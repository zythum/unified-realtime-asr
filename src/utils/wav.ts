/**
 * Minimal WAV helpers for test fixtures.
 *
 * The ASR client expects raw 16-bit little-endian PCM (no container). These
 * helpers detect a RIFF/WAVE container and strip everything up to the `data`
 * sub-chunk, so a `.wav` file can be fed as if it were raw PCM.
 */

export function isWav(buffer: Buffer): boolean {
  return (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WAVE"
  );
}

/** Return the raw PCM payload, skipping the WAV container. Non-WAV is returned as-is. */
export function stripWavHeader(buffer: Buffer): Buffer {
  if (!isWav(buffer)) return buffer;
  // Sub-chunks start after "RIFF" + size (4+4) + "WAVE" (4) => offset 12.
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "data") {
      return buffer.subarray(offset + 8, offset + 8 + size);
    }
    offset += 8 + size + (size & 1); // chunks are word-aligned
  }
  return buffer;
}
