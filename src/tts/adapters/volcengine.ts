import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { BaseRealtimeTTSClient } from "../realtime-tts-client.js";
import { TTSAuthError, TTSError, TTSProtocolError } from "../../core/errors.js";
import {
  MSG_AUDIO_ONLY_RESPONSE,
  MSG_ERROR,
  MSG_FULL_SERVER_RESPONSE,
  SER_JSON,
  decodeFrame,
  encodeFrame,
  toBuffer,
  type VolcFrame,
} from "../../utils/volc-frames.js";
import type { TTSAudioFormat, TTSCapabilities, TTSWord, VolcengineTTSConfig } from "../types.js";

/**
 * 火山引擎豆包语音合成 WebSocket 适配器（V3 二进制协议）。
 *
 * 两种模式共用同一套 envelope 与下行事件，差异只在「文本怎么发」：
 *
 * | | `duplex`（双向流式） | `oneshot`（单向流式） |
 * | --- | --- | --- |
 * | 端点 | `/api/v3/tts/bidirection` | `/api/v3/tts/unidirectional/stream` |
 * | 文本 | `StartSession` → `TaskRequest`×N → `FinishSession` | 一帧 full client request 带全文 |
 * | 上行 event | 需要 | 合成阶段不需要（仅关闭时 `FinishConnection`） |
 *
 * 两者对上行都表现为 `sendText()` / `flush()`，由基类的 `capabilities.incrementalText`
 * 决定是「逐次下发」还是「攒到 flush 一次性下发」。
 *
 * 参考文档：双向 6561/1329505 · 单向 6561/1719100 · SDK 6561/1739229。
 *
 * 两种模式均已实测线上。文档里没写清 / 写错的点（全部帧都走 binary、连接级事件
 * 也带 sessionId、单向模式不能发 StartConnection、句文本只在 351 里、1.0 字级
 * 时间戳是驼峰字段+秒）逐条记录在 DEVELOPMENT.md 的「Volcengine TTS」条目下。
 */
export class VolcengineTTSClient extends BaseRealtimeTTSClient {
  private ws?: WebSocket;
  /** 连接级状态：StartConnection / ConnectionStarted。 */
  private connectionState: "idle" | "starting" | "ready" | "finishing" = "idle";
  /** 会话级状态：StartSession / SessionStarted / FinishSession。 */
  private sessionState: "idle" | "starting" | "active" | "finishing" = "idle";
  private sessionId = "";
  /** 已产生但尚未下发的文本。 */
  private pendingText: string[] = [];
  private flushRequested = false;
  private finishPromise?: Promise<void>;
  private finishResolve?: () => void;
  /** 句序号：本库统一分配，1-based，跨会话连续。 */
  private sentenceSeq = 0;
  private currentSentence: Sentence | null = null;
  /** 回看一帧：音频帧与句子结束是两个事件，压住一帧才能判定句尾。 */
  private heldChunk: HeldChunk | null = null;

  private readonly mode: "duplex" | "oneshot";
  private readonly apiKey: string;
  private readonly resourceId: string;
  private readonly appId?: string;
  private readonly accessKey?: string;
  private readonly url: string;
  private readonly speaker: string;
  private readonly outputFormat: TTSAudioFormat;
  private readonly outputSampleRate: number;

  constructor(config: VolcengineTTSConfig) {
    super(config.options);
    this.mode = config.mode ?? "duplex";
    this.apiKey = config.apiKey;
    this.resourceId = config.resourceId ?? DEFAULT_RESOURCE_ID;
    this.appId = config.appId;
    this.accessKey = config.accessKey;
    this.url = config.url ?? (this.mode === "duplex" ? URL_DUPLEX : URL_ONESHOT);
    this.speaker = config.options?.voice?.trim() ?? "";
    this.outputFormat = config.options?.format ?? "pcm";
    this.outputSampleRate = config.options?.sampleRate ?? DEFAULT_SAMPLE_RATE;
  }

  get provider(): string {
    return "volcengine";
  }

