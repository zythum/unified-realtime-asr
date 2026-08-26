import { test } from "node:test";
import assert from "node:assert/strict";
import { createASRClient } from "../src/index.js";

test("factory creates each supported provider", () => {
  const configs = [
    { provider: "openai", apiKey: "test-key" },
    { provider: "dashscope", apiKey: "test-key" },
    { provider: "volcengine", apiKey: "test-key" },
    { provider: "iflytek", appId: "test-app", apiKey: "test-key", apiSecret: "test-secret" },
  ] as const;

  for (const config of configs) {
    const client = createASRClient(config);
    assert.equal(client.provider, config.provider);
  }
});

test("factory forwards the OpenAI custom URL", () => {
  const url = "ws://localhost:12345/openai";
  const client = createASRClient({ provider: "openai", apiKey: "test-key", url });

  assert.equal((client as any).url, url);
});
