import { createHash } from "node:crypto";

import { z } from "@hra-internal/schema";

import {
  actorEpochIdSchema,
  actorIdSchema,
  actorTurnIdSchema,
} from "./actor-domain";
import {
  contextSnapshotIdSchema,
  contextValueIdSchema,
  programRunIdSchema,
} from "./domain";
import {
  isTerminalRunState,
  type RlmReceiptRecord,
  type RlmRunAuthorityV2,
  type RlmRunRecord,
} from "./rlm-run-authority-v2";
import {
  RLM_V2_MAX_FUEL,
  RLM_V2_MAX_COLLECTION_ITEMS,
  RLM_V2_MAX_SOURCE_UTF8_BYTES,
  RLM_V2_PROGRAM_VERSION,
  RlmV2OperationReplayRequiredError,
  RlmV2ReferenceEvaluator,
  compareRlmV2NodePaths,
  deriveRlmV2ReceiptId,
  digestRlmV2Program,
  parseRlmV2Caller,
  parseRlmV2Program,
  rlmV2OperationReceiptSchema,
  rlmV2OperationSchema,
  rlmV2NodePathSchema,
  type RlmV2Caller,
  type RlmV2ExecutionOutcome,
  type RlmV2JsonValue,
  type RlmV2Operation,
  type RlmV2OperationContext,
  type RlmV2OperationPort,
  type RlmV2OperationReceipt,
  type RlmV2Program,
  type RlmV2ReceiptPort,
} from "./rlm-v2";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const pageLimitSchema = z.number().int().min(1).max(128);
const waitMillisecondsSchema = z.number().int().min(0).max(300_000);
const STOP_DRAIN_JOIN_MILLISECONDS = 1_000;
const valueRoleSchema = z.enum([
  "programSource",
  "programResult",
  "receiptResult",
]);

export type RlmRuntimeValueRole = z.infer<typeof valueRoleSchema>;

export interface RlmRuntimeValueIdentity {
  readonly version: 2;
  readonly role: RlmRuntimeValueRole;
  readonly epochId: string;
  readonly actorId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly programDigest: string;
  readonly receiptId: string | null;
  readonly nodePath: RlmReceiptRecord["nodePath"] | null;
  readonly operation: RlmV2Operation | null;
  readonly requestDigest: string | null;
}

export interface RlmRuntimeSealedValue {
  readonly valueId: string;
  readonly contentDigest: string;
  readonly identityDigest: string;
}

export interface RlmRuntimeOpenedValue extends RlmRuntimeSealedValue {
  readonly value: unknown;
}

/**
 * The implementation owns encryption, authenticated object publication, and
 * active context-value metadata. SQLite may receive only the returned opaque
 * value ID and digests, never `value`.
 */
export interface RlmRuntimeEncryptedValuePort {
  sealJson(input: Readonly<{
    operationId: string;
    identity: RlmRuntimeValueIdentity;
    identityDigest: string;
    contentDigest: string;
    value: RlmV2JsonValue;
  }>): Promise<unknown>;
  openJson(input: Readonly<{
    valueId: string;
    expectedIdentity: RlmRuntimeValueIdentity;
    expectedIdentityDigest: string;
    expectedContentDigest: string | null;
  }>): Promise<unknown>;
}

/** Resolves a caller from durable, provider-neutral actor authority. */
export interface RlmRuntimeCallerPort {
  resolveCaller(run: RlmRunRecord): Promise<unknown>;
}

type MaybePromise<T> = T | Promise<T>;

/** A structural port keeps the runtime deterministic in tests and accepts the SQLite authority. */
export interface RlmRuntimeRunAuthorityPort {
  prepareRun(
    input: Parameters<RlmRunAuthorityV2["prepareRun"]>[0],
  ): MaybePromise<RlmRunRecord>;
  transitionRun(
    input: Parameters<RlmRunAuthorityV2["transitionRun"]>[0],
  ): MaybePromise<RlmRunRecord>;
  requestDesiredState(
    input: Parameters<RlmRunAuthorityV2["requestDesiredState"]>[0],
  ): MaybePromise<RlmRunRecord>;
  requestLifecycleCheckpoint(
    input: Parameters<RlmRunAuthorityV2["requestLifecycleCheckpoint"]>[0],
  ): MaybePromise<RlmRunRecord>;
  releaseLifecycleCheckpoint(
    input: Parameters<RlmRunAuthorityV2["releaseLifecycleCheckpoint"]>[0],
  ): MaybePromise<RlmRunRecord>;
  readRun(runId: string): MaybePromise<RlmRunRecord | null>;
  listRecoverableRuns(
    input: Parameters<RlmRunAuthorityV2["listRecoverableRuns"]>[0],
  ): MaybePromise<readonly RlmRunRecord[]>;
  prepareReceipt(
    input: Parameters<RlmRunAuthorityV2["prepareReceipt"]>[0],
  ): MaybePromise<RlmReceiptRecord>;
  transitionReceipt(
    input: Parameters<RlmRunAuthorityV2["transitionReceipt"]>[0],
  ): MaybePromise<RlmReceiptRecord>;
  readReceipt(receiptId: string): MaybePromise<RlmReceiptRecord | null>;
  listRecoverableReceipts(
    input: Parameters<RlmRunAuthorityV2["listRecoverableReceipts"]>[0],
  ): MaybePromise<readonly RlmReceiptRecord[]>;
}

export type RlmRuntimeV2ErrorCode =
  | "cancelled"
  | "conflict"
  | "corrupt_state"
  | "invalid_admission"
  | "not_found"
  | "not_ready"
  | "quiesced"
  | "recovery_required"
  | "timeout";

/** Messages are deliberately fixed and content-free. */
export class RlmRuntimeV2Error extends Error {
  readonly code: RlmRuntimeV2ErrorCode;

  constructor(code: RlmRuntimeV2ErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "RlmRuntimeV2Error";
    this.code = code;
  }
}

const ERROR_MESSAGES: Readonly<Record<RlmRuntimeV2ErrorCode, string>> = {
  cancelled: "RLM runtime operation was cancelled",
  conflict: "RLM runtime immutable identity conflicts",
  corrupt_state: "RLM runtime durable state is incoherent",
  invalid_admission: "RLM runtime admission is invalid",
  not_found: "RLM runtime run does not exist",
  not_ready: "RLM runtime result is not ready",
  quiesced: "RLM runtime is quiesced",
  recovery_required: "RLM runtime requires recovery",
  timeout: "RLM runtime wait timed out",
};

export interface RlmRuntimeRunHandle {
  readonly runId: string;
  readonly state: RlmRunRecord["state"];
  readonly desiredState: RlmRunRecord["desiredState"];
  readonly revision: number;
}

export type RlmRuntimeResult =
  | Readonly<{
      state: "pending";
      handle: RlmRuntimeRunHandle;
    }>
  | Readonly<{
      state: "completed";
      value: RlmV2JsonValue;
    }>
  | Readonly<{
      state: "failed" | "stopped" | "recoveryRequired";
      code: string;
    }>;

export interface RlmRuntimeBootReport {
  readonly scheduledRunIds: readonly string[];
  readonly suspendedRunIds: readonly string[];
  readonly stoppedRunIds: readonly string[];
  readonly recoveryRequiredRunIds: readonly string[];
  readonly replayPreparedReceiptIds: readonly string[];
}

export interface RlmRuntimeQuiesceReport {
  readonly requestedRunIds: readonly string[];
  readonly settledRunIds: readonly string[];
  readonly timedOutRunIds: readonly string[];
}

export interface RlmRuntimeV2Options {
  readonly authority: RlmRuntimeRunAuthorityPort;
  readonly values: RlmRuntimeEncryptedValuePort;
  readonly callers: RlmRuntimeCallerPort;
  readonly operations: RlmV2OperationPort;
  readonly now?: () => number;
  readonly pageLimit?: number;
  readonly pollIntervalMs?: number;
  readonly maxScanRecords?: number;
}

