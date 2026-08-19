import { describe, expect, test } from "bun:test";

import {
  runtimeProtocolVersion,
  type ChatPaneProjection,
  type RuntimeDispatchResponse,
  type RuntimeEvent,
  type RuntimeSnapshot,
  type RuntimeTaskDispatchResponse,
  type RuntimeTransportLifecycle,
  type RuntimeTransportRetryResponse,
} from "../../../contracts/runtime";
import {
  RuntimeBridgeProtocolError,
  type RuntimeBridge,
  type RuntimeBridgeListener,
} from "../runtime-bridge";
import { createRuntimeShell, type RuntimeShell } from "./shell";
import {
  accountUpsertEvent,
  emptyRuntimeSnapshot,
  fixtureAccount,
  snapshotInvalidatedEvent,
} from "./test-fixtures";

type SnapshotSource = Error | Promise<RuntimeSnapshot> | RuntimeSnapshot;

class FakeRuntimeBridge implements RuntimeBridge {
  readonly snapshotCalls: number[] = [];
  readonly retryCalls: number[] = [];
  retryResponse: RuntimeTransportRetryResponse = { version: 1, status: "accepted" };
  dispatchError: Error | null = null;
  #sources: SnapshotSource[];
  #listener: RuntimeBridgeListener | null = null;

  constructor(...sources: SnapshotSource[]) {
    this.#sources = sources;
  }

  snapshot(): Promise<RuntimeSnapshot> {
    this.snapshotCalls.push(this.snapshotCalls.length + 1);
    const source = this.#sources.shift();
    if (source === undefined) return Promise.reject(new Error("No fake snapshot is queued."));
    if (source instanceof Error) return Promise.reject(source);
    return Promise.resolve(source);
  }

  dispatch(): Promise<RuntimeDispatchResponse> {
    if (this.dispatchError !== null) return Promise.reject(this.dispatchError);
    return Promise.resolve({
      version: runtimeProtocolVersion,
      operationId: "op_12345678",
      ok: true,
      result: { type: "accepted" },
    });
  }

  dispatchTask(): Promise<RuntimeTaskDispatchResponse> {
    return Promise.reject(new Error("The account-shell fake has no task authority."));
  }

  addProject() {
    return Promise.resolve({ version: runtimeProtocolVersion, status: "cancelled" } as const);
  }

  retryTransport(): Promise<RuntimeTransportRetryResponse> {
    this.retryCalls.push(this.retryCalls.length + 1);
    return Promise.resolve(this.retryResponse);
  }

  subscribe(listener: RuntimeBridgeListener): () => void {
    this.#listener = listener;
    return () => {
      if (this.#listener === listener) this.#listener = null;
    };
  }

  queueSnapshot(snapshot: RuntimeSnapshot): void {
    this.#sources.push(snapshot);
  }

  emit(event: RuntimeEvent): void {
    if (this.#listener === null) throw new Error("The fake bridge has no listener.");
    this.#listener.onEvent(event);
  }

  emitTransportLifecycle(lifecycle: RuntimeTransportLifecycle): void {
    if (this.#listener === null) throw new Error("The fake bridge has no listener.");
    this.#listener.onTransportLifecycle(lifecycle);
  }

  emitMalformed(boundary: "dispatchResponse" | "event" | "snapshotResponse" = "event"): void {
    if (this.#listener === null) throw new Error("The fake bridge has no listener.");
    this.#listener.onMalformedValue(new RuntimeBridgeProtocolError(boundary, null));
  }
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolver: ((value: Value) => void) | null = null;
  const promise = new Promise<Value>((resolve) => {
    resolver = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (resolver === null) throw new Error("Deferred resolver was not initialized.");
      resolver(value);
    },
  };
}

function taskInvalidatedEvent(sequence: number): RuntimeEvent {
  return {
    version: runtimeProtocolVersion,
    sequence,
    event: {
      type: "task.invalidated",
      invalidation: {
        workspaceId: "wsp_00000000000000000000000000",
        projectionRevision: 2,
        scope: "workspace",
      },
    },
  };
}

async function waitForReady(shell: RuntimeShell, sequence: number): Promise<RuntimeSnapshot> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = shell.getState();
    if (state.state === "ready" && state.snapshot.lastSequence === sequence) return state.snapshot;
    await Promise.resolve();
  }
  throw new Error(`Runtime shell did not become ready at sequence ${sequence}.`);
}

async function waitForFailed(shell: RuntimeShell): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (shell.getState().state === "failed") return;
    await Promise.resolve();
  }
  throw new Error("Runtime shell did not reach its failed state.");
}

