import { describe, expect, test } from "bun:test";
import { FIXTURE_QUERY_KEY } from "@hraness/direct";
import { taskWorkspaceViewValues } from "@hraness/agent-tasks-protocol";

import { createRuntimeBridge } from "../src/runtime-bridge";
import { createRuntimeShell } from "../src/runtime";
import {
  runtimeEventName,
  runtimeEventSchema,
  runtimeEventUtf8ByteLimit,
  runtimeHumanCredentialReconnectConfirmation,
  runtimeProtocolVersion,
  runtimeSessionSyncResetConfirmation,
  runtimeTransportHealthCommand,
  type RuntimeEvent,
} from "../../contracts/runtime";
import {
  createHRADirectRuntime,
  createHRADirectShellFactory,
  installHRADirectBrowser,
} from "./runtime";
import { hraDirectDefinition } from "./scenarios";
import { createHRADirectTransport } from "./transport";
import {
  createHRATaskTransportFixtureActivation,
  getHRATaskTransportFixture,
} from "./transport-fixtures";
import {
  HRA_DIRECT_ACTIVE_DEADLINE,
  HRA_DIRECT_ACTIVE_REQUEST_TIME,
  fixtureCurrentRunTaskChange,
  hraDirectTaskIds,
  hraDirectTaskStateIds,
  parseHRADirectTaskProjectionState,
  parseHRADirectWorld,
} from "./world";

const WORKSPACE_ID = "wsp_00000000000000000000000000";

function activation(id: string) {
  const active = hraDirectDefinition.activateScenario(id);
  if (!active.ok) throw new Error(active.error.message);
  return active.value;
}

function fixtureActivation(fixture: ReturnType<typeof activation>) {
  const serialized = hraDirectDefinition.serializeFixture({
    scenario: fixture.scenario,
    world: fixture.world,
    runtime: fixture.runtime,
  });
  if (!serialized.ok) throw new Error(serialized.error.message);
  return {
    kind: "query" as const,
    source: `?${FIXTURE_QUERY_KEY}=${encodeURIComponent(serialized.value)}`,
  };
}

