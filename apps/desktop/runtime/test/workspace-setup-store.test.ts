import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { ChatPaneStore } from "../src/state/chat-pane-store";
import {
  chatWorkspaceLaneId,
  ChatWorkspaceStore,
} from "../src/state/chat-workspace-store";
import { applyMigrations } from "../src/state/database";
import { migrations } from "../src/state/migrations";
import {
  WorkspaceSetupStore,
  WorkspaceSetupStoreError,
} from "../src/state/workspace-setup-store";
import type { WorkspaceLaneIdentity } from
  "../src/workspaces/workspace-broker";
import { workspaceSetupRejectionDigest } from
  "../src/workspaces/workspace-setup-recipe";

const NOW = new Date("2026-08-21T12:00:00.000Z");
const ACCOUNT = "acct_workspacesetup01";
const PANE = "pane_workspacesetup01";
const REPOSITORY = `repo_${"7".repeat(26)}`;
const BASE = "a".repeat(40);
const RECIPE = "b".repeat(64);
const EXECUTOR = "c".repeat(64);
const EXECUTOR_TWO = "d".repeat(64);
const INSTANCE = "wsexec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const INSTANCE_TWO = "wsexec_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function fixture(options: Readonly<{ v62Ready?: boolean }> = {}) {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  if (options.v62Ready === true) {
    for (const migration of migrations) {
      if (migration.version <= 62) database.exec(migration.sql);
    }
  } else {
    applyMigrations(database);
  }
  database.query(`
    INSERT INTO account_profiles (
      profile_id, label, auth_state, process_generation,
      selected, created_at, updated_at
    ) VALUES (?1, 'Setup', 'signed_in', 1, 1, ?2, ?2)
  `).run(ACCOUNT, NOW.toISOString());
  database.query(`
    INSERT INTO local_repositories (
      repository_id, name, canonical_repository_path,
      canonical_git_common_dir, created_at, updated_at
    ) VALUES (?1, 'Setup repository', ?2, ?3, ?4, ?4)
  `).run(
    REPOSITORY,
    "/private/tmp/hra-setup-repository",
    "/private/tmp/hra-setup-repository/.git",
    NOW.getTime(),
  );
  const panes = new ChatPaneStore(database, {
    messageRequestDigestKey: new Uint8Array(32).fill(19),
  });
  panes.create({
    paneId: PANE,
    repository: {
      id: REPOSITORY,
      name: "Setup repository",
      workingDirectory: "/private/tmp/hra-setup-repository",
    },
    accountProfileId: ACCOUNT,
    now: NOW,
  });
  const laneId = chatWorkspaceLaneId(PANE, 1);
  const identity: WorkspaceLaneIdentity = {
    runId: laneId,
    laneId,
    baseSha: BASE,
    branchName: `codex/oprte-${laneId}`,
    canonicalRepositoryPath: "/private/tmp/hra-setup-repository",
    canonicalGitCommonDir: "/private/tmp/hra-setup-repository/.git",
    canonicalCheckoutPath: `/private/tmp/hra-setup-lanes/${laneId}`,
    recoveryManifestPath: `/private/tmp/hra-setup-lanes/.oprte-manifests/${laneId}.json`,
  };
  const workspace = new ChatWorkspaceStore(database, {
    now: () => NOW,
    panes,
  });
  workspace.bindWorkspaceLane(identity);
  if (options.v62Ready === true) {
    workspace.markWorkspaceLaneReady(identity);
    const setupMigration = migrations.find(({ version }) => version === 63);
    if (setupMigration === undefined) throw new Error("Missing setup migration");
    database.exec(setupMigration.sql);
  }
  return {
    database,
    identity,
    panes,
    store: new WorkspaceSetupStore(database, { now: () => NOW }),
    workspace,
  };
}