interface Producer {
  readonly runId: string;
  readonly controller: AbortController;
  promise: Promise<void>;
}

const admissionInputSchema = z.object({
  runId: programRunIdSchema,
  epochId: actorEpochIdSchema,
  actorId: actorIdSchema,
  turnId: actorTurnIdSchema,
  completedPrefixSnapshotId: contextSnapshotIdSchema,
  currentUserInputValueId: contextValueIdSchema.nullable(),
  releaseIdentityDigest: digestSchema,
  fuelLimit: z.literal(RLM_V2_MAX_FUEL),
  program: z.unknown(),
  caller: z.unknown(),
}).strict();

export type RlmRuntimeAdmission = z.input<typeof admissionInputSchema>;

/**
 * Durable orchestration around the deterministic evaluator. In-memory
 * producers are only wakeups: every decision is re-read from durable state.
 */
export class RlmRuntimeV2 {
  readonly #authority: RlmRuntimeRunAuthorityPort;
  readonly #values: RlmRuntimeEncryptedValuePort;
  readonly #callers: RlmRuntimeCallerPort;
  readonly #operations: RlmV2OperationPort;
  readonly #now: () => number;
  readonly #pageLimit: number;
  readonly #pollIntervalMs: number;
  readonly #maxScanRecords: number;
  readonly #producers = new Set<Producer>();
  #closed = false;

  constructor(options: RlmRuntimeV2Options) {
    this.#authority = options.authority;
    this.#values = options.values;
    this.#callers = options.callers;
    this.#operations = options.operations;
    this.#now = options.now ?? Date.now;
    this.#pageLimit = pageLimitSchema.parse(options.pageLimit ?? 128);
    this.#pollIntervalMs = z.number().int().min(1).max(1_000)
      .parse(options.pollIntervalMs ?? 10);
    this.#maxScanRecords = z.number().int().min(1).max(1_000_000)
      .parse(options.maxScanRecords ?? 100_000);
  }

