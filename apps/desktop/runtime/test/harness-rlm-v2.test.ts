import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import type { RecursiveBudget } from "../src/harness/domain";
import {
  MemoryRlmV2ReceiptStore,
  RlmV2OperationReplayRequiredError,
  RlmV2ReferenceEvaluator,
  canonicalRlmV2Equal,
  deriveRlmV2ReceiptId,
  digestRlmV2Program,
  evaluateRlmV2Expression,
  parseRlmV2Program,
  parseRlmV2Caller,
  safeParseRlmV2Program,
  type RlmV2Operation,
  type RlmV2OperationContext,
  type RlmV2OperationPort,
  type RlmV2OperationReceipt,
  type RlmV2Caller,
  type RlmV2JsonValue,
  type RlmV2Program,
  type RlmV2ReceiptPort,
} from "../src/harness/rlm-v2";

const DEADLINE = "2030-01-01T00:00:00.000Z";
const budget: RecursiveBudget = {
  depthRemaining: 3,
  activeDescendantLimit: 8,
  durableDescendantLimit: 50,
  tokenBudget: 1_000_000,
  deadline: DEADLINE,
  heapByteLimit: 16 * 1024 * 1024,
  contextValueByteLimit: 1024 * 1024,
  messageByteLimit: 128 * 1024,
  laneAuthority: "managedWrite",
};

function caller(
  capabilities: RlmV2Caller["capabilities"] = [],
  deadline = DEADLINE,
): RlmV2Caller {
  return {
    epochId: "hepoch_rlmv2root0001",
    actorId: "hactor_rlmv2caller01",
    turnId: "hturn_rlmv2caller001",
    capabilities,
    admittedFeatures: ["boundedPrograms", "recursiveAgents"],
    semanticWitnessDigests: [],
    budget: { ...budget, deadline },
  };
}

const noOperations: RlmV2OperationPort = {
  invoke: () => Promise.reject(new Error("unexpected operation")),
};

function literal(value: RlmV2JsonValue) {
  return { kind: "literal", value } as const;
}

function variable(name: string) {
  return { kind: "variable", name } as const;
}

function program(
  steps: RlmV2Program["steps"],
  result: RlmV2Program["result"],
  capabilities: RlmV2Program["capabilities"] = [],
): RlmV2Program {
  return parseRlmV2Program({ version: 2, capabilities, steps, result });
}