const activeChatPane: ChatPaneProjection = {
  id: "pane_shellchat001",
  paletteIndex: 0,
  revision: 1,
  title: "Shell chat",
  repository: { id: "repo_shellchat001", name: "hra" },
  accountProfileId: null,
  interactionMode: "chat",
  state: "streaming",
  activity: { ordinal: 1, kind: "messageSent" },
  workspace: {
    mode: "managedWorktree",
    state: "ready",
    revision: 1,
    recoveryKind: null,
  },
  turn: {
    id: "chatturn_shellchat001",
    status: "streaming",
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
  attention: null,
  recoverablePrompt: false,
  canStartFreshContext: false,
  messageQueue: { revision: 1, pauseReason: null, blockedMessage: null, messages: [] },
  attachments: { drafts: [], referenced: [] },
  harness: null,
};

function snapshotWithChat(
  pane: ChatPaneProjection,
  lastSequence = 0,
): RuntimeSnapshot {
  return {
    ...emptyRuntimeSnapshot(lastSequence),
    chat: { revision: 1, panes: [pane] },
  };
}

describe("runtime shell", () => {
  test("exposes receiver-safe snapshots and isolates every listener", async () => {
    const bridge = new FakeRuntimeBridge(emptyRuntimeSnapshot());
    const shell = createRuntimeShell(bridge);
    const { getSnapshot, subscribe } = shell;
    const observedStates: string[] = [];
    const observedTaskRevisions: number[] = [];

    subscribe(() => {
      throw new Error("state listener failure");
    });
    subscribe(() => observedStates.push(getSnapshot().state));
    shell.subscribeTaskInvalidations(() => {
      throw new Error("task listener failure");
    });
    shell.subscribeTaskInvalidations((invalidation) => {
      observedTaskRevisions.push(invalidation.projectionRevision);
    });

    await shell.connect();
    expect(getSnapshot()).toMatchObject({ state: "ready" });
    expect(observedStates).toEqual(["connecting", "ready"]);
    expect(() => bridge.emit(taskInvalidatedEvent(1))).not.toThrow();
    expect(observedTaskRevisions).toEqual([2]);
    expect(getSnapshot()).toMatchObject({
      state: "ready",
      snapshot: { lastSequence: 1 },
    });
  });

  test("delivers a buffered task invalidation already covered by the snapshot exactly once", async () => {
    const pending = deferred<RuntimeSnapshot>();
    const bridge = new FakeRuntimeBridge(pending.promise);
    const shell = createRuntimeShell(bridge);
    const observedTaskRevisions: number[] = [];
    shell.subscribeTaskInvalidations((invalidation) => {
      observedTaskRevisions.push(invalidation.projectionRevision);
    });

    const connecting = shell.connect();
    bridge.emit(taskInvalidatedEvent(1));
    pending.resolve({
      ...emptyRuntimeSnapshot(),
      lastSequence: 1,
      revision: 2,
    });
    await connecting;

    expect(observedTaskRevisions).toEqual([2]);
    bridge.emit(taskInvalidatedEvent(1));
    expect(observedTaskRevisions).toEqual([2]);
    expect(shell.getSnapshot()).toMatchObject({
      state: "ready",
      snapshot: { lastSequence: 1 },
    });
  });

  test("delivers a task invalidation that arrives after its covering snapshot", async () => {
    const bridge = new FakeRuntimeBridge({
      ...emptyRuntimeSnapshot(),
      lastSequence: 1,
      revision: 2,
    });
    const shell = createRuntimeShell(bridge);
    const observedTaskRevisions: number[] = [];
    shell.subscribeTaskInvalidations((invalidation) => {
      observedTaskRevisions.push(invalidation.projectionRevision);
    });

    await shell.connect();
    bridge.emit(taskInvalidatedEvent(1));
    bridge.emit(taskInvalidatedEvent(1));

    expect(observedTaskRevisions).toEqual([2]);
    expect(shell.getSnapshot()).toMatchObject({
      state: "ready",
      snapshot: { lastSequence: 1 },
    });
  });

  test("hydrates a snapshot atomically with events received during the request", async () => {
    const pending = deferred<RuntimeSnapshot>();
    const bridge = new FakeRuntimeBridge(pending.promise);
    const shell = createRuntimeShell(bridge);
    const connection = shell.connect();

    bridge.emit(accountUpsertEvent(1, fixtureAccount({ label: "Buffered" })));
    expect(shell.getState()).toEqual({ state: "connecting" });

    pending.resolve(emptyRuntimeSnapshot());
    await connection;

    expect(shell.getState()).toMatchObject({
      state: "ready",
      snapshot: { lastSequence: 1, accounts: [{ label: "Buffered" }] },
    });
  });

  test("bounds delayed-hydration state and converges through an authoritative resnapshot", async () => {
    const pending = deferred<RuntimeSnapshot>();
    const authoritative = {
      ...emptyRuntimeSnapshot(3),
      revision: 4,
      accounts: [fixtureAccount({ revision: 4, label: "Authoritative" })],
    };
    const bridge = new FakeRuntimeBridge(pending.promise, authoritative);
    const shell = createRuntimeShell(bridge, { maxBufferedEvents: 2 });
    const connection = shell.connect();

    bridge.emit(accountUpsertEvent(1, fixtureAccount({ revision: 2, label: "One" })));
    bridge.emit(accountUpsertEvent(2, fixtureAccount({ revision: 3, label: "Two" })));
    bridge.emit(accountUpsertEvent(3, fixtureAccount({ revision: 4, label: "Three" })));
    pending.resolve(emptyRuntimeSnapshot());
    await connection;

    expect(shell.getState()).toEqual({ state: "ready", snapshot: authoritative });
    expect(bridge.snapshotCalls).toHaveLength(2);
  });

  test("resnapshots on a gap and reaches the same state as the authoritative snapshot", async () => {
    const authoritative = {
      ...emptyRuntimeSnapshot(2),
      accounts: [fixtureAccount({ revision: 3, label: "Authoritative" })],
    };
    const bridge = new FakeRuntimeBridge(emptyRuntimeSnapshot(), authoritative);
    const shell = createRuntimeShell(bridge);
    const observedStates: string[] = [];
    shell.subscribe(() => observedStates.push(shell.getState().state));
    await shell.connect();

    bridge.emit(accountUpsertEvent(2));
    expect(shell.getState()).toMatchObject({
      state: "reconnecting",
      gap: { expectedSequence: 1, receivedSequence: 2 },
    });

    expect(await waitForReady(shell, 2)).toEqual(authoritative);
    expect(bridge.snapshotCalls).toHaveLength(2);
    expect(observedStates).toContain("reconnecting");
  });

  test("resnapshots on invalidation and ignores a duplicate after convergence", async () => {
    const authoritative = {
      ...emptyRuntimeSnapshot(1),
      accounts: [fixtureAccount({ revision: 2 })],
    };
    const bridge = new FakeRuntimeBridge(emptyRuntimeSnapshot(), authoritative);
    const shell = createRuntimeShell(bridge);
    await shell.connect();
    const invalidation = snapshotInvalidatedEvent(1);

    bridge.emit(invalidation);
    expect(shell.getState()).toMatchObject({ state: "reconnecting", gap: null });
    expect(await waitForReady(shell, 1)).toEqual(authoritative);

    bridge.emit(invalidation);
    expect(shell.getState()).toEqual({ state: "ready", snapshot: authoritative });
    expect(bridge.snapshotCalls).toHaveLength(2);
  });

  test("resnapshots a contiguous chat event with a stale pane revision without escaping the listener", async () => {
    const initial = snapshotWithChat(activeChatPane);
    const recoveredPane = {
      ...activeChatPane,
      revision: 3,
      title: "Authoritative chat",
    };
    const authoritative = snapshotWithChat(recoveredPane, 1);
    const bridge = new FakeRuntimeBridge(initial, authoritative);
    const shell = createRuntimeShell(bridge);
    await shell.connect();

    const inconsistent: RuntimeEvent = {
      version: runtimeProtocolVersion,
      sequence: 1,
      event: {
        type: "chat.pane.upserted",
        revision: 3,
        pane: recoveredPane,
      },
    };
    expect(() => bridge.emit(inconsistent)).not.toThrow();
    expect(shell.getState()).toMatchObject({ state: "reconnecting", gap: null });
    expect(await waitForReady(shell, 1)).toEqual(authoritative);
    expect(bridge.snapshotCalls).toHaveLength(2);
  });

  test("keeps siblings live when a long pane settles through bounded local state", async () => {
    const longResponse = "streamed-response🙂".repeat(600);
    const longPane: ChatPaneProjection = {
      ...activeChatPane,
      turn: {
        ...activeChatPane.turn!,
        responseMarkdown: {
          tail: longResponse,
          totalUtf8Bytes: new TextEncoder().encode(longResponse).byteLength,
          truncatedPrefix: false,
        },
      },
    };
    const sibling: ChatPaneProjection = {
      ...activeChatPane,
      id: "pane_shellchat002",
      title: "Independent sibling",
      turn: { ...activeChatPane.turn!, id: "chatturn_shellchat002" },
    };
    const initial = {
      ...snapshotWithChat(longPane),
      chat: { revision: 1, panes: [longPane, sibling] },
    };
    const bridge = new FakeRuntimeBridge(initial);
    const shell = createRuntimeShell(bridge);
    await shell.connect();
    const ready = shell.getState();
    if (ready.state !== "ready") throw new Error("Expected a ready runtime shell");
    const siblingBefore = ready.snapshot.chat.panes[1];

    bridge.emit({
      version: runtimeProtocolVersion,
      sequence: 1,
      event: {
        type: "chat.pane.stateChanged",
        revision: 2,
        pane: {
          id: longPane.id,
          paletteIndex: longPane.paletteIndex,
          revision: 2,
          title: longPane.title,
          accountProfileId: longPane.accountProfileId,
          interactionMode: longPane.interactionMode,
          state: "ready",
          activity: longPane.activity,
          workspace: longPane.workspace,
          turn: {
            id: longPane.turn!.id,
            status: "completed",
            startedAt: longPane.turn!.startedAt,
            completedAt: "2026-08-03T12:01:00.000Z",
            continuationCount: 0,
            tools: [{
              id: "chattool_shellchat001",
              category: "filesystem",
              status: "completed",
            }],
            providerSubagents: { agents: [], overflowCount: 0 },
            routing: longPane.turn!.routing,
          },
          attention: null,
          recoverablePrompt: false,
          canStartFreshContext: false,
        },
      },
    });

    const settled = shell.getState();
    expect(settled.state).toBe("ready");
    if (settled.state !== "ready") throw new Error("Expected a ready runtime shell");
    expect(settled.snapshot.chat.panes[0]).toMatchObject({
      state: "ready",
      turn: {
        responseMarkdown: { tail: longResponse },
        tools: [{ status: "completed" }],
      },
    });
    expect(settled.snapshot.chat.panes[1]).toBe(siblingBefore);
    expect(bridge.snapshotCalls).toHaveLength(1);
  });

  test("fails truthfully after a chat delta offset stays inconsistent across bounded snapshots", async () => {
    const initial = snapshotWithChat(activeChatPane);
    const bridge = new FakeRuntimeBridge(initial, initial, initial);
    const shell = createRuntimeShell(bridge, { maxSnapshotAttempts: 2 });
    await shell.connect();

    const inconsistent: RuntimeEvent = {
      version: runtimeProtocolVersion,
      sequence: 1,
      event: {
        type: "chat.turn.delta",
        paneId: activeChatPane.id,
        turnId: activeChatPane.turn!.id,
        revision: 2,
        channel: "responseMarkdown",
        startUtf8Offset: 1,
        delta: "unexpected",
      },
    };
    expect(() => bridge.emit(inconsistent)).not.toThrow();
    await waitForFailed(shell);

    expect(shell.getState()).toEqual({
      state: "failed",
      snapshot: initial,
      failure: {
        kind: "persistentProjectionInconsistency",
        sequence: 1,
        eventType: "chat.turn.delta",
        message: "Runtime event 1 (chat.turn.delta) remained inconsistent with the authoritative projection after 2 snapshots.",
      },
    });
    expect(bridge.snapshotCalls).toHaveLength(3);
  });

  test("converges when an invalidation is buffered during snapshot hydration", async () => {
    const pending = deferred<RuntimeSnapshot>();
    const authoritative = {
      ...emptyRuntimeSnapshot(2),
      accounts: [fixtureAccount({ revision: 3 })],
    };
    const bridge = new FakeRuntimeBridge(pending.promise, authoritative);
    const shell = createRuntimeShell(bridge);
    const connection = shell.connect();
    const invalidation = snapshotInvalidatedEvent(2);

    bridge.emit(invalidation);
    bridge.emit(invalidation);
    pending.resolve(emptyRuntimeSnapshot());
    await connection;

    expect(shell.getState()).toEqual({ state: "ready", snapshot: authoritative });
    expect(bridge.snapshotCalls).toHaveLength(2);
  });

  test("publishes a replayed task invalidation once after the successful hydration attempt", async () => {
    const bridge = new FakeRuntimeBridge(emptyRuntimeSnapshot(), emptyRuntimeSnapshot(2));
    const shell = createRuntimeShell(bridge);
    const observed: Array<{ readonly sequence: number; readonly state: string }> = [];
    shell.subscribeTaskInvalidations((invalidation) => {
      observed.push({
        sequence: invalidation.projectionRevision,
        state: shell.getState().state,
      });
    });

    const connection = shell.connect();
    bridge.emit(taskInvalidatedEvent(1));
    bridge.emit(accountUpsertEvent(3));
    await connection;

    expect(shell.getState()).toMatchObject({
      state: "ready",
      snapshot: { lastSequence: 3 },
    });
    expect(bridge.snapshotCalls).toHaveLength(2);
    expect(observed).toEqual([{ sequence: 2, state: "ready" }]);
  });

  test("fails on a malformed event while retaining a reconnect action and trusted snapshot", async () => {
    const bridge = new FakeRuntimeBridge(emptyRuntimeSnapshot());
    const shell = createRuntimeShell(bridge);
    await shell.connect();
    const trusted = shell.getState();
    if (trusted.state !== "ready") throw new Error("Expected an initial ready state.");

    bridge.emitMalformed();
    expect(shell.getState()).toEqual({
      state: "failed",
      snapshot: trusted.snapshot,
      failure: {
        kind: "malformedTransportValue",
        boundary: "event",
        message: "The native runtime returned an invalid event.",
      },
    });

    bridge.queueSnapshot({
      ...emptyRuntimeSnapshot(4),
      accounts: [fixtureAccount({ revision: 4, label: "Recovered" })],
    });
    await shell.reconnect();
    expect(shell.getState()).toMatchObject({
      state: "ready",
      snapshot: { lastSequence: 4, accounts: [{ label: "Recovered" }] },
    });
  });

  test("generation boundaries cancel stale hydration and accept protected task events exactly once", async () => {
    const pending = deferred<RuntimeSnapshot>();
    const recovered = snapshotWithChat({
      ...activeChatPane,
      revision: 2,
      title: "Recovered generation",
    });
    const bridge = new FakeRuntimeBridge(pending.promise, recovered);
    const shell = createRuntimeShell(bridge);
    const tasks: number[] = [];
    shell.subscribeTaskInvalidations((invalidation) => {
      tasks.push(invalidation.projectionRevision);
    });

    const staleConnection = shell.connect();
    bridge.emit(taskInvalidatedEvent(1));
    bridge.emitTransportLifecycle({
      version: 1,
      state: "backingOff",
      generation: 1,
      attempt: 1,
      retryAtUnixMilliseconds: 1,
    });
    expect(tasks).toEqual([2]);
    expect(shell.getState().state).toBe("reconnecting");

    pending.resolve(emptyRuntimeSnapshot(2));
    await staleConnection;
    expect(shell.getState().state).toBe("reconnecting");

    bridge.emitTransportLifecycle({ version: 1, state: "starting", generation: 2 });
    bridge.emitTransportLifecycle({ version: 1, state: "ready", generation: 2 });
    await waitForReady(shell, 0);
    expect(tasks).toEqual([2]);
    expect(bridge.snapshotCalls).toHaveLength(2);
  });

  test("rehydrates only from a fresh snapshot when Native advances the gateway generation", async () => {
    const first = snapshotWithChat(activeChatPane, 8);
    const restartedPane = {
      ...activeChatPane,
      revision: 2,
      title: "Recovered generation",
    };
    const restarted = snapshotWithChat(restartedPane, 0);
    const bridge = new FakeRuntimeBridge(first, restarted);
    const shell = createRuntimeShell(bridge);
    await shell.connect();

    bridge.emitTransportLifecycle({ version: 1, state: "ready", generation: 2 });
    await waitForReady(shell, 0);

    expect(shell.getState()).toMatchObject({
      state: "ready",
      snapshot: { chat: { panes: [{ title: "Recovered generation" }] } },
    });
    expect(bridge.snapshotCalls).toHaveLength(2);

    bridge.emitTransportLifecycle({ version: 1, state: "ready", generation: 1 });
    expect(bridge.snapshotCalls).toHaveLength(2);
    bridge.emitTransportLifecycle({ version: 1, state: "starting", generation: 2 });
    expect(shell.getState().state).toBe("ready");
  });

  test("uses explicit Native retry only after automatic transport recovery is exhausted", async () => {
    const initial = emptyRuntimeSnapshot(4);
    const recovered = { ...emptyRuntimeSnapshot(), revision: 5 };
    const bridge = new FakeRuntimeBridge(initial, recovered);
    const shell = createRuntimeShell(bridge);
    await shell.connect();

    bridge.emitTransportLifecycle({
      version: 1,
      state: "failed",
      generation: 1,
      canRetry: true,
      message: "The local runtime stopped after bounded retries.",
    });
    expect(shell.getState()).toMatchObject({
      state: "failed",
      snapshot: initial,
      failure: { kind: "transport", canRetry: true, generation: 1 },
    });
    bridge.emitTransportLifecycle({ version: 1, state: "ready", generation: 1 });
    expect(shell.getState().state).toBe("failed");
    expect(bridge.snapshotCalls).toHaveLength(1);

    await shell.reconnect();
    expect(bridge.retryCalls).toEqual([1]);
    expect(shell.getState()).toMatchObject({ state: "reconnecting", snapshot: initial });
    bridge.emitTransportLifecycle({ version: 1, state: "ready", generation: 2 });
    expect(await waitForReady(shell, 0)).toEqual(recovered);
  });

  test("keeps sibling panes live after a safe saturated-mutation rejection", async () => {
    const initial = emptyRuntimeSnapshot(4);
    const bridge = new FakeRuntimeBridge(initial);
    const shell = createRuntimeShell(bridge);
    await shell.connect();
    bridge.dispatchError = new Error("Runtime request queue is full");

    try {
      await shell.dispatch({
        type: "runtime.restartAccount",
        accountProfileId: "acct_personal01",
      });
      throw new Error("Expected the saturated request to reject.");
    } catch (error: unknown) {
      expect(error).toMatchObject({ message: "Runtime request queue is full" });
    }
    expect(shell.getState()).toEqual({ state: "ready", snapshot: initial });

    bridge.dispatchError = new RuntimeBridgeProtocolError(
      "dispatchResponse",
      new Error("malformed generation response"),
    );
    try {
      await shell.dispatch({
        type: "runtime.restartAccount",
        accountProfileId: "acct_personal01",
      });
    } catch {
      // The shell state below is the protocol-fault oracle.
    }
    expect(shell.getState()).toMatchObject({
      state: "failed",
      failure: { kind: "malformedTransportValue", boundary: "dispatchResponse" },
    });
  });

  test("surfaces malformed snapshots as a failed shell state", async () => {
    const bridge = new FakeRuntimeBridge(
      new RuntimeBridgeProtocolError("snapshotResponse", { version: 1 }),
    );
    const shell = createRuntimeShell(bridge);

    await shell.connect();

    expect(shell.getState()).toMatchObject({
      state: "failed",
      snapshot: null,
      failure: { kind: "malformedTransportValue", boundary: "snapshotResponse" },
    });
  });
});
