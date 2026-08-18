import {
  runtimeChatContinuationLimit,
  runtimeChatDeltaUtf8ByteLimit,
  runtimeChatPaneLimit,
  runtimeChatReasoningTailUtf8ByteLimit,
  runtimeChatResponseTailUtf8ByteLimit,
  runtimeChatToolLimit,
  runtimeChatTurnPromptUtf8ByteLimit,
  type ChatAttention,
  type ChatAttentionCode,
  type ChatMessageId,
  type ChatMessageQueueProjection,
  type ChatPaneActivity,
  type ChatPaneInteractionMode,
  type ChatPaneProjection,
  type ChatReasoningEffort,
  type ChatServiceTier,
  type ChatToolCategory,
  type ChatToolProjection,
  type ChatUtf8Tail,
  type RuntimeChatMessageLedgerCommand,
} from "../../../contracts/runtime";

export type {
  ChatRootTurnRoutingProjection,
  ChatServiceTier,
} from "../../../contracts/runtime";

export const CHAT_MODEL = "gpt-5.6-sol" as const;
export const CHAT_MODELS = [CHAT_MODEL, "gpt-5.6-luna"] as const;
export type ChatModel = (typeof CHAT_MODELS)[number];
export const CHAT_MAX_PANES = runtimeChatPaneLimit;
export const CHAT_MAX_TOOLS_PER_TURN = runtimeChatToolLimit;
export const CHAT_MAX_CONTINUATIONS = runtimeChatContinuationLimit;
export const CHAT_MAX_PROMPT_UTF8_BYTES = runtimeChatTurnPromptUtf8ByteLimit;
export const CHAT_MAX_RESPONSE_TAIL_UTF8_BYTES = runtimeChatResponseTailUtf8ByteLimit;
export const CHAT_MAX_ASSISTANT_RECONCILIATION_UTF8_BYTES =
  CHAT_MAX_RESPONSE_TAIL_UTF8_BYTES;
export const CHAT_MAX_REASONING_TAIL_UTF8_BYTES = runtimeChatReasoningTailUtf8ByteLimit;
export const CHAT_MAX_DELTA_UTF8_BYTES = runtimeChatDeltaUtf8ByteLimit;
export const CHAT_MAX_HISTORY_UTF8_BYTES_PER_PANE = 1024 * 1024;
export const CHAT_MAX_HISTORY_UTF8_BYTES_TOTAL = 16 * 1024 * 1024;
export const CHAT_MAX_HANDOFF_HISTORY_ITEMS = 1_024;
export const CHAT_MAX_TURN_RECEIPTS_PER_PANE = 512;

export type ChatPaneId = ChatPaneProjection["id"];
export type ChatTurnId = NonNullable<ChatPaneProjection["turn"]>["id"];
export type ChatAccountProfileId = NonNullable<ChatPaneProjection["accountProfileId"]>;
export type ChatRepositoryId = ChatPaneProjection["repository"]["id"];

export interface ChatRepository {
  readonly id: ChatRepositoryId;
  readonly name: string;
  /** Gateway-private canonical working directory. */
  readonly workingDirectory: string;
}

export interface ChatThreadBinding {
  readonly accountProfileId: ChatAccountProfileId;
  /** Gateway-owned, restart-stable identity used to fence SessionService events. */
  readonly threadId: string;
  /** Provider-private raw identity used only to reconstruct SessionService after restart. */
  readonly restartThreadId: string;
}

