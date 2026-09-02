import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import { labelSchema, profileIdSchema, unixMillisecondsSchema } from "./values";

export const ACCOUNT_USAGE_HISTORY_PAGE_LIMIT = 100;
export const CODEX_WEEKLY_RATE_LIMIT_WINDOW_MINUTES = 7 * 24 * 60;
const CODEX_WEEKLY_RATE_LIMIT_WINDOW_MS =
  CODEX_WEEKLY_RATE_LIMIT_WINDOW_MINUTES * 60_000;
export const AUTO_RATE_LIMIT_RESET_REMAINING_PERCENT = 1;
export const AUTO_RATE_LIMIT_RESET_USED_PERCENT =
  100 - AUTO_RATE_LIMIT_RESET_REMAINING_PERCENT;

export const accountRateLimitResetOutcomeSchema = z.enum([
  "reset",
  "alreadyRedeemed",
  "nothingToReset",
  "noCredit",
]);

export type AccountRateLimitResetOutcome = z.infer<
  typeof accountRateLimitResetOutcomeSchema
>;

const automaticRateLimitResetLocalResolutionSchema = z.enum([
  "weekly_window_changed",
  "account_identity_changed",
]);

const automaticRateLimitResetAttemptWindowShape = {
  weeklyWindowResetsAt: unixMillisecondsSchema,
} as const;

export const automaticRateLimitResetLastAttemptSchema = z.union([
  z.object({
    state: z.literal("prepared"),
    ...automaticRateLimitResetAttemptWindowShape,
  }).strict(),
  z.object({
    state: z.literal("retry_pending"),
    ...automaticRateLimitResetAttemptWindowShape,
  }).strict(),
  z.object({
    state: z.literal("recovery_pending"),
    ...automaticRateLimitResetAttemptWindowShape,
  }).strict(),
  z.object({
    state: z.literal("settled"),
    outcome: accountRateLimitResetOutcomeSchema,
    ...automaticRateLimitResetAttemptWindowShape,
  }).strict(),
  z.object({
    state: z.literal("closed"),
    reason: automaticRateLimitResetLocalResolutionSchema,
    ...automaticRateLimitResetAttemptWindowShape,
  }).strict(),
]);

export type AutomaticRateLimitResetLastAttempt = z.infer<
  typeof automaticRateLimitResetLastAttemptSchema
>;

export const automaticRateLimitResetRefreshStatusSchema = z.union([
  z.object({
    state: z.literal("not_eligible"),
    reason: z.enum([
      "credits_unavailable",
      "weekly_window_unavailable",
      "below_threshold",
    ]),
  }).strict(),
  z.object({
    state: z.literal("waiting"),
    reason: z.enum(["credits_unavailable", "below_threshold"]),
  }).strict(),
  z.object({ state: z.literal("window_changed") }).strict(),
  z.object({
    state: z.literal("latched"),
    outcome: accountRateLimitResetOutcomeSchema,
  }).strict(),
  z.object({
    state: z.literal("latched"),
    reason: automaticRateLimitResetLocalResolutionSchema,
  }).strict(),
  z.object({ state: z.literal("retry_pending") }).strict(),
  z.object({ state: z.literal("recovery_pending") }).strict(),
  z.object({
    state: z.literal("suppressed"),
    reason: z.enum([
      "reconciliation_required",
      "reconciliation_window",
      "weekly_window_unavailable",
      "weekly_window_nonmonotonic",
      "account_identity_changed",
    ]),
  }).strict(),
  z.object({
    state: z.literal("settled"),
    outcome: accountRateLimitResetOutcomeSchema,
  }).strict(),
]);

export type AutomaticRateLimitResetRefreshStatus = z.infer<
  typeof automaticRateLimitResetRefreshStatusSchema
>;

export const automaticRateLimitResetPolicyStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("active") }).strict(),
  z.object({ state: z.literal("reconciliation_required") }).strict(),
  z.object({
    state: z.literal("window_suppressed"),
    weeklyWindowResetsAt: unixMillisecondsSchema,
  }).strict(),
]);

