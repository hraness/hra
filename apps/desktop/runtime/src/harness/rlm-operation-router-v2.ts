import { z } from "@hra-internal/schema";

import {
  HARNESS_MIN_CONTEXT_BYTES,
  HRA_METAHARNESS_LEGACY_POLICY_VERSION,
  HRA_METAHARNESS_POLICY_VERSION,
  STANDARD_ACTOR_TURN_ACCELERATION,
  actorBudgetSchema,
  actorIdSchema,
  actorResultSchema,
  actorTurnAccelerationSchema,
  actorTurnIdSchema,
  actorTurnSchema,
  actorWorkClassSchema,
  isTerminalActorTurnState,
  type ActorTurnAcceleration,
  type ActorResult,
  type ActorTurn,
} from "./actor-domain";
import { contextSnapshotIdSchema } from "./domain";
import {
  PersistentActorError,
  type PersistentActorCoordinator,
  type PersistentActorStatus,
  type PersistentActorTurnView,
  type PersistentActorWaitAllResult,
  type PersistentActorWaitAnyResult,
} from "./persistent-actors";
import type { HarnessProposalService } from "./proposal-service";
import {
  RLM_V2_MAX_COLLECTION_ITEMS,
  RLM_V2_MAX_NESTING,
  RLM_V2_MAX_VALUE_UTF8_BYTES,
  RlmV2OperationReplayRequiredError,
  rlmV2OperationSchema,
  type RlmV2JsonValue,
  type RlmV2Operation,
  type RlmV2OperationContext,
  type RlmV2OperationPort,
} from "./rlm-v2";

const valueIdSchema = z.string().min(16).max(96)
  .regex(/^ctxval_[A-Za-z0-9_-]+$/u);
const proposalTitleSchema = z.string().min(1).max(160).refine(
  (value) => value === value.trim() && !value.includes("\0"),
  "proposal title must be trimmed and NUL-free",
);
const actorTitleSchema = z.string().min(1).max(160).refine(
  (value) => value === value.trim() && !value.includes("\0"),
  "actor title must be trimmed and NUL-free",
);
const operationArgumentsSchema = z.record(z.string(), z.unknown());
const allocationShareSchema = z.number().int().min(1).max(10_000);
const actorAllocationSchema = z.object({
  tokenShareBps: allocationShareSchema,
  byteShareBps: allocationShareSchema,
  activeDescendantShareBps: allocationShareSchema,
  durableDescendantShareBps: allocationShareSchema,
}).strict();
export const rlmV2ActorOperationContractSchema = z.enum([
  "current",
  "predecessorRecoveryOnly",
]);
export type RlmV2ActorOperationContract = z.infer<
  typeof rlmV2ActorOperationContractSchema
>;

const currentActorSpawnArgumentsSchema = z.object({
  title: actorTitleSchema,
  workClass: actorWorkClassSchema,
  acceleration: actorTurnAccelerationSchema,
  allocation: actorAllocationSchema,
  inputValueId: valueIdSchema,
}).strict();
const predecessorActorSpawnArgumentsSchema = z.object({
  title: actorTitleSchema,
  allocation: actorAllocationSchema,
  inputValueId: valueIdSchema,
}).strict();
const currentActorSendArgumentsSchema = z.object({
  actorId: actorIdSchema,
  inputValueId: valueIdSchema,
  acceleration: actorTurnAccelerationSchema.optional()
    .default(STANDARD_ACTOR_TURN_ACCELERATION),
}).strict();
const predecessorActorSendArgumentsSchema = z.object({
  actorId: actorIdSchema,
  inputValueId: valueIdSchema,
}).strict();

export type RlmV2ActorSpawnArguments = Readonly<{
  title: string;
  policyVersion: 0 | 1;
  workClass:
    | z.infer<typeof actorWorkClassSchema>
    | "legacyUnclassified";
  acceleration: ActorTurnAcceleration;
  allocation: z.infer<typeof actorAllocationSchema>;
  inputValueId: string;
}>;

