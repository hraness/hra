import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { applyMigrations } from "../src/state/database";
import {
  LocalTaskAuthorityCommandStore,
  type LocalTaskAuthorityPreparation,
} from "../src/state/local-task-authority-command-store";
import { LocalDueWorkStore } from "../src/state/local-task-due-work-store";
import { LocalTaskStore } from "../src/state/local-task-store";
import {
  localDueWorkOperationId,
  type LocalTaskAuthorityCommandPort,
} from "../src/tasks/handler-adapter";
import type { LocalTaskDueWork } from "../src/tasks/reconciler";

const INSTALLATION_ID = "install_authority_commands";
const WORKSPACE_ID = "wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REPOSITORY_ID = "repo_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const LOCATOR_PREFIX = "01ARZ3NDEKTSV4RRFFQ69G5FA";
const DEFER_TASK_ID = `tsk_${LOCATOR_PREFIX}0`;
const QUEUED_TASK_ID = `tsk_${LOCATOR_PREFIX}1`;
const CLAIM_TASK_ID = `tsk_${LOCATOR_PREFIX}2`;
const RECOVERY_TASK_ID = `tsk_${LOCATOR_PREFIX}3`;
const INTERACTION_TASK_ID = `tsk_${LOCATOR_PREFIX}4`;
const QUEUED_RUN_ID = "run_authority_queued";
const RECOVERY_RUN_ID = "run_authority_recovery";
const INTERACTION_RUN_ID = "run_authority_interaction";
const CLAIM_ID = "claim_authority_expiry";
const INTERACTION_ID = "interaction_authority_expiry";
const KEY = new Uint8Array(32).fill(0x43);

interface AuthorityFixture {
  readonly bootGeneration: number;
  readonly callbacks: {
    readonly workspaceId: string;
    readonly projectionRevision: number;
  }[];
  readonly database: Database;
  readonly due: LocalDueWorkStore;
  readonly port: LocalTaskAuthorityCommandStore;
  readonly work: ReadonlyMap<LocalTaskDueWork["kind"], LocalTaskDueWork>;
}

function seedTask(
  database: Database,
  input: Readonly<{
    id: string;
    revision: number;
    status: "open" | "in_progress";
  }>,
): void {
  database.query(`
    INSERT INTO local_tasks (
      workspace_id, task_id, task_key, title, task_type, priority, status,
      available_at, repository_id, revision, review_revision, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, 'task', 2, ?5, ?6, ?7, ?8, 1, 1, 1)
  `).run(
    WORKSPACE_ID,
    input.id,
    `AUTH-${String(input.revision).padStart(7, "0")}`,
    `Authority task ${input.revision}`,
    input.status,
    input.id === DEFER_TASK_ID ? 100 : 0,
    REPOSITORY_ID,
    input.revision,
  );
  database.query(`
    INSERT INTO local_task_bodies (workspace_id, task_id, description, updated_at)
    VALUES (?1, ?2, '', 1)
  `).run(WORKSPACE_ID, input.id);
}

function seedRun(
  database: Database,
  input: Readonly<{
    runId: string;
    taskId: string;
    phase: "queued" | "running" | "waiting";
    bootGeneration: number | null;
  }>,
): void {
  database.query(`
    INSERT INTO local_task_runs (
      workspace_id, task_id, run_id, repository_id, phase, desired_state,
      boot_generation, recovery_state, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, 'run', ?6, 'none', 1, 1)
  `).run(
    WORKSPACE_ID,
    input.taskId,
    input.runId,
    REPOSITORY_ID,
    input.phase,
    input.bootGeneration,
  );
}

