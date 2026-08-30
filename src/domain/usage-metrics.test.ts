import { describe, expect, test } from "bun:test";

import {
  AUTO_RATE_LIMIT_RESET_USED_PERCENT,
  CODEX_WEEKLY_RATE_LIMIT_WINDOW_MINUTES,
  accountUsageCounterSamples,
  automaticRateLimitResetDecision,
  automaticRateLimitResetStatusSchema,
  createStoredAccountUsageSnapshot,
  observedAccountTokenVelocity,
  providerUsagePayload,
  type AccountUsageCounterSample,
} from "./usage-metrics";

const digest = "a".repeat(64);
const epoch = "018f47a0-7b45-7000-8000-000000000001";
const usagePayload = (lifetimeTokens: number | null) => ({
  usage: { summary: { lifetimeTokens } },
  rateLimits: {},
});

const sample = (
  sourceSequence: number,
  observedAt: number,
  lifetimeTokens: number | null,
  overrides: Partial<AccountUsageCounterSample> = {},
): AccountUsageCounterSample => ({
  sourceSequence,
  accountFingerprint: digest,
  usageEpoch: epoch,
  schemaDigest: digest,
  counterName: "lifetimeTokens",
  clock: "received",
  observedAt,
  receivedAt: observedAt,
  lifetimeTokens,
  gapBefore: false,
  ...overrides,
});

