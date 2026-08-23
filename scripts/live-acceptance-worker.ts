#!/usr/bin/env bun

import type { Readable, Writable } from "node:stream";
import { isatty } from "node:tty";

import { callLocalDaemon } from "../src/daemon/local-transport";
import { waitForDaemonReady } from "../src/daemon/daemon-startup";
import { main as cliMain, runDaemon } from "../src/cli";
import type { Output } from "../src/cli/render";
import type { CommandResponse } from "../src/domain/contracts";
import {
  createAcceptanceInstallation,
  type AcceptanceInstallationDescriptor,
} from "./live-acceptance-installation";
import {
  assertAcceptanceDescriptorLayout,
  LIVE_ACCEPTANCE_CONTROL_FD,
  LIVE_ACCEPTANCE_CONTROL_MAXIMUM_BYTES,
  LIVE_ACCEPTANCE_DESCRIPTOR_MAXIMUM_BYTES,
  LIVE_ACCEPTANCE_STATUS_FD,
  LIVE_ACCEPTANCE_STATUS_MAXIMUM_BYTES,
  liveAcceptanceWorkerControlSchema,
  liveAcceptanceWorkerStatusSchema,
  type LiveAcceptanceWorkerStatus,
} from "./live-acceptance";

class WorkerFailure extends Error {
  constructor(readonly code: Extract<LiveAcceptanceWorkerStatus, { type: "failed" }>["code"]) {
    super(code);
    this.name = "WorkerFailure";
  }
}

type InputFailureCode = "control_invalid" | "descriptor_invalid";

class WorkerInput {
  readonly #stream: Readable;
  readonly #iterator: AsyncIterator<unknown>;
  #buffer = Buffer.alloc(0);
  #ended = false;

  constructor() {
    if (isatty(LIVE_ACCEPTANCE_CONTROL_FD)) {
      throw new WorkerFailure("descriptor_invalid");
    }
    this.#stream = process.stdin;
    this.#iterator = this.#stream[Symbol.asyncIterator]();
  }

  async readFrame(
    maximumBytes: number,
    failureCode: InputFailureCode,
  ): Promise<Buffer | null> {
    for (;;) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline >= 0) {
        if (newline === 0 || newline + 1 > maximumBytes) {
          throw new WorkerFailure(failureCode);
        }
        const line = Buffer.from(this.#buffer.subarray(0, newline));
        const remainder = Buffer.from(this.#buffer.subarray(newline + 1));
        this.#buffer.fill(0);
        this.#buffer = remainder;
        return line;
      }
      if (this.#buffer.byteLength >= maximumBytes) {
        throw new WorkerFailure(failureCode);
      }
      if (this.#ended) {
        if (this.#buffer.byteLength !== 0) throw new WorkerFailure(failureCode);
        return null;
      }
      let next: IteratorResult<unknown>;
      try {
        next = await this.#iterator.next();
      } catch {
        throw new WorkerFailure(failureCode);
      }
      if (next.done) {
        this.#ended = true;
        continue;
      }
      const chunk = Buffer.isBuffer(next.value)
        ? next.value
        : Buffer.from(next.value as Uint8Array);
      if (chunk.byteLength === 0) continue;
      const prior = this.#buffer;
      if (chunk.byteLength > LIVE_ACCEPTANCE_CONTROL_MAXIMUM_BYTES - prior.byteLength) {
        prior.fill(0);
        chunk.fill(0);
        this.#buffer = Buffer.alloc(0);
        throw new WorkerFailure(failureCode);
      }
      this.#buffer = Buffer.concat([prior, chunk]);
      prior.fill(0);
      chunk.fill(0);
    }
  }

  destroy(): void {
    this.#buffer.fill(0);
    this.#buffer = Buffer.alloc(0);
    this.#stream.destroy();
  }
}

async function readDescriptor(input: WorkerInput): Promise<unknown> {
  const frame = await input.readFrame(
    LIVE_ACCEPTANCE_DESCRIPTOR_MAXIMUM_BYTES,
    "descriptor_invalid",
  );
  if (frame === null) throw new WorkerFailure("descriptor_invalid");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame)) as unknown;
  } catch {
    throw new WorkerFailure("descriptor_invalid");
  } finally {
    frame.fill(0);
  }
}

