import { describe, expect, test } from "bun:test";

import type { UsageLimit, UsageProjection } from "../oompa/cloud";
import {
  accountUsageSummary,
  bindingWindow,
  formatDurationUntil,
  formatTokenRate,
  nextReset,
  outlookSentence,
  providerUsageRollup,
  usageOutlook,
  usageRate,
  weeklyWindow,
  type UsageObservation,
} from "./usage-meter";

const hour = 3_600_000;
const now = 1_760_000_000_000;

function limit(overrides: Partial<UsageLimit> & Readonly<{ id: string }>): UsageLimit {
  return {
    individual: false,
    name: overrides.id,
    primary: { resetsAt: now + 2 * hour, usedPercent: 40, windowDurationMinutes: 300 },
    reached: false,
    secondary: { resetsAt: now + 100 * hour, usedPercent: 10, windowDurationMinutes: 7 * 24 * 60 },
    unlimited: false,
    ...overrides,
  };
}

function ready(
  limits: readonly UsageLimit[],
  lifetimeTokens = 1_000,
  resetCredits?: number,
): UsageProjection {
  return {
    data: {
      currentStreakDays: 1,
      daily: [],
      lifetimeTokens,
      limits,
      longestRunningTurnSeconds: 0,
      longestStreakDays: 1,
      peakDailyTokens: 0,
      ...(resetCredits === undefined ? {} : { resetCredits }),
    },
    state: "ready",
  };
}

const observe = (
  observedAt: number,
  usedPercent: number,
  lifetimeTokens: number,
): UsageObservation => ({
  observedAt,
  projection: ready([limit({ id: "codex", primary: { resetsAt: now + 2 * hour, usedPercent, windowDurationMinutes: 300 } })], lifetimeTokens),
});

describe("bindingWindow", () => {
  test("picks the most used window across limits, then the earliest reset", () => {
    const binding = bindingWindow([
      limit({ id: "a" }),
      limit({ id: "b", primary: { resetsAt: now + hour, usedPercent: 90, windowDurationMinutes: 300 } }),
      limit({ id: "c", primary: { resetsAt: now + 3 * hour, usedPercent: 90, windowDurationMinutes: 300 } }),
    ]);
    expect(binding?.limitId).toBe("b");
    expect(binding?.usedPercent).toBe(90);
  });

  test("ignores unlimited limits and yields null with nothing bound", () => {
    expect(bindingWindow([limit({ id: "a", primary: null, secondary: null, unlimited: true })])).toBeNull();
    expect(bindingWindow([])).toBeNull();
  });

  test("finds the seven-day window and the next reset", () => {
    const limits = [limit({ id: "codex" })];
    expect(weeklyWindow(limits)?.windowDurationMinutes).toBe(7 * 24 * 60);
    expect(nextReset(limits, now)).toBe(now + 2 * hour);
    expect(nextReset(limits, now + 200 * hour)).toBeNull();
  });
});

describe("usageRate", () => {
  test("needs two samples of the same window at least five minutes apart", () => {
    expect(usageRate([observe(now, 50, 500)], bindingWindow([limit({ id: "codex" })]))).toBeNull();
    expect(usageRate([observe(now, 50, 500), observe(now - 60_000, 49, 400)], bindingWindow([limit({ id: "codex" })]))).toBeNull();
  });

  test("measures percent per hour and tokens per minute over the span", () => {
    const history = [observe(now, 60, 6_000), observe(now - hour, 50, 3_000), observe(now - 2 * hour, 40, 0)];
    const rate = usageRate(history, bindingWindow([limit({ id: "codex" })]));
    expect(rate?.percentPerHour).toBe(10);
    expect(rate?.tokensPerMinute).toBe(50);
    expect(rate?.spanMs).toBe(2 * hour);
  });

  test("drops the token rate when the lifetime counter went backwards", () => {
    const history = [observe(now, 60, 100), observe(now - hour, 50, 3_000)];
    const rate = usageRate(history, bindingWindow([limit({ id: "codex" })]));
    expect(rate?.percentPerHour).toBe(10);
    expect(rate?.tokensPerMinute).toBeNull();
  });

  test("ignores samples from before the window's last reset", () => {
    const stale: UsageObservation = {
      observedAt: now - hour,
      projection: ready([limit({ id: "codex", primary: { resetsAt: now - 30 * 60_000, usedPercent: 95, windowDurationMinutes: 300 } })]),
    };
    expect(usageRate([observe(now, 5, 100), stale], bindingWindow([limit({ id: "codex" })]))).toBeNull();
  });
});

