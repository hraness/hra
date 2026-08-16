import { describe, expect, test } from "bun:test";

import { submittedTaskClaimMatchesDispatch } from "./dispatchReconciliation";

const dispatch = {
  organizationId: "organization-primary",
  workspaceId: "workspace-primary",
  taskId: "task-primary",
  taskClaimPublicId: "claim-primary",
  claimFence: 7,
  leaseGeneration: 3,
} as const;

const task = {
  _id: "task-primary",
  organizationId: "organization-primary",
  workspaceId: "workspace-primary",
  status: "in_review",
} as const;

const claim = {
  organizationId: "organization-primary",
  workspaceId: "workspace-primary",
  taskId: "task-primary",
  publicId: "claim-primary",
  fence: 7,
  leaseGeneration: 3,
  state: "submitted",
} as const;

describe("dispatch submission reconciliation", () => {
  test("recognizes only the exact task/claim completion window", () => {
    expect(submittedTaskClaimMatchesDispatch(dispatch, task, claim)).toBeTrue();
    expect(submittedTaskClaimMatchesDispatch(dispatch, { ...task, status: "in_progress" }, claim))
      .toBeFalse();
    expect(submittedTaskClaimMatchesDispatch(
      dispatch,
      { ...task, currentClaim: { fence: 7 } },
      claim,
    )).toBeFalse();
    expect(submittedTaskClaimMatchesDispatch(dispatch, task, { ...claim, state: "active" }))
      .toBeFalse();
  });

  test("any tenant, task, claim, or fence mismatch fails closed", () => {
    expect(submittedTaskClaimMatchesDispatch(
      { ...dispatch, organizationId: "organization-foreign" },
      task,
      claim,
    )).toBeFalse();
    expect(submittedTaskClaimMatchesDispatch(
      { ...dispatch, workspaceId: "workspace-foreign" },
      task,
      claim,
    )).toBeFalse();
    expect(submittedTaskClaimMatchesDispatch(
      { ...dispatch, taskId: "task-foreign" },
      task,
      claim,
    )).toBeFalse();
    expect(submittedTaskClaimMatchesDispatch(
      { ...dispatch, taskClaimPublicId: "claim-foreign" },
      task,
      claim,
    )).toBeFalse();
    expect(submittedTaskClaimMatchesDispatch(
      { ...dispatch, claimFence: 8 },
      task,
      claim,
    )).toBeFalse();
    expect(submittedTaskClaimMatchesDispatch(
      { ...dispatch, leaseGeneration: 4 },
      task,
      claim,
    )).toBeFalse();
  });
});
