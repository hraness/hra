import { z } from "zod";

import { codexProviderAccountAuthoritySchema, codexProviderAccountIdSchema, providerAccountReadinessSchema } from "./provider-accounts";
import {
  canonicalProviderUsageComponent,
  canonicalProviderUsageJson,
  providerUsageAuthorityModeSchema,
  providerUsageDigest,
  providerUsageQuotaComponentSchema,
  type CodexQuotaUsage,
} from "./provider-usage";
import { automaticRateLimitResetDecision, automaticRateLimitResetObservation } from "./usage-metrics";
import {
  AUTOMATIC_USAGE_ACCOUNT_LIMIT,
  automaticUsageDecision,
  automaticUsagePolicyConfigurationSchema,
  automaticUsageResetGateSchema,
  settledAutomaticPointerMoveSchema,
} from "./usage-policy";
import { profileIdSchema, unixMillisecondsSchema, utf8Bytes } from "./values";

export const AUTOMATIC_POINTER_MOVE_CAPSULE_MAX_BYTES = 4 * 1024 * 1024;
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const observationRevision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const exactAuthority = codexProviderAccountAuthoritySchema.refine((authority) => authority.processGeneration > 0);

/** Fences from an observation, never caller-selected targets or account lists. */
export const automaticPointerMoveRequestSchema = z.object({
  idempotencyKey: z.string().uuid(),
  provider: z.literal("codex"),
  daemonGeneration: revision,
  bootId: z.string().regex(/^boot_[a-f0-9]{32}$/u),
  expectedSourceAuthority: exactAuthority,
  expectedSourceQuotaObservationRevision: observationRevision,
  expectedSourceQuotaComponentDigest: digest,
  expectedResetPolicyRevision: revision,
  expectedAutomaticPolicyRevision: revision,
  expectedOrderRevision: revision,
  expectedPointerRevision: revision,
}).strict();
export type AutomaticPointerMoveRequest = z.infer<typeof automaticPointerMoveRequestSchema>;

export function automaticPointerMoveRequestDigest(value: unknown): string {
  const request = automaticPointerMoveRequestSchema.parse(value);
  // The independent operation key is bound by the capsule and storage anchor.
  return providerUsageDigest({ domain: "oompa:automatic-pointer-move-request:v1",
    provider: request.provider, daemonGeneration: request.daemonGeneration, bootId: request.bootId,
    expectedSourceAuthority: request.expectedSourceAuthority,
    expectedSourceQuotaObservationRevision: request.expectedSourceQuotaObservationRevision,
    expectedSourceQuotaComponentDigest: request.expectedSourceQuotaComponentDigest,
    expectedResetPolicyRevision: request.expectedResetPolicyRevision,
    expectedAutomaticPolicyRevision: request.expectedAutomaticPolicyRevision,
    expectedOrderRevision: request.expectedOrderRevision, expectedPointerRevision: request.expectedPointerRevision,
  });
}

const safeQuotaComponentSchema = providerUsageQuotaComponentSchema.superRefine((component, context) => {
  if (component.source !== "codex_app_server" || component.authority.provider !== "codex") {
    context.addIssue({ code: "custom", message: "Automatic pointer evidence is Codex-only." });
    return;
  }
  try {
    canonicalProviderUsageComponent(component);
  } catch {
    context.addIssue({ code: "custom", message: "Quota component is not canonical evidence." });
  }
});

/**
 * Storage establishes absence/refusal from its rows before admission. A refusal
 * retains only the immutable source identity, never the rejected foreign value.
 * All refusal variants are unselectable, exactly like quota:null in the selector.
 */
export const automaticPointerMoveAccountSchema = z.object({
  authority: codexProviderAccountAuthoritySchema,
  readiness: providerAccountReadinessSchema,
  authorityMode: providerUsageAuthorityModeSchema,
  quota: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("observed"), component: safeQuotaComponentSchema }).strict(),
    z.object({ kind: z.literal("absent") }).strict(),
    z.object({
      kind: z.literal("refused"),
      reason: z.enum(["invalid_quota", "compatibility_display_only", "authority_mismatch"]),
      sourceRevision: observationRevision,
      sourceDigest: digest,
    }).strict(),
  ]),
}).strict();
export type AutomaticPointerMoveAccount = z.infer<typeof automaticPointerMoveAccountSchema>;

const resetPolicySchema = z.object({
  profileId: profileIdSchema,
  state: z.enum(["active_unbound", "active_bound", "reconciliation_required", "window_suppressed"]),
  accountFingerprint: digest.nullable(),
  weeklyWindowResetsAt: unixMillisecondsSchema.nullable(),
  revision,
  createdAt: unixMillisecondsSchema,
  updatedAt: unixMillisecondsSchema,
}).strict();
const noResetGateSchema = automaticUsageResetGateSchema.refine((gate) => gate.state === "not_eligible");

/**
 * These are DB admission facts, not proof that a parsed object committed. The
 * current reset journal lacks the pre-dispatch quota revision; settled/closed
 * same-window attempts therefore cannot enter this first capsule version.
 */
