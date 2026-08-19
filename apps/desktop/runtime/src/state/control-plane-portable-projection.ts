import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Database } from "bun:sqlite";
import { z } from "@hra-internal/schema";

import { operationReceiptKeyByteLength } from "./operation-receipt-key";
import {
  PROVIDER_THREAD_ARCHIVE_JOURNAL_V57_SQL,
  ProviderThreadArchiveJournalV57,
} from "./provider-thread-archive-journal-v57";

export const PORTABLE_PROVIDER_CONTEXT_PROJECTION_VERSION = 3 as const;

const hexDigestSchema = z.string().length(64).regex(/^[0-9a-f]{64}$/u);
const isoDateTimeSchema = z.string().datetime({ offset: true });
const bindingRowSchema = z.object({
  binding_id: z.string(),
  binding_key_digest: hexDigestSchema,
  pane_id: z.string(),
  revision: z.number().int().positive().safe(),
  state: z.enum(["active", "ambiguous", "released"]),
  ambiguity_receipt_digest: hexDigestSchema.nullable(),
  containment_receipt_digest: hexDigestSchema.nullable(),
}).strict();
const paneEvidenceRowSchema = z.object({
  pane_id: z.string(),
  revision: z.number().int().positive().safe(),
  interaction_mode: z.literal("chat"),
  state: z.enum(["ready", "starting", "streaming", "continuing", "attention"]),
  provider_account_profile_id: z.string().nullable(),
  provider_thread_id: z.string().nullable(),
  provider_restart_thread_id: z.string().nullable(),
  active_provider_turn_id: z.string().nullable(),
  active_turn_poisoned: z.literal(1),
  provider_context_reset_required: z.literal(1),
  provider_history_floor_sequence: z.number().int().nonnegative().safe(),
  history_max_sequence: z.number().int().nonnegative().safe(),
  assistant_item_id: z.string().nullable(),
  assistant_item_stream_text: z.string(),
  assistant_item_stream_utf8_bytes: z.number().int().nonnegative().safe(),
  assistant_item_stream_overflow: z.union([z.literal(0), z.literal(1)]),
  assistant_item_verified: z.union([z.literal(0), z.literal(1)]),
  tools_json: z.string(),
  reasoning_tail: z.string(),
  reasoning_total_utf8_bytes: z.number().int().nonnegative().safe(),
  reasoning_verified_tail: z.string(),
  reasoning_verified_total_utf8_bytes: z.number().int().nonnegative().safe(),
  reasoning_active_item_id: z.string().nullable(),
  reasoning_proof_tainted: z.union([z.literal(0), z.literal(1)]),
  provider_subagents_json: z.string(),
  provider_subagent_overflow_count: z.number().int().nonnegative().safe(),
  attention_code: z.string().nullable(),
  attention_retryable: z.union([z.literal(0), z.literal(1)]).nullable(),
  message_queue_pause_reason: z.string().nullable(),
}).strict();
const providerLeaseRowSchema = z.object({
  binding_id: z.string(),
  pane_id: z.string(),
  attachment_id: z.string(),
  acquired_at: z.string(),
}).strict();
const providerThreadArchiveIntentRowSchema = z.object({
  pane_id: z.string(),
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
  account_profile_id: z.string(),
  thread_id: z.string(),
  restart_thread_id: z.string(),
  binding_id: z.string().nullable(),
  binding_key_digest: hexDigestSchema.nullable(),
  binding_revision: z.number().int().positive().safe().nullable(),
  generation: z.number().int().positive().safe(),
  generation_contained: z.union([z.literal(0), z.literal(1)]),
  generation_containment_receipt: z.string().nullable(),
  effect_attempt: z.number().int().nonnegative().safe(),
  containment_receipt: z.string().nullable(),
  response_generation: z.number().int().positive().safe().nullable(),
  response_stream_position: z.number().int().nonnegative().safe().nullable(),
  ambiguity_receipt: z.string().nullable(),
  reconciliation_disposition: z.enum(["applied", "not_applied"]).nullable(),
  reconciliation_receipt: z.string().nullable(),
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
}).strict();
const completeAuthorityRowSchema = z.record(
  z.string(),
  z.union([z.string(), z.number().safe(), z.null()]),
);

