import {
  hasExactKeys,
  isFiniteTimestamp,
  isRecord,
  isSafeNonNegativeInteger,
  isSafePositiveInteger,
} from "./contracts";

export type UsageWindow = Readonly<{
  resetsAt: number;
  usedPercent: number;
  windowDurationMinutes: number;
}>;

export type UsageLimit = Readonly<{
  id: string;
  individual: boolean;
  name: string;
  primary: UsageWindow | null;
  reached: boolean;
  secondary: UsageWindow | null;
  unlimited: boolean;
}>;

export type UsageReady = Readonly<{
  daily: readonly Readonly<{ startDate: string; tokens: number }>[];
  limits: readonly UsageLimit[];
  longestRunningTurnSeconds: number;
  longestStreakDays: number;
  lifetimeTokens: number;
  peakDailyTokens: number;
  currentStreakDays: number;
}>;

export type UsageProjection =
  | Readonly<{ state: "unavailable" }>
  | Readonly<{ state: "loading" }>
  | Readonly<{ state: "failed" }>
  | Readonly<{ data: UsageReady; state: "ready" }>;

export type UsageSnapshotOrder = Readonly<{
  digest: string;
  observedAt: number;
  sourceDeviceId: string;
  sourceRevision: number;
}>;

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const identifierPattern = /^[A-Za-z0-9_.:-]{1,96}$/u;

function parseWindow(value: unknown): UsageWindow | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, [
    "resetsAt",
    "usedPercent",
    "windowDurationMinutes",
  ])) return undefined;
  if (
    !isFiniteTimestamp(value.resetsAt)
    || typeof value.usedPercent !== "number"
    || !Number.isFinite(value.usedPercent)
    || value.usedPercent < 0
    || value.usedPercent > 100
    || !isSafePositiveInteger(value.windowDurationMinutes)
    || value.windowDurationMinutes > 365 * 24 * 60
  ) return undefined;
  return {
    resetsAt: value.resetsAt,
    usedPercent: value.usedPercent,
    windowDurationMinutes: value.windowDurationMinutes,
  };
}

function parseLimit(value: unknown): UsageLimit | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id",
    "individual",
    "name",
    "primary",
    "reached",
    "secondary",
    "unlimited",
  ])) return null;
  const primary = parseWindow(value.primary);
  const secondary = parseWindow(value.secondary);
  if (
    typeof value.id !== "string"
    || !identifierPattern.test(value.id)
    || typeof value.name !== "string"
    || value.name.length < 1
    || value.name.length > 96
    || typeof value.individual !== "boolean"
    || typeof value.reached !== "boolean"
    || typeof value.unlimited !== "boolean"
    || primary === undefined
    || secondary === undefined
  ) return null;
  return {
    id: value.id,
    individual: value.individual,
    name: value.name,
    primary,
    reached: value.reached,
    secondary,
    unlimited: value.unlimited,
  };
}

export function parseUsageProjection(value: unknown): UsageProjection | null {
  if (!isRecord(value)) return null;
  if (
    hasExactKeys(value, ["state"])
    && (value.state === "unavailable" || value.state === "loading" || value.state === "failed")
  ) return { state: value.state };
  if (!hasExactKeys(value, ["data", "state"]) || value.state !== "ready") return null;
  if (!isRecord(value.data) || !hasExactKeys(value.data, [
    "currentStreakDays",
    "daily",
    "lifetimeTokens",
    "limits",
    "longestRunningTurnSeconds",
    "longestStreakDays",
    "peakDailyTokens",
  ])) return null;
  if (!Array.isArray(value.data.limits) || value.data.limits.length > 32) return null;
  const limits = value.data.limits.map(parseLimit);
  if (limits.some((limit) => limit === null)) return null;
  const limitIds = limits.map((limit) => limit?.id);
  if (new Set(limitIds).size !== limitIds.length) return null;

  if (!Array.isArray(value.data.daily) || value.data.daily.length > 366) return null;
  const daily: { startDate: string; tokens: number }[] = [];
  for (const row of value.data.daily) {
    if (
      !isRecord(row)
      || !hasExactKeys(row, ["startDate", "tokens"])
      || typeof row.startDate !== "string"
      || !datePattern.test(row.startDate)
      || !isSafeNonNegativeInteger(row.tokens)
    ) return null;
    daily.push({ startDate: row.startDate, tokens: row.tokens });
  }
  if (new Set(daily.map((row) => row.startDate)).size !== daily.length) return null;

  if (
    !isSafeNonNegativeInteger(value.data.currentStreakDays)
    || !isSafeNonNegativeInteger(value.data.lifetimeTokens)
    || !isSafeNonNegativeInteger(value.data.longestRunningTurnSeconds)
    || !isSafeNonNegativeInteger(value.data.longestStreakDays)
    || !isSafeNonNegativeInteger(value.data.peakDailyTokens)
  ) return null;
  return {
    data: {
      currentStreakDays: value.data.currentStreakDays,
      daily,
      lifetimeTokens: value.data.lifetimeTokens,
      limits: limits as UsageLimit[],
      longestRunningTurnSeconds: value.data.longestRunningTurnSeconds,
      longestStreakDays: value.data.longestStreakDays,
      peakDailyTokens: value.data.peakDailyTokens,
    },
    state: "ready",
  };
}

function compareSnapshotOrder(left: UsageSnapshotOrder, right: UsageSnapshotOrder): number {
  if (left.observedAt !== right.observedAt) return left.observedAt - right.observedAt;
  const deviceOrder = left.sourceDeviceId < right.sourceDeviceId
    ? -1
    : left.sourceDeviceId > right.sourceDeviceId
      ? 1
      : 0;
  if (deviceOrder !== 0) return deviceOrder;
  return left.sourceRevision - right.sourceRevision;
}

export function usageSnapshotDisposition(
  current: UsageSnapshotOrder | null,
  sameSourceRevision: UsageSnapshotOrder | null,
  candidate: UsageSnapshotOrder,
  now: number,
): "replace" | "store" | "replay" | "conflict" | "stale" | "future" {
  if (candidate.observedAt > now + 5 * 60 * 1_000) return "future";
  if (sameSourceRevision !== null) {
    return sameSourceRevision.digest === candidate.digest
      && sameSourceRevision.observedAt === candidate.observedAt
      ? "replay"
      : "conflict";
  }
  if (current === null) return "replace";
  if (
    current.sourceDeviceId === candidate.sourceDeviceId
    && candidate.sourceRevision < current.sourceRevision
  ) return "stale";
  return compareSnapshotOrder(candidate, current) > 0 ? "replace" : "store";
}
