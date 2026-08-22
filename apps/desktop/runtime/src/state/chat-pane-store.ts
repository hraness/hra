import type { Database } from "bun:sqlite";
import { z } from "@hra-internal/schema";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  accountProfileIdSchema,
  chatAttentionCodeSchema,
  chatIsoDateTimeSchema,
  chatMessageIdSchema,
  chatPaneIdSchema,
  chatPaneActivitySchema,
  chatPaneActivityKindSchema,
  chatPaneInteractionModeSchema,
  chatPaneProjectionSchema,
  chatProviderSubagentsProjectionSchema,
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
  type ChatMessageQueueProjection,
  type ChatMessageId,
  type ChatPaneProjection,
  type ChatProviderSubagentsProjection,
  type ChatToolCategory,
  type ChatToolProjection,
} from "../../../contracts/runtime";
import {
  CHAT_MESSAGE_MAX_ACTIVE_PER_PANE,
  CHAT_MESSAGE_MAX_UTF8_BYTES_PER_PANE,
  CHAT_MESSAGE_MAX_UTF8_BYTES_TOTAL,
  chatMessageLedgerRowSchema,
  chatMessageQueueMetadataRowSchema,
  SQLiteChatMessageAttachmentAuthority,
  parseChatMessageContent,
  parseChatMessageQueueProjection,
  projectQueuePauseReason,
  storeQueuePauseReason,
  type ChatMessageAttachmentAuthority,
  type ChatMessageClaim,
  type ChatMessageClaimInput,
  type ChatMessageClaimResult,
  type ChatMessageDiscardAmbiguousInput,
  type ChatMessageEditInput,
  type ChatMessageEnqueueAndSteerInput,
  type ChatMessageEnqueueAndSteerResult,
  type ChatMessageEnqueueInput,
  type ChatMessageEnqueueResult,
  type ChatMessageIdempotentEnqueueInput,
  type ChatMessageLedgerRow,
  type ChatMessageQueueMetadataRow,
  type ChatMessageQueuePauseInput,
  type ChatMessageQueueResumeInput,
  type ChatMessageRowCasInput,
  type ChatMessageTransitionInput,
  type StoredChatMessageState,
} from "./chat-message-ledger";
import { operationReceiptKeyByteLength } from "./operation-receipt-key";
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
  chatProviderAttachmentAuthority,
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
  utf8Tail,
  utf8ByteLength,
  utf8Chunks,
} from "../chat/text-bounds";
import {
  RootTurnRoutingSQLiteAuthorityV1,
  type RootTurnRoutingClassificationAdmissionV1,
} from "../harness/root-turn-routing-sqlite-v1";
import {
  CHAT_PANE_NEXT_PALETTE_INDEX_SQL,
  chatPanePaletteIndexSchema,
} from "./chat-pane-palette-schema-v1";
import type { ReasoningSummaryCompletionReceipt } from
  "../sessions/reasoning-summary-accumulator";
import type { ChatAttachmentVault } from "../attachments/contracts";
import {
  ProviderThreadArchiveJournalV57,
  providerThreadArchiveCompleteInventoryDigestV57,
  type AddProviderThreadArchiveCutMemberV57,
  type ProviderThreadArchiveBindingPreimageV57,
  type ProviderThreadArchiveCutMemberSnapshotV57,
  type ProviderThreadArchiveCutSnapshotV57,
  type ProviderThreadArchiveRecoveryInventoryV57,
  type ProviderThreadArchiveTargetSnapshotV57,
  type ProviderThreadArchiveTerminalCleanupV57,
  type ProviderThreadArchiveTerminalCleanupComponentV57,
} from "./provider-thread-archive-journal-v57";
import { ScheduledChatStore } from "./scheduled-chat-store";

const isoDateTimeSchema = chatIsoDateTimeSchema;
const freshProviderContextAttentionMessage =
  "Attachment context from the prior Codex session is quarantined. Choose Start fresh to continue without transferring it.";
const providerIdSchema = z.string().min(1).max(512).refine(
  (value) => !value.includes("\0"),
  "provider identity contains NUL",
);
const providerArchiveMemberIdSchema = z.string().min(18).max(96).regex(
  /^archmember_[A-Za-z0-9_-]+$/u,
);
const providerArchiveTargetIdSchema = z.string().min(18).max(96).regex(
  /^archtarget_[A-Za-z0-9_-]+$/u,
);
const providerArchiveAttemptIdSchema = z.string().min(19).max(96).regex(
  /^archattempt_[A-Za-z0-9_-]+$/u,
);
const providerArchiveCutIdSchema = z.string().min(15).max(96).regex(
  /^archcut_[A-Za-z0-9_-]+$/u,
);
const providerArchiveDigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const assistantItemIdSchema = z.string().min(13).max(96).regex(/^item_[A-Za-z0-9_-]+$/u);
const storedBooleanSchema = z.union([z.literal(0), z.literal(1)]);
const attachmentInputClassRowSchema = z.object({
  kind: z.enum(["image", "file"]),
  state: z.literal("ready"),
}).strict();
const retainedProviderAttachmentBindingRowSchema = z.object({
  binding_id: z.string().min(1).max(128),
  binding_key_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  revision: z.number().int().positive().safe(),
  state: z.enum(["active", "ambiguous"]),
}).strict();
const providerThreadArchiveIntentRowSchema = z.object({
  pane_id: chatPaneIdSchema,
  purpose: z.enum(["start_fresh", "pane_archive"]),
  state: z.enum([
    "prepared",
    "effect_started",
    "ambiguous",
    "succeeded",
    "account_contained",
  ]),
  pane_revision: z.number().int().positive().safe(),
  queue_revision: z.number().int().positive().safe().nullable(),
  account_profile_id: accountProfileIdSchema,
  thread_id: providerIdSchema,
  restart_thread_id: providerIdSchema,
  binding_id: z.string().min(1).max(128).nullable(),
  binding_key_digest: z.string().regex(/^[0-9a-f]{64}$/u).nullable(),
  binding_revision: z.number().int().positive().safe().nullable(),
  generation: z.number().int().positive().safe(),
  generation_contained: storedBooleanSchema,
  generation_containment_receipt: z.string().min(16).max(512).nullable(),
  effect_attempt: z.number().int().nonnegative().safe(),
  containment_receipt: z.string().min(16).max(512).nullable(),
  response_generation: z.number().int().positive().safe().nullable(),
  response_stream_position: z.number().int().nonnegative().safe().nullable(),
  ambiguity_receipt: z.string().min(16).max(512).nullable(),
  reconciliation_disposition: z.enum(["applied", "not_applied"]).nullable(),
  reconciliation_receipt: z.string().min(16).max(512).nullable(),
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
}).strict();
export type ChatProviderThreadArchiveIntent = z.infer<
  typeof providerThreadArchiveIntentRowSchema
>;
export type RetainedProviderAttachmentBindingClassification =
  | Readonly<{ readonly kind: "none" }>
  | Readonly<{
      readonly kind: "exact";
      readonly bindingId: string;
      readonly bindingKeyDigest: string;
      readonly revision: number;
      readonly state: "active" | "ambiguous";
    }>
  | Readonly<{ readonly kind: "orphan" }>;
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
const reasoningReceiptRowSchema = z.object({
  receipt_id: z.string().min(1),
  state: z.enum(["verified", "tainted"]),
  completion_digest: z.string().nullable(),
  completion_generation: z.number().int().positive().safe(),
  completion_stream_position: z.number().int().nonnegative().safe(),
  completion_fact_index: z.number().int().nonnegative().safe(),
  overflowed: storedBooleanSchema,
  repaired_suffix: storedBooleanSchema,
  taint_reason: z.string().nullable(),
  summary_tail: z.string().nullable(),
  summary_total_utf8_bytes: z.number().int().nonnegative().safe().nullable(),
  summary_truncated_prefix: nullableStoredBooleanSchema,
}).strict();

// These domains are durable released identity bytes. Renaming them would
// orphan existing observer panes, tool receipts, and completion receipts.
const LEGACY_OPRTE_HARNESS_OBSERVER_PANE_DOMAIN =
  "oprte-harness-observer-pane-v1\0";
const LEGACY_OPRTE_CHAT_TOOL_DOMAIN = "oprte-chat-tool-v1\0";
const LEGACY_OPRTE_CHAT_ASSISTANT_COMPLETION_DOMAIN =
  "oprte-chat-assistant-completion-v1\0";
// Non-production store consumers may omit the installation key. Their replay
// authority then survives only within this process and fails closed after a
// process restart. The production composition always injects its durable key.
const ephemeralMessageRequestDigestKey = Uint8Array.from(
  randomBytes(operationReceiptKeyByteLength),
);

const paneRowSchema = z.object({
  pane_id: chatPaneIdSchema,
  palette_index: chatPanePaletteIndexSchema,
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
  reasoning_verified_tail: z.string(),
  reasoning_verified_total_utf8_bytes: z.number().int().nonnegative().safe(),
  reasoning_active_item_id: assistantItemIdSchema.nullable(),
  reasoning_proof_tainted: storedBooleanSchema,
  provider_subagents_json: z.string(),
  provider_subagent_overflow_count: z.number().int().min(0).max(120),
  tools_json: z.string(),
  visited_account_ids_json: z.string(),
  attention_code: chatAttentionCodeSchema.nullable(),
  attention_message: z.string().min(1).max(240).nullable(),
  attention_retryable: nullableStoredBooleanSchema,
  history_truncated: storedBooleanSchema,
  provider_history_floor_sequence: z.number().int().nonnegative().safe(),
  provider_context_reset_required: storedBooleanSchema,
  message_queue_revision: z.number().int().positive().safe(),
  next_message_ordinal: z.number().int().positive().safe(),
  message_queue_pause_reason: z.enum([
    "stop",
    "runtime_restart",
    "attention",
    "ambiguous_effect",
  ]).nullable(),
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
const chatMessagePayloadTotalsSchema = z.object({
  active_count: z.number().int().nonnegative().safe(),
  pane_bytes: z.number().int().nonnegative().safe(),
  global_bytes: z.number().int().nonnegative().safe(),
}).strict();
const sequenceRowSchema = z.object({ sequence: z.number().int().positive().safe() }).strict();
const assistantReceiptRowSchema = z.object({
  completion_sha256: z.string().length(64).regex(/^[0-9a-f]+$/u),
}).strict();
const providerArchiveAccountProfileRowSchema = z.object({
  profile_id: accountProfileIdSchema,
  revision: z.number().int().positive().safe(),
  process_generation: z.number().int().nonnegative().safe(),
  removed_at: isoDateTimeSchema.nullable(),
}).strict();
const providerArchiveHarnessOwnershipRowSchema = z.object({
  actor_id: harnessActorIdSchema,
  actor_state: z.literal("active"),
  actor_pane_binding_id: z.string().min(16).max(96),
  actor_pane_binding_revision: z.number().int().positive().safe(),
  incarnation_id: z.string().min(16).max(96),
  incarnation_account_profile_id: accountProfileIdSchema,
  incarnation_admission_generation: z.number().int().positive().safe(),
  incarnation_provider_thread_id: providerIdSchema,
  incarnation_state: z.enum(["idle", "running"]),
  session_account_profile_id: accountProfileIdSchema,
  session_actor_id: harnessActorIdSchema,
  session_admission_generation: z.number().int().positive().safe(),
  session_live_generation: z.number().int().positive().safe(),
  session_provider_thread_id: providerIdSchema,
  session_revision: z.number().int().positive().safe(),
  workspace_binding_id: z.string().min(16).max(96),
  workspace_binding_revision: z.number().int().positive().safe(),
}).strict();
const providerArchiveSealedCutAuthorityRowSchema = z.object({
  member_count: z.number().int().nonnegative().max(CHAT_MAX_PANES),
  inventory_digest: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();
const providerArchiveFrozenIdentityRowSchema = z.object({
  thread_id: providerIdSchema,
  restart_thread_id: providerIdSchema,
}).strict();
const providerArchiveMemberAuthorityRowSchema = z.object({
  member_id: providerArchiveMemberIdSchema,
  cut_id: z.string().min(15).max(96),
  pane_id: chatPaneIdSchema,
  pane_revision: z.number().int().positive().safe(),
  pane_cas_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  thread_id: providerIdSchema,
  restart_thread_id: providerIdSchema,
  role: z.enum(["target", "sibling"]),
  target_id: z.string().min(18).max(96).nullable(),
  attempt_id: z.string().min(19).max(96).nullable(),
  target_attempt_ordinal: z.number().int().positive().safe().nullable(),
  action: z.enum([
    "preserved_target",
    "contain_generation_context",
    "detach_binding_only",
  ]),
  binding_id: z.string().min(1).max(128).nullable(),
  binding_key_digest: z.string().regex(/^[0-9a-f]{64}$/u).nullable(),
  binding_revision: z.number().int().positive().safe().nullable(),
  identity_evidence_digest: providerArchiveDigestSchema,
  identity_revision_digest: providerArchiveDigestSchema,
  state: z.enum(["pending", "settled"]),
  settlement_evidence_digest: z.string().regex(/^[0-9a-f]{64}$/u).nullable(),
  settlement_revision_digest: z.string().regex(/^[0-9a-f]{64}$/u).nullable(),
  settled_at: isoDateTimeSchema.nullable(),
}).strict().superRefine((row, context) => {
  const targetColumns = [
    row.target_id,
    row.attempt_id,
    row.target_attempt_ordinal,
  ];
  const bindingColumns = [
    row.binding_id,
    row.binding_key_digest,
    row.binding_revision,
  ];
  if (
    targetColumns.some((value) => value === null) !==
      targetColumns.every((value) => value === null) ||
    bindingColumns.some((value) => value === null) !==
      bindingColumns.every((value) => value === null)
  ) {
    context.addIssue({
      code: "custom",
      message: "v57 member authority is only partially populated",
    });
  }
  const settlementColumns = [
    row.settlement_evidence_digest,
    row.settlement_revision_digest,
    row.settled_at,
  ];
  if (
    (row.state === "pending" && settlementColumns.some((value) => value !== null)) ||
    (row.state === "settled" && settlementColumns.some((value) => value === null))
  ) {
    context.addIssue({
      code: "custom",
      message: "v57 member settlement authority is incomplete",
    });
  }
});
const providerArchiveRoutingTurnRowSchema = z.object({
  chat_turn_id: chatTurnIdSchema,
}).strict();
const providerArchiveLocalContainmentRowSchema = z.object({
  unresolved_root_routes: z.number().int().nonnegative().safe(),
  unresolved_message_effects: z.number().int().nonnegative().safe(),
  retained_turn_leases: z.number().int().nonnegative().safe(),
}).strict();
const providerArchiveTargetAuthorityRowSchema = z.object({
  target_id: providerArchiveTargetIdSchema,
  pane_id: chatPaneIdSchema,
  purpose: z.enum(["start_fresh", "pane_archive"]),
  pane_revision: z.number().int().positive().safe(),
  queue_revision: z.number().int().positive().safe().nullable(),
  pane_cas_digest: providerArchiveDigestSchema,
  queue_cas_digest: providerArchiveDigestSchema.nullable(),
  account_profile_id: accountProfileIdSchema,
  account_profile_revision: z.number().int().positive().safe(),
  thread_id: providerIdSchema,
  restart_thread_id: providerIdSchema,
  binding_id: z.string().min(1).max(128).nullable(),
  binding_key_digest: providerArchiveDigestSchema.nullable(),
  binding_revision: z.number().int().positive().safe().nullable(),
  current_attempt_id: providerArchiveAttemptIdSchema,
  current_attempt_ordinal: z.number().int().positive().safe(),
  status: z.enum(["open", "account_contained", "committed"]),
  identity_hmac: providerArchiveDigestSchema,
  pointer_hmac: providerArchiveDigestSchema,
  commit_evidence_digest: providerArchiveDigestSchema.nullable(),
  commit_revision_digest: providerArchiveDigestSchema.nullable(),
  commit_hmac: providerArchiveDigestSchema.nullable(),
  committed_at: isoDateTimeSchema.nullable(),
}).strict().superRefine((row, context) => {
  const commitColumns = [
    row.commit_evidence_digest,
    row.commit_revision_digest,
    row.commit_hmac,
    row.committed_at,
  ];
  if (
    (row.status === "committed" && commitColumns.some((value) => value === null))
    || (row.status !== "committed" &&
      commitColumns.some((value) => value !== null))
  ) {
    context.addIssue({
      code: "custom",
      message: "v57 target commit authority is incomplete",
    });
  }
});
const providerArchiveAttemptAuthorityRowSchema = z.object({
  attempt_id: providerArchiveAttemptIdSchema,
  target_id: providerArchiveTargetIdSchema,
  ordinal: z.number().int().positive().safe(),
  generation: z.number().int().positive().safe(),
  account_profile_revision: z.number().int().positive().safe(),
  predecessor_attempt_id: providerArchiveAttemptIdSchema.nullable(),
  cut_id: providerArchiveCutIdSchema.nullable(),
  state: z.enum([
    "prepared",
    "effect_started",
    "ambiguous",
    "direct_applied",
    "reconciled_applied",
    "reconciled_not_applied",
    "abandoned_pre_effect",
    "account_contained",
  ]),
  request_evidence_digest: providerArchiveDigestSchema,
  request_revision_digest: providerArchiveDigestSchema,
  identity_hmac: providerArchiveDigestSchema,
  cut_binding_hmac: providerArchiveDigestSchema.nullable(),
  effect_evidence_digest: providerArchiveDigestSchema.nullable(),
  effect_revision_digest: providerArchiveDigestSchema.nullable(),
  effect_hmac: providerArchiveDigestSchema.nullable(),
  ambiguity_evidence_digest: providerArchiveDigestSchema.nullable(),
  ambiguity_revision_digest: providerArchiveDigestSchema.nullable(),
  ambiguity_hmac: providerArchiveDigestSchema.nullable(),
  outcome_evidence_digest: providerArchiveDigestSchema.nullable(),
  outcome_revision_digest: providerArchiveDigestSchema.nullable(),
  response_generation: z.number().int().positive().safe().nullable(),
  response_stream_position: z.number().int().nonnegative().safe().nullable(),
  outcome_hmac: providerArchiveDigestSchema.nullable(),
}).strict();
const providerArchiveCutAuthorityRowSchema = z.object({
  cut_id: providerArchiveCutIdSchema,
  account_profile_id: accountProfileIdSchema,
  account_profile_revision: z.number().int().positive().safe(),
  source_generation: z.number().int().positive().safe(),
  cause: z.enum(["ambiguous_response", "lost_response", "account_removal"]),
  initiating_attempt_id: providerArchiveAttemptIdSchema.nullable(),
  predecessor_cut_id: providerArchiveCutIdSchema.nullable(),
  state: z.enum([
    "fence_started",
    "fenced",
    "sealed",
    "removal_awaiting_tombstone",
    "contained",
  ]),
  successor_generation: z.number().int().positive().safe().nullable(),
  successor_account_profile_revision:
    z.number().int().positive().safe().nullable(),
  identity_evidence_digest: providerArchiveDigestSchema,
  identity_revision_digest: providerArchiveDigestSchema,
  identity_hmac: providerArchiveDigestSchema,
  fence_hmac: providerArchiveDigestSchema.nullable(),
  member_count: z.number().int().nonnegative().max(CHAT_MAX_PANES).nullable(),
  inventory_digest: providerArchiveDigestSchema.nullable(),
  enumeration_authority_digest: providerArchiveDigestSchema.nullable(),
  seal_revision_digest: providerArchiveDigestSchema.nullable(),
  seal_hmac: providerArchiveDigestSchema.nullable(),
  containment_evidence_digest: providerArchiveDigestSchema.nullable(),
  containment_revision_digest: providerArchiveDigestSchema.nullable(),
  containment_hmac: providerArchiveDigestSchema.nullable(),
}).strict();
const providerArchiveActiveCutFenceRowSchema = z.object({
  cut_id: providerArchiveCutIdSchema,
  account_profile_id: accountProfileIdSchema,
  source_generation: z.number().int().positive().safe(),
  cause: z.enum(["ambiguous_response", "lost_response", "account_removal"]),
  state: z.enum([
    "fence_started",
    "fenced",
    "sealed",
    "removal_awaiting_tombstone",
  ]),
}).strict();

const CHAT_MAX_ASSISTANT_ITEMS_PER_TURN = 128;
// A 256 KiB stream window can require one extra 4 KiB chunk when a Unicode
// code point leaves up to three bytes unused at a chunk boundary.
const CHAT_MAX_STREAM_DELTAS_PER_BATCH = Math.ceil(
  CHAT_MAX_RESPONSE_TAIL_UTF8_BYTES / (CHAT_MAX_DELTA_UTF8_BYTES - 3),
);

type PaneRow = z.infer<typeof paneRowSchema>;

export type ChatProviderThreadArchiveTargetPreparationV57Input = Readonly<{
  readonly targetId: string;
  readonly attemptId: string;
  readonly paneId: ChatPaneId;
  readonly expectedRevision: number;
  readonly generation: number;
  readonly now: Date;
}> & (
  | Readonly<{
      readonly purpose: "pane_archive";
      readonly expectedQueueRevision: null;
    }>
  | Readonly<{
      readonly purpose: "start_fresh";
      readonly expectedQueueRevision: number;
    }>
);

export interface ChatProviderThreadArchiveSourceOwnershipV57 {
  readonly accountProfileId: ChatAccountProfileId;
  readonly sourceGeneration: number;
  readonly members: readonly AddProviderThreadArchiveCutMemberV57[];
  readonly expectedMemberCount: number;
  readonly expectedInventoryDigest: string;
  readonly enumerationAuthorityDigest: string;
}

export type ChatProviderThreadArchiveMemberSettlementV57Input = Readonly<{
  readonly memberId: string;
  readonly now: Date;
}>;

export interface ChatProviderThreadArchiveMemberSettlementV57Result {
  readonly member: ProviderThreadArchiveCutMemberSnapshotV57;
  readonly pane: ChatPaneProjection | null;
}

export interface ChatProviderThreadArchiveLostResponseCutV57Result {
  readonly cut: ProviderThreadArchiveCutSnapshotV57;
  readonly affectedTargetIds: readonly string[];
}

export type ChatProviderThreadArchiveReconciliationV57 =
  | Readonly<{
      readonly disposition: "applied";
      readonly responseGeneration: number;
      readonly responseStreamPosition: number;
      readonly providerContainmentReceipt: string;
    }>
  | Readonly<{
      readonly disposition: "not_applied";
      readonly providerReconciliationReceipt: string;
    }>
  | Readonly<{ readonly disposition: "ambiguous" }>;

export type ChatProviderThreadArchiveFinalizationV57Result =
  | Readonly<{
      readonly kind: "pane_archive";
      readonly removed: ChatPaneRemoveResult;
      readonly containmentReceipt: string;
    }>
  | Readonly<{
      readonly kind: "start_fresh";
      readonly pane: ChatPaneProjection;
      readonly queue: ChatMessageQueueProjection;
      readonly containmentReceipt: string;
    }>;

export interface ChatProviderThreadArchiveTerminalTargetV57 {
  readonly targetId: string;
  readonly paneId: ChatPaneId;
}

export interface ChatProviderThreadArchiveTerminalFinalizationReplayV57 {
  readonly targetId: string;
  readonly paneId: ChatPaneId;
  readonly result: ChatProviderThreadArchiveFinalizationV57Result;
}

export interface ChatProviderThreadArchiveTerminalComponentV57 {
  readonly component: ProviderThreadArchiveTerminalCleanupComponentV57;
  readonly targets: readonly ChatProviderThreadArchiveTerminalTargetV57[];
  readonly finalizations:
    readonly ChatProviderThreadArchiveTerminalFinalizationReplayV57[];
}

export interface ChatProviderThreadArchiveStartupSweepV57 {
  readonly cleanup: ProviderThreadArchiveTerminalCleanupV57;
  readonly recoveryInventory: ProviderThreadArchiveRecoveryInventoryV57;
}

type ProviderThreadArchiveOwnershipV57 =
  | Readonly<{
      readonly kind: "ordinary";
      readonly accountProfileId: ChatAccountProfileId;
      readonly generation: number;
      readonly authority: NonNullable<ReturnType<
        RootTurnRoutingSQLiteAuthorityV1["readTurnRouting"]
      >>;
    }>
  | Readonly<{
      readonly kind: "harness";
      readonly accountProfileId: ChatAccountProfileId;
      readonly generation: number;
      readonly authority: z.infer<
        typeof providerArchiveHarnessOwnershipRowSchema
      >;
    }>;

type ProviderThreadArchivePaneAuthorityV57 = Readonly<{
  readonly row: PaneRow;
  readonly binding: ChatThreadBinding;
  readonly retainedBinding: Exclude<
    RetainedProviderAttachmentBindingClassification,
    Readonly<{ readonly kind: "orphan" }>
  >;
  readonly bindingPreimage: ProviderThreadArchiveBindingPreimageV57;
  readonly ownership: ProviderThreadArchiveOwnershipV57;
  readonly queueCasDigest: string;
  readonly paneCasDigest: string;
}>;

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
  readonly reasoningItemId?: string;
  readonly now: Date;
}

export interface ChatReasoningCompletionInput {
  readonly paneId: ChatPaneId;
  readonly turnId: ChatTurnId;
  readonly itemId: string;
  readonly receipt: ReasoningSummaryCompletionReceipt;
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
  readonly #messageAttachmentAuthority: ChatMessageAttachmentAuthority;
  readonly #paneArchiveAuthority: Pick<
    ChatAttachmentVault,
    | "assertPaneArchiveCompatible"
    | "assertProviderThreadArchiveV57Compatible"
    | "assertProviderThreadArchiveTerminalPostimagesV57"
    | "preparePaneArchiveInTransaction"
    | "markPaneArchivedInTransaction"
    | "releaseProviderBindingAfterResumeContainedInTransaction"
  > | null;
  readonly #messageRequestDigestKey: Uint8Array;
  readonly #providerThreadArchiveJournalV57: ProviderThreadArchiveJournalV57;
  readonly #scheduledChats: ScheduledChatStore;

  constructor(
    database: Database,
    options: Readonly<{
      messageAttachmentAuthority?: ChatMessageAttachmentAuthority;
      messageRequestDigestKey?: Uint8Array;
      paneArchiveAuthority?: Pick<
        ChatAttachmentVault,
        | "assertPaneArchiveCompatible"
        | "assertProviderThreadArchiveV57Compatible"
        | "assertProviderThreadArchiveTerminalPostimagesV57"
        | "preparePaneArchiveInTransaction"
        | "markPaneArchivedInTransaction"
        | "releaseProviderBindingAfterResumeContainedInTransaction"
      >;
      scheduledChatStore?: ScheduledChatStore;
    }> = {},
  ) {
    this.#database = database;
    this.#rootTurnRouting = new RootTurnRoutingSQLiteAuthorityV1(database);
    this.#messageAttachmentAuthority = options.messageAttachmentAuthority ??
      new SQLiteChatMessageAttachmentAuthority(database);
    this.#paneArchiveAuthority = options.paneArchiveAuthority ?? null;
    const digestKey = options.messageRequestDigestKey ?? ephemeralMessageRequestDigestKey;
    if (digestKey.byteLength !== operationReceiptKeyByteLength) {
      throw new Error("Chat message request-digest key has an invalid length.");
    }
    this.#messageRequestDigestKey = Uint8Array.from(digestKey);
    this.#providerThreadArchiveJournalV57 = new ProviderThreadArchiveJournalV57(
      database,
      this.#messageRequestDigestKey,
    );
    this.#scheduledChats = options.scheduledChatStore ?? new ScheduledChatStore(database);
    this.#scheduledChats.bindPaneMutationAuthority({
      assertPaneMutationAllowed: (paneId) => {
        this.assertProviderThreadArchivePaneMutationAllowedV57(paneId);
      },
      cancelUnclaimedScheduledMessage: (input) =>
        this.cancelUnclaimedScheduledMessage(input),
      settleScheduledClearQueue: (input) =>
        this.settleScheduledClearQueue(input),
    });
  }

  list(): readonly ChatPaneProjection[] {
    return this.#database.transaction(() =>
      this.#livePaneRows().map((row) => this.#projection(row)))();
  }

  get(paneId: ChatPaneId): ChatPanePrivateRecord | null {
    const id = chatPaneIdSchema.parse(paneId);
    return this.#database.transaction(() => {
      const value: unknown = this.#database.query(`
        ${paneWithActiveRoutingSelect()}
        WHERE pane.pane_id = ?1 AND pane.archived_at IS NULL
      `).get(id);
      return value === null ? null : this.#privateRecord(this.#parseRow(value));
    })();
  }

  require(paneId: ChatPaneId): ChatPanePrivateRecord {
    const pane = this.get(paneId);
    if (pane === null) throw new ChatPaneStoreError("not_found", "This chat pane no longer exists.");
    return pane;
  }

  /** Complete, FIFO-ordered renderer projection of the currently queued rows. */
  messageQueue(paneId: ChatPaneId): ChatMessageQueueProjection {
    return this.#database.transaction(() => {
      const metadata = this.#requireMessageQueueMetadata(paneId);
      return this.#messageQueueProjection(metadata);
    })();
  }

  cancelUnclaimedScheduledMessage(input: Readonly<{
    paneId: ChatPaneId;
    messageId: ChatMessageId;
    now: Date;
  }>): boolean {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const messageId = chatMessageIdSchema.parse(input.messageId);
    const now = isoDateTimeSchema.parse(input.now.toISOString());
    return this.#database.transaction(() => {
      this.#assertNoPendingProviderThreadArchiveAuthorityV57(paneId);
      const row = this.#messageRow(messageId);
      if (row === null || row.pane_id !== paneId || row.state !== "queued") {
        return false;
      }
      const cancelled = this.#database.query(`
        UPDATE chat_message_ledger SET
          state = 'cancelled', revision = revision + 1,
          terminal_at = ?3, updated_at = ?3
        WHERE pane_id = ?1 AND message_id = ?2 AND state = 'queued'
      `).run(paneId, messageId, now);
      if (cancelled.changes !== 1) return false;
      this.#clearMessageAttachments(paneId, messageId, now);
      const advanced = this.#database.query(`
        UPDATE chat_panes SET
          message_queue_revision = message_queue_revision + 1,
          updated_at = ?2
        WHERE pane_id = ?1 AND archived_at IS NULL
      `).run(paneId, now);
      if (advanced.changes < 1) {
        throw new ChatPaneStoreError(
          "conflict",
          "The scheduled message pane changed before cancellation.",
        );
      }
      return true;
    })();
  }

  settleScheduledClearQueue(input: Readonly<{
    paneId: ChatPaneId;
    now: Date;
  }>): boolean {
    const queue = this.messageQueue(input.paneId);
    if (
      queue.messages.length > 0
      || queue.blockedMessage !== null
      || (queue.pauseReason !== "stop"
        && queue.pauseReason !== "runtimeRestart"
        && queue.pauseReason !== "attention")
    ) return false;
    this.resumeMessageQueue({
      paneId: input.paneId,
      expectedQueueRevision: queue.revision,
      now: input.now,
    });
    return true;
  }

  enqueueMessage(input: ChatMessageEnqueueInput): ChatMessageQueueProjection {
    return this.enqueueMessageIdempotently({
      ...input,
      delivery: { kind: "queue" },
    }).queue;
  }

  enqueueMessageIdempotently(
    input: ChatMessageIdempotentEnqueueInput,
  ): ChatMessageEnqueueResult {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const messageId = chatMessageIdSchema.parse(input.messageId);
    validateRevision(input.expectedQueueRevision);
    const content = parseChatMessageContent(input.content);
    const requestDeliveryKind = input.delivery.kind === "queue"
      ? "queue"
      : "steer_head";
    const requestSteerTurnId = input.delivery.kind === "queue"
      ? null
      : chatTurnIdSchema.parse(input.delivery.expectedTurnId);
    const requestDeliveryOutcome = input.delivery.kind === "queue"
      ? "accepted"
      : "pending";
    const requestFingerprintHmac = this.#messageRequestFingerprint({
      paneId,
      messageId,
      content,
      delivery: input.delivery.kind === "queue"
        ? { kind: "queue" }
        : { kind: "steerHead", expectedTurnId: requestSteerTurnId! },
    });
    const now = isoDateTimeSchema.parse(input.now.toISOString());
    return this.#database.transaction(() => {
      this.#assertNoPendingProviderThreadArchiveIntent(paneId);
      const metadata = this.#requireMessageQueueMetadata(paneId);
      const existing = this.#messageRow(messageId);
      if (existing !== null) {
        if (
          existing.pane_id === paneId &&
          input.expectedQueueRevision <= metadata.message_queue_revision &&
          this.#messageRequestMatches(existing, requestFingerprintHmac, {
            requestDeliveryKind,
            requestSteerTurnId,
          })
        ) {
          return {
            disposition: replayDisposition(existing),
            queue: this.#messageQueueProjection(metadata),
          };
        }
        throw new ChatPaneStoreError(
          "conflict",
          "This app-owned chat message ID was already used.",
        );
      }
      if (metadata.message_queue_revision !== input.expectedQueueRevision) {
        throw staleQueueRevision();
      }
      const textBytes = utf8ByteLength(content.text);
      this.#assertMessagePayloadCapacity(paneId, {
        addedRows: 1,
        replacedBytes: 0,
        nextBytes: textBytes,
      });
      try {
        this.#database.query(`
          INSERT INTO chat_message_ledger (
            message_id, pane_id, ordinal, revision,
            message_text, message_utf8_bytes,
            request_delivery_kind, request_steer_turn_id,
            request_fingerprint_hmac, request_delivery_outcome,
            state, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, ?8, ?9, 'queued', ?10, ?10
          )
        `).run(
          messageId,
          paneId,
          metadata.next_message_ordinal,
          content.text,
          textBytes,
          requestDeliveryKind,
          requestSteerTurnId,
          requestFingerprintHmac,
          requestDeliveryOutcome,
          now,
        );
        this.#bindReadyMessageAttachments(paneId, messageId, content, now);
        const advanced = this.#database.query(`
          UPDATE chat_panes SET
            message_queue_revision = message_queue_revision + 1,
            next_message_ordinal = next_message_ordinal + 1,
            updated_at = ?3
          WHERE pane_id = ?1 AND message_queue_revision = ?2
            AND archived_at IS NULL
        `).run(paneId, input.expectedQueueRevision, now);
        if (advanced.changes !== 1) throw staleQueueRevision();
      } catch (error: unknown) {
        throw sqliteMessageConflict(error, "The chat message could not be queued.");
      }
      return {
        disposition: "applied" as const,
        queue: this.messageQueue(paneId),
      };
    })();
  }

  /**
   * Atomically queues a composer message, then prepares that same row for
   * steering only if it is now the FIFO head of the exact active turn. A
   * paused queue, changed turn fence, or older head aborts the outer
   * transaction so neither the row nor its draft attachment conversion lands.
   */
  enqueueMessageAndPrepareSteer(
    input: ChatMessageEnqueueAndSteerInput,
  ): ChatMessageEnqueueAndSteerResult {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const messageId = chatMessageIdSchema.parse(input.messageId);
    const turnId = chatTurnIdSchema.parse(input.turnId);
    return this.#database.transaction(() => {
      const enqueued = this.enqueueMessageIdempotently({
        ...input,
        delivery: { kind: "steerHead", expectedTurnId: turnId },
      });
      if (enqueued.disposition !== "applied") {
        return { kind: enqueued.disposition, queue: enqueued.queue };
      }
      const queued = enqueued.queue;
      const metadata = this.#requireMessageQueueMetadata(paneId);
      const head = queued.messages[0];
      if (metadata.message_queue_pause_reason !== null) {
        throw new ChatPaneStoreError(
          "conflict",
          "The steer was not queued because this message queue is paused.",
        );
      }
      if (
        metadata.active_turn_id !== turnId ||
        !["starting", "streaming", "continuing"].includes(metadata.state)
      ) {
        throw new ChatPaneStoreError(
          "conflict",
          "The steer was not queued because its active chat turn changed.",
        );
      }
      if (head?.id !== messageId) {
        throw new ChatPaneStoreError(
          "conflict",
          "The steer was not queued because an older message is already ahead of it.",
        );
      }
      const prepared = this.claimHeadMessage({
        paneId,
        expectedQueueRevision: queued.revision,
        messageId,
        expectedMessageRevision: head.revision,
        turnId,
        kind: "steer",
        now: input.now,
      });
      return { kind: "prepared" as const, ...prepared };
    })();
  }

  editQueuedMessage(input: ChatMessageEditInput): ChatMessageQueueProjection {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const messageId = chatMessageIdSchema.parse(input.messageId);
    validateRevision(input.expectedQueueRevision);
    validateRevision(input.expectedMessageRevision);
    const content = parseChatMessageContent(input.content);
    const now = isoDateTimeSchema.parse(input.now.toISOString());

    return this.#database.transaction(() => {
      this.#assertNoPendingProviderThreadArchiveIntent(paneId);
      this.#requireMessageQueueRevision(paneId, input.expectedQueueRevision);
      const row = this.#requireMessageRowForPane(paneId, messageId);
      this.#requireQueuedMessageRevision(row, input.expectedMessageRevision);
      const textBytes = utf8ByteLength(content.text);
      this.#assertMessagePayloadCapacity(paneId, {
        addedRows: 0,
        replacedBytes: row.message_utf8_bytes,
        nextBytes: textBytes,
      });
      try {
        const edited = this.#database.query(`
          UPDATE chat_message_ledger SET
            message_text = ?4,
            message_utf8_bytes = ?5,
            revision = revision + 1,
            updated_at = ?6
          WHERE pane_id = ?1 AND message_id = ?2
            AND revision = ?3 AND state = 'queued'
        `).run(
          paneId,
          messageId,
          input.expectedMessageRevision,
          content.text,
          textBytes,
          now,
        );
        if (edited.changes !== 1) throw staleMessageRevision();
        this.#replaceReadyMessageAttachments(paneId, messageId, content, now);
        this.#advanceMessageQueueRevision(
          paneId,
          input.expectedQueueRevision,
          now,
        );
      } catch (error: unknown) {
        throw sqliteMessageConflict(error, "The queued chat message could not be edited.");
      }
      return this.messageQueue(paneId);
    })();
  }

  removeQueuedMessage(input: ChatMessageRowCasInput): ChatMessageQueueProjection {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const messageId = chatMessageIdSchema.parse(input.messageId);
    validateRevision(input.expectedQueueRevision);
    validateRevision(input.expectedMessageRevision);
    const now = isoDateTimeSchema.parse(input.now.toISOString());

    return this.#database.transaction(() => {
      this.#assertNoPendingProviderThreadArchiveIntent(paneId);
      this.#requireMessageQueueRevision(paneId, input.expectedQueueRevision);
      const row = this.#requireMessageRowForPane(paneId, messageId);
      this.#requireQueuedMessageRevision(row, input.expectedMessageRevision);
      const removed = this.#database.query(`
        UPDATE chat_message_ledger SET
          state = 'cancelled',
          revision = revision + 1,
          terminal_at = ?4,
          updated_at = ?4
        WHERE pane_id = ?1 AND message_id = ?2
          AND revision = ?3 AND state = 'queued'
      `).run(
        paneId,
        messageId,
        input.expectedMessageRevision,
        now,
      );
      if (removed.changes !== 1) throw staleMessageRevision();
      this.#clearMessageAttachments(paneId, messageId, now);
      this.#advanceMessageQueueRevision(paneId, input.expectedQueueRevision, now);
      return this.messageQueue(paneId);
    })();
  }

  pauseMessageQueue(input: ChatMessageQueuePauseInput): ChatMessageQueueProjection {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const reason = storeQueuePauseReason(input.reason);
    const now = isoDateTimeSchema.parse(input.now.toISOString());
    return this.#database.transaction(() => {
      this.#assertNoPendingProviderThreadArchiveIntent(paneId);
      const metadata = this.#requireMessageQueueMetadata(paneId);
      if (metadata.message_queue_pause_reason === reason) {
        return this.#messageQueueProjection(metadata);
      }
      const updated = this.#database.query(`
        UPDATE chat_panes SET
          message_queue_pause_reason = ?3,
          message_queue_revision = message_queue_revision + 1,
          updated_at = ?4
        WHERE pane_id = ?1 AND message_queue_revision = ?2
          AND archived_at IS NULL
      `).run(paneId, metadata.message_queue_revision, reason, now);
      if (updated.changes !== 1) throw staleQueueRevision();
      return this.messageQueue(paneId);
    })();
  }

  resumeMessageQueue(input: ChatMessageQueueResumeInput): ChatMessageQueueProjection {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    validateRevision(input.expectedQueueRevision);
    const now = isoDateTimeSchema.parse(input.now.toISOString());
    return this.#database.transaction(() => {
      this.#assertNoPendingProviderThreadArchiveIntent(paneId);
      if (this.require(paneId).providerContextResetRequired) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Use Start fresh to resume a queue with quarantined provider context.",
        );
      }
      const metadata = this.#requireMessageQueueRevision(
        paneId,
        input.expectedQueueRevision,
      );
      if (metadata.message_queue_pause_reason === null) {
        throw new ChatPaneStoreError("invalid_state", "This message queue is already running.");
      }
      if (metadata.message_queue_pause_reason === "ambiguous_effect") {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Contain the ambiguous message effect before resuming this queue.",
        );
      }
      const resumed = this.#database.query(`
        UPDATE chat_panes SET
          message_queue_pause_reason = NULL,
          message_queue_revision = message_queue_revision + 1,
          updated_at = ?3
        WHERE pane_id = ?1 AND message_queue_revision = ?2
          AND archived_at IS NULL
      `).run(paneId, input.expectedQueueRevision, now);
      if (resumed.changes !== 1) throw staleQueueRevision();
      return this.messageQueue(paneId);
    })();
  }

  startFreshProviderContext(input: Readonly<{
    readonly paneId: ChatPaneId;
    readonly expectedRevision: number;
    readonly expectedQueueRevision: number;
    readonly now: Date;
  }>): Readonly<{
    readonly pane: ChatPaneProjection;
    readonly queue: ChatMessageQueueProjection;
  }> {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    validateRevision(input.expectedRevision);
    validateRevision(input.expectedQueueRevision);
    const now = isoDateTimeSchema.parse(input.now.toISOString());
    return this.#database.transaction(() => {
      this.#assertNoPendingProviderThreadArchiveAuthorityV57(paneId);
      const pane = this.preflightStartFreshProviderContext(input);
      const classification = this.classifyRetainedProviderAttachmentBinding(
        paneId,
        pane.binding,
      );
      if (classification.kind === "orphan") {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Attachment custody no longer matches this pane's provider lineage.",
        );
      }
      const pendingArchiveIntent = this.providerThreadArchiveIntent(paneId);
      if (
        pane.binding === null &&
        pendingArchiveIntent !== null &&
        pendingArchiveIntent.state !== "account_contained"
      ) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Provider containment recovery must finish before starting fresh.",
        );
      }
      if (pane.binding !== null) {
        const intent = this.#requireSucceededProviderThreadArchiveIntent({
          pane,
          purpose: "start_fresh",
          paneRevision: input.expectedRevision,
          queueRevision: input.expectedQueueRevision,
        });
        this.#releaseExactProviderAttachmentBindingInTransaction(
          paneId,
          classification,
          intent,
          input.now,
        );
      }
      this.#advanceProviderHistoryFloor(paneId);
      const reset = this.#database.query(`
        UPDATE chat_panes
        SET state = 'ready',
            active_prompt = NULL,
            active_provider_turn_id = NULL,
            provider_account_profile_id = NULL,
            provider_thread_id = NULL,
            provider_restart_thread_id = NULL,
            active_turn_poisoned = 0,
            attention_code = NULL,
            attention_message = NULL,
            attention_retryable = NULL,
            history_truncated = 0,
            provider_context_reset_required = 0,
            message_queue_pause_reason = NULL,
            message_queue_revision = message_queue_revision + 1,
            revision = revision + 1,
            updated_at = ?4
        WHERE pane_id = ?1 AND revision = ?2
          AND message_queue_revision = ?3
          AND provider_context_reset_required = 1
          AND state = 'attention'
          AND attention_code = 'runtime_unavailable'
          AND attention_retryable = 0
          AND message_queue_pause_reason IS NOT NULL
          AND message_queue_pause_reason != 'ambiguous_effect'
          AND archived_at IS NULL
      `).run(
        paneId,
        input.expectedRevision,
        input.expectedQueueRevision,
        now,
      );
      if (reset.changes !== 1) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "The quarantined provider context changed before it could start fresh.",
        );
      }
      this.#database.query(`
        DELETE FROM chat_provider_thread_archive_intents WHERE pane_id = ?1
      `).run(paneId);
      return {
        pane: this.require(paneId).projection,
        queue: this.messageQueue(paneId),
      };
    })();
  }

  preflightStartFreshProviderContext(input: Readonly<{
    readonly paneId: ChatPaneId;
    readonly expectedRevision: number;
    readonly expectedQueueRevision: number;
  }>): ChatPanePrivateRecord {
    return this.#preflightStartFreshProviderContextV57(input, null);
  }

  #preflightStartFreshProviderContextV57(
    input: Readonly<{
      readonly paneId: ChatPaneId;
      readonly expectedRevision: number;
      readonly expectedQueueRevision: number;
    }>,
    allowedTargetId: string | null,
  ): ChatPanePrivateRecord {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    validateRevision(input.expectedRevision);
    validateRevision(input.expectedQueueRevision);
    return this.#database.transaction(() => {
      this.#assertNoPendingProviderThreadArchiveAuthorityV57(
        paneId,
        allowedTargetId,
        null,
        allowedTargetId !== null,
      );
      const pane = this.#requireRevision(paneId, input.expectedRevision, {
        allowPendingProviderThreadArchiveIntent: true,
      });
      const metadata = this.#requireMessageQueueRevision(
        paneId,
        input.expectedQueueRevision,
      );
      const pendingTransition = this.#pendingProviderThreadArchiveIntent(paneId);
      if (
        pendingTransition !== null &&
        pendingTransition.purpose !== "start_fresh"
      ) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "This provider-context transition is pending; only its exact recovery may continue.",
        );
      }
      if (
        !pane.providerContextResetRequired ||
        pane.projection.state !== "attention" ||
        pane.projection.attention?.code !== "runtime_unavailable" ||
        pane.projection.attention.retryable
      ) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "This pane has no quarantined provider context to start fresh from.",
        );
      }
      if (
        metadata.message_queue_pause_reason === null ||
        metadata.message_queue_pause_reason === "ambiguous_effect"
      ) {
        throw new ChatPaneStoreError(
          "invalid_state",
          metadata.message_queue_pause_reason === "ambiguous_effect"
            ? "Contain the ambiguous message effect before starting fresh."
            : "Starting fresh requires an explicitly paused message queue.",
        );
      }
      if (
        this.classifyRetainedProviderAttachmentBinding(paneId, pane.binding)
          .kind === "orphan"
      ) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "The quarantined provider attachment lineage cannot be contained exactly.",
        );
      }
      const pendingArchiveIntent = this.providerThreadArchiveIntent(paneId);
      if (
        (pane.binding === null && pendingArchiveIntent !== null &&
          pendingArchiveIntent.state !== "account_contained") ||
        (pane.binding !== null && pendingArchiveIntent?.state === "account_contained")
      ) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Provider containment recovery must finish before starting fresh.",
        );
      }
      return pane;
    })();
  }

  preflightPaneArchive(input: Readonly<{
    readonly paneId: ChatPaneId;
    readonly expectedRevision: number;
  }>): ChatPanePrivateRecord {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    validateRevision(input.expectedRevision);
    return this.#database.transaction(() =>
      this.#preflightPaneArchive(paneId, input.expectedRevision)
    )();
  }

  classifyRetainedProviderAttachmentBinding(
    paneIdValue: ChatPaneId,
    binding: ChatThreadBinding | null,
  ): RetainedProviderAttachmentBindingClassification {
    const paneId = chatPaneIdSchema.parse(paneIdValue);
    const rows = this.#retainedProviderAttachmentBindingRows(paneId);
    if (rows.length === 0) return Object.freeze({ kind: "none" as const });
    if (rows.length !== 1 || binding === null) {
      return Object.freeze({ kind: "orphan" as const });
    }
    const authority = chatProviderAttachmentAuthority(paneId, binding);
    const row = rows[0];
    if (row === undefined) return Object.freeze({ kind: "orphan" as const });
    if (
      row.binding_id !== authority.bindingId ||
      row.binding_key_digest !== authority.bindingKeyDigest
    ) return Object.freeze({ kind: "orphan" as const });
    return Object.freeze({
      kind: "exact" as const,
      bindingId: row.binding_id,
      bindingKeyDigest: row.binding_key_digest,
      revision: row.revision,
      state: row.state,
    });
  }

  retainedProviderAttachmentBindingCount(paneId: ChatPaneId): number {
    return this.#retainedProviderAttachmentBindingCount(
      chatPaneIdSchema.parse(paneId),
    );
  }

  requiredInputClassForAttachments(
    paneId: ChatPaneId,
    attachmentIds: readonly string[],
  ): "text" | "image" {
    return this.#attachmentRequiredInputClass(
      chatPaneIdSchema.parse(paneId),
      attachmentIds,
    );
  }

  prepareProviderThreadArchiveIntent(input: Readonly<{
    readonly paneId: ChatPaneId;
    readonly purpose: "start_fresh" | "pane_archive";
    readonly expectedRevision: number;
    readonly expectedQueueRevision: number | null;
    readonly binding: ChatThreadBinding;
    readonly generation: number;
    readonly now: Date;
  }>): ChatProviderThreadArchiveIntent {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    validateRevision(input.expectedRevision);
    if (input.expectedQueueRevision !== null) {
      validateRevision(input.expectedQueueRevision);
    }
    validateRevision(input.generation);
    const now = isoDateTimeSchema.parse(input.now.toISOString());
    return this.#database.transaction(() => {
      this.#assertNoPendingProviderThreadArchiveAuthorityV57(paneId);
      const pane = input.purpose === "start_fresh"
        ? this.preflightStartFreshProviderContext({
            paneId,
            expectedRevision: input.expectedRevision,
            expectedQueueRevision: input.expectedQueueRevision ?? corrupt(
              "Start-fresh archive intent lost its queue revision.",
            ),
          })
        : this.#preflightPaneArchive(paneId, input.expectedRevision);
      if (!sameBinding(pane.binding, input.binding)) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "The provider thread changed before containment was prepared.",
        );
      }
      const classification = this.classifyRetainedProviderAttachmentBinding(
        paneId,
        pane.binding,
      );
      if (classification.kind === "orphan") {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Attachment custody no longer matches this pane's provider lineage.",
        );
      }
      const existing = this.providerThreadArchiveIntent(paneId);
      if (existing !== null) {
        const exactBindingMatches = classification.kind === "exact"
          ? existing.binding_id === classification.bindingId &&
            existing.binding_key_digest === classification.bindingKeyDigest &&
            existing.binding_revision === classification.revision
          : existing.binding_id === null &&
            existing.binding_key_digest === null &&
            existing.binding_revision === null;
        if (
          existing.purpose !== input.purpose ||
          existing.pane_revision !== input.expectedRevision ||
          existing.queue_revision !== input.expectedQueueRevision ||
          existing.account_profile_id !== input.binding.accountProfileId ||
          existing.thread_id !== input.binding.threadId ||
          existing.restart_thread_id !== input.binding.restartThreadId ||
          !exactBindingMatches
        ) {
          throw new ChatPaneStoreError(
            "revision_conflict",
            "The durable provider containment intent belongs to another transition.",
          );
        }
        return existing;
      }
      this.#database.query(`
        INSERT INTO chat_provider_thread_archive_intents (
          pane_id, purpose, state, pane_revision, queue_revision,
          account_profile_id, thread_id, restart_thread_id,
          binding_id, binding_key_digest, binding_revision,
          generation, generation_contained, generation_containment_receipt,
          effect_attempt, containment_receipt,
          response_generation, response_stream_position, ambiguity_receipt,
          reconciliation_disposition, reconciliation_receipt,
          created_at, updated_at
        ) VALUES (
          ?1, ?2, 'prepared', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
          ?11, 0, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, ?12, ?12
        )
      `).run(
        paneId,
        input.purpose,
        input.expectedRevision,
        input.expectedQueueRevision,
        input.binding.accountProfileId,
        input.binding.threadId,
        input.binding.restartThreadId,
        classification.kind === "exact" ? classification.bindingId : null,
        classification.kind === "exact" ? classification.bindingKeyDigest : null,
        classification.kind === "exact" ? classification.revision : null,
        input.generation,
        now,
      );
      return this.#requireProviderThreadArchiveIntent(paneId);
    })();
  }

  providerThreadArchiveIntent(
    paneIdValue: ChatPaneId,
  ): ChatProviderThreadArchiveIntent | null {
    const paneId = chatPaneIdSchema.parse(paneIdValue);
    const value: unknown = this.#database.query(`
      SELECT * FROM chat_provider_thread_archive_intents WHERE pane_id = ?1
    `).get(paneId);
    return value === null ? null : providerThreadArchiveIntentRowSchema.parse(value);
  }

  pendingProviderThreadArchivePaneIds(): readonly ChatPaneId[] {
    const values: unknown[] = this.#database.query(`
      SELECT pane_id FROM chat_provider_thread_archive_intents
      WHERE state != 'account_contained'
      ORDER BY pane_id
    `).all();
    return values.map((value) =>
      z.object({ pane_id: chatPaneIdSchema }).strict().parse(value).pane_id
    );
  }

  /** Same-transaction guard for direct chat_panes writers outside this store. */
  assertProviderThreadArchivePaneMutationAllowedV57(
    paneIdValue: ChatPaneId,
  ): void {
    const paneId = chatPaneIdSchema.parse(paneIdValue);
    this.#database.transaction(() => {
      this.#assertNoPendingProviderThreadArchiveAuthorityV57(paneId);
    })();
  }

  #prepareProviderThreadArchiveTargetV57(
    input: ChatProviderThreadArchiveTargetPreparationV57Input,
  ): ProviderThreadArchiveTargetSnapshotV57 {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    validateRevision(input.expectedRevision);
    validateRevision(input.generation);
    if (input.purpose === "start_fresh") {
      validateRevision(input.expectedQueueRevision);
    } else if (input.expectedQueueRevision !== null) {
      throw new ChatPaneStoreError(
        "conflict",
        "A pane archive cannot claim a start-fresh queue revision.",
      );
    }
    const now = new Date(isoDateTimeSchema.parse(input.now.toISOString()));
    return this.#database.transaction(() => {
      if (
        this.#scheduledChats.mutationForPane(paneId) !== null
        || this.#scheduledChats.desiredOff(paneId) !== null
      ) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Wait for the pending schedule change before archiving this chat provider context.",
        );
      }
      const journal = this.#requireProviderThreadArchiveJournalV57();
      this.#assertNoConflictingLegacyArchiveV57(paneId);
      const openTargets = journal.recoveryTargets();
      const samePane = openTargets.find((target) => target.paneId === paneId);
      const sameId = openTargets.find((target) =>
        target.targetId === input.targetId
      );
      if (
        (samePane !== undefined && samePane.targetId !== input.targetId) ||
        (sameId !== undefined && sameId.paneId !== paneId)
      ) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "Another durable provider-thread archive target owns this transition.",
        );
      }

      const pane = input.purpose === "start_fresh"
        ? this.#preflightStartFreshProviderContextV57({
            paneId,
            expectedRevision: input.expectedRevision,
            expectedQueueRevision: input.expectedQueueRevision,
          }, input.targetId)
        : this.#preflightPaneArchive(
            paneId,
            input.expectedRevision,
            input.targetId,
          );
      if (
        pane.projection.interactionMode !== "chat" ||
        isActive(pane.projection)
      ) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Only an inactive ordinary pane can prepare a provider-thread archive target.",
        );
      }
      this.#assertMessageQueueClosableForPane(paneId);
      this.#requirePaneArchiveCompatibilityV57(paneId);
      const authority = this.#providerThreadArchivePaneAuthorityV57(paneId);
      if (
        authority.row.revision !== input.expectedRevision ||
        authority.row.message_queue_revision !== (
          input.purpose === "start_fresh"
            ? input.expectedQueueRevision
            : authority.row.message_queue_revision
        )
      ) {
        throw staleRevision();
      }
      if (
        authority.ownership.kind !== "ordinary" ||
        authority.ownership.accountProfileId !==
          authority.binding.accountProfileId ||
        authority.ownership.generation !== input.generation
      ) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "The pane no longer has exact ordinary provider-generation ownership.",
        );
      }
      const profile = this.#requireProviderArchiveAccountProfileV57(
        authority.binding.accountProfileId,
      );
      if (profile.process_generation !== input.generation) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "The provider account generation changed before archive preparation.",
        );
      }
      this.#assertProviderArchiveSourceCohortPreflightV57(
        authority.binding.accountProfileId,
        input.generation,
      );
      const preimage = this.#providerThreadArchiveTargetPreimageV57({
        authority,
        purpose: input.purpose,
        accountProfileRevision: profile.revision,
      });
      const initialAttempt = samePane?.attempts[0];
      if (samePane !== undefined) {
        if (
          samePane.purpose !== input.purpose ||
          initialAttempt === undefined ||
          initialAttempt.attemptId !== input.attemptId ||
          initialAttempt.generation !== input.generation ||
          initialAttempt.accountProfileRevision !== profile.revision
        ) {
          throw new ChatPaneStoreError(
            "revision_conflict",
            "The durable provider-thread archive target belongs to another request.",
          );
        }
        journal.assertTargetPreimage(samePane.targetId, preimage);
        this.#assertProviderArchiveTargetStoreAuthorityV57(samePane);
        return samePane;
      }
      const requestEvidenceDigest = this.#providerArchiveHmacV57(
        "target-request-evidence",
        {
          targetId: input.targetId,
          attemptId: input.attemptId,
          paneId,
          purpose: input.purpose,
          accountProfileId: authority.binding.accountProfileId,
          threadId: authority.binding.threadId,
          restartThreadId: authority.binding.restartThreadId,
          generation: input.generation,
          paneCasDigest: authority.paneCasDigest,
          queueCasDigest: input.purpose === "start_fresh"
            ? authority.queueCasDigest
            : null,
          binding: authority.bindingPreimage,
        },
      );
      const requestRevisionDigest = this.#providerArchiveHmacV57(
        "target-request-revision",
        {
          targetId: input.targetId,
          attemptId: input.attemptId,
          paneRevision: authority.row.revision,
          queueRevision: input.purpose === "start_fresh"
            ? authority.row.message_queue_revision
            : null,
          accountProfileRevision: profile.revision,
          generation: input.generation,
        },
      );
      return journal.prepareTarget({
        targetId: input.targetId,
        paneId,
        purpose: input.purpose,
        paneRevision: authority.row.revision,
        queueRevision: input.purpose === "start_fresh"
          ? authority.row.message_queue_revision
          : null,
        paneCasDigest: authority.paneCasDigest,
        queueCasDigest: input.purpose === "start_fresh"
          ? authority.queueCasDigest
          : null,
        accountProfileId: authority.binding.accountProfileId,
        accountProfileRevision: profile.revision,
        threadId: authority.binding.threadId,
        restartThreadId: authority.binding.restartThreadId,
        binding: authority.bindingPreimage,
        attempt: {
          attemptId: input.attemptId,
          generation: input.generation,
          accountProfileRevision: profile.revision,
          requestEvidenceDigest,
          requestRevisionDigest,
        },
        now,
      });
    })();
  }

  /**
   * Freezes the complete local preimage and consumes the one provider-effect
   * claim in the same SQLite transaction. Runtime callers must use this seam:
   * no durable prepared-only window is exposed before provider RPC.
   */
  prepareProviderThreadArchiveEffectStartedV57(
    input: ChatProviderThreadArchiveTargetPreparationV57Input,
  ): ReturnType<ProviderThreadArchiveJournalV57["admissionDescriptor"]> {
    return this.#database.transaction(() => {
      const target = this.#prepareProviderThreadArchiveTargetV57(input);
      if (
        target.currentAttempt.attemptId !== input.attemptId ||
        target.currentAttempt.generation !== input.generation
      ) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "The v57 provider-effect claim no longer names the current attempt.",
        );
      }
      const effectEvidenceDigest = this.#providerArchiveHmacV57(
        "effect-start-evidence",
        {
          targetId: target.targetId,
          attemptId: target.currentAttempt.attemptId,
          paneId: target.paneId,
          purpose: target.purpose,
          generation: target.currentAttempt.generation,
        },
      );
      const effectRevisionDigest = this.#providerArchiveHmacV57(
        "effect-start-revision",
        {
          targetId: target.targetId,
          attemptId: target.currentAttempt.attemptId,
          expectedPaneRevision: input.expectedRevision,
          expectedQueueRevision: input.expectedQueueRevision,
        },
      );
      if (target.currentAttempt.state === "effect_started") {
        const attempt = this.#providerArchiveAttemptAuthorityRowV57(
          target.currentAttempt.attemptId,
        );
        if (
          attempt.effect_evidence_digest !== effectEvidenceDigest ||
          attempt.effect_revision_digest !== effectRevisionDigest
        ) {
          throw new ChatPaneStoreError(
            "corrupt_state",
            "The v57 provider-effect claim lacks its exact store-owned evidence.",
          );
        }
        return this.#requireProviderThreadArchiveJournalV57()
          .admissionDescriptor(target.targetId);
      }
      if (target.currentAttempt.state !== "prepared") {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "The v57 provider-effect claim was already consumed by another recovery phase.",
        );
      }
      this.#requireProviderThreadArchiveJournalV57().markEffectStarted({
        attemptId: target.currentAttempt.attemptId,
        effectEvidenceDigest,
        effectRevisionDigest,
        now: input.now,
      });
      return this.#requireProviderThreadArchiveJournalV57().admissionDescriptor(
        target.targetId,
      );
    })();
  }

  recordProviderThreadArchiveDirectAppliedV57(input: Readonly<{
    readonly targetId: string;
    readonly responseGeneration: number;
    readonly responseStreamPosition: number;
    readonly providerContainmentReceipt: string;
    readonly now: Date;
  }>): ReturnType<ProviderThreadArchiveJournalV57["admissionDescriptor"]> {
    const targetId = providerArchiveTargetIdSchema.parse(input.targetId);
    validateRevision(input.responseGeneration);
    if (
      !Number.isSafeInteger(input.responseStreamPosition)
      || input.responseStreamPosition < 0
    ) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The provider archive response position is invalid.",
      );
    }
    const providerReceipt = boundedOpaqueReceipt(
      input.providerContainmentReceipt,
    );
    const now = new Date(isoDateTimeSchema.parse(input.now.toISOString()));
    return this.#database.transaction(() => {
      const journal = this.#requireProviderThreadArchiveJournalV57();
      const target = journal.reopenTarget(targetId);
      const { targetRow, attemptRow } =
        this.#assertProviderArchiveTargetPreimageV57(target);
      const evidenceDigest = this.#providerArchiveHmacV57(
        "direct-applied-evidence",
        {
          targetId,
          attemptId: target.currentAttempt.attemptId,
          generation: target.currentAttempt.generation,
          responseGeneration: input.responseGeneration,
          responseStreamPosition: input.responseStreamPosition,
          providerContainmentReceipt: providerReceipt,
        },
      );
      const revisionDigest = this.#providerArchiveHmacV57(
        "direct-applied-revision",
        {
          targetIdentityHmac: targetRow.identity_hmac,
          targetPointerHmac: targetRow.pointer_hmac,
          attemptIdentityHmac: attemptRow.identity_hmac,
          attemptEffectHmac: attemptRow.effect_hmac,
          paneRevision: targetRow.pane_revision,
          queueRevision: targetRow.queue_revision,
          outcomeEvidenceDigest: evidenceDigest,
        },
      );
      if (target.currentAttempt.state === "direct_applied") {
        if (
          attemptRow.response_generation !== input.responseGeneration
          || attemptRow.response_stream_position !==
            input.responseStreamPosition
          || attemptRow.outcome_evidence_digest !== evidenceDigest
          || attemptRow.outcome_revision_digest !== revisionDigest
        ) {
          throw new ChatPaneStoreError(
            "revision_conflict",
            "The direct provider archive result changed after it was recorded.",
          );
        }
        return journal.admissionDescriptor(targetId);
      }
      if (
        target.currentAttempt.state !== "effect_started"
        || target.currentAttempt.cutId !== null
        || input.responseGeneration !== target.currentAttempt.generation
      ) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "The direct provider archive result lacks its exact effect authority.",
        );
      }
      journal.recordDirectApplied({
        attemptId: target.currentAttempt.attemptId,
        responseGeneration: input.responseGeneration,
        responseStreamPosition: input.responseStreamPosition,
        outcomeEvidenceDigest: evidenceDigest,
        outcomeRevisionDigest: revisionDigest,
        now,
      });
      return journal.admissionDescriptor(targetId);
    })();
  }

  /**
   * Persists one complete successor wave as an all-or-nothing direct outcome.
   * A fault on any target leaves the whole cohort effect-started so one later
   * containment cut can still bind the exact generation wave.
   */
  recordProviderThreadArchiveDirectAppliedCohortV57(input: Readonly<{
    readonly cutId: string;
    readonly results: readonly Readonly<{
      readonly targetId: string;
      readonly responseGeneration: number;
      readonly responseStreamPosition: number;
      readonly providerContainmentReceipt: string;
    }>[];
    readonly now: Date;
  }>): readonly ReturnType<
    ProviderThreadArchiveJournalV57["admissionDescriptor"]
  >[] {
    const cutId = providerArchiveCutIdSchema.parse(input.cutId);
    if (input.results.length < 1 || input.results.length > CHAT_MAX_PANES) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The v57 direct-applied cohort has an invalid target count.",
      );
    }
    const results = input.results.map((result) => Object.freeze({
      targetId: providerArchiveTargetIdSchema.parse(result.targetId),
      responseGeneration: (() => {
        validateRevision(result.responseGeneration);
        return result.responseGeneration;
      })(),
      responseStreamPosition: (() => {
        if (
          !Number.isSafeInteger(result.responseStreamPosition)
          || result.responseStreamPosition < 0
        ) {
          throw new ChatPaneStoreError(
            "invalid_state",
            "A v57 cohort response position is invalid.",
          );
        }
        return result.responseStreamPosition;
      })(),
      providerContainmentReceipt: boundedOpaqueReceipt(
        result.providerContainmentReceipt,
      ),
    })).sort((left, right) =>
      compareProviderArchiveCodeUnits(left.targetId, right.targetId)
    );
    if (
      new Set(results.map(({ targetId }) => targetId)).size !== results.length
    ) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The v57 direct-applied cohort contains duplicate targets.",
      );
    }
    const now = new Date(isoDateTimeSchema.parse(input.now.toISOString()));
    return this.#database.transaction(() => {
      const journal = this.#requireProviderThreadArchiveJournalV57();
      const cut = journal.reopenCut(cutId);
      if (
        cut.cause === "account_removal" || cut.state !== "contained" ||
        cut.successorGeneration !== cut.sourceGeneration + 1 ||
        cut.successorAccountProfileRevision === null
      ) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "The v57 direct-applied cohort lacks one contained predecessor cut.",
        );
      }
      this.#assertProviderArchiveSourceContainedAuthorityV57(cut);
      const cohort = cut.members.filter((member) =>
        member.role === "target"
      ).map((member) => {
        const stored = this.#providerArchiveMemberAuthorityRowV57(
          member.memberId,
        );
        if (
          stored.target_id === null || stored.attempt_id === null ||
          stored.target_attempt_ordinal === null
        ) {
          throw new ChatPaneStoreError(
            "corrupt_state",
            "A v57 direct-applied cohort member lost its target lineage.",
          );
        }
        const target = journal.reopenTarget(stored.target_id);
        const predecessor = target.attempts.find((attempt) =>
          attempt.attemptId === stored.attempt_id
        );
        if (
          target.paneId !== member.paneId || predecessor === undefined ||
          predecessor.ordinal !== stored.target_attempt_ordinal ||
          predecessor.cutId !== cutId ||
          predecessor.generation !== cut.sourceGeneration
        ) {
          throw new ChatPaneStoreError(
            "corrupt_state",
            "A v57 direct-applied cohort changed its frozen predecessor.",
          );
        }
        if (
          target.status === "committed" &&
          predecessor.state === "reconciled_applied"
        ) return null;
        if (
          target.status !== "open" ||
          predecessor.state !== "reconciled_not_applied" ||
          target.currentAttempt.predecessorAttemptId !==
            predecessor.attemptId ||
          target.currentAttempt.ordinal !== predecessor.ordinal + 1 ||
          target.currentAttempt.cutId !== null ||
          target.currentAttempt.generation !== cut.successorGeneration ||
          target.currentAttempt.accountProfileRevision !==
            cut.successorAccountProfileRevision ||
          !["effect_started", "direct_applied"].includes(
            target.currentAttempt.state,
          )
        ) {
          throw new ChatPaneStoreError(
            "revision_conflict",
            "A v57 direct-applied cohort target left its exact successor wave.",
          );
        }
        return target;
      }).filter((target) => target !== null).sort((left, right) =>
        compareProviderArchiveCodeUnits(left.targetId, right.targetId)
      );
      if (
        cohort.length !== results.length ||
        cohort.some((target, index) =>
          target.targetId !== results[index]?.targetId
        )
      ) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "The v57 direct results do not equal the complete successor cohort.",
        );
      }
      const states = new Set(cohort.map(({ currentAttempt }) =>
        currentAttempt.state
      ));
      if (states.size !== 1) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "The v57 direct-applied cohort cannot replay a partial outcome.",
        );
      }
      if (states.has("effect_started")) {
        const ready = this.#providerThreadArchiveSuccessorWaveReadyV57(cutId)
          .map(({ transitionId }) => transitionId)
          .sort(compareProviderArchiveCodeUnits);
        if (
          ready.length !== results.length ||
          ready.some((targetId, index) =>
            targetId !== results[index]?.targetId
          )
        ) {
          throw new ChatPaneStoreError(
            "revision_conflict",
            "The v57 ready successor wave changed before outcome commit.",
          );
        }
      } else if (!states.has("direct_applied")) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "The v57 direct-applied cohort has an invalid replay phase.",
        );
      }
      return Object.freeze(results.map((result) =>
        this.recordProviderThreadArchiveDirectAppliedV57({
          ...result,
          now,
        })
      ));
    })();
  }

  beginProviderThreadArchiveLostResponseCutV57(input: Readonly<{
    readonly targetId: string;
    readonly cutId: string;
    readonly cause: "ambiguous_response" | "lost_response";
    readonly now: Date;
  }>): ChatProviderThreadArchiveLostResponseCutV57Result {
    const targetId = providerArchiveTargetIdSchema.parse(input.targetId);
    const cutId = providerArchiveCutIdSchema.parse(input.cutId);
    const cause = z.enum(["ambiguous_response", "lost_response"])
      .parse(input.cause);
    const now = new Date(isoDateTimeSchema.parse(input.now.toISOString()));
    return this.#database.transaction(() => {
      const journal = this.#requireProviderThreadArchiveJournalV57();
      const existingCount = countRowSchema.parse(this.#database.query(`
        SELECT COUNT(*) AS count
        FROM chat_provider_thread_archive_cuts_v57 WHERE cut_id = ?1
      `).get(cutId)).count;
      if (existingCount === 1) {
        const existing = journal.reopenCut(cutId);
        const initiatingAttempt = existing.initiatingAttemptId === null
          ? null
          : this.#providerArchiveAttemptAuthorityRowV57(
              existing.initiatingAttemptId,
            );
        if (
          existing.cause !== cause || initiatingAttempt === null ||
          initiatingAttempt.target_id !== targetId ||
          initiatingAttempt.generation !== existing.sourceGeneration
        ) {
          throw new ChatPaneStoreError(
            "revision_conflict",
            "The v57 containment cut belongs to another lost response.",
          );
        }
        const affectedTargetIds =
          this.#assertProviderArchiveLostResponseCutAuthorityV57(existing);
        return Object.freeze({
          cut: existing,
          affectedTargetIds: Object.freeze(affectedTargetIds),
        });
      }
      const initiatingTarget = journal.reopenTarget(targetId);
      const initiating = this.#assertProviderArchiveTargetPreimageV57(
        initiatingTarget,
      );
      if (
        initiatingTarget.currentAttempt.state !== "effect_started"
        || initiatingTarget.currentAttempt.cutId !== null
      ) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "The lost provider response no longer owns an unfenced effect.",
        );
      }
      const affectedTargets = journal.recoveryTargets().filter((target) => {
        const row = this.#providerArchiveTargetAuthorityRowV57(
          target.targetId,
        );
        return row.account_profile_id === initiating.targetRow.account_profile_id
          && target.currentAttempt.generation ===
            initiatingTarget.currentAttempt.generation
          && target.currentAttempt.cutId === null;
      });
      for (const target of affectedTargets) {
        this.#assertProviderArchiveTargetPreimageV57(target);
        if (target.currentAttempt.state !== "effect_started") {
          throw new ChatPaneStoreError(
            "invalid_state",
            "Every affected v57 target must own an effect before containment begins.",
          );
        }
      }
      const predecessorCutId = [...initiatingTarget.attempts]
        .reverse()
        .find((attempt) =>
          attempt.attemptId !== initiatingTarget.currentAttempt.attemptId
          && attempt.cutId !== null
        )?.cutId ?? null;
      const affectedTargetIds = affectedTargets.map((target) =>
        target.targetId
      ).sort(compareProviderArchiveCodeUnits);
      this.#assertProviderArchiveSourceCohortPreflightV57(
        initiating.targetRow.account_profile_id,
        initiatingTarget.currentAttempt.generation,
      );
      journal.createCut({
        cutId,
        accountProfileId: initiating.targetRow.account_profile_id,
        accountProfileRevision:
          initiatingTarget.currentAttempt.accountProfileRevision,
        sourceGeneration: initiatingTarget.currentAttempt.generation,
        cause,
        initiatingAttemptId: initiatingTarget.currentAttempt.attemptId,
        predecessorCutId,
        identityEvidenceDigest: this.#providerArchiveHmacV57(
          "lost-response-cut-evidence",
          {
            cutId,
            cause,
            initiatingTargetId: targetId,
            initiatingAttemptId: initiatingTarget.currentAttempt.attemptId,
            accountProfileId: initiating.targetRow.account_profile_id,
            sourceGeneration: initiatingTarget.currentAttempt.generation,
            predecessorCutId,
            affectedTargetIds,
          },
        ),
        identityRevisionDigest: this.#providerArchiveHmacV57(
          "lost-response-cut-revision",
          {
            cutId,
            targetIdentityHmac: initiating.targetRow.identity_hmac,
            initiatingAttemptIdentityHmac: initiating.attemptRow.identity_hmac,
            initiatingAttemptEffectHmac: initiating.attemptRow.effect_hmac,
            accountProfileRevision:
              initiatingTarget.currentAttempt.accountProfileRevision,
          },
        ),
        now,
      });
      const boundAttempts = journal.bindAllAffectedTargets(cutId);
      const targetsByAttempt = new Map(journal.recoveryTargets().map(
        (target) => [target.currentAttempt.attemptId, target] as const,
      ));
      for (const attempt of boundAttempts) {
        if (attempt.state !== "effect_started") {
          throw new ChatPaneStoreError(
            "invalid_state",
            "A bound v57 target lacked effect-started ambiguity authority.",
          );
        }
        const affected = targetsByAttempt.get(attempt.attemptId) ?? corrupt(
          "A bound v57 attempt lost its target.",
        );
        const affectedTargetRow = this.#providerArchiveTargetAuthorityRowV57(
          affected.targetId,
        );
        const affectedAttemptRow =
          this.#providerArchiveAttemptAuthorityRowV57(attempt.attemptId);
        const cutRow = this.#providerArchiveCutAuthorityRowV57(cutId);
        journal.recordAmbiguous({
          attemptId: attempt.attemptId,
          ambiguityEvidenceDigest: this.#providerArchiveHmacV57(
            "lost-response-ambiguity-evidence",
            {
              cutId,
              cause,
              targetId: affected.targetId,
              attemptId: attempt.attemptId,
              generation: attempt.generation,
            },
          ),
          ambiguityRevisionDigest: this.#providerArchiveHmacV57(
            "lost-response-ambiguity-revision",
            {
              cutId,
              targetIdentityHmac: affectedTargetRow.identity_hmac,
              attemptIdentityHmac: affectedAttemptRow.identity_hmac,
              attemptEffectHmac: affectedAttemptRow.effect_hmac,
              attemptCutBindingHmac: affectedAttemptRow.cut_binding_hmac,
              cutIdentityHmac: cutRow.identity_hmac,
            },
          ),
          now,
        });
      }
      const boundTargetIds = [...targetsByAttempt.values()]
        .filter((target) => target.currentAttempt.cutId === cutId)
        .map((target) => target.targetId)
        .sort(compareProviderArchiveCodeUnits);
      if (
        boundTargetIds.length !== affectedTargetIds.length ||
        boundTargetIds.some((boundTargetId, index) =>
          boundTargetId !== affectedTargetIds[index]
        )
      ) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "The v57 cut did not bind its exact affected target cohort.",
        );
      }
      return Object.freeze({
        cut: journal.reopenCut(cutId),
        affectedTargetIds: Object.freeze(boundTargetIds),
      });
    })();
  }

  #verifiedProviderThreadArchiveCommittedTargetsV57(): readonly ProviderThreadArchiveTargetSnapshotV57[] {
    const journal = this.#requireProviderThreadArchiveJournalV57();
    const values: unknown[] = this.#database.query(`
      SELECT target_id FROM chat_provider_thread_archive_targets_v57
      WHERE status = 'committed' ORDER BY target_id
    `).all();
    const targets = values.map((value) => {
      const targetId = z.object({
        target_id: providerArchiveTargetIdSchema,
      }).strict().parse(value).target_id;
      const target = journal.reopenTarget(targetId);
      if (target.status !== "committed") {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "A terminal v57 target disagrees with its committed index.",
        );
      }
      this.#assertProviderArchiveTargetStoreAuthorityV57(target);
      const targetRow = this.#providerArchiveTargetAuthorityRowV57(targetId);
      this.#replayCommittedProviderThreadArchiveFinalizationV57({
        target,
        targetRow,
        containmentReceipt:
          this.#providerArchiveFinalizationContainmentReceiptV57(target),
      });
      return target;
    });
    return Object.freeze(targets);
  }

  /** Verifies every committed target before destructive startup cleanup. */
  verifyProviderThreadArchiveTerminalAuthorityV57(): readonly string[] {
    return this.#database.transaction(() => Object.freeze(
      this.#verifiedProviderThreadArchiveCommittedTargetsV57().map(
        ({ targetId }) => targetId,
      ),
    ))();
  }

  /**
   * Atomically releases only exact, locally verified terminal archive
   * components. Components containing any open target and zero-target removal
   * cuts remain durable recovery authority.
   */
  sweepProviderThreadArchiveTerminalAuthorityV57(
    expectedCommittedTargetIdsValue: readonly string[],
  ): ChatProviderThreadArchiveStartupSweepV57 {
    return this.#database.transaction(() => {
      const expectedCommittedTargetIds = z.array(
        providerArchiveTargetIdSchema,
      ).parse(expectedCommittedTargetIdsValue);
      const canonicalExpectedTargetIds = [...expectedCommittedTargetIds]
        .sort(compareProviderArchiveCodeUnits);
      if (
        new Set(expectedCommittedTargetIds).size !==
          expectedCommittedTargetIds.length
        || expectedCommittedTargetIds.some((targetId, index) =>
          targetId !== canonicalExpectedTargetIds[index]
        )
      ) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "The expected v57 committed-target set is not canonical.",
        );
      }
      const expectedTargetIds = Object.freeze(canonicalExpectedTargetIds);
      const observedCommittedTargetIds = Object.freeze(
        this.#verifiedProviderThreadArchiveCommittedTargetsV57().map(
          ({ targetId }) => targetId,
        ),
      );
      if (!providerArchiveStringArraysEqual(
        expectedTargetIds,
        observedCommittedTargetIds,
      )) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "The v57 committed-target set changed before terminal cleanup.",
        );
      }
      if (this.#paneArchiveAuthority === null) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "V57 terminal cleanup requires attachment-vault postimage authority.",
        );
      }
      this.#paneArchiveAuthority
        .assertProviderThreadArchiveTerminalPostimagesV57(expectedTargetIds);

      const journal = this.#requireProviderThreadArchiveJournalV57();
      const visitedTargetIds = new Set<string>();
      const deletedTargetIds: string[] = [];
      const deletedCutIds: string[] = [];
      for (const seedTargetId of expectedTargetIds) {
        if (visitedTargetIds.has(seedTargetId)) continue;
        const terminal = this.verifiedProviderThreadArchiveTerminalComponentV57(
          seedTargetId,
        );
        for (const targetId of terminal.component.targetIds) {
          if (visitedTargetIds.has(targetId)) {
            throw new ChatPaneStoreError(
              "corrupt_state",
              "V57 terminal cleanup components overlap.",
            );
          }
          visitedTargetIds.add(targetId);
        }
        if (!terminal.component.allTargetsCommitted) continue;
        const componentCuts = terminal.component.cutIds.map((cutId) =>
          journal.reopenCut(cutId)
        );
        for (const cut of componentCuts) {
          if (cut.cause !== "account_removal") {
            this.#assertProviderArchiveSourceContainedAuthorityV57(cut);
            continue;
          }
          if (
            cut.state !== "contained"
            || cut.members.some((member) => member.state !== "settled")
          ) {
            throw new ChatPaneStoreError(
              "invalid_state",
              "The v57 account-removal component lacks complete contained member authority.",
            );
          }
          for (const member of cut.members) {
            this.#assertProviderArchiveSettledMemberPostimageV57(cut, member);
          }
          this.#assertProviderArchiveSealedInventoryPostimageV57(cut);
        }
        if (componentCuts.some((cut) =>
          cut.cause === "account_removal" && cut.targetCount === 0
        )) {
          throw new ChatPaneStoreError(
            "invalid_state",
            "V57 terminal cleanup cannot release a component containing zero-target account-removal authority.",
          );
        }

        const deleted = journal.deleteCommittedTargetSafely(
          seedTargetId,
          terminal.component,
        );
        if (
          !providerArchiveStringArraysEqual(
            deleted.deletedTargetIds,
            terminal.component.targetIds,
          )
          || !providerArchiveStringArraysEqual(
            deleted.deletedCutIds,
            terminal.component.cutIds,
          )
        ) {
          throw new ChatPaneStoreError(
            "corrupt_state",
            "V57 terminal cleanup did not delete its exact component.",
          );
        }
        deletedTargetIds.push(...deleted.deletedTargetIds);
        deletedCutIds.push(...deleted.deletedCutIds);
      }

      deletedTargetIds.sort(compareProviderArchiveCodeUnits);
      deletedCutIds.sort(compareProviderArchiveCodeUnits);
      if (
        new Set(deletedTargetIds).size !== deletedTargetIds.length
        || new Set(deletedCutIds).size !== deletedCutIds.length
      ) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "V57 terminal cleanup returned duplicate authority identifiers.",
        );
      }
      const remainingCommittedTargetIds = Object.freeze(
        this.#verifiedProviderThreadArchiveCommittedTargetsV57().map(
          ({ targetId }) => targetId,
        ),
      );
      const remainingCommittedTargetIdSet = new Set(
        remainingCommittedTargetIds,
      );
      if (deletedTargetIds.some((targetId) =>
        remainingCommittedTargetIdSet.has(targetId)
      )) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "V57 terminal cleanup retained authority it reported deleted.",
        );
      }
      const partitionedTargetIds = [
        ...deletedTargetIds,
        ...remainingCommittedTargetIds,
      ].sort(compareProviderArchiveCodeUnits);
      if (!providerArchiveStringArraysEqual(
        partitionedTargetIds,
        expectedTargetIds,
      )) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "V57 terminal cleanup did not partition the approved target set.",
        );
      }

      const recoveryInventory = this.verifyProviderThreadArchiveRecoveryV57();
      return Object.freeze({
        cleanup: Object.freeze({
          deletedTargetIds: Object.freeze(deletedTargetIds),
          deletedCutIds: Object.freeze(deletedCutIds),
        }),
        recoveryInventory,
      });
    })();
  }

  /**
   * Reopens one exact target/cut component without releasing its authority.
   * Committed postimages are always verified, but their replay values are
   * returned only after every target in the component is committed.
   */
  verifiedProviderThreadArchiveTerminalComponentV57(
    seedTargetIdValue: string,
  ): ChatProviderThreadArchiveTerminalComponentV57 {
    const seedTargetId = providerArchiveTargetIdSchema.parse(
      seedTargetIdValue,
    );
    return this.#database.transaction(() => {
      const journal = this.#requireProviderThreadArchiveJournalV57();
      const component = journal.terminalCleanupComponent(seedTargetId);
      const canonicalTargetIds = [...component.targetIds]
        .sort(compareProviderArchiveCodeUnits);
      const canonicalCutIds = [...component.cutIds]
        .sort(compareProviderArchiveCodeUnits);
      if (
        component.targetIds.length === 0
        || !component.targetIds.includes(seedTargetId)
        || new Set(component.targetIds).size !== component.targetIds.length
        || new Set(component.cutIds).size !== component.cutIds.length
        || component.targetIds.some((targetId, index) =>
          targetId !== canonicalTargetIds[index]
        )
        || component.cutIds.some((cutId, index) =>
          cutId !== canonicalCutIds[index]
        )
      ) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "The v57 terminal component is not canonical.",
        );
      }

      const accountProfileId = accountProfileIdSchema.parse(
        component.accountProfileId,
      );
      const componentCutIds = new Set(component.cutIds);
      const committedFinalizations = new Map<
        string,
        ChatProviderThreadArchiveFinalizationV57Result
      >();
      const verifiedTargets = component.targetIds.map((targetId) => {
        const target = journal.reopenTarget(targetId);
        const targetRow = this.#providerArchiveTargetAuthorityRowV57(targetId);
        if (
          target.targetId !== targetId
          || targetRow.target_id !== targetId
          || targetRow.pane_id !== target.paneId
          || targetRow.purpose !== target.purpose
          || targetRow.status !== target.status
          || targetRow.account_profile_id !== accountProfileId
          || target.attempts.some((attempt) =>
            attempt.cutId !== null && !componentCutIds.has(attempt.cutId)
          )
        ) {
          throw new ChatPaneStoreError(
            "corrupt_state",
            "A v57 terminal target crossed its exact component authority.",
          );
        }
        this.#assertProviderArchiveTargetStoreAuthorityV57(target);
        if (target.status === "committed") {
          committedFinalizations.set(
            targetId,
            this.#replayCommittedProviderThreadArchiveFinalizationV57({
              target,
              targetRow,
              containmentReceipt:
                this.#providerArchiveFinalizationContainmentReceiptV57(
                  target,
                ),
            }),
          );
        }
        return Object.freeze({
          targetId,
          paneId: chatPaneIdSchema.parse(target.paneId),
        });
      });
      for (const cutId of component.cutIds) {
        const cut = journal.reopenCut(cutId);
        if (cut.cutId !== cutId || cut.accountProfileId !== accountProfileId) {
          throw new ChatPaneStoreError(
            "corrupt_state",
            "A v57 terminal cut crossed its exact component authority.",
          );
        }
      }
      const allTargetsCommitted = committedFinalizations.size ===
        verifiedTargets.length;
      if (component.allTargetsCommitted !== allTargetsCommitted) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "The v57 terminal component commitment state changed.",
        );
      }
      const targets = Object.freeze(verifiedTargets);
      const finalizations = component.allTargetsCommitted
        ? Object.freeze(targets.map(({ targetId, paneId }) =>
          Object.freeze({
            targetId,
            paneId,
            result: committedFinalizations.get(targetId) ?? corrupt(
              "A committed v57 terminal component lost its finalization replay.",
            ),
          })
        ))
        : Object.freeze([]);
      return Object.freeze({ component, targets, finalizations });
    })();
  }

  /**
   * Returns the immutable provider thread owned by one open v57 target only
   * after revalidating its complete keyed Store preimage in one read cut.
   */
  providerThreadArchiveTargetBindingV57(targetIdValue: string): ChatThreadBinding {
    const targetId = providerArchiveTargetIdSchema.parse(targetIdValue);
    return this.#database.transaction(() => {
      const target = this.#requireProviderThreadArchiveJournalV57()
        .reopenTarget(targetId);
      return Object.freeze(
        this.#assertProviderArchiveTargetPreimageV57(target).authority.binding,
      );
    })();
  }

  /** Read-only proof that this pane still owns unresolved local provider work. */
  hasUnsettledProviderEffectAuthorityV57(paneIdValue: ChatPaneId): boolean {
    const paneId = chatPaneIdSchema.parse(paneIdValue);
    return this.#database.transaction(() => {
      const row = this.#providerArchiveLivePaneRowV57(paneId);
      if (row.interaction_mode !== "chat") return true;
      return this.#providerArchivePaneHasUnsettledLocalEffectsV57(paneId);
    })();
  }

  /** Reopens every v57 authority and checks its current store-owned preimage. */
  verifyProviderThreadArchiveRecoveryV57():
    ProviderThreadArchiveRecoveryInventoryV57 {
    return this.#database.transaction(() => {
      const journal = this.#requireProviderThreadArchiveJournalV57();
      const inventory = journal.recoveryInventory();
      const cuts = new Map(
        inventory.activeCuts.map((cut) => [cut.cutId, cut] as const),
      );
      for (
        const target of this.#verifiedProviderThreadArchiveCommittedTargetsV57()
      ) {
        for (const attempt of target.attempts) {
          if (attempt.cutId === null) continue;
          const attemptCut = journal.reopenCut(attempt.cutId);
          cuts.set(attemptCut.cutId, attemptCut);
        }
      }
      for (const target of inventory.targets) {
        this.#assertProviderArchiveTargetStoreAuthorityV57(target);
        this.#assertNoConflictingLegacyArchiveV57(target.paneId);
        for (const attempt of target.attempts) {
          if (attempt.cutId === null) continue;
          const attemptCut = journal.reopenCut(attempt.cutId);
          cuts.set(attemptCut.cutId, attemptCut);
        }
        const currentCut = target.currentAttempt.cutId === null
          ? null
          : journal.reopenCut(target.currentAttempt.cutId);
        if (target.status === "account_contained") {
          this.#assertProviderArchiveAccountContainedTargetPostimageV57(
            target,
          );
          continue;
        }
        const firstAttempt = target.attempts[0];
        if (firstAttempt === undefined) {
          throw new ChatPaneStoreError(
            "corrupt_state",
            "A v57 archive target lost its initial generation authority.",
          );
        }
        const pane = target.purpose === "start_fresh"
          ? this.#preflightStartFreshProviderContextV57({
              paneId: chatPaneIdSchema.parse(target.paneId),
              expectedRevision: this.#providerArchiveLivePaneRowV57(
                target.paneId,
              ).revision,
              expectedQueueRevision: this.#providerArchiveLivePaneRowV57(
                target.paneId,
              ).message_queue_revision,
            }, target.targetId)
          : this.#preflightPaneArchive(
              chatPaneIdSchema.parse(target.paneId),
              this.#providerArchiveLivePaneRowV57(target.paneId).revision,
              target.targetId,
            );
        if (pane.projection.interactionMode !== "chat") {
          throw new ChatPaneStoreError(
            "corrupt_state",
            "A v57 archive target no longer owns an ordinary pane.",
          );
        }
        this.#assertMessageQueueClosableForPane(
          chatPaneIdSchema.parse(target.paneId),
        );
        this.#requirePaneArchiveCompatibilityV57(
          chatPaneIdSchema.parse(target.paneId),
        );
        const authority = this.#providerThreadArchivePaneAuthorityV57(
          target.paneId,
        );
        if (
          authority.ownership.kind !== "ordinary" ||
          authority.ownership.accountProfileId !==
            authority.binding.accountProfileId ||
          authority.ownership.generation !== firstAttempt.generation
        ) {
          throw new ChatPaneStoreError(
            "revision_conflict",
            "A v57 archive target lost its exact source-generation ownership.",
          );
        }
        this.#assertProviderArchiveSourceCohortPreflightV57(
          authority.binding.accountProfileId,
          firstAttempt.generation,
        );
        this.#assertProviderArchiveCurrentAccountAuthorityV57(
          authority.binding.accountProfileId,
          target.currentAttempt,
          currentCut,
        );
        journal.assertTargetPreimage(
          target.targetId,
          this.#providerThreadArchiveTargetPreimageV57({
            authority,
            purpose: target.purpose,
            accountProfileRevision: firstAttempt.accountProfileRevision,
          }),
        );
      }
      for (const cut of cuts.values()) {
        if (cut.cause !== "account_removal") {
          this.#assertProviderArchiveLostResponseCutAuthorityV57(cut);
        }
        for (const storedMember of cut.members) {
          if (storedMember.state === "settled") {
            this.#assertProviderArchiveSettledMemberPostimageV57(
              cut,
              storedMember,
            );
            continue;
          }
          const authority = this.#providerThreadArchivePaneAuthorityV57(
            storedMember.paneId,
          );
          journal.assertMemberPreimage(storedMember.memberId, {
            paneId: authority.row.pane_id,
            paneRevision: authority.row.revision,
            paneCasDigest: authority.paneCasDigest,
            threadId: authority.binding.threadId,
            restartThreadId: authority.binding.restartThreadId,
            binding: authority.bindingPreimage,
          });
        }
        if ([
          "sealed",
          "removal_awaiting_tombstone",
          "contained",
        ].includes(cut.state)) {
          this.#assertProviderArchiveSealedInventoryPostimageV57(cut);
        }
        if (cut.state === "contained" && cut.cause !== "account_removal") {
          this.markProviderThreadArchiveCutContainedV57({
            cutId: cut.cutId,
            now: new Date(0),
          });
        }
      }
      return inventory;
    })();
  }

  /**
   * Verified startup exclusion set for every live v57 target and every member
   * of a cut still referenced by one of those uncommitted targets.
   */
  providerThreadArchiveRecoveryPaneIdsV57(): readonly ChatPaneId[] {
    return this.#database.transaction(() => {
      const inventory = this.verifyProviderThreadArchiveRecoveryV57();
      const paneIds = new Set<ChatPaneId>();
      const cutIds = new Set<string>(
        inventory.activeCuts.map((cut) => cut.cutId),
      );
      for (const target of inventory.targets) {
        paneIds.add(chatPaneIdSchema.parse(target.paneId));
        for (const attempt of target.attempts) {
          if (attempt.cutId !== null) cutIds.add(attempt.cutId);
        }
      }
      const journal = this.#requireProviderThreadArchiveJournalV57();
      for (const cutId of cutIds) {
        const cut = journal.reopenCut(cutId);
        for (const member of cut.members) {
          paneIds.add(chatPaneIdSchema.parse(member.paneId));
        }
        if (
          ["fence_started", "fenced"].includes(cut.state) &&
          cut.cause !== "account_removal"
        ) {
          const current =
            this.#enumerateProviderThreadArchiveSourceOwnershipV57({
              cut,
              accountProfileId: accountProfileIdSchema.parse(
                cut.accountProfileId,
              ),
              sourceGeneration: cut.sourceGeneration,
              now: new Date(0),
              allowSettledPostimages: false,
            });
          for (const member of current.members) {
            paneIds.add(chatPaneIdSchema.parse(member.paneId));
          }
        }
      }
      return Object.freeze(
        [...paneIds].sort(compareProviderArchiveCodeUnits),
      );
    })();
  }

  /**
   * Canonically enumerates the complete live pane inventory owned by one
   * archive cut's account and source generation. This method is read-only.
   */
  enumerateProviderThreadArchiveSourceOwnershipV57(input: Readonly<{
    readonly cutId: string;
    readonly accountProfileId: ChatAccountProfileId;
    readonly sourceGeneration: number;
    readonly now: Date;
  }>): ChatProviderThreadArchiveSourceOwnershipV57 {
    const accountProfileId = accountProfileIdSchema.parse(
      input.accountProfileId,
    );
    validateRevision(input.sourceGeneration);
    const now = new Date(isoDateTimeSchema.parse(input.now.toISOString()));
    return this.#database.transaction(() => {
      const cut = this.#requireProviderThreadArchiveJournalV57().reopenCut(
        input.cutId,
      );
      if (!["fenced", "sealed"].includes(cut.state)) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "The v57 cut is not available for caller-owned source enumeration.",
        );
      }
      this.#assertProviderArchiveLostResponseCutAuthorityV57(cut);
      return this.#enumerateProviderThreadArchiveSourceOwnershipV57({
        cut,
        accountProfileId,
        sourceGeneration: input.sourceGeneration,
        now,
        allowSettledPostimages: false,
      });
    })();
  }

  /**
   * Applies one frozen member's complete local containment cut and records the
   * keyed journal settlement last in the same SQLite transaction.
   */
  settleProviderThreadArchiveMemberV57(
    input: ChatProviderThreadArchiveMemberSettlementV57Input,
  ): ChatProviderThreadArchiveMemberSettlementV57Result {
    const memberId = providerArchiveMemberIdSchema.parse(input.memberId);
    const now = new Date(isoDateTimeSchema.parse(input.now.toISOString()));
    return this.#database.transaction(() => {
      const journal = this.#requireProviderThreadArchiveJournalV57();
      const stored = this.#providerArchiveMemberAuthorityRowV57(memberId);
      const cut = journal.reopenCut(stored.cut_id);
      const member = cut.members.find((candidate) =>
        candidate.memberId === memberId
      );
      if (member === undefined || member.state !== stored.state) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "The v57 member authority disagrees with its keyed cut inventory.",
        );
      }
      if (cut.cause === "account_removal") {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Account-removal member settlement is not owned by ChatPaneStore.",
        );
      }
      this.#assertProviderArchiveLostResponseCutAuthorityV57(cut);
      this.#assertProviderArchiveSourceSealAuthorityV57(cut);
      this.#assertProviderArchiveSealedInventoryPostimageV57(cut);
      if (stored.state === "settled") {
        this.#assertProviderArchiveSettledMemberPostimageV57(cut, member);
        return { member, pane: this.get(stored.pane_id)?.projection ?? null };
      }
      if (cut.state !== "sealed") {
        throw new ChatPaneStoreError(
          "invalid_state",
          "The v57 member is not pending in a sealed containment cut.",
        );
      }
      this.#assertNoPendingProviderThreadArchiveAuthorityV57(
        stored.pane_id,
        stored.target_id,
        stored.member_id,
        false,
        stored.target_attempt_ordinal,
      );
      this.#assertNoConflictingLegacyArchiveV57(stored.pane_id);
      const authority = this.#providerThreadArchivePaneAuthorityV57(
        stored.pane_id,
      );
      if (
        authority.binding.accountProfileId !== cut.accountProfileId ||
        authority.row.revision !== stored.pane_revision
      ) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "The v57 member lost its exact account or pane revision authority.",
        );
      }
      journal.assertMemberPreimage(stored.member_id, {
        paneId: authority.row.pane_id,
        paneRevision: authority.row.revision,
        paneCasDigest: authority.paneCasDigest,
        threadId: authority.binding.threadId,
        restartThreadId: authority.binding.restartThreadId,
        binding: authority.bindingPreimage,
      });
      const requiresDetachment = stored.action === "detach_binding_only";
      if (stored.action === "contain_generation_context") {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Harness generation containment is not available in this v57 phase.",
        );
      }
      let pane: ChatPaneProjection;
      if (requiresDetachment) {
        pane = this.#containProviderThreadArchiveMemberLocallyV57({
          stored,
          cut,
          authority,
          now,
        });
      } else {
        if (stored.action !== "preserved_target") {
          throw new ChatPaneStoreError(
            "corrupt_state",
            "The v57 member action has no safe local settlement.",
          );
        }
        pane = this.require(stored.pane_id).projection;
      }
      const settlementEvidenceDigest = this.#providerArchiveHmacV57(
        "member-settlement-evidence",
        {
          memberId: stored.member_id,
          cutId: stored.cut_id,
          paneId: stored.pane_id,
          role: stored.role,
          action: stored.action,
          cause: cut.cause,
          sourceGeneration: cut.sourceGeneration,
          detached: requiresDetachment,
        },
      );
      const settlementRevisionDigest = this.#providerArchiveHmacV57(
        "member-settlement-revision",
        requiresDetachment
          ? {
              memberId: stored.member_id,
              frozenPaneRevision: stored.pane_revision,
              settledPaneRevision: pane.revision,
              settledQueueRevision: pane.messageQueue.revision,
              providerContextResetRequired: true,
            }
          : {
              memberId: stored.member_id,
              frozenPaneRevision: stored.pane_revision,
              paneCasDigest: stored.pane_cas_digest,
              providerContextResetRequired: false,
            },
      );
      const settled = journal.settleMember({
        memberId: stored.member_id,
        settlementEvidenceDigest,
        settlementRevisionDigest,
        now,
      });
      this.#assertProviderArchiveSettledMemberPostimageV57(cut, settled);
      return { member: settled, pane };
    })();
  }

  sealProviderThreadArchiveSourceInventoryV57(input: Readonly<{
    readonly cutId: string;
    readonly now: Date;
  }>): ProviderThreadArchiveCutSnapshotV57 {
    const cutId = providerArchiveCutIdSchema.parse(input.cutId);
    const now = new Date(isoDateTimeSchema.parse(input.now.toISOString()));
    return this.#database.transaction(() => {
      const journal = this.#requireProviderThreadArchiveJournalV57();
      const cut = journal.reopenCut(cutId);
      if (cut.cause !== "account_removal") {
        this.#assertProviderArchiveLostResponseCutAuthorityV57(cut);
      }
      if (["sealed", "contained"].includes(cut.state)) {
        this.#assertProviderArchiveSourceSealAuthorityV57(cut);
        this.#assertProviderArchiveSealedInventoryPostimageV57(cut);
        return cut;
      }
      if (cut.state !== "fenced" || cut.cause === "account_removal") {
        throw new ChatPaneStoreError(
          "invalid_state",
          "The v57 source cut is not ready for ordinary inventory sealing.",
        );
      }
      const enumeration =
        this.#enumerateProviderThreadArchiveSourceOwnershipV57({
          cut,
          accountProfileId: accountProfileIdSchema.parse(
            cut.accountProfileId,
          ),
          sourceGeneration: cut.sourceGeneration,
          now,
          allowSettledPostimages: false,
        });
      for (const member of enumeration.members) {
        journal.addCutMember(member);
      }
      return journal.sealCutInventory({
        cutId,
        expectedMemberCount: enumeration.expectedMemberCount,
        expectedInventoryDigest: enumeration.expectedInventoryDigest,
        enumerationAuthorityDigest: enumeration.enumerationAuthorityDigest,
        sealRevisionDigest: this.#providerArchiveHmacV57(
          "source-inventory-seal-revision",
          {
            cutId,
            sourceGeneration: cut.sourceGeneration,
            successorGeneration: cut.successorGeneration,
            expectedMemberCount: enumeration.expectedMemberCount,
            expectedInventoryDigest: enumeration.expectedInventoryDigest,
            enumerationAuthorityDigest:
              enumeration.enumerationAuthorityDigest,
          },
        ),
        now,
      });
    })();
  }

  markProviderThreadArchiveCutContainedV57(input: Readonly<{
    readonly cutId: string;
    readonly now: Date;
  }>): ProviderThreadArchiveCutSnapshotV57 {
    const cutId = providerArchiveCutIdSchema.parse(input.cutId);
    const now = new Date(isoDateTimeSchema.parse(input.now.toISOString()));
    return this.#database.transaction(() => {
      const journal = this.#requireProviderThreadArchiveJournalV57();
      const cut = journal.reopenCut(cutId);
      if (cut.cause === "account_removal") {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Account-removal containment is not owned by ChatPaneStore.",
        );
      }
      this.#assertProviderArchiveLostResponseCutAuthorityV57(cut);
      if (!["sealed", "contained"].includes(cut.state)) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "The v57 source cut is not sealed for containment.",
        );
      }
      this.#assertProviderArchiveSourceSealAuthorityV57(cut);
      for (const member of cut.members) {
        if (member.state !== "settled") {
          throw new ChatPaneStoreError(
            "invalid_state",
            "The v57 source cut still has an unsettled member.",
          );
        }
        this.#assertProviderArchiveSettledMemberPostimageV57(cut, member);
      }
      this.#assertProviderArchiveSealedInventoryPostimageV57(cut);
      const cutRow = this.#providerArchiveCutAuthorityRowV57(cutId);
      const containmentEvidenceDigest = this.#providerArchiveHmacV57(
        "source-cut-containment-evidence",
        {
          cutId,
          sourceGeneration: cut.sourceGeneration,
          successorGeneration: cut.successorGeneration,
          members: cut.members.map((member) => ({
            memberId: member.memberId,
            paneId: member.paneId,
            role: member.role,
            action: member.action,
            state: member.state,
          })),
        },
      );
      const containmentRevisionDigest = this.#providerArchiveHmacV57(
        "source-cut-containment-revision",
        {
          cutId,
          cutIdentityHmac: cutRow.identity_hmac,
          fenceHmac: cutRow.fence_hmac,
          sealHmac: cutRow.seal_hmac,
          successorGeneration: cutRow.successor_generation,
          successorAccountProfileRevision:
            cutRow.successor_account_profile_revision,
          memberCount: cutRow.member_count,
          inventoryDigest: cutRow.inventory_digest,
        },
      );
      if (cut.state === "contained") {
        if (
          cutRow.containment_evidence_digest !== containmentEvidenceDigest ||
          cutRow.containment_revision_digest !== containmentRevisionDigest ||
          cutRow.containment_hmac === null
        ) {
          throw new ChatPaneStoreError(
            "corrupt_state",
            "The contained v57 cut lacks its exact store-owned containment authority.",
          );
        }
        return cut;
      }
      if (cutRow.state !== "sealed") {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "The v57 source cut state disagrees with its keyed snapshot.",
        );
      }
      return journal.markCutContained({
        cutId,
        containmentEvidenceDigest,
        containmentRevisionDigest,
        now,
      });
    })();
  }

  recordProviderThreadArchiveReconciliationV57(input: Readonly<{
    readonly targetId: string;
    readonly result: ChatProviderThreadArchiveReconciliationV57;
    readonly now: Date;
  }>): Readonly<{
    readonly disposition: ChatProviderThreadArchiveReconciliationV57["disposition"];
    readonly descriptor: ReturnType<
      ProviderThreadArchiveJournalV57["admissionDescriptor"]
    >;
  }> {
    const targetId = providerArchiveTargetIdSchema.parse(input.targetId);
    const now = new Date(isoDateTimeSchema.parse(input.now.toISOString()));
    return this.#database.transaction(() => {
      const journal = this.#requireProviderThreadArchiveJournalV57();
      const target = journal.reopenTarget(targetId);
      const { targetRow, attemptRow, cut } =
        this.#assertProviderArchiveTargetPreimageV57(target);
      if (cut === null || cut.state !== "contained") {
        throw new ChatPaneStoreError(
          "invalid_state",
          "The v57 archive result cannot reconcile before exact containment.",
        );
      }
      this.#assertProviderArchiveSourceContainedAuthorityV57(cut);
      if (input.result.disposition === "ambiguous") {
        if (target.currentAttempt.state !== "ambiguous") {
          throw new ChatPaneStoreError(
            "revision_conflict",
            "A repeated reconciliation ambiguity cannot rewrite a terminal result.",
          );
        }
        return Object.freeze({
          disposition: "ambiguous" as const,
          descriptor: journal.admissionDescriptor(targetId),
        });
      }
      const providerReceipt = boundedOpaqueReceipt(
        input.result.disposition === "applied"
          ? input.result.providerContainmentReceipt
          : input.result.providerReconciliationReceipt,
      );
      if (
        input.result.disposition === "applied"
        && (!Number.isSafeInteger(input.result.responseStreamPosition)
          || input.result.responseStreamPosition < 0)
      ) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "The reconciled archive response position is invalid.",
        );
      }
      const evidenceDigest = this.#providerArchiveHmacV57(
        `reconciliation-${input.result.disposition}-evidence`,
        {
          targetId,
          attemptId: target.currentAttempt.attemptId,
          cutId: cut.cutId,
          sourceGeneration: cut.sourceGeneration,
          successorGeneration: cut.successorGeneration,
          result: input.result,
          providerReceipt,
        },
      );
      const revisionDigest = this.#providerArchiveHmacV57(
        `reconciliation-${input.result.disposition}-revision`,
        {
          targetIdentityHmac: targetRow.identity_hmac,
          attemptIdentityHmac: attemptRow.identity_hmac,
          attemptAmbiguityHmac: attemptRow.ambiguity_hmac,
          cutContainmentHmac:
            this.#providerArchiveCutAuthorityRowV57(cut.cutId)
              .containment_hmac,
          outcomeEvidenceDigest: evidenceDigest,
        },
      );
      const expectedState = input.result.disposition === "applied"
        ? "reconciled_applied"
        : "reconciled_not_applied";
      if (target.currentAttempt.state === expectedState) {
        if (
          attemptRow.outcome_evidence_digest !== evidenceDigest
          || attemptRow.outcome_revision_digest !== revisionDigest
          || (input.result.disposition === "applied" && (
            attemptRow.response_generation !==
              input.result.responseGeneration
            || attemptRow.response_stream_position !==
              input.result.responseStreamPosition
          ))
          || (input.result.disposition === "not_applied" && (
            attemptRow.response_generation !== null
            || attemptRow.response_stream_position !== null
          ))
        ) {
          throw new ChatPaneStoreError(
            "revision_conflict",
            "The v57 reconciliation result changed after it was recorded.",
          );
        }
      } else {
        if (target.currentAttempt.state !== "ambiguous") {
          throw new ChatPaneStoreError(
            "revision_conflict",
            "The v57 target no longer owns an ambiguous reconciliation.",
          );
        }
        if (input.result.disposition === "applied") {
          validateRevision(input.result.responseGeneration);
          journal.recordReconciledApplied({
            attemptId: target.currentAttempt.attemptId,
            responseGeneration: input.result.responseGeneration,
            responseStreamPosition: input.result.responseStreamPosition,
            outcomeEvidenceDigest: evidenceDigest,
            outcomeRevisionDigest: revisionDigest,
            now,
          });
        } else {
          journal.recordReconciledNotApplied({
            attemptId: target.currentAttempt.attemptId,
            outcomeEvidenceDigest: evidenceDigest,
            outcomeRevisionDigest: revisionDigest,
            now,
          });
        }
      }
      return Object.freeze({
        disposition: input.result.disposition,
        descriptor: journal.admissionDescriptor(targetId),
      });
    })();
  }

  appendProviderThreadArchiveSuccessorWaveEffectStartedV57(input: Readonly<{
    readonly cutId: string;
    readonly attempts: readonly Readonly<{
      readonly targetId: string;
      readonly attemptId: string;
    }>[];
    readonly now: Date;
  }>): readonly ReturnType<
    ProviderThreadArchiveJournalV57["admissionDescriptor"]
  >[] {
    const cutId = providerArchiveCutIdSchema.parse(input.cutId);
    if (input.attempts.length < 1 || input.attempts.length > CHAT_MAX_PANES) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The v57 successor wave has an invalid target count.",
      );
    }
    const attempts = input.attempts.map((attempt) => Object.freeze({
      targetId: providerArchiveTargetIdSchema.parse(attempt.targetId),
      attemptId: providerArchiveAttemptIdSchema.parse(attempt.attemptId),
    })).sort((left, right) =>
      compareProviderArchiveCodeUnits(left.targetId, right.targetId)
    );
    if (
      new Set(attempts.map(({ targetId }) => targetId)).size !== attempts.length
      || new Set(attempts.map(({ attemptId }) => attemptId)).size !==
        attempts.length
    ) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The v57 successor wave contains duplicate authority.",
      );
    }
    const now = new Date(isoDateTimeSchema.parse(input.now.toISOString()));
    return this.#database.transaction(() => {
      const journal = this.#requireProviderThreadArchiveJournalV57();
      const cut = journal.reopenCut(cutId);
      if (
        cut.cause === "account_removal" || cut.state !== "contained" ||
        cut.successorGeneration !== cut.sourceGeneration + 1 ||
        cut.successorAccountProfileRevision === null
      ) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "The v57 successor wave lacks one contained predecessor cut.",
        );
      }
      this.#assertProviderArchiveSourceContainedAuthorityV57(cut);
      const targetValues: unknown[] = this.#database.query(`
        SELECT DISTINCT target.target_id
        FROM chat_provider_thread_archive_targets_v57 AS target
        JOIN chat_provider_thread_archive_attempts_v57 AS prior
          ON prior.target_id = target.target_id
        WHERE prior.cut_id = ?1
        ORDER BY target.target_id
      `).all(cutId);
      const associatedTargets = targetValues.map((value) =>
        journal.reopenTarget(z.object({
          target_id: providerArchiveTargetIdSchema,
        }).strict().parse(value).target_id)
      );
      const cohort = associatedTargets.flatMap((target) => {
        if (
          target.currentAttempt.cutId === cutId &&
          target.currentAttempt.state === "ambiguous"
        ) {
          throw new ChatPaneStoreError(
            "invalid_state",
            "Every target in the v57 cut must reconcile before successor admission.",
          );
        }
        if (
          target.currentAttempt.cutId === cutId &&
          target.currentAttempt.state === "reconciled_not_applied"
        ) {
          return [{ target, predecessor: target.currentAttempt, replay: false }];
        }
        const predecessor = target.attempts[target.attempts.length - 2];
        if (
          target.currentAttempt.state === "effect_started" &&
          predecessor?.cutId === cutId &&
          predecessor.state === "reconciled_not_applied"
        ) {
          return [{ target, predecessor, replay: true }];
        }
        if (
          target.currentAttempt.cutId === cutId &&
          target.currentAttempt.state === "reconciled_applied"
        ) {
          if (target.status !== "committed") {
            throw new ChatPaneStoreError(
              "invalid_state",
              "Every applied v57 cut sibling must commit before successor admission.",
            );
          }
          return [];
        }
        throw new ChatPaneStoreError(
          "revision_conflict",
          "A v57 cut target no longer occupies its exact reconciliation wave.",
        );
      }).sort((left, right) =>
        compareProviderArchiveCodeUnits(
          left.target.targetId,
          right.target.targetId,
        )
      );
      if (
        cohort.length !== attempts.length ||
        cohort.some(({ target }, index) =>
          target.targetId !== attempts[index]?.targetId
        ) ||
        cohort.some(({ target, replay }, index) =>
          replay && target.currentAttempt.attemptId !== attempts[index]?.attemptId
        ) ||
        (cohort.some(({ replay }) => replay) &&
          cohort.some(({ replay }) => !replay))
      ) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "The supplied v57 successors do not exactly equal the complete not-applied cohort.",
        );
      }
      const prepared = cohort.map(({ target, predecessor, replay }, index) => {
        const attemptId = attempts[index]?.attemptId ?? corrupt(
          "The v57 successor cohort lost its canonical attempt.",
        );
        const verified = this.#assertProviderArchiveTargetPreimageV57(target);
        const generation = predecessor.generation + 1;
        if (generation !== cut.successorGeneration) {
          throw new ChatPaneStoreError(
            "revision_conflict",
            "A v57 successor left its exact N plus one generation.",
          );
        }
        const requestEvidenceDigest = this.#providerArchiveHmacV57(
          "successor-request-evidence",
          {
            targetId: target.targetId,
            attemptId,
            predecessorAttemptId: predecessor.attemptId,
            predecessorCutId: cutId,
            generation,
            paneId: target.paneId,
            purpose: target.purpose,
            binding: verified.authority.bindingPreimage,
          },
        );
        const requestRevisionDigest = this.#providerArchiveHmacV57(
          "successor-request-revision",
          {
            targetIdentityHmac: verified.targetRow.identity_hmac,
            predecessorAttemptIdentityHmac:
              this.#providerArchiveAttemptAuthorityRowV57(
                predecessor.attemptId,
              ).identity_hmac,
            predecessorCutContainmentHmac:
              this.#providerArchiveCutAuthorityRowV57(cutId).containment_hmac,
            accountProfileRevision: cut.successorAccountProfileRevision,
          },
        );
        const effectEvidenceDigest = this.#providerArchiveHmacV57(
          "successor-effect-evidence",
          {
            targetId: target.targetId,
            attemptId,
            generation,
            predecessorAttemptId: predecessor.attemptId,
          },
        );
        const effectRevisionDigest = this.#providerArchiveHmacV57(
          "successor-effect-revision",
          {
            requestEvidenceDigest,
            requestRevisionDigest,
            accountProfileRevision: cut.successorAccountProfileRevision,
          },
        );
        if (replay) {
          const current = this.#providerArchiveAttemptAuthorityRowV57(attemptId);
          if (
            current.generation !== generation ||
            current.account_profile_revision !==
              cut.successorAccountProfileRevision ||
            current.request_evidence_digest !== requestEvidenceDigest ||
            current.request_revision_digest !== requestRevisionDigest ||
            current.effect_evidence_digest !== effectEvidenceDigest ||
            current.effect_revision_digest !== effectRevisionDigest
          ) {
            throw new ChatPaneStoreError(
              "revision_conflict",
              "The v57 successor effect changed after its atomic wave.",
            );
          }
        }
        return {
          target,
          attemptId,
          generation,
          requestEvidenceDigest,
          requestRevisionDigest,
          effectEvidenceDigest,
          effectRevisionDigest,
          replay,
        };
      });
      if (prepared.every(({ replay }) => replay)) {
        return this.#providerThreadArchiveSuccessorWaveReadyV57(cutId);
      }
      for (const successor of prepared) {
        journal.appendSuccessorAttempt({
          targetId: successor.target.targetId,
          attemptId: successor.attemptId,
          generation: successor.generation,
          accountProfileRevision: cut.successorAccountProfileRevision,
          requestEvidenceDigest: successor.requestEvidenceDigest,
          requestRevisionDigest: successor.requestRevisionDigest,
          now,
        });
      }
      for (const successor of prepared) {
        journal.markEffectStarted({
          attemptId: successor.attemptId,
          effectEvidenceDigest: successor.effectEvidenceDigest,
          effectRevisionDigest: successor.effectRevisionDigest,
          now,
        });
      }
      return this.#providerThreadArchiveSuccessorWaveReadyV57(cutId);
    })();
  }

  /**
   * Rechecks the complete frozen predecessor-cut cohort immediately before
   * any successor-generation provider RPC is claimed.
   */
  assertProviderThreadArchiveSuccessorWaveReadyV57(input: Readonly<{
    readonly cutId: string;
  }>): readonly ReturnType<
    ProviderThreadArchiveJournalV57["admissionDescriptor"]
  >[] {
    const cutId = providerArchiveCutIdSchema.parse(input.cutId);
    return this.#database.transaction(() =>
      this.#providerThreadArchiveSuccessorWaveReadyV57(cutId)
    )();
  }

  appendProviderThreadArchiveSuccessorEffectStartedV57(input: Readonly<{
    readonly targetId: string;
    readonly attemptId: string;
    readonly now: Date;
  }>): ReturnType<ProviderThreadArchiveJournalV57["admissionDescriptor"]> {
    const targetId = providerArchiveTargetIdSchema.parse(input.targetId);
    return this.#database.transaction(() => {
      const target = this.#requireProviderThreadArchiveJournalV57()
        .reopenTarget(targetId);
      const predecessor = target.currentAttempt.state === "effect_started"
        ? target.attempts[target.attempts.length - 2]
        : target.currentAttempt;
      if (predecessor?.cutId === null || predecessor?.cutId === undefined) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "The v57 successor lacks a contained predecessor cut.",
        );
      }
      const descriptors =
        this.appendProviderThreadArchiveSuccessorWaveEffectStartedV57({
          cutId: predecessor.cutId,
          attempts: [{ targetId, attemptId: input.attemptId }],
          now: input.now,
        });
      return descriptors[0] ?? corrupt(
        "The v57 single-target successor wave returned no descriptor.",
      );
    })();
  }

  finalizeProviderThreadArchiveTargetV57(input: Readonly<{
    readonly targetId: string;
    readonly now: Date;
  }>): ChatProviderThreadArchiveFinalizationV57Result {
    const targetId = providerArchiveTargetIdSchema.parse(input.targetId);
    const now = new Date(isoDateTimeSchema.parse(input.now.toISOString()));
    return this.#database.transaction(() => {
      const journal = this.#requireProviderThreadArchiveJournalV57();
      const target = journal.reopenTarget(targetId);
      const targetRow = this.#providerArchiveTargetAuthorityRowV57(targetId);
      this.#assertProviderArchiveTargetStoreAuthorityV57(target);
      if (target.currentAttempt.cutId !== null) {
        this.#assertProviderArchiveSourceContainedAuthorityV57(
          journal.reopenCut(target.currentAttempt.cutId),
        );
      }
      const containmentReceipt =
        this.#providerArchiveFinalizationContainmentReceiptV57(target);
      if (target.status === "committed") {
        return this.#replayCommittedProviderThreadArchiveFinalizationV57({
          target,
          targetRow,
          containmentReceipt,
        });
      }
      const verified = this.#assertProviderArchiveTargetPreimageV57(target);
      if (
        target.currentAttempt.state !== "direct_applied"
        && target.currentAttempt.state !== "reconciled_applied"
      ) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "The v57 target lacks an exact applied result for finalization.",
        );
      }
      const localResult = target.purpose === "pane_archive"
        ? Object.freeze({
            kind: "pane_archive" as const,
            removed: this.#finalizeProviderThreadArchivePaneV57({
              targetRow: verified.targetRow,
              containmentReceipt,
              now,
            }),
            containmentReceipt,
          })
        : (() => {
            const reset = this.#finalizeProviderThreadArchiveStartFreshV57({
              targetRow: verified.targetRow,
              containmentReceipt,
              now,
            });
            return Object.freeze({
              kind: "start_fresh" as const,
              pane: reset.pane,
              queue: reset.queue,
              containmentReceipt,
            });
          })();
      const postimage = this.#providerArchiveFinalizationPostimageV57(
        target,
        verified.targetRow,
      );
      journal.markTargetCommitted({
        targetId,
        commitEvidenceDigest: this.#providerArchiveHmacV57(
          "target-finalization-evidence",
          {
            targetId,
            attemptId: target.currentAttempt.attemptId,
            attemptState: target.currentAttempt.state,
            containmentReceipt,
            postimage,
          },
        ),
        commitRevisionDigest: this.#providerArchiveHmacV57(
          "target-finalization-revision",
          {
            targetIdentityHmac: verified.targetRow.identity_hmac,
            targetPointerHmac: verified.targetRow.pointer_hmac,
            attemptOutcomeHmac: verified.attemptRow.outcome_hmac,
            cutContainmentHmac: verified.cut === null
              ? null
              : this.#providerArchiveCutAuthorityRowV57(
                  verified.cut.cutId,
                ).containment_hmac,
            postimage,
          },
        ),
        now,
      });
      return localResult;
    })();
  }

  markProviderThreadArchiveEffectStarted(input: Readonly<{
    readonly paneId: ChatPaneId;
    readonly expectedGeneration: number;
    readonly now: Date;
  }>): ChatProviderThreadArchiveIntent {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    validateRevision(input.expectedGeneration);
    const now = isoDateTimeSchema.parse(input.now.toISOString());
    return this.#database.transaction(() => {
      const changed = this.#database.query(`
        UPDATE chat_provider_thread_archive_intents
        SET state = 'effect_started', effect_attempt = effect_attempt + 1,
            updated_at = ?3
        WHERE pane_id = ?1 AND generation = ?2 AND state = 'prepared'
      `).run(paneId, input.expectedGeneration, now);
      if (changed.changes !== 1) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "The provider containment intent changed before its effect started.",
        );
      }
      return this.#requireProviderThreadArchiveIntent(paneId);
    })();
  }

  rebasePreparedProviderThreadArchive(input: Readonly<{
    readonly paneId: ChatPaneId;
    readonly generation: number;
    readonly evidenceReceipt: string;
    readonly now: Date;
  }>): ChatProviderThreadArchiveIntent {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    validateRevision(input.generation);
    const receipt = boundedOpaqueReceipt(input.evidenceReceipt);
    const now = isoDateTimeSchema.parse(input.now.toISOString());
    return this.#database.transaction(() => {
      const current = this.#requireProviderThreadArchiveIntent(paneId);
      if (
        current.state !== "prepared" ||
        input.generation <= current.generation
      ) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "A prepared provider containment intent can rebase only to a newer generation.",
        );
      }
      const changed = this.#database.query(`
        UPDATE chat_provider_thread_archive_intents
        SET state = 'prepared', generation = ?2,
            reconciliation_disposition = 'not_applied',
            reconciliation_receipt = ?3, updated_at = ?4
        WHERE pane_id = ?1 AND state = 'prepared' AND generation < ?2
      `).run(paneId, input.generation, receipt, now);
      if (changed.changes !== 1) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "The prepared provider containment intent changed during restart.",
        );
      }
      return this.#requireProviderThreadArchiveIntent(paneId);
    })();
  }

  markProviderThreadArchiveAmbiguous(input: Readonly<{
    readonly paneId: ChatPaneId;
    readonly expectedGeneration: number;
    readonly ambiguityReceipt: string;
    readonly now: Date;
  }>): ChatProviderThreadArchiveIntent {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    validateRevision(input.expectedGeneration);
    const receipt = boundedOpaqueReceipt(input.ambiguityReceipt);
    const now = isoDateTimeSchema.parse(input.now.toISOString());
    return this.#database.transaction(() => {
      const changed = this.#database.query(`
        UPDATE chat_provider_thread_archive_intents
        SET state = 'ambiguous', ambiguity_receipt = ?3, updated_at = ?4
        WHERE pane_id = ?1 AND generation = ?2 AND state = 'effect_started'
      `).run(paneId, input.expectedGeneration, receipt, now);
      if (changed.changes !== 1) {
        const current = this.#requireProviderThreadArchiveIntent(paneId);
        if (
          current.state === "ambiguous" &&
          current.generation === input.expectedGeneration &&
          current.ambiguity_receipt === receipt
        ) return current;
        throw new ChatPaneStoreError(
          "revision_conflict",
          "The ambiguous provider containment receipt changed.",
        );
      }
      return this.#requireProviderThreadArchiveIntent(paneId);
    })();
  }

  markProviderThreadArchiveGenerationContained(input: Readonly<{
    readonly paneId: ChatPaneId;
    readonly expectedGeneration: number;
    readonly containmentReceipt: string;
    readonly now: Date;
  }>): ChatProviderThreadArchiveIntent {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    validateRevision(input.expectedGeneration);
    const receipt = boundedOpaqueReceipt(input.containmentReceipt);
    const now = isoDateTimeSchema.parse(input.now.toISOString());
    return this.#database.transaction(() => {
      const changed = this.#database.query(`
        UPDATE chat_provider_thread_archive_intents
        SET generation_contained = 1,
            generation_containment_receipt = ?3, updated_at = ?4
        WHERE pane_id = ?1 AND generation = ?2 AND state = 'ambiguous'
          AND generation_contained = 0
      `).run(paneId, input.expectedGeneration, receipt, now);
      if (changed.changes !== 1) {
        const current = this.#requireProviderThreadArchiveIntent(paneId);
        if (
          current.state === "ambiguous" &&
          current.generation === input.expectedGeneration &&
          current.generation_contained === 1 &&
          current.generation_containment_receipt === receipt
        ) return current;
        throw new ChatPaneStoreError(
          "revision_conflict",
          "The provider archive generation containment proof changed.",
        );
      }
      return this.#requireProviderThreadArchiveIntent(paneId);
    })();
  }

  resetProviderThreadArchiveAfterNotApplied(input: Readonly<{
    readonly paneId: ChatPaneId;
    readonly generation: number;
    readonly reconciliationReceipt: string;
    readonly now: Date;
  }>): ChatProviderThreadArchiveIntent {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    validateRevision(input.generation);
    const receipt = boundedOpaqueReceipt(input.reconciliationReceipt);
    const now = isoDateTimeSchema.parse(input.now.toISOString());
    return this.#database.transaction(() => {
      const current = this.#requireProviderThreadArchiveIntent(paneId);
      if (
        current.state !== "ambiguous" ||
        current.generation_contained !== 1 ||
        current.generation_containment_receipt === null ||
        input.generation <= current.generation
      ) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "A not-applied provider archive can retry only after exact containment on a newer generation.",
        );
      }
      const changed = this.#database.query(`
        UPDATE chat_provider_thread_archive_intents
        SET state = 'prepared', generation = ?2, ambiguity_receipt = NULL,
            generation_contained = 0,
            generation_containment_receipt = NULL,
            reconciliation_disposition = 'not_applied',
            reconciliation_receipt = ?3, updated_at = ?4
        WHERE pane_id = ?1 AND state = 'ambiguous'
          AND generation_contained = 1
          AND generation_containment_receipt IS NOT NULL
          AND generation < ?2
      `).run(paneId, input.generation, receipt, now);
      if (changed.changes !== 1) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "The provider containment reconciliation changed.",
        );
      }
      return this.#requireProviderThreadArchiveIntent(paneId);
    })();
  }

  recordProviderThreadArchiveSucceeded(input: Readonly<{
    readonly paneId: ChatPaneId;
    readonly containmentReceipt: string;
    readonly expectedIntentGeneration: number;
    readonly responseGeneration: number;
    readonly streamPosition: number;
    readonly now: Date;
  } & (
    | Readonly<{ readonly source: "direct" }>
    | Readonly<{
        readonly source: "reconciled";
        readonly reconciliationReceipt: string;
      }>
  )>): ChatProviderThreadArchiveIntent {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    validateRevision(input.expectedIntentGeneration);
    validateRevision(input.responseGeneration);
    if (!Number.isSafeInteger(input.streamPosition) || input.streamPosition < 0) {
      throw new ChatPaneStoreError("invalid_state", "Archive response position is invalid.");
    }
    const receipt = boundedOpaqueReceipt(input.containmentReceipt);
    const reconciliationReceipt = input.source === "reconciled"
      ? boundedOpaqueReceipt(input.reconciliationReceipt)
      : null;
    const now = isoDateTimeSchema.parse(input.now.toISOString());
    return this.#database.transaction(() => {
      const current = this.#requireProviderThreadArchiveIntent(paneId);
      if (current.state === "succeeded") {
        if (
          current.generation === input.expectedIntentGeneration &&
          current.containment_receipt === receipt &&
          current.response_generation === input.responseGeneration &&
          current.response_stream_position === input.streamPosition &&
          (
            input.source === "direct"
              ? current.response_generation === current.generation
              : current.response_generation > current.generation &&
                current.generation_contained === 1 &&
                current.generation_containment_receipt !== null &&
                current.reconciliation_disposition === "applied" &&
                current.reconciliation_receipt === reconciliationReceipt
          )
        ) return current;
        throw new ChatPaneStoreError(
          "revision_conflict",
          "The provider containment success receipt changed.",
        );
      }
      const direct = input.source === "direct" &&
        current.state === "effect_started" &&
        input.responseGeneration === input.expectedIntentGeneration;
      const reconciled = input.source === "reconciled" &&
        current.state === "ambiguous" &&
        current.generation_contained === 1 &&
        current.generation_containment_receipt !== null &&
        input.responseGeneration > input.expectedIntentGeneration;
      if (
        current.generation !== input.expectedIntentGeneration ||
        (!direct && !reconciled)
      ) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "The provider containment response generation does not match its durable effect authority.",
        );
      }
      const changed = this.#database.query(`
        UPDATE chat_provider_thread_archive_intents
        SET state = 'succeeded', containment_receipt = ?2,
            response_generation = ?3, response_stream_position = ?4,
            ambiguity_receipt = NULL,
            reconciliation_disposition = CASE WHEN ?5 IS NULL THEN
              reconciliation_disposition ELSE 'applied' END,
            reconciliation_receipt = COALESCE(?5, reconciliation_receipt),
            updated_at = ?6
        WHERE pane_id = ?1 AND generation = ?7
          AND (
            (?8 = 'direct' AND state = 'effect_started' AND ?3 = generation)
            OR (?8 = 'reconciled' AND state = 'ambiguous'
              AND generation_contained = 1
              AND generation_containment_receipt IS NOT NULL
              AND ?3 > generation)
          )
      `).run(
        paneId,
        receipt,
        input.responseGeneration,
        input.streamPosition,
        reconciliationReceipt,
        now,
        input.expectedIntentGeneration,
        input.source,
      );
      if (changed.changes !== 1) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "The provider containment success receipt changed.",
        );
      }
      return this.#requireProviderThreadArchiveIntent(paneId);
    })();
  }

  /**
   * Appends a user discard receipt only after the ambiguous message's exact
   * logical turn is terminal. The delivery evidence and payload row remain
   * immutable; only its attachment lease and queue containment are released.
   */
  discardAmbiguousMessage(
    input: ChatMessageDiscardAmbiguousInput,
  ): ChatMessageQueueProjection {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const messageId = chatMessageIdSchema.parse(input.messageId);
    validateRevision(input.expectedQueueRevision);
    validateRevision(input.expectedMessageRevision);
    const now = isoDateTimeSchema.parse(input.now.toISOString());
    return this.#database.transaction(() => {
      this.#assertNoPendingProviderThreadArchiveIntent(paneId);
      const metadata = this.#requireMessageQueueRevision(
        paneId,
        input.expectedQueueRevision,
      );
      if (metadata.message_queue_pause_reason !== "ambiguous_effect") {
        throw new ChatPaneStoreError(
          "invalid_state",
          "This message queue has no unresolved delivery outcome.",
        );
      }
      const row = this.#requireMessageRowForPane(paneId, messageId);
      if (
        row.revision !== input.expectedMessageRevision ||
        row.state !== "ambiguous" || row.claimed_turn_id === null
      ) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "The blocked chat message changed before it could be discarded.",
        );
      }
      const pane = this.require(paneId);
      if (
        pane.projection.turn?.id !== row.claimed_turn_id ||
        isActive(pane.projection)
      ) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Contain the blocked message's exact turn before discarding it.",
        );
      }
      try {
        const inserted = this.#database.query(`
          INSERT INTO chat_message_ambiguous_resolutions (
            message_id, pane_id, claimed_turn_id, resolution, resolved_at
          ) VALUES (?1, ?2, ?3, 'discarded', ?4)
        `).run(messageId, paneId, row.claimed_turn_id, now);
        if (inserted.changes !== 1) throw staleMessageRevision();
        this.#releaseMessageAttachmentLeases(
          paneId,
          messageId,
          row.claimed_turn_id,
          now,
        );
        const resumed = this.#database.query(`
          UPDATE chat_panes SET
            message_queue_pause_reason = CASE
              WHEN provider_context_reset_required = 1 THEN 'attention'
              ELSE NULL
            END,
            message_queue_revision = message_queue_revision + 1,
            updated_at = ?3
          WHERE pane_id = ?1 AND message_queue_revision = ?2
            AND archived_at IS NULL
        `).run(paneId, input.expectedQueueRevision, now);
        if (resumed.changes !== 1) throw staleQueueRevision();
      } catch (error: unknown) {
        throw sqliteMessageConflict(
          error,
          "The blocked chat message could not be discarded.",
        );
      }
      return this.messageQueue(paneId);
    })();
  }

  claimHeadMessage(input: ChatMessageClaimInput): ChatMessageClaimResult {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const messageId = chatMessageIdSchema.parse(input.messageId);
    const turnId = chatTurnIdSchema.parse(input.turnId);
    validateRevision(input.expectedQueueRevision);
    validateRevision(input.expectedMessageRevision);
    const now = isoDateTimeSchema.parse(input.now.toISOString());
    return this.#database.transaction(() => {
      this.#assertNoPendingProviderThreadArchiveIntent(paneId);
      const metadata = this.#requireMessageQueueRevision(
        paneId,
        input.expectedQueueRevision,
      );
      if (metadata.message_queue_pause_reason !== null) {
        throw new ChatPaneStoreError("invalid_state", "This message queue is paused.");
      }
      if (
        input.kind === "steer" &&
        (
          metadata.active_turn_id !== turnId ||
          !["starting", "streaming", "continuing"].includes(metadata.state)
        )
      ) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "The exact active turn is no longer available for steering.",
        );
      }
      if (
        input.kind === "start" &&
        metadata.state !== "ready" && metadata.state !== "attention"
      ) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "A new chat turn cannot be claimed while another turn is active.",
        );
      }
      const head = this.#queuedHead(paneId);
      if (head === null || head.message_id !== messageId) {
        throw new ChatPaneStoreError(
          "conflict",
          "Only the exact FIFO head can be claimed.",
        );
      }
      this.#requireQueuedMessageRevision(head, input.expectedMessageRevision);
      const content = this.#messageContent(head);
      const nextState = input.kind === "start" ? "start_claimed" : "steer_prepared";
      const claimed = this.#database.query(`
        UPDATE chat_message_ledger SET
          state = ?4,
          claimed_turn_id = ?5,
          revision = revision + 1,
          updated_at = ?6
        WHERE pane_id = ?1 AND message_id = ?2
          AND revision = ?3 AND state = 'queued'
      `).run(
        paneId,
        messageId,
        input.expectedMessageRevision,
        nextState,
        turnId,
        now,
      );
      if (claimed.changes !== 1) throw staleMessageRevision();
      this.#acquireMessageAttachmentLeases(paneId, messageId, turnId, now);
      this.#advanceMessageQueueRevision(paneId, input.expectedQueueRevision, now);
      const claim: ChatMessageClaim = {
        messageId,
        paneId,
        ordinal: head.ordinal,
        revision: input.expectedMessageRevision + 1,
        turnId,
        kind: input.kind,
        content,
      };
      return { claim, queue: this.messageQueue(paneId) };
    })();
  }

  /**
   * Claims the exact FIFO head and admits its app-owned logical turn in one
   * SQLite transaction. The renderer never supplies the logical turn ID, and
   * no provider effect can observe a claim without its root-route receipt.
   */
  claimHeadMessageAndBeginTurn(
    input: Omit<ChatMessageClaimInput, "kind">,
  ): ChatMessageClaimResult & Readonly<{ pane: ChatPaneProjection }> {
    return this.#database.transaction(() => {
      const current = this.require(input.paneId);
      const claimed = this.claimHeadMessage({ ...input, kind: "start" });
      if (
        claimed.claim.content.text.trim().length === 0 &&
        claimed.claim.content.attachmentRefs.length === 0
      ) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "A claimed message requires text or a ready attachment.",
        );
      }
      const requiredInputClass = this.#attachmentRequiredInputClass(
        input.paneId,
        claimed.claim.content.attachmentRefs,
      );
      const admission = this.beginTurn({
        paneId: input.paneId,
        expectedRevision: current.projection.revision,
        turnId: input.turnId,
        prompt: claimed.claim.content.text,
        requiredInputClass,
        now: input.now,
      });
      if (admission.kind !== "begun") {
        throw new ChatPaneStoreError(
          "conflict",
          "This queued message logical turn was already admitted.",
        );
      }
      return {
        claim: claimed.claim,
        queue: this.messageQueue(input.paneId),
        pane: admission.pane,
      };
    })();
  }

  returnClaimedMessageToQueue(
    input: ChatMessageTransitionInput,
  ): ChatMessageQueueProjection {
    return this.#transitionClaim(input, {
      start: { from: "start_claimed", to: "queued" },
      steer: { from: "steer_prepared", to: "queued" },
    }, "return to the queue");
  }

  /** Compensates only a newly enqueued atomic steer before its effect cut. */
  cancelPreparedSteerMessage(
    input: ChatMessageTransitionInput,
  ): Readonly<{
    queue: ChatMessageQueueProjection;
    attachmentsRestored: boolean;
  }> {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const messageId = chatMessageIdSchema.parse(input.messageId);
    const turnId = chatTurnIdSchema.parse(input.turnId);
    validateRevision(input.expectedMessageRevision);
    const now = isoDateTimeSchema.parse(input.now.toISOString());
    return this.#database.transaction(() => {
      this.#assertNoPendingProviderThreadArchiveIntent(paneId);
      const metadata = this.#requireMessageQueueMetadata(paneId);
      const row = this.#requireMessageRowForPane(paneId, messageId);
      this.#requireClaimTransition(
        row,
        input.expectedMessageRevision,
        turnId,
        "steer_prepared",
      );
      if (row.request_delivery_kind !== "steer_head") {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "Only a newly enqueued atomic steer can be cancelled here.",
        );
      }
      const cancelled = this.#database.query(`
        UPDATE chat_message_ledger SET
          state = 'cancelled',
          request_delivery_outcome = 'not_applied',
          revision = revision + 1,
          terminal_at = ?6,
          updated_at = ?6
        WHERE pane_id = ?1 AND message_id = ?2 AND revision = ?3
          AND claimed_turn_id = ?4 AND state = ?5
      `).run(
        paneId,
        messageId,
        input.expectedMessageRevision,
        turnId,
        "steer_prepared",
        now,
      );
      if (cancelled.changes !== 1) throw staleMessageRevision();
      this.#releasePreparedMessageAttachmentLeases(
        paneId,
        messageId,
        turnId,
        now,
      );
      let attachmentsRestored: boolean;
      try {
        attachmentsRestored =
          this.#messageAttachmentAuthority.restorePreparedDraftRefsInTransaction({
            paneId,
            messageId,
            now,
          });
      } catch {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "The prepared steer's attachment authority could not be restored.",
        );
      }
      this.#advanceMessageQueueRevision(
        paneId,
        metadata.message_queue_revision,
        now,
      );
      return { queue: this.messageQueue(paneId), attachmentsRestored };
    })();
  }

  markMessageEffectStarted(
    input: ChatMessageTransitionInput,
  ): ChatMessageQueueProjection {
    return this.#transitionClaim(input, {
      start: { from: "start_claimed", to: "start_effect_started" },
      steer: { from: "steer_prepared", to: "steer_effect_started" },
    }, "start its effect", {
      effectStartedAt: true,
      steerRequestOutcome: "effect_started",
    });
  }

  /**
   * Atomically records a provider-proven quota rejection and restores only
   * the exact current scheduled start message to FIFO. The provider's
   * not-applied proof permits retrying this same durable occurrence; every
   * other effect-started message remains ambiguity-fenced.
   */
  settleProvenNotAppliedScheduledStart(
    input: ChatMessageTransitionInput,
  ): ChatMessageQueueProjection {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const messageId = chatMessageIdSchema.parse(input.messageId);
    const turnId = chatTurnIdSchema.parse(input.turnId);
    validateRevision(input.expectedMessageRevision);
    if (input.kind !== "start") {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Only a scheduled start can settle from a proven quota rejection.",
      );
    }
    const now = isoDateTimeSchema.parse(input.now.toISOString());
    return this.#database.transaction(() => {
      this.#assertNoPendingProviderThreadArchiveIntent(paneId);
      const schedule = this.#scheduledChats.get(paneId);
      const run = this.#scheduledChats.runForMessage(paneId, messageId);
      if (
        schedule === null
        || run === null
        || run.sessionId !== schedule.sessionId
        || run.scheduleGeneration !== schedule.generation
        || run.cancelledAt !== null
        || this.#scheduledChats.mutationForPane(paneId) !== null
        || this.#scheduledChats.desiredOff(paneId) !== null
      ) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "The proven quota rejection no longer belongs to the active schedule.",
        );
      }
      const metadata = this.#requireMessageQueueMetadata(paneId);
      const row = this.#requireMessageRowForPane(paneId, messageId);
      this.#requireClaimTransition(
        row,
        input.expectedMessageRevision,
        turnId,
        "start_effect_started",
      );
      if (row.request_delivery_kind !== "queue") {
        throw new ChatPaneStoreError(
          "invalid_state",
          "A scheduled start cannot carry renderer steering authority.",
        );
      }
      const route = this.#rootTurnRouting.readTurnRouting(paneId, turnId);
      if (
        route === null
        || route.state !== "effectStarted"
        || route.acceptedAt !== null
        || route.settledAt !== null
      ) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "The scheduled quota proof lost its exact root-routing cut.",
        );
      }
      this.#rootTurnRouting.settleInTransaction({
        paneId,
        chatTurnId: turnId,
        outcome: "quotaRejected",
        now: input.now,
      });
      const returned = this.#database.query(`
        UPDATE chat_message_ledger SET
          state = 'queued', claimed_turn_id = NULL,
          effect_started_at = NULL, revision = revision + 1,
          updated_at = ?5
        WHERE pane_id = ?1 AND message_id = ?2 AND revision = ?3
          AND claimed_turn_id = ?4 AND state = 'start_effect_started'
      `).run(
        paneId,
        messageId,
        input.expectedMessageRevision,
        turnId,
        now,
      );
      if (returned.changes !== 1) throw staleMessageRevision();
      this.#releasePreparedMessageAttachmentLeases(
        paneId,
        messageId,
        turnId,
        now,
      );
      this.#advanceMessageQueueRevision(
        paneId,
        metadata.message_queue_revision,
        now,
      );
      return this.messageQueue(paneId);
    })();
  }

  acknowledgeMessageEffect(
    input: ChatMessageTransitionInput,
  ): ChatMessageQueueProjection {
    return this.#database.transaction(() => {
      const acknowledged = this.#transitionClaim(input, {
        start: { from: "start_effect_started", to: "start_acknowledged" },
        steer: { from: "steer_effect_started", to: "steer_acknowledged" },
      }, "acknowledge its effect", {
        acknowledgedAt: true,
        steerRequestOutcome: "accepted",
      });
      const pane = this.require(input.paneId);
      if (
        pane.projection.turn?.id !== input.turnId ||
        isActive(pane.projection)
      ) return acknowledged;
      return this.completeClaimedMessage({
        ...input,
        expectedMessageRevision: input.expectedMessageRevision + 1,
        now: input.now,
      });
    })();
  }

  completeClaimedMessage(
    input: ChatMessageTransitionInput,
  ): ChatMessageQueueProjection {
    return this.#transitionClaim(input, {
      start: { from: "start_acknowledged", to: "completed" },
      steer: { from: "steer_acknowledged", to: "completed" },
    }, "complete", { terminalAt: true });
  }

  /**
   * Settles every provider-acknowledged message only after its exact parent
   * logical turn is durably terminal. This also repairs a crash between the
   * pane terminal and message-ledger settlement.
   */
  completeAcknowledgedMessagesForTurn(
    paneIdInput: ChatPaneId,
    turnIdInput: ChatTurnId,
    now: Date,
  ): Readonly<{ queue: ChatMessageQueueProjection; completedCount: number }> {
    const paneId = chatPaneIdSchema.parse(paneIdInput);
    const turnId = chatTurnIdSchema.parse(turnIdInput);
    return this.#database.transaction(() => {
      const pane = this.require(paneId);
      if (pane.projection.turn?.id !== turnId || isActive(pane.projection)) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Acknowledged chat messages require their exact terminal turn.",
        );
      }
      const values: unknown[] = this.#database.query(`
        SELECT * FROM chat_message_ledger
        WHERE pane_id = ?1 AND claimed_turn_id = ?2
          AND state IN ('start_acknowledged', 'steer_acknowledged')
        ORDER BY ordinal, message_id
      `).all(paneId, turnId);
      const rows = values.map((value) => this.#parseMessageRow(value));
      for (const row of rows) {
        this.completeClaimedMessage({
          paneId,
          messageId: row.message_id,
          expectedMessageRevision: row.revision,
          turnId,
          kind: row.state === "start_acknowledged" ? "start" : "steer",
          now,
        });
      }
      return { queue: this.messageQueue(paneId), completedCount: rows.length };
    })();
  }

  markMessageEffectAmbiguous(
    input: ChatMessageTransitionInput,
  ): ChatMessageQueueProjection {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const messageId = chatMessageIdSchema.parse(input.messageId);
    const turnId = chatTurnIdSchema.parse(input.turnId);
    validateRevision(input.expectedMessageRevision);
    const now = isoDateTimeSchema.parse(input.now.toISOString());
    const from = input.kind === "start"
      ? "start_effect_started"
      : "steer_effect_started";
    return this.#database.transaction(() => {
      this.#assertNoPendingProviderThreadArchiveIntent(paneId);
      const metadata = this.#requireMessageQueueMetadata(paneId);
      const row = this.#requireMessageRowForPane(paneId, messageId);
      this.#requireClaimTransition(row, input.expectedMessageRevision, turnId, from);
      const updated = this.#database.query(`
        UPDATE chat_message_ledger SET
          state = 'ambiguous',
          ${row.request_delivery_kind === "steer_head"
            ? "request_delivery_outcome = 'ambiguous',"
            : ""}
          revision = revision + 1,
          terminal_at = ?6,
          updated_at = ?6
        WHERE pane_id = ?1 AND message_id = ?2 AND revision = ?3
          AND claimed_turn_id = ?4 AND state = ?5
      `).run(paneId, messageId, input.expectedMessageRevision, turnId, from, now);
      if (updated.changes !== 1) throw staleMessageRevision();
      this.#markMessageAttachmentLeasesAmbiguous(
        paneId,
        messageId,
        turnId,
        now,
      );
      const paused = this.#database.query(`
        UPDATE chat_panes SET
          message_queue_pause_reason = 'ambiguous_effect',
          message_queue_revision = message_queue_revision + 1,
          updated_at = ?3
        WHERE pane_id = ?1 AND message_queue_revision = ?2
          AND archived_at IS NULL
      `).run(paneId, metadata.message_queue_revision, now);
      if (paused.changes !== 1) throw staleQueueRevision();
      return this.messageQueue(paneId);
    })();
  }

  /**
   * Reconciles only app-owned ledger cuts. It never retries a provider effect:
   * prepared rows return to FIFO, effect-started rows become ambiguous, and
   * every restarted queue pauses before a later explicit resume.
   */
  reconcileMessageQueueAfterRestart(
    paneIdInput: ChatPaneId,
    nowInput: Date,
  ): ChatMessageQueueProjection {
    const paneId = chatPaneIdSchema.parse(paneIdInput);
    const now = isoDateTimeSchema.parse(nowInput.toISOString());
    return this.#database.transaction(() => {
      this.#assertNoPendingProviderThreadArchiveIntent(paneId);
      const metadata = this.#requireMessageQueueMetadata(paneId);
      const uncertain: unknown[] = this.#database.query(`
        SELECT * FROM chat_message_ledger
        WHERE pane_id = ?1 AND state IN (
          'start_claimed', 'steer_prepared',
          'start_effect_started', 'steer_effect_started'
        )
          OR (pane_id = ?1 AND state = 'ambiguous' AND NOT EXISTS (
            SELECT 1 FROM chat_message_ambiguous_resolutions AS resolution
            WHERE resolution.message_id = chat_message_ledger.message_id
              AND resolution.pane_id = chat_message_ledger.pane_id
              AND resolution.claimed_turn_id =
                chat_message_ledger.claimed_turn_id
              AND resolution.resolution = 'discarded'
          ))
        ORDER BY ordinal, message_id
      `).all(paneId);
      const rows = uncertain.map((value) => this.#parseMessageRow(value));
      const ambiguous = rows.some((row) =>
        row.state === "start_effect_started" ||
        row.state === "steer_effect_started" ||
        row.state === "ambiguous"
      );
      let mutated = false;
      for (const row of rows) {
        if (row.state === "start_claimed" || row.state === "steer_prepared") {
          if (
            row.state === "steer_prepared" &&
            row.request_delivery_kind === "steer_head"
          ) {
            const cancelled = this.#database.query(`
              UPDATE chat_message_ledger SET
                state = 'cancelled',
                request_delivery_outcome = 'not_applied',
                revision = revision + 1,
                terminal_at = ?3,
                updated_at = ?3
              WHERE message_id = ?1 AND revision = ?2
                AND state = 'steer_prepared'
                AND request_delivery_kind = 'steer_head'
                AND request_delivery_outcome = 'pending'
            `).run(row.message_id, row.revision, now);
            if (cancelled.changes !== 1 || row.claimed_turn_id === null) {
              throw staleMessageRevision();
            }
            this.#releasePreparedMessageAttachmentLeases(
              paneId,
              row.message_id,
              row.claimed_turn_id,
              now,
            );
            try {
              this.#messageAttachmentAuthority.restorePreparedDraftRefsInTransaction({
                paneId,
                messageId: row.message_id,
                now,
              });
            } catch {
              throw new ChatPaneStoreError(
                "corrupt_state",
                "The restarted steer's attachment authority could not be restored.",
              );
            }
            mutated = true;
            continue;
          }
          const updated = this.#database.query(`
            UPDATE chat_message_ledger SET
              state = 'queued',
              claimed_turn_id = NULL,
              revision = revision + 1,
              updated_at = ?3
            WHERE message_id = ?1 AND revision = ?2
          `).run(row.message_id, row.revision, now);
          if (updated.changes !== 1 || row.claimed_turn_id === null) {
            throw staleMessageRevision();
          }
          this.#releasePreparedMessageAttachmentLeases(
            paneId,
            row.message_id,
            row.claimed_turn_id,
            now,
          );
          mutated = true;
        } else if (row.state !== "ambiguous") {
          const updated = this.#database.query(`
            UPDATE chat_message_ledger SET
              state = 'ambiguous',
              ${row.request_delivery_kind === "steer_head"
                ? "request_delivery_outcome = 'ambiguous',"
                : ""}
              terminal_at = ?3,
              revision = revision + 1,
              updated_at = ?3
            WHERE message_id = ?1 AND revision = ?2
          `).run(row.message_id, row.revision, now);
          if (updated.changes !== 1 || row.claimed_turn_id === null) {
            throw staleMessageRevision();
          }
          this.#markMessageAttachmentLeasesAmbiguous(
            paneId,
            row.message_id,
            row.claimed_turn_id,
            now,
          );
          mutated = true;
        }
      }
      const queuedValue: unknown = this.#database.query(`
        SELECT COUNT(*) AS count FROM chat_message_ledger
        WHERE pane_id = ?1 AND state = 'queued'
      `).get(paneId);
      const hasQueuedMessages = countRowSchema.parse(queuedValue).count > 0;
      if (
        !ambiguous &&
        !hasQueuedMessages &&
        metadata.message_queue_pause_reason !== "ambiguous_effect"
      ) {
        const nextReason = metadata.message_queue_pause_reason === "runtime_restart"
          ? null
          : metadata.message_queue_pause_reason;
        if (
          !mutated &&
          metadata.message_queue_pause_reason === nextReason
        ) {
          return this.#messageQueueProjection(metadata);
        }
        const advanced = this.#database.query(`
          UPDATE chat_panes SET
            message_queue_pause_reason = ?3,
            message_queue_revision = message_queue_revision + 1,
            updated_at = ?4
          WHERE pane_id = ?1 AND message_queue_revision = ?2
            AND archived_at IS NULL
        `).run(
          paneId,
          metadata.message_queue_revision,
          nextReason,
          now,
        );
        if (advanced.changes !== 1) throw staleQueueRevision();
        return this.messageQueue(paneId);
      }
      const nextReason = ambiguous ? "ambiguous_effect" : "runtime_restart";
      if (
        !mutated &&
        metadata.message_queue_pause_reason === nextReason
      ) {
        return this.#messageQueueProjection(metadata);
      }
      const paused = this.#database.query(`
        UPDATE chat_panes SET
          message_queue_pause_reason = ?3,
          message_queue_revision = message_queue_revision + 1,
          updated_at = ?4
        WHERE pane_id = ?1 AND message_queue_revision = ?2
          AND archived_at IS NULL
      `).run(
        paneId,
        metadata.message_queue_revision,
        nextReason,
        now,
      );
      if (paused.changes !== 1) throw staleQueueRevision();
      return this.messageQueue(paneId);
    })();
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
            pane_id, palette_index, display_order, repository_id, repository_name, revision, title,
            account_profile_id, model, reasoning_effort, service_tier,
            interaction_mode, state,
            workspace_mode, workspace_state, workspace_revision,
            workspace_recovery_reason, created_at, updated_at
          ) VALUES (
            ?1, ${CHAT_PANE_NEXT_PALETTE_INDEX_SQL}, ?2, ?3, ?4, 1, ?5, ?6, ?7, 'max', 'standard', 'chat', 'ready',
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
    return this.#database.transaction(() => {
      this.#assertNoPendingProviderArchiveAccountAdmissionV57(
        accountProfileId,
      );
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
          return { kind: "replayed", pane: existing.projection } as const;
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
            pane_id, palette_index, display_order, repository_id, repository_name, revision, title,
            account_profile_id, model, reasoning_effort, interaction_mode, state,
            provider_account_profile_id, provider_thread_id,
            provider_restart_thread_id, created_at, updated_at
          ) VALUES (
            ?1, ${CHAT_PANE_NEXT_PALETTE_INDEX_SQL}, ?2, ?3, ?4, 1, ?5, ?6, ?7, 'ultra', 'harnessObserver', 'ready',
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
      return {
        kind: "created",
        pane: this.require(paneId).projection,
      } as const;
    })();
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
    return this.#database.transaction(() => {
      this.#assertNoPendingProviderThreadArchiveAuthorityV57(paneId);
      this.#assertNoPendingProviderArchiveAccountAdmissionV57(
        accountProfileId,
      );
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
    })();
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
    return this.#database.transaction(() => {
      this.#assertNoPendingProviderThreadArchiveAuthorityV57(paneId);
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
      ) return { kind: "replayed", pane: current.projection } as const;
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
      return {
        kind: "seeded",
        pane: this.require(paneId).projection,
      } as const;
    })();
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
    return this.#database.transaction(() => {
      this.#assertNoPendingProviderThreadArchiveAuthorityV57(paneId);
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
      ) return { kind: "replayed", pane: current.projection } as const;
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
      return {
        kind: "seeded",
        pane: this.require(paneId).projection,
      } as const;
    })();
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
      this.#assertNoPendingProviderThreadArchiveAuthorityV57(paneId);
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
            tools_json = '[]',
            reasoning_tail = reasoning_verified_tail,
            reasoning_total_utf8_bytes = reasoning_verified_total_utf8_bytes,
            reasoning_active_item_id = NULL,
            provider_subagents_json = '[]',
            provider_subagent_overflow_count = 0,
            activity_ordinal = activity_ordinal + 1,
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
    containmentReceipt?: string,
  ): ChatPaneRemoveResult {
    const id = chatPaneIdSchema.parse(paneId);
    validateRevision(expectedRevision);
    const timestamp = isoDateTimeSchema.parse(now.toISOString());
    return this.#database.transaction(() => {
      this.#assertNoPendingProviderThreadArchiveAuthorityV57(id);
      const liveRows = this.#livePaneRows();
      const removedOrder = liveRows.find((row) => row.pane_id === id)?.display_order;
      if (removedOrder === undefined) {
        throw new ChatPaneStoreError("not_found", "This chat pane no longer exists.");
      }
      const current = this.#requireRevision(id, expectedRevision, {
        allowPendingProviderThreadArchiveIntent: true,
      });
      const archiveIntent = this.providerThreadArchiveIntent(id);
      const pendingArchiveIntent = archiveIntent !== null &&
          archiveIntent.state !== "account_contained"
        ? archiveIntent
        : null;
      const accountContainedIntent = archiveIntent?.state === "account_contained"
        ? archiveIntent
        : null;
      if (pendingArchiveIntent !== null) {
        const succeeded = this.#requireSucceededProviderThreadArchiveIntent({
          pane: current,
          purpose: "pane_archive",
          paneRevision: expectedRevision,
          queueRevision: null,
        });
        if (
          containmentReceipt === undefined ||
          containmentReceipt !== succeeded.containment_receipt
        ) {
          throw new ChatPaneStoreError(
            "revision_conflict",
            "The provider containment receipt no longer authorizes this pane archive.",
          );
        }
        this.#releaseExactProviderAttachmentBindingInTransaction(
          id,
          this.classifyRetainedProviderAttachmentBinding(id, current.binding),
          succeeded,
          now,
        );
      } else if (accountContainedIntent !== null) {
        if (
          current.binding !== null ||
          accountContainedIntent.generation_contained !== 1 ||
          accountContainedIntent.generation_containment_receipt === null
        ) {
          throw new ChatPaneStoreError(
            "corrupt_state",
            "Account-contained provider context retained invalid archive authority.",
          );
        }
        if (
          containmentReceipt === undefined ||
          containmentReceipt !==
            accountContainedIntent.generation_containment_receipt
        ) {
          throw new ChatPaneStoreError(
            "revision_conflict",
            "The account-containment receipt no longer authorizes this pane archive.",
          );
        }
      }
      if (isActive(current.projection)) {
        throw new ChatPaneStoreError("invalid_state", "Wait for this chat turn to finish before closing its pane.");
      }
      if (current.projection.interactionMode === "harnessObserver") {
        throw new ChatPaneStoreError(
          "invalid_state",
          "An attached actor pane is retained with its durable actor binding.",
        );
      }
      if (this.#paneArchiveAuthority !== null) {
        if (containmentReceipt === undefined) {
          throw new ChatPaneStoreError(
            "invalid_state",
            "Attachment custody requires exact provider containment before pane archive.",
          );
        }
        this.#paneArchiveAuthority.preparePaneArchiveInTransaction({
          paneId: id,
          now,
          containmentReceipt,
        });
      }
      this.#closeMessageQueueForPane(id, timestamp);
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
      if (this.#paneArchiveAuthority !== null && containmentReceipt !== undefined) {
        this.#paneArchiveAuthority.markPaneArchivedInTransaction({
          paneId: id,
          now,
          containmentReceipt,
        });
      }
      if (pendingArchiveIntent !== null) {
        const consumed = this.#database.query(`
          DELETE FROM chat_provider_thread_archive_intents
          WHERE pane_id = ?1 AND purpose = 'pane_archive' AND state = 'succeeded'
        `).run(id);
        if (consumed.changes !== 1) {
          throw new ChatPaneStoreError(
            "revision_conflict",
            "The provider containment intent changed before pane archive finalized.",
          );
        }
      } else if (accountContainedIntent !== null) {
        const consumed = this.#database.query(`
          DELETE FROM chat_provider_thread_archive_intents
          WHERE pane_id = ?1 AND state = 'account_contained'
            AND generation_containment_receipt = ?2
        `).run(
          id,
          accountContainedIntent.generation_containment_receipt,
        );
        if (consumed.changes !== 1) {
          throw new ChatPaneStoreError(
            "revision_conflict",
            "The account-containment authority changed before pane archive finalized.",
          );
        }
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
      for (const paneId of currentPaneIds) {
        this.#assertNoPendingProviderThreadArchiveIntent(paneId);
      }
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
    readonly requiredInputClass?: "text" | "image";
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
      this.#assertNoUnresolvedAmbiguousMessage(paneId);
      if (isActive(current.projection)) {
        throw new ChatPaneStoreError("invalid_state", "This chat pane already has an active turn.");
      }
      if (current.providerContextResetRequired) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Provider context reset requires a fresh message, not Retry.",
        );
      }
      if (
        this.classifyRetainedProviderAttachmentBinding(paneId, current.binding)
          .kind === "orphan"
      ) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Attachment custody no longer matches this pane's provider lineage.",
        );
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
        this.#rootTurnRouting.readTurnRouting(paneId, priorFailedTurnId)
          ?.requiredInputClass ?? "text",
        input.now,
      );
      if (current.activeTurnPoisoned) {
        this.#advanceProviderHistoryFloor(paneId);
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
            reasoning_verified_tail = '',
            reasoning_verified_total_utf8_bytes = 0,
            reasoning_active_item_id = NULL,
            reasoning_proof_tainted = 0,
            provider_subagents_json = '[]',
            provider_subagent_overflow_count = 0,
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
      readonly requiredInputClass?: "text" | "image";
      readonly now: Date;
    }>,
    interactionMode: "chat" | "harnessObserver",
  ): ChatPaneBeginTurnResult {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const turnId = chatTurnIdSchema.parse(input.turnId);
    const requiredInputClass = input.requiredInputClass ?? "text";
    validateRevision(input.expectedRevision);
    assertBoundedUtf8(
      input.prompt,
      requiredInputClass === "image" ? 0 : 1,
      CHAT_MAX_PROMPT_UTF8_BYTES,
      "Chat prompt",
    );
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
      if (interactionMode === "chat") {
        this.#assertNoUnresolvedAmbiguousMessage(paneId);
      }
      const priorReceipt: unknown = this.#database.query(`
        SELECT turn_id FROM chat_turn_receipts WHERE pane_id = ?1 AND turn_id = ?2
      `).get(paneId, turnId);
      if (priorReceipt !== null) {
        if (current.projection.turn?.id === turnId && current.activePrompt === input.prompt) {
          if (
            interactionMode === "chat" &&
            this.#rootTurnRouting.readTurnRouting(paneId, turnId)
              ?.requiredInputClass !== requiredInputClass
          ) {
            corrupt("An ordinary replay lost its exact input classification.");
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
      if (isActive(current.projection)) {
        throw new ChatPaneStoreError("invalid_state", "This chat pane already has an active turn.");
      }
      if (
        interactionMode === "chat" &&
        current.providerContextResetRequired
      ) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Use Start fresh before sending into quarantined provider context.",
        );
      }
      if (
        interactionMode === "chat" &&
        this.classifyRetainedProviderAttachmentBinding(paneId, current.binding)
          .kind === "orphan"
      ) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Attachment custody no longer matches this pane's provider lineage.",
        );
      }
      const routingClassification = interactionMode === "chat"
        ? this.#routingClassification(
            paneId,
            turnId,
            input.prompt,
            requiredInputClass,
            input.now,
          )
        : null;
      if (current.activeTurnPoisoned) {
        this.#advanceProviderHistoryFloor(paneId);
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
            reasoning_verified_tail = '',
            reasoning_verified_total_utf8_bytes = 0,
            reasoning_active_item_id = NULL,
            reasoning_proof_tainted = 0,
            provider_subagents_json = '[]',
            provider_subagent_overflow_count = 0,
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
    const accountId = accountProfileIdSchema.parse(accountProfileId);
    const timestamp = isoDateTimeSchema.parse(now.toISOString());
    return this.#database.transaction(() => {
      this.#assertNoPendingProviderArchiveAccountAdmissionV57(accountId);
      const pane = this.#requireActiveTurn(paneId, turnId);
      if (pane.visitedAccountProfileIds.includes(accountId)) {
        throw new ChatPaneStoreError("conflict", "This account was already visited by the active chat turn.");
      }
      const visited = [...pane.visitedAccountProfileIds, accountId];
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
    })();
  }

  prepareProviderThread(
    paneId: ChatPaneId,
    turnId: ChatTurnId,
    binding: ChatThreadBinding,
    now: Date,
  ): ChatPaneProjection {
    const accountProfileId = accountProfileIdSchema.parse(
      binding.accountProfileId,
    );
    const threadId = providerIdSchema.parse(binding.threadId);
    const restartThreadId = providerIdSchema.parse(binding.restartThreadId);
    const timestamp = isoDateTimeSchema.parse(now.toISOString());
    return this.#database.transaction(() => {
      this.#assertNoPendingProviderArchiveAccountAdmissionV57(
        accountProfileId,
      );
      const pane = this.#requireActiveTurn(paneId, turnId);
      if (!pane.visitedAccountProfileIds.includes(accountProfileId)) {
        throw new ChatPaneStoreError("conflict", "A chat thread cannot bind an unvisited account.");
      }
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
        accountProfileId,
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
    })();
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
    readonly reasoningItemId?: string;
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
      ...(input.reasoningItemId === undefined
        ? {}
        : { reasoningItemId: input.reasoningItemId }),
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
      const reasoningItemId = assistantItemIdSchema.parse(input.reasoningItemId);
      const completedReceipt = this.#database.query(`
        SELECT receipt_id FROM chat_reasoning_item_receipts
        WHERE pane_id = ?1 AND turn_id = ?2 AND item_id = ?3
      `).get(pane.projection.id, turnId, reasoningItemId);
      if (completedReceipt !== null) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "A reasoning-summary delta arrived after its item completed.",
        );
      }
      if (
        pane.reasoningItemId !== null &&
        pane.reasoningItemId !== reasoningItemId
      ) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "A new reasoning-summary item arrived before the previous item completed.",
        );
      }
      result = this.#database.query(`
          UPDATE chat_panes
          SET reasoning_tail = ?1,
              reasoning_total_utf8_bytes = ?2,
              reasoning_active_item_id = ?3,
              state = 'streaming',
              turn_status = 'streaming',
              revision = revision + ?4,
              updated_at = ?5
          WHERE pane_id = ?6 AND active_turn_id = ?7
            AND revision = ?8
            AND state IN ('starting', 'streaming', 'continuing')
            AND active_turn_poisoned = 0
        `).run(
          nextTail.tail,
          nextTail.totalUtf8Bytes,
          reasoningItemId,
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
    return this.#database.transaction(() => {
      const pane = this.get(chatPaneIdSchema.parse(paneId));
      if (
        pane === null ||
        pane.projection.turn?.id !== chatTurnIdSchema.parse(turnId) ||
        !isActive(pane.projection)
      ) return null;
      const retainedBinding = this.classifyRetainedProviderAttachmentBinding(
        pane.projection.id,
        pane.binding,
      );
      const quarantineProviderContext = retainedBinding.kind !== "none";
      const preserveProviderIdentity = retainedBinding.kind === "exact";
      const timestamp = terminalIso(pane.projection.turn.startedAt, now);
      const result = this.#database.query(`
        UPDATE chat_panes
        SET state = 'attention',
            turn_status = 'failed',
            turn_completed_at = ?1,
            active_provider_turn_id = NULL,
            provider_account_profile_id = CASE WHEN ?7 = 1
              THEN provider_account_profile_id ELSE NULL END,
            provider_thread_id = CASE WHEN ?7 = 1
              THEN provider_thread_id ELSE NULL END,
            provider_restart_thread_id = CASE WHEN ?7 = 1
              THEN provider_restart_thread_id ELSE NULL END,
            active_turn_poisoned = 1,
            provider_context_reset_required = MAX(
              provider_context_reset_required,
              ?3
            ),
            tools_json = ?2,
            reasoning_tail = reasoning_verified_tail,
            reasoning_total_utf8_bytes = reasoning_verified_total_utf8_bytes,
            reasoning_active_item_id = NULL,
            provider_subagents_json = '[]',
            provider_subagent_overflow_count = 0,
            attention_code = 'runtime_unavailable',
            attention_message = CASE WHEN ?3 = 1
              THEN ?4
              ELSE 'Streaming state could not be saved safely. Send your message again to start fresh.'
            END,
            attention_retryable = CASE WHEN ?3 = 1 THEN 0 ELSE 1 END,
            revision = revision + 1,
            updated_at = ?1
        WHERE pane_id = ?5 AND active_turn_id = ?6
          AND state IN ('starting', 'streaming', 'continuing')
      `).run(
        timestamp,
        JSON.stringify(completeAllTools(pane.projection.turn.tools)),
        quarantineProviderContext ? 1 : 0,
        freshProviderContextAttentionMessage,
        pane.projection.id,
        turnId,
        preserveProviderIdentity ? 1 : 0,
      );
      if (result.changes !== 1) return null;
      if (quarantineProviderContext) {
        this.pauseMessageQueue({
          paneId: pane.projection.id,
          reason: "attention",
          now,
        });
      }
      return this.require(pane.projection.id).projection;
    })();
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

  reconcileReasoningCompletion(
    input: ChatReasoningCompletionInput,
  ): ChatPaneProjection | null {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const turnId = chatTurnIdSchema.parse(input.turnId);
    const itemId = assistantItemIdSchema.parse(input.itemId);
    const timestamp = isoDateTimeSchema.parse(input.now.toISOString());
    return this.#database.transaction(() => {
      this.#assertNoPendingProviderThreadArchiveIntent(paneId);
      const pane = this.get(paneId);
      if (pane === null || pane.projection.turn?.id !== turnId) return null;
      const receipt = input.receipt;
      const existing = reasoningReceiptRowSchema.nullable().parse(
        this.#database.query(`
          SELECT receipt_id, state, completion_digest, completion_generation,
            completion_stream_position, completion_fact_index, overflowed,
            repaired_suffix, taint_reason, summary_tail,
            summary_total_utf8_bytes, summary_truncated_prefix
          FROM chat_reasoning_item_receipts
          WHERE pane_id = ?1 AND turn_id = ?2 AND item_id = ?3
        `).get(paneId, turnId, itemId),
      );
      if (existing !== null) {
        if (!storedReasoningReceiptMatches(existing, receipt)) {
          const current = paneRowSchema.parse(this.#database.query(`
            ${paneWithActiveRoutingSelect()}
            WHERE pane.pane_id = ?1
          `).get(paneId));
          if (current.reasoning_proof_tainted === 1) return null;
          const tainted = this.#database.query(`
            UPDATE chat_panes
            SET reasoning_proof_tainted = 1,
                reasoning_active_item_id = NULL,
                revision = revision + 1,
                updated_at = ?3
            WHERE pane_id = ?1 AND active_turn_id = ?2
          `).run(paneId, turnId, timestamp);
          if (tainted.changes !== 1) return null;
          return this.require(paneId).projection;
        }
        return null;
      }
      if (
        isActive(pane.projection) &&
        pane.reasoningItemId !== null && pane.reasoningItemId !== itemId
      ) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "A reasoning completion does not own the active summary item.",
        );
      }
      this.#database.query(`
        INSERT INTO chat_reasoning_item_receipts (
          pane_id, turn_id, item_id, receipt_id, state, completion_digest,
          completion_generation, completion_stream_position,
          completion_fact_index, overflowed, repaired_suffix, taint_reason,
          summary_tail, summary_total_utf8_bytes, summary_truncated_prefix,
          created_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
          ?14, ?15, ?16
        )
      `).run(
        paneId,
        turnId,
        itemId,
        receipt.receiptId,
        receipt.state,
        receipt.completionDigest,
        receipt.completionGeneration,
        receipt.completionStreamPosition,
        receipt.completionFactIndex,
        receipt.overflowed ? 1 : 0,
        receipt.repairedSuffix ? 1 : 0,
        receipt.reason,
        receipt.summary?.tail ?? null,
        receipt.summary?.totalUtf8Bytes ?? null,
        receipt.summary?.truncatedPrefix === undefined
          ? null
          : receipt.summary.truncatedPrefix ? 1 : 0,
        timestamp,
      );

      const currentRow = paneRowSchema.parse(this.#database.query(`
        ${paneWithActiveRoutingSelect()}
        WHERE pane.pane_id = ?1
      `).get(paneId));
      const currentVerified = {
        tail: currentRow.reasoning_verified_tail,
        totalUtf8Bytes: currentRow.reasoning_verified_total_utf8_bytes,
      };
      let verifiedTail = currentVerified.tail;
      let verifiedTotal = currentVerified.totalUtf8Bytes;
      const proofTainted = currentRow.reasoning_proof_tainted === 1 ||
        receipt.state === "tainted";
      if (receipt.state === "verified") {
        const separator = verifiedTotal === 0 || receipt.summary.totalUtf8Bytes === 0
          ? ""
          : "\n\n";
        const separatorBytes = utf8ByteLength(separator);
        if (
          verifiedTotal > Number.MAX_SAFE_INTEGER - separatorBytes ||
          verifiedTotal + separatorBytes >
            Number.MAX_SAFE_INTEGER - receipt.summary.totalUtf8Bytes
        ) {
          throw new ChatPaneStoreError(
            "corrupt_state",
            "Verified reasoning byte count exhausted its safe range.",
          );
        }
        verifiedTotal += separatorBytes + receipt.summary.totalUtf8Bytes;
        verifiedTail = utf8Tail(
          `${verifiedTail}${separator}${receipt.summary.tail}`,
          CHAT_MAX_REASONING_TAIL_UTF8_BYTES,
        );
      }
      const active = isActive(pane.projection);
      const result = this.#database.query(active ? `
          UPDATE chat_panes
          SET reasoning_verified_tail = ?1,
              reasoning_verified_total_utf8_bytes = ?2,
              reasoning_tail = ?1,
              reasoning_total_utf8_bytes = ?2,
              reasoning_active_item_id = NULL,
              reasoning_proof_tainted = ?6,
              activity_ordinal = activity_ordinal + 1,
              activity_kind = 'thinkingCompleted',
              revision = revision + 1,
              updated_at = ?3
          WHERE pane_id = ?4 AND active_turn_id = ?5
            AND state IN ('starting', 'streaming', 'continuing')
            AND activity_ordinal < 9007199254740991
        ` : `
          UPDATE chat_panes
          SET reasoning_verified_tail = ?1,
              reasoning_verified_total_utf8_bytes = ?2,
              reasoning_tail = ?1,
              reasoning_total_utf8_bytes = ?2,
              reasoning_active_item_id = NULL,
              reasoning_proof_tainted = ?6,
              revision = revision + 1,
              updated_at = ?3
          WHERE pane_id = ?4 AND active_turn_id = ?5
            AND state IN ('ready', 'attention')
            AND turn_status IN ('completed', 'failed')
        `).run(
          verifiedTail,
          verifiedTotal,
          timestamp,
          paneId,
          turnId,
          proofTainted ? 1 : 0,
        );
      if (result.changes !== 1) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "Verified reasoning completion could not advance its pane.",
        );
      }
      return this.require(paneId).projection;
    })();
  }

  replaceProviderSubagents(input: Readonly<{
    paneId: ChatPaneId;
    turnId: ChatTurnId;
    projection: ChatProviderSubagentsProjection;
    now: Date;
  }>): ChatPaneProjection | null {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const turnId = chatTurnIdSchema.parse(input.turnId);
    const projection = chatProviderSubagentsProjectionSchema.parse(input.projection);
    const pane = this.get(paneId);
    if (
      pane === null || pane.projection.turn?.id !== turnId ||
      !isActive(pane.projection)
    ) return null;
    if (
      JSON.stringify(pane.projection.turn.providerSubagents) ===
        JSON.stringify(projection)
    ) return null;
    const timestamp = isoDateTimeSchema.parse(input.now.toISOString());
    const result = this.#database.query(`
      UPDATE chat_panes
      SET provider_subagents_json = ?1,
          provider_subagent_overflow_count = ?2,
          revision = revision + 1,
          updated_at = ?3
      WHERE pane_id = ?4 AND active_turn_id = ?5
        AND state IN ('starting', 'streaming', 'continuing')
    `).run(
      JSON.stringify(projection.agents),
      projection.overflowCount,
      timestamp,
      paneId,
      turnId,
    );
    return result.changes === 1 ? this.require(paneId).projection : null;
  }

  clearVolatileProviderSubagents(
    now: Date,
    excludedPaneIds: readonly ChatPaneId[] = [],
  ): void {
    const timestamp = isoDateTimeSchema.parse(now.toISOString());
    const excluded = new Set(
      excludedPaneIds.map((paneId) => chatPaneIdSchema.parse(paneId)),
    );
    this.#database.transaction(() => {
      const candidates: unknown[] = this.#database.query(`
        SELECT pane_id FROM chat_panes
        WHERE provider_subagents_json != '[]'
          OR provider_subagent_overflow_count != 0
          OR reasoning_active_item_id IS NOT NULL
        ORDER BY pane_id
      `).all();
      for (const value of candidates) {
        const paneId = z.object({ pane_id: chatPaneIdSchema })
          .strict().parse(value).pane_id;
        if (excluded.has(paneId)) continue;
        this.#database.query(`
          UPDATE chat_panes
          SET provider_subagents_json = '[]',
              provider_subagent_overflow_count = 0,
              reasoning_tail = CASE
                WHEN reasoning_active_item_id IS NULL
                  THEN reasoning_tail
                ELSE reasoning_verified_tail
              END,
              reasoning_total_utf8_bytes = CASE
                WHEN reasoning_active_item_id IS NULL
                  THEN reasoning_total_utf8_bytes
                ELSE reasoning_verified_total_utf8_bytes
              END,
              reasoning_active_item_id = NULL,
              revision = revision + 1,
              updated_at = ?2
          WHERE pane_id = ?1
            AND (
              provider_subagents_json != '[]'
              OR provider_subagent_overflow_count != 0
              OR reasoning_active_item_id IS NOT NULL
            )
        `).run(paneId, timestamp);
      }
    })();
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
            reasoning_tail = reasoning_verified_tail,
            reasoning_total_utf8_bytes = reasoning_verified_total_utf8_bytes,
            reasoning_active_item_id = NULL,
            provider_subagents_json = '[]',
            provider_subagent_overflow_count = 0,
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
            reasoning_tail = reasoning_verified_tail,
            reasoning_total_utf8_bytes = reasoning_verified_total_utf8_bytes,
            reasoning_active_item_id = NULL,
            provider_subagents_json = '[]',
            provider_subagent_overflow_count = 0,
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
          reasoning_tail = reasoning_verified_tail,
          reasoning_total_utf8_bytes = reasoning_verified_total_utf8_bytes,
          reasoning_active_item_id = NULL,
          provider_subagents_json = '[]',
          provider_subagent_overflow_count = 0,
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
            reasoning_tail = reasoning_verified_tail,
            reasoning_total_utf8_bytes = reasoning_verified_total_utf8_bytes,
            reasoning_active_item_id = NULL,
            provider_subagents_json = '[]',
            provider_subagent_overflow_count = 0,
            attention_code = ?3,
            attention_message = ?4,
            attention_retryable = ?5,
            history_truncated = 0,
            provider_history_floor_sequence = MAX(
              provider_history_floor_sequence,
              COALESCE((
                SELECT MAX(history.sequence)
                FROM chat_pane_history AS history
                WHERE history.pane_id = chat_panes.pane_id
              ), 0)
            ),
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
      return this.require(pane.projection.id).projection;
    })();
  }

  detachUnavailableAccount(
    paneId: ChatPaneId,
    accountProfileId: ChatAccountProfileId,
    now: Date,
    contextPolicy: "preserveHandoff" | "quarantineAttachments" = "preserveHandoff",
    attachmentContainment: Readonly<{
      readonly bindingId: string;
      readonly bindingKeyDigest: string;
      readonly expectedRevision: number;
      readonly containmentReceipt: string;
    }> | null = null,
    providerContextContainmentReceipt: string | null = null,
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
      this.#assertNoPendingProviderThreadArchiveAuthorityV57(id);
      if (contextPolicy === "quarantineAttachments") {
        const contextReceipt = providerContextContainmentReceipt === null
          ? null
          : boundedOpaqueReceipt(providerContextContainmentReceipt);
        if (contextReceipt === null) {
          throw new ChatPaneStoreError(
            "invalid_state",
            "Account detachment requires exact generation containment proof.",
          );
        }
        const classification = this.classifyRetainedProviderAttachmentBinding(
          id,
          pane.binding,
        );
        if (classification.kind === "orphan") {
          throw new ChatPaneStoreError(
            "invalid_state",
            "Attachment custody no longer matches this pane's provider lineage.",
          );
        }
        if (classification.kind === "exact") {
          if (
            attachmentContainment === null ||
            this.#paneArchiveAuthority === null ||
            attachmentContainment.bindingId !== classification.bindingId ||
            attachmentContainment.bindingKeyDigest !==
              classification.bindingKeyDigest ||
            attachmentContainment.expectedRevision !== classification.revision
          ) {
            throw new ChatPaneStoreError(
              "invalid_state",
              "Exact provider containment is required before account detachment.",
            );
          }
          this.#paneArchiveAuthority
            .releaseProviderBindingAfterResumeContainedInTransaction({
              ...attachmentContainment,
              paneId: id,
              now,
            });
        } else if (attachmentContainment !== null) {
          throw new ChatPaneStoreError(
            "revision_conflict",
            "Provider attachment custody changed before account detachment.",
          );
        }
        const pendingArchiveIntent = this.providerThreadArchiveIntent(id);
        if (
          pendingArchiveIntent !== null &&
          pendingArchiveIntent.state !== "account_contained"
        ) {
          this.#database.query(`
            UPDATE chat_provider_thread_archive_intents
            SET state = 'account_contained',
                containment_receipt = NULL,
                response_generation = NULL,
                response_stream_position = NULL,
                ambiguity_receipt = NULL,
                generation_contained = 1,
                generation_containment_receipt = ?2,
                reconciliation_disposition = NULL,
                reconciliation_receipt = NULL,
                updated_at = ?3
            WHERE pane_id = ?1
          `).run(id, contextReceipt, timestamp);
        }
      }
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
              reasoning_tail = reasoning_verified_tail,
              reasoning_total_utf8_bytes = reasoning_verified_total_utf8_bytes,
              reasoning_active_item_id = NULL,
              provider_subagents_json = '[]',
              provider_subagent_overflow_count = 0,
              attention_code = ?4,
              attention_message = ?5,
              attention_retryable = ?6,
              provider_context_reset_required = MAX(
                provider_context_reset_required,
                ?7
              ),
              message_queue_pause_reason = CASE
                WHEN ?7 = 1 AND message_queue_pause_reason IS NULL
                  THEN 'attention'
                ELSE message_queue_pause_reason
              END,
              message_queue_revision = message_queue_revision + CASE
                WHEN ?7 = 1 AND message_queue_pause_reason IS NULL THEN 1
                ELSE 0
              END,
              revision = revision + 1,
              updated_at = ?2
          WHERE pane_id = ?8 AND revision = ?9
            AND state IN ('starting', 'streaming', 'continuing')
        `).run(
          accountId,
          terminalAt,
          JSON.stringify(completeAllTools(pane.projection.turn.tools)),
          contextPolicy === "quarantineAttachments"
            ? "runtime_unavailable"
            : "account_unavailable",
          contextPolicy === "quarantineAttachments"
            ? freshProviderContextAttentionMessage
            : "This Codex subscription became unavailable. HRA will choose another connected subscription when you send again.",
          contextPolicy === "quarantineAttachments" ? 0 : 1,
          contextPolicy === "quarantineAttachments" ? 1 : 0,
          id,
          pane.projection.revision,
        );
        if (result.changes !== 1) return null;
        return this.require(id).projection;
      }
      if (contextPolicy === "quarantineAttachments") {
        const quarantined = this.#database.query(`
          UPDATE chat_panes
          SET account_profile_id = CASE WHEN account_profile_id = ?1 THEN NULL ELSE account_profile_id END,
              state = 'attention',
              provider_account_profile_id = CASE WHEN provider_account_profile_id = ?1 THEN NULL ELSE provider_account_profile_id END,
              provider_thread_id = CASE WHEN provider_account_profile_id = ?1 THEN NULL ELSE provider_thread_id END,
              provider_restart_thread_id = CASE WHEN provider_account_profile_id = ?1 THEN NULL ELSE provider_restart_thread_id END,
              attention_code = 'runtime_unavailable',
              attention_message = ?2,
              attention_retryable = 0,
              provider_context_reset_required = 1,
              message_queue_pause_reason = CASE
                WHEN message_queue_pause_reason IS NULL THEN 'attention'
                ELSE message_queue_pause_reason
              END,
              message_queue_revision = message_queue_revision + CASE
                WHEN message_queue_pause_reason IS NULL THEN 1 ELSE 0
              END,
              revision = revision + 1,
              updated_at = ?3
          WHERE pane_id = ?4 AND revision = ?5
        `).run(
          accountId,
          freshProviderContextAttentionMessage,
          timestamp,
          id,
          pane.projection.revision,
        );
        if (quarantined.changes !== 1) return null;
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
    options: Readonly<{
      preserveAttachedHarness?: boolean;
      excludePaneIds?: readonly ChatPaneId[];
    }> = {},
  ): readonly ChatPaneProjection[] {
    const excludedPaneIds = new Set(
      (options.excludePaneIds ?? []).map((paneId) =>
        chatPaneIdSchema.parse(paneId)
      ),
    );
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
        const paneId = chatPaneIdSchema.parse(row.pane_id);
        if (excludedPaneIds.has(paneId)) continue;
        this.#assertNoPendingProviderThreadArchiveIntent(paneId);
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
        const rowBinding = row.provider_account_profile_id === null ||
            row.provider_thread_id === null ||
            row.provider_restart_thread_id === null
          ? null
          : {
              accountProfileId: row.provider_account_profile_id,
              threadId: row.provider_thread_id,
              restartThreadId: row.provider_restart_thread_id,
            };
        const retainedBinding = this.classifyRetainedProviderAttachmentBinding(
          row.pane_id,
          rowBinding,
        );
        const retainedProviderAttachmentBinding = retainedBinding.kind !== "none";
        const preserveProviderIdentity = retainedBinding.kind === "exact";
        const providerResetRequired =
          row.provider_context_reset_required === 1 ||
          retainedProviderAttachmentBinding;
        this.#database.query(`
          UPDATE chat_panes
          SET state = 'attention',
              turn_status = 'failed',
              turn_completed_at = ?1,
              active_provider_turn_id = NULL,
              provider_account_profile_id = CASE WHEN ?3 = 1
                THEN provider_account_profile_id ELSE NULL END,
              provider_thread_id = CASE WHEN ?3 = 1
                THEN provider_thread_id ELSE NULL END,
              provider_restart_thread_id = CASE WHEN ?3 = 1
                THEN provider_restart_thread_id ELSE NULL END,
              active_turn_poisoned = 1,
              provider_context_reset_required = MAX(
                provider_context_reset_required,
                ?4
              ),
              tools_json = ?2,
              reasoning_tail = reasoning_verified_tail,
              reasoning_total_utf8_bytes = reasoning_verified_total_utf8_bytes,
              reasoning_active_item_id = NULL,
              provider_subagents_json = '[]',
              provider_subagent_overflow_count = 0,
              attention_code = 'runtime_unavailable',
              attention_message = ?5,
              attention_retryable = ?6,
              revision = revision + 1,
              updated_at = ?1
          WHERE pane_id = ?7 AND revision = ?8
        `).run(
          timestamp,
          JSON.stringify(tools),
          preserveProviderIdentity ? 1 : 0,
          providerResetRequired ? 1 : 0,
          providerResetRequired
            ? freshProviderContextAttentionMessage
            : "The previous turn was interrupted when HRA restarted. Send another message to continue.",
          providerResetRequired ? 0 : 1,
          row.pane_id,
          row.revision,
        );
        recoveredPaneIds.push(chatPaneIdSchema.parse(row.pane_id));
      }
      return recoveredPaneIds.map((paneId) => this.require(paneId).projection);
    })();
  }

  handoffHistory(
    paneId: ChatPaneId,
    includeActiveTurn: boolean,
  ): ChatHandoffHistory {
    this.#assertNoPendingProviderThreadArchiveIntent(paneId);
    const pane = this.require(paneId);
    if (pane.providerContextResetRequired) {
      return { items: [], complete: false };
    }
    const values: unknown[] = this.#database.query(`
      SELECT role, text, utf8_bytes
      FROM chat_pane_history
      WHERE pane_id = ?1
        AND sequence > (
          SELECT provider_history_floor_sequence
          FROM chat_panes WHERE pane_id = ?1
        )
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
      SELECT MAX(
        COALESCE((
          SELECT MAX(sequence) FROM chat_pane_history WHERE pane_id = ?1
        ), 0),
        (
          SELECT provider_history_floor_sequence
          FROM chat_panes WHERE pane_id = ?1
        )
      ) + 1 AS sequence
    `).get(paneId);
    const { sequence } = sequenceRowSchema.parse(sequenceValue);
    const utf8Bytes = utf8ByteLength(text);
    this.#database.query(`
      INSERT INTO chat_pane_history(pane_id, sequence, role, text, utf8_bytes, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    `).run(paneId, sequence, role, text, utf8Bytes, createdAt);
  }

  #advanceProviderHistoryFloor(paneId: ChatPaneId): void {
    const advanced = this.#database.query(`
      UPDATE chat_panes
      SET provider_history_floor_sequence = MAX(
        provider_history_floor_sequence,
        COALESCE((
          SELECT MAX(history.sequence)
          FROM chat_pane_history AS history
          WHERE history.pane_id = chat_panes.pane_id
        ), 0)
      )
      WHERE pane_id = ?1
    `).run(paneId);
    if (advanced.changes !== 1) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "The provider history handoff floor could not advance.",
      );
    }
  }

  #enforceHistoryBounds(paneId: ChatPaneId): void {
    while (this.#historyBytes(paneId) > CHAT_MAX_HISTORY_UTF8_BYTES_PER_PANE) {
      if (!this.#evictOldestHistory("WHERE pane_id = ?1", [paneId])) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "No unquarantined pane history can satisfy the per-pane bound.",
        );
      }
    }
    while (this.#totalHistoryBytes() > CHAT_MAX_HISTORY_UTF8_BYTES_TOTAL) {
      if (!this.#evictOldestHistory("", [])) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "No unquarantined pane history can satisfy the global bound.",
        );
      }
    }
  }

  #evictOldestHistory(where: string, parameters: readonly string[]): boolean {
    const values: unknown[] = this.#database.query(`
      SELECT pane_id, sequence
      FROM chat_pane_history
      ${where}
      ORDER BY created_at, pane_id, sequence
    `).all(...parameters);
    const rows = z.array(z.object({
      pane_id: chatPaneIdSchema,
      sequence: z.number().int().positive().safe(),
    }).strict()).parse(values);
    const checkedPaneIds = new Set<ChatPaneId>();
    for (const row of rows) {
      if (checkedPaneIds.has(row.pane_id)) continue;
      checkedPaneIds.add(row.pane_id);
      try {
        this.#assertNoPendingProviderThreadArchiveAuthorityV57(row.pane_id);
      } catch (error: unknown) {
        if (
          error instanceof ChatPaneStoreError &&
          error.code === "invalid_state"
        ) continue;
        throw error;
      }
      this.#database.query(`
        DELETE FROM chat_pane_history WHERE pane_id = ?1 AND sequence = ?2
      `).run(row.pane_id, row.sequence);
      this.#database.query(`
        UPDATE chat_panes SET history_truncated = 1 WHERE pane_id = ?1
      `).run(row.pane_id);
      return true;
    }
    return false;
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

  #requireMessageQueueMetadata(
    paneIdInput: ChatPaneId,
  ): ChatMessageQueueMetadataRow {
    const paneId = chatPaneIdSchema.parse(paneIdInput);
    const value: unknown = this.#database.query(`
      SELECT
        pane_id, interaction_mode, state, active_turn_id, archived_at,
        message_queue_revision, next_message_ordinal,
        message_queue_pause_reason
      FROM chat_panes
      WHERE pane_id = ?1 AND archived_at IS NULL
    `).get(paneId);
    if (value === null) {
      throw new ChatPaneStoreError("not_found", "This chat pane no longer exists.");
    }
    try {
      return chatMessageQueueMetadataRowSchema.parse(value);
    } catch {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "Stored chat message queue metadata is invalid.",
      );
    }
  }

  #requireMessageQueueRevision(
    paneId: ChatPaneId,
    expectedRevision: number,
  ): ChatMessageQueueMetadataRow {
    validateRevision(expectedRevision);
    const metadata = this.#requireMessageQueueMetadata(paneId);
    if (metadata.message_queue_revision !== expectedRevision) {
      throw staleQueueRevision();
    }
    return metadata;
  }

  #assertNoUnresolvedAmbiguousMessage(paneId: ChatPaneId): void {
    const value: unknown = this.#database.query(`
      SELECT COUNT(*) AS count
      FROM chat_message_ledger AS message
      LEFT JOIN chat_message_ambiguous_resolutions AS resolution
        ON resolution.message_id = message.message_id
      WHERE message.pane_id = ?1 AND message.state = 'ambiguous'
        AND resolution.message_id IS NULL
    `).get(paneId);
    if (countRowSchema.parse(value).count > 0) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Resolve the ambiguous message effect before starting another turn.",
      );
    }
  }

  #messageQueueProjection(
    metadata: ChatMessageQueueMetadataRow,
  ): ChatMessageQueueProjection {
    const values: unknown[] = this.#database.query(`
      SELECT * FROM chat_message_ledger
        INDEXED BY chat_message_ledger_queued_head_idx
      WHERE pane_id = ?1 AND state = 'queued'
      ORDER BY ordinal, message_id
      LIMIT ?2
    `).all(metadata.pane_id, CHAT_MESSAGE_MAX_ACTIVE_PER_PANE + 1);
    if (values.length > CHAT_MESSAGE_MAX_ACTIVE_PER_PANE) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "Stored queued chat message count exceeded its projection limit.",
      );
    }
    const messages = values.map((value) => {
      const row = this.#parseMessageRow(value);
      const content = this.#messageContent(row);
      return {
        id: row.message_id,
        ordinal: row.ordinal,
        revision: row.revision,
        ...content,
      };
    });
    const blockedValues: unknown[] = this.#database.query(`
      SELECT message.* FROM chat_message_ledger AS message
      LEFT JOIN chat_message_ambiguous_resolutions AS resolution
        ON resolution.message_id = message.message_id
      WHERE message.pane_id = ?1 AND message.state = 'ambiguous'
        AND resolution.message_id IS NULL
      ORDER BY message.ordinal, message.message_id
      LIMIT 2
    `).all(metadata.pane_id);
    if (blockedValues.length > 1) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "A message queue has more than one unresolved delivery outcome.",
      );
    }
    const blockedRow = blockedValues[0] === undefined
      ? null
      : this.#parseMessageRow(blockedValues[0]);
    const blockedMessage = blockedRow === null
      ? null
      : {
          id: blockedRow.message_id,
          ordinal: blockedRow.ordinal,
          revision: blockedRow.revision,
          ...this.#messageContent(blockedRow),
          deliveryOutcome: "deliveryOutcomeUnknown" as const,
        };
    try {
      return parseChatMessageQueueProjection({
        revision: metadata.message_queue_revision,
        pauseReason: projectQueuePauseReason(
          metadata.message_queue_pause_reason,
        ),
        blockedMessage,
        messages,
      });
    } catch {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "Stored chat message queue projection is invalid.",
      );
    }
  }

  #parseMessageRow(value: unknown): ChatMessageLedgerRow {
    try {
      const row = chatMessageLedgerRowSchema.parse(value);
      if (utf8ByteLength(row.message_text) !== row.message_utf8_bytes) {
        throw new Error("message byte count drifted");
      }
      return row;
    } catch {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "Stored chat message ledger state is invalid.",
      );
    }
  }

  #messageRow(messageId: string): ChatMessageLedgerRow | null {
    const value: unknown = this.#database.query(`
      SELECT * FROM chat_message_ledger WHERE message_id = ?1
    `).get(chatMessageIdSchema.parse(messageId));
    return value === null ? null : this.#parseMessageRow(value);
  }

  #requireMessageRowForPane(
    paneId: ChatPaneId,
    messageId: string,
  ): ChatMessageLedgerRow {
    const row = this.#messageRow(messageId);
    if (row === null || row.pane_id !== paneId) {
      throw new ChatPaneStoreError(
        "not_found",
        "This queued chat message no longer exists.",
      );
    }
    return row;
  }

  #messageContent(row: ChatMessageLedgerRow) {
    let attachmentRefs;
    try {
      attachmentRefs = this.#messageAttachmentAuthority.messageRefsInTransaction({
        paneId: row.pane_id,
        messageId: row.message_id,
      });
    } catch {
      throw new ChatPaneStoreError(
        "invalid_state",
        "A queued chat attachment is no longer ready for this pane.",
      );
    }
    try {
      return parseChatMessageContent({
        text: row.message_text,
        attachmentRefs,
      });
    } catch {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "Stored chat message content is invalid.",
      );
    }
  }

  #messageRequestMatches(
    row: ChatMessageLedgerRow,
    requestFingerprintHmac: string,
    intent: Readonly<{
      requestDeliveryKind: "queue" | "steer_head";
      requestSteerTurnId: ChatTurnId | null;
    }>,
  ): boolean {
    if (
      row.request_delivery_kind !== intent.requestDeliveryKind ||
      row.request_steer_turn_id !== intent.requestSteerTurnId ||
      row.request_fingerprint_hmac === null
    ) return false;
    return timingSafeEqual(
      Buffer.from(row.request_fingerprint_hmac, "hex"),
      Buffer.from(requestFingerprintHmac, "hex"),
    );
  }

  #messageRequestFingerprint(input: Readonly<{
    paneId: ChatPaneId;
    messageId: ChatMessageLedgerRow["message_id"];
    content: ReturnType<typeof parseChatMessageContent>;
    delivery: Readonly<
      { kind: "queue" } |
      { kind: "steerHead"; expectedTurnId: ChatTurnId }
    >;
  }>): string {
    return createHmac("sha256", this.#messageRequestDigestKey)
      .update("hra-chat-message-request-v1\0")
      .update(JSON.stringify({
        paneId: input.paneId,
        messageId: input.messageId,
        text: input.content.text,
        attachmentRefs: input.content.attachmentRefs,
        delivery: input.delivery,
      }))
      .digest("hex");
  }

  #bindReadyMessageAttachments(
    paneId: ChatPaneId,
    messageId: ChatMessageLedgerRow["message_id"],
    content: ReturnType<typeof parseChatMessageContent>,
    now: string,
  ): void {
    try {
      this.#messageAttachmentAuthority.bindReadyMessageRefsInTransaction({
        paneId,
        messageId,
        attachmentRefs: content.attachmentRefs,
        now,
      });
    } catch {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Every chat message attachment must be ready for this pane.",
      );
    }
  }

  #replaceReadyMessageAttachments(
    paneId: ChatPaneId,
    messageId: ChatMessageLedgerRow["message_id"],
    content: ReturnType<typeof parseChatMessageContent>,
    now: string,
  ): void {
    try {
      this.#messageAttachmentAuthority.replaceReadyMessageRefsInTransaction({
        paneId,
        messageId,
        attachmentRefs: content.attachmentRefs,
        now,
      });
    } catch {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Every edited chat attachment must be ready for this pane.",
      );
    }
  }

  #clearMessageAttachments(
    paneId: ChatPaneId,
    messageId: ChatMessageLedgerRow["message_id"],
    now: string,
  ): void {
    try {
      this.#messageAttachmentAuthority.replaceReadyMessageRefsInTransaction({
        paneId,
        messageId,
        attachmentRefs: [],
        now,
      });
    } catch {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "Cancelled chat attachment references could not be released.",
      );
    }
  }

  #acquireMessageAttachmentLeases(
    paneId: ChatPaneId,
    messageId: ChatMessageLedgerRow["message_id"],
    turnId: ChatTurnId,
    now: string,
  ): void {
    try {
      this.#messageAttachmentAuthority.acquireTurnLeasesInTransaction({
        paneId,
        messageId,
        turnId,
        now,
      });
    } catch {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The chat attachment lease could not be acquired atomically.",
      );
    }
  }

  #releasePreparedMessageAttachmentLeases(
    paneId: ChatPaneId,
    messageId: ChatMessageLedgerRow["message_id"],
    turnId: ChatTurnId,
    now: string,
  ): void {
    try {
      this.#messageAttachmentAuthority.releasePreparedTurnLeasesInTransaction({
        paneId,
        messageId,
        turnId,
        now,
      });
    } catch {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "The prepared chat attachment lease set is incomplete.",
      );
    }
  }

  #markMessageAttachmentLeasesAmbiguous(
    paneId: ChatPaneId,
    messageId: ChatMessageLedgerRow["message_id"],
    turnId: ChatTurnId,
    now: string,
  ): void {
    try {
      this.#messageAttachmentAuthority.markTurnLeasesAmbiguousInTransaction({
        paneId,
        messageId,
        turnId,
        now,
      });
    } catch {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "The ambiguous chat attachment lease set is incomplete.",
      );
    }
  }

  #releaseMessageAttachmentLeases(
    paneId: ChatPaneId,
    messageId: ChatMessageLedgerRow["message_id"],
    turnId: ChatTurnId,
    now: string,
  ): void {
    try {
      this.#messageAttachmentAuthority.releaseTurnLeasesInTransaction({
        paneId,
        messageId,
        turnId,
        now,
      });
    } catch {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "The terminal chat attachment lease set is incomplete.",
      );
    }
  }

  #queuedHead(paneId: ChatPaneId): ChatMessageLedgerRow | null {
    const value: unknown = this.#database.query(`
      SELECT * FROM chat_message_ledger
        INDEXED BY chat_message_ledger_queued_head_idx
      WHERE pane_id = ?1 AND state = 'queued'
      ORDER BY ordinal, message_id
      LIMIT 1
    `).get(paneId);
    return value === null ? null : this.#parseMessageRow(value);
  }

  #requireQueuedMessageRevision(
    row: ChatMessageLedgerRow,
    expectedRevision: number,
  ): void {
    if (row.revision !== expectedRevision) throw staleMessageRevision();
    if (row.state !== "queued") {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Only an unclaimed queued message can be changed.",
      );
    }
  }

  #assertMessagePayloadCapacity(
    paneId: ChatPaneId,
    change: Readonly<{
      addedRows: 0 | 1;
      replacedBytes: number;
      nextBytes: number;
    }>,
  ): void {
    const value: unknown = this.#database.query(`
      SELECT
        (
          SELECT COUNT(*) FROM chat_message_ledger
          WHERE pane_id = ?1 AND state NOT IN ('completed', 'cancelled')
            AND NOT (state = 'ambiguous' AND EXISTS (
              SELECT 1 FROM chat_message_ambiguous_resolutions AS resolution
              WHERE resolution.message_id = chat_message_ledger.message_id
                AND resolution.pane_id = chat_message_ledger.pane_id
                AND resolution.claimed_turn_id =
                  chat_message_ledger.claimed_turn_id
                AND resolution.resolution = 'discarded'
            ))
        ) AS active_count,
        (
          SELECT COALESCE(SUM(message_utf8_bytes), 0)
          FROM chat_message_ledger
          WHERE pane_id = ?1 AND state NOT IN ('completed', 'cancelled')
            AND NOT (state = 'ambiguous' AND EXISTS (
              SELECT 1 FROM chat_message_ambiguous_resolutions AS resolution
              WHERE resolution.message_id = chat_message_ledger.message_id
                AND resolution.pane_id = chat_message_ledger.pane_id
                AND resolution.claimed_turn_id =
                  chat_message_ledger.claimed_turn_id
                AND resolution.resolution = 'discarded'
            ))
        ) AS pane_bytes,
        (
          SELECT COALESCE(SUM(message_utf8_bytes), 0)
          FROM chat_message_ledger
          WHERE state NOT IN ('completed', 'cancelled')
            AND NOT (state = 'ambiguous' AND EXISTS (
              SELECT 1 FROM chat_message_ambiguous_resolutions AS resolution
              WHERE resolution.message_id = chat_message_ledger.message_id
                AND resolution.pane_id = chat_message_ledger.pane_id
                AND resolution.claimed_turn_id =
                  chat_message_ledger.claimed_turn_id
                AND resolution.resolution = 'discarded'
            ))
        ) AS global_bytes
    `).get(paneId);
    const totals = chatMessagePayloadTotalsSchema.parse(value);
    const activeCount = totals.active_count + change.addedRows;
    const paneBytes = totals.pane_bytes - change.replacedBytes + change.nextBytes;
    const globalBytes = totals.global_bytes - change.replacedBytes + change.nextBytes;
    if (activeCount > CHAT_MESSAGE_MAX_ACTIVE_PER_PANE) {
      throw new ChatPaneStoreError(
        "limit",
        "This chat pane already has the maximum number of pending messages.",
      );
    }
    if (paneBytes > CHAT_MESSAGE_MAX_UTF8_BYTES_PER_PANE) {
      throw new ChatPaneStoreError(
        "limit",
        "This chat pane's complete queued text exceeds its private local limit.",
      );
    }
    if (globalBytes > CHAT_MESSAGE_MAX_UTF8_BYTES_TOTAL) {
      throw new ChatPaneStoreError(
        "limit",
        "Queued chat text reached the private local database limit.",
      );
    }
  }

  #advanceMessageQueueRevision(
    paneId: ChatPaneId,
    expectedRevision: number,
    now: string,
  ): void {
    const result = this.#database.query(`
      UPDATE chat_panes SET
        message_queue_revision = message_queue_revision + 1,
        updated_at = ?3
      WHERE pane_id = ?1 AND message_queue_revision = ?2
        AND archived_at IS NULL
    `).run(paneId, expectedRevision, now);
    if (result.changes !== 1) throw staleQueueRevision();
  }

  #requireClaimTransition(
    row: ChatMessageLedgerRow,
    expectedRevision: number,
    turnId: ChatTurnId,
    expectedState: StoredChatMessageState,
  ): void {
    if (row.revision !== expectedRevision) throw staleMessageRevision();
    if (row.state !== expectedState || row.claimed_turn_id !== turnId) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The claimed chat message is no longer at the expected lifecycle cut.",
      );
    }
  }

  #transitionClaim(
    input: ChatMessageTransitionInput,
    states: Readonly<Record<
      "start" | "steer",
      Readonly<{ from: StoredChatMessageState; to: StoredChatMessageState }>
    >>,
    action: string,
    timestamps: Readonly<{
      effectStartedAt?: boolean;
      acknowledgedAt?: boolean;
      terminalAt?: boolean;
      steerRequestOutcome?: "accepted" | "effect_started";
    }> = {},
  ): ChatMessageQueueProjection {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const messageId = chatMessageIdSchema.parse(input.messageId);
    const turnId = chatTurnIdSchema.parse(input.turnId);
    validateRevision(input.expectedMessageRevision);
    const now = isoDateTimeSchema.parse(input.now.toISOString());
    const transition = states[input.kind];
    return this.#database.transaction(() => {
      this.#assertNoPendingProviderThreadArchiveIntent(paneId);
      const metadata = this.#requireMessageQueueMetadata(paneId);
      const row = this.#requireMessageRowForPane(paneId, messageId);
      this.#requireClaimTransition(
        row,
        input.expectedMessageRevision,
        turnId,
        transition.from,
      );
      const updates = [
        "state = ?5",
        "revision = revision + 1",
        "updated_at = ?6",
      ];
      if (transition.to === "queued") updates.push("claimed_turn_id = NULL");
      if (timestamps.effectStartedAt) updates.push("effect_started_at = ?6");
      if (timestamps.acknowledgedAt) updates.push("acknowledged_at = ?6");
      if (timestamps.terminalAt) updates.push("terminal_at = ?6");
      if (
        timestamps.steerRequestOutcome !== undefined &&
        input.kind === "steer" &&
        row.request_delivery_kind === "steer_head"
      ) {
        updates.push(
          `request_delivery_outcome = '${timestamps.steerRequestOutcome}'`,
        );
      }
      const updated = this.#database.query(`
        UPDATE chat_message_ledger SET ${updates.join(", ")}
        WHERE pane_id = ?1 AND message_id = ?2 AND revision = ?3
          AND claimed_turn_id = ?4 AND state = '${transition.from}'
      `).run(
        paneId,
        messageId,
        input.expectedMessageRevision,
        turnId,
        transition.to,
        now,
      );
      if (updated.changes !== 1) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          `The claimed chat message changed before HRA could ${action}.`,
        );
      }
      if (transition.to === "queued") {
        this.#releasePreparedMessageAttachmentLeases(
          paneId,
          messageId,
          turnId,
          now,
        );
      } else if (transition.to === "completed") {
        this.#releaseMessageAttachmentLeases(
          paneId,
          messageId,
          turnId,
          now,
        );
      }
      this.#advanceMessageQueueRevision(
        paneId,
        metadata.message_queue_revision,
        now,
      );
      return this.messageQueue(paneId);
    })();
  }

  #closeMessageQueueForPane(paneId: ChatPaneId, now: string): void {
    const metadata = this.#requireMessageQueueMetadata(paneId);
    this.#assertMessageQueueClosableForPane(paneId);
    const cancellable: unknown[] = this.#database.query(`
      SELECT * FROM chat_message_ledger
      WHERE pane_id = ?1 AND state IN (
        'queued', 'start_claimed', 'steer_prepared'
      )
      ORDER BY ordinal, message_id
    `).all(paneId);
    const rows = cancellable.map((value) => this.#parseMessageRow(value));
    for (const row of rows) {
      if (row.state === "start_claimed" || row.state === "steer_prepared") {
        if (row.claimed_turn_id === null) {
          throw new ChatPaneStoreError(
            "corrupt_state",
            "A prepared chat message lost its claimed turn.",
          );
        }
        this.#releasePreparedMessageAttachmentLeases(
          paneId,
          row.message_id,
          row.claimed_turn_id,
          now,
        );
      }
      this.#clearMessageAttachments(paneId, row.message_id, now);
    }
    const cancelled = this.#database.query(`
      UPDATE chat_message_ledger SET
        state = 'cancelled',
        revision = revision + 1,
        terminal_at = ?2,
        updated_at = ?2
      WHERE pane_id = ?1 AND state IN (
        'queued', 'start_claimed', 'steer_prepared'
      )
    `).run(paneId, now);
    if (cancelled.changes !== rows.length) {
      throw new ChatPaneStoreError(
        "revision_conflict",
        "The message queue changed before this pane could close.",
      );
    }
    if (rows.length > 0) {
      this.#advanceMessageQueueRevision(
        paneId,
        metadata.message_queue_revision,
        now,
      );
    }
  }

  #requireProviderThreadArchiveJournalV57():
    ProviderThreadArchiveJournalV57 {
    return this.#providerThreadArchiveJournalV57;
  }

  #providerArchiveTargetAuthorityRowV57(
    targetIdValue: string,
  ): z.infer<typeof providerArchiveTargetAuthorityRowSchema> {
    const targetId = providerArchiveTargetIdSchema.parse(targetIdValue);
    const value: unknown = this.#database.query(`
      SELECT target_id, pane_id, purpose, pane_revision, queue_revision,
        pane_cas_digest, queue_cas_digest,
        account_profile_id, account_profile_revision, thread_id,
        restart_thread_id, binding_id, binding_key_digest, binding_revision,
        current_attempt_id, current_attempt_ordinal, status, identity_hmac,
        pointer_hmac, commit_evidence_digest, commit_revision_digest,
        commit_hmac, committed_at
      FROM chat_provider_thread_archive_targets_v57 WHERE target_id = ?1
    `).get(targetId);
    if (value === null) {
      throw new ChatPaneStoreError(
        "not_found",
        "The v57 provider archive target no longer exists.",
      );
    }
    return providerArchiveTargetAuthorityRowSchema.parse(value);
  }

  #providerArchiveAttemptAuthorityRowV57(
    attemptIdValue: string,
  ): z.infer<typeof providerArchiveAttemptAuthorityRowSchema> {
    const attemptId = providerArchiveAttemptIdSchema.parse(attemptIdValue);
    const value: unknown = this.#database.query(`
      SELECT attempt_id, target_id, ordinal, generation,
        account_profile_revision, predecessor_attempt_id,
        cut_id, state, request_evidence_digest, request_revision_digest,
        identity_hmac, cut_binding_hmac,
        effect_evidence_digest, effect_revision_digest, effect_hmac,
        ambiguity_evidence_digest, ambiguity_revision_digest, ambiguity_hmac,
        outcome_evidence_digest, outcome_revision_digest,
        response_generation, response_stream_position, outcome_hmac
      FROM chat_provider_thread_archive_attempts_v57 WHERE attempt_id = ?1
    `).get(attemptId);
    if (value === null) {
      throw new ChatPaneStoreError(
        "not_found",
        "The v57 provider archive attempt no longer exists.",
      );
    }
    return providerArchiveAttemptAuthorityRowSchema.parse(value);
  }

  #providerArchiveCutAuthorityRowV57(
    cutIdValue: string,
  ): z.infer<typeof providerArchiveCutAuthorityRowSchema> {
    const cutId = providerArchiveCutIdSchema.parse(cutIdValue);
    const value: unknown = this.#database.query(`
      SELECT cut_id, account_profile_id, account_profile_revision,
        source_generation, cause, initiating_attempt_id, predecessor_cut_id,
        state, successor_generation,
        successor_account_profile_revision,
        identity_evidence_digest, identity_revision_digest, identity_hmac,
        fence_hmac, member_count, inventory_digest,
        enumeration_authority_digest, seal_revision_digest, seal_hmac,
        containment_evidence_digest, containment_revision_digest,
        containment_hmac
      FROM chat_provider_thread_archive_cuts_v57 WHERE cut_id = ?1
    `).get(cutId);
    if (value === null) {
      throw new ChatPaneStoreError(
        "not_found",
        "The v57 provider archive cut no longer exists.",
      );
    }
    return providerArchiveCutAuthorityRowSchema.parse(value);
  }

  #providerArchiveOrdinaryCutTargetIdsV57(
    cut: ProviderThreadArchiveCutSnapshotV57,
  ): readonly string[] {
    const frozenTargetIds = cut.members.filter((member) =>
      member.role === "target"
    ).map((member) => {
      const stored = this.#providerArchiveMemberAuthorityRowV57(
        member.memberId,
      );
      if (stored.target_id === null || stored.cut_id !== cut.cutId) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "A v57 cut target member lost its exact target authority.",
        );
      }
      return stored.target_id;
    });
    const targetIds = frozenTargetIds.length > 0
      ? frozenTargetIds
      : this.#database.query(`
          SELECT DISTINCT target_id
          FROM chat_provider_thread_archive_attempts_v57
          WHERE cut_id = ?1 ORDER BY target_id
        `).all(cut.cutId).map((value) =>
          z.object({ target_id: providerArchiveTargetIdSchema })
            .strict().parse(value).target_id
        );
    targetIds.sort(compareProviderArchiveCodeUnits);
    if (
      targetIds.length !== cut.targetCount ||
      new Set(targetIds).size !== targetIds.length
    ) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "The v57 cut lost its complete target cohort.",
      );
    }
    return Object.freeze(targetIds);
  }

  #assertProviderArchiveLostResponseCutAuthorityV57(
    cut: ProviderThreadArchiveCutSnapshotV57,
  ): readonly string[] {
    if (cut.cause === "account_removal" || cut.initiatingAttemptId === null) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The ordinary v57 cut lost its initiating provider effect.",
      );
    }
    const cutRow = this.#providerArchiveCutAuthorityRowV57(cut.cutId);
    if (
      cutRow.account_profile_id !== cut.accountProfileId ||
      cutRow.account_profile_revision !== cut.accountProfileRevision ||
      cutRow.source_generation !== cut.sourceGeneration ||
      cutRow.cause !== cut.cause ||
      cutRow.initiating_attempt_id !== cut.initiatingAttemptId
    ) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "The v57 cut identity disagrees with its keyed journal snapshot.",
      );
    }
    const initiatingAttempt = this.#providerArchiveAttemptAuthorityRowV57(
      cut.initiatingAttemptId,
    );
    const initiatingTarget = this.#providerArchiveTargetAuthorityRowV57(
      initiatingAttempt.target_id,
    );
    const initiatingTargetSnapshot =
      this.#requireProviderThreadArchiveJournalV57().reopenTarget(
        initiatingAttempt.target_id,
      );
    this.#assertProviderArchiveTargetStoreAuthorityV57(
      initiatingTargetSnapshot,
    );
    const expectedPredecessorCutId = [...initiatingTargetSnapshot.attempts]
      .reverse()
      .find((attempt) =>
        attempt.ordinal < initiatingAttempt.ordinal && attempt.cutId !== null
      )?.cutId ?? null;
    if (cutRow.predecessor_cut_id !== expectedPredecessorCutId) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "The v57 cut lost its initiating target predecessor lineage.",
      );
    }
    const affectedTargetIds = this.#providerArchiveOrdinaryCutTargetIdsV57(
      cut,
    );
    const expectedIdentityEvidence = this.#providerArchiveHmacV57(
      "lost-response-cut-evidence",
      {
        cutId: cut.cutId,
        cause: cut.cause,
        initiatingTargetId: initiatingAttempt.target_id,
        initiatingAttemptId: initiatingAttempt.attempt_id,
        accountProfileId: cut.accountProfileId,
        sourceGeneration: cut.sourceGeneration,
        predecessorCutId: cutRow.predecessor_cut_id,
        affectedTargetIds,
      },
    );
    const expectedIdentityRevision = this.#providerArchiveHmacV57(
      "lost-response-cut-revision",
      {
        cutId: cut.cutId,
        targetIdentityHmac: initiatingTarget.identity_hmac,
        initiatingAttemptIdentityHmac: initiatingAttempt.identity_hmac,
        initiatingAttemptEffectHmac: initiatingAttempt.effect_hmac,
        accountProfileRevision: cut.accountProfileRevision,
      },
    );
    if (
      cutRow.identity_evidence_digest !== expectedIdentityEvidence ||
      cutRow.identity_revision_digest !== expectedIdentityRevision
    ) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "The v57 cut lacks its exact store-owned identity evidence.",
      );
    }
    const attemptValues: unknown[] = this.#database.query(`
      SELECT attempt_id
      FROM chat_provider_thread_archive_attempts_v57
      WHERE cut_id = ?1 ORDER BY target_id, ordinal
    `).all(cut.cutId);
    if (attemptValues.length !== affectedTargetIds.length) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "The v57 cut ambiguity cohort changed after binding.",
      );
    }
    for (const value of attemptValues) {
      const attemptId = z.object({
        attempt_id: providerArchiveAttemptIdSchema,
      }).strict().parse(value).attempt_id;
      const attempt = this.#providerArchiveAttemptAuthorityRowV57(attemptId);
      const target = this.#providerArchiveTargetAuthorityRowV57(
        attempt.target_id,
      );
      this.#assertProviderArchiveTargetStoreAuthorityV57(
        this.#requireProviderThreadArchiveJournalV57().reopenTarget(
          attempt.target_id,
        ),
      );
      const expectedAmbiguityEvidence = this.#providerArchiveHmacV57(
        "lost-response-ambiguity-evidence",
        {
          cutId: cut.cutId,
          cause: cut.cause,
          targetId: attempt.target_id,
          attemptId: attempt.attempt_id,
          generation: attempt.generation,
        },
      );
      const expectedAmbiguityRevision = this.#providerArchiveHmacV57(
        "lost-response-ambiguity-revision",
        {
          cutId: cut.cutId,
          targetIdentityHmac: target.identity_hmac,
          attemptIdentityHmac: attempt.identity_hmac,
          attemptEffectHmac: attempt.effect_hmac,
          attemptCutBindingHmac: attempt.cut_binding_hmac,
          cutIdentityHmac: cutRow.identity_hmac,
        },
      );
      if (
        attempt.ambiguity_evidence_digest !== expectedAmbiguityEvidence ||
        attempt.ambiguity_revision_digest !== expectedAmbiguityRevision
      ) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "A v57 cut attempt lacks its exact store-owned ambiguity evidence.",
        );
      }
    }
    return affectedTargetIds;
  }

  #providerArchiveFrozenMemberInputsV57(
    cut: ProviderThreadArchiveCutSnapshotV57,
  ): readonly AddProviderThreadArchiveCutMemberV57[] {
    const members = cut.members.map((member) => {
      const stored = this.#providerArchiveMemberAuthorityRowV57(
        member.memberId,
      );
      if (
        stored.cut_id !== cut.cutId || stored.pane_id !== member.paneId ||
        stored.role !== member.role || stored.action !== member.action
      ) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "A frozen v57 member disagrees with its keyed cut snapshot.",
        );
      }
      const binding: ProviderThreadArchiveBindingPreimageV57 =
        stored.binding_id === null
          ? Object.freeze({ kind: "none" as const })
          : Object.freeze({
              kind: "exact" as const,
              bindingId: stored.binding_id,
              bindingKeyDigest: stored.binding_key_digest ?? corrupt(
                "A frozen v57 member lost its binding key digest.",
              ),
              bindingRevision: stored.binding_revision ?? corrupt(
                "A frozen v57 member lost its binding revision.",
              ),
            });
      return Object.freeze({
        memberId: stored.member_id,
        cutId: stored.cut_id,
        paneId: stored.pane_id,
        paneRevision: stored.pane_revision,
        paneCasDigest: stored.pane_cas_digest,
        threadId: stored.thread_id,
        restartThreadId: stored.restart_thread_id,
        role: stored.role,
        targetId: stored.target_id,
        attemptId: stored.attempt_id,
        targetAttemptOrdinal: stored.target_attempt_ordinal,
        action: stored.action,
        binding,
        identityEvidenceDigest: stored.identity_evidence_digest,
        identityRevisionDigest: stored.identity_revision_digest,
        now: new Date(0),
      });
    }).sort((left, right) =>
      compareProviderArchiveCodeUnits(left.paneId, right.paneId)
    );
    return Object.freeze(members);
  }

  #assertProviderArchiveSourceSealAuthorityV57(
    cut: ProviderThreadArchiveCutSnapshotV57,
  ): void {
    if (cut.cause === "account_removal") return;
    if (!["sealed", "contained"].includes(cut.state)) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The v57 source inventory is not durably sealed.",
      );
    }
    const cutRow = this.#providerArchiveCutAuthorityRowV57(cut.cutId);
    const members = this.#providerArchiveFrozenMemberInputsV57(cut);
    const expectedInventoryDigest =
      providerThreadArchiveCompleteInventoryDigestV57(members);
    const expectedEnumerationAuthority = this.#providerArchiveHmacV57(
      "complete-source-enumeration",
      {
        cutId: cut.cutId,
        accountProfileId: cut.accountProfileId,
        sourceGeneration: cut.sourceGeneration,
        expectedMemberCount: members.length,
        expectedInventoryDigest,
        members: members.map((member) => ({
          memberId: member.memberId,
          paneId: member.paneId,
          paneRevision: member.paneRevision,
          paneCasDigest: member.paneCasDigest,
          role: member.role,
          targetId: member.targetId,
          attemptId: member.attemptId,
          targetAttemptOrdinal: member.targetAttemptOrdinal,
          action: member.action,
          binding: member.binding,
          identityEvidenceDigest: member.identityEvidenceDigest,
          identityRevisionDigest: member.identityRevisionDigest,
        })),
      },
    );
    const expectedSealRevision = this.#providerArchiveHmacV57(
      "source-inventory-seal-revision",
      {
        cutId: cut.cutId,
        sourceGeneration: cut.sourceGeneration,
        successorGeneration: cut.successorGeneration,
        expectedMemberCount: members.length,
        expectedInventoryDigest,
        enumerationAuthorityDigest: expectedEnumerationAuthority,
      },
    );
    if (
      cutRow.member_count !== members.length ||
      cutRow.inventory_digest !== expectedInventoryDigest ||
      cutRow.enumeration_authority_digest !== expectedEnumerationAuthority ||
      cutRow.seal_revision_digest !== expectedSealRevision ||
      cutRow.seal_hmac === null
    ) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "The v57 source cut lacks its exact store-owned sealed inventory authority.",
      );
    }
  }

  #assertProviderArchiveSourceContainedAuthorityV57(
    cut: ProviderThreadArchiveCutSnapshotV57,
  ): void {
    this.#assertProviderArchiveLostResponseCutAuthorityV57(cut);
    this.#assertProviderArchiveSourceSealAuthorityV57(cut);
    if (
      cut.state !== "contained" ||
      cut.members.some((member) => member.state !== "settled")
    ) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The v57 cut lacks complete contained member authority.",
      );
    }
    const cutRow = this.#providerArchiveCutAuthorityRowV57(cut.cutId);
    const expectedEvidence = this.#providerArchiveHmacV57(
      "source-cut-containment-evidence",
      {
        cutId: cut.cutId,
        sourceGeneration: cut.sourceGeneration,
        successorGeneration: cut.successorGeneration,
        members: cut.members.map((member) => ({
          memberId: member.memberId,
          paneId: member.paneId,
          role: member.role,
          action: member.action,
          state: member.state,
        })),
      },
    );
    const expectedRevision = this.#providerArchiveHmacV57(
      "source-cut-containment-revision",
      {
        cutId: cut.cutId,
        cutIdentityHmac: cutRow.identity_hmac,
        fenceHmac: cutRow.fence_hmac,
        sealHmac: cutRow.seal_hmac,
        successorGeneration: cutRow.successor_generation,
        successorAccountProfileRevision:
          cutRow.successor_account_profile_revision,
        memberCount: cutRow.member_count,
        inventoryDigest: cutRow.inventory_digest,
      },
    );
    if (
      cutRow.containment_evidence_digest !== expectedEvidence ||
      cutRow.containment_revision_digest !== expectedRevision ||
      cutRow.containment_hmac === null
    ) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "The contained v57 cut lacks its exact store-owned containment authority.",
      );
    }
    for (const member of cut.members) {
      this.#assertProviderArchiveSettledMemberPostimageV57(cut, member);
    }
    this.#assertProviderArchiveSealedInventoryPostimageV57(cut);
  }

  #providerArchiveFrozenTargetBindingV57(
    targetRow: z.infer<typeof providerArchiveTargetAuthorityRowSchema>,
  ): ProviderThreadArchiveBindingPreimageV57 {
    if (targetRow.binding_id === null) {
      if (
        targetRow.binding_key_digest !== null ||
        targetRow.binding_revision !== null
      ) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "A v57 target retained only part of its attachment binding.",
        );
      }
      return Object.freeze({ kind: "none" as const });
    }
    if (
      targetRow.binding_key_digest === null ||
      targetRow.binding_revision === null
    ) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "A v57 target retained only part of its attachment binding.",
      );
    }
    return Object.freeze({
      kind: "exact" as const,
      bindingId: targetRow.binding_id,
      bindingKeyDigest: targetRow.binding_key_digest,
      bindingRevision: targetRow.binding_revision,
    });
  }

  #assertProviderArchiveTargetStoreAuthorityV57(
    target: ProviderThreadArchiveTargetSnapshotV57,
  ): void {
    const targetRow = this.#providerArchiveTargetAuthorityRowV57(
      target.targetId,
    );
    for (const attemptSnapshot of target.attempts) {
      const attempt = this.#providerArchiveAttemptAuthorityRowV57(
        attemptSnapshot.attemptId,
      );
      if (
        attempt.target_id !== target.targetId ||
        attempt.ordinal !== attemptSnapshot.ordinal ||
        attempt.generation !== attemptSnapshot.generation ||
        attempt.predecessor_attempt_id !==
          attemptSnapshot.predecessorAttemptId
      ) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "A v57 target attempt disagrees with its keyed journal snapshot.",
        );
      }
      if (attempt.predecessor_attempt_id === null) {
        const expectedRequestEvidence = this.#providerArchiveHmacV57(
          "target-request-evidence",
          {
            targetId: target.targetId,
            attemptId: attempt.attempt_id,
            paneId: target.paneId,
            purpose: target.purpose,
            accountProfileId: targetRow.account_profile_id,
            threadId: targetRow.thread_id,
            restartThreadId: targetRow.restart_thread_id,
            generation: attempt.generation,
            paneCasDigest: targetRow.pane_cas_digest,
            queueCasDigest: targetRow.queue_cas_digest,
            binding: this.#providerArchiveFrozenTargetBindingV57(targetRow),
          },
        );
        const expectedRequestRevision = this.#providerArchiveHmacV57(
          "target-request-revision",
          {
            targetId: target.targetId,
            attemptId: attempt.attempt_id,
            paneRevision: targetRow.pane_revision,
            queueRevision: targetRow.queue_revision,
            accountProfileRevision: attempt.account_profile_revision,
            generation: attempt.generation,
          },
        );
        if (
          attempt.request_evidence_digest !== expectedRequestEvidence ||
          attempt.request_revision_digest !== expectedRequestRevision
        ) {
          throw new ChatPaneStoreError(
            "corrupt_state",
            "A v57 target lacks its exact store-owned request authority.",
          );
        }
      } else {
        const predecessor = this.#providerArchiveAttemptAuthorityRowV57(
          attempt.predecessor_attempt_id,
        );
        if (predecessor.cut_id === null) {
          throw new ChatPaneStoreError(
            "corrupt_state",
            "A v57 successor lost its predecessor containment cut.",
          );
        }
        const predecessorCut = this.#providerArchiveCutAuthorityRowV57(
          predecessor.cut_id,
        );
        const expectedRequestEvidence = this.#providerArchiveHmacV57(
          "successor-request-evidence",
          {
            targetId: target.targetId,
            attemptId: attempt.attempt_id,
            predecessorAttemptId: predecessor.attempt_id,
            predecessorCutId: predecessor.cut_id,
            generation: attempt.generation,
            paneId: target.paneId,
            purpose: target.purpose,
            binding: this.#providerArchiveFrozenTargetBindingV57(targetRow),
          },
        );
        const expectedRequestRevision = this.#providerArchiveHmacV57(
          "successor-request-revision",
          {
            targetIdentityHmac: targetRow.identity_hmac,
            predecessorAttemptIdentityHmac: predecessor.identity_hmac,
            predecessorCutContainmentHmac: predecessorCut.containment_hmac,
            accountProfileRevision: attempt.account_profile_revision,
          },
        );
        if (
          attempt.request_evidence_digest !== expectedRequestEvidence ||
          attempt.request_revision_digest !== expectedRequestRevision
        ) {
          throw new ChatPaneStoreError(
            "corrupt_state",
            "A v57 successor lacks its exact store-owned request authority.",
          );
        }
      }
      if (attempt.effect_hmac !== null) {
        const effectEvidenceDigest = attempt.predecessor_attempt_id === null
          ? this.#providerArchiveHmacV57(
              "effect-start-evidence",
              {
                targetId: target.targetId,
                attemptId: attempt.attempt_id,
                paneId: target.paneId,
                purpose: target.purpose,
                generation: attempt.generation,
              },
            )
          : this.#providerArchiveHmacV57(
              "successor-effect-evidence",
              {
                targetId: target.targetId,
                attemptId: attempt.attempt_id,
                generation: attempt.generation,
                predecessorAttemptId: attempt.predecessor_attempt_id,
              },
            );
        const effectRevisionDigest = attempt.predecessor_attempt_id === null
          ? this.#providerArchiveHmacV57(
              "effect-start-revision",
              {
                targetId: target.targetId,
                attemptId: attempt.attempt_id,
                expectedPaneRevision: targetRow.pane_revision,
                expectedQueueRevision: targetRow.queue_revision,
              },
            )
          : this.#providerArchiveHmacV57(
              "successor-effect-revision",
              {
                requestEvidenceDigest: attempt.request_evidence_digest,
                requestRevisionDigest: attempt.request_revision_digest,
                accountProfileRevision: attempt.account_profile_revision,
              },
            );
        if (
          attempt.effect_evidence_digest !== effectEvidenceDigest ||
          attempt.effect_revision_digest !== effectRevisionDigest
        ) {
          throw new ChatPaneStoreError(
            "corrupt_state",
            "A v57 target attempt lacks its exact store-owned effect evidence.",
          );
        }
      }
      if (attempt.state === "direct_applied") {
        const expectedRevisionDigest = this.#providerArchiveHmacV57(
          "direct-applied-revision",
          {
            targetIdentityHmac: targetRow.identity_hmac,
            targetPointerHmac: targetRow.pointer_hmac,
            attemptIdentityHmac: attempt.identity_hmac,
            attemptEffectHmac: attempt.effect_hmac,
            paneRevision: targetRow.pane_revision,
            queueRevision: targetRow.queue_revision,
            outcomeEvidenceDigest: attempt.outcome_evidence_digest,
          },
        );
        if (attempt.outcome_revision_digest !== expectedRevisionDigest) {
          throw new ChatPaneStoreError(
            "corrupt_state",
            "A direct v57 result lacks its exact store-owned outcome authority.",
          );
        }
      }
      if (
        attempt.state === "reconciled_applied" ||
        attempt.state === "reconciled_not_applied"
      ) {
        if (attempt.cut_id === null) {
          throw new ChatPaneStoreError(
            "corrupt_state",
            "A reconciled v57 attempt lost its containment cut.",
          );
        }
        const disposition = attempt.state === "reconciled_applied"
          ? "applied"
          : "not_applied";
        const expectedRevisionDigest = this.#providerArchiveHmacV57(
          `reconciliation-${disposition}-revision`,
          {
            targetIdentityHmac: targetRow.identity_hmac,
            attemptIdentityHmac: attempt.identity_hmac,
            attemptAmbiguityHmac: attempt.ambiguity_hmac,
            cutContainmentHmac:
              this.#providerArchiveCutAuthorityRowV57(attempt.cut_id)
                .containment_hmac,
            outcomeEvidenceDigest: attempt.outcome_evidence_digest,
          },
        );
        if (attempt.outcome_revision_digest !== expectedRevisionDigest) {
          throw new ChatPaneStoreError(
            "corrupt_state",
            "A reconciled v57 result lacks its exact store-owned outcome authority.",
          );
        }
      }
    }
  }

  #assertProviderArchiveTargetPreimageV57(
    target: ProviderThreadArchiveTargetSnapshotV57,
  ): Readonly<{
    authority: ProviderThreadArchivePaneAuthorityV57;
    targetRow: z.infer<typeof providerArchiveTargetAuthorityRowSchema>;
    attemptRow: z.infer<typeof providerArchiveAttemptAuthorityRowSchema>;
    cut: ProviderThreadArchiveCutSnapshotV57 | null;
  }> {
    const journal = this.#requireProviderThreadArchiveJournalV57();
    const targetRow = this.#providerArchiveTargetAuthorityRowV57(
      target.targetId,
    );
    if (
      target.status !== "open"
      || targetRow.status !== "open"
      || targetRow.pane_id !== target.paneId
      || targetRow.purpose !== target.purpose
      || targetRow.current_attempt_id !== target.currentAttempt.attemptId
      || targetRow.current_attempt_ordinal !== target.currentAttempt.ordinal
    ) {
      throw new ChatPaneStoreError(
        "revision_conflict",
        "The v57 provider archive target is not open on its exact attempt.",
      );
    }
    this.#assertProviderArchiveTargetStoreAuthorityV57(target);
    this.#assertNoConflictingLegacyArchiveV57(target.paneId);
    const pane = target.purpose === "start_fresh"
      ? this.#preflightStartFreshProviderContextV57({
          paneId: chatPaneIdSchema.parse(target.paneId),
          expectedRevision: targetRow.pane_revision,
          expectedQueueRevision: targetRow.queue_revision ?? corrupt(
            "A start-fresh v57 target lost its queue revision.",
          ),
        }, target.targetId)
      : this.#preflightPaneArchive(
          chatPaneIdSchema.parse(target.paneId),
          targetRow.pane_revision,
          target.targetId,
        );
    if (
      pane.projection.interactionMode !== "chat"
      || isActive(pane.projection)
    ) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The v57 provider archive target no longer owns an inactive ordinary pane.",
      );
    }
    this.#assertMessageQueueClosableForPane(targetRow.pane_id);
    this.#requirePaneArchiveCompatibilityV57(targetRow.pane_id);
    const authority = this.#providerThreadArchivePaneAuthorityV57(
      targetRow.pane_id,
    );
    const firstAttempt = target.attempts[0] ?? corrupt(
      "The v57 provider archive target lost its first attempt.",
    );
    if (
      authority.ownership.kind !== "ordinary"
      || authority.ownership.accountProfileId !==
        authority.binding.accountProfileId
      || authority.ownership.generation !== firstAttempt.generation
      || authority.binding.accountProfileId !== targetRow.account_profile_id
    ) {
      throw new ChatPaneStoreError(
        "revision_conflict",
        "The v57 target lost its exact provider source ownership.",
      );
    }
    journal.assertTargetPreimage(
      target.targetId,
      this.#providerThreadArchiveTargetPreimageV57({
        authority,
        purpose: target.purpose,
        accountProfileRevision: firstAttempt.accountProfileRevision,
      }),
    );
    const cut = target.currentAttempt.cutId === null
      ? null
      : journal.reopenCut(target.currentAttempt.cutId);
    this.#assertProviderArchiveCurrentAccountAuthorityV57(
      targetRow.account_profile_id,
      target.currentAttempt,
      cut,
    );
    const attemptRow = this.#providerArchiveAttemptAuthorityRowV57(
      target.currentAttempt.attemptId,
    );
    if (
      attemptRow.ordinal !== target.currentAttempt.ordinal
      || attemptRow.state !== target.currentAttempt.state
      || attemptRow.cut_id !== target.currentAttempt.cutId
    ) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "The v57 target snapshot disagrees with its current attempt authority.",
      );
    }
    return Object.freeze({ authority, targetRow, attemptRow, cut });
  }

  #providerArchiveFinalizationContainmentReceiptV57(
    target: ProviderThreadArchiveTargetSnapshotV57,
  ): string {
    const targetRow = this.#providerArchiveTargetAuthorityRowV57(
      target.targetId,
    );
    const attemptRow = this.#providerArchiveAttemptAuthorityRowV57(
      target.currentAttempt.attemptId,
    );
    const cutRow = attemptRow.cut_id === null
      ? null
      : this.#providerArchiveCutAuthorityRowV57(attemptRow.cut_id);
    if (
      !["direct_applied", "reconciled_applied"].includes(attemptRow.state)
      || attemptRow.outcome_hmac === null
      || (attemptRow.state === "reconciled_applied" &&
        (cutRow === null || cutRow.containment_hmac === null))
    ) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The v57 target lacks exact applied finalization authority.",
      );
    }
    return this.#providerArchiveHmacV57(
      "target-finalization-containment-receipt",
      {
        targetId: target.targetId,
        paneId: target.paneId,
        purpose: target.purpose,
        targetIdentityHmac: targetRow.identity_hmac,
        targetPointerHmac: targetRow.pointer_hmac,
        attemptId: attemptRow.attempt_id,
        attemptOrdinal: attemptRow.ordinal,
        attemptGeneration: attemptRow.generation,
        attemptIdentityHmac: attemptRow.identity_hmac,
        attemptOutcomeHmac: attemptRow.outcome_hmac,
        cutId: cutRow?.cut_id ?? null,
        cutIdentityHmac: cutRow?.identity_hmac ?? null,
        cutContainmentHmac: cutRow?.containment_hmac ?? null,
      },
    );
  }

  #releaseProviderArchiveTargetBindingV57(input: Readonly<{
    targetRow: z.infer<typeof providerArchiveTargetAuthorityRowSchema>;
    classification: RetainedProviderAttachmentBindingClassification;
    containmentReceipt: string;
    now: Date;
  }>): void {
    const { targetRow, classification, containmentReceipt, now } = input;
    if (classification.kind === "orphan") {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The v57 target attachment custody is orphaned.",
      );
    }
    if (classification.kind === "exact") {
      if (
        this.#paneArchiveAuthority === null
        || targetRow.binding_id !== classification.bindingId
        || targetRow.binding_key_digest !== classification.bindingKeyDigest
        || targetRow.binding_revision !== classification.revision
      ) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "The v57 target attachment custody changed before finalization.",
        );
      }
      this.#paneArchiveAuthority
        .releaseProviderBindingAfterResumeContainedInTransaction({
          bindingId: classification.bindingId,
          bindingKeyDigest: classification.bindingKeyDigest,
          paneId: targetRow.pane_id,
          expectedRevision: classification.revision,
          containmentReceipt,
          now,
        });
    } else if (
      targetRow.binding_id !== null
      || targetRow.binding_key_digest !== null
      || targetRow.binding_revision !== null
    ) {
      throw new ChatPaneStoreError(
        "revision_conflict",
        "The v57 target retained stale attachment binding authority.",
      );
    }
    if (this.#retainedProviderAttachmentBindingCount(targetRow.pane_id) !== 0) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Provider attachment custody remains after v57 finalization.",
      );
    }
  }

  #finalizeProviderThreadArchiveStartFreshV57(input: Readonly<{
    targetRow: z.infer<typeof providerArchiveTargetAuthorityRowSchema>;
    containmentReceipt: string;
    now: Date;
  }>): Readonly<{
    pane: ChatPaneProjection;
    queue: ChatMessageQueueProjection;
  }> {
    const { targetRow, containmentReceipt, now } = input;
    const pane = this.require(targetRow.pane_id);
    this.#releaseProviderArchiveTargetBindingV57({
      targetRow,
      classification: this.classifyRetainedProviderAttachmentBinding(
        targetRow.pane_id,
        pane.binding,
      ),
      containmentReceipt,
      now,
    });
    this.#advanceProviderHistoryFloor(targetRow.pane_id);
    const reset = this.#database.query(`
      UPDATE chat_panes SET
        state = 'ready', active_prompt = NULL,
        active_provider_turn_id = NULL,
        provider_account_profile_id = NULL,
        provider_thread_id = NULL, provider_restart_thread_id = NULL,
        active_turn_poisoned = 0,
        attention_code = NULL, attention_message = NULL,
        attention_retryable = NULL, history_truncated = 0,
        provider_context_reset_required = 0,
        message_queue_pause_reason = NULL,
        message_queue_revision = message_queue_revision + 1,
        revision = revision + 1, updated_at = ?4
      WHERE pane_id = ?1 AND revision = ?2
        AND message_queue_revision = ?3
        AND provider_context_reset_required = 1
        AND state = 'attention'
        AND attention_code = 'runtime_unavailable'
        AND attention_retryable = 0
        AND message_queue_pause_reason IS NOT NULL
        AND message_queue_pause_reason != 'ambiguous_effect'
        AND archived_at IS NULL
    `).run(
      targetRow.pane_id,
      targetRow.pane_revision,
      targetRow.queue_revision,
      now.toISOString(),
    );
    if (reset.changes !== 1) {
      throw new ChatPaneStoreError(
        "revision_conflict",
        "The v57 start-fresh pane changed before finalization.",
      );
    }
    return Object.freeze({
      pane: this.require(targetRow.pane_id).projection,
      queue: this.messageQueue(targetRow.pane_id),
    });
  }

  #finalizeProviderThreadArchivePaneV57(input: Readonly<{
    targetRow: z.infer<typeof providerArchiveTargetAuthorityRowSchema>;
    containmentReceipt: string;
    now: Date;
  }>): ChatPaneRemoveResult {
    const { targetRow, containmentReceipt, now } = input;
    const pane = this.require(targetRow.pane_id);
    const liveRows = this.#livePaneRows();
    const removedOrder = liveRows.find((row) =>
      row.pane_id === targetRow.pane_id
    )?.display_order;
    if (removedOrder === undefined) {
      throw new ChatPaneStoreError(
        "not_found",
        "The v57 pane archive target is no longer live.",
      );
    }
    this.#releaseProviderArchiveTargetBindingV57({
      targetRow,
      classification: this.classifyRetainedProviderAttachmentBinding(
        targetRow.pane_id,
        pane.binding,
      ),
      containmentReceipt,
      now,
    });
    const archiveAuthority = this.#paneArchiveAuthority ?? corrupt(
      "The v57 pane archive lost its attachment privacy authority.",
    );
    archiveAuthority.preparePaneArchiveInTransaction({
      paneId: targetRow.pane_id,
      now,
      containmentReceipt,
    });
    this.#closeMessageQueueForPane(targetRow.pane_id, now.toISOString());
    if (pane.projection.workspace !== null) {
      this.#preserveActiveWorkspace(targetRow.pane_id, now.toISOString());
    }
    const archived = this.#database.query(`
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
        active_prompt = NULL, archived_at = ?3,
        revision = revision + 1, updated_at = ?3
      WHERE pane_id = ?1 AND revision = ?2 AND archived_at IS NULL
    `).run(targetRow.pane_id, targetRow.pane_revision, now.toISOString());
    if (archived.changes < 1) throw staleRevision();
    const archivePostimage = z.object({
      revision: z.number().int().positive().safe(),
      archived_at: isoDateTimeSchema,
    }).strict().parse(this.#database.query(`
      SELECT revision, archived_at FROM chat_panes WHERE pane_id = ?1
    `).get(targetRow.pane_id));
    if (
      archivePostimage.revision !== targetRow.pane_revision + 1
      || archivePostimage.archived_at !== now.toISOString()
    ) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "The v57 pane archive did not advance exactly once.",
      );
    }
    archiveAuthority.markPaneArchivedInTransaction({
      paneId: targetRow.pane_id,
      now,
      containmentReceipt,
    });
    this.#database.query(`
      UPDATE chat_panes SET display_order = display_order + ?1
      WHERE archived_at IS NULL AND display_order > ?2
    `).run(CHAT_MAX_PANES, removedOrder);
    this.#database.query(`
      UPDATE chat_panes SET display_order = display_order - ?1
      WHERE archived_at IS NULL AND display_order >= ?2
    `).run(CHAT_MAX_PANES + 1, removedOrder + CHAT_MAX_PANES + 1);
    this.#livePaneRows();
    return Object.freeze({
      paneId: targetRow.pane_id,
      revision: targetRow.pane_revision + 1,
    });
  }

  #providerArchiveFinalizationPostimageV57(
    target: ProviderThreadArchiveTargetSnapshotV57,
    targetRow: z.infer<typeof providerArchiveTargetAuthorityRowSchema>,
  ): Readonly<Record<string, unknown>> {
    const row = this.#providerArchiveStoredPaneRowV57(targetRow.pane_id);
    this.#assertProviderArchiveLocalEffectsContainedV57(row.pane_id);
    const messageValues: unknown[] = this.#database.query(`
      SELECT * FROM chat_message_ledger
      WHERE pane_id = ?1 ORDER BY ordinal, message_id
    `).all(row.pane_id);
    const ledgerDigest = this.#providerArchiveHmacV57(
      "target-finalization-ledger-postimage",
      {
        paneId: row.pane_id,
        messageQueueRevision: row.message_queue_revision,
        nextMessageOrdinal: row.next_message_ordinal,
        pauseReason: row.message_queue_pause_reason,
        messages: messageValues.map((value) => this.#parseMessageRow(value)),
      },
    );
    const shared = {
      paneId: row.pane_id,
      paneRevision: row.revision,
      queueRevision: row.message_queue_revision,
      ledgerDigest,
      activePrompt: row.active_prompt,
      activeProviderTurnId: row.active_provider_turn_id,
      activeTurnPoisoned: row.active_turn_poisoned,
      providerAccountProfileId: row.provider_account_profile_id,
      providerThreadId: row.provider_thread_id,
      providerRestartThreadId: row.provider_restart_thread_id,
      providerContextResetRequired: row.provider_context_reset_required,
      attentionCode: row.attention_code,
      attentionMessage: row.attention_message,
      attentionRetryable: row.attention_retryable,
      messageQueuePauseReason: row.message_queue_pause_reason,
      historyTruncated: row.history_truncated,
      providerHistoryFloorSequence: row.provider_history_floor_sequence,
      workspaceState: row.workspace_state,
      workspaceRevision: row.workspace_revision,
      workspaceRecoveryReason: row.workspace_recovery_reason,
      retainedProviderAttachmentBindings:
        this.#retainedProviderAttachmentBindingCount(row.pane_id),
    };
    if (target.purpose === "pane_archive") {
      if (
        row.archived_at === null ||
        row.revision !== targetRow.pane_revision + 1 ||
        row.active_prompt !== null ||
        shared.retainedProviderAttachmentBindings !== 0
      ) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "The committed v57 pane archive lacks its exact local postimage.",
        );
      }
      return Object.freeze({
        kind: "pane_archive",
        ...shared,
        archivedAt: row.archived_at,
      });
    }
    if (
      row.archived_at !== null ||
      row.revision !== targetRow.pane_revision + 1 ||
      row.message_queue_revision !== (targetRow.queue_revision ?? 0) + 1 ||
      row.state !== "ready" || row.active_prompt !== null ||
      row.active_provider_turn_id !== null || row.active_turn_poisoned !== 0 ||
      row.provider_account_profile_id !== null ||
      row.provider_thread_id !== null ||
      row.provider_restart_thread_id !== null ||
      row.provider_context_reset_required !== 0 ||
      row.attention_code !== null || row.attention_message !== null ||
      row.attention_retryable !== null ||
      row.message_queue_pause_reason !== null || row.history_truncated !== 0 ||
      shared.retainedProviderAttachmentBindings !== 0
    ) {
      throw new ChatPaneStoreError(
        "revision_conflict",
        "The committed v57 start-fresh target lacks its exact local postimage.",
      );
    }
    return Object.freeze({
      kind: "start_fresh",
      ...shared,
      archivedAt: null,
      state: row.state,
    });
  }

  #replayCommittedProviderThreadArchiveFinalizationV57(input: Readonly<{
    target: ProviderThreadArchiveTargetSnapshotV57;
    targetRow: z.infer<typeof providerArchiveTargetAuthorityRowSchema>;
    containmentReceipt: string;
  }>): ChatProviderThreadArchiveFinalizationV57Result {
    const { target, targetRow, containmentReceipt } = input;
    if (
      target.status !== "committed"
      || targetRow.status !== "committed"
      || targetRow.commit_hmac === null
      || targetRow.committed_at === null
    ) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The v57 target is not durably committed.",
      );
    }
    const row = this.#providerArchiveStoredPaneRowV57(targetRow.pane_id);
    if (this.#retainedProviderAttachmentBindingCount(row.pane_id) !== 0) {
      throw new ChatPaneStoreError(
        "revision_conflict",
        "A committed v57 target retained provider attachment custody.",
      );
    }
    const postimage = this.#providerArchiveFinalizationPostimageV57(
      target,
      targetRow,
    );
    const attemptRow = this.#providerArchiveAttemptAuthorityRowV57(
      target.currentAttempt.attemptId,
    );
    const cutRow = attemptRow.cut_id === null
      ? null
      : this.#providerArchiveCutAuthorityRowV57(attemptRow.cut_id);
    const expectedCommitEvidence = this.#providerArchiveHmacV57(
      "target-finalization-evidence",
      {
        targetId: target.targetId,
        attemptId: target.currentAttempt.attemptId,
        attemptState: target.currentAttempt.state,
        containmentReceipt,
        postimage,
      },
    );
    const expectedCommitRevision = this.#providerArchiveHmacV57(
      "target-finalization-revision",
      {
        targetIdentityHmac: targetRow.identity_hmac,
        targetPointerHmac: targetRow.pointer_hmac,
        attemptOutcomeHmac: attemptRow.outcome_hmac,
        cutContainmentHmac: cutRow?.containment_hmac ?? null,
        postimage,
      },
    );
    if (
      targetRow.commit_evidence_digest !== expectedCommitEvidence ||
      targetRow.commit_revision_digest !== expectedCommitRevision
    ) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "The committed v57 target lacks its exact store-owned finalization evidence.",
      );
    }
    if (target.purpose === "pane_archive") {
      if (
        row.archived_at === null
        || row.revision !== targetRow.pane_revision + 1
      ) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "The committed v57 pane archive lacks its exact local postimage.",
        );
      }
      return Object.freeze({
        kind: "pane_archive",
        removed: Object.freeze({
          paneId: targetRow.pane_id,
          revision: row.revision,
        }),
        containmentReceipt,
      });
    }
    if (
      row.archived_at !== null
      || row.revision !== targetRow.pane_revision + 1
      || row.message_queue_revision !== (targetRow.queue_revision ?? 0) + 1
      || row.state !== "ready"
      || row.provider_account_profile_id !== null
      || row.provider_thread_id !== null
      || row.provider_restart_thread_id !== null
      || row.provider_context_reset_required !== 0
      || row.attention_code !== null
      || row.message_queue_pause_reason !== null
    ) {
      throw new ChatPaneStoreError(
        "revision_conflict",
        "The committed v57 start-fresh target lacks its exact local postimage.",
      );
    }
    return Object.freeze({
      kind: "start_fresh",
      pane: this.require(row.pane_id).projection,
      queue: this.messageQueue(row.pane_id),
      containmentReceipt,
    });
  }

  #requirePaneArchiveCompatibilityV57(paneId: ChatPaneId): void {
    if (this.#paneArchiveAuthority === null) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Attachment privacy authority is unavailable for v57 archive preparation.",
      );
    }
    this.#paneArchiveAuthority.assertProviderThreadArchiveV57Compatible(paneId);
  }

  #assertNoConflictingLegacyArchiveV57(paneIdValue: string): void {
    const paneId = chatPaneIdSchema.parse(paneIdValue);
    const legacy = this.providerThreadArchiveIntent(paneId);
    if (legacy === null) return;
    throw new ChatPaneStoreError(
      "invalid_state",
      "A legacy provider-context transition must reconcile before v57 recovery can continue.",
    );
  }

  #providerArchiveStoredPaneRowV57(paneIdValue: string): PaneRow {
    const paneId = chatPaneIdSchema.parse(paneIdValue);
    const value: unknown = this.#database.query(`
      ${paneWithActiveRoutingSelect()}
      WHERE pane.pane_id = ?1
    `).get(paneId);
    if (value === null) {
      throw new ChatPaneStoreError(
        "not_found",
        "A v57 provider-thread archive pane no longer exists.",
      );
    }
    return this.#parseRow(value);
  }

  #providerArchiveLivePaneRowV57(paneIdValue: string): PaneRow {
    const row = this.#providerArchiveStoredPaneRowV57(paneIdValue);
    if (row.archived_at !== null) {
      throw new ChatPaneStoreError(
        "not_found",
        "A v57 provider-thread archive pane is no longer live.",
      );
    }
    return row;
  }

  #providerArchiveExactBindingV57(row: PaneRow): ChatThreadBinding {
    const values = [
      row.provider_account_profile_id,
      row.provider_thread_id,
      row.provider_restart_thread_id,
    ];
    if (values.every((value) => value === null)) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The pane has no exact provider thread to archive.",
      );
    }
    if (values.some((value) => value === null)) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "The pane retained only part of its provider-thread identity.",
      );
    }
    return {
      accountProfileId: row.provider_account_profile_id!,
      threadId: row.provider_thread_id!,
      restartThreadId: row.provider_restart_thread_id!,
    };
  }

  #providerArchiveBindingPreimageV57(
    classification: Exclude<
      RetainedProviderAttachmentBindingClassification,
      Readonly<{ readonly kind: "orphan" }>
    >,
  ): ProviderThreadArchiveBindingPreimageV57 {
    return classification.kind === "none"
      ? Object.freeze({ kind: "none" as const })
      : Object.freeze({
          kind: "exact" as const,
          bindingId: classification.bindingId,
          bindingKeyDigest: classification.bindingKeyDigest,
          bindingRevision: classification.revision,
        });
  }

  #providerArchiveQueueCasDigestV57(row: PaneRow): string {
    const values: unknown[] = this.#database.query(`
      SELECT * FROM chat_message_ledger
      WHERE pane_id = ?1 ORDER BY ordinal, message_id
    `).all(row.pane_id);
    const messages = values.map((value) => this.#parseMessageRow(value));
    const rows = messages.map((message) => ({
      message,
      attachmentRefs: this.#messageAttachmentAuthority
        .messageRefsInTransaction({
          paneId: row.pane_id,
          messageId: message.message_id,
        }),
    }));
    return this.#providerArchiveHmacV57("queue-cas", {
      paneId: row.pane_id,
      messageQueueRevision: row.message_queue_revision,
      nextMessageOrdinal: row.next_message_ordinal,
      pauseReason: row.message_queue_pause_reason,
      rows,
    });
  }

  #providerArchiveOrdinaryOwnershipV57(
    row: PaneRow,
    binding: ChatThreadBinding,
  ): ProviderThreadArchiveOwnershipV57 {
    if (row.interaction_mode !== "chat" || row.active_turn_id === null) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The ordinary pane lacks an exact current root-turn owner.",
      );
    }
    const visited = parseJson(
      row.visited_account_ids_json,
      visitedAccountsSchema,
    );
    const accountProfileId = visited.at(-1) ?? (
      row.active_provider_turn_id === null
        ? null
        : row.provider_account_profile_id
    );
    if (accountProfileId === null || accountProfileId !== binding.accountProfileId) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The ordinary pane cannot prove which account owns its provider effect.",
      );
    }
    const route = this.#rootTurnRouting.readTurnRouting(
      row.pane_id,
      row.active_turn_id,
    );
    if (route === null) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The ordinary pane lost its exact provider-generation route.",
      );
    }
    const generation = route.acceptedGeneration ?? (
      route.effectStartedAt === null ? null : route.catalogGeneration
    );
    if (generation === null) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The ordinary pane has neither accepted nor effect-started generation authority.",
      );
    }
    return Object.freeze({
      kind: "ordinary" as const,
      accountProfileId,
      generation,
      authority: route,
    });
  }

  #providerArchiveHarnessOwnershipV57(
    row: PaneRow,
    binding: ChatThreadBinding,
  ): ProviderThreadArchiveOwnershipV57 {
    const values: unknown[] = this.#database.query(`
      SELECT actor.actor_id, actor.state AS actor_state,
        actor_pane.binding_id AS actor_pane_binding_id,
        actor_pane.revision AS actor_pane_binding_revision,
        incarnation.incarnation_id,
        incarnation.account_profile_id AS incarnation_account_profile_id,
        incarnation.process_generation AS incarnation_admission_generation,
        incarnation.provider_thread_id AS incarnation_provider_thread_id,
        incarnation.state AS incarnation_state,
        session.account_profile_id AS session_account_profile_id,
        session.actor_id AS session_actor_id,
        session.admission_generation AS session_admission_generation,
        session.live_generation AS session_live_generation,
        session.provider_thread_id AS session_provider_thread_id,
        session.revision AS session_revision,
        workspace.binding_id AS workspace_binding_id,
        workspace.revision AS workspace_binding_revision
      FROM harness_actor_pane_bindings AS actor_pane
      JOIN harness_actors AS actor
        ON actor.actor_id = actor_pane.actor_id AND actor.state = 'active'
      JOIN harness_actor_incarnations AS incarnation
        ON incarnation.actor_id = actor.actor_id
        AND incarnation.state IN ('idle', 'running')
        AND incarnation.provider_thread_id IS NOT NULL
      JOIN harness_actor_session_bindings AS session
        ON session.incarnation_id = incarnation.incarnation_id
        AND session.state = 'bound'
      JOIN harness_actor_workspace_bindings AS workspace
        ON workspace.binding_id = session.workspace_binding_id
        AND workspace.actor_id = actor.actor_id
        AND workspace.state = 'active'
      WHERE actor_pane.pane_id = ?1 AND actor_pane.state = 'attached'
      ORDER BY incarnation.incarnation_id
      LIMIT 2
    `).all(row.pane_id);
    if (values.length !== 1) {
      throw new ChatPaneStoreError(
        values.length === 0 ? "invalid_state" : "corrupt_state",
        "The harness pane lacks one exact live actor-session owner.",
      );
    }
    const authority = providerArchiveHarnessOwnershipRowSchema.parse(
      values[0],
    );
    if (
      row.interaction_mode !== "harnessObserver" ||
      authority.session_actor_id !== authority.actor_id ||
      authority.session_account_profile_id !==
        authority.incarnation_account_profile_id ||
      authority.session_admission_generation !==
        authority.incarnation_admission_generation ||
      authority.session_provider_thread_id !==
        authority.incarnation_provider_thread_id ||
      binding.accountProfileId !== authority.session_account_profile_id ||
      binding.restartThreadId !== authority.session_provider_thread_id ||
      row.account_profile_id !== authority.session_account_profile_id
    ) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "The harness pane's actor-session ownership is incoherent.",
      );
    }
    return Object.freeze({
      kind: "harness" as const,
      accountProfileId: authority.session_account_profile_id,
      generation: authority.session_live_generation,
      authority,
    });
  }

  #providerThreadArchivePaneAuthorityV57(
    paneIdValue: string,
  ): ProviderThreadArchivePaneAuthorityV57 {
    const row = this.#providerArchiveLivePaneRowV57(paneIdValue);
    const binding = this.#providerArchiveExactBindingV57(row);
    const classification = this.classifyRetainedProviderAttachmentBinding(
      row.pane_id,
      binding,
    );
    if (classification.kind === "orphan") {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Attachment custody no longer matches the pane's provider lineage.",
      );
    }
    const retainedBinding = classification;
    const bindingPreimage = this.#providerArchiveBindingPreimageV57(
      retainedBinding,
    );
    const ownership = row.interaction_mode === "chat"
      ? this.#providerArchiveOrdinaryOwnershipV57(row, binding)
      : this.#providerArchiveHarnessOwnershipV57(row, binding);
    const queueCasDigest = this.#providerArchiveQueueCasDigestV57(row);
    const paneCasPreimage = Object.fromEntries(
      Object.entries(row).filter(([key]) => key !== "display_order"),
    );
    const paneCasDigest = this.#providerArchiveHmacV57("pane-cas", {
      pane: paneCasPreimage,
      queueCasDigest,
      retainedBinding,
      ownership,
    });
    return Object.freeze({
      row,
      binding,
      retainedBinding,
      bindingPreimage,
      ownership,
      queueCasDigest,
      paneCasDigest,
    });
  }

  #requireProviderArchiveAccountProfileV57(
    accountProfileIdValue: string,
  ): z.infer<typeof providerArchiveAccountProfileRowSchema> {
    const accountProfileId = accountProfileIdSchema.parse(
      accountProfileIdValue,
    );
    const value: unknown = this.#database.query(`
      SELECT profile_id, revision, process_generation, removed_at
      FROM account_profiles WHERE profile_id = ?1
    `).get(accountProfileId);
    if (value === null) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The provider account profile no longer exists.",
      );
    }
    const profile = providerArchiveAccountProfileRowSchema.parse(value);
    if (profile.removed_at !== null || profile.process_generation < 1) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The provider account profile is not active for archive recovery.",
      );
    }
    return profile;
  }

  #providerThreadArchiveTargetPreimageV57(input: Readonly<{
    authority: ProviderThreadArchivePaneAuthorityV57;
    purpose: "start_fresh" | "pane_archive";
    accountProfileRevision: number;
  }>) {
    return Object.freeze({
      paneId: input.authority.row.pane_id,
      purpose: input.purpose,
      paneRevision: input.authority.row.revision,
      queueRevision: input.purpose === "start_fresh"
        ? input.authority.row.message_queue_revision
        : null,
      paneCasDigest: input.authority.paneCasDigest,
      queueCasDigest: input.purpose === "start_fresh"
        ? input.authority.queueCasDigest
        : null,
      accountProfileId: input.authority.binding.accountProfileId,
      accountProfileRevision: input.accountProfileRevision,
      threadId: input.authority.binding.threadId,
      restartThreadId: input.authority.binding.restartThreadId,
      binding: input.authority.bindingPreimage,
    });
  }

  #assertProviderArchiveCurrentAccountAuthorityV57(
    accountProfileId: string,
    attempt: ProviderThreadArchiveTargetSnapshotV57["currentAttempt"],
    cut: ProviderThreadArchiveCutSnapshotV57 | null,
  ): void {
    if (cut?.cause === "account_removal") {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Account-removal recovery is not owned by the ChatPane v57 preflight seam.",
      );
    }
    const expectedGeneration = cut?.successorGeneration ?? attempt.generation;
    const expectedRevision = cut?.successorAccountProfileRevision ??
      attempt.accountProfileRevision;
    const profile = this.#requireProviderArchiveAccountProfileV57(
      accountProfileId,
    );
    if (
      profile.process_generation !== expectedGeneration ||
      profile.revision !== expectedRevision
    ) {
      throw new ChatPaneStoreError(
        "revision_conflict",
        "The provider account authority no longer matches v57 recovery.",
      );
    }
  }

  #assertNoProviderArchiveHarnessSourceSessionsV57(
    accountProfileIdValue: string,
    sourceGeneration: number | null,
  ): void {
    const accountProfileId = accountProfileIdSchema.parse(
      accountProfileIdValue,
    );
    if (sourceGeneration !== null) validateRevision(sourceGeneration);
    const count = countRowSchema.parse(this.#database.query(`
      SELECT COUNT(*) AS count
      FROM harness_actor_session_bindings AS session
      JOIN harness_actor_incarnations AS incarnation
        ON incarnation.incarnation_id = session.incarnation_id
      WHERE session.account_profile_id = ?1
        AND session.state = 'bound'
        AND (?2 IS NULL OR session.live_generation = ?2)
    `).get(accountProfileId, sourceGeneration)).count;
    if (count === 0) return;
    throw new ChatPaneStoreError(
      "invalid_state",
      sourceGeneration === null
        ? "A bound Harness session prevents exact account archive containment."
        : "A bound Harness session prevents exact source-generation archive containment.",
    );
  }

  #assertProviderArchiveSourceCohortPreflightV57(
    accountProfileIdValue: string,
    sourceGeneration: number,
  ): void {
    const accountProfileId = accountProfileIdSchema.parse(
      accountProfileIdValue,
    );
    validateRevision(sourceGeneration);
    this.#assertNoProviderArchiveHarnessSourceSessionsV57(
      accountProfileId,
      sourceGeneration,
    );
    for (const row of this.#livePaneRows()) {
      const providerColumns = [
        row.provider_account_profile_id,
        row.provider_thread_id,
        row.provider_restart_thread_id,
      ];
      if (providerColumns.every((value) => value === null)) continue;
      if (providerColumns.some((value) => value === null)) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "A live pane retained only part of its provider-thread identity.",
        );
      }
      if (row.provider_account_profile_id !== accountProfileId) continue;
      const authority = this.#providerThreadArchivePaneAuthorityV57(
        row.pane_id,
      );
      if (
        authority.binding.accountProfileId !== accountProfileId ||
        authority.ownership.accountProfileId !== accountProfileId
      ) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "A source-generation pane disagrees about its provider account.",
        );
      }
      if (authority.ownership.generation !== sourceGeneration) continue;
      if (authority.ownership.kind !== "ordinary") {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Harness source ownership is not yet safe for v57 archive containment.",
        );
      }
      // A completed ordinary turn retains the thread it may explicitly resume
      // on a later process generation. Its settled route is historical
      // provenance, not live authority owned by the generation being fenced.
      // Exact archive targets are checked independently before this cohort
      // scan, so excluding settled non-target history cannot drop the target.
      if (
        authority.ownership.authority.settledAt !== null &&
        !this.#providerArchivePaneHasUnsettledLocalEffectsV57(row.pane_id)
      ) continue;
      if (["starting", "streaming", "continuing"].includes(row.state)) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "An active source-generation pane prevents exact archive containment.",
        );
      }
      this.#assertNoConflictingLegacyArchiveV57(row.pane_id);
      this.#assertMessageQueueClosableForPane(row.pane_id);
      this.#requirePaneArchiveCompatibilityV57(row.pane_id);
    }
  }

  #providerArchiveMemberAuthorityRowV57(
    memberId: string,
  ): z.infer<typeof providerArchiveMemberAuthorityRowSchema> {
    const value: unknown = this.#database.query(`
      SELECT member_id, cut_id, pane_id, pane_revision, pane_cas_digest,
        thread_id, restart_thread_id, role, target_id, attempt_id,
        target_attempt_ordinal, action, binding_id, binding_key_digest,
        binding_revision, identity_evidence_digest, identity_revision_digest,
        state, settlement_evidence_digest,
        settlement_revision_digest, settled_at
      FROM chat_provider_thread_archive_cut_members_v57
      WHERE member_id = ?1
    `).get(providerArchiveMemberIdSchema.parse(memberId));
    if (value === null) {
      throw new ChatPaneStoreError(
        "not_found",
        "The v57 provider archive member no longer exists.",
      );
    }
    try {
      return providerArchiveMemberAuthorityRowSchema.parse(value);
    } catch {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "Stored v57 provider archive member authority is invalid.",
      );
    }
  }

  #containProviderThreadArchiveMemberLocallyV57(input: Readonly<{
    stored: z.infer<typeof providerArchiveMemberAuthorityRowSchema>;
    cut: ProviderThreadArchiveCutSnapshotV57;
    authority: ProviderThreadArchivePaneAuthorityV57;
    now: Date;
  }>): ChatPaneProjection {
    const { stored, cut, authority, now } = input;
    if (
      authority.row.interaction_mode !== "chat" ||
      ["starting", "streaming", "continuing"].includes(authority.row.state)
    ) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Only an inactive ordinary pane can complete v57 member containment.",
      );
    }
    this.#assertMessageQueueClosableForPane(stored.pane_id);
    this.#settleProviderArchiveRootRoutesV57(stored.pane_id, now);
    const nowIso = isoDateTimeSchema.parse(now.toISOString());
    const preparedCount = this.#settleProviderArchivePreparedMessagesV57(
      stored.pane_id,
      nowIso,
    );
    this.#releaseProviderArchiveMemberBindingV57(stored, authority, now);
    const queueRevisionChanged = preparedCount > 0 ||
      authority.row.message_queue_pause_reason !== "attention";
    const updated = this.#database.query(`
      UPDATE chat_panes SET
        account_profile_id = CASE WHEN ?9 = 1 THEN NULL ELSE ?5 END,
        state = 'attention',
        active_prompt = NULL,
        active_provider_turn_id = NULL,
        provider_account_profile_id = NULL,
        provider_thread_id = NULL,
        provider_restart_thread_id = NULL,
        attention_code = 'runtime_unavailable',
        attention_message = ?6,
        attention_retryable = 0,
        provider_context_reset_required = 1,
        message_queue_pause_reason = 'attention',
        message_queue_revision = message_queue_revision + ?7,
        revision = revision + 1,
        updated_at = ?8
      WHERE pane_id = ?1 AND revision = ?2
        AND provider_account_profile_id = ?5
        AND provider_thread_id = ?3
        AND provider_restart_thread_id = ?4
        AND state NOT IN ('starting', 'streaming', 'continuing')
        AND archived_at IS NULL
    `).run(
      stored.pane_id,
      stored.pane_revision,
      stored.thread_id,
      stored.restart_thread_id,
      cut.accountProfileId,
      freshProviderContextAttentionMessage,
      queueRevisionChanged ? 1 : 0,
      nowIso,
      cut.cause === "account_removal" ? 1 : 0,
    );
    if (updated.changes !== 1) {
      throw new ChatPaneStoreError(
        "revision_conflict",
        "The v57 member pane changed before local containment committed.",
      );
    }
    this.#assertProviderArchiveLocalEffectsContainedV57(stored.pane_id);
    this.#assertProviderArchiveFrozenIdentityReleasedV57(
      stored.pane_id,
      {
        thread_id: stored.thread_id,
        restart_thread_id: stored.restart_thread_id,
      },
      false,
    );
    return this.require(stored.pane_id).projection;
  }

  #settleProviderArchiveRootRoutesV57(
    paneId: ChatPaneId,
    now: Date,
  ): void {
    const values: unknown[] = this.#database.query(`
      SELECT chat_turn_id
      FROM harness_root_turn_routing_receipts
      WHERE pane_id = ?1 AND settled_at IS NULL
      ORDER BY created_at, chat_turn_id
    `).all(paneId);
    if (values.length > CHAT_MAX_TURN_RECEIPTS_PER_PANE) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "A v57 member retained too many unsettled root routes.",
      );
    }
    for (const value of values) {
      const { chat_turn_id: chatTurnId } =
        providerArchiveRoutingTurnRowSchema.parse(value);
      const route = this.#rootTurnRouting.readTurnRouting(paneId, chatTurnId);
      if (route === null || route.settledAt !== null) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "A v57 member root route changed during containment.",
        );
      }
      const outcome = route.state === "classified" || route.state === "resolved"
        ? "notApplied"
        : route.state === "effectStarted"
          ? "ambiguous"
          : route.state === "accepted"
            ? "interrupted"
            : null;
      if (outcome === null) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "A v57 member retained an invalid unsettled root route.",
        );
      }
      this.#rootTurnRouting.settleInTransaction({
        paneId,
        chatTurnId,
        outcome,
        now,
      });
    }
  }

  #settleProviderArchivePreparedMessagesV57(
    paneId: ChatPaneId,
    now: string,
  ): number {
    const values: unknown[] = this.#database.query(`
      SELECT * FROM chat_message_ledger
      WHERE pane_id = ?1 AND state IN ('start_claimed', 'steer_prepared')
      ORDER BY ordinal, message_id
    `).all(paneId);
    const rows = values.map((value) => this.#parseMessageRow(value));
    for (const row of rows) {
      if (row.claimed_turn_id === null) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "A v57 member pre-effect message lost its claimed turn.",
        );
      }
      if (
        row.state === "steer_prepared" &&
        row.request_delivery_kind === "steer_head"
      ) {
        const cancelled = this.#database.query(`
          UPDATE chat_message_ledger SET
            state = 'cancelled',
            request_delivery_outcome = 'not_applied',
            revision = revision + 1,
            terminal_at = ?3,
            updated_at = ?3
          WHERE message_id = ?1 AND revision = ?2
            AND state = 'steer_prepared'
            AND request_delivery_kind = 'steer_head'
            AND request_delivery_outcome = 'pending'
        `).run(row.message_id, row.revision, now);
        if (cancelled.changes !== 1) throw staleMessageRevision();
        this.#releasePreparedMessageAttachmentLeases(
          paneId,
          row.message_id,
          row.claimed_turn_id,
          now,
        );
        try {
          this.#messageAttachmentAuthority
            .restorePreparedDraftRefsInTransaction({
              paneId,
              messageId: row.message_id,
              now,
            });
        } catch {
          throw new ChatPaneStoreError(
            "corrupt_state",
            "A v57 member could not release its prepared steer attachments.",
          );
        }
        continue;
      }
      const returned = this.#database.query(`
        UPDATE chat_message_ledger SET
          state = 'queued', claimed_turn_id = NULL,
          revision = revision + 1, updated_at = ?3
        WHERE message_id = ?1 AND revision = ?2
          AND state IN ('start_claimed', 'steer_prepared')
      `).run(row.message_id, row.revision, now);
      if (returned.changes !== 1) throw staleMessageRevision();
      this.#releasePreparedMessageAttachmentLeases(
        paneId,
        row.message_id,
        row.claimed_turn_id,
        now,
      );
    }
    return rows.length;
  }

  #releaseProviderArchiveMemberBindingV57(
    stored: z.infer<typeof providerArchiveMemberAuthorityRowSchema>,
    authority: ProviderThreadArchivePaneAuthorityV57,
    now: Date,
  ): void {
    if (authority.retainedBinding.kind === "exact") {
      if (
        this.#paneArchiveAuthority === null ||
        stored.binding_id !== authority.retainedBinding.bindingId ||
        stored.binding_key_digest !==
          authority.retainedBinding.bindingKeyDigest ||
        stored.binding_revision !== authority.retainedBinding.revision
      ) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "The v57 member attachment binding changed before containment.",
        );
      }
      const containmentReceipt = this.#providerArchiveHmacV57(
        "member-attachment-containment",
        {
          memberId: stored.member_id,
          cutId: stored.cut_id,
          paneId: stored.pane_id,
          bindingId: stored.binding_id,
          bindingKeyDigest: stored.binding_key_digest,
          bindingRevision: stored.binding_revision,
        },
      );
      this.#paneArchiveAuthority
        .releaseProviderBindingAfterResumeContainedInTransaction({
          bindingId: authority.retainedBinding.bindingId,
          bindingKeyDigest: authority.retainedBinding.bindingKeyDigest,
          paneId: stored.pane_id,
          expectedRevision: authority.retainedBinding.revision,
          containmentReceipt,
          now,
        });
    } else if (
      stored.binding_id !== null || stored.binding_key_digest !== null ||
      stored.binding_revision !== null
    ) {
      throw new ChatPaneStoreError(
        "revision_conflict",
        "The v57 member retained stale attachment binding authority.",
      );
    }
    if (this.#retainedProviderAttachmentBindingCount(stored.pane_id) !== 0) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Provider attachment custody remains after v57 member containment.",
      );
    }
  }

  #assertProviderArchiveAccountContainedTargetPostimageV57(
    target: ProviderThreadArchiveTargetSnapshotV57,
  ): void {
    const row = this.#providerArchiveStoredPaneRowV57(target.paneId);
    if (
      row.archived_at !== null ||
      row.interaction_mode !== "chat" ||
      ["starting", "streaming", "continuing"].includes(row.state) ||
      row.provider_account_profile_id !== null ||
      row.provider_thread_id !== null ||
      row.provider_restart_thread_id !== null ||
      row.provider_context_reset_required !== 1 ||
      this.#retainedProviderAttachmentBindingCount(row.pane_id) !== 0
    ) {
      throw new ChatPaneStoreError(
        "revision_conflict",
        "An account-contained v57 target lacks its exact detached pane postimage.",
      );
    }
    this.#assertProviderArchiveLocalEffectsContainedV57(row.pane_id);
    const identity = providerArchiveFrozenIdentityRowSchema.parse(
      this.#database.query(`
        SELECT thread_id, restart_thread_id
        FROM chat_provider_thread_archive_targets_v57
        WHERE target_id = ?1
      `).get(target.targetId),
    );
    this.#assertProviderArchiveFrozenIdentityReleasedV57(
      row.pane_id,
      identity,
      false,
    );
  }

  #assertProviderArchiveFrozenIdentityReleasedV57(
    paneId: ChatPaneId,
    identity: z.infer<typeof providerArchiveFrozenIdentityRowSchema>,
    requireHarnessPaneDetachment: boolean,
  ): void {
    const paneReuse = countRowSchema.parse(this.#database.query(`
      SELECT COUNT(*) AS count FROM chat_panes
      WHERE pane_id != ?1 AND (
        provider_thread_id = ?2 OR provider_restart_thread_id = ?3
      )
    `).get(
      paneId,
      identity.thread_id,
      identity.restart_thread_id,
    )).count;
    const harnessReuse = countRowSchema.parse(this.#database.query(`
      SELECT COUNT(*) AS count
      FROM harness_actor_incarnations AS incarnation
      LEFT JOIN harness_actor_session_bindings AS session
        ON session.incarnation_id = incarnation.incarnation_id
        AND session.state = 'bound'
      WHERE incarnation.provider_thread_id = ?1 AND (
        incarnation.state IN ('idle', 'running') OR session.incarnation_id IS NOT NULL
      )
    `).get(identity.restart_thread_id)).count;
    const attachedHarnessPane = requireHarnessPaneDetachment
      ? countRowSchema.parse(this.#database.query(`
          SELECT COUNT(*) AS count FROM harness_actor_pane_bindings
          WHERE pane_id = ?1 AND state = 'attached'
        `).get(paneId)).count
      : 0;
    if (paneReuse === 0 && harnessReuse === 0 && attachedHarnessPane === 0) {
      return;
    }
    throw new ChatPaneStoreError(
      "revision_conflict",
      "A settled v57 member retained or reassigned its frozen provider identity.",
    );
  }

  #assertProviderArchiveSettledMemberPostimageV57(
    cut: ProviderThreadArchiveCutSnapshotV57,
    member: ProviderThreadArchiveCutMemberSnapshotV57,
  ): void {
    const journal = this.#requireProviderThreadArchiveJournalV57();
    const stored = this.#providerArchiveMemberAuthorityRowV57(member.memberId);
    if (
      stored.cut_id !== cut.cutId || stored.pane_id !== member.paneId ||
      stored.state !== "settled"
    ) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "A settled v57 member disagrees with its frozen authority.",
      );
    }
    if (member.action === "preserved_target") {
      const targetId = stored.target_id;
      if (targetId === null) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "A settled preserved member lost its exact target identity.",
        );
      }
      const targetExists = countRowSchema.parse(this.#database.query(`
        SELECT COUNT(*) AS count
        FROM chat_provider_thread_archive_targets_v57 WHERE target_id = ?1
      `).get(targetId)).count;
      if (targetExists === 0) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "A settled preserved target lost its terminal purpose authority.",
        );
      }
      const target = journal.reopenTarget(targetId);
      if (
        target.paneId !== member.paneId ||
        !target.attempts.some((attempt) => attempt.cutId === cut.cutId)
      ) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "A settled preserved member disagrees with its target lineage.",
        );
      }
      if (cut.cause !== "account_removal") {
        const expectedEvidenceDigest = this.#providerArchiveHmacV57(
          "member-settlement-evidence",
          {
            memberId: stored.member_id,
            cutId: stored.cut_id,
            paneId: stored.pane_id,
            role: stored.role,
            action: stored.action,
            cause: cut.cause,
            sourceGeneration: cut.sourceGeneration,
            detached: false,
          },
        );
        const expectedRevisionDigest = this.#providerArchiveHmacV57(
          "member-settlement-revision",
          {
            memberId: stored.member_id,
            frozenPaneRevision: stored.pane_revision,
            paneCasDigest: stored.pane_cas_digest,
            providerContextResetRequired: false,
          },
        );
        if (
          stored.settlement_evidence_digest !== expectedEvidenceDigest ||
          stored.settlement_revision_digest !== expectedRevisionDigest
        ) {
          throw new ChatPaneStoreError(
            "corrupt_state",
            "A preserved v57 target lost its exact store-owned settlement evidence.",
          );
        }
      }
      if (target.status === "committed") {
        const targetRow = this.#providerArchiveTargetAuthorityRowV57(
          target.targetId,
        );
        this.#replayCommittedProviderThreadArchiveFinalizationV57({
          target,
          targetRow,
          containmentReceipt:
            this.#providerArchiveFinalizationContainmentReceiptV57(target),
        });
        return;
      }
      if (target.status === "account_contained") {
        this.#assertProviderArchiveAccountContainedTargetPostimageV57(target);
        return;
      }
      const authority = this.#providerThreadArchivePaneAuthorityV57(
        member.paneId,
      );
      journal.assertMemberPreimage(member.memberId, {
        paneId: authority.row.pane_id,
        paneRevision: authority.row.revision,
        paneCasDigest: authority.paneCasDigest,
        threadId: authority.binding.threadId,
        restartThreadId: authority.binding.restartThreadId,
        binding: authority.bindingPreimage,
      });
      return;
    }

    const frozenIdentity = {
      thread_id: stored.thread_id,
      restart_thread_id: stored.restart_thread_id,
    };
    const row = this.#providerArchiveStoredPaneRowV57(member.paneId);
    const providerColumns = [
      row.provider_account_profile_id,
      row.provider_thread_id,
      row.provider_restart_thread_id,
    ];
    const providerBindingCleared = providerColumns.every((value) =>
      value === null
    );
    if (providerColumns.some((value) => value === null) &&
      !providerBindingCleared) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "A settled v57 member retained only part of a provider identity.",
      );
    }
    if (member.action === "detach_binding_only") {
      if (
        row.archived_at !== null ||
        row.interaction_mode !== "chat" ||
        row.state !== "attention" ||
        row.active_prompt !== null ||
        row.active_provider_turn_id !== null ||
        !providerBindingCleared ||
        row.provider_context_reset_required !== 1 ||
        row.attention_code !== "runtime_unavailable" ||
        row.attention_message !== freshProviderContextAttentionMessage ||
        row.attention_retryable !== 0 ||
        row.message_queue_pause_reason !== "attention" ||
        row.revision !== stored.pane_revision + 1 ||
        (cut.cause === "account_removal"
          ? row.account_profile_id !== null
          : row.account_profile_id !== cut.accountProfileId) ||
        this.#retainedProviderAttachmentBindingCount(row.pane_id) !== 0
      ) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "A settled ordinary v57 member lacks its exact detached postimage.",
        );
      }
      this.#assertProviderArchiveLocalEffectsContainedV57(row.pane_id);
      this.#assertProviderArchiveFrozenIdentityReleasedV57(
        row.pane_id,
        frozenIdentity,
        false,
      );
      const expectedEvidenceDigest = this.#providerArchiveHmacV57(
        "member-settlement-evidence",
        {
          memberId: stored.member_id,
          cutId: stored.cut_id,
          paneId: stored.pane_id,
          role: stored.role,
          action: stored.action,
          cause: cut.cause,
          sourceGeneration: cut.sourceGeneration,
          detached: true,
        },
      );
      const expectedRevisionDigest = this.#providerArchiveHmacV57(
        "member-settlement-revision",
        {
          memberId: stored.member_id,
          frozenPaneRevision: stored.pane_revision,
          settledPaneRevision: row.revision,
          settledQueueRevision: row.message_queue_revision,
          providerContextResetRequired: true,
        },
      );
      if (
        stored.settlement_evidence_digest !== expectedEvidenceDigest ||
        stored.settlement_revision_digest !== expectedRevisionDigest
      ) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "A settled v57 member lost its exact local settlement evidence.",
        );
      }
      return;
    }
    this.#assertProviderArchiveLocalEffectsContainedV57(row.pane_id);
    throw new ChatPaneStoreError(
      "invalid_state",
      "Harness generation containment is not available in this v57 phase.",
    );
  }

  #assertProviderArchiveLocalEffectsContainedV57(paneId: ChatPaneId): void {
    const evidence = this.#providerArchiveLocalEffectEvidenceV57(paneId);
    if (
      evidence.unresolved_root_routes === 0 &&
      evidence.unresolved_message_effects === 0 &&
      evidence.retained_turn_leases === 0
    ) return;
    throw new ChatPaneStoreError(
      "revision_conflict",
      "A contained v57 pane retained unresolved local provider-effect evidence.",
    );
  }

  #providerArchiveLocalEffectEvidenceV57(
    paneId: ChatPaneId,
  ): z.infer<typeof providerArchiveLocalContainmentRowSchema> {
    return providerArchiveLocalContainmentRowSchema.parse(
      this.#database.query(`
        SELECT
          (
            SELECT COUNT(*)
            FROM harness_root_turn_routing_receipts
            WHERE pane_id = ?1
              AND settled_at IS NULL
          ) AS unresolved_root_routes,
          (
            SELECT COUNT(*)
            FROM chat_message_ledger AS message
            WHERE message.pane_id = ?1 AND (
              message.state IN (
                'start_claimed', 'steer_prepared',
                'start_effect_started', 'steer_effect_started',
                'start_acknowledged', 'steer_acknowledged'
              )
              OR (
                message.state = 'ambiguous'
                AND NOT EXISTS (
                  SELECT 1
                  FROM chat_message_ambiguous_resolutions AS resolution
                  WHERE resolution.message_id = message.message_id
                    AND resolution.pane_id = message.pane_id
                    AND resolution.claimed_turn_id = message.claimed_turn_id
                    AND resolution.resolution = 'discarded'
                )
              )
            )
          ) AS unresolved_message_effects,
          (
            SELECT COUNT(*)
            FROM chat_attachment_turn_leases
            WHERE pane_id = ?1 AND state != 'released'
          ) AS retained_turn_leases
      `).get(paneId),
    );
  }

  #providerArchivePaneHasUnsettledLocalEffectsV57(paneId: ChatPaneId): boolean {
    const evidence = this.#providerArchiveLocalEffectEvidenceV57(paneId);
    return evidence.unresolved_root_routes > 0 ||
      evidence.unresolved_message_effects > 0 ||
      evidence.retained_turn_leases > 0;
  }

  #assertProviderArchiveSealedInventoryPostimageV57(
    cut: ProviderThreadArchiveCutSnapshotV57,
  ): void {
    this.#assertProviderArchiveSourceSealAuthorityV57(cut);
    const authority = providerArchiveSealedCutAuthorityRowSchema.parse(
      this.#database.query(`
        SELECT member_count, inventory_digest
        FROM chat_provider_thread_archive_cuts_v57 WHERE cut_id = ?1
      `).get(cut.cutId),
    );
    const frozenPaneIds = cut.members.map((member) => member.paneId)
      .sort(compareProviderArchiveCodeUnits);
    if (
      authority.member_count !== cut.members.length ||
      new Set(frozenPaneIds).size !== frozenPaneIds.length
    ) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "The sealed v57 cut lost its frozen complete member set.",
      );
    }
    if (cut.cause === "account_removal") {
      this.#assertNoProviderArchiveHarnessSourceSessionsV57(
        cut.accountProfileId,
        null,
      );
      const frozen = new Set(frozenPaneIds);
      for (const row of this.#livePaneRows()) {
        const columns = [
          row.provider_account_profile_id,
          row.provider_thread_id,
          row.provider_restart_thread_id,
        ];
        if (columns.every((value) => value === null)) continue;
        if (columns.some((value) => value === null)) {
          throw new ChatPaneStoreError(
            "corrupt_state",
            "A live pane retained a partial provider identity after removal sealing.",
          );
        }
        if (
          row.provider_account_profile_id === cut.accountProfileId &&
          !frozen.has(row.pane_id)
        ) {
          throw new ChatPaneStoreError(
            "revision_conflict",
            "An unjournaled account pane appeared after removal inventory sealing.",
          );
        }
      }
      return;
    }
    const current = this.#enumerateProviderThreadArchiveSourceOwnershipV57({
      cut,
      accountProfileId: cut.accountProfileId,
      sourceGeneration: cut.sourceGeneration,
      now: new Date(0),
      allowSettledPostimages: true,
    });
    const represented = new Set(current.members.map((member) => member.paneId));
    for (const member of cut.members) {
      if (member.state === "settled") represented.add(member.paneId);
    }
    const representedPaneIds = [...represented]
      .sort(compareProviderArchiveCodeUnits);
    if (
      representedPaneIds.length !== frozenPaneIds.length ||
      representedPaneIds.some((paneId, index) =>
        paneId !== frozenPaneIds[index]
      )
    ) {
      throw new ChatPaneStoreError(
        "revision_conflict",
        "The live source generation no longer equals the sealed v57 inventory plus authorized postimages.",
      );
    }
    if (cut.members.every((member) => member.state === "pending") && (
      current.expectedMemberCount !== authority.member_count ||
      current.expectedInventoryDigest !== authority.inventory_digest
    )) {
      throw new ChatPaneStoreError(
        "revision_conflict",
        "The pending live source inventory no longer matches the sealed v57 digest.",
      );
    }
  }

  #enumerateProviderThreadArchiveSourceOwnershipV57(input: Readonly<{
    cut: ProviderThreadArchiveCutSnapshotV57;
    accountProfileId: ChatAccountProfileId;
    sourceGeneration: number;
    now: Date;
    allowSettledPostimages: boolean;
  }>): ChatProviderThreadArchiveSourceOwnershipV57 {
    const {
      cut,
      accountProfileId,
      sourceGeneration,
      now,
      allowSettledPostimages,
    } = input;
    if (
      cut.accountProfileId !== accountProfileId ||
      cut.sourceGeneration !== sourceGeneration ||
      cut.cause === "account_removal" ||
      !["fence_started", "fenced", "sealed", "contained"].includes(cut.state)
    ) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The v57 cut is not ready for exact source-generation enumeration.",
      );
    }
    const journal = this.#requireProviderThreadArchiveJournalV57();
    this.#assertProviderArchiveSourceCohortPreflightV57(
      accountProfileId,
      sourceGeneration,
    );
    const cutTargetValues: unknown[] = this.#database.query(`
      SELECT DISTINCT target.target_id
      FROM chat_provider_thread_archive_targets_v57 AS target
      JOIN chat_provider_thread_archive_attempts_v57 AS attempt
        ON attempt.target_id = target.target_id
      WHERE attempt.cut_id = ?1
      ORDER BY target.target_id
    `).all(cut.cutId);
    const cutTargets = cutTargetValues.map((value) =>
      journal.reopenTarget(z.object({
        target_id: z.string().min(1).max(96),
      }).strict().parse(value).target_id)
    );
    const frozenTargetMembers = allowSettledPostimages
      ? cut.members.filter((member) => member.role === "target").map(
          (member) => ({
            member,
            stored: this.#providerArchiveMemberAuthorityRowV57(member.memberId),
          }),
        )
      : [];
    if (allowSettledPostimages) {
      if (
        frozenTargetMembers.length !== cut.targetCount ||
        cutTargets.some((target) => !frozenTargetMembers.some(({ stored }) =>
          stored.target_id === target.targetId
        ))
      ) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "The sealed v57 target inventory disagrees with its surviving lineage.",
        );
      }
      for (const { member, stored } of frozenTargetMembers) {
        if (stored.target_id === null || stored.attempt_id === null) {
          throw new ChatPaneStoreError(
            "corrupt_state",
            "A sealed v57 target member lost its exact target attempt.",
          );
        }
        const target = cutTargets.find((candidate) =>
          candidate.targetId === stored.target_id
        );
        if (target === undefined) {
          throw new ChatPaneStoreError(
            member.state === "settled" ? "corrupt_state" : "revision_conflict",
            "A sealed v57 target lost its durable terminal purpose authority.",
          );
        }
        if (
          target.paneId !== member.paneId ||
          !target.attempts.some((attempt) =>
            attempt.attemptId === stored.attempt_id &&
            attempt.ordinal === stored.target_attempt_ordinal &&
            attempt.cutId === cut.cutId
          )
        ) {
          throw new ChatPaneStoreError(
            "corrupt_state",
            "A sealed v57 target member changed its frozen attempt lineage.",
          );
        }
      }
    }
    const members: AddProviderThreadArchiveCutMemberV57[] = [];
    const includedTargets = new Set<string>();
    for (const row of this.#livePaneRows()) {
      const providerColumns = [
        row.provider_account_profile_id,
        row.provider_thread_id,
        row.provider_restart_thread_id,
      ];
      if (providerColumns.every((value) => value === null)) continue;
      if (providerColumns.some((value) => value === null)) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "A live pane retained only part of its provider-thread identity.",
        );
      }
      if (row.provider_account_profile_id !== accountProfileId) continue;
      const authority = this.#providerThreadArchivePaneAuthorityV57(
        row.pane_id,
      );
      if (
        authority.ownership.accountProfileId !== accountProfileId ||
        authority.binding.accountProfileId !== accountProfileId
      ) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "A source inventory pane disagrees about its provider account.",
        );
      }
      const target = cutTargets.find((candidate) =>
        candidate.paneId === row.pane_id
      );
      const isExactCurrentCutTarget = target !== undefined
        && target.currentAttempt.cutId === cut.cutId
        && target.currentAttempt.generation === sourceGeneration;
      const ownsLiveSourceGeneration =
        authority.ownership.generation === sourceGeneration &&
        (
          authority.ownership.kind !== "ordinary" ||
          authority.ownership.authority.settledAt === null ||
          this.#providerArchivePaneHasUnsettledLocalEffectsV57(row.pane_id)
        );
      if (
        !ownsLiveSourceGeneration && !isExactCurrentCutTarget
      ) continue;
      if (authority.ownership.kind !== "ordinary") {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Harness panes cannot enter an ordinary-only v57 source inventory.",
        );
      }
      if (target !== undefined) includedTargets.add(target.targetId);
      const role = target === undefined ? "sibling" : "target";
      const action = target === undefined
        ? row.interaction_mode === "harnessObserver"
          ? "contain_generation_context"
          : "detach_binding_only"
        : "preserved_target";
      const memberId = `archmember_${this.#providerArchiveHmacV57(
        "cut-member-id",
        { cutId: cut.cutId, paneId: row.pane_id },
      )}`;
      const identityEvidenceDigest = this.#providerArchiveHmacV57(
        "cut-member-evidence",
        {
          memberId,
          cutId: cut.cutId,
          accountProfileId,
          sourceGeneration,
          paneId: row.pane_id,
          threadId: authority.binding.threadId,
          restartThreadId: authority.binding.restartThreadId,
          role,
          targetId: target?.targetId ?? null,
          attemptId: target?.currentAttempt.attemptId ?? null,
          targetAttemptOrdinal: target?.currentAttempt.ordinal ?? null,
          action,
          binding: authority.bindingPreimage,
          ownership: authority.ownership,
        },
      );
      const identityRevisionDigest = this.#providerArchiveHmacV57(
        "cut-member-revision",
        {
          memberId,
          paneRevision: row.revision,
          paneCasDigest: authority.paneCasDigest,
          binding: authority.bindingPreimage,
        },
      );
      members.push(Object.freeze({
        memberId,
        cutId: cut.cutId,
        paneId: row.pane_id,
        paneRevision: row.revision,
        paneCasDigest: authority.paneCasDigest,
        threadId: authority.binding.threadId,
        restartThreadId: authority.binding.restartThreadId,
        role,
        targetId: target?.targetId ?? null,
        attemptId: target?.currentAttempt.attemptId ?? null,
        targetAttemptOrdinal: target?.currentAttempt.ordinal ?? null,
        action,
        binding: authority.bindingPreimage,
        identityEvidenceDigest,
        identityRevisionDigest,
        now,
      }));
    }
    if (
      (allowSettledPostimages
        ? frozenTargetMembers.length
        : cutTargets.length) !== cut.targetCount ||
      (!allowSettledPostimages && includedTargets.size !== cutTargets.length)
    ) {
      throw new ChatPaneStoreError(
        "revision_conflict",
        "The v57 cut target set no longer equals the source inventory.",
      );
    }
    members.sort((left, right) =>
      compareProviderArchiveCodeUnits(left.paneId, right.paneId)
    );
    const expectedInventoryDigest =
      providerThreadArchiveCompleteInventoryDigestV57(members);
    const enumerationAuthorityDigest = this.#providerArchiveHmacV57(
      "complete-source-enumeration",
      {
        cutId: cut.cutId,
        accountProfileId,
        sourceGeneration,
        expectedMemberCount: members.length,
        expectedInventoryDigest,
        members: members.map((member) => ({
          memberId: member.memberId,
          paneId: member.paneId,
          paneRevision: member.paneRevision,
          paneCasDigest: member.paneCasDigest,
          role: member.role,
          targetId: member.targetId,
          attemptId: member.attemptId,
          targetAttemptOrdinal: member.targetAttemptOrdinal,
          action: member.action,
          binding: member.binding,
          identityEvidenceDigest: member.identityEvidenceDigest,
          identityRevisionDigest: member.identityRevisionDigest,
        })),
      },
    );
    return Object.freeze({
      accountProfileId,
      sourceGeneration,
      members: Object.freeze(members),
      expectedMemberCount: members.length,
      expectedInventoryDigest,
      enumerationAuthorityDigest,
    });
  }

  #providerThreadArchiveSuccessorWaveReadyV57(
    cutIdValue: string,
  ): readonly ReturnType<
    ProviderThreadArchiveJournalV57["admissionDescriptor"]
  >[] {
    const cutId = providerArchiveCutIdSchema.parse(cutIdValue);
    const journal = this.#requireProviderThreadArchiveJournalV57();
    const cut = journal.reopenCut(cutId);
    if (
      cut.cause === "account_removal" || cut.state !== "contained" ||
      cut.successorGeneration !== cut.sourceGeneration + 1 ||
      cut.successorAccountProfileRevision === null
    ) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The v57 successor wave lacks one contained N plus one authority.",
      );
    }
    this.#assertProviderArchiveSourceContainedAuthorityV57(cut);
    const targetMembers = cut.members.filter((member) =>
      member.role === "target"
    ).map((member) => ({
      member,
      stored: this.#providerArchiveMemberAuthorityRowV57(member.memberId),
    }));
    if (targetMembers.length !== cut.targetCount) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "The contained v57 cut lost its complete frozen target cohort.",
      );
    }
    const readyTargetIds: string[] = [];
    for (const { member, stored } of targetMembers) {
      if (
        stored.target_id === null || stored.attempt_id === null ||
        stored.target_attempt_ordinal === null ||
        stored.cut_id !== cutId || stored.pane_id !== member.paneId
      ) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "A contained v57 target member lost its frozen predecessor authority.",
        );
      }
      const target = journal.reopenTarget(stored.target_id);
      const predecessor = target.attempts.find((attempt) =>
        attempt.attemptId === stored.attempt_id
      );
      if (
        target.paneId !== stored.pane_id || predecessor === undefined ||
        predecessor.ordinal !== stored.target_attempt_ordinal ||
        predecessor.cutId !== cutId ||
        predecessor.generation !== cut.sourceGeneration
      ) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "A contained v57 target changed its frozen predecessor lineage.",
        );
      }
      if (target.status === "committed") {
        this.#assertProviderArchiveTargetStoreAuthorityV57(target);
        if (predecessor.state !== "reconciled_applied") {
          throw new ChatPaneStoreError(
            "corrupt_state",
            "A terminal v57 wave sibling lacks its applied predecessor result.",
          );
        }
        const targetRow = this.#providerArchiveTargetAuthorityRowV57(
          target.targetId,
        );
        this.#replayCommittedProviderThreadArchiveFinalizationV57({
          target,
          targetRow,
          containmentReceipt:
            this.#providerArchiveFinalizationContainmentReceiptV57(target),
        });
        continue;
      }
      if (
        target.status !== "open" ||
        predecessor.state !== "reconciled_not_applied" ||
        target.currentAttempt.state !== "effect_started" ||
        target.currentAttempt.cutId !== null ||
        target.currentAttempt.generation !== cut.successorGeneration ||
        target.currentAttempt.accountProfileRevision !==
          cut.successorAccountProfileRevision ||
        target.currentAttempt.predecessorAttemptId !== predecessor.attemptId ||
        target.currentAttempt.ordinal !== predecessor.ordinal + 1
      ) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Every open v57 wave sibling must own its exact effect-started N plus one successor.",
        );
      }
      this.#assertProviderArchiveTargetPreimageV57(target);
      readyTargetIds.push(target.targetId);
    }
    readyTargetIds.sort(compareProviderArchiveCodeUnits);
    return Object.freeze(readyTargetIds.map((targetId) =>
      journal.admissionDescriptor(targetId)
    ));
  }

  #providerArchiveHmacV57(domain: string, value: unknown): string {
    return createHmac("sha256", this.#messageRequestDigestKey)
      .update(`hra-provider-thread-archive-store-v57:${domain}\0`)
      .update(canonicalProviderArchiveJson(value))
      .digest("hex");
  }

  #assertMessageQueueClosableForPane(paneId: ChatPaneId): void {
    const blocker = countRowSchema.parse(this.#database.query(`
      SELECT COUNT(*) AS count FROM chat_message_ledger
      WHERE pane_id = ?1 AND (
        state IN (
          'start_effect_started', 'steer_effect_started',
          'start_acknowledged', 'steer_acknowledged'
        )
        OR (state = 'ambiguous' AND NOT EXISTS (
            SELECT 1 FROM chat_message_ambiguous_resolutions AS resolution
            WHERE resolution.message_id = chat_message_ledger.message_id
              AND resolution.pane_id = chat_message_ledger.pane_id
              AND resolution.claimed_turn_id =
                chat_message_ledger.claimed_turn_id
              AND resolution.resolution = 'discarded'
          ))
      )
    `).get(paneId)).count;
    if (blocker > 0) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Contain the in-flight or ambiguous message effect before closing this pane.",
      );
    }
  }

  #pendingProviderThreadArchiveIntent(
    paneId: ChatPaneId,
  ): ChatProviderThreadArchiveIntent | null {
    const intent = this.providerThreadArchiveIntent(paneId);
    return intent !== null && intent.state !== "account_contained"
      ? intent
      : null;
  }

  #assertNoPendingProviderThreadArchiveIntent(paneId: ChatPaneId): void {
    if (this.#pendingProviderThreadArchiveIntent(paneId) !== null) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "This provider-context transition is pending; only its exact recovery may continue.",
      );
    }
    this.#assertNoPendingProviderThreadArchiveAuthorityV57(paneId);
  }

  #assertNoPendingProviderThreadArchiveAuthorityV57(
    paneId: ChatPaneId,
    allowedTargetId: string | null = null,
    allowedMemberId: string | null = null,
    allowMembersForTarget = false,
    allowedSettledTargetAttemptOrdinal: number | null = null,
  ): void {
    const pending = countRowSchema.parse(this.#database.query(`
      SELECT (
        SELECT COUNT(*)
        FROM chat_provider_thread_archive_targets_v57
        WHERE pane_id = ?1
          AND (?2 IS NULL OR target_id != ?2)
      ) + (
        SELECT COUNT(*)
        FROM chat_provider_thread_archive_cut_members_v57 AS member
        WHERE member.pane_id = ?1 AND (
          member.state = 'pending'
          OR EXISTS (
            SELECT 1
            FROM chat_provider_thread_archive_attempts_v57 AS attempt
            JOIN chat_provider_thread_archive_targets_v57 AS target
              ON target.target_id = attempt.target_id
            WHERE attempt.cut_id = member.cut_id
          )
        )
          AND (?3 IS NULL OR member.member_id != ?3)
          AND (
            ?4 = 0 OR ?2 IS NULL
            OR member.target_id IS NULL OR member.target_id != ?2
          )
          AND NOT (
            ?5 IS NOT NULL AND ?2 IS NOT NULL
            AND member.state = 'settled'
            AND member.role = 'target'
            AND member.target_id = ?2
            AND member.target_attempt_ordinal IS NOT NULL
            AND member.target_attempt_ordinal <= ?5
            AND EXISTS (
              SELECT 1
              FROM chat_provider_thread_archive_attempts_v57 AS lineage
              WHERE lineage.target_id = member.target_id
                AND lineage.attempt_id = member.attempt_id
                AND lineage.ordinal = member.target_attempt_ordinal
                AND lineage.cut_id = member.cut_id
            )
          )
      ) AS count
    `).get(
      paneId,
      allowedTargetId,
      allowedMemberId,
      allowMembersForTarget ? 1 : 0,
      allowedSettledTargetAttemptOrdinal,
    )).count;
    if (pending !== 0) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "This v57 provider-context transition is pending; only its exact recovery may continue.",
      );
    }
    this.#assertNoActiveProviderArchiveSourceCutV57({
      paneId,
      allowedTargetId,
      allowedMemberId,
      allowMembersForTarget,
    });
  }

  #assertNoPendingProviderArchiveAccountAdmissionV57(
    accountProfileIdValue: string,
  ): void {
    const accountProfileId = accountProfileIdSchema.parse(
      accountProfileIdValue,
    );
    const pending = countRowSchema.parse(this.#database.query(`
      SELECT (
        SELECT COUNT(*)
        FROM chat_provider_thread_archive_targets_v57
        WHERE account_profile_id = ?1
      ) + (
        SELECT COUNT(*)
        FROM chat_provider_thread_archive_cuts_v57
        WHERE account_profile_id = ?1 AND state IN (
          'fence_started', 'fenced', 'sealed',
          'removal_awaiting_tombstone'
        )
      ) AS count
    `).get(accountProfileId)).count;
    if (pending === 0) return;
    throw new ChatPaneStoreError(
      "invalid_state",
      "This provider account is quarantined by a pending v57 archive transition.",
    );
  }

  #assertNoActiveProviderArchiveSourceCutV57(input: Readonly<{
    paneId: ChatPaneId;
    allowedTargetId: string | null;
    allowedMemberId: string | null;
    allowMembersForTarget: boolean;
  }>): void {
    const row = this.#providerArchiveStoredPaneRowV57(input.paneId);
    const providerColumns = [
      row.provider_account_profile_id,
      row.provider_thread_id,
      row.provider_restart_thread_id,
    ];
    if (providerColumns.every((value) => value === null)) return;
    if (providerColumns.some((value) => value === null)) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "The pane retained only part of its provider-thread identity during containment.",
      );
    }
    const values: unknown[] = this.#database.query(`
      SELECT cut_id, account_profile_id, source_generation, cause, state
      FROM chat_provider_thread_archive_cuts_v57
      WHERE account_profile_id = ?1 AND state IN (
        'fence_started', 'fenced', 'sealed', 'removal_awaiting_tombstone'
      )
      ORDER BY cut_id LIMIT 2
    `).all(row.provider_account_profile_id);
    if (values.length === 0) return;
    if (values.length !== 1) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "The provider account retained multiple active containment cuts.",
      );
    }
    const cut = providerArchiveActiveCutFenceRowSchema.parse(values[0]);
    if (cut.cause !== "account_removal") {
      const authority = this.#providerThreadArchivePaneAuthorityV57(
        input.paneId,
      );
      if (
        authority.ownership.accountProfileId !== cut.account_profile_id
        || authority.ownership.generation !== cut.source_generation
      ) return;
      const settledOrdinaryHistory = authority.ownership.kind === "ordinary" &&
        authority.ownership.authority.settledAt !== null;
      if (settledOrdinaryHistory) {
        const journalAuthority = countRowSchema.parse(this.#database.query(`
          SELECT (
            SELECT COUNT(*)
            FROM chat_provider_thread_archive_targets_v57 AS target
            JOIN chat_provider_thread_archive_attempts_v57 AS attempt
              ON attempt.target_id = target.target_id
            WHERE target.pane_id = ?1 AND attempt.cut_id = ?2
          ) + (
            SELECT COUNT(*)
            FROM chat_provider_thread_archive_cut_members_v57 AS member
            WHERE member.pane_id = ?1 AND member.cut_id = ?2
          ) AS count
        `).get(input.paneId, cut.cut_id)).count;
        // A settled route that is absent from the frozen cut is historical
        // thread provenance only. It may resume on the successor generation
        // and must not inherit the target's mutation quarantine.
        if (journalAuthority === 0) return;
      }
    }
    const exactRecoveryAllowance = countRowSchema.parse(this.#database.query(`
      SELECT (
        SELECT COUNT(*)
        FROM chat_provider_thread_archive_targets_v57 AS target
        JOIN chat_provider_thread_archive_attempts_v57 AS attempt
          ON attempt.target_id = target.target_id
        WHERE ?1 IS NOT NULL AND target.target_id = ?1
          AND target.pane_id = ?2 AND target.status != 'committed'
          AND attempt.cut_id = ?3
      ) + (
        SELECT COUNT(*)
        FROM chat_provider_thread_archive_cut_members_v57 AS member
        WHERE ?4 IS NOT NULL AND member.member_id = ?4
          AND member.pane_id = ?2 AND member.cut_id = ?3
      ) + (
        SELECT COUNT(*)
        FROM chat_provider_thread_archive_cut_members_v57 AS member
        WHERE ?5 = 1 AND ?1 IS NOT NULL AND member.target_id = ?1
          AND member.pane_id = ?2 AND member.cut_id = ?3
      ) AS count
    `).get(
      input.allowedTargetId,
      input.paneId,
      cut.cut_id,
      input.allowedMemberId,
      input.allowMembersForTarget ? 1 : 0,
    )).count;
    if (exactRecoveryAllowance > 0) return;
    throw new ChatPaneStoreError(
      "invalid_state",
      "This pane belongs to an active v57 source-generation cut; only exact containment recovery may mutate it.",
    );
  }

  #requireRevision(
    paneId: ChatPaneId,
    expectedRevision: number,
    options: Readonly<{
      allowPendingProviderThreadArchiveIntent?: boolean;
    }> = {},
  ): ChatPanePrivateRecord {
    if (options.allowPendingProviderThreadArchiveIntent !== true) {
      this.#assertNoPendingProviderThreadArchiveIntent(paneId);
    }
    const pane = this.require(paneId);
    if (pane.projection.revision !== expectedRevision) throw staleRevision();
    return pane;
  }

  #requireActiveTurn(paneId: ChatPaneId, turnId: ChatTurnId): ChatPanePrivateRecord {
    const id = chatPaneIdSchema.parse(paneId);
    this.#assertNoPendingProviderThreadArchiveIntent(id);
    const pane = this.require(id);
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
    requiredInputClass: "text" | "image",
    now: Date,
  ): RootTurnRoutingClassificationAdmissionV1 {
    const prior = this.#rootTurnRouting.readLatestTurnRouting(paneId);
    const routing = classifyRootTurnRoutingV1({
      prompt,
      requiredInputClass,
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
      requiredInputClass,
      classificationReason: routing.classificationReason,
      workClass: routing.workClass,
      requestedProfile: routing.requestedProfile,
      requestedServiceTier: routing.requestedServiceTier,
      now,
    };
  }

  #attachmentRequiredInputClass(
    paneId: ChatPaneId,
    attachmentIds: readonly string[],
  ): "text" | "image" {
    let required: "text" | "image" = "text";
    for (const attachmentId of attachmentIds) {
      const value: unknown = this.#database.query(`
        SELECT kind, state FROM chat_attachments
        WHERE pane_id = ?1 AND attachment_id = ?2
      `).get(paneId, attachmentId);
      let row: z.infer<typeof attachmentInputClassRowSchema>;
      try {
        row = attachmentInputClassRowSchema.parse(value);
      } catch {
        throw new ChatPaneStoreError(
          "invalid_state",
          "A claimed attachment is no longer ready for input classification.",
        );
      }
      if (row.kind !== "image") {
        throw new ChatPaneStoreError(
          "invalid_state",
          "HRA currently supports image attachments only.",
        );
      }
      required = "image";
    }
    return required;
  }

  #retainedProviderAttachmentBindingCount(paneId: ChatPaneId): number {
    return this.#retainedProviderAttachmentBindingRows(paneId).length;
  }

  #retainedProviderAttachmentBindingRows(
    paneId: ChatPaneId,
  ): readonly z.infer<typeof retainedProviderAttachmentBindingRowSchema>[] {
    const values: unknown[] = this.#database.query(`
      SELECT binding_id, binding_key_digest, revision, state
      FROM chat_provider_attachment_bindings
      WHERE pane_id = ?1 AND state IN ('active', 'ambiguous')
      ORDER BY binding_id
      LIMIT 2
    `).all(paneId);
    return values.map((value) =>
      retainedProviderAttachmentBindingRowSchema.parse(value)
    );
  }

  #preflightPaneArchive(
    paneId: ChatPaneId,
    expectedRevision: number,
    allowedTargetId: string | null = null,
  ): ChatPanePrivateRecord {
    this.#assertNoPendingProviderThreadArchiveAuthorityV57(
      paneId,
      allowedTargetId,
      null,
      allowedTargetId !== null,
    );
    const pane = this.#requireRevision(paneId, expectedRevision, {
      allowPendingProviderThreadArchiveIntent: true,
    });
    if (isActive(pane.projection)) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Wait for this chat turn to finish before closing its pane.",
      );
    }
    if (pane.projection.interactionMode !== "chat") {
      throw new ChatPaneStoreError(
        "invalid_state",
        "An attached actor pane is retained with its durable actor binding.",
      );
    }
    if (
      this.#scheduledChats.get(paneId) !== null
      || this.#scheduledChats.mutationForPane(paneId) !== null
      || this.#scheduledChats.desiredOff(paneId) !== null
    ) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Turn off this chat's schedule before closing its pane.",
      );
    }
    const pendingTransition = this.#pendingProviderThreadArchiveIntent(paneId);
    if (
      pendingTransition !== null && pendingTransition.purpose !== "pane_archive"
    ) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "This provider-context transition is pending; only its exact recovery may continue.",
      );
    }
    this.#assertMessageQueueClosableForPane(paneId);
    this.#paneArchiveAuthority?.assertPaneArchiveCompatible(paneId);
    if (
      this.classifyRetainedProviderAttachmentBinding(paneId, pane.binding)
        .kind === "orphan"
    ) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Attachment custody no longer matches this pane's provider lineage.",
      );
    }
    return pane;
  }

  #requireProviderThreadArchiveIntent(
    paneId: ChatPaneId,
  ): ChatProviderThreadArchiveIntent {
    return this.providerThreadArchiveIntent(paneId) ?? corrupt(
      "The durable provider thread archive intent is missing.",
    );
  }

  #requireSucceededProviderThreadArchiveIntent(input: Readonly<{
    readonly pane: ChatPanePrivateRecord;
    readonly purpose: "start_fresh" | "pane_archive";
    readonly paneRevision: number;
    readonly queueRevision: number | null;
  }>): ChatProviderThreadArchiveIntent {
    const binding = input.pane.binding ?? corrupt(
      "A provider archive intent cannot finalize without its exact pane binding.",
    );
    const intent = this.#requireProviderThreadArchiveIntent(
      input.pane.projection.id,
    );
    if (
      intent.state !== "succeeded" ||
      intent.purpose !== input.purpose ||
      intent.pane_revision !== input.paneRevision ||
      intent.queue_revision !== input.queueRevision ||
      intent.account_profile_id !== binding.accountProfileId ||
      intent.thread_id !== binding.threadId ||
      intent.restart_thread_id !== binding.restartThreadId ||
      intent.containment_receipt === null ||
      intent.response_generation === null ||
      !(
        intent.response_generation === intent.generation ||
        (
          intent.response_generation > intent.generation &&
          intent.generation_contained === 1 &&
          intent.generation_containment_receipt !== null &&
          intent.reconciliation_disposition === "applied" &&
          intent.reconciliation_receipt !== null
        )
      )
    ) {
      throw new ChatPaneStoreError(
        "revision_conflict",
        "The provider containment receipt no longer authorizes this transition.",
      );
    }
    return intent;
  }

  #releaseExactProviderAttachmentBindingInTransaction(
    paneId: ChatPaneId,
    classification: RetainedProviderAttachmentBindingClassification,
    intent: ChatProviderThreadArchiveIntent,
    now: Date,
  ): void {
    if (classification.kind === "orphan") {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Attachment custody no longer matches this pane's provider lineage.",
      );
    }
    if (classification.kind === "exact") {
      if (
        this.#paneArchiveAuthority === null ||
        intent.binding_id !== classification.bindingId ||
        intent.binding_key_digest !== classification.bindingKeyDigest ||
        intent.binding_revision !== classification.revision ||
        intent.containment_receipt === null
      ) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "Provider attachment custody changed before containment finalized.",
        );
      }
      this.#paneArchiveAuthority
        .releaseProviderBindingAfterResumeContainedInTransaction({
          bindingId: classification.bindingId,
          bindingKeyDigest: classification.bindingKeyDigest,
          paneId,
          expectedRevision: classification.revision,
          containmentReceipt: intent.containment_receipt,
          now,
        });
    } else if (
      intent.binding_id !== null || intent.binding_key_digest !== null ||
      intent.binding_revision !== null
    ) {
      throw new ChatPaneStoreError(
        "revision_conflict",
        "The provider containment intent retained stale attachment authority.",
      );
    }
    if (this.#retainedProviderAttachmentBindingCount(paneId) !== 0) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Provider attachment custody remains after exact containment.",
      );
    }
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
      reasoningItemId: row.reasoning_active_item_id,
      activeTurnPoisoned: row.active_turn_poisoned === 1,
      providerContextResetRequired:
        row.provider_context_reset_required === 1,
    };
  }

  #projection(row: PaneRow): ChatPaneProjection {
    const providerBinding = row.provider_account_profile_id === null ||
        row.provider_thread_id === null ||
        row.provider_restart_thread_id === null
      ? null
      : {
          accountProfileId: row.provider_account_profile_id,
          threadId: row.provider_thread_id,
          restartThreadId: row.provider_restart_thread_id,
        };
    const retainedBinding = this.classifyRetainedProviderAttachmentBinding(
      row.pane_id,
      providerBinding,
    );
    const pendingArchiveIntent = this.providerThreadArchiveIntent(row.pane_id);
    const pendingV57PaneArchiveTarget = countRowSchema.parse(
      this.#database.query(`
        SELECT COUNT(*) AS count
        FROM chat_provider_thread_archive_targets_v57
        WHERE pane_id = ?1 AND status != 'committed'
          AND purpose = 'pane_archive'
      `).get(row.pane_id),
    ).count;
    const archiveIntentAllowsFreshStart = providerBinding === null
      ? pendingArchiveIntent === null ||
        pendingArchiveIntent.state === "account_contained"
      : pendingArchiveIntent === null ||
        (
          pendingArchiveIntent.purpose === "start_fresh" &&
          pendingArchiveIntent.state !== "account_contained"
        );
    const responseTail = chatResponseMarkdownSchema.parse({
      tail: row.response_tail,
      totalUtf8Bytes: row.response_total_utf8_bytes,
      truncatedPrefix: utf8ByteLength(row.response_tail) < row.response_total_utf8_bytes,
    });
    const reasoningTerminal = row.turn_status === "completed" ||
      row.turn_status === "failed";
    const reasoningText = row.reasoning_proof_tainted === 1
      ? ""
      : reasoningTerminal
      ? row.reasoning_verified_tail
      : row.reasoning_tail;
    const reasoningBytes = row.reasoning_proof_tainted === 1
      ? 0
      : reasoningTerminal
      ? row.reasoning_verified_total_utf8_bytes
      : row.reasoning_total_utf8_bytes;
    const reasoningTail = chatReasoningSummarySchema.parse({
      tail: reasoningText,
      totalUtf8Bytes: reasoningBytes,
      truncatedPrefix: utf8ByteLength(reasoningText) < reasoningBytes,
    });
    const tools = parseJson(row.tools_json, toolsSchema);
    const providerSubagents = chatProviderSubagentsProjectionSchema.parse({
      agents: parseJson(
        row.provider_subagents_json,
        chatProviderSubagentsProjectionSchema.shape.agents,
      ),
      overflowCount: row.provider_subagent_overflow_count,
    });
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
          reasoningSummaryVerified: row.reasoning_proof_tainted === 0 &&
            row.reasoning_verified_total_utf8_bytes > 0,
          tools,
          providerSubagents,
          routing,
        };
    try {
      return chatPaneProjectionSchema.parse({
        id: row.pane_id,
        paletteIndex: row.palette_index,
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
        canStartFreshContext:
          row.provider_context_reset_required === 1 &&
          retainedBinding.kind !== "orphan" &&
          archiveIntentAllowsFreshStart &&
          pendingV57PaneArchiveTarget === 0 &&
          row.state === "attention" &&
          row.attention_code === "runtime_unavailable" &&
          row.attention_retryable === 0 &&
          row.message_queue_pause_reason !== null &&
          row.message_queue_pause_reason !== "ambiguous_effect",
        schedule: this.#scheduledChats.projection(row.pane_id),
        messageQueue: this.#messageQueueProjection(
          chatMessageQueueMetadataRowSchema.parse({
            pane_id: row.pane_id,
            interaction_mode: row.interaction_mode,
            state: row.state,
            active_turn_id: row.active_turn_id,
            archived_at: row.archived_at,
            message_queue_revision: row.message_queue_revision,
            next_message_ordinal: row.next_message_ordinal,
            message_queue_pause_reason: row.message_queue_pause_reason,
          }),
        ),
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

function storedReasoningReceiptMatches(
  stored: z.infer<typeof reasoningReceiptRowSchema>,
  receipt: ReasoningSummaryCompletionReceipt,
): boolean {
  return stored.receipt_id === receipt.receiptId &&
    stored.state === receipt.state &&
    stored.completion_digest === receipt.completionDigest &&
    stored.completion_generation === receipt.completionGeneration &&
    stored.completion_stream_position === receipt.completionStreamPosition &&
    stored.completion_fact_index === receipt.completionFactIndex &&
    stored.overflowed === (receipt.overflowed ? 1 : 0) &&
    stored.repaired_suffix === (receipt.repairedSuffix ? 1 : 0) &&
    stored.taint_reason === receipt.reason &&
    stored.summary_tail === (receipt.summary?.tail ?? null) &&
    stored.summary_total_utf8_bytes ===
      (receipt.summary?.totalUtf8Bytes ?? null) &&
    stored.summary_truncated_prefix === (
      receipt.summary === null ? null : receipt.summary.truncatedPrefix ? 1 : 0
    );
}

function replayDisposition(
  row: ChatMessageLedgerRow,
): "notApplied" | "replayed" {
  switch (row.request_delivery_outcome) {
    case "accepted":
    case "effect_started":
    case "ambiguous":
      return "replayed";
    case "not_applied":
      return "notApplied";
    case "pending":
      throw new ChatPaneStoreError(
        "conflict",
        "The original steering request has not reached a durable outcome.",
      );
    case "legacy":
      throw new ChatPaneStoreError(
        "conflict",
        "This legacy chat message cannot prove an exact request replay.",
      );
  }
}

function compareProviderArchiveCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function providerArchiveStringArraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function canonicalProviderArchiveJson(value: unknown): string {
  if (value === null || typeof value === "boolean" ||
    typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "A provider archive digest contained a noncanonical number.",
      );
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalProviderArchiveJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record).sort(compareProviderArchiveCodeUnits);
    return `{${keys.map((key) => {
      const entry = record[key];
      if (entry === undefined) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "A provider archive digest contained an undefined field.",
        );
      }
      return `${JSON.stringify(key)}:${canonicalProviderArchiveJson(entry)}`;
    }).join(",")}}`;
  }
  throw new ChatPaneStoreError(
    "corrupt_state",
    "A provider archive digest contained an unsupported value.",
  );
}

function validateRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ChatPaneStoreError("conflict", "Chat pane revision is invalid.");
  }
}

function boundedOpaqueReceipt(value: string): string {
  if (
    typeof value !== "string" || value.length < 16 || value.length > 512 ||
    value.includes("\0")
  ) {
    throw new ChatPaneStoreError("invalid_state", "Provider receipt is invalid.");
  }
  return value;
}

function sameBinding(
  left: ChatThreadBinding | null,
  right: ChatThreadBinding,
): boolean {
  return left !== null &&
    left.accountProfileId === right.accountProfileId &&
    left.threadId === right.threadId &&
    left.restartThreadId === right.restartThreadId;
}

function staleRevision(): ChatPaneStoreError {
  return new ChatPaneStoreError(
    "revision_conflict",
    "This chat pane changed. Try again with its latest revision.",
  );
}

function staleQueueRevision(): ChatPaneStoreError {
  return new ChatPaneStoreError(
    "revision_conflict",
    "This chat message queue changed. Try again with its latest revision.",
  );
}

function staleMessageRevision(): ChatPaneStoreError {
  return new ChatPaneStoreError(
    "revision_conflict",
    "This queued chat message changed. Try again with its latest revision.",
  );
}

function sqliteConflict(error: unknown, message: string): ChatPaneStoreError {
  if (error instanceof ChatPaneStoreError) return error;
  return new ChatPaneStoreError("conflict", message);
}

function sqliteMessageConflict(error: unknown, message: string): ChatPaneStoreError {
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
