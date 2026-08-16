import type { Database } from "bun:sqlite";
import {
  promotionActivationReceiptSchema,
  promotionBatchAcceptanceSchema,
  promotionBatchReceiptSchema,
  promotionEntityFamilyValues,
  promotionEntityIdentity,
  promotionManifestSchema,
  promotionSnapshotSchema,
  taskDomain,
  workspacePromotionStateSchema,
  type PromotionActivationReceipt,
  type PromotionBatchReceipt,
  type PromotionManifest,
  type PromotionSnapshot,
  type WorkspacePromotionState,
} from "@hraness/agent-tasks-protocol";
import { z } from "@hra-internal/schema";
import { createHash } from "node:crypto";

const sessionRowSchema = z.object({
  promotion_id: taskDomain.promotionIdSchema,
  workspace_id: taskDomain.workspacePublicIdSchema,
  state: z.enum([
    "snapshot_frozen",
    "staging",
    "uploading",
    "activating",
    "outcome_unknown",
    "activated",
    "aborted",
  ]),
  destination_organization_id: z.string().min(1).max(256),
  staging_workspace_id: taskDomain.workspacePublicIdSchema.nullable(),
  source_workspace_revision: taskDomain.revisionSchema,
  source_event_sequence: taskDomain.workspaceEventSequenceSchema,
  created_at: taskDomain.epochMsSchema,
  updated_at: taskDomain.epochMsSchema,
}).strict();

const manifestRowSchema = z.object({
  manifest_json: z.string(),
  snapshot_json: z.string(),
}).strict();

const activationRowSchema = z.object({
  receipt_json: z.string(),
}).strict();

export class LocalPromotionConflict extends Error {
  constructor(message = "Local promotion state or receipt conflicts with durable state") {
    super(message);
    this.name = "LocalPromotionConflict";
  }
}

