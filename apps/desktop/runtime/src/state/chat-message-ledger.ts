import type { Database } from "bun:sqlite";
import { z } from "@hra-internal/schema";
import {
  chatIsoDateTimeSchema,
  chatMessageAttachmentIdSchema,
  chatMessageContentSchema,
  chatMessageIdSchema,
  chatMessageQueuePauseReasonSchema,
  chatMessageQueueProjectionSchema,
  chatPaneIdSchema,
  chatTurnIdSchema,
  runtimeChatMessageAttachmentLimit,
  runtimeChatQueuedMessageLimit,
  runtimeChatQueueUtf8ByteLimit,
  type ChatMessageAttachmentId,
  type ChatMessageContent,
  type ChatMessageId,
  type ChatMessageQueuePauseReason,
  type ChatMessageQueueProjection,
  type ChatPaneProjection,
} from "../../../contracts/runtime";

export const CHAT_MESSAGE_MAX_ACTIVE_PER_PANE = runtimeChatQueuedMessageLimit;
export const CHAT_MESSAGE_MAX_UTF8_BYTES_PER_PANE = runtimeChatQueueUtf8ByteLimit;
export const CHAT_MESSAGE_MAX_UTF8_BYTES_TOTAL = 8 * 1024 * 1024;

export const storedChatMessageStateSchema = z.enum([
  "queued",
  "start_claimed",
  "start_effect_started",
  "start_acknowledged",
  "steer_prepared",
  "steer_effect_started",
  "steer_acknowledged",
  "completed",
  "cancelled",
  "ambiguous",
]);

export type StoredChatMessageState = z.infer<typeof storedChatMessageStateSchema>;
export type ChatMessageClaimKind = "start" | "steer";
export type ChatTurnId = z.infer<typeof chatTurnIdSchema>;

const storedQueuePauseReasonSchema = z.enum([
  "stop",
  "runtime_restart",
  "attention",
  "ambiguous_effect",
]);

export const chatMessageLedgerRowSchema = z.object({
  message_id: chatMessageIdSchema,
  pane_id: chatPaneIdSchema,
  ordinal: z.number().int().positive().safe(),
  revision: z.number().int().positive().safe(),
  message_text: z.string(),
  message_utf8_bytes: z.number().int().nonnegative().safe(),
  state: storedChatMessageStateSchema,
  claimed_turn_id: chatTurnIdSchema.nullable(),
  effect_started_at: chatIsoDateTimeSchema.nullable(),
  acknowledged_at: chatIsoDateTimeSchema.nullable(),
  terminal_at: chatIsoDateTimeSchema.nullable(),
  created_at: chatIsoDateTimeSchema,
  updated_at: chatIsoDateTimeSchema,
}).strict();

export const chatMessageQueueMetadataRowSchema = z.object({
  pane_id: chatPaneIdSchema,
  interaction_mode: z.enum(["chat", "harnessObserver"]),
  state: z.enum(["ready", "starting", "streaming", "continuing", "attention"]),
  active_turn_id: chatTurnIdSchema.nullable(),
  archived_at: chatIsoDateTimeSchema.nullable(),
  message_queue_revision: z.number().int().positive().safe(),
  next_message_ordinal: z.number().int().positive().safe(),
  message_queue_pause_reason: storedQueuePauseReasonSchema.nullable(),
}).strict();

export type ChatMessageLedgerRow = z.infer<typeof chatMessageLedgerRowSchema>;
export type ChatMessageQueueMetadataRow = z.infer<
  typeof chatMessageQueueMetadataRowSchema
>;

export interface ChatMessageAttachmentReadinessInput {
  readonly paneId: ChatPaneProjection["id"];
  readonly attachmentRefs: readonly ChatMessageAttachmentId[];
  readonly now: string;
}

