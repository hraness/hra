import { createHash } from "node:crypto";

import { z } from "@hra-internal/schema";

import type { DynamicToolCallParams as GeneratedDynamicToolCallParams } from "../../../contracts/generated/codex/0.144.6/typescript/v2/DynamicToolCallParams";
import type { DynamicToolCallResponse as GeneratedDynamicToolCallResponse } from "../../../contracts/generated/codex/0.144.6/typescript/v2/DynamicToolCallResponse";
import type { DynamicToolSpec as GeneratedDynamicToolSpec } from "../../../contracts/generated/codex/0.144.6/typescript/v2/DynamicToolSpec";
import type { CodexRequestId } from "./envelope";
import { pinnedCodexMethods } from "./pinned-codecs";
import type { CodexStreamPosition } from "./rpc-core";

export const PINNED_CODEX_DYNAMIC_TOOL_VERSION = "0.144.6";
export const HRA_DYNAMIC_TOOL_NAMESPACE = "oprte";
export const HRA_RLM_DYNAMIC_TOOL_NAME = "rlm_run";
export const HRA_RLM_DYNAMIC_TOOL_SEMANTIC_CONTRACT_VERSION = 1 as const;
/** Exact v0 spec digest. It may reconcile stored effects, never start new work. */
export const HRA_RLM_PREDECESSOR_DYNAMIC_TOOL_SPEC_SHA256 =
  "4f7fd56a5855c36761265fcf2665be96ae7ed3e3737d382427996b0c6c441a13" as const;
/** Exact pre-routing.inspect v1 spec digest. Existing effects may only recover. */
export const HRA_RLM_PRE_ROUTING_INSPECT_DYNAMIC_TOOL_SPEC_SHA256 =
  "c8233c335cf93d1e8a412a5bfe81d71246b99fa120a58d4c29763caf6aac8fb4" as const;
export const MAX_CODEX_DYNAMIC_TOOL_ARGUMENT_BYTES = 256 * 1_024;
export const MAX_CODEX_DYNAMIC_TOOL_OUTPUT_BYTES = 256 * 1_024;
export const MAX_CODEX_DYNAMIC_TOOL_OUTPUT_ITEMS = 16;
export const MAX_CODEX_DYNAMIC_TOOL_PROBE_EVIDENCE_BYTES = 1024 * 1_024;
export const PINNED_CODEX_DYNAMIC_TOOL_PROBE_MAX_AGE_MS = 10 * 60 * 1_000;

const MAX_ID_CHARACTERS = 512;
const MAX_ACCOUNT_PROFILE_ID_CHARACTERS = 512;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 16_384;
const MAX_JSON_OBJECT_KEYS = 2_048;
const MAX_JSON_STRING_CHARACTERS = 256 * 1_024;
const MAX_OUTPUT_TEXT_CHARACTERS = 256 * 1_024;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/u;

export type PinnedCodexJsonValue =
  | null
  | boolean
  | number
  | string
  | PinnedCodexJsonValue[]
  | { [key: string]: PinnedCodexJsonValue };

export type PinnedCodexDynamicToolArguments =
  | Readonly<{
      schemaVersion: 1;
      action: "submit";
      program: PinnedCodexJsonValue;
    }>
  | Readonly<{
      schemaVersion: 1;
      action: "status" | "result" | "cancel";
      runId: string;
    }>
  | Readonly<{
      schemaVersion: 1;
      action: "wait";
      runId: string;
      timeoutMs: number;
    }>;

const idSchema = z.string().min(1).max(MAX_ID_CHARACTERS);
const accountProfileIdSchema = z.string().min(1).max(MAX_ACCOUNT_PROFILE_ID_CHARACTERS);
const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const jsonValueSchema = z.unknown().transform((value, context): PinnedCodexJsonValue => {
  if (!isBoundedJsonValue(value)) {
    context.addIssue({ code: "custom", message: "unbounded or invalid JSON value" });
    return z.NEVER;
  }
  return value;
});

const runIdSchema = z.string()
  .regex(/^rlmrun_[A-Za-z0-9_-]+$/u)
  .max(96);
