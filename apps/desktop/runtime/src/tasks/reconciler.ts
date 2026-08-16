export const localTaskReconcilerMaximumBatch = 32;
export const localTaskReconcilerDefaultBackoffMs = 500;
export const localTaskReconcilerMaximumBackoffMs = 60_000;
export const localTaskReconcilerDefaultTimerMs = 1_000;
export const localTaskReconcilerDefaultSleepGapMs = 5_000;

export type LocalTaskDueWorkKind =
  | "defer_wake"
  | "queued_run"
  | "claim_expiry"
  | "run_recovery"
  | "interaction_expiry"
  | "repair";

export interface LocalTaskDueWork {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: LocalTaskDueWorkKind;
  readonly entityId: string;
  /** Immutable semantic deadline used for authority revalidation. */
  readonly dueAt: number;
  /**
   * Expected entity revision. For claim_expiry this is specifically the claim
   * lease generation, paired with expectedFence as the claim fence.
   */
  readonly expectedRevision: number | null;
  readonly expectedFence: number | null;
  readonly attempt: number;
  /** Changes on every enqueue replacement and every claim. */
  readonly workGeneration: number;
  readonly claimedBootGeneration: number;
}

export interface LocalTaskDueWorkPort {
  beginBoot(input: Readonly<{
    installationId: string;
    bootId: string;
    now: number;
  }>): number;
  closeBoot(input: Readonly<{
    bootGeneration: number;
    reason: "clean" | "recovered" | "replaced";
    now: number;
  }>): void;
  enqueue(input: Readonly<{
    workspaceId: string;
    kind: LocalTaskDueWorkKind;
    entityId: string;
    dueAt: number;
    expectedRevision?: number | undefined;
    expectedFence?: number | undefined;
    now: number;
  }>): void;
  claimDue(input: Readonly<{
    bootGeneration: number;
    now: number;
    limit: number;
    abandonedClaimAfterMs: number;
  }>): readonly LocalTaskDueWork[];
  complete(input: Readonly<{
    id: string;
    bootGeneration: number;
    workGeneration: number;
    now: number;
  }>): boolean;
  retry(input: Readonly<{
    id: string;
    bootGeneration: number;
    workGeneration: number;
    /** Mutable admission time for the next attempt, not a new authority deadline. */
    nextDueAt: number;
    errorCode: string;
    now: number;
  }>): boolean;
  release(input: Readonly<{
    id: string;
    bootGeneration: number;
    workGeneration: number;
    now: number;
  }>): boolean;
  cancel(input: Readonly<{
    id: string;
    bootGeneration: number;
    workGeneration: number;
    now: number;
  }>): boolean;
}

/**
 * The queued-run handler may depend on this port without learning about the
 * SQLite-backed due-work store. The claim fence must be carried unchanged
 * through start and settlement.
 */
export interface LocalQueuedRunIntentClaim {
  readonly workspaceId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly repositoryId: string;
  readonly fence: number;
  readonly bootGeneration: number;
}

export interface LocalQueuedRunIntentPort {
  claimQueuedRunIntent(input: Readonly<{
    workspaceId: string;
    runId: string;
    bootGeneration: number;
    now: number;
  }>): LocalQueuedRunIntentClaim | null;
  markQueuedRunIntentStarted(input: Readonly<{
    workspaceId: string;
    runId: string;
    bootGeneration: number;
    fence: number;
    now: number;
  }>): void;
  finishQueuedRunIntent(input: Readonly<{
    workspaceId: string;
    runId: string;
    bootGeneration: number;
    fence: number;
    outcome: "terminal" | "abandoned";
    now: number;
  }>): void;
}

export interface LocalTaskReconcilerClock {
  wallNow(): number;
  monotonicNow(): number;
}

export interface LocalTaskReconcilerScheduler {
  schedule(callback: () => void, delayMs: number): () => void;
}

export type LocalTaskReconcilerWakeReason =
  | "startup"
  | "timer"
  | "explicit"
  | "host_wake"
  | "large_clock_gap";

export interface LocalTaskDueWorkCurrentAuthority {
  readonly kind: "current";
  readonly bootGeneration: number;
  readonly deadlineCheckedAt: number;
  readonly revision: number | null;
  readonly fence: number | null;
}

