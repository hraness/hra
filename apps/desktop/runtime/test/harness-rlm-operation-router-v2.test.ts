import { describe, expect, test } from "bun:test";
import { fc } from "@hra-internal/test";

import type {
  PersistentActorStatus,
  PersistentActorTurnView,
  PersistentActorWaitAllResult,
  PersistentActorWaitAnyResult,
} from "../src/harness/persistent-actors";
import { PersistentActorError } from "../src/harness/persistent-actors";
import {
  RlmV2OperationRouter,
  parseRlmV2ActorSendArguments,
  parseRlmV2ActorSpawnArguments,
  type RlmV2ActorBinding,
  type RlmV2ActorOperationContract,
  type RlmV2ContextOperation,
} from "../src/harness/rlm-operation-router-v2";
import type { RlmV2OperationContext } from "../src/harness/rlm-v2";

const now = "2026-08-06T12:00:00.000Z";
const deadline = "2026-08-06T13:00:00.000Z";
const binding: RlmV2ActorBinding = {
  epochId: "hepoch_000000001",
  actorId: "hactor_000000001",
  turnId: "hturn_000000001",
  actorDepth: 0,
  completedPrefixSnapshotId: "ctxsnap_000000001",
  currentUserInputValueId: "ctxval_0000000001",
  contextQuotaBytes: 16 * 1024 * 1024,
};
function operationContext(signal = new AbortController().signal): RlmV2OperationContext {
  return {
    epochId: binding.epochId,
    actorId: binding.actorId,
    turnId: binding.turnId,
    capabilities: [
      "context.read",
      "context.materialize",
      "heap.read",
      "heap.write",
      "agent.spawn",
      "agent.message",
      "agent.wait",
      "agent.cancel",
      "routing.inspect",
      "harness.propose",
    ],
    admittedFeatures: ["boundedPrograms"],
    semanticWitnessDigests: ["a".repeat(64)],
    budget: {
      depthRemaining: 3,
      activeDescendantLimit: 8,
      durableDescendantLimit: 50,
      tokenBudget: 100_000,
      deadline,
      heapByteLimit: 16 * 1024 * 1024,
      contextValueByteLimit: 1024 * 1024,
      messageByteLimit: 256 * 1024,
      laneAuthority: "readOnly",
    },
    programRunId: "rlmrun_000000001",
    programDigest: "b".repeat(64),
    receiptId: "pop_000000000001",
    nodePath: [["step", 0]],
    signal,
  };
}

function actor(id = "hactor_000000002") {
  return {
    id,
    epochId: binding.epochId,
    parentActorId: binding.actorId,
    depth: 1,
    title: "Research",
    state: "active" as const,
    budget: {
      maxDepth: 3,
      maxActiveDescendants: 4,
      maxDurableDescendants: 8,
      tokenBudget: 8_000,
      byteBudget: 1024 * 1024,
      deadline,
      laneAuthority: "readOnlySnapshot" as const,
    },
    tokenReserved: 0,
    byteReserved: 0,
    nextTurnOrdinal: 2,
    nextResultOrdinal: 2,
    revision: 2,
    createdAt: now,
    updatedAt: now,
    stoppedAt: null,
  };
}

function turn(
  state: "running" | "succeeded" = "running",
  id = "hturn_000000002",
) {
  return {
    id,
    epochId: binding.epochId,
    actorId: actor().id,
    ordinal: 1,
    idempotencyKey: "idempotency_0001", // gitleaks:allow - deterministic test vector
    inputValueId: "ctxval_000000001",
    state,
    desiredState: "run" as const,
    revision: state === "running" ? 2 : 3,
    createdAt: now,
    startedAt: now,
    settledAt: state === "succeeded" ? now : null,
    outcomeCode: state === "succeeded" ? "completed" : null,
  };
}

function result(turnId = "hturn_000000002") {
  return {
    id: "hresult_000000001",
    epochId: binding.epochId,
    actorId: actor().id,
    turnId,
    terminalAttemptId: "hattempt_00000001",
    outcome: "succeeded" as const,
    valueId: "ctxval_000000002",
    actorResultOrdinal: 1,
    rootCompletionSequence: 1,
    createdAt: now,
  };
}