type BindingRow = z.infer<typeof bindingRowSchema>;
type PaneEvidenceRow = z.infer<typeof paneEvidenceRowSchema>;
type ProviderThreadArchiveIntentRow = z.infer<
  typeof providerThreadArchiveIntentRowSchema
>;
type CompleteAuthorityRow = z.infer<typeof completeAuthorityRowSchema>;

interface ProviderThreadArchiveAuthorityRowsV57 {
  readonly targets: readonly CompleteAuthorityRow[];
  readonly attempts: readonly CompleteAuthorityRow[];
  readonly cuts: readonly CompleteAuthorityRow[];
  readonly cutMembers: readonly CompleteAuthorityRow[];
}

export const portableProviderContextProjectionAttestationSchema = z.object({
  version: z.literal(PORTABLE_PROVIDER_CONTEXT_PROJECTION_VERSION),
  affectedPaneCount: z.number().int().nonnegative().safe(),
  removedBindingCount: z.number().int().nonnegative().safe(),
  removedLeaseCount: z.number().int().nonnegative().safe(),
  removedArchiveIntentCount: z.number().int().nonnegative().safe(),
  removedArchiveTargetCount: z.number().int().nonnegative().safe(),
  removedArchiveAttemptCount: z.number().int().nonnegative().safe(),
  removedArchiveCutCount: z.number().int().nonnegative().safe(),
  removedArchiveCutMemberCount: z.number().int().nonnegative().safe(),
  removedAuthoritySha256: hexDigestSchema,
  requiresFreshSend: z.literal(true),
  sourceDatabaseSha256: hexDigestSchema,
  attachmentVaultGenerationSha256: hexDigestSchema,
  projectedAt: isoDateTimeSchema,
  projectionHmacSha256: hexDigestSchema,
}).strict();

export type PortableProviderContextProjectionAttestation = Readonly<
  z.infer<typeof portableProviderContextProjectionAttestationSchema>
>;

export interface ProjectPortableProviderContextInput {
  /**
   * A closed serialized snapshot. The projector deserializes its own private
   * in-memory database and never receives a live control-plane connection.
   */
  readonly sourceDatabaseBytes: Uint8Array;
  readonly operationReceiptKey: Uint8Array;
  readonly sourceDatabaseSha256: string;
  readonly attachmentVaultGenerationSha256: string;
  readonly now: Date;
}

export interface ProjectPortableProviderContextResult {
  readonly databaseBytes: Uint8Array;
  readonly attestation: PortableProviderContextProjectionAttestation;
}

export class PortableProviderContextProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortableProviderContextProjectionError";
  }
}

/**
 * Removes resumable attachment-provider authority only from the deserialized
 * backup copy. Display history and attachment bytes remain intact. Affected
 * panes retain a monotonic provider-history floor so a later fresh send cannot
 * inject pre-restore attachment context into a different provider runtime.
 */