describe("observedAccountTokenVelocity", () => {
  test("uses the actual elapsed denominator inside the one-minute tolerance", () => {
    const result = observedAccountTokenVelocity({
      samples: [sample(1, 1_000, 100), sample(2, 61_000, 220)],
      window: "1m",
      now: 61_000,
    });
    expect(result).toEqual({
      available: true,
      window: "1m",
      counterDelta: 120,
      elapsedMs: 60_000,
      tokensPerSecond: 2,
      tokensPerMinute: 120,
      fromSourceSequence: 1,
      throughSourceSequence: 2,
      clock: "received",
    });
  });

  test("accepts exact 0.8W and 1.2W boundaries and rejects just outside", () => {
    for (const elapsed of [48_000, 72_000]) {
      expect(observedAccountTokenVelocity({ samples: [sample(1, 0, 0), sample(2, elapsed, 10)], window: "1m", now: elapsed }).available).toBe(true);
    }
    for (const elapsed of [47_999, 72_001]) {
      expect(observedAccountTokenVelocity({ samples: [sample(1, 0, 0), sample(2, elapsed, 10)], window: "1m", now: elapsed })).toEqual({ available: false, window: "1m", reason: "window_coverage" });
    }
  });

  test("breaks equally distant candidate ties toward the earlier sample", () => {
    const result = observedAccountTokenVelocity({
      samples: [sample(1, 0, 0), sample(2, 50_000, 50), sample(3, 70_000, 70), sample(4, 120_000, 120)],
      window: "1m",
      now: 120_000,
    });
    expect(result.available && result.fromSourceSequence).toBe(2);
  });

  test("rejects a 90-second gap plus one and accepts the exact boundary", () => {
    expect(observedAccountTokenVelocity({ samples: [sample(1, 0, 0), sample(2, 90_000, 90), sample(3, 300_000, 300)], window: "5m", now: 300_000 })).toEqual({ available: false, window: "5m", reason: "sample_gap" });
    expect(observedAccountTokenVelocity({ samples: [sample(1, 0, 0), sample(2, 90_000, 90), sample(3, 180_000, 180), sample(4, 270_000, 270), sample(5, 300_000, 300)], window: "5m", now: 300_000 }).available).toBe(true);
  });

  test("classifies reset, daemon gap, source gap, account change, and staleness", () => {
    expect(observedAccountTokenVelocity({ samples: [sample(1, 0, 100), sample(2, 60_000, 90)], window: "1m", now: 60_000 })).toEqual({ available: false, window: "1m", reason: "counter_reset" });
    expect(observedAccountTokenVelocity({ samples: [sample(1, 0, 0), sample(2, 60_000, 1, { gapBefore: true })], window: "1m", now: 60_000 })).toEqual({ available: false, window: "1m", reason: "daemon_gap" });
    expect(observedAccountTokenVelocity({ samples: [sample(1, 0, 0), sample(3, 60_000, 1)], window: "1m", now: 60_000 })).toEqual({ available: false, window: "1m", reason: "source_sequence_gap" });
    expect(observedAccountTokenVelocity({ samples: [sample(1, 0, 0), sample(2, 60_000, 1, { accountFingerprint: "b".repeat(64) })], window: "1m", now: 60_000 })).toEqual({ available: false, window: "1m", reason: "account_changed" });
    expect(observedAccountTokenVelocity({ samples: [sample(1, 0, 0), sample(2, 60_000, 1)], window: "1m", now: 150_001 })).toEqual({ available: false, window: "1m", reason: "stale_latest" });
  });

  test("creates durable observation epochs and marks daemon continuity gaps", () => {
    const first = createStoredAccountUsageSnapshot({
      providerPayload: usagePayload(100),
      sourceSequence: 1,
      observedAt: 1_000,
      receivedAt: 1_000,
      accountFingerprint: digest,
      providerGeneration: 1,
      daemonGeneration: 1,
      previousPayload: null,
    });
    const second = createStoredAccountUsageSnapshot({
      providerPayload: usagePayload(220),
      sourceSequence: 2,
      observedAt: 61_000,
      receivedAt: 61_000,
      accountFingerprint: digest,
      providerGeneration: 1,
      daemonGeneration: 1,
      previousPayload: first,
    });
    expect(second.observation).toMatchObject({
      usageEpoch: first.observation.usageEpoch,
      gapBefore: false,
      lifetimeTokens: 220,
    });
    const afterRestart = createStoredAccountUsageSnapshot({
      providerPayload: usagePayload(230),
      sourceSequence: 3,
      observedAt: 70_000,
      receivedAt: 70_000,
      accountFingerprint: digest,
      providerGeneration: 1,
      daemonGeneration: 2,
      previousPayload: second,
    });
    expect(afterRestart.observation).toMatchObject({
      usageEpoch: first.observation.usageEpoch,
      gapBefore: true,
    });
    const reset = createStoredAccountUsageSnapshot({
      providerPayload: usagePayload(1),
      sourceSequence: 4,
      observedAt: 80_000,
      receivedAt: 80_000,
      accountFingerprint: digest,
      providerGeneration: 1,
      daemonGeneration: 2,
      previousPayload: afterRestart,
    });
    expect(reset.observation.usageEpoch).not.toBe(first.observation.usageEpoch);
    expect(providerUsagePayload(reset)).toEqual(usagePayload(1));
    expect(accountUsageCounterSamples([{ payload: first }, { payload: second }])).toHaveLength(2);
  });

  test("does not call an unverified profile fingerprint a usable account velocity", () => {
    expect(observedAccountTokenVelocity({
      samples: [
        sample(1, 0, 0, { accountFingerprint: null }),
        sample(2, 60_000, 100, { accountFingerprint: null }),
      ],
      window: "1m",
      now: 60_000,
    })).toEqual({ available: false, window: "1m", reason: "account_unverified" });
  });

  test("does not let an old source gap poison a later contiguous trailing window", () => {
    const result = observedAccountTokenVelocity({
      samples: [
        sample(1, 0, 0),
        sample(3, 60_000, 60),
        sample(4, 120_000, 120),
        sample(5, 180_000, 180),
      ],
      window: "1m",
      now: 180_000,
    });
    expect(result).toMatchObject({
      available: true,
      fromSourceSequence: 4,
      throughSourceSequence: 5,
    });
  });
});

