import { describe, expect, test } from "bun:test";

import {
  WORKSPACE_INTEGRITY_INVERSE_INDEXES,
  WORKSPACE_INTEGRITY_LIMITS,
  auditRunnerAuthorityIntegrity,
  auditTaskIntegrity,
  buildWorkspaceIntegrityPage,
  buildWorkspaceIntegrityScan,
  type TaskIntegrityInput,
  type WorkspaceIntegrityPageInput,
} from "./workspaceIntegrity";

const NOW = 1_800_000_000_000;

function healthyTask(): TaskIntegrityInput {
  return {
    workspace: { organizationId: "org_1", id: "wsp_1" },
    now: NOW,
    task: {
      organizationId: "org_1",
      workspaceId: "wsp_1",
      id: "task_1",
      publicId: "tsk_public_1",
      key: "TSK-1",
      status: "open",
      availableAt: 0,
      isReady: true,
      isBlocked: false,
      needsAttention: false,
      unresolvedBlockerCount: 0,
      cancelledBlockerCount: 0,
      revision: 1,
      reviewRevision: 1,
      claimFence: 0,
    },
    activeClaims: {
      rows: [],
      limit: WORKSPACE_INTEGRITY_LIMITS.activeClaims,
      truncated: false,
    },
    blockers: {
      rows: [],
      limit: WORKSPACE_INTEGRITY_LIMITS.directBlockers,
      truncated: false,
    },
    pendingSubmissions: {
      rows: [],
      limit: WORKSPACE_INTEGRITY_LIMITS.pendingSubmissions,
      truncated: false,
    },
    latestEvent: {
      organizationId: "org_1",
      workspaceId: "wsp_1",
      taskId: "task_1",
      taskPublicId: "tsk_public_1",
      taskRevision: 1,
    },
  };
}

function healthyPage(task = healthyTask()): WorkspaceIntegrityPageInput {
  return {
    workspace: { organizationId: "org_1", id: "wsp_1", publicId: "wsp_public_1" },
    now: NOW,
    startedAtBeginning: true,
    nextCursor: null,
    taskLimit: WORKSPACE_INTEGRITY_LIMITS.defaultTasks,
    tasks: [task],
    usage: {
      organizationId: "org_1",
      workspaceId: "wsp_1",
      activeTasks: 1,
      totalTasks: 1,
      activeAgents: 1,
      updatedAt: NOW,
    },
    activeGrants: {
      rows: [
        {
          organizationId: "org_1",
          workspaceId: "wsp_1",
          agentId: "agent_1",
          agent: {
            id: "agent_1",
            organizationId: "org_1",
            status: "active",
          },
        },
      ],
      limit: WORKSPACE_INTEGRITY_LIMITS.activeGrants,
      truncated: false,
    },
    runnerAuthorities: {
      rows: [],
      limit: WORKSPACE_INTEGRITY_LIMITS.runnerAuthorities,
      truncated: false,
    },
  };
}

