import { test } from "node:test";
import assert from "node:assert/strict";
import { DashScopeTTSClient } from "../../src/tts/adapters/dashscope.js";
import type { TTSChunk } from "../../src/tts/types.js";

/**
 * 这些用例只跑适配器的状态机：注入一个假 WebSocket 捕获客户端发出的帧，
 * 再用适配器的私有 onMessage 模拟服务端事件，全程不触网。
 */

interface Sent extends Record<string, any> {}

function attachFakeSocket(client: DashScopeTTSClient): Sent[] {
  const sent: Sent[] = [];
  (client as any).ws = {
    readyState: 1, // WebSocket.OPEN
    send: (data: any) => sent.push(JSON.parse(String(data))),
    close: () => {},
    // closeImpl 注册后立即回调，让关闭流程不依赖真实连接。
    once: (event: string, cb: () => void) => {
      if (event === "close") cb();
    },
  };
  (client as any).connected = true;
  return sent;
}

function makeClient(voice = "longanhuan_v3.6"): DashScopeTTSClient {
  return new DashScopeTTSClient({
    provider: "dashscope",
    apiKey: "test-key",
    options: { voice },
  });
}

const sendEvent = (client: DashScopeTTSClient, message: unknown) =>
  (client as any).onMessage(Buffer.from(JSON.stringify(message)), false);

const sendAudioFrame = (client: DashScopeTTSClient, bytes: number[]) =>
  (client as any).onMessage(Buffer.from(bytes), true);

const taskStarted = (client: DashScopeTTSClient) =>
  sendEvent(client, { header: { event: "task-started" } });

const taskFinished = (client: DashScopeTTSClient) =>
  sendEvent(client, {
    header: { event: "task-finished" },
    payload: { usage: { characters: 12 } },
  });

/**
 * 复刻真实载荷结构：文本在 `output` 层（original_text / normalized_text），
 * `output.sentence` 里只有 index / words（实测自 DashScope 线上响应）。
 */
const resultGenerated = (
  client: DashScopeTTSClient,
  type: string,
  extra: Record<string, unknown> = {},
) =>
  sendEvent(client, {
    header: { event: "result-generated", attributes: {} },
    payload: {
      output: { type, sentence: { index: 0, words: [] }, ...extra },
    },
  });

const actions = (sent: Sent[]) => sent.map((s) => s.header.action);

test("DashScope TTS 整段：run-task / continue-task / finish-task 同一 task_id，音频按句定稿", async () => {
  const client = makeClient();
  const sent = attachFakeSocket(client);
  const chunks: TTSChunk[] = [];
  client.on("audio", (c) => chunks.push(c));

  client.sendText("床前明月光，疑是地上霜。");
  const flushed = client.flush();

  // 任务启动前不应有 continue-task（官方要求等 task-started）。
  assert.deepEqual(actions(sent), ["run-task"]);
  const runTask = sent[0];
  assert.equal(runTask.payload.task_group, "audio");
  assert.equal(runTask.payload.task, "tts");
  assert.equal(runTask.payload.function, "SpeechSynthesizer");
  assert.equal(runTask.payload.model, "qwen-audio-3.0-tts-flash");
  assert.deepEqual(runTask.payload.parameters, {
    text_type: "PlainText",
    voice: "longanhuan_v3.6",
    format: "pcm",
    sample_rate: 24000,
  });

  taskStarted(client);
  assert.deepEqual(actions(sent), ["run-task", "continue-task", "finish-task"]);
  assert.equal(sent[1].payload.input.text, "床前明月光，疑是地上霜。");
  assert.equal(new Set(sent.map((s) => s.header.task_id)).size, 1, "同一轮的 task_id 必须一致");

  // 服务端时序：sentence-begin → (synthesis + binary)×2 → sentence-end
  resultGenerated(client, "sentence-begin", { original_text: "床前明月光，疑是地上霜。" });
  resultGenerated(client, "sentence-synthesis", {});
  sendAudioFrame(client, [1, 2, 3, 4]);
  resultGenerated(client, "sentence-synthesis", {});
  sendAudioFrame(client, [5, 6]);
  resultGenerated(client, "sentence-end", { original_text: "床前明月光，疑是地上霜。" });

  assert.deepEqual(
    chunks.map((c) => ({
      bytes: [...c.audio],
      isFinal: c.isFinal,
      id: c.id,
      index: c.index,
      text: c.text,
      format: c.format,
      sampleRate: c.sampleRate,
      channels: c.channels,
    })),
    [
      {
        bytes: [1, 2, 3, 4],
        isFinal: false,
        id: "s1",
        index: 1,
        text: "床前明月光，疑是地上霜。",
        format: "pcm",
        sampleRate: 24000,
        channels: 1,
      },
      {
        bytes: [5, 6],
        isFinal: true,
        id: "s1",
        index: 1,
        text: "床前明月光，疑是地上霜。",
        format: "pcm",
        sampleRate: 24000,
        channels: 1,
      },
    ],
  );

  taskFinished(client);
  await flushed;
});

