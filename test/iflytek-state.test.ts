import { test } from "node:test";
import assert from "node:assert/strict";
import { IFlytekASRClient, buildIFlytekAuthUrl } from "../src/adapters/iflytek.js";
import type { Transcript } from "../src/types.js";

test("IFlytek LLM auth URL has correct signature structure", () => {
  const url = buildIFlytekAuthUrl(
    "wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1",
    "testAppId",
    "testAccessKeyId",
    "testSecret",
    "2025-09-04T15:38:07+0800",
    "test-uuid-123",
  );
  assert.ok(url.includes("accessKeyId=testAccessKeyId"));
  assert.ok(url.includes("appId=testAppId"));
  assert.ok(url.includes("uuid=test-uuid-123"));
  assert.ok(url.includes("signature="));
  // 验证参数按 key 升序排列（accessKeyId < appId < audio_encode < lang < samplerate < utc < uuid）
  const queryPart = url.split("?")[1];
  const keys = queryPart.split("&").map((p) => p.split("=")[0]);
  const sigIdx = keys.indexOf("signature");
  const paramKeys = keys.slice(0, sigIdx);
  const sorted = [...paramKeys].sort();
  assert.deepEqual(paramKeys, sorted);
});

test("IFlytek LLM maps result to transcript with id/index", () => {
  const client = new IFlytekASRClient({
    provider: "iflytek",
    appId: "test-app",
    apiKey: "test-key",
    apiSecret: "test-secret",
  });
  const transcripts: Transcript[] = [];
  client.on("transcript", (t) => transcripts.push(t));
  const onMessage = (msg: unknown) => (client as any).onMessage(Buffer.from(JSON.stringify(msg)));

  // 模拟 started（标准版兼容格式）
  onMessage({ action: "started", code: "0", data: "", desc: "success", sid: "rta001" });

  // 模拟大模型版中间结果 (type="1")
  onMessage({
    msg_type: "result",
    res_type: "asr",
    data: {
      seg_id: 0,
      cn: { st: { rt: [{ ws: [{ cw: [{ w: "你好", wp: "n" }] }] }], bg: 820, type: "1", ed: 0 } },
      ls: false,
    },
  });

  // 模拟大模型版最终结果 (type="0")
  onMessage({
    msg_type: "result",
    res_type: "asr",
    data: {
      seg_id: 0,
      cn: {
        st: { rt: [{ ws: [{ cw: [{ w: "你好！", wp: "n" }] }] }], bg: 820, type: "0", ed: 1500 },
      },
      ls: false,
    },
  });

  // 模拟第二句
  onMessage({
    msg_type: "result",
    res_type: "asr",
    data: {
      seg_id: 1,
      cn: { st: { rt: [{ ws: [{ cw: [{ w: "今天", wp: "n" }] }] }], bg: 2000, type: "1", ed: 0 } },
      ls: false,
    },
  });

  assert.deepEqual(
    transcripts.map(({ text, isFinal, id, index }) => ({ text, isFinal, id, index })),
    [
      { text: "你好", isFinal: false, id: "s1", index: 1 },
      { text: "你好！", isFinal: true, id: "s1", index: 1 },
      { text: "今天", isFinal: false, id: "s2", index: 2 },
    ],
  );
});
