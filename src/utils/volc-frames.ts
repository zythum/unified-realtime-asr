import type WebSocket from "ws";

/**
 * 火山引擎语音二进制帧（ASR 与 TTS 共用同一套 envelope）。
 *
 * 参考文档：
 * - 流式语音识别：6561/80818（`0b0000` = 非最后一包 / `0b0010` = 最后一包）
 * - 双向流式 TTS V3：6561/1329505 · 单向流式 TTS V3：6561/1719100（`0b0100` = 带 event）
 *
 * 帧结构（全部大端序）：
 * ```
 * byte0: protocol_version(4bit) | header_size(4bit)   -> 恒为 0x11
 * byte1: message_type(4bit)     | message_type_flags(4bit)
 * byte2: serialization(4bit)    | compression(4bit)
 * byte3: reserved (0x00)
 * [4B event]          （flags 带 WithEvent 时）
 * [4B len + sessionId]（session/任务级事件）
 * [4B len + connectId]（连接级事件，见下）
 * [4B sequence]       （flags 带序列号时）
 * 4B payload_len + payload
 * ```
 *
 * 注意 flags 的标准语义（ASR 与 TTS 通用）：
 * - `0b0000` 无序列号；`0b0001` 序列号 > 0；`0b0010` 最后一包（无序列号）；`0b0011` 序列号 < 0；
 * - `0b0100` **带 event number**。
 *
 * 服务端帧的可选字段在文档里的描述不够精确（`sessionId` / `connectId` 的出现在不同事件上
 * 并不一致），因此 {@link decodeFrame} 采用「按长度自校验」的宽松解析：逐个尝试候选布局，
 * 取能**恰好消费完整个缓冲区**的那个。这样即使某个字段的出现规则与文档不同，也不会把
 * payload 读错位。
 */

/* ------------------------------- message type ------------------------------ */

/** 客户端 full client request（含请求参数 / 事件）。 */
export const MSG_FULL_CLIENT_REQUEST = 0b0001;
/** 客户端 audio-only request（仅 ASR 用）。 */
export const MSG_AUDIO_ONLY_REQUEST = 0b0010;
/** 服务端 full server response（JSON 结果 / 事件）。 */
export const MSG_FULL_SERVER_RESPONSE = 0b1001;
/** 服务端 audio-only response（音频数据）。 */
export const MSG_AUDIO_ONLY_RESPONSE = 0b1011;
/** 服务端错误帧。 */
export const MSG_ERROR = 0b1111;

/* ---------------------------------- flags --------------------------------- */

export const FLAG_NO_SEQ = 0b0000;
export const FLAG_POS_SEQ = 0b0001;
/** 最后一包（无序列号）。 */
export const FLAG_LAST_NO_SEQ = 0b0010;
/** 序列号 < 0（最后一包，带序号）。 */
export const FLAG_NEG_SEQ = 0b0011;
/** 带 event number —— TTS 的全部控制帧都用它。 */
export const FLAG_WITH_EVENT = 0b0100;

/* ------------------------------ serialization ----------------------------- */

export const SER_RAW = 0b0000;
export const SER_JSON = 0b0001;
export const COMP_NONE = 0b0000;
export const COMP_GZIP = 0b0001;

const PROTOCOL_VERSION = 0b0001;
const HEADER_SIZE = 0b0001; // 单位：4 字节

export interface VolcFrame {
  messageType: number;
  flags: number;
  serialization: number;
  compression: number;
  /** flags 带 `0b0100` 时存在。 */
  event?: number;
  sessionId?: string;
  connectId?: string;
  sequence?: number;
  /** 错误帧（messageType === MSG_ERROR）携带的错误码。 */
  errorCode?: number;
  payload: Buffer;
}

export interface EncodeFrameOptions {
  /** 默认 {@link MSG_FULL_CLIENT_REQUEST}。 */
  messageType?: number;
  /** 显式 flags；提供 `event` 时会自动叠加 `FLAG_WITH_EVENT`。 */
  flags?: number;
  serialization?: number;
  compression?: number;
  event?: number;
  sessionId?: string;
  /** 正数 → 带序号；负数 → 最后一包（带序号）。 */
  sequence?: number;
  payload?: Buffer | string;
}

/** 组装一帧。`event` 存在时自动置上 WithEvent 位，无需手工算 flags。 */
export function encodeFrame(options: EncodeFrameOptions = {}): Buffer {
  const {
    messageType = MSG_FULL_CLIENT_REQUEST,
    serialization = SER_JSON,
    compression = COMP_NONE,
    event,
    sessionId,
    sequence,
    payload,
  } = options;

  let flags = options.flags ?? FLAG_NO_SEQ;
  if (event !== undefined) flags |= FLAG_WITH_EVENT;
  if (sequence !== undefined) {
    flags |= sequence < 0 ? FLAG_NEG_SEQ : FLAG_POS_SEQ;
  }

  const parts: Buffer[] = [
    Buffer.from([
      (PROTOCOL_VERSION << 4) | HEADER_SIZE,
      (messageType << 4) | flags,
      (serialization << 4) | compression,
      0x00,
    ]),
  ];

  if (event !== undefined) parts.push(i32(event));
  if (sessionId !== undefined) parts.push(lengthPrefixed(sessionId));
  if (sequence !== undefined) parts.push(i32(sequence));

  const body = toPayloadBuffer(payload);
  parts.push(u32(body.length), body);
  return Buffer.concat(parts);
}

