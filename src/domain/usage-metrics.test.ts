import { describe, expect, test } from "bun:test";

import {
  accountUsageCounterSamples,
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
