import type { Database } from "bun:sqlite";
import { z } from "@hra-internal/schema";
import {
  accountProfileIdSchema,
  chatAttentionCodeSchema,
  chatIsoDateTimeSchema,
  chatPaneIdSchema,
  chatPaneActivitySchema,
  chatPaneActivityKindSchema,
  chatPaneInteractionModeSchema,
  chatPaneProjectionSchema,
  chatReasoningSummarySchema,
  chatReasoningEffortSchema,
  chatRootTurnProfileSchema,
  chatRootTurnRoutingClassificationReasonSchema,
  chatRootTurnRoutingProfileFallbackReasonSchema,
  chatRootTurnRoutingProjectionSchema,
  chatRootTurnRoutingServiceTierFallbackReasonSchema,
  chatRootTurnRoutingServiceTierSchema,
  chatRootTurnWorkClassSchema,
  chatServiceTierSchema,
  chatResponseMarkdownSchema,
  chatToolProjectionSchema,
  chatTurnIdSchema,
  harnessActorIdSchema,
  type ChatAttention,
  type ChatPaneProjection,
  type ChatToolCategory,
  type ChatToolProjection,
} from "../../../contracts/runtime";
import {
  CHAT_MAX_CONTINUATIONS,
  CHAT_MAX_ASSISTANT_RECONCILIATION_UTF8_BYTES,
  CHAT_MAX_DELTA_UTF8_BYTES,
  CHAT_MAX_HANDOFF_HISTORY_ITEMS,
  CHAT_MAX_HISTORY_UTF8_BYTES_PER_PANE,
  CHAT_MAX_HISTORY_UTF8_BYTES_TOTAL,
  CHAT_MAX_PANES,
  CHAT_MAX_PROMPT_UTF8_BYTES,
  CHAT_MAX_REASONING_TAIL_UTF8_BYTES,
  CHAT_MAX_RESPONSE_TAIL_UTF8_BYTES,
  CHAT_MAX_TOOLS_PER_TURN,
  CHAT_MAX_TURN_RECEIPTS_PER_PANE,
  CHAT_MODEL,
  type ChatAccountProfileId,
  type ChatDeltaChannel,
  type ChatHistoryItem,
  type ChatHandoffHistory,
  type ChatPaneId,
  type ChatPanePrivateRecord,
  type ChatRepository,
  type ChatThreadBinding,
  type ChatTurnDelta,
  type ChatTurnId,
} from "../chat/types";
import { classifyRootTurnRoutingV1 } from
  "../chat/root-turn-routing-policy-v1";
import {
  appendUtf8Tail,
  assertBoundedUtf8,
  boundedCharacters,
  utf8ByteLength,
  utf8Chunks,
} from "../chat/text-bounds";
import {
  RootTurnRoutingSQLiteAuthorityV1,
  type RootTurnRoutingClassificationAdmissionV1,
} from "../harness/root-turn-routing-sqlite-v1";

const isoDateTimeSchema = chatIsoDateTimeSchema;
const providerIdSchema = z.string().min(1).max(512).refine(
  (value) => !value.includes("\0"),
  "provider identity contains NUL",
);
const assistantItemIdSchema = z.string().min(13).max(96).regex(/^item_[A-Za-z0-9_-]+$/u);
const storedBooleanSchema = z.union([z.literal(0), z.literal(1)]);
const nullableStoredBooleanSchema = storedBooleanSchema.nullable();
const workspaceModeSchema = z.enum(["legacy_unbound", "managed_worktree"]);
const workspaceStateSchema = z.enum([
  "preparing",
  "waiting_capacity",
  "ready",
  "preserved",
  "recovery_required",
]);
const workspaceRecoveryReasonSchema = z.enum([
  "legacy_unbound",
  "capacity_unavailable",
  "insufficient_disk",
  "base_mismatch",
  "binding_mismatch",
  "branch_without_lane",
  "checkout_mismatch",
  "dirty_checkout",
  "invalid_manifest",
  "manifest_missing",
  "path_escape",
  "repository_mismatch",
  "provision_interrupted",
  "lane_missing",
  "unknown",
]);
const toolsSchema = z.array(chatToolProjectionSchema).max(CHAT_MAX_TOOLS_PER_TURN);
const visitedAccountsSchema = z.array(accountProfileIdSchema).max(CHAT_MAX_PANES).superRefine(
  (values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", message: "visited chat accounts must be unique" });
    }
  },
);
const paneOrderSchema = z.array(chatPaneIdSchema).min(1).max(CHAT_MAX_PANES).superRefine(
  (paneIds, context) => {
    if (new Set(paneIds).size !== paneIds.length) {
      context.addIssue({ code: "custom", message: "chat pane order must contain unique IDs" });
    }
  },
);

// These domains are durable released identity bytes. Renaming them would
// orphan existing observer panes, tool receipts, and completion receipts.
const LEGACY_OPRTE_HARNESS_OBSERVER_PANE_DOMAIN =
  "oprte-harness-observer-pane-v1\0";
const LEGACY_OPRTE_CHAT_TOOL_DOMAIN = "oprte-chat-tool-v1\0";
const LEGACY_OPRTE_CHAT_ASSISTANT_COMPLETION_DOMAIN =
  "oprte-chat-assistant-completion-v1\0";

const paneRowSchema = z.object({
  pane_id: chatPaneIdSchema,
  display_order: z.number().int().nonnegative().safe(),
  repository_id: z.string().min(1).max(128),
  repository_name: z.string().min(1).max(160),
  revision: z.number().int().positive().safe(),
  title: z.string().min(1).max(160),
  account_profile_id: accountProfileIdSchema.nullable(),
  model: z.literal(CHAT_MODEL),
  reasoning_effort: chatReasoningEffortSchema,
  service_tier: chatServiceTierSchema,
  state: z.enum(["ready", "starting", "streaming", "continuing", "attention"]),
  activity_ordinal: z.number().int().nonnegative().safe(),
  activity_kind: chatPaneActivityKindSchema,
  interaction_mode: chatPaneInteractionModeSchema,
  workspace_mode: workspaceModeSchema,
  workspace_state: workspaceStateSchema,
  workspace_revision: z.number().int().positive().safe(),
  workspace_recovery_reason: workspaceRecoveryReasonSchema.nullable(),
  archived_at: isoDateTimeSchema.nullable(),
  provider_account_profile_id: accountProfileIdSchema.nullable(),
  provider_thread_id: providerIdSchema.nullable(),
  provider_restart_thread_id: providerIdSchema.nullable(),
  active_turn_id: chatTurnIdSchema.nullable(),
  active_provider_turn_id: providerIdSchema.nullable(),
  active_prompt: z.string().refine(
    (value) => utf8ByteLength(value) <= CHAT_MAX_PROMPT_UTF8_BYTES && !value.includes("\0"),
    "stored chat prompt is invalid",
  ).nullable(),
  turn_status: z.enum(["starting", "streaming", "continuing", "completed", "failed"]).nullable(),
  turn_started_at: isoDateTimeSchema.nullable(),
  turn_completed_at: isoDateTimeSchema.nullable(),
  continuation_count: z.number().int().min(0).max(CHAT_MAX_CONTINUATIONS),
  response_tail: z.string(),
  response_total_utf8_bytes: z.number().int().nonnegative().safe(),
  assistant_item_id: assistantItemIdSchema.nullable(),
  assistant_item_stream_text: z.string().refine(
    (value) => !value.includes("\0") &&
      utf8ByteLength(value) <= CHAT_MAX_ASSISTANT_RECONCILIATION_UTF8_BYTES,
    "stored assistant reconciliation text is invalid",
  ),
  assistant_item_stream_utf8_bytes: z.number().int().min(0)
    .max(CHAT_MAX_ASSISTANT_RECONCILIATION_UTF8_BYTES),
  assistant_item_stream_overflow: storedBooleanSchema,
  assistant_item_verified: storedBooleanSchema,
  active_turn_poisoned: storedBooleanSchema,
  reasoning_tail: z.string(),
  reasoning_total_utf8_bytes: z.number().int().nonnegative().safe(),
  tools_json: z.string(),
  visited_account_ids_json: z.string(),
  attention_code: chatAttentionCodeSchema.nullable(),
  attention_message: z.string().min(1).max(240).nullable(),
  attention_retryable: nullableStoredBooleanSchema,
  history_truncated: storedBooleanSchema,
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
  routing_policy_version: z.literal(1).nullable(),
  routing_classification_reason:
    chatRootTurnRoutingClassificationReasonSchema.nullable(),
  routing_work_class: chatRootTurnWorkClassSchema.nullable(),
  routing_requested_profile: chatRootTurnProfileSchema.nullable(),
  routing_selected_profile: chatRootTurnProfileSchema.nullable(),
  routing_profile_fallback_reason:
    chatRootTurnRoutingProfileFallbackReasonSchema.nullable(),
  routing_requested_service_tier:
    chatRootTurnRoutingServiceTierSchema.nullable(),
  routing_selected_service_tier:
    chatRootTurnRoutingServiceTierSchema.nullable(),
  routing_service_tier_fallback_reason:
    chatRootTurnRoutingServiceTierFallbackReasonSchema.nullable(),
}).strict().superRefine((row, context) => {
  const requiredRouting = [
    row.routing_classification_reason,
    row.routing_work_class,
    row.routing_requested_profile,
    row.routing_requested_service_tier,
  ];
  if (
    row.routing_policy_version === null
      ? requiredRouting.some((value) => value !== null) ||
        row.routing_selected_profile !== null ||
        row.routing_profile_fallback_reason !== null ||
        row.routing_selected_service_tier !== null ||
        row.routing_service_tier_fallback_reason !== null
      : requiredRouting.some((value) => value === null) ||
        row.active_turn_id === null || row.interaction_mode !== "chat"
  ) {
    context.addIssue({
      code: "custom",
      message: "active root routing projection is only partially joined",
      path: ["routing_policy_version"],
    });
  }
});

const historyRowSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  utf8_bytes: z.number().int().nonnegative().safe(),
}).strict();

const countRowSchema = z.object({ count: z.number().int().nonnegative().safe() }).strict();
const bytesRowSchema = z.object({ bytes: z.number().int().nonnegative().safe() }).strict();
const sequenceRowSchema = z.object({ sequence: z.number().int().positive().safe() }).strict();
const assistantReceiptRowSchema = z.object({
  completion_sha256: z.string().length(64).regex(/^[0-9a-f]+$/u),
}).strict();

const CHAT_MAX_ASSISTANT_ITEMS_PER_TURN = 128;
// A 256 KiB stream window can require one extra 4 KiB chunk when a Unicode
// code point leaves up to three bytes unused at a chunk boundary.
const CHAT_MAX_STREAM_DELTAS_PER_BATCH = Math.ceil(
  CHAT_MAX_RESPONSE_TAIL_UTF8_BYTES / (CHAT_MAX_DELTA_UTF8_BYTES - 3),
);

type PaneRow = z.infer<typeof paneRowSchema>;

export class ChatPaneStoreError extends Error {
  readonly code:
    | "not_found"
    | "conflict"
    | "revision_conflict"
    | "limit"
    | "invalid_state"
    | "corrupt_state";

  constructor(
    code: ChatPaneStoreError["code"],
    message: string,
  ) {
    super(message);
    this.name = "ChatPaneStoreError";
    this.code = code;
  }
}

export interface ChatPaneCreateInput {
  readonly paneId: ChatPaneId;
  readonly repository: ChatRepository;
  readonly accountProfileId: ChatAccountProfileId | null;
  readonly title?: string;
  readonly now: Date;
}

export interface ChatAttachedHarnessSessionInput {
  readonly actorId: string;
  readonly repository: ChatRepository;
  readonly binding: ChatThreadBinding;
  readonly title: string;
  readonly now: Date;
}

export type ChatAttachedHarnessSessionResult = Readonly<{
  readonly kind: "created" | "replayed";
  readonly pane: ChatPaneProjection;
}>;

export interface ChatAttachedHarnessResponseInput {
  readonly paneId: ChatPaneId;
  readonly turnId: ChatTurnId;
  readonly markdown: string;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly now: Date;
}

export type ChatAttachedHarnessResponseResult = Readonly<{
  readonly kind: "seeded" | "replayed";
  readonly pane: ChatPaneProjection;
}>;

export interface ChatAttachedHarnessFailureInput {
  readonly paneId: ChatPaneId;
  readonly turnId: ChatTurnId;
  readonly attention: ChatAttention;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly now: Date;
}

export type ChatAttachedHarnessFailureResult = Readonly<{
  readonly kind: "seeded" | "replayed";
  readonly pane: ChatPaneProjection;
}>;

export interface ChatAttachedHarnessCompletionInput {
  readonly paneId: ChatPaneId;
  readonly turnId: ChatTurnId;
  readonly markdown: string;
  readonly now: Date;
}

export interface ChatPaneDeltaResult {
  readonly pane: ChatPaneProjection;
  readonly delta: ChatTurnDelta;
}

export interface ChatPaneDeltaBatchInput {
  readonly paneId: ChatPaneId;
  readonly turnId: ChatTurnId;
  readonly channel: ChatDeltaChannel;
  readonly deltas: readonly string[];
  readonly assistantMessageId?: string;
  readonly now: Date;
}

export interface ChatPaneDeltaBatchResult {
  readonly pane: ChatPaneProjection;
  readonly deltas: readonly ChatTurnDelta[];
}

export type ChatPaneDeltaBatchOutcome =
  | Readonly<{ readonly kind: "written"; readonly result: ChatPaneDeltaBatchResult | null }>
  | Readonly<{ readonly kind: "rejected"; readonly error: unknown }>;

export interface ChatPaneRemoveResult {
  readonly paneId: ChatPaneId;
  readonly revision: number;
}

export type ChatPaneBeginTurnResult =
  | Readonly<{ readonly kind: "begun"; readonly pane: ChatPaneProjection }>
  | Readonly<{ readonly kind: "replayed"; readonly pane: ChatPaneProjection }>;

export type ChatAssistantCompletionResult =
  | Readonly<{ readonly kind: "ignored" | "tainted" | "verified" }>
  | Readonly<{
      readonly kind: "repaired";
      readonly pane: ChatPaneProjection;
      readonly deltas: readonly ChatTurnDelta[];
    }>;

