/**
 * Fictional usage observations for the product examples and the browser
 * fixture, folded through the real meter reducers. Two Codex accounts: one
 * comfortably ahead of its reset, one nearly spent with a reset credit left.
 */
import type { UsageOverview } from "../../src/data/usage";
import { accountUsageSummary, providerUsageRollup, type UsageObservation } from "../../src/model/usage-meter";
import type { UsageLimit, UsageProjection } from "../../src/oompa/cloud";

const hour = 3_600_000;

function projection(now: number, used: number, weekly: number, lifetimeTokens: number, resetCredits: number): UsageProjection {
  const limits: UsageLimit[] = [{
    id: "codex",
    individual: false,
    name: "Codex",
    primary: { resetsAt: now + 2 * hour + 10 * 60_000, usedPercent: used, windowDurationMinutes: 300 },
    reached: used >= 100,
    secondary: { resetsAt: now + 3 * 24 * hour + 4 * hour, usedPercent: weekly, windowDurationMinutes: 7 * 24 * 60 },
    unlimited: false,
  }];
  return {
    data: {
      currentStreakDays: 6, daily: [{ startDate: "2026-09-08", tokens: 412_000 }], lifetimeTokens, limits,
      longestRunningTurnSeconds: 1_840, longestStreakDays: 14, peakDailyTokens: 950_000, resetCredits,
    },
    state: "ready",
  };
}

function history(now: number, usedNow: number, weekly: number, tokensNow: number, credits: number): readonly UsageObservation[] {
  return [3, 2, 1, 0].map((stepsBack) => ({
    observedAt: now - stepsBack * 30 * 60_000,
    projection: projection(now, Math.max(0, usedNow - stepsBack * 4), weekly, tokensNow - stepsBack * 24_000, credits),
  }));
}

export function usageOverview(now: number): UsageOverview {
  const accounts = [
    { history: history(now, 38, 22, 8_400_000, 2), metadata: { email: "work@example.com", label: "Work", plan: "plus" }, publicId: "acct_example_work" },
    { history: history(now, 91, 64, 3_100_000, 1), metadata: { email: "home@example.com", label: "Home", plan: "plus" }, publicId: "acct_example_home" },
  ].map((account) => ({ ...account, summary: accountUsageSummary(account.history, now) }));
  return { accounts, codex: providerUsageRollup(accounts.map((account) => account.summary)), loading: false, now, ready: true };
}
