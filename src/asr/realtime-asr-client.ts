import { BaseRealtimeSession } from "../core/session.js";
import { ASRError } from "../core/errors.js";
import type { ASREvents, RealtimeASROptions, Transcript } from "./types.js";
import { toInt16LE, type AudioInput } from "../utils/audio.js";

/** ASR 方向的默认选项（连接层默认值见 BaseRealtimeSession）。 */
const ASR_DEFAULTS: RealtimeASROptions = {
  language: "zh-CN",
  sampleRate: 16000,
  channels: 1,
  format: "pcm",
  interimResults: true,
  punctuation: true,
  enableConfusion: true,
};

/**
 * 实时语音识别方向的公共客户端：音频进 → `transcript` 出。
 *
 * 连接生命周期、重连与错误扇出继承自 {@link BaseRealtimeSession}；
 * 这里额外负责统一音频归一化（任何输入 → 16-bit LE PCM）与 transcript 扇出。
 * 具体适配器只需实现 `connectImpl` / `sendAudioImpl` / `closeImpl`。
 */
export abstract class BaseRealtimeASRClient extends BaseRealtimeSession<
  ASREvents,
  RealtimeASROptions
> {
  constructor(options: RealtimeASROptions = {}) {
    super({ ...ASR_DEFAULTS, ...options });
  }

  /** Feed raw audio. Accepts Buffer / Int16Array / Float32Array / number[]. */
  sendAudio(chunk: AudioInput): void {
    if (!this.connected) {
      throw new ASRError("Not connected. Call connect() before sendAudio().", "not-connected");
    }
    const pcm = toInt16LE(chunk);
    this.sendAudioImpl(pcm);
  }

  /** Adapters call this to emit a unified transcript. `t.isFinal` marks final. */
  protected emitTranscript(t: Transcript): void {
    this.emit("transcript", t);
  }

  /* ---- protocol hooks implemented by adapters ---- */
  protected abstract sendAudioImpl(pcm: Uint8Array): void;
}
