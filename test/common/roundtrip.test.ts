import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createASRClient, createTTSClient } from "../../src/index.js";
import type { TTSChunk } from "../../src/tts/types.js";

/**
 * 跨方向交叉验证：TTS 合成的音频再喂给 ASR，文本应当能对回来。
 *
 * 它能证明什么：
 *   1. TTS 产出的音频**真的可懂**——若字节布局错了（容器头没去掉、声道交错、位深不对），
 *      ASR 会听成乱码；
 *   2. 两个方向的适配器在同一条真实链路上自洽（非 mock）。
 *
 * 它**不能**证明什么（实测结论，别让这条测试承担超出能力的责任）：
 *   - 不能验证 `sampleRate` 元信息是否如实。实测发现 DashScope ASR 对上报的
 *     `sample_rate` 不敏感（同一段 16k 音频按 8000 / 16000 / 24000 上报，识别结果完全一致），
 *     所以"采样率报错就会被听出来"是不成立的。
 *     采样率真实性由 `test/tts/integration.test.ts` 用「字节数按采样率成比例」来验证。
 *
 * 两个方向都用 16kHz 单声道 PCM，避免依赖任何重采样（本库不做重采样）。
 */

dotenv.config({ path: fileURLToPath(new URL("../../.env.local", import.meta.url)) });

const SAMPLE_RATE = 16000;
const ASR_CHUNK = 640; // 20ms @ 16k/16-bit mono
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 去掉标点 / 空白，只留可比较的内容。 */
function normalize(text: string): string {
  return text.replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, "");
}

/** 基于最长公共子序列的相似度（1 = 完全一致），用作 ASR 准确率的粗略代理。 */
function similarity(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  const dp = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return (2 * dp[a.length][b.length]) / (a.length + b.length);
}

/** 合成一句话，返回拼接后的原始 PCM 与分片列表。 */
async function synthesize(
  text: string,
  voice: string,
  apiKey: string,
): Promise<{
  pcm: Buffer;
  chunks: TTSChunk[];
  errors: string[];
}> {
  const tts = createTTSClient({
    provider: "dashscope",
    apiKey,
    model: process.env.DASHSCOPE_TTS_MODEL,
    workspaceId: process.env.DASHSCOPE_WORKSPACE_ID,
    options: { voice, format: "pcm", sampleRate: SAMPLE_RATE },
  });

  const chunks: TTSChunk[] = [];
  const errors: string[] = [];
  tts.on("audio", (c) => chunks.push(c));
  tts.on("error", (e) => errors.push(`${e.name}: ${e.message}`));

  await tts.connect();
  tts.sendText(text);
  await tts.flush();
  await tts.close();

  const pcm = Buffer.concat(chunks.map((c) => Buffer.from(c.audio)));
  return { pcm, chunks, errors };
}

/** 把 PCM 按实时节奏喂给 ASR，返回全部中间稿中信息量最大的那一条。 */
async function recognize(pcm: Buffer, apiKey: string): Promise<{ best: string; errors: string[] }> {
  const asr = createASRClient({
    provider: "dashscope",
    apiKey,
    model: process.env.DASHSCOPE_ASR_MODEL,
    workspaceId: process.env.DASHSCOPE_WORKSPACE_ID,
    options: { sampleRate: SAMPLE_RATE, channels: 1, format: "pcm" },
  });

  const texts: string[] = [];
  const errors: string[] = [];
  let lastAt = Date.now();
  asr.on("transcript", (t) => {
    texts.push(t.text);
    lastAt = Date.now();
  });
  asr.on("error", (e) => errors.push(`${e.name}: ${e.message}`));

  await asr.connect();
  for (let i = 0; i < pcm.length; i += ASR_CHUNK) {
    asr.sendAudio(pcm.subarray(i, i + ASR_CHUNK));
    await sleep(20);
  }

  // 排空：等服务端残余结果到达，带超时兜底。
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (texts.length > 0 && Date.now() - lastAt > 1500) break;
    await sleep(100);
  }
  await sleep(300);
  await asr.close();

  const best = texts.reduce((a, b) => (b.length > a.length ? b : a), "");
  return { best, errors };
}

