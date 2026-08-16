import { expect, test } from "bun:test";
import {
  assertAsyncProperty,
  assertProperty,
  fc,
  propertyParameters,
} from "@hra-internal/test";

import type { RecursiveBudget } from "../src/harness/domain";
import {
  MemoryRlmV2ReceiptStore,
  RLM_V2_MAX_COLLECTION_ITEMS,
  RLM_V2_MAX_FUEL,
  RLM_V2_MAX_VALUE_UTF8_BYTES,
  RlmV2ReferenceEvaluator,
  canonicalRlmV2Equal,
  deriveRlmV2ReceiptId,
  digestRlmV2Program,
  evaluateRlmV2Expression,
  parseRlmV2Program,
  safeParseRlmV2Program,
  type RlmV2Caller,
  type RlmV2JsonValue,
  type RlmV2OperationPort,
  type RlmV2Program,
} from "../src/harness/rlm-v2";

const PROPERTY_TIMEOUT = propertyParameters.interruptAfterTimeLimit + 5_000;
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

function caller(capabilities: RlmV2Caller["capabilities"] = []): RlmV2Caller {
  return {
    epochId: "hepoch_propertyroot01",
    actorId: "hactor_propertycall01",
    turnId: "hturn_propertycall001",
    capabilities,
    admittedFeatures: ["boundedPrograms", "recursiveAgents"],
    semanticWitnessDigests: [],
    budget,
  };
}

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

const noOperations: RlmV2OperationPort = {
  invoke: () => Promise.reject(new Error("unexpected operation")),
};

const safeKey = fc.stringMatching(/^[a-z][a-z0-9]{0,7}$/u);
const jsonLeaf = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer({ min: -10_000, max: 10_000 }),
  fc.string({ maxLength: 24 }),
);
const boundedJson: fc.Arbitrary<RlmV2JsonValue> = fc.letrec((tie) => ({
  value: fc.oneof(
    jsonLeaf,
    fc.array(tie("value"), { maxLength: 4 }),
    fc.dictionary(safeKey, tie("value"), { maxKeys: 4 }),
  ),
})).value as fc.Arbitrary<RlmV2JsonValue>;

test("RLM v2 parser is total for arbitrary foreign values", () => {
  assertProperty(fc.property(
    fc.anything({ withBigInt: true, withMap: true, withSet: true }),
    (value) => {
      expect(() => safeParseRlmV2Program(value)).not.toThrow();
    },
  ));
});

test("RLM v2 valid JSON programs survive serialization with one canonical digest", () => {
  assertProperty(fc.property(boundedJson, (value) => {
    const admitted = program([], literal(value));
    const restarted = parseRlmV2Program(JSON.parse(JSON.stringify(admitted)));
    expect(restarted).toEqual(admitted);
    expect(digestRlmV2Program(restarted)).toBe(digestRlmV2Program(admitted));
  }));
});

test("canonical equality ignores object insertion order and preserves array order", () => {
  assertProperty(fc.property(
    fc.dictionary(safeKey, jsonLeaf, { maxKeys: 12 }),
    (record) => {
      const reversed = Object.fromEntries(Object.entries(record).reverse());
      expect(canonicalRlmV2Equal(record, reversed)).toBeTrue();
      expect(canonicalRlmV2Equal([record, 0], [0, record])).toBeFalse();
    },
  ));
});

test("expression object construction always removes prototypes", () => {
  assertProperty(fc.property(
    fc.dictionary(safeKey, jsonLeaf, { maxKeys: 12 }),
    (record) => {
      const entries = Object.fromEntries(Object.entries(record).map(([key, value]) => [
        key,
        literal(value),
      ]));
      const evaluated = evaluateRlmV2Expression({ kind: "object", entries }, new Map());
      expect(Object.getPrototypeOf(evaluated)).toBeNull();
      expect(evaluated).toEqual(record);
    },
  ));
});

