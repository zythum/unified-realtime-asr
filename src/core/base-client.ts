import { TypedEmitter } from "./typed-emitter.js";
import { ASRError } from "./errors.js";
import type { ASREvents, RealtimeASROptions, Transcript } from "../types.js";
import { toInt16LE, type AudioInput } from "../utils/audio.js";

/**
 * Common lifecycle, event fan-out, audio normalization and reconnect logic.
 * Concrete adapters only implement the four protocol hooks.
 */
export abstract class BaseRealtimeASRClient extends TypedEmitter<ASREvents> {
  protected options: RealtimeASROptions;
  protected connected = false;
  private reconnectAttempts = 0;

  constructor(options: RealtimeASROptions = {}) {
    super();
    this.options = {
      language: "zh-CN",
      sampleRate: 16000,
      channels: 1,
      format: "pcm",
      interimResults: true,
      punctuation: true,
      enableConfusion: true,
      ...options,
    };
  }

  /** Stable provider identifier. */
  abstract get provider(): string;

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.connectImpl();
    this.connected = true;
    this.reconnectAttempts = 0;
  }

  /** Feed raw audio. Accepts Buffer / Int16Array / Float32Array / number[]. */
  sendAudio(chunk: AudioInput): void {
    if (!this.connected) {
      throw new ASRError("Not connected. Call connect() before sendAudio().", "not-connected");
    }
    const pcm = toInt16LE(chunk);
    this.sendAudioImpl(pcm);
  }

  async close(): Promise<void> {
    await this.closeImpl();
    this.connected = false;
  }

  /** Adapters call this to emit a unified transcript. `t.isFinal` marks final. */
  protected emitTranscript(t: Transcript): void {
    this.emit("transcript", t);
  }

  /** Adapters call this on an abnormal close to drive reconnect. */
  protected handleDisconnect(code?: number, reason?: string): void {
    this.connected = false;
    this.emit("close", { code, reason });
    if (this.options.autoReconnect && this.shouldReconnect(code)) {
      this.scheduleReconnect();
    }
  }

  private shouldReconnect(code?: number): boolean {
    // 1000 = normal/clean closure, do not retry.
    if (code === 1000) return false;
    return this.reconnectAttempts < (this.options.maxReconnectAttempts ?? 5);
  }

  private scheduleReconnect(): void {
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000);
    this.reconnectAttempts++;
    setTimeout(() => {
      this.connect().catch((err) =>
        this.emit("error", new ASRError("Reconnect failed", "reconnect", err)),
      );
    }, delay);
  }

  /* ---- protocol hooks implemented by adapters ---- */
  protected abstract connectImpl(): Promise<void>;
  protected abstract sendAudioImpl(pcm: Uint8Array): void;
  protected abstract closeImpl(): Promise<void>;
}
