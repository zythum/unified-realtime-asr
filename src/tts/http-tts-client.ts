import { BaseTTSClient } from "./tts-client.js";

/**
 * **一次性请求（HTTP）** 方向的语音合成客户端。
 *
 * 与 `BaseRealtimeTTSClient` 的差别是传输语义，且少了一整层东西：
 * - **没有连接可建立**：`connect()` 只置就绪态，不发探针请求（避免多余计费调用）。
 *   凭证错误会由 `flush()` 的 reject 明确暴露。
 * - **没有连接可重连**：因此不接重连控制器 —— `options.autoReconnect` 对这类
 *   provider 是空话，能力位里 `transport: "http"` 会如实说明。
 * - `close()` 唯一有意义的动作是**中止在途请求**（顺带释放等待中的 `flush()`）。
 *
 * 适配器典型形态：`flushImpl()` 发一次请求，边读响应体边 `emitAudio`。
 */
export abstract class BaseHttpTTSClient extends BaseTTSClient {
  private inFlight?: AbortController;

  /** HTTP 无握手：就绪即返回。 */
  protected async connectImpl(): Promise<void> {
    /* 无网络动作 */
  }

  /** 关闭 = 中止在途请求。 */
  protected async closeImpl(): Promise<void> {
    this.abortInFlight();
  }

  /** 适配器发起请求后登记，便于 `close()` 中止。 */
  protected trackRequest(controller: AbortController): void {
    this.inFlight = controller;
  }

  /** 请求正常结束时注销（避免 `close()` 误伤后续请求）。 */
  protected clearRequest(controller: AbortController): void {
    if (this.inFlight === controller) this.inFlight = undefined;
  }

  /** 中止在途请求（若有）。 */
  protected abortInFlight(): void {
    this.inFlight?.abort();
    this.inFlight = undefined;
  }
}
