import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createTTSClient } from "../../src/index.js";
import type { TTSChunk } from "../../src/tts/types.js";

// 复用仓库根的 .env.local 里的真实密钥；缺失则 skip。
dotenv.config({ path: fileURLToPath(new URL("../../.env.local", import.meta.url)) });

interface SynthResult {
  pcm: Buffer;
  chunks: TTSChunk[];
  errors: string[];
}

/** 合成一句话并拼接原始 PCM（不做任何转码，供下游直接使用）。 */
async function synthesize(
  text: string,
  options: { voice: string; apiKey: string; sampleRate: number },
): Promise<SynthResult> {
  const tts = createTTSClient({
    provider: "dashscope",
    apiKey: options.apiKey,
    model: process.env.DASHSCOPE_TTS_MODEL,
    workspaceId: process.env.DASHSCOPE_WORKSPACE_ID,
    options: { voice: options.voice, format: "pcm", sampleRate: options.sampleRate },
  });

  const chunks: TTSChunk[] = [];
  const errors: string[] = [];
  tts.on("audio", (c) => chunks.push(c));
  tts.on("error", (e) => errors.push(`${e.name}: ${e.message}`));

  await tts.connect();
  tts.sendText(text);
  await tts.flush(); // 返回即表示本轮音频已全部到达
  await tts.close();

  return { pcm: Buffer.concat(chunks.map((c) => Buffer.from(c.audio))), chunks, errors };
}

/** 密钥 / 音色缺失时跳过（音色名各家不通用，本库不猜默认值）。 */
function requireCredentials(t: { skip: (msg?: string) => void }): string | null {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  const voice = process.env.DASHSCOPE_TTS_VOICE;
  if (!apiKey) {
    t.skip("未配置 DASHSCOPE_API_KEY，跳过");
    return null;
  }
  if (!voice) {
    t.skip("未配置 DASHSCOPE_TTS_VOICE，跳过");
    return null;
  }
  return voice;
}

test("dashscope TTS 端到端：合成一句话并拿到音频分片", { timeout: 30000 }, async (t) => {
  const voice = requireCredentials(t);
  if (!voice) return;

  const { pcm, chunks, errors } = await synthesize("今天天气怎么样？", {
    voice,
    apiKey: process.env.DASHSCOPE_API_KEY!,
    sampleRate: 24000,
  });

  assert.deepEqual(errors, [], `不应出现错误: ${errors.join("; ")}`);
  assert.ok(pcm.length > 0, "应收到音频数据");
  assert.ok(
    chunks.some((c) => c.isFinal),
    "应至少有一个句尾分片（isFinal=true）",
  );
  assert.ok(
    chunks.every((c) => c.format === "pcm" && c.sampleRate === 24000),
    "音频元信息应与请求一致（pcm / 24000）",
  );
  assert.ok(
    chunks.every((c) => typeof c.id === "string" && Number.isInteger(c.index)),
    "每片都应带句级 id 与 1-based index",
  );
});

test(
  "dashscope TTS 的 sampleRate 参数确实生效：字节数按采样率成比例",
  { timeout: 30000 },
  async (t) => {
    const voice = requireCredentials(t);
    if (!voice) return;

    // 同一句话，采样率相差 3 倍：字节数应当同比例变化。
    // 若服务端忽略了 sample_rate（或我们上报的元信息不实），两者会一样长 —— 这正是
    // 交叉验证（TTS→ASR）覆盖不到的那一块：实测 ASR 对 sample_rate 并不敏感。
    const text = "今天天气怎么样，我们出去走一走吧";
    const low = 8000;
    const high = 24000;

    const a = await synthesize(text, {
      voice,
      apiKey: process.env.DASHSCOPE_API_KEY!,
      sampleRate: low,
    });
    const b = await synthesize(text, {
      voice,
      apiKey: process.env.DASHSCOPE_API_KEY!,
      sampleRate: high,
    });
    assert.deepEqual([...a.errors, ...b.errors], [], "不应出现错误");

    const ratio = b.pcm.length / a.pcm.length;
    const expected = high / low;
    assert.ok(
      Math.abs(ratio - expected) / expected < 0.1,
      `${high}Hz / ${low}Hz 的字节数比应为 ${expected}，实际 ${ratio.toFixed(2)}` +
        `（${b.pcm.length} / ${a.pcm.length} 字节）`,
    );

    // 两份音频"折算成时长"应当接近：同一句话，只是采样率不同。
    const secondsA = a.pcm.length / (low * 2);
    const secondsB = b.pcm.length / (high * 2);
    assert.ok(
      Math.abs(secondsA - secondsB) / secondsA < 0.2,
      `同一句话在两种采样率下的时长应接近，实际 ${secondsA.toFixed(2)}s vs ${secondsB.toFixed(2)}s`,
    );

    // 上游上报的元信息必须与请求一致（这是我们对调用方的承诺）。
    assert.ok(
      a.chunks.every((c) => c.sampleRate === low),
      `元信息应为 ${low}`,
    );
    assert.ok(
      b.chunks.every((c) => c.sampleRate === high),
      `元信息应为 ${high}`,
    );

    t.diagnostic(
      `${low}Hz: ${a.pcm.length} 字节 (${secondsA.toFixed(2)}s) / ${high}Hz: ${b.pcm.length} 字节 (${secondsB.toFixed(2)}s)`,
    );
  },
);

