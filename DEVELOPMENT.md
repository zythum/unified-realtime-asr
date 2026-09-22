# Development Guide

本文档面向贡献者和需要在本地调试、扩展 `unified-realtime-asr` 的开发者。库的安装、provider 配置和运行时 API 请先阅读 [README.md](./README.md)。

## 开发环境

- Node.js 18 或更高版本
- npm
- 本项目使用纯 ESM、TypeScript `NodeNext` 模块解析
- 运行示例需要至少一个 provider 的 API Key
- `gen:voice` 需要 macOS 的 `say` 和 `ffmpeg`

安装依赖：

```bash
npm install
```

## 常用命令

```bash
npm run clean          # 清空 dist/（build 会自动先跑它）
npm run build          # 先 clean 再编译 src，输出 dist/ 和声明文件
npm run typecheck      # TypeScript 类型检查，不输出文件
npm run test           # 运行 test/*/*.test.ts（按 asr / tts / common 分目录）
npm run lint           # oxlint
npm run format         # oxfmt 格式化
npm run format:check   # 检查格式但不修改文件
```

生成或处理示例音频：

```bash
npm run gen:voice      # 使用 macOS say + ffmpeg 生成测试 PCM 语音
npm run strip:wav      # 去掉 WAV 容器头，生成原始 PCM
```

提交变更前建议至少执行：

```bash
npm run format:check && npm run typecheck && npm run test && npm run build
```

## 本地示例

### Node 示例

复制环境变量模板并填写 provider 密钥：

```bash
cp .env.example .env.local
```

`.env.local` 不会入库（`.gitignore` 的 `.env.*` 覆盖，仅放行 `.env.example`）。

**变量清单以 [`.env.example`](./.env.example) 为准**（按 provider 分组，含每个变量的用途说明），
两个文件保持同一套键名与顺序 —— 增删变量时请两边同步。命名约定：

- **方向专有配置一律带 `_ASR_` / `_TTS_` 中缀**：`DASHSCOPE_ASR_MODEL`、`VOLC_ASR_RESOURCE_ID`、`VOLC_TTS_VOICE`、`IFLYTEK_TTS_VCN`；
- **凭证与地域类两个方向共用同一把 / 同一处**，因此保持裸名、只写一份：`DASHSCOPE_API_KEY`、`VOLC_API_KEY`、`OPENAI_API_KEY`、`IFLYTEK_*`、`DASHSCOPE_WORKSPACE_ID`。
  刻意**不**拆成 `_ASR_` / `_TTS_` 两份 —— 同一把密钥写两处，迟早漂移。

> 这些变量只被 `test/` 与 `examples/` 读取 —— **库本身从不读环境变量**，配置一律由参数传入。
> 集成测试（`test/asr/integration.test.ts`、`test/tts/integration.test.ts`、`test/common/roundtrip.test.ts`）
> 会自行 `dotenv` 载入 `.env.local`，所以**配好之后 `npm test` 不需要在命令行传任何变量**；
> 缺密钥或占位值会跳过并打印原因（例如 `OPENAI_API_KEY` 仍是模板值 `sk-your-key`）。

运行文件推流示例：

```bash
ASR_PROVIDER=volcengine \
VOLC_API_KEY=xxx \
ASR_PCM_FILE=fixtures/sample-voice.pcm \
npm run example:node-basic
```

也可以直接选择其他 provider：

```bash
ASR_PROVIDER=dashscope DASHSCOPE_API_KEY=sk-xxx npm run example:node-basic
ASR_PROVIDER=openai OPENAI_API_KEY=sk-xxx npm run example:node-basic
```

Node 示例的关键流程是：创建客户端、监听统一事件、`connect()`、按实时节奏调用 `sendAudio()`，等待排空窗口后调用 `close()`。环境变量解析和示例编排不属于库的公共 API。

### Web 示例

浏览器不能直接运行本库：本库依赖 Node 的 `ws`，且各 provider 使用服务端私有协议。因此 `examples/web` 通过轻量 Node 服务桥接浏览器和 ASR provider：

