import WebSocket from "ws";
import { gzipSync, gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { BaseRealtimeASRClient } from "../core/base-client.js";
import { ASRError, ASRConnectionError, ASRProtocolError } from "../core/errors.js";
import type { RealtimeASROptions } from "../types.js";
/* -------------------------------------------------------------------------- */
/* 火山引擎「双向流式语音识别 WebSocket」(doc 2630027) —— 私有二进制帧协议     */
/*                                                                            */
/* 与 TTS「双向流式-V3」(doc 1329505) 共用同一套 WebSocket 二进制帧协议，     */
/* 鉴权走新版控制台的 X-Api-Key（不再是旧版 NLS 的 HMAC token）。             */
/*                                                                            */
/* 帧结构（大端）：                                                           */
/*   byte0 : (protocol_version=1 << 4) | (header_size=1)        => 0x11      */
/*   byte1 : (message_type << 4) | message_type_specific_flags                */
/*   byte2 : (serialization << 4) | compression_method                       */
/*           serialization: 0=raw(音频) 1=JSON(文本)                         */
/*           compression : 0=none       1=gzip                               */
/*   byte3 : reserved (0)                                                      */
/*   [可选] event number    (4B, 仅 WITH_EVENT 标志位时)                      */
/*   [可选] sequence number  (4B, 有符号, 仅 WITH_SEQUENCE 标志位时)          */
/*   payload size           (4B, uint32 BE)                                   */
/*   payload                (gzip(JSON) 或 gzip(raw pcm))                     */
/* -------------------------------------------------------------------------- */

const PROTOCOL_VERSION = 0b0001;
const HEADER_SIZE = 0b0001; // 单位：4 字节

const FULL_CLIENT_REQUEST = 0b0001; // 1  客户端初始化（full client request）
const AUDIO_ONLY_REQUEST = 0b0010; // 2  客户端音频包
const FULL_SERVER_RESPONSE = 0b1001; // 9  服务端文本/识别结果
const AUDIO_ONLY_RESPONSE = 0b1011; // 11 服务端音频（ASR 不使用）
const ERROR_INFO = 0b1111; // 15 错误帧

// message_type_specific_flags（byte1 低 4 位）。
// 正序 / 负序不靠不同 flag 区分，而是靠携带的 sequence 数值的符号：
//   末包 = WITH_SEQUENCE 帧，但 sequence 取负值。
const WITH_SEQUENCE = 0b0001; // 帧头后携带 4B sequence number
const WITH_EVENT = 0b0010; // 帧头后携带 4B event number

const SER_RAW = 0b0000;
const SER_JSON = 0b0001;
const COMP_GZIP = 0b0001;

function buildHeader(
  messageType: number,
  flags: number,
  serialization: number,
  compression: number,
): Buffer {
  return Buffer.from([
    (PROTOCOL_VERSION << 4) | HEADER_SIZE, // 0x11
    (messageType << 4) | flags,
    (serialization << 4) | compression,
    0x00, // reserved
  ]);
}

function frameWith(
  payload: Buffer,
  messageType: number,
  flags: number,
  serialization: number,
  compression: number,
  seq?: number,
): Buffer {
  const header = buildHeader(messageType, flags, serialization, compression);
  const parts: Buffer[] = [header];
  if (flags & WITH_SEQUENCE) {
    const s = Buffer.alloc(4);
    s.writeInt32BE(seq ?? 0, 0);
    parts.push(s);
  }
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length, 0);
  parts.push(len, payload);
  return Buffer.concat(parts);
}

interface DecodedFrame {
  messageType: number;
  flags: number;
  serialization: number;
  compression: number;
  /** 仅当帧头带 WITH_SEQUENCE 标志位时存在（有符号 4B）。 */
  sequence?: number;
  payloadSize: number;
  payload: Buffer;
}

function decodeFrame(buf: Buffer): DecodedFrame {
  if (buf.length < 4) throw new Error("Volcengine frame too short");
  let offset = 1; // byte0: protocol version + header size
  const b1 = buf[offset++];
  const messageType = (b1 >> 4) & 0x0f;
  const flags = b1 & 0x0f;
  const b2 = buf[offset++];
  const serialization = (b2 >> 4) & 0x0f;
  const compression = b2 & 0x0f;
  offset += 1; // byte3: reserved

  let sequence: number | undefined;
  if (flags & WITH_SEQUENCE) {
    sequence = buf.readInt32BE(offset);
    offset += 4;
  }
  if (flags & WITH_EVENT) {
    offset += 4; // event number, 本客户端用不到
  }
  const payloadSize = buf.readUInt32BE(offset);
  offset += 4;
  const payload = buf.subarray(offset, offset + payloadSize);
  return { messageType, flags, serialization, compression, sequence, payloadSize, payload };
}

