import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { BaseRealtimeTTSClient } from "../realtime-tts-client.js";
import { TTSAuthError, TTSError, TTSProtocolError } from "../../core/errors.js";
import type { DashScopeTTSConfig, TTSAudioFormat, TTSCapabilities, TTSWord } from "../types.js";

/**
 * 阿里百炼 / DashScope 实时语音合成（CosyVoice / Qwen-Audio-TTS）。
 *
 * 协议要点（doc: cosyvoice-websocket-api / cosyvoice-client-events / cosyvoice-server-events）：
 * - 同一条 WebSocket 上用 `run-task` → `continue-task`×N → `finish-task` 描述一轮合成，
 *   三个事件的 `task_id` 必须一致；
 * - 服务端事件走 text 帧（task-started / result-generated / task-finished / task-failed），
 *   音频走 **binary 帧**，且紧跟在 `result-generated(type=sentence-synthesis)` 之后；
 * - 一轮结束后可在同一连接上直接发新的 `run-task`（连接复用），无需重建。
 *
 * 对上行暴露的只有统一的 `sendText()` / `flush()`：`flush()` 即「finish-task + 等
 * task-finished」，之后若还有文本进来，适配器会自动开新一轮任务。
 */
export class DashScopeTTSClient extends BaseRealtimeTTSClient {
  private ws?: WebSocket;
  private taskId = "";
  private taskState: TaskState = "idle";
  /** 已产生但尚未随 continue-task 发出的文本（含任务启动前的排队）。 */
  private pendingText: string[] = [];
  private flushRequested = false;
  private finishPromise?: Promise<void>;
  private finishResolve?: () => void;
  /** 句序号：本库统一分配，1-based，跨任务连续（与 ASR 侧 index 语义一致）。 */
  private sentenceSeq = 0;
  private currentSentence: Sentence | null = null;
  /**
   * 回看一帧：音频帧与「句子结束」是两个独立事件，收到下一帧或句子结束时才能
   * 判定前一帧是否为该句最后一片，因此这里压住一帧再发。
   */
  private heldChunk: HeldChunk | null = null;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly outputFormat: TTSAudioFormat;
  private readonly outputSampleRate: number;

  constructor(config: DashScopeTTSConfig) {
    super(config.options);
    this.apiKey = config.apiKey;
    this.model = config.model?.trim() || DEFAULT_MODEL;
    this.voice = config.options?.voice?.trim() ?? "";
    this.url = config.url ?? buildDashScopeTTSUrl(config.workspaceId, config.region);
    this.headers = config.workspace ? { "X-DashScope-WorkSpace": config.workspace } : {};
    this.outputFormat = config.options?.format ?? "pcm";
    this.outputSampleRate = config.options?.sampleRate ?? DEFAULT_SAMPLE_RATE;
  }

  get provider(): string {
    return "dashscope";
  }

  get capabilities(): TTSCapabilities {
    return CAPABILITIES;
  }

  protected async connectImpl(): Promise<void> {
    if (!this.voice) {
      throw new TTSError(
        "DashScope TTS 需要 options.voice（音色名，如 'longanhuan_v3.6'）；各家音色名不通用，本库不猜默认值。",
        "missing-voice",
      );
    }

    const headers: Record<string, string> = {
      ...this.headers,
      Authorization: `Bearer ${this.apiKey}`,
    };

    this.taskId = "";
    this.taskState = "idle";
    this.flushRequested = false;
    this.finishPromise = undefined;
    this.finishResolve = undefined;
    this.currentSentence = null;
    this.heldChunk = null;

    this.ws = new WebSocket(this.url, { headers });

    await new Promise<void>((resolve, reject) => {
      const ws = this.ws;
      if (!ws) return reject(new TTSError("WebSocket 未初始化", "ws"));

      ws.on("open", () => {
        this.emitOpen();
        resolve();
        // 连接就绪前排队的文本：现在可以开任务了。
        this.ensureTask();
      });
      ws.on("message", (data, isBinary) => this.onMessage(data, isBinary));
      ws.on("error", (err) => this.emitError(new TTSError("WebSocket 错误", "ws", err)));
      ws.on("close", (code, reason) => {
        // 连接没了：放掉可能仍在等待的 flush()，并丢弃半句音频（避免发出误导性的 isFinal）。
        this.releaseFinish();
        this.heldChunk = null;
        this.handleDisconnect(code, reason?.toString());
      });
      ws.on("unexpected-response", (_req, res) => {
        const status = res.statusCode ?? 0;
        const err =
          status === 401 || status === 403
            ? new TTSAuthError(`握手失败：鉴权被拒（HTTP ${status}）`, "handshake")
            : new TTSError(`握手失败：HTTP ${status}`, "handshake");
        reject(err);
      });
    });
  }

