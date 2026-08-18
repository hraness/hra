import { describe, expect, test } from "bun:test";

import {
  HarnessProductionLifecycleKernelV2,
  type HarnessProductionLifecycleKernelV2Options,
} from "../src/harness/production-lifecycle-kernel-v2";

interface Fixture {
  readonly calls: string[];
  readonly kernel: HarnessProductionLifecycleKernelV2;
}

function fixture(input: Readonly<{
  rendererRefresh?: "included" | "excluded";
  contextRecovery?: () => Promise<unknown>;
  proposalRecovery?: () => Promise<unknown>;
  rootRecovery?: () => Promise<unknown>;
  chatRecovery?: () => Promise<unknown>;
  actorSessionRecovery?: () => Promise<Readonly<{
    recoveredIncarnationIds: string[];
    quarantinedIncarnationIds: string[];
    deferredIncarnationIds: string[];
  }>>;
  actorSessionClose?: () => Promise<void>;
  livenessActivation?: () => Promise<unknown>;
  actorSessionAdmissionReconcile?: () => Promise<unknown>;
  actorReconcile?: () => Promise<unknown>;
  programAdmissionRecovery?: () => Promise<unknown>;
  rlmQuiesce?: (timeoutMs: number) => Promise<unknown>;
  rootCloseAdmission?: () => void;
  rootCloseObservation?: () => void;
  rootSettled?: () => Promise<void>;
  dynamicOpenAdmission?: () => void;
  dynamicSettled?: () => Promise<unknown>;
  shadowAnalyzerStart?: () => void;
  shadowAnalyzerClose?: () => void;
  shadowAnalyzerSettled?: () => Promise<void>;
  recordShadowAnalyzerCalls?: boolean;
  livenessClose?: () => Promise<void>;
  keyCustodyQuiesce?: () => Promise<void>;
}> = {}): Fixture {
  const calls: string[] = [];
  const options: HarnessProductionLifecycleKernelV2Options = {
    contexts: {
      recover: async () => {
        calls.push("context.recover");
        return await input.contextRecovery?.();
      },
    },
    proposals: {
      recover: async () => {
        calls.push("proposals.recover");
        return await input.proposalRecovery?.();
      },
    },
    chat: {
      recoverInterruptedAfterRootRecovery: async () => {
        calls.push("chat.recoverInterruptedAfterRootRecovery");
        return await input.chatRecovery?.();
      },
      activateLiveness: async () => {
        calls.push("chat.activateLiveness");
        return await input.livenessActivation?.();
      },
    },
    actorSessions: {
      recoverActorSessions: async () => {
        calls.push("actorSessions.recoverActorSessions");
        return await input.actorSessionRecovery?.() ?? {
          recoveredIncarnationIds: [],
          quarantinedIncarnationIds: [],
          deferredIncarnationIds: [],
        };
      },
      close: async () => {
        calls.push("actorSessions.close");
        await input.actorSessionClose?.();
      },
    },
    actors: {
      reconcileSessionAdmissions: async () => {
        calls.push("actors.reconcileSessionAdmissions");
        return await input.actorSessionAdmissionReconcile?.();
      },
      reconcile: async () => {
        calls.push("actors.reconcile");
        return await input.actorReconcile?.();
      },
    },
    programAdmissions: {
      recover: async () => {
        calls.push("programAdmissions.recover");
        return await input.programAdmissionRecovery?.();
      },
    },
    rlm: {
      reconcileOnBoot: () => {
        calls.push("rlm.reconcileOnBoot");
        return Promise.resolve();
      },
      quiesce: (timeoutMs) => {
        calls.push(`rlm.quiesce:${String(timeoutMs)}`);
        return input.rlmQuiesce?.(timeoutMs) ?? Promise.resolve({
          requestedRunIds: [],
          settledRunIds: [],
          timedOutRunIds: [],
        });
      },
    },
    projections: {
      rendererRefresh: input.rendererRefresh ?? "included",
      reconcileAll: () => {
        calls.push("projections.reconcileAllAndRefresh");
        return Promise.resolve([]);
      },
      settled: () => {
        calls.push("projections.settled");
        return Promise.resolve();
      },
    },
    renderer: {
      initialize: () => {
        calls.push("renderer.initialize");
        return Promise.resolve();
      },
      settled: () => {
        calls.push("renderer.settled");
        return Promise.resolve();
      },
    },
    dynamicTools: {
      openAdmissionAfterRecovery: () => {
        calls.push("dynamicTools.openAdmissionAfterRecovery");
        input.dynamicOpenAdmission?.();
      },
      closeAdmission: () => {
        calls.push("dynamicTools.closeAdmission");
      },
      settled: () => {
        calls.push("dynamicTools.settled");
        return input.dynamicSettled?.() ?? Promise.resolve();
      },
    },
    rootSessions: {
      reconcileOnBoot: () => {
        calls.push("rootSessions.reconcileOnBoot");
        return input.rootRecovery?.() ?? Promise.resolve([]);
      },
      closeAdmission: () => {
        calls.push("rootSessions.closeAdmission");
        input.rootCloseAdmission?.();
      },
      closeObservation: () => {
        calls.push("rootSessions.closeObservation");
        input.rootCloseObservation?.();
      },
      settled: () => {
        calls.push("rootSessions.settled");
        return input.rootSettled?.() ?? Promise.resolve();
      },
    },
    shadowRoutingAnalyzer: {
      startAfterRecovery: () => {
        if (input.recordShadowAnalyzerCalls === true) {
          calls.push("shadowRoutingAnalyzer.startAfterRecovery");
        }
        input.shadowAnalyzerStart?.();
      },
      closeAdmission: () => {
        if (input.recordShadowAnalyzerCalls === true) {
          calls.push("shadowRoutingAnalyzer.closeAdmission");
        }
        input.shadowAnalyzerClose?.();
      },
      settled: () => {
        if (input.recordShadowAnalyzerCalls === true) {
          calls.push("shadowRoutingAnalyzer.settled");
        }
        return input.shadowAnalyzerSettled?.() ?? Promise.resolve();
      },
    },
    liveness: {
      close: () => {
        calls.push("liveness.close");
        return input.livenessClose?.() ?? Promise.resolve();
      },
    },
    keyCustody: {
      quiesceForExternalDeletion: () => {
        calls.push("keyCustody.quiesceForExternalDeletion");
        return input.keyCustodyQuiesce?.() ?? Promise.resolve();
      },
    },
    rlmQuiesceTimeoutMs: 17,
  };
  return { calls, kernel: new HarnessProductionLifecycleKernelV2(options) };
}