const dynamicToolArgumentsSchema = z.object({
  schemaVersion: z.literal(1),
  action: z.enum(["submit", "status", "wait", "result", "cancel"]),
  program: jsonValueSchema.optional(),
  runId: runIdSchema.optional(),
  timeoutMs: z.number().int().min(0).max(30_000).optional(),
}).strict().superRefine((value, context) => {
  if (value.action === "submit") {
    if (value.program === undefined) {
      context.addIssue({ code: "custom", message: "submit requires program" });
    }
    if (value.runId !== undefined || value.timeoutMs !== undefined) {
      context.addIssue({ code: "custom", message: "submit rejects inspection fields" });
    }
    return;
  }
  if (value.runId === undefined || value.program !== undefined) {
    context.addIssue({ code: "custom", message: "inspection requires only a run id" });
  }
  if (value.action === "wait") {
    if (value.timeoutMs === undefined) {
      context.addIssue({ code: "custom", message: "wait requires timeout" });
    }
  } else if (value.timeoutMs !== undefined) {
    context.addIssue({ code: "custom", message: "timeout is valid only for wait" });
  }
});

const dynamicToolCallParamsSchema = z.object({
  threadId: idSchema,
  turnId: idSchema,
  callId: idSchema,
  namespace: z.literal(HRA_DYNAMIC_TOOL_NAMESPACE),
  tool: z.literal(HRA_RLM_DYNAMIC_TOOL_NAME),
  arguments: dynamicToolArgumentsSchema,
}).strict().superRefine((value, context) => {
  if (encodedBytes(value.arguments) > MAX_CODEX_DYNAMIC_TOOL_ARGUMENT_BYTES) {
    context.addIssue({ code: "custom", message: "dynamic tool arguments exceed byte bound" });
  }
});

const dynamicToolOutputContentItemSchema = z.object({
  type: z.literal("inputText"),
  text: z.string().max(MAX_OUTPUT_TEXT_CHARACTERS),
}).strict();

const dynamicToolResponseSchema = z.object({
  contentItems: z.array(dynamicToolOutputContentItemSchema)
    .max(MAX_CODEX_DYNAMIC_TOOL_OUTPUT_ITEMS),
  success: z.boolean(),
}).strict().superRefine((value, context) => {
  if (encodedBytes(value) > MAX_CODEX_DYNAMIC_TOOL_OUTPUT_BYTES) {
    context.addIssue({ code: "custom", message: "dynamic tool response exceeds byte bound" });
  }
});

const dynamicToolSpecSchema = z.object({
  type: z.literal("namespace"),
  name: z.literal(HRA_DYNAMIC_TOOL_NAMESPACE),
  description: z.string().min(1).max(1_024),
  tools: z.tuple([
    z.object({
      type: z.literal("function"),
      name: z.literal(HRA_RLM_DYNAMIC_TOOL_NAME),
      description: z.string().min(1).max(1_024),
      inputSchema: jsonValueSchema,
      deferLoading: z.literal(false),
    }).strict(),
  ]),
}).strict();

const RLM_V2_CAPABILITIES = Object.freeze([
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
] as const);

const RLM_V2_OPERATIONS = Object.freeze([
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
  "routing.inspect",
  "harness.propose",
] as const);

const RLM_V2_OPERATION_ARGUMENTS = [
  "Arguments are expressions evaluated before the call.",
  "context.snapshot {}; context.search {snapshotId?,query,limit?};",
  "context.slice {snapshotId?,startOrdinal,endOrdinal,limit?};",
  "context.materialize {snapshotId?,ordinals,format?};",
  "heap.put {name,value,format?}; heap.get {valueId} or {name};",
  "heap.list {afterValueId?,limit?};",
  "agent.spawn {title,workClass:largeChange|wideResearch|standard|boundedLeaf,allocation:{tokenShareBps,byteShareBps,activeDescendantShareBps,durableDescendantShareBps},inputValueId}; HRA derives model, reasoning effort, and Fast or Standard from workClass;",
  "agent.send {actorId,inputValueId}; HRA reuses the actor's durable workClass route. agent.status {actorId};",
  "agent.waitAny/agent.waitAll {turnIds,timeoutMs};",
  "agent.result/agent.cancel {turnId};",
  "routing.inspect {} returns bounded content-free shadow routing memory for the current durable caller; v1 includes recursive actor outcomes only, excludes ordinary root-turn spend, and reports requestedProfile as routing intent rather than observed provider compliance;",
  "harness.propose {title,body}.",
].join(" ");

