import { CodexError } from "./errors.ts";

const NEWLINE = 0x0a;

export interface JsonLineDecoderOptions {
  readonly maxLineBytes?: number;
  readonly maxBufferedBytes?: number;
}

/** A byte-bounded JSONL decoder. It never includes provider data in errors. */
export class JsonLineDecoder {
  readonly #maxLineBytes: number;
  readonly #maxBufferedBytes: number;
  #buffer = new Uint8Array(0);
  readonly #textDecoder = new TextDecoder("utf-8", { fatal: true });

  constructor(options: JsonLineDecoderOptions = {}) {
    this.#maxLineBytes = boundedLimit(options.maxLineBytes, 8 * 1024 * 1024);
    this.#maxBufferedBytes = boundedLimit(
      options.maxBufferedBytes,
      this.#maxLineBytes + 64 * 1024,
    );
    if (this.#maxBufferedBytes < this.#maxLineBytes) {
      throw new CodexError(
        "INVALID_INPUT",
        "maxBufferedBytes must be at least maxLineBytes",
      );
    }
  }

  push(chunk: Uint8Array): readonly unknown[] {
    if (chunk.byteLength === 0) return [];
    if (this.#buffer.byteLength + chunk.byteLength > this.#maxBufferedBytes) {
      throw new CodexError("PROTOCOL_LIMIT", "Codex JSONL buffer exceeded its byte limit");
    }

    const joined = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
    joined.set(this.#buffer);
    joined.set(chunk, this.#buffer.byteLength);

    const values: unknown[] = [];
    let start = 0;
    for (let index = 0; index < joined.byteLength; index += 1) {
      if (joined[index] !== NEWLINE) continue;
      const length = index - start;
      if (length > this.#maxLineBytes) {
        throw new CodexError("PROTOCOL_LIMIT", "Codex JSONL line exceeded its byte limit");
      }
      if (length > 0) values.push(this.#parse(joined.subarray(start, index)));
      start = index + 1;
    }

    this.#buffer = joined.slice(start);
    if (this.#buffer.byteLength > this.#maxLineBytes) {
      throw new CodexError("PROTOCOL_LIMIT", "Codex JSONL line exceeded its byte limit");
    }
    return values;
  }

  finish(): readonly unknown[] {
    if (this.#buffer.byteLength === 0) return [];
    if (this.#buffer.byteLength > this.#maxLineBytes) {
      throw new CodexError("PROTOCOL_LIMIT", "Codex JSONL line exceeded its byte limit");
    }
    const value = this.#parse(this.#buffer);
    this.#buffer = new Uint8Array(0);
    return [value];
  }

  #parse(bytes: Uint8Array): unknown {
    let text: string;
    try {
      text = this.#textDecoder.decode(bytes);
    } catch (error) {
      throw new CodexError("PROTOCOL_ERROR", "Codex emitted invalid UTF-8", { cause: error });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new CodexError("PROTOCOL_ERROR", "Codex emitted invalid JSON", { cause: error });
    }
  }
}

function boundedLimit(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 64 * 1024 * 1024) {
    throw new CodexError("INVALID_INPUT", "JSONL limits must be positive bounded integers");
  }
  return selected;
}
