import type { Database } from "bun:sqlite";
import { z } from "@hra-internal/schema";
import {
  accountProfileIdSchema,
  chatIsoDateTimeSchema,
  chatMessageAttachmentIdSchema,
  chatPaneInteractionModeSchema,
  chatPaneIdSchema,
  chatTurnIdSchema,
  runtimeChatPaneLimit,
  type ChatMessageAttachmentId,
  type ChatPaneProjection,
} from "../../../contracts/runtime";
import {
  CHAT_ATTACHMENT_DEFAULT_DRAFT_LEASE_MS,
  CHAT_ATTACHMENT_DEFAULT_GC_GRACE_MS,
  CHAT_ATTACHMENT_MAX_CHUNK_BYTES,
  CHAT_ATTACHMENT_MAX_DRAFTS_PER_PANE,
  CHAT_ATTACHMENT_MAX_GLOBAL_READY_BYTES,
  CHAT_ATTACHMENT_MAX_PANE_READY_BYTES,
  CHAT_ATTACHMENT_MAX_PROJECTED_PER_PANE,
  CHAT_ATTACHMENT_MAX_REFERENCED_PER_PANE,
  ChatAttachmentVaultError,
  type ChatAttachmentAppendInput,
  type ChatAttachmentBeginInput,
  type ChatAttachmentCancelInput,
  type ChatAttachmentFinalizeInput,
  type ChatAttachmentGarbageCollectionInput,
  type ChatAttachmentGarbageCollectionResult,
  type ChatAttachmentMetadata,
  type ChatAttachmentMutationResult,
  type ChatAttachmentPaneProjection,
  type ChatAttachmentPaneArchiveInput,
  type ChatAttachmentPreview,
  type ChatAttachmentPreviewInput,
  type ChatAttachmentPrivacyDeletionInput,
  type ChatAttachmentProjectionInput,
  type ChatAttachmentProviderAmbiguityInput,
  type ChatAttachmentProviderBindingMutationInput,
  type ChatAttachmentProviderDescriptor,
  type ChatAttachmentProviderLeaseInput,
  type ChatAttachmentProviderLeaseResult,
  type ChatAttachmentProviderReadInput,
  type ChatAttachmentReconciliationResult,
  type ChatAttachmentRemovalResult,
  type ChatAttachmentRemoveInput,
  type ChatAttachmentVault,
} from "./contracts";
import type {
  ChatImageNormalizer,
  NativeImageNormalizerReceipt,
} from "./normalizer";
import {
  digestBytes,
  digestOpaqueReceipt,
  exactBindingKeyDigest,
  internalSuffix,
  normalizeMediaType,
  parseAttachmentId,
  parseChunkOrdinal,
  parseExpectedBytes,
  parseKind,
  parseMessageId,
  parseNow,
  parsePaneId,
  parseProviderBindingId,
  parseRevision,
  parseSha256,
  parseUploadId,
  sanitizeDisplayName,
  strictBase64Chunk,
} from "./validation";
import {
  AttachmentVaultFileSystem,
  type VerifiedVaultFile,
} from "./vault-filesystem";

const attachmentStateSchema = z.enum([
  "creating",
  "receiving",
  "normalizing",
  "publishing",
  "ready",
  "corrupt",
  "deleting",
]);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const attachmentRowSchema = z.object({
  attachment_id: chatMessageAttachmentIdSchema,
  upload_id: z.string(),
  pane_id: chatPaneIdSchema,
  revision: z.number().int().positive().safe(),
  state: attachmentStateSchema,
  deletion_reason: z.enum([
    "cancelled",
    "removed",
    "archive",
    "gc",
    "privacy",
  ]).nullable(),
  kind: z.enum(["image", "file"]),
  display_name: z.string(),
  declared_media_type: z.string(),
  effective_media_type: z.string().nullable(),
  internal_suffix: z.string(),
  expected_input_bytes: z.number().int().positive().safe(),
  received_input_bytes: z.number().int().nonnegative().safe(),
  source_retained: z.union([z.literal(0), z.literal(1)]),
  next_chunk_ordinal: z.number().int().nonnegative().safe(),
  prepared_chunk_ordinal: z.number().int().nonnegative().safe().nullable(),
  prepared_offset: z.number().int().nonnegative().safe().nullable(),
  prepared_byte_length: z.number().int().positive().safe().nullable(),
  prepared_sha256: digestSchema.nullable(),
  finalize_request_revision: z.number().int().positive().safe().nullable(),
  requested_input_sha256: digestSchema.nullable(),
  input_sha256: digestSchema.nullable(),
  source_media_type: z.enum([
    "image/png",
    "image/jpeg",
    "image/heic",
    "image/webp",
  ]).nullable(),
  width: z.number().int().positive().safe().nullable(),
  height: z.number().int().positive().safe().nullable(),
  pixel_count: z.number().int().positive().safe().nullable(),
  canonical_bytes: z.number().int().positive().safe().nullable(),
  canonical_sha256: digestSchema.nullable(),
  preview_bytes: z.number().int().positive().safe().nullable(),
  preview_width: z.number().int().positive().max(320).nullable(),
  preview_height: z.number().int().positive().max(320).nullable(),
  preview_sha256: digestSchema.nullable(),
  provider_bytes: z.number().int().positive().safe().nullable(),
  provider_sha256: digestSchema.nullable(),
  ready_at: chatIsoDateTimeSchema.nullable(),
  created_at: chatIsoDateTimeSchema,
  updated_at: chatIsoDateTimeSchema,
}).strict();
type AttachmentRow = z.infer<typeof attachmentRowSchema>;

const chunkRowSchema = z.object({
  attachment_id: chatMessageAttachmentIdSchema,
  upload_id: z.string(),
  pane_id: chatPaneIdSchema,
  ordinal: z.number().int().nonnegative().safe(),
  request_revision: z.number().int().positive().safe(),
  byte_offset: z.number().int().nonnegative().safe(),
  byte_length: z.number().int().positive().safe(),
  sha256: digestSchema,
  state: z.enum(["prepared", "committed", "rolled_back"]),
  settled_revision: z.number().int().positive().safe().nullable(),
  created_at: chatIsoDateTimeSchema,
  settled_at: chatIsoDateTimeSchema.nullable(),
}).strict();
type ChunkRow = z.infer<typeof chunkRowSchema>;

const providerBindingRowSchema = z.object({
  binding_id: z.string(),
  binding_key_digest: digestSchema,
  pane_id: chatPaneIdSchema,
  revision: z.number().int().positive().safe(),
  state: z.enum(["active", "ambiguous", "released"]),
  ambiguity_receipt_digest: digestSchema.nullable(),
  containment_receipt_digest: digestSchema.nullable(),
  acquired_at: chatIsoDateTimeSchema,
  updated_at: chatIsoDateTimeSchema,
  released_at: chatIsoDateTimeSchema.nullable(),
}).strict();
type ProviderBindingRow = z.infer<typeof providerBindingRowSchema>;

const paneArchiveIntentRowSchema = z.object({
  pane_id: chatPaneIdSchema,
  containment_receipt_digest: digestSchema,
  state: z.enum(["prepared", "pane_archived", "completed"]),
  prepared_at: chatIsoDateTimeSchema,
  pane_archived_at: chatIsoDateTimeSchema.nullable(),
  completed_at: chatIsoDateTimeSchema.nullable(),
  updated_at: chatIsoDateTimeSchema,
}).strict();
type PaneArchiveIntentRow = z.infer<typeof paneArchiveIntentRowSchema>;

const privacyIntentRowSchema = z.object({
  pane_id: chatPaneIdSchema,
  authorization_receipt_digest: digestSchema,
  containment_receipt_digest: digestSchema,
  contained_at: chatIsoDateTimeSchema,
  updated_at: chatIsoDateTimeSchema,
}).strict();
type PrivacyIntentRow = z.infer<typeof privacyIntentRowSchema>;

const accountContainedProviderArchiveIntentRowSchema = z.object({
  generation_contained: z.literal(1),
  generation_containment_receipt: z.string().min(16).max(512),
}).strict();
type AccountContainedProviderArchiveIntentRow = z.infer<
  typeof accountContainedProviderArchiveIntentRowSchema
>;

const countRowSchema = z.object({
  count: z.number().int().nonnegative().safe(),
}).strict();
const paneIdRowSchema = z.object({
  pane_id: chatPaneIdSchema,
}).strict();
const providerThreadArchiveTargetIdSchemaV57 = z.string().min(18).max(96)
  .regex(/^archtarget_[A-Za-z0-9_-]+$/u);
const providerThreadArchiveCommittedTargetRowSchemaV57 = z.object({
  target_id: providerThreadArchiveTargetIdSchemaV57,
  pane_id: chatPaneIdSchema,
  purpose: z.enum(["start_fresh", "pane_archive"]),
  status: z.literal("committed"),
}).strict();
type ProviderThreadArchiveCommittedTargetRowV57 = z.infer<
  typeof providerThreadArchiveCommittedTargetRowSchemaV57
>;
const providerThreadArchivePaneArchivePostimageRowSchemaV57 = z.object({
  attachments: z.number().int().nonnegative().safe(),
  draft_leases: z.number().int().nonnegative().safe(),
  upload_chunks: z.number().int().nonnegative().safe(),
  message_refs: z.number().int().nonnegative().safe(),
  turn_leases: z.number().int().nonnegative().safe(),
  provider_bindings: z.number().int().nonnegative().safe(),
  provider_leases: z.number().int().nonnegative().safe(),
  storage_quarantines: z.number().int().nonnegative().safe(),
}).strict();
const providerThreadArchiveStartFreshPostimageRowSchemaV57 = z.object({
  retained_provider_bindings: z.number().int().nonnegative().safe(),
  retained_provider_leases: z.number().int().nonnegative().safe(),
  retained_turn_leases: z.number().int().nonnegative().safe(),
  prepared_chunks: z.number().int().nonnegative().safe(),
  storage_quarantines: z.number().int().nonnegative().safe(),
  archive_intents: z.number().int().nonnegative().safe(),
  privacy_intents: z.number().int().nonnegative().safe(),
}).strict();
const bytesRowSchema = z.object({
  bytes: z.number().int().nonnegative().safe(),
}).strict();
const paneLifecycleRowSchema = z.object({
  archived_at: chatIsoDateTimeSchema.nullable(),
}).strict();
const providerArchivePrivacyProviderIdSchema = z.string().min(1).max(512)
  .refine((value) => !value.includes("\0"), "provider identity contains NUL");
const providerArchivePrivacyPaneRowSchema = z.object({
  pane_id: chatPaneIdSchema,
  account_profile_id: accountProfileIdSchema.nullable(),
  provider_account_profile_id: accountProfileIdSchema.nullable(),
  provider_thread_id: providerArchivePrivacyProviderIdSchema.nullable(),
  provider_restart_thread_id: providerArchivePrivacyProviderIdSchema.nullable(),
  interaction_mode: chatPaneInteractionModeSchema,
  active_turn_id: chatTurnIdSchema.nullable(),
  active_provider_turn_id: providerArchivePrivacyProviderIdSchema.nullable(),
  visited_account_ids_json: z.string(),
}).strict();
type ProviderArchivePrivacyPaneRow = z.infer<
  typeof providerArchivePrivacyPaneRowSchema
>;
const providerArchivePrivacyCutRowSchema = z.object({
  cut_id: z.string().min(15).max(96).regex(/^archcut_[A-Za-z0-9_-]+$/u),
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
const providerArchivePrivacyRouteRowSchema = z.object({
  accepted_generation: z.number().int().positive().safe().nullable(),
  catalog_generation: z.number().int().positive().safe().nullable(),
  effect_started_at: chatIsoDateTimeSchema.nullable(),
}).strict();
const providerArchivePrivacyHarnessGenerationRowSchema = z.object({
  generation: z.number().int().positive().safe(),
}).strict();
const providerArchivePrivacyVisitedAccountsSchema = z.array(
  accountProfileIdSchema,
).max(runtimeChatPaneLimit).superRefine((values, context) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({
      code: "custom",
      message: "visited provider accounts must be unique",
    });
  }
});
export interface SQLiteChatAttachmentVaultOptions {
  readonly database: Database;
  readonly root: string;
  readonly normalizer: ChatImageNormalizer;
  /** Test-only observability seam after owned I/O and before its final authority fence. */
  readonly afterIoCheckpoint?: (
    checkpoint: ChatAttachmentIoCheckpoint,
  ) => Promise<void>;
}

export type ChatAttachmentIoCheckpoint =
  | "begin-created"
  | "chunk-written"
  | "finalize-verified"
  | "object-delete-authorized"
  | "object-delete-preflight"
  | "privacy-bytes-removed"
  | "preview-read"
  | "provider-verified"
  | "source-delete-authorized"
  | "source-verified";

