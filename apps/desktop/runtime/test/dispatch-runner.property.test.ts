import { expect, test } from "bun:test";
import { assertAsyncProperty, fc } from "@hra-internal/test";
import type {
  ClaimedDispatch,
  RunnerHeartbeatResponse,
} from "@hraness/agent-tasks-protocol";

import { DispatchLeaseRegistry } from "../src/dispatch/runner";

class PropertyClock {
  value = 0;
  now(): number { return this.value; }
}

const claimBase = {
  runId: "run_property0001",
  taskId: "task_property0001",
  taskKey: "OPS-0000001",
  taskTitle: "Property lease",
  taskDescription: "Exercise arbitrary lease windows.",
  repositoryId: `repo_${"0".repeat(26)}`,
  baseRef: "main",
  claimId: "claim_property001",
  claimFence: 1,
  inputReviewRevision: 1,
  leaseGeneration: 1,
} as const;

function response(
  serverTime: number,
  runnerDuration: number,
  runLeaseUntil?: number,
): RunnerHeartbeatResponse {
  return {
    serverTime,
    leaseUntil: serverTime + runnerDuration,
    desiredState: "active",
    candidates: [],
    runLeases: runLeaseUntil === undefined
      ? []
      : [{ runId: claimBase.runId, leaseUntil: runLeaseUntil }],
    stopRunIds: [],
    releaseRunIds: [],
  };
}

function tuple() {
  return {
    runId: claimBase.runId,
    claimId: claimBase.claimId,
    claimFence: claimBase.claimFence,
    runtimePublicId: "runner_property01",
    runtimeBootId: "boot_property0001",
  } as const;
}

test("local claim authority never outlives either arbitrary server deadline", async () => {
  await assertAsyncProperty(fc.asyncProperty(
    fc.integer({ min: 1_000, max: 1_000_000_000 }),
    fc.integer({ min: 1, max: 120_000 }),
    fc.integer({ min: 1, max: 120_000 }),
    fc.integer({ min: 0, max: 180_000 }),
    async (serverTime, runnerDuration, claimDuration, responseLatency) => {
      const clock = new PropertyClock();
      const authorityStartedAt = 10_000;
      clock.value = authorityStartedAt + responseLatency;
      const registry = new DispatchLeaseRegistry({
        clock,
        runtimePublicId: tuple().runtimePublicId,
        runtimeBootId: tuple().runtimeBootId,
      });
      registry.observeHeartbeat(response(serverTime, runnerDuration), authorityStartedAt, true);
      expect(registry.registerClaim({
        ...claimBase,
        leaseUntil: serverTime + claimDuration,
      } satisfies ClaimedDispatch)).toBe("new");

      const exactDeadline = authorityStartedAt + Math.min(runnerDuration, claimDuration);
      if (clock.value < exactDeadline) {
        clock.value = exactDeadline - 1;
        expect(await registry.assertCurrent(tuple())).toBeTrue();
      }
      clock.value = exactDeadline;
      expect(await registry.assertCurrent(tuple())).toBeFalse();
    },
  ));
});

test("an indeterminate heartbeat replay never extends arbitrary run authority", async () => {
  await assertAsyncProperty(fc.asyncProperty(
    fc.integer({ min: 2, max: 120_000 }),
    fc.integer({ min: 1, max: 60_000 }),
    async (initialDuration, elapsed) => {
      const clock = new PropertyClock();
      const serverTime = 1_000;
      const authorityStartedAt = 10_000;
      clock.value = authorityStartedAt;
      const registry = new DispatchLeaseRegistry({
        clock,
        runtimePublicId: tuple().runtimePublicId,
        runtimeBootId: tuple().runtimeBootId,
      });
      registry.observeHeartbeat(response(serverTime, initialDuration), authorityStartedAt, true);
      registry.registerClaim({
        ...claimBase,
        leaseUntil: serverTime + initialDuration,
      } satisfies ClaimedDispatch);

      clock.value = authorityStartedAt + Math.min(elapsed, initialDuration - 1);
      registry.observeHeartbeat(
        response(serverTime + elapsed, 120_000, serverTime + elapsed + 120_000),
        clock.value,
        false,
      );
      clock.value = authorityStartedAt + initialDuration;
      expect(await registry.assertCurrent(tuple())).toBeFalse();
    },
  ));
});
