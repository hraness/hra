import { z } from "@hra-internal/schema";

import type { SessionTurnLifecycle } from "../sessions/session-service";

type MaybePromise<T> = T | Promise<T>;

const RECONCILIATION_LIMIT = 4_096;
const DEFAULT_DEADLINE_POLL_MILLISECONDS = 1_000;
const DEFAULT_LOST_CALLBACK_AUDIT_MILLISECONDS = 30_000;
const DEFAULT_DEMAND_RECONCILIATION_FRESHNESS_MILLISECONDS = 1_000;
const MAX_LOST_CALLBACK_AUDIT_MILLISECONDS = 5 * 60_000;

const work = Object.freeze({
  sweepDeadlines: 1 << 0,
  reconcileActors: 1 << 1,
});

type ReconciliationTarget =
  | Readonly<{ kind: "actor"; actorId: string }>
  | Readonly<{ kind: "turn"; turnId: string }>
  | Readonly<{ kind: "incarnation"; incarnationId: string }>
  | Readonly<{
      kind: "providerTurn";
      value: PersistentActorProviderTurnTargetV2;
    }>;

interface PendingReconciliationTarget {
  readonly revision: number;
  readonly target: ReconciliationTarget;
}

const actorReconciliationOutcomeSchema = z.object({
  inspectedOperations: z.number().int().nonnegative().safe(),
  inspectedAttempts: z.number().int().nonnegative().safe(),
  inspectedTurns: z.number().int().nonnegative().safe(),
  pending: z.number().int().nonnegative().safe(),
  fenced: z.number().int().nonnegative().safe(),
}).strict();

const deadlineSweepOutcomeSchema = z.object({
  expired: z.number().int().nonnegative().safe(),
}).strict();

export interface PersistentActorReconciliationPortV2 {
  reconcile(input: PersistentActorReconciliationRequestV2): Promise<unknown>;
  sweepDeadlines?(input: Readonly<{ limit: number }>): Promise<unknown>;
}

/**
 * Gateway-owned lifecycle identities are not provider identities. This narrow
 * capability resolves one already-owned event through SessionService's exact
 * reverse index before durable actor reconciliation is targeted.
 */
export interface PersistentActorLifecycleRoutePortV2 {
  readHarnessActorChatEventRoute(input: Readonly<{
    accountProfileId: string;
    threadId: string;
    turnId: string;
  }>): Readonly<{ actorId: string }> | null;
}

export interface PersistentActorProviderTurnTargetV2 {
  readonly accountProfileId: string;
  readonly providerThreadId: string;
  readonly providerTurnId: string;
}

export interface PersistentActorReconciliationRequestV2 {
  readonly limit: number;
  readonly actorIds?: readonly string[] | undefined;
  readonly turnIds?: readonly string[] | undefined;
  readonly incarnationIds?: readonly string[] | undefined;
  readonly providerTurns?: readonly PersistentActorProviderTurnTargetV2[] |
    undefined;
}

export interface PersistentActorLivenessDemandV2 {
  readonly actorIds?: readonly string[];
  readonly turnIds?: readonly string[];
}

export interface PersistentActorLivenessWakeV2 {
  readonly incarnationIds?: readonly string[];
}

export interface PersistentActorProjectionRefreshPortV2 {
  reconcileAll(): MaybePromise<unknown>;
}

export interface PersistentActorLivenessTimerV2 {
  cancel(): void;
}

export interface PersistentActorLivenessSchedulerV2 {
  monotonicNow(): number;
  schedule(
    callback: () => void,
    delayMilliseconds: number,
  ): PersistentActorLivenessTimerV2;
}

/** Injected into persistent actor reads and waits; it never scans a provider. */
export interface PersistentActorLivenessPortV2 {
  ensureCurrent(input?: PersistentActorLivenessDemandV2): Promise<void>;
}

export interface PersistentActorLivenessWakePortV2 {
  requestReconciliation(input?: PersistentActorLivenessWakeV2): void;
}

export class PersistentActorLivenessPumpV2Error extends Error {
  readonly code: "closed";

