import { BaseHttpTTSClient } from "../http-tts-client.js";
import { TTSAuthError, TTSError, TTSProtocolError } from "../../core/errors.js";
import type { OpenAITTSConfig, TTSAudioFormat, TTSCapabilities } from "../types.js";

/**
 * OpenAI 语音合成适配器（`POST /v1/audio/speech`）。
 *
 * 这是四家里唯一的**纯 HTTP、无会话**形态，正好压测方向基类的降级路径：
 * - `sendText()` 只入本地缓冲（`incrementalText: false`），`flush()` 才发一次请求；
 * - 响应体是 chunked 音频流，边读边 `emitAudio`；末片用「压一帧回看」标 `isFinal`
 *   （HTTP 流结束前无法预知哪片是最后一片）；
 * - `close()` 中止在途请求 —— HTTP 下这是它唯一有意义的动作。
 *
 * 文档：guides/text-to-speech + API 参考（`response_format` / `speed` / `stream_format`）。
 * 注意 `stream_format: "sse"` 对 `tts-1`/`tts-1-hd` 不支持，因此这里统一用默认的
 * chunked 传输（读原始字节流），不依赖任何 SSE 解析。
 */
export class OpenAITTSClient extends BaseHttpTTSClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly url: string;
  private readonly voice: string;
  private readonly responseFormat: TTSAudioFormat | "pcm";
  /** 本轮待合成文本：`sendTextImpl` 收到的整段。 */
  private pendingText = "";
  /** 轮次号：一次请求 = 一句。 */
  private roundCounter = 0;
  /** 可注入的 fetch（单测用），默认全局 fetch。 */
  protected fetchImpl: typeof fetch = globalThis.fetch;

  constructor(config: OpenAITTSConfig) {
    super(config.options);
    this.apiKey = config.apiKey;
    this.model = config.model?.trim() || DEFAULT_MODEL;
    this.url = config.url ?? `${config.baseUrl ?? DEFAULT_BASE_URL}${SPEECH_PATH}`;
    this.voice = config.options?.voice?.trim() ?? "";
    this.responseFormat = config.options?.format ?? "pcm";
  }

  get provider(): string {
    return "openai";
  }

  get capabilities(): TTSCapabilities {
    return {
      // 纯 HTTP：每个 flush 一次请求，没有连接可复用、也没有可重连的连接
      transport: "http",
      incrementalText: false,
      sessionReuse: false,
      formats: ["pcm", "wav", "mp3", "opus", "aac", "flac"],
      // 端点为 24kHz 输出（pcm 为 24k/16-bit/mono）；容器格式的实际采样率写在容器头里
      sampleRates: [24000],
      instructions: true, // 四家里唯一支持自然语言指令的
      voiceCloning: false,
      wordTimestamps: false,
    };
  }

  /* ------------------------------- 上行文本 ------------------------------- */

  /** 非增量后端：基类已把整段文本攒好，这里只暂存。 */
  protected sendTextImpl(text: string): void {
    this.pendingText += text;
  }

  protected async flushImpl(): Promise<void> {
    const text = this.pendingText;
    this.pendingText = "";
    if (!text) return;

    const controller = new AbortController();
    this.trackRequest(controller);
    const round = ++this.roundCounter;
    let held: Uint8Array | null = null;

    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(this.buildBody(text)),
        signal: controller.signal,
      });

      if (!res.ok) throw await this.toError(res);
      if (!res.body) throw new TTSProtocolError("响应没有 body", "empty-body");

      for await (const chunk of res.body) {
        const bytes =
          chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBufferLike);
        if (bytes.length === 0) continue;
        // 压一帧回看：流结束前无法预知哪片是最后一片
        if (held) this.emitAudio(this.toChunk(held, false, round));
        held = bytes;
      }
      if (held) this.emitAudio(this.toChunk(held, true, round));
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new TTSError("请求已被 close() 中止", "aborted", err);
      }
      if (err instanceof TTSError) throw err;
      throw new TTSError("请求失败", "request", err);
    } finally {
      this.clearRequest(controller);
    }
  }

  private buildBody(text: string): Record<string, unknown> {
    const opts = this.options;
    return {
      model: this.model,
      input: text,
      voice: this.voice,
      response_format: this.responseFormat,
      ...(opts.speed !== undefined ? { speed: clamp(opts.speed, 0.25, 4) } : {}),
      ...(opts.instructions ? { instructions: opts.instructions } : {}),
      ...opts.extra,
    };
  }

  private toChunk(audio: Uint8Array, isFinal: boolean, round: number) {
    return {
      audio,
      format: this.responseFormat,
      // 端点固定 24kHz 输出；容器格式（mp3/opus/…）的采样率以容器头为准，这里不臆测
      ...(this.responseFormat === "pcm" || this.responseFormat === "wav"
        ? { sampleRate: OUTPUT_SAMPLE_RATE }
        : {}),
      channels: 1,
      isFinal,
      id: `r${round}`,
      index: round,
    };
  }

  /** 统一的错误归类：鉴权 / 限流 / 其余协议错误。 */
  private async toError(res: Response): Promise<TTSError> {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    const message = `OpenAI TTS 请求失败：HTTP ${res.status}${detail ? ` ${detail}` : ""}`;
    if (res.status === 401 || res.status === 403)
      return new TTSAuthError(message, String(res.status));
    if (res.status === 429) return new TTSError(message, "rate-limit");
    return new TTSProtocolError(message, String(res.status));
  }

  protected override async connectImpl(): Promise<void> {
    if (!this.voice) {
      throw new TTSError(
        "OpenAI TTS 需要 options.voice（如 'coral' / 'marin' / 'cedar'）；各家音色名不通用，本库不猜默认值。",
        "missing-voice",
      );
    }
    await super.connectImpl(); // HTTP 无握手，就绪即返回
  }
}

/* --------------------------------- 常量 --------------------------------- */

const DEFAULT_BASE_URL = "https://api.openai.com";
const SPEECH_PATH = "/v1/audio/speech";
const DEFAULT_MODEL = "gpt-4o-mini-tts";
const OUTPUT_SAMPLE_RATE = 24000;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