describe("RLM v2 admission and expressions", () => {
  test("accepts only stable actor caller identity", () => {
    expect(parseRlmV2Caller(caller())).toEqual(caller());
    expect(() => parseRlmV2Caller({
      ...caller(),
      callerGeneration: 2,
    })).toThrow();
    expect(() => parseRlmV2Caller({
      ...caller(),
      callerThreadId: "thread_provider_incarnation",
    })).toThrow();
  });

  test("accepts only the closed v2 surface and round-trips canonically", () => {
    const admitted = program(
      [{ kind: "let", as: "answer", value: literal(42) }],
      variable("answer"),
    );
    const restarted = parseRlmV2Program(JSON.parse(JSON.stringify(admitted)));
    expect(restarted).toEqual(admitted);
    expect(digestRlmV2Program(restarted)).toBe(digestRlmV2Program(admitted));

    for (const step of [
      { kind: "action", operation: "agent.status", arguments: {} },
      { kind: "return", value: literal(null) },
      { kind: "forEach", items: literal([]), steps: [] },
    ]) {
      expect(safeParseRlmV2Program({
        version: 2,
        capabilities: [],
        steps: [step],
        result: literal(null),
      }).success).toBeFalse();
    }
    for (const operation of [
      "heap.delete",
      "goal.get",
      "goal.checkpoint",
      "goal.requestComplete",
      "harness.evidence",
    ]) {
      expect(safeParseRlmV2Program({
        version: 2,
        capabilities: [],
        steps: [{ kind: "call", as: "x", operation, arguments: {} }],
        result: variable("x"),
      }).success).toBeFalse();
    }
    for (const capability of ["goal.read", "goal.checkpoint", "goal.requestComplete"]) {
      expect(safeParseRlmV2Program({
        version: 2,
        capabilities: [capability],
        steps: [],
        result: literal(null),
      }).success).toBeFalse();
    }
  });

  test("evaluates the complete expression algebra with strict booleans", () => {
    const expression = {
      kind: "object",
      entries: {
        arithmetic: { kind: "add", left: literal(19), right: literal(23) },
        boolean: {
          kind: "and",
          left: { kind: "not", value: literal(false) },
          right: { kind: "or", left: literal(false), right: literal(true) },
        },
        indexed: {
          kind: "index",
          value: { kind: "list", items: [literal("a"), literal("b")] },
          index: literal(1),
        },
        objectIndexed: {
          kind: "index",
          value: literal({ alpha: "selected" }),
          index: literal("alpha"),
        },
        listConcat: {
          kind: "concat",
          left: literal([1, 2]),
          right: literal([3]),
        },
        projected: {
          kind: "field",
          value: { kind: "object", entries: { value: literal("safe") } },
          field: "value",
        },
        text: {
          kind: "concat",
          left: literal("ab"),
          right: literal("🙂"),
        },
        textLength: { kind: "length", value: literal("a🙂") },
        listLength: { kind: "length", value: literal([1, 2, 3]) },
        equal: {
          kind: "equals",
          left: literal({ b: 2, a: 1 }),
          right: literal({ a: 1, b: 2 }),
        },
      },
    } as const;
    const value = evaluateRlmV2Expression(expression, new Map());
    expect(value).toEqual({
      arithmetic: 42,
      boolean: true,
      equal: true,
      indexed: "b",
      listConcat: [1, 2, 3],
      listLength: 3,
      objectIndexed: "selected",
      projected: "safe",
      text: "ab🙂",
      textLength: 2,
    });
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Object.keys(value as Readonly<Record<string, RlmV2JsonValue>>)).toEqual([
      "arithmetic",
      "boolean",
      "equal",
      "indexed",
      "listConcat",
      "listLength",
      "objectIndexed",
      "projected",
      "text",
      "textLength",
    ]);
    expect(canonicalRlmV2Equal({ a: [1, 2], b: true }, { b: true, a: [1, 2] })).toBeTrue();
    expect(() => evaluateRlmV2Expression({
      kind: "and",
      left: literal(1),
      right: literal(true),
    }, new Map())).toThrow("requires a boolean");
  });

  test("rejects duplicate same-frame names, admits child shadowing, and prevents child leakage", async () => {
    expect(() => program([
      { kind: "let", as: "x", value: literal(1) },
      { kind: "let", as: "x", value: literal(2) },
    ], variable("x"))).toThrow("Duplicate RLM binding");

    const shadowing = program([
      { kind: "let", as: "x", value: literal(1) },
      {
        kind: "if",
        as: "selected",
        condition: literal(true),
        then: {
          steps: [{ kind: "let", as: "x", value: literal(2) }],
          result: variable("x"),
        },
        otherwise: { steps: [], result: literal(0) },
      },
    ], {
      kind: "list",
      items: [variable("x"), variable("selected")],
    });
    const outcome = await new RlmV2ReferenceEvaluator({ operations: noOperations }).execute(
      "rlmrun_lexicalfixture01",
      shadowing,
      caller(),
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ state: "succeeded", value: [1, 2] });

    expect(() => program([{
      kind: "if",
      as: "selected",
      condition: literal(true),
      then: {
        steps: [{ kind: "let", as: "privateValue", value: literal(2) }],
        result: variable("privateValue"),
      },
      otherwise: { steps: [], result: literal(0) },
    }], variable("privateValue"))).toThrow("Unknown RLM variable");
  });
});

