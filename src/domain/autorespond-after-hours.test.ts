import { describe, expect, spyOn, test } from "bun:test";
import fc from "fast-check";

import {
  parseAutorespondAfterHoursPolicy,
  selectAutorespondAfterHoursTier,
} from "./autorespond-after-hours";

const policy = {
  kind: "autorespond_after_hours",
  version: 1,
  revision: 7,
  enabled: true,
} as const;
const schedule = {
  version: 1,
  revision: 11,
  startMinute: 600,
  endMinute: 1_320,
  timeZone: "UTC",
} as const;
const input = {
  sourceKind: "protocol",
  approvalEligibility: "eligible",
  historyEligibility: "proven",
  policy,
  schedule,
  observedAt: Date.parse("2026-01-01T23:00:00Z"),
} as const;
const baselineLimits = { consecutive: 3, lastHour: 10, lastDay: 40 } as const;
const elevatedLimits = { consecutive: 6, lastHour: 20, lastDay: 80 } as const;

describe("inactive after-hours policy consent", () => {
  test("parses only exact purpose-bound versioned consent and copies it immutably", () => {
    const original = { ...policy };
    const parsed = parseAutorespondAfterHoursPolicy(original);
    expect(parsed).toEqual(policy);
    expect(parsed).not.toBe(original);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parseAutorespondAfterHoursPolicy({ ...policy, enabled: false })?.enabled).toBe(false);
    expect(parseAutorespondAfterHoursPolicy({ ...policy, revision: Number.MAX_SAFE_INTEGER })?.revision)
      .toBe(Number.MAX_SAFE_INTEGER);
    for (const candidate of [
      undefined, null, true, [], {},
      { version: 1, revision: 7, enabled: true },
      { ...policy, kind: "notification_email" },
      { ...policy, version: 2 },
      { ...policy, revision: 0 },
      { ...policy, revision: 1.5 },
      { ...policy, revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...policy, enabled: "true" },
      { ...policy, limits: elevatedLimits },
    ]) expect(parseAutorespondAfterHoursPolicy(candidate)).toBeNull();
  });

  test("matches an independent exact-shape predicate over arbitrary JSON", () => {
    fc.assert(fc.property(fc.jsonValue(), (value) => {
      const record = value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
      const valid = record !== null
        && Object.keys(record).sort().join(",") === "enabled,kind,revision,version"
        && record.kind === "autorespond_after_hours"
        && record.version === 1
        && typeof record.enabled === "boolean"
        && typeof record.revision === "number"
        && Number.isSafeInteger(record.revision)
        && record.revision >= 1;
      expect(parseAutorespondAfterHoursPolicy(value) !== null).toBe(valid);
    }), { seed: 71, numRuns: 300 });
  });

  test("round-trips valid consent and refuses arbitrary extra limit fields", () => {
    fc.assert(fc.property(
      fc.boolean(),
      fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
      fc.jsonValue(),
      (enabled, revision, limits) => {
        const value = { ...policy, enabled, revision };
        expect(parseAutorespondAfterHoursPolicy(value)).toEqual(value);
        expect(parseAutorespondAfterHoursPolicy(JSON.parse(JSON.stringify(value)) as unknown)).toEqual(value);
        expect(parseAutorespondAfterHoursPolicy({ ...value, limits })).toBeNull();
      },
    ), { seed: 72, numRuns: 200 });
  });

  test("does not invoke accessors or accept exotic, hidden, symbolic, or aliased state", () => {
    let reads = 0;
    const accessor = { ...policy, get enabled() { reads += 1; return true; } };
    const hidden = Object.defineProperty({ ...policy }, "hidden", { value: true });
    const symbolic = { ...policy, [Symbol("authority")]: true };
    const exotic = Object.create(policy) as unknown;
    const cyclic: Record<string, unknown> = { ...policy };
    cyclic.self = cyclic;
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    for (const candidate of [accessor, hidden, symbolic, exotic, cyclic, proxy]) {
      expect(parseAutorespondAfterHoursPolicy(candidate)).toBeNull();
      expect(selectAutorespondAfterHoursTier({ ...input, policy: candidate }).tier).toBe("baseline");
    }
    expect(reads).toBe(0);
    expect(selectAutorespondAfterHoursTier({ ...input, schedule: policy }).tier).toBe("baseline");
  });
});