class StatusWriter {
  readonly #stream: Writable;
  #tail = Promise.resolve();

  constructor() {
    if (isatty(LIVE_ACCEPTANCE_STATUS_FD)) {
      throw new WorkerFailure("status_unavailable");
    }
    this.#stream = process.stdout;
  }

  write(statusInput: LiveAcceptanceWorkerStatus): Promise<void> {
    const status = liveAcceptanceWorkerStatusSchema.parse(statusInput);
    const frame = `${JSON.stringify(status)}\n`;
    if (Buffer.byteLength(frame, "utf8") > LIVE_ACCEPTANCE_STATUS_MAXIMUM_BYTES) {
      return Promise.reject(new WorkerFailure("status_unavailable"));
    }
    const operation = this.#tail.then(async () => {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        this.#stream.write(frame, (error) => {
          if (error === undefined || error === null) resolvePromise();
          else rejectPromise(error);
        });
      });
    });
    this.#tail = operation.catch(() => undefined);
    return operation;
  }

  async close(): Promise<void> {
    await this.#tail;
    await new Promise<void>((resolvePromise) => this.#stream.end(resolvePromise));
  }
}

type ControlOutcome = "parent_closed" | "stop_requested";

const deferred = <T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
} => {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, reject: rejectPromise, resolve: resolvePromise };
};

async function beforeDeadline<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new WorkerFailure("daemon_failed")), milliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const responseRequiresRestart = (response: CommandResponse): boolean =>
  response.ok
  && response.data !== null
  && typeof response.data === "object"
  && "daemonRestartRequired" in response.data
  && response.data.daemonRestartRequired === true;

type GenerationStopReason = "parent_closed" | "restart" | "stop" | "suspend";

type DaemonGeneration = {
  expectedStop: GenerationStopReason | null;
  promise: Promise<number>;
};

class DaemonSupervisor {
  readonly #descriptor: AcceptanceInstallationDescriptor;
  readonly #installation: ReturnType<typeof createAcceptanceInstallation>;
  readonly #failure = deferred<never>();
  #failureError: Error | undefined;
  #generation: DaemonGeneration | undefined;
  #suspended = false;

  constructor(descriptor: AcceptanceInstallationDescriptor) {
    this.#descriptor = descriptor;
    this.#installation = createAcceptanceInstallation(descriptor);
    void this.#failure.promise.catch(() => undefined);
  }

  get failure(): Promise<never> {
    return this.#failure.promise;
  }