/* -------------------------------------------------------------------------- */
/* 火山引擎：双向流式 / 单向流式（两种模式用户代码相同）                        */
/* -------------------------------------------------------------------------- */

/** 账号未开通语音合成时握手会被拒：403 + "requested resource not granted"。 */
function isEntitlementError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /not granted|未开通/.test(msg);
}

async function synthesizeVolc(
  text: string,
  mode: "duplex" | "oneshot",
  opts: { apiKey: string; voice: string },
): Promise<SynthResult> {
  const tts = createTTSClient({
    provider: "volcengine",
    apiKey: opts.apiKey,
    resourceId: process.env.VOLC_TTS_RESOURCE_ID,
    mode,
    options: { voice: opts.voice, format: "pcm", sampleRate: 24000 },
  });

  const chunks: TTSChunk[] = [];
  const errors: string[] = [];
  tts.on("audio", (c) => chunks.push(c));
  tts.on("error", (e) => errors.push(`${e.name}: ${e.message}`));

  await tts.connect();
  tts.sendText(text);
  await tts.flush(); // 两种模式在这里表现一致：单向模式即「一帧带全文」
  await tts.close();

  return { pcm: Buffer.concat(chunks.map((c) => Buffer.from(c.audio))), chunks, errors };
}

for (const mode of ["duplex", "oneshot"] as const) {
  test(
    `volcengine TTS 端到端（${mode}）：合成一句话并拿到音频分片`,
    { timeout: 30000 },
    async (t) => {
      const apiKey = process.env.VOLC_API_KEY;
      const voice = process.env.VOLC_TTS_VOICE;
      if (!apiKey) {
        t.skip("未配置 VOLC_API_KEY，跳过");
        return;
      }
      if (!voice) {
        t.skip("未配置 VOLC_TTS_VOICE（音色名各家不通用，本库不猜默认值），跳过");
        return;
      }

      let result: SynthResult;
      try {
        result = await synthesizeVolc("今天天气怎么样？", mode, { apiKey, voice });
      } catch (err) {
        if (isEntitlementError(err)) {
          // 账号未开通语音合成属于环境问题，不是代码问题：说清原因后跳过，别污染 CI。
          t.skip(`该 API Key 未开通语音合成服务：${(err as Error).message}`);
          return;
        }
        throw err;
      }

      assert.deepEqual(result.errors, [], `不应出现错误: ${result.errors.join("; ")}`);
      assert.ok(result.pcm.length > 0, "应收到音频数据");
      assert.ok(
        result.chunks.some((c) => c.isFinal),
        "应至少有一个句尾分片（isFinal=true）",
      );
      assert.ok(
        result.chunks.every(
          (c) => c.format === "pcm" && c.sampleRate === 24000 && c.channels === 1,
        ),
        "音频元信息应与请求一致（pcm / 24000 / mono）",
      );
      assert.ok(
        result.chunks.every((c) => typeof c.id === "string" && Number.isInteger(c.index)),
        "每片都应带句级 id 与 1-based index",
      );

      t.diagnostic(
        `${mode}: ${result.pcm.length} 字节 ≈ ${(result.pcm.length / (24000 * 2)).toFixed(2)}s`,
      );
    },
  );
}

/* -------------------------------------------------------------------------- */
/* 火山 seed-tts-1.0：字级时间戳（仅 1.0 音色提供，需 enable_timestamp）          */
/* -------------------------------------------------------------------------- */