  get capabilities(): TTSCapabilities {
    return {
      transport: "websocket",
      incrementalText: this.mode === "duplex",
      sessionReuse: true,
      formats: ["pcm", "wav", "mp3", "opus"],
      sampleRates: [8000, 16000, 22050, 24000, 44100, 48000],
      instructions: false, // 无自然语言指令参数（情感走 extra 里的 emotion）
      voiceCloning: true, // seed-icl-* 声音复刻
      wordTimestamps: true, // audio_params.enable_timestamp（TTS 1.0 音色）
    };
  }

  protected async connectImpl(): Promise<void> {
    if (!this.speaker) {
      throw new TTSError(
        "火山 TTS 需要 options.voice（音色名，如 'zh_female_vv_uranus_bigtts'）；各家音色名不通用，本库不猜默认值。",
        "missing-voice",
      );
    }

    const headers: Record<string, string> = {
      "X-Api-Key": this.apiKey,
      "X-Api-Resource-Id": this.resourceId,
      "X-Api-Connect-Id": randomUUID(),
    };
    // 旧版控制台鉴权
    if (this.appId && this.accessKey) {
      headers["X-Api-App-Id"] = this.appId;
      headers["X-Api-Access-Key"] = this.accessKey;
    }

    this.connectionState = "starting";
    this.sessionState = "idle";
    this.sessionId = "";
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
        if (this.mode === "duplex") {
          // 双向流式：握手后必须 StartConnection，等 ConnectionStarted 才能开 session。
          this.sendFrame(EVENT.StartConnection, undefined, {});
        } else {
          // 单向流式：合成阶段不发送任何上行 event 帧，把文本帧发出去即可（实测确认）。
          // 若这里多发一个 StartConnection，服务端会报
          //   55000000 "resource ID is mismatched with speaker related resource"
          this.connectionState = "ready";
        }
      });
      ws.on("message", (data, isBinary) => this.onMessage(data, isBinary));
      ws.on("error", (err) => this.emitError(new TTSError("WebSocket 错误", "ws", err)));
      ws.on("close", (code, reason) => {
        this.releaseFinish();
        this.heldChunk = null;
        this.connectionState = "idle";
        this.sessionState = "idle";
        this.handleDisconnect(code, reason?.toString());
      });
      ws.on("unexpected-response", (_req, res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8").trim();
          const status = res.statusCode ?? 0;
          const hint = body.includes("not granted")
            ? "（该 API Key 未开通语音合成服务，需在火山控制台开通并确认 resource-id）"
            : "";
          const message = `握手失败：HTTP ${status}${body ? ` ${body}` : ""}${hint}`;
          reject(
            status === 401 || status === 403
              ? new TTSAuthError(message, "handshake")
              : new TTSError(message, "handshake"),
          );
        });
      });
    });
  }

  /* ------------------------------- 上行文本 ------------------------------- */

  protected sendTextImpl(text: string): void {
    if (!text) return;
    this.pendingText.push(text);
    if (this.mode === "duplex") this.ensureSession();
  }

  protected flushImpl(): Promise<void> {
    if (this.mode === "oneshot") return this.flushOneshot();
    return this.flushDuplex();
  }

  /** 双向流式：FinishSession 结束本轮，服务端把已收文本全部合成。 */
  private flushDuplex(): Promise<void> {
    if (this.sessionState === "idle" && this.pendingText.length === 0) return Promise.resolve();
    this.flushRequested = true;
    const pending = this.armFinish();
    this.ensureSession();
    this.maybeFinishSession();
    return pending;
  }

  /** 单向流式：把攒下的文本拼成一帧发出去，连接保留给下一轮。 */
  private flushOneshot(): Promise<void> {
    if (this.pendingText.length === 0) return Promise.resolve();
    const text = this.pendingText.join("");
    this.pendingText = [];
    const pending = this.armFinish();
    this.sendFrame(undefined, undefined, {
      user: { uid: randomUUID() },
      namespace: NAMESPACE,
      req_params: {
        speaker: this.speaker,
        text,
        audio_params: this.audioParams(),
      },
    });
    return pending;
  }

  private ensureSession(): void {
    if (this.sessionState !== "idle") return;
    if (this.connectionState !== "ready") return; // 等 ConnectionStarted
    if (this.pendingText.length === 0 && !this.flushRequested) return;
    this.sessionId = randomUUID();
    this.sessionState = "starting";
    this.sendFrame(EVENT.StartSession, this.sessionId, {
      event: EVENT.StartSession,
      namespace: NAMESPACE,
      req_params: { speaker: this.speaker, audio_params: this.audioParams() },
    });
  }

  /** SessionStarted 之后才能发 TaskRequest / FinishSession（文档明确要求）。 */
  private drainPendingText(): void {
    if (this.sessionState !== "active" || this.pendingText.length === 0) return;
    const text = this.pendingText.join("");
    this.pendingText = [];
    this.sendFrame(EVENT.TaskRequest, this.sessionId, {
      event: EVENT.TaskRequest,
      namespace: NAMESPACE,
      req_params: { text },
    });
  }

  private maybeFinishSession(): void {
    if (!this.flushRequested || this.sessionState !== "active") return;
    this.sessionState = "finishing";
    this.sendFrame(EVENT.FinishSession, this.sessionId, { event: EVENT.FinishSession });
  }

  private audioParams(): Record<string, unknown> {
    const opts = this.options;
    return {
      format: this.outputFormat === "opus" ? "ogg_opus" : this.outputFormat,
      sample_rate: this.outputSampleRate,
      // 统一选项 → 火山参数：speed 是倍率（1.0 = 原速），火山用 [-50,100] 的 speech_rate；
      // volume 是 0-100（50 = 原音量），火山用 [-50,100] 的 loudness_rate。两者都是近似线性换算。
      ...(opts.speed !== undefined ? { speech_rate: clamp((opts.speed - 1) * 100, -50, 100) } : {}),
      ...(opts.volume !== undefined
        ? { loudness_rate: clamp((opts.volume - 50) * 2, -50, 100) }
        : {}),
      // 厂商私有参数（emotion / enable_timestamp / bit_rate …）透传进 audio_params
      ...opts.extra,
    };
  }

  private sendFrame(
    event: number | undefined,
    sessionId: string | undefined,
    payload: object,
  ): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      encodeFrame({
        event,
        sessionId,
        serialization: SER_JSON,
        payload: Buffer.from(JSON.stringify(payload), "utf-8"),
      }),
    );
  }

  private armFinish(): Promise<void> {
    if (!this.finishPromise) {
      this.finishPromise = new Promise<void>((resolve) => {
        this.finishResolve = resolve;
      });
    }
    return this.finishPromise;
  }

  /* ------------------------------- 下行事件 ------------------------------- */

  /**
   * 火山**所有**帧都走 WebSocket binary 消息（实测确认：控制事件也是 binary），
   * 因此不能按 `isBinary` 分流 —— 必须一律按 envelope 解码，由帧内的 messageType
   * 区分控制帧与音频帧。曾因按 isBinary 分类而把事件帧当音频吞掉、状态机卡死。
   */
  private onMessage(data: WebSocket.RawData, _isBinary: boolean): void {
    const buf = toBuffer(data);
    let frame: VolcFrame;
    try {
      frame = decodeFrame(buf);
    } catch (err) {
      this.emitError(
        new TTSProtocolError(
          `无法解析服务端帧（len=${buf.length} hex=${buf.subarray(0, 24).toString("hex")}）`,
          undefined,
          err,
        ),
      );
      return;
    }
    this.onFrame(frame);
  }

  private onFrame(frame: VolcFrame): void {
    if (frame.messageType === MSG_ERROR) {
      this.emitError(
        new TTSProtocolError(
          `火山 TTS 错误帧：code=${frame.errorCode ?? "?"} ${frame.payload.toString("utf-8").slice(0, 200)}`,
        ),
      );
      return;
    }
    // 音频也可能走 audio-only response（不带 event），payload 即原始音频字节。
    if (frame.messageType === MSG_AUDIO_ONLY_RESPONSE) {
      this.onAudioPayload(frame.payload);
      return;
    }
    if (frame.messageType !== MSG_FULL_SERVER_RESPONSE) return;

    // 带 event 的控制/数据事件：payload 是 JSON；TTSResponse(352) 的 payload 是音频字节。
    switch (frame.event) {
      case EVENT.ConnectionStarted:
        this.connectionState = "ready";
        this.ensureSession();
        break;
      case EVENT.ConnectionFailed:
        this.emitError(new TTSProtocolError(`连接失败：${frame.payload.toString("utf-8")}`));
        this.releaseFinish();
        break;
      case EVENT.ConnectionFinished:
        this.connectionState = "idle";
        this.releaseFinish();
        break;
      case EVENT.SessionStarted:
        this.sessionState = "active";
        this.drainPendingText();
        this.maybeFinishSession();
        break;
      case EVENT.SessionFinished:
        this.onSessionEnd();
        break;
      case EVENT.SessionCanceled:
        this.onSessionEnd();
        break;
      case EVENT.SessionFailed:
        this.onSessionFailed(frame.payload);
        break;
      case EVENT.TTSSentenceStart:
        this.beginSentence(frame.payload);
        break;
      case EVENT.TTSSentenceEnd:
        this.onSentenceEnd(frame.payload);
        break;
      case EVENT.TTSResponse:
        this.onAudioPayload(frame.payload);
        break;
      case EVENT.TTSEnded:
        this.flushHeldChunk(true);
        this.releaseFinish();
        break;
      default:
        break;
    }
  }

  private onSessionEnd(): void {
    this.flushHeldChunk(true);
    this.currentSentence = null;
    this.sessionState = "idle";
    this.flushRequested = false;
    this.releaseFinish();
    // 双向流式：flush 之后又追加的文本，在同一连接上开新一轮 session。
    if (this.mode === "duplex") this.ensureSession();
  }

  private onSessionFailed(payload: Buffer): void {
    this.flushHeldChunk(true);
    this.currentSentence = null;
    this.sessionState = "idle";
    this.flushRequested = false;
    this.releaseFinish();
    const detail = payload.toString("utf-8").slice(0, 300);
    this.emitError(
      /not granted|permission|unauthor/i.test(detail)
        ? new TTSAuthError(`会话失败：${detail}`, "session-failed")
        : new TTSProtocolError(`会话失败：${detail}`, "session-failed"),
    );
  }

  private beginSentence(payload?: Buffer): void {
    const meta = parseJsonObject(payload);
    this.currentSentence = {
      id: `s${++this.sentenceSeq}`,
      index: this.sentenceSeq,
      ...(meta ? sentenceMeta(meta) : {}),
    };
  }

  private onSentenceEnd(payload?: Buffer): void {
    const meta = parseJsonObject(payload);
    if (this.currentSentence && meta) {
      const { text, words } = sentenceMeta(meta);
      if (text) this.currentSentence.text = text;
      if (words) this.currentSentence.words = words;
    }
    this.flushHeldChunk(true);
    this.currentSentence = null;
  }

  /** 收到一帧音频：先回看上一帧，再压住当前帧等待「句子结束」。 */
  private onAudioPayload(audio: Buffer): void {
    if (audio.length === 0) return;
    const sentence = this.currentSentence ?? this.beginOrphanSentence();
    if (this.heldChunk) {
      this.flushHeldChunk(this.heldChunk.sentence.id !== sentence.id);
    }
    this.heldChunk = { audio, sentence };
  }

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

    // 还有在途会话或排队文本：借关闭前最后一次机会合成完。
    if (this.sessionState !== "idle" || this.pendingText.length > 0) {
      const pending = this.armFinish();
      if (this.mode === "oneshot") {
        const text = this.pendingText.join("");
        this.pendingText = [];
        if (text) {
          this.flushRequested = true;
          this.sendFrame(undefined, undefined, {
            user: { uid: randomUUID() },
            namespace: NAMESPACE,
            req_params: { speaker: this.speaker, text, audio_params: this.audioParams() },
          });
        }
      } else {
        this.flushRequested = true;
        this.ensureSession();
        this.maybeFinishSession();
      }
      await Promise.race([pending, delay(CLOSE_DRAIN_MS)]);
    }

    this.flushHeldChunk(true);
    this.releaseFinish();

    // 关闭连接阶段才发 FinishConnection。
    if (this.connectionState === "ready" && ws.readyState === WebSocket.OPEN) {
      this.sendFrame(EVENT.FinishConnection, undefined, {});
    }

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

