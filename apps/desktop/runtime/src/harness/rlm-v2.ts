import { createHash } from "node:crypto";

import { z } from "@hra-internal/schema";

import {
  actorEpochIdSchema,
  actorIdSchema,
  actorTurnIdSchema,
} from "./actor-domain";
import {
  HARNESS_MAX_PROGRAM_BRANCHES,
  HARNESS_MAX_PROGRAM_ITERATIONS,
  programOperationIdSchema,
  programRunIdSchema,
  recursiveBudgetSchema,
  type RecursiveBudget,
} from "./domain";
import { harnessFeatureSchema, type HarnessFeature } from "./semantic-gate";

export const RLM_V2_PROGRAM_VERSION = 2 as const;
export const RLM_V2_MAX_SOURCE_UTF8_BYTES = 512 * 1024;
export const RLM_V2_MAX_VALUE_UTF8_BYTES = 256 * 1024;
export const RLM_V2_MAX_NESTING = 8;
export const RLM_V2_MAX_COLLECTION_ITEMS = 32;
export const RLM_V2_MAX_CONCURRENCY = 8;
export const RLM_V2_MAX_FUEL = 1_024;

export type RlmV2JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly RlmV2JsonValue[]
  | Readonly<{ readonly [key: string]: RlmV2JsonValue }>;

type ProgramJsonValue = RlmV2JsonValue;

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const PATH_KIND_ORDER = {
  step: 0,
  if: 1,
  map: 2,
  reduce: 3,
  parallel: 4,
} as const;

const nameSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
  .refine((name) => !FORBIDDEN_KEYS.has(name), "RLM binding name is prototype-sensitive");
const keySchema = z.string()
  .min(1)
  .max(128)
  .refine((name) => !FORBIDDEN_KEYS.has(name), "RLM object key is prototype-sensitive")
  .refine(
    (name) => !isCanonicalArrayIndexKey(name),
    "RLM object keys may not use array-index spelling",
  );

export const rlmV2CapabilitySchema = z.enum([
  "context.read",
  "context.materialize",
  "heap.read",
  "heap.write",
  "agent.spawn",
  "agent.message",
  "agent.wait",
  "agent.cancel",
  "harness.propose",
]);

export type RlmV2Capability = z.infer<typeof rlmV2CapabilitySchema>;

export interface RlmV2Caller {
  /** Durable identity. Provider thread IDs and generations are deliberately absent. */
  readonly epochId: string;
  readonly actorId: string;
  readonly turnId: string;
  readonly capabilities: readonly RlmV2Capability[];
  readonly admittedFeatures: readonly HarnessFeature[];
  readonly semanticWitnessDigests: readonly string[];
  readonly budget: RecursiveBudget;
}

export const rlmV2OperationSchema = z.enum([
  "context.snapshot",
  "context.search",
  "context.slice",
  "context.materialize",
  "heap.put",
  "heap.get",
  "heap.list",
  "agent.spawn",
  "agent.send",
  "agent.status",
  "agent.waitAny",
  "agent.waitAll",
  "agent.result",
  "agent.cancel",
  "harness.propose",
]);

export type RlmV2Operation = z.infer<typeof rlmV2OperationSchema>;

export type RlmV2Expression =
  | Readonly<{ readonly kind: "literal"; readonly value: ProgramJsonValue }>
  | Readonly<{ readonly kind: "variable"; readonly name: string }>
  | Readonly<{ readonly kind: "list"; readonly items: readonly RlmV2Expression[] }>
  | Readonly<{
      readonly kind: "object";
      readonly entries: Readonly<Record<string, RlmV2Expression>>;
    }>
  | Readonly<{
      readonly kind: "field";
      readonly value: RlmV2Expression;
      readonly field: string;
    }>
  | Readonly<{
      readonly kind: "index";
      readonly value: RlmV2Expression;
      readonly index: RlmV2Expression;
    }>
  | Readonly<{
      readonly kind: "equals";
      readonly left: RlmV2Expression;
      readonly right: RlmV2Expression;
    }>
  | Readonly<{ readonly kind: "not"; readonly value: RlmV2Expression }>
  | Readonly<{
      readonly kind: "and" | "or" | "add" | "concat";
      readonly left: RlmV2Expression;
      readonly right: RlmV2Expression;
    }>
  | Readonly<{ readonly kind: "length"; readonly value: RlmV2Expression }>;

export interface RlmV2Block {
  readonly steps: readonly RlmV2Step[];
  readonly result: RlmV2Expression;
}

export type RlmV2Step =
  | Readonly<{
      readonly kind: "let";
      readonly as: string;
      readonly value: RlmV2Expression;
    }>
  | Readonly<{
      readonly kind: "call";
      readonly as: string;
      readonly operation: RlmV2Operation;
      readonly arguments: Readonly<Record<string, RlmV2Expression>>;
    }>
  | Readonly<{
      readonly kind: "if";
      readonly as: string;
      readonly condition: RlmV2Expression;
      readonly then: RlmV2Block;
      readonly otherwise: RlmV2Block;
    }>
  | Readonly<{
      readonly kind: "map";
      readonly as: string;
      readonly items: RlmV2Expression;
      readonly item: string;
      readonly index: string;
      readonly maxItems: number;
      readonly concurrency: number;
      readonly body: RlmV2Block;
    }>
  | Readonly<{
      readonly kind: "reduce";
      readonly as: string;
      readonly items: RlmV2Expression;
      readonly initial: RlmV2Expression;
      readonly accumulator: string;
      readonly item: string;
      readonly index: string;
      readonly maxItems: number;
      readonly body: RlmV2Block;
    }>
  | Readonly<{
      readonly kind: "parallel";
      readonly as: string;
      readonly concurrency: number;
      readonly branches: Readonly<Record<string, RlmV2Block>>;
    }>;

export interface RlmV2Program extends RlmV2Block {
  readonly version: typeof RLM_V2_PROGRAM_VERSION;
  readonly capabilities: readonly z.infer<typeof rlmV2CapabilitySchema>[];
}

const jsonValueSchema: z.ZodType<ProgramJsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite().safe(),
  z.string(),
  z.array(jsonValueSchema).max(RLM_V2_MAX_COLLECTION_ITEMS),
  z.record(keySchema, jsonValueSchema).superRefine((value, context) => {
    if (Object.keys(value).length > RLM_V2_MAX_COLLECTION_ITEMS) {
      context.addIssue({ code: "custom", message: "RLM object exceeds its collection limit" });
    }
  }),
]));

const expressionSchema: z.ZodType<RlmV2Expression> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("literal"), value: jsonValueSchema }).strict(),
    z.object({ kind: z.literal("variable"), name: nameSchema }).strict(),
    z.object({
      kind: z.literal("list"),
      items: z.array(expressionSchema).max(RLM_V2_MAX_COLLECTION_ITEMS),
    }).strict(),
    z.object({
      kind: z.literal("object"),
      entries: z.record(keySchema, expressionSchema).superRefine((value, context) => {
        if (Object.keys(value).length > RLM_V2_MAX_COLLECTION_ITEMS) {
          context.addIssue({ code: "custom", message: "RLM object expression exceeds its collection limit" });
        }
      }),
    }).strict(),
    z.object({
      kind: z.literal("field"),
      value: expressionSchema,
      field: keySchema,
    }).strict(),
    z.object({
      kind: z.literal("index"),
      value: expressionSchema,
      index: expressionSchema,
    }).strict(),
    ...(["equals", "and", "or", "add", "concat"] as const).map((kind) =>
      z.object({
        kind: z.literal(kind),
        left: expressionSchema,
        right: expressionSchema,
      }).strict()
    ),
    z.object({ kind: z.literal("not"), value: expressionSchema }).strict(),
    z.object({ kind: z.literal("length"), value: expressionSchema }).strict(),
  ])
);

