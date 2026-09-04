import { describe, expect, test } from "bun:test";

import { formatRelativeTime, formatUtcDay, relativeTimeUnits } from "./relative-time";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const now = 1_760_000_000_000;

describe("formatRelativeTime", () => {
  test("collapses anything inside a minute to just now", () => {
    expect(formatRelativeTime(now, now)).toBe("just now");
    expect(formatRelativeTime(now + 59_999, now)).toBe("just now");
    expect(formatRelativeTime(now - 59_999, now)).toBe("just now");
  });

  test("reads the past with ago and the future with in", () => {
    expect(formatRelativeTime(now - 5 * minute, now)).toBe("5 minutes ago");
    expect(formatRelativeTime(now + 5 * minute, now)).toBe("in 5 minutes");
  });

  test("uses the singular at exactly one unit", () => {
    expect(formatRelativeTime(now - minute, now)).toBe("1 minute ago");
    expect(formatRelativeTime(now + hour, now)).toBe("in 1 hour");
    expect(formatRelativeTime(now - day, now)).toBe("1 day ago");
  });

  test("picks the largest unit the magnitude reaches and truncates", () => {
    expect(formatRelativeTime(now - 90 * minute, now)).toBe("1 hour ago");
    expect(formatRelativeTime(now - 47 * hour, now)).toBe("1 day ago");
    expect(formatRelativeTime(now + 10 * day, now)).toBe("in 10 days");
  });

  test("is ordered from the largest unit to the smallest", () => {
    const sizes = relativeTimeUnits.map((unit) => unit.milliseconds);
    expect(sizes).toEqual([...sizes].sort((left, right) => right - left));
  });

  test("renders a non-finite input as unknown rather than throwing", () => {
    expect(formatRelativeTime(Number.NaN, now)).toBe("unknown");
    expect(formatRelativeTime(now, Number.POSITIVE_INFINITY)).toBe("unknown");
  });
});

describe("formatUtcDay", () => {
  test("is the UTC calendar day of the timestamp", () => {
    expect(formatUtcDay(Date.UTC(2026, 8, 4, 23, 30))).toBe("2026-09-04");
    expect(formatUtcDay(Date.UTC(2026, 0, 1))).toBe("2026-01-01");
  });

  test("has no day for a missing or impossible timestamp", () => {
    expect(formatUtcDay(null)).toBeNull();
    expect(formatUtcDay(0)).toBeNull();
    expect(formatUtcDay(-1)).toBeNull();
    expect(formatUtcDay(Number.NaN)).toBeNull();
  });
});