const rlmV2ProgramExample = Object.freeze({
  version: 2,
  capabilities: Object.freeze([
    "context.read",
    "context.materialize",
    "agent.spawn",
    "agent.wait",
  ]),
  steps: Object.freeze([
    Object.freeze({
      kind: "call",
      as: "snapshot",
      operation: "context.snapshot",
      arguments: Object.freeze({}),
    }),
    Object.freeze({
      kind: "call",
      as: "task",
      operation: "context.materialize",
      arguments: Object.freeze({
        ordinals: Object.freeze({
          kind: "list",
          items: Object.freeze([
            Object.freeze({ kind: "literal", value: 0 }),
          ]),
        }),
        format: Object.freeze({ kind: "literal", value: "text" }),
      }),
    }),
    Object.freeze({
      kind: "call",
      as: "child",
      operation: "agent.spawn",
      arguments: Object.freeze({
        title: Object.freeze({ kind: "literal", value: "Inspect evidence" }),
        workClass: Object.freeze({
          kind: "literal",
          value: "wideResearch",
        }),
        allocation: Object.freeze({
          kind: "object",
          entries: Object.freeze({
            tokenShareBps: Object.freeze({ kind: "literal", value: 5_000 }),
            byteShareBps: Object.freeze({ kind: "literal", value: 5_000 }),
            activeDescendantShareBps: Object.freeze({ kind: "literal", value: 5_000 }),
            durableDescendantShareBps: Object.freeze({ kind: "literal", value: 5_000 }),
          }),
        }),
        inputValueId: Object.freeze({
          kind: "field",
          value: Object.freeze({ kind: "variable", name: "task" }),
          field: "valueId",
        }),
      }),
    }),
    Object.freeze({
      kind: "call",
      as: "waited",
      operation: "agent.waitAny",
      arguments: Object.freeze({
        turnIds: Object.freeze({
          kind: "list",
          items: Object.freeze([
            Object.freeze({
              kind: "field",
              value: Object.freeze({
                kind: "field",
                value: Object.freeze({ kind: "variable", name: "child" }),
                field: "turn",
              }),
              field: "turnId",
            }),
          ]),
        }),
        timeoutMs: Object.freeze({ kind: "literal", value: 30_000 }),
      }),
    }),
    Object.freeze({
      kind: "call",
      as: "result",
      operation: "agent.result",
      arguments: Object.freeze({
        turnId: Object.freeze({
          kind: "field",
          value: Object.freeze({
            kind: "field",
            value: Object.freeze({ kind: "variable", name: "child" }),
            field: "turn",
          }),
          field: "turnId",
        }),
      }),
    }),
  ]),
  result: Object.freeze({ kind: "variable", name: "result" }),
});

const rlmV2RoutingInspectionExample = Object.freeze({
  version: 2,
  capabilities: Object.freeze(["routing.inspect"]),
  steps: Object.freeze([
    Object.freeze({
      kind: "call",
      as: "routingMemory",
      operation: "routing.inspect",
      arguments: Object.freeze({}),
    }),
  ]),
  result: Object.freeze({ kind: "variable", name: "routingMemory" }),
});

