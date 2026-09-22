import WebSocket from "ws";
import { createHmac } from "node:crypto";
import { BaseRealtimeTTSClient } from "../realtime-tts-client.js";
import { TTSAuthError, TTSError, TTSProtocolError } from "../../core/errors.js";
import type { IFlytekTTSConfig, TTSAudioFormat, TTSCapabilities } from "../types.js";

/**
 * 科大讯飞超拟人语音合成适配器（双向流式，doc: spark/super smart-tts）。
 *
 * 协议要点（均为实测确认，文档有几处不准）：
 * - 端点 `wss://cbm01.cn-huabei-1.xf-yun.com/v1/private/mcd9m97e6`，鉴权走 **方式二**：
 *   query 里带 `host`/`date`/`authorization`，签名是 `host\ndate\nGET {path} HTTP/1.1`
 *   的 **HMAC-SHA256**（base64）——注意与讯飞识别用的参数串 HMAC-SHA1 完全不同。
 * - 文本**必须 base64**（文档示例给的是明文，直接传会报 `10163 … must be encode to base64`）。
 * - 流式：`header.status` 与 `payload.text.status` 同为 0（首帧）/ 1（中间）/ 2（结束），
 *   `payload.text.seq` 递增；**可以用「空文本 + status=2」收尾**（实测接受）。
 * - 下行：音频在 `payload.audio.audio`（base64），逐帧 `status=1`，最后来一帧
 *   `status=2` 且**音频为空**作为结束标记。
 * - **同一连接不可复用**：一轮结束后再发文本会得到 `26016 intput channel is closed`
 *   （原文如此），所以适配器在下一轮开始前**自动重连**，对调用方仍是
 *   `sendText` / `flush` 两个动作。
 */
export class IFlytekTTSClient extends BaseRealtimeTTSClient {
  private ws?: WebSocket;
  /** 连接可用（已 open 且本轮未结束）。 */
  private ready = false;
  /** 上一轮已收尾：连接已不可用，下一轮需重连。 */
  private spent = false;
  /** 本轮是否已发过文本帧（决定首帧用 status=0）。 */
  private roundOpen = false;
  /** 已发出结束帧，正在等 `audio.status=2`。 */
  private terminating = false;
  private finishRequested = false;
  private seq = 0;
  private finishPromise?: Promise<void>;
  private finishResolve?: () => void;
  /** 轮次计数与当前轮次号：讯飞没有句级事件，一轮合成即一句，轮次号直接当句序号。 */
  private roundCounter = 0;
  private currentRound = 0;
  private heldChunk: HeldChunk | null = null;
  /** 内部主动关闭（重连/收尾）时，不要把它当成异常断开上报。 */
  private intentionalClose = false;

  private readonly appId: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly url: string;
  private readonly voice: string;
  private readonly encoding: string;
  private readonly outputFormat: TTSAudioFormat;
  private readonly outputSampleRate: number;

  constructor(config: IFlytekTTSConfig) {
    super(config.options);
    this.appId = config.appId;
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.url = config.url ?? DEFAULT_URL;
    this.voice = config.options?.voice?.trim() ?? "";
    this.outputFormat = config.options?.format ?? "pcm";
    this.encoding = TO_IFLYTEK_ENCODING[this.outputFormat] ?? "raw";
    this.outputSampleRate = config.options?.sampleRate ?? DEFAULT_SAMPLE_RATE;
  }

  get provider(): string {
    return "iflytek";
  }

  get capabilities(): TTSCapabilities {
    return {
      transport: "websocket",
      incrementalText: true,
      // 一轮合成会把输入通道关掉（26016），连接不能承载多轮 —— 适配器内部重连来兜，
      // 这里如实上报 false，别让调用方以为可以复用。
      sessionReuse: false,
      formats: ["pcm", "mp3", "opus"],
      sampleRates: [8000, 16000, 24000],
      instructions: false, // 无自然语言指令；口语化走 extra 里的 parameter.oral
      voiceCloning: false,
      wordTimestamps: false, // rhy=1 返回的是拼音标注（pybuf），不是时间戳
    };
  }

