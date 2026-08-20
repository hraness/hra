import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GenerationalSecretCustody,
  HRA_HUMAN_KEYCHAIN_SERVICE,
  HRA_RUNNER_KEYCHAIN_SERVICE,
  SecretStoreAccessDeniedError,
  type SecretStore,
} from "@hraness/hra-human-client";
import { hraReleaseIdentity } from "../release-identity";

import {
  applyMigrations,
  openControlPlane,
  validateAppliedMigrationPrefix,
} from "../src/state/database";
import { migrations } from "../src/state/migrations";
import { HumanAccountMetadataStore } from
  "../src/state/human-account-metadata-store";
import { currentControlPlaneMigrationVersion } from "../src/state/release-compatibility";

const temporaryDirectories: string[] = [];

function migrationChecksum(migration: (typeof migrations)[number]): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${String(migration.version)}\n${migration.name}\n${migration.sql}`);
  return hasher.digest("hex");
}

function applyMigrationPrefix(database: Database, throughVersion: number): void {
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT
  `);
  applyMigrationRange(database, 0, throughVersion);
}

function applyMigrationRange(
  database: Database,
  afterVersion: number,
  throughVersion: number,
): void {
  for (const migration of migrations) {
    if (migration.version <= afterVersion) continue;
    if (migration.version > throughVersion) break;
    database.transaction(() => {
      database.exec(migration.sql);
      database.query(`
        INSERT INTO schema_migrations (version, name, checksum, applied_at)
        VALUES (?1, ?2, ?3, '2026-08-03T12:00:00.000Z')
      `).run(migration.version, migration.name, migrationChecksum(migration));
    })();
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) =>
      await rm(path, { recursive: true, force: true })),
  );
});