test(
  "volcengine TTS（seed-tts-1.0）：字级时间戳可用且归一化为毫秒",
  { timeout: 30000 },
  async (t) => {
    const apiKey = process.env.VOLC_API_KEY;
    const voice = process.env.VOLC_TTS_VOICE_1_0;
    if (!apiKey) {
      t.skip("未配置 VOLC_API_KEY，跳过");
      return;
    }
    if (!voice) {
      // 音色与 resource-id 必须配套（1.0 音色不能配 seed-tts-2.0），故不猜默认值。
      t.skip("未配置 VOLC_TTS_VOICE_1_0（示例：zh_female_shuangkuaisisi_moon_bigtts），跳过");
      return;
    }

    const tts = createTTSClient({
      provider: "volcengine",
      apiKey,
      resourceId: "seed-tts-1.0",
      options: { voice, format: "pcm", sampleRate: 24000, extra: { enable_timestamp: true } },
    });

    const chunks: TTSChunk[] = [];
    const errors: string[] = [];
    tts.on("audio", (c) => chunks.push(c));
    tts.on("error", (e) => errors.push(`${e.name}: ${e.message}`));

    await tts.connect();
    tts.sendText("今天天气怎么样");
    await tts.flush();
    await tts.close();

    assert.deepEqual(errors, [], `不应出现错误: ${errors.join("; ")}`);

    const words = chunks.flatMap((c) => c.words ?? []);
    assert.ok(words.length >= 5, `应拿到字级时间戳，实际 ${words.length} 条`);
    assert.equal(words.map((w) => w.text).join(""), "今天天气怎么样");

    // 单位必须是毫秒（服务端给的是秒，适配器负责换算）——若漏乘 1000，
    // 整句时间戳会小得离谱（这里是几百毫秒 vs 每字 0.1~1.3 秒）。
    const first = words[0];
    assert.ok(
      first.beginTime !== undefined && first.endTime !== undefined,
      "字级时间戳应带起止时间",
    );
    assert.ok(
      first.endTime! > first.beginTime! && first.endTime! < 5000,
      `时间应为毫秒量级：${JSON.stringify(first)}`,
    );
    assert.ok(
      words.every((w, i) => i === 0 || w.beginTime! >= words[i - 1].beginTime!),
      "字级时间戳应单调不减",
    );

    // 句文本来自 TTSSentenceStart/End，应当被带出来
    assert.ok(
      chunks.some((c) => c.text === "今天天气怎么样"),
      "句尾分片应带 text",
    );

    t.diagnostic(
      `1.0 字级时间戳样例: ${words
        .slice(0, 3)
        .map((w) => `${w.text}@${w.beginTime}-${w.endTime}ms`)
        .join(" ")}`,
    );
  },
);

/* -------------------------------------------------------------------------- */
/* 讯飞超拟人合成：增量文本 + 一轮一连接（适配器内部自动重连）                    */
/* -------------------------------------------------------------------------- */