const blockSchema: z.ZodType<RlmV2Block> = z.lazy(() => z.object({
  steps: z.array(stepSchema).max(RLM_V2_MAX_COLLECTION_ITEMS),
  result: expressionSchema,
}).strict());

const stepSchema: z.ZodType<RlmV2Step> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("let"), as: nameSchema, value: expressionSchema }).strict(),
    z.object({
      kind: z.literal("call"),
      as: nameSchema,
      operation: rlmV2OperationSchema,
      arguments: z.record(keySchema, expressionSchema).superRefine((value, context) => {
        if (Object.keys(value).length > RLM_V2_MAX_COLLECTION_ITEMS) {
          context.addIssue({ code: "custom", message: "RLM call exceeds its argument limit" });
        }
      }),
    }).strict(),
    z.object({
      kind: z.literal("if"),
      as: nameSchema,
      condition: expressionSchema,
      then: blockSchema,
      otherwise: blockSchema,
    }).strict(),
    z.object({
      kind: z.literal("map"),
      as: nameSchema,
      items: expressionSchema,
      item: nameSchema,
      index: nameSchema,
      maxItems: z.number().int().min(0).max(HARNESS_MAX_PROGRAM_ITERATIONS),
      concurrency: z.number().int().min(1).max(RLM_V2_MAX_CONCURRENCY),
      body: blockSchema,
    }).strict(),
    z.object({
      kind: z.literal("reduce"),
      as: nameSchema,
      items: expressionSchema,
      initial: expressionSchema,
      accumulator: nameSchema,
      item: nameSchema,
      index: nameSchema,
      maxItems: z.number().int().min(0).max(HARNESS_MAX_PROGRAM_ITERATIONS),
      body: blockSchema,
    }).strict(),
    z.object({
      kind: z.literal("parallel"),
      as: nameSchema,
      concurrency: z.number().int().min(1).max(RLM_V2_MAX_CONCURRENCY),
      branches: z.record(nameSchema, blockSchema).superRefine((value, context) => {
        const count = Object.keys(value).length;
        if (count < 1 || count > HARNESS_MAX_PROGRAM_BRANCHES) {
          context.addIssue({ code: "custom", message: "RLM parallel requires one to eight branches" });
        }
      }),
    }).strict(),
  ])
);

const rawProgramSchema: z.ZodType<RlmV2Program> = z.object({
  version: z.literal(RLM_V2_PROGRAM_VERSION),
  capabilities: z.array(rlmV2CapabilitySchema).max(10),
  steps: z.array(stepSchema).max(RLM_V2_MAX_COLLECTION_ITEMS),
  result: expressionSchema,
}).strict();

const rlmV2CallerSchema: z.ZodType<RlmV2Caller> = z.object({
  epochId: actorEpochIdSchema,
  actorId: actorIdSchema,
  turnId: actorTurnIdSchema,
  capabilities: z.array(rlmV2CapabilitySchema).max(10).refine(
    (capabilities) => new Set(capabilities).size === capabilities.length,
    "RLM v2 caller capabilities must be unique",
  ),
  admittedFeatures: z.array(harnessFeatureSchema).min(1).max(6).refine(
    (features) => features.includes("boundedPrograms") &&
      new Set(features).size === features.length,
    "RLM v2 caller features must be unique and include boundedPrograms",
  ),
  semanticWitnessDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(32).refine(
    (digests) => new Set(digests).size === digests.length,
    "RLM v2 caller semantic witnesses must be unique",
  ),
  budget: recursiveBudgetSchema,
}).strict();

export type RlmV2PathSegment = readonly [
  "step" | "if" | "map" | "reduce" | "parallel",
  number,
];
export type RlmV2NodePath = readonly RlmV2PathSegment[];

export const rlmV2PathSegmentSchema: z.ZodType<RlmV2PathSegment> = z.tuple([
  z.enum(["step", "if", "map", "reduce", "parallel"]),
  z.number().int().nonnegative().max(RLM_V2_MAX_FUEL),
]);
export const rlmV2NodePathSchema: z.ZodType<RlmV2NodePath> = z.array(rlmV2PathSegmentSchema)
  .min(1)
  .max(RLM_V2_MAX_NESTING * 2 + 1);

/**
 * Decrypted logical replay value at the evaluator boundary. Durable adapters
 * must seal `result` in the encrypted value store and keep only its opaque
 * handle plus the content-free identity fields in the SQLite evidence ledger.
 */
export interface RlmV2OperationReceipt {
  readonly version: typeof RLM_V2_PROGRAM_VERSION;
  readonly id: string;
  readonly programRunId: string;
  readonly programDigest: string;
  readonly nodePath: RlmV2NodePath;
  readonly operation: RlmV2Operation;
  readonly requestDigest: string;
  readonly result: ProgramJsonValue;
}

export const rlmV2OperationReceiptSchema: z.ZodType<RlmV2OperationReceipt> = z.object({
  version: z.literal(RLM_V2_PROGRAM_VERSION),
  id: programOperationIdSchema,
  programRunId: programRunIdSchema,
  programDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  nodePath: rlmV2NodePathSchema,
  operation: rlmV2OperationSchema,
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  result: jsonValueSchema,
}).strict().superRefine((receipt, context) => {
  if (Buffer.byteLength(canonicalJson(receipt.result), "utf8") > RLM_V2_MAX_VALUE_UTF8_BYTES) {
    context.addIssue({
      code: "custom",
      message: "RLM receipt result exceeds its value byte limit",
      path: ["result"],
    });
  }
  if (receipt.id !== deriveRlmV2ReceiptId(
    receipt.programRunId,
    receipt.programDigest,
    receipt.nodePath,
  )) {
    context.addIssue({
      code: "custom",
      message: "RLM receipt ID does not match its structural coordinate",
      path: ["id"],
    });
  }
});

export interface RlmV2ReceiptPort {
  /** Returns a rehydrated logical receipt; null is the only absence marker. */
  read(receiptId: string): Promise<unknown>;
  /**
   * Must accept an exact replay and reject a conflicting immutable record.
   * It must never persist the plaintext result in the content-free ledger.
   */
  record(receipt: RlmV2OperationReceipt): Promise<void>;
}

export interface RlmV2OperationContext extends RlmV2Caller {
  readonly programRunId: string;
  readonly programDigest: string;
  readonly receiptId: string;
  readonly nodePath: RlmV2NodePath;
  readonly signal: AbortSignal;
}

export interface RlmV2OperationPort {
  /** Implementations reconcile or idempotently apply the stable receipt ID. */
  invoke(
    operation: RlmV2Operation,
    argumentsValue: Readonly<Record<string, ProgramJsonValue>>,
    context: RlmV2OperationContext,
  ): Promise<unknown>;
}

