import WebSocket from "ws";
import { createHmac } from "node:crypto";
import { randomUUID } from "node:crypto";
import { BaseRealtimeASRClient } from "../realtime-asr-client.js";
import { ASRError, ASRConnectionError, ASRProtocolError } from "../../core/errors.js";
import type { IFlytekASRConfig } from "../types.js";

const DEFAULT_URL = "wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1";

/**
 * 科大讯飞实时语音转写大模型版 WebSocket 适配器。
 *
 * 参考文档：https://www.xfyun.cn/doc/spark/asr_llm/rtasr_llm.html
 *
 * 鉴权方式：将所有业务参数（不含 signature）按 key 升序排列，
 * URL-encode 后拼接为 baseString，再用 accessKeySecret 做 HMAC-SHA1 签名。
 *
 * 音频传输：握手成功（action: "started"）后直接发送 PCM binary，
 * 建议 40ms/1280B；结束时发送 {"end": true, "sessionId": "..."} 文本帧。
 *
 * 返回结构：msg_type="result", res_type="asr"；
 * 文本在 data.cn.st.rt[].ws[].cw[].w，type="0" 为 final，type="1" 为 partial。
 */
export class IFlytekASRClient extends BaseRealtimeASRClient {
  private readonly appId: string;
  private readonly accessKeyId: string;
  private readonly accessKeySecret: string;
  private readonly url: string;
  private ws?: WebSocket;
  private started = false;
  private audioBuffer: Uint8Array[] = [];
  private sessionId = "";
  private currentSegmentId: string | null = null;
  private currentSegmentIndex = 0;
  private segmentSeq = 0;

  constructor(config: IFlytekASRConfig) {
    super(config.options);
    this.appId = config.appId;
    this.accessKeyId = config.apiKey;
    this.accessKeySecret = config.apiSecret;
    this.url = config.url ?? DEFAULT_URL;
  }

  get provider(): string {
    return "iflytek";
  }