  protected async connectImpl(): Promise<void> {
    if (!this.voice) {
      throw new TTSError(
        "讯飞 TTS 需要 options.voice（发音人，如 'x5_lingxiaoxuan_flow'）。注意发音人授权与字符量授权是两笔独立授权，未授权会报 11200。",
        "missing-voice",
      );
    }
    this.resetRoundState();
    this.spent = false;
    await this.openSocket();
  }

  /** 建连（含鉴权）；同时用于首次连接与轮次之间的自动重连。 */
  private async openSocket(): Promise<void> {
    const authUrl = buildIFlytekTTSAuthUrl(this.url, this.apiKey, this.apiSecret);
    this.ws = new WebSocket(authUrl);
    this.ready = false;

    await new Promise<void>((resolve, reject) => {
      const ws = this.ws;
      if (!ws) return reject(new TTSError("WebSocket 未初始化", "ws"));

      ws.on("open", () => {
        this.ready = true;
        this.emitOpen();
        resolve();
      });
      ws.on("message", (data) => this.onMessage(data));
      ws.on("error", (err) => this.emitError(new TTSError("WebSocket 错误", "ws", err)));
      ws.on("close", (code, reason) => {
        this.ready = false;
        if (this.intentionalClose) {
          this.intentionalClose = false;
          return; // 内部重连/收尾：不算异常断开
        }
        this.releaseFinish();
        this.heldChunk = null;
        this.handleDisconnect(code, reason?.toString());
      });
      ws.on("unexpected-response", (_req, res) => {
        const status = res.statusCode ?? 0;
        const message = `握手失败：HTTP ${status}`;
        reject(
          status === 401 || status === 403
            ? new TTSAuthError(message, "handshake")
            : new TTSError(message, "handshake"),
        );
      });
    });
  }

  /* ------------------------------- 上行文本 ------------------------------- */

  protected sendTextImpl(text: string): void {
    if (!text) return;
    this.pendingText.push(text);
    this.pump();
  }

  protected flushImpl(): Promise<void> {
    // 本轮还没发过任何文本 → 无内容可合成。
    if (!this.roundOpen && this.pendingText.length === 0) return Promise.resolve();
    this.finishRequested = true;
    const pending = this.armFinish();
    if (this.ready) this.pump();
    else void this.reconnectThenPump(); // 上一轮已收尾（连接不可复用）或尚未就绪
    return pending;
  }

  private pendingText: string[] = [];

  /** 按需发出：先把排队的文本作为 0/1 帧发掉，再发结束帧。 */
  private pump(): void {
    if (!this.ready || this.terminating) return;
    while (this.pendingText.length > 0) {
      const text = this.pendingText.shift()!;
      if (!this.roundOpen) this.currentRound = ++this.roundCounter; // 开新一轮：分配句序号
      this.sendTextFrame(text, this.roundOpen ? 1 : 0);
      this.roundOpen = true;
    }
    if (this.finishRequested && this.roundOpen) {
      // 结束帧：文档口径是「一次性合成直接传 2」，实测「空文本 + status=2」也被接受。
      this.sendTextFrame("", 2);
      this.terminating = true;
    }
  }

