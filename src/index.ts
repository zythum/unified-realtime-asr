import { DashScopeRealtimeASRClient } from "./adapters/dashscope.js";
import { OpenAIRealtimeASRClient } from "./adapters/openai.js";
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
    case "openai-realtime":
      return new OpenAIRealtimeASRClient({ apiKey: config.apiKey }, config.options);
    case "dashscope":
      return new DashScopeRealtimeASRClient(config);
    case "volcengine":
      return new VolcengineASRClient({
        apiKey: config.apiKey,
        resourceId: config.resourceId,
        appId: config.appId,
        url: config.url,
        options: config.options,
      });
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
export { OpenAIRealtimeASRClient } from "./adapters/openai.js";
export { DashScopeRealtimeASRClient } from "./adapters/dashscope.js";
export { VolcengineASRClient } from "./adapters/volcengine.js";
export type { RealtimeMessage } from "./adapters/openai.js";
export { createASRClient as default } from "./index.js";