/**
 * Content-free authority for one already-admitted operation whose external
 * result is uncertain. The durable receipt ledger is the source of this
 * target; callers must not synthesize targets from model output.
 */
export interface RlmV2OperationReplayTarget {
  readonly id: string;
  readonly nodePath: RlmV2NodePath;
  readonly operation: RlmV2Operation;
  readonly requestDigest: string;
}

const rlmV2OperationReplayTargetSchema: z.ZodType<RlmV2OperationReplayTarget> =
  z.object({
    id: programOperationIdSchema,
    nodePath: rlmV2NodePathSchema,
    operation: rlmV2OperationSchema,
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict();

/**
 * A reconciled external mutation has durable evidence, but its provider reply
 * is not yet definitive. This marker is intentionally content-free so the
 * evaluator can suspend and replay the same receipt instead of converting the
 * response loss into a permanent program failure.
 */
export class RlmV2OperationReplayRequiredError extends Error {
  readonly code = "replay_required" as const;

  constructor() {
    super("RLM external operation requires durable replay");
    this.name = "RlmV2OperationReplayRequiredError";
  }
}

export type RlmV2FailureCode =
  | "cancelled"
  | "deadline_exceeded"
  | "fuel_exhausted"
  | "evaluation_failed"
  | "operation_failed"
  | "replay_required"
  | "receipt_conflict";

export type RlmV2ExecutionOutcome =
  | Readonly<{
      readonly state: "succeeded";
      readonly value: ProgramJsonValue;
      readonly fuel: number;
      readonly reusedReceipts: number;
      readonly recordedReceipts: number;
    }>
  | Readonly<{
      readonly state: "failed" | "cancelled" | "suspended";
      readonly code: RlmV2FailureCode;
      readonly nodePath: RlmV2NodePath | null;
      readonly fuel: number;
      readonly reusedReceipts: number;
      readonly recordedReceipts: number;
    }>;

class RlmV2Fault extends Error {
  readonly code: RlmV2FailureCode;
  readonly nodePath: RlmV2NodePath | null;

  constructor(code: RlmV2FailureCode, message: string, nodePath: RlmV2NodePath | null) {
    super(message);
    this.name = "RlmV2Fault";
    this.code = code;
    this.nodePath = nodePath;
  }
}

class LexicalFrame {
  readonly #parent: LexicalFrame | null;
  readonly #local: ReadonlyMap<string, ProgramJsonValue>;

  constructor(
    parent: LexicalFrame | null = null,
    local: ReadonlyMap<string, ProgramJsonValue> = new Map(),
  ) {
    this.#parent = parent;
    this.#local = local;
  }

  child(bindings: Readonly<Record<string, ProgramJsonValue>> = nullPrototypeRecord([])): LexicalFrame {
    return new LexicalFrame(this, new Map(sortedEntries(bindings)));
  }

  define(name: string, value: ProgramJsonValue): LexicalFrame {
    if (this.#local.has(name)) throw new Error(`Duplicate RLM binding in one frame: ${name}`);
    const next = new Map(this.#local);
    next.set(name, value);
    return new LexicalFrame(this.#parent, next);
  }

  get(name: string): ProgramJsonValue {
    if (this.#local.has(name)) return this.#local.get(name)!;
    if (this.#parent !== null) return this.#parent.get(name);
    throw new Error(`Unknown RLM variable: ${name}`);
  }
}

interface Inspection {
  readonly capabilities: ReadonlySet<string>;
  readonly worstCaseFuel: number;
}

interface ExecutionState {
  readonly caller: RlmV2Caller;
  readonly programRunId: string;
  readonly programDigest: string;
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
  readonly enforceDeadline: boolean;
  readonly replayTarget: RlmV2OperationReplayTarget | null;
  readonly executedPaths: Set<string>;
  replayTargetReached: boolean;
  reusedReceipts: number;
  recordedReceipts: number;
}

export class RlmV2ReferenceEvaluator {
  readonly #operations: RlmV2OperationPort;
  readonly #receipts: RlmV2ReceiptPort;
  readonly #now: () => number;

  constructor(input: Readonly<{
    operations: RlmV2OperationPort;
    receipts?: RlmV2ReceiptPort;
    now?: () => number;
  }>) {
    this.#operations = input.operations;
    this.#receipts = input.receipts ?? new MemoryRlmV2ReceiptStore();
    this.#now = input.now ?? Date.now;
  }

  async execute(
    programRunIdValue: string,
    programValue: unknown,
    callerValue: unknown,
    signal: AbortSignal,
  ): Promise<RlmV2ExecutionOutcome> {
    const programRunId = programRunIdSchema.parse(programRunIdValue);
    const program = parseRlmV2Program(programValue);
    const caller = parseRlmV2Caller(callerValue);
    const callerCapabilities = new Set(caller.capabilities);
    for (const capability of program.capabilities) {
      if (!callerCapabilities.has(capability)) {
        throw new Error("RLM v2 program capability exceeds caller authority");
      }
    }
    const state: ExecutionState = {
      caller,
      programRunId,
      programDigest: digestRlmV2Program(program),
      signal,
      deadlineMs: Date.parse(caller.budget.deadline),
      enforceDeadline: true,
      replayTarget: null,
      executedPaths: new Set(),
      replayTargetReached: false,
      reusedReceipts: 0,
      recordedReceipts: 0,
    };
    try {
      this.#guard(state, null);
      const value = await this.#executeBlock(program, new LexicalFrame(), [], state);
      this.#guard(state, null);
      return {
        state: "succeeded",
        value,
        fuel: state.executedPaths.size,
        reusedReceipts: state.reusedReceipts,
        recordedReceipts: state.recordedReceipts,
      };
    } catch (error: unknown) {
      const fault = toFault(error, null);
      return {
        state: fault.code === "cancelled"
          ? "cancelled"
          : fault.code === "replay_required"
            ? "suspended"
            : "failed",
        code: fault.code,
        nodePath: fault.nodePath,
        fuel: state.executedPaths.size,
        reusedReceipts: state.reusedReceipts,
        recordedReceipts: state.recordedReceipts,
      };
    }
  }

  /**
   * Reconstructs the lexical inputs for exactly one durable external receipt
   * and invokes no other missing operation. Reconciliation deliberately
   * ignores the original execution deadline because it closes an effect that
   * was already admitted before that deadline; it never admits a new effect.
   */
  async replayExactOperation(
    programRunIdValue: string,
    programValue: unknown,
    callerValue: unknown,
    targetValue: unknown,
    signal: AbortSignal,
  ): Promise<RlmV2ExecutionOutcome> {
    const programRunId = programRunIdSchema.parse(programRunIdValue);
    const program = parseRlmV2Program(programValue);
    const caller = parseRlmV2Caller(callerValue);
    const target = rlmV2OperationReplayTargetSchema.parse(targetValue);
    const programDigest = digestRlmV2Program(program);
    if (target.id !== deriveRlmV2ReceiptId(
      programRunId,
      programDigest,
      target.nodePath,
    )) {
      throw new Error("RLM replay target has incoherent structural identity");
    }
    const callerCapabilities = new Set(caller.capabilities);
    for (const capability of program.capabilities) {
      if (!callerCapabilities.has(capability)) {
        throw new Error("RLM v2 program capability exceeds caller authority");
      }
    }
    const state: ExecutionState = {
      caller,
      programRunId,
      programDigest,
      signal,
      deadlineMs: Date.parse(caller.budget.deadline),
      enforceDeadline: false,
      replayTarget: target,
      executedPaths: new Set(),
      replayTargetReached: false,
      reusedReceipts: 0,
      recordedReceipts: 0,
    };
    try {
      this.#guard(state, target.nodePath);
      const value = await this.#replayTargetInBlock(
        program,
        new LexicalFrame(),
        [],
        state,
      );
      this.#guard(state, target.nodePath);
      if (!state.replayTargetReached) {
        throw new RlmV2Fault(
          "receipt_conflict",
          "RLM replay target was not reached",
          target.nodePath,
        );
      }
      return {
        state: "succeeded",
        value,
        fuel: state.executedPaths.size,
        reusedReceipts: state.reusedReceipts,
        recordedReceipts: state.recordedReceipts,
      };
    } catch (error: unknown) {
      const fault = toFault(error, target.nodePath);
      return {
        state: fault.code === "cancelled"
          ? "cancelled"
          : fault.code === "replay_required"
            ? "suspended"
            : "failed",
        code: fault.code,
        nodePath: fault.nodePath,
        fuel: state.executedPaths.size,
        reusedReceipts: state.reusedReceipts,
        recordedReceipts: state.recordedReceipts,
      };
    }
  }

  async #replayTargetInBlock(
    block: RlmV2Block,
    initialFrame: LexicalFrame,
    basePath: RlmV2NodePath,
    state: ExecutionState,
  ): Promise<ProgramJsonValue> {
    const target = state.replayTarget;
    if (target === null) throw new Error("RLM replay target is missing");
    const segment = target.nodePath[basePath.length];
    if (segment?.[0] !== "step" || segment[1] >= block.steps.length) {
      throw new RlmV2Fault(
        "receipt_conflict",
        "RLM replay target does not name a step in its block",
        target.nodePath,
      );
    }

    let frame = initialFrame;
    for (let index = 0; index < segment[1]; index += 1) {
      const step = block.steps[index]!;
      const stepPath = appendPath(basePath, "step", index);
      this.#admitStep(state, stepPath);
      const value = await this.#executeStep(step, frame, stepPath, state);
      this.#guard(state, stepPath);
      frame = frame.define(step.as, value);
    }

    const step = block.steps[segment[1]]!;
    const stepPath = appendPath(basePath, "step", segment[1]);
    this.#admitStep(state, stepPath);
    if (step.kind === "call") {
      if (!sameNodePath(stepPath, target.nodePath)) {
        throw new RlmV2Fault(
          "receipt_conflict",
          "RLM replay target continues beyond a call",
          target.nodePath,
        );
      }
      return await this.#executeCall(step, frame, stepPath, state);
    }

    const childSegment = target.nodePath[stepPath.length];
    switch (step.kind) {
      case "let":
        throw new RlmV2Fault(
          "receipt_conflict",
          "RLM replay target names a non-operation step",
          target.nodePath,
        );
      case "if": {
        const condition = expectBoolean(
          evaluateRlmV2Expression(step.condition, frame),
          "RLM if condition",
        );
        const branchIndex = condition ? 0 : 1;
        if (childSegment?.[0] !== "if" || childSegment[1] !== branchIndex) {
          throw new RlmV2Fault(
            "receipt_conflict",
            "RLM replay target conflicts with its conditional branch",
            target.nodePath,
          );
        }
        return await this.#replayTargetInBlock(
          condition ? step.then : step.otherwise,
          frame.child(),
          appendPath(stepPath, "if", branchIndex),
          state,
        );
      }
      case "map": {
        const items = expectList(
          evaluateRlmV2Expression(step.items, frame),
          "RLM map",
        );
        if (items.length > step.maxItems || childSegment?.[0] !== "map" ||
            childSegment[1] >= items.length) {
          throw new RlmV2Fault(
            "receipt_conflict",
            "RLM replay target conflicts with its map iteration",
            target.nodePath,
          );
        }
        const index = childSegment[1];
        return await this.#replayTargetInBlock(
          step.body,
          frame.child(nullPrototypeRecord([
            [step.index, index],
            [step.item, items[index]!],
          ])),
          appendPath(stepPath, "map", index),
          state,
        );
      }
      case "reduce": {
        const items = expectList(
          evaluateRlmV2Expression(step.items, frame),
          "RLM reduce",
        );
        if (items.length > step.maxItems || childSegment?.[0] !== "reduce" ||
            childSegment[1] >= items.length) {
          throw new RlmV2Fault(
            "receipt_conflict",
            "RLM replay target conflicts with its reduce iteration",
            target.nodePath,
          );
        }
        const targetIndex = childSegment[1];
        let accumulator = evaluateRlmV2Expression(step.initial, frame);
        for (let index = 0; index < targetIndex; index += 1) {
          const path = appendPath(stepPath, "reduce", index);
          accumulator = await this.#executeBlock(
            step.body,
            frame.child(nullPrototypeRecord([
              [step.accumulator, accumulator],
              [step.index, index],
              [step.item, items[index]!],
            ])),
            path,
            state,
          );
        }
        return await this.#replayTargetInBlock(
          step.body,
          frame.child(nullPrototypeRecord([
            [step.accumulator, accumulator],
            [step.index, targetIndex],
            [step.item, items[targetIndex]!],
          ])),
          appendPath(stepPath, "reduce", targetIndex),
          state,
        );
      }
      case "parallel": {
        const branches = sortedEntries(step.branches);
        if (childSegment?.[0] !== "parallel" ||
            childSegment[1] >= branches.length) {
          throw new RlmV2Fault(
            "receipt_conflict",
            "RLM replay target conflicts with its parallel branch",
            target.nodePath,
          );
        }
        const index = childSegment[1];
        return await this.#replayTargetInBlock(
          branches[index]![1],
          frame.child(),
          appendPath(stepPath, "parallel", index),
          state,
        );
      }
    }
  }

  async #executeBlock(
    block: RlmV2Block,
    initialFrame: LexicalFrame,
    basePath: RlmV2NodePath,
    state: ExecutionState,
  ): Promise<ProgramJsonValue> {
    let frame = initialFrame;
    for (const [index, step] of block.steps.entries()) {
      const stepPath = appendPath(basePath, "step", index);
      this.#admitStep(state, stepPath);
      try {
        const value = await this.#executeStep(step, frame, stepPath, state);
        this.#guard(state, stepPath);
        frame = frame.define(step.as, value);
      } catch (error: unknown) {
        throw toFault(error, stepPath);
      }
    }
    return evaluateRlmV2Expression(block.result, frame);
  }

  async #executeStep(
    step: RlmV2Step,
    frame: LexicalFrame,
    stepPath: RlmV2NodePath,
    state: ExecutionState,
  ): Promise<ProgramJsonValue> {
    switch (step.kind) {
      case "let":
        return evaluateRlmV2Expression(step.value, frame);
      case "call":
        return await this.#executeCall(step, frame, stepPath, state);
      case "if": {
        const condition = expectBoolean(
          evaluateRlmV2Expression(step.condition, frame),
          "RLM if condition",
        );
        const branchIndex = condition ? 0 : 1;
        return await this.#executeBlock(
          condition ? step.then : step.otherwise,
          frame.child(),
          appendPath(stepPath, "if", branchIndex),
          state,
        );
      }
      case "map": {
        const items = expectList(evaluateRlmV2Expression(step.items, frame), "RLM map");
        if (items.length > step.maxItems) {
          throw new RlmV2Fault("fuel_exhausted", "RLM map exceeds maxItems", stepPath);
        }
        const output = await this.#executeFixedBatches(
          items,
          step.concurrency,
          (index) => appendPath(stepPath, "map", index),
          async (item, index, path) => {
            const child = frame.child(nullPrototypeRecord([
              [step.index, index],
              [step.item, item],
            ]));
            return await this.#executeBlock(step.body, child, path, state);
          },
          state,
          stepPath,
        );
        return checkedValue(output);
      }
      case "reduce": {
        const items = expectList(evaluateRlmV2Expression(step.items, frame), "RLM reduce");
        if (items.length > step.maxItems) {
          throw new RlmV2Fault("fuel_exhausted", "RLM reduce exceeds maxItems", stepPath);
        }
        let accumulator = evaluateRlmV2Expression(step.initial, frame);
        for (const [index, item] of items.entries()) {
          const path = appendPath(stepPath, "reduce", index);
          this.#guard(state, path);
          const child = frame.child(nullPrototypeRecord([
            [step.accumulator, accumulator],
            [step.index, index],
            [step.item, item],
          ]));
          accumulator = await this.#executeBlock(step.body, child, path, state);
          this.#guard(state, path);
        }
        return accumulator;
      }
      case "parallel": {
        const branches = sortedEntries(step.branches);
        const results = await this.#executeFixedBatches(
          branches,
          step.concurrency,
          (index) => appendPath(stepPath, "parallel", index),
          async ([name, block], _index, path) => [
            name,
            await this.#executeBlock(block, frame.child(), path, state),
          ] as const,
          state,
          stepPath,
        );
        return checkedValue(nullPrototypeRecord(results));
      }
    }
  }

  async #executeCall(
    step: Extract<RlmV2Step, { readonly kind: "call" }>,
    frame: LexicalFrame,
    nodePath: RlmV2NodePath,
    state: ExecutionState,
  ): Promise<ProgramJsonValue> {
    const requiredCapability = capabilityForRlmV2Operation(step.operation);
    if (!state.caller.capabilities.includes(requiredCapability)) {
      throw new Error("RLM operation exceeds caller authority");
    }
    const argumentsValue = nullPrototypeRecord(
      sortedEntries(step.arguments).map(([key, expression]) => [
        key,
        evaluateRlmV2Expression(expression, frame),
      ] as const),
    );
    checkedValue(argumentsValue);
    const requestValue: ProgramJsonValue = {
      operation: step.operation,
      arguments: argumentsValue,
    };
    const requestDigest = digestCanonical(requestValue);
    const receiptId = deriveRlmV2ReceiptId(
      state.programRunId,
      state.programDigest,
      nodePath,
    );

    this.#guard(state, nodePath);
    const loaded = await this.#receipts.read(receiptId);
    this.#guard(state, nodePath);
    if (loaded !== null) {
      const receipt = parseReceipt(loaded);
      assertReceiptIdentity(receipt, {
        id: receiptId,
        programRunId: state.programRunId,
        programDigest: state.programDigest,
        nodePath,
        operation: step.operation,
        requestDigest,
      });
      if (state.replayTarget?.id === receiptId) {
        assertReplayTargetIdentity(state.replayTarget, {
          id: receiptId,
          nodePath,
          operation: step.operation,
          requestDigest,
        });
        state.replayTargetReached = true;
      }
      state.reusedReceipts += 1;
      return receipt.result;
    }

    this.#guard(state, nodePath);
    if (state.replayTarget !== null) {
      assertReplayTargetIdentity(state.replayTarget, {
        id: receiptId,
        nodePath,
        operation: step.operation,
        requestDigest,
      });
      state.replayTargetReached = true;
    }
    let result: ProgramJsonValue;
    try {
      result = checkedValue(await this.#operations.invoke(
        step.operation,
        argumentsValue,
        {
          ...state.caller,
          programRunId: state.programRunId,
          programDigest: state.programDigest,
          receiptId,
          nodePath,
          signal: state.signal,
        },
      ));
    } catch (error: unknown) {
      this.#guard(state, nodePath);
      if (error instanceof RlmV2OperationReplayRequiredError) {
        throw new RlmV2Fault(
          "replay_required",
          "RLM external operation requires durable replay",
          nodePath,
        );
      }
      throw new RlmV2Fault(
        "operation_failed",
        error instanceof Error ? error.message : "RLM operation failed",
        nodePath,
      );
    }
    this.#guard(state, nodePath);
    const receipt = parseReceipt({
      version: RLM_V2_PROGRAM_VERSION,
      id: receiptId,
      programRunId: state.programRunId,
      programDigest: state.programDigest,
      nodePath,
      operation: step.operation,
      requestDigest,
      result,
    });
    await this.#receipts.record(receipt);
    this.#guard(state, nodePath);
    state.recordedReceipts += 1;
    return result;
  }

  async #executeFixedBatches<T, R>(
    values: readonly T[],
    concurrency: number,
    pathAt: (index: number) => RlmV2NodePath,
    execute: (value: T, index: number, path: RlmV2NodePath) => Promise<R>,
    state: ExecutionState,
    parentPath: RlmV2NodePath,
  ): Promise<readonly R[]> {
    const output = new Map<number, R>();
    for (let start = 0; start < values.length; start += concurrency) {
      this.#guard(state, parentPath);
      const end = Math.min(values.length, start + concurrency);
      const settled = await Promise.allSettled(
        values.slice(start, end).map((value, offset) => {
          const index = start + offset;
          const path = pathAt(index);
          return execute(value, index, path);
        }),
      );
      const failures: RlmV2Fault[] = [];
      for (const [offset, result] of settled.entries()) {
        const index = start + offset;
        if (result.status === "fulfilled") output.set(index, result.value);
        else failures.push(toFault(result.reason, pathAt(index)));
      }
      if (failures.length > 0) {
        failures.sort(compareFaults);
        throw failures[0]!;
      }
      this.#guard(state, parentPath);
    }
    return values.map((_value, index) => {
      if (!output.has(index)) throw new Error("RLM fixed batch omitted a result");
      return output.get(index)!;
    });
  }

  #admitStep(state: ExecutionState, nodePath: RlmV2NodePath): void {
    this.#guard(state, nodePath);
    const key = canonicalPath(nodePath);
    if (state.executedPaths.has(key)) {
      throw new RlmV2Fault("evaluation_failed", "RLM node path was executed twice", nodePath);
    }
    state.executedPaths.add(key);
    if (state.executedPaths.size > RLM_V2_MAX_FUEL) {
      throw new RlmV2Fault("fuel_exhausted", "RLM execution exhausted fuel", nodePath);
    }
  }

  #guard(state: ExecutionState, nodePath: RlmV2NodePath | null): void {
    if (state.signal.aborted) {
      throw new RlmV2Fault("cancelled", "RLM execution was cancelled", nodePath);
    }
    if (state.enforceDeadline && this.#now() >= state.deadlineMs) {
      throw new RlmV2Fault("deadline_exceeded", "RLM execution deadline elapsed", nodePath);
    }
  }
}

