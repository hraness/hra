import type { ProjectionEvent } from "./reducer";
import type { RuntimeProjection } from "./projection";
import {
  ProjectionBackpressureError,
} from "./projection";

export class ProjectionCoordinatorClosedError extends Error {
  constructor() {
    super("Runtime projection commit admission is closed");
    this.name = "ProjectionCoordinatorClosedError";
  }
}

export class ProjectionCoordinatorSaturationError extends Error {
  readonly capacity: number;
  readonly pending: number;

  constructor(capacity: number, pending: number) {
    super(
      `Runtime projection commit admission is saturated at ${String(pending)}/${String(capacity)}`,
    );
    this.name = "ProjectionCoordinatorSaturationError";
    this.capacity = capacity;
    this.pending = pending;
  }
}

export class ProjectionCoordinatorCapacityTimeoutError extends Error {
  readonly pending: number;
  readonly timeoutMs: number;

  constructor(timeoutMs: number, pending: number) {
    super(
      `Runtime projection capacity did not recover within ${String(timeoutMs)} ms with ${String(pending)} commit(s) pending`,
    );
    this.name = "ProjectionCoordinatorCapacityTimeoutError";
    this.timeoutMs = timeoutMs;
    this.pending = pending;
  }
}

export interface ProjectionCommitCoordinatorOptions {
  /**
   * Bounds event-bearing promise closures while the renderer or stdout is
   * stalled. The projection delivery queue remains the primary capacity
   * authority; this is a fail-closed second-order memory bound.
   */
  readonly maxPendingCommits?: number;
  /**
   * Bounds a renderer/Native drain stall. Once this deadline expires, every
   * admitted or future commit fails with the same terminal error so shutdown
   * and caller recovery cannot remain pinned behind an abandoned queue.
   */
  readonly capacityWaitTimeoutMs?: number;
  /** Synchronous, once-only notification used by the gateway supervisor path. */
  readonly onCapacityTimeout?: (
    error: ProjectionCoordinatorCapacityTimeoutError,
  ) => void;
}

/**
 * Serializes projection commits and awaits real queue capacity. Event data
 * remains in the admitted caller rather than being copied into a second
 * buffer; RuntimeProjection remains the sole bounded delivery queue.
 */
export class ProjectionCommitCoordinator {
  readonly #projection: RuntimeProjection;
  readonly #maxPendingCommits: number;
  readonly #capacityWaitTimeoutMs: number;
  readonly #onCapacityTimeout: ((
    error: ProjectionCoordinatorCapacityTimeoutError,
  ) => void) | null;
  #tail: Promise<void> = Promise.resolve();
  #admissionClosed = false;
  #pendingCommits = 0;
  #capacityFailure: ProjectionCoordinatorCapacityTimeoutError | null = null;

  constructor(
    projection: RuntimeProjection,
    options: ProjectionCommitCoordinatorOptions = {},
  ) {
    this.#projection = projection;
    this.#maxPendingCommits = options.maxPendingCommits ?? 512;
    this.#capacityWaitTimeoutMs = options.capacityWaitTimeoutMs ?? 5_000;
    this.#onCapacityTimeout = options.onCapacityTimeout ?? null;
    if (
      !Number.isSafeInteger(this.#maxPendingCommits) ||
      this.#maxPendingCommits < 1
    ) {
      throw new RangeError("maxPendingCommits must be a positive safe integer");
    }
    if (
      !Number.isSafeInteger(this.#capacityWaitTimeoutMs) ||
      this.#capacityWaitTimeoutMs < 1 ||
      this.#capacityWaitTimeoutMs > 60_000
    ) {
      throw new RangeError(
        "capacityWaitTimeoutMs must be an integer from 1 through 60000",
      );
    }
  }

  get pendingCommitCount(): number {
    return this.#pendingCommits;
  }

  publish(event: ProjectionEvent): Promise<void> {
    return this.#enqueue(() => this.#commitWhenCapacityAllows(() => {
      this.#projection.publish(event);
    }));
  }

  installRecoverableState(event: ProjectionEvent): Promise<void> {
    return this.#enqueue(() => this.#commitWhenCapacityAllows(() => {
      this.#projection.installRecoverableState(event);
    }));
  }

  installHarnessState(
    input: Parameters<RuntimeProjection["installHarnessState"]>[0],
  ): Promise<void> {
    return this.#enqueue(() => this.#commitWhenCapacityAllows(() => {
      this.#projection.installHarnessState(input);
    }));
  }

  installChatMessageQueueState(
    input: Parameters<RuntimeProjection["installChatMessageQueueState"]>[0],
  ): Promise<void> {
    return this.#enqueue(() => this.#commitWhenCapacityAllows(() => {
      this.#projection.installChatMessageQueueState(input);
    }));
  }

  /** Prevents new commits while allowing every already-admitted commit to drain. */
  closeAdmission(): void {
    this.#admissionClosed = true;
  }

  /** Waits for every commit admitted before (or during) this call. */
  async settled(): Promise<void> {
    for (;;) {
      const observed = this.#tail;
      await observed;
      if (this.#tail === observed) return;
    }
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    if (this.#capacityFailure !== null) {
      return Promise.reject(this.#capacityFailure);
    }
    if (this.#admissionClosed) {
      return Promise.reject(new ProjectionCoordinatorClosedError());
    }
    if (this.#pendingCommits >= this.#maxPendingCommits) {
      return Promise.reject(new ProjectionCoordinatorSaturationError(
        this.#maxPendingCommits,
        this.#pendingCommits,
      ));
    }
    this.#pendingCommits += 1;
    const run = this.#tail.then(operation);
    this.#tail = run.catch(() => undefined);
    return run.finally(() => {
      this.#pendingCommits -= 1;
    });
  }

  async #commitWhenCapacityAllows(commit: () => void): Promise<void> {
    for (;;) {
      if (this.#capacityFailure !== null) throw this.#capacityFailure;
      const observedGeneration = this.#projection.capacityGeneration;
      try {
        commit();
        return;
      } catch (error: unknown) {
        if (!(error instanceof ProjectionBackpressureError)) throw error;
      }
      const capacityChanged = this.#projection.waitForCapacityChange(
        observedGeneration,
      );
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timedOut = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), this.#capacityWaitTimeoutMs);
      });
      const recovered = await Promise.race([
        capacityChanged.then(() => true),
        timedOut,
      ]).finally(() => {
        if (timer !== null) clearTimeout(timer);
      });
      if (recovered) continue;

      const failure = this.#capacityFailure ??
        new ProjectionCoordinatorCapacityTimeoutError(
          this.#capacityWaitTimeoutMs,
          this.#pendingCommits,
        );
      if (this.#capacityFailure === null) {
        this.#capacityFailure = failure;
        this.#admissionClosed = true;
        try {
          this.#onCapacityTimeout?.(failure);
        } catch {
          // The terminal coordinator error still releases every caller even
          // if an injected recovery notifier itself is unavailable.
        }
      }
      throw failure;
    }
  }
}
