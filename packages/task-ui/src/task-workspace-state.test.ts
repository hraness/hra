import { describe, expect, test } from "bun:test";
import {
  taskWorkspaceDetailCollectionValues,
  taskWorkspaceRecoveryKindValues,
  taskWorkspaceViewValues,
} from "@hraness/agent-tasks-domain";

import {
  expiredClaimTaskDetailFixture,
  reviewTaskDetailFixture,
  taskWorkspaceFixtureNow,
} from "./task-workspace-fixtures";
import {
  actorLabel,
  detailRecoveryKinds,
  effectiveRunnerPresence,
  initialTaskWorkspaceUiState,
  safeHttpsUrl,
  taskWorkspaceDetailCollections,
  taskWorkspaceRecoveryKinds,
  taskWorkspaceRecoveryGuidance,
  taskWorkspaceReducer,
  taskWorkspaceViews,
} from "./task-workspace-state";

test("shared UI literals are the authoritative domain values", () => {
  expect(taskWorkspaceViews).toBe(taskWorkspaceViewValues);
  expect(taskWorkspaceDetailCollections).toBe(taskWorkspaceDetailCollectionValues);
  expect(taskWorkspaceRecoveryKinds).toBe(taskWorkspaceRecoveryKindValues);
});

describe("shared taskWorkspaceReducer", () => {
  test("retains an editor after a rejected command and closes it after success", () => {
    const editing = taskWorkspaceReducer(initialTaskWorkspaceUiState, {
      taskKey: "AT-12AB3CD",
      type: "composer.edit",
    });
    const pending = taskWorkspaceReducer(editing, {
      id: 1,
      label: "Update task",
      type: "operation.started",
    });
    const failed = taskWorkspaceReducer(pending, {
      id: 1,
      result: { error: { code: "TASK_STATE_CONFLICT", reference: "req_conflict" }, ok: false },
      type: "operation.finished",
    });

    expect(failed.composer).toEqual({ kind: "edit", taskKey: "AT-12AB3CD" });
    expect(failed.notice).toEqual({
      error: { code: "TASK_STATE_CONFLICT", reference: "req_conflict" },
      kind: "error",
    });

    const retried = taskWorkspaceReducer(failed, {
      id: 2,
      label: "Update task",
      type: "operation.started",
    });
    const succeeded = taskWorkspaceReducer(retried, {
      id: 2,
      result: { ok: true, requestId: "req_success" },
      type: "operation.finished",
    });
    expect(succeeded.composer).toBeNull();
    expect(succeeded.notice).toEqual({ kind: "success", requestId: "req_success" });
  });

  test("ignores stale completions from an older operation", () => {
    const first = taskWorkspaceReducer(initialTaskWorkspaceUiState, {
      id: 1,
      label: "First",
      type: "operation.started",
    });
    const second = taskWorkspaceReducer(first, {
      id: 2,
      label: "Second",
      type: "operation.started",
    });
    const stale = taskWorkspaceReducer(second, {
      id: 1,
      result: { ok: true, requestId: "req_stale" },
      type: "operation.finished",
    });

    expect(stale).toBe(second);
    expect(stale.pendingOperation).toEqual({ id: 2, label: "Second" });
  });

  test("does not replace an editor while a command is pending", () => {
    const pending = taskWorkspaceReducer(initialTaskWorkspaceUiState, {
      id: 1,
      label: "Create task",
      type: "operation.started",
    });
    expect(taskWorkspaceReducer(pending, { type: "composer.create" })).toBe(pending);
    expect(
      taskWorkspaceReducer(pending, { taskKey: "AT-12AB3CD", type: "composer.edit" }),
    ).toBe(pending);
  });
});

describe("task recovery derivation", () => {
  test("combines explicit revocation with cancelled-blocker attention", () => {
    expect(detailRecoveryKinds(reviewTaskDetailFixture, taskWorkspaceFixtureNow)).toEqual([
      "access_revoked",
      "cancelled_blocker",
    ]);
  });

  test("detects an expired claim from the deterministic server time", () => {
    expect(detailRecoveryKinds(expiredClaimTaskDetailFixture, taskWorkspaceFixtureNow)).toEqual([
      "access_revoked",
      "claim_expired",
    ]);
  });

  test("derives retained-history guidance for a cancelled task", () => {
    const cancelled = {
      ...reviewTaskDetailFixture,
      recoveries: [],
      task: { ...reviewTaskDetailFixture.task, status: "cancelled" as const },
    };
    expect(detailRecoveryKinds(cancelled, taskWorkspaceFixtureNow)).toEqual([
      "task_cancelled",
      "cancelled_blocker",
    ]);
    expect(taskWorkspaceRecoveryGuidance.task_cancelled.body).toContain("remain auditable");
  });

  test("keeps rejected evidence immutable in its recovery language", () => {
    expect(taskWorkspaceRecoveryGuidance.submission_rejected.body).toContain("stay immutable");
    expect(taskWorkspaceRecoveryGuidance.submission_rejected.body).toContain("new submission");
  });
});

describe("safe presentation boundaries", () => {
  test("expires a stale runner lease locally without waiting for another subscription", () => {
    const ready = {
      availableCapacity: 1,
      leaseUntil: taskWorkspaceFixtureNow + 45_000,
      serverTime: taskWorkspaceFixtureNow,
      state: "ready",
    } as const;
    expect(effectiveRunnerPresence(ready, taskWorkspaceFixtureNow + 44_999)).toBe(ready);
    expect(effectiveRunnerPresence(ready, taskWorkspaceFixtureNow + 45_000)).toEqual({
      serverTime: taskWorkspaceFixtureNow + 45_000,
      state: "offline",
    });
  });

  test("visually distinguishes human, agent, and system actors", () => {
    expect(actorLabel({ id: "human", kind: "human", name: "Ada" })).toBe("Human · Ada");
    expect(actorLabel({ id: "agent", kind: "agent", name: "Scout", status: "active" })).toBe(
      "Agent · Scout",
    );
    expect(actorLabel({ id: "system", jobKind: "claim_expiry", kind: "system" })).toBe(
      "System · claim expiry",
    );
  });

  test("renders only bounded HTTPS external links", () => {
    expect(safeHttpsUrl("https://example.com/work?q=1")).toBe("https://example.com/work?q=1");
    expect(safeHttpsUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpsUrl("http://example.com")).toBeNull();
    expect(safeHttpsUrl("https://user:secret@example.com/work")).toBeNull();
    expect(safeHttpsUrl("not a URL")).toBeNull();
  });
});