export class MemoryRlmV2ReceiptStore implements RlmV2ReceiptPort {
  readonly #receipts = new Map<string, RlmV2OperationReceipt>();

  read(receiptId: string): Promise<RlmV2OperationReceipt | null> {
    return Promise.resolve(this.#receipts.get(receiptId) ?? null);
  }

  record(receiptValue: RlmV2OperationReceipt): Promise<void> {
    const receipt = parseReceipt(receiptValue);
    const current = this.#receipts.get(receipt.id);
    if (current !== undefined && canonicalJson(current as unknown as ProgramJsonValue) !==
      canonicalJson(receipt as unknown as ProgramJsonValue)) {
      throw new RlmV2Fault("receipt_conflict", "RLM receipt conflicts with an immutable record", receipt.nodePath);
    }
    this.#receipts.set(receipt.id, receipt);
    return Promise.resolve();
  }

  snapshot(): readonly RlmV2OperationReceipt[] {
    return [...this.#receipts.values()].sort((left, right) => compareLexicographic(left.id, right.id));
  }
}

export function parseRlmV2Program(value: unknown): RlmV2Program {
  assertJsonInput(value);
  const parsed = rawProgramSchema.parse(value);
  const normalized: RlmV2Program = freezeJson({
    ...parsed,
    capabilities: [...parsed.capabilities].sort(compareLexicographic),
  });
  const sourceBytes = Buffer.byteLength(canonicalJson(normalized as unknown as ProgramJsonValue), "utf8");
  if (sourceBytes > RLM_V2_MAX_SOURCE_UTF8_BYTES) {
    throw new Error("RLM v2 program exceeds its source byte limit");
  }
  const inspection = inspectRlmV2Program(normalized);
  if (inspection.worstCaseFuel > RLM_V2_MAX_FUEL) {
    throw new Error("RLM v2 program exceeds its worst-case fuel limit");
  }
  const declared = new Set(normalized.capabilities);
  if (declared.size !== normalized.capabilities.length) {
    throw new Error("RLM v2 capabilities must be unique");
  }
  for (const capability of inspection.capabilities) {
    if (!declared.has(capability as z.infer<typeof rlmV2CapabilitySchema>)) {
      throw new Error(`RLM v2 program lacks ${capability}`);
    }
  }
  return normalized;
}

export function safeParseRlmV2Program(value: unknown):
  | Readonly<{ readonly success: true; readonly data: RlmV2Program }>
  | Readonly<{ readonly success: false; readonly error: Error }> {
  try {
    return { success: true, data: parseRlmV2Program(value) };
  } catch (error: unknown) {
    return {
      success: false,
      error: error instanceof Error ? error : new Error("RLM v2 program is invalid"),
    };
  }
}

export function parseRlmV2Caller(value: unknown): RlmV2Caller {
  assertJsonInput(value);
  return freezeJson(rlmV2CallerSchema.parse(value));
}

export function capabilityForRlmV2Operation(operation: RlmV2Operation): RlmV2Capability {
  switch (operation) {
    case "context.snapshot":
    case "context.search":
    case "context.slice":
      return "context.read";
    case "context.materialize":
      return "context.materialize";
    case "heap.put":
      return "heap.write";
    case "heap.get":
    case "heap.list":
      return "heap.read";
    case "agent.spawn":
      return "agent.spawn";
    case "agent.send":
      return "agent.message";
    case "agent.status":
    case "agent.waitAny":
    case "agent.waitAll":
    case "agent.result":
      return "agent.wait";
    case "agent.cancel":
      return "agent.cancel";
    case "harness.propose":
      return "harness.propose";
  }
}

export function digestRlmV2Program(value: RlmV2Program): string {
  const program = parseRlmV2Program(value);
  return digestCanonical(program as unknown as ProgramJsonValue);
}

export function deriveRlmV2ReceiptId(
  programRunIdValue: string,
  programDigest: string,
  nodePathValue: RlmV2NodePath,
): string {
  const programRunId = programRunIdSchema.parse(programRunIdValue);
  if (!/^[a-f0-9]{64}$/u.test(programDigest)) throw new Error("Invalid RLM program digest");
  const nodePath = rlmV2NodePathSchema.parse(nodePathValue);
  const digest = digestCanonical([
    "oprte.rlm.operation.v2",
    programRunId,
    programDigest,
    nodePath,
  ]);
  return programOperationIdSchema.parse(`rlmop_${digest}`);
}

export function evaluateRlmV2Expression(
  expressionValue: RlmV2Expression,
  bindings: ReadonlyMap<string, ProgramJsonValue> | LexicalFrame,
): ProgramJsonValue {
  const frame = bindings instanceof LexicalFrame
    ? bindings
    : frameFromBindings(bindings);
  const expression = expressionSchema.parse(expressionValue);
  return evaluateExpressionNode(expression, frame);
}

export function canonicalRlmV2Equal(left: ProgramJsonValue, right: ProgramJsonValue): boolean {
  return canonicalJson(checkedValue(left)) === canonicalJson(checkedValue(right));
}

export function compareRlmV2NodePaths(left: RlmV2NodePath, right: RlmV2NodePath): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftSegment = left[index]!;
    const rightSegment = right[index]!;
    const kind = PATH_KIND_ORDER[leftSegment[0]] - PATH_KIND_ORDER[rightSegment[0]];
    if (kind !== 0) return kind;
    if (leftSegment[1] !== rightSegment[1]) return leftSegment[1] - rightSegment[1];
  }
  return left.length - right.length;
}

