import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { applyMigrations } from "../src/state/database";
import {
  createLocalRuntimeBootId,
  LocalBootFenceConflict,
  LocalDueWorkStore,
} from "../src/state/local-task-due-work-store";
import { LocalTaskAuthorityCommandStore } from "../src/state/local-task-authority-command-store";
import { LocalTaskStore } from "../src/state/local-task-store";

const INSTALLATION_ID = "install_due_work";
const WORKSPACE_ID = "wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REPOSITORY_ID = "repo_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TASK_ID = "tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OPERATION_ID = "op_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const KEY = new Uint8Array(32).fill(0x31);

function fixture() {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  const tasks = new LocalTaskStore(database, KEY);
  tasks.registerInstallation(INSTALLATION_ID, 1);
  tasks.onboardProject({
    installationId: INSTALLATION_ID,
    repository: {
      repositoryId: REPOSITORY_ID,
      name: "Offline repository",
      canonicalRepositoryPath: "/tmp/due-work",
      canonicalGitCommonDir: "/tmp/due-work/.git",
    },
    workspace: {
      workspaceId: WORKSPACE_ID,
      name: "Due work",
      slug: "due-work",
      keyPrefix: "DUE",
    },
  }, 2);
  const receipt = tasks.execute({
    kind: "task.create_and_run",
    operationId: OPERATION_ID,
    authority: {
      kind: "local_owner",
      workspaceId: WORKSPACE_ID,
      installationId: INSTALLATION_ID,
    },
    expectedWorkspaceRevision: 1,
    taskId: TASK_ID,
    title: "Recover me",
    description: "",
    type: "task",
    priority: 2,
    availableAt: 0,
    labels: [],
    repositoryId: REPOSITORY_ID,
  }, undefined, 3);
  if (
    receipt.outcome !== "committed" ||
    receipt.result.kind !== "task_created" ||
    receipt.result.runId === undefined
  ) {
    throw new Error("Fixture did not create its queued run");
  }
  return {
    database,
    tasks,
    due: new LocalDueWorkStore(database),
    runId: receipt.result.runId,
  };
}

