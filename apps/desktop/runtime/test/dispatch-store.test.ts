import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  MAX_RUN_DISPLAY_EVENTS,
  MAX_RUN_DISPLAY_TEXT_UTF8_BYTES,
  MAX_RUN_REASONING_SUMMARY_EVENTS,
  appendRunEventsRequestSchema,
} from "@hraness/agent-tasks-protocol";
import {
  DispatchReservationConflict,
  DispatchStore,
  DispatchTransitionConflict,
  WorkspaceLaneIdentityConflict,
} from "../src/state/dispatch-store";
import { applyMigrations } from "../src/state/database";
import { migrations } from "../src/state/migrations";

function dispatchDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.query(`
    INSERT INTO projects (
      project_id, canonical_repository_path, canonical_git_common_dir,
      display_name, created_at, updated_at
    ) VALUES ('project_primary', '/fixture/repo', '/fixture/repo/.git',
      'Fixture', '2026-07-20T12:00:00.000Z', '2026-07-20T12:00:00.000Z')
  `).run();
  return database;
}

const reservation = {
  runId: "run_primary0001",
  taskId: "task_primary0001",
  taskKey: "OPS-7K2M4Q9",
  claimId: "claim_primary001",
  claimFence: 7,
  inputReviewRevision: 3,
  runtimePublicId: "runtime_primary1",
  runtimeBootId: "boot_primary0001",
  repositoryPublicId: "repo_primary0001",
} as const;

