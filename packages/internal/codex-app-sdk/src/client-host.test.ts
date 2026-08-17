import { describe, expect, test } from "bun:test";

import {
  ambiguous,
  cancelled,
  confirmed,
  createAttemptId,
  type CodexIntent,
  type CodexReconciliationRequest,
  type DispatchOutcome,
} from "./client";
import {
  ClientHostLifecycleError,
  createCodexAppClientHost,
  type CodexAppDriver,
} from "./client-host";
import {
  defineOperation,
  defineOperationRegistry,
  type OperationName,
  type OperationOutput,
} from "./operations";
import { createReducerStore } from "./store";
import {
  createScriptedCodexAppDriver,
} from "./testing/scripted-driver";

type TestSnapshot = Readonly<{ messageCount: number }>;
type TestResult = Readonly<{ turnId: string }>;
const testOperations = defineOperationRegistry({
  "message.send": defineOperation<
    Readonly<{ text: string }>,
    TestResult
  >({
    effect: "non-idempotent-mutation",
    lostResponse: "ambiguous",
    timeoutMs: 30_000,
    concurrency: "per-thread",
    reconciliation: {
      kind: "automatic",
      strategy: "client-message-id",
    },
  }),
  "thread.count": defineOperation<Readonly<Record<never, never>>, number>({
    effect: "read",
    lostResponse: "safe-to-retry",
    timeoutMs: 10_000,
    concurrency: "parallel",
    reconciliation: "not-required",
  }),
  "thread.rename": defineOperation<
    Readonly<{ name: string }>,
    Readonly<{ name: string }>
  >({
    effect: "idempotent-mutation",
    lostResponse: "safe-to-retry",
    timeoutMs: 10_000,
    concurrency: "per-thread",
    reconciliation: "not-required",
  }),
  "message.untracked-send": defineOperation<
    Readonly<{ text: string }>,
    TestResult
  >({
    effect: "non-idempotent-mutation",
    lostResponse: "ambiguous",
    timeoutMs: 30_000,
    concurrency: "per-thread",
    reconciliation: {
      kind: "unsupported",
      strategy: "provider-does-not-expose-lookup",
    },
  }),
});
type TestOperations = typeof testOperations;
type TestIntent = CodexIntent<TestOperations, "message.send">;

