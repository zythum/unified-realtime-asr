/**
 * ASR 首字延迟探针。
 *
 * 把同一段音频按「实时」速度（默认 20ms/包）推给指定 provider，记录：
 *   - connect  : WebSocket 握手耗时（单独计时）
 *   - A1st     : 第一条 partial 相对「开始推流」的墙钟耗时
 *   - A1st@audio: 第一条 partial 到达时，已经推给服务端的音频时长（真正的「首字」信息量）
 *   - B1st     : 第一条 final 的墙钟耗时
 * 并逐条打印结果时间线，便于横向对比不同 provider。
 *
 * 用法：
 *   npx tsx scripts/asr-latency.ts dashscope
 *   npx tsx scripts/asr-latency.ts volcengine
 *   ASR_PCM_FILE=fixtures/sample-voice.pcm npx tsx scripts/asr-latency.ts iflytek
 *
 * 加 `--raw` 时额外打印服务端原始帧到达时间线（目前实现了火山帧解码）：
 * 用来判断「慢」到底发生在服务端返回、还是发生在适配器解析/转发。
 * 两者共用「开始推流」这一个时间原点，因此可以逐条对齐。
 *   npx tsx scripts/asr-latency.ts volcengine --raw
 *
 * 注意：`--raw` 会在收包路径上多做一次解码 + 打印，会轻微扰动时延；取数值时建议不加 `--raw`，
 * 只在需要归因「服务端 vs 适配器」时才打开。
 *
 * 可用环境变量调参：ASR_CHUNK_MS / ASR_PCM_FILE / VOLC_ASR_URL / ASR_SPEAKER_DIARIZATION / ASR_EXTRA。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import WebSocket from "ws";
import {
  createASRClient,
  type ASRConfig,
  type RealtimeASRClient,
  type RealtimeASROptions,
} from "../src/index.js";
import { stripWavHeader } from "../src/utils/wav.js";
import { decodeFrame, toBuffer } from "../src/utils/volc-frames.js";

dotenv.config({ path: fileURLToPath(new URL("../.env.local", import.meta.url)) });

/** 单包音频时长（ms）。火山官方建议 100~200ms；双向流式以 200ms 为最优。用 ASR_CHUNK_MS 覆盖。 */
const CHUNK_MS = Number(process.env.ASR_CHUNK_MS ?? 20);
/** 单包字节数：16kHz / 16-bit / mono。 */
const CHUNK_BYTES = (CHUNK_MS * 16000 * 2) / 1000;

/** 已推给服务端的音频时长（ms），由推流循环维护，用于标注结果到达时的音频进度。 */
let audioSentMs = 0;
/**
 * 所有时间线的统一原点 =「开始推流」时刻（握手耗时单独用 connectMs 报告）。
 * transcript 行与 `--raw` 行共用它，两条时间线才能逐条对齐。
 */
let origin = 0;

interface Sample {
  t: number; // 相对「开始推流」的墙钟耗时（ms）
  audioMs: number; // 该结果到达时已推给服务端的音频时长
  isFinal: boolean;
  text: string;
}