function evaluateExpressionNode(
  expression: RlmV2Expression,
  frame: LexicalFrame,
): ProgramJsonValue {
  let value: ProgramJsonValue;
  switch (expression.kind) {
    case "literal":
      value = expression.value;
      break;
    case "variable":
      value = frame.get(expression.name);
      break;
    case "list":
      value = expression.items.map((item) => evaluateExpressionNode(item, frame));
      break;
    case "object":
      value = nullPrototypeRecord(sortedEntries(expression.entries).map(([key, entry]) => [
        key,
        evaluateExpressionNode(entry, frame),
      ] as const));
      break;
    case "field": {
      const object = expectRecord(evaluateExpressionNode(expression.value, frame), "RLM field");
      if (!Object.hasOwn(object, expression.field)) {
        throw new Error(`RLM field is missing: ${expression.field}`);
      }
      value = object[expression.field]!;
      break;
    }
    case "index": {
      const collection = evaluateExpressionNode(expression.value, frame);
      const index = evaluateExpressionNode(expression.index, frame);
      if (isList(collection)) {
        if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= collection.length) {
          throw new Error("RLM list index is out of bounds");
        }
        value = collection[index]!;
      } else {
        const object = expectRecord(collection, "RLM object index");
        if (typeof index !== "string" || FORBIDDEN_KEYS.has(index) || !Object.hasOwn(object, index)) {
          throw new Error("RLM object index is missing or invalid");
        }
        value = object[index]!;
      }
      break;
    }
    case "equals":
      value = canonicalRlmV2Equal(
        evaluateExpressionNode(expression.left, frame),
        evaluateExpressionNode(expression.right, frame),
      );
      break;
    case "not":
      value = !expectBoolean(evaluateExpressionNode(expression.value, frame), "RLM not");
      break;
    case "and": {
      const left = expectBoolean(evaluateExpressionNode(expression.left, frame), "RLM and");
      const right = expectBoolean(evaluateExpressionNode(expression.right, frame), "RLM and");
      value = left && right;
      break;
    }
    case "or": {
      const left = expectBoolean(evaluateExpressionNode(expression.left, frame), "RLM or");
      const right = expectBoolean(evaluateExpressionNode(expression.right, frame), "RLM or");
      value = left || right;
      break;
    }
    case "add": {
      const left = expectNumber(evaluateExpressionNode(expression.left, frame), "RLM add");
      const right = expectNumber(evaluateExpressionNode(expression.right, frame), "RLM add");
      const result = left + right;
      if (!Number.isFinite(result) || Math.abs(result) > Number.MAX_SAFE_INTEGER) {
        throw new Error("RLM add result is outside the safe numeric range");
      }
      value = result;
      break;
    }
    case "concat": {
      const left = evaluateExpressionNode(expression.left, frame);
      const right = evaluateExpressionNode(expression.right, frame);
      if (typeof left === "string" && typeof right === "string") value = left + right;
      else if (isList(left) && isList(right)) {
        if (left.length + right.length > RLM_V2_MAX_COLLECTION_ITEMS) {
          throw new Error("RLM concat exceeds its collection limit");
        }
        value = [...left, ...right];
      } else throw new Error("RLM concat requires two strings or two lists");
      break;
    }
    case "length": {
      const target = evaluateExpressionNode(expression.value, frame);
      if (typeof target === "string") value = [...target].length;
      else if (isList(target)) value = target.length;
      else if (isRecord(target)) value = Object.keys(target).length;
      else throw new Error("RLM length requires a string, list, or object");
      break;
    }
  }
  return checkedValue(value);
}