export type RlmV2ActorSendArguments = Readonly<{
  acceleration: ActorTurnAcceleration;
  actorId: string;
  inputValueId: string;
}>;
const transferredActorResultSchema = z.object({
  valueId: valueIdSchema,
  kind: z.literal("text"),
  utf8Bytes: z.number().int().nonnegative()
    .max(RLM_V2_MAX_VALUE_UTF8_BYTES),
}).strict();

const actorBindingSchema = z.object({
  epochId: z.string().min(16).max(96).regex(/^hepoch_[A-Za-z0-9_-]+$/u),
  actorId: actorIdSchema,
  turnId: actorTurnIdSchema,
  actorDepth: z.number().int().min(0).max(3),
  completedPrefixSnapshotId: contextSnapshotIdSchema,
  currentUserInputValueId: valueIdSchema.nullable(),
  contextQuotaBytes: z.number().int().min(1024 * 1024)
    .max(64 * 1024 * 1024),
}).strict();

export type RlmV2ActorBinding = z.infer<typeof actorBindingSchema>;

export interface RlmV2ActorBindingPort {
  /** Resolve and revalidate the exact durable caller for every operation. */
  resolve(context: RlmV2OperationContext): Promise<unknown>;
}

export type RlmV2ContextOperation = Extract<RlmV2Operation,
  | "context.snapshot"
  | "context.search"
  | "context.slice"
  | "context.materialize"
  | "heap.put"
  | "heap.get"
  | "heap.list">;

export interface RlmV2ContextOperationPort {
  invoke(
    operation: RlmV2ContextOperation,
    argumentsValue: Readonly<Record<string, RlmV2JsonValue>>,
    input: Readonly<{
      binding: RlmV2ActorBinding;
      receiptId: string;
      signal: AbortSignal;
    }>,
  ): Promise<unknown>;
}

type ActorCoordinatorPort = Pick<PersistentActorCoordinator,
  | "spawn"
  | "send"
  | "status"
  | "waitAny"
  | "waitAll"
  | "result"
  | "cancel">;

type ProposalServicePort = Pick<HarnessProposalService, "propose">;

/**
 * Copies one authenticated child result into caller-owned encrypted heap
 * custody. The returned value ID must be readable by the caller's ordinary
 * heap.get path; implementations must never return a child-owned source ID.
 */
export interface RlmV2ActorResultTransferPort {
  transfer(input: Readonly<{
    epochId: string;
    callerActorId: string;
    callerTurnId: string;
    sourceActorId: string;
    sourceTurnId: string;
    sourceValueId: string;
    receiptId: string;
    quotaLimitBytes: number;
  }>): Promise<unknown>;
}

export interface RlmV2OperationRouterOptions {
  readonly bindings: RlmV2ActorBindingPort;
  readonly context: RlmV2ContextOperationPort;
  readonly actors: ActorCoordinatorPort;
  readonly actorResults: RlmV2ActorResultTransferPort;
  readonly proposals: ProposalServicePort;
  /**
   * The predecessor reader is for an already durable v0 operation only. A
   * fresh model call must always use the current exact tool digest and schema.
   */
  readonly actorOperationContract?: RlmV2ActorOperationContract;
  /**
   * Production resolves the contract from the already durable caller. This
   * keeps a migrated v0 actor recoverable without letting a fresh v1 actor
   * select the predecessor schema.
   */
  readonly actorOperationContracts?: Readonly<{
    readForActor(input: Readonly<{
      epochId: string;
      actorId: string;
      turnId: string;
    }>): RlmV2ActorOperationContract;
  }>;
}

/**
 * The only RLM v2 operation switch. Every branch has a strict argument schema,
 * revalidates the durable caller, and returns bounded JSON without provider or
 * account identities, paths, timestamps, or transcript text.
 */
export class RlmV2OperationRouter implements RlmV2OperationPort {
  readonly #bindings: RlmV2ActorBindingPort;
  readonly #context: RlmV2ContextOperationPort;
  readonly #actors: ActorCoordinatorPort;
  readonly #actorResults: RlmV2ActorResultTransferPort;
  readonly #proposals: ProposalServicePort;
  readonly #actorOperationContract: RlmV2ActorOperationContract;
  readonly #actorOperationContracts:
    | NonNullable<RlmV2OperationRouterOptions["actorOperationContracts"]>
    | null;

