import { redactCanonicalSensitiveText } from "../domain/sensitive-text-patterns";
import {
  containsAbsolutePath,
  hasExactKeys,
  isRecord,
  isSafeNonNegativeInteger,
  isSafePositiveInteger,
  snapshotForeignJson,
} from "./contracts";

// Bounds cover this component block only, not a head, encrypted envelope or
// hosted admission limit. Safe integers need at most 16 JSON bytes, other
// nonnegative finite numbers 24, and ASCII Code(n) strings n+2. Including
// keys/punctuation gives a 675-byte Codex limit, 4,283-byte Claude quota and
// 13,833-byte Claude accounting object. All 101/16/32 rows fit these bounds.
export const USAGE_COMPONENTS_V2_CODEX_MAX_JSON_BYTES = 68_738;
export const USAGE_COMPONENTS_V2_CLAUDE_MAX_JSON_BYTES = 18_598;
export const USAGE_COMPONENTS_V2_MAX_JSON_BYTES = USAGE_COMPONENTS_V2_CODEX_MAX_JSON_BYTES;

type Missing = Readonly<{
  state: "unavailable";
  reason: "not_observed" | "identity_unavailable" | "source_unavailable" | "representation_limit";
}>;
type Observed<S extends string, D> = Readonly<{
  state: "observed";
  source: S;
  observedAt: number;
  receivedAt: number;
  data: D;
}>;
type CodexWindow = Readonly<{
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAtMs: number | null;
}>;
type CodexLimit = Readonly<{
  id: string;
  rateLimitReachedType: string | null;
  primary: CodexWindow | null;
  secondary: CodexWindow | null;
}>;
type CodexQuota = Readonly<{
  resetCreditsAvailable: number | null;
  limits: readonly CodexLimit[];
}>;
type ClaudeStatus =
  | Readonly<{ state: "known"; value: "allowed" | "warning" | "blocked" | "denied" | "rejected" }>
  | Readonly<{ state: "unknown"; value: string }>;
type ClaudeWindow = Readonly<{
  id: string;
  scope: "account";
  usedPercent: number;
  resetsAtMs: number;
}>;
type ClaudeQuota = Readonly<{
  status: ClaudeStatus;
  rateLimitType: string | null;
  resetsAtMs: number | null;
  overageStatus: string | null;
  overageDisabledReason: string | null;
  isUsingOverage: boolean | null;
  windows: readonly ClaudeWindow[];
}>;
type Tokens = Readonly<{
  inputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
}>;
type ClaudeModel = Tokens & Readonly<{
  model: string;
  costUsd: number | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
}>;
type ClaudeAccounting = Tokens & Readonly<{
  totalCostUsd: number | null;
  models: readonly ClaudeModel[];
}>;
type Readiness =
  | Readonly<{
      state: "cached";
      value: "unverified" | "signed_out" | "login_pending" | "signed_in" | "recovery_required";
      observedAt: number | null;
    }>
  | Readonly<{ state: "unavailable"; reason: "source_unavailable" }>;
type AutomaticPolicy =
  | Readonly<{
      state: "configured";
      revision: number;
      defaultEnabled: boolean;
      override: "inherit" | "on" | "off";
    }>
  | Readonly<{ state: "unavailable"; reason: "configuration_unavailable" }>;

export type CodexUsageComponentsV2 = Readonly<{
  provider: "codex";
  quota: Missing | Observed<"codex_app_server", CodexQuota>;
  accounting: Readonly<{ state: "unavailable"; reason: "not_projected" }>;
  readiness: Readiness;
  automaticPolicy: AutomaticPolicy;
}>;
export type ClaudeUsageComponentsV2 = Readonly<{
  provider: "claude";
  quota: Missing | Observed<"claude_rate_limit_event", ClaudeQuota>;
  accounting: Missing | Observed<"claude_result", ClaudeAccounting>;
  readiness: Readiness;
  automaticPolicy: AutomaticPolicy;
}>;
export type UsageComponentsV2 = CodexUsageComponentsV2 | ClaudeUsageComponentsV2;

const codePattern = /^[A-Za-z0-9_.:+/-]+$/u;
const isCode = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= maximum
  && codePattern.test(value) && !containsAbsolutePath(value)
  && redactCanonicalSensitiveText(value, "[redacted]") === value;
const isNonnegativeFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const isPercent = (value: unknown): value is number => isNonnegativeFinite(value) && value <= 100;
const isAmount = (value: unknown): value is number =>
  isNonnegativeFinite(value) && value <= Number.MAX_SAFE_INTEGER;
const isNullableCounter = (value: unknown): value is number | null =>
  value === null || isSafeNonNegativeInteger(value);
const isNullableCode = (value: unknown): value is string | null => value === null || isCode(value, 128);
const exact = (value: unknown, keys: readonly string[]): value is Readonly<Record<string, unknown>> =>
  isRecord(value) && hasExactKeys(value, keys);

