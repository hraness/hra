import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";

import {
  runtimeProtocolVersion,
  runtimeProjectAddCommand,
  runtimeEventName,
  runtimeTransportHealthCommand,
  runtimeTransportLifecycleEventName,
  runtimeTransportRetryCommand,
  type ChatPaneProjection,
  type RuntimeDispatchResponse,
  type RuntimeTaskDispatchResponse,
} from "../../contracts/runtime";
import {
  createRuntimeBridge,
  nativeUiScaleShortcutIds,
  RuntimeBridgeProtocolError,
  RuntimeBridgeTransportTimeoutError,
  subscribeNativeUiScaleShortcuts,
  type RuntimeTransport,
  uiScaleCommandFromNativeShortcut,
} from "./runtime-bridge";
import {
  accountUpsertEvent,
  emptyRuntimeSnapshot,
  fixtureAccount,
} from "./runtime/test-fixtures";

interface TransportHarness {
  readonly transport: RuntimeTransport;
  readonly invocations: Array<{ readonly command: string; readonly payload: unknown }>;
  emit(value: unknown, name?: string): void;
}

const workspaceId = "wsp_00000000000000000000000000";
const workspaceSummary = {
  id: workspaceId,
  name: "Local hra",
  slug: "local-hra",
  keyPrefix: "KIT",
  revision: 7,
  authority: {
    kind: "local",
    localWorkspaceId: workspaceId,
    ownerInstallationId: "install_local0001",
  },
  counts: {
    all: { capped: false, value: 1 },
    ready: { capped: false, value: 1 },
    blocked: { capped: false, value: 0 },
    deferred: { capped: false, value: 0 },
    attention: { capped: false, value: 0 },
    assigned: { capped: false, value: 0 },
    review: { capped: false, value: 0 },
  },
} as const;

const bridgeChatPane: ChatPaneProjection = {
  id: "pane_bridgechat001",
  paletteIndex: 0,
  revision: 1,
  title: "HRA",
  repository: { id: "repo_00000000000000000000000000", name: "hra" },
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
  messageQueue: { revision: 1, pauseReason: null, blockedMessage: null, messages: [] },
  attachments: { drafts: [], referenced: [] },
  harness: null,
};

