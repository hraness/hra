import { z } from "@hra-internal/schema";
import type { AccountLoginState, AccountSummary } from "../../../contracts/runtime";
import type {
  CodexAccountPlan,
  CodexSparseRateLimitSnapshot,
  PinnedCodexAccountLoginCompleted,
  PinnedCodexAccountRead,
  PinnedCodexAccountUpdated,
  PinnedCodexLoginCancel,
  PinnedCodexLoginStart,
  PinnedCodexRateLimits,
  PinnedCodexTokenUsage,
} from "../codex";
import type {
  AccountTokenUsageState,
  AccountUsageState,
} from "../internal-contracts";

const isoDateTimeSchema = z.string().datetime();
const boundedUrlSchema = z.string().url().max(2_048);

type RateLimitSnapshot = PinnedCodexRateLimits["rateLimits"];
type RateLimitWindow = NonNullable<RateLimitSnapshot["primary"]>;
type PlanType = Extract<
  NonNullable<PinnedCodexAccountRead["account"]>,
  { readonly type: "chatgpt" }
>["planType"];

type AccountReadFields = Pick<
  AccountSummary,
  "identityLabel" | "planLabel" | "authState"
>;

export type AccountUpdatedFields = Pick<AccountSummary, "planLabel" | "authState">;

export interface AccountProfileUpdatedFactFields {
  readonly plan: CodexAccountPlan | null;
  readonly signedIn: boolean;
}

export type LoginStartProjection =
  | Readonly<{
      type: "browser";
      loginId: string;
      authorizationUrl: string;
      login: AccountLoginState;
    }>
  | Readonly<{
      type: "deviceCode";
      loginId: string;
      authorizationUrl: string;
      login: AccountLoginState;
    }>
  | Readonly<{
      type: "immediate";
      authMode: "apiKey" | "chatgptAuthTokens";
      login: AccountLoginState;
    }>;

export interface LoginCompletedProjection {
  readonly loginId: string | null;
  readonly success: boolean;
  readonly login: AccountLoginState;
}

export type LoginCancelStatus = PinnedCodexLoginCancel["status"];

const planLabels = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  team: "Team",
  self_serve_business_usage_based: "Business",
  business: "Business",
  enterprise_cbp_usage_based: "Enterprise",
  enterprise: "Enterprise",
  edu: "Education",
  unknown: "Unknown",
} as const satisfies Record<PlanType, string>;

function planLabel(planType: PlanType | null): string | null {
  return planType === null ? null : planLabels[planType];
}

function parseObservedAt(observedAt: string): string {
  return isoDateTimeSchema.parse(observedAt);
}

function unixSecondsToIso(value: number | null): string | null {
  if (value === null) return null;
  const milliseconds = value * 1_000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error("rate-limit reset timestamp is outside the supported range");
  }
  const rendered = new Date(milliseconds).toISOString();
  return isoDateTimeSchema.parse(rendered);
}

function projectRateLimitWindow(
  window: RateLimitWindow | null,
): Extract<AccountUsageState, { state: "ready" }>["limits"][number]["primary"] {
  if (window === null) return null;
  return {
    usedPercent: window.usedPercent,
    windowDurationMinutes: window.windowDurationMins,
    resetsAt: unixSecondsToIso(window.resetsAt),
  };
}

function projectRateLimit(
  snapshot: RateLimitSnapshot,
  fallbackId: string,
): Extract<AccountUsageState, { state: "ready" }>["limits"][number] {
  const id = snapshot.limitId ?? fallbackId;
  return {
    id,
    name: snapshot.limitName ?? id,
    primary: projectRateLimitWindow(snapshot.primary),
    secondary: projectRateLimitWindow(snapshot.secondary),
    individual: snapshot.individualLimit === null
      ? null
      : {
          remainingPercent: snapshot.individualLimit.remainingPercent,
          resetsAt: unixSecondsToIso(snapshot.individualLimit.resetsAt) ?? unreachableTimestamp(),
        },
    unlimited: snapshot.credits?.unlimited ?? false,
    reached:
      snapshot.rateLimitReachedType !== null ||
      snapshot.primary?.usedPercent === 100 ||
      snapshot.secondary?.usedPercent === 100 ||
      snapshot.individualLimit?.remainingPercent === 0,
  };
}

function unreachableTimestamp(): never {
  throw new Error("a required rate-limit reset timestamp was unavailable");
}

export function projectAccountRead(value: PinnedCodexAccountRead): AccountReadFields {
  if (value.account === null) {
    return { identityLabel: null, planLabel: null, authState: "signedOut" };
  }
  switch (value.account.type) {
    case "chatgpt":
      return {
        identityLabel: value.account.email,
        planLabel: planLabel(value.account.planType),
        authState: "signedIn",
      };
    case "apiKey":
    case "amazonBedrock":
      return { identityLabel: null, planLabel: null, authState: "signedIn" };
  }
}

export function projectLoginStart(
  value: PinnedCodexLoginStart,
  startedAt: string,
): LoginStartProjection {
  const timestamp = parseObservedAt(startedAt);
  switch (value.type) {
    case "chatgpt":
      return {
        type: "browser",
        loginId: value.loginId,
        authorizationUrl: value.authUrl,
        login: { state: "waitingForBrowser", startedAt: timestamp },
      };
    case "chatgptDeviceCode":
      return {
        type: "deviceCode",
        loginId: value.loginId,
        authorizationUrl: value.verificationUrl,
        login: {
          state: "waitingForDeviceCode",
          userCode: value.userCode,
          startedAt: timestamp,
        },
      };
    case "apiKey":
    case "chatgptAuthTokens":
      return {
        type: "immediate",
        authMode: value.type,
        login: { state: "idle" },
      };
  }
}