export class SQLiteChatAttachmentVault implements ChatAttachmentVault {
  readonly #database: Database;
  readonly #filesystem: AttachmentVaultFileSystem;
  readonly #normalizer: ChatImageNormalizer;
  readonly #afterIoCheckpoint: (
    checkpoint: ChatAttachmentIoCheckpoint,
  ) => Promise<void>;
  #mutationTail: Promise<void> = Promise.resolve();
  #verifiedUploadDeletionPaneId: string | null = null;
  readonly #verifiedPaneArchiveCleanupV57 = new Set<string>();
  #authorizedProviderThreadArchiveCommittedTargetIdsV57:
    readonly string[] | null = null;

  constructor(options: SQLiteChatAttachmentVaultOptions) {
    this.#database = options.database;
    this.#normalizer = options.normalizer;
    this.#afterIoCheckpoint = options.afterIoCheckpoint ??
      (() => Promise.resolve());
    this.#filesystem = new AttachmentVaultFileSystem(options.root, {
      afterVerifiedUploadDigest: async () => {
        await this.#afterIoCheckpoint("source-verified");
        const paneId = this.#verifiedUploadDeletionPaneId;
        if (paneId === null) {
          throw invalidState("Attachment source cleanup lost its pane authority.");
        }
        this.#assertNoProviderThreadArchiveMutationAuthorityV57(paneId);
        await this.#afterIoCheckpoint("source-delete-authorized");
      },
    });
    // Fail at composition time if the additive vault migration is absent.
    const columns = this.#database.query<{ name: string }, []>(
      "SELECT name FROM pragma_table_info('chat_attachments')",
    ).all().map(({ name }) => name);
    if (!columns.includes("kind") || !columns.includes("provider_sha256")) {
      throw new Error("Attachment vault schema v2 is not installed.");
    }
  }

  beginUpload(
    input: ChatAttachmentBeginInput,
  ): Promise<ChatAttachmentMutationResult> {
    return this.#exclusive(async () => {
      const paneId = parsePaneId(input.paneId);
      const attachmentId = parseAttachmentId(input.attachmentId);
      const uploadId = parseUploadId(input.uploadId);
      const kind = parseKind(input.kind);
      const displayName = sanitizeDisplayName(input.displayName);
      const declaredMediaType = normalizeMediaType(input.declaredMediaType);
      const expectedBytes = parseExpectedBytes(input.expectedBytes);
      const now = parseNow(input.now);
      const nowIso = now.toISOString();
      const leaseMs = parseBoundedDuration(
        input.draftLeaseMs ?? CHAT_ATTACHMENT_DEFAULT_DRAFT_LEASE_MS,
        "Draft attachment lease",
      );
      const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
      const suffix = internalSuffix(kind, displayName);
      this.#requirePaneWritable(paneId);

      const existing = this.#rowByEitherIdentity(attachmentId, uploadId);
      if (existing !== null) {
        this.#assertSameBegin(existing, {
          paneId,
          attachmentId,
          uploadId,
          kind,
          displayName,
          declaredMediaType,
          expectedBytes,
          suffix,
        });
        if (existing.state === "creating") {
          return {
            attachment: await this.#resumeCreating(existing, nowIso),
            changed: true,
          };
        }
        return { attachment: metadata(existing), changed: false };
      }
      const deletion = this.#database.query<{ attachment_id: string }, [string, string]>(`
        SELECT attachment_id FROM chat_attachment_deletion_receipts
        WHERE attachment_id = ?1 OR upload_id = ?2
      `).get(attachmentId, uploadId);
      if (deletion !== null) {
        throw conflict("An attachment or upload ID cannot be reused.");
      }

      this.#database.transaction(() => {
        this.#requirePaneWritable(paneId);
        const drafts = countRowSchema.parse(this.#database.query(`
          SELECT COUNT(*) AS count
          FROM chat_attachment_draft_leases
          WHERE pane_id = ?1
        `).get(paneId));
        if (drafts.count >= CHAT_ATTACHMENT_MAX_DRAFTS_PER_PANE) {
          throw quota("This pane already has the maximum number of attachment drafts.");
        }
        this.#assertByteQuota(paneId, expectedBytes);
        this.#database.query(`
          INSERT INTO chat_attachments (
            attachment_id, upload_id, pane_id, revision, state, kind,
            display_name, declared_media_type, effective_media_type,
            internal_suffix, expected_input_bytes, received_input_bytes,
            source_retained, next_chunk_ordinal, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, 1, 'creating', ?4,
            ?5, ?6, NULL, ?7, ?8, 0, 1, 0, ?9, ?9
          )
        `).run(
          attachmentId,
          uploadId,
          paneId,
          kind,
          displayName,
          declaredMediaType,
          suffix,
          expectedBytes,
          nowIso,
        );
        this.#database.query(`
          INSERT INTO chat_attachment_draft_leases (
            attachment_id, pane_id, expires_at, created_at
          ) VALUES (?1, ?2, ?3, ?4)
        `).run(attachmentId, paneId, expiresAt, nowIso);
      })();

      try {
        return {
          attachment: await this.#resumeCreating(
            this.#requireRow(attachmentId),
            nowIso,
          ),
          changed: true,
        };
      } catch (error: unknown) {
        const paneError = this.#paneWriteFenceError(paneId);
        if (paneError !== null) throw paneError;
        this.#containCorrupt(attachmentId, nowIso);
        throw error;
      }
    });
  }

  appendChunk(
    input: ChatAttachmentAppendInput,
  ): Promise<ChatAttachmentMutationResult> {
    return this.#exclusive(async () => {
      const paneId = parsePaneId(input.paneId);
      const attachmentId = parseAttachmentId(input.attachmentId);
      const uploadId = parseUploadId(input.uploadId);
      const expectedRevision = parseRevision(input.expectedRevision);
      const ordinal = parseChunkOrdinal(input.chunkOrdinal);
      const bytes = strictBase64Chunk(input.base64);
      const digest = digestBytes(bytes);
      const nowIso = parseNow(input.now).toISOString();
      this.#requirePaneWritable(paneId);
      const replay = this.#chunk(attachmentId, ordinal, expectedRevision);
      if (replay !== null) {
        this.#assertSameChunk(replay, {
          paneId,
          uploadId,
          expectedRevision,
          digest,
          bytes: bytes.byteLength,
        });
        if (replay.state === "committed") {
          return { attachment: metadata(this.#requireRow(attachmentId)), changed: false };
        }
        if (replay.state === "rolled_back") {
          throw revisionConflict();
        }
        return {
          attachment: metadata(await this.#settlePreparedChunk(replay, bytes, nowIso)),
          changed: true,
        };
      }

      const prepared = this.#database.transaction(() => {
        this.#requirePaneWritable(paneId);
        const row = this.#requireRow(attachmentId);
        this.#assertRowAuthority(row, paneId, uploadId);
        if (row.state !== "receiving") {
          throw invalidState("Only a receiving attachment accepts chunks.");
        }
        if (row.revision !== expectedRevision) throw revisionConflict();
        if (row.next_chunk_ordinal !== ordinal || row.prepared_chunk_ordinal !== null) {
          throw conflict("Attachment chunks must arrive in exact ordinal order.");
        }
        if (this.#committedChunk(attachmentId, ordinal) !== null) {
          throw conflict("Attachment chunk ordinal is already committed.");
        }
        const remaining = row.expected_input_bytes - row.received_input_bytes;
        const requiredBytes = Math.min(CHAT_ATTACHMENT_MAX_CHUNK_BYTES, remaining);
        if (bytes.byteLength !== requiredBytes) {
          throw new ChatAttachmentVaultError(
            "invalid_input",
            "Every nonfinal attachment chunk must be exactly 512 KiB.",
          );
        }
        if (ordinal !== Math.floor(row.received_input_bytes / CHAT_ATTACHMENT_MAX_CHUNK_BYTES)) {
          throw conflict("Attachment chunk ordinal does not match its exact offset.");
        }
        this.#database.query(`
          INSERT INTO chat_attachment_upload_chunks (
            attachment_id, upload_id, pane_id, ordinal, request_revision,
            byte_offset, byte_length, sha256, state, created_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'prepared', ?9)
        `).run(
          attachmentId,
          uploadId,
          paneId,
          ordinal,
          expectedRevision,
          row.received_input_bytes,
          bytes.byteLength,
          digest,
          nowIso,
        );
        this.#database.query(`
          UPDATE chat_attachments
          SET prepared_chunk_ordinal = ?2,
              prepared_offset = received_input_bytes,
              prepared_byte_length = ?3,
              prepared_sha256 = ?4,
              revision = revision + 1,
              updated_at = ?5
          WHERE attachment_id = ?1
        `).run(attachmentId, ordinal, bytes.byteLength, digest, nowIso);
        return this.#requireChunk(attachmentId, ordinal, expectedRevision);
      })();
      try {
        return {
          attachment: metadata(await this.#settlePreparedChunk(prepared, bytes, nowIso)),
          changed: true,
        };
      } catch (error: unknown) {
        const paneError = this.#paneWriteFenceError(paneId);
        if (paneError !== null) throw paneError;
        this.#containCorrupt(attachmentId, nowIso);
        throw error;
      }
    });
  }

  finalizeUpload(
    input: ChatAttachmentFinalizeInput,
  ): Promise<ChatAttachmentMutationResult> {
    return this.#exclusive(async () => {
      const paneId = parsePaneId(input.paneId);
      const attachmentId = parseAttachmentId(input.attachmentId);
      const uploadId = parseUploadId(input.uploadId);
      const expectedRevision = parseRevision(input.expectedRevision);
      const inputSha256 = parseSha256(input.inputSha256, "Attachment input SHA-256");
      const nowIso = parseNow(input.now).toISOString();
      this.#requirePaneWritable(paneId);
      let row = this.#requireRow(attachmentId);
      this.#assertRowAuthority(row, paneId, uploadId);
      if (row.finalize_request_revision !== null) {
        if (
          row.finalize_request_revision !== expectedRevision ||
          row.requested_input_sha256 !== inputSha256
        ) {
          throw conflict("Attachment finalization input changed after admission.");
        }
        if (row.state === "ready") {
          let verified: AttachmentRow;
          try {
            verified = await this.#verifyReady(row, nowIso);
          } catch (error: unknown) {
            const paneError = this.#paneWriteFenceError(paneId);
            if (paneError !== null) throw paneError;
            this.#quarantineStorage(row, nowIso);
            this.#containCorrupt(attachmentId, nowIso);
            throw asCorrupt(error);
          }
          await this.#afterIoCheckpoint("finalize-verified");
          this.#requirePaneWritable(paneId);
          const current = this.#requireRow(attachmentId);
          if (current.state !== "ready" || current.revision !== verified.revision) {
            throw invalidState("Attachment changed during finalization replay.");
          }
          return {
            attachment: metadata(current),
            changed: verified.revision !== row.revision,
          };
        }
        if (row.state === "corrupt" || row.state === "deleting") {
          throw new ChatAttachmentVaultError(
            "corrupt",
            "Attachment finalization is already contained.",
          );
        }
      } else {
        if (row.state !== "receiving") {
          throw invalidState("Attachment is not ready to finalize.");
        }
        if (row.revision !== expectedRevision) throw revisionConflict();
        if (
          row.received_input_bytes !== row.expected_input_bytes ||
          row.prepared_chunk_ordinal !== null
        ) {
          throw invalidState("Attachment upload is incomplete.");
        }
        const completeChunks = countRowSchema.parse(this.#database.query(`
          SELECT COUNT(*) AS count FROM chat_attachment_upload_chunks
          WHERE attachment_id = ?1 AND state = 'committed'
        `).get(attachmentId));
        if (completeChunks.count !== row.next_chunk_ordinal) {
          throw invalidState("Attachment chunk receipts are incomplete.");
        }
        try {
          await this.#filesystem.verifyUpload(
            attachmentId,
            row.expected_input_bytes,
            inputSha256,
          );
        } catch (error: unknown) {
          this.#containCorrupt(attachmentId, nowIso);
          throw asCorrupt(error);
        }
        await this.#afterIoCheckpoint("finalize-verified");
        this.#assertStorageAdmissionSafe();
        this.#database.transaction(() => {
          this.#requirePaneWritable(paneId);
          const current = this.#requireRow(attachmentId);
          if (current.revision !== expectedRevision || current.state !== "receiving") {
            throw revisionConflict();
          }
          this.#database.query(`
            UPDATE chat_attachments
            SET state = ?2,
                finalize_request_revision = ?3,
                requested_input_sha256 = ?4,
                input_sha256 = ?4,
                revision = revision + 1,
                updated_at = ?5
            WHERE attachment_id = ?1
          `).run(
            attachmentId,
            current.kind === "image" ? "normalizing" : "publishing",
            expectedRevision,
            inputSha256,
            nowIso,
          );
        })();
        row = this.#requireRow(attachmentId);
      }

      try {
        const ready = await this.#resumeFinalization(row, nowIso);
        this.#requirePaneWritable(paneId);
        const current = this.#requireRow(attachmentId);
        if (current.state !== "ready" || current.revision !== ready.revision) {
          throw invalidState("Attachment changed before finalization returned.");
        }
        return { attachment: metadata(current), changed: true };
      } catch (error: unknown) {
        const paneError = this.#paneWriteFenceError(paneId);
        if (paneError !== null) throw paneError;
        this.#containCorrupt(attachmentId, nowIso);
        throw asCorrupt(error);
      }
    });
  }

  cancelUpload(
    input: ChatAttachmentCancelInput,
  ): Promise<ChatAttachmentRemovalResult> {
    return this.#exclusive(async () => {
      const paneId = parsePaneId(input.paneId);
      const attachmentId = parseAttachmentId(input.attachmentId);
      const uploadId = parseUploadId(input.uploadId);
      const expectedRevision = parseRevision(input.expectedRevision);
      const nowIso = parseNow(input.now).toISOString();
      const deleted = this.#deletionReceipt(attachmentId);
      if (deleted !== null) {
        if (deleted.upload_id !== uploadId || deleted.reason !== "cancelled") {
          throw conflict("Attachment cancellation identity changed.");
        }
        return { attachmentId, removed: true, changed: false };
      }
      const row = this.#requireRow(attachmentId);
      this.#assertRowAuthority(row, paneId, uploadId);
      if (row.revision !== expectedRevision) throw revisionConflict();
      if (row.state === "ready") {
        throw invalidState("A ready attachment must be removed, not cancelled.");
      }
      await this.#deleteAttachment(row, "cancelled", nowIso);
      return { attachmentId, removed: true, changed: true };
    });
  }

  removeAttachment(
    input: ChatAttachmentRemoveInput,
  ): Promise<ChatAttachmentRemovalResult> {
    return this.#exclusive(async () => {
      const paneId = parsePaneId(input.paneId);
      const attachmentId = parseAttachmentId(input.attachmentId);
      const expectedRevision = parseRevision(input.expectedRevision);
      const nowIso = parseNow(input.now).toISOString();
      const deleted = this.#deletionReceipt(attachmentId);
      if (deleted !== null) {
        if (deleted.reason !== "removed") {
          throw conflict("Attachment removal identity changed.");
        }
        return { attachmentId, removed: true, changed: false };
      }
      const row = this.#requireRow(attachmentId);
      this.#requirePaneWritable(paneId);
      if (row.pane_id !== paneId) throw notFound();
      if (row.revision !== expectedRevision) throw revisionConflict();
      if (row.state === "deleting") {
        throw invalidState("Attachment is not removable in its current state.");
      }
      await this.#deleteAttachment(row, "removed", nowIso);
      return { attachmentId, removed: true, changed: true };
    });
  }

  projectPane(input: ChatAttachmentProjectionInput): ChatAttachmentPaneProjection {
    const paneId = parsePaneId(input.paneId);
    const nowIso = parseNow(input.now).toISOString();
    this.#requirePaneReadable(paneId);
    const referencedIds = input.referencedAttachmentIds.map(parseAttachmentId);
    if (
      referencedIds.length > CHAT_ATTACHMENT_MAX_REFERENCED_PER_PANE ||
      new Set(referencedIds).size !== referencedIds.length
    ) {
      throw new ChatAttachmentVaultError(
        "invalid_input",
        "Pane attachment references exceed their bounded unique projection.",
      );
    }
    const drafts = this.#database.query(`
      SELECT attachment.*
      FROM chat_attachment_draft_leases AS draft
      JOIN chat_attachments AS attachment
        ON attachment.attachment_id = draft.attachment_id
       AND attachment.pane_id = draft.pane_id
      WHERE draft.pane_id = ?1
        AND draft.expires_at > ?2
        AND attachment.state != 'deleting'
      ORDER BY attachment.created_at, attachment.attachment_id
      LIMIT ?3
    `).all(paneId, nowIso, CHAT_ATTACHMENT_MAX_DRAFTS_PER_PANE + 1)
      .map((row) => metadata(attachmentRowSchema.parse(row)));
    if (drafts.length > CHAT_ATTACHMENT_MAX_DRAFTS_PER_PANE) {
      throw invalidState("Pane has too many live attachment drafts.");
    }
    const referenced = referencedIds.map((attachmentId) => {
      const row = this.#requireRow(attachmentId);
      if (row.pane_id !== paneId || row.state === "deleting") throw notFound();
      return metadata(row);
    });
    if (drafts.length + referenced.length > CHAT_ATTACHMENT_MAX_PROJECTED_PER_PANE) {
      throw invalidState("Pane attachment projection exceeds its legal bound.");
    }
    return { drafts, referenced };
  }

  readPreview(input: ChatAttachmentPreviewInput): Promise<ChatAttachmentPreview> {
    return this.#exclusive(async () => {
      const paneId = parsePaneId(input.paneId);
      const attachmentId = parseAttachmentId(input.attachmentId);
      const expectedRevision = parseRevision(input.expectedRevision);
      const nowIso = parseNow(input.now).toISOString();
      this.#requirePaneReadable(paneId);
      const relationship = input.relationship.kind === "draft"
        ? { kind: "draft" } as const
        : {
            kind: "message",
            messageId: parseMessageId(input.relationship.messageId),
          } as const;
      const requireRelationship = (): void => {
        const authorized = relationship.kind === "draft"
          ? countRowSchema.parse(this.#database.query(`
              SELECT COUNT(*) AS count
              FROM chat_attachment_draft_leases
              WHERE attachment_id = ?1 AND pane_id = ?2 AND expires_at > ?3
            `).get(attachmentId, paneId, nowIso)).count === 1
          : countRowSchema.parse(this.#database.query(`
              SELECT COUNT(*) AS count
              FROM chat_message_attachment_refs AS ref
              JOIN chat_message_ledger AS message
                ON message.message_id = ref.message_id
               AND message.pane_id = ref.pane_id
              WHERE ref.attachment_id = ?1
                AND ref.pane_id = ?2
                AND ref.message_id = ?3
                AND message.state NOT IN ('completed', 'cancelled')
                AND NOT (
                  message.state = 'ambiguous'
                  AND EXISTS (
                    SELECT 1 FROM chat_message_ambiguous_resolutions AS resolution
                    WHERE resolution.message_id = message.message_id
                      AND resolution.pane_id = message.pane_id
                  )
                )
            `).get(attachmentId, paneId, relationship.messageId)).count === 1;
        if (!authorized) throw notFound();
      };
      requireRelationship();
      const row = this.#requireRow(attachmentId);
      if (
        row.pane_id !== paneId ||
        row.revision !== expectedRevision ||
        row.state !== "ready" ||
        row.kind !== "image" ||
        row.preview_bytes === null ||
        row.preview_sha256 === null
      ) {
        throw notFound();
      }
      let bytes: Uint8Array;
      try {
        bytes = await this.#filesystem.readImagePreview(
          attachmentId,
          row.preview_bytes,
          row.preview_sha256,
        );
      } catch (error: unknown) {
        this.#containCorrupt(attachmentId, nowIso);
        throw asCorrupt(error);
      }
      await this.#afterIoCheckpoint("preview-read");
      this.#requirePaneReadable(paneId);
      requireRelationship();
      const current = this.#requireRow(attachmentId);
      if (
        current.pane_id !== row.pane_id ||
        current.revision !== row.revision ||
        current.state !== "ready" ||
        current.kind !== "image" ||
        current.preview_bytes !== row.preview_bytes ||
        current.preview_sha256 !== row.preview_sha256
      ) {
        throw notFound();
      }
      return {
        attachmentId,
        revision: current.revision,
        mediaType: "image/png",
        bytes,
      };
    });
  }

  acquireProviderLease(
    input: ChatAttachmentProviderLeaseInput,
  ): ChatAttachmentProviderLeaseResult {
    const bindingId = parseProviderBindingId(input.bindingId);
    const bindingKeyDigest = exactBindingKeyDigest(input.bindingKeyDigest);
    const paneId = parsePaneId(input.paneId);
    const nowIso = parseNow(input.now).toISOString();
    const attachmentIds = input.attachmentIds.map(parseAttachmentId);
    if (
      attachmentIds.length < 1 ||
      attachmentIds.length > 8 ||
      new Set(attachmentIds).size !== attachmentIds.length
    ) {
      throw new ChatAttachmentVaultError(
        "invalid_input",
        "A provider effect requires one to eight unique attachments.",
      );
    }
    return this.#database.transaction(() => {
      this.#requirePaneWritable(paneId);
      for (const attachmentId of attachmentIds) {
        const attachment = this.#requireRow(attachmentId);
        if (attachment.pane_id !== paneId || attachment.state !== "ready") {
          throw invalidState("Provider attachment is not ready in this pane.");
        }
      }
      let binding = this.#providerBinding(bindingId);
      let changed = false;
      if (binding === null) {
        this.#database.query(`
          INSERT INTO chat_provider_attachment_bindings (
            binding_id, binding_key_digest, pane_id, revision, state,
            acquired_at, updated_at
          ) VALUES (?1, ?2, ?3, 1, 'active', ?4, ?4)
        `).run(bindingId, bindingKeyDigest, paneId, nowIso);
        binding = this.#requireProviderBinding(bindingId);
        changed = true;
      } else {
        this.#assertBindingAuthority(binding, paneId, bindingKeyDigest);
        if (binding.state !== "active") {
          throw invalidState("Provider attachment binding is no longer active.");
        }
      }
      let added = 0;
      for (const attachmentId of attachmentIds) {
        const result = this.#database.query(`
          INSERT INTO chat_provider_attachment_leases (
            binding_id, pane_id, attachment_id, acquired_at
          ) VALUES (?1, ?2, ?3, ?4)
          ON CONFLICT (binding_id, attachment_id) DO NOTHING
        `).run(bindingId, paneId, attachmentId, nowIso);
        added += Number(result.changes);
      }
      if (added > 0 && !changed) {
        this.#database.query(`
          UPDATE chat_provider_attachment_bindings
          SET revision = revision + 1, updated_at = ?2
          WHERE binding_id = ?1
        `).run(bindingId, nowIso);
        changed = true;
      }
      const result = this.#requireProviderBinding(bindingId);
      return {
        bindingId,
        revision: result.revision,
        state: result.state,
        changed,
      };
    })();
  }

  readProviderBinding(input: Readonly<{
    readonly bindingId: string;
    readonly bindingKeyDigest: string;
    readonly paneId: string;
  }>): ChatAttachmentProviderLeaseResult | null {
    const bindingId = parseProviderBindingId(input.bindingId);
    const bindingKeyDigest = exactBindingKeyDigest(input.bindingKeyDigest);
    const paneId = parsePaneId(input.paneId);
    const binding = this.#providerBinding(bindingId);
    if (binding === null) return null;
    this.#assertBindingAuthority(binding, paneId, bindingKeyDigest);
    return providerResult(binding, false);
  }

  paneHasRetainedProviderBindings(paneIdValue: string): boolean {
    const paneId = parsePaneId(paneIdValue);
    const value: unknown = this.#database.query(`
      SELECT COUNT(*) AS count FROM chat_provider_attachment_bindings
      WHERE pane_id = ?1 AND state != 'released'
    `).get(paneId);
    return countRowSchema.parse(value).count > 0;
  }

  markProviderBindingAmbiguous(
    input: ChatAttachmentProviderAmbiguityInput,
  ): ChatAttachmentProviderLeaseResult {
    const bindingId = parseProviderBindingId(input.bindingId);
    const bindingKeyDigest = exactBindingKeyDigest(input.bindingKeyDigest);
    const paneId = parsePaneId(input.paneId);
    const expectedRevision = parseRevision(input.expectedRevision);
    const ambiguityDigest = digestOpaqueReceipt(
      input.ambiguityReceipt,
      "Provider ambiguity receipt",
    );
    const nowIso = parseNow(input.now).toISOString();
    return this.#database.transaction(() => {
      this.#assertNoProviderThreadArchiveMutationAuthorityV57(paneId);
      const binding = this.#requireProviderBinding(bindingId);
      this.#assertBindingAuthority(binding, paneId, bindingKeyDigest);
      if (
        binding.state === "ambiguous" &&
        binding.revision === expectedRevision + 1 &&
        binding.ambiguity_receipt_digest === ambiguityDigest
      ) {
        return providerResult(binding, false);
      }
      if (binding.revision !== expectedRevision) throw revisionConflict();
      if (binding.state !== "active") {
        throw invalidState("Only an active provider binding can become ambiguous.");
      }
      this.#database.query(`
        UPDATE chat_provider_attachment_bindings
        SET state = 'ambiguous',
            ambiguity_receipt_digest = ?2,
            revision = revision + 1,
            updated_at = ?3
        WHERE binding_id = ?1
      `).run(bindingId, ambiguityDigest, nowIso);
      return providerResult(this.#requireProviderBinding(bindingId), true);
    })();
  }

  releaseProviderBindingAfterResumeContained(
    input: ChatAttachmentProviderBindingMutationInput,
  ): ChatAttachmentProviderLeaseResult {
    return this.#database.transaction(() =>
      this.releaseProviderBindingAfterResumeContainedInTransaction(input)
    )();
  }

  releaseProviderBindingAfterResumeContainedInTransaction(
    input: ChatAttachmentProviderBindingMutationInput,
  ): ChatAttachmentProviderLeaseResult {
    const bindingId = parseProviderBindingId(input.bindingId);
    const bindingKeyDigest = exactBindingKeyDigest(input.bindingKeyDigest);
    const paneId = parsePaneId(input.paneId);
    const expectedRevision = parseRevision(input.expectedRevision);
    const containmentDigest = digestOpaqueReceipt(
      input.containmentReceipt,
      "Provider containment receipt",
    );
    const nowIso = parseNow(input.now).toISOString();
    const binding = this.#requireProviderBinding(bindingId);
    this.#assertBindingAuthority(binding, paneId, bindingKeyDigest);
    if (
      binding.state === "released" &&
      binding.revision === expectedRevision + 1 &&
      binding.containment_receipt_digest === containmentDigest
    ) {
      return providerResult(binding, false);
    }
    if (binding.revision !== expectedRevision) throw revisionConflict();
    if (binding.state === "released") {
      throw conflict("Provider binding containment receipt changed.");
    }
    this.#database.query(`
      UPDATE chat_provider_attachment_bindings
      SET state = 'released',
          containment_receipt_digest = ?2,
          revision = revision + 1,
          updated_at = ?3,
          released_at = ?3
      WHERE binding_id = ?1
    `).run(bindingId, containmentDigest, nowIso);
    return providerResult(this.#requireProviderBinding(bindingId), true);
  }

  providerDescriptor(
    input: ChatAttachmentProviderReadInput,
  ): Promise<ChatAttachmentProviderDescriptor> {
    return this.#exclusive(async () => {
      const bindingId = parseProviderBindingId(input.bindingId);
      const bindingKeyDigest = exactBindingKeyDigest(input.bindingKeyDigest);
      const paneId = parsePaneId(input.paneId);
      const attachmentId = parseAttachmentId(input.attachmentId);
      const nowIso = parseNow(input.now).toISOString();
      this.#requirePaneReadable(paneId);
      const binding = this.#requireProviderBinding(bindingId);
      this.#assertBindingAuthority(binding, paneId, bindingKeyDigest);
      if (binding.state !== "active") {
        throw invalidState("Provider attachment binding is not active.");
      }
      const lease = countRowSchema.parse(this.#database.query(`
        SELECT COUNT(*) AS count
        FROM chat_provider_attachment_leases
        WHERE binding_id = ?1 AND pane_id = ?2 AND attachment_id = ?3
      `).get(bindingId, paneId, attachmentId));
      if (lease.count !== 1) throw notFound();
      const row = this.#requireRow(attachmentId);
      if (
        row.pane_id !== paneId ||
        row.state !== "ready" ||
        row.provider_bytes === null ||
        row.provider_sha256 === null ||
        row.effective_media_type === null
      ) {
        throw invalidState("Provider attachment is not ready.");
      }
      let verified: VerifiedVaultFile;
      try {
        verified = row.kind === "image"
          ? await this.#filesystem.verifyImageCanonical(
              attachmentId,
              row.provider_bytes,
              row.provider_sha256,
            )
          : await this.#filesystem.verifyGeneric(
              attachmentId,
              row.internal_suffix,
              row.provider_bytes,
              row.provider_sha256,
            );
      } catch (error: unknown) {
        this.#containCorrupt(attachmentId, nowIso);
        throw asCorrupt(error);
      }
      await this.#afterIoCheckpoint("provider-verified");
      this.#requirePaneReadable(paneId);
      const currentBinding = this.#requireProviderBinding(bindingId);
      const currentLease = countRowSchema.parse(this.#database.query(`
        SELECT COUNT(*) AS count
        FROM chat_provider_attachment_leases
        WHERE binding_id = ?1 AND pane_id = ?2 AND attachment_id = ?3
      `).get(bindingId, paneId, attachmentId));
      if (
        currentBinding.state !== "active" ||
        currentBinding.revision !== binding.revision ||
        currentBinding.binding_key_digest !== binding.binding_key_digest ||
        currentLease.count !== 1
      ) {
        throw invalidState("Provider attachment lease changed during verification.");
      }
      const current = this.#requireRow(attachmentId);
      if (
        current.pane_id !== row.pane_id ||
        current.revision !== row.revision ||
        current.state !== "ready" ||
        current.provider_bytes !== row.provider_bytes ||
        current.provider_sha256 !== row.provider_sha256 ||
        current.effective_media_type !== row.effective_media_type
      ) {
        throw invalidState("Provider attachment changed during verification.");
      }
      return providerDescriptor(current, verified);
    });
  }

  reconcile(now: Date): Promise<ChatAttachmentReconciliationResult> {
    return this.#exclusive(async () => {
      const nowIso = parseNow(now).toISOString();
      const totals = {
        resumedChunks: 0,
        rolledBackChunks: 0,
        normalized: 0,
        published: 0,
        contained: 0,
        deleted: 0,
        residueRemoved: 0,
      };
      await this.#filesystem.assertRoots();
      const archiveIntents = this.#database.query(`
        SELECT * FROM chat_attachment_pane_archive_intents
        ORDER BY pane_id
      `).all().map((row) => paneArchiveIntentRowSchema.parse(row));
      for (const intent of archiveIntents) {
        const pane = this.#paneLifecycle(intent.pane_id);
        if (intent.state === "prepared") {
          if (pane.archived_at !== null) {
            throw invalidState("Archived pane has only a prepared attachment cleanup intent.");
          }
          continue;
        }
        if (intent.state === "pane_archived") {
          if (
            this.#providerThreadArchiveMutationFencedV57(intent.pane_id) &&
            !this.#providerThreadArchivePaneArchiveCleanupAuthorizedV57(
              intent.pane_id,
            )
          ) {
            continue;
          }
          totals.deleted += await this.#completePaneArchiveIntent(intent, nowIso);
        }
      }
      const privacyIntents = this.#database.query(`
        SELECT * FROM chat_attachment_privacy_deletion_intents
        ORDER BY pane_id
      `).all().map((row) => privacyIntentRowSchema.parse(row));
      for (const intent of privacyIntents) {
        if (this.#providerThreadArchivePrivacyFencedV57(intent.pane_id)) {
          continue;
        }
        totals.deleted += await this.#completePrivacyDeletionIntent(intent, nowIso);
      }
      this.#revokeTerminalMessageRefs();
      const rows = this.#database.query(`
        SELECT * FROM chat_attachments
        ORDER BY created_at, attachment_id
      `).all().map((row) => attachmentRowSchema.parse(row));
      const databaseObjectIds = new Set(rows.map((row) => row.attachment_id));
      for (const objectId of await this.#filesystem.listObjectIds()) {
        if (!databaseObjectIds.has(objectId)) {
          throw new ChatAttachmentVaultError(
            "unsafe_filesystem",
            "Attachment vault contains an object without durable custody.",
          );
        }
      }
      for (const original of rows) {
        let row = this.#row(original.attachment_id);
        if (row === null) continue;
        if (this.#providerThreadArchiveMutationFencedV57(row.pane_id)) {
          continue;
        }
        try {
          if (
            row.kind === "image" &&
            (row.state === "normalizing" || row.state === "corrupt")
          ) {
            try {
              this.#assertNoProviderThreadArchiveMutationAuthorityV57(
                row.pane_id,
              );
              totals.residueRemoved += await this.#filesystem.removeNormalizerResidue(
                row.attachment_id,
              );
              this.#assertNoProviderThreadArchiveMutationAuthorityV57(
                row.pane_id,
              );
            } catch (error: unknown) {
              this.#quarantineStorage(row, nowIso);
              throw error;
            }
          }
          if (row.state === "creating") {
            await this.#resumeCreating(row, nowIso);
            row = this.#requireRow(row.attachment_id);
          }
          if (row.state === "receiving" && row.prepared_chunk_ordinal !== null) {
            const chunk = this.#requirePreparedChunk(
              row.attachment_id,
              row.prepared_chunk_ordinal,
            );
            const outcome = await this.#settlePreparedChunkFromDisk(chunk, nowIso);
            if (outcome === "committed") totals.resumedChunks += 1;
            else totals.rolledBackChunks += 1;
            row = this.#requireRow(row.attachment_id);
          }
          if (row.state === "normalizing" || row.state === "publishing") {
            const before = row.state;
            row = await this.#resumeFinalization(row, nowIso);
            if (before === "normalizing") totals.normalized += 1;
            totals.published += 1;
          }
          if (row.state === "ready") {
            row = await this.#verifyReady(row, nowIso);
          }
          if (row.state === "deleting") {
            await this.#completeDeletion(row, nowIso);
            totals.deleted += 1;
            continue;
          }
          try {
            await this.#assertDurableInventory(row);
          } catch (error: unknown) {
            this.#quarantineStorage(row, nowIso);
            throw error;
          }
        } catch (error: unknown) {
          if (this.#providerThreadArchiveMutationFencedV57(original.pane_id)) {
            continue;
          }
          const current = this.#row(original.attachment_id);
          if (
            current !== null && current.state === "normalizing" &&
            current.provider_bytes === null
          ) {
            this.#quarantineStorage(current, nowIso);
          }
          if (current !== null && current.state === "ready") {
            this.#quarantineStorage(current, nowIso);
          }
          if (current !== null && current.state === "corrupt") throw error;
          if (current !== null && current.state !== "deleting") {
            this.#containCorrupt(current.attachment_id, nowIso);
            totals.contained += 1;
          } else if (current !== null) {
            throw error;
          }
        }
      }
      return totals;
    });
  }

  collectGarbage(
    input: ChatAttachmentGarbageCollectionInput,
  ): Promise<ChatAttachmentGarbageCollectionResult> {
    return this.#exclusive(async () => {
      const now = parseNow(input.now);
      const graceMs = parseBoundedDuration(
        input.graceMs ?? CHAT_ATTACHMENT_DEFAULT_GC_GRACE_MS,
        "Attachment garbage-collection grace",
      );
      const maximumDeletes = input.maximumDeletes ?? 16;
      if (!Number.isSafeInteger(maximumDeletes) || maximumDeletes < 1 || maximumDeletes > 64) {
        throw new ChatAttachmentVaultError(
          "invalid_input",
          "Attachment garbage-collection batch is invalid.",
        );
      }
      const nowIso = now.toISOString();
      const cutoffIso = new Date(now.getTime() - graceMs).toISOString();
      this.#revokeTerminalMessageRefs();
      const candidates = this.#database.query(`
        SELECT attachment.*
        FROM chat_attachments AS attachment
        LEFT JOIN chat_attachment_draft_leases AS draft
          ON draft.attachment_id = attachment.attachment_id
        WHERE attachment.state IN (
          'creating', 'receiving', 'ready', 'corrupt', 'deleting'
        )
          AND attachment.updated_at <= ?1
          AND (draft.attachment_id IS NULL OR draft.expires_at <= ?1)
          AND NOT EXISTS (
            SELECT 1 FROM chat_message_attachment_refs AS ref
            WHERE ref.attachment_id = attachment.attachment_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM chat_attachment_turn_leases AS turn_lease
            WHERE turn_lease.attachment_id = attachment.attachment_id
              AND turn_lease.state != 'released'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM chat_provider_attachment_leases AS provider_lease
            JOIN chat_provider_attachment_bindings AS binding
              ON binding.binding_id = provider_lease.binding_id
            WHERE provider_lease.attachment_id = attachment.attachment_id
              AND binding.state != 'released'
          )
        ORDER BY attachment.updated_at, attachment.attachment_id
        LIMIT ?2
      `).all(cutoffIso, maximumDeletes)
        .map((row) => attachmentRowSchema.parse(row));
      let deleted = 0;
      let contained = 0;
      for (const row of candidates) {
        if (this.#providerThreadArchiveMutationFencedV57(row.pane_id)) {
          continue;
        }
        try {
          await this.#deleteAttachment(row, "gc", nowIso, true);
          deleted += 1;
        } catch {
          if (this.#providerThreadArchiveMutationFencedV57(row.pane_id)) {
            continue;
          }
          const current = this.#row(row.attachment_id);
          if (current !== null && current.state !== "deleting") {
            try {
              this.#containCorrupt(row.attachment_id, nowIso);
            } catch (error: unknown) {
              if (this.#providerThreadArchiveMutationFencedV57(row.pane_id)) {
                continue;
              }
              throw error;
            }
          }
          contained += 1;
        }
      }
      return { deleted, contained };
    });
  }

  assertPaneArchiveCompatible(paneIdValue: ChatPaneProjection["id"]): void {
    const paneId = parsePaneId(paneIdValue);
    const pane = this.#paneLifecycle(paneId);
    if (pane.archived_at !== null) {
      throw invalidState("Only a live pane can prepare attachment archive cleanup.");
    }
    if (this.#privacyIntent(paneId) !== null) {
      throw invalidState("Pane privacy deletion already owns attachment cleanup.");
    }
    this.#assertNoActiveNonArchiveDeletionCut(paneId);
    // A completed privacy tombstone proves this namespace is already clean.
    // Pane archive may proceed as a no-op at every vault lifecycle cut.
  }

  assertProviderThreadArchiveV57Compatible(
    paneIdValue: ChatPaneProjection["id"],
  ): void {
    const paneId = parsePaneId(paneIdValue);
    this.assertPaneArchiveCompatible(paneId);
    this.#assertNoProviderThreadArchiveAttachmentMutationCutV57(paneId);
  }

  preparePaneArchiveInTransaction(input: ChatAttachmentPaneArchiveInput): void {
    const paneId = parsePaneId(input.paneId);
    const nowIso = parseNow(input.now).toISOString();
    const containmentDigest = digestOpaqueReceipt(
      input.containmentReceipt,
      "Pane archive containment receipt",
    );
    const pane = this.#paneLifecycle(paneId);
    if (pane.archived_at !== null) {
      throw invalidState("Only a live pane can prepare attachment archive cleanup.");
    }
    if (this.#privacyIntent(paneId) !== null) {
      throw invalidState("Pane privacy deletion already owns attachment cleanup.");
    }
    this.#assertNoActiveNonArchiveDeletionCut(paneId);
    if (this.#hasPrivacyTombstone(paneId)) return;
    const existing = this.#paneArchiveIntent(paneId);
    if (existing !== null) {
      if (
        existing.containment_receipt_digest !== containmentDigest ||
        existing.prepared_at !== nowIso
      ) {
        throw conflict("Pane archive attachment intent changed.");
      }
      return;
    }
    this.#database.query(`
      INSERT INTO chat_attachment_pane_archive_intents (
        pane_id, containment_receipt_digest, state,
        prepared_at, pane_archived_at, completed_at, updated_at
      ) VALUES (?1, ?2, 'prepared', ?3, NULL, NULL, ?3)
    `).run(paneId, containmentDigest, nowIso);
  }

  markPaneArchivedInTransaction(input: ChatAttachmentPaneArchiveInput): void {
    const paneId = parsePaneId(input.paneId);
    const nowIso = parseNow(input.now).toISOString();
    const containmentDigest = digestOpaqueReceipt(
      input.containmentReceipt,
      "Pane archive containment receipt",
    );
    const pane = this.#paneLifecycle(paneId);
    if (pane.archived_at === null) {
      throw invalidState("Pane archive cleanup cannot advance before pane archive.");
    }
    this.#assertNoActiveNonArchiveDeletionCut(paneId);
    if (this.#hasPrivacyTombstone(paneId)) return;
    const intent = this.#requirePaneArchiveIntent(paneId);
    if (
      intent.containment_receipt_digest !== containmentDigest ||
      intent.prepared_at !== nowIso
    ) {
      throw conflict("Pane archive attachment intent changed.");
    }
    if (intent.state === "pane_archived" || intent.state === "completed") {
      this.#verifiedPaneArchiveCleanupV57.add(paneId);
      return;
    }
    this.#database.query(`
      UPDATE chat_attachment_pane_archive_intents
      SET state = 'pane_archived', pane_archived_at = ?2, updated_at = ?2
      WHERE pane_id = ?1 AND state = 'prepared'
    `).run(paneId, nowIso);
    this.#verifiedPaneArchiveCleanupV57.add(paneId);
  }

  /**
   * Restores the in-memory archive cleanup capability only after ChatPaneStore
   * has authenticated every surviving v57 target with its Store-owned HMACs.
   * Startup must call this after terminal verification and before reconcile.
   */
  authorizeProviderThreadArchivePaneCleanupAfterStoreVerificationV57(
    expectedCommittedTargetIds: readonly string[],
  ): void {
    const expected = parseCanonicalProviderThreadArchiveTargetIdsV57(
      expectedCommittedTargetIds,
    );
    const committed = this.#providerThreadArchiveCommittedTargetsV57();
    this.#assertExactProviderThreadArchiveCommittedTargetIdsV57(
      expected,
      committed,
    );
    const authorized =
      this.#authorizedProviderThreadArchiveCommittedTargetIdsV57;
    if (
      authorized !== null &&
      !canonicalStringArraysEqualV57(authorized, expected)
    ) {
      throw invalidState(
        "Provider thread archive terminal authorization snapshot changed.",
      );
    }

    const cleanupPaneIds: string[] = [];
    for (const target of committed) {
      if (target.purpose !== "pane_archive") continue;
      if (this.#hasPrivacyTombstone(target.pane_id)) {
        this.#assertProviderThreadArchivePaneArchiveTargetStructureV57(
          target.pane_id,
        );
        cleanupPaneIds.push(target.pane_id);
        continue;
      }
      this.#assertProviderThreadArchivePaneArchiveCleanupStructureV57(
        target.pane_id,
        true,
      );
      if (this.#requirePaneArchiveIntent(target.pane_id).state === "pane_archived") {
        cleanupPaneIds.push(target.pane_id);
      }
    }
    this.#authorizedProviderThreadArchiveCommittedTargetIdsV57 = expected;
    for (const paneId of cleanupPaneIds) {
      this.#verifiedPaneArchiveCleanupV57.add(paneId);
    }
  }

  assertProviderThreadArchiveTerminalPostimagesV57(
    expectedCommittedTargetIds: readonly string[],
  ): void {
    const expected = parseCanonicalProviderThreadArchiveTargetIdsV57(
      expectedCommittedTargetIds,
    );
    const authorized =
      this.#authorizedProviderThreadArchiveCommittedTargetIdsV57;
    if (
      authorized === null ||
      !canonicalStringArraysEqualV57(authorized, expected)
    ) {
      throw invalidState(
        "Provider thread archive terminal postimages lack their exact authorized snapshot.",
      );
    }
    const committed = this.#providerThreadArchiveCommittedTargetsV57();
    this.#assertExactProviderThreadArchiveCommittedTargetIdsV57(
      expected,
      committed,
    );
    for (const target of committed) {
      if (target.purpose === "pane_archive") {
        this.#assertProviderThreadArchivePaneArchiveTerminalPostimageV57(
          target.pane_id,
        );
      } else {
        this.#assertProviderThreadArchiveStartFreshTerminalPostimageV57(
          target.pane_id,
        );
      }
    }
  }

  archivePaneAfterResumeContained(
    input: ChatAttachmentPaneArchiveInput,
  ): Promise<void> {
    return this.#exclusive(async () => {
      const paneId = parsePaneId(input.paneId);
      const nowIso = parseNow(input.now).toISOString();
      const containmentDigest = digestOpaqueReceipt(
        input.containmentReceipt,
        "Pane archive containment receipt",
      );
      if (this.#hasPrivacyTombstone(paneId)) return;
      const intent = this.#requirePaneArchiveIntent(paneId);
      if (intent.containment_receipt_digest !== containmentDigest) {
        throw conflict("Pane archive containment receipt changed.");
      }
      await this.#completePaneArchiveIntent(intent, nowIso);
    });
  }

  deletePanePrivateData(
    input: ChatAttachmentPrivacyDeletionInput,
  ): Promise<void> {
    return this.#exclusive(async () => {
      const paneId = parsePaneId(input.paneId);
      const nowIso = parseNow(input.now).toISOString();
      const authorizationDigest = digestOpaqueReceipt(
        input.authorizationReceipt,
        "Attachment privacy-deletion authorization",
      );
      const containmentDigest = digestOpaqueReceipt(
        input.containmentReceipt,
        "Attachment privacy-deletion containment receipt",
      );
      if (authorizationDigest === containmentDigest) {
        throw new ChatAttachmentVaultError(
          "invalid_input",
          "Privacy deletion authorization and containment require distinct receipts.",
        );
      }
      if (this.#hasPrivacyTombstone(paneId)) {
        this.#database.transaction(() => {
          this.#assertNoProviderThreadArchiveAuthorityV57(paneId);
          const pendingProviderArchive = countRowSchema.parse(
            this.#database.query(`
              SELECT COUNT(*) AS count
              FROM chat_provider_thread_archive_intents
              WHERE pane_id = ?1 AND state != 'account_contained'
            `).get(paneId),
          ).count;
          if (pendingProviderArchive > 0) {
            throw invalidState(
              "Provider thread archive already owns pane containment.",
            );
          }
          const accountContainedProviderArchive =
            this.#assertExactAccountContainedProviderArchiveIntent(
              paneId,
              containmentDigest,
            );
          if (accountContainedProviderArchive !== null) {
            const consumed = this.#database.query(`
              DELETE FROM chat_provider_thread_archive_intents
              WHERE pane_id = ?1 AND state = 'account_contained'
                AND generation_contained = 1
                AND generation_containment_receipt = ?2
            `).run(
              paneId,
              accountContainedProviderArchive.generation_containment_receipt,
            );
            if (consumed.changes !== 1) {
              throw conflict("Provider account-containment authority changed.");
            }
          }
        })();
        return;
      }
      this.#database.transaction(() => {
        this.#assertNoProviderThreadArchiveAuthorityV57(paneId);
        const pendingProviderArchive = countRowSchema.parse(this.#database.query(`
          SELECT COUNT(*) AS count
          FROM chat_provider_thread_archive_intents
          WHERE pane_id = ?1 AND state != 'account_contained'
        `).get(paneId)).count;
        if (pendingProviderArchive > 0) {
          throw invalidState("Provider thread archive already owns pane containment.");
        }
        this.#assertExactAccountContainedProviderArchiveIntent(
          paneId,
          containmentDigest,
        );
        const archiveIntent = this.#paneArchiveIntent(paneId);
        if (archiveIntent !== null && archiveIntent.state !== "completed") {
          throw invalidState("Pane archive already owns attachment cleanup.");
        }
        const existing = this.#privacyIntent(paneId);
        if (existing !== null) {
          if (
            existing.authorization_receipt_digest !== authorizationDigest ||
            existing.containment_receipt_digest !== containmentDigest
          ) {
            throw conflict("Attachment privacy-deletion authorization changed.");
          }
          return;
        }
        this.#database.query(`
          INSERT INTO chat_attachment_privacy_deletion_intents (
            pane_id, authorization_receipt_digest,
            containment_receipt_digest, contained_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, ?4)
        `).run(paneId, authorizationDigest, containmentDigest, nowIso);
        this.#releasePaneBindings(paneId, containmentDigest, nowIso);
        this.#database.query(`
          DELETE FROM chat_attachment_turn_leases WHERE pane_id = ?1
        `).run(paneId);
        this.#database.query(`
          DELETE FROM chat_message_attachment_refs WHERE pane_id = ?1
        `).run(paneId);
        this.#database.query(`
          DELETE FROM chat_attachment_draft_leases WHERE pane_id = ?1
        `).run(paneId);
        const current = this.#database.query(`
          SELECT * FROM chat_attachments
          WHERE pane_id = ?1
          ORDER BY created_at, attachment_id
        `).all(paneId).map((row) => attachmentRowSchema.parse(row));
        for (const row of current) {
          if (row.state !== "deleting") {
            this.#database.query(`
              UPDATE chat_attachments
              SET state = 'deleting', deletion_reason = 'privacy',
                  revision = revision + 1, updated_at = ?2
              WHERE attachment_id = ?1
            `).run(row.attachment_id, nowIso);
          }
        }
      })();
      await this.#completePrivacyDeletionIntent(
        this.#requirePrivacyIntent(paneId),
        nowIso,
      );
    });
  }

  async #resumeCreating(
    row: AttachmentRow,
    nowIso: string,
  ): Promise<ChatAttachmentMetadata> {
    this.#requirePaneWritable(row.pane_id);
    await this.#filesystem.createUploadObject(row.attachment_id);
    await this.#afterIoCheckpoint("begin-created");
    return this.#database.transaction(() => {
      this.#requirePaneWritable(row.pane_id);
      const current = this.#requireRow(row.attachment_id);
      if (current.state === "receiving") return metadata(current);
      if (current.state !== "creating" || current.revision !== row.revision) {
        throw invalidState("Attachment creation cannot be resumed.");
      }
      this.#database.query(`
        UPDATE chat_attachments
        SET state = 'receiving', revision = revision + 1, updated_at = ?2
        WHERE attachment_id = ?1
      `).run(row.attachment_id, nowIso);
      return metadata(this.#requireRow(row.attachment_id));
    })();
  }

  async #settlePreparedChunk(
    chunk: ChunkRow,
    bytes: Uint8Array,
    nowIso: string,
  ): Promise<AttachmentRow> {
    if (digestBytes(bytes) !== chunk.sha256 || bytes.byteLength !== chunk.byte_length) {
      throw conflict("Prepared attachment chunk bytes changed.");
    }
    const currentSize = await this.#filesystem.uploadSize(chunk.attachment_id);
    if (currentSize === chunk.byte_offset) {
      await this.#filesystem.appendChunk(
        chunk.attachment_id,
        chunk.byte_offset,
        bytes,
      );
    } else if (currentSize === chunk.byte_offset + chunk.byte_length) {
      const exact = await this.#filesystem.verifyRange(
        chunk.attachment_id,
        chunk.byte_offset,
        chunk.byte_length,
        chunk.sha256,
      );
      if (!exact) throw new ChatAttachmentVaultError("corrupt", "Prepared chunk differs on disk.");
    } else {
      throw new ChatAttachmentVaultError(
        "corrupt",
        "Prepared attachment chunk has a partial or excess write.",
      );
    }
    await this.#afterIoCheckpoint("chunk-written");
    return this.#commitPreparedChunk(chunk, nowIso);
  }

  async #settlePreparedChunkFromDisk(
    chunk: ChunkRow,
    nowIso: string,
  ): Promise<"committed" | "rolled_back"> {
    const currentSize = await this.#filesystem.uploadSize(chunk.attachment_id);
    if (currentSize === chunk.byte_offset) {
      this.#rollbackPreparedChunk(chunk, nowIso);
      return "rolled_back";
    }
    if (currentSize !== chunk.byte_offset + chunk.byte_length) {
      throw new ChatAttachmentVaultError(
        "corrupt",
        "Prepared attachment chunk has a partial or excess write.",
      );
    }
    const exact = await this.#filesystem.verifyRange(
      chunk.attachment_id,
      chunk.byte_offset,
      chunk.byte_length,
      chunk.sha256,
    );
    if (!exact) throw new ChatAttachmentVaultError("corrupt", "Prepared chunk differs on disk.");
    this.#commitPreparedChunk(chunk, nowIso);
    return "committed";
  }

  #rollbackPreparedChunk(chunk: ChunkRow, nowIso: string): AttachmentRow {
    return this.#database.transaction(() => {
      this.#assertNoProviderThreadArchiveMutationAuthorityV57(chunk.pane_id);
      const currentChunk = this.#requireChunk(
        chunk.attachment_id,
        chunk.ordinal,
        chunk.request_revision,
      );
      if (currentChunk.state === "rolled_back") {
        return this.#requireRow(chunk.attachment_id);
      }
      if (currentChunk.state !== "prepared") {
        throw invalidState("Attachment chunk is not rollback eligible.");
      }
      const row = this.#requireRow(chunk.attachment_id);
      if (
        row.state !== "receiving" ||
        row.prepared_chunk_ordinal !== chunk.ordinal ||
        row.prepared_offset !== chunk.byte_offset ||
        row.prepared_byte_length !== chunk.byte_length ||
        row.prepared_sha256 !== chunk.sha256 ||
        row.revision !== chunk.request_revision + 1
      ) {
        throw invalidState("Prepared attachment rollback lost its exact fence.");
      }
      const settledRevision = row.revision + 1;
      this.#database.query(`
        UPDATE chat_attachments
        SET prepared_chunk_ordinal = NULL,
            prepared_offset = NULL,
            prepared_byte_length = NULL,
            prepared_sha256 = NULL,
            revision = ?2,
            updated_at = ?3
        WHERE attachment_id = ?1
      `).run(chunk.attachment_id, settledRevision, nowIso);
      this.#database.query(`
        UPDATE chat_attachment_upload_chunks
        SET state = 'rolled_back', settled_revision = ?4, settled_at = ?5
        WHERE attachment_id = ?1 AND ordinal = ?2 AND request_revision = ?3
      `).run(
        chunk.attachment_id,
        chunk.ordinal,
        chunk.request_revision,
        settledRevision,
        nowIso,
      );
      return this.#requireRow(chunk.attachment_id);
    })();
  }

  #commitPreparedChunk(chunk: ChunkRow, nowIso: string): AttachmentRow {
    return this.#database.transaction(() => {
      this.#requirePaneWritable(chunk.pane_id);
      const currentChunk = this.#requireChunk(
        chunk.attachment_id,
        chunk.ordinal,
        chunk.request_revision,
      );
      if (currentChunk.state === "committed") return this.#requireRow(chunk.attachment_id);
      if (
        currentChunk.sha256 !== chunk.sha256 ||
        currentChunk.byte_offset !== chunk.byte_offset ||
        currentChunk.byte_length !== chunk.byte_length
      ) {
        throw conflict("Prepared attachment chunk receipt changed.");
      }
      const row = this.#requireRow(chunk.attachment_id);
      if (
        row.state !== "receiving" ||
        row.prepared_chunk_ordinal !== chunk.ordinal ||
        row.prepared_offset !== chunk.byte_offset ||
        row.prepared_byte_length !== chunk.byte_length ||
        row.prepared_sha256 !== chunk.sha256 ||
        row.revision !== chunk.request_revision + 1
      ) {
        throw invalidState("Prepared attachment chunk lost its exact fence.");
      }
      const committedRevision = row.revision + 1;
      this.#database.query(`
        UPDATE chat_attachments
        SET received_input_bytes = received_input_bytes + ?2,
            next_chunk_ordinal = next_chunk_ordinal + 1,
            prepared_chunk_ordinal = NULL,
            prepared_offset = NULL,
            prepared_byte_length = NULL,
            prepared_sha256 = NULL,
            revision = ?3,
            updated_at = ?4
        WHERE attachment_id = ?1
      `).run(chunk.attachment_id, chunk.byte_length, committedRevision, nowIso);
      this.#database.query(`
        UPDATE chat_attachment_upload_chunks
        SET state = 'committed', settled_revision = ?4, settled_at = ?5
        WHERE attachment_id = ?1 AND ordinal = ?2 AND request_revision = ?3
      `).run(
        chunk.attachment_id,
        chunk.ordinal,
        chunk.request_revision,
        committedRevision,
        nowIso,
      );
      return this.#requireRow(chunk.attachment_id);
    })();
  }

  async #resumeFinalization(
    initial: AttachmentRow,
    nowIso: string,
  ): Promise<AttachmentRow> {
    let row = this.#requireRow(initial.attachment_id);
    if (row.state === "ready") return row;
    if (row.state === "normalizing") {
      if (
        row.kind !== "image" ||
        row.input_sha256 === null ||
        row.finalize_request_revision === null
      ) {
        throw invalidState("Image normalization receipt is incomplete.");
      }
      this.#requirePaneWritable(row.pane_id);
      await this.#filesystem.removeUndocumentedImageGeneration(row.attachment_id);
      this.#requirePaneWritable(row.pane_id);
      this.#assertStorageAdmissionSafe();
      try {
        const receipt = await this.#normalizer.normalize(
          this.#filesystem.uploadPath(row.attachment_id),
          this.#filesystem.imageGenerationPath(row.attachment_id),
        );
        this.#requirePaneWritable(row.pane_id);
        if (receipt.sourceBytes !== row.expected_input_bytes) {
          throw new ChatAttachmentVaultError(
            "corrupt",
            "Image source size changed during normalization.",
          );
        }
        await this.#filesystem.verifyImageGeneration(row.attachment_id, receipt);
        this.#database.transaction(() => {
          this.#requirePaneWritable(row.pane_id);
          const current = this.#requireRow(row.attachment_id);
          if (current.state !== "normalizing" || current.revision !== row.revision) {
            throw revisionConflict();
          }
          this.#database.query(`
            UPDATE chat_attachments
            SET state = 'publishing',
                effective_media_type = 'image/png',
                source_media_type = ?2,
                width = ?3,
                height = ?4,
                pixel_count = ?5,
                canonical_bytes = ?6,
                canonical_sha256 = ?7,
                preview_bytes = ?8,
                preview_width = ?9,
                preview_height = ?10,
                preview_sha256 = ?11,
                provider_bytes = ?6,
                provider_sha256 = ?7,
                revision = revision + 1,
                updated_at = ?12
            WHERE attachment_id = ?1
          `).run(
            row.attachment_id,
            receipt.mediaType,
            receipt.canonical.width,
            receipt.canonical.height,
            receipt.canonical.width * receipt.canonical.height,
            receipt.canonical.bytes,
            receipt.canonical.sha256,
            receipt.preview.bytes,
            receipt.preview.width,
            receipt.preview.height,
            receipt.preview.sha256,
            nowIso,
          );
        })();
      } catch (error: unknown) {
        await this.#cleanupFailedNormalization(row, nowIso);
        throw error;
      }
      row = this.#requireRow(row.attachment_id);
    }
    if (row.state !== "publishing") {
      throw invalidState("Attachment is not at a resumable publication cut.");
    }
    if (
      row.input_sha256 === null ||
      row.requested_input_sha256 !== row.input_sha256 ||
      row.finalize_request_revision === null
    ) {
      throw invalidState("Attachment publication receipt is incomplete.");
    }
    if (row.kind === "image") {
      const receipt = imageReceipt(row);
      await this.#filesystem.verifyImageGeneration(row.attachment_id, receipt);
      this.#requirePaneWritable(row.pane_id);
      this.#assertFinalByteQuota(
        row,
        receipt.canonical.bytes,
        receipt.preview.bytes,
      );
    } else {
      this.#assertFinalByteQuota(row, row.expected_input_bytes, 0);
      this.#requirePaneWritable(row.pane_id);
      await this.#filesystem.publishGeneric(
        row.attachment_id,
        row.internal_suffix,
        row.expected_input_bytes,
        row.input_sha256,
      );
      this.#requirePaneWritable(row.pane_id);
    }
    this.#database.transaction(() => {
      this.#requirePaneWritable(row.pane_id);
      const current = this.#requireRow(row.attachment_id);
      if (current.state !== "publishing" || current.revision !== row.revision) {
        throw revisionConflict();
      }
      if (current.kind === "file") {
        this.#database.query(`
          UPDATE chat_attachments
          SET state = 'ready',
              source_retained = 0,
              effective_media_type = declared_media_type,
              provider_bytes = expected_input_bytes,
              provider_sha256 = input_sha256,
              ready_at = ?2,
              revision = revision + 1,
              updated_at = ?2
          WHERE attachment_id = ?1
        `).run(row.attachment_id, nowIso);
      } else {
        this.#database.query(`
          UPDATE chat_attachments
          SET state = 'ready', ready_at = ?2,
              revision = revision + 1, updated_at = ?2
          WHERE attachment_id = ?1
        `).run(row.attachment_id, nowIso);
      }
    })();
    const ready = this.#requireRow(row.attachment_id);
    return ready.kind === "image"
      ? await this.#cleanReadyImageSource(ready, nowIso)
      : ready;
  }

  async #verifyReady(row: AttachmentRow, nowIso: string): Promise<AttachmentRow> {
    if (
      row.provider_bytes === null ||
      row.provider_sha256 === null ||
      row.effective_media_type === null
    ) {
      throw invalidState("Ready attachment has no provider receipt.");
    }
    if (row.kind === "image") {
      await this.#filesystem.verifyImageGeneration(row.attachment_id, imageReceipt(row));
      return await this.#cleanReadyImageSource(row, nowIso);
    } else {
      await this.#filesystem.verifyGeneric(
        row.attachment_id,
        row.internal_suffix,
        row.provider_bytes,
        row.provider_sha256,
      );
      if (row.source_retained !== 0) {
        throw invalidState("Ready generic attachment retained a source duplicate.");
      }
      await this.#filesystem.assertUploadAbsent(row.attachment_id);
      return row;
    }
  }

  async #cleanReadyImageSource(
    stale: AttachmentRow,
    nowIso: string,
  ): Promise<AttachmentRow> {
    let row = this.#requireRow(stale.attachment_id);
    if (
      row.state !== "ready" || row.kind !== "image" ||
      row.input_sha256 === null
    ) {
      throw invalidState("Image source cleanup requires an exact ready receipt.");
    }
    if (row.source_retained === 0) {
      await this.#filesystem.assertUploadAbsent(row.attachment_id);
      return row;
    }
    this.#requirePaneWritable(row.pane_id);
    if (this.#verifiedUploadDeletionPaneId !== null) {
      throw invalidState("Attachment source cleanup is already in progress.");
    }
    this.#verifiedUploadDeletionPaneId = row.pane_id;
    try {
      await this.#filesystem.removeVerifiedUploadIfPresent(
        row.attachment_id,
        row.expected_input_bytes,
        row.input_sha256,
      );
    } finally {
      this.#verifiedUploadDeletionPaneId = null;
    }
    row = this.#database.transaction(() => {
      this.#requirePaneWritable(row.pane_id);
      const current = this.#requireRow(stale.attachment_id);
      if (
        current.state !== "ready" || current.kind !== "image" ||
        current.source_retained !== 1 || current.revision !== row.revision ||
        current.input_sha256 !== row.input_sha256
      ) {
        throw revisionConflict();
      }
      this.#database.query(`
        UPDATE chat_attachments
        SET source_retained = 0, revision = revision + 1, updated_at = ?2
        WHERE attachment_id = ?1
      `).run(current.attachment_id, nowIso);
      return this.#requireRow(current.attachment_id);
    })();
    await this.#filesystem.assertUploadAbsent(row.attachment_id);
    return row;
  }

  async #cleanupFailedNormalization(
    row: AttachmentRow,
    nowIso: string,
  ): Promise<void> {
    let cleanupFailure: unknown;
    try {
      this.#assertNoProviderThreadArchiveMutationAuthorityV57(row.pane_id);
      await this.#filesystem.removeNormalizerResidue(row.attachment_id);
      this.#assertNoProviderThreadArchiveMutationAuthorityV57(row.pane_id);
    } catch (error: unknown) {
      cleanupFailure = error;
    }
    try {
      this.#assertNoProviderThreadArchiveMutationAuthorityV57(row.pane_id);
      await this.#filesystem.removeUndocumentedImageGeneration(row.attachment_id);
      this.#assertNoProviderThreadArchiveMutationAuthorityV57(row.pane_id);
    } catch (error: unknown) {
      cleanupFailure ??= error;
    }
    if (cleanupFailure !== undefined) {
      this.#quarantineStorage(row, nowIso);
      throw cleanupFailure instanceof Error
        ? cleanupFailure
        : new Error("Attachment normalization cleanup failed.");
    }
  }

  #quarantineStorage(row: AttachmentRow, nowIso: string): void {
    this.#database.transaction(() => {
      this.#assertNoProviderThreadArchiveMutationAuthorityV57(row.pane_id);
      this.#database.query(`
        INSERT INTO chat_attachment_storage_quarantines (
          attachment_id, pane_id, reason, detected_at
        ) VALUES (?1, ?2, 'normalizer_cleanup', ?3)
        ON CONFLICT (attachment_id) DO NOTHING
      `).run(row.attachment_id, row.pane_id, nowIso);
    })();
  }

  async #deleteAttachment(
    stale: AttachmentRow,
    reason: "cancelled" | "removed" | "archive" | "gc",
    nowIso: string,
    requireExpiredDraft = false,
  ): Promise<void> {
    const row = this.#requireRow(stale.attachment_id);
    this.#assertNoRetainingCustody(row.attachment_id);
    this.#database.transaction(() => {
      const current = this.#requireRow(row.attachment_id);
      if (reason !== "archive") {
        this.#assertNoProviderThreadArchiveMutationAuthorityV57(
          current.pane_id,
        );
      }
      if (requireExpiredDraft) {
        const draft = this.#database.query<{ expires_at: string }, [string]>(`
          SELECT expires_at FROM chat_attachment_draft_leases
          WHERE attachment_id = ?1
        `).get(row.attachment_id);
        if (draft !== null && draft.expires_at > nowIso) {
          throw invalidState("Attachment draft is still inside its grace window.");
        }
      }
      this.#database.query(`
        DELETE FROM chat_attachment_draft_leases WHERE attachment_id = ?1
      `).run(row.attachment_id);
      if (current.state !== "deleting") {
        this.#database.query(`
          UPDATE chat_attachments
          SET state = 'deleting', deletion_reason = ?3,
              revision = revision + 1, updated_at = ?2
          WHERE attachment_id = ?1
        `).run(row.attachment_id, nowIso, reason);
      }
    })();
    await this.#completeDeletion(this.#requireRow(row.attachment_id), nowIso);
  }

  async #completeDeletion(
    stale: AttachmentRow,
    nowIso: string,
  ): Promise<void> {
    let row = this.#database.transaction(() => {
      const current = this.#requireRow(stale.attachment_id);
      this.#assertDeletionMutationAuthorityV57(current);
      if (
        current.state !== "deleting" || current.deletion_reason === null ||
        current.deletion_reason !== stale.deletion_reason
      ) {
        throw invalidState("Attachment deletion lost its durable cut.");
      }
      return current;
    })();
    await this.#afterIoCheckpoint("object-delete-preflight");
    row = this.#database.transaction(() => {
      const current = this.#requireRow(row.attachment_id);
      this.#assertDeletionMutationAuthorityV57(current);
      if (
        current.state !== "deleting" || current.deletion_reason === null ||
        current.deletion_reason !== row.deletion_reason ||
        current.revision !== row.revision
      ) {
        throw invalidState("Attachment deletion lost its durable cut.");
      }
      return current;
    })();
    await this.#afterIoCheckpoint("object-delete-authorized");
    row = this.#database.transaction(() => {
      const current = this.#requireRow(row.attachment_id);
      this.#assertDeletionMutationAuthorityV57(current);
      if (
        current.state !== "deleting" || current.deletion_reason === null ||
        current.deletion_reason !== row.deletion_reason ||
        current.revision !== row.revision
      ) {
        throw invalidState("Attachment deletion lost its durable cut.");
      }
      return current;
    })();
    await this.#filesystem.removeObject(
      row.attachment_id,
      row.internal_suffix,
      row.kind,
    );
    this.#database.transaction(() => {
      const current = this.#requireRow(row.attachment_id);
      this.#assertDeletionMutationAuthorityV57(current);
      if (
        current.state !== "deleting" || current.deletion_reason === null ||
        current.deletion_reason !== row.deletion_reason ||
        current.revision !== row.revision
      ) {
        throw invalidState("Attachment deletion lost its durable cut.");
      }
      this.#database.query(`
        DELETE FROM chat_attachment_draft_leases WHERE attachment_id = ?1
      `).run(row.attachment_id);
      if (current.deletion_reason !== "privacy") {
        this.#database.query(`
          INSERT INTO chat_attachment_deletion_receipts (
            attachment_id, upload_id, pane_id, final_revision, reason, deleted_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
          ON CONFLICT (attachment_id) DO NOTHING
        `).run(
          current.attachment_id,
          current.upload_id,
          current.pane_id,
          current.revision,
          current.deletion_reason,
          nowIso,
        );
      }
      this.#database.query(`
        DELETE FROM chat_attachments WHERE attachment_id = ?1
      `).run(row.attachment_id);
    })();
  }

  #containCorrupt(attachmentId: ChatMessageAttachmentId, nowIso: string): void {
    this.#database.transaction(() => {
      const row = this.#row(attachmentId);
      if (row === null) return;
      this.#assertNoProviderThreadArchiveMutationAuthorityV57(row.pane_id);
      if (row.state === "corrupt" || row.state === "deleting") return;
      this.#database.query(`
        DELETE FROM chat_attachment_draft_leases WHERE attachment_id = ?1
      `).run(attachmentId);
      this.#database.query(`
        UPDATE chat_attachments
        SET state = 'corrupt', revision = revision + 1, updated_at = ?2
        WHERE attachment_id = ?1
      `).run(attachmentId, nowIso);
    })();
  }

  #releasePaneBindings(
    paneId: string,
    containmentDigest: string,
    nowIso: string,
  ): void {
    const bindings = this.#database.query(`
      SELECT * FROM chat_provider_attachment_bindings
      WHERE pane_id = ?1 AND state != 'released'
      ORDER BY binding_id
    `).all(paneId).map((row) => providerBindingRowSchema.parse(row));
    for (const binding of bindings) {
      this.#database.query(`
        UPDATE chat_provider_attachment_bindings
        SET state = 'released',
            containment_receipt_digest = ?2,
            revision = revision + 1,
            updated_at = ?3,
            released_at = ?3
        WHERE binding_id = ?1
      `).run(binding.binding_id, containmentDigest, nowIso);
    }
  }

  async #completePaneArchiveIntent(
    stale: PaneArchiveIntentRow,
    nowIso: string,
  ): Promise<number> {
    const intent = this.#requirePaneArchiveIntent(stale.pane_id);
    if (intent.state === "completed") return 0;
    const pane = this.#paneLifecycle(intent.pane_id);
    if (intent.state !== "pane_archived" || pane.archived_at === null) {
      throw invalidState("Attachment archive cleanup lacks its atomic pane archive cut.");
    }
    this.#database.transaction(() => {
      this.#assertProviderThreadArchivePaneArchiveCleanupAuthorityV57(
        intent.pane_id,
      );
      this.#assertNoActiveNonArchiveDeletionCut(intent.pane_id);
      this.#releasePaneBindings(
        intent.pane_id,
        intent.containment_receipt_digest,
        nowIso,
      );
      this.#database.query(`
        DELETE FROM chat_attachment_turn_leases WHERE pane_id = ?1
      `).run(intent.pane_id);
      this.#database.query(`
        DELETE FROM chat_message_attachment_refs WHERE pane_id = ?1
      `).run(intent.pane_id);
      this.#database.query(`
        DELETE FROM chat_attachment_draft_leases WHERE pane_id = ?1
      `).run(intent.pane_id);
      const rows = this.#database.query(`
        SELECT * FROM chat_attachments
        WHERE pane_id = ?1
        ORDER BY created_at, attachment_id
      `).all(intent.pane_id).map((row) => attachmentRowSchema.parse(row));
      for (const row of rows) {
        if (row.state === "deleting") continue;
        this.#database.query(`
          UPDATE chat_attachments
          SET state = 'deleting', deletion_reason = 'archive',
              revision = revision + 1, updated_at = ?2
          WHERE attachment_id = ?1
        `).run(row.attachment_id, nowIso);
      }
    })();
    const deleting = this.#database.query(`
      SELECT * FROM chat_attachments
      WHERE pane_id = ?1
      ORDER BY created_at, attachment_id
    `).all(intent.pane_id).map((row) => attachmentRowSchema.parse(row));
    for (const row of deleting) {
      if (row.state !== "deleting") {
        throw invalidState("Pane archive attachment did not enter deletion custody.");
      }
      await this.#completeDeletion(row, nowIso);
    }
    this.#database.transaction(() => {
      this.#assertProviderThreadArchivePaneArchiveCleanupAuthorityV57(
        intent.pane_id,
      );
      this.#assertNoActiveNonArchiveDeletionCut(intent.pane_id);
      const remaining = countRowSchema.parse(this.#database.query(`
        SELECT COUNT(*) AS count FROM chat_attachments WHERE pane_id = ?1
      `).get(intent.pane_id));
      if (remaining.count !== 0) {
        throw invalidState("Pane archive attachment cleanup is incomplete.");
      }
      this.#database.query(`
        DELETE FROM chat_provider_attachment_bindings WHERE pane_id = ?1
      `).run(intent.pane_id);
      this.#database.query(`
        UPDATE chat_attachment_pane_archive_intents
        SET state = 'completed', completed_at = ?2, updated_at = ?2
        WHERE pane_id = ?1 AND state = 'pane_archived'
      `).run(intent.pane_id, nowIso);
      this.#verifiedPaneArchiveCleanupV57.delete(intent.pane_id);
    })();
    return deleting.length;
  }

  async #completePrivacyDeletionIntent(
    intent: PrivacyIntentRow,
    nowIso: string,
  ): Promise<number> {
    const rows = this.#database.query(`
      SELECT * FROM chat_attachments
      WHERE pane_id = ?1
      ORDER BY created_at, attachment_id
    `).all(intent.pane_id).map((row) => attachmentRowSchema.parse(row));
    for (const row of rows) {
      if (row.state !== "deleting") {
        throw invalidState("Privacy deletion lost attachment containment.");
      }
      await this.#completeDeletion(row, nowIso);
    }
    await this.#afterIoCheckpoint("privacy-bytes-removed");
    this.#database.transaction(() => {
      const current = this.#requirePrivacyIntent(intent.pane_id);
      if (
        current.authorization_receipt_digest !== intent.authorization_receipt_digest ||
        current.containment_receipt_digest !== intent.containment_receipt_digest
      ) {
        throw conflict("Attachment privacy-deletion authorization changed.");
      }
      const remaining = countRowSchema.parse(this.#database.query(`
        SELECT COUNT(*) AS count FROM chat_attachments WHERE pane_id = ?1
      `).get(intent.pane_id));
      if (remaining.count !== 0) {
        throw invalidState("Attachment privacy deletion is incomplete.");
      }
      this.#assertNoProviderThreadArchiveAuthorityV57(intent.pane_id);
      const pendingProviderArchive = countRowSchema.parse(this.#database.query(`
        SELECT COUNT(*) AS count
        FROM chat_provider_thread_archive_intents
        WHERE pane_id = ?1 AND state != 'account_contained'
      `).get(intent.pane_id)).count;
      if (pendingProviderArchive > 0) {
        throw invalidState("Provider thread archive already owns pane containment.");
      }
      const accountContainedProviderArchive =
        this.#assertExactAccountContainedProviderArchiveIntent(
          intent.pane_id,
          current.containment_receipt_digest,
        );
      this.#database.query(`
        DELETE FROM chat_provider_attachment_bindings WHERE pane_id = ?1
      `).run(intent.pane_id);
      this.#database.query(`
        DELETE FROM chat_attachment_deletion_receipts WHERE pane_id = ?1
      `).run(intent.pane_id);
      this.#database.query(`
        DELETE FROM chat_attachment_pane_archive_intents WHERE pane_id = ?1
      `).run(intent.pane_id);
      this.#database.query(`
        INSERT INTO chat_attachment_privacy_tombstones (pane_id, completed_at)
        VALUES (?1, ?2)
        ON CONFLICT (pane_id) DO NOTHING
      `).run(intent.pane_id, nowIso);
      if (accountContainedProviderArchive !== null) {
        const consumed = this.#database.query(`
          DELETE FROM chat_provider_thread_archive_intents
          WHERE pane_id = ?1 AND state = 'account_contained'
            AND generation_contained = 1
            AND generation_containment_receipt = ?2
        `).run(
          intent.pane_id,
          accountContainedProviderArchive.generation_containment_receipt,
        );
        if (consumed.changes !== 1) {
          throw conflict("Provider account-containment authority changed.");
        }
      }
      this.#database.query(`
        DELETE FROM chat_attachment_privacy_deletion_intents WHERE pane_id = ?1
      `).run(intent.pane_id);
    })();
    return rows.length;
  }

  #revokeTerminalMessageRefs(): number {
    return this.#database.transaction(() => {
      const paneValues: unknown[] = this.#database.query(`
        SELECT DISTINCT ref.pane_id
        FROM chat_message_attachment_refs AS ref
        WHERE NOT EXISTS (
          SELECT 1 FROM chat_attachment_turn_leases AS turn_lease
          WHERE turn_lease.attachment_id = ref.attachment_id
            AND turn_lease.message_id = ref.message_id
            AND turn_lease.pane_id = ref.pane_id
            AND turn_lease.state != 'released'
        )
          AND EXISTS (
            SELECT 1 FROM chat_message_ledger AS message
            WHERE message.message_id = ref.message_id
              AND message.pane_id = ref.pane_id
              AND (
                message.state IN ('completed', 'cancelled')
                OR (
                  message.state = 'ambiguous'
                  AND EXISTS (
                    SELECT 1
                    FROM chat_message_ambiguous_resolutions AS resolution
                    WHERE resolution.message_id = message.message_id
                      AND resolution.pane_id = message.pane_id
                  )
                )
              )
          )
        ORDER BY ref.pane_id
      `).all();
      let revoked = 0;
      for (const value of paneValues) {
        const paneId = paneIdRowSchema.parse(value).pane_id;
        if (this.#providerThreadArchiveMutationFencedV57(paneId)) continue;
        revoked += Number(this.#database.query(`
          DELETE FROM chat_message_attachment_refs AS ref
          WHERE ref.pane_id = ?1
            AND NOT EXISTS (
              SELECT 1 FROM chat_attachment_turn_leases AS turn_lease
              WHERE turn_lease.attachment_id = ref.attachment_id
                AND turn_lease.message_id = ref.message_id
                AND turn_lease.pane_id = ref.pane_id
                AND turn_lease.state != 'released'
            )
            AND EXISTS (
              SELECT 1 FROM chat_message_ledger AS message
              WHERE message.message_id = ref.message_id
                AND message.pane_id = ref.pane_id
                AND (
                  message.state IN ('completed', 'cancelled')
                  OR (
                    message.state = 'ambiguous'
                    AND EXISTS (
                      SELECT 1
                      FROM chat_message_ambiguous_resolutions AS resolution
                      WHERE resolution.message_id = message.message_id
                        AND resolution.pane_id = message.pane_id
                    )
                  )
                )
            )
        `).run(paneId).changes);
      }
      return revoked;
    })();
  }

  async #assertDurableInventory(row: AttachmentRow): Promise<void> {
    const blob = `blob.${row.internal_suffix}`;
    if (row.state === "creating" || row.state === "receiving") {
      await this.#filesystem.assertObjectInventory(row.attachment_id, {
        allowedEntries: ["source.upload"],
        requiredEntries: ["source.upload"],
      });
      return;
    }
    if (row.state === "normalizing") {
      await this.#filesystem.assertObjectInventory(row.attachment_id, {
        allowedEntries: ["source.upload", "normalized"],
        requiredEntries: ["source.upload"],
      });
      return;
    }
    if (row.state === "publishing") {
      if (row.kind === "image") {
        await this.#filesystem.assertObjectInventory(row.attachment_id, {
          allowedEntries: ["source.upload", "normalized"],
          requiredEntries: ["source.upload", "normalized"],
        });
      } else {
        await this.#filesystem.assertObjectInventory(row.attachment_id, {
          allowedEntries: ["source.upload", blob],
          allowGenericPublicationPair: true,
        });
      }
      return;
    }
    if (row.state === "ready") {
      await this.#filesystem.assertObjectInventory(row.attachment_id, row.kind === "image"
        ? { allowedEntries: ["normalized"], requiredEntries: ["normalized"] }
        : { allowedEntries: [blob], requiredEntries: [blob] });
      return;
    }
    if (row.state === "corrupt") {
      await this.#filesystem.assertObjectInventory(
        row.attachment_id,
        row.kind === "image"
          ? {
              allowedEntries: ["source.upload", "normalized"],
              allowMissingObject: true,
              allowEmpty: true,
            }
          : {
              allowedEntries: ["source.upload", blob],
              allowGenericPublicationPair: true,
              allowMissingObject: true,
              allowEmpty: true,
            },
      );
    }
  }

  #assertNoRetainingCustody(attachmentId: ChatMessageAttachmentId): void {
    const custody = countRowSchema.parse(this.#database.query(`
      SELECT (
        (SELECT COUNT(*) FROM chat_message_attachment_refs
          WHERE attachment_id = ?1)
        +
        (SELECT COUNT(*) FROM chat_attachment_turn_leases
          WHERE attachment_id = ?1 AND state != 'released')
        +
        (SELECT COUNT(*)
          FROM chat_provider_attachment_leases AS provider_lease
          JOIN chat_provider_attachment_bindings AS binding
            ON binding.binding_id = provider_lease.binding_id
          WHERE provider_lease.attachment_id = ?1
            AND binding.state != 'released')
      ) AS count
    `).get(attachmentId));
    if (custody.count !== 0) {
      throw invalidState("Attachment is retained by a message or provider binding.");
    }
  }

  #assertNoActiveNonArchiveDeletionCut(paneId: string): void {
    const active = countRowSchema.parse(this.#database.query(`
      SELECT COUNT(*) AS count
      FROM chat_attachments
      WHERE pane_id = ?1 AND state = 'deleting'
        AND deletion_reason IN ('cancelled', 'removed', 'gc')
    `).get(paneId));
    if (active.count !== 0) {
      throw invalidState(
        "A non-archive attachment deletion cut must settle before pane archive.",
      );
    }
  }

  #assertNoProviderThreadArchiveAttachmentMutationCutV57(
    paneId: string,
  ): void {
    const active = countRowSchema.parse(this.#database.query(`
      SELECT COUNT(*) AS count
      FROM chat_attachments
      WHERE pane_id = ?1 AND (
        state IN ('creating', 'normalizing', 'publishing', 'corrupt', 'deleting')
        OR prepared_chunk_ordinal IS NOT NULL
        OR (state = 'ready' AND source_retained = 1)
      )
    `).get(paneId));
    if (active.count !== 0) {
      throw invalidState(
        "Attachment filesystem mutation must settle before v57 provider archive admission.",
      );
    }
  }

  #assertDeletionMutationAuthorityV57(row: AttachmentRow): void {
    if (row.deletion_reason === "privacy") {
      this.#assertPrivacyDeletionPreflight(row.pane_id);
      return;
    }
    if (row.deletion_reason === "archive") {
      this.#assertProviderThreadArchivePaneArchiveCleanupAuthorityV57(
        row.pane_id,
      );
      return;
    }
    this.#assertNoProviderThreadArchiveMutationAuthorityV57(row.pane_id);
  }

  #assertPrivacyDeletionPreflight(paneId: string): void {
    const intent = this.#requirePrivacyIntent(paneId);
    this.#assertNoProviderThreadArchiveAuthorityV57(paneId);
    const pendingProviderArchive = countRowSchema.parse(this.#database.query(`
      SELECT COUNT(*) AS count
      FROM chat_provider_thread_archive_intents
      WHERE pane_id = ?1 AND state != 'account_contained'
    `).get(paneId));
    if (pendingProviderArchive.count !== 0) {
      throw invalidState("Provider thread archive already owns pane containment.");
    }
    this.#assertExactAccountContainedProviderArchiveIntent(
      paneId,
      intent.containment_receipt_digest,
    );
  }

  #assertProviderThreadArchivePaneArchiveCleanupAuthorityV57(
    paneId: string,
  ): void {
    const targets = countRowSchema.parse(this.#database.query(`
      SELECT COUNT(*) AS count
      FROM chat_provider_thread_archive_targets_v57
      WHERE pane_id = ?1
    `).get(paneId)).count;
    if (targets === 0) {
      this.#assertNoProviderThreadArchiveMutationAuthorityV57(paneId);
      return;
    }
    if (!this.#verifiedPaneArchiveCleanupV57.has(paneId)) {
      throw invalidState(
        "Committed pane-archive cleanup lacks Store terminal verification.",
      );
    }
    this.#assertProviderThreadArchivePaneArchiveCleanupStructureV57(paneId);
  }

  #assertProviderThreadArchivePaneArchiveCleanupStructureV57(
    paneId: string,
    allowCompleted = false,
  ): void {
    const intent = this.#requirePaneArchiveIntent(paneId);
    if (
      (intent.state !== "pane_archived" &&
        !(allowCompleted && intent.state === "completed"))
    ) {
      throw invalidState(
        "Attachment archive cleanup lacks its atomic pane archive cut.",
      );
    }
    this.#assertProviderThreadArchivePaneArchiveTargetStructureV57(paneId);
  }

  #assertProviderThreadArchivePaneArchiveTargetStructureV57(
    paneId: string,
  ): void {
    if (this.#paneLifecycle(paneId).archived_at === null) {
      throw invalidState(
        "Attachment archive cleanup lacks its atomic pane archive cut.",
      );
    }
    const targets = countRowSchema.parse(this.#database.query(`
      SELECT COUNT(*) AS count
      FROM chat_provider_thread_archive_targets_v57
      WHERE pane_id = ?1
    `).get(paneId)).count;
    const authorizedTargets = countRowSchema.parse(this.#database.query(`
      SELECT COUNT(*) AS count
      FROM chat_provider_thread_archive_targets_v57
      WHERE pane_id = ?1 AND purpose = 'pane_archive' AND status = 'committed'
    `).get(paneId)).count;
    const unauthorizedMembers = countRowSchema.parse(this.#database.query(`
      SELECT COUNT(*) AS count
      FROM chat_provider_thread_archive_cut_members_v57 AS member
      WHERE member.pane_id = ?1 AND NOT (
        member.state = 'settled' AND member.role = 'target' AND EXISTS (
          SELECT 1
          FROM chat_provider_thread_archive_targets_v57 AS target
          WHERE target.target_id = member.target_id
            AND target.pane_id = member.pane_id
            AND target.purpose = 'pane_archive'
            AND target.status = 'committed'
        )
      )
    `).get(paneId)).count;
    if (
      targets !== 1 || authorizedTargets !== 1 || unauthorizedMembers !== 0
    ) {
      throw invalidState(
        "Attachment archive cleanup lacks one committed pane-archive authority.",
      );
    }
    this.#assertNoActiveProviderThreadArchiveSourceCutV57(paneId);
  }

  #providerThreadArchiveCommittedTargetsV57():
    readonly ProviderThreadArchiveCommittedTargetRowV57[] {
    const values: unknown[] = this.#database.query(`
      SELECT target_id, pane_id, purpose, status
      FROM chat_provider_thread_archive_targets_v57
      WHERE status = 'committed'
      ORDER BY target_id
    `).all();
    const rows = values.map((value) =>
      providerThreadArchiveCommittedTargetRowSchemaV57.parse(value)
    );
    const targetIds = rows.map(({ target_id }) => target_id);
    const canonical = [...targetIds].sort(compareCanonicalCodeUnitsV57);
    if (
      new Set(targetIds).size !== targetIds.length ||
      !canonicalStringArraysEqualV57(targetIds, canonical)
    ) {
      throw invalidState(
        "Stored provider thread archive committed targets are not canonical.",
      );
    }
    return Object.freeze(rows);
  }

  #assertExactProviderThreadArchiveCommittedTargetIdsV57(
    expected: readonly string[],
    committed: readonly ProviderThreadArchiveCommittedTargetRowV57[],
  ): void {
    const observed = committed.map(({ target_id }) => target_id);
    if (!canonicalStringArraysEqualV57(expected, observed)) {
      throw invalidState(
        "Provider thread archive committed target snapshot changed.",
      );
    }
  }

  #assertProviderThreadArchivePaneArchiveTerminalPostimageV57(
    paneId: string,
  ): void {
    if (this.#hasPrivacyTombstone(paneId)) {
      if (this.#privacyIntent(paneId) !== null) {
        throw invalidState(
          "Committed pane-archive privacy cleanup is incomplete.",
        );
      }
      this.#assertProviderThreadArchivePaneArchiveTargetStructureV57(paneId);
    } else {
      this.#assertProviderThreadArchivePaneArchiveCleanupStructureV57(
        paneId,
        true,
      );
      if (this.#requirePaneArchiveIntent(paneId).state !== "completed") {
        throw invalidState(
          "Committed pane-archive attachment cleanup is incomplete.",
        );
      }
    }
    const postimage =
      providerThreadArchivePaneArchivePostimageRowSchemaV57.parse(
        this.#database.query(`
          SELECT
            (SELECT COUNT(*) FROM chat_attachments
              WHERE pane_id = ?1) AS attachments,
            (SELECT COUNT(*) FROM chat_attachment_draft_leases
              WHERE pane_id = ?1) AS draft_leases,
            (SELECT COUNT(*) FROM chat_attachment_upload_chunks
              WHERE pane_id = ?1) AS upload_chunks,
            (SELECT COUNT(*) FROM chat_message_attachment_refs
              WHERE pane_id = ?1) AS message_refs,
            (SELECT COUNT(*) FROM chat_attachment_turn_leases
              WHERE pane_id = ?1) AS turn_leases,
            (SELECT COUNT(*) FROM chat_provider_attachment_bindings
              WHERE pane_id = ?1) AS provider_bindings,
            (SELECT COUNT(*) FROM chat_provider_attachment_leases
              WHERE pane_id = ?1) AS provider_leases,
            (SELECT COUNT(*) FROM chat_attachment_storage_quarantines
              WHERE pane_id = ?1) AS storage_quarantines
        `).get(paneId),
      );
    if (Object.values(postimage).some((count) => count !== 0)) {
      throw invalidState(
        "Committed pane-archive Vault custody is not empty.",
      );
    }
  }

  #assertProviderThreadArchiveStartFreshTerminalPostimageV57(
    paneId: string,
  ): void {
    if (this.#paneLifecycle(paneId).archived_at !== null) {
      throw invalidState(
        "Committed start-fresh attachment custody belongs to an archived pane.",
      );
    }
    this.#assertNoProviderThreadArchiveAttachmentMutationCutV57(paneId);
    const postimage =
      providerThreadArchiveStartFreshPostimageRowSchemaV57.parse(
        this.#database.query(`
          SELECT
            (SELECT COUNT(*) FROM chat_provider_attachment_bindings
              WHERE pane_id = ?1 AND state != 'released'
            ) AS retained_provider_bindings,
            (SELECT COUNT(*)
              FROM chat_provider_attachment_leases AS provider_lease
              JOIN chat_provider_attachment_bindings AS binding
                ON binding.binding_id = provider_lease.binding_id
                  AND binding.pane_id = provider_lease.pane_id
              WHERE provider_lease.pane_id = ?1 AND binding.state != 'released'
            ) AS retained_provider_leases,
            (SELECT COUNT(*) FROM chat_attachment_turn_leases
              WHERE pane_id = ?1 AND state != 'released'
            ) AS retained_turn_leases,
            (SELECT COUNT(*) FROM chat_attachment_upload_chunks
              WHERE pane_id = ?1 AND state = 'prepared'
            ) AS prepared_chunks,
            (SELECT COUNT(*) FROM chat_attachment_storage_quarantines
              WHERE pane_id = ?1) AS storage_quarantines,
            (SELECT COUNT(*) FROM chat_attachment_pane_archive_intents
              WHERE pane_id = ?1) AS archive_intents,
            (SELECT COUNT(*) FROM chat_attachment_privacy_deletion_intents
              WHERE pane_id = ?1) AS privacy_intents
        `).get(paneId),
      );
    if (Object.values(postimage).some((count) => count !== 0)) {
      throw invalidState(
        "Committed start-fresh Vault custody is not terminal.",
      );
    }
  }

  #providerThreadArchivePaneArchiveCleanupAuthorizedV57(
    paneId: string,
  ): boolean {
    try {
      this.#assertProviderThreadArchivePaneArchiveCleanupAuthorityV57(paneId);
      return true;
    } catch (error: unknown) {
      if (
        error instanceof ChatAttachmentVaultError &&
        error.code === "invalid_state"
      ) {
        return false;
      }
      throw error;
    }
  }

  #requirePaneWritable(paneId: string): void {
    const row = this.#database.query<{
      archived_at: string | null;
      interaction_mode: string;
    }, [string]>(`
      SELECT archived_at, interaction_mode FROM chat_panes WHERE pane_id = ?1
    `).get(paneId);
    if (row === null) throw notFound();
    if (
      row.archived_at !== null || row.interaction_mode !== "chat" ||
      this.#privacyIntent(paneId) !== null ||
      this.#hasPrivacyTombstone(paneId) ||
      this.#paneArchiveIntent(paneId) !== null
    ) {
      throw invalidState("Attachments require an active chat pane.");
    }
    this.#assertNoProviderThreadArchiveMutationAuthorityV57(paneId);
  }

  #paneWriteFenceError(paneId: string): Error | null {
    try {
      this.#requirePaneWritable(paneId);
      return null;
    } catch (error: unknown) {
      return error instanceof Error
        ? error
        : new Error("Attachment pane write authority changed.");
    }
  }

  #requirePaneReadable(paneId: string): void {
    const pane = this.#paneLifecycle(paneId);
    if (
      pane.archived_at !== null ||
      this.#privacyIntent(paneId) !== null ||
      this.#hasPrivacyTombstone(paneId) ||
      this.#paneArchiveIntent(paneId) !== null
    ) {
      throw notFound();
    }
  }

  #assertByteQuota(paneId: string, addedBytes: number): void {
    this.#assertStorageAdmissionSafe();
    const pane = bytesRowSchema.parse(this.#database.query(`
      SELECT COALESCE(SUM(
        CASE WHEN provider_bytes IS NULL
          THEN expected_input_bytes
          ELSE provider_bytes + COALESCE(preview_bytes, 0)
            + CASE WHEN source_retained = 1
                THEN expected_input_bytes ELSE 0 END
        END
      ), 0) AS bytes
      FROM chat_attachments
      WHERE pane_id = ?1
    `).get(paneId));
    const global = bytesRowSchema.parse(this.#database.query(`
      SELECT COALESCE(SUM(
        CASE WHEN provider_bytes IS NULL
          THEN expected_input_bytes
          ELSE provider_bytes + COALESCE(preview_bytes, 0)
            + CASE WHEN source_retained = 1
                THEN expected_input_bytes ELSE 0 END
        END
      ), 0) AS bytes
      FROM chat_attachments
    `).get());
    if (pane.bytes + addedBytes > CHAT_ATTACHMENT_MAX_PANE_READY_BYTES) {
      throw quota("Attachment bytes exceed this pane's private vault quota.");
    }
    if (global.bytes + addedBytes > CHAT_ATTACHMENT_MAX_GLOBAL_READY_BYTES) {
      throw quota("Attachment bytes exceed the private vault quota.");
    }
  }

  #assertFinalByteQuota(
    row: AttachmentRow,
    finalBytes: number,
    previewBytes: number,
  ): void {
    this.#assertStorageAdmissionSafe();
    const pane = bytesRowSchema.parse(this.#database.query(`
      SELECT COALESCE(SUM(
        CASE WHEN provider_bytes IS NULL
          THEN expected_input_bytes
          ELSE provider_bytes + COALESCE(preview_bytes, 0)
            + CASE WHEN source_retained = 1
                THEN expected_input_bytes ELSE 0 END
        END
      ), 0) AS bytes
      FROM chat_attachments
      WHERE pane_id = ?1 AND attachment_id != ?2
    `).get(row.pane_id, row.attachment_id));
    const global = bytesRowSchema.parse(this.#database.query(`
      SELECT COALESCE(SUM(
        CASE WHEN provider_bytes IS NULL
          THEN expected_input_bytes
          ELSE provider_bytes + COALESCE(preview_bytes, 0)
            + CASE WHEN source_retained = 1
                THEN expected_input_bytes ELSE 0 END
        END
      ), 0) AS bytes
      FROM chat_attachments
      WHERE attachment_id != ?1
    `).get(row.attachment_id));
    const ownedBytes = row.kind === "image"
      ? row.expected_input_bytes + finalBytes + previewBytes
      : finalBytes;
    if (pane.bytes + ownedBytes > CHAT_ATTACHMENT_MAX_PANE_READY_BYTES) {
      throw quota("Normalized attachment exceeds this pane's private vault quota.");
    }
    if (global.bytes + ownedBytes > CHAT_ATTACHMENT_MAX_GLOBAL_READY_BYTES) {
      throw quota("Normalized attachment exceeds the private vault quota.");
    }
  }

  #assertStorageAdmissionSafe(): void {
    const quarantines = countRowSchema.parse(this.#database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_storage_quarantines
    `).get());
    if (quarantines.count !== 0) {
      throw new ChatAttachmentVaultError(
        "unsafe_filesystem",
        "Attachment admissions are fenced by unresolved storage custody.",
      );
    }
  }

  #assertSameBegin(
    row: AttachmentRow,
    input: Readonly<{
      paneId: string;
      attachmentId: string;
      uploadId: string;
      kind: "image" | "file";
      displayName: string;
      declaredMediaType: string;
      expectedBytes: number;
      suffix: string;
    }>,
  ): void {
    if (
      row.pane_id !== input.paneId ||
      row.attachment_id !== input.attachmentId ||
      row.upload_id !== input.uploadId ||
      row.kind !== input.kind ||
      row.display_name !== input.displayName ||
      row.declared_media_type !== input.declaredMediaType ||
      row.expected_input_bytes !== input.expectedBytes ||
      row.internal_suffix !== input.suffix
    ) {
      throw conflict("Attachment begin input changed under an existing identity.");
    }
  }

  #assertSameChunk(
    row: ChunkRow,
    input: Readonly<{
      paneId: string;
      uploadId: string;
      expectedRevision: number;
      digest: string;
      bytes: number;
    }>,
  ): void {
    if (
      row.pane_id !== input.paneId ||
      row.upload_id !== input.uploadId ||
      row.request_revision !== input.expectedRevision ||
      row.sha256 !== input.digest ||
      row.byte_length !== input.bytes
    ) {
      throw conflict("Attachment chunk replay changed its admitted bytes.");
    }
  }

  #assertRowAuthority(
    row: AttachmentRow,
    paneId: string,
    uploadId: string,
  ): void {
    if (row.pane_id !== paneId || row.upload_id !== uploadId) throw notFound();
  }

  #assertBindingAuthority(
    row: ProviderBindingRow,
    paneId: string,
    bindingKeyDigest: string,
  ): void {
    if (row.pane_id !== paneId || row.binding_key_digest !== bindingKeyDigest) {
      throw notFound();
    }
  }

  #row(attachmentId: string): AttachmentRow | null {
    const row: unknown = this.#database.query(`
      SELECT * FROM chat_attachments WHERE attachment_id = ?1
    `).get(attachmentId);
    return row === null ? null : attachmentRowSchema.parse(row);
  }

  #requireRow(attachmentId: string): AttachmentRow {
    const row = this.#row(attachmentId);
    if (row === null) throw notFound();
    return row;
  }

  #rowByEitherIdentity(attachmentId: string, uploadId: string): AttachmentRow | null {
    const row: unknown = this.#database.query(`
      SELECT * FROM chat_attachments
      WHERE attachment_id = ?1 OR upload_id = ?2
      LIMIT 1
    `).get(attachmentId, uploadId);
    return row === null ? null : attachmentRowSchema.parse(row);
  }

  #chunk(
    attachmentId: string,
    ordinal: number,
    requestRevision: number,
  ): ChunkRow | null {
    const row: unknown = this.#database.query(`
      SELECT * FROM chat_attachment_upload_chunks
      WHERE attachment_id = ?1 AND ordinal = ?2 AND request_revision = ?3
    `).get(attachmentId, ordinal, requestRevision);
    return row === null ? null : chunkRowSchema.parse(row);
  }

  #requireChunk(
    attachmentId: string,
    ordinal: number,
    requestRevision: number,
  ): ChunkRow {
    const row = this.#chunk(attachmentId, ordinal, requestRevision);
    if (row === null) throw invalidState("Attachment chunk receipt is missing.");
    return row;
  }

  #requirePreparedChunk(attachmentId: string, ordinal: number): ChunkRow {
    const value: unknown = this.#database.query(`
      SELECT * FROM chat_attachment_upload_chunks
      WHERE attachment_id = ?1 AND ordinal = ?2 AND state = 'prepared'
      LIMIT 1
    `).get(attachmentId, ordinal);
    if (value === null) throw invalidState("Prepared attachment chunk receipt is missing.");
    return chunkRowSchema.parse(value);
  }

  #committedChunk(attachmentId: string, ordinal: number): ChunkRow | null {
    const value: unknown = this.#database.query(`
      SELECT * FROM chat_attachment_upload_chunks
      WHERE attachment_id = ?1 AND ordinal = ?2 AND state = 'committed'
      LIMIT 1
    `).get(attachmentId, ordinal);
    return value === null ? null : chunkRowSchema.parse(value);
  }

  #providerBinding(bindingId: string): ProviderBindingRow | null {
    const row: unknown = this.#database.query(`
      SELECT * FROM chat_provider_attachment_bindings WHERE binding_id = ?1
    `).get(bindingId);
    return row === null ? null : providerBindingRowSchema.parse(row);
  }

  #paneLifecycle(paneId: string): z.infer<typeof paneLifecycleRowSchema> {
    const row: unknown = this.#database.query(`
      SELECT archived_at FROM chat_panes WHERE pane_id = ?1
    `).get(paneId);
    if (row === null) throw notFound();
    return paneLifecycleRowSchema.parse(row);
  }

  #paneArchiveIntent(paneId: string): PaneArchiveIntentRow | null {
    const row: unknown = this.#database.query(`
      SELECT * FROM chat_attachment_pane_archive_intents WHERE pane_id = ?1
    `).get(paneId);
    return row === null ? null : paneArchiveIntentRowSchema.parse(row);
  }

  #requirePaneArchiveIntent(paneId: string): PaneArchiveIntentRow {
    const row = this.#paneArchiveIntent(paneId);
    if (row === null) {
      throw invalidState("Pane archive has no durable attachment cleanup intent.");
    }
    return row;
  }

  #privacyIntent(paneId: string): PrivacyIntentRow | null {
    const row: unknown = this.#database.query(`
      SELECT * FROM chat_attachment_privacy_deletion_intents WHERE pane_id = ?1
    `).get(paneId);
    return row === null ? null : privacyIntentRowSchema.parse(row);
  }

  #assertExactAccountContainedProviderArchiveIntent(
    paneId: string,
    containmentDigest: string,
  ): AccountContainedProviderArchiveIntentRow | null {
    const row: unknown = this.#database.query(`
      SELECT generation_contained, generation_containment_receipt
      FROM chat_provider_thread_archive_intents
      WHERE pane_id = ?1 AND state = 'account_contained'
    `).get(paneId);
    if (row === null) return null;
    const intent = accountContainedProviderArchiveIntentRowSchema.parse(row);
    if (
      digestOpaqueReceipt(
        intent.generation_containment_receipt,
        "Attachment privacy-deletion containment receipt",
      ) !== containmentDigest
    ) {
      throw conflict("Provider account-containment authority changed.");
    }
    return intent;
  }

  #assertNoProviderThreadArchiveAuthorityV57(paneId: string): void {
    const authority = countRowSchema.parse(this.#database.query(`
      SELECT COUNT(*) AS count
      FROM (
        SELECT target_id AS authority_id
        FROM chat_provider_thread_archive_targets_v57
        WHERE pane_id = ?1
        UNION ALL
        SELECT member_id AS authority_id
        FROM chat_provider_thread_archive_cut_members_v57
        WHERE pane_id = ?1
      )
    `).get(paneId));
    if (authority.count !== 0) {
      throw invalidState(
        "Provider thread archive v57 authority already owns pane containment.",
      );
    }
    this.#assertNoCutlessEffectStartedProviderThreadArchiveSourceV57(paneId);
    this.#assertNoActiveProviderThreadArchiveSourceCutV57(paneId);
  }

  #assertNoProviderThreadArchiveMutationAuthorityV57(paneId: string): void {
    const authority = countRowSchema.parse(this.#database.query(`
      SELECT (
        SELECT COUNT(*)
        FROM chat_provider_thread_archive_targets_v57
        WHERE pane_id = ?1
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
      ) AS count
    `).get(paneId));
    if (authority.count !== 0) {
      throw invalidState(
        "Provider thread archive v57 authority freezes attachment mutation.",
      );
    }
    this.#assertNoCutlessEffectStartedProviderThreadArchiveSourceV57(paneId);
    this.#assertNoActiveProviderThreadArchiveSourceCutV57(paneId);
  }

  #providerThreadArchiveMutationFencedV57(paneId: string): boolean {
    try {
      this.#assertNoProviderThreadArchiveMutationAuthorityV57(paneId);
      return false;
    } catch (error: unknown) {
      if (
        error instanceof ChatAttachmentVaultError &&
        error.code === "invalid_state"
      ) {
        return true;
      }
      throw error;
    }
  }

  #providerThreadArchivePrivacyFencedV57(paneId: string): boolean {
    try {
      this.#assertNoProviderThreadArchiveAuthorityV57(paneId);
      return false;
    } catch (error: unknown) {
      if (
        error instanceof ChatAttachmentVaultError &&
        error.code === "invalid_state"
      ) {
        return true;
      }
      throw error;
    }
  }

  #assertNoCutlessEffectStartedProviderThreadArchiveSourceV57(
    paneId: string,
  ): void {
    const paneValue: unknown = this.#database.query(`
      SELECT pane_id, account_profile_id, provider_account_profile_id,
        provider_thread_id, provider_restart_thread_id, interaction_mode,
        active_turn_id, active_provider_turn_id, visited_account_ids_json
      FROM chat_panes WHERE pane_id = ?1
    `).get(paneId);
    if (paneValue === null) throw notFound();
    const pane = providerArchivePrivacyPaneRowSchema.parse(paneValue);
    const providerIdentity = [
      pane.provider_account_profile_id,
      pane.provider_thread_id,
      pane.provider_restart_thread_id,
    ];
    if (providerIdentity.every((value) => value === null)) return;
    if (providerIdentity.some((value) => value === null)) {
      throw invalidState(
        "The pane retained only part of its provider-thread identity.",
      );
    }
    const accountProfileId = pane.provider_account_profile_id;
    if (accountProfileId === null) {
      throw invalidState("The pane lacks exact provider-account ownership.");
    }
    const sourceGeneration = this.#providerThreadArchiveSourceGenerationV57(
      pane,
    );
    const effects = countRowSchema.parse(this.#database.query(`
      SELECT COUNT(*) AS count
      FROM chat_provider_thread_archive_targets_v57 AS target
      JOIN chat_provider_thread_archive_attempts_v57 AS attempt
        ON attempt.attempt_id = target.current_attempt_id
        AND attempt.target_id = target.target_id
        AND attempt.ordinal = target.current_attempt_ordinal
      WHERE target.account_profile_id = ?1
        AND attempt.generation = ?2
        AND attempt.state = 'effect_started'
        AND attempt.cut_id IS NULL
    `).get(accountProfileId, sourceGeneration));
    if (effects.count !== 0) {
      throw invalidState(
        "A cutless provider archive effect owns this source generation.",
      );
    }
  }

  #assertNoActiveProviderThreadArchiveSourceCutV57(paneId: string): void {
    const paneValue: unknown = this.#database.query(`
      SELECT pane_id, account_profile_id, provider_account_profile_id,
        provider_thread_id, provider_restart_thread_id, interaction_mode,
        active_turn_id, active_provider_turn_id, visited_account_ids_json
      FROM chat_panes WHERE pane_id = ?1
    `).get(paneId);
    if (paneValue === null) throw notFound();
    const pane = providerArchivePrivacyPaneRowSchema.parse(paneValue);
    const providerIdentity = [
      pane.provider_account_profile_id,
      pane.provider_thread_id,
      pane.provider_restart_thread_id,
    ];
    if (providerIdentity.every((value) => value === null)) return;
    if (providerIdentity.some((value) => value === null)) {
      throw invalidState(
        "The pane retained only part of its provider-thread identity.",
      );
    }
    const cutValues: unknown[] = this.#database.query(`
      SELECT cut_id, account_profile_id, source_generation, cause, state
      FROM chat_provider_thread_archive_cuts_v57
      WHERE account_profile_id = ?1 AND state IN (
        'fence_started', 'fenced', 'sealed', 'removal_awaiting_tombstone'
      )
      ORDER BY cut_id LIMIT 2
    `).all(pane.provider_account_profile_id);
    if (cutValues.length === 0) return;
    if (cutValues.length !== 1) {
      throw invalidState(
        "The provider account retained multiple active archive-containment cuts.",
      );
    }
    const cut = providerArchivePrivacyCutRowSchema.parse(cutValues[0]);
    if (cut.cause === "account_removal") {
      throw invalidState(
        "Provider thread archive v57 authority already owns pane containment.",
      );
    }
    if (this.#providerThreadArchiveSourceGenerationV57(pane) ===
      cut.source_generation) {
      throw invalidState(
        "Provider thread archive v57 authority already owns pane containment.",
      );
    }
  }

  #providerThreadArchiveSourceGenerationV57(
    pane: ProviderArchivePrivacyPaneRow,
  ): number {
    const accountProfileId = pane.provider_account_profile_id;
    const restartThreadId = pane.provider_restart_thread_id;
    if (accountProfileId === null || restartThreadId === null) {
      throw invalidState(
        "The pane lacks exact provider source-generation ownership.",
      );
    }
    if (pane.interaction_mode === "harnessObserver") {
      if (pane.account_profile_id !== accountProfileId) {
        throw invalidState(
          "The Harness pane disagrees about its provider account.",
        );
      }
      const values: unknown[] = this.#database.query(`
        SELECT session.live_generation AS generation
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
          AND session.actor_id = actor.actor_id
          AND session.account_profile_id = ?2
          AND incarnation.account_profile_id = ?2
          AND session.admission_generation = incarnation.process_generation
          AND session.provider_thread_id = ?3
          AND incarnation.provider_thread_id = ?3
        ORDER BY incarnation.incarnation_id
        LIMIT 2
      `).all(pane.pane_id, accountProfileId, restartThreadId);
      if (values.length !== 1) {
        throw invalidState(
          "The Harness pane lacks one exact provider source-generation owner.",
        );
      }
      return providerArchivePrivacyHarnessGenerationRowSchema.parse(
        values[0],
      ).generation;
    }
    let visitedAccounts: readonly string[];
    try {
      visitedAccounts = providerArchivePrivacyVisitedAccountsSchema.parse(
        JSON.parse(pane.visited_account_ids_json) as unknown,
      );
    } catch {
      throw invalidState("Stored provider-account ownership is invalid.");
    }
    const owner = visitedAccounts.at(-1) ?? (
      pane.active_provider_turn_id === null ? null : accountProfileId
    );
    if (owner !== accountProfileId || pane.active_turn_id === null) {
      throw invalidState(
        "The pane lacks exact provider source-generation ownership.",
      );
    }
    const routeValue: unknown = this.#database.query(`
      SELECT accepted_generation, catalog_generation, effect_started_at
      FROM harness_root_turn_routing_receipts
      WHERE pane_id = ?1 AND chat_turn_id = ?2
    `).get(pane.pane_id, pane.active_turn_id);
    if (routeValue === null) {
      throw invalidState(
        "The pane lost its exact provider source-generation route.",
      );
    }
    const route = providerArchivePrivacyRouteRowSchema.parse(routeValue);
    const generation = route.accepted_generation ?? (
      route.effect_started_at === null ? null : route.catalog_generation
    );
    if (generation === null) {
      throw invalidState(
        "The pane route lacks accepted or effect-started generation authority.",
      );
    }
    return generation;
  }

  #hasPrivacyTombstone(paneId: string): boolean {
    return countRowSchema.parse(this.#database.query(`
      SELECT COUNT(*) AS count
      FROM chat_attachment_privacy_tombstones
      WHERE pane_id = ?1
    `).get(paneId)).count === 1;
  }

  #requirePrivacyIntent(paneId: string): PrivacyIntentRow {
    const row = this.#privacyIntent(paneId);
    if (row === null) {
      throw invalidState("Pane privacy deletion has no durable cleanup intent.");
    }
    return row;
  }

  #requireProviderBinding(bindingId: string): ProviderBindingRow {
    const row = this.#providerBinding(bindingId);
    if (row === null) throw notFound();
    return row;
  }

  #deletionReceipt(attachmentId: string): Readonly<{
    attachment_id: string;
    upload_id: string;
    reason: string;
  }> | null {
    return this.#database.query<{
      attachment_id: string;
      upload_id: string;
      reason: string;
    }, [string]>(`
      SELECT attachment_id, upload_id, reason
      FROM chat_attachment_deletion_receipts
      WHERE attachment_id = ?1
    `).get(attachmentId);
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const ready = this.#mutationTail;
    let release: (() => void) | undefined;
    this.#mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return ready.then(operation).finally(() => release?.());
  }
}

function parseCanonicalProviderThreadArchiveTargetIdsV57(
  values: readonly string[],
): readonly string[] {
  let targetIds: string[];
  try {
    targetIds = z.array(providerThreadArchiveTargetIdSchemaV57).parse(values);
  } catch {
    throw invalidState(
      "Provider thread archive terminal target snapshot is invalid.",
    );
  }
  const canonical = [...targetIds].sort(compareCanonicalCodeUnitsV57);
  if (
    new Set(targetIds).size !== targetIds.length ||
    !canonicalStringArraysEqualV57(targetIds, canonical)
  ) {
    throw invalidState(
      "Provider thread archive terminal target snapshot is not canonical.",
    );
  }
  return Object.freeze(targetIds);
}

function compareCanonicalCodeUnitsV57(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalStringArraysEqualV57(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length && left.every((value, index) =>
    value === right[index]
  );
}

function metadata(row: AttachmentRow): ChatAttachmentMetadata {
  return {
    id: row.attachment_id,
    revision: row.revision,
    kind: row.kind,
    displayName: row.display_name,
    mediaType: row.effective_media_type ?? row.declared_media_type,
    bytes: row.provider_bytes ?? row.received_input_bytes,
    state: row.state === "creating" || row.state === "receiving"
      ? "uploading"
      : row.state === "normalizing" || row.state === "publishing" || row.state === "deleting"
      ? "processing"
      : row.state,
    previewAvailable: row.state === "ready" && row.kind === "image",
  };
}

function providerDescriptor(
  row: AttachmentRow,
  verified: VerifiedVaultFile,
): ChatAttachmentProviderDescriptor {
  if (row.effective_media_type === null) {
    throw invalidState("Provider attachment has no effective media type.");
  }
  return {
    attachmentId: row.attachment_id,
    kind: row.kind,
    displayName: row.display_name,
    mediaType: row.effective_media_type,
    bytes: verified.bytes,
    sha256: verified.sha256,
    readPath: verified.path,
  };
}

function imageReceipt(row: AttachmentRow): NativeImageNormalizerReceipt {
  if (
    row.kind !== "image" ||
    row.source_media_type === null ||
    row.width === null ||
    row.height === null ||
    row.canonical_bytes === null ||
    row.canonical_sha256 === null ||
    row.preview_bytes === null ||
    row.preview_width === null ||
    row.preview_height === null ||
    row.preview_sha256 === null
  ) {
    throw invalidState("Normalized image receipt is incomplete.");
  }
  return {
    schemaVersion: 1,
    mediaType: row.source_media_type,
    sourceBytes: row.expected_input_bytes,
    canonical: {
      width: row.width,
      height: row.height,
      bytes: row.canonical_bytes,
      sha256: row.canonical_sha256,
    },
    preview: {
      width: row.preview_width,
      height: row.preview_height,
      bytes: row.preview_bytes,
      sha256: row.preview_sha256,
    },
  };
}

function providerResult(
  row: ProviderBindingRow,
  changed: boolean,
): ChatAttachmentProviderLeaseResult {
  return {
    bindingId: row.binding_id,
    revision: row.revision,
    state: row.state,
    changed,
  };
}

function parseBoundedDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 30 * 24 * 60 * 60 * 1_000) {
    throw new ChatAttachmentVaultError("invalid_input", `${label} is invalid.`);
  }
  return value;
}

function asCorrupt(error: unknown): ChatAttachmentVaultError {
  if (error instanceof ChatAttachmentVaultError && error.code === "invalid_input") {
    return error;
  }
  return new ChatAttachmentVaultError(
    "corrupt",
    "Attachment bytes could not be verified safely.",
  );
}

function conflict(message: string): ChatAttachmentVaultError {
  return new ChatAttachmentVaultError("conflict", message);
}

function invalidState(message: string): ChatAttachmentVaultError {
  return new ChatAttachmentVaultError("invalid_state", message);
}

function notFound(): ChatAttachmentVaultError {
  return new ChatAttachmentVaultError("not_found", "Attachment was not found.");
}

function quota(message: string): ChatAttachmentVaultError {
  return new ChatAttachmentVaultError("quota_exceeded", message);
}

function revisionConflict(): ChatAttachmentVaultError {
  return new ChatAttachmentVaultError(
    "revision_conflict",
    "Attachment revision changed.",
  );
}
