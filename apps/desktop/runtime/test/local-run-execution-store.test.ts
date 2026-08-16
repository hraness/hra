import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createRunInteractionReplyKeyPair,
  taskWorkspaceViewValues,
  type PortableInvalidation,
  type PortableRunInteractionRequest,
  type PortableTaskCommand,
} from "@hraness/agent-tasks-protocol";

import { DispatchAccountReservationArbiter } from "../src/dispatch/account-reservations";
import { DispatchActivityAdapter } from "../src/dispatch/activity-adapter";
import { DispatchCoordinator } from "../src/dispatch/coordinator";
import { DispatchRevocationCoordinator } from "../src/dispatch/revocation";
import type { DispatchAccountSummary } from "../src/internal-contracts";
import { LocalTaskAuthorityCommandStore } from "../src/state/local-task-authority-command-store";
import { LocalDueWorkStore } from "../src/state/local-task-due-work-store";
import {
  LocalRunExecutionStore,
  type LocalRunTaskChange,
} from "../src/state/local-run-execution-store";
import { applyMigrations } from "../src/state/database";
import { LocalTaskStore } from "../src/state/local-task-store";
import { LocalRunCompletionAdapter } from "../src/tasks/local-run-completion-adapter";
import { LocalRunInteractionAdapter } from "../src/tasks/local-run-interaction-adapter";
import { LocalQueuedRunExecutor } from "../src/tasks/local-run-executor";
import { LocalTaskChangeCoordinator } from "../src/tasks/local-task-change-coordinator";
const installationId = "install_local_execution";
const bootId = "boot_local_execution";
const runnerId = "runner_local_execution";
const fingerprintKey = new Uint8Array(32).fill(0x51);
type InteractionResponseCommand = Extract<
  PortableTaskCommand,
  { readonly kind: "interaction.respond" }
>;

function executionAccount(): DispatchAccountSummary {
  return {
    id: "account_local_execution",
    revision: 1,
    label: "Local execution",
    selected: true,
    identityLabel: null,
    planLabel: null,
    usageRemainingPercent: 100,
    authState: "signedIn",
    login: { state: "idle" },
    usage: {
      state: "ready",
      updatedAt: new Date(20).toISOString(),
      tokens: { state: "unavailable" },
      limits: [{
        id: "five-hour",
        name: "Five hour",
        primary: {
          usedPercent: 0,
          windowDurationMinutes: 300,
          resetsAt: null,
        },
        secondary: null,
        individual: null,
        unlimited: false,
        reached: false,
      }],
    },
    runtime: { state: "stopped", generation: 1 },
  };
}

function publicId(prefix: string, value: number): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let remaining = value;
  let locator = "";
  for (let index = 0; index < 26; index += 1) {
    locator = (alphabet[remaining % 32] ?? "0") + locator;
    remaining = Math.floor(remaining / 32);
  }
  return `${prefix}_${locator}`;
}

function fixture(
  observeInvalidation?: (
    database: Database,
    input: LocalRunTaskChange,
  ) => void,
  onCapacityReleased?: (runId: string) => void,
) {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  const tasks = new LocalTaskStore(database, fingerprintKey);
  const workspaceId = publicId("wsp", 41);
  const repositoryId = publicId("repo", 41);
  const taskId = publicId("tsk", 41);
  tasks.registerInstallation(installationId, 1);
  tasks.onboardProject({
    installationId,
    repository: {
      repositoryId,
      name: "Execution repository",
      canonicalRepositoryPath: "/tmp/local-execution",
      canonicalGitCommonDir: "/tmp/local-execution/.git",
    },
    workspace: {
      workspaceId,
      name: "Execution workspace",
      slug: "execution-workspace",
      keyPrefix: "EX",
    },
  }, 2);
  const receipt = tasks.execute({
    kind: "task.create_and_run",
    operationId: publicId("op", 41),
    authority: {
      kind: "local_owner",
      workspaceId,
      installationId,
    },
    expectedWorkspaceRevision: 1,
    taskId,
    title: "Run local task",
    description: "Make the smallest safe change.",
    type: "task",
    priority: 2,
    availableAt: 0,
    labels: [],
    repositoryId,
  }, undefined, 10);
  if (receipt.outcome !== "committed" || receipt.result.kind !== "task_created") {
    throw new Error("Fixture task did not commit");
  }
  const runId = receipt.result.runId;
  if (runId === undefined) throw new Error("Fixture run was not created");
  const due = new LocalDueWorkStore(database);
  const bootGeneration = due.beginBoot({
    installationId,
    bootId,
    now: 20,
  });
  const work = due.claimDue({
    bootGeneration,
    now: 20,
    limit: 1,
    abandonedClaimAfterMs: 60_000,
  })[0];
  if (work === undefined || work.kind !== "queued_run") {
    throw new Error("Fixture queued work was not claimed");
  }
  const authorityStore = new LocalTaskAuthorityCommandStore({
    database,
    tasks,
  });
  const prepared = authorityStore.prepareDueWork({
    work,
    bootGeneration,
    now: 20,
    operationId: publicId("op", 42),
  });
  if (prepared.kind !== "current" || prepared.command !== null) {
    throw new Error("Fixture queued work was not current");
  }
  const invalidations: LocalRunTaskChange[] = [];
  const executions = new LocalRunExecutionStore({
    database,
    ...(onCapacityReleased === undefined ? {} : { onCapacityReleased }),
    onChanged: (value) => {
      invalidations.push(value);
      observeInvalidation?.(database, value);
    },
  });
  return {
    authority: prepared.authority,
    bootGeneration,
    database,
    due,
    executions,
    invalidations,
    repositoryId,
    runId,
    taskId,
    tasks,
    work,
    workspaceId,
  };
}

async function driveRunning(
  value: ReturnType<typeof fixture>,
): Promise<void> {
  const admitted = value.executions.admit({
    accountProfileId: "account_local_execution",
    authority: value.authority,
    baseSha: "b".repeat(40),
    bootGeneration: value.bootGeneration,
    now: 20,
    runtimeBootId: bootId,
    runtimePublicId: runnerId,
    work: value.work,
  });
  if (admitted.kind !== "admitted") throw new Error("Admission failed");
  const coordinator = new DispatchCoordinator({
    fence: value.executions,
    launcher: {
      ensureThread: () => Promise.resolve({
        kind: "ready",
        value: { threadId: "thread_local_execution" },
      }),
      ensureInitialTurn: () => Promise.resolve({
        kind: "ready",
        value: { turnId: "turn_local_execution" },
      }),
    },
    publication: value.executions,
    store: value.executions,
    workspaces: {
      resolveBase: () => Promise.reject(
        new Error("Admission already resolved the immutable base"),
      ),
      provision: (input) => Promise.resolve({
        baseSha: input.baseSha,
        branchName: `codex/oprte-${input.runId}`,
        canonicalGitCommonDir: "/tmp/local-execution/.git",
        checkoutPath: `/tmp/lanes/${input.runId}`,
        laneId: input.runId,
        recovered: false,
      }),
    },
  });
  const result = await coordinator.execute(admitted.admission.assignment);
  if (result.kind !== "running") throw new Error("Coordinator did not reach running");
}

async function prepareWaitingInteraction(
  value: ReturnType<typeof fixture>,
  suffix: string,
  beforePersistence?: () => void,
): Promise<Readonly<{
  command: InteractionResponseCommand;
  request: PortableRunInteractionRequest;
}>> {
  const activity = new DispatchActivityAdapter({
    fence: value.executions,
    store: value.executions,
  });
  await activity.observe({
    accountProfileId: "account_local_execution",
    threadId: "thread_local_execution",
    turnId: "turn_local_execution",
    kind: "waiting_for_input",
  });
  const request: PortableRunInteractionRequest = {
    id: `interaction_${suffix}`,
    kind: "user_input",
    createdAt: 100,
    expiresAt: 1_000,
    questions: [{
      id: `question_${suffix}`,
      header: "Direction",
      prompt: "How should the run continue?",
      allowOther: true,
      options: [],
    }],
  };
  beforePersistence?.();
  expect(value.executions.requestInteraction({
    accountProfileId: "account_local_execution",
    threadId: "thread_local_execution",
    turnId: "turn_local_execution",
    request,
  })).not.toBeNull();
  const workspaceRevision = value.database.query<{
    revision: number;
  }, [string]>(`
    SELECT revision FROM local_workspaces WHERE workspace_id = ?1
  `).get(value.workspaceId)?.revision;
  if (workspaceRevision === undefined) throw new Error("Workspace disappeared");
  const question = request.questions[0];
  if (question === undefined) throw new Error("Interaction question disappeared");
  return {
    request,
    command: {
      kind: "interaction.respond",
      operationId: publicId("op", suffix === "completion_pending" ? 81 : 82),
      authority: {
        kind: "local_owner",
        workspaceId: value.workspaceId,
        installationId,
      },
      expectedWorkspaceRevision: workspaceRevision,
      runId: value.runId,
      interactionId: request.id,
      request,
      response: {
        kind: "user_input",
        answers: [{
          questionId: question.id,
          selectedOptionIds: [],
          otherText: "Continue with the local run.",
        }],
      },
    },
  };
}

async function driveAmbiguous(
  value: ReturnType<typeof fixture>,
  suffix: string,
): Promise<void> {
  await driveRunning(value);
  value.executions.transition({
    runId: value.runId,
    to: "ambiguous",
    failureCode: `simulated_ambiguity_${suffix}`,
  });
  value.executions.appendPublicEvent({
    runId: value.runId,
    eventId: `${value.runId}:ambiguity:${suffix}`,
    kind: "run.lease_lost",
  });
}

function ambiguityResolutionCommand(
  value: ReturnType<typeof fixture>,
  operationValue: number,
): Extract<PortableTaskCommand, { kind: "dispatch.resolve_ambiguity" }> {
  const revisions = value.database.query<{
    task_revision: number;
    workspace_revision: number;
  }, [string]>(`
    SELECT task.revision AS task_revision,
      workspace.revision AS workspace_revision
    FROM local_tasks AS task
    JOIN local_workspaces AS workspace
      ON workspace.workspace_id = task.workspace_id
    WHERE task.task_id = ?1
  `).get(value.taskId);
  if (revisions === null) throw new Error("Ambiguous task disappeared");
  return {
    kind: "dispatch.resolve_ambiguity",
    operationId: publicId("op", operationValue),
    authority: {
      kind: "local_owner",
      workspaceId: value.workspaceId,
      installationId,
    },
    expectedWorkspaceRevision: revisions.workspace_revision,
    taskId: value.taskId,
    expectedTaskRevision: revisions.task_revision,
    sourceRunId: value.runId,
    reason: "confirmed_cancelled",
  };
}

