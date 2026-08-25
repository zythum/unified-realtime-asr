import { test } from "node:test";
import assert from "node:assert/strict";
import { VolcengineASRClient } from "../src/adapters/volcengine.js";
import type { Transcript } from "../src/types.js";

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
