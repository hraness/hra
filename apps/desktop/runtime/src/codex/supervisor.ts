import type { CodexGenerationEndReason } from "./rpc-core";

export interface CodexRestartPolicy {
  readonly initialDelayMs: number;
  readonly maximumDelayMs: number;
  readonly maximumRestartAttempts: number;
}

export interface SupervisedCodexGeneration {
  readonly generation: number;
  expire(reason: CodexGenerationEndReason): void | Promise<void>;
}

export type CodexSupervisorState =
  | Readonly<{ type: "idle"; generation: number }>
  | Readonly<{ type: "starting"; generation: number }>
  | Readonly<{ type: "running"; generation: number }>
  | Readonly<{
      type: "backing_off";
      generation: number;
      attempt: number;
      delayMs: number;
    }>
  | Readonly<{
      type: "failed";
      generation: number;
      attempts: number;
    }>
  | Readonly<{ type: "stopped"; generation: number }>;

export interface CodexRestartSupervisorOptions<T extends SupervisedCodexGeneration> {
  readonly beforeCreate?: (generation: number) => void | Promise<void>;
  readonly create: (generation: number) => Promise<T>;
  readonly initialGeneration?: number;
  readonly now?: () => number;
  readonly onState?: (state: CodexSupervisorState) => void;
  readonly policy: CodexRestartPolicy;
  readonly restartBudgetResetMs?: number;
  readonly sleep?: (delayMs: number) => Promise<void>;
}

export class CodexSupervisorStartError extends Error {
  constructor() {
    super("The Codex process generation could not be started.");
    this.name = "CodexSupervisorStartError";
  }
}

function positiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function nonnegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative safe integer`);
  }
}

function validatePolicy(policy: CodexRestartPolicy): void {
  positiveSafeInteger(policy.initialDelayMs, "initialDelayMs");
  positiveSafeInteger(policy.maximumDelayMs, "maximumDelayMs");
  positiveSafeInteger(policy.maximumRestartAttempts, "maximumRestartAttempts");
  if (policy.maximumDelayMs < policy.initialDelayMs) {
    throw new Error("maximumDelayMs must be at least initialDelayMs");
  }
  if (policy.maximumRestartAttempts > 32) {
    throw new Error("maximumRestartAttempts must not exceed 32");
  }
}

export function codexRestartDelay(
  policy: CodexRestartPolicy,
  attempt: number,
): number {
  validatePolicy(policy);
  positiveSafeInteger(attempt, "attempt");
  const exponent = Math.min(attempt - 1, 52);
  return Math.min(
    policy.maximumDelayMs,
    policy.initialDelayMs * 2 ** exponent,
  );
}

export class CodexRestartSupervisor<T extends SupervisedCodexGeneration> {
  readonly #beforeCreate: (generation: number) => void | Promise<void>;
  readonly #create: (generation: number) => Promise<T>;
  readonly #now: () => number;
  readonly #onState: ((state: CodexSupervisorState) => void) | undefined;
  readonly #policy: CodexRestartPolicy;
  readonly #restartBudgetResetMs: number;
  readonly #sleep: (delayMs: number) => Promise<void>;
  #current: T | null = null;
  #currentStartedAt: number | null = null;
  #generation: number;
  #queuedRestart: Readonly<{
    generation: number;
    reason: CodexGenerationEndReason;
  }> | null = null;
  #restartAttemptsUsed = 0;
  #restartPromise: Promise<T | null> | null = null;
  #startPromise: Promise<T> | null = null;
  #state: CodexSupervisorState;
  #stopRequested = false;

  constructor(options: CodexRestartSupervisorOptions<T>) {
    validatePolicy(options.policy);
    const initialGeneration = options.initialGeneration ?? 0;
    nonnegativeSafeInteger(initialGeneration, "initialGeneration");
    const restartBudgetResetMs = options.restartBudgetResetMs ?? 30_000;
    positiveSafeInteger(restartBudgetResetMs, "restartBudgetResetMs");
    this.#beforeCreate = options.beforeCreate ?? (() => undefined);
    this.#create = options.create;
    this.#generation = initialGeneration;
    this.#now = options.now ?? (() => performance.now());
    this.#onState = options.onState;
    this.#policy = options.policy;
    this.#restartBudgetResetMs = restartBudgetResetMs;
    this.#sleep = options.sleep ?? Bun.sleep;
    this.#state = { type: "idle", generation: initialGeneration };
  }

  get current(): T | null {
    return this.#current;
  }

  get generation(): number {
    return this.#generation;
  }

  get state(): CodexSupervisorState {
    return this.#state;
  }

  async start(): Promise<T> {
    if (this.#startPromise !== null) return await this.#startPromise;
    const task = this.#startOnce();
    this.#startPromise = task;
    try {
      return await task;
    } finally {
      if (this.#startPromise === task) this.#startPromise = null;
    }
  }

  async #startOnce(): Promise<T> {
    if (this.#current !== null) return this.#current;
    if (this.#restartPromise !== null) {
      const restarted = await this.#restartPromise;
      if (restarted === null) throw new CodexSupervisorStartError();
      return restarted;
    }
    if (
      this.#state.type === "failed" &&
      this.#restartAttemptsUsed >= this.#policy.maximumRestartAttempts
    ) {
      throw new CodexSupervisorStartError();
    }
    this.#stopRequested = false;
    const generation = this.#nextGeneration();
    try {
      await this.#beforeCreate(generation);
      if (this.#stopRequested) {
        this.#setState({ type: "stopped", generation: this.#generation });
        throw new CodexSupervisorStartError();
      }
      this.#setState({ type: "starting", generation });
      const created = await this.#create(generation);
      await this.#acceptGeneration(created, generation);
      if (this.#stopRequested) {
        await created.expire("stopped");
        this.#setState({ type: "stopped", generation: this.#generation });
        throw new CodexSupervisorStartError();
      }
      this.#current = created;
      this.#currentStartedAt = this.#now();
      this.#setState({ type: "running", generation });
      return created;
    } catch (error: unknown) {
      if (this.#stopRequested || this.#state.type === "stopped") {
        throw new CodexSupervisorStartError();
      }
      // A failed first launch is operationally the same as a process fault.
      // Recover it through the one capped, backoff-governed restart budget
      // instead of allowing repeated calls to `start()` to launch forever.
      void error;
      const recovered = await this.#restart("process_exited");
      if (recovered === null) throw new CodexSupervisorStartError();
      return recovered;
    }
  }

  restart(
    reason: CodexGenerationEndReason,
    faultedGeneration?: number,
  ): Promise<T | null> {
    if (this.#restartPromise !== null) {
      if (faultedGeneration !== undefined && faultedGeneration === this.#generation) {
        this.#queuedRestart = { generation: faultedGeneration, reason };
      }
      return this.#restartPromise;
    }
    if (reason === "restart_requested") this.#restartAttemptsUsed = 0;
    this.#stopRequested = false;
    const task = this.#restartQueued(reason);
    this.#restartPromise = task;
    void task.then(
      () => this.#finishRestartTask(task),
      () => this.#finishRestartTask(task),
    );
    return task;
  }

  /**
   * Reopens the automatic restart budget after the caller has observed a
   * generation remain healthy for its chosen stability window.
   */
  resetRestartBudget(): void {
    if (this.#current === null || this.#state.type !== "running") return;
    this.#restartAttemptsUsed = 0;
  }

  async stop(): Promise<void> {
    this.#stopRequested = true;
    this.#queuedRestart = null;
    if (this.#startPromise !== null) {
      try {
        await this.#startPromise;
      } catch {
        // A stopped in-flight start expires its created generation before rejecting.
      }
    }
    if (this.#restartPromise !== null) await this.#restartPromise;
    const current = this.#current;
    this.#current = null;
    this.#currentStartedAt = null;
    if (current !== null) await current.expire("stopped");
    if (this.#state.type !== "stopped") {
      this.#setState({ type: "stopped", generation: this.#generation });
    }
  }

  async #restartAfterStart(reason: CodexGenerationEndReason): Promise<T | null> {
    if (this.#startPromise !== null) {
      try {
        await this.#startPromise;
      } catch {
        // A bounded restart may recover after the initial launch fails.
      }
    }
    return await this.#restart(reason);
  }

  async #restartQueued(reason: CodexGenerationEndReason): Promise<T | null> {
    let result = await this.#restartAfterStart(reason);
    while (!this.#stopRequested) {
      // Let a just-launched generation's already-resolved fault callback run
      // before deciding that restart convergence is complete.
      await Promise.resolve();
      const queued = this.#takeQueuedRestart();
      if (queued === null) return result;
      if (queued.generation !== this.#generation) continue;
      result = await this.#restart(queued.reason);
    }
    return result;
  }

  async #restart(reason: CodexGenerationEndReason): Promise<T | null> {
    const current = this.#current;
    if (
      current !== null &&
      this.#currentStartedAt !== null &&
      this.#now() - this.#currentStartedAt >= this.#restartBudgetResetMs
    ) {
      this.#restartAttemptsUsed = 0;
    }
    this.#current = null;
    this.#currentStartedAt = null;
    if (current !== null) {
      try {
        await current.expire(reason);
      } catch {
        // Expiration cannot authorize replay or prevent a bounded fresh launch.
      }
    }

    while (this.#restartAttemptsUsed < this.#policy.maximumRestartAttempts) {
      this.#restartAttemptsUsed += 1;
      const attempt = this.#restartAttemptsUsed;
      const delayMs = codexRestartDelay(this.#policy, attempt);
      this.#setState({
        type: "backing_off",
        generation: this.#generation,
        attempt,
        delayMs,
      });
      await this.#sleep(delayMs);
      if (this.#stopRequested) {
        this.#setState({ type: "stopped", generation: this.#generation });
        return null;
      }

      const generation = this.#nextGeneration();
      try {
        await this.#beforeCreate(generation);
        if (this.#stopRequested) {
          this.#setState({ type: "stopped", generation: this.#generation });
          return null;
        }
        this.#setState({ type: "starting", generation });
        const created = await this.#create(generation);
        await this.#acceptGeneration(created, generation);
        if (this.#stopRequested) {
          await created.expire("stopped");
          this.#setState({ type: "stopped", generation: this.#generation });
          return null;
        }
        this.#current = created;
        this.#currentStartedAt = this.#now();
        this.#setState({ type: "running", generation });
        return created;
      } catch {
        // The next bounded attempt receives a new generation and a capped delay.
      }
    }

    this.#setState({
      type: "failed",
      generation: this.#generation,
      attempts: this.#restartAttemptsUsed,
    });
    return null;
  }

  async #acceptGeneration(created: T, generation: number): Promise<void> {
    if (created.generation !== generation) {
      await created.expire("protocol_fault");
      throw new Error("Codex process factory returned the wrong generation");
    }
  }

  #nextGeneration(): number {
    if (this.#generation === Number.MAX_SAFE_INTEGER) {
      throw new Error("Codex process generation exhausted safe integers");
    }
    this.#generation += 1;
    return this.#generation;
  }

  #finishRestartTask(task: Promise<T | null>): void {
    if (this.#restartPromise !== task) return;
    this.#restartPromise = null;
    const queued = this.#takeQueuedRestart();
    if (
      queued !== null &&
      !this.#stopRequested &&
      queued.generation === this.#generation
    ) {
      void this.restart(queued.reason, queued.generation);
    }
  }

  #takeQueuedRestart(): Readonly<{
    generation: number;
    reason: CodexGenerationEndReason;
  }> | null {
    const queued = this.#queuedRestart;
    this.#queuedRestart = null;
    return queued;
  }

  #setState(state: CodexSupervisorState): void {
    this.#state = state;
    try {
      this.#onState?.(state);
    } catch {
      // Projection callbacks cannot take control of process supervision.
    }
  }
}
