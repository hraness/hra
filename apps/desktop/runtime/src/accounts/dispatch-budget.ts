import type { AccountUsageState } from "../internal-contracts";

export const dispatchBudgetFreshnessMs = 2 * 60 * 1_000;
export const dispatchBudgetRefreshRetryMs = 30_000;
export const chatProactiveRerouteThresholdPercent = 10;
const maximumFutureClockSkewMs = 5_000;

export type DispatchBudget =
  | Readonly<{ kind: "known"; remainingPercent: number }>
  | Readonly<{ kind: "unknown" }>
  | Readonly<{ kind: "stale" }>
  | Readonly<{ kind: "exhausted" }>;

export function dispatchBudget(
  usage: AccountUsageState,
  now: number,
): DispatchBudget {
  if (!Number.isFinite(now)) return { kind: "stale" };
  if (usage.state !== "ready") return { kind: "unknown" };
  const observedAt = Date.parse(usage.updatedAt);
  if (
    !Number.isFinite(observedAt) ||
    observedAt > now + maximumFutureClockSkewMs ||
    now - observedAt > dispatchBudgetFreshnessMs
  ) {
    return { kind: "stale" };
  }
  if (usage.limits.length === 0) return { kind: "unknown" };

  const bucketScores: number[] = [];
  let stale = false;
  let exhausted = false;
  let unknown = false;
  for (const limit of usage.limits) {
    const constraints: number[] = [];
    let limitIsStale = false;
    for (const window of [limit.primary, limit.secondary]) {
      if (window === null) continue;
      if (window.resetsAt !== null) {
        const resetsAt = Date.parse(window.resetsAt);
        if (!Number.isFinite(resetsAt) || resetsAt <= now) {
          limitIsStale = true;
          continue;
        }
      }
      constraints.push(100 - window.usedPercent);
    }
    if (limit.individual !== undefined && limit.individual !== null) {
      const resetsAt = Date.parse(limit.individual.resetsAt);
      if (!Number.isFinite(resetsAt) || resetsAt <= now) {
        limitIsStale = true;
      } else {
        constraints.push(limit.individual.remainingPercent);
      }
    }
    if (limitIsStale) {
      stale = true;
      continue;
    }
    if (limit.reached) exhausted = true;
    if (constraints.length === 0) {
      if (limit.unlimited === true) {
        bucketScores.push(100);
        continue;
      }
      unknown = true;
      continue;
    }
    const score = Math.min(...constraints);
    if (score <= 0) exhausted = true;
    bucketScores.push(score);
  }

  // A fresh, explicit exhaustion signal remains authoritative even when a
  // different provider bucket has crossed its reset boundary. This prevents
  // stale fallback routing from selecting an account known to have no budget.
  if (exhausted) return { kind: "exhausted" };
  if (stale) return { kind: "stale" };
  if (unknown) return { kind: "unknown" };
  if (bucketScores.length === 0) return { kind: "unknown" };
  const remainingPercent = Math.min(...bucketScores);
  return remainingPercent <= 0
    ? { kind: "exhausted" }
    : { kind: "known", remainingPercent };
}

export function dispatchBudgetNeedsRefresh(
  usage: AccountUsageState,
  now: number,
): boolean {
  const budget = dispatchBudget(usage, now);
  return budget.kind === "stale" || budget.kind === "unknown";
}

export function chatRoutingBudget(
  usage: AccountUsageState,
  now: number,
): "healthy" | "low" | "exhausted" | "unknown" {
  const budget = dispatchBudget(usage, now);
  switch (budget.kind) {
    case "known":
      return budget.remainingPercent < chatProactiveRerouteThresholdPercent
        ? "low"
        : "healthy";
    case "exhausted":
      return "exhausted";
    case "stale":
    case "unknown":
      return "unknown";
  }
}

export function dispatchBudgetRefreshRetryAt(now: number): number {
  // Positive infinity means "retry once the clock is valid again". Negative
  // infinity means no future deadline can be represented without overflow.
  if (!Number.isSafeInteger(now) || now < 0) return Number.POSITIVE_INFINITY;
  if (now > Number.MAX_SAFE_INTEGER - dispatchBudgetRefreshRetryMs) {
    return Number.NEGATIVE_INFINITY;
  }
  return now + dispatchBudgetRefreshRetryMs;
}

export function dispatchBudgetRefreshIsDue(
  now: number,
  retryAt: number,
): boolean {
  if (!Number.isSafeInteger(now) || now < 0) return false;
  if (retryAt === Number.POSITIVE_INFINITY) return true;
  if (retryAt === Number.NEGATIVE_INFINITY) return false;
  return Number.isSafeInteger(retryAt) && retryAt >= 0 && now >= retryAt;
}
