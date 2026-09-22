import { TypedEmitter } from "./typed-emitter.js";
import { SpeechError } from "./errors.js";
import type { CloseInfo, RealtimeSessionOptions } from "./types.js";

/** 内部别名：只放宽泛型约束，不泄漏到公共 API。 */
type AnyFn = (...args: any[]) => void;

/**
 * 传输无关的客户端底座：生命周期骨架 + 事件扇出。
 *
 * 这里刻意**不含**「长连接」假设 —— 既不重连、也不假定 `connected` 背后有一条 socket。
 * 于是两种传输都能站在它上面：
 * - 长连接（WebSocket）：{@link BaseRealtimeSession} 在此之上补重连；
 * - 一次性请求（HTTP）：`BaseHttpTTSClient` 在此之上补「中止在途请求」。
 *
 * 事件语义对两者一致：`open` = 可以开始收发数据；`error` = 统一错误；`close` = 连接/会话
 * 结束（异常断开与调用方主动 `close()` 都会触发，主动关闭时 `code` 通常为 1000；
 * code 1000 不触发重连）。
 */
export abstract class BaseSpeechClient<
  Events extends Record<keyof Events, AnyFn>,
  Options extends RealtimeSessionOptions = RealtimeSessionOptions,
> extends TypedEmitter<Events> {
  protected options: Options;
  protected connected = false;

  constructor(options: Options) {
    super();
    this.options = options;
  }

  /** Stable provider identifier. */
  abstract get provider(): string;

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.connectImpl();
    this.connected = true;
    this.onConnected();
  }

  async close(): Promise<void> {
    await this.closeImpl();
    this.connected = false;
  }

  /** 子类在握手/就绪后调用。 */
  protected emitOpen(): void {
    this.emitLifecycle("open");
  }

  /** 子类上报统一错误。 */
  protected emitError(err: SpeechError): void {
    this.emitLifecycle("error", err);
  }

  /** 子类在连接/会话结束时调用（异常断开或调用方主动 `close()`，后者 code 通常为 1000）。 */
  protected emitClose(info?: CloseInfo): void {
    this.emitLifecycle("close", info);
  }

  /** 连接成功后的钩子（如重置重连计数）。 */
  protected onConnected(): void {}

  /**
   * open / close / error 三个生命周期事件在所有方向上同名同形，但错误的具体类型
   * 不同（`ASRError` / `TTSError`）。这里集中做一次转发，避免每个适配器各写一次
   * 类型断言。
   */
  private emitLifecycle(event: "open" | "close" | "error", payload?: unknown): void {
    (this.emit as unknown as (event: string, payload?: unknown) => void)(event, payload);
  }

  /* ---- protocol hooks implemented by adapters ---- */
  protected abstract connectImpl(): Promise<void>;
  protected abstract closeImpl(): Promise<void>;
}