interface Sentence {
  id: string;
  index: number;
  /** 句文本：实测只在 TTSSentenceEnd(351) 的 payload 里给（sentence-start 的 text 为空）。 */
  text?: string;
  words?: TTSWord[];
}

interface HeldChunk {
  audio: Buffer;
  /** 持有句对象引用：元信息后续补齐后，发出时自动可见。 */
  sentence: Sentence;
}

/* --------------------------------- 常量 --------------------------------- */

const URL_DUPLEX = "wss://openspeech.bytedance.com/api/v3/tts/bidirection";
const URL_ONESHOT = "wss://openspeech.bytedance.com/api/v3/tts/unidirectional/stream";
const DEFAULT_RESOURCE_ID = "seed-tts-2.0";
const DEFAULT_SAMPLE_RATE = 24000;
const CLOSE_DRAIN_MS = 3000;
/** 两种模式的 payload 都用这个 namespace（官方文档示例如此）。 */
const NAMESPACE = "BidirectionalTTS";

/** 事件编号（doc 6561/1719100 §2.3 与 SDK 文档一致）。 */
const EVENT = {
  StartConnection: 1,
  FinishConnection: 2,
  ConnectionStarted: 50,
  ConnectionFailed: 51,
  ConnectionFinished: 52,
  StartSession: 100,
  FinishSession: 102,
  SessionStarted: 150,
  SessionCanceled: 151,
  SessionFinished: 152,
  SessionFailed: 153,
  TaskRequest: 200,
  TTSSentenceStart: 350,
  TTSSentenceEnd: 351,
  TTSResponse: 352,
  TTSEnded: 359,
} as const;

