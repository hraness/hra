export interface CodexJsonlSink {
  write(bytes: Uint8Array): number | Promise<number>;
  flush?(): number | Promise<number>;
}

export class CodexJsonlWriter {
  readonly #encoder = new TextEncoder();
  readonly #sink: CodexJsonlSink;
  #tail: Promise<void> = Promise.resolve();
  #fault: Error | null = null;
  #closing = false;
  #closed = false;

  constructor(sink: CodexJsonlSink) {
    this.#sink = sink;
  }

  write(message: unknown): Promise<void> {
    if (this.#fault !== null) return Promise.reject(this.#fault);
    if (this.#closing || this.#closed) {
      return Promise.reject(new Error("Codex JSONL writer is closed"));
    }
    let json: string | undefined;
    try {
      json = JSON.stringify(message);
    } catch {
      return Promise.reject(new Error("Codex JSONL message is not serializable"));
    }
    if (json === undefined) return Promise.reject(new Error("Codex JSONL message is not serializable"));
    const bytes = this.#encoder.encode(`${json}\n`);
    const operation = this.#tail.then(async () => {
      if (this.#fault !== null) throw this.#fault;
      if (this.#closed) throw new Error("Codex JSONL writer is closed");
      await this.#sink.write(bytes);
      if (this.#sink.flush !== undefined) await this.#sink.flush();
    });
    const exposed = operation.catch(() => {
      if (this.#fault === null) this.#fault = new Error("Codex JSONL writer failed");
      throw this.#fault;
    });
    this.#tail = exposed.catch(() => undefined);
    return exposed;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;
    const pending = this.#tail;
    await pending;
    this.#closed = true;
  }
}