  constructor(options: RlmV2OperationRouterOptions) {
    this.#bindings = options.bindings;
    this.#context = options.context;
    this.#actors = options.actors;
    this.#actorResults = options.actorResults;
    this.#proposals = options.proposals;
    if (
      options.actorOperationContract !== undefined &&
      options.actorOperationContracts !== undefined
    ) {
      throw new Error("RLM actor operation contract authority is ambiguous");
    }
    this.#actorOperationContract = rlmV2ActorOperationContractSchema.parse(
      options.actorOperationContract ?? "current",
    );
    this.#actorOperationContracts = options.actorOperationContracts ?? null;
  }

  async invoke(
    operationValue: RlmV2Operation,
    argumentsValue: Readonly<Record<string, RlmV2JsonValue>>,
    context: RlmV2OperationContext,
  ): Promise<RlmV2JsonValue> {
    const operation = rlmV2OperationSchema.parse(operationValue);
    const argumentsRecord = operationArgumentsSchema.parse(argumentsValue) as
      Readonly<Record<string, RlmV2JsonValue>>;
    throwIfAborted(context.signal);
    const binding = actorBindingSchema.parse(await this.#bindings.resolve(context));
    if (
      binding.epochId !== context.epochId ||
      binding.actorId !== context.actorId ||
      binding.turnId !== context.turnId
    ) {
      throw new Error("RLM durable caller binding changed");
    }
    throwIfAborted(context.signal);

    let result: unknown;
    switch (operation) {
      case "context.snapshot":
      case "context.search":
      case "context.slice":
      case "context.materialize":
      case "heap.put":
      case "heap.get":
      case "heap.list":
        result = await this.#context.invoke(operation, argumentsRecord, {
          binding,
          receiptId: context.receiptId,
          signal: context.signal,
        });
        break;
      case "agent.spawn": {
        const input = parseRlmV2ActorSpawnArguments(
          argumentsRecord,
          this.#actorContract(binding),
        );
        result = actorSpawnResult(await reconciledActorMutation(async () =>
          await this.#actors.spawn({
            callerActorId: binding.actorId,
            idempotencyKey: context.receiptId,
            title: input.title,
            policyVersion: input.policyVersion,
            workClass: input.workClass,
            acceleration: input.acceleration,
            budget: deriveChildBudget(binding, context, input.allocation),
            inputValueId: input.inputValueId,
          })
        ));
        break;
      }
      case "agent.send": {
        const input = parseRlmV2ActorSendArguments(
          argumentsRecord,
          this.#actorContract(binding),
        );
        result = turnView(await reconciledActorMutation(async () =>
          await this.#actors.send({
            callerActorId: binding.actorId,
            actorId: input.actorId,
            inputValueId: input.inputValueId,
            acceleration: input.acceleration,
            idempotencyKey: context.receiptId,
          })
        ));
        break;
      }
      case "agent.status": {
        const input = z.object({ actorId: actorIdSchema }).strict()
          .parse(argumentsRecord);
        result = actorStatus(await this.#actors.status({
          callerActorId: binding.actorId,
          actorId: input.actorId,
        }));
        break;
      }
      case "agent.waitAny": {
        const input = waitArguments(argumentsRecord);
        result = waitAny(await this.#actors.waitAny({
          callerActorId: binding.actorId,
          ...input,
        }, context.signal));
        break;
      }
      case "agent.waitAll": {
        const input = waitArguments(argumentsRecord);
        result = waitAll(await this.#actors.waitAll({
          callerActorId: binding.actorId,
          ...input,
        }, context.signal));
        break;
      }
      case "agent.result": {
        const input = z.object({ turnId: actorTurnIdSchema }).strict()
          .parse(argumentsRecord);
        const view = await this.#actors.result({
          callerActorId: binding.actorId,
          turnId: input.turnId,
        });
        result = await transferredTurnView(
          view,
          binding,
          context.receiptId,
          this.#actorResults,
        );
        break;
      }
      case "agent.cancel": {
        const input = z.object({ turnId: actorTurnIdSchema }).strict()
          .parse(argumentsRecord);
        const cancelled = await reconciledActorMutation(async () =>
          await this.#actors.cancel({
            callerActorId: binding.actorId,
            turnId: input.turnId,
          })
        );
        if (!isTerminalTurnView(cancelled)) {
          throw new RlmV2OperationReplayRequiredError();
        }
        result = turnView(cancelled);
        break;
      }
      case "harness.propose": {
        const input = z.object({
          title: proposalTitleSchema,
          body: z.unknown(),
        }).strict().parse(argumentsRecord);
        result = await this.#proposals.propose({
          receiptId: context.receiptId,
          epochId: binding.epochId,
          actorId: binding.actorId,
          turnId: binding.turnId,
          title: input.title,
          body: input.body,
          contextQuotaBytes: binding.contextQuotaBytes,
        });
        break;
      }
    }

    throwIfAborted(context.signal);
    return boundedJson(result);
  }

  #actorContract(binding: RlmV2ActorBinding): RlmV2ActorOperationContract {
    return rlmV2ActorOperationContractSchema.parse(
      this.#actorOperationContracts?.readForActor({
        epochId: binding.epochId,
        actorId: binding.actorId,
        turnId: binding.turnId,
      }) ?? this.#actorOperationContract,
    );
  }
}