function inspectRlmV2Program(program: RlmV2Program): Inspection {
  const capabilities = new Set<string>();
  const worstCaseFuel = inspectBlock(program, new Set(), 1, capabilities);
  return { capabilities, worstCaseFuel };
}

function inspectBlock(
  block: RlmV2Block,
  inherited: ReadonlySet<string>,
  depth: number,
  capabilities: Set<string>,
  initialLocals: readonly string[] = [],
): number {
  if (depth > RLM_V2_MAX_NESTING) throw new Error("RLM v2 block exceeds its nesting limit");
  const locals = new Set<string>();
  for (const name of initialLocals) {
    if (locals.has(name)) throw new Error(`Duplicate RLM binding in one frame: ${name}`);
    locals.add(name);
  }
  const available = (): ReadonlySet<string> => new Set([...inherited, ...locals]);
  let fuel = 0;
  for (const step of block.steps) {
    const visible = available();
    fuel = boundedFuelAdd(fuel, 1);
    switch (step.kind) {
      case "let":
        inspectExpression(step.value, visible, 1);
        break;
      case "call":
        for (const [, expression] of sortedEntries(step.arguments)) {
          inspectExpression(expression, visible, 1);
        }
        capabilities.add(capabilityForRlmV2Operation(step.operation));
        break;
      case "if": {
        inspectExpression(step.condition, visible, 1);
        const thenFuel = inspectBlock(step.then, visible, depth + 1, capabilities);
        const otherwiseFuel = inspectBlock(step.otherwise, visible, depth + 1, capabilities);
        fuel = boundedFuelAdd(fuel, Math.max(thenFuel, otherwiseFuel));
        break;
      }
      case "map": {
        inspectExpression(step.items, visible, 1);
        const bodyFuel = inspectBlock(
          step.body,
          visible,
          depth + 1,
          capabilities,
          [step.item, step.index],
        );
        fuel = boundedFuelAdd(fuel, boundedFuelMultiply(step.maxItems, bodyFuel));
        break;
      }
      case "reduce": {
        inspectExpression(step.items, visible, 1);
        inspectExpression(step.initial, visible, 1);
        const bodyFuel = inspectBlock(
          step.body,
          visible,
          depth + 1,
          capabilities,
          [step.accumulator, step.item, step.index],
        );
        fuel = boundedFuelAdd(fuel, boundedFuelMultiply(step.maxItems, bodyFuel));
        break;
      }
      case "parallel": {
        let parallelFuel = 0;
        for (const [, branch] of sortedEntries(step.branches)) {
          parallelFuel = boundedFuelAdd(
            parallelFuel,
            inspectBlock(branch, visible, depth + 1, capabilities),
          );
        }
        fuel = boundedFuelAdd(fuel, parallelFuel);
        break;
      }
    }
    if (locals.has(step.as)) throw new Error(`Duplicate RLM binding in one frame: ${step.as}`);
    locals.add(step.as);
  }
  inspectExpression(block.result, available(), 1);
  return fuel;
}

