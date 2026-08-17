import {
  abortHRAPromotionRequestSchema,
  activateHRAPromotionRequestSchema,
  advanceHRAPromotionCleanupRequestSchema,
  startHRAPromotionRequestSchema,
  taskDomain,
  type WorkspacePromotionStateV2,
} from "@hraness/agent-tasks-protocol";

import {
  LocalPromotionError,
  promotionTransportFailureCode,
  type LocalPromotionCoordinatorCheckpoint,
  type LocalPromotionCoordinatorFaultInjector,
  type LocalPromotionProgress,
  type LocalPromotionTransport,
  type LocalPromotionTransportFailure,
  type LocalPromotionTransportResult,
} from "./contracts";
import type { LocalPromotionV2Store } from "../state/local-promotion-v2-store";

const REMOTE_PROJECTION_POLL_MS = 500;
const LIFECYCLE_ACTIVE_POLL_MS = 250;
const MAX_LIFECYCLE_TIMER_MS = 60_000;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface LocalPromotionCoordinatorOptions {
  readonly store: LocalPromotionV2Store;
  readonly transport: LocalPromotionTransport;
  readonly now?: () => number;
  readonly setTimer?: (
    callback: () => void,
    delayMs: number,
  ) => TimerHandle;
  readonly clearTimer?: (handle: TimerHandle) => void;
  readonly faultInjector?: LocalPromotionCoordinatorFaultInjector;
}

/**
 * A single serialized coordinator owns all promotion network side effects.
 * `runOnce` is deterministic for tests and explicit retries; `start`, `stop`,
 * and `wake` provide the gateway lifecycle.
 */
