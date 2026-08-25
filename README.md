# unified-realtime-asr

统一、provider 无关的实时语音识别（ASR）客户端：一个 API，多个后端。

面向中文云厂商（阿里百炼 / DashScope、火山引擎 / Volcengine）与 OpenAI-Realtime 风格的实时听写接口。把各家不同的私有协议、WebSocket 帧格式、事件模型全部隐藏在适配器后面，调用方只看到一套统一的接口。

## 特性

- **一个入口 `createASRClient(config)`**：用配置对象切换后端，业务代码零改动。
- **统一事件模型**：只有 `open` / `transcript` / `error` / `close` 四个事件；`transcript` 用 `t.isFinal` 区分中间稿与定稿，没有冗余的 partial/final 别名。
- **统一音频输入**：`sendAudio()` 接受 `Buffer` / `Int16Array` / `Float32Array` / `number[]`，内部统一转成 16-bit little-endian PCM。
- **说话人分离（Speaker Diarization）**：Volcengine 实时流支持，开启后每条 `transcript` 带 `speaker` 标签（见下文）。
- **自动重连**：可选 `autoReconnect`，异常断开后按指数退避重连。

## 安装

```bash
npm install unified-realtime-asr
```

依赖：`ws`。开发依赖：`typescript`、`tsx`、`@types/node`、`oxlint`、`oxfmt`。

> 本项目为纯 ESM（`"type": "module"`），且 `moduleResolution` 使用 `NodeNext`，引用时使用 `.js` 扩展名（见下方示例）。

## 快速开始

```ts
import { createASRClient } from "unified-realtime-asr";

const client = createASRClient({
  provider: "volcengine",
  apiKey: process.env.VOLC_API_KEY!,
});

client.on("open", () => console.log("connected"));
client.on("transcript", (t) => {
  // t.isFinal === false => 中间稿（partial），可能被后续音频修正
  // t.isFinal === true  => 定稿（final），确定不再改
  console.log(t.isFinal ? `[final]   ${t.text}` : `[partial] ${t.text}`);
});
client.on("error", (e) => console.error(e.message));
client.on("close", (i) => console.log("closed", i));

await client.connect();

// 喂 16k/16-bit/mono 的原始 PCM（Buffer / Int16Array / Float32Array / number[]）
const pcm: Buffer = /* 来自麦克风或文件 */ readFileSync("voice.pcm");
for (const chunk of chunked(pcm, 640)) {
  client.sendAudio(chunk); // 每片约 20ms
  await sleep(20);
}

await client.close();
```

## 支持的后端

| `provider`         | 服务                                            | 协议                         |
| ------------------ | ----------------------------------------------- | ---------------------------- |
| `volcengine`       | 火山引擎 豆包流式语音识别（2.0 小时版默认）      | 私有二进制帧协议            |
| `dashscope`        | 阿里百炼 / 通义 Fun-ASR（Paraformer 实时 v2）    | 私有 WebSocket（裸 PCM 帧） |
| `openai-realtime`  | OpenAI Realtime transcription_sessions          | OpenAI-Realtime（base64 JSON）|

### 配置

```ts
// Volcengine
createASRClient({
  provider: "volcengine",
  apiKey: "...",                       // 新版控制台 API Key（X-Api-Key）
  resourceId: "volc.seedasr.sauc.duration", // 可选，决定模型版本/计费
  appId: "...",                       // 可选
  options: { speakerDiarization: true },
});

// DashScope（百炼）
createASRClient({
  provider: "dashscope",
  apiKey: "sk-...",                    // DashScope API Key
  model: "paraformer-realtime-v2",     // 可选，默认即此
  workspaceId: "...",                 // 可选，业务空间专属域名
  region: "cn-beijing",               // 可选，配合 workspaceId
  workspace: "...",                   // 可选，X-DashScope-WorkSpace
});

// OpenAI Realtime
createASRClient({
  provider: "openai-realtime",
  apiKey: "sk-...",
  options: { transcriptionModel: "gpt-4o-transcribe" }, // 可选
});
```

### 通用选项 `RealtimeASROptions`

传给 `options` 字段，对所有后端生效（不被某后端支持的会被忽略）：

