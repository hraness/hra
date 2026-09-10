import {
  hasExactKeys,
  isRecord,
  isSafeNonNegativeInteger,
  snapshotForeignJson,
} from "./contracts";

// Bounds cover the standalone display block, not a complete usage head or
// encrypted envelope. No display value grants permission to perform an effect.
export const USAGE_DISPLAY_V2_CODEX_MAX_JSON_BYTES = 538;
export const USAGE_DISPLAY_V2_CLAUDE_MAX_JSON_BYTES = 245;
export const USAGE_DISPLAY_V2_MAX_JSON_BYTES = USAGE_DISPLAY_V2_CODEX_MAX_JSON_BYTES;

type ResetPolicy =
  | Readonly<{ state: "active" | "reconciliation_required" }>
  | Readonly<{ state: "window_suppressed"; weeklyWindowResetsAt: number }>;
type LastAttempt =
  | Readonly<{ state: "prepared" | "retry_pending" | "recovery_pending"; weeklyWindowResetsAt: number }>
  | Readonly<{
      state: "settled";
      outcome: "reset" | "alreadyRedeemed" | "nothingToReset" | "noCredit";
      weeklyWindowResetsAt: number;
    }>
  | Readonly<{
      state: "closed";
      reason: "weekly_window_changed" | "account_identity_changed";
      weeklyWindowResetsAt: number;
    }>;
type CurrentIdentity =
  | Readonly<{ state: "unavailable"; reason: "identity_unavailable" | "snapshot_conflict" }>
  | Readonly<{ state: "known"; policy: ResetPolicy; lastAttempt: LastAttempt | null }>;
type Pending =
  | Readonly<{ state: "unavailable"; reason: "snapshot_conflict" }>
  | Readonly<{ state: "none" }>
  | Readonly<{
      state: "prepared" | "retry_pending" | "recovery_pending";
      weeklyWindowResetsAt: number;
      identityRelation: "current" | "different" | "unavailable";
    }>;
type CodexReset =
  | Readonly<{ state: "unavailable"; reason: "snapshot_conflict" }>
  | Readonly<{ state: "cached"; currentIdentity: CurrentIdentity; pending: Pending }>;
type UnavailableAdvice = Readonly<{
  state: "unavailable";
  reason: "runtime_not_integrated" | "inputs_unavailable" | "snapshot_conflict";
}>;
type Disabled = Readonly<{ action: "disabled"; reason: "policy_disabled" }>;
type CodexDecision =
  | Disabled
  | Readonly<{
      action: "observe_only";
      reason: "not_active_source" | "source_unknown" | "reset_pending";
      recheckAt: null;
    }>
  | Readonly<{ action: "observe_only"; reason: "source_stale"; recheckAt: number }>
  | Readonly<{
      action: "reconciliation_required";
      reason: "invalid_input" | "account_order_conflict" | "source_conflict"
        | "reached_type_conflict" | "reset_gate_mismatch" | "reset_reconciliation_required";
    }>
  | Readonly<{ action: "continue"; reason: "below_threshold" }>
  | Readonly<{ action: "reset"; reason: "weekly_reset_eligible" }>
  | Readonly<{ action: "propose_pointer_move"; reason: "next_available_account" }>
  | Readonly<{ action: "wait"; reason: "no_fresh_target"; recheckAt: number }>;
type ClaudeDecision =
  | Disabled
  | Readonly<{ action: "reconciliation_required"; reason: "invalid_input" }>
  | Readonly<{
      action: "observe_only";
      reason: "claude_native_fallback_armed" | "claude_automation_unavailable";
      recheckAt: null;
    }>;
type Advisory<D> = Readonly<{ state: "advisory"; evaluatedAt: number; decision: D }>;