export class ChatPaneStore {
  readonly #database: Database;
  readonly #rootTurnRouting: RootTurnRoutingSQLiteAuthorityV1;

  constructor(database: Database) {
    this.#database = database;
    this.#rootTurnRouting = new RootTurnRoutingSQLiteAuthorityV1(database);
  }

  list(): readonly ChatPaneProjection[] {
    return this.#livePaneRows().map((row) => this.#projection(row));
  }

  get(paneId: ChatPaneId): ChatPanePrivateRecord | null {
    const id = chatPaneIdSchema.parse(paneId);
    const value: unknown = this.#database.query(`
      ${paneWithActiveRoutingSelect()}
      WHERE pane.pane_id = ?1 AND pane.archived_at IS NULL
    `).get(id);
    return value === null ? null : this.#privateRecord(this.#parseRow(value));
  }

  require(paneId: ChatPaneId): ChatPanePrivateRecord {
    const pane = this.get(paneId);
    if (pane === null) throw new ChatPaneStoreError("not_found", "This chat pane no longer exists.");
    return pane;
  }

  findByProviderThread(
    accountProfileId: ChatAccountProfileId,
    providerThreadId: string,
  ): ChatPanePrivateRecord | null {
    const accountId = accountProfileIdSchema.parse(accountProfileId);
    const threadId = providerIdSchema.parse(providerThreadId);
    const values: unknown[] = this.#database.query(`
      ${paneWithActiveRoutingSelect()}
      WHERE pane.provider_account_profile_id = ?1
        AND pane.provider_thread_id = ?2
        AND pane.archived_at IS NULL
      ORDER BY pane.updated_at DESC, pane.pane_id
      LIMIT 2
    `).all(accountId, threadId);
    if (values.length > 1) {
      throw new ChatPaneStoreError("corrupt_state", "A provider thread was bound to multiple panes.");
    }
    const value = values[0];
    return value === undefined ? null : this.#privateRecord(this.#parseRow(value));
  }

  paneIdsReferencingAccount(
    accountProfileId: ChatAccountProfileId,
  ): readonly ChatPaneId[] {
    const accountId = accountProfileIdSchema.parse(accountProfileId);
    const values: unknown[] = this.#database.query(`
      SELECT pane_id FROM chat_panes
      WHERE archived_at IS NULL
        AND (account_profile_id = ?1 OR provider_account_profile_id = ?1)
      ORDER BY display_order, pane_id
    `).all(accountId);
    return values.map((value) => z.object({ pane_id: chatPaneIdSchema }).strict().parse(value).pane_id);
  }

  create(input: ChatPaneCreateInput): ChatPaneProjection {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const repositoryId = input.repository.id;
    const repositoryName = boundedCharacters(input.repository.name.trim(), 160);
    if (repositoryName.length === 0 || repositoryName.includes("\0")) {
      throw new ChatPaneStoreError("conflict", "The chat repository name is invalid.");
    }
    const accountProfileId = input.accountProfileId === null
      ? null
      : accountProfileIdSchema.parse(input.accountProfileId);
    const title = boundedTitle(input.title ?? "New chat");
    const now = isoDateTimeSchema.parse(input.now.toISOString());

    return this.#database.transaction(() => {
      const livePaneCount = this.#livePaneRows().length;
      if (livePaneCount >= CHAT_MAX_PANES) {
        throw new ChatPaneStoreError("limit", "At most 64 chat panes can be open.");
      }
      if (this.get(paneId) !== null) {
        throw new ChatPaneStoreError("conflict", "This chat pane already exists.");
      }
      try {
        this.#database.query(`
          INSERT INTO chat_panes (
            pane_id, display_order, repository_id, repository_name, revision, title,
            account_profile_id, model, reasoning_effort, service_tier,
            interaction_mode, state,
            workspace_mode, workspace_state, workspace_revision,
            workspace_recovery_reason, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, 'max', 'standard', 'chat', 'ready',
            'managed_worktree', 'preparing', 1, NULL, ?8, ?8
          )
        `).run(
          paneId,
          livePaneCount,
          repositoryId,
          repositoryName,
          title,
          accountProfileId,
          CHAT_MODEL,
          now,
        );
      } catch (error: unknown) {
        throw sqliteConflict(error, "The chat pane could not be created.");
      }
      return this.require(paneId).projection;
    })();
  }

  /**
   * Creates the renderer observer for an already-running harness actor.
   *
   * This primitive deliberately does not open a transaction. The harness
   * attachment authority calls it inside the one outer SQLite transaction
   * that also writes the actor-to-pane binding and projection witnesses.
   */
  createAttachedHarnessSession(
    input: ChatAttachedHarnessSessionInput,
  ): ChatAttachedHarnessSessionResult {
    const paneId = harnessObserverPaneId(input.actorId);
    const repositoryId = input.repository.id;
    const repositoryName = boundedCharacters(input.repository.name.trim(), 160);
    if (repositoryName.length === 0 || repositoryName.includes("\0")) {
      throw new ChatPaneStoreError("conflict", "The chat repository name is invalid.");
    }
    const accountProfileId = accountProfileIdSchema.parse(input.binding.accountProfileId);
    const threadId = providerIdSchema.parse(input.binding.threadId);
    const restartThreadId = providerIdSchema.parse(input.binding.restartThreadId);
    const title = boundedTitle(input.title);
    const now = isoDateTimeSchema.parse(input.now.toISOString());
    const existing = this.get(paneId);
    if (existing !== null) {
      if (attachedHarnessSessionMatches(existing, {
        repositoryId,
        repositoryName,
        accountProfileId,
        threadId,
        restartThreadId,
        title,
      })) {
        return { kind: "replayed", pane: existing.projection };
      }
      throw new ChatPaneStoreError(
        "conflict",
        "This harness observer pane conflicts with its durable attachment.",
      );
    }

    const livePaneCount = this.#livePaneRows().length;
    if (livePaneCount >= CHAT_MAX_PANES) {
      throw new ChatPaneStoreError("limit", "At most 64 chat panes can be open.");
    }
    try {
      this.#database.query(`
        INSERT INTO chat_panes (
          pane_id, display_order, repository_id, repository_name, revision, title,
          account_profile_id, model, reasoning_effort, interaction_mode, state,
          provider_account_profile_id, provider_thread_id,
          provider_restart_thread_id, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, 'ultra', 'harnessObserver', 'ready',
          ?6, ?8, ?9, ?10, ?10
        )
      `).run(
        paneId,
        livePaneCount,
        repositoryId,
        repositoryName,
        title,
        accountProfileId,
        CHAT_MODEL,
        threadId,
        restartThreadId,
        now,
      );
    } catch (error: unknown) {
      throw sqliteConflict(error, "The harness observer pane could not be attached.");
    }
    return { kind: "created", pane: this.require(paneId).projection };
  }

  /**
   * Rebinds an attached actor pane after the persistent actor proves a new
   * idle incarnation for a later logical turn. The actor-to-pane identity is stable;
   * only gateway-private session routing changes.
   */
  rebindAttachedHarnessSession(input: Readonly<{
    paneId: ChatPaneId;
    binding: ChatThreadBinding;
    now: Date;
  }>): ChatPaneProjection {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const accountProfileId = accountProfileIdSchema.parse(
      input.binding.accountProfileId,
    );
    const threadId = providerIdSchema.parse(input.binding.threadId);
    const restartThreadId = providerIdSchema.parse(input.binding.restartThreadId);
    const now = isoDateTimeSchema.parse(input.now.toISOString());
    const current = this.require(paneId);
    if (current.projection.interactionMode !== "harnessObserver") {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Only an attached harness pane can change actor session routing.",
      );
    }
    if (
      current.projection.accountProfileId === accountProfileId &&
      current.binding?.accountProfileId === accountProfileId &&
      current.binding.threadId === threadId &&
      current.binding.restartThreadId === restartThreadId
    ) return current.projection;
    try {
      const changed = this.#database.query(`
        UPDATE chat_panes SET
          account_profile_id = ?1,
          provider_account_profile_id = ?1,
          provider_thread_id = ?2,
          provider_restart_thread_id = ?3,
          revision = revision + 1,
          updated_at = ?4
        WHERE pane_id = ?5 AND revision = ?6
          AND interaction_mode = 'harnessObserver'
      `).run(
        accountProfileId,
        threadId,
        restartThreadId,
        now,
        paneId,
        current.projection.revision,
      );
      if (changed.changes !== 1) throw staleRevision();
    } catch (error: unknown) {
      if (error instanceof ChatPaneStoreError) throw error;
      throw sqliteConflict(error, "The attached actor session could not be rebound.");
    }
    return this.require(paneId).projection;
  }

  /**
   * Seeds the observer's one bounded terminal response projection.
   *
   * This is deliberately transaction-neutral and does not append chat
   * history. The encrypted actor result remains the content authority; this
   * row is only the renderer cache created in the same transaction as the
   * actor-to-pane binding and semantic witness.
   */
  seedAttachedHarnessLatestResponse(
    input: ChatAttachedHarnessResponseInput,
  ): ChatAttachedHarnessResponseResult {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const turnId = chatTurnIdSchema.parse(input.turnId);
    if (
      input.markdown.includes("\0") ||
      utf8ByteLength(input.markdown) > CHAT_MAX_HISTORY_UTF8_BYTES_PER_PANE
    ) {
      throw new ChatPaneStoreError(
        "conflict",
        "The harness response exceeds its bounded renderer projection.",
      );
    }
    const startedAt = isoDateTimeSchema.parse(input.startedAt.toISOString());
    const completedAt = isoDateTimeSchema.parse(input.completedAt.toISOString());
    const now = isoDateTimeSchema.parse(input.now.toISOString());
    if (Date.parse(completedAt) < Date.parse(startedAt)) {
      throw new ChatPaneStoreError(
        "conflict",
        "The harness response completed before it started.",
      );
    }
    const response = appendUtf8Tail(
      { tail: "", totalUtf8Bytes: 0, truncatedPrefix: false },
      input.markdown,
      CHAT_MAX_RESPONSE_TAIL_UTF8_BYTES,
    );
    const current = this.require(paneId);
    if (current.projection.interactionMode !== "harnessObserver") {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Only a harness observer pane can receive an actor response.",
      );
    }
    if (current.projection.turn !== null) {
      const existing = current.projection.turn;
      if (
        existing.id === turnId && existing.status === "completed" &&
        existing.startedAt === startedAt && existing.completedAt === completedAt &&
        existing.responseMarkdown.tail === response.tail &&
        existing.responseMarkdown.totalUtf8Bytes === response.totalUtf8Bytes &&
        existing.responseMarkdown.truncatedPrefix === response.truncatedPrefix &&
        existing.reasoningSummary.totalUtf8Bytes === 0 &&
        existing.tools.length === 0
      ) return { kind: "replayed", pane: current.projection };
      throw new ChatPaneStoreError(
        "conflict",
        "The harness observer already projects a different actor response.",
      );
    }
    const changed = this.#database.query(`
      UPDATE chat_panes SET
        state = 'ready', active_turn_id = ?1, turn_status = 'completed',
        turn_started_at = ?2, turn_completed_at = ?3,
        response_tail = ?4, response_total_utf8_bytes = ?5,
        history_truncated = ?6,
        activity_ordinal = activity_ordinal + 1,
        activity_kind = 'responseCompleted',
        revision = revision + 1, updated_at = ?7
      WHERE pane_id = ?8 AND revision = ?9
        AND interaction_mode = 'harnessObserver'
        AND active_turn_id IS NULL
        AND activity_ordinal < 9007199254740991
    `).run(
      turnId,
      startedAt,
      completedAt,
      response.tail,
      response.totalUtf8Bytes,
      response.truncatedPrefix ? 1 : 0,
      now,
      paneId,
      current.projection.revision,
    );
    if (changed.changes !== 1) {
      throw new ChatPaneStoreError(
        "revision_conflict",
        "The harness observer changed before its response was projected.",
      );
    }
    this.#database.query(`
      INSERT INTO chat_turn_receipts(pane_id, turn_id, created_at)
      VALUES (?1, ?2, ?3)
    `).run(paneId, turnId, now);
    return { kind: "seeded", pane: this.require(paneId).projection };
  }

  /** Seeds one exact terminal actor error without inventing transcript text. */
  seedAttachedHarnessLatestFailure(
    input: ChatAttachedHarnessFailureInput,
  ): ChatAttachedHarnessFailureResult {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const turnId = chatTurnIdSchema.parse(input.turnId);
    const code = chatAttentionCodeSchema.parse(input.attention.code);
    const message = boundedCharacters(input.attention.message, 240);
    if (message.length === 0) {
      throw new ChatPaneStoreError("conflict", "Harness actor failure requires a message.");
    }
    const startedAt = isoDateTimeSchema.parse(input.startedAt.toISOString());
    const completedAt = isoDateTimeSchema.parse(input.completedAt.toISOString());
    const now = isoDateTimeSchema.parse(input.now.toISOString());
    if (Date.parse(completedAt) < Date.parse(startedAt)) {
      throw new ChatPaneStoreError(
        "conflict",
        "The harness actor failure completed before it started.",
      );
    }
    const current = this.require(paneId);
    if (current.projection.interactionMode !== "harnessObserver") {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Only a harness observer pane can receive an actor failure.",
      );
    }
    if (current.projection.turn !== null) {
      const existing = current.projection.turn;
      if (
        existing.id === turnId && existing.status === "failed" &&
        existing.startedAt === startedAt && existing.completedAt === completedAt &&
        existing.responseMarkdown.totalUtf8Bytes === 0 &&
        existing.reasoningSummary.totalUtf8Bytes === 0 &&
        existing.tools.length === 0 &&
        current.projection.attention?.code === code &&
        current.projection.attention.message === message &&
        current.projection.attention.retryable === input.attention.retryable
      ) return { kind: "replayed", pane: current.projection };
      throw new ChatPaneStoreError(
        "conflict",
        "The harness observer already projects a different actor result.",
      );
    }
    const changed = this.#database.query(`
      UPDATE chat_panes SET
        state = 'attention', active_turn_id = ?1, turn_status = 'failed',
        turn_started_at = ?2, turn_completed_at = ?3,
        attention_code = ?4, attention_message = ?5,
        attention_retryable = ?6,
        revision = revision + 1, updated_at = ?7
      WHERE pane_id = ?8 AND revision = ?9
        AND interaction_mode = 'harnessObserver'
        AND active_turn_id IS NULL
    `).run(
      turnId,
      startedAt,
      completedAt,
      code,
      message,
      input.attention.retryable ? 1 : 0,
      now,
      paneId,
      current.projection.revision,
    );
    if (changed.changes !== 1) {
      throw new ChatPaneStoreError(
        "revision_conflict",
        "The harness observer changed before its failure was projected.",
      );
    }
    this.#database.query(`
      INSERT INTO chat_turn_receipts(pane_id, turn_id, created_at)
      VALUES (?1, ?2, ?3)
    `).run(paneId, turnId, now);
    return { kind: "seeded", pane: this.require(paneId).projection };
  }

  /**
   * Settles an admitted observer turn directly from its durable actor result.
   * This covers response-before-listener and replay recovery without creating
   * a synthetic provider item or admitting a second logical turn.
   */
  completeAttachedHarnessTurn(
    input: ChatAttachedHarnessCompletionInput,
  ): ChatPaneProjection | null {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const turnId = chatTurnIdSchema.parse(input.turnId);
    if (
      input.markdown.includes("\0") ||
      utf8ByteLength(input.markdown) > CHAT_MAX_HISTORY_UTF8_BYTES_PER_PANE
    ) {
      throw new ChatPaneStoreError(
        "conflict",
        "The harness actor response exceeds its bounded chat projection.",
      );
    }
    return this.#database.transaction(() => {
      const pane = this.get(paneId);
      if (pane === null || pane.projection.turn?.id !== turnId) return null;
      if (pane.projection.interactionMode !== "harnessObserver") {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Only a harness observer pane can settle an actor result.",
        );
      }
      const response = appendUtf8Tail(
        { tail: "", totalUtf8Bytes: 0, truncatedPrefix: false },
        input.markdown,
        CHAT_MAX_RESPONSE_TAIL_UTF8_BYTES,
      );
      if (!isActive(pane.projection)) {
        const existing = pane.projection.turn;
        if (
          existing.status === "completed" &&
          existing.responseMarkdown.tail === response.tail &&
          existing.responseMarkdown.totalUtf8Bytes === response.totalUtf8Bytes &&
          existing.responseMarkdown.truncatedPrefix === response.truncatedPrefix
        ) return pane.projection;
        return null;
      }
      const timestamp = terminalIso(pane.projection.turn.startedAt, input.now);
      const completion = this.#database.query(`
        UPDATE chat_panes
        SET state = 'ready', turn_status = 'completed',
            turn_completed_at = ?1, active_provider_turn_id = NULL,
            active_prompt = NULL, response_tail = ?2,
            response_total_utf8_bytes = ?3,
            history_truncated = CASE WHEN ?4 = 1 THEN 1 ELSE history_truncated END,
            tools_json = '[]', activity_ordinal = activity_ordinal + 1,
            activity_kind = 'responseCompleted',
            revision = revision + 1, updated_at = ?1
        WHERE pane_id = ?5 AND active_turn_id = ?6
          AND interaction_mode = 'harnessObserver'
          AND state IN ('starting', 'streaming', 'continuing')
          AND activity_ordinal < 9007199254740991
      `).run(
        timestamp,
        response.tail,
        response.totalUtf8Bytes,
        response.truncatedPrefix ? 1 : 0,
        paneId,
        turnId,
      );
      if (completion.changes !== 1) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "The harness actor completion could not advance its exact pane.",
        );
      }
      if (pane.activePrompt !== null) {
        this.#appendHistory(paneId, "user", pane.activePrompt, timestamp);
      }
      if (response.tail.length > 0) {
        this.#appendHistory(paneId, "assistant", response.tail, timestamp);
      }
      this.#enforceHistoryBounds(paneId);
      return this.require(paneId).projection;
    })();
  }

  rename(
    paneId: ChatPaneId,
    expectedRevision: number,
    title: string,
    now: Date,
  ): ChatPaneProjection {
    const id = chatPaneIdSchema.parse(paneId);
    validateRevision(expectedRevision);
    const nextTitle = boundedTitle(title);
    const timestamp = isoDateTimeSchema.parse(now.toISOString());
    return this.#database.transaction(() => {
      const current = this.#requireRevision(id, expectedRevision);
      this.#database.query(`
        UPDATE chat_panes
        SET title = ?1, revision = revision + 1, updated_at = ?2
        WHERE pane_id = ?3 AND revision = ?4
      `).run(nextTitle, timestamp, id, expectedRevision);
      const next = this.require(id).projection;
      if (next.revision !== current.projection.revision + 1) {
        throw new ChatPaneStoreError("corrupt_state", "Chat pane revision did not advance exactly once.");
      }
      return next;
    })();
  }

  recoverWorkspace(
    paneId: ChatPaneId,
    expectedRevision: number,
    now: Date,
  ): ChatPaneProjection {
    const id = chatPaneIdSchema.parse(paneId);
    validateRevision(expectedRevision);
    const timestamp = isoDateTimeSchema.parse(now.toISOString());
    return this.#database.transaction(() => {
      const current = this.#requireRevision(id, expectedRevision);
      if (current.projection.interactionMode !== "chat") {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Harness observer panes do not own managed workspace recovery.",
        );
      }
      if (isActive(current.projection)) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Wait for this chat turn to finish before recovering its workspace.",
        );
      }
      const workspace = ordinaryWorkspace(current.projection);
      if (workspace.state === "ready") {
        throw new ChatPaneStoreError(
          "invalid_state",
          "This chat pane workspace does not require recovery.",
        );
      }
      this.#prepareWorkspaceRetry(id, timestamp);
      const clearProviderBinding = workspace.mode === "legacyUnbound";
      try {
        const result = this.#database.query(`
          UPDATE chat_panes
          SET provider_account_profile_id = CASE WHEN ?1 = 1 THEN NULL ELSE provider_account_profile_id END,
              provider_thread_id = CASE WHEN ?1 = 1 THEN NULL ELSE provider_thread_id END,
              provider_restart_thread_id = CASE WHEN ?1 = 1 THEN NULL ELSE provider_restart_thread_id END,
              workspace_mode = 'managed_worktree',
              workspace_state = 'preparing',
              workspace_recovery_reason = NULL,
              workspace_revision = workspace_revision + CASE
                WHEN workspace_state != 'preparing'
                  OR workspace_recovery_reason IS NOT NULL
                THEN 1 ELSE 0 END,
              revision = revision + 1,
              updated_at = ?2
          WHERE pane_id = ?3 AND revision = ?4 AND archived_at IS NULL
        `).run(
          clearProviderBinding ? 1 : 0,
          timestamp,
          id,
          expectedRevision,
        );
        if (result.changes !== 1) throw staleRevision();
      } catch (error: unknown) {
        throw sqliteConflict(error, "The pane workspace could not be recovered.");
      }
      return this.require(id).projection;
    })();
  }

  selectRepository(
    paneId: ChatPaneId,
    expectedRevision: number,
    repository: ChatRepository,
    now: Date,
  ): ChatPaneProjection {
    const id = chatPaneIdSchema.parse(paneId);
    validateRevision(expectedRevision);
    const repositoryName = boundedCharacters(repository.name.trim(), 160);
    if (repositoryName.length === 0 || repositoryName.includes("\0")) {
      throw new ChatPaneStoreError("conflict", "The chat repository name is invalid.");
    }
    const timestamp = isoDateTimeSchema.parse(now.toISOString());
    return this.#database.transaction(() => {
      const current = this.#requireRevision(id, expectedRevision);
      if (current.projection.interactionMode !== "chat") {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Harness observer pane repositories are fixed by their actor attachment.",
        );
      }
      const history = countRowSchema.parse(this.#database.query(`
        SELECT COUNT(*) AS count FROM chat_pane_history WHERE pane_id = ?1
      `).get(id));
      if (isActive(current.projection)) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Wait for this chat turn to finish before changing its project.",
        );
      }
      const changingRepository = current.projection.repository.id !== repository.id;
      if (
        changingRepository && (
          current.projection.turn !== null ||
          current.binding !== null ||
          current.providerTurnId !== null ||
          history.count !== 0
        )
      ) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "A repository can be changed only before this chat has started.",
        );
      }
      const workspace = ordinaryWorkspace(current.projection);
      const prepareWorkspace = changingRepository || workspace.state !== "ready";
      if (changingRepository) {
        this.#preserveActiveWorkspace(id, timestamp);
      } else if (prepareWorkspace) {
        this.#prepareWorkspaceRetry(id, timestamp);
      }
      const clearProviderBinding = changingRepository || workspace.mode === "legacyUnbound";
      const result = this.#database.query(`
        UPDATE chat_panes
        SET repository_id = ?1,
            repository_name = ?2,
            provider_account_profile_id = CASE WHEN ?3 = 1 THEN NULL ELSE provider_account_profile_id END,
            provider_thread_id = CASE WHEN ?3 = 1 THEN NULL ELSE provider_thread_id END,
            provider_restart_thread_id = CASE WHEN ?3 = 1 THEN NULL ELSE provider_restart_thread_id END,
            workspace_mode = CASE WHEN ?4 = 1 THEN 'managed_worktree' ELSE workspace_mode END,
            workspace_state = CASE WHEN ?4 = 1 THEN 'preparing' ELSE workspace_state END,
            workspace_recovery_reason = CASE WHEN ?4 = 1 THEN NULL ELSE workspace_recovery_reason END,
            workspace_revision = workspace_revision + CASE
              WHEN ?4 = 1 AND (
                workspace_state != 'preparing' OR workspace_recovery_reason IS NOT NULL
              ) THEN 1 ELSE 0 END,
            revision = revision + 1,
            updated_at = ?5
        WHERE pane_id = ?6 AND revision = ?7 AND archived_at IS NULL
      `).run(
        repository.id,
        repositoryName,
        clearProviderBinding ? 1 : 0,
        prepareWorkspace ? 1 : 0,
        timestamp,
        id,
        expectedRevision,
      );
      if (result.changes !== 1) throw staleRevision();
      return this.require(id).projection;
    })();
  }

  remove(
    paneId: ChatPaneId,
    expectedRevision: number,
    now: Date = new Date(),
  ): ChatPaneRemoveResult {
    const id = chatPaneIdSchema.parse(paneId);
    validateRevision(expectedRevision);
    const timestamp = isoDateTimeSchema.parse(now.toISOString());
    return this.#database.transaction(() => {
      const liveRows = this.#livePaneRows();
      const removedOrder = liveRows.find((row) => row.pane_id === id)?.display_order;
      if (removedOrder === undefined) {
        throw new ChatPaneStoreError("not_found", "This chat pane no longer exists.");
      }
      const current = this.#requireRevision(id, expectedRevision);
      if (isActive(current.projection)) {
        throw new ChatPaneStoreError("invalid_state", "Wait for this chat turn to finish before closing its pane.");
      }
      if (current.projection.interactionMode === "harnessObserver") {
        throw new ChatPaneStoreError(
          "invalid_state",
          "An attached actor pane is retained with its durable actor binding.",
        );
      }
      if (current.projection.workspace !== null) {
        this.#preserveActiveWorkspace(id, timestamp);
      }
      const result = this.#database.query(`
        UPDATE chat_panes SET
          workspace_state = CASE
            WHEN workspace_mode = 'managed_worktree' THEN 'preserved'
            ELSE workspace_state
          END,
          workspace_recovery_reason = CASE
            WHEN workspace_mode = 'managed_worktree' THEN NULL
            ELSE workspace_recovery_reason
          END,
          workspace_revision = workspace_revision + CASE
            WHEN workspace_mode = 'managed_worktree' THEN 1 ELSE 0
          END,
          active_prompt = NULL,
          archived_at = ?3,
          revision = revision + 1,
          updated_at = ?3
        WHERE pane_id = ?1 AND revision = ?2 AND archived_at IS NULL
      `).run(id, expectedRevision, timestamp);
      if (result.changes < 1) throw staleRevision();
      const archived = z.object({
        revision: z.number().int().positive().safe(),
        archived_at: isoDateTimeSchema,
      }).strict().parse(this.#database.query(`
        SELECT revision, archived_at FROM chat_panes WHERE pane_id = ?1
      `).get(id));
      if (
        archived.revision !== expectedRevision + 1 ||
        archived.archived_at !== timestamp
      ) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "The chat pane archive did not advance exactly once.",
        );
      }
      this.#database.query(`
        UPDATE chat_panes
        SET display_order = display_order + ?1
        WHERE archived_at IS NULL AND display_order > ?2
      `).run(CHAT_MAX_PANES, removedOrder);
      this.#database.query(`
        UPDATE chat_panes
        SET display_order = display_order - ?1
        WHERE archived_at IS NULL AND display_order >= ?2
      `).run(CHAT_MAX_PANES + 1, removedOrder + CHAT_MAX_PANES + 1);
      this.#livePaneRows();
      return { paneId: id, revision: expectedRevision + 1 };
    })();
  }

  reorder(
    expectedOrderedPaneIdsInput: readonly ChatPaneId[],
    orderedPaneIdsInput: readonly ChatPaneId[],
  ): readonly ChatPaneId[] {
    const expectedOrderedPaneIds = paneOrderSchema.parse(expectedOrderedPaneIdsInput);
    const orderedPaneIds = paneOrderSchema.parse(orderedPaneIdsInput);
    return this.#database.transaction(() => {
      const liveRows = this.#livePaneRows();
      const currentPaneIds = liveRows.map((row) => row.pane_id);
      const livePaneIds = new Set(liveRows.map((row) => row.pane_id));
      if (
        expectedOrderedPaneIds.length !== currentPaneIds.length
        || expectedOrderedPaneIds.some((paneId, index) => paneId !== currentPaneIds[index])
      ) {
        throw new ChatPaneStoreError(
          "conflict",
          "The pane order changed before the requested order could be applied.",
        );
      }
      if (
        orderedPaneIds.length !== liveRows.length
        || orderedPaneIds.some((paneId) => !livePaneIds.has(paneId))
      ) {
        throw new ChatPaneStoreError(
          "conflict",
          "The pane order must exactly match the live pane set.",
        );
      }
      try {
        this.#database.query(`
          UPDATE chat_panes
          SET display_order = display_order + ?1
          WHERE archived_at IS NULL
        `).run(CHAT_MAX_PANES);
        const assign = this.#database.query(`
          UPDATE chat_panes SET display_order = ?1
          WHERE pane_id = ?2 AND archived_at IS NULL
        `);
        for (const [displayOrder, paneId] of orderedPaneIds.entries()) {
          if (assign.run(displayOrder, paneId).changes !== 1) {
            throw new ChatPaneStoreError(
              "conflict",
              "The pane order changed while it was being applied.",
            );
          }
        }
      } catch (error: unknown) {
        if (error instanceof ChatPaneStoreError) throw error;
        throw sqliteConflict(error, "The chat pane order could not be stored.");
      }
      this.#livePaneRows();
      return [...orderedPaneIds];
    })();
  }

  beginTurn(input: Readonly<{
    readonly paneId: ChatPaneId;
    readonly expectedRevision: number;
    readonly turnId: ChatTurnId;
    readonly prompt: string;
    readonly now: Date;
  }>): ChatPaneBeginTurnResult {
    return this.#beginTurn(input, "chat");
  }

  beginAttachedHarnessTurn(input: Readonly<{
    readonly paneId: ChatPaneId;
    readonly expectedRevision: number;
    readonly turnId: ChatTurnId;
    readonly prompt: string;
    readonly now: Date;
  }>): ChatPaneBeginTurnResult {
    return this.#beginTurn(input, "harnessObserver");
  }

  retryTurn(input: Readonly<{
    readonly paneId: ChatPaneId;
    readonly expectedRevision: number;
    readonly priorFailedTurnId: ChatTurnId;
    readonly turnId: ChatTurnId;
    readonly now: Date;
  }>): ChatPaneBeginTurnResult {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const priorFailedTurnId = chatTurnIdSchema.parse(input.priorFailedTurnId);
    const turnId = chatTurnIdSchema.parse(input.turnId);
    validateRevision(input.expectedRevision);
    const timestamp = isoDateTimeSchema.parse(input.now.toISOString());
    return this.#database.transaction(() => {
      const current = this.#requireRevision(paneId, input.expectedRevision);
      if (current.projection.interactionMode !== "chat") {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Harness observer panes require persistent actor authority.",
        );
      }
      if (isActive(current.projection)) {
        throw new ChatPaneStoreError("invalid_state", "This chat pane already has an active turn.");
      }
      if (
        current.projection.state !== "attention" ||
        current.projection.attention?.retryable !== true ||
        current.projection.turn?.status !== "failed"
      ) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "This chat pane has no retryable failed turn.",
        );
      }
      if (current.projection.turn.id !== priorFailedTurnId) {
        throw new ChatPaneStoreError(
          "conflict",
          "The retry target does not match this pane's failed turn.",
        );
      }
      if (current.activePrompt === null) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "The failed turn has no recoverable prompt.",
        );
      }
      if (turnId === priorFailedTurnId) {
        throw new ChatPaneStoreError(
          "conflict",
          "A retry requires a new chat turn identifier.",
        );
      }
      const priorReceipt: unknown = this.#database.query(`
        SELECT turn_id FROM chat_turn_receipts WHERE pane_id = ?1 AND turn_id = ?2
      `).get(paneId, turnId);
      if (priorReceipt !== null) {
        throw new ChatPaneStoreError("conflict", "This chat turn identifier was already used.");
      }
      if (this.#rootTurnRouting.readTurnRouting(paneId, turnId) !== null) {
        throw new ChatPaneStoreError(
          "conflict",
          "This chat turn identifier has durable routing history.",
        );
      }
      const routingClassification = this.#routingClassification(
        paneId,
        turnId,
        current.activePrompt,
        input.now,
      );
      if (current.activeTurnPoisoned) {
        this.#database.query("DELETE FROM chat_pane_history WHERE pane_id = ?1")
          .run(paneId);
      }
      this.#database.query(`
        INSERT INTO chat_turn_receipts(pane_id, turn_id, created_at) VALUES (?1, ?2, ?3)
      `).run(paneId, turnId, timestamp);
      this.#rootTurnRouting.admitClassificationInTransaction(
        routingClassification,
      );
      this.#pruneReceipts(paneId);
      const begun = this.#database.query(`
        UPDATE chat_panes
        SET state = 'starting',
            active_turn_id = ?1,
            active_provider_turn_id = NULL,
            turn_status = 'starting',
            turn_started_at = ?2,
            turn_completed_at = NULL,
            continuation_count = 0,
            response_tail = '',
            response_total_utf8_bytes = 0,
            assistant_item_id = NULL,
            assistant_item_stream_text = '',
            assistant_item_stream_utf8_bytes = 0,
            assistant_item_stream_overflow = 0,
            assistant_item_verified = 0,
            active_turn_poisoned = 0,
            reasoning_tail = '',
            reasoning_total_utf8_bytes = 0,
            tools_json = '[]',
            visited_account_ids_json = '[]',
            attention_code = NULL,
            attention_message = NULL,
            attention_retryable = NULL,
            activity_ordinal = activity_ordinal + 1,
            activity_kind = 'messageSent',
            history_truncated = CASE WHEN ?6 = 1 THEN 0 ELSE history_truncated END,
            revision = revision + 1,
            updated_at = ?2
        WHERE pane_id = ?3 AND revision = ?4
          AND active_turn_id = ?5
          AND state = 'attention'
          AND turn_status = 'failed'
          AND attention_retryable = 1
          AND active_prompt IS NOT NULL
          AND activity_ordinal < 9007199254740991
      `).run(
        turnId,
        timestamp,
        paneId,
        input.expectedRevision,
        priorFailedTurnId,
        current.activeTurnPoisoned ? 1 : 0,
      );
      if (begun.changes !== 1) {
        throw new ChatPaneStoreError("corrupt_state", "Chat activity ordinal is exhausted.");
      }
      this.#database.query(`
        DELETE FROM chat_assistant_item_receipts WHERE pane_id = ?1
      `).run(paneId);
      return { kind: "begun", pane: this.require(paneId).projection } as const;
    })();
  }

  #beginTurn(
    input: Readonly<{
      readonly paneId: ChatPaneId;
      readonly expectedRevision: number;
      readonly turnId: ChatTurnId;
      readonly prompt: string;
      readonly now: Date;
    }>,
    interactionMode: "chat" | "harnessObserver",
  ): ChatPaneBeginTurnResult {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const turnId = chatTurnIdSchema.parse(input.turnId);
    validateRevision(input.expectedRevision);
    assertBoundedUtf8(input.prompt, 1, CHAT_MAX_PROMPT_UTF8_BYTES, "Chat prompt");
    const timestamp = isoDateTimeSchema.parse(input.now.toISOString());
    return this.#database.transaction(() => {
      const current = this.#requireRevision(paneId, input.expectedRevision);
      if (current.projection.interactionMode !== interactionMode) {
        throw new ChatPaneStoreError(
          "invalid_state",
          interactionMode === "chat"
            ? "Harness observer panes require persistent actor authority."
            : "Only an attached harness pane accepts an actor turn.",
        );
      }
      const priorReceipt: unknown = this.#database.query(`
        SELECT turn_id FROM chat_turn_receipts WHERE pane_id = ?1 AND turn_id = ?2
      `).get(paneId, turnId);
      if (priorReceipt !== null) {
        if (current.projection.turn?.id === turnId && current.activePrompt === input.prompt) {
          if (
            interactionMode === "chat" &&
            this.#rootTurnRouting.readTurnRouting(paneId, turnId) === null
          ) {
            corrupt("An ordinary replay lost its root routing receipt.");
          }
          return {
            kind: "replayed",
            pane: this.require(paneId).projection,
          } as const;
        }
        throw new ChatPaneStoreError("conflict", "This chat turn identifier was already used.");
      }
      if (
        interactionMode === "chat" &&
        this.#rootTurnRouting.readTurnRouting(paneId, turnId) !== null
      ) {
        throw new ChatPaneStoreError(
          "conflict",
          "This chat turn identifier has durable routing history.",
        );
      }
      const routingClassification = interactionMode === "chat"
        ? this.#routingClassification(
            paneId,
            turnId,
            input.prompt,
            input.now,
          )
        : null;
      if (isActive(current.projection)) {
        throw new ChatPaneStoreError("invalid_state", "This chat pane already has an active turn.");
      }
      if (current.activeTurnPoisoned) {
        this.#database.query("DELETE FROM chat_pane_history WHERE pane_id = ?1")
          .run(paneId);
      }
      this.#database.query(`
        INSERT INTO chat_turn_receipts(pane_id, turn_id, created_at) VALUES (?1, ?2, ?3)
      `).run(paneId, turnId, timestamp);
      if (routingClassification !== null) {
        this.#rootTurnRouting.admitClassificationInTransaction(
          routingClassification,
        );
      }
      this.#pruneReceipts(paneId);
      const begun = this.#database.query(`
        UPDATE chat_panes
        SET state = 'starting',
            active_turn_id = ?1,
            active_provider_turn_id = NULL,
            active_prompt = ?2,
            turn_status = 'starting',
            turn_started_at = ?3,
            turn_completed_at = NULL,
            continuation_count = 0,
            response_tail = '',
            response_total_utf8_bytes = 0,
            assistant_item_id = NULL,
            assistant_item_stream_text = '',
            assistant_item_stream_utf8_bytes = 0,
            assistant_item_stream_overflow = 0,
            assistant_item_verified = 0,
            active_turn_poisoned = 0,
            reasoning_tail = '',
            reasoning_total_utf8_bytes = 0,
            tools_json = '[]',
            visited_account_ids_json = '[]',
            attention_code = NULL,
            attention_message = NULL,
            attention_retryable = NULL,
            activity_ordinal = activity_ordinal + 1,
            activity_kind = 'messageSent',
            history_truncated = CASE WHEN ?6 = 1 THEN 0 ELSE history_truncated END,
            revision = revision + 1,
            updated_at = ?3
        WHERE pane_id = ?4 AND revision = ?5
          AND activity_ordinal < 9007199254740991
      `).run(
        turnId,
        input.prompt,
        timestamp,
        paneId,
        input.expectedRevision,
        current.activeTurnPoisoned ? 1 : 0,
      );
      if (begun.changes !== 1) {
        throw new ChatPaneStoreError("corrupt_state", "Chat activity ordinal is exhausted.");
      }
      this.#database.query(`
        DELETE FROM chat_assistant_item_receipts WHERE pane_id = ?1
      `).run(paneId);
      return { kind: "begun", pane: this.require(paneId).projection } as const;
    })();
  }

  reserveAccount(
    paneId: ChatPaneId,
    turnId: ChatTurnId,
    accountProfileId: ChatAccountProfileId,
    now: Date,
  ): ChatPaneProjection {
    const pane = this.#requireActiveTurn(paneId, turnId);
    const accountId = accountProfileIdSchema.parse(accountProfileId);
    if (pane.visitedAccountProfileIds.includes(accountId)) {
      throw new ChatPaneStoreError("conflict", "This account was already visited by the active chat turn.");
    }
    const visited = [...pane.visitedAccountProfileIds, accountId];
    const timestamp = isoDateTimeSchema.parse(now.toISOString());
    try {
      const result = this.#database.query(`
        UPDATE chat_panes
        SET account_profile_id = ?1,
            visited_account_ids_json = ?2,
            revision = revision + 1,
            updated_at = ?3
        WHERE pane_id = ?4 AND active_turn_id = ?5
          AND state IN ('starting', 'continuing')
      `).run(accountId, JSON.stringify(visited), timestamp, pane.projection.id, turnId);
      if (result.changes !== 1) {
        throw new ChatPaneStoreError("invalid_state", "The chat turn is no longer reserving an account.");
      }
    } catch (error: unknown) {
      throw sqliteConflict(error, "The selected chat account is unavailable.");
    }
    return this.require(pane.projection.id).projection;
  }

  prepareProviderThread(
    paneId: ChatPaneId,
    turnId: ChatTurnId,
    binding: ChatThreadBinding,
    now: Date,
  ): ChatPaneProjection {
    const pane = this.#requireActiveTurn(paneId, turnId);
    if (!pane.visitedAccountProfileIds.includes(binding.accountProfileId)) {
      throw new ChatPaneStoreError("conflict", "A chat thread cannot bind an unvisited account.");
    }
    const threadId = providerIdSchema.parse(binding.threadId);
    const restartThreadId = providerIdSchema.parse(binding.restartThreadId);
    const timestamp = isoDateTimeSchema.parse(now.toISOString());
    const result = this.#database.query(`
      UPDATE chat_panes
      SET provider_account_profile_id = ?1,
          provider_thread_id = ?2,
          provider_restart_thread_id = ?3,
          active_provider_turn_id = NULL,
          revision = revision + 1,
          updated_at = ?4
      WHERE pane_id = ?5 AND active_turn_id = ?6
        AND state IN ('starting', 'continuing')
    `).run(
      binding.accountProfileId,
      threadId,
      restartThreadId,
      timestamp,
      pane.projection.id,
      turnId,
    );
    if (result.changes !== 1) {
      throw new ChatPaneStoreError("invalid_state", "The chat turn is no longer preparing a provider thread.");
    }
    return this.require(pane.projection.id).projection;
  }

  markTurnAccepted(
    paneId: ChatPaneId,
    turnId: ChatTurnId,
    providerTurnId: string,
    now: Date,
  ): ChatPaneProjection {
    const pane = this.#requireActiveTurn(paneId, turnId);
    const rawTurnId = providerIdSchema.parse(providerTurnId);
    if (pane.binding === null) {
      throw new ChatPaneStoreError("invalid_state", "The active chat has no provider thread.");
    }
    const timestamp = isoDateTimeSchema.parse(now.toISOString());
    const result = this.#database.query(`
      UPDATE chat_panes
      SET state = 'streaming',
          turn_status = 'streaming',
          active_provider_turn_id = ?1,
          revision = revision + 1,
          updated_at = ?2
      WHERE pane_id = ?3 AND active_turn_id = ?4
        AND state IN ('starting', 'continuing', 'streaming')
    `).run(rawTurnId, timestamp, pane.projection.id, turnId);
    if (result.changes !== 1) {
      throw new ChatPaneStoreError("invalid_state", "The chat turn is no longer awaiting provider acceptance.");
    }
    return this.require(pane.projection.id).projection;
  }

  appendDelta(input: Readonly<{
    readonly paneId: ChatPaneId;
    readonly turnId: ChatTurnId;
    readonly channel: ChatDeltaChannel;
    readonly delta: string;
    readonly assistantMessageId?: string;
    readonly now: Date;
  }>): ChatPaneDeltaResult | null {
    const result = this.appendDeltaBatch({
      paneId: input.paneId,
      turnId: input.turnId,
      channel: input.channel,
      deltas: [input.delta],
      ...(input.assistantMessageId === undefined
        ? {}
        : { assistantMessageId: input.assistantMessageId }),
      now: input.now,
    });
    if (result === null) return null;
    const delta = result.deltas[0];
    if (delta === undefined || result.deltas.length !== 1) {
      throw new ChatPaneStoreError("corrupt_state", "A scalar chat delta produced an invalid batch.");
    }
    return { pane: result.pane, delta };
  }

  /**
   * Persists one ordered renderer-safe stream batch with one row rewrite and
   * one durability commit. The returned deltas retain their individual
   * contract-sized payloads and exact intermediate revisions.
   */
  appendDeltaBatch(input: ChatPaneDeltaBatchInput): ChatPaneDeltaBatchResult | null {
    return this.#database.transaction(() => this.#appendDeltaBatch(input))();
  }

  /**
   * Co-commits independent pane batches. A bad pane is rolled back to its
   * nested savepoint without sacrificing healthy panes; an outer commit
   * failure still rejects the entire call so callers can contain ambiguity.
   */
  appendDeltaBatches(
    inputs: readonly ChatPaneDeltaBatchInput[],
  ): readonly ChatPaneDeltaBatchOutcome[] {
    if (inputs.length < 1 || inputs.length > CHAT_MAX_PANES) {
      throw new ChatPaneStoreError(
        "limit",
        `A chat stream commit must contain 1..${String(CHAT_MAX_PANES)} pane batches.`,
      );
    }
    return this.#database.transaction(() => inputs.map((input): ChatPaneDeltaBatchOutcome => {
      try {
        const result = this.#database.transaction(() => this.#appendDeltaBatch(input))();
        return { kind: "written", result };
      } catch (error: unknown) {
        return { kind: "rejected", error };
      }
    }))();
  }

  #appendDeltaBatch(input: ChatPaneDeltaBatchInput): ChatPaneDeltaBatchResult | null {
    if (
      input.deltas.length < 1 ||
      input.deltas.length > CHAT_MAX_STREAM_DELTAS_PER_BATCH
    ) {
      throw new ChatPaneStoreError(
        "limit",
        `A chat stream batch must contain 1..${String(CHAT_MAX_STREAM_DELTAS_PER_BATCH)} bounded deltas.`,
      );
    }
    const deltaBytes = input.deltas.map((delta) => assertBoundedUtf8(
      delta,
      1,
      CHAT_MAX_DELTA_UTF8_BYTES,
      "Chat stream delta",
    ));
    const batchBytes = deltaBytes.reduce((total, bytes) => total + bytes, 0);
    if (batchBytes > CHAT_MAX_RESPONSE_TAIL_UTF8_BYTES) {
      throw new ChatPaneStoreError(
        "limit",
        "A chat stream batch exceeded the bounded response window.",
      );
    }
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const turnId = chatTurnIdSchema.parse(input.turnId);
    const pane = this.get(paneId);
    if (
      pane === null ||
      pane.projection.turn?.id !== turnId ||
      !isActive(pane.projection) ||
      pane.activeTurnPoisoned
    ) return null;
    if (pane.projection.revision > Number.MAX_SAFE_INTEGER - input.deltas.length) {
      throw new ChatPaneStoreError("corrupt_state", "Chat pane revision exhausted its safe range.");
    }
    const currentTail = input.channel === "responseMarkdown"
      ? pane.projection.turn.responseMarkdown
      : pane.projection.turn.reasoningSummary;
    const maximumBytes = input.channel === "responseMarkdown"
      ? CHAT_MAX_RESPONSE_TAIL_UTF8_BYTES
      : CHAT_MAX_REASONING_TAIL_UTF8_BYTES;
    const batchText = input.deltas.join("");
    const nextTail = appendUtf8Tail(currentTail, batchText, maximumBytes);
    if (nextTail.totalUtf8Bytes !== currentTail.totalUtf8Bytes + batchBytes) {
      throw new ChatPaneStoreError("corrupt_state", "Chat delta byte accounting drifted.");
    }
    const timestamp = isoDateTimeSchema.parse(input.now.toISOString());
    let result: Readonly<{ changes: number }>;
    if (input.channel === "responseMarkdown") {
      const assistantMessageId = assistantItemIdSchema.parse(input.assistantMessageId);
      const completedReceipt: unknown = this.#database.query(`
        SELECT completion_sha256 FROM chat_assistant_item_receipts
        WHERE pane_id = ?1 AND turn_id = ?2 AND assistant_item_id = ?3
      `).get(pane.projection.id, turnId, assistantMessageId);
      if (completedReceipt !== null) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "An assistant delta arrived after its item completed.",
        );
      }
      const currentItem = pane.assistantItem;
      if (
        currentItem !== null &&
        currentItem.id !== assistantMessageId &&
        !currentItem.verified
      ) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "A new assistant item arrived before the previous item was verified.",
        );
      }
      if (currentItem?.id === assistantMessageId && currentItem.verified) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "An assistant delta arrived after its item completed.",
        );
      }
      const sameItem = currentItem?.id === assistantMessageId;
      const streamText = sameItem ? currentItem.streamText : "";
      const streamBytes = utf8ByteLength(streamText);
      let retainedDeltaCount = 0;
      let retainedDeltaBytes = 0;
      let overflowed = sameItem && currentItem.overflowed;
      if (!overflowed) {
        for (const bytes of deltaBytes) {
          if (
            streamBytes + retainedDeltaBytes + bytes >
              CHAT_MAX_ASSISTANT_RECONCILIATION_UTF8_BYTES
          ) {
            overflowed = true;
            break;
          }
          retainedDeltaCount += 1;
          retainedDeltaBytes += bytes;
        }
      }
      // Once exact completion reconciliation is impossible, the overflow bit
      // is the complete recovery authority. Drop the now-useless duplicate
      // prefix so later bounded tail updates do not keep rewriting it.
      const nextStreamText = overflowed
        ? ""
        : retainedDeltaCount === 0
        ? streamText
        : `${streamText}${input.deltas.slice(0, retainedDeltaCount).join("")}`;
      const nextStreamBytes = overflowed ? 0 : streamBytes + retainedDeltaBytes;
      result = this.#database.query(`
          UPDATE chat_panes
          SET response_tail = ?1,
              response_total_utf8_bytes = ?2,
              assistant_item_id = ?3,
              assistant_item_stream_text = ?4,
              assistant_item_stream_utf8_bytes = ?5,
              assistant_item_stream_overflow = ?6,
              assistant_item_verified = 0,
              state = 'streaming',
              turn_status = 'streaming',
              revision = revision + ?7,
              updated_at = ?8
          WHERE pane_id = ?9 AND active_turn_id = ?10
            AND revision = ?11
            AND state IN ('starting', 'streaming', 'continuing')
            AND active_turn_poisoned = 0
        `).run(
          nextTail.tail,
          nextTail.totalUtf8Bytes,
          assistantMessageId,
          nextStreamText,
          nextStreamBytes,
          overflowed ? 1 : 0,
          input.deltas.length,
          timestamp,
          pane.projection.id,
          turnId,
          pane.projection.revision,
        );
    } else {
      result = this.#database.query(`
          UPDATE chat_panes
          SET reasoning_tail = ?1,
              reasoning_total_utf8_bytes = ?2,
              state = 'streaming',
              turn_status = 'streaming',
              revision = revision + ?3,
              updated_at = ?4
          WHERE pane_id = ?5 AND active_turn_id = ?6
            AND revision = ?7
            AND state IN ('starting', 'streaming', 'continuing')
            AND active_turn_poisoned = 0
        `).run(
          nextTail.tail,
          nextTail.totalUtf8Bytes,
          input.deltas.length,
          timestamp,
          pane.projection.id,
          turnId,
          pane.projection.revision,
        );
    }
    if (result.changes !== 1) return null;
    const projection = this.require(pane.projection.id).projection;
    if (projection.revision !== pane.projection.revision + input.deltas.length) {
      throw new ChatPaneStoreError("corrupt_state", "Chat stream batch revision drifted.");
    }
    let startUtf8Offset = currentTail.totalUtf8Bytes;
    const deltas = input.deltas.map((delta, index): ChatTurnDelta => {
      const value: ChatTurnDelta = {
        type: "chat.turn.delta",
        paneId: pane.projection.id,
        turnId,
        revision: pane.projection.revision + index + 1,
        channel: input.channel,
        startUtf8Offset,
        delta,
      };
      startUtf8Offset += deltaBytes[index] ?? corrupt("Chat batch byte count is missing.");
      return value;
    });
    return {
      pane: projection,
      deltas: Object.freeze(deltas),
    };
  }

  reconcileAssistantCompletion(input: Readonly<{
    readonly paneId: ChatPaneId;
    readonly turnId: ChatTurnId;
    readonly assistantMessageId: string;
    readonly fullText: string;
    readonly truncated: boolean;
    readonly now: Date;
  }>): ChatAssistantCompletionResult {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const turnId = chatTurnIdSchema.parse(input.turnId);
    const assistantMessageId = assistantItemIdSchema.parse(input.assistantMessageId);
    if (input.fullText.includes("\0")) {
      throw new ChatPaneStoreError("conflict", "Assistant completion text contains NUL.");
    }
    const fullTextBytes = utf8ByteLength(input.fullText);
    const timestamp = isoDateTimeSchema.parse(input.now.toISOString());
    return this.#database.transaction(() => {
      const pane = this.get(paneId);
      if (
        pane === null ||
        pane.projection.turn?.id !== turnId ||
        !isActive(pane.projection) ||
        pane.activeTurnPoisoned
      ) return { kind: "ignored" } as const;
      const currentItem = pane.assistantItem;
      const completionDigest = assistantCompletionDigest(input.fullText);
      const priorReceiptValue: unknown = this.#database.query(`
        SELECT completion_sha256 FROM chat_assistant_item_receipts
        WHERE pane_id = ?1 AND turn_id = ?2 AND assistant_item_id = ?3
      `).get(paneId, turnId, assistantMessageId);
      if (priorReceiptValue !== null) {
        const priorReceipt = assistantReceiptRowSchema.parse(priorReceiptValue);
        if (
          !input.truncated &&
          fullTextBytes <= CHAT_MAX_ASSISTANT_RECONCILIATION_UTF8_BYTES &&
          priorReceipt.completion_sha256 === completionDigest
        ) return { kind: "ignored" } as const;
        this.#taintAssistantItem(paneId, turnId);
        return { kind: "tainted" } as const;
      }
      if (
        input.truncated ||
        fullTextBytes > CHAT_MAX_ASSISTANT_RECONCILIATION_UTF8_BYTES ||
        currentItem?.overflowed === true ||
        (
          currentItem !== null &&
          currentItem.id !== assistantMessageId &&
          !currentItem.verified
        )
      ) {
        this.#taintAssistantItem(paneId, turnId);
        return { kind: "tainted" } as const;
      }
      const streamed = currentItem?.id === assistantMessageId
        ? currentItem.streamText
        : "";
      if (!input.fullText.startsWith(streamed)) {
        this.#taintAssistantItem(paneId, turnId);
        return { kind: "tainted" } as const;
      }
      const missingSuffix = input.fullText.slice(streamed.length);
      if (missingSuffix.length === 0) {
        const result = this.#database.query(`
          UPDATE chat_panes
          SET assistant_item_id = ?1,
              assistant_item_stream_text = ?2,
              assistant_item_stream_utf8_bytes = ?3,
              assistant_item_stream_overflow = 0,
              assistant_item_verified = 1
          WHERE pane_id = ?4 AND active_turn_id = ?5
            AND state IN ('starting', 'streaming', 'continuing')
            AND active_turn_poisoned = 0
        `).run(assistantMessageId, input.fullText, fullTextBytes, paneId, turnId);
        if (result.changes !== 1) return { kind: "ignored" } as const;
        this.#recordAssistantCompletion(
          paneId,
          turnId,
          assistantMessageId,
          completionDigest,
        );
        return { kind: "verified" } as const;
      }
      if (pane.projection.turn === null) unreachableTurn();
      const currentResponse = pane.projection.turn.responseMarkdown;
      const repairChunks = utf8Chunks(missingSuffix, CHAT_MAX_DELTA_UTF8_BYTES);
      const repairedResponse = appendUtf8Tail(
        currentResponse,
        missingSuffix,
        CHAT_MAX_RESPONSE_TAIL_UTF8_BYTES,
      );
      const result = this.#database.query(`
        UPDATE chat_panes
        SET response_tail = ?1,
            response_total_utf8_bytes = ?2,
            assistant_item_id = ?3,
            assistant_item_stream_text = ?4,
            assistant_item_stream_utf8_bytes = ?5,
            assistant_item_stream_overflow = 0,
            assistant_item_verified = 1,
            state = 'streaming',
            turn_status = 'streaming',
            revision = revision + ?6,
            updated_at = ?7
        WHERE pane_id = ?8 AND active_turn_id = ?9
          AND state IN ('starting', 'streaming', 'continuing')
          AND active_turn_poisoned = 0
      `).run(
        repairedResponse.tail,
        repairedResponse.totalUtf8Bytes,
        assistantMessageId,
        input.fullText,
        fullTextBytes,
        repairChunks.length,
        timestamp,
        paneId,
        turnId,
      );
      if (result.changes !== 1) return { kind: "ignored" } as const;
      this.#recordAssistantCompletion(
        paneId,
        turnId,
        assistantMessageId,
        completionDigest,
      );
      let startUtf8Offset = currentResponse.totalUtf8Bytes;
      const deltas = repairChunks.map((delta, index): ChatTurnDelta => {
        const value: ChatTurnDelta = {
          type: "chat.turn.delta",
          paneId,
          turnId,
          revision: pane.projection.revision + index + 1,
          channel: "responseMarkdown",
          startUtf8Offset,
          delta,
        };
        startUtf8Offset += utf8ByteLength(delta);
        return value;
      });
      const repaired = this.require(paneId).projection;
      if (repaired.revision !== pane.projection.revision + deltas.length) {
        throw new ChatPaneStoreError("corrupt_state", "Assistant repair revision drifted.");
      }
      return { kind: "repaired", pane: repaired, deltas } as const;
    })();
  }

  poisonTurn(
    paneId: ChatPaneId,
    turnId: ChatTurnId,
    now: Date,
  ): ChatPaneProjection | null {
    const pane = this.get(chatPaneIdSchema.parse(paneId));
    if (
      pane === null ||
      pane.projection.turn?.id !== chatTurnIdSchema.parse(turnId) ||
      !isActive(pane.projection)
    ) return null;
    const timestamp = terminalIso(pane.projection.turn.startedAt, now);
    const result = this.#database.query(`
      UPDATE chat_panes
      SET state = 'attention',
          turn_status = 'failed',
          turn_completed_at = ?1,
          active_provider_turn_id = NULL,
          provider_account_profile_id = NULL,
          provider_thread_id = NULL,
          provider_restart_thread_id = NULL,
          active_turn_poisoned = 1,
          tools_json = ?2,
          attention_code = 'runtime_unavailable',
          attention_message = 'Streaming state could not be saved safely. Send your message again to start fresh.',
          attention_retryable = 1,
          revision = revision + 1,
          updated_at = ?1
      WHERE pane_id = ?3 AND active_turn_id = ?4
        AND state IN ('starting', 'streaming', 'continuing')
    `).run(
      timestamp,
      JSON.stringify(completeAllTools(pane.projection.turn.tools)),
      pane.projection.id,
      turnId,
    );
    return result.changes === 1 ? this.require(pane.projection.id).projection : null;
  }

  startTool(
    paneId: ChatPaneId,
    turnId: ChatTurnId,
    category: ChatToolCategory,
    now: Date,
  ): ChatPaneProjection | null {
    const pane = this.get(paneId);
    if (pane === null || pane.projection.turn?.id !== turnId || !isActive(pane.projection)) {
      return null;
    }
    const tools = pane.projection.turn.tools;
    if (tools.length >= CHAT_MAX_TOOLS_PER_TURN) return null;
    const tool: ChatToolProjection = {
      id: ownedToolId(pane.projection.id, turnId, tools.length),
      category,
      status: "running",
    };
    return this.#replaceTools(pane, [...tools, tool], now);
  }

  recordToolStarted(
    paneId: ChatPaneId,
    turnId: ChatTurnId,
    now: Date,
  ): ChatPaneProjection | null {
    const pane = this.get(chatPaneIdSchema.parse(paneId));
    if (
      pane === null ||
      pane.projection.turn?.id !== chatTurnIdSchema.parse(turnId) ||
      !isActive(pane.projection)
    ) return null;
    const timestamp = isoDateTimeSchema.parse(now.toISOString());
    const result = this.#database.query(`
      UPDATE chat_panes
      SET activity_ordinal = activity_ordinal + 1,
          activity_kind = 'toolStarted',
          revision = revision + 1,
          updated_at = ?1
      WHERE pane_id = ?2 AND active_turn_id = ?3
        AND state IN ('starting', 'streaming', 'continuing')
        AND activity_ordinal < 9007199254740991
    `).run(timestamp, pane.projection.id, turnId);
    if (result.changes !== 1) {
      const current = this.get(pane.projection.id);
      if (current === null || current.projection.turn?.id !== turnId || !isActive(current.projection)) {
        return null;
      }
      throw new ChatPaneStoreError("corrupt_state", "Chat activity ordinal is exhausted.");
    }
    return this.require(pane.projection.id).projection;
  }

  recordThinkingCompleted(
    paneId: ChatPaneId,
    turnId: ChatTurnId,
    now: Date,
  ): ChatPaneProjection | null {
    const pane = this.get(chatPaneIdSchema.parse(paneId));
    if (
      pane === null ||
      pane.projection.turn?.id !== chatTurnIdSchema.parse(turnId) ||
      !isActive(pane.projection)
    ) return null;
    const timestamp = isoDateTimeSchema.parse(now.toISOString());
    const result = this.#database.query(`
      UPDATE chat_panes
      SET activity_ordinal = activity_ordinal + 1,
          activity_kind = 'thinkingCompleted',
          revision = revision + 1,
          updated_at = ?1
      WHERE pane_id = ?2 AND active_turn_id = ?3
        AND state IN ('starting', 'streaming', 'continuing')
        AND activity_ordinal < 9007199254740991
    `).run(timestamp, pane.projection.id, turnId);
    if (result.changes !== 1) {
      const current = this.get(pane.projection.id);
      if (current === null || current.projection.turn?.id !== turnId || !isActive(current.projection)) {
        return null;
      }
      throw new ChatPaneStoreError("corrupt_state", "Chat activity ordinal is exhausted.");
    }
    return this.require(pane.projection.id).projection;
  }

  completeTool(
    paneId: ChatPaneId,
    turnId: ChatTurnId,
    category: ChatToolCategory,
    now: Date,
  ): ChatPaneProjection | null {
    const pane = this.get(paneId);
    if (pane === null || pane.projection.turn?.id !== turnId || !isActive(pane.projection)) {
      return null;
    }
    const index = pane.projection.turn.tools.findIndex(
      (tool) => tool.category === category && tool.status === "running",
    );
    if (index < 0) return null;
    const tools = pane.projection.turn.tools.map((tool, candidateIndex) =>
      candidateIndex === index ? { ...tool, status: "completed" as const } : tool);
    return this.#replaceTools(pane, tools, now);
  }

  beginContinuation(
    paneId: ChatPaneId,
    turnId: ChatTurnId,
    accountProfileId: ChatAccountProfileId,
    now: Date,
  ): ChatPaneProjection {
    const pane = this.#requireActiveTurn(paneId, turnId);
    if (pane.projection.turn === null) unreachableTurn();
    if (pane.projection.turn.continuationCount >= CHAT_MAX_CONTINUATIONS) {
      throw new ChatPaneStoreError("limit", "This chat turn reached its continuation limit.");
    }
    const accountId = accountProfileIdSchema.parse(accountProfileId);
    if (pane.visitedAccountProfileIds.includes(accountId)) {
      throw new ChatPaneStoreError("conflict", "This account was already visited by the active chat turn.");
    }
    const visited = [...pane.visitedAccountProfileIds, accountId];
    const timestamp = isoDateTimeSchema.parse(now.toISOString());
    try {
      this.#database.query(`
        UPDATE chat_panes
        SET account_profile_id = ?1,
            state = 'continuing',
            turn_status = 'continuing',
            continuation_count = continuation_count + 1,
            provider_account_profile_id = NULL,
            provider_thread_id = NULL,
            provider_restart_thread_id = NULL,
            active_provider_turn_id = NULL,
            assistant_item_id = NULL,
            assistant_item_stream_text = '',
            assistant_item_stream_utf8_bytes = 0,
            assistant_item_stream_overflow = 0,
            assistant_item_verified = 0,
            visited_account_ids_json = ?2,
            revision = revision + 1,
            updated_at = ?3
        WHERE pane_id = ?4 AND active_turn_id = ?5
          AND state IN ('starting', 'streaming', 'continuing')
      `).run(accountId, JSON.stringify(visited), timestamp, pane.projection.id, turnId);
    } catch (error: unknown) {
      throw sqliteConflict(error, "The continuation account is unavailable.");
    }
    return this.require(pane.projection.id).projection;
  }

  completeTurn(
    paneId: ChatPaneId,
    turnId: ChatTurnId,
    now: Date,
  ): ChatPaneProjection | null {
    return this.#database.transaction(() => {
      const pane = this.get(paneId);
      if (pane === null || pane.projection.turn?.id !== turnId || !isActive(pane.projection)) {
        return null;
      }
      if (
        pane.activeTurnPoisoned ||
        pane.assistantItem === null ||
        !pane.assistantItem.verified ||
        pane.assistantItem.overflowed
      ) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "The completed assistant response was not reconciled.",
        );
      }
      const timestamp = terminalIso(pane.projection.turn.startedAt, now);
      const response = pane.projection.turn.responseMarkdown.tail;
      const completion = this.#database.query(`
        UPDATE chat_panes
        SET state = 'ready',
            turn_status = 'completed',
            turn_completed_at = ?1,
            active_provider_turn_id = NULL,
            active_prompt = NULL,
            tools_json = ?2,
            activity_ordinal = activity_ordinal + 1,
            activity_kind = 'responseCompleted',
            revision = revision + 1,
            updated_at = ?1
        WHERE pane_id = ?3 AND active_turn_id = ?4
          AND state IN ('starting', 'streaming', 'continuing')
          AND activity_ordinal < 9007199254740991
      `).run(
        timestamp,
        JSON.stringify(completeAllTools(pane.projection.turn.tools)),
        pane.projection.id,
        turnId,
      );
      if (completion.changes !== 1) {
        throw new ChatPaneStoreError("corrupt_state", "Chat activity ordinal is exhausted.");
      }
      if (pane.projection.turn.responseMarkdown.truncatedPrefix) {
        this.#database.query(`
          UPDATE chat_panes SET history_truncated = 1 WHERE pane_id = ?1
        `).run(pane.projection.id);
      }
      if (pane.activePrompt !== null) this.#appendHistory(pane.projection.id, "user", pane.activePrompt, timestamp);
      if (response.length > 0) this.#appendHistory(pane.projection.id, "assistant", response, timestamp);
      this.#enforceHistoryBounds(pane.projection.id);
      return this.require(pane.projection.id).projection;
    })();
  }

  enterAttention(input: Readonly<{
    readonly paneId: ChatPaneId;
    readonly turnId: ChatTurnId;
    readonly attention: ChatAttention;
    readonly clearBinding: boolean;
    readonly now: Date;
  }>): ChatPaneProjection | null {
    const code = chatAttentionCodeSchema.parse(input.attention.code);
    const message = boundedCharacters(input.attention.message, 240);
    if (message.length === 0) throw new ChatPaneStoreError("conflict", "Chat attention requires a message.");
    const pane = this.get(input.paneId);
    if (pane === null || pane.projection.turn?.id !== input.turnId || !isActive(pane.projection)) {
      return null;
    }
    const timestamp = terminalIso(pane.projection.turn.startedAt, input.now);
    this.#database.query(`
      UPDATE chat_panes
      SET state = 'attention',
          turn_status = 'failed',
          turn_completed_at = ?1,
          active_prompt = CASE WHEN ?6 = 1 THEN active_prompt ELSE NULL END,
          active_provider_turn_id = NULL,
          provider_account_profile_id = CASE WHEN ?2 = 1 THEN NULL ELSE provider_account_profile_id END,
          provider_thread_id = CASE WHEN ?2 = 1 THEN NULL ELSE provider_thread_id END,
          provider_restart_thread_id = CASE WHEN ?2 = 1 THEN NULL ELSE provider_restart_thread_id END,
          history_truncated = CASE
            WHEN ?2 = 0 AND active_provider_turn_id IS NOT NULL THEN 1
            ELSE history_truncated
          END,
          tools_json = ?3,
          attention_code = ?4,
          attention_message = ?5,
          attention_retryable = ?6,
          revision = revision + 1,
          updated_at = ?1
      WHERE pane_id = ?7 AND active_turn_id = ?8
        AND state IN ('starting', 'streaming', 'continuing')
    `).run(
      timestamp,
      input.clearBinding ? 1 : 0,
      JSON.stringify(completeAllTools(pane.projection.turn.tools)),
      code,
      message,
      input.attention.retryable ? 1 : 0,
      pane.projection.id,
      input.turnId,
    );
    return this.require(pane.projection.id).projection;
  }

  resetContextWithAttention(input: Readonly<{
    readonly paneId: ChatPaneId;
    readonly turnId: ChatTurnId;
    readonly attention: ChatAttention;
    readonly now: Date;
  }>): ChatPaneProjection | null {
    const code = chatAttentionCodeSchema.parse(input.attention.code);
    const message = boundedCharacters(input.attention.message, 240);
    if (message.length === 0) throw new ChatPaneStoreError("conflict", "Chat attention requires a message.");
    return this.#database.transaction(() => {
      const pane = this.get(input.paneId);
      if (pane === null || pane.projection.turn?.id !== input.turnId || !isActive(pane.projection)) {
        return null;
      }
      const timestamp = terminalIso(pane.projection.turn.startedAt, input.now);
      const result = this.#database.query(`
        UPDATE chat_panes
        SET state = 'attention',
            turn_status = 'failed',
            turn_completed_at = ?1,
            active_prompt = CASE WHEN ?5 = 1 THEN active_prompt ELSE NULL END,
            active_provider_turn_id = NULL,
            provider_account_profile_id = NULL,
            provider_thread_id = NULL,
            provider_restart_thread_id = NULL,
            tools_json = ?2,
            attention_code = ?3,
            attention_message = ?4,
            attention_retryable = ?5,
            history_truncated = 0,
            revision = revision + 1,
            updated_at = ?1
        WHERE pane_id = ?6 AND active_turn_id = ?7
          AND state IN ('starting', 'streaming', 'continuing')
      `).run(
        timestamp,
        JSON.stringify(completeAllTools(pane.projection.turn.tools)),
        code,
        message,
        input.attention.retryable ? 1 : 0,
        pane.projection.id,
        input.turnId,
      );
      if (result.changes !== 1) return null;
      this.#database.query("DELETE FROM chat_pane_history WHERE pane_id = ?1")
        .run(pane.projection.id);
      return this.require(pane.projection.id).projection;
    })();
  }

  detachUnavailableAccount(
    paneId: ChatPaneId,
    accountProfileId: ChatAccountProfileId,
    now: Date,
  ): ChatPaneProjection | null {
    const id = chatPaneIdSchema.parse(paneId);
    const accountId = accountProfileIdSchema.parse(accountProfileId);
    const timestamp = isoDateTimeSchema.parse(now.toISOString());
    return this.#database.transaction(() => {
      const pane = this.get(id);
      if (
        pane === null ||
        (
          pane.projection.accountProfileId !== accountId &&
          pane.binding?.accountProfileId !== accountId
        )
      ) return null;
      if (isActive(pane.projection)) {
        if (pane.projection.turn === null) unreachableTurn();
        const terminalAt = terminalIso(pane.projection.turn.startedAt, now);
        const result = this.#database.query(`
          UPDATE chat_panes
          SET account_profile_id = CASE WHEN account_profile_id = ?1 THEN NULL ELSE account_profile_id END,
              state = 'attention',
              turn_status = 'failed',
              turn_completed_at = ?2,
              active_provider_turn_id = NULL,
              provider_account_profile_id = NULL,
              provider_thread_id = NULL,
              provider_restart_thread_id = NULL,
              tools_json = ?3,
              attention_code = 'account_unavailable',
              attention_message = 'This Codex subscription became unavailable. HRA will choose another connected subscription when you send again.',
              attention_retryable = 1,
              revision = revision + 1,
              updated_at = ?2
          WHERE pane_id = ?4 AND revision = ?5
            AND state IN ('starting', 'streaming', 'continuing')
        `).run(
          accountId,
          terminalAt,
          JSON.stringify(completeAllTools(pane.projection.turn.tools)),
          id,
          pane.projection.revision,
        );
        if (result.changes !== 1) return null;
        return this.require(id).projection;
      }
      const result = this.#database.query(`
        UPDATE chat_panes
        SET account_profile_id = CASE WHEN account_profile_id = ?1 THEN NULL ELSE account_profile_id END,
            provider_account_profile_id = CASE WHEN provider_account_profile_id = ?1 THEN NULL ELSE provider_account_profile_id END,
            provider_thread_id = CASE WHEN provider_account_profile_id = ?1 THEN NULL ELSE provider_thread_id END,
            provider_restart_thread_id = CASE WHEN provider_account_profile_id = ?1 THEN NULL ELSE provider_restart_thread_id END,
            revision = revision + 1,
            updated_at = ?2
        WHERE pane_id = ?3 AND revision = ?4
      `).run(accountId, timestamp, id, pane.projection.revision);
      if (result.changes !== 1) return null;
      return this.require(id).projection;
    })();
  }

  recoverInterrupted(
    now: Date,
    options: Readonly<{ preserveAttachedHarness?: boolean }> = {},
  ): readonly ChatPaneProjection[] {
    return this.#database.transaction(() => {
      const activeValues: unknown[] = this.#database.query(`
        ${paneWithActiveRoutingSelect()}
        WHERE pane.state IN ('starting', 'streaming', 'continuing')
          AND pane.archived_at IS NULL
        ORDER BY pane.created_at, pane.pane_id
      `).all();
      const active = activeValues.map((value) => this.#parseRow(value));
      const recoveredPaneIds: ChatPaneId[] = [];
      for (const row of active) {
        if (
          options.preserveAttachedHarness === true &&
          row.interaction_mode === "harnessObserver"
        ) continue;
        const timestamp = terminalIso(
          row.turn_started_at ?? corrupt("Active chat turn start time is missing."),
          now,
        );
        const route = row.active_turn_id === null
          ? null
          : this.#rootTurnRouting.readTurnRouting(
              row.pane_id,
              row.active_turn_id,
            );
        if (
          route !== null &&
          (
            route.state === "classified" || route.state === "resolved" ||
            route.state === "effectStarted" || route.state === "accepted"
          )
        ) {
          this.#rootTurnRouting.settleInTransaction({
            paneId: row.pane_id,
            chatTurnId: row.active_turn_id ?? corrupt(
              "Active root routing evidence lost its chat turn.",
            ),
            outcome: route.state === "classified" || route.state === "resolved"
              ? "notApplied"
              : route.state === "effectStarted"
                ? "ambiguous"
                : "interrupted",
            now: new Date(timestamp),
          });
        }
        const tools = completeAllTools(parseJson(row.tools_json, toolsSchema));
        this.#database.query(`
          UPDATE chat_panes
          SET state = 'attention',
              turn_status = 'failed',
              turn_completed_at = ?1,
              active_provider_turn_id = NULL,
              provider_account_profile_id = NULL,
              provider_thread_id = NULL,
              provider_restart_thread_id = NULL,
              active_turn_poisoned = 1,
              tools_json = ?2,
              attention_code = 'runtime_unavailable',
              attention_message = 'The previous turn was interrupted when HRA restarted. Send another message to continue.',
              attention_retryable = 1,
              revision = revision + 1,
              updated_at = ?1
          WHERE pane_id = ?3 AND revision = ?4
        `).run(timestamp, JSON.stringify(tools), row.pane_id, row.revision);
        recoveredPaneIds.push(chatPaneIdSchema.parse(row.pane_id));
      }
      return recoveredPaneIds.map((paneId) => this.require(paneId).projection);
    })();
  }

  handoffHistory(
    paneId: ChatPaneId,
    includeActiveTurn: boolean,
  ): ChatHandoffHistory {
    const pane = this.require(paneId);
    const values: unknown[] = this.#database.query(`
      SELECT role, text, utf8_bytes
      FROM chat_pane_history
      WHERE pane_id = ?1
      ORDER BY sequence
    `).all(pane.projection.id);
    const history: ChatHistoryItem[] = values.map((value) => {
      const row = historyRowSchema.parse(value);
      if (utf8ByteLength(row.text) !== row.utf8_bytes) {
        throw new ChatPaneStoreError("corrupt_state", "Stored chat history byte count drifted.");
      }
      return { role: row.role, text: row.text };
    });
    let complete = !pane.historyTruncated;
    if (includeActiveTurn && pane.activePrompt !== null) {
      if (
        pane.activeTurnPoisoned ||
        (
          pane.assistantItem !== null &&
          (!pane.assistantItem.verified || pane.assistantItem.overflowed)
        )
      ) complete = false;
      history.push({ role: "user", text: pane.activePrompt });
      const activeResponse = pane.projection.turn?.responseMarkdown ?? null;
      const partialResponse = activeResponse?.tail ?? "";
      if (activeResponse?.truncatedPrefix === true) complete = false;
      if (partialResponse.length > 0) history.push({ role: "assistant", text: partialResponse });
    }
    const bounded = boundedHistorySuffix(
      history,
      CHAT_MAX_HISTORY_UTF8_BYTES_PER_PANE,
      CHAT_MAX_HANDOFF_HISTORY_ITEMS,
    );
    return { items: bounded.values, complete: complete && !bounded.truncated };
  }

  #replaceTools(
    pane: ChatPanePrivateRecord,
    tools: readonly ChatToolProjection[],
    now: Date,
  ): ChatPaneProjection {
    const parsedTools = toolsSchema.parse(tools);
    const timestamp = isoDateTimeSchema.parse(now.toISOString());
    this.#database.query(`
      UPDATE chat_panes
      SET tools_json = ?1, revision = revision + 1, updated_at = ?2
      WHERE pane_id = ?3 AND active_turn_id = ?4
        AND state IN ('starting', 'streaming', 'continuing')
    `).run(
      JSON.stringify(parsedTools),
      timestamp,
      pane.projection.id,
      pane.projection.turn?.id ?? "",
    );
    return this.require(pane.projection.id).projection;
  }

  #prepareWorkspaceRetry(paneId: ChatPaneId, timestamp: string): void {
    this.#database.query(`
      UPDATE workspace_leases SET
        status = 'provisioning',
        quarantine_reason = NULL,
        quarantined_at = NULL,
        updated_at = ?2
      WHERE lane_id IN (
        SELECT workspace_lease_id FROM chat_pane_workspace_bindings
        WHERE pane_id = ?1 AND state != 'preserved'
      ) AND status IN ('provisioning', 'quarantined')
    `).run(paneId, timestamp);
    this.#database.query(`
      UPDATE chat_pane_workspace_bindings SET
        state = 'provisioning',
        recovery_reason = NULL,
        revision = revision + 1,
        updated_at = ?2
      WHERE pane_id = ?1 AND state IN ('quarantined', 'recovery_required')
    `).run(paneId, timestamp);
  }

  #preserveActiveWorkspace(paneId: ChatPaneId, timestamp: string): void {
    this.#database.query(`
      UPDATE workspace_leases SET status = 'preserved', updated_at = ?2
      WHERE lane_id IN (
        SELECT workspace_lease_id FROM chat_pane_workspace_bindings
        WHERE pane_id = ?1 AND state != 'preserved'
      )
    `).run(paneId, timestamp);
    this.#database.query(`
      UPDATE chat_pane_workspace_bindings SET
        state = 'preserved', recovery_reason = NULL,
        revision = revision + 1, updated_at = ?2
      WHERE pane_id = ?1 AND state != 'preserved'
    `).run(paneId, timestamp);
  }

  #taintAssistantItem(paneId: ChatPaneId, turnId: ChatTurnId): void {
    const result = this.#database.query(`
      UPDATE chat_panes
      SET assistant_item_stream_overflow = 1,
          assistant_item_verified = 0,
          history_truncated = 1
      WHERE pane_id = ?1 AND active_turn_id = ?2
        AND state IN ('starting', 'streaming', 'continuing')
    `).run(paneId, turnId);
    if (result.changes !== 1) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The assistant item could not be durably tainted.",
      );
    }
  }

  #recordAssistantCompletion(
    paneId: ChatPaneId,
    turnId: ChatTurnId,
    assistantMessageId: string,
    completionDigest: string,
  ): void {
    const countValue: unknown = this.#database.query(`
      SELECT COUNT(*) AS count FROM chat_assistant_item_receipts
      WHERE pane_id = ?1 AND turn_id = ?2
    `).get(paneId, turnId);
    if (countRowSchema.parse(countValue).count >= CHAT_MAX_ASSISTANT_ITEMS_PER_TURN) {
      this.#taintAssistantItem(paneId, turnId);
      throw new ChatPaneStoreError(
        "limit",
        "The assistant item count exceeded its safe limit.",
      );
    }
    this.#database.query(`
      INSERT INTO chat_assistant_item_receipts(
        pane_id, turn_id, assistant_item_id, completion_sha256
      ) VALUES (?1, ?2, ?3, ?4)
    `).run(paneId, turnId, assistantMessageId, completionDigest);
  }

  #appendHistory(
    paneId: ChatPaneId,
    role: ChatHistoryItem["role"],
    text: string,
    createdAt: string,
  ): void {
    const sequenceValue: unknown = this.#database.query(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
      FROM chat_pane_history WHERE pane_id = ?1
    `).get(paneId);
    const { sequence } = sequenceRowSchema.parse(sequenceValue);
    const utf8Bytes = utf8ByteLength(text);
    this.#database.query(`
      INSERT INTO chat_pane_history(pane_id, sequence, role, text, utf8_bytes, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    `).run(paneId, sequence, role, text, utf8Bytes, createdAt);
  }

  #enforceHistoryBounds(paneId: ChatPaneId): void {
    while (this.#historyBytes(paneId) > CHAT_MAX_HISTORY_UTF8_BYTES_PER_PANE) {
      if (!this.#evictOldestHistory("WHERE pane_id = ?1", [paneId])) break;
    }
    while (this.#totalHistoryBytes() > CHAT_MAX_HISTORY_UTF8_BYTES_TOTAL) {
      if (!this.#evictOldestHistory("", [])) break;
    }
  }

  #evictOldestHistory(where: string, parameters: readonly string[]): boolean {
    const value: unknown = this.#database.query(`
      SELECT pane_id, sequence
      FROM chat_pane_history
      ${where}
      ORDER BY created_at, pane_id, sequence
      LIMIT 1
    `).get(...parameters);
    const parsed = z.object({
      pane_id: chatPaneIdSchema,
      sequence: z.number().int().positive().safe(),
    }).strict().nullable().parse(value);
    if (parsed === null) return false;
    this.#database.query(`
      DELETE FROM chat_pane_history WHERE pane_id = ?1 AND sequence = ?2
    `).run(parsed.pane_id, parsed.sequence);
    this.#database.query(`
      UPDATE chat_panes SET history_truncated = 1 WHERE pane_id = ?1
    `).run(parsed.pane_id);
    return true;
  }

  #historyBytes(paneId: ChatPaneId): number {
    const value: unknown = this.#database.query(`
      SELECT COALESCE(SUM(utf8_bytes), 0) AS bytes
      FROM chat_pane_history WHERE pane_id = ?1
    `).get(paneId);
    return bytesRowSchema.parse(value).bytes;
  }

  #totalHistoryBytes(): number {
    const value: unknown = this.#database.query(`
      SELECT COALESCE(SUM(utf8_bytes), 0) AS bytes FROM chat_pane_history
    `).get();
    return bytesRowSchema.parse(value).bytes;
  }

  #pruneReceipts(paneId: ChatPaneId): void {
    this.#database.query(`
      DELETE FROM chat_turn_receipts
      WHERE pane_id = ?1 AND turn_id IN (
        SELECT turn_id FROM chat_turn_receipts
        WHERE pane_id = ?1
        ORDER BY created_at DESC, turn_id DESC
        LIMIT -1 OFFSET ?2
      )
    `).run(paneId, CHAT_MAX_TURN_RECEIPTS_PER_PANE);
  }

  #requireRevision(paneId: ChatPaneId, expectedRevision: number): ChatPanePrivateRecord {
    const pane = this.require(paneId);
    if (pane.projection.revision !== expectedRevision) throw staleRevision();
    return pane;
  }

  #requireActiveTurn(paneId: ChatPaneId, turnId: ChatTurnId): ChatPanePrivateRecord {
    const pane = this.require(chatPaneIdSchema.parse(paneId));
    if (pane.projection.turn?.id !== chatTurnIdSchema.parse(turnId) || !isActive(pane.projection)) {
      throw new ChatPaneStoreError("invalid_state", "The chat turn is no longer active.");
    }
    return pane;
  }

  #parseRow(value: unknown): PaneRow {
    try {
      return paneRowSchema.parse(value);
    } catch {
      throw new ChatPaneStoreError("corrupt_state", "Stored chat pane state is invalid.");
    }
  }

  #routingClassification(
    paneId: ChatPaneId,
    chatTurnId: ChatTurnId,
    prompt: string,
    now: Date,
  ): RootTurnRoutingClassificationAdmissionV1 {
    const prior = this.#rootTurnRouting.readLatestTurnRouting(paneId);
    const routing = classifyRootTurnRoutingV1({
      prompt,
      priorRouting: prior === null
        ? null
        : {
            policyVersion: prior.policyVersion,
            classificationReason: prior.classificationReason,
            workClass: prior.workClass,
            requestedProfile: prior.requestedProfile,
            selectedProfile: prior.selectedProfile,
            profileFallbackReason: prior.profileFallbackReason,
            requestedServiceTier: prior.requestedServiceTier,
            selectedServiceTier: prior.selectedServiceTier,
            serviceTierFallbackReason: prior.serviceTierFallbackReason,
          },
    });
    return {
      paneId,
      chatTurnId,
      policyVersion: routing.policyVersion,
      classificationReason: routing.classificationReason,
      workClass: routing.workClass,
      requestedProfile: routing.requestedProfile,
      requestedServiceTier: routing.requestedServiceTier,
      now,
    };
  }

  #livePaneRows(): readonly PaneRow[] {
    const values: unknown[] = this.#database.query(`
      ${paneWithActiveRoutingSelect()}
      WHERE pane.archived_at IS NULL
      ORDER BY pane.display_order, pane.pane_id
    `).all();
    if (values.length > CHAT_MAX_PANES) {
      throw new ChatPaneStoreError("corrupt_state", "Stored chat pane count exceeded its limit.");
    }
    const rows = values.map((value) => this.#parseRow(value));
    if (rows.some((row, index) => row.display_order !== index)) {
      throw new ChatPaneStoreError("corrupt_state", "Stored chat pane order is invalid.");
    }
    return rows;
  }

  #privateRecord(row: PaneRow): ChatPanePrivateRecord {
    const projection = this.#projection(row);
    const visited = parseJson(row.visited_account_ids_json, visitedAccountsSchema);
    if (utf8ByteLength(row.assistant_item_stream_text) !== row.assistant_item_stream_utf8_bytes) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "Stored assistant reconciliation byte count drifted.",
      );
    }
    return {
      projection,
      binding: row.provider_account_profile_id === null ||
          row.provider_thread_id === null ||
          row.provider_restart_thread_id === null
        ? null
        : {
            accountProfileId: row.provider_account_profile_id,
            threadId: row.provider_thread_id,
            restartThreadId: row.provider_restart_thread_id,
          },
      providerTurnId: row.active_provider_turn_id,
      activePrompt: row.active_prompt,
      visitedAccountProfileIds: visited,
      historyTruncated: row.history_truncated === 1,
      assistantItem: row.assistant_item_id === null
        ? null
        : {
            id: row.assistant_item_id,
            streamText: row.assistant_item_stream_text,
            overflowed: row.assistant_item_stream_overflow === 1,
            verified: row.assistant_item_verified === 1,
          },
      activeTurnPoisoned: row.active_turn_poisoned === 1,
    };
  }

  #projection(row: PaneRow): ChatPaneProjection {
    const responseTail = chatResponseMarkdownSchema.parse({
      tail: row.response_tail,
      totalUtf8Bytes: row.response_total_utf8_bytes,
      truncatedPrefix: utf8ByteLength(row.response_tail) < row.response_total_utf8_bytes,
    });
    const reasoningTail = chatReasoningSummarySchema.parse({
      tail: row.reasoning_tail,
      totalUtf8Bytes: row.reasoning_total_utf8_bytes,
      truncatedPrefix: utf8ByteLength(row.reasoning_tail) < row.reasoning_total_utf8_bytes,
    });
    const tools = parseJson(row.tools_json, toolsSchema);
    const attention: ChatAttention | null = row.attention_code === null
      ? null
      : {
          code: row.attention_code,
          message: row.attention_message ?? corrupt("Chat attention message is missing."),
          retryable: row.attention_retryable === 1,
        };
    const routing = row.routing_policy_version === null
      ? null
      : chatRootTurnRoutingProjectionSchema.parse({
          policyVersion: row.routing_policy_version,
          classificationReason: row.routing_classification_reason,
          workClass: row.routing_work_class,
          requestedProfile: row.routing_requested_profile,
          selectedProfile: row.routing_selected_profile,
          profileFallbackReason: row.routing_profile_fallback_reason,
          requestedServiceTier: row.routing_requested_service_tier,
          selectedServiceTier: row.routing_selected_service_tier,
          serviceTierFallbackReason:
            row.routing_service_tier_fallback_reason,
        });
    const turn = row.active_turn_id === null
      ? null
      : {
          id: row.active_turn_id,
          status: row.turn_status ?? corrupt("Chat turn status is missing."),
          startedAt: row.turn_started_at ?? corrupt("Chat turn start time is missing."),
          completedAt: row.turn_completed_at,
          continuationCount: row.continuation_count,
          responseMarkdown: responseTail,
          reasoningSummary: reasoningTail,
          tools,
          routing,
        };
    try {
      return chatPaneProjectionSchema.parse({
        id: row.pane_id,
        revision: row.revision,
        title: row.title,
        repository: { id: row.repository_id, name: row.repository_name },
        accountProfileId: row.account_profile_id,
        interactionMode: row.interaction_mode,
        state: row.state,
        activity: chatPaneActivitySchema.parse({
          ordinal: row.activity_ordinal,
          kind: row.activity_kind,
        }),
        workspace: row.interaction_mode === "harnessObserver"
          ? null
          : chatWorkspaceProjection(row),
        turn,
        attention,
        recoverablePrompt: row.interaction_mode === "chat" &&
          row.state === "attention" && row.attention_retryable === 1 &&
          row.active_prompt !== null,
      });
    } catch {
      throw new ChatPaneStoreError("corrupt_state", "Stored chat pane projection is invalid.");
    }
  }
}

function paneWithActiveRoutingSelect(): string {
  return `
    SELECT pane.*,
      route.policy_version AS routing_policy_version,
      route.classification_reason AS routing_classification_reason,
      route.work_class AS routing_work_class,
      route.requested_profile AS routing_requested_profile,
      route.selected_profile AS routing_selected_profile,
      route.profile_fallback_reason AS routing_profile_fallback_reason,
      route.requested_service_tier AS routing_requested_service_tier,
      route.selected_service_tier AS routing_selected_service_tier,
      route.service_tier_fallback_reason
        AS routing_service_tier_fallback_reason
    FROM chat_panes AS pane
    LEFT JOIN harness_root_turn_routing_receipts AS route
      ON route.pane_id = pane.pane_id
      AND route.chat_turn_id = pane.active_turn_id
  `;
}

function chatWorkspaceProjection(row: PaneRow): NonNullable<ChatPaneProjection["workspace"]> {
  const recoveryKind = row.workspace_recovery_reason === null
    ? undefined
    : ({
        legacy_unbound: "legacyUnbound",
        capacity_unavailable: "capacityUnavailable",
        insufficient_disk: "insufficientDisk",
        base_mismatch: "baseMismatch",
        binding_mismatch: "bindingMismatch",
        branch_without_lane: "branchWithoutLane",
        checkout_mismatch: "checkoutMismatch",
        dirty_checkout: "dirtyCheckout",
        invalid_manifest: "invalidManifest",
        manifest_missing: "manifestMissing",
        path_escape: "pathEscape",
        repository_mismatch: "repositoryMismatch",
        provision_interrupted: "provisionInterrupted",
        lane_missing: "laneMissing",
        unknown: "unknown",
      } as const satisfies Record<
        NonNullable<PaneRow["workspace_recovery_reason"]>,
        NonNullable<ChatPaneProjection["workspace"]>["recoveryKind"]
      >)[row.workspace_recovery_reason];
  const states = {
    preparing: "preparing",
    waiting_capacity: "waitingCapacity",
    ready: "ready",
    preserved: "preserved",
    recovery_required: "recoveryRequired",
  } as const satisfies Record<
    PaneRow["workspace_state"],
    NonNullable<ChatPaneProjection["workspace"]>["state"]
  >;
  return {
    mode: row.workspace_mode === "managed_worktree"
      ? "managedWorktree"
      : "legacyUnbound",
    state: states[row.workspace_state],
    revision: row.workspace_revision,
    recoveryKind: recoveryKind ?? null,
  };
}

function ordinaryWorkspace(
  pane: ChatPaneProjection,
): NonNullable<ChatPaneProjection["workspace"]> {
  if (pane.interactionMode !== "chat" || pane.workspace === null) {
    throw new ChatPaneStoreError(
      "corrupt_state",
      "An ordinary chat pane lost its pathless workspace state.",
    );
  }
  return pane.workspace;
}

function parseJson<T>(value: string, schema: Readonly<{ parse(input: unknown): T }>): T {
  try {
    return schema.parse(JSON.parse(value) as unknown);
  } catch {
    throw new ChatPaneStoreError("corrupt_state", "Stored chat JSON state is invalid.");
  }
}

function boundedTitle(value: string): string {
  const title = boundedCharacters(value.trim(), 160);
  if (title.length === 0 || title.includes("\0")) {
    throw new ChatPaneStoreError("conflict", "Chat pane titles must contain visible text.");
  }
  return title;
}

/** Stable renderer identity for one durable harness actor observer. */
export function harnessObserverPaneId(actorId: string): ChatPaneId {
  const parsedActorId = harnessActorIdSchema.parse(actorId);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(LEGACY_OPRTE_HARNESS_OBSERVER_PANE_DOMAIN);
  hasher.update(parsedActorId);
  return chatPaneIdSchema.parse(`pane_${hasher.digest("hex").slice(0, 40)}`);
}

function attachedHarnessSessionMatches(
  existing: ChatPanePrivateRecord,
  expected: Readonly<{
    repositoryId: ChatRepository["id"];
    repositoryName: string;
    accountProfileId: ChatAccountProfileId;
    threadId: string;
    restartThreadId: string;
    title: string;
  }>,
): boolean {
  const pane = existing.projection;
  return pane.interactionMode === "harnessObserver" &&
    pane.revision === 1 &&
    pane.title === expected.title &&
    pane.repository.id === expected.repositoryId &&
    pane.repository.name === expected.repositoryName &&
    pane.accountProfileId === expected.accountProfileId &&
    pane.state === "ready" &&
    pane.activity.ordinal === 0 &&
    pane.activity.kind === "idle" &&
    pane.turn === null &&
    pane.attention === null &&
    pane.harness === null &&
    existing.binding?.accountProfileId === expected.accountProfileId &&
    existing.binding.threadId === expected.threadId &&
    existing.binding.restartThreadId === expected.restartThreadId &&
    existing.providerTurnId === null &&
    existing.activePrompt === null &&
    existing.visitedAccountProfileIds.length === 0 &&
    !existing.historyTruncated &&
    existing.assistantItem === null &&
    !existing.activeTurnPoisoned;
}

function validateRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ChatPaneStoreError("conflict", "Chat pane revision is invalid.");
  }
}

function staleRevision(): ChatPaneStoreError {
  return new ChatPaneStoreError(
    "revision_conflict",
    "This chat pane changed. Try again with its latest revision.",
  );
}

function sqliteConflict(error: unknown, message: string): ChatPaneStoreError {
  if (error instanceof ChatPaneStoreError) return error;
  return new ChatPaneStoreError("conflict", message);
}

function isActive(pane: ChatPaneProjection): boolean {
  return pane.state === "starting" || pane.state === "streaming" || pane.state === "continuing";
}

function completeAllTools(
  tools: readonly ChatToolProjection[],
): readonly ChatToolProjection[] {
  return tools.map((tool) => tool.status === "completed"
    ? tool
    : { ...tool, status: "completed" as const });
}

function ownedToolId(
  paneId: ChatPaneId,
  turnId: ChatTurnId,
  index: number,
): ChatToolProjection["id"] {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(LEGACY_OPRTE_CHAT_TOOL_DOMAIN);
  hasher.update(paneId);
  hasher.update("\0");
  hasher.update(turnId);
  hasher.update("\0");
  hasher.update(String(index));
  return `chattool_${hasher.digest("hex").slice(0, 32)}`;
}

function assistantCompletionDigest(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(LEGACY_OPRTE_CHAT_ASSISTANT_COMPLETION_DOMAIN);
  hasher.update(text);
  return hasher.digest("hex");
}

function boundedHistorySuffix(
  values: readonly ChatHistoryItem[],
  maximumBytes: number,
  maximumItems: number,
): Readonly<{ readonly values: readonly ChatHistoryItem[]; readonly truncated: boolean }> {
  const retained: ChatHistoryItem[] = [];
  let retainedBytes = 0;
  let truncated = false;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value === undefined) continue;
    let exchange: readonly ChatHistoryItem[];
    if (value.role === "assistant") {
      const prompt = values[index - 1];
      if (prompt?.role !== "user") {
        truncated = true;
        continue;
      }
      exchange = [prompt, value];
      index -= 1;
    } else {
      exchange = [value];
    }
    const exchangeBytes = exchange.reduce(
      (total, item) => total + utf8ByteLength(item.text),
      0,
    );
    if (
      retained.length + exchange.length > maximumItems ||
      retainedBytes + exchangeBytes > maximumBytes
    ) {
      truncated = true;
      break;
    }
    retained.unshift(...exchange);
    retainedBytes += exchangeBytes;
  }
  if (retained.length !== values.length) truncated = true;
  return { values: retained, truncated };
}

function corrupt(message: string): never {
  throw new ChatPaneStoreError("corrupt_state", message);
}

function unreachableTurn(): never {
  throw new ChatPaneStoreError("corrupt_state", "The active chat turn is missing.");
}

function terminalIso(startedAt: string, now: Date): string {
  const parsedStart = isoDateTimeSchema.parse(startedAt);
  const parsedNow = isoDateTimeSchema.parse(now.toISOString());
  return parsedNow >= parsedStart ? parsedNow : parsedStart;
}
