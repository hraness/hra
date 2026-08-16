import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import type { AccountRuntimeRouter } from "../src/accounts/runtime-router";
import { reconcilePinnedCodexThreadStart } from "../src/codex/reconciliation";
import {
  actorEpochSchema,
  actorSchema,
} from "../src/harness/actor-domain";
import {
  HarnessActorMutationFenceV2,
  HarnessActorWorkspaceLookupV2,
} from "../src/harness/production-adapters-v2";
import { HarnessSQLiteAuthorityV2 } from "../src/harness/sqlite-authority-v2";
import { applyMigrations } from "../src/state/database";
import type { ControlPlaneLifetimeLock } from "../src/state/control-plane-lock";

const at = "2030-01-01T00:00:00.000Z";
const deadline = "2030-01-02T00:00:00.000Z";
const projectId = "project-production-adapters-v2";
const actorId = "hactor_production_adapter01";
const epochId = "hepoch_production_adapter01";
const laneId = "harness_lane_production_adapter_01";

function openDatabase(): Readonly<{
  database: Database;
  actors: HarnessSQLiteAuthorityV2;
}> {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.query(`
    INSERT INTO projects (
      project_id, canonical_repository_path, canonical_git_common_dir,
      display_name, created_at, updated_at
    ) VALUES (?1, '/tmp/production-adapter', '/tmp/production-adapter/.git',
      'Production adapter', ?2, ?2)
  `).run(projectId, at);
  const budget = {
    maxDepth: 3,
    maxActiveDescendants: 8,
    maxDurableDescendants: 50,
    tokenBudget: 100_000,
    byteBudget: 16 * 1024 * 1024,
    deadline,
    laneAuthority: "managedWrite" as const,
  };
  const actors = new HarnessSQLiteAuthorityV2(database, {
    now: () => new Date(at),
  });
  actors.createActorEpoch({
    epoch: actorEpochSchema.parse({
      id: epochId,
      projectId,
      sourceSha: "a".repeat(40),
      rootActorId: actorId,
      budget,
      tokenReserved: 0,
      byteReserved: 0,
      nextRootCompletionSequence: 1,
      state: "active",
      revision: 1,
      createdAt: at,
      updatedAt: at,
      stoppedAt: null,
    }),
    rootActor: actorSchema.parse({
      id: actorId,
      epochId,
      parentActorId: null,
      depth: 0,
      title: "Root",
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
    }),
  });
  database.query(`
    INSERT INTO workspace_leases (
      lane_id, project_id, canonical_checkout_path, mode, status,
      base_sha, branch_name, retention, dirty_hint,
      recovery_manifest_path, created_at, updated_at
    ) VALUES (
      ?1, ?2, '/tmp/production-adapter-lane', 'managed_worktree',
      'ready', ?3, 'codex/oprte-production-adapter', 'preserve', 0,
      '/tmp/production-adapter-manifest.json', ?4, ?4
    )
  `).run(laneId, projectId, "a".repeat(40), at);
  actors.bindActorWorkspace({
    bindingId: "hbinding_production_adapter01",
    actorId,
    laneId,
    authority: "managedWrite",
    createdAt: at,
  });
  return { database, actors };
}

describe("production harness adapters v2", () => {
  test("resolves only the one ready lane durably bound to an actor", async () => {
    const { database } = openDatabase();
    try {
      const lookup = new HarnessActorWorkspaceLookupV2(database);
      expect(await lookup.resolveLane(laneId)).toEqual({
        checkoutPath: "/tmp/production-adapter-lane",
        authority: "managedWrite",
      });
      expect(await lookup.resolveActor(actorId)).toEqual({
        checkoutPath: "/tmp/production-adapter-lane",
        authority: "managedWrite",
      });
      database.query(
        "UPDATE workspace_leases SET status = 'quarantined' WHERE lane_id = ?1",
      ).run(laneId);
      try {
        await lookup.resolveActor(actorId);
        throw new Error("expected quarantined actor workspace rejection");
      } catch (error: unknown) {
        expect(error).toMatchObject({ code: "not_found" });
      }
    } finally {
      database.close();
    }
  });

  test("admits negative mutation evidence only under a stable live successor and lock", async () => {
    let held = true;
    const lock: ControlPlaneLifetimeLock = {
      path: "/tmp/control-plane.lock",
      bindControlPlane: () => {
        if (!held) throw new Error("released");
        return {
          controlPlanePath: "/tmp/control-plane.sqlite",
          stateRoot: { device: "1", inode: "2" },
          controlPlane: { device: "1", inode: "3" },
        };
      },
      release: () => {
        held = false;
      },
    };
    let generation = 7;
    let running = true;
    const runtimes = {
      generation: () => generation,
      isRunning: () => running,
    } satisfies Pick<AccountRuntimeRouter, "generation" | "isRunning">;
    const fence = new HarnessActorMutationFenceV2({
      lifetimeLock: lock,
      runtimes,
    });
    const input = {
      accountProfileId: "acct_production_adapter",
      processGeneration: 7,
      effectKey: "b".repeat(64),
    };
    const stableAbsentScan = {
      complete: true,
      active: [],
      archived: [],
    } as const;
    const threadIdentity = {
      threadSource: "oprte-harness-actor-v2",
      cwd: "/tmp/production-adapter-lane",
      ephemeral: false,
      historyMode: "paginated" as const,
    };
    const sameGenerationFence = await fence.read(input);
    expect(sameGenerationFence).toEqual({
      previousGenerationTerminated: false,
      exclusiveMutationLease: false,
      externalDeletionExcluded: false,
    });
    expect(reconcilePinnedCodexThreadStart(
      threadIdentity,
      stableAbsentScan,
      stableAbsentScan,
      sameGenerationFence,
    )).toEqual({ kind: "pending", reason: "generation_not_fenced" });

    generation = 8;
    const successorFence = await fence.read(input);
    expect(successorFence).toEqual({
      previousGenerationTerminated: true,
      exclusiveMutationLease: true,
      externalDeletionExcluded: true,
    });
    expect(reconcilePinnedCodexThreadStart(
      threadIdentity,
      stableAbsentScan,
      stableAbsentScan,
      successorFence,
    )).toEqual({ kind: "not_applied" });

    running = false;
    expect(await fence.read(input)).toEqual({
      previousGenerationTerminated: false,
      exclusiveMutationLease: false,
      externalDeletionExcluded: false,
    });

    running = true;
    generation = 6;
    expect(await fence.read(input)).toEqual({
      previousGenerationTerminated: false,
      exclusiveMutationLease: false,
      externalDeletionExcluded: false,
    });

    generation = 8;
    let generationReads = 0;
    const changingRuntimes = {
      generation: () => ++generationReads === 1 ? 8 : 9,
      isRunning: () => true,
    } satisfies Pick<AccountRuntimeRouter, "generation" | "isRunning">;
    const changingFence = new HarnessActorMutationFenceV2({
      lifetimeLock: lock,
      runtimes: changingRuntimes,
    });
    expect(await changingFence.read(input)).toEqual({
      previousGenerationTerminated: false,
      exclusiveMutationLease: false,
      externalDeletionExcluded: false,
    });

    running = true;
    lock.release();
    expect(await fence.read(input)).toEqual({
      previousGenerationTerminated: false,
      exclusiveMutationLease: false,
      externalDeletionExcluded: false,
    });
  });
});