describe("durable local run execution", () => {
  test("admits queued work with claim, binding, fence, and due settlement atomically", async () => {
    const value = fixture();
    try {
      const candidate = value.executions.launchCandidate(
        value.workspaceId,
        value.runId,
      );
      expect(candidate).toMatchObject({
        repositoryId: value.repositoryId,
        repositoryPath: "/tmp/local-execution",
        runId: value.runId,
        taskId: value.taskId,
      });
      const admitted = value.executions.admit({
        accountProfileId: "account_local_execution",
        authority: value.authority,
        baseSha: "a".repeat(40),
        bootGeneration: value.bootGeneration,
        now: 20,
        runtimeBootId: bootId,
        runtimePublicId: runnerId,
        work: value.work,
      });
      expect(admitted.kind).toBe("admitted");
      expect(value.database.query<{ state: string }, [string]>(`
        SELECT state FROM local_due_work WHERE due_work_id = ?1
      `).get(value.work.id)).toEqual({ state: "done" });
      expect(value.database.query<{
        phase: string;
        claim_id: string;
        fence: number;
        boot_generation: number;
      }, [string]>(`
        SELECT phase, claim_id, fence, boot_generation
        FROM local_task_runs WHERE run_id = ?1
      `).get(value.runId)).toMatchObject({
        phase: "leased",
        fence: 1,
        boot_generation: value.bootGeneration,
      });
      expect(value.executions.read(value.runId)).toMatchObject({
        accountProfileId: "account_local_execution",
        baseSha: "a".repeat(40),
        claimFence: 1,
        executionMode: "managed_worktree",
        stage: "reserved",
      });
      expect(await value.executions.assertCurrent(
        admitted.kind === "admitted"
          ? admitted.admission.assignment
          : {
              claimFence: 1,
              claimId: "claim_unreachable",
              runId: value.runId,
              runtimeBootId: bootId,
              runtimePublicId: runnerId,
            },
      )).toBeTrue();
      value.due.closeBoot({
        bootGeneration: value.bootGeneration,
        now: 21,
        reason: "clean",
      });
      expect(await value.executions.assertCurrent(
        admitted.kind === "admitted"
          ? admitted.admission.assignment
          : {
              claimFence: 1,
              claimId: "claim_unreachable",
              runId: value.runId,
              runtimeBootId: bootId,
              runtimePublicId: runnerId,
            },
      )).toBeFalse();
      expect(value.invalidations).toEqual([{
        affectedProjections: [{
          projection: "workspace_summary",
        }, {
          projection: "task_list",
          views: [...taskWorkspaceViewValues],
        }, {
          projection: "task_detail",
        }],
        changeKind: "run.admitted",
        projectionRevision: 3,
        runId: value.runId,
        scope: "task_change",
        taskId: value.taskId,
        workspaceId: value.workspaceId,
      }]);
    } finally {
      value.database.close();
    }
  });

  test("does not misreport durable admission when invalidation publication is backpressured", () => {
    let publicationBlocked = true;
    let publicationAttempts = 0;
    const published: PortableInvalidation[] = [];
    const changes = new LocalTaskChangeCoordinator({
      cancel: () => undefined,
      onChange: (change) => {
        publicationAttempts += 1;
        if (publicationBlocked) throw new Error("snapshot barrier is active");
        published.push(change);
      },
      schedule: () => 1,
    });
    const value = fixture((_database, change) => changes.accept(change));
    try {
      const admitted = value.executions.admit({
        accountProfileId: "account_local_execution",
        authority: value.authority,
        baseSha: "a".repeat(40),
        bootGeneration: value.bootGeneration,
        now: 20,
        runtimeBootId: bootId,
        runtimePublicId: runnerId,
        work: value.work,
      });

      expect(admitted.kind).toBe("admitted");
      expect(publicationAttempts).toBe(1);
      expect(value.database.query<{ state: string }, [string]>(`
        SELECT state FROM local_due_work WHERE due_work_id = ?1
      `).get(value.work.id)).toEqual({ state: "done" });
      expect(value.executions.read(value.runId)).toMatchObject({
        baseSha: "a".repeat(40),
        stage: "reserved",
      });

      publicationBlocked = false;
      changes.flush();
      expect(publicationAttempts).toBe(2);
      expect(published).toHaveLength(1);
      expect(published[0]).toMatchObject({
        changeKind: "run.admitted",
        projectionRevision: 3,
        scope: "task_change",
      });
      changes.close();
    } finally {
      value.database.close();
    }
  });

  test("drives coordinator to a durable owned turn and public running phase", async () => {
    const value = fixture();
    try {
      await driveRunning(value);
      expect(value.executions.read(value.runId)).toMatchObject({
        stage: "running",
        threadId: "thread_local_execution",
        turnId: "turn_local_execution",
      });
      expect(value.database.query<{ phase: string }, [string]>(`
        SELECT phase FROM local_task_runs WHERE run_id = ?1
      `).get(value.runId)).toEqual({ phase: "running" });
      expect(value.executions.latestPublicEvent(value.runId)?.kind)
        .toBe("codex.running");
    } finally {
      value.database.close();
    }
  });

  test.each([
    ["lease-lost result", false],
    ["coordinator exception", true],
  ] as const)("releases account capacity after a %s", async (_label, rejects) => {
    const value = fixture();
    try {
      const accounts = new DispatchAccountReservationArbiter({
        accounts: { dispatchAccounts: () => [executionAccount()] },
        now: () => 20,
      });
      const executor = new LocalQueuedRunExecutor({
        accounts,
        coordinator: {
          execute: (assignment) => {
            if (rejects) {
              return Promise.reject(
                new Error("simulated coordinator failure"),
              );
            }
            value.executions.transition({
              runId: assignment.runId,
              to: "lease_lost",
            });
            value.executions.appendPublicEvent({
              runId: assignment.runId,
              eventId: `${assignment.runId}:simulated-lease-lost`,
              kind: "run.lease_lost",
            });
            const binding = value.executions.read(assignment.runId);
            if (binding === null) throw new Error("Binding disappeared");
            return Promise.resolve({ kind: "lease_lost" as const, binding });
          },
        },
        runtimeBootId: bootId,
        runtimePublicId: runnerId,
        store: value.executions,
        workspaces: {
          inspectRepository: () => Promise.resolve({
            canonicalRepositoryPath: "/tmp/local-execution",
            canonicalGitCommonDir: "/tmp/local-execution/.git",
          }),
          resolveBase: () => Promise.resolve("e".repeat(40)),
        },
      });
      expect(await executor.start({
        authority: value.authority,
        context: {
          bootGeneration: value.bootGeneration,
          wakeReason: "startup",
          wallNow: 20,
        },
        work: value.work,
      })).toMatchObject({ outcome: "settled" });
      await executor.settled();
      expect(value.executions.read(value.runId)?.stage).toBe("lease_lost");
      expect(value.executions.capacityReservations()).toEqual([]);
      expect(accounts.currentSnapshot()).toMatchObject({
        activeRuns: 0,
        availableCapacity: 1,
        state: "ready",
      });
    } finally {
      value.database.close();
    }
  });

  test("aborts an admitted launch before waiting for shutdown settlement", async () => {
    const value = fixture();
    try {
      const accounts = new DispatchAccountReservationArbiter({
        accounts: { dispatchAccounts: () => [executionAccount()] },
        now: () => 20,
      });
      let observedSignal: AbortSignal | undefined;
      const executor = new LocalQueuedRunExecutor({
        accounts,
        coordinator: {
          execute: (assignment, signal) => {
            observedSignal = signal;
            return new Promise((resolve) => {
              const settle = (): void => {
                value.executions.transition({
                  runId: assignment.runId,
                  to: "lease_lost",
                });
                value.executions.appendPublicEvent({
                  runId: assignment.runId,
                  eventId: `${assignment.runId}:shutdown-lease-lost`,
                  kind: "run.lease_lost",
                });
                const binding = value.executions.read(assignment.runId);
                if (binding === null) throw new Error("Binding disappeared");
                resolve({ kind: "lease_lost", binding });
              };
              signal?.addEventListener("abort", settle, { once: true });
              if (signal?.aborted === true) settle();
            });
          },
        },
        runtimeBootId: bootId,
        runtimePublicId: runnerId,
        store: value.executions,
        workspaces: {
          inspectRepository: () => Promise.resolve({
            canonicalRepositoryPath: "/tmp/local-execution",
            canonicalGitCommonDir: "/tmp/local-execution/.git",
          }),
          resolveBase: () => Promise.resolve("e".repeat(40)),
        },
      });
      expect(await executor.start({
        authority: value.authority,
        context: {
          bootGeneration: value.bootGeneration,
          wakeReason: "startup",
          wallNow: 20,
        },
        work: value.work,
      })).toMatchObject({ outcome: "settled" });

      await executor.stop();

      expect(observedSignal?.aborted).toBeTrue();
      expect(value.executions.read(value.runId)?.stage).toBe("lease_lost");
      expect(value.executions.capacityReservations()).toEqual([]);
    } finally {
      value.database.close();
    }
  });

  test("cannot admit a launch that was inspecting Git when shutdown began", async () => {
    const value = fixture();
    try {
      const accounts = new DispatchAccountReservationArbiter({
        accounts: { dispatchAccounts: () => [executionAccount()] },
        now: () => 20,
      });
      let releaseInspection: (() => void) | undefined;
      const inspectionBlocked = new Promise<void>((resolve) => {
        releaseInspection = resolve;
      });
      let inspectionStarted: (() => void) | undefined;
      const sawInspection = new Promise<void>((resolve) => {
        inspectionStarted = resolve;
      });
      let executed = false;
      const executor = new LocalQueuedRunExecutor({
        accounts,
        coordinator: {
          execute: () => {
            executed = true;
            throw new Error("A stopping executor must not admit execution");
          },
        },
        runtimeBootId: bootId,
        runtimePublicId: runnerId,
        store: value.executions,
        workspaces: {
          inspectRepository: async () => {
            inspectionStarted?.();
            await inspectionBlocked;
            return {
              canonicalRepositoryPath: "/tmp/local-execution",
              canonicalGitCommonDir: "/tmp/local-execution/.git",
            };
          },
          resolveBase: () => Promise.resolve("e".repeat(40)),
        },
      });
      const starting = executor.start({
        authority: value.authority,
        context: {
          bootGeneration: value.bootGeneration,
          wakeReason: "startup",
          wallNow: 20,
        },
        work: value.work,
      });
      await sawInspection;

      await executor.stop();
      releaseInspection?.();

      expect(await starting).toEqual({
        outcome: "obsolete",
        authority: { kind: "stale", reason: "boot" },
      });
      expect(executed).toBeFalse();
      expect(value.executions.read(value.runId)).toBeNull();
      expect(accounts.currentSnapshot()).toMatchObject({
        activeRuns: 0,
        availableCapacity: 1,
      });
    } finally {
      value.database.close();
    }
  });

  test("retains both durable and process-wide capacity when execution throws after ambiguity", async () => {
    const value = fixture();
    try {
      const accounts = new DispatchAccountReservationArbiter({
        accounts: { dispatchAccounts: () => [executionAccount()] },
        now: () => 20,
      });
      const executor = new LocalQueuedRunExecutor({
        accounts,
        coordinator: {
          execute: (assignment) => {
            value.executions.transition({
              runId: assignment.runId,
              to: "ambiguous",
              failureCode: "simulated_post_transition_failure",
            });
            value.executions.appendPublicEvent({
              runId: assignment.runId,
              eventId: `${assignment.runId}:simulated-ambiguous`,
              kind: "run.lease_lost",
            });
            return Promise.reject(
              new Error("simulated failure after ambiguous transition"),
            );
          },
        },
        runtimeBootId: bootId,
        runtimePublicId: runnerId,
        store: value.executions,
        workspaces: {
          inspectRepository: () => Promise.resolve({
            canonicalRepositoryPath: "/tmp/local-execution",
            canonicalGitCommonDir: "/tmp/local-execution/.git",
          }),
          resolveBase: () => Promise.resolve("e".repeat(40)),
        },
      });

      expect(await executor.start({
        authority: value.authority,
        context: {
          bootGeneration: value.bootGeneration,
          wakeReason: "startup",
          wallNow: 20,
        },
        work: value.work,
      })).toMatchObject({ outcome: "settled" });
      await executor.settled();

      expect(value.executions.read(value.runId)).toMatchObject({
        stage: "ambiguous",
        failureCode: "simulated_post_transition_failure",
      });
      expect(value.executions.capacityReservations()).toEqual([{
        accountProfileId: "account_local_execution",
        runId: value.runId,
      }]);
      expect(accounts.currentSnapshot()).toMatchObject({
        activeRuns: 1,
        availableCapacity: 0,
        retainedRunIds: [value.runId],
        state: "capacity_full",
      });
    } finally {
      value.database.close();
    }
  });

  test("rejects a changed registered repository identity before execution", async () => {
    const value = fixture();
    try {
      const accounts = new DispatchAccountReservationArbiter({
        accounts: { dispatchAccounts: () => [executionAccount()] },
        now: () => 20,
      });
      let executed = false;
      const executor = new LocalQueuedRunExecutor({
        accounts,
        coordinator: {
          execute: () => {
            executed = true;
            throw new Error("Coordinator must not receive an untrusted repository");
          },
        },
        runtimeBootId: bootId,
        runtimePublicId: runnerId,
        store: value.executions,
        workspaces: {
          inspectRepository: () => Promise.resolve({
            canonicalRepositoryPath: "/tmp/local-execution",
            canonicalGitCommonDir: "/tmp/replaced-repository/.git",
          }),
          resolveBase: () => {
            throw new Error("Base resolution must not run after identity drift");
          },
        },
      });
      expect(await executor.start({
        authority: value.authority,
        context: {
          bootGeneration: value.bootGeneration,
          wakeReason: "startup",
          wallNow: 20,
        },
        work: value.work,
      })).toMatchObject({
        outcome: "retry",
        errorCode: "repository_unavailable",
      });
      expect(executed).toBeFalse();
      expect(value.executions.read(value.runId)).toBeNull();
      expect(accounts.currentSnapshot()).toMatchObject({
        activeRuns: 0,
        availableCapacity: 1,
      });
    } finally {
      value.database.close();
    }
  });

  test("rejects managed-lane binding against a different repository identity", () => {
    const value = fixture();
    try {
      const admitted = value.executions.admit({
        accountProfileId: "account_local_execution",
        authority: value.authority,
        baseSha: "f".repeat(40),
        bootGeneration: value.bootGeneration,
        now: 20,
        runtimeBootId: bootId,
        runtimePublicId: runnerId,
        work: value.work,
      });
      if (admitted.kind !== "admitted") throw new Error("Admission failed");
      expect(() => value.executions.bindWorkspaceLane({
        baseSha: "f".repeat(40),
        branchName: `codex/oprte-${value.runId}`,
        canonicalCheckoutPath: `/tmp/lanes/${value.runId}`,
        canonicalGitCommonDir: "/tmp/replaced-repository/.git",
        canonicalRepositoryPath: "/tmp/local-execution",
        laneId: value.runId,
        recoveryManifestPath: `/tmp/lanes/.oprte-manifests/${value.runId}.json`,
        runId: value.runId,
      })).toThrow("Local repository identity conflicts");
      expect(value.database.query<{
        lane_id: string | null;
        canonical_git_common_dir: string | null;
      }, [string]>(`
        SELECT lane_id, canonical_git_common_dir
        FROM local_run_execution_bindings WHERE run_id = ?1
      `).get(value.runId)).toEqual({
        lane_id: null,
        canonical_git_common_dir: null,
      });
    } finally {
      value.database.close();
    }
  });

  test("authorizes branch recovery only from a complete preexisting local lane binding", () => {
    const value = fixture();
    try {
      const admitted = value.executions.admit({
        accountProfileId: "account_local_execution",
        authority: value.authority,
        baseSha: "f".repeat(40),
        bootGeneration: value.bootGeneration,
        now: 20,
        runtimeBootId: bootId,
        runtimePublicId: runnerId,
        work: value.work,
      });
      if (admitted.kind !== "admitted") throw new Error("Admission failed");
      const identity = {
        baseSha: "f".repeat(40),
        branchName: `codex/oprte-${value.runId}`,
        canonicalCheckoutPath: `/tmp/lanes/${value.runId}`,
        canonicalGitCommonDir: "/tmp/local-execution/.git",
        canonicalRepositoryPath: "/tmp/local-execution",
        laneId: value.runId,
        recoveryManifestPath: `/tmp/lanes/.oprte-manifests/${value.runId}.json`,
        runId: value.runId,
      } as const;

      expect(value.executions.authorizeWorkspaceLaneRecovery(identity)).toBeNull();
      expect(value.executions.bindWorkspaceLane(identity)).toEqual(identity);
      expect(value.executions.authorizeWorkspaceLaneRecovery(identity)).toEqual(identity);
      expect(value.executions.authorizeWorkspaceLaneRecovery({
        ...identity,
        canonicalCheckoutPath: "/tmp/lanes/foreign",
      })).toEqual(identity);

      value.database.query(`
        UPDATE local_run_execution_bindings
        SET recovery_manifest_path = NULL
        WHERE run_id = ?1
      `).run(value.runId);
      expect(value.executions.authorizeWorkspaceLaneRecovery(identity)).toBeNull();
    } finally {
      value.database.close();
    }
  });

  test.each([
    [
      "failed" as const,
      "failed" as const,
      "run.failed" as const,
    ],
    [
      "interrupted" as const,
      "cancelled" as const,
      "run.cancelled" as const,
    ],
  ])("retains a %s lifecycle callback when HITL persists during its fence check", async (
    lifecycleStatus,
    terminalStage,
    terminalEvent,
  ) => {
    const value = fixture();
    try {
      await driveRunning(value);
      const accounts = new DispatchAccountReservationArbiter({
        accounts: { dispatchAccounts: () => [executionAccount()] },
        now: () => 200,
        recoveredReservations: [{
          accountProfileId: "account_local_execution",
          runId: value.runId,
        }],
      });
      const completion = new LocalRunCompletionAdapter({
        accounts,
        store: value.executions,
      });
      const interaction = await prepareWaitingInteraction(
        value,
        `lifecycle_first_${lifecycleStatus}`,
        () => completion.observe({
          accountProfileId: "account_local_execution",
          threadId: "thread_local_execution",
          turnId: "turn_local_execution",
          status: lifecycleStatus,
        }),
      );
      await completion.settled();

      expect(value.executions.read(value.runId)?.stage).toBe("waiting");
      expect(value.executions.interactionAuthority(interaction.request.id)?.state)
        .toBe("pending");
      expect(accounts.currentSnapshot()).toMatchObject({
        activeRuns: 1,
        retainedRunIds: [value.runId],
        state: "capacity_full",
      });

      expect(value.executions.expireInteraction(interaction.request.id, 200))
        .toMatchObject({ state: "expired" });
      completion.retryPending();
      await completion.settled();
      expect(value.executions.read(value.runId)?.stage).toBe(terminalStage);
      expect(value.executions.latestPublicEvent(value.runId)?.kind)
        .toBe(terminalEvent);
      expect(accounts.currentSnapshot()).toMatchObject({
        activeRuns: 0,
        availableCapacity: 1,
        retainedRunIds: [],
        state: "ready",
      });
    } finally {
      value.database.close();
    }
  });

  test.each([
    ["stale completion fence", "stale" as const, "local_completion_fence_stale"],
    [
      "corrupted completion input",
      "corrupt" as const,
      "local_completion_submission_rejected",
    ],
  ])("settles a %s without retaining its account lane", async (
    _label,
    mode,
    failureCode,
  ) => {
    const value = fixture();
    try {
      await driveRunning(value);
      const accounts = new DispatchAccountReservationArbiter({
        accounts: { dispatchAccounts: () => [executionAccount()] },
        now: () => 20,
        recoveredReservations: [{
          accountProfileId: "account_local_execution",
          runId: value.runId,
        }],
      });
      if (mode === "stale") {
        value.due.beginBoot({
          installationId,
          bootId: "boot_local_completion_restart",
          now: 100,
        });
      } else {
        value.database.query(`
          UPDATE local_tasks SET review_revision = review_revision + 1
          WHERE task_id = ?1
        `).run(value.taskId);
      }
      const completion = new LocalRunCompletionAdapter({
        accounts,
        store: value.executions,
      });
      completion.observe({
        accountProfileId: "account_local_execution",
        threadId: "thread_local_execution",
        turnId: "turn_local_execution",
        status: "completed",
      });
      await completion.settled();
      expect(value.executions.read(value.runId)).toMatchObject({
        stage: "lease_lost",
        failureCode,
      });
      expect(value.executions.latestPublicEvent(value.runId)?.kind)
        .toBe("run.lease_lost");
      expect(value.executions.capacityReservations()).toEqual([]);
      expect(accounts.currentSnapshot()).toMatchObject({
        activeRuns: 0,
        availableCapacity: 1,
        state: "ready",
      });
    } finally {
      value.database.close();
    }
  });

  test.each([
    ["pending" as const, "stale_fence_pending"],
    ["answered" as const, "stale_fence_answered"],
  ])("checks a stale completion fence without releasing a %s HITL lane", async (
    interactionState,
    suffix,
  ) => {
    const value = fixture();
    try {
      await driveRunning(value);
      const interaction = await prepareWaitingInteraction(value, suffix);
      if (interactionState === "answered") {
        expect(value.tasks.executeWithDisposition(
          interaction.command,
          undefined,
          200,
        )).toMatchObject({
          replayed: false,
          receipt: { outcome: "committed" },
        });
      }
      const accounts = new DispatchAccountReservationArbiter({
        accounts: { dispatchAccounts: () => [executionAccount()] },
        now: () => 200,
        recoveredReservations: [{
          accountProfileId: "account_local_execution",
          runId: value.runId,
        }],
      });
      value.due.beginBoot({
        installationId,
        bootId: `boot_${suffix}`,
        now: 200,
      });
      const completion = new LocalRunCompletionAdapter({
        accounts,
        store: value.executions,
      });
      completion.observe({
        accountProfileId: "account_local_execution",
        threadId: "thread_local_execution",
        turnId: "turn_local_execution",
        status: "failed",
      });
      await completion.settled();

      expect(value.executions.read(value.runId)?.stage).toBe("waiting");
      expect(value.executions.interactionAuthority(interaction.request.id)?.state)
        .toBe(interactionState);
      expect(accounts.currentSnapshot()).toMatchObject({
        activeRuns: 1,
        retainedRunIds: [value.runId],
        state: "capacity_full",
      });

      if (interactionState === "pending") {
        expect(value.executions.expireInteraction(interaction.request.id, 201))
          .toMatchObject({ state: "expired" });
        completion.retryPending();
        await completion.settled();
        expect(value.executions.read(value.runId)).toMatchObject({
          stage: "lease_lost",
          failureCode: "local_completion_fence_stale",
        });
        expect(value.executions.capacityReservations()).toEqual([]);
        expect(accounts.currentSnapshot()).toMatchObject({
          activeRuns: 0,
          availableCapacity: 1,
          retainedRunIds: [],
          state: "ready",
        });
      } else {
        expect(value.executions.recoverAnsweredInteractionsOnRestart())
          .toEqual([value.runId]);
        completion.retryPending();
        await completion.settled();
        expect(value.executions.read(value.runId)?.stage).toBe("ambiguous");
        expect(value.executions.capacityReservations()).toEqual([{
          accountProfileId: "account_local_execution",
          runId: value.runId,
        }]);
        expect(accounts.currentSnapshot()).toMatchObject({
          activeRuns: 1,
          retainedRunIds: [value.runId],
          state: "capacity_full",
        });
      }
    } finally {
      value.database.close();
    }
  });

  test("invalidates every novel same-phase event and exact replay does not", async () => {
    const value = fixture();
    try {
      await driveRunning(value);
      const before = value.invalidations.length;
      const event = {
        runId: value.runId,
        eventId: `${value.runId}:planning`,
        kind: "codex.planning" as const,
      };
      value.executions.appendPublicEvent(event);
      expect(value.invalidations.length).toBe(before + 1);
      expect(value.invalidations.at(-1)).toMatchObject({
        changeKind: "run.event_appended",
        runId: value.runId,
        scope: "task_change",
        taskId: value.taskId,
      });
      const change = value.invalidations.at(-1);
      expect(change?.affectedProjections.some(
        ({ projection }) => projection === "workspace_summary",
      )).toBeFalse();
      const revision = value.database.query<{ revision: number }, [string]>(`
        SELECT revision FROM local_workspaces WHERE workspace_id = ?1
      `).get(value.workspaceId)?.revision;
      value.executions.appendPublicEvent(event);
      expect(value.invalidations.length).toBe(before + 1);
      expect(value.database.query<{ revision: number }, [string]>(`
        SELECT revision FROM local_workspaces WHERE workspace_id = ?1
      `).get(value.workspaceId)?.revision).toBe(revision);
    } finally {
      value.database.close();
    }
  });

  test("publishes a phase-changing first text event immediately and later text as display-only", () => {
    const value = fixture();
    try {
      const admitted = value.executions.admit({
        accountProfileId: "account_local_execution",
        authority: value.authority,
        baseSha: "b".repeat(40),
        bootGeneration: value.bootGeneration,
        now: 20,
        runtimeBootId: bootId,
        runtimePublicId: runnerId,
        work: value.work,
      });
      if (admitted.kind !== "admitted") throw new Error("Admission failed");

      value.executions.appendDisplayDelta({
        runId: value.runId,
        kind: "codex.assistant_message.delta",
        displayText: "First running projection.",
      });
      expect(value.invalidations.at(-1)).toMatchObject({
        changeKind: "run.event_appended",
      });
      expect(value.database.query<{ phase: string }, [string]>(`
        SELECT phase FROM local_task_runs WHERE run_id = ?1
      `).get(value.runId)).toEqual({ phase: "running" });

      value.executions.appendDisplayDelta({
        runId: value.runId,
        kind: "codex.assistant_message.delta",
        displayText: "Same running projection.",
      });
      expect(value.invalidations.at(-1)).toMatchObject({
        changeKind: "run.display_changed",
      });
    } finally {
      value.database.close();
    }
  });

  test("publishes cancel-requested state in the same transaction as its phase transition", async () => {
    const value = fixture();
    try {
      await driveRunning(value);
      const beforeRevision = value.database.query<{
        revision: number;
      }, [string]>(`
        SELECT revision FROM local_workspaces WHERE workspace_id = ?1
      `).get(value.workspaceId)?.revision;
      const beforeInvalidations = value.invalidations.length;

      value.executions.transition({
        runId: value.runId,
        to: "cancelled",
      });

      expect(value.database.query<{
        desired_state: string;
        phase: string;
      }, [string]>(`
        SELECT desired_state, phase FROM local_task_runs WHERE run_id = ?1
      `).get(value.runId)).toEqual({
        desired_state: "stop",
        phase: "cancel_requested",
      });
      expect(value.invalidations).toHaveLength(beforeInvalidations + 1);
      expect(value.invalidations.at(-1)).toMatchObject({
        changeKind: "run.phase_changed",
        projectionRevision: (beforeRevision ?? 0) + 1,
        runId: value.runId,
        taskId: value.taskId,
      });
    } finally {
      value.database.close();
    }
  });

  test("publishes interaction expiry committed by human ambiguity resolution", async () => {
    const value = fixture();
    try {
      await driveRunning(value);
      const interaction = await prepareWaitingInteraction(
        value,
        "human_resolution_projection",
      );
      value.executions.transition({
        runId: value.runId,
        to: "lease_lost",
        failureCode: "human_resolution_projection",
      });
      value.executions.appendPublicEvent({
        runId: value.runId,
        eventId: `${value.runId}:human-resolution-ambiguity`,
        kind: "run.lease_lost",
      });
      expect(value.tasks.execute(
        ambiguityResolutionCommand(value, 104),
        undefined,
        300,
      )).toMatchObject({
        outcome: "committed",
        result: { kind: "run_updated", phase: "cancelled" },
      });
      const beforeInvalidations = value.invalidations.length;

      expect(value.executions.markHumanResolved(value.runId, 301)).toBeTrue();

      expect(value.executions.interactionAuthority(interaction.request.id)?.state)
        .toBe("expired");
      expect(value.invalidations).toHaveLength(beforeInvalidations + 1);
      expect(value.invalidations.at(-1)).toMatchObject({
        changeKind: "run.interaction_changed",
        runId: value.runId,
        taskId: value.taskId,
      });
    } finally {
      value.database.close();
    }
  });

  test("marks failed and cancelled terminal task-count changes as summary-affecting", async () => {
    for (const terminal of [
      { stage: "failed" as const, kind: "run.failed" as const },
      { stage: "cancelled" as const, kind: "run.cancelled" as const },
    ]) {
      const value = fixture();
      try {
        await driveRunning(value);
        value.executions.transition({
          runId: value.runId,
          to: terminal.stage,
        });
        value.executions.appendPublicEvent({
          runId: value.runId,
          eventId: `${value.runId}:${terminal.stage}:summary`,
          kind: terminal.kind,
        });

        const change = value.invalidations.at(-1);
        expect(change).toMatchObject({
          changeKind: "run.event_appended",
        });
        expect(change?.affectedProjections.some(
          ({ projection }) => projection === "workspace_summary",
        )).toBeTrue();
      } finally {
        value.database.close();
      }
    }
  });

  test("publishes bounded provider text and projection revision atomically", async () => {
    const observed: (string | null)[] = [];
    const value = fixture((database) => {
      observed.push(database.query<{ display_text: string | null }, []>(`
        SELECT display_text FROM local_run_public_events
        ORDER BY observed_at DESC, sequence DESC LIMIT 1
      `).get()?.display_text ?? null);
    });
    try {
      await driveRunning(value);
      observed.length = 0;
      expect(value.executions.appendDisplayDelta({
        runId: value.runId,
        kind: "codex.assistant_message.delta",
        displayText: "Finished the focused implementation.",
      })).toBeGreaterThan(0);
      expect(observed).toEqual(["Finished the focused implementation."]);
      expect(value.invalidations.at(-1)).toMatchObject({
        changeKind: "run.display_changed",
        runId: value.runId,
        scope: "task_change",
        taskId: value.taskId,
      });
      expect(value.executions.latestPublicEvent(value.runId)).toMatchObject({
        kind: "codex.assistant_message.delta",
        summary: "Responding",
        displayText: "Finished the focused implementation.",
      });
    } finally {
      value.database.close();
    }
  });

  test("ambiguous execution retains its active proof past the old lease deadline", () => {
    const value = fixture();
    try {
      const admitted = value.executions.admit({
        accountProfileId: "account_local_execution",
        authority: value.authority,
        baseSha: "d".repeat(40),
        bootGeneration: value.bootGeneration,
        now: 20,
        runtimeBootId: bootId,
        runtimePublicId: runnerId,
        work: value.work,
      });
      if (admitted.kind !== "admitted") throw new Error("Admission failed");
      value.executions.transition({ runId: value.runId, to: "lease_lost" });
      value.executions.appendPublicEvent({
        runId: value.runId,
        eventId: `${value.runId}:lease-lost`,
        kind: "run.lease_lost",
      });
      expect(value.database.query<{ phase: string }, [string]>(`
        SELECT phase FROM local_task_runs WHERE run_id = ?1
      `).get(value.runId)).toEqual({ phase: "ambiguous" });
      expect(value.database.query<{ state: string }, []>(`
        SELECT state FROM local_task_claims
      `).get()).toEqual({ state: "active" });
      expect(value.database.query<{ state: string }, []>(`
        SELECT state FROM local_due_work WHERE work_kind = 'claim_expiry'
      `).get()).toEqual({ state: "cancelled" });
      expect(value.executions.capacityReservations()).toEqual([{
        accountProfileId: "account_local_execution",
        runId: value.runId,
      }]);
      const restartedGeneration = value.due.beginBoot({
        installationId,
        bootId: "boot_local_execution_restart",
        now: 120_000,
      });
      expect(value.due.claimDue({
        bootGeneration: restartedGeneration,
        now: 120_000,
        limit: 32,
        abandonedClaimAfterMs: 60_000,
      }).some(({ kind }) => kind === "claim_expiry")).toBeFalse();
      expect(value.database.query<{ status: string }, [string]>(`
        SELECT status FROM local_tasks WHERE task_id = ?1
      `).get(value.taskId)).toEqual({ status: "in_progress" });
    } finally {
      value.database.close();
    }
  });

  test("heals human-resolved ambiguous capacity on startup and exact command replay only", async () => {
    const startup = fixture();
    const replay = fixture();
    const unresolved = fixture();
    try {
      await driveAmbiguous(startup, "startup_crash");
      const startupCommand = ambiguityResolutionCommand(startup, 92);
      expect(startup.tasks.executeWithDisposition(
        startupCommand,
        undefined,
        80_000,
      )).toMatchObject({
        replayed: false,
        receipt: { outcome: "committed" },
      });
      expect(startup.executions.read(startup.runId)?.stage).toBe("ambiguous");
      expect(startup.executions.capacityReservations()).toEqual([{
        accountProfileId: "account_local_execution",
        runId: startup.runId,
      }]);
      expect(startup.database.query<{
        claim_state: string;
        phase: string;
        recovery_state: string;
      }, [string]>(`
        SELECT claim.state AS claim_state, run.phase, run.recovery_state
        FROM local_task_runs AS run
        JOIN local_task_claims AS claim
          ON claim.workspace_id = run.workspace_id AND claim.claim_id = run.claim_id
        WHERE run.run_id = ?1
      `).get(startup.runId)).toEqual({
        claim_state: "released",
        phase: "cancelled",
        recovery_state: "recovered",
      });
      const restarted = new LocalRunExecutionStore({
        database: startup.database,
      });
      expect(restarted.reconcileRetainedTerminalCapacityOnRestart(80_001))
        .toEqual([startup.runId]);
      expect(restarted.capacityReservations()).toEqual([]);
      expect(new DispatchAccountReservationArbiter({
        accounts: { dispatchAccounts: () => [executionAccount()] },
        now: () => 80_001,
        recoveredReservations: restarted.capacityReservations(),
      }).currentSnapshot()).toMatchObject({
        activeRuns: 0,
        availableCapacity: 1,
        state: "ready",
      });

      await driveAmbiguous(replay, "receipt_replay");
      const replayCommand = ambiguityResolutionCommand(replay, 93);
      expect(replay.tasks.executeWithDisposition(
        replayCommand,
        undefined,
        81_000,
      )).toMatchObject({
        replayed: false,
        receipt: { outcome: "committed" },
      });
      const replayAccounts = new DispatchAccountReservationArbiter({
        accounts: { dispatchAccounts: () => [executionAccount()] },
        now: () => 81_001,
        recoveredReservations: replay.executions.capacityReservations(),
      });
      const exactReplay = replay.tasks.executeWithDisposition(
        replayCommand,
        undefined,
        81_001,
      );
      expect(exactReplay).toMatchObject({
        replayed: true,
        receipt: { outcome: "committed" },
      });
      if (
        exactReplay.receipt.outcome === "committed"
        && replay.executions.markHumanResolved(replay.runId, 81_001)
      ) {
        replayAccounts.releaseRun(replay.runId);
      }
      expect(replay.executions.capacityReservations()).toEqual([]);
      expect(replayAccounts.currentSnapshot()).toMatchObject({
        activeRuns: 0,
        availableCapacity: 1,
        state: "ready",
      });

      await driveAmbiguous(unresolved, "raw_unrecovered");
      const unresolvedRestart = new LocalRunExecutionStore({
        database: unresolved.database,
      });
      expect(unresolvedRestart.reconcileRetainedTerminalCapacityOnRestart(
        82_000,
      )).toEqual([]);
      expect(unresolvedRestart.markHumanResolved(unresolved.runId, 82_000))
        .toBeFalse();
      expect(unresolvedRestart.capacityReservations()).toEqual([{
        accountProfileId: "account_local_execution",
        runId: unresolved.runId,
      }]);
      expect(new DispatchAccountReservationArbiter({
        accounts: { dispatchAccounts: () => [executionAccount()] },
        now: () => 82_000,
        recoveredReservations: unresolvedRestart.capacityReservations(),
      }).currentSnapshot()).toMatchObject({
        activeRuns: 1,
        retainedRunIds: [unresolved.runId],
        state: "capacity_full",
      });
    } finally {
      startup.database.close();
      replay.database.close();
      unresolved.database.close();
    }
  });

  test.each([
    "running" as const,
    "waiting" as const,
  ])("defers repeated same-boot claim expiry through a stale %s callback until ambiguity resolution", async (
    stage,
  ) => {
    const value = fixture();
    try {
      await driveRunning(value);
      if (stage === "waiting") {
        await new DispatchActivityAdapter({
          fence: value.executions,
          store: value.executions,
        }).observe({
          accountProfileId: "account_local_execution",
          threadId: "thread_local_execution",
          turnId: "turn_local_execution",
          kind: "waiting_for_input",
        });
      }
      const authorityCommands = new LocalTaskAuthorityCommandStore({
        database: value.database,
        tasks: value.tasks,
      });
      const firstExpiry = value.due.claimDue({
        bootGeneration: value.bootGeneration,
        now: 70_000,
        limit: 1,
        abandonedClaimAfterMs: 60_000,
      })[0];
      expect(firstExpiry).toMatchObject({ kind: "claim_expiry" });
      if (firstExpiry === undefined) throw new Error("Claim expiry disappeared");
      const firstPrepared = authorityCommands.prepareDueWork({
        work: firstExpiry,
        bootGeneration: value.bootGeneration,
        now: 70_000,
        operationId: publicId("op", stage === "running" ? 86 : 87),
      });
      if (firstPrepared.kind !== "current" || firstPrepared.command === null) {
        throw new Error("Claim expiry was not authoritative");
      }
      expect(authorityCommands.executeSystemCommand({
        work: firstExpiry,
        command: firstPrepared.command,
        authority: firstPrepared.authority,
        now: 70_000,
      })).toMatchObject({
        kind: "retry",
        errorCode: "system_command_rejected",
      });
      value.due.retry({
        id: firstExpiry.id,
        bootGeneration: value.bootGeneration,
        workGeneration: firstExpiry.workGeneration,
        nextDueAt: 70_001,
        errorCode: "system_command_rejected",
        now: 70_000,
      });

      // Model a late owned-turn callback whose outcome cannot be attributed
      // after its fence check. The durable ambiguity must retain both the
      // active claim and account lane while a racing scheduler retry lands.
      value.executions.transition({
        runId: value.runId,
        to: "ambiguous",
        failureCode: "local_completion_fence_stale",
      });
      value.executions.appendPublicEvent({
        runId: value.runId,
        eventId: `${value.runId}:same-boot-stale-${stage}`,
        kind: "run.lease_lost",
      });
      const binding = value.executions.read(value.runId);
      if (binding === null) throw new Error("Execution binding disappeared");
      const claim = value.database.query<{
        fence: number;
        lease_generation: number;
        lease_until: number;
      }, [string]>(`
        SELECT fence, lease_generation, lease_until
        FROM local_task_claims WHERE claim_id = ?1
      `).get(binding.claimId);
      if (claim === null) throw new Error("Active claim disappeared");
      value.due.enqueue({
        workspaceId: value.workspaceId,
        kind: "claim_expiry",
        entityId: binding.claimId,
        dueAt: claim.lease_until,
        expectedRevision: claim.lease_generation,
        expectedFence: claim.fence,
        now: 70_000,
      });
      const retryExpiry = value.due.claimDue({
        bootGeneration: value.bootGeneration,
        now: 70_001,
        limit: 1,
        abandonedClaimAfterMs: 60_000,
      })[0];
      expect(retryExpiry).toMatchObject({ kind: "claim_expiry" });
      if (retryExpiry === undefined) throw new Error("Retried expiry disappeared");
      const retryPrepared = authorityCommands.prepareDueWork({
        work: retryExpiry,
        bootGeneration: value.bootGeneration,
        now: 70_001,
        operationId: publicId("op", stage === "running" ? 88 : 89),
      });
      if (retryPrepared.kind !== "current" || retryPrepared.command === null) {
        throw new Error("Retried claim expiry was not authoritative");
      }
      expect(authorityCommands.executeSystemCommand({
        work: retryExpiry,
        command: retryPrepared.command,
        authority: retryPrepared.authority,
        now: 70_001,
      })).toMatchObject({
        kind: "retry",
        errorCode: "system_command_rejected",
      });
      expect(value.database.query<{
        claim_state: string;
        phase: string;
        status: string;
      }, [string]>(`
        SELECT claim.state AS claim_state, run.phase, task.status
        FROM local_task_runs AS run
        JOIN local_tasks AS task
          ON task.workspace_id = run.workspace_id AND task.task_id = run.task_id
        JOIN local_task_claims AS claim
          ON claim.workspace_id = run.workspace_id AND claim.claim_id = run.claim_id
        WHERE run.run_id = ?1
      `).get(value.runId)).toEqual({
        claim_state: "active",
        phase: "ambiguous",
        status: "in_progress",
      });

      const revisions = value.database.query<{
        task_revision: number;
        workspace_revision: number;
      }, [string]>(`
        SELECT task.revision AS task_revision,
          workspace.revision AS workspace_revision
        FROM local_tasks AS task
        JOIN local_workspaces AS workspace
          ON workspace.workspace_id = task.workspace_id
        WHERE task.task_id = ?1
      `).get(value.taskId);
      if (revisions === null) throw new Error("Ambiguous task disappeared");
      expect(value.tasks.execute({
        kind: "dispatch.resolve_ambiguity",
        operationId: publicId("op", stage === "running" ? 90 : 91),
        authority: {
          kind: "local_owner",
          workspaceId: value.workspaceId,
          installationId,
        },
        expectedWorkspaceRevision: revisions.workspace_revision,
        taskId: value.taskId,
        expectedTaskRevision: revisions.task_revision,
        sourceRunId: value.runId,
        reason: "confirmed_cancelled",
      }, undefined, 70_002)).toMatchObject({
        outcome: "committed",
        result: { kind: "run_updated", phase: "cancelled" },
      });
      value.executions.markHumanResolved(value.runId, 70_002);
      expect(value.executions.capacityReservations()).toEqual([]);
      expect(value.database.query<{
        claim_state: string;
        phase: string;
        status: string;
      }, [string]>(`
        SELECT claim.state AS claim_state, run.phase, task.status
        FROM local_task_runs AS run
        JOIN local_tasks AS task
          ON task.workspace_id = run.workspace_id AND task.task_id = run.task_id
        JOIN local_task_claims AS claim
          ON claim.workspace_id = run.workspace_id AND claim.claim_id = run.claim_id
        WHERE run.run_id = ?1
      `).get(value.runId)).toEqual({
        claim_state: "released",
        phase: "cancelled",
        status: "open",
      });
    } finally {
      value.database.close();
    }
  });

  test("recovers a restarted run before lease expiry and keeps ambiguity resolvable", async () => {
    const value = fixture();
    try {
      await driveRunning(value);
      const restartedGeneration = value.due.beginBoot({
        installationId,
        bootId: "boot_local_recovery_precedes_expiry",
        now: 120_000,
      });
      const recovery = value.due.claimDue({
        bootGeneration: restartedGeneration,
        now: 120_000,
        limit: 1,
        abandonedClaimAfterMs: 60_000,
      })[0];
      expect(recovery).toMatchObject({
        kind: "run_recovery",
        entityId: value.runId,
      });
      if (recovery === undefined) throw new Error("Recovery work disappeared");
      const authorityCommands = new LocalTaskAuthorityCommandStore({
        database: value.database,
        tasks: value.tasks,
      });
      const prepared = authorityCommands.prepareDueWork({
        work: recovery,
        bootGeneration: restartedGeneration,
        now: 120_000,
        operationId: publicId("op", 72),
      });
      if (prepared.kind !== "current" || prepared.command === null) {
        throw new Error("Restart recovery was not authoritative");
      }
      expect(authorityCommands.executeSystemCommand({
        work: recovery,
        command: prepared.command,
        authority: prepared.authority,
        now: 120_000,
      })).toMatchObject({ kind: "committed" });
      expect(value.database.query<{
        phase: string;
        status: string;
        claim_state: string;
        expiry_state: string;
      }, [string]>(`
        SELECT run.phase, task.status, claim.state AS claim_state,
          expiry.state AS expiry_state
        FROM local_task_runs AS run
        JOIN local_tasks AS task
          ON task.workspace_id = run.workspace_id AND task.task_id = run.task_id
        JOIN local_task_claims AS claim
          ON claim.workspace_id = run.workspace_id AND claim.claim_id = run.claim_id
        JOIN local_due_work AS expiry
          ON expiry.workspace_id = run.workspace_id
          AND expiry.work_kind = 'claim_expiry'
          AND expiry.entity_id = run.claim_id
        WHERE run.run_id = ?1
      `).get(value.runId)).toEqual({
        phase: "ambiguous",
        status: "in_progress",
        claim_state: "active",
        expiry_state: "cancelled",
      });

      const revisions = value.database.query<{
        task_revision: number;
        workspace_revision: number;
      }, [string]>(`
        SELECT task.revision AS task_revision,
          workspace.revision AS workspace_revision
        FROM local_tasks AS task
        JOIN local_workspaces AS workspace
          ON workspace.workspace_id = task.workspace_id
        WHERE task.task_id = ?1
      `).get(value.taskId);
      if (revisions === null) throw new Error("Recovered task disappeared");
      expect(value.tasks.execute({
        kind: "dispatch.resolve_ambiguity",
        operationId: publicId("op", 73),
        authority: {
          kind: "local_owner",
          workspaceId: value.workspaceId,
          installationId,
        },
        expectedWorkspaceRevision: revisions.workspace_revision,
        taskId: value.taskId,
        expectedTaskRevision: revisions.task_revision,
        sourceRunId: value.runId,
        reason: "confirmed_cancelled",
      }, undefined, 120_001)).toMatchObject({
        outcome: "committed",
        result: { kind: "run_updated", phase: "cancelled" },
      });
      value.executions.markHumanResolved(value.runId, 120_001);
      expect(value.executions.capacityReservations()).toEqual([]);
    } finally {
      value.database.close();
    }
  });

  test("rejects task cancellation while an ambiguous run retains its lane", () => {
    const value = fixture();
    try {
      const admitted = value.executions.admit({
        accountProfileId: "account_local_execution",
        authority: value.authority,
        baseSha: "d".repeat(40),
        bootGeneration: value.bootGeneration,
        now: 20,
        runtimeBootId: bootId,
        runtimePublicId: runnerId,
        work: value.work,
      });
      if (admitted.kind !== "admitted") throw new Error("Admission failed");
      value.executions.transition({ runId: value.runId, to: "lease_lost" });
      value.executions.appendPublicEvent({
        runId: value.runId,
        eventId: `${value.runId}:cancel-guard-ambiguity`,
        kind: "run.lease_lost",
      });
      const authority = value.database.query<{
        task_revision: number;
        workspace_revision: number;
      }, [string]>(`
        SELECT task.revision AS task_revision,
          workspace.revision AS workspace_revision
        FROM local_tasks AS task
        JOIN local_workspaces AS workspace
          ON workspace.workspace_id = task.workspace_id
        WHERE task.task_id = ?1
      `).get(value.taskId);
      if (authority === null) throw new Error("Task authority disappeared");
      expect(value.tasks.execute({
        kind: "task.cancel",
        operationId: publicId("op", 71),
        authority: {
          kind: "local_owner",
          workspaceId: value.workspaceId,
          installationId,
        },
        expectedWorkspaceRevision: authority.workspace_revision,
        taskId: value.taskId,
        expectedTaskRevision: authority.task_revision,
        reason: "Do not strand the uncertain provider mutation.",
      }, undefined, 30)).toMatchObject({
        outcome: "rejected",
        code: "invalid_state",
      });
      expect(value.database.query<{ status: string }, [string]>(`
        SELECT status FROM local_tasks WHERE task_id = ?1
      `).get(value.taskId)).toEqual({ status: "in_progress" });
      expect(value.executions.capacityReservations()).toEqual([{
        accountProfileId: "account_local_execution",
        runId: value.runId,
      }]);
    } finally {
      value.database.close();
    }
  });

  test("blocks reopen through post-cancel ambiguity and restart until the lane is released", async () => {
    const value = fixture();
    try {
      await driveRunning(value);
      const beforeCancel = value.database.query<{
        task_revision: number;
        workspace_revision: number;
      }, [string]>(`
        SELECT task.revision AS task_revision,
          workspace.revision AS workspace_revision
        FROM local_tasks AS task
        JOIN local_workspaces AS workspace
          ON workspace.workspace_id = task.workspace_id
        WHERE task.task_id = ?1
      `).get(value.taskId);
      if (beforeCancel === null) throw new Error("Task disappeared before cancellation");
      expect(value.tasks.execute({
        kind: "task.cancel",
        operationId: publicId("op", 74),
        authority: {
          kind: "local_owner",
          workspaceId: value.workspaceId,
          installationId,
        },
        expectedWorkspaceRevision: beforeCancel.workspace_revision,
        taskId: value.taskId,
        expectedTaskRevision: beforeCancel.task_revision,
        reason: "Stop this local task.",
      }, undefined, 30)).toMatchObject({
        outcome: "committed",
        result: { kind: "task_updated" },
      });
      const cancelled = value.database.query<{
        run_phase: string;
        task_revision: number;
        workspace_revision: number;
      }, [string]>(`
        SELECT run.phase AS run_phase, task.revision AS task_revision,
          workspace.revision AS workspace_revision
        FROM local_tasks AS task
        JOIN local_workspaces AS workspace
          ON workspace.workspace_id = task.workspace_id
        JOIN local_task_runs AS run
          ON run.workspace_id = task.workspace_id AND run.task_id = task.task_id
        WHERE task.task_id = ?1
      `).get(value.taskId);
      if (cancelled === null) throw new Error("Cancelled task disappeared");
      expect(cancelled.run_phase).toBe("cancel_requested");
      expect(value.tasks.execute({
        kind: "task.reopen",
        operationId: publicId("op", 76),
        authority: {
          kind: "local_owner",
          workspaceId: value.workspaceId,
          installationId,
        },
        expectedWorkspaceRevision: cancelled.workspace_revision,
        taskId: value.taskId,
        expectedTaskRevision: cancelled.task_revision,
      }, undefined, 31)).toMatchObject({
        outcome: "rejected",
        code: "invalid_state",
      });

      await new DispatchRevocationCoordinator({
        capabilities: {
          releaseRun: (runId) => value.executions.releaseCapacity(runId),
        },
        sessions: {
          interruptGatewayThread: () =>
            Promise.reject(new Error("thread stop result was lost")),
          stopGatewayAccount: () =>
            Promise.reject(new Error("account stop result was lost")),
        },
        store: value.executions,
      }).revoke(value.runId, "stop_requested");
      expect(value.executions.read(value.runId)?.stage).toBe("ambiguous");
      expect(value.database.query<{ phase: string; status: string }, [string]>(`
        SELECT run.phase, task.status
        FROM local_task_runs AS run
        JOIN local_tasks AS task
          ON task.workspace_id = run.workspace_id AND task.task_id = run.task_id
        WHERE run.run_id = ?1
      `).get(value.runId)).toEqual({
        phase: "ambiguous",
        status: "cancelled",
      });

      value.due.beginBoot({
        installationId,
        bootId: "boot_post_cancel_ambiguity_restart",
        now: 40,
      });
      const restarted = new LocalRunExecutionStore({
        database: value.database,
      });
      const restartedAccounts = new DispatchAccountReservationArbiter({
        accounts: { dispatchAccounts: () => [executionAccount()] },
        now: () => 40,
        recoveredReservations: restarted.capacityReservations(),
      });
      expect(restartedAccounts.currentSnapshot()).toMatchObject({
        activeRuns: 1,
        retainedRunIds: [value.runId],
        state: "capacity_full",
      });

      const resolution = value.database.query<{
        task_revision: number;
        workspace_revision: number;
      }, [string]>(`
        SELECT task.revision AS task_revision,
          workspace.revision AS workspace_revision
        FROM local_tasks AS task
        JOIN local_workspaces AS workspace
          ON workspace.workspace_id = task.workspace_id
        WHERE task.task_id = ?1
      `).get(value.taskId);
      if (resolution === null) throw new Error("Cancelled task disappeared");
      expect(value.tasks.execute({
        kind: "task.reopen",
        operationId: publicId("op", 77),
        authority: {
          kind: "local_owner",
          workspaceId: value.workspaceId,
          installationId,
        },
        expectedWorkspaceRevision: resolution.workspace_revision,
        taskId: value.taskId,
        expectedTaskRevision: resolution.task_revision,
      }, undefined, 49)).toMatchObject({
        outcome: "rejected",
        code: "invalid_state",
      });
      expect(value.tasks.execute({
        kind: "dispatch.resolve_ambiguity",
        operationId: publicId("op", 75),
        authority: {
          kind: "local_owner",
          workspaceId: value.workspaceId,
          installationId,
        },
        expectedWorkspaceRevision: resolution.workspace_revision,
        taskId: value.taskId,
        expectedTaskRevision: resolution.task_revision,
        sourceRunId: value.runId,
        reason: "confirmed_cancelled",
      }, undefined, 50)).toMatchObject({
        outcome: "committed",
        result: { kind: "run_updated", phase: "cancelled" },
      });
      const terminalButRetained = value.database.query<{
        task_revision: number;
        workspace_revision: number;
      }, [string]>(`
        SELECT task.revision AS task_revision,
          workspace.revision AS workspace_revision
        FROM local_tasks AS task
        JOIN local_workspaces AS workspace
          ON workspace.workspace_id = task.workspace_id
        WHERE task.task_id = ?1
      `).get(value.taskId);
      if (terminalButRetained === null) {
        throw new Error("Resolved retained task disappeared");
      }
      expect(value.tasks.execute({
        kind: "task.reopen",
        operationId: publicId("op", 79),
        authority: {
          kind: "local_owner",
          workspaceId: value.workspaceId,
          installationId,
        },
        expectedWorkspaceRevision: terminalButRetained.workspace_revision,
        taskId: value.taskId,
        expectedTaskRevision: terminalButRetained.task_revision,
      }, undefined, 50)).toMatchObject({
        outcome: "rejected",
        code: "invalid_state",
      });
      restarted.markHumanResolved(value.runId, 50);
      restartedAccounts.releaseRun(value.runId);
      expect(value.database.query<{
        claim_state: string;
        run_phase: string;
        task_status: string;
      }, [string]>(`
        SELECT claim.state AS claim_state, run.phase AS run_phase,
          task.status AS task_status
        FROM local_task_runs AS run
        JOIN local_tasks AS task
          ON task.workspace_id = run.workspace_id AND task.task_id = run.task_id
        JOIN local_task_claims AS claim
          ON claim.workspace_id = run.workspace_id AND claim.claim_id = run.claim_id
        WHERE run.run_id = ?1
      `).get(value.runId)).toEqual({
        claim_state: "released",
        run_phase: "cancelled",
        task_status: "cancelled",
      });
      expect(restarted.capacityReservations()).toEqual([]);
      expect(restartedAccounts.currentSnapshot()).toMatchObject({
        activeRuns: 0,
        availableCapacity: 1,
      });
      const releasable = value.database.query<{
        task_revision: number;
        workspace_revision: number;
      }, [string]>(`
        SELECT task.revision AS task_revision,
          workspace.revision AS workspace_revision
        FROM local_tasks AS task
        JOIN local_workspaces AS workspace
          ON workspace.workspace_id = task.workspace_id
        WHERE task.task_id = ?1
      `).get(value.taskId);
      if (releasable === null) throw new Error("Resolved task disappeared");
      expect(value.tasks.execute({
        kind: "task.reopen",
        operationId: publicId("op", 78),
        authority: {
          kind: "local_owner",
          workspaceId: value.workspaceId,
          installationId,
        },
        expectedWorkspaceRevision: releasable.workspace_revision,
        taskId: value.taskId,
        expectedTaskRevision: releasable.task_revision,
      }, undefined, 51)).toMatchObject({
        outcome: "committed",
        result: { kind: "task_updated" },
      });
      expect(value.database.query<{ status: string }, [string]>(`
        SELECT status FROM local_tasks WHERE task_id = ?1
      `).get(value.taskId)).toEqual({ status: "open" });
    } finally {
      value.database.close();
    }
  });

  test("keeps a cancelled run retained when terminal invalidation throws until retry releases it", async () => {
    let throwCancelledInvalidation = false;
    const value = fixture((database) => {
      const latest = database.query<{ event_kind: string }, []>(`
        SELECT event_kind FROM local_run_public_events
        ORDER BY observed_at DESC, sequence DESC LIMIT 1
      `).get();
      if (throwCancelledInvalidation && latest?.event_kind === "run.cancelled") {
        throw new Error("simulated post-commit invalidation failure");
      }
    });
    try {
      await driveRunning(value);
      const beforeCancel = value.database.query<{
        task_revision: number;
        workspace_revision: number;
      }, [string]>(`
        SELECT task.revision AS task_revision,
          workspace.revision AS workspace_revision
        FROM local_tasks AS task
        JOIN local_workspaces AS workspace
          ON workspace.workspace_id = task.workspace_id
        WHERE task.task_id = ?1
      `).get(value.taskId);
      if (beforeCancel === null) throw new Error("Task disappeared");
      expect(value.tasks.execute({
        kind: "task.cancel",
        operationId: publicId("op", 83),
        authority: {
          kind: "local_owner",
          workspaceId: value.workspaceId,
          installationId,
        },
        expectedWorkspaceRevision: beforeCancel.workspace_revision,
        taskId: value.taskId,
        expectedTaskRevision: beforeCancel.task_revision,
        reason: "Exercise the terminal callback retry barrier.",
      }, undefined, 30)).toMatchObject({ outcome: "committed" });
      const accounts = new DispatchAccountReservationArbiter({
        accounts: { dispatchAccounts: () => [executionAccount()] },
        now: () => 40,
        recoveredReservations: [{
          accountProfileId: "account_local_execution",
          runId: value.runId,
        }],
      });
      const completion = new LocalRunCompletionAdapter({
        accounts,
        store: value.executions,
      });
      throwCancelledInvalidation = true;
      completion.observe({
        accountProfileId: "account_local_execution",
        threadId: "thread_local_execution",
        turnId: "turn_local_execution",
        status: "interrupted",
      });
      await completion.settled();

      expect(value.executions.read(value.runId)?.stage).toBe("cancelled");
      expect(value.database.query<{ phase: string }, [string]>(`
        SELECT phase FROM local_task_runs WHERE run_id = ?1
      `).get(value.runId)).toEqual({ phase: "cancelled" });
      expect(value.executions.capacityReservations()).toEqual([{
        accountProfileId: "account_local_execution",
        runId: value.runId,
      }]);
      expect(accounts.currentSnapshot()).toMatchObject({
        activeRuns: 1,
        retainedRunIds: [value.runId],
      });

      const retained = value.database.query<{
        task_revision: number;
        workspace_revision: number;
      }, [string]>(`
        SELECT task.revision AS task_revision,
          workspace.revision AS workspace_revision
        FROM local_tasks AS task
        JOIN local_workspaces AS workspace
          ON workspace.workspace_id = task.workspace_id
        WHERE task.task_id = ?1
      `).get(value.taskId);
      if (retained === null) throw new Error("Cancelled task disappeared");
      expect(value.tasks.execute({
        kind: "task.reopen",
        operationId: publicId("op", 84),
        authority: {
          kind: "local_owner",
          workspaceId: value.workspaceId,
          installationId,
        },
        expectedWorkspaceRevision: retained.workspace_revision,
        taskId: value.taskId,
        expectedTaskRevision: retained.task_revision,
      }, undefined, 41)).toMatchObject({
        outcome: "rejected",
        code: "invalid_state",
      });

      throwCancelledInvalidation = false;
      completion.retryPending();
      await completion.settled();
      expect(value.executions.capacityReservations()).toEqual([]);
      expect(accounts.currentSnapshot()).toMatchObject({
        activeRuns: 0,
        availableCapacity: 1,
      });
      const released = value.database.query<{
        task_revision: number;
        workspace_revision: number;
      }, [string]>(`
        SELECT task.revision AS task_revision,
          workspace.revision AS workspace_revision
        FROM local_tasks AS task
        JOIN local_workspaces AS workspace
          ON workspace.workspace_id = task.workspace_id
        WHERE task.task_id = ?1
      `).get(value.taskId);
      if (released === null) throw new Error("Released task disappeared");
      expect(value.tasks.execute({
        kind: "task.reopen",
        operationId: publicId("op", 85),
        authority: {
          kind: "local_owner",
          workspaceId: value.workspaceId,
          installationId,
        },
        expectedWorkspaceRevision: released.workspace_revision,
        taskId: value.taskId,
        expectedTaskRevision: released.task_revision,
      }, undefined, 42)).toMatchObject({ outcome: "committed" });
    } finally {
      value.database.close();
    }
  });

  test("distinguishes proven local shutdown from unresolved revocation", async () => {
    const stopped = fixture();
    const accountStopped = fixture();
    const ambiguous = fixture();
    try {
      await driveRunning(stopped);
      const interrupted: string[] = [];
      await new DispatchRevocationCoordinator({
        capabilities: {
          releaseRun: (runId) => stopped.executions.releaseCapacity(runId),
        },
        sessions: {
          interruptGatewayThread: (threadId) => {
            interrupted.push(threadId);
            return Promise.resolve("interrupted");
          },
        },
        store: stopped.executions,
      }).revoke(stopped.runId, "stop_requested");
      expect(interrupted).toEqual(["thread_local_execution"]);
      expect(stopped.executions.read(stopped.runId)?.stage).toBe("cancelled");
      expect(stopped.executions.latestPublicEvent(stopped.runId)?.kind)
        .toBe("run.cancelled");
      expect(stopped.executions.capacityReservations()).toEqual([{
        accountProfileId: "account_local_execution",
        runId: stopped.runId,
      }]);
      expect(stopped.executions.releaseCapacity(stopped.runId)).toBeTrue();
      expect(stopped.executions.capacityReservations()).toEqual([]);

      await driveRunning(accountStopped);
      const gatewayStops: string[] = [];
      await new DispatchRevocationCoordinator({
        capabilities: {
          releaseRun: (runId) => accountStopped.executions.releaseCapacity(runId),
        },
        sessions: {
          interruptGatewayThread: () =>
            Promise.reject(new Error("thread ownership unavailable")),
          stopGatewayAccount: (accountProfileId) => {
            gatewayStops.push(accountProfileId);
            return Promise.resolve();
          },
        },
        store: accountStopped.executions,
      }).revoke(
        accountStopped.runId,
        "interaction_resolution_ambiguous",
      );
      expect(gatewayStops).toEqual(["account_local_execution"]);
      expect(accountStopped.executions.read(accountStopped.runId)).toMatchObject({
        stage: "failed",
        failureCode: "interaction_resolution_ambiguous",
      });
      expect(accountStopped.executions.latestPublicEvent(accountStopped.runId)?.kind)
        .toBe("run.failed");
      expect(accountStopped.executions.capacityReservations()).toEqual([{
        accountProfileId: "account_local_execution",
        runId: accountStopped.runId,
      }]);
      expect(accountStopped.executions.releaseCapacity(accountStopped.runId))
        .toBeTrue();
      expect(accountStopped.executions.capacityReservations()).toEqual([]);

      await driveRunning(ambiguous);
      const failedStops: string[] = [];
      const ambiguousReleases: string[] = [];
      await new DispatchRevocationCoordinator({
        capabilities: {
          releaseRun: (runId) => {
            ambiguousReleases.push(runId);
            ambiguous.executions.releaseCapacity(runId);
          },
        },
        sessions: {
          interruptGatewayThread: () =>
            Promise.reject(new Error("thread ownership unavailable")),
          stopGatewayAccount: (accountProfileId) => {
            failedStops.push(accountProfileId);
            return Promise.reject(new Error("account shutdown unavailable"));
          },
        },
        store: ambiguous.executions,
      }).revoke(
        ambiguous.runId,
        "interaction_resolution_ambiguous",
      );
      expect(failedStops).toEqual(["account_local_execution"]);
      expect(ambiguousReleases).toEqual([]);
      expect(ambiguous.executions.read(ambiguous.runId)?.stage)
        .toBe("ambiguous");
      expect(ambiguous.executions.latestPublicEvent(ambiguous.runId)?.kind)
        .toBe("run.lease_lost");
      expect(ambiguous.executions.capacityReservations()).toEqual([{
        accountProfileId: "account_local_execution",
        runId: ambiguous.runId,
      }]);
    } finally {
      stopped.database.close();
      accountStopped.database.close();
      ambiguous.database.close();
    }
  });

  test("fails a started run without leaking its claim or task assignment", () => {
    const value = fixture();
    try {
      const admitted = value.executions.admit({
        accountProfileId: "account_local_execution",
        authority: value.authority,
        baseSha: "c".repeat(40),
        bootGeneration: value.bootGeneration,
        now: 20,
        runtimeBootId: bootId,
        runtimePublicId: runnerId,
        work: value.work,
      });
      if (admitted.kind !== "admitted") throw new Error("Admission failed");
      value.executions.transition({ runId: value.runId, to: "failed" });
      value.executions.appendPublicEvent({
        runId: value.runId,
        eventId: `${value.runId}:failed`,
        kind: "run.failed",
      });
      expect(value.database.query<{ phase: string }, [string]>(`
        SELECT phase FROM local_task_runs WHERE run_id = ?1
      `).get(value.runId)).toEqual({ phase: "failed" });
      expect(value.database.query<{ status: string; assignee_agent_id: string | null }, [string]>(`
        SELECT status, assignee_agent_id FROM local_tasks WHERE task_id = ?1
      `).get(value.taskId)).toEqual({
        status: "open",
        assignee_agent_id: null,
      });
      expect(value.database.query<{ state: string }, []>(`
        SELECT state FROM local_task_claims
      `).get()).toEqual({ state: "released" });
    } finally {
      value.database.close();
    }
  });

  test("rolls back an illegal semantic event after a terminal run", async () => {
    const value = fixture();
    try {
      await driveRunning(value);
      value.executions.transition({ runId: value.runId, to: "failed" });
      value.executions.appendPublicEvent({
        runId: value.runId,
        eventId: `${value.runId}:terminal`,
        kind: "run.failed",
      });
      const before = value.database.query<{
        events: number;
        revision: number;
        sequence: number;
      }, [string, string]>(`
        SELECT
          (SELECT count(*) FROM local_run_public_events WHERE run_id = ?1)
            AS events,
          workspace.revision,
          binding.last_event_sequence AS sequence
        FROM local_workspaces AS workspace
        JOIN local_run_execution_bindings AS binding
          ON binding.workspace_id = workspace.workspace_id
        WHERE workspace.workspace_id = ?2 AND binding.run_id = ?1
      `).get(value.runId, value.workspaceId);
      expect(() => value.executions.appendPublicEvent({
        runId: value.runId,
        eventId: `${value.runId}:illegal-running`,
        kind: "codex.running",
      })).toThrow("invalid from failed");
      expect(value.database.query<{
        events: number;
        revision: number;
        sequence: number;
      }, [string, string]>(`
        SELECT
          (SELECT count(*) FROM local_run_public_events WHERE run_id = ?1)
            AS events,
          workspace.revision,
          binding.last_event_sequence AS sequence
        FROM local_workspaces AS workspace
        JOIN local_run_execution_bindings AS binding
          ON binding.workspace_id = workspace.workspace_id
        WHERE workspace.workspace_id = ?2 AND binding.run_id = ?1
      `).get(value.runId, value.workspaceId)).toEqual(before);
    } finally {
      value.database.close();
    }
  });

  test("atomically turns a completed turn into mode-neutral review evidence", async () => {
    const released: string[] = [];
    const value = fixture(undefined, (runId) => released.push(runId));
    try {
      await driveRunning(value);
      const beforeInvalidations = value.invalidations.length;
      expect(value.executions.submitCompleted(value.runId, 200)).toMatchObject({
        runId: value.runId,
        stage: "completed",
      });
      expect(value.database.query<{
        task_status: string;
        run_phase: string;
        claim_state: string;
        submission_status: string;
        summary: string;
        evidence_json: string;
      }, [string]>(`
        SELECT task.status AS task_status, run.phase AS run_phase,
          claim.state AS claim_state, submission.status AS submission_status,
          submission.summary, submission.evidence_json
        FROM local_task_runs AS run
        JOIN local_tasks AS task
          ON task.workspace_id = run.workspace_id AND task.task_id = run.task_id
        JOIN local_task_claims AS claim
          ON claim.workspace_id = run.workspace_id AND claim.claim_id = run.claim_id
        JOIN local_task_submissions AS submission
          ON submission.workspace_id = run.workspace_id
          AND submission.task_id = run.task_id
        WHERE run.run_id = ?1
      `).get(value.runId)).toEqual({
        task_status: "in_review",
        run_phase: "submitted",
        claim_state: "submitted",
        submission_status: "pending",
        summary: "Completed by Codex and ready for human review.",
        evidence_json: JSON.stringify([{
          kind: "note",
          text: "The Codex turn completed successfully.",
        }]),
      });
      expect(released).toEqual([value.runId]);
      expect(value.executions.releaseCapacity(value.runId, 201)).toBeTrue();
      expect(released).toEqual([value.runId]);
      expect(value.executions.latestPublicEvent(value.runId)?.kind)
        .toBe("run.submitted");
      expect(value.executions.capacityReservations()).toEqual([]);
      expect(value.invalidations.length).toBe(beforeInvalidations + 1);
      expect(value.invalidations.at(-1)).toMatchObject({
        affectedProjections: [{ projection: "workspace_summary" }, {
          projection: "task_list",
          views: [...taskWorkspaceViewValues],
        }, {
          projection: "task_detail",
        }],
        changeKind: "task.submitted",
        runId: value.runId,
        scope: "task_change",
        taskId: value.taskId,
      });
    } finally {
      value.database.close();
    }
  });

  test("retries a rejected immutable submission as a new queued run", async () => {
    const value = fixture();
    try {
      await driveRunning(value);
      value.executions.submitCompleted(value.runId, 200);
      const submitted = value.database.query<{
        submission_id: string;
        review_revision: number;
        task_revision: number;
        workspace_revision: number;
      }, [string]>(`
        SELECT submission.submission_id, submission.review_revision,
          task.revision AS task_revision,
          workspace.revision AS workspace_revision
        FROM local_task_submissions AS submission
        JOIN local_tasks AS task
          ON task.workspace_id = submission.workspace_id
          AND task.task_id = submission.task_id
        JOIN local_workspaces AS workspace
          ON workspace.workspace_id = submission.workspace_id
        WHERE submission.task_id = ?1
      `).get(value.taskId);
      if (submitted === null) throw new Error("Submission disappeared");
      const rejected = value.tasks.execute({
        kind: "review.reject",
        operationId: publicId("op", 61),
        authority: {
          kind: "local_owner",
          workspaceId: value.workspaceId,
          installationId,
        },
        expectedWorkspaceRevision: submitted.workspace_revision,
        taskId: value.taskId,
        submissionId: submitted.submission_id,
        expectedReviewRevision: submitted.review_revision,
        reason: "Please address the review feedback.",
      }, undefined, 210);
      expect(rejected).toMatchObject({
        outcome: "committed",
        result: { kind: "submission_updated" },
      });
      const reopened = value.database.query<{
        task_revision: number;
        workspace_revision: number;
      }, [string]>(`
        SELECT task.revision AS task_revision,
          workspace.revision AS workspace_revision
        FROM local_tasks AS task
        JOIN local_workspaces AS workspace
          ON workspace.workspace_id = task.workspace_id
        WHERE task.task_id = ?1
      `).get(value.taskId);
      if (reopened === null) throw new Error("Rejected task disappeared");
      const retried = value.tasks.execute({
        kind: "dispatch.retry",
        operationId: publicId("op", 62),
        authority: {
          kind: "local_owner",
          workspaceId: value.workspaceId,
          installationId,
        },
        expectedWorkspaceRevision: reopened.workspace_revision,
        taskId: value.taskId,
        expectedTaskRevision: reopened.task_revision,
        sourceRunId: value.runId,
      }, undefined, 220);
      expect(retried).toMatchObject({
        outcome: "committed",
        result: { kind: "run_updated", phase: "queued" },
      });
      if (
        retried.outcome !== "committed"
        || retried.result.kind !== "run_updated"
      ) throw new Error("Rejected run retry did not commit");
      expect(value.database.query<{
        phase: string;
        retried_by_run_id: string | null;
      }, [string]>(`
        SELECT phase, retried_by_run_id
        FROM local_task_runs WHERE run_id = ?1
      `).get(value.runId)).toEqual({
        phase: "submitted",
        retried_by_run_id: retried.result.runId,
      });
      expect(value.database.query<{
        status: string;
        reviewed_at: number | null;
      }, [string]>(`
        SELECT status, reviewed_at FROM local_task_submissions
        WHERE submission_id = ?1
      `).get(submitted.submission_id)).toEqual({
        status: "rejected",
        reviewed_at: 210,
      });
      expect(value.database.query<{
        phase: string;
        source_run_id: string | null;
        intent_state: string;
        due_state: string;
      }, [string]>(`
        SELECT run.phase, run.source_run_id,
          intent.state AS intent_state, due.state AS due_state
        FROM local_task_runs AS run
        JOIN local_queued_run_intents AS intent
          ON intent.workspace_id = run.workspace_id
          AND intent.run_id = run.run_id
        JOIN local_due_work AS due
          ON due.workspace_id = run.workspace_id
          AND due.work_kind = 'queued_run'
          AND due.entity_id = run.run_id
        WHERE run.run_id = ?1
      `).get(retried.result.runId)).toEqual({
        phase: "queued",
        source_run_id: value.runId,
        intent_state: "queued",
        due_state: "pending",
      });
    } finally {
      value.database.close();
    }
  });

  test.each([
    [
      "completed before response commit",
      "completed" as const,
      "completion_pending" as const,
      "completed" as const,
      "run.submitted" as const,
    ],
    [
      "completed after response commit",
      "completed" as const,
      "completion_answered" as const,
      "completed" as const,
      "run.submitted" as const,
    ],
    [
      "failed before response commit",
      "failed" as const,
      "failure_pending" as const,
      "failed" as const,
      "run.failed" as const,
    ],
    [
      "failed after response commit",
      "failed" as const,
      "failure_answered" as const,
      "failed" as const,
      "run.failed" as const,
    ],
    [
      "interrupted before response commit",
      "interrupted" as const,
      "interruption_pending" as const,
      "cancelled" as const,
      "run.cancelled" as const,
    ],
    [
      "interrupted after response commit",
      "interrupted" as const,
      "interruption_answered" as const,
      "cancelled" as const,
      "run.cancelled" as const,
    ],
  ])("defers %s until the interaction settles", async (
    _label,
    lifecycleStatus,
    order,
    terminalStage,
    terminalEvent,
  ) => {
    const value = fixture();
    try {
      await driveRunning(value);
      const interaction = await prepareWaitingInteraction(value, order);
      const accounts = new DispatchAccountReservationArbiter({
        accounts: { dispatchAccounts: () => [executionAccount()] },
        now: () => 200,
        recoveredReservations: [{
          accountProfileId: "account_local_execution",
          runId: value.runId,
        }],
      });
      const completion = new LocalRunCompletionAdapter({
        accounts,
        store: value.executions,
      });
      const lifecycle = {
        accountProfileId: "account_local_execution",
        threadId: "thread_local_execution",
        turnId: "turn_local_execution",
        status: lifecycleStatus,
      };

      if (order.endsWith("_pending")) {
        completion.observe(lifecycle);
        await completion.settled();
        expect(value.executions.interactionAuthority(interaction.request.id)?.state)
          .toBe("pending");
      }

      const response = value.tasks.executeWithDisposition(
        interaction.command,
        undefined,
        200,
      );
      expect(response).toMatchObject({
        replayed: false,
        receipt: { outcome: "committed" },
      });

      if (order.endsWith("_answered")) {
        completion.observe(lifecycle);
        await completion.settled();
      }
      expect(value.executions.read(value.runId)?.stage).toBe("waiting");
      expect(value.executions.interactionAuthority(interaction.request.id)?.state)
        .toBe("answered");
      expect(accounts.currentSnapshot()).toMatchObject({
        activeRuns: 1,
        retainedRunIds: [value.runId],
        state: "capacity_full",
      });

      const adapter = new LocalRunInteractionAdapter({
        identity: {
          runnerId,
          bootId,
          bootGeneration: value.bootGeneration,
        },
        onAmbiguous: () => {
          throw new Error("Interaction settlement unexpectedly became ambiguous");
        },
        onCommitted: () => undefined,
        replyKey: await createRunInteractionReplyKeyPair(),
        sessions: {
          resolveInteraction: () =>
            Promise.resolve({ kind: "applied" as const }),
        },
        store: value.executions,
        tasks: value.tasks,
      });
      await adapter.respond(interaction.command);
      expect(value.executions.interactionAuthority(interaction.request.id)?.state)
        .toBe("resolved");
      expect(value.executions.read(value.runId)?.stage).toBe("running");

      completion.retryPending();
      await completion.settled();
      expect(value.executions.read(value.runId)?.stage).toBe(terminalStage);
      expect(value.executions.latestPublicEvent(value.runId)?.kind)
        .toBe(terminalEvent);
      expect(value.executions.interactionAuthority(interaction.request.id)?.state)
        .toBe("resolved");
      expect(accounts.currentSnapshot()).toMatchObject({
        activeRuns: 0,
        availableCapacity: 1,
        retainedRunIds: [],
        state: "ready",
      });
    } finally {
      value.database.close();
    }
  });

  test("settles a committed interaction once without persisting plaintext", async () => {
    const value = fixture();
    try {
      await driveRunning(value);
      const activity = new DispatchActivityAdapter({
        fence: value.executions,
        store: value.executions,
      });
      await activity.observe({
        accountProfileId: "account_local_execution",
        threadId: "thread_local_execution",
        turnId: "turn_local_execution",
        kind: "waiting_for_input",
      });
      const request: PortableRunInteractionRequest = {
        id: "interaction_local0001",
        kind: "user_input",
        createdAt: 100,
        expiresAt: 1_000,
        questions: [{
          id: "question_local00001",
          header: "Direction",
          prompt: "How should the run continue?",
          allowOther: true,
          options: [],
        }],
      };
      const providerResponses: unknown[] = [];
      const committedInvalidations: unknown[] = [];
      const adapter = new LocalRunInteractionAdapter({
        identity: {
          runnerId,
          bootId,
          bootGeneration: value.bootGeneration,
        },
        onAmbiguous: () => {
          throw new Error("Interaction settlement unexpectedly became ambiguous");
        },
        onCommitted: (input) => committedInvalidations.push(input),
        replyKey: await createRunInteractionReplyKeyPair(),
        sessions: {
          resolveInteraction: (_interactionId, response) => {
            providerResponses.push(response);
            return Promise.resolve({ kind: "applied" as const });
          },
        },
        store: value.executions,
        tasks: value.tasks,
      });
      expect(await adapter.observeRequest({
        accountProfileId: "account_local_execution",
        threadId: "thread_local_execution",
        turnId: "turn_local_execution",
        request,
      })).toMatchObject({
        id: request.id,
        reply: {
          runnerId,
          bootId,
          bootGeneration: value.bootGeneration,
        },
      });
      const workspaceRevision = value.database.query<{
        revision: number;
      }, [string]>(`
        SELECT revision FROM local_workspaces WHERE workspace_id = ?1
      `).get(value.workspaceId)?.revision;
      if (workspaceRevision === undefined) throw new Error("Workspace disappeared");
      const question = request.questions[0];
      if (question === undefined) throw new Error("Interaction question disappeared");
      const plaintext = "answer-that-must-never-enter-sqlite";
      const command: Extract<
        PortableTaskCommand,
        { kind: "interaction.respond" }
      > = {
        kind: "interaction.respond",
        operationId: publicId("op", 51),
        authority: {
          kind: "local_owner",
          workspaceId: value.workspaceId,
          installationId,
        },
        expectedWorkspaceRevision: workspaceRevision,
        runId: value.runId,
        interactionId: request.id,
        request,
        response: {
          kind: "user_input",
          answers: [{
            questionId: question.id,
            selectedOptionIds: [],
            otherText: plaintext,
          }],
        },
      };
      const first = value.tasks.executeWithDisposition(command, undefined, 200);
      expect(first).toMatchObject({
        replayed: false,
        receipt: { outcome: "committed" },
      });
      expect(new TextDecoder().decode(value.database.serialize()))
        .not.toContain(plaintext);
      if (first.receipt.outcome === "committed" && !first.replayed) {
        await adapter.respond(command);
      }
      const replay = value.tasks.executeWithDisposition(command, undefined, 201);
      if (replay.receipt.outcome === "committed" && !replay.replayed) {
        await adapter.respond(command);
      }
      expect(replay.replayed).toBeTrue();
      expect(providerResponses).toEqual([command.response]);
      expect(value.executions.interactionAuthority(request.id)?.state)
        .toBe("resolved");
      expect(value.executions.read(value.runId)?.stage).toBe("running");
      expect(value.executions.latestPublicEvent(value.runId)?.kind)
        .toBe("codex.running");
      expect(committedInvalidations).toHaveLength(1);
      expect(committedInvalidations[0]).toMatchObject({
        affectedProjections: [{
          projection: "task_list",
          views: [...taskWorkspaceViewValues],
        }, {
          projection: "task_detail",
        }],
        changeKind: "run.interaction_changed",
        runId: value.runId,
        scope: "task_change",
        taskId: value.taskId,
      });
      expect(new TextDecoder().decode(value.database.serialize()))
        .not.toContain(plaintext);
    } finally {
      value.database.close();
    }
  });

  test.each([
    ["throws" as const, true],
    ["returns non-applied" as const, false],
  ])("atomically expires an answered interaction when provider resolution %s", async (
    mode,
    simulateCrashBeforeRelease,
  ) => {
    const value = fixture();
    try {
      await driveRunning(value);
      const interaction = await prepareWaitingInteraction(
        value,
        `atomic_stop_${mode === "throws" ? "throw" : "rejected"}`,
      );
      expect(value.tasks.executeWithDisposition(
        interaction.command,
        undefined,
        200,
      )).toMatchObject({
        replayed: false,
        receipt: { outcome: "committed" },
      });
      const accounts = new DispatchAccountReservationArbiter({
        accounts: { dispatchAccounts: () => [executionAccount()] },
        now: () => 200,
        recoveredReservations: [{
          accountProfileId: "account_local_execution",
          runId: value.runId,
        }],
      });
      const interrupted: string[] = [];
      const stoppedAccounts: string[] = [];
      const revocations = new DispatchRevocationCoordinator({
        capabilities: { releaseRun: () => undefined },
        sessions: {
          interruptGatewayThread: (threadId) => {
            interrupted.push(threadId);
            return mode === "throws"
              ? Promise.resolve("interrupted")
              : Promise.reject(new Error("thread projection unavailable"));
          },
          stopGatewayAccount: (accountProfileId) => {
            stoppedAccounts.push(accountProfileId);
            return Promise.resolve();
          },
        },
        store: value.executions,
      });
      const adapter = new LocalRunInteractionAdapter({
        identity: {
          runnerId,
          bootId,
          bootGeneration: value.bootGeneration,
        },
        onAmbiguous: async (runId) => {
          await revocations.revoke(
            runId,
            "interaction_resolution_ambiguous",
          );
          if (
            !simulateCrashBeforeRelease
            && value.executions.releaseCapacity(runId, 201)
          ) {
            accounts.releaseRun(runId);
          }
        },
        onCommitted: () => undefined,
        replyKey: await createRunInteractionReplyKeyPair(),
        sessions: {
          resolveInteraction: () => mode === "throws"
            ? Promise.reject(new Error("provider resolution transport failed"))
            : Promise.resolve({ kind: "rejected" as const }),
        },
        store: value.executions,
        tasks: value.tasks,
      });

      await adapter.respond(interaction.command);

      expect(interrupted).toEqual(["thread_local_execution"]);
      expect(stoppedAccounts).toEqual(
        mode === "throws" ? [] : ["account_local_execution"],
      );
      expect(value.executions.interactionAuthority(interaction.request.id)?.state)
        .toBe("expired");
      expect(value.executions.read(value.runId)).toMatchObject({
        stage: "failed",
        failureCode: "interaction_resolution_ambiguous",
      });
      expect(value.database.query<{ phase: string }, [string]>(`
        SELECT phase FROM local_task_runs WHERE run_id = ?1
      `).get(value.runId)).toEqual({ phase: "failed" });
      if (simulateCrashBeforeRelease) {
        expect(value.executions.capacityReservations()).toEqual([{
          accountProfileId: "account_local_execution",
          runId: value.runId,
        }]);
        const restarted = new LocalRunExecutionStore({
          database: value.database,
        });
        expect(restarted.recoverAnsweredInteractionsOnRestart()).toEqual([]);
        expect(restarted.reconcileRetainedTerminalCapacityOnRestart(202))
          .toEqual([value.runId]);
        expect(restarted.capacityReservations()).toEqual([]);
      } else {
        expect(value.executions.capacityReservations()).toEqual([]);
        expect(accounts.currentSnapshot()).toMatchObject({
          activeRuns: 0,
          availableCapacity: 1,
        });
      }
    } finally {
      value.database.close();
    }
  });

  test("marks a committed interaction response ambiguous on post-commit mismatch", async () => {
    const value = fixture();
    try {
      await driveRunning(value);
      const activity = new DispatchActivityAdapter({
        fence: value.executions,
        store: value.executions,
      });
      await activity.observe({
        accountProfileId: "account_local_execution",
        threadId: "thread_local_execution",
        turnId: "turn_local_execution",
        kind: "waiting_for_input",
      });
      const request: PortableRunInteractionRequest = {
        id: "interaction_mismatch001",
        kind: "user_input",
        createdAt: 100,
        expiresAt: 1_000,
        questions: [{
          id: "question_mismatch001",
          header: "Direction",
          prompt: "How should the run continue?",
          allowOther: true,
          options: [],
        }],
      };
      expect(value.executions.requestInteraction({
        accountProfileId: "account_local_execution",
        threadId: "thread_local_execution",
        turnId: "turn_local_execution",
        request,
      })).not.toBeNull();
      const workspaceRevision = value.database.query<{
        revision: number;
      }, [string]>(`
        SELECT revision FROM local_workspaces WHERE workspace_id = ?1
      `).get(value.workspaceId)?.revision;
      if (workspaceRevision === undefined) throw new Error("Workspace disappeared");
      const question = request.questions[0];
      if (question === undefined) throw new Error("Interaction question disappeared");
      const command: Extract<
        PortableTaskCommand,
        { kind: "interaction.respond" }
      > = {
        kind: "interaction.respond",
        operationId: publicId("op", 53),
        authority: {
          kind: "local_owner",
          workspaceId: value.workspaceId,
          installationId,
        },
        expectedWorkspaceRevision: workspaceRevision,
        runId: value.runId,
        interactionId: request.id,
        request,
        response: {
          kind: "user_input",
          answers: [{
            questionId: question.id,
            selectedOptionIds: [],
            otherText: "ephemeral mismatch response",
          }],
        },
      };
      expect(value.tasks.executeWithDisposition(command, undefined, 200))
        .toMatchObject({
          replayed: false,
          receipt: { outcome: "committed" },
        });
      value.executions.transition({ runId: value.runId, to: "running" });
      let providerResponses = 0;
      const adapter = new LocalRunInteractionAdapter({
        identity: {
          runnerId,
          bootId,
          bootGeneration: value.bootGeneration,
        },
        onAmbiguous: (runId) => {
          value.executions.transition({
            runId,
            to: "ambiguous",
            failureCode: "interaction_post_commit_mismatch",
          });
          value.executions.appendPublicEvent({
            runId,
            eventId: `${runId}:interaction-post-commit-mismatch`,
            kind: "run.lease_lost",
          });
        },
        onCommitted: () => undefined,
        replyKey: await createRunInteractionReplyKeyPair(),
        sessions: {
          resolveInteraction: () => {
            providerResponses += 1;
            return Promise.resolve({ kind: "applied" as const });
          },
        },
        store: value.executions,
        tasks: value.tasks,
      });
      await adapter.respond(command);
      expect(providerResponses).toBe(0);
      expect(value.executions.read(value.runId)).toMatchObject({
        stage: "ambiguous",
        failureCode: "interaction_post_commit_mismatch",
      });
      expect(value.executions.interactionAuthority(request.id)?.state)
        .toBe("answered");
    } finally {
      value.database.close();
    }
  });

  test("recovers an answered interaction as explicit restart ambiguity", async () => {
    const value = fixture();
    try {
      await driveRunning(value);
      const activity = new DispatchActivityAdapter({
        fence: value.executions,
        store: value.executions,
      });
      await activity.observe({
        accountProfileId: "account_local_execution",
        threadId: "thread_local_execution",
        turnId: "turn_local_execution",
        kind: "waiting_for_input",
      });
      const request: PortableRunInteractionRequest = {
        id: "interaction_restart001",
        kind: "user_input",
        createdAt: 100,
        expiresAt: 1_000,
        questions: [{
          id: "question_restart001",
          header: "Direction",
          prompt: "How should the run continue?",
          allowOther: true,
          options: [],
        }],
      };
      expect(value.executions.requestInteraction({
        accountProfileId: "account_local_execution",
        threadId: "thread_local_execution",
        turnId: "turn_local_execution",
        request,
      })).not.toBeNull();
      const workspaceRevision = value.database.query<{
        revision: number;
      }, [string]>(`
        SELECT revision FROM local_workspaces WHERE workspace_id = ?1
      `).get(value.workspaceId)?.revision;
      if (workspaceRevision === undefined) throw new Error("Workspace disappeared");
      const question = request.questions[0];
      if (question === undefined) throw new Error("Interaction question disappeared");
      const plaintext = "restart-answer-must-remain-ephemeral";
      value.tasks.execute({
        kind: "interaction.respond",
        operationId: publicId("op", 52),
        authority: {
          kind: "local_owner",
          workspaceId: value.workspaceId,
          installationId,
        },
        expectedWorkspaceRevision: workspaceRevision,
        runId: value.runId,
        interactionId: request.id,
        request,
        response: {
          kind: "user_input",
          answers: [{
            questionId: question.id,
            selectedOptionIds: [],
            otherText: plaintext,
          }],
        },
      }, undefined, 200);
      const restarted = new LocalRunExecutionStore({
        database: value.database,
      });
      expect(restarted.recoverAnsweredInteractionsOnRestart())
        .toEqual([value.runId]);
      expect(restarted.read(value.runId)).toMatchObject({
        stage: "ambiguous",
        failureCode: "interaction_restart_ambiguity",
      });
      expect(value.database.query<{ phase: string }, [string]>(`
        SELECT phase FROM local_task_runs WHERE run_id = ?1
      `).get(value.runId)).toEqual({ phase: "ambiguous" });
      expect(restarted.capacityReservations()).toEqual([{
        accountProfileId: "account_local_execution",
        runId: value.runId,
      }]);
      expect(new TextDecoder().decode(value.database.serialize()))
        .not.toContain(plaintext);
    } finally {
      value.database.close();
    }
  });
});
