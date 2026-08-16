import {
  JsonLineDecoder,
  ProtocolViolation,
  errorMessage,
  isJsonObject,
  isJsonRpcId,
  parseProtocolLine,
  type JsonObject,
  type JsonRpcId,
} from "./jsonl";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_STDERR_CHARS = 16_384;

export interface AppServerLaunchOptions {
  readonly command: readonly [string, ...Array<string>];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface ObservedMessage {
  readonly ordinal: number;
  readonly receivedAtMs: number;
  readonly value: JsonObject;
}

export interface ShutdownEvidence {
  readonly mode: "stdin-eof" | "sigterm" | "sigkill";
  readonly exitCode: number;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface MessageWaiter {
  readonly afterOrdinal: number;
  readonly predicate: (message: ObservedMessage) => boolean;
  readonly resolve: (message: ObservedMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class RemoteRpcError extends Error {
  override readonly name = "RemoteRpcError";
  readonly method: string;
  readonly payload: JsonObject;

  constructor(method: string, payload: JsonObject) {
    super(`app-server rejected ${method}: ${formatRemoteError(payload)}`);
    this.method = method;
    this.payload = payload;
  }
}

export class CodexAppServerClient {
  readonly #child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  readonly #messages: Array<ObservedMessage> = [];
  readonly #waiters = new Set<MessageWaiter>();
  readonly #readerTask: Promise<void>;
  readonly #stderrTask: Promise<void>;
  readonly #exitTask: Promise<void>;
  #fatalError: Error | null = null;
  #nextRequestId = 1;
  #nextOrdinal = 1;
  #stderr = "";
  #closed = false;
  #shutdownEvidence: ShutdownEvidence | null = null;

  private constructor(options: AppServerLaunchOptions) {
    this.#child = Bun.spawn({
      cmd: [...options.command],
      cwd: options.cwd,
      env: { ...options.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.#readerTask = this.#readStdout();
    this.#stderrTask = this.#readStderr();
    this.#exitTask = this.#observeExit();
  }

  static launch(options: AppServerLaunchOptions): CodexAppServerClient {
    return new CodexAppServerClient(options);
  }

  get lastOrdinal(): number {
    return this.#nextOrdinal - 1;
  }

  get stderrTail(): string {
    return redactDiagnostic(this.#stderr);
  }

  messagesAfter(ordinal: number): ReadonlyArray<ObservedMessage> {
    return this.#messages.filter((message) => message.ordinal > ordinal);
  }

  async request(
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    this.#throwIfUnavailable();
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;

    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`timed out waiting ${timeoutMs} ms for ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
    });

    try {
      this.#write({ id, method, params });
    } catch (error: unknown) {
      const pending = this.#pending.get(id);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.#pending.delete(id);
      }
      throw error;
    }

    return response;
  }

  notify(method: string, params?: unknown): void {
    this.#throwIfUnavailable();
    this.#write(params === undefined ? { method } : { method, params });
  }

  respondResult(id: JsonRpcId, result: unknown): void {
    this.#throwIfUnavailable();
    this.#write({ id, result });
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    this.#throwIfUnavailable();
    this.#write({ id, error: { code, message } });
  }

  waitForMessage(
    predicate: (message: ObservedMessage) => boolean,
    options: { readonly afterOrdinal?: number; readonly timeoutMs?: number } = {},
  ): Promise<ObservedMessage> {
    this.#throwIfUnavailable();
    const afterOrdinal = options.afterOrdinal ?? 0;
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const existing = this.#messages.find(
      (message) => message.ordinal > afterOrdinal && predicate(message),
    );
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }

    return new Promise<ObservedMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        reject(new Error(`timed out waiting ${timeoutMs} ms for app-server message`));
      }, timeoutMs);
      const waiter: MessageWaiter = {
        afterOrdinal,
        predicate,
        resolve,
        reject,
        timer,
      };
      this.#waiters.add(waiter);
    });
  }

  async close(timeoutMs = 2_000): Promise<ShutdownEvidence> {
    if (this.#closed) {
      await this.#settleReaders();
      if (this.#shutdownEvidence === null) {
        const exitCode = await this.#child.exited;
        this.#shutdownEvidence = { mode: "stdin-eof", exitCode };
      }
      return this.#shutdownEvidence;
    }
    this.#closed = true;
    await this.#child.stdin.end();

    let mode: ShutdownEvidence["mode"] = "stdin-eof";
    const exited = await waitForExit(this.#child, timeoutMs);
    if (!exited) {
      mode = "sigterm";
      this.#child.kill("SIGTERM");
      const terminated = await waitForExit(this.#child, timeoutMs);
      if (!terminated) {
        mode = "sigkill";
        this.#child.kill("SIGKILL");
      }
    }
    const exitCode = await this.#child.exited;
    this.#shutdownEvidence = { mode, exitCode };
    await this.#settleReaders();
    return this.#shutdownEvidence;
  }

  #write(message: JsonObject): void {
    const encoded = `${JSON.stringify(message)}\n`;
    void Promise.resolve(this.#child.stdin.write(encoded)).catch((error: unknown) => {
      this.#fail(new Error(`failed writing app-server stdin: ${errorMessage(error)}`));
    });
    void Promise.resolve(this.#child.stdin.flush()).catch((error: unknown) => {
      this.#fail(new Error(`failed flushing app-server stdin: ${errorMessage(error)}`));
    });
  }

  async #readStdout(): Promise<void> {
    const decoder = new JsonLineDecoder();
    try {
      const reader = this.#child.stdout.getReader();
      while (true) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
        for (const line of decoder.push(next.value)) {
          this.#acceptLine(line);
        }
      }
      for (const line of decoder.finish()) {
        this.#acceptLine(line);
      }
    } catch (error: unknown) {
      this.#fail(
        error instanceof ProtocolViolation
          ? error
          : new ProtocolViolation(`failed reading app-server stdout: ${errorMessage(error)}`),
      );
    }
  }

  async #readStderr(): Promise<void> {
    const decoder = new TextDecoder();
    const reader = this.#child.stderr.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      this.#stderr = keepTail(this.#stderr + decoder.decode(next.value, { stream: true }));
    }
    this.#stderr = keepTail(this.#stderr + decoder.decode());
  }

  #acceptLine(line: string): void {
    const value = parseProtocolLine(line);
    if (typeof value.method === "string") {
      this.#observeMessage(value);
      return;
    }

    if (!isJsonRpcId(value.id)) {
      throw new ProtocolViolation("response id was invalid after envelope validation");
    }
    const pending = this.#pending.get(value.id);
    if (pending === undefined) {
      throw new ProtocolViolation(`received response for unknown request id ${String(value.id)}`);
    }
    clearTimeout(pending.timer);
    this.#pending.delete(value.id);
    if (Object.hasOwn(value, "error")) {
      if (!isJsonObject(value.error)) {
        pending.reject(new ProtocolViolation("response error must be an object"));
        return;
      }
      pending.reject(new RemoteRpcError(pending.method, value.error));
      return;
    }
    pending.resolve(value.result);
  }

  #observeMessage(value: JsonObject): void {
    const observed: ObservedMessage = {
      ordinal: this.#nextOrdinal,
      receivedAtMs: Date.now(),
      value,
    };
    this.#nextOrdinal += 1;
    this.#messages.push(observed);
    for (const waiter of this.#waiters) {
      if (observed.ordinal > waiter.afterOrdinal && waiter.predicate(observed)) {
        clearTimeout(waiter.timer);
        this.#waiters.delete(waiter);
        waiter.resolve(observed);
      }
    }
  }

  async #observeExit(): Promise<void> {
    const exitCode = await this.#child.exited;
    if (!this.#closed && (exitCode !== 0 || this.#pending.size > 0 || this.#waiters.size > 0)) {
      this.#fail(new Error(`app-server exited unexpectedly with code ${exitCode}`));
    }
  }

  #fail(error: Error): void {
    if (this.#fatalError !== null) {
      return;
    }
    this.#fatalError = error;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      this.#waiters.delete(waiter);
    }
  }

  #throwIfUnavailable(): void {
    if (this.#fatalError !== null) {
      throw this.#fatalError;
    }
    if (this.#closed) {
      throw new Error("app-server client is closed");
    }
  }

  async #settleReaders(): Promise<void> {
    await Promise.allSettled([this.#readerTask, this.#stderrTask, this.#exitTask]);
  }
}

function formatRemoteError(error: JsonObject): string {
  const code = typeof error.code === "number" ? `code ${error.code}` : "unknown code";
  const message = typeof error.message === "string" ? error.message : "unknown error";
  return `${code}: ${message}`;
}

function keepTail(value: string): string {
  return value.length <= MAX_STDERR_CHARS ? value : value.slice(-MAX_STDERR_CHARS);
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*)([^\s]+)/giu, "$1[REDACTED]")
    .replace(/((?:access|refresh|id)[_-]?token\s*[:=]\s*)([^\s]+)/giu, "$1[REDACTED]")
    .replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]*/gu, "$1…[REDACTED]");
}

async function waitForExit(
  child: Bun.Subprocess<"pipe", "pipe", "pipe">,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  return Promise.race([child.exited.then(() => true), timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}
