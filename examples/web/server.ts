/**
 * 极简 Web 示例：浏览器麦克风 -> Node 中继 -> 统一 ASR 库 -> 厂商。
 *
 * 浏览器无法直接跑本库（依赖 Node 的 ws / 私有帧协议），所以这里用一个
 * 轻量 Node 服务做桥接：
 *   - 用内置 http 提供静态页面（public/index.html）；
 *   - 用 ws 起一个 WebSocket（/ws）；
 *   - 浏览器把麦克风采集的 16k/16-bit/mono PCM 以二进制帧推到 /ws；
 *   - 服务端直接转发给 createASRClient().sendAudio()，再把 transcript
 *     事件以 JSON 回传给浏览器。
 *
 * 识别引擎（provider）由浏览器在开始录音前通过 {type:"config", provider}
 * 消息指定，服务端据此用对应的环境变量密钥建连；录音过程中可随时停止。
 *
 * 运行：
 *   cp .env.example .env.local   # 填好各厂商密钥
 *   npm run example:web          # 打开 http://localhost:3000
 *
 * 注意：密钥留在服务端（env），不暴露给浏览器。
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import dotenv from "dotenv";
import { createASRClient, type ASRConfig } from "../../src/index.js";

dotenv.config({ path: fileURLToPath(new URL("../../.env.local", import.meta.url)) });

const PORT = Number(process.env.PORT ?? 3000);
const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "public");

function buildConfig(provider: string): ASRConfig {
  switch (provider) {
    case "openai":
      return { provider: "openai", apiKey: process.env.OPENAI_API_KEY! };
    case "dashscope":
      return {
        provider: "dashscope",
        apiKey: process.env.DASHSCOPE_API_KEY!,
        model: process.env.DASHSCOPE_ASR_MODEL,
        workspaceId: process.env.DASHSCOPE_WORKSPACE_ID,
      };
    case "volcengine":
      return {
        provider: "volcengine",
        apiKey: process.env.VOLC_API_KEY!,
        resourceId: process.env.VOLC_ASR_RESOURCE_ID,
      };
    case "iflytek":
      return {
        provider: "iflytek",
        appId: process.env.IFLYTEK_APP_ID!,
        apiKey: process.env.IFLYTEK_API_KEY!,
        apiSecret: process.env.IFLYTEK_API_SECRET!,
      };
    default:
      throw new Error(
        `不支持的 provider: ${provider}（可选 dashscope | volcengine | openai | iflytek）`,
      );
  }
}

const server = createServer(async (req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    try {
      const html = await readFile(join(PUBLIC_DIR, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("无法读取 public/index.html");
    }
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (sock: WebSocket) => {
  let asr: ReturnType<typeof createASRClient> | undefined;
  let asrReady = false;
  let connecting = false;
  // ASR 建连期间的音频先缓冲，就绪后统一 flush，避免丢掉开头几句。
  const audioBuf: Buffer[] = [];
  const MAX_BUF = 300;

  const send = (obj: unknown) => {
    if (sock.readyState === sock.OPEN) sock.send(JSON.stringify(obj));
  };

  let connectionGeneration = 0;

  function startASR(provider: string) {
    if (connecting || asr) return; // 已有连接，忽略重复 config
    const generation = ++connectionGeneration;
    connecting = true;

    let cfg: ASRConfig;
    try {
      cfg = buildConfig(provider);
    } catch (err) {
      connecting = false;
      send({ type: "error", message: (err as Error).message });
      sock.close();
      return;
    }

    let currentAsr: ReturnType<typeof createASRClient>;
    try {
      currentAsr = createASRClient(cfg);
      asr = currentAsr;
    } catch (err) {
      connecting = false;
      send({ type: "error", message: (err as Error).message });
      sock.close();
      return;
    }

    const isCurrent = () => generation === connectionGeneration && asr === currentAsr;

    currentAsr.on("transcript", (t) => {
      if (!isCurrent()) return;
      send({
        type: "transcript",
        text: t.text,
        isFinal: t.isFinal,
        id: t.id ?? null,
        index: t.index ?? null,
        speaker: t.speaker ?? null,
      });
    });
    currentAsr.on("error", (e) => {
      if (!isCurrent()) return;
      send({ type: "error", message: e.message });
    });
    currentAsr.on("close", () => {
      if (!isCurrent()) return;
      connecting = false;
      asrReady = false;
      asr = undefined;
      send({ type: "asr-close" });
    });

    currentAsr
      .connect()
      .then(() => {
        // stop 可能在 connect 等待期间发生；旧连接不得再修改当前会话状态。
        if (
          generation !== connectionGeneration ||
          asr !== currentAsr ||
          sock.readyState !== sock.OPEN
        ) {
          currentAsr.close().catch(() => {});
          return;
        }
        connecting = false;
        asrReady = true;
        send({ type: "ready", provider: currentAsr.provider });
        for (const pcm of audioBuf) {
          if (generation !== connectionGeneration || asr !== currentAsr || !asrReady) break;
          try {
            currentAsr.sendAudio(pcm);
          } catch {
            /* ignore */
          }
        }
        audioBuf.length = 0;
      })
      .catch((err) => {
        if (generation !== connectionGeneration || asr !== currentAsr) return;
        connecting = false;
        asrReady = false;
        asr = undefined;
        send({ type: "error", message: (err as Error).message });
        sock.close();
      });
  }

  function stopASR() {
    connectionGeneration += 1;
    const currentAsr = asr;
    asr = undefined;
    asrReady = false;
    connecting = false;
    audioBuf.length = 0;
    currentAsr?.close().catch(() => {});
  }

  sock.on("message", (data, isBinary) => {
    if (isBinary) {
      const pcm = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (!asrReady || !asr) {
        if (audioBuf.length < MAX_BUF) audioBuf.push(pcm); // 缓冲待 flush
        return;
      }
      try {
        asr.sendAudio(pcm);
      } catch {
        /* 连接尚未就绪时丢弃，避免抛错中断流 */
      }
      return;
    }

    let msg: { type?: string; provider?: string };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === "config") startASR(String(msg.provider ?? ""));
    else if (msg.type === "stop") stopASR();
  });

  sock.on("close", () => stopASR());
});

server.listen(PORT, () => {
  console.log(`[web] http://localhost:${PORT}`);
});
