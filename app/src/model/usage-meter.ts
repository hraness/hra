/**
 * The usage meter derivations.
 *
 * Pure functions over decrypted usage projections: per account, which window
 * binds, how much of it is left and when it resets; from a short history of
 * observations, how fast the account is being used and whether the reset or
 * exhaustion comes first; and one provider-level rollup for the compact meter
 * on the grid. Nothing here reads a clock or touches React.
 */
import type { UsageLimit, UsageProjection, UsageWindow } from "../oompa/cloud";

export type UsageObservation = Readonly<{
  observedAt: number;
  projection: UsageProjection;
}>;

export type BindingWindow = Readonly<{
  limitId: string;
  limitName: string;
  /** Milliseconds until the window resets, never negative. */
  resetsAt: number;
  usedPercent: number;
  windowDurationMinutes: number;
}>;

export type UsageRate = Readonly<{
  /** Percent of the binding window consumed per hour over the sampled span. */
  percentPerHour: number;
  spanMs: number;
  /** Tokens per minute over the sampled lifetime counter, when it moved. */
  tokensPerMinute: number | null;
}>;

export type UsageOutlook =
  /** No window binds: the account reports unlimited use. */
  | Readonly<{ kind: "unlimited" }>
  /** The binding window is exhausted until it resets. */
  | Readonly<{ kind: "exhausted"; resetsAt: number }>
  /** Nothing is being consumed right now, or there are too few samples. */
  | Readonly<{ kind: "steady"; resetsAt: number }>
  /** At the current rate the reset arrives before the window runs out. */
  | Readonly<{ exhaustsAt: number; kind: "surplus"; resetsAt: number }>
  /** At the current rate the window runs out before it resets. */
  | Readonly<{ exhaustsAt: number; kind: "running_out"; resetsAt: number }>;

export type AccountUsageSummary = Readonly<{
  binding: BindingWindow | null;
  /** Remaining percent of the binding window; 100 when unlimited. */
  remainingPercent: number;
  /** Codex reset credits still available, or null when the daemon did not project them. */
  resetCredits: number | null;
  outlook: UsageOutlook;
  rate: UsageRate | null;
  /** The next reset among every projected window, for the "frees up" line. */
  nextResetAt: number | null;
  /** The weekly window when the provider reports one. */
  weekly: BindingWindow | null;
  observedAt: number;
  /** Hosted time minus `observedAt`; a meter never pretends a stale row is live. */
  ageMs: number;
}>;

export const weeklyWindowMinutes = 7 * 24 * 60;

/** Observations older than this read as stale on the meter. */
export const staleObservationMs = 2 * 60 * 60 * 1_000;

/** The rate needs at least this much observed time to mean anything. */
export const minimumRateSpanMs = 5 * 60 * 1_000;

/** How many observations the rate looks back over, newest first. */
export const rateWindowSamples = 12;

function windows(limit: UsageLimit): readonly Readonly<{ limit: UsageLimit; window: UsageWindow }>[] {
  return [limit.primary, limit.secondary]
    .filter((window): window is UsageWindow => window !== null)
    .map((window) => ({ limit, window }));
}

function toBinding(limit: UsageLimit, window: UsageWindow): BindingWindow {
  return {
    limitId: limit.id,
    limitName: limit.name,
    resetsAt: window.resetsAt,
    usedPercent: window.usedPercent,
    windowDurationMinutes: window.windowDurationMinutes,
  };
}

/**
 * The window that binds: the most used one across every limit, ties broken by
 * the earliest reset. A limit the provider marks unlimited contributes nothing.
 */
export function bindingWindow(limits: readonly UsageLimit[]): BindingWindow | null {
  const candidates = limits
    .filter((limit) => !limit.unlimited)
    .flatMap(windows)
    .map(({ limit, window }) => toBinding(limit, window))
    .sort((left, right) => right.usedPercent - left.usedPercent || left.resetsAt - right.resetsAt);
  return candidates[0] ?? null;
}

/** The provider's seven-day window, if it projects one. */
export function weeklyWindow(limits: readonly UsageLimit[]): BindingWindow | null {
  const candidates = limits
    .flatMap(windows)
    .filter(({ window }) => window.windowDurationMinutes === weeklyWindowMinutes)
    .map(({ limit, window }) => toBinding(limit, window))
    .sort((left, right) => right.usedPercent - left.usedPercent || left.resetsAt - right.resetsAt);
  return candidates[0] ?? null;
}