1. `public/index.html` 使用 `getUserMedia` 采集麦克风。
2. Web Audio 将音频转换为 16kHz / 16-bit / mono PCM。
3. 浏览器通过 WebSocket 将二进制 PCM 帧发送到 `examples/web/server.ts`。
4. 服务端按客户端选择的 provider 创建 `ASRClient`，并把识别结果转发回浏览器。
5. ASR 连接建立前的音频会先缓冲，连接成功后统一 flush，避免丢失开头音频。

运行：

```bash
cp .env.example .env.local   # 填写各 provider 的密钥
npm run example:web
```

打开 <http://localhost:3000>，选择识别引擎并授权麦克风。密钥只在服务端读取，不会发送到浏览器。前端按 `transcript.id` 原地更新 partial，收到 `isFinal: true` 后冻结该行；Volcengine 开启 `speakerDiarization` 后还会显示说话人标签。

## 项目结构

```text
src/
├── index.ts                 # 公共入口、createASRClient / createTTSClient 和导出
├── core/                    # 只放【方向无关】的东西，不得 import asr/ 或 tts/
│   ├── types.ts             # 共用类型：CloseInfo / RealtimeSessionOptions
│   ├── speech-client.ts     # 传输无关底座：生命周期骨架 + 事件扇出
│   ├── session.ts           # 在上一行之上补「长连接」语义：异常断开 + 指数退避重连
│   ├── reconnect.ts         # 重连策略（组合件，ASR / TTS 的长连接实现共用）
│   ├── errors.ts            # 统一错误类型（SpeechError 基类 + ASR / TTS 两族）
│   └── typed-emitter.ts     # 类型安全的事件发射器
├── asr/                     # 实时识别方向（音频进 → transcript 出）
│   ├── types.ts             # 方向类型：Transcript / ASREvents / 各 ASR provider 配置
│   ├── realtime-asr-client.ts # 方向基类（长连接）：sendAudio / emitTranscript
│   └── adapters/
│       ├── dashscope.ts     # DashScope 实时识别适配器
│       ├── openai.ts        # OpenAI-Realtime 适配器
│       ├── volcengine.ts    # Volcengine 二进制协议适配器
│       └── iflytek.ts       # 讯飞实时语音转写大模型版适配器
├── tts/                     # 实时合成方向（文本进 → audio 出）
│   ├── types.ts             # 方向类型：TTSChunk / TTSEvents / 能力位 / 各 TTS provider 配置
│   ├── tts-client.ts        # 方向基类（**传输无关**）：sendText / flush / 能力降级 / emitAudio
│   ├── realtime-tts-client.ts # 长连接传输：+ 异常断开重连（现有 3 家）
│   ├── http-tts-client.ts   # 一次性请求传输：+ 中止在途请求（OpenAI）
│   └── adapters/
│       ├── dashscope.ts     # DashScope 实时合成适配器
│       ├── volcengine.ts    # 火山豆包语音合成（duplex / oneshot 两种模式）
│       ├── iflytek.ts       # 讯飞超拟人合成（一轮一连接，适配器内部自动重连）
│       └── openai.ts        # OpenAI /v1/audio/speech（纯 HTTP，无会话）
└── utils/
    ├── audio.ts             # 音频归一化（→ 16-bit LE PCM，目前仅 ASR 侧使用）
    ├── volc-frames.ts       # 火山二进制帧编解码（ASR / TTS 共用同一套 envelope）
    └── wav.ts               # WAV 头处理（开发 / 示例用，库运行时不依赖）

examples/
├── node/basic.ts            # 文件推流 Node 示例
└── web/                     # 浏览器麦克风桥接示例

test/                        # 单元测试和集成测试（与 src/ 同构，方向分目录）
├── asr/
│   ├── *-state.test.ts      # 各 provider 的状态机单测（注入假连接，不触网）
│   └── integration.test.ts  # 真实服务端到端（缺密钥时 skip）
├── tts/
│   ├── dashscope-state.test.ts
│   ├── iflytek-state.test.ts
│   ├── openai-state.test.ts
│   ├── volcengine-state.test.ts
│   └── integration.test.ts  # 两个 provider 的端到端 + 采样率真实性
└── common/
    ├── factory.test.ts      # 公共入口（createASRClient / createTTSClient）的契约
    └── roundtrip.test.ts    # 跨方向交叉验证：TTS 合成 → 喂给 ASR → 比对文本
scripts/                     # 测试音频生成、WAV 处理脚本
fixtures/                    # 示例音频
```