test("DashScope TTS 逐句：flush 后继续 sendText 会在同一连接上开新任务，句序号连续", async () => {
  const client = makeClient();
  const sent = attachFakeSocket(client);
  const chunks: TTSChunk[] = [];
  client.on("audio", (c) => chunks.push(c));

  // 第一句
  client.sendText("第一句。");
  const first = client.flush();
  taskStarted(client);
  resultGenerated(client, "sentence-begin", { original_text: "第一句。" });
  sendAudioFrame(client, [1]);
  resultGenerated(client, "sentence-end", { original_text: "第一句。" });
  taskFinished(client);
  await first;

  // 第二句：连接复用，自动开新一轮
  client.sendText("第二句。");
  const second = client.flush();
  taskStarted(client);
  resultGenerated(client, "sentence-begin", { original_text: "第二句。" });
  sendAudioFrame(client, [2]);
  resultGenerated(client, "sentence-end", { original_text: "第二句。" });
  taskFinished(client);
  await second;

  const runTasks = sent.filter((s) => s.header.action === "run-task");
  assert.equal(runTasks.length, 2, "每轮 flush 前应各有一个 run-task");
  assert.notEqual(runTasks[0].header.task_id, runTasks[1].header.task_id, "新轮次必须换 task_id");
  assert.deepEqual(
    chunks.map((c) => ({ bytes: [...c.audio], isFinal: c.isFinal, id: c.id, index: c.index })),
    [
      { bytes: [1], isFinal: true, id: "s1", index: 1 },
      { bytes: [2], isFinal: true, id: "s2", index: 2 },
    ],
    "句级 id / index 应跨任务连续，便于按句排队播放",
  );
});

test("DashScope TTS：下一句开始时，上一句仍压着的那一帧按 isFinal=true 补发", async () => {
  const client = makeClient();
  attachFakeSocket(client);
  const chunks: TTSChunk[] = [];
  client.on("audio", (c) => chunks.push(c));

  client.sendText("第一句。第二句。");
  const flushed = client.flush();
  taskStarted(client);

  resultGenerated(client, "sentence-begin", { original_text: "第一句。" });
  sendAudioFrame(client, [1]);
  // 服务端未先给 sentence-end 就直接开了下一句：上一帧必须当作句尾发出。
  resultGenerated(client, "sentence-begin", { original_text: "第二句。" });
  sendAudioFrame(client, [2]);
  resultGenerated(client, "sentence-end", { original_text: "第二句。" });
  taskFinished(client);
  await flushed;

  assert.deepEqual(
    chunks.map((c) => ({ bytes: [...c.audio], isFinal: c.isFinal, id: c.id })),
    [
      { bytes: [1], isFinal: true, id: "s1" },
      { bytes: [2], isFinal: true, id: "s2" },
    ],
  );
});

test("DashScope TTS：task-failed 归类为鉴权错误，并释放等待中的 flush()", async () => {
  const client = makeClient();
  attachFakeSocket(client);
  const errors: Error[] = [];
  client.on("error", (e) => errors.push(e));

  client.sendText("你好。");
  const flushed = client.flush();
  taskStarted(client);
  sendEvent(client, {
    header: {
      event: "task-failed",
      error_code: "InvalidApiKey",
      error_message: "invalid api key",
    },
  });

  await flushed; // 失败也必须唤醒 flush()，否则调用方会永久悬挂
  assert.equal(errors.length, 1);
  assert.equal(errors[0].name, "TTSAuthError");
  assert.equal((errors[0] as { code?: string }).code, "InvalidApiKey");
});

test("DashScope TTS：close() 会把还没 flush 的排队文本补合成完", async () => {
  const client = makeClient();
  const sent = attachFakeSocket(client);

  client.sendText("收尾。");
  const closed = client.close();

  // 关闭流程里应自行走完 启动 → 提交文本 → 收尾
  assert.deepEqual(actions(sent), ["run-task"]);
  taskStarted(client);
  assert.deepEqual(actions(sent), ["run-task", "continue-task", "finish-task"]);
  assert.equal(sent[1].payload.input.text, "收尾。");
  taskFinished(client);

  await closed;
  assert.equal(client.provider, "dashscope");
});

test("DashScope TTS：未连接与缺少 voice 时给出明确错误", async () => {
  const client = makeClient();
  assert.throws(() => client.sendText("x"), /Not connected/);
  await assert.rejects(() => client.flush(), /Not connected/);

  const noVoice = new DashScopeTTSClient({ provider: "dashscope", apiKey: "test-key" });
  await assert.rejects(() => noVoice.connect(), /voice/);
});

test("DashScope TTS 暴露的能力位与协议实际能力一致", () => {
  const caps = makeClient().capabilities;
  assert.equal(caps.incrementalText, true); // 支持多次 continue-task
  assert.equal(caps.sessionReuse, true); // task-finished 后可复用连接开新任务
  assert.equal(caps.instructions, true); // parameters.instruction
  assert.equal(caps.wordTimestamps, true); // word_timestamp_enabled（需在 extra 里开启）
  assert.ok(caps.formats.includes("pcm"));
  assert.ok(caps.sampleRates.includes(24000));
});
