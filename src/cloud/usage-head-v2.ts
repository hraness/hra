import { hasExactKeys, isRecord, isSafePositiveInteger, snapshotForeignJson } from "./contracts";
import {
  parseUsageComponentsV2,
  type ClaudeUsageComponentsV2,
  type CodexUsageComponentsV2,
  type UsageComponentsV2,
} from "./usage-components-v2";
import { parseUsageHeadContextV2 } from "./usage-context-v2";
import {
  parseUsageDisplayV2,
  type ClaudeUsageDisplayV2,
  type CodexUsageDisplayV2,
  type UsageDisplayV2,
} from "./usage-display-v2";

// Conservative composed plaintext ceilings, not reachable maxima or envelope
// limits. Framing adds 685/634 bytes to the two existing standalone blocks.
export const USAGE_HEAD_V2_CODEX_MAX_JSON_BYTES = 69_961;
export const USAGE_HEAD_V2_CLAUDE_MAX_JSON_BYTES = 19_477;
export const USAGE_HEAD_V2_MAX_JSON_BYTES = USAGE_HEAD_V2_CODEX_MAX_JSON_BYTES;

// The native listing and policy modules cannot enter the browser dependency
// graph. Tests bind these distinct limits to their authoritative definitions.
const listingAccountLimit = 10_000;
const automaticAccountLimit = 1_000;
const codexAccountMatchPattern = /^codex_[0-9a-f]{48}$/u;

export type UsageHeadOrderV2 =
  | Readonly<{
      state: "cached";
      orderRevision: number;
      pointerRevision: number;
      orderPosition: number;
      accountCount: number;
      active: boolean;
    }>
  | Readonly<{ state: "unavailable"; reason: "snapshot_conflict" | "representation_limit" }>;

type UsageHeadBaseV2 = Readonly<{
  version: 2;
  userPublicId: string;
  sourceDevicePublicId: string;
  sourcePublicId: string;
  sourceRevision: number;
  keyVersion: number;
  order: UsageHeadOrderV2;
}>;
export type CodexUsageHeadV2 = UsageHeadBaseV2 & Readonly<{
  provider: "codex";
  codexAccountMatchPublicId: string | null;
  components: CodexUsageComponentsV2;
  display: CodexUsageDisplayV2;
}>;
export type ClaudeUsageHeadV2 = UsageHeadBaseV2 & Readonly<{
  provider: "claude";
  codexAccountMatchPublicId: null;
  components: ClaudeUsageComponentsV2;
  display: ClaudeUsageDisplayV2;
}>;
export type UsageHeadV2 = CodexUsageHeadV2 | ClaudeUsageHeadV2;

function parseOrder(input: unknown): UsageHeadOrderV2 | null {
  if (!isRecord(input)) return null;
  if (hasExactKeys(input, ["state", "reason"]) && input.state === "unavailable"
    && (input.reason === "snapshot_conflict" || input.reason === "representation_limit")) {
    return Object.freeze({ state: "unavailable", reason: input.reason });
  }
  if (!hasExactKeys(input, ["state", "orderRevision", "pointerRevision", "orderPosition", "accountCount", "active"])
    || input.state !== "cached" || !isSafePositiveInteger(input.orderRevision)
    || !isSafePositiveInteger(input.pointerRevision) || !isSafePositiveInteger(input.orderPosition)
    || !isSafePositiveInteger(input.accountCount) || input.accountCount > listingAccountLimit
    || input.orderPosition > input.accountCount || typeof input.active !== "boolean"
    || (input.accountCount === 1 && !input.active)) return null;
  return Object.freeze({
    state: "cached", orderRevision: input.orderRevision, pointerRevision: input.pointerRevision,
    orderPosition: input.orderPosition, accountCount: input.accountCount, active: input.active,
  });
}

function adviceIsCoherent(
  components: UsageComponentsV2,
  display: UsageDisplayV2,
  order: UsageHeadOrderV2,
): boolean {
  if (display.nextAction.state !== "advisory") return true;
  const { decision } = display.nextAction;
  // The actual reducer parses its complete input before resolving effective
  // policy or taking Claude's provider-specific early return.
  if (decision.action === "reconciliation_required" && decision.reason === "invalid_input") return true;
  if (order.state === "cached" && order.accountCount > automaticAccountLimit) return false;
  const policy = components.automaticPolicy;
  if (policy.state !== "configured") return false;
  const enabled = policy.override === "inherit" ? policy.defaultEnabled : policy.override === "on";
  if (!enabled) return decision.action === "disabled";
  if (decision.action === "disabled") return false;
  if (display.provider !== "codex" || order.state !== "cached") return true;
  if (decision.action === "reconciliation_required" && decision.reason === "account_order_conflict") return true;
  if (decision.action === "observe_only" && decision.reason === "not_active_source") return !order.active;
  return order.active;
}

/**
 * Parse cached display facts against independently selected context. Neither
 * this comparison nor a cached membership count proves authenticity, current
 * authority, evaluation validity or completeness of a multi-head listing.
 */
export function parseUsageHeadV2(input: unknown, expectedContext: unknown): UsageHeadV2 | null {
  const context = parseUsageHeadContextV2(expectedContext);
  if (context === null) return null;
  const snapshot = snapshotForeignJson(input);
  if (!snapshot.ok) return null;
  const value = snapshot.value;
  if (!isRecord(value) || !hasExactKeys(value, [
    "version", "userPublicId", "sourceDevicePublicId", "provider", "sourcePublicId",
    "sourceRevision", "keyVersion", "codexAccountMatchPublicId", "order", "components", "display",
  ]) || value.version !== 2 || value.userPublicId !== context.userPublicId
    || value.sourceDevicePublicId !== context.sourceDevicePublicId || value.provider !== context.provider
    || value.sourcePublicId !== context.sourcePublicId || value.sourceRevision !== context.sourceRevision
    || value.keyVersion !== context.keyVersion) return null;
  const link = value.codexAccountMatchPublicId;
  if (link !== null && (typeof link !== "string" || !codexAccountMatchPattern.test(link))) return null;
  const order = parseOrder(value.order);
  const components = parseUsageComponentsV2(value.components);
  const display = parseUsageDisplayV2(value.display);
  if (order === null || components === null || display === null
    || components.provider !== context.provider || display.provider !== context.provider
    || !adviceIsCoherent(components, display, order)) return null;
  const base = {
    version: 2 as const,
    userPublicId: context.userPublicId,
    sourceDevicePublicId: context.sourceDevicePublicId,
    provider: context.provider,
    sourcePublicId: context.sourcePublicId,
    sourceRevision: context.sourceRevision,
    keyVersion: context.keyVersion,
    codexAccountMatchPublicId: link,
    order,
    components,
    display,
  };
  let parsed: UsageHeadV2;
  if (components.provider === "codex" && display.provider === "codex") {
    const reset = display.reset;
    if (link !== null && reset.state === "cached" && reset.currentIdentity.state === "unavailable"
      && reset.currentIdentity.reason === "identity_unavailable") return null;
    parsed = { ...base, provider: "codex", components, display };
  } else if (components.provider === "claude" && display.provider === "claude" && link === null) {
    parsed = { ...base, provider: "claude", codexAccountMatchPublicId: null, components, display };
  } else return null;
  const maximum = parsed.provider === "codex" ? USAGE_HEAD_V2_CODEX_MAX_JSON_BYTES : USAGE_HEAD_V2_CLAUDE_MAX_JSON_BYTES;
  if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > maximum) return null;
  // Order and both nested blocks are independently detached and deeply frozen.
  return Object.freeze(parsed);
}
