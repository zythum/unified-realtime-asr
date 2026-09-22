# unified-realtime-asr

[![npm version](https://img.shields.io/npm/v/unified-realtime-asr.svg?style=flat-square&logo=npm&label=npm%20install%20unified-realtime-asr)](https://www.npmjs.com/package/unified-realtime-asr)

统一、provider 无关的实时语音客户端：一个 API，多个后端。

面向中文云厂商（阿里百炼 / DashScope、火山引擎 / Volcengine）与 OpenAI-Realtime 风格的实时接口。把各家不同的私有协议、WebSocket 帧格式、事件模型全部隐藏在适配器后面，调用方只看到一套统一的接口。

本库有两个**并列的镜像方向**，共用同一套凭证字段、连接生命周期与事件语义：

| 方向                    | 入口              | 数据流                          | 唯一业务事件 |
| ----------------------- | ----------------- | ------------------------------- | ------------ |
| **实时语音识别**（ASR） | `createASRClient` | `sendAudio()` → 文本            | `transcript` |
| **实时语音合成**（TTS） | `createTTSClient` | `sendText()` / `flush()` → 音频 | `audio`      |

两侧都用 `isFinal` 划边界：ASR 表示「该句定稿」，TTS 表示「该句音频已完整」。

> 包名沿用 `unified-realtime-asr`（历史原因），能力范围已覆盖 ASR 与 TTS 两个方向。

## 支持矩阵

| `provider`   | 实时语音识别（ASR）                  | 实时语音合成（TTS）              |
| ------------ | ------------------------------------ | -------------------------------- |
| `dashscope`  | ✅ Fun-ASR 实时语音识别              | ✅ CosyVoice / Qwen-Audio-TTS    |
| `volcengine` | ✅ 豆包流式语音识别 2.0              | ✅ 豆包语音合成 `seed-tts-2.0`   |
| `openai`     | ✅ Realtime `transcription_sessions` | ✅ `/v1/audio/speech`（纯 HTTP） |
| `iflytek`    | ✅ 实时语音转写大模型版              | ✅ 超拟人语音合成                |

## 特性

两个方向共用：

- **统一入口**：`createASRClient(config)` / `createTTSClient(config)`，用配置对象切换后端，业务代码零改动。
- **统一事件模型**：只有 4 个事件（`open` / 业务事件 / `error` / `close`），业务事件用 `isFinal` 区分中间态与完成态，没有冗余别名。
- **统一凭证形状**：同名同义的配置字段，多数后端两个方向复用同一把 API Key。
- **统一连接生命周期**：异常断开后的指数退避重连（`autoReconnect`）。
- **统一错误体系**：`SpeechError` 基类 + `ASRError` / `TTSError` 两族细分错误。

实时语音识别（ASR）：

- **统一音频输入**：`sendAudio()` 接受 `Buffer` / `Int16Array` / `Float32Array` / `number[]`，内部统一转成 16-bit little-endian PCM。
- **说话人分离**：Volcengine 实时流支持，开启后每条 `transcript` 带 `speaker` 标签。
- **句级 id 关联**：同一句的 partial 与 final 共享稳定 `id`，配套 1-based 句序号 `index`，便于 UI 原地替换而不是不断追加新行。

实时语音合成（TTS）：

- **逐句 / 整段同一套 API**：`sendText()` + `flush()`，差别只在 `flush()` 的时机。
- **能力位 + 内部降级**：后端不支持增量文本时，`sendText()` 自动退化为本地缓冲，调用方代码无需分支。
- **句级音频分片**：同一句的多片共享 `id` / `index`，最后一片带 `isFinal: true`，便于按句组织播放队列。

## 安装

```bash
npm install unified-realtime-asr
```

要求 Node.js 18 或更高版本。运行时依赖为 `ws`。

> 本项目为纯 ESM（`"type": "module"`），且 `moduleResolution` 使用 `NodeNext`，引用时使用 `.js` 扩展名（见下方示例）。

## 共同约定

两个方向共享的部分，一次说清，后文不再重复。

### 生命周期事件

除各自唯一的业务事件外，两个方向的客户端都发出同样三个事件：

```ts
client.on("open", () => {}); // 连接已建立
client.on("error", (err) => {}); // 统一错误（SpeechError 的子类）
client.on("close", (info) => {}); // 连接关闭，info 为 { code, reason }
```

### 句级 id 与 index

两个方向都按**句**组织结果，并给出同名的两个字段：

| 字段    | 含义                                                                           |
| ------- | ------------------------------------------------------------------------------ |
| `id`    | 句级稳定标识：同一句的所有分片（ASR 的 partial/final、TTS 的多个音频片）共用它 |
| `index` | 1-based 句序号，**由本库统一分配**（不透传厂商的句索引）                       |

各方向的 `id` 取名规则见对应章节（ASR 侧因后端而异）。

### 凭证与配置

- 配置对象都是判别联合（`ASRConfig` / `TTSConfig`），字段名在两个方向间保持一致：`provider` / `apiKey` / `appId` / `apiSecret` / `model` / `workspaceId` 等。
- 多数后端两个方向**复用同一把 Key**（例如 DashScope 的 `sk-...` 同时用于实时识别与实时合成），差异只在 `model` 与方向特有的选项上。
- 连接层通用选项对两个方向同名同义：

| 选项                   | 默认  | 说明                              |
| ---------------------- | ----- | --------------------------------- |
| `autoReconnect`        | false | 异常断开后按指数退避自动重连      |
| `maxReconnectAttempts` | 5     | 最大重连次数                      |
| `extra`                | —     | 各厂商私有参数透传（passthrough） |

### 错误类型

```text
SpeechError
├── ASRError ─── ASRConnectionError / ASRAuthError / ASRProtocolError
└── TTSError ─── TTSConnectionError / TTSAuthError / TTSProtocolError
```

按能力族捕获用 `instanceof ASRError`，统一捕获用 `instanceof SpeechError`。

## 实时语音识别（ASR）

音频进、文本出。

### 快速开始

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

### 支持的后端

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
| `speakerDiarization`   | `false`   | 说话人分离，开启后 `transcript.speaker` 带标签       |
| `autoReconnect`        | `false`   | 异常断开自动重连                                     |
| `maxReconnectAttempts` | `5`       | 最大重连次数                                         |
| `extra`                | —         | 各厂商私有参数透传（passthrough）                    |

### 事件与类型

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

### 音频输入约定

- 默认期望 **16kHz / 16-bit / 单声道** 的原始 PCM（little-endian）。
- `sendAudio()` 接受多种类型，内部统一转换为 `Int16Array` → little-endian PCM。
- 若输入是 `.wav`，请先去掉容器头再喂入，或直接传入 `format: "wav"`（视后端支持）。
- 建议每片 20ms（16k 单声道下为 640 字节），与采集节奏匹配。

### 说话人分离（Speaker Diarization）

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

### 句级 id 关联（partial ↔ final）

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

### 导出

`createASRClient`（默认导出同名）、`RealtimeASRClient`、`ASRConfig`、`Transcript`、`RealtimeASROptions`、各适配器类（`OpenAIASRClient` / `DashScopeASRClient` / `VolcengineASRClient` / `IFlytekASRClient`）、错误类型（`ASRError` / `ASRConnectionError` / `ASRAuthError` / `ASRProtocolError`）。

## 实时语音合成（TTS）

文本进、音频出——ASR 的镜像方向。

### 快速开始

```ts
import { createTTSClient } from "unified-realtime-asr";

const tts = createTTSClient({
  provider: "dashscope",
  apiKey: process.env.DASHSCOPE_API_KEY!, // 与实时识别同一把
  options: { voice: "longanhuan_v3.6", format: "pcm", sampleRate: 24000 },
});

tts.on("open", () => console.log("connected"));
tts.on("audio", (c) => speaker.write(c.audio)); // c.isFinal => 该句音频已完整
tts.on("error", (e) => console.error(e.name, e.message));
tts.on("close", (info) => console.log("closed", info));

await tts.connect();

// 整段合成：一次提交
tts.sendText("床前明月光，疑是地上霜。");
await tts.flush(); // resolve = 本轮音频已全部经 audio 事件送达

// 逐句 / 跟随 LLM 流式输出：同一套 API，只是 flush 的时机不同
for (const delta of llmStream) {
  tts.sendText(delta);
  if (/[。！？]$/.test(delta)) await tts.flush(); // 到句末立刻出声
}
await tts.flush(); // 收尾
await tts.close();
```

### 支持的后端

| `provider`   | 服务                                | 协议                                                             | 增量文本       | 连接复用                             | 文档                                                                                       |
| ------------ | ----------------------------------- | ---------------------------------------------------------------- | -------------- | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `dashscope`  | 阿里百炼 CosyVoice / Qwen-Audio-TTS | 私有 WebSocket（`run-task` → `continue-task`×N → `finish-task`） | ✅             | ✅                                   | [接口文档](https://platform.qianwenai.com/docs/developer-guides/speech/realtime-streaming) |
| `volcengine` | 火山引擎 豆包语音合成大模型         | 私有二进制帧（`duplex` / `oneshot` 两种端点，同一套 envelope）   | 按 `mode` 而定 | ✅                                   | [接口文档](https://www.volcengine.com/docs/6561/1719100)                                   |
| `iflytek`    | 科大讯飞超拟人语音合成              | WebSocket + URL 签名（HMAC-SHA256，与识别的 SHA1 不同）          | ✅             | ❌（一轮一连接，适配器内部自动重连） | [接口文档](https://www.xfyun.cn/doc/spark/super%20smart-tts.html)                          |
| `openai`     | OpenAI `/v1/audio/speech`           | 纯 HTTP（无会话，每个 `flush()` 一次请求）                       | ❌             | —（无连接）                          | [接口文档](https://developers.openai.com/api/docs/guides/text-to-speech)                   |

### 配置

```ts
// 阿里百炼 / DashScope
createTTSClient({
  provider: "dashscope",
  apiKey: "sk-...", // 与实时识别、千问大模型同一把
  model: "qwen-audio-3.0-tts-flash", // 可选，默认即此
  options: { voice: "longanhuan_v3.6" }, // 必填
});

// 火山引擎 / Volcengine（与实时识别同一把 key，只换 resource-id）
createTTSClient({
  provider: "volcengine",
  apiKey: "...", // 新版控制台 API Key（X-Api-Key）
  resourceId: "seed-tts-2.0", // 可选，默认即此（识别侧是 volc.seedasr.sauc.duration）
  mode: "duplex", // 可选：duplex（默认，文本可增量输入）| oneshot（一次性输入整段）
  options: { voice: "zh_female_vv_uranus_bigtts" }, // 必填
});
```

```ts
// OpenAI（HTTP，无会话）
createTTSClient({
  provider: "openai",
  apiKey: "sk-...", // 与实时识别同一把
  model: "gpt-4o-mini-tts", // 可选，默认即此
  options: { voice: "coral" }, // 必填（13 个内置音色，英文优化）
});
```

```ts
// 科大讯飞（超拟人合成）——凭证字段与讯飞实时识别同名，可直接复用环境变量
createTTSClient({
  provider: "iflytek",
  appId: "...",
  apiKey: "...", // APIKey
  apiSecret: "...", // APISecret（HMAC-SHA256 签名，与识别的 SHA1 不同）
  options: { voice: "x5_lingxiaoxuan_flow" }, // 必填
});
```

> 讯飞的**发音人授权与字符量授权是两笔独立授权**：控制台开通了服务不等于某个 `voice` 可用，未授权会返回 `11200 LiccCheck failed`。可用发音人以控制台为准。

`mode` 是**唯一会改变协议**的选项，但不改变调用方式 —— 两种模式都是 `sendText()` + `flush()`：

| `mode`           | 端点                                | 文本投递                                           | `capabilities.incrementalText`  | 适合              |
| ---------------- | ----------------------------------- | -------------------------------------------------- | ------------------------------- | ----------------- |
| `duplex`（默认） | `/api/v3/tts/bidirection`           | `StartSession` → `TaskRequest`×N → `FinishSession` | `true`                          | 对接 LLM 流式输出 |
| `oneshot`        | `/api/v3/tts/unidirectional/stream` | 一帧带全文（少几个控制帧往返）                     | `false`（基类自动改为本地缓冲） | 固定文案          |

火山侧统一选项的换算：`speed`（倍率）→ `speech_rate`（[-50,100]）、`volume`（0-100）→ `loudness_rate`（[-50,100]）为近似线性换算；**无 pitch 参数**，`pitch` 会被忽略；情感等私有参数经 `extra` 透传。

### 通用选项 `RealtimeTTSOptions`

| 选项                                     | 默认          | 说明                                                                                               |
| ---------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------- |
| `voice`                                  | —             | 音色 / 发音人。**各家音色名不通用，本库不猜默认值**，缺失时 `connect()` 会明确报错                 |
| `format`                                 | `"pcm"`       | 输出编码。流式逐片播放建议 `pcm`；wav / mp3 只在首片带文件头，必须按「一个完整文件的分片」追加播放 |
| `sampleRate`                             | 各后端默认    | 输出采样率；适配器会显式下发，保证 `chunk.sampleRate` 始终如实                                     |
| `language`                               | —             | BCP-47 语言提示                                                                                    |
| `speed` / `pitch`                        | 1.0           | **倍率**（1.0 = 原速 / 原调）                                                                      |
| `volume`                                 | —             | 音量，0-100                                                                                        |
| `instructions`                           | —             | 自然语言指令，控制语气 / 情感（provider 支持时生效）                                               |
| `extra`                                  | —             | 厂商私有参数透传（如 `seed`、`enable_ssml`、`word_timestamp_enabled`）                             |
| `autoReconnect` / `maxReconnectAttempts` | `false` / `5` | 与 ASR 侧同名同义                                                                                  |

### 事件与类型

```ts
interface TTSChunk {
  audio: Uint8Array; // 原始字节，本库不做任何转码 / 重采样
  format: TTSAudioFormat; // 'pcm' | 'wav' | 'mp3' | 'opus' | 'aac' | 'flac'
  sampleRate?: number;
  channels?: number;
  isFinal: boolean; // true = 该句音频已完整
  id?: string; // 句级 id：同一句的多片共用
  index?: number; // 1-based 句序号（本库统一分配，跨任务连续）
  text?: string; // 本片对应的文本（provider 给出时）
  words?: TTSWord[]; // 字级时间戳（provider 支持且开启时）
  raw?: unknown; // 原始厂商 payload
}

interface TTSEvents {
  open: () => void;
  audio: (chunk: TTSChunk) => void;
  error: (err: TTSError) => void;
  close: (info?: { code?: number; reason?: string }) => void;
}
```

音频按**句**产出：同一句可能分多片，最后一片带 `isFinal: true`，句内所有片共享 `id` 与 `index`，便于按句组织播放队列（例如「等整句到齐再播」或流式追加播放）。

### 输出音频约定

- 输出字节**原样透出**，本库不做转码、不做重采样、不拼容器头；播放端按 `chunk.format` + `chunk.sampleRate` 解码。
- `pcm` 是逐片可播的（无容器），**流式播放首选**。
- `wav` / `mp3` 这类带容器的格式只在任务首片带文件头，必须当作「一个完整文件的分片」按序追加播放，不能逐片独立解码。

### 逐句与整段

`flush()` 是**合成任务的边界**，不是"发送"：它对应厂商的收尾动作，并在服务端确认后 resolve。因此**逐句与整段是同一套 API 的两种用法**，差别只在 `flush()` 的调用时机：

| 动作             | 含义                                                 | 对应 ASR 侧        |
| ---------------- | ---------------------------------------------------- | ------------------ |
| `sendText(text)` | 追加待合成文本，粒度随意（整段 / 逐句 / 逐 delta）   | `sendAudio(chunk)` |
| `flush()`        | 提交本轮文本并强制合成；resolve = 服务端确认本轮结束 | 无（ASR 是持续流） |
| `close()`        | 关闭连接；未提交的缓冲会被补合成一次，避免丢字       | `close()`          |

适配器负责在同一连接上开启下一轮（是否支持复用见 `capabilities.sessionReuse`），调用方不需要接触 task_id / session 这类厂商概念。

### 能力位 `capabilities`

```ts
tts.capabilities.transport; // 'websocket'（长连接，可复用/重连）| 'http'（一次性请求）
tts.capabilities.incrementalText; // 是否支持增量文本（false 时 sendText 只入本地缓冲）
tts.capabilities.sessionReuse; // flush 后能否在同一连接上继续合成
tts.capabilities.formats; // 支持的输出编码
tts.capabilities.sampleRates; // 支持的采样率
tts.capabilities.instructions; // 是否支持自然语言指令
tts.capabilities.voiceCloning; // 是否支持声音复刻
tts.capabilities.wordTimestamps; // 是否支持字级时间戳
```

能力差异**由适配器内部消化**：例如不支持增量文本的后端，`sendText()` 会自动改为本地缓冲、`flush()` 时一次性提交——调用方代码无需分支。

### 导出

`createTTSClient`、`TTSClient`、`TTSConfig`、`TTSChunk`、`TTSCapabilities`、`RealtimeTTSOptions`、各适配器类（`DashScopeTTSClient` / `VolcengineTTSClient` / `IFlytekTTSClient` / `OpenAITTSClient`）、错误类型（`TTSError` / `TTSConnectionError` / `TTSAuthError` / `TTSProtocolError`）。

## 开发

开发方式、项目脚本和实现说明见 [DEVELOPMENT.md](./DEVELOPMENT.md)。
SProtocolError`）。

## 开发

开发方式、项目脚本和实现说明见 [DEVELOPMENT.md](./DEVELOPMENT.md)。
