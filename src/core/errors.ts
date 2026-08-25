export class ASRError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
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
