import { test } from "node:test";
import assert from "node:assert/strict";
import { IFlytekTTSClient, buildIFlytekTTSAuthUrl } from "../../src/tts/adapters/iflytek.js";
import type { TTSChunk } from "../../src/tts/types.js";

/** 状态机单测：注入假 WebSocket，全程不触网。 */

function attachFakeSocket(client: IFlytekTTSClient) {
  const sent: any[] = [];
  (client as any).ws = {
    readyState: 1,
    send: (data: string) => sent.push(JSON.parse(String(data))),
    close: () => {},
    once: (event: string, cb: () => void) => {
      if (event === "close") cb();
    },
  };
  (client as any).connected = true;
  (client as any).ready = true; // 真实流程由 ws open 驱动，单测直接置位
  return {
    sent,
    /** 解出每帧的关键字段，便于断言。 */
    frames: () =>
      sent.map((f) => ({
        headerStatus: f.header.status,
        textStatus: f.payload.text.status,
        seq: f.payload.text.seq,
        text: Buffer.from(f.payload.text.text, "base64").toString("utf-8"),
      })),
  };
}

function makeClient(extra: Record<string, unknown> = {}): IFlytekTTSClient {
  return new IFlytekTTSClient({
    provider: "iflytek",
    appId: "test-app",
    apiKey: "test-key",
    apiSecret: "test-secret",
    options: { voice: "x5_lingxiaoxuan_flow", ...extra },
  });
}

/** 服务端下发一帧音频（base64）。 */
const sendAudio = (client: IFlytekTTSClient, bytes: number[], status = 1) =>
  (client as any).onMessage(
    JSON.stringify({
      header: { code: 0, status },
      payload: {
        audio: {
          encoding: "raw",
          sample_rate: 24000,
          channels: 1,
          bit_depth: 16,
          status,
          seq: 1,
          audio: Buffer.from(bytes).toString("base64"),
        },
      },
    }),
  );

test("讯飞 TTS：增量文本用 status 0/1 下发，flush 用「空文本 + status=2」收尾", async () => {
  const client = makeClient();
  const { frames } = attachFakeSocket(client);
  const chunks: TTSChunk[] = [];
  client.on("audio", (c) => chunks.push(c));

  client.sendText("今天天气怎么样，");
  client.sendText("我们出去走一走吧");
  assert.deepEqual(frames(), [
    { headerStatus: 0, textStatus: 0, seq: 0, text: "今天天气怎么样，" },
    { headerStatus: 1, textStatus: 1, seq: 1, text: "我们出去走一走吧" },
  ]);

  const flushed = client.flush();
  assert.deepEqual(frames()[2], { headerStatus: 2, textStatus: 2, seq: 2, text: "" });

  // 服务端：两帧音频（status=1）+ 一帧空音频结束标记（status=2）
  sendAudio(client, [1, 2, 3]);
  sendAudio(client, [4, 5]);
  assert.deepEqual(
    chunks.map((c) => ({ bytes: [...c.audio], isFinal: c.isFinal, id: c.id, index: c.index })),
    [{ bytes: [1, 2, 3], isFinal: false, id: "r1", index: 1 }],
    "压住最后一帧，等到结束标记才标 isFinal",
  );

  (client as any).onMessage(
    JSON.stringify({
      header: { code: 0, status: 2 },
      payload: { audio: { status: 2, audio: "" } },
    }),
  );
  await flushed;

  const last = chunks[chunks.length - 1];
  assert.deepEqual(
    { bytes: [...last.audio], isFinal: last.isFinal, id: last.id },
    { bytes: [4, 5], isFinal: true, id: "r1" },
  );
  assert.equal(last.format, "pcm");
  assert.equal(last.sampleRate, 24000);
  assert.equal(last.channels, 1);

  // 收尾后连接被判为不可复用（实测 26016），能力位如实上报
  assert.equal((client as any).spent, true);
  assert.equal(client.capabilities.sessionReuse, false);
});

test("讯飞 TTS：text 必须 base64、编码映射为 raw、倍率换算为 0-100", async () => {
  const client = makeClient({ speed: 1.5, pitch: 0.5, volume: 75 });
  const { sent } = attachFakeSocket(client);
  client.sendText("你好");
  const frame = sent[0];
  assert.equal(frame.payload.text.text, Buffer.from("你好", "utf-8").toString("base64"));
  assert.equal(frame.parameter.tts.audio.encoding, "raw"); // 统一 pcm → 讯飞 raw
  assert.equal(frame.parameter.tts.speed, 75); // 1.5 × 50
  assert.equal(frame.parameter.tts.pitch, 25); // 0.5 × 50
  assert.equal(frame.parameter.tts.volume, 75); // 口径一致，直接透传
  assert.equal(frame.header.app_id, "test-app");
});

test("讯飞 TTS：11200（发音人/额度未授权）归类为鉴权错误，并释放 flush()", async () => {
  const client = makeClient();
  attachFakeSocket(client);
  const errors: Error[] = [];
  client.on("error", (e) => errors.push(e));

  client.sendText("你好");
  const flushed = client.flush();
  (client as any).onMessage(
    JSON.stringify({
      header: { code: 11200, message: "LiccCheck failed, unauthenticated, err: licc limit" },
    }),
  );
  await flushed; // 出错也必须唤醒

  assert.equal(errors.length, 1);
  assert.equal(errors[0].name, "TTSAuthError");
});

test("讯飞 TTS：缺少 voice 时 connect() 明确报错（且提示发音人独立授权）", async () => {
  const client = new IFlytekTTSClient({
    provider: "iflytek",
    appId: "a",
    apiKey: "k",
    apiSecret: "s",
  });
  await assert.rejects(() => client.connect(), /voice/);
});

test("讯飞 TTS 鉴权 URL：HMAC-SHA256 签名结构正确", () => {
  const url = buildIFlytekTTSAuthUrl(
    "wss://cbm01.cn-huabei-1.xf-yun.com/v1/private/mcd9m97e6",
    "my-key",
    "my-secret",
    "Thu, 12 Dec 2019 01:57:27 GMT",
  );
  const q = new URL(url).searchParams;
  assert.equal(q.get("host"), "cbm01.cn-huabei-1.xf-yun.com");
  assert.equal(q.get("date"), "Thu, 12 Dec 2019 01:57:27 GMT");

  const auth = Buffer.from(q.get("authorization")!, "base64").toString("utf-8");
  assert.match(
    auth,
    /^api_key="my-key", algorithm="hmac-sha256", headers="host date request-line", signature="[^"]+"$/,
  );
  assert.ok(
    url.includes(new URL("wss://cbm01.cn-huabei-1.xf-yun.com/v1/private/mcd9m97e6").pathname),
    "签名对象应包含请求路径",
  );
});
