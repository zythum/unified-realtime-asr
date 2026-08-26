# unified-realtime-asr

[![npm version](https://img.shields.io/npm/v/unified-realtime-asr.svg?style=flat-square&logo=npm&label=npm%20install%20unified-realtime-asr)](https://www.npmjs.com/package/unified-realtime-asr)

统一、provider 无关的实时语音识别（ASR）客户端：一个 API，多个后端。

面向中文云厂商（阿里百炼 / DashScope、火山引擎 / Volcengine）与 OpenAI-Realtime 风格的实时听写接口。把各家不同的私有协议、WebSocket 帧格式、事件模型全部隐藏在适配器后面，调用方只看到一套统一的接口。

## 特性

- **一个入口 `createASRClient(config)`**：用配置对象切换后端，业务代码零改动。
- **统一事件模型**：只有 `open` / `transcript` / `error` / `close` 四个事件；`transcript` 用 `t.isFinal` 区分中间稿与定稿，没有冗余的 partial/final 别名。
- **统一音频输入**：`sendAudio()` 接受 `Buffer` / `Int16Array` / `Float32Array` / `number[]`，内部统一转成 16-bit little-endian PCM。
- **说话人分离（Speaker Diarization）**：Volcengine 实时流支持，开启后每条 `transcript` 带 `speaker` 标签（见下文）。
- **句级 id 关联**：provider 能提供标识时，每条 `transcript` 带稳定 `id`；同时统一提供 1-based 句序号 `index`。同一句的 partial 与最终 final 共享 `id`，便于 UI 把中间稿原地替换为定稿、按句编号或换行。
- **自动重连**：可选 `autoReconnect`，异常断开后按指数退避重连。

## 安装

```bash
npm install unified-realtime-asr
```

要求 Node.js 18 或更高版本。运行时依赖为 `ws`。

> 本项目为纯 ESM（`"type": "module"`），且 `moduleResolution` 使用 `NodeNext`，引用时使用 `.js` 扩展名（见下方示例）。

## 快速开始

```ts
import { readFileSync } from "node:fs";
import { createASRClient } from "unified-realtime-asr";

const client = createASRClient({
  provider: "volcengine",
  apiKey: process.env.VOLC_API_KEY!,
});

client.on("open", () => console.log("connected"));
client.on("transcript", (t) => {
  // t.isFinal === false => 中间稿（partial），可能被后续音频修正
  // t.isFinal === true  => 定稿（final），确定不再改
  console.log(t.isFinal ? `[final] ${t.text}` : `[partial] ${t.text}`);
});
client.on("error", (error) => console.error(error.message));
client.on("close", (info) => console.log("closed", info));

await client.connect();

// 喂 16k/16-bit/mono 的原始 PCM，每片 640 字节约 20ms
const pcm = readFileSync("voice.pcm");
for (let offset = 0; offset < pcm.length; offset += 640) {
  client.sendAudio(pcm.subarray(offset, offset + 640));
  await new Promise((resolve) => setTimeout(resolve, 20));
}

// 实际应用中应等待最后结果到达后再关闭连接
await client.close();
```

## 支持的后端

| `provider`   | 服务                                                      | 协议                           | 文档                                                                                 |
| ------------ | --------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------ |
| `volcengine` | 火山引擎 豆包流式语音识别（2.0 小时版默认）               | 私有二进制帧协议               | [接口文档](https://docs.volcengine.com/docs/6561/1354869?lang=zh)                    |
| `dashscope`  | 阿里百炼 / 通义 Fun-ASR（默认 fun-asr-flash-8k-realtime） | 私有 WebSocket（裸 PCM 帧）    | [接口文档](https://platform.qianwenai.com/docs/developer-guides/speech/asr-realtime) |
| `openai`     | OpenAI Realtime transcription_sessions                    | OpenAI-Realtime（base64 JSON） | [接口文档](https://platform.openai.com/docs/guides/realtime-transcription)           |
| `iflytek`    | 科大讯飞实时语音转写大模型版                              | WebSocket + URL 签名鉴权       | [接口文档](https://www.xfyun.cn/doc/spark/asr_llm/rtasr_llm.html)                    |

### 配置

```ts
// Volcengine
createASRClient({
  provider: "volcengine",
  apiKey: "...", // 新版控制台 API Key（X-Api-Key）
  resourceId: "volc.seedasr.sauc.duration", // 可选，决定模型版本/计费
  appId: "...", // 可选
  options: { speakerDiarization: true },
});

// DashScope（百炼）
createASRClient({
  provider: "dashscope",
  apiKey: "sk-...", // DashScope API Key
  model: "fun-asr-flash-8k-realtime", // 可选，默认即此
  workspaceId: "...", // 可选，业务空间专属域名
  region: "cn-beijing", // 可选，配合 workspaceId
  workspace: "...", // 可选，X-DashScope-WorkSpace
});

// OpenAI Realtime
createASRClient({
  provider: "openai",
  apiKey: "sk-...",
  options: { transcriptionModel: "gpt-4o-transcribe" }, // 可选
});

// 科大讯飞（实时语音转写大模型版）
createASRClient({
  provider: "iflytek",
  appId: "...", // 讯飞开放平台应用 ID
  apiKey: "...", // accessKeyId
  apiSecret: "...", // accessKeySecret
});
```

### 通用选项 `RealtimeASROptions`

传给 `options` 字段，对所有后端生效（不被某后端支持的会被忽略）：

| 选项                   | 默认      | 说明                                                 |
| ---------------------- | --------- | ---------------------------------------------------- |
| `language`             | `"zh-CN"` | BCP-47 语言码，或 `"auto"`                           |
| `sampleRate`           | `16000`   | 输入采样率（Hz）                                     |
| `channels`             | `1`       | 声道数（几乎都是单声道）                             |
| `format`               | `"pcm"`   | 输入编码：`pcm` / `opus` / `g711a` / `g711u` / `wav` |
| `interimResults`       | `true`    | 是否请求中间稿                                       |
| `punctuation`          | `true`    | 自动标点                                             |
| `enableConfusion`      | `true`    | 逆文本归一化（数字/日期 → 数字）                     |
| `vad`                  | —         | 基于 VAD 的断句（视后端支持）                        |
| `transcriptionModel`   | —         | 转录模型 id（OpenAI-Realtime 风格后端）              |
| `autoReconnect`        | `false`   | 异常断开自动重连                                     |
| `maxReconnectAttempts` | `5`       | 最大重连次数                                         |
| `speakerDiarization`   | `false`   | 说话人分离，开启后 `transcript.speaker` 带标签       |
| `extra`                | —         | 各厂商私有参数透传（passthrough）                    |

## 说话人分离（Speaker Diarization）

仅 **Volcengine** 实时流支持。开启后，每条 `transcript` 会带上 `speaker` 标签（字符串，如 `"1"`、`"2"`）：

```ts
const client = createASRClient({
  provider: "volcengine",
  apiKey: process.env.VOLC_API_KEY!,
  options: { speakerDiarization: true },
});

client.on("transcript", (t) => {
  console.log(`[${t.speaker ?? "?"}] ${t.text}`);
});
```

约束：

- 须在 `language` 为空或 `"zh-CN"` 时生效（本库默认即 `zh-CN`，无需额外配置）。
- 标签反映的是当前累积片段里**最近一个说话人**；在句子/utterance 边界处最有意义（Volcengine 不提供逐词说话人标签）。
- **DashScope 实时流不支持**说话人分离（其文件转写 / 通义听悟支持，但不在本库的实时接口范围内），该选项在 DashScope 下被忽略。

`Transcript` 上的 `speaker` 字段已预留，适配器仅在服务端确实返回标签时才填充，否则为 `undefined`。

## 句级 id 关联（partial ↔ final）

provider 能提供句级标识时，每条 `transcript` 都带一个稳定的 `id`，用于把**同一句**的中间稿（partial）和最终定稿（final）关联起来，方便 UI 把"正在输入"的那一行就地替换为定稿，而不是不断追加新行。同时本库按句统一分配独立的 **`index`（1-based 句序号）**，可直接用作句编号或在 UI 上按句换行。

- **DashScope**：同一句的首条 partial 开一个 `id`（`s1`、`s2` …），该句 final 到达前所有 partial 共用此 `id`，final 后该 id 作废、下一句重新开 `id`；`index` 与之同步递增。
- **OpenAI-Realtime**：`id` 直接复用服务端事件的 `item_id`，`delta`（partial）与 `completed`（final）天然同 `id`；`index` 独立按首次见到的 `item_id` 顺序分配（1、2、3 …）。
- **Volcengine**：`result.text` / `utterances` 里的「活体句」即当前句，直接作为 partial（句级 `id` 为 `u1`、`u2` …，按活体句在 `utterances` 中的序号派生，同一句多次更新共享该 `id`）；`utterances` 中带 `definite` 标记的为已定稿句，直接发 final（复用同一 `id`）；若会话结束时尾句未被服务端定稿，适配器会兜底补发一条 final，因此调用方无需自行组装定稿。

```ts
client.on("transcript", (t) => {
  if (!t.id) return; // 个别后端某些帧不带 id
  const line = getOrCreateLine(t.id); // 按 id 取/建一行
  line.textContent = t.text;
  line.className = t.isFinal ? "final" : "partial";
  if (t.isFinal) freezeLine(t.id); // 定稿后冻结
});
```

## 音频输入约定

- 默认期望 **16kHz / 16-bit / 单声道** 的原始 PCM（little-endian）。
- `sendAudio()` 接受多种类型，内部统一转换为 `Int16Array` → little-endian PCM。
- 若输入是 `.wav`，请先去掉容器头再喂入，或直接传入 `format: "wav"`（视后端支持）。
- 建议每片 20ms（16k 单声道下为 640 字节），与采集节奏匹配。

## 事件与类型

```ts
interface Transcript {
  text: string;
  isFinal: boolean; // false=中间稿, true=定稿
  id?: string; // provider 提供的稳定句级 id：同一句的 partial 与 final 同 id
  index?: number; // 1-based 句/段序号（本库统一分配，与 id 独立）
  startTime?: number; // 起始偏移（ms）
  endTime?: number; // 结束偏移（ms）
  language?: string; // BCP-47
  speaker?: string; // 说话人标签（开启 diarization 时）
  raw?: unknown; // 原始厂商 payload，便于调试
}

interface ASREvents {
  open: () => void;
  transcript: (t: Transcript) => void;
  error: (err: ASRError) => void;
  close: (info?: { code?: number; reason?: string }) => void;
}
```

主要导出：`createASRClient`（默认导出同名）、`RealtimeASRClient`、`ASRConfig`、各适配器类（`OpenAIASRClient` / `DashScopeASRClient` / `VolcengineASRClient` / `IFlytekASRClient`）、错误类型（`ASRError` / `ASRConnectionError` / `ASRAuthError` / `ASRProtocolError`）。

开发方式、项目脚本和实现说明见 [DEVELOPMENT.md](./DEVELOPMENT.md)。
