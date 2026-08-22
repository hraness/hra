import { describe, expect, test } from "bun:test";

import type { WorkspaceSummary } from "@hraness/agent-tasks-protocol";

import {
  runtimeSnapshotSchema,
  type ChatPaneProjection,
  type RuntimeSnapshot,
} from "../../../contracts/runtime";
import {
  projectAttention,
  type TaskAttentionObservation,
  type WorkspaceSetupAttentionObservation,
} from "./attention-projector";
import { AttentionObservationService } from "./attention-service";

const setupIdentity = {
  setupRequestId: `wssetup_${"a".repeat(32)}`,
  recipeDigest: "b".repeat(64),
  setupRevision: 3,
} as const;

function pane(overrides: Partial<ChatPaneProjection> = {}): ChatPaneProjection {
  return {
    id: "pane_attention0001",
    paletteIndex: 0,
    revision: 1,
    title: "Release audit",
    repository: {
      id: "repo_00000000000000000000000000",
      name: "hra",
    },
    accountProfileId: null,
    interactionMode: "chat",
    state: "ready",
    activity: { ordinal: 0, kind: "idle" },
    workspace: {
      mode: "managedWorktree",
      state: "ready",
      revision: 1,
      recoveryKind: null,
    },
    turn: null,
    attention: null,
    recoverablePrompt: false,
    canStartFreshContext: false,
    schedule: null,
    messageQueue: {
      revision: 1,
      pauseReason: null,
      blockedMessage: null,
      messages: [],
    },
    attachments: { drafts: [], referenced: [] },
    harness: null,
    ...overrides,
  };
}

function snapshot(chatPanes: readonly ChatPaneProjection[] = []): RuntimeSnapshot {
  return runtimeSnapshotSchema.parse({
    revision: 1,
    lastSequence: 0,
    runtime: { state: "ready", generation: 1 },
    runner: { state: "connected" },
    accounts: [{
      id: "acct_attention0001",
      revision: 1,
      label: "Work",
      selected: true,
      identityLabel: "builder@example.com",
      planLabel: "pro",
      weeklyUsage: null,
      authState: "signedIn",
      login: { state: "idle" },
      runtime: { state: "ready", generation: 1 },
    }],
    retainedAccountLocalData: [],
    humanAccount: { state: "signedOut", revision: 0 },
    execution: {
      folderAccess: { revision: 1, displayName: "Documents", availability: "ready" },
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      sandbox: "danger-full-access",
      computerUse: "required",
    },
    chat: { revision: 1, panes: chatPanes },
    sessionSync: {
      status: {
        state: "unavailable",
        reason: "cloudConfigurationMissing",
        retryable: false,
      },
      localGridSlots: [],
      remoteSessions: [],
    },
    harness: null,
  });
}

function workspace(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id: "wsp_00000000000000000000000000",
    name: "Local HRA",
    slug: "local-hra",
    keyPrefix: "KIT",
    revision: 1,
    authority: {
      kind: "local",
      localWorkspaceId: "wsp_00000000000000000000000000",
      ownerInstallationId: "install_attention0001",
    },
    counts: {
      all: { value: 5, capped: false },
      ready: { value: 2, capped: false },
      blocked: { value: 0, capped: false },
      deferred: { value: 0, capped: false },
      attention: { value: 2, capped: false },
      assigned: { value: 1, capped: false },
      review: { value: 1, capped: false },
    },
    ...overrides,
  };
}

function paneReason(
  value: ReturnType<typeof projectAttention>,
): Extract<(typeof value.items)[number], { readonly source: "pane" }>["reason"] {
  const item = value.items.find((candidate) => candidate.source === "pane");
  if (item?.source !== "pane") throw new Error("Expected one pane attention item.");
  return item.reason;
}

