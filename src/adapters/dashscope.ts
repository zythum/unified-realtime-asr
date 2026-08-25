import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { BaseRealtimeASRClient } from "../core/base-client.js";
import { ASRError, ASRProtocolError } from "../core/errors.js";
import type { RealtimeASROptions } from "../types.js";

/**
 * 阿里百炼 / DashScope（千问 Fun-ASR / Qwen-ASR）。
 *
 * 与 OpenAI 同族不同协议：发裸二进制 PCM 帧、消息信封为 {header,payload} 嵌套、
 * 且必须等 task-started 才能推音频。因此不继承 OpenAIRealtimeASRClient，而是基于
 * BaseRealtimeASRClient 独立实现（与 Volcengine 的「独立私有协议」取向一致）。
 */
export class DashScopeRealtimeASRClient extends BaseRealtimeASRClient {
  private ws?: WebSocket;
  private taskId = "";
  private started = false;
  private audioBuffer: Uint8Array[] = [];
  private finishResolve?: () => void;
  private apiKey: string;
  private url: string;
  private headers: Record<string, string>;

  constructor(config: {
    apiKey: string;
    model?: string;
    workspaceId?: string;
    region?: "cn-beijing" | "ap-southeast-1";
    workspace?: string;
    url?: string;
    options?: RealtimeASROptions;
  }) {
    const options = {
      ...config.options,
      transcriptionModel: config.model ?? config.options?.transcriptionModel,
    };
    super(options);
    this.apiKey = config.apiKey;
    this.url = config.url ?? buildDashScopeUrl(config.workspaceId, config.region);
    this.headers = config.workspace ? { "X-DashScope-WorkSpace": config.workspace } : {};
  }

  get provider(): string {
    return "dashscope";
  }

  protected async connectImpl(): Promise<void> {
    const headers: Record<string, string> = {
      ...this.headers,
      Authorization: `Bearer ${this.apiKey}`,
    };
    this.taskId = randomUUID();
    this.started = false;
    this.audioBuffer = [];
    this.ws = new WebSocket(this.url, { headers });

    await new Promise<void>((resolve, reject) => {
      if (!this.ws) return reject(new ASRError("WebSocket uninitialized"));
      this.ws.on("open", () => {
        this.ws!.send(JSON.stringify(this.buildRunTask()));
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

  private buildRunTask(): Record<string, unknown> {
    const opts = this.options;
    const parameters: Record<string, unknown> = {
      format: opts.format ?? "pcm",
      sample_rate: opts.sampleRate ?? 16000,
    };
    const lang = mapLanguage(opts.language);
    if (lang) parameters.language_hints = [lang];
    return {
      header: { action: "run-task", task_id: this.taskId, streaming: "duplex" },
      payload: {
        task_group: "audio",
        task: "asr",
        function: "recognition",
        // 百炼「Paraformer 实时语音识别」WebSocket 接口的模型名为 paraformer-realtime-v2。
        // （qwen-audio-* 属于另一套非 WebSocket 接口，用在此处会导致任务空跑、无识别结果。）
        model: opts.transcriptionModel ?? "paraformer-realtime-v2",
        parameters,
        input: {},
      },
    };
  }

  private onMessage(data: WebSocket.RawData): void {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const event: string | undefined = msg?.header?.event;
    if (event === "task-started") {
      this.started = true;
      for (const chunk of this.audioBuffer) this.ws!.send(chunk);
      this.audioBuffer = [];
      return;
    }
    if (event === "result-generated") {
      const s = msg?.payload?.output?.sentence;
      if (!s || s.heartbeat) return;
      this.emitTranscript({
        text: String(s.text ?? ""),
        isFinal: Boolean(s.sentence_end),
        raw: msg,
      });
      return;
    }
    if (event === "task-finished") {
      this.finishResolve?.();
      return;
    }
    if (event === "task-failed") {
      this.emit("error", new ASRProtocolError(String(msg?.header?.error_message ?? "task failed")));
    }
  }

  protected sendAudioImpl(pcm: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.started) {
      this.audioBuffer.push(pcm); // 等 task-started 后统一 flush
      return;
    }
    this.ws.send(pcm);
  }

  protected async closeImpl(): Promise<void> {
    if (!this.ws) return;
    const ws = this.ws;
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            header: { action: "finish-task", task_id: this.taskId, streaming: "duplex" },
            payload: { input: {} },
          }),
        );
      }
    } catch {
      /* ignore */
    }
    // 等服务端回传最终结果（task-finished）后再关连接，避免截断 final 事件。
    await new Promise<void>((resolve) => {
      this.finishResolve = resolve;
      setTimeout(resolve, 3000);
    });
    ws.close(1000);
  }
}

function buildDashScopeUrl(workspaceId?: string, region?: "cn-beijing" | "ap-southeast-1"): string {
  if (workspaceId) {
    const r = region ?? "cn-beijing";
    return `wss://${workspaceId}.${r}.maas.aliyuncs.com/api-ws/v1/inference`;
  }
  return "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
}

// DashScope（Paraformer 实时 v2）官方支持的 language_hints 取值。
const DASHSCOPE_LANGUAGES = new Set(["zh", "en", "ja", "yue", "ko", "de", "fr", "ru"]);

/** 把统一 BCP-47 语言码映射为 DashScope 接受的语言码。
 *  - 取 BCP-47 主语言子标签（split('-')[0]，兼容 yue/cmn 等三位码），在官方集合内则返回规范码；
 *  - 不在集合内则【透传原始码】，兼容后续 DashScope 新增语种，无需改本适配器；
 *  - 仅 auto / 未设置返回 undefined（由模型自动识别，不发送 language_hints）。 */
function mapLanguage(lang?: string | undefined): string | undefined {
  if (!lang || lang === "auto") return undefined;
  const primary = lang.split("-")[0].toLowerCase();
  return DASHSCOPE_LANGUAGES.has(primary) ? primary : lang;
}
