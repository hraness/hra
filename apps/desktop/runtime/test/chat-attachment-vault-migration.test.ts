import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrations } from "../src/state/migrations";

const NOW = "2026-08-18T12:00:00.000Z";
const PANE = "pane_vaultmigration01";
const ATTACHMENT = "attachment_vaultmigrate01";
const MESSAGE = "chatmsg_vaultmigrate01";
const TURN = "chatturn_vaultmigrate01";

test("migration 50 preserves image custody while adding generic-file authority", () => {
  const migration = migrations.find(({ version }) => version === 50);
  if (migration === undefined) throw new Error("attachment vault migration is missing");
  expect(migration.name).toBe("private-durable-chat-attachment-vault");

  const database = new Database(":memory:", { strict: true });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (const candidate of migrations) {
      if (candidate.version >= 50) break;
      database.exec(candidate.sql);
    }
    insertPane(database);
    const digest = "a".repeat(64);
    database.query(`
      INSERT INTO chat_attachments (
        attachment_id, upload_id, pane_id, revision, state,
        expected_input_bytes, received_input_bytes, next_chunk_ordinal,
        input_sha256, source_media_type, width, height, pixel_count,
        canonical_bytes, canonical_sha256, preview_bytes, preview_sha256,
        ready_at, created_at, updated_at
      ) VALUES (
        ?1, 'upload_vaultmigrate01', ?2, 7, 'ready',
        100, 100, 1, ?3, 'image/png', 10, 8, 80,
        90, ?3, 50, ?3, ?4, ?4, ?4
      )
    `).run(ATTACHMENT, PANE, digest, NOW);
    database.query(`
      INSERT INTO chat_message_ledger (
        message_id, pane_id, ordinal, revision, message_text,
        message_utf8_bytes, state, claimed_turn_id,
        effect_started_at, acknowledged_at, terminal_at,
        created_at, updated_at
      ) VALUES (
        ?1, ?2, 1, 1, 'image', 5, 'start_claimed', ?3,
        NULL, NULL, NULL, ?4, ?4
      )
    `).run(MESSAGE, PANE, TURN, NOW);
    database.query(`
      INSERT INTO chat_message_attachment_refs (
        message_id, pane_id, position, attachment_id,
        consumed_draft_expires_at
      ) VALUES (?1, ?2, 0, ?3, ?4)
    `).run(MESSAGE, PANE, ATTACHMENT, NOW);
    database.query(`
      INSERT INTO chat_attachment_turn_leases (
        attachment_id, pane_id, message_id, turn_id, state,
        acquired_at, updated_at, released_at
      ) VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?5, NULL)
    `).run(ATTACHMENT, PANE, MESSAGE, TURN, NOW);

    database.transaction(() => database.exec(migration.sql))();
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.query(`
      SELECT kind, display_name, declared_media_type, effective_media_type,
        internal_suffix, provider_bytes, provider_sha256,
        preview_width, preview_height, source_retained, deletion_reason
      FROM chat_attachments WHERE attachment_id = ?1
    `).get(ATTACHMENT)).toEqual({
      kind: "image",
      display_name: "image.png",
      declared_media_type: "image/png",
      effective_media_type: "image/png",
      internal_suffix: "png",
      provider_bytes: 90,
      provider_sha256: digest,
      preview_width: 10,
      preview_height: 8,
      source_retained: 0,
      deletion_reason: null,
    });
    expect(database.query(`
      SELECT state FROM chat_attachment_turn_leases
      WHERE attachment_id = ?1 AND message_id = ?2 AND turn_id = ?3
    `).get(ATTACHMENT, MESSAGE, TURN)).toEqual({ state: "active" });

    database.query(`
      INSERT INTO chat_attachments (
        attachment_id, upload_id, pane_id, revision, state, kind,
        display_name, declared_media_type, effective_media_type,
        internal_suffix, expected_input_bytes, received_input_bytes,
        source_retained,
        next_chunk_ordinal, finalize_request_revision,
        requested_input_sha256, input_sha256,
        provider_bytes, provider_sha256, ready_at, created_at, updated_at
      ) VALUES (
        'attachment_vaultgeneric02', 'upload_vaultgeneric02', ?1,
        3, 'ready', 'file', 'notes.txt', 'text/plain', 'text/plain',
        'txt', 4, 4, 0, 1, 2, ?2, ?2, 4, ?2, ?3, ?3, ?3
      )
    `).run(PANE, digest, NOW);
    expect(database.query(`
      SELECT kind, preview_sha256 FROM chat_attachments
      WHERE attachment_id = 'attachment_vaultgeneric02'
    `).get()).toEqual({ kind: "file", preview_sha256: null });
    expect(() => database.query(`
      UPDATE chat_attachments
      SET deletion_reason = 'gc', revision = revision + 1
      WHERE attachment_id = 'attachment_vaultgeneric02'
    `).run()).toThrow();

    const serialized = database.serialize();
    const reopened = Database.deserialize(serialized, { strict: true });
    try {
      reopened.exec("PRAGMA foreign_keys = ON");
      expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(reopened.query(`
        SELECT COUNT(*) AS count FROM chat_provider_attachment_bindings
      `).get()).toEqual({ count: 0 });
      expect(reopened.query(`
        SELECT COUNT(*) AS count FROM chat_attachment_upload_chunks
      `).get()).toEqual({ count: 0 });
    } finally {
      reopened.close();
    }
  } finally {
    database.close();
  }
});

function insertPane(database: Database): void {
  database.query(`
    INSERT INTO account_profiles (
      profile_id, label, auth_state, process_generation,
      selected, created_at, updated_at
    ) VALUES ('acct_vaultmigration1', 'Vault', 'signed_in', 1, 1, ?1, ?1)
  `).run(NOW);
  const hasPalette = database.query<{ count: number }, []>(`
    SELECT COUNT(*) AS count FROM pragma_table_info('chat_panes')
    WHERE name = 'palette_index'
  `).get()?.count === 1;
  database.query(`
    INSERT INTO chat_panes (
      pane_id, ${hasPalette ? "palette_index," : ""}
      display_order, repository_id, repository_name, revision, title,
      account_profile_id, model, reasoning_effort, service_tier,
      interaction_mode, state,
      workspace_mode, workspace_state, workspace_revision,
      workspace_recovery_reason, created_at, updated_at
    ) VALUES (
      ?1, ${hasPalette ? "0," : ""}
      0, ?2, 'Vault migration', 1, 'Vault migration',
      'acct_vaultmigration1', 'gpt-5.6-sol', 'max', 'standard',
      'chat', 'ready', 'managed_worktree', 'preparing', 1,
      NULL, ?3, ?3
    )
  `).run(PANE, `repo_${"b".repeat(26)}`, NOW);
}
