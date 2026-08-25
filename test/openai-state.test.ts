import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAIASRClient } from "../src/adapters/openai.js";

test("OpenAI maps item_id to a stable id and independent index", () => {
  const client = new OpenAIASRClient({ provider: "openai", apiKey: "test-key" });
  const handle = (message: unknown) => (client as any).handle(message);

  assert.deepEqual(
    handle({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item_alpha",
      delta: "你好",
    }),
    { kind: "partial", text: "你好", id: "item_alpha", index: 1 },
  );
  assert.deepEqual(
    handle({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_alpha",
      transcript: "你好。",
    }),
    { kind: "final", text: "你好。", id: "item_alpha", index: 1 },
  );
  assert.deepEqual(
    handle({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item_beta",
      delta: "天气不错",
    }),
    { kind: "partial", text: "天气不错", id: "item_beta", index: 2 },
  );
});
