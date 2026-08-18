/**
 * HRA-owned facts are the only values that the session model folds.
 * Provider payloads are parsed and projected before they enter this union.
 */

export const MAX_CODEX_FACT_ENCODED_BYTES = 8 * 1_024 * 1_024;

export type CodexFactOrigin = "live" | "reconciled" | "snapshot";

export interface CodexFactMetadata {
  readonly accountProfileId: string;
  readonly encodedBytes: number;
  readonly factIndex: number;
  readonly generation: number;
  readonly origin: CodexFactOrigin;
  readonly streamPosition: number;
}

export type CodexRuntimeAvailability =
  | "backoff"
  | "failed"
  | "running"
  | "starting"
  | "stopped";

export type CodexAccountAvailability =
  | "signed_in"
  | "signed_out"
  | "unknown";

export type CodexAccountPlan =
  | "business"
  | "edu"
  | "enterprise"
  | "enterprise_cbp_usage_based"
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "prolite"
  | "self_serve_business_usage_based"
  | "team"
  | "unknown";

export interface CodexRateLimitWindow {
  readonly resetsAt: number | null;
  readonly usedPercent: number;
  readonly windowDurationMins: number | null;
}

export interface CodexRateLimitCredits {
  readonly balance: string | null;
  readonly hasCredits: boolean;
  readonly unlimited: boolean;
}

export interface CodexSpendControlLimit {
  readonly limit: string;
  readonly remainingPercent: number;
  readonly resetsAt: number;
  readonly used: string;
}

export interface CodexSparseRateLimitSnapshot {
  readonly credits?: CodexRateLimitCredits | null | undefined;
  readonly individualLimit?: CodexSpendControlLimit | null | undefined;
  readonly limitId?: string | null | undefined;
  readonly limitName?: string | null | undefined;
  readonly planType?: CodexAccountPlan | null | undefined;
  readonly primary?: CodexRateLimitWindow | null | undefined;
  readonly rateLimitReachedType?:
    | "rate_limit_reached"
    | "workspace_member_credits_depleted"
    | "workspace_member_usage_limit_reached"
    | "workspace_owner_credits_depleted"
    | "workspace_owner_usage_limit_reached"
    | null
    | undefined;
  readonly secondary?: CodexRateLimitWindow | null | undefined;
}

export type CodexThreadStatus =
  | "active"
  | "idle"
  | "not_loaded"
  | "system_error";

export type CodexTurnStatus =
  | "active"
  | "completed"
  | "failed"
  | "interrupted";

export type CodexToolActivity =
  | "collaboration"
  | "command"
  | "file_change"
  | "image"
  | "mcp"
  | "other"
  | "search"
  | "sleep";

export type CodexProviderAgentStatus = "running" | "starting" | "terminal";

export interface CodexProviderAgentObservation {
  /** Provider-private identity. It must never cross a renderer adapter. */
  readonly agentId: string;
  readonly status: CodexProviderAgentStatus;
}

export type CodexItemSnapshot =
  | Readonly<{
      id: string;
      kind: "assistant_text";
      text: string;
      truncated: boolean;
    }>
  | Readonly<{
      clientMessageId: string | null;
      id: string;
      kind: "user_text";
      /** The pinned display boundary retains identity but discards prompt text. */
      text: string | null;
    }>
  | Readonly<{
      id: string;
      kind: "reasoning_summary";
      /** Sanitized, ordered summary parts retained for exact completion proof. */
      summaryParts: readonly string[];
      text: string;
      truncated: boolean;
    }>
  | Readonly<{
      activity: CodexToolActivity;
      id: string;
      kind: "tool";
      status: Exclude<CodexTurnStatus, "active">;
    }>
  | Readonly<{
      category: "compatibility" | "provider" | "runtime";
      id: string;
      kind: "error";
    }>;

export interface CodexTurnSnapshot {
  readonly completedAt: string | null;
  readonly id: string;
  /** `null` preserves item history when the provider returns a partial view. */
  readonly items: readonly CodexItemSnapshot[] | null;
  /** Private semantic collaboration state reconstructed from the item view. */
  readonly providerAgents?: readonly CodexProviderAgentObservation[];
  readonly quotaProof?: "provider_usage_limit_exceeded";
  readonly startedAt: string | null;
  readonly status: CodexTurnStatus;
}

export interface CodexThreadSnapshot {
  readonly archived: boolean;
  readonly createdAt: string;
  readonly cwd: string;
  readonly id: string;
  /** `null` is a metadata-only snapshot and must preserve loaded history. */
  readonly turns: readonly CodexTurnSnapshot[] | null;
  readonly status: CodexThreadStatus;
  readonly title: string | null;
  readonly updatedAt: string;
}

export type CodexTurnActivity =
  | "editing"
  | "planning"
  | "running"
  | "testing"
  | "waiting_for_approval"
  | "waiting_for_input";

export type CodexSessionOperation =
  | "thread_read"
  | "thread_resume"
  | "thread_start"
  | "turn_interrupt"
  | "turn_start"
  | "turn_steer";

export type CodexOperationOutcome =
  | "ambiguous"
  | "confirmed"
  | "pending"
  | "rejected";

export type CodexHydrationStatus =
  | "history_unavailable"
  | "ready"
  | "recovering"
  | "retry_wait"
  | "started";