// 火山引擎「大模型流式语音识别」统一端点（doc 1354869）。
// bigasr（1.0）与 seedasr（2.0）两种 resource-id 都走同一 WebSocket 地址，
// 仅靠 X-Api-Resource-Id 头区分；旧的 /api/v3/asr 路径已废弃。
const BIGASR_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel";
const DEFAULT_RESOURCE_ID = "volc.seedasr.sauc.duration"; // 豆包流式语音识别 2.0 小时版

function resolveUrl(_resourceId: string, explicit?: string): string {
  return explicit ?? BIGASR_URL;
}

export interface VolcengineClientOptions {
  /** 新版控制台 API Key，作为 X-Api-Key。 */
  apiKey: string;
  /** X-Api-Resource-Id，决定模型版本与计费。默认 2.0 小时版。 */
  resourceId?: string;
  /** 可选的应用标识，仅在某些后端组合下需要。 */
  appId?: string;
  /** 覆盖默认 WebSocket 端点。 */
  url?: string;
  options?: RealtimeASROptions;
}

/**
 * 火山引擎双向流式语音识别客户端（私有二进制协议，非 OpenAI-Realtime 风格）。
 *
 * 按「私有协议不该塞进 OpenAIRealtimeASRClient 引擎」的划分，这里是一个
 * 独立的 {@link BaseRealtimeASRClient} 子类，直接实现 V3 帧编解码。
 */
export class VolcengineASRClient extends BaseRealtimeASRClient {
  private ws?: WebSocket;
  private readonly apiKey: string;
  private readonly resourceId: string;
  private readonly appId?: string;
  private readonly url: string;

  constructor(opts: VolcengineClientOptions) {
    super(opts.options);
    this.apiKey = opts.apiKey;
    this.resourceId = opts.resourceId ?? DEFAULT_RESOURCE_ID;
    this.appId = opts.appId;
    this.url = resolveUrl(this.resourceId, opts.url);
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
      show_utterances: true, // 返回分句信息（调用方如需按句拆分可选）
      result_type: "full",
      // 说话人聚类分离：仅当 language 为空或 zh-CN（本适配器默认即如此）时可用。
      ...(opts.speakerDiarization
        ? { enable_speaker_info: true, ssd_version: "200" }
        : {}),
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
    return frameWith(compressed, FULL_CLIENT_REQUEST, 0, SER_JSON, COMP_GZIP);
  }

  protected sendAudioImpl(pcm: Uint8Array): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const compressed = gzipSync(Buffer.from(pcm));
    ws.send(frameWith(compressed, AUDIO_ONLY_REQUEST, 0, SER_RAW, COMP_GZIP));
  }

  // 适配器只负责协议：连、推音频、转发结果。结束/收尾（排空、补 final）由调用方决定，
  // 因此 closeImpl 仅做最小关闭并等待底层连接断开。
  protected async closeImpl(): Promise<void> {
    const ws = this.ws;
    if (!ws) return;
    try {
      ws.close(1000);
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 4000); // 兜底：等服务端回关
      ws.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private onMessage(data: WebSocket.RawData): void {
    const buf = toBuffer(data);
    if (buf.length < 4) return;
    this.parseFrame(buf);
  }

  private parseFrame(buf: Buffer): void {
    let decoded: DecodedFrame;
    try {
      decoded = decodeFrame(buf);
    } catch (err) {
      this.emit("error", new ASRProtocolError("无法解析服务端帧", undefined, err));
      return;
    }
    const { messageType, serialization, compression, payload } = decoded;

    if (messageType === ERROR_INFO) {
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
    if (messageType !== FULL_SERVER_RESPONSE && messageType !== AUDIO_ONLY_RESPONSE) return;
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
    // 仅转发识别文本为 partial。结束判定与 final 收尾交给调用方（见 examples/basic.ts）。
    const text: string | undefined =
      typeof body?.result?.text === "string" ? body.result.text : undefined;
    if (text) {
      const speaker = this.extractSpeaker(body.result);
      this.emitTranscript({
        text,
        isFinal: false,
        ...(speaker !== undefined ? { speaker } : {}),
        raw: body,
      });
    }
  }

  /**
   * 提取说话人标签。开启 `enable_speaker_info` 后，火山引擎在 `result` 顶层或
   * 每个 `utterances[]` 上返回 `speaker`（字符串，如 "1"）。多路径读取以兼容
   * 不同版本响应结构。
   */
  private extractSpeaker(result: any): string | undefined {
    if (!result || typeof result !== "object") return undefined;
    if (typeof result.speaker === "string") return result.speaker;
    const utts = result.utterances;
    if (Array.isArray(utts) && utts.length) {
      const last = utts[utts.length - 1];
      if (last && typeof last.speaker === "string") return last.speaker;
    }
    return undefined;
  }
}

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}
