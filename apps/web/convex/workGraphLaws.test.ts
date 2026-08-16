import { describe, expect, test } from "bun:test";

import {
  activeTaskClaimTupleMatches,
  agentGrantTupleMatches,
  blockerPropagationReadBound,
  dependencyTupleMatches,
  derivedReady,
  derivedNeedsAttention,
  isCredentialFreeHttpsUrl,
  parentTaskTupleMatches,
  reviewActorAllowed,
  taskMatchesAuthorizedScope,
  taskScopedRecordMatches,
  transitionSubmissionLifecycle,
  transitionBlockerCounters,
  validateDependencyInsertion,
  validateParentInsertion,
  MAX_BLOCKER_PROPAGATION_READS,
  MAX_BLOCKING_DEPENDENTS,
  MAX_DIRECT_BLOCKERS,
} from "./workGraphLaws";

function deterministic(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state ^ (state >>> 15), 2_246_822_519) + 3_266_489_917) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("dependency graph laws", () => {
  test("accepts forward DAG edges and rejects every generated back edge", () => {
    const random = deterministic(0x0da6da6);
    for (let example = 0; example < 100; example += 1) {
      const nodeCount = 3 + Math.floor(random() * 40);
      const adjacency = new Map<string, string[]>();
      for (let left = 0; left < nodeCount; left += 1) {
        for (let right = left + 1; right < nodeCount; right += 1) {
          if (random() < 0.08) {
            const dependents = adjacency.get(String(left)) ?? [];
            dependents.push(String(right));
            adjacency.set(String(left), dependents);
          }
        }
      }
      expect(validateDependencyInsertion(adjacency, "0", String(nodeCount)).kind).toBe("valid");
      const chain = new Map<string, string[]>();
      for (let index = 0; index < nodeCount - 1; index += 1) {
        chain.set(String(index), [String(index + 1)]);
      }
      expect(validateDependencyInsertion(chain, String(nodeCount - 1), "0").kind).toBe("cycle");
    }
  });

  test("bounds nodes and edges independently", () => {
    const wide = new Map<string, string[]>([["blocked", ["a", "b", "c"]]]);
    expect(
      validateDependencyInsertion(wide, "target", "blocked", {
        visitedTasks: 2,
        examinedEdges: 100,
      }),
    ).toMatchObject({ kind: "limit", exhausted: "visited_tasks" });
    expect(
      validateDependencyInsertion(wide, "target", "blocked", {
        visitedTasks: 100,
        examinedEdges: 2,
      }),
    ).toMatchObject({ kind: "limit", exhausted: "examined_edges" });
  });

  test("keeps maximum blocker propagation linear in blockers plus dependents", () => {
    expect(blockerPropagationReadBound(MAX_DIRECT_BLOCKERS, MAX_BLOCKING_DEPENDENTS)).toBe(
      MAX_BLOCKER_PROPAGATION_READS,
    );
    expect(blockerPropagationReadBound(MAX_DIRECT_BLOCKERS + 1, 0)).toBeNull();
    expect(blockerPropagationReadBound(0, MAX_BLOCKING_DEPENDENTS + 1)).toBeNull();
  });
});

describe("claim tuple laws", () => {
  const fullTuple = {
    taskStatus: "in_progress",
    taskOrganizationId: "org-a",
    taskWorkspaceId: "workspace-a",
    taskId: "task-a",
    compactClaimId: "claim-a",
    compactClaimPublicId: "clm-a",
    compactAgentId: "agent-a",
    compactAgentPublicId: "agt-a",
    compactFence: 7,
    compactLeaseGeneration: 3,
    compactLeaseUntil: 10_000,
    claimId: "claim-a",
    claimOrganizationId: "org-a",
    claimWorkspaceId: "workspace-a",
    claimTaskId: "task-a",
    claimPublicId: "clm-a",
    claimAgentId: "agent-a",
    claimAgentPublicId: "agt-a",
    claimState: "active",
    claimFence: 7,
    claimLeaseGeneration: 3,
    claimLeaseUntil: 10_000,
  } as const;

  test("rejects every mismatched durable claim field", () => {
    expect(activeTaskClaimTupleMatches(fullTuple)).toBeTrue();
    const mismatches = [
      ["taskStatus", "open"],
      ["claimOrganizationId", "org-b"],
      ["claimWorkspaceId", "workspace-b"],
      ["claimTaskId", "task-b"],
      ["claimId", "claim-b"],
      ["claimPublicId", "clm-b"],
      ["claimAgentId", "agent-b"],
      ["claimAgentPublicId", "agt-b"],
      ["claimState", "released"],
      ["claimFence", 8],
      ["claimLeaseGeneration", 4],
      ["claimLeaseUntil", 10_001],
    ] as const;
    for (const [field, value] of mismatches) {
      expect(activeTaskClaimTupleMatches({ ...fullTuple, [field]: value })).toBeFalse();
    }
  });

  test("rejects every cross-tenant task-owned record mismatch", () => {
    const scoped = {
      taskOrganizationId: "org-a",
      taskWorkspaceId: "workspace-a",
      taskId: "task-a",
      recordOrganizationId: "org-a",
      recordWorkspaceId: "workspace-a",
      recordTaskId: "task-a",
    } as const;
    expect(taskScopedRecordMatches(scoped)).toBeTrue();
    expect(taskScopedRecordMatches({ ...scoped, recordOrganizationId: "org-b" })).toBeFalse();
    expect(taskScopedRecordMatches({ ...scoped, recordWorkspaceId: "workspace-b" })).toBeFalse();
    expect(taskScopedRecordMatches({ ...scoped, recordTaskId: "task-b" })).toBeFalse();
  });
});

