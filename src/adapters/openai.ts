import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { BaseRealtimeASRClient } from "../core/base-client.js";
import { ASRError, ASRProtocolError } from "../core/errors.js";
import type { OpenAIConfig, RealtimeASROptions } from "../types.js";

export type RealtimeMessage =
  | { kind: "ignore" }
  | { kind: "start" }
  | { kind: "partial"; text: string; id?: string; index?: number }
  | { kind: "final"; text: string; id?: string; index?: number }
  | { kind: "error"; message: string };

/**
 * OpenAI Realtime 转录协议引擎（transcription_sessions）。
 *
 * 仅覆盖 OpenAI 自己的实时听写接口：WebSocket(Bearer) -> 发 update_session
 * -> 推 `input_audio_buffer.append` 音频流 -> 收 `transcription.delta/completed`
 * 事件。这是目前唯一真正做"实时转录(transcription)、模型不回嘴"的
 * OpenAI-Realtime 风格接口。
 *
 * 注意：智谱 GLM / MiniMax 的"实时"是语音对话（模型会回嘴）接口，并非
 * transcription_sessions 这种只听写不回嘴的形态，因此不属于本引擎。
 * DashScope（Paraformer）、Volcengine 是另一套私有/独立协议，也不继承本类。
 */
export class OpenAIASRClient extends BaseRealtimeASRClient {
  /** Base WebSocket URL（auth 走 Bearer 头）。 */
  protected url = "wss://api.openai.com/v1/realtime/transcription_sessions?intent=transcription";
  protected authHeaderName = "Authorization";
  protected apiKeyPrefix = "Bearer ";
  /** 音频发送方式：base64 放进 JSON 字段。 */
  protected audioMode: "binary" | "base64-json" = "base64-json";
  protected audioAppendType = "input_audio_buffer.append";
  protected audioField = "audio";
  /** 是否必须等 start 事件到达后才能发音频。 */
  protected gateAudioOnStart = false;

  private ws?: WebSocket;
  private taskId = "";
  private started = false;
  private audioBuffer: Uint8Array[] = [];
  private apiKey: string;
  /** item_id -> 1-based 句序号，用于 Transcript.index。 */
  private itemIndex = new Map<string, number>();
  private itemSeq = 0;

  constructor(config: OpenAIConfig) {
    super(config.options);
    this.apiKey = config.apiKey;
    this.url = config.url ?? this.url;
  }

  get provider(): string {
    return "openai";
  }

  protected async connectImpl(): Promise<void> {
    const headers: Record<string, string> = {};
    headers[this.authHeaderName] = `${this.apiKeyPrefix}${this.apiKey}`;

    this.taskId = randomUUID();
    this.started = !this.gateAudioOnStart;
    this.audioBuffer = [];
    this.itemIndex.clear();
    this.itemSeq = 0;
    this.ws = new WebSocket(this.url, { headers });

    await new Promise<void>((resolve, reject) => {
      if (!this.ws) return reject(new ASRError("WebSocket uninitialized"));
      this.ws.on("open", () => {
        this.ws!.send(JSON.stringify(this.buildSessionUpdate(this.options, this.taskId)));
        this.emit("open");
        resolve();
      });
      this.ws.on("message", (data) => this.onMessage(data));
      this.ws.on("error", (err) => this.emit("error", new ASRError("WebSocket error", "ws", err)));
      this.ws.on("close", (code, reason) => this.handleDisconnect(code, reason?.toString()));
      this.ws.on("unexpected-response", (_req, res) =>
        reject(new ASRError(`Handshake failed: ${res.statusCode}`, "handshake")),
      );
    });
  }

  private onMessage(data: WebSocket.RawData): void {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const r = this.handle(msg);
    switch (r.kind) {
      case "start":
        this.started = true;
        if (this.gateAudioOnStart) {
          for (const chunk of this.audioBuffer) this.ws!.send(chunk);
          this.audioBuffer = [];
        }
        break;
      case "partial":
        this.emitTranscript({
          text: r.text,
          isFinal: false,
          ...(r.id ? { id: r.id } : {}),
          ...(r.index !== undefined ? { index: r.index } : {}),
          raw: msg,
        });
        break;
      case "final":
        this.emitTranscript({
          text: r.text,
          isFinal: true,
          ...(r.id ? { id: r.id } : {}),
          ...(r.index !== undefined ? { index: r.index } : {}),
          raw: msg,
        });
        break;
      case "error":
        this.emit("error", new ASRProtocolError(r.message));
        break;
      case "ignore":
        break;
    }
  }

  protected sendAudioImpl(pcm: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.started) {
      this.audioBuffer.push(pcm); // 等 start 事件后统一 flush
      return;
    }
    if (this.audioMode === "binary") {
      this.ws.send(pcm);
    } else {
      const audio = Buffer.from(pcm).toString("base64");
      this.ws.send(JSON.stringify({ type: this.audioAppendType, [this.audioField]: audio }));
    }
  }

  protected async closeImpl(): Promise<void> {
    if (!this.ws) return;
    try {
      if (this.ws.readyState === WebSocket.OPEN) {
        const finish = this.buildFinish(this.taskId);
        if (finish) this.ws.send(JSON.stringify(finish));
      }
    } catch {
      /* ignore */
    }
    this.ws.close(1000);
  }

  /** 配置会话（OpenAI transcription_sessions）。 */
  protected buildSessionUpdate(opts: RealtimeASROptions, _taskId: string): Record<string, unknown> {
    return {
      type: "update_session",
      session: {
        input_audio_format: opts.format === "pcm" ? "pcm16" : opts.format,
        input_audio_transcription: { model: opts.transcriptionModel ?? "gpt-4o-transcribe" },
        turn_detection: { type: "server_vad" },
      },
    };
  }

  /** 构造关闭消息（清空音频缓冲）。返回 null 表示无需发送。 */
  protected buildFinish(_taskId: string): Record<string, unknown> | null {
    return { type: "input_audio_buffer.clear" };
  }

  /** 把一条服务端消息归类为统一模型（OpenAI transcription_sessions 事件）。 */
  protected handle(msg: any): RealtimeMessage {
    const t: string | undefined = msg?.type;
    if (t === "session.created" || t === "session.updated") return { kind: "start" };
    if (t === "conversation.item.input_audio_transcription.delta")
      return {
        kind: "partial",
        text: String(msg?.delta ?? ""),
        id: msg?.item_id,
        index: msg?.item_id ? this.indexForItem(msg.item_id) : undefined,
      };
    if (t === "conversation.item.input_audio_transcription.completed")
      return {
        kind: "final",
        text: String(msg?.transcript ?? ""),
        id: msg?.item_id,
        index: msg?.item_id ? this.indexForItem(msg.item_id) : undefined,
      };
    if (t === "error")
      return { kind: "error", message: String(msg?.error?.message ?? "realtime error") };
    return { kind: "ignore" };
  }

  /** 给每个 item_id 分配一个稳定的 1-based 句序号（首次见到时 +1）。 */
  private indexForItem(itemId: string): number {
    let idx = this.itemIndex.get(itemId);
    if (idx === undefined) {
      this.itemSeq += 1;
      idx = this.itemSeq;
      this.itemIndex.set(itemId, idx);
    }
    return idx;
  }
}
