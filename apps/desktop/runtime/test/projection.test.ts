import { describe, expect, test } from "bun:test";

import {
  runtimeProtocolVersion,
  type AccountSummary,
  type ChatPaneProjection,
  type RuntimeEvent,
  type RuntimeSnapshot,
} from "../../contracts/runtime";
import {
  ProjectionCoordinatorCapacityTimeoutError,
  ProjectionCommitCoordinator,
  ProjectionCoordinatorClosedError,
  ProjectionCoordinatorSaturationError,
  ProjectionBackpressureError,
  ProjectionPayloadLimitError,
  RuntimeProjection,
  runtimeEventByteCeiling,
} from "../src/projection";
import {
  ProjectionSequenceGapError,
  replayRuntimeEvent,
} from "../src/projection/reducer";

function emptySnapshot(lastSequence = 0): RuntimeSnapshot {
  return {
    revision: 1,
    lastSequence,
    runtime: { state: "ready", generation: 1 },
    runner: { state: "connecting" },
    accounts: [],
    retainedAccountLocalData: [],
    humanAccount: { state: "signedOut", revision: 0 },
    chat: { revision: 1, panes: [] },
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
  };
}

function account(revision = 1): AccountSummary {
  return {
    id: "acct_projection01",
    revision,
    label: "Personal",
    selected: true,
    identityLabel: "builder@example.com",
    planLabel: "pro",
    usageRemainingPercent: 73,
    authState: "signedIn",
    login: { state: "idle" },
    runtime: { state: "ready", generation: 1 },
  };
}

function chatPane(responseMarkdown = "Ready"): ChatPaneProjection {
  return {
    id: "pane_projection01",
    revision: 1,
    title: "Projection",
    repository: {
      id: "repo_00000000000000000000000000",
      name: "example",
    },
    accountProfileId: null,
    interactionMode: "chat",
    state: "ready",
    activity: { ordinal: 1, kind: "responseCompleted" },
    workspace: {
      mode: "managedWorktree",
      state: "ready",
      revision: 1,
      recoveryKind: null,
    },
    turn: {
      id: "chatturn_projection01",
      status: "completed",
      startedAt: "2026-08-03T12:00:00.000Z",
      completedAt: "2026-08-03T12:00:01.000Z",
      continuationCount: 0,
      responseMarkdown: {
        tail: responseMarkdown,
        totalUtf8Bytes: new TextEncoder().encode(responseMarkdown).byteLength,
        truncatedPrefix: false,
      },
      reasoningSummary: {
        tail: "",
        totalUtf8Bytes: 0,
        truncatedPrefix: false,
      },
      tools: [],
      routing: {
        policyVersion: 1,
        classificationReason: "conservativeDefault",
        workClass: "standard",
        requestedProfile: "solMax",
        selectedProfile: "solMax",
        profileFallbackReason: null,
        requestedServiceTier: "standard",
        selectedServiceTier: "standard",
        serviceTierFallbackReason: null,
      },
    },
    attention: null,
    recoverablePrompt: false,
    harness: null,
  };
}