  constructor() {
    super("Persistent actor liveness is closed.");
    this.name = "PersistentActorLivenessPumpV2Error";
    this.code = "closed";
  }
}

/**
 * Turns synchronous provider lifecycle hints into one bounded durable actor
 * reconciliation queue. Hints carry no authority: reconciliation re-reads the
 * durable attempts, and projections refresh only after that pass succeeds.
 */
export class PersistentActorLivenessPumpV2
implements PersistentActorLivenessPortV2, PersistentActorLivenessWakePortV2 {
  readonly #actors: PersistentActorReconciliationPortV2;
  readonly #eventRoutes: PersistentActorLifecycleRoutePortV2;
  readonly #projections: PersistentActorProjectionRefreshPortV2;
  readonly #scheduler: PersistentActorLivenessSchedulerV2;
  #pendingWork = 0;
  #reconciliationPassInFlight = false;
  #projectionRefreshRequired = false;
  readonly #pendingTargets = new Map<string, PendingReconciliationTarget>();
  readonly #lastSuccessfulTargetReconciliationAt = new Map<string, number>();
  #nextTargetRevision = 1;
  #globalReconciliationRevision: number | null = null;
  #closed = false;
  #running: Promise<void> | null = null;
  #failure: Error | null = null;
  #closePromise: Promise<void> | null = null;
  #timer: PersistentActorLivenessTimerV2 | null = null;
  readonly #deadlinePollMilliseconds: number;
  readonly #lostCallbackAuditMilliseconds: number;
  readonly #demandReconciliationFreshnessMilliseconds: number;
  #nextLostCallbackAuditAt: number;
  #lastSuccessfulGlobalReconciliationAt: number | null = null;
  #lastMonotonicNow = 0;

  constructor(options: Readonly<{
    actors: PersistentActorReconciliationPortV2;
    eventRoutes: PersistentActorLifecycleRoutePortV2;
    projections: PersistentActorProjectionRefreshPortV2;
    deadlinePollMilliseconds?: number;
    lostCallbackAuditMilliseconds?: number;
    demandReconciliationFreshnessMilliseconds?: number;
    scheduler?: PersistentActorLivenessSchedulerV2;
  }>) {
    this.#actors = options.actors;
    this.#eventRoutes = options.eventRoutes;
    this.#projections = options.projections;
    this.#scheduler = options.scheduler ?? systemScheduler;
    this.#deadlinePollMilliseconds = boundedDuration(
      options.deadlinePollMilliseconds ?? DEFAULT_DEADLINE_POLL_MILLISECONDS,
      10,
      60_000,
      "deadlinePollMilliseconds",
    );
    this.#lostCallbackAuditMilliseconds = Math.max(
      this.#deadlinePollMilliseconds,
      boundedDuration(
        options.lostCallbackAuditMilliseconds ??
          DEFAULT_LOST_CALLBACK_AUDIT_MILLISECONDS,
        10,
        MAX_LOST_CALLBACK_AUDIT_MILLISECONDS,
        "lostCallbackAuditMilliseconds",
      ),
    );
    this.#demandReconciliationFreshnessMilliseconds = boundedDuration(
      options.demandReconciliationFreshnessMilliseconds ??
        DEFAULT_DEMAND_RECONCILIATION_FRESHNESS_MILLISECONDS,
      DEFAULT_DEMAND_RECONCILIATION_FRESHNESS_MILLISECONDS,
      MAX_LOST_CALLBACK_AUDIT_MILLISECONDS,
      "demandReconciliationFreshnessMilliseconds",
    );
    this.#nextLostCallbackAuditAt = this.#now() +
      this.#lostCallbackAuditMilliseconds;
    this.#armDeadlineSweep();
  }

  /** Safe for a synchronous SessionService notification callback. */
  observe(event: SessionTurnLifecycle): void {
    if (this.#closed || event.status === "inProgress") return;
    const route = this.#eventRoutes.readHarnessActorChatEventRoute({
      accountProfileId: event.accountProfileId,
      threadId: event.threadId,
      turnId: event.turnId,
    });
    if (route === null) return;
    this.#addTarget({ kind: "actor", actorId: route.actorId });
    this.#requestTargetedReconciliation();
  }

  /** Wakes one coalesced pass after a detached actor session becomes usable. */
  requestReconciliation(input: PersistentActorLivenessWakeV2 = {}): void {
    if (this.#closed) return;
    const incarnationIds = uniqueBounded(input.incarnationIds ?? [], 4_096);
    if (incarnationIds.length === 0) {
      this.#requestGlobalReconciliation();
    } else {
      for (const incarnationId of incarnationIds) {
        this.#addTarget({ kind: "incarnation", incarnationId });
      }
      this.#requestTargetedReconciliation();
    }
  }

  /**
   * Read/wait liveness seam. Polling waiters share one monotonic freshness
   * window instead of turning every local 25 ms observation into a global
   * provider scan. Terminal callbacks and the lost-callback audit remain
   * independent immediate/bounded reconciliation paths.
   */
  ensureCurrent(input: PersistentActorLivenessDemandV2 = {}): Promise<void> {
    if (this.#closed) return Promise.reject(new PersistentActorLivenessPumpV2Error());
    const now = this.#now();
    const targets: ReconciliationTarget[] = [
      ...uniqueBounded(input.actorIds ?? [], 4_096)
        .map((actorId) => ({ kind: "actor" as const, actorId })),
      ...uniqueBounded(input.turnIds ?? [], 4_096)
        .map((turnId) => ({ kind: "turn" as const, turnId })),
    ];
    for (const target of targets) {
      const key = reconciliationTargetKey(target);
      if (
        !this.#targetIsFresh(key, now) && !this.#pendingTargets.has(key)
      ) this.#addTarget(target);
    }
    if (targets.length > 0 && this.#pendingTargets.size > 0) {
      this.#pendingWork |= work.sweepDeadlines | work.reconcileActors;
    }
    if (this.#running !== null) return this.#running;
    if (this.#pendingWork !== 0 || this.#hasReconciliationScheduled()) {
      return this.#schedule();
    }
    return this.#failure === null
      ? Promise.resolve()
      : Promise.reject(this.#failure);
  }

  /** Waits for current work and exposes the most recent unrecovered failure. */
  async settled(): Promise<void> {
    while (this.#running !== null) {
      try {
        await this.#running;
      } catch {
        // The exact failure is retained below. This catch also makes an
        // ignored synchronous notification incapable of becoming unhandled.
      }
    }
    if (this.#failure !== null) throw this.#failure;
  }

  drain(): Promise<void> {
    return this.settled();
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closed = true;
    this.#timer?.cancel();
    this.#timer = null;
    this.#closePromise = this.settled();
    return this.#closePromise;
  }

  #schedule(): Promise<void> {
    if (this.#running !== null) return this.#running;
    // The microtask boundary coalesces a synchronous terminal notification
    // burst before the first bounded provider reconciliation starts.
    const run = Promise.resolve().then(() => this.#drain());
    this.#running = run;
    void run.then(
      () => this.#complete(run, null),
      (failure: unknown) => this.#complete(run, failure),
    );
    return run;
  }

  async #drain(): Promise<void> {
    while (this.#pendingWork !== 0) {
      const requestedWork = this.#pendingWork;
      this.#pendingWork = 0;
      let reconciledActors = false;
      if (
        (requestedWork & work.sweepDeadlines) !== 0 &&
        this.#actors.sweepDeadlines !== undefined
      ) {
        const outcome = deadlineSweepOutcomeSchema.parse(
          await this.#actors.sweepDeadlines({ limit: RECONCILIATION_LIMIT }),
        );
        if (outcome.expired > 0) {
          this.#markGlobalReconciliationRequired();
          this.#projectionRefreshRequired = true;
        }
      }
      if (this.#hasPendingReconciliation()) {
        this.#pendingWork &= ~work.reconcileActors;
        const globalRevision = this.#globalReconciliationRevision;
        const targets = new Map(this.#pendingTargets);
        this.#reconciliationPassInFlight = true;
        const outcome = actorReconciliationOutcomeSchema.parse(
          await this.#actors.reconcile(globalRevision === null
            ? targetedReconciliationRequest(targets)
            : { limit: RECONCILIATION_LIMIT }),
        );
        const reconciledAt = this.#now();
        if (this.#globalReconciliationRevision === globalRevision) {
          this.#globalReconciliationRevision = null;
        }
        if (globalRevision !== null) {
          this.#lastSuccessfulGlobalReconciliationAt = reconciledAt;
        }
        for (const [key, target] of targets) {
          if (this.#pendingTargets.get(key)?.revision === target.revision) {
            this.#pendingTargets.delete(key);
          }
          this.#lastSuccessfulTargetReconciliationAt.set(key, reconciledAt);
        }
        this.#pruneTargetFreshness(reconciledAt);
        reconciledActors = true;
        if (actorReconciliationMayHaveChangedState(outcome)) {
          this.#projectionRefreshRequired = true;
        }
      }
      if (this.#projectionRefreshRequired) {
        await this.#projections.reconcileAll();
        this.#projectionRefreshRequired = false;
      }
      if (reconciledActors) {
        this.#reconciliationPassInFlight = false;
      }
      this.#failure = null;
    }
  }

  #hasReconciliationScheduled(): boolean {
    return this.#reconciliationPassInFlight || this.#hasPendingReconciliation() ||
      (this.#pendingWork & work.reconcileActors) !== 0;
  }

  #hasPendingReconciliation(): boolean {
    return this.#globalReconciliationRevision !== null ||
      this.#pendingTargets.size > 0;
  }

  #addTarget(target: ReconciliationTarget): void {
    this.#pendingTargets.set(reconciliationTargetKey(target), {
      revision: this.#nextTargetRevision,
      target,
    });
    this.#nextTargetRevision += 1;
  }

  #requestTargetedReconciliation(): void {
    this.#pendingWork |= work.reconcileActors;
    void this.#schedule();
  }

  #markGlobalReconciliationRequired(): void {
    this.#globalReconciliationRevision = this.#nextTargetRevision;
    this.#nextTargetRevision += 1;
    this.#pendingWork |= work.reconcileActors;
  }

  #requestGlobalReconciliation(): void {
    this.#markGlobalReconciliationRequired();
    void this.#schedule();
  }

  #targetIsFresh(key: string, now: number): boolean {
    if (this.#failure !== null) return false;
    const reconciledAt = Math.max(
      this.#lastSuccessfulGlobalReconciliationAt ?? -1,
      this.#lastSuccessfulTargetReconciliationAt.get(key) ?? -1,
    );
    return reconciledAt >= 0 &&
      now - reconciledAt < this.#demandReconciliationFreshnessMilliseconds;
  }

  #pruneTargetFreshness(now: number): void {
    if (this.#lastSuccessfulTargetReconciliationAt.size <= 8_192) return;
    for (const [key, reconciledAt] of this.#lastSuccessfulTargetReconciliationAt) {
      if (now - reconciledAt >= this.#demandReconciliationFreshnessMilliseconds) {
        this.#lastSuccessfulTargetReconciliationAt.delete(key);
      }
    }
  }

  #complete(run: Promise<void>, failure: unknown): void {
    if (this.#running !== run) return;
    this.#running = null;
    if (failure !== null) {
      this.#reconciliationPassInFlight = false;
      this.#failure = normalizeFailure(failure);
    }
    if (this.#pendingWork !== 0 && !this.#closed) void this.#schedule();
  }

  #armDeadlineSweep(): void {
    this.#timer = this.#scheduler.schedule(() => {
      this.#timer = null;
      if (this.#closed) return;
      this.#pendingWork |= work.sweepDeadlines;
      const now = this.#now();
      if (now >= this.#nextLostCallbackAuditAt) {
        this.#markGlobalReconciliationRequired();
        // Do not replay every missed interval after suspension. One durable
        // audit observes the current state and restores the fixed upper bound.
        this.#nextLostCallbackAuditAt = now +
          this.#lostCallbackAuditMilliseconds;
      }
      void this.#schedule();
      this.#armDeadlineSweep();
    }, this.#deadlinePollMilliseconds);
  }

  #now(): number {
    const observed = this.#scheduler.monotonicNow();
    if (!Number.isFinite(observed) || observed < 0) {
      throw new RangeError("Persistent actor liveness clock must be finite and nonnegative");
    }
    this.#lastMonotonicNow = Math.max(this.#lastMonotonicNow, observed);
    return this.#lastMonotonicNow;
  }
}

