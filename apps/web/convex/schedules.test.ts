import { describe, expect, test } from "bun:test";

import {
  nextSweepArgs,
  overdueClaimSweepDisposition,
  scheduledWakeDispatchDisposition,
  scheduledWakeTupleMatches,
} from "./schedules";

const validWakeTuple = {
  scheduledTaskId: "task_a",
  loadedTaskId: "task_a",
  taskOrganizationId: "organization_a",
  taskWorkspaceId: "workspace_a",
  wakeTaskId: "task_a",
  wakeOrganizationId: "organization_a",
  wakeWorkspaceId: "workspace_a",
  scheduledGeneration: 7,
  wakeGeneration: 7,
  scheduledDeadline: 42_000,
  wakeDeadline: 42_000,
} as const;

const validWakeTask = {
  id: "task_a",
  organizationId: "organization_a",
  workspaceId: "workspace_a",
  key: "OPS-123",
  revision: 7,
  claimFence: 3,
} as const;

const validWakeDispatch = {
  organizationId: validWakeTask.organizationId,
  workspaceId: validWakeTask.workspaceId,
  taskId: validWakeTask.id,
  taskKey: validWakeTask.key,
  phase: "queued",
  queuedTaskRevision: validWakeTask.revision,
  queuedClaimFence: validWakeTask.claimFence,
} as const;

describe("scheduled wake ownership", () => {
  test("accepts only the exact task, tenant, generation, and deadline tuple", () => {
    expect(scheduledWakeTupleMatches(validWakeTuple)).toBeTrue();
    const mismatches = [
      { loadedTaskId: "task_b" },
      { wakeTaskId: "task_b" },
      { wakeOrganizationId: "organization_b" },
      { wakeWorkspaceId: "workspace_b" },
      { wakeGeneration: 8 },
      { wakeDeadline: 43_000 },
    ] as const;
    for (const mismatch of mismatches) {
      expect(scheduledWakeTupleMatches({ ...validWakeTuple, ...mismatch })).toBeFalse();
    }
  });

  test("a scheduled task locator cannot stale a foreign tenant wake", () => {
    expect(
      scheduledWakeTupleMatches({
        ...validWakeTuple,
        scheduledTaskId: "foreign_task",
        loadedTaskId: "foreign_task",
      }),
    ).toBeFalse();
  });

  test("advances only one exact queued dispatch with the task wake", () => {
    expect(scheduledWakeDispatchDisposition({
      queuedDispatchCount: 0,
      task: validWakeTask,
    })).toBe("none");
    expect(scheduledWakeDispatchDisposition({
      queuedDispatchCount: 1,
      task: validWakeTask,
      queuedDispatch: validWakeDispatch,
    })).toBe("advance");
    for (const queuedDispatch of [
      { ...validWakeDispatch, organizationId: "organization_b" },
      { ...validWakeDispatch, workspaceId: "workspace_b" },
      { ...validWakeDispatch, taskId: "task_b" },
      { ...validWakeDispatch, taskKey: "OPS-999" },
      { ...validWakeDispatch, phase: "leased" },
      { ...validWakeDispatch, queuedTaskRevision: validWakeTask.revision - 1 },
      { ...validWakeDispatch, queuedClaimFence: validWakeTask.claimFence + 1 },
    ] as const) {
      expect(scheduledWakeDispatchDisposition({
        queuedDispatchCount: 1,
        task: validWakeTask,
        queuedDispatch,
      })).toBe("invalid");
    }
    expect(scheduledWakeDispatchDisposition({
      queuedDispatchCount: 2,
      task: validWakeTask,
      queuedDispatch: validWakeDispatch,
    })).toBe("invalid");
  });
});

describe("bounded sweep continuation", () => {
  test("restarts from the index head after a nonterminal page", () => {
    expect(nextSweepArgs(false)).toEqual({});
    expect(nextSweepArgs(true)).toBeNull();
  });
});

describe("protected dispatch claim sweeping", () => {
  test("suppresses a protected claim once and never expires it generically", () => {
    expect(overdueClaimSweepDisposition({
      dispatchGuardKind: "clear",
      sweepSuppressed: undefined,
    })).toBe("expire");
    for (const dispatchGuardKind of ["blocked", "projection_mismatch"] as const) {
      expect(overdueClaimSweepDisposition({
        dispatchGuardKind,
        sweepSuppressed: undefined,
      })).toBe("suppress");
      expect(overdueClaimSweepDisposition({
        dispatchGuardKind,
        sweepSuppressed: true,
      })).toBe("protected");
    }
  });
});