test("prototype-sensitive keys are rejected at every JSON boundary", () => {
  assertProperty(fc.property(
    fc.constantFrom("__proto__", "constructor", "prototype"),
    jsonLeaf,
    (key, value) => {
      const hostile: unknown = JSON.parse(`{"${key}":${JSON.stringify(value)}}`);
      expect(safeParseRlmV2Program({
        version: 2,
        capabilities: [],
        steps: [],
        result: { kind: "literal", value: hostile },
      }).success).toBeFalse();
      expect(() => evaluateRlmV2Expression({
        kind: "field",
        value: literal({ safe: true }),
        field: key,
      }, new Map())).toThrow();
    },
  ));
});

test("alpha-renaming bindings leaves lexical results invariant", async () => {
  await assertAsyncProperty(fc.asyncProperty(
    fc.integer({ min: -1_000, max: 1_000 }),
    fc.integer({ min: -1_000, max: 1_000 }),
    async (left, right) => {
      const make = (leftName: string, rightName: string) => program([
        { kind: "let", as: leftName, value: literal(left) },
        { kind: "let", as: rightName, value: literal(right) },
      ], { kind: "add", left: variable(leftName), right: variable(rightName) });
      const evaluator = new RlmV2ReferenceEvaluator({ operations: noOperations });
      const first = await evaluator.execute(
        "rlmrun_alphafirst0001",
        make("left", "right"),
        caller(),
        new AbortController().signal,
      );
      const renamed = await evaluator.execute(
        "rlmrun_alphasecond001",
        make("a", "b"),
        caller(),
        new AbortController().signal,
      );
      expect(first).toMatchObject({ state: "succeeded", value: left + right });
      expect(renamed).toMatchObject({ state: "succeeded", value: left + right });
    },
  ));
}, PROPERTY_TIMEOUT);

test("child shadowing never mutates the immutable parent frame", async () => {
  await assertAsyncProperty(fc.asyncProperty(
    jsonLeaf,
    jsonLeaf,
    async (parentValue, childValue) => {
      const admitted = program([
        { kind: "let", as: "value", value: literal(parentValue) },
        {
          kind: "if",
          as: "child",
          condition: literal(true),
          then: {
            steps: [{ kind: "let", as: "value", value: literal(childValue) }],
            result: variable("value"),
          },
          otherwise: { steps: [], result: literal(null) },
        },
      ], { kind: "list", items: [variable("value"), variable("child")] });
      const outcome = await new RlmV2ReferenceEvaluator({ operations: noOperations }).execute(
        "rlmrun_shadowproperty1",
        admitted,
        caller(),
        new AbortController().signal,
      );
      expect(outcome).toMatchObject({ state: "succeeded", value: [parentValue, childValue] });
    },
  ));
}, PROPERTY_TIMEOUT);

test("map results and typed paths are invariant across allowed concurrency", async () => {
  await assertAsyncProperty(fc.asyncProperty(
    fc.array(fc.integer({ min: -100, max: 100 }), { maxLength: 12 }),
    fc.integer({ min: 1, max: 8 }),
    fc.integer({ min: 1, max: 8 }),
    async (values, firstConcurrency, secondConcurrency) => {
      const make = (concurrency: number) => program([{
        kind: "map",
        as: "mapped",
        items: literal(values),
        item: "item",
        index: "index",
        maxItems: values.length,
        concurrency,
        body: {
          steps: [{
            kind: "let",
            as: "incremented",
            value: { kind: "add", left: variable("item"), right: literal(1) },
          }],
          result: variable("incremented"),
        },
      }], variable("mapped"));
      const evaluator = new RlmV2ReferenceEvaluator({ operations: noOperations });
      const first = await evaluator.execute(
        "rlmrun_mapconcurrency1",
        make(firstConcurrency),
        caller(),
        new AbortController().signal,
      );
      const second = await evaluator.execute(
        "rlmrun_mapconcurrency2",
        make(secondConcurrency),
        caller(),
        new AbortController().signal,
      );
      const expected = values.map((value) => value + 1);
      expect(first).toMatchObject({ state: "succeeded", value: expected, fuel: 1 + values.length });
      expect(second).toMatchObject({ state: "succeeded", value: expected, fuel: 1 + values.length });
    },
  ));
}, PROPERTY_TIMEOUT);

