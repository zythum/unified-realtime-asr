import { SpeechError } from "./errors.js";
import type { RealtimeSessionOptions } from "./types.js";

/**
 * 异常断开后的指数退避重连策略。
 *
 * 抽成**组合件**而不是基类，是因为它要同时服务两个方向（ASR / TTS）的长连接实现，
 * 而这两个方向各自还有别的继承需求 —— 放进继承链会造成"重连逻辑只能有一个父类"
 * 的死结。HTTP 传输不接这个件（它没有可断开的连接）。
 */
export class ReconnectController {
  private attempts = 0;

  constructor(
    private readonly options: RealtimeSessionOptions,
    /** 重连动作：通常是 `() => client.connect()`。 */
    private readonly reconnect: () => Promise<void>,
    private readonly onError: (err: SpeechError) => void,
  ) {}

  /** 连接成功后归零，避免把历史失败累积到下次断开。 */
  reset(): void {
    this.attempts = 0;
  }

  /** 是否还该重试。`1000` = 正常关闭，不重试。 */
  shouldRetry(code?: number): boolean {
    if (code === 1000) return false;
    return this.attempts < (this.options.maxReconnectAttempts ?? 5);
  }

  /** 安排一次退避重连（指数退避，上限 30s）。 */
  schedule(): void {
    const delay = Math.min(1000 * 2 ** this.attempts, 30_000);
    this.attempts++;
    setTimeout(() => {
      this.reconnect().catch((err) =>
        this.onError(new SpeechError("Reconnect failed", "reconnect", err)),
      );
    }, delay);
  }
}