export type AutomaticRateLimitResetPolicyStatus = z.infer<
  typeof automaticRateLimitResetPolicyStatusSchema
>;

export const automaticRateLimitResetStatusSchema = z.object({
  threshold: z.object({
    remainingPercent: z.literal(AUTO_RATE_LIMIT_RESET_REMAINING_PERCENT),
    usedPercent: z.literal(AUTO_RATE_LIMIT_RESET_USED_PERCENT),
  }).strict(),
  policy: automaticRateLimitResetPolicyStatusSchema,
  observation: z.union([
    z.object({
      state: z.literal("available"),
      creditsAvailable: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      remainingPercent: z.number().finite().min(0).max(100),
      usedPercent: z.number().finite().min(0).max(100),
      weeklyWindowResetsAt: unixMillisecondsSchema,
    }).strict(),
    z.object({
      state: z.literal("unavailable"),
      reason: z.literal("weekly_window_unavailable"),
    }).strict(),
  ]),
  lastAttempt: automaticRateLimitResetLastAttemptSchema.nullable(),
  refresh: automaticRateLimitResetRefreshStatusSchema.optional(),
}).strict();

export type AutomaticRateLimitResetDecision =
  | Readonly<{
      eligible: true;
      remainingPercent: number;
      usedPercent: number;
      weeklyWindowResetsAt: number;
    }>
  | Readonly<{
      eligible: false;
      reason:
        | "credits_unavailable"
        | "weekly_window_unavailable"
        | "below_threshold";
    }>;

export type AutomaticRateLimitResetObservation =
  | Readonly<{
      available: true;
      creditsAvailable: number;
      usedPercent: number;
      weeklyWindowResetsAt: number;
    }>
  | Readonly<{
      available: false;
      reason: "weekly_window_unavailable";
    }>;

const automaticResetWindowSchema = z.object({
  usedPercent: z.number().finite().min(0).max(100),
  windowDurationMins: z.number().finite().nullable(),
  resetsAt: z.number().finite().nonnegative().nullable(),
}).passthrough();

const automaticResetLimitSchema = z.object({
  limitId: z.string().nullable(),
  primary: automaticResetWindowSchema.nullable(),
  secondary: automaticResetWindowSchema.nullable(),
}).passthrough();