function fixture(): AuthorityFixture {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  const tasks = new LocalTaskStore(database, KEY);
  tasks.registerInstallation(INSTALLATION_ID, 1);
  tasks.onboardProject({
    installationId: INSTALLATION_ID,
    repository: {
      repositoryId: REPOSITORY_ID,
      name: "Authority repository",
      canonicalRepositoryPath: "/tmp/authority-commands",
      canonicalGitCommonDir: "/tmp/authority-commands/.git",
    },
    workspace: {
      workspaceId: WORKSPACE_ID,
      name: "Authority commands",
      slug: "authority-commands",
      keyPrefix: "AUTH",
    },
  }, 1);
  const due = new LocalDueWorkStore(database);
  const oldBootGeneration = due.beginBoot({
    installationId: INSTALLATION_ID,
    bootId: "boot_authority_old",
    now: 10,
  });

  seedTask(database, { id: DEFER_TASK_ID, revision: 3, status: "open" });
  seedTask(database, { id: QUEUED_TASK_ID, revision: 4, status: "open" });
  seedTask(database, { id: CLAIM_TASK_ID, revision: 5, status: "in_progress" });
  seedTask(database, { id: RECOVERY_TASK_ID, revision: 6, status: "open" });
  seedTask(database, { id: INTERACTION_TASK_ID, revision: 7, status: "open" });
  seedRun(database, {
    runId: QUEUED_RUN_ID,
    taskId: QUEUED_TASK_ID,
    phase: "queued",
    bootGeneration: null,
  });
  seedRun(database, {
    runId: RECOVERY_RUN_ID,
    taskId: RECOVERY_TASK_ID,
    phase: "running",
    bootGeneration: oldBootGeneration,
  });
  seedRun(database, {
    runId: INTERACTION_RUN_ID,
    taskId: INTERACTION_TASK_ID,
    phase: "waiting",
    bootGeneration: oldBootGeneration,
  });
  database.query(`
    INSERT INTO local_queued_run_intents (
      workspace_id, run_id, task_id, repository_id, state, available_at,
      created_at, updated_at
    ) VALUES
      (?1, ?2, ?3, ?4, 'queued', 100, 1, 1),
      (?1, ?5, ?6, ?4, 'queued', 0, 1, 1)
  `).run(
    WORKSPACE_ID,
    QUEUED_RUN_ID,
    QUEUED_TASK_ID,
    REPOSITORY_ID,
    RECOVERY_RUN_ID,
    RECOVERY_TASK_ID,
  );
  const oldClaim = due.claimQueuedRunIntent({
    workspaceId: WORKSPACE_ID,
    runId: RECOVERY_RUN_ID,
    bootGeneration: oldBootGeneration,
    now: 11,
  });
  if (oldClaim === null) throw new Error("Recovery fixture intent was not claimed");
  due.markQueuedRunIntentStarted({
    workspaceId: WORKSPACE_ID,
    runId: RECOVERY_RUN_ID,
    bootGeneration: oldBootGeneration,
    fence: oldClaim.fence,
    now: 12,
  });
  database.query(`
    UPDATE local_task_runs SET fence = ?3
    WHERE workspace_id = ?1 AND run_id = ?2
  `).run(WORKSPACE_ID, RECOVERY_RUN_ID, oldClaim.fence);
  database.query(`
    INSERT INTO local_task_claims (
      workspace_id, task_id, claim_id, agent_id, fence, lease_generation,
      lease_until, state, boot_generation, created_at, updated_at
    ) VALUES (?1, ?2, ?3, 'builtin_local_codex', 7, 9, 100, 'active', ?4, 1, 1)
  `).run(WORKSPACE_ID, CLAIM_TASK_ID, CLAIM_ID, oldBootGeneration);
  const request = {
    id: INTERACTION_ID,
    createdAt: 1,
    expiresAt: 100,
    kind: "file_change_approval",
    scope: "once",
  };
  database.query(`
    INSERT INTO local_run_interactions (
      workspace_id, run_id, interaction_id, request_json, state,
      created_at, expires_at
    ) VALUES (?1, ?2, ?3, ?4, 'pending', 1, 100)
  `).run(
    WORKSPACE_ID,
    INTERACTION_RUN_ID,
    INTERACTION_ID,
    JSON.stringify(request),
  );

  const bootGeneration = due.beginBoot({
    installationId: INSTALLATION_ID,
    bootId: "boot_authority_current",
    now: 50,
  });
  const enqueue = (
    kind: LocalTaskDueWork["kind"],
    entityId: string,
    expectedRevision?: number,
    expectedFence?: number,
  ) => due.enqueue({
    workspaceId: WORKSPACE_ID,
    kind,
    entityId,
    dueAt: 100,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    ...(expectedFence === undefined ? {} : { expectedFence }),
    now: 50,
  });
  enqueue("defer_wake", DEFER_TASK_ID, 3);
  enqueue("queued_run", QUEUED_RUN_ID, 4);
  enqueue("claim_expiry", CLAIM_ID, 9, 7);
  enqueue("run_recovery", RECOVERY_RUN_ID, 6, oldClaim.fence);
  enqueue("interaction_expiry", INTERACTION_ID, 7);
  enqueue("repair", "workspace", 1);
  const claimed = due.claimDue({
    bootGeneration,
    now: 100,
    limit: 10,
  });
  const work = new Map(claimed.map((item) => [item.kind, item]));
  if (work.size !== 6) throw new Error("Authority fixture did not claim every work kind");

  const callbacks: AuthorityFixture["callbacks"] = [];
  const port = new LocalTaskAuthorityCommandStore({
    database,
    tasks,
    onCommitted: (value) => callbacks.push(value),
  });
  const structuralPort: LocalTaskAuthorityCommandPort = port;
  if (structuralPort !== port) throw new Error("Structural port assignment changed identity");
  return { bootGeneration, callbacks, database, due, port, work };
}