  async admit(inputValue: unknown): Promise<RlmRuntimeRunHandle> {
    if (this.#closed) throw new RlmRuntimeV2Error("quiesced");
    let input: z.output<typeof admissionInputSchema>;
    let program: RlmV2Program;
    let caller: RlmV2Caller;
    try {
      input = admissionInputSchema.parse(inputValue);
      program = parseRlmV2Program(input.program);
      caller = parseRlmV2Caller(input.caller);
      assertAdmission(input, program, caller, this.#now());
    } catch {
      throw new RlmRuntimeV2Error("invalid_admission");
    }
    const programDigest = digestRlmV2Program(program);
    const admissionDigest = deriveRlmRuntimeAdmissionDigest({
      ...input,
      programDigest,
      caller,
    });
    const sourceIdentity = valueIdentity({
      role: "programSource",
      epochId: input.epochId,
      actorId: input.actorId,
      turnId: input.turnId,
      runId: input.runId,
      programDigest,
    });
    const sealed = await this.#seal(
      deriveValueOperationId("program-source", admissionDigest),
      sourceIdentity,
      program as unknown as RlmV2JsonValue,
      programDigest,
    );
    if (sealed.contentDigest !== programDigest) {
      throw new RlmRuntimeV2Error("corrupt_state");
    }
    let run: RlmRunRecord;
    try {
      run = await this.#authority.prepareRun({
        id: input.runId,
        epochId: input.epochId,
        actorId: input.actorId,
        turnId: input.turnId,
        programValueId: sealed.valueId,
        programDigest,
        completedPrefixSnapshotId: input.completedPrefixSnapshotId,
        currentUserInputValueId: input.currentUserInputValueId,
        capabilities: caller.capabilities,
        admittedFeatures: caller.admittedFeatures,
        semanticWitnessDigests: caller.semanticWitnessDigests,
        budget: caller.budget,
        fuelLimit: input.fuelLimit,
        deadline: caller.budget.deadline,
        releaseIdentityDigest: input.releaseIdentityDigest,
        admissionDigest,
      });
    } catch {
      throw new RlmRuntimeV2Error("conflict");
    }
    this.#schedule(run.id);
    return publicHandle(run);
  }

  async status(runIdValue: string): Promise<RlmRuntimeRunHandle> {
    const run = await this.#requireRun(runIdValue);
    this.#scheduleReplayIfNeeded(run);
    return publicHandle(run);
  }

  async wait(
    runIdValue: string,
    timeoutMsValue: number,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<RlmRuntimeRunHandle> {
    const runId = programRunIdSchema.parse(runIdValue);
    const timeoutMs = waitMillisecondsSchema.parse(timeoutMsValue);
    const deadline = this.#now() + timeoutMs;
    while (true) {
      if (signal.aborted) throw new RlmRuntimeV2Error("cancelled");
      const run = await this.#requireRun(runId);
      this.#scheduleReplayIfNeeded(run);
      if (isTerminalRunState(run.state) ||
          (run.state === "suspended" && run.desiredState !== "run")) {
        return publicHandle(run);
      }
      const remaining = deadline - this.#now();
      if (remaining <= 0) throw new RlmRuntimeV2Error("timeout");
      await abortableDelay(Math.min(this.#pollIntervalMs, remaining), signal);
    }
  }

  async result(runIdValue: string): Promise<RlmRuntimeResult> {
    const run = await this.#requireRun(runIdValue);
    this.#scheduleReplayIfNeeded(run);
    if (run.state !== "completed") {
      if (run.state === "failed" || run.state === "stopped" ||
          run.state === "recoveryRequired") {
        return {
          state: run.state,
          code: run.terminalCode ?? "terminal_state",
        };
      }
      return { state: "pending", handle: publicHandle(run) };
    }
    if (run.terminalResultValueId === null) {
      throw new RlmRuntimeV2Error("corrupt_state");
    }
    const identity = valueIdentity({
      role: "programResult",
      epochId: run.epochId,
      actorId: run.actorId,
      turnId: run.turnId,
      runId: run.id,
      programDigest: run.programDigest,
    });
    const opened = await this.#open(run.terminalResultValueId, identity, null);
    return { state: "completed", value: parseJsonValue(opened.value) };
  }

  async suspend(runIdValue: string): Promise<RlmRuntimeRunHandle> {
    if (this.#closed) throw new RlmRuntimeV2Error("quiesced");
    const requested = await this.#requestIntent(runIdValue, "suspend");
    this.#abortRun(requested.id);
    const settled = await this.#settleDurableIntent(requested.id);
    return publicHandle(settled);
  }

  async resume(runIdValue: string): Promise<RlmRuntimeRunHandle> {
    if (this.#closed) throw new RlmRuntimeV2Error("quiesced");
    const run = await this.#requireRun(runIdValue);
    if (isTerminalRunState(run.state)) return publicHandle(run);
    const requested = run.desiredState === "run"
      ? run
      : await this.#requestIntent(run.id, "run");
    if (requested.state !== "suspended" && requested.state !== "prepared" &&
        requested.state !== "running") {
      throw new RlmRuntimeV2Error("conflict");
    }
    this.#schedule(requested.id);
    return publicHandle(requested);
  }

  async stop(runIdValue: string): Promise<RlmRuntimeRunHandle> {
    const before = await this.#requireRun(runIdValue);
    const requested = await this.#requestIntent(runIdValue, "stop");
    const active = [...this.#producers].find(
      (producer) => producer.runId === requested.id,
    );
    if (before.desiredState === "stop" && active !== undefined) {
      return publicHandle(await this.#requireRun(requested.id));
    }
    if (before.desiredState !== "stop") this.#abortRun(requested.id);
    let settled = await this.#settleDurableIntent(requested.id);
    if (active !== undefined && before.desiredState !== "stop") {
      const joined = await Promise.race([
        active.promise.then(() => true),
        delay(STOP_DRAIN_JOIN_MILLISECONDS).then(() => false),
      ]);
      if (!joined) return publicHandle(await this.#requireRun(requested.id));
      settled = await this.#settleDurableIntent(requested.id);
    }
    if (
      !isTerminalRunState(settled.state) && settled.desiredState === "stop" &&
      ![...this.#producers].some((producer) => producer.runId === settled.id)
    ) {
      this.#schedule(settled.id);
    }
    return publicHandle(await this.#requireRun(settled.id));
  }

  cancel(runIdValue: string): Promise<RlmRuntimeRunHandle> {
    return this.stop(runIdValue);
  }

  async reconcileOnBoot(): Promise<RlmRuntimeBootReport> {
    if (this.#closed) throw new RlmRuntimeV2Error("quiesced");
    const receipts = await this.#allRecoverableReceipts();
    await this.#assertRecoverableExternalReceiptParents(receipts);
    const recoveryRuns = new Set<string>();
    const replayPrepared = new Set<string>();
    for (const receipt of receipts) {
      if (receipt.state === "recoveryRequired") {
        recoveryRuns.add(receipt.runId);
        continue;
      }
      if (receipt.state === "replayRequired") {
        replayPrepared.add(receipt.id);
        continue;
      }
      if (receipt.state !== "effectStarted") continue;
      if (!isDurablyReplayable(receipt)) {
        recoveryRuns.add(receipt.runId);
        continue;
      }
      try {
        const replay = await this.#authority.transitionReceipt({
          receiptId: receipt.id,
          expectedState: "effectStarted",
          nextState: "replayRequired",
        });
        if (replay.state === "replayRequired") replayPrepared.add(replay.id);
      } catch {
        const current = await this.#authority.readReceipt(receipt.id);
        if (current?.state === "replayRequired") replayPrepared.add(current.id);
        else if (current?.state === "recoveryRequired") recoveryRuns.add(current.runId);
        else throw new RlmRuntimeV2Error("corrupt_state");
      }
    }

    const scheduled = new Set<string>();
    const suspended = new Set<string>();
    const stopped = new Set<string>();
    const runs = await this.#allRecoverableRuns();
    for (const runValue of runs) {
      let run = runValue;
      if (run.state === "recoveryRequired" || recoveryRuns.has(run.id)) {
        run = await this.#markRunRecoveryRequired(run.id);
        recoveryRuns.add(run.id);
        continue;
      }
      if (run.lifecycleCheckpoint) {
        run = await this.#releaseLifecycleCheckpointOnBoot(run.id);
        if (isTerminalRunState(run.state)) continue;
      }
      if (run.state === "suspended" && run.desiredState === "suspend") {
        suspended.add(run.id);
        continue;
      }
      if (run.desiredState === "stop") {
        const debt = await this.#externalDrainReceiptsForRun(run.id);
        if (debt.recoveryRequired) {
          await this.#markRunRecoveryRequired(run.id);
          recoveryRuns.add(run.id);
          continue;
        }
        if (debt.receipts.length > 0) {
          scheduled.add(run.id);
          this.#schedule(run.id);
          continue;
        }
        run = await this.#settleDurableIntent(run.id);
        if (run.state === "suspended") suspended.add(run.id);
        if (run.state === "stopped") stopped.add(run.id);
        continue;
      }
      if (run.desiredState !== "run") {
        run = await this.#settleDurableIntent(run.id);
        if (run.state === "suspended") suspended.add(run.id);
        continue;
      }
      if (
        run.state === "prepared" || run.state === "running" ||
        (run.state === "suspended" && run.desiredState === "run")
      ) {
        scheduled.add(run.id);
        this.#schedule(run.id);
      }
    }
    return {
      scheduledRunIds: sorted(scheduled),
      suspendedRunIds: sorted(suspended),
      stoppedRunIds: sorted(stopped),
      recoveryRequiredRunIds: sorted(recoveryRuns),
      replayPreparedReceiptIds: sorted(replayPrepared),
    };
  }

  async quiesce(timeoutMsValue = 5_000): Promise<RlmRuntimeQuiesceReport> {
    const timeoutMs = waitMillisecondsSchema.parse(timeoutMsValue);
    this.#closed = true;
    const requested = new Set<string>();
    for (const run of await this.#allRecoverableRuns()) {
      if (run.lifecycleCheckpoint) {
        requested.add(run.id);
        continue;
      }
      if (run.desiredState !== "run") continue;
      const checkpointed = await this.#requestLifecycleCheckpoint(run.id);
      if (checkpointed.lifecycleCheckpoint) requested.add(checkpointed.id);
    }
    for (const producer of this.#producers) producer.controller.abort();

    const producerSnapshot = [...this.#producers];
    const producerRunIds = new Set(producerSnapshot.map((producer) => producer.runId));
    for (const runId of producerRunIds) requested.add(runId);
    const producerSettled = new Set<string>();
    if (producerSnapshot.length > 0) {
      const completion = Promise.allSettled(
        producerSnapshot.map(async (producer) => {
          await producer.promise;
          producerSettled.add(producer.runId);
        }),
      );
      await Promise.race([
        completion,
        delay(timeoutMs),
      ]);
    }
    const settled = new Set<string>();
    for (const runId of requested) {
      if (producerRunIds.has(runId) && !producerSettled.has(runId)) continue;
      let run = await this.#requireRun(runId);
      if (isTerminalRunState(run.state)) {
        settled.add(run.id);
        continue;
      }
      if (!run.lifecycleCheckpoint) {
        run = await this.#settleDurableIntent(run.id);
        if (run.state === "suspended" || isTerminalRunState(run.state)) {
          settled.add(run.id);
        }
        continue;
      }
      if (run.desiredState !== "run") {
        throw new RlmRuntimeV2Error("corrupt_state");
      }
      if (run.state === "prepared" || run.state === "running") {
        run = await this.#transitionRun(run, "suspended");
      }
      if (run.state !== "suspended" || !run.lifecycleCheckpoint) {
        throw new RlmRuntimeV2Error("corrupt_state");
      }
      settled.add(run.id);
    }
    const timedOut = [...requested].filter((runId) => !settled.has(runId));
    return {
      requestedRunIds: sorted(requested),
      settledRunIds: sorted(settled),
      timedOutRunIds: timedOut.toSorted(),
    };
  }

  #schedule(runId: string): void {
    if (this.#closed) return;
    const existing = [...this.#producers].find((entry) => entry.runId === runId);
    if (existing !== undefined) return;
    const controller = new AbortController();
    const producer: Producer = {
      runId,
      controller,
      promise: Promise.resolve(),
    };
    producer.promise = Promise.resolve().then(async () => {
      await this.#drive(runId, controller);
    }).catch(async () => {
      const run = await Promise.resolve(this.#authority.readRun(runId))
        .catch(() => null);
      if (run !== null && !isTerminalRunState(run.state)) {
        await this.#markRunRecoveryRequired(runId).catch(() => undefined);
      }
    }).finally(() => {
      this.#producers.delete(producer);
    });
    this.#producers.add(producer);
  }

  async #drive(runId: string, controller: AbortController): Promise<void> {
    let run = await this.#requireRun(runId);
    if (isTerminalRunState(run.state)) return;
    if (run.lifecycleCheckpoint) return;

    if (run.desiredState === "suspend") {
      await this.#settleDurableIntent(run.id);
      return;
    }

    if (run.desiredState === "run" &&
        (run.state === "prepared" || run.state === "suspended")) {
      run = await this.#transitionRun(run, "running");
    }

    const recovery = await this.#reconcileReceiptsForRun(run.id);
    if (recovery) {
      await this.#markRunRecoveryRequired(run.id);
      return;
    }
    run = await this.#requireRun(run.id);

    let drainReceipts: readonly RlmReceiptRecord[] = [];
    if (run.desiredState === "stop") {
      const debt = await this.#externalDrainReceiptsForRun(run.id);
      if (debt.recoveryRequired) {
        await this.#markRunRecoveryRequired(run.id);
        return;
      }
      drainReceipts = debt.receipts;
      if (drainReceipts.length === 0) {
        await this.#settleDurableIntent(run.id);
        return;
      }
      if (run.state === "suspended") {
        run = await this.#transitionRun(run, "running");
      }
    }

    if (run.state !== "running") return;
    if (run.desiredState !== "run" && run.desiredState !== "stop") {
      await this.#settleDurableIntent(run.id);
      return;
    }

    const sourceIdentity = valueIdentity({
      role: "programSource",
      epochId: run.epochId,
      actorId: run.actorId,
      turnId: run.turnId,
      runId: run.id,
      programDigest: run.programDigest,
    });
    const opened = await this.#open(
      run.programValueId,
      sourceIdentity,
      run.programDigest,
    );
    const program = parseRlmV2Program(opened.value);
    if (digestRlmV2Program(program) !== run.programDigest) {
      throw new RlmRuntimeV2Error("corrupt_state");
    }
    const caller = parseRlmV2Caller(await this.#callers.resolveCaller(run));
    assertStoredAdmission(run, program, caller);

    if (run.desiredState === "stop") {
      await this.#drainExternalReceipts(
        run,
        program,
        caller,
        drainReceipts,
        controller.signal,
      );
      return;
    }

    const bridge = new DurableEvaluatorBridge({
      authority: this.#authority,
      values: this.#values,
      operations: this.#operations,
      run,
    });
    const evaluator = new RlmV2ReferenceEvaluator({
      operations: bridge,
      receipts: bridge,
      now: this.#now,
    });
    const outcome = await evaluator.execute(
      run.id,
      program,
      caller,
      controller.signal,
    );
    await this.#settleExecution(run.id, outcome);
  }

  async #drainExternalReceipts(
    initialRun: RlmRunRecord,
    program: RlmV2Program,
    caller: RlmV2Caller,
    receipts: readonly RlmReceiptRecord[],
    signal: AbortSignal,
  ): Promise<void> {
    for (const target of receipts) {
      const run = await this.#requireRun(initialRun.id);
      if (run.state !== "running" || run.desiredState !== "stop") {
        await this.#settleDurableIntent(run.id);
        return;
      }
      const current = await this.#authority.readReceipt(target.id);
      if (current === null || current.runId !== run.id) {
        await this.#markRunRecoveryRequired(run.id);
        return;
      }
      if (current.state === "succeeded" || current.state === "failed") continue;
      if (
        current.state !== "replayRequired" ||
        current.replayClass !== "reconciledExternalMutation" ||
        !sameReceiptIdentity(current, target)
      ) {
        await this.#markRunRecoveryRequired(run.id);
        return;
      }

      const bridge = new DurableEvaluatorBridge({
        authority: this.#authority,
        values: this.#values,
        operations: this.#operations,
        run,
        drainReceiptId: current.id,
      });
      const evaluator = new RlmV2ReferenceEvaluator({
        operations: bridge,
        receipts: bridge,
        now: this.#now,
      });
      const outcome = await evaluator.replayExactOperation(
        run.id,
        program,
        caller,
        {
          id: current.id,
          nodePath: current.nodePath,
          operation: current.operation,
          requestDigest: current.requestDigest,
        },
        signal,
      );
      const settled = await this.#authority.readReceipt(current.id);
      if (settled === null || !sameReceiptIdentity(settled, current)) {
        await this.#markRunRecoveryRequired(run.id);
        return;
      }
      if (outcome.state === "succeeded" && settled.state === "succeeded") {
        continue;
      }
      if (
        outcome.state === "failed" && outcome.code === "operation_failed" &&
        settled.state === "failed"
      ) {
        continue;
      }
      if (
        (outcome.state === "suspended" || outcome.state === "cancelled") &&
        settled.state === "replayRequired"
      ) {
        await this.#settleDurableIntent(run.id);
        return;
      }
      await this.#markRunRecoveryRequired(run.id);
      return;
    }

    const remaining = await this.#externalDrainReceiptsForRun(initialRun.id);
    if (remaining.recoveryRequired || remaining.receipts.length > 0) {
      await this.#markRunRecoveryRequired(initialRun.id);
      return;
    }
    await this.#settleDurableIntent(initialRun.id);
  }

  async #settleExecution(
    runId: string,
    outcome: RlmV2ExecutionOutcome,
  ): Promise<void> {
    let run = await this.#requireRun(runId);
    if (isTerminalRunState(run.state)) return;
    if (run.lifecycleCheckpoint) {
      if (run.state !== "running" || run.desiredState !== "run") {
        throw new RlmRuntimeV2Error("corrupt_state");
      }
      await this.#transitionRun(run, "suspended");
      return;
    }
    if (run.desiredState !== "run") {
      await this.#settleDurableIntent(run.id);
      return;
    }
    if (run.state !== "running") throw new RlmRuntimeV2Error("corrupt_state");
    if (outcome.state === "suspended") {
      await this.#transitionRun(run, "suspended");
      return;
    }
    if (outcome.state !== "succeeded") {
      await this.#transitionRun(run, "failed", null, outcome.code);
      return;
    }
    const identity = valueIdentity({
      role: "programResult",
      epochId: run.epochId,
      actorId: run.actorId,
      turnId: run.turnId,
      runId: run.id,
      programDigest: run.programDigest,
    });
    const contentDigest = digestCanonical(outcome.value);
    const sealed = await this.#seal(
      deriveValueOperationId("program-result", run.admissionDigest),
      identity,
      outcome.value,
      contentDigest,
    );
    run = await this.#requireRun(run.id);
    if (run.desiredState !== "run") {
      await this.#settleDurableIntent(run.id);
      return;
    }
    await this.#transitionRun(run, "completed", sealed.valueId, "completed");
  }

  async #reconcileReceiptsForRun(runId: string): Promise<boolean> {
    let recovery = false;
    for (const receipt of await this.#allRecoverableReceipts()) {
      if (receipt.runId !== runId) continue;
      if (receipt.state === "recoveryRequired") {
        recovery = true;
      } else if (receipt.state === "effectStarted") {
        if (!isDurablyReplayable(receipt)) {
          recovery = true;
        } else {
          try {
            await this.#authority.transitionReceipt({
              receiptId: receipt.id,
              expectedState: "effectStarted",
              nextState: "replayRequired",
            });
          } catch {
            const current = await this.#authority.readReceipt(receipt.id);
            if (current === null || !sameReceiptIdentity(current, receipt)) {
              throw new RlmRuntimeV2Error("corrupt_state");
            }
            if (
              current.state === "replayRequired" ||
              current.state === "succeeded" || current.state === "failed"
            ) continue;
            recovery = true;
          }
        }
      }
    }
    return recovery;
  }

  async #assertRecoverableExternalReceiptParents(
    receipts: readonly RlmReceiptRecord[],
  ): Promise<void> {
    const parentIds = new Set(
      receipts.filter((receipt) =>
        receipt.replayClass === "reconciledExternalMutation" &&
        (receipt.state === "effectStarted" ||
          receipt.state === "replayRequired" ||
          receipt.state === "recoveryRequired")
      ).map((receipt) => receipt.runId),
    );
    const parents = new Map<string, RlmRunRecord>();
    for (const runId of parentIds) {
      const parent = await this.#authority.readRun(runId);
      if (parent === null) throw new RlmRuntimeV2Error("corrupt_state");
      parents.set(runId, parent);
    }
    for (const receipt of receipts) {
      if (
        receipt.replayClass !== "reconciledExternalMutation" ||
        (receipt.state !== "effectStarted" &&
          receipt.state !== "replayRequired" &&
          receipt.state !== "recoveryRequired")
      ) continue;
      const parent = parents.get(receipt.runId);
      if (parent === undefined) throw new RlmRuntimeV2Error("corrupt_state");
      if (
        isTerminalRunState(parent.state) &&
        !(parent.state === "recoveryRequired" &&
          receipt.state === "recoveryRequired")
      ) throw new RlmRuntimeV2Error("corrupt_state");
    }
  }

  async #requestIntent(
    runIdValue: string,
    desiredState: RlmRunRecord["desiredState"],
  ): Promise<RlmRunRecord> {
    const runId = programRunIdSchema.parse(runIdValue);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const run = await this.#requireRun(runId);
      if (isTerminalRunState(run.state)) return run;
      if (run.desiredState === desiredState) return run;
      try {
        return await this.#authority.requestDesiredState({
          runId,
          expectedRevision: run.revision,
          expectedDesiredState: run.desiredState,
          desiredState,
        });
      } catch {
        // Re-read boundedly; a concurrent terminal or identical request wins.
      }
    }
    throw new RlmRuntimeV2Error("conflict");
  }

  async #requestLifecycleCheckpoint(runId: string): Promise<RlmRunRecord> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const run = await this.#requireRun(runId);
      if (isTerminalRunState(run.state) || run.lifecycleCheckpoint ||
          run.desiredState !== "run") return run;
      try {
        return await this.#authority.requestLifecycleCheckpoint({
          runId: run.id,
          expectedRevision: run.revision,
        });
      } catch {
        // Re-read boundedly; explicit suspend/stop or an identical checkpoint wins.
      }
    }
    throw new RlmRuntimeV2Error("conflict");
  }

  async #releaseLifecycleCheckpointOnBoot(
    runId: string,
  ): Promise<RlmRunRecord> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let run = await this.#requireRun(runId);
      if (isTerminalRunState(run.state) || !run.lifecycleCheckpoint) return run;
      if (run.desiredState !== "run") {
        throw new RlmRuntimeV2Error("corrupt_state");
      }
      try {
        if (run.state === "prepared" || run.state === "running") {
          run = await this.#transitionRun(run, "suspended");
        }
        if (run.state !== "suspended") {
          throw new RlmRuntimeV2Error("corrupt_state");
        }
        return await this.#authority.releaseLifecycleCheckpoint({
          runId: run.id,
          expectedRevision: run.revision,
        });
      } catch (cause: unknown) {
        if (cause instanceof RlmRuntimeV2Error &&
            cause.code === "corrupt_state") throw cause;
        // Re-read boundedly around a concurrent terminal or explicit intent.
      }
    }
    throw new RlmRuntimeV2Error("conflict");
  }

  async #settleDurableIntent(runId: string): Promise<RlmRunRecord> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const run = await this.#requireRun(runId);
      if (isTerminalRunState(run.state)) return run;
      if (run.desiredState === "stop") {
        const debt = await this.#externalDrainReceiptsForRun(run.id);
        if (debt.recoveryRequired) {
          return await this.#markRunRecoveryRequired(run.id);
        }
        if (debt.receipts.length > 0) {
          if (run.state === "suspended") return run;
          if (run.state !== "running") {
            return await this.#markRunRecoveryRequired(run.id);
          }
          try {
            return await this.#transitionRun(run, "suspended");
          } catch {
            continue;
          }
        }
      }
      if (run.state === "suspended" && run.desiredState !== "stop") return run;
      const target = run.desiredState === "stop"
        ? "stopped" as const
        : run.desiredState === "suspend"
          ? "suspended" as const
          : null;
      if (target === null) return run;
      try {
        return await this.#transitionRun(
          run,
          target,
          null,
          target === "stopped" ? "stopped" : null,
        );
      } catch {
        // A producer may be crossing an evaluator boundary. Re-read boundedly.
      }
    }
    throw new RlmRuntimeV2Error("conflict");
  }

  async #externalDrainReceiptsForRun(runId: string): Promise<Readonly<{
    receipts: readonly RlmReceiptRecord[];
    recoveryRequired: boolean;
  }>> {
    const receipts: RlmReceiptRecord[] = [];
    let recoveryRequired = false;
    for (const receipt of await this.#allRecoverableReceipts()) {
      if (
        receipt.runId !== runId ||
        receipt.replayClass !== "reconciledExternalMutation"
      ) continue;
      if (receipt.state === "recoveryRequired") {
        recoveryRequired = true;
      } else if (
        receipt.state === "effectStarted" ||
        receipt.state === "replayRequired"
      ) {
        receipts.push(receipt);
      }
    }
    receipts.sort((left, right) =>
      compareRlmV2NodePaths(left.nodePath, right.nodePath) ||
      left.id.localeCompare(right.id)
    );
    return { receipts, recoveryRequired };
  }

  async #markRunRecoveryRequired(runId: string): Promise<RlmRunRecord> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const run = await this.#requireRun(runId);
      if (run.state === "recoveryRequired" || isTerminalRunState(run.state)) return run;
      try {
        return await this.#transitionRun(
          run,
          "recoveryRequired",
          null,
          "recovery_required",
        );
      } catch {
        // Re-read boundedly around concurrent intent settlement.
      }
    }
    throw new RlmRuntimeV2Error("conflict");
  }

  async #transitionRun(
    run: RlmRunRecord,
    nextState: RlmRunRecord["state"],
    terminalResultValueId: string | null = null,
    terminalCode: string | null = null,
  ): Promise<RlmRunRecord> {
    return await this.#authority.transitionRun({
      runId: run.id,
      expectedRevision: run.revision,
      expectedState: run.state,
      nextState,
      terminalResultValueId,
      terminalCode,
    });
  }

  async #requireRun(runIdValue: string): Promise<RlmRunRecord> {
    let runId: string;
    try {
      runId = programRunIdSchema.parse(runIdValue);
    } catch {
      throw new RlmRuntimeV2Error("not_found");
    }
    const run = await this.#authority.readRun(runId);
    if (run === null) throw new RlmRuntimeV2Error("not_found");
    return run;
  }

  async #seal(
    operationId: string,
    identity: RlmRuntimeValueIdentity,
    value: RlmV2JsonValue,
    contentDigest: string,
  ): Promise<RlmRuntimeSealedValue> {
    const identityDigest = digestValueIdentity(identity);
    const returned = await this.#values.sealJson({
      operationId,
      identity,
      identityDigest,
      contentDigest,
      value,
    });
    const sealed = sealedValueSchema.parse(returned);
    if (sealed.contentDigest !== contentDigest ||
        sealed.identityDigest !== identityDigest) {
      throw new RlmRuntimeV2Error("corrupt_state");
    }
    return sealed;
  }

  async #open(
    valueId: string,
    identity: RlmRuntimeValueIdentity,
    contentDigest: string | null,
  ): Promise<RlmRuntimeOpenedValue> {
    const identityDigest = digestValueIdentity(identity);
    const returned = await this.#values.openJson({
      valueId,
      expectedIdentity: identity,
      expectedIdentityDigest: identityDigest,
      expectedContentDigest: contentDigest,
    });
    const opened = openedValueSchema.parse(returned);
    if (opened.valueId !== valueId || opened.identityDigest !== identityDigest ||
        (contentDigest !== null && opened.contentDigest !== contentDigest) ||
        digestCanonical(parseJsonValue(opened.value)) !== opened.contentDigest) {
      throw new RlmRuntimeV2Error("corrupt_state");
    }
    return opened;
  }

  #abortRun(runId: string): void {
    for (const producer of this.#producers) {
      if (producer.runId === runId) producer.controller.abort();
    }
  }

  #scheduleReplayIfNeeded(run: RlmRunRecord): void {
    if (
      run.state === "suspended" && run.desiredState === "run" &&
      !run.lifecycleCheckpoint
    ) {
      this.#schedule(run.id);
    }
  }

  async #allRecoverableRuns(): Promise<readonly RlmRunRecord[]> {
    return await collectPages({
      pageLimit: this.#pageLimit,
      maxRecords: this.#maxScanRecords,
      idOf: (run) => run.id,
      page: async (afterRunId) => await this.#authority.listRecoverableRuns({
        afterRunId,
        limit: this.#pageLimit,
      }),
    });
  }

  async #allRecoverableReceipts(): Promise<readonly RlmReceiptRecord[]> {
    return await collectPages({
      pageLimit: this.#pageLimit,
      maxRecords: this.#maxScanRecords,
      idOf: (receipt) => receipt.id,
      page: async (afterReceiptId) => await this.#authority.listRecoverableReceipts({
        afterReceiptId,
        limit: this.#pageLimit,
      }),
    });
  }
}