export type CodexUsageDisplayV2 = Readonly<{
  provider: "codex";
  reset: CodexReset;
  nextAction: UnavailableAdvice | Readonly<{ state: "blocked"; reason: "reset_outcome_unknown" }>
    | Advisory<CodexDecision>;
}>;
export type ClaudeUsageDisplayV2 = Readonly<{
  provider: "claude";
  reset: Readonly<{ state: "unavailable"; reason: "provider_unsupported" }>;
  nextAction: UnavailableAdvice | Advisory<ClaudeDecision>;
}>;
export type UsageDisplayV2 = CodexUsageDisplayV2 | ClaudeUsageDisplayV2;

function exact(value: unknown, keys: readonly string[]): value is Readonly<Record<string, unknown>> {
  return isRecord(value) && hasExactKeys(value, keys);
}

function parseResetPolicy(value: unknown): ResetPolicy | null {
  if (exact(value, ["state"]) && (value.state === "active" || value.state === "reconciliation_required")) {
    return { state: value.state };
  }
  if (exact(value, ["state", "weeklyWindowResetsAt"]) && value.state === "window_suppressed"
    && isSafeNonNegativeInteger(value.weeklyWindowResetsAt)) {
    return { state: "window_suppressed", weeklyWindowResetsAt: value.weeklyWindowResetsAt };
  }
  return null;
}

function parseLastAttempt(value: unknown): LastAttempt | null {
  if (!isRecord(value) || !isSafeNonNegativeInteger(value.weeklyWindowResetsAt)) return null;
  const weeklyWindowResetsAt = value.weeklyWindowResetsAt;
  if (exact(value, ["state", "weeklyWindowResetsAt"])
    && (value.state === "prepared" || value.state === "retry_pending" || value.state === "recovery_pending")) {
    return { state: value.state, weeklyWindowResetsAt };
  }
  if (exact(value, ["state", "outcome", "weeklyWindowResetsAt"]) && value.state === "settled"
    && (value.outcome === "reset" || value.outcome === "alreadyRedeemed"
      || value.outcome === "nothingToReset" || value.outcome === "noCredit")) {
    return { state: "settled", outcome: value.outcome, weeklyWindowResetsAt };
  }
  if (exact(value, ["state", "reason", "weeklyWindowResetsAt"]) && value.state === "closed"
    && (value.reason === "weekly_window_changed" || value.reason === "account_identity_changed")) {
    return { state: "closed", reason: value.reason, weeklyWindowResetsAt };
  }
  return null;
}

function parseCurrentIdentity(value: unknown): CurrentIdentity | null {
  if (exact(value, ["state", "reason"]) && value.state === "unavailable"
    && (value.reason === "identity_unavailable" || value.reason === "snapshot_conflict")) {
    return { state: "unavailable", reason: value.reason };
  }
  if (!exact(value, ["state", "policy", "lastAttempt"]) || value.state !== "known") return null;
  const policy = parseResetPolicy(value.policy);
  const lastAttempt = value.lastAttempt === null ? null : parseLastAttempt(value.lastAttempt);
  if (policy === null || (lastAttempt === null && value.lastAttempt !== null)) return null;
  return { state: "known", policy, lastAttempt };
}

function parsePending(value: unknown): Pending | null {
  if (exact(value, ["state"]) && value.state === "none") return { state: "none" };
  if (exact(value, ["state", "reason"]) && value.state === "unavailable" && value.reason === "snapshot_conflict") {
    return { state: "unavailable", reason: "snapshot_conflict" };
  }
  if (!exact(value, ["state", "weeklyWindowResetsAt", "identityRelation"])
    || (value.state !== "prepared" && value.state !== "retry_pending" && value.state !== "recovery_pending")
    || !isSafeNonNegativeInteger(value.weeklyWindowResetsAt)
    || (value.identityRelation !== "current" && value.identityRelation !== "different" && value.identityRelation !== "unavailable")) return null;
  return { state: value.state, weeklyWindowResetsAt: value.weeklyWindowResetsAt, identityRelation: value.identityRelation };
}