const automaticResetPayloadSchema = z.object({
  rateLimits: z.object({
    primary: automaticResetLimitSchema,
    byLimitId: z.record(z.string(), automaticResetLimitSchema).nullable(),
    resetCreditsAvailable: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).passthrough(),
}).passthrough();

const providerResetTimestampMilliseconds = (value: number): number | null => {
  // Codex 0.149 defines resetsAt as integer Unix seconds. Accepting an
  // ambiguous millisecond value could turn a malformed bucket into mutation
  // authority, so conversion is deliberately one-way and bounded.
  if (!Number.isSafeInteger(value) || value < 0 || value >= 100_000_000_000) {
    return null;
  }
  const milliseconds = value * 1_000;
  return Number.isSafeInteger(milliseconds)
    ? milliseconds
    : null;
};

/**
 * Chooses only the exact Codex seven-day bucket. Other provider limits must
 * never spend an account reset credit merely because they happen to be high.
 */
export function automaticRateLimitResetDecision(input: {
  providerPayload: unknown;
  now: number;
}): AutomaticRateLimitResetDecision {
  const observation = automaticRateLimitResetObservation(input);
  if (!observation.available) {
    return { eligible: false, reason: observation.reason };
  }
  if (observation.creditsAvailable < 1) {
    return { eligible: false, reason: "credits_unavailable" };
  }
  if (observation.usedPercent < AUTO_RATE_LIMIT_RESET_USED_PERCENT) {
    return { eligible: false, reason: "below_threshold" };
  }
  return {
    eligible: true,
    remainingPercent: Math.max(0, 100 - observation.usedPercent),
    usedPercent: observation.usedPercent,
    weeklyWindowResetsAt: observation.weeklyWindowResetsAt,
  };
}

export function automaticRateLimitResetObservation(input: {
  providerPayload: unknown;
  now: number;
}): AutomaticRateLimitResetObservation {
  const now = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(input.now);
  const parsed = automaticResetPayloadSchema.safeParse(input.providerPayload);
  if (!parsed.success) {
    return { available: false, reason: "weekly_window_unavailable" };
  }

  const byLimitId = parsed.data.rateLimits.byLimitId;
  const primary = parsed.data.rateLimits.primary;
  const limitIds = Object.keys(byLimitId ?? {});
  const keyedCodex = byLimitId?.codex;
  const codexLimit = limitIds.length > 0
    ? keyedCodex !== undefined
      && (keyedCodex.limitId === null || keyedCodex.limitId === "codex")
      ? keyedCodex
      : undefined
    : primary.limitId === null || primary.limitId === "codex"
      ? primary
      : undefined;
  const weekly = codexLimit === undefined
    ? []
    : [codexLimit.primary, codexLimit.secondary]
    .flatMap((window) => {
      if (
        window === null
        || window.windowDurationMins !== CODEX_WEEKLY_RATE_LIMIT_WINDOW_MINUTES
        || window.resetsAt === null
      ) return [];
      const weeklyWindowResetsAt = providerResetTimestampMilliseconds(window.resetsAt);
      if (
        weeklyWindowResetsAt === null
        || weeklyWindowResetsAt <= now
        || weeklyWindowResetsAt - now > CODEX_WEEKLY_RATE_LIMIT_WINDOW_MS
      ) return [];
      return [{
        usedPercent: window.usedPercent,
        weeklyWindowResetsAt,
      }];
    })
    .sort((left, right) =>
      right.usedPercent - left.usedPercent
      || left.weeklyWindowResetsAt - right.weeklyWindowResetsAt);
  const candidate = weekly[0];
  if (candidate === undefined) {
    return { available: false, reason: "weekly_window_unavailable" };
  }
  return {
    available: true,
    creditsAvailable: parsed.data.rateLimits.resetCreditsAvailable,
    usedPercent: candidate.usedPercent,
    weeklyWindowResetsAt: candidate.weeklyWindowResetsAt,
  };
}

const accountUsageHistoryBaseSchema = z.object({
  sourceRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  observedAt: unixMillisecondsSchema,
});

export const accountUsageHistoryEntrySchema = z.discriminatedUnion("state", [
  accountUsageHistoryBaseSchema.extend({
    state: z.literal("observed"),
    receivedAt: unixMillisecondsSchema.nullable(),
    lifetimeTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    gapBefore: z.boolean().nullable(),
  }).strict(),
  accountUsageHistoryBaseSchema.extend({
    state: z.literal("failed"),
    reasonCode: z.literal("account_usage_read_failed"),
  }).strict(),
]);

export type AccountUsageHistoryEntry = z.infer<typeof accountUsageHistoryEntrySchema>;

export const accountUsageHistoryPageSchema = z.object({
  account: z.object({
    id: profileIdSchema,
    label: labelSchema,
  }).strict(),
  range: z.object({
    fromObservedAt: unixMillisecondsSchema,
    throughObservedAt: unixMillisecondsSchema,
  }).strict(),
  entries: z.array(accountUsageHistoryEntrySchema).max(ACCOUNT_USAGE_HISTORY_PAGE_LIMIT),
  nextCursor: z.string().min(1).max(2_048).nullable(),
}).strict();

export type AccountUsageHistoryPage = z.infer<typeof accountUsageHistoryPageSchema>;

export const usageVelocityWindowSchema = z.enum(["1m", "5m", "15m"]);
export type UsageVelocityWindow = z.infer<typeof usageVelocityWindowSchema>;

const WINDOW_MS: Readonly<Record<UsageVelocityWindow, number>> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
};