function runningView(): PersistentActorTurnView {
  return { turn: turn(), result: null };
}

function succeededView(): PersistentActorTurnView {
  const completed = turn("succeeded");
  return { turn: completed, result: result(completed.id) };
}

function fixture(overrides: Readonly<{
  bindingValue?: unknown;
  contextResult?: unknown;
  spawnError?: Error;
  sendError?: Error;
  cancelView?: PersistentActorTurnView;
  transferResult?: unknown;
  routingResult?: unknown;
  actorOperationContract?: RlmV2ActorOperationContract;
  actorOperationContractForActor?: RlmV2ActorOperationContract;
}> = {}) {
  const calls: Array<readonly [string, unknown]> = [];
  const actors = {
    spawn(input: unknown) {
      calls.push(["spawn", input]);
      if (overrides.spawnError !== undefined) {
        return Promise.reject(overrides.spawnError);
      }
      return Promise.resolve({ actor: actor(), turn: runningView() });
    },
    send(input: unknown) {
      calls.push(["send", input]);
      if (overrides.sendError !== undefined) {
        return Promise.reject(overrides.sendError);
      }
      return Promise.resolve(runningView());
    },
    status(input: unknown): Promise<PersistentActorStatus> {
      calls.push(["status", input]);
      return Promise.resolve({
        actor: actor(),
        incarnation: null,
        liveTurns: [turn()],
        latestResult: result(),
      });
    },
    waitAny(input: unknown): Promise<PersistentActorWaitAnyResult> {
      calls.push(["waitAny", input]);
      return Promise.resolve({
        state: "terminal",
        completed: succeededView(),
        pendingTurnIds: [],
      });
    },
    waitAll(input: unknown): Promise<PersistentActorWaitAllResult> {
      calls.push(["waitAll", input]);
      return Promise.resolve({
        state: "terminal",
        completed: [succeededView()],
        pendingTurnIds: [],
      });
    },
    result(input: unknown) {
      calls.push(["result", input]);
      return Promise.resolve(succeededView());
    },
    cancel(input: unknown) {
      calls.push(["cancel", input]);
      return Promise.resolve(overrides.cancelView ?? succeededView());
    },
  };
  const proposals = {
    list(input: unknown) {
      calls.push(["proposalList", input]);
      return Promise.resolve([{ id: "hproposal_000000001", revision: 1, title: "One" }]);
    },
    get(input: unknown) {
      calls.push(["proposalGet", input]);
      if (typeof input !== "string") throw new Error("invalid proposal ID");
      return Promise.resolve({
        summary: { id: input, revision: 1, title: "One" },
        body: { change: "one" },
      });
    },
    propose(input: unknown) {
      calls.push(["propose", input]);
      return Promise.resolve({ id: "hproposal_000000001", revision: 1, title: "One" });
    },
  };
  return {
    calls,
    router: new RlmV2OperationRouter({
      bindings: {
        resolve(context) {
          calls.push(["resolve", context.receiptId]);
          return Promise.resolve(overrides.bindingValue ?? binding);
        },
      },
      context: {
        invoke(operation, argumentsValue, input) {
          calls.push(["context", { operation, argumentsValue, input }]);
          return Promise.resolve(
            Object.prototype.hasOwnProperty.call(overrides, "contextResult")
              ? overrides.contextResult
              : { operation, valueId: "ctxval_000000001" },
          );
        },
      },
      actors,
      actorResults: {
        transfer(input) {
          calls.push(["transferResult", input]);
          return Promise.resolve(overrides.transferResult ?? {
            valueId: "ctxval_parent_result_0001",
            kind: "text",
            utf8Bytes: 42,
          });
        },
      },
      routing: {
        inspectForCaller(input) {
          calls.push(["routingInspect", input]);
          return Promise.resolve(
            Object.prototype.hasOwnProperty.call(overrides, "routingResult")
              ? overrides.routingResult
              : {
                  kind: "unavailable",
                  schemaVersion: 1,
                  mode: "shadow",
                  policyAuthorization: "none",
                  coverage: {
                    outcomes: "recursiveActorOutcomesOnly",
                    ordinaryRootTurnSpend: "excluded",
                  },
                  reason: "paneLineageUnavailable",
                },
          );
        },
      },
      proposals,
      ...(overrides.actorOperationContractForActor === undefined
        ? {}
        : {
          actorOperationContracts: {
            readForActor(input: unknown) {
              calls.push(["readActorOperationContract", input]);
              return overrides.actorOperationContractForActor!;
            },
          },
        }),
      ...(overrides.actorOperationContract === undefined
        ? {}
        : { actorOperationContract: overrides.actorOperationContract }),
    }),
  };
}