export class LocalPromotionStore {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  freezeSnapshot(inputValue: unknown): WorkspacePromotionState {
    const input = z.object({
      snapshot: promotionSnapshotSchema,
      destinationOrganizationId: z.string().min(1).max(256),
      now: taskDomain.epochMsSchema,
    }).strict().parse(inputValue);
    const { manifest } = input.snapshot;
    return this.#database.transaction(() => {
      const existing = this.#sessionByPromotion(manifest.promotionId);
      if (existing !== null) {
        const stored = this.snapshot(manifest.promotionId);
        if (
          JSON.stringify(stored) !== JSON.stringify(input.snapshot) ||
          existing.destination_organization_id !== input.destinationOrganizationId
        ) {
          throw new LocalPromotionConflict();
        }
        return this.state(manifest.sourceWorkspaceId);
      }
      const workspaceValue: unknown = this.#database.query(`
        SELECT revision, event_sequence, authority_kind
        FROM local_workspaces
        WHERE workspace_id = ?1 AND tombstoned_at IS NULL
      `).get(manifest.sourceWorkspaceId);
      const workspace = z.object({
        revision: taskDomain.revisionSchema,
        event_sequence: z.number().int().nonnegative().safe(),
        authority_kind: z.enum(["local", "promoting", "cloud"]),
      }).strict().nullable().parse(workspaceValue);
      if (
        workspace === null ||
        workspace.authority_kind !== "local" ||
        workspace.revision !== manifest.sourceWorkspaceRevision ||
        workspace.event_sequence !== manifest.sourceEventSequence
      ) {
        throw new LocalPromotionConflict("Promotion snapshot revision is stale");
      }
      this.#assertTerminalLocalWork(manifest);
      this.#database.query(`
        INSERT INTO local_promotion_sessions (
          promotion_id, workspace_id, state, destination_organization_id,
          source_workspace_revision, source_event_sequence, created_at, updated_at
        ) VALUES (?1, ?2, 'snapshot_frozen', ?3, ?4, ?5, ?6, ?6)
      `).run(
        manifest.promotionId,
        manifest.sourceWorkspaceId,
        input.destinationOrganizationId,
        manifest.sourceWorkspaceRevision,
        manifest.sourceEventSequence,
        input.now,
      );
      this.#database.query(`
        INSERT INTO local_promotion_manifests (
          promotion_id, schema_version, root_digest, manifest_json,
          snapshot_json, entity_count, created_at
        ) VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6)
      `).run(
        manifest.promotionId,
        manifest.rootDigest,
        JSON.stringify(manifest),
        JSON.stringify(input.snapshot),
        input.snapshot.entities.length,
        input.now,
      );
      for (const family of promotionEntityFamilyValues) {
        const entities = input.snapshot.entities.filter((entity) => entity.family === family);
        this.#database.query(`
          INSERT INTO local_promotion_family_digests (
            promotion_id, family, entity_count, family_digest
          ) VALUES (?1, ?2, ?3, ?4)
        `).run(
          manifest.promotionId,
          family,
          entities.length,
          familyDigest(family, entities),
        );
      }
      const updated = this.#database.query(`
        UPDATE local_workspaces
        SET authority_kind = 'promoting', promotion_id = ?2,
          authority_phase = 'snapshot_frozen', cloud_workspace_id = NULL,
          updated_at = ?3
        WHERE workspace_id = ?1 AND authority_kind = 'local'
      `).run(manifest.sourceWorkspaceId, manifest.promotionId, input.now);
      if (updated.changes !== 1) throw new LocalPromotionConflict();
      return this.state(manifest.sourceWorkspaceId);
    })();
  }

  snapshot(promotionIdValue: string): PromotionSnapshot {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    const value: unknown = this.#database.query(`
      SELECT manifest_json, snapshot_json
      FROM local_promotion_manifests WHERE promotion_id = ?1
    `).get(promotionId);
    const row = manifestRowSchema.nullable().parse(value);
    if (row === null) throw new LocalPromotionConflict("Promotion manifest does not exist");
    const manifest = promotionManifestSchema.parse(parseJson(row.manifest_json));
    const snapshot = promotionSnapshotSchema.parse(parseJson(row.snapshot_json));
    if (JSON.stringify(snapshot.manifest) !== JSON.stringify(manifest)) {
      throw new LocalPromotionConflict("Promotion manifest and snapshot drifted");
    }
    return snapshot;
  }

  markStaging(inputValue: unknown): WorkspacePromotionState {
    const input = z.object({
      promotionId: taskDomain.promotionIdSchema,
      stagingWorkspaceId: taskDomain.workspacePublicIdSchema,
      now: taskDomain.epochMsSchema,
    }).strict().parse(inputValue);
    return this.#transition(input.promotionId, {
      from: ["snapshot_frozen", "staging"],
      to: "staging",
      authorityPhase: "staging",
      stagingWorkspaceId: input.stagingWorkspaceId,
      now: input.now,
    });
  }

  markUploading(promotionIdValue: string, nowValue = Date.now()):
    WorkspacePromotionState {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    const now = taskDomain.epochMsSchema.parse(nowValue);
    return this.#transition(promotionId, {
      from: ["staging", "uploading"],
      to: "uploading",
      authorityPhase: "uploading",
      now,
    });
  }

  recordBatchAcceptance(inputValue: unknown): WorkspacePromotionState {
    const acceptance = promotionBatchAcceptanceSchema.parse(inputValue);
    return this.#database.transaction(() => {
      const session = this.#requireSession(acceptance.batch.promotionId);
      if (
        (session.state !== "staging" && session.state !== "uploading") ||
        session.staging_workspace_id === null
      ) {
        throw new LocalPromotionConflict("Promotion is not accepting batches");
      }
      const existingValue: unknown = this.#database.query(`
        SELECT receipt_json FROM local_promotion_upload_receipts
        WHERE promotion_id = ?1 AND batch_id = ?2
      `).get(acceptance.batch.promotionId, acceptance.batch.batchId);
      const existing = z.object({ receipt_json: z.string() })
        .strict().nullable().parse(existingValue);
      if (existing !== null) {
        const receipt = promotionBatchReceiptSchema.parse(parseJson(existing.receipt_json));
        if (JSON.stringify(receipt) !== JSON.stringify(acceptance.receipt)) {
          throw new LocalPromotionConflict();
        }
        return this.state(session.workspace_id);
      }
      const manifest = this.snapshot(acceptance.batch.promotionId).manifest;
      const receipts = [
        ...this.#batchReceipts(acceptance.batch.promotionId),
        acceptance.receipt,
      ];
      workspacePromotionStateSchema.parse({
        state: "promoting",
        promotionId: acceptance.batch.promotionId,
        manifest,
        localWritable: false,
        stagingWorkspaceId: session.staging_workspace_id,
        acceptedBatchReceipts: receipts,
      });
      const cumulativeCount = acceptance.receipt.cumulativeCounts[
        acceptance.receipt.family
      ];
      const acceptanceSequence = receipts.length;
      this.#database.query(`
        INSERT INTO local_promotion_upload_receipts (
          promotion_id, batch_id, family, ordinal, request_digest,
          accepted_count, cumulative_count, server_digest, receipt_json,
          acceptance_sequence, recorded_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
      `).run(
        acceptance.receipt.promotionId,
        acceptance.receipt.batchId,
        acceptance.receipt.family,
        acceptance.receipt.ordinal,
        acceptance.receipt.requestDigest,
        acceptance.receipt.itemCount,
        cumulativeCount,
        acceptance.receipt.acceptedDigest,
        JSON.stringify(acceptance.receipt),
        acceptanceSequence,
        acceptance.receipt.acceptedAt,
      );
      this.#setSessionAndWorkspacePhase(
        session,
        "uploading",
        "uploading",
        acceptance.receipt.acceptedAt,
      );
      return this.state(session.workspace_id);
    })();
  }

  beginActivation(promotionIdValue: string, nowValue = Date.now()):
    WorkspacePromotionState {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    const now = taskDomain.epochMsSchema.parse(nowValue);
    const session = this.#requireSession(promotionId);
    const manifest = this.snapshot(promotionId).manifest;
    const receipts = this.#batchReceipts(promotionId);
    workspacePromotionStateSchema.parse({
      state: "promoting",
      promotionId,
      manifest,
      localWritable: false,
      stagingWorkspaceId: session.staging_workspace_id ?? undefined,
      acceptedBatchReceipts: receipts,
    });
    const cumulative = receipts.at(-1)?.cumulativeCounts ??
      Object.fromEntries(promotionEntityFamilyValues.map((family) => [family, 0]));
    for (const family of promotionEntityFamilyValues) {
      if (cumulative[family] !== manifest.counts[family]) {
        throw new LocalPromotionConflict("Promotion upload is incomplete");
      }
    }
    return this.#transition(promotionId, {
      from: ["uploading", "activating"],
      to: "activating",
      authorityPhase: "activating",
      now,
    });
  }

  markOutcomeUnknown(promotionIdValue: string, nowValue = Date.now()):
    WorkspacePromotionState {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    const now = taskDomain.epochMsSchema.parse(nowValue);
    return this.#transition(promotionId, {
      from: ["activating", "outcome_unknown"],
      to: "outcome_unknown",
      authorityPhase: "outcome_unknown",
      now,
    });
  }

  recordActivation(receiptValue: unknown): WorkspacePromotionState {
    const receipt = promotionActivationReceiptSchema.parse(receiptValue);
    return this.#database.transaction(() => {
      const session = this.#requireSession(receipt.promotionId);
      const snapshot = this.snapshot(receipt.promotionId);
      const existingValue: unknown = this.#database.query(`
        SELECT receipt_json FROM local_promotion_activation_receipts
        WHERE promotion_id = ?1
      `).get(receipt.promotionId);
      const existing = activationRowSchema.nullable().parse(existingValue);
      if (existing !== null) {
        const stored = promotionActivationReceiptSchema.parse(parseJson(existing.receipt_json));
        if (JSON.stringify(stored) !== JSON.stringify(receipt)) {
          throw new LocalPromotionConflict();
        }
        return this.state(session.workspace_id);
      }
      workspacePromotionStateSchema.parse({
        state: "promoted",
        promotionId: receipt.promotionId,
        manifest: snapshot.manifest,
        localWritable: false,
        stagingWorkspaceId: session.staging_workspace_id,
        activationReceipt: receipt,
      });
      if (session.state !== "activating" && session.state !== "outcome_unknown") {
        throw new LocalPromotionConflict("Promotion is not awaiting activation");
      }
      this.#database.query(`
        INSERT INTO local_promotion_activation_receipts (
          promotion_id, cloud_workspace_id, manifest_root_digest,
          receipt_json, accepted_at
        ) VALUES (?1, ?2, ?3, ?4, ?5)
      `).run(
        receipt.promotionId,
        receipt.destinationWorkspaceId,
        receipt.acceptedManifestRoot,
        JSON.stringify(receipt),
        receipt.activatedAt,
      );
      this.#database.query(`
        UPDATE local_promotion_sessions
        SET state = 'activated', updated_at = ?2
        WHERE promotion_id = ?1
      `).run(receipt.promotionId, receipt.activatedAt);
      this.#database.query(`
        UPDATE local_workspaces
        SET authority_kind = 'cloud', authority_phase = NULL,
          cloud_workspace_id = ?2, updated_at = ?3
        WHERE workspace_id = ?1 AND authority_kind = 'promoting'
      `).run(
        session.workspace_id,
        receipt.destinationWorkspaceId,
        receipt.activatedAt,
      );
      return this.state(session.workspace_id);
    })();
  }

  abortPreActivation(inputValue: unknown): WorkspacePromotionState {
    const input = z.object({
      promotionId: taskDomain.promotionIdSchema,
      provedAt: taskDomain.epochMsSchema,
    }).strict().parse(inputValue);
    return this.#database.transaction(() => {
      const session = this.#requireSession(input.promotionId);
      if (
        session.state === "activating" ||
        session.state === "outcome_unknown" ||
        session.state === "activated"
      ) {
        throw new LocalPromotionConflict("Promotion can no longer prove a pre-activation abort");
      }
      this.#database.query(`
        UPDATE local_promotion_sessions
        SET state = 'aborted', updated_at = ?2 WHERE promotion_id = ?1
      `).run(input.promotionId, input.provedAt);
      this.#database.query(`
        UPDATE local_workspaces
        SET authority_kind = 'local', promotion_id = NULL,
          authority_phase = NULL, cloud_workspace_id = NULL, updated_at = ?2
        WHERE workspace_id = ?1 AND authority_kind = 'promoting'
      `).run(session.workspace_id, input.provedAt);
      return this.state(session.workspace_id);
    })();
  }

  state(workspaceIdValue: string): WorkspacePromotionState {
    const workspaceId = taskDomain.workspacePublicIdSchema.parse(workspaceIdValue);
    const sessionValue: unknown = this.#database.query(`
      SELECT promotion_id, workspace_id, state, destination_organization_id,
        staging_workspace_id, source_workspace_revision, source_event_sequence,
        created_at, updated_at
      FROM local_promotion_sessions
      WHERE workspace_id = ?1
      ORDER BY created_at DESC LIMIT 1
    `).get(workspaceId);
    const session = sessionRowSchema.nullable().parse(sessionValue);
    if (session === null) {
      return workspacePromotionStateSchema.parse({
        state: "local",
        localWritable: true,
      });
    }
    const manifest = this.snapshot(session.promotion_id).manifest;
    if (session.state === "aborted") {
      return workspacePromotionStateSchema.parse({
        state: "aborted",
        promotionId: session.promotion_id,
        manifestRoot: manifest.rootDigest,
        preActivationAbortProvedAt: session.updated_at,
        localWritable: true,
      });
    }
    if (session.state === "activated") {
      const activation = this.#activationReceipt(session.promotion_id);
      if (activation === null || session.staging_workspace_id === null) {
        throw new LocalPromotionConflict("Activated promotion is missing its receipt");
      }
      return workspacePromotionStateSchema.parse({
        state: "promoted",
        promotionId: session.promotion_id,
        manifest,
        localWritable: false,
        stagingWorkspaceId: session.staging_workspace_id,
        activationReceipt: activation,
      });
    }
    if (session.state === "outcome_unknown") {
      if (session.staging_workspace_id === null) {
        throw new LocalPromotionConflict("Unknown promotion outcome has no staging workspace");
      }
      return workspacePromotionStateSchema.parse({
        state: "outcome_unknown",
        promotionId: session.promotion_id,
        manifest,
        localWritable: false,
        stagingWorkspaceId: session.staging_workspace_id,
      });
    }
    return workspacePromotionStateSchema.parse({
      state: "promoting",
      promotionId: session.promotion_id,
      manifest,
      localWritable: false,
      ...(session.staging_workspace_id === null
        ? {}
        : { stagingWorkspaceId: session.staging_workspace_id }),
      acceptedBatchReceipts: this.#batchReceipts(session.promotion_id),
    });
  }

  #transition(
    promotionId: string,
    input: Readonly<{
      from: readonly z.infer<typeof sessionRowSchema>["state"][];
      to: z.infer<typeof sessionRowSchema>["state"];
      authorityPhase: "snapshot_frozen" | "staging" | "uploading" | "activating"
        | "outcome_unknown";
      stagingWorkspaceId?: string | undefined;
      now: number;
    }>,
  ): WorkspacePromotionState {
    return this.#database.transaction(() => {
      const session = this.#requireSession(promotionId);
      if (!input.from.includes(session.state)) throw new LocalPromotionConflict();
      if (
        input.stagingWorkspaceId !== undefined &&
        session.staging_workspace_id !== null &&
        session.staging_workspace_id !== input.stagingWorkspaceId
      ) {
        throw new LocalPromotionConflict();
      }
      const stagingWorkspaceId = input.stagingWorkspaceId ??
        session.staging_workspace_id;
      this.#database.query(`
        UPDATE local_promotion_sessions
        SET state = ?2, staging_workspace_id = ?3, updated_at = ?4
        WHERE promotion_id = ?1
      `).run(promotionId, input.to, stagingWorkspaceId, input.now);
      this.#setWorkspacePhase(session.workspace_id, input.authorityPhase, input.now);
      return this.state(session.workspace_id);
    })();
  }

  #setSessionAndWorkspacePhase(
    session: z.infer<typeof sessionRowSchema>,
    state: z.infer<typeof sessionRowSchema>["state"],
    phase: "snapshot_frozen" | "staging" | "uploading" | "activating"
      | "outcome_unknown",
    now: number,
  ): void {
    this.#database.query(`
      UPDATE local_promotion_sessions SET state = ?2, updated_at = ?3
      WHERE promotion_id = ?1
    `).run(session.promotion_id, state, now);
    this.#setWorkspacePhase(session.workspace_id, phase, now);
  }

  #setWorkspacePhase(workspaceId: string, phase: string, now: number): void {
    const result = this.#database.query(`
      UPDATE local_workspaces SET authority_phase = ?2, updated_at = ?3
      WHERE workspace_id = ?1 AND authority_kind = 'promoting'
    `).run(workspaceId, phase, now);
    if (result.changes !== 1) throw new LocalPromotionConflict();
  }

  #assertTerminalLocalWork(manifest: PromotionManifest): void {
    const value: unknown = this.#database.query(`
      SELECT
        (SELECT count(*) FROM local_queued_run_intents
          WHERE workspace_id = ?1 AND state IN ('queued', 'claimed', 'started'))
          AS queued_intents,
        (SELECT count(*) FROM local_task_claims
          WHERE workspace_id = ?1 AND state = 'active') AS active_claims,
        (SELECT count(*) FROM local_task_runs
          WHERE workspace_id = ?1 AND phase IN (
            'queued', 'leased', 'provisioning', 'starting', 'running',
            'waiting', 'cancel_requested', 'ambiguous'
          )) AS nonterminal_runs,
        (SELECT count(*) FROM local_run_interactions
          WHERE workspace_id = ?1 AND state IN ('pending', 'answered'))
          AS open_interactions
    `).get(manifest.sourceWorkspaceId);
    const counts = z.object({
      queued_intents: z.number().int().nonnegative(),
      active_claims: z.number().int().nonnegative(),
      nonterminal_runs: z.number().int().nonnegative(),
      open_interactions: z.number().int().nonnegative(),
    }).strict().parse(value);
    if (
      counts.queued_intents !== 0 ||
      counts.active_claims !== 0 ||
      counts.nonterminal_runs !== 0 ||
      counts.open_interactions !== 0
    ) {
      throw new LocalPromotionConflict("Local work must be terminal before promotion");
    }
  }

  #sessionByPromotion(promotionId: string): z.infer<typeof sessionRowSchema> | null {
    const value: unknown = this.#database.query(`
      SELECT promotion_id, workspace_id, state, destination_organization_id,
        staging_workspace_id, source_workspace_revision, source_event_sequence,
        created_at, updated_at
      FROM local_promotion_sessions WHERE promotion_id = ?1
    `).get(promotionId);
    return sessionRowSchema.nullable().parse(value);
  }

  #requireSession(promotionId: string): z.infer<typeof sessionRowSchema> {
    const session = this.#sessionByPromotion(promotionId);
    if (session === null) throw new LocalPromotionConflict("Promotion does not exist");
    return session;
  }

  #batchReceipts(promotionId: string): readonly PromotionBatchReceipt[] {
    const values: unknown[] = this.#database.query(`
      SELECT receipt_json FROM local_promotion_upload_receipts
      WHERE promotion_id = ?1
      ORDER BY acceptance_sequence
    `).all(promotionId);
    return values.map((value) => {
      const row = z.object({ receipt_json: z.string() }).strict().parse(value);
      return promotionBatchReceiptSchema.parse(parseJson(row.receipt_json));
    });
  }

  #activationReceipt(promotionId: string): PromotionActivationReceipt | null {
    const value: unknown = this.#database.query(`
      SELECT receipt_json FROM local_promotion_activation_receipts
      WHERE promotion_id = ?1
    `).get(promotionId);
    const row = activationRowSchema.nullable().parse(value);
    return row === null
      ? null
      : promotionActivationReceiptSchema.parse(parseJson(row.receipt_json));
  }
}

function familyDigest(
  family: string,
  entities: PromotionSnapshot["entities"],
): string {
  const canonical = [...entities]
    .sort((left, right) =>
      compareCanonicalText(
        promotionEntityIdentity(left),
        promotionEntityIdentity(right),
      ))
    .map((entity) => canonicalJson(entity))
    .join("\n");
  return `sha256_${createHash("sha256")
    .update(`hraness-kitchen:promotion-family:v1\n${family}\n${canonical}`)
    .digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
      return JSON.stringify(value);
    case "object":
      return `{${Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => compareCanonicalText(left, right))
        .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
        .join(",")}}`;
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      throw new TypeError("Promotion records must contain only JSON values");
  }
  throw new TypeError("Promotion records must contain only JSON values");
}

function compareCanonicalText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}
