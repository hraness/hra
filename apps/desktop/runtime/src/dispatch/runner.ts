import {
  MAX_DISPATCH_CLAIMS_PER_PULL,
  MAX_RUN_EVENT_BATCH,
  HRA_DISPATCH_PROTOCOL_VERSION,
  RUNNER_HEARTBEAT_INTERVAL_MS,
  publicRunStatusEventKindSchema,
  publicRunTextEventKindSchema,
  runnerHeartbeatRequestSchema,
  runnerHeartbeatResponseMatchesRequest,
  type ClaimedDispatch,
  type RunnerHeartbeatRequest,
  type RunnerHeartbeatResponse,
} from "@hraness/agent-tasks-protocol";
import type {
  dispatchCandidateSchema,
  runnerBlockReasonSchema,
  runnerReportedStateSchema,
} from "@hraness/agent-tasks-protocol";
import { createHash } from "node:crypto";
import type { z } from "@hra-internal/schema";

import type {
  DispatchAssignment,
  DispatchExecutionResult,
  DispatchFenceGuard,
  DispatchPublicationBarrier,
} from "./coordinator";
import type {
  DispatchBinding,
  PendingDispatchEvent,
} from "../state/dispatch-store";
import type {
  DispatchCloudFailure,
  HRADispatchHttpClient,
} from "./cloud-client";
import type { DispatchInteractionSyncStatus } from "./interaction-adapter";
import { renderTaskWorkflowPromptV1 } from "./task-workflow-prompt-v1";

const DEFAULT_PULL_INTERVAL_MS = 2_000;
const DEFAULT_PULL_JITTER_RATIO = 0.25;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

type DispatchCandidate = z.infer<typeof dispatchCandidateSchema>;
type RunnerBlockReason = z.infer<typeof runnerBlockReasonSchema>;
type RunnerReportedState = z.infer<typeof runnerReportedStateSchema>;

export interface DispatchRunnerClock {
  now(): number;
}

