import type { Database } from "bun:sqlite";
import {
  HRA_PROMOTION_MAX_REQUEST_BYTES,
  acceptHRAPromotionBatchRequestSchema,
  createUuidV7,
  promotionBatchReceiptPageSchema,
  serializedHRAPromotionRequestBytes,
  taskDomain,
  uuidV7Schema,
  workspacePromotionStateV2Schema,
  type PromotionBatchReceiptV2,
  type PromotionBatchV2,
  type PromotionCleanupProgress,
  type PromotionEntity,
  type PromotionManifestV2,
  type WorkspacePromotionStateV2,
} from "@hraness/agent-tasks-protocol";
import { z } from "@hra-internal/schema";
import { createHash, randomBytes } from "node:crypto";

import {
  LocalPromotionError,
  cloudAuthority,
  localPromotionAuthorityOverlaySchema,
  localPromotionFaultCodeSchema,
  localPromotionProgressSchema,
  localPromotionRecoveryCopySchema,
  type FrozenLocalPromotion,
  type LocalPromotionAuthorityOverlay,
  type LocalPromotionCheckpoint,
  type LocalPromotionFaultInjector,
  type LocalPromotionIdempotencyKeyStore,
  type LocalPromotionProgress,
  type LocalPromotionRecoveryCopy,
  type PreparedLocalPromotionBatch,
} from "../promotion/contracts";
import {
  buildLocalPromotionSnapshotWithinTransaction,
} from "../promotion/source-snapshot";

const sessionStateSchema = z.enum([
  "snapshot_frozen",
  "starting",
  "staging",
  "uploading",
  "receiving",
  "validating",
  "projecting",
  "ready",
  "activating",
  "outcome_unknown",
  "aborting",
  "activated",
  "aborted",
]);

const MAX_RECEIPT_AUDIT_PAGES = Math.ceil(
  taskDomain.MAX_PROMOTION_BATCH_RECEIPTS /
    taskDomain.MAX_PROMOTION_RECEIPT_PAGE_SIZE,
);
const receiptAuditCursorFingerprintSchema = z.string()
  .length(22)
  .regex(/^[A-Za-z0-9_-]+$/u);
const persistedReceiptAuditStateSchema = z.object({
  version: z.literal(1),
  cursorFingerprints: z.array(receiptAuditCursorFingerprintSchema)
    .max(MAX_RECEIPT_AUDIT_PAGES - 1),
}).strict().superRefine((state, context) => {
  if (
    new Set(state.cursorFingerprints).size !==
      state.cursorFingerprints.length
  ) {
    context.addIssue({
      code: "custom",
      message: "receipt audit cursors must be unique",
      path: ["cursorFingerprints"],
    });
  }
});
type PersistedReceiptAuditState = z.infer<
  typeof persistedReceiptAuditStateSchema
>;
const persistedReceiptAuditStateJsonSchema = z.string().min(1).max(65_536);

const sessionRowSchema = z.object({
  promotion_id: taskDomain.promotionIdSchema,
  schema_version: z.union([z.literal(1), z.literal(2)]),
  workspace_id: taskDomain.workspacePublicIdSchema,
  state: sessionStateSchema,
  destination_organization_id: z.string().min(1).max(256),
  staging_workspace_id: taskDomain.workspacePublicIdSchema.nullable(),
  cloud_workspace_id: taskDomain.workspacePublicIdSchema.nullable(),
  source_workspace_revision: taskDomain.revisionSchema,
  source_event_sequence: taskDomain.workspaceEventSequenceSchema,
  manifest_root_digest: taskDomain.sha256DigestSchema.nullable(),
  attempt_count: z.number().int().nonnegative().safe(),
  next_attempt_at: taskDomain.epochMsSchema.nullable(),
  fault_code: z.string().nullable(),
  lost_response_batch_id: taskDomain.promotionBatchIdSchema.nullable(),
  receipt_audit_cursor: persistedReceiptAuditStateJsonSchema.nullable(),
  created_at: taskDomain.epochMsSchema,
  updated_at: taskDomain.epochMsSchema,
}).strict();
type SessionRow = z.infer<typeof sessionRowSchema>;

const manifestRowSchema = z.object({
  manifest_json: z.string().min(2),
  entity_count: z.number().int().nonnegative().max(500_000),
  serialized_entity_bytes: z.number().int().nonnegative().safe(),
}).strict();

const familyRowSchema = z.object({
  family: taskDomain.promotionEntityFamilySchema,
  family_index: z.number().int().min(0)
    .max(taskDomain.promotionEntityFamilyValues.length - 1),
  snapshot_count: z.number().int().nonnegative().max(500_000),
  snapshot_digest: taskDomain.sha256DigestSchema,
  snapshot_last_identity: z.string().min(1).max(512).nullable(),
  accepted_batch_count: z.number().int().nonnegative().max(1_000_001),
  accepted_entity_count: z.number().int().nonnegative().max(500_000),
  accepted_digest: taskDomain.sha256DigestSchema,
  accepted_last_identity: z.string().min(1).max(512).nullable(),
  complete: z.union([z.literal(0), z.literal(1)]),
}).strict();
type FamilyRow = z.infer<typeof familyRowSchema>;

const outboundRowSchema = z.object({
  batch_id: taskDomain.promotionBatchIdSchema,
  request_json: z.string().min(2),
  request_bytes: z.number().int().positive().max(
    HRA_PROMOTION_MAX_REQUEST_BYTES,
  ),
  state: z.enum(["prepared", "in_flight", "lost_response", "accepted"]),
  receipt_audit_cursor: taskDomain.promotionReceiptAuditCursorSchema.nullable(),
}).strict();

const entityRowSchema = z.object({
  entity_json: z.string().min(2).max(HRA_PROMOTION_MAX_REQUEST_BYTES),
}).strict();

const receiptRowSchema = z.object({
  receipt_json: z.string().min(2),
}).strict();

const decisionRowSchema = z.object({
  decision: z.enum(["activated", "aborted_before_activation"]),
  receipt_json: z.string().min(2),
}).strict();

const pairingRowSchema = z.object({
  state: z.enum(["pending", "pairing", "paired", "blocked"]),
}).strict();

const runnerPairingRecordRowSchema = z.object({
  cloud_workspace_id: taskDomain.workspacePublicIdSchema,
  promotion_id: taskDomain.promotionIdSchema,
  source_workspace_id: taskDomain.workspacePublicIdSchema,
  installation_id: taskDomain.runnerInstallationIdSchema,
  state: z.enum(["pending", "pairing", "paired", "blocked"]),
  attempt_count: z.number().int().nonnegative().safe(),
  fault_code: z.string().min(1).max(128).nullable(),
  created_at: taskDomain.epochMsSchema,
  updated_at: taskDomain.epochMsSchema,
}).strict();

const recoveryRowSchema = z.object({
  promotion_id: taskDomain.promotionIdSchema,
  local_workspace_id: taskDomain.workspacePublicIdSchema,
  cloud_workspace_id: taskDomain.workspacePublicIdSchema,
  state: z.literal("read_only"),
  created_at: taskDomain.epochMsSchema,
  last_opened_at: taskDomain.epochMsSchema.nullable(),
}).strict();

const rejectionProofRowSchema = z.object({
  source_workspace_id: taskDomain.workspacePublicIdSchema,
  staging_workspace_id: taskDomain.workspacePublicIdSchema,
  manifest_root_digest: taskDomain.sha256DigestSchema,
  rejection_code: taskDomain.promotionRejectionCodeSchema,
  state_json: z.string().min(2).max(HRA_PROMOTION_MAX_REQUEST_BYTES),
  observed_at: taskDomain.epochMsSchema,
}).strict();

const workspaceAuthorityRowSchema = z.object({
  workspace_id: taskDomain.workspacePublicIdSchema,
  owner_installation_id: taskDomain.runnerInstallationIdSchema,
  authority_kind: z.enum(["local", "promoting", "cloud"]),
  promotion_id: taskDomain.promotionIdSchema.nullable(),
  authority_phase: z.enum([
    "snapshot_frozen",
    "staging",
    "uploading",
    "activating",
    "outcome_unknown",
  ]).nullable(),
  cloud_workspace_id: taskDomain.workspacePublicIdSchema.nullable(),
}).strict();

export interface LocalPromotionV2StoreOptions {
  readonly faultInjector?: LocalPromotionFaultInjector;
}

export interface OutstandingLocalPromotionBatch {
  readonly prepared: PreparedLocalPromotionBatch;
  readonly state: "prepared" | "in_flight" | "lost_response" | "accepted";
  readonly receiptAuditCursor: string | null;
}