interface DurableEvaluatorBridgeOptions {
  readonly authority: RlmRuntimeRunAuthorityPort;
  readonly values: RlmRuntimeEncryptedValuePort;
  readonly operations: RlmV2OperationPort;
  readonly run: RlmRunRecord;
  readonly drainReceiptId?: string | null;
}

class DurableEvaluatorBridge implements RlmV2ReceiptPort, RlmV2OperationPort {
  readonly #authority: RlmRuntimeRunAuthorityPort;
  readonly #values: RlmRuntimeEncryptedValuePort;
  readonly #operations: RlmV2OperationPort;
  readonly #run: RlmRunRecord;
  readonly #drainReceiptId: string | null;

  constructor(options: DurableEvaluatorBridgeOptions) {
    this.#authority = options.authority;
    this.#values = options.values;
    this.#operations = options.operations;
    this.#run = options.run;
    this.#drainReceiptId = options.drainReceiptId ?? null;
  }

  async read(receiptId: string): Promise<RlmV2OperationReceipt | null> {
    const receipt = await this.#authority.readReceipt(receiptId);
    if (receipt === null || receipt.state === "prepared" ||
        receipt.state === "replayRequired") return null;
    if (receipt.runId !== this.#run.id) {
      throw new RlmRuntimeV2Error("corrupt_state");
    }
    if (receipt.state === "recoveryRequired") {
      throw new RlmRuntimeV2Error("recovery_required");
    }
    if (receipt.state === "failed") {
      throw new RlmRuntimeV2Error("not_ready");
    }
    if (receipt.state === "effectStarted" || receipt.resultValueId === null) {
      throw new RlmRuntimeV2Error("recovery_required");
    }
    const identity = receiptValueIdentity(this.#run, receipt);
    const opened = await openValue(
      this.#values,
      receipt.resultValueId,
      identity,
      null,
    );
    return rlmV2OperationReceiptSchema.parse({
      version: RLM_V2_PROGRAM_VERSION,
      id: receipt.id,
      programRunId: receipt.runId,
      programDigest: this.#run.programDigest,
      nodePath: receipt.nodePath,
      operation: receipt.operation,
      requestDigest: receipt.requestDigest,
      result: opened.value,
    });
  }

  async invoke(
    operationValue: RlmV2Operation,
    argumentsValue: Readonly<Record<string, RlmV2JsonValue>>,
    context: RlmV2OperationContext,
  ): Promise<unknown> {
    const operation = rlmV2OperationSchema.parse(operationValue);
    assertOperationContext(this.#run, operation, context);
    const requestDigest = digestCanonical({
      operation,
      arguments: argumentsValue,
    });
    const effectKey = digestCanonical([
      "oprte.rlm.effect.v2",
      context.receiptId,
      requestDigest,
    ]);
    let receipt: RlmReceiptRecord;
    if (this.#drainReceiptId === null) {
      receipt = await this.#authority.prepareReceipt({
        id: context.receiptId,
        runId: context.programRunId,
        nodePath: context.nodePath,
        operation,
        requestDigest,
        effectKey,
      });
    } else {
      const admitted = await this.#authority.readReceipt(context.receiptId);
      if (
        context.receiptId !== this.#drainReceiptId || admitted === null ||
        admitted.state !== "replayRequired" ||
        admitted.replayClass !== "reconciledExternalMutation" ||
        admitted.runId !== context.programRunId ||
        admitted.operation !== operation ||
        admitted.requestDigest !== requestDigest ||
        admitted.effectKey !== effectKey ||
        canonicalJson(admitted.nodePath) !== canonicalJson(context.nodePath)
      ) {
        throw new RlmRuntimeV2Error("recovery_required");
      }
      receipt = admitted;
    }
    if (receipt.state === "succeeded") {
      const loaded = await this.read(receipt.id);
      if (loaded === null) throw new RlmRuntimeV2Error("corrupt_state");
      return loaded.result;
    }
    if (receipt.state === "failed") throw new RlmRuntimeV2Error("not_ready");
    if (receipt.state === "recoveryRequired" || receipt.state === "effectStarted") {
      throw new RlmRuntimeV2Error("recovery_required");
    }
    if (receipt.state !== "prepared" && receipt.state !== "replayRequired") {
      throw new RlmRuntimeV2Error("corrupt_state");
    }
    receipt = await this.#authority.transitionReceipt({
      receiptId: receipt.id,
      expectedState: receipt.state,
      nextState: "effectStarted",
    });
    try {
      return parseJsonValue(
        await this.#operations.invoke(operation, argumentsValue, context),
      );
    } catch (cause: unknown) {
      if (
        cause instanceof RlmV2OperationReplayRequiredError &&
        receipt.replayClass !== "reconciledExternalMutation"
      ) {
        await this.#settleEffectFailure(receipt, "recoveryRequired", {
          code: "invalid_replay_class",
          retryable: false,
        });
        throw new RlmRuntimeV2Error("recovery_required");
      }
      if (
        context.signal.aborted ||
        cause instanceof RlmV2OperationReplayRequiredError
      ) {
        await this.#settleEffectFailure(receipt, "replayRequired", null);
      } else {
        await this.#settleEffectFailure(receipt, "failed", {
          code: "operation_failed",
          retryable: false,
        });
      }
      if (cause instanceof RlmV2OperationReplayRequiredError) throw cause;
      throw new RlmRuntimeV2Error("not_ready");
    }
  }

  async #settleEffectFailure(
    receipt: RlmReceiptRecord,
    nextState: "failed" | "replayRequired" | "recoveryRequired",
    error: Readonly<{ code: string; retryable: boolean }> | null,
  ): Promise<void> {
    try {
      await this.#authority.transitionReceipt({
          receiptId: receipt.id,
          expectedState: "effectStarted",
          nextState,
          error,
        });
        return;
    } catch {
      const current = await this.#authority.readReceipt(receipt.id);
      if (
        current?.runId === receipt.runId && current.state === nextState &&
        canonicalJson(current.error) === canonicalJson(error)
      ) {
        return;
      }
      throw new RlmRuntimeV2Error("recovery_required");
    }
  }

  async record(receiptValue: RlmV2OperationReceipt): Promise<void> {
    const logical = rlmV2OperationReceiptSchema.parse(receiptValue);
    if (
      this.#drainReceiptId !== null && logical.id !== this.#drainReceiptId
    ) throw new RlmRuntimeV2Error("recovery_required");
    const stored = await this.#authority.readReceipt(logical.id);
    if (stored === null || stored.runId !== this.#run.id) {
      throw new RlmRuntimeV2Error("corrupt_state");
    }
    if (stored.state === "succeeded") {
      const loaded = await this.read(stored.id);
      if (loaded === null || canonicalJson(loaded) !== canonicalJson(logical)) {
        throw new RlmRuntimeV2Error("conflict");
      }
      return;
    }
    if (stored.state !== "effectStarted") {
      throw new RlmRuntimeV2Error("recovery_required");
    }
    assertReceiptLogicalIdentity(this.#run, stored, logical);
    const identity = receiptValueIdentity(this.#run, stored);
    const contentDigest = digestCanonical(logical.result);
    const sealed = await sealValue(
      this.#values,
      deriveValueOperationId("receipt-result", stored.id),
      identity,
      logical.result,
      contentDigest,
    );
    await this.#authority.transitionReceipt({
      receiptId: stored.id,
      expectedState: "effectStarted",
      nextState: "succeeded",
      resultValueId: sealed.valueId,
    });
  }
}