export interface DispatchRunnerScheduler {
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export interface DispatchRunnerRandom {
  sample(): number;
}

export interface DispatchCapabilitySnapshot {
  readonly reportedState: RunnerReportedState;
  readonly blockReason?: RunnerBlockReason;
  readonly capacity: number;
  readonly activeRuns: number;
  readonly retainedRunIds: readonly string[];
  readonly repositoryIds: readonly string[];
}

export interface LocalDispatchSlot {
  readonly accountProfileId: string;
  readonly repositoryId: string;
  readonly repositoryPath: string;
  readonly reservationId: string;
}

export type DispatchSlotDisposition =
  | Readonly<{ kind: "claim_failed" }>
  | Readonly<{ kind: "running"; runId: string }>
  | Readonly<{ kind: "terminal"; runId: string }>
  | Readonly<{ kind: "ambiguous"; runId: string }>
  | Readonly<{ kind: "lease_lost"; runId: string }>
  | Readonly<{ kind: "execution_failed"; runId: string }>;

export interface DispatchCapabilityPort {
  snapshot(signal?: AbortSignal): Promise<DispatchCapabilitySnapshot>;
  acquire(candidate: DispatchCandidate, signal?: AbortSignal): Promise<LocalDispatchSlot | null>;
  settle(slot: LocalDispatchSlot, disposition: DispatchSlotDisposition): Promise<void>;
  releaseRun(runId: string): unknown;
}

export interface DispatchExecutionPort {
  execute(assignment: DispatchAssignment, signal?: AbortSignal): Promise<DispatchExecutionResult>;
}

export interface DispatchOutboxPort {
  read(runId: string): DispatchBinding | null;
  materializeDisplayDraft?(runId: string): PendingDispatchEvent | null;
  pendingEvents(limit?: number): readonly PendingDispatchEvent[];
  pendingEventsForRun(runId: string, limit?: number): readonly PendingDispatchEvent[];
  isAcknowledged(runId: string, throughSequence: number): boolean;
  acknowledge(runId: string, throughSequence: number): number;
}

export type DispatchRevocationReason =
  | "stop_requested"
  | "cloud_terminal"
  | "lease_expired"
  | "fence_rejected"
  | "runner_invalid"
  | "interaction_limit"
  | "interaction_resolution_ambiguous"
  | "invalid_interaction_response"
  | "shutdown";

export interface DispatchRevocationPort {
  revoke(runId: string, reason: DispatchRevocationReason): Promise<void>;
}

export interface DispatchInteractionSyncPort {
  syncOnce(
    currentRunIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<DispatchInteractionSyncStatus>;
}

export type DispatchRunnerDiagnosticCode =
  | "capability_invalid"
  | "heartbeat_unavailable"
  | "heartbeat_rejected"
  | "claim_unavailable"
  | "claim_rejected"
  | "claim_target_unavailable"
  | "execution_failed"
  | "outbox_corrupt"
  | "outbox_unavailable"
  | "outbox_fence_rejected"
  | "interaction_unavailable"
  | "interaction_fence_rejected"
  | "interaction_rejected"
  | "interaction_limit"
  | "interaction_resolution_ambiguous"
  | "invalid_interaction_response"
  | "revocation_failed";

export interface DispatchRunnerDiagnostic {
  readonly code: DispatchRunnerDiagnosticCode;
  readonly runId?: string;
}

export interface HRADispatchRunnerIdentity {
  readonly runnerId: string;
  readonly installationId: string;
  readonly bootId: string;
  readonly bootGeneration: number;
  readonly clientVersion: string;
}

export interface DispatchHeartbeatJournal {
  pendingHeartbeat(input: Readonly<{
    runnerId: string;
    installationId: string;
    bootId: string;
    bootGeneration: number;
    sequence: number;
  }>): RunnerHeartbeatRequest | null;
  prepareHeartbeat(request: RunnerHeartbeatRequest): RunnerHeartbeatRequest;
}

export interface HRADispatchRunnerOptions {
  readonly identity: HRADispatchRunnerIdentity;
  readonly cloud: Pick<HRADispatchHttpClient, "heartbeat" | "claim" | "appendEvents">;
  readonly capabilities: DispatchCapabilityPort;
  readonly heartbeatJournal?: DispatchHeartbeatJournal;
  readonly executor: DispatchExecutionPort;
  readonly outbox: DispatchOutboxPort;
  readonly revocations: DispatchRevocationPort;
  readonly interactions?: DispatchInteractionSyncPort;
  readonly clock?: DispatchRunnerClock;
  readonly scheduler?: DispatchRunnerScheduler;
  readonly random?: DispatchRunnerRandom;
  readonly initialHeartbeatSequence?: number;
  readonly pullIntervalMs?: number;
  readonly pullJitterRatio?: number;
  readonly shutdownGraceMs?: number;
  readonly onDiagnostic?: (diagnostic: DispatchRunnerDiagnostic) => void;
  readonly onRunnerStatus?: (status: "connected" | "contended" | "unavailable") => void;
  readonly onHeartbeatAccepted?: (input: {
    readonly bootId: string;
    readonly bootGeneration: number;
    readonly sequence: number;
  }) => void | Promise<void>;
  readonly onRunTerminalAcknowledged?: (runId: string) => void | Promise<void>;
}

export type DispatchRunnerExit =
  | Readonly<{ kind: "stopped" }>
  | Readonly<{ kind: "halted"; reason: "authentication" | "protocol" }>;

interface DispatchLeaseRecord {
  readonly runId: string;
  readonly claimId: string;
  readonly claimFence: number;
  readonly runtimePublicId: string;
  readonly runtimeBootId: string;
  expiresAt: number;
}

// Lease authority is duration-based. A wall clock can jump after NTP correction,
// sleep, or a manual date change, so production uses the process monotonic clock.
const systemClock: DispatchRunnerClock = { now: () => performance.now() };
const systemScheduler: DispatchRunnerScheduler = {
  sleep(milliseconds, signal) {
    if (signal?.aborted === true) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(done, milliseconds);
      function done(): void {
        signal?.removeEventListener("abort", done);
        clearTimeout(timeout);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    });
  },
};
const systemRandom: DispatchRunnerRandom = { sample: () => Math.random() };

export class DispatchLeaseRegistry implements DispatchFenceGuard {
  readonly #clock: DispatchRunnerClock;
  readonly #records = new Map<string, DispatchLeaseRecord>();
  readonly #runtimeBootId: string;
  readonly #runtimePublicId: string;
  #lastObservedAt = Number.NEGATIVE_INFINITY;
  #runnerExpiresAt = 0;
  #serverAnchor: Readonly<{ serverTime: number; localTime: number }> | null = null;

  constructor(options: {
    readonly clock: DispatchRunnerClock;
    readonly runtimePublicId: string;
    readonly runtimeBootId: string;
  }) {
    this.#clock = options.clock;
    this.#runtimePublicId = options.runtimePublicId;
    this.#runtimeBootId = options.runtimeBootId;
  }

  observeHeartbeat(
    response: RunnerHeartbeatResponse,
    authorityStartedAt: number,
    renewDispatches: boolean,
  ): void {
    const receivedAt = this.#now();
    const presenceDuration = response.leaseUntil - response.serverTime;
    this.#runnerExpiresAt = authorityStartedAt + presenceDuration;
    this.#serverAnchor = { serverTime: response.serverTime, localTime: authorityStartedAt };
    if (renewDispatches) {
      const runLeases = new Map(response.runLeases.map(({ runId, leaseUntil }) => [
        runId,
        leaseUntil,
      ] as const));
      for (const record of this.#records.values()) {
        const serverDeadline = runLeases.get(record.runId);
        if (serverDeadline === undefined) continue;
        const remaining = Math.max(0, serverDeadline - response.serverTime);
        record.expiresAt = Math.min(
          authorityStartedAt + remaining,
          receivedAt + remaining,
        );
      }
    }
    // Never let response latency turn a valid server lease into more local time.
    this.#runnerExpiresAt = Math.min(this.#runnerExpiresAt, receivedAt + presenceDuration);
  }

