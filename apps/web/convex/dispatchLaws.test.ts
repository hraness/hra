import { describe, expect, test } from "bun:test";
import {
  appendRunEventsRequestSchema,
  MAX_RUN_DISPLAY_EVENTS,
  MAX_RUN_REASONING_SUMMARY_EVENTS,
  MAX_RUN_TOOL_ACTIVITY_EVENTS,
  type RunnerHeartbeatRequest,
} from "@hraness/agent-tasks-protocol";

import {
  CANDIDATE_ROTATION_COOLDOWN_MS,
  candidateRowsToRotate,
  contiguousEventBatch,
  deriveRunnerPresence,
  dispatchCandidateExpansionTake,
  dispatchCandidateIsEligible,
  dispatchCandidateScanTake,
  dispatchBindingTupleMatches,
  dispatchClaimAllowed,
  dispatchClaimLeaseDisposition,
  dispatchRetryAllowed,
  dispatchSubmissionAuthorityMatches,
  dispatchSubmissionInputRevisionMatches,
  dispatchTenantTupleMatches,
  heartbeatDisposition,
  heartbeatFingerprint,
  heartbeatMayRotateCandidates,
  nextRunPhase,
  planFairEligibleDispatchCandidates,
  rejectedSubmissionMatchesDispatch,
  retainedTerminalRunIds,
  runnerAuthorityClockMatches,
  runnerAuthorityDisposition,
  runnerAuthorityTupleMatches,
  resolvedAmbiguousDispatchPhase,
  runDisplayBudgetAfterBatch,
  runEventSequenceAllowed,
  scheduledDispatchExpiryDisposition,
  selectFairDispatchCandidateRows,
  storedRunEventPayloadMatches,
  taskDispatchBlocksTaskRelease,
} from "./dispatchLaws";

const now = 1_000_000;

function heartbeat(overrides: Partial<RunnerHeartbeatRequest> = {}): RunnerHeartbeatRequest {
  return {
    runnerId: "runner_abcdefgh",
    installationId: "install_abcdefgh",
    bootId: "boot_abcdefgh",
    bootGeneration: 1,
    sequence: 1,
    protocolVersion: 1,
    clientVersion: "1.0.0",
    reportedState: "ready",
    capacity: 2,
    activeRuns: 0,
    currentRunIds: [],
    retainedRunIds: [],
    repositoryIds: ["repo_00000000000000000000000000"],
    ...overrides,
  };
}

