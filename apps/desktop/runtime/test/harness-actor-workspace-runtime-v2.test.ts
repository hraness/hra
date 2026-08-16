import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  actorEpochSchema,
  actorSchema,
  type Actor,
} from "../src/harness/actor-domain";
import {
  HarnessActorWorkspaceIdentityStoreV2,
  PersistentActorWorkspaceRuntimeV2,
  type HarnessActorWorkspaceRuntimeV2Error,
} from "../src/harness/actor-workspace-runtime-v2";
import {
  deriveManagedActorLaneId,
  deriveReadOnlySnapshotId,
} from "../src/harness/actor-workspace-adapter";
import { HarnessSQLiteAuthorityV2 } from "../src/harness/sqlite-authority-v2";
import { applyMigrations } from "../src/state/database";
import {
  WorkspaceLaneQuarantinedError,
  type ReadOnlySnapshotIdentity,
  type WorkspaceLaneIdentity,
} from "../src/workspaces/workspace-broker";

const at = "2030-01-01T00:00:00.000Z";
const later = "2030-01-01T00:00:01.000Z";
const deadline = "2030-01-02T00:00:00.000Z";
const sourceSha = "a".repeat(40);
const projectId = "project-actor-workspace-v2";
const repositoryPath = "/tmp/actor-workspace-source";
const gitCommonDir = "/tmp/actor-workspace-source/.git";
const lanesRoot = "/tmp/actor-workspace-lanes";

function fixture() {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.query(`
    INSERT INTO projects (
      project_id, canonical_repository_path, canonical_git_common_dir,
      display_name, created_at, updated_at
    ) VALUES (?1, ?2, ?3, 'Actor Workspace', ?4, ?4)
  `).run(projectId, repositoryPath, gitCommonDir, at);
  const authority = new HarnessSQLiteAuthorityV2(database, {
    now: () => new Date(later),
  });
  const budget = {
    maxDepth: 3,
    maxActiveDescendants: 8,
    maxDurableDescendants: 50,
    tokenBudget: 100_000,
    byteBudget: 16 * 1024 * 1024,
    deadline,
    laneAuthority: "managedWrite" as const,
  };
  const epoch = actorEpochSchema.parse({
    id: "hepoch_workspacev2001",
    projectId,
    sourceSha,
    rootActorId: "hactor_workspacev2001",
    budget,
    tokenReserved: 0,
    byteReserved: 0,
    nextRootCompletionSequence: 1,
    state: "active",
    revision: 1,
    createdAt: at,
    updatedAt: at,
    stoppedAt: null,
  });
  const root = actorSchema.parse({
    id: epoch.rootActorId,
    epochId: epoch.id,
    parentActorId: null,
    depth: 0,
    title: "Root actor",
    state: "active",
    budget,
    tokenReserved: 0,
    byteReserved: 0,
    nextTurnOrdinal: 1,
    nextResultOrdinal: 1,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    stoppedAt: null,
  });
  authority.createActorEpoch({ epoch, rootActor: root });
  const identities = new HarnessActorWorkspaceIdentityStoreV2(database, {
    now: () => new Date(later),
  });
  return { authority, database, epoch, identities, root };
}

function identity(laneId: string): ReadOnlySnapshotIdentity;
function identity(laneId: string, branchName: string): WorkspaceLaneIdentity;
function identity(
  laneId: string,
  branchName?: string,
): ReadOnlySnapshotIdentity | WorkspaceLaneIdentity {
  const base = {
    baseSha: sourceSha,
    canonicalCheckoutPath: `${lanesRoot}/${laneId}`,
    canonicalGitCommonDir: gitCommonDir,
    canonicalRepositoryPath: repositoryPath,
    laneId,
    recoveryManifestPath: `${lanesRoot}/.oprte-manifests/${laneId}.json`,
    runId: laneId,
  };
  return branchName === undefined ? base : { ...base, branchName };
}

function child(root: Actor, id: string) {
  return actorSchema.parse({
    id,
    epochId: root.epochId,
    parentActorId: root.id,
    depth: 1,
    title: id,
    state: "active",
    budget: {
      ...root.budget,
      laneAuthority: "readOnlySnapshot",
      tokenBudget: 10_000,
      byteBudget: 1024 * 1024,
    },
    tokenReserved: 0,
    byteReserved: 0,
    nextTurnOrdinal: 1,
    nextResultOrdinal: 1,
    revision: 1,
    createdAt: later,
    updatedAt: later,
    stoppedAt: null,
  });
}