export interface LocalTaskDueWorkStaleAuthority {
  readonly kind: "stale";
  readonly reason: "boot" | "deadline" | "revision" | "fence" | "missing";
}

export type LocalTaskDueWorkHandlerResult =
  | Readonly<{
      outcome: "completed";
      authority: LocalTaskDueWorkCurrentAuthority;
    }>
  | Readonly<{
      /**
       * The handler's command transaction already settled the durable due row.
       * This is reserved for local system commands that revalidate authority,
       * mutate domain state, emit events, and complete the work atomically.
       */
      outcome: "settled";
      authority: LocalTaskDueWorkCurrentAuthority;
    }>
  | Readonly<{
      outcome: "obsolete";
      authority: LocalTaskDueWorkStaleAuthority;
    }>
  | Readonly<{
      outcome: "retry";
      authority: LocalTaskDueWorkCurrentAuthority;
      errorCode: string;
      retryAfterMs?: number | undefined;
    }>;

export interface LocalTaskDueWorkHandlerContext {
  readonly bootGeneration: number;
  readonly wakeReason: LocalTaskReconcilerWakeReason;
  readonly wallNow: number;
}

type LocalTaskDueWorkHandler = (
  work: LocalTaskDueWork,
  context: LocalTaskDueWorkHandlerContext,
) => LocalTaskDueWorkHandlerResult | Promise<LocalTaskDueWorkHandlerResult>;

export interface LocalTaskDueWorkHandlers {
  readonly deferWake: LocalTaskDueWorkHandler;
  readonly startQueuedRun: LocalTaskDueWorkHandler;
  readonly expireClaim: LocalTaskDueWorkHandler;
  /**
   * Handles an intent that was already started by an older boot. This handler
   * may record ambiguity or abandonment, but must never call the start path.
   */
  readonly recoverStartedRun: LocalTaskDueWorkHandler;
  readonly expireInteraction: LocalTaskDueWorkHandler;
  readonly repair: LocalTaskDueWorkHandler;
}

export interface LocalTaskReconcilerOptions {
  readonly installationId: string;
  readonly bootId: string;
  readonly dueWork: LocalTaskDueWorkPort;
  readonly handlers: LocalTaskDueWorkHandlers;
  readonly clock?: LocalTaskReconcilerClock;
  readonly scheduler?: LocalTaskReconcilerScheduler;
  readonly timerMs?: number;
  readonly sleepGapMs?: number;
  readonly abandonedClaimAfterMs?: number;
  readonly baseBackoffMs?: number;
  readonly maximumBackoffMs?: number;
  readonly onFault?: (error: unknown) => void;
}

export interface LocalTaskDueWorkEnqueue {
  readonly workspaceId: string;
  readonly kind: LocalTaskDueWorkKind;
  readonly entityId: string;
  readonly dueAt: number;
  readonly expectedRevision?: number | undefined;
  readonly expectedFence?: number | undefined;
}

export type LocalTaskReconcilerState =
  | "idle"
  | "recovering"
  | "running"
  | "stopping"
  | "stopped";

const defaultClock: LocalTaskReconcilerClock = {
  wallNow: () => Date.now(),
  monotonicNow: () => Math.floor(performance.now()),
};