describe("runner heartbeat laws", () => {
  test("selects bounded candidates fairly across capable repository queues", () => {
    const heads = Array.from({ length: 40 }, (_, index) => ({
      publicId: `run_head_${index.toString().padStart(4, "0")}`,
      queuedAt: index,
      repositoryId: `repository_${index.toString().padStart(4, "0")}`,
    }));
    expect(selectFairDispatchCandidateRows({
      expandedRows: [],
      headRows: heads,
      limit: 32,
    })).toEqual(heads.slice(0, 32));
    expect(dispatchCandidateExpansionTake(heads.length, 32)).toBe(0);

    const twoHeads = heads.slice(0, 2);
    const busyExtras = Array.from({ length: 40 }, (_, index) => ({
      publicId: `run_extra_${index.toString().padStart(4, "0")}`,
      queuedAt: index + 100,
      repositoryId: heads[0]?.repositoryId ?? "repository_missing",
    }));
    const selected = selectFairDispatchCandidateRows({
      expandedRows: [...twoHeads, ...busyExtras],
      headRows: twoHeads,
      limit: 32,
    });
    expect(selected).not.toBeNull();
    expect(selected).toHaveLength(32);
    expect(new Set(selected?.map(({ repositoryId }) => repositoryId))).toEqual(
      new Set(twoHeads.map(({ repositoryId }) => repositoryId)),
    );
    expect(selectFairDispatchCandidateRows({
      expandedRows: [
        { publicId: "run_repo_a_extra", queuedAt: 150, repositoryId: "repository_a" },
      ],
      headRows: [
        { publicId: "run_repo_a_head", queuedAt: 100, repositoryId: "repository_a" },
        { publicId: "run_repo_b_head", queuedAt: 200, repositoryId: "repository_b" },
      ],
      limit: 2,
    })?.map(({ publicId }) => publicId)).toEqual([
      "run_repo_a_head",
      "run_repo_b_head",
    ]);
    expect(selectFairDispatchCandidateRows({
      expandedRows: [],
      headRows: [
        { publicId: "run_repo_a_head", queuedAt: 100, repositoryId: "repository_a" },
        { publicId: "run_repo_b_head", queuedAt: 200, repositoryId: "repository_b" },
      ],
      limit: 1,
      repositoryCursor: "repository_a",
    })?.[0]?.repositoryId).toBe("repository_b");
    expect(dispatchCandidateExpansionTake(twoHeads.length, 32)).toBe(31);
    expect(dispatchCandidateScanTake(twoHeads.length, 32)).toBe(256);
    const firstBusy = busyExtras[0];
    if (firstBusy === undefined) throw new Error("Expected a busy candidate");
    expect(selectFairDispatchCandidateRows({
      expandedRows: [{ ...firstBusy, queuedAt: Number.NaN }],
      headRows: twoHeads,
      limit: 32,
    })).toBeNull();

    const oneRepository = Array.from({ length: 4 }, (_, index) => ({
      publicId: `run_one_repo_${index}`,
      queuedAt: index,
      repositoryId: "repository_one",
    }));
    expect(selectFairDispatchCandidateRows({
      expandedRows: oneRepository,
      headRows: oneRepository.slice(0, 1),
      limit: 2,
      repositoryCursor: "repository_one",
    })?.map(({ publicId }) => publicId)).toEqual([
      "run_one_repo_0",
      "run_one_repo_1",
    ]);
  });

  test("selects the oldest eligible row and rotates only its ineligible prefix", () => {
    const blockedHead = {
      candidateOrderAt: 10,
      eligible: false,
      publicId: "run_blocked_head",
      queuedAt: 10,
      repositoryId: "repository_a",
    };
    const readySecond = {
      candidateOrderAt: 11,
      eligible: true,
      publicId: "run_ready_second",
      queuedAt: 11,
      repositoryId: "repository_a",
    };
    const readyOther = {
      candidateOrderAt: 12,
      eligible: true,
      publicId: "run_ready_other",
      queuedAt: 12,
      repositoryId: "repository_b",
    };
    expect(planFairEligibleDispatchCandidates({
      limit: 2,
      rows: [blockedHead, readySecond, readyOther],
    })).toEqual({
      deferredPublicIds: [blockedHead.publicId],
      nextRepositoryCursor: readyOther.repositoryId,
      selected: [readySecond, readyOther],
    });
    expect(candidateRowsToRotate({
      cooldownMs: CANDIDATE_ROTATION_COOLDOWN_MS,
      deferredPublicIds: [blockedHead.publicId],
      maximumRows: 3,
      now: 100_000,
      rows: [blockedHead, readySecond, readyOther],
      truncatedRepositoryIds: [blockedHead.repositoryId],
    })).toEqual([blockedHead]);
    expect(candidateRowsToRotate({
      cooldownMs: CANDIDATE_ROTATION_COOLDOWN_MS,
      deferredPublicIds: [blockedHead.publicId],
      maximumRows: 3,
      now: 100_000,
      rows: [blockedHead, readySecond, readyOther],
      truncatedRepositoryIds: [],
    })).toEqual([]);
    expect(candidateRowsToRotate({
      cooldownMs: CANDIDATE_ROTATION_COOLDOWN_MS,
      deferredPublicIds: [blockedHead.publicId],
      maximumRows: 1,
      now: 100_000,
      rows: [{ ...blockedHead, candidateRotationAt: 99_999 }],
      truncatedRepositoryIds: [blockedHead.repositoryId],
    })).toEqual([]);
  });

  test("does not offer deadline-ready work before its persisted wake barrier", () => {
    const exact = {
      currentClaimFence: 4,
      currentTaskRevision: 7,
      persistedReady: true,
      queuedClaimFence: 4,
      queuedTaskRevision: 7,
      readyNow: true,
    } as const;
    expect(dispatchCandidateIsEligible(exact)).toBeTrue();
    expect(dispatchCandidateIsEligible({ ...exact, persistedReady: false })).toBeFalse();
    expect(dispatchCandidateIsEligible({ ...exact, readyNow: false })).toBeFalse();
    expect(dispatchCandidateIsEligible({ ...exact, queuedTaskRevision: 6 })).toBeFalse();
    expect(dispatchCandidateIsEligible({ ...exact, queuedClaimFence: 3 })).toBeFalse();
  });

  test("advances a boundary cursor from the last selected head, never a tail extra", () => {
    const rows = [
      { eligible: true, publicId: "run_a_head", queuedAt: 1, repositoryId: "repository_a" },
      { eligible: true, publicId: "run_b_head", queuedAt: 2, repositoryId: "repository_b" },
      { eligible: true, publicId: "run_b_extra", queuedAt: 5, repositoryId: "repository_b" },
      { eligible: true, publicId: "run_c_head", queuedAt: 3, repositoryId: "repository_c" },
    ] as const;
    expect(planFairEligibleDispatchCandidates({
      limit: 3,
      repositoryCursor: "repository_a",
      rows,
    })).toEqual({
      deferredPublicIds: [],
      nextRepositoryCursor: "repository_c",
      selected: [rows[1], rows[3], rows[2]],
    });
  });

  test("exact heartbeat replays never rotate candidate order", () => {
    expect(heartbeatMayRotateCandidates({ kind: "create" })).toBe(true);
    expect(heartbeatMayRotateCandidates({ kind: "advance" })).toBe(true);
    expect(heartbeatMayRotateCandidates({ kind: "restart" })).toBe(true);
    expect(heartbeatMayRotateCandidates({ kind: "replay" })).toBe(false);
    expect(heartbeatMayRotateCandidates({ kind: "stale" })).toBe(false);
    expect(heartbeatMayRotateCandidates({ kind: "gap" })).toBe(false);
    expect(heartbeatMayRotateCandidates({ kind: "conflict" })).toBe(false);
  });

  test("terminal recovery is exact and cannot starve behind phase history", () => {
    const historical = Array.from({ length: 40 }, (_, index) => ({
      publicId: `run_submitted_${String(index).padStart(2, "0")}`,
      phase: "submitted",
    }));
    const recovered = { publicId: "run_recovered_failed", phase: "failed" };
    expect(retainedTerminalRunIds(
      [recovered.publicId],
      [...historical, recovered],
    )).toEqual([recovered.publicId]);
    expect(retainedTerminalRunIds(
      ["run_active", "run_ambiguous", recovered.publicId],
      [
        ...historical,
        { publicId: "run_active", phase: "running" },
        { publicId: "run_ambiguous", phase: "ambiguous" },
        recovered,
      ],
    )).toEqual([recovered.publicId]);
  });

  test("requires a generation-one sequence-one registration", () => {
    const initial = heartbeat();
    expect(
      heartbeatDisposition(null, {
        bootId: initial.bootId,
        bootGeneration: initial.bootGeneration,
        sequence: initial.sequence,
        fingerprint: heartbeatFingerprint(initial),
      }),
    ).toEqual({ kind: "create" });
    expect(
      heartbeatDisposition(null, {
        bootId: initial.bootId,
        bootGeneration: 2,
        sequence: 1,
        fingerprint: heartbeatFingerprint(initial),
      }),
    ).toEqual({ kind: "gap" });
  });

  test("accepts exact replay without allowing a same-sequence rewrite", () => {
    const initial = heartbeat();
    const fingerprint = heartbeatFingerprint(initial);
    const current = {
      bootId: initial.bootId,
      bootGeneration: 1,
      heartbeatSequence: 1,
      heartbeatFingerprint: fingerprint,
      leaseUntil: now + 45_000,
    };
    expect(
      heartbeatDisposition(current, {
        bootId: initial.bootId,
        bootGeneration: 1,
        sequence: 1,
        fingerprint,
      }),
    ).toEqual({ kind: "replay" });
    expect(
      heartbeatDisposition(current, {
        bootId: initial.bootId,
        bootGeneration: 1,
        sequence: 1,
        fingerprint: heartbeatFingerprint(heartbeat({ capacity: 3 })),
      }),
    ).toEqual({ kind: "conflict" });
  });

  test("rejects stale and skipped clocks but admits one-step restart", () => {
    const current = {
      bootId: "boot_abcdefgh",
      bootGeneration: 7,
      heartbeatSequence: 9,
      heartbeatFingerprint: "stored",
      leaseUntil: now + 1,
    };
    expect(
      heartbeatDisposition(current, {
        bootId: current.bootId,
        bootGeneration: 7,
        sequence: 8,
        fingerprint: "stale",
      }),
    ).toEqual({ kind: "stale" });
    expect(
      heartbeatDisposition(current, {
        bootId: current.bootId,
        bootGeneration: 7,
        sequence: 11,
        fingerprint: "gap",
      }),
    ).toEqual({ kind: "gap" });
    expect(
      heartbeatDisposition(current, {
        bootId: "boot_restarted",
        bootGeneration: 8,
        sequence: 1,
        fingerprint: "restart",
      }),
    ).toEqual({ kind: "restart" });
  });
});

