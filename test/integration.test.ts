import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createASRClient, type ASRConfig } from "../src/index.js";
import { stripWavHeader } from "../src/utils/wav.js";

// 复用仓库根的 .env.local 里的真实密钥；缺失则对应用例 skip。
dotenv.config({ path: fileURLToPath(new URL("../.env.local", import.meta.url)) });

const SAMPLE = fileURLToPath(new URL("../fixtures/sample-voice.wav", import.meta.url));
const CHUNK = 640; // 20ms @ 16k/16-bit mono
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface E2EResult {
  best: string;
  gotFinal: boolean;
  errors: string[];
}

/** 连真实服务商、推流示例音频、收集识别结果并排空后关闭。 */
async function runE2E(config: ASRConfig): Promise<E2EResult> {
  const client = createASRClient(config);
  const texts: string[] = [];
  const errors: string[] = [];
  let gotFinal = false;
  let lastAt = Date.now();

  client.on("transcript", (t) => {
    texts.push(t.text);
    lastAt = Date.now();
    if (t.isFinal) gotFinal = true;
  });
  client.on("error", (e) => errors.push(e.message));

  await client.connect();

  const raw = stripWavHeader(readFileSync(SAMPLE));
  for (let i = 0; i < raw.length; i += CHUNK) {
    client.sendAudio(raw.subarray(i, i + CHUNK));
    await sleep(20);
  }

  // 排空：等服务端残余结果到达，带超时兜底，避免用例挂起。
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (gotFinal) break;
    if (texts.length > 0 && Date.now() - lastAt > 1500) break; // 已安静
    await sleep(100);
  }
  await sleep(300);
  await client.close();

  const best = texts.reduce((a, b) => (b.length > a.length ? b : a), "");
  return { best, gotFinal, errors };
}

test("dashscope 端到端：识别示例音频并给出定稿", { timeout: 30000 }, async (t) => {
  if (!process.env.DASHSCOPE_API_KEY) {
    t.skip("未配置 DASHSCOPE_API_KEY，跳过");
    return;
  }
  const { best, gotFinal, errors } = await runE2E({
    provider: "dashscope",
    apiKey: process.env.DASHSCOPE_API_KEY,
    model: process.env.DASHSCOPE_MODEL,
    workspaceId: process.env.DASHSCOPE_WORKSPACE_ID,
  });
  assert.ok(errors.length === 0, `出现错误: ${errors.join("; ")}`);
  assert.ok(best.includes("今天天气"), `期望识别到示例内容，实际: ${best}`);
  assert.ok(gotFinal, "DashScope 应给出 isFinal=true 的定稿");
});

test("volcengine 端到端：识别示例音频", { timeout: 30000 }, async (t) => {
  if (!process.env.VOLC_API_KEY) {
    t.skip("未配置 VOLC_API_KEY，跳过");
    return;
  }
  const { best, errors } = await runE2E({
    provider: "volcengine",
    apiKey: process.env.VOLC_API_KEY,
    resourceId: process.env.VOLC_RESOURCE_ID,
  });
  assert.ok(errors.length === 0, `出现错误: ${errors.join("; ")}`);
  assert.ok(best.includes("今天天气"), `期望识别到示例内容，实际: ${best}`);
});
