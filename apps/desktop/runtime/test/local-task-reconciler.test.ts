import { describe, expect, test } from "bun:test";

import {
  LocalTaskReconciler,
  localTaskReconcilerMaximumBatch,
  type LocalTaskDueWork,
  type LocalTaskDueWorkHandlerContext,
  type LocalTaskDueWorkHandlerResult,
  type LocalTaskDueWorkHandlers,
  type LocalTaskDueWorkKind,
  type LocalTaskDueWorkPort,
  type LocalTaskReconcilerClock,
  type LocalTaskReconcilerScheduler,
} from "../src/tasks/reconciler";

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

interface FakeRow extends Mutable<LocalTaskDueWork> {
  notBeforeAt: number;
  state: "pending" | "claimed" | "done" | "cancelled";
}

class FakeClock implements LocalTaskReconcilerClock {
  wall = 100;
  monotonic = 100;

  wallNow(): number {
    return this.wall;
  }

  monotonicNow(): number {
    return this.monotonic;
  }
}

class FakeScheduler implements LocalTaskReconcilerScheduler {
  callbacks: (() => void)[] = [];

  schedule(callback: () => void): () => void {
    this.callbacks.push(callback);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const index = this.callbacks.indexOf(callback);
      if (index >= 0) this.callbacks.splice(index, 1);
    };
  }

  fire(): void {
    const callbacks = this.callbacks.splice(0);
    for (const callback of callbacks) callback();
  }
}

class FakeDueWorkPort implements LocalTaskDueWorkPort {
  readonly rows: FakeRow[] = [];
  readonly claimLimits: number[] = [];
  readonly retries: {
    readonly id: string;
    readonly nextDueAt: number;
    readonly errorCode: string;
  }[] = [];
  readonly released: string[] = [];
  readonly cancelled: string[] = [];
  closed = false;
  generation = 1;
  beginCount = 0;
  beginError: Error | null = null;

  add(
    id: string,
    kind: LocalTaskDueWorkKind = "repair",
    overrides: Partial<LocalTaskDueWork> = {},
  ): FakeRow {
    const row: FakeRow = {
      id,
      workspaceId: "wsp_fixture",
      kind,
      entityId: id,
      dueAt: 100,
      notBeforeAt: overrides.dueAt ?? 100,
      expectedRevision: 1,
      expectedFence: 1,
      attempt: 0,
      workGeneration: 0,
      claimedBootGeneration: 0,
      state: "pending",
      ...overrides,
    };
    this.rows.push(row);
    return row;
  }

  beginBoot(): number {
    this.beginCount += 1;
    if (this.beginError !== null) throw this.beginError;
    for (const row of this.rows) {
      if (row.state === "claimed" && row.claimedBootGeneration !== this.generation) {
        row.state = "pending";
        row.claimedBootGeneration = 0;
      }
    }
    return this.generation;
  }

  closeBoot(): void {
    this.closed = true;
  }

  enqueue(input: Parameters<LocalTaskDueWorkPort["enqueue"]>[0]): void {
    const existing = this.rows.find((row) =>
      row.workspaceId === input.workspaceId &&
      row.kind === input.kind &&
      row.entityId === input.entityId
    );
    if (existing === undefined) {
      this.add(`due-${String(this.rows.length + 1)}`, input.kind, {
        workspaceId: input.workspaceId,
        entityId: input.entityId,
        dueAt: input.dueAt,
        expectedRevision: input.expectedRevision ?? null,
        expectedFence: input.expectedFence ?? null,
      });
      return;
    }
    existing.dueAt = input.dueAt;
    existing.notBeforeAt = input.dueAt;
    existing.expectedRevision = input.expectedRevision ?? null;
    existing.expectedFence = input.expectedFence ?? null;
    existing.state = "pending";
    existing.attempt = 0;
    existing.workGeneration += 1;
  }

  claimDue(
    input: Parameters<LocalTaskDueWorkPort["claimDue"]>[0],
  ): readonly LocalTaskDueWork[] {
    this.claimLimits.push(input.limit);
    return this.rows
      .filter((row) =>
        row.state === "pending" && row.notBeforeAt <= input.now)
      .slice(0, input.limit)
      .map((row) => {
        row.state = "claimed";
        row.claimedBootGeneration = input.bootGeneration;
        row.attempt += 1;
        row.workGeneration += 1;
        return { ...row };
      });
  }