  async start(): Promise<void> {
    if (this.#generation !== undefined || this.#suspended) {
      throw new WorkerFailure("daemon_failed");
    }
    const generation: DaemonGeneration = {
      expectedStop: null,
      promise: runDaemon(this.#installation),
    };
    this.#generation = generation;
    void generation.promise.then(
      (exitCode) => {
        if (exitCode !== 0 || generation.expectedStop === null) {
          this.#fail(new WorkerFailure("daemon_failed"));
        }
      },
      () => this.#fail(new WorkerFailure("daemon_failed")),
    );
    try {
      await Promise.race([
        waitForDaemonReady({
          deadlineMs: 30_000,
          paths: this.#installation.paths,
          queryStatus: async () => await callLocalDaemon({
            command: { kind: "daemon.status" },
            deadlineMs: 750,
            paths: this.#installation.paths,
          }),
        }),
        generation.promise.then(() => { throw new WorkerFailure("daemon_failed"); }),
        this.#failure.promise,
      ]);
    } catch (error: unknown) {
      generation.expectedStop ??= "stop";
      signalDaemon();
      await beforeDeadline(generation.promise, 30_000).catch(() => undefined);
      throw error;
    }
    if (process.env.HOME !== this.#descriptor.expectedHomeDirectory) {
      throw new WorkerFailure("home_changed");
    }
  }

  async command(
    command: Parameters<typeof callLocalDaemon>[0]["command"],
    signal: AbortSignal,
  ): Promise<CommandResponse> {
    this.#assertRunning();
    const response = await Promise.race([
      callLocalDaemon({
        command,
        paths: this.#installation.paths,
        signal,
      }),
      this.#failure.promise,
    ]);
    if (responseRequiresRestart(response)) {
      const generation = this.#generation;
      if (generation === undefined || generation.expectedStop !== null) {
        throw new WorkerFailure("daemon_failed");
      }
      generation.expectedStop = "restart";
    }
    return response;
  }

  async restartAfterResponse(): Promise<void> {
    const generation = this.#generation;
    if (generation === undefined || generation.expectedStop !== "restart") return;
    await beforeDeadline(generation.promise, 30_000);
    if (this.#generation !== generation) throw new WorkerFailure("daemon_failed");
    this.#generation = undefined;
    await this.start();
  }

  async suspend(signal: AbortSignal): Promise<void> {
    if (this.#suspended || this.#generation === undefined) {
      throw new WorkerFailure("control_invalid");
    }
    await this.#stopGeneration("suspend", signal, true);
    this.#suspended = true;
  }

  async resume(): Promise<void> {
    if (!this.#suspended || this.#generation !== undefined) {
      throw new WorkerFailure("control_invalid");
    }
    this.#suspended = false;
    try {
      await this.start();
    } catch (error: unknown) {
      this.#suspended = true;
      throw error;
    }
  }

  async stop(reason: "parent_closed" | "stop", signal: AbortSignal): Promise<void> {
    if (this.#suspended) return;
    if (reason === "parent_closed" && this.#generation?.expectedStop === "parent_closed") {
      await this.#awaitStoppedGeneration(this.#generation);
      return;
    }
    await this.#stopGeneration(reason, signal, reason === "stop");
  }

  beginParentShutdown(): void {
    if (this.#suspended) return;
    const generation = this.#generation;
    if (generation === undefined) return;
    if (generation.expectedStop === null) {
      generation.expectedStop = "parent_closed";
      signalDaemon();
    }
  }

  async #stopGeneration(
    reason: GenerationStopReason,
    signal: AbortSignal,
    throughDaemonCommand: boolean,
  ): Promise<void> {
    const generation = this.#generation;
    if (generation === undefined || generation.expectedStop !== null) {
      throw new WorkerFailure("daemon_failed");
    }
    generation.expectedStop = reason;
    if (throughDaemonCommand) {
      const response = await callLocalDaemon({
        command: { kind: "daemon.stop" },
        deadlineMs: 5_000,
        paths: this.#installation.paths,
        signal,
      });
      if (!response.ok) throw new WorkerFailure("daemon_failed");
    } else {
      signalDaemon();
    }
    await this.#awaitStoppedGeneration(generation);
  }

  async #awaitStoppedGeneration(generation: DaemonGeneration): Promise<void> {
    const exitCode = await beforeDeadline(generation.promise, 30_000);
    if (exitCode !== 0 || this.#generation !== generation) {
      throw new WorkerFailure("daemon_failed");
    }
    this.#generation = undefined;
  }

  #assertRunning(): void {
    if (this.#failureError !== undefined) throw this.#failureError;
    if (this.#suspended || this.#generation === undefined || this.#generation.expectedStop !== null) {
      throw new WorkerFailure("daemon_failed");
    }
  }

  #fail(error: Error): void {
    if (this.#failureError !== undefined) return;
    this.#failureError = error;
    this.#failure.reject(error);
  }
}

class CapturedCliOutput implements Output {
  #stderr = "";
  #stdout = "";

  get result(): Readonly<{ stderr: string; stdout: string }> {
    return { stderr: this.#stderr, stdout: this.#stdout };
  }

  writeStderr(value: string): void {
    this.#stderr = this.#append(this.#stderr, value, 256 * 1024);
  }

  writeStdout(value: string): void {
    this.#stdout = this.#append(this.#stdout, value, 1024 * 1024);
  }

  async writeStdoutAsync(value: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    this.writeStdout(value);
  }

  #append(current: string, value: string, maximumBytes: number): string {
    const next = current + value;
    if (Buffer.byteLength(next, "utf8") > maximumBytes) {
      throw new WorkerFailure("status_unavailable");
    }
    return next;
  }
}

async function executeCliControl(
  control: Extract<ReturnType<typeof liveAcceptanceWorkerControlSchema.parse>, { type: "cli" }>,
  descriptor: AcceptanceInstallationDescriptor,
  supervisor: DaemonSupervisor,
  signal: AbortSignal,
): Promise<Readonly<{ restartRequired: boolean; result: { exitCode: number; stderr: string; stdout: string } }>> {
  if (control.argv[0] === "daemon" || control.argv[0] === "init") {
    throw new WorkerFailure("control_invalid");
  }
  const output = new CapturedCliOutput();
  let protectedInputConsumed = false;
  let restartRequired = false;
  const exitCode = await cliMain(control.argv, output, {
    callDaemon: async (command, commandSignal) => {
      const combinedSignal = commandSignal === undefined
        ? signal
        : AbortSignal.any([signal, commandSignal]);
      const response = await supervisor.command(command, combinedSignal);
      restartRequired ||= responseRequiresRestart(response);
      return response;
    },
    installation: createAcceptanceInstallation(descriptor),
    interactive: false,
    isTerminalDescriptor: (fd) => fd !== LIVE_ACCEPTANCE_CONTROL_FD,
    readProtectedDocument: async (source) => {
      if (
        source.kind !== "fd"
        || source.fd !== LIVE_ACCEPTANCE_CONTROL_FD
        || control.protectedInput === undefined
        || protectedInputConsumed
      ) throw new WorkerFailure("control_invalid");
      protectedInputConsumed = true;
      return control.protectedInput.document;
    },
  });
  if ((control.protectedInput !== undefined) !== protectedInputConsumed) {
    throw new WorkerFailure("control_invalid");
  }
  return { restartRequired, result: { exitCode, ...output.result } };
}

async function handleControl(
  control: ReturnType<typeof liveAcceptanceWorkerControlSchema.parse>,
  descriptor: AcceptanceInstallationDescriptor,
  status: StatusWriter,
  supervisor: DaemonSupervisor,
  signal: AbortSignal,
): Promise<ControlOutcome | null> {
  if (control.type === "stop") {
    await supervisor.stop("stop", signal);
    return "stop_requested";
  }
  if (control.type === "suspend") {
    await supervisor.suspend(signal);
    await status.write({
      action: "suspend",
      requestId: control.requestId,
      type: "ack",
      version: 1,
    });
    return null;
  }
  if (control.type === "resume") {
    await supervisor.resume();
    await status.write({
      action: "resume",
      requestId: control.requestId,
      type: "ack",
      version: 1,
    });
    return null;
  }
  if (control.type === "command") {
    const response = await supervisor.command(control.command, signal);
    await status.write({
      requestId: control.requestId,
      response,
      type: "command_result",
      version: 1,
    });
    if (responseRequiresRestart(response)) await supervisor.restartAfterResponse();
    return null;
  }
  const cli = await executeCliControl(control, descriptor, supervisor, signal);
  await status.write({
    requestId: control.requestId,
    result: cli.result,
    type: "cli_result",
    version: 1,
  });
  if (cli.restartRequired) await supervisor.restartAfterResponse();
  return null;
}

async function consumeControl(
  input: WorkerInput,
  descriptor: AcceptanceInstallationDescriptor,
  status: StatusWriter,
  supervisor: DaemonSupervisor,
): Promise<ControlOutcome> {
  const parentLifetime = new AbortController();
  const completed = deferred<ControlOutcome>();
  let pendingFrames = 0;
  let tail = Promise.resolve<ControlOutcome | null>(null);
  try {
    const readLoop = (async () => {
      try {
        for (;;) {
          const line = await input.readFrame(
            LIVE_ACCEPTANCE_CONTROL_MAXIMUM_BYTES,
            "control_invalid",
          );
          if (line === null) break;
          let control: ReturnType<typeof liveAcceptanceWorkerControlSchema.parse>;
          try {
            control = liveAcceptanceWorkerControlSchema.parse(
              JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)) as unknown,
            );
          } catch {
            throw new WorkerFailure("control_invalid");
          } finally {
            line.fill(0);
          }
          pendingFrames += 1;
          if (pendingFrames > 128) throw new WorkerFailure("control_invalid");
          tail = tail.then(async (prior) => {
            if (prior !== null) return prior;
            try {
              const outcome = await handleControl(
                control,
                descriptor,
                status,
                supervisor,
                parentLifetime.signal,
              );
              if (outcome !== null) completed.resolve(outcome);
              return outcome;
            } finally {
              pendingFrames -= 1;
            }
          });
          void tail.catch((error: unknown) => completed.reject(error));
        }
        parentLifetime.abort(new Error("The acceptance parent control pipe closed."));
        supervisor.beginParentShutdown();
        completed.resolve("parent_closed");
      } catch (error: unknown) {
        completed.reject(error);
      }
    })();
    const outcome = await Promise.race([completed.promise, supervisor.failure]);
    if (outcome === "parent_closed") {
      parentLifetime.abort(new Error("The acceptance parent control pipe closed."));
      supervisor.beginParentShutdown();
    }
    input.destroy();
    await readLoop.catch(() => undefined);
    await beforeDeadline(tail, 5_000).catch((error: unknown) => {
      if (outcome !== "parent_closed") throw error;
    });
    return outcome;
  } finally {
    parentLifetime.abort(new Error("The acceptance control lifetime ended."));
    input.destroy();
  }
}