test(
  "交叉验证：DashScope TTS 合成的音频送进 DashScope ASR 能识别回来",
  { timeout: 60000 },
  async (t) => {
    const apiKey = process.env.DASHSCOPE_API_KEY;
    const voice = process.env.DASHSCOPE_TTS_VOICE;
    if (!apiKey) {
      t.skip("未配置 DASHSCOPE_API_KEY，跳过");
      return;
    }
    if (!voice) {
      t.skip("未配置 DASHSCOPE_TTS_VOICE，跳过");
      return;
    }

    const source = "今天天气怎么样，我们出去走一走吧";

    const { pcm, chunks, errors: ttsErrors } = await synthesize(source, voice, apiKey);
    assert.deepEqual(ttsErrors, [], `TTS 报错: ${ttsErrors.join("; ")}`);

    // 元信息必须如实：这是我们对外承诺的字段。
    assert.ok(chunks.length > 0, "应收到音频分片");
    assert.ok(
      chunks.every((c) => c.format === "pcm" && c.sampleRate === SAMPLE_RATE && c.channels === 1),
      "分片元信息应与请求一致（pcm / 16000 / mono）",
    );
    assert.ok(
      chunks.some((c) => c.isFinal),
      "应至少有一个句尾分片",
    );

    // 时长兜底：只能拦住"量级级"的错误（例如把 mp3 字节当成 PCM 会算出荒谬时长），
    // 拦不住 1.5 倍的采样率偏差——那种偏差要靠 test/tts 里的字节数比例测试。
    const seconds = pcm.length / (SAMPLE_RATE * 2);
    assert.ok(
      seconds > 0.5 && seconds < 15,
      `音频时长不合理：${seconds.toFixed(2)}s（${pcm.length} 字节）`,
    );

    const { best, errors: asrErrors } = await recognize(pcm, apiKey);
    assert.deepEqual(asrErrors, [], `ASR 报错: ${asrErrors.join("; ")}`);

    const ratio = similarity(normalize(source), normalize(best));
    // 打印实际往返结果：这是这条链路唯一能观察到的"真实准确率"，失败时也便于定位。
    t.diagnostic(`源文本　: ${source}`);
    t.diagnostic(`往返结果: ${best}（相似度 ${ratio.toFixed(2)}，音频 ${seconds.toFixed(2)}s）`);

    assert.ok(
      ratio >= 0.8,
      `往返文本相似度不足：${ratio.toFixed(2)}\n  源文本: ${source}\n  ASR 结果: ${best}`,
    );
  },
);

/* -------------------------------------------------------------------------- */
/* 火山侧：TTS → ASR（同一把 key，两个方向都走火山自己的服务）                   */
/* -------------------------------------------------------------------------- */

/** 合成一句话（16k PCM，避免任何重采样）。 */
async function synthesizeVolc(text: string, voice: string, apiKey: string): Promise<Buffer> {
  const tts = createTTSClient({
    provider: "volcengine",
    apiKey,
    resourceId: process.env.VOLC_TTS_RESOURCE_ID,
    options: { voice, format: "pcm", sampleRate: SAMPLE_RATE },
  });
  const chunks: Buffer[] = [];
  const errors: string[] = [];
  tts.on("audio", (c) => chunks.push(Buffer.from(c.audio)));
  tts.on("error", (e) => errors.push(`${e.name}: ${e.message}`));

  await tts.connect();
  tts.sendText(text);
  await tts.flush();
  await tts.close();

  assert.deepEqual(errors, [], `TTS 报错: ${errors.join("; ")}`);
  return Buffer.concat(chunks);
}

async function recognizeVolc(pcm: Buffer, apiKey: string): Promise<string> {
  const asr = createASRClient({
    provider: "volcengine",
    apiKey,
    resourceId: process.env.VOLC_ASR_RESOURCE_ID,
    options: { sampleRate: SAMPLE_RATE, channels: 1, format: "pcm" },
  });
  const texts: string[] = [];
  let lastAt = Date.now();
  asr.on("transcript", (t) => {
    texts.push(t.text);
    lastAt = Date.now();
  });
  asr.on("error", (e) => console.error("[volc asr]", e.message));

  await asr.connect();
  for (let i = 0; i < pcm.length; i += ASR_CHUNK) {
    asr.sendAudio(pcm.subarray(i, i + ASR_CHUNK));
    await sleep(20);
  }
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (texts.length > 0 && Date.now() - lastAt > 1500) break;
    await sleep(100);
  }
  await sleep(300);
  await asr.close();

  return texts.reduce((a, b) => (b.length > a.length ? b : a), "");
}