const rlmV2JsonSchemaDefinitions = Object.freeze({
  rlmExpression: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["kind"]),
    description: "One bounded lexical expression. The selected kind determines which remaining fields are required; runtime validation is strict.",
    properties: Object.freeze({
      kind: Object.freeze({
        enum: Object.freeze([
          "literal",
          "variable",
          "list",
          "object",
          "field",
          "index",
          "equals",
          "not",
          "and",
          "or",
          "add",
          "concat",
          "length",
        ]),
      }),
      value: Object.freeze({
        description: "literal JSON value, or the operand for field/not/length",
      }),
      name: Object.freeze({
        type: "string",
        pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
        maxLength: 64,
      }),
      items: Object.freeze({
        type: "array",
        maxItems: 32,
        items: Object.freeze({ $ref: "#/$defs/rlmExpression" }),
      }),
      entries: Object.freeze({
        type: "object",
        maxProperties: 32,
        additionalProperties: Object.freeze({ $ref: "#/$defs/rlmExpression" }),
      }),
      field: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
      index: Object.freeze({ $ref: "#/$defs/rlmExpression" }),
      left: Object.freeze({ $ref: "#/$defs/rlmExpression" }),
      right: Object.freeze({ $ref: "#/$defs/rlmExpression" }),
    }),
  }),
  rlmBlock: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["steps", "result"]),
    properties: Object.freeze({
      steps: Object.freeze({
        type: "array",
        maxItems: 32,
        items: Object.freeze({ $ref: "#/$defs/rlmStep" }),
      }),
      result: Object.freeze({ $ref: "#/$defs/rlmExpression" }),
    }),
  }),
  rlmStep: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["kind", "as"]),
    description: "A let, call, if, map, reduce, or parallel step. Runtime validation strictly requires only the fields belonging to that kind.",
    properties: Object.freeze({
      kind: Object.freeze({
        enum: Object.freeze(["let", "call", "if", "map", "reduce", "parallel"]),
      }),
      as: Object.freeze({
        type: "string",
        pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
        maxLength: 64,
      }),
      value: Object.freeze({ $ref: "#/$defs/rlmExpression" }),
      operation: Object.freeze({
        enum: RLM_V2_OPERATIONS,
        description: RLM_V2_OPERATION_ARGUMENTS,
      }),
      arguments: Object.freeze({
        type: "object",
        maxProperties: 32,
        additionalProperties: Object.freeze({ $ref: "#/$defs/rlmExpression" }),
        description: RLM_V2_OPERATION_ARGUMENTS,
      }),
      condition: Object.freeze({ $ref: "#/$defs/rlmExpression" }),
      then: Object.freeze({ $ref: "#/$defs/rlmBlock" }),
      otherwise: Object.freeze({ $ref: "#/$defs/rlmBlock" }),
      items: Object.freeze({ $ref: "#/$defs/rlmExpression" }),
      item: Object.freeze({ type: "string", minLength: 1, maxLength: 64 }),
      index: Object.freeze({ type: "string", minLength: 1, maxLength: 64 }),
      maxItems: Object.freeze({ type: "integer", minimum: 0, maximum: 32 }),
      concurrency: Object.freeze({ type: "integer", minimum: 1, maximum: 8 }),
      body: Object.freeze({ $ref: "#/$defs/rlmBlock" }),
      initial: Object.freeze({ $ref: "#/$defs/rlmExpression" }),
      accumulator: Object.freeze({ type: "string", minLength: 1, maxLength: 64 }),
      branches: Object.freeze({
        type: "object",
        minProperties: 1,
        maxProperties: 8,
        additionalProperties: Object.freeze({ $ref: "#/$defs/rlmBlock" }),
      }),
    }),
  }),
  rlmProgram: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["version", "capabilities", "steps", "result"]),
    description: "A bounded, deterministic lexical RLM v2 program. Bindings are local; arbitrary code and provider RPC are unavailable.",
    properties: Object.freeze({
      version: Object.freeze({ const: 2 }),
      capabilities: Object.freeze({
        type: "array",
        maxItems: 10,
        uniqueItems: true,
        items: Object.freeze({ enum: RLM_V2_CAPABILITIES }),
      }),
      steps: Object.freeze({
        type: "array",
        maxItems: 32,
        items: Object.freeze({ $ref: "#/$defs/rlmStep" }),
      }),
      result: Object.freeze({ $ref: "#/$defs/rlmExpression" }),
    }),
    examples: Object.freeze([
      rlmV2ProgramExample,
      rlmV2RoutingInspectionExample,
    ]),
  }),
});

export const HRA_RLM_DYNAMIC_TOOL_SPEC = deepFreeze(Object.freeze({
  type: "namespace",
  name: HRA_DYNAMIC_TOOL_NAMESPACE,
  description: "Run one bounded HRA recursive orchestration program using metaharness semantic contract v1.",
  tools: [Object.freeze({
    type: "function",
    name: HRA_RLM_DYNAMIC_TOOL_NAME,
    description: "Submit or inspect one durable bounded RLM program without evaluating arbitrary code.",
      inputSchema: Object.freeze({
        type: "object",
        additionalProperties: false,
        required: ["schemaVersion", "action"],
        $defs: rlmV2JsonSchemaDefinitions,
        properties: Object.freeze({
        schemaVersion: Object.freeze({ const: 1 }),
        action: Object.freeze({
          enum: ["submit", "status", "wait", "result", "cancel"],
        }),
        program: Object.freeze({
          $ref: "#/$defs/rlmProgram",
          description: "Required only for submit. See the complete RLM v2 AST and example in $defs.",
        }),
        runId: Object.freeze({
          type: "string",
          pattern: "^rlmrun_[A-Za-z0-9_-]+$",
          maxLength: 96,
        }),
        timeoutMs: Object.freeze({
          type: "integer",
          minimum: 0,
          maximum: 30_000,
        }),
      }),
    }),
    deferLoading: false,
  })],
} as const));

const probeEvidencePayloadSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("oprte.codex.dynamic-tool.real-probe-witness"),
  source: z.literal("signed-in-real-app-server"),
  runId: z.string().uuid(),
  startedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }),
  codexVersion: z.literal(PINNED_CODEX_DYNAMIC_TOOL_VERSION),
  binarySha256: z.string().regex(SHA_256_PATTERN),
  processGeneration: positiveSafeIntegerSchema,
  registration: z.object({
    initializeExperimentalApi: z.literal(true),
    carrierMethod: z.literal(pinnedCodexMethods.threadStart),
    paramsField: z.literal("dynamicTools"),
    namespace: z.literal(HRA_DYNAMIC_TOOL_NAMESPACE),
    tool: z.literal(HRA_RLM_DYNAMIC_TOOL_NAME),
    specSha256: z.string().regex(SHA_256_PATTERN),
  }).strict(),
  observations: z.object({
    registrationAccepted: z.literal(true),
    exactThreadAndTurnIdentity: z.literal(true),
    successfulCompletion: z.literal(true),
    failedCompletion: z.literal(true),
    cancellationResolution: z.literal(true),
    duplicateCallObserved: z.literal(true),
    duplicateCallRejected: z.literal(true),
    restartGenerationScoped: z.literal(true),
  }).strict(),
}).strict();

const probeWitnessSchema = probeEvidencePayloadSchema.extend({
  evidenceObjectDigest: z.string().regex(SHA_256_PATTERN),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.finishedAt) < Date.parse(value.startedAt)) {
    context.addIssue({ code: "custom", message: "probe finished before it started" });
  }
  if (value.registration.specSha256 !== HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256) {
    context.addIssue({ code: "custom", message: "probe witnessed a different tool spec" });
  }
});

const probeRuntimeBindingSchema = z.object({
  binarySha256: z.string().regex(SHA_256_PATTERN),
  processGeneration: positiveSafeIntegerSchema,
  nowMs: z.number().int().nonnegative().safe(),
}).strict();

const verifiedWitnessBrand: unique symbol = Symbol("PinnedCodexDynamicToolProbeWitness");
const verifiedProbeWitnesses = new WeakSet<object>();

export interface PinnedCodexDynamicToolProbeWitness {
  readonly [verifiedWitnessBrand]: true;
  readonly runId: string;
  readonly binarySha256: string;
  readonly processGeneration: number;
  readonly finishedAt: string;
  readonly evidenceObjectDigest: string;
}

export type PinnedCodexDynamicToolProbeRuntimeBinding = z.infer<
  typeof probeRuntimeBindingSchema
>;

export interface PinnedCodexDynamicToolEvidenceReadback {
  readonly digest: string;
  readonly bytes: Uint8Array;
}

/**
 * Trusted composition boundary. Implementations authenticate immutable,
 * signed-in real-app-server probe provenance before returning any bytes.
 */
export interface PinnedCodexDynamicToolEvidenceCustody {
  readVerifiedProbeEvidence(input: Readonly<{
    digest: string;
    runId: string;
    binarySha256: string;
    processGeneration: number;
  }>): Promise<PinnedCodexDynamicToolEvidenceReadback | null>;
}

export interface PinnedCodexDynamicToolCall {
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly namespace: typeof HRA_DYNAMIC_TOOL_NAMESPACE;
  readonly tool: typeof HRA_RLM_DYNAMIC_TOOL_NAME;
  readonly arguments: PinnedCodexDynamicToolArguments;
  readonly argumentsSha256: string;
}

export interface PinnedCodexDynamicToolCallerBinding {
  readonly accountProfileId: string;
  readonly accountGeneration: number;
}

export interface PinnedCodexDynamicToolRequest {
  readonly method: "item/tool/call";
  readonly params: PinnedCodexDynamicToolCall;
  readonly generation: number;
  readonly id: CodexRequestId;
  readonly requestInstanceId: number;
  readonly streamPosition: CodexStreamPosition;
  readonly accountProfileId: string;
  readonly accountGeneration: number;
}

