import { describe, expect, test } from "bun:test";

import {
  runEventBatchAffectsTaskListContinuation,
  runEventBatchProjectionImpact,
} from "./dispatch";

const TASK_ID = "tsk_00000000000000000000000000";
const RUN_ID = "run_00000000000000000000000000";

describe("run event task-list continuation impact", () => {
  test("preserves task-list continuation for same-phase text deltas", () => {
    expect(runEventBatchAffectsTaskListContinuation(
      "running",
      "running",
    )).toBeFalse();
  });

  test("preserves task-list continuation for same-phase status events", () => {
    expect(runEventBatchAffectsTaskListContinuation(
      "running",
      "running",
    )).toBeFalse();
  });

  test("treats a phase transition as list-affecting even with text", () => {
    expect(runEventBatchAffectsTaskListContinuation(
      "starting",
      "running",
    )).toBeTrue();
  });

  test("classifies same-phase display as a patchable run change", () => {
    expect(runEventBatchProjectionImpact({
      before: "running",
      after: "running",
      taskPublicId: TASK_ID,
      runPublicId: RUN_ID,
    })).toEqual({
      scope: "run",
      taskPublicId: TASK_ID,
      runPublicId: RUN_ID,
      views: [
        "all",
        "ready",
        "blocked",
        "deferred",
        "attention",
        "assigned",
        "review",
      ],
      structure: false,
    });
  });

  test("classifies a phase transition as structural run change", () => {
    expect(runEventBatchProjectionImpact({
      before: "running",
      after: "submitted",
      taskPublicId: TASK_ID,
      runPublicId: RUN_ID,
    })).toMatchObject({ scope: "run", structure: true });
  });
});