  /* ------------------------------- 上行文本 ------------------------------- */

  protected sendTextImpl(text: string): void {
    if (!text) return;
    this.pendingText.push(text);
    this.ensureTask();
  }

  protected flushImpl(): Promise<void> {
    // 没有在途任务、也没有新文本：无事可做。
    if (this.taskState === "idle" && this.pendingText.length === 0) return Promise.resolve();

    this.flushRequested = true;
    const pending = this.armFinish();
    this.ensureTask();
    this.maybeFinish();
    return pending;
  }

  /** 取（或建立）本轮「等 task-finished」的 Promise。 */
  private armFinish(): Promise<void> {
    if (!this.finishPromise) {
      this.finishPromise = new Promise<void>((resolve) => {
        this.finishResolve = resolve;
      });
    }
    return this.finishPromise;
  }

  /** 空闲且确有文本时才开新任务；任务一旦开启，后续 continue-task 都挂在它上面。 */
  private ensureTask(): void {
    if (this.taskState !== "idle" || this.pendingText.length === 0) return;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    this.taskId = randomUUID();
    this.taskState = "starting";
    this.sendCommand(
      { action: "run-task", task_id: this.taskId, streaming: "duplex" },
      this.buildRunTaskPayload(),
    );
  }

  /** task-started 之后才能发 continue-task / finish-task（官方明确要求）。 */
  private drainPendingText(): void {
    if (this.taskState !== "active" || this.pendingText.length === 0) return;
    const text = this.pendingText.join("");
    this.pendingText = [];
    this.sendCommand(
      { action: "continue-task", task_id: this.taskId, streaming: "duplex" },
      { input: { text } },
    );
  }

  private maybeFinish(): void {
    if (!this.flushRequested || this.taskState !== "active") return;
    this.taskState = "finishing";
    this.sendCommand(
      { action: "finish-task", task_id: this.taskId, streaming: "duplex" },
      { input: {} },
    );
  }

  private buildRunTaskPayload(): Record<string, unknown> {
    const opts = this.options;
    const parameters: Record<string, unknown> = {
      text_type: "PlainText",
      voice: this.voice,
      format: this.outputFormat,
      sample_rate: this.outputSampleRate,
      // 统一选项 → DashScope 参数：speed/pitch 为倍率，volume 为 0-100。
      ...(opts.speed !== undefined ? { rate: opts.speed } : {}),
      ...(opts.pitch !== undefined ? { pitch: opts.pitch } : {}),
      ...(opts.volume !== undefined ? { volume: opts.volume } : {}),
      ...(opts.instructions ? { instruction: opts.instructions } : {}),
    };
    const lang = mapLanguageHint(opts.language);
    if (lang) parameters.language_hints = [lang];
    // 厂商私有参数（seed / enable_ssml / word_timestamp_enabled / hot_fix …）透传进 parameters。
    Object.assign(parameters, opts.extra ?? {});

    return {
      task_group: "audio",
      task: "tts",
      function: "SpeechSynthesizer",
      model: this.model,
      parameters,
      input: {},
    };
  }

