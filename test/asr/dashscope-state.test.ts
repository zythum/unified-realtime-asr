import { test } from "node:test";
import assert from "node:assert/strict";
import { DashScopeASRClient } from "../../src/asr/adapters/dashscope.js";
import type { Transcript } from "../../src/asr/types.js";

test("DashScope keeps sentence id/index across partial and final", () => {
  const client = new DashScopeASRClient({
    provider: "dashscope",
    apiKey: "test-key",
  });
  const transcripts: Transcript[] = [];
  client.on("transcript", (transcript) => transcripts.push(transcript));
  const onMessage = (message: unknown) =>
    (client as any).onMessage(Buffer.from(JSON.stringify(message)));

  const result = (text: string, sentenceEnd: boolean) => ({
    header: { event: "result-generated" },
    payload: { output: { sentence: { text, sentence_end: sentenceEnd } } },
  });

  onMessage(result("第一句", false));
  onMessage(result("第一句话", false));
  onMessage(result("第一句话。", true));
  onMessage(result("第二句", false));

  assert.deepEqual(
    transcripts.map(({ text, isFinal, id, index }) => ({ text, isFinal, id, index })),
    [
      { text: "第一句", isFinal: false, id: "s1", index: 1 },
      { text: "第一句话", isFinal: false, id: "s1", index: 1 },
      { text: "第一句话。", isFinal: true, id: "s1", index: 1 },
      { text: "第二句", isFinal: false, id: "s2", index: 2 },
    ],
  );
});