| 选项                  | 默认       | 说明                                              |
| --------------------- | ---------- | ------------------------------------------------- |
| `language`            | `"zh-CN"`  | BCP-47 语言码，或 `"auto"`                         |
| `sampleRate`          | `16000`    | 输入采样率（Hz）                                   |
| `channels`            | `1`        | 声道数（几乎都是单声道）                          |
| `format`              | `"pcm"`    | 输入编码：`pcm` / `opus` / `g711a` / `g711u` / `wav` |
| `interimResults`      | `true`     | 是否请求中间稿                                    |
| `punctuation`         | `true`     | 自动标点                                          |
| `enableConfusion`     | `true`     | 逆文本归一化（数字/日期 → 数字）                  |
| `vad`                 | —          | 基于 VAD 的断句（视后端支持）                     |
| `transcriptionModel`  | —          | 转录模型 id（OpenAI-Realtime 风格后端）           |
| `autoReconnect`       | `false`    | 异常断开自动重连                                  |
| `maxReconnectAttempts`| `5`        | 最大重连次数                                      |
| `speakerDiarization`  | `false`    | 说话人分离，开启后 `transcript.speaker` 带标签    |
| `extra`               | —          | 各厂商私有参数透传（passthrough）                 |

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

## 音频输入约定

- 默认期望 **16kHz / 16-bit / 单声道** 的原始 PCM（little-endian）。
- `sendAudio()` 接受多种类型，内部统一转换为 `Int16Array` → little-endian PCM。
- 若输入是 `.wav`，可先用 `stripWavHeader()`（见 `src/utils/wav.ts`）去掉容器头再喂入，或直接传入 `format: "wav"`（视后端支持）。
- 建议每片 20ms（16k 单声道下为 640 字节），与采集节奏匹配。

## 事件与类型

```ts
interface Transcript {
  text: string;
  isFinal: boolean;        // false=中间稿, true=定稿
  index?: number;           // 句/段序号（视后端提供）
  startTime?: number;       // 起始偏移（ms）
  endTime?: number;         // 结束偏移（ms）
  language?: string;        // BCP-47
  speaker?: string;         // 说话人标签（开启 diarization 时）
  raw?: unknown;            // 原始厂商 payload，便于调试
}

interface ASREvents {
  open: () => void;
  transcript: (t: Transcript) => void;
  error: (err: ASRError) => void;
  close: (info?: { code?: number; reason?: string }) => void;
}
```

主要导出：`createASRClient`（默认导出同名）、`RealtimeASRClient`、`ASRConfig`、各适配器类（`OpenAIRealtimeASRClient` / `DashScopeRealtimeASRClient` / `VolcengineASRClient`）、错误类型（`ASRError` / `ASRConnectionError` / `ASRAuthError` / `ASRProtocolError`）。

## 项目脚本

```bash
npm run build       # tsc 编译到 dist/（tsconfig.build.json，仅 src）
npm run typecheck   # tsc --noEmit 类型检查
npm run dev         # tsx examples/basic.ts 跑示例（需配置环境变量）
npm run lint        # oxlint
npm run format      # oxfmt 格式化
npm run test        # tsx --test test/*.test.ts
npm run gen:voice   # 用 macOS say + ffmpeg 生成测试用 PCM 语音（scripts/gen-sample-voice.ts）
npm run strip:wav   # 去掉 .wav 容器头得到原始 PCM（scripts/strip-wav.ts）
```

### 环境变量（示例）

参考 `.env.example`，复制到 `.env.local`（已 gitignore）后填值：

```bash
ASR_PROVIDER=dashscope        # dashscope | volcengine | openai-realtime
DASHSCOPE_API_KEY=sk-xxx
DASHSCOPE_MODEL=
DASHSCOPE_WORKSPACE_ID=
VOLC_API_KEY=xxx
VOLC_RESOURCE_ID=volc.seedasr.sauc.duration
OPENAI_API_KEY=sk-xxx
ASR_PCM_FILE=examples/sample-voice.wav   # 可选，推流文件（wav 自动去头）
```

```bash
ASR_PROVIDER=volcengine VOLC_API_KEY=xxx ASR_PCM_FILE=fixtures/sample-voice.pcm npm run dev
```

## 设计说明

- **协议与引擎解耦**：各厂商的差异全部收敛在 `adapters/` 下的独立子类里，公共生命周期（连接、推音频、事件扇出、重连）由 `BaseRealtimeASRClient` 负责。调用方只依赖统一接口，新增后端只需新增一个适配器。
- **"一个 transcript 事件"**：为避免 `partial`/`final` 双别名带来的冗余与歧义，所有适配器只通过 `t.isFinal` 分流，调用方按需处理中间稿与定稿。
- **结束/排空交由调用方**：适配器只负责"连、推、转发"，发完音频后的排空窗口与补打 final 由调用方编排（见 `examples/basic.ts` 的 `drainWait`），避免把各厂商的收尾差异塞进适配器。