export function parseRlmV2ActorSpawnArguments(
  value: unknown,
  contractValue: unknown,
): RlmV2ActorSpawnArguments {
  const contract = rlmV2ActorOperationContractSchema.parse(contractValue);
  if (contract === "current") {
    const input = currentActorSpawnArgumentsSchema.parse(value);
    return Object.freeze({
      ...input,
      policyVersion: HRA_METAHARNESS_POLICY_VERSION,
      acceleration: Object.freeze(input.acceleration),
    });
  }
  const input = predecessorActorSpawnArgumentsSchema.parse(value);
  return Object.freeze({
    ...input,
    policyVersion: HRA_METAHARNESS_LEGACY_POLICY_VERSION,
    workClass: "legacyUnclassified",
    acceleration: STANDARD_ACTOR_TURN_ACCELERATION,
  });
}

export function parseRlmV2ActorSendArguments(
  value: unknown,
  contractValue: unknown,
): RlmV2ActorSendArguments {
  const contract = rlmV2ActorOperationContractSchema.parse(contractValue);
  if (contract === "current") {
    const input = currentActorSendArgumentsSchema.parse(value);
    return Object.freeze({
      ...input,
      acceleration: Object.freeze(input.acceleration),
    });
  }
  const input = predecessorActorSendArgumentsSchema.parse(value);
  return Object.freeze({
    ...input,
    acceleration: STANDARD_ACTOR_TURN_ACCELERATION,
  });
}

function deriveChildBudget(
  binding: RlmV2ActorBinding,
  context: RlmV2OperationContext,
  allocation: z.infer<typeof actorAllocationSchema>,
) {
  if (context.budget.depthRemaining < 1) {
    throw new Error("RLM caller has no child depth remaining");
  }
  const durableDescendants = allocatedShare(
    context.budget.durableDescendantLimit,
    allocation.durableDescendantShareBps,
  );
  const activeDescendants = Math.min(
    durableDescendants,
    allocatedShare(
      context.budget.activeDescendantLimit,
      allocation.activeDescendantShareBps,
    ),
  );
  const byteShare = allocatedShare(
    context.budget.heapByteLimit,
    allocation.byteShareBps,
  );
  const byteBudget = Math.max(
    HARNESS_MIN_CONTEXT_BYTES,
    Math.floor(byteShare / HARNESS_MIN_CONTEXT_BYTES) *
      HARNESS_MIN_CONTEXT_BYTES,
  );
  return actorBudgetSchema.parse({
    maxDepth: binding.actorDepth + context.budget.depthRemaining,
    maxActiveDescendants: activeDescendants,
    maxDurableDescendants: durableDescendants,
    tokenBudget: allocatedShare(
      context.budget.tokenBudget,
      allocation.tokenShareBps,
    ),
    byteBudget: Math.min(byteBudget, context.budget.heapByteLimit),
    deadline: context.budget.deadline,
    laneAuthority: context.budget.laneAuthority === "readOnly"
      ? "readOnlySnapshot"
      : "managedWrite",
  });
}

