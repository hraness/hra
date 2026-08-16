import { describe, expect, test } from "bun:test";

import type { PinnedCodexDynamicToolRequest } from
  "../src/codex/dynamic-tool";
import { HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256 } from
  "../src/codex/dynamic-tool";
import type { SessionTurnLifecycle } from
  "../src/sessions/session-service";
import type { RuntimeHarnessDomainCommand } from "../../contracts/runtime";
import {
  createHarnessProductionCompositionV2,
  HarnessProductionCompositionV2Error,
  type HarnessProductionCompositionV2Parts,
} from "../src/harness/production-composition-v2";
import type { HarnessRendererResult } from
  "../src/harness/renderer-service-v2";
import type { HarnessRootChatAdmissionResultV2 } from
  "../src/harness/root-chat-admission-v2";
import type { RuntimePaths } from "../src/runtime-paths";

const rootAdmission = Object.freeze({
  projectId: "project-composition-v2",
  sourceSha: "a".repeat(40),
  paneId: "pane_composition_v2",
  chatTurnId: "chatturn_composition_v2",
  epochId: "hepoch_composition_v2",
  actorId: "hactor_composition_v2",
  turnId: "hturn_composition_v2",
  currentInputOperationId: "contextop_composition_v2",
  currentInputValueId: "ctxval_composition_v2",
  readyForProvider: true as const,
}) as HarnessRootChatAdmissionResultV2;
const rootAdmissionInput = Object.freeze({
  repositoryId: rootAdmission.projectId,
  canonicalWorkingDirectory: "/tmp/composition-v2",
  paneId: rootAdmission.paneId,
  chatTurnId: rootAdmission.chatTurnId,
  title: "Composition v2",
  prompt: "Use the recursive harness.",
  createdAt: "2026-08-06T12:00:00.000Z",
});

const lifecycleEvent: SessionTurnLifecycle = Object.freeze({
  accountProfileId: "acct_composition_v2",
  threadId: "thread_composition_v2",
  turnId: "turn_composition_v2",
  status: "completed",
});
const expiredFault = Object.freeze({
  type: "server_request_expired" as const,
  generation: 1,
  method: "item/tool/call",
  reason: "generation_ended" as const,
});
const capabilityPaths: RuntimePaths = Object.freeze({
  codexBinary: "/runtime/codex",
  codexHome: "/profiles/composition/codex-home",
  gitBinary: "/runtime/git/bin/git",
  gitRoot: "/runtime/git",
});
const capabilityNow = Date.parse("2026-08-06T12:00:00.000Z");

function capabilityReceipt(input: Readonly<{
  accountProfileId: string;
  binarySha256: string;
  codexVersion: string;
  paths: RuntimePaths;
  processGeneration: number;
}>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "oprte.codex.dynamic-tool.direct-lifecycle-receipt",
    source: "signed-in-real-app-server",
    runId: "019fbd82-efa4-7542-af14-492556dcbcf7",
    startedAt: new Date(capabilityNow).toISOString(),
    finishedAt: new Date(capabilityNow).toISOString(),
    accountProfileId: input.accountProfileId,
    codexBinary: input.paths.codexBinary,
    codexHome: input.paths.codexHome,
    codexVersion: input.codexVersion,
    binarySha256: input.binarySha256,
    processGeneration: input.processGeneration,
    registration: {
      initializeExperimentalApi: true,
      carrierMethod: "thread/start",
      paramsField: "dynamicTools",
      namespace: "oprte",
      tool: "rlm_run",
      specSha256: HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256,
    },
    observations: {
      registrationAccepted: true,
      exactThreadAndTurnIdentity: true,
      successfulCompletion: true,
      failedCompletion: true,
      cancellationResolution: true,
      duplicateCallObserved: true,
      duplicateCallRejected: true,
      restartGenerationScoped: true,
    },
  };
}

function dynamicRequest(
  accountProfileId = lifecycleEvent.accountProfileId,
): PinnedCodexDynamicToolRequest {
  return Object.freeze({ accountProfileId }) as unknown as
    PinnedCodexDynamicToolRequest;
}

