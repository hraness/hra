import { z } from "zod";

import { providerSchema, type Provider } from "./presets";
import {
  providerAccountAuthoritySchema,
  providerAccountIdSchema,
  providerAccountReadinessSchema,
  sessionRoutingProvenanceSchema,
  type ProviderAccountAuthority,
} from "./provider-accounts";
import {
  canonicalProviderUsageComponent,
  providerUsageAuthorityModeSchema,
  providerUsageQuotaComponentSchema,
  type CodexQuotaUsage,
  type ProviderUsageQuotaComponent,
} from "./provider-usage";
import {
  accountRateLimitResetOutcomeSchema,
  CODEX_WEEKLY_RATE_LIMIT_WINDOW_MINUTES,
  USAGE_EXHAUSTION_USED_PERCENT,
  USAGE_LATEST_STALE_MS,
} from "./usage-metrics";
import { sessionIdSchema, unixMillisecondsSchema } from "./values";

const revisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const observationRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const AUTOMATIC_USAGE_ACCOUNT_LIMIT = 1_000;
export const AUTOMATIC_USAGE_MOVE_LINEAGE_LIMIT = 1_000;
export const AUTOMATIC_USAGE_FRESHNESS_MS = USAGE_LATEST_STALE_MS;

export const automaticUsageOverrideSchema = z.enum(["inherit", "on", "off"]);
export const automaticUsagePolicyConfigurationSchema = z.object({
  version: z.literal(1),
  defaultEnabled: z.boolean(),
  overrides: z.object({
    codex: automaticUsageOverrideSchema,
    claude: automaticUsageOverrideSchema,
  }).strict(),
  automaticPolicyRevision: revisionSchema,
}).strict();
export type AutomaticUsagePolicyConfiguration = z.infer<
  typeof automaticUsagePolicyConfigurationSchema
>;

export function initialAutomaticUsagePolicyConfiguration(): AutomaticUsagePolicyConfiguration {
  return {
    version: 1,
    defaultEnabled: true,
    overrides: { codex: "inherit", claude: "inherit" },
    automaticPolicyRevision: 1,
  };
}

export function resolveAutomaticUsagePolicy(input: Readonly<{
  configuration: unknown;
  provider: Provider;
}>): Readonly<{
  provider: Provider;
  enabled: boolean;
  source: "default" | "override";
  automaticPolicyRevision: number;
}> {
  const configuration = automaticUsagePolicyConfigurationSchema.parse(input.configuration);
  const provider = providerSchema.parse(input.provider);
  const override = configuration.overrides[provider];
  return {
    provider,
    enabled: override === "inherit" ? configuration.defaultEnabled : override === "on",
    source: override === "inherit" ? "default" : "override",
    automaticPolicyRevision: configuration.automaticPolicyRevision,
  };
}

export type UsageObservationFreshness = "fresh" | "stale" | "future";

export function usageObservationFreshness(input: Readonly<{
  receivedAt: number;
  now: number;
}>): UsageObservationFreshness {
  const now = unixMillisecondsSchema.parse(input.now);
  const receivedAt = unixMillisecondsSchema.parse(input.receivedAt);
  if (receivedAt > now) return "future";
  return now - receivedAt <= AUTOMATIC_USAGE_FRESHNESS_MS ? "fresh" : "stale";
}

const sameAuthority = (left: ProviderAccountAuthority, right: ProviderAccountAuthority): boolean =>
  left.provider === right.provider
  && left.profileId === right.profileId
  && left.providerAccountId === right.providerAccountId
  && left.bindingGeneration === right.bindingGeneration
  && left.processGeneration === right.processGeneration;

const sameBinding = (left: ProviderAccountAuthority, right: ProviderAccountAuthority): boolean =>
  left.provider === right.provider
  && left.profileId === right.profileId
  && left.providerAccountId === right.providerAccountId
  && left.bindingGeneration === right.bindingGeneration;

/** Accounting deliberately has no place in the policy input. */
export const usagePolicyAccountSchema = z.object({
  authority: providerAccountAuthoritySchema,
  readiness: providerAccountReadinessSchema,
  authorityMode: providerUsageAuthorityModeSchema,
  quota: z.unknown(),
}).strict();
export type UsagePolicyAccount = z.infer<typeof usagePolicyAccountSchema>;