export type PinnedCodexDynamicToolResponse = z.infer<typeof dynamicToolResponseSchema>;

export type PinnedCodexDynamicToolAdmission =
  | Readonly<{ kind: "accepted"; key: string }>
  | Readonly<{ kind: "duplicate"; key: string }>
  | Readonly<{ kind: "replay_conflict"; key: string }>;

/**
 * A generation-local receipt ledger. The provider request id is deliberately
 * not part of the key: a replay under a fresh JSON-RPC id is still a replay.
 */
export class PinnedCodexDynamicToolLedger {
  readonly #argumentsByCall = new Map<string, string>();

  admit(generation: number, call: PinnedCodexDynamicToolCall): PinnedCodexDynamicToolAdmission {
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new Error("Codex process generation must be a positive safe integer");
    }
    const key = dynamicToolCallKey(generation, call);
    const priorDigest = this.#argumentsByCall.get(key);
    if (priorDigest === undefined) {
      this.#argumentsByCall.set(key, call.argumentsSha256);
      return { kind: "accepted", key };
    }
    return priorDigest === call.argumentsSha256
      ? { kind: "duplicate", key }
      : { kind: "replay_conflict", key };
  }
}

export const HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256 = sha256Canonical(
  HRA_RLM_DYNAMIC_TOOL_SPEC,
);
export const HRA_RLM_DYNAMIC_TOOL_V1_SPEC_SHA256 =
  "3e98e085a6bd241f257e161de4c9486c8490dda2c9675bf6d951188c2dc77ed5" as const;

if (HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256 !== HRA_RLM_DYNAMIC_TOOL_V1_SPEC_SHA256) {
  throw new Error("HRA RLM dynamic-tool v1 spec digest drifted");
}

export type HraRlmDynamicToolDigestPurpose = "fresh" | "recovery";
export type HraRlmDynamicToolDigestClassification =
  | "current"
  | "predecessorRecoveryOnly";

/**
 * The current digest admits fresh work after its exact live probe. The
 * predecessor digest is deliberately one-way: it can identify an already
 * durable operation during recovery but cannot authorize a new effect.
 */
export function classifyHraRlmDynamicToolSpecDigest(
  digest: unknown,
  purpose: HraRlmDynamicToolDigestPurpose,
): HraRlmDynamicToolDigestClassification | null {
  if (digest === HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256) return "current";
  if (
    purpose === "recovery" &&
    (
      digest === HRA_RLM_PREDECESSOR_DYNAMIC_TOOL_SPEC_SHA256 ||
      digest === HRA_RLM_PRE_ROUTING_INSPECT_DYNAMIC_TOOL_SPEC_SHA256
    )
  ) {
    return "predecessorRecoveryOnly";
  }
  return null;
}

export const pinnedCodexDynamicToolGeneratedAssociationWitness = Object.freeze({
  call: true,
  response: true,
  spec: true,
} satisfies {
  readonly call: z.output<
    typeof dynamicToolCallParamsSchema
  > extends GeneratedDynamicToolCallParams ? true : false;
  readonly response: z.output<
    typeof dynamicToolResponseSchema
  > extends GeneratedDynamicToolCallResponse ? true : false;
  // The exported constant is recursively frozen, so its readonly arrays are
  // intentionally stricter than the generated mutable transport shape. The
  // parsed wire value is the actual generated-contract association boundary.
  readonly spec: z.output<typeof dynamicToolSpecSchema> extends GeneratedDynamicToolSpec
    ? true
    : false;
});

/**
 * Converts a complete, signed-in real-app-server probe document into the
 * opaque capability required to admit `item/tool/call`, but only after the
 * trusted custody boundary returns the exact immutable evidence object. The
 * adapter reads no environment flag, CLI token, reusable SDK bearer, or raw
 * syntactically valid JSON as an alternative.
 */