export function projectPortableProviderContext(
  input: ProjectPortableProviderContextInput,
): ProjectPortableProviderContextResult {
  const receiptKey = parseReceiptKey(input.operationReceiptKey);
  const sourceDatabaseSha256 = hexDigestSchema.parse(input.sourceDatabaseSha256);
  const attachmentVaultGenerationSha256 = hexDigestSchema.parse(
    input.attachmentVaultGenerationSha256,
  );
  const now = isoDateTimeSchema.parse(input.now.toISOString());
  let database: Database | null = null;
  try {
    const projectionDatabase = Database.deserialize(input.sourceDatabaseBytes, {
      strict: true,
    });
    database = projectionDatabase;
    configureProjectionDatabase(projectionDatabase);
    let proof: PortableProviderContextProjectionAttestation | null = null;
    projectionDatabase.transaction(() => {
      const bindings = readBindings(projectionDatabase);
      const leases = readProviderLeases(projectionDatabase);
      const providerThreadArchiveIntents = readProviderThreadArchiveIntents(
        projectionDatabase,
      );
      const providerThreadArchiveAuthorityV57 = readProviderThreadArchiveAuthorityV57(
        projectionDatabase,
      );
      verifyProviderThreadArchiveAuthorityV57(
        projectionDatabase,
        receiptKey,
        providerThreadArchiveAuthorityV57,
      );
      const alreadyResetPaneIds = readResetRequiredPaneIds(projectionDatabase);
      const affectedPaneIds = [...new Set([
        ...bindings.map(({ pane_id: paneId }) => paneId),
        ...providerThreadArchiveIntents.map(({ pane_id: paneId }) => paneId),
        ...providerThreadArchiveAuthorityV57.targets.map((row) =>
          requiredAuthorityString(row, "pane_id")
        ),
        ...providerThreadArchiveAuthorityV57.cutMembers.map((row) =>
          requiredAuthorityString(row, "pane_id")
        ),
        ...alreadyResetPaneIds,
      ])].toSorted(compareCanonicalText);
      const removedAuthoritySha256 = createHash("sha256")
        .update("hra.control-plane.removed-provider-authority.v3\0", "utf8")
        .update(canonicalJson({
          bindings,
          leases,
          providerThreadArchiveIntents,
          providerThreadArchiveAuthorityV57,
        }), "utf8")
        .digest("hex");

      deleteProviderThreadArchiveAuthorityV57(
        projectionDatabase,
        providerThreadArchiveAuthorityV57,
      );

      const removedArchiveIntents = projectionDatabase.query(
        "DELETE FROM chat_provider_thread_archive_intents",
      ).run();
      if (
        Number(removedArchiveIntents.changes) !== providerThreadArchiveIntents.length
        || readProviderThreadArchiveIntents(projectionDatabase).length !== 0
      ) {
        throw new PortableProviderContextProjectionError(
          "Portable provider thread archive-intent deletion did not settle exactly once.",
        );
      }

      const removed = projectionDatabase.query(
        "DELETE FROM chat_provider_attachment_bindings",
      ).run();
      if (
        (bindings.length > 0 && Number(removed.changes) < bindings.length) ||
        readBindings(projectionDatabase).length !== 0
      ) {
        throw new PortableProviderContextProjectionError(
          "Portable provider binding deletion did not settle exactly once.",
        );
      }
      if (readProviderLeases(projectionDatabase).length !== 0) {
        throw new PortableProviderContextProjectionError(
          "Portable provider attachment leases survived binding deletion.",
        );
      }

      for (const paneId of affectedPaneIds) {
        const paneIdentity = z.object({
          state: z.string(),
          interaction_mode: z.string(),
        }).strict().parse(
          projectionDatabase.query(`
            SELECT state, interaction_mode FROM chat_panes WHERE pane_id = ?1
          `)
            .get(paneId),
        );
        if (paneIdentity.interaction_mode !== "chat") {
          throw new PortableProviderContextProjectionError(
            "Only an ordinary chat pane may own portable attachment context.",
          );
        }
        const state = paneIdentity.state;
        const active = state === "starting" || state === "streaming" ||
          state === "continuing";
        const changed = projectionDatabase.query(`
          UPDATE chat_panes
          SET provider_account_profile_id = NULL,
              provider_thread_id = NULL,
              provider_restart_thread_id = NULL,
              active_provider_turn_id = NULL,
              active_turn_poisoned = 1,
              provider_context_reset_required = 1,
              assistant_item_id = NULL,
              assistant_item_stream_text = '',
              assistant_item_stream_utf8_bytes = 0,
              assistant_item_stream_overflow = 0,
              assistant_item_verified = 0,
              tools_json = '[]',
              reasoning_tail = reasoning_verified_tail,
              reasoning_total_utf8_bytes = reasoning_verified_total_utf8_bytes,
              reasoning_active_item_id = NULL,
              reasoning_proof_tainted = 0,
              provider_subagents_json = '[]',
              provider_subagent_overflow_count = 0,
              provider_history_floor_sequence = MAX(
                provider_history_floor_sequence,
                COALESCE((
                  SELECT MAX(history.sequence)
                  FROM chat_pane_history AS history
                  WHERE history.pane_id = chat_panes.pane_id
                ), 0)
              ),
              state = CASE WHEN ?1 = 1 THEN state ELSE 'attention' END,
              attention_code = CASE
                WHEN ?1 = 1 THEN attention_code ELSE 'runtime_unavailable'
              END,
              attention_message = CASE
                WHEN ?1 = 1 THEN attention_message
                ELSE 'Restored attachment context cannot resume. Send a new message to start fresh.'
              END,
              attention_retryable = CASE
                WHEN ?1 = 1 THEN attention_retryable ELSE 0
              END,
              message_queue_pause_reason = CASE
                WHEN message_queue_pause_reason = 'ambiguous_effect'
                  THEN message_queue_pause_reason
                ELSE 'attention'
              END,
              message_queue_revision = message_queue_revision + CASE
                WHEN message_queue_pause_reason IN ('ambiguous_effect', 'attention')
                  THEN 0 ELSE 1
              END,
              revision = revision + 1,
              updated_at = ?2
          WHERE pane_id = ?3
        `).run(active ? 1 : 0, now, paneId);
        if (changed.changes !== 1) {
          throw new PortableProviderContextProjectionError(
            "An attachment-bearing pane changed during portable projection.",
          );
        }
      }
      const core = Object.freeze({
        version: PORTABLE_PROVIDER_CONTEXT_PROJECTION_VERSION,
        affectedPaneCount: affectedPaneIds.length,
        removedBindingCount: bindings.length,
        removedLeaseCount: leases.length,
        removedArchiveIntentCount: providerThreadArchiveIntents.length,
        removedArchiveTargetCount:
          providerThreadArchiveAuthorityV57.targets.length,
        removedArchiveAttemptCount:
          providerThreadArchiveAuthorityV57.attempts.length,
        removedArchiveCutCount:
          providerThreadArchiveAuthorityV57.cuts.length,
        removedArchiveCutMemberCount:
          providerThreadArchiveAuthorityV57.cutMembers.length,
        removedAuthoritySha256,
        requiresFreshSend: true as const,
        sourceDatabaseSha256,
        attachmentVaultGenerationSha256,
        projectedAt: now,
      });
      proof = Object.freeze({
        ...core,
        projectionHmacSha256: projectionHmac(receiptKey, core),
      });
    })();
    if (proof === null) {
      throw new PortableProviderContextProjectionError(
        "Portable provider-context projection produced no proof.",
      );
    }
    const inspected = inspectPortableProviderContext(
      projectionDatabase,
      receiptKey,
      proof,
    );
    const databaseBytes = projectionDatabase.serialize();
    return Object.freeze({ databaseBytes, attestation: inspected });
  } catch (error: unknown) {
    if (error instanceof PortableProviderContextProjectionError) throw error;
    throw new PortableProviderContextProjectionError(
      `The portable provider-context projection failed: ${errorMessage(error)}`,
    );
  } finally {
    database?.close();
    receiptKey.fill(0);
  }
}

