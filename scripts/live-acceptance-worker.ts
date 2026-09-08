#!/usr/bin/env bun

import type { Readable, Writable } from "node:stream";
import { isatty } from "node:tty";

import { z } from "zod";

import { callLocalDaemon } from "../src/daemon/local-transport";
import { waitForDaemonReady, type DaemonIdentity } from "../src/daemon/daemon-startup";
import {
  initialize,
  main as cliMain,
  runDaemon,
  type LiveAcceptanceClaudeProofPort,
} from "../src/cli";
import type { Output } from "../src/cli/render";
import type { CommandResponse, LocalCommand } from "../src/domain/contracts";
import { publicEffectiveClaudeRuntimeProfileSchema } from "../src/domain/runtime-profile";
import { profileIdSchema, projectIdSchema, sessionIdSchema } from "../src/domain/values";
import {
  createAcceptanceInstallation,
  type AcceptanceInstallationDescriptor,
} from "./live-acceptance-installation";
import {
  LiveAcceptanceMemoryFaultController,
  type LiveAcceptanceMemoryFaultArm,
  type LiveAcceptanceMemoryFaultFinalize,
  type LiveAcceptanceMemoryFaultStatus,
} from "./live-acceptance-memory-fault";
import {
  ClaudeLiveAcceptanceProofCollector,
  ClaudeLiveAcceptanceProofError,
  type ClaudeLiveAcceptancePrivateReceipt,
  type ClaudeLiveAcceptanceProvisionalPrivateReceipt,
} from "./claude-live-acceptance-proof";
import {
  assertAcceptanceDescriptorLayout,
  LIVE_ACCEPTANCE_CONTROL_FD,
  LIVE_ACCEPTANCE_CONTROL_MAXIMUM_BYTES,
  LIVE_ACCEPTANCE_DESCRIPTOR_MAXIMUM_BYTES,
  LIVE_ACCEPTANCE_STATUS_FD,
  LIVE_ACCEPTANCE_STATUS_MAXIMUM_BYTES,
  liveAcceptanceWorkerControlSchema,
  liveAcceptanceWorkerStatusSchema,
  type ClaudeLiveAcceptanceWorkerArm,
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
  controller: AbortController;
  expectedStop: GenerationStopReason | null;
  faultEnded: boolean;
  faultGeneration: number;
  identity?: DaemonIdentity;
  promise: Promise<number>;
};

type DaemonSupervisorDependencies = Readonly<{
  callLocalDaemon?: typeof callLocalDaemon;
  runDaemon?: typeof runDaemon;
  waitForDaemonReady?: typeof waitForDaemonReady;
}>;

type WorkerDependencies = DaemonSupervisorDependencies & Readonly<{
  initializeWorkerInstallation?: (
    descriptor: AcceptanceInstallationDescriptor,
  ) => Promise<void>;
}>;

type WorkerMode = "standard" | "claude_proof";

const workerModeFromArgv = (argv: readonly string[]): WorkerMode => {
  if (argv.length === 0) return "standard";
  if (argv.length === 1 && argv[0] === "--claude-proof") return "claude_proof";
  throw new WorkerFailure("descriptor_invalid");
};

const providerIdentifierSchema = z.string().min(1).max(512)
  .refine((value) => !/\p{Cc}|\p{Cs}/u.test(value));
const safeIntegerSchema = z.number().int().nonnegative().safe();
const rawClaudeSessionSchema = z.object({
  activeTurnId: providerIdentifierSchema.optional(),
  archivedAt: safeIntegerSchema.optional(),
  createdAt: safeIntegerSchema,
  fastEnabled: z.literal(false),
  id: sessionIdSchema,
  note: z.string(),
  preset: z.literal("fable-max"),
  profileId: profileIdSchema,
  projectId: projectIdSchema,
  provider: z.literal("claude"),
  providerThreadId: providerIdentifierSchema,
  providerUpdatedAt: safeIntegerSchema.optional(),
  revision: z.number().int().positive().safe(),
  state: z.enum(["starting", "active", "idle", "terminal", "recovery_required"]),
  title: z.string(),
  updatedAt: safeIntegerSchema,
}).strict();
const rawClaudeStartResultSchema = z.object({
  effectiveRuntimeProfile: publicEffectiveClaudeRuntimeProfileSchema,
  idempotencyKey: z.string().uuid(),
  session: rawClaudeSessionSchema,
}).strict();
const rawClaudeSendResultSchema = z.object({
  effectiveRuntimeProfile: publicEffectiveClaudeRuntimeProfileSchema,
  idempotencyKey: z.string().uuid(),
  session: rawClaudeSessionSchema,
  turnId: providerIdentifierSchema,
}).strict();