export async function acceptPinnedCodexDynamicToolProbeWitness(
  evidence: unknown,
  runtimeValue?: unknown,
  custody?: PinnedCodexDynamicToolEvidenceCustody,
): Promise<PinnedCodexDynamicToolProbeWitness | null> {
  let parsed: ReturnType<typeof probeWitnessSchema.safeParse>;
  let runtime: ReturnType<typeof probeRuntimeBindingSchema.safeParse>;
  try {
    parsed = probeWitnessSchema.safeParse(evidence);
    runtime = probeRuntimeBindingSchema.safeParse(runtimeValue);
  } catch {
    return null;
  }
  if (
    !parsed.success ||
    !runtime.success ||
    custody === undefined ||
    !probeWitnessMatchesRuntime(parsed.data, runtime.data)
  ) {
    return null;
  }

  let readback: PinnedCodexDynamicToolEvidenceReadback | null;
  try {
    readback = await custody.readVerifiedProbeEvidence({
      digest: parsed.data.evidenceObjectDigest,
      runId: parsed.data.runId,
      binarySha256: parsed.data.binarySha256,
      processGeneration: parsed.data.processGeneration,
    });
  } catch {
    return null;
  }
  if (
    readback === null ||
    readback.digest !== parsed.data.evidenceObjectDigest ||
    !(readback.bytes instanceof Uint8Array) ||
    readback.bytes.byteLength === 0 ||
    readback.bytes.byteLength > MAX_CODEX_DYNAMIC_TOOL_PROBE_EVIDENCE_BYTES ||
    sha256Bytes(readback.bytes) !== parsed.data.evidenceObjectDigest
  ) {
    return null;
  }
  let evidenceValue: unknown;
  try {
    evidenceValue = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(readback.bytes),
    ) as unknown;
  } catch {
    return null;
  }
  const evidencePayload = probeEvidencePayloadSchema.safeParse(evidenceValue);
  if (
    !evidencePayload.success ||
    sha256Canonical(evidencePayload.data) !==
      sha256Canonical(withoutProbeEvidenceDigest(parsed.data))
  ) {
    return null;
  }

  const verified = Object.freeze({
    [verifiedWitnessBrand]: true as const,
    runId: parsed.data.runId,
    binarySha256: parsed.data.binarySha256,
    processGeneration: parsed.data.processGeneration,
    finishedAt: parsed.data.finishedAt,
    evidenceObjectDigest: parsed.data.evidenceObjectDigest,
  });
  verifiedProbeWitnesses.add(verified);
  return verified;
}

/** The runtime binding is mandatory. A unary syntactic-brand check is false. */
export function isPinnedCodexDynamicToolProbeWitness(
  value: unknown,
  runtimeValue?: unknown,
): value is PinnedCodexDynamicToolProbeWitness {
  try {
    const runtime = probeRuntimeBindingSchema.safeParse(runtimeValue);
    return runtime.success &&
      typeof value === "object" && value !== null &&
      verifiedProbeWitnesses.has(value) &&
      verifiedWitnessBrand in value &&
      (value as { readonly [verifiedWitnessBrand]?: unknown })[verifiedWitnessBrand] === true &&
      typeof (value as { readonly binarySha256?: unknown }).binarySha256 === "string" &&
      typeof (value as { readonly processGeneration?: unknown }).processGeneration === "number" &&
      typeof (value as { readonly finishedAt?: unknown }).finishedAt === "string" &&
      (value as PinnedCodexDynamicToolProbeWitness).binarySha256 ===
        runtime.data.binarySha256 &&
      (value as PinnedCodexDynamicToolProbeWitness).processGeneration ===
        runtime.data.processGeneration &&
      probeFinishedAtIsFresh(
        (value as PinnedCodexDynamicToolProbeWitness).finishedAt,
        runtime.data.nowMs,
      );
  } catch {
    return false;
  }
}

export function parsePinnedCodexDynamicToolCall(
  params: unknown,
): PinnedCodexDynamicToolCall | null {
  return nullOnThrow(() => {
    const parsed = dynamicToolCallParamsSchema.safeParse(params);
    if (!parsed.success) return null;
    const argumentsValue = normalizeDynamicToolArguments(parsed.data.arguments);
    if (argumentsValue === null) return null;
    return Object.freeze({
      ...parsed.data,
      arguments: argumentsValue,
      argumentsSha256: sha256Canonical(argumentsValue),
    });
  });
}

export function parsePinnedCodexDynamicToolResponse(
  value: unknown,
): PinnedCodexDynamicToolResponse | null {
  return nullOnThrow(() => {
    const parsed = dynamicToolResponseSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  });
}