  complete(input: Parameters<LocalTaskDueWorkPort["complete"]>[0]): boolean {
    const row = this.#claimed(
      input.id,
      input.bootGeneration,
      input.workGeneration,
    );
    if (row === null) return false;
    row.state = "done";
    return true;
  }

  retry(input: Parameters<LocalTaskDueWorkPort["retry"]>[0]): boolean {
    const row = this.#claimed(
      input.id,
      input.bootGeneration,
      input.workGeneration,
    );
    if (row === null) return false;
    row.state = "pending";
    row.notBeforeAt = input.nextDueAt;
    this.retries.push({
      id: input.id,
      nextDueAt: input.nextDueAt,
      errorCode: input.errorCode,
    });
    return true;
  }

  release(input: Parameters<LocalTaskDueWorkPort["release"]>[0]): boolean {
    const row = this.#claimed(
      input.id,
      input.bootGeneration,
      input.workGeneration,
    );
    if (row === null) return false;
    row.state = "pending";
    this.released.push(input.id);
    return true;
  }

  cancel(input: Parameters<LocalTaskDueWorkPort["cancel"]>[0]): boolean {
    const row = this.#claimed(
      input.id,
      input.bootGeneration,
      input.workGeneration,
    );
    if (row === null) return false;
    row.state = "cancelled";
    this.cancelled.push(input.id);
    return true;
  }

  #claimed(
    id: string,
    generation: number,
    workGeneration: number,
  ): FakeRow | null {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (
      row === undefined ||
      row.state !== "claimed" ||
      row.claimedBootGeneration !== generation ||
      row.workGeneration !== workGeneration
    ) {
      return null;
    }
    return row;
  }
}

function current(
  work: LocalTaskDueWork,
  context: LocalTaskDueWorkHandlerContext,
  outcome: "completed" | "retry" = "completed",
): LocalTaskDueWorkHandlerResult {
  const authority = {
    kind: "current" as const,
    bootGeneration: context.bootGeneration,
    deadlineCheckedAt: context.wallNow,
    revision: work.expectedRevision,
    fence: work.expectedFence,
  };
  return outcome === "completed"
    ? { outcome, authority }
    : { outcome, authority, errorCode: "transient" };
}

