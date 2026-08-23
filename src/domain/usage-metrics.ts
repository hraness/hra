import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

export const usageVelocityWindowSchema = z.enum(["1m", "5m", "15m"]);
export type UsageVelocityWindow = z.infer<typeof usageVelocityWindowSchema>;

const WINDOW_MS: Readonly<Record<UsageVelocityWindow, number>> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
};

export const USAGE_SAMPLE_MAX_GAP_MS = 90_000;
export const USAGE_LATEST_STALE_MS = 90_000;
export const ACCOUNT_USAGE_SCHEMA_DIGEST = createHash("sha256")
  .update("hra:codex-account-usage:0.149.0:lifetimeTokens:v1")
  .digest("hex");

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
    && previousObservation.schemaDigest === ACCOUNT_USAGE_SCHEMA_DIGEST
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
      schemaDigest: observation.schemaDigest,
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