function parseMissing(value: unknown): Missing | null {
  if (!exact(value, ["state", "reason"]) || value.state !== "unavailable") return null;
  const reason = value.reason;
  return reason === "not_observed" || reason === "identity_unavailable"
    || reason === "source_unavailable" || reason === "representation_limit"
    ? { state: "unavailable", reason } : null;
}

function parseObserved<S extends string, D>(
  value: unknown,
  source: S,
  parseData: (value: unknown) => D | null,
): Observed<S, D> | null {
  if (!exact(value, ["state", "source", "observedAt", "receivedAt", "data"])
    || value.state !== "observed" || value.source !== source
    || !isSafeNonNegativeInteger(value.observedAt) || !isSafeNonNegativeInteger(value.receivedAt)
    || (source !== "codex_app_server" && value.observedAt !== value.receivedAt)) return null;
  const data = parseData(value.data);
  return data === null ? null : {
    state: "observed", source, observedAt: value.observedAt, receivedAt: value.receivedAt, data,
  };
}

function sortedRows<T>(
  value: unknown, maximum: number, parseRow: (value: unknown) => T | null, key: (row: T) => string,
): readonly T[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null;
  const rows: T[] = [];
  const keys = new Set<string>();
  for (const candidate of value) {
    const row = parseRow(candidate);
    if (row === null || keys.has(key(row))) return null;
    keys.add(key(row));
    rows.push(row);
  }
  return rows.sort((left, right) => key(left) === key(right) ? 0 : key(left) < key(right) ? -1 : 1);
}

function parseCodexWindow(value: unknown): CodexWindow | null {
  if (!exact(value, ["usedPercent", "windowDurationMins", "resetsAtMs"])
    || !isPercent(value.usedPercent)
    || (value.windowDurationMins !== null && !isNonnegativeFinite(value.windowDurationMins))
    || !isNullableCounter(value.resetsAtMs)) return null;
  return { usedPercent: value.usedPercent, windowDurationMins: value.windowDurationMins, resetsAtMs: value.resetsAtMs };
}

function parseCodexLimit(value: unknown): CodexLimit | null {
  if (!exact(value, ["id", "rateLimitReachedType", "primary", "secondary"])
    || !isCode(value.id, 256) || !isNullableCode(value.rateLimitReachedType)) return null;
  const primary = value.primary === null ? null : parseCodexWindow(value.primary);
  const secondary = value.secondary === null ? null : parseCodexWindow(value.secondary);
  if ((value.primary !== null && primary === null) || (value.secondary !== null && secondary === null)) return null;
  return { id: value.id, rateLimitReachedType: value.rateLimitReachedType, primary, secondary };
}

function parseCodexQuota(value: unknown): CodexQuota | null {
  if (!exact(value, ["resetCreditsAvailable", "limits"]) || !isNullableCounter(value.resetCreditsAvailable)) return null;
  const limits = sortedRows(value.limits, 101, parseCodexLimit, (limit) => limit.id);
  return limits === null ? null : { resetCreditsAvailable: value.resetCreditsAvailable, limits };
}

function parseClaudeStatus(value: unknown): ClaudeStatus | null {
  if (!exact(value, ["state", "value"])) return null;
  if (value.state === "unknown" && isCode(value.value, 128)) return { state: "unknown", value: value.value };
  if (value.state === "known" && (value.value === "allowed" || value.value === "warning"
    || value.value === "blocked" || value.value === "denied" || value.value === "rejected")) {
    return { state: "known", value: value.value };
  }
  return null;
}

function parseClaudeWindow(value: unknown): ClaudeWindow | null {
  if (!exact(value, ["id", "scope", "usedPercent", "resetsAtMs"])
    || !isCode(value.id, 128) || value.scope !== "account"
    || !isPercent(value.usedPercent) || !isSafeNonNegativeInteger(value.resetsAtMs)) return null;
  return { id: value.id, scope: "account", usedPercent: value.usedPercent, resetsAtMs: value.resetsAtMs };
}

function parseClaudeQuota(value: unknown): ClaudeQuota | null {
  if (!exact(value, ["status", "rateLimitType", "resetsAtMs", "overageStatus", "overageDisabledReason", "isUsingOverage", "windows"])
    || !isNullableCode(value.rateLimitType) || !isNullableCounter(value.resetsAtMs)
    || !isNullableCode(value.overageStatus) || !isNullableCode(value.overageDisabledReason)
    || (value.isUsingOverage !== null && typeof value.isUsingOverage !== "boolean")) return null;
  const status = parseClaudeStatus(value.status);
  const windows = sortedRows(value.windows, 16, parseClaudeWindow, (window) => window.id);
  return status === null || windows === null ? null : {
    status, rateLimitType: value.rateLimitType, resetsAtMs: value.resetsAtMs,
    overageStatus: value.overageStatus, overageDisabledReason: value.overageDisabledReason,
    isUsingOverage: value.isUsingOverage, windows,
  };
}