/** The earliest future reset among every projected window. */
export function nextReset(limits: readonly UsageLimit[], now: number): number | null {
  const resets = limits
    .flatMap(windows)
    .map(({ window }) => window.resetsAt)
    .filter((resetsAt) => resetsAt > now)
    .sort((left, right) => left - right);
  return resets[0] ?? null;
}

function readyLimits(projection: UsageProjection): readonly UsageLimit[] | null {
  return projection.state === "ready" ? projection.data.limits : null;
}

/**
 * The consumption rate over the most recent observations of the same binding
 * window. Only samples inside the current window count: a sample from before
 * the last reset would make a fresh window look like it was filling backwards.
 * Tokens come from the lifetime counter and need it to be monotonic over the
 * span; a counter that went backwards (a re-login, a provider reset) yields
 * no token rate rather than a negative one.
 */
export function usageRate(
  history: readonly UsageObservation[],
  binding: BindingWindow | null,
): UsageRate | null {
  if (binding === null) return null;
  const samples = [...history]
    .sort((left, right) => right.observedAt - left.observedAt)
    .slice(0, rateWindowSamples)
    .flatMap((observation) => {
      const limits = readyLimits(observation.projection);
      if (limits === null) return [];
      const window = limits
        .filter((limit) => limit.id === binding.limitId)
        .flatMap(windows)
        .find(({ window: candidate }) =>
          candidate.windowDurationMinutes === binding.windowDurationMinutes
          && candidate.resetsAt === binding.resetsAt);
      if (window === undefined) return [];
      const lifetimeTokens = observation.projection.state === "ready"
        ? observation.projection.data.lifetimeTokens
        : null;
      return [{ lifetimeTokens, observedAt: observation.observedAt, usedPercent: window.window.usedPercent }];
    });
  const newest = samples[0];
  const oldest = samples.at(-1);
  if (newest === undefined || oldest === undefined || newest === oldest) return null;
  const spanMs = newest.observedAt - oldest.observedAt;
  if (spanMs < minimumRateSpanMs) return null;
  const percentPerHour = Math.max(0, newest.usedPercent - oldest.usedPercent) / (spanMs / 3_600_000);
  const monotonic = samples.every((sample, index) => {
    const later = samples[index - 1];
    return sample.lifetimeTokens !== null
      && (later === undefined || (later.lifetimeTokens !== null && later.lifetimeTokens >= sample.lifetimeTokens));
  });
  const tokensPerMinute = monotonic && newest.lifetimeTokens !== null && oldest.lifetimeTokens !== null
    ? (newest.lifetimeTokens - oldest.lifetimeTokens) / (spanMs / 60_000)
    : null;
  return { percentPerHour, spanMs, tokensPerMinute };
}

export function usageOutlook(
  binding: BindingWindow | null,
  rate: UsageRate | null,
  now: number,
): UsageOutlook {
  if (binding === null) return { kind: "unlimited" };
  const remaining = Math.max(0, 100 - binding.usedPercent);
  if (remaining <= 0) return { kind: "exhausted", resetsAt: binding.resetsAt };
  if (rate === null || rate.percentPerHour <= 0) return { kind: "steady", resetsAt: binding.resetsAt };
  const exhaustsAt = now + (remaining / rate.percentPerHour) * 3_600_000;
  return exhaustsAt < binding.resetsAt
    ? { exhaustsAt, kind: "running_out", resetsAt: binding.resetsAt }
    : { exhaustsAt, kind: "surplus", resetsAt: binding.resetsAt };
}

/**
 * One account's summary from its newest ready observation and the history
 * behind it. A non-ready newest projection yields null: the meter shows the
 * account as unknown rather than as empty or full.
 */
export function accountUsageSummary(
  history: readonly UsageObservation[],
  now: number,
): AccountUsageSummary | null {
  const newest = [...history].sort((left, right) => right.observedAt - left.observedAt)[0];
  if (newest === undefined || newest.projection.state !== "ready") return null;
  const limits = newest.projection.data.limits;
  const binding = bindingWindow(limits);
  const rate = usageRate(history, binding);
  return {
    ageMs: Math.max(0, now - newest.observedAt),
    binding,
    nextResetAt: nextReset(limits, now),
    observedAt: newest.observedAt,
    outlook: usageOutlook(binding, rate, now),
    rate,
    remainingPercent: binding === null ? 100 : Math.max(0, 100 - binding.usedPercent),
    resetCredits: newest.projection.data.resetCredits ?? null,
    weekly: weeklyWindow(limits),
  };
}

