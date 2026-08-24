export type CodexFailureCode =
  | "AUTHORITY_STALE"
  | "DEADLINE_EXPIRED"
  | "HOME_MISMATCH"
  | "INDETERMINATE_EFFECT"
  | "INVALID_INPUT"
  | "PROCESS_EXITED"
  | "PROTOCOL_ERROR"
  | "PROTOCOL_LIMIT"
  | "REMOTE_ERROR"
  | "RUNTIME_MISMATCH"
  | "TIMEOUT"
  | "UNSUPPORTED_CAPABILITY";

export class CodexError extends Error {
  readonly code: CodexFailureCode;

  constructor(code: CodexFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexError";
    this.code = code;
  }
}

export class CodexRemoteError extends CodexError {
  readonly remoteCode: number;

  constructor(remoteCode: number, safeMessage: string) {
    super("REMOTE_ERROR", `Codex rejected the request (${String(remoteCode)}): ${safeMessage}`);
    this.name = "CodexRemoteError";
    this.remoteCode = remoteCode;
  }
}

export class IndeterminateCodexEffectError extends CodexError {
  readonly operation: string;
  readonly requestId: number;

  constructor(operation: string, requestId: number, cause?: unknown) {
    super(
      "INDETERMINATE_EFFECT",
      `${operation} may have reached Codex; reconcile it before another attempt`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "IndeterminateCodexEffectError";
    this.operation = operation;
    this.requestId = requestId;
  }
}