export function projectLoginCompleted(
  value: PinnedCodexAccountLoginCompleted,
): LoginCompletedProjection {
  return {
    loginId: value.loginId,
    success: value.success,
    login: value.success
      ? { state: "idle" }
      : { state: "failed", message: "Codex sign-in did not complete." },
  };
}

export function projectLoginCancel(value: PinnedCodexLoginCancel): LoginCancelStatus {
  return value.status;
}

export function projectAccountUpdated(value: PinnedCodexAccountUpdated): AccountUpdatedFields {
  return {
    authState: value.authMode === null ? "signedOut" : "signedIn",
    planLabel: planLabel(value.planType),
  };
}

export function projectAccountProfileUpdated(
  value: AccountProfileUpdatedFactFields,
): AccountUpdatedFields {
  return {
    authState: value.signedIn ? "signedIn" : "signedOut",
    planLabel: planLabel(value.plan),
  };
}

export function projectRateLimits(
  value: PinnedCodexRateLimits,
  observedAt: string,
  tokens: AccountTokenUsageState = { state: "unavailable" },
): AccountUsageState {
  const mapped = value.rateLimitsByLimitId;
  const limits = mapped === null || Object.keys(mapped).length === 0
    ? [projectRateLimit(value.rateLimits, "default")]
    : Object.entries(mapped)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, snapshot]) => projectRateLimit(snapshot, id));
  const ids = limits.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("rate-limit buckets projected to duplicate identifiers");
  }
  return { state: "ready", limits, tokens, updatedAt: parseObservedAt(observedAt) };
}

export function projectRateLimitsUpdated(
  value: Readonly<{ readonly rateLimits: CodexSparseRateLimitSnapshot }>,
  observedAt: string,
  previous: AccountUsageState = { state: "unavailable" },
): AccountUsageState {
  const previousLimits = previous.state === "ready" ? previous.limits : [];
  const inferredId = value.rateLimits.limitId ?? (
    previousLimits.length === 1 ? previousLimits[0]?.id : undefined
  ) ?? "default";
  const existing = previousLimits.find(({ id }) => id === inferredId);
  const primary = value.rateLimits.primary === null || value.rateLimits.primary === undefined
    ? existing?.primary ?? null
    : projectRateLimitWindow(value.rateLimits.primary);
  const secondary = value.rateLimits.secondary === null || value.rateLimits.secondary === undefined
    ? existing?.secondary ?? null
    : projectRateLimitWindow(value.rateLimits.secondary);
  const individual = value.rateLimits.individualLimit === undefined
    ? existing?.individual ?? null
    : value.rateLimits.individualLimit === null
      ? null
      : {
          remainingPercent: value.rateLimits.individualLimit.remainingPercent,
          resetsAt: unixSecondsToIso(value.rateLimits.individualLimit.resetsAt) ?? unreachableTimestamp(),
        };
  const unlimited = value.rateLimits.credits === undefined
    ? existing?.unlimited ?? false
    : value.rateLimits.credits?.unlimited ?? false;
  const measuredReached =
    primary?.usedPercent === 100 ||
    secondary?.usedPercent === 100 ||
    individual?.remainingPercent === 0;
  const update = {
    id: inferredId,
    name: value.rateLimits.limitName ?? existing?.name ?? inferredId,
    primary,
    secondary,
    individual,
    unlimited,
    reached: value.rateLimits.rateLimitReachedType === undefined
      ? existing?.reached === true || measuredReached
      : value.rateLimits.rateLimitReachedType !== null || measuredReached,
  } satisfies Extract<AccountUsageState, { state: "ready" }>["limits"][number];
  const limits = previous.state === "ready"
    ? [...previous.limits.filter(({ id }) => id !== update.id), update]
        .sort((left, right) => left.id.localeCompare(right.id))
    : [update];
  if (limits.length > 32) {
    throw new Error("a rate-limit update exceeded 32 buckets");
  }
  return {
    state: "ready",
    limits,
    tokens: previous.state === "ready" ? previous.tokens : { state: "unavailable" },
    updatedAt: parseObservedAt(observedAt),
  };
}

export function projectTokenUsage(
  value: PinnedCodexTokenUsage,
  observedAt: string,
): AccountTokenUsageState {
  const sourceDaily = value.dailyUsageBuckets ?? [];
  const dates = sourceDaily.map(({ startDate }) => startDate);
  if (new Set(dates).size !== dates.length) {
    throw new Error("account token usage contained duplicate daily dates");
  }
  const daily = [...sourceDaily]
    .sort((left, right) => left.startDate.localeCompare(right.startDate))
    .slice(-366)
    .map(({ startDate, tokens }) => ({ startDate, tokens }));
  return {
    state: "ready",
    lifetimeTokens: value.summary.lifetimeTokens,
    peakDailyTokens: value.summary.peakDailyTokens,
    longestRunningTurnSeconds: value.summary.longestRunningTurnSec,
    currentStreakDays: value.summary.currentStreakDays,
    longestStreakDays: value.summary.longestStreakDays,
    daily,
    updatedAt: parseObservedAt(observedAt),
  };
}

export function externalAuthorizationUrl(value: string): string {
  const parsed = boundedUrlSchema.parse(value);
  const url = new URL(parsed);
  if (
    url.origin !== "https://auth.openai.com" ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error("Codex returned an unapproved sign-in address");
  }
  return url.href;
}
