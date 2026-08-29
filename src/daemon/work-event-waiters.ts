import { WORK_WAITER_LIMIT } from "../domain/work";

type Waiter = Readonly<{
  workId: string;
  resolve: () => void;
}>;

export class WorkEventWaiterLimitError extends Error {
  constructor() {
    super("The daemon already has the maximum number of work event waiters.");
    this.name = "WorkEventWaiterLimitError";
  }
}

export class WorkEventWaiters {
  readonly #maximum: number;
  readonly #waiters = new Set<Waiter>();

  constructor(maximum = WORK_WAITER_LIMIT) {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > WORK_WAITER_LIMIT) {
      throw new Error(
        `Work event waiter capacity must be an integer from 1 through ${WORK_WAITER_LIMIT}.`,
      );
    }
    this.#maximum = maximum;
  }

  get size(): number {
    return this.#waiters.size;
  }

  notify(workId: string): void {
    for (const waiter of [...this.#waiters]) {
      if (waiter.workId === workId) waiter.resolve();
    }
  }

  async wait(input: Readonly<{
    workId: string;
    expectedSequence: number;
    waitMs: number;
    signal: AbortSignal;
    readSequence: () => number;
  }>): Promise<"changed" | "timeout"> {
    if (!Number.isInteger(input.waitMs) || input.waitMs < 0 || input.waitMs > 30_000) {
      throw new Error("Work event wait is outside the supported bound.");
    }
    if (input.waitMs === 0) return "timeout";
    if (this.#waiters.size >= this.#maximum) throw new WorkEventWaiterLimitError();
    if (input.signal.aborted) throw input.signal.reason;

    let settled = false;
    let resolveChange: (() => void) | undefined;
    const changed = new Promise<void>((resolve) => {
      resolveChange = resolve;
    });
    const waiter: Waiter = {
      workId: input.workId,
      resolve: () => {
        if (settled) return;
        settled = true;
        resolveChange?.();
      },
    };
    this.#waiters.add(waiter);
    try {
      if (input.readSequence() !== input.expectedSequence) return "changed";
      return await new Promise<"changed" | "timeout">((resolve, reject) => {
        let completed = false;
        const finish = (outcome: "changed" | "timeout") => {
          if (completed) return;
          completed = true;
          clearTimeout(timer);
          input.signal.removeEventListener("abort", onAbort);
          resolve(outcome);
        };
        const timer = setTimeout(() => finish("timeout"), input.waitMs);
        timer.unref();
        const onAbort = () => {
          if (completed) return;
          completed = true;
          clearTimeout(timer);
          input.signal.removeEventListener("abort", onAbort);
          reject(input.signal.reason);
        };
        input.signal.addEventListener("abort", onAbort, { once: true });
        void changed.then(() => finish("changed"));
      });
    } finally {
      settled = true;
      this.#waiters.delete(waiter);
    }
  }
}