export function parsePinnedCodexDynamicToolSpec(
  value: unknown,
): GeneratedDynamicToolSpec | null {
  return nullOnThrow(() => {
    const parsed = dynamicToolSpecSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  });
}

export function parsePinnedCodexDynamicToolCallerBinding(
  value: unknown,
): PinnedCodexDynamicToolCallerBinding | null {
  return nullOnThrow(() => {
    const parsed = z.object({
      accountProfileId: accountProfileIdSchema,
      accountGeneration: positiveSafeIntegerSchema,
    }).strict().safeParse(value);
    return parsed.success ? parsed.data : null;
  });
}

export function dynamicToolCallKey(
  generation: number,
  call: Pick<PinnedCodexDynamicToolCall, "threadId" | "turnId" | "callId">,
): string {
  return JSON.stringify([generation, call.threadId, call.turnId, call.callId]);
}

function normalizeDynamicToolArguments(
  value: z.output<typeof dynamicToolArgumentsSchema>,
): PinnedCodexDynamicToolArguments | null {
  switch (value.action) {
    case "submit":
      return value.program === undefined
        ? null
        : Object.freeze({
          schemaVersion: 1,
          action: "submit",
          program: value.program,
        });
    case "wait":
      return value.runId === undefined || value.timeoutMs === undefined
        ? null
        : Object.freeze({
          schemaVersion: 1,
          action: "wait",
          runId: value.runId,
          timeoutMs: value.timeoutMs,
        });
    case "status":
    case "result":
    case "cancel":
      return value.runId === undefined
        ? null
        : Object.freeze({
          schemaVersion: 1,
          action: value.action,
          runId: value.runId,
        });
  }
}

function isBoundedJsonValue(value: unknown): value is PinnedCodexJsonValue {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return false;
    if (
      candidate === null ||
      typeof candidate === "boolean" ||
      typeof candidate === "string"
    ) {
      return typeof candidate !== "string" || candidate.length <= MAX_JSON_STRING_CHARACTERS;
    }
    if (typeof candidate === "number") return Number.isFinite(candidate);
    if (Array.isArray(candidate)) {
      return candidate.length <= MAX_JSON_NODES &&
        candidate.every((entry) => visit(entry, depth + 1));
    }
    if (typeof candidate !== "object") return false;
    const prototype = Reflect.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const entries = Object.entries(candidate);
    if (entries.length > MAX_JSON_OBJECT_KEYS) return false;
    return entries.every(([key, entry]) =>
      key.length > 0 &&
      key.length <= MAX_ID_CHARACTERS &&
      key !== "__proto__" &&
      key !== "constructor" &&
      key !== "prototype" &&
      visit(entry, depth + 1));
  };
  try {
    if (!visit(value, 0)) return false;
    return encodedBytes(value) <= MAX_CODEX_DYNAMIC_TOOL_ARGUMENT_BYTES;
  } catch {
    return false;
  }
}

function encodedBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function probeWitnessMatchesRuntime(
  witness: z.infer<typeof probeWitnessSchema>,
  runtime: PinnedCodexDynamicToolProbeRuntimeBinding,
): boolean {
  return witness.binarySha256 === runtime.binarySha256 &&
    witness.processGeneration === runtime.processGeneration &&
    probeFinishedAtIsFresh(witness.finishedAt, runtime.nowMs);
}

function probeFinishedAtIsFresh(finishedAt: string, nowMs: number): boolean {
  const finishedAtMs = Date.parse(finishedAt);
  return Number.isFinite(finishedAtMs) &&
    finishedAtMs <= nowMs &&
    nowMs - finishedAtMs <= PINNED_CODEX_DYNAMIC_TOOL_PROBE_MAX_AGE_MS;
}

function withoutProbeEvidenceDigest(
  witness: z.infer<typeof probeWitnessSchema>,
): z.infer<typeof probeEvidencePayloadSchema> {
  const { evidenceObjectDigest, ...payload } = witness;
  void evidenceObjectDigest;
  return payload;
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalizeJson(value))).digest("hex");
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, canonicalizeJson(entry)]),
    );
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze(Reflect.get(value, key));
    }
    Object.freeze(value);
  }
  return value;
}

function nullOnThrow<T>(operation: () => T | null): T | null {
  try {
    return operation();
  } catch {
    return null;
  }
}