async function main(): Promise<void> {
  const provider = process.argv[2];
  const raw = process.argv.includes("--raw");
  if (!provider) {
    console.error(
      "用法: npx tsx scripts/asr-latency.ts <dashscope|volcengine|iflytek|openai> [--raw]",
    );
    process.exit(2);
  }

  const file = process.env.ASR_PCM_FILE ?? "fixtures/sample-voice.wav";
  const pcm = loadPcm(file);
  const totalAudioMs = (pcm.length / CHUNK_BYTES) * CHUNK_MS;
  console.log(
    `provider=${provider} file=${file} 音频=${fmtMs(totalAudioMs)} (${pcm.length}B) 包长=${CHUNK_MS}ms`,
  );

  if (raw) {
    console.log("--raw 时间线与结果时间线同原点（开始推流），可直接逐条对齐");
    installRawFrameLogger(provider);
  }

  const client = createASRClient(buildConfig(provider));
  const samples: Sample[] = [];
  const speakers = new Set<string>();
  const tConnect = Date.now(); // 握手计时起点

  client.on("open", () => console.log(`[open] connect +${Date.now() - tConnect}ms`));
  client.on("transcript", (t) => {
    const s: Sample = {
      t: rel(Date.now()),
      audioMs: audioSentMs,
      isFinal: t.isFinal,
      text: t.text,
    };
    samples.push(s);
    if (t.speaker !== undefined) speakers.add(t.speaker);
    console.log(
      `[+${pad(s.t)}ms | audio=${pad(s.audioMs)}ms] ${s.isFinal ? "FINAL  " : "partial"} ${JSON.stringify(
        s.text,
      )}${t.speaker !== undefined ? ` speaker=${t.speaker}` : ""}`,
    );
  });
  client.on("error", (e) => console.error(`[error] ${e.message}`));

  await client.connect();
  const connectMs = Date.now() - tConnect;

  origin = Date.now(); // 首字延迟的口径：从「开始推流」起算
  await streamPcm(client, pcm);

  // 推完音频后保持静默，等服务端把尾句算完（各家收尾策略不同）。
  await drainWait(samples, 1200, 4000);
  const tailWaitMs = Date.now() - origin - totalAudioMs;

  await client.close();

  const firstPartial = samples.find((s) => !s.isFinal);
  const firstFinal = samples.find((s) => s.isFinal);
  console.log("\n================ 汇总 ================");
  console.log(`provider     : ${provider}`);
  console.log(`connect      : ${connectMs}ms`);
  console.log(`A1st partial : ${firstPartial ? `${firstPartial.t}ms` : "—（无 partial）"}`);
  console.log(
    `A1st @audio  : ${firstPartial ? `${firstPartial.audioMs}ms` : "—"}（首字到达时已推音频时长）`,
  );
  console.log(`B1st final   : ${firstFinal ? `${firstFinal.t}ms` : "—（无 final）"}`);
  console.log(`推流结束后等待 : ${tailWaitMs}ms`);
  console.log(
    `说话人标签   : ${speakers.size ? `有 [${[...speakers].join(", ")}]` : "无（未开启或服务端未返回）"}`,
  );
  console.log(
    `结果条数     : ${samples.length}（partial=${samples.filter((s) => !s.isFinal).length}, final=${
      samples.filter((s) => s.isFinal).length
    }）`,
  );
  console.log(`总耗时       : ${fmtMs(Date.now() - tConnect)}`);
}

/** 按实时速度推流；每推一包更新 audioSentMs，便于把结果标注到音频进度上。 */
async function streamPcm(client: RealtimeASRClient, pcm: Buffer): Promise<void> {
  const t0 = Date.now();
  for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
    client.sendAudio(pcm.subarray(offset, offset + CHUNK_BYTES));
    const sentBytes = Math.min(offset + CHUNK_BYTES, pcm.length);
    const sentMs = (sentBytes / CHUNK_BYTES) * CHUNK_MS;
    audioSentMs = sentMs;
    // 用目标绝对时间对齐 sleep，避免 sleep 抖动导致推流整体变慢
    await sleep(Math.max(0, t0 + sentMs - Date.now()));
  }
}

/** 排空窗口：结果不再增长后保持 restForMs 静默即结束；上限 maxMs。 */
function drainWait(samples: Sample[], restForMs: number, maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    let seen = samples.length;
    let lastChange = Date.now();
    const tick = (): void => {
      if (samples.length !== seen) {
        seen = samples.length;
        lastChange = Date.now();
      }
      if (Date.now() - start >= maxMs) return resolve();
      if (Date.now() - lastChange >= restForMs) return resolve();
      setTimeout(tick, 50);
    };
    tick();
  });
}

/**
 * 给 ws 的 message 事件挂一个旁路监听（先于适配器注册），打印服务端原始帧时间线。
 * 这样「服务端何时回结果」与「适配器何时 emit transcript」可以分开看到。
 */
