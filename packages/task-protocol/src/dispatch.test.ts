import { describe, expect, test } from "bun:test";

import {
  DISPATCH_LEASE_MS,
  MAX_DISPATCH_CLAIMS_PER_PULL,
  MAX_RUN_DISPLAY_TEXT_UTF8_BYTES,
  MAX_RUN_DISPLAY_EVENTS,
  MAX_RUN_REASONING_SUMMARY_EVENTS,
  MAX_RUN_TOOL_ACTIVITY_EVENTS,
  MAX_RUN_EVENT_BATCH,
  HRA_DISPATCH_PROTOCOL_VERSION,
  RUNNER_HEARTBEAT_INTERVAL_MS,
  RUNNER_PRESENCE_LEASE_MS,
  agentPresetScopes,
  agentScopeValues,
  appendRunEventsRequestSchema,
  claimDispatchRequestSchema,
  hraDispatchRoutes,
  runnerHeartbeatRequestSchema,
  runnerHeartbeatResponseMatchesRequest,
  runnerHeartbeatResponseSchema,
  runnerPresenceViewSchema,
  runEventViewSchema,
  taskRunViewSchema,
  type RunnerHeartbeatRequest,
} from "./index";

const heartbeat: RunnerHeartbeatRequest = {
  runnerId: "runner_primary0001",
  installationId: "install_primary001",
  bootId: "boot_primary0001",
  bootGeneration: 1,
  sequence: 1,
  protocolVersion: HRA_DISPATCH_PROTOCOL_VERSION,
  clientVersion: "0.1.0",
  reportedState: "ready",
  capacity: 2,
  activeRuns: 0,
  currentRunIds: [],
  retainedRunIds: [],
  repositoryIds: ["repo_0123456789ABCDEFGHJKMNPQRS"],
};