describe("RLM v2 block execution", () => {
  test("maps in fixed batches, reduces as a strict left fold, and exports only block results", async () => {
    let active = 0;
    let maximumActive = 0;
    const starts: number[] = [];
    const operations: RlmV2OperationPort = {
      invoke: async (_operation, argumentsValue) => {
        const value = argumentsValue.value;
        if (typeof value !== "number") throw new Error("invalid fixture value");
        starts.push(value);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        return String(value * 2);
      },
    };
    const admitted = program([
      {
        kind: "map",
        as: "mapped",
        items: literal([1, 2, 3, 4, 5]),
        item: "item",
        index: "index",
        maxItems: 5,
        concurrency: 2,
        body: {
          steps: [{
            kind: "call",
            as: "doubled",
            operation: "heap.get",
            arguments: { value: variable("item") },
          }],
          result: variable("doubled"),
        },
      },
      {
        kind: "reduce",
        as: "joined",
        items: variable("mapped"),
        initial: literal(""),
        accumulator: "accumulator",
        item: "item",
        index: "index",
        maxItems: 5,
        body: {
          steps: [],
          result: {
            kind: "concat",
            left: variable("accumulator"),
            right: {
              kind: "concat",
              left: literal("/"),
              right: variable("item"),
            },
          },
        },
      },
    ], {
      kind: "object",
      entries: { joined: variable("joined"), mapped: variable("mapped") },
    }, ["heap.read"]);
    const outcome = await new RlmV2ReferenceEvaluator({ operations }).execute(
      "rlmrun_batchfixture001",
      admitted,
      caller(["heap.read"]),
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({
      state: "succeeded",
      value: { joined: "/2/4/6/8/10", mapped: ["2", "4", "6", "8", "10"] },
      fuel: 7,
    });
    expect(starts).toEqual([1, 2, 3, 4, 5]);
    expect(maximumActive).toBe(2);
  });

  test("checks map maxItems before starting child work", async () => {
    let invoked = 0;
    const admitted = program([{
      kind: "map",
      as: "mapped",
      items: literal([1, 2]),
      item: "item",
      index: "index",
      maxItems: 1,
      concurrency: 1,
      body: {
        steps: [{
          kind: "call",
          as: "called",
          operation: "heap.get",
          arguments: {},
        }],
        result: variable("called"),
      },
    }], variable("mapped"), ["heap.read"]);
    const outcome = await new RlmV2ReferenceEvaluator({
      operations: {
        invoke: () => {
          invoked += 1;
          return Promise.resolve(null);
        },
      },
    }).execute(
      "rlmrun_maxitemsfixture",
      admitted,
      caller(["heap.read"]),
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ state: "failed", code: "fuel_exhausted" });
    expect(invoked).toBe(0);
  });

  test("parallel settles its batch and selects the lowest canonical failing path", async () => {
    const completed: string[] = [];
    const admitted = program([{
      kind: "parallel",
      as: "answers",
      concurrency: 2,
      branches: {
        zeta: {
          steps: [{
            kind: "call",
            as: "answer",
            operation: "heap.get",
            arguments: { name: literal("zeta") },
          }],
          result: variable("answer"),
        },
        alpha: {
          steps: [{
            kind: "call",
            as: "answer",
            operation: "heap.get",
            arguments: { name: literal("alpha") },
          }],
          result: variable("answer"),
        },
      },
    }], variable("answers"), ["heap.read"]);
    const outcome = await new RlmV2ReferenceEvaluator({
      operations: {
        invoke: async (_operation, argumentsValue) => {
          const name = argumentsValue.name;
          if (typeof name !== "string") throw new Error("invalid branch name");
          if (name === "alpha") await Promise.resolve();
          completed.push(name);
          throw new Error(name);
        },
      },
    }).execute(
      "rlmrun_parallelfail001",
      admitted,
      caller(["heap.read"]),
      new AbortController().signal,
    );
    expect(completed.sort()).toEqual(["alpha", "zeta"]);
    expect(outcome).toMatchObject({
      state: "failed",
      code: "operation_failed",
      nodePath: [["step", 0], ["parallel", 0], ["step", 0]],
    });
  });
});

