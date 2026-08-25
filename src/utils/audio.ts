/**
 * Audio normalization helpers.
 *
 * The unified client always converts whatever the caller supplies into the
 * canonical wire format: 16-bit little-endian PCM bytes. Individual adapters
 * may re-encode (e.g. base64 for the OpenAI-Realtime style transports), but
 * the contract between user code and the base client is always "raw PCM".
 *
 * NOTE: sample-rate conversion / resampling is intentionally out of scope.
 * Feed the adapter the sample rate the provider expects (see provider docs);
 * mismatched rates will produce garbage transcripts, not errors.
 */

export type AudioInput = Buffer | Int16Array | Float32Array | number[];

/** Convert any supported input into 16-bit little-endian PCM bytes. */
export function toInt16LE(chunk: AudioInput): Uint8Array {
  if (Buffer.isBuffer(chunk)) {
    // Assume already 16-bit LE PCM; pass through untouched.
    return new Uint8Array(chunk);
  }

  let int16: Int16Array;
  if (chunk instanceof Int16Array) {
    int16 = chunk;
  } else if (chunk instanceof Float32Array) {
    int16 = new Int16Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) int16[i] = floatToPcm(chunk[i]);
  } else {
    int16 = new Int16Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) int16[i] = floatToPcm(chunk[i]);
  }

  const out = new Uint8Array(int16.length * 2);
  for (let i = 0; i < int16.length; i++) {
    out[i * 2] = int16[i] & 0xff;
    out[i * 2 + 1] = (int16[i] >> 8) & 0xff;
  }
  return out;
}

/** float in [-1, 1] -> 16-bit signed PCM. */
export function floatToPcm(f: number): number {
  const s = Math.max(-1, Math.min(1, f));
  return s < 0 ? s * 0x8000 : s * 0x7fff;
}