describe("local due-work durability", () => {
  test("creates a fresh local fence identity for every process boot", () => {
    const uuids = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ];
    const nextUuid = () => {
      const value = uuids.shift();
      if (value === undefined) throw new Error("UUID fixture exhausted");
      return value;
    };
    expect(createLocalRuntimeBootId(nextUuid))
      .toBe("boot_00000000000040008000000000000001");
    expect(createLocalRuntimeBootId(nextUuid))
      .toBe("boot_00000000000040008000000000000002");
  });

  test("claims elapsed work after sleep and retries with a durable backoff", () => {
    const { database, due } = fixture();
    try {
      const generation = due.beginBoot({
        installationId: INSTALLATION_ID,
        bootId: "boot_due_work_one",
        now: 10,
      });
      due.enqueue({
        workspaceId: WORKSPACE_ID,
        kind: "repair",
        entityId: "workspace",
        dueAt: 100,
        now: 10,
      });
      const claimed = due.claimDue({
        bootGeneration: generation,
        now: 10_000,
        limit: 10,
      });
      expect(claimed.map(({ kind }) => kind)).toContain("repair");
      const repair = claimed.find(({ kind }) => kind === "repair");
      if (repair === undefined) throw new Error("Repair work was not claimed");
      due.retry({
        id: repair.id,
        bootGeneration: generation,
        workGeneration: repair.workGeneration,
        nextDueAt: 20_000,
        errorCode: "transient",
        now: 10_001,
      });
      expect(due.claimDue({
        bootGeneration: generation,
        now: 19_999,
        limit: 10,
      }).some(({ id }) => id === repair.id)).toBeFalse();
      const retried = due.claimDue({
        bootGeneration: generation,
        now: 20_000,
        limit: 10,
      }).find(({ id }) => id === repair.id);
      expect(retried?.attempt).toBe(2);
      if (retried === undefined) throw new Error("Repair retry was not claimed");
      due.complete({
        id: retried.id,
        bootGeneration: generation,
        workGeneration: retried.workGeneration,
        now: 20_001,
      });
    } finally {
      database.close();
    }
  });

  test("atomically rebases a queued run when its task revision changes", () => {
    const { database, due, runId, tasks } = fixture();
    try {
      expect(tasks.execute({
        kind: "task.update",
        operationId: "op_01ARZ3NDEKTSV4RRFFQ69G5FB0",
        authority: {
          kind: "local_owner",
          workspaceId: WORKSPACE_ID,
          installationId: INSTALLATION_ID,
        },
        expectedWorkspaceRevision: 2,
        taskId: TASK_ID,
        expectedTaskRevision: 1,
        patch: { title: "Use the revised title" },
      }, undefined, 4)).toMatchObject({
        outcome: "committed",
        result: { kind: "task_updated", taskRevision: 2 },
      });
      expect(database.query<{
        phase: string;
        intent_state: string;
        due_state: string;
        expected_revision: number | null;
      }, [string]>(`
        SELECT run.phase, intent.state AS intent_state,
          due.state AS due_state, due.expected_revision
        FROM local_task_runs AS run
        JOIN local_queued_run_intents AS intent
          ON intent.workspace_id = run.workspace_id
          AND intent.run_id = run.run_id
        JOIN local_due_work AS due
          ON due.workspace_id = run.workspace_id
          AND due.work_kind = 'queued_run'
          AND due.entity_id = run.run_id
        WHERE run.run_id = ?1
      `).get(runId)).toEqual({
        phase: "queued",
        intent_state: "queued",
        due_state: "pending",
        expected_revision: 2,
      });

      const generation = due.beginBoot({
        installationId: INSTALLATION_ID,
        bootId: "boot_revision_rebase",
        now: 5,
      });
      const work = due.claimDue({
        bootGeneration: generation,
        now: 5,
        limit: 10,
      }).find(({ kind }) => kind === "queued_run");
      if (work === undefined) throw new Error("Rebased queued run was not claimable");
      expect(new LocalTaskAuthorityCommandStore({ database, tasks })
        .prepareDueWork({
          work,
          bootGeneration: generation,
          now: 5,
          operationId: "op_01ARZ3NDEKTSV4RRFFQ69G5FB1",
        })).toMatchObject({
          kind: "current",
          authority: { revision: 2 },
        });
    } finally {
      database.close();
    }
  });

  test("an obsolete claim cannot cancel a replacement generation", () => {
    const { database, due } = fixture();
    try {
      const generation = due.beginBoot({
        installationId: INSTALLATION_ID,
        bootId: "boot_due_generation",
        now: 10,
      });
      due.enqueue({
        workspaceId: WORKSPACE_ID,
        kind: "repair",
        entityId: "generation-race",
        dueAt: 10,
        expectedRevision: 1,
        now: 10,
      });
      const oldClaim = due.claimDue({
        bootGeneration: generation,
        now: 10,
        limit: 10,
      }).find(({ entityId }) => entityId === "generation-race");
      if (oldClaim === undefined) throw new Error("Old generation was not claimed");
      due.enqueue({
        workspaceId: WORKSPACE_ID,
        kind: "repair",
        entityId: "generation-race",
        dueAt: 20,
        expectedRevision: 2,
        now: 11,
      });

      expect(due.cancel({
        id: oldClaim.id,
        bootGeneration: generation,
        workGeneration: oldClaim.workGeneration,
        now: 12,
      })).toBeFalse();
      expect(database.query<{
        state: string;
        due_at: number;
        expected_revision: number | null;
        work_generation: number;
      }, [string]>(`
        SELECT state, due_at, expected_revision, work_generation
        FROM local_due_work WHERE due_work_id = ?1
      `).get(oldClaim.id)).toEqual({
        state: "pending",
        due_at: 20,
        expected_revision: 2,
        work_generation: oldClaim.workGeneration + 1,
      });
    } finally {
      database.close();
    }
  });

  test.each(["done", "cancelled"] as const)(
    "treats same-generation %s settlement as an obsolete no-op",
    (terminalState) => {
      const { database, due } = fixture();
      try {
        const generation = due.beginBoot({
          installationId: INSTALLATION_ID,
          bootId: `boot_same_generation_${terminalState}`,
          now: 10,
        });
        due.enqueue({
          workspaceId: WORKSPACE_ID,
          kind: "repair",
          entityId: `terminal-${terminalState}`,
          dueAt: 10,
          now: 10,
        });
        const work = due.claimDue({
          bootGeneration: generation,
          now: 10,
          limit: 10,
        }).find(({ entityId }) => entityId === `terminal-${terminalState}`);
        if (work === undefined) throw new Error("Terminal work was not claimed");

        database.query(`
          UPDATE local_due_work
          SET state = ?2, claimed_boot_generation = NULL, claimed_at = NULL,
            updated_at = 11
          WHERE due_work_id = ?1
        `).run(work.id, terminalState);

        expect(due.complete({
          id: work.id,
          bootGeneration: generation,
          workGeneration: work.workGeneration,
          now: 12,
        })).toBeFalse();
      } finally {
        database.close();
      }
    },
  );

  test("requeues a pre-side-effect claim under a higher fence after restart", () => {
    const { database, due, runId } = fixture();
    try {
      const firstBoot = due.beginBoot({
        installationId: INSTALLATION_ID,
        bootId: "boot_due_work_first",
        now: 10,
      });
      const claim = due.claimQueuedRunIntent({
        workspaceId: WORKSPACE_ID,
        runId,
        bootGeneration: firstBoot,
        now: 10,
      });
      expect(claim?.fence).toBe(1);

      const secondBoot = due.beginBoot({
        installationId: INSTALLATION_ID,
        bootId: "boot_due_work_second",
        now: 20,
      });
      const replay = due.claimQueuedRunIntent({
        workspaceId: WORKSPACE_ID,
        runId,
        bootGeneration: secondBoot,
        now: 20,
      });
      expect(replay?.fence).toBe(2);
      expect(() => due.markQueuedRunIntentStarted({
        workspaceId: WORKSPACE_ID,
        runId,
        bootGeneration: firstBoot,
        fence: 1,
        now: 21,
      })).toThrow(LocalBootFenceConflict);
    } finally {
      database.close();
    }
  });

  test("never requeues a crash-after-start side effect and exposes run recovery", () => {
    const { database, due, tasks, runId } = fixture();
    try {
      const firstBoot = due.beginBoot({
        installationId: INSTALLATION_ID,
        bootId: "boot_crash_after_start",
        now: 10,
      });
      const claim = due.claimQueuedRunIntent({
        workspaceId: WORKSPACE_ID,
        runId,
        bootGeneration: firstBoot,
        now: 10,
      });
      if (claim === null) throw new Error("Queued run was not claimed");
      due.markQueuedRunIntentStarted({
        workspaceId: WORKSPACE_ID,
        runId,
        bootGeneration: firstBoot,
        fence: claim.fence,
        now: 11,
      });

      const secondBoot = due.beginBoot({
        installationId: INSTALLATION_ID,
        bootId: "boot_after_crash",
        now: 100,
      });
      expect(due.claimQueuedRunIntent({
        workspaceId: WORKSPACE_ID,
        runId,
        bootGeneration: secondBoot,
        now: 100,
      })).toBeNull();
      const recovery = due.claimDue({
        bootGeneration: secondBoot,
        now: 100,
        limit: 10,
      }).filter(({ kind, entityId }) =>
        kind === "run_recovery" && entityId === runId);
      expect(recovery).toHaveLength(1);
      expect(database.query<{ state: string }, [string]>(`
        SELECT state FROM local_queued_run_intents WHERE run_id = ?1
      `).get(runId)?.state).toBe("started");

      const receipt = tasks.execute({
        kind: "run.reconcile",
        operationId: "op_01ARZ3NDEKTSV4RRFFQ69G5FAW",
        workspaceId: WORKSPACE_ID,
        runId,
        bootGeneration: secondBoot,
      }, undefined, 101);
      expect(receipt).toMatchObject({
        outcome: "committed",
        result: { kind: "run_updated", runId, phase: "ambiguous" },
      });
      expect(database.query<{ state: string }, [string]>(`
        SELECT state FROM local_queued_run_intents WHERE run_id = ?1
      `).get(runId)?.state).toBe("abandoned");

      const thirdBoot = due.beginBoot({
        installationId: INSTALLATION_ID,
        bootId: "boot_after_second_crash",
        now: 200,
      });
      const nextRecovery = due.claimDue({
        bootGeneration: thirdBoot,
        now: 200,
        limit: 10,
      }).filter(({ kind, entityId }) =>
        kind === "run_recovery" && entityId === runId);
      expect(nextRecovery).toHaveLength(0);
      expect(due.claimQueuedRunIntent({
        workspaceId: WORKSPACE_ID,
        runId,
        bootGeneration: thirdBoot,
        now: 200,
      })).toBeNull();
    } finally {
      database.close();
    }
  });

  test("claims restart recovery before an older claim expiry", () => {
    const { database, due, runId } = fixture();
    try {
      const firstBoot = due.beginBoot({
        installationId: INSTALLATION_ID,
        bootId: "boot_recovery_precedence_first",
        now: 10,
      });
      due.enqueue({
        workspaceId: WORKSPACE_ID,
        kind: "claim_expiry",
        entityId: "claim_recovery_precedence",
        dueAt: 1,
        expectedRevision: 1,
        expectedFence: 1,
        now: 10,
      });
      const claim = due.claimQueuedRunIntent({
        workspaceId: WORKSPACE_ID,
        runId,
        bootGeneration: firstBoot,
        now: 10,
      });
      if (claim === null) throw new Error("Queued run was not claimed");
      due.markQueuedRunIntentStarted({
        workspaceId: WORKSPACE_ID,
        runId,
        bootGeneration: firstBoot,
        fence: claim.fence,
        now: 11,
      });

      const secondBoot = due.beginBoot({
        installationId: INSTALLATION_ID,
        bootId: "boot_recovery_precedence_second",
        now: 100,
      });
      expect(due.claimDue({
        bootGeneration: secondBoot,
        now: 100,
        limit: 1,
      })[0]).toMatchObject({
        kind: "run_recovery",
        entityId: runId,
      });
    } finally {
      database.close();
    }
  });

  test("bounds claims and rejects stale completion after a boot change", () => {
    const { database, due } = fixture();
    try {
      const firstBoot = due.beginBoot({
        installationId: INSTALLATION_ID,
        bootId: "boot_bound_first",
        now: 10,
      });
      for (let index = 0; index < 25; index += 1) {
        due.enqueue({
          workspaceId: WORKSPACE_ID,
          kind: "repair",
          entityId: `repair-${String(index)}`,
          dueAt: 10,
          now: 10,
        });
      }
      const firstPage = due.claimDue({
        bootGeneration: firstBoot,
        now: 10,
        limit: 7,
      });
      expect(firstPage).toHaveLength(7);
      const staleWork = firstPage[0];
      if (staleWork === undefined) throw new Error("Expected stale claimed work");
      const secondBoot = due.beginBoot({
        installationId: INSTALLATION_ID,
        bootId: "boot_bound_second",
        now: 11,
      });
      expect(() => due.complete({
        id: staleWork.id,
        bootGeneration: firstBoot,
        workGeneration: staleWork.workGeneration,
        now: 12,
      })).toThrow(LocalBootFenceConflict);
      expect(due.claimDue({
        bootGeneration: secondBoot,
        now: 12,
        limit: 7,
      })).toHaveLength(7);
    } finally {
      database.close();
    }
  });

  test("recovers stale run intents in bounded reconciliation pages after boot", () => {
    const { database, due } = fixture();
    try {
      const firstBoot = due.beginBoot({
        installationId: INSTALLATION_ID,
        bootId: "boot_bounded_recovery_first",
        now: 10,
      });
      database.transaction(() => {
        const run = database.query(`
          INSERT INTO local_task_runs (
            workspace_id, task_id, run_id, repository_id, phase, desired_state,
            recovery_state, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, 'queued', 'run', 'none', 11, 11)
        `);
        const intent = database.query(`
          INSERT INTO local_queued_run_intents (
            workspace_id, run_id, task_id, repository_id, state, fence,
            claimed_boot_generation, available_at, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, 'claimed', 1, ?5, 0, 11, 11)
        `);
        for (let index = 0; index < 150; index += 1) {
          const runId = `run_stale_${String(index).padStart(4, "0")}`;
          run.run(WORKSPACE_ID, TASK_ID, runId, REPOSITORY_ID);
          intent.run(
            WORKSPACE_ID,
            runId,
            TASK_ID,
            REPOSITORY_ID,
            firstBoot,
          );
        }
      })();

      const secondBoot = due.beginBoot({
        installationId: INSTALLATION_ID,
        bootId: "boot_bounded_recovery_second",
        now: 20,
      });
      expect(database.query<{ count: number }, []>(`
        SELECT count(*) AS count FROM local_queued_run_intents
        WHERE state = 'claimed'
      `).get()?.count).toBe(118);

      due.claimDue({
        bootGeneration: secondBoot,
        now: 20,
        limit: 7,
      });
      expect(database.query<{ state: string; count: number }, []>(`
        SELECT state, count(*) AS count FROM local_queued_run_intents
        WHERE state IN ('claimed', 'queued')
        GROUP BY state ORDER BY state
      `).all()).toEqual([
        { state: "claimed", count: 111 },
        { state: "queued", count: 40 },
      ]);
    } finally {
      database.close();
    }
  });
});
