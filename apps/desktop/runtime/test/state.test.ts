import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { RuntimeDomainCommand } from "../../contracts/runtime";
import { createHash } from "node:crypto";
import { linkSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hraReleaseIdentity } from "../release-identity";
import {
  applyMigrations,
  checkpointControlPlaneForApplicationSupportCutover,
  ControlPlaneIntegrityError,
  controlPlanePath,
  openControlPlane,
} from "../src/state/database";
import { migrations } from "../src/state/migrations";
import {
  loadOrCreateOperationReceiptKey,
  operationReceiptKeyCandidatePath,
  operationReceiptKeyPath,
} from "../src/state/operation-receipt-key";
import {
  fingerprintRuntimeCommand,
  OperationReceiptConflict,
  OperationReceiptStore,
} from "../src/state/operation-receipts";

const temporaryDirectories: string[] = [];
const receiptFingerprintKey = new Uint8Array(32).fill(0x42);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("control-plane database", () => {
  test("uses the frozen OPRTE Application Support root", () => {
    expect(controlPlanePath("/Users/oprte")).toBe(
      "/Users/oprte/Library/Application Support/OPRTE/control-plane.sqlite",
    );
  });

  test("applies immutable migrations exactly once", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      database.exec("PRAGMA foreign_keys = ON");
      applyMigrations(database);
      applyMigrations(database);
      const applied = database
        .query<{ version: number; name: string }, []>(
          "SELECT version, name FROM schema_migrations ORDER BY version",
        )
        .all();
      expect(applied).toEqual(migrations.map(({ version, name }) => ({ version, name })));
      const tables = database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map(({ name }) => name);
      expect(tables).toEqual([
        "account_profile_capacity_quarantine",
        "account_profiles",
        "app_release_state",
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
        "cloud_human_operation_receipts",
        "cloud_invalidation_heads",
        "compatibility_diagnostics",
        "dispatch_bindings",
        "dispatch_display_drafts",
        "dispatch_interaction_sync_state",
        "dispatch_interactions",
        "dispatch_outbox",
        "dispatch_runner_installation",
        "dispatch_runner_pending_heartbeats",
        "harness_actor_account_leases",
        "harness_actor_continuation_intents",
        "harness_actor_epochs",
        "harness_actor_fast_reservations",
        "harness_actor_incarnations",
        "harness_actor_model_reroute_inbox",
        "harness_actor_operations",
        "harness_actor_pane_bindings",
        "harness_actor_projection_witnesses",
        "harness_actor_results",
        "harness_actor_session_bindings",
        "harness_actor_turn_attempts",
        "harness_actor_turn_usage_inbox",
        "harness_actor_turns",
        "harness_actor_workspace_bindings",
        "harness_actors",
        "harness_context_snapshots",
        "harness_context_value_chunks",
        "harness_context_values",
        "harness_longitudinal_routing_analyses",
        "harness_longitudinal_routing_arm_stats",
        "harness_longitudinal_routing_observations",
        "harness_longitudinal_routing_pane_heads",
        "harness_longitudinal_routing_usage_current",
        "harness_program_admission_intents",
        "harness_program_operation_receipts",
        "harness_program_runs",
        "harness_proposals",
        "harness_root_turn_routing_receipts",
        "harness_semantic_evidence_bundles",
        "harness_settings",
        "human_account_metadata",
        "human_account_profiles",
        "human_custody_metadata",
        "human_custody_pointer_quarantine",
        "human_organization_operation_aliases",
        "human_organization_operations",
        "local_builtin_executors",
        "local_due_work",
        "local_fences",
        "local_installations",
        "local_operation_receipts",
        "local_promotion_activation_receipts",
        "local_promotion_cleanup_v2",
        "local_promotion_decision_proofs_v2",
        "local_promotion_family_digests",
        "local_promotion_family_progress_v2",
        "local_promotion_http_operations",
        "local_promotion_manifests",
        "local_promotion_manifests_v2",
        "local_promotion_outbound_batches_v2",
        "local_promotion_recovery_copies",
        "local_promotion_rejection_proofs_v2",
        "local_promotion_sessions",
        "local_promotion_sessions_v1",
        "local_promotion_snapshot_entities",
        "local_promotion_upload_receipts",
        "local_promotion_upload_receipts_v2",
        "local_queued_run_intents",
        "local_recovery_records",
        "local_renderer_mutation_attempts",
        "local_renderer_mutation_quarantines",
        "local_repositories",
        "local_run_display_drafts",
        "local_run_execution_bindings",
        "local_run_interactions",
        "local_run_public_events",
        "local_runner_pairing_pending",
        "local_runtime_boot_history",
        "local_runtime_boot_state",
        "local_task_bodies",
        "local_task_claims",
        "local_task_comments",
        "local_task_dependencies",
        "local_task_labels",
        "local_task_references",
        "local_task_reviews",
        "local_task_runs",
        "local_task_submissions",
        "local_tasks",
        "local_tombstones",
        "local_workspace_events",
        "local_workspace_repositories",
        "local_workspaces",
        "operation_receipts",
        "projects",
        "repository_bindings",
        "schema_migrations",
        "session_sync_attempted_envelopes",
        "session_sync_boot_state",
        "session_sync_clock_calibration",
        "session_sync_device_state",
        "session_sync_directory_cursor",
        "session_sync_dirty_panes",
        "session_sync_grid_positions",
        "session_sync_local_nonce_state",
        "session_sync_operation_journal",
        "session_sync_outbox_intents",
        "session_sync_pane_bindings",
        "session_sync_remote_entries",
        "session_sync_retired_pane_bindings",
        "session_sync_retry_state",
        "session_sync_session_heads",
        "session_sync_settings",
        "session_sync_signed_membership_epochs",
        "session_sync_snapshot_entries",
        "session_sync_vault_state",
        "thread_bindings",
        "workspace_leases",
      ]);
    } finally {
      database.close();
    }
  });

  test("rejects unknown or noncontiguous migration history before mutating state", () => {
    for (const version of [2, 999]) {
      const database = new Database(":memory:", { strict: true });
      try {
        database.exec(`
          CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            checksum TEXT NOT NULL,
            applied_at TEXT NOT NULL
          ) STRICT;
        `);
        database.query(`
          INSERT INTO schema_migrations (version, name, checksum, applied_at)
          VALUES (?1, 'foreign', ?2, '2026-07-21T12:00:00.000Z')
        `).run(version, "a".repeat(64));

        expect(() => applyMigrations(database)).toThrow("supported contiguous prefix");
        expect(database.query(`
          SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'account_profiles'
        `).get()).toBeNull();
      } finally {
        database.close();
      }
    }
  });

  test("creates user-only database storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "oprte-state-"));
    temporaryDirectories.push(root);
    const path = join(root, "private", "control-plane.sqlite");
    const database = openControlPlane(path, {
      releaseIdentity: hraReleaseIdentity,
    });
    try {
      expect(
        database.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get(),
      ).toEqual({ foreign_keys: 1 });
      expect(
        database.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get(),
      ).toEqual({ journal_mode: "wal" });
      expect(
        database.query<{ synchronous: number }, []>("PRAGMA synchronous").get(),
      ).toEqual({ synchronous: 2 });
      expect(
        database.query<{ trusted_schema: number }, []>(
          "PRAGMA trusted_schema",
        ).get(),
      ).toEqual({ trusted_schema: 0 });
    } finally {
      database.close();
    }
    expect((await stat(join(root, "private"))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("fails startup safely and actionably on a bounded foreign-key integrity violation", async () => {
    const root = await mkdtemp(join(tmpdir(), "oprte-state-integrity-"));
    temporaryDirectories.push(root);
    const path = join(root, "private", "control-plane.sqlite");
    const database = openControlPlane(path, {
      releaseIdentity: hraReleaseIdentity,
    });
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec(`
      CREATE TABLE integrity_parent (
        id INTEGER PRIMARY KEY
      ) STRICT;
      CREATE TABLE integrity_child (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER NOT NULL REFERENCES integrity_parent(id)
      ) STRICT;
      INSERT INTO integrity_child (id, parent_id) VALUES (1, 404);
    `);
    database.close();

    let failure: unknown;
    try {
      openControlPlane(path, { releaseIdentity: hraReleaseIdentity });
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ControlPlaneIntegrityError);
    expect(failure).toMatchObject({
      code: "integrity_check_failed",
      recovery: "restore_verified_backup",
    });
    if (!(failure instanceof Error)) throw new Error("Expected a safe integrity failure");
    expect(failure.message).toContain("restore a verified control-plane backup");
    expect(failure.message).not.toContain(path);
    expect(failure.message).not.toContain("integrity_child");
    expect(failure.message).not.toContain("404");
  });

  test("validates both DELETE-journal legacy databases and WAL cutovers", async () => {
    const root = await mkdtemp(join(tmpdir(), "oprte-cutover-checkpoint-"));
    temporaryDirectories.push(root);

    for (const journalMode of ["DELETE", "WAL"] as const) {
      const path = join(root, `${journalMode.toLowerCase()}.sqlite`);
      const database = new Database(path, { create: true, strict: true });
      try {
        database.exec(`PRAGMA journal_mode = ${journalMode}`);
        database.exec("CREATE TABLE fixture (value TEXT NOT NULL) STRICT");
        database.query("INSERT INTO fixture (value) VALUES (?1)").run(journalMode);

        expect(() =>
          checkpointControlPlaneForApplicationSupportCutover(database),
        ).not.toThrow();
        expect(
          database.query<{ value: string }, []>("SELECT value FROM fixture").get(),
        ).toEqual({ value: journalMode });
      } finally {
        database.close();
      }
    }
  });

  test("persists a separate user-only operation-receipt key and repairs its modes", async () => {
    const root = await mkdtemp(join(tmpdir(), "oprte-receipt-key-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "private", "control-plane.sqlite");
    const keyPath = operationReceiptKeyPath(databasePath);

    const first = loadOrCreateOperationReceiptKey(keyPath);
    expect(first).toHaveLength(32);
    expect((await stat(join(root, "private"))).mode & 0o777).toBe(0o700);
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600);

    await chmod(join(root, "private"), 0o755);
    await chmod(keyPath, 0o644);
    const second = loadOrCreateOperationReceiptKey(keyPath);
    expect(second).toEqual(first);
    expect((await stat(join(root, "private"))).mode & 0o777).toBe(0o700);
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
    expect(keyPath).not.toBe(databasePath);

    const candidatePath = operationReceiptKeyCandidatePath(keyPath);
    linkSync(keyPath, candidatePath);
    expect((await stat(candidatePath)).nlink).toBe(2);
    expect(loadOrCreateOperationReceiptKey(keyPath)).toEqual(first);
    expect(stat(candidatePath)).rejects.toMatchObject({ code: "ENOENT" });

    const beforeLinkParent = join(root, "before-link");
    const beforeLinkKeyPath = operationReceiptKeyPath(
      join(beforeLinkParent, "control-plane.sqlite"),
    );
    const beforeLinkCandidate =
      operationReceiptKeyCandidatePath(beforeLinkKeyPath);
    const abandonedKey = new Uint8Array(32).fill(0x44);
    await mkdir(beforeLinkParent, { mode: 0o700 });
    await writeFile(beforeLinkCandidate, abandonedKey, { mode: 0o600 });
    const recoveredKey = loadOrCreateOperationReceiptKey(beforeLinkKeyPath);
    expect(recoveredKey).not.toEqual(abandonedKey);
    expect(stat(beforeLinkCandidate)).rejects.toMatchObject({ code: "ENOENT" });

    const unsafeParent = join(root, "unsafe-candidate");
    const unsafeKeyPath = operationReceiptKeyPath(
      join(unsafeParent, "control-plane.sqlite"),
    );
    const unsafeCandidate = operationReceiptKeyCandidatePath(unsafeKeyPath);
    await mkdir(unsafeParent, { mode: 0o700 });
    await writeFile(unsafeCandidate, new Uint8Array(32), { mode: 0o644 });
    expect(() => loadOrCreateOperationReceiptKey(unsafeKeyPath)).toThrow(
      "candidate is unsafe",
    );
    expect((await stat(unsafeCandidate)).mode & 0o777).toBe(0o644);
  });

  test("deduplicates completed operations without storing their command payload", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      applyMigrations(database);
      const receipts = new OperationReceiptStore(database, receiptFingerprintKey);
      const createWorkAccount = { type: "account.create", label: "Work" } as const;
      expect(receipts.begin("op_12345678", createWorkAccount)).toEqual({ state: "new" });
      expect(receipts.begin("op_12345678", createWorkAccount)).toEqual({ state: "inFlight" });
      receipts.complete({
        version: 3,
        operationId: "op_12345678",
        ok: true,
        result: { type: "accepted" },
      });
      expect(receipts.begin("op_12345678", createWorkAccount)).toEqual({
        state: "recorded",
        response: {
          version: 3,
          operationId: "op_12345678",
          ok: true,
          result: { type: "accepted" },
        },
      });
      expect(() =>
        receipts.begin("op_12345678", { type: "account.create", label: "Personal" }),
      ).toThrow(OperationReceiptConflict);
      expect(() =>
        receipts.begin("op_12345678", {
          type: "account.logout",
          accountProfileId: "acct_12345678",
        }),
      ).toThrow(OperationReceiptConflict);
      const row = database
        .query<{ command_fingerprint: string; command_type: string; response_json: string }, []>(
          "SELECT command_type, command_fingerprint, response_json FROM operation_receipts",
        )
        .get();
      expect(row?.command_type).toBe("account.create");
      expect(row?.command_fingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(JSON.stringify(row)).not.toContain("Work");
      expect(row?.response_json).not.toContain("label");
    } finally {
      database.close();
    }
  });

  test("marks operations interrupted by a gateway restart as ambiguous", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      applyMigrations(database);
      const receipts = new OperationReceiptStore(database, receiptFingerprintKey);
      const command = {
        type: "account.refresh",
        accountProfileId: "acct_12345678",
      } as const;
      expect(receipts.begin("op_ambiguous1", command)).toEqual({ state: "new" });
      expect(receipts.recoverInterrupted(new Date("2026-07-19T12:00:00.000Z"))).toBe(1);
      expect(receipts.begin("op_ambiguous1", command)).toEqual({ state: "ambiguous" });
      expect(receipts.recoverInterrupted(new Date("2026-07-19T12:00:01.000Z"))).toBe(0);
    } finally {
      database.close();
    }
  });

  test("fingerprints canonical command content without depending on key order", () => {
    const left: RuntimeDomainCommand = {
      type: "account.login.start",
      accountProfileId: "acct_12345678",
      mode: "browser",
    };
    const right = {
      mode: "browser",
      accountProfileId: "acct_12345678",
      type: "account.login.start",
    } as const satisfies RuntimeDomainCommand;
    expect(fingerprintRuntimeCommand(left, receiptFingerprintKey)).toBe(
      fingerprintRuntimeCommand(right, receiptFingerprintKey),
    );
  });

  test("does not retain secret command content or an offline-testable command digest", () => {
    const database = new Database(":memory:", { strict: true });
    const secret = "correct horse battery staple";
    const command: RuntimeDomainCommand = {
      type: "account.create",
      label: secret,
    };
    try {
      applyMigrations(database);
      const receipts = new OperationReceiptStore(database, receiptFingerprintKey);
      expect(receipts.begin("op_secret123", command)).toEqual({ state: "new" });
      const row = database
        .query<{ command_fingerprint: string; response_json: string | null }, []>(
          "SELECT command_fingerprint, response_json FROM operation_receipts",
        )
        .get();
      const oldUnkeyedFingerprint = createHash("sha256")
        .update(JSON.stringify(command))
        .digest("hex");
      const guessedSecretDigest = createHash("sha256").update(secret).digest("hex");

      expect(JSON.stringify(row)).not.toContain(secret);
      expect(row?.command_fingerprint).not.toBe(oldUnkeyedFingerprint);
      expect(row?.command_fingerprint).not.toBe(guessedSecretDigest);
      expect(row?.command_fingerprint).not.toBe(
        fingerprintRuntimeCommand(command, new Uint8Array(32).fill(0x24)),
      );
    } finally {
      database.close();
    }
  });
});
