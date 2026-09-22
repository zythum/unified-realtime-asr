import { test } from "node:test";
import assert from "node:assert/strict";
import { createASRClient, createTTSClient } from "../../src/index.js";

/**
 * 公共入口的契约：两个方向的工厂都只做「配置 → 适配器」的映射，
 * provider 字段原样透传，未知 provider 立即失败。
 */

test("createASRClient creates each supported provider", () => {
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

test("createASRClient forwards the OpenAI custom URL", () => {
  const url = "ws://localhost:12345/openai";
  const client = createASRClient({ provider: "openai", apiKey: "test-key", url });

  assert.equal((client as any).url, url);
});

test("createTTSClient creates each supported provider", () => {
  const configs = [
    { provider: "dashscope", apiKey: "test-key", options: { voice: "test-voice" } },
    { provider: "volcengine", apiKey: "test-key", options: { voice: "test-voice" } },
    {
      provider: "volcengine",
      apiKey: "test-key",
      mode: "oneshot",
      options: { voice: "test-voice" },
    },
  ] as const;

  for (const config of configs) {
    const client = createTTSClient(config);
    assert.equal(client.provider, config.provider);
  }
});

test("createTTSClient: volcengine 的 mode 决定 incrementalText 能力位", () => {
  const voice = { voice: "test-voice" };
  const duplex = createTTSClient({ provider: "volcengine", apiKey: "k", options: voice });
  const oneshot = createTTSClient({
    provider: "volcengine",
    apiKey: "k",
    mode: "oneshot",
    options: voice,
  });

  assert.equal(duplex.capabilities.incrementalText, true);
  assert.equal(oneshot.capabilities.incrementalText, false);
  // 两种模式都支持连接复用（用户代码相同，只是下发方式不同）
  assert.equal(duplex.capabilities.sessionReuse, true);
  assert.equal(oneshot.capabilities.sessionReuse, true);
});

test("createTTSClient rejects an unknown provider", () => {
  // 判别联合已有两家成员；这个 default 分支是「新增 provider 忘记接线」的落点，必须响亮失败。
  assert.throws(() => createTTSClient({ provider: "nope" } as never), /Unknown provider.*nope/);
});