/**
 * Validates the authenticated creation attestation and the projected copy's
 * remaining semantic fence. The source database/vault preimages are deleted
 * by projection and therefore must also be bound, with the projected database
 * digest, inside the encrypted backup manifest.
 */
export function inspectPortableProviderContext(
  database: Database,
  operationReceiptKey: Uint8Array,
  expectedAttestation: PortableProviderContextProjectionAttestation,
): PortableProviderContextProjectionAttestation {
  const receiptKey = parseReceiptKey(operationReceiptKey);
  try {
    const expected = parseProjectionAttestation(expectedAttestation);
    const core = {
      version: expected.version,
      affectedPaneCount: expected.affectedPaneCount,
      removedBindingCount: expected.removedBindingCount,
      removedLeaseCount: expected.removedLeaseCount,
      removedArchiveIntentCount: expected.removedArchiveIntentCount,
      removedArchiveTargetCount: expected.removedArchiveTargetCount,
      removedArchiveAttemptCount: expected.removedArchiveAttemptCount,
      removedArchiveCutCount: expected.removedArchiveCutCount,
      removedArchiveCutMemberCount: expected.removedArchiveCutMemberCount,
      removedAuthoritySha256: expected.removedAuthoritySha256,
      requiresFreshSend: expected.requiresFreshSend,
      sourceDatabaseSha256: expected.sourceDatabaseSha256,
      attachmentVaultGenerationSha256: expected.attachmentVaultGenerationSha256,
      projectedAt: expected.projectedAt,
    };
    if (!equalHex(
      projectionHmac(receiptKey, core),
      expected.projectionHmacSha256,
    )) {
      throw new PortableProviderContextProjectionError(
        "The portable provider-context proof is not bound to this receipt key.",
      );
    }
    const bindings = readBindings(database);
    const leases = readProviderLeases(database);
    const providerThreadArchiveIntents = readProviderThreadArchiveIntents(database);
    const providerThreadArchiveAuthorityV57 = readProviderThreadArchiveAuthorityV57(
      database,
    );
    verifyProviderThreadArchiveAuthorityV57(
      database,
      receiptKey,
      providerThreadArchiveAuthorityV57,
    );
    if (
      bindings.length !== 0
      || leases.length !== 0
      || providerThreadArchiveIntents.length !== 0
      || providerThreadArchiveAuthorityV57.targets.length !== 0
      || providerThreadArchiveAuthorityV57.attempts.length !== 0
      || providerThreadArchiveAuthorityV57.cuts.length !== 0
      || providerThreadArchiveAuthorityV57.cutMembers.length !== 0
    ) {
      throw new PortableProviderContextProjectionError(
        "The portable copy still contains resumable provider metadata.",
      );
    }
    const affectedPaneIds = readResetRequiredPaneIds(database);
    const panes = affectedPaneIds.map((paneId) => readPaneEvidence(database, paneId));
    if (panes.length !== expected.affectedPaneCount) {
      throw new PortableProviderContextProjectionError(
        "The portable provider-context pane count differs from its proof.",
      );
    }
    for (const pane of panes) {
      if (
        pane.provider_account_profile_id !== null ||
        pane.provider_thread_id !== null ||
        pane.provider_restart_thread_id !== null ||
        pane.active_provider_turn_id !== null ||
        pane.provider_history_floor_sequence < pane.history_max_sequence ||
        pane.assistant_item_id !== null ||
        pane.assistant_item_stream_text !== "" ||
        pane.assistant_item_stream_utf8_bytes !== 0 ||
        pane.assistant_item_stream_overflow !== 0 ||
        pane.assistant_item_verified !== 0 ||
        pane.tools_json !== "[]" ||
        pane.reasoning_tail !== pane.reasoning_verified_tail ||
        pane.reasoning_total_utf8_bytes !== pane.reasoning_verified_total_utf8_bytes ||
        pane.reasoning_active_item_id !== null ||
        pane.reasoning_proof_tainted !== 0 ||
        pane.provider_subagents_json !== "[]" ||
        pane.provider_subagent_overflow_count !== 0 ||
        !["attention", "ambiguous_effect"].includes(
          pane.message_queue_pause_reason ?? "",
        ) ||
        (
          !isActiveState(pane.state) &&
          (
            pane.state !== "attention" ||
            pane.attention_code !== "runtime_unavailable" ||
            pane.attention_retryable !== 0
          )
        )
      ) {
        throw new PortableProviderContextProjectionError(
          "An attachment-bearing pane is not fenced for a fresh provider context.",
        );
      }
    }
    return expected;
  } finally {
    receiptKey.fill(0);
  }
}