  registerClaim(claim: ClaimedDispatch): "new" | "replay" | "conflict" {
    const existing = this.#records.get(claim.runId);
    if (existing !== undefined) {
      return existing.claimId === claim.claimId && existing.claimFence === claim.claimFence
        ? "replay"
        : "conflict";
    }
    const now = this.#now();
    const estimatedServerNow = this.#serverAnchor === null
      ? now
      : this.#serverAnchor.serverTime + Math.max(0, now - this.#serverAnchor.localTime);
    const remaining = Math.max(0, claim.leaseUntil - estimatedServerNow);
    this.#records.set(claim.runId, {
      runId: claim.runId,
      claimId: claim.claimId,
      claimFence: claim.claimFence,
      runtimePublicId: this.#runtimePublicId,
      runtimeBootId: this.#runtimeBootId,
      expiresAt: now + remaining,
    });
    return "new";
  }

  hasRunnerLease(): boolean {
    return this.#now() < this.#runnerExpiresAt;
  }

  currentRunIds(): readonly string[] {
    return [...this.#records.values()]
      .filter((record) => this.#isRecordCurrent(record))
      .map(({ runId }) => runId);
  }

  runIds(): readonly string[] {
    return [...this.#records.keys()];
  }

  expiredRunIds(): readonly string[] {
    const now = this.#now();
    return [...this.#records.values()]
      .filter((record) => now >= record.expiresAt || now >= this.#runnerExpiresAt)
      .map(({ runId }) => runId);
  }

  revoke(runId: string): boolean {
    return this.#records.delete(runId);
  }

  assertCurrent(input: {
    readonly claimFence: number;
    readonly claimId: string;
    readonly runId: string;
    readonly runtimeBootId: string;
    readonly runtimePublicId: string;
  }): Promise<boolean> {
    const record = this.#records.get(input.runId);
    return Promise.resolve(record !== undefined &&
      record.claimId === input.claimId &&
      record.claimFence === input.claimFence &&
      record.runtimeBootId === input.runtimeBootId &&
      record.runtimePublicId === input.runtimePublicId &&
      this.#isRecordCurrent(record));
  }

  #isRecordCurrent(record: DispatchLeaseRecord): boolean {
    const now = this.#now();
    return now < record.expiresAt && now < this.#runnerExpiresAt;
  }

  #now(): number {
    const observed = this.#clock.now();
    if (!Number.isFinite(observed)) {
      this.#lastObservedAt = Number.POSITIVE_INFINITY;
      return this.#lastObservedAt;
    }
    this.#lastObservedAt = Math.max(this.#lastObservedAt, observed);
    return this.#lastObservedAt;
  }
}

export class HRADispatchRunner implements DispatchPublicationBarrier {
  readonly #identity: HRADispatchRunnerIdentity;
  readonly #cloud: HRADispatchRunnerOptions["cloud"];
  readonly #capabilities: DispatchCapabilityPort;
  readonly #heartbeatJournal: DispatchHeartbeatJournal | null;
  readonly #executor: DispatchExecutionPort;
  readonly #outbox: DispatchOutboxPort;
  readonly #interactions: DispatchInteractionSyncPort | null;
  readonly #revocations: DispatchRevocationPort;
  readonly #clock: DispatchRunnerClock;
  readonly #scheduler: DispatchRunnerScheduler;
  readonly #random: DispatchRunnerRandom;
  readonly #leases: DispatchLeaseRegistry;
  readonly #pullIntervalMs: number;
  readonly #pullJitterRatio: number;
  readonly #shutdownGraceMs: number;
  readonly #onDiagnostic: (diagnostic: DispatchRunnerDiagnostic) => void;
  readonly #onHeartbeatAccepted: NonNullable<HRADispatchRunnerOptions["onHeartbeatAccepted"]>;
  readonly #onRunnerStatus: NonNullable<HRADispatchRunnerOptions["onRunnerStatus"]>;
  readonly #onRunTerminalAcknowledged: NonNullable<
    HRADispatchRunnerOptions["onRunTerminalAcknowledged"]
  >;
  readonly #candidates = new Map<string, DispatchCandidate>();
  readonly #executions = new Map<string, Promise<void>>();
  readonly #runControllers = new Map<string, AbortController>();
  readonly #revocationTasks = new Map<string, Promise<void>>();
  #flushTail: Promise<void> = Promise.resolve();
  #heartbeatSequence: number;
  #heartbeatAuthorityStartedAt: number | null = null;
  #heartbeatIndeterminate = false;
  #pendingHeartbeatRequest: RunnerHeartbeatRequest | null = null;
  #desiredState: "active" | "draining" = "active";
  #haltReason: "authentication" | "protocol" | undefined;
  #running = false;
  #supervisorController: AbortController | null = null;

  constructor(options: HRADispatchRunnerOptions) {
    this.#identity = options.identity;
    this.#cloud = options.cloud;
    this.#capabilities = options.capabilities;
    this.#heartbeatJournal = options.heartbeatJournal ?? null;
    this.#executor = options.executor;
    this.#outbox = options.outbox;
    this.#interactions = options.interactions ?? null;
    this.#revocations = options.revocations;
    this.#clock = options.clock ?? systemClock;
    this.#scheduler = options.scheduler ?? systemScheduler;
    this.#random = options.random ?? systemRandom;
    this.#heartbeatSequence = positiveInteger(options.initialHeartbeatSequence ?? 1, "heartbeat sequence");
    this.#pullIntervalMs = boundedInteger(options.pullIntervalMs ?? DEFAULT_PULL_INTERVAL_MS, 100, 60_000, "pull interval");
    this.#pullJitterRatio = boundedNumber(options.pullJitterRatio ?? DEFAULT_PULL_JITTER_RATIO, 0, 0.5, "pull jitter ratio");
    this.#shutdownGraceMs = boundedInteger(options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS, 1, 60_000, "shutdown grace");
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined);
    this.#onHeartbeatAccepted = options.onHeartbeatAccepted ?? (() => undefined);
    this.#onRunnerStatus = options.onRunnerStatus ?? (() => undefined);
    this.#onRunTerminalAcknowledged = options.onRunTerminalAcknowledged ?? (() => undefined);
    this.#leases = new DispatchLeaseRegistry({
      clock: this.#clock,
      runtimePublicId: options.identity.runnerId,
      runtimeBootId: options.identity.bootId,
    });
  }

  get fence(): DispatchFenceGuard {
    return this.#leases;
  }

  async run(signal?: AbortSignal): Promise<DispatchRunnerExit> {
    if (this.#running) throw new Error("dispatch runner is already supervised");
    this.#running = true;
    this.#haltReason = undefined;
    const controller = new AbortController();
    this.#supervisorController = controller;
    const stop = (): void => controller.abort();
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted === true) controller.abort();
    try {
      try {
        await Promise.all([this.#heartbeatLoop(controller.signal), this.#pullLoop(controller.signal)]);
      } catch (error) {
        controller.abort();
        await this.#revokeAll("runner_invalid");
        await this.#drainExecutions();
        throw error;
      }
      if (aborted(signal)) await this.#revokeAll("shutdown");
      if (this.#haltReason !== undefined) await this.#revokeAll("runner_invalid");
      await this.#drainExecutions();
      return this.#haltReason === undefined
        ? { kind: "stopped" }
        : { kind: "halted", reason: this.#haltReason };
    } finally {
      controller.abort();
      signal?.removeEventListener("abort", stop);
      this.#supervisorController = null;
      this.#running = false;
    }
  }

  async heartbeatOnce(signal?: AbortSignal): Promise<"ok" | "retry" | "halted" | "aborted"> {
    if (this.#haltReason !== undefined) return "halted";
    if (aborted(signal)) return "aborted";
    try {
      let request = this.#pendingHeartbeatRequest;
      if (request === null) {
        request = this.#heartbeatJournal?.pendingHeartbeat({
          runnerId: this.#identity.runnerId,
          installationId: this.#identity.installationId,
          bootId: this.#identity.bootId,
          bootGeneration: this.#identity.bootGeneration,
          sequence: this.#heartbeatSequence,
        }) ?? null;
        if (request === null) {
          const snapshot = await this.#capabilities.snapshot(signal);
          const currentRunIds = [...this.#leases.currentRunIds()].sort();
          const retainedRunIds = [...new Set([
            ...snapshot.retainedRunIds,
            ...currentRunIds,
          ])].sort();
          request = runnerHeartbeatRequestSchema.parse({
            ...this.#identity,
            sequence: this.#heartbeatSequence,
            protocolVersion: HRA_DISPATCH_PROTOCOL_VERSION,
            reportedState: snapshot.reportedState,
            ...(snapshot.blockReason === undefined
              ? {}
              : { blockReason: snapshot.blockReason }),
            capacity: snapshot.capacity,
            activeRuns: Math.max(snapshot.activeRuns, retainedRunIds.length),
            currentRunIds,
            retainedRunIds,
            repositoryIds: [...new Set(snapshot.repositoryIds)].sort(),
          });
          request = this.#heartbeatJournal?.prepareHeartbeat(request) ??
            request;
        }
        this.#pendingHeartbeatRequest = request;
        this.#heartbeatAuthorityStartedAt = this.#clock.now();
      }
      const result = await this.#cloud.heartbeat(request, signal);
      if (!result.ok) return this.#heartbeatFailure(result.error);
      if (!runnerHeartbeatResponseMatchesRequest(request, result.data)) {
        throw new Error("Heartbeat response does not match its request snapshot");
      }

      const authorityStartedAt = this.#heartbeatAuthorityStartedAt;
      if (authorityStartedAt === null) throw new Error("Heartbeat authority clock is unavailable");
      this.#leases.observeHeartbeat(
        result.data,
        authorityStartedAt,
        !this.#heartbeatIndeterminate,
      );
      await this.#onHeartbeatAccepted({
        bootId: this.#identity.bootId,
        bootGeneration: this.#identity.bootGeneration,
        sequence: this.#heartbeatSequence,
      });
      this.#heartbeatSequence = nextPositiveInteger(this.#heartbeatSequence);
      this.#heartbeatAuthorityStartedAt = null;
      this.#heartbeatIndeterminate = false;
      this.#pendingHeartbeatRequest = null;
      this.#desiredState = result.data.desiredState;
      this.#onRunnerStatus("connected");
      this.#replaceCandidates(result.data.desiredState === "active" ? result.data.candidates : []);
      for (const runId of result.data.releaseRunIds) {
        const released = this.#outbox.read(runId);
        if (released !== null && released.lastEventSequence > 0) {
          this.#outbox.acknowledge(runId, released.lastEventSequence);
        }
        // A cloud terminal is proof that no more local events should publish,
        // not proof that the owned Codex turn stopped. Reconcile the local turn
        // before releasing its account slot, and retry on later heartbeats when
        // interruption remains ambiguous.
        await this.#revokeRun(runId, "cloud_terminal", true);
      }
      for (const runId of result.data.stopRunIds) {
        await this.#revokeRun(runId, "stop_requested");
      }
      await this.#revokeExpired();
      return "ok";
    } catch {
      this.#onDiagnostic({ code: "capability_invalid" });
      this.#halt("protocol");
      return "halted";
    }
  }

  async pullOnce(signal?: AbortSignal): Promise<"ok" | "retry" | "halted" | "aborted"> {
    if (this.#haltReason !== undefined) return "halted";
    if (aborted(signal)) return "aborted";
    await this.#revokeExpired();
    if (!this.#leases.hasRunnerLease() || this.#desiredState !== "active") return "retry";
    const outbox = await this.#flushOutbox(signal);
    if (outbox !== "ok") return outbox;
    const interactions = await this.#syncInteractions(signal);
    if (interactions !== "ok") return interactions;

    let snapshot: DispatchCapabilitySnapshot;
    try {
      snapshot = await this.#capabilities.snapshot(signal);
    } catch {
      this.#onDiagnostic({ code: "capability_invalid" });
      return "retry";
    }
    const available = Math.max(
      0,
      snapshot.capacity - Math.max(snapshot.activeRuns, this.#executions.size),
    );
    const claimLimit = Math.min(
      available,
      MAX_DISPATCH_CLAIMS_PER_PULL,
      this.#candidates.size,
    );
    const candidates = [...this.#candidates.values()].slice(0, claimLimit);
    for (const candidate of candidates) {
      if (aborted(signal)) return "aborted";
      await this.#claimCandidate(candidate, signal);
      if (this.#haltReason !== undefined) return "halted";
    }
    return "ok";
  }

  forgetRun(runId: string): void {
    this.#runControllers.get(runId)?.abort();
    this.#leases.revoke(runId);
    this.#runControllers.delete(runId);
  }

  acknowledgeThrough(
    runId: string,
    throughSequence: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.#acknowledgeThrough(runId, throughSequence, signal);
  }

  async #heartbeatLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.heartbeatOnce(signal);
      if (!signal.aborted) await this.#scheduler.sleep(RUNNER_HEARTBEAT_INTERVAL_MS, signal);
    }
  }

  async #pullLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.pullOnce(signal);
      if (!signal.aborted) {
        await this.#scheduler.sleep(
          boundedJitterMilliseconds(
            this.#pullIntervalMs,
            this.#pullJitterRatio,
            this.#random.sample(),
          ),
          signal,
        );
      }
    }
  }

  #heartbeatFailure(failure: DispatchCloudFailure): "retry" | "halted" | "aborted" {
    if (failure.kind === "aborted") {
      this.#heartbeatIndeterminate = true;
      return "aborted";
    }
    if (failure.kind === "network" || failure.kind === "timeout" || failure.kind === "invalid_response") {
      this.#heartbeatIndeterminate = true;
      this.#onRunnerStatus("unavailable");
      this.#onDiagnostic({ code: "heartbeat_unavailable" });
      return "retry";
    }
    if (isRetryableRemote(failure)) {
      if (!this.#heartbeatIndeterminate) {
        this.#heartbeatAuthorityStartedAt = null;
        this.#pendingHeartbeatRequest = null;
      }
      this.#onRunnerStatus(failure.code === "RUNNER_ALREADY_CONNECTED" ? "contended" : "unavailable");
      this.#onDiagnostic({ code: "heartbeat_unavailable" });
      return "retry";
    }
    this.#onDiagnostic({ code: "heartbeat_rejected" });
    this.#halt(isAuthenticationFailure(failure) ? "authentication" : "protocol");
    return "halted";
  }

  async #claimCandidate(candidate: DispatchCandidate, signal?: AbortSignal): Promise<void> {
    const candidateKey = dispatchCandidateKey(candidate);
    this.#candidates.delete(candidateKey);
    let slot: LocalDispatchSlot | null;
    try {
      slot = await this.#capabilities.acquire(candidate, signal);
    } catch {
      this.#onDiagnostic({ code: "claim_target_unavailable" });
      return;
    }
    if (slot === null || slot.repositoryId !== candidate.repositoryId) {
      this.#onDiagnostic({ code: "claim_target_unavailable" });
      if (slot !== null) await this.#capabilities.settle(slot, { kind: "claim_failed" });
      return;
    }

    const result = await this.#cloud.claim({
      runnerId: this.#identity.runnerId,
      bootId: this.#identity.bootId,
      bootGeneration: this.#identity.bootGeneration,
      taskKey: candidate.taskKey,
      repositoryId: candidate.repositoryId,
    }, signal);
    if (!result.ok) {
      await this.#capabilities.settle(slot, { kind: "claim_failed" });
      if (result.error.kind === "aborted") return;
      if (isFatalCloudFailure(result.error)) {
        this.#onDiagnostic({ code: "claim_rejected" });
        this.#halt(isAuthenticationFailure(result.error) ? "authentication" : "protocol");
        return;
      }
      if (isRetryableFailure(result.error)) {
        this.#candidates.set(candidateKey, candidate);
        this.#onDiagnostic({ code: "claim_unavailable" });
      } else {
        this.#onDiagnostic({ code: "claim_rejected" });
      }
      return;
    }

    const claim = result.data.run;
    const registration = this.#leases.registerClaim(claim);
    if (registration !== "new") {
      await this.#capabilities.settle(slot, { kind: "claim_failed" });
      if (registration === "conflict") {
        this.#onDiagnostic({ code: "claim_rejected", runId: claim.runId });
        this.#halt("protocol");
      }
      return;
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    this.#runControllers.set(claim.runId, controller);
    const execution = this.#executeClaim(claim, slot, controller.signal)
      .finally(() => {
        signal?.removeEventListener("abort", abort);
        this.#executions.delete(claim.runId);
      });
    this.#executions.set(claim.runId, execution);
  }

  async #executeClaim(
    claim: ClaimedDispatch,
    slot: LocalDispatchSlot,
    signal: AbortSignal,
  ): Promise<void> {
    const assignment: DispatchAssignment = {
      runId: claim.runId,
      taskId: claim.taskId,
      taskKey: claim.taskKey,
      claimId: claim.claimId,
      claimFence: claim.claimFence,
      inputReviewRevision: claim.inputReviewRevision,
      runtimePublicId: this.#identity.runnerId,
      runtimeBootId: this.#identity.bootId,
      repositoryPublicId: claim.repositoryId,
      accountProfileId: slot.accountProfileId,
      baseRef: claim.baseRef,
      initialPrompt: renderTaskWorkflowPromptV1({
        taskKey: claim.taskKey,
        title: claim.taskTitle,
        description: claim.taskDescription,
      }),
      repositoryPath: slot.repositoryPath,
      title: claim.taskTitle,
    };
    try {
      const result = await this.#executor.execute(assignment, signal);
      if (result.kind !== "running" && result.binding.lastEventSequence > 0) {
        const acknowledged = await this.#acknowledgeThrough(
          result.binding.runId,
          result.binding.lastEventSequence,
          signal,
        );
        if (!acknowledged) {
          await this.#capabilities.settle(slot, {
            kind: "ambiguous",
            runId: result.binding.runId,
          });
          return;
        }
      }
      await this.#capabilities.settle(slot, resultDisposition(result));
      if (result.kind !== "running") this.forgetRun(claim.runId);
    } catch {
      this.#onDiagnostic({ code: "execution_failed", runId: claim.runId });
      await this.#revokeRun(claim.runId, "runner_invalid", true);
      // Bind the reservation to the failed run after revocation. A proven
      // local stop has already recorded a release tombstone and deletes it;
      // an ambiguous stop keeps capacity retained for later reconciliation.
      await this.#capabilities.settle(slot, { kind: "ambiguous", runId: claim.runId });
    }
  }

  async #acknowledgeThrough(
    runId: string,
    throughSequence: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    while (!this.#outbox.isAcknowledged(runId, throughSequence)) {
      if (aborted(signal) || !this.#leases.currentRunIds().includes(runId)) return false;
      const result = await this.#flushOutbox(signal, runId);
      if (result === "halted" || result === "aborted") return false;
      if (result === "retry") await this.#scheduler.sleep(250, signal);
    }
    return true;
  }

  #flushOutbox(
    signal?: AbortSignal,
    preferredRunId?: string,
  ): Promise<"ok" | "retry" | "halted" | "aborted"> {
    const task = this.#flushTail.then(() => this.#flushOutboxNow(
      signal,
      preferredRunId,
    ));
    this.#flushTail = task.then(() => undefined, () => undefined);
    return task;
  }

  async #syncInteractions(
    signal?: AbortSignal,
  ): Promise<"ok" | "retry" | "halted" | "aborted"> {
    if (this.#interactions === null) return "ok";
    let status: DispatchInteractionSyncStatus;
    try {
      status = await this.#interactions.syncOnce(this.#leases.currentRunIds(), signal);
    } catch {
      this.#onDiagnostic({ code: "interaction_unavailable" });
      return "retry";
    }
    if (typeof status === "object") {
      this.#onDiagnostic({ code: status.reason, runId: status.runId });
      await this.#revokeRun(status.runId, status.reason);
      return "retry";
    }
    switch (status) {
      case "ok":
        return "ok";
      case "aborted":
        return "aborted";
      case "retry":
        this.#onDiagnostic({ code: "interaction_unavailable" });
        return "retry";
      case "fence_rejected":
        this.#onDiagnostic({ code: "interaction_fence_rejected" });
        return "retry";
      case "halted":
        this.#onDiagnostic({ code: "interaction_rejected" });
        this.#halt("protocol");
        return "halted";
    }
  }

  async #flushOutboxNow(
    signal?: AbortSignal,
    preferredRunId?: string,
  ): Promise<"ok" | "retry" | "halted" | "aborted"> {
    const currentRunIds = this.#leases.currentRunIds();
    for (const runId of currentRunIds) this.#outbox.materializeDisplayDraft?.(runId);
    const currentRunId = preferredRunId !== undefined && currentRunIds.includes(preferredRunId)
      ? preferredRunId
      : currentRunIds.find((runId) => (
      this.#outbox.pendingEventsForRun(runId, 1).length > 0
      ));
    if (currentRunId === undefined) return "ok";
    const binding = this.#outbox.read(currentRunId);
    if (
      binding === null ||
      binding.runtimePublicId !== this.#identity.runnerId ||
      binding.runtimeBootId !== this.#identity.bootId
    ) {
      this.#onDiagnostic({ code: "outbox_corrupt", runId: currentRunId });
      this.#halt("protocol");
      return "halted";
    }
    const events = this.#outbox.pendingEventsForRun(currentRunId, MAX_RUN_EVENT_BATCH);
    if (!eventsAreContiguous(events)) {
      this.#onDiagnostic({ code: "outbox_corrupt", runId: currentRunId });
      this.#halt("protocol");
      return "halted";
    }
    const result = await this.#cloud.appendEvents(currentRunId, {
      runnerId: this.#identity.runnerId,
      bootId: this.#identity.bootId,
      claimId: binding.claimId,
      claimFence: binding.claimFence,
      events: events.map((event) => event.displayText === undefined
        ? {
            id: wireDispatchEventId(event.eventId),
            sequence: event.sequence,
            kind: publicRunStatusEventKindSchema.parse(event.kind),
          }
        : {
            id: wireDispatchEventId(event.eventId),
            sequence: event.sequence,
            kind: publicRunTextEventKindSchema.parse(event.kind),
            displayText: event.displayText,
          }),
    }, signal);
    if (!result.ok) {
      if (result.error.kind === "aborted") return "aborted";
      if (isFenceFailure(result.error)) {
        this.#onDiagnostic({ code: "outbox_fence_rejected", runId: currentRunId });
        // A stop revocation flush can itself discover that the cloud fence is
        // gone. Its in-flight revocation already owns local cleanup, so revoke
        // authority directly instead of awaiting that same task and
        // self-deadlocking. Retained capacity is retired by cloud-terminal
        // proof on a later heartbeat.
        if (this.#revocationTasks.has(currentRunId)) {
          this.#leases.revoke(currentRunId);
        } else {
          await this.#revokeRun(currentRunId, "fence_rejected");
        }
        return "retry";
      }
      if (isFatalCloudFailure(result.error)) {
        this.#onDiagnostic({ code: "outbox_fence_rejected", runId: currentRunId });
        this.#halt(isAuthenticationFailure(result.error) ? "authentication" : "protocol");
        return "halted";
      }
      this.#onDiagnostic({ code: "outbox_unavailable", runId: currentRunId });
      return "retry";
    }
    const first = events[0];
    const last = events.at(-1);
    if (
      first === undefined ||
      last === undefined ||
      result.data.acceptedThroughSequence < first.sequence ||
      result.data.acceptedThroughSequence > last.sequence
    ) {
      this.#onDiagnostic({ code: "outbox_corrupt", runId: currentRunId });
      this.#halt("protocol");
      return "halted";
    }
    this.#outbox.acknowledge(currentRunId, result.data.acceptedThroughSequence);
    const updated = this.#outbox.read(currentRunId);
    if (
      updated !== null &&
      isTerminalStage(updated.stage) &&
      result.data.acceptedThroughSequence >= updated.lastEventSequence &&
      this.#outbox.isAcknowledged(currentRunId, updated.lastEventSequence)
    ) {
      this.forgetRun(currentRunId);
      await this.#onRunTerminalAcknowledged(currentRunId);
    }
    return "ok";
  }

  #replaceCandidates(candidates: readonly DispatchCandidate[]): void {
    this.#candidates.clear();
    for (const candidate of candidates) {
      this.#candidates.set(dispatchCandidateKey(candidate), candidate);
    }
  }

  async #revokeExpired(): Promise<void> {
    for (const runId of this.#leases.expiredRunIds()) {
      await this.#revokeRun(runId, "lease_expired");
    }
  }

  async #revokeAll(reason: DispatchRevocationReason): Promise<void> {
    await Promise.all(this.#leases.runIds().map((runId) => this.#revokeRun(runId, reason)));
  }

  #revokeRun(
    runId: string,
    reason: DispatchRevocationReason,
    force = false,
  ): Promise<void> {
    const inFlight = this.#revocationTasks.get(runId);
    if (inFlight !== undefined) return inFlight;
    const known = this.#leases.runIds().includes(runId);
    const controller = this.#runControllers.get(runId);
    this.#runControllers.delete(runId);
    controller?.abort();
    if (!force && !known && controller === undefined) return Promise.resolve();
    const task = (async (): Promise<void> => {
      let revocationSucceeded = false;
      try {
        await this.#revocations.revoke(runId, reason);
        revocationSucceeded = true;
        if (
          reason !== "cloud_terminal" &&
          this.#leases.currentRunIds().includes(runId) &&
          this.#outbox.pendingEventsForRun(runId, 1).length > 0
        ) {
          // Give locally-authored terminal proof an immediate attempt, while
          // leaving its durable event and lease available to the normal pull
          // loop when transport is transient or more than one batch remains.
          await this.#flushOutbox(undefined, runId);
        }
      } catch {
        this.#onDiagnostic({ code: "revocation_failed", runId });
      } finally {
        // A rejected local stop is ambiguous: the Codex turn may still be
        // running. Keep the lease so the next heartbeat reports the run and
        // can safely retry the same stop request.
        if (revocationSucceeded) {
          let retainForPublication = false;
          try {
            const binding = this.#outbox.read(runId);
            retainForPublication =
              reason !== "cloud_terminal" &&
              binding !== null &&
              isTerminalStage(binding.stage) &&
              binding.lastEventSequence > 0 &&
              !this.#outbox.isAcknowledged(runId, binding.lastEventSequence) &&
              this.#leases.currentRunIds().includes(runId);
          } catch {
            this.#onDiagnostic({ code: "outbox_corrupt", runId });
            this.#halt("protocol");
          }
          if (!retainForPublication) this.#leases.revoke(runId);
        }
      }
    })().finally(() => {
      if (this.#revocationTasks.get(runId) === task) this.#revocationTasks.delete(runId);
    });
    this.#revocationTasks.set(runId, task);
    return task;
  }

  #halt(reason: "authentication" | "protocol"): void {
    if (this.#haltReason !== undefined) return;
    this.#haltReason = reason;
    this.#candidates.clear();
    this.#onRunnerStatus("unavailable");
    void this.#revokeAll("runner_invalid");
    this.#supervisorController?.abort();
  }

  async #drainExecutions(): Promise<void> {
    const active = [...this.#executions.values()];
    if (active.length === 0) return;
    const grace = new AbortController();
    try {
      await Promise.race([
        Promise.allSettled(active).then(() => undefined),
        this.#scheduler.sleep(this.#shutdownGraceMs, grace.signal),
      ]);
    } finally {
      grace.abort();
    }
  }
}