const valueIdentitySchema: z.ZodType<RlmRuntimeValueIdentity> = z.object({
  version: z.literal(2),
  role: valueRoleSchema,
  epochId: actorEpochIdSchema,
  actorId: actorIdSchema,
  turnId: actorTurnIdSchema,
  runId: programRunIdSchema,
  programDigest: digestSchema,
  receiptId: z.string().min(16).max(128).nullable(),
  nodePath: rlmV2NodePathSchema.nullable(),
  operation: rlmV2OperationSchema.nullable(),
  requestDigest: digestSchema.nullable(),
}).strict().superRefine((value, context) => {
  const receiptFields = [value.receiptId, value.nodePath, value.operation, value.requestDigest];
  const hasAll = receiptFields.every((field) => field !== null);
  const hasNone = receiptFields.every((field) => field === null);
  if (value.role === "receiptResult" ? !hasAll : !hasNone) {
    context.addIssue({
      code: "custom",
      message: "RLM value receipt identity must exactly match its role",
    });
  }
});

const sealedValueSchema: z.ZodType<RlmRuntimeSealedValue> = z.object({
  valueId: contextValueIdSchema,
  contentDigest: digestSchema,
  identityDigest: digestSchema,
}).strict();

const openedValueSchema: z.ZodType<RlmRuntimeOpenedValue> = z.object({
  valueId: contextValueIdSchema,
  contentDigest: digestSchema,
  identityDigest: digestSchema,
  value: z.unknown(),
}).strict();