  protected async connectImpl(): Promise<void> {
    this.started = false;
    this.audioBuffer = [];
    this.sessionId = randomUUID();
    this.currentSegmentId = null;
    this.currentSegmentIndex = 0;
    this.segmentSeq = 0;

    const wsUrl = this.buildAuthUrl();
    this.ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      const ws = this.ws;
      if (!ws) return reject(new ASRError("WebSocket 未初始化"));

      ws.on("open", () => {
        this.emit("open");
        resolve();
      });
      ws.on("message", (data) => this.onMessage(data));
      ws.on("error", (err) => this.emit("error", new ASRError("WebSocket 错误", "ws", err)));
      ws.on("close", (code, reason) => this.handleDisconnect(code, reason?.toString()));
      ws.on("unexpected-response", (_request, response) => {
        reject(new ASRConnectionError(`握手失败: HTTP ${response.statusCode}`));
      });
    });
  }

  protected sendAudioImpl(pcm: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.started) {
      this.audioBuffer.push(pcm);
      return;
    }
    this.ws.send(pcm);
  }

  protected async closeImpl(): Promise<void> {
    const ws = this.ws;
    if (!ws) return;

    if (ws.readyState === WebSocket.OPEN && this.started) {
      try {
        ws.send(JSON.stringify({ end: true, sessionId: this.sessionId }));
      } catch {
        /* ignore */
      }
    }

    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 3000);
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

  /**
   * 构造带签名的 WebSocket URL。
   *
   * 签名规则：
   * 1. 收集所有业务参数（不含 signature）
   * 2. 按 key 升序排列
   * 3. 每个 key/value 分别 URL-encode，拼接为 key=value&... 格式
   * 4. 用 accessKeySecret 做 HMAC-SHA1，base64 编码得到 signature
   */
  private buildAuthUrl(): string {
    // 使用本地时区偏移构造 UTC 时间串
    const now = new Date();
    const offset = -now.getTimezoneOffset();
    const sign = offset >= 0 ? "+" : "-";
    const pad2 = (n: number) => String(Math.abs(n)).padStart(2, "0");
    const tzHours = pad2(Math.floor(Math.abs(offset) / 60));
    const tzMinutes = pad2(Math.abs(offset) % 60);
    const yyyy = now.getFullYear();
    const MM = pad2(now.getMonth() + 1);
    const dd = pad2(now.getDate());
    const hh = pad2(now.getHours());
    const mm = pad2(now.getMinutes());
    const ss = pad2(now.getSeconds());
    const utcStr = `${yyyy}-${MM}-${dd}T${hh}:${mm}:${ss}${sign}${tzHours}${tzMinutes}`;

    const params: Record<string, string> = {
      accessKeyId: this.accessKeyId,
      appId: this.appId,
      uuid: this.sessionId,
      utc: utcStr,
      audio_encode: "pcm_s16le",
      samplerate: String(this.options.sampleRate ?? 16000),
      lang: this.mapLang(),
    };

    // 可选参数
    if (this.options.punctuation === false) params.eng_punc = "0";
    if (this.options.speakerDiarization) params.role_type = "2";
    if (this.options.extra) {
      for (const [key, value] of Object.entries(this.options.extra)) {
        if (value !== undefined) params[key] = String(value);
      }
    }

    // 按 key 升序排列，拼接 baseString
    const sortedKeys = Object.keys(params).sort();
    const baseString = sortedKeys
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
      .join("&");

    // HMAC-SHA1 签名
    const signature = createHmac("sha1", this.accessKeySecret).update(baseString).digest("base64");

    return `${this.url}?${baseString}&signature=${encodeURIComponent(signature)}`;
  }

  private mapLang(): string {
    const lang = this.options.language;
    if (!lang || lang === "auto" || lang === "zh-CN" || lang.startsWith("zh")) {
      return "autodialect";
    }
    return "autodialect";
  }

  private onMessage(data: WebSocket.RawData): void {
    let message: any;
    try {
      message = JSON.parse(data.toString());
    } catch (err) {
      this.emit("error", new ASRProtocolError("无法解析讯飞 RTASR 响应 JSON", undefined, err));
      return;
    }

    const msgType = message?.msg_type;

    // 大模型版 started：msg_type="action", data.action="started"
    if (msgType === "action" && message?.data?.action === "started") {
      this.started = true;
      this.flushAudio();
      return;
    }

    // 标准版 started：action="started"
    const action = message?.action ?? "";
    if (action === "started") {
      const code = String(message?.code ?? "0");
      if (code !== "0") {
        this.emitVendorError(message);
        return;
      }
      this.started = true;
      this.flushAudio();
      return;
    }

    // 错误处理
    if (action === "error") {
      this.emitVendorError(message);
      return;
    }

    // 大模型版结果：msg_type="result", res_type="asr"
    const resType = message?.res_type;
    if (msgType === "result" && resType === "asr") {
      this.handleResult(message?.data, message);
      return;
    }

    // 标准版结果：action="result"
    if (action === "result") {
      let resultData: any;
      try {
        resultData =
          typeof message?.data === "string" ? JSON.parse(message.data) : (message?.data ?? {});
      } catch {
        return;
      }
      this.handleResult(resultData, message);
      return;
    }

    // 大模型版功能异常
    if (msgType === "result" && resType === "frc") {
      this.emitVendorError(message?.data);
      return;
    }
  }

  private handleResult(resultData: any, raw: unknown): void {
    if (!resultData || typeof resultData !== "object") return;

    const st = resultData?.cn?.st;
    if (!st) return;

    const text = extractText(st);
    if (!text) return;

    const type = String(st?.type ?? "1");
    const isFinal = type === "0";
    const startTime = numberOrUndefined(st?.bg);
    const endTime = numberOrUndefined(st?.ed);
    const speaker = extractSpeaker(st);

    // 讯飞大模型版的 seg_id 是全局消息递增序号，不是句级标识。
    // 句级 id 由适配器自行维护：首条 partial 开新句，final 后切换到下一句。
    if (!this.currentSegmentId) {
      this.segmentSeq += 1;
      this.currentSegmentId = `s${this.segmentSeq}`;
      this.currentSegmentIndex = this.segmentSeq;
    }

    this.emitTranscript({
      text,
      isFinal,
      id: this.currentSegmentId,
      index: this.currentSegmentIndex,
      ...(startTime !== undefined ? { startTime } : {}),
      ...(endTime !== undefined && endTime > 0 ? { endTime } : {}),
      ...(speaker !== undefined ? { speaker } : {}),
      raw,
    });

    if (isFinal) {
      this.currentSegmentId = null;
      this.currentSegmentIndex = 0;
    }
  }

  private flushAudio(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    for (const chunk of this.audioBuffer) this.ws.send(chunk);
    this.audioBuffer = [];
  }

  /** 把厂商错误载荷格式化为统一协议错误后上报（区别于基类的 emitError）。 */
  private emitVendorError(message: any): void {
    const parts: string[] = [];
    if (message?.code) parts.push(String(message.code));
    if (message?.desc) parts.push(message.desc);
    if (message?.detail) parts.push(JSON.stringify(message.detail));
    const detail = parts.join(": ");
    this.emit("error", new ASRProtocolError(`讯飞 RTASR 错误${detail ? `: ${detail}` : ""}`));
  }
}

function extractText(st: any): string {
  const groups = Array.isArray(st?.rt) ? st.rt : [];
  const words = groups.flatMap((group: any) => (Array.isArray(group?.ws) ? group.ws : []));
  return words
    .flatMap((wordGroup: any) => (Array.isArray(wordGroup?.cw) ? wordGroup.cw : []))
    .map((word: any) => String(word?.w ?? ""))
    .join("");
}

function extractSpeaker(st: any): string | undefined {
  const groups = Array.isArray(st?.rt) ? st.rt : [];
  for (const group of groups) {
    const wsList = Array.isArray(group?.ws) ? group.ws : [];
    for (const ws of wsList) {
      const cwList = Array.isArray(ws?.cw) ? ws.cw : [];
      for (const cw of cwList) {
        const rl = cw?.rl;
        if (typeof rl === "number" && rl > 0) return String(rl);
        if (typeof rl === "string" && rl !== "0" && rl.length > 0) return rl;
      }
    }
  }
  return undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** 导出鉴权 URL 构造函数，便于测试。 */
export { buildIFlytekAuthUrl };
function buildIFlytekAuthUrl(
  baseUrl: string,
  appId: string,
  accessKeyId: string,
  accessKeySecret: string,
  utc: string,
  uuid: string,
  extra: Record<string, string> = {},
): string {
  const params: Record<string, string> = {
    accessKeyId,
    appId,
    uuid,
    utc,
    audio_encode: "pcm_s16le",
    samplerate: "16000",
    lang: "autodialect",
    ...extra,
  };
  const sortedKeys = Object.keys(params).sort();
  const baseString = sortedKeys
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join("&");
  const signature = createHmac("sha1", accessKeySecret).update(baseString).digest("base64");
  return `${baseUrl}?${baseString}&signature=${encodeURIComponent(signature)}`;
}