describe("RLM v2 operation router", () => {
  test("routes every context and heap operation through one bounded seam", async () => {
    const { router, calls } = fixture();
    const operations: readonly RlmV2ContextOperation[] = [
      "context.snapshot",
      "context.search",
      "context.slice",
      "context.materialize",
      "heap.put",
      "heap.get",
      "heap.list",
    ];
    for (const operation of operations) {
      expect(await router.invoke(operation, { query: "needle" }, operationContext()))
        .toEqual({ operation, valueId: "ctxval_000000001" });
    }
    const contextCalls = calls.filter(([name]) => name === "context");
    expect(contextCalls).toHaveLength(operations.length);
    expect(contextCalls[0]?.[1]).toMatchObject({
      input: {
        binding,
        receiptId: "pop_000000000001",
      },
    });
  });

  test("injects the durable caller and structural receipt into actor effects", async () => {
    const { router, calls } = fixture();
    const allocation = {
      tokenShareBps: 5_000,
      byteShareBps: 5_000,
      activeDescendantShareBps: 5_000,
      durableDescendantShareBps: 5_000,
    };
    expect(await router.invoke("agent.spawn", {
      title: "Research",
      workClass: "wideResearch",
      allocation,
      inputValueId: "ctxval_000000001",
    }, operationContext())).toEqual({
      actorId: "hactor_000000002",
      turn: {
        actorId: "hactor_000000002",
        outcomeCode: null,
        result: null,
        state: "running",
        turnId: "hturn_000000002",
      },
    });
    expect(calls.find(([name]) => name === "spawn")?.[1]).toEqual({
      callerActorId: binding.actorId,
      idempotencyKey: "pop_000000000001",
      title: "Research",
      policyVersion: 1,
      workClass: "wideResearch",
      budget: {
        maxDepth: 3,
        maxActiveDescendants: 4,
        maxDurableDescendants: 25,
        tokenBudget: 50_000,
        byteBudget: 8 * 1024 * 1024,
        deadline,
        laneAuthority: "readOnlySnapshot",
      },
      inputValueId: "ctxval_000000001",
    });

    await router.invoke("agent.send", {
      actorId: actor().id,
      inputValueId: "ctxval_000000001",
    }, operationContext());
    expect(calls.find(([name]) => name === "send")?.[1]).toEqual({
      callerActorId: binding.actorId,
      actorId: actor().id,
      inputValueId: "ctxval_000000001",
      idempotencyKey: "pop_000000000001",
    });
  });

  test("dual-reads predecessor actor calls only through the recovery contract", async () => {
    const allocation = {
      tokenShareBps: 1,
      byteShareBps: 1,
      activeDescendantShareBps: 1,
      durableDescendantShareBps: 1,
    };
    const predecessorSpawn = {
      title: "Existing child",
      allocation,
      inputValueId: "ctxval_000000001",
    };
    expect(() => parseRlmV2ActorSpawnArguments(
      predecessorSpawn,
      "current",
    )).toThrow();
    expect(parseRlmV2ActorSpawnArguments(
      predecessorSpawn,
      "predecessorRecoveryOnly",
    )).toEqual({
      ...predecessorSpawn,
      policyVersion: 0,
      workClass: "legacyUnclassified",
    });
    expect(() => parseRlmV2ActorSpawnArguments({
      ...predecessorSpawn,
      workClass: "standard",
    }, "predecessorRecoveryOnly")).toThrow();

    expect(parseRlmV2ActorSendArguments({
      actorId: actor().id,
      inputValueId: "ctxval_000000001",
    }, "current")).toEqual({
      actorId: actor().id,
      inputValueId: "ctxval_000000001",
    });

    const { router, calls } = fixture({
      actorOperationContract: "predecessorRecoveryOnly",
    });
    await router.invoke("agent.spawn", predecessorSpawn, operationContext());
    expect(calls.find(([name]) => name === "spawn")?.[1]).toMatchObject({
      policyVersion: 0,
      workClass: "legacyUnclassified",
    });

    const durable = fixture({
      actorOperationContractForActor: "predecessorRecoveryOnly",
    });
    await durable.router.invoke(
      "agent.spawn",
      predecessorSpawn,
      operationContext(),
    );
    expect(
      durable.calls.find(([name]) => name === "readActorOperationContract")
        ?.[1],
    ).toEqual({
      epochId: binding.epochId,
      actorId: binding.actorId,
      turnId: binding.turnId,
    });
    expect(durable.calls.find(([name]) => name === "spawn")?.[1])
      .toMatchObject({
        policyVersion: 0,
        workClass: "legacyUnclassified",
      });

    const current = fixture({ actorOperationContractForActor: "current" });
    expect(current.router.invoke(
      "agent.spawn",
      predecessorSpawn,
      operationContext(),
    )).rejects.toThrow();
  });

  test("rejects agent-supplied model-tier authority", () => {
    const allocation = {
      tokenShareBps: 1,
      byteShareBps: 1,
      activeDescendantShareBps: 1,
      durableDescendantShareBps: 1,
    };
    expect(fixture().router.invoke("agent.spawn", {
      title: "Injected tier",
      workClass: "boundedLeaf",
      acceleration: { mode: "standard" },
      allocation,
      inputValueId: "ctxval_000000001",
    }, operationContext())).rejects.toThrow();
    expect(fixture().router.invoke("agent.send", {
      actorId: actor().id,
      inputValueId: "ctxval_000000001",
      acceleration: {
        mode: "fast",
        criticalPath: true,
        bottleneck: "reasoning",
      },
    }, operationContext())).rejects.toThrow();
  });

  test("returns content-free actor status, result, waits, and cancellation", async () => {
    const { router, calls } = fixture();
    expect(await router.invoke("agent.status", { actorId: actor().id }, operationContext()))
      .toEqual({
        actorId: actor().id,
        state: "active",
        liveTurnIds: [turn().id],
        latestResult: {
          outcome: "succeeded",
          valueId: "ctxval_000000002",
          actorResultOrdinal: 1,
          rootCompletionSequence: 1,
        },
      });
    expect(await router.invoke("agent.result", { turnId: turn().id }, operationContext()))
      .toMatchObject({
        state: "succeeded",
        result: {
          valueId: "ctxval_parent_result_0001",
          kind: "text",
          utf8Bytes: 42,
        },
      });
    expect(calls.find(([name]) => name === "transferResult")?.[1]).toEqual({
      epochId: binding.epochId,
      callerActorId: binding.actorId,
      callerTurnId: binding.turnId,
      sourceActorId: actor().id,
      sourceTurnId: turn().id,
      sourceValueId: "ctxval_000000002",
      receiptId: "pop_000000000001",
      quotaLimitBytes: 16 * 1024 * 1024,
    });
    expect(await router.invoke("agent.waitAny", {
      turnIds: [turn().id],
      timeoutMs: 10,
    }, operationContext())).toMatchObject({ state: "terminal", pendingTurnIds: [] });
    expect(await router.invoke("agent.waitAll", {
      turnIds: [turn().id],
      timeoutMs: 10,
    }, operationContext())).toMatchObject({ state: "terminal", pendingTurnIds: [] });
    expect(await router.invoke("agent.cancel", { turnId: turn().id }, operationContext()))
      .toMatchObject({ state: "succeeded" });
  });

  test("marks response-lost actor mutations and unfinished cancellation for replay", async () => {
    const pending = new PersistentActorError(
      "provider_pending",
      "private provider detail",
    );
    const allocation = {
      tokenShareBps: 1,
      byteShareBps: 1,
      activeDescendantShareBps: 1,
      durableDescendantShareBps: 1,
    };
    const operations = [
      () => fixture({ spawnError: pending }).router.invoke("agent.spawn", {
        title: "Research",
        workClass: "standard",
        allocation,
        inputValueId: "ctxval_000000001",
      }, operationContext()),
      () => fixture({ sendError: pending }).router.invoke("agent.send", {
        actorId: actor().id,
        inputValueId: "ctxval_000000001",
      }, operationContext()),
      () => fixture({ cancelView: runningView() }).router.invoke("agent.cancel", {
        turnId: turn().id,
      }, operationContext()),
    ] as const;
    for (const operation of operations) {
      let caught: unknown;
      try {
        await operation();
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toMatchObject({
        code: "replay_required",
        message: "RLM external operation requires durable replay",
      });
    }
  });

  test("property: relative child allocations can never widen caller authority", async () => {
    await fc.assert(fc.asyncProperty(
      fc.record({
        tokenShareBps: fc.integer({ min: 1, max: 10_000 }),
        byteShareBps: fc.integer({ min: 1, max: 10_000 }),
        activeDescendantShareBps: fc.integer({ min: 1, max: 10_000 }),
        durableDescendantShareBps: fc.integer({ min: 1, max: 10_000 }),
      }),
      async (allocation) => {
        const { router, calls } = fixture();
        await router.invoke("agent.spawn", {
          title: "Bounded child",
          workClass: "boundedLeaf",
          allocation,
          inputValueId: "ctxval_000000001",
        }, operationContext());
        const spawn = calls.find(([name]) => name === "spawn")?.[1] as
          | { readonly budget?: Record<string, unknown> }
          | undefined;
        const budget = spawn?.budget;
        expect(budget).toBeDefined();
        expect(Number(budget?.tokenBudget)).toBeGreaterThanOrEqual(1);
        expect(Number(budget?.tokenBudget)).toBeLessThanOrEqual(
          operationContext().budget.tokenBudget,
        );
        expect(Number(budget?.byteBudget) % (1024 * 1024)).toBe(0);
        expect(Number(budget?.byteBudget)).toBeLessThanOrEqual(
          operationContext().budget.heapByteLimit,
        );
        expect(Number(budget?.maxActiveDescendants)).toBeLessThanOrEqual(
          Number(budget?.maxDurableDescendants),
        );
        expect(Number(budget?.maxDurableDescendants)).toBeLessThanOrEqual(
          operationContext().budget.durableDescendantLimit,
        );
      },
    ), { numRuns: 100 });
  });

  test("rejects spawn without remaining depth and child-owned result transfer", async () => {
    const noDepth = operationContext();
    let noDepthError: unknown;
    try {
      await fixture().router.invoke("agent.spawn", {
        title: "Too deep",
        workClass: "standard",
        allocation: {
          tokenShareBps: 1,
          byteShareBps: 1,
          activeDescendantShareBps: 1,
          durableDescendantShareBps: 1,
        },
        inputValueId: "ctxval_000000001",
      }, {
        ...noDepth,
        budget: { ...noDepth.budget, depthRemaining: 0 },
      });
    } catch (error: unknown) {
      noDepthError = error;
    }
    expect(noDepthError).toBeInstanceOf(Error);
    expect((noDepthError as Error).message).toContain("no child depth");

    let transferError: unknown;
    try {
      await fixture({
        transferResult: {
          valueId: "ctxval_000000002",
          kind: "text",
          utf8Bytes: 42,
        },
      }).router.invoke("agent.result", {
        turnId: turn().id,
      }, operationContext());
    } catch (error: unknown) {
      transferError = error;
    }
    expect(transferError).toBeInstanceOf(Error);
    expect((transferError as Error).message).toContain("child-owned custody");
  });

  test("routes only suggest-only proposal admission with injected lineage", async () => {
    const { router, calls } = fixture();
    expect(await router.invoke("harness.propose", {
      title: "One",
      body: { change: "one" },
    }, operationContext())).toEqual({
      id: "hproposal_000000001",
      revision: 1,
      title: "One",
    });
    expect(calls.find(([name]) => name === "propose")?.[1]).toEqual({
      receiptId: "pop_000000000001",
      epochId: binding.epochId,
      actorId: binding.actorId,
      turnId: binding.turnId,
      title: "One",
      body: { change: "one" },
      contextQuotaBytes: binding.contextQuotaBytes,
    });
  });

  test("inspects only the authenticated caller's bounded routing memory", async () => {
    const { router, calls } = fixture();
    expect(await router.invoke("routing.inspect", {}, operationContext())).toEqual({
      kind: "unavailable",
      schemaVersion: 1,
      mode: "shadow",
      policyAuthorization: "none",
      coverage: {
        outcomes: "recursiveActorOutcomesOnly",
        ordinaryRootTurnSpend: "excluded",
      },
      reason: "paneLineageUnavailable",
    });
    expect(calls.find(([name]) => name === "routingInspect")?.[1]).toEqual({
      epochId: binding.epochId,
      actorId: binding.actorId,
      turnId: binding.turnId,
    });

    expect(fixture().router.invoke(
      "routing.inspect",
      { actorId: "hactor_000000999" },
      operationContext(),
    )).rejects.toThrow();

    expect(fixture({
      routingResult: {
        kind: "unavailable",
        schemaVersion: 1,
        mode: "shadow",
        policyAuthorization: "none",
        coverage: {
          outcomes: "recursiveActorOutcomesOnly",
          ordinaryRootTurnSpend: "excluded",
        },
        reason: "paneLineageUnavailable",
        providerThreadId: "must-not-cross-the-routing-boundary",
      },
    }).router.invoke(
      "routing.inspect",
      {},
      operationContext(),
    )).rejects.toThrow();
  });

  test("rejects every model attempt to enumerate or read proposal data", async () => {
    const { router, calls } = fixture();
    for (const operation of ["harness.list", "harness.get"] as const) {
      expect(await rejected(router.invoke(
        operation as never,
        operation === "harness.get"
          ? { proposalId: "hproposal_000000001" }
          : {},
        operationContext(),
      ))).toBeInstanceOf(Error);
    }
    await Promise.resolve();
    expect(calls.some(([name]) =>
      name === "proposalList" || name === "proposalGet"
    )).toBeFalse();
  });

  test("fails closed for stale bindings, duplicate waits, cancellation, and hostile outputs", () => {
    expect(fixture({ bindingValue: { ...binding, extra: true } }).router.invoke(
      "heap.list",
      {},
      operationContext(),
    )).rejects.toThrow();
    expect(fixture({
      bindingValue: { ...binding, turnId: "hturn_000000009" },
    }).router.invoke(
      "heap.list",
      {},
      operationContext(),
    )).rejects.toThrow("durable caller binding changed");
    expect(fixture().router.invoke("agent.waitAny", {
      turnIds: [turn().id, turn().id],
      timeoutMs: 0,
    }, operationContext())).rejects.toThrow();

    const controller = new AbortController();
    controller.abort(new Error("stop"));
    expect(fixture().router.invoke(
      "heap.list",
      {},
      operationContext(controller.signal),
    )).rejects.toThrow("stop");

    const hostile = Object.create(null) as Record<string, unknown>;
    hostile.__proto__ = true;
    expect(fixture({ contextResult: hostile }).router.invoke(
      "heap.list",
      {},
      operationContext(),
    )).rejects.toThrow("invalid key");
  });

  test("property: every accepted wait set is returned in canonical unique order", async () => {
    await fc.assert(fc.asyncProperty(
      fc.uniqueArray(fc.integer({ min: 1, max: 32 }), {
        minLength: 1,
        maxLength: 32,
      }),
      async (ordinals) => {
        const ids = ordinals.map((ordinal) => `hturn_${String(ordinal).padStart(9, "0")}`);
        const { router, calls } = fixture();
        await router.invoke("agent.waitAll", {
          turnIds: ids,
          timeoutMs: 0,
        }, operationContext());
        expect(calls.find(([name]) => name === "waitAll")?.[1]).toEqual({
          callerActorId: binding.actorId,
          turnIds: ids,
          timeoutMs: 0,
        });
      },
    ), { numRuns: 100 });
  });

  test("rejects non-JSON context output before it can enter a receipt", () => {
    for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n]) {
      expect(fixture({ contextResult: value }).router.invoke(
        "context.snapshot",
        {},
        operationContext(),
      )).rejects.toThrow();
    }
  });
});

async function rejected(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected operation to reject");
}
