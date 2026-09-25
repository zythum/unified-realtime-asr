import { test } from "node:test";
import assert from "node:assert/strict";
import { VolcengineASRClient } from "../../src/asr/adapters/volcengine.js";
import type { Transcript } from "../../src/asr/types.js";

function createProbe() {
  const client = new VolcengineASRClient({ provider: "volcengine", apiKey: "test-key" });
  const transcripts: Transcript[] = [];
  client.on("transcript", (transcript) => transcripts.push(transcript));
  const handleResponse = (body: unknown) => (client as any).handleResponse(body);
  const flushPendingFinal = () => (client as any).flushPendingFinal();
  return { transcripts, handleResponse, flushPendingFinal };
}

test("Volcengine carries speaker on partial and does not create a phantom sentence", () => {
  const { transcripts, handleResponse } = createProbe();

  handleResponse({
    result: {
      text: "第一句",
      utterances: [{ text: "第一句", definite: false, speaker: "1" }],
    },
  });
  handleResponse({
    result: {
      text: "第一句",
      utterances: [{ text: "第一句", definite: true, speaker: "1" }],
    },
  });

  assert.deepEqual(
    transcripts.map(({ text, isFinal, id, index, speaker }) => ({
      text,
      isFinal,
      id,
      index,
      speaker,
    })),
    [
      { text: "第一句", isFinal: false, id: "u1", index: 1, speaker: "1" },
      { text: "第一句", isFinal: true, id: "u1", index: 1, speaker: "1" },
    ],
  );
});

test("Volcengine 丢弃重复回包：文本未变化时不重复发 partial，但尾句 final 仍补发", () => {
  const { transcripts, handleResponse, flushPendingFinal } = createProbe();
  // 服务端「每包音频回一包结果」，同一句会被重复下发；这里模拟 今天 x2 + 今天天气 x3。
  const live = (text: string) => ({ result: { text, utterances: [{ text, definite: false }] } });

  handleResponse(live("今天"));
  handleResponse(live("今天"));
  handleResponse(live("今天天气"));
  handleResponse(live("今天天气"));
  handleResponse(live("今天天气"));
  flushPendingFinal();

  assert.deepEqual(
    transcripts.map(({ text, isFinal }) => ({ text, isFinal })),
    [
      { text: "今天", isFinal: false },
      { text: "今天天气", isFinal: false },
      { text: "今天天气", isFinal: true },
    ],
  );
});

test("Volcengine 默认走官方推荐的优化版链路，显式 url 仍可回退旧版", () => {
  const byDefault = new VolcengineASRClient({ provider: "volcengine", apiKey: "test-key" });
  assert.equal((byDefault as any).url, "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async");

  const pinned = new VolcengineASRClient({
    provider: "volcengine",
    apiKey: "test-key",
    url: "wss://example.test/api/v3/sauc/bigmodel",
  });
  assert.equal((pinned as any).url, "wss://example.test/api/v3/sauc/bigmodel");
});

test("Volcengine suppresses a late server final after fallback final", () => {
  const { transcripts, handleResponse, flushPendingFinal } = createProbe();

  handleResponse({
    result: {
      text: "尾句",
      utterances: [{ text: "尾句", definite: false, speaker: "2" }],
    },
  });
  flushPendingFinal();
  handleResponse({
    result: {
      text: "",
      utterances: [{ text: "尾句", definite: true }],
    },
  });

  assert.equal(transcripts.filter((transcript) => transcript.isFinal).length, 1);
  assert.deepEqual(transcripts.at(-1), {
    text: "尾句",
    isFinal: true,
    id: "u1",
    index: 1,
    speaker: "2",
    raw: null,
  });
});
