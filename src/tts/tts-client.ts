import { BaseSpeechClient } from "../core/speech-client.js";
import { TTSError } from "../core/errors.js";
import type { RealtimeTTSOptions, TTSCapabilities, TTSChunk, TTSEvents } from "./types.js";

/** TTS 方向的默认选项（传输层默认值见 BaseSpeechClient 的子类）。 */
const TTS_DEFAULTS: RealtimeTTSOptions = {
  format: "pcm",
};

/**
 * 语音合成方向的公共客户端：文本进 → `audio` 出。**传输无关**。
 *
 * 对外只有三个动作，与 ASR 侧镜像：
 * - `sendText(text)`  ≈ `sendAudio(chunk)`：追加数据，粒度随意；
 * - `flush()`         ：提交本轮文本并强制合成，等待服务端确认；
 * - `close()`         ：结束本轮 / 关闭传输。
 *
 * 因此**逐句与整段是同一套 API 的两种用法**：
 * ```ts
 * // 整段
 * client.sendText(全文); await client.flush();
 *
 * // 逐句（或 LLM 流式逐 delta）
 * for (const delta of llmStream) {
 *   client.sendText(delta);                       // 攒进服务端
 *   if (句末) await client.flush();                // 立刻出声
 * }
 * await client.flush();                            // 收尾
 * ```
 *
 * 传输差异由子类决定，调用方无感：
 * - `BaseRealtimeTTSClient`：WebSocket 长连接（可增量下发、可复用连接/自动重连）；
 * - `BaseHttpTTSClient`：一次性 HTTP 请求（无连接概念，`flush` 即一次请求）。
 *
 * 两者都通过 `capabilities` 如实自述（`incrementalText` / `sessionReuse` / `transport`）。
 */
export abstract class BaseTTSClient extends BaseSpeechClient<TTSEvents, RealtimeTTSOptions> {
  /** 非增量后端的文本缓冲（`capabilities.incrementalText === false` 时启用）。 */
  private textBuffer = "";

  constructor(options: RealtimeTTSOptions = {}) {
    super({ ...TTS_DEFAULTS, ...options });
  }

  /** 本后端能力位。适配器必须自己按它降级，调用方可用它做分支。 */
  abstract get capabilities(): TTSCapabilities;

  /**
   * 追加待合成文本。粒度随意（整段 / 逐句 / 逐 delta 均可），顺序即合成顺序。
   * 非增量后端只把文本攒进本地缓冲，等 `flush()` 时一次性提交。
   */
  sendText(text: string): void {
    if (!text) return;
    if (!this.connected) {
      throw new TTSError("Not connected. Call connect() before sendText().", "not-connected");
    }
    if (this.capabilities.incrementalText) {
      this.sendTextImpl(text);
      return;
    }
    this.textBuffer += text;
  }

  /**
   * 提交已追加的文本并强制合成，返回的 Promise 在服务端确认本轮合成结束时 resolve
   * （即该轮的音频已全部经 `audio` 事件发出）。
   *
   * 非增量后端（如仅支持整段合成的接口）在这里退化为一次整段请求。
   */
  async flush(): Promise<void> {
    if (!this.connected) {
      throw new TTSError("Not connected. Call connect() before flush().", "not-connected");
    }
    if (this.capabilities.incrementalText) {
      return this.flushImpl();
    }
    const text = this.textBuffer;
    this.textBuffer = "";
    return this.synthesizeOnceImpl(text);
  }

  /** Adapters call this to emit one piece of synthesized audio. */
  protected emitAudio(chunk: TTSChunk): void {
    this.emit("audio", chunk);
  }

  /**
   * 关闭前把还没提交的缓冲补合成一次，避免调用方忘了 `flush()` 丢字。
   * 补合成失败不阻断关闭，只上报 `error` 事件。
   */
  override async close(): Promise<void> {
    if (this.textBuffer) {
      const text = this.textBuffer;
      this.textBuffer = "";
      try {
        await this.synthesizeOnceImpl(text);
      } catch (err) {
        this.emitError(
          err instanceof TTSError ? err : new TTSError("Flush on close failed", "close-flush", err),
        );
      }
    }
    await super.close();
  }

  /* ---- protocol hooks implemented by adapters ---- */

  /** 增量追加文本（仅当 `capabilities.incrementalText` 为真时调用）。 */
  protected abstract sendTextImpl(text: string): void;

  /** 提交本轮文本并强制合成；resolve = 服务端确认本轮结束。 */
  protected abstract flushImpl(): Promise<void>;

  /** 非增量后端的整段合成。默认实现 = 追加一次 + 提交一轮。 */
  protected async synthesizeOnceImpl(text: string): Promise<void> {
    if (!text) return;
    this.sendTextImpl(text);
    await this.flushImpl();
  }
}