const defaultScheduler: LocalTaskReconcilerScheduler = {
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export class LocalTaskReconciler {
  readonly #installationId: string;
  readonly #bootId: string;
  readonly #dueWork: LocalTaskDueWorkPort;
  readonly #handlers: LocalTaskDueWorkHandlers;
  readonly #clock: LocalTaskReconcilerClock;
  readonly #scheduler: LocalTaskReconcilerScheduler;
  readonly #timerMs: number;
  readonly #sleepGapMs: number;
  readonly #abandonedClaimAfterMs: number;
  readonly #baseBackoffMs: number;
  readonly #maximumBackoffMs: number;
  readonly #onFault: (error: unknown) => void;

  #state: LocalTaskReconcilerState = "idle";
  #bootGeneration: number | null = null;
  #startup: Promise<void> | null = null;
  #pass: Promise<void> | null = null;
  #queuedReason: LocalTaskReconcilerWakeReason | null = null;
  #cancelTimer: (() => void) | null = null;
  #lastWallNow: number | null = null;
  #lastMonotonicNow: number | null = null;

  constructor(options: LocalTaskReconcilerOptions) {
    this.#installationId = nonempty(options.installationId, "installation ID");
    this.#bootId = nonempty(options.bootId, "boot ID");
    this.#dueWork = options.dueWork;
    this.#handlers = options.handlers;
    this.#clock = options.clock ?? defaultClock;
    this.#scheduler = options.scheduler ?? defaultScheduler;
    this.#timerMs = positiveInteger(
      options.timerMs ?? localTaskReconcilerDefaultTimerMs,
      "timer interval",
    );
    this.#sleepGapMs = positiveInteger(
      options.sleepGapMs ?? localTaskReconcilerDefaultSleepGapMs,
      "sleep gap",
    );
    this.#abandonedClaimAfterMs = positiveInteger(
      options.abandonedClaimAfterMs ?? 60_000,
      "abandoned claim interval",
    );
    this.#baseBackoffMs = positiveInteger(
      options.baseBackoffMs ?? localTaskReconcilerDefaultBackoffMs,
      "base backoff",
    );
    this.#maximumBackoffMs = positiveInteger(
      options.maximumBackoffMs ?? localTaskReconcilerMaximumBackoffMs,
      "maximum backoff",
    );
    if (this.#baseBackoffMs > this.#maximumBackoffMs) {
      throw new RangeError("base backoff cannot exceed maximum backoff");
    }
    this.#onFault = options.onFault ?? (() => undefined);
  }

  get bootGeneration(): number | null {
    return this.#bootGeneration;
  }

  get state(): LocalTaskReconcilerState {
    return this.#state;
  }

  /**
   * Opens the durable boot synchronously so stale claims are fenced before any
   * service can publish readiness or accept a command. Recovery work is not
   * admitted until start(), which lets callers bind every boot-scoped port to
   * this exact generation first.
   */
  begin(): number {
    if (this.#state !== "idle") {
      throw new Error("Local task reconciler already began a boot");
    }
    const wallNow = safeClock(this.#clock.wallNow(), "wall clock");
    this.#lastWallNow = wallNow;
    this.#lastMonotonicNow = safeClock(this.#clock.monotonicNow(), "monotonic clock");
    this.#bootGeneration = positiveInteger(
      this.#dueWork.beginBoot({
        installationId: this.#installationId,
        bootId: this.#bootId,
        now: wallNow,
      }),
      "boot generation",
    );
    this.#state = "recovering";
    return this.#bootGeneration;
  }

  /**
   * Starts the bounded startup pass without hiding beginBoot failures behind an
   * async rejection. The returned readiness promise settles only after every
   * wake coalesced into the initial serialized tail has drained.
   */
  start(): Promise<void> {
    if (this.#state === "idle") this.begin();
    if (this.#state !== "recovering" || this.#startup !== null) {
      throw new Error("Local task reconciler already started");
    }
    const pass = this.#queuePass("startup");
    const startup = pass.then(() => {
      if (this.#state !== "recovering") return;
      this.#state = "running";
      this.#armTimer();
    });
    this.#startup = startup;
    return startup;
  }

  enqueue(work: LocalTaskDueWorkEnqueue): void {
    if (this.#state !== "running") {
      throw new Error("Local task reconciler is not accepting work");
    }
    const now = safeClock(this.#clock.wallNow(), "wall clock");
    this.#dueWork.enqueue({ ...work, now });
    this.wake("explicit");
  }

  wake(reason: Exclude<LocalTaskReconcilerWakeReason, "startup" | "large_clock_gap">): void {
    if (this.#state !== "recovering" && this.#state !== "running") return;
    void this.#queuePass(this.#sampleWakeReason(reason)).catch(this.#onFault);
  }

  /**
   * Waits until the currently admitted pass and every wake coalesced into it
   * have settled. It does not stop the periodic timer or admit new work.
   */
  async drain(): Promise<void> {
    await this.#pass;
  }

  async stop(
    beforeBootClose: () => void | Promise<void> = () => undefined,
  ): Promise<void> {
    if (this.#state === "stopped") return;
    if (this.#state === "idle") {
      this.#state = "stopped";
      await beforeBootClose();
      return;
    }
    this.#state = "stopping";
    this.#queuedReason = null;
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    await this.#pass;
    try {
      // The active boot remains a valid local fence while already-admitted
      // external work is cancelled and settled. Closing it earlier would let
      // shutdown itself race those final fenced transitions.
      await beforeBootClose();
    } finally {
      const generation = this.#bootGeneration;
      if (generation !== null) {
        this.#dueWork.closeBoot({
          bootGeneration: generation,
          reason: "clean",
          now: safeClock(this.#clock.wallNow(), "wall clock"),
        });
      }
      this.#state = "stopped";
    }
  }

  #sampleWakeReason(
    requested: Exclude<LocalTaskReconcilerWakeReason, "startup" | "large_clock_gap">,
  ): LocalTaskReconcilerWakeReason {
    const wallNow = safeClock(this.#clock.wallNow(), "wall clock");
    const monotonicNow = safeClock(this.#clock.monotonicNow(), "monotonic clock");
    const previousWall = this.#lastWallNow;
    const previousMonotonic = this.#lastMonotonicNow;
    this.#lastWallNow = wallNow;
    this.#lastMonotonicNow = monotonicNow;
    if (previousWall === null || previousMonotonic === null) return requested;
    const wallElapsed = Math.max(0, wallNow - previousWall);
    const monotonicElapsed = Math.max(0, monotonicNow - previousMonotonic);
    return wallElapsed - monotonicElapsed >= this.#sleepGapMs
      ? "large_clock_gap"
      : requested;
  }

  #queuePass(reason: LocalTaskReconcilerWakeReason): Promise<void> {
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    this.#queuedReason = strongerWakeReason(this.#queuedReason, reason);
    if (this.#pass !== null) return this.#pass;
    const pass = this.#drainQueuedPasses();
    this.#pass = pass;
    void pass.finally(() => {
      if (this.#pass === pass) this.#pass = null;
      if (this.#state === "running") this.#armTimer();
    }).catch(() => undefined);
    return pass;
  }

  async #drainQueuedPasses(): Promise<void> {
    while (
      (this.#state === "recovering" || this.#state === "running")
      && this.#queuedReason !== null
    ) {
      const reason = this.#queuedReason;
      this.#queuedReason = null;
      await this.#runPass(reason);
    }
  }

  async #runPass(reason: LocalTaskReconcilerWakeReason): Promise<void> {
    const generation = requiredBootGeneration(this.#bootGeneration);
    const claimed = this.#dueWork.claimDue({
      bootGeneration: generation,
      now: safeClock(this.#clock.wallNow(), "wall clock"),
      limit: localTaskReconcilerMaximumBatch,
      abandonedClaimAfterMs: this.#abandonedClaimAfterMs,
    });
    if (claimed.length > localTaskReconcilerMaximumBatch) {
      throw new Error("Due-work port exceeded the reconciler batch limit");
    }
    for (const work of claimed) {
      const now = safeClock(this.#clock.wallNow(), "wall clock");
      if (this.#state !== "recovering" && this.#state !== "running") {
        this.#dueWork.release({
          id: work.id,
          bootGeneration: generation,
          workGeneration: work.workGeneration,
          now,
        });
        continue;
      }
      await this.#handleOne(work, reason, generation, now);
    }
  }

  async #handleOne(
    work: LocalTaskDueWork,
    wakeReason: LocalTaskReconcilerWakeReason,
    bootGeneration: number,
    wallNow: number,
  ): Promise<void> {
    if (
      work.claimedBootGeneration !== bootGeneration ||
      work.dueAt > wallNow
    ) {
      this.#dueWork.release({
        id: work.id,
        bootGeneration,
        workGeneration: work.workGeneration,
        now: wallNow,
      });
      return;
    }
    let result: LocalTaskDueWorkHandlerResult;
    try {
      result = await handlerFor(this.#handlers, work.kind)(work, {
        bootGeneration,
        wakeReason,
        wallNow,
      });
    } catch {
      this.#retry(work, bootGeneration, wallNow, "handler_failed");
      return;
    }
    if (result.outcome === "obsolete") {
      this.#dueWork.cancel({
        id: work.id,
        bootGeneration,
        workGeneration: work.workGeneration,
        now: safeClock(this.#clock.wallNow(), "wall clock"),
      });
      return;
    }
    if (!authorityMatches(result.authority, work, bootGeneration)) {
      this.#retry(work, bootGeneration, wallNow, "revalidation_mismatch");
      return;
    }
    const settledAt = safeClock(this.#clock.wallNow(), "wall clock");
    if (result.outcome === "completed") {
      this.#dueWork.complete({
        id: work.id,
        bootGeneration,
        workGeneration: work.workGeneration,
        now: settledAt,
      });
      return;
    }
    if (result.outcome === "settled") return;
    this.#retry(
      work,
      bootGeneration,
      settledAt,
      safeErrorCode(result.errorCode),
      result.retryAfterMs,
    );
  }

  #retry(
    work: LocalTaskDueWork,
    bootGeneration: number,
    now: number,
    errorCode: string,
    requestedDelay?: number,
  ): void {
    const delay = requestedDelay === undefined
      ? exponentialBackoff(
          work.attempt,
          this.#baseBackoffMs,
          this.#maximumBackoffMs,
        )
      : Math.min(
          positiveInteger(requestedDelay, "retry delay"),
          this.#maximumBackoffMs,
        );
    this.#dueWork.retry({
      id: work.id,
      bootGeneration,
      workGeneration: work.workGeneration,
      nextDueAt: safeTimestampAdd(now, delay),
      errorCode,
      now,
    });
  }

  #armTimer(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = this.#scheduler.schedule(() => {
      this.#cancelTimer = null;
      this.wake("timer");
    }, this.#timerMs);
  }
}