describe("full tenant relation tuple laws", () => {
  test("binds a loaded task and task-owned rows to the authorized tenant", () => {
    const authorizedTask = {
      authorizedOrganizationId: "org-a",
      authorizedWorkspaceId: "workspace-a",
      taskOrganizationId: "org-a",
      taskWorkspaceId: "workspace-a",
    } as const;
    expect(taskMatchesAuthorizedScope(authorizedTask)).toBeTrue();
    expect(
      taskMatchesAuthorizedScope({ ...authorizedTask, taskOrganizationId: "org-b" }),
    ).toBeFalse();
    expect(
      taskMatchesAuthorizedScope({ ...authorizedTask, taskWorkspaceId: "workspace-b" }),
    ).toBeFalse();

    const taskOwnedRow = {
      taskOrganizationId: "org-a",
      taskWorkspaceId: "workspace-a",
      taskId: "task-a",
      recordOrganizationId: "org-a",
      recordWorkspaceId: "workspace-a",
      recordTaskId: "task-a",
    } as const;
    expect(taskScopedRecordMatches(taskOwnedRow)).toBeTrue();
    for (const mismatch of [
      { recordOrganizationId: "org-b" },
      { recordWorkspaceId: "workspace-b" },
      { recordTaskId: "task-b" },
    ]) {
      expect(taskScopedRecordMatches({ ...taskOwnedRow, ...mismatch })).toBeFalse();
    }
  });

  test("requires an exact parent pointer in the same tenant", () => {
    const parent = {
      taskOrganizationId: "org-a",
      taskWorkspaceId: "workspace-a",
      taskParentTaskId: "task-parent",
      parentOrganizationId: "org-a",
      parentWorkspaceId: "workspace-a",
      parentTaskId: "task-parent",
    } as const;
    expect(parentTaskTupleMatches(parent)).toBeTrue();
    for (const mismatch of [
      { parentOrganizationId: "org-b" },
      { parentWorkspaceId: "workspace-b" },
      { parentTaskId: "task-other" },
    ]) {
      expect(parentTaskTupleMatches({ ...parent, ...mismatch })).toBeFalse();
    }
  });

  test("requires a dependency row and both endpoints to share one exact tuple", () => {
    const dependency = {
      dependencyOrganizationId: "org-a",
      dependencyWorkspaceId: "workspace-a",
      dependencyBlockerTaskId: "task-blocker",
      dependencyBlockedTaskId: "task-blocked",
      blockerOrganizationId: "org-a",
      blockerWorkspaceId: "workspace-a",
      blockerTaskId: "task-blocker",
      blockedOrganizationId: "org-a",
      blockedWorkspaceId: "workspace-a",
      blockedTaskId: "task-blocked",
    } as const;
    expect(dependencyTupleMatches(dependency)).toBeTrue();
    for (const mismatch of [
      { dependencyOrganizationId: "org-b" },
      { dependencyWorkspaceId: "workspace-b" },
      { dependencyBlockerTaskId: "task-other" },
      { dependencyBlockedTaskId: "task-other" },
      { blockerOrganizationId: "org-b" },
      { blockerWorkspaceId: "workspace-b" },
      { blockerTaskId: "task-other" },
      { blockedOrganizationId: "org-b" },
      { blockedWorkspaceId: "workspace-b" },
      { blockedTaskId: "task-other" },
    ]) {
      expect(dependencyTupleMatches({ ...dependency, ...mismatch })).toBeFalse();
    }
  });

  test("binds an agent grant to the exact authorized organization, workspace, and agent", () => {
    const grant = {
      authorizedOrganizationId: "org-a",
      authorizedWorkspaceId: "workspace-a",
      agentOrganizationId: "org-a",
      agentId: "agent-a",
      grantOrganizationId: "org-a",
      grantWorkspaceId: "workspace-a",
      grantAgentId: "agent-a",
    } as const;
    expect(agentGrantTupleMatches(grant)).toBeTrue();
    for (const mismatch of [
      { agentOrganizationId: "org-b" },
      { grantOrganizationId: "org-b" },
      { grantWorkspaceId: "workspace-b" },
      { grantAgentId: "agent-b" },
    ]) {
      expect(agentGrantTupleMatches({ ...grant, ...mismatch })).toBeFalse();
    }
  });
});