## 架构与扩展方式

### 架构约束由测试守住

`test/common/architecture.test.ts` 把几条「容易在重构中悄悄退化」的约定变成 CI 保证：

- `core/` 不得 import `asr/` 或 `tts/`（方向无关层）；
- 两个方向互不依赖；
- 两个方向结构对称（各自有 `types.ts` / 方向基类 / `adapters/`），`test/` 与 `src/` 同构；
- 类型按方向拆分且 `src/index.ts` 完整汇聚三个 types 模块（**公开导出面的回归防线**：拆类型时最容易漏 re-export，而 `tsc` 不会报）。

判定只做**路径级**检查（import 说明符），不扫类型名 —— 后者会被注释误伤（`core/types.ts` 的注释里就写着 `Transcript`）。

### 构建产物必须与源码一一对应

`npm run build` 会先执行 `npm run clean`（`scripts/clean-dist.ts`）。原因是 `tsc` **只增不减**：移动或重命名 `src/` 下的文件后，旧路径的产物会留在 `dist/` 里，而 `package.json` 的 `files` 包含 `dist`，于是陈旧文件会被一起发布（本仓库真实发生过）。直接跑 `tsc -p tsconfig.build.json` 会跳过清理，别用。

### 分层：方向 → 传输 → provider

继承方向必须是「**方向在上、传输在下**」，否则纯 HTTP 的 provider 会被迫继承长连接的那套东西（没有连接可断、`autoReconnect` 变成空话）：

```
TypedEmitter
└─ BaseSpeechClient            传输无关：options / connected / connect / close / emitOpen / emitError / emitClose
   ├─ BaseRealtimeSession       + 异常断开与指数退避重连（ReconnectController）
   │    └─ BaseRealtimeASRClient        ← ASR 目前全是长连接
   └─ BaseTTSClient            合成方向逻辑：sendText / flush / 缓冲降级 / capabilities
        ├─ BaseRealtimeTTSClient        + 重连        ← dashscope / volcengine / iflytek
        └─ BaseHttpTTSClient            + 中止在途请求 ← openai（无连接，connect() 只置就绪）
```

重连策略做成**组合件**（`core/reconnect.ts`）而不是基类：它要同时服务 ASR 与 TTS 的长连接实现，塞进继承链会造成"重连逻辑只能有一个父类"的死结。HTTP 传输不接这个件。

传输差异对调用方透明，但可用 `capabilities.transport`（`websocket` / `http`）如实查询。

方向由两个子类补齐，二者是镜像关系：

|          | `BaseRealtimeASRClient`                       | `BaseRealtimeTTSClient`                                    |
| -------- | --------------------------------------------- | ---------------------------------------------------------- |
| 数据入口 | `sendAudio(chunk)`                            | `sendText(text)` + `flush()`                               |
| 业务事件 | `transcript`（`isFinal` = 该句定稿）          | `audio`（`isFinal` = 该句音频完整）                        |
| 句级关联 | `id` / `index`                                | `id` / `index`（同语义）                                   |
| 协议钩子 | `connectImpl` / `sendAudioImpl` / `closeImpl` | `connectImpl` / `sendTextImpl` / `flushImpl` / `closeImpl` |

新增 provider 时只实现协议钩子，不要把厂商判断写进公共客户端或示例代码。

**目录结构与方向一一对应**：每个方向是一个自洽的子树（`asr/types.ts` + `asr/asr-client.ts` + `asr/adapters/`，`tts/` 同构），方向的类型、基类与适配器放在一起；`core/` 只保留方向无关的设施。`test/` 与 `src/` 同构（`test/asr/`、`test/tts/`、`test/common/`）。