function readBindings(database: Database): readonly BindingRow[] {
  const rows: unknown[] = database.query(`
    SELECT binding_id, binding_key_digest, pane_id, revision, state,
           ambiguity_receipt_digest, containment_receipt_digest
    FROM chat_provider_attachment_bindings
    ORDER BY pane_id COLLATE BINARY, binding_id COLLATE BINARY
  `).all();
  return rows.map((row) => bindingRowSchema.parse(row));
}

function readProviderLeases(
  database: Database,
): readonly z.infer<typeof providerLeaseRowSchema>[] {
  const rows: unknown[] = database.query(`
    SELECT binding_id, pane_id, attachment_id, acquired_at
    FROM chat_provider_attachment_leases
    ORDER BY pane_id COLLATE BINARY, binding_id COLLATE BINARY,
             attachment_id COLLATE BINARY
  `).all();
  return rows.map((row) => providerLeaseRowSchema.parse(row));
}

function readProviderThreadArchiveIntents(
  database: Database,
): readonly ProviderThreadArchiveIntentRow[] {
  const rows: unknown[] = database.query(`
    SELECT pane_id, purpose, state, pane_revision, queue_revision,
           account_profile_id, thread_id, restart_thread_id,
           binding_id, binding_key_digest, binding_revision,
           generation, generation_contained, generation_containment_receipt,
           effect_attempt, containment_receipt,
           response_generation, response_stream_position, ambiguity_receipt,
           reconciliation_disposition, reconciliation_receipt,
           created_at, updated_at
    FROM chat_provider_thread_archive_intents
    ORDER BY pane_id COLLATE BINARY
  `).all();
  return rows.map((row) => providerThreadArchiveIntentRowSchema.parse(row));
}

