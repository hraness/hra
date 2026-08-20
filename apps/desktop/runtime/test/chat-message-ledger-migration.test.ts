import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { ChatPaneStore } from "../src/state/chat-pane-store";
import { migrations } from "../src/state/migrations";

const NOW = "2026-08-18T12:00:00.000Z";

test("message-ledger migrations backfill a pane and reopen with exact queue clocks", () => {
  const migration = migrations.find(({ version }) => version === 47);
  const resolutionMigration = migrations.find(({ version }) => version === 48);
  const idempotencyMigration = migrations.find(({ version }) => version === 51);
  const capabilityMigration = migrations.find(({ version }) => version === 52);
  const historyFloorMigration = migrations.find(({ version }) => version === 53);
  const contextResetMigration = migrations.find(({ version }) => version === 54);
  const providerLineageMigration = migrations.find(({ version }) => version === 55);
  const archiveIntentMigration = migrations.find(({ version }) => version === 56);
  if (migration === undefined) throw new Error("message ledger migration is missing");
  if (resolutionMigration === undefined) {
    throw new Error("ambiguous resolution migration is missing");
  }
  if (idempotencyMigration === undefined) {
    throw new Error("message idempotency migration is missing");
  }
  if (
    capabilityMigration === undefined || historyFloorMigration === undefined ||
    contextResetMigration === undefined || providerLineageMigration === undefined ||
    archiveIntentMigration === undefined
  ) throw new Error("live attachment routing migrations are missing");
  expect(migration.name).toBe("durable-app-owned-chat-message-ledger");
  expect(idempotencyMigration.name).toBe("immutable-chat-message-delivery-intent");
  expect(capabilityMigration.name).toBe("generation-fenced-root-input-capabilities");
  expect(historyFloorMigration.name).toBe("provider-history-handoff-floor");
  expect(contextResetMigration.name).toBe("provider-context-reset-required");
  expect(providerLineageMigration.name).toBe(
    "one-live-provider-attachment-lineage-per-pane",
  );
  expect(archiveIntentMigration.name).toBe(
    "durable-provider-thread-archive-intent",
  );
  expect(migrations.at(-1)?.version).toBe(62);

  const legacy = new Database(":memory:", { strict: true });
  legacy.exec("PRAGMA foreign_keys = ON");
  for (const candidate of migrations) {
    if (candidate.version >= 47) break;
    legacy.exec(candidate.sql);
  }
  legacy.query(`
    INSERT INTO account_profiles (
      profile_id, label, auth_state, process_generation,
      selected, created_at, updated_at
    ) VALUES ('acct_migrationledger1', 'Ledger', 'signed_in', 1, 1, ?1, ?1)
  `).run(NOW);
  legacy.query(`
    INSERT INTO chat_panes (
      pane_id, display_order, repository_id, repository_name, revision, title,
      account_profile_id, model, reasoning_effort, service_tier,
      interaction_mode, state,
      workspace_mode, workspace_state, workspace_revision,
      workspace_recovery_reason, created_at, updated_at
    ) VALUES (
      'pane_migrationledger1', 0, ?1, 'Migration repository', 7, 'Existing pane',
      'acct_migrationledger1', 'gpt-5.6-sol', 'max', 'standard',
      'chat', 'ready', 'managed_worktree', 'preparing', 3, NULL, ?2, ?2
    )
  `).run(`repo_${"8".repeat(26)}`, NOW);

  for (const candidate of migrations) {
    if (candidate.version < 47) continue;
    legacy.transaction(() => legacy.exec(candidate.sql))();
  }
  expect(legacy.query(`
    SELECT message_queue_revision, next_message_ordinal,
      message_queue_pause_reason
    FROM chat_panes WHERE pane_id = 'pane_migrationledger1'
  `).get()).toEqual({
    message_queue_revision: 1,
    next_message_ordinal: 1,
    message_queue_pause_reason: null,
  });
  expect(new ChatPaneStore(legacy).messageQueue("pane_migrationledger1"))
    .toEqual({
      revision: 1,
      pauseReason: null,
      blockedMessage: null,
      messages: [],
    });
  expect(legacy.query(`
    SELECT singleton, generation FROM chat_attachment_vault_state
  `).get()).toEqual({ singleton: 1, generation: 0 });

  const serialized = legacy.serialize();
  legacy.close();
  const reopened = Database.deserialize(serialized, { strict: true });
  reopened.exec("PRAGMA foreign_keys = ON");
  try {
    const store = new ChatPaneStore(reopened);
    const queue = store.enqueueMessage({
      paneId: "pane_migrationledger1",
      expectedQueueRevision: 1,
      messageId: "chatmsg_migrationledger1",
      content: { text: "survives reopen", attachmentRefs: [] },
      now: new Date(NOW),
    });
    expect(queue).toMatchObject({
      revision: 2,
      messages: [{ ordinal: 1, revision: 1, text: "survives reopen" }],
    });
    const messageRow = reopened.query<{
      request_delivery_kind: string;
      request_steer_turn_id: string | null;
      request_fingerprint_hmac: string;
      request_delivery_outcome: string;
    }, []>(`
      SELECT request_delivery_kind, request_steer_turn_id,
        request_fingerprint_hmac, request_delivery_outcome
      FROM chat_message_ledger WHERE message_id = 'chatmsg_migrationledger1'
    `).get();
    expect(messageRow).toMatchObject({
      request_delivery_kind: "queue",
      request_steer_turn_id: null,
      request_delivery_outcome: "accepted",
    });
    expect(messageRow?.request_fingerprint_hmac).toMatch(/^[a-f0-9]{64}$/u);
  } finally {
    reopened.close();
  }
});

