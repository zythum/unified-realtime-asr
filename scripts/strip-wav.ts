/**
 * Strip the WAV container header from a .wav file, producing raw 16-bit
 * little-endian PCM that the ASR client can consume directly.
 *
 * Usage:
 *   tsx scripts/strip-wav.ts --in fixtures/sample-voice.wav
 *   tsx scripts/strip-wav.ts --in in.wav --out out.pcm
 */
import { readFileSync, writeFileSync } from "node:fs";
import { stripWavHeader } from "../src/utils/wav.js";

function get(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const IN = get("--in", "");
const OUT = get("--out", IN.replace(/\.wav$/i, ".pcm"));

if (!IN) {
  console.error("Usage: tsx scripts/strip-wav.ts --in file.wav [--out file.pcm]");
  process.exit(1);
}

const raw = stripWavHeader(readFileSync(IN));
writeFileSync(OUT, raw);
console.log(
  `[ok] ${OUT}  (${raw.length} bytes, ~${(raw.length / 2 / 16000).toFixed(2)}s @ 16k/16-bit/mono)`,
);