describe("workspace runner authority laws", () => {
  const authority = {
    runnerPublicId: "runner_primary",
    installationId: "install_primary",
    generation: 4,
    leaseUntil: now + 45_000,
  } as const;

  test("acquires once and lets only the same installation renew a live lease", () => {
    expect(
      runnerAuthorityDisposition(null, {
        runnerPublicId: authority.runnerPublicId,
        installationId: authority.installationId,
      }, now),
    ).toEqual({ kind: "acquire", generation: 1 });
    expect(
      runnerAuthorityDisposition(authority, {
        runnerPublicId: authority.runnerPublicId,
        installationId: authority.installationId,
      }, now),
    ).toEqual({ kind: "renew", generation: 4 });
    expect(
      runnerAuthorityDisposition(authority, {
        runnerPublicId: "runner_contender",
        installationId: "install_contender",
      }, now),
    ).toEqual({ kind: "conflict", retryAfterMs: 45_000 });
  });

  test("admits a different installation exactly at expiry and fences corrupt generations", () => {
    const incoming = {
      runnerPublicId: "runner_contender",
      installationId: "install_contender",
    };
    expect(runnerAuthorityDisposition(authority, incoming, authority.leaseUntil - 1)).toEqual({
      kind: "conflict",
      retryAfterMs: 1,
    });
    expect(runnerAuthorityDisposition(authority, incoming, authority.leaseUntil)).toEqual({
      kind: "takeover",
      generation: 5,
    });
    expect(
      runnerAuthorityDisposition({ ...authority, generation: Number.MAX_SAFE_INTEGER }, incoming, authority.leaseUntil),
    ).toEqual({ kind: "corrupt" });
    expect(runnerAuthorityDisposition({ ...authority, leaseUntil: Number.NaN }, incoming, now))
      .toEqual({ kind: "corrupt" });
    expect(runnerAuthorityDisposition(null, incoming, Number.NaN))
      .toEqual({ kind: "corrupt" });
  });

  test("a live authority requires one positive generation and the exact runner lease", () => {
    expect(runnerAuthorityClockMatches({
      authorityGeneration: 3,
      authorityLeaseUntil: 2_000,
      runnerLeaseUntil: 2_000,
    })).toBeTrue();
    for (const corruption of [
      { authorityGeneration: 0 },
      { authorityGeneration: Number.NaN },
      { authorityLeaseUntil: 1_999 },
      { authorityLeaseUntil: Number.NaN },
      { runnerLeaseUntil: 2_001 },
      { runnerLeaseUntil: Number.NaN },
    ]) {
      expect(runnerAuthorityClockMatches({
        authorityGeneration: 3,
        authorityLeaseUntil: 2_000,
        runnerLeaseUntil: 2_000,
        ...corruption,
      })).toBeFalse();
    }
  });

  test("matches the complete persisted authority and runner tuple", () => {
    const tuple = {
      authorityOrganizationId: "org_a",
      authorityWorkspaceId: "workspace_a",
      authorityRunnerId: "runner_row_a",
      authorityRunnerPublicId: "runner_a",
      authorityInstallationId: "install_a",
      runnerOrganizationId: "org_a",
      runnerWorkspaceId: "workspace_a",
      runnerId: "runner_row_a",
      runnerPublicId: "runner_a",
      runnerInstallationId: "install_a",
    };
    expect(runnerAuthorityTupleMatches(tuple)).toBeTrue();
    for (const key of [
      "authorityOrganizationId",
      "authorityWorkspaceId",
      "authorityRunnerId",
      "authorityRunnerPublicId",
      "authorityInstallationId",
    ] as const) {
      expect(runnerAuthorityTupleMatches({ ...tuple, [key]: "different" })).toBeFalse();
    }
  });
});