export const automaticUsageQuotaEvidenceSchema = z.object({
  authority: providerAccountAuthoritySchema,
  quotaObservationRevision: observationRevisionSchema,
  quotaComponentDigest: digestSchema,
  receivedAt: unixMillisecondsSchema,
  observedAt: unixMillisecondsSchema,
  // A fresh observation expires at its first window boundary, even before 90s.
  firstResetAt: unixMillisecondsSchema,
}).strict();
export type AutomaticUsageQuotaEvidence = z.infer<typeof automaticUsageQuotaEvidenceSchema>;

type UsagePolicyWindow = Readonly<{
  id: "primary" | "secondary";
  usedPercent: number;
  windowDurationMins: number;
  resetsAtMs: number;
}>;

export type ProviderUsageAccountClassification =
  | Readonly<{
      state: "unknown";
      reason: "invalid_account" | "account_not_ready" | "display_only"
        | "quota_unavailable" | "invalid_quota" | "authority_mismatch"
        | "future_observation" | "stale_observation" | "codex_limit_unavailable"
        | "invalid_window" | "no_windows" | "window_reset";
    }>
  | Readonly<{ state: "reconciliation_required"; reason: "reached_type_conflict" }>
  | Readonly<{
      state: "observe_only";
      reason: "claude_turn_observation";
      freshness: UsageObservationFreshness;
      exhausted: boolean | null;
      recheckAt: number | null;
    }>
  | Readonly<{
      state: "available" | "exhausted";
      freshness: "fresh" | "stale";
      evidence: AutomaticUsageQuotaEvidence;
      windows: readonly UsagePolicyWindow[];
      resetCreditsAvailable: number;
      recheckAt: number | null;
    }>;

const selectedCodexLimit = (quota: CodexQuotaUsage): CodexQuotaUsage["limits"][number] | null => {
  const ids = quota.limits.map((limit) => limit.id);
  if (new Set(ids).size !== ids.length) return null;
  // An unknown non-legacy identity cannot accidentally reopen the legacy path.
  const keyed = quota.limits.filter((limit) => limit.id !== "legacy:primary");
  if (keyed.some((limit) => !limit.id.startsWith("limit:")
    || (limit.limitId !== null && limit.id !== `limit:${limit.limitId}`))) return null;
  const selected = keyed.length > 0
    ? keyed.find((limit) => limit.id === "limit:codex")
    : quota.limits.find((limit) => limit.id === "legacy:primary");
  return selected !== undefined && (selected.limitId === null || selected.limitId === "codex")
    ? selected : null;
};

function readQuota(value: unknown): ProviderUsageQuotaComponent | null {
  const parsed = providerUsageQuotaComponentSchema.safeParse(value);
  if (!parsed.success) return null;
  try {
    const canonical = canonicalProviderUsageComponent(parsed.data);
    return canonical.component === "quota" ? canonical : null;
  } catch {
    return null;
  }
}