function readProviderThreadArchiveAuthorityV57(
  database: Database,
): ProviderThreadArchiveAuthorityRowsV57 {
  const targetRows: unknown[] = database.query(`
    SELECT * FROM chat_provider_thread_archive_targets_v57
    ORDER BY target_id COLLATE BINARY
  `).all();
  const attemptRows: unknown[] = database.query(`
    SELECT * FROM chat_provider_thread_archive_attempts_v57
    ORDER BY attempt_id COLLATE BINARY
  `).all();
  const cutRows: unknown[] = database.query(`
    SELECT * FROM chat_provider_thread_archive_cuts_v57
    ORDER BY cut_id COLLATE BINARY
  `).all();
  const cutMemberRows: unknown[] = database.query(`
    SELECT * FROM chat_provider_thread_archive_cut_members_v57
    ORDER BY member_id COLLATE BINARY
  `).all();
  return Object.freeze({
    targets: Object.freeze(targetRows.map((row) =>
      completeAuthorityRowSchema.parse(row)
    )),
    attempts: Object.freeze(attemptRows.map((row) =>
      completeAuthorityRowSchema.parse(row)
    )),
    cuts: Object.freeze(cutRows.map((row) =>
      completeAuthorityRowSchema.parse(row)
    )),
    cutMembers: Object.freeze(cutMemberRows.map((row) =>
      completeAuthorityRowSchema.parse(row)
    )),
  });
}

function verifyProviderThreadArchiveAuthorityV57(
  database: Database,
  receiptKey: Uint8Array,
  rows: ProviderThreadArchiveAuthorityRowsV57,
): void {
  const foreignKeyViolations: unknown[] = database.query(
    "PRAGMA foreign_key_check",
  ).all();
  if (foreignKeyViolations.length !== 0) {
    throw new PortableProviderContextProjectionError(
      "Provider-thread archive authority has an unreachable foreign-key row.",
    );
  }
  const journal = new ProviderThreadArchiveJournalV57(database, receiptKey);
  for (const target of rows.targets) {
    journal.reopenTarget(requiredAuthorityString(target, "target_id"));
  }
  for (const cut of rows.cuts) {
    const snapshot = journal.reopenCut(requiredAuthorityString(cut, "cut_id"));
    if (snapshot.state === "fence_started" || snapshot.state === "fenced") {
      throw new PortableProviderContextProjectionError(
        "Portable projection requires every provider-thread archive cut to have a complete sealed inventory.",
      );
    }
  }
}