test("reduce is a strict left fold for every admitted list", async () => {
  await assertAsyncProperty(fc.asyncProperty(
    fc.array(fc.string({ maxLength: 8 }), { maxLength: 12 }),
    async (values) => {
      const admitted = program([{
        kind: "reduce",
        as: "folded",
        items: literal(values),
        initial: literal("seed"),
        accumulator: "acc",
        item: "item",
        index: "index",
        maxItems: values.length,
        body: {
          steps: [],
          result: {
            kind: "concat",
            left: { kind: "concat", left: variable("acc"), right: literal("|") },
            right: variable("item"),
          },
        },
      }], variable("folded"));
      const outcome = await new RlmV2ReferenceEvaluator({ operations: noOperations }).execute(
        "rlmrun_reduceproperty1",
        admitted,
        caller(),
        new AbortController().signal,
      );
      expect(outcome).toMatchObject({
        state: "succeeded",
        value: values.reduce((accumulator, item) => `${accumulator}|${item}`, "seed"),
      });
    },
  ));
}, PROPERTY_TIMEOUT);

test("parallel results use lexicographic keys independent of declaration and concurrency", async () => {
  await assertAsyncProperty(fc.asyncProperty(
    fc.array(fc.integer({ min: -100, max: 100 }), { minLength: 1, maxLength: 8 }),
    fc.integer({ min: 1, max: 8 }),
    async (values, concurrency) => {
      const entries = values.map((value, index) => [
        `branch${String(index).padStart(2, "0")}`,
        { steps: [], result: literal(value) },
      ] as const).reverse();
      const admitted = program([{
        kind: "parallel",
        as: "joined",
        concurrency,
        branches: Object.fromEntries(entries),
      }], variable("joined"));
      const outcome = await new RlmV2ReferenceEvaluator({ operations: noOperations }).execute(
        "rlmrun_parallelproperty",
        admitted,
        caller(),
        new AbortController().signal,
      );
      expect(outcome.state).toBe("succeeded");
      if (outcome.state === "succeeded") {
        expect(Object.keys(outcome.value as Record<string, RlmV2JsonValue>)).toEqual(
          values.map((_value, index) => `branch${String(index).padStart(2, "0")}`),
        );
        expect(Object.values(outcome.value as Record<string, RlmV2JsonValue>)).toEqual(values);
      }
    },
  ));
}, PROPERTY_TIMEOUT);

test("receipt replay invokes each structural call once across repeated root evaluation", async () => {
  await assertAsyncProperty(fc.asyncProperty(
    fc.array(fc.integer({ min: -100, max: 100 }), { maxLength: 10 }),
    async (values) => {
      const admitted = callMapProgram(values);
      const receipts = new MemoryRlmV2ReceiptStore();
      let invocations = 0;
      const evaluator = new RlmV2ReferenceEvaluator({
        receipts,
        operations: {
          invoke: (_operation, argumentsValue) => {
            invocations += 1;
            return Promise.resolve(argumentsValue.value);
          },
        },
      });
      const first = await evaluator.execute(
        "rlmrun_replayproperty1",
        admitted,
        caller(["heap.read"]),
        new AbortController().signal,
      );
      const replay = await evaluator.execute(
        "rlmrun_replayproperty1",
        admitted,
        caller(["heap.read"]),
        new AbortController().signal,
      );
      expect(first).toMatchObject({ state: "succeeded", value: values, recordedReceipts: values.length });
      expect(replay).toMatchObject({ state: "succeeded", value: values, reusedReceipts: values.length });
      expect(invocations).toBe(values.length);
    },
  ), { numRuns: 100 });
}, PROPERTY_TIMEOUT);