describe("renderer-safe gateway projection", () => {
  test("maintains exact queue bytes across publish and partial drain", () => {
    const projection = new RuntimeProjection(emptySnapshot());
    const accountEvent = { type: "account.upserted", account: account() } as const;
    const runnerEvent = { type: "runner.changed", runner: { state: "connected" } } as const;
    const firstBytes = encodedBytes({
      version: runtimeProtocolVersion,
      sequence: 1,
      event: accountEvent,
    });
    const secondBytes = encodedBytes({
      version: runtimeProtocolVersion,
      sequence: 2,
      event: runnerEvent,
    });

    expect(projection.queuedByteCount).toBe(0);
    projection.publish(accountEvent);
    expect(projection.queuedByteCount).toBe(firstBytes);
    projection.publish(runnerEvent);
    expect(projection.queuedByteCount).toBe(firstBytes + secondBytes);

    expect(projection.drainEvents(0)).toEqual([]);
    expect(projection.queuedByteCount).toBe(firstBytes + secondBytes);
    expect(projection.drainEvents(1)).toMatchObject([{ sequence: 1 }]);
    expect(projection.queuedByteCount).toBe(secondBytes);
    expect(projection.drainEvents()).toMatchObject([{ sequence: 2 }]);
    expect(projection.queuedByteCount).toBe(0);
  });

  test("queues only bounded account and readiness events", () => {
    const projection = new RuntimeProjection(emptySnapshot());
    projection.publish({ type: "account.upserted", account: account() });
    projection.publish({ type: "runner.changed", runner: { state: "connected" } });

    const events = projection.drainEvents();
    expect(events.map(({ event }) => event.type)).toEqual([
      "account.upserted",
      "runner.changed",
    ]);
    expect(events.every((event) => encodedBytes(event) <= runtimeEventByteCeiling)).toBeTrue();
    const capture = projection.beginSnapshot();
    expect(capture.response.snapshot).toMatchObject({
      lastSequence: 2,
      accounts: [{ id: account().id }],
      runner: { state: "connected" },
    });
    capture.release();
  });

  test("restores persisted pane clocks through the bootstrap snapshot", () => {
    const projection = new RuntimeProjection(emptySnapshot());
    const restored = { ...chatPane(), revision: 9 };
    projection.installBootstrapChatState([restored]);

    const initial = projection.beginSnapshot();
    expect(initial.response.snapshot.chat).toEqual({
      revision: 1,
      panes: [restored],
    });
    initial.release();

    projection.publish({
      type: "chat.pane.upserted",
      revision: 10,
      pane: { ...restored, revision: 10, title: "Renamed" },
    });
    const next = projection.beginSnapshot();
    expect(next.response.snapshot.chat).toMatchObject({
      revision: 2,
      panes: [{ revision: 10, title: "Renamed" }],
    });
    next.release();
  });

  test("bootstrap chat state can be installed only once", () => {
    const projection = new RuntimeProjection(emptySnapshot());
    projection.installBootstrapChatState([]);
    expect(() => projection.installBootstrapChatState([])).toThrow(
      "Bootstrap chat state was already installed",
    );
  });

  test("snapshot capture discards represented state but preserves operation completion", () => {
    const projection = new RuntimeProjection(emptySnapshot());
    projection.publish({ type: "account.upserted", account: account() });
    projection.publish({
      type: "operation.completed",
      operationId: "op_projection01",
      outcome: { ok: true },
    });

    const capture = projection.beginSnapshot();
    expect(capture.response.snapshot.lastSequence).toBe(2);
    expect(projection.drainEvents()).toEqual([]);
    capture.release();
    expect(projection.drainEvents()).toMatchObject([{
      sequence: 3,
      event: { type: "operation.completed", operationId: "op_projection01" },
    }]);
  });

  test("snapshot capture preserves scoped task invalidations outside global state", () => {
    const projection = new RuntimeProjection(emptySnapshot());
    projection.publish({
      type: "task.invalidated",
      invalidation: {
        workspaceId: "wsp_00000000000000000000000000",
        projectionRevision: 11,
        scope: "task_detail",
        taskId: "tsk_00000000000000000000000000",
      },
    });

    const capture = projection.beginSnapshot();
    expect(capture.response.snapshot.lastSequence).toBe(1);
    expect("taskDetail" in capture.response.snapshot).toBeFalse();
    expect(projection.drainEvents()).toEqual([]);
    capture.release();
    expect(projection.drainEvents()).toMatchObject([{
      sequence: 2,
      event: {
        type: "task.invalidated",
        invalidation: { projectionRevision: 11 },
      },
    }]);
  });

  test("snapshot capture accounts for protected resequencing and later publication", () => {
    let notifications = 0;
    const projection = new RuntimeProjection(emptySnapshot(), {
      onEventsAvailable: () => {
        notifications += 1;
      },
    });
    const stateEvent = { type: "runner.changed", runner: { state: "connected" } } as const;
    const operationEvent = {
      type: "operation.completed",
      operationId: "op_projection01",
      outcome: { ok: true },
    } as const;
    const taskEvent = {
      type: "task.invalidated",
      invalidation: {
        workspaceId: "wsp_00000000000000000000000000",
        projectionRevision: 11,
        scope: "workspace",
      },
    } as const;
    projection.publish(stateEvent);
    projection.publish(operationEvent);
    projection.publish(taskEvent);
    expect(notifications).toBe(3);

    const capture = projection.beginSnapshot();
    const resequencedOperationBytes = encodedBytes({
      version: runtimeProtocolVersion,
      sequence: 4,
      event: operationEvent,
    });
    const resequencedTaskBytes = encodedBytes({
      version: runtimeProtocolVersion,
      sequence: 5,
      event: taskEvent,
    });
    expect(projection.queuedByteCount).toBe(
      resequencedOperationBytes + resequencedTaskBytes,
    );

    projection.publish({ type: "runner.changed", runner: { state: "connecting" } });
    const laterEventBytes = encodedBytes({
      version: runtimeProtocolVersion,
      sequence: 6,
      event: { type: "runner.changed", runner: { state: "connecting" } },
    });
    const capturedQueueBytes =
      resequencedOperationBytes + resequencedTaskBytes + laterEventBytes;
    expect(projection.queuedByteCount).toBe(capturedQueueBytes);
    expect(projection.drainEvents()).toEqual([]);
    expect(projection.queuedByteCount).toBe(capturedQueueBytes);
    expect(notifications).toBe(3);

    capture.release();
    capture.release();
    expect(notifications).toBe(4);
    expect(projection.queuedByteCount).toBe(capturedQueueBytes);
    expect(projection.drainEvents(1)).toMatchObject([{
      sequence: 4,
      event: { type: "operation.completed" },
    }]);
    expect(projection.queuedByteCount).toBe(resequencedTaskBytes + laterEventBytes);
    expect(projection.drainEvents()).toHaveLength(2);
    expect(projection.queuedByteCount).toBe(0);
  });

  test("failed protected resequencing preserves the original queue and byte total", () => {
    const operationEvent = {
      type: "operation.completed",
      operationId: "op_projection01",
      outcome: { ok: true },
    } as const;
    const originalBytes = encodedBytes({
      version: runtimeProtocolVersion,
      sequence: 9,
      event: operationEvent,
    });
    const resequencedBytes = encodedBytes({
      version: runtimeProtocolVersion,
      sequence: 10,
      event: operationEvent,
    });
    expect(resequencedBytes).toBeGreaterThan(originalBytes);
    const projection = new RuntimeProjection(emptySnapshot(8), {
      maxQueuedBytes: originalBytes,
    });
    projection.publish(operationEvent);
    expect(projection.queuedByteCount).toBe(originalBytes);

    expect(() => projection.beginSnapshot()).toThrow(ProjectionBackpressureError);
    expect(projection.lastSequence).toBe(9);
    expect(projection.queuedEventCount).toBe(1);
    expect(projection.queuedByteCount).toBe(originalBytes);
    expect(projection.drainEvents()).toMatchObject([{
      sequence: 9,
      event: { type: "operation.completed" },
    }]);
    expect(projection.queuedByteCount).toBe(0);
  });

  test("backpressure rejects without consuming sequence or state", () => {
    const projection = new RuntimeProjection(emptySnapshot(), { maxQueuedEvents: 1 });
    projection.publish({ type: "account.upserted", account: account() });
    expect(() => projection.publish({
      type: "runner.changed",
      runner: { state: "connected" },
    })).toThrow(ProjectionBackpressureError);
    expect(projection.lastSequence).toBe(1);
    const queuedBytes = projection.queuedByteCount;
    expect(queuedBytes).toBeGreaterThan(0);
    expect(projection.drainEvents()).toHaveLength(1);
    expect(projection.queuedByteCount).toBe(0);
    projection.publish({ type: "runner.changed", runner: { state: "connected" } });
    expect(projection.queuedByteCount).toBeGreaterThan(0);
    expect(projection.drainEvents()[0]?.sequence).toBe(2);
    expect(projection.queuedByteCount).toBe(0);
  });

  test("shares one bounded capacity wait per generation", async () => {
    const projection = new RuntimeProjection(emptySnapshot());
    const observed = projection.capacityGeneration;
    const first = projection.waitForCapacityChange(observed);
    const second = projection.waitForCapacityChange(observed);
    expect(second).toBe(first);
    projection.publish({ type: "runner.changed", runner: { state: "connected" } });
    expect(projection.drainEvents()).toHaveLength(1);
    expect(await first).toBe(observed + 1);
    expect(await second).toBe(observed + 1);
  });

  test("awaits real capacity while a snapshot protects exact events", async () => {
    const projection = new RuntimeProjection(emptySnapshot(), { maxQueuedEvents: 1 });
    const coordinator = new ProjectionCommitCoordinator(projection);
    projection.publish({
      type: "operation.completed",
      operationId: "op_projection01",
      outcome: { ok: true },
    });
    const capture = projection.beginSnapshot();
    let completions = 0;
    const pending = coordinator.publish({
      type: "operation.completed",
      operationId: "op_projection02",
      outcome: { ok: true },
    }).then(() => {
      completions += 1;
    });

    await Promise.resolve();
    expect(completions).toBe(0);
    expect(coordinator.pendingCommitCount).toBe(1);
    expect(projection.drainEvents()).toEqual([]);
    capture.release();
    capture.release();
    await Promise.resolve();
    expect(completions).toBe(0);

    expect(projection.drainEvents()).toMatchObject([{
      sequence: 2,
      event: { type: "operation.completed", operationId: "op_projection01" },
    }]);
    await pending;
    expect(completions).toBe(1);
    expect(coordinator.pendingCommitCount).toBe(0);
    expect(projection.drainEvents()).toMatchObject([{
      sequence: 3,
      event: { type: "operation.completed", operationId: "op_projection02" },
    }]);
  });

  test("serializes recoverable installation and settles admitted commits", async () => {
    const projection = new RuntimeProjection(emptySnapshot(), { maxQueuedEvents: 1 });
    const coordinator = new ProjectionCommitCoordinator(projection);
    projection.publish({
      type: "operation.completed",
      operationId: "op_projection01",
      outcome: { ok: true },
    });
    const pane = chatPane("x".repeat(runtimeEventByteCeiling + 1));
    const install = coordinator.installRecoverableState({
      type: "chat.pane.upserted",
      revision: pane.revision,
      pane,
    });
    const settled = coordinator.settled();

    await Promise.resolve();
    expect(coordinator.pendingCommitCount).toBe(1);
    projection.drainEvents();
    await Promise.all([install, settled]);
    expect(projection.drainEvents()).toMatchObject([{
      sequence: 2,
      event: { type: "snapshot.invalidated", reason: "projectionOverflow" },
    }]);

    projection.publish({
      type: "operation.completed",
      operationId: "op_projection02",
      outcome: { ok: true },
    });
    const harnessInstall = coordinator.installHarnessState({
      harness: {
        revision: 1,
        settings: {
          revision: 1,
          recursiveSessionsEnabled: false,
          contextQuotaBytes: 16 * 1024 * 1024,
          refinementMode: "off",
        },
        proposals: [],
      },
      panes: [{ paneId: pane.id, harness: null }],
    });
    await Promise.resolve();
    expect(coordinator.pendingCommitCount).toBe(1);
    projection.drainEvents();
    await harnessInstall;
    expect(projection.drainEvents()).toMatchObject([{
      sequence: 4,
      event: { type: "snapshot.invalidated", reason: "harnessChanged" },
    }]);

    coordinator.closeAdmission();
    const closedError = await coordinator.publish({
      type: "runner.changed",
      runner: { state: "connected" },
    }).then(() => null, (error: unknown) => error);
    expect(closedError).toBeInstanceOf(ProjectionCoordinatorClosedError);
  });

  test("bounds admitted commit closures while projection capacity is stalled", async () => {
    const projection = new RuntimeProjection(emptySnapshot(), { maxQueuedEvents: 1 });
    const coordinator = new ProjectionCommitCoordinator(projection, {
      maxPendingCommits: 1,
    });
    projection.publish({
      type: "operation.completed",
      operationId: "op_projection01",
      outcome: { ok: true },
    });
    const capture = projection.beginSnapshot();
    const admitted = coordinator.publish({
      type: "operation.completed",
      operationId: "op_projection02",
      outcome: { ok: true },
    });
    await Promise.resolve();
    expect(coordinator.pendingCommitCount).toBe(1);

    const rejected = await coordinator.publish({
      type: "operation.completed",
      operationId: "op_projection03",
      outcome: { ok: true },
    }).then(() => null, (error: unknown) => error);
    expect(rejected).toBeInstanceOf(ProjectionCoordinatorSaturationError);
    expect(rejected).toMatchObject({ capacity: 1, pending: 1 });
    expect(coordinator.pendingCommitCount).toBe(1);

    capture.release();
    projection.drainEvents();
    await admitted;
    expect(coordinator.pendingCommitCount).toBe(0);
    expect(projection.drainEvents()).toMatchObject([{
      event: { operationId: "op_projection02" },
    }]);
  });

  test("a stalled renderer drain fails all commits once and cannot pin shutdown", async () => {
    const projection = new RuntimeProjection(emptySnapshot(), { maxQueuedEvents: 1 });
    const failures: ProjectionCoordinatorCapacityTimeoutError[] = [];
    const coordinator = new ProjectionCommitCoordinator(projection, {
      capacityWaitTimeoutMs: 10,
      onCapacityTimeout: (error) => { failures.push(error); },
    });
    projection.publish({
      type: "operation.completed",
      operationId: "op_projection01",
      outcome: { ok: true },
    });
    const capture = projection.beginSnapshot();
    const first = coordinator.publish({
      type: "operation.completed",
      operationId: "op_projection02",
      outcome: { ok: true },
    });
    const second = coordinator.publish({
      type: "operation.completed",
      operationId: "op_projection03",
      outcome: { ok: true },
    });

    const [firstError, secondError] = await Promise.all([
      first.then(() => null, (error: unknown) => error),
      second.then(() => null, (error: unknown) => error),
    ]);
    await coordinator.settled();
    expect(firstError).toBeInstanceOf(ProjectionCoordinatorCapacityTimeoutError);
    if (!(firstError instanceof ProjectionCoordinatorCapacityTimeoutError)) {
      throw new Error("Expected the projection capacity watchdog to expire");
    }
    expect(secondError).toBe(firstError);
    expect(firstError).toMatchObject({ timeoutMs: 10, pending: 2 });
    expect(failures).toEqual([firstError]);
    expect(coordinator.pendingCommitCount).toBe(0);

    const rejected = await coordinator.publish({
      type: "runner.changed",
      runner: { state: "connected" },
    }).then(() => null, (error: unknown) => error);
    expect(rejected).toBe(firstError);
    expect(failures).toEqual([firstError]);

    const terminalSequence = projection.lastSequence;
    capture.release();
    expect(projection.drainEvents()).toMatchObject([{
      sequence: terminalSequence,
      event: { operationId: "op_projection01" },
    }]);
    expect(projection.lastSequence).toBe(terminalSequence);
  });

  test("configured event byte ceilings fail before mutation", () => {
    const projection = new RuntimeProjection(emptySnapshot(), {
      maxEventBytes: 180,
      maxQueuedBytes: 1_000,
    });
    expect(() => projection.publish({
      type: "account.upserted",
      account: account(),
    })).toThrow(ProjectionPayloadLimitError);
    expect(projection.lastSequence).toBe(0);
    expect(projection.queuedByteCount).toBe(0);
  });

  test("reports escaped legal deltas through the projection payload authority", () => {
    const base = chatPane("");
    const baseTurn = base.turn;
    if (baseTurn === null) throw new Error("Expected the chat fixture turn");
    const pane: ChatPaneProjection = {
      ...base,
      state: "streaming",
      turn: {
        ...baseTurn,
        status: "streaming",
        completedAt: null,
      },
    };
    const projection = new RuntimeProjection({
      ...emptySnapshot(),
      chat: { revision: 1, panes: [pane] },
    });
    const delta = {
      type: "chat.turn.delta",
      paneId: pane.id,
      turnId: baseTurn.id,
      revision: 2,
      channel: "responseMarkdown",
      startUtf8Offset: 0,
      delta: "\\".repeat(4_096),
    } as const;

    expect(() => projection.publish(delta)).toThrow(ProjectionPayloadLimitError);
    expect(projection.lastSequence).toBe(0);
    expect(projection.queuedEventCount).toBe(0);

    projection.installRecoverableState(delta);
    expect(projection.drainEvents()).toMatchObject([{
      sequence: 1,
      event: { type: "snapshot.invalidated", reason: "projectionOverflow" },
    }]);
    const capture = projection.beginSnapshot();
    expect(capture.response.snapshot.chat.panes[0]).toMatchObject({
      revision: 2,
      turn: {
        responseMarkdown: {
          tail: delta.delta,
          totalUtf8Bytes: 4_096,
        },
      },
    });
    capture.release();
  });

  test("still rejects malformed domain events before projection mutation", () => {
    const projection = new RuntimeProjection(emptySnapshot());
    const malformed = {
      type: "runner.changed",
      runner: { state: "connected" },
    } as const;
    Object.defineProperty(malformed.runner, "state", {
      value: "not-a-runtime-state",
    });
    expect(() => projection.publish(malformed)).toThrow();
    expect(projection.lastSequence).toBe(0);
    expect(projection.queuedEventCount).toBe(0);
  });

  test("installs oversized recoverable state and delivers only an invalidation", () => {
    const projection = new RuntimeProjection(emptySnapshot());
    const pane = chatPane("x".repeat(runtimeEventByteCeiling + 1));

    projection.installRecoverableState({
      type: "chat.pane.upserted",
      revision: pane.revision,
      pane,
    });

    expect(projection.drainEvents()).toEqual([{
      version: runtimeProtocolVersion,
      sequence: 1,
      event: { type: "snapshot.invalidated", reason: "projectionOverflow" },
    }]);
    const capture = projection.beginSnapshot();
    expect(capture.response.snapshot).toMatchObject({
      revision: 2,
      lastSequence: 1,
      chat: {
        revision: 2,
        panes: [{
          id: pane.id,
          revision: 1,
          turn: { responseMarkdown: { tail: pane.turn?.responseMarkdown.tail } },
        }],
      },
    });
    capture.release();
  });

  test("publishes long-pane lifecycle state without invalidating the global snapshot", () => {
    const responseMarkdown = "long-response🙂".repeat(700);
    const pane = chatPane(responseMarkdown);
    const projection = new RuntimeProjection({
      ...emptySnapshot(),
      chat: { revision: 1, panes: [pane] },
    });

    projection.publish({
      type: "chat.pane.stateChanged",
      revision: 2,
      pane: {
        id: pane.id,
        revision: 2,
        title: "Settled projection",
        accountProfileId: pane.accountProfileId,
        interactionMode: pane.interactionMode,
        state: "ready",
        activity: pane.activity,
        workspace: pane.workspace,
        turn: {
          id: pane.turn!.id,
          status: "completed",
          startedAt: pane.turn!.startedAt,
          completedAt: pane.turn!.completedAt,
          continuationCount: 0,
          tools: [{
            id: "chattool_projection01",
            category: "command",
            status: "completed",
          }],
          routing: pane.turn!.routing,
          },
          attention: null,
          recoverablePrompt: false,
        },
    });

    expect(projection.drainEvents()).toMatchObject([{
      sequence: 1,
      event: { type: "chat.pane.stateChanged", revision: 2 },
    }]);
    const capture = projection.beginSnapshot();
    expect(capture.response.snapshot.chat.panes[0]).toMatchObject({
      revision: 2,
      title: "Settled projection",
      turn: {
        responseMarkdown: { tail: responseMarkdown },
        tools: [{ status: "completed" }],
      },
    });
    capture.release();
  });

  test("recoverable installation is atomic under backpressure", () => {
    const projection = new RuntimeProjection(emptySnapshot(), {
      maxQueuedBytes: 1,
    });
    const pane = chatPane("x".repeat(runtimeEventByteCeiling + 1));

    expect(() => projection.installRecoverableState({
      type: "chat.pane.upserted",
      revision: pane.revision,
      pane,
    })).toThrow(ProjectionBackpressureError);
    expect(projection.lastSequence).toBe(0);
    expect(projection.queuedEventCount).toBe(0);
    const capture = projection.beginSnapshot();
    expect(capture.response.snapshot.chat).toEqual({ revision: 1, panes: [] });
    capture.release();
  });

  test("installs global proposals and pane descendants atomically", () => {
    const pane = chatPane();
    const projection = new RuntimeProjection({
      ...emptySnapshot(),
      chat: { revision: 1, panes: [pane] },
    });
    const proposal = {
      id: "hproposal_projection01",
      revision: 1,
      title: "Prefer narrower context",
    };
    const child = {
      id: "hactor_projectionchild01",
      revision: 1,
      title: "Inspect the narrow context",
      state: "idle" as const,
      openedPaneId: null,
      canOpen: true,
      canMessage: false,
      canStop: true,
    };

    projection.installHarnessState({
      harness: {
        revision: 1,
        settings: {
          revision: 1,
          recursiveSessionsEnabled: false,
          contextQuotaBytes: 16 * 1024 * 1024,
          refinementMode: "off",
        },
        proposals: [proposal],
      },
      panes: [{
        paneId: pane.id,
        harness: {
          revision: 1,
          descendants: { count: 1, truncated: false, children: [child] },
        },
      }],
    });

    expect(projection.drainEvents()).toMatchObject([{
      sequence: 1,
      event: { type: "snapshot.invalidated", reason: "harnessChanged" },
    }]);
    const capture = projection.beginSnapshot();
    expect(capture.response.snapshot.harness?.proposals).toEqual([proposal]);
    expect(capture.response.snapshot.chat.panes[0]?.harness?.descendants)
      .toEqual({ count: 1, truncated: false, children: [child] });
    capture.release();
  });

  test("treats semantically equal harness state as a queue- and sequence-preserving no-op", () => {
    const pane = chatPane();
    let notifications = 0;
    const projection = new RuntimeProjection({
      ...emptySnapshot(),
      chat: { revision: 1, panes: [pane] },
    }, {
      maxQueuedEvents: 1,
      onEventsAvailable: () => {
        notifications += 1;
      },
    });
    const installed = {
      harness: {
        revision: 1,
        settings: {
          revision: 1,
          recursiveSessionsEnabled: false,
          contextQuotaBytes: 16 * 1024 * 1024,
          refinementMode: "off" as const,
        },
        proposals: [],
      },
      panes: [{ paneId: pane.id, harness: null }],
    };

    projection.installHarnessState(installed);
    expect(projection.lastSequence).toBe(1);
    expect(projection.queuedEventCount).toBe(1);
    expect(notifications).toBe(1);

    // A fresh SQLite read has distinct object identities but the same exact
    // renderer meaning. It must succeed even while the one-slot queue is full.
    projection.installHarnessState(structuredClone(installed));
    expect(projection.lastSequence).toBe(1);
    expect(projection.queuedEventCount).toBe(1);
    expect(notifications).toBe(1);

    projection.drainEvents();
    projection.installHarnessState({
      ...installed,
      harness: {
        ...installed.harness,
        revision: 2,
        settings: {
          ...installed.harness.settings,
          revision: 2,
          recursiveSessionsEnabled: true,
        },
      },
    });
    expect(projection.drainEvents()).toMatchObject([{
      sequence: 2,
      event: { type: "snapshot.invalidated", reason: "harnessChanged" },
    }]);
    expect(notifications).toBe(2);
  });

  test("rejects a half-installed child attachment without changing state", () => {
    const pane = chatPane();
    const projection = new RuntimeProjection({
      ...emptySnapshot(),
      chat: { revision: 1, panes: [pane] },
    });

    expect(() => projection.installHarnessState({
      harness: {
        revision: 1,
        settings: {
          revision: 1,
          recursiveSessionsEnabled: false,
          contextQuotaBytes: 16 * 1024 * 1024,
          refinementMode: "off",
        },
        proposals: [],
      },
      panes: [{
        paneId: pane.id,
        harness: {
          revision: 1,
          descendants: {
            count: 1,
            truncated: false,
            children: [{
              id: "hactor_projectionmissing01",
              revision: 1,
              title: "Missing pane",
              state: "idle",
              openedPaneId: "pane_projectionmissing01",
              canOpen: false,
              canMessage: true,
              canStop: true,
            }],
          },
        },
      }],
    })).toThrow();
    expect(projection.lastSequence).toBe(0);
    expect(projection.queuedEventCount).toBe(0);
    const capture = projection.beginSnapshot();
    expect(capture.response.snapshot.harness).toBeNull();
    expect(capture.response.snapshot.chat.panes[0]?.harness).toBeNull();
    capture.release();
  });

  test("rejects transient events from recoverable installation", () => {
    const projection = new RuntimeProjection(emptySnapshot());
    expect(() => projection.installRecoverableState({
      type: "operation.completed",
      operationId: "op_projection01",
      outcome: { ok: true },
    })).toThrow("Cannot install transient runtime event");
    expect(projection.lastSequence).toBe(0);
    expect(projection.queuedEventCount).toBe(0);
  });

  test("replay ignores duplicates and rejects sequence gaps", () => {
    const event: RuntimeEvent = {
      version: runtimeProtocolVersion,
      sequence: 1,
      event: { type: "account.upserted", account: account() },
    };
    const first = replayRuntimeEvent(emptySnapshot(), event);
    expect(replayRuntimeEvent(first, event)).toBe(first);
    expect(() => replayRuntimeEvent(first, { ...event, sequence: 3 })).toThrow(
      ProjectionSequenceGapError,
    );
  });
});

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