function actorReconciliationMayHaveChangedState(
  outcome: z.infer<typeof actorReconciliationOutcomeSchema>,
): boolean {
  return outcome.inspectedOperations > 0 ||
    outcome.inspectedAttempts > 0 ||
    outcome.inspectedTurns > 0 ||
    outcome.pending > 0 ||
    outcome.fenced > 0;
}

function targetedReconciliationRequest(
  targets: ReadonlyMap<string, PendingReconciliationTarget>,
): PersistentActorReconciliationRequestV2 {
  const actorIds: string[] = [];
  const turnIds: string[] = [];
  const incarnationIds: string[] = [];
  const providerTurns: PersistentActorProviderTurnTargetV2[] = [];
  for (const { target } of targets.values()) {
    if (target.kind === "actor") actorIds.push(target.actorId);
    if (target.kind === "turn") turnIds.push(target.turnId);
    if (target.kind === "incarnation") {
      incarnationIds.push(target.incarnationId);
    }
    if (target.kind === "providerTurn") providerTurns.push(target.value);
  }
  return Object.freeze({
    limit: RECONCILIATION_LIMIT,
    ...(actorIds.length === 0 ? {} : { actorIds: actorIds.toSorted() }),
    ...(turnIds.length === 0 ? {} : { turnIds: turnIds.toSorted() }),
    ...(incarnationIds.length === 0
      ? {} : { incarnationIds: incarnationIds.toSorted() }),
    ...(providerTurns.length === 0 ? {} : {
      providerTurns: providerTurns.toSorted((left, right) =>
        providerTurnTargetKey(left).localeCompare(providerTurnTargetKey(right))),
    }),
  });
}