describe("automaticRateLimitResetStatusSchema", () => {
  const base = {
    threshold: { remainingPercent: 1, usedPercent: 99 },
    observation: {
      state: "unavailable" as const,
      reason: "weekly_window_unavailable" as const,
    },
  };
  const weeklyWindowResetsAt = 2_000_000_000_000;

  test("accepts only exact privacy-safe attempt state pairings", () => {
    const attempts: unknown[] = [
      null,
      { state: "prepared", weeklyWindowResetsAt },
      { state: "retry_pending", weeklyWindowResetsAt },
      { state: "recovery_pending", weeklyWindowResetsAt },
      { state: "settled", outcome: "reset", weeklyWindowResetsAt },
      { state: "closed", reason: "weekly_window_changed", weeklyWindowResetsAt },
    ];
    for (const lastAttempt of attempts) {
      expect(automaticRateLimitResetStatusSchema.safeParse({
        ...base,
        lastAttempt,
      }).success).toBe(true);
    }
  });

  test("rejects private extras and invalid state-field combinations", () => {
    for (const value of [
      {
        ...base,
        lastAttempt: {
          state: "settled",
          weeklyWindowResetsAt,
        },
      },
      {
        ...base,
        lastAttempt: {
          state: "closed",
          outcome: "reset",
          weeklyWindowResetsAt,
        },
      },
      {
        ...base,
        lastAttempt: {
          state: "settled",
          outcome: "reset",
          weeklyWindowResetsAt,
          idempotencyKey: "00000000-0000-4000-8000-000000000001",
        },
      },
      {
        ...base,
        lastAttempt: {
          state: "settled",
          outcome: "reset",
          weeklyWindowResetsAt,
          accountFingerprint: digest,
        },
      },
      {
        ...base,
        lastAttempt: null,
        resetCredit: { id: "private-credit", description: "private" },
      },
      {
        ...base,
        lastAttempt: null,
        refresh: { state: "settled", reason: "weekly_window_changed" },
      },
    ]) {
      expect(automaticRateLimitResetStatusSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("automaticRateLimitResetDecision", () => {
  const weeklyWindowResetsAtSeconds = 2_000_000_000;
  const weeklyWindowResetsAt = weeklyWindowResetsAtSeconds * 1_000;
  const now = weeklyWindowResetsAt - 3 * 24 * 60 * 60_000;
  const providerPayload = (input: {
    available?: number;
    usedPercent?: number;
    duration?: number | null;
    resetsAt?: number | null;
    limitId?: string;
    slot?: "primary" | "secondary";
  } = {}) => ({
    usage: { summary: { lifetimeTokens: 1 } },
    rateLimits: {
      primary: {
        limitId: input.limitId ?? "codex",
        primary: input.slot === "secondary" ? null : {
          usedPercent: input.usedPercent ?? 99,
          windowDurationMins: input.duration ?? 10_080,
          resetsAt: input.resetsAt ?? weeklyWindowResetsAtSeconds,
        },
        secondary: input.slot === "secondary" ? {
          usedPercent: input.usedPercent ?? 99,
          windowDurationMins: input.duration ?? 10_080,
          resetsAt: input.resetsAt ?? weeklyWindowResetsAtSeconds,
        } : null,
      },
      byLimitId: null,
      resetCreditsAvailable: input.available ?? 1,
    },
  });

  test("triggers at one percent remaining in either weekly window slot", () => {
    for (const slot of ["primary", "secondary"] as const) {
      expect(automaticRateLimitResetDecision({
        providerPayload: providerPayload({
          slot,
          usedPercent: AUTO_RATE_LIMIT_RESET_USED_PERCENT,
        }),
        now,
      })).toEqual({
        eligible: true,
        remainingPercent: 1,
        usedPercent: 99,
        weeklyWindowResetsAt,
      });
    }
  });

  test("does not trigger below the threshold or without a credit", () => {
    expect(automaticRateLimitResetDecision({
      providerPayload: providerPayload({ usedPercent: 98.999 }),
      now,
    })).toEqual({ eligible: false, reason: "below_threshold" });
    expect(automaticRateLimitResetDecision({
      providerPayload: providerPayload({ available: 0 }),
      now,
    })).toEqual({ eligible: false, reason: "credits_unavailable" });
  });

  test("fails closed for stale, malformed, nonweekly, and non-Codex windows", () => {
    for (const payload of [
      providerPayload({ resetsAt: 1 }),
      providerPayload({ resetsAt: 2_000_000_000_000 }),
      providerPayload({ resetsAt: 2_000_000_000.5 }),
      providerPayload({ duration: 300 }),
      providerPayload({ limitId: "other" }),
      { rateLimits: { resetCreditsAvailable: 1 } },
    ]) {
      const decision = automaticRateLimitResetDecision({
        providerPayload: payload,
        now,
      });
      expect(decision.eligible).toBe(false);
    }
  });

  test("accepts at most one weekly duration of reset horizon", () => {
    const maximumFutureReset = now
      + CODEX_WEEKLY_RATE_LIMIT_WINDOW_MINUTES * 60_000;
    expect(automaticRateLimitResetDecision({
      providerPayload: providerPayload({ resetsAt: maximumFutureReset / 1_000 }),
      now,
    })).toMatchObject({ eligible: true, weeklyWindowResetsAt: maximumFutureReset });
    for (const resetsAt of [
      maximumFutureReset / 1_000 + 1,
      99_999_999_999,
    ]) {
      expect(automaticRateLimitResetDecision({
        providerPayload: providerPayload({ resetsAt }),
        now,
      })).toEqual({ eligible: false, reason: "weekly_window_unavailable" });
    }
  });

  test("selects the exact Codex bucket from a multi-limit response", () => {
    const codex = {
      ...providerPayload({ usedPercent: 99 }).rateLimits.primary,
      limitId: null,
    };
    const other = providerPayload({ usedPercent: 100, limitId: "other" }).rateLimits.primary;
    expect(automaticRateLimitResetDecision({
      providerPayload: {
        rateLimits: {
          primary: other,
          byLimitId: { other, codex },
          resetCreditsAvailable: 1,
        },
      },
      now,
    })).toMatchObject({ eligible: true, usedPercent: 99 });
  });

  test("treats the keyed Codex bucket as canonical when the root projection disagrees", () => {
    const staleRoot = providerPayload({ usedPercent: 100 }).rateLimits.primary;
    const currentCodex = providerPayload({ usedPercent: 20 }).rateLimits.primary;
    expect(automaticRateLimitResetDecision({
      providerPayload: {
        rateLimits: {
          primary: staleRoot,
          byLimitId: { codex: currentCodex },
          resetCreditsAvailable: 1,
        },
      },
      now,
    })).toEqual({ eligible: false, reason: "below_threshold" });
  });

  test("rejects contradictory or inferred Codex identities in a keyed map", () => {
    const codex = providerPayload({ usedPercent: 99 }).rateLimits.primary;
    const other = providerPayload({ usedPercent: 99, limitId: "other" }).rateLimits.primary;
    for (const byLimitId of [
      { codex: other },
      { other: codex },
    ]) {
      expect(automaticRateLimitResetDecision({
        providerPayload: {
          rateLimits: {
            primary: codex,
            byLimitId,
            resetCreditsAvailable: 1,
          },
        },
        now,
      })).toEqual({ eligible: false, reason: "weekly_window_unavailable" });
    }
  });

  test("accepts the historical null-id Codex bucket only without a contradictory map", () => {
    const historical = {
      ...providerPayload({ usedPercent: 99 }).rateLimits.primary,
      limitId: null,
    };
    expect(automaticRateLimitResetDecision({
      providerPayload: {
        rateLimits: {
          primary: historical,
          byLimitId: null,
          resetCreditsAvailable: 1,
        },
      },
      now,
    })).toMatchObject({ eligible: true, usedPercent: 99 });
    expect(automaticRateLimitResetDecision({
      providerPayload: {
        rateLimits: {
          primary: historical,
          byLimitId: { other: providerPayload({ limitId: "other" }).rateLimits.primary },
          resetCreditsAvailable: 1,
        },
      },
      now,
    })).toEqual({ eligible: false, reason: "weekly_window_unavailable" });
  });
});
