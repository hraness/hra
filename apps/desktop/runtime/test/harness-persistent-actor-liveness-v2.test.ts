import { describe, expect, test } from "bun:test";

import {
  PersistentActorLivenessPumpV2,
  PersistentActorLivenessPumpV2Error,
  type PersistentActorLivenessSchedulerV2,
  type PersistentActorLifecycleRoutePortV2,
  type PersistentActorProjectionRefreshPortV2,
  type PersistentActorReconciliationRequestV2,
  type PersistentActorReconciliationPortV2,
} from "../src/harness/persistent-actor-liveness-v2";
import type { SessionTurnLifecycle } from "../src/sessions/session-service";

const cleanReconciliation = Object.freeze({
  inspectedOperations: 0,
  inspectedAttempts: 0,
  inspectedTurns: 0,
  pending: 0,
  fenced: 0,
});

const changedReconciliation = Object.freeze({
  ...cleanReconciliation,
  inspectedAttempts: 1,
});

function lifecycle(
  status: SessionTurnLifecycle["status"],
  turnId = "turn_owned_nested_liveness_01",
): SessionTurnLifecycle {
  return {
    accountProfileId: "acct_nested_liveness_01",
    threadId: "thread_owned_nested_liveness_01",
    turnId,
    status,
  };
}

function actorTarget(turnId: string): string {
  return `hactor_${turnId.slice("turn_owned_".length)}`;
}

class EventRoutes implements PersistentActorLifecycleRoutePortV2 {
  readonly calls: Array<Readonly<{
    accountProfileId: string;
    threadId: string;
    turnId: string;
  }>> = [];

  readHarnessActorChatEventRoute(input: Readonly<{
    accountProfileId: string;
    threadId: string;
    turnId: string;
  }>): Readonly<{ actorId: string }> | null {
    this.calls.push(input);
    return input.turnId.startsWith("turn_owned_")
      ? Object.freeze({ actorId: actorTarget(input.turnId) })
      : null;
  }
}

class Actors implements PersistentActorReconciliationPortV2 {
  readonly calls: PersistentActorReconciliationRequestV2[] = [];
  readonly deadlineSweeps: Array<Readonly<{ limit: number }>> = [];
  outcomes: Array<Promise<unknown>> = [];
  deadlineOutcomes: Array<Promise<unknown>> = [];

  reconcile(input: PersistentActorReconciliationRequestV2): Promise<unknown> {
    this.calls.push(input);
    return this.outcomes.shift() ?? Promise.resolve(cleanReconciliation);
  }

  sweepDeadlines(input: Readonly<{ limit: number }>): Promise<unknown> {
    this.deadlineSweeps.push(input);
    return this.deadlineOutcomes.shift() ?? Promise.resolve({ expired: 0 });
  }
}

class FakeScheduler implements PersistentActorLivenessSchedulerV2 {
  now = 0;
  #nextId = 1;
  readonly #timers = new Map<number, Readonly<{
    at: number;
    callback: () => void;
  }>>();

  monotonicNow(): number {
    return this.now;
  }

  schedule(callback: () => void, delayMilliseconds: number) {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#timers.set(id, Object.freeze({
      at: this.now + delayMilliseconds,
      callback,
    }));
    return Object.freeze({
      cancel: () => {
        this.#timers.delete(id);
      },
    });
  }

  advanceBy(milliseconds: number): void {
    const target = this.now + milliseconds;
    for (;;) {
      const next = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])
        .at(0);
      if (next === undefined) break;
      const [id, timer] = next;
      this.#timers.delete(id);
      this.now = timer.at;
      timer.callback();
    }
    this.now = target;
  }
}

class Projections implements PersistentActorProjectionRefreshPortV2 {
  calls = 0;
  outcomes: Array<Promise<unknown>> = [];

  reconcileAll(): Promise<unknown> {
    this.calls += 1;
    return this.outcomes.shift() ?? Promise.resolve([]);
  }
}

function fixture(options: Readonly<{
  lostCallbackAuditMilliseconds?: number;
}> = {}) {
  const actors = new Actors();
  const eventRoutes = new EventRoutes();
  const projections = new Projections();
  const scheduler = new FakeScheduler();
  return {
    actors,
    eventRoutes,
    projections,
    scheduler,
    pump: new PersistentActorLivenessPumpV2({
      actors,
      eventRoutes,
      projections,
      deadlinePollMilliseconds: 10,
      lostCallbackAuditMilliseconds:
        options.lostCallbackAuditMilliseconds ?? 40,
      scheduler,
    }),
  };
}