describe("inactive after-hours provisional selection", () => {
  test("selects only the closed protocol tier and never grants runtime authority", () => {
    const result = selectAutorespondAfterHoursTier(input);
    expect(result).toEqual({
      version: 1,
      mode: "provisional",
      runtimeMutationAllowed: false,
      tier: "after_hours",
      limits: elevatedLimits,
      reason: "eligible_outside_hours",
      snapshot: { policy, schedule, observedAt: input.observedAt },
    });
  });

  test.each([
    ["absent", undefined, "input_invalid"],
    ["empty", {}, "input_invalid"],
    ["missing policy", { ...input, policy: null }, "policy_missing"],
    ["disabled", { ...input, policy: { ...policy, enabled: false } }, "policy_disabled"],
    ["malformed", { ...input, policy: { enabled: true } }, "policy_invalid"],
    ["ineligible approval", { ...input, approvalEligibility: "ineligible" }, "approval_ineligible"],
    ["unknown approval", { ...input, approvalEligibility: "unknown" }, "approval_ineligible"],
    ["unknown history", { ...input, historyEligibility: "unknown" }, "history_unproven"],
    ["unproven human reset", { ...input, historyEligibility: "human_reset_required" }, "human_reset_required"],
    ["missing schedule", { ...input, schedule: null }, "schedule_invalid"],
    ["invalid zone", { ...input, schedule: { ...schedule, timeZone: "Mars/Olympus" } }, "schedule_invalid"],
    ["invalid instant", { ...input, observedAt: -1 }, "clock_invalid"],
    ["arbitrary limits", { ...input, limits: { consecutive: 999 } }, "input_invalid"],
  ] as const)("keeps %s on the baseline", (_name, value, reason) => {
    expect(selectAutorespondAfterHoursTier(value)).toEqual({
      version: 1,
      mode: "provisional",
      runtimeMutationAllowed: false,
      tier: "baseline",
      limits: baselineLimits,
      reason,
      snapshot: null,
    });
  });

  test("omitted consent is disabled and notification consent cannot substitute for it", () => {
    const withoutPolicy = {
      sourceKind: input.sourceKind,
      approvalEligibility: input.approvalEligibility,
      historyEligibility: input.historyEligibility,
      schedule,
      observedAt: input.observedAt,
    };
    expect(selectAutorespondAfterHoursTier(withoutPolicy).reason).toBe("policy_missing");
    for (const enabled of [true, false]) {
      expect(selectAutorespondAfterHoursTier({
        ...input, policy: { version: 1, revision: 7, enabled },
      }).reason).toBe("policy_invalid");
      expect(selectAutorespondAfterHoursTier({ ...withoutPolicy, notificationEmailEnabled: enabled }).tier)
        .toBe("baseline");
    }
  });

  test.each([
    ["2026-01-01T09:59:59.999Z", "after_hours"],
    ["2026-01-01T10:00:00.000Z", "baseline"],
    ["2026-01-01T21:59:59.999Z", "baseline"],
    ["2026-01-01T22:00:00.000Z", "after_hours"],
  ] as const)("uses the immutable schedule at %s", (instant, tier) => {
    const result = selectAutorespondAfterHoursTier({ ...input, observedAt: Date.parse(instant) });
    expect(result.tier).toBe(tier);
    expect(result.snapshot?.policy.revision).toBe(7);
    expect(result.snapshot?.schedule.revision).toBe(11);
    expect(result.snapshot?.observedAt).toBe(Date.parse(instant));
    expect(result.runtimeMutationAllowed).toBe(false);
  });

  test.each([
    ["2026-01-01T21:59:59.999Z", "after_hours"],
    ["2026-01-01T22:00:00Z", "baseline"],
    ["2026-01-02T09:59:59.999Z", "baseline"],
    ["2026-01-02T10:00:00Z", "after_hours"],
  ] as const)("handles overnight hours at %s without resetting anything", (instant, tier) => {
    expect(selectAutorespondAfterHoursTier({
      ...input,
      schedule: { ...schedule, startMinute: 1_320, endMinute: 600 },
      observedAt: Date.parse(instant),
    }).tier).toBe(tier);
  });

  test.each([
    [120, 240, "2024-03-10T06:59:59Z", "after_hours"],
    [120, 240, "2024-03-10T07:00:00Z", "baseline"],
    [120, 240, "2024-03-10T08:00:00Z", "after_hours"],
    [60, 120, "2024-11-03T05:30:00Z", "baseline"],
    [60, 120, "2024-11-03T06:30:00Z", "baseline"],
    [60, 120, "2024-11-03T07:00:00Z", "after_hours"],
  ] as const)("evaluates DST hours %i..%i at %s", (startMinute, endMinute, instant, tier) => {
    expect(selectAutorespondAfterHoursTier({
      ...input,
      schedule: { ...schedule, startMinute, endMinute, timeZone: "America/New_York" },
      observedAt: Date.parse(instant),
    }).tier).toBe(tier);
  });

  test("every malformed instant or schedule stays below the elevated tier", () => {
    for (const observedAt of [undefined, null, NaN, Infinity, -1, 1.5, 8_640_000_000_000_001, "2026-01-01"]) {
      const result = selectAutorespondAfterHoursTier({ ...input, observedAt });
      expect(result.tier).toBe("baseline");
      expect(result.limits).toEqual(baselineLimits);
      expect(result.runtimeMutationAllowed).toBe(false);
    }
    for (const candidate of [
      { ...schedule, startMinute: 1_320 },
      { ...schedule, revision: 0 },
      { ...schedule, version: 2 },
      { ...schedule, endMinute: 1_440 },
      { ...schedule, enabled: true },
    ]) expect(selectAutorespondAfterHoursTier({ ...input, schedule: candidate }).tier).toBe("baseline");
  });

  test("failed wall-clock evaluation returns only a provisional baseline", () => {
    const formatter = spyOn(Intl.DateTimeFormat.prototype, "formatToParts")
      .mockImplementation(() => []);
    try {
      expect(selectAutorespondAfterHoursTier(input)).toEqual({
        version: 1,
        mode: "provisional",
        runtimeMutationAllowed: false,
        tier: "baseline",
        limits: baselineLimits,
        reason: "time_evaluation_failed",
        snapshot: null,
      });
    } finally {
      formatter.mockRestore();
    }
    expect(selectAutorespondAfterHoursTier(input).tier).toBe("after_hours");
  });

  test("requires every positive gate for arbitrary valid UTC and overnight schedules", () => {
    fc.assert(fc.property(
      fc.boolean(),
      fc.constantFrom("protocol", "prose"),
      fc.constantFrom("eligible", "ineligible", "unknown"),
      fc.constantFrom("proven", "unknown", "human_reset_required"),
      fc.integer({ min: 0, max: 1_439 }),
      fc.integer({ min: 1, max: 1_439 }),
      fc.integer({ min: 0, max: 1_439 }),
      (enabled, sourceKind, approvalEligibility, historyEligibility, startMinute, length, minute) => {
        const endMinute = (startMinute + length) % 1_440;
        const withinHours = (minute - startMinute + 1_440) % 1_440 < length;
        const result = selectAutorespondAfterHoursTier({
          ...input,
          sourceKind,
          approvalEligibility,
          historyEligibility,
          policy: { ...policy, enabled },
          schedule: { ...schedule, startMinute, endMinute },
          observedAt: Date.parse("2026-01-01T00:00:00Z") + minute * 60_000,
        });
        const elevated = enabled && sourceKind === "protocol" && approvalEligibility === "eligible"
          && historyEligibility === "proven" && !withinHours;
        expect(result.tier).toBe(elevated ? "after_hours" : "baseline");
        expect(result.limits).toEqual(elevated ? elevatedLimits : baselineLimits);
        expect(result.runtimeMutationAllowed).toBe(false);
      },
    ), { seed: 75, numRuns: 500 });
  });

  test("prose never receives the higher tier for any JSON policy, schedule, or instant", () => {
    fc.assert(fc.property(fc.jsonValue(), fc.jsonValue(), fc.jsonValue(), (consent, hours, observedAt) => {
      const result = selectAutorespondAfterHoursTier({
        ...input, sourceKind: "prose", policy: consent, schedule: hours, observedAt,
      });
      expect(result.tier).toBe("baseline");
      expect(result.limits).toEqual(baselineLimits);
      expect(result.runtimeMutationAllowed).toBe(false);
    }), { seed: 73, numRuns: 200 });
    expect(selectAutorespondAfterHoursTier({ ...input, sourceKind: "prose" }).reason).toBe("prose_baseline");
  });

  test("is total over JSON and never treats a legacy consecutive floor as a proven reset", () => {
    fc.assert(fc.property(fc.jsonValue(), (value) => {
      const result = selectAutorespondAfterHoursTier(value);
      expect(result.runtimeMutationAllowed).toBe(false);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.limits)).toBe(true);
      expect([baselineLimits, elevatedLimits]).toContainEqual(result.limits);
    }), { seed: 74, numRuns: 300 });
    for (const instant of ["2026-01-01T23:00:00Z", "2026-01-03T23:00:00Z"]) {
      expect(selectAutorespondAfterHoursTier({
        ...input, observedAt: Date.parse(instant), historyEligibility: "human_reset_required",
      }).reason).toBe("human_reset_required");
    }
    expect(selectAutorespondAfterHoursTier({ ...input, consecutiveCount: 3 }).tier).toBe("baseline");
  });

  test("detaches and freezes the complete selected snapshot without mutating callers", () => {
    const mutable = { ...input, policy: { ...policy }, schedule: { ...schedule, timeZone: "utc" } };
    const result = selectAutorespondAfterHoursTier(mutable);
    expect(result.tier).toBe("after_hours");
    expect(result.snapshot).not.toBeNull();
    expect(result.snapshot?.schedule.timeZone).toBe("UTC");
    expect(mutable.schedule.timeZone).toBe("utc");
    expect(result.snapshot?.policy).not.toBe(mutable.policy);
    expect(result.snapshot?.schedule).not.toBe(mutable.schedule);
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot?.policy)).toBe(true);
    expect(Object.isFrozen(result.snapshot?.schedule)).toBe(true);
    mutable.schedule.timeZone = "Asia/Tokyo";
    expect(Reflect.set(mutable.policy, "enabled", false)).toBe(true);
    expect(result.snapshot?.schedule.timeZone).toBe("UTC");
    expect(result.snapshot?.policy.enabled).toBe(true);
    expect(Reflect.set(result.limits, "consecutive", 999)).toBe(false);
    expect(Reflect.set(result, "runtimeMutationAllowed", true)).toBe(false);
    expect(Reflect.set(result.snapshot!, "observedAt", 0)).toBe(false);
    expect(selectAutorespondAfterHoursTier(input).limits).toEqual(elevatedLimits);
  });
});
