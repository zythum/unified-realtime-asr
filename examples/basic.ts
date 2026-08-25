import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createASRClient, type ASRConfig } from "../src/index.js";
import { stripWavHeader } from "../src/utils/wav.js";

// 用 dotenv 加载仓库根的 .env.local（gitignored），避免密钥入库；已存在的环境变量优先。
dotenv.config({ path: fileURLToPath(new URL("../.env.local", import.meta.url)) });

/**
 * Usage demo. Without credentials it just prints the configured client and
 * exits — set env vars to actually stream.
 *
 *   ASR_PROVIDER=dashscope DASHSCOPE_API_KEY=sk-xxx npm run dev
 *   ASR_PROVIDER=openai-realtime OPENAI_API_KEY=sk-xxx npm run dev
 *
 * Feed a PCM (16k mono) or WAV file via ASR_PCM_FILE to stream it through:
 *   ASR_PCM_FILE=fixtures/sample-voice.pcm ... npm run dev
 *   ASR_PCM_FILE=fixtures/sample-voice.wav ... npm run dev   # header auto-stripped
 */

async function main(): Promise<void> {
  const provider = process.env.ASR_PROVIDER;
  if (!provider) {
    console.log("No ASR_PROVIDER set. Set one of:");
    console.log("openai-realtime, dashscope, volcengine, plus credentials.");
    console.log("Optionally set ASR_PCM_FILE=/path/to/16k-mono.pcm to stream a file.");
    return;
  }

  const config = buildConfig(provider);
  const client = createASRClient(config);

  // 调用方自行维护「当前识别文本」与「是否收到显式 final」，以便在不依赖
  // 适配器内部收尾逻辑的前提下，于排空后补打 final。
  let lastPartial = "";
  let lastPartialAt = 0;
  let gotFinal = false;

  client.on("open", () => console.log(`[${client.provider}] connected`));
  // 单一 transcript 事件，用 t.isFinal 分流中间稿 / 定稿。
  client.on("transcript", (t) => {
    if (t.isFinal) {
      gotFinal = true;
      console.log(`\n(final)   ${t.text}`);
    } else {
      lastPartial = t.text;
      lastPartialAt = Date.now();
      process.stdout.write(`\r(partial) ${t.text}`);
    }
  });
  client.on("error", (e) => console.error("\n[error]", e.message));
  client.on("close", (i) => console.log("\n[closed]", i));

  await client.connect();

  const pcmFile = process.env.ASR_PCM_FILE;
  if (pcmFile) {
    // Stream the file in 20ms chunks (640 bytes @ 16k/16-bit mono).
    // `.wav` inputs have their container header stripped on the fly.
    const CHUNK = 640;
    const raw = pcmFile.toLowerCase().endsWith(".wav")
      ? stripWavHeader(readFileSync(pcmFile))
      : readFileSync(pcmFile);
    const chunks: Buffer[] = [];
    for (let i = 0; i < raw.length; i += CHUNK) chunks.push(raw.subarray(i, i + CHUNK));
    const source = Readable.from(chunks);
    for await (const chunk of source) {
      client.sendAudio(chunk);
      await sleep(20);
    }

    // 排空补偿（编排在调用方，而非适配器内）：客户端已停止喂音频，但服务端最终
    // 结果相对关闭存在滞后，需保持连接打开等残余结果到达，再补打 final 并关闭。
    await drainWait(
      () => gotFinal,
      () => Date.now() - lastPartialAt >= 800,
    );
    if (!gotFinal && lastPartial) console.log(`\n(final)   ${lastPartial}`);
  } else {
    console.log("Connected. Call client.sendAudio(<pcm>) from your microphone capture.");
    // keep the process alive a bit so you can pipe audio in
    await sleep(5000);
  }

  await client.close();
}

/** 调用方侧的排空窗口：客户端主动结束推流后，保持连接打开等服务端残余结果到达。 */
function drainWait(isFinal: () => boolean, isQuiet: () => boolean, maxMs = 4000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (isFinal()) return resolve();
      if (timeSince(start) >= maxMs) return resolve();
      if (isQuiet()) return resolve();
      setTimeout(tick, 100);
    };
    tick();
  });
}

function timeSince(start: number): number {
  return Date.now() - start;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function buildConfig(provider: string): ASRConfig {
  switch (provider) {
    case "openai-realtime":
      return { provider: "openai-realtime", apiKey: process.env.OPENAI_API_KEY! };
    case "dashscope":
      return {
        provider: "dashscope",
        apiKey: process.env.DASHSCOPE_API_KEY!,
        model: process.env.DASHSCOPE_MODEL,
        workspaceId: process.env.DASHSCOPE_WORKSPACE_ID,
      };
    case "volcengine":
      return {
        provider: "volcengine",
        apiKey: process.env.VOLC_API_KEY!,
        resourceId: process.env.VOLC_RESOURCE_ID,
      };
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