export interface ChatMessageAttachmentAuthority {
  /** Every method runs synchronously inside the caller-owned SQLite transaction. */
  bindReadyMessageRefsInTransaction(input: Readonly<
    ChatMessageAttachmentReadinessInput & { messageId: ChatMessageId }
  >): void;
  replaceReadyMessageRefsInTransaction(input: Readonly<
    ChatMessageAttachmentReadinessInput & { messageId: ChatMessageId }
  >): void;
  messageRefsInTransaction(input: Readonly<{
    paneId: ChatPaneProjection["id"];
    messageId: ChatMessageId;
  }>): readonly ChatMessageAttachmentId[];
  acquireTurnLeasesInTransaction(input: Readonly<{
    paneId: ChatPaneProjection["id"];
    messageId: ChatMessageId;
    turnId: ChatTurnId;
    now: string;
  }>): void;
  releasePreparedTurnLeasesInTransaction(input: Readonly<{
    paneId: ChatPaneProjection["id"];
    messageId: ChatMessageId;
    turnId: ChatTurnId;
    now: string;
  }>): void;
  markTurnLeasesAmbiguousInTransaction(input: Readonly<{
    paneId: ChatPaneProjection["id"];
    messageId: ChatMessageId;
    turnId: ChatTurnId;
    now: string;
  }>): void;
  releaseTurnLeasesInTransaction(input: Readonly<{
    paneId: ChatPaneProjection["id"];
    messageId: ChatMessageId;
    turnId: ChatTurnId;
    now: string;
  }>): void;
  restorePreparedDraftRefsInTransaction(input: Readonly<{
    paneId: ChatPaneProjection["id"];
    messageId: ChatMessageId;
    now: string;
  }>): boolean;
}

const attachmentRefRowSchema = z.object({
  attachment_id: chatMessageAttachmentIdSchema,
  state: z.enum([
    "creating",
    "receiving",
    "normalizing",
    "publishing",
    "ready",
    "corrupt",
    "deleting",
  ]),
}).strict();

const attachmentLeaseCountSchema = z.object({
  count: z.number().int().nonnegative().safe(),
}).strict();

const attachmentDraftLeaseRowSchema = z.object({
  expires_at: chatIsoDateTimeSchema,
}).strict();

const attachmentConsumedDraftRowSchema = z.object({
  attachment_id: chatMessageAttachmentIdSchema,
  consumed_draft_expires_at: chatIsoDateTimeSchema,
}).strict();