  private sendTextFrame(text: string, status: 0 | 1 | 2): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        header: { app_id: this.appId, status },
        parameter: {
          tts: {
            vcn: this.voice,
            ...this.tuningParams(),
            audio: {
              encoding: this.encoding,
              sample_rate: this.outputSampleRate,
              channels: 1,
              bit_depth: 16,
              frame_size: 0,
            },
          },
        },
        payload: {
          text: {
            encoding: "utf8",
            compress: "raw",
            format: "plain",
            status,
            seq: this.seq++,
            // 实测必须 base64（文档示例写明文会报 10163）
            text: Buffer.from(text, "utf-8").toString("base64"),
          },
        },
      }),
    );
  }

  /**
   * 统一选项 → 讯飞参数。讯飞的 speed / pitch 是 0-100（50 = 原速/原调，0 = 0.5 倍，
   * 100 = 2 倍），所以倍率 × 50；volume 的 0-100 语义与我们一致（50 = 原音量），直接透传。
   */
  private tuningParams(): Record<string, unknown> {
    const opts = this.options;
    return {
      ...(opts.speed !== undefined ? { speed: clamp(opts.speed * 50, 0, 100) } : {}),
      ...(opts.pitch !== undefined ? { pitch: clamp(opts.pitch * 50, 0, 100) } : {}),
      ...(opts.volume !== undefined ? { volume: clamp(opts.volume, 0, 100) } : {}),
      // 口语化等级 / spark_assist / 水印等私有参数走 extra
      ...opts.extra,
    };
  }

  /** 收尾后连接不可复用：换一条新连接继续服务后续文本。 */
  private async reconnectThenPump(): Promise<void> {
    if (!this.spent) return; // 正在连或已就绪，交给 pump
    try {
      this.spent = false;
      this.intentionalClose = true;
      this.ws?.close(1000);
      this.resetRoundState();
      await this.openSocket();
      this.pump();
    } catch (err) {
      this.emitError(new TTSError("重连失败", "reconnect", err));
      this.releaseFinish();
    }
  }

  /**
   * 只清「轮内簿记」，**不动 `finishRequested`** —— 它是调用方 `flush()` 的意图，
   * 必须跨重连存活（重连后要立刻补发结束帧，否则服务端会等到 26005 超时）。
   */
  private resetRoundState(): void {
    this.roundOpen = false;
    this.currentRound = 0;
    this.terminating = false;
    this.seq = 0;
  }

  private armFinish(): Promise<void> {
    if (!this.finishPromise) {
      this.finishPromise = new Promise<void>((resolve) => {
        this.finishResolve = resolve;
      });
    }
    return this.finishPromise;
  }

  private releaseFinish(): void {
    const resolve = this.finishResolve;
    this.finishResolve = undefined;
    this.finishPromise = undefined;
    resolve?.();
  }

  /* ------------------------------- 下行事件 ------------------------------- */

  private onMessage(data: WebSocket.RawData): void {
    let msg: any;
    try {
      msg = JSON.parse(
        typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf-8"),
      );
    } catch (err) {
      this.emitError(new TTSProtocolError("无法解析服务端帧", undefined, err));
      return;
    }

    const code = Number(msg?.header?.code ?? 0);
    if (code !== 0) {
      this.onServerError(code, String(msg?.header?.message ?? ""));
      return;
    }

    const audio = msg?.payload?.audio;
    if (!audio) return; // 例如首帧后的空 ack

    // 结束标记：status=2 且音频为空
    if (Number(audio.status) === 2) {
      this.flushHeldChunk(true);
      this.terminating = false;
      this.roundOpen = false;
      this.finishRequested = false;
      this.spent = true; // 输入通道已被服务端关闭，下一轮必须重连
      this.ready = false;
      this.releaseFinish();
      if (this.pendingText.length > 0) void this.reconnectThenPump();
      return;
    }

    const bytes = decodeBase64Audio(audio.audio);
    if (bytes && bytes.length > 0) this.onAudioFrame(bytes, audio);
  }

  private onServerError(code: number, message: string): void {
    const detail = `讯飞 TTS 错误 ${code}: ${message}`;
    // 11200 = 授权类（发音人/额度未授权）；26016 = 连接已不可复用；其余按协议错误处理
    const err =
      code === 11200
        ? new TTSAuthError(detail, String(code))
        : new TTSProtocolError(detail, String(code));
    this.emitError(err);
    // 出错也要放掉等待中的 flush()，并让下一轮重连
    this.flushHeldChunk(true);
    this.spent = true;
    this.ready = false;
    this.finishRequested = false; // 本次 flush 已被 releaseFinish 放掉，意图作废
    this.releaseFinish();
  }

  /**
   * 收到一帧音频：压住一帧再发，这样等下一帧或结束标记到达时才能把「本轮最后一帧」
   * 标成 `isFinal: true`（讯飞没有句级事件，结束标记那一帧的音频还是空的）。
   */
  private onAudioFrame(bytes: Uint8Array, meta: any): void {
    if (this.heldChunk) this.flushHeldChunk(false);
    this.heldChunk = { audio: bytes, meta, id: `r${this.currentRound}`, index: this.currentRound };
  }

  /** 收尾一帧回看：把压住的那帧发出去（`isFinal` 标记是否为本轮最后一帧）。 */
  private flushHeldChunk(isFinal: boolean): void {
    const held = this.heldChunk;
    if (!held) return;
    this.heldChunk = null;
    this.emitAudio({
      audio: held.audio,
      format:
        fromIflytekEncoding(String(held.meta?.encoding ?? this.encoding)) ?? this.outputFormat,
      sampleRate: Number(held.meta?.sample_rate ?? this.outputSampleRate),
      channels: Number(held.meta?.channels ?? 1),
      isFinal,
      id: held.id,
      index: held.index,
    });
  }

  /* -------------------------------- 关闭 --------------------------------- */

  protected async closeImpl(): Promise<void> {
    const ws = this.ws;
    if (!ws) return;

    if (this.roundOpen && !this.terminating && ws.readyState === WebSocket.OPEN) {
      const pending = this.armFinish();
      this.finishRequested = true;
      this.pump();
      await Promise.race([pending, delay(CLOSE_DRAIN_MS)]);
    }

    this.flushHeldChunk(true);
    this.releaseFinish();

    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, CLOSE_DRAIN_MS);
      ws.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          // 用户主动关闭不置 intentionalClose：与其他适配器一致，仍发 close(1000) 事件，
          // 且 code=1000 不会触发重连。intentionalClose 只用于轮间内部重连。
          ws.close(1000);
        }
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}

