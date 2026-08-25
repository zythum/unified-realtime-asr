/**
 * Generate a real-speech PCM test fixture from text using macOS `say` (TTS)
 * piped through `ffmpeg` into 16k/16-bit/mono raw PCM (optionally also .wav).
 *
 * Usage:
 *   tsx scripts/gen-sample-voice.ts
 *   tsx scripts/gen-sample-voice.ts --text "你好世界" --voice Tingting --out fixtures/sample-voice.pcm --wav
 *
 * Requirements: macOS (for `say`) and `ffmpeg` (brew install ffmpeg).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);

function get(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
function has(flag: string): boolean {
  return process.argv.includes(flag);
}

const TEXT = get("--text", "今天天气真好，我们一起来测试一下实时语音识别功能。");
const VOICE = get("--voice", "Tingting");
const OUT = get("--out", "fixtures/sample-voice.pcm");
const ALSO_WAV = has("--wav");

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "asr-voice-"));
  const aiff = join(tmp, "voice.aiff");

  try {
    console.log(`[say] synthesizing (voice=${VOICE}): ${TEXT}`);
    await run("say", ["-v", VOICE, "-o", aiff, TEXT]);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      throw new Error("`say` not found. This generator requires macOS.");
    }
    throw new Error(`\`say\` failed: ${err?.stderr?.toString() ?? err?.message ?? err}`);
  }

  try {
    await run("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-i",
      aiff,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-f",
      "s16le",
      OUT,
    ]);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      throw new Error("`ffmpeg` not found. Install it via `brew install ffmpeg`.");
    }
    throw new Error(`\`ffmpeg\` failed: ${err?.stderr?.toString() ?? err?.message ?? err}`);
  }

  const raw = readFileSync(OUT);
  console.log(
    `[ok] ${OUT}  (${raw.length} bytes, ~${(raw.length / 2 / 16000).toFixed(2)}s @ 16k/16-bit/mono)`,
  );

  if (ALSO_WAV) {
    const wav = OUT.replace(/\.pcm$/i, ".wav");
    await run("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-i",
      aiff,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      wav,
    ]);
    console.log(`[ok] ${wav}  (playable WAV with header)`);
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