describe("workspace integrity auditor", () => {
  test("accepts zero or one exact workspace runner authority", () => {
    const workspace = { organizationId: "org_1", id: "wsp_1" };
    expect(
      auditRunnerAuthorityIntegrity({
        workspace,
        authorities: { rows: [], limit: 1, truncated: false },
      }),
    ).toEqual([]);
    expect(
      auditRunnerAuthorityIntegrity({
        workspace,
        authorities: {
          rows: [{
            organizationId: "org_1",
            workspaceId: "wsp_1",
            runnerId: "runner_row_1",
            runnerPublicId: "runner_public_1",
            installationId: "install_1",
            generation: 2,
            leaseUntil: NOW + 45_000,
            runner: {
              id: "runner_row_1",
              organizationId: "org_1",
              workspaceId: "wsp_1",
              publicId: "runner_public_1",
              installationId: "install_1",
              leaseUntil: NOW + 45_000,
            },
          }],
          limit: 1,
          truncated: false,
        },
      }),
    ).toEqual([]);
  });

  test("finds duplicate, cross-tenant, invalid-generation, and broken runner authority rows", () => {
    const broken = {
      organizationId: "org_foreign",
      workspaceId: "wsp_foreign",
      runnerId: "runner_row_1",
      runnerPublicId: "runner_public_1",
      installationId: "install_1",
      generation: 0,
      leaseUntil: NOW + 45_000,
      runner: null,
    };
    expect(
      auditRunnerAuthorityIntegrity({
        workspace: { organizationId: "org_1", id: "wsp_1" },
        authorities: { rows: [broken, broken], limit: 1, truncated: true },
      }).map(({ kind }) => kind),
    ).toEqual([
      "runner_authority_count_mismatch",
      "runner_authority_tenant_mismatch",
      "runner_authority_generation_invalid",
      "runner_authority_tuple_mismatch",
      "runner_authority_tenant_mismatch",
      "runner_authority_generation_invalid",
      "runner_authority_tuple_mismatch",
    ]);
  });

  test("discovers task-owned rows through task-first inverse indexes", () => {
    expect(WORKSPACE_INTEGRITY_INVERSE_INDEXES).toEqual({
      activeClaims: "by_task_state",
      blockerEdges: "by_blocked_task_blocker",
      pendingSubmissions: "by_task_status_submitted",
      taskEvents: "by_task",
    });
  });

  test("proves a complete healthy workspace page without leaking internal locators", () => {
    const result = buildWorkspaceIntegrityPage(healthyPage());

    expect(result).toMatchObject({
      workspacePublicId: "wsp_public_1",
      workspaceComplete: true,
      workspaceClean: true,
      pageClean: true,
      observed: { tasks: 1, activeTasks: 1, activeGrants: 1 },
      findings: [],
    });
    expect(JSON.stringify(result)).not.toContain("task_1");
    expect(JSON.stringify(result)).not.toContain("org_1");
    expect(JSON.stringify(result)).not.toContain("wsp_1");
  });

  test("finds stale claim fences and every durable tuple disagreement", () => {
    const base = healthyTask();
    const input: TaskIntegrityInput = {
      ...base,
      task: {
        ...base.task,
        status: "in_progress",
        isReady: false,
        claimFence: 3,
        currentClaim: {
          claimId: "claim_1",
          publicId: "clm_public_1",
          agentId: "agent_1",
          agentPublicId: "agt_public_1",
          fence: 2,
          leaseGeneration: 4,
          leaseUntil: NOW + 60_000,
        },
      },
      activeClaims: {
        rows: [
          {
            id: "claim_1",
            organizationId: "org_1",
            workspaceId: "wsp_1",
            taskId: "task_1",
            publicId: "clm_public_1",
            agentId: "agent_foreign",
            agentPublicId: "agt_public_1",
            state: "active",
            fence: 2,
            leaseGeneration: 4,
            leaseUntil: NOW + 60_000,
          },
        ],
        limit: WORKSPACE_INTEGRITY_LIMITS.activeClaims,
        truncated: false,
      },
    };

    expect(auditTaskIntegrity(input).findings.map((row) => row.kind)).toEqual([
      "claim_fence_mismatch",
      "active_claim_tuple_mismatch",
    ]);
  });

  test("recomputes blockers instead of trusting readiness and attention projections", () => {
    const base = healthyTask();
    const input: TaskIntegrityInput = {
      ...base,
      blockers: {
        rows: [
          {
            edge: {
              organizationId: "org_1",
              workspaceId: "wsp_1",
              blockerTaskId: "blocker_1",
              blockedTaskId: "task_1",
            },
            blocker: {
              organizationId: "org_1",
              workspaceId: "wsp_1",
              id: "blocker_1",
              status: "cancelled",
            },
          },
        ],
        limit: WORKSPACE_INTEGRITY_LIMITS.directBlockers,
        truncated: false,
      },
    };

    expect(auditTaskIntegrity(input).findings.map((row) => row.kind)).toEqual([
      "cancelled_blocker_count_mismatch",
      "blocked_projection_mismatch",
      "ready_projection_mismatch",
      "attention_projection_mismatch",
    ]);
  });

  test("detects cross-tenant blockers, submissions, and event revision drift", () => {
    const base = healthyTask();
    const input: TaskIntegrityInput = {
      ...base,
      task: {
        ...base.task,
        status: "in_review",
        isReady: false,
        revision: 9,
        reviewRevision: 4,
      },
      blockers: {
        rows: [
          {
            edge: {
              organizationId: "org_1",
              workspaceId: "wsp_1",
              blockerTaskId: "blocker_1",
              blockedTaskId: "task_1",
            },
            blocker: {
              organizationId: "org_foreign",
              workspaceId: "wsp_foreign",
              id: "blocker_1",
              status: "done",
            },
          },
        ],
        limit: WORKSPACE_INTEGRITY_LIMITS.directBlockers,
        truncated: false,
      },
      pendingSubmissions: {
        rows: [
          {
            organizationId: "org_foreign",
            workspaceId: "wsp_foreign",
            taskId: "task_foreign",
            status: "pending",
            reviewRevision: 3,
          },
        ],
        limit: WORKSPACE_INTEGRITY_LIMITS.pendingSubmissions,
        truncated: false,
      },
      latestEvent: {
        organizationId: "org_1",
        workspaceId: "wsp_1",
        taskId: "task_1",
        taskPublicId: "tsk_public_1",
        taskRevision: 8,
      },
    };

    expect(auditTaskIntegrity(input).findings.map((row) => row.kind)).toEqual([
      "blocker_relation_mismatch",
      "pending_submission_tuple_mismatch",
      "submission_review_revision_mismatch",
      "latest_event_revision_mismatch",
    ]);
  });

  test("never calls a truncated page or relation scan clean", () => {
    const base = healthyTask();
    const truncatedTask: TaskIntegrityInput = {
      ...base,
      blockers: { ...base.blockers, truncated: true },
    };
    const result = buildWorkspaceIntegrityPage({
      ...healthyPage(truncatedTask),
      nextCursor: "next-page",
      activeGrants: {
        ...healthyPage().activeGrants,
        truncated: true,
      },
    });

    expect(result).toMatchObject({
      workspaceComplete: false,
      workspaceClean: false,
      pageClean: false,
      coverage: {
        blockerRelations: { truncatedTasks: 1 },
        activeGrants: { truncated: true },
      },
    });
  });

  test("checks exact workspace usage only when the complete task set is visible", () => {
    const page = healthyPage();
    const result = buildWorkspaceIntegrityPage({
      ...page,
      usage: {
        organizationId: "org_1",
        workspaceId: "wsp_1",
        activeTasks: 0,
        totalTasks: 2,
        activeAgents: 0,
        updatedAt: NOW,
      },
    });

    expect(result.findings).toEqual([
      { kind: "active_task_usage_mismatch", expected: 1, actual: 0 },
      { kind: "total_task_usage_mismatch", expected: 1, actual: 2 },
      { kind: "active_agent_usage_mismatch", expected: 1, actual: 0 },
    ]);
    expect(result.workspaceClean).toBeFalse();
  });

  test("detects orphaned and duplicate active durable claims", () => {
    const base = healthyTask();
    const activeClaim = {
      id: "claim_orphan",
      organizationId: "org_1",
      workspaceId: "wsp_1",
      taskId: "task_1",
      publicId: "clm_public_orphan",
      agentId: "agent_1",
      agentPublicId: "agt_public_1",
      state: "active",
      fence: 1,
      leaseGeneration: 1,
      leaseUntil: NOW + 60_000,
    };

    expect(
      auditTaskIntegrity({
        ...base,
        activeClaims: {
          rows: [activeClaim],
          limit: WORKSPACE_INTEGRITY_LIMITS.activeClaims,
          truncated: false,
        },
      }).findings,
    ).toContainEqual({
      kind: "active_claim_count_mismatch",
      taskKey: "TSK-1",
      expected: 0,
      actual: 1,
    });

    const claimed = healthyTask();
    const duplicate = auditTaskIntegrity({
      ...claimed,
      task: {
        ...claimed.task,
        status: "in_progress",
        isReady: false,
        currentClaim: {
          claimId: activeClaim.id,
          publicId: activeClaim.publicId,
          agentId: activeClaim.agentId,
          agentPublicId: activeClaim.agentPublicId,
          fence: activeClaim.fence,
          leaseGeneration: activeClaim.leaseGeneration,
          leaseUntil: activeClaim.leaseUntil,
        },
        claimFence: activeClaim.fence,
      },
      activeClaims: {
        rows: [activeClaim, { ...activeClaim, id: "claim_duplicate" }],
        limit: WORKSPACE_INTEGRITY_LIMITS.activeClaims,
        truncated: false,
      },
    });
    expect(duplicate.findings.map(({ kind }) => kind)).toContain(
      "active_claim_count_mismatch",
    );
  });

  test("does not count a disabled agent merely because its grant remains active", () => {
    const page = healthyPage();
    const result = buildWorkspaceIntegrityPage({
      ...page,
      usage: { ...page.usage!, activeAgents: 0 },
      activeGrants: {
        ...page.activeGrants,
        rows: page.activeGrants.rows.map((grant) => ({
          ...grant,
          agent: grant.agent === null ? null : { ...grant.agent, status: "disabled" },
        })),
      },
    });

    expect(result.workspaceClean).toBeTrue();
    expect(result.observed.activeAgents).toBe(0);
  });

  test("certifies a stable two-pass scan spanning multiple bounded pages", () => {
    const firstTask = healthyTask();
    const secondTask: TaskIntegrityInput = {
      ...healthyTask(),
      task: {
        ...healthyTask().task,
        id: "task_2",
        publicId: "tsk_public_2",
        key: "TSK-2",
      },
      latestEvent: {
        organizationId: "org_1",
        workspaceId: "wsp_1",
        taskId: "task_2",
        taskPublicId: "tsk_public_2",
        taskRevision: 1,
      },
    };
    const common = {
      ...healthyPage(),
      usage: { ...healthyPage().usage!, activeTasks: 2, totalTasks: 2 },
    };
    const pages = [
      buildWorkspaceIntegrityPage({
        ...common,
        tasks: [firstTask],
        nextCursor: "cursor_2",
      }),
      buildWorkspaceIntegrityPage({
        ...common,
        tasks: [secondTask],
        startedAtBeginning: false,
        nextCursor: null,
      }),
    ];
    const result = buildWorkspaceIntegrityScan({
      workspacePublicId: "wsp_public_1",
      generatedAt: NOW,
      maxPages: 2,
      passes: [pages, pages],
    });

    expect(result).toMatchObject({
      scanComplete: true,
      scanClean: true,
      observed: { passes: 2, pages: 4, tasks: 2, activeTasks: 2 },
      findings: [],
    });
  });

  test("fails closed when task revisions change between scan passes", () => {
    const page = buildWorkspaceIntegrityPage(healthyPage());
    const changed = {
      ...page,
      taskFingerprints: [{ taskKey: "TSK-1", revision: 2 }],
    };
    const result = buildWorkspaceIntegrityScan({
      workspacePublicId: "wsp_public_1",
      generatedAt: NOW,
      maxPages: 1,
      passes: [[page], [changed]],
    });

    expect(result.scanComplete).toBeFalse();
    expect(result.scanClean).toBeFalse();
    expect(result.findings).toContainEqual({ kind: "task_scan_changed" });
  });
});
