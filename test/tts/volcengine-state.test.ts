import { test } from "node:test";
import assert from "node:assert/strict";
import { VolcengineTTSClient } from "../../src/tts/adapters/volcengine.js";
import {
  MSG_AUDIO_ONLY_RESPONSE,
  MSG_FULL_CLIENT_REQUEST,
  MSG_FULL_SERVER_RESPONSE,
  decodeFrame,
  encodeFrame,
} from "../../src/utils/volc-frames.js";
import type { TTSChunk } from "../../src/tts/types.js";

/**
 * 状态机单测：注入假 WebSocket 捕获上行帧，用共享帧编解码构造**服务端**事件，全程不触网。
 * 两个坑都踩过，用例刻意按真实形态构造：
 *   1. 服务端事件必须用 `MSG_FULL_SERVER_RESPONSE`（0b1001），客户端请求帧是 0b0001，
 *      适配器只认前者（构造错类型会被静默忽略，表现为整组用例假挂）；
 *   2. 事件要通过 **binary 通道**（`onMessage(..., true)`）注入 —— 火山连控制事件都走
 *      WebSocket binary，适配器曾按 `isBinary` 分流而把事件当音频吞掉。
 */

const EVENT = {
  ConnectionStarted: 50,
  SessionStarted: 150,
  SessionFinished: 152,
  SessionFailed: 153,
  TTSSentenceStart: 350,
  TTSSentenceEnd: 351,
  TTSResponse: 352,
} as const;

interface SentFrame {
  messageType: number;
  event?: number;
  sessionId?: string;
  flags: number;
  payload: any;
}

/**
 * 注入假 socket。`connectionReady: false` 时状态机停在「未连接就绪」，
 * 由用例显式注入 ConnectionStarted 驱动 —— 与真实时序（connectImpl 里发 StartConnection）一致。
 */
function attachFakeSocket(client: VolcengineTTSClient, connectionReady = false) {
  const sent: Buffer[] = [];
  (client as any).ws = {
    readyState: 1,
    send: (data: Buffer) => sent.push(Buffer.from(data)),
    close: () => {},
    once: (event: string, cb: () => void) => {
      if (event === "close") cb();
    },
  };
  (client as any).connected = true;
  if (connectionReady) (client as any).connectionState = "ready";
  return {
    sent,
    frames: (): SentFrame[] =>
      sent.map((buf) => {
        const f = decodeFrame(buf);
        return {
          messageType: f.messageType,
          event: f.event,
          sessionId: f.sessionId,
          flags: f.flags,
          payload: f.payload.length ? JSON.parse(f.payload.toString("utf-8")) : undefined,
        };
      }),
  };
}

function makeClient(mode: "duplex" | "oneshot" = "duplex"): VolcengineTTSClient {
  return new VolcengineTTSClient({
    provider: "volcengine",
    apiKey: "test-key",
    mode,
    options: { voice: "zh_female_vv_uranus_bigtts" },
  });
}

/** 服务端下发：带 event 的控制 / 数据帧。 */
const sendEvent = (
  client: VolcengineTTSClient,
  event: number,
  payload?: object,
  sessionId?: string,
) =>
  (client as any).onMessage(
    encodeFrame({
      messageType: MSG_FULL_SERVER_RESPONSE,
      event,
      sessionId,
      payload: Buffer.from(payload ? JSON.stringify(payload) : "", "utf-8"),
    }),
    true, // 实测：火山连控制事件也走 WebSocket binary 消息
  );

/** 服务端下发：音频帧（两种承载方式都要支持）。 */
const sendAudio = (client: VolcengineTTSClient, bytes: number[], viaAudioOnlyFrame = false) =>
  (client as any).onMessage(
    viaAudioOnlyFrame
      ? encodeFrame({ messageType: MSG_AUDIO_ONLY_RESPONSE, payload: Buffer.from(bytes) })
      : encodeFrame({
          messageType: MSG_FULL_SERVER_RESPONSE,
          event: EVENT.TTSResponse,
          payload: Buffer.from(bytes),
        }),
    true,
  );

const events = (frames: SentFrame[]) => frames.map((f) => f.event);

