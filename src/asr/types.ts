/**
 * 实时识别（ASR）方向的公共类型：统一结果形状 + 各 provider 配置。
 *
 * 与 `tts/types.ts` 镜像。两侧共用的只有 `core/types.ts` 里的连接层选项；
 * 用户代码永远只接触这里的形状，厂商协议细节藏在 `asr/adapters/` 后面。
 */

import type { ASRError } from "../core/errors.js";
import type { CloseInfo, RealtimeSessionOptions } from "../core/types.js";

export type ASRAudioFormat = "pcm" | "opus" | "g711a" | "g711u" | "wav";

/** A single recognition result. `isFinal=false` => interim (partial). */
export interface Transcript {
  /** Recognized text. */
  text: string;
  /** false = interim/partial, true = sentence-final or stream-final. */
  isFinal: boolean;
  /** 1-based 句/段序号，由本库统一分配，便于按句编号或换行。 */
  index?: number;
  /** Provider 提供的稳定句级 id；同一句的 partial 与其后的 final 共用同一 id。 */
  id?: string;
  /** Start offset in milliseconds, when available. */
  startTime?: number;
  /** End offset in milliseconds, when available. */
  endTime?: number;
  /** BCP-47 language code, when available. */
  language?: string;
  /** Speaker label, when diarization is enabled. */
  speaker?: string;
  /** The original vendor payload, for debugging / advanced use. */
  raw?: unknown;
}

export interface RealtimeASROptions extends RealtimeSessionOptions {
  /** BCP-47 language, e.g. 'zh-CN', 'en-US', or 'auto'. Default 'zh-CN'. */
  language?: string;
  /** Sample rate in Hz the caller will feed. Default 16000. */
  sampleRate?: number;
  /** Channels. ASR is almost always mono(1). Default 1. */
  channels?: number;
  /** Audio encoding of the *input* the caller provides. Default 'pcm'. */
  format?: ASRAudioFormat;
  /** Request interim (partial) results. Default true. */
  interimResults?: boolean;
  /** Enable automatic punctuation. Default true. */
  punctuation?: boolean;
  /** Add inverse text normalization (numbers/dates -> digits). Default true. */
  enableConfusion?: boolean;
  /** Enable VAD-based sentence segmentation (where supported). */
  vad?: boolean;
  /**
   * Enable speaker/role diarization, so each {@link Transcript} carries a
   * `speaker` label. Only honored by providers that support it on their
   * realtime stream (e.g. Volcengine). Ignored elsewhere (e.g. DashScope
   * realtime, which has no diarization on the streaming API).
   */
  speakerDiarization?: boolean;
  /** Model id for the transcription (OpenAI-Realtime style providers). */
  transcriptionModel?: string;
}

/** Events emitted by every ASR client. */
export interface ASREvents {
  /** Underlying WebSocket connection established. */
  open: () => void;
  /**
   * 每一次识别结果（无论中间稿还是定稿）。同一份结果上的 `isFinal` 区分二者：
   *   - `isFinal: false` => 中间结果（partial），可能随后续音频被修正；
   *   - `isFinal: true`  => 最终结果（final），确定不再改。
   * 只暴露这一个事件，调用方用 `t.isFinal` 自行分流，避免冗余的 partial/final 别名。
   */
  transcript: (t: Transcript) => void;
  /** Recoverable error (stream continues unless it's fatal). */
  error: (err: ASRError) => void;
  /** Connection closed. */
  close: (info?: CloseInfo) => void;
}

/* -------------------------------------------------------------------------- */
/* Provider configs (discriminated union on `provider`)                       */
/* -------------------------------------------------------------------------- */

export interface VolcengineASRConfig {
  provider: "volcengine";
  /** 新版控制台 API Key，作为 X-Api-Key。 */
  apiKey: string;
  /** X-Api-Resource-Id，决定模型版本与计费。默认 `volc.seedasr.sauc.duration`（2.0 小时版）。 */
  resourceId?: string;
  /** 可选应用标识，仅在某些后端组合下需要。 */
  appId?: string;
  url?: string;
  options?: RealtimeASROptions;
}

export interface OpenAIASRConfig {
  provider: "openai";
  apiKey: string;
  url?: string;
  options?: RealtimeASROptions;
}

/** 阿里云百炼 / DashScope 实时语音识别（千问 Fun-ASR / Qwen-ASR）。 */
export interface DashScopeASRConfig {
  provider: "dashscope";
  /** DashScope API Key（sk-...），与调用千问大模型同一把。 */
  apiKey: string;
  /** 模型名。默认 fun-asr-flash-8k-realtime（百炼 Fun-ASR 实时语音识别 WebSocket 接口）。 */
  model?: string;
  /** 业务空间专属域名的工作空间 ID；不填则用旧域名 dashscope.aliyuncs.com。 */
  workspaceId?: string;
  /** 地域，配合 workspaceId 使用。默认 cn-beijing。 */
  region?: "cn-beijing" | "ap-southeast-1";
  /** 业务空间 ID（X-DashScope-WorkSpace 请求头）。 */
  workspace?: string;
  url?: string;
  options?: RealtimeASROptions;
}

/** 科大讯飞实时语音转写大模型版（RTASR LLM）。 */
export interface IFlytekASRConfig {
  provider: "iflytek";
  /** 讯飞开放平台应用 ID（appId）。 */
  appId: string;
  /** 接口密钥（accessKeyId / APIKey）。 */
  apiKey: string;
  /** 接口密钥（accessKeySecret / APISecret），用于签名。 */
  apiSecret: string;
  /** 覆盖默认 WebSocket 端点。 */
  url?: string;
  options?: RealtimeASROptions;
}

export type ASRConfig =
  | VolcengineASRConfig
  | OpenAIASRConfig
  | DashScopeASRConfig
  | IFlytekASRConfig;