describe("RLM v2 receipts and admission fences", () => {
  const receiptProgram = program([
    {
      kind: "call",
      as: "first",
      operation: "heap.get",
      arguments: { value: literal(1) },
    },
    {
      kind: "call",
      as: "second",
      operation: "heap.get",
      arguments: { value: literal(2) },
    },
  ], { kind: "list", items: [variable("first"), variable("second")] }, ["heap.read"]);

  test("replays from the immutable root using path-keyed receipts", async () => {
    const receipts = new MemoryRlmV2ReceiptStore();
    let invoked = 0;
    const operations: RlmV2OperationPort = {
      invoke: (_operation, argumentsValue) => {
        invoked += 1;
        return Promise.resolve(argumentsValue.value);
      },
    };
    const evaluator = new RlmV2ReferenceEvaluator({ operations, receipts });
    const first = await evaluator.execute(
      "rlmrun_receiptreplay01",
      receiptProgram,
      caller(["heap.read"]),
      new AbortController().signal,
    );
    const replay = await evaluator.execute(
      "rlmrun_receiptreplay01",
      receiptProgram,
      caller(["heap.read"]),
      new AbortController().signal,
    );
    expect(first).toMatchObject({ state: "succeeded", recordedReceipts: 2, reusedReceipts: 0 });
    expect(replay).toMatchObject({ state: "succeeded", recordedReceipts: 0, reusedReceipts: 2 });
    expect(invoked).toBe(2);
    expect(receipts.snapshot().map(({ nodePath }) => nodePath)).toContainEqual([["step", 0]]);
    expect(receipts.snapshot().map(({ nodePath }) => nodePath)).toContainEqual([["step", 1]]);
  });

  test("suspends a response-lost operation without recording a receipt", async () => {
    const receipts = new MemoryRlmV2ReceiptStore();
    const admitted = program([{
      kind: "call",
      as: "child",
      operation: "agent.spawn",
      arguments: {},
    }], variable("child"), ["agent.spawn"]);
    const outcome = await new RlmV2ReferenceEvaluator({
      operations: {
        invoke: () => Promise.reject(
          new RlmV2OperationReplayRequiredError(),
        ),
      },
      receipts,
    }).execute(
      "rlmrun_replayrequired1",
      admitted,
      caller(["agent.spawn"]),
      new AbortController().signal,
    );

    expect(outcome).toMatchObject({
      state: "suspended",
      code: "replay_required",
      nodePath: [["step", 0]],
      recordedReceipts: 0,
      reusedReceipts: 0,
    });
    expect(await receipts.read(deriveRlmV2ReceiptId(
      "rlmrun_replayrequired1",
      digestRlmV2Program(admitted),
      [["step", 0]],
    ))).toBeNull();
  });

  test("replays only one admitted target and skips missing parallel siblings", async () => {
    const receipts = new MemoryRlmV2ReceiptStore();
    const calls: RlmV2Operation[] = [];
    const admitted = program([{
      kind: "parallel",
      as: "answers",
      concurrency: 2,
      branches: {
        alpha: {
          steps: [{
            kind: "call",
            as: "missing",
            operation: "heap.get",
            arguments: {},
          }],
          result: variable("missing"),
        },
        beta: {
          steps: [{
            kind: "call",
            as: "target",
            operation: "agent.spawn",
            arguments: {},
          }],
          result: variable("target"),
        },
      },
    }], variable("answers"), ["agent.spawn", "heap.read"]);
    const programRunId = "rlmrun_exactdrain0001";
    const nodePath = [
      ["step", 0],
      ["parallel", 1],
      ["step", 0],
    ] as const;
    const evaluator = new RlmV2ReferenceEvaluator({
      operations: {
        invoke(operation) {
          calls.push(operation);
          return Promise.resolve({ child: true });
        },
      },
      receipts,
      now: () => Date.parse("2040-01-01T00:00:00.000Z"),
    });
    const outcome = await evaluator.replayExactOperation(
      programRunId,
      admitted,
      caller(["agent.spawn", "heap.read"]),
      {
        id: deriveRlmV2ReceiptId(
          programRunId,
          digestRlmV2Program(admitted),
          nodePath,
        ),
        nodePath,
        operation: "agent.spawn",
        requestDigest: emptyRequestDigest("agent.spawn"),
      },
      new AbortController().signal,
    );

    expect(outcome.state).toBe("succeeded");
    expect(calls).toEqual(["agent.spawn"]);
    expect(receipts.snapshot()).toEqual([
      expect.objectContaining({ operation: "agent.spawn", nodePath }),
    ]);
  });

  test("fails closed before invoking when target reconstruction needs a missing receipt", async () => {
    const receipts = new MemoryRlmV2ReceiptStore();
    let calls = 0;
    const admitted = program([
      {
        kind: "call",
        as: "prefix",
        operation: "heap.get",
        arguments: {},
      },
      {
        kind: "call",
        as: "target",
        operation: "agent.spawn",
        arguments: { prefix: variable("prefix") },
      },
    ], variable("target"), ["agent.spawn", "heap.read"]);
    const programRunId = "rlmrun_exactdrain0002";
    const nodePath = [["step", 1]] as const;
    const outcome = await new RlmV2ReferenceEvaluator({
      operations: {
        invoke() {
          calls += 1;
          return Promise.resolve(null);
        },
      },
      receipts,
    }).replayExactOperation(
      programRunId,
      admitted,
      caller(["agent.spawn", "heap.read"]),
      {
        id: deriveRlmV2ReceiptId(
          programRunId,
          digestRlmV2Program(admitted),
          nodePath,
        ),
        nodePath,
        operation: "agent.spawn",
        requestDigest: "f".repeat(64),
      },
      new AbortController().signal,
    );

    expect(outcome).toMatchObject({
      state: "failed",
      code: "receipt_conflict",
      nodePath,
    });
    expect(calls).toBe(0);
    expect(receipts.snapshot()).toEqual([]);
  });

  test("reuses a durable crash prefix and invokes only the missing suffix", async () => {
    const complete = new MemoryRlmV2ReceiptStore();
    await new RlmV2ReferenceEvaluator({
      operations: { invoke: (_operation, argumentsValue) => Promise.resolve(argumentsValue.value) },
      receipts: complete,
    }).execute(
      "rlmrun_crashprefix001",
      receiptProgram,
      caller(["heap.read"]),
      new AbortController().signal,
    );
    const prefix = new MemoryRlmV2ReceiptStore();
    await prefix.record(complete.snapshot().find(({ nodePath }) => nodePath[0]?.[1] === 0)!);
    let invoked = 0;
    const replay = await new RlmV2ReferenceEvaluator({
      operations: {
        invoke: (_operation, argumentsValue) => {
          invoked += 1;
          return Promise.resolve(argumentsValue.value);
        },
      },
      receipts: prefix,
    }).execute(
      "rlmrun_crashprefix001",
      receiptProgram,
      caller(["heap.read"]),
      new AbortController().signal,
    );
    expect(replay).toMatchObject({
      state: "succeeded",
      value: [1, 2],
      reusedReceipts: 1,
      recordedReceipts: 1,
    });
    expect(invoked).toBe(1);
  });

  test("fails closed on a receipt whose request identity conflicts", async () => {
    const digest = digestRlmV2Program(receiptProgram);
    const nodePath = [["step", 0]] as const;
    const id = deriveRlmV2ReceiptId("rlmrun_conflictfixture", digest, nodePath);
    const receipt: RlmV2OperationReceipt = {
      version: 2,
      id,
      programRunId: "rlmrun_conflictfixture",
      programDigest: digest,
      nodePath,
      operation: "heap.get",
      requestDigest: "0".repeat(64),
      result: "attacker",
    };
    const receipts: RlmV2ReceiptPort = {
      read: () => Promise.resolve(receipt),
      record: () => Promise.resolve(),
    };
    const outcome = await new RlmV2ReferenceEvaluator({
      operations: noOperations,
      receipts,
    }).execute(
      "rlmrun_conflictfixture",
      receiptProgram,
      caller(["heap.read"]),
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({
      state: "failed",
      code: "receipt_conflict",
      nodePath,
    });
  });

  test("checks cancellation and deadline before admission and after awaited operations", async () => {
    const singleCall = program([{
      kind: "call",
      as: "answer",
      operation: "heap.get",
      arguments: {},
    }], variable("answer"), ["heap.read"]);
    let invoked = 0;
    const aborted = new AbortController();
    aborted.abort();
    const cancelled = await new RlmV2ReferenceEvaluator({
      operations: {
        invoke: () => {
          invoked += 1;
          return Promise.resolve(null);
        },
      },
    }).execute(
      "rlmrun_cancelledfixture",
      singleCall,
      caller(["heap.read"]),
      aborted.signal,
    );
    expect(cancelled).toMatchObject({ state: "cancelled", code: "cancelled", fuel: 0 });
    expect(invoked).toBe(0);

    let now = Date.parse("2029-01-01T00:00:00.000Z");
    const deadline = "2029-01-01T00:00:01.000Z";
    const afterAwait = await new RlmV2ReferenceEvaluator({
      now: () => now,
      operations: {
        invoke: () => {
          invoked += 1;
          now = Date.parse(deadline);
          return Promise.resolve("late");
        },
      },
    }).execute(
      "rlmrun_deadlinefixture1",
      singleCall,
      caller(["heap.read"], deadline),
      new AbortController().signal,
    );
    expect(afterAwait).toMatchObject({
      state: "failed",
      code: "deadline_exceeded",
      recordedReceipts: 0,
    });
    expect(invoked).toBe(1);
  });

  test("passes stable run, digest, path, and receipt identity to the operation port", async () => {
    let observed: RlmV2OperationContext | null = null;
    let observedArgumentKeys: readonly string[] = [];
    const singleCall = program([{
      kind: "call",
      as: "answer",
      operation: "agent.status",
      arguments: {
        zeta: literal(null),
        handle: literal("agent_fixture0001"),
        alpha: literal(true),
      },
    }], variable("answer"), ["agent.wait"]);
    await new RlmV2ReferenceEvaluator({
      operations: {
        invoke: (_operation, argumentsValue, context) => {
          observed = context;
          observedArgumentKeys = Object.keys(argumentsValue);
          return Promise.resolve(null);
        },
      },
    }).execute(
      "rlmrun_identityfixture1",
      singleCall,
      caller(["agent.wait"]),
      new AbortController().signal,
    );
    expect(observed).not.toBeNull();
    expect(observed!.epochId).toBe("hepoch_rlmv2root0001");
    expect(observed!.actorId).toBe("hactor_rlmv2caller01");
    expect(observed!.turnId).toBe("hturn_rlmv2caller001");
    expect(observed!.programRunId).toBe("rlmrun_identityfixture1");
    expect(observed!.programDigest).toBe(digestRlmV2Program(singleCall));
    expect(observed!.nodePath).toEqual([["step", 0]]);
    expect(observedArgumentKeys).toEqual(["alpha", "handle", "zeta"]);
    expect(observed!.receiptId).toBe(deriveRlmV2ReceiptId(
      "rlmrun_identityfixture1",
      observed!.programDigest,
      [["step", 0]],
    ));
  });
});

function emptyRequestDigest(operation: RlmV2Operation): string {
  const canonical = `{"arguments":{},"operation":"${operation}"}`;
  return createHash("sha256").update(canonical).digest("hex");
}