function valueIdentity(input: Readonly<{
  role: "programSource" | "programResult";
  epochId: string;
  actorId: string;
  turnId: string;
  runId: string;
  programDigest: string;
}>): RlmRuntimeValueIdentity {
  return valueIdentitySchema.parse({
    version: 2,
    ...input,
    receiptId: null,
    nodePath: null,
    operation: null,
    requestDigest: null,
  });
}

function receiptValueIdentity(
  run: RlmRunRecord,
  receipt: RlmReceiptRecord,
): RlmRuntimeValueIdentity {
  return valueIdentitySchema.parse({
    version: 2,
    role: "receiptResult",
    epochId: run.epochId,
    actorId: run.actorId,
    turnId: run.turnId,
    runId: run.id,
    programDigest: run.programDigest,
    receiptId: receipt.id,
    nodePath: receipt.nodePath,
    operation: receipt.operation,
    requestDigest: receipt.requestDigest,
  });
}

async function sealValue(
  values: RlmRuntimeEncryptedValuePort,
  operationId: string,
  identity: RlmRuntimeValueIdentity,
  value: RlmV2JsonValue,
  contentDigest: string,
): Promise<RlmRuntimeSealedValue> {
  const identityDigest = digestValueIdentity(identity);
  const sealed = sealedValueSchema.parse(await values.sealJson({
    operationId,
    identity,
    identityDigest,
    contentDigest,
    value,
  }));
  if (sealed.contentDigest !== contentDigest || sealed.identityDigest !== identityDigest) {
    throw new RlmRuntimeV2Error("corrupt_state");
  }
  return sealed;
}

