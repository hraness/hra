export type ClaudeFailureCode =
  | "AUTHORITY_STALE"
  | "CONFIG_DIR_MISMATCH"
  | "DEADLINE_EXPIRED"
  | "INVALID_INPUT"
  | "NOT_AUTHENTICATED"
  | "PRESET_UNSUPPORTED"
  | "PROCESS_EXITED"
  | "PROTOCOL_ERROR"
  | "PROTOCOL_LIMIT"
  | "RUNTIME_MISMATCH"
  | "TIMEOUT"
  | "UNSUPPORTED_CAPABILITY";

/** Never carries provider payload text. Callers add only bounded, safe detail. */
export class ClaudeError extends Error {
  readonly code: ClaudeFailureCode;

  constructor(code: ClaudeFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClaudeError";
    this.code = code;
  }
}
