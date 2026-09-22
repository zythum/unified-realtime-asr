/**
 * 两个方向共用的类型。
 *
 * 这里是 `core/` 的边界所在：本文件（以及整个 `core/`）不得出现方向特有的类型
 * （`Transcript` / `TTSChunk` / 各 provider 配置），也不得 import `asr/` 或 `tts/`。
 * 方向特有的类型在 `asr/types.ts` 与 `tts/types.ts`。
 */

export interface CloseInfo {
  code?: number;
  reason?: string;
}

/**
 * 连接层通用选项：实时识别与实时合成共用。
 * 方向特有的选项分别见 `asr/types.ts` 的 `RealtimeASROptions`
 * 与 `tts/types.ts` 的 `RealtimeTTSOptions`。
 */
export interface RealtimeSessionOptions {
  /** Auto-reconnect on abnormal close. Default false. */
  autoReconnect?: boolean;
  /** Max reconnect attempts when autoReconnect is on. Default 5. */
  maxReconnectAttempts?: number;
  /** Vendor-specific passthrough. */
  extra?: Record<string, unknown>;
}