test("交叉验证：火山 TTS 合成的音频送进火山 ASR 能识别回来", { timeout: 60000 }, async (t) => {
  const apiKey = process.env.VOLC_API_KEY;
  const voice = process.env.VOLC_TTS_VOICE;
  if (!apiKey) {
    t.skip("未配置 VOLC_API_KEY，跳过");
    return;
  }
  if (!voice) {
    t.skip("未配置 VOLC_TTS_VOICE，跳过");
    return;
  }

  const source = "今天天气怎么样，我们出去走一走吧";
  const pcm = await synthesizeVolc(source, voice, apiKey);
  assert.ok(pcm.length > 0, "应收到音频数据");

  const seconds = pcm.length / (SAMPLE_RATE * 2);
  assert.ok(seconds > 0.5 && seconds < 15, `音频时长不合理：${seconds.toFixed(2)}s`);

  const best = await recognizeVolc(pcm, apiKey);
  const ratio = similarity(normalize(source), normalize(best));
  t.diagnostic(`源文本　: ${source}`);
  t.diagnostic(`往返结果: ${best}（相似度 ${ratio.toFixed(2)}，音频 ${seconds.toFixed(2)}s）`);

  assert.ok(
    ratio >= 0.8,
    `往返文本相似度不足：${ratio.toFixed(2)}\n  源文本: ${source}\n  ASR 结果: ${best}`,
  );
});

/* -------------------------------------------------------------------------- */
/* 讯飞侧：TTS → ASR（顺带覆盖讯飞识别的真机路径，此前只有状态机单测）             */
/* -------------------------------------------------------------------------- */

const iflytekCreds = () => ({
  appId: process.env.IFLYTEK_APP_ID,
  apiKey: process.env.IFLYTEK_API_KEY,
  apiSecret: process.env.IFLYTEK_API_SECRET,
  voice: process.env.IFLYTEK_TTS_VCN,
});

async function synthesizeIflytek(
  text: string,
  voice: string,
  creds: { appId: string; apiKey: string; apiSecret: string },
): Promise<Buffer> {
  const tts = createTTSClient({
    provider: "iflytek",
    appId: creds.appId,
    apiKey: creds.apiKey,
    apiSecret: creds.apiSecret,
    options: { voice, format: "pcm", sampleRate: SAMPLE_RATE },
  });
  const chunks: Buffer[] = [];
  const errors: string[] = [];
  tts.on("audio", (c) => chunks.push(Buffer.from(c.audio)));
  tts.on("error", (e) => errors.push(`${e.name}: ${e.message}`));

  await tts.connect();
  tts.sendText(text);
  await tts.flush();
  await tts.close();

  assert.deepEqual(errors, [], `TTS 报错: ${errors.join("; ")}`);
  return Buffer.concat(chunks);
}

async function recognizeIflytek(
  pcm: Buffer,
  creds: { appId: string; apiKey: string; apiSecret: string },
): Promise<string> {
  const asr = createASRClient({
    provider: "iflytek",
    appId: creds.appId,
    apiKey: creds.apiKey,
    apiSecret: creds.apiSecret,
    options: { sampleRate: SAMPLE_RATE, channels: 1, format: "pcm" },
  });
  const texts: string[] = [];
  let lastAt = Date.now();
  asr.on("transcript", (t) => {
    texts.push(t.text);
    lastAt = Date.now();
  });
  asr.on("error", (e) => console.error("[iflytek asr]", e.message));

  await asr.connect();
  for (let i = 0; i < pcm.length; i += ASR_CHUNK) {
    asr.sendAudio(pcm.subarray(i, i + ASR_CHUNK));
    await sleep(20);
  }
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (texts.length > 0 && Date.now() - lastAt > 1500) break;
    await sleep(100);
  }
  await sleep(300);
  await asr.close();

  return texts.reduce((a, b) => (b.length > a.length ? b : a), "");
}

test("交叉验证：讯飞 TTS 合成的音频送进讯飞 ASR 能识别回来", { timeout: 60000 }, async (t) => {
  const { appId, apiKey, apiSecret, voice } = iflytekCreds();
  if (!appId || !apiKey || !apiSecret) {
    t.skip("未配置 IFLYTEK_APP_ID / IFLYTEK_API_KEY / IFLYTEK_API_SECRET，跳过");
    return;
  }
  if (!voice) {
    t.skip("未配置 IFLYTEK_TTS_VCN（示例：x5_lingxiaoxuan_flow），跳过");
    return;
  }

  const source = "今天天气怎么样，我们出去走一走吧";
  let pcm: Buffer;
  try {
    pcm = await synthesizeIflytek(source, voice, { appId, apiKey, apiSecret });
  } catch (err) {
    if (/11200|LiccCheck/.test((err as Error).message)) {
      t.skip(`发音人未授权：${(err as Error).message}`);
      return;
    }
    throw err;
  }
  assert.ok(pcm.length > 0, "应收到音频数据");

  const seconds = pcm.length / (SAMPLE_RATE * 2);
  assert.ok(seconds > 0.5 && seconds < 15, `音频时长不合理：${seconds.toFixed(2)}s`);

  const best = await recognizeIflytek(pcm, { appId, apiKey, apiSecret });
  const ratio = similarity(normalize(source), normalize(best));
  t.diagnostic(`源文本　: ${source}`);
  t.diagnostic(`往返结果: ${best}（相似度 ${ratio.toFixed(2)}，音频 ${seconds.toFixed(2)}s）`);

  assert.ok(
    ratio >= 0.8,
    `往返文本相似度不足：${ratio.toFixed(2)}\n  源文本: ${source}\n  ASR 结果: ${best}`,
  );
});

