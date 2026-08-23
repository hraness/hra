import type { SessionId } from "../domain/values";

type Waiter = {
  readonly sessionId: SessionId;
  readonly resolve: () => void;
};

export class SessionEventWaiterLimitError extends Error {
  constructor() {
    super("The daemon already has the maximum number of session event waiters.");
    this.name = "SessionEventWaiterLimitError";
  }
}

export class SessionEventWaiters {
  readonly #maximum: number;
  readonly #waiters = new Set<Waiter>();

  constructor(maximum = 16) {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 16) {
      throw new Error("Session event waiter capacity must be an integer from 1 through 16.");
    }
    this.#maximum = maximum;
  }

  get size(): number {
    return this.#waiters.size;
  }

  notify(sessionId: SessionId): void {
    for (const waiter of [...this.#waiters]) {
      if (waiter.sessionId === sessionId) waiter.resolve();
    }
  }

  async wait(input: {
    sessionId: SessionId;
    expectedObservedThrough: number;
    waitMs: number;
    signal: AbortSignal;
    readObservedThrough: () => number;
  }): Promise<"changed" | "timeout"> {
    if (!Number.isInteger(input.waitMs) || input.waitMs < 0 || input.waitMs > 30_000) {
      throw new Error("Session event wait is outside the supported bound.");
    }
    if (input.waitMs === 0) return "timeout";
    if (this.#waiters.size >= this.#maximum) throw new SessionEventWaiterLimitError();
    if (input.signal.aborted) throw input.signal.reason;

    let resolved = false;
    let resolveWait: (() => void) | undefined;
    const changed = new Promise<void>((resolve) => {
      resolveWait = resolve;
    });
    const waiter: Waiter = {
      sessionId: input.sessionId,
      resolve: () => {
        if (resolved) return;
        resolved = true;
        resolveWait?.();
      },
    };
    this.#waiters.add(waiter);
    try {
      if (input.readObservedThrough() !== input.expectedObservedThrough) return "changed";
      const outcome = await new Promise<"changed" | "timeout">((resolve, reject) => {
        const timer = setTimeout(() => resolve("timeout"), input.waitMs);
        timer.unref();
        const onAbort = () => reject(input.signal.reason);
        input.signal.addEventListener("abort", onAbort, { once: true });
        void changed.then(() => resolve("changed")).finally(() => {
          clearTimeout(timer);
          input.signal.removeEventListener("abort", onAbort);
        });
      });
      return outcome;
    } finally {
      resolved = true;
      this.#waiters.delete(waiter);
    }
  }
}