export const USAGE_SAMPLE_MAX_GAP_MS = 90_000;
export const USAGE_LATEST_STALE_MS = 90_000;
/**
 * Identity of the stored `lifetimeTokens` counter semantics. The domain is
 * stable across Codex pins; bump `ACCOUNT_USAGE_SCHEMA_ID` by hand only when
 * a new pin changes what the counter means, which starts a new usage epoch.
 */
const ACCOUNT_USAGE_DIGEST_DOMAIN = "hra:codex-account-usage:v2";
export const ACCOUNT_USAGE_SCHEMA_ID = "lifetimeTokens:v1";
export const ACCOUNT_USAGE_SCHEMA_DIGEST = createHash("sha256")
  .update(`${ACCOUNT_USAGE_DIGEST_DOMAIN}:${ACCOUNT_USAGE_SCHEMA_ID}`)
  .digest("hex");

/**
 * Digests written by releases whose domain embedded the then-pinned Codex
 * version. Their counter semantics equal the current schema id, so stored
 * observations carrying one are re-derived to the current digest on read
 * instead of forcing a new usage epoch or a `schema_changed` gap.
 */
const RETIRED_ACCOUNT_USAGE_SCHEMA_DIGESTS: ReadonlySet<string> = new Set([
  "327b3f456c3200e91b3215d4030cb74e1e1c8911b3f1311687134dd9d9c8144d",
]);

/** Maps a stored digest to the current schema identity when it is compatible. */
export const rederiveAccountUsageSchemaDigest = (stored: string): string =>
  RETIRED_ACCOUNT_USAGE_SCHEMA_DIGESTS.has(stored) ? ACCOUNT_USAGE_SCHEMA_DIGEST : stored;

export const accountUsageCounterSampleSchema = z.object({
  sourceSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  accountFingerprint: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  usageEpoch: z.string().uuid(),
  schemaDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  counterName: z.literal("lifetimeTokens"),
  clock: z.enum(["provider", "received"]),
  observedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  receivedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  lifetimeTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  gapBefore: z.boolean(),
}).strict();

export type AccountUsageCounterSample = z.infer<typeof accountUsageCounterSampleSchema>;