export class LocalPromotionCoordinator {
  readonly #store: LocalPromotionV2Store;
  readonly #transport: LocalPromotionTransport;
  readonly #now: () => number;
  readonly #setTimer: (
    callback: () => void,
    delayMs: number,
  ) => TimerHandle;
  readonly #clearTimer: (handle: TimerHandle) => void;
  readonly #faultInjector: LocalPromotionCoordinatorFaultInjector | undefined;

  #active = false;
  #wakeQueued = false;
  #timer: TimerHandle | null = null;
  #tail: Promise<void> = Promise.resolve();
  #workInFlight = 0;

  constructor(options: LocalPromotionCoordinatorOptions) {
    this.#store = options.store;
    this.#transport = options.transport;
    this.#now = options.now ?? Date.now;
    this.#setTimer = options.setTimer ??
      ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clearTimer = options.clearTimer ??
      ((handle) => clearTimeout(handle));
    this.#faultInjector = options.faultInjector;
  }

  start(): void {
    if (this.#active) return;
    this.#active = true;
    this.wake();
  }

  async stop(): Promise<void> {
    this.closeAdmission();
    await this.#tail;
  }

  closeAdmission(): void {
    this.#active = false;
    this.#wakeQueued = false;
    if (this.#timer !== null) {
      this.#clearTimer(this.#timer);
      this.#timer = null;
    }
  }

  hasUnsettledWork(): boolean {
    return this.#workInFlight > 0;
  }

  wake(): void {
    if (!this.#active || this.#wakeQueued) return;
    this.#wakeQueued = true;
    void this.#enqueue(async () => {
      this.#wakeQueued = false;
      await this.#drain();
    });
  }

  beginPromotion(input: Readonly<{
    workspaceId: string;
    promotionId: string;
    destinationOrganizationId: string;
  }>): LocalPromotionProgress {
    const progress = this.#store.freezeSourceSnapshot({
      ...input,
      now: this.#now(),
    });
    this.wake();
    return progress;
  }

  async runOnce(promotionIdValue: string): Promise<LocalPromotionProgress> {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    return await this.#enqueue(async () => await this.#step(promotionId));
  }

  async abortPromotion(
    promotionIdValue: string,
  ): Promise<LocalPromotionProgress> {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    return await this.#enqueue(async () => {
      let progress = this.#store.progress(promotionId);
      if (
        ["activated", "aborted"].includes(progress.phase)
      ) {
        throw new LocalPromotionError("state_conflict");
      }
      if (progress.destinationWorkspaceId === null) {
        progress = await this.#startRemote(promotionId);
        if (progress.destinationWorkspaceId === null) return progress;
      }
      if (progress.phase !== "aborting") {
        progress = this.#store.beginAbort(promotionId, this.#now());
      }
      return await this.#abortRemote(promotionId);
    });
  }

  async #drain(): Promise<void> {
    if (!this.#active) return;
    const now = this.#now();
    const promotionIds = new Set([
      ...this.#store.resumablePromotionIds(now),
      ...this.#store.cleanupPromotionIds(now),
    ]);
    for (const promotionId of promotionIds) {
      if (!this.#active) break;
      try {
        await this.#step(promotionId);
      } catch (error: unknown) {
        if (error instanceof LocalPromotionError) {
          try {
            this.#store.scheduleFault({
              promotionId,
              code: error.code,
              nextAttemptAt: error.retryable
                ? this.#store.nextBackoffAt(promotionId, this.#now())
                : null,
              now: this.#now(),
            });
          } catch {
            // A racing terminal proof can legitimately retire this session.
          }
          continue;
        }
        // Fault-injection and unexpected process faults deliberately remain
        // unrecorded: the next gateway boot resumes the prior durable boundary.
      }
    }
    if (!this.#active) return;
    const nextScheduled = this.#store.nextScheduledAttemptAt();
    const hasImmediatelyRunnable = this.#store.resumablePromotionIds(
      this.#now(),
      1,
    ).length > 0 ||
      this.#store.cleanupPromotionIds(this.#now(), 1).length > 0;
    if (hasImmediatelyRunnable) {
      this.#arm(LIFECYCLE_ACTIVE_POLL_MS);
    } else if (nextScheduled !== null) {
      this.#arm(Math.min(
        MAX_LIFECYCLE_TIMER_MS,
        Math.max(0, nextScheduled - this.#now()),
      ));
    }
  }

  async #step(promotionId: string): Promise<LocalPromotionProgress> {
    const progress = this.#store.progress(promotionId);
    switch (progress.phase) {
      case "snapshot_frozen":
      case "starting":
        return await this.#startRemote(promotionId);
      case "receiving":
        return await this.#receiveNextBatch(promotionId);
      case "validating":
      case "projecting":
        return await this.#pollRemoteProjection(promotionId);
      case "ready":
        return await this.#activateRemote(promotionId, false);
      case "activating":
      case "outcome_unknown":
        return await this.#reconcileActivation(promotionId);
      case "aborting":
        return await this.#abortRemote(promotionId);
      case "activated":
      case "aborted":
        return await this.#advanceCleanup(promotionId);
    }
  }

  async #startRemote(promotionId: string): Promise<LocalPromotionProgress> {
    const prior = this.#store.progress(promotionId);
    if (prior.phase === "starting") {
      const lookup = await this.#lookup(promotionId);
      if (lookup.ok) {
        this.#checkpoint("lookup.after_response_before_persist");
        const remote = lookup.value.promotion;
        this.#store.recordStart(promotionId, {
          promotionId,
          stagingWorkspaceId: remote.stagingWorkspaceId,
          state: "receiving",
        }, this.#now());
        return this.#store.recordRemoteState(
          promotionId,
          remote,
          this.#now(),
        );
      }
      if (lookup.kind !== "not_found") {
        return this.#recordTransportFailure(promotionId, lookup);
      }
    }
    this.#store.markStarting(promotionId, this.#now());
    const frozen = this.#store.frozen(promotionId);
    const request = startHRAPromotionRequestSchema.parse({
      organizationId: frozen.organizationId,
      manifest: frozen.manifest,
    });
    this.#checkpoint("start.before_request");
    const result = await this.#call(async () =>
      await this.#transport.start(request));
    if (!result.ok) return this.#recordTransportFailure(promotionId, result);
    this.#checkpoint("start.after_response_before_persist");
    return this.#store.recordStart(
      promotionId,
      result.value,
      this.#now(),
    );
  }

  async #receiveNextBatch(
    promotionId: string,
  ): Promise<LocalPromotionProgress> {
    let outstanding = this.#store.outstandingBatch(promotionId);
    if (outstanding?.state === "in_flight") {
      this.#store.markBatchLostResponse(
        promotionId,
        outstanding.prepared.batch.batchId,
        this.#now(),
      );
      outstanding = this.#store.outstandingBatch(promotionId);
    }
    if (outstanding?.state === "lost_response") {
      this.#checkpoint("lookup.before_request");
      const result = await this.#call(async () =>
        await this.#transport.listReceipts(promotionId, {
          ...(outstanding?.receiptAuditCursor === null
            ? {}
            : { cursor: outstanding?.receiptAuditCursor }),
          limit: 100,
        }));
      if (!result.ok) return this.#recordTransportFailure(promotionId, result);
      this.#checkpoint("lookup.after_response_before_persist");
      const receipt = this.#store.advanceReceiptAudit(
        promotionId,
        outstanding.prepared.batch.batchId,
        result.value,
        this.#now(),
      );
      if (receipt !== null) {
        return this.#store.recordBatchAcceptance(
          outstanding.prepared.batch,
          receipt,
        );
      }
      return this.#store.progress(promotionId);
    }

    const prepared = this.#store.prepareNextBatch(promotionId, this.#now());
    if (prepared === null) return await this.#pollRemoteProjection(promotionId);
    this.#store.markBatchInFlight(
      promotionId,
      prepared.batch.batchId,
      this.#now(),
    );
    this.#checkpoint("batch.before_request");
    const result = await this.#call(async () =>
      await this.#transport.acceptBatch(promotionId, {
        batch: prepared.batch,
      }));
    if (!result.ok) {
      if (result.kind === "offline" || result.kind === "outcome_unknown") {
        this.#store.markBatchLostResponse(
          promotionId,
          prepared.batch.batchId,
          this.#now(),
        );
      }
      return this.#recordTransportFailure(promotionId, result);
    }
    this.#checkpoint("batch.after_response_before_persist");
    return this.#store.recordBatchAcceptance(
      prepared.batch,
      result.value.receipt,
    );
  }

  async #pollRemoteProjection(
    promotionId: string,
  ): Promise<LocalPromotionProgress> {
    const result = await this.#lookup(promotionId);
    if (!result.ok) return this.#recordTransportFailure(promotionId, result);
    this.#checkpoint("lookup.after_response_before_persist");
    if (result.value.promotion.state === "rejected") {
      return this.#recordRemoteRejection(
        promotionId,
        result.value.promotion,
      );
    }
    const progress = this.#store.recordRemoteState(
      promotionId,
      result.value.promotion,
      this.#now(),
    );
    if (
      ["receiving", "validating", "projecting"].includes(progress.phase)
    ) {
      return this.#store.deferUntil({
        promotionId,
        nextAttemptAt: this.#now() + REMOTE_PROJECTION_POLL_MS,
        now: this.#now(),
      });
    }
    this.#store.clearFault(promotionId, this.#now());
    return this.#store.progress(promotionId);
  }

  async #activateRemote(
    promotionId: string,
    alreadyBegun: boolean,
  ): Promise<LocalPromotionProgress> {
    if (!alreadyBegun) this.#store.beginActivation(promotionId, this.#now());
    const manifest = this.#store.manifest(promotionId);
    const request = activateHRAPromotionRequestSchema.parse({
      manifestRoot: manifest.rootDigest,
      counts: manifest.counts,
      familyDigests: manifest.familyDigests,
    });
    this.#checkpoint("activation.before_request");
    const result = await this.#call(async () =>
      await this.#transport.activate(promotionId, request));
    if (!result.ok) {
      if (result.kind === "offline" || result.kind === "outcome_unknown") {
        this.#store.markOutcomeUnknown(promotionId, this.#now());
      }
      return this.#recordTransportFailure(promotionId, result);
    }
    this.#checkpoint("activation.after_response_before_persist");
    return this.#store.recordActivation(result.value.receipt);
  }

  async #reconcileActivation(
    promotionId: string,
  ): Promise<LocalPromotionProgress> {
    const result = await this.#lookup(promotionId);
    if (!result.ok) return this.#recordTransportFailure(promotionId, result);
    this.#checkpoint("lookup.after_response_before_persist");
    const remote = result.value.promotion;
    if (remote.state === "activated") {
      return this.#store.recordActivation(remote.activationReceipt);
    }
    if (remote.state === "aborted") {
      return this.#store.recordAbort(remote.abortReceipt);
    }
    if (remote.state === "ready") {
      return await this.#activateRemote(promotionId, true);
    }
    if (remote.state === "rejected") {
      return this.#recordRemoteRejection(promotionId, remote);
    }
    this.#store.markOutcomeUnknown(promotionId, this.#now());
    return this.#store.deferUntil({
      promotionId,
      nextAttemptAt: this.#now() + REMOTE_PROJECTION_POLL_MS,
      now: this.#now(),
    });
  }

  async #abortRemote(promotionId: string): Promise<LocalPromotionProgress> {
    const lookup = await this.#lookup(promotionId);
    if (!lookup.ok) {
      return this.#recordTransportFailure(promotionId, lookup);
    }
    this.#checkpoint("lookup.after_response_before_persist");
    const remote = lookup.value.promotion;
    if (remote.state === "aborted") {
      return this.#store.recordAbort(remote.abortReceipt);
    }
    if (remote.state === "activated") {
      return this.#store.recordActivation(remote.activationReceipt);
    }
    if (remote.state === "outcome_unknown") {
      return this.#recordTransportFailure(promotionId, {
        ok: false,
        kind: "outcome_unknown",
      });
    }
    const manifest = this.#store.manifest(promotionId);
    const request = abortHRAPromotionRequestSchema.parse({
      manifestRoot: manifest.rootDigest,
    });
    this.#checkpoint("abort.before_request");
    const result = await this.#call(async () =>
      await this.#transport.abort(promotionId, request));
    if (!result.ok) return this.#recordTransportFailure(promotionId, result);
    this.#checkpoint("abort.after_response_before_persist");
    return this.#store.recordAbort(result.value.receipt);
  }

  #recordRemoteRejection(
    promotionId: string,
    remote: Extract<WorkspacePromotionStateV2, { state: "rejected" }>,
  ): LocalPromotionProgress {
    return this.#store.recordRemoteRejection(
      promotionId,
      remote,
      this.#now(),
    );
  }

  async #advanceCleanup(
    promotionId: string,
  ): Promise<LocalPromotionProgress> {
    let cleanup = this.#store.cleanup(promotionId);
    if (cleanup === null) {
      this.#checkpoint("cleanup.before_request");
      const status = await this.#call(async () =>
        await this.#transport.cleanupStatus(promotionId));
      if (!status.ok) {
        return this.#recordTransportFailure(promotionId, status);
      }
      this.#checkpoint("cleanup.after_response_before_persist");
      cleanup = this.#store.recordCleanup(status.value.cleanup, this.#now());
    }
    if (cleanup.state === "complete") {
      this.#store.clearFault(promotionId, this.#now());
      return this.#store.progress(promotionId);
    }
    const request = advanceHRAPromotionCleanupRequestSchema.parse({
      limit: 500,
    });
    this.#checkpoint("cleanup.before_request");
    const result = await this.#call(async () =>
      await this.#transport.advanceCleanup(promotionId, request));
    if (!result.ok) return this.#recordTransportFailure(promotionId, result);
    this.#checkpoint("cleanup.after_response_before_persist");
    const advanced = this.#store.recordCleanup(
      result.value.cleanup,
      this.#now(),
    );
    if (advanced.state === "complete") {
      this.#store.clearFault(promotionId, this.#now());
    } else {
      this.#store.deferUntil({
        promotionId,
        nextAttemptAt: this.#now() + REMOTE_PROJECTION_POLL_MS,
        now: this.#now(),
      });
    }
    return this.#store.progress(promotionId);
  }

  async #lookup(
    promotionId: string,
  ): Promise<LocalPromotionTransportResult<Readonly<{
    promotion: WorkspacePromotionStateV2;
  }>>> {
    this.#checkpoint("lookup.before_request");
    return await this.#call(async () =>
      await this.#transport.lookup(promotionId));
  }

  #recordTransportFailure(
    promotionId: string,
    failure: LocalPromotionTransportFailure,
  ): LocalPromotionProgress {
    const code = promotionTransportFailureCode(failure);
    const retryable =
      failure.kind === "offline" || failure.kind === "outcome_unknown";
    return this.#store.scheduleFault({
      promotionId,
      code,
      nextAttemptAt: retryable
        ? this.#store.nextBackoffAt(promotionId, this.#now())
        : null,
      now: this.#now(),
    });
  }

  async #call<Value>(
    call: () => Promise<LocalPromotionTransportResult<Value>>,
  ): Promise<LocalPromotionTransportResult<Value>> {
    try {
      return await call();
    } catch {
      return { ok: false, kind: "offline" };
    }
  }

  #checkpoint(checkpoint: LocalPromotionCoordinatorCheckpoint): void {
    this.#faultInjector?.(checkpoint);
  }

  #arm(delayMs: number): void {
    if (!this.#active) return;
    if (this.#timer !== null) this.#clearTimer(this.#timer);
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      this.wake();
    }, delayMs);
  }

  #enqueue<Value>(operation: () => Promise<Value>): Promise<Value> {
    this.#workInFlight += 1;
    const pending = this.#tail.then(operation, operation).finally(() => {
      this.#workInFlight -= 1;
    });
    this.#tail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
}