describe("dispatch-bound submission authority", () => {
  const exact = {
    now,
    authorization: { organizationId: "org_a", workspaceId: "workspace_a", agentId: "agent_a" },
    request: {
      runId: "run_a",
      runnerId: "runner_a",
      bootId: "boot_a",
      claimId: "claim_a",
      claimFence: 7,
    },
    task: { id: "task_a", organizationId: "org_a", workspaceId: "workspace_a" },
    claim: {
      id: "claim_row_a",
      organizationId: "org_a",
      workspaceId: "workspace_a",
      taskId: "task_a",
      agentId: "agent_a",
      publicId: "claim_a",
      fence: 7,
      state: "active",
      leaseUntil: now + 60_000,
    },
    dispatch: {
      publicId: "run_a",
      organizationId: "org_a",
      workspaceId: "workspace_a",
      taskId: "task_a",
      runnerId: "runner_row_a",
      runnerPublicId: "runner_a",
      bootId: "boot_a",
      bootGeneration: 3,
      taskClaimId: "claim_row_a",
      taskClaimPublicId: "claim_a",
      claimFence: 7,
      leaseUntil: now + 30_000,
      phase: "running" as const,
    },
    runner: {
      id: "runner_row_a",
      organizationId: "org_a",
      workspaceId: "workspace_a",
      agentId: "agent_a",
      publicId: "runner_a",
      installationId: "install_a",
      bootId: "boot_a",
      bootGeneration: 3,
      leaseUntil: now + 45_000,
    },
    authority: {
      organizationId: "org_a",
      workspaceId: "workspace_a",
      runnerId: "runner_row_a",
      runnerPublicId: "runner_a",
      installationId: "install_a",
      generation: 2,
      leaseUntil: now + 45_000,
    },
  } as const;

  test("admits only the exact live runner, boot, dispatch, claim, and authority tuple", () => {
    expect(dispatchSubmissionAuthorityMatches(exact)).toBeTrue();
    expect(dispatchSubmissionAuthorityMatches({
      ...exact,
      authority: {
        ...exact.authority,
        runnerId: "runner_row_new",
        runnerPublicId: "runner_new",
        installationId: "install_new",
      },
    })).toBeFalse();
    expect(dispatchSubmissionAuthorityMatches({
      ...exact,
      request: { ...exact.request, claimFence: exact.request.claimFence + 1 },
    })).toBeFalse();
    expect(dispatchSubmissionAuthorityMatches({
      ...exact,
      now: exact.authority.leaseUntil,
    })).toBeFalse();
  });
});

