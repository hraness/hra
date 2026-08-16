import { describe, expect, test } from "bun:test";

import {
  INITIAL_WORKSPACE_PROJECTION_REVISION,
  nextWorkspaceProjectionHeads,
  normalizeWorkspaceProjectionHeads,
} from "./hraProjection";

const TASK_ID = "tsk_00000000000000000000000000";
const RUN_ID = "run_00000000000000000000000000";

function revisions(value: number) {
  return {
    all: value,
    ready: value,
    blocked: value,
    deferred: value,
    attention: value,
    assigned: value,
    review: value,
  };
}

describe("workspace projection heads", () => {
  test("starts every task view at the positive shared initial revision", () => {
    expect(normalizeWorkspaceProjectionHeads(null)).toEqual({
      projectionRevision: INITIAL_WORKSPACE_PROJECTION_REVISION,
      taskViewRevisions: revisions(INITIAL_WORKSPACE_PROJECTION_REVISION),
    });
  });

  test("inherits a legacy row's list revision for every view", () => {
    expect(normalizeWorkspaceProjectionHeads({
      revision: 19,
      taskListRevision: 7,
    })).toEqual({
      projectionRevision: 19,
      taskViewRevisions: revisions(7),
    });
  });

  test("uses the global revision as a conservative legacy fallback", () => {
    expect(normalizeWorkspaceProjectionHeads({ revision: 19 })).toEqual({
      projectionRevision: 19,
      taskViewRevisions: revisions(19),
    });
  });

  test("advances every view watermark for a workspace fallback", () => {
    expect(nextWorkspaceProjectionHeads({
      revision: 19,
      taskViewRevisions: revisions(7),
    })).toEqual({
      projectionRevision: 20,
      taskViewRevisions: revisions(20),
    });
  });

  test("advances only structurally affected task views", () => {
    expect(nextWorkspaceProjectionHeads(
      { revision: 19, taskViewRevisions: revisions(7) },
      {
        scope: "task",
        taskPublicId: TASK_ID,
        views: ["ready", "assigned"],
        structure: true,
      },
    )).toEqual({
      projectionRevision: 20,
      taskViewRevisions: {
        ...revisions(7),
        ready: 20,
        assigned: 20,
      },
    });
  });

  test("keeps every continuation valid for a display-only run change", () => {
    expect(nextWorkspaceProjectionHeads(
      { revision: 19, taskViewRevisions: revisions(7) },
      {
        scope: "run",
        taskPublicId: TASK_ID,
        runPublicId: RUN_ID,
        views: ["all", "ready", "assigned"],
        structure: false,
      },
    )).toEqual({
      projectionRevision: 20,
      taskViewRevisions: revisions(7),
    });
  });

  test("materializes legacy view heads before a display-only advance", () => {
    expect(nextWorkspaceProjectionHeads(
      { revision: 19, taskListRevision: 7 },
      {
        scope: "run",
        taskPublicId: TASK_ID,
        runPublicId: RUN_ID,
        views: ["all"],
        structure: false,
      },
    )).toEqual({
      projectionRevision: 20,
      taskViewRevisions: revisions(7),
    });
  });

  test.each([
    { revision: 0 },
    { revision: 2, taskListRevision: 0 },
    { revision: 2, taskListRevision: 3 },
    { revision: 2, taskViewRevisions: { ...revisions(1), ready: 3 } },
    { revision: Number.MAX_SAFE_INTEGER },
  ])("fails closed for invalid or exhausted persisted heads: %o", (current) => {
    expect(() => nextWorkspaceProjectionHeads(current)).toThrow();
  });

  test("rejects malformed scoped invalidation metadata", () => {
    expect(() => nextWorkspaceProjectionHeads(
      { revision: 19, taskViewRevisions: revisions(7) },
      {
        scope: "task",
        taskPublicId: TASK_ID,
        views: ["ready", "ready"],
        structure: true,
      },
    )).toThrow("duplicate task views");
  });
});