test("火山 TTS duplex：ConnectionStarted → StartSession → TaskRequest → FinishSession，音频按句定稿", async () => {
  const client = makeClient();
  const { frames } = attachFakeSocket(client);
  const chunks: TTSChunk[] = [];
  client.on("audio", (c) => chunks.push(c));

  client.sendText("今天天气怎么样");
  const flushed = client.flush();

  // 连接未就绪：只能排队，不能发包（官方要求等 ConnectionStarted 才能发 StartSession）
  assert.deepEqual(frames(), []);

  sendEvent(client, EVENT.ConnectionStarted);
  let sent = frames();
  assert.deepEqual(events(sent), [100]);
  assert.equal(sent[0].messageType, MSG_FULL_CLIENT_REQUEST);
  assert.ok(typeof sent[0].sessionId === "string" && sent[0].sessionId.length > 0);
  assert.equal(sent[0].payload.event, 100);
  assert.equal(sent[0].payload.req_params.speaker, "zh_female_vv_uranus_bigtts");
  assert.equal(sent[0].payload.req_params.audio_params.format, "pcm");
  assert.equal(sent[0].payload.req_params.audio_params.sample_rate, 24000);
  const sid = sent[0].sessionId!;

  // SessionStarted 之后才发文本与收尾，且同轮 sessionId 一致
  sendEvent(client, EVENT.SessionStarted, {}, sid);
  sent = frames();
  assert.deepEqual(events(sent), [100, 200, 102]);
  assert.equal(sent[1].payload.req_params.text, "今天天气怎么样");
  assert.equal(new Set(sent.slice(1).map((f) => f.sessionId)).size, 1);

  // 服务端：句开始 → 两帧音频（一帧走 TTSResponse、一帧走 audio-only 帧）→ 句结束
  sendEvent(client, EVENT.TTSSentenceStart, {}, sid);
  sendAudio(client, [1, 2, 3, 4]);
  sendAudio(client, [5, 6], true);
  sendEvent(client, EVENT.TTSSentenceEnd, {}, sid);

  assert.deepEqual(
    chunks.map((c) => ({ bytes: [...c.audio], isFinal: c.isFinal, id: c.id, index: c.index })),
    [
      { bytes: [1, 2, 3, 4], isFinal: false, id: "s1", index: 1 },
      { bytes: [5, 6], isFinal: true, id: "s1", index: 1 },
    ],
  );
  assert.equal(chunks[0].format, "pcm");
  assert.equal(chunks[0].sampleRate, 24000);
  assert.equal(chunks[0].channels, 1);

  sendEvent(client, EVENT.SessionFinished, {}, sid);
  await flushed;
});

test("火山 TTS duplex：SessionFinished 后继续 sendText 复用连接开新一轮，句序号连续", async () => {
  const client = makeClient();
  const { frames } = attachFakeSocket(client);
  const chunks: TTSChunk[] = [];
  client.on("audio", (c) => chunks.push(c));

  client.sendText("第一句");
  const first = client.flush();
  sendEvent(client, EVENT.ConnectionStarted);
  const sid1 = frames()[0].sessionId!;
  sendEvent(client, EVENT.SessionStarted, {}, sid1);
  sendEvent(client, EVENT.TTSSentenceStart, {}, sid1);
  sendAudio(client, [1]);
  sendEvent(client, EVENT.TTSSentenceEnd, {}, sid1);
  sendEvent(client, EVENT.SessionFinished, {}, sid1);
  await first;

  client.sendText("第二句");
  const second = client.flush();
  const sessions = frames().filter((f) => f.event === 100);
  assert.equal(sessions.length, 2, "第二轮应在同一连接上重新 StartSession");
  assert.notEqual(sessions[0].sessionId, sessions[1].sessionId, "新会话必须换 sessionId");

  const sid2 = sessions[1].sessionId!;
  sendEvent(client, EVENT.SessionStarted, {}, sid2);
  sendEvent(client, EVENT.TTSSentenceStart, {}, sid2);
  sendAudio(client, [2]);
  sendEvent(client, EVENT.TTSSentenceEnd, {}, sid2);
  sendEvent(client, EVENT.SessionFinished, {}, sid2);
  await second;

  assert.deepEqual(
    chunks.map((c) => ({ bytes: [...c.audio], isFinal: c.isFinal, id: c.id, index: c.index })),
    [
      { bytes: [1], isFinal: true, id: "s1", index: 1 },
      { bytes: [2], isFinal: true, id: "s2", index: 2 },
    ],
  );
});