type CapturedFreshClaudeSession = Readonly<{
  profileGeneration: number;
  profileId: z.infer<typeof profileIdSchema>;
  providerThreadId: string;
  sessionId: z.infer<typeof sessionIdSchema>;
}>;

class WorkerClaudeProofController implements LiveAcceptanceClaudeProofPort {
  readonly #candidate: NonNullable<AcceptanceInstallationDescriptor["candidate"]>;
  readonly #runId: string;
  #collector: ClaudeLiveAcceptanceProofCollector | undefined;
  #generation: number | undefined;
  #closed = false;
  #closeError: ClaudeLiveAcceptanceProofError | undefined;
  #freshSession: CapturedFreshClaudeSession | undefined;
  #armedSession: Readonly<{
    sendIdempotencyKey: string;
    sessionId: z.infer<typeof sessionIdSchema>;
  }> | undefined;
  #observationError: ClaudeLiveAcceptanceProofError | undefined;

  constructor(input: Readonly<{
    candidate: NonNullable<AcceptanceInstallationDescriptor["candidate"]>;
    runId: string;
  }>) {
    this.#candidate = input.candidate;
    this.#runId = input.runId;
  }

  beginDaemonGeneration(generation: number): void {
    if (this.#closed || this.#generation !== undefined) {
      throw new ClaudeLiveAcceptanceProofError("generation_invalid");
    }
    this.#generation = generation;
  }

  observeCommandResponse(command: LocalCommand, response: CommandResponse): void {
    if (this.#closed || !response.ok) return;
    if (command.kind === "session.start") {
      this.#observeFreshSessionStart(command, response.data);
      return;
    }
    if (command.kind !== "session.send") return;
    const armed = this.#armedSession;
    if (
      armed === undefined
      || command.session !== armed.sessionId
      || command.idempotencyKey !== armed.sendIdempotencyKey
    ) return;
    if (this.#observationError !== undefined) return;
    const parsed = rawClaudeSendResultSchema.safeParse(response.data);
    if (
      !parsed.success
      || parsed.data.session.id !== armed.sessionId
      || parsed.data.idempotencyKey !== armed.sendIdempotencyKey
      || parsed.data.effectiveRuntimeProfile.profileId !== parsed.data.session.profileId
      || parsed.data.effectiveRuntimeProfile.processGeneration
        !== this.#freshSession?.profileGeneration
      || (
        parsed.data.session.state === "active"
        && parsed.data.session.activeTurnId !== parsed.data.turnId
      )
      || (
        parsed.data.session.state === "idle"
        && parsed.data.session.activeTurnId !== undefined
      )
    ) {
      this.#observationError = new ClaudeLiveAcceptanceProofError(
        "turn_corroboration_invalid",
      );
      return;
    }
    const generation = this.#generation;
    if (generation === undefined) {
      this.#observationError = new ClaudeLiveAcceptanceProofError("generation_invalid");
      return;
    }
    try {
      this.#requireCollector().corroborateAppliedSend({
        daemonGeneration: generation,
        idempotencyKey: parsed.data.idempotencyKey,
        sessionId: parsed.data.session.id,
        turnId: parsed.data.turnId,
      });
    } catch (error: unknown) {
      if (!(error instanceof ClaudeLiveAcceptanceProofError)) throw error;
      this.#observationError = error;
    }
  }

  armObservedFreshSession(input: ClaudeLiveAcceptanceWorkerArm): void {
    if (
      this.#closed
      || this.#collector !== undefined
      || this.#generation === undefined
      || input.daemonGeneration !== this.#generation
      || this.#observationError !== undefined
    ) throw this.#observationError
      ?? new ClaudeLiveAcceptanceProofError("session_scope_invalid");
    const fresh = this.#freshSession;
    if (
      fresh === undefined
      || fresh.sessionId !== input.sessionId
      || fresh.profileId !== input.profileId
      || fresh.profileGeneration !== input.profileGeneration
    ) throw new ClaudeLiveAcceptanceProofError("session_scope_invalid");
    const collector = new ClaudeLiveAcceptanceProofCollector({
      candidate: this.#candidate,
      runId: this.#runId,
    });
    collector.beginDaemonGeneration(this.#generation);
    collector.armFreshSession({
      ...input,
      providerThreadId: fresh.providerThreadId,
    });
    this.#collector = collector;
    this.#armedSession = Object.freeze({
      sendIdempotencyKey: input.sendIdempotencyKey,
      sessionId: input.sessionId,
    });
  }

  async handleManagedHostToolCall(
    input: Parameters<ClaudeLiveAcceptanceProofCollector["handleManagedHostToolCall"]>[0],
  ): ReturnType<ClaudeLiveAcceptanceProofCollector["handleManagedHostToolCall"]> {
    return await this.#requireCollector().handleManagedHostToolCall(input);
  }

  handleManagedHostToolResponseWritten(
    receipt: Parameters<ClaudeLiveAcceptanceProofCollector["handleManagedHostToolResponseWritten"]>[0],
  ): void {
    this.#requireCollector().handleManagedHostToolResponseWritten(receipt);
  }

  closeDaemonGeneration(generation: number | null): void {
    if (this.#closed) {
      if (generation !== this.#generation && this.#closeError === undefined) {
        this.#closeError = new ClaudeLiveAcceptanceProofError("generation_invalid");
      }
      return;
    }
    this.#closed = true;
    if (generation === null || generation !== this.#generation) {
      this.#closeError = new ClaudeLiveAcceptanceProofError("generation_invalid");
      return;
    }
    try {
      this.#collector?.closeDaemonGeneration(generation);
    } catch (error: unknown) {
      if (!(error instanceof ClaudeLiveAcceptanceProofError)) throw error;
      this.#closeError = error;
    }
  }

  readProvisionalPrivateReceipt(): ClaudeLiveAcceptanceProvisionalPrivateReceipt {
    if (this.#observationError !== undefined) throw this.#observationError;
    return this.#requireCollector().readProvisionalPrivateReceipt();
  }

  readPrivateReceipt(): ClaudeLiveAcceptancePrivateReceipt {
    if (this.#observationError !== undefined) throw this.#observationError;
    if (this.#closeError !== undefined) throw this.#closeError;
    return this.#requireCollector().readPrivateReceipt();
  }

  #observeFreshSessionStart(
    command: Extract<LocalCommand, { kind: "session.start" }>,
    data: unknown,
  ): void {
    if (this.#freshSession !== undefined || this.#collector !== undefined) {
      this.#observationError ??= new ClaudeLiveAcceptanceProofError("session_scope_invalid");
      return;
    }
    const parsed = rawClaudeStartResultSchema.safeParse(data);
    if (
      command.provider !== "claude"
      || command.preset !== "fable-max"
      || command.fast
      || !parsed.success
      || command.idempotencyKey !== parsed.data.idempotencyKey
      || command.account !== parsed.data.session.profileId
      || command.project !== parsed.data.session.projectId
      || parsed.data.session.state !== "idle"
      || parsed.data.session.activeTurnId !== undefined
      || parsed.data.effectiveRuntimeProfile.profileId !== parsed.data.session.profileId
      || parsed.data.effectiveRuntimeProfile.processGeneration < 1
    ) {
      this.#observationError = new ClaudeLiveAcceptanceProofError("session_scope_invalid");
      return;
    }
    this.#freshSession = Object.freeze({
      profileGeneration: parsed.data.effectiveRuntimeProfile.processGeneration,
      profileId: parsed.data.session.profileId,
      providerThreadId: parsed.data.session.providerThreadId,
      sessionId: parsed.data.session.id,
    });
  }

  #requireCollector(): ClaudeLiveAcceptanceProofCollector {
    if (this.#closed && this.#collector === undefined) {
      throw new ClaudeLiveAcceptanceProofError("proof_incomplete");
    }
    const collector = this.#collector;
    if (collector === undefined) {
      throw new ClaudeLiveAcceptanceProofError("proof_incomplete");
    }
    return collector;
  }
}

