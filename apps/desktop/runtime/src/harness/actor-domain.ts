import { createHash } from "node:crypto";

import { z } from "@hra-internal/schema";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const opaqueId = (prefix: string) => z.string()
  .min(prefix.length + 9)
  .max(96)
  .regex(new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`, "u"));
const isoTimestampSchema = z.string().length(24).datetime().refine((value) => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value;
}, "actor timestamps must use canonical UTC milliseconds");

export const HARNESS_MAX_DEPTH = 3;
export const HARNESS_MAX_ACTIVE_DESCENDANTS = 8;
export const HARNESS_MAX_DURABLE_DESCENDANTS = 50;
export const HARNESS_MIN_CONTEXT_BYTES = 1024 * 1024;
export const HARNESS_MAX_CONTEXT_BYTES = 64 * 1024 * 1024;

/**
 * Policy version zero is retained only to describe actors created before the
 * model-visible metaharness contract. New actor admission always uses v1.
 */
export const HRA_METAHARNESS_LEGACY_POLICY_VERSION = 0 as const;
export const HRA_METAHARNESS_POLICY_VERSION = 1 as const;
export const actorPolicyVersionSchema = z.union([
  z.literal(HRA_METAHARNESS_LEGACY_POLICY_VERSION),
  z.literal(HRA_METAHARNESS_POLICY_VERSION),
]);
export type ActorPolicyVersion = z.infer<typeof actorPolicyVersionSchema>;

export const actorWorkClassSchema = z.enum([
  "largeChange",
  "wideResearch",
  "standard",
  "boundedLeaf",
]);
export type ActorWorkClass = z.infer<typeof actorWorkClassSchema>;

export const legacyActorWorkClassSchema = z.literal("legacyUnclassified");
export const persistedActorWorkClassSchema = z.union([
  actorWorkClassSchema,
  legacyActorWorkClassSchema,
]);
export type PersistedActorWorkClass = z.infer<
  typeof persistedActorWorkClassSchema
>;

export const actorTurnFastBottleneckSchema = z.enum([
  "reasoning",
  "fileGeneration",
]);
export const actorTurnAccelerationSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("standard"),
  }).strict(),
  z.object({
    mode: z.literal("fast"),
    criticalPath: z.literal(true),
    bottleneck: actorTurnFastBottleneckSchema,
  }).strict(),
]);
export type ActorTurnAcceleration = z.infer<
  typeof actorTurnAccelerationSchema
>;

export const STANDARD_ACTOR_TURN_ACCELERATION: ActorTurnAcceleration =
  Object.freeze({ mode: "standard" });

export function parseActorWorkClass(value: unknown): ActorWorkClass | null {
  const parsed = actorWorkClassSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseActorTurnAcceleration(
  value: unknown,
): ActorTurnAcceleration | null {
  const parsed = actorTurnAccelerationSchema.safeParse(value);
  return parsed.success ? Object.freeze(parsed.data) : null;
}

export const actorEpochIdSchema = opaqueId("hepoch");
export const actorIdSchema = opaqueId("hactor");
export const actorTurnIdSchema = opaqueId("hturn");
export const actorAttemptIdSchema = opaqueId("hattempt");
export const actorResultIdSchema = opaqueId("hresult");
export const actorOperationIdSchema = opaqueId("hoperation");

export const actorLaneAuthoritySchema = z.enum([
  "readOnlySnapshot",
  "managedWrite",
]);

export const actorBudgetSchema = z.object({
  maxDepth: z.number().int().min(0).max(HARNESS_MAX_DEPTH),
  maxActiveDescendants: z.number().int().min(1)
    .max(HARNESS_MAX_ACTIVE_DESCENDANTS),
  maxDurableDescendants: z.number().int().min(1)
    .max(HARNESS_MAX_DURABLE_DESCENDANTS),
  tokenBudget: z.number().int().positive().safe(),
  byteBudget: z.number().int()
    .min(HARNESS_MIN_CONTEXT_BYTES)
    .max(HARNESS_MAX_CONTEXT_BYTES)
    .refine(
      (value) => value % HARNESS_MIN_CONTEXT_BYTES === 0,
      "actor byte budgets must use whole MiB increments",
    ),
  deadline: isoTimestampSchema,
  laneAuthority: actorLaneAuthoritySchema,
}).strict();

export type ActorBudget = z.infer<typeof actorBudgetSchema>;

export const actorEpochSchema = z.object({
  id: actorEpochIdSchema,
  projectId: z.string().min(1).max(128),
  sourceSha: z.string().regex(/^[0-9a-f]{40,64}$/u),
  rootActorId: actorIdSchema,
  budget: actorBudgetSchema,
  tokenReserved: z.number().int().nonnegative().safe(),
  byteReserved: z.number().int().nonnegative().safe(),
  nextRootCompletionSequence: z.number().int().positive().safe(),
  state: z.enum(["active", "stopRequested", "stopped", "quarantined"]),
  revision: z.number().int().positive().safe(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  stoppedAt: isoTimestampSchema.nullable(),
}).strict().superRefine((epoch, context) => {
  if (epoch.tokenReserved > epoch.budget.tokenBudget) {
    context.addIssue({
      code: "custom",
      message: "actor epoch token reservations exceed the root budget",
      path: ["tokenReserved"],
    });
  }
  if (epoch.byteReserved > epoch.budget.byteBudget) {
    context.addIssue({
      code: "custom",
      message: "actor epoch byte reservations exceed the root budget",
      path: ["byteReserved"],
    });
  }
  if ((epoch.state === "stopped" || epoch.state === "quarantined") !==
      (epoch.stoppedAt !== null)) {
    context.addIssue({
      code: "custom",
      message: "only a terminal actor epoch has a stopped timestamp",
      path: ["stoppedAt"],
    });
  }
});

export type ActorEpoch = z.infer<typeof actorEpochSchema>;

export const actorSchema = z.object({
  id: actorIdSchema,
  epochId: actorEpochIdSchema,
  parentActorId: actorIdSchema.nullable(),
  depth: z.number().int().min(0).max(HARNESS_MAX_DEPTH),
  title: z.string().min(1).max(160),
  state: z.enum(["active", "stopRequested", "stopped", "quarantined"]),
  budget: actorBudgetSchema,
  tokenReserved: z.number().int().nonnegative().safe(),
  byteReserved: z.number().int().nonnegative().safe(),
  nextTurnOrdinal: z.number().int().positive().safe(),
  nextResultOrdinal: z.number().int().positive().safe(),
  revision: z.number().int().positive().safe(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  stoppedAt: isoTimestampSchema.nullable(),
}).strict().superRefine((actor, context) => {
  if ((actor.parentActorId === null) !== (actor.depth === 0)) {
    context.addIssue({
      code: "custom",
      message: "only the epoch root actor may have depth zero",
      path: ["parentActorId"],
    });
  }
  if (actor.depth > actor.budget.maxDepth) {
    context.addIssue({
      code: "custom",
      message: "actor depth exceeds its inherited budget",
      path: ["depth"],
    });
  }
  if (actor.tokenReserved > actor.budget.tokenBudget) {
    context.addIssue({
      code: "custom",
      message: "actor token reservations exceed its inherited budget",
      path: ["tokenReserved"],
    });
  }
  if (actor.byteReserved > actor.budget.byteBudget) {
    context.addIssue({
      code: "custom",
      message: "actor byte reservations exceed its inherited budget",
      path: ["byteReserved"],
    });
  }
  if ((actor.state === "stopped" || actor.state === "quarantined") !==
      (actor.stoppedAt !== null)) {
    context.addIssue({
      code: "custom",
      message: "only a terminal actor has a stopped timestamp",
      path: ["stoppedAt"],
    });
  }
});

export type Actor = z.infer<typeof actorSchema>;

export const actorTurnStateSchema = z.enum([
  "prepared",
  "starting",
  "running",
  "reconciling",
  "succeeded",
  "failed",
  "cancelled",
  "quotaRejected",
  "ambiguous",
]);

export const actorTurnSchema = z.object({
  id: actorTurnIdSchema,
  epochId: actorEpochIdSchema,
  actorId: actorIdSchema,
  ordinal: z.number().int().positive().safe(),
  idempotencyKey: z.string().min(16).max(128),
  inputValueId: z.string().min(1).max(96),
  state: actorTurnStateSchema,
  desiredState: z.enum(["run", "stop"]),
  revision: z.number().int().positive().safe(),
  createdAt: isoTimestampSchema,
  startedAt: isoTimestampSchema.nullable(),
  settledAt: isoTimestampSchema.nullable(),
  outcomeCode: z.string().min(1).max(96).nullable(),
}).strict().superRefine((turn, context) => {
  const terminal = isTerminalActorTurnState(turn.state);
  if (terminal !== (turn.settledAt !== null)) {
    context.addIssue({
      code: "custom",
      message: "only a terminal actor turn has a settlement timestamp",
      path: ["settledAt"],
    });
  }
  if ((turn.state !== "prepared") !== (turn.startedAt !== null)) {
    context.addIssue({
      code: "custom",
      message: "a started actor turn requires an exact start timestamp",
      path: ["startedAt"],
    });
  }
  if (terminal !== (turn.outcomeCode !== null)) {
    context.addIssue({
      code: "custom",
      message: "only a terminal actor turn has an outcome code",
      path: ["outcomeCode"],
    });
  }
});

export type ActorTurn = z.infer<typeof actorTurnSchema>;

export const actorAttemptSchema = z.object({
  id: actorAttemptIdSchema,
  turnId: actorTurnIdSchema,
  incarnationId: z.string().min(1).max(96),
  ordinal: z.number().int().positive().safe(),
  accountProfileId: z.string().min(1).max(96),
  processGeneration: z.number().int().positive().safe(),
  clientUserMessageId: z.string().min(16).max(128),
  state: z.enum([
    "starting",
    "running",
    "reconciling",
    "completed",
    "failed",
    "quotaRejected",
    "interrupted",
    "ambiguous",
  ]),
  quotaProofDigest: digestSchema.nullable(),
  createdAt: isoTimestampSchema,
  startedAt: isoTimestampSchema.nullable(),
  settledAt: isoTimestampSchema.nullable(),
}).strict().superRefine((attempt, context) => {
  const terminal = isTerminalActorAttemptState(attempt.state);
  if (terminal !== (attempt.settledAt !== null)) {
    context.addIssue({
      code: "custom",
      message: "only a terminal actor attempt has a settlement timestamp",
      path: ["settledAt"],
    });
  }
  if ((attempt.state === "quotaRejected") !==
      (attempt.quotaProofDigest !== null)) {
    context.addIssue({
      code: "custom",
      message: "only a proven quota rejection may carry quota evidence",
      path: ["quotaProofDigest"],
    });
  }
});

export type ActorAttempt = z.infer<typeof actorAttemptSchema>;

export const actorResultSchema = z.object({
  id: actorResultIdSchema,
  epochId: actorEpochIdSchema,
  actorId: actorIdSchema,
  turnId: actorTurnIdSchema,
  // A cancellation before an effect, or a definitive quota rejection while
  // admitting the provider thread, has a durable logical-turn receipt but no
  // provider-turn attempt. Keeping that distinction explicit avoids
  // inventing an effect identity during replay.
  terminalAttemptId: actorAttemptIdSchema.nullable(),
  outcome: z.enum(["succeeded", "failed", "cancelled", "quotaRejected"]),
  valueId: z.string().min(1).max(96).nullable(),
  actorResultOrdinal: z.number().int().positive().safe(),
  rootCompletionSequence: z.number().int().positive().safe(),
  createdAt: isoTimestampSchema,
}).strict().superRefine((result, context) => {
  if ((result.outcome === "succeeded") !== (result.valueId !== null)) {
    context.addIssue({
      code: "custom",
      message: "only a successful actor result references content",
      path: ["valueId"],
    });
  }
  if (
    result.terminalAttemptId === null &&
    result.outcome !== "cancelled" && result.outcome !== "quotaRejected"
  ) {
    context.addIssue({
      code: "custom",
      message:
        "only a pre-effect cancellation or thread-admission quota rejection omits its terminal attempt",
      path: ["terminalAttemptId"],
    });
  }
});

export type ActorResult = z.infer<typeof actorResultSchema>;

export const actorNodePathSegmentSchema = z.tuple([
  z.enum(["step", "if", "map", "reduce", "parallel"]),
  z.number().int().nonnegative().safe(),
]);
export const actorNodePathSchema = z.array(actorNodePathSegmentSchema).max(64);
export type ActorNodePath = z.infer<typeof actorNodePathSchema>;

export type ActorState = Actor["state"];
export type ActorTurnState = ActorTurn["state"];

const actorStateTransitions: Readonly<Record<ActorState, readonly ActorState[]>> = {
  active: ["stopRequested", "stopped", "quarantined"],
  stopRequested: ["stopped", "quarantined"],
  stopped: [],
  quarantined: [],
};

const actorTurnTransitions: Readonly<
  Record<ActorTurnState, readonly ActorTurnState[]>
> = {
  prepared: ["starting", "cancelled", "quotaRejected"],
  starting: ["running", "reconciling", "failed", "quotaRejected", "ambiguous"],
  running: ["reconciling", "succeeded", "failed", "cancelled", "ambiguous"],
  reconciling: ["running", "succeeded", "failed", "cancelled", "quotaRejected", "ambiguous"],
  succeeded: [],
  failed: [],
  cancelled: [],
  quotaRejected: [],
  ambiguous: [],
};

export class ActorDomainError extends Error {
  readonly code:
    | "budget_exhausted"
    | "invalid_transition"
    | "lineage_conflict"
    | "ordinal_conflict";

  constructor(code: ActorDomainError["code"], message: string) {
    super(message);
    this.name = "ActorDomainError";
    this.code = code;
  }
}

export function deriveChildBudget(
  parentValue: Actor,
  requestedValue: ActorBudget,
): ActorBudget {
  const parent = actorSchema.parse(parentValue);
  const requested = actorBudgetSchema.parse(requestedValue);
  if (parent.state !== "active") {
    throw new ActorDomainError(
      "invalid_transition",
      "only an active actor may admit a child",
    );
  }
  if (parent.depth >= parent.budget.maxDepth) {
    throw new ActorDomainError(
      "budget_exhausted",
      "the recursive depth budget is exhausted",
    );
  }
  const parentDeadline = Date.parse(parent.budget.deadline);
  const requestedDeadline = Date.parse(requested.deadline);
  if (
    requested.maxDepth > parent.budget.maxDepth ||
    requested.maxActiveDescendants > parent.budget.maxActiveDescendants ||
    requested.maxDurableDescendants > parent.budget.maxDurableDescendants ||
    requested.tokenBudget > parent.budget.tokenBudget - parent.tokenReserved ||
    requested.byteBudget > parent.budget.byteBudget - parent.byteReserved ||
    requestedDeadline > parentDeadline ||
    (parent.budget.laneAuthority === "readOnlySnapshot" &&
      requested.laneAuthority !== "readOnlySnapshot")
  ) {
    throw new ActorDomainError(
      "budget_exhausted",
      "a child cannot widen its parent's remaining authority",
    );
  }
  return Object.freeze({ ...requested });
}

export function transitionActor(
  actorValue: Actor,
  nextState: ActorState,
  now: string,
): Actor {
  const actor = actorSchema.parse(actorValue);
  isoTimestampSchema.parse(now);
  if (!actorStateTransitions[actor.state].includes(nextState)) {
    throw new ActorDomainError(
      "invalid_transition",
      `invalid actor transition: ${actor.state} -> ${nextState}`,
    );
  }
  return actorSchema.parse({
    ...actor,
    state: nextState,
    revision: actor.revision + 1,
    updatedAt: now,
    stoppedAt: nextState === "stopped" || nextState === "quarantined"
      ? now
      : null,
  });
}

export function transitionActorTurn(
  turnValue: ActorTurn,
  nextState: ActorTurnState,
  now: string,
  outcomeCode: string | null = null,
): ActorTurn {
  const turn = actorTurnSchema.parse(turnValue);
  isoTimestampSchema.parse(now);
  if (!actorTurnTransitions[turn.state].includes(nextState)) {
    throw new ActorDomainError(
      "invalid_transition",
      `invalid actor turn transition: ${turn.state} -> ${nextState}`,
    );
  }
  const terminal = isTerminalActorTurnState(nextState);
  if (terminal !== (outcomeCode !== null)) {
    throw new ActorDomainError(
      "invalid_transition",
      "terminal actor turns require one bounded outcome code",
    );
  }
  return actorTurnSchema.parse({
    ...turn,
    state: nextState,
    revision: turn.revision + 1,
    startedAt: turn.startedAt ?? (nextState === "prepared" ? null : now),
    settledAt: terminal ? now : null,
    outcomeCode,
  });
}

export function requestActorTurnStop(
  turnValue: ActorTurn,
): ActorTurn {
  const turn = actorTurnSchema.parse(turnValue);
  if (isTerminalActorTurnState(turn.state) || turn.desiredState === "stop") {
    return turn;
  }
  return actorTurnSchema.parse({
    ...turn,
    desiredState: "stop",
    revision: turn.revision + 1,
  });
}

export function assertNextActorResult(input: Readonly<{
  actor: Actor;
  epoch: ActorEpoch;
  turn: ActorTurn;
  attempt: ActorAttempt | null;
  result: ActorResult;
}>): void {
  const actor = actorSchema.parse(input.actor);
  const epoch = actorEpochSchema.parse(input.epoch);
  const turn = actorTurnSchema.parse(input.turn);
  const attempt = input.attempt === null ? null : actorAttemptSchema.parse(input.attempt);
  const result = actorResultSchema.parse(input.result);
  const attemptOutcome = attempt === null
    ? result.outcome === "quotaRejected" ? "quotaRejected" : "cancelled"
    : attempt.state === "completed"
      ? "succeeded"
      : attempt.state === "failed"
        ? "failed"
        : attempt.state === "interrupted"
          ? "cancelled"
          : attempt.state === "quotaRejected"
            ? "quotaRejected"
            : null;
  if (
    actor.epochId !== epoch.id ||
    turn.epochId !== epoch.id ||
    turn.actorId !== actor.id ||
    (attempt !== null && attempt.turnId !== turn.id) ||
    result.epochId !== epoch.id ||
    result.actorId !== actor.id ||
    result.turnId !== turn.id ||
    result.terminalAttemptId !== (attempt?.id ?? null) ||
    result.outcome !== attemptOutcome
  ) {
    throw new ActorDomainError(
      "lineage_conflict",
      "actor result lineage does not match its terminal attempt",
    );
  }
  if (
    result.actorResultOrdinal !== actor.nextResultOrdinal ||
    result.rootCompletionSequence !== epoch.nextRootCompletionSequence
  ) {
    throw new ActorDomainError(
      "ordinal_conflict",
      "actor result ordering does not match the durable counters",
    );
  }
}

export function selectWaitAnyResult(
  values: readonly ActorResult[],
): ActorResult | null {
  const results = values.map((value) => actorResultSchema.parse(value));
  if (results.length === 0) return null;
  return [...results].sort((left, right) =>
    left.rootCompletionSequence - right.rootCompletionSequence ||
    left.actorId.localeCompare(right.actorId) ||
    left.turnId.localeCompare(right.turnId)
  )[0]!;
}

export function actorOperationReceiptId(input: Readonly<{
  runId: string;
  immutableProgramDigest: string;
  nodePath: ActorNodePath;
}>): string {
  const nodePath = actorNodePathSchema.parse(input.nodePath);
  digestSchema.parse(input.immutableProgramDigest);
  return actorOperationIdSchema.parse(`hoperation_${createHash("sha256")
    .update("oprte.rlm.operation.v2\0")
    .update(input.runId)
    .update("\0")
    .update(input.immutableProgramDigest)
    .update("\0")
    .update(canonicalJson(nodePath))
    .digest("base64url")
    .slice(0, 48)}`);
}

export function actorEffectKey(input: Readonly<{
  receiptId: string;
  operation: string;
  requestDigest: string;
  effectSubtype: string;
}>): string {
  actorOperationIdSchema.parse(input.receiptId);
  digestSchema.parse(input.requestDigest);
  for (const value of [input.operation, input.effectSubtype]) {
    if (value.length < 1 || value.length > 96 || value.includes("\0")) {
      throw new TypeError("actor effect identity is invalid");
    }
  }
  return createHash("sha256")
    .update("oprte.rlm.effect.v1\0")
    .update(input.receiptId)
    .update("\0")
    .update(input.operation)
    .update("\0")
    .update(input.requestDigest)
    .update("\0")
    .update(input.effectSubtype)
    .digest("hex");
}

export function isTerminalActorTurnState(state: ActorTurnState): boolean {
  return state === "succeeded" || state === "failed" ||
    state === "cancelled" || state === "quotaRejected" ||
    state === "ambiguous";
}

export function isTerminalActorAttemptState(
  state: ActorAttempt["state"],
): boolean {
  return state === "completed" || state === "failed" ||
    state === "quotaRejected" || state === "interrupted" ||
    state === "ambiguous";
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}