function handlerFor(
  handlers: LocalTaskDueWorkHandlers,
  kind: LocalTaskDueWorkKind,
): LocalTaskDueWorkHandler {
  switch (kind) {
    case "defer_wake":
      return handlers.deferWake;
    case "queued_run":
      return handlers.startQueuedRun;
    case "claim_expiry":
      return handlers.expireClaim;
    case "run_recovery":
      return handlers.recoverStartedRun;
    case "interaction_expiry":
      return handlers.expireInteraction;
    case "repair":
      return handlers.repair;
  }
}

function authorityMatches(
  authority: LocalTaskDueWorkCurrentAuthority,
  work: LocalTaskDueWork,
  bootGeneration: number,
): boolean {
  return authority.bootGeneration === bootGeneration &&
    authority.deadlineCheckedAt >= work.dueAt &&
    authority.revision === work.expectedRevision &&
    authority.fence === work.expectedFence;
}

function exponentialBackoff(attempt: number, base: number, maximum: number): number {
  const exponent = Math.min(Math.max(0, attempt - 1), 30);
  return Math.min(maximum, base * (2 ** exponent));
}

function strongerWakeReason(
  current: LocalTaskReconcilerWakeReason | null,
  incoming: LocalTaskReconcilerWakeReason,
): LocalTaskReconcilerWakeReason {
  if (current === "large_clock_gap" || incoming === "large_clock_gap") {
    return "large_clock_gap";
  }
  if (current === "host_wake" || incoming === "host_wake") return "host_wake";
  return current ?? incoming;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function safeClock(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a nonnegative safe integer`);
  }
  return value;
}

function safeTimestampAdd(value: number, increment: number): number {
  const result = value + increment;
  if (!Number.isSafeInteger(result) || result < 0) return Number.MAX_SAFE_INTEGER;
  return result;
}

function safeErrorCode(value: string): string {
  return /^[a-z0-9_]{1,128}$/u.test(value) ? value : "handler_retry";
}

function nonempty(value: string, label: string): string {
  if (value.length === 0 || value.length > 128) {
    throw new RangeError(`${label} must contain 1 to 128 characters`);
  }
  return value;
}

function requiredBootGeneration(value: number | null): number {
  if (value === null) throw new Error("Local task reconciler has no active boot");
  return value;
}
