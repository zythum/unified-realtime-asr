/**
 * 实时合成（TTS）方向的公共类型：统一输出形状 + 各 provider 配置。
 *
 * 与 `asr/types.ts` 镜像。两侧共用的只有 `core/types.ts` 里的连接层选项；
 * 用户代码永远只接触这里的形状，厂商协议细节藏在 `tts/adapters/` 后面。
 */

import type { TTSError } from "../core/errors.js";
import type { CloseInfo, RealtimeSessionOptions } from "../core/types.js";

/**
 * 合成音频的输出编码。
 * 刻意与 ASR 的输入 `ASRAudioFormat` 分开：那个联合类型表示「能喂什么进去」，
 * 把 mp3 / aac 混进去会误导调用方。
 */
export type TTSAudioFormat = "pcm" | "wav" | "mp3" | "opus" | "aac" | "flac";

/** 字/词级时间戳，provider 支持且开启时才有。 */
export interface TTSWord {
  text: string;
  /** 在句子中的起止字序（从 0 开始 / 从 1 开始），provider 给出时才有。 */
  beginIndex?: number;
  endIndex?: number;
  /** 对应音频的起止时间戳（毫秒）。 */
  beginTime?: number;
  endTime?: number;
}

/**
 * 一片合成音频。语义与 ASR 的 `Transcript` 对齐，调用方只需一个事件：
 * - `isFinal: true` 表示该句音频已完整（不会再有同 `id` 的片）；
 * - `id` / `index` 为句级标识与 1-based 句序号，同一句的多片共用，便于按句组织播放队列。
 *
 * 本库不对音频做任何转码或重采样：`format` / `sampleRate` 是原样透出的元信息。
 * 注意 wav / mp3 这类带容器的格式只在任务首片携带文件头，必须按「一个完整文件的
 * 分片」追加播放，不能逐片独立解码；需要逐片可播时用 `pcm`。
 */
export interface TTSChunk {
  audio: Uint8Array;
  format: TTSAudioFormat;
  sampleRate?: number;
  channels?: number;
  isFinal: boolean;
  id?: string;
  index?: number;
  /** 本片对应的文本，provider 给出时才有。 */
  text?: string;
  words?: TTSWord[];
  /** The original vendor payload, for debugging / advanced use. */
  raw?: unknown;
}

export interface TTSEvents {
  /** Underlying WebSocket connection established. */
  open: () => void;
  /** 每一次合成音频分片（用 `c.isFinal` 判断句尾）。 */
  audio: (chunk: TTSChunk) => void;
  error: (err: TTSError) => void;
  /** Connection closed. */
  close: (info?: CloseInfo) => void;
}

/**
 * provider 能力位。调用方可用它做分支（例如决定是否逐 delta 灌文本），
 * 但适配器内部必须自己完成降级，不能让「某家不支持」泄漏成调用方的 if/else。
 */
export interface TTSCapabilities {
  /**
   * 传输形态：`websocket` 长连接（可复用连接 / 可自动重连）或 `http` 一次性请求
   * （无连接概念，`options.autoReconnect` 对其无效）。调用方据此判断"连接"是否真实存在。
   */
  transport: "websocket" | "http";
  /** false = 不支持增量文本：`sendText()` 只入本地缓冲，`flush()` 时一次性提交。 */
  incrementalText: boolean;
  /** 一个连接能否承载多轮合成（`flush()` 之后继续 `sendText()` 不会重建连接）。 */
  sessionReuse: boolean;
  /** 支持的输出编码。 */
  formats: readonly TTSAudioFormat[];
  /** 支持的输出采样率（Hz）。 */
  sampleRates: readonly number[];
  /** 自然语言指令控制（语气 / 情感 / 口音）。 */
  instructions: boolean;
  /** 声音复刻。 */
  voiceCloning: boolean;
  /** 字级时间戳。 */
  wordTimestamps: boolean;
}

export interface RealtimeTTSOptions extends RealtimeSessionOptions {
  /** 音色 / 发音人。各家音色名不通用，本库不猜默认值。 */
  voice?: string;
  /** 输出编码。默认 `'pcm'`（流式播放最省事）。 */
  format?: TTSAudioFormat;
  /** 输出采样率。未指定时用适配器默认值。 */
  sampleRate?: number;
  /** BCP-47 语言提示，如 `'zh-CN'`。 */
  language?: string;
  /** 语速倍率，1.0 = 原速。 */
  speed?: number;
  /** 音量，0-100。 */
  volume?: number;
  /** 音调倍率，1.0 = 原调。 */
  pitch?: number;
  /** 自然语言指令，控制语气 / 情感 / 口音（provider 支持时生效）。 */
  instructions?: string;
}

/* -------------------------------------------------------------------------- */
/* Provider configs (discriminated union on `provider`)                       */
/* -------------------------------------------------------------------------- */