function deleteProviderThreadArchiveAuthorityV57(
  database: Database,
  expected: ProviderThreadArchiveAuthorityRowsV57,
): void {
  const observed = readProviderThreadArchiveAuthorityV57(database);
  if (canonicalJson(observed) !== canonicalJson(expected)) {
    throw new PortableProviderContextProjectionError(
      "Provider-thread archive authority changed during portable projection.",
    );
  }
  const deleteGuardSql = providerThreadArchiveDeleteGuardSql();
  database.exec(`
    DROP TRIGGER chat_provider_thread_archive_target_delete_guard_v57;
    DROP TRIGGER chat_provider_thread_archive_cut_delete_guard_v57;
    DROP TRIGGER chat_provider_thread_archive_member_delete_guard_v57;
  `);
  try {
    const removedMembers = database.query(
      "DELETE FROM chat_provider_thread_archive_cut_members_v57",
    ).run();
    if (Number(removedMembers.changes) !== expected.cutMembers.length) {
      throw new PortableProviderContextProjectionError(
        "Portable provider-thread archive member deletion did not settle exactly once.",
      );
    }

    const removedTargets = database.query(
      "DELETE FROM chat_provider_thread_archive_targets_v57",
    ).run();
    if (
      Number(removedTargets.changes)
        !== expected.targets.length + expected.attempts.length
    ) {
      throw new PortableProviderContextProjectionError(
        "Portable provider-thread archive target and attempt deletion did not settle exactly once.",
      );
    }
    if (readProviderThreadArchiveAuthorityV57(database).attempts.length !== 0) {
      throw new PortableProviderContextProjectionError(
        "Portable provider-thread archive attempts survived target deletion.",
      );
    }

    const removedCuts = database.query(
      "DELETE FROM chat_provider_thread_archive_cuts_v57",
    ).run();
    if (Number(removedCuts.changes) !== expected.cuts.length) {
      throw new PortableProviderContextProjectionError(
        "Portable provider-thread archive cut deletion did not settle exactly once.",
      );
    }
  } finally {
    for (const sql of deleteGuardSql) database.exec(sql);
  }
  const remaining = readProviderThreadArchiveAuthorityV57(database);
  if (
    remaining.targets.length !== 0
    || remaining.attempts.length !== 0
    || remaining.cuts.length !== 0
    || remaining.cutMembers.length !== 0
  ) {
    throw new PortableProviderContextProjectionError(
      "Portable provider-thread archive authority deletion was incomplete.",
    );
  }
}

const providerThreadArchiveDeleteGuardNames = [
  "chat_provider_thread_archive_target_delete_guard_v57",
  "chat_provider_thread_archive_cut_delete_guard_v57",
  "chat_provider_thread_archive_member_delete_guard_v57",
] as const;

function providerThreadArchiveDeleteGuardSql(): readonly string[] {
  return providerThreadArchiveDeleteGuardNames.map((name) => {
    const marker = `CREATE TRIGGER ${name}`;
    const start = PROVIDER_THREAD_ARCHIVE_JOURNAL_V57_SQL.indexOf(marker);
    const next = start < 0
      ? -1
      : PROVIDER_THREAD_ARCHIVE_JOURNAL_V57_SQL.indexOf("\n\n  CREATE ", start);
    const end = next < 0 ? PROVIDER_THREAD_ARCHIVE_JOURNAL_V57_SQL.length : next;
    const sql = start < 0 ? "" : PROVIDER_THREAD_ARCHIVE_JOURNAL_V57_SQL.slice(start, end)
      .trim();
    if (!sql.startsWith(marker) || !sql.endsWith("END;")) {
      throw new PortableProviderContextProjectionError(
        "Portable projection could not recover its trusted v57 delete guard.",
      );
    }
    return sql;
  });
}