/* --------------------------------- 工具 --------------------------------- */

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseJsonObject(payload?: Buffer): any | undefined {
  if (!payload || payload.length === 0) return undefined;
  try {
    const parsed = JSON.parse(payload.toString("utf-8"));
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 从 TTSSentenceStart/End 的 payload 里提取句文本与字级时间戳。 */
function sentenceMeta(meta: any): { text?: string; words?: TTSWord[] } {
  const text = typeof meta?.text === "string" && meta.text.length > 0 ? meta.text : undefined;
  const words = toWords(meta);
  return { ...(text ? { text } : {}), ...(words ? { words } : {}) };
}

/**
 * 字级时间戳（需在 `extra` 里开 `enable_timestamp`，目前仅 TTS 1.0 / ICL 1.0 音色提供）。
 *
 * 实测 `seed-tts-1.0` 的载荷是**驼峰字段 + 单位秒**：
 * ```json
 * { "text": "今天天气怎么样", "words": [
 *   { "word": "今", "startTime": 0.105, "endTime": 0.265, "confidence": 0.97 }, … ] }
 * ```
 * 而 2.0 文档描述的是下划线字段 + 毫秒（`begin_time` / `end_time`）。两种都认，
 * 统一归一化成**毫秒**（`TTSWord` 的约定）：按字段名判断单位，不做数值猜测。
 */
function toWords(meta: any): TTSWord[] | undefined {
  const raw = meta?.words ?? meta?.additions?.words;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const words: TTSWord[] = [];
  for (const w of raw) {
    const text = String(w?.word ?? w?.text ?? "");
    if (!text) continue;
    const startSec = num(w?.startTime);
    const endSec = num(w?.endTime);
    const beginTime =
      startSec !== undefined ? Math.round(startSec * 1000) : num(w?.begin_time ?? w?.start_time); // 下划线分支：文档口径已是毫秒
    const endTime = endSec !== undefined ? Math.round(endSec * 1000) : num(w?.end_time);
    const beginIndex = num(w?.begin_index);
    const endIndex = num(w?.end_index);
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

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
