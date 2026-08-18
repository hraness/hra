import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { ChatPaneStore } from "../src/state/chat-pane-store";
import { migrations } from "../src/state/migrations";

const NOW = "2026-08-18T12:00:00.000Z";

test("message-ledger migrations backfill a pane and reopen with exact queue clocks", () => {
  const migration = migrations.find(({ version }) => version === 47);
  const resolutionMigration = migrations.find(({ version }) => version === 48);
  if (migration === undefined) throw new Error("message ledger migration is missing");
  if (resolutionMigration === undefined) {
    throw new Error("ambiguous resolution migration is missing");
  }
  expect(migration.name).toBe("durable-app-owned-chat-message-ledger");
  expect(migrations.at(-1)?.version).toBe(48);

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

  legacy.transaction(() => legacy.exec(migration.sql))();
  legacy.transaction(() => legacy.exec(resolutionMigration.sql))();
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
        pane_id, display_order, repository_id, repository_name, revision, title,
        account_profile_id, model, reasoning_effort, service_tier,
        interaction_mode, state,
        workspace_mode, workspace_state, workspace_revision,
        workspace_recovery_reason, created_at, updated_at
      ) VALUES (
        'pane_guardledger001', 0, ?1, 'Guard repository', 1, 'Guard pane',
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
  } finally {
    database.close();
  }
});