export interface ChatHistoryItem {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface ChatHandoffHistory {
  readonly items: readonly ChatHistoryItem[];
  /** False means some model-visible user/assistant text is unavailable. */
  readonly complete: boolean;
}

export type ChatAccountBudget = "healthy" | "low" | "exhausted" | "unknown";

/** Usage-free account routing material. It never crosses the renderer boundary. */
export interface ChatAccountCandidate {
  readonly id: ChatAccountProfileId;
  readonly selected: boolean;
  readonly budget: ChatAccountBudget;
}

export interface ChatAccountPort {
  /** Refreshes stale provider capacity before returning conservative dispositions. */
  refreshCandidates(): Promise<readonly ChatAccountCandidate[]>;
  /**
   * Fences the account runtime generation after a mutating response is lost.
   * This settles only after the old generation can no longer perform work;
   * launching its replacement is best effort.
   */
  containAmbiguousEffect(accountProfileId: ChatAccountProfileId): Promise<void>;
  hasRateLimitProofSince?(
    accountProfileId: ChatAccountProfileId,
    floor: ChatQuotaProofCursor,
  ): boolean;
}

/**
 * Last-resort containment boundary for an account effect that neither the
 * provider interrupt nor the account-generation fence could stop. The host
 * must admit one bounded gateway/transport recovery request synchronously;
 * it must never replay the ambiguous provider mutation.
 */
export interface ChatRuntimeRecoveryPort {
  requestRecovery(input: Readonly<{
    readonly reason: "ambiguous_provider_effect_unfenced";
    /** Null only when root admission existed but no provider account was bound yet. */
    readonly accountProfileId: ChatAccountProfileId | null;
    readonly paneId: ChatPaneId;
    readonly turnId: ChatTurnId;
  }>): void;
}

export interface ChatQuotaProofCursor {
  readonly generation: number;
  readonly streamPosition: number;
}

export interface ChatRepositoryPort {
  resolve(repositoryId: ChatRepositoryId): Promise<ChatRepository | null>;
}

/**
 * Pane-owned managed-worktree boundary. Implementations may inspect private
 * paths, but only the pathless pane projection can cross to the renderer.
 */
export interface ChatWorkspacePort {
  /** Provision or exactly recover this pane's deterministic managed lane. */
  provision(
    paneId: ChatPaneId,
    repository: ChatRepository,
  ): Promise<ChatPaneProjection>;
  /** Return only an exact ready managed checkout, never the source checkout. */
  resolve(
    paneId: ChatPaneId,
    repository: ChatRepository,
  ): Promise<ChatRepository | null>;
  /** Durably leave preparation when the registered source cannot be resolved. */
  markRepositoryUnavailable(paneId: ChatPaneId): ChatPaneProjection;
  /** Forget process-local verification after the pane leaves the live grid. */
  release(paneId: ChatPaneId): void;
}

/**
 * Provider-neutral root harness boundary owned by the chat composition.
 * Returning `null` means recursive sessions were disabled at admission time.
 * Provider identities appear only on terminal observation and are never used
 * to derive a durable root identity.
 */
export interface ChatHarnessRootPort {
  admit(input: Readonly<{
    repositoryId: ChatRepositoryId;
    canonicalWorkingDirectory: string;
    paneId: ChatPaneId;
    chatTurnId: ChatTurnId;
    title: string;
    prompt: string;
    createdAt: string;
  }>): Promise<Readonly<{ turnId: string }> | null>;
  observe(input: Readonly<{
    accountProfileId: ChatAccountProfileId;
    quotaProof?: "provider_usage_limit_exceeded";
    threadId: string;
    turnId: string;
    status: "completed" | "failed" | "interrupted" | "inProgress";
  }>): Promise<unknown>;
  settleBeforeProvider(input: Readonly<{
    turnId: string;
    paneId: ChatPaneId;
    failure: "provider_start_ambiguous" | "provider_unavailable";
    settledAt?: string;
  }>): Promise<unknown>;
}

/**
 * Trusted bridge from one attached renderer pane to its persistent actor.
 * Provider and actor routing identities stay inside the gateway; ChatService
 * receives only the owned turn identity needed to join SessionService events.
 */
export interface ChatHarnessActorTurnInput {
  readonly paneId: ChatPaneId;
  readonly chatTurnId: ChatTurnId;
  readonly prompt: string;
  readonly createdAt: string;
}

export type ChatHarnessActorTurnOutcome =
  | Readonly<{
      kind: "recovering";
      actorTurnId: string;
    }>
  | Readonly<{
      kind: "accepted";
      actorTurnId: string;
      providerTurnId: string;
    }>
  | Readonly<{
      kind: "settled";
      actorTurnId: string;
      outcome: "succeeded";
      responseMarkdown: string | null;
    }>
  | Readonly<{
      kind: "settled";
      actorTurnId: string;
      outcome: "cancelled" | "failed" | "quotaRejected";
    }>;

export interface ChatHarnessActorTurnPort {
  /**
   * Reattaches a pane when an actor replacement thread emits before the
   * provider-start response returns. The implementation must return a pane
   * only from durable actor/session authority; ChatService never infers the
   * owner from renderer state.
   */
  routeSessionEvent(input: Readonly<{
    accountProfileId: ChatAccountProfileId;
    threadId: string;
    turnId: string;
  }>): ChatPaneId | null;
  startTurn(input: ChatHarnessActorTurnInput): Promise<ChatHarnessActorTurnOutcome>;
  /**
   * Reconciles provider evidence before replaying this exact logical turn.
   * A terminal SessionService hint carries no actor authority by itself, so
   * ChatService must never settle an attached pane from that hint alone.
   */
  reconcileTurn(input: ChatHarnessActorTurnInput): Promise<ChatHarnessActorTurnOutcome>;
}

export interface ChatProviderConfiguration {
  readonly model: ChatModel;
  readonly reasoningEffort: ChatReasoningEffort;
  readonly serviceTier?: ChatServiceTier;
  readonly approvalPolicy: "on-request";
  readonly approvalsReviewer: "auto_review";
  readonly sandbox: "workspace-write";
}

export interface ChatProviderThreadRequest extends ChatProviderConfiguration {
  readonly accountProfileId: ChatAccountProfileId;
  readonly title: string;
  readonly workingDirectory: string;
}

export interface ChatProviderResumeRequest extends ChatProviderThreadRequest {
  readonly threadId: string;
  readonly restartThreadId: string;
}

export interface ChatProviderTurnRequest extends ChatProviderConfiguration {
  readonly accountProfileId: ChatAccountProfileId;
  readonly threadId: string;
  readonly clientTurnId: ChatTurnId;
  readonly prompt: string;
  readonly workingDirectory: string;
}

export interface ChatProviderSteerFence {
  readonly generation: number;
}

export interface ChatProviderSteerRequest {
  readonly binding: ChatThreadBinding;
  readonly providerTurnId: string;
  readonly messageId: ChatMessageId;
  readonly prompt: string;
  readonly fence: ChatProviderSteerFence;
}

export interface ChatProviderPort {
  /** Resolves the first HRA-ordered candidate from one exact provider catalog. */
  resolveConfiguration(
    accountProfileId: ChatAccountProfileId,
    candidates: readonly ChatProviderConfiguration[],
  ): Promise<ChatProviderConfiguration>;
  startThread(request: ChatProviderThreadRequest): Promise<Readonly<{
    threadId: string;
    restartThreadId: string;
  }>>;
  resumeThread(request: ChatProviderResumeRequest): Promise<void>;
  setThreadName(binding: ChatThreadBinding, name: string): Promise<void>;
  injectHistory(binding: ChatThreadBinding, history: readonly ChatHistoryItem[]): Promise<void>;
  startTurn(request: ChatProviderTurnRequest): Promise<Readonly<{
    turnId: string;
    quotaProofCursor: ChatQuotaProofCursor;
  }>>;
  verifySteerTarget(
    input: ChatThreadBinding & Readonly<{ readonly turnId: string }>,
  ): ChatProviderSteerFence | null;
  steerTurn(request: ChatProviderSteerRequest): Promise<void>;
  interruptTurn(input: ChatThreadBinding & Readonly<{ readonly turnId: string }>): Promise<void>;
}

export type ChatProviderFailureCode =
  | "quota_reached"
  | "authentication"
  | "capability_unavailable"
  | "configuration"
  | "runtime"
  | "rejected"
  | "unknown";

export class ChatProviderEffectError extends Error {
  readonly certainty: "not_applied" | "ambiguous";
  readonly code: ChatProviderFailureCode;
  readonly quotaProof: "provider_rate_limit_reached" | null;

