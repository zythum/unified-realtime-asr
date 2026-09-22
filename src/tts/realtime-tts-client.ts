import { ReconnectController } from "../core/reconnect.js";
import { BaseTTSClient } from "./tts-client.js";
import type { RealtimeTTSOptions } from "./types.js";

/**
 * **长连接（WebSocket）** 方向的语音合成客户端。
 *
 * 与 {@link BaseTTSClient} 的差别只有传输语义：异常断开后按指数退避重连
 * （`options.autoReconnect`）。合成方向本身（`sendText` / `flush` / 能力降级）
 * 全在父类，适配器只需要实现协议钩子。
 *
 * 纯 HTTP 的合成接口请改用 `BaseHttpTTSClient` —— 那里 `autoReconnect` 是空话。
 */
export abstract class BaseRealtimeTTSClient extends BaseTTSClient {
  private readonly reconnector: ReconnectController;

  constructor(options: RealtimeTTSOptions = {}) {
    super(options);
    this.reconnector = new ReconnectController(
      options,
      () => this.connect(),
      (err) => this.emitError(err),
    );
  }

  /** 适配器在连接/会话结束时调用（异常断开，或调用方主动 `close()`）：发 `close` 事件，仅在 code 非 1000 时重连。 */
  protected handleDisconnect(code?: number, reason?: string): void {
    this.connected = false;
    this.emitClose({ code, reason });
    if (this.options.autoReconnect && this.reconnector.shouldRetry(code)) {
      this.reconnector.schedule();
    }
  }

  protected override onConnected(): void {
    this.reconnector.reset();
  }
}
