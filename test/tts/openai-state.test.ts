import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAITTSClient } from "../../src/tts/adapters/openai.js";
import type { TTSChunk } from "../../src/tts/types.js";

/**
 * 状态机单测：注入假 `fetch`（真实 `Response` + `ReadableStream`），全程不触网。
 * 这家是唯一的纯 HTTP 形态，重点验证**基类降级路径**（sendText 只缓冲、flush 才发请求）。
 */

/** 用 ReadableStream 造一个会分片返回的响应体。 */
function streamResponse(chunks: number[][], init: ResponseInit = { status: 200 }): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(new Uint8Array(c));
        controller.close();
      },
    }),
    init,
  );
}

interface Captured {
  url: string;
  body: any;
  headers: Record<string, string>;
}

function attachFakeFetch(client: OpenAITTSClient, res: Response | (() => Promise<Response>)) {
  const calls: Captured[] = [];
  (client as any).fetchImpl = async (url: string, init: any) => {
    calls.push({
      url,
      body: JSON.parse(init.body),
      headers: init.headers as Record<string, string>,
    });
    return typeof res === "function" ? res() : res;
  };
  (client as any).connected = true;
  return calls;
}

function makeClient(extra: Record<string, unknown> = {}): OpenAITTSClient {
  return new OpenAITTSClient({
    provider: "openai",
    apiKey: "test-key",
    options: { voice: "coral", ...extra },
  });
}

test("OpenAI TTS：sendText 只入缓冲，flush 才发一次请求（基类降级路径）", async () => {
  const client = makeClient();
  const calls = attachFakeFetch(
    client,
    streamResponse([
      [1, 2],
      [3, 4],
    ]),
  );
  const chunks: TTSChunk[] = [];
  client.on("audio", (c) => chunks.push(c));

  assert.equal(client.capabilities.incrementalText, false);
  assert.equal(client.capabilities.transport, "http");
  assert.equal(client.capabilities.sessionReuse, false);

  client.sendText("今天");
  client.sendText("天气怎么样");
  assert.equal(calls.length, 0, "非增量端点：sendText 不应发请求");

  await client.flush();
  assert.equal(calls.length, 1, "整段只发一次请求");
  assert.equal(calls[0].url, "https://api.openai.com/v1/audio/speech");
  assert.equal(calls[0].headers.Authorization, "Bearer test-key");
  assert.deepEqual(calls[0].body, {
    model: "gpt-4o-mini-tts",
    input: "今天天气怎么样",
    voice: "coral",
    response_format: "pcm",
  });

  // 压一帧回看：末片才标 isFinal
  assert.deepEqual(
    chunks.map((c) => ({ bytes: [...c.audio], isFinal: c.isFinal, id: c.id, index: c.index })),
    [
      { bytes: [1, 2], isFinal: false, id: "r1", index: 1 },
      { bytes: [3, 4], isFinal: true, id: "r1", index: 1 },
    ],
  );
  assert.equal(chunks[0].format, "pcm");
  assert.equal(chunks[0].sampleRate, 24000);
  assert.equal(chunks[0].channels, 1);
});

test("OpenAI TTS：空缓冲的 flush 不发请求；两轮各自一次请求", async () => {
  const client = makeClient();
  const calls = attachFakeFetch(client, () => Promise.resolve(streamResponse([[9]])));

  await client.flush(); // 没有文本 → 直接完成
  assert.equal(calls.length, 0);

  client.sendText("第一句");
  await client.flush();
  client.sendText("第二句");
  await client.flush();
  assert.equal(calls.length, 2, "HTTP 下每个 flush 一次请求");
  assert.deepEqual(
    calls.map((c) => c.body.input),
    ["第一句", "第二句"],
  );
});

test("OpenAI TTS：speed / instructions / 容器格式按文档映射", async () => {
  const client = makeClient({ speed: 1.5, instructions: "Speak cheerfully", format: "mp3" });
  const calls = attachFakeFetch(client, streamResponse([[1]]));
  client.sendText("hi");
  await client.flush();

  assert.equal(calls[0].body.speed, 1.5);
  assert.equal(calls[0].body.instructions, "Speak cheerfully");
  assert.equal(calls[0].body.response_format, "mp3");
});

test("OpenAI TTS：401 归类为鉴权错误、400 为协议错误，都释放 flush()", async () => {
  const unauthorized = makeClient();
  attachFakeFetch(unauthorized, new Response("invalid api key", { status: 401 }));
  const errors: Error[] = [];
  unauthorized.on("error", (e) => errors.push(e));
  unauthorized.sendText("hi");
  await assert.rejects(() => unauthorized.flush(), /HTTP 401/);
  assert.equal((errors[0] as any)?.name, undefined, "reject 由 flush 抛出，不重复走 error 事件");

  const bad = makeClient();
  attachFakeFetch(bad, new Response('{"error":"unsupported voice"}', { status: 400 }));
  bad.sendText("hi");
  await assert.rejects(
    () => bad.flush(),
    (err: Error) => {
      assert.equal(err.name, "TTSProtocolError");
      assert.match(err.message, /unsupported voice/);
      return true;
    },
  );
});

test("OpenAI TTS：close() 会中止在途请求", async () => {
  const client = makeClient();
  let aborted = false;
  (client as any).connected = true;
  (client as any).fetchImpl = (_url: string, init: any) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("Aborted", "AbortError"));
      });
    });

  client.sendText("很长的一段话");
  const flushed = client.flush();
  await new Promise((r) => setTimeout(r, 10)); // 让请求进入在途状态
  await client.close();

  assert.equal(aborted, true, "close() 应中止在途请求");
  await assert.rejects(() => flushed, /已.*中止|中止/);
});

test("OpenAI TTS：缺少 voice 时 connect() 明确报错（且不产生网络调用）", async () => {
  const client = new OpenAITTSClient({ provider: "openai", apiKey: "k" });
  await assert.rejects(() => client.connect(), /voice/);
});