/* --------------------------------- 内部类型 -------------------------------- */

interface HeldChunk {
  audio: Uint8Array;
  meta: any;
  id: string;
  index: number;
}

/* --------------------------------- 常量 --------------------------------- */

const DEFAULT_URL = "wss://cbm01.cn-huabei-1.xf-yun.com/v1/private/mcd9m97e6";
const DEFAULT_SAMPLE_RATE = 24000;
const CLOSE_DRAIN_MS = 3000;

/** 统一编码 → 讯飞编码（raw = PCM，lame = MP3）。 */
const TO_IFLYTEK_ENCODING: Partial<Record<TTSAudioFormat, string>> = {
  pcm: "raw",
  mp3: "lame",
  opus: "opus",
};
const FROM_IFLYTEK_ENCODING: Record<string, TTSAudioFormat> = {
  raw: "pcm",
  lame: "mp3",
  opus: "opus",
  "opus-wb": "opus",
  "opus-swb": "opus",
};

/* --------------------------------- 工具 --------------------------------- */

/**
 * 鉴权方式二：`host\ndate\nGET {path} HTTP/1.1` 做 HMAC-SHA256，再拼成 authorization 放进 query。
 * 导出供测试直接断言签名结构（与 ASR 适配器导出 `buildIFlytekAuthUrl` 的做法一致）。
 */
export function buildIFlytekTTSAuthUrl(
  requestUrl: string,
  apiKey: string,
  apiSecret: string,
  date = new Date().toUTCString(),
): string {
  const u = new URL(requestUrl);
  const signatureOrigin = `host: ${u.host}\ndate: ${date}\nGET ${u.pathname} HTTP/1.1`;
  const signature = createHmac("sha256", apiSecret).update(signatureOrigin).digest("base64");
  const authorizationOrigin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authorizationOrigin, "utf-8").toString("base64");
  const query = new URLSearchParams({ host: u.host, date, authorization });
  return `${requestUrl}?${query.toString()}`;
}

function fromIflytekEncoding(encoding: string): TTSAudioFormat | undefined {
  return FROM_IFLYTEK_ENCODING[encoding];
}

function decodeBase64Audio(audio: unknown): Uint8Array | undefined {
  if (typeof audio !== "string" || audio.length === 0) return undefined;
  return new Uint8Array(Buffer.from(audio, "base64"));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