/** A classification is evidence, never permission to dispatch a provider call. */
export function classifyProviderUsageAccount(input: Readonly<{
  account: unknown;
  now: number;
}>): ProviderUsageAccountClassification {
  const now = unixMillisecondsSchema.parse(input.now);
  const parsed = usagePolicyAccountSchema.safeParse(input.account);
  if (!parsed.success) return { state: "unknown", reason: "invalid_account" };
  const account = parsed.data;
  // Explicit Claude sessions may produce exact turn facts while the bounded
  // auth probe remains unverified. That permits explanation, never selection.
  if (account.readiness !== "signed_in"
    && !(account.authority.provider === "claude" && account.readiness === "unverified")) {
    return { state: "unknown", reason: "account_not_ready" };
  }
  if (account.authorityMode !== "mutation_authoritative") {
    return { state: "unknown", reason: "display_only" };
  }
  if (account.quota === null || account.quota === undefined) {
    return { state: "unknown", reason: "quota_unavailable" };
  }
  const component = readQuota(account.quota);
  if (component === null) return { state: "unknown", reason: "invalid_quota" };
  if (!sameAuthority(account.authority, component.authority)) {
    return { state: "unknown", reason: "authority_mismatch" };
  }
  const freshness = usageObservationFreshness({ receivedAt: component.receivedAt, now });
  if (freshness === "future") return { state: "unknown", reason: "future_observation" };
  if (component.quota.format === "claude_v1") {
    const quota = component.quota;
    const blocked = quota.status.state === "known"
      && ["blocked", "denied", "rejected"].includes(quota.status.value);
    const boundaries = quota.windows.filter((window) =>
      window.usedPercent >= USAGE_EXHAUSTION_USED_PERCENT && window.resetsAtMs > now)
      .map((window) => window.resetsAtMs);
    if (blocked && quota.resetsAtMs !== null && quota.resetsAtMs > now) {
      boundaries.push(quota.resetsAtMs);
    }
    return {
      state: "observe_only",
      reason: "claude_turn_observation",
      freshness,
      exhausted: boundaries.length > 0 ? true
        : quota.status.state === "known" && !blocked && freshness === "fresh" ? false : null,
      recheckAt: boundaries.length > 0 ? Math.max(...boundaries) : null,
    };
  }
  const limit = selectedCodexLimit(component.quota);
  if (limit === null) return { state: "unknown", reason: "codex_limit_unavailable" };
  const windows: UsagePolicyWindow[] = [];
  for (const id of ["primary", "secondary"] as const) {
    const window = limit[id];
    if (window === null) continue;
    const durationMs = (window.windowDurationMins ?? 0) * 60_000;
    if (
      window.windowDurationMins === null || durationMs <= 0
      || !Number.isSafeInteger(durationMs)
      || window.resetsAtMs === null || window.resetsAtMs >= 100_000_000_000_000
      || window.resetsAtMs - component.receivedAt > durationMs
    ) return { state: "unknown", reason: "invalid_window" };
    windows.push({ ...window, id, windowDurationMins: window.windowDurationMins, resetsAtMs: window.resetsAtMs });
  }
  if (windows.length === 0) return { state: "unknown", reason: "no_windows" };
  const live = windows.filter((window) => window.resetsAtMs > now);
  const blocking = live.filter((window) => window.usedPercent >= USAGE_EXHAUSTION_USED_PERCENT);
  if (blocking.length === 0 && live.length !== windows.length) {
    return { state: "unknown", reason: "window_reset" };
  }
  if (limit.rateLimitReachedType !== null && blocking.length === 0) {
    return { state: "reconciliation_required", reason: "reached_type_conflict" };
  }
  if (freshness === "stale" && blocking.length === 0) {
    return { state: "unknown", reason: "stale_observation" };
  }
  return {
    state: blocking.length > 0 ? "exhausted" : "available",
    // An expired slot prevents mutation even if another window still proves exhaustion.
    freshness: live.length === windows.length ? freshness : "stale",
    evidence: {
      authority: component.authority,
      quotaObservationRevision: component.observationRevision,
      quotaComponentDigest: component.componentDigest,
      receivedAt: component.receivedAt,
      observedAt: component.observedAt,
      firstResetAt: Math.min(...live.map((window) => window.resetsAtMs)),
    },
    windows: live,
    resetCreditsAvailable: component.quota.resetCreditsAvailable,
    recheckAt: blocking.length > 0 ? Math.max(...blocking.map((window) => window.resetsAtMs)) : null,
  };
}

const resetGateBase = {
  authority: providerAccountAuthoritySchema,
  quotaObservationRevision: observationRevisionSchema,
  resetPolicyRevision: revisionSchema,
  resetBoundary: unixMillisecondsSchema.nullable(),
} as const;

/**
 * Produced from the existing raw-v1 weekly reset decision and durable reset
 * state. The v2 quota alone cannot establish that reset handling has settled.
 */