class DaemonSupervisor {
  readonly #descriptor: AcceptanceInstallationDescriptor;
  readonly #installation: ReturnType<typeof createAcceptanceInstallation>;
  readonly #memoryFault: LiveAcceptanceMemoryFaultController;
  readonly #claudeProof: WorkerClaudeProofController | undefined;
  readonly #failure = deferred<never>();
  readonly #callLocalDaemon: typeof callLocalDaemon;
  readonly #runDaemon: typeof runDaemon;
  readonly #waitForDaemonReady: typeof waitForDaemonReady;
  #failureError: Error | undefined;
  #generation: DaemonGeneration | undefined;
  #suspended = false;

  constructor(
    descriptor: AcceptanceInstallationDescriptor,
    dependencies: DaemonSupervisorDependencies = {},
    options: Readonly<{ claudeProof?: boolean }> = {},
  ) {
    this.#descriptor = descriptor;
    this.#installation = createAcceptanceInstallation(descriptor);
    this.#memoryFault = new LiveAcceptanceMemoryFaultController({
      // The local Claude proof carries a candidate but does not enroll hosted
      // sync. Only the separate Codex hosted gate admits the response-drop
      // controller's candidate and cloud-target contract.
      ...(options.claudeProof === true || descriptor.candidate === undefined
        ? {}
        : { candidate: descriptor.candidate }),
      ...(descriptor.cloudDeploymentUrl === undefined
        ? {}
        : { cloudDeploymentUrl: descriptor.cloudDeploymentUrl }),
      device: descriptor.device,
      runId: descriptor.runId,
    });
    const proofCandidate = descriptor.candidate;
    if (options.claudeProof === true && proofCandidate === undefined) {
      throw new WorkerFailure("descriptor_invalid");
    }
    this.#claudeProof = options.claudeProof === true && proofCandidate !== undefined
      ? new WorkerClaudeProofController({
          candidate: proofCandidate,
          runId: descriptor.runId,
        })
      : undefined;
    this.#callLocalDaemon = dependencies.callLocalDaemon ?? callLocalDaemon;
    this.#runDaemon = dependencies.runDaemon ?? runDaemon;
    this.#waitForDaemonReady = dependencies.waitForDaemonReady ?? waitForDaemonReady;
    void this.#failure.promise.catch(() => undefined);
  }

  get failure(): Promise<never> {
    return Promise.race([this.#failure.promise, this.#memoryFault.failure]);
  }

  async start(): Promise<void> {
    if (this.#generation !== undefined || this.#suspended) {
      throw new WorkerFailure("daemon_failed");
    }
    const controller = new AbortController();
    const faultGeneration = this.#memoryFault.beginGeneration();
    const generation: DaemonGeneration = {
      controller,
      expectedStop: null,
      faultEnded: false,
      faultGeneration,
      promise: this.#runDaemon(this.#installation, {
        liveAcceptanceCanonicalMemoryTransportDecorator: (transport) =>
          this.#memoryFault.decorate(faultGeneration, transport),
        ...(this.#claudeProof === undefined
          ? {}
          : { liveAcceptanceClaudeProof: this.#claudeProof }),
        stopSignal: controller.signal,
      }),
    };
    this.#generation = generation;
    void generation.promise.then(
      (exitCode) => {
        if (exitCode !== 0 || generation.expectedStop === null) {
          this.#endFaultGeneration(generation, exitCode);
          this.#fail(new WorkerFailure("daemon_failed"));
        }
      },
      () => {
        this.#endFaultGeneration(generation, 1);
        this.#fail(new WorkerFailure("daemon_failed"));
      },
    );
    try {
      generation.identity = await Promise.race([
        this.#waitForDaemonReady({
          deadlineMs: 30_000,
          paths: this.#installation.paths,
          queryStatus: async () => await this.#callLocalDaemon({
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
      generation.controller.abort(new Error("Live-acceptance daemon readiness failed."));
      await beforeDeadline(generation.promise, 30_000).then(
        (exitCode) => this.#endFaultGeneration(generation, exitCode),
        () => this.#endFaultGeneration(generation, 1),
      ).catch(() => undefined);
      throw error instanceof WorkerFailure ? error : new WorkerFailure("daemon_failed");
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
      this.#callLocalDaemon({
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

  armCanonicalMemoryResponseDrop(
    input: LiveAcceptanceMemoryFaultArm,
  ): LiveAcceptanceMemoryFaultStatus {
    this.#assertRunning();
    return this.#memoryFault.arm(input);
  }

  canonicalMemoryResponseDropStatus(): LiveAcceptanceMemoryFaultStatus {
    this.#assertRunning();
    return this.#memoryFault.status();
  }

  finalizeCanonicalMemoryResponseDrop(
    input: LiveAcceptanceMemoryFaultFinalize,
  ): LiveAcceptanceMemoryFaultStatus {
    this.#assertRunning();
    return this.#memoryFault.finalize(input);
  }

  currentDaemonGeneration(): number {
    this.#assertRunning();
    const generation = this.#generation?.identity?.generation;
    if (generation === undefined) throw new WorkerFailure("daemon_failed");
    return generation;
  }

  armClaudeProof(input: ClaudeLiveAcceptanceWorkerArm): void {
    this.#assertRunning();
    if (this.#claudeProof === undefined) throw new WorkerFailure("control_invalid");
    this.#claudeProof.armObservedFreshSession(input);
  }

  observeClaudeCommandResponse(command: LocalCommand, response: CommandResponse): void {
    if (this.#claudeProof === undefined) return;
    if (command.kind !== "session.start" && command.kind !== "session.send") return;
    this.#assertRunning();
    this.#claudeProof.observeCommandResponse(command, response);
  }

  readClaudeProvisionalProof(): ClaudeLiveAcceptanceProvisionalPrivateReceipt {
    this.#assertRunning();
    if (this.#claudeProof === undefined) throw new WorkerFailure("control_invalid");
    return this.#claudeProof.readProvisionalPrivateReceipt();
  }

  readClaudeFinalProof(): ClaudeLiveAcceptancePrivateReceipt {
    if (this.#generation !== undefined || this.#claudeProof === undefined) {
      throw new WorkerFailure("control_invalid");
    }
    return this.#claudeProof.readPrivateReceipt();
  }

  async restartAfterResponse(): Promise<void> {
    const generation = this.#generation;
    if (generation === undefined || generation.expectedStop !== "restart") return;
    await this.#awaitStoppedGeneration(generation);
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
      generation.controller.abort(new Error("The live-acceptance parent closed."));
    }
  }

  async stopAfterFailure(): Promise<void> {
    const generation = this.#generation;
    if (generation === undefined) return;
    generation.expectedStop ??= "stop";
    generation.controller.abort(new Error("The live-acceptance worker failed."));
    await beforeDeadline(generation.promise, 30_000).then(
      (exitCode) => this.#endFaultGeneration(generation, exitCode),
      () => this.#endFaultGeneration(generation, 1),
    ).catch(() => undefined);
  }

  closeMemoryFault(): void {
    this.#memoryFault.close();
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
      if (generation.identity === undefined) throw new WorkerFailure("daemon_failed");
      const response = await this.#callLocalDaemon({
        command: { kind: "daemon.stop", expected: generation.identity },
        deadlineMs: 5_000,
        paths: this.#installation.paths,
        signal,
      });
      if (!response.ok) throw new WorkerFailure("daemon_failed");
    } else {
      generation.controller.abort(new Error("The live-acceptance daemon was asked to stop."));
    }
    await this.#awaitStoppedGeneration(generation);
  }

  async #awaitStoppedGeneration(generation: DaemonGeneration): Promise<void> {
    const exitCode = await beforeDeadline(generation.promise, 30_000);
    if (exitCode !== 0 || this.#generation !== generation) {
      throw new WorkerFailure("daemon_failed");
    }
    this.#endFaultGeneration(generation, exitCode);
    this.#generation = undefined;
  }

  #endFaultGeneration(generation: DaemonGeneration, exitCode: number): void {
    if (generation.faultEnded) return;
    generation.faultEnded = true;
    try {
      this.#memoryFault.endGeneration({
        exitCode,
        generation: generation.faultGeneration,
        reason: generation.expectedStop ?? "stop",
      });
    } catch (error: unknown) {
      this.#fail(error instanceof Error ? error : new WorkerFailure("daemon_failed"));
    }
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

const discardedCliOutput: Output = {
  writeStderr: () => undefined,
  writeStdout: () => undefined,
};

async function initializeWorkerInstallation(
  descriptor: AcceptanceInstallationDescriptor,
): Promise<void> {
  // Codex resolves its account-level credential-store policy from the app-server
  // startup directory. Bind that base config to the same isolated project used by
  // every config/read preflight, without changing HOME or carrying the path in argv.
  process.chdir(descriptor.documentsDirectory);
  if (process.cwd() !== descriptor.documentsDirectory) {
    throw new WorkerFailure("layout_invalid");
  }
  const installation = createAcceptanceInstallation(descriptor);
  try {
    const exitCode = await initialize(true, false, discardedCliOutput, {
      documentsDirectory: descriptor.documentsDirectory,
      paths: installation.paths,
    });
    if (exitCode !== 0) throw new WorkerFailure("initialization_failed");
  } catch {
    // The worker protocol reports a bounded stage, never a potentially
    // path-bearing SQLite or filesystem diagnostic.
    throw new WorkerFailure("initialization_failed");
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
      supervisor.observeClaudeCommandResponse(command, response);
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
  if (control.type === "memory_fault_arm") {
    await status.write({
      requestId: control.requestId,
      status: supervisor.armCanonicalMemoryResponseDrop(control.input),
      type: "memory_fault_result",
      version: 1,
    });
    return null;
  }
  if (control.type === "memory_fault_finalize") {
    await status.write({
      requestId: control.requestId,
      status: supervisor.finalizeCanonicalMemoryResponseDrop(control.input),
      type: "memory_fault_result",
      version: 1,
    });
    return null;
  }
  if (control.type === "memory_fault_status") {
    await status.write({
      requestId: control.requestId,
      status: supervisor.canonicalMemoryResponseDropStatus(),
      type: "memory_fault_result",
      version: 1,
    });
    return null;
  }
  if (control.type === "claude_proof_arm") {
    supervisor.armClaudeProof(control.input);
    await status.write({
      action: "arm",
      requestId: control.requestId,
      type: "claude_proof_ack",
      version: 1,
    });
    return null;
  }
  if (control.type === "claude_proof_read_provisional") {
    let outcome: Extract<LiveAcceptanceWorkerStatus, {
      type: "claude_proof_provisional_result";
    }>["outcome"];
    try {
      outcome = {
        receipt: supervisor.readClaudeProvisionalProof(),
        status: "ready",
      };
    } catch (error: unknown) {
      if (!(error instanceof ClaudeLiveAcceptanceProofError)) throw error;
      outcome = error.code === "proof_incomplete"
        ? { status: "pending" }
        : { code: error.code, status: "refused" };
    }
    await status.write({
      outcome,
      requestId: control.requestId,
      type: "claude_proof_provisional_result",
      version: 1,
    });
    return null;
  }
  if (control.type === "claude_proof_stop") {
    await supervisor.stop("stop", signal);
    let outcome: Extract<LiveAcceptanceWorkerStatus, {
      type: "claude_proof_final_result";
    }>["outcome"];
    try {
      outcome = {
        receipt: supervisor.readClaudeFinalProof(),
        status: "proved",
      };
    } catch (error: unknown) {
      if (!(error instanceof ClaudeLiveAcceptanceProofError)) throw error;
      outcome = { code: error.code, status: "refused" };
    }
    await status.write({
      outcome,
      requestId: control.requestId,
      type: "claude_proof_final_result",
      version: 1,
    });
    return "stop_requested";
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

async function workerMain(
  dependencies: WorkerDependencies = {},
  mode: WorkerMode = "standard",
): Promise<number> {
  let status: StatusWriter | undefined;
  let input: WorkerInput | undefined;
  let descriptor: AcceptanceInstallationDescriptor | undefined;
  let supervisor: DaemonSupervisor | undefined;
  try {
    status = new StatusWriter();
    input = new WorkerInput();
    try {
      descriptor = await assertAcceptanceDescriptorLayout(await readDescriptor(input));
    } catch (error: unknown) {
      if (error instanceof WorkerFailure) throw error;
      throw new WorkerFailure("descriptor_invalid");
    }
    if (process.env.HOME !== descriptor.expectedHomeDirectory) {
      throw new WorkerFailure("home_changed");
    }
    await (dependencies.initializeWorkerInstallation ?? initializeWorkerInstallation)(descriptor);
    supervisor = new DaemonSupervisor(
      descriptor,
      dependencies,
      { claudeProof: mode === "claude_proof" },
    );
    await supervisor.start();
    if (process.env.HOME !== descriptor.expectedHomeDirectory) {
      throw new WorkerFailure("home_changed");
    }
    await status.write({
      ...(mode === "claude_proof"
        ? { daemonGeneration: supervisor.currentDaemonGeneration() }
        : {}),
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
    await supervisor?.stopAfterFailure().catch(() => undefined);
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
    supervisor?.closeMemoryFault();
    input?.destroy();
  }
}

type LiveAcceptanceWorkerSupervisorTestInput =
  | Readonly<{
      descriptor: AcceptanceInstallationDescriptor;
      kind: "start";
      runDaemon: typeof runDaemon;
      waitForDaemonReady: typeof waitForDaemonReady;
    }>
  | Readonly<{
      claudeProof?: boolean;
      callLocalDaemon?: typeof callLocalDaemon;
      initializeWorkerInstallation?: typeof initializeWorkerInstallation;
      kind: "worker_main";
      runDaemon: typeof runDaemon;
      waitForDaemonReady: typeof waitForDaemonReady;
    }>;

export function runLiveAcceptanceWorkerSupervisorForTest(
  input: Extract<LiveAcceptanceWorkerSupervisorTestInput, { kind: "start" }>,
): Promise<void>;
export function runLiveAcceptanceWorkerSupervisorForTest(
  input: Extract<LiveAcceptanceWorkerSupervisorTestInput, { kind: "worker_main" }>,
): Promise<number>;
export async function runLiveAcceptanceWorkerSupervisorForTest(
  input: LiveAcceptanceWorkerSupervisorTestInput,
): Promise<number | void> {
  const dependencies = {
    ...(input.kind === "worker_main" && input.callLocalDaemon !== undefined
      ? { callLocalDaemon: input.callLocalDaemon }
      : {}),
    ...(input.kind === "worker_main" && input.initializeWorkerInstallation !== undefined
      ? { initializeWorkerInstallation: input.initializeWorkerInstallation }
      : {}),
    runDaemon: input.runDaemon,
    waitForDaemonReady: input.waitForDaemonReady,
  };
  if (input.kind === "worker_main") {
    return await workerMain(dependencies, input.claudeProof === true ? "claude_proof" : "standard");
  }
  const supervisor = new DaemonSupervisor(input.descriptor, dependencies);
  await supervisor.start();
}

if (import.meta.main) {
  const mode = (() => {
    try {
      return workerModeFromArgv(Bun.argv.slice(2));
    } catch {
      return null;
    }
  })();
  process.exitCode = mode === null ? 1 : await workerMain({}, mode);
}