export const accountUsageObservationSchema = accountUsageCounterSampleSchema.extend({
  version: z.literal(1),
  providerGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  daemonGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

export type AccountUsageObservation = z.infer<typeof accountUsageObservationSchema>;

export const storedAccountUsageSnapshotSchema = z.object({
  version: z.literal(1),
  providerPayload: z.unknown(),
  observation: accountUsageObservationSchema,
}).strict();

export type StoredAccountUsageSnapshot = z.infer<typeof storedAccountUsageSnapshotSchema>;

export const usageVelocityUnavailableReasonSchema = z.enum([
  "insufficient_samples",
  "account_unverified",
  "missing_counter",
  "stale_latest",
  "source_sequence_gap",
  "observation_time_nonmonotonic",
  "clock_changed",
  "account_changed",
  "usage_epoch_changed",
  "schema_changed",
  "counter_changed",
  "daemon_gap",
  "sample_gap",
  "counter_reset",
  "window_coverage",
]);

export type UsageVelocityUnavailableReason = z.infer<typeof usageVelocityUnavailableReasonSchema>;

export type ObservedAccountTokenVelocity =
  | {
      readonly available: true;
      readonly window: UsageVelocityWindow;
      readonly counterDelta: number;
      readonly elapsedMs: number;
      readonly tokensPerSecond: number;
      readonly tokensPerMinute: number;
      readonly fromSourceSequence: number;
      readonly throughSourceSequence: number;
      readonly clock: "provider" | "received";
    }
  | {
      readonly available: false;
      readonly window: UsageVelocityWindow;
      readonly reason: UsageVelocityUnavailableReason;
    };

const unavailable = (
  window: UsageVelocityWindow,
  reason: UsageVelocityUnavailableReason,
): ObservedAccountTokenVelocity => ({ available: false, window, reason });

const incompatibleReason = (
  first: AccountUsageCounterSample,
  next: AccountUsageCounterSample,
): UsageVelocityUnavailableReason | null => {
  if (first.accountFingerprint !== next.accountFingerprint) return "account_changed";
  if (first.usageEpoch !== next.usageEpoch) return "usage_epoch_changed";
  if (first.schemaDigest !== next.schemaDigest) return "schema_changed";
  if (first.clock !== next.clock) return "clock_changed";
  return null;
};

const lifetimeTokensFromProviderPayload = (payload: unknown): number | null => {
  const parsed = z.object({
    usage: z.object({
      summary: z.object({
        lifetimeTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
      }).passthrough(),
    }).passthrough(),
  }).passthrough().safeParse(payload);
  return parsed.success ? parsed.data.usage.summary.lifetimeTokens : null;
};

export function createStoredAccountUsageSnapshot(input: {
  providerPayload: unknown;
  sourceSequence: number;
  observedAt: number;
  receivedAt: number;
  accountFingerprint: string | null;
  providerGeneration: number;
  daemonGeneration: number;
  previousPayload: unknown;
}): StoredAccountUsageSnapshot {
  const sourceSequence = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
    .parse(input.sourceSequence);
  const observedAt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
    .parse(input.observedAt);
  const receivedAt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
    .parse(input.receivedAt);
  const accountFingerprint = z.string().regex(/^[a-f0-9]{64}$/u).nullable()
    .parse(input.accountFingerprint);
  const providerGeneration = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
    .parse(input.providerGeneration);
  const daemonGeneration = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
    .parse(input.daemonGeneration);
  const lifetimeTokens = lifetimeTokensFromProviderPayload(input.providerPayload);
  const previous = input.previousPayload === null
    ? null
    : storedAccountUsageSnapshotSchema.safeParse(input.previousPayload);
  const previousObservation = previous?.success === true ? previous.data.observation : null;
  const comparable = previousObservation !== null
    && accountFingerprint !== null
    && previousObservation.accountFingerprint === accountFingerprint
    && rederiveAccountUsageSchemaDigest(previousObservation.schemaDigest) === ACCOUNT_USAGE_SCHEMA_DIGEST
    && previousObservation.lifetimeTokens !== null
    && lifetimeTokens !== null
    && lifetimeTokens >= previousObservation.lifetimeTokens;
  const usageEpoch = comparable ? previousObservation.usageEpoch : randomUUID();
  const gapBefore = previousObservation !== null && comparable && (
    sourceSequence !== previousObservation.sourceSequence + 1
    || providerGeneration !== previousObservation.providerGeneration
    || daemonGeneration !== previousObservation.daemonGeneration
    || observedAt <= previousObservation.observedAt
    || receivedAt < previousObservation.receivedAt
    || observedAt - previousObservation.observedAt > USAGE_SAMPLE_MAX_GAP_MS
  );
  return storedAccountUsageSnapshotSchema.parse({
    version: 1,
    providerPayload: input.providerPayload,
    observation: {
      version: 1,
      sourceSequence,
      accountFingerprint,
      usageEpoch,
      schemaDigest: ACCOUNT_USAGE_SCHEMA_DIGEST,
      counterName: "lifetimeTokens",
      clock: "received",
      observedAt,
      receivedAt,
      lifetimeTokens,
      gapBefore,
      providerGeneration,
      daemonGeneration,
    },
  });
}

export function providerUsagePayload(value: unknown): unknown {
  const parsed = storedAccountUsageSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data.providerPayload : value;
}

export function accountUsageCounterSamples(
  values: readonly Readonly<{ payload: unknown }>[]
): readonly AccountUsageCounterSample[] {
  return values.flatMap((value) => {
    const parsed = storedAccountUsageSnapshotSchema.safeParse(value.payload);
    if (!parsed.success) return [];
    const observation = parsed.data.observation;
    return [accountUsageCounterSampleSchema.parse({
      sourceSequence: observation.sourceSequence,
      accountFingerprint: observation.accountFingerprint,
      usageEpoch: observation.usageEpoch,
      schemaDigest: rederiveAccountUsageSchemaDigest(observation.schemaDigest),
      counterName: observation.counterName,
      clock: observation.clock,
      observedAt: observation.observedAt,
      receivedAt: observation.receivedAt,
      lifetimeTokens: observation.lifetimeTokens,
      gapBefore: observation.gapBefore,
    })];
  });
}

export function observedAccountTokenVelocity(input: {
  samples: readonly AccountUsageCounterSample[];
  window: UsageVelocityWindow;
  now: number;
}): ObservedAccountTokenVelocity {
  const window = usageVelocityWindowSchema.parse(input.window);
  const samples = z.array(accountUsageCounterSampleSchema).max(10_000).parse(input.samples);
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    throw new Error("Usage velocity observation time is invalid.");
  }
  if (samples.length < 2) return unavailable(window, "insufficient_samples");
  const latest = samples.at(-1);
  if (latest === undefined) return unavailable(window, "insufficient_samples");
  if (latest.accountFingerprint === null) return unavailable(window, "account_unverified");
  if (latest.lifetimeTokens === null) return unavailable(window, "missing_counter");
  if (input.now - latest.receivedAt > USAGE_LATEST_STALE_MS) return unavailable(window, "stale_latest");

  const target = WINDOW_MS[window];
  const minimum = target * 0.8;
  const maximum = target * 1.2;
  let chosenIndex: number | null = null;
  let chosenDistance = Number.POSITIVE_INFINITY;
  for (let index = samples.length - 2; index >= 0; index -= 1) {
    const candidate = samples[index];
    if (candidate === undefined) continue;
    const elapsed = latest.observedAt - candidate.observedAt;
    if (elapsed > maximum) break;
    if (elapsed < minimum) continue;
    const distance = Math.abs(elapsed - target);
    if (distance < chosenDistance || (distance === chosenDistance && (chosenIndex === null || index < chosenIndex))) {
      chosenIndex = index;
      chosenDistance = distance;
    }
  }
  if (chosenIndex === null) return unavailable(window, "window_coverage");

  const first = samples[chosenIndex];
  if (first === undefined) return unavailable(window, "insufficient_samples");
  if (first.accountFingerprint === null) return unavailable(window, "account_unverified");
  if (first.lifetimeTokens === null) return unavailable(window, "missing_counter");
  for (let index = chosenIndex + 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (previous === undefined || current === undefined) continue;
    if (current.sourceSequence !== previous.sourceSequence + 1) {
      return unavailable(window, "source_sequence_gap");
    }
    if (current.observedAt <= previous.observedAt || current.receivedAt < previous.receivedAt) {
      return unavailable(window, "observation_time_nonmonotonic");
    }
    const incompatible = incompatibleReason(first, current);
    if (incompatible !== null) return unavailable(window, incompatible);
    if (current.gapBefore) return unavailable(window, "daemon_gap");
    if (current.observedAt - previous.observedAt > USAGE_SAMPLE_MAX_GAP_MS) {
      return unavailable(window, "sample_gap");
    }
  }
  const counterDelta = latest.lifetimeTokens - first.lifetimeTokens;
  if (counterDelta < 0) return unavailable(window, "counter_reset");
  const elapsedMs = latest.observedAt - first.observedAt;
  const tokensPerSecond = counterDelta / (elapsedMs / 1_000);
  return {
    available: true,
    window,
    counterDelta,
    elapsedMs,
    tokensPerSecond,
    tokensPerMinute: tokensPerSecond * 60,
    fromSourceSequence: first.sourceSequence,
    throughSourceSequence: latest.sourceSequence,
    clock: latest.clock,
  };
}
