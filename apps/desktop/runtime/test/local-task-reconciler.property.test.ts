import { expect, test } from "bun:test";
import { assertAsyncProperty, fc } from "@hra-internal/test";

import {
  LocalTaskReconciler,
  localTaskReconcilerMaximumBatch,
  type LocalTaskDueWork,
  type LocalTaskDueWorkPort,
} from "../src/tasks/reconciler";

type Row = {
  -readonly [Key in keyof LocalTaskDueWork]: LocalTaskDueWork[Key];
} & {
  notBeforeAt: number;
  state: "pending" | "claimed" | "done";
};

class PropertyDueWork implements LocalTaskDueWorkPort {
  readonly rows: Row[] = [];
  readonly limits: number[] = [];
  readonly batchSizes: number[] = [];
  generation = 1;

  beginBoot(): number {
    return this.generation;
  }

  closeBoot(): void {}

  enqueue(input: Parameters<LocalTaskDueWorkPort["enqueue"]>[0]): void {
    const existing = this.rows.find((row) =>
      row.workspaceId === input.workspaceId &&
      row.kind === input.kind &&
      row.entityId === input.entityId
    );
    if (existing !== undefined) {
      existing.dueAt = input.dueAt;
      existing.notBeforeAt = input.dueAt;
      existing.expectedRevision = input.expectedRevision ?? null;
      existing.expectedFence = input.expectedFence ?? null;
      existing.state = "pending";
      existing.attempt = 0;
      existing.workGeneration += 1;
      return;
    }
    this.rows.push({
      id: `due-${String(this.rows.length)}`,
      workspaceId: input.workspaceId,
      kind: input.kind,
      entityId: input.entityId,
      dueAt: input.dueAt,
      notBeforeAt: input.dueAt,
      expectedRevision: input.expectedRevision ?? null,
      expectedFence: input.expectedFence ?? null,
      attempt: 0,
      workGeneration: 0,
      claimedBootGeneration: 0,
      state: "pending",
    });
  }

  claimDue(input: Parameters<LocalTaskDueWorkPort["claimDue"]>[0]): LocalTaskDueWork[] {
    this.limits.push(input.limit);
    const claimed = this.rows
      .filter(({ state, notBeforeAt }) =>
        state === "pending" && notBeforeAt <= input.now)
      .slice(0, input.limit);
    this.batchSizes.push(claimed.length);
    return claimed.map((row) => {
      row.state = "claimed";
      row.attempt += 1;
      row.workGeneration += 1;
      row.claimedBootGeneration = input.bootGeneration;
      return { ...row };
    });
  }

  complete(input: Parameters<LocalTaskDueWorkPort["complete"]>[0]): boolean {
    const row = this.claimed(input.id, input.bootGeneration, input.workGeneration);
    if (row === null) return false;
    row.state = "done";
    return true;
  }

  retry(input: Parameters<LocalTaskDueWorkPort["retry"]>[0]): boolean {
    const row = this.claimed(input.id, input.bootGeneration, input.workGeneration);
    if (row === null) return false;
    row.state = "pending";
    row.notBeforeAt = input.nextDueAt;
    return true;
  }

  release(input: Parameters<LocalTaskDueWorkPort["release"]>[0]): boolean {
    const row = this.claimed(input.id, input.bootGeneration, input.workGeneration);
    if (row === null) return false;
    row.state = "pending";
    return true;
  }

  cancel(input: Parameters<LocalTaskDueWorkPort["cancel"]>[0]): boolean {
    const row = this.claimed(
      input.id,
      input.bootGeneration,
      input.workGeneration,
    );
    if (row === null) return false;
    row.state = "done";
    return true;
  }