describe("PersistentActorLivenessPumpV2", () => {
  test("ignores active hints and coalesces synchronous terminal bursts", async () => {
    const value = fixture();
    value.pump.observe(lifecycle("inProgress"));
    await value.pump.drain();
    expect(value.actors.calls).toHaveLength(0);

    let release = (): void => undefined;
    value.actors.outcomes.push(new Promise<unknown>((resolve) => {
      release = () => resolve(changedReconciliation);
    }));
    expect(value.pump.observe(lifecycle("completed"))).toBeUndefined();
    value.pump.observe(lifecycle("failed", "turn_owned_nested_liveness_02"));
    value.pump.observe(lifecycle(
      "interrupted",
      "turn_owned_nested_liveness_03",
    ));
    await Promise.resolve();
    await Promise.resolve();
    expect(value.actors.calls).toEqual([{
      limit: 4_096,
      actorIds: [
        actorTarget("turn_owned_nested_liveness_01"),
        actorTarget("turn_owned_nested_liveness_02"),
        actorTarget("turn_owned_nested_liveness_03"),
      ],
    }]);
    expect(value.eventRoutes.calls).toEqual([
      lifecycle("completed"),
      lifecycle("failed", "turn_owned_nested_liveness_02"),
      lifecycle("interrupted", "turn_owned_nested_liveness_03"),
    ].map(({ accountProfileId, threadId, turnId }) => ({
      accountProfileId,
      threadId,
      turnId,
    })));
    expect(value.projections.calls).toBe(0);
    release();
    await value.pump.settled();
    expect(value.actors.calls).toHaveLength(1);
    expect(value.projections.calls).toBe(1);
  });

  test("sweeps durable deadlines before each reconciliation pass", async () => {
    const value = fixture();
    await value.pump.ensureCurrent({ turnIds: ["hturn_liveness_demand_01"] });
    expect(value.actors.deadlineSweeps).toEqual([{ limit: 4_096 }]);
    expect(value.actors.calls).toEqual([{
      limit: 4_096,
      turnIds: ["hturn_liveness_demand_01"],
    }]);
    await value.pump.close();
  });

  test("ignores a terminal gateway event that is not routed to a durable actor", async () => {
    const value = fixture();
    value.pump.observe(lifecycle("completed", "turn_unowned_root_chat_01"));
    await value.pump.settled();
    expect(value.eventRoutes.calls).toHaveLength(1);
    expect(value.actors.calls).toEqual([]);
    expect(value.projections.calls).toBe(0);
    await value.pump.close();
  });

  test("serializes a terminal hint received during reconciliation", async () => {
    const value = fixture();
    let release = (): void => undefined;
    value.actors.outcomes.push(
      new Promise<unknown>((resolve) => {
        release = () => resolve(changedReconciliation);
      }),
      Promise.resolve(changedReconciliation),
    );
    value.pump.observe(lifecycle("completed"));
    await Promise.resolve();
    await Promise.resolve();
    value.pump.observe(lifecycle("failed", "turn_owned_nested_liveness_02"));
    expect(value.actors.calls).toHaveLength(1);
    release();
    await value.pump.settled();
    expect(value.actors.calls).toEqual([
      {
        limit: 4_096,
        actorIds: [actorTarget("turn_owned_nested_liveness_01")],
      },
      {
        limit: 4_096,
        actorIds: [actorTarget("turn_owned_nested_liveness_02")],
      },
    ]);
    expect(value.projections.calls).toBe(2);
  });

  test("retains failures, skips refresh, and retries on later liveness demand", async () => {
    const value = fixture();
    const transient = new Error("provider reconciliation unavailable");
    value.actors.outcomes.push(
      Promise.reject(transient),
      Promise.resolve(changedReconciliation),
    );
    value.pump.observe(lifecycle("completed"));
    expect(await rejection(value.pump.settled())).toBe(transient);
    expect(value.projections.calls).toBe(0);
    await value.pump.ensureCurrent({ turnIds: ["hturn_liveness_retry_01"] });
    await value.pump.settled();
    expect(value.actors.calls).toEqual([
      {
        limit: 4_096,
        actorIds: [actorTarget("turn_owned_nested_liveness_01")],
      },
      {
        limit: 4_096,
        actorIds: [actorTarget("turn_owned_nested_liveness_01")],
        turnIds: ["hturn_liveness_retry_01"],
      },
    ]);
    expect(value.projections.calls).toBe(1);

    const refreshFailure = new Error("projection refresh unavailable");
    value.actors.outcomes.push(
      Promise.resolve(changedReconciliation),
      Promise.resolve(cleanReconciliation),
    );
    value.projections.outcomes.push(Promise.reject(refreshFailure));
    value.pump.observe(lifecycle("failed", "turn_owned_refresh_failure"));
    expect(await rejection(value.pump.settled())).toBe(refreshFailure);
    expect(value.actors.calls).toHaveLength(3);
    expect(value.projections.calls).toBe(2);
    await value.pump.ensureCurrent({ turnIds: ["hturn_refresh_retry_01"] });
    expect(value.projections.calls).toBe(3);
  });

  test("clean fake-clock ticks sweep deadlines without scanning actor witnesses or refreshing", async () => {
    const value = fixture({ lostCallbackAuditMilliseconds: 40 });

    for (let tick = 0; tick < 3; tick += 1) {
      value.scheduler.advanceBy(10);
      await value.pump.settled();
    }
    expect(value.actors.deadlineSweeps).toHaveLength(3);
    expect(value.actors.calls).toHaveLength(0);
    expect(value.projections.calls).toBe(0);

    value.scheduler.advanceBy(10);
    await value.pump.settled();
    expect(value.actors.deadlineSweeps).toHaveLength(4);
    expect(value.actors.calls).toHaveLength(1);
    expect(value.projections.calls).toBe(0);
    await value.pump.close();
  });

  test("an expired durable deadline reconciles and refreshes within its fake-clock poll", async () => {
    const value = fixture({ lostCallbackAuditMilliseconds: 100 });
    value.actors.deadlineOutcomes.push(Promise.resolve({ expired: 1 }));
    value.actors.outcomes.push(Promise.resolve(changedReconciliation));

    value.scheduler.advanceBy(10);
    await value.pump.settled();

    expect(value.actors.deadlineSweeps).toEqual([{ limit: 4_096 }]);
    expect(value.actors.calls).toEqual([{ limit: 4_096 }]);
    expect(value.projections.calls).toBe(1);
    await value.pump.close();
  });

  test("terminal hints converge immediately and a lost callback converges on the bounded audit tick", async () => {
    const value = fixture({ lostCallbackAuditMilliseconds: 40 });
    value.actors.outcomes.push(
      Promise.resolve(changedReconciliation),
      Promise.resolve(changedReconciliation),
    );

    value.pump.observe(lifecycle("completed"));
    await value.pump.settled();
    expect(value.actors.calls).toHaveLength(1);
    expect(value.projections.calls).toBe(1);

    for (let tick = 0; tick < 3; tick += 1) {
      value.scheduler.advanceBy(10);
      await value.pump.settled();
    }
    expect(value.actors.calls).toHaveLength(1);
    expect(value.projections.calls).toBe(1);

    value.scheduler.advanceBy(10);
    await value.pump.settled();
    expect(value.actors.calls).toHaveLength(2);
    expect(value.projections.calls).toBe(2);
    await value.pump.close();
  });

  test("bounds concurrent wait-loop demand scans by monotonic freshness, not waiter count", async () => {
    const scanCountFor = async (waiterCount: number): Promise<number> => {
      const value = fixture({ lostCallbackAuditMilliseconds: 30_000 });
      for (let elapsed = 0; elapsed <= 5_000; elapsed += 25) {
        value.scheduler.now = elapsed;
        await Promise.all(Array.from(
          { length: waiterCount },
          () => value.pump.ensureCurrent({
            turnIds: ["hturn_shared_poll_demand_01"],
          }),
        ));
      }
      const count = value.actors.calls.length;
      await value.pump.close();
      return count;
    };

    // 201 poll rounds create 10,050 liveness demands for 50 waiters, but the
    // shared provider reconciliation cost remains one pass per second.
    expect(await scanCountFor(1)).toBe(6);
    expect(await scanCountFor(50)).toBe(6);
  });

  test("concurrent wait demands join the admitted reconciliation pass", async () => {
    const value = fixture({ lostCallbackAuditMilliseconds: 30_000 });
    let release = (): void => undefined;
    value.actors.outcomes.push(new Promise<unknown>((resolve) => {
      release = () => resolve(cleanReconciliation);
    }));

    const admitted = value.pump.ensureCurrent({
      turnIds: ["hturn_joined_demand_01"],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(value.actors.calls).toHaveLength(1);
    const joined = Promise.all(Array.from(
      { length: 50 },
      () => value.pump.ensureCurrent({
        turnIds: ["hturn_joined_demand_01"],
      }),
    ));
    expect(value.actors.calls).toHaveLength(1);

    release();
    await Promise.all([admitted, joined]);
    await value.pump.settled();
    expect(value.actors.calls).toHaveLength(1);
    await value.pump.close();
  });

  test("terminal hints bypass demand freshness and reconcile promptly", async () => {
    const value = fixture({ lostCallbackAuditMilliseconds: 30_000 });
    await value.pump.ensureCurrent({
      turnIds: ["hturn_freshness_demand_01"],
    });
    expect(value.actors.calls).toHaveLength(1);

    value.scheduler.now = 25;
    await Promise.all(Array.from(
      { length: 50 },
      () => value.pump.ensureCurrent({
        turnIds: ["hturn_freshness_demand_01"],
      }),
    ));
    expect(value.actors.calls).toHaveLength(1);

    value.actors.outcomes.push(Promise.resolve(changedReconciliation));
    value.pump.observe(lifecycle("completed", "turn_owned_prompt_wake"));
    await value.pump.settled();
    expect(value.actors.calls).toHaveLength(2);
    expect(value.projections.calls).toBe(1);
    await value.pump.close();
  });

  test("one waiter among 114 actors targets one turn while the lost-callback audit stays global", async () => {
    const turnIds = Array.from(
      { length: 114 },
      (_, index) => `hturn_parallel_liveness_${String(index).padStart(3, "0")}`,
    );
    const selectedTurnId = turnIds[73]!;
    const value = fixture({ lostCallbackAuditMilliseconds: 40 });

    await value.pump.ensureCurrent({ turnIds: [selectedTurnId] });
    expect(value.actors.calls).toEqual([{
      limit: 4_096,
      turnIds: [selectedTurnId],
    }]);
    expect(value.actors.calls[0]?.turnIds).not.toContain(turnIds[0]);
    expect(value.actors.calls[0]?.turnIds).not.toContain(turnIds[113]);

    value.scheduler.advanceBy(40);
    await value.pump.settled();
    expect(value.actors.calls).toEqual([
      { limit: 4_096, turnIds: [selectedTurnId] },
      { limit: 4_096 },
    ]);
    await value.pump.close();
  });

  test("114 idle actors have a constant witness-refresh cost across repeated ticks", async () => {
    const actorCount = 114;
    let witnessScans = 0;
    const value = fixture({ lostCallbackAuditMilliseconds: 100 });
    value.projections.reconcileAll = () => {
      value.projections.calls += 1;
      witnessScans += actorCount;
      return Promise.resolve([]);
    };

    for (let tick = 0; tick < 100; tick += 1) {
      value.scheduler.advanceBy(10);
      await value.pump.settled();
    }

    expect(value.actors.deadlineSweeps).toHaveLength(100);
    expect(value.actors.calls).toHaveLength(10);
    expect(value.projections.calls).toBe(0);
    expect(witnessScans).toBe(0);
    await value.pump.close();
  });

  test("close drains admitted work and rejects later liveness requests", async () => {
    const value = fixture();
    let release = (): void => undefined;
    value.actors.outcomes.push(new Promise<unknown>((resolve) => {
      release = () => resolve(changedReconciliation);
    }));
    value.pump.observe(lifecycle("completed"));
    await Promise.resolve();
    const closing = value.pump.close();
    expect(value.pump.close()).toBe(closing);
    value.pump.observe(lifecycle("failed", "turn_owned_after_close"));
    release();
    await closing;
    expect(value.actors.calls).toHaveLength(1);
    expect(value.projections.calls).toBe(1);
    expect(await rejection(value.pump.ensureCurrent()))
      .toBeInstanceOf(PersistentActorLivenessPumpV2Error);
  });
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected promise to reject");
}