function inspectExpression(
  expression: RlmV2Expression,
  available: ReadonlySet<string>,
  depth: number,
): void {
  if (depth > RLM_V2_MAX_NESTING) {
    throw new Error("RLM v2 expression exceeds its nesting limit");
  }
  switch (expression.kind) {
    case "literal":
      checkedValue(expression.value);
      return;
    case "variable":
      if (!available.has(expression.name)) throw new Error(`Unknown RLM variable: ${expression.name}`);
      return;
    case "list":
      for (const item of expression.items) inspectExpression(item, available, depth + 1);
      return;
    case "object":
      for (const [, value] of sortedEntries(expression.entries)) {
        inspectExpression(value, available, depth + 1);
      }
      return;
    case "field":
    case "not":
    case "length":
      inspectExpression(expression.value, available, depth + 1);
      return;
    case "index":
      inspectExpression(expression.value, available, depth + 1);
      inspectExpression(expression.index, available, depth + 1);
      return;
    case "equals":
    case "and":
    case "or":
    case "add":
    case "concat":
      inspectExpression(expression.left, available, depth + 1);
      inspectExpression(expression.right, available, depth + 1);
  }
}

function checkedValue(value: unknown): ProgramJsonValue {
  assertJsonInput(value);
  const parsed = jsonValueSchema.parse(value);
  const normalized = freezeJson(parsed);
  if (Buffer.byteLength(canonicalJson(normalized), "utf8") > RLM_V2_MAX_VALUE_UTF8_BYTES) {
    throw new Error("RLM value exceeds its byte limit");
  }
  return normalized;
}

function parseReceipt(value: unknown): RlmV2OperationReceipt {
  try {
    assertJsonInput(value);
    const parsed = rlmV2OperationReceiptSchema.parse(value);
    return freezeJson({
      ...parsed,
      result: checkedValue(parsed.result),
    });
  } catch {
    throw new RlmV2Fault("receipt_conflict", "RLM receipt is malformed", null);
  }
}