describe("local task SQLite migrations", () => {
  test("migration 37 preserves populated v36 custody before atomic recovery and restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oprte-migration-37-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "control-plane.sqlite");
    const descriptor = {
      service: HRA_HUMAN_KEYCHAIN_SERVICE,
      name: "primary",
    } as const;
    const committedSlot = "legacy_committed_0001";
    const pendingSlot = "fresh_pending_000002";
    const humanJournal = {
      version: 1,
      revision: 7,
      latestGeneration: 2,
      service: descriptor.service,
      name: descriptor.name,
      committed: { generation: 1, slot: committedSlot },
      pending: {
        pointer: { generation: 2, slot: pendingSlot },
        replacesGeneration: 1,
      },
    } as const;
    const runnerJournal = {
      version: 1,
      revision: 4,
      latestGeneration: 4,
      service: HRA_RUNNER_KEYCHAIN_SERVICE,
      name: "runner_workspace_primary",
      committed: { generation: 4, slot: "runner_committed_0004" },
    } as const;
    const accountMetadata = {
      version: 1,
      revision: 3,
      credentialGeneration: 1,
      profile: {
        version: 1,
        apiUrl: "https://oprte.example.test",
        secretStore: "keychain",
        user: {
          id: "user_migration37",
          email: "migration@example.test",
          name: "Migration",
        },
      },
    } as const;

    let database = new Database(path, { create: true, strict: true });
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrationPrefix(database, 36);
    database.query(`
      INSERT INTO human_custody_metadata(
        service, name, revision, latest_generation, journal_json, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6), (?7, ?8, ?9, ?10, ?11, ?12)
    `).run(
      humanJournal.service,
      humanJournal.name,
      humanJournal.revision,
      humanJournal.latestGeneration,
      JSON.stringify(humanJournal),
      1_800_000_000_001,
      runnerJournal.service,
      runnerJournal.name,
      runnerJournal.revision,
      runnerJournal.latestGeneration,
      JSON.stringify(runnerJournal),
      1_800_000_000_002,
    );
    database.query(`
      INSERT INTO human_account_metadata(
        singleton, revision, credential_generation, metadata_json, updated_at
      ) VALUES (1, ?1, ?2, ?3, ?4)
    `).run(
      accountMetadata.revision,
      accountMetadata.credentialGeneration,
      JSON.stringify(accountMetadata),
      1_800_000_000_003,
    );
    const custodyBefore = database.query(`
      SELECT service, name, revision, latest_generation, journal_json, updated_at
      FROM human_custody_metadata ORDER BY service, name
    `).all();
    const accountBefore = database.query(`
      SELECT singleton, revision, credential_generation, metadata_json, updated_at
      FROM human_account_metadata
    `).all();

    expect(validateAppliedMigrationPrefix(database)).toBe(36);
    applyMigrations(database);
    expect(validateAppliedMigrationPrefix(database)).toBe(currentControlPlaneMigrationVersion);
    expect(database.query(`
      SELECT service, name, revision, latest_generation, journal_json, updated_at
      FROM human_custody_metadata ORDER BY service, name
    `).all()).toEqual(custodyBefore);
    expect(database.query(`
      SELECT singleton, revision, credential_generation, metadata_json, updated_at
      FROM human_account_metadata
    `).all()).toEqual(accountBefore);
    expect(database.query(`
      SELECT count(*) AS count FROM human_custody_pointer_quarantine
    `).get()).toEqual({ count: 0 });

    const pendingEnvelope = JSON.stringify({
      version: 1,
      generation: 2,
      value: "fresh credential stays outside SQLite",
    });
    let deleteAttempts = 0;
    const secrets: SecretStore = {
      get: ({ name }) => name.endsWith(committedSlot)
        ? Promise.reject(new SecretStoreAccessDeniedError())
        : Promise.resolve(name.endsWith(pendingSlot) ? pendingEnvelope : null),
      set: () => Promise.reject(new Error("migration recovery must not write")),
      delete: () => {
        deleteAttempts += 1;
        return Promise.reject(new Error("migration recovery must not delete"));
      },
    };
    const custody = new GenerationalSecretCustody({
      descriptor,
      metadata: new HumanAccountMetadataStore({
        database,
        now: () => 1_800_000_000_004,
      }),
      secrets,
      nextSlot: () => "unused_migration_003",
    });
    expect(await custody.quarantineLegacyIdentityPointers()).toEqual({
      state: "quarantined",
      quarantinedPointerCount: 1,
    });
    expect(deleteAttempts).toBe(0);
    database.close();

    database = new Database(path, { strict: true });
    database.exec("PRAGMA foreign_keys = ON");
    const restartedStore = new HumanAccountMetadataStore({ database });
    expect(await restartedStore.read(descriptor)).toEqual({
      version: 1,
      revision: 8,
      latestGeneration: 2,
      service: descriptor.service,
      name: descriptor.name,
      committed: { generation: 2, slot: pendingSlot },
    });
    const restarted = new GenerationalSecretCustody({
      descriptor,
      metadata: restartedStore,
      secrets,
      nextSlot: () => "unused_migration_004",
    });
    expect(await restarted.read()).toEqual({
      generation: 2,
      value: "fresh credential stays outside SQLite",
    });
    const evidence = database.query(`
      SELECT pointer_kind, generation, slot, source_revision, reason
      FROM human_custody_pointer_quarantine
    `).all();
    expect(evidence).toEqual([{
      pointer_kind: "committed",
      generation: 1,
      slot: committedSlot,
      source_revision: 7,
      reason: "legacy_identity_access_denied",
    }]);
    expect(JSON.stringify(evidence)).not.toContain("fresh credential");
    expect(() => database.query(`
      DELETE FROM human_custody_pointer_quarantine
    `).run()).toThrow("custody quarantine evidence is immutable");
    expect(database.query(`
      SELECT journal_json FROM human_custody_metadata
      WHERE service = ?1 AND name = ?2
    `).get(descriptor.service, descriptor.name)).not.toEqual(null);
    database.close();
  });

  test("appends immutable local authority through durable recursive actors", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      database.exec("PRAGMA foreign_keys = ON");
      applyMigrations(database);
      expect(validateAppliedMigrationPrefix(database)).toBe(currentControlPlaneMigrationVersion);
      expect(migrations.filter(({ version }) => version >= 12)
        .map(({ version, name }) => ({ version, name })))
        .toEqual([
          { version: 12, name: "local-task-replay-and-recovery" },
          { version: 13, name: "local-promotion-snapshots-and-receipts" },
          { version: 14, name: "durable-local-task-execution" },
          { version: 15, name: "local-promotion-v2-and-human-custody" },
          { version: 16, name: "local-promotion-rejection-proofs" },
          { version: 17, name: "dispatch-runner-pending-heartbeats" },
          { version: 18, name: "app-release-compatibility" },
          { version: 19, name: "human-organization-operation-aliases" },
          { version: 20, name: "local-due-work-generations" },
          { version: 21, name: "local-renderer-mutation-attempts" },
          {
            version: 22,
            name: "local-renderer-mutation-command-bindings",
          },
          {
            version: 23,
            name: "dispatch-managed-workspace-provenance",
          },
          {
            version: 24,
            name: "durable-chat-panes",
          },
          {
            version: 25,
            name: "chat-pane-agent-signals",
          },
          {
            version: 26,
            name: "replay-harness-authority",
          },
          {
            version: 27,
            name: "recursive-actor-workspaces",
          },
          {
            version: 28,
            name: "recursive-program-admission-intents",
          },
          {
            version: 29,
            name: "program-admission-recovery-evidence",
          },
          {
            version: 30,
            name: "isolated-chat-pane-workspaces",
          },
          {
            version: 31,
            name: "encrypted-multi-device-session-observation",
          },
          {
            version: 32,
            name: "session-sync-crash-journal-and-reservation-rebind",
          },
          {
            version: 33,
            name: "session-sync-storage-boundaries",
          },
          {
            version: 34,
            name: "session-sync-human-scope-authority",
          },
          {
            version: 35,
            name: "account-profile-capacity-recovery",
          },
          {
            version: 36,
            name: "harness-actor-reconciliation-target-indexes",
          },
          {
            version: 37,
            name: "legacy-keychain-identity-quarantine",
          },
          {
            version: 38,
            name: "remove-chat-audio-cues",
          },
          {
            version: 39,
            name: "durable-chat-pane-order",
          },
          {
            version: 40,
            name: "automatic-chat-account-routing",
          },
          {
            version: 41,
            name: "chat-service-tier",
          },
          {
            version: 42,
            name: "tokenmaxxing-metaharness-policy-evidence",
          },
          {
            version: 43,
            name: "terminalize-provider-quota-without-history-replay",
          },
          {
            version: 44,
            name: "longitudinal-routing-shadow-memory",
          },
          {
            version: 45,
            name: "durable-root-turn-routing-receipts",
          },
          {
            version: 46,
            name: "actor-turn-requested-service-tier-authority",
          },
          {
            version: 47,
            name: "durable-app-owned-chat-message-ledger",
          },
          {
            version: 48,
            name: "explicit-ambiguous-chat-message-resolution",
          },
          {
            version: 49,
            name: "verified-reasoning-provider-subagents-and-pane-palette",
          },
          {
            version: 50,
            name: "private-durable-chat-attachment-vault",
          },
          {
            version: 51,
            name: "immutable-chat-message-delivery-intent",
          },
          {
            version: 52,
            name: "generation-fenced-root-input-capabilities",
          },
          {
            version: 53,
            name: "provider-history-handoff-floor",
          },
          {
            version: 54,
            name: "provider-context-reset-required",
          },
          {
            version: 55,
            name: "one-live-provider-attachment-lineage-per-pane",
          },
          {
            version: 56,
            name: "durable-provider-thread-archive-intent",
          },
          {
            version: 57,
            name: "keyed-provider-thread-archive-containment-journal",
          },
          {
            version: 58,
            name: "global-chat-execution-settings",
          },
          {
            version: 59,
            name: "scheduled-chat-cloud-authority",
          },
          {
            version: 60,
            name: "scheduled-chat-proven-quota-retry",
          },
          {
            version: 61,
            name: "session-sync-durable-human-origin",
          },
          {
            version: 62,
            name: "scheduled-chat-durable-off-intent",
          },
        ]);
      const names = new Set(
        database.query<{ name: string }, []>(`
          SELECT name FROM sqlite_schema
          WHERE type = 'table'
        `).all().map(({ name }) => name),
      );
      for (const required of [
        "account_profile_capacity_quarantine",
        "human_custody_pointer_quarantine",
        "cloud_invalidation_heads",
        "chat_assistant_item_receipts",
        "chat_attachment_deletion_receipts",
        "chat_attachment_draft_leases",
        "chat_attachment_pane_archive_intents",
        "chat_attachment_privacy_deletion_intents",
        "chat_attachment_privacy_tombstones",
        "chat_attachment_storage_quarantines",
        "chat_attachment_turn_leases",
        "chat_attachment_upload_chunks",
        "chat_attachment_vault_state",
        "chat_attachments",
        "chat_execution_settings",
        "chat_message_ambiguous_resolutions",
        "chat_message_attachment_refs",
        "chat_message_ledger",
        "chat_pane_history",
        "chat_pane_palette_sequence",
        "chat_pane_workspace_bindings",
        "chat_panes",
        "chat_provider_attachment_bindings",
        "chat_provider_attachment_leases",
        "chat_provider_thread_archive_attempts_v57",
        "chat_provider_thread_archive_cut_members_v57",
        "chat_provider_thread_archive_cuts_v57",
        "chat_provider_thread_archive_intents",
        "chat_provider_thread_archive_targets_v57",
        "chat_reasoning_item_receipts",
        "chat_scheduled_chat_desired_off",
        "chat_scheduled_chat_generation_high_water",
        "chat_scheduled_chat_mutations",
        "chat_scheduled_chat_runs",
        "chat_scheduled_chats",
        "chat_turn_receipts",
        "harness_actor_account_leases",
        "harness_longitudinal_routing_analyses",
        "harness_longitudinal_routing_arm_stats",
        "harness_longitudinal_routing_observations",
        "harness_longitudinal_routing_pane_heads",
        "harness_longitudinal_routing_usage_current",
        "harness_root_turn_routing_receipts",
        "harness_actor_epochs",
        "harness_actor_fast_reservations",
        "harness_actor_incarnations",
        "harness_actor_model_reroute_inbox",
        "harness_actor_operations",
        "harness_actor_pane_bindings",
        "harness_actor_results",
        "harness_actor_turn_attempts",
        "harness_actor_turns",
        "harness_actor_workspace_bindings",
        "harness_actors",
        "harness_context_snapshots",
        "harness_context_value_chunks",
        "harness_context_values",
        "harness_program_operation_receipts",
        "harness_program_admission_intents",
        "harness_program_runs",
        "harness_proposals",
        "harness_settings",
        "human_organization_operations",
        "human_organization_operation_aliases",
        "local_workspaces",
        "local_tasks",
        "local_task_dependencies",
        "local_workspace_events",
        "local_operation_receipts",
        "local_renderer_mutation_attempts",
        "local_renderer_mutation_quarantines",
        "local_due_work",
        "local_queued_run_intents",
        "local_runtime_boot_state",
        "session_sync_device_state",
        "session_sync_outbox_intents",
        "session_sync_operation_journal",
        "session_sync_pane_bindings",
        "session_sync_retired_pane_bindings",
        "session_sync_remote_entries",
        "session_sync_settings",
        "session_sync_vault_state",
        "local_fences",
        "local_promotion_sessions",
        "local_promotion_manifests",
        "local_promotion_upload_receipts",
        "local_promotion_activation_receipts",
        "local_promotion_manifests_v2",
        "local_promotion_snapshot_entities",
        "local_promotion_family_progress_v2",
        "local_promotion_outbound_batches_v2",
        "local_promotion_http_operations",
        "local_promotion_upload_receipts_v2",
        "local_promotion_decision_proofs_v2",
        "local_promotion_rejection_proofs_v2",
        "local_promotion_cleanup_v2",
        "local_promotion_recovery_copies",
        "local_runner_pairing_pending",
        "local_run_execution_bindings",
        "local_run_display_drafts",
        "dispatch_runner_pending_heartbeats",
        "app_release_state",
      ]) {
        expect(names.has(required)).toBeTrue();
      }
    } finally {
      database.close();
    }
  });

  test("migration 32 transactionally classifies legacy bindings and recovers an interrupted attempt", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      database.exec("PRAGMA foreign_keys = ON");
      applyMigrationPrefix(database, 31);
      for (const [paneId, sessionId] of [
        ["pane_sync_pending01", `syncsession_${"p".repeat(32)}`],
        ["pane_sync_accepted1", `syncsession_${"a".repeat(32)}`],
      ] as const) {
        database.query(`
          INSERT INTO chat_panes(
            pane_id, repository_id, repository_name, revision, title,
            reasoning_effort, state, agent_index, created_at, updated_at
          ) VALUES (?1, 'repo_sync_migration', 'Example', 1, ?1,
            'ultra', 'ready', ?2, '2026-08-08T00:00:00.000Z',
            '2026-08-08T00:00:00.000Z')
        `).run(paneId, paneId === "pane_sync_accepted1" ? 1 : 2);
        database.query(`
          INSERT INTO session_sync_grid_positions(
            session_id, grid_position, origin, discovered_at
          ) VALUES (?1, ?2, 'local', 1)
        `).run(sessionId, paneId === "pane_sync_accepted1" ? 1 : 0);
        database.query(`
          INSERT INTO session_sync_pane_bindings(
            pane_id, session_id, tenant_id, organization_id, owner_user_id,
            vault_id, vault_generation, origin_device_id, included, created_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '1', ?7, 1, 1)
        `).run(
          paneId,
          sessionId,
          `synctenant_${"t".repeat(32)}`,
          `syncorg_${"o".repeat(32)}`,
          `syncuser_${"u".repeat(32)}`,
          `syncvault_${"v".repeat(32)}`,
          `syncdevice_${"d".repeat(32)}`,
        );
      }
      database.query(`
        INSERT INTO session_sync_session_heads(
          session_id, directory_ordinal, mirror_epoch, writer_generation,
          boot_id, boot_generation, membership_epoch, key_epoch,
          acknowledged_sequence, acknowledged_digest,
          acknowledged_source_revision, sync_state, nonce_state_json,
          updated_at
        ) VALUES (?1, '1', '1', '1', ?2, '1', '1', '1', '1', ?3,
          1, 'idle', '{}', 2)
      `).run(
        `syncsession_${"a".repeat(32)}`,
        `syncboot_${"b".repeat(32)}`,
        `sha256_${"c".repeat(64)}`,
      );
      const migration = migrations.find(({ version }) => version === 32);
      if (migration === undefined) throw new Error("migration 32 is missing");
      expect(() => database.transaction(() => {
        database.exec(migration.sql);
        throw new Error("injected migration interruption");
      })()).toThrow("injected migration interruption");
      expect(database.query(`
        SELECT name FROM pragma_table_info('session_sync_pane_bindings')
        WHERE name = 'binding_state'
      `).get()).toBeNull();

      applyMigrations(database);
      expect(database.query(`
        SELECT pane_id, binding_state FROM session_sync_pane_bindings
        ORDER BY pane_id
      `).all()).toEqual([
        { pane_id: "pane_sync_accepted1", binding_state: "accepted" },
        { pane_id: "pane_sync_pending01", binding_state: "pending" },
      ]);
      const schemaNames = database.query<{ name: string; type: string }, []>(`
        SELECT name, type FROM sqlite_schema
        WHERE name IN (
          'session_sync_operation_journal',
          'session_sync_retired_pane_bindings',
          'session_sync_binding_state_monotonic',
          'session_sync_creation_grant_immutable',
          'session_sync_one_global_control_operation_idx'
        ) ORDER BY name
      `).all();
      expect(schemaNames).toEqual([
        { name: "session_sync_binding_state_monotonic", type: "trigger" },
        { name: "session_sync_creation_grant_immutable", type: "trigger" },
        { name: "session_sync_one_global_control_operation_idx", type: "index" },
        { name: "session_sync_operation_journal", type: "table" },
        { name: "session_sync_retired_pane_bindings", type: "table" },
      ]);
    } finally {
      database.close();
    }
  });

  test("migrations 38 through 41 remove audio state, order panes, clear routing pins, and default service tiers", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      database.exec("PRAGMA foreign_keys = ON");
      applyMigrationPrefix(database, 37);
      database.query(`
        INSERT INTO account_profiles (
          profile_id, label, auth_state, process_generation, created_at, updated_at
        ) VALUES (
          'acct_legacy_routing_0001', 'Legacy subscription', 'signedIn', 0,
          '2026-08-03T12:00:00.000Z', '2026-08-03T12:00:00.000Z'
        )
      `).run();
      const insert = database.query(`
        INSERT INTO chat_panes (
          pane_id, agent_index, repository_id, repository_name, revision, title,
          account_profile_id, reasoning_effort, state, created_at, updated_at
        ) VALUES (
          ?1, ?2, 'repo_00000000000000000000000000', 'Example', 1, ?3,
          'acct_legacy_routing_0001', 'ultra', 'ready', ?4, ?4
        )
      `);
      insert.run("pane_order03", 1, "Third", "2026-08-03T12:00:01.000Z");
      insert.run("pane_order02", 2, "Second", "2026-08-03T12:00:00.000Z");
      insert.run("pane_order01", 3, "First", "2026-08-03T12:00:00.000Z");
      insert.run("pane_order04", 4, "Active", "2026-08-03T12:00:02.000Z");
      insert.run("pane_order05", 5, "Recovering", "2026-08-03T12:00:03.000Z");
      database.query(`
        UPDATE chat_panes SET
          provider_account_profile_id = 'acct_legacy_routing_0001',
          provider_thread_id = 'thread_existing',
          provider_restart_thread_id = 'thread_existing'
        WHERE pane_id = 'pane_order01'
      `).run();
      database.query(`
        UPDATE chat_panes SET interaction_mode = 'harnessObserver'
        WHERE pane_id = 'pane_order03'
      `).run();
      database.query(`
        UPDATE chat_panes SET
          state = 'starting',
          active_turn_id = 'chatturn_migration_active_01',
          active_prompt = 'Keep this reservation',
          turn_status = 'starting',
          turn_started_at = '2026-08-03T12:00:04.000Z',
          visited_account_ids_json = '["acct_legacy_routing_0001"]'
        WHERE pane_id = 'pane_order04'
      `).run();
      database.query(`
        UPDATE chat_panes SET
          state = 'attention',
          active_turn_id = 'chatturn_migration_recovery_01',
          turn_status = 'failed',
          turn_started_at = '2026-08-03T12:00:05.000Z',
          turn_completed_at = '2026-08-03T12:00:06.000Z',
          active_turn_poisoned = 1,
          attention_code = 'runtime_unavailable',
          attention_message = 'Interrupted fixture',
          attention_retryable = 1,
          visited_account_ids_json = '["acct_legacy_routing_0001"]'
        WHERE pane_id = 'pane_order05'
      `).run();

      applyMigrationRange(database, 37, 41);

      expect(database.query(`
        SELECT pane_id, service_tier FROM chat_panes ORDER BY pane_id
      `).all()).toEqual([
        { pane_id: "pane_order01", service_tier: "standard" },
        { pane_id: "pane_order02", service_tier: "standard" },
        { pane_id: "pane_order03", service_tier: "standard" },
        { pane_id: "pane_order04", service_tier: "standard" },
        { pane_id: "pane_order05", service_tier: "standard" },
      ]);

      expect(database.query(`
        SELECT pane_id, display_order, account_profile_id
        FROM chat_panes ORDER BY display_order
      `).all()).toEqual([
        {
          pane_id: "pane_order01",
          display_order: 0,
          account_profile_id: "acct_legacy_routing_0001",
        },
        { pane_id: "pane_order02", display_order: 1, account_profile_id: null },
        {
          pane_id: "pane_order03",
          display_order: 2,
          account_profile_id: "acct_legacy_routing_0001",
        },
        {
          pane_id: "pane_order04",
          display_order: 3,
          account_profile_id: "acct_legacy_routing_0001",
        },
        {
          pane_id: "pane_order05",
          display_order: 4,
          account_profile_id: "acct_legacy_routing_0001",
        },
      ]);
      const columns = new Set(
        database.query<{ name: string }, []>("PRAGMA table_info(chat_panes)")
          .all()
          .map(({ name }) => name),
      );
      expect(columns.has("agent_index")).toBeFalse();
      expect(columns.has("activity_tool_tone")).toBeFalse();
      expect(columns.has("tool_start_count")).toBeFalse();
      expect(columns.has("display_order")).toBeTrue();
      expect(() => database.query(`
        UPDATE chat_panes SET display_order = 0
        WHERE pane_id = 'pane_order03'
      `).run()).toThrow();
    } finally {
      database.close();
    }
  });

  test("migration 35 quarantines only legacy overflow while preserving every profile byte", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      database.exec("PRAGMA foreign_keys = ON");
      applyMigrationPrefix(database, 34);
      const insert = database.query(`
        INSERT INTO account_profiles (
          profile_id, label, identity_label, auth_state, process_generation,
          created_at, updated_at, revision, selected, removed_at,
          local_data_deleted_at
        ) VALUES (?1, ?2, NULL, 'signedOut', 0, ?3, ?3, 1, ?4, ?5, NULL)
      `);
      for (let index = 0; index < 80; index += 1) {
        const timestamp = new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString();
        insert.run(
          `acct_legacy_capacity_${String(index).padStart(3, "0")}`,
          `Legacy ${index}`,
          timestamp,
          index === 69 ? 1 : 0,
          index < 70 ? null : timestamp,
        );
      }

      applyMigrations(database);

      expect(database.query(`
        SELECT COUNT(*) AS count FROM account_profiles
      `).get()).toEqual({ count: 80 });
      expect(database.query(`
        SELECT COUNT(*) AS count FROM account_profile_capacity_quarantine
      `).get()).toEqual({ count: 16 });
      expect(database.query(`
        SELECT
          SUM(CASE WHEN removed_at IS NULL THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN removed_at IS NOT NULL THEN 1 ELSE 0 END) AS retained
        FROM runtime_visible_account_profiles
      `).get()).toEqual({ active: 64, retained: 0 });
      expect(database.query(`
        SELECT profile_id FROM runtime_visible_account_profiles WHERE selected = 1
      `).get()).toEqual({ profile_id: "acct_legacy_capacity_069" });
      expect(database.query(`
        SELECT COUNT(*) AS count FROM account_profiles
        WHERE local_data_deleted_at IS NOT NULL
      `).get()).toEqual({ count: 0 });
      expect(database.query(`
        SELECT COUNT(*) AS count FROM account_profile_capacity_quarantine
        WHERE reason = 'legacy_capacity_overflow'
          AND evidence_revision = 1
      `).get()).toEqual({ count: 16 });

      applyMigrations(database);
      expect(database.query(`
        SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 35
      `).get()).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  test("migration 33 erases foreign retry text and closes the SQLite diagnostic boundary", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      database.exec("PRAGMA foreign_keys = ON");
      applyMigrationPrefix(database, 32);
      database.query(`
        INSERT INTO session_sync_retry_state(
          worker, attempt, not_before, error_code, generation, updated_at
        ) VALUES ('observer', 0, 1, ?1, 0, 1)
      `).run("provider failed at /Users/private-person/token-secret");

      applyMigrations(database);
      expect(database.query(`
        SELECT error_code FROM session_sync_retry_state
        WHERE worker = 'observer'
      `).get()).toEqual({ error_code: "LOCAL_UNKNOWN" });
      expect(() => database.query(`
        UPDATE session_sync_retry_state SET error_code = ?1
        WHERE worker = 'observer'
      `).run("secret-bearing foreign error")).toThrow();
      database.query(`
        UPDATE session_sync_retry_state SET error_code = 'RATE_LIMITED'
        WHERE worker = 'observer'
      `).run();
    } finally {
      database.close();
    }
  });

  test("reopens at the same head and rejects a persisted checksum drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "oprte-local-migrations-"));
    temporaryDirectories.push(root);
    const path = join(root, "control-plane.sqlite");
    const first = openControlPlane(path, {
      releaseIdentity: hraReleaseIdentity,
    });
    first.close();

    const reopened = openControlPlane(path, {
      releaseIdentity: hraReleaseIdentity,
    });
    expect(validateAppliedMigrationPrefix(reopened)).toBe(currentControlPlaneMigrationVersion);
    reopened.query(`
      UPDATE schema_migrations SET checksum = ?2 WHERE version = ?1
    `).run(24, "0".repeat(64));
    reopened.close();

    expect(() =>
      openControlPlane(path, { releaseIdentity: hraReleaseIdentity }),
    ).toThrow("checksum drift");
  });

  test("increments chat workspace revision exactly for material projection changes", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      database.exec("PRAGMA foreign_keys = ON");
      applyMigrations(database);
      database.query(`
        INSERT INTO chat_panes (
          pane_id, palette_index, repository_id, repository_name, revision, title,
          reasoning_effort, state, display_order, created_at, updated_at
        ) VALUES (
          'pane_workspace_revision',
          (SELECT next_palette_index FROM chat_pane_palette_sequence WHERE singleton = 1),
          'repo_workspace_revision', 'Example', 1,
          'Workspace revision', 'ultra', 'ready', 0,
          '2026-08-03T12:00:00.000Z', '2026-08-03T12:00:00.000Z'
        )
      `).run();

      expect(() => database.query(`
        UPDATE chat_panes
        SET workspace_mode = 'managed_worktree',
          workspace_state = 'preparing',
          workspace_recovery_reason = NULL
        WHERE pane_id = 'pane_workspace_revision'
      `).run()).toThrow("invalid chat workspace projection transition");
      expect(() => database.query(`
        UPDATE chat_panes
        SET workspace_revision = workspace_revision + 1
        WHERE pane_id = 'pane_workspace_revision'
      `).run()).toThrow("invalid chat workspace projection transition");

      expect(database.query(`
        UPDATE chat_panes
        SET workspace_mode = 'managed_worktree',
          workspace_state = 'preparing',
          workspace_recovery_reason = NULL,
          workspace_revision = workspace_revision + 1
        WHERE pane_id = 'pane_workspace_revision'
      `).run().changes).toBe(1);
      expect(database.query(`
        SELECT workspace_mode, workspace_state, workspace_revision,
          workspace_recovery_reason
        FROM chat_panes WHERE pane_id = 'pane_workspace_revision'
      `).get()).toEqual({
        workspace_mode: "managed_worktree",
        workspace_recovery_reason: null,
        workspace_revision: 2,
        workspace_state: "preparing",
      });
    } finally {
      database.close();
    }
  });

  test("upgrades a populated migration 23 database through durable chat panes exactly once", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      database.exec("PRAGMA foreign_keys = ON");
      applyMigrationPrefix(database, 23);
      database.query(`
        INSERT INTO account_profiles (
          profile_id, label, identity_label, auth_state, process_generation,
          created_at, updated_at
        ) VALUES (
          'account_upgrade_fixture', 'Existing subscription', NULL, 'signedOut', 0,
          '2026-08-03T12:00:00.000Z', '2026-08-03T12:00:00.000Z'
        )
      `).run();

      applyMigrations(database);
      expect(validateAppliedMigrationPrefix(database)).toBe(currentControlPlaneMigrationVersion);
      expect(database.query(`
        SELECT profile_id, label, auth_state FROM account_profiles
        WHERE profile_id = 'account_upgrade_fixture'
      `).get()).toEqual({
        auth_state: "signedOut",
        label: "Existing subscription",
        profile_id: "account_upgrade_fixture",
      });
      const durableChatMigration = migrations.find(({ version }) => version === 24);
      if (durableChatMigration === undefined) throw new Error("chat migration is missing");
      expect(database.query(`
        SELECT version, name, checksum FROM schema_migrations WHERE version = 24
      `).get()).toEqual({
        checksum: migrationChecksum(durableChatMigration),
        name: "durable-chat-panes",
        version: 24,
      });
      expect(database.query<{ name: string }, []>(`
        SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name LIKE 'chat_%'
        ORDER BY name
      `).all().map(({ name }) => name)).toEqual([
        "chat_assistant_item_receipts",
        "chat_attachment_deletion_receipts",
        "chat_attachment_draft_leases",
        "chat_attachment_pane_archive_intents",
        "chat_attachment_privacy_deletion_intents",
        "chat_attachment_privacy_tombstones",
        "chat_attachment_storage_quarantines",
        "chat_attachment_turn_leases",
        "chat_attachment_upload_chunks",
        "chat_attachment_vault_state",
        "chat_attachments",
        "chat_execution_settings",
        "chat_message_ambiguous_resolutions",
        "chat_message_attachment_refs",
        "chat_message_ledger",
        "chat_pane_history",
        "chat_pane_palette_sequence",
        "chat_pane_workspace_bindings",
        "chat_panes",
        "chat_provider_attachment_bindings",
        "chat_provider_attachment_leases",
        "chat_provider_thread_archive_attempts_v57",
        "chat_provider_thread_archive_cut_members_v57",
        "chat_provider_thread_archive_cuts_v57",
        "chat_provider_thread_archive_intents",
        "chat_provider_thread_archive_targets_v57",
        "chat_reasoning_item_receipts",
        "chat_scheduled_chat_desired_off",
        "chat_scheduled_chat_generation_high_water",
        "chat_scheduled_chat_mutations",
        "chat_scheduled_chat_runs",
        "chat_scheduled_chats",
        "chat_turn_receipts",
      ]);

      applyMigrations(database);
      expect(database.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 24
      `).get()).toEqual({ count: 1 });
      expect(database.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM account_profiles
        WHERE profile_id = 'account_upgrade_fixture'
      `).get()).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  test("migration 25 deterministically backfills unique stable agent slots", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      database.exec("PRAGMA foreign_keys = ON");
      applyMigrationPrefix(database, 24);
      const insert = database.query(`
        INSERT INTO chat_panes (
          pane_id, repository_id, repository_name, revision, title,
          reasoning_effort, state, created_at, updated_at
        ) VALUES (?1, 'repo_00000000000000000000000000', 'Example', 1, ?2,
          'ultra', 'ready', ?3, ?3)
      `);
      insert.run("pane_backfill03", "Third", "2026-08-03T12:00:01.000Z");
      insert.run("pane_backfill02", "Second", "2026-08-03T12:00:00.000Z");
      insert.run("pane_backfill01", "First", "2026-08-03T12:00:00.000Z");

      applyMigrationRange(database, 24, 25);
      expect(database.query(`
        SELECT pane_id, agent_index, activity_ordinal, activity_kind,
          activity_tool_tone, tool_start_count
        FROM chat_panes ORDER BY agent_index
      `).all()).toEqual([
        {
          pane_id: "pane_backfill01",
          agent_index: 1,
          activity_ordinal: 0,
          activity_kind: "idle",
          activity_tool_tone: null,
          tool_start_count: 0,
        },
        {
          pane_id: "pane_backfill02",
          agent_index: 2,
          activity_ordinal: 0,
          activity_kind: "idle",
          activity_tool_tone: null,
          tool_start_count: 0,
        },
        {
          pane_id: "pane_backfill03",
          agent_index: 3,
          activity_ordinal: 0,
          activity_kind: "idle",
          activity_tool_tone: null,
          tool_start_count: 0,
        },
      ]);
      expect(() => database.query(`
        UPDATE chat_panes SET agent_index = 1 WHERE pane_id = 'pane_backfill03'
      `).run()).toThrow();
      expect(() => database.query(`
        UPDATE chat_panes SET agent_index = 4 WHERE pane_id = 'pane_backfill03'
      `).run()).toThrow();
      expect(() => database.query(`
        UPDATE chat_panes SET activity_kind = 'toolStarted'
        WHERE pane_id = 'pane_backfill01'
      `).run()).toThrow();

      expect(database.query(`
        UPDATE chat_panes
        SET agent_index = agent_index,
          activity_ordinal = activity_ordinal,
          activity_kind = activity_kind,
          activity_tool_tone = activity_tool_tone
        WHERE pane_id = 'pane_backfill01'
      `).run().changes).toBe(1);
      expect(database.query(`
        UPDATE chat_panes
        SET activity_ordinal = activity_ordinal + 1,
          activity_kind = 'messageSent',
          activity_tool_tone = NULL
        WHERE pane_id = 'pane_backfill01'
      `).run().changes).toBe(1);
      expect(() => database.query(`
        UPDATE chat_panes
        SET activity_ordinal = 0,
          activity_kind = 'idle',
          activity_tool_tone = NULL
        WHERE pane_id = 'pane_backfill01'
      `).run()).toThrow();
      expect(() => database.query(`
        UPDATE chat_panes
        SET activity_ordinal = 3,
          activity_kind = 'responseCompleted',
          activity_tool_tone = NULL
        WHERE pane_id = 'pane_backfill01'
      `).run()).toThrow();
      expect(database.query(`
        SELECT agent_index, activity_ordinal, activity_kind, activity_tool_tone
        FROM chat_panes WHERE pane_id = 'pane_backfill01'
      `).get()).toEqual({
        agent_index: 1,
        activity_ordinal: 1,
        activity_kind: "messageSent",
        activity_tool_tone: null,
      });
    } finally {
      database.close();
    }
  });

  test("enforces graph, authority, and receipt constraints after reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "oprte-local-constraints-"));
    temporaryDirectories.push(root);
    const path = join(root, "control-plane.sqlite");
    const first = openControlPlane(path, {
      releaseIdentity: hraReleaseIdentity,
    });
    first.query(`
      INSERT INTO local_installations (installation_id, created_at, updated_at)
      VALUES ('install_local_test', 1, 1)
    `).run();
    first.query(`
      INSERT INTO local_workspaces (
        workspace_id, name, slug, key_prefix, authority_kind,
        owner_installation_id, created_at, updated_at
      ) VALUES (
        'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'Local', 'local', 'LOC', 'local',
        'install_local_test', 1, 1
      )
    `).run();
    first.close();

    const reopened = openControlPlane(path, {
      releaseIdentity: hraReleaseIdentity,
    });
    try {
      expect(() => reopened.query(`
        UPDATE local_workspaces
        SET authority_kind = 'promoting'
        WHERE workspace_id = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV'
      `).run()).toThrow();
      expect(() => reopened.query(`
        INSERT INTO local_operation_receipts (
          operation_id, workspace_id, command_kind, command_digest,
          receipt_json, recorded_at
        ) VALUES ('op_bad', 'missing', 'task.create', 'sha256_bad', '{}', 1)
      `).run()).toThrow();
      expect(() => reopened.query(`
        INSERT INTO local_renderer_mutation_attempts (
          attempt_id, workspace_id, command_kind, keyed_fingerprint, state,
          revision, prepared_at
        ) VALUES (
          'op_invalid_kind',
          'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          'interaction.settle',
          ?1,
          'prepared',
          1,
          1
        )
      `).run(`sha256_${"a".repeat(64)}`)).toThrow();
      expect(() => reopened.query(`
        INSERT INTO local_renderer_mutation_attempts (
          attempt_id, workspace_id, command_kind, keyed_fingerprint, state,
          revision, prepared_at, effect_started_at
        ) VALUES (
          'op_invalid_state',
          'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          'task.update',
          ?1,
          'effect_started',
          1,
          1,
          1
        )
      `).run(`sha256_${"b".repeat(64)}`)).toThrow();
    } finally {
      reopened.close();
    }
  });
});
