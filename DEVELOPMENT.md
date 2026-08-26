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
npm run build          # 只编译 src，输出 dist/ 和声明文件
npm run typecheck      # TypeScript 类型检查，不输出文件
npm run test           # 运行 test/*.test.ts
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

`.env.local` 不会入库。变量说明：

```bash
ASR_PROVIDER=dashscope        # dashscope | volcengine | openai
DASHSCOPE_API_KEY=sk-xxx
DASHSCOPE_MODEL=
DASHSCOPE_WORKSPACE_ID=
VOLC_API_KEY=xxx
VOLC_RESOURCE_ID=volc.seedasr.sauc.duration
OPENAI_API_KEY=sk-xxx
ASR_PCM_FILE=fixtures/sample-voice.wav   # 可选；WAV 会自动去头
```

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
├── index.ts                 # 公共入口、createASRClient 和导出
├── types.ts                 # 统一类型和 provider 配置
├── core/
│   ├── base-client.ts       # 连接生命周期、音频发送、重连、事件扇出
│   ├── errors.ts            # 统一错误类型
│   └── typed-emitter.ts     # 类型安全的事件发射器
├── adapters/
│   ├── dashscope.ts         # DashScope WebSocket 适配器
│   ├── openai.ts            # OpenAI-Realtime 适配器
│   └── volcengine.ts        # Volcengine 二进制协议适配器
└── utils/
    └── wav.ts               # WAV 头处理和音频转换工具

examples/
├── node/basic.ts            # 文件推流 Node 示例
└── web/                     # 浏览器麦克风桥接示例

test/                        # 单元测试和集成测试
scripts/                     # 测试音频生成、WAV 处理脚本
fixtures/                    # 示例音频
```

## 架构与扩展方式

### 公共生命周期集中在 Base Client

`BaseRealtimeASRClient` 负责 provider 无关的职责：

- 创建和关闭连接
- 接收并转换调用方提供的音频
- 发送统一事件
- 异常关闭后的指数退避重连
- 维护连接状态；监听器由调用方通过 `off()` 或 `removeAllListeners()` 管理

适配器只负责 provider 特有的 URL、认证、握手、帧编码、服务端消息解析，以及把识别结果转换成 `Transcript`。这样新增 provider 时，不应把厂商协议判断散落到公共客户端或示例代码中。

### 统一 transcript 事件

所有适配器只发出一个 `transcript` 事件，使用 `isFinal` 区分 partial 和 final。不要再增加 `partial` / `final` 两套别名，否则调用方会被迫处理重复事件模型。

当 provider 能标识同一句时，适配器应让 partial 和 final 共享稳定的 `id`，并分配 1-based `index`。这保证前端可以按句原地替换，而不需要猜测文本是否属于上一句。

### 结束与排空

适配器负责按句转发识别结果；Volcengine 的未定稿尾句在会话结束时由适配器补发 final。发完音频后的排空窗口仍由调用方编排：调用方应等待服务端残余结果到达，再关闭客户端。Node 示例中的 `drainWait` 是这一约定的参考实现。

## Provider 维护经验

- **DashScope**：实时流使用裸 PCM WebSocket 帧；默认模型为 `fun-asr-flash-8k-realtime`。同一句从首条 partial 开始使用 `s1`、`s2` … ID，final 到达后切换到下一句。
- **OpenAI-Realtime**：partial 使用 `delta`，final 使用 `completed`；服务端的 `item_id` 可直接作为结果 ID。
- **Volcengine**：使用私有二进制帧协议；`utterances` 中的活体句用于 partial，带 `definite` 的句子用于 final。说话人标签依赖服务端返回，且表示当前累积片段中最近的说话人，不是逐词标签。
- **IFlytek**：大模型版使用 URL 签名鉴权（HMAC-SHA1），握手后发送裸 PCM binary；结果在 `data.cn.st.rt[].ws[].cw[].w` 拼接，`type="0"` 为 final、`type="1"` 为 partial，`seg_id` 为句序号。支持 `role_type=2` 开启角色分离。
- 不同 provider 对语言、VAD、标点、音频格式和说话人分离的支持并不完全一致。公共 `RealtimeASROptions` 只表达统一能力，provider 不支持的选项应安全忽略或在适配器内做兼容处理。

## 修改适配器时的检查清单

1. 更新 `src/types.ts` 中的 provider 配置类型（如有新增配置）。
2. 在 `src/adapters/` 新增适配器，并继承公共 Base Client。
3. 在 `src/index.ts` 的 `createASRClient` 中加入 provider 分支和导出。
4. 为握手、认证错误、正常结果、partial/final 关联、异常关闭补充测试。
5. 更新 README 中面向使用者的配置和行为说明；实现细节、命令和排障经验写入本文件。
6. 运行格式检查、类型检查、测试和构建。

## 文档边界

- `README.md`：使用者需要知道的安装方式、provider 配置、音频输入、事件模型和结果语义。
- `DEVELOPMENT.md`：本地开发命令、示例运行、项目结构、架构决策、provider 实现经验和贡献检查清单。

新增公共行为时，两份文档都要同步检查：README 说明调用方可观察到的行为，本文档说明实现约束和验证方式。
