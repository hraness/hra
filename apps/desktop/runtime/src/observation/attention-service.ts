import type { RuntimeSnapshot } from "../../../contracts/runtime";
import type { AttentionProjection } from "@hraness/hra-local-observation-protocol/attention";

import {
  projectAttention,
  type TaskAttentionObservation,
  type WorkspaceSetupAttentionObservation,
} from "./attention-projector";

const defaultTaskRefreshTimeoutMilliseconds = 2_000;
const maximumTaskRefreshTimeoutMilliseconds = 4_000;

type TaskReadOutcome =
  | Readonly<{ kind: "completed"; tasks: TaskAttentionObservation }>
  | Readonly<{ kind: "failed" }>;

interface ActiveTaskRead {
  readonly controller: AbortController;
  readonly outcome: Promise<TaskReadOutcome>;
}

export interface AttentionObservationServiceOptions {
  readonly readSnapshot: () => RuntimeSnapshot;
  readonly readSetup?: () => readonly WorkspaceSetupAttentionObservation[];
  readonly readTasks?: (signal: AbortSignal) => Promise<TaskAttentionObservation>;
  readonly readTaskFallback?: () => TaskAttentionObservation;
  /** Focused test seam. Production keeps the fixed two-second budget. */
  readonly taskRefreshTimeoutMilliseconds?: number;
}

/**
 * Read-only gateway coordinator. It admits at most one task refresh, returns a
 * synchronous scoped fallback at the wall-clock deadline, and retains the
 * actual adapter promise so shutdown can abort and join it before teardown.
 */
export class AttentionObservationService {
  readonly #readSnapshot: AttentionObservationServiceOptions["readSnapshot"];
  readonly #readSetup: NonNullable<AttentionObservationServiceOptions["readSetup"]>;
  readonly #readTasks: AttentionObservationServiceOptions["readTasks"];
  readonly #readTaskFallback: AttentionObservationServiceOptions["readTaskFallback"];
  readonly #taskRefreshTimeoutMilliseconds: number;
  readonly #serviceAbort = new AbortController();
  #activeTaskRead: ActiveTaskRead | null = null;
  #admissionClosed = false;

  constructor(options: AttentionObservationServiceOptions) {
    this.#readSnapshot = options.readSnapshot;
    this.#readSetup = options.readSetup ?? (() => []);
    this.#readTasks = options.readTasks;
    this.#readTaskFallback = options.readTaskFallback;
    this.#taskRefreshTimeoutMilliseconds = options.taskRefreshTimeoutMilliseconds ??
      defaultTaskRefreshTimeoutMilliseconds;
    if (
      !Number.isSafeInteger(this.#taskRefreshTimeoutMilliseconds) ||
      this.#taskRefreshTimeoutMilliseconds < 1 ||
      this.#taskRefreshTimeoutMilliseconds > maximumTaskRefreshTimeoutMilliseconds
    ) throw new TypeError("Task attention refresh timeout is invalid.");
  }

  closeAdmission(): void {
    if (this.#admissionClosed) return;
    this.#admissionClosed = true;
    const reason = new Error("Attention observation service is closing.");
    this.#serviceAbort.abort(reason);
    this.#activeTaskRead?.controller.abort(reason);
  }

  hasUnsettledWork(): boolean {
    return this.#activeTaskRead !== null;
  }

  async settled(): Promise<void> {
    for (;;) {
      const active = this.#activeTaskRead;
      if (active === null) return;
      await active.outcome;
      await Promise.resolve();
    }
  }

  #fallback(): TaskAttentionObservation {
    try {
      return this.#readTaskFallback?.() ?? {
        completeness: "cloud_unavailable",
        workspaces: [],
      };
    } catch {
      return {
        completeness: "task_authority_unavailable",
        workspaces: [],
      };
    }
  }

  #startTaskRead(): ActiveTaskRead {
    if (this.#readTasks === undefined || this.#activeTaskRead !== null) {
      throw new Error("Task attention refresh admission is invalid.");
    }
    const controller = new AbortController();
    const outcome = Promise.resolve()
      .then(async () => await this.#readTasks!(controller.signal))
      .then(
        (tasks): TaskReadOutcome => ({ kind: "completed", tasks }),
        (): TaskReadOutcome => ({ kind: "failed" }),
      );
    const active = Object.freeze({ controller, outcome });
    this.#activeTaskRead = active;
    void outcome.finally(() => {
      if (this.#activeTaskRead === active) this.#activeTaskRead = null;
    }).catch(() => undefined);
    return active;
  }

  async list(signal: AbortSignal = new AbortController().signal): Promise<AttentionProjection> {
    signal.throwIfAborted();
    if (this.#admissionClosed) {
      throw new Error("Attention observation service admission is closed.");
    }
    let tasks: TaskAttentionObservation | undefined;
    if (this.#readTasks !== undefined) {
      if (this.#activeTaskRead !== null) {
        tasks = this.#fallback();
      } else {
        const active = this.#startTaskRead();
        type ListTaskOutcome =
          | TaskReadOutcome
          | Readonly<{ kind: "timedOut" }>
          | Readonly<{ kind: "callerAborted" }>
          | Readonly<{ kind: "serviceClosed" }>;
        let resolveCallerAbort!: (outcome: ListTaskOutcome) => void;
        const callerAbort = new Promise<ListTaskOutcome>((resolve) => {
          resolveCallerAbort = resolve;
        });
        const abortFromCaller = () => {
          active.controller.abort(signal.reason);
          resolveCallerAbort({ kind: "callerAborted" });
        };
        let resolveServiceClose!: (outcome: ListTaskOutcome) => void;
        const serviceClose = new Promise<ListTaskOutcome>((resolve) => {
          resolveServiceClose = resolve;
        });
        const abortFromService = () => {
          active.controller.abort(this.#serviceAbort.signal.reason);
          resolveServiceClose({ kind: "serviceClosed" });
        };
        signal.addEventListener("abort", abortFromCaller, { once: true });
        this.#serviceAbort.signal.addEventListener("abort", abortFromService, {
          once: true,
        });
        let timeout: ReturnType<typeof setTimeout> | null = null;
        const deadline = new Promise<ListTaskOutcome>((resolve) => {
          timeout = setTimeout(() => {
            active.controller.abort(new Error("Task attention refresh timed out."));
            resolve({ kind: "timedOut" });
          }, this.#taskRefreshTimeoutMilliseconds);
        });
        try {
          const outcome = await Promise.race([
            active.outcome,
            deadline,
            callerAbort,
            serviceClose,
          ]);
          signal.throwIfAborted();
          if (outcome.kind === "serviceClosed") {
            throw new Error("Attention observation service admission is closed.");
          }
          tasks = outcome.kind === "completed"
            ? outcome.tasks
            : outcome.kind === "timedOut"
            ? this.#fallback()
            : {
                completeness: "task_authority_unavailable",
                workspaces: [],
              };
        } finally {
          if (timeout !== null) clearTimeout(timeout);
          signal.removeEventListener("abort", abortFromCaller);
          this.#serviceAbort.signal.removeEventListener("abort", abortFromService);
        }
      }
    }
    signal.throwIfAborted();
    if (this.#admissionClosed) {
      throw new Error("Attention observation service admission is closed.");
    }
    // Local state is captured after the only asynchronous adapter so the
    // returned pane, account, and setup attention is fresh at projection time.
    const snapshot = this.#readSnapshot();
    const setup = this.#readSetup();
    return projectAttention({
      snapshot,
      setup,
      ...(tasks === undefined ? {} : { tasks }),
    });
  }
}