function requiredWork(
  value: AuthorityFixture,
  kind: LocalTaskDueWork["kind"],
): LocalTaskDueWork {
  const work = value.work.get(kind);
  if (work === undefined) throw new Error(`Missing ${kind} work`);
  return work;
}

function prepare(
  value: AuthorityFixture,
  kind: LocalTaskDueWork["kind"],
  now = 100,
): Extract<LocalTaskAuthorityPreparation, { kind: "current" }> {
  const work = requiredWork(value, kind);
  const prepared = value.port.prepareDueWork({
    work,
    bootGeneration: value.bootGeneration,
    now,
    operationId: localDueWorkOperationId(work, value.bootGeneration),
  });
  if (prepared.kind !== "current") {
    throw new Error(`${kind} unexpectedly prepared stale authority`);
  }
  return prepared;
}

describe("SQLite local task authority command port", () => {
  test("prepares every entity-specific command without claiming a queued run", () => {
    const value = fixture();
    try {
      expect(prepare(value, "defer_wake").command).toMatchObject({
        kind: "defer.wake",
        taskId: DEFER_TASK_ID,
        expectedTaskRevision: 3,
        scheduledFor: 100,
      });
      expect(prepare(value, "queued_run").command).toBeNull();
      expect(prepare(value, "claim_expiry").command).toMatchObject({
        kind: "claim.expire",
        taskId: CLAIM_TASK_ID,
        claimId: CLAIM_ID,
        fence: 7,
        leaseGeneration: 9,
        expectedDeadline: 100,
      });
      expect(prepare(value, "run_recovery").command).toMatchObject({
        kind: "run.reconcile",
        runId: RECOVERY_RUN_ID,
        bootGeneration: value.bootGeneration,
      });
      expect(prepare(value, "interaction_expiry").command).toMatchObject({
        kind: "interaction.expire",
        runId: INTERACTION_RUN_ID,
        interactionId: INTERACTION_ID,
        expectedDeadline: 100,
      });
      expect(prepare(value, "repair").command).toMatchObject({
        kind: "workspace.repair",
        expectedWorkspaceRevision: 1,
      });
      expect(value.database.query(`
        SELECT state, fence, claimed_boot_generation
        FROM local_queued_run_intents WHERE run_id = ?1
      `).get(QUEUED_RUN_ID)).toEqual({
        state: "queued",
        fence: 1,
        claimed_boot_generation: null,
      });
    } finally {
      value.database.close();
    }
  });

  test("keeps the authority deadline stable across a delayed retry", () => {
    const value = fixture();
    try {
      const first = requiredWork(value, "queued_run");
      value.due.retry({
        id: first.id,
        bootGeneration: value.bootGeneration,
        workGeneration: first.workGeneration,
        nextDueAt: 200,
        errorCode: "executor_unavailable",
        now: 101,
      });
      expect(value.due.claimDue({
        bootGeneration: value.bootGeneration,
        now: 199,
        limit: 10,
      })).toHaveLength(0);
      const retried = value.due.claimDue({
        bootGeneration: value.bootGeneration,
        now: 200,
        limit: 10,
      }).find(({ kind }) => kind === "queued_run");
      if (retried === undefined) throw new Error("Queued retry was not claimed");
      expect(retried).toMatchObject({ dueAt: 100, attempt: 2 });
      expect(value.database.query(`
        SELECT due_at, not_before_at
        FROM local_due_work WHERE due_work_id = ?1
      `).get(first.id)).toEqual({ due_at: 100, not_before_at: 200 });
      expect(value.port.prepareDueWork({
        work: retried,
        bootGeneration: value.bootGeneration,
        now: 200,
        operationId: localDueWorkOperationId(
          retried,
          value.bootGeneration,
        ),
      })).toMatchObject({ kind: "current", command: null });
    } finally {
      value.database.close();
    }
  });

  test("commits all system commands with exact due settlement and one invalidation each", () => {
    const value = fixture();
    try {
      const prepared = new Map(
        ([
          "repair",
          "defer_wake",
          "claim_expiry",
          "run_recovery",
          "interaction_expiry",
        ] as const).map((kind) => [kind, prepare(value, kind)]),
      );
      for (const kind of [
        "repair",
        "defer_wake",
        "claim_expiry",
        "run_recovery",
        "interaction_expiry",
      ] as const) {
        const item = prepared.get(kind);
        if (item?.command === null || item?.command === undefined) {
          throw new Error(`Missing ${kind} command`);
        }
        expect(value.port.executeSystemCommand({
          work: requiredWork(value, kind),
          command: item.command,
          authority: item.authority,
          now: 100,
        })).toEqual({ kind: "committed", authority: item.authority });
      }

      expect(value.callbacks).toEqual([2, 3, 4, 5, 6].map(
        (projectionRevision) => ({ workspaceId: WORKSPACE_ID, projectionRevision }),
      ));
      expect(value.database.query<{ count: number }, []>(`
        SELECT count(*) AS count FROM local_due_work
        WHERE work_kind <> 'queued_run' AND state = 'done'
          AND claimed_boot_generation IS NULL AND claimed_at IS NULL
      `).get()?.count).toBe(5);
      expect(value.database.query(`
        SELECT status, revision FROM local_tasks WHERE task_id = ?1
      `).get(DEFER_TASK_ID)).toEqual({ status: "open", revision: 4 });
      expect(value.database.query(`
        SELECT status, revision FROM local_tasks WHERE task_id = ?1
      `).get(CLAIM_TASK_ID)).toEqual({ status: "open", revision: 6 });
      expect(value.database.query(`
        SELECT phase FROM local_task_runs WHERE run_id = ?1
      `).get(RECOVERY_RUN_ID)).toEqual({ phase: "ambiguous" });
      expect(value.database.query(`
        SELECT state FROM local_queued_run_intents WHERE run_id = ?1
      `).get(RECOVERY_RUN_ID)).toEqual({ state: "abandoned" });
      expect(value.database.query(`
        SELECT state FROM local_run_interactions WHERE interaction_id = ?1
      `).get(INTERACTION_ID)).toEqual({ state: "expired" });

      value.database.exec("DELETE FROM local_workspace_events");
      value.database.query(`
        UPDATE local_workspaces
          SET revision = 1, event_sequence = 0, updated_at = 100
          WHERE workspace_id = ?1
      `).run(WORKSPACE_ID);
      value.database.query(`
        UPDATE local_due_work
        SET state = 'claimed', claimed_boot_generation = ?2, claimed_at = 101
        WHERE due_work_id = ?1
      `).run(requiredWork(value, "repair").id, value.bootGeneration);
      const replayPreparation = prepare(value, "repair", 101);
      if (replayPreparation.command === null) {
        throw new Error("Missing replay preparation command");
      }
      expect(value.port.executeSystemCommand({
        work: requiredWork(value, "repair"),
        command: replayPreparation.command,
        authority: replayPreparation.authority,
        now: 101,
      })).toEqual({
        kind: "committed",
        authority: replayPreparation.authority,
      });
      expect(value.callbacks).toHaveLength(5);
    } finally {
      value.database.close();
    }
  });

  test("returns typed stale or retry authority without publishing invalidation", () => {
    const staleValue = fixture();
    try {
      const repair = prepare(staleValue, "repair");
      if (repair.command === null) throw new Error("Missing repair command");
      staleValue.database.query(`
        UPDATE local_workspaces SET revision = 2 WHERE workspace_id = ?1
      `).run(WORKSPACE_ID);
      expect(staleValue.port.executeSystemCommand({
        work: requiredWork(staleValue, "repair"),
        command: repair.command,
        authority: repair.authority,
        now: 100,
      })).toEqual({
        kind: "obsolete",
        authority: { kind: "stale", reason: "revision" },
      });
      expect(staleValue.callbacks).toHaveLength(0);
    } finally {
      staleValue.database.close();
    }

    const retryValue = fixture();
    try {
      const repair = prepare(retryValue, "repair");
      if (repair.command?.kind !== "workspace.repair") {
        throw new Error("Missing retry repair command");
      }
      expect(retryValue.port.executeSystemCommand({
        work: requiredWork(retryValue, "repair"),
        command: { ...repair.command, expectedWorkspaceRevision: 2 },
        authority: repair.authority,
        now: 100,
      })).toEqual({
        kind: "retry",
        authority: repair.authority,
        errorCode: "authority_command_mismatch",
      });
      expect(retryValue.callbacks).toHaveLength(0);
      expect(retryValue.database.query(`
        SELECT state FROM local_due_work WHERE due_work_id = ?1
      `).get(requiredWork(retryValue, "repair").id)).toEqual({ state: "claimed" });
    } finally {
      retryValue.database.close();
    }
  });
});