**类型也按方向拆**：`core/types.ts`（共用）＋ `asr/types.ts` ＋ `tts/types.ts`，三份互相不重名，`src/index.ts` 用三条 `export *` 汇聚到包根，因此**对使用者的导出面与拆分前完全一致**。新增方向类型时放进对应方向的 `types.ts`；只有在两个方向都要用、且不含方向语义的类型（如连接层选项）才进 `core/types.ts`。拆分的收益是可验证的：`core/` 现在连类型依赖都指向自己，删掉 `asr/` 就能干净地删掉整个方向。

> ⚠️ 测试脚本是 `tsx --test test/*/*.test.ts`：**恰好一层子目录**。若新增更深的目录（如 `test/asr/unit/`），必须同步改这个 glob —— sh 不会递归，旧 glob 会**静默地一个测试都不跑**。

判断一个文件该放哪，用这一条规则即可：**`core/` 下的任何文件都不许 import `asr/` 或 `tts/`**。只要它出现了 `Transcript` / `TTSChunk` / `ASREvents` / `TTSEvents` 这类方向类型，它就不属于 `core/`。新增文件时请落在对应方向目录下，不要退回单一 `adapters/` 平铺。

### TTS 方向的约定

- **`flush()` 是合成任务的边界**，不是「发送」：它对应厂商的 `finish-task` / `FinishSession` / `response.create` 等收尾动作，并在服务端确认（`task-finished` 一类事件）后 resolve。之后若还有文本进来，**适配器负责在同一连接上开启新一轮**（`capabilities.sessionReuse`），调用方永远不需要接触 task_id / session。
- **能力差异必须在适配器内部降级**，靠 `capabilities` 暴露给调用方做可选分支。典型例子：`incrementalText: false` 的后端，基类会把 `sendText()` 收到的文本攒进本地缓冲、`flush()` 时一次性提交（见 `BaseRealtimeTTSClient`），调用方代码不变。
- **`isFinal` 按句给**：厂商的「句子结束」与「音频帧」是两个独立事件（帧先到、句尾后到），因此适配器需要**压住一帧再发**，等下一帧或句尾事件到达时才能判定前一帧是否为该句最后一片。DashScope 适配器的 `heldChunk` 就是这一机制。
- **句序号 `index` 由本库分配**，不要直接透传厂商的 `sentence.index`：DashScope 的 `index` 每轮任务都从 0 重新开始，透传会出现重复序号。
- **音频不做转码 / 重采样**，`format` 与 `sampleRate` 如实透出；容器格式（wav / mp3）只在任务首片带文件头，这一点要写在文档里而不是替调用方拼容器头。
- 关闭时若仍有未提交文本，基类与适配器会补合成一次，避免调用方忘 `flush()` 丢字。

### 公共生命周期集中在 Base Client

provider 无关的职责集中在 `BaseRealtimeSession` 与两个方向基类：

- 创建和关闭连接、异常关闭后的指数退避重连、维护连接状态（`BaseRealtimeSession`）
- 接收并转换调用方提供的数据：音频归一化为 16-bit LE PCM（ASR 侧）/ 文本缓冲与提交（TTS 侧）
- 发送统一事件；监听器由调用方通过 `off()` 或 `removeAllListeners()` 管理

适配器只负责 provider 特有的 URL、认证、握手、帧编码、服务端消息解析，以及把结果转换成 `Transcript` / `TTSChunk`。这样新增 provider 时，不应把厂商协议判断散落到公共客户端或示例代码中。

生命周期事件的落地约定：新写的适配器调用 `emitOpen()` / `emitError()`（`BaseRealtimeSession` 提供），不要直接 `this.emit("open", …)`。ASR 侧四个既有适配器仍在直接 `emit`，属于历史写法，迁移是纯粹的机械替换，可择机统一。

### 统一 transcript 事件

所有适配器只发出一个 `transcript` 事件，使用 `isFinal` 区分 partial 和 final。不要再增加 `partial` / `final` 两套别名，否则调用方会被迫处理重复事件模型。

当 provider 能标识同一句时，适配器应让 partial 和 final 共享稳定的 `id`，并分配 1-based `index`。这保证前端可以按句原地替换，而不需要猜测文本是否属于上一句。

