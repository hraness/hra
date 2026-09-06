import { describe, expect, test } from "bun:test";

import {
  canonicalizeNotificationTimeZone,
  isWithinNotificationHours,
  notificationHoursAllowedWindowEnd,
  notificationHoursPolicySchema,
  notificationHoursUpdateSchema,
} from "./notification-hours";

const utcPolicy = notificationHoursPolicySchema.parse({
  version: 1,
  revision: 1,
  startMinute: 10 * 60,
  endMinute: 22 * 60,
  timeZone: "UTC",
});

describe("notification hours", () => {
  test("parses only the strict v1 contract and canonicalizes an IANA zone", () => {
    expect(notificationHoursPolicySchema.parse({
      version: 1,
      revision: 7,
      startMinute: 600,
      endMinute: 1_320,
      timeZone: "america/new_york",
    })).toEqual({
      version: 1,
      revision: 7,
      startMinute: 600,
      endMinute: 1_320,
      timeZone: "America/New_York",
    });
    expect(canonicalizeNotificationTimeZone("utc")).toBe("UTC");
    expect(() => notificationHoursPolicySchema.parse({
      ...utcPolicy,
      extra: true,
    })).toThrow();
    expect(() => notificationHoursUpdateSchema.parse({
      version: 1,
      startMinute: 600,
      endMinute: 1_320,
      timeZone: "UTC",
      revision: 1,
    })).toThrow();
  });

  test("refuses invalid zones, degenerate ranges, bounds, and revisions", () => {
    for (const timeZone of ["", " UTC", "+00:00", "Mars/Olympus", 42]) {
      expect(() => notificationHoursPolicySchema.parse({
        ...utcPolicy,
        timeZone,
      })).toThrow();
    }
    for (const candidate of [
      { ...utcPolicy, startMinute: 600, endMinute: 600 },
      { ...utcPolicy, startMinute: -1 },
      { ...utcPolicy, endMinute: 1_440 },
      { ...utcPolicy, revision: 0 },
      { ...utcPolicy, revision: Number.MAX_SAFE_INTEGER + 1 },
    ]) expect(() => notificationHoursPolicySchema.parse(candidate)).toThrow();

    const degenerate = notificationHoursUpdateSchema.safeParse({
      version: 1,
      startMinute: 600,
      endMinute: 600,
      timeZone: "UTC",
    });
    expect(degenerate.success).toBe(false);
    if (!degenerate.success) {
      expect(degenerate.error.issues.some((entry) =>
        entry.message === "Notification hours must cover a nonempty wall-clock range."
        && entry.path.length === 1
        && entry.path[0] === "endMinute")).toBe(true);
    }
  });

  test("uses inclusive starts and exclusive ends for a normal UTC range", () => {
    expect(isWithinNotificationHours(utcPolicy, Date.parse("2026-01-01T09:59:59.999Z"))).toBe(false);
    expect(isWithinNotificationHours(utcPolicy, Date.parse("2026-01-01T10:00:00.000Z"))).toBe(true);
    expect(isWithinNotificationHours(utcPolicy, Date.parse("2026-01-01T21:59:59.999Z"))).toBe(true);
    expect(isWithinNotificationHours(utcPolicy, Date.parse("2026-01-01T22:00:00.000Z"))).toBe(false);
  });

  test("handles minute bounds and a one-minute overnight range", () => {
    const allButLastMinute = { ...utcPolicy, startMinute: 0, endMinute: 1_439 };
    expect(isWithinNotificationHours(allButLastMinute, Date.parse("2026-01-01T00:00:00Z"))).toBe(true);
    expect(isWithinNotificationHours(allButLastMinute, Date.parse("2026-01-01T23:58:59Z"))).toBe(true);
    expect(isWithinNotificationHours(allButLastMinute, Date.parse("2026-01-01T23:59:00Z"))).toBe(false);

    const lastMinute = { ...utcPolicy, startMinute: 1_439, endMinute: 0 };
    expect(isWithinNotificationHours(lastMinute, Date.parse("2026-01-01T23:59:00Z"))).toBe(true);
    expect(isWithinNotificationHours(lastMinute, Date.parse("2026-01-02T00:00:00Z"))).toBe(false);
  });

  test("spans midnight without changing either boundary rule", () => {
    const overnight = { ...utcPolicy, startMinute: 1_320, endMinute: 600 };
    expect(isWithinNotificationHours(overnight, Date.parse("2026-01-01T21:59:00Z"))).toBe(false);
    expect(isWithinNotificationHours(overnight, Date.parse("2026-01-01T22:00:00Z"))).toBe(true);
    expect(isWithinNotificationHours(overnight, Date.parse("2026-01-02T09:59:59Z"))).toBe(true);
    expect(isWithinNotificationHours(overnight, Date.parse("2026-01-02T10:00:00Z"))).toBe(false);
  });

  test("maps a spring-forward gap by the instant's actual local wall time", () => {
    const spring = notificationHoursPolicySchema.parse({
      version: 1,
      revision: 1,
      startMinute: 120,
      endMinute: 240,
      timeZone: "America/New_York",
    });
    expect(isWithinNotificationHours(spring, Date.parse("2024-03-10T06:59:00Z"))).toBe(false);
    // 02:00 through 02:59 never occurs; the next instant is local 03:00.
    expect(isWithinNotificationHours(spring, Date.parse("2024-03-10T07:00:00Z"))).toBe(true);
    expect(isWithinNotificationHours(spring, Date.parse("2024-03-10T08:00:00Z"))).toBe(false);
  });

  test("admits both occurrences in a fall-back fold", () => {
    const fold = notificationHoursPolicySchema.parse({
      version: 1,
      revision: 1,
      startMinute: 60,
      endMinute: 120,
      timeZone: "America/New_York",
    });
    expect(isWithinNotificationHours(fold, Date.parse("2024-11-03T05:30:00Z"))).toBe(true);
    expect(isWithinNotificationHours(fold, Date.parse("2024-11-03T06:30:00Z"))).toBe(true);
    expect(isWithinNotificationHours(fold, Date.parse("2024-11-03T07:00:00Z"))).toBe(false);
  });

  test("finds the first disallowed instant across skipped and repeated local times", () => {
    const spring = notificationHoursPolicySchema.parse({
      version: 1,
      revision: 1,
      startMinute: 60,
      endMinute: 240,
      timeZone: "America/New_York",
    });
    expect(notificationHoursAllowedWindowEnd(
      spring,
      Date.parse("2024-03-10T06:30:15.999Z"),
    )).toBe(Date.parse("2024-03-10T08:00:00.000Z"));

    const fold = notificationHoursPolicySchema.parse({
      version: 1,
      revision: 1,
      startMinute: 30,
      endMinute: 120,
      timeZone: "America/New_York",
    });
    expect(notificationHoursAllowedWindowEnd(
      fold,
      Date.parse("2024-11-03T05:30:15.999Z"),
    )).toBe(Date.parse("2024-11-03T07:00:00.000Z"));
  });

  test("returns the exact current-window end or null without naive wall-time construction", () => {
    expect(notificationHoursAllowedWindowEnd(
      utcPolicy,
      Date.parse("2026-01-01T21:59:59.999Z"),
    )).toBe(Date.parse("2026-01-01T22:00:00.000Z"));
    expect(notificationHoursAllowedWindowEnd(
      utcPolicy,
      Date.parse("2026-01-01T22:00:00.000Z"),
    )).toBeNull();

    const overnight = { ...utcPolicy, startMinute: 1_320, endMinute: 600 };
    expect(notificationHoursAllowedWindowEnd(
      overnight,
      Date.parse("2026-01-01T23:15:00.000Z"),
    )).toBe(Date.parse("2026-01-02T10:00:00.000Z"));
  });

  test("does not reinterpret a persisted zone when the host zone changes", () => {
    const policy = notificationHoursPolicySchema.parse({
      ...utcPolicy,
      timeZone: "America/Puerto_Rico",
    });
    const instant = Date.parse("2026-01-01T14:00:00Z");
    const original = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Honolulu";
      const first = isWithinNotificationHours(policy, instant);
      process.env.TZ = "Asia/Tokyo";
      expect(isWithinNotificationHours(policy, instant)).toBe(first);
      expect(first).toBe(true);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  test("rejects invalid epoch instants and is deterministic for valid ones", () => {
    for (const instant of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      1.5,
      8_640_000_000_000_001,
      "2026-01-01T12:00:00Z",
    ]) {
      expect(() => isWithinNotificationHours(utcPolicy, instant)).toThrow();
      expect(() => notificationHoursAllowedWindowEnd(utcPolicy, instant)).toThrow();
    }
    const instant = Date.parse("2026-01-01T12:00:00Z");
    expect(Array.from({ length: 20 }, () => isWithinNotificationHours(utcPolicy, instant)))
      .toEqual(Array.from({ length: 20 }, () => true));
  });
});