export const automaticPointerMoveResetProofSchema = z.object({
  kind: z.literal("not_eligible"),
  sourceAccountFingerprint: digest,
  policy: resetPolicySchema,
  unresolvedAttemptCount: z.literal(0),
  sameWindowTerminalAttempt: z.null(),
  gate: noResetGateSchema,
}).strict();
export type AutomaticPointerMoveResetProof = z.infer<typeof automaticPointerMoveResetProofSchema>;

export const automaticPointerMoveCapsuleInputSchema = z.object({
  request: automaticPointerMoveRequestSchema,
  moveId: z.string().regex(/^[a-f0-9]{40}$/u),
  evaluatedAt: unixMillisecondsSchema,
  settledAt: unixMillisecondsSchema,
  configuration: automaticUsagePolicyConfigurationSchema,
  orderRevision: revision,
  pointerRevision: revision,
  activeProviderAccountId: codexProviderAccountIdSchema,
  order: z.array(codexProviderAccountIdSchema).min(1).max(AUTOMATIC_USAGE_ACCOUNT_LIMIT),
  accounts: z.array(automaticPointerMoveAccountSchema).min(1).max(AUTOMATIC_USAGE_ACCOUNT_LIMIT),
  resetProof: automaticPointerMoveResetProofSchema,
}).strict();
export type AutomaticPointerMoveCapsuleInput = z.infer<typeof automaticPointerMoveCapsuleInputSchema>;

type Refusal = "invalid_input" | "evidence_overflow" | "decision_not_move" | "reset_proof_invalid";
export class AutomaticPointerMoveCapsuleError extends Error {
  constructor(readonly code: Refusal) {
    super(`AUTOMATIC_POINTER_MOVE_${code.toUpperCase()}`);
    this.name = "AutomaticPointerMoveCapsuleError";
  }
}
function fail(code: Refusal): never { throw new AutomaticPointerMoveCapsuleError(code); }
const same = (left: unknown, right: unknown): boolean => canonicalProviderUsageJson(left) === canonicalProviderUsageJson(right);

/** Reconstruct only the released weekly helper's closed numeric input. */
function resetPayload(quota: CodexQuotaUsage): object {
  const window = (value: CodexQuotaUsage["limits"][number]["primary"]) => {
    if (value === null) return null;
    if (value.resetsAtMs !== null && value.resetsAtMs % 1_000 !== 0) fail("reset_proof_invalid");
    return { usedPercent: value.usedPercent, windowDurationMins: value.windowDurationMins,
      resetsAt: value.resetsAtMs === null ? null : value.resetsAtMs / 1_000 };
  };
  const limit = (value: CodexQuotaUsage["limits"][number]) => ({
    limitId: value.limitId, primary: window(value.primary), secondary: window(value.secondary),
  });
  const legacy = quota.limits.find((entry) => entry.id === "legacy:primary");
  const keyed = quota.limits.filter((entry) => entry.id !== "legacy:primary");
  if (keyed.some((entry) => !entry.id.startsWith("limit:"))) fail("reset_proof_invalid");
  return { rateLimits: {
    primary: legacy === undefined ? { limitId: null, primary: null, secondary: null } : limit(legacy),
    byLimitId: Object.fromEntries(keyed.map((entry) => [entry.id.slice("limit:".length), limit(entry)])),
    resetCreditsAvailable: quota.resetCreditsAvailable,
  } };
}