/**
 * 阿里云百炼 / DashScope 实时语音合成（CosyVoice / Qwen-Audio-TTS）。
 *
 * 凭证与实时识别共用同一把 DashScope API Key，差异只在 `model` 与 `options.voice`。
 */
export interface DashScopeTTSConfig {
  provider: "dashscope";
  /** DashScope API Key（sk-...），与实时识别、千问大模型同一把。 */
  apiKey: string;
  /** 模型名。默认 `qwen-audio-3.0-tts-flash`。 */
  model?: string;
  /** 业务空间专属域名的工作空间 ID；不填则用旧域名 dashscope.aliyuncs.com。 */
  workspaceId?: string;
  /** 地域，配合 workspaceId 使用。默认 cn-beijing。 */
  region?: "cn-beijing" | "ap-southeast-1";
  /** 业务空间 ID（X-DashScope-WorkSpace 请求头）。 */
  workspace?: string;
  url?: string;
  options?: RealtimeTTSOptions;
}

/**
 * 火山引擎豆包语音合成（`seed-tts-2.0` / 声音复刻系列）。
 *
 * 凭证与实时识别共用同一把新版控制台 API Key（`X-Api-Key`），差异在
 * `X-Api-Resource-Id`：识别用 `volc.seedasr.sauc.duration`，合成用 `seed-tts-2.0`。
 */
export interface VolcengineTTSConfig {
  provider: "volcengine";
  /** 新版控制台 API Key（X-Api-Key），与实时识别同一把。 */
  apiKey: string;
  /** X-Api-Resource-Id，决定模型版本与计费。默认 `seed-tts-2.0`（语音合成 2.0 字符版）。 */
  resourceId?: string;
  /** 旧版控制台：APP ID（与 `accessKey` 配对使用；新版控制台只需 `apiKey`）。 */
  appId?: string;
  /** 旧版控制台：Access Token。 */
  accessKey?: string;
  /**
   * 协议模式，两种模式**用户代码完全相同**（`sendText` + `flush`）：
   * - `duplex`（默认）双向流式：文本可增量输入，适合对接 LLM 的流式输出；
   * - `oneshot` 单向流式：一次性输入整段文本，少几个控制帧往返，适合固定文案。
   *
   * 差异体现在实现与 {@link TTSCapabilities} 上，不影响调用方式。
   */
  mode?: "duplex" | "oneshot";
  url?: string;
  options?: RealtimeTTSOptions;
}

/**
 * 科大讯飞超拟人语音合成（双向流式大模型 TTS）。
 *
 * 凭证字段与讯飞实时识别（`IFlytekASRConfig`）**完全同名**：`appId` / `apiKey` / `apiSecret`，
 * 便于复用同一套环境变量；但签名算法不同 —— 识别是 HMAC-SHA1（参数串），合成是
 * HMAC-SHA256（`host` / `date` / `request-line`），由适配器各自实现。
 *
 * 注意：接口的**发音人授权与字符量授权是两笔独立授权**，控制台里开通了服务不等于
 * 某个 `voice` 可用（未授权的发音人调用时会返回 `11200 LiccCheck failed`）。
 */
export interface IFlytekTTSConfig {
  provider: "iflytek";
  /** 讯飞开放平台应用 ID（appId）。 */
  appId: string;
  /** 接口密钥（APIKey）。 */
  apiKey: string;
  /** 接口密钥（APISecret），用于 HMAC-SHA256 签名。 */
  apiSecret: string;
  url?: string;
  options?: RealtimeTTSOptions;
}

/**
 * OpenAI 语音合成（`POST /v1/audio/speech`，gpt-4o-mini-tts / tts-1 / tts-1-hd）。
 *
 * 与另外三家形态不同：**没有 WebSocket、没有会话** —— 每个 `flush()` 就是一次 HTTP 请求，
 * 响应体按 chunked 流式返回音频。因此：
 * - `sendText()` 只入本地缓冲，`flush()` 一次性提交（`capabilities.incrementalText = false`）；
 * - `options.autoReconnect` 对它无效（没有可断开的连接），`capabilities.transport = "http"`；
 * - `connect()` 不发探针请求，凭证错误由 `flush()` 暴露。
 */
export interface OpenAITTSConfig {
  provider: "openai";
  apiKey: string;
  /** 模型。默认 `gpt-4o-mini-tts`（另有 `tts-1` / `tts-1-hd`）。 */
  model?: string;
  /** API base，默认 `https://api.openai.com`（走代理/Azure 时覆盖）。 */
  baseUrl?: string;
  /** 直接覆盖完整端点，优先级高于 `baseUrl`。 */
  url?: string;
  options?: RealtimeTTSOptions;
}

/** TTS provider 判别联合：新增合成后端时在此追加一个成员。 */
export type TTSConfig =
  | DashScopeTTSConfig
  | VolcengineTTSConfig
  | IFlytekTTSConfig
  | OpenAITTSConfig;