export function boundedJitterMilliseconds(
  baseMilliseconds: number,
  ratio: number,
  sample: number,
): number {
  const base = boundedInteger(baseMilliseconds, 1, 60_000, "jitter base");
  const boundedRatio = boundedNumber(ratio, 0, 0.5, "jitter ratio");
  const boundedSample = boundedNumber(sample, 0, 1, "random sample");
  return Math.max(1, Math.round(base * (1 - boundedRatio + 2 * boundedRatio * boundedSample)));
}

export function wireDispatchEventId(localEventId: string): string {
  const digest = createHash("sha256")
    .update(`kitchen-cloud-event-v1:${localEventId}`)
    .digest("hex");
  return `event_${digest.slice(0, 48)}`;
}

function resultDisposition(result: DispatchExecutionResult): DispatchSlotDisposition {
  switch (result.kind) {
    case "running":
      return { kind: "running", runId: result.binding.runId };
    case "terminal":
      return { kind: "terminal", runId: result.binding.runId };
    case "ambiguous":
      return { kind: "ambiguous", runId: result.binding.runId };
    case "lease_lost":
      return { kind: "lease_lost", runId: result.binding.runId };
  }
}

function eventsAreContiguous(events: readonly PendingDispatchEvent[]): boolean {
  return events.every((event, index) => {
    const previous = events[index - 1];
    return previous === undefined || event.sequence === previous.sequence + 1;
  });
}