describe("leased readiness and claim laws", () => {
  test("the exact lease boundary is offline", () => {
    const base = {
      capacity: 2,
      cloudActiveRuns: 0,
      desiredState: "active" as const,
      leaseUntil: now,
      reportedActiveRuns: 0,
      reportedState: "ready" as const,
      repositoryCount: 1,
    };
    expect(deriveRunnerPresence(base, now)).toEqual({ state: "offline", serverTime: now });
    expect(deriveRunnerPresence({ ...base, leaseUntil: now + 1 }, now)).toEqual({
      state: "ready",
      serverTime: now,
      leaseUntil: now + 1,
      availableCapacity: 2,
    });
  });

  test("stale, draining, blocked, and full runners cannot claim", () => {
    const eligible = {
      dispatchPhase: "queued" as const,
      repositoryCapability: true,
      runnerBootMatches: true,
      runnerDesiredState: "active" as const,
      runnerLeaseUntil: now + 1,
      runnerReady: true,
      availableCapacity: 1,
      taskReady: true,
    };
    expect(dispatchClaimAllowed(eligible, now)).toBeTrue();
    expect(dispatchClaimAllowed({ ...eligible, runnerLeaseUntil: now }, now)).toBeFalse();
    expect(dispatchClaimAllowed({ ...eligible, runnerDesiredState: "draining" }, now)).toBeFalse();
    expect(dispatchClaimAllowed({ ...eligible, runnerReady: false }, now)).toBeFalse();
    expect(dispatchClaimAllowed({ ...eligible, availableCapacity: 0 }, now)).toBeFalse();
  });

  test("renews task authority at the threshold and never outlives it", () => {
    expect(
      dispatchClaimLeaseDisposition(
        { claimLeaseGeneration: 3, claimLeaseUntil: now + 5 * 60 * 1_000 + 1 },
        now,
      ),
    ).toEqual({
      kind: "retain",
      claimLeaseGeneration: 3,
      claimLeaseUntil: now + 5 * 60 * 1_000 + 1,
      dispatchLeaseUntil: now + 90_000,
    });
    expect(
      dispatchClaimLeaseDisposition(
        { claimLeaseGeneration: 3, claimLeaseUntil: now + 5 * 60 * 1_000 },
        now,
      ),
    ).toEqual({
      kind: "renew",
      claimLeaseGeneration: 4,
      claimLeaseUntil: now + 15 * 60 * 1_000,
      dispatchLeaseUntil: now + 90_000,
    });
    expect(
      dispatchClaimLeaseDisposition(
        { claimLeaseGeneration: 3, claimLeaseUntil: now },
        now,
      ),
    ).toBeNull();
  });
});