describe("HRA dispatch protocol", () => {
  test("freezes the narrow dispatcher authority and lease cadence", () => {
    expect(agentScopeValues).toContain("runtime:heartbeat");
    expect(agentScopeValues).toContain("runs:report");
    expect(agentScopeValues).toContain("dispatch:execute");
    expect(agentPresetScopes.dispatcher).toEqual([
      "tasks:read",
      "tasks:claim",
      "tasks:submit",
      "comments:write",
      "dispatch:execute",
      "runtime:heartbeat",
      "runs:report",
    ]);
    expect(RUNNER_HEARTBEAT_INTERVAL_MS).toBe(15_000);
    expect(RUNNER_PRESENCE_LEASE_MS).toBe(45_000);
    expect(DISPATCH_LEASE_MS).toBe(90_000);
    expect(MAX_DISPATCH_CLAIMS_PER_PULL).toBe(4);
    expect(MAX_RUN_REASONING_SUMMARY_EVENTS + MAX_RUN_TOOL_ACTIVITY_EVENTS)
      .toBeLessThan(MAX_RUN_DISPLAY_EVENTS);
  });

  test("heartbeat state is strict, capacity-bounded, and internally consistent", () => {
    expect(runnerHeartbeatRequestSchema.parse(heartbeat)).toEqual(heartbeat);
    expect(runnerHeartbeatRequestSchema.safeParse({ ...heartbeat, activeRuns: 3 }).success).toBeFalse();
    expect(runnerHeartbeatRequestSchema.safeParse({
      ...heartbeat,
      currentRunIds: ["run_current00001"],
    }).success).toBeFalse();
    expect(runnerHeartbeatRequestSchema.safeParse({
      ...heartbeat,
      activeRuns: 2,
      currentRunIds: ["run_current00001"],
      retainedRunIds: ["run_current00001", "run_current00001"],
    }).success).toBeFalse();
    expect(runnerHeartbeatRequestSchema.safeParse({ ...heartbeat, repositoryIds: [heartbeat.repositoryIds[0], heartbeat.repositoryIds[0]] }).success).toBeFalse();
    expect(runnerHeartbeatRequestSchema.safeParse({ ...heartbeat, reportedState: "degraded" }).success).toBeFalse();
    expect(runnerHeartbeatRequestSchema.safeParse({ ...heartbeat, secret: "never" }).success).toBeFalse();
    expect(runnerHeartbeatResponseSchema.safeParse({
      serverTime: 100,
      leaseUntil: 99,
      desiredState: "active",
      candidates: [],
      runLeases: [],
      stopRunIds: [],
      releaseRunIds: [],
    }).success).toBeFalse();

    const response = {
      serverTime: 100,
      leaseUntil: 100 + RUNNER_PRESENCE_LEASE_MS,
      desiredState: "active" as const,
      candidates: [{
        taskKey: "OPS-123ABCD",
        repositoryId: "repo_0123456789ABCDEFGHJKMNPQRS",
        queuedAt: 90,
      }],
      runLeases: [{ runId: "run_current00001", leaseUntil: 100 + DISPATCH_LEASE_MS }],
      stopRunIds: ["run_current00001"],
      releaseRunIds: ["run_finished0001"],
    };
    expect(runnerHeartbeatResponseSchema.parse(response)).toEqual(response);
    for (const invalid of [
      { ...response, leaseUntil: response.serverTime + RUNNER_PRESENCE_LEASE_MS + 1 },
      {
        ...response,
        runLeases: [{
          runId: "run_current00001",
          leaseUntil: response.serverTime + DISPATCH_LEASE_MS + 1,
        }],
      },
      {
        ...response,
        runLeases: [{
          runId: "run_current00001",
          leaseUntil: response.serverTime,
        }],
      },
      { ...response, candidates: [response.candidates[0], response.candidates[0]] },
      { ...response, stopRunIds: ["run_missing00001"] },
      { ...response, stopRunIds: ["run_current00001", "run_current00001"] },
      { ...response, releaseRunIds: ["run_finished0001", "run_finished0001"] },
      { ...response, releaseRunIds: ["run_current00001"] },
    ]) {
      expect(runnerHeartbeatResponseSchema.safeParse(invalid).success).toBeFalse();
    }
    const contextualRequest = {
      ...heartbeat,
      activeRuns: 2,
      currentRunIds: ["run_current00001"],
      retainedRunIds: ["run_current00001", "run_finished0001"],
    };
    expect(runnerHeartbeatResponseMatchesRequest(contextualRequest, response)).toBe(true);
    expect(runnerHeartbeatResponseMatchesRequest(contextualRequest, {
      ...response,
      runLeases: [{ runId: "run_foreign00001", leaseUntil: response.serverTime + 1 }],
      stopRunIds: [],
    })).toBe(false);
    expect(runnerHeartbeatResponseMatchesRequest(contextualRequest, {
      ...response,
      releaseRunIds: ["run_foreign00001"],
    })).toBe(false);
    expect(runnerHeartbeatResponseMatchesRequest(contextualRequest, {
      ...response,
      candidates: [{ ...response.candidates[0]!, repositoryId: "repo_11111111111111111111111111" }],
    })).toBe(false);
  });

  test("run events are closed semantic values with contiguous bounded sequences", () => {
    const base = {
      runnerId: heartbeat.runnerId,
      bootId: heartbeat.bootId,
      claimId: "claim_primary001",
      claimFence: 1,
      events: [
        { id: "event_primary001", sequence: 1, kind: "worktree.preparing" as const },
        { id: "event_primary002", sequence: 2, kind: "worktree.ready" as const },
      ],
    };
    expect(appendRunEventsRequestSchema.parse(base)).toEqual(base);
    expect(appendRunEventsRequestSchema.safeParse({
      ...base,
      events: [base.events[0], { ...base.events[1], sequence: 3 }],
    }).success).toBeFalse();
    expect(appendRunEventsRequestSchema.safeParse({
      ...base,
      events: Array.from({ length: MAX_RUN_EVENT_BATCH + 1 }, (_, index) => ({
        id: `event_batch_${String(index).padStart(3, "0")}`,
        sequence: index + 1,
        kind: "codex.running",
      })),
    }).success).toBeFalse();
    expect(appendRunEventsRequestSchema.safeParse({
      ...base,
      events: [{ ...base.events[0], summary: "/Users/person/secret" }],
    }).success).toBeFalse();
  });

  test("run display events admit only bounded summary and assistant deltas", () => {
    const request = {
      runnerId: heartbeat.runnerId,
      bootId: heartbeat.bootId,
      claimId: "claim_primary001",
      claimFence: 1,
      events: [
        {
          id: "event_display0001",
          sequence: 7,
          kind: "codex.reasoning_summary.delta" as const,
          displayText: "Checking the retry boundary…",
        },
        {
          id: "event_display0002",
          sequence: 8,
          kind: "codex.assistant_message.delta" as const,
          displayText: "The focused checks pass.",
        },
        {
          id: "event_display0003",
          sequence: 9,
          kind: "codex.tool_activity.started" as const,
        },
      ],
    };
    expect(appendRunEventsRequestSchema.parse(request)).toEqual(request);
    const firstDisplayEvent = request.events[0];
    if (firstDisplayEvent === undefined) throw new Error("Expected a display event fixture");
    expect(runEventViewSchema.parse({ ...firstDisplayEvent, observedAt: 100 })).toEqual({
      ...firstDisplayEvent,
      observedAt: 100,
    });
    for (const invalid of [
      { ...request.events[0], kind: "codex.reasoning.delta" },
      { ...request.events[0], displayText: "" },
      { ...request.events[0], displayText: "unsafe\u0000text" },
      { ...request.events[0], displayText: "🙂".repeat(MAX_RUN_DISPLAY_TEXT_UTF8_BYTES / 4 + 1) },
      { ...request.events[2], displayText: "tool name, args, or output" },
      { ...request.events[0], toolName: "exec", command: "cat .env" },
    ]) {
      expect(appendRunEventsRequestSchema.safeParse({ ...request, events: [invalid] }).success)
        .toBeFalse();
    }
  });

  test("run views expose one exact contiguous transcript in sequence order", () => {
    const events = [
      { id: "event_view00001", sequence: 1, kind: "codex.running" as const, observedAt: 1 },
      {
        id: "event_view00002",
        sequence: 2,
        kind: "codex.reasoning_summary.delta" as const,
        displayText: "Checking the boundary.",
        observedAt: 2,
      },
      {
        id: "event_view00003",
        sequence: 3,
        kind: "codex.assistant_message.delta" as const,
        displayText: "Done.",
        observedAt: 3,
      },
    ];
    const run = {
      id: "run_primary0001",
      taskKey: "OPS-123ABCD",
      phase: "running" as const,
      repositoryId: "repo_0123456789ABCDEFGHJKMNPQRS",
      desiredState: "run" as const,
      updatedAt: 3,
      events,
      interactions: [],
    };
    expect(taskRunViewSchema.parse(run)).toEqual(run);
    for (const invalidEvents of [
      [...events].reverse(),
      [events[0], { ...events[1], sequence: 1 }, events[2]],
      [events[0], { ...events[1], id: events[0]?.id }, events[2]],
      [events[0], { ...events[1], sequence: 3 }, { ...events[2], sequence: 4 }],
    ]) {
      expect(taskRunViewSchema.safeParse({ ...run, events: invalidEvents }).success).toBeFalse();
    }
    expect(taskRunViewSchema.safeParse({
      ...run,
      events: [{
        id: "event_orphan0001",
        sequence: 1,
        kind: "codex.tool_activity.completed",
        observedAt: 1,
      }],
    }).success).toBeFalse();
    expect(taskRunViewSchema.safeParse({
      ...run,
      events: Array.from({ length: MAX_RUN_DISPLAY_EVENTS + 1 }, (_, index) => ({
        id: `event_over_${String(index).padStart(4, "0")}`,
        sequence: index + 1,
        kind: "codex.assistant_message.delta" as const,
        displayText: "x",
        observedAt: index + 1,
      })),
    }).success).toBeFalse();
    const capacityStatuses = Array.from({ length: 94 }, (_, index) => ({
      id: `event_capacity_${String(index).padStart(3, "0")}`,
      sequence: index + 1,
      kind: "codex.running" as const,
      observedAt: index + 1,
    }));
    expect(taskRunViewSchema.safeParse({
      ...run,
      events: [
        ...capacityStatuses,
        {
          id: "event_capacity_start",
          sequence: 95,
          kind: "codex.tool_activity.started",
          observedAt: 95,
        },
        {
          id: "event_capacity_edit",
          sequence: 96,
          kind: "codex.editing",
          observedAt: 96,
        },
      ],
    }).success).toBeFalse();
  });

  test("runner views distinguish an expired connection from blocked, busy, and ready", () => {
    expect(runnerPresenceViewSchema.parse({ state: "offline", serverTime: 1 })).toEqual({
      state: "offline",
      serverTime: 1,
    });
    expect(runnerPresenceViewSchema.safeParse({ state: "offline", serverTime: 1, leaseUntil: 2 }).success).toBeFalse();
    expect(runnerPresenceViewSchema.safeParse({ state: "blocked", serverTime: 1, leaseUntil: 2 }).success).toBeFalse();
    expect(runnerPresenceViewSchema.safeParse({ state: "ready", serverTime: 1, leaseUntil: 2, availableCapacity: 0 }).success).toBeFalse();
    expect(runnerPresenceViewSchema.safeParse({
      state: "ready",
      serverTime: 1,
      leaseUntil: 1 + RUNNER_PRESENCE_LEASE_MS,
      availableCapacity: 1,
    }).success).toBeTrue();
    for (const leaseUntil of [1, 1 + RUNNER_PRESENCE_LEASE_MS + 1]) {
      expect(runnerPresenceViewSchema.safeParse({
        state: "ready",
        serverTime: 1,
        leaseUntil,
        availableCapacity: 1,
      }).success).toBeFalse();
    }
  });

  test("dispatch routes are outbound HTTPS API locators, never local callback addresses", () => {
    expect(hraDispatchRoutes.heartbeat).toBe("/v1/runtime/heartbeat");
    expect(hraDispatchRoutes.claim).toBe("/v1/dispatch/claim");
    expect(hraDispatchRoutes.events("run_primary0001")).toBe(
      "/v1/dispatch/runs/run_primary0001/events",
    );
    expect(claimDispatchRequestSchema.safeParse({
      runnerId: heartbeat.runnerId,
      bootId: heartbeat.bootId,
      bootGeneration: 1,
      taskKey: "OPS-123ABCD",
      repositoryId: "repo_0123456789ABCDEFGHJKMNPQRS",
      callbackUrl: "http://127.0.0.1:9999",
    }).success).toBeFalse();
  });
});