describe("hierarchy and readiness laws", () => {
  test("parent changes do not enter readiness derivation", () => {
    const before = derivedReady({
      status: "open",
      availableAt: 10,
      now: 20,
      unresolved: 0,
      cancelled: 0,
    });
    const parentByTask = new Map<string, string | undefined>([["child", undefined]]);
    expect(validateParentInsertion(parentByTask, "child", "parent")).toEqual({
      kind: "valid",
      depth: 1,
    });
    expect(before).toBeTrue();
  });

  test("detects parent cycles and depth exhaustion", () => {
    expect(validateParentInsertion(new Map([["parent", "child"]]), "child", "parent").kind).toBe(
      "cycle",
    );
    const chain = new Map<string, string>();
    for (let index = 0; index < 101; index += 1) chain.set(String(index), String(index + 1));
    expect(validateParentInsertion(chain, "root", "0").kind).toBe("limit");
  });

  test("blocker lifecycle transitions round trip without counter drift", () => {
    const cancelled = transitionBlockerCounters(
      { unresolved: 1, cancelled: 0 },
      "open",
      "cancelled",
    );
    expect(cancelled).toEqual({ unresolved: 0, cancelled: 1 });
    const reopened = transitionBlockerCounters(cancelled, "cancelled", "open");
    expect(reopened).toEqual({ unresolved: 1, cancelled: 0 });
    const done = transitionBlockerCounters(reopened, "open", "done");
    expect(done).toEqual({ unresolved: 0, cancelled: 0 });
  });

  test("stale completion attention survives repair until the reopened blocker completes", () => {
    expect(derivedNeedsAttention({ status: "done", unresolved: 1, cancelled: 0 })).toBeTrue();
    expect(derivedNeedsAttention({ status: "done", unresolved: 0, cancelled: 0 })).toBeFalse();
    expect(derivedNeedsAttention({ status: "open", unresolved: 1, cancelled: 0 })).toBeFalse();
    expect(derivedNeedsAttention({ status: "open", unresolved: 0, cancelled: 1 })).toBeTrue();
    expect(derivedNeedsAttention({ status: "open", unresolved: 0, cancelled: 0 })).toBeFalse();
  });
});

describe("external evidence URLs", () => {
  test("accepts bounded HTTPS URLs without embedded credentials", () => {
    expect(isCredentialFreeHttpsUrl("https://example.com/build/42")).toBeTrue();
    expect(isCredentialFreeHttpsUrl("https://user:secret@example.com/build/42")).toBeFalse();
    expect(isCredentialFreeHttpsUrl("http://example.com/build/42")).toBeFalse();
    expect(isCredentialFreeHttpsUrl("not a URL")).toBeFalse();
  });
});

describe("submission lifecycle laws", () => {
  test("has exactly three terminal transitions and no terminal rewrites", () => {
    expect(transitionSubmissionLifecycle("pending", "accept")).toBe("accepted");
    expect(transitionSubmissionLifecycle("pending", "reject")).toBe("rejected");
    expect(transitionSubmissionLifecycle("pending", "cancel")).toBe("cancelled");
    for (const terminal of ["accepted", "rejected", "cancelled"] as const) {
      expect(transitionSubmissionLifecycle(terminal, "accept")).toBeNull();
      expect(transitionSubmissionLifecycle(terminal, "reject")).toBeNull();
      expect(transitionSubmissionLifecycle(terminal, "cancel")).toBeNull();
    }
  });

  test("enforces stable-agent four-eyes review while allowing humans", () => {
    expect(reviewActorAllowed({ submittedByAgentId: "agt_A", reviewerAgentId: "agt_A" })).toBeFalse();
    expect(reviewActorAllowed({ submittedByAgentId: "agt_A", reviewerAgentId: "agt_B" })).toBeTrue();
    expect(reviewActorAllowed({ submittedByAgentId: "agt_A" })).toBeTrue();
  });
});