function parseCodexReset(value: unknown): CodexReset | null {
  if (exact(value, ["state", "reason"]) && value.state === "unavailable" && value.reason === "snapshot_conflict") {
    return { state: "unavailable", reason: "snapshot_conflict" };
  }
  if (!exact(value, ["state", "currentIdentity", "pending"]) || value.state !== "cached") return null;
  const currentIdentity = parseCurrentIdentity(value.currentIdentity);
  const pending = parsePending(value.pending);
  return currentIdentity === null || pending === null ? null : { state: "cached", currentIdentity, pending };
}

function parseUnavailableAdvice(value: unknown): UnavailableAdvice | null {
  if (!exact(value, ["state", "reason"]) || value.state !== "unavailable"
    || (value.reason !== "runtime_not_integrated" && value.reason !== "inputs_unavailable" && value.reason !== "snapshot_conflict")) return null;
  return { state: "unavailable", reason: value.reason };
}

function parseDisabled(value: unknown): Disabled | null {
  return exact(value, ["action", "reason"]) && value.action === "disabled" && value.reason === "policy_disabled"
    ? { action: "disabled", reason: "policy_disabled" } : null;
}

function parseCodexDecision(value: unknown, evaluatedAt: number): CodexDecision | null {
  const disabled = parseDisabled(value);
  if (disabled !== null) return disabled;
  if (exact(value, ["action", "reason", "recheckAt"])) {
    if (value.action === "observe_only") {
      if ((value.reason === "not_active_source" || value.reason === "source_unknown" || value.reason === "reset_pending")
        && value.recheckAt === null) return { action: "observe_only", reason: value.reason, recheckAt: null };
      if (value.reason === "source_stale" && isSafeNonNegativeInteger(value.recheckAt) && value.recheckAt > evaluatedAt) {
        return { action: "observe_only", reason: "source_stale", recheckAt: value.recheckAt };
      }
    }
    if (value.action === "wait" && value.reason === "no_fresh_target"
      && isSafeNonNegativeInteger(value.recheckAt) && value.recheckAt > evaluatedAt) {
      return { action: "wait", reason: "no_fresh_target", recheckAt: value.recheckAt };
    }
    return null;
  }
  if (!exact(value, ["action", "reason"])) return null;
  if (value.action === "reconciliation_required"
    && (value.reason === "invalid_input" || value.reason === "account_order_conflict" || value.reason === "source_conflict"
      || value.reason === "reached_type_conflict" || value.reason === "reset_gate_mismatch" || value.reason === "reset_reconciliation_required")) {
    return { action: "reconciliation_required", reason: value.reason };
  }
  if (value.action === "continue" && value.reason === "below_threshold") return { action: "continue", reason: "below_threshold" };
  if (value.action === "reset" && value.reason === "weekly_reset_eligible") return { action: "reset", reason: "weekly_reset_eligible" };
  if (value.action === "propose_pointer_move" && value.reason === "next_available_account") {
    return { action: "propose_pointer_move", reason: "next_available_account" };
  }
  return null;
}

function parseClaudeDecision(value: unknown): ClaudeDecision | null {
  const disabled = parseDisabled(value);
  if (disabled !== null) return disabled;
  if (exact(value, ["action", "reason"]) && value.action === "reconciliation_required" && value.reason === "invalid_input") {
    return { action: "reconciliation_required", reason: "invalid_input" };
  }
  if (exact(value, ["action", "reason", "recheckAt"]) && value.action === "observe_only" && value.recheckAt === null
    && (value.reason === "claude_native_fallback_armed" || value.reason === "claude_automation_unavailable")) {
    return { action: "observe_only", reason: value.reason, recheckAt: null };
  }
  return null;
}

function parseAdvisory<D>(value: unknown, parseDecision: (input: unknown, evaluatedAt: number) => D | null): Advisory<D> | null {
  if (!exact(value, ["state", "evaluatedAt", "decision"]) || value.state !== "advisory"
    || !isSafeNonNegativeInteger(value.evaluatedAt)) return null;
  const decision = parseDecision(value.decision, value.evaluatedAt);
  return decision === null ? null : { state: "advisory", evaluatedAt: value.evaluatedAt, decision };
}