async function settleRuntime(runtime: ReturnType<typeof createHRADirectRuntime>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = runtime.shell.getState();
    if (state.state === "ready" && state.snapshot.lastSequence === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const generation = runtime.harness.store.getSnapshot().generation;
  const settled = await runtime.harness.store.whenQuiescent(generation);
  if (!settled.ok) throw new Error(settled.error.message);
  await Promise.resolve();
}

async function waitForShellReady(
  shell: ReturnType<typeof createRuntimeShell>,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (shell.getState().state === "ready") return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(
    `The Direct runtime shell did not become ready: ${JSON.stringify(shell.getState())}`,
  );
}

describe("HRA deterministic native transport", () => {
  test("acknowledges only the exact current healthy transport generation idempotently", async () => {
    const fixture = activation("empty-ready");
    const harness = createHRADirectTransport(fixture.world, fixture.runtime);
    try {
      const before = harness.getSnapshot();
      const current = { version: 1, generation: 1 } as const;
      expect(await harness.transport.invoke(runtimeTransportHealthCommand, current))
        .toEqual({ version: 1, generation: 1, status: "accepted" });
      expect(await harness.transport.invoke(runtimeTransportHealthCommand, current))
        .toEqual({ version: 1, generation: 1, status: "accepted" });
      expect(harness.getSnapshot()).toMatchObject({
        confirmedTransportGenerations: [1],
        snapshotReads: before.snapshotReads,
        deliveredScriptedEvents: before.deliveredScriptedEvents,
      });

      for (const payload of [
        { version: 1, generation: 0 },
        { version: 1, generation: 2 },
        { version: 1, generation: 1, unexpected: true },
        { version: 2, generation: 1 },
        { version: 1, generation: "1" },
      ]) {
        let rejected = false;
        try {
          await harness.transport.invoke(runtimeTransportHealthCommand, payload);
        } catch {
          rejected = true;
        }
        expect(rejected).toBeTrue();
      }
      expect(harness.getSnapshot().confirmedTransportGenerations).toEqual([1]);

      harness.emitTransportLifecycle({ version: 1, state: "starting", generation: 2 });
      harness.emitTransportLifecycle({ version: 1, state: "ready", generation: 2 });
      let staleRejected = false;
      try {
        await harness.transport.invoke(runtimeTransportHealthCommand, current);
      } catch {
        staleRejected = true;
      }
      expect(staleRejected).toBeTrue();
      expect(await harness.transport.invoke(runtimeTransportHealthCommand, {
        version: 1,
        generation: 2,
      })).toEqual({ version: 1, generation: 2, status: "accepted" });
      expect(harness.getSnapshot().confirmedTransportGenerations).toEqual([1, 2]);
    } finally {
      harness.dispose();
    }
  });

  test("models the browser-only transport as an already-ready Native generation", async () => {
    const fixture = activation("empty-ready");
    const harness = createHRADirectTransport(fixture.world, fixture.runtime);
    try {
      expect(await createRuntimeBridge(harness.transport).retryTransport()).toEqual({
        version: 1,
        status: "alreadyReady",
      });
      expect(harness.getSnapshot().invocations.at(-1)).toMatchObject({
        command: "hra.runtime.retryTransport",
        payload: { version: 1 },
      });
    } finally {
      harness.dispose();
    }
  });

  test("simulates bounded backoff through a fresh ready generation", async () => {
    const fixture = activation("empty-ready");
    const harness = createHRADirectTransport(fixture.world, fixture.runtime);
    const shell = createRuntimeShell(createRuntimeBridge(harness.transport));
    try {
      await shell.connect();
      harness.emitTransportLifecycle({
        version: 1,
        state: "backingOff",
        generation: 1,
        attempt: 1,
        retryAtUnixMilliseconds: 1,
      });
      expect(shell.getState().state).toBe("reconnecting");
      harness.emitTransportLifecycle({ version: 1, state: "starting", generation: 2 });
      harness.emitTransportLifecycle({ version: 1, state: "ready", generation: 2 });
      await waitForShellReady(shell);
      expect(harness.getSnapshot()).toMatchObject({
        snapshotReads: 2,
        transportLifecycle: { state: "ready", generation: 2 },
      });
    } finally {
      shell.dispose();
      harness.dispose();
    }
  });

  test("models exact-turn Stop, terminal replay, and stale-target rejection", async () => {
    const fixture = activation("chat-parallel-streaming");
    const harness = createHRADirectTransport(fixture.world, fixture.runtime);
    const shell = createRuntimeShell(createRuntimeBridge(harness.transport));
    try {
      await shell.connect();
      const state = shell.getState();
      if (state.state !== "ready") throw new Error("Direct shell did not become ready.");
      const first = state.snapshot.chat.panes[0];
      const second = state.snapshot.chat.panes[1];
      if (first?.turn === null || first?.turn === undefined || second?.turn === null ||
        second?.turn === undefined) {
        throw new Error("Parallel Direct fixture requires two active turns.");
      }
      const command = {
        type: "chat.turn.stop" as const,
        paneId: first.id,
        expectedRevision: first.revision,
        turnId: first.turn.id,
      };

      const stopped = await shell.dispatch(command);
      expect(stopped).toMatchObject({
        ok: true,
        result: {
          type: "chatPane",
          pane: {
            revision: first.revision + 1,
            state: "attention",
            turn: { id: first.turn.id, status: "failed" },
            attention: { code: "turn_failed", retryable: true },
          },
        },
      });
      expect(await shell.dispatch(command)).toMatchObject({
        ok: true,
        result: stopped.ok ? stopped.result : undefined,
      });
      expect(await shell.dispatch({
        ...command,
        turnId: second.turn.id,
      })).toMatchObject({ ok: false, error: { code: "invalid_state" } });
      expect(await shell.dispatch({
        type: "chat.turn.stop",
        paneId: second.id,
        expectedRevision: second.revision + 1,
        turnId: second.turn.id,
      })).toMatchObject({ ok: false, error: { code: "stale_revision" } });
    } finally {
      shell.dispose();
      harness.dispose();
    }
  });

  test("retries only the exact marked failed turn without exposing its retained prompt", async () => {
    const fixture = activation("chat-attention");
    const harness = createHRADirectTransport(fixture.world, fixture.runtime);
    const shell = createRuntimeShell(createRuntimeBridge(harness.transport, {
      createOperationId: () => "op_directretry0000000000000001",
    }));
    try {
      await shell.connect();
      const state = shell.getState();
      if (state.state !== "ready") throw new Error("Direct shell did not become ready.");
      const pane = state.snapshot.chat.panes.find(({ recoverablePrompt }) => recoverablePrompt);
      if (pane?.turn === null || pane?.turn === undefined) {
        throw new Error("Direct retry fixture requires one marked failed turn.");
      }
      const turnId = "chatturn_directretry000000000001";
      expect(await shell.dispatch({
        type: "chat.turn.retry",
        paneId: pane.id,
        expectedRevision: pane.revision,
        priorFailedTurnId: "chatturn_wrongretrytarget01",
        turnId,
      })).toMatchObject({ ok: false, error: { code: "invalid_state" } });

      const retried = await shell.dispatch({
        type: "chat.turn.retry",
        paneId: pane.id,
        expectedRevision: pane.revision,
        priorFailedTurnId: pane.turn.id,
        turnId,
      });
      expect(retried).toMatchObject({
        ok: true,
        result: {
          type: "chatPane",
          pane: {
            revision: pane.revision + 1,
            state: "starting",
            turn: { id: turnId, status: "starting" },
            recoverablePrompt: false,
          },
        },
      });
      const invocation = harness.getSnapshot().invocations.toReversed().find(({ payload }) =>
        typeof payload === "object" && payload !== null && "command" in payload &&
        typeof payload.command === "object" && payload.command !== null &&
        "type" in payload.command && payload.command.type === "chat.turn.retry"
      );
      expect(invocation).toMatchObject({
        command: "hra.runtime.dispatch",
        payload: {
          command: {
            type: "chat.turn.retry",
            paneId: pane.id,
            expectedRevision: pane.revision,
            priorFailedTurnId: pane.turn.id,
            turnId,
          },
        },
      });
      const command = (invocation?.payload as { command?: unknown } | undefined)?.command;
      expect(command !== null && typeof command === "object" && Object.hasOwn(command, "prompt"))
        .toBeFalse();
      expect(JSON.stringify(invocation)).not.toContain("Retry failed turn");

      const settled = shell.getState();
      if (settled.state !== "ready") throw new Error("Direct shell stopped being ready.");
      const completed = settled.snapshot.chat.panes.find(({ id }) => id === pane.id);
      expect(completed).toMatchObject({
        state: "ready",
        turn: {
          id: turnId,
          status: "completed",
        },
        recoverablePrompt: false,
      });
      expect(completed?.turn?.responseMarkdown.tail).toContain("Retried the retained message.");
    } finally {
      shell.dispose();
      harness.dispose();
    }
  });

  test("an ordinary composer send replaces retained-prompt capability instead of retrying it", async () => {
    const fixture = activation("chat-attention");
    const harness = createHRADirectTransport(fixture.world, fixture.runtime);
    const shell = createRuntimeShell(createRuntimeBridge(harness.transport, {
      createOperationId: () => "op_directreplace000000000000001",
    }));
    try {
      await shell.connect();
      const state = shell.getState();
      if (state.state !== "ready") throw new Error("Direct shell did not become ready.");
      const pane = state.snapshot.chat.panes.find(({ recoverablePrompt }) => recoverablePrompt);
      if (pane === undefined) throw new Error("Direct replacement fixture needs a retained prompt.");
      const replacement = "Use this deliberately different message.";
      const turnId = "chatturn_directreplace0000000001";
      expect(await shell.dispatch({
        type: "chat.turn.start",
        paneId: pane.id,
        expectedRevision: pane.revision,
        turnId,
        prompt: replacement,
      })).toMatchObject({
        ok: true,
        result: {
          type: "chatPane",
          pane: {
            state: "starting",
            turn: { id: turnId },
            recoverablePrompt: false,
          },
        },
      });
      const invocation = harness.getSnapshot().invocations.toReversed().find(({ payload }) =>
        typeof payload === "object" && payload !== null && "command" in payload &&
        typeof payload.command === "object" && payload.command !== null &&
        "type" in payload.command && payload.command.type === "chat.turn.start"
      );
      expect(invocation).toMatchObject({
        payload: {
          command: {
            type: "chat.turn.start",
            paneId: pane.id,
            prompt: replacement,
          },
        },
      });
      expect(JSON.stringify(invocation)).not.toContain("priorFailedTurnId");
      const settled = shell.getState();
      if (settled.state !== "ready") throw new Error("Direct shell stopped being ready.");
      const completed = settled.snapshot.chat.panes.find(({ id }) => id === pane.id);
      expect(completed).toMatchObject({
        state: "ready",
        recoverablePrompt: false,
        turn: { id: turnId },
      });
      expect(completed?.turn?.responseMarkdown.tail).toContain(replacement);
    } finally {
      shell.dispose();
      harness.dispose();
    }
  });

  test("simulates exhausted automatic recovery and an explicit retry", async () => {
    const fixture = activation("empty-ready");
    const harness = createHRADirectTransport(fixture.world, fixture.runtime);
    const shell = createRuntimeShell(createRuntimeBridge(harness.transport));
    try {
      await shell.connect();
      harness.emitTransportLifecycle({
        version: 1,
        state: "failed",
        generation: 1,
        canRetry: true,
        message: "Automatic recovery was exhausted.",
      });
      expect(shell.getState()).toMatchObject({
        state: "failed",
        failure: { kind: "transport", canRetry: true },
      });

      await shell.reconnect();
      expect(shell.getState().state).toBe("reconnecting");
      expect(harness.getSnapshot().transportLifecycle).toMatchObject({
        state: "backingOff",
        generation: 1,
      });
      harness.emitTransportLifecycle({ version: 1, state: "starting", generation: 2 });
      harness.emitTransportLifecycle({ version: 1, state: "ready", generation: 2 });
      await waitForShellReady(shell);
      expect(harness.getSnapshot().invocations.filter(
        ({ command }) => command === "hra.runtime.retryTransport",
      )).toHaveLength(1);
    } finally {
      shell.dispose();
      harness.dispose();
    }
  });

  test("simulates terminal stopping without exposing a retry loop", async () => {
    const fixture = activation("empty-ready");
    const harness = createHRADirectTransport(fixture.world, fixture.runtime);
    const bridge = createRuntimeBridge(harness.transport);
    const shell = createRuntimeShell(bridge);
    try {
      await shell.connect();
      harness.emitTransportLifecycle({ version: 1, state: "stopping", generation: 1 });
      expect(shell.getState()).toMatchObject({
        state: "failed",
        failure: { kind: "transport", canRetry: false },
      });
      expect(await shell.retryTransport()).toEqual({
        version: 1,
        status: "unavailable",
      });
      harness.emitTransportLifecycle({ version: 1, state: "ready", generation: 2 });
      expect(shell.getState().state).toBe("failed");
      expect(harness.getSnapshot()).toMatchObject({
        snapshotReads: 1,
        transportLifecycle: { state: "ready", generation: 2 },
      });
    } finally {
      shell.dispose();
      harness.dispose();
    }
  });

  test("StrictMode-style remounts replace the full session and restore browser globals", () => {
    const originalFetch = globalThis.fetch;
    const target = {};
    const runtimes: ReturnType<typeof createHRADirectRuntime>[] = [];
    const factory = createHRADirectShellFactory(
      { kind: "scenario", scenario: "empty-ready" },
      (runtime) => {
        expect(Reflect.has(target, "__direct")).toBeTrue();
        runtimes.push(runtime);
      },
      { reset: () => undefined, target },
    );

    try {
      const firstShell = factory();
      const firstRuntime = runtimes[0];
      if (firstRuntime === undefined) throw new Error("The first runtime was not published.");
      expect(globalThis.fetch).not.toBe(originalFetch);
      expect(firstRuntime.session.isDisposed()).toBeFalse();

      firstShell.dispose();
      expect(firstRuntime.session.isDisposed()).toBeTrue();
      expect(Reflect.has(target, "__direct")).toBeFalse();
      expect(globalThis.fetch).toBe(originalFetch);

      const secondShell = factory();
      const secondRuntime = runtimes[1];
      if (secondRuntime === undefined) throw new Error("The second runtime was not published.");
      expect(secondRuntime).not.toBe(firstRuntime);
      expect(secondRuntime.session.isDisposed()).toBeFalse();
      expect(Reflect.has(target, "__direct")).toBeTrue();
      expect(globalThis.fetch).not.toBe(originalFetch);

      secondShell.dispose();
      expect(secondRuntime.session.isDisposed()).toBeTrue();
      expect(Reflect.has(target, "__direct")).toBeFalse();
      expect(globalThis.fetch).toBe(originalFetch);
    } finally {
      for (const runtime of runtimes) runtime.dispose();
    }
  });

  test("browser containment failure disposes the unexposed session and rolls back fetch", () => {
    const originalFetch = globalThis.fetch;
    const target = {};
    Object.defineProperty(target, "__direct", {
      configurable: false,
      enumerable: true,
      value: "occupied",
      writable: false,
    });
    const runtime = createHRADirectRuntime({
      kind: "scenario",
      scenario: "empty-ready",
    });

    expect(() => installHRADirectBrowser(runtime, {
      reset: () => undefined,
      target,
    })).toThrow();
    expect(runtime.session.isDisposed()).toBeTrue();
    expect(Reflect.get(target, "__direct")).toBe("occupied");
    expect(globalThis.fetch).toBe(originalFetch);
  });

  test("forces the real bridge to parse and assemble a chunked snapshot", async () => {
    const fixture = activation("profiles-isolated");
    const harness = createHRADirectTransport(fixture.world, fixture.runtime);
    const bridge = createRuntimeBridge(harness.transport, {
      createOperationId: () => "op_direct0001",
    });

    const snapshot = await bridge.snapshot();
    const expectedSnapshot = fixture.world.gateway.snapshots[0];
    if (expectedSnapshot === undefined) throw new Error("Fixture snapshot is missing.");

    expect(snapshot).toEqual(expectedSnapshot);
    expect(harness.getSnapshot().snapshotReads).toBe(1);
    expect(harness.getSnapshot().invocations.length).toBeGreaterThan(2);
    expect(harness.getSnapshot().invocations.every(({ command }) => (
      command === "hra.runtime.snapshot"
    ))).toBe(true);
    expect(harness.store.getSnapshot().activity).toMatchObject({ active: 0 });
  });

  test("requires an exact reveal receipt before recovery becomes ready", async () => {
    const fixture = activation("settings-session-sync-disabled");
    const harness = createHRADirectTransport(fixture.world, fixture.runtime);
    const shell = createRuntimeShell(createRuntimeBridge(harness.transport));
    try {
      await shell.connect();
      expect(await shell.dispatch({
        type: "sessionSync.enable",
        expectedRevision: 0,
        deviceName: "Studio Mac",
      })).toMatchObject({ ok: true });
      expect(shell.getState()).toMatchObject({
        state: "ready",
        snapshot: {
          sessionSync: {
            status: { state: "active", revision: 1, recovery: "exportRequired" },
          },
        },
      });

      const revealed = await shell.dispatch({
        type: "sessionSync.recovery.reveal",
        expectedRevision: 1,
      });
      if (!revealed.ok || revealed.result.type !== "sessionSyncRecoveryKit") {
        throw new Error("Direct did not reveal its recovery fixture.");
      }
      expect(revealed.result.expiresAt).toBe(HRA_DIRECT_ACTIVE_DEADLINE);
      expect(JSON.stringify(shell.getState())).not.toContain(revealed.result.recoveryKit);
      const beforeDenied = shell.getState();
      expect(await shell.dispatch({
        type: "sessionSync.recoveryKitSavedOffline",
        expectedRevision: 1,
        revealId: `syncreveal_${"x".repeat(32)}`,
      })).toMatchObject({ ok: false, error: { code: "policy_denied" } });
      expect(shell.getState()).toBe(beforeDenied);

      expect(await shell.dispatch({
        type: "sessionSync.recoveryKitSavedOffline",
        expectedRevision: 1,
        revealId: revealed.result.revealId,
      })).toMatchObject({ ok: true });
      expect(shell.getState()).toMatchObject({
        state: "ready",
        snapshot: {
          sessionSync: { status: { revision: 2, recovery: "ready" } },
        },
      });
      const beforeRotation = shell.getState();
      expect(await shell.dispatch({
        type: "sessionSync.recovery.rotate" as const,
        expectedRevision: 2,
      })).toMatchObject({ ok: true });
      expect(shell.getState()).toMatchObject({
        state: "ready",
        snapshot: {
          chat: beforeRotation.state === "ready" ? beforeRotation.snapshot.chat : undefined,
          sessionSync: {
            status: {
              state: "active",
              revision: 3,
              scopeGeneration: 2,
              recovery: "exportRequired",
            },
          },
        },
      });
      const afterRotation = shell.getState();
      expect(await shell.dispatch({
        type: "sessionSync.recovery.rotate",
        expectedRevision: 2,
      })).toMatchObject({ ok: false, error: { code: "stale_revision" } });
      expect(shell.getState()).toBe(afterRotation);

      expect(await shell.dispatch({
        type: "sessionSync.reset" as const,
        expectedRevision: 3,
        confirmation: runtimeSessionSyncResetConfirmation,
      })).toMatchObject({ ok: true });
      expect(shell.getState()).toMatchObject({
        state: "ready",
        snapshot: {
          chat: beforeRotation.state === "ready" ? beforeRotation.snapshot.chat : undefined,
          sessionSync: {
            status: { state: "disabled", revision: 4, deviceName: "Studio Mac" },
            remoteSessions: [],
          },
        },
      });
      const afterReset = shell.getState();
      expect(await shell.dispatch({
        type: "sessionSync.reset",
        expectedRevision: 3,
        confirmation: runtimeSessionSyncResetConfirmation,
      })).toMatchObject({ ok: false, error: { code: "invalid_state" } });
      expect(shell.getState()).toBe(afterReset);

      expect(await shell.dispatch({
        type: "sessionSync.enable",
        expectedRevision: 4,
        deviceName: "Studio Mac",
      })).toMatchObject({ ok: true });
      expect(shell.getState()).toMatchObject({
        state: "ready",
        snapshot: {
          sessionSync: {
            status: { state: "active", revision: 5, scopeGeneration: 3 },
          },
        },
      });
    } finally {
      shell.dispose();
      harness.dispose();
    }
  });

  test("binds approval to the displayed code and redacts imported recovery material", async () => {
    const fixture = activation("settings-session-sync-active");
    const harness = createHRADirectTransport(fixture.world, fixture.runtime);
    const shell = createRuntimeShell(createRuntimeBridge(harness.transport));
    try {
      await shell.connect();
      const status = fixture.world.gateway.snapshots[0]!.sessionSync.status;
      if (status.state !== "active") throw new Error("Active sync fixture is missing.");
      const enrollment = status.pendingEnrollments[0]!;
      expect(await shell.dispatch({
        type: "sessionSync.enrollment.approve",
        expectedRevision: status.revision,
        requestId: enrollment.requestId,
        pairingCode: "654321",
      })).toMatchObject({ ok: false, error: { code: "policy_denied" } });
      expect(await shell.dispatch({
        type: "sessionSync.enrollment.approve",
        expectedRevision: status.revision,
        requestId: enrollment.requestId,
        pairingCode: enrollment.pairingCode,
      })).toMatchObject({ ok: true });

      const importedSecret = `RECOVERY-${"S".repeat(64)}`;
      expect(await shell.dispatch({
        type: "sessionSync.recovery.import",
        expectedRevision: status.revision + 1,
        recoveryKit: importedSecret,
      })).toMatchObject({ ok: true });
      const recorded = JSON.stringify(harness.getSnapshot().invocations);
      expect(recorded).not.toContain(importedSecret);
      expect(recorded).toContain("[redacted]");
    } finally {
      shell.dispose();
      harness.dispose();
    }
  });

  test("keeps local pane creation and sending independent of every sync fault", async () => {
    for (const [index, scenario] of [
      "session-sync-fault-cloud",
      "session-sync-fault-auth",
      "session-sync-fault-keychain",
      "session-sync-fault-network",
    ].entries()) {
      const fixture = activation(scenario);
      const initialPane = fixture.world.gateway.snapshots[0]?.chat.panes[0];
      if (initialPane === undefined) throw new Error(`${scenario} has no local pane.`);
      const harness = createHRADirectTransport(fixture.world, fixture.runtime);
      let operation = 0;
      const shell = createRuntimeShell(createRuntimeBridge(harness.transport, {
        createOperationId: () =>
          `op_syncfault${String(index).padStart(2, "0")}${String(++operation).padStart(2, "0")}`,
      }));
      try {
        await shell.connect();
        const project = await shell.addProject();
        if (project.status !== "created") throw new Error(`${scenario} has no pathless project.`);
        expect(await shell.dispatch({
          type: "chat.pane.create",
          paneId: `pane_sync_created_${index}`,
          repositoryId: project.repository.id,
        })).toMatchObject({ ok: true });
        expect(await shell.dispatch({
          type: "chat.turn.start",
          paneId: initialPane.id,
          expectedRevision: initialPane.revision,
          turnId: `chatturn_sync_fault_${index}`,
          prompt: "Local send remains available.",
        })).toMatchObject({ ok: true });
        expect(shell.getState()).toMatchObject({
          state: "ready",
          snapshot: {
            chat: { panes: [{ state: "ready" }, { state: "ready" }] },
            sessionSync: { status: { state: "unavailable" }, remoteSessions: [] },
          },
        });
      } finally {
        shell.dispose();
        harness.dispose();
      }
    }
  });

  test("reset clears only remote observation and fences stale or malformed repeats", async () => {
    const fixture = activation("remote-session-summaries-512");
    const harness = createHRADirectTransport(fixture.world, fixture.runtime);
    const shell = createRuntimeShell(createRuntimeBridge(harness.transport));
    try {
      await shell.connect();
      const initial = shell.getState();
      if (initial.state !== "ready" || initial.snapshot.sessionSync.status.state !== "active") {
        throw new Error("The dense session-sync fixture is not active.");
      }
      const status = initial.snapshot.sessionSync.status;
      const dispatchUnknown = shell.dispatch.bind(shell) as (command: unknown) => Promise<unknown>;
      let malformedRejected = false;
      try {
        await dispatchUnknown({
          type: "sessionSync.reset",
          expectedRevision: status.revision,
          confirmation: "reset it",
        });
      } catch {
        malformedRejected = true;
      }
      expect(malformedRejected).toBeTrue();
      expect(shell.getState()).toBe(initial);

      expect(await shell.dispatch({
        type: "sessionSync.reset",
        expectedRevision: status.revision,
        confirmation: runtimeSessionSyncResetConfirmation,
      })).toMatchObject({ ok: true });
      const reset = shell.getState();
      expect(reset).toMatchObject({
        state: "ready",
        snapshot: {
          sessionSync: {
            status: { state: "disabled", revision: status.revision + 1 },
            remoteSessions: [],
          },
        },
      });
      if (reset.state !== "ready") throw new Error("Reset did not settle.");
      expect(reset.snapshot.chat.panes).toEqual(initial.snapshot.chat.panes);
      expect(reset.snapshot.sessionSync.localGridSlots)
        .toEqual(initial.snapshot.sessionSync.localGridSlots);
      expect(await shell.dispatch({
        type: "sessionSync.reset",
        expectedRevision: status.revision,
        confirmation: runtimeSessionSyncResetConfirmation,
      })).toMatchObject({ ok: false, error: { code: "invalid_state" } });
      expect(shell.getState()).toBe(reset);

      expect(await shell.dispatch({
        type: "sessionSync.enable",
        expectedRevision: status.revision + 1,
        deviceName: status.deviceName,
      })).toMatchObject({ ok: true });
      const reenrolled = shell.getState();
      expect(reenrolled).toMatchObject({
        state: "ready",
        snapshot: {
          chat: { panes: initial.snapshot.chat.panes },
          sessionSync: {
            status: {
              state: "active",
              revision: status.revision + 2,
              scopeGeneration: status.scopeGeneration + 1,
            },
            remoteSessions: [],
          },
        },
      });
      if (reenrolled.state !== "ready") throw new Error("Re-enrollment did not settle.");

      expect(await shell.dispatch({
        type: "sessionSync.recovery.rotate",
        expectedRevision: status.revision + 2,
      })).toMatchObject({ ok: true });
      const rotated = shell.getState();
      expect(rotated).toMatchObject({
        state: "ready",
        snapshot: {
          chat: { panes: initial.snapshot.chat.panes },
          sessionSync: {
            status: {
              state: "active",
              revision: status.revision + 3,
              scopeGeneration: status.scopeGeneration + 2,
              recovery: "exportRequired",
            },
            remoteSessions: [],
          },
        },
      });
      if (rotated.state !== "ready") throw new Error("Rotation did not settle.");
      expect(rotated.snapshot.sessionSync.localGridSlots)
        .toEqual(initial.snapshot.sessionSync.localGridSlots);
      expect(await shell.dispatch({
        type: "sessionSync.recovery.rotate",
        expectedRevision: status.revision + 2,
      })).toMatchObject({ ok: false, error: { code: "stale_revision" } });
      expect(shell.getState()).toBe(rotated);
    } finally {
      shell.dispose();
      harness.dispose();
    }
  });

  test("fails recovery closed under sync faults and cancels after disposal", async () => {
    const faultFixture = activation("session-sync-fault-network");
    const faultHarness = createHRADirectTransport(faultFixture.world, faultFixture.runtime);
    const faultShell = createRuntimeShell(createRuntimeBridge(faultHarness.transport));
    try {
      await faultShell.connect();
      const before = faultShell.getState();
      expect(await faultShell.dispatch({
        type: "sessionSync.recovery.rotate",
        expectedRevision: 1,
      })).toMatchObject({ ok: false, error: { code: "invalid_state" } });
      expect(faultShell.getState()).toBe(before);
      expect(await faultShell.dispatch({
        type: "sessionSync.reset",
        expectedRevision: 1,
        confirmation: runtimeSessionSyncResetConfirmation,
      })).toMatchObject({ ok: false, error: { code: "invalid_state" } });
      expect(faultShell.getState()).toBe(before);
    } finally {
      faultShell.dispose();
      faultHarness.dispose();
    }

    const activeFixture = activation("settings-session-sync-active");
    const activeHarness = createHRADirectTransport(activeFixture.world, activeFixture.runtime);
    const activeShell = createRuntimeShell(createRuntimeBridge(activeHarness.transport));
    await activeShell.connect();
    const beforeDisposal = activeHarness.getSnapshot();
    activeShell.dispose();
    expect(() => activeShell.dispatch({
      type: "sessionSync.recovery.rotate",
      expectedRevision: 7,
    })).toThrow("runtime shell has been disposed");
    const afterDisposal = activeHarness.getSnapshot();
    expect(afterDisposal.invocations).toEqual(beforeDisposal.invocations);
    expect(afterDisposal.snapshotReads).toBe(beforeDisposal.snapshotReads);
    activeHarness.dispose();
  });

  test("dispatches through exact request correlation and projects the emitted event", async () => {
    const fixture = activation("empty-ready");
    const harness = createHRADirectTransport(fixture.world, fixture.runtime);
    const bridge = createRuntimeBridge(harness.transport, {
      createOperationId: () => "op_direct0001",
    });
    const shell = createRuntimeShell(bridge);
    await shell.connect();

    const response = await shell.dispatch({ type: "account.create", label: "Personal" });

    expect(response).toMatchObject({
      ok: true,
      operationId: "op_direct0001",
      result: { type: "account", account: { label: "Personal" } },
    });
    expect(shell.getState()).toMatchObject({
      state: "ready",
      snapshot: { accounts: [{ label: "Personal", selected: true }] },
    });
    expect(harness.getSnapshot().invocations.at(-1)).toMatchObject({
      command: "hra.runtime.dispatch",
      payload: { operationId: "op_direct0001", command: { type: "account.create" } },
    });
    shell.dispose();
  });

  test("fences stale human recovery commands and settles retry, consent, and fresh sign-in", async () => {
    const fixture = activation("settings-human-credential-recovery");
    const harness = createHRADirectTransport(fixture.world, fixture.runtime);
    const shell = createRuntimeShell(createRuntimeBridge(harness.transport));
    try {
      await shell.connect();
      expect(shell.getState()).toMatchObject({
        state: "ready",
        snapshot: {
          humanAccount: {
            state: "error",
            revision: 7,
            code: "CREDENTIAL_RECOVERY_REQUIRED",
          },
        },
      });

      expect(await shell.dispatch({
        type: "human.credentials.retry",
        expectedRevision: 6,
      })).toMatchObject({ ok: false, error: { code: "stale_revision" } });
      expect(shell.getState()).toMatchObject({
        state: "ready",
        snapshot: { humanAccount: { state: "error", revision: 7 } },
      });

      expect(await shell.dispatch({
        type: "human.credentials.retry",
        expectedRevision: 7,
      })).toMatchObject({ ok: true, result: { type: "accepted" } });
      expect(shell.getState()).toMatchObject({
        state: "ready",
        snapshot: {
          humanAccount: {
            state: "recoveryRequired",
            revision: 8,
            reason: "legacyCredentialAccessDenied",
          },
        },
      });

      expect(await shell.dispatch({
        type: "human.credentials.reconnect",
        expectedRevision: 7,
        confirmation: runtimeHumanCredentialReconnectConfirmation,
      })).toMatchObject({ ok: false, error: { code: "stale_revision" } });
      expect(shell.getState()).toMatchObject({
        state: "ready",
        snapshot: { humanAccount: { state: "recoveryRequired", revision: 8 } },
      });

      expect(await shell.dispatch({
        type: "human.credentials.reconnect",
        expectedRevision: 8,
        confirmation: runtimeHumanCredentialReconnectConfirmation,
      })).toMatchObject({ ok: true, result: { type: "accepted" } });
      expect(shell.getState()).toMatchObject({
        state: "ready",
        snapshot: { humanAccount: { state: "signedOut", revision: 9 } },
      });

      expect(await shell.dispatch({
        type: "human.credentials.retry",
        expectedRevision: 9,
      })).toMatchObject({ ok: false, error: { code: "invalid_state" } });
      expect(await shell.dispatch({ type: "human.signIn.start" })).toMatchObject({
        ok: true,
        result: { type: "accepted" },
      });
      expect(shell.getState()).toMatchObject({
        state: "ready",
        snapshot: { humanAccount: { state: "signingIn", revision: 10 } },
      });
    } finally {
      shell.dispose();
      harness.dispose();
    }
  });

  test("renames and recovers a long existing pane through bounded state events", async () => {
    const fixture = activation("chat-completed");
    const initial = fixture.world.gateway.snapshots[0];
    const sourcePane = initial?.chat.panes[0];
    if (initial === undefined || sourcePane?.turn === null || sourcePane === undefined) {
      throw new Error("Completed chat fixture is missing its pane.");
    }
    const responseMarkdown = "Retained Direct response. ".repeat(400);
    const longPane = {
      ...sourcePane,
      workspace: {
        mode: "managedWorktree" as const,
        state: "waitingCapacity" as const,
        revision: sourcePane.workspace!.revision + 1,
        recoveryKind: "capacityUnavailable" as const,
      },
      turn: {
        ...sourcePane.turn,
        responseMarkdown: {
          tail: responseMarkdown,
          totalUtf8Bytes: new TextEncoder().encode(responseMarkdown).byteLength,
          truncatedPrefix: false,
        },
      },
    };
    const world = parseHRADirectWorld({
      ...fixture.world,
      gateway: {
        ...fixture.world.gateway,
        snapshots: fixture.world.gateway.snapshots.map((snapshot, index) =>
          index === 0
            ? { ...snapshot, chat: { ...snapshot.chat, panes: [longPane] } }
            : snapshot
        ),
      },
    });
    const harness = createHRADirectTransport(world, fixture.runtime);
    const events: RuntimeEvent[] = [];
    const unsubscribe = harness.transport.on(runtimeEventName, (detail) => {
      events.push(runtimeEventSchema.parse(detail));
    });
    let operation = 0;
    const bridge = createRuntimeBridge(harness.transport, {
      createOperationId: () => `op_directlong${String(++operation).padStart(2, "0")}`,
    });
    const shell = createRuntimeShell(bridge);
    await shell.connect();

    await shell.dispatch({
      type: "chat.pane.rename",
      paneId: longPane.id,
      expectedRevision: longPane.revision,
      title: "Retained response",
    });
    await shell.dispatch({
      type: "chat.pane.workspace.recover",
      paneId: longPane.id,
      expectedRevision: longPane.revision + 1,
    });

    expect(new TextEncoder().encode(responseMarkdown).byteLength).toBeGreaterThan(7_168);
    expect(events.map(({ event }) => event.type)).toEqual([
      "chat.pane.stateChanged",
      "chat.pane.stateChanged",
    ]);
    expect(events.every((event) =>
      new TextEncoder().encode(JSON.stringify(event)).byteLength <= runtimeEventUtf8ByteLimit
    )).toBeTrue();
    expect(JSON.stringify(events)).not.toContain(responseMarkdown);
    for (const event of events) {
      if (event.event.type !== "chat.pane.stateChanged") {
        throw new Error("Expected a pane-local state event.");
      }
      expect(event.event.pane.turn).not.toHaveProperty("responseMarkdown");
      expect(event.event.pane.turn).not.toHaveProperty("reasoningSummary");
    }
    expect(shell.getState()).toMatchObject({
      state: "ready",
      snapshot: {
        lastSequence: 2,
        chat: {
          panes: [{
            revision: longPane.revision + 2,
            title: "Retained response",
            workspace: { state: "preparing", recoveryKind: null },
            turn: { responseMarkdown: { tail: responseMarkdown } },
          }],
        },
      },
    });
    expect(harness.getSnapshot().snapshotReads).toBe(1);
    unsubscribe();
    shell.dispose();
  });

  test("reselects a pristine pathless project and projects its turn lifecycle", async () => {
    const fixture = activation("chat-draft");
    const initialPane = fixture.world.gateway.snapshots[0]?.chat.panes[0];
    if (initialPane === undefined) throw new Error("Draft chat fixture is missing its pane.");
    const harness = createHRADirectTransport(fixture.world, fixture.runtime);
    let operation = 0;
    const bridge = createRuntimeBridge(harness.transport, {
      createOperationId: () => `op_directchat${String(++operation).padStart(2, "0")}`,
    });
    const shell = createRuntimeShell(bridge);
    const rawEventTypes: string[] = [];
    harness.transport.on(runtimeEventName, (detail) => {
      rawEventTypes.push(runtimeEventSchema.parse(detail).event.type);
    });
    await shell.connect();

    const project = await shell.addProject();
    if (project.status !== "created") throw new Error("Expected a created Direct project.");
    rawEventTypes.length = 0;
    const selected = await shell.dispatch({
      type: "chat.pane.repository.select",
      paneId: initialPane.id,
      expectedRevision: initialPane.revision,
      repositoryId: project.repository.id,
    });
    expect(selected).toMatchObject({
      ok: true,
      result: {
        type: "chatPane",
        pane: {
          revision: initialPane.revision + 1,
          repository: { id: project.repository.id, name: "hra" },
          turn: null,
        },
      },
    });
    expect(rawEventTypes).toEqual(["chat.pane.upserted"]);
    expect(shell.getState()).toMatchObject({
      state: "ready",
      snapshot: {
        chat: {
          panes: [{
            id: initialPane.id,
            revision: initialPane.revision + 1,
            repository: { id: project.repository.id, name: "hra" },
          }],
        },
      },
    });
    rawEventTypes.length = 0;

    await shell.dispatch({
      type: "chat.turn.start",
      paneId: initialPane.id,
      expectedRevision: initialPane.revision + 1,
      turnId: "chatturn_directchat01",
      prompt: "Project this turn",
    });
    expect(rawEventTypes).toEqual([
      "chat.pane.upserted",
      "chat.pane.upserted",
    ]);
    shell.dispose();
  });

  test("reorders exactly the current pane set and emits one durable event", async () => {
    const fixture = activation("chat-many-panes");
    const initialOrder = fixture.world.gateway.snapshots[0]?.chat.panes.map(({ id }) => id);
    if (initialOrder === undefined || initialOrder.length < 2) {
      throw new Error("Many-pane Direct fixture is incomplete.");
    }
    const harness = createHRADirectTransport(fixture.world, fixture.runtime);
    let operation = 0;
    const bridge = createRuntimeBridge(harness.transport, {
      createOperationId: () => `op_directorder${String(++operation).padStart(2, "0")}`,
    });
    const shell = createRuntimeShell(bridge);
    const events: RuntimeEvent[] = [];
    harness.transport.on(runtimeEventName, (detail) => {
      events.push(runtimeEventSchema.parse(detail));
    });
    await shell.connect();
    events.length = 0;

    const orderedPaneIds = initialOrder.toReversed();
    expect(await shell.dispatch({
      type: "chat.panes.reorder",
      expectedOrderedPaneIds: initialOrder,
      orderedPaneIds,
    })).toMatchObject({ ok: true, result: { type: "accepted" } });
    expect(events.map(({ event }) => event)).toEqual([{
      type: "chat.panes.reordered",
      orderedPaneIds,
    }]);
    expect(shell.getState()).toMatchObject({
      state: "ready",
      snapshot: { chat: { panes: orderedPaneIds.map((id) => ({ id })) } },
    });

    events.length = 0;
    expect(await shell.dispatch({
      type: "chat.panes.reorder",
      expectedOrderedPaneIds: orderedPaneIds.slice(1),
      orderedPaneIds: orderedPaneIds.slice(1),
    })).toMatchObject({
      ok: false,
      error: { code: "conflict", retryable: false, action: "none" },
    });
    expect(events).toEqual([]);

    expect(await shell.dispatch({
      type: "chat.panes.reorder",
      expectedOrderedPaneIds: initialOrder,
      orderedPaneIds: initialOrder,
    })).toMatchObject({
      ok: false,
      error: { code: "conflict", retryable: false, action: "none" },
    });
    expect(events).toEqual([]);
    shell.dispose();
  });

  test("drives pathless project add and correlated portable task reads", async () => {
    const fixture = getHRATaskTransportFixture("local-ready");
    const harness = createHRADirectTransport(fixture.world, fixture.runtime);
    const bridge = createRuntimeBridge(harness.transport, {
      createOperationId: () => "op_direct0001",
    });
    const shell = createRuntimeShell(bridge);
    const invalidations: string[] = [];
    shell.subscribeTaskInvalidations((invalidation) => invalidations.push(invalidation.workspaceId));
    await shell.connect();

    const context = await shell.dispatchTask({
      type: "task.workspace.context",
      workspaceId: "wsp_00000000000000000000000000",
    });
    const lookup = await shell.dispatchTask({
      type: "task.lookup",
      workspaceId: "wsp_00000000000000000000000000",
      taskKey: "KIT-0000000",
    });
    const added = await shell.addProject();

    expect(context).toMatchObject({ result: { type: "taskWorkspaceContext" } });
    expect(lookup).toMatchObject({
      result: { type: "taskLookup", taskKey: "KIT-0000000", task: { key: "KIT-0000000" } },
    });
    expect(added).toMatchObject({ status: "created", repository: { name: "Local hra" } });
    expect(invalidations).toEqual(["wsp_00000000000000000000000000"]);
    expect(harness.getSnapshot().invocations.at(-1)).toEqual({
      command: "hra.project.add",
      payload: { version: runtimeProtocolVersion },
    });
    shell.dispose();
  });

  test("scopes task lookup page fallbacks by workspace before matching a task key", async () => {
    const fixture = getHRATaskTransportFixture("local-ready");
    const stateFixture = fixture.world.task.states.find(
      ({ id }) => id === fixture.world.task.initialStateId,
    );
    if (stateFixture === undefined) throw new Error("The local task fixture state is missing.");
    const state = parseHRADirectTaskProjectionState(stateFixture.projectionJson);
    const localWorkspace = state.workspaces[0];
    const localPage = state.pages[0];
    const localItem = localPage?.page.items[0];
    if (localWorkspace === undefined || localPage === undefined || localItem === undefined) {
      throw new Error("The local task fallback fixture is incomplete.");
    }
    const foreignWorkspaceId = "wsp_11111111111111111111111111";
    const foreignTaskId = "tsk_11111111111111111111111111";
    const collisionState = {
      ...state,
      details: [],
      workspaces: [
        localWorkspace,
        {
          ...localWorkspace,
          id: foreignWorkspaceId,
          name: "Foreign hra",
          slug: "foreign-hra",
          authority: {
            kind: "local" as const,
            localWorkspaceId: foreignWorkspaceId,
            ownerInstallationId: "install_foreign0001",
          },
        },
      ],
      pages: [
        {
          requestCursor: null,
          page: {
            ...localPage.page,
            workspaceId: foreignWorkspaceId,
            items: [{
              ...localItem,
              task: { ...localItem.task, id: foreignTaskId },
            }],
          },
        },
        localPage,
      ],
    };
    const world = parseHRADirectWorld({
      ...fixture.world,
      task: {
        ...fixture.world.task,
        states: [{
          ...stateFixture,
          projectionJson: JSON.stringify(collisionState),
        }],
      },
    });
    const harness = createHRADirectTransport(world, fixture.runtime);
    const shell = createRuntimeShell(createRuntimeBridge(harness.transport, {
      createOperationId: () => "op_lookup0001",
    }));
    await shell.connect();

    const local = await shell.dispatchTask({
      type: "task.lookup",
      workspaceId: localWorkspace.id,
      taskKey: localItem.task.key,
    });
    const foreign = await shell.dispatchTask({
      type: "task.lookup",
      workspaceId: foreignWorkspaceId,
      taskKey: localItem.task.key,
    });

    expect(local).toMatchObject({
      ok: true,
      result: { type: "taskLookup", task: { id: localItem.task.id } },
    });
    expect(foreign).toMatchObject({
      ok: true,
      result: { type: "taskLookup", task: { id: foreignTaskId } },
    });
    shell.dispose();
  });

  test("selects and consumes only a transition correlated to the exact mutation target", async () => {
    const stopFixture = getHRATaskTransportFixture("stop-requested");
    const stopTransition = stopFixture.world.task.mutationTransitions[0];
    if (stopTransition === undefined) throw new Error("The stop transition fixture is missing.");
    const stopReceipt = JSON.parse(stopTransition.receiptJson) as {
      readonly result: Readonly<Record<string, unknown>>;
    };
    const stopWorld = parseHRADirectWorld({
      ...stopFixture.world,
      task: {
        ...stopFixture.world.task,
        mutationTransitions: [
          {
            ...stopTransition,
            id: "stop-wrong-run",
            receiptJson: JSON.stringify({
              ...stopReceipt,
              result: { ...stopReceipt.result, runId: "run_wrong_target" },
            }),
          },
          stopTransition,
        ],
      },
    });
    const stopHarness = createHRADirectTransport(stopWorld, stopFixture.runtime);
    const stopShell = createRuntimeShell(createRuntimeBridge(stopHarness.transport, {
      createOperationId: () => "op_transition0001",
    }));
    const stopInvalidations: string[] = [];
    stopShell.subscribeTaskInvalidations((invalidation) => {
      stopInvalidations.push(invalidation.scope);
    });
    await stopShell.connect();

    const stopCommand = {
      expectedWorkspaceRevision: 16,
      operationId: "op_00000000000000000000000009",
      kind: "dispatch.stop" as const,
      runId: "run_stop_current",
    };
    const wrongTarget = await stopShell.dispatchTask({
      type: "task.mutate",
      workspaceId: WORKSPACE_ID,
      intent: {
        ...stopCommand,
        operationId: "op_00000000000000000000000008",
        runId: "run_absent_target",
      },
    });
    expect(wrongTarget).toMatchObject({
      ok: false,
      error: { code: "not_implemented" },
    });
    expect(stopInvalidations).toEqual([]);

    const stopped = await stopShell.dispatchTask({
      type: "task.mutate",
      workspaceId: WORKSPACE_ID,
      intent: stopCommand,
    });
    expect(stopped).toMatchObject({
      ok: true,
      result: {
        type: "taskMutation",
        mutation: { result: { runId: "run_stop_current" } },
      },
    });
    expect(stopInvalidations).toEqual(["task_detail"]);

    const replayed = await stopShell.dispatchTask({
      type: "task.mutate",
      workspaceId: WORKSPACE_ID,
      intent: stopCommand,
    });
    expect(replayed).toEqual(stopped);
    expect(stopInvalidations).toEqual(["task_detail"]);

    const conflictingReuse = await stopShell.dispatchTask({
      type: "task.mutate",
      workspaceId: WORKSPACE_ID,
      intent: { ...stopCommand, runId: "run_conflicting_target" },
    });
    expect(conflictingReuse).toMatchObject({
      ok: false,
      error: { code: "conflict", retryable: false },
    });
    expect(stopInvalidations).toEqual(["task_detail"]);
    stopShell.dispose();

    const ambiguityFixture = getHRATaskTransportFixture("ambiguity-resolved");
    const ambiguityHarness = createHRADirectTransport(
      ambiguityFixture.world,
      ambiguityFixture.runtime,
    );
    const ambiguityShell = createRuntimeShell(createRuntimeBridge(
      ambiguityHarness.transport,
      { createOperationId: () => "op_transition0002" },
    ));
    await ambiguityShell.connect();
    const baseAmbiguity = {
      expectedWorkspaceRevision: 20,
      expectedTaskRevision: 20,
      kind: "dispatch.resolve_ambiguity" as const,
      sourceRunId: "run_ambiguous_source",
      taskId: "tsk_00000000000000000000000007",
    };
    const wrongOutcome = await ambiguityShell.dispatchTask({
      type: "task.mutate",
      workspaceId: WORKSPACE_ID,
      intent: {
        ...baseAmbiguity,
        operationId: "op_00000000000000000000000010",
        reason: "declared_failed",
      },
    });
    expect(wrongOutcome).toMatchObject({
      ok: false,
      error: { code: "not_implemented" },
    });
    const correlatedOutcome = await ambiguityShell.dispatchTask({
      type: "task.mutate",
      workspaceId: WORKSPACE_ID,
      intent: {
        ...baseAmbiguity,
        operationId: "op_00000000000000000000000011",
        reason: "confirmed_cancelled",
      },
    });
    expect(correlatedOutcome).toMatchObject({
      ok: true,
      result: {
        type: "taskMutation",
        mutation: { result: { phase: "cancelled" } },
      },
    });
    ambiguityShell.dispose();
  });

  test("models durable local mutation attempts across restart reuse and settlement", async () => {
    const fixture = getHRATaskTransportFixture("stop-requested");
    const harness = createHRADirectTransport(fixture.world, fixture.runtime);
    const shell = createRuntimeShell(createRuntimeBridge(harness.transport, {
      createOperationId: () => "op_attemptbridge0001",
    }));
    await shell.connect();

    const attemptId = "op_00000000000000000000000009";
    const fingerprint = `sha256_${"a".repeat(64)}`;
    const prepared = await shell.dispatchTask({
      type: "task.mutation.attempt.prepare",
      workspaceId: WORKSPACE_ID,
      attemptId,
      commandKind: "dispatch.stop",
      fingerprint,
    });
    expect(prepared).toMatchObject({
      ok: true,
      result: {
        type: "taskMutationAttempt",
        attempt: { attemptId, revision: 1, state: "prepared" },
      },
    });

    const recovered = await shell.dispatchTask({
      type: "task.mutation.attempt.prepare",
      workspaceId: WORKSPACE_ID,
      attemptId: "op_00000000000000000000000019",
      commandKind: "dispatch.stop",
      fingerprint,
    });
    expect(recovered).toMatchObject({
      ok: true,
      result: {
        type: "taskMutationAttempt",
        attempt: { attemptId, revision: 1, state: "prepared" },
      },
    });

    const started = await shell.dispatchTask({
      type: "task.mutation.attempt.start",
      workspaceId: WORKSPACE_ID,
      attemptId,
      expectedRevision: 1,
      intent: {
        expectedWorkspaceRevision: 16,
        operationId: attemptId,
        kind: "dispatch.stop",
        runId: "run_stop_current",
      },
    });
    expect(started).toMatchObject({
      ok: true,
      result: {
        type: "taskMutationAttempt",
        attempt: { attemptId, revision: 2, state: "effect_started" },
      },
    });

    const mutation = await shell.dispatchTask({
      type: "task.mutate",
      workspaceId: WORKSPACE_ID,
      intent: {
        expectedWorkspaceRevision: 16,
        operationId: attemptId,
        kind: "dispatch.stop",
        runId: "run_stop_current",
      },
    });
    expect(mutation).toMatchObject({
      ok: true,
      result: { type: "taskMutation" },
    });

    const inspected = await shell.dispatchTask({
      type: "task.mutation.attempt.inspect",
      workspaceId: WORKSPACE_ID,
      attemptId,
      expectedRevision: 2,
    });
    expect(inspected).toMatchObject({
      ok: true,
      result: {
        type: "taskMutationAttemptInspection",
        inspection: {
          attemptId,
          commandKind: "dispatch.stop",
          resolution: { outcome: "committed" },
        },
      },
    });
    const stillOpen = await shell.dispatchTask({
      type: "task.mutation.attempt.list",
      workspaceId: WORKSPACE_ID,
      limit: 32,
    });
    expect(stillOpen).toMatchObject({
      ok: true,
      result: {
        type: "taskMutationAttemptList",
        attempts: [{ attemptId, state: "effect_started" }],
      },
    });

    const reconciled = await shell.dispatchTask({
      type: "task.mutation.attempt.reconcile",
      workspaceId: WORKSPACE_ID,
      attemptId,
      expectedRevision: 2,
    });
    expect(reconciled).toMatchObject({
      ok: true,
      result: {
        type: "taskMutationReconciliation",
        reconciliation: {
          attemptId,
          commandKind: "dispatch.stop",
          resolution: { outcome: "committed" },
        },
      },
    });

    const open = await shell.dispatchTask({
      type: "task.mutation.attempt.list",
      workspaceId: WORKSPACE_ID,
      limit: 32,
    });
    expect(open).toMatchObject({
      ok: true,
      result: { type: "taskMutationAttemptList", attempts: [] },
    });

    const next = await shell.dispatchTask({
      type: "task.mutation.attempt.prepare",
      workspaceId: WORKSPACE_ID,
      attemptId: "op_00000000000000000000000029",
      commandKind: "dispatch.stop",
      fingerprint,
    });
    expect(next).toMatchObject({
      ok: true,
      result: {
        type: "taskMutationAttempt",
        attempt: {
          attemptId: "op_00000000000000000000000029",
          state: "prepared",
        },
      },
    });
    shell.dispose();
  });

  test("rejects retry command drift without consuming the fixture or invalidating projections", async () => {
    const fixture = getHRATaskTransportFixture("retry-failed");
    const harness = createHRADirectTransport(fixture.world, fixture.runtime);
    const shell = createRuntimeShell(createRuntimeBridge(harness.transport, {
      createOperationId: () => "op_retrydrift0001",
    }));
    const invalidations: string[] = [];
    shell.subscribeTaskInvalidations((invalidation) => {
      invalidations.push(`${invalidation.scope}:${String(invalidation.projectionRevision)}`);
    });
    await shell.connect();

    const command = {
      expectedTaskRevision: 18,
      expectedWorkspaceRevision: 18,
      kind: "dispatch.retry" as const,
      operationId: "op_00000000000000000000000020",
      sourceRunId: "run_failed_source",
      taskId: "tsk_00000000000000000000000006",
    };
    const driftedCommands = [
      {
        ...command,
        operationId: "op_00000000000000000000000021",
        taskId: "tsk_11111111111111111111111111",
      },
      {
        ...command,
        operationId: "op_00000000000000000000000022",
        sourceRunId: "run_different_source",
      },
      {
        ...command,
        operationId: "op_00000000000000000000000023",
        expectedTaskRevision: 17,
      },
    ];

    for (const drifted of driftedCommands) {
      const rejected = await shell.dispatchTask({
        type: "task.mutate",
        workspaceId: WORKSPACE_ID,
        intent: drifted,
      });
      expect(rejected).toMatchObject({
        ok: false,
        error: { code: "not_implemented" },
      });
      expect(invalidations).toEqual([]);
    }

    const retried = await shell.dispatchTask({
      type: "task.mutate",
      workspaceId: WORKSPACE_ID,
      intent: command,
    });
    expect(retried).toMatchObject({
      ok: true,
      result: {
        type: "taskMutation",
        mutation: {
          result: {
            kind: "run_updated",
            phase: "queued",
            runId: "run_retry_queued",
          },
        },
      },
    });
    expect(invalidations).toEqual(["task_detail:19"]);
    const detail = await shell.dispatchTask({
      type: "task.detail",
      workspaceId: WORKSPACE_ID,
      taskId: command.taskId,
    });
    expect(detail).toMatchObject({
      result: {
        type: "taskDetail",
        detail: {
          task: {
            revision: 18,
            status: "open",
          },
          runs: [
            { id: "run_retry_queued", phase: "queued" },
            { id: "run_failed_source", phase: "failed" },
          ],
        },
      },
    });
    if (!detail.ok || detail.result.type !== "taskDetail") {
      throw new Error("The retry detail projection is missing.");
    }
    expect(detail.result.detail.task).not.toHaveProperty("currentClaim");
    const page = await shell.dispatchTask({
      type: "task.list",
      workspaceId: WORKSPACE_ID,
      view: "all",
      cursor: null,
      limit: 100,
    });
    expect(page).toMatchObject({
      result: {
        type: "taskListPage",
        page: {
          items: [{
            run: {
              phase: "queued",
            },
            task: {
              id: command.taskId,
            },
          }],
        },
      },
    });
    shell.dispose();
  });

  test("rejects stale or different HITL requests without consuming or invalidating the exact response fixture", async () => {
    const fixture = getHRATaskTransportFixture("hitl-pending");
    const harness = createHRADirectTransport(fixture.world, fixture.runtime);
    const shell = createRuntimeShell(createRuntimeBridge(harness.transport, {
      createOperationId: () => "op_hitldrift00001",
    }));
    const invalidations: string[] = [];
    shell.subscribeTaskInvalidations((invalidation) => {
      invalidations.push(`${invalidation.scope}:${String(invalidation.projectionRevision)}`);
    });
    await shell.connect();

    const command = {
      expectedWorkspaceRevision: 12,
      interactionId: "interaction_hitl_pending",
      kind: "interaction.respond" as const,
      operationId: "op_00000000000000000000000030",
      request: {
        id: "interaction_hitl_pending",
        createdAt: HRA_DIRECT_ACTIVE_REQUEST_TIME,
        expiresAt: HRA_DIRECT_ACTIVE_DEADLINE,
        kind: "file_change_approval" as const,
        scope: "once" as const,
      },
      response: {
        decision: "approve_once" as const,
        kind: "file_change_approval" as const,
      },
      runId: "run_hitl_pending",
    };
    const driftedCommands = [
      {
        ...command,
        operationId: "op_00000000000000000000000031",
        request: {
          ...command.request,
          createdAt: Date.UTC(2026, 6, 19, 15, 0, 0),
          expiresAt: Date.UTC(2026, 6, 19, 15, 1, 0),
        },
      },
      {
        ...command,
        operationId: "op_00000000000000000000000032",
        request: {
          ...command.request,
          createdAt: HRA_DIRECT_ACTIVE_REQUEST_TIME - 1,
        },
      },
    ];

    for (const drifted of driftedCommands) {
      const rejected = await shell.dispatchTask({
        type: "task.mutate",
        workspaceId: WORKSPACE_ID,
        intent: drifted,
      });
      expect(rejected).toMatchObject({
        ok: false,
        error: { code: "not_implemented" },
      });
      expect(invalidations).toEqual([]);
    }

    const answered = await shell.dispatchTask({
      type: "task.mutate",
      workspaceId: WORKSPACE_ID,
      intent: command,
    });
    expect(answered).toMatchObject({
      ok: true,
      result: {
        type: "taskMutation",
        mutation: {
          result: {
            interactionId: command.interactionId,
            kind: "interaction_updated",
            state: "answered",
          },
        },
      },
    });
    expect(invalidations).toEqual(["task_detail:13"]);
    const detail = await shell.dispatchTask({
      type: "task.detail",
      workspaceId: WORKSPACE_ID,
      taskId: "tsk_00000000000000000000000003",
    });
    expect(detail).toMatchObject({
      result: {
        type: "taskDetail",
        detail: {
          task: {
            revision: 12,
            status: "in_progress",
          },
          runs: [{
            id: "run_hitl_pending",
            phase: "waiting",
            interactions: [{
              responseRevision: 1,
              state: "answered",
            }],
          }],
        },
      },
    });
    shell.dispose();
  });

  test("does not reinterpret a valid task handler failure as an account request", async () => {
    const fixture = getHRATaskTransportFixture("stop-requested");
    const harness = createHRADirectTransport(fixture.world, fixture.runtime);
    const handlerFailure = new Error("observable task handler failure");
    const unsubscribe = harness.transport.on(runtimeEventName, () => {
      throw handlerFailure;
    });

    let failure: unknown;
    try {
      await harness.transport.invoke("hra.runtime.dispatch", {
        version: runtimeProtocolVersion,
        operationId: "op_handler0001",
        command: {
          type: "task.mutate",
          workspaceId: WORKSPACE_ID,
          intent: {
            expectedWorkspaceRevision: 16,
            operationId: "op_00000000000000000000000012",
            kind: "dispatch.stop",
            runId: "run_stop_current",
          },
        },
      });
    } catch (reason) {
      failure = reason;
    }

    expect(failure).toBe(handlerFailure);
    unsubscribe();
    harness.dispose();
  });

  test("projects two simultaneous task lanes and a pending HITL response through shell and bridge", async () => {
    const runningFixture = getHRATaskTransportFixture("two-running");
    const runningHarness = createHRADirectTransport(runningFixture.world, runningFixture.runtime);
    const runningBridge = createRuntimeBridge(runningHarness.transport, {
      createOperationId: () => "op_direct0001",
    });
    const runningShell = createRuntimeShell(runningBridge);
    await runningShell.connect();
    const page = await runningShell.dispatchTask({
      type: "task.list",
      workspaceId: "wsp_00000000000000000000000000",
      view: "all",
      cursor: null,
      limit: 100,
    });
    expect(page).toMatchObject({
      result: {
        type: "taskListPage",
        page: {
          items: [
            { task: { key: "KIT-0000001" }, run: { phase: "running" } },
            { task: { key: "KIT-0000002" }, run: { phase: "running" } },
          ],
        },
      },
    });
    runningShell.dispose();

    const hitlFixture = getHRATaskTransportFixture("hitl-pending");
    const hitlHarness = createHRADirectTransport(hitlFixture.world, hitlFixture.runtime);
    const hitlShell = createRuntimeShell(createRuntimeBridge(hitlHarness.transport, {
      createOperationId: () => "op_direct0002",
    }));
    const invalidations: string[] = [];
    hitlShell.subscribeTaskInvalidations((invalidation) => invalidations.push(invalidation.scope));
    await hitlShell.connect();
    const response = await hitlShell.dispatchTask({
      type: "task.mutate",
      workspaceId: WORKSPACE_ID,
      intent: {
        expectedWorkspaceRevision: 12,
        operationId: "op_00000000000000000000000001",
        kind: "interaction.respond",
        runId: "run_hitl_pending",
        interactionId: "interaction_hitl_pending",
        request: {
          id: "interaction_hitl_pending",
          createdAt: HRA_DIRECT_ACTIVE_REQUEST_TIME,
          expiresAt: HRA_DIRECT_ACTIVE_DEADLINE,
          kind: "file_change_approval",
          scope: "once",
        },
        response: { kind: "file_change_approval", decision: "approve_once" },
      },
    });
    expect(response).toMatchObject({
      ok: true,
      result: { type: "taskMutation", mutation: { result: { state: "answered" } } },
    });
    expect(invalidations).toEqual(["task_detail"]);
    const detail = await hitlShell.dispatchTask({
      type: "task.detail",
      workspaceId: "wsp_00000000000000000000000000",
      taskId: "tsk_00000000000000000000000003",
    });
    expect(detail).toMatchObject({
      result: {
        type: "taskDetail",
        detail: { runs: [{ interactions: [{ state: "answered" }] }] },
      },
    });
    hitlShell.dispose();
  });

  test("emits one parsed composite current-run invalidation on the owned sequence", async () => {
    const fixture = getHRATaskTransportFixture("two-running");
    const target = fixture.world.task.states.find(
      ({ id }) => id === hraDirectTaskStateIds.currentRunDisplayRevision12,
    );
    if (target === undefined) throw new Error("The revision-12 task state is missing.");
    const targetState = parseHRADirectTaskProjectionState(target.projectionJson);
    const targetWorkspace = targetState.workspaces.find(
      ({ id }) => id === hraDirectTaskIds.workspace,
    );
    if (targetWorkspace === undefined) {
      throw new Error("The revision-12 workspace summary is missing.");
    }
    for (const view of taskWorkspaceViewValues) {
      const firstPage = targetState.pages.find(({ page, requestCursor }) =>
        page.workspaceId === hraDirectTaskIds.workspace &&
        page.view === view &&
        requestCursor === null
      );
      if (firstPage === undefined) {
        throw new Error(`The revision-12 ${view} first page is missing.`);
      }
      expect(targetWorkspace.counts[view]).toEqual({
        capped: false,
        value: firstPage.page.items.length,
      });
    }
    const harness = createHRADirectTransport(fixture.world, fixture.runtime);
    const shell = createRuntimeShell(createRuntimeBridge(harness.transport));
    const invalidations: unknown[] = [];
    shell.subscribeTaskInvalidations((invalidation) => {
      invalidations.push(invalidation);
    });
    await shell.connect();

    const readCurrentPair = async () => await Promise.all([
      shell.dispatchTask({
        cursor: null,
        limit: 100,
        type: "task.list" as const,
        view: "all" as const,
        workspaceId: hraDirectTaskIds.workspace,
      }),
      shell.dispatchTask({
        taskId: hraDirectTaskIds.currentTask,
        type: "task.detail" as const,
        workspaceId: hraDirectTaskIds.workspace,
      }),
    ]);
    const [initialList, initialDetail] = await readCurrentPair();
    expect(initialList).toMatchObject({
      ok: true,
      result: {
        page: { projectionRevision: 11 },
        type: "taskListPage",
      },
    });
    expect(initialDetail).toMatchObject({
      ok: true,
      result: {
        detail: { projectionRevision: 11 },
        type: "taskDetail",
      },
    });

    const before = shell.getState();
    if (before.state !== "ready") throw new Error("Direct shell did not connect");
    const beforeSequence = before.snapshot.lastSequence;
    const change = fixtureCurrentRunTaskChange(12);
    harness.emitTaskStateInvalidation(
      hraDirectTaskStateIds.currentRunDisplayRevision12,
      change,
    );

    expect(invalidations).toEqual([change]);
    const after = shell.getState();
    if (after.state !== "ready") throw new Error("Direct shell left ready state");
    expect(after.snapshot.lastSequence).toBe(beforeSequence + 1);
    const [list, detail] = await readCurrentPair();
    expect(list).toMatchObject({
      ok: true,
      result: {
        page: { projectionRevision: 12 },
        type: "taskListPage",
      },
    });
    expect(detail).toMatchObject({
      ok: true,
      result: {
        detail: { projectionRevision: 12 },
        type: "taskDetail",
      },
    });
    const emitUnknown = harness.emitTaskStateInvalidation as (
      taskStateId: string,
      invalidation: unknown,
    ) => void;
    expect(() => emitUnknown(
      hraDirectTaskStateIds.currentRunDisplayRevision12,
      {
        ...change,
        affectedProjections: [],
      },
    )).toThrow();
    shell.dispose();
  });

  test("rejects a task-state invalidation missing any declared list view", () => {
    const fixture = getHRATaskTransportFixture("two-running");
    const target = fixture.world.task.states.find(
      ({ id }) => id === hraDirectTaskStateIds.currentRunDisplayRevision12,
    );
    if (target === undefined) throw new Error("The revision-12 task state is missing.");
    const targetState = parseHRADirectTaskProjectionState(target.projectionJson);
    const incompleteWorld = parseHRADirectWorld({
      ...fixture.world,
      task: {
        ...fixture.world.task,
        states: fixture.world.task.states.map((state) =>
          state.id !== target.id
            ? state
            : {
                ...state,
                projectionJson: JSON.stringify({
                  ...targetState,
                  pages: targetState.pages.filter(({ page }) =>
                    page.view !== "review"
                  ),
                }),
              }
        ),
      },
    });
    const harness = createHRADirectTransport(incompleteWorld, fixture.runtime);
    let deliveredEvents = 0;
    harness.transport.on(runtimeEventName, () => {
      deliveredEvents += 1;
    });

    expect(() => harness.emitTaskStateInvalidation(
      hraDirectTaskStateIds.currentRunDisplayRevision12,
      fixtureCurrentRunTaskChange(12),
    )).toThrow("every exact affected list projection");
    expect(deliveredEvents).toBe(0);
    harness.dispose();
  });

  test("rejects an affected list represented only by a continuation fixture", () => {
    const fixture = getHRATaskTransportFixture("two-running");
    const target = fixture.world.task.states.find(
      ({ id }) => id === hraDirectTaskStateIds.currentRunDisplayRevision12,
    );
    if (target === undefined) throw new Error("The revision-12 task state is missing.");
    const targetState = parseHRADirectTaskProjectionState(target.projectionJson);
    const continuationOnlyWorld = parseHRADirectWorld({
      ...fixture.world,
      task: {
        ...fixture.world.task,
        states: fixture.world.task.states.map((state) =>
          state.id !== target.id
            ? state
            : {
                ...state,
                projectionJson: JSON.stringify({
                  ...targetState,
                  pages: targetState.pages.map((page) =>
                    page.page.view === "review"
                      ? { ...page, requestCursor: "review-next" }
                      : page
                  ),
                }),
              }
        ),
      },
    });
    const harness = createHRADirectTransport(
      continuationOnlyWorld,
      fixture.runtime,
    );
    let deliveredEvents = 0;
    harness.transport.on(runtimeEventName, () => {
      deliveredEvents += 1;
    });

    expect(() => harness.emitTaskStateInvalidation(
      hraDirectTaskStateIds.currentRunDisplayRevision12,
      fixtureCurrentRunTaskChange(12),
    )).toThrow("every exact affected list projection");
    expect(deliveredEvents).toBe(0);
    harness.dispose();
  });

  test("rejects an assigned list that is not correlated to the active agent", () => {
    const fixture = getHRATaskTransportFixture("two-running");
    const target = fixture.world.task.states.find(
      ({ id }) => id === hraDirectTaskStateIds.currentRunDisplayRevision12,
    );
    if (target === undefined) throw new Error("The revision-12 task state is missing.");
    const targetState = parseHRADirectTaskProjectionState(target.projectionJson);
    const mismatchedAgentWorld = parseHRADirectWorld({
      ...fixture.world,
      task: {
        ...fixture.world.task,
        states: fixture.world.task.states.map((state) =>
          state.id !== target.id
            ? state
            : {
                ...state,
                projectionJson: JSON.stringify({
                  ...targetState,
                  pages: targetState.pages.map((fixturePage) =>
                    fixturePage.page.view === "assigned"
                      ? {
                          ...fixturePage,
                          page: {
                            ...fixturePage.page,
                            assignedAgentId: "agent_inactive",
                          },
                        }
                      : fixturePage
                  ),
                }),
              }
        ),
      },
    });
    const harness = createHRADirectTransport(
      mismatchedAgentWorld,
      fixture.runtime,
    );
    let deliveredEvents = 0;
    harness.transport.on(runtimeEventName, () => {
      deliveredEvents += 1;
    });

    expect(() => harness.emitTaskStateInvalidation(
      hraDirectTaskStateIds.currentRunDisplayRevision12,
      fixtureCurrentRunTaskChange(12),
    )).toThrow("correlate its first page to the active agent");
    expect(deliveredEvents).toBe(0);
    harness.dispose();
  });

  test("rejects an affected list whose summary count disagrees with its first page", () => {
    const fixture = getHRATaskTransportFixture("two-running");
    const target = fixture.world.task.states.find(
      ({ id }) => id === hraDirectTaskStateIds.currentRunDisplayRevision12,
    );
    if (target === undefined) throw new Error("The revision-12 task state is missing.");
    const targetState = parseHRADirectTaskProjectionState(target.projectionJson);
    const mismatchedCountWorld = parseHRADirectWorld({
      ...fixture.world,
      task: {
        ...fixture.world.task,
        states: fixture.world.task.states.map((state) =>
          state.id !== target.id
            ? state
            : {
                ...state,
                projectionJson: JSON.stringify({
                  ...targetState,
                  workspaces: targetState.workspaces.map((workspace) =>
                    workspace.id === hraDirectTaskIds.workspace
                      ? {
                          ...workspace,
                          counts: {
                            ...workspace.counts,
                            all: {
                              capped: false,
                              value: workspace.counts.all.value + 1,
                            },
                          },
                        }
                      : workspace
                  ),
                }),
              }
        ),
      },
    });
    const harness = createHRADirectTransport(
      mismatchedCountWorld,
      fixture.runtime,
    );
    let deliveredEvents = 0;
    harness.transport.on(runtimeEventName, () => {
      deliveredEvents += 1;
    });

    expect(() => harness.emitTaskStateInvalidation(
      hraDirectTaskStateIds.currentRunDisplayRevision12,
      fixtureCurrentRunTaskChange(12),
    )).toThrow("summary count equal to its first page");
    expect(deliveredEvents).toBe(0);
    harness.dispose();
  });

  test("applies review, stop, retry, and ambiguity receipts to bounded next projections", async () => {
    const cases = [
      {
        fixture: "review-accept",
        command: {
          kind: "review.accept" as const,
          expectedReviewRevision: 14,
          submissionId: "sub_00000000000000000000000000",
          taskId: "tsk_00000000000000000000000004",
        },
        expectedReceipt: { result: { kind: "submission_updated" } },
        expectedDetail: { task: { status: "done" } },
        taskId: "tsk_00000000000000000000000004",
      },
      {
        fixture: "review-reject",
        command: {
          kind: "review.reject" as const,
          expectedReviewRevision: 14,
          submissionId: "sub_00000000000000000000000000",
          taskId: "tsk_00000000000000000000000004",
          reason: "Needs a deterministic replay check.",
        },
        expectedReceipt: { result: { kind: "submission_updated" } },
        expectedDetail: { task: { status: "open" } },
        taskId: "tsk_00000000000000000000000004",
      },
      {
        fixture: "stop-requested",
        command: { kind: "dispatch.stop" as const, runId: "run_stop_current" },
        expectedReceipt: { result: { kind: "run_updated", phase: "cancel_requested" } },
        expectedDetail: {
          task: {
            currentClaim: {
              fence: 16,
              leaseGeneration: 16,
            },
            revision: 16,
            status: "in_progress",
          },
          runs: [{ phase: "cancel_requested" }],
        },
        taskId: "tsk_00000000000000000000000005",
      },
      {
        fixture: "retry-failed",
        command: {
          kind: "dispatch.retry" as const,
          expectedTaskRevision: 18,
          sourceRunId: "run_failed_source",
          taskId: "tsk_00000000000000000000000006",
        },
        expectedReceipt: { result: { kind: "run_updated", phase: "queued" } },
        expectedDetail: {
          runs: [
            { id: "run_retry_queued", phase: "queued" },
            { id: "run_failed_source", phase: "failed" },
          ],
        },
        taskId: "tsk_00000000000000000000000006",
      },
      {
        fixture: "ambiguity-resolved",
        command: {
          kind: "dispatch.resolve_ambiguity" as const,
          expectedTaskRevision: 20,
          sourceRunId: "run_ambiguous_source",
          taskId: "tsk_00000000000000000000000007",
          reason: "confirmed_cancelled" as const,
        },
        expectedReceipt: { result: { kind: "run_updated", phase: "cancelled" } },
        expectedDetail: { runs: [{ phase: "cancelled" }] },
        taskId: "tsk_00000000000000000000000007",
      },
    ] as const;

    for (const [index, fixtureCase] of cases.entries()) {
      const fixture = getHRATaskTransportFixture(fixtureCase.fixture);
      const harness = createHRADirectTransport(fixture.world, fixture.runtime);
      const shell = createRuntimeShell(createRuntimeBridge(harness.transport, {
        createOperationId: () => `op_direct${String(index).padStart(4, "0")}`,
      }));
      await shell.connect();
      const mutation = await shell.dispatchTask({
        type: "task.mutate",
        workspaceId: WORKSPACE_ID,
        intent: {
          expectedWorkspaceRevision: [14, 14, 16, 18, 20][index] ?? 1,
          operationId: `op_0000000000000000000000000${index + 2}`,
          ...fixtureCase.command,
        },
      });
      expect(mutation).toMatchObject({
        ok: true,
        result: { type: "taskMutation", mutation: fixtureCase.expectedReceipt },
      });
      const detail = await shell.dispatchTask({
        type: "task.detail",
        workspaceId: "wsp_00000000000000000000000000",
        taskId: fixtureCase.taskId,
      });
      expect(detail).toMatchObject({
        result: { type: "taskDetail", detail: fixtureCase.expectedDetail },
      });
      shell.dispose();
    }
  });

  test("recovers a task invalidation through an authoritative restart snapshot", async () => {
    const runtime = createHRADirectRuntime(
      createHRATaskTransportFixtureActivation("restart-resnapshot"),
    );
    await runtime.shell.connect();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runtime.harness.getSnapshot().snapshotReads).toBe(2);
    expect(runtime.shell.getState()).toMatchObject({ state: "ready", snapshot: { lastSequence: 2 } });
    runtime.dispose();
  });

  test("keeps private project and session commands outside the renderer seam", async () => {
    const fixture = activation("renderer-boundary");
    const harness = createHRADirectTransport(fixture.world, fixture.runtime);
    const bridge = createRuntimeBridge(harness.transport, {
      createOperationId: () => "op_session00000001",
    });
    const shell = createRuntimeShell(bridge);
    await shell.connect();

    const dispatchUnknown = shell.dispatch.bind(shell) as (command: unknown) => Promise<unknown>;
    for (const command of [
      { type: "project.inspect", projectId: "proj_direct001" },
      { type: "project.register", path: "/fixture/new" },
      { type: "thread.list", accountProfileId: "acct_personal01" },
      { type: "thread.start", accountProfileId: "acct_personal01" },
      { type: "thread.resume", threadId: "thread_direct001" },
      { type: "thread.fork", threadId: "thread_direct001", temporary: false },
      { type: "turn.start", threadId: "thread_direct001", prompt: "private" },
      { type: "turn.steer", threadId: "thread_direct001", prompt: "private" },
      { type: "interaction.answer", interactionId: "hitl_direct001", answer: "private" },
    ]) {
      const rejected = await dispatchUnknown(command).then(
        () => false,
        () => true,
      );
      expect(rejected).toBeTrue();
    }

    const commandTypes = harness.getSnapshot().invocations.flatMap(({ payload }) => {
      if (typeof payload !== "object" || payload === null || !("command" in payload)) return [];
      const command = payload.command;
      return typeof command === "object" && command !== null && "type" in command &&
          typeof command.type === "string"
        ? [command.type]
        : [];
    });
    expect(commandTypes).toEqual([]);
    shell.dispose();
  });

  test("recovers a sequence gap through the real shell resnapshot loop", async () => {
    const runtime = createHRADirectRuntime({
      kind: "scenario",
      scenario: "transport-recovery",
    });

    await runtime.shell.connect();
    await settleRuntime(runtime);

    expect(runtime.shell.getState()).toMatchObject({
      state: "ready",
      snapshot: {
        lastSequence: 2,
        accounts: [{ id: "acct_recovered1", label: "Recovered" }],
      },
    });
    expect(runtime.harness.getSnapshot()).toMatchObject({
      snapshotReads: 2,
      eventScriptFailures: [],
    });
    const activity = runtime.harness.store.getSnapshot().activity;
    expect(activity.active).toBe(0);
    expect(activity.started).toBeGreaterThan(0);
    expect(activity.settled).toBe(activity.started);
    runtime.shell.dispose();
  });

  test("keeps active-login removal previews internally consistent", async () => {
    const runtime = createHRADirectRuntime({
      kind: "scenario",
      scenario: "login-browser",
    });
    await runtime.shell.connect();

    const response = await runtime.shell.dispatch({
      type: "account.remove.preview",
      accountProfileId: "acct_personal01",
    });

    expect(response).toMatchObject({
      ok: true,
      result: {
        type: "accountRemovalPreview",
        preview: { blockers: ["loginActive"], canRemove: false, loginActive: true },
      },
    });
    runtime.shell.dispose();
  });

  test("successful subscription logout removes the row and preserves retained local data", async () => {
    const runtime = createHRADirectRuntime({
      kind: "scenario",
      scenario: "settings-browser-login",
    });
    await runtime.shell.connect();

    const response = await runtime.shell.dispatch({
      type: "account.logout",
      accountProfileId: "acct_work00001",
    });
    await settleRuntime(runtime);

    expect(response).toMatchObject({ ok: true, result: { type: "accepted" } });
    expect(runtime.shell.getState()).toMatchObject({
      state: "ready",
      snapshot: {
        accounts: [{ id: "acct_personal01" }],
        retainedAccountLocalData: [{ id: "acct_work00001", label: "Work" }],
      },
    });
    runtime.shell.dispose();
  });

  test("disposal fences chunk assembly and settles an active event script", async () => {
    const immediate = createHRADirectRuntime({
      kind: "scenario",
      scenario: "transport-recovery",
    });
    const connecting = immediate.shell.connect();
    immediate.shell.dispose();
    await connecting;
    await Promise.resolve();

    const afterImmediateDisposal = immediate.harness.getSnapshot();
    expect(afterImmediateDisposal).toMatchObject({
      cancelledScriptedEvents: 1,
      deliveredScriptedEvents: 0,
      disposed: true,
      eventListeners: 0,
      pendingSnapshotTransfers: 0,
      remainingScriptedEvents: 0,
      snapshotReads: 1,
    });
    expect(afterImmediateDisposal.invocations).toHaveLength(1);
    expect(immediate.harness.store.getSnapshot().activity).toEqual({
      active: 0,
      started: 1,
      settled: 1,
    });

    const fixture = activation("transport-recovery");
    const firstEvent = fixture.world.gateway.events[0];
    if (firstEvent === undefined) throw new Error("Recovery event fixture is missing.");
    const slowFixture = {
      ...fixture,
      world: parseHRADirectWorld({
        ...fixture.world,
        gateway: {
          ...fixture.world.gateway,
          events: [{ ...firstEvent, delayMs: 5_000 }],
        },
      }),
    };
    const running = createHRADirectRuntime(fixtureActivation(slowFixture));
    await running.shell.connect();
    expect(running.harness.store.getSnapshot().activity.active).toBe(1);

    running.dispose();
    const afterEventCancellation = running.harness.getSnapshot();
    const afterLogicalCancellation = running.harness.logical.snapshot();
    const cancelledActivity = running.harness.store.getSnapshot().activity;
    expect(cancelledActivity.active).toBe(0);
    expect(cancelledActivity.started).toBeGreaterThan(0);
    expect(cancelledActivity.settled).toBe(cancelledActivity.started);
    expect(afterEventCancellation).toMatchObject({
      cancelledScriptedEvents: 1,
      deliveredScriptedEvents: 0,
      disposed: true,
      eventListeners: 0,
      pendingSnapshotTransfers: 0,
      remainingScriptedEvents: 0,
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(running.harness.getSnapshot()).toEqual(afterEventCancellation);
    expect(running.harness.logical.snapshot()).toEqual(afterLogicalCancellation);
  });

  test("activity publication cannot reenter disposal before the request is fenced", async () => {
    const fixture = activation("transport-recovery");
    const harness = createHRADirectTransport(fixture.world, fixture.runtime);
    const bridge = createRuntimeBridge(harness.transport);
    const unsubscribe = harness.store.subscribe(() => {
      if (harness.store.getSnapshot().activity.active === 1) harness.dispose();
    });

    let failure: unknown = null;
    try {
      await bridge.snapshot();
    } catch (reason) {
      failure = reason;
    } finally {
      unsubscribe();
    }

    expect(failure).toBeInstanceOf(Error);
    expect(harness.getSnapshot()).toMatchObject({
      cancelledScriptedEvents: 1,
      disposed: true,
      eventListeners: 0,
      invocations: [],
      pendingSnapshotTransfers: 0,
      remainingScriptedEvents: 0,
      snapshotReads: 0,
    });
    expect(harness.store.getSnapshot().activity).toEqual({
      active: 0,
      started: 1,
      settled: 1,
    });
  });

  test("hostile event-listener failures remain observable and fully settled", async () => {
    const fixture = activation("transport-recovery");
    const harness = createHRADirectTransport(fixture.world, fixture.runtime);
    const bridge = createRuntimeBridge(harness.transport);
    const hostileReason = new Proxy(new Error("This message must remain unreadable."), {
      get: () => {
        throw new Error("The hostile reason cannot be inspected.");
      },
      getPrototypeOf: () => {
        throw new Error("The hostile reason has no inspectable prototype.");
      },
    });
    const unsubscribe = harness.transport.on(runtimeEventName, () => {
      throw hostileReason;
    });

    await bridge.snapshot();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (harness.getSnapshot().eventScriptFailures.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    expect(harness.getSnapshot()).toMatchObject({
      deliveredScriptedEvents: 0,
      eventScriptFailures: ["Uninspectable HRA Direct event-script failure"],
      remainingScriptedEvents: 1,
    });
    const activity = harness.store.getSnapshot().activity;
    expect(activity.active).toBe(0);
    expect(activity.started).toBe(activity.settled);

    unsubscribe();
    harness.dispose();
  });
});