type Fact<Type extends string, Payload extends object = Record<never, never>> =
  Readonly<CodexFactMetadata & { readonly type: Type } & Payload>;

export type CodexFact =
  | Fact<"runtime.changed", {
      readonly availability: CodexRuntimeAvailability;
    }>
  | Fact<"account.changed", {
      readonly availability: CodexAccountAvailability;
    }>
  | Fact<"account.login_completed", {
      readonly loginId: string | null;
      readonly success: boolean;
    }>
  | Fact<"account.profile_updated", {
      readonly plan: CodexAccountPlan | null;
      readonly signedIn: boolean;
    }>
  | Fact<"account.rate_limits_updated", {
      readonly rateLimits: CodexSparseRateLimitSnapshot;
    }>
  | Fact<"thread.snapshot", {
      readonly thread: CodexThreadSnapshot;
    }>
  | Fact<"thread.archived", {
      readonly archived: boolean;
      readonly threadId: string;
    }>
  | Fact<"thread.deleted", {
      readonly threadId: string;
    }>
  | Fact<"thread.title_changed", {
      readonly threadId: string;
      readonly title: string | null;
    }>
  | Fact<"thread.status_changed", {
      readonly status: CodexThreadStatus;
      readonly threadId: string;
    }>
  | Fact<"turn.snapshot", {
      readonly threadId: string;
      readonly turn: CodexTurnSnapshot;
    }>
  | Fact<"turn.started", {
      readonly startedAt: string | null;
      readonly threadId: string;
      readonly turnId: string;
    }>
  | Fact<"turn.activity", {
      readonly activity: CodexTurnActivity;
      readonly threadId: string;
      readonly turnId: string;
    }>
  | Fact<"turn.completed", {
      readonly completedAt: string;
      readonly status: Exclude<CodexTurnStatus, "active">;
      readonly threadId: string;
      readonly turnId: string;
    }>
  | Fact<"turn.token_usage", {
      /** Cumulative usage for the provider turn, used for durable accounting. */
      readonly cumulativeCachedInputTokens: number;
      readonly cumulativeInputTokens: number;
      readonly cumulativeOutputTokens: number;
      readonly cumulativeReasoningOutputTokens: number;
      /** Usage from the latest model interaction, retained for current UI consumers. */
      readonly cachedInputTokens: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly reasoningOutputTokens: number;
      readonly threadId: string;
      readonly turnId: string;
    }>
  | Fact<"turn.model_rerouted", {
      readonly fromModel: string;
      readonly reason: "highRiskCyberActivity";
      readonly threadId: string;
      readonly toModel: string;
      readonly turnId: string;
    }>
  | Fact<"item.started", {
      readonly activity: CodexToolActivity | null;
      readonly itemId: string;
      readonly kind: "assistant_text" | "reasoning_summary" | "tool";
      readonly providerAgents?: readonly CodexProviderAgentObservation[];
      readonly threadId: string;
      readonly turnId: string;
    }>
  | Fact<"item.delta", {
      readonly channel: "assistant_text";
      readonly delta: string;
      readonly itemId: string;
      readonly threadId: string;
      readonly truncated: boolean;
      readonly turnId: string;
    }>
  | Fact<"item.delta", {
      readonly channel: "reasoning_summary";
      readonly delta: string;
      readonly itemId: string;
      readonly partAdded?: false;
      readonly summaryIndex: number;
      readonly threadId: string;
      readonly truncated: boolean;
      readonly turnId: string;
    }>
  | Fact<"item.completed", {
      readonly item: CodexItemSnapshot;
      readonly providerAgents?: readonly CodexProviderAgentObservation[];
      readonly threadId: string;
      readonly turnId: string;
    }>
  | Fact<"interaction.requested", {
      readonly expiresAt: number;
      readonly interactionId: string;
      readonly kind: "approval" | "user_input";
      readonly threadId: string;
      readonly turnId: string;
    }>
  | Fact<"interaction.settled", {
      readonly interactionId: string;
      readonly outcome: "answered" | "expired" | "provider_resolved" | "rejected";
    }>
  | Fact<"server_request.resolved", {
      /** Opaque correlation only; provider request IDs never enter owned state. */
      readonly requestKey: string;
      readonly threadId: string;
    }>
  | Fact<"operation.changed", {
      readonly operation: CodexSessionOperation;
      readonly operationId: string;
      readonly outcome: CodexOperationOutcome;
      readonly threadId: string | null;
    }>
  | Fact<"hydration.changed", {
      readonly attempt: number;
      readonly status: CodexHydrationStatus;
      readonly threadId: string | null;
    }>;

export function codexFactCursor(
  fact: CodexFact,
): Readonly<{ generation: number; streamPosition: number; factIndex: number }> {
  return {
    generation: fact.generation,
    streamPosition: fact.streamPosition,
    factIndex: fact.factIndex,
  };
}

export function codexServerRequestResolutionKey(
  accountProfileId: string,
  generation: number,
  requestId: string | number,
): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update([
    "oprte-server-request-resolution-v1",
    accountProfileId,
    String(generation),
    typeof requestId,
    String(requestId),
  ].join("\u0000"));
  return `request_${hasher.digest("hex").slice(0, 48)}`;
}