test("every durable crash-prefix receipt is reused and only its suffix is invoked", async () => {
  await assertAsyncProperty(fc.asyncProperty(
    fc.array(fc.integer({ min: -100, max: 100 }), { minLength: 1, maxLength: 8 }),
    fc.nat({ max: 100 }),
    async (values, prefixSeed) => {
      const admitted = callMapProgram(values);
      const full = new MemoryRlmV2ReceiptStore();
      await new RlmV2ReferenceEvaluator({
        receipts: full,
        operations: {
          invoke: (_operation, argumentsValue) => Promise.resolve(argumentsValue.value),
        },
      }).execute(
        "rlmrun_crashproperty01",
        admitted,
        caller(["heap.read"]),
        new AbortController().signal,
      );
      const prefixLength = prefixSeed % (values.length + 1);
      const ordered = [...full.snapshot()].sort(
        (left, right) => left.nodePath[1]![1] - right.nodePath[1]![1],
      );
      const partial = new MemoryRlmV2ReceiptStore();
      for (const receipt of ordered.slice(0, prefixLength)) await partial.record(receipt);
      let invocations = 0;
      const replay = await new RlmV2ReferenceEvaluator({
        receipts: partial,
        operations: {
          invoke: (_operation, argumentsValue) => {
            invocations += 1;
            return Promise.resolve(argumentsValue.value);
          },
        },
      }).execute(
        "rlmrun_crashproperty01",
        admitted,
        caller(["heap.read"]),
        new AbortController().signal,
      );
      expect(replay).toMatchObject({
        state: "succeeded",
        value: values,
        reusedReceipts: prefixLength,
        recordedReceipts: values.length - prefixLength,
      });
      expect(invocations).toBe(values.length - prefixLength);
    },
  ), { numRuns: 100 });
}, PROPERTY_TIMEOUT);

test("receipt coordinates are stable for one node and distinct for distinct typed paths", () => {
  assertProperty(fc.property(
    fc.integer({ min: 0, max: 31 }),
    fc.integer({ min: 0, max: 31 }),
    (leftIndex, rightIndex) => {
      const digest = "a".repeat(64);
      const leftPath = [["step", 0], ["map", leftIndex]] as const;
      const rightPath = [["step", 0], ["map", rightIndex]] as const;
      const first = deriveRlmV2ReceiptId("rlmrun_pathproperty001", digest, leftPath);
      expect(deriveRlmV2ReceiptId("rlmrun_pathproperty001", digest, leftPath)).toBe(first);
      expect(deriveRlmV2ReceiptId("rlmrun_pathproperty001", digest, rightPath) === first)
        .toBe(rightIndex === leftIndex);
    },
  ));
});

test("stop admission never invokes an operation after an already-observed abort", async () => {
  await assertAsyncProperty(fc.asyncProperty(fc.boolean(), async (abort) => {
    let invocations = 0;
    const admitted = program([{
      kind: "call",
      as: "answer",
      operation: "heap.get",
      arguments: {},
    }], variable("answer"), ["heap.read"]);
    const controller = new AbortController();
    if (abort) controller.abort();
    const outcome = await new RlmV2ReferenceEvaluator({
      operations: {
        invoke: () => {
          invocations += 1;
          return Promise.resolve(null);
        },
      },
    }).execute(
      "rlmrun_stopproperty001",
      admitted,
      caller(["heap.read"]),
      controller.signal,
    );
    expect(invocations).toBe(abort ? 0 : 1);
    expect(outcome.state).toBe(abort ? "cancelled" : "succeeded");
  }));
}, PROPERTY_TIMEOUT);