function reconciliationTargetKey(target: ReconciliationTarget): string {
  if (target.kind === "actor") return `actor\0${target.actorId}`;
  if (target.kind === "turn") return `turn\0${target.turnId}`;
  if (target.kind === "incarnation") {
    return `incarnation\0${target.incarnationId}`;
  }
  return `providerTurn\0${providerTurnTargetKey(target.value)}`;
}

function providerTurnTargetKey(
  target: PersistentActorProviderTurnTargetV2,
): string {
  return [
    target.accountProfileId,
    target.providerThreadId,
    target.providerTurnId,
  ].join("\0");
}

function uniqueBounded(
  values: readonly string[],
  maximum: number,
): readonly string[] {
  if (values.length > maximum) {
    throw new RangeError(`Persistent actor liveness accepts at most ${maximum} targets`);
  }
  const unique = new Set<string>();
  for (const value of values) {
    if (value.length === 0 || value.length > 512 || value.includes("\0")) {
      throw new RangeError("Persistent actor liveness target is invalid");
    }
    unique.add(value);
  }
  return [...unique];
}

function boundedDuration(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive duration`);
  }
  return Math.max(minimum, Math.min(maximum, value));
}

const systemScheduler: PersistentActorLivenessSchedulerV2 = Object.freeze({
  monotonicNow: () => performance.now(),
  schedule: (callback: () => void, delayMilliseconds: number) => {
    const timer = setTimeout(callback, delayMilliseconds);
    return Object.freeze({ cancel: () => clearTimeout(timer) });
  },
});

function normalizeFailure(failure: unknown): Error {
  return failure instanceof Error
    ? failure
    : new Error("Persistent actor liveness reconciliation failed.", {
        cause: failure,
      });
}
