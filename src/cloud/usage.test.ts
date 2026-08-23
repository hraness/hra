import { describe, expect, test } from "bun:test";

import { parseUsageProjection, usageSnapshotDisposition } from "./usage";

const ready = {
  data: {
    currentStreakDays: 2,
    daily: [{ startDate: "2026-08-22", tokens: 123 }],
    lifetimeTokens: 1000,
    limits: [{
      id: "primary",
      individual: false,
      name: "Primary",
      primary: { resetsAt: 2_000_000, usedPercent: 42, windowDurationMinutes: 300 },
      reached: false,
      secondary: null,
      unlimited: false,
    }],
    longestRunningTurnSeconds: 120,
    longestStreakDays: 4,
    peakDailyTokens: 500,
  },
  state: "ready",
} as const;

describe("usage projection laws", () => {
  test("keeps unavailable distinct from a ready zero", () => {
    expect(parseUsageProjection({ state: "unavailable" })).toEqual({ state: "unavailable" });
    expect(parseUsageProjection(ready)).toEqual(ready);
  });

  test("rejects duplicate limit IDs, duplicate days, and oversized history", () => {
    expect(parseUsageProjection({
      ...ready,
      data: { ...ready.data, limits: [ready.data.limits[0], ready.data.limits[0]] },
    })).toBeNull();
    expect(parseUsageProjection({
      ...ready,
      data: { ...ready.data, daily: [ready.data.daily[0], ready.data.daily[0]] },
    })).toBeNull();
    expect(parseUsageProjection({
      ...ready,
      data: {
        ...ready.data,
        daily: Array.from({ length: 367 }, (_, index) => ({
          startDate: `2025-01-${String((index % 28) + 1).padStart(2, "0")}`,
          tokens: index,
        })),
      },
    })).toBeNull();
  });

  test("orders out-of-order snapshots deterministically", () => {
    const current = {
      digest: "a",
      observedAt: 100,
      sourceDeviceId: "device-a",
      sourceRevision: 2,
    };
    expect(usageSnapshotDisposition(current, null, {
      ...current,
      digest: "b",
      observedAt: 99,
      sourceRevision: 3,
    }, 1000)).toBe("store");
    expect(usageSnapshotDisposition(current, current, current, 1000)).toBe("replay");
    expect(usageSnapshotDisposition(current, current, { ...current, digest: "changed" }, 1000))
      .toBe("conflict");
    expect(usageSnapshotDisposition(current, null, { ...current, observedAt: 301_001 }, 1_000))
      .toBe("future");
    expect(usageSnapshotDisposition({
      ...current,
      sourceDeviceId: "device_Z",
    }, null, {
      ...current,
      digest: "ascii-winner",
      sourceDeviceId: "device_a",
    }, 1_000)).toBe("replace");
    expect(usageSnapshotDisposition(current, null, {
      ...current,
      digest: "higher-revision",
      sourceRevision: 3,
    }, 1_000)).toBe("replace");
  });
});