async function openValue(
  values: RlmRuntimeEncryptedValuePort,
  valueId: string,
  identity: RlmRuntimeValueIdentity,
  contentDigest: string | null,
): Promise<RlmRuntimeOpenedValue> {
  const identityDigest = digestValueIdentity(identity);
  const opened = openedValueSchema.parse(await values.openJson({
    valueId,
    expectedIdentity: identity,
    expectedIdentityDigest: identityDigest,
    expectedContentDigest: contentDigest,
  }));
  if (opened.valueId !== valueId || opened.identityDigest !== identityDigest ||
      (contentDigest !== null && opened.contentDigest !== contentDigest) ||
      digestCanonical(parseJsonValue(opened.value)) !== opened.contentDigest) {
    throw new RlmRuntimeV2Error("corrupt_state");
  }
  return opened;
}

export function deriveRlmRuntimeAdmissionDigest(input: Readonly<{
  runId: string;
  epochId: string;
  actorId: string;
  turnId: string;
  completedPrefixSnapshotId: string;
  currentUserInputValueId: string | null;
  releaseIdentityDigest: string;
  fuelLimit: number;
  programDigest: string;
  caller: RlmV2Caller;
}>): string {
  const caller = parseRlmV2Caller(input.caller);
  return digestCanonical({
    domain: "oprte.rlm.run-admission.v2",
    runId: programRunIdSchema.parse(input.runId),
    epochId: actorEpochIdSchema.parse(input.epochId),
    actorId: actorIdSchema.parse(input.actorId),
    turnId: actorTurnIdSchema.parse(input.turnId),
    completedPrefixSnapshotId: contextSnapshotIdSchema.parse(
      input.completedPrefixSnapshotId,
    ),
    currentUserInputValueId: contextValueIdSchema.nullable().parse(
      input.currentUserInputValueId,
    ),
    releaseIdentityDigest: digestSchema.parse(input.releaseIdentityDigest),
    fuelLimit: z.literal(RLM_V2_MAX_FUEL).parse(input.fuelLimit),
    programDigest: digestSchema.parse(input.programDigest),
    caller: canonicalCaller(caller),
  });
}

function canonicalCaller(caller: RlmV2Caller): RlmV2JsonValue {
  return {
    epochId: caller.epochId,
    actorId: caller.actorId,
    turnId: caller.turnId,
    capabilities: caller.capabilities.toSorted(),
    admittedFeatures: caller.admittedFeatures.toSorted(),
    semanticWitnessDigests: caller.semanticWitnessDigests.toSorted(),
    budget: { ...caller.budget },
  };
}

function assertAdmission(
  input: z.output<typeof admissionInputSchema>,
  program: RlmV2Program,
  caller: RlmV2Caller,
  now: number,
): void {
  if (input.fuelLimit !== RLM_V2_MAX_FUEL ||
      caller.epochId !== input.epochId ||
      caller.actorId !== input.actorId ||
      caller.turnId !== input.turnId) {
    throw new RlmRuntimeV2Error("invalid_admission");
  }
  const callerCapabilities = new Set(caller.capabilities);
  if (program.capabilities.some((capability) => !callerCapabilities.has(capability))) {
    throw new RlmRuntimeV2Error("invalid_admission");
  }
  if (Date.parse(caller.budget.deadline) <= now) {
    throw new RlmRuntimeV2Error("invalid_admission");
  }
}

function assertStoredAdmission(
  run: RlmRunRecord,
  program: RlmV2Program,
  caller: RlmV2Caller,
): void {
  if (run.fuelLimit !== RLM_V2_MAX_FUEL ||
      caller.epochId !== run.epochId ||
      caller.actorId !== run.actorId ||
      caller.turnId !== run.turnId ||
      run.deadline !== caller.budget.deadline ||
      canonicalJson(run.capabilities) !== canonicalJson(caller.capabilities.toSorted()) ||
      canonicalJson(run.admittedFeatures) !==
        canonicalJson(caller.admittedFeatures.toSorted()) ||
      canonicalJson(run.semanticWitnessDigests) !==
        canonicalJson(caller.semanticWitnessDigests.toSorted()) ||
      canonicalJson(run.budget) !== canonicalJson(caller.budget) ||
      digestRlmV2Program(program) !== run.programDigest) {
    throw new RlmRuntimeV2Error("corrupt_state");
  }
  const derived = deriveRlmRuntimeAdmissionDigest({
    runId: run.id,
    epochId: run.epochId,
    actorId: run.actorId,
    turnId: run.turnId,
    completedPrefixSnapshotId: run.completedPrefixSnapshotId,
    currentUserInputValueId: run.currentUserInputValueId,
    releaseIdentityDigest: run.releaseIdentityDigest,
    fuelLimit: run.fuelLimit,
    programDigest: run.programDigest,
    caller,
  });
  if (derived !== run.admissionDigest) throw new RlmRuntimeV2Error("corrupt_state");
}