export const automaticUsageResetGateSchema = z.discriminatedUnion("state", [
  z.object({ ...resetGateBase, state: z.literal("eligible"), resetBoundary: unixMillisecondsSchema }).strict(),
  z.object({
    ...resetGateBase,
    state: z.literal("not_eligible"),
    reason: z.enum(["credits_unavailable", "weekly_window_unavailable", "below_threshold"]),
  }).strict(),
  z.object({
    ...resetGateBase,
    state: z.literal("settled"),
    outcome: accountRateLimitResetOutcomeSchema,
    resetBoundary: unixMillisecondsSchema,
    resetIdempotencyKey: z.string().uuid(),
    attemptQuotaObservationRevision: observationRevisionSchema,
    settledAt: unixMillisecondsSchema,
  }).strict(),
  z.object({
    ...resetGateBase,
    state: z.literal("pending"),
    reason: z.enum(["prepared", "retry_pending", "recovery_pending", "reread_required"]),
  }).strict(),
  z.object({ ...resetGateBase, state: z.literal("reconciliation_required") }).strict(),
]).superRefine((gate, context) => {
  if (gate.authority.provider !== "codex") {
    context.addIssue({ code: "custom", message: "Only Codex owns reset credits." });
  }
  if (gate.state === "settled" && gate.quotaObservationRevision <= gate.attemptQuotaObservationRevision) {
    context.addIssue({ code: "custom", message: "Settled reset authority requires a later quota reread." });
  }
});
export type AutomaticUsageResetGate = z.infer<typeof automaticUsageResetGateSchema>;

export const automaticUsageDecisionAuthoritySchema = z.object({
  source: automaticUsageQuotaEvidenceSchema,
  orderRevision: revisionSchema,
  pointerRevision: revisionSchema,
  automaticPolicyRevision: revisionSchema,
  resetPolicyRevision: revisionSchema,
  resetBoundary: unixMillisecondsSchema.nullable(),
  evaluatedAt: unixMillisecondsSchema,
}).strict();
export type AutomaticUsageDecisionAuthority = z.infer<typeof automaticUsageDecisionAuthoritySchema>;

export type AutomaticUsageDecision =
  | Readonly<{ action: "disabled"; reason: "policy_disabled"; automaticPolicyRevision: number }>
  | Readonly<{
      action: "observe_only";
      reason: "claude_native_fallback_armed" | "claude_automation_unavailable"
        | "not_active_source" | "source_unknown" | "source_stale"
        | "reset_pending" | "no_target";
      recheckAt: number | null;
    }>
  | Readonly<{
      action: "reconciliation_required";
      reason: "invalid_input" | "account_order_conflict" | "source_conflict"
        | "reached_type_conflict" | "reset_gate_mismatch" | "reset_reconciliation_required";
    }>
  | Readonly<{ action: "continue"; reason: "below_threshold"; evidence: AutomaticUsageQuotaEvidence }>
  | Readonly<{ action: "reset"; reason: "weekly_reset_eligible"; authority: AutomaticUsageDecisionAuthority }>
  | Readonly<{
      action: "propose_pointer_move";
      reason: "next_available_account";
      authority: AutomaticUsageDecisionAuthority;
      target: AutomaticUsageQuotaEvidence;
    }>
  | Readonly<{ action: "wait"; reason: "no_fresh_target"; recheckAt: number; authority: AutomaticUsageDecisionAuthority }>;

export const automaticUsageDecisionInputSchema = z.object({
  provider: providerSchema,
  now: unixMillisecondsSchema,
  configuration: automaticUsagePolicyConfigurationSchema,
  observedSource: providerAccountAuthoritySchema,
  order: z.array(providerAccountIdSchema).max(AUTOMATIC_USAGE_ACCOUNT_LIMIT),
  orderRevision: revisionSchema,
  activeProviderAccountId: providerAccountIdSchema.nullable(),
  pointerRevision: revisionSchema,
  resetPolicyRevision: revisionSchema,
  accounts: z.array(usagePolicyAccountSchema).max(AUTOMATIC_USAGE_ACCOUNT_LIMIT),
  resetGate: automaticUsageResetGateSchema.nullable(),
  nativeFallback: z.enum(["armed", "unavailable", "disabled"]),
}).strict();
export type AutomaticUsageDecisionInput = z.infer<typeof automaticUsageDecisionInputSchema>;