test("migration 47 installs immutable identity, revision, and transition guards", () => {
  const database = new Database(":memory:", { strict: true });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (const migration of migrations) database.exec(migration.sql);
    database.query(`
      INSERT INTO account_profiles (
        profile_id, label, auth_state, process_generation,
        selected, created_at, updated_at
      ) VALUES ('acct_guardledger01', 'Ledger', 'signed_in', 1, 1, ?1, ?1)
    `).run(NOW);
    database.query(`
      INSERT INTO chat_panes (
        pane_id, palette_index, display_order, repository_id, repository_name, revision, title,
        account_profile_id, model, reasoning_effort, service_tier,
        interaction_mode, state,
        workspace_mode, workspace_state, workspace_revision,
        workspace_recovery_reason, created_at, updated_at
      ) VALUES (
        'pane_guardledger001', 0, 0, ?1, 'Guard repository', 1, 'Guard pane',
        'acct_guardledger01', 'gpt-5.6-sol', 'max', 'standard',
        'chat', 'ready', 'managed_worktree', 'preparing', 1, NULL, ?2, ?2
      )
    `).run(`repo_${"9".repeat(26)}`, NOW);
    const store = new ChatPaneStore(database);
    store.enqueueMessage({
      paneId: "pane_guardledger001",
      expectedQueueRevision: 1,
      messageId: "chatmsg_guardledger001",
      content: { text: "guard", attachmentRefs: [] },
      now: new Date(NOW),
    });
    expect(() => database.query(`
      UPDATE chat_message_ledger SET ordinal = 2, revision = 2
      WHERE message_id = 'chatmsg_guardledger001'
    `).run()).toThrow("immutable");
    expect(() => database.query(`
      UPDATE chat_message_ledger SET message_text = 'drift'
      WHERE message_id = 'chatmsg_guardledger001'
    `).run()).toThrow("revision");
    expect(() => database.query(`
      UPDATE chat_message_ledger SET
        state = 'completed', revision = 2, terminal_at = ?1
      WHERE message_id = 'chatmsg_guardledger001'
    `).run(NOW)).toThrow("transition");
    expect(() => database.query(`
      UPDATE chat_message_ledger SET request_fingerprint_hmac = ?1
      WHERE message_id = 'chatmsg_guardledger001'
    `).run("f".repeat(64))).toThrow("immutable");
  } finally {
    database.close();
  }
});

test("migration 55 permits only one live provider attachment lineage per pane", () => {
  const database = new Database(":memory:", { strict: true });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (const migration of migrations) database.exec(migration.sql);
    database.query(`
      INSERT INTO chat_panes (
        pane_id, palette_index, display_order, repository_id, repository_name,
        revision, title, model, reasoning_effort, service_tier,
        interaction_mode, state, workspace_mode, workspace_state,
        workspace_revision, workspace_recovery_reason, created_at, updated_at
      ) VALUES (
        'pane_lineageguard01', 0, 0, ?1, 'Lineage repository', 1,
        'Lineage pane', 'gpt-5.6-sol', 'max', 'standard', 'chat', 'ready',
        'managed_worktree', 'preparing', 1, NULL, ?2, ?2
      )
    `).run(`repo_${"a".repeat(26)}`, NOW);
    const insertBinding = database.query(`
      INSERT INTO chat_provider_attachment_bindings (
        binding_id, binding_key_digest, pane_id, revision, state,
        acquired_at, updated_at
      ) VALUES (?1, ?2, 'pane_lineageguard01', 1, 'active', ?3, ?3)
    `);
    insertBinding.run("attbinding_lineage001", "a".repeat(64), NOW);
    expect(() => insertBinding.run(
      "attbinding_lineage002",
      "b".repeat(64),
      NOW,
    )).toThrow();
    database.query(`
      UPDATE chat_provider_attachment_bindings
      SET state = 'released', revision = 2,
        containment_receipt_digest = ?2, released_at = ?3, updated_at = ?3
      WHERE binding_id = ?1
    `).run("attbinding_lineage001", "c".repeat(64), NOW);
    expect(() => insertBinding.run(
      "attbinding_lineage002",
      "b".repeat(64),
      NOW,
    )).not.toThrow();
  } finally {
    database.close();
  }
});
