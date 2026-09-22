import WebSocket from "ws";
import { gzipSync, gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { BaseRealtimeASRClient } from "../realtime-asr-client.js";
import { ASRError, ASRConnectionError, ASRProtocolError } from "../../core/errors.js";
import type { VolcengineASRConfig } from "../types.js";
import {
  MSG_AUDIO_ONLY_REQUEST,
  MSG_AUDIO_ONLY_RESPONSE,
  MSG_ERROR,
  MSG_FULL_SERVER_RESPONSE,
  SER_JSON,
  SER_RAW,
  COMP_GZIP,
  decodeFrame,
  encodeFrame,
  toBuffer,
  type VolcFrame,
} from "../../utils/volc-frames.js";

/**
 * 火山引擎双向流式语音识别 WebSocket 协议（doc 2630027 / 1354869）。
 *
 * 鉴权走新版控制台的 `X-Api-Key`，不使用旧版 NLS 的 HMAC token。
 * 二进制帧的编解码在 `utils/volc-frames.ts`（与 TTS 方向共用同一套 envelope）——
 * 本适配器只负责 ASR 特有的事：请求参数、按 utterances 分句、说话人标签。
 */

// 火山引擎「大模型流式语音识别」统一端点（doc 1354869）。
// bigasr（1.0）与 seedasr（2.0）两种 resource-id 都走同一 WebSocket 地址，
// 仅靠 X-Api-Resource-Id 头区分；旧的 /api/v3/asr 路径已废弃。
const BIGASR_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel";
const DEFAULT_RESOURCE_ID = "volc.seedasr.sauc.duration"; // 豆包流式语音识别 2.0 小时版

function resolveUrl(_resourceId: string, explicit?: string): string {
  return explicit ?? BIGASR_URL;
}

/**
 * 火山引擎双向流式语音识别客户端（私有二进制协议，非 OpenAI-Realtime 风格）。
 *
 * 按「私有协议不该塞进 OpenAIASRClient 引擎」的划分，这里是一个
 * 独立的 {@link BaseRealtimeASRClient} 子类，直接实现 V3 帧编解码。
 */
export class VolcengineASRClient extends BaseRealtimeASRClient {
  private ws?: WebSocket;
  private readonly apiKey: string;
  private readonly resourceId: string;
  private readonly appId?: string;
  private readonly url: string;
  /** 已作为 final 发出的分句 ID，避免服务端 final 与本地兜底 final 重复。 */
  private finalizedUtteranceIds = new Set<string>();
  /** 已作为 final 发出的最大分句序号（1-based），用于 fallback 分配序号。 */
  private emittedUtterances = 0;
  /** 最近一次 partial 对应的「当前活体句」，用于在会话结束时补发一条 final（兜底）。 */
  private pendingFinal: { id: string; index: number; text: string; speaker?: string } | null = null;

  constructor(config: VolcengineASRConfig) {
    super(config.options);
    this.apiKey = config.apiKey;
    this.resourceId = config.resourceId ?? DEFAULT_RESOURCE_ID;
    this.appId = config.appId;
    this.url = resolveUrl(this.resourceId, config.url);
  }

  get provider(): string {
    return "volcengine";
  }

  protected async connectImpl(): Promise<void> {
    const headers: Record<string, string> = {
      "X-Api-Key": this.apiKey,
      "X-Api-Resource-Id": this.resourceId,
      "X-Api-Request-Id": randomUUID(),
      "X-Api-Connect-Id": randomUUID(),
      "X-Api-Sequence": "-1",
    };
    if (this.appId) headers["X-Api-App-Id"] = this.appId;

    this.ws = new WebSocket(this.url, { headers });
    this.finalizedUtteranceIds.clear(); // 新会话，分句 final 去重状态归零
    this.emittedUtterances = 0; // 新会话，分句计数归零
    this.pendingFinal = null; // 新会话，清掉上一会话遗留的尾句兜底

    await new Promise<void>((resolve, reject) => {
      const ws = this.ws;
      if (!ws) return reject(new ASRError("WebSocket 未初始化"));

      ws.on("open", () => {
        try {
          ws.send(this.buildInitFrame());
        } catch (err) {
          return reject(new ASRConnectionError("发送初始化帧失败", undefined, err));
        }
        this.emit("open");
        resolve();
      });
      ws.on("message", (data) => this.onMessage(data));
      ws.on("error", (err) => this.emit("error", new ASRError("WebSocket 错误", "ws", err)));
      ws.on("close", (code, reason) => this.handleDisconnect(code, reason?.toString()));
      ws.on("unexpected-response", (_req, res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8").trim();
          const logId = res.headers["x-tt-logid"];
          const msg = [
            "握手失败",
            `status=${res.statusCode}`,
            logId ? `logid=${logId}` : "",
            body ? `body=${body}` : "",
          ]
            .filter(Boolean)
            .join(" ");
          reject(new ASRConnectionError(msg, undefined));
        });
      });
    });
  }

  /** full client request：JSON 配置 + gzip。 */
  private buildInitFrame(): Buffer {
    const opts = this.options;
    const request: Record<string, unknown> = {
      model_name: "bigmodel",
      enable_itn: opts.enableConfusion ?? true,
      enable_punc: opts.punctuation ?? true,
      enable_ddc: false,
      show_utterances: true, // 必须：utterances[] 含当前活体句与已定稿句（definite 标记），用于分句
      result_type: "full", // 该端点下 result.text 即「当前句」活体文本，直接作为 partial；定稿句由 utterances 的 definite 标记识别
      // 说话人聚类分离：仅当 language 为空或 zh-CN（本适配器默认即如此）时可用。
      ...(opts.speakerDiarization ? { enable_speaker_info: true, ssd_version: "200" } : {}),
      ...opts.extra,
    };
    const payload = {
      user: { uid: randomUUID() },
      audio: {
        format: "pcm",
        codec: "raw",
        rate: opts.sampleRate ?? 16000,
        bits: 16,
        channel: opts.channels ?? 1,
      },
      request,
    };
    const json = Buffer.from(JSON.stringify(payload), "utf-8");
    const compressed = gzipSync(json);
    // 握手头 X-Api-Sequence:-1 表示服务端自动分配序号，客户端帧不携带 sequence。
    return encodeFrame({ serialization: SER_JSON, compression: COMP_GZIP, payload: compressed });
  }

  protected sendAudioImpl(pcm: Uint8Array): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const compressed = gzipSync(Buffer.from(pcm));
    ws.send(
      encodeFrame({
        messageType: MSG_AUDIO_ONLY_REQUEST,
        serialization: SER_RAW,
        compression: COMP_GZIP,
        payload: compressed,
      }),
    );
  }

  // 适配器负责协议：连、推音频、按 utterances 分句转发结果（已完成分句发 final，
  // 当前句发 partial）。closeImpl 仅做最小关闭并等待底层连接断开；调用方仍可在
  // 关闭前保留连接一段时间，以兜底捕获最后一句话的定稿（见 examples/node/basic.ts）。
  protected async closeImpl(): Promise<void> {
    const ws = this.ws;
    if (!ws) return;
    // 先补发尾句 final（若服务端未主动定稿），再关闭连接。
    this.flushPendingFinal();

    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 4000); // 兜底：等服务端回关
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

  private onMessage(data: WebSocket.RawData): void {
    const buf = toBuffer(data);
    if (buf.length < 4) return;
    this.parseFrame(buf);
  }

  private parseFrame(buf: Buffer): void {
    let decoded: VolcFrame;
    try {
      decoded = decodeFrame(buf);
    } catch (err) {
      this.emit("error", new ASRProtocolError("无法解析服务端帧", undefined, err));
      return;
    }
    const { messageType, serialization, compression, payload } = decoded;

    if (messageType === MSG_ERROR) {
      let detail = "";
      try {
        const raw = compression === COMP_GZIP ? gunzipSync(payload) : payload;
        detail = raw.toString("utf-8");
      } catch {
        detail = `(无法解码 ${payload.length}B)`;
      }
      this.emit("error", new ASRProtocolError(`火山引擎 ASR 错误帧: ${detail}`));
      return;
    }
    if (messageType !== MSG_FULL_SERVER_RESPONSE && messageType !== MSG_AUDIO_ONLY_RESPONSE) return;
    if (serialization !== SER_JSON) return; // 服务端音频帧在 ASR 场景不出现

    let body: any;
    try {
      const raw = compression === COMP_GZIP ? gunzipSync(payload) : payload;
      body = JSON.parse(raw.toString("utf-8"));
    } catch (err) {
      this.emit("error", new ASRProtocolError("无法解析服务端响应 JSON", undefined, err));
      return;
    }
    this.handleResponse(body);
  }

  private handleResponse(body: any): void {
    if (body?.code && body.code !== 0) {
      this.emit(
        "error",
        new ASRProtocolError(`火山引擎 ASR 业务错误 ${body.code}: ${body.message ?? ""}`),
      );
      return;
    }
    const result = body?.result;
    if (!result || typeof result !== "object") return;

    const utts: any[] = Array.isArray(result.utterances) ? result.utterances : [];
    // 是否定稿：火山引擎用 definite（部分版本字段名 def）。
    const isDefinite = (u: any): boolean =>
      u?.definite === true || u?.def === true || u?.definite === 1 || u?.def === 1;

    // 1) 已定稿分句：utterances 中 definite 的为「已完成句」，逐条发 final（每个只发一次）。
    for (let i = 0; i < utts.length; i++) {
      const u = utts[i];
      if (!isDefinite(u)) continue;
      const index = i + 1;
      const id = `u${index}`;
      if (this.finalizedUtteranceIds.has(id)) continue;

      const speaker = utteranceSpeaker(u);
      this.finalizedUtteranceIds.add(id);
      this.emittedUtterances = Math.max(this.emittedUtterances, index);
      this.emitTranscript({
        text: String(u?.text ?? ""),
        isFinal: true,
        id,
        index,
        ...(speaker !== undefined ? { speaker } : {}),
        raw: body,
      });
      if (this.pendingFinal?.id === id) this.pendingFinal = null;
    }

    // 2) 当前正在识别的句：取最后一个 non-definite 分句。
    //    只有 utterances 完全缺失时才使用 result.text，避免 all-definite 响应制造伪造的下一句。
    const liveIdx = utts.reduce((acc, u, idx) => (isDefinite(u) ? acc : idx), -1);
    let partialText: string | null = null;
    if (liveIdx >= 0) partialText = String(utts[liveIdx]?.text ?? "");
    else if (utts.length === 0 && typeof result.text === "string" && result.text.length > 0) {
      partialText = result.text;
    }

    if (partialText && partialText.trim().length > 0) {
      const index = liveIdx >= 0 ? liveIdx + 1 : this.emittedUtterances + 1;
      const id = `u${index}`;
      const speaker = liveIdx >= 0 ? utteranceSpeaker(utts[liveIdx]) : resultSpeaker(result);
      this.emitTranscript({
        text: partialText,
        isFinal: false,
        id,
        index,
        ...(speaker !== undefined ? { speaker } : {}),
        raw: body,
      });
      // 记下当前活体句，便于会话结束时补发 final。
      this.pendingFinal = { id, index, text: partialText, ...(speaker ? { speaker } : {}) };
    }
  }

  /** 会话结束时，对尚未被服务端正式定稿的最后一句活体句补发 final。 */
  private flushPendingFinal(): void {
    const p = this.pendingFinal;
    if (!p || this.finalizedUtteranceIds.has(p.id)) return;
    this.pendingFinal = null;
    this.finalizedUtteranceIds.add(p.id);
    this.emittedUtterances = Math.max(this.emittedUtterances, p.index);
    this.emitTranscript({
      text: p.text,
      isFinal: true,
      id: p.id,
      index: p.index,
      ...(p.speaker !== undefined ? { speaker: p.speaker } : {}),
      raw: null,
    });
  }
}

/** 从单条 utterance 提取说话人标签（开启 enable_speaker_info 后）。兼容 speaker / additions.speaker_id。 */
function utteranceSpeaker(u: any): string | undefined {
  if (!u || typeof u !== "object") return undefined;
  if (typeof u.speaker === "string") return u.speaker;
  const sid = u?.additions?.speaker_id;
  if (typeof sid === "string") return sid;
  return undefined;
}

function resultSpeaker(result: any): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  if (typeof result.speaker === "string") return result.speaker;
  const sid = result?.additions?.speaker_id;
  return typeof sid === "string" ? sid : undefined;
}
