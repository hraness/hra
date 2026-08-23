import { timingSafeEqual, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, rename, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { basename, dirname, join } from "node:path";

import { commandEnvelopeSchema, commandResponseSchema, type CommandResponse, type LocalCommand } from "../domain/contracts";
import { ensurePrivateDirectory, type StatePaths } from "../storage/paths";

const maximumRequestBytes = 1_048_576;
const maximumResponseBytes = 4_194_304;
// The pinned Codex adapter may perform bounded capability discovery plus one
// 30-second provider mutation. The local exchange must outlive that complete
// descriptor so a client never times out while an effect is still settling.
const defaultDeadlineMs = 180_000;

type Handler = (command: LocalCommand, context: { requestId: string; signal: AbortSignal; afterResponse(callback: () => void): void }) => Promise<unknown>;

const currentUid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

async function validateOwnedFile(path: string, kind: "file" | "socket", mode?: number): Promise<void> {
  const metadata = await lstat(path);
  const expected = kind === "file" ? metadata.isFile() : metadata.isSocket();
  if (!expected || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`Unsafe local ${kind}: ${path}`);
  }
  const uid = currentUid();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error(`Local ${kind} is owned by another user: ${path}`);
  }
  if (mode !== undefined && (metadata.mode & 0o777) !== mode) {
    throw new Error(`Local ${kind} has unsafe permissions: ${path}`);
  }
}