describe("gateway attention projector", () => {
  test("selects exactly one pane item using the frozen precedence", () => {
    const recovery = {
      mode: "managedWorktree" as const,
      state: "recoveryRequired" as const,
      revision: 2,
      recoveryKind: "dirtyCheckout" as const,
    };
    const chatAttention = {
      state: "attention" as const,
      attention: {
        code: "approval_required" as const,
        message: "Private provider message that must not cross the observation boundary.",
        retryable: true,
      },
    };
    const queue = {
      revision: 2,
      pauseReason: "ambiguousEffect" as const,
      blockedMessage: {
        id: "chatmsg_attention0001",
        ordinal: 1,
        revision: 1,
        text: "Private queued text",
        attachmentRefs: [],
        deliveryOutcome: "deliveryOutcomeUnknown" as const,
      },
      messages: [],
    };
    const allSignals = snapshot([pane({
      ...chatAttention,
      workspace: recovery,
      messageQueue: queue,
    })]);
    const setups: readonly WorkspaceSetupAttentionObservation[] = [{
      paneId: "pane_attention0001",
      state: "ambiguous",
      ...setupIdentity,
    }, {
      paneId: "pane_attention0001",
      state: "approvalRequired",
      setupRequestId: `wssetup_${"c".repeat(32)}`,
      recipeDigest: "d".repeat(64),
      setupRevision: 4,
    }];
    expect(paneReason(projectAttention({ snapshot: allSignals, setup: setups }))).toEqual({
      kind: "ambiguous_delivery",
    });

    const noDeliveryAmbiguity = snapshot([pane({ ...chatAttention, workspace: recovery })]);
    expect(paneReason(projectAttention({
      snapshot: noDeliveryAmbiguity,
      setup: setups,
    }))).toMatchObject({ kind: "workspace_setup_ambiguous" });
    expect(paneReason(projectAttention({
      snapshot: noDeliveryAmbiguity,
      setup: [{ paneId: "pane_attention0001", state: "approvalRequired", ...setupIdentity }],
    }))).toMatchObject({ kind: "workspace_setup_approval_required" });
    expect(paneReason(projectAttention({
      snapshot: noDeliveryAmbiguity,
      setup: [{
        paneId: "pane_attention0001",
        state: "failed",
        outcome: "timeout",
        ...setupIdentity,
      }],
    }))).toMatchObject({ kind: "workspace_setup_failed", setupOutcome: "timeout" });
    expect(paneReason(projectAttention({ snapshot: noDeliveryAmbiguity }))).toEqual({
      kind: "workspace_recovery",
      recoveryKind: "dirtyCheckout",
    });
    expect(paneReason(projectAttention({
      snapshot: snapshot([pane(chatAttention)]),
    }))).toEqual({ kind: "chat_attention", code: "approval_required" });
    expect(paneReason(projectAttention({
      snapshot: snapshot([pane({
        messageQueue: {
          revision: 2,
          pauseReason: "stop",
          blockedMessage: null,
          messages: [],
        },
      })]),
    }))).toEqual({ kind: "queue_paused", pauseReason: "stop" });
  });

  test("projects only aggregate task attention and review counts", () => {
    const projection = projectAttention({
      snapshot: snapshot(),
      tasks: { completeness: "complete", workspaces: [workspace()] },
    });
    expect(projection.items.filter(({ source }) => source === "workspace")).toEqual([{
      source: "workspace",
      workspaceId: "wsp_00000000000000000000000000",
      name: "Local HRA",
      reason: "task_attention",
      count: { value: 2, capped: false },
    }, {
      source: "workspace",
      workspaceId: "wsp_00000000000000000000000000",
      name: "Local HRA",
      reason: "task_review",
      count: { value: 1, capped: false },
    }]);
    const serialized = JSON.stringify(projection);
    for (const forbidden of ["taskId", "taskKey", "description", "submission", "prompt"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("keeps regular schedules and optional signed-out cloud quiet", () => {
    const scheduled = pane({
      schedule: {
        revision: 1,
        rrule: "DTSTART;TZID=America/Puerto_Rico:20260821T090000\nRRULE:FREQ=DAILY;INTERVAL=1",
        timeZone: "America/Puerto_Rico",
        nextRunAt: "2026-08-22T13:00:00.000Z",
      },
    });
    const projection = projectAttention({
      snapshot: snapshot([scheduled]),
      tasks: { completeness: "cloud_unavailable", workspaces: [] },
    });
    expect(projection.completeness).toBe("complete");
    expect(projection.items).toEqual([]);
  });

  test("reports task authority failure without dropping local attention or retaining rows", async () => {
    let attempt = 0;
    const localSnapshot = runtimeSnapshotSchema.parse({
      ...snapshot([pane({
        state: "attention",
        attention: {
          code: "turn_failed",
          message: "Private failure message",
          retryable: true,
        },
      })]),
      humanAccount: {
        state: "error",
        revision: 2,
        code: "SERVICE_UNAVAILABLE",
        message: "Cloud transport failed.",
        retryable: true,
        profile: null,
      },
    });
    const service = new AttentionObservationService({
      readSnapshot: () => localSnapshot,
      readTasks: () => {
        attempt += 1;
        if (attempt > 1) return Promise.reject(new Error("cloud transport failed"));
        return Promise.resolve({
          completeness: "complete" as const,
          workspaces: [workspace()],
        });
      },
    });
    expect((await service.list()).completeness).toBe("complete");
    const partial = await service.list();
    expect(partial.completeness).toBe("task_authority_unavailable");
    expect(partial.items.some(({ source }) => source === "pane")).toBeTrue();
    expect(partial.items.filter(({ source }) => source === "workspace")).toHaveLength(0);
    expect(JSON.stringify(partial)).not.toContain("Private failure message");
  });

  test("bounds a slow task refresh and returns freshly captured local attention", async () => {
    const attachedCloudFailure = {
      state: "error" as const,
      revision: 2,
      code: "SERVICE_UNAVAILABLE" as const,
      message: "Cloud transport failed.",
      retryable: true,
      profile: null,
    };
    let currentSnapshot = runtimeSnapshotSchema.parse({
      ...snapshot(),
      humanAccount: attachedCloudFailure,
    });
    const observedAbort: { current: boolean } = { current: false };
    const service = new AttentionObservationService({
      readSnapshot: () => currentSnapshot,
      readTasks: async (signal) => await new Promise<TaskAttentionObservation>(
        (_resolve, reject) => {
          signal.addEventListener("abort", () => {
            observedAbort.current = true;
            reject(new Error("cloud task refresh timed out"));
          }, { once: true });
        },
      ),
      taskRefreshTimeoutMilliseconds: 5,
    });
    const listing = service.list();
    currentSnapshot = runtimeSnapshotSchema.parse({
      ...snapshot([pane({
        state: "attention",
        attention: {
          code: "turn_failed",
          message: "Private failure message",
          retryable: true,
        },
      })]),
      humanAccount: attachedCloudFailure,
    });

    const projection = await listing;
    expect(observedAbort.current).toBe(true);
    expect(projection.completeness).toBe("cloud_unavailable");
    expect(projection.items.some(({ source }) => source === "pane")).toBe(true);
    expect(JSON.stringify(projection)).not.toContain("Private failure message");
  });

  test("bounds, coalesces, aborts, and joins an adapter that ignores cancellation", async () => {
    const cachedWorkspace = workspace();
    let taskReads = 0;
    const observedSignal: { current: AbortSignal | null } = { current: null };
    let resolveTaskRead!: (tasks: TaskAttentionObservation) => void;
    const taskRead = new Promise<TaskAttentionObservation>((resolve) => {
      resolveTaskRead = resolve;
    });
    const service = new AttentionObservationService({
      readSnapshot: () => runtimeSnapshotSchema.parse({
        ...snapshot(),
        humanAccount: {
          state: "error",
          revision: 2,
          code: "SERVICE_UNAVAILABLE",
          message: "Cloud transport failed.",
          retryable: true,
          profile: null,
        },
      }),
      readTasks: (signal) => {
        taskReads += 1;
        observedSignal.current = signal;
        return taskRead;
      },
      readTaskFallback: () => ({
        completeness: "cloud_unavailable",
        workspaces: [cachedWorkspace],
      }),
      taskRefreshTimeoutMilliseconds: 5,
    });
    const startedAt = performance.now();
    const projection = await service.list();
    expect(projection.completeness).toBe("cloud_unavailable");
    expect(projection.items.filter(({ source }) => source === "workspace"))
      .toHaveLength(2);
    expect(performance.now() - startedAt).toBeLessThan(100);
    expect(observedSignal.current?.aborted).toBeTrue();

    const concurrentFallback = await service.list();
    expect(concurrentFallback.items.filter(({ source }) => source === "workspace"))
      .toHaveLength(2);
    expect(taskReads).toBe(1);

    service.closeAdmission();
    const settlement = service.settled();
    expect(await Promise.race([
      settlement.then(() => "settled" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 5)),
    ])).toBe("blocked");
    resolveTaskRead({ completeness: "complete", workspaces: [] });
    await settlement;
  });

  test("does not hide task authority failure while optional cloud is signed out", async () => {
    const service = new AttentionObservationService({
      readSnapshot: () => snapshot(),
      readTasks: () => Promise.reject(new Error("local task store failed")),
    });
    expect((await service.list()).completeness).toBe("task_authority_unavailable");
  });

  test("cancels the task adapter before reading local state during shutdown", async () => {
    let snapshotReads = 0;
    const observedSignal: { current: AbortSignal | null } = { current: null };
    const service = new AttentionObservationService({
      readSnapshot: () => {
        snapshotReads += 1;
        return snapshot();
      },
      readTasks: async (signal) => {
        observedSignal.current = signal;
        return await new Promise<TaskAttentionObservation>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(signal.reason instanceof Error
              ? signal.reason
              : new Error("Task attention was aborted."));
          }, { once: true });
        });
      },
    });
    const controller = new AbortController();
    const listing = service.list(controller.signal);
    await Promise.resolve();
    controller.abort(new Error("test shutdown"));

    const rejection = await listing.then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).toMatchObject({ message: "test shutdown" });
    expect(observedSignal.current?.aborted).toBe(true);
    expect(snapshotReads).toBe(0);
  });
});