/** Model ladders are provider data; no current quota input admits model scope. */
export type ProviderUsageModelLadder = Readonly<{
  provider: Provider;
  entries: readonly Readonly<{ model: string; reasoningEffort: string }>[];
}>;

export function automaticUsageDecision(value: unknown): AutomaticUsageDecision {
  const parsed = automaticUsageDecisionInputSchema.safeParse(value);
  if (!parsed.success) return { action: "reconciliation_required", reason: "invalid_input" };
  const input = parsed.data;
  const policy = resolveAutomaticUsagePolicy(input);
  if (!policy.enabled) {
    return { action: "disabled", reason: "policy_disabled", automaticPolicyRevision: policy.automaticPolicyRevision };
  }
  if (input.provider === "claude") {
    return {
      action: "observe_only",
      reason: input.nativeFallback === "armed" ? "claude_native_fallback_armed" : "claude_automation_unavailable",
      recheckAt: null,
    };
  }
  const accounts = new Map(input.accounts.map((account) => [account.authority.providerAccountId, account]));
  if (
    accounts.size !== input.accounts.length || new Set(input.order).size !== input.order.length
    || new Set(input.accounts.map((account) => account.authority.profileId)).size !== input.accounts.length
    || input.order.length !== accounts.size
    || input.accounts.some((account) => account.authority.provider !== input.provider || account.readiness === "removed")
    || input.order.some((id) => !accounts.has(id))
    || (input.activeProviderAccountId === null ? input.order.length > 0 : !accounts.has(input.activeProviderAccountId))
  ) return { action: "reconciliation_required", reason: "account_order_conflict" };
  if (input.observedSource.providerAccountId !== input.activeProviderAccountId) {
    return { action: "observe_only", reason: "not_active_source", recheckAt: null };
  }
  const source = accounts.get(input.observedSource.providerAccountId);
  if (source === undefined || !sameAuthority(source.authority, input.observedSource)) {
    return { action: "reconciliation_required", reason: "source_conflict" };
  }
  const classification = classifyProviderUsageAccount({ account: source, now: input.now });
  if (classification.state === "reconciliation_required") {
    return { action: "reconciliation_required", reason: classification.reason };
  }
  if (classification.state !== "available" && classification.state !== "exhausted") {
    return { action: "observe_only", reason: "source_unknown", recheckAt: null };
  }
  if (classification.freshness !== "fresh") {
    return { action: "observe_only", reason: "source_stale", recheckAt: classification.recheckAt };
  }
  if (classification.state === "available") {
    return { action: "continue", reason: "below_threshold", evidence: classification.evidence };
  }
  const gate = input.resetGate;
  const weekly = classification.windows.filter((window) =>
    window.windowDurationMins === CODEX_WEEKLY_RATE_LIMIT_WINDOW_MINUTES)
    .sort((left, right) => right.usedPercent - left.usedPercent || left.resetsAtMs - right.resetsAtMs)[0];
  if (
    gate === null || !sameAuthority(gate.authority, source.authority)
    || gate.quotaObservationRevision !== classification.evidence.quotaObservationRevision
    || gate.resetPolicyRevision !== input.resetPolicyRevision
    || gate.resetBoundary !== (weekly?.resetsAtMs ?? null)
    || (gate.state === "settled" && classification.evidence.receivedAt < gate.settledAt)
    || (gate.state === "eligible" && (weekly === undefined
      || weekly.usedPercent < USAGE_EXHAUSTION_USED_PERCENT || classification.resetCreditsAvailable < 1))
    || (gate.state === "not_eligible" && (
      (gate.reason === "weekly_window_unavailable" && weekly !== undefined)
      || (gate.reason === "credits_unavailable" && (weekly === undefined || classification.resetCreditsAvailable > 0))
      || (gate.reason === "below_threshold" && (weekly === undefined || classification.resetCreditsAvailable < 1
        || weekly.usedPercent >= USAGE_EXHAUSTION_USED_PERCENT))
    ))
  ) return { action: "reconciliation_required", reason: "reset_gate_mismatch" };
  if (gate.state === "reconciliation_required") {
    return { action: "reconciliation_required", reason: "reset_reconciliation_required" };
  }
  if (gate.state === "pending") return { action: "observe_only", reason: "reset_pending", recheckAt: null };
  const authority: AutomaticUsageDecisionAuthority = {
    source: classification.evidence,
    orderRevision: input.orderRevision,
    pointerRevision: input.pointerRevision,
    automaticPolicyRevision: input.configuration.automaticPolicyRevision,
    resetPolicyRevision: input.resetPolicyRevision,
    resetBoundary: gate.resetBoundary,
    evaluatedAt: input.now,
  };
  if (gate.state === "eligible") return { action: "reset", reason: "weekly_reset_eligible", authority };
  const start = input.order.indexOf(source.authority.providerAccountId);
  const rechecks = classification.recheckAt === null ? [] : [classification.recheckAt];
  for (let offset = 1; offset < input.order.length; offset += 1) {
    const id = input.order[(start + offset) % input.order.length];
    const candidate = id === undefined ? undefined : accounts.get(id);
    if (candidate === undefined) return { action: "reconciliation_required", reason: "account_order_conflict" };
    const classified = classifyProviderUsageAccount({ account: candidate, now: input.now });
    if (classified.state === "available") {
      return { action: "propose_pointer_move", reason: "next_available_account", authority, target: classified.evidence };
    }
    if (classified.state === "exhausted" && classified.recheckAt !== null) rechecks.push(classified.recheckAt);
  }
  const recheckAt = rechecks.length > 0 ? Math.min(...rechecks) : null;
  return recheckAt === null ? { action: "observe_only", reason: "no_target", recheckAt: null }
    : { action: "wait", reason: "no_fresh_target", recheckAt, authority };
}