export interface LocalRunnerPairingRecord {
  readonly cloudWorkspaceId: string;
  readonly promotionId: string;
  readonly sourceWorkspaceId: string;
  readonly installationId: string;
  readonly state: "pending" | "pairing" | "paired" | "blocked";
  readonly attemptCount: number;
  readonly faultCode: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export class LocalPromotionV2Store implements LocalPromotionIdempotencyKeyStore {
  readonly #database: Database;
  readonly #faultInjector: LocalPromotionFaultInjector | undefined;

  constructor(
    database: Database,
    options: LocalPromotionV2StoreOptions = {},
  ) {
    this.#database = database;
    this.#faultInjector = options.faultInjector;
  }

  freezeSourceSnapshot(inputValue: unknown): LocalPromotionProgress {
    const input = z.object({
      workspaceId: taskDomain.workspacePublicIdSchema,
      promotionId: taskDomain.promotionIdSchema,
      destinationOrganizationId: z.string().min(1).max(256),
      now: taskDomain.epochMsSchema,
    }).strict().parse(inputValue);
    try {
      return this.#database.transaction(() => {
        const existing = this.#session(input.promotionId);
        if (existing !== null) {
          if (
            existing.schema_version !== 2 ||
            existing.workspace_id !== input.workspaceId ||
            existing.destination_organization_id !==
              input.destinationOrganizationId
          ) {
            throw new LocalPromotionError("state_conflict");
          }
          return this.progress(input.promotionId);
        }
        const snapshot = buildLocalPromotionSnapshotWithinTransaction(
          this.#database,
          {
            workspaceId: input.workspaceId,
            promotionId: input.promotionId,
            now: input.now,
          },
        );
        this.#checkpoint("snapshot.after_read_before_persist");
        this.#database.query(`
          INSERT INTO local_promotion_sessions (
            promotion_id, schema_version, workspace_id, state,
            destination_organization_id, source_workspace_revision,
            source_event_sequence, manifest_root_digest, created_at, updated_at
          ) VALUES (?1, 2, ?2, 'snapshot_frozen', ?3, ?4, ?5, ?6, ?7, ?7)
        `).run(
          snapshot.manifest.promotionId,
          snapshot.manifest.sourceWorkspaceId,
          input.destinationOrganizationId,
          snapshot.manifest.sourceWorkspaceRevision,
          snapshot.manifest.sourceEventSequence,
          snapshot.manifest.rootDigest,
          input.now,
        );
        this.#database.query(`
          INSERT INTO local_promotion_manifests_v2 (
            promotion_id, manifest_json, entity_count,
            serialized_entity_bytes, created_at
          ) VALUES (?1, ?2, ?3, ?4, ?5)
        `).run(
          snapshot.manifest.promotionId,
          taskDomain.canonicalPromotionJson(snapshot.manifest),
          snapshot.entities.length,
          snapshot.serializedEntityBytes,
          input.now,
        );

        let entityCursor = 0;
        for (
          const [familyIndex, family] of
            taskDomain.promotionEntityFamilyValues.entries()
        ) {
          const familyEntities: PromotionEntity[] = [];
          while (snapshot.entities[entityCursor]?.family === family) {
            const entity = snapshot.entities[entityCursor];
            if (entity === undefined) break;
            familyEntities.push(entity);
            entityCursor += 1;
          }
          for (const [ordinal, entity] of familyEntities.entries()) {
            const entityJson = taskDomain.canonicalPromotionJson(entity);
            this.#database.query(`
              INSERT INTO local_promotion_snapshot_entities (
                promotion_id, family, family_ordinal, entity_identity,
                entity_json, serialized_bytes
              ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            `).run(
              snapshot.manifest.promotionId,
              family,
              ordinal,
              taskDomain.promotionEntityIdentity(entity),
              entityJson,
              new TextEncoder().encode(entityJson).length,
            );
          }
          const initialDigest = taskDomain.promotionFamilyInitialDigest(family);
          const empty = familyEntities.length === 0;
          this.#database.query(`
            INSERT INTO local_promotion_family_progress_v2 (
              promotion_id, family, family_index, snapshot_count,
              snapshot_digest, snapshot_last_identity,
              accepted_batch_count, accepted_entity_count, accepted_digest,
              accepted_last_identity, complete
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0, ?7, NULL, ?8)
          `).run(
            snapshot.manifest.promotionId,
            family,
            familyIndex,
            familyEntities.length,
            snapshot.manifest.familyDigests[family],
            familyEntities.length === 0
              ? null
              : taskDomain.promotionEntityIdentity(
                  familyEntities[familyEntities.length - 1] as PromotionEntity,
                ),
            initialDigest,
            empty ? 1 : 0,
          );
        }
        this.#checkpoint("snapshot.after_entities_before_authority");
        const frozen = this.#database.query(`
          UPDATE local_workspaces
          SET authority_kind = 'promoting', promotion_id = ?2,
            authority_phase = 'snapshot_frozen', cloud_workspace_id = NULL,
            updated_at = ?3
          WHERE workspace_id = ?1 AND authority_kind = 'local'
            AND revision = ?4 AND event_sequence = ?5
        `).run(
          snapshot.manifest.sourceWorkspaceId,
          snapshot.manifest.promotionId,
          input.now,
          snapshot.manifest.sourceWorkspaceRevision,
          snapshot.manifest.sourceEventSequence,
        );
        if (frozen.changes !== 1) {
          throw new LocalPromotionError("authority_conflict");
        }
        return this.progress(input.promotionId);
      }).immediate();
    } catch (error: unknown) {
      if (error instanceof LocalPromotionError) throw error;
      if (
        error instanceof Error &&
        (
          error.message.includes("UNIQUE constraint failed") ||
          error.message.includes("CHECK constraint failed")
        )
      ) {
        throw new LocalPromotionError("state_conflict");
      }
      throw error;
    }
  }

  frozen(promotionIdValue: string): FrozenLocalPromotion {
    const session = this.#requireV2Session(promotionIdValue);
    return {
      manifest: this.#manifest(session.promotion_id),
      organizationId: session.destination_organization_id,
    };
  }

  markStarting(promotionIdValue: string, nowValue: number): LocalPromotionProgress {
    return this.#transition(
      promotionIdValue,
      ["snapshot_frozen", "starting"],
      "starting",
      "snapshot_frozen",
      nowValue,
    );
  }

  recordStart(
    promotionIdValue: string,
    responseValue: unknown,
    nowValue: number,
  ): LocalPromotionProgress {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    const response = z.object({
      promotionId: taskDomain.promotionIdSchema,
      stagingWorkspaceId: taskDomain.workspacePublicIdSchema,
      state: z.literal("receiving"),
    }).strict().parse(responseValue);
    const now = taskDomain.epochMsSchema.parse(nowValue);
    return this.#database.transaction(() => {
      const session = this.#requireV2Session(promotionId);
      if (
        response.promotionId !== promotionId ||
        response.stagingWorkspaceId === session.workspace_id ||
        !["snapshot_frozen", "starting", "receiving"].includes(session.state)
      ) {
        throw new LocalPromotionError("state_conflict");
      }
      if (
        session.staging_workspace_id !== null &&
        session.staging_workspace_id !== response.stagingWorkspaceId
      ) {
        throw new LocalPromotionError("receipt_conflict");
      }
      this.#database.query(`
        UPDATE local_promotion_sessions
        SET state = 'receiving', staging_workspace_id = ?2,
          attempt_count = 0, next_attempt_at = NULL, fault_code = NULL,
          updated_at = ?3
        WHERE promotion_id = ?1
      `).run(promotionId, response.stagingWorkspaceId, now);
      this.#setWorkspacePhase(session.workspace_id, "staging", now);
      return this.progress(promotionId);
    })();
  }

  prepareNextBatch(
    promotionIdValue: string,
    nowValue: number,
  ): PreparedLocalPromotionBatch | null {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    const now = taskDomain.epochMsSchema.parse(nowValue);
    return this.#database.transaction(() => {
      const session = this.#requireV2Session(promotionId);
      if (session.state !== "receiving") {
        throw new LocalPromotionError("state_conflict");
      }
      const existing = this.outstandingBatch(promotionId);
      if (existing !== null && existing.state !== "accepted") {
        return existing.prepared;
      }
      const family = this.#familyRows(promotionId)
        .find((row) => row.complete === 0);
      if (family === undefined) return null;

      const entityValues: unknown[] = this.#database.query(`
        SELECT entity_json
        FROM local_promotion_snapshot_entities
        WHERE promotion_id = ?1 AND family = ?2
          AND family_ordinal >= ?3
        ORDER BY family_ordinal
        LIMIT 500
      `).all(
        promotionId,
        family.family,
        family.accepted_entity_count,
      );
      const entities = entityValues.map((value) =>
        taskDomain.promotionEntitySchema.parse(
          parseJson(entityRowSchema.parse(value).entity_json),
        ));
      if (entities.length === 0) {
        throw new LocalPromotionError("snapshot_invalid");
      }

      let candidateItems = entities;
      let batch = this.#batchFor(family, candidateItems, promotionId);
      let requestBytes = serializedHRAPromotionRequestBytes({ batch });
      while (
        requestBytes > HRA_PROMOTION_MAX_REQUEST_BYTES &&
        candidateItems.length > 1
      ) {
        candidateItems = candidateItems.slice(
          0,
          Math.max(1, Math.floor(candidateItems.length / 2)),
        );
        batch = this.#batchFor(family, candidateItems, promotionId);
        requestBytes = serializedHRAPromotionRequestBytes({ batch });
      }
      if (requestBytes > HRA_PROMOTION_MAX_REQUEST_BYTES) {
        throw new LocalPromotionError("snapshot_capacity_exceeded");
      }
      const request = acceptHRAPromotionBatchRequestSchema.parse({ batch });
      this.#database.query(`
        INSERT INTO local_promotion_outbound_batches_v2 (
          promotion_id, batch_id, family, ordinal, request_digest,
          request_json, request_bytes, state, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'prepared', ?8, ?8)
      `).run(
        promotionId,
        batch.batchId,
        batch.family,
        batch.ordinal,
        batch.requestDigest,
        taskDomain.canonicalPromotionJson(request),
        requestBytes,
        now,
      );
      this.#checkpoint("batch.after_prepare");
      return { batch, serializedBytes: requestBytes };
    })();
  }

  outstandingBatch(
    promotionIdValue: string,
  ): OutstandingLocalPromotionBatch | null {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    const value: unknown = this.#database.query(`
      SELECT batch_id, request_json, request_bytes, state, receipt_audit_cursor
      FROM local_promotion_outbound_batches_v2
      WHERE promotion_id = ?1 AND state <> 'accepted'
      ORDER BY created_at, batch_id
      LIMIT 1
    `).get(promotionId);
    const row = outboundRowSchema.nullable().parse(value);
    if (row === null) return null;
    const request = acceptHRAPromotionBatchRequestSchema.parse(
      parseJson(row.request_json),
    );
    return {
      prepared: {
        batch: request.batch,
        serializedBytes: row.request_bytes,
      },
      state: row.state,
      receiptAuditCursor: row.receipt_audit_cursor,
    };
  }

  markBatchInFlight(
    promotionIdValue: string,
    batchIdValue: string,
    nowValue: number,
  ): void {
    this.#setBatchState(
      promotionIdValue,
      batchIdValue,
      ["prepared", "in_flight", "lost_response"],
      "in_flight",
      null,
      nowValue,
    );
  }

  markBatchLostResponse(
    promotionIdValue: string,
    batchIdValue: string,
    nowValue: number,
  ): void {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    const batchId = taskDomain.promotionBatchIdSchema.parse(batchIdValue);
    const now = taskDomain.epochMsSchema.parse(nowValue);
    this.#database.transaction(() => {
      this.#setBatchState(
        promotionId,
        batchId,
        ["in_flight", "lost_response"],
        "lost_response",
        null,
        now,
      );
      this.#database.query(`
        UPDATE local_promotion_sessions
        SET lost_response_batch_id = ?2, receipt_audit_cursor = NULL,
          updated_at = ?3
        WHERE promotion_id = ?1
      `).run(promotionId, batchId, now);
    })();
  }

  advanceReceiptAudit(
    promotionIdValue: string,
    batchIdValue: string,
    pageValue: unknown,
    nowValue: number,
  ): PromotionBatchReceiptV2 | null {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    const batchId = taskDomain.promotionBatchIdSchema.parse(batchIdValue);
    const page = promotionBatchReceiptPageSchema.parse(pageValue);
    const now = taskDomain.epochMsSchema.parse(nowValue);
    if (page.promotionId !== promotionId) {
      throw new LocalPromotionError("receipt_conflict");
    }
    const matching = page.items.find((receipt) => receipt.batchId === batchId);
    if (matching !== undefined) return matching;
    this.#database.transaction(() => {
      const outstanding = this.outstandingBatch(promotionId);
      if (
        outstanding === null ||
        outstanding.prepared.batch.batchId !== batchId ||
        outstanding.state !== "lost_response"
      ) {
        throw new LocalPromotionError("state_conflict");
      }
      if (page.hasMore) {
        if (page.cursor === null) {
          throw new LocalPromotionError("receipt_conflict");
        }
        const session = this.#requireV2Session(promotionId);
        if (session.lost_response_batch_id !== batchId) {
          throw new LocalPromotionError("state_conflict");
        }
        const audit = parsePersistedReceiptAuditState(
          session.receipt_audit_cursor,
        );
        if (
          outstanding.receiptAuditCursor !== null &&
          !audit.cursorFingerprints.includes(
            receiptAuditCursorFingerprint(outstanding.receiptAuditCursor),
          )
        ) {
          throw new LocalPromotionError("receipt_conflict");
        }
        const fingerprint = receiptAuditCursorFingerprint(page.cursor);
        if (
          audit.cursorFingerprints.includes(fingerprint) ||
          audit.cursorFingerprints.length >= MAX_RECEIPT_AUDIT_PAGES - 1
        ) {
          throw new LocalPromotionError("receipt_conflict");
        }
        const nextAudit = persistedReceiptAuditStateSchema.parse({
          version: 1,
          cursorFingerprints: [
            ...audit.cursorFingerprints,
            fingerprint,
          ],
        });
        this.#database.query(`
          UPDATE local_promotion_outbound_batches_v2
          SET receipt_audit_cursor = ?3, updated_at = ?4
          WHERE promotion_id = ?1 AND batch_id = ?2
        `).run(promotionId, batchId, page.cursor, now);
        this.#database.query(`
          UPDATE local_promotion_sessions
          SET receipt_audit_cursor = ?2, updated_at = ?3
          WHERE promotion_id = ?1
        `).run(
          promotionId,
          persistedReceiptAuditStateJsonSchema.parse(
            JSON.stringify(nextAudit),
          ),
          now,
        );
      } else {
        this.#database.query(`
          UPDATE local_promotion_outbound_batches_v2
          SET state = 'prepared', receipt_audit_cursor = NULL, updated_at = ?3
          WHERE promotion_id = ?1 AND batch_id = ?2
        `).run(promotionId, batchId, now);
        this.#database.query(`
          UPDATE local_promotion_sessions
          SET lost_response_batch_id = NULL, receipt_audit_cursor = NULL,
            updated_at = ?2
          WHERE promotion_id = ?1
        `).run(promotionId, now);
      }
    })();
    return null;
  }

  recordBatchAcceptance(
    batchValue: unknown,
    receiptValue: unknown,
  ): LocalPromotionProgress {
    const acceptance = taskDomain.promotionBatchAcceptanceV2Schema.parse({
      batch: batchValue,
      receipt: receiptValue,
    });
    return this.#database.transaction(() => {
      const session = this.#requireV2Session(acceptance.batch.promotionId);
      if (session.state !== "receiving") {
        throw new LocalPromotionError("state_conflict");
      }
      const existingValue: unknown = this.#database.query(`
        SELECT receipt_json FROM local_promotion_upload_receipts_v2
        WHERE promotion_id = ?1 AND batch_id = ?2
      `).get(acceptance.batch.promotionId, acceptance.batch.batchId);
      const existing = receiptRowSchema.nullable().parse(existingValue);
      if (existing !== null) {
        const stored = taskDomain.promotionBatchReceiptV2Schema.parse(
          parseJson(existing.receipt_json),
        );
        if (
          taskDomain.canonicalPromotionJson(stored) !==
          taskDomain.canonicalPromotionJson(acceptance.receipt)
        ) {
          throw new LocalPromotionError("receipt_conflict");
        }
        return this.progress(acceptance.batch.promotionId);
      }
      const outstanding = this.outstandingBatch(acceptance.batch.promotionId);
      if (
        outstanding === null ||
        taskDomain.canonicalPromotionJson(outstanding.prepared.batch) !==
          taskDomain.canonicalPromotionJson(acceptance.batch)
      ) {
        throw new LocalPromotionError("receipt_conflict");
      }
      const family = this.#familyRow(
        acceptance.batch.promotionId,
        acceptance.batch.family,
      );
      if (
        family.complete === 1 ||
        acceptance.batch.ordinal !== family.accepted_batch_count ||
        acceptance.batch.previousFamilyCount !== family.accepted_entity_count ||
        acceptance.batch.previousFamilyDigest !== family.accepted_digest ||
        acceptance.batch.previousEntityIdentity !==
          family.accepted_last_identity
      ) {
        throw new LocalPromotionError("receipt_conflict");
      }
      const expectedCounts = Object.fromEntries(
        this.#familyRows(acceptance.batch.promotionId).map((row) => [
          row.family,
          row.family === acceptance.batch.family
            ? acceptance.receipt.cumulativeFamilyCount
            : row.accepted_entity_count,
        ]),
      ) as Record<string, number>;
      for (const expectedFamily of taskDomain.promotionEntityFamilyValues) {
        if (
          acceptance.receipt.cumulativeCounts[expectedFamily] !==
          expectedCounts[expectedFamily]
        ) {
          throw new LocalPromotionError("receipt_conflict");
        }
      }
      const completesFamily =
        acceptance.receipt.cumulativeFamilyCount === family.snapshot_count;
      if (
        acceptance.receipt.cumulativeFamilyCount > family.snapshot_count ||
        (
          completesFamily &&
          (
            acceptance.receipt.cumulativeFamilyDigest !==
              family.snapshot_digest ||
            acceptance.receipt.lastEntityIdentity !==
              family.snapshot_last_identity
          )
        )
      ) {
        throw new LocalPromotionError("receipt_conflict");
      }
      const localUpdatedAt = Math.max(
        acceptance.receipt.acceptedAt,
        session.created_at,
        session.updated_at,
      );
      const sequence = z.object({
        count: z.number().int().nonnegative().safe(),
      }).strict().parse(this.#database.query(`
        SELECT count(*) AS count FROM local_promotion_upload_receipts_v2
        WHERE promotion_id = ?1
      `).get(acceptance.batch.promotionId)).count + 1;
      this.#database.query(`
        INSERT INTO local_promotion_upload_receipts_v2 (
          promotion_id, batch_id, family, ordinal, request_digest,
          cumulative_family_count, cumulative_family_digest, receipt_json,
          acceptance_sequence, accepted_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
      `).run(
        acceptance.batch.promotionId,
        acceptance.batch.batchId,
        acceptance.batch.family,
        acceptance.batch.ordinal,
        acceptance.batch.requestDigest,
        acceptance.receipt.cumulativeFamilyCount,
        acceptance.receipt.cumulativeFamilyDigest,
        taskDomain.canonicalPromotionJson(acceptance.receipt),
        sequence,
        acceptance.receipt.acceptedAt,
      );
      this.#checkpoint("batch.after_receipt_before_progress");
      this.#database.query(`
        UPDATE local_promotion_family_progress_v2
        SET accepted_batch_count = accepted_batch_count + 1,
          accepted_entity_count = ?3, accepted_digest = ?4,
          accepted_last_identity = ?5, complete = ?6
        WHERE promotion_id = ?1 AND family = ?2
      `).run(
        acceptance.batch.promotionId,
        acceptance.batch.family,
        acceptance.receipt.cumulativeFamilyCount,
        acceptance.receipt.cumulativeFamilyDigest,
        acceptance.receipt.lastEntityIdentity,
        completesFamily ? 1 : 0,
      );
      this.#database.query(`
        UPDATE local_promotion_outbound_batches_v2
        SET state = 'accepted', receipt_audit_cursor = NULL, updated_at = ?3
        WHERE promotion_id = ?1 AND batch_id = ?2
      `).run(
        acceptance.batch.promotionId,
        acceptance.batch.batchId,
        localUpdatedAt,
      );
      this.#database.query(`
        UPDATE local_promotion_sessions
        SET attempt_count = 0, next_attempt_at = NULL, fault_code = NULL,
          lost_response_batch_id = NULL, receipt_audit_cursor = NULL,
          updated_at = ?2
        WHERE promotion_id = ?1
      `).run(
        acceptance.batch.promotionId,
        localUpdatedAt,
      );
      this.#setWorkspacePhase(
        session.workspace_id,
        "uploading",
        localUpdatedAt,
      );
      return this.progress(acceptance.batch.promotionId);
    })();
  }

  recordRemoteState(
    promotionIdValue: string,
    stateValue: unknown,
    nowValue: number,
  ): LocalPromotionProgress {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    const remote = workspacePromotionStateV2Schema.parse(stateValue);
    const now = taskDomain.epochMsSchema.parse(nowValue);
    const session = this.#requireV2Session(promotionId);
    const manifest = this.#manifest(promotionId);
    if (
      remote.promotionId !== promotionId ||
      (
        remote.state !== "aborted" &&
        (
          remote.manifest.rootDigest !== manifest.rootDigest ||
          remote.stagingWorkspaceId !== session.staging_workspace_id
        )
      )
    ) {
      throw new LocalPromotionError("receipt_conflict");
    }
    if (remote.state === "activated") {
      return this.recordActivation(remote.activationReceipt);
    }
    if (remote.state === "aborted") {
      return this.recordAbort(remote.abortReceipt);
    }
    if (
      remote.state !== "receiving" &&
      !this.#allFamiliesComplete(promotionId)
    ) {
      throw new LocalPromotionError("receipt_conflict");
    }
    if (remote.state === "rejected") {
      return this.recordRemoteRejection(promotionId, remote, now);
    }
    const localState = remote.state;
    const phase = localState === "outcome_unknown"
      ? "outcome_unknown"
      : "uploading";
    return this.#database.transaction(() => {
      this.#database.query(`
        UPDATE local_promotion_sessions
        SET state = ?2, updated_at = ?3
        WHERE promotion_id = ?1 AND schema_version = 2
      `).run(promotionId, localState, now);
      this.#setWorkspacePhase(session.workspace_id, phase, now);
      return this.progress(promotionId);
    })();
  }

  recordRemoteRejection(
    promotionIdValue: string,
    stateValue: unknown,
    nowValue: number,
  ): LocalPromotionProgress {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    const remote = workspacePromotionStateV2Schema.parse(stateValue);
    const now = taskDomain.epochMsSchema.parse(nowValue);
    if (remote.state !== "rejected") {
      throw new LocalPromotionError("state_conflict");
    }
    const session = this.#requireV2Session(promotionId);
    const manifest = this.#manifest(promotionId);
    if (
      remote.promotionId !== promotionId ||
      remote.manifest.sourceWorkspaceId !== session.workspace_id ||
      remote.manifest.rootDigest !== manifest.rootDigest ||
      remote.stagingWorkspaceId !== session.staging_workspace_id ||
      !this.#allFamiliesComplete(promotionId)
    ) {
      throw new LocalPromotionError("receipt_conflict");
    }
    const stateJson = taskDomain.canonicalPromotionJson(remote);
    return this.#database.transaction(() => {
      const existing = this.#remoteRejectionProof(promotionId);
      if (
        existing !== null &&
        taskDomain.canonicalPromotionJson(existing) !== stateJson
      ) {
        throw new LocalPromotionError("receipt_conflict");
      }
      if (existing === null) {
        this.#database.query(`
          INSERT INTO local_promotion_rejection_proofs_v2 (
            promotion_id, source_workspace_id, staging_workspace_id,
            manifest_root_digest, rejection_code, state_json, observed_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        `).run(
          promotionId,
          remote.manifest.sourceWorkspaceId,
          remote.stagingWorkspaceId,
          remote.manifest.rootDigest,
          remote.rejectionCode,
          stateJson,
          now,
        );
      }
      this.#database.query(`
        UPDATE local_promotion_sessions
        SET attempt_count = attempt_count + 1, next_attempt_at = NULL,
          fault_code = 'transport_rejected', updated_at = ?2
        WHERE promotion_id = ?1 AND schema_version = 2
      `).run(promotionId, now);
      return this.progress(promotionId);
    })();
  }

  beginActivation(
    promotionIdValue: string,
    nowValue: number,
  ): LocalPromotionProgress {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    if (!this.#allFamiliesComplete(promotionId)) {
      throw new LocalPromotionError("state_conflict");
    }
    return this.#transition(
      promotionId,
      ["ready", "activating"],
      "activating",
      "activating",
      nowValue,
    );
  }

  markOutcomeUnknown(
    promotionIdValue: string,
    nowValue: number,
  ): LocalPromotionProgress {
    return this.#transition(
      promotionIdValue,
      ["activating", "outcome_unknown"],
      "outcome_unknown",
      "outcome_unknown",
      nowValue,
    );
  }

  recordActivation(receiptValue: unknown): LocalPromotionProgress {
    const receipt = taskDomain.promotionActivationReceiptV2Schema.parse(
      receiptValue,
    );
    return this.#database.transaction(() => {
      const session = this.#requireV2Session(receipt.promotionId);
      const manifest = this.#manifest(receipt.promotionId);
      if (this.#remoteRejectionProof(receipt.promotionId) !== null) {
        throw new LocalPromotionError("activation_proof_invalid");
      }
      const existing = this.#decision(receipt.promotionId);
      if (existing !== null) {
        if (
          existing.decision !== "activated" ||
          existing.receipt_json !==
            taskDomain.canonicalPromotionJson(receipt)
        ) {
          throw new LocalPromotionError("activation_proof_invalid");
        }
        return this.progress(receipt.promotionId);
      }
      if (
        ![
          "receiving",
          "validating",
          "projecting",
          "ready",
          "activating",
          "outcome_unknown",
          "aborting",
        ].includes(session.state) ||
        session.staging_workspace_id === null ||
        receipt.sourceWorkspaceId !== session.workspace_id ||
        receipt.destinationWorkspaceId !== session.staging_workspace_id ||
        receipt.acceptedManifestRoot !== manifest.rootDigest
      ) {
        throw new LocalPromotionError("activation_proof_invalid");
      }
      for (const family of taskDomain.promotionEntityFamilyValues) {
        if (
          receipt.acceptedCounts[family] !== manifest.counts[family] ||
          receipt.acceptedFamilyDigests[family] !==
            manifest.familyDigests[family]
        ) {
          throw new LocalPromotionError("activation_proof_invalid");
        }
      }
      const localUpdatedAt = Math.max(
        receipt.activatedAt,
        session.created_at,
        session.updated_at,
      );
      this.#database.query(`
        INSERT INTO local_promotion_decision_proofs_v2 (
          promotion_id, decision, server_receipt_id, receipt_digest,
          receipt_json, decision_sequence, decided_at
        ) VALUES (?1, 'activated', ?2, ?3, ?4, ?5, ?6)
      `).run(
        receipt.promotionId,
        receipt.serverReceiptId,
        receipt.receiptDigest,
        taskDomain.canonicalPromotionJson(receipt),
        receipt.decisionSequence,
        receipt.activatedAt,
      );
      this.#checkpoint("activation.after_proof_before_authority");
      const switched = this.#database.query(`
        UPDATE local_workspaces
        SET authority_kind = 'cloud', authority_phase = NULL,
          cloud_workspace_id = ?2, updated_at = ?3
        WHERE workspace_id = ?1 AND authority_kind = 'promoting'
          AND promotion_id = ?4
      `).run(
        session.workspace_id,
        receipt.destinationWorkspaceId,
        localUpdatedAt,
        receipt.promotionId,
      );
      if (switched.changes !== 1) {
        throw new LocalPromotionError("authority_conflict");
      }
      this.#database.query(`
        UPDATE local_promotion_sessions
        SET state = 'activated', cloud_workspace_id = ?2,
          attempt_count = 0, next_attempt_at = NULL, fault_code = NULL,
          updated_at = ?3
        WHERE promotion_id = ?1
      `).run(
        receipt.promotionId,
        receipt.destinationWorkspaceId,
        localUpdatedAt,
      );
      this.#database.query(`
        INSERT INTO local_promotion_recovery_copies (
          promotion_id, local_workspace_id, cloud_workspace_id,
          state, created_at
        ) VALUES (?1, ?2, ?3, 'read_only', ?4)
      `).run(
        receipt.promotionId,
        session.workspace_id,
        receipt.destinationWorkspaceId,
        receipt.activatedAt,
      );
      const installation = z.object({
        owner_installation_id: taskDomain.runnerInstallationIdSchema,
      }).strict().parse(this.#database.query(`
        SELECT owner_installation_id FROM local_workspaces
        WHERE workspace_id = ?1
      `).get(session.workspace_id));
      this.#database.query(`
        INSERT INTO local_runner_pairing_pending (
          cloud_workspace_id, promotion_id, installation_id,
          state, created_at, updated_at
        ) VALUES (?1, ?2, ?3, 'pending', ?4, ?4)
      `).run(
        receipt.destinationWorkspaceId,
        receipt.promotionId,
        installation.owner_installation_id,
        receipt.activatedAt,
      );
      return this.progress(receipt.promotionId);
    })();
  }

  beginAbort(
    promotionIdValue: string,
    nowValue: number,
  ): LocalPromotionProgress {
    const session = this.#requireV2Session(promotionIdValue);
    if (session.staging_workspace_id === null) {
      throw new LocalPromotionError("state_conflict");
    }
    if (
      (session.state === "activating" ||
        session.state === "outcome_unknown") &&
      this.#remoteRejectionProof(session.promotion_id) === null
    ) {
      throw new LocalPromotionError("state_conflict");
    }
    return this.#transition(
      session.promotion_id,
      [
        "snapshot_frozen",
        "starting",
        "receiving",
        "validating",
        "projecting",
        "ready",
        "activating",
        "outcome_unknown",
        "aborting",
      ],
      "aborting",
      "staging",
      nowValue,
    );
  }

  recordAbort(receiptValue: unknown): LocalPromotionProgress {
    const receipt = taskDomain.promotionAbortReceiptV2Schema.parse(receiptValue);
    return this.#database.transaction(() => {
      const session = this.#requireV2Session(receipt.promotionId);
      const manifest = this.#manifest(receipt.promotionId);
      const existing = this.#decision(receipt.promotionId);
      if (existing !== null) {
        if (
          existing.decision !== "aborted_before_activation" ||
          existing.receipt_json !== taskDomain.canonicalPromotionJson(receipt)
        ) {
          throw new LocalPromotionError("abort_proof_invalid");
        }
        return this.progress(receipt.promotionId);
      }
      if (
        ![
          "receiving",
          "validating",
          "projecting",
          "ready",
          "activating",
          "outcome_unknown",
          "aborting",
        ].includes(session.state) ||
        session.staging_workspace_id === null ||
        receipt.sourceWorkspaceId !== session.workspace_id ||
        receipt.stagingWorkspaceId !== session.staging_workspace_id ||
        receipt.manifestRoot !== manifest.rootDigest
      ) {
        throw new LocalPromotionError("abort_proof_invalid");
      }
      const localUpdatedAt = Math.max(
        receipt.abortedAt,
        session.created_at,
        session.updated_at,
      );
      this.#database.query(`
        INSERT INTO local_promotion_decision_proofs_v2 (
          promotion_id, decision, server_receipt_id, receipt_digest,
          receipt_json, decision_sequence, decided_at
        ) VALUES (
          ?1, 'aborted_before_activation', ?2, ?3, ?4, ?5, ?6
        )
      `).run(
        receipt.promotionId,
        receipt.serverReceiptId,
        receipt.receiptDigest,
        taskDomain.canonicalPromotionJson(receipt),
        receipt.decisionSequence,
        receipt.abortedAt,
      );
      this.#checkpoint("abort.after_proof_before_authority");
      const restored = this.#database.query(`
        UPDATE local_workspaces
        SET authority_kind = 'local', promotion_id = NULL,
          authority_phase = NULL, cloud_workspace_id = NULL, updated_at = ?3
        WHERE workspace_id = ?1 AND authority_kind = 'promoting'
          AND promotion_id = ?2
      `).run(session.workspace_id, receipt.promotionId, localUpdatedAt);
      if (restored.changes !== 1) {
        throw new LocalPromotionError("authority_conflict");
      }
      this.#database.query(`
        UPDATE local_promotion_sessions
        SET state = 'aborted', attempt_count = 0, next_attempt_at = NULL,
          fault_code = NULL, updated_at = ?2
        WHERE promotion_id = ?1
      `).run(receipt.promotionId, localUpdatedAt);
      return this.progress(receipt.promotionId);
    })();
  }

  recordCleanup(
    progressValue: unknown,
    nowValue: number,
  ): PromotionCleanupProgress {
    const progress = taskDomain.promotionCleanupProgressSchema.parse(
      progressValue,
    );
    const now = taskDomain.epochMsSchema.parse(nowValue);
    if (this.#decision(progress.promotionId) === null) {
      throw new LocalPromotionError("state_conflict");
    }
    this.#database.query(`
      INSERT INTO local_promotion_cleanup_v2 (
        promotion_id, scope, state, deleted_entity_count, cursor,
        decision_proof_retained, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)
      ON CONFLICT(promotion_id) DO UPDATE SET
        scope = excluded.scope,
        state = excluded.state,
        deleted_entity_count = excluded.deleted_entity_count,
        cursor = excluded.cursor,
        decision_proof_retained = 1,
        updated_at = excluded.updated_at
    `).run(
      progress.promotionId,
      progress.scope,
      progress.state,
      progress.deletedEntityCount,
      progress.cursor,
      now,
    );
    return progress;
  }

  cleanup(promotionIdValue: string): PromotionCleanupProgress | null {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    const value: unknown = this.#database.query(`
      SELECT scope, state, deleted_entity_count, cursor
      FROM local_promotion_cleanup_v2 WHERE promotion_id = ?1
    `).get(promotionId);
    const row = z.object({
      scope: z.enum(["staging_rows", "all_promotion_owned_rows"]),
      state: z.enum(["pending", "running", "complete"]),
      deleted_entity_count: z.number().int().nonnegative().max(500_000),
      cursor: taskDomain.promotionCleanupCursorSchema.nullable(),
    }).strict().nullable().parse(value);
    return row === null
      ? null
      : taskDomain.promotionCleanupProgressSchema.parse({
          promotionId,
          scope: row.scope,
          state: row.state,
          deletedEntityCount: row.deleted_entity_count,
          cursor: row.cursor,
          decisionProofRetained: true,
        });
  }

  cleanupHttpOperationKey(promotionIdValue: string): string {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    this.#requireV2Session(promotionId);
    const cleanup = this.cleanup(promotionId);
    if (cleanup === null) return "cleanup:unobserved";
    const cursorDigest = createHash("sha256")
      .update(cleanup.cursor ?? "complete")
      .digest("hex");
    return [
      "cleanup",
      cleanup.state,
      String(cleanup.deletedEntityCount),
      cursorDigest,
    ].join(":");
  }

  getOrCreateHttpIdempotencyKey(inputValue: Readonly<{
    promotionId: string;
    operationKey: string;
    requestDigest: string;
    now: number;
  }>): ReturnType<typeof createUuidV7> {
    const input = z.object({
      promotionId: taskDomain.promotionIdSchema,
      operationKey: z.string().min(1).max(256),
      requestDigest: taskDomain.sha256DigestSchema,
      now: taskDomain.epochMsSchema,
    }).strict().parse(inputValue);
    return this.#database.transaction(() => {
      this.#requireV2Session(input.promotionId);
      const existing = z.object({
        request_digest: taskDomain.sha256DigestSchema,
        idempotency_key: uuidV7Schema,
      }).strict().nullable().parse(this.#database.query(`
        SELECT request_digest, idempotency_key
        FROM local_promotion_http_operations
        WHERE promotion_id = ?1 AND operation_key = ?2
      `).get(input.promotionId, input.operationKey));
      if (existing !== null) {
        if (existing.request_digest !== input.requestDigest) {
          throw new LocalPromotionError("receipt_conflict");
        }
        return existing.idempotency_key;
      }
      const idempotencyKey = createUuidV7(
        input.now,
        randomBytes(10),
      );
      this.#database.query(`
        INSERT INTO local_promotion_http_operations (
          promotion_id, operation_key, request_digest,
          idempotency_key, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5)
      `).run(
        input.promotionId,
        input.operationKey,
        input.requestDigest,
        idempotencyKey,
        input.now,
      );
      return idempotencyKey;
    }).immediate();
  }

  scheduleFault(inputValue: unknown): LocalPromotionProgress {
    const input = z.object({
      promotionId: taskDomain.promotionIdSchema,
      code: z.string(),
      nextAttemptAt: taskDomain.epochMsSchema.nullable(),
      now: taskDomain.epochMsSchema,
    }).strict().parse(inputValue);
    const code = localPromotionFaultCodeSchema.parse(input.code);
    this.#requireV2Session(input.promotionId);
    this.#database.query(`
      UPDATE local_promotion_sessions
      SET attempt_count = attempt_count + 1, next_attempt_at = ?2,
        fault_code = ?3, updated_at = ?4
      WHERE promotion_id = ?1
    `).run(
      input.promotionId,
      input.nextAttemptAt,
      code,
      input.now,
    );
    return this.progress(input.promotionId);
  }

  deferUntil(inputValue: unknown): LocalPromotionProgress {
    const input = z.object({
      promotionId: taskDomain.promotionIdSchema,
      nextAttemptAt: taskDomain.epochMsSchema,
      now: taskDomain.epochMsSchema,
    }).strict().parse(inputValue);
    this.#requireV2Session(input.promotionId);
    this.#database.query(`
      UPDATE local_promotion_sessions
      SET next_attempt_at = ?2, fault_code = NULL, updated_at = ?3
      WHERE promotion_id = ?1
    `).run(input.promotionId, input.nextAttemptAt, input.now);
    return this.progress(input.promotionId);
  }

  nextBackoffAt(promotionIdValue: string, nowValue: number): number {
    const session = this.#requireV2Session(promotionIdValue);
    const now = taskDomain.epochMsSchema.parse(nowValue);
    const exponent = Math.min(session.attempt_count, 7);
    return taskDomain.epochMsSchema.parse(
      now + Math.min(60_000, 500 * 2 ** exponent),
    );
  }

  clearFault(promotionIdValue: string, nowValue: number): void {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    const now = taskDomain.epochMsSchema.parse(nowValue);
    this.#database.query(`
      UPDATE local_promotion_sessions
      SET attempt_count = 0, next_attempt_at = NULL, fault_code = NULL,
        updated_at = ?2
      WHERE promotion_id = ?1 AND schema_version = 2
    `).run(promotionId, now);
  }

  resumablePromotionIds(
    nowValue: number,
    limitValue = 64,
  ): readonly string[] {
    const now = taskDomain.epochMsSchema.parse(nowValue);
    const limit = z.number().int().min(1).max(64).parse(limitValue);
    const values: unknown[] = this.#database.query(`
      SELECT promotion_id FROM local_promotion_sessions
      WHERE schema_version = 2
        AND state NOT IN ('activated', 'aborted')
        AND NOT (
          state <> 'aborting'
          AND fault_code = 'transport_rejected'
          AND EXISTS (
            SELECT 1
            FROM local_promotion_rejection_proofs_v2 AS rejection
            WHERE rejection.promotion_id =
              local_promotion_sessions.promotion_id
          )
        )
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)
      ORDER BY updated_at, promotion_id
      LIMIT ?2
    `).all(now, limit);
    return values.map((value) =>
      z.object({
        promotion_id: taskDomain.promotionIdSchema,
      }).strict().parse(value).promotion_id);
  }

  cleanupPromotionIds(
    nowValue: number,
    limitValue = 64,
  ): readonly string[] {
    const now = taskDomain.epochMsSchema.parse(nowValue);
    const limit = z.number().int().min(1).max(64).parse(limitValue);
    const values: unknown[] = this.#database.query(`
      SELECT session.promotion_id
      FROM local_promotion_sessions AS session
      LEFT JOIN local_promotion_cleanup_v2 AS cleanup
        ON cleanup.promotion_id = session.promotion_id
      WHERE session.schema_version = 2
        AND session.state IN ('activated', 'aborted')
        AND (cleanup.promotion_id IS NULL OR cleanup.state <> 'complete')
        AND (session.next_attempt_at IS NULL OR session.next_attempt_at <= ?1)
      ORDER BY session.updated_at, session.promotion_id
      LIMIT ?2
    `).all(now, limit);
    return values.map((value) =>
      z.object({
        promotion_id: taskDomain.promotionIdSchema,
      }).strict().parse(value).promotion_id);
  }

  nextScheduledAttemptAt(): number | null {
    const value: unknown = this.#database.query(`
      SELECT min(next_attempt_at) AS next_attempt_at
      FROM local_promotion_sessions
      WHERE schema_version = 2 AND next_attempt_at IS NOT NULL
        AND (
          state NOT IN ('activated', 'aborted')
          OR EXISTS (
            SELECT 1
            FROM local_promotion_decision_proofs_v2 AS decision
            LEFT JOIN local_promotion_cleanup_v2 AS cleanup
              ON cleanup.promotion_id = decision.promotion_id
            WHERE decision.promotion_id = local_promotion_sessions.promotion_id
              AND (cleanup.promotion_id IS NULL OR cleanup.state <> 'complete')
          )
        )
    `).get();
    return z.object({
      next_attempt_at: taskDomain.epochMsSchema.nullable(),
    }).strict().parse(value).next_attempt_at;
  }

  progress(promotionIdValue: string): LocalPromotionProgress {
    const session = this.#requireV2Session(promotionIdValue);
    const manifestRow = this.#manifestRow(session.promotion_id);
    const families = this.#familyRows(session.promotion_id);
    const acceptedEntityCount = families.reduce(
      (count, family) => count + family.accepted_entity_count,
      0,
    );
    const acceptedBatchCount = families.reduce(
      (count, family) => count + family.accepted_batch_count,
      0,
    );
    const fault = session.fault_code === null
      ? null
      : new LocalPromotionError(
          localPromotionFaultCodeSchema.parse(session.fault_code),
        ).toJSON();
    const pairingValue: unknown = session.cloud_workspace_id === null
      ? null
      : this.#database.query(`
          SELECT state FROM local_runner_pairing_pending
          WHERE cloud_workspace_id = ?1
        `).get(session.cloud_workspace_id);
    const pairing = pairingRowSchema.nullable().parse(pairingValue)?.state ??
      "not_applicable";
    const recovery = this.recoveryCopy(session.promotion_id);
    const canAbort = !["activated", "aborted"].includes(session.state) &&
      (
        (
          session.state !== "activating" &&
          session.state !== "outcome_unknown"
        ) ||
        this.#remoteRejectionProof(session.promotion_id) !== null
      );
    return localPromotionProgressSchema.parse({
      promotionId: session.promotion_id,
      sourceWorkspaceId: session.workspace_id,
      destinationWorkspaceId: session.cloud_workspace_id ??
        session.staging_workspace_id,
      phase: localPhase(session.state),
      frozenAt: session.created_at,
      updatedAt: session.updated_at,
      preparedEntityCount: manifestRow.entity_count,
      acceptedEntityCount,
      acceptedBatchCount,
      families: families.map((family) => ({
        family: family.family,
        preparedCount: family.snapshot_count,
        acceptedCount: family.accepted_entity_count,
        acceptedBatchCount: family.accepted_batch_count,
        complete: family.complete === 1,
      })),
      nextAttemptAt: session.next_attempt_at,
      fault,
      canAbort,
      localWritable: session.state === "aborted",
      recoveryCopyAvailable: recovery !== null,
      runnerPairing: pairing,
    });
  }

  progressForWorkspace(
    workspaceIdValue: string,
  ): LocalPromotionProgress | null {
    const workspaceId = taskDomain.workspacePublicIdSchema.parse(
      workspaceIdValue,
    );
    const value: unknown = this.#database.query(`
      SELECT promotion_id
      FROM local_promotion_sessions
      WHERE schema_version = 2
        AND (workspace_id = ?1 OR cloud_workspace_id = ?1)
      ORDER BY created_at DESC, promotion_id DESC
      LIMIT 1
    `).get(workspaceId);
    const row = z.object({
      promotion_id: taskDomain.promotionIdSchema,
    }).strict().nullable().parse(value);
    return row === null ? null : this.progress(row.promotion_id);
  }

  recoveryCopy(
    promotionIdValue: string,
  ): LocalPromotionRecoveryCopy | null {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    const value: unknown = this.#database.query(`
      SELECT promotion_id, local_workspace_id, cloud_workspace_id,
        state, created_at, last_opened_at
      FROM local_promotion_recovery_copies WHERE promotion_id = ?1
    `).get(promotionId);
    const row = recoveryRowSchema.nullable().parse(value);
    return row === null
      ? null
      : localPromotionRecoveryCopySchema.parse({
          promotionId: row.promotion_id,
          localWorkspaceId: row.local_workspace_id,
          cloudWorkspaceId: row.cloud_workspace_id,
          access: row.state,
          createdAt: row.created_at,
          lastOpenedAt: row.last_opened_at,
        });
  }

  recoveryReadAuthority(inputValue: unknown): LocalPromotionRecoveryCopy {
    const input = localPromotionRecoveryCopySchema.parse(inputValue);
    const recovery = this.recoveryCopy(input.promotionId);
    if (
      recovery === null ||
      recovery.localWorkspaceId !== input.localWorkspaceId ||
      recovery.cloudWorkspaceId !== input.cloudWorkspaceId ||
      recovery.access !== "read_only"
    ) {
      throw new LocalPromotionError("authority_conflict");
    }
    const session = this.#requireV2Session(input.promotionId);
    if (
      session.state !== "activated" ||
      session.workspace_id !== recovery.localWorkspaceId ||
      session.cloud_workspace_id !== recovery.cloudWorkspaceId
    ) {
      throw new LocalPromotionError("authority_conflict");
    }
    return recovery;
  }

  markRecoveryOpened(promotionIdValue: string, nowValue: number):
    LocalPromotionRecoveryCopy {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    const now = taskDomain.epochMsSchema.parse(nowValue);
    const changed = this.#database.query(`
      UPDATE local_promotion_recovery_copies SET last_opened_at = ?2
      WHERE promotion_id = ?1
    `).run(promotionId, now);
    if (changed.changes !== 1) {
      throw new LocalPromotionError("state_conflict");
    }
    const recovery = this.recoveryCopy(promotionId);
    if (recovery === null) throw new LocalPromotionError("state_conflict");
    return recovery;
  }

  authorityOverlay(
    workspaceIdValue: string,
  ): LocalPromotionAuthorityOverlay {
    const workspaceId = taskDomain.workspacePublicIdSchema.parse(
      workspaceIdValue,
    );
    const value: unknown = this.#database.query(`
      SELECT workspace_id, owner_installation_id, authority_kind,
        promotion_id, authority_phase, cloud_workspace_id
      FROM local_workspaces
      WHERE workspace_id = ?1 OR cloud_workspace_id = ?1
      ORDER BY CASE WHEN cloud_workspace_id = ?1 THEN 0 ELSE 1 END
      LIMIT 1
    `).get(workspaceId);
    const workspace = workspaceAuthorityRowSchema.nullable().parse(value);
    if (workspace === null) {
      throw new LocalPromotionError("workspace_not_found");
    }
    if (workspace.authority_kind === "local") {
      return localPromotionAuthorityOverlaySchema.parse({
        sourceLocalWorkspaceId: workspace.workspace_id,
        presentedWorkspaceId: workspace.workspace_id,
        authority: {
          kind: "local",
          localWorkspaceId: workspace.workspace_id,
          ownerInstallationId: workspace.owner_installation_id,
        },
        sourceAccess: "read_write",
      });
    }
    if (workspace.authority_kind === "cloud") {
      if (workspace.cloud_workspace_id === null) {
        throw new LocalPromotionError("state_conflict");
      }
      return localPromotionAuthorityOverlaySchema.parse({
        sourceLocalWorkspaceId: workspace.workspace_id,
        presentedWorkspaceId: workspace.cloud_workspace_id,
        authority: cloudAuthority(workspace.cloud_workspace_id),
        sourceAccess: "read_only_recovery",
      });
    }
    if (
      workspace.promotion_id === null ||
      workspace.authority_phase === null
    ) {
      throw new LocalPromotionError("state_conflict");
    }
    return localPromotionAuthorityOverlaySchema.parse({
      sourceLocalWorkspaceId: workspace.workspace_id,
      presentedWorkspaceId: workspace.workspace_id,
      authority: {
        kind: "promoting",
        localWorkspaceId: workspace.workspace_id,
        promotionId: workspace.promotion_id,
        phase: workspace.authority_phase,
      },
      sourceAccess: "frozen",
    });
  }

  markPairingState(inputValue: unknown): void {
    const input = z.object({
      cloudWorkspaceId: taskDomain.workspacePublicIdSchema,
      promotionId: taskDomain.promotionIdSchema,
      state: z.enum(["pairing", "paired", "blocked"]),
      faultCode: z.string().min(1).max(128).nullable().default(null),
      now: taskDomain.epochMsSchema,
    }).strict().parse(inputValue);
    const changed = this.#database.query(`
      UPDATE local_runner_pairing_pending
      SET state = ?2,
        attempt_count = CASE WHEN ?2 IN ('pairing', 'blocked')
          THEN attempt_count + 1 ELSE attempt_count END,
        fault_code = ?3, updated_at = ?4
      WHERE cloud_workspace_id = ?1 AND promotion_id = ?5
    `).run(
      input.cloudWorkspaceId,
      input.state,
      input.faultCode,
      input.now,
      input.promotionId,
    );
    if (changed.changes !== 1) {
      throw new LocalPromotionError("state_conflict");
    }
  }

  runnerPairingsForInstallation(
    installationIdValue: string,
  ): readonly LocalRunnerPairingRecord[] {
    const installationId = taskDomain.runnerInstallationIdSchema.parse(
      installationIdValue,
    );
    const values: unknown[] = this.#database.query(`
      SELECT pairing.cloud_workspace_id, pairing.promotion_id,
        session.workspace_id AS source_workspace_id,
        pairing.installation_id, pairing.state, pairing.attempt_count,
        pairing.fault_code, pairing.created_at, pairing.updated_at
      FROM local_runner_pairing_pending AS pairing
      JOIN local_promotion_sessions AS session
        ON session.promotion_id = pairing.promotion_id
      WHERE pairing.installation_id = ?1
        AND session.schema_version = 2
        AND session.state = 'activated'
      ORDER BY pairing.created_at, pairing.promotion_id
      LIMIT 129
    `).all(installationId);
    if (values.length > 128) {
      throw new LocalPromotionError("state_conflict");
    }
    return values.map((value) => {
      const row = runnerPairingRecordRowSchema.parse(value);
      return {
        cloudWorkspaceId: row.cloud_workspace_id,
        promotionId: row.promotion_id,
        sourceWorkspaceId: row.source_workspace_id,
        installationId: row.installation_id,
        state: row.state,
        attemptCount: row.attempt_count,
        faultCode: row.fault_code,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  readSnapshotEntities(
    promotionIdValue: string,
    familyValue: string,
    offsetValue: number,
    limitValue = 500,
  ): readonly PromotionEntity[] {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    const family = taskDomain.promotionEntityFamilySchema.parse(familyValue);
    const offset = z.number().int().nonnegative().max(500_000).parse(offsetValue);
    const limit = z.number().int().min(1).max(500).parse(limitValue);
    const values: unknown[] = this.#database.query(`
      SELECT entity_json FROM local_promotion_snapshot_entities
      WHERE promotion_id = ?1 AND family = ?2 AND family_ordinal >= ?3
      ORDER BY family_ordinal LIMIT ?4
    `).all(promotionId, family, offset, limit);
    return values.map((value) =>
      taskDomain.promotionEntitySchema.parse(
        parseJson(entityRowSchema.parse(value).entity_json),
      ));
  }

  manifest(promotionIdValue: string): PromotionManifestV2 {
    return this.#manifest(
      taskDomain.promotionIdSchema.parse(promotionIdValue),
    );
  }

  #batchFor(
    family: FamilyRow,
    items: readonly PromotionEntity[],
    promotionId: string,
  ): PromotionBatchV2 {
    const base = {
      schemaVersion: 2 as const,
      promotionId,
      batchId: deterministicPublicId(
        "batch",
        `${promotionId}:${family.family}:${String(family.accepted_batch_count)}`,
      ),
      family: family.family,
      ordinal: family.accepted_batch_count,
      previousFamilyCount: family.accepted_entity_count,
      previousFamilyDigest: family.accepted_digest,
      previousEntityIdentity: family.accepted_last_identity,
      items: [...items],
    };
    return taskDomain.promotionBatchV2Schema.parse({
      ...base,
      requestDigest: taskDomain.promotionBatchV2RequestDigest(base),
    });
  }

  #transition(
    promotionIdValue: string,
    from: readonly SessionRow["state"][],
    to: SessionRow["state"],
    workspacePhase:
      | "snapshot_frozen"
      | "staging"
      | "uploading"
      | "activating"
      | "outcome_unknown",
    nowValue: number,
  ): LocalPromotionProgress {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    const now = taskDomain.epochMsSchema.parse(nowValue);
    return this.#database.transaction(() => {
      const session = this.#requireV2Session(promotionId);
      if (!from.includes(session.state)) {
        throw new LocalPromotionError("state_conflict");
      }
      this.#database.query(`
        UPDATE local_promotion_sessions SET state = ?2, updated_at = ?3
        WHERE promotion_id = ?1
      `).run(promotionId, to, now);
      this.#setWorkspacePhase(session.workspace_id, workspacePhase, now);
      return this.progress(promotionId);
    })();
  }

  #setBatchState(
    promotionIdValue: string,
    batchIdValue: string,
    from: readonly OutstandingLocalPromotionBatch["state"][],
    to: OutstandingLocalPromotionBatch["state"],
    cursor: string | null,
    nowValue: number,
  ): void {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    const batchId = taskDomain.promotionBatchIdSchema.parse(batchIdValue);
    const now = taskDomain.epochMsSchema.parse(nowValue);
    const placeholders = from.map((_, index) => `?${String(index + 5)}`).join(", ");
    const changed = this.#database.query(`
      UPDATE local_promotion_outbound_batches_v2
      SET state = ?3, receipt_audit_cursor = ?4, updated_at = ?${String(
        from.length + 5,
      )}
      WHERE promotion_id = ?1 AND batch_id = ?2
        AND state IN (${placeholders})
    `).run(
      promotionId,
      batchId,
      to,
      cursor,
      ...from,
      now,
    );
    if (changed.changes !== 1) {
      throw new LocalPromotionError("state_conflict");
    }
  }

  #setWorkspacePhase(
    workspaceId: string,
    phase: string,
    now: number,
  ): void {
    const changed = this.#database.query(`
      UPDATE local_workspaces SET authority_phase = ?2, updated_at = ?3
      WHERE workspace_id = ?1 AND authority_kind = 'promoting'
    `).run(workspaceId, phase, now);
    if (changed.changes !== 1) {
      throw new LocalPromotionError("authority_conflict");
    }
  }

  #allFamiliesComplete(promotionId: string): boolean {
    const value = z.object({
      incomplete: z.number().int().nonnegative().safe(),
    }).strict().parse(this.#database.query(`
      SELECT count(*) AS incomplete
      FROM local_promotion_family_progress_v2
      WHERE promotion_id = ?1 AND complete = 0
    `).get(promotionId));
    return value.incomplete === 0;
  }

  #familyRows(promotionId: string): readonly FamilyRow[] {
    const values: unknown[] = this.#database.query(`
      SELECT family, family_index, snapshot_count, snapshot_digest,
        snapshot_last_identity, accepted_batch_count, accepted_entity_count,
        accepted_digest, accepted_last_identity, complete
      FROM local_promotion_family_progress_v2
      WHERE promotion_id = ?1 ORDER BY family_index
    `).all(promotionId);
    const rows = values.map((value) => familyRowSchema.parse(value));
    if (rows.length !== taskDomain.promotionEntityFamilyValues.length) {
      throw new LocalPromotionError("snapshot_invalid");
    }
    return rows;
  }

  #familyRow(promotionId: string, family: string): FamilyRow {
    const row = this.#familyRows(promotionId).find(
      (value) => value.family === family,
    );
    if (row === undefined) throw new LocalPromotionError("snapshot_invalid");
    return row;
  }

  #manifestRow(promotionId: string): z.infer<typeof manifestRowSchema> {
    const value: unknown = this.#database.query(`
      SELECT manifest_json, entity_count, serialized_entity_bytes
      FROM local_promotion_manifests_v2 WHERE promotion_id = ?1
    `).get(promotionId);
    const row = manifestRowSchema.nullable().parse(value);
    if (row === null) throw new LocalPromotionError("snapshot_invalid");
    return row;
  }

  #manifest(promotionId: string): PromotionManifestV2 {
    const manifest = taskDomain.promotionManifestV2Schema.parse(
      parseJson(this.#manifestRow(promotionId).manifest_json),
    );
    if (manifest.promotionId !== promotionId) {
      throw new LocalPromotionError("snapshot_invalid");
    }
    return manifest;
  }

  #session(promotionId: string): SessionRow | null {
    const value: unknown = this.#database.query(`
      SELECT promotion_id, schema_version, workspace_id, state,
        destination_organization_id, staging_workspace_id, cloud_workspace_id,
        source_workspace_revision, source_event_sequence, manifest_root_digest,
        attempt_count, next_attempt_at, fault_code, lost_response_batch_id,
        receipt_audit_cursor, created_at, updated_at
      FROM local_promotion_sessions WHERE promotion_id = ?1
    `).get(promotionId);
    return sessionRowSchema.nullable().parse(value);
  }

  #requireV2Session(promotionIdValue: string): SessionRow {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    const session = this.#session(promotionId);
    if (session === null) throw new LocalPromotionError("state_conflict");
    if (session.schema_version !== 2) {
      throw new LocalPromotionError("legacy_session");
    }
    return session;
  }

  #decision(
    promotionId: string,
  ): z.infer<typeof decisionRowSchema> | null {
    const value: unknown = this.#database.query(`
      SELECT decision, receipt_json
      FROM local_promotion_decision_proofs_v2 WHERE promotion_id = ?1
    `).get(promotionId);
    return decisionRowSchema.nullable().parse(value);
  }

  #remoteRejectionProof(
    promotionIdValue: string,
  ): Extract<WorkspacePromotionStateV2, { state: "rejected" }> | null {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    const value: unknown = this.#database.query(`
      SELECT source_workspace_id, staging_workspace_id, manifest_root_digest,
        rejection_code, state_json, observed_at
      FROM local_promotion_rejection_proofs_v2
      WHERE promotion_id = ?1
    `).get(promotionId);
    const row = rejectionProofRowSchema.nullable().parse(value);
    if (row === null) return null;
    const state = workspacePromotionStateV2Schema.parse(
      parseJson(row.state_json),
    );
    const session = this.#requireV2Session(promotionId);
    const manifest = this.#manifest(promotionId);
    if (
      state.state !== "rejected" ||
      state.promotionId !== promotionId ||
      state.manifest.sourceWorkspaceId !== row.source_workspace_id ||
      state.stagingWorkspaceId !== row.staging_workspace_id ||
      state.manifest.rootDigest !== row.manifest_root_digest ||
      state.rejectionCode !== row.rejection_code ||
      row.source_workspace_id !== session.workspace_id ||
      row.staging_workspace_id !== session.staging_workspace_id ||
      row.manifest_root_digest !== manifest.rootDigest
    ) {
      throw new LocalPromotionError("receipt_conflict");
    }
    return state;
  }

  #checkpoint(checkpoint: LocalPromotionCheckpoint): void {
    this.#faultInjector?.(checkpoint);
  }
}

function receiptAuditCursorFingerprint(cursor: string): string {
  return receiptAuditCursorFingerprintSchema.parse(
    createHash("sha256").update(cursor).digest("base64url").slice(0, 22),
  );
}

function parsePersistedReceiptAuditState(
  value: string | null,
): PersistedReceiptAuditState {
  if (value === null) {
    return { version: 1, cursorFingerprints: [] };
  }
  const legacyCursor =
    taskDomain.promotionReceiptAuditCursorSchema.safeParse(value);
  if (legacyCursor.success) {
    return {
      version: 1,
      cursorFingerprints: [
        receiptAuditCursorFingerprint(legacyCursor.data),
      ],
    };
  }
  try {
    return persistedReceiptAuditStateSchema.parse(
      JSON.parse(value) as unknown,
    );
  } catch {
    throw new LocalPromotionError("receipt_conflict");
  }
}

function localPhase(
  state: SessionRow["state"],
):
  | "snapshot_frozen"
  | "starting"
  | "receiving"
  | "validating"
  | "projecting"
  | "ready"
  | "activating"
  | "outcome_unknown"
  | "aborting"
  | "activated"
  | "aborted" {
  if (state === "staging" || state === "uploading") return "receiving";
  return state;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function deterministicPublicId(prefix: string, seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  let value = BigInt(`0x${hex}`);
  let locator = "";
  for (let index = 0; index < 26; index += 1) {
    locator = (CROCKFORD[Number(value & 31n)] ?? "0") + locator;
    value >>= 5n;
  }
  return `${prefix}_${locator}`;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new LocalPromotionError("snapshot_invalid");
  }
}