function dispatchCandidateKey(candidate: DispatchCandidate): string {
  return `${candidate.repositoryId}\u0000${candidate.taskKey}`;
}

function isTerminalStage(stage: DispatchBinding["stage"]): boolean {
  return stage === "completed" ||
    stage === "failed" ||
    stage === "cancelled" ||
    stage === "lease_lost";
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

function isRetryableRemote(
  failure: DispatchCloudFailure,
): failure is Extract<DispatchCloudFailure, { kind: "remote" }> {
  return failure.kind === "remote" &&
    (failure.code === "RATE_LIMITED" ||
      failure.code === "RUNNER_ALREADY_CONNECTED" ||
      failure.code === "SERVICE_UNAVAILABLE" ||
      failure.code === "INTERNAL_ERROR");
}

function isRetryableFailure(failure: DispatchCloudFailure): boolean {
  return failure.kind === "network" ||
    failure.kind === "timeout" ||
    failure.kind === "invalid_response" ||
    isRetryableRemote(failure);
}

function isAuthenticationFailure(failure: DispatchCloudFailure): boolean {
  return failure.kind === "remote" && (
    failure.code === "AUTHENTICATION_FAILED" ||
    failure.code === "SESSION_REQUIRED" ||
    failure.code === "SESSION_INVALID" ||
    failure.code === "AUTHORIZATION_DENIED" ||
    failure.code === "SCOPE_REQUIRED"
  );
}

function isFatalCloudFailure(failure: DispatchCloudFailure): boolean {
  return failure.kind === "remote" && (
    isAuthenticationFailure(failure) ||
    failure.code === "VALIDATION_ERROR" ||
    failure.code === "ORGANIZATION_MISMATCH" ||
    failure.code === "MEMBERSHIP_INACTIVE"
  );
}

function isFenceFailure(failure: DispatchCloudFailure): boolean {
  return failure.kind === "remote" && (
    failure.code === "CLAIM_STALE" ||
    failure.code === "CLAIM_NOT_OWNED" ||
    failure.code === "LEASE_NOT_RENEWABLE" ||
    failure.code === "TASK_STATE_CONFLICT"
  );
}

function positiveInteger(value: number, label: string): number {
  return boundedInteger(value, 1, Number.MAX_SAFE_INTEGER, label);
}

function nextPositiveInteger(value: number): number {
  if (value >= Number.MAX_SAFE_INTEGER) throw new RangeError("heartbeat sequence exhausted");
  return value + 1;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function boundedNumber(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}