/** Storage parses a verified durable row into this branded type after commit. */
export const settledAutomaticPointerMoveSchema = z.object({
  version: z.literal(1),
  kind: z.literal("settled_automatic_pointer_move"),
  moveId: z.string().regex(/^[a-f0-9]{40}$/u),
  authority: automaticUsageDecisionAuthoritySchema,
  target: automaticUsageQuotaEvidenceSchema,
  toPointerRevision: revisionSchema,
  settledAt: unixMillisecondsSchema,
}).strict().superRefine((move, context) => {
  if (
    move.authority.source.authority.provider !== "codex" || move.target.authority.provider !== "codex"
    || move.authority.source.authority.providerAccountId === move.target.authority.providerAccountId
    || move.toPointerRevision !== move.authority.pointerRevision + 1
    || move.settledAt < move.authority.evaluatedAt
  ) context.addIssue({ code: "custom", message: "Automatic pointer move authority is incoherent." });
  for (const evidence of [move.authority.source, move.target]) {
    if (
      evidence.receivedAt > move.authority.evaluatedAt
      || move.settledAt - evidence.receivedAt > AUTOMATIC_USAGE_FRESHNESS_MS
      || move.settledAt >= evidence.firstResetAt
    ) context.addIssue({ code: "custom", message: "Automatic pointer move used expired quota evidence." });
  }
}).brand<"SettledAutomaticPointerMove">();
export type SettledAutomaticPointerMove = z.infer<typeof settledAutomaticPointerMoveSchema>;

export const automaticUsageManagedSessionSchema = z.object({
  sessionId: sessionIdSchema,
  sessionRevision: revisionSchema,
  sessionAuthorityRevision: revisionSchema,
  authority: providerAccountAuthoritySchema,
  routingProvenance: sessionRoutingProvenanceSchema,
  appliedPointerRevision: revisionSchema.nullable(),
  turnId: z.string().min(1).max(200).nullable(),
}).strict();
export type AutomaticUsageManagedSession = z.infer<typeof automaticUsageManagedSessionSchema>;