async function removeStaleEndpoint(paths: StatePaths): Promise<void> {
  for (const [path, kind] of [[paths.socket, "socket"], [paths.capability, "file"]] as const) {
    try {
      await validateOwnedFile(path, kind);
      await unlink(path);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function publishCapability(paths: StatePaths, capability: string): Promise<void> {
  const temporary = join(dirname(paths.capability), `.${basename(paths.capability)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${capability}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, paths.capability);
  await validateOwnedFile(paths.capability, "file", 0o600);
}

const publicFailureCodes = [
  "INVALID_INPUT",
  "NOT_FOUND",
  "AMBIGUOUS",
  "CONFLICT",
  "INTERACTION_REQUIRED",
  "UNAVAILABLE",
  "RECOVERY_REQUIRED",
  "INTERNAL",
] as const;

type PublicFailureCode = typeof publicFailureCodes[number];

export const commandFailureBrand = Symbol("hra.command-failure");

const publicFailureMessages = {
  INVALID_INPUT: "The local command was rejected as invalid.",
  NOT_FOUND: "No matching object was found.",
  AMBIGUOUS: "The selector matches more than one object.",
  CONFLICT: "The local command conflicts with current authority.",
  INTERACTION_REQUIRED: "The local command requires an explicit interaction.",
  UNAVAILABLE: "A required local or provider capability is unavailable.",
  RECOVERY_REQUIRED: "The local command requires recovery before it can continue.",
  INTERNAL: "The local request failed before a safe diagnostic was available.",
} as const satisfies Readonly<Record<PublicFailureCode, string>>;

type DeclaredCommandFailure = Error & Readonly<{
  [commandFailureBrand]: true;
  code: PublicFailureCode;
  details?: unknown;
}>;

const declaredCommandFailure = (error: unknown): error is DeclaredCommandFailure =>
  error instanceof Error
  && commandFailureBrand in error
  && error[commandFailureBrand] === true
  && "code" in error
  && publicFailureCodes.includes(error.code as PublicFailureCode);

const safeResponse = (requestId: string, error: unknown): CommandResponse => {
  const publicFailure = declaredCommandFailure(error);
  const code = publicFailure
    ? error.code
    : "INTERNAL";
  return {
    ok: false,
    version: 1,
    requestId,
    error: {
      code,
      message: publicFailureMessages[code],
      ...(publicFailure
        && code !== "INTERNAL"
        && error.details !== undefined
        ? { details: error.details }
        : {}),
    },
  };
};

export class LocalDaemonServer {
  readonly #paths: StatePaths;
  readonly #capability: string;
  readonly #server: Server;
  readonly #handler: Handler;
  readonly #deadlineMs: number;
  readonly #inFlight = new Set<Promise<void>>();
  readonly #sockets = new Set<Socket>();
  readonly #controllers = new Set<AbortController>();
  #accepting = true;
  #listenerClosed: Promise<void> | undefined;

  private constructor(paths: StatePaths, capability: string, handler: Handler, deadlineMs: number) {
    this.#paths = paths;
    this.#capability = capability;
    this.#handler = handler;
    this.#deadlineMs = deadlineMs;
    this.#server = createServer((socket) => this.#accept(socket));
    this.#server.maxConnections = 32;
  }

  static async start(input: { paths: StatePaths; handler: Handler; deadlineMs?: number }): Promise<LocalDaemonServer> {
    await ensurePrivateDirectory(input.paths.runtime);
    await removeStaleEndpoint(input.paths);
    const capability = randomBytes(32).toString("base64url");
    await publishCapability(input.paths, capability);
    const owned = new LocalDaemonServer(input.paths, capability, input.handler, input.deadlineMs ?? defaultDeadlineMs);
    try {
      await new Promise<void>((resolve, reject) => {
        owned.#server.once("error", reject);
        owned.#server.listen(input.paths.socket, () => {
          owned.#server.off("error", reject);
          resolve();
        });
      });
      await chmod(input.paths.socket, 0o600);
      await validateOwnedFile(input.paths.socket, "socket", 0o600);
      return owned;
    } catch (error: unknown) {
      await removeStaleEndpoint(input.paths).catch(() => undefined);
      throw error;
    }
  }

  #accept(socket: Socket): void {
    if (!this.#accepting) {
      socket.destroy();
      return;
    }
    this.#sockets.add(socket);
    const controller = new AbortController();
    this.#controllers.add(controller);
    let received = Buffer.alloc(0);
    let handled = false;
    const deadline = setTimeout(() => {
      controller.abort(new Error("Local request deadline exceeded."));
      socket.destroy();
    }, this.#deadlineMs);
    deadline.unref();
    const settleSocket = () => {
      clearTimeout(deadline);
      controller.abort(new Error("Local client disconnected."));
      this.#sockets.delete(socket);
      this.#controllers.delete(controller);
    };
    socket.once("close", settleSocket);
    socket.once("end", () => {
      controller.abort(new Error("Local client disconnected."));
      if (!socket.destroyed) socket.destroy();
    });
    socket.on("data", (chunk) => {
      if (!this.#accepting) {
        socket.destroy();
        return;
      }
      if (handled) {
        const trailing = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (trailing.some((byte) => byte !== 0x0a && byte !== 0x0d && byte !== 0x20 && byte !== 0x09)) {
          socket.destroy(new Error("Local connection must carry exactly one request."));
        }
        return;
      }
      received = Buffer.concat([received, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (received.byteLength > maximumRequestBytes) {
        socket.destroy(new Error("Local request exceeds the byte limit."));
        return;
      }
      const newline = received.indexOf(0x0a);
      if (newline < 0) return;
      handled = true;
      const trailing = received.subarray(newline + 1);
      if (trailing.some((byte) => byte !== 0x0a && byte !== 0x0d && byte !== 0x20 && byte !== 0x09)) {
        socket.destroy(new Error("Local connection must carry exactly one request."));
        return;
      }
      const task = this.#handleFrame(socket, received.subarray(0, newline), controller.signal);
      this.#inFlight.add(task);
      void task.then(
        () => this.#inFlight.delete(task),
        () => this.#inFlight.delete(task),
      );
    });
  }

  async #handleFrame(socket: Socket, frame: Buffer, signal: AbortSignal): Promise<void> {
    let requestId: string = randomUUID();
    let response: CommandResponse;
    const afterResponse: Array<() => void> = [];
    try {
      const parsedJson = JSON.parse(frame.toString("utf8")) as unknown;
      if (typeof parsedJson === "object" && parsedJson !== null && "requestId" in parsedJson && typeof parsedJson.requestId === "string") {
        requestId = parsedJson.requestId;
      }
      const envelope = commandEnvelopeSchema.parse(parsedJson);
      requestId = envelope.requestId;
      const expected = Buffer.from(this.#capability);
      const provided = Buffer.from(envelope.capability);
      if (expected.byteLength !== provided.byteLength || !timingSafeEqual(expected, provided)) {
        throw new Error("Local capability was rejected.");
      }
      const data = await this.#handler(envelope.command, { requestId, signal, afterResponse: (callback) => afterResponse.push(callback) });
      response = { ok: true, version: 1, requestId, data };
    } catch (error: unknown) {
      response = safeResponse(requestId, error);
    }
    const bytes = Buffer.from(`${JSON.stringify(response)}\n`, "utf8");
    if (bytes.byteLength > maximumResponseBytes) {
      response = safeResponse(requestId, new Error("Local response exceeds the byte limit."));
    }
    if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`, () => {
      for (const callback of afterResponse) callback();
    });
  }

  beginShutdown(reason: Error = new Error("Local daemon transport is closing.")): void {
    if (!this.#accepting) return;
    this.#accepting = false;
    this.#listenerClosed = new Promise<void>((resolve, reject) => {
      this.#server.close((error) => error === undefined ? resolve() : reject(error));
    });
    for (const controller of this.#controllers) controller.abort(reason);
    for (const socket of this.#sockets) socket.destroy();
  }

  async close(input: { deadlineMs?: number } = {}): Promise<void> {
    this.beginShutdown();
    const deadlineMs = input.deadlineMs ?? 5_000;
    const listenerClosed = this.#listenerClosed ?? Promise.resolve();
    const settled = Promise.all([listenerClosed, Promise.allSettled([...this.#inFlight])]).then(() => undefined);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let settleError: Error | undefined;
    try {
      await Promise.race([
        settled,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new LocalDaemonShutdownTimeoutError(deadlineMs)), deadlineMs);
        }),
      ]);
    } catch (error: unknown) {
      settleError = error instanceof Error ? error : new Error("Local daemon transport settled with a non-Error failure.");
    }
    if (deadline !== undefined) clearTimeout(deadline);
    let endpointError: Error | undefined;
    try { await removeStaleEndpoint(this.#paths); } catch (error: unknown) {
      endpointError = error instanceof Error ? error : new Error("Local daemon endpoint cleanup failed with a non-Error value.");
    }
    if (settleError !== undefined) throw settleError;
    if (endpointError !== undefined) throw endpointError;
  }
}

export class LocalDaemonShutdownTimeoutError extends Error {
  readonly code = "LOCAL_DAEMON_SHUTDOWN_TIMEOUT" as const;

  constructor(deadlineMs: number) {
    super(`The local daemon transport did not settle within ${deadlineMs}ms.`);
    this.name = "LocalDaemonShutdownTimeoutError";
  }
}

async function readCapability(path: string): Promise<string> {
  await validateOwnedFile(path, "file", 0o600);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (metadata.size > 128) throw new Error("Local capability file is oversized.");
    const value = (await handle.readFile("utf8")).trim();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new Error("Local capability file is malformed.");
    return value;
  } finally {
    await handle.close();
  }
}

const throwIfClientAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) {
    throw signal.reason ?? new DOMException("The local daemon request was aborted.", "AbortError");
  }
};

export async function callLocalDaemon(input: {
  paths: StatePaths;
  command: LocalCommand;
  deadlineMs?: number;
  signal?: AbortSignal;
}): Promise<CommandResponse> {
  throwIfClientAborted(input.signal);
  let capability: string;
  try {
    capability = await readCapability(input.paths.capability);
    await validateOwnedFile(input.paths.socket, "socket", 0o600);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new LocalDaemonUnavailableError("The local daemon endpoint is absent.", error);
    throw error;
  }
  throwIfClientAborted(input.signal);
  const requestId = randomUUID();
  const request = `${JSON.stringify({ version: 1, capability, requestId, command: input.command })}\n`;
  return await new Promise<CommandResponse>((resolvePromise, rejectPromise) => {
    let settled = false;
    let connected = false;
    let received = Buffer.alloc(0);
    const socket = createConnection(input.paths.socket);
    const destroyImmediately = (): void => {
      if (typeof socket.resetAndDestroy === "function") socket.resetAndDestroy();
      else socket.destroy();
    };
    const settle = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      input.signal?.removeEventListener("abort", onAbort);
      operation();
    };
    const deadline = setTimeout(() => {
      settle(() => rejectPromise(connected
        ? new LocalDaemonIndeterminateError("The HRA daemon did not respond before the deadline.")
        : new LocalDaemonUnavailableError("The HRA daemon was unavailable before the request deadline.")));
      destroyImmediately();
    }, input.deadlineMs ?? defaultDeadlineMs);
    deadline.unref();
    const onAbort = () => {
      settle(() => rejectPromise(connected
        ? new LocalDaemonIndeterminateError("The local daemon request was aborted after dispatch became possible.", input.signal?.reason)
        : input.signal?.reason ?? new DOMException("The local daemon request was aborted.", "AbortError")));
      destroyImmediately();
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted === true) {
      onAbort();
      return;
    }
    socket.once("connect", () => {
      if (settled) {
        socket.destroy();
        return;
      }
      connected = true;
      socket.write(request);
    });
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (received.byteLength > maximumResponseBytes) {
        settle(() => rejectPromise(new LocalDaemonIndeterminateError("The HRA daemon returned an oversized response.")));
        socket.destroy();
        return;
      }
      const newline = received.indexOf(0x0a);
      if (newline < 0) return;
      try {
        const response = commandResponseSchema.parse(JSON.parse(received.subarray(0, newline).toString("utf8")) as unknown);
        settle(() => resolvePromise(response));
      } catch (error: unknown) {
        settle(() => rejectPromise(new LocalDaemonIndeterminateError("The HRA daemon returned an invalid response.", error)));
      } finally {
        socket.end();
      }
    });
    socket.once("error", (error) => settle(() => {
      if (!connected && ["ENOENT", "ECONNREFUSED", "ECONNRESET"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        rejectPromise(new LocalDaemonUnavailableError("The local daemon was unavailable before request dispatch.", error));
        return;
      }
      rejectPromise(connected
        ? new LocalDaemonIndeterminateError("The local daemon connection failed after request dispatch became possible.", error)
        : error);
    }));
    socket.once("close", () => {
      if (!settled) settle(() => rejectPromise(connected
        ? new LocalDaemonIndeterminateError("The HRA daemon closed the connection without a response.")
        : new LocalDaemonUnavailableError("The local daemon connection closed before request dispatch.")));
    });
  });
}

export class LocalDaemonUnavailableError extends Error {
  readonly code = "LOCAL_DAEMON_UNAVAILABLE" as const;
  readonly phase = "pre_connect" as const;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "LocalDaemonUnavailableError";
  }
}

export class LocalDaemonIndeterminateError extends Error {
  readonly code = "LOCAL_DAEMON_INDETERMINATE" as const;
  readonly phase = "after_connect" as const;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "LocalDaemonIndeterminateError";
  }
}

export function isLocalDaemonUnavailable(error: unknown): error is LocalDaemonUnavailableError {
  return error instanceof LocalDaemonUnavailableError;
}

export async function callWithSafeAutostart<T>(attempt: () => Promise<T>, start: () => Promise<void>): Promise<T> {
  try {
    return await attempt();
  } catch (error: unknown) {
    if (!isLocalDaemonUnavailable(error)) throw error;
    await start();
    return await attempt();
  }
}