/** .env 模板里的占位值：视为"未配置"，跳过而不是报错（与真正的鉴权失败区分开）。 */
const OPENAI_PLACEHOLDER_KEYS = new Set(["sk-your-key", "sk-xxx", "sk-..."]);

/* -------------------------------------------------------------------------- */
/* OpenAI 侧：TTS → ASR（都是 24kHz pcm16 mono，不需要任何重采样）               */
/* -------------------------------------------------------------------------- */

const OPENAI_RATE = 24000;

async function synthesizeOpenAI(text: string, voice: string, apiKey: string): Promise<Buffer> {
  const tts = createTTSClient({
    provider: "openai",
    apiKey,
    model: process.env.OPENAI_TTS_MODEL,
    options: { voice, format: "pcm" },
  });
  const chunks: Buffer[] = [];
  const errors: string[] = [];
  tts.on("audio", (c) => chunks.push(Buffer.from(c.audio)));
  tts.on("error", (e) => errors.push(`${e.name}: ${e.message}`));

  await tts.connect();
  tts.sendText(text);
  await tts.flush();
  await tts.close();

  assert.deepEqual(errors, [], `TTS 报错: ${errors.join("; ")}`);
  return Buffer.concat(chunks);
}

async function recognizeOpenAI(pcm: Buffer, apiKey: string): Promise<string> {
  const asr = createASRClient({
    provider: "openai",
    apiKey,
    options: { sampleRate: OPENAI_RATE, channels: 1, format: "pcm" },
  });
  const texts: string[] = [];
  let lastAt = Date.now();
  asr.on("transcript", (t) => {
    texts.push(t.text);
    lastAt = Date.now();
  });
  asr.on("error", (e) => console.error("[openai asr]", e.message));

  await asr.connect();
  const chunk = 1440; // 30ms @ 24k/16-bit mono
  for (let i = 0; i < pcm.length; i += chunk) {
    asr.sendAudio(pcm.subarray(i, i + chunk));
    await sleep(20);
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (texts.length > 0 && Date.now() - lastAt > 1500) break;
    await sleep(100);
  }
  await sleep(300);
  await asr.close();

  return texts.reduce((a, b) => (b.length > a.length ? b : a), "");
}

test("交叉验证：OpenAI TTS 合成的音频送进 OpenAI ASR 能识别回来", { timeout: 60000 }, async (t) => {
  const apiKey = process.env.OPENAI_API_KEY;
  const voice = process.env.OPENAI_TTS_VOICE;
  if (!apiKey || OPENAI_PLACEHOLDER_KEYS.has(apiKey)) {
    t.skip("未配置真实 OPENAI_API_KEY（当前为模板占位值），跳过");
    return;
  }
  if (!voice) {
    t.skip("未配置 OPENAI_TTS_VOICE，跳过");
    return;
  }

  const source = "今天天气怎么样，我们出去走一走吧";
  const pcm = await synthesizeOpenAI(source, voice, apiKey);
  assert.ok(pcm.length > 0, "应收到音频数据");

  const seconds = pcm.length / (OPENAI_RATE * 2);
  assert.ok(seconds > 0.5 && seconds < 15, `音频时长不合理：${seconds.toFixed(2)}s`);

  const best = await recognizeOpenAI(pcm, apiKey);
  const ratio = similarity(normalize(source), normalize(best));
  t.diagnostic(`源文本　: ${source}`);
  t.diagnostic(`往返结果: ${best}（相似度 ${ratio.toFixed(2)}，音频 ${seconds.toFixed(2)}s）`);

  assert.ok(
    ratio >= 0.8,
    `往返文本相似度不足：${ratio.toFixed(2)}\n  源文本: ${source}\n  ASR 结果: ${best}`,
  );
});
