import { BaseSpeechClient } from "./speech-client.js";
import { ReconnectController } from "./reconnect.js";
import type { RealtimeSessionOptions } from "./types.js";

/** 内部别名：只放宽泛型约束，不泄漏到公共 API。 */
type AnyFn = (...args: any[]) => void;

/**
 * 面向**长连接**（WebSocket）的会话底座。
 *
 * 在 {@link BaseSpeechClient} 之上只加一件事：异常断开后的指数退避重连。
 * 纯 HTTP provider 不该用这一层 —— 它没有可断开的连接，`autoReconnect`
 * 对它是空话（那种 provider 用各自方向的 HTTP 基类）。
 *
 * 方向由子类补齐（两侧共享同一套 open / error / close 语义）：
 * - {@link BaseRealtimeASRClient}：音频进 → `transcript` 出
 * - `BaseRealtimeTTSClient`：文本进 → `audio` 出
 */
export abstract class BaseRealtimeSession<
  Events extends Record<keyof Events, AnyFn>,
  Options extends RealtimeSessionOptions = RealtimeSessionOptions,
> extends BaseSpeechClient<Events, Options> {
  private readonly reconnector: ReconnectController;

  constructor(options: Options) {
    super(options);
    this.reconnector = new ReconnectController(
      options,
      () => this.connect(),
      (err) => this.emitError(err),
    );
  }

  /** 子类在连接/会话结束时调用（异常断开，或调用方主动 `close()`）：发出 `close`，仅在 code 非 1000 且开启 autoReconnect 时驱动重连。 */
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