### 结束与排空

适配器负责按句转发识别结果；Volcengine 的未定稿尾句在会话结束时由适配器补发 final。发完音频后的排空窗口仍由调用方编排：调用方应等待服务端残余结果到达，再关闭客户端。Node 示例中的 `drainWait` 是这一约定的参考实现。

## Provider 维护经验

- **DashScope**：实时流使用裸 PCM WebSocket 帧；默认模型为 `fun-asr-flash-8k-realtime`。同一句从首条 partial 开始使用 `s1`、`s2` … ID，final 到达后切换到下一句。
  - 官方文档（README 的「支持的后端」表格里放的是指南页，这里补更细的事件参考）：[WebSocket API](https://help.aliyun.com/zh/model-studio/fun-asr-realtime-websocket-api) · [客户端事件](https://help.aliyun.com/zh/model-studio/fun-asr-client-events) · [服务端事件](https://help.aliyun.com/zh/model-studio/fun-asr-server-events)。
  - 文档里几个容易踩的点：① `sample_rate` 的约束是「**8k 模型仅支持 8000 Hz**，其他模型支持任意采样率」，而本库默认模型正是 8k 那个、默认采样率却是 16000（实测仍能正确识别，服务端似乎会自行处理，但已偏离文档口径）；② `language_hints` **按模型不同**：`fun-asr-flash-8k-realtime` 只支持 `zh`，`fun-asr-realtime` 支持一长串语种且**不含 `yue`**；③ ASR 的 `continue-task` 用途是**更新对话上下文**（`payload.input.context`，仅部分模型支持），不是发音频；④ 连接可跨任务复用（`task-finished` 后发新 `run-task`），但 **`task-failed` 会关闭连接、不可复用**，空闲 60 秒超时断开。
- **OpenAI-Realtime**：partial 使用 `delta`，final 使用 `completed`；服务端的 `item_id` 可直接作为结果 ID。
- **Volcengine**：使用私有二进制帧协议；`utterances` 中的活体句用于 partial，带 `definite` 的句子用于 final。说话人标签依赖服务端返回，且表示当前累积片段中最近的说话人，不是逐词标签。
- **IFlytek**：大模型版使用 URL 签名鉴权（HMAC-SHA1），握手后发送裸 PCM binary；结果在 `data.cn.st.rt[].ws[].cw[].w` 拼接，`type="0"` 为 final、`type="1"` 为 partial，`seg_id` 为句序号。支持 `role_type=2` 开启角色分离。
- **DashScope TTS**（`tts/adapters/dashscope.ts`，已实测线上）：官方文档 [实时流式语音合成指南](https://platform.qianwenai.com/docs/developer-guides/speech/realtime-streaming) · [WebSocket API 参考](https://help.aliyun.com/zh/model-studio/cosyvoice-websocket-api)。一轮合成 = `run-task` → `continue-task`×N → `finish-task`，三者 `task_id` 必须一致，且**必须等 `task-started` 之后**才能发后续指令（适配器用 `pendingText` 排队实现这一点）。音频走 binary 帧、紧跟 `result-generated(type=sentence-synthesis)`；一轮结束收到 `task-finished` 后可在同一连接上直接发新的 `run-task`（连接复用已实测通过，逐句模式每句一个任务约 600ms）。
  - 实测载荷结构与文档示例的层级不同：**句子文本在 `payload.output.original_text` / `normalized_text`（与 `type`、`sentence` 同级），`output.sentence` 里只有 `index` 和 `words`**。按文档示例去读 `sentence.original_text` 会永远拿到空文本。
  - `output.sentence.index` 每轮任务都从 0 重新开始，因此统一的句序号由本库自行分配。
  - `words` 默认为空数组，需在 `extra` 里开启 `word_timestamp_enabled` 才会有值。
  - **`sample_rate` 确实生效**（实测 8000 / 16000 / 24000 / 48000：字节数严格按采样率成比例，折算出的时长恒为 ~3s）。因此 `TTSChunk.sampleRate` 如实可信，验证手段是「同一句话换采样率，字节数应按比例变化」（见 `test/tts/integration.test.ts`）。
  - **反例：不要用 TTS→ASR 往返来验证采样率**。实测 DashScope ASR 对上报的 `sample_rate` 不敏感——同一段 16k 音频按 8000 / 16000 / 24000 上报，识别结果逐字相同（服务端自己做了重采样 / 检测）。往返测试只能证明「音频可懂 + 字节布局正确」（无容器头、单声道、位深正确），证明不了采样率元信息的真实性。
- **Volcengine TTS**（`tts/adapters/volcengine.ts`，**已实测线上**）：两种模式共用同一套帧 envelope 与下行事件（`350`/`351`/`352`/`152`），差异只在「文本怎么发」。文档：[双向 6561/1329505](https://www.volcengine.com/docs/6561/1329505) · [单向 6561/1719100](https://www.volcengine.com/docs/6561/1719100)。
  实测到的**文档没写清 / 写错**的地方（都是踩过才确认的）：
  1. **所有帧都走 WebSocket binary 消息**，控制事件也是 —— 绝不能按 `ws` 的 `isBinary` 分流，否则事件帧会被当成音频吞掉、状态机静默卡死（flush 永久悬挂）。必须一律按 envelope 解码，由帧内 `messageType` 区分控制/音频。
  2. **每个事件帧都带 `sessionId`，连连接级的 `ConnectionStarted(50)` / `ConnectionFinished(52)` 也带** —— 文档与第三方实现都说"连接级事件跳过 sessionId"，是错的。`utils/volc-frames.ts` 的「按长度自校验」宽松解码正好兜住了这一点。
  3. **音频帧 = `messageType=0b1011` + `flags=0b0100`(WithEvent) + `event=352`**，payload 即原始音频字节（不是纯 audio-only 帧，也不是 JSON）。
  4. **句文本只在 `TTSSentenceEnd(351)` 的 payload 里**：`{"phonemes":[],"text":"…","words":[]}`；`TTSSentenceStart(350)` 的 `text` 是空串。
  5. 事件时序：双向 `50 → 150 → 350 → 352×N → 351 → 152`；单向**没有 `150`**，直接 `350 → 352×N → 351 → 152`。
  6. **单向模式绝不能发 `StartConnection`**：发了会得到业务错误 `55000000 "resource ID is mismatched with speaker related resource"`。文档说"合成阶段不需要上行 event 帧"是准确的。
  7. 单向模式下**不需要 `FinishConnection` 服务端就会合成**，连接可继续复用；`FinishConnection` 只在 close 时发。
  - 统一选项换算：`speed`（倍率）→ `speech_rate`、`volume`（0-100）→ `loudness_rate`，均为近似线性；**无 pitch 参数**（忽略）；情感等走 `extra`。
  - **1.0 与 2.0 的差异**：`resource-id` 与音色必须配套（`seed-tts-2.0` 只能用 2.0 音色，反之亦然），配错会直接报业务错。已授权情况可随时用 `X-Api-Resource-Id` 扫描确认（未授权的会回 `403 not granted`）。
  - **字级时间戳只在 1.0 / ICL 1.0 音色提供**，需在 `extra` 里开 `enable_timestamp`。实测载荷是**驼峰字段且单位是秒**：`{"words":[{"word":"今","startTime":0.105,"endTime":0.265,"confidence":0.97}…]}`——注意是 `word` 而不是 `text`，且**不是** 2.0 文档里写的下划线 `begin_time/end_time`（毫秒）。适配器两种都认并按字段名判单位、统一归一化成毫秒（曾因只认下划线命名而让 `words` 永远为空）。
  - 另外 1.0 的 `TTSSentenceStart(350)` 里 `text` **是有值的**（2.0 为空串，文本只在 351），所以句文本两个事件都要读。
  - 真机数据（"今天天气怎么样"）：2.0 两种模式均 ~500-700ms、约 75KB / 1.58s @24k；1.0 约 811ms 且带 7 个字级时间戳；TTS→ASR 往返相似度 1.00。
- **IFlytek TTS**（`tts/adapters/iflytek.ts`，**已实测线上**）：端点 `wss://cbm01.cn-huabei-1.xf-yun.com/v1/private/mcd9m97e6`（超拟人合成，doc: spark/super smart-tts）。实测确认的几点：
  1. 鉴权走**方式二**：`host\ndate\nGET {path} HTTP/1.1` 的 **HMAC-SHA256**（base64 → authorization → query），与讯飞**识别**的参数串 HMAC-SHA1 完全不是一回事；
  2. `payload.text.text` **必须 base64**（文档示例给的是明文，直接传报 `10163 … must be encode to base64`）；
  3. 流式：`header.status` 与 `payload.text.status` 同为 0/1/2（首/中/末），`seq` 递增；**「空文本 + status=2」被接受**，所以不必扣住最后一段文本；
  4. 下行音频在 `payload.audio.audio`（base64），逐帧 `status=1`，最后来一帧 **`status=2` 且音频为空**的结束标记（适配器据此压一帧回看，把真正的最后一帧标成 `isFinal`）；
  5. **同一连接不可复用**：一轮结束后再发文本返回 `26016 intput channel is closed`（原文错别字）；适配器在下一轮开始前**自动重连**，调用方仍是 `sendText`/`flush`；`capabilities.sessionReuse` 如实上报 `false`；
  6. **发音人授权与字符量授权是两笔独立授权**：未授权的 vcn 报 `11200 LiccCheck failed, err: licc limit`（本账号实测 `x5_lingxiaoxuan_flow` / `x5_lingyuzhao_flow` 可用，文档示例里的 `x5_lingfeiyi_flow` 反而不行）；`10163` 的报错会**列出全部合法 vcn**，排查时很有用；
  7. 一轮合成 = 一句（讯飞没有句级事件），因此句级 `id`/`index` 用轮次号（`r1`、`r2`）。
  - 换算：讯飞 `speed`/`pitch` 是 0-100（50 = 原速/原调）→ 统一倍率 × 50；`volume` 的 0-100 语义与我们一致，直接透传。统一 `pcm`/`mp3`/`opus` → 讯飞 `raw`/`lame`/`opus`；`wav`/`aac`/`flac` 不支持。
  - 真机数据：中长句约 3.2s 音频 / 890ms（含两轮 + 一次自动重连）；TTS→ASR 往返相似度 1.00（该用例同时覆盖了讯飞**识别**的真机路径）。
- **OpenAI TTS**（`tts/adapters/openai.ts`）：唯一的纯 HTTP 形态 —— `POST /v1/audio/speech`，**没有 WebSocket、没有会话**，`flush()` 即一次请求，响应体按 chunked 流式返回。要点：
  1. **没有会话可选**：因此 `incrementalText: false`（`sendText` 只入基类缓冲、`flush` 一次性提交）、`sessionReuse: false`、`transport: "http"`；`connect()` 不发探针请求（避免多余计费调用），凭证错误由 `flush()` 暴露；
  2. `close()` 唯一有意义的动作是**中止在途请求**（`AbortController`），在途的 `flush()` 会以 `aborted` 拒绝；
  3. 文档里 `stream_format: "sse"` 对 `tts-1`/`tts-1-hd` **不支持**，所以这里统一用默认 chunked，直接读原始字节流，不做 SSE 解析；
  4. 端点为 24kHz 输出；`pcm`/`wav` 的 `sampleRate` 如实报 24000，容器格式（mp3/opus/…）不臆测（其采样率在容器头里）；
  5. 指南与 API 参考要一起看：`response_format` / `speed` / `stream_format` / 模型白名单只在 [API 参考](https://developers.openai.com/api/reference/resources/audio/subresources/methods/create) 里；指南开头写"11 built-in voices"但列表实际是 13 个（tts-1/tts-1-hd 支持其中 9 个），以列表为准。
  - ⚠️ **尚未真机验证**：本地 `.env.local` 的 `OPENAI_API_KEY` 是模板占位值（`sk-your-key`），相关真机用例会**跳过并说明原因**（与真正的鉴权失败区分开）。配上真实 key 后应跑通 `test/tts/integration.test.ts` 与 `test/common/roundtrip.test.ts` 里的 OpenAI 用例。
- 不同 provider 对语言、VAD、标点、音频格式和说话人分离的支持并不完全一致。公共 `RealtimeASROptions` 只表达统一能力，provider 不支持的选项应安全忽略或在适配器内做兼容处理。

## 修改适配器时的检查清单

ASR 适配器：

1. 更新 `src/asr/types.ts` 中的 provider 配置类型，并把新成员加入 `ASRConfig` 联合。
2. 在 `src/asr/adapters/` 新增适配器，并继承 `core/asr-client.ts` 的 `BaseRealtimeASRClient`。
3. 在 `src/index.ts` 的 `createASRClient` 中加入 provider 分支和导出。
4. 为握手、认证错误、正常结果、partial/final 关联、异常关闭补充测试（`test/asr/*-state.test.ts`，注入假连接、不触网；真实端到端放 `test/asr/integration.test.ts`，缺密钥时 skip）。

TTS 适配器（额外注意）：

0. 适配器放在 `src/tts/adapters/`，继承 `core/tts-client.ts` 的 `BaseRealtimeTTSClient`；不要复用 ASR 目录。
1. 配置类型写进 `src/tts/types.ts` 并加入 `TTSConfig` 联合，同时在 `createTTSClient` 中加分支（provider 达到两家后把 `if` 改回带穷尽性检查的 `switch`）。
2. 声明真实的 `capabilities`，**并在适配器内部按它降级**（尤其是 `incrementalText`）。
3. 覆盖这些用例：整段、逐句（`flush()` 后继续 `sendText()` 是否复用连接）、句子边界处的 `isFinal`、任务失败的错误分类、`flush()` 在异常/失败时必须被唤醒、`close()` 补齐未提交文本。
   单测里注入的**服务端事件必须用 `MSG_FULL_SERVER_RESPONSE`（0b1001）**——客户端请求帧是 0b0001，用错 message type 会被适配器静默忽略，表现为整组用例假挂（踩过一次）。
   若协议把控制帧与音频帧都放在 binary 消息里（火山就是），适配器**不能**按 `isBinary` 分流；单测应覆盖「事件帧从 binary 通道进来」这条路径。
   若某模式会改变能力位（如火山的 `mode`），再加一条断言 `capabilities` 随配置变化的用例。
   真实端到端再补两项：`sampleRate` 等元信息真实性（用「变更参数 → 字节数按比例变化」这类可判定的手段，**不要**用某个方向去"听"来间接推断），以及跨方向往返（`test/common/roundtrip.test.ts` 的形态：合成 → 识别 → 比对文本）。
4. 句序号 `index` 由本库分配，不要透传厂商的句索引。
5. 测试放 `test/tts/`（状态机单测 `dashscope-state.test.ts` 风格 + 真实端到端 `integration.test.ts`）；只有两个方向通用的契约才放 `test/common/`。

通用：

6. 更新 README 中面向使用者的配置和行为说明；实现细节、命令和排障经验写入本文件。
7. 运行格式检查、类型检查、测试和构建（`npm run build` 已内置 clean）。
8. 若新增/移动了文件，架构测试（`test/common/architecture.test.ts`）会校验目录约束；它失败通常说明文件放错了方向子树。

## 文档边界

- `README.md`：使用者需要知道的安装方式、两个方向（ASR / TTS）的 provider 配置、输入 / 输出约定、事件模型和结果语义。结构上 **ASR 与 TTS 是两个并列的一级章节**，各自包含「快速开始 → 支持的后端 → 配置 → 通用选项 → 事件与类型 → 方向特有约定 → 导出」；两个方向共享的内容集中在「共同约定」，不要在两处重复维护。
- `DEVELOPMENT.md`：本地开发命令、示例运行、项目结构、架构决策、provider 实现经验和贡献检查清单。

新增公共行为时，两份文档都要同步检查：README 说明调用方可观察到的行为，本文档说明实现约束和验证方式。