describe("usageOutlook", () => {
  const binding = bindingWindow([limit({ id: "codex" })]);
  test("reset first means surplus; exhaustion first means running out", () => {
    expect(usageOutlook(binding, { percentPerHour: 10, spanMs: hour, tokensPerMinute: null }, now).kind).toBe("surplus");
    expect(usageOutlook(binding, { percentPerHour: 60, spanMs: hour, tokensPerMinute: null }, now).kind).toBe("running_out");
  });
  test("no rate is steady, no window is unlimited, a full window is exhausted", () => {
    expect(usageOutlook(binding, null, now).kind).toBe("steady");
    expect(usageOutlook(null, null, now).kind).toBe("unlimited");
    expect(usageOutlook(
      bindingWindow([limit({ id: "codex", primary: { resetsAt: now + hour, usedPercent: 100, windowDurationMinutes: 300 } })]),
      null,
      now,
    ).kind).toBe("exhausted");
  });
});

describe("accountUsageSummary and providerUsageRollup", () => {
  test("summarises the newest ready observation with its history", () => {
    const history = [observe(now - hour, 50, 3_000), observe(now, 60, 6_000)];
    const summary = accountUsageSummary(history, now + 60_000);
    expect(summary?.remainingPercent).toBe(40);
    expect(summary?.ageMs).toBe(60_000);
    expect(summary?.rate?.percentPerHour).toBe(10);
    expect(summary?.resetCredits).toBeNull();
    expect(summary?.outlook.kind).toBe("surplus");
  });

  test("a non-ready newest projection is unknown, never zero", () => {
    expect(accountUsageSummary([{ observedAt: now, projection: { state: "failed" } }], now)).toBeNull();
    expect(accountUsageSummary([], now)).toBeNull();
  });

  test("rolls providers up by mean remaining, earliest reset, summed credits and rates", () => {
    const one = accountUsageSummary([observe(now, 20, 0)], now);
    const two = accountUsageSummary([{
      observedAt: now,
      projection: ready([limit({ id: "codex", primary: { resetsAt: now + hour, usedPercent: 80, windowDurationMinutes: 300 } })], 0, 2),
    }], now);
    const rollup = providerUsageRollup([one, two, null]);
    expect(rollup.accounts).toBe(3);
    expect(rollup.unknown).toBe(1);
    expect(rollup.remainingPercent).toBe(50);
    expect(rollup.nextResetAt).toBe(now + hour);
    expect(rollup.resetCredits).toBe(2);
    expect(rollup.tokensPerMinute).toBeNull();
    expect(rollup.outlook).toBe("steady");
    expect(rollup.stale).toBe(false);
  });

  test("flags a stale observation", () => {
    const old = accountUsageSummary([observe(now - 3 * hour, 20, 0)], now);
    expect(providerUsageRollup([old]).stale).toBe(true);
  });
});

describe("formatting", () => {
  test("durations are coarse and never negative", () => {
    expect(formatDurationUntil(now + 130 * 60_000, now)).toBe("2h 10m");
    expect(formatDurationUntil(now + 3 * 24 * hour + 4 * hour, now)).toBe("3d 4h");
    expect(formatDurationUntil(now + 45 * 60_000, now)).toBe("45m");
    expect(formatDurationUntil(now - 5, now)).toBe("now");
  });
  test("token rates scale", () => {
    expect(formatTokenRate(830)).toBe("830 tok/min");
    expect(formatTokenRate(1_240)).toBe("1.2k tok/min");
    expect(formatTokenRate(12_400)).toBe("12k tok/min");
    expect(formatTokenRate(1_200_000)).toBe("1.2M tok/min");
  });
  test("the outlook sentence names the reset", () => {
    const rollup = providerUsageRollup([accountUsageSummary([observe(now, 20, 0)], now)]);
    expect(outlookSentence(rollup, now)).toBe("Idle; resets in 2h.");
  });
});
