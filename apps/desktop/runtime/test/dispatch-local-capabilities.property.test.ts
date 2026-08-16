import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import { compareDispatchAccounts } from "../src/dispatch/local-capabilities";
import {
  dispatchBudget,
  dispatchBudgetRefreshIsDue,
  dispatchBudgetRefreshRetryAt,
  dispatchBudgetRefreshRetryMs,
} from "../src/accounts/dispatch-budget";
import type { DispatchAccountSummary } from "../src/internal-contracts";

const now = Date.parse("2026-07-21T12:00:00.000Z");

function account(index: number, usedPercent: number): DispatchAccountSummary {
  return {
    id: `acct_property${String(index).padStart(4, "0")}`,
    revision: 1,
    label: `Account ${index}`,
    selected: false,
    identityLabel: null,
    planLabel: null,
    usageRemainingPercent: 100 - usedPercent,
    authState: "signedIn",
    login: { state: "idle" },
    usage: {
      state: "ready",
      updatedAt: new Date(now).toISOString(),
      tokens: { state: "unavailable" },
      limits: [{
        id: "codex",
        name: "Codex",
        primary: { usedPercent, windowDurationMinutes: 300, resetsAt: null },
        secondary: null,
        individual: null,
        unlimited: false,
        reached: usedPercent === 100,
      }],
    },
    runtime: { state: "stopped", generation: 0 },
  };
}

test("budget ordering is permutation invariant and maximizes conservative remaining capacity", () => {
  assertProperty(fc.property(
    fc.uniqueArray(fc.integer({ min: 0, max: 99 }), { minLength: 1, maxLength: 24 }),
    (usedPercents) => {
      const accounts = usedPercents.map((used, index) => account(index, used));
      const comparator = (left: DispatchAccountSummary, right: DispatchAccountSummary) =>
        compareDispatchAccounts(left, right, new Map(), now);
      const forward = accounts.toSorted(comparator);
      const reverse = [...accounts].reverse().toSorted(comparator);
      expect(reverse.map(({ id }) => id)).toEqual(forward.map(({ id }) => id));
      expect(forward[0]?.usage).toMatchObject({
        limits: [{ primary: { usedPercent: Math.min(...usedPercents) } }],
      });
    },
  ));
});

test("fresh multi-bucket budgets equal their most constrained remaining percentage", () => {
  assertProperty(fc.property(
    fc.array(fc.integer({ min: 0, max: 99 }), { minLength: 1, maxLength: 24 }),
    (usedPercents) => {
      const usage = account(0, 0).usage;
      if (usage.state !== "ready") throw new Error("expected ready usage fixture");
      const baseLimit = usage.limits[0];
      if (baseLimit === undefined) throw new Error("expected rate-limit fixture");
      expect(dispatchBudget({
        ...usage,
        limits: usedPercents.map((usedPercent, index) => ({
          ...baseLimit,
          id: `bucket-${String(index)}`,
          name: `Bucket ${String(index)}`,
          primary: {
            usedPercent,
            windowDurationMinutes: 300,
            resetsAt: new Date(now + 60_000).toISOString(),
          },
        })),
      }, now)).toEqual({
        kind: "known",
        remainingPercent: 100 - Math.max(...usedPercents),
      });
    },
  ));
});

test("a fresh exhausted bucket dominates unrelated stale buckets", () => {
  assertProperty(fc.property(
    fc.integer({ min: 0, max: 100 }),
    fc.integer({ min: 1, max: 100 }),
    (staleUsedPercent, exhaustedUsedPercent) => {
      const usage = account(0, staleUsedPercent).usage;
      if (usage.state !== "ready") throw new Error("expected ready usage fixture");
      const baseLimit = usage.limits[0];
      if (baseLimit === undefined) throw new Error("expected rate-limit fixture");
      expect(dispatchBudget({
        ...usage,
        limits: [
          {
            ...baseLimit,
            primary: {
              usedPercent: staleUsedPercent,
              windowDurationMinutes: 300,
              resetsAt: new Date(now - 1).toISOString(),
            },
          },
          {
            ...baseLimit,
            id: "exhausted",
            name: "Exhausted",
            reached: true,
            primary: {
              usedPercent: exhaustedUsedPercent,
              windowDurationMinutes: 300,
              resetsAt: new Date(now + 60_000).toISOString(),
            },
          },
        ],
      }, now)).toEqual({ kind: "exhausted" });
    },
  ));
});

test("budget refresh retry windows remain closed until the exact deadline", () => {
  assertProperty(fc.property(
    fc.integer({
      min: 0,
      max: Number.MAX_SAFE_INTEGER - dispatchBudgetRefreshRetryMs,
    }),
    fc.integer({ min: 0, max: dispatchBudgetRefreshRetryMs - 1 }),
    (startedAt, elapsedBeforeDeadline) => {
      const retryAt = dispatchBudgetRefreshRetryAt(startedAt);
      expect(dispatchBudgetRefreshIsDue(startedAt + elapsedBeforeDeadline, retryAt)).toBeFalse();
      expect(dispatchBudgetRefreshIsDue(retryAt, retryAt)).toBeTrue();
    },
  ));
});

test("invalid refresh clocks wait for a valid clock before retrying", () => {
  for (const clock of [
    Number.NaN,
    Number.NEGATIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    -1,
  ]) {
    const retryAt = dispatchBudgetRefreshRetryAt(clock);
    expect(retryAt).toBe(Number.POSITIVE_INFINITY);
    expect(dispatchBudgetRefreshIsDue(clock, retryAt)).toBeFalse();
    expect(dispatchBudgetRefreshIsDue(now, retryAt)).toBeTrue();
  }
});

test("unrepresentable refresh deadlines fail closed without overflow hot-looping", () => {
  for (const clock of [
    Number.MAX_SAFE_INTEGER - dispatchBudgetRefreshRetryMs + 1,
    Number.MAX_SAFE_INTEGER,
  ]) {
    const retryAt = dispatchBudgetRefreshRetryAt(clock);
    expect(retryAt).toBe(Number.NEGATIVE_INFINITY);
    expect(dispatchBudgetRefreshIsDue(clock, retryAt)).toBeFalse();
    expect(dispatchBudgetRefreshIsDue(now, retryAt)).toBeFalse();
  }
});