function deriveMove(input: AutomaticPointerMoveCapsuleInput) {
  const request = input.request;
  if (input.order.length !== input.accounts.length
    || input.order.some((id, index) => id !== input.accounts[index]?.authority.providerAccountId)
    || request.expectedOrderRevision !== input.orderRevision
    || request.expectedPointerRevision !== input.pointerRevision
    || request.expectedAutomaticPolicyRevision !== input.configuration.automaticPolicyRevision
    || input.settledAt < input.evaluatedAt) fail("invalid_input");
  const source = input.accounts.find((account) => account.authority.providerAccountId === input.activeProviderAccountId);
  if (source === undefined || !same(source.authority, request.expectedSourceAuthority)) fail("invalid_input");
  if (source.quota.kind !== "observed" || source.quota.component.quota.format !== "codex_v1") fail("decision_not_move");
  const component = source.quota.component;
  if (component.observationRevision !== request.expectedSourceQuotaObservationRevision
    || component.componentDigest !== request.expectedSourceQuotaComponentDigest
    || !same(component.authority, source.authority)) fail("invalid_input");

  const proof = input.resetProof;
  const policy = proof.policy;
  const payload = resetPayload(source.quota.component.quota);
  const observation = automaticRateLimitResetObservation({ providerPayload: payload, now: input.evaluatedAt });
  const reset = automaticRateLimitResetDecision({ providerPayload: payload, now: input.evaluatedAt });
  if (reset.eligible) fail("reset_proof_invalid");
  const boundary = observation.available ? observation.weeklyWindowResetsAt : null;
  if (policy.profileId !== source.authority.profileId
    || policy.revision !== request.expectedResetPolicyRevision
    || policy.updatedAt < policy.createdAt || policy.updatedAt > input.evaluatedAt
    || (policy.state !== "active_unbound" && policy.state !== "active_bound")
    || (policy.state === "active_unbound" && (policy.accountFingerprint !== null || policy.weeklyWindowResetsAt !== null))
    || (policy.state === "active_bound" && (boundary === null
      || policy.accountFingerprint !== proof.sourceAccountFingerprint || policy.weeklyWindowResetsAt !== boundary))) fail("reset_proof_invalid");
  const expectedGate = {
    authority: source.authority,
    quotaObservationRevision: component.observationRevision,
    resetPolicyRevision: policy.revision,
    resetBoundary: boundary,
    state: "not_eligible",
    reason: reset.reason,
  };
  if (!same(expectedGate, proof.gate)) fail("reset_proof_invalid");
  const decision = automaticUsageDecision({
    provider: "codex", now: input.evaluatedAt, configuration: input.configuration,
    observedSource: source.authority, order: input.order, orderRevision: input.orderRevision,
    activeProviderAccountId: input.activeProviderAccountId, pointerRevision: input.pointerRevision,
    accounts: input.accounts.map((account) => ({ ...account,
      quota: account.quota.kind === "observed" ? account.quota.component : null })),
    resetPolicyRevision: policy.revision, resetGate: proof.gate, nativeFallback: "unavailable",
  });
  if (decision.action !== "propose_pointer_move") fail("decision_not_move");
  const move = settledAutomaticPointerMoveSchema.safeParse({
    version: 1, kind: "settled_automatic_pointer_move", moveId: input.moveId,
    authority: decision.authority, target: decision.target,
    toPointerRevision: input.pointerRevision + 1, settledAt: input.settledAt,
  });
  if (!move.success || move.data.target.authority.processGeneration < 1) fail("decision_not_move");
  return move.data;
}

const capsuleShape = automaticPointerMoveCapsuleInputSchema.extend({
  version: z.literal(1),
  requestDigest: digest,
  move: settledAutomaticPointerMoveSchema,
}).strict();
export const automaticPointerMoveCapsuleSchema = capsuleShape.superRefine((capsule, context) => {
  try {
    if (utf8Bytes(canonicalProviderUsageJson(capsule)) > AUTOMATIC_POINTER_MOVE_CAPSULE_MAX_BYTES) fail("evidence_overflow");
    if (capsule.requestDigest !== automaticPointerMoveRequestDigest(capsule.request)
      || !same(capsule.move, deriveMove(capsule))) fail("invalid_input");
  } catch (error: unknown) {
    context.addIssue({ code: "custom", message: error instanceof AutomaticPointerMoveCapsuleError ? error.code : "invalid_input" });
  }
});
export type AutomaticPointerMoveCapsule = z.infer<typeof automaticPointerMoveCapsuleSchema>;

/** Internal consistency only: storage must additionally verify its durable seal. */
export function verifyAutomaticPointerMoveCapsule(value: unknown): AutomaticPointerMoveCapsule {
  const result = automaticPointerMoveCapsuleSchema.safeParse(value);
  if (!result.success) fail(result.error.issues.some((issue) => issue.message === "evidence_overflow") ? "evidence_overflow" : "invalid_input");
  return result.data;
}

export function automaticPointerMoveCapsuleDigest(value: unknown): string {
  return providerUsageDigest({ domain: "oompa:automatic-pointer-move-capsule:v1", capsule: verifyAutomaticPointerMoveCapsule(value) });
}

export type CreateAutomaticPointerMoveCapsuleResult =
  | Readonly<{ status: "created"; capsule: AutomaticPointerMoveCapsule; canonicalJson: string; digest: string; utf8Bytes: number }>
  | Readonly<{ status: "refused"; reason: Refusal }>;

/** Pure evidence construction; a created capsule is NOT a committed move. */
export function createAutomaticPointerMoveCapsule(value: unknown): CreateAutomaticPointerMoveCapsuleResult {
  const parsed = automaticPointerMoveCapsuleInputSchema.safeParse(value);
  if (!parsed.success) return { status: "refused", reason: "invalid_input" };
  try {
    if (utf8Bytes(canonicalProviderUsageJson(parsed.data)) > AUTOMATIC_POINTER_MOVE_CAPSULE_MAX_BYTES) fail("evidence_overflow");
    const capsule = verifyAutomaticPointerMoveCapsule({ ...parsed.data, version: 1,
      requestDigest: automaticPointerMoveRequestDigest(parsed.data.request), move: deriveMove(parsed.data) });
    const canonicalJson = canonicalProviderUsageJson(capsule);
    return { status: "created", capsule, canonicalJson,
      digest: automaticPointerMoveCapsuleDigest(capsule), utf8Bytes: utf8Bytes(canonicalJson) };
  } catch (error: unknown) {
    return { status: "refused", reason: error instanceof AutomaticPointerMoveCapsuleError ? error.code : "invalid_input" };
  }
}