export type AutomaticUsageFollowDecision =
  | Readonly<{ action: "stay"; reason: "explicit_session" | "already_applied" | "claude_observe_only" }>
  | Readonly<{ action: "disabled"; reason: "policy_disabled" }>
  | Readonly<{ action: "reconciliation_required"; reason: "invalid_session" | "invalid_lineage" | "lineage_gap" | "lineage_authority_mismatch" }>
  | Readonly<{
      action: "follow_pointer_moves" | "advance_pointer_revision";
      session: AutomaticUsageManagedSession;
      moveIds: readonly string[];
      target: ProviderAccountAuthority;
      toPointerRevision: number;
      automaticPolicyRevision: number;
    }>;

/** Following never reselects an account or consults current quota/accounting. */
export function followSettledAutomaticPointerMoves(input: Readonly<{
  session: AutomaticUsageManagedSession;
  configuration: AutomaticUsagePolicyConfiguration;
  throughPointerRevision: number;
  moves: readonly SettledAutomaticPointerMove[];
}>): AutomaticUsageFollowDecision {
  const sessionResult = automaticUsageManagedSessionSchema.safeParse(input.session);
  const policyResult = automaticUsagePolicyConfigurationSchema.safeParse(input.configuration);
  const throughResult = revisionSchema.safeParse(input.throughPointerRevision);
  if (!sessionResult.success || !policyResult.success || !throughResult.success) {
    return { action: "reconciliation_required", reason: "invalid_session" };
  }
  const session = sessionResult.data;
  if (session.routingProvenance === "explicit") return { action: "stay", reason: "explicit_session" };
  if (session.authority.provider === "claude") return { action: "stay", reason: "claude_observe_only" };
  const policy = resolveAutomaticUsagePolicy({ configuration: policyResult.data, provider: session.authority.provider });
  if (!policy.enabled) return { action: "disabled", reason: "policy_disabled" };
  const applied = session.appliedPointerRevision;
  const through = throughResult.data;
  if (applied === null || through < applied) return { action: "reconciliation_required", reason: "lineage_gap" };
  if (through === applied) return { action: "stay", reason: "already_applied" };
  const movesResult = z.array(settledAutomaticPointerMoveSchema).max(AUTOMATIC_USAGE_MOVE_LINEAGE_LIMIT).safeParse(input.moves);
  if (!movesResult.success) return { action: "reconciliation_required", reason: "invalid_lineage" };
  const moves = movesResult.data.sort((left, right) => left.authority.pointerRevision - right.authority.pointerRevision);
  if (new Set(moves.map((move) => move.moveId)).size !== moves.length) {
    return { action: "reconciliation_required", reason: "invalid_lineage" };
  }
  let revision = applied;
  let authority: ProviderAccountAuthority = session.authority;
  let lastSettledAt = 0;
  let lastOrderRevision = 0;
  let lastPolicyRevision = 0;
  for (const move of moves) {
    if (move.authority.pointerRevision !== revision || move.toPointerRevision > through) {
      return { action: "reconciliation_required", reason: "lineage_gap" };
    }
    if (!sameBinding(authority, move.authority.source.authority)) {
      return { action: "reconciliation_required", reason: "lineage_authority_mismatch" };
    }
    if (move.authority.evaluatedAt < lastSettledAt
      || move.authority.orderRevision < lastOrderRevision
      || move.authority.automaticPolicyRevision < lastPolicyRevision
      || move.authority.automaticPolicyRevision > policy.automaticPolicyRevision) {
      return { action: "reconciliation_required", reason: "invalid_lineage" };
    }
    revision = move.toPointerRevision;
    authority = move.target.authority;
    lastSettledAt = move.settledAt;
    lastOrderRevision = move.authority.orderRevision;
    lastPolicyRevision = move.authority.automaticPolicyRevision;
  }
  if (revision !== through) return { action: "reconciliation_required", reason: "lineage_gap" };
  return {
    action: sameBinding(session.authority, authority) ? "advance_pointer_revision" : "follow_pointer_moves",
    session,
    moveIds: moves.map((move) => move.moveId),
    // A round trip does not rebind or replace the session's process authority.
    target: sameBinding(session.authority, authority) ? session.authority : authority,
    toPointerRevision: through,
    automaticPolicyRevision: policy.automaticPolicyRevision,
  };
}