  claimed(id: string, generation: number, workGeneration: number): Row | null {
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

type WakeBurstObservation = Readonly<{
  dueWork: PropertyDueWork;
  duplicateExecutions: number;
  maximumActive: number;
  pendingBeforeFinalDrain: number;
  finalDrainPasses: number;
  finalDrainBatchSizes: readonly number[];
}>;

async function exerciseWakeBurst(
  initialCount: number,
  wakeCount: number,
  duplicateCount: number,
): Promise<WakeBurstObservation> {
  const dueWork = new PropertyDueWork();
  for (let index = 0; index < initialCount; index += 1) {
    dueWork.enqueue({
      workspaceId: "wsp_property",
      kind: "repair",
      entityId: `initial-${String(index)}`,
      dueAt: 100,
      now: 1,
    });
  }
  const clock = { wall: 100, monotonic: 100 };
  let active = 0;
  let maximumActive = 0;
  let duplicateExecutions = 0;
  const reconciler = new LocalTaskReconciler({
    installationId: "installation_property",
    bootId: "boot_property",
    dueWork,
    clock: {
      wallNow: () => clock.wall,
      monotonicNow: () => clock.monotonic,
    },
    scheduler: { schedule: () => () => undefined },
    handlers: {
      deferWake: run,
      startQueuedRun: run,
      expireClaim: run,
      recoverStartedRun: run,
      expireInteraction: run,
      repair: run,
    },
  });

  async function run(work: LocalTaskDueWork, context: {
    readonly bootGeneration: number;
    readonly wallNow: number;
  }) {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await Promise.resolve();
    if (work.entityId === "dedupe") duplicateExecutions += 1;
    active -= 1;
    return {
      outcome: "completed" as const,
      authority: {
        kind: "current" as const,
        bootGeneration: context.bootGeneration,
        deadlineCheckedAt: context.wallNow,
        revision: work.expectedRevision,
        fence: work.expectedFence,
      },
    };
  }

  try {
    await reconciler.start();
    for (let index = 0; index < wakeCount; index += 1) {
      reconciler.wake(index % 2 === 0 ? "explicit" : "host_wake");
    }
    await reconciler.drain();
    for (let index = 1; index <= duplicateCount; index += 1) {
      reconciler.enqueue({
        workspaceId: "wsp_property",
        kind: "repair",
        entityId: "dedupe",
        dueAt: 1_000,
        expectedRevision: index,
      });
    }
    await reconciler.drain();

    clock.wall = 1_000;
    clock.monotonic = 1_000;
    const pendingBeforeFinalDrain = dueWork.rows.filter(({ notBeforeAt, state }) =>
      state === "pending" && notBeforeAt <= clock.wall).length;
    const finalDrainPasses = Math.ceil(
      pendingBeforeFinalDrain / localTaskReconcilerMaximumBatch,
    );
    const batchCountBeforeFinalDrain = dueWork.batchSizes.length;
    for (let index = 0; index < finalDrainPasses; index += 1) {
      reconciler.wake(index % 2 === 0 ? "explicit" : "host_wake");
      await reconciler.drain();
    }

    return {
      dueWork,
      duplicateExecutions,
      maximumActive,
      pendingBeforeFinalDrain,
      finalDrainPasses,
      finalDrainBatchSizes: dueWork.batchSizes.slice(batchCountBeforeFinalDrain),
    };
  } finally {
    await reconciler.stop();
  }
}

function expectWakeBurstInvariants(
  observation: WakeBurstObservation,
  duplicateCount: number,
): void {
  expect(observation.maximumActive).toBeLessThanOrEqual(1);
  expect(observation.dueWork.limits.every((limit) =>
    limit === localTaskReconcilerMaximumBatch)).toBeTrue();
  expect(observation.dueWork.batchSizes.every((size) =>
    size <= localTaskReconcilerMaximumBatch)).toBeTrue();
  expect(observation.finalDrainBatchSizes).toHaveLength(
    observation.finalDrainPasses,
  );
  expect(observation.finalDrainBatchSizes.reduce((sum, size) => sum + size, 0))
    .toBe(observation.pendingBeforeFinalDrain);
  expect(observation.dueWork.rows.filter(({ entityId }) =>
    entityId === "dedupe")).toHaveLength(1);
  expect(observation.duplicateExecutions).toBe(1);
  expect(
    observation.dueWork.rows.find(({ entityId }) => entityId === "dedupe")
      ?.expectedRevision,
  ).toBe(duplicateCount);
}

test("drains a full bounded backlog before executing a deduplicated row", async () => {
  const observation = await exerciseWakeBurst(96, 0, 1);

  expect(observation.finalDrainBatchSizes).toEqual([32, 1]);
  expectWakeBurstInvariants(observation, 1);
});

test("arbitrary wake bursts stay serialized, bounded, and deduplicated", async () => {
  await assertAsyncProperty(fc.asyncProperty(
    fc.integer({ min: 0, max: 96 }),
    fc.integer({ min: 0, max: 48 }),
    fc.integer({ min: 1, max: 64 }),
    async (initialCount, wakeCount, duplicateCount) => {
      const observation = await exerciseWakeBurst(
        initialCount,
        wakeCount,
        duplicateCount,
      );
      expectWakeBurstInvariants(observation, duplicateCount);
    },
  ), { numRuns: 100 });
});
