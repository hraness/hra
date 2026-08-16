/**
 * The transport ceiling intentionally exceeds the owned 6 MiB history
 * compatibility threshold. This lets the session layer classify a large,
 * non-pageable thread/read without turning an ordinary compatibility case
 * into a process-generation fault. Truly excessive lines still fail closed.
 */
export const MAX_CODEX_JSONL_LINE_BYTES = 16 * 1_024 * 1_024;

const MAX_RETAINED_JSONL_BUFFER_BYTES = 64 * 1_024;

export type CodexJsonlFaultReason =
  | "decoder_finished"
  | "invalid_utf8"
  | "line_too_large";

export class CodexJsonlError extends Error {
  readonly reason: CodexJsonlFaultReason;

  constructor(reason: CodexJsonlFaultReason) {
    super(`Codex JSONL decoding failed: ${reason}`);
    this.name = "CodexJsonlError";
    this.reason = reason;
  }
}

export class CodexJsonlDecoder {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #maxLineBytes: number;
  #buffer = new Uint8Array(0);
  #bufferLength = 0;
  #finished = false;
  #fault: CodexJsonlError | null = null;

  constructor(maxLineBytes = MAX_CODEX_JSONL_LINE_BYTES) {
    if (
      !Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0 ||
      maxLineBytes > MAX_CODEX_JSONL_LINE_BYTES
    ) {
      throw new Error("maxLineBytes must be a positive safe integer within the hard limit");
    }
    this.#maxLineBytes = maxLineBytes;
  }

  push(chunk: Uint8Array): readonly string[] {
    this.#throwIfUnavailable();
    const lines: string[] = [];
    let offset = 0;
    while (offset < chunk.byteLength) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.byteLength : newline;
      this.#append(chunk.subarray(offset, end));
      if (newline < 0) break;
      const line = this.#decodeBufferedLine();
      if (line.trim().length > 0) lines.push(line);
      offset = newline + 1;
    }
    return lines;
  }

  finish(): readonly string[] {
    this.#throwIfUnavailable();
    this.#finished = true;
    if (this.#bufferLength === 0) return Object.freeze([]);
    const line = this.#decodeBufferedLine();
    return line.trim().length === 0 ? Object.freeze([]) : Object.freeze([line]);
  }

  #append(segment: Uint8Array): void {
    if (segment.byteLength === 0) return;
    const nextLength = this.#bufferLength + segment.byteLength;
    if (nextLength > this.#maxLineBytes) {
      throw this.#latchFault("line_too_large");
    }
    if (nextLength > this.#buffer.byteLength) {
      let capacity = Math.min(
        this.#maxLineBytes,
        Math.max(1_024, this.#buffer.byteLength),
      );
      while (capacity < nextLength) {
        capacity = Math.min(this.#maxLineBytes, capacity * 2);
      }
      const grown = new Uint8Array(capacity);
      grown.set(this.#buffer.subarray(0, this.#bufferLength));
      this.#buffer = grown;
    }
    this.#buffer.set(segment, this.#bufferLength);
    this.#bufferLength = nextLength;
  }

  #decodeBufferedLine(): string {
    let line: string;
    try {
      line = this.#decoder.decode(this.#buffer.subarray(0, this.#bufferLength));
    } catch {
      throw this.#latchFault("invalid_utf8");
    }
    this.#bufferLength = 0;
    if (this.#buffer.byteLength > MAX_RETAINED_JSONL_BUFFER_BYTES) {
      this.#buffer = new Uint8Array(0);
    }
    return line.replace(/\r$/u, "");
  }

  #latchFault(reason: CodexJsonlFaultReason): CodexJsonlError {
    if (this.#fault === null) this.#fault = new CodexJsonlError(reason);
    this.#buffer = new Uint8Array(0);
    this.#bufferLength = 0;
    return this.#fault;
  }

  #throwIfUnavailable(): void {
    if (this.#fault !== null) throw this.#fault;
    if (this.#finished) throw new CodexJsonlError("decoder_finished");
  }
}
