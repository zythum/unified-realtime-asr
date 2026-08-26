import { DashScopeASRClient } from "./adapters/dashscope.js";
import { IFlytekASRClient } from "./adapters/iflytek.js";
import { OpenAIASRClient } from "./adapters/openai.js";
import { VolcengineASRClient } from "./adapters/volcengine.js";
import { BaseRealtimeASRClient } from "./core/base-client.js";
import type { ASRConfig } from "./types.js";

/** Unified client interface (alias of the abstract base). */
export type RealtimeASRClient = BaseRealtimeASRClient;

/**
 * Create a provider-agnostic realtime ASR client from a config object.
 * This is the single entry point that "hides" every vendor difference.
 */
export function createASRClient(config: ASRConfig): RealtimeASRClient {
  switch (config.provider) {
    case "openai":
      return new OpenAIASRClient(config);
    case "dashscope":
      return new DashScopeASRClient(config);
    case "volcengine":
      return new VolcengineASRClient(config);
    case "iflytek":
      return new IFlytekASRClient(config);
    default: {
      const _exhaustive: never = config;
      throw new Error(`Unknown provider: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export * from "./types.js";
export { BaseRealtimeASRClient } from "./core/base-client.js";
export { TypedEmitter } from "./core/typed-emitter.js";
export { ASRError, ASRConnectionError, ASRAuthError, ASRProtocolError } from "./core/errors.js";
export { OpenAIASRClient } from "./adapters/openai.js";
export { DashScopeASRClient } from "./adapters/dashscope.js";
export { VolcengineASRClient } from "./adapters/volcengine.js";
export { IFlytekASRClient } from "./adapters/iflytek.js";
export type { RealtimeMessage } from "./adapters/openai.js";
export { createASRClient as default } from "./index.js";