describe("persistent actor workspace runtime", () => {
  test("rejects an invalid binding before any broker or durable effect", async () => {
    const { authority, database, epoch, identities, root } = fixture();
    let managedCalls = 0;
    let readOnlyCalls = 0;
    const runtime = new PersistentActorWorkspaceRuntimeV2({
      database,
      authority,
      broker: {
        provision: () => {
          managedCalls += 1;
          return Promise.reject(new Error("invalid input reached broker"));
        },
        provisionReadOnlySnapshot: () => {
          readOnlyCalls += 1;
          return Promise.reject(new Error("invalid input reached broker"));
        },
      },
      identities,
    });

    expect(await rejected(runtime.acquire({
      epoch,
      actor: root,
      bindingId: "invalid",
    }))).toBeDefined();
    expect({ managedCalls, readOnlyCalls }).toEqual({
      managedCalls: 0,
      readOnlyCalls: 0,
    });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM workspace_leases
    `).get()).toEqual({ count: 0 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM harness_actor_workspace_bindings
    `).get()).toEqual({ count: 0 });
  });

  test("persists and binds one exact managed actor worktree", async () => {
    const { authority, database, epoch, identities, root } = fixture();
    const laneId = deriveManagedActorLaneId(root.id, sourceSha);
    const branchName = `codex/oprte-${laneId}`;
    const exactIdentity = identity(laneId, branchName);
    expect(identities.authorizeWorkspaceLaneRecovery(exactIdentity)).toBeNull();
    const broker = {
      provision() {
        const record = exactIdentity;
        identities.bindWorkspaceLane(record);
        identities.markWorkspaceLaneReady(record);
        return Promise.resolve({
          baseSha: sourceSha,
          branchName,
          canonicalGitCommonDir: gitCommonDir,
          checkoutPath: record.canonicalCheckoutPath,
          laneId,
          recovered: false,
        });
      },
      provisionReadOnlySnapshot: () => Promise.reject(new Error("unexpected")),
    };
    const runtime = new PersistentActorWorkspaceRuntimeV2({
      database,
      authority,
      broker,
      identities,
    });
    expect(await runtime.acquire({
      epoch,
      actor: root,
      bindingId: "hbinding_workspace0001",
    })).toEqual({ laneId, authority: "managedWrite" });
    expect(database.query(`
      SELECT mode, status, branch_name FROM workspace_leases WHERE lane_id = ?1
    `).get(laneId)).toEqual({
      mode: "managed_worktree",
      status: "ready",
      branch_name: branchName,
    });
    expect(identities.authorizeWorkspaceLaneRecovery(exactIdentity))
      .toEqual(exactIdentity);
    expect(identities.authorizeWorkspaceLaneRecovery({
      ...exactIdentity,
      baseSha: "f".repeat(40),
    })).toEqual(exactIdentity);
  });

  test("shares one exact detached snapshot across read-only siblings", async () => {
    const { authority, database, epoch, identities, root } = fixture();
    const first = authority.createChildActor(child(root, "hactor_workspacechild1"));
    const refreshedRoot = authority.readActor(root.id)!;
    const second = authority.createChildActor(child(
      refreshedRoot,
      "hactor_workspacechild2",
    ));
    const laneId = deriveReadOnlySnapshotId(projectId, sourceSha);
    const broker = {
      provision: () => Promise.reject(new Error("unexpected")),
      provisionReadOnlySnapshot() {
        const record = identity(laneId);
        identities.bindReadOnlySnapshot(record);
        identities.markReadOnlySnapshotReady(record);
        return Promise.resolve({
          baseSha: sourceSha,
          canonicalGitCommonDir: gitCommonDir,
          checkoutPath: record.canonicalCheckoutPath,
          laneId,
          recovered: false,
        });
      },
    };
    const runtime = new PersistentActorWorkspaceRuntimeV2({
      database,
      authority,
      broker,
      identities,
    });
    for (const [actor, bindingId] of [
      [first, "hbinding_workspacechild1"],
      [second, "hbinding_workspacechild2"],
    ] as const) {
      expect(await runtime.acquire({ epoch, actor, bindingId })).toEqual({
        laneId,
        authority: "readOnlySnapshot",
      });
    }
    expect(database.query(`
      SELECT COUNT(*) AS count FROM workspace_leases WHERE lane_id = ?1
    `).get(laneId)).toEqual({ count: 1 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM harness_actor_workspace_bindings
      WHERE lane_id = ?1 AND state = 'active'
    `).get(laneId)).toEqual({ count: 2 });
  });

  test("preserves a drifted lane and durably quarantines its actor", async () => {
    const { authority, database, epoch, identities, root } = fixture();
    const laneId = deriveManagedActorLaneId(root.id, sourceSha);
    const branchName = `codex/oprte-${laneId}`;
    const broker = {
      provision() {
        identities.bindWorkspaceLane(identity(laneId, branchName));
        return Promise.reject(
          new WorkspaceLaneQuarantinedError("dirty_checkout"),
        );
      },
      provisionReadOnlySnapshot: () => Promise.reject(new Error("unexpected")),
    };
    const runtime = new PersistentActorWorkspaceRuntimeV2({
      database,
      authority,
      broker,
      identities,
    });
    expect(await rejected(runtime.acquire({
      epoch,
      actor: root,
      bindingId: "hbinding_workspace0001",
    }))).toMatchObject({
      code: "workspace_quarantined",
    } satisfies Partial<HarnessActorWorkspaceRuntimeV2Error>);
    expect(authority.readActor(root.id)?.state).toBe("quarantined");
    expect(database.query(`
      SELECT status, quarantine_reason FROM workspace_leases WHERE lane_id = ?1
    `).get(laneId)).toEqual({
      status: "quarantined",
      quarantine_reason: "dirty_checkout",
    });
  });
});

async function rejected<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected promise to reject");
}