function installRawFrameLogger(provider: string): void {
  if (provider !== "volcengine") {
    console.warn(`[raw] 暂未实现 ${provider} 的帧解码，跳过原始帧日志`);
    return;
  }
  const origOn = WebSocket.prototype.on as unknown as (
    event: string,
    listener: (data: WebSocket.RawData) => void,
  ) => WebSocket;

  const patched = function patchedOn(
    this: WebSocket,
    event: string,
    listener: (data: WebSocket.RawData) => void,
  ): WebSocket {
    if (event === "message") {
      // 旁路监听先于适配器注册，因此这里打印的时点 ≤ 适配器处理时点。
      origOn.call(this, "message", (data: WebSocket.RawData) => {
        const t = rel(Date.now());
        try {
          const frame = decodeFrame(toBuffer(data));
          console.log(
            `  <raw +${pad(t)}ms> ${summarize(frame.messageType, frame.flags, frame.payload)}`,
          );
        } catch (e) {
          console.log(`  <raw +${pad(t)}ms> 解码失败: ${(e as Error).message}`);
        }
      });
    }
    return origOn.call(this, event, listener);
  };

  WebSocket.prototype.on = patched as unknown as typeof WebSocket.prototype.on;
}

function summarize(messageType: number, flags: number, payload: Buffer): string {
  const meta = `msgType=0b${messageType.toString(2)} flags=0b${flags.toString(2).padStart(4, "0")}`;
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(payload.toString("utf-8")) as Record<string, unknown>;
  } catch {
    return `${meta} (非 JSON payload, ${payload.length}B)`;
  }
  if (!body) return `${meta} (空)`;
  const result = (body.result ?? {}) as Record<string, unknown>;
  const utts = Array.isArray(result.utterances)
    ? (result.utterances as Record<string, unknown>[])
    : [];
  const definiteFlags = utts
    .map((u) => (u?.definite === true || u?.def === true ? "D" : "-"))
    .join("");
  const resText = typeof result.text === "string" ? result.text : "";
  const uttText = utts.length ? String(utts[utts.length - 1]?.text ?? "") : "";
  const shown = (utts.length ? uttText : resText).slice(-24);
  // 适配器优先用 utterances 文本；若 result.text 更早更新，这里能看出来（diff 标记）。
  const mismatch =
    resText !== uttText ? ` <<diff: result.text=${JSON.stringify(resText.slice(-24))}>>` : "";
  return `${meta} code=${String(body.code ?? 0)} utts=${utts.length}[${definiteFlags}] text=${JSON.stringify(shown)}${mismatch}`;
}

function loadPcm(file: string): Buffer {
  const raw = readFileSync(file);
  return file.toLowerCase().endsWith(".wav") ? Buffer.from(stripWavHeader(raw)) : raw;
}

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
    case "volcengine": {
      // 调参入口：ASR_SPEAKER_DIARIZATION=1 开说话人分离；ASR_EXTRA='{"enable_nonstream":true}' 透传 request 字段。
      const options: RealtimeASROptions = {};
      if (process.env.ASR_SPEAKER_DIARIZATION === "1") options.speakerDiarization = true;
      if (process.env.ASR_EXTRA) {
        options.extra = JSON.parse(process.env.ASR_EXTRA) as Record<string, unknown>;
      }
      return {
        provider: "volcengine",
        apiKey: process.env.VOLC_API_KEY!,
        resourceId: process.env.VOLC_ASR_RESOURCE_ID,
        // 用 VOLC_ASR_URL 覆盖端点，对比 bigmodel / bigmodel_async / bigmodel_nostream
        ...(process.env.VOLC_ASR_URL ? { url: process.env.VOLC_ASR_URL } : {}),
        ...(Object.keys(options).length ? { options } : {}),
      };
    }
    case "iflytek":
      return {
        provider: "iflytek",
        appId: process.env.IFLYTEK_APP_ID!,
        apiKey: process.env.IFLYTEK_API_KEY!,
        apiSecret: process.env.IFLYTEK_API_SECRET!,
      };
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/** 相对统一原点（开始推流）的耗时，ms。 */
function rel(now: number): number {
  return now - origin;
}

function pad(n: number): string {
  return String(Math.round(n)).padStart(5, " ");
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