describe("HarnessProductionLifecycleKernelV2", () => {
  test("initializes exactly once in dependency order without a duplicate refresh", async () => {
    const value = fixture({ rendererRefresh: "included" });
    const first = value.kernel.initialize();
    const concurrent = value.kernel.initialize();
    expect(concurrent).toBe(first);
    expect(await first).toEqual({
      rendererInitialized: false,
      rendererRefreshedByProjection: true,
    });
    expect(value.kernel.state).toBe("ready");
    expect(value.calls).toEqual([
      "context.recover",
      "proposals.recover",
      "rootSessions.reconcileOnBoot",
      "chat.recoverInterruptedAfterRootRecovery",
      "actors.reconcileSessionAdmissions",
      "actorSessions.recoverActorSessions",
      "actors.reconcile",
      "chat.activateLiveness",
      "programAdmissions.recover",
      "rlm.reconcileOnBoot",
      "projections.reconcileAllAndRefresh",
      "dynamicTools.openAdmissionAfterRecovery",
    ]);
    expect(value.calls.filter(
      (call) => call === "dynamicTools.openAdmissionAfterRecovery",
    )).toHaveLength(1);

    value.kernel.closeAdmissions();
    expect(value.calls.slice(12)).toEqual([
      "rootSessions.closeAdmission",
      "dynamicTools.closeAdmission",
    ]);
    expect(value.calls).not.toContain("rootSessions.closeObservation");
    expect(value.calls).not.toContain("liveness.close");
    expect(await rejected(value.kernel.shutdown())).toMatchObject({
      code: "invalid_state",
    });
    expect(value.calls.slice(12)).toEqual([
      "rootSessions.closeAdmission",
      "dynamicTools.closeAdmission",
    ]);
    const preparing = value.kernel.preProviderStop();
    expect(value.kernel.preProviderStop()).toBe(preparing);
    expect(await preparing).toEqual({
      providerStopPermitted: true,
      timedOutRunIds: [],
    });
    expect(value.calls).not.toContain("rootSessions.closeObservation");
    value.kernel.providerSourcesStopped();
    const stopping = value.kernel.shutdown();
    const concurrentStop = value.kernel.shutdown();
    expect(concurrentStop).toBe(stopping);
    expect(await stopping).toEqual({
      databaseClosePermitted: true,
      timedOutRunIds: [],
    });
    expect(value.kernel.databaseClosePermitted).toBeTrue();
    expect(value.kernel.state).toBe("stopped");
    expect(value.calls.slice(12)).toEqual([
      "rootSessions.closeAdmission",
      "dynamicTools.closeAdmission",
      "actorSessions.close",
      "rootSessions.settled",
      "dynamicTools.settled",
      "liveness.close",
      "rlm.quiesce:17",
      "rootSessions.closeObservation",
      "rootSessions.settled",
      "dynamicTools.settled",
      "projections.settled",
      "renderer.settled",
      "keyCustody.quiesceForExternalDeletion",
    ]);
    expect(value.calls.filter(
      (call) => call === "dynamicTools.openAdmissionAfterRecovery",
    )).toHaveLength(1);
  });

  test("initializes the renderer once only when projection refresh is excluded", async () => {
    const value = fixture({ rendererRefresh: "excluded" });
    expect(await value.kernel.initialize()).toEqual({
      rendererInitialized: true,
      rendererRefreshedByProjection: false,
    });
    expect(value.calls).toEqual([
      "context.recover",
      "proposals.recover",
      "rootSessions.reconcileOnBoot",
      "chat.recoverInterruptedAfterRootRecovery",
      "actors.reconcileSessionAdmissions",
      "actorSessions.recoverActorSessions",
      "actors.reconcile",
      "chat.activateLiveness",
      "programAdmissions.recover",
      "rlm.reconcileOnBoot",
      "projections.reconcileAllAndRefresh",
      "renderer.initialize",
      "dynamicTools.openAdmissionAfterRecovery",
    ]);
    await value.kernel.preProviderStop();
    value.kernel.providerSourcesStopped();
    await value.kernel.shutdown();
  });

  test("fails before chat cleanup when durable root recovery cannot prove lineage", async () => {
    const failure = new Error("root lineage is partial");
    const value = fixture({
      rootRecovery: () => Promise.reject(failure),
    });
    expect(await rejected(value.kernel.initialize())).toMatchObject({
      code: "initialization_failed",
      cause: failure,
    });
    expect(value.calls).toEqual([
      "context.recover",
      "proposals.recover",
      "rootSessions.reconcileOnBoot",
      "rootSessions.closeAdmission",
      "dynamicTools.closeAdmission",
    ]);
    expect(value.calls).not.toContain("chat.recoverInterruptedAfterRootRecovery");
    await value.kernel.preProviderStop();
    value.kernel.providerSourcesStopped();
    await value.kernel.shutdown();
  });

  test("makes partial initialization failure terminal and still drains every service", async () => {
    const failure = new Error("actor recovery failed");
    const value = fixture({
      actorReconcile: () => Promise.reject(failure),
    });
    const first = value.kernel.initialize();
    expect(await rejected(first)).toMatchObject({
      code: "initialization_failed",
      cause: failure,
    });
    expect(value.kernel.state).toBe("initializationFailed");
    expect(value.kernel.initialize()).toBe(first);
    expect(value.calls).toEqual([
      "context.recover",
      "proposals.recover",
      "rootSessions.reconcileOnBoot",
      "chat.recoverInterruptedAfterRootRecovery",
      "actors.reconcileSessionAdmissions",
      "actorSessions.recoverActorSessions",
      "actors.reconcile",
      "rootSessions.closeAdmission",
      "dynamicTools.closeAdmission",
    ]);

    await value.kernel.preProviderStop();
    value.kernel.providerSourcesStopped();
    await value.kernel.shutdown();
    expect(value.calls.slice(9)).toEqual([
      "actorSessions.close",
      "rootSessions.settled",
      "dynamicTools.settled",
      "liveness.close",
      "rlm.quiesce:17",
      "rootSessions.closeObservation",
      "rootSessions.settled",
      "dynamicTools.settled",
      "projections.settled",
      "renderer.settled",
      "keyCustody.quiesceForExternalDeletion",
    ]);
    expect(value.kernel.databaseClosePermitted).toBeTrue();
  });

  test("restores generation-local actor sessions before actor reconciliation", async () => {
    const failure = new Error("actor session history is unstable");
    const value = fixture({
      actorSessionRecovery: () => Promise.reject(failure),
    });
    expect(await rejected(value.kernel.initialize())).toMatchObject({
      code: "initialization_failed",
      cause: failure,
    });
    expect(value.calls).toEqual([
      "context.recover",
      "proposals.recover",
      "rootSessions.reconcileOnBoot",
      "chat.recoverInterruptedAfterRootRecovery",
      "actors.reconcileSessionAdmissions",
      "actorSessions.recoverActorSessions",
      "rootSessions.closeAdmission",
      "dynamicTools.closeAdmission",
    ]);
    expect(value.calls).not.toContain("actors.reconcile");
    expect(value.calls).not.toContain("chat.activateLiveness");
    await value.kernel.preProviderStop();
    value.kernel.providerSourcesStopped();
    await value.kernel.shutdown();
  });

  test("a stalled binding still admits the coordinator's readiness-filtered boot pass", async () => {
    const value = fixture({
      actorSessionRecovery: () => Promise.resolve({
        recoveredIncarnationIds: ["hincarnation_healthy"],
        quarantinedIncarnationIds: [],
        deferredIncarnationIds: ["hincarnation_stalled"],
      }),
      actorReconcile: () => Promise.resolve({
        inspectedOperations: 0,
        inspectedAttempts: 1,
        inspectedTurns: 1,
        pending: 1,
        fenced: 0,
      }),
    });

    expect(await value.kernel.initialize()).toEqual({
      rendererInitialized: false,
      rendererRefreshedByProjection: true,
    });
    expect(value.kernel.state).toBe("ready");
    expect(value.calls).toContain("actors.reconcile");
    expect(value.calls).toContain("chat.activateLiveness");
    expect(value.calls).toContain("programAdmissions.recover");
    expect(value.calls).toContain("dynamicTools.openAdmissionAfterRecovery");

    await value.kernel.preProviderStop();
    value.kernel.providerSourcesStopped();
    await value.kernel.shutdown();
  });

  test("materializes recoverable actor admissions before session recovery", async () => {
    const failure = new Error("actor admission response is still uncertain");
    const value = fixture({
      actorSessionAdmissionReconcile: () => Promise.reject(failure),
    });
    expect(await rejected(value.kernel.initialize())).toMatchObject({
      code: "initialization_failed",
      cause: failure,
    });
    expect(value.calls).toEqual([
      "context.recover",
      "proposals.recover",
      "rootSessions.reconcileOnBoot",
      "chat.recoverInterruptedAfterRootRecovery",
      "actors.reconcileSessionAdmissions",
      "rootSessions.closeAdmission",
      "dynamicTools.closeAdmission",
    ]);
    expect(value.calls).not.toContain("actorSessions.recoverActorSessions");
    expect(value.calls).not.toContain("actors.reconcile");
    await value.kernel.preProviderStop();
    value.kernel.providerSourcesStopped();
    await value.kernel.shutdown();
  });

  test("never starts program recovery when post-actor liveness activation fails", async () => {
    const failure = new Error("liveness timer unavailable");
    const value = fixture({
      livenessActivation: () => Promise.reject(failure),
    });
    expect(await rejected(value.kernel.initialize())).toMatchObject({
      code: "initialization_failed",
      cause: failure,
    });
    expect(value.calls).toEqual([
      "context.recover",
      "proposals.recover",
      "rootSessions.reconcileOnBoot",
      "chat.recoverInterruptedAfterRootRecovery",
      "actors.reconcileSessionAdmissions",
      "actorSessions.recoverActorSessions",
      "actors.reconcile",
      "chat.activateLiveness",
      "rootSessions.closeAdmission",
      "dynamicTools.closeAdmission",
    ]);
    expect(value.calls).not.toContain("programAdmissions.recover");
    await value.kernel.preProviderStop();
    value.kernel.providerSourcesStopped();
    await value.kernel.shutdown();
  });

  test("recovers program admission intents before any RLM replay", async () => {
    const failure = new Error("program admission evidence is ambiguous");
    const value = fixture({
      programAdmissionRecovery: () => Promise.reject(failure),
    });
    expect(await rejected(value.kernel.initialize())).toMatchObject({
      code: "initialization_failed",
      cause: failure,
    });
    expect(value.calls).toEqual([
      "context.recover",
      "proposals.recover",
      "rootSessions.reconcileOnBoot",
      "chat.recoverInterruptedAfterRootRecovery",
      "actors.reconcileSessionAdmissions",
      "actorSessions.recoverActorSessions",
      "actors.reconcile",
      "chat.activateLiveness",
      "programAdmissions.recover",
      "rootSessions.closeAdmission",
      "dynamicTools.closeAdmission",
    ]);
    expect(value.calls).not.toContain("rlm.reconcileOnBoot");
    await value.kernel.preProviderStop();
    value.kernel.providerSourcesStopped();
    await value.kernel.shutdown();
  });

  test("recovers proposals before root recovery can settle their source turns", async () => {
    const failure = new Error("proposal body custody is temporarily unavailable");
    const value = fixture({
      proposalRecovery: () => Promise.reject(failure),
    });
    expect(await rejected(value.kernel.initialize())).toMatchObject({
      code: "initialization_failed",
      cause: failure,
    });
    expect(value.calls).toEqual([
      "context.recover",
      "proposals.recover",
      "rootSessions.closeAdmission",
      "dynamicTools.closeAdmission",
    ]);
    expect(value.calls).not.toContain("rootSessions.reconcileOnBoot");
    await value.kernel.preProviderStop();
    value.kernel.providerSourcesStopped();
    await value.kernel.shutdown();
  });

  test("never reopens dynamic-tool admission after boot admission closes", async () => {
    const recovery = deferred<void>();
    const value = fixture({ contextRecovery: () => recovery.promise });
    const initialization = value.kernel.initialize();
    value.kernel.closeAdmissions();
    expect(value.calls).toEqual([
      "context.recover",
      "rootSessions.closeAdmission",
      "dynamicTools.closeAdmission",
    ]);

    recovery.resolve();
    expect(await rejected(initialization)).toMatchObject({
      code: "initialization_cancelled",
    });
    expect(value.calls).not.toContain("dynamicTools.openAdmissionAfterRecovery");

    await value.kernel.preProviderStop();
    value.kernel.providerSourcesStopped();
    await value.kernel.shutdown();
  });

  test("rejects provider-source termination until the producer barrier passes", async () => {
    const value = fixture();
    expect(() => value.kernel.providerSourcesStopped()).toThrow();
    expect(value.calls).toEqual([]);
    await value.kernel.preProviderStop();
    expect(() => value.kernel.providerSourcesStopped()).not.toThrow();
  });

  test("shutdown closes admissions before an in-flight initialization can advance", async () => {
    const recovery = deferred<void>();
    const value = fixture({ contextRecovery: () => recovery.promise });
    const initialization = value.kernel.initialize();
    value.kernel.closeAdmissions();
    expect(value.calls).toEqual([
      "context.recover",
      "rootSessions.closeAdmission",
      "dynamicTools.closeAdmission",
    ]);
    expect(value.calls).not.toContain("dynamicTools.openAdmissionAfterRecovery");
    expect(value.calls).not.toContain("rootSessions.closeObservation");
    expect(value.calls).not.toContain("liveness.close");
    const preparing = value.kernel.preProviderStop();
    expect(value.calls).toEqual([
      "context.recover",
      "rootSessions.closeAdmission",
      "dynamicTools.closeAdmission",
      "actorSessions.close",
    ]);
    recovery.resolve();
    expect(await rejected(initialization)).toMatchObject({
      code: "initialization_cancelled",
    });
    await preparing;
    expect(value.calls).toEqual([
      "context.recover",
      "rootSessions.closeAdmission",
      "dynamicTools.closeAdmission",
      "actorSessions.close",
      "rootSessions.settled",
      "dynamicTools.settled",
      "liveness.close",
      "rlm.quiesce:17",
    ]);
    value.kernel.providerSourcesStopped();
    const stopping = value.kernel.shutdown();
    await stopping;
    expect(value.calls).not.toContain("actors.reconcile");
    expect(value.calls).not.toContain("dynamicTools.openAdmissionAfterRecovery");
    expect(value.kernel.databaseClosePermitted).toBeTrue();
  });

  test("a timed-out RLM producer forbids provider stop and leaves observers open", async () => {
    const value = fixture({
      rlmQuiesce: () => Promise.resolve({
        requestedRunIds: ["rlmrun_b", "rlmrun_a"],
        settledRunIds: ["rlmrun_b"],
        timedOutRunIds: ["rlmrun_a"],
      }),
    });
    const preparing = value.kernel.preProviderStop();
    expect(await rejected(preparing)).toMatchObject({
      code: "rlm_quiesce_timeout",
      timedOutRunIds: ["rlmrun_a"],
    });
    expect(value.kernel.preProviderStop()).toBe(preparing);
    expect(() => value.kernel.providerSourcesStopped()).toThrow();
    expect(await rejected(value.kernel.shutdown())).toMatchObject({
      code: "invalid_state",
    });
    expect(value.kernel.databaseClosePermitted).toBeFalse();
    expect(value.kernel.state).toBe("shutdownFailed");
    expect(value.calls).toEqual([
      "rootSessions.closeAdmission",
      "dynamicTools.closeAdmission",
      "actorSessions.close",
      "rootSessions.settled",
      "dynamicTools.settled",
      "liveness.close",
      "rlm.quiesce:17",
    ]);
    expect(value.calls).not.toContain("rootSessions.closeObservation");
  });

  test("bounds a blocked RLM adapter without granting provider-stop authority", async () => {
    const value = fixture({
      rlmQuiesce: () => new Promise<never>(() => undefined),
    });
    const preparing = value.kernel.preProviderStop();
    expect(await rejected(preparing)).toMatchObject({
      code: "shutdown_failed",
    });
    expect(value.kernel.preProviderStop()).toBe(preparing);
    expect(() => value.kernel.providerSourcesStopped()).toThrow();
    expect(value.calls).toEqual([
      "rootSessions.closeAdmission",
      "dynamicTools.closeAdmission",
      "actorSessions.close",
      "rootSessions.settled",
      "dynamicTools.settled",
      "liveness.close",
      "rlm.quiesce:17",
    ]);
    expect(value.calls).not.toContain("rootSessions.closeObservation");
  });

  test("an in-flight actor-session recovery forbids provider stop after its drain deadline", async () => {
    const value = fixture({
      actorSessionClose: () => new Promise<never>(() => undefined),
    });
    const preparing = value.kernel.preProviderStop();
    expect(await rejected(preparing)).toMatchObject({
      code: "shutdown_failed",
    });
    expect(value.kernel.preProviderStop()).toBe(preparing);
    expect(() => value.kernel.providerSourcesStopped()).toThrow();
    expect(await rejected(value.kernel.shutdown())).toMatchObject({
      code: "invalid_state",
    });
    expect(value.kernel.databaseClosePermitted).toBeFalse();
    expect(value.calls).not.toContain("rootSessions.closeObservation");
  });

  test("bounds an armed liveness drain and still checkpoints RLM runs", async () => {
    const value = fixture({
      livenessClose: () => new Promise<never>(() => undefined),
    });
    expect(await rejected(value.kernel.preProviderStop())).toMatchObject({
      code: "shutdown_failed",
    });
    expect(value.calls).toEqual([
      "rootSessions.closeAdmission",
      "dynamicTools.closeAdmission",
      "actorSessions.close",
      "rootSessions.settled",
      "dynamicTools.settled",
      "liveness.close",
      "rlm.quiesce:17",
    ]);
    expect(() => value.kernel.providerSourcesStopped()).toThrow();
    expect(value.calls).not.toContain("rootSessions.closeObservation");
  });

  test("an admission-close failure forbids provider stop and terminal drain", async () => {
    const value = fixture({
      rootCloseAdmission: () => {
        throw new Error("root admission close failed");
      },
    });
    expect(await rejected(value.kernel.preProviderStop())).toMatchObject({
      code: "shutdown_failed",
    });
    expect(value.calls).toEqual([
      "rootSessions.closeAdmission",
      "dynamicTools.closeAdmission",
      "actorSessions.close",
      "rootSessions.settled",
      "dynamicTools.settled",
      "liveness.close",
      "rlm.quiesce:17",
    ]);
    expect(() => value.kernel.providerSourcesStopped()).toThrow();
    expect(value.calls).not.toContain("rootSessions.closeObservation");
    expect(value.kernel.databaseClosePermitted).toBeFalse();
  });

  test("drains an accepted dynamic submit before enumerating RLM runs", async () => {
    const rootAdmission = deferred<void>();
    const dynamicSubmit = deferred<void>();
    const value = fixture({
      rootSettled: () => rootAdmission.promise,
      dynamicSettled: () => dynamicSubmit.promise,
    });

    const preparing = value.kernel.preProviderStop();
    await Promise.resolve();
    expect(value.calls).toEqual([
      "rootSessions.closeAdmission",
      "dynamicTools.closeAdmission",
      "actorSessions.close",
      "rootSessions.settled",
      "dynamicTools.settled",
    ]);
    expect(value.calls).not.toContain("liveness.close");
    expect(value.calls).not.toContain("rlm.quiesce:17");
    dynamicSubmit.resolve();
    await Promise.resolve();
    expect(value.calls).not.toContain("rlm.quiesce:17");
    rootAdmission.resolve();

    await preparing;
    expect(value.calls).toEqual([
      "rootSessions.closeAdmission",
      "dynamicTools.closeAdmission",
      "actorSessions.close",
      "rootSessions.settled",
      "dynamicTools.settled",
      "liveness.close",
      "rlm.quiesce:17",
    ]);
  });

  test("starts shadow analysis after recovery and joins it before provider stop", async () => {
    const value = fixture({ recordShadowAnalyzerCalls: true });

    await value.kernel.initialize();
    expect(value.calls.slice(-2)).toEqual([
      "shadowRoutingAnalyzer.startAfterRecovery",
      "dynamicTools.openAdmissionAfterRecovery",
    ]);

    await value.kernel.preProviderStop();
    const closeIndex = value.calls.indexOf(
      "shadowRoutingAnalyzer.closeAdmission",
    );
    const settledIndex = value.calls.indexOf("shadowRoutingAnalyzer.settled");
    const livenessIndex = value.calls.indexOf("liveness.close");
    const providerBarrierIndex = value.calls.indexOf("rlm.quiesce:17");
    expect(closeIndex).toBeGreaterThan(-1);
    expect(settledIndex).toBeGreaterThan(closeIndex);
    expect(livenessIndex).toBeGreaterThan(settledIndex);
    expect(providerBarrierIndex).toBeGreaterThan(livenessIndex);

    value.kernel.providerSourcesStopped();
    await value.kernel.shutdown();
  });

  test("fails boot closed when shadow analysis cannot start", async () => {
    const failure = new Error("shadow timer unavailable");
    const value = fixture({
      recordShadowAnalyzerCalls: true,
      shadowAnalyzerStart: () => {
        throw failure;
      },
    });

    expect(await rejected(value.kernel.initialize())).toMatchObject({
      code: "initialization_failed",
      cause: failure,
    });
    expect(value.calls.slice(-4)).toEqual([
      "shadowRoutingAnalyzer.startAfterRecovery",
      "rootSessions.closeAdmission",
      "dynamicTools.closeAdmission",
      "shadowRoutingAnalyzer.closeAdmission",
    ]);
    expect(value.calls).not.toContain("dynamicTools.openAdmissionAfterRecovery");

    await value.kernel.preProviderStop();
    value.kernel.providerSourcesStopped();
    await value.kernel.shutdown();
  });

  test("bounds a blocked shadow-analysis join before provider stop", async () => {
    const value = fixture({
      recordShadowAnalyzerCalls: true,
      shadowAnalyzerSettled: () => new Promise<never>(() => undefined),
    });

    expect(await rejected(value.kernel.preProviderStop())).toMatchObject({
      code: "shutdown_failed",
    });
    expect(value.calls).toContain("shadowRoutingAnalyzer.closeAdmission");
    expect(value.calls).toContain("shadowRoutingAnalyzer.settled");
    expect(value.calls).toContain("rlm.quiesce:17");
    expect(() => value.kernel.providerSourcesStopped()).toThrow();
    expect(value.kernel.databaseClosePermitted).toBeFalse();
  });

  test("joins effect producers before provider stop, then drains terminal sources", async () => {
    const root = deferred<void>();
    const dynamic = deferred<void>();
    const liveness = deferred<void>();
    let rootSettledCalls = 0;
    let dynamicSettledCalls = 0;
    const value = fixture({
      rootSettled: () => ++rootSettledCalls === 1
        ? Promise.resolve()
        : root.promise,
      dynamicSettled: () => ++dynamicSettledCalls === 1
        ? Promise.resolve()
        : dynamic.promise,
      livenessClose: () => liveness.promise,
      keyCustodyQuiesce: () => Promise.reject(new Error("custody busy")),
    });
    const preparing = value.kernel.preProviderStop();
    await Promise.resolve();
    expect(value.calls).not.toContain("rlm.quiesce:17");
    liveness.resolve();
    await preparing;
    expect(value.calls).toEqual([
      "rootSessions.closeAdmission",
      "dynamicTools.closeAdmission",
      "actorSessions.close",
      "rootSessions.settled",
      "dynamicTools.settled",
      "liveness.close",
      "rlm.quiesce:17",
    ]);
    value.kernel.providerSourcesStopped();
    const stopping = value.kernel.shutdown();
    await Promise.resolve();
    expect(value.calls).toContain("rootSessions.closeObservation");
    root.resolve();
    dynamic.resolve();
    expect(await rejected(stopping)).toMatchObject({ code: "shutdown_failed" });
    expect(value.calls.at(-1)).toBe("keyCustody.quiesceForExternalDeletion");
    expect(value.kernel.databaseClosePermitted).toBeFalse();
  });
});

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve(value?: T): void;
}> {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((accept) => {
      resolve = accept;
    }),
    resolve: (value?: T) => resolve(value as T),
  };
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (cause: unknown) {
    return cause;
  }
  throw new Error("expected rejection");
}