function assertOperationContext(
  run: RlmRunRecord,
  operation: RlmV2Operation,
  context: RlmV2OperationContext,
): void {
  if (context.epochId !== run.epochId ||
      context.actorId !== run.actorId ||
      context.turnId !== run.turnId ||
      context.programRunId !== run.id || context.programDigest !== run.programDigest ||
      deriveRlmV2ReceiptId(run.id, run.programDigest, context.nodePath) !== context.receiptId ||
      !run.capabilities.includes(operationCapability(operation))) {
    throw new RlmRuntimeV2Error("corrupt_state");
  }
}

function operationCapability(operation: RlmV2Operation): RlmRunRecord["capabilities"][number] {
  switch (operation) {
    case "context.snapshot":
    case "context.search":
    case "context.slice":
      return "context.read";
    case "context.materialize":
      return "context.materialize";
    case "heap.put":
      return "heap.write";
    case "heap.get":
    case "heap.list":
      return "heap.read";
    case "agent.spawn":
      return "agent.spawn";
    case "agent.send":
      return "agent.message";
    case "agent.status":
    case "agent.waitAny":
    case "agent.waitAll":
    case "agent.result":
      return "agent.wait";
    case "agent.cancel":
      return "agent.cancel";
    case "routing.inspect":
      return "routing.inspect";
    case "harness.propose":
      return "harness.propose";
  }
}

function assertReceiptLogicalIdentity(
  run: RlmRunRecord,
  stored: RlmReceiptRecord,
  logical: RlmV2OperationReceipt,
): void {
  if (logical.id !== stored.id || logical.programRunId !== run.id ||
      logical.programDigest !== run.programDigest ||
      canonicalJson(logical.nodePath) !== canonicalJson(stored.nodePath) ||
      logical.operation !== stored.operation ||
      logical.requestDigest !== stored.requestDigest) {
    throw new RlmRuntimeV2Error("conflict");
  }
}

function sameReceiptIdentity(
  left: RlmReceiptRecord,
  right: RlmReceiptRecord,
): boolean {
  return left.id === right.id && left.runId === right.runId &&
    left.operation === right.operation &&
    left.requestDigest === right.requestDigest &&
    left.effectKey === right.effectKey &&
    left.replayClass === right.replayClass &&
    canonicalJson(left.nodePath) === canonicalJson(right.nodePath);
}

function isDurablyReplayable(receipt: RlmReceiptRecord): boolean {
  switch (receipt.replayClass) {
    case "pureRead":
    case "cancelableWait":
    case "idempotentLocalMutation":
      return true;
    case "reconciledExternalMutation":
      // RlmV2OperationPort requires reconciliation/idempotent application by receipt ID.
      return true;
  }
}

function publicHandle(run: RlmRunRecord): RlmRuntimeRunHandle {
  return {
    runId: run.id,
    state: run.state,
    desiredState: run.desiredState,
    revision: run.revision,
  };
}

function digestValueIdentity(identityValue: RlmRuntimeValueIdentity): string {
  const identity = valueIdentitySchema.parse(identityValue);
  return digestCanonical({
    domain: "oprte.rlm.encrypted-value-identity.v2",
    ...identity,
  });
}

function deriveValueOperationId(kind: string, stableIdentity: string): string {
  return `rlmvalue_${createHash("sha256")
    .update("oprte.rlm.value-operation.v2\0")
    .update(kind)
    .update("\0")
    .update(stableIdentity)
    .digest("base64url")}`;
}

function parseJsonValue(value: unknown): RlmV2JsonValue {
  const active = new WeakSet<object>();
  let nodes = 0;
  const visit = (current: unknown, depth: number): RlmV2JsonValue => {
    nodes += 1;
    if (nodes > 100_000 || depth > 64) throw new RlmRuntimeV2Error("corrupt_state");
    if (current === null || typeof current === "boolean" || typeof current === "string") {
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Math.abs(current) > Number.MAX_SAFE_INTEGER) {
        throw new RlmRuntimeV2Error("corrupt_state");
      }
      return current;
    }
    if (typeof current !== "object" || active.has(current)) {
      throw new RlmRuntimeV2Error("corrupt_state");
    }
    const prototype: unknown = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
      throw new RlmRuntimeV2Error("corrupt_state");
    }
    active.add(current);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(current);
      if (Reflect.ownKeys(descriptors).some((key) => typeof key === "symbol")) {
        throw new RlmRuntimeV2Error("corrupt_state");
      }
      if (Array.isArray(current)) {
        if (current.length > RLM_V2_MAX_COLLECTION_ITEMS ||
            Object.keys(descriptors).some((key) =>
              key !== "length" && !/^(0|[1-9][0-9]*)$/u.test(key)
            )) {
          throw new RlmRuntimeV2Error("corrupt_state");
        }
        const output: RlmV2JsonValue[] = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined || !("value" in descriptor)) {
            throw new RlmRuntimeV2Error("corrupt_state");
          }
          output.push(visit(descriptor.value, depth + 1));
        }
        return output;
      }
      if (Object.keys(descriptors).length > RLM_V2_MAX_COLLECTION_ITEMS) {
        throw new RlmRuntimeV2Error("corrupt_state");
      }
      const output = Object.create(null) as Record<string, RlmV2JsonValue>;
      for (const key of Object.keys(descriptors).toSorted()) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new RlmRuntimeV2Error("corrupt_state");
        }
        const descriptor = descriptors[key];
        if (descriptor === undefined || !("value" in descriptor)) {
          throw new RlmRuntimeV2Error("corrupt_state");
        }
        output[key] = visit(descriptor.value, depth + 1);
      }
      const checked = output;
      if (Buffer.byteLength(canonicalJson(checked), "utf8") >
          RLM_V2_MAX_SOURCE_UTF8_BYTES) {
        throw new RlmRuntimeV2Error("corrupt_state");
      }
      return checked;
    } finally {
      active.delete(current);
    }
  };
  return visit(value, 0);
}

function digestCanonical(value: RlmV2JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).toSorted().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}

async function collectPages<T>(input: Readonly<{
  pageLimit: number;
  maxRecords: number;
  idOf: (value: T) => string;
  page: (after: string | null) => Promise<readonly T[]>;
}>): Promise<readonly T[]> {
  const output: T[] = [];
  let after: string | null = null;
  while (true) {
    const page = await input.page(after);
    if (page.length > input.pageLimit) throw new RlmRuntimeV2Error("corrupt_state");
    let previous: string | null = after;
    for (const value of page) {
      const id = input.idOf(value);
      if (previous !== null && id <= previous) {
        throw new RlmRuntimeV2Error("corrupt_state");
      }
      output.push(value);
      previous = id;
      if (output.length > input.maxRecords) {
        throw new RlmRuntimeV2Error("recovery_required");
      }
    }
    if (page.length < input.pageLimit) return output;
    if (previous === after) throw new RlmRuntimeV2Error("corrupt_state");
    after = previous;
  }
}

function sorted(values: ReadonlySet<string>): readonly string[] {
  return [...values].toSorted();
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new RlmRuntimeV2Error("cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RlmRuntimeV2Error("cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