test("iflytek TTS 端到端：增量文本合成，并在下一轮自动重连", { timeout: 40000 }, async (t) => {
  const { IFLYTEK_APP_ID, IFLYTEK_API_KEY, IFLYTEK_API_SECRET, IFLYTEK_TTS_VCN } = process.env;
  if (!IFLYTEK_APP_ID || !IFLYTEK_API_KEY || !IFLYTEK_API_SECRET) {
    t.skip("未配置 IFLYTEK_APP_ID / IFLYTEK_API_KEY / IFLYTEK_API_SECRET，跳过");
    return;
  }
  if (!IFLYTEK_TTS_VCN) {
    // 发音人授权与字符量授权是两笔独立授权，本库不猜哪个音色可用。
    t.skip("未配置 IFLYTEK_TTS_VCN（示例：x5_lingxiaoxuan_flow），跳过");
    return;
  }

  const tts = createTTSClient({
    provider: "iflytek",
    appId: IFLYTEK_APP_ID,
    apiKey: IFLYTEK_API_KEY,
    apiSecret: IFLYTEK_API_SECRET,
    options: { voice: IFLYTEK_TTS_VCN, format: "pcm", sampleRate: 24000 },
  });

  const errors: string[] = [];
  const first: Buffer[] = [];
  const second: Buffer[] = [];
  /** 当前轮次的接收桶：轮次之间显式切换，不靠 chunk 序号猜。 */
  let sink: Buffer[] = first;
  let chunks: TTSChunk[] = [];
  tts.on("audio", (c) => {
    chunks.push(c);
    sink.push(Buffer.from(c.audio));
  });
  tts.on("error", (e) => errors.push(`${e.name}: ${e.message}`));

  try {
    await tts.connect();

    // 第一轮：增量下发（两个 sendText），再 flush 收尾
    tts.sendText("今天天气怎么样，");
    tts.sendText("我们出去走一走吧");
    await tts.flush();

    const bytesA = first.reduce((n, b) => n + b.length, 0);
    assert.ok(bytesA > 0, "第一轮应收到音频");
    assert.equal(errors.length, 0, `第一轮报错: ${errors.join("; ")}`);

    // 第二轮：讯飞不支持连接复用（实测 26016），适配器应自动重连后继续
    sink = second;
    chunks = [];
    tts.sendText("第二句测试");
    await tts.flush();

    assert.equal(errors.length, 0, `第二轮报错（自动重连可能失效）: ${errors.join("; ")}`);
    assert.ok(second.reduce((n, b) => n + b.length, 0) > 0, "第二轮应收到音频");
    assert.ok(
      chunks.some((c) => c.isFinal),
      "每轮都应有 isFinal 分片",
    );
    assert.ok(
      chunks.every((c) => c.format === "pcm" && c.sampleRate === 24000 && c.channels === 1),
      "音频元信息应与请求一致（pcm / 24000 / mono）",
    );

    const seconds = second.reduce((n, b) => n + b.length, 0) / (24000 * 2);
    t.diagnostic(
      `第二轮 ${second.reduce((n, b) => n + b.length, 0)} 字节 ≈ ${seconds.toFixed(2)}s @24k`,
    );
  } catch (err) {
    if (/11200|LiccCheck/.test((err as Error).message)) {
      t.skip(`发音人未授权：${(err as Error).message}`);
      return;
    }
    throw err;
  } finally {
    await tts.close().catch(() => {});
  }
});

/** .env 模板里的占位值：视为"未配置"，跳过而不是报错（与真正的鉴权失败区分开）。 */
const OPENAI_PLACEHOLDER_KEYS = new Set(["sk-your-key", "sk-xxx", "sk-..."]);

/* -------------------------------------------------------------------------- */
/* OpenAI：纯 HTTP，无会话（每个 flush 一次请求）                                */
/* -------------------------------------------------------------------------- */

test("openai TTS 端到端：一次请求拿到流式音频，元信息如实", { timeout: 40000 }, async (t) => {
  const apiKey = process.env.OPENAI_API_KEY;
  const voice = process.env.OPENAI_TTS_VOICE;
  if (!apiKey || OPENAI_PLACEHOLDER_KEYS.has(apiKey)) {
    t.skip("未配置真实 OPENAI_API_KEY（当前为模板占位值），跳过");
    return;
  }
  if (!voice) {
    t.skip("未配置 OPENAI_TTS_VOICE（示例：coral / marin / cedar），跳过");
    return;
  }

  const tts = createTTSClient({
    provider: "openai",
    apiKey,
    model: process.env.OPENAI_TTS_MODEL,
    options: { voice, format: "pcm" },
  });

  const chunks: TTSChunk[] = [];
  const errors: string[] = [];
  tts.on("audio", (c) => chunks.push(c));
  tts.on("error", (e) => errors.push(`${e.name}: ${e.message}`));

  await tts.connect();
  // 非增量端点：逐段 sendText 只会入缓冲，flush 时合成一次请求
  tts.sendText("今天天气怎么样？");
  tts.sendText("我们出去走一走吧。");
  await tts.flush();
  await tts.close();

  assert.deepEqual(errors, [], `不应出现错误: ${errors.join("; ")}`);
  const bytes = chunks.reduce((n, c) => n + c.audio.length, 0);
  assert.ok(bytes > 0, "应收到音频数据");
  assert.ok(
    chunks.some((c) => c.isFinal),
    "应至少有一个 isFinal 分片（流结束）",
  );
  assert.ok(
    chunks.every((c) => c.format === "pcm" && c.sampleRate === 24000 && c.channels === 1),
    "音频元信息应为 pcm / 24000 / mono",
  );
  assert.ok(
    chunks.every((c) => typeof c.id === "string" && Number.isInteger(c.index)),
    "每片都应带句级 id 与 1-based index",
  );

  t.diagnostic(
    `pcm ${bytes} 字节 ≈ ${(bytes / (24000 * 2)).toFixed(2)}s @24k，分片 ${chunks.length} 个`,
  );
});