  private sendCommand(header: Record<string, unknown>, payload: Record<string, unknown>): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ header, payload }));
  }

  /* ------------------------------- 下行事件 ------------------------------- */

  private onMessage(data: WebSocket.RawData, isBinary: boolean): void {
    if (isBinary) {
      this.onAudioFrame(toBytes(data));
      return;
    }
    let msg: any;
    try {
      msg = JSON.parse(toBytes(data).toString("utf-8"));
    } catch {
      // 兜底：个别实现可能把音频放在不带 binary 标志的帧里。
      this.onAudioFrame(toBytes(data));
      return;
    }
    this.onEvent(msg);
  }

  private onEvent(msg: any): void {
    switch (msg?.header?.event) {
      case "task-started":
        this.taskState = "active";
        this.drainPendingText();
        this.maybeFinish();
        break;
      case "result-generated":
        this.onResultGenerated(msg);
        break;
      case "task-finished":
        this.onTaskFinished();
        break;
      case "task-failed":
        this.onTaskFailed(msg);
        break;
      default:
        break;
    }
  }

  private onResultGenerated(msg: any): void {
    const output = msg?.payload?.output;
    if (!output) return;
    const sentence = output.sentence ?? {};
    const type = String(output.type ?? "");
    const text = sentenceText(output, sentence);
    const words = toWords(sentence.words);

    if (type === "sentence-begin") {
      this.currentSentence = {
        id: `s${++this.sentenceSeq}`,
        index: this.sentenceSeq,
        ...(text ? { text } : {}),
        ...(words ? { words } : {}),
      };
      return;
    }

    // sentence-synthesis 只声明「后面紧跟一帧音频」；文本 / 时间戳可能在后续帧里补齐。
    if (this.currentSentence) {
      if (text) this.currentSentence.text = text;
      if (words) this.currentSentence.words = words;
    }
    if (type === "sentence-end") {
      this.flushHeldChunk(true);
      this.currentSentence = null;
    }
  }

  /** 收到一帧音频：先回看上一帧，再压住当前帧等待「句子结束」。 */
  private onAudioFrame(audio: Uint8Array): void {
    if (audio.length === 0) return;
    const sentence = this.currentSentence ?? this.beginOrphanSentence();
    if (this.heldChunk) {
      // 不同句 ⇒ 上一句必然已结束；同句 ⇒ 上一片不是该句最后一片。
      this.flushHeldChunk(this.heldChunk.sentence.id !== sentence.id);
    }
    this.heldChunk = { audio, sentence };
  }

  /** 服务端没给 sentence-begin（异常/兼容场景）时，按到达顺序自建一句。 */
  private beginOrphanSentence(): Sentence {
    const sentence: Sentence = { id: `s${++this.sentenceSeq}`, index: this.sentenceSeq };
    this.currentSentence = sentence;
    return sentence;
  }

  private flushHeldChunk(isFinal: boolean): void {
    const held = this.heldChunk;
    if (!held) return;
    this.heldChunk = null;
    const { sentence } = held;
    this.emitAudio({
      audio: held.audio,
      format: this.outputFormat,
      sampleRate: this.outputSampleRate,
      channels: 1,
      isFinal,
      id: sentence.id,
      index: sentence.index,
      ...(sentence.text ? { text: sentence.text } : {}),
      ...(sentence.words ? { words: sentence.words } : {}),
    });
  }

  private onTaskFinished(): void {
    this.flushHeldChunk(true);
    this.currentSentence = null;
    this.taskState = "idle";
    this.flushRequested = false;
    this.releaseFinish();
    // 逐句用法：flush() 之后又追加的文本，在同一连接上开新任务。
    this.ensureTask();
  }

  private onTaskFailed(msg: any): void {
    const code = String(msg?.header?.error_code ?? "");
    const message = String(msg?.header?.error_message ?? "task failed");
    this.flushHeldChunk(true);
    this.currentSentence = null;
    this.taskState = "idle";
    this.flushRequested = false;
    this.releaseFinish();
    this.emitError(classifyTaskFailure(code, message));
    // 失败不自动重试（避免密钥错误时无限重试）；已排队的文本保留，下次 flush() 会再试。
  }

  /** 唤醒仍在等待的 flush()（正常情况下由 task-finished / task-failed 触发）。 */
  private releaseFinish(): void {
    const resolve = this.finishResolve;
    this.finishResolve = undefined;
    this.finishPromise = undefined;
    resolve?.();
  }

  /* -------------------------------- 关闭 --------------------------------- */

  protected async closeImpl(): Promise<void> {
    const ws = this.ws;
    if (!ws) return;

    // 还有在途任务或排队文本：借关闭前最后一次机会合成完，避免调用方忘 flush 丢字。
    if (this.taskState !== "idle" || this.pendingText.length > 0) {
      this.flushRequested = true;
      const pending = this.armFinish();
      this.ensureTask();
      this.maybeFinish();
      // 等服务端收尾，但最多等 CLOSE_DRAIN_MS，避免连接异常时卡住 close()。
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

/** run-task → continue-task → finish-task 的任务状态机。 */
type TaskState = "idle" | "starting" | "active" | "finishing";

interface Sentence {
  id: string;
  index: number;
  text?: string;
  words?: TTSWord[];
}

interface HeldChunk {
  audio: Uint8Array;
  /** 持有句对象引用：句子元信息（文本 / 时间戳）后续补齐后，发出时自动可见。 */
  sentence: Sentence;
}

/* --------------------------------- 常量 --------------------------------- */

const DEFAULT_MODEL = "qwen-audio-3.0-tts-flash";
/** 显式下发采样率，保证 `TTSChunk.sampleRate` 永远如实（而不是靠厂商默认值猜）。 */
const DEFAULT_SAMPLE_RATE = 24000;
const CLOSE_DRAIN_MS = 3000;

const CAPABILITIES: TTSCapabilities = {
  transport: "websocket",
  incrementalText: true,
  sessionReuse: true,
  formats: ["pcm", "wav", "mp3", "opus"],
  sampleRates: [8000, 16000, 22050, 24000, 44100, 48000],
  instructions: true,
  voiceCloning: true,
  wordTimestamps: true,
};

/* --------------------------------- 工具 --------------------------------- */

function buildDashScopeTTSUrl(
  workspaceId?: string,
  region?: "cn-beijing" | "ap-southeast-1",
): string {
  if (workspaceId) {
    const r = region ?? "cn-beijing";
    return `wss://${workspaceId}.${r}.maas.aliyuncs.com/api-ws/v1/inference`;
  }
  return "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
}

/**
 * 句子文本在 `output` 层（`original_text` / `normalized_text`），句对象里只有
 * `index` 与 `words` —— 这是实测确认过的真实载荷结构，官方文档示例容易看错层级。
 */
function sentenceText(output: any, sentence: any): string | undefined {
  const text = output?.original_text ?? output?.normalized_text ?? sentence?.text;
  return typeof text === "string" && text.length > 0 ? text : undefined;
}

function toWords(raw: unknown): TTSWord[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const words: TTSWord[] = [];
  for (const w of raw) {
    if (!w || typeof w !== "object") continue;
    const text = String((w as any).text ?? "");
    if (!text) continue;
    const beginIndex = num((w as any).begin_index);
    const endIndex = num((w as any).end_index);
    const beginTime = num((w as any).begin_time);
    const endTime = num((w as any).end_time);
    words.push({
      text,
      ...(beginIndex !== undefined ? { beginIndex } : {}),
      ...(endIndex !== undefined ? { endIndex } : {}),
      ...(beginTime !== undefined ? { beginTime } : {}),
      ...(endTime !== undefined ? { endTime } : {}),
    });
  }
  return words.length > 0 ? words : undefined;
}

/** 只接受真实数字：字符串形式的数字（如 "0"）也接受，其余忽略。 */
function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** task-failed 的错误分类：明显的密钥/权限问题归为鉴权错误，其余为协议错误。 */
function classifyTaskFailure(code: string, message: string): TTSError {
  const haystack = `${code} ${message}`;
  if (/apikey|api_key|unauthor|forbidden|invalid\s*key|access\s*denied/i.test(haystack)) {
    return new TTSAuthError(message, code || "task-failed");
  }
  return new TTSProtocolError(message, code || "task-failed");
}

/** DashScope TTS `language_hints` 支持的取值（doc: cosyvoice-client-events）。 */
const DASHSCOPE_TTS_LANGUAGES = new Set([
  "zh",
  "en",
  "fr",
  "de",
  "ja",
  "ko",
  "ru",
  "pt",
  "th",
  "id",
  "vi",
  "es",
  "it",
  "ms",
  "fil",
  "ar",
]);

/** 统一 BCP-47 → language_hints：取主语言子标签，集合内用规范码，否则透传原码。 */
function mapLanguageHint(lang?: string): string | undefined {
  if (!lang || lang === "auto") return undefined;
  const primary = lang.split("-")[0].toLowerCase();
  return DASHSCOPE_TTS_LANGUAGES.has(primary) ? primary : lang;
}

function toBytes(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // 只作兜底上限用：不要让这个定时器把进程的事件循环留住。
    timer.unref?.();
  });
}