function allocatedShare(limit: number, basisPoints: number): number {
  const allocated = Number(
    (BigInt(limit) * BigInt(basisPoints)) / 10_000n,
  );
  return Math.max(1, Math.min(limit, allocated));
}

async function reconciledActorMutation<Value>(
  operation: () => Promise<Value>,
): Promise<Value> {
  try {
    return await operation();
  } catch (cause: unknown) {
    if (
      cause instanceof PersistentActorError &&
      cause.code === "provider_pending"
    ) {
      throw new RlmV2OperationReplayRequiredError();
    }
    throw cause;
  }
}

function isTerminalTurnView(value: PersistentActorTurnView): boolean {
  return isTerminalActorTurnState(actorTurnSchema.parse(value.turn).state);
}

function waitArguments(value: unknown): Readonly<{
  turnIds: readonly string[];
  timeoutMs: number;
}> {
  return z.object({
    turnIds: z.array(actorTurnIdSchema).min(1)
      .max(RLM_V2_MAX_COLLECTION_ITEMS)
      .refine((values) => new Set(values).size === values.length),
    timeoutMs: z.number().int().min(0).max(300_000),
  }).strict().parse(value);
}

function actorSpawnResult(value: Awaited<ReturnType<ActorCoordinatorPort["spawn"]>>) {
  return {
    actorId: actorIdSchema.parse(value.actor.id),
    turn: turnView(value.turn),
  } as const;
}

function actorStatus(value: PersistentActorStatus) {
  const actorId = actorIdSchema.parse(value.actor.id);
  const liveTurns = value.liveTurns.map((turn) => actorTurnSchema.parse(turn))
    .toSorted(compareTurns);
  return {
    actorId,
    state: value.actor.state,
    liveTurnIds: liveTurns.map((turn) => turn.id),
    latestResult: value.latestResult === null
      ? null
      : publicResult(actorResultSchema.parse(value.latestResult)),
  } as const;
}

function turnView(value: PersistentActorTurnView) {
  const turn = actorTurnSchema.parse(value.turn);
  const result = value.result === null
    ? null
    : actorResultSchema.parse(value.result);
  if (result !== null && result.turnId !== turn.id) {
    throw new Error("actor result does not belong to its logical turn");
  }
  return {
    turnId: turn.id,
    actorId: turn.actorId,
    state: turn.state,
    outcomeCode: turn.outcomeCode,
    result: result === null ? null : publicResult(result),
  } as const;
}

async function transferredTurnView(
  value: PersistentActorTurnView,
  binding: RlmV2ActorBinding,
  receiptId: string,
  transfers: RlmV2ActorResultTransferPort,
) {
  const turn = actorTurnSchema.parse(value.turn);
  const result = value.result === null
    ? null
    : actorResultSchema.parse(value.result);
  if (
    result === null || result.turnId !== turn.id ||
    result.actorId !== turn.actorId || result.epochId !== binding.epochId
  ) {
    if (result !== null) {
      throw new Error("actor result does not belong to its logical turn");
    }
    return turnView(value);
  }
  if (result.outcome !== "succeeded") return turnView(value);
  if (result.valueId === null) {
    throw new Error("successful actor result lacks content authority");
  }
  const transferred = transferredActorResultSchema.parse(
    await transfers.transfer({
      epochId: binding.epochId,
      callerActorId: binding.actorId,
      callerTurnId: binding.turnId,
      sourceActorId: result.actorId,
      sourceTurnId: result.turnId,
      sourceValueId: result.valueId,
      receiptId,
      quotaLimitBytes: binding.contextQuotaBytes,
    }),
  );
  if (transferred.valueId === result.valueId) {
    throw new Error("actor result transfer retained child-owned custody");
  }
  return {
    turnId: turn.id,
    actorId: turn.actorId,
    state: turn.state,
    outcomeCode: turn.outcomeCode,
    result: {
      outcome: result.outcome,
      valueId: transferred.valueId,
      kind: transferred.kind,
      utf8Bytes: transferred.utf8Bytes,
      actorResultOrdinal: result.actorResultOrdinal,
      rootCompletionSequence: result.rootCompletionSequence,
    },
  } as const;
}