const signalDaemon = (): void => {
  try {
    process.kill(process.pid, "SIGTERM");
  } catch {
    // The daemon may already have completed its bounded shutdown.
  }
};

async function workerMain(): Promise<number> {
  let status: StatusWriter | undefined;
  let input: WorkerInput | undefined;
  let descriptor: AcceptanceInstallationDescriptor | undefined;
  try {
    status = new StatusWriter();
    input = new WorkerInput();
    descriptor = await assertAcceptanceDescriptorLayout(await readDescriptor(input));
    if (process.env.HOME !== descriptor.expectedHomeDirectory) {
      throw new WorkerFailure("home_changed");
    }
    // Codex resolves its account-level credential-store policy from the app-server
    // startup directory. Bind that base config to the same isolated project used by
    // every config/read preflight, without changing HOME or carrying the path in argv.
    process.chdir(descriptor.documentsDirectory);
    if (process.cwd() !== descriptor.documentsDirectory) {
      throw new WorkerFailure("layout_invalid");
    }
    const supervisor = new DaemonSupervisor(descriptor);
    await supervisor.start();
    if (process.env.HOME !== descriptor.expectedHomeDirectory) {
      throw new WorkerFailure("home_changed");
    }
    await status.write({
      device: descriptor.device,
      pid: process.pid,
      runId: descriptor.runId,
      type: "ready",
      version: 1,
    });
    const outcome = await consumeControl(input, descriptor, status, supervisor);
    if (outcome === "parent_closed") {
      const shutdown = new AbortController();
      await supervisor.stop("parent_closed", shutdown.signal);
    }
    await status.write({
      device: descriptor.device,
      runId: descriptor.runId,
      type: "stopped",
      version: 1,
    });
    await status.close();
    return 0;
  } catch (error: unknown) {
    signalDaemon();
    const code = error instanceof WorkerFailure
      ? error.code
      : error instanceof Error && error.message === "home_changed"
        ? "home_changed"
        : "internal_failure";
    await status?.write({
      code,
      ...(descriptor === undefined
        ? {}
        : { device: descriptor.device, runId: descriptor.runId }),
      type: "failed",
      version: 1,
    }).catch(() => undefined);
    await status?.close().catch(() => undefined);
    return 1;
  } finally {
    input?.destroy();
  }
}

if (import.meta.main) process.exitCode = await workerMain();