test("deadline admission is monotone and never starts work at or beyond the bound", async () => {
  await assertAsyncProperty(fc.asyncProperty(
    fc.integer({ min: -1_000, max: 1_000 }),
    async (offsetMs) => {
      const deadlineMs = Date.parse("2029-01-01T00:00:00.000Z");
      let invocations = 0;
      const admitted = program([{
        kind: "call",
        as: "answer",
        operation: "heap.get",
        arguments: {},
      }], variable("answer"), ["heap.read"]);
      const outcome = await new RlmV2ReferenceEvaluator({
        now: () => deadlineMs + offsetMs,
        operations: {
          invoke: () => {
            invocations += 1;
            return Promise.resolve(null);
          },
        },
      }).execute(
        "rlmrun_deadlineproperty",
        admitted,
        { ...caller(["heap.read"]), budget: { ...budget, deadline: new Date(deadlineMs).toISOString() } },
        new AbortController().signal,
      );
      expect(invocations).toBe(offsetMs < 0 ? 1 : 0);
      expect(outcome.state).toBe(offsetMs < 0 ? "succeeded" : "failed");
      if (offsetMs >= 0) expect(outcome).toMatchObject({ code: "deadline_exceeded", fuel: 0 });
    },
  ));
}, PROPERTY_TIMEOUT);

test("structural admission enforces nesting, values, collections, and worst-case fuel", () => {
  let nested: RlmV2Program["result"] = literal(null);
  for (let index = 0; index < 9; index += 1) nested = { kind: "list", items: [nested] };
  expect(() => program([], nested)).toThrow("expression exceeds its nesting limit");

  expect(() => program([], literal("x".repeat(RLM_V2_MAX_VALUE_UTF8_BYTES)))).toThrow(
    "value exceeds its byte limit",
  );
  expect(() => program([], literal(new Array(RLM_V2_MAX_COLLECTION_ITEMS + 1).fill(null)))).toThrow();

  const sourceChunk = "s".repeat(180 * 1024);
  expect(() => program([
    { kind: "let", as: "first", value: literal(sourceChunk) },
    { kind: "let", as: "second", value: literal(sourceChunk) },
    { kind: "let", as: "third", value: literal(sourceChunk) },
  ], literal(null))).toThrow("source byte limit");

  for (const concurrency of [0, 9]) {
    expect(() => program([{
      kind: "map",
      as: "mapped",
      items: literal([]),
      item: "item",
      index: "index",
      maxItems: 0,
      concurrency,
      body: { steps: [], result: literal(null) },
    }], variable("mapped"))).toThrow();
  }

  const tooManyBranches = Object.fromEntries(
    Array.from({ length: 9 }, (_value, index) => [
      `branch${index}`,
      { steps: [], result: literal(index) },
    ]),
  );
  expect(() => program([{
    kind: "parallel",
    as: "joined",
    concurrency: 8,
    branches: tooManyBranches,
  }], variable("joined"))).toThrow("one to eight branches");

  const bodySteps = Array.from({ length: RLM_V2_MAX_COLLECTION_ITEMS }, (_value, index) => ({
    kind: "let" as const,
    as: `value${index}`,
    value: literal(index),
  }));
  expect(() => program([{
    kind: "map",
    as: "mapped",
    items: literal([]),
    item: "item",
    index: "index",
    maxItems: RLM_V2_MAX_COLLECTION_ITEMS,
    concurrency: 1,
    body: { steps: bodySteps, result: literal(null) },
  }], variable("mapped"))).toThrow("worst-case fuel");
  expect(1 + RLM_V2_MAX_COLLECTION_ITEMS * bodySteps.length).toBeGreaterThan(RLM_V2_MAX_FUEL);
});

test("same-frame duplicate admission is independent of the duplicated name", () => {
  assertProperty(fc.property(safeKey, (name) => {
    expect(() => program([
      { kind: "let", as: name, value: literal(1) },
      { kind: "let", as: name, value: literal(2) },
    ], variable(name))).toThrow("Duplicate RLM binding");
  }));
});

function callMapProgram(values: readonly number[]): RlmV2Program {
  return program([{
    kind: "map",
    as: "mapped",
    items: literal(values),
    item: "item",
    index: "index",
    maxItems: values.length,
    concurrency: 3,
    body: {
      steps: [{
        kind: "call",
        as: "echoed",
        operation: "heap.get",
        arguments: { value: variable("item") },
      }],
      result: variable("echoed"),
    },
  }], variable("mapped"), ["heap.read"]);
}