describe("Codex app client host", () => {
  test("owns lifecycle while delegating state and typed outcomes", async () => {
    expect(Object.keys(testOperations)).toEqual([
      "message.send",
      "thread.count",
      "thread.rename",
      "message.untracked-send",
    ]);
    const attemptId = createAttemptId("attempt-client-1");
    const driver = createScriptedCodexAppDriver<
      TestSnapshot,
      TestOperations
    >({
      initialSnapshot: { messageCount: 0 },
      steps: [
        {
          call: "dispatch",
          expectedType: "message.send",
          outcome: confirmed(attemptId, { turnId: "turn-1" }),
          snapshot: { messageCount: 1 },
        },
        {
          call: "reconcile",
          expectedOperation: "message.send",
          expectedAttemptId: attemptId,
          outcome: confirmed(attemptId, { turnId: "turn-1" }),
        },
      ],
    });
    const client = createCodexAppClientHost(testOperations, driver);
    const intent: TestIntent = {
      type: "message.send",
      attemptId,
      input: { text: "hello" },
    };

    expect((await client.dispatch(intent)).status).toBe("rejected");
    await client.start();
    expect(client.lifecycle.getSnapshot()).toEqual({
      status: "running",
      generation: 1,
    });

    const typedOutcome: Promise<DispatchOutcome<TestResult>> =
      client.dispatch(intent);
    const outcome = await typedOutcome;
    expect(outcome).toEqual({
      status: "confirmed",
      attemptId,
      value: { turnId: "turn-1" },
    });
    expect(client.store.getSnapshot()).toEqual({ messageCount: 1 });
    expect(
      (
        await client.reconcile({
          operation: "message.send",
          attemptId,
        })
      ).status,
    ).toBe("confirmed");

    await client.close();
    await client.close();
    expect(client.lifecycle.getSnapshot()).toEqual({
      status: "closed",
      generation: 1,
      failure: null,
    });
    expect(driver.remainingSteps()).toBe(0);
    expect(driver.calls().map((call) => call.call)).toEqual([
      "start",
      "dispatch",
      "reconcile",
      "close",
    ]);
  });

  test("uses the declared reconciliation strategy for an ambiguous driver failure", async () => {
    const attemptId = createAttemptId("attempt-client-2");
    const driver = createScriptedCodexAppDriver<
      TestSnapshot,
      TestOperations
    >({
      initialSnapshot: { messageCount: 0 },
      steps: [
        {
          call: "dispatch",
          expectedType: "thread.count",
          outcome: confirmed(attemptId, 0),
        },
      ],
    });
    const client = createCodexAppClientHost(testOperations, driver);
    await client.start();

    const outcome = await client.dispatch({
      type: "message.send",
      attemptId,
      input: { text: "hello" },
    });

    expect(outcome).toEqual({
      status: "ambiguous",
      attemptId,
      reconciliation: {
        operation: "message.send",
        strategy: {
          kind: "automatic",
          strategy: "client-message-id",
        },
        reason: "driver-contract-violation",
      },
    });
    await client.close();
  });

  test("makes safe-to-retry driver failures retryable instead of ambiguous", async () => {
    const readAttemptId = createAttemptId("attempt-safe-read");
    const mutationAttemptId = createAttemptId("attempt-safe-mutation");
    const driver = createScriptedCodexAppDriver<
      TestSnapshot,
      TestOperations
    >({
      initialSnapshot: { messageCount: 0 },
      steps: [
        {
          call: "dispatch",
          expectedType: "message.send",
          outcome: confirmed(readAttemptId, { turnId: "unused-read" }),
        },
        {
          call: "dispatch",
          expectedType: "message.send",
          outcome: confirmed(mutationAttemptId, {
            turnId: "unused-mutation",
          }),
        },
      ],
    });
    const client = createCodexAppClientHost(testOperations, driver);
    await client.start();

    const readOutcome = await client.dispatch({
      type: "thread.count",
      attemptId: readAttemptId,
      input: {},
    });
    const mutationOutcome = await client.dispatch({
      type: "thread.rename",
      attemptId: mutationAttemptId,
      input: { name: "renamed" },
    });

    for (const outcome of [readOutcome, mutationOutcome]) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.error.code).toBe("driver_contract_violation");
        expect(outcome.error.retryable).toBe(true);
        expect(outcome.error.metadata?.lostResponse).toBe("safe-to-retry");
      }
    }
    await client.close();
  });

  test("rejects crafted unknown and non-reconcilable operations before the driver", async () => {
    const attemptId = createAttemptId("attempt-crafted-operation");
    const driver = createScriptedCodexAppDriver<
      TestSnapshot,
      TestOperations
    >({
      initialSnapshot: { messageCount: 0 },
      steps: [],
    });
    const client = createCodexAppClientHost(testOperations, driver);
    await client.start();

    const unknown = await client.dispatch({
      type: "future.operation",
      attemptId,
      input: {},
    } as unknown as CodexIntent<TestOperations, "message.send">);
    const inheritedEnvelope = Object.create({
      type: "message.send",
    }) as Record<string, unknown>;
    inheritedEnvelope["attemptId"] = attemptId;
    inheritedEnvelope["input"] = { text: "must not dispatch" };
    const inheritedEnvelopeFailure = await client
      .dispatch(
        inheritedEnvelope as unknown as CodexIntent<
          TestOperations,
          "message.send"
        >,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    const nullPrototypeEnvelope = Object.create(null) as Record<
      string,
      unknown
    >;
    nullPrototypeEnvelope["type"] = "future.null-prototype";
    nullPrototypeEnvelope["attemptId"] = attemptId;
    nullPrototypeEnvelope["input"] = {};
    const nullPrototypeOperation = await client.dispatch(
      nullPrototypeEnvelope as unknown as CodexIntent<
        TestOperations,
        "message.send"
      >,
    );
    const nullEnvelopeFailure = await client
      .dispatch(
        null as unknown as CodexIntent<TestOperations, "message.send">,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    const readReconciliation = await client.reconcile({
      operation: "thread.count",
      attemptId,
    } as unknown as CodexReconciliationRequest<
      TestOperations,
      "message.send"
    >);
    const unsupportedReconciliation = await client.reconcile({
      operation: "message.untracked-send",
      attemptId,
    } as unknown as CodexReconciliationRequest<
      TestOperations,
      "message.send"
    >);

    expect(unknown).toEqual({
      status: "rejected",
      attemptId,
      error: {
        code: "unknown_operation",
        message: "The operation is not declared by this client.",
        retryable: false,
        metadata: {},
      },
    });
    expect(inheritedEnvelopeFailure).toBeInstanceOf(TypeError);
    expect(nullPrototypeOperation.status).toBe("rejected");
    expect(nullEnvelopeFailure).toBeInstanceOf(TypeError);
    expect(readReconciliation.status).toBe("rejected");
    expect(unsupportedReconciliation.status).toBe("rejected");
    if (readReconciliation.status === "rejected") {
      expect(readReconciliation.error.code).toBe(
        "operation_reconciliation_unavailable",
      );
    }
    if (unsupportedReconciliation.status === "rejected") {
      expect(unsupportedReconciliation.error.code).toBe(
        "operation_reconciliation_unavailable",
      );
    }
    expect(driver.calls().map((call) => call.call)).toEqual(["start"]);
    await client.close();
  });

  test("rejects non-portable driver error metadata as a contract violation", async () => {
    const arrayAttemptId = createAttemptId("attempt-array-metadata");
    const numberAttemptId = createAttemptId("attempt-number-metadata");
    const malformedOutcome = (
      attemptId: typeof arrayAttemptId,
      metadata: unknown,
    ): DispatchOutcome<number> => {
      const outcome = {
        status: "rejected",
        attemptId,
        error: {
          code: "private_driver_error",
          message: "private driver error",
          retryable: false,
          metadata,
        },
      };
      return outcome as unknown as DispatchOutcome<number>;
    };
    const driver = createScriptedCodexAppDriver<
      TestSnapshot,
      TestOperations
    >({
      initialSnapshot: { messageCount: 0 },
      steps: [
        {
          call: "dispatch",
          expectedType: "thread.count",
          outcome: malformedOutcome(arrayAttemptId, ["not", "a", "record"]),
        },
        {
          call: "dispatch",
          expectedType: "thread.count",
          outcome: malformedOutcome(numberAttemptId, {
            durationMs: Number.POSITIVE_INFINITY,
          }),
        },
      ],
    });
    const client = createCodexAppClientHost(testOperations, driver);
    await client.start();

    const arrayOutcome = await client.dispatch({
      type: "thread.count",
      attemptId: arrayAttemptId,
      input: {},
    });
    const numberOutcome = await client.dispatch({
      type: "thread.count",
      attemptId: numberAttemptId,
      input: {},
    });

    for (const outcome of [arrayOutcome, numberOutcome]) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.error.code).toBe("driver_contract_violation");
        expect(outcome.error.retryable).toBe(true);
        expect(outcome.error.metadata?.durationMs).toBeUndefined();
      }
    }
    await client.close();
  });

  test("rejects accessor and inherited driver outcome fields without reading them", async () => {
    const getterAttemptId = createAttemptId("attempt-getter-outcome");
    const prototypeAttemptId = createAttemptId("attempt-prototype-outcome");
    let statusReads = 0;
    const getterOutcome: Record<string, unknown> = {
      attemptId: getterAttemptId,
      value: 1,
    };
    Object.defineProperty(getterOutcome, "status", {
      enumerable: true,
      get: () => {
        statusReads += 1;
        return statusReads === 1 ? "confirmed" : "rejected";
      },
    });
    const prototypeOutcome = Object.create({
      status: "confirmed",
    }) as Record<string, unknown>;
    prototypeOutcome["attemptId"] = prototypeAttemptId;
    prototypeOutcome["value"] = 2;
    const driver = createScriptedCodexAppDriver<
      TestSnapshot,
      TestOperations
    >({
      initialSnapshot: { messageCount: 0 },
      steps: [
        {
          call: "dispatch",
          expectedType: "thread.count",
          outcome: getterOutcome as unknown as DispatchOutcome<number>,
        },
        {
          call: "dispatch",
          expectedType: "thread.count",
          outcome: prototypeOutcome as unknown as DispatchOutcome<number>,
        },
      ],
    });
    const client = createCodexAppClientHost(testOperations, driver);
    await client.start();

    const getterResult = await client.dispatch({
      type: "thread.count",
      attemptId: getterAttemptId,
      input: {},
    });
    const prototypeResult = await client.dispatch({
      type: "thread.count",
      attemptId: prototypeAttemptId,
      input: {},
    });

    expect(statusReads).toBe(0);
    for (const outcome of [getterResult, prototypeResult]) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.error.code).toBe("driver_contract_violation");
        expect(outcome.error.retryable).toBe(true);
      }
    }
    await client.close();
  });

  test("returns a frozen normalized copy of an accepted driver outcome", async () => {
    const attemptId = createAttemptId("attempt-normalized-outcome");
    const metadata: Record<string, string> = { phase: "initial" };
    const driverError = {
      code: "authority_rejected",
      message: "The authority rejected the request.",
      retryable: false,
      metadata,
    };
    const rawOutcome = {
      status: "rejected",
      attemptId,
      error: driverError,
    };
    const driver = createScriptedCodexAppDriver<
      TestSnapshot,
      TestOperations
    >({
      initialSnapshot: { messageCount: 0 },
      steps: [
        {
          call: "dispatch",
          expectedType: "thread.count",
          outcome: rawOutcome as unknown as DispatchOutcome<number>,
        },
      ],
    });
    const client = createCodexAppClientHost(testOperations, driver);
    await client.start();

    const outcome = await client.dispatch({
      type: "thread.count",
      attemptId,
      input: {},
    });
    rawOutcome.status = "confirmed";
    driverError.message = "mutated after validation";
    metadata["phase"] = "mutated";

    expect(outcome).not.toBe(rawOutcome);
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(Object.isFrozen(outcome.error)).toBe(true);
      expect(Object.isFrozen(outcome.error.metadata)).toBe(true);
      expect(outcome.error.message).toBe(
        "The authority rejected the request.",
      );
      expect(outcome.error.metadata?.phase).toBe("initial");
    }
    await client.close();
  });

  test("fails closed when a safe-to-retry driver reports ambiguity", async () => {
    const attemptId = createAttemptId("attempt-invalid-ambiguity");
    const driver = createScriptedCodexAppDriver<
      TestSnapshot,
      TestOperations
    >({
      initialSnapshot: { messageCount: 0 },
      steps: [
        {
          call: "dispatch",
          expectedType: "thread.count",
          outcome: ambiguous(attemptId, {
            operation: "thread.count",
            strategy: {
              kind: "manual",
              strategy: "invalid-read-reconciliation",
            },
            reason: "lost-response",
          }),
        },
      ],
    });
    const client = createCodexAppClientHost(testOperations, driver);
    await client.start();

    const outcome = await client.dispatch({
      type: "thread.count",
      attemptId,
      input: {},
    });

    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.error).toMatchObject({
        code: "driver_contract_violation",
        retryable: true,
      });
    }
    await client.close();
  });

  test("validates and snapshots registry descriptors at host creation", () => {
    const driver = createScriptedCodexAppDriver<
      TestSnapshot,
      TestOperations
    >({
      initialSnapshot: { messageCount: 0 },
      steps: [],
    });
    const malformed = {
      ...testOperations,
      "message.send": {
        ...testOperations["message.send"],
        name: "message.typo",
      },
    } as unknown as TestOperations;

    expect(() => createCodexAppClientHost(malformed, driver)).toThrow(
      "must repeat its registry name",
    );
  });

  test("rejects accessor semantics before a descriptor can drift effect classes", () => {
    const driver = createScriptedCodexAppDriver<
      TestSnapshot,
      TestOperations
    >({
      initialSnapshot: { messageCount: 0 },
      steps: [],
    });
    let effectReads = 0;
    const semantics: Record<string, unknown> = {
      lostResponse: "safe-to-retry",
      timeoutMs: 1_000,
      concurrency: "parallel",
      reconciliation: "not-required",
    };
    Object.defineProperty(semantics, "effect", {
      enumerable: true,
      get: () => {
        effectReads += 1;
        return effectReads === 1 ? "read" : "non-idempotent-mutation";
      },
    });
    const drifting = {
      drift: {
        name: "drift",
        semantics,
      },
    } as unknown as TestOperations;

    expect(() => createCodexAppClientHost(drifting, driver)).toThrow(
      "operation effect must be an own data property",
    );
    expect(effectReads).toBe(0);
  });

  test("does not expose a driver's start error to callers or lifecycle state", async () => {
    const driver = createScriptedCodexAppDriver<
      TestSnapshot,
      TestOperations
    >({
      initialSnapshot: { messageCount: 0 },
      steps: [],
      startFailure: new Error("credential value must not enter UI state"),
    });
    const client = createCodexAppClientHost(testOperations, driver);

    let startError: unknown = null;
    try {
      await client.start();
    } catch (error) {
      startError = error;
    }
    expect(startError).toBeInstanceOf(ClientHostLifecycleError);
    if (startError instanceof ClientHostLifecycleError) {
      expect(startError.message).toBe(
        "The client driver failed to start.",
      );
      expect(startError.failure).toEqual({
        code: "driver_start_failed",
        message: "The client driver failed to start.",
        retryable: true,
      });
    }
    expect(String(startError)).not.toContain("credential");
    expect(client.lifecycle.getSnapshot()).toEqual({
      status: "failed",
      generation: 1,
      phase: "start",
      failure: {
        code: "driver_start_failed",
        message: "The client driver failed to start.",
        retryable: true,
      },
    });
    const repeatedStartError = await client.start().then(
      () => null,
      (error: unknown) => error,
    );
    expect(repeatedStartError).toBeInstanceOf(ClientHostLifecycleError);
    expect(driver.calls().filter((call) => call.call === "start")).toHaveLength(
      1,
    );
    await client.close();
  });

  test("cancels before invocation when the caller signal is already aborted", async () => {
    const attemptId = createAttemptId("attempt-client-3");
    const driver = createScriptedCodexAppDriver<
      TestSnapshot,
      TestOperations
    >({
      initialSnapshot: { messageCount: 0 },
      steps: [
        {
          call: "dispatch",
          expectedType: "message.send",
          outcome: confirmed(attemptId, { turnId: "turn-3" }),
        },
      ],
    });
    const client = createCodexAppClientHost(testOperations, driver);
    const controller = new AbortController();
    controller.abort();
    await client.start();

    const outcome = await client.dispatch(
      {
          type: "message.send",
          attemptId,
          input: { text: "hello" },
      },
      { signal: controller.signal },
    );

    expect(outcome).toEqual({
      status: "cancelled",
      attemptId,
      reason: "caller",
    });
    expect(driver.remainingSteps()).toBe(1);
    await client.close();
  });

  test("preserves caller and host provenance for in-flight cancellation", async () => {
    const createAbortReportingDriver = (
      reportedReason: "caller" | "client-closing",
    ): Readonly<{
      driver: CodexAppDriver<TestSnapshot, TestOperations>;
      started: Promise<void>;
    }> => {
      const store = createReducerStore<TestSnapshot, TestSnapshot>(
        { messageCount: 0 },
        (_snapshot, next) => next,
      );
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const driver: CodexAppDriver<TestSnapshot, TestOperations> = {
        store,
        start: () => Promise.resolve(),
        dispatch: (intent, context) =>
          new Promise((resolve) => {
            markStarted();
            context.signal.addEventListener(
              "abort",
              () => {
                resolve(cancelled(intent.attemptId, reportedReason));
              },
              { once: true },
            );
          }),
        reconcile: (request) =>
          Promise.resolve(cancelled(request.attemptId, "superseded")),
        close: () => Promise.resolve(),
      };
      return Object.freeze({ driver, started });
    };

    const callerAttemptId = createAttemptId("attempt-caller-provenance");
    const callerDriver = createAbortReportingDriver("client-closing");
    const callerClient = createCodexAppClientHost(
      testOperations,
      callerDriver.driver,
    );
    const callerController = new AbortController();
    await callerClient.start();
    const callerOutcomePromise = callerClient.dispatch(
      {
        type: "message.send",
        attemptId: callerAttemptId,
        input: { text: "cancel by caller" },
      },
      { signal: callerController.signal },
    );
    await callerDriver.started;
    callerController.abort();

    expect(await callerOutcomePromise).toEqual({
      status: "cancelled",
      attemptId: callerAttemptId,
      reason: "caller",
    });
    await callerClient.close();

    const hostAttemptId = createAttemptId("attempt-host-provenance");
    const hostDriver = createAbortReportingDriver("caller");
    const hostClient = createCodexAppClientHost(
      testOperations,
      hostDriver.driver,
    );
    await hostClient.start();
    const hostOutcomePromise = hostClient.dispatch({
      type: "message.send",
      attemptId: hostAttemptId,
      input: { text: "cancel by host" },
    });
    await hostDriver.started;
    const closePromise = hostClient.close();

    expect(await hostOutcomePromise).toEqual({
      status: "cancelled",
      attemptId: hostAttemptId,
      reason: "client-closing",
    });
    await closePromise;
  });

  test("does not enter running state when start is cancelled at completion", async () => {
    const attemptId = createAttemptId("attempt-client-start-cancel");
    const store = createReducerStore<TestSnapshot, TestSnapshot>(
      { messageCount: 0 },
      (_snapshot, next) => next,
    );
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const driver: CodexAppDriver<TestSnapshot, TestOperations> = {
      store,
      start: () => startGate,
      dispatch: (intent) =>
        Promise.resolve(cancelled(intent.attemptId, "superseded")),
      reconcile: (request) =>
        Promise.resolve(cancelled(request.attemptId, "superseded")),
      close: () => Promise.resolve(),
    };
    const client = createCodexAppClientHost(testOperations, driver);
    const controller = new AbortController();
    const startPromise = client.start({ signal: controller.signal });
    controller.abort();
    releaseStart();

    let startError: unknown = null;
    try {
      await startPromise;
    } catch (error) {
      startError = error;
    }

    expect(startError).toBeInstanceOf(Error);
    expect(client.lifecycle.getSnapshot()).toEqual({
      status: "failed",
      generation: 1,
      phase: "start",
      failure: {
        code: "start_cancelled",
        message: "Client start was cancelled before it completed.",
        retryable: true,
      },
    });
    expect(
      (
        await client.dispatch({
          type: "message.send",
          attemptId,
          input: { text: "unused" },
        })
      ).status,
    ).toBe("rejected");
    await client.close();
  });

  test("waits for an aborted start to settle before closing the driver", async () => {
    const store = createReducerStore<TestSnapshot, TestSnapshot>(
      { messageCount: 0 },
      (_snapshot, next) => next,
    );
    const calls: string[] = [];
    let rejectStart!: (error: Error) => void;
    const startGate = new Promise<void>((_resolve, reject) => {
      rejectStart = reject;
    });
    const driver: CodexAppDriver<TestSnapshot, TestOperations> = {
      store,
      start: ({ signal }) => {
        calls.push("start");
        signal.addEventListener(
          "abort",
          () => {
            calls.push("start-aborted");
          },
          { once: true },
        );
        return startGate;
      },
      dispatch: (intent) =>
        Promise.resolve(cancelled(intent.attemptId, "superseded")),
      reconcile: (request) =>
        Promise.resolve(cancelled(request.attemptId, "superseded")),
      close: () => {
        calls.push("close");
        return Promise.resolve();
      },
    };
    const client = createCodexAppClientHost(testOperations, driver);
    const startPromise = client.start();
    const observedStart = startPromise.then(
      () => null,
      (error: unknown) => error,
    );

    const closePromise = client.close();

    expect(calls).toEqual(["start", "start-aborted"]);
    expect(client.lifecycle.getSnapshot().status).toBe("closing");

    calls.push("start-settling");
    rejectStart(new Error("private start failure"));
    const startError = await observedStart;
    expect(startError).toBeInstanceOf(ClientHostLifecycleError);
    expect(String(startError)).not.toContain("private start failure");
    await closePromise;

    expect(calls).toEqual([
      "start",
      "start-aborted",
      "start-settling",
      "close",
    ]);
    expect(client.lifecycle.getSnapshot()).toEqual({
      status: "closed",
      generation: 1,
      failure: null,
    });
  });

  test("installs idempotency guards before lifecycle notifications", async () => {
    const store = createReducerStore<TestSnapshot, TestSnapshot>(
      { messageCount: 0 },
      (_snapshot, next) => next,
    );
    const calls: string[] = [];
    const driver: CodexAppDriver<TestSnapshot, TestOperations> = {
      store,
      start: () => {
        calls.push("start");
        return Promise.resolve();
      },
      dispatch: (intent) =>
        Promise.resolve(cancelled(intent.attemptId, "superseded")),
      reconcile: (request) =>
        Promise.resolve(cancelled(request.attemptId, "superseded")),
      close: () => {
        calls.push("close");
        return Promise.resolve();
      },
    };
    const client = createCodexAppClientHost(testOperations, driver);
    let reentrantStart: Promise<void> | null = null;
    let reentrantClose: Promise<void> | null = null;
    client.lifecycle.subscribe(() => {
      const lifecycle = client.lifecycle.getSnapshot();
      if (lifecycle.status === "starting" && reentrantStart === null) {
        reentrantStart = client.start();
      }
      if (lifecycle.status === "closing" && reentrantClose === null) {
        reentrantClose = client.close();
      }
    });

    const firstStart = client.start();
    expect(reentrantStart as Promise<void> | null).toBe(firstStart);
    await firstStart;
    const firstClose = client.close();
    expect(reentrantClose as Promise<void> | null).toBe(firstClose);
    await firstClose;

    expect(calls).toEqual(["start", "close"]);
  });

  test("rejects start when close wins before a pending driver start resolves", async () => {
    const store = createReducerStore<TestSnapshot, TestSnapshot>(
      { messageCount: 0 },
      (_snapshot, next) => next,
    );
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let closeCount = 0;
    const driver: CodexAppDriver<TestSnapshot, TestOperations> = {
      store,
      start: () => startGate,
      dispatch: (intent) =>
        Promise.resolve(cancelled(intent.attemptId, "superseded")),
      reconcile: (request) =>
        Promise.resolve(cancelled(request.attemptId, "superseded")),
      close: () => {
        closeCount += 1;
        return Promise.resolve();
      },
    };
    const client = createCodexAppClientHost(testOperations, driver);
    const startPromise = client.start();
    const closePromise = client.close();
    releaseStart();

    const startError = await startPromise.then(
      () => null,
      (error: unknown) => error,
    );
    expect(startError).toBeInstanceOf(ClientHostLifecycleError);
    if (startError instanceof ClientHostLifecycleError) {
      expect(startError.failure.code).toBe("start_cancelled");
    }
    await closePromise;
    expect(closeCount).toBe(1);
    expect(client.lifecycle.getSnapshot().status).toBe("closed");
  });

  test("records a reentrant caller abort as a terminal start failure", async () => {
    const store = createReducerStore<TestSnapshot, TestSnapshot>(
      { messageCount: 0 },
      (_snapshot, next) => next,
    );
    const controller = new AbortController();
    let startCount = 0;
    const driver: CodexAppDriver<TestSnapshot, TestOperations> = {
      store,
      start: () => {
        startCount += 1;
        return Promise.resolve();
      },
      dispatch: (intent) =>
        Promise.resolve(cancelled(intent.attemptId, "superseded")),
      reconcile: (request) =>
        Promise.resolve(cancelled(request.attemptId, "superseded")),
      close: () => Promise.resolve(),
    };
    const client = createCodexAppClientHost(testOperations, driver);
    client.lifecycle.subscribe(() => {
      if (client.lifecycle.getSnapshot().status === "starting") {
        controller.abort();
      }
    });

    const error = await client.start({ signal: controller.signal }).then(
      () => null,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(ClientHostLifecycleError);
    expect(startCount).toBe(0);
    expect(client.lifecycle.getSnapshot()).toEqual({
      status: "failed",
      generation: 1,
      phase: "start",
      failure: {
        code: "start_cancelled",
        message: "Client start was cancelled before it completed.",
        retryable: true,
      },
    });
    await client.close();
  });

  test("tracks an invoked command before a reentrant close can snapshot it", async () => {
    const attemptId = createAttemptId("attempt-reentrant-close");
    const store = createReducerStore<TestSnapshot, TestSnapshot>(
      { messageCount: 0 },
      (_snapshot, next) => next,
    );
    let resolveDispatch!: (
      outcome: DispatchOutcome<TestResult>,
    ) => void;
    const dispatchGate = new Promise<DispatchOutcome<TestResult>>(
      (resolve) => {
        resolveDispatch = resolve;
      },
    );
    let closeClient: (() => Promise<void>) | null = null;
    let reentrantClose: Promise<void> | null = null;
    let closeCount = 0;
    const driver: CodexAppDriver<TestSnapshot, TestOperations> = {
      store,
      start: () => Promise.resolve(),
      dispatch: <Name extends OperationName<TestOperations>>() => {
        if (closeClient === null) {
          throw new Error("client close port was not installed");
        }
        reentrantClose = closeClient();
        return dispatchGate as Promise<
          DispatchOutcome<OperationOutput<TestOperations[Name]>>
        >;
      },
      reconcile: (request) =>
        Promise.resolve(cancelled(request.attemptId, "superseded")),
      close: () => {
        closeCount += 1;
        return Promise.resolve();
      },
    };
    const client = createCodexAppClientHost(testOperations, driver);
    closeClient = client.close;
    await client.start();

    const outcomePromise = client.dispatch({
      type: "message.send",
      attemptId,
      input: { text: "hello" },
    });

    expect(client.lifecycle.getSnapshot().status).toBe("closing");
    await Promise.resolve();
    expect(client.lifecycle.getSnapshot().status).toBe("closing");
    expect(closeCount).toBe(1);
    resolveDispatch(confirmed(attemptId, { turnId: "turn-reentrant" }));
    expect((await outcomePromise).status).toBe("confirmed");
    await (reentrantClose as Promise<void> | null);
    expect(client.lifecycle.getSnapshot().status).toBe("closed");
  });

  test("waits for an invoked command while closing the driver", async () => {
    const attemptId = createAttemptId("attempt-client-4");
    const store = createReducerStore<TestSnapshot, TestSnapshot>(
      { messageCount: 0 },
      (_snapshot, next) => next,
    );
    let resolveDispatch!: (
      outcome: DispatchOutcome<TestResult>,
    ) => void;
    const pendingDispatch = new Promise<DispatchOutcome<TestResult>>(
      (resolve) => {
        resolveDispatch = resolve;
      },
    );
    const driver: CodexAppDriver<TestSnapshot, TestOperations> = {
      store,
      start: () => Promise.resolve(),
      dispatch: <Name extends OperationName<TestOperations>>() =>
        pendingDispatch as Promise<
          DispatchOutcome<OperationOutput<TestOperations[Name]>>
        >,
      reconcile: (request) =>
        Promise.resolve(cancelled(request.attemptId, "superseded")),
      close: () => Promise.resolve(),
    };
    const client = createCodexAppClientHost(testOperations, driver);
    await client.start();
    const outcomePromise = client.dispatch({
      type: "message.send",
      attemptId,
      input: { text: "hello" },
    });
    const closePromise = client.close();

    expect(client.lifecycle.getSnapshot().status).toBe("closing");
    resolveDispatch(confirmed(attemptId, { turnId: "turn-4" }));

    expect((await outcomePromise).status).toBe("confirmed");
    await closePromise;
    expect(client.lifecycle.getSnapshot().status).toBe("closed");
  });
});