  constructor(input: Readonly<{
    readonly certainty: "not_applied" | "ambiguous";
    readonly code: ChatProviderFailureCode;
    readonly quotaProof?: "provider_rate_limit_reached" | null;
  }>) {
    super("The coding provider operation did not complete.");
    this.name = "ChatProviderEffectError";
    this.certainty = input.certainty;
    this.code = input.code;
    this.quotaProof = input.quotaProof ?? null;
  }
}

export type ChatPaneCommand =
  | Readonly<{
      readonly type: "chat.pane.create";
      readonly paneId: ChatPaneId;
      readonly repositoryId: ChatRepositoryId;
    }>
  | Readonly<{
      readonly type: "chat.pane.rename";
      readonly paneId: ChatPaneId;
      readonly expectedRevision: number;
      readonly title: string;
    }>
  | Readonly<{
      readonly type: "chat.pane.workspace.recover";
      readonly paneId: ChatPaneId;
      readonly expectedRevision: number;
    }>
  | Readonly<{
      readonly type: "chat.pane.repository.select";
      readonly paneId: ChatPaneId;
      readonly repositoryId: ChatRepositoryId;
      readonly expectedRevision: number;
    }>
  | Readonly<{
      readonly type: "chat.pane.remove";
      readonly paneId: ChatPaneId;
      readonly expectedRevision: number;
    }>
  | Readonly<{
      readonly type: "chat.panes.reorder";
      readonly expectedOrderedPaneIds: readonly ChatPaneId[];
      readonly orderedPaneIds: readonly ChatPaneId[];
    }>
  | Readonly<{
      readonly type: "chat.turn.start";
      readonly paneId: ChatPaneId;
      readonly expectedRevision: number;
      readonly turnId: ChatTurnId;
      readonly prompt: string;
    }>
  | Readonly<{
      readonly type: "chat.turn.stop";
      readonly paneId: ChatPaneId;
      readonly expectedRevision: number;
      readonly turnId: ChatTurnId;
    }>
  | Readonly<{
      readonly type: "chat.turn.retry";
      readonly paneId: ChatPaneId;
      readonly expectedRevision: number;
      readonly priorFailedTurnId: ChatTurnId;
      readonly turnId: ChatTurnId;
    }>
  | RuntimeChatMessageLedgerCommand;

export type ChatCommandResult =
  | Readonly<{ readonly type: "pane"; readonly pane: ChatPaneProjection }>
  | Readonly<{
      readonly type: "messageQueue";
      readonly paneId: ChatPaneId;
      readonly queue: ChatMessageQueueProjection;
    }>
  | Readonly<{ readonly type: "removed"; readonly paneId: ChatPaneId; readonly revision: number }>
  | Readonly<{ readonly type: "reordered"; readonly orderedPaneIds: readonly ChatPaneId[] }>;

export type ChatDeltaChannel = "reasoningSummary" | "responseMarkdown";

export interface ChatTurnDelta {
  readonly type: "chat.turn.delta";
  readonly paneId: ChatPaneId;
  readonly turnId: ChatTurnId;
  readonly revision: number;
  readonly channel: ChatDeltaChannel;
  readonly startUtf8Offset: number;
  readonly delta: string;
}

export interface ChatProjectionSink {
  /** The host may emit an upsert or invalidate a snapshot when the pane is too large. */
  paneChanged(pane: ChatPaneProjection): void | Promise<void>;
  /** Mutable lifecycle/tool state is bounded and never repeats chat text tails. */
  paneStateChanged(pane: ChatPaneProjection): void | Promise<void>;
  paneRemoved(paneId: ChatPaneId, revision: number): void | Promise<void>;
  panesReordered(orderedPaneIds: readonly ChatPaneId[]): void | Promise<void>;
  /** Complete queue text is already installed in the authoritative snapshot. */
  messageQueueChanged(
    paneId: ChatPaneId,
    queue: ChatMessageQueueProjection,
  ): void | Promise<void>;
  delta(delta: ChatTurnDelta): void | Promise<void>;
}

export interface ChatPanePrivateRecord {
  readonly projection: ChatPaneProjection;
  readonly binding: ChatThreadBinding | null;
  readonly providerTurnId: string | null;
  readonly activePrompt: string | null;
  readonly visitedAccountProfileIds: readonly ChatAccountProfileId[];
  readonly historyTruncated: boolean;
  readonly assistantItem: Readonly<{
    readonly id: string;
    readonly streamText: string;
    readonly overflowed: boolean;
    readonly verified: boolean;
  }> | null;
  readonly activeTurnPoisoned: boolean;
}

export interface ChatActivityDelta {
  readonly paneId: ChatPaneId;
  readonly turnId: ChatTurnId;
  readonly channel: ChatDeltaChannel;
  readonly delta: string;
  /** Gateway-owned assistant item identity; required for responseMarkdown. */
  readonly assistantMessageId?: string;
}

export interface ChatToolActivity {
  readonly paneId: ChatPaneId;
  readonly turnId: ChatTurnId;
  readonly category: ChatToolCategory;
}

export interface ChatTurnTerminal {
  readonly paneId: ChatPaneId;
  readonly turnId: ChatTurnId;
  readonly outcome: "completed" | "failed" | "interrupted";
  /** This exact parsed provider proof terminalizes the logical turn. */
  readonly quotaProof?: "provider_rate_limit_reached";
}

export interface ChatUnexpectedInteraction {
  readonly paneId: ChatPaneId;
  readonly turnId: ChatTurnId;
}

export type {
  ChatAttention,
  ChatAttentionCode,
  ChatPaneActivity,
  ChatPaneInteractionMode,
  ChatPaneProjection,
  ChatReasoningEffort,
  ChatToolCategory,
  ChatToolProjection,
  ChatUtf8Tail,
};