/** SQLite-backed ready/same-pane authority used until the upload vault owns it. */
export class SQLiteChatMessageAttachmentAuthority
  implements ChatMessageAttachmentAuthority
{
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  bindReadyMessageRefsInTransaction(input: Readonly<
    ChatMessageAttachmentReadinessInput & { messageId: ChatMessageId }
  >): void {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const messageId = chatMessageIdSchema.parse(input.messageId);
    const now = chatIsoDateTimeSchema.parse(input.now);
    const refs = this.#parseRefs(input.attachmentRefs);
    this.#bindRefs(paneId, messageId, refs, new Set(), now);
  }

  replaceReadyMessageRefsInTransaction(input: Readonly<
    ChatMessageAttachmentReadinessInput & { messageId: ChatMessageId }
  >): void {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const messageId = chatMessageIdSchema.parse(input.messageId);
    const now = chatIsoDateTimeSchema.parse(input.now);
    const refs = this.#parseRefs(input.attachmentRefs);
    const existing = this.#storedRefProvenance(paneId, messageId);
    this.#requireReady(paneId, refs);
    const draftLeases = this.#requireDraftLeases(
      paneId,
      refs.filter((attachmentId) => !existing.has(attachmentId)),
      now,
    );
    this.#database.query(`
      DELETE FROM chat_message_attachment_refs
      WHERE message_id = ?1 AND pane_id = ?2
    `).run(messageId, paneId);
    for (const [position, attachmentId] of refs.entries()) {
      const expiresAt = existing.get(attachmentId) ?? draftLeases.get(attachmentId);
      if (expiresAt === undefined) {
        throw new Error("chat message attachment lost its consumed draft lease");
      }
      this.#database.query(`
        INSERT INTO chat_message_attachment_refs (
          message_id, pane_id, position, attachment_id,
          consumed_draft_expires_at
        ) VALUES (?1, ?2, ?3, ?4, ?5)
      `).run(
        messageId,
        paneId,
        position,
        attachmentId,
        expiresAt,
      );
    }
    this.#consumeDraftLeases(paneId, draftLeases);
  }

  messageRefsInTransaction(input: Readonly<{
    paneId: ChatPaneProjection["id"];
    messageId: ChatMessageId;
  }>): readonly ChatMessageAttachmentId[] {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const messageId = chatMessageIdSchema.parse(input.messageId);
    const values: unknown[] = this.#database.query(`
      SELECT ref.attachment_id, attachment.state
      FROM chat_message_attachment_refs AS ref
      JOIN chat_attachments AS attachment
        ON attachment.attachment_id = ref.attachment_id
        AND attachment.pane_id = ref.pane_id
      WHERE ref.message_id = ?1 AND ref.pane_id = ?2
      ORDER BY ref.position
      LIMIT ?3
    `).all(messageId, paneId, runtimeChatMessageAttachmentLimit + 1);
    if (values.length > runtimeChatMessageAttachmentLimit) {
      throw new Error("stored chat message attachment reference limit exceeded");
    }
    const rows = values.map((value) => attachmentRefRowSchema.parse(value));
    if (rows.some(({ state }) => state !== "ready")) {
      throw new Error("stored chat message attachment is no longer ready");
    }
    return this.#parseRefs(rows.map(({ attachment_id }) => attachment_id));
  }

  acquireTurnLeasesInTransaction(input: Readonly<{
    paneId: ChatPaneProjection["id"];
    messageId: ChatMessageId;
    turnId: ChatTurnId;
    now: string;
  }>): void {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const messageId = chatMessageIdSchema.parse(input.messageId);
    const turnId = chatTurnIdSchema.parse(input.turnId);
    const now = chatIsoDateTimeSchema.parse(input.now);
    const refs = this.messageRefsInTransaction({ paneId, messageId });
    for (const attachmentId of refs) {
      const acquired = this.#database.query(`
        INSERT INTO chat_attachment_turn_leases (
          attachment_id, pane_id, message_id, turn_id,
          state, acquired_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?5)
        ON CONFLICT (attachment_id, message_id, turn_id) DO UPDATE SET
          state = 'active', acquired_at = excluded.acquired_at,
          updated_at = excluded.updated_at, released_at = NULL
        WHERE chat_attachment_turn_leases.state = 'released'
      `).run(attachmentId, paneId, messageId, turnId, now);
      if (acquired.changes !== 1) {
        throw new Error("chat attachment already has a live turn lease");
      }
    }
    this.#requireLeaseCount(paneId, messageId, turnId, refs.length, "active");
  }

  releasePreparedTurnLeasesInTransaction(input: Readonly<{
    paneId: ChatPaneProjection["id"];
    messageId: ChatMessageId;
    turnId: ChatTurnId;
    now: string;
  }>): void {
    this.#settleLeases(input, "active", "released");
  }

  markTurnLeasesAmbiguousInTransaction(input: Readonly<{
    paneId: ChatPaneProjection["id"];
    messageId: ChatMessageId;
    turnId: ChatTurnId;
    now: string;
  }>): void {
    this.#settleLeases(input, "active", "ambiguous");
  }

  releaseTurnLeasesInTransaction(input: Readonly<{
    paneId: ChatPaneProjection["id"];
    messageId: ChatMessageId;
    turnId: ChatTurnId;
    now: string;
  }>): void {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const messageId = chatMessageIdSchema.parse(input.messageId);
    const turnId = chatTurnIdSchema.parse(input.turnId);
    const now = chatIsoDateTimeSchema.parse(input.now);
    const expected = this.#messageRefCount(paneId, messageId);
    this.#database.query(`
      UPDATE chat_attachment_turn_leases SET
        state = 'released', released_at = ?4, updated_at = ?4
      WHERE pane_id = ?1 AND message_id = ?2 AND turn_id = ?3
        AND state IN ('active', 'ambiguous')
    `).run(paneId, messageId, turnId, now);
    this.#requireLeaseCount(paneId, messageId, turnId, expected, "released");
  }

  restorePreparedDraftRefsInTransaction(input: Readonly<{
    paneId: ChatPaneProjection["id"];
    messageId: ChatMessageId;
    now: string;
  }>): boolean {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const messageId = chatMessageIdSchema.parse(input.messageId);
    const now = chatIsoDateTimeSchema.parse(input.now);
    const provenance = this.#storedRefProvenance(paneId, messageId);
    const nowEpoch = Date.parse(now);
    let allRestored = true;
    for (const [attachmentId, expiresAt] of provenance) {
      if (Date.parse(expiresAt) <= nowEpoch) {
        allRestored = false;
        continue;
      }
      const restored = this.#database.query(`
        INSERT INTO chat_attachment_draft_leases (
          attachment_id, pane_id, expires_at, created_at
        ) VALUES (?1, ?2, ?3, ?4)
      `).run(attachmentId, paneId, expiresAt, now);
      if (restored.changes !== 1) {
        throw new Error("chat message attachment draft lease could not be restored");
      }
    }
    this.#database.query(`
      DELETE FROM chat_message_attachment_refs
      WHERE message_id = ?1 AND pane_id = ?2
    `).run(messageId, paneId);
    return allRestored;
  }

  #settleLeases(
    input: Readonly<{
      paneId: ChatPaneProjection["id"];
      messageId: ChatMessageId;
      turnId: ChatTurnId;
      now: string;
    }>,
    from: "active",
    to: "ambiguous" | "released",
  ): void {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const messageId = chatMessageIdSchema.parse(input.messageId);
    const turnId = chatTurnIdSchema.parse(input.turnId);
    const now = chatIsoDateTimeSchema.parse(input.now);
    const expected = this.#messageRefCount(paneId, messageId);
    this.#database.query(`
      UPDATE chat_attachment_turn_leases SET
        state = ?5,
        released_at = CASE WHEN ?5 = 'released' THEN ?4 ELSE NULL END,
        updated_at = ?4
      WHERE pane_id = ?1 AND message_id = ?2 AND turn_id = ?3
        AND state = ?6
    `).run(paneId, messageId, turnId, now, to, from);
    this.#requireLeaseCount(paneId, messageId, turnId, expected, to);
  }

  #requireLeaseCount(
    paneId: ChatPaneProjection["id"],
    messageId: ChatMessageId,
    turnId: ChatTurnId,
    expected: number,
    state: "active" | "ambiguous" | "released",
  ): void {
    const value: unknown = this.#database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_turn_leases
      WHERE pane_id = ?1 AND message_id = ?2 AND turn_id = ?3 AND state = ?4
    `).get(paneId, messageId, turnId, state);
    if (attachmentLeaseCountSchema.parse(value).count !== expected) {
      throw new Error("chat attachment turn lease set is incomplete");
    }
  }

  #requireReady(
    paneId: ChatPaneProjection["id"],
    refs: readonly ChatMessageAttachmentId[],
  ): void {
    for (const attachmentId of refs) {
      const value: unknown = this.#database.query(`
        SELECT attachment_id, state FROM chat_attachments
        WHERE attachment_id = ?1 AND pane_id = ?2
      `).get(attachmentId, paneId);
      const row = attachmentRefRowSchema.nullable().parse(value);
      if (row?.state !== "ready") {
        throw new Error("chat message attachment is not ready for this pane");
      }
    }
  }

  #bindRefs(
    paneId: ChatPaneProjection["id"],
    messageId: ChatMessageId,
    refs: readonly ChatMessageAttachmentId[],
    existing: ReadonlySet<ChatMessageAttachmentId>,
    now: string,
  ): void {
    this.#requireReady(paneId, refs);
    const draftLeases = this.#requireDraftLeases(
      paneId,
      refs.filter((attachmentId) => !existing.has(attachmentId)),
      now,
    );
    for (const [position, attachmentId] of refs.entries()) {
      const expiresAt = draftLeases.get(attachmentId);
      if (expiresAt === undefined) {
        throw new Error("chat message attachment lost its consumed draft lease");
      }
      this.#database.query(`
        INSERT INTO chat_message_attachment_refs (
          message_id, pane_id, position, attachment_id,
          consumed_draft_expires_at
        ) VALUES (?1, ?2, ?3, ?4, ?5)
      `).run(messageId, paneId, position, attachmentId, expiresAt);
    }
    this.#consumeDraftLeases(paneId, draftLeases);
  }

  #requireDraftLeases(
    paneId: ChatPaneProjection["id"],
    refs: readonly ChatMessageAttachmentId[],
    now: string,
  ): ReadonlyMap<ChatMessageAttachmentId, string> {
    const leases = new Map<ChatMessageAttachmentId, string>();
    const nowEpoch = Date.parse(now);
    for (const attachmentId of refs) {
      const value: unknown = this.#database.query(`
        SELECT expires_at FROM chat_attachment_draft_leases
        WHERE attachment_id = ?1 AND pane_id = ?2
      `).get(attachmentId, paneId);
      const lease = attachmentDraftLeaseRowSchema.nullable().parse(value);
      if (lease === null || Date.parse(lease.expires_at) <= nowEpoch) {
        throw new Error("chat message attachment lacks a live draft lease");
      }
      leases.set(attachmentId, lease.expires_at);
    }
    return leases;
  }

  #consumeDraftLeases(
    paneId: ChatPaneProjection["id"],
    leases: ReadonlyMap<ChatMessageAttachmentId, string>,
  ): void {
    for (const [attachmentId, expiresAt] of leases) {
      const consumed = this.#database.query(`
        DELETE FROM chat_attachment_draft_leases
        WHERE attachment_id = ?1 AND pane_id = ?2 AND expires_at = ?3
      `).run(attachmentId, paneId, expiresAt);
      if (consumed.changes !== 1) {
        throw new Error("chat message attachment draft lease changed concurrently");
      }
    }
  }

  #storedRefProvenance(
    paneId: ChatPaneProjection["id"],
    messageId: ChatMessageId,
  ): ReadonlyMap<ChatMessageAttachmentId, string> {
    const values: unknown[] = this.#database.query(`
      SELECT attachment_id, consumed_draft_expires_at
      FROM chat_message_attachment_refs
      WHERE message_id = ?1 AND pane_id = ?2
      ORDER BY position
      LIMIT ?3
    `).all(messageId, paneId, runtimeChatMessageAttachmentLimit + 1);
    if (values.length > runtimeChatMessageAttachmentLimit) {
      throw new Error("stored chat message attachment reference limit exceeded");
    }
    const rows = values.map((value) => attachmentConsumedDraftRowSchema.parse(value));
    const refs = this.#parseRefs(rows.map(({ attachment_id }) => attachment_id));
    return new Map(refs.map((attachmentId, index) => {
      const row = rows[index];
      if (row === undefined || row.attachment_id !== attachmentId) {
        throw new Error("chat message attachment provenance order drifted");
      }
      return [attachmentId, row.consumed_draft_expires_at] as const;
    }));
  }

  #messageRefCount(
    paneId: ChatPaneProjection["id"],
    messageId: ChatMessageId,
  ): number {
    const value: unknown = this.#database.query(`
      SELECT COUNT(*) AS count FROM chat_message_attachment_refs
      WHERE message_id = ?1 AND pane_id = ?2
    `).get(messageId, paneId);
    return attachmentLeaseCountSchema.parse(value).count;
  }

  #parseRefs(
    refs: readonly ChatMessageAttachmentId[],
  ): readonly ChatMessageAttachmentId[] {
    const schema = z
      .array(chatMessageAttachmentIdSchema)
      .max(runtimeChatMessageAttachmentLimit)
      .superRefine((values, context) => {
        if (new Set(values).size !== values.length) {
          context.addIssue({
            code: "custom",
            message: "chat message attachment references must be unique",
          });
        }
      });
    return schema.parse(refs);
  }
}

export interface ChatMessageEnqueueInput {
  readonly paneId: ChatPaneProjection["id"];
  readonly expectedQueueRevision: number;
  readonly messageId: ChatMessageId;
  readonly content: ChatMessageContent;
  readonly now: Date;
}

export interface ChatMessageEnqueueAndSteerInput extends ChatMessageEnqueueInput {
  readonly turnId: ChatTurnId;
}

export interface ChatMessageRowCasInput {
  readonly paneId: ChatPaneProjection["id"];
  readonly expectedQueueRevision: number;
  readonly messageId: ChatMessageId;
  readonly expectedMessageRevision: number;
  readonly now: Date;
}

export interface ChatMessageEditInput extends ChatMessageRowCasInput {
  readonly content: ChatMessageContent;
}

export interface ChatMessageClaimInput extends ChatMessageRowCasInput {
  readonly turnId: ChatTurnId;
  readonly kind: ChatMessageClaimKind;
}

export interface ChatMessageClaim {
  readonly messageId: ChatMessageId;
  readonly paneId: ChatPaneProjection["id"];
  readonly ordinal: number;
  readonly revision: number;
  readonly turnId: ChatTurnId;
  readonly kind: ChatMessageClaimKind;
  readonly content: ChatMessageContent;
}

export interface ChatMessageClaimResult {
  readonly claim: ChatMessageClaim;
  readonly queue: ChatMessageQueueProjection;
}

export type ChatMessageEnqueueAndSteerResult = ChatMessageClaimResult;

export interface ChatMessageTransitionInput {
  readonly paneId: ChatPaneProjection["id"];
  readonly messageId: ChatMessageId;
  readonly expectedMessageRevision: number;
  readonly turnId: ChatTurnId;
  readonly kind: ChatMessageClaimKind;
  readonly now: Date;
}

export interface ChatMessageQueueResumeInput {
  readonly paneId: ChatPaneProjection["id"];
  readonly expectedQueueRevision: number;
  readonly now: Date;
}

export type ChatMessageDiscardAmbiguousInput = ChatMessageRowCasInput;

export interface ChatMessageQueuePauseInput {
  readonly paneId: ChatPaneProjection["id"];
  readonly reason: Exclude<ChatMessageQueuePauseReason, "ambiguousEffect">;
  readonly now: Date;
}

export function parseChatMessageContent(
  value: unknown,
): ChatMessageContent {
  return chatMessageContentSchema.parse(value);
}

export function projectQueuePauseReason(
  value: ChatMessageQueueMetadataRow["message_queue_pause_reason"],
): ChatMessageQueuePauseReason | null {
  if (value === null) return null;
  return chatMessageQueuePauseReasonSchema.parse({
    stop: "stop",
    runtime_restart: "runtimeRestart",
    attention: "attention",
    ambiguous_effect: "ambiguousEffect",
  }[value]);
}

export function storeQueuePauseReason(
  value: ChatMessageQueuePauseReason,
): NonNullable<ChatMessageQueueMetadataRow["message_queue_pause_reason"]> {
  const values = {
    stop: "stop",
    runtimeRestart: "runtime_restart",
    attention: "attention",
    ambiguousEffect: "ambiguous_effect",
  } as const satisfies Record<
    ChatMessageQueuePauseReason,
    NonNullable<ChatMessageQueueMetadataRow["message_queue_pause_reason"]>
  >;
  return values[chatMessageQueuePauseReasonSchema.parse(value)];
}

export function parseChatMessageQueueProjection(
  value: unknown,
): ChatMessageQueueProjection {
  return chatMessageQueueProjectionSchema.parse(value);
}

export function isPayloadActiveState(state: StoredChatMessageState): boolean {
  return state !== "completed" && state !== "cancelled";
}