export type ProviderUsageRollup = Readonly<{
  accounts: number;
  /** Mean remaining percent across accounts with a binding window. */
  remainingPercent: number;
  /** The earliest binding-window reset across accounts. */
  nextResetAt: number | null;
  /** Sum of projected reset credits; null when no account projects them. */
  resetCredits: number | null;
  /** Sum of token rates where known; null when none is known. */
  tokensPerMinute: number | null;
  /** The most urgent outlook among the accounts. */
  outlook: UsageOutlook["kind"];
  stale: boolean;
  /** Accounts whose newest projection was not ready. */
  unknown: number;
}>;

const outlookUrgency: Readonly<Record<UsageOutlook["kind"], number>> = {
  exhausted: 4,
  running_out: 3,
  steady: 1,
  surplus: 2,
  unlimited: 0,
};

/** The compact rollup the grid meter shows for one provider. */
export function providerUsageRollup(
  summaries: readonly (AccountUsageSummary | null)[],
): ProviderUsageRollup {
  const known = summaries.filter((summary): summary is AccountUsageSummary => summary !== null);
  const bound = known.filter((summary) => summary.binding !== null);
  const credits = known.map((summary) => summary.resetCredits).filter((value): value is number => value !== null);
  const rates = known
    .map((summary) => summary.rate?.tokensPerMinute ?? null)
    .filter((value): value is number => value !== null);
  const resets = known
    .map((summary) => summary.binding?.resetsAt ?? null)
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);
  const outlook = known
    .map((summary) => summary.outlook.kind)
    .sort((left, right) => outlookUrgency[right] - outlookUrgency[left])[0] ?? "unlimited";
  return {
    accounts: summaries.length,
    nextResetAt: resets[0] ?? null,
    outlook,
    remainingPercent: bound.length === 0
      ? 100
      : bound.reduce((total, summary) => total + summary.remainingPercent, 0) / bound.length,
    resetCredits: credits.length === 0 ? null : credits.reduce((total, value) => total + value, 0),
    stale: known.some((summary) => summary.ageMs > staleObservationMs),
    tokensPerMinute: rates.length === 0 ? null : rates.reduce((total, value) => total + value, 0),
    unknown: summaries.length - known.length,
  };
}

/** "2h 10m", "3d 4h", "45m", "now". Never negative. */
export function formatDurationUntil(at: number, now: number): string {
  const total = Math.max(0, at - now);
  const minutes = Math.round(total / 60_000);
  if (minutes < 1) return "now";
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const rest = minutes % 60;
  if (days > 0) return hours > 0 ? `${String(days)}d ${String(hours)}h` : `${String(days)}d`;
  if (hours > 0) return rest > 0 ? `${String(hours)}h ${String(rest)}m` : `${String(hours)}h`;
  return `${String(rest)}m`;
}

/** "12k", "1.2M", "830" tokens per minute, rounded for a glance. */
export function formatTokenRate(tokensPerMinute: number): string {
  const value = Math.max(0, tokensPerMinute);
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M tok/min`;
  if (value >= 10_000) return `${String(Math.round(value / 1_000))}k tok/min`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k tok/min`;
  return `${String(Math.round(value))} tok/min`;
}

/** The one-line sentence under the meter, from the rollup's outlook. */
export function outlookSentence(rollup: ProviderUsageRollup, now: number): string {
  const reset = rollup.nextResetAt === null ? null : formatDurationUntil(rollup.nextResetAt, now);
  switch (rollup.outlook) {
    case "exhausted":
      return reset === null ? "Limit reached." : `Limit reached; frees up in ${reset}.`;
    case "running_out":
      return reset === null ? "Running out at this pace." : `Running out before the reset in ${reset}.`;
    case "surplus":
      return reset === null ? "Surplus at this pace." : `Surplus: the reset in ${reset} comes first.`;
    case "steady":
      return reset === null ? "Idle." : `Idle; resets in ${reset}.`;
    case "unlimited":
      return "No limit reported.";
  }
}
