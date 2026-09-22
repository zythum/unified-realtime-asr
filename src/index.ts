import { DashScopeASRClient } from "./asr/adapters/dashscope.js";
import { IFlytekASRClient } from "./asr/adapters/iflytek.js";
import { OpenAIASRClient } from "./asr/adapters/openai.js";
import { VolcengineASRClient } from "./asr/adapters/volcengine.js";
import { DashScopeTTSClient } from "./tts/adapters/dashscope.js";
import { IFlytekTTSClient } from "./tts/adapters/iflytek.js";
import { OpenAITTSClient } from "./tts/adapters/openai.js";
import { VolcengineTTSClient } from "./tts/adapters/volcengine.js";
import { BaseRealtimeASRClient } from "./asr/realtime-asr-client.js";
import { BaseTTSClient } from "./tts/tts-client.js";
import type { ASRConfig } from "./asr/types.js";
import type { TTSConfig } from "./tts/types.js";

/** Unified ASR client interface (alias of the abstract base). */
export type RealtimeASRClient = BaseRealtimeASRClient;

/**
 * 统一的 TTS 客户端类型：**方向基类**，同时覆盖长连接与 HTTP 两种传输
 * （具体是哪种看 `client.capabilities.transport`）。
 */
export type TTSClient = BaseTTSClient;

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

/**
 * Create a provider-agnostic TTS client from a config object.
 * 与 {@link createASRClient} 对称：同样的凭证字段名，换 provider 不改业务代码。
 */
export function createTTSClient(config: TTSConfig): TTSClient {
  switch (config.provider) {
    case "dashscope":
      return new DashScopeTTSClient(config);
    case "volcengine":
      return new VolcengineTTSClient(config);
    case "iflytek":
      return new IFlytekTTSClient(config);
    case "openai":
      return new OpenAITTSClient(config);
    default: {
      const _exhaustive: never = config;
      throw new Error(`Unknown provider: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/* ------------------------------- shared core ------------------------------ */

// 三个 types 模块互相不重名，这里原样汇聚到包根：对使用者而言导出面与拆分前一致。
export * from "./core/types.js";
export * from "./asr/types.js";
export * from "./tts/types.js";

export { BaseSpeechClient } from "./core/speech-client.js";
export { BaseRealtimeSession } from "./core/session.js";
export { TypedEmitter } from "./core/typed-emitter.js";
export {
  SpeechError,
  ASRError,
  ASRConnectionError,
  ASRAuthError,
  ASRProtocolError,
  TTSError,
  TTSConnectionError,
  TTSAuthError,
  TTSProtocolError,
} from "./core/errors.js";

/* ----------------------------------- ASR ---------------------------------- */

export { BaseRealtimeASRClient } from "./asr/realtime-asr-client.js";
export { OpenAIASRClient } from "./asr/adapters/openai.js";
export { DashScopeASRClient } from "./asr/adapters/dashscope.js";
export { VolcengineASRClient } from "./asr/adapters/volcengine.js";
export { IFlytekASRClient } from "./asr/adapters/iflytek.js";
export type { RealtimeMessage } from "./asr/adapters/openai.js";

/* ----------------------------------- TTS ---------------------------------- */

// 方向基类（传输无关）与两种传输实现
export { BaseTTSClient } from "./tts/tts-client.js";
export { BaseRealtimeTTSClient } from "./tts/realtime-tts-client.js";
export { BaseHttpTTSClient } from "./tts/http-tts-client.js";
export { DashScopeTTSClient } from "./tts/adapters/dashscope.js";
export { VolcengineTTSClient } from "./tts/adapters/volcengine.js";
export { IFlytekTTSClient } from "./tts/adapters/iflytek.js";
export { OpenAITTSClient } from "./tts/adapters/openai.js";

export { createASRClient as default } from "./index.js";