function transportHarness(response: (payload: unknown) => unknown): TransportHarness {
  const invocations: Array<{ readonly command: string; readonly payload: unknown }> = [];
  const listeners = new Map<string, (value: unknown) => void>();
  return {
    invocations,
    transport: {
      invoke(command, payload) {
        invocations.push({ command, payload });
        return Promise.resolve(response(payload));
      },
      on(name, callback) {
        listeners.set(name, callback);
        return () => {
          if (listeners.get(name) === callback) listeners.delete(name);
        };
      },
    },
    emit(value, name = runtimeEventName) {
      const listener = listeners.get(name);
      if (listener === undefined) throw new Error("No native event listener is registered.");
      listener(value);
    },
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (reason: unknown) {
    return reason;
  }
  throw new Error("Expected the promise to reject.");
}

describe("runtime bridge", () => {
  test("uses the read-only v2 snapshot command and parses its response", async () => {
    const snapshot = emptyRuntimeSnapshot(12);
    const harness = transportHarness(() => ({ version: runtimeProtocolVersion, snapshot }));

    expect(await createRuntimeBridge(harness.transport).snapshot()).toEqual(snapshot);
    expect(harness.invocations).toEqual([
      { command: "hra.runtime.snapshot", payload: { version: runtimeProtocolVersion } },
    ]);
  });

  test("assembles a paged snapshot before exposing it", async () => {
    const snapshot = {
      ...emptyRuntimeSnapshot(22),
      accounts: [fixtureAccount({ label: "before 🌿 after" })],
    };
    const bytes = new TextEncoder().encode(JSON.stringify({
      version: runtimeProtocolVersion,
      snapshot,
    }));
    const emojiStart = bytes.findIndex((byte) => byte === 0xf0);
    if (emojiStart < 0) throw new Error("Expected a multibyte fixture");
    const split = emojiStart + 1;
    const chunks = [bytes.slice(0, split), bytes.slice(split)];
    const harness = transportHarness((payload) => {
      const index = typeof payload === "object" && payload !== null && "index" in payload
        ? Number(payload.index)
        : 0;
      const chunk = chunks[index];
      if (chunk === undefined) throw new Error("Unexpected snapshot chunk index");
      return {
        version: runtimeProtocolVersion,
        transferId: "snapshot_12345678",
        index,
        count: chunks.length,
        base64: Buffer.from(chunk).toString("base64"),
      };
    });

    expect(await createRuntimeBridge(harness.transport).snapshot()).toEqual(snapshot);
    expect(harness.invocations).toEqual([
      { command: "hra.runtime.snapshot", payload: { version: runtimeProtocolVersion } },
      {
        command: "hra.runtime.snapshot",
        payload: {
          version: runtimeProtocolVersion,
          transferId: "snapshot_12345678",
          index: 1,
        },
      },
    ]);
  });

  test("uses the typed dispatch command and enforces operation correlation", async () => {
    const harness = transportHarness((payload) => {
      if (typeof payload !== "object" || payload === null || !("operationId" in payload)) {
        throw new Error("Expected an operation envelope.");
      }
      return {
        version: runtimeProtocolVersion,
        operationId: payload.operationId,
        ok: true,
        result: { type: "accepted" },
      };
    });
    const bridge = createRuntimeBridge(harness.transport, {
      createOperationId: () => "op_12345678",
    });

    expect(await bridge.dispatch({
      type: "runtime.restartAccount",
      accountProfileId: "acct_personal01",
    })).toMatchObject({
      operationId: "op_12345678",
      ok: true,
    });
    expect(harness.invocations).toEqual([
      {
        command: "hra.runtime.dispatch",
        payload: {
          version: runtimeProtocolVersion,
          operationId: "op_12345678",
          command: {
            type: "runtime.restartAccount",
            accountProfileId: "acct_personal01",
          },
        },
      },
    ]);

    const mismatched = transportHarness(() => ({
      version: runtimeProtocolVersion,
      operationId: "op_87654321",
      ok: true,
      result: { type: "accepted" },
    }));
    expect(await rejectionOf(
      createRuntimeBridge(mismatched.transport, {
        createOperationId: () => "op_12345678",
      }).dispatch({
        type: "runtime.restartAccount",
        accountProfileId: "acct_personal01",
      }),
    )).toBeInstanceOf(RuntimeBridgeProtocolError);
  });

  test("correlates harness settings through the exact harness parser", async () => {
    const operationId = "op_harnesssettings1";
    const command = {
      type: "harness.settings.update" as const,
      expectedHarnessRevision: 4,
      expectedRevision: 3,
      recursiveSessionsEnabled: true,
      contextQuotaBytes: 16 * 1024 * 1024,
      refinementMode: "suggest" as const,
    };
    const response: RuntimeDispatchResponse = {
      version: runtimeProtocolVersion,
      operationId,
      ok: true,
      result: {
        type: "harnessSettings",
        harnessRevision: 5,
        settings: {
          revision: 4,
          recursiveSessionsEnabled: true,
          contextQuotaBytes: 16 * 1024 * 1024,
          refinementMode: "suggest",
        },
      },
    };
    expect(await createRuntimeBridge(transportHarness(() => response).transport, {
      createOperationId: () => operationId,
    }).dispatch(command)).toEqual(response);

    const mismatched = {
      ...response,
      result: {
        ...response.result,
        harnessRevision: 6,
      },
    } as const;
    expect(await rejectionOf(createRuntimeBridge(
      transportHarness(() => mismatched).transport,
      { createOperationId: () => operationId },
    ).dispatch(command))).toMatchObject({
      name: "RuntimeBridgeProtocolError",
      boundary: "dispatchResponse",
    });
  });

  test("correlates chat pane, queue revision, and stop results with the exact request", async () => {
    const operationId = "op_bridgechat001";
    const responseFor = (pane: ChatPaneProjection) => ({
      version: runtimeProtocolVersion,
      operationId,
      ok: true,
      result: {
        type: "chatPane",
        pane,
        disposition: "applied",
        appliedRevision: pane.revision,
      },
    } as const);
    const createCommand = {
      type: "chat.pane.create",
      paneId: bridgeChatPane.id,
      repositoryId: bridgeChatPane.repository.id,
    } as const;
    const correlated = transportHarness(() => responseFor(bridgeChatPane));
    expect(await createRuntimeBridge(correlated.transport, {
      createOperationId: () => operationId,
    }).dispatch(createCommand)).toMatchObject({
      ok: true,
      result: { type: "chatPane", pane: { id: bridgeChatPane.id, revision: 1 } },
    });
    const replayed = transportHarness(() => ({
      version: runtimeProtocolVersion,
      operationId,
      ok: true,
      result: {
        type: "chatPaneReplay",
        paneId: bridgeChatPane.id,
        commandType: "chat.pane.create",
        appliedRevision: 1,
      },
    } as const));
    expect(await createRuntimeBridge(replayed.transport, {
      createOperationId: () => operationId,
    }).dispatch(createCommand)).toMatchObject({
      ok: true,
      result: { type: "chatPaneReplay", paneId: bridgeChatPane.id },
    });

    for (const pane of [
      { ...bridgeChatPane, id: "pane_bridgechat002" },
      { ...bridgeChatPane, revision: 2 },
    ]) {
      const mismatched = transportHarness(() => responseFor(pane));
      expect(await rejectionOf(createRuntimeBridge(mismatched.transport, {
        createOperationId: () => operationId,
      }).dispatch(createCommand))).toMatchObject({
        name: "RuntimeBridgeProtocolError",
        boundary: "dispatchResponse",
      });
    }

    const selectedRepositoryId = "repo_11111111111111111111111111";
    const selectRepositoryCommand = {
      type: "chat.pane.repository.select",
      paneId: bridgeChatPane.id,
      repositoryId: selectedRepositoryId,
      expectedRevision: bridgeChatPane.revision,
    } as const;
    const selectedPane: ChatPaneProjection = {
      ...bridgeChatPane,
      revision: bridgeChatPane.revision + 1,
      repository: { id: selectedRepositoryId, name: "Selected" },
    };
    const correctSelection = transportHarness(() => responseFor(selectedPane));
    expect(await createRuntimeBridge(correctSelection.transport, {
      createOperationId: () => operationId,
    }).dispatch(selectRepositoryCommand)).toMatchObject({
      result: {
        type: "chatPane",
        pane: { revision: 2, repository: { id: selectedRepositoryId } },
      },
    });
    const wrongSelection = transportHarness(() => responseFor({
      ...selectedPane,
      repository: bridgeChatPane.repository,
    }));
    expect(await rejectionOf(createRuntimeBridge(wrongSelection.transport, {
      createOperationId: () => operationId,
    }).dispatch(selectRepositoryCommand))).toMatchObject({
      name: "RuntimeBridgeProtocolError",
      boundary: "dispatchResponse",
    });

    const startedPane: ChatPaneProjection = {
      ...bridgeChatPane,
      revision: 2,
      state: "starting",
      turn: {
        id: "chatturn_bridgechat001",
        status: "starting",
        startedAt: "2026-08-03T12:00:00.000Z",
        completedAt: null,
        continuationCount: 0,
        responseMarkdown: { tail: "", totalUtf8Bytes: 0, truncatedPrefix: false },
        reasoningSummary: { tail: "", totalUtf8Bytes: 0, truncatedPrefix: false },
        reasoningSummaryVerified: false,
        tools: [],
        providerSubagents: { agents: [], overflowCount: 0 },
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
    };
    const enqueueCommand = {
      type: "chat.message.enqueue",
      paneId: bridgeChatPane.id,
      expectedQueueRevision: 1,
      messageId: "chatmsg_bridgechat001",
      content: { text: "Start", attachmentRefs: [] as string[] },
      delivery: { kind: "queue" },
    } as const;
    const queueResponse = (revision: number, paneId = bridgeChatPane.id) => ({
      version: runtimeProtocolVersion,
      operationId,
      ok: true as const,
      result: {
        type: "chatMessageQueue" as const,
        paneId,
        disposition: "applied" as const,
        messageId: enqueueCommand.messageId,
        queue: {
          revision,
          pauseReason: null,
          blockedMessage: null,
          messages: [],
        },
      },
    });
    const correctEnqueue = transportHarness(() => queueResponse(2));
    expect(await createRuntimeBridge(correctEnqueue.transport, {
      createOperationId: () => operationId,
    }).dispatch(enqueueCommand)).toMatchObject({
      result: { type: "chatMessageQueue", paneId: bridgeChatPane.id },
    });

    const staleQueue = transportHarness(() => queueResponse(1));
    expect(await rejectionOf(createRuntimeBridge(staleQueue.transport, {
      createOperationId: () => operationId,
    }).dispatch(enqueueCommand))).toMatchObject({
      name: "RuntimeBridgeProtocolError",
      boundary: "dispatchResponse",
    });

    const stopCommand = {
      type: "chat.turn.stop",
      paneId: bridgeChatPane.id,
      expectedRevision: 2,
      turnId: startedPane.turn!.id,
    } as const;
    const stoppedPane: ChatPaneProjection = {
      ...startedPane,
      revision: 5,
      state: "attention",
      turn: {
        ...startedPane.turn!,
        status: "failed",
        completedAt: "2026-08-03T12:00:01.000Z",
      },
      attention: {
        code: "turn_failed",
        message: "You stopped this turn. You can send another message.",
        retryable: true,
      },
      recoverablePrompt: true,
    };
    const correctStop = transportHarness(() => responseFor(stoppedPane));
    expect(await createRuntimeBridge(correctStop.transport, {
      createOperationId: () => operationId,
    }).dispatch(stopCommand)).toMatchObject({
      result: { type: "chatPane", pane: { revision: 5, state: "attention" } },
    });
    for (const mismatched of [
      { ...stoppedPane, revision: stopCommand.expectedRevision },
      { ...stoppedPane, state: "streaming", attention: null },
      {
        ...stoppedPane,
        turn: { ...stoppedPane.turn!, id: "chatturn_bridgechat002" },
      },
    ] as const) {
      const transport = transportHarness(() => responseFor(mismatched));
      expect(await rejectionOf(createRuntimeBridge(transport.transport, {
        createOperationId: () => operationId,
      }).dispatch(stopCommand))).toMatchObject({
        name: "RuntimeBridgeProtocolError",
        boundary: "dispatchResponse",
      });
    }

  });

  test("invokes the pathless native project chooser and exposes only its safe outcome", async () => {
    const harness = transportHarness(() => ({
      version: runtimeProtocolVersion,
      status: "created",
      repository: {
        id: "repo_00000000000000000000000000",
        name: "HRA",
        createdAt: 1_784_388_800_000,
      },
      workspace: workspaceSummary,
    }));

    expect(await createRuntimeBridge(harness.transport).addProject()).toMatchObject({
      status: "created",
      repository: { name: "HRA" },
    });
    expect(harness.invocations).toEqual([{
      command: runtimeProjectAddCommand,
      payload: { version: runtimeProtocolVersion },
    }]);

    const malformed = transportHarness(() => ({
      version: runtimeProtocolVersion,
      status: "created",
      trustedDirectoryPath: "/not-exposed",
    }));
    expect(await rejectionOf(createRuntimeBridge(malformed.transport).addProject())).toMatchObject({
      name: "RuntimeBridgeProtocolError",
      boundary: "projectAddResponse",
    });

    const invocationFailure = new Error("native picker unavailable");
    const unavailable = transportHarness(() => {
      throw invocationFailure;
    });
    expect(await rejectionOf(createRuntimeBridge(unavailable.transport).addProject()))
      .toBe(invocationFailure);
  });

  test("dispatches scoped task reads through the separate portable result seam", async () => {
    const harness = transportHarness((payload) => {
      if (typeof payload !== "object" || payload === null || !("operationId" in payload)) {
        throw new Error("Expected an operation envelope.");
      }
      return {
        version: runtimeProtocolVersion,
        operationId: payload.operationId,
        ok: true,
        result: {
          type: "taskWorkspaceSummaries",
          workspaces: [workspaceSummary],
        },
      };
    });
    const bridge = createRuntimeBridge(harness.transport, {
      createOperationId: () => "op_native0001",
    });

    expect(await bridge.dispatchTask({ type: "task.workspaces.list" })).toMatchObject({
      operationId: "op_native0001",
      ok: true,
      result: { type: "taskWorkspaceSummaries" },
    });
    expect(harness.invocations).toEqual([{
      command: "hra.runtime.dispatch",
      payload: {
        version: runtimeProtocolVersion,
        operationId: "op_native0001",
        command: { type: "task.workspaces.list" },
      },
    }]);
  });

  test("assembles an immutable paged task response before exposing it", async () => {
    const complete: RuntimeTaskDispatchResponse = {
      version: runtimeProtocolVersion,
      operationId: "op_native0001",
      ok: true,
      result: {
        type: "taskWorkspaceSummaries",
        workspaces: [workspaceSummary],
      },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(complete));
    const split = Math.floor(bytes.byteLength / 2);
    const chunks = [bytes.slice(0, split), bytes.slice(split)];
    const harness = transportHarness((payload) => {
      const index = typeof payload === "object" && payload !== null && "index" in payload
        ? Number(payload.index)
        : 0;
      const chunk = chunks[index];
      if (chunk === undefined) throw new Error("Unexpected response chunk index");
      return {
        version: runtimeProtocolVersion,
        operationId: "op_native0001",
        transferId: "response_12345678",
        index,
        count: chunks.length,
        base64: Buffer.from(chunk).toString("base64"),
      };
    });

    expect(await createRuntimeBridge(harness.transport, {
      createOperationId: () => "op_native0001",
    }).dispatchTask({ type: "task.workspaces.list" })).toEqual(complete);
    expect(harness.invocations).toEqual([
      {
        command: "hra.runtime.dispatch",
        payload: {
          version: runtimeProtocolVersion,
          operationId: "op_native0001",
          command: { type: "task.workspaces.list" },
        },
      },
      {
        command: "hra.runtime.dispatch",
        payload: {
          version: runtimeProtocolVersion,
          operationId: "op_native0001",
          transferId: "response_12345678",
          index: 1,
        },
      },
    ]);
  });

  test("rejects a valid task result returned for the wrong scoped command", async () => {
    const harness = transportHarness(() => ({
      version: runtimeProtocolVersion,
      operationId: "op_native0001",
      ok: true,
      result: {
        type: "taskWorkspaceSummaries",
        workspaces: [workspaceSummary],
      },
    }));
    expect(await rejectionOf(createRuntimeBridge(harness.transport, {
      createOperationId: () => "op_native0001",
    }).dispatchTask({
      type: "task.list",
      workspaceId,
      view: "all",
      cursor: null,
      limit: 100,
    }))).toMatchObject({
      name: "RuntimeBridgeProtocolError",
      boundary: "taskDispatchResponse",
    });
  });

  test("rejects task and session commands before they cross the renderer seam", async () => {
    const harness = transportHarness(() => {
      throw new Error("The native transport must not be called.");
    });
    const bridge = createRuntimeBridge(harness.transport);
    const dispatchUnknown = bridge.dispatch.bind(bridge) as (
      command: unknown,
    ) => Promise<unknown>;

    expect(await rejectionOf(dispatchUnknown({ type: "thread.list" }))).toBeDefined();
    const taskDispatchUnknown = bridge.dispatchTask.bind(bridge) as (
      command: unknown,
    ) => Promise<unknown>;
    expect(await rejectionOf(taskDispatchUnknown({
      type: "project.register",
      path: "/fixture/example",
    }))).toBeDefined();
    expect(harness.invocations).toEqual([]);
  });

  test("parses events before exposure and routes malformed values separately", () => {
    const harness = transportHarness(() => null);
    const received: unknown[] = [];
    const malformed: RuntimeBridgeProtocolError[] = [];
    const unsubscribe = createRuntimeBridge(harness.transport).subscribe({
      onEvent: (event) => received.push(event),
      onTransportLifecycle: () => undefined,
      onMalformedValue: (error) => malformed.push(error),
    });
    const event = accountUpsertEvent(1);
    const taskInvalidation = {
      version: runtimeProtocolVersion,
      sequence: 2,
      event: {
        type: "task.invalidated",
        invalidation: {
          workspaceId,
          projectionRevision: 8,
          scope: "task_list",
          view: "ready",
        },
      },
    } as const;

    harness.emit(event);
    harness.emit(taskInvalidation);
    harness.emit({ version: 1, sequence: 3, event: { type: "something.new" } });

    expect(received).toEqual([event, taskInvalidation]);
    expect(malformed).toHaveLength(1);
    expect(malformed[0]).toMatchObject({ boundary: "event" });
    unsubscribe();
    expect(() => harness.emit(event)).toThrow("No native event listener");
  });

  test("parses Native transport generations and sends the pathless retry command", async () => {
    const harness = transportHarness(() => ({ version: 1, status: "accepted" }));
    const bridge = createRuntimeBridge(harness.transport);
    const lifecycles: unknown[] = [];
    const malformed: RuntimeBridgeProtocolError[] = [];
    const unsubscribe = bridge.subscribe({
      onEvent: () => undefined,
      onTransportLifecycle: (lifecycle) => lifecycles.push(lifecycle),
      onMalformedValue: (error) => malformed.push(error),
    });

    harness.emit(
      { version: 1, state: "ready", generation: 2 },
      runtimeTransportLifecycleEventName,
    );
    harness.emit(
      { version: 1, state: "ready", generation: 0 },
      runtimeTransportLifecycleEventName,
    );
    expect(lifecycles).toEqual([{ version: 1, state: "ready", generation: 2 }]);
    expect(malformed).toHaveLength(1);
    expect(malformed[0]).toMatchObject({ boundary: "transportLifecycle" });
    expect(await bridge.retryTransport()).toEqual({ version: 1, status: "accepted" });
    expect(harness.invocations.at(-1)).toEqual({
      command: runtimeTransportRetryCommand,
      payload: { version: 1 },
    });
    unsubscribe();
  });

  test("resets recovery health only after a complete renderer-validated snapshot", async () => {
    const snapshot = emptyRuntimeSnapshot(12);
    const invocations: Array<{ command: string; payload: unknown }> = [];
    const listeners = new Map<string, (detail: unknown) => void>();
    const transport: RuntimeTransport = {
      invoke(command, payload) {
        invocations.push({ command, payload });
        if (command === runtimeTransportHealthCommand) {
          return Promise.resolve({ version: 1, generation: 4, status: "accepted" });
        }
        return Promise.resolve({ version: runtimeProtocolVersion, snapshot });
      },
      on(name, callback) {
        listeners.set(name, callback);
        return () => listeners.delete(name);
      },
    };
    const bridge = createRuntimeBridge(transport);
    const unsubscribe = bridge.subscribe({
      onEvent: () => undefined,
      onTransportLifecycle: () => undefined,
      onMalformedValue: () => undefined,
    });
    listeners.get(runtimeTransportLifecycleEventName)?.({
      version: 1,
      state: "ready",
      generation: 4,
    });

    expect(await bridge.snapshot()).toEqual(snapshot);
    expect(invocations).toEqual([
      {
        command: "hra.runtime.snapshot",
        payload: { version: runtimeProtocolVersion },
      },
      {
        command: runtimeTransportHealthCommand,
        payload: { version: 1, generation: 4 },
      },
    ]);
    unsubscribe();
  });

  test("malformed generation data forces recovery without acknowledging health", async () => {
    const invocations: Array<{ command: string; payload: unknown }> = [];
    const listeners = new Map<string, (detail: unknown) => void>();
    const transport: RuntimeTransport = {
      invoke(command, payload) {
        invocations.push({ command, payload });
        if (command === runtimeTransportRetryCommand) {
          return Promise.resolve({ version: 1, status: "accepted" });
        }
        return Promise.resolve({ version: runtimeProtocolVersion, snapshot: { revision: 0 } });
      },
      on(name, callback) {
        listeners.set(name, callback);
        return () => listeners.delete(name);
      },
    };
    const bridge = createRuntimeBridge(transport);
    const unsubscribe = bridge.subscribe({
      onEvent: () => undefined,
      onTransportLifecycle: () => undefined,
      onMalformedValue: () => undefined,
    });
    listeners.get(runtimeTransportLifecycleEventName)?.({
      version: 1,
      state: "ready",
      generation: 6,
    });

    expect(await rejectionOf(bridge.snapshot())).toMatchObject({
      name: "RuntimeBridgeProtocolError",
      boundary: "snapshotResponse",
    });
    expect(invocations.map(({ command }) => command)).toEqual([
      "hra.runtime.snapshot",
      runtimeTransportRetryCommand,
    ]);
    expect(invocations.some(({ command }) => command === runtimeTransportHealthCommand))
      .toBeFalse();
    expect(invocations[1]?.payload).toEqual({ version: 1, forceIfRunning: true });
    unsubscribe();
  });

  test("bounds stalled snapshots and ambiguous dispatches, forces recovery, and never replays", async () => {
    const scenarios = [
      {
        command: "hra.runtime.snapshot",
        run: (bridge: ReturnType<typeof createRuntimeBridge>) => bridge.snapshot(),
      },
      {
        command: "hra.runtime.dispatch",
        run: (bridge: ReturnType<typeof createRuntimeBridge>) => bridge.dispatch({
          type: "runtime.restartAccount",
          accountProfileId: "acct_personal01",
        }),
      },
    ] as const;

    for (const scenario of scenarios) {
      const invocations: Array<{ command: string; payload: unknown }> = [];
      const transport: RuntimeTransport = {
        invoke(command, payload) {
          invocations.push({ command, payload });
          if (command === runtimeTransportRetryCommand) {
            return Promise.resolve({ version: 1, status: "accepted" });
          }
          return new Promise(() => undefined);
        },
        on: () => () => undefined,
      };
      const bridge = createRuntimeBridge(transport, {
        createOperationId: () => "op_timeout0001",
        invokeTimeoutMilliseconds: 5,
        recoveryTimeoutMilliseconds: 5,
      });

      const error = await rejectionOf(scenario.run(bridge));
      expect(error).toBeInstanceOf(RuntimeBridgeTransportTimeoutError);
      expect(error).toMatchObject({
        command: scenario.command,
        timeoutMilliseconds: 5,
      });
      expect(invocations.map(({ command }) => command)).toEqual([
        scenario.command,
        runtimeTransportRetryCommand,
      ]);
      expect(invocations[1]?.payload).toEqual({
        version: 1,
        forceIfRunning: true,
      });
    }
  });

  test("does not kill a healthy generation while its bounded startup snapshot is still initializing", async () => {
    const invocations: string[] = [];
    const transport: RuntimeTransport = {
      async invoke(command) {
        invocations.push(command);
        if (command === runtimeTransportRetryCommand) {
          return { version: 1, status: "accepted" };
        }
        if (command === "hra.runtime.snapshot") {
          await Bun.sleep(15);
          return { version: runtimeProtocolVersion, snapshot: emptyRuntimeSnapshot() };
        }
        return new Promise(() => undefined);
      },
      on: () => () => undefined,
    };
    const bridge = createRuntimeBridge(transport, {
      invokeTimeoutMilliseconds: 5,
      snapshotTimeoutMilliseconds: 50,
      recoveryTimeoutMilliseconds: 5,
    });

    expect(await bridge.snapshot()).toEqual(emptyRuntimeSnapshot());
    expect(invocations).toEqual(["hra.runtime.snapshot"]);

    expect(await rejectionOf(bridge.dispatch({
      type: "runtime.restartAccount",
      accountProfileId: "acct_personal01",
    }))).toMatchObject({
      name: "RuntimeBridgeTransportTimeoutError",
      command: "hra.runtime.dispatch",
      timeoutMilliseconds: 5,
    });
    expect(invocations).toEqual([
      "hra.runtime.snapshot",
      "hra.runtime.dispatch",
      runtimeTransportRetryCommand,
    ]);
  });

  test("does not recursively retry a timed-out recovery command", async () => {
    const invocations: string[] = [];
    const transport: RuntimeTransport = {
      invoke(command) {
        invocations.push(command);
        return new Promise(() => undefined);
      },
      on: () => () => undefined,
    };
    const bridge = createRuntimeBridge(transport, {
      invokeTimeoutMilliseconds: 5,
      recoveryTimeoutMilliseconds: 5,
    });

    expect(await rejectionOf(bridge.retryTransport())).toMatchObject({
      name: "RuntimeBridgeTransportTimeoutError",
      command: runtimeTransportRetryCommand,
    });
    expect(invocations).toEqual([runtimeTransportRetryCommand]);
  });

  test("rejects malformed snapshot responses", async () => {
    const harness = transportHarness(() => ({ version: 1, snapshot: emptyRuntimeSnapshot() }));

    expect(await rejectionOf(createRuntimeBridge(harness.transport).snapshot())).toMatchObject({
      name: "RuntimeBridgeProtocolError",
      boundary: "snapshotResponse",
    });
  });

  test("rejects session-launch authority before invoking the native bridge", async () => {
    const harness = transportHarness(() => {
      throw new Error("Forbidden renderer commands must not reach native transport.");
    });
    const bridge = createRuntimeBridge(harness.transport);
    const dispatchUnknown = bridge.dispatch.bind(bridge) as (
      command: unknown,
    ) => Promise<unknown>;

    for (const command of [
      { type: "project.register", path: "/fixture/example" },
      {
        type: "thread.start",
        accountProfileId: "acct_12345678",
        projectId: "proj_12345678",
        laneMode: "managed",
      },
      { type: "thread.fork", threadId: "thread_12345678", temporary: false },
      {
        type: "turn.start",
        threadId: "thread_12345678",
        clientUserMessageId: "message_12345678",
        input: { type: "text", text: "Do the work" },
      },
      {
        type: "turn.steer",
        threadId: "thread_12345678",
        expectedTurnId: "turn_12345678",
        clientUserMessageId: "message_12345678",
        input: { type: "text", text: "Keep going" },
      },
      { type: "workspace.release", workspaceLaneId: "lane_12345678" },
      {
        type: "interaction.answer",
        interactionId: "hitl_12345678",
        expectedRevision: 1,
        response: { type: "decision", decision: "allowOnce" },
      },
    ]) {
      expect(await rejectionOf(dispatchUnknown(command))).toBeDefined();
    }
    expect(harness.invocations).toEqual([]);
  });

  test("maps only HRA-owned native shortcuts to UI scale commands", () => {
    expect(uiScaleCommandFromNativeShortcut({ id: nativeUiScaleShortcutIds.increase })).toBe(
      "increase",
    );
    expect(uiScaleCommandFromNativeShortcut({ id: nativeUiScaleShortcutIds.decrease })).toBe(
      "decrease",
    );
    expect(uiScaleCommandFromNativeShortcut({ id: nativeUiScaleShortcutIds.reset })).toBe("reset");

    for (const value of [
      null,
      "hra.ui-scale.increase",
      {},
      { id: 1 },
      { command: nativeUiScaleShortcutIds.increase },
      { id: "another-app.ui-scale.increase" },
    ]) {
      expect(uiScaleCommandFromNativeShortcut(value)).toBeNull();
    }
  });

  test("correlates attachment previews to the exact pane relationship", async () => {
    const operationId = "op_bridgeattachment1";
    const command = {
      type: "chat.attachment.preview",
      paneId: bridgeChatPane.id,
      attachmentId: "attachment_bridgepreview01",
      expectedRevision: 2,
      relationship: { kind: "draft" },
    } as const;
    const response = (paneId: string) => ({
      version: runtimeProtocolVersion,
      operationId,
      ok: true as const,
      result: {
        type: "chatAttachmentPreview" as const,
        paneId,
        attachmentId: command.attachmentId,
        revision: command.expectedRevision,
        mediaType: "image/png" as const,
        base64: "iVBORw==",
      },
    });
    expect(await createRuntimeBridge(
      transportHarness(() => response(command.paneId)).transport,
      { createOperationId: () => operationId },
    ).dispatch(command)).toMatchObject({
      result: { type: "chatAttachmentPreview", paneId: command.paneId },
    });
    expect(await rejectionOf(createRuntimeBridge(
      transportHarness(() => response("pane_bridgechat002")).transport,
      { createOperationId: () => operationId },
    ).dispatch(command))).toMatchObject({
      name: "RuntimeBridgeProtocolError",
      boundary: "dispatchResponse",
    });
  });

  test("correlates Start fresh to the exact pane and advanced queue revision", async () => {
    const operationId = "op_bridgefreshctx01";
    const command = {
      type: "chat.pane.startFreshContext",
      paneId: bridgeChatPane.id,
      expectedRevision: 4,
      expectedQueueRevision: 7,
    } as const;
    const response = (paneId: string, queueRevision: number) => ({
      version: runtimeProtocolVersion,
      operationId,
      ok: true as const,
      result: {
        type: "chatMessageQueue" as const,
        paneId,
        messageId: null,
        disposition: "applied" as const,
        queue: {
          revision: queueRevision,
          pauseReason: null,
          blockedMessage: null,
          messages: [],
        },
      },
    });
    expect(await createRuntimeBridge(
      transportHarness(() => response(command.paneId, 8)).transport,
      { createOperationId: () => operationId },
    ).dispatch(command)).toMatchObject({
      result: { type: "chatMessageQueue", paneId: command.paneId },
    });
    for (const invalid of [
      response("pane_bridgechat002", 8),
      response(command.paneId, 7),
    ]) {
      expect(await rejectionOf(createRuntimeBridge(
        transportHarness(() => invalid).transport,
        { createOperationId: () => operationId },
      ).dispatch(command))).toMatchObject({
        name: "RuntimeBridgeProtocolError",
        boundary: "dispatchResponse",
      });
    }
  });

  test("subscribes to native shortcut events and ignores unrelated commands", () => {
    const harness = transportHarness(() => null);
    const received: string[] = [];
    const unsubscribe = subscribeNativeUiScaleShortcuts(
      harness.transport,
      (command) => received.push(command),
    );

    harness.emit({ id: "unrelated.command" }, "shortcut");
    harness.emit({ id: nativeUiScaleShortcutIds.increase }, "shortcut");
    harness.emit({ id: nativeUiScaleShortcutIds.reset }, "shortcut");

    expect(received).toEqual(["increase", "reset"]);
    unsubscribe();
    expect(() => harness.emit({ id: nativeUiScaleShortcutIds.decrease }, "shortcut")).toThrow(
      "No native event listener",
    );
  });
});
