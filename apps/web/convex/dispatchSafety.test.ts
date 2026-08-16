import { describe, expect, test } from "bun:test";

import {
  requireProjectionAfterProtectedWrite,
  taskDispatchGuardFromRows,
} from "./dispatchSafety";

const task = {
  taskId: "task_a",
  organizationId: "organization_a",
  workspaceId: "workspace_a",
};

describe("task dispatch mutation and claim-release guard", () => {
  test("is clear only when no dispatch may still own local effects", () => {
    expect(taskDispatchGuardFromRows(task, [])).toEqual({ kind: "clear" });
    expect(
      taskDispatchGuardFromRows(task, [{ ...task, phase: "queued" }]),
    ).toEqual({ kind: "blocked" });
    expect(
      taskDispatchGuardFromRows(task, [{ ...task, phase: "running" }]),
    ).toEqual({ kind: "blocked" });
    expect(
      taskDispatchGuardFromRows(task, [{ ...task, phase: "ambiguous" }]),
    ).toEqual({ kind: "blocked" });
  });

  test("a corrupt blocker tuple fails closed instead of disappearing", () => {
    expect(
      taskDispatchGuardFromRows(task, [
        { ...task, phase: "running" },
        { ...task, organizationId: "organization_foreign", phase: "ambiguous" },
      ]),
    ).toEqual({ kind: "projection_mismatch" });
  });

  test("proved terminal rows are not accepted as blockers by the bounded query policy", () => {
    expect(
      taskDispatchGuardFromRows(task, [{ ...task, phase: "submitted" }]),
    ).toEqual({ kind: "projection_mismatch" });
  });
});

describe("post-write projection safety", () => {
  test("returns a present projection without changing its identity", () => {
    const projection = { runId: "run_a" };
    expect(requireProjectionAfterProtectedWrite(projection, "claimDispatch")).toBe(projection);
  });

  test("throws on missing projections so Convex rolls back the write prefix", () => {
    for (const missing of [null, undefined] as const) {
      expect(() => requireProjectionAfterProtectedWrite(missing, "claimDispatch")).toThrow(
        "claimDispatch projection is invalid after a protected write.",
      );
    }
  });
});