function parseCodexNextAction(value: unknown): CodexUsageDisplayV2["nextAction"] | null {
  const unavailable = parseUnavailableAdvice(value);
  if (unavailable !== null) return unavailable;
  if (exact(value, ["state", "reason"]) && value.state === "blocked" && value.reason === "reset_outcome_unknown") {
    return { state: "blocked", reason: "reset_outcome_unknown" };
  }
  return parseAdvisory(value, parseCodexDecision);
}

function codexDisplayIsCoherent(reset: CodexReset, nextAction: CodexUsageDisplayV2["nextAction"]): boolean {
  const snapshotUnavailable = nextAction.state === "unavailable" && nextAction.reason === "snapshot_conflict";
  if (reset.state === "unavailable") return snapshotUnavailable;
  const { currentIdentity, pending } = reset;
  if (pending.state === "unavailable") return snapshotUnavailable;
  if (pending.state !== "none") {
    if (currentIdentity.state === "known" && pending.identityRelation === "unavailable") return false;
    if (currentIdentity.state === "unavailable" && currentIdentity.reason === "identity_unavailable"
      && pending.identityRelation !== "unavailable") return false;
  }

  // Recovery is independently retained. Neither unknown current identity nor
  // disabled management may hide an unresolved provider outcome.
  if (pending.state === "recovery_pending") return nextAction.state === "blocked";
  if (nextAction.state === "blocked") return false;
  if (currentIdentity.state === "unavailable" && currentIdentity.reason === "snapshot_conflict") {
    return snapshotUnavailable;
  }
  if (nextAction.state !== "advisory") return true;
  const { decision } = nextAction;
  if (currentIdentity.state !== "known" && (decision.action === "continue" || decision.action === "reset"
    || decision.action === "propose_pointer_move" || decision.action === "wait")) return false;
  if (pending.state === "prepared" || pending.state === "retry_pending") {
    if (pending.identityRelation === "different") {
      return decision.action === "disabled" || (decision.action === "reconciliation_required"
        && decision.reason === "reset_reconciliation_required");
    }
    if (pending.identityRelation === "current" && (decision.action === "reset"
      || decision.action === "propose_pointer_move" || decision.action === "wait")) return false;
  }
  // History is not a second pending-state oracle. Do not impose equality
  // between lastAttempt, its window, the policy latch and independent pending.
  return true;
}

// Only parser-created objects reach this function; foreign input is never
// frozen or retained in the returned display block.
function freezeParsed<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeParsed(child);
    Object.freeze(value);
  }
  return value;
}

/** Cached display only: no action evaluation, identity proof or dispatch authority. */
export function parseUsageDisplayV2(input: unknown): UsageDisplayV2 | null {
  const snapshot = snapshotForeignJson(input);
  if (!snapshot.ok) return null;
  const value = snapshot.value;
  if (!exact(value, ["provider", "reset", "nextAction"])) return null;
  let parsed: UsageDisplayV2;
  if (value.provider === "codex") {
    const reset = parseCodexReset(value.reset);
    const nextAction = parseCodexNextAction(value.nextAction);
    if (reset === null || nextAction === null || !codexDisplayIsCoherent(reset, nextAction)) return null;
    parsed = { provider: "codex", reset, nextAction };
  } else if (value.provider === "claude") {
    if (!exact(value.reset, ["state", "reason"]) || value.reset.state !== "unavailable"
      || value.reset.reason !== "provider_unsupported") return null;
    const nextAction = parseUnavailableAdvice(value.nextAction) ?? parseAdvisory(value.nextAction, parseClaudeDecision);
    if (nextAction === null) return null;
    parsed = { provider: "claude", reset: { state: "unavailable", reason: "provider_unsupported" }, nextAction };
  } else return null;
  const maximum = parsed.provider === "codex" ? USAGE_DISPLAY_V2_CODEX_MAX_JSON_BYTES : USAGE_DISPLAY_V2_CLAUDE_MAX_JSON_BYTES;
  if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > maximum) return null;
  return freezeParsed(parsed);
}
