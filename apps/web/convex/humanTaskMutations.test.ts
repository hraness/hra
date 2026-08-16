import { describe, expect, test } from "bun:test";

import {
  acceptSubmission,
  addTaskComment,
  addTaskDependency,
  addTaskLabel,
  addTaskReference,
  assignTask,
  cancelTask,
  clearTaskParent,
  createTask,
  deferTask,
  humanTaskMutationDigest,
  humanTaskMutationRoleAllowed,
  rejectSubmission,
  removeTaskDependency,
  removeTaskLabel,
  removeTaskReference,
  reopenTask,
  setTaskParent,
  updateTask,
} from "./humanTaskMutations";

describe("human task mutation authorization", () => {
  test("owners and administrators may perform every human task command", () => {
    for (const role of ["owner", "admin"] as const) {
      expect(humanTaskMutationRoleAllowed(role, [], "planner")).toBeTrue();
      expect(humanTaskMutationRoleAllowed(role, [], "reviewer")).toBeTrue();
      expect(humanTaskMutationRoleAllowed(role, [], "comment")).toBeTrue();
      expect(humanTaskMutationRoleAllowed(role, [], "dispatch")).toBeTrue();
    }
  });

  test("workspace planners inherit the distinct cloud dispatch authority", () => {
    expect(humanTaskMutationRoleAllowed("member", ["planner"], "planner")).toBeTrue();
    expect(humanTaskMutationRoleAllowed("member", ["planner"], "reviewer")).toBeFalse();
    expect(humanTaskMutationRoleAllowed("member", ["planner"], "comment")).toBeTrue();
    expect(humanTaskMutationRoleAllowed("member", ["planner"], "dispatch")).toBeTrue();

    expect(humanTaskMutationRoleAllowed("member", ["reviewer"], "planner")).toBeFalse();
    expect(humanTaskMutationRoleAllowed("member", ["reviewer"], "reviewer")).toBeTrue();
    expect(humanTaskMutationRoleAllowed("member", ["reviewer"], "comment")).toBeTrue();
    expect(humanTaskMutationRoleAllowed("member", ["reviewer"], "dispatch")).toBeFalse();

    expect(humanTaskMutationRoleAllowed("member", ["viewer"], "planner")).toBeFalse();
    expect(humanTaskMutationRoleAllowed("member", ["viewer"], "reviewer")).toBeFalse();
    expect(humanTaskMutationRoleAllowed("member", ["viewer"], "comment")).toBeFalse();
    expect(humanTaskMutationRoleAllowed("member", ["viewer"], "dispatch")).toBeFalse();
    expect(humanTaskMutationRoleAllowed("member", [], "comment")).toBeFalse();
    expect(humanTaskMutationRoleAllowed("member", [], "dispatch")).toBeFalse();
  });
});

describe("human task idempotency digest", () => {
  test("is canonical across object insertion order and absent optional fields", () => {
    const left = humanTaskMutationDigest("tasks.update", {
      workspaceId: "wsp_A",
      key: "TASK-0000001",
      update: { title: "Changed", description: undefined, priority: 1 },
    });
    const right = humanTaskMutationDigest("tasks.update", {
      update: { priority: 1, title: "Changed" },
      key: "TASK-0000001",
      workspaceId: "wsp_A",
    });
    expect(left).toBe(right);
    expect(left).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  test("binds the operation, tenant, selector, and body", () => {
    const base = {
      workspaceId: "wsp_A",
      key: "TASK-0000001",
      revision: 3,
      label: "backend",
    };
    const digest = humanTaskMutationDigest("tasks.labels.add", base);
    expect(humanTaskMutationDigest("tasks.labels.remove", base)).not.toBe(digest);
    expect(humanTaskMutationDigest("tasks.labels.add", { ...base, workspaceId: "wsp_B" })).not.toBe(
      digest,
    );
    expect(humanTaskMutationDigest("tasks.labels.add", { ...base, key: "TASK-0000002" })).not.toBe(
      digest,
    );
    expect(humanTaskMutationDigest("tasks.labels.add", { ...base, revision: 4 })).not.toBe(digest);
  });
});

test("the public facade exposes the complete TaskWorkspaceActions mutation surface", () => {
  const functions = [
    createTask,
    updateTask,
    cancelTask,
    reopenTask,
    addTaskDependency,
    removeTaskDependency,
    addTaskLabel,
    removeTaskLabel,
    addTaskComment,
    addTaskReference,
    removeTaskReference,
    assignTask,
    deferTask,
    setTaskParent,
    clearTaskParent,
    acceptSubmission,
    rejectSubmission,
  ];
  expect(functions).toHaveLength(17);
  expect(functions.every((registered) => registered !== undefined)).toBeTrue();
});
