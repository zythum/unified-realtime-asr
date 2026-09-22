/**
 * 统一错误类型。
 *
 * `SpeechError` 是所有能力的公共基类；各方向再派生出 `ASRError` / `TTSError`
 * 两族，细分类目（连接 / 鉴权 / 协议）在族内派生。捕获端既可以按能力族
 * （`instanceof ASRError`）也可以按公共基类（`instanceof SpeechError`）判断。
 */
export class SpeechError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "SpeechError";
  }
}

/* ----------------------------------- ASR ---------------------------------- */

export class ASRError extends SpeechError {
  constructor(message: string, code?: string, cause?: unknown) {
    super(message, code, cause);
    this.name = "ASRError";
  }
}

export class ASRConnectionError extends ASRError {
  constructor(message: string, code?: string, cause?: unknown) {
    super(message, code, cause);
    this.name = "ASRConnectionError";
  }
}

export class ASRAuthError extends ASRError {
  constructor(message: string, code?: string, cause?: unknown) {
    super(message, code, cause);
    this.name = "ASRAuthError";
  }
}

export class ASRProtocolError extends ASRError {
  constructor(message: string, code?: string, cause?: unknown) {
    super(message, code, cause);
    this.name = "ASRProtocolError";
  }
}

/* ----------------------------------- TTS ---------------------------------- */

export class TTSError extends SpeechError {
  constructor(message: string, code?: string, cause?: unknown) {
    super(message, code, cause);
    this.name = "TTSError";
  }
}

export class TTSConnectionError extends TTSError {
  constructor(message: string, code?: string, cause?: unknown) {
    super(message, code, cause);
    this.name = "TTSConnectionError";
  }
}

export class TTSAuthError extends TTSError {
  constructor(message: string, code?: string, cause?: unknown) {
    super(message, code, cause);
    this.name = "TTSAuthError";
  }
}

export class TTSProtocolError extends TTSError {
  constructor(message: string, code?: string, cause?: unknown) {
    super(message, code, cause);
    this.name = "TTSProtocolError";
  }
}