function waitAny(value: PersistentActorWaitAnyResult) {
  return {
    state: value.state,
    completed: value.completed === null ? null : turnView(value.completed),
    pendingTurnIds: sortedUniqueTurnIds(value.pendingTurnIds),
  } as const;
}

function waitAll(value: PersistentActorWaitAllResult) {
  const completed = value.completed.map(turnView).toSorted((left, right) =>
    left.turnId.localeCompare(right.turnId)
  );
  return {
    state: value.state,
    completed,
    pendingTurnIds: sortedUniqueTurnIds(value.pendingTurnIds),
  } as const;
}

function publicResult(result: ActorResult) {
  return {
    outcome: result.outcome,
    valueId: result.valueId,
    actorResultOrdinal: result.actorResultOrdinal,
    rootCompletionSequence: result.rootCompletionSequence,
  } as const;
}

function sortedUniqueTurnIds(values: readonly string[]): readonly string[] {
  const parsed = z.array(actorTurnIdSchema).max(RLM_V2_MAX_COLLECTION_ITEMS)
    .parse(values);
  if (new Set(parsed).size !== parsed.length) {
    throw new Error("actor wait result contains duplicate logical turns");
  }
  return parsed.toSorted((left, right) => left.localeCompare(right));
}

function compareTurns(left: ActorTurn, right: ActorTurn): number {
  return left.ordinal - right.ordinal || left.id.localeCompare(right.id);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("RLM operation aborted");
}

function boundedJson(value: unknown): RlmV2JsonValue {
  const normalized = normalizeJson(value, 0);
  if (Buffer.byteLength(canonicalJson(normalized), "utf8") >
      RLM_V2_MAX_VALUE_UTF8_BYTES) {
    throw new Error("RLM operation result exceeds its byte limit");
  }
  return normalized;
}

function normalizeJson(value: unknown, depth: number): RlmV2JsonValue {
  if (depth > RLM_V2_MAX_NESTING) {
    throw new Error("RLM operation result exceeds its nesting limit");
  }
  if (
    value === null || typeof value === "boolean" || typeof value === "string"
  ) return value;
  if (
    typeof value === "number" && Number.isFinite(value) &&
    Math.abs(value) <= Number.MAX_SAFE_INTEGER
  ) return value;
  if (Array.isArray(value)) {
    if (value.length > RLM_V2_MAX_COLLECTION_ITEMS) {
      throw new Error("RLM operation result exceeds its collection limit");
    }
    return Object.freeze(value.map((entry) => normalizeJson(entry, depth + 1)));
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("RLM operation result is not bounded JSON");
  }
  const entries = Object.entries(value);
  if (entries.length > RLM_V2_MAX_COLLECTION_ITEMS) {
    throw new Error("RLM operation result exceeds its collection limit");
  }
  const output: Record<string, RlmV2JsonValue> = Object.create(null) as
    Record<string, RlmV2JsonValue>;
  for (const [key, entry] of entries.toSorted(([left], [right]) =>
    left.localeCompare(right)
  )) {
    if (
      key.length === 0 || key.length > 128 || key === "__proto__" ||
      key === "constructor" || key === "prototype"
    ) throw new Error("RLM operation result contains an invalid key");
    output[key] = normalizeJson(entry, depth + 1);
  }
  return Object.freeze(output);
}

function canonicalJson(value: RlmV2JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, RlmV2JsonValue>>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
