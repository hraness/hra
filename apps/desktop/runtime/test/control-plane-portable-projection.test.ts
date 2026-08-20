import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  inspectPortableProviderContext,
  projectPortableProviderContext,
} from "../src/state/control-plane-portable-projection";
import { openControlPlane } from "../src/state/database";
import {
  providerThreadArchiveCompleteInventoryDigestV57,
  ProviderThreadArchiveJournalV57,
} from "../src/state/provider-thread-archive-journal-v57";

const now = new Date("2026-08-18T16:00:00.000Z");
const receiptKey = new Uint8Array(32).fill(7);
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("portable provider-context projection", () => {
  test("rejects an active scheduled chat without mutating the source snapshot", () => {
    const database = fixtureDatabase();
    try {
      const paneId = "pane_portable_schedule001";
      insertPane(database, {
        paneId,
        displayOrder: 0,
        paletteIndex: 0,
        state: "ready",
      });
      const sessionId = insertScheduledChatBinding(database, paneId);
      insertScheduledChatActive(database, paneId, sessionId);
      const sourceSnapshot = Buffer.from(database.serialize());

      expect(() => projectFixture(database, {
        sourceDatabaseSha256: "8".repeat(64),
        attachmentVaultGenerationSha256: "9".repeat(64),
      })).toThrow("Turn off scheduled chats first");
      expect(Buffer.from(database.serialize())).toEqual(sourceSnapshot);
    } finally {
      database.close();
    }
  });

  test("rejects every prepared or effect-started scheduled-chat mutation", () => {
    for (const state of ["prepared", "effect_started"] as const) {
      const database = fixtureDatabase();
      try {
        const paneId = `pane_portable_${state === "prepared" ? "prepared" : "effect"}001`;
        insertPane(database, {
          paneId,
          displayOrder: 0,
          paletteIndex: 0,
          state: "ready",
        });
        const sessionId = insertScheduledChatBinding(database, paneId);
        insertScheduledChatMutation(database, paneId, sessionId, state);
        const sourceSnapshot = Buffer.from(database.serialize());

        expect(() => projectFixture(database, {
          sourceDatabaseSha256: "a".repeat(64),
          attachmentVaultGenerationSha256: "b".repeat(64),
        })).toThrow("Turn off scheduled chats first");
        expect(Buffer.from(database.serialize())).toEqual(sourceSnapshot);
      } finally {
        database.close();
      }
    }
  });

  test("rejects a durable schedule-off recovery intent", () => {
    const database = fixtureDatabase();
    try {
      const paneId = "pane_portable_offintent001";
      insertPane(database, {
        paneId,
        displayOrder: 0,
        paletteIndex: 0,
        state: "ready",
      });
      const sessionId = insertScheduledChatBinding(database, paneId);
      database.query(`
        INSERT INTO chat_scheduled_chat_desired_off(
          pane_id, session_id, target_generation, created_at, updated_at
        ) VALUES (?1, ?2, '1', ?3, ?3)
      `).run(paneId, sessionId, now.getTime());
      const sourceSnapshot = Buffer.from(database.serialize());

      expect(() => projectFixture(database, {
        sourceDatabaseSha256: "e".repeat(64),
        attachmentVaultGenerationSha256: "f".repeat(64),
      })).toThrow("Turn off scheduled chats first");
      expect(Buffer.from(database.serialize())).toEqual(sourceSnapshot);
    } finally {
      database.close();
    }
  });

  test("allows a cleared schedule's generation high-water without removing it", () => {
    const database = fixtureDatabase();
    let projected: Database | null = null;
    try {
      const paneId = "pane_portable_cleared0001";
      insertPane(database, {
        paneId,
        displayOrder: 0,
        paletteIndex: 0,
        state: "ready",
      });
      const sessionId = insertScheduledChatBinding(database, paneId);
      database.query(`
        INSERT INTO chat_scheduled_chat_generation_high_water(
          pane_id, session_id, generation, updated_at
        ) VALUES (?1, ?2, '7', ?3)
      `).run(paneId, sessionId, now.getTime());

      const result = projectFixture(database, {
        sourceDatabaseSha256: "c".repeat(64),
        attachmentVaultGenerationSha256: "d".repeat(64),
      });
      projected = result.database;
      expect(projected.query(`
        SELECT pane_id, session_id, generation
        FROM chat_scheduled_chat_generation_high_water
      `).get()).toEqual({ pane_id: paneId, session_id: sessionId, generation: "7" });
    } finally {
      projected?.close();
      database.close();
    }
  });

  test("accepts a valid v61 cleared-schedule snapshot without the v62 off-intent table", () => {
    const database = fixtureDatabase();
    let projected: Database | null = null;
    try {
      const paneId = "pane_portable_v61clear01";
      insertPane(database, {
        paneId,
        displayOrder: 0,
        paletteIndex: 0,
        state: "ready",
      });
      const sessionId = insertScheduledChatBinding(database, paneId);
      database.query(`
        INSERT INTO chat_scheduled_chat_generation_high_water(
          pane_id, session_id, generation, updated_at
        ) VALUES (?1, ?2, '7', ?3)
      `).run(paneId, sessionId, now.getTime());
      downgradeScheduledChatSchemaToV61(database);

      const result = projectFixture(database, {
        sourceDatabaseSha256: "6".repeat(64),
        attachmentVaultGenerationSha256: "7".repeat(64),
      });
      projected = result.database;
      expect(projected.query(`
        SELECT generation FROM chat_scheduled_chat_generation_high_water
        WHERE pane_id = ?1 AND session_id = ?2
      `).get(paneId, sessionId)).toEqual({ generation: "7" });
      expect(projected.query(`
        SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name = 'chat_scheduled_chat_desired_off'
      `).get()).toBeNull();
      expect(projected.query(`
        SELECT MAX(version) AS version FROM schema_migrations
      `).get()).toEqual({ version: 61 });
    } finally {
      projected?.close();
      database.close();
    }
  });

  test("rejects a v62 snapshot that omits its durable off-intent table", () => {
    const database = fixtureDatabase();
    try {
      database.exec(`
        DROP TRIGGER chat_scheduled_chat_desired_off_pane_update_quarantine;
        DROP TRIGGER chat_scheduled_chat_desired_off_pane_delete_quarantine;
        DROP TABLE chat_scheduled_chat_desired_off;
      `);
      expect(() => projectFixture(database, {
        sourceDatabaseSha256: "4".repeat(64),
        attachmentVaultGenerationSha256: "5".repeat(64),
      })).toThrow("Scheduled-chat portability state is incomplete");
    } finally {
      database.close();
    }
  });

  test("removes provider binding metadata while retaining display history and bytes authority", () => {
    const database = fixtureDatabase();
    let projected: Database | null = null;
    try {
      insertPane(database, {
        paneId: "pane_portable_terminal01",
        displayOrder: 0,
        paletteIndex: 0,
        state: "ready",
      });
      insertHistory(database, "pane_portable_terminal01", [
        [1, "user", "look at the attached design"],
        [2, "assistant", "I reviewed it."],
      ]);
      insertProviderBinding(database, {
        bindingId: "attbinding_portable_terminal01",
        paneId: "pane_portable_terminal01",
        state: "active",
      });
      insertProviderAttachmentLease(database, {
        attachmentId: "attachment_portable_terminal01",
        bindingId: "attbinding_portable_terminal01",
        paneId: "pane_portable_terminal01",
      });

      const result = projectFixture(database, {
        sourceDatabaseSha256: "a".repeat(64),
        attachmentVaultGenerationSha256: "b".repeat(64),
      });
      projected = result.database;
      const proof = result.attestation;

      expect(proof).toMatchObject({
        version: 3,
        affectedPaneCount: 1,
        removedBindingCount: 1,
        removedLeaseCount: 1,
        removedArchiveIntentCount: 0,
        removedArchiveTargetCount: 0,
        removedArchiveAttemptCount: 0,
        removedArchiveCutCount: 0,
        removedArchiveCutMemberCount: 0,
        requiresFreshSend: true,
      });
      expect(proof.projectionHmacSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(inspectPortableProviderContext(projected, receiptKey, proof)).toEqual(proof);
      expect(projected.query(`
        SELECT state
        FROM chat_provider_attachment_bindings
        WHERE binding_id = 'attbinding_portable_terminal01'
      `).get()).toBeNull();
      expect(projected.query(`
        SELECT binding_id FROM chat_provider_attachment_leases
        WHERE binding_id = 'attbinding_portable_terminal01'
      `).get()).toBeNull();
      expect(projected.query(`
        SELECT state, provider_account_profile_id, provider_thread_id,
               provider_restart_thread_id, active_turn_poisoned,
               provider_context_reset_required,
               provider_history_floor_sequence, attention_code,
               attention_retryable, message_queue_pause_reason
        FROM chat_panes WHERE pane_id = 'pane_portable_terminal01'
      `).get()).toEqual({
        state: "attention",
        provider_account_profile_id: null,
        provider_thread_id: null,
        provider_restart_thread_id: null,
        active_turn_poisoned: 1,
        provider_context_reset_required: 1,
        provider_history_floor_sequence: 2,
        attention_code: "runtime_unavailable",
        attention_retryable: 0,
        message_queue_pause_reason: "attention",
      });
      expect(projected.query(`
        SELECT sequence, role, text FROM chat_pane_history
        WHERE pane_id = 'pane_portable_terminal01' ORDER BY sequence
      `).all()).toEqual([
        { sequence: 1, role: "user", text: "look at the attached design" },
        { sequence: 2, role: "assistant", text: "I reviewed it." },
      ]);
    } finally {
      projected?.close();
      database.close();
    }
  });

  test("pre-poisons active panes for ordinary startup recovery without fabricating terminal state", () => {
    const database = fixtureDatabase();
    let projected: Database | null = null;
    try {
      insertPane(database, {
        paneId: "pane_portable_active0001",
        displayOrder: 0,
        paletteIndex: 0,
        state: "streaming",
      });
      insertHistory(database, "pane_portable_active0001", [
        [1, "user", "prior visible request"],
      ]);
      insertProviderBinding(database, {
        bindingId: "attbinding_portable_active0001",
        paneId: "pane_portable_active0001",
        state: "ambiguous",
      });

      const result = projectFixture(database, {
        sourceDatabaseSha256: "c".repeat(64),
        attachmentVaultGenerationSha256: "d".repeat(64),
      });
      projected = result.database;

      expect(projected.query(`
        SELECT state, turn_status, turn_completed_at, active_turn_poisoned,
               active_provider_turn_id, provider_history_floor_sequence,
               attention_code, attention_retryable
        FROM chat_panes WHERE pane_id = 'pane_portable_active0001'
      `).get()).toEqual({
        state: "streaming",
        turn_status: "streaming",
        turn_completed_at: null,
        active_turn_poisoned: 1,
        active_provider_turn_id: null,
        provider_history_floor_sequence: 1,
        attention_code: null,
        attention_retryable: null,
      });
      expect(projected.query(`
        SELECT state FROM chat_provider_attachment_bindings
        WHERE binding_id = 'attbinding_portable_active0001'
      `).get()).toBeNull();
    } finally {
      projected?.close();
      database.close();
    }
  });

  test("rejects a projected copy whose provider fence no longer matches its attestation", () => {
    const database = fixtureDatabase();
    let projected: Database | null = null;
    try {
      insertPane(database, {
        paneId: "pane_portable_tamper0001",
        displayOrder: 0,
        paletteIndex: 0,
        state: "ready",
      });
      insertProviderBinding(database, {
        bindingId: "attbinding_portable_tamper0001",
        paneId: "pane_portable_tamper0001",
        state: "active",
      });
      const result = projectFixture(database, {
        sourceDatabaseSha256: "e".repeat(64),
        attachmentVaultGenerationSha256: "1".repeat(64),
      });
      const projectedDatabase = result.database;
      projected = projectedDatabase;
      const proof = result.attestation;
      projectedDatabase.query(`
        UPDATE chat_panes SET tools_json = '[{"category":"other","status":"running"}]',
                              revision = revision + 1
        WHERE pane_id = 'pane_portable_tamper0001'
      `).run();
      expect(() => inspectPortableProviderContext(
        projectedDatabase,
        receiptKey,
        proof,
      ))
        .toThrow("not fenced");
    } finally {
      projected?.close();
      database.close();
    }
  });

  test("binds every source-identity field to the private projection attestation", () => {
    const database = fixtureDatabase();
    let projected: Database | null = null;
    try {
      insertPane(database, {
        paneId: "pane_portable_proof00001",
        displayOrder: 0,
        paletteIndex: 0,
        state: "ready",
      });
      insertProviderBinding(database, {
        bindingId: "attbinding_portable_proof00001",
        paneId: "pane_portable_proof00001",
        state: "active",
      });
      const result = projectFixture(database, {
        sourceDatabaseSha256: "2".repeat(64),
        attachmentVaultGenerationSha256: "3".repeat(64),
      });
      const projectedDatabase = result.database;
      projected = projectedDatabase;
      const proof = result.attestation;

      for (const changed of [
        { ...proof, affectedPaneCount: proof.affectedPaneCount + 1 },
        { ...proof, sourceDatabaseSha256: "4".repeat(64) },
        { ...proof, attachmentVaultGenerationSha256: "5".repeat(64) },
        { ...proof, projectedAt: "2026-08-18T16:00:01.000Z" },
        { ...proof, removedBindingCount: proof.removedBindingCount + 1 },
        { ...proof, removedLeaseCount: proof.removedLeaseCount + 1 },
        {
          ...proof,
          removedArchiveIntentCount: proof.removedArchiveIntentCount + 1,
        },
        {
          ...proof,
          removedArchiveTargetCount: proof.removedArchiveTargetCount + 1,
        },
        {
          ...proof,
          removedArchiveAttemptCount: proof.removedArchiveAttemptCount + 1,
        },
        {
          ...proof,
          removedArchiveCutCount: proof.removedArchiveCutCount + 1,
        },
        {
          ...proof,
          removedArchiveCutMemberCount:
            proof.removedArchiveCutMemberCount + 1,
        },
        { ...proof, removedAuthoritySha256: "6".repeat(64) },
        { ...proof, projectionHmacSha256: "7".repeat(64) },
      ]) {
        expect(() => inspectPortableProviderContext(
          projectedDatabase,
          receiptKey,
          changed,
        ))
          .toThrow("not bound to this receipt key");
      }
      expect(() => inspectPortableProviderContext(
        projectedDatabase,
        new Uint8Array(32).fill(8),
        proof,
      )).toThrow("not bound to this receipt key");
    } finally {
      projected?.close();
      database.close();
    }
  });

  test("rejects impossible attachment authority on a harness observer pane", () => {
    const database = fixtureDatabase();
    try {
      insertPane(database, {
        paneId: "pane_portable_harness001",
        displayOrder: 0,
        paletteIndex: 0,
        state: "ready",
      });
      database.query(`
        UPDATE chat_panes
        SET interaction_mode = 'harnessObserver'
        WHERE pane_id = 'pane_portable_harness001'
      `).run();
      insertProviderBinding(database, {
        bindingId: "attbinding_portable_harness001",
        paneId: "pane_portable_harness001",
        state: "active",
      });

      expect(() => projectFixture(database, {
        sourceDatabaseSha256: "7".repeat(64),
        attachmentVaultGenerationSha256: "8".repeat(64),
      })).toThrow("Only an ordinary chat pane");
      expect(database.query(`
        SELECT state FROM chat_provider_attachment_bindings
        WHERE binding_id = 'attbinding_portable_harness001'
      `).get()).toEqual({ state: "active" });
    } finally {
      database.close();
    }
  });

  test("authenticates and removes every archive-intent state for both purposes only from the copy", () => {
    const database = fixtureDatabase();
    let projected: Database | null = null;
    try {
      const states = [
        "prepared",
        "effect_started",
        "ambiguous",
        "succeeded",
        "account_contained",
      ] as const;
      const purposes = ["start_fresh", "pane_archive"] as const;
      let index = 0;
      for (const purpose of purposes) {
        for (const state of states) {
          const suffix = String(index + 1).padStart(2, "0");
          const paneId = `pane_portablearchive${suffix}`;
          insertPane(database, {
            paneId,
            displayOrder: index,
            paletteIndex: index,
            state: "ready",
          });
          insertProviderThreadArchiveIntent(database, { paneId, purpose, state });
          index += 1;
        }
      }
      const sourceRows = readProviderThreadArchiveIntentRows(database);
      const sourceSnapshot = Buffer.from(database.serialize());
      const expectedRemovedAuthoritySha256 = removedAuthorityDigest({
        providerThreadArchiveIntents: sourceRows,
      });

      const result = projectFixture(database, {
        sourceDatabaseSha256: "9".repeat(64),
        attachmentVaultGenerationSha256: "a".repeat(64),
      });
      const projectedDatabase = result.database;
      projected = projectedDatabase;

      expect(result.attestation).toMatchObject({
        version: 3,
        affectedPaneCount: 10,
        removedArchiveIntentCount: 10,
        removedAuthoritySha256: expectedRemovedAuthoritySha256,
      });
      expect(projectedDatabase.query(`
        SELECT COUNT(*) AS count FROM chat_provider_thread_archive_intents
      `).get()).toEqual({ count: 0 });
      expect(projectedDatabase.query(`
        SELECT COUNT(*) AS count FROM chat_panes
        WHERE provider_context_reset_required = 1
          AND provider_account_profile_id IS NULL
          AND provider_thread_id IS NULL
          AND provider_restart_thread_id IS NULL
          AND state = 'attention'
          AND message_queue_pause_reason = 'attention'
      `).get()).toEqual({ count: 10 });
      expect(readProviderThreadArchiveIntentRows(database)).toEqual(sourceRows);
      expect(Buffer.from(database.serialize())).toEqual(sourceSnapshot);
      expect(inspectPortableProviderContext(
        projectedDatabase,
        receiptKey,
        result.attestation,
      )).toEqual(result.attestation);
      insertProviderThreadArchiveIntent(projectedDatabase, {
        paneId: "pane_portablearchive01",
        purpose: "start_fresh",
        state: "prepared",
      });
      expect(() => inspectPortableProviderContext(
        projectedDatabase,
        receiptKey,
        result.attestation,
      )).toThrow("still contains resumable provider metadata");
    } finally {
      projected?.close();
      database.close();
    }
  });

  test("authenticates, transcripts, and removes every normalized v57 authority row", () => {
    const database = fixtureDatabase();
    let projected: Database | null = null;
    try {
      insertV57RemovalAuthority(database);
      const sourceRows = readV57AuthorityRows(database);
      const sourceSnapshot = Buffer.from(database.serialize());
      const expectedRemovedAuthoritySha256 = removedAuthorityDigest({
        providerThreadArchiveAuthorityV57: sourceRows,
      });

      const result = projectFixture(database, {
        sourceDatabaseSha256: "b".repeat(64),
        attachmentVaultGenerationSha256: "c".repeat(64),
      });
      projected = result.database;

      expect(result.attestation).toMatchObject({
        version: 3,
        affectedPaneCount: 3,
        removedArchiveIntentCount: 0,
        removedArchiveTargetCount: 2,
        removedArchiveAttemptCount: 3,
        removedArchiveCutCount: 1,
        removedArchiveCutMemberCount: 3,
        removedAuthoritySha256: expectedRemovedAuthoritySha256,
      });
      expect(readV57AuthorityRows(projected)).toEqual({
        targets: [],
        attempts: [],
        cuts: [],
        cutMembers: [],
      });
      expect(projected.query(`
        SELECT COUNT(*) AS count FROM chat_panes
        WHERE pane_id IN (
          'pane_portablev57target01',
          'pane_portablev57target02',
          'pane_portablev57sibling1'
        )
          AND provider_context_reset_required = 1
          AND provider_account_profile_id IS NULL
          AND provider_thread_id IS NULL
          AND provider_restart_thread_id IS NULL
          AND state = 'attention'
          AND message_queue_pause_reason = 'attention'
      `).get()).toEqual({ count: 3 });
      expect(inspectPortableProviderContext(
        projected,
        receiptKey,
        result.attestation,
      )).toEqual(result.attestation);
      expect(readV57AuthorityRows(database)).toEqual(sourceRows);
      expect(Buffer.from(database.serialize())).toEqual(sourceSnapshot);
    } finally {
      projected?.close();
      database.close();
    }
  });

  test("rejects a zero-member fence-started v57 cut without changing its source", () => {
    const database = fixtureDatabase();
    try {
      insertPane(database, {
        paneId: "pane_portablev57unsealed1",
        displayOrder: 0,
        paletteIndex: 0,
        state: "ready",
      });
      createV57RemovalCut(database, "archcut_portablev57unsealed1");
      const sourceSnapshot = Buffer.from(database.serialize());

      expect(() => projectFixture(database, {
        sourceDatabaseSha256: "3".repeat(64),
        attachmentVaultGenerationSha256: "4".repeat(64),
      })).toThrow("complete sealed inventory");
      expect(Buffer.from(database.serialize())).toEqual(sourceSnapshot);
      expect(database.query(`
        SELECT state FROM chat_provider_thread_archive_cuts_v57
        WHERE cut_id = 'archcut_portablev57unsealed1'
      `).get()).toEqual({ state: "fence_started" });
      expect(database.query(`
        SELECT provider_account_profile_id, provider_thread_id,
               provider_restart_thread_id, provider_context_reset_required
        FROM chat_panes WHERE pane_id = 'pane_portablev57unsealed1'
      `).get()).toEqual({
        provider_account_profile_id: "acct_portable_context0001",
        provider_thread_id: "thread_pane_portablev57unsealed1",
        provider_restart_thread_id: "restart_pane_portablev57unsealed1",
        provider_context_reset_required: 0,
      });
    } finally {
      database.close();
    }
  });

  test("rejects a partially enumerated fenced v57 cut without changing its source", () => {
    const database = fixtureDatabase();
    try {
      const recordedPaneId = "pane_portablev57partial01";
      const omittedPaneId = "pane_portablev57partial02";
      for (const [index, paneId] of [recordedPaneId, omittedPaneId].entries()) {
        insertPane(database, {
          paneId,
          displayOrder: index,
          paletteIndex: index,
          state: "ready",
        });
      }
      const cutId = "archcut_portablev57partial01";
      const journal = createV57RemovalCut(database, cutId);
      journal.bindAllAffectedTargets(cutId);
      journal.recordFence({
        cutId,
        successorGeneration: null,
        successorAccountProfileRevision: null,
        fenceEvidenceDigest: digest("partial-fence"),
        fenceRevisionDigest: digest("partial-fence-revision"),
        now,
      });
      journal.addCutMember(v57SiblingMember({
        cutId,
        memberId: "archmember_portablev57partial01",
        paneId: recordedPaneId,
      }));
      const sourceSnapshot = Buffer.from(database.serialize());

      expect(() => projectFixture(database, {
        sourceDatabaseSha256: "5".repeat(64),
        attachmentVaultGenerationSha256: "6".repeat(64),
      })).toThrow("complete sealed inventory");
      expect(Buffer.from(database.serialize())).toEqual(sourceSnapshot);
      expect(database.query(`
        SELECT state, member_count FROM chat_provider_thread_archive_cuts_v57
        WHERE cut_id = ?1
      `).get(cutId)).toEqual({ state: "fenced", member_count: null });
      expect(database.query(`
        SELECT provider_context_reset_required FROM chat_panes
        WHERE pane_id = ?1
      `).get(omittedPaneId)).toEqual({ provider_context_reset_required: 0 });
    } finally {
      database.close();
    }
  });

  test("projects a sealed v57 inventory while its complete members remain pending", () => {
    const database = fixtureDatabase();
    let projected: Database | null = null;
    try {
      const paneId = "pane_portablev57sealed001";
      const cutId = "archcut_portablev57sealed001";
      insertPane(database, {
        paneId,
        displayOrder: 0,
        paletteIndex: 0,
        state: "ready",
      });
      const journal = createV57RemovalCut(database, cutId);
      journal.bindAllAffectedTargets(cutId);
      journal.recordFence({
        cutId,
        successorGeneration: null,
        successorAccountProfileRevision: null,
        fenceEvidenceDigest: digest("sealed-fence"),
        fenceRevisionDigest: digest("sealed-fence-revision"),
        now,
      });
      const member = v57SiblingMember({
        cutId,
        memberId: "archmember_portablev57sealed001",
        paneId,
      });
      journal.addCutMember(member);
      journal.sealCutInventory({
        cutId,
        expectedMemberCount: 1,
        expectedInventoryDigest:
          providerThreadArchiveCompleteInventoryDigestV57([member]),
        enumerationAuthorityDigest: digest("sealed-enumeration-authority"),
        sealRevisionDigest: digest("sealed-inventory-revision"),
        now,
      });
      const sourceSnapshot = Buffer.from(database.serialize());

      const result = projectFixture(database, {
        sourceDatabaseSha256: "7".repeat(64),
        attachmentVaultGenerationSha256: "8".repeat(64),
      });
      projected = result.database;

      expect(result.attestation).toMatchObject({
        affectedPaneCount: 1,
        removedArchiveTargetCount: 0,
        removedArchiveAttemptCount: 0,
        removedArchiveCutCount: 1,
        removedArchiveCutMemberCount: 1,
      });
      expect(readV57AuthorityRows(projected)).toEqual({
        targets: [],
        attempts: [],
        cuts: [],
        cutMembers: [],
      });
      expect(projected.query(`
        SELECT state, provider_account_profile_id, provider_thread_id,
               provider_restart_thread_id, provider_context_reset_required,
               message_queue_pause_reason
        FROM chat_panes WHERE pane_id = ?1
      `).get(paneId)).toEqual({
        state: "attention",
        provider_account_profile_id: null,
        provider_thread_id: null,
        provider_restart_thread_id: null,
        provider_context_reset_required: 1,
        message_queue_pause_reason: "attention",
      });
      expect(Buffer.from(database.serialize())).toEqual(sourceSnapshot);
      expect(database.query(`
        SELECT state FROM chat_provider_thread_archive_cut_members_v57
        WHERE member_id = 'archmember_portablev57sealed001'
      `).get()).toEqual({ state: "pending" });
    } finally {
      projected?.close();
      database.close();
    }
  });

  test("fails closed on receipt tampering in every v57 relation without changing the source", () => {
    const database = fixtureDatabase();
    try {
      insertV57RemovalAuthority(database);
      const pristine = Buffer.from(database.serialize());
      const scenarios = [
        {
          trigger: "chat_provider_thread_archive_target_identity_immutable_v57",
          table: "chat_provider_thread_archive_targets_v57",
          idColumn: "target_id",
          id: "archtarget_portablev5701",
        },
        {
          trigger: "chat_provider_thread_archive_attempt_identity_immutable_v57",
          table: "chat_provider_thread_archive_attempts_v57",
          idColumn: "attempt_id",
          id: "archattempt_portablev5701",
        },
        {
          trigger: "chat_provider_thread_archive_cut_identity_immutable_v57",
          table: "chat_provider_thread_archive_cuts_v57",
          idColumn: "cut_id",
          id: "archcut_portablev5701",
        },
        {
          trigger: "chat_provider_thread_archive_member_identity_immutable_v57",
          table: "chat_provider_thread_archive_cut_members_v57",
          idColumn: "member_id",
          id: "archmember_portablev5701",
        },
      ] as const;
      for (const scenario of scenarios) {
        const cloneBytes = Buffer.from(pristine);
        cloneBytes[18] = 1;
        cloneBytes[19] = 1;
        const changed = Database.deserialize(cloneBytes, { strict: true });
        try {
          changed.exec(`DROP TRIGGER ${scenario.trigger}`);
          changed.query(`
            UPDATE ${scenario.table} SET identity_hmac = ?2
            WHERE ${scenario.idColumn} = ?1
          `).run(scenario.id, "f".repeat(64));
          const changedSnapshot = Buffer.from(changed.serialize());
          expect(() => projectFixture(changed, {
            sourceDatabaseSha256: "d".repeat(64),
            attachmentVaultGenerationSha256: "e".repeat(64),
          })).toThrow("receipt is invalid");
          expect(Buffer.from(changed.serialize())).toEqual(changedSnapshot);
        } finally {
          changed.close();
          cloneBytes.fill(0);
        }
      }
      expect(Buffer.from(database.serialize())).toEqual(pristine);
    } finally {
      database.close();
    }
  });

  test("rolls back copy-only v57 removal when an authority pane is not ordinary", () => {
    const database = fixtureDatabase();
    try {
      insertPane(database, {
        paneId: "pane_portablev57harness01",
        displayOrder: 0,
        paletteIndex: 0,
        state: "ready",
      });
      prepareV57Target(database, {
        targetId: "archtarget_portablev57harness01",
        attemptId: "archattempt_portablev57harness01",
        paneId: "pane_portablev57harness01",
        generation: 1,
        accountProfileRevision: 1,
      });
      database.query(`
        UPDATE chat_panes SET interaction_mode = 'harnessObserver'
        WHERE pane_id = 'pane_portablev57harness01'
      `).run();
      const sourceSnapshot = Buffer.from(database.serialize());

      expect(() => projectFixture(database, {
        sourceDatabaseSha256: "1".repeat(64),
        attachmentVaultGenerationSha256: "2".repeat(64),
      })).toThrow("Only an ordinary chat pane");
      expect(Buffer.from(database.serialize())).toEqual(sourceSnapshot);
      expect(readV57AuthorityRows(database)).toMatchObject({
        targets: [{ target_id: "archtarget_portablev57harness01" }],
        attempts: [{ attempt_id: "archattempt_portablev57harness01" }],
      });
    } finally {
      database.close();
    }
  });
});

function projectFixture(
  database: Database,
  input: Readonly<{
    sourceDatabaseSha256: string;
    attachmentVaultGenerationSha256: string;
  }>,
): Readonly<{
  database: Database;
  attestation: ReturnType<typeof projectPortableProviderContext>["attestation"];
}> {
  const sourceDatabaseBytes = database.serialize();
  sourceDatabaseBytes[18] = 1;
  sourceDatabaseBytes[19] = 1;
  try {
    const result = projectPortableProviderContext({
      sourceDatabaseBytes,
      operationReceiptKey: receiptKey,
      sourceDatabaseSha256: input.sourceDatabaseSha256,
      attachmentVaultGenerationSha256: input.attachmentVaultGenerationSha256,
      now,
    });
    let projected: Database | null = null;
    try {
      projected = Database.deserialize(result.databaseBytes, { strict: true });
      projected.exec("PRAGMA trusted_schema = OFF");
      projected.exec("PRAGMA foreign_keys = ON");
      return Object.freeze({
        database: projected,
        attestation: result.attestation,
      });
    } catch (error: unknown) {
      projected?.close();
      throw error;
    } finally {
      result.databaseBytes.fill(0);
    }
  } finally {
    sourceDatabaseBytes.fill(0);
  }
}

function readProviderThreadArchiveIntentRows(database: Database): readonly unknown[] {
  return database.query(`
    SELECT pane_id, purpose, state, pane_revision, queue_revision,
           account_profile_id, thread_id, restart_thread_id,
           binding_id, binding_key_digest, binding_revision,
           generation, generation_contained, generation_containment_receipt,
           effect_attempt, containment_receipt,
           response_generation, response_stream_position, ambiguity_receipt,
           reconciliation_disposition, reconciliation_receipt,
           created_at, updated_at
    FROM chat_provider_thread_archive_intents
    ORDER BY pane_id
  `).all();
}

function readV57AuthorityRows(database: Database): Readonly<{
  targets: readonly Record<string, unknown>[];
  attempts: readonly Record<string, unknown>[];
  cuts: readonly Record<string, unknown>[];
  cutMembers: readonly Record<string, unknown>[];
}> {
  return {
    targets: database.query(`
      SELECT * FROM chat_provider_thread_archive_targets_v57 ORDER BY target_id
    `).all() as Record<string, unknown>[],
    attempts: database.query(`
      SELECT * FROM chat_provider_thread_archive_attempts_v57 ORDER BY attempt_id
    `).all() as Record<string, unknown>[],
    cuts: database.query(`
      SELECT * FROM chat_provider_thread_archive_cuts_v57 ORDER BY cut_id
    `).all() as Record<string, unknown>[],
    cutMembers: database.query(`
      SELECT * FROM chat_provider_thread_archive_cut_members_v57 ORDER BY member_id
    `).all() as Record<string, unknown>[],
  };
}

function removedAuthorityDigest(input: Readonly<{
  providerThreadArchiveIntents?: readonly unknown[];
  providerThreadArchiveAuthorityV57?: ReturnType<typeof readV57AuthorityRows>;
}>): string {
  return createHash("sha256")
    .update("hra.control-plane.removed-provider-authority.v3\0", "utf8")
    .update(canonicalJson({
      bindings: [],
      leases: [],
      providerThreadArchiveIntents: input.providerThreadArchiveIntents ?? [],
      providerThreadArchiveAuthorityV57:
        input.providerThreadArchiveAuthorityV57 ?? {
          targets: [],
          attempts: [],
          cuts: [],
          cutMembers: [],
        },
    }), "utf8")
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
      throw new TypeError("Portable projection test value is not JSON");
  }
  throw new TypeError("Portable projection test value is not JSON");
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function prepareV57Target(
  database: Database,
  input: Readonly<{
    targetId: string;
    attemptId: string;
    paneId: string;
    generation: number;
    accountProfileRevision: number;
  }>,
): void {
  new ProviderThreadArchiveJournalV57(database, receiptKey).prepareTarget({
    targetId: input.targetId,
    paneId: input.paneId,
    purpose: "pane_archive",
    paneRevision: 1,
    queueRevision: null,
    paneCasDigest: digest(`pane:${input.paneId}`),
    queueCasDigest: null,
    accountProfileId: "acct_portable_context0001",
    accountProfileRevision: input.accountProfileRevision,
    threadId: `thread_${input.paneId}`,
    restartThreadId: `restart_${input.paneId}`,
    binding: { kind: "none" },
    attempt: {
      attemptId: input.attemptId,
      generation: input.generation,
      accountProfileRevision: input.accountProfileRevision,
      requestEvidenceDigest: digest(`request:${input.attemptId}`),
      requestRevisionDigest: digest(`request-revision:${input.attemptId}`),
    },
    now,
  });
}

function createV57RemovalCut(
  database: Database,
  cutId: string,
): ProviderThreadArchiveJournalV57 {
  const journal = new ProviderThreadArchiveJournalV57(database, receiptKey);
  journal.createCut({
    cutId,
    accountProfileId: "acct_portable_context0001",
    accountProfileRevision: 1,
    sourceGeneration: 1,
    cause: "account_removal",
    initiatingAttemptId: null,
    predecessorCutId: null,
    identityEvidenceDigest: digest(`cut:${cutId}`),
    identityRevisionDigest: digest(`cut-revision:${cutId}`),
    now,
  });
  return journal;
}

function v57SiblingMember(input: Readonly<{
  cutId: string;
  memberId: string;
  paneId: string;
}>) {
  return {
    memberId: input.memberId,
    cutId: input.cutId,
    paneId: input.paneId,
    paneRevision: 1,
    paneCasDigest: digest(`member-pane:${input.paneId}`),
    threadId: `thread_${input.paneId}`,
    restartThreadId: `restart_${input.paneId}`,
    role: "sibling" as const,
    targetId: null,
    attemptId: null,
    targetAttemptOrdinal: null,
    action: "detach_binding_only" as const,
    binding: { kind: "none" as const },
    identityEvidenceDigest: digest(`member:${input.memberId}`),
    identityRevisionDigest: digest(`member-revision:${input.memberId}`),
    now,
  };
}

function insertV57RemovalAuthority(database: Database): void {
  const panes = [
    "pane_portablev57target01",
    "pane_portablev57target02",
    "pane_portablev57sibling1",
  ] as const;
  for (const [index, paneId] of panes.entries()) {
    insertPane(database, {
      paneId,
      displayOrder: index,
      paletteIndex: index,
      state: "ready",
    });
  }
  const journal = new ProviderThreadArchiveJournalV57(database, receiptKey);
  prepareV57Target(database, {
    targetId: "archtarget_portablev5702",
    attemptId: "archattempt_portablev5702",
    paneId: panes[1],
    generation: 1,
    accountProfileRevision: 1,
  });
  journal.recordPreparedNotStarted({
    attemptId: "archattempt_portablev5702",
    outcomeEvidenceDigest: digest("target-2-not-started"),
    outcomeRevisionDigest: digest("target-2-not-started-revision"),
    now,
  });
  database.query(`
    UPDATE account_profiles SET process_generation = 2, revision = 2
    WHERE profile_id = 'acct_portable_context0001' AND revision = 1
  `).run();
  journal.appendSuccessorAttempt({
    targetId: "archtarget_portablev5702",
    attemptId: "archattempt_portablev5703",
    generation: 2,
    accountProfileRevision: 2,
    requestEvidenceDigest: digest("target-2-successor"),
    requestRevisionDigest: digest("target-2-successor-revision"),
    now,
  });

  prepareV57Target(database, {
    targetId: "archtarget_portablev5701",
    attemptId: "archattempt_portablev5701",
    paneId: panes[0],
    generation: 2,
    accountProfileRevision: 2,
  });
  journal.markEffectStarted({
    attemptId: "archattempt_portablev5701",
    effectEvidenceDigest: digest("target-1-effect"),
    effectRevisionDigest: digest("target-1-effect-revision"),
    now,
  });
  journal.recordDirectApplied({
    attemptId: "archattempt_portablev5701",
    responseGeneration: 2,
    responseStreamPosition: 4,
    outcomeEvidenceDigest: digest("target-1-outcome"),
    outcomeRevisionDigest: digest("target-1-outcome-revision"),
    now,
  });

  const cutId = "archcut_portablev5701";
  journal.createCut({
    cutId,
    accountProfileId: "acct_portable_context0001",
    accountProfileRevision: 2,
    sourceGeneration: 2,
    cause: "account_removal",
    initiatingAttemptId: null,
    predecessorCutId: null,
    identityEvidenceDigest: digest("removal-identity"),
    identityRevisionDigest: digest("removal-identity-revision"),
    now,
  });
  journal.bindAllAffectedTargets(cutId);
  journal.recordFence({
    cutId,
    successorGeneration: null,
    successorAccountProfileRevision: null,
    fenceEvidenceDigest: digest("removal-fence"),
    fenceRevisionDigest: digest("removal-fence-revision"),
    now,
  });
  const members = [
    {
      memberId: "archmember_portablev5701",
      paneId: panes[0],
      targetId: "archtarget_portablev5701",
      attemptId: "archattempt_portablev5701",
      targetAttemptOrdinal: 1,
      role: "target" as const,
      action: "preserved_target" as const,
    },
    {
      memberId: "archmember_portablev5702",
      paneId: panes[1],
      targetId: "archtarget_portablev5702",
      attemptId: "archattempt_portablev5703",
      targetAttemptOrdinal: 2,
      role: "target" as const,
      action: "contain_generation_context" as const,
    },
    {
      memberId: "archmember_portablev5703",
      paneId: panes[2],
      targetId: null,
      attemptId: null,
      targetAttemptOrdinal: null,
      role: "sibling" as const,
      action: "detach_binding_only" as const,
    },
  ] as const;
  const completeMembers = members.map((member) => ({
    ...member,
    cutId,
    paneRevision: 1,
    paneCasDigest: digest(`member-pane:${member.paneId}`),
    threadId: `thread_${member.paneId}`,
    restartThreadId: `restart_${member.paneId}`,
    binding: { kind: "none" as const },
    identityEvidenceDigest: digest(`member:${member.memberId}`),
    identityRevisionDigest: digest(`member-revision:${member.memberId}`),
    now,
  }));
  for (const member of completeMembers) journal.addCutMember(member);
  journal.sealCutInventory({
    cutId,
    expectedMemberCount: completeMembers.length,
    expectedInventoryDigest:
      providerThreadArchiveCompleteInventoryDigestV57(completeMembers),
    enumerationAuthorityDigest: digest("removal-enumeration-authority"),
    sealRevisionDigest: digest("removal-seal-revision"),
    now,
  });
  for (const member of completeMembers) {
    journal.settleMember({
      memberId: member.memberId,
      settlementEvidenceDigest: digest(`settlement:${member.memberId}`),
      settlementRevisionDigest: digest(`settlement-revision:${member.memberId}`),
      now,
    });
  }
  journal.markRemovalAwaitingTombstone({
    cutId,
    containmentEvidenceDigest: digest("removal-containment"),
    containmentRevisionDigest: digest("removal-containment-revision"),
    targets: [
      {
        targetId: "archtarget_portablev5701",
        containmentEvidenceDigest: digest("target-1-containment"),
        containmentRevisionDigest: digest("target-1-containment-revision"),
      },
      {
        targetId: "archtarget_portablev5702",
        containmentEvidenceDigest: digest("target-2-containment"),
        containmentRevisionDigest: digest("target-2-containment-revision"),
      },
    ],
    now,
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function insertProviderThreadArchiveIntent(
  database: Database,
  input: Readonly<{
    paneId: string;
    purpose: "start_fresh" | "pane_archive";
    state:
      | "prepared"
      | "effect_started"
      | "ambiguous"
      | "succeeded"
      | "account_contained";
  }>,
): void {
  const generation = 7;
  const generationContained = [
    "ambiguous",
    "succeeded",
    "account_contained",
  ].includes(input.state) ? 1 : 0;
  const reconciliationDisposition = input.state === "succeeded"
    ? "applied"
    : ["ambiguous", "account_contained"].includes(input.state)
    ? "not_applied"
    : null;
  database.query(`
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
      ?1, ?2, ?3, 1, ?4,
      'acct_portable_context0001', ?5, ?6,
      ?7, ?8, 3,
      ?9, ?10, ?11,
      ?12, ?13,
      ?14, ?15, ?16,
      ?17, ?18,
      ?19, ?19
    )
  `).run(
    input.paneId,
    input.purpose,
    input.state,
    input.purpose === "start_fresh" ? 1 : null,
    `thread_${input.paneId}`,
    `restart_${input.paneId}`,
    `binding_${input.paneId}`,
    "c".repeat(64),
    generation,
    generationContained,
    generationContained === 1 ? `generation_contained_${input.paneId}` : null,
    input.state === "prepared" ? 0 : 1,
    input.state === "succeeded" ? `archive_succeeded_${input.paneId}` : null,
    input.state === "succeeded" ? generation + 1 : null,
    input.state === "succeeded" ? 42 : null,
    input.state === "ambiguous" ? `archive_ambiguous_${input.paneId}` : null,
    reconciliationDisposition,
    reconciliationDisposition === null
      ? null
      : `reconciliation_${input.state}_${input.paneId}`,
    now.toISOString(),
  );
}

function fixtureDatabase(): Database {
  const root = mkdtempSync(join(tmpdir(), "hra-portable-context-"));
  temporaryRoots.push(root);
  const database = openControlPlane(join(root, "control-plane.sqlite"), {
    releaseIdentity: { version: "1.0.0", build: 1 },
    now: () => 1,
  });
  database.query(`
    INSERT INTO account_profiles (
      profile_id, label, auth_state, process_generation,
      selected, created_at, updated_at
    ) VALUES (
      'acct_portable_context0001', 'Portable context', 'signed_in', 1,
      1, ?1, ?1
    )
  `).run(now.toISOString());
  return database;
}

function downgradeScheduledChatSchemaToV61(database: Database): void {
  database.exec(`
    DROP TRIGGER chat_scheduled_chat_desired_off_pane_update_quarantine;
    DROP TRIGGER chat_scheduled_chat_desired_off_pane_delete_quarantine;
    DROP TABLE chat_scheduled_chat_desired_off;
    DELETE FROM schema_migrations WHERE version = 62;
    UPDATE app_release_state SET migration_version = 61;
  `);
}

function insertScheduledChatBinding(database: Database, paneId: string): string {
  const sessionId = `syncsession_${"s".repeat(32)}`;
  database.query(`
    INSERT INTO session_sync_grid_positions(
      session_id, grid_position, origin, discovered_at
    ) VALUES (?1, 0, 'local', ?2)
  `).run(sessionId, now.getTime());
  database.query(`
    INSERT INTO session_sync_pane_bindings(
      pane_id, session_id, tenant_id, organization_id, owner_user_id,
      vault_id, vault_generation, origin_device_id, included,
      binding_state, creation_grant_digest, reserved_at, created_at
    ) VALUES (
      ?1, ?2, ?3, ?4, ?5,
      ?6, '1', ?7, 1,
      'accepted', ?8, ?9, ?9
    )
  `).run(
    paneId,
    sessionId,
    `synctenant_${"t".repeat(32)}`,
    `syncorg_${"o".repeat(32)}`,
    `syncuser_${"u".repeat(32)}`,
    `syncvault_${"v".repeat(32)}`,
    `syncdevice_${"d".repeat(32)}`,
    `sha256_${"e".repeat(64)}`,
    now.getTime(),
  );
  return sessionId;
}

function insertScheduledChatActive(
  database: Database,
  paneId: string,
  sessionId: string,
): void {
  database.query(`
    INSERT INTO chat_scheduled_chats(
      pane_id, session_id, revision, generation, key_epoch,
      rrule, time_zone, next_run_at, definition_ciphertext_digest,
      created_at, updated_at
    ) VALUES (
      ?1, ?2, 1, '1', '1',
      ?3, 'America/Puerto_Rico', ?4, ?5,
      ?6, ?6
    )
  `).run(
    paneId,
    sessionId,
    "DTSTART;TZID=America/Puerto_Rico:20260820T090000\nRRULE:FREQ=DAILY;INTERVAL=1",
    now.getTime() + 60_000,
    `sha256_${"f".repeat(64)}`,
    now.getTime(),
  );
}

function insertScheduledChatMutation(
  database: Database,
  paneId: string,
  sessionId: string,
  state: "prepared" | "effect_started",
): void {
  database.query(`
    INSERT INTO chat_scheduled_chat_mutations(
      operation_id, pane_id, session_id, kind, state,
      expected_pane_revision, expected_schedule_revision,
      target_schedule_revision, target_generation, request_json,
      request_digest, rrule, time_zone, next_run_at,
      definition_ciphertext_digest, created_at, updated_at
    ) VALUES (
      ?1, ?2, ?3, 'put', ?4,
      1, NULL,
      1, '1', '{}',
      ?5, ?6, 'America/Puerto_Rico', ?7,
      ?8, ?9, ?9
    )
  `).run(
    `syncop_${state === "prepared" ? "p".repeat(32) : "e".repeat(32)}`,
    paneId,
    sessionId,
    state,
    `sha256_${"1".repeat(64)}`,
    "DTSTART;TZID=America/Puerto_Rico:20260820T090000\nRRULE:FREQ=DAILY;INTERVAL=1",
    now.getTime() + 60_000,
    `sha256_${"2".repeat(64)}`,
    now.getTime(),
  );
}

function insertPane(
  database: Database,
  input: Readonly<{
    paneId: string;
    displayOrder: number;
    paletteIndex: number;
    state: "ready" | "streaming";
  }>,
): void {
  const active = input.state === "streaming";
  database.query(`
    INSERT INTO chat_panes (
      pane_id, palette_index, display_order,
      repository_id, repository_name, revision, title,
      account_profile_id, model, reasoning_effort, service_tier,
      interaction_mode, state,
      provider_account_profile_id, provider_thread_id,
      provider_restart_thread_id, active_turn_id, active_provider_turn_id,
      active_prompt, turn_status, turn_started_at,
      workspace_mode, workspace_state, workspace_revision,
      workspace_recovery_reason, created_at, updated_at
    ) VALUES (
      ?1, ?2, ?3,
      ?4, 'Portable fixture', 1, 'Portable fixture',
      'acct_portable_context0001', 'gpt-5.6-sol', 'max', 'standard',
      'chat', ?5,
      'acct_portable_context0001', ?6, ?7, ?8, ?9,
      ?10, ?11, ?12,
      'managed_worktree', 'preparing', 1,
      NULL, ?13, ?13
    )
  `).run(
    input.paneId,
    input.paletteIndex,
    input.displayOrder,
    `repo_${String(input.displayOrder + 1).repeat(26)}`,
    input.state,
    `thread_${input.paneId}`,
    `restart_${input.paneId}`,
    active ? `chatturn_${"a".repeat(24)}` : null,
    active ? `provider_turn_${input.paneId}` : null,
    active ? "active attachment prompt" : null,
    active ? "streaming" : null,
    active ? now.toISOString() : null,
    now.toISOString(),
  );
}

function insertHistory(
  database: Database,
  paneId: string,
  rows: readonly (readonly [number, "user" | "assistant", string])[],
): void {
  for (const [sequence, role, text] of rows) {
    database.query(`
      INSERT INTO chat_pane_history (
        pane_id, sequence, role, text, utf8_bytes, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    `).run(
      paneId,
      sequence,
      role,
      text,
      new TextEncoder().encode(text).byteLength,
      now.toISOString(),
    );
  }
}

function insertProviderBinding(
  database: Database,
  input: Readonly<{
    bindingId: string;
    paneId: string;
    state: "active" | "ambiguous";
  }>,
): void {
  database.query(`
    INSERT INTO chat_provider_attachment_bindings (
      binding_id, binding_key_digest, pane_id, revision, state,
      ambiguity_receipt_digest, containment_receipt_digest,
      acquired_at, updated_at, released_at
    ) VALUES (
      ?1, ?2, ?3, 1, ?4,
      ?5, NULL, ?6, ?6, NULL
    )
  `).run(
    input.bindingId,
    "9".repeat(64),
    input.paneId,
    input.state,
    input.state === "ambiguous" ? "f".repeat(64) : null,
    now.toISOString(),
  );
}

function insertProviderAttachmentLease(
  database: Database,
  input: Readonly<{
    attachmentId: string;
    bindingId: string;
    paneId: string;
  }>,
): void {
  const bytes = Buffer.from("portable attachment", "utf8");
  database.query(`
    INSERT INTO chat_attachments (
      attachment_id, upload_id, pane_id, revision, state, kind,
      display_name, declared_media_type, effective_media_type,
      internal_suffix, expected_input_bytes, received_input_bytes,
      source_retained, next_chunk_ordinal, finalize_request_revision,
      requested_input_sha256, input_sha256,
      provider_bytes, provider_sha256, ready_at, created_at, updated_at
    ) VALUES (
      ?1, ?2, ?3, 4, 'ready', 'file',
      'portable.txt', 'text/plain', 'text/plain',
      'txt', ?4, ?4,
      0, 1, 4,
      ?5, ?5, ?4, ?5, ?6, ?6, ?6
    )
  `).run(
    input.attachmentId,
    `upload_${input.attachmentId.slice("attachment_".length)}`,
    input.paneId,
    bytes.byteLength,
    new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    now.toISOString(),
  );
  database.query(`
    INSERT INTO chat_provider_attachment_leases (
      binding_id, pane_id, attachment_id, acquired_at
    ) VALUES (?1, ?2, ?3, ?4)
  `).run(input.bindingId, input.paneId, input.attachmentId, now.toISOString());
}