function requiredAuthorityString(
  row: CompleteAuthorityRow,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new PortableProviderContextProjectionError(
      `Provider-thread archive authority lacks ${field}.`,
    );
  }
  return value;
}

function readResetRequiredPaneIds(database: Database): readonly string[] {
  const rows: unknown[] = database.query(`
    SELECT pane_id FROM chat_panes
    WHERE provider_context_reset_required = 1
    ORDER BY pane_id COLLATE BINARY
  `).all();
  return rows.map((row) => z.object({ pane_id: z.string() }).strict().parse(row).pane_id);
}

function readPaneEvidence(database: Database, paneId: string): PaneEvidenceRow {
  return paneEvidenceRowSchema.parse(database.query(`
    SELECT pane.pane_id, pane.revision, pane.interaction_mode, pane.state,
           pane.provider_account_profile_id, pane.provider_thread_id,
           pane.provider_restart_thread_id, pane.active_provider_turn_id,
           pane.active_turn_poisoned, pane.provider_context_reset_required,
           pane.provider_history_floor_sequence,
           COALESCE(MAX(history.sequence), 0) AS history_max_sequence,
           pane.assistant_item_id, pane.assistant_item_stream_text,
           pane.assistant_item_stream_utf8_bytes,
           pane.assistant_item_stream_overflow, pane.assistant_item_verified,
           pane.tools_json, pane.reasoning_tail,
           pane.reasoning_total_utf8_bytes, pane.reasoning_verified_tail,
           pane.reasoning_verified_total_utf8_bytes,
           pane.reasoning_active_item_id, pane.reasoning_proof_tainted,
           pane.provider_subagents_json, pane.provider_subagent_overflow_count,
           pane.attention_code, pane.attention_retryable,
           pane.message_queue_pause_reason
    FROM chat_panes AS pane
    LEFT JOIN chat_pane_history AS history ON history.pane_id = pane.pane_id
    WHERE pane.pane_id = ?1
    GROUP BY pane.pane_id
  `).get(paneId));
}

function parseProjectionAttestation(
  value: PortableProviderContextProjectionAttestation,
): PortableProviderContextProjectionAttestation {
  return portableProviderContextProjectionAttestationSchema.parse(value);
}

function projectionHmac(
  receiptKey: Uint8Array,
  core: Omit<PortableProviderContextProjectionAttestation, "projectionHmacSha256">,
): string {
  return createHmac("sha256", receiptKey)
    .update("hra.control-plane.portable-provider-context-proof.v3\0", "utf8")
    .update(canonicalJson(core), "utf8")
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
      return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      return `{${Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => compareCanonicalText(left, right))
        .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
        .join(",")}}`;
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      throw new PortableProviderContextProjectionError(
        "Portable provider-context receipts require canonical JSON values.",
      );
  }
  throw new PortableProviderContextProjectionError(
    "Portable provider-context receipts require canonical JSON values.",
  );
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseReceiptKey(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== operationReceiptKeyByteLength) {
    throw new PortableProviderContextProjectionError(
      "Portable provider-context projection requires the exact receipt key.",
    );
  }
  return Uint8Array.from(value);
}

function configureProjectionDatabase(database: Database): void {
  database.exec("PRAGMA trusted_schema = OFF");
  database.exec("PRAGMA foreign_keys = ON");
  const trustedSchema = z.object({ trusted_schema: z.literal(0) }).passthrough()
    .parse(database.query("PRAGMA trusted_schema").get());
  const foreignKeys = z.object({ foreign_keys: z.literal(1) }).passthrough()
    .parse(database.query("PRAGMA foreign_keys").get());
  if (trustedSchema.trusted_schema !== 0 || foreignKeys.foreign_keys !== 1) {
    throw new PortableProviderContextProjectionError(
      "Portable projection could not enforce foreign database safety pragmas.",
    );
  }
}

function isActiveState(state: PaneEvidenceRow["state"]): boolean {
  return state === "starting" || state === "streaming" || state === "continuing";
}

function equalHex(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