function applyMigrationPrefix(database: Database, throughVersion: number): void {
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT
  `);
  for (const migration of migrations) {
    if (migration.version > throughVersion) break;
    database.transaction(() => {
      database.exec(migration.sql);
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(`${String(migration.version)}\n${migration.name}\n${migration.sql}`);
      database.query(`
        INSERT INTO schema_migrations (version, name, checksum, applied_at)
        VALUES (?1, ?2, ?3, '2026-07-20T12:00:00.000Z')
      `).run(migration.version, migration.name, hasher.digest("hex"));
    })();
  }
}

describe("durable dispatch store", () => {
  test("persists one exact workspace lane identity without rebinding its base", () => {
    const database = dispatchDatabase();
    try {
      const store = new DispatchStore(database);
      const identity = {
        runId: reservation.runId,
        laneId: reservation.runId,
        canonicalRepositoryPath: "/fixture/repo",
        canonicalGitCommonDir: "/fixture/repo/.git",
        canonicalCheckoutPath: `/fixture/lanes/${reservation.runId}`,
        baseSha: "a".repeat(40),
        branchName: `codex/oprte-${reservation.runId}`,
        recoveryManifestPath: `/fixture/lanes/.oprte-manifests/${reservation.runId}.json`,
      } as const;

      expect(store.authorizeWorkspaceLaneRecovery(identity)).toBeNull();
      expect(store.bindWorkspaceLane(identity)).toEqual(identity);
      store.markWorkspaceLaneReady(identity);
      expect(new DispatchStore(database).bindWorkspaceLane(identity)).toEqual(identity);
      expect(new DispatchStore(database).authorizeWorkspaceLaneRecovery(identity))
        .toEqual(identity);
      expect(store.authorizeWorkspaceLaneRecovery({
        ...identity,
        baseSha: "b".repeat(40),
      })).toEqual(identity);
      expect(store.bindWorkspaceLane({ ...identity, baseSha: "b".repeat(40) })).toEqual(identity);
      expect(() => store.markWorkspaceLaneReady({
        ...identity,
        baseSha: "b".repeat(40),
      })).toThrow(WorkspaceLaneIdentityConflict);
      expect(database.query("SELECT status FROM workspace_leases WHERE lane_id = ?1")
        .get(identity.laneId)).toEqual({ status: "ready" });
      database.query(`
        UPDATE workspace_leases SET status = 'quarantined',
          quarantine_reason = 'fixture',
          quarantined_at = '2026-08-09T12:00:00.000Z'
        WHERE lane_id = ?1
      `).run(identity.laneId);
      expect(store.authorizeWorkspaceLaneRecovery(identity)).toBeNull();
    } finally {
      database.close();
    }
  });

  test("replays an identical reservation and rejects a changed claim tuple", () => {
    const database = dispatchDatabase();
    try {
      const store = new DispatchStore(database);
      store.bindRepository({
        repositoryPublicId: reservation.repositoryPublicId,
        projectId: "project_primary",
        canonicalRepositoryPath: "/fixture/repo",
        canonicalGitCommonDir: "/fixture/repo/.git",
        now: new Date("2026-07-20T12:00:00.000Z"),
      });
      expect(store.repositoryBinding(reservation.repositoryPublicId)).toEqual({
        repositoryPublicId: reservation.repositoryPublicId,
        projectId: "project_primary",
        canonicalRepositoryPath: "/fixture/repo",
        canonicalGitCommonDir: "/fixture/repo/.git",
      });
      expect(store.reserve({ ...reservation, now: new Date("2026-07-20T12:00:01.000Z") })).toMatchObject({
        ...reservation,
        executionMode: "managed_worktree",
        stage: "reserved",
      });
      expect(new DispatchStore(database).read(reservation.runId)).toMatchObject({
        executionMode: "managed_worktree",
      });
      expect(store.reserve(reservation)).toMatchObject(reservation);
      expect(() => store.reserve({ ...reservation, claimFence: 8 })).toThrow(
        DispatchReservationConflict,
      );
      store.releaseDispatchCapacity(reservation.runId, new Date("2026-07-20T12:00:02.000Z"));
      expect(database.query(`
        SELECT capacity_released_at FROM dispatch_bindings WHERE run_id = ?1
      `).get(reservation.runId)).toEqual({
        capacity_released_at: "2026-07-20T12:00:02.000Z",
      });
    } finally {
      database.close();
    }
  });

  test("migrates unbound legacy reservations fail-closed and recovers proven managed lanes", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      applyMigrationPrefix(database, 22);
      database.query(`
        INSERT INTO projects (
          project_id, canonical_repository_path, canonical_git_common_dir,
          display_name, created_at, updated_at
        ) VALUES (
          'project_migration', '/fixture/migration', '/fixture/migration/.git',
          'Migration fixture', '2026-07-20T12:00:00.000Z',
          '2026-07-20T12:00:00.000Z'
        )
      `).run();
      database.query(`
        INSERT INTO projects (
          project_id, canonical_repository_path, canonical_git_common_dir,
          display_name, created_at, updated_at
        ) VALUES (
          'project_foreign', '/fixture/foreign', '/fixture/foreign/.git',
          'Foreign fixture', '2026-07-20T12:00:00.000Z',
          '2026-07-20T12:00:00.000Z'
        )
      `).run();
      database.query(`
        INSERT INTO repository_bindings (
          repository_public_id, project_id, canonical_repository_path,
          canonical_git_common_dir, created_at, updated_at
        ) VALUES (
          'repo_migration', 'project_migration', '/fixture/migration',
          '/fixture/migration/.git', '2026-07-20T12:00:00.000Z',
          '2026-07-20T12:00:00.000Z'
        )
      `).run();
      database.query(`
        INSERT INTO workspace_leases (
          lane_id, project_id, canonical_checkout_path, mode, status,
          base_sha, branch_name, retention, recovery_manifest_path,
          created_at, updated_at
        ) VALUES (
          'run_provisioned_cloud', 'project_migration',
          '/fixture/lanes/run_provisioned_cloud', 'managed_dispatch',
          'provisioning', ?1, 'codex/oprte-run_provisioned_cloud', 'preserve',
          '/fixture/lanes/.oprte-manifests/run_provisioned_cloud.json',
          '2026-07-20T12:00:00.000Z', '2026-07-20T12:00:00.000Z'
        )
      `).run("b".repeat(40));
      database.query(`
        INSERT INTO workspace_leases (
          lane_id, project_id, canonical_checkout_path, mode, status,
          base_sha, branch_name, retention, recovery_manifest_path,
          created_at, updated_at
        ) VALUES (
          'run_legacy_cloud', 'project_foreign',
          '/fixture/foreign-lanes/run_legacy_cloud', 'managed_dispatch',
          'provisioning', ?1, 'codex/oprte-run_legacy_cloud', 'preserve',
          '/fixture/foreign-lanes/.oprte-manifests/run_legacy_cloud.json',
          '2026-07-20T12:00:00.000Z', '2026-07-20T12:00:00.000Z'
        )
      `).run("a".repeat(40));
      for (const [runId, laneId, branchName] of [
        ["run_legacy_cloud", null, null],
        ["run_managed_cloud", "run_managed_cloud", "codex/oprte-run_managed_cloud"],
      ] as const) {
        database.query(`
          INSERT INTO dispatch_bindings (
            run_id, task_id, task_key, claim_id, claim_fence,
            input_review_revision, runtime_public_id, runtime_boot_id,
            repository_public_id, lane_id, stage, base_sha, branch_name,
            created_at, updated_at
          ) VALUES (
            ?1, 'task_migration', 'OPS-1', ?2, ?3, 1,
            'runtime_migration', 'boot_migration', 'repo_migration', ?4,
            'reserved', ?5, ?6, '2026-07-20T12:00:00.000Z',
            '2026-07-20T12:00:00.000Z'
          )
        `).run(
          runId,
          `claim_${runId}`,
          runId === "run_legacy_cloud" ? 1 : 2,
          laneId,
          "a".repeat(40),
          branchName,
        );
      }
      database.query(`
        INSERT INTO dispatch_bindings (
          run_id, task_id, task_key, claim_id, claim_fence,
          input_review_revision, runtime_public_id, runtime_boot_id,
          repository_public_id, stage, created_at, updated_at
        ) VALUES (
          'run_provisioned_cloud', 'task_migration', 'OPS-1',
          'claim_run_provisioned_cloud', 3, 1, 'runtime_migration',
          'boot_migration', 'repo_migration', 'reserved',
          '2026-07-20T12:00:00.000Z', '2026-07-20T12:00:00.000Z'
        )
      `).run();
      for (const [runId, laneId, branchName] of [
        ["run_legacy_local", null, null],
        ["run_managed_local", "run_managed_local", "codex/oprte-run_managed_local"],
      ] as const) {
        database.query(`
          INSERT INTO local_run_execution_bindings (
            workspace_id, run_id, task_id, task_key, claim_id, claim_fence,
            input_review_revision, runtime_public_id, runtime_boot_id,
            repository_id, account_profile_id, lane_id, stage, base_sha,
            branch_name, created_at, updated_at
          ) VALUES (
            'wsp_migration', ?1, 'task_migration', 'OPS-1', ?2, ?3, 1,
            'runtime_migration', 'boot_migration', 'repo_migration',
            'account_migration', ?4, 'reserved', ?5, ?6, 1, 1
          )
        `).run(
          runId,
          `claim_${runId}`,
          runId === "run_legacy_local" ? 1 : 2,
          laneId,
          "a".repeat(40),
          branchName,
        );
      }

      applyMigrations(database);

      expect(database.query(`
        SELECT run_id, execution_mode, lane_id, base_sha, branch_name
        FROM dispatch_bindings ORDER BY run_id
      `).all()).toEqual([
        {
          run_id: "run_legacy_cloud",
          execution_mode: "legacy_unbound",
          lane_id: null,
          base_sha: "a".repeat(40),
          branch_name: null,
        },
        {
          run_id: "run_managed_cloud",
          execution_mode: "managed_worktree",
          lane_id: "run_managed_cloud",
          base_sha: "a".repeat(40),
          branch_name: "codex/oprte-run_managed_cloud",
        },
        {
          run_id: "run_provisioned_cloud",
          execution_mode: "managed_worktree",
          lane_id: "run_provisioned_cloud",
          base_sha: "b".repeat(40),
          branch_name: "codex/oprte-run_provisioned_cloud",
        },
      ]);
      expect(database.query(`
        SELECT run_id, execution_mode
        FROM local_run_execution_bindings ORDER BY run_id
      `).all()).toEqual([
        { run_id: "run_legacy_local", execution_mode: "legacy_unbound" },
        { run_id: "run_managed_local", execution_mode: "managed_worktree" },
      ]);
      expect(() => database.query(`
        UPDATE dispatch_bindings SET execution_mode = 'development_source'
      `).run()).toThrow();
    } finally {
      database.close();
    }
  });

  test("orders a replay-safe semantic outbox and forbids terminal resurrection", () => {
    const database = dispatchDatabase();
    try {
      const store = new DispatchStore(database);
      store.bindRepository({
        repositoryPublicId: reservation.repositoryPublicId,
        projectId: "project_primary",
        canonicalRepositoryPath: "/fixture/repo",
        canonicalGitCommonDir: "/fixture/repo/.git",
      });
      store.reserve(reservation);
      const first = store.appendPublicEvent({
        runId: reservation.runId,
        eventId: "event_primary001",
        kind: "worktree.preparing",
        now: new Date("2026-07-20T12:01:00.000Z"),
      });
      expect(store.appendPublicEvent({
        runId: reservation.runId,
        eventId: "event_primary001",
        kind: "worktree.preparing",
      })).toEqual(first);
      expect(() => store.appendPublicEvent({
        runId: reservation.runId,
        eventId: "event_primary001",
        kind: "run.failed",
      })).toThrow(DispatchReservationConflict);
      const second = store.appendPublicEvent({
        runId: reservation.runId,
        eventId: "event_primary002",
        kind: "worktree.ready",
      });
      expect(second.sequence).toBe(2);
      expect(store.latestPublicEvent(reservation.runId)).toEqual(second);
      expect(store.pendingEvents()).toEqual([first, second]);
      expect(store.acknowledge(reservation.runId, 1)).toBe(1);
      expect(store.pendingEvents()).toEqual([second]);

      store.transition({ runId: reservation.runId, to: "failed", failureCode: "git_failed" });
      expect(() => store.transition({ runId: reservation.runId, to: "running" })).toThrow(
        DispatchTransitionConflict,
      );
    } finally {
      database.close();
    }
  });

  test("coalesces display deltas durably and materializes them before later status", () => {
    const database = dispatchDatabase();
    try {
      const store = new DispatchStore(database);
      store.bindRepository({
        repositoryPublicId: reservation.repositoryPublicId,
        projectId: "project_primary",
        canonicalRepositoryPath: "/fixture/repo",
        canonicalGitCommonDir: "/fixture/repo/.git",
      });
      store.reserve(reservation);
      for (const displayText of ["Checking ", "the ", "lease."]) {
        expect(store.appendDisplayDelta({
          runId: reservation.runId,
          kind: "codex.reasoning_summary.delta",
          displayText,
        })).toBe(new TextEncoder().encode(displayText).length);
      }
      expect(store.pendingEventsForRun(reservation.runId)).toEqual([]);

      // A fresh store sees and seals the same draft after process restart.
      const restarted = new DispatchStore(database);
      const display = restarted.materializeDisplayDraft(reservation.runId);
      expect(display).toMatchObject({
        sequence: 1,
        kind: "codex.reasoning_summary.delta",
        displayText: "Checking the lease.",
      });
      expect(restarted.materializeDisplayDraft(reservation.runId)).toBeNull();

      restarted.appendDisplayDelta({
        runId: reservation.runId,
        kind: "codex.assistant_message.delta",
        displayText: "Done.",
      });
      const terminal = restarted.appendPublicEvent({
        runId: reservation.runId,
        eventId: "event_submitted001",
        kind: "run.submitted",
      });
      expect(terminal.sequence).toBe(3);
      const events = restarted.pendingEventsForRun(reservation.runId);
      expect(events.map(({ kind }) => kind)).toEqual([
        "codex.reasoning_summary.delta",
        "codex.assistant_message.delta",
        "run.submitted",
      ]);
      expect(appendRunEventsRequestSchema.safeParse({
        runnerId: "runner_primary0001",
        bootId: "boot_primary0001",
        claimId: reservation.claimId,
        claimFence: reservation.claimFence,
        events: events.map(({ eventId, sequence, kind, displayText }) => ({
          id: `event_${eventId.replace(/[^a-z0-9_-]/gu, "_")}`,
          sequence,
          kind,
          ...(displayText === undefined ? {} : { displayText }),
        })),
      }).success).toBeTrue();
    } finally {
      database.close();
    }
  });

  test("bounds display content independently from terminal outbox capacity", () => {
    const database = dispatchDatabase();
    try {
      const store = new DispatchStore(database);
      store.bindRepository({
        repositoryPublicId: reservation.repositoryPublicId,
        projectId: "project_primary",
        canonicalRepositoryPath: "/fixture/repo",
        canonicalGitCommonDir: "/fixture/repo/.git",
      });
      store.reserve(reservation);
      const fullChunk = "x".repeat(MAX_RUN_DISPLAY_TEXT_UTF8_BYTES);
      for (let index = 0; index < MAX_RUN_DISPLAY_EVENTS + 10; index += 1) {
        store.appendDisplayDelta({
          runId: reservation.runId,
          kind: index % 2 === 0
            ? "codex.reasoning_summary.delta"
            : "codex.assistant_message.delta",
          displayText: fullChunk,
        });
      }
      store.materializeDisplayDraft(reservation.runId);
      expect(store.displayEventCount(reservation.runId)).toBe(MAX_RUN_DISPLAY_EVENTS);
      expect(store.read(reservation.runId)?.lastEventSequence).toBe(MAX_RUN_DISPLAY_EVENTS);
      expect(() => store.appendDisplayDelta({
        runId: reservation.runId,
        kind: "codex.assistant_message.delta",
        displayText: "unsafe\u0000control",
      })).toThrow();
      expect(store.appendPublicEvent({
        runId: reservation.runId,
        eventId: "event_terminal001",
        kind: "run.failed",
      }).sequence).toBe(MAX_RUN_DISPLAY_EVENTS + 1);
    } finally {
      database.close();
    }
  });

  test("reasoning exhaustion preserves a bounded tail for the final assistant response", () => {
    const database = dispatchDatabase();
    try {
      const store = new DispatchStore(database);
      store.bindRepository({
        repositoryPublicId: reservation.repositoryPublicId,
        projectId: "project_primary",
        canonicalRepositoryPath: "/fixture/repo",
        canonicalGitCommonDir: "/fixture/repo/.git",
      });
      store.reserve(reservation);
      const fullChunk = "r".repeat(MAX_RUN_DISPLAY_TEXT_UTF8_BYTES);
      for (let index = 0; index < MAX_RUN_REASONING_SUMMARY_EVENTS + 20; index += 1) {
        store.appendDisplayDelta({
          runId: reservation.runId,
          kind: "codex.reasoning_summary.delta",
          displayText: fullChunk,
        });
      }
      store.materializeDisplayDraft(reservation.runId);
      expect(store.reasoningSummaryEventCount(reservation.runId))
        .toBe(MAX_RUN_REASONING_SUMMARY_EVENTS);
      store.appendDisplayDelta({
        runId: reservation.runId,
        kind: "codex.assistant_message.delta",
        displayText: "Final response remains visible.",
      });
      store.materializeDisplayDraft(reservation.runId);
      expect(store.latestPublicEvent(reservation.runId)).toMatchObject({
        kind: "codex.assistant_message.delta",
        displayText: "Final response remains visible.",
      });
      expect(store.displayEventCount(reservation.runId))
        .toBe(MAX_RUN_REASONING_SUMMARY_EVENTS + 1);
      expect(store.displayEventCount(reservation.runId)).toBeLessThanOrEqual(MAX_RUN_DISPLAY_EVENTS);
    } finally {
      database.close();
    }
  });
});