/**
 * 解析一帧。与文档的严格布局不同，这里用「恰好消费完缓冲区」来自校验候选布局，
 * 以容忍文档未明确的 `sessionId` / `connectId` 出现规则。
 */
export function decodeFrame(buf: Buffer): VolcFrame {
  if (buf.length < 4) throw new Error("volc frame too short");

  const b1 = buf[1];
  const b2 = buf[2];
  const messageType = (b1 >> 4) & 0x0f;
  const flags = b1 & 0x0f;
  const serialization = (b2 >> 4) & 0x0f;
  const compression = b2 & 0x0f;

  const withEvent = (flags & FLAG_WITH_EVENT) !== 0;
  const withSequence = (flags & FLAG_POS_SEQ) !== 0 || (flags & FLAG_NEG_SEQ) !== 0;
  const isError = messageType === MSG_ERROR;

  // 事件之后可能出现的可选字段：sessionId / connectId / sequence，以及 errorCode。
  // 逐个组合去试，取「payload 长度恰好等于剩余字节数」的那个布局。
  const extras: number[][] = withEvent ? [[], [1], [2], [3], [1, 2], [1, 3]] : [[]];
  const sequences: boolean[] = withSequence ? [true, false] : [false];

  for (const extraFields of extras) {
    for (const wantSequence of sequences) {
      const parsed = tryLayout(buf, { extraFields, wantSequence, isError, withEvent });
      if (!parsed) continue;
      return {
        messageType,
        flags,
        serialization,
        compression,
        ...parsed,
        payload: buf.subarray(buf.length - parsed.payloadLength),
      } as VolcFrame;
    }
  }

  throw new Error(
    `volc frame: 无法确定布局（len=${buf.length} msgType=0b${messageType.toString(2)} flags=0b${flags
      .toString(2)
      .padStart(4, "0")}）`,
  );
}

/** extraFields: 1 = sessionId, 2 = connectId, 3 = 其它长度前缀字段。 */
function tryLayout(
  buf: Buffer,
  opts: { extraFields: number[]; wantSequence: boolean; isError: boolean; withEvent: boolean },
): {
  event?: number;
  sessionId?: string;
  connectId?: string;
  sequence?: number;
  errorCode?: number;
  payloadLength: number;
} | null {
  let off = 4;
  const out: Record<string, unknown> = {};

  if (opts.isError) {
    if (off + 4 > buf.length) return null;
    out.errorCode = buf.readUInt32BE(off);
    off += 4;
  }

  if (opts.withEvent) {
    if (off + 4 > buf.length) return null;
    out.event = buf.readInt32BE(off);
    off += 4;
  }

  for (const field of opts.extraFields) {
    const read = readLengthPrefixed(buf, off);
    if (!read) return null;
    if (field === 1) out.sessionId = read.value;
    else if (field === 2) out.connectId = read.value;
    off = read.next;
  }

  if (opts.wantSequence) {
    if (off + 4 > buf.length) return null;
    out.sequence = buf.readInt32BE(off);
    off += 4;
  }

  if (off + 4 > buf.length) return null;
  const payloadLength = buf.readUInt32BE(off);
  if (off + 4 + payloadLength !== buf.length) return null; // 自校验：必须恰好用完
  return { ...(out as any), payloadLength };
}

function readLengthPrefixed(buf: Buffer, off: number): { value: string; next: number } | null {
  if (off + 4 > buf.length) return null;
  const len = buf.readUInt32BE(off);
  // 合理上限：字段是 uuid / 短标识，不可能是巨大的数（也防止把 payload 当字段读）
  if (len > 256 || off + 4 + len > buf.length) return null;
  return { value: buf.subarray(off + 4, off + 4 + len).toString("utf-8"), next: off + 4 + len };
}

/** 统一把 ws 的 RawData 收敛成 Buffer（并复制，避免持有底层缓冲）。 */
export function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

/* --------------------------------- helpers -------------------------------- */

function i32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(value, 0);
  return b;
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value, 0);
  return b;
}

function lengthPrefixed(value: string): Buffer {
  const b = Buffer.from(value, "utf-8");
  return Buffer.concat([u32(b.length), b]);
}

function toPayloadBuffer(payload: Buffer | string | undefined): Buffer {
  if (payload === undefined) return Buffer.alloc(0);
  return Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf-8");
}