test("火山 TTS oneshot：sendText 只入缓冲，flush 时一次性下发一帧（无 event）", async () => {
  const client = makeClient("oneshot");
  const { sent, frames } = attachFakeSocket(client, true);
  const chunks: TTSChunk[] = [];
  client.on("audio", (c) => chunks.push(c));

  assert.equal(client.capabilities.incrementalText, false);
  assert.equal(client.capabilities.sessionReuse, true);

  // 逐 delta 调用也只攒在本地
  client.sendText("今天");
  client.sendText("天气怎么样");
  assert.equal(sent.length, 0, "oneshot 模式下 sendText 不应发包");

  const flushed = client.flush();
  const out = frames();
  assert.equal(out.length, 1, "整段只发一帧");
  assert.equal(out[0].messageType, MSG_FULL_CLIENT_REQUEST);
  assert.equal(out[0].event, undefined, "合成阶段不带 event");
  assert.equal(out[0].flags, 0);
  assert.equal(out[0].payload.req_params.text, "今天天气怎么样");
  assert.equal(out[0].payload.req_params.speaker, "zh_female_vv_uranus_bigtts");
  assert.ok(typeof out[0].payload.user.uid === "string");

  sendEvent(client, EVENT.TTSSentenceStart);
  sendAudio(client, [9, 9]);
  sendEvent(client, EVENT.TTSSentenceEnd);
  sendEvent(client, EVENT.SessionFinished);
  await flushed;

  assert.deepEqual(
    chunks.map((c) => ({ bytes: [...c.audio], isFinal: c.isFinal, id: c.id })),
    [{ bytes: [9, 9], isFinal: true, id: "s1" }],
  );

  // 连接复用：第二轮同样只需一帧
  client.sendText("第二句");
  const second = client.flush();
  assert.equal(frames().length, 2);
  assert.equal(frames()[1].payload.req_params.text, "第二句");
  sendEvent(client, EVENT.TTSSentenceStart);
  sendAudio(client, [8]);
  sendEvent(client, EVENT.TTSSentenceEnd);
  sendEvent(client, EVENT.SessionFinished);
  await second;
});

test("火山 TTS：统一选项 speed / volume 换算成 speech_rate / loudness_rate", async () => {
  const client = new VolcengineTTSClient({
    provider: "volcengine",
    apiKey: "test-key",
    options: { voice: "v", speed: 1.5, volume: 75 },
  });
  const { frames } = attachFakeSocket(client);
  client.sendText("x");
  client.flush();
  sendEvent(client, EVENT.ConnectionStarted);
  const params = frames()[0].payload.req_params.audio_params;
  assert.equal(params.speech_rate, 50); // (1.5 - 1) * 100
  assert.equal(params.loudness_rate, 50); // (75 - 50) * 2
});

test("火山 TTS：SessionFailed 会释放 flush()，权限类文案归类为鉴权错误", async () => {
  const client = makeClient();
  attachFakeSocket(client);
  const errors: Error[] = [];
  client.on("error", (e) => errors.push(e));

  client.sendText("你好");
  const flushed = client.flush();
  sendEvent(client, EVENT.ConnectionStarted);
  sendEvent(client, EVENT.SessionFailed, { code: 1, message: "internal error" });
  await flushed; // 失败也必须唤醒，否则调用方永久悬挂

  assert.equal(errors.length, 1);
  assert.equal(errors[0].name, "TTSProtocolError");

  const client2 = makeClient();
  attachFakeSocket(client2);
  const errors2: Error[] = [];
  client2.on("error", (e) => errors2.push(e));
  client2.sendText("你好");
  const flushed2 = client2.flush();
  sendEvent(client2, EVENT.ConnectionStarted);
  (client2 as any).onMessage(
    encodeFrame({
      messageType: MSG_FULL_SERVER_RESPONSE,
      event: EVENT.SessionFailed,
      payload: Buffer.from('{"error":"resource not granted"}', "utf-8"),
    }),
    true,
  );
  await flushed2;
  assert.equal(errors2[0].name, "TTSAuthError");
});

test("火山 TTS：缺少 voice 时 connect() 明确报错", async () => {
  const client = new VolcengineTTSClient({ provider: "volcengine", apiKey: "test-key" });
  await assert.rejects(() => client.connect(), /voice/);
});