function handlers(
  handler: (
    work: LocalTaskDueWork,
    context: LocalTaskDueWorkHandlerContext,
  ) => LocalTaskDueWorkHandlerResult | Promise<LocalTaskDueWorkHandlerResult>,
  overrides: Partial<LocalTaskDueWorkHandlers> = {},
): LocalTaskDueWorkHandlers {
  return {
    deferWake: handler,
    startQueuedRun: handler,
    expireClaim: handler,
    recoverStartedRun: handler,
    expireInteraction: handler,
    repair: handler,
    ...overrides,
  };
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function fixture(
  dueWork: FakeDueWorkPort,
  taskHandlers: LocalTaskDueWorkHandlers,
): {
  readonly clock: FakeClock;
  readonly reconciler: LocalTaskReconciler;
  readonly scheduler: FakeScheduler;
} {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler();
  return {
    clock,
    scheduler,
    reconciler: new LocalTaskReconciler({
      installationId: "installation_fixture",
      bootId: "boot_fixture",
      dueWork,
      handlers: taskHandlers,
      clock,
      scheduler,
      timerMs: 1_000,
      sleepGapMs: 5_000,
      baseBackoffMs: 500,
      maximumBackoffMs: 60_000,
    }),
  };
}

describe("local task reconciler", () => {
  test("fences the boot synchronously before admitting bounded startup recovery", async () => {
    const dueWork = new FakeDueWorkPort();
    for (let index = 0; index < localTaskReconcilerMaximumBatch; index += 1) {
      dueWork.add(`delayed-${String(index)}`, "queued_run");
    }
    const entered = deferred();
    const release = deferred();
    const { reconciler } = fixture(dueWork, handlers(async (work, context) => {
      entered.resolve();
      await release.promise;
      return current(work, context);
    }));

    expect(reconciler.begin()).toBe(1);
    expect(reconciler.state).toBe("recovering");
    expect(dueWork.beginCount).toBe(1);
    expect(dueWork.claimLimits).toEqual([]);

    const readiness = reconciler.start();
    await entered.promise;

    expect(reconciler.state).toBe("recovering");
    expect(dueWork.claimLimits).toEqual([localTaskReconcilerMaximumBatch]);
    expect(dueWork.rows.filter(({ state }) => state === "claimed"))
      .toHaveLength(localTaskReconcilerMaximumBatch);
    expect(() => reconciler.enqueue({
      workspaceId: "wsp_fixture",
      kind: "repair",
      entityId: "must-wait-for-recovery",
      dueAt: 100,
    })).toThrow("not accepting work");

    release.resolve();
    await readiness;
    expect(reconciler.state).toBe("running");
    expect(dueWork.rows.every(({ state }) => state === "done")).toBeTrue();
    await reconciler.stop();
  });

  test("surfaces a boot-fencing fault synchronously", () => {
    const dueWork = new FakeDueWorkPort();
    dueWork.beginError = new Error("boot fence unavailable");
    const { reconciler } = fixture(
      dueWork,
      handlers((work, context) => current(work, context)),
    );

    expect(() => reconciler.start()).toThrow("boot fence unavailable");
    expect(reconciler.state).toBe("idle");
    expect(dueWork.beginCount).toBe(1);
  });

  test("runs one serialized pass of at most 32 records", async () => {
    const dueWork = new FakeDueWorkPort();
    for (let index = 0; index < 40; index += 1) {
      dueWork.add(`work-${String(index)}`);
    }
    let active = 0;
    let maximumActive = 0;
    const { reconciler } = fixture(dueWork, handlers(async (work, context) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return current(work, context);
    }));

    await reconciler.start();
    expect(dueWork.rows.filter(({ state }) => state === "done")).toHaveLength(32);
    reconciler.wake("explicit");
    await reconciler.drain();

    expect(dueWork.rows.every(({ state }) => state === "done")).toBeTrue();
    expect(dueWork.claimLimits).toEqual([
      localTaskReconcilerMaximumBatch,
      localTaskReconcilerMaximumBatch,
    ]);
    expect(maximumActive).toBe(1);
    await reconciler.stop();
  });

  test("coalesces wake bursts without concurrent handlers", async () => {
    const dueWork = new FakeDueWorkPort();
    dueWork.add("blocked");
    const entered = deferred();
    const release = deferred();
    let active = 0;
    let maximumActive = 0;
    const { reconciler } = fixture(dueWork, handlers(async (work, context) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      entered.resolve();
      await release.promise;
      active -= 1;
      return current(work, context);
    }));

    const starting = reconciler.start();
    await entered.promise;
    for (let index = 0; index < 25; index += 1) reconciler.wake("host_wake");
    release.resolve();
    await starting;
    await reconciler.drain();

    expect(maximumActive).toBe(1);
    expect(dueWork.claimLimits).toHaveLength(2);
    await reconciler.stop();
  });

  test("persists bounded exponential retry from the durable attempt count", async () => {
    const dueWork = new FakeDueWorkPort();
    dueWork.add("retry-me", "repair", { attempt: 2 });
    const { reconciler } = fixture(
      dueWork,
      handlers((work, context) => current(work, context, "retry")),
    );

    await reconciler.start();

    expect(dueWork.retries).toEqual([{
      id: "retry-me",
      nextDueAt: 2_100,
      errorCode: "transient",
    }]);
    await reconciler.stop();
  });

  test("does not double-settle a system command transaction", async () => {
    const dueWork = new FakeDueWorkPort();
    const row = dueWork.add("atomic-system-command");
    const { reconciler } = fixture(dueWork, handlers((work, context) => {
      row.state = "done";
      return {
        outcome: "settled",
        authority: {
          kind: "current",
          bootGeneration: context.bootGeneration,
          deadlineCheckedAt: context.wallNow,
          revision: work.expectedRevision,
          fence: work.expectedFence,
        },
      };
    }));

    await reconciler.start();

    expect(row.state).toBe("done");
    await reconciler.stop();
  });

  test("cancels stale fences and routes old started work only to recovery", async () => {
    const dueWork = new FakeDueWorkPort();
    dueWork.add("stale-start", "queued_run", { expectedFence: 5 });
    dueWork.add("ambiguous-start", "run_recovery", { expectedFence: 7 });
    let starts = 0;
    let recoveries = 0;
    const { reconciler } = fixture(dueWork, handlers(
      (work, context) => current(work, context),
      {
        startQueuedRun: () => {
          starts += 1;
          return {
            outcome: "obsolete",
            authority: { kind: "stale", reason: "fence" },
          };
        },
        recoverStartedRun: (work, context) => {
          recoveries += 1;
          return current(work, context);
        },
      },
    ));

    await reconciler.start();

    expect(starts).toBe(1);
    expect(recoveries).toBe(1);
    expect(dueWork.cancelled).toEqual(["stale-start"]);
    expect(dueWork.rows.find(({ id }) => id === "ambiguous-start")?.state).toBe("done");
    await reconciler.stop();
  });

  test("turns a wall-versus-monotonic jump into a large-clock-gap pass", async () => {
    const dueWork = new FakeDueWorkPort();
    const reasons: string[] = [];
    const { clock, reconciler, scheduler } = fixture(
      dueWork,
      handlers((work, context) => {
        reasons.push(context.wakeReason);
        return current(work, context);
      }),
    );
    await reconciler.start();
    dueWork.add("elapsed-while-asleep");
    clock.wall += 60_000;
    clock.monotonic += 1_000;

    scheduler.fire();
    await reconciler.drain();

    expect(reasons).toEqual(["large_clock_gap"]);
    await reconciler.stop();
  });

  test("reclaims a pre-side-effect crash but preserves its attempt count", async () => {
    const dueWork = new FakeDueWorkPort();
    dueWork.generation = 2;
    dueWork.add("crashed-claim", "queued_run", {
      attempt: 1,
      workGeneration: 1,
      claimedBootGeneration: 1,
    }).state = "claimed";
    const observedAttempts: number[] = [];
    const { reconciler } = fixture(dueWork, handlers((work, context) => {
      observedAttempts.push(work.attempt);
      return current(work, context);
    }));

    await reconciler.start();

    expect(observedAttempts).toEqual([2]);
    expect(dueWork.rows[0]?.state).toBe("done");
    await reconciler.stop();
  });

  test("drains the active handler, releases unstarted claims, and stops timers", async () => {
    const dueWork = new FakeDueWorkPort();
    dueWork.add("active");
    dueWork.add("not-started-one");
    dueWork.add("not-started-two");
    const entered = deferred();
    const release = deferred();
    let handled = 0;
    const { reconciler, scheduler } = fixture(
      dueWork,
      handlers(async (work, context) => {
        handled += 1;
        entered.resolve();
        await release.promise;
        return current(work, context);
      }),
    );
    const starting = reconciler.start();
    await entered.promise;

    let settledBeforeBootClose = false;
    const stopping = reconciler.stop(() => {
      expect(dueWork.closed).toBeFalse();
      expect(handled).toBe(1);
      expect(dueWork.released).toEqual([
        "not-started-one",
        "not-started-two",
      ]);
      settledBeforeBootClose = true;
    });
    release.resolve();
    await Promise.all([starting, stopping]);
    scheduler.fire();
    reconciler.wake("explicit");
    await reconciler.drain();

    expect(handled).toBe(1);
    expect(dueWork.released).toEqual(["not-started-one", "not-started-two"]);
    expect(settledBeforeBootClose).toBeTrue();
    expect(dueWork.closed).toBeTrue();
    expect(reconciler.state).toBe("stopped");
  });

  test("collapses repeated future enqueue hints to one durable semantic row", async () => {
    const dueWork = new FakeDueWorkPort();
    let handled = 0;
    const { clock, reconciler } = fixture(dueWork, handlers((work, context) => {
      handled += 1;
      return current(work, context);
    }));
    await reconciler.start();
    for (let index = 0; index < 20; index += 1) {
      reconciler.enqueue({
        workspaceId: "wsp_fixture",
        kind: "repair",
        entityId: "same-semantic-work",
        dueAt: 1_000,
        expectedRevision: index + 1,
      });
    }
    await reconciler.drain();
    expect(dueWork.rows).toHaveLength(1);

    clock.wall = 1_000;
    clock.monotonic = 1_000;
    reconciler.wake("explicit");
    await reconciler.drain();

    expect(handled).toBe(1);
    expect(dueWork.rows[0]?.expectedRevision).toBe(20);
    await reconciler.stop();
  });
});