describe("WorkspaceSetupStore", () => {
  test("binds approval, effect, and success to one monotonic lane head", () => {
    const value = fixture();
    try {
      const beforeRevision = value.panes.require(PANE).projection.revision;
      const beforePane = paneRevisions(value.database);
      const requested = value.store.requestApproval({
        identity: value.identity,
        recipeDigest: RECIPE,
        executorDigest: EXECUTOR,
      });
      expect(requested).toMatchObject({
        paneId: PANE,
        state: "approval_required",
        setupRevision: 1,
        recipeDigest: RECIPE,
        executorDigest: EXECUTOR,
      });
      expect(value.panes.require(PANE).projection.revision).toBe(
        beforeRevision + 1,
      );
      expect(paneRevisions(value.database)).toEqual({
        revision: beforePane.revision + 1,
        workspace_revision: beforePane.workspace_revision + 1,
      });

      expect(value.store.requestApproval({
        identity: value.identity,
        recipeDigest: RECIPE,
        executorDigest: EXECUTOR,
      })).toEqual(requested);
      expect(value.panes.require(PANE).projection.revision).toBe(
        beforeRevision + 1,
      );
      expect(paneRevisions(value.database)).toEqual({
        revision: beforePane.revision + 1,
        workspace_revision: beforePane.workspace_revision + 1,
      });

      const approved = value.store.approve({
        requestId: requested.requestId,
        recipeDigest: RECIPE,
        expectedSetupRevision: 1,
      });
      expect(approved).toMatchObject({ changed: true, setupRevision: 2 });
      expect(paneRevisions(value.database)).toEqual({
        revision: beforePane.revision + 2,
        workspace_revision: beforePane.workspace_revision + 2,
      });
      expect(value.store.approve({
        requestId: requested.requestId,
        recipeDigest: RECIPE,
        expectedSetupRevision: 1,
      })).toMatchObject({ changed: false, setupRevision: 2 });

      expect(value.store.claimEffect({
        requestId: requested.requestId,
        executorInstanceId: INSTANCE,
      })).toMatchObject({
        disposition: "claimed",
        request: { state: "effect_started", setupRevision: 3 },
      });
      expect(paneRevisions(value.database)).toEqual({
        revision: beforePane.revision + 3,
        workspace_revision: beforePane.workspace_revision + 3,
      });
      expect(value.store.claimEffect({
        requestId: requested.requestId,
        executorInstanceId: INSTANCE,
      })).toMatchObject({ disposition: "in_progress" });
      const succeeded = value.store.settleSucceeded({
        requestId: requested.requestId,
        executorInstanceId: INSTANCE,
        transcript: "installed\n",
      });
      expect(succeeded).toMatchObject({ state: "succeeded", setupRevision: 4 });
      expect(value.store.readLocalDiagnostic(requested.requestId)).toBe(
        "installed\n",
      );
      expect(value.store.allAttention()).toEqual([]);
      expect(value.store.hasUnsettledWork()).toBe(false);
      expect(value.panes.require(PANE).projection.revision).toBe(
        beforeRevision + 4,
      );
      expect(paneRevisions(value.database)).toEqual({
        revision: beforePane.revision + 4,
        workspace_revision: beforePane.workspace_revision + 4,
      });
    } finally {
      value.database.close();
    }
  });

  test("keeps an exact successful recipe authoritative across executor changes", () => {
    const value = fixture();
    try {
      const first = value.store.requestApproval({
        identity: value.identity,
        recipeDigest: RECIPE,
        executorDigest: EXECUTOR,
      });
      value.store.approve({
        requestId: first.requestId,
        recipeDigest: RECIPE,
        expectedSetupRevision: 1,
      });
      value.store.claimEffect({
        requestId: first.requestId,
        executorInstanceId: INSTANCE,
      });
      const succeeded = value.store.settleSucceeded({
        requestId: first.requestId,
        executorInstanceId: INSTANCE,
        transcript: "installed\n",
      });
      const before = value.database.serialize();

      expect(value.store.requestApproval({
        identity: value.identity,
        recipeDigest: RECIPE,
        executorDigest: EXECUTOR_TWO,
      })).toEqual(succeeded);
      expect(value.database.serialize()).toEqual(before);
      expect(value.database.query(`
        SELECT COUNT(*) AS count FROM workspace_setup_requests
      `).get()).toEqual({ count: 1 });
    } finally {
      value.database.close();
    }
  });

  test("never revives an exact historical non-head request", () => {
    const value = fixture();
    try {
      const first = value.store.requestApproval({
        identity: value.identity,
        recipeDigest: RECIPE,
        executorDigest: EXECUTOR,
      });
      value.store.approve({
        requestId: first.requestId,
        recipeDigest: RECIPE,
        expectedSetupRevision: 1,
      });
      value.store.claimEffect({
        requestId: first.requestId,
        executorInstanceId: INSTANCE,
      });
      value.store.settleFailed({
        requestId: first.requestId,
        executorInstanceId: INSTANCE,
        failureCode: "exit_nonzero",
        transcript: "failed\n",
      });
      const second = value.store.requestApproval({
        identity: value.identity,
        recipeDigest: RECIPE,
        executorDigest: EXECUTOR_TWO,
      });
      const before = value.database.serialize();

      expect(() => value.store.requestApproval({
        identity: value.identity,
        recipeDigest: RECIPE,
        executorDigest: EXECUTOR,
      })).toThrow("historical workspace setup request");
      expect(value.database.serialize()).toEqual(before);
      expect(value.store.headForLane(value.identity.laneId)?.requestId).toBe(
        second.requestId,
      );
    } finally {
      value.database.close();
    }
  });

  test("persists pre-effect rejection without approval, effect, or transcript", () => {
    const value = fixture();
    try {
      const before = paneRevisions(value.database);
      const rejected = value.store.recordPreEffectFailure({
        identity: value.identity,
        recipeDigest: RECIPE,
        executorDigest: EXECUTOR,
        failureCode: "invalid_recipe",
      });
      expect(rejected).toMatchObject({
        state: "rejected",
        setupRevision: 1,
        failureCode: "invalid_recipe",
      });
      expect(value.database.query(`
        SELECT approval_binding_digest, executor_instance_id, transcript,
          transcript_bytes, approved_at, effect_started_at
        FROM workspace_setup_requests WHERE request_id = ?1
      `).get(rejected.requestId)).toEqual({
        approval_binding_digest: null,
        executor_instance_id: null,
        transcript: null,
        transcript_bytes: null,
        approved_at: null,
        effect_started_at: null,
      });
      expect(paneRevisions(value.database)).toEqual({
        revision: before.revision + 1,
        workspace_revision: before.workspace_revision + 1,
      });
      expect(new WorkspaceSetupStore(value.database).allAttention()).toEqual([{
        paneId: PANE,
        setupRequestId: rejected.requestId,
        recipeDigest: RECIPE,
        setupRevision: 1,
        state: "failed",
        outcome: "invalid_recipe",
      }]);
      const postimage = value.database.serialize();
      expect(value.store.recordPreEffectFailure({
        identity: value.identity,
        recipeDigest: RECIPE,
        executorDigest: EXECUTOR,
        failureCode: "invalid_recipe",
      })).toEqual(rejected);
      expect(value.store.requestApproval({
        identity: value.identity,
        recipeDigest: RECIPE,
        executorDigest: EXECUTOR,
      })).toEqual(rejected);
      expect(value.database.serialize()).toEqual(postimage);
      expect(() => value.store.approve({
        requestId: rejected.requestId,
        recipeDigest: RECIPE,
        expectedSetupRevision: 1,
      })).toThrow("no longer awaiting");
    } finally {
      value.database.close();
    }
  });

  test("reconciles only an exact disproved Git-read rejection without a pane bump", () => {
    const value = fixture();
    try {
      const rejected = value.store.recordPreEffectFailure({
        identity: value.identity,
        recipeDigest: workspaceSetupRejectionDigest(BASE, "git_read_failed"),
        executorDigest: EXECUTOR,
        failureCode: "runtime_unavailable",
      });
      const afterRejection = paneRevisions(value.database);
      const beforeMismatch = value.database.serialize();
      expect(value.store.reconcileProvenAbsentAfterGitReadFailure({
        identity: value.identity,
        executorDigest: EXECUTOR_TWO,
      })).toBe(false);
      expect(value.database.serialize()).toEqual(beforeMismatch);

      expect(value.store.reconcileProvenAbsentAfterGitReadFailure({
        identity: value.identity,
        executorDigest: EXECUTOR,
      })).toBe(true);
      expect(value.store.headForLane(value.identity.laneId)).toBeNull();
      expect(value.store.allAttention()).toEqual([]);
      expect(paneRevisions(value.database)).toEqual(afterRejection);
      expect(value.database.query(`
        SELECT COUNT(*) AS count FROM workspace_setup_requests
        WHERE request_id = ?1
      `).get(rejected.requestId)).toEqual({ count: 0 });
    } finally {
      value.database.close();
    }
  });

  test("preserves every non-Git-read rejection when recipe absence is proven", () => {
    const value = fixture();
    try {
      const rejected = value.store.recordPreEffectFailure({
        identity: value.identity,
        recipeDigest: workspaceSetupRejectionDigest(BASE, "invalid_recipe"),
        executorDigest: EXECUTOR,
        failureCode: "invalid_recipe",
      });
      const before = value.database.serialize();
      expect(value.store.reconcileProvenAbsentAfterGitReadFailure({
        identity: value.identity,
        executorDigest: EXECUTOR,
      })).toBe(false);
      expect(value.database.serialize()).toEqual(before);
      expect(value.store.headForLane(value.identity.laneId)).toEqual(rejected);
      expect(value.store.allAttention()).toHaveLength(1);
    } finally {
      value.database.close();
    }
  });

  test("fences a proven recipe on a pre-authority ready lane for clean replacement", () => {
    const value = fixture({ v62Ready: true });
    try {
      const before = paneRevisions(value.database);
      const fenced = value.store.requireCleanReplacementForLegacyReadyLane({
        identity: value.identity,
        recipeDigest: RECIPE,
        executorDigest: EXECUTOR,
      });
      if (fenced === null) throw new Error("Expected legacy setup fence");
      expect(fenced).toMatchObject({
        state: "rejected",
        setupRevision: 1,
        failureCode: "clean_replacement_required",
      });
      expect(paneRevisions(value.database)).toEqual({
        revision: before.revision + 1,
        workspace_revision: before.workspace_revision + 1,
      });
      expect(value.panes.require(PANE).projection.workspace).toEqual({
        mode: "managedWorktree",
        state: "recoveryRequired",
        revision: before.workspace_revision + 1,
        recoveryKind: "provisionInterrupted",
      });
      expect(value.database.query(`
        SELECT lease.status, lease.quarantine_reason,
          binding.state, binding.recovery_reason
        FROM workspace_leases AS lease
        JOIN chat_pane_workspace_bindings AS binding
          ON binding.workspace_lease_id = lease.lane_id
        WHERE lease.lane_id = ?1
      `).get(value.identity.laneId)).toEqual({
        status: "quarantined",
        quarantine_reason: "provision_interrupted",
        state: "quarantined",
        recovery_reason: "provision_interrupted",
      });
      expect(value.store.allAttention()).toEqual([{
        paneId: PANE,
        setupRequestId: fenced.requestId,
        recipeDigest: RECIPE,
        setupRevision: 1,
        state: "failed",
        outcome: "clean_replacement_required",
      }]);
      expect(value.workspace.readyRepository(PANE, {
        id: REPOSITORY,
        name: "Setup repository",
        workingDirectory: value.identity.canonicalRepositoryPath,
      })).toBeNull();

      expect(value.workspace.beginProvisioning(PANE).workspace).toEqual({
        mode: "managedWorktree",
        state: "recoveryRequired",
        revision: before.workspace_revision + 1,
        recoveryKind: "provisionInterrupted",
      });
      expect(value.store.requireCleanReplacementForLegacyReadyLane({
        identity: value.identity,
        recipeDigest: RECIPE,
        executorDigest: EXECUTOR_TWO,
      })).toEqual(fenced);
      expect(value.database.query(`
        SELECT COUNT(*) AS count FROM workspace_setup_requests
      `).get()).toEqual({ count: 1 });
    } finally {
      value.database.close();
    }
  });

  test("does not fence a new provisioning lane before its first setup approval", () => {
    const value = fixture();
    try {
      expect(value.store.requireCleanReplacementForLegacyReadyLane({
        identity: value.identity,
        recipeDigest: RECIPE,
        executorDigest: EXECUTOR,
      })).toBeNull();
      expect(value.store.headForLane(value.identity.laneId)).toBeNull();
      expect(value.panes.require(PANE).projection.workspace?.state).toBe(
        "preparing",
      );
    } finally {
      value.database.close();
    }
  });

  test("turns a prior executor effect into durable ambiguity without replay", () => {
    const value = fixture();
    try {
      const requested = value.store.requestApproval({
        identity: value.identity,
        recipeDigest: RECIPE,
        executorDigest: EXECUTOR,
      });
      value.store.approve({
        requestId: requested.requestId,
        recipeDigest: RECIPE,
        expectedSetupRevision: 1,
      });
      value.store.claimEffect({
        requestId: requested.requestId,
        executorInstanceId: INSTANCE,
      });

      expect(value.store.recoverInterruptedEffects(INSTANCE_TWO)).toBe(1);
      expect(value.store.headForLane(value.identity.laneId)).toMatchObject({
        state: "ambiguous",
        setupRevision: 4,
      });
      expect(value.store.readLocalDiagnostic(requested.requestId)).toBeNull();
      expect(value.store.allAttention()).toEqual([{
        paneId: PANE,
        setupRequestId: requested.requestId,
        recipeDigest: RECIPE,
        setupRevision: 4,
        state: "ambiguous",
      }]);
      expect(value.store.recoverInterruptedEffects(INSTANCE_TWO)).toBe(0);
    } finally {
      value.database.close();
    }
  });

  test("requires fresh approval when exact executor bytes change", () => {
    const value = fixture();
    try {
      const first = value.store.requestApproval({
        identity: value.identity,
        recipeDigest: RECIPE,
        executorDigest: EXECUTOR,
      });
      value.store.approve({
        requestId: first.requestId,
        recipeDigest: RECIPE,
        expectedSetupRevision: 1,
      });
      value.store.claimEffect({
        requestId: first.requestId,
        executorInstanceId: INSTANCE,
      });
      value.store.settleFailed({
        requestId: first.requestId,
        executorInstanceId: INSTANCE,
        failureCode: "exit_nonzero",
        transcript: "failed\n",
      });

      const second = value.store.requestApproval({
        identity: value.identity,
        recipeDigest: RECIPE,
        executorDigest: EXECUTOR_TWO,
      });
      expect(second).toMatchObject({
        state: "approval_required",
        setupRevision: 1,
        executorDigest: EXECUTOR_TWO,
      });
      expect(second.requestId).not.toBe(first.requestId);
      expect(value.store.allAttention()).toEqual([{
        paneId: PANE,
        setupRequestId: second.requestId,
        recipeDigest: RECIPE,
        setupRevision: 1,
        state: "approvalRequired",
      }]);
      expect(value.database.query(`
        SELECT COUNT(*) AS count FROM workspace_setup_requests
      `).get()).toEqual({ count: 2 });
    } finally {
      value.database.close();
    }
  });

  test("blocks pane preservation while the setup child effect is live", () => {
    const value = fixture();
    try {
      const request = value.store.requestApproval({
        identity: value.identity,
        recipeDigest: RECIPE,
        executorDigest: EXECUTOR,
      });
      value.store.approve({
        requestId: request.requestId,
        recipeDigest: RECIPE,
        expectedSetupRevision: 1,
      });
      value.store.claimEffect({
        requestId: request.requestId,
        executorInstanceId: INSTANCE,
      });
      const before = value.database.serialize();
      expect(() => value.database.query(`
        UPDATE chat_pane_workspace_bindings
        SET state = 'preserved', revision = revision + 1
        WHERE expected_lane_id = ?1 AND state = 'provisioning'
      `).run(value.identity.laneId)).toThrow(
        "workspace setup effect must settle before pane preservation",
      );
      expect(value.database.serialize()).toEqual(before);

      expect(value.store.markEffectAmbiguous({
        requestId: request.requestId,
        executorInstanceId: INSTANCE,
      })).toBe(true);
      expect(value.database.query(`
        UPDATE chat_pane_workspace_bindings
        SET state = 'preserved', revision = revision + 1
        WHERE expected_lane_id = ?1 AND state = 'provisioning'
      `).run(value.identity.laneId).changes).toBe(1);
      expect(value.store.allAttention()).toEqual([]);
      expect(value.store.hasUnsettledWork()).toBe(false);
    } finally {
      value.database.close();
    }
  });

  test("rejects forged revisions, uncoupled pane bumps, and lane-project drift", () => {
    const value = fixture();
    try {
      const before = value.database.serialize();
      expect(() => value.database.query(`
        UPDATE chat_panes
        SET revision = revision + 1,
          workspace_revision = workspace_revision + 1
        WHERE pane_id = ?1
      `).run(PANE)).toThrow("invalid chat workspace projection transition");
      expect(value.database.serialize()).toEqual(before);

      const request = value.store.requestApproval({
        identity: value.identity,
        recipeDigest: RECIPE,
        executorDigest: EXECUTOR,
      });
      const afterRequest = value.database.serialize();
      expect(() => value.database.query(`
        UPDATE workspace_setup_requests
        SET setup_revision = 2
        WHERE request_id = ?1
      `).run(request.requestId)).toThrow();
      expect(value.database.serialize()).toEqual(afterRequest);
      expect(() => value.database.query(`
        UPDATE chat_panes
        SET revision = revision + 1,
          workspace_revision = workspace_revision + 1
        WHERE pane_id = ?1
      `).run(PANE)).toThrow("invalid chat workspace projection transition");
      expect(value.database.serialize()).toEqual(afterRequest);

      value.database.query(`
        INSERT INTO projects (
          project_id, canonical_repository_path, canonical_git_common_dir,
          display_name, created_at, updated_at
        ) VALUES (
          'project_workspace_setup_other', '/private/tmp/setup-other',
          '/private/tmp/setup-other/.git', 'Other', ?1, ?1
        )
      `).run(NOW.getTime());
      expect(() => value.database.query(`
        INSERT INTO workspace_setup_requests (
          request_id, lane_id, project_id, base_sha, recipe_digest,
          executor_digest, state, setup_revision, created_at, updated_at
        ) VALUES (
          'wssetup_ffffffffffffffffffffffffffffffff', ?1,
          'project_workspace_setup_other', ?2, ?3, ?4,
          'approval_required', 1, ?5, ?5
        )
      `).run(
        value.identity.laneId,
        BASE,
        RECIPE,
        EXECUTOR_TWO,
        NOW.toISOString(),
      )).toThrow("workspace setup request project mismatch");

      value.database.query(`
        UPDATE chat_pane_workspace_bindings
        SET project_id = 'project_workspace_setup_other'
        WHERE expected_lane_id = ?1
      `).run(value.identity.laneId);
      expect(() => value.database.query(`
        INSERT INTO workspace_setup_requests (
          request_id, lane_id, project_id, base_sha, recipe_digest,
          executor_digest, state, setup_revision, created_at, updated_at
        )
        SELECT
          'wssetup_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', lease.lane_id,
          lease.project_id, ?2, ?3, ?4, 'approval_required', 1, ?5, ?5
        FROM workspace_leases AS lease
        WHERE lease.lane_id = ?1
      `).run(
        value.identity.laneId,
        BASE,
        "e".repeat(64),
        EXECUTOR_TWO,
        NOW.toISOString(),
      )).toThrow("workspace setup request project mismatch");
    } finally {
      value.database.close();
    }
  });

  test("recomputes the exact approval binding before child-effect claim", () => {
    const value = fixture();
    try {
      const request = value.store.requestApproval({
        identity: value.identity,
        recipeDigest: RECIPE,
        executorDigest: EXECUTOR,
      });
      value.store.approve({
        requestId: request.requestId,
        recipeDigest: RECIPE,
        expectedSetupRevision: 1,
      });
      value.database.query(`
        UPDATE workspace_setup_requests
        SET approval_binding_digest = ?2
        WHERE request_id = ?1
      `).run(request.requestId, "f".repeat(64));
      const before = value.database.serialize();
      expect(() => value.store.claimEffect({
        requestId: request.requestId,
        executorInstanceId: INSTANCE,
      })).toThrow("approval binding is corrupt");
      expect(value.database.serialize()).toEqual(before);
    } finally {
      value.database.close();
    }
  });

  test("rejects stale or changed approval without touching authority", () => {
    const value = fixture();
    try {
      const request = value.store.requestApproval({
        identity: value.identity,
        recipeDigest: RECIPE,
        executorDigest: EXECUTOR,
      });
      const before = value.database.serialize();
      expect(() => value.store.approve({
        requestId: request.requestId,
        recipeDigest: "f".repeat(64),
        expectedSetupRevision: 1,
      })).toThrow(WorkspaceSetupStoreError);
      expect(value.database.serialize()).toEqual(before);
      expect(() => value.store.approve({
        requestId: request.requestId,
        recipeDigest: RECIPE,
        expectedSetupRevision: 2,
      })).toThrow("stale");
      expect(value.database.serialize()).toEqual(before);
    } finally {
      value.database.close();
    }
  });
});

function paneRevisions(database: Database): Readonly<{
  revision: number;
  workspace_revision: number;
}> {
  const value = database.query(`
    SELECT revision, workspace_revision FROM chat_panes WHERE pane_id = ?1
  `).get(PANE);
  if (
    typeof value !== "object" || value === null ||
    typeof (value as { revision?: unknown }).revision !== "number" ||
    typeof (value as { workspace_revision?: unknown }).workspace_revision !==
      "number"
  ) throw new Error("Expected pane revisions");
  return value as { revision: number; workspace_revision: number };
}