function assertReceiptIdentity(
  receipt: RlmV2OperationReceipt,
  expected: Omit<RlmV2OperationReceipt, "version" | "result">,
): void {
  if (
    receipt.id !== expected.id ||
    receipt.programRunId !== expected.programRunId ||
    receipt.programDigest !== expected.programDigest ||
    receipt.operation !== expected.operation ||
    receipt.requestDigest !== expected.requestDigest ||
    canonicalPath(receipt.nodePath) !== canonicalPath(expected.nodePath)
  ) {
    throw new RlmV2Fault("receipt_conflict", "RLM receipt identity does not match its node", expected.nodePath);
  }
}

function assertReplayTargetIdentity(
  target: RlmV2OperationReplayTarget,
  actual: RlmV2OperationReplayTarget,
): void {
  if (
    target.id !== actual.id ||
    target.operation !== actual.operation ||
    target.requestDigest !== actual.requestDigest ||
    !sameNodePath(target.nodePath, actual.nodePath)
  ) {
    throw new RlmV2Fault(
      "receipt_conflict",
      "RLM replay target conflicts with the reconstructed operation",
      target.nodePath,
    );
  }
}

function sameNodePath(left: RlmV2NodePath, right: RlmV2NodePath): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

function frameFromBindings(bindings: ReadonlyMap<string, ProgramJsonValue>): LexicalFrame {
  let frame = new LexicalFrame();
  for (const [name, value] of [...bindings.entries()].sort(([left], [right]) => compareLexicographic(left, right))) {
    nameSchema.parse(name);
    frame = frame.define(name, checkedValue(value));
  }
  return frame;
}

function expectBoolean(value: ProgramJsonValue, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} requires a boolean`);
  return value;
}

function expectNumber(value: ProgramJsonValue, label: string): number {
  if (typeof value !== "number") throw new Error(`${label} requires a number`);
  return value;
}

function expectList(value: ProgramJsonValue, label: string): readonly ProgramJsonValue[] {
  if (!isList(value)) throw new Error(`${label} requires a list`);
  return value;
}

function expectRecord(
  value: ProgramJsonValue,
  label: string,
): Readonly<Record<string, ProgramJsonValue>> {
  if (!isRecord(value)) throw new Error(`${label} requires an object`);
  return value;
}

function isRecord(value: ProgramJsonValue): value is Readonly<Record<string, ProgramJsonValue>> {
  return value !== null && typeof value === "object" && !isList(value);
}

function isList(value: ProgramJsonValue): value is readonly ProgramJsonValue[] {
  return Array.isArray(value);
}

function nullPrototypeRecord<T extends ProgramJsonValue>(
  entries: readonly (readonly [string, T])[],
): Readonly<Record<string, T>> {
  const value = Object.create(null) as Record<string, T>;
  for (const [key, entry] of [...entries].sort(([left], [right]) => compareLexicographic(left, right))) {
    if (FORBIDDEN_KEYS.has(key) || Object.hasOwn(value, key)) {
      throw new Error(`Invalid or duplicate RLM object key: ${key}`);
    }
    value[key] = entry;
  }
  return Object.freeze(value);
}

function sortedEntries<T>(value: Readonly<Record<string, T>>): readonly (readonly [string, T])[] {
  return Object.keys(value)
    .sort(compareLexicographic)
    .map((key) => [key, value[key]!] as const);
}

function appendPath(
  path: RlmV2NodePath,
  kind: RlmV2PathSegment[0],
  index: number,
): RlmV2NodePath {
  return Object.freeze([...path, Object.freeze([kind, index] as const)]);
}

function canonicalPath(path: RlmV2NodePath): string {
  return canonicalJson(path);
}

function compareFaults(left: RlmV2Fault, right: RlmV2Fault): number {
  if (left.nodePath === null) return right.nodePath === null ? 0 : -1;
  if (right.nodePath === null) return 1;
  return compareRlmV2NodePaths(left.nodePath, right.nodePath);
}

function toFault(error: unknown, fallbackPath: RlmV2NodePath | null): RlmV2Fault {
  if (error instanceof RlmV2Fault) {
    if (error.nodePath !== null || fallbackPath === null) return error;
    return new RlmV2Fault(error.code, error.message, fallbackPath);
  }
  return new RlmV2Fault(
    "evaluation_failed",
    error instanceof Error ? error.message : "RLM evaluation failed",
    fallbackPath,
  );
}

function boundedFuelAdd(left: number, right: number): number {
  const total = left + right;
  return total > RLM_V2_MAX_FUEL ? RLM_V2_MAX_FUEL + 1 : total;
}

function boundedFuelMultiply(left: number, right: number): number {
  if (left === 0 || right === 0) return 0;
  if (left > RLM_V2_MAX_FUEL / right) return RLM_V2_MAX_FUEL + 1;
  return left * right;
}

function assertJsonInput(value: unknown): void {
  const active = new WeakSet<object>();
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > 100_000) throw new Error("RLM JSON input exceeds its node limit");
    if (depth > 64) throw new Error("RLM JSON input is too deeply nested");
    if (current === null || typeof current === "boolean" || typeof current === "string") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Math.abs(current) > Number.MAX_SAFE_INTEGER) {
        throw new Error("RLM JSON numbers must be finite and safe");
      }
      return;
    }
    if (typeof current !== "object") throw new Error("RLM input must contain only JSON values");
    if (active.has(current)) throw new Error("RLM JSON input must be acyclic");
    const prototype: unknown = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
      throw new Error("RLM input must contain only plain JSON objects and arrays");
    }
    const descriptors = Object.getOwnPropertyDescriptors(current);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key === "symbol")) {
      throw new Error("RLM JSON values may not contain symbol properties");
    }
    active.add(current);
    try {
      if (Array.isArray(current)) {
        if (Object.keys(descriptors).some((key) => key !== "length" && !/^(0|[1-9][0-9]*)$/u.test(key))) {
          throw new Error("RLM arrays may not have named properties");
        }
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined || !("value" in descriptor)) {
            throw new Error("RLM arrays must be dense data arrays");
          }
          visit(descriptor.value, depth + 1);
        }
      } else {
        for (const key of Object.keys(descriptors)) {
          if (FORBIDDEN_KEYS.has(key)) throw new Error("RLM object key is prototype-sensitive");
          const descriptor = descriptors[key]!;
          if (!("value" in descriptor) || descriptor.enumerable !== true) {
            throw new Error("RLM objects must contain enumerable data properties");
          }
          visit(descriptor.value, depth + 1);
        }
      }
    } finally {
      active.delete(current);
    }
  };
  visit(value, 0);
}

function freezeJson<T>(value: T): T;
function freezeJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (isUnknownArray(value)) return Object.freeze(value.map(freezeJson));
  const output = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of sortedEntries(value as Readonly<Record<string, unknown>>)) {
    output[key] = freezeJson(entry);
  }
  return Object.freeze(output);
}

function digestCanonical(value: ProgramJsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: ProgramJsonValue | RlmV2NodePath): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
      return JSON.stringify(value);
    case "object":
      return `{${sortedEntries(value as Readonly<Record<string, ProgramJsonValue>>)
        .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
        .join(",")}}`;
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      throw new TypeError("RLM canonical values must be JSON");
  }
}

function compareLexicographic(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isCanonicalArrayIndexKey(value: string): boolean {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) return false;
  const numeric = Number(value);
  return Number.isInteger(numeric) &&
    numeric >= 0 &&
    numeric < 4_294_967_295 &&
    String(numeric) === value;
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}