function settingsUpdate(
  recursiveSessionsEnabled: boolean,
  expectedRevision = 1,
): Extract<RuntimeHarnessDomainCommand, {
  type: "harness.settings.update";
}> {
  return {
    type: "harness.settings.update",
    expectedHarnessRevision: expectedRevision,
    expectedRevision,
    recursiveSessionsEnabled,
    automaticFastMode: "criticalPath",
    contextQuotaBytes: 8 * 1024 * 1024,
    refinementMode: "off",
  };
}

function fixture(options: Readonly<{
  recursiveSessionsEnabled?: boolean;
  readSettings?: () => Promise<Readonly<{
    recursiveSessionsEnabled: boolean;
  }>>;
  chatSettled?: () => Promise<void>;
  rootObservation?: () => Promise<unknown>;
  rendererExecuteFailure?: Error;
  reconcileCapabilities?: (enabled: boolean) => Promise<void>;
  initializeLifecycle?: () => Promise<Readonly<{
    rendererInitialized: boolean;
    rendererRefreshedByProjection: boolean;
  }>>;
  preProviderStop?: () => Promise<Readonly<{
    providerStopPermitted: true;
    timedOutRunIds: readonly [];
  }>>;
}> = {}) {
  const calls: string[] = [];
  let rootObservationTail: Promise<void> = Promise.resolve();
  let recursiveSessionsEnabled = options.recursiveSessionsEnabled ?? true;
  const parts: HarnessProductionCompositionV2Parts = {
    settings: {
      read: () => options.readSettings?.() ?? ({ recursiveSessionsEnabled }),
    },
    renderer: {
      execute: (command) => {
        calls.push("renderer.execute");
        if (options.rendererExecuteFailure !== undefined) {
          return Promise.reject(options.rendererExecuteFailure);
        }
        if (command.type === "harness.settings.update") {
          recursiveSessionsEnabled = command.recursiveSessionsEnabled;
          return Promise.resolve({
            type: "harnessSettings" as const,
            harnessRevision: command.expectedHarnessRevision + 1,
            settings: {
              revision: command.expectedRevision + 1,
              recursiveSessionsEnabled: command.recursiveSessionsEnabled,
              automaticFastMode: command.automaticFastMode,
              contextQuotaBytes: command.contextQuotaBytes,
              refinementMode: command.refinementMode,
            },
          });
        }
        return Promise.resolve(
          Object.freeze({ type: "renderer-result" }) as unknown as
            HarnessRendererResult,
        );
      },
      refresh: () => {
        calls.push("renderer.refresh");
        return Promise.resolve();
      },
    },
    chat: {
      closeAdmission: () => undefined,
      settled: () => {
        calls.push("chat.settled");
        return options.chatSettled?.() ?? Promise.resolve();
      },
    },
    dynamicTools: {
      handle: () => {
        calls.push("dynamic.handle");
        return Promise.resolve(Object.freeze({ delivery: "responded" as const }));
      },
      expire: () => {
        calls.push("dynamic.expire");
        return 2;
      },
      settled: () => {
        calls.push("dynamic.settled");
        return Promise.resolve();
      },
    },
    roots: {
      observe: () => {
        calls.push("roots.observe");
        const result = Promise.resolve(options.rootObservation?.());
        rootObservationTail = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
      settleBeforeProvider: () => {
        calls.push("roots.settleBeforeProvider");
        return Promise.resolve(Object.freeze({ state: "settled" }));
      },
      settled: () => {
        calls.push("roots.settled");
        return rootObservationTail;
      },
    },
    rootAdmission: {
      admit: () => {
        calls.push("root.admit");
        return Promise.resolve(rootAdmission);
      },
    },
    providerCapabilities: {
      settingsChanged: (enabled) => {
        calls.push(`capabilities.settingsChanged:${enabled}`);
        return options.reconcileCapabilities?.(enabled) ?? Promise.resolve();
      },
      observe: () => {
        calls.push("capabilities.observe");
      },
      close: () => {
        calls.push("capabilities.close");
      },
      settled: () => {
        calls.push("capabilities.settled");
        return Promise.resolve();
      },
    },
    liveness: {
      observe: () => {
        calls.push("liveness.observe");
      },
      settled: () => {
        calls.push("liveness.settled");
        return Promise.resolve();
      },
    },
    harnessFactConsumer: {
      consumeCodexFacts: () => {
        calls.push("facts.consume");
      },
    },
    lifecycle: {
      initialize: () => {
        calls.push("lifecycle.initialize");
        return options.initializeLifecycle?.() ?? Promise.resolve({
          rendererInitialized: false,
          rendererRefreshedByProjection: true,
        });
      },
      closeAdmissions: () => {
        calls.push("lifecycle.closeAdmissions");
      },
      preProviderStop: () => {
        calls.push("lifecycle.preProviderStop");
        return options.preProviderStop?.() ?? Promise.resolve({
          providerStopPermitted: true as const,
          timedOutRunIds: [] as const,
        });
      },
      providerSourcesStopped: () => {
        calls.push("lifecycle.providerSourcesStopped");
      },
      shutdown: async () => {
        calls.push("lifecycle.shutdown");
        await rootObservationTail;
        return {
          databaseClosePermitted: true as const,
          timedOutRunIds: [] as const,
        };
      },
    },
  };
  return {
    calls,
    parts,
    setRecursiveSessionsEnabled(value: boolean) {
      recursiveSessionsEnabled = value;
    },
  };
}

describe("HarnessProductionCompositionV2", () => {
  test("exposes the router resolver early, drops hints, and fails effect proxies closed", async () => {
    const composition = createHarnessProductionCompositionV2();
    expect(composition.dynamicToolCapabilityResolver).toBeFunction();
    expect(() => composition.observeActorLifecycle(lifecycleEvent)).not.toThrow();
    expect(() => composition.rootChat.observe(lifecycleEvent))
      .toThrow(HarnessProductionCompositionV2Error);
    expect(() => composition.expireDynamicToolRequest("acct", expiredFault))
      .toThrow(HarnessProductionCompositionV2Error);
    expect(await rejected(composition.rootChat.admit(rootAdmissionInput)))
      .toMatchObject({
      code: "invalid_state",
    });
  });

  test("binds one complete graph and gates root admission by current settings", async () => {
    const composition = createHarnessProductionCompositionV2();
    const value = fixture({ recursiveSessionsEnabled: false });
    composition.bind(value.parts);
    expect(composition.harnessFactConsumer).toBe(
      value.parts.harnessFactConsumer,
    );
    expect(() => composition.bind(value.parts)).toThrow(
      HarnessProductionCompositionV2Error,
    );

    expect(await composition.rootChat.admit(rootAdmissionInput)).toBeNull();
    expect(value.calls).not.toContain("root.admit");
    value.setRecursiveSessionsEnabled(true);
    expect(await composition.rootChat.admit(rootAdmissionInput)).toBeNull();
    expect(value.calls).toEqual([]);
    await composition.initialize();
    expect(await composition.rootChat.admit(rootAdmissionInput)).toBe(rootAdmission);
    await composition.rendererCommands.refresh();
    composition.closeAdmissions();
    composition.closeAdmissions();
    expect(await composition.rootChat.admit(rootAdmissionInput)).toBeNull();
    expect(value.calls).toEqual([
      "capabilities.settingsChanged:true",
      "lifecycle.initialize",
      "root.admit",
      "renderer.refresh",
      "capabilities.close",
      "lifecycle.closeAdmissions",
    ]);
  });

  test("holds provider admission until durable boot settings converge", async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const convergence = new Promise<void>((resolve) => {
      release = resolve;
    });
    const composition = createHarnessProductionCompositionV2();
    const value = fixture({
      recursiveSessionsEnabled: true,
      reconcileCapabilities: () => {
        markStarted();
        return convergence;
      },
    });
    composition.bind(value.parts);

    const initializing = composition.initialize();
    await started;
    expect(value.calls).toEqual([
      "capabilities.settingsChanged:true",
    ]);
    expect(await composition.rootChat.admit(rootAdmissionInput)).toBeNull();
    expect(await composition.handleDynamicToolRequest(
      lifecycleEvent.accountProfileId,
      dynamicRequest(),
    )).toEqual({ delivery: "responded" });

    release();
    await initializing;
    expect(value.calls).toEqual([
      "capabilities.settingsChanged:true",
      "dynamic.handle",
      "lifecycle.initialize",
    ]);
    expect(await composition.rootChat.admit(rootAdmissionInput)).toBe(rootAdmission);
  });

  test("advertises durable capability before account startup", async () => {
    const composition = createHarnessProductionCompositionV2({
      hashBinary: () => Promise.resolve("a".repeat(64)),
      now: () => capabilityNow,
      probe: { run: (input) => Promise.resolve(capabilityReceipt(input)) },
      readVersion: () => Promise.resolve("0.144.6"),
    });
    const value = fixture({ recursiveSessionsEnabled: true });
    composition.bind(value.parts);

    expect((await composition.dynamicToolCapabilityResolver({
      accountProfileId: lifecycleEvent.accountProfileId,
      generation: 7,
      paths: capabilityPaths,
    }))?.caller).toEqual({
      accountProfileId: lifecycleEvent.accountProfileId,
      accountGeneration: 7,
    });
    expect(value.calls).toEqual([]);
  });

  test("opens recovered callbacks during lifecycle while new work stays closed", async () => {
    let releaseLifecycle!: () => void;
    let lifecycleStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      lifecycleStarted = resolve;
    });
    const lifecycle = new Promise<Readonly<{
      rendererInitialized: boolean;
      rendererRefreshedByProjection: boolean;
    }>>((resolve) => {
      releaseLifecycle = () => resolve({
        rendererInitialized: false,
        rendererRefreshedByProjection: true,
      });
    });
    const composition = createHarnessProductionCompositionV2();
    const value = fixture({
      initializeLifecycle: () => {
        lifecycleStarted();
        return lifecycle;
      },
    });
    composition.bind(value.parts);

    const initializing = composition.initialize();
    await started;
    expect(value.calls).toEqual([
      "capabilities.settingsChanged:true",
      "lifecycle.initialize",
    ]);
    expect(await composition.handleDynamicToolRequest(
      lifecycleEvent.accountProfileId,
      dynamicRequest(),
    )).toEqual({ delivery: "responded" });
    expect(await composition.rootChat.admit(rootAdmissionInput)).toBeNull();
    expect(await rejected(composition.rendererCommands.execute(
      settingsUpdate(false),
    ))).toMatchObject({ code: "not_ready" });
    composition.observeActorLifecycle(lifecycleEvent);
    expect(value.calls.slice(2)).toEqual([
      "dynamic.handle",
      "liveness.observe",
      "capabilities.observe",
    ]);

    releaseLifecycle();
    await initializing;
    expect(await composition.rootChat.admit(rootAdmissionInput)).toBe(rootAdmission);
  });

  test("reconciles each successful settings CAS before restoring admission", async () => {
    const composition = createHarnessProductionCompositionV2();
    const value = fixture();
    composition.bind(value.parts);
    await composition.initialize();
    value.calls.length = 0;

    expect(await composition.rendererCommands.execute(
      settingsUpdate(false),
    )).toMatchObject({
      type: "harnessSettings",
      settings: { recursiveSessionsEnabled: false },
    });
    expect(value.calls).toEqual([
      "renderer.execute",
      "capabilities.settingsChanged:false",
    ]);
    expect(await composition.rootChat.admit(rootAdmissionInput)).toBeNull();

    value.calls.length = 0;
    expect(await composition.rendererCommands.execute(
      settingsUpdate(true, 2),
    )).toMatchObject({
      type: "harnessSettings",
      settings: { recursiveSessionsEnabled: true },
    });
    expect(value.calls).toEqual([
      "renderer.execute",
      "capabilities.settingsChanged:true",
    ]);
    expect(await composition.rootChat.admit(rootAdmissionInput)).toBe(rootAdmission);
  });

  test("keeps provider response routing live while settings converge", async () => {
    let releaseDisabled!: () => void;
    let markDisabledStarted!: () => void;
    const disabledStarted = new Promise<void>((resolve) => {
      markDisabledStarted = resolve;
    });
    const disabledConvergence = new Promise<void>((resolve) => {
      releaseDisabled = resolve;
    });
    const composition = createHarnessProductionCompositionV2();
    const value = fixture({
      reconcileCapabilities: (enabled) => {
        if (enabled) return Promise.resolve();
        markDisabledStarted();
        return disabledConvergence;
      },
    });
    composition.bind(value.parts);
    await composition.initialize();
    value.calls.length = 0;

    const updating = composition.rendererCommands.execute(
      settingsUpdate(false),
    );
    await disabledStarted;
    expect(value.calls).toEqual([
      "renderer.execute",
      "capabilities.settingsChanged:false",
    ]);
    expect(await composition.handleDynamicToolRequest(
      lifecycleEvent.accountProfileId,
      dynamicRequest(),
    )).toEqual({ delivery: "responded" });
    expect(await composition.rootChat.admit(rootAdmissionInput)).toBeNull();

    releaseDisabled();
    await updating;
    expect(value.calls).toEqual([
      "renderer.execute",
      "capabilities.settingsChanged:false",
      "dynamic.handle",
    ]);
  });

  test("runs no provider effect when the settings CAS is rejected", async () => {
    const failure = new Error("injected settings CAS conflict");
    const composition = createHarnessProductionCompositionV2();
    const value = fixture({ rendererExecuteFailure: failure });
    composition.bind(value.parts);
    await composition.initialize();
    value.calls.length = 0;

    expect(await rejected(composition.rendererCommands.execute(
      settingsUpdate(false),
    ))).toBe(failure);
    expect(value.calls).toEqual(["renderer.execute"]);
    expect(await composition.handleDynamicToolRequest(
      lifecycleEvent.accountProfileId,
      dynamicRequest(),
    )).toEqual({ delivery: "responded" });
  });

  test("fails admission closed after a committed setting cannot reconcile", async () => {
    const failure = new Error("injected capability reconciliation failure");
    let rejectDisabled = true;
    const composition = createHarnessProductionCompositionV2();
    const value = fixture({
      reconcileCapabilities: (enabled) =>
        !enabled && rejectDisabled
          ? Promise.reject(failure)
          : Promise.resolve(),
    });
    composition.bind(value.parts);
    await composition.initialize();
    value.calls.length = 0;

    expect(await rejected(composition.rendererCommands.execute(
      settingsUpdate(false),
    ))).toBe(failure);
    expect(value.calls).toEqual([
      "renderer.execute",
      "capabilities.settingsChanged:false",
    ]);
    expect(await composition.handleDynamicToolRequest(
      lifecycleEvent.accountProfileId,
      dynamicRequest(),
    )).toEqual({ delivery: "responded" });

    rejectDisabled = false;
    await composition.rendererCommands.execute(settingsUpdate(true, 2));
    expect(await composition.handleDynamicToolRequest(
      lifecycleEvent.accountProfileId,
      dynamicRequest(),
    )).toEqual({ delivery: "responded" });
  });

  test("probes no provider capability before boot or while recursive sessions are off", async () => {
    let probeCalls = 0;
    const composition = createHarnessProductionCompositionV2({
      hashBinary: () => Promise.resolve("a".repeat(64)),
      now: () => Date.parse("2026-08-06T12:00:00.000Z"),
      probe: {
        run: () => {
          probeCalls += 1;
          return Promise.reject(new Error("fixture probe stops after gating"));
        },
      },
      readVersion: () => Promise.resolve("0.144.6"),
    });
    const resolve = () => composition.dynamicToolCapabilityResolver({
      accountProfileId: "acct_composition_v2",
      generation: 1,
      paths: capabilityPaths,
    });

    expect(await resolve()).toBeNull();
    const value = fixture({ recursiveSessionsEnabled: false });
    composition.bind(value.parts);
    expect(await resolve()).toBeNull();
    await composition.initialize();
    expect(await resolve()).toBeNull();
    expect(probeCalls).toBe(0);

    value.setRecursiveSessionsEnabled(true);
    expect(await resolve()).toBeNull();
    expect(probeCalls).toBe(1);
    await composition.preProviderStop();
    composition.providerSourcesStopped();
    await composition.shutdown();
    expect(await resolve()).toBeNull();
    expect(probeCalls).toBe(1);
  });

  test("routes dynamic requests only through their exact account callback", async () => {
    const composition = createHarnessProductionCompositionV2();
    const value = fixture();
    composition.bind(value.parts);
    const request = dynamicRequest();

    expect(await rejected(composition.handleDynamicToolRequest(
      "acct_other",
      request,
    ))).toMatchObject({ code: "account_mismatch" });
    expect(await composition.handleDynamicToolRequest(
      lifecycleEvent.accountProfileId,
      request,
    )).toEqual({ delivery: "responded" });
    expect(value.calls).toEqual(["dynamic.handle"]);
    await composition.initialize();
    expect(await composition.handleDynamicToolRequest(
      lifecycleEvent.accountProfileId,
      request,
    )).toEqual({ delivery: "responded" });
    expect(composition.expireDynamicToolRequest(
      lifecycleEvent.accountProfileId,
      expiredFault,
    )).toBe(2);
    composition.closeAdmissions();
    expect(await composition.handleDynamicToolRequest(
      lifecycleEvent.accountProfileId,
      request,
    )).toEqual({ delivery: "responded" });
    expect(value.calls).toEqual([
      "dynamic.handle",
      "capabilities.settingsChanged:true",
      "lifecycle.initialize",
      "dynamic.handle",
      "dynamic.expire",
      "capabilities.close",
      "lifecycle.closeAdmissions",
      "dynamic.handle",
    ]);
  });

  test("keeps chat-owned root settlement separate from nested-actor liveness", async () => {
    const composition = createHarnessProductionCompositionV2();
    const value = fixture();
    composition.bind(value.parts);

    composition.observeActorLifecycle(lifecycleEvent);
    expect(value.calls).toEqual([
      "liveness.observe",
      "capabilities.observe",
    ]);
    await composition.rootChat.observe(lifecycleEvent);
    expect(value.calls).toEqual([
      "liveness.observe",
      "capabilities.observe",
      "roots.observe",
    ]);
    await composition.settled();
    expect(value.calls).toEqual([
      "liveness.observe",
      "capabilities.observe",
      "roots.observe",
      "dynamic.settled",
      "roots.settled",
      "liveness.settled",
      "capabilities.settled",
    ]);
    await composition.initialize();
    await composition.preProviderStop();
    expect(value.calls.slice(7)).toEqual([
      "capabilities.settingsChanged:true",
      "lifecycle.initialize",
      "capabilities.close",
      "lifecycle.closeAdmissions",
      "capabilities.settled",
      "chat.settled",
      "lifecycle.preProviderStop",
    ]);
    composition.providerSourcesStopped();
    composition.providerSourcesStopped();
    const first = composition.shutdown();
    const concurrent = composition.shutdown();
    expect(concurrent).toBe(first);
    await first;
    expect(value.calls.slice(7)).toEqual([
      "capabilities.settingsChanged:true",
      "lifecycle.initialize",
      "capabilities.close",
      "lifecycle.closeAdmissions",
      "capabilities.settled",
      "chat.settled",
      "lifecycle.preProviderStop",
      "lifecycle.providerSourcesStopped",
      "lifecycle.shutdown",
      "chat.settled",
      "capabilities.settled",
    ]);
  });

  test("chat can enqueue a root observation before immediate shutdown closes admission", async () => {
    let resolveObservation!: () => void;
    const observation = new Promise<void>((resolve) => {
      resolveObservation = resolve;
    });
    const composition = createHarnessProductionCompositionV2();
    const value = fixture({ rootObservation: () => observation });
    composition.bind(value.parts);

    const observing = composition.rootChat.observe(lifecycleEvent);
    const preparing = composition.preProviderStop();
    expect(value.calls).toEqual([
      "roots.observe",
      "capabilities.close",
      "lifecycle.closeAdmissions",
      "capabilities.settled",
      "chat.settled",
    ]);
    expect(await rejected(composition.shutdown())).toMatchObject({
      code: "invalid_state",
    });
    expect(value.calls).toEqual([
      "roots.observe",
      "capabilities.close",
      "lifecycle.closeAdmissions",
      "capabilities.settled",
      "chat.settled",
    ]);
    await preparing;
    composition.providerSourcesStopped();
    const stopping = composition.shutdown();
    expect(value.calls).toEqual([
      "roots.observe",
      "capabilities.close",
      "lifecycle.closeAdmissions",
      "capabilities.settled",
      "chat.settled",
      "lifecycle.preProviderStop",
      "lifecycle.providerSourcesStopped",
      "lifecycle.shutdown",
      "chat.settled",
      "capabilities.settled",
    ]);
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBeFalse();
    resolveObservation();
    await observing;
    await stopping;
  });

  test("rejects provider-source termination before the producer barrier", async () => {
    const composition = createHarnessProductionCompositionV2();
    const value = fixture();
    composition.bind(value.parts);

    expect(() => composition.providerSourcesStopped()).toThrow(
      HarnessProductionCompositionV2Error,
    );
    expect(value.calls).toEqual([]);
    await composition.preProviderStop();
    expect(() => composition.providerSourcesStopped()).not.toThrow();
  });

  test("keeps provider sources live while the cached pre-stop barrier is blocked", async () => {
    const barrier = deferred<Readonly<{
      providerStopPermitted: true;
      timedOutRunIds: readonly [];
    }>>();
    const composition = createHarnessProductionCompositionV2();
    const value = fixture({ preProviderStop: () => barrier.promise });
    composition.bind(value.parts);

    const first = composition.preProviderStop();
    expect(composition.preProviderStop()).toBe(first);
    expect(() => composition.providerSourcesStopped()).toThrow();
    expect(await composition.rootChat.observe(lifecycleEvent)).toBeUndefined();
    expect(value.calls).toContain("roots.observe");
    barrier.resolve({ providerStopPermitted: true, timedOutRunIds: [] });
    expect(await first).toEqual({
      providerStopPermitted: true,
      timedOutRunIds: [],
    });
    const callsBeforeLateTerminalHint = [...value.calls];
    expect(() => composition.observeActorLifecycle(lifecycleEvent)).not.toThrow();
    expect(value.calls).toEqual(callsBeforeLateTerminalHint);
    expect(() => composition.providerSourcesStopped()).not.toThrow();
  });

  test("joins an accepted chat effect before entering lifecycle quiescence", async () => {
    const chatTail = deferred<void>();
    const composition = createHarnessProductionCompositionV2();
    const value = fixture({ chatSettled: () => chatTail.promise });
    composition.bind(value.parts);

    const preparing = composition.preProviderStop();
    await Promise.resolve();
    expect(value.calls).toEqual([
      "capabilities.close",
      "lifecycle.closeAdmissions",
      "capabilities.settled",
      "chat.settled",
    ]);
    expect(value.calls).not.toContain("lifecycle.preProviderStop");
    expect(() => composition.providerSourcesStopped()).toThrow();
    chatTail.resolve();

    await preparing;
    expect(value.calls.at(-1)).toBe("lifecycle.preProviderStop");
    expect(() => composition.providerSourcesStopped()).not.toThrow();
  });

  test("times out a blocked chat effect and never grants provider stop", async () => {
    const composition = createHarnessProductionCompositionV2({}, 17);
    const value = fixture({
      chatSettled: () => new Promise<never>(() => undefined),
    });
    composition.bind(value.parts);

    const preparing = composition.preProviderStop();
    expect(await rejected(preparing)).toMatchObject({ code: "invalid_state" });
    expect(composition.preProviderStop()).toBe(preparing);
    expect(value.calls).toContain("lifecycle.preProviderStop");
    expect(() => composition.providerSourcesStopped()).toThrow();
  });

  test("closes a root admission that was awaiting its settings read", async () => {
    const settings = deferred<Readonly<{
      recursiveSessionsEnabled: boolean;
    }>>();
    let blockSettingsRead = false;
    const composition = createHarnessProductionCompositionV2();
    const value = fixture({
      readSettings: () => blockSettingsRead
        ? settings.promise
        : Promise.resolve({ recursiveSessionsEnabled: true }),
    });
    composition.bind(value.parts);
    await composition.initialize();

    blockSettingsRead = true;
    const admitting = composition.rootChat.admit(rootAdmissionInput);
    await Promise.resolve();
    const preparing = composition.preProviderStop();
    settings.resolve({ recursiveSessionsEnabled: true });

    expect(await admitting).toBeNull();
    await preparing;
    expect(value.calls).not.toContain("root.admit");
  });

  test("propagates chat-owned root observation failures", async () => {
    const failure = new Error("root observation failed");
    const composition = createHarnessProductionCompositionV2();
    const value = fixture({
      rootObservation: () => Promise.reject(failure),
    });
    composition.bind(value.parts);
    expect(await rejected(composition.rootChat.observe(lifecycleEvent)))
      .toBe(failure);
  });
});

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
}> {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((accept) => {
      resolve = accept;
    }),
    resolve,
  };
}

async function rejected<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected promise to reject");
}