const tokenKeys = ["inputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "outputTokens", "thinkingTokens"] as const;
function parseTokens(value: Readonly<Record<string, unknown>>): Tokens | null {
  if (!isNullableCounter(value.inputTokens) || !isNullableCounter(value.cacheReadInputTokens)
    || !isNullableCounter(value.cacheCreationInputTokens) || !isNullableCounter(value.outputTokens)
    || !isNullableCounter(value.thinkingTokens)) return null;
  return {
    inputTokens: value.inputTokens, cacheReadInputTokens: value.cacheReadInputTokens,
    cacheCreationInputTokens: value.cacheCreationInputTokens, outputTokens: value.outputTokens,
    thinkingTokens: value.thinkingTokens,
  };
}

function parseClaudeModel(value: unknown): ClaudeModel | null {
  if (!exact(value, ["model", "costUsd", ...tokenKeys, "contextWindow", "maxOutputTokens"])
    || !isCode(value.model, 128) || (value.costUsd !== null && !isAmount(value.costUsd))
    || !isNullableCounter(value.contextWindow) || !isNullableCounter(value.maxOutputTokens)) return null;
  const tokens = parseTokens(value);
  return tokens === null ? null : {
    model: value.model, costUsd: value.costUsd, ...tokens,
    contextWindow: value.contextWindow, maxOutputTokens: value.maxOutputTokens,
  };
}

function parseClaudeAccounting(value: unknown): ClaudeAccounting | null {
  if (!exact(value, ["totalCostUsd", ...tokenKeys, "models"])
    || (value.totalCostUsd !== null && !isAmount(value.totalCostUsd))) return null;
  const tokens = parseTokens(value);
  const models = sortedRows(value.models, 32, parseClaudeModel, (model) => model.model);
  return tokens === null || models === null ? null : { totalCostUsd: value.totalCostUsd, ...tokens, models };
}

function parseReadiness(value: unknown): Readiness | null {
  if (exact(value, ["state", "reason"]) && value.state === "unavailable" && value.reason === "source_unavailable") {
    return { state: "unavailable", reason: "source_unavailable" };
  }
  if (!exact(value, ["state", "value", "observedAt"]) || value.state !== "cached"
    || !isNullableCounter(value.observedAt)) return null;
  if (value.value !== "unverified" && value.value !== "signed_out" && value.value !== "login_pending"
    && value.value !== "signed_in" && value.value !== "recovery_required") return null;
  return { state: "cached", value: value.value, observedAt: value.observedAt };
}

function parsePolicy(value: unknown): AutomaticPolicy | null {
  if (exact(value, ["state", "reason"]) && value.state === "unavailable" && value.reason === "configuration_unavailable") {
    return { state: "unavailable", reason: "configuration_unavailable" };
  }
  if (!exact(value, ["state", "revision", "defaultEnabled", "override"]) || value.state !== "configured"
    || !isSafePositiveInteger(value.revision) || typeof value.defaultEnabled !== "boolean"
    || (value.override !== "inherit" && value.override !== "on" && value.override !== "off")) return null;
  return { state: "configured", revision: value.revision, defaultEnabled: value.defaultEnabled, override: value.override };
}

// Only called on parser-created, detached plain data, never a foreign object.
function freezeParsed<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeParsed(child);
    Object.freeze(value);
  }
  return value;
}

/** Display components only: no source identity, currentness or dispatch proof. */
export function parseUsageComponentsV2(input: unknown): UsageComponentsV2 | null {
  const snapshot = snapshotForeignJson(input);
  if (!snapshot.ok) return null;
  const value = snapshot.value;
  if (!exact(value, ["provider", "quota", "accounting", "readiness", "automaticPolicy"])) return null;
  const readiness = parseReadiness(value.readiness);
  const automaticPolicy = parsePolicy(value.automaticPolicy);
  if (readiness === null || automaticPolicy === null) return null;
  let parsed: UsageComponentsV2;
  if (value.provider === "codex") {
    const quota = parseMissing(value.quota) ?? parseObserved(value.quota, "codex_app_server", parseCodexQuota);
    if (quota === null || !exact(value.accounting, ["state", "reason"])
      || value.accounting.state !== "unavailable" || value.accounting.reason !== "not_projected") return null;
    parsed = { provider: "codex", quota, accounting: { state: "unavailable", reason: "not_projected" }, readiness, automaticPolicy };
  } else if (value.provider === "claude") {
    const quota = parseMissing(value.quota) ?? parseObserved(value.quota, "claude_rate_limit_event", parseClaudeQuota);
    const accounting = parseMissing(value.accounting) ?? parseObserved(value.accounting, "claude_result", parseClaudeAccounting);
    if (quota === null || accounting === null) return null;
    parsed = { provider: "claude", quota, accounting, readiness, automaticPolicy };
  } else return null;
  const maximum = parsed.provider === "codex"
    ? USAGE_COMPONENTS_V2_CODEX_MAX_JSON_BYTES : USAGE_COMPONENTS_V2_CLAUDE_MAX_JSON_BYTES;
  if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > maximum) return null;
  return freezeParsed(parsed);
}