describe("dispatch tuple and semantic event laws", () => {
  test("requires the complete tenant and binding tuple", () => {
    const tenant = {
      authorizedOrganizationId: "org_a",
      authorizedWorkspaceId: "ws_a",
      runnerOrganizationId: "org_a",
      runnerWorkspaceId: "ws_a",
      taskOrganizationId: "org_a",
      taskWorkspaceId: "ws_a",
      repositoryOrganizationId: "org_a",
      repositoryWorkspaceId: "ws_a",
      dispatchOrganizationId: "org_a",
      dispatchWorkspaceId: "ws_a",
    };
    expect(dispatchTenantTupleMatches(tenant)).toBeTrue();
    expect(dispatchTenantTupleMatches({ ...tenant, repositoryWorkspaceId: "ws_b" })).toBeFalse();

    const binding = {
      dispatchRunnerId: "runner_a",
      runnerId: "runner_a",
      dispatchBootId: "boot_a",
      bootId: "boot_a",
      dispatchBootGeneration: 2,
      bootGeneration: 2,
      dispatchClaimPublicId: "claim_a",
      claimPublicId: "claim_a",
      dispatchClaimFence: 7,
      claimFence: 7,
    };
    expect(dispatchBindingTupleMatches(binding)).toBeTrue();
    expect(dispatchBindingTupleMatches({ ...binding, claimFence: 8 })).toBeFalse();
  });

  test("accepts duplicate prefixes and requires the new suffix to be contiguous", () => {
    expect(
      contiguousEventBatch({
        acceptedThroughSequence: 3,
        events: [
          { id: "event_two", sequence: 2, kind: "codex.starting" },
          { id: "event_three", sequence: 3, kind: "codex.running" },
          { id: "event_four", sequence: 4, kind: "codex.testing" },
        ],
      }),
    ).toBeTrue();
    expect(
      contiguousEventBatch({
        acceptedThroughSequence: 3,
        events: [{ id: "event_five", sequence: 5, kind: "codex.testing" }],
      }),
    ).toBeFalse();
  });

  test("terminal phases cannot be reopened and cancellation requires desired stop", () => {
    expect(nextRunPhase("leased", "run", "worktree.preparing")).toBe("provisioning");
    expect(nextRunPhase("running", "run", "codex.waiting_for_input")).toBe("waiting");
    expect(nextRunPhase("waiting", "run", "codex.editing")).toBe("running");
    expect(nextRunPhase("waiting", "run", "codex.reasoning_summary.delta")).toBe("running");
    expect(nextRunPhase("running", "run", "codex.assistant_message.delta")).toBe("running");
    expect(nextRunPhase("running", "run", "codex.tool_activity.started")).toBe("running");
    expect(nextRunPhase("running", "run", "run.cancelled")).toBeNull();
    expect(nextRunPhase("cancel_requested", "stop", "run.cancelled")).toBe("cancelled");
    expect(nextRunPhase("submitted", "run", "codex.testing")).toBeNull();
  });

  test("display payload shape and replay identity are exact", () => {
    const base = {
      runnerId: "runner_primary0001",
      bootId: "boot_primary0001",
      claimId: "claim_primary001",
      claimFence: 1,
    } as const;
    const display = {
      id: "event_display001",
      sequence: 1,
      kind: "codex.assistant_message.delta" as const,
      displayText: "The checks pass.",
    };
    expect(appendRunEventsRequestSchema.safeParse({ ...base, events: [display] }).success).toBeTrue();
    expect(appendRunEventsRequestSchema.safeParse({
      ...base,
      events: [{ ...display, displayText: undefined }],
    }).success).toBeFalse();
    expect(appendRunEventsRequestSchema.safeParse({
      ...base,
      events: [{ ...display, kind: "codex.running" }],
    }).success).toBeFalse();
    expect(storedRunEventPayloadMatches(display, display)).toBeTrue();
    expect(storedRunEventPayloadMatches(
      { ...display, displayText: "Different" },
      display,
    )).toBeFalse();
    expect(storedRunEventPayloadMatches(
      { ...display, kind: "codex.reasoning_summary.delta" },
      display,
    )).toBeFalse();
    expect(storedRunEventPayloadMatches(
      { kind: "codex.testing" },
      { id: "event_status0001", sequence: 2, kind: "codex.running" },
    )).toBeFalse();
    expect(storedRunEventPayloadMatches(
      { kind: "codex.running", displayText: "forbidden" },
      { id: "event_status0001", sequence: 2, kind: "codex.running" },
    )).toBeFalse();
  });

  test("enforces lifetime display budgets across batches while exact replays remain free", () => {
    const reasoning = Array.from({ length: MAX_RUN_REASONING_SUMMARY_EVENTS }, (_, index) => ({
      sequence: index + 1,
      kind: "codex.reasoning_summary.delta" as const,
    }));
    const tools = Array.from({ length: MAX_RUN_TOOL_ACTIVITY_EVENTS }, (_, index) => ({
      sequence: reasoning.length + index + 1,
      kind: index % 2 === 0
        ? "codex.tool_activity.started" as const
        : "codex.tool_activity.completed" as const,
    }));
    const existingEvents = [...reasoning, ...tools];
    const assistantTail = Array.from({
      length: MAX_RUN_DISPLAY_EVENTS - existingEvents.length,
    }, (_, index) => ({
      sequence: existingEvents.length + index + 1,
      kind: "codex.assistant_message.delta" as const,
    }));
    const accepted = runDisplayBudgetAfterBatch({
      acceptedThroughSequence: existingEvents.length,
      existingEvents,
      events: [
        ...existingEvents.slice(-5),
        ...assistantTail,
      ],
    });
    expect(accepted).toEqual({
      kind: "accepted",
      budget: {
        displayEvents: MAX_RUN_DISPLAY_EVENTS,
        reasoningSummaryEvents: MAX_RUN_REASONING_SUMMARY_EVENTS,
        toolActivityEvents: MAX_RUN_TOOL_ACTIVITY_EVENTS,
      },
    });
    expect(runDisplayBudgetAfterBatch({
      acceptedThroughSequence: existingEvents.length,
      existingEvents,
      events: [...assistantTail, {
        sequence: existingEvents.length + assistantTail.length + 1,
        kind: "codex.assistant_message.delta",
      }],
    })).toEqual({ kind: "limit_exceeded" });
    expect(runDisplayBudgetAfterBatch({
      acceptedThroughSequence: reasoning.length,
      existingEvents: reasoning,
      events: [{
        sequence: reasoning.length + 1,
        kind: "codex.reasoning_summary.delta",
      }],
    })).toEqual({ kind: "limit_exceeded" });
    expect(runDisplayBudgetAfterBatch({
      acceptedThroughSequence: existingEvents.length,
      existingEvents,
      events: [{
        sequence: existingEvents.length + 1,
        kind: "codex.tool_activity.started",
      }],
    })).toEqual({ kind: "limit_exceeded" });
    expect(runDisplayBudgetAfterBatch({
      acceptedThroughSequence: 2,
      existingEvents: [
        { sequence: 1, kind: "codex.running" },
        { sequence: 3, kind: "codex.testing" },
      ],
      events: [],
    })).toEqual({ kind: "invalid_existing" });

    const statuses = Array.from({ length: 94 }, (_, index) => ({
      sequence: index + 1,
      kind: "codex.running" as const,
    }));
    expect(runDisplayBudgetAfterBatch({
      acceptedThroughSequence: statuses.length,
      existingEvents: statuses,
      events: [
        { sequence: 95, kind: "codex.tool_activity.started" },
        { sequence: 96, kind: "codex.editing" },
      ],
    })).toEqual({ kind: "invalid_event" });
    expect(runDisplayBudgetAfterBatch({
      acceptedThroughSequence: statuses.length,
      existingEvents: statuses,
      events: [
        { sequence: 95, kind: "codex.tool_activity.started" },
        { sequence: 96, kind: "codex.tool_activity.completed" },
      ],
    })).toMatchObject({ kind: "accepted" });
    expect(runDisplayBudgetAfterBatch({
      acceptedThroughSequence: statuses.length,
      existingEvents: statuses,
      events: [
        { sequence: 95, kind: "codex.tool_activity.started" },
        { sequence: 96, kind: "codex.tool_activity.completed" },
        { sequence: 97, kind: "run.failed" },
      ],
    })).toMatchObject({ kind: "accepted" });
    expect(runDisplayBudgetAfterBatch({
      acceptedThroughSequence: 0,
      existingEvents: [],
      events: [{ sequence: 1, kind: "codex.tool_activity.completed" }],
    })).toEqual({ kind: "invalid_event" });
  });

  test("reserves bounded history capacity for a terminal event", () => {
    expect(runEventSequenceAllowed(96, "codex.editing")).toBeTrue();
    expect(runEventSequenceAllowed(97, "codex.editing")).toBeFalse();
    expect(runEventSequenceAllowed(100, "run.submitted")).toBeTrue();
    expect(runEventSequenceAllowed(101, "run.failed")).toBeFalse();
  });

  test("rejects execution input that changed and later returned to the same values", () => {
    expect(dispatchSubmissionInputRevisionMatches(7, 7)).toBeTrue();
    expect(dispatchSubmissionInputRevisionMatches(9, 7)).toBeFalse();
  });

  test("dispatch expiry requeues only before the acknowledged side-effect barrier", () => {
    const current = {
      dispatchId: "dispatch_a",
      runnerId: "runner_a",
      bootId: "boot_a",
      bootGeneration: 3,
      taskClaimId: "claim_a",
      claimFence: 8,
      leaseGeneration: 5,
      leaseUntil: now + 90_000,
      phase: "running" as const,
    };
    const scheduled = {
      dispatchId: current.dispatchId,
      runnerId: current.runnerId,
      bootId: current.bootId,
      bootGeneration: current.bootGeneration,
      taskClaimId: current.taskClaimId,
      claimFence: current.claimFence,
      leaseGeneration: current.leaseGeneration,
      expectedDeadline: current.leaseUntil,
    };
    expect(scheduledDispatchExpiryDisposition(current, scheduled, current.leaseUntil - 1)).toBe(
      "reschedule",
    );
    expect(scheduledDispatchExpiryDisposition(current, scheduled, current.leaseUntil)).toBe(
      "ambiguous",
    );
    expect(
      scheduledDispatchExpiryDisposition(
        { ...current, phase: "leased" },
        scheduled,
        current.leaseUntil,
      ),
    ).toBe("requeue");
    expect(
      scheduledDispatchExpiryDisposition(
        current,
        { ...scheduled, leaseGeneration: scheduled.leaseGeneration + 1 },
        current.leaseUntil,
      ),
    ).toBe("stale");
    expect(
      scheduledDispatchExpiryDisposition(
        { ...current, phase: "submitted" },
        scheduled,
        current.leaseUntil,
      ),
    ).toBe("stale");
  });

  test("only proved terminal dispatches release generic task mutations and claim expiry", () => {
    for (const phase of [
      "queued",
      "leased",
      "provisioning",
      "starting",
      "running",
      "waiting",
      "cancel_requested",
      "ambiguous",
    ] as const) {
      expect(taskDispatchBlocksTaskRelease(phase)).toBeTrue();
    }
    for (const phase of ["submitted", "failed", "cancelled"] as const) {
      expect(taskDispatchBlocksTaskRelease(phase)).toBeFalse();
    }
  });

  test("retry appends only from a failed, cancelled, or rejected-submission proof", () => {
    const retryable = {
      sourcePhase: "failed" as const,
      sourceSubmissionRejected: false,
      taskRevision: 8,
      expectedTaskRevision: 8,
      taskStatus: "open" as const,
      taskHasCurrentClaim: false,
      sourceFenceMatches: true,
      anotherDispatchBlocksTask: false,
      sourceAlreadyRetried: false,
    };
    expect(dispatchRetryAllowed(retryable)).toBeTrue();
    expect(dispatchRetryAllowed({ ...retryable, sourcePhase: "cancelled" })).toBeTrue();
    expect(dispatchRetryAllowed({
      ...retryable,
      sourcePhase: "submitted",
      sourceSubmissionRejected: true,
    })).toBeTrue();
    expect(dispatchRetryAllowed({
      ...retryable,
      sourcePhase: "submitted",
    })).toBeFalse();
    expect(dispatchRetryAllowed({ ...retryable, sourcePhase: "ambiguous" })).toBeFalse();
    expect(dispatchRetryAllowed({ ...retryable, taskRevision: 9 })).toBeFalse();
    expect(dispatchRetryAllowed({ ...retryable, sourceFenceMatches: false })).toBeFalse();
    expect(dispatchRetryAllowed({ ...retryable, sourceAlreadyRetried: true })).toBeFalse();
    expect(dispatchRetryAllowed({ ...retryable, anotherDispatchBlocksTask: true })).toBeFalse();
  });

  test("a rejected submission proves only its exact originating dispatch", () => {
    expect(rejectedSubmissionMatchesDispatch({
      sourceDispatchPublicId: "run_source",
      submissionDispatchPublicId: "run_source",
      submissionStatus: "rejected",
    })).toBeTrue();
    expect(rejectedSubmissionMatchesDispatch({
      sourceDispatchPublicId: "run_source",
      submissionDispatchPublicId: "run_other",
      submissionStatus: "rejected",
    })).toBeFalse();
    expect(rejectedSubmissionMatchesDispatch({
      sourceDispatchPublicId: "run_source",
      submissionStatus: "rejected",
    })).toBeFalse();
    expect(rejectedSubmissionMatchesDispatch({
      sourceDispatchPublicId: "run_source",
      submissionDispatchPublicId: "run_source",
      submissionStatus: "pending",
    })).toBeFalse();
  });

  test("ambiguity needs an explicit bounded human declaration and the exact live claim", () => {
    const resolvable = {
      sourcePhase: "ambiguous" as const,
      taskRevision: 11,
      expectedTaskRevision: 11,
      taskStatus: "in_progress" as const,
      taskHasCurrentClaim: true,
      sourceFenceMatches: true,
      anotherDispatchBlocksTask: false,
    };
    expect(resolvedAmbiguousDispatchPhase(resolvable, "confirmed_cancelled")).toBe(
      "cancelled",
    );
    expect(resolvedAmbiguousDispatchPhase(resolvable, "declared_failed")).toBe("failed");
    expect(
      resolvedAmbiguousDispatchPhase(
        { ...resolvable, sourcePhase: "running" },
        "declared_failed",
      ),
    ).toBeNull();
    expect(
      resolvedAmbiguousDispatchPhase(
        { ...resolvable, taskHasCurrentClaim: false },
        "confirmed_cancelled",
      ),
    ).toBeNull();
  });
});
