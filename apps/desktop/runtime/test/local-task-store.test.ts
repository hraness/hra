import { describe, expect, test } from "bun:test";
import { taskDomain } from "@hraness/agent-tasks-protocol";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runtimeTaskMutationSemanticKey,
} from "../../contracts/runtime";
import { applyMigrations } from "../src/state/database";
import {
  LocalMutationAttemptConflict,
  LocalOnboardingConflict,
  LocalOnboardingIdentifierCollision,
  LocalOperationConflict,
  LocalProjectionRevisionConflict,
  LocalTaskStore,
} from "../src/state/local-task-store";

const INSTALLATION_ID = "install_local_tests";
const FINGERPRINT_KEY = new Uint8Array(32).fill(0x42);

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

function fixture(seed = 1) {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  const store = new LocalTaskStore(database, FINGERPRINT_KEY);
  const repositoryId = publicId("repo", seed);
  const workspaceId = publicId("wsp", seed);
  store.registerInstallation(INSTALLATION_ID, 1);
  store.onboardProject({
    installationId: INSTALLATION_ID,
    repository: {
      repositoryId,
      name: "Local repository",
      canonicalRepositoryPath: `/tmp/local-${String(seed)}`,
      canonicalGitCommonDir: `/tmp/local-${String(seed)}/.git`,
    },
    workspace: {
      workspaceId,
      name: "Local workspace",
      slug: `local-${String(seed)}`,
      keyPrefix: `L${String(seed)}`,
    },
  }, 2);
  return { database, store, repositoryId, workspaceId };
}

function countingStore(database: Database): Readonly<{
  count: () => number;
  reset: () => void;
  store: LocalTaskStore;
}> {
  let queryCount = 0;
  const counted = {
    query(sql: string) {
      queryCount += 1;
      return database.query(sql);
    },
    transaction<Return, Args extends unknown[]>(
      callback: (...args: Args) => Return,
    ) {
      return database.transaction(callback);
    },
  } as unknown as Database;
  return {
    count: () => queryCount,
    reset: () => {
      queryCount = 0;
    },
    store: new LocalTaskStore(counted, FINGERPRINT_KEY),
  };
}

function createCommand(input: {
  readonly workspaceId: string;
  readonly operation: number;
  readonly task: number;
  readonly workspaceRevision: number;
  readonly title?: string;
  readonly repositoryId?: string;
  readonly run?: boolean;
}) {
  return {
    kind: input.run === true ? "task.create_and_run" : "task.create",
    operationId: publicId("op", input.operation),
    authority: {
      kind: "local_owner",
      workspaceId: input.workspaceId,
      installationId: INSTALLATION_ID,
    },
    expectedWorkspaceRevision: input.workspaceRevision,
    taskId: publicId("tsk", input.task),
    title: input.title ?? `Task ${String(input.task)}`,
    description: "",
    type: "task",
    priority: 2,
    availableAt: 0,
    labels: [],
    ...(input.repositoryId === undefined ? {} : { repositoryId: input.repositoryId }),
  } as const;
}

function rendererFingerprint(
  command: ReturnType<typeof createCommand> | Record<string, unknown>,
): string {
  const { authority, kind, ...intent } = command;
  void authority;
  return `sha256_${createHash("sha256")
    .update(runtimeTaskMutationSemanticKey(String(kind), { kind, ...intent }))
    .digest("hex")}`;
}

describe("local task authority", () => {
  test("onboards repositories without remotes and replays by canonical Git identity", () => {
    const { database, store, repositoryId, workspaceId } = fixture(1);
    try {
      const replay = store.onboardProject({
        installationId: INSTALLATION_ID,
        repository: {
          repositoryId: publicId("repo", 999),
          name: "A newly suggested label",
          canonicalRepositoryPath: "/tmp/local-1",
          canonicalGitCommonDir: "/tmp/local-1/.git",
        },
        workspace: {
          workspaceId: publicId("wsp", 999),
          name: "Another candidate",
          slug: "another-candidate",
          keyPrefix: "ALT",
        },
      }, 3);
      expect(replay.repository).toEqual({
        id: repositoryId,
        name: "Local repository",
        createdAt: 2,
      });
      expect(replay.workspace.id).toBe(workspaceId);
      expect(JSON.stringify(replay)).not.toContain("/tmp/");
      expect(JSON.stringify(replay)).not.toContain("publicUrl");

      expect(() => store.onboardProject({
        installationId: INSTALLATION_ID,
        repository: {
          repositoryId: publicId("repo", 2),
          name: "Mismatch",
          canonicalRepositoryPath: "/tmp/local-1",
          canonicalGitCommonDir: "/tmp/another/.git",
        },
        workspace: {
          workspaceId: publicId("wsp", 2),
          name: "Mismatch",
          slug: "mismatch",
          keyPrefix: "MIS",
        },
      }, 4)).toThrow(LocalOnboardingConflict);
      expect(() => store.onboardProject({
        installationId: INSTALLATION_ID,
        repository: {
          repositoryId,
          name: "Collision",
          canonicalRepositoryPath: "/tmp/collision",
          canonicalGitCommonDir: "/tmp/collision/.git",
        },
        workspace: {
          workspaceId: publicId("wsp", 3),
          name: "Collision",
          slug: "collision",
          keyPrefix: "COL",
        },
      }, 4)).toThrow(LocalOnboardingIdentifierCollision);
    } finally {
      database.close();
    }
  });

  test("converges concurrent repeated onboarding candidates on one durable project", async () => {
    const { database, store, repositoryId, workspaceId } = fixture(10);
    try {
      const results = await Promise.all(
        Array.from({ length: 32 }, async (_, index) =>
          await Promise.resolve().then(() => store.onboardProject({
            installationId: INSTALLATION_ID,
            repository: {
              repositoryId: publicId("repo", 300_000 + index),
              name: `Candidate ${String(index)}`,
              canonicalRepositoryPath: "/tmp/local-10",
              canonicalGitCommonDir: "/tmp/local-10/.git",
            },
            workspace: {
              workspaceId: publicId("wsp", 300_000 + index),
              name: `Candidate ${String(index)}`,
              slug: `candidate-${String(index)}`,
              keyPrefix: `C${String(index)}`,
            },
          }, 100 + index)),
        ),
      );
      expect(new Set(results.map(({ repository }) => repository.id)))
        .toEqual(new Set([repositoryId]));
      expect(new Set(results.map(({ workspace }) => workspace.id)))
        .toEqual(new Set([workspaceId]));
      expect(database.query<{ count: number }, []>(`
        SELECT count(*) AS count FROM local_repositories
      `).get()?.count).toBe(1);
      expect(database.query<{ count: number }, []>(`
        SELECT count(*) AS count FROM local_workspaces
      `).get()?.count).toBe(1);
    } finally {
      database.close();
    }
  });

  test("commits projection, typed event, and keyed receipt atomically with exact replay", () => {
    const { database, store, workspaceId } = fixture(2);
    try {
      const secret = "guessable private task prose";
      const command = {
        ...createCommand({
          workspaceId,
          operation: 20,
          task: 20,
          workspaceRevision: 1,
          title: "Private",
        }),
        description: secret,
      };
      const committed = store.executeWithDisposition(command, undefined, 10);
      expect(committed.replayed).toBeFalse();
      const { receipt } = committed;
      expect(receipt.outcome).toBe("committed");
      expect(store.executeWithDisposition(command, undefined, 999)).toEqual({
        receipt,
        replayed: true,
      });
      expect(() => store.execute(
        command,
        { kind: "agent", agentId: "builtin_local_codex" },
        999,
      )).toThrow(LocalOperationConflict);
      const stored = database.query<{
        command_digest: string;
        receipt_json: string;
      }, []>(`
        SELECT command_digest, receipt_json FROM local_operation_receipts
      `).get();
      expect(stored?.receipt_json).not.toContain(secret);
      expect(stored?.command_digest).not.toBe(
        `sha256_${createHash("sha256").update(secret).digest("hex")}`,
      );
      expect(database.query<{ count: number }, []>(`
        SELECT count(*) AS count FROM local_workspace_events
      `).get()?.count).toBe(1);
      expect(database.query<{ revision: number; event_sequence: number }, []>(`
        SELECT revision, event_sequence FROM local_workspaces
      `).get()).toEqual({ revision: 2, event_sequence: 1 });

      const otherKeyStore = new LocalTaskStore(database, new Uint8Array(32).fill(0x24));
      expect(() => otherKeyStore.execute(command, undefined, 11))
        .toThrow(LocalOperationConflict);
    } finally {
      database.close();
    }
  });

  test("journals renderer effects with keyed metadata, strict CAS, and exact receipt reconciliation", () => {
    const { database, store, workspaceId } = fixture(21);
    try {
      const attemptId = publicId("op", 21_001);
      const candidateId = publicId("op", 21_002);
      const command = createCommand({
        workspaceId,
        operation: 21_001,
        task: 21_001,
        workspaceRevision: 1,
        title:
          "private title /Users/alice/project github approve_once",
      });
      const rawFingerprint = rendererFingerprint(command);
      const prepared = store.prepareRendererMutationAttempt({
        attemptId,
        workspaceId,
        commandKind: "task.create",
        fingerprint: rawFingerprint,
      }, 10);
      expect(prepared).toEqual({
        attemptId,
        workspaceId,
        commandKind: "task.create",
        revision: 1,
        preparedAt: 10,
        state: "prepared",
      });
      expect(store.prepareRendererMutationAttempt({
        attemptId,
        workspaceId,
        commandKind: "task.create",
        fingerprint: rawFingerprint,
      }, 99)).toEqual(prepared);
      expect(store.prepareRendererMutationAttempt({
        attemptId: candidateId,
        workspaceId,
        commandKind: "task.create",
        fingerprint: rawFingerprint,
      }, 99)).toEqual(prepared);
      expect(() => store.prepareRendererMutationAttempt({
        attemptId,
        workspaceId,
        commandKind: "task.create",
        fingerprint: `sha256_${"f".repeat(64)}`,
      }, 99)).toThrow(LocalMutationAttemptConflict);

      const storedMetadata = database.query<{
        attempt_id: string;
        command_kind: string;
        keyed_fingerprint: string;
      }, []>(`
        SELECT attempt_id, command_kind, keyed_fingerprint
        FROM local_renderer_mutation_attempts
      `).get();
      expect(storedMetadata).toMatchObject({
        attempt_id: attemptId,
        command_kind: "task.create",
      });
      expect(storedMetadata?.keyed_fingerprint).not.toBe(rawFingerprint);
      const serializedMetadata = JSON.stringify(storedMetadata);
      expect(serializedMetadata).not.toContain("private title");
      expect(serializedMetadata).not.toContain("/Users/alice/project");
      expect(serializedMetadata).not.toContain("github");
      expect(serializedMetadata).not.toContain("approve_once");

      const started = store.startRendererMutationAttempt({
        attemptId,
        workspaceId,
        expectedRevision: prepared.revision,
        command,
      }, 11);
      expect(started).toEqual({
        ...prepared,
        revision: 2,
        effectStartedAt: 11,
        state: "effect_started",
      });
      expect(() => store.startRendererMutationAttempt({
        attemptId,
        workspaceId,
        expectedRevision: prepared.revision,
        command,
      }, 12)).toThrow("revision");
      const restartedStore = new LocalTaskStore(database, FINGERPRINT_KEY);
      restartedStore.assertRendererMutationEffectStarted(command);

      const receipt = restartedStore.execute(command, undefined, 12);
      expect(receipt.outcome).toBe("committed");
      const inspected =
        restartedStore.inspectSerializedRendererMutationAttempt({
          attemptId,
          workspaceId,
          expectedRevision: started.revision,
        }, 13);
      expect(inspected.attempt).toEqual(started);
      expect(inspected.receipt).toEqual(receipt);
      expect(inspected.resolution).toMatchObject({
        outcome: "committed",
        mutation: {
          operationId: attemptId,
          workspaceId,
          commandKind: "task.create",
          projectionRevision: 2,
        },
      });
      expect(restartedStore.listOpenRendererMutationAttempts({
        workspaceId,
        limit: 32,
      })).toEqual([started]);
      const reconciled =
        restartedStore.reconcileSerializedRendererMutationAttempt({
          attemptId,
          workspaceId,
          expectedRevision: started.revision,
        }, 14);
      expect(reconciled.attempt).toMatchObject({
        attemptId,
        revision: 3,
        state: "settled",
        terminalOutcome: "committed",
      });
      expect(reconciled.receipt).toEqual(receipt);
      expect(reconciled.resolution).toMatchObject({
        outcome: "committed",
        mutation: {
          operationId: attemptId,
          workspaceId,
          commandKind: "task.create",
          projectionRevision: 2,
        },
      });
      expect(restartedStore.listOpenRendererMutationAttempts({
        workspaceId,
        limit: 32,
      })).toEqual([]);
      expect(() => restartedStore.assertRendererMutationEffectStarted(command))
        .toThrow("not in progress");
      expect(restartedStore.reconcileSerializedRendererMutationAttempt({
        attemptId,
        workspaceId,
        expectedRevision: reconciled.attempt.revision,
      }, 15)).toEqual(reconciled);
    } finally {
      database.close();
    }
  });

  test("proves absent local receipts without replay and reconciles rejected receipts", () => {
    const { database, store, workspaceId } = fixture(22);
    try {
      const preparedCommand = {
        kind: "task.update",
        operationId: publicId("op", 22_001),
        authority: {
          kind: "local_owner",
          workspaceId,
          installationId: INSTALLATION_ID,
        },
        expectedWorkspaceRevision: 1,
        taskId: publicId("tsk", 999),
        expectedTaskRevision: 1,
        patch: { title: "not applied" },
      } as const;
      const prepared = store.prepareRendererMutationAttempt({
        attemptId: preparedCommand.operationId,
        workspaceId,
        commandKind: "task.update",
        fingerprint: rendererFingerprint(preparedCommand),
      }, 10);
      expect(store.inspectSerializedRendererMutationAttempt({
        attemptId: prepared.attemptId,
        workspaceId,
        expectedRevision: prepared.revision,
      }, 11)).toEqual({
        attempt: prepared,
        receipt: null,
        resolution: { outcome: "not_applied" },
      });
      expect(store.listOpenRendererMutationAttempts({
        workspaceId,
        limit: 32,
      })).toEqual([prepared]);
      const preparedResolution =
        store.reconcileSerializedRendererMutationAttempt({
          attemptId: prepared.attemptId,
          workspaceId,
          expectedRevision: prepared.revision,
        }, 12);
      expect(preparedResolution.resolution).toEqual({
        outcome: "not_applied",
      });
      expect(preparedResolution.attempt.effectStartedAt).toBeNull();

      const startedCommand = {
        ...preparedCommand,
        operationId: publicId("op", 22_002),
        patch: { title: "started but not applied" },
      } as const;
      const startedPrepared = store.prepareRendererMutationAttempt({
        attemptId: startedCommand.operationId,
        workspaceId,
        commandKind: "task.update",
        fingerprint: rendererFingerprint(startedCommand),
      }, 13);
      const started = store.startRendererMutationAttempt({
        attemptId: startedPrepared.attemptId,
        workspaceId,
        expectedRevision: startedPrepared.revision,
        command: startedCommand,
      }, 14);
      expect(store.inspectSerializedRendererMutationAttempt({
        attemptId: started.attemptId,
        workspaceId,
        expectedRevision: started.revision,
      }, 15).resolution).toEqual({ outcome: "not_applied" });
      expect(store.reconcileSerializedRendererMutationAttempt({
        attemptId: started.attemptId,
        workspaceId,
        expectedRevision: started.revision,
      }, 16).resolution).toEqual({ outcome: "not_applied" });
      expect(database.query<{ count: number }, []>(`
        SELECT count(*) AS count FROM local_operation_receipts
      `).get()?.count).toBe(0);

      const rejectedCommand = {
        ...preparedCommand,
        operationId: publicId("op", 22_003),
        expectedWorkspaceRevision: 999,
        patch: { title: "never written" },
      } as const;
      const rejectedPrepared = store.prepareRendererMutationAttempt({
        attemptId: rejectedCommand.operationId,
        workspaceId,
        commandKind: "task.update",
        fingerprint: rendererFingerprint(rejectedCommand),
      }, 17);
      const rejectedStarted = store.startRendererMutationAttempt({
        attemptId: rejectedPrepared.attemptId,
        workspaceId,
        expectedRevision: rejectedPrepared.revision,
        command: rejectedCommand,
      }, 18);
      const rejectedReceipt = store.execute(rejectedCommand, undefined, 19);
      expect(rejectedReceipt).toMatchObject({
        outcome: "rejected",
        code: "revision_conflict",
      });
      expect(store.reconcileSerializedRendererMutationAttempt({
        attemptId: rejectedStarted.attemptId,
        workspaceId,
        expectedRevision: rejectedStarted.revision,
      }, 20).resolution).toEqual({
        outcome: "rejected",
        code: "revision_conflict",
      });
    } finally {
      database.close();
    }
  });

  test("binds every materialized semantic field before start and the exact command after start", () => {
    const { database, store, repositoryId, workspaceId } = fixture(24);
    try {
      const command = {
        ...createCommand({
          workspaceId,
          operation: 24_001,
          task: 24_001,
          workspaceRevision: 1,
          repositoryId,
        }),
        labels: ["zeta", "alpha"],
      } as const;
      const prepared = store.prepareRendererMutationAttempt({
        attemptId: command.operationId,
        workspaceId,
        commandKind: command.kind,
        fingerprint: rendererFingerprint(command),
      }, 10);
      const semanticFields = Object.keys(command)
        .filter(
          (field) =>
            field !== "authority" &&
            !taskDomain.taskWorkspaceMutationFenceFieldValues.includes(
              field as never,
            ),
        )
        .sort();
      const semanticVariants = [
        {
          field: "availableAt",
          command: { ...command, availableAt: 1 },
        },
        {
          field: "description",
          command: { ...command, description: "Different description" },
        },
        {
          field: "kind",
          command: { ...command, kind: "task.create_and_run" as const },
        },
        {
          field: "labels",
          command: { ...command, labels: ["different"] },
        },
        {
          field: "operationId",
          command: {
            ...command,
            operationId: publicId("op", 24_002),
          },
        },
        {
          field: "priority",
          command: { ...command, priority: 3 },
        },
        {
          field: "repositoryId",
          command: {
            ...command,
            repositoryId: publicId("repo", 24_002),
          },
        },
        {
          field: "taskId",
          command: { ...command, taskId: publicId("tsk", 24_002) },
        },
        {
          field: "title",
          command: { ...command, title: "Different title" },
        },
        {
          field: "type",
          command: { ...command, type: "bug" as const },
        },
      ];
      expect(semanticVariants.map(({ field }) => field).sort())
        .toEqual(semanticFields);
      for (const variant of semanticVariants) {
        expect(() => store.startRendererMutationAttempt({
          attemptId: prepared.attemptId,
          workspaceId,
          expectedRevision: prepared.revision,
          command: variant.command,
        }, 11)).toThrow(LocalMutationAttemptConflict);
      }

      const refreshedFenceCommand = {
        ...command,
        expectedWorkspaceRevision: 99,
        labels: ["alpha", "zeta"],
      };
      const started = store.startRendererMutationAttempt({
        attemptId: prepared.attemptId,
        workspaceId,
        expectedRevision: prepared.revision,
        command: refreshedFenceCommand,
      }, 12);
      expect(started.state).toBe("effect_started");
      expect(() => store.assertRendererMutationEffectStarted(command))
        .toThrow(LocalMutationAttemptConflict);
      expect(() => store.assertRendererMutationEffectStarted({
        ...refreshedFenceCommand,
        labels: command.labels,
      })).toThrow(LocalMutationAttemptConflict);
      for (const variant of semanticVariants) {
        expect(() => store.assertRendererMutationEffectStarted({
          ...variant.command,
          expectedWorkspaceRevision:
            refreshedFenceCommand.expectedWorkspaceRevision,
        })).toThrow();
      }

      const restartedStore = new LocalTaskStore(database, FINGERPRINT_KEY);
      restartedStore.assertRendererMutationEffectStarted(
        refreshedFenceCommand,
      );
      const stored = database.query<{
        keyed_command_digest: string | null;
      }, [string]>(`
        SELECT keyed_command_digest
        FROM local_renderer_mutation_attempts
        WHERE attempt_id = ?1
      `).get(command.operationId);
      expect(stored?.keyed_command_digest).toMatch(/^sha256_[a-f0-9]{64}$/);
      expect(JSON.stringify(stored)).not.toContain(command.title);
    } finally {
      database.close();
    }
  });

  test("normalizes user-input sets before start but binds their exact post-start shape", () => {
    const { database, store, workspaceId } = fixture(26);
    try {
      const command = {
        kind: "interaction.respond",
        operationId: publicId("op", 26_001),
        authority: {
          kind: "local_owner",
          workspaceId,
          installationId: INSTALLATION_ID,
        },
        expectedWorkspaceRevision: 1,
        runId: "run_interaction26001",
        interactionId: "interaction_primary26001",
        request: {
          id: "interaction_primary26001",
          createdAt: 1,
          expiresAt: 2,
          kind: "user_input",
          questions: [
            {
              id: "question_primary26001",
              header: "First",
              prompt: "Choose first",
              allowOther: false,
              options: [
                { id: "option_primary26001", label: "A" },
                { id: "option_primary26002", label: "B" },
              ],
            },
            {
              id: "question_primary26002",
              header: "Second",
              prompt: "Choose second",
              allowOther: false,
              options: [
                { id: "option_primary26003", label: "C" },
                { id: "option_primary26004", label: "D" },
              ],
            },
          ],
        },
        response: {
          kind: "user_input",
          answers: [
            {
              questionId: "question_primary26001",
              selectedOptionIds: [
                "option_primary26002",
                "option_primary26001",
              ],
            },
            {
              questionId: "question_primary26002",
              selectedOptionIds: [
                "option_primary26004",
                "option_primary26003",
              ],
            },
          ],
        },
      } as const;
      const prepared = store.prepareRendererMutationAttempt({
        attemptId: command.operationId,
        workspaceId,
        commandKind: command.kind,
        fingerprint: rendererFingerprint(command),
      }, 10);
      const permuted = {
        ...command,
        response: {
          kind: "user_input",
          answers: [
            {
              questionId: "question_primary26002",
              selectedOptionIds: [
                "option_primary26003",
                "option_primary26004",
              ],
            },
            {
              questionId: "question_primary26001",
              selectedOptionIds: [
                "option_primary26001",
                "option_primary26002",
              ],
            },
          ],
        },
      } as const;
      const started = store.startRendererMutationAttempt({
        attemptId: prepared.attemptId,
        workspaceId,
        expectedRevision: prepared.revision,
        command: permuted,
      }, 11);
      expect(started.state).toBe("effect_started");
      store.assertRendererMutationEffectStarted(permuted);
      expect(() => store.assertRendererMutationEffectStarted(command))
        .toThrow(LocalMutationAttemptConflict);
    } finally {
      database.close();
    }
  });

  test("quarantines a legacy unbound receipt as ambiguous across reload", () => {
    const { database, store, workspaceId } = fixture(25);
    try {
      const command = createCommand({
        workspaceId,
        operation: 25_001,
        task: 25_001,
        workspaceRevision: 1,
      });
      const prepared = store.prepareRendererMutationAttempt({
        attemptId: command.operationId,
        workspaceId,
        commandKind: command.kind,
        fingerprint: rendererFingerprint(command),
      }, 10);
      const started = store.startRendererMutationAttempt({
        attemptId: prepared.attemptId,
        workspaceId,
        expectedRevision: prepared.revision,
        command,
      }, 11);
      expect(store.execute(command, undefined, 12).outcome).toBe("committed");
      database.query(`
        UPDATE local_renderer_mutation_attempts
        SET keyed_command_digest = NULL
        WHERE attempt_id = ?1
      `).run(command.operationId);

      const restartedStore = new LocalTaskStore(database, FINGERPRINT_KEY);
      const quarantined =
        restartedStore.inspectSerializedRendererMutationAttempt({
          attemptId: started.attemptId,
          workspaceId,
          expectedRevision: started.revision,
        }, 13);
      expect(quarantined).toMatchObject({
        attempt: {
          attemptId: started.attemptId,
          state: "quarantined",
          terminalOutcome: "ambiguous",
          reason: "legacy_unbound_receipt",
        },
        resolution: {
          outcome: "ambiguous",
          reason: "legacy_unbound_receipt",
        },
      });
      expect(restartedStore.listOpenRendererMutationAttempts({
        workspaceId,
        limit: 32,
      })).toEqual([]);
      if (quarantined.attempt.state !== "quarantined") {
        throw new Error("Expected a terminal mutation quarantine.");
      }
      const repeated =
        restartedStore.reconcileSerializedRendererMutationAttempt({
        attemptId: started.attemptId,
        workspaceId,
        expectedRevision: started.revision,
        }, 14);
      expect(quarantined).toEqual(repeated);
      expect(database.query<{ count: number }, [string]>(`
        SELECT count(*) AS count
        FROM local_operation_receipts
        WHERE operation_id = ?1
      `).get(command.operationId)?.count).toBe(1);
      expect(database.query<{ count: number }, [string]>(`
        SELECT count(*) AS count
        FROM local_renderer_mutation_quarantines
        WHERE attempt_id = ?1
      `).get(command.operationId)?.count).toBe(1);
      expect(restartedStore.prepareRendererMutationAttempt({
        attemptId: publicId("op", 25_002),
        workspaceId,
        commandKind: "workspace.rename",
        fingerprint: `sha256_${"d".repeat(64)}`,
      }, 15).state).toBe("prepared");
    } finally {
      database.close();
    }
  });

  test("bounds open attempt listing and compacts terminal metadata", () => {
    const { database, store, workspaceId } = fixture(23);
    try {
      const open = store.prepareRendererMutationAttempt({
        attemptId: publicId("op", 22_999),
        workspaceId,
        commandKind: "workspace.rename",
        fingerprint: `sha256_${"d".repeat(64)}`,
      }, 99);
      expect(store.listOpenRendererMutationAttempts({
        workspaceId,
        limit: 32,
      })).toEqual([open]);
      expect(() => store.prepareRendererMutationAttempt({
        attemptId: publicId("op", 22_998),
        workspaceId,
        commandKind: "task.update",
        fingerprint: `sha256_${"e".repeat(64)}`,
      }, 99)).toThrow("unresolved");
      expect(store.reconcileSerializedRendererMutationAttempt({
        attemptId: open.attemptId,
        workspaceId,
        expectedRevision: open.revision,
      }, 100).resolution).toEqual({ outcome: "not_applied" });

      for (let index = 0; index < 70; index += 1) {
        const attempt = store.prepareRendererMutationAttempt({
          attemptId: publicId("op", 23_000 + index),
          workspaceId,
          commandKind: "workspace.rename",
          fingerprint: `sha256_${index.toString(16).padStart(64, "0")}`,
        }, 101 + index);
        expect(store.reconcileSerializedRendererMutationAttempt({
          attemptId: attempt.attemptId,
          workspaceId,
          expectedRevision: attempt.revision,
        }, 1_000 + attempt.preparedAt).resolution).toEqual({
          outcome: "not_applied",
        });
      }
      expect(database.query<{ count: number }, [string]>(`
        SELECT count(*) AS count
        FROM local_renderer_mutation_attempts
        WHERE workspace_id = ?1 AND state = 'settled'
      `).get(workspaceId)?.count).toBe(64);
      expect(store.listOpenRendererMutationAttempts({
        workspaceId,
        limit: 32,
      })).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("rolls back a rejected mutation and binds operation IDs against drift", () => {
    const { database, store, workspaceId } = fixture(3);
    try {
      const created = {
        ...createCommand({
          workspaceId,
          operation: 30,
          task: 30,
          workspaceRevision: 1,
        }),
        labels: ["existing"],
      };
      expect(store.execute(created, undefined, 10).outcome).toBe("committed");
      const duplicate = {
        kind: "task.label_add",
        operationId: publicId("op", 31),
        authority: created.authority,
        expectedWorkspaceRevision: 2,
        taskId: created.taskId,
        expectedTaskRevision: 1,
        label: "existing",
      } as const;
      const rejected = store.execute(duplicate, undefined, 11);
      expect(rejected).toMatchObject({ outcome: "rejected", code: "invalid_state" });
      expect(database.query<{ revision: number }, [string]>(`
        SELECT revision FROM local_tasks WHERE task_id = ?1
      `).get(created.taskId)?.revision).toBe(1);
      expect(database.query<{ revision: number }, []>(`
        SELECT revision FROM local_workspaces
      `).get()?.revision).toBe(2);
      expect(store.execute(duplicate, undefined, 12)).toEqual(rejected);
      expect(() => store.execute({
        ...duplicate,
        label: "different",
      }, undefined, 12)).toThrow(LocalOperationConflict);
    } finally {
      database.close();
    }
  });

  test("rolls back command writes when the workspace revision CAS is rejected", () => {
    const { database, store, workspaceId } = fixture(31);
    try {
      const created = createCommand({
        workspaceId,
        operation: 310,
        task: 310,
        workspaceRevision: 1,
        title: "Original title",
      });
      expect(store.execute(created, undefined, 10).outcome).toBe("committed");
      database.exec(`
        CREATE TRIGGER reject_workspace_revision_update
        BEFORE UPDATE OF revision ON local_workspaces
        BEGIN
          SELECT RAISE(IGNORE);
        END;
      `);

      const rejected = store.execute({
        kind: "task.update",
        operationId: publicId("op", 311),
        authority: created.authority,
        expectedWorkspaceRevision: 2,
        taskId: created.taskId,
        expectedTaskRevision: 1,
        patch: { title: "Must roll back" },
      }, undefined, 11);

      expect(rejected).toMatchObject({
        outcome: "rejected",
        code: "revision_conflict",
      });
      expect(database.query<{
        title: string;
        revision: number;
      }, [string]>(`
        SELECT title, revision FROM local_tasks WHERE task_id = ?1
      `).get(created.taskId)).toEqual({
        title: "Original title",
        revision: 1,
      });
      expect(database.query<{
        revision: number;
        event_sequence: number;
      }, []>(`
        SELECT revision, event_sequence FROM local_workspaces
      `).get()).toEqual({ revision: 2, event_sequence: 1 });
      expect(database.query<{ count: number }, []>(`
        SELECT count(*) AS count FROM local_workspace_events
      `).get()?.count).toBe(1);
    } finally {
      database.close();
    }
  });

  test("rejects graph cycles and preserves blocker counter and revision laws", () => {
    const { database, store, workspaceId } = fixture(4);
    try {
      const first = createCommand({
        workspaceId,
        operation: 40,
        task: 40,
        workspaceRevision: 1,
      });
      const second = createCommand({
        workspaceId,
        operation: 41,
        task: 41,
        workspaceRevision: 2,
      });
      store.execute(first, undefined, 10);
      store.execute(second, undefined, 11);
      const added = store.execute({
        kind: "dependency.add",
        operationId: publicId("op", 42),
        authority: first.authority,
        expectedWorkspaceRevision: 3,
        taskId: second.taskId,
        expectedTaskRevision: 1,
        blockerTaskId: first.taskId,
        expectedBlockerRevision: 1,
      }, undefined, 12);
      expect(added).toMatchObject({
        outcome: "committed",
        result: { taskRevision: 2 },
      });
      expect(store.taskDetail(workspaceId, second.taskId, 12).task)
        .toMatchObject({ unresolvedBlockerCount: 1, isReady: false, revision: 2 });
      const cycle = store.execute({
        kind: "dependency.add",
        operationId: publicId("op", 43),
        authority: first.authority,
        expectedWorkspaceRevision: 4,
        taskId: first.taskId,
        expectedTaskRevision: 1,
        blockerTaskId: second.taskId,
        expectedBlockerRevision: 2,
      }, undefined, 13);
      expect(cycle).toMatchObject({ outcome: "rejected", code: "graph_cycle" });
      expect(database.query<{ count: number }, []>(`
        SELECT count(*) AS count FROM local_task_dependencies
      `).get()?.count).toBe(1);
    } finally {
      database.close();
    }
  });

  test("rejects dispatch retry while the task has an unresolved blocker", () => {
    const { database, store, repositoryId, workspaceId } = fixture(41);
    try {
      const blocker = createCommand({
        workspaceId,
        operation: 410,
        task: 410,
        workspaceRevision: 1,
      });
      const target = createCommand({
        workspaceId,
        operation: 411,
        task: 411,
        workspaceRevision: 2,
        repositoryId,
      });
      store.execute(blocker, undefined, 10);
      store.execute(target, undefined, 11);
      store.execute({
        kind: "dependency.add",
        operationId: publicId("op", 412),
        authority: target.authority,
        expectedWorkspaceRevision: 3,
        taskId: target.taskId,
        expectedTaskRevision: 1,
        blockerTaskId: blocker.taskId,
        expectedBlockerRevision: 1,
      }, undefined, 12);
      const sourceRunId = "run_failed_source_410";
      database.query(`
        INSERT INTO local_task_runs (
          workspace_id, task_id, run_id, repository_id, phase, desired_state,
          fence, recovery_state, finished_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, 'failed', 'run', 1, 'none', 13, 13, 13)
      `).run(workspaceId, target.taskId, sourceRunId, repositoryId);

      expect(store.execute({
        kind: "dispatch.retry",
        operationId: publicId("op", 413),
        authority: target.authority,
        expectedWorkspaceRevision: 4,
        taskId: target.taskId,
        expectedTaskRevision: 2,
        sourceRunId,
      }, undefined, 14)).toMatchObject({
        outcome: "rejected",
        code: "invalid_state",
      });
      expect(database.query<{ count: number }, []>(`
        SELECT count(*) AS count FROM local_queued_run_intents
      `).get()?.count).toBe(0);
    } finally {
      database.close();
    }
  });

  test("suspends a queued dependent when its blocker reopens and requeues it when unblocked", () => {
    const { database, store, repositoryId, workspaceId } = fixture(42);
    try {
      const blocker = createCommand({
        workspaceId,
        operation: 420,
        task: 420,
        workspaceRevision: 1,
      });
      const target = createCommand({
        workspaceId,
        operation: 421,
        task: 421,
        workspaceRevision: 2,
        repositoryId,
      });
      store.execute(blocker, undefined, 10);
      store.execute(target, undefined, 11);
      store.execute({
        kind: "dependency.add",
        operationId: publicId("op", 422),
        authority: target.authority,
        expectedWorkspaceRevision: 3,
        taskId: target.taskId,
        expectedTaskRevision: 1,
        blockerTaskId: blocker.taskId,
        expectedBlockerRevision: 1,
      }, undefined, 12);
      database.query(`
        UPDATE local_tasks
        SET status = 'done', completed_at = 13, updated_at = 13
        WHERE workspace_id = ?1 AND task_id = ?2
      `).run(workspaceId, blocker.taskId);
      expect(store.execute({
        kind: "workspace.repair",
        operationId: publicId("op", 423),
        workspaceId,
        expectedWorkspaceRevision: 4,
      }, undefined, 14)).toMatchObject({ outcome: "committed" });

      const sourceRunId = "run_failed_source_420";
      database.query(`
        INSERT INTO local_task_runs (
          workspace_id, task_id, run_id, repository_id, phase, desired_state,
          fence, recovery_state, finished_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, 'failed', 'run', 1, 'none', 15, 15, 15)
      `).run(workspaceId, target.taskId, sourceRunId, repositoryId);
      const retried = store.execute({
        kind: "dispatch.retry",
        operationId: publicId("op", 424),
        authority: target.authority,
        expectedWorkspaceRevision: 5,
        taskId: target.taskId,
        expectedTaskRevision: 2,
        sourceRunId,
      }, undefined, 16);
      if (
        retried.outcome !== "committed" ||
        retried.result.kind !== "run_updated"
      ) {
        throw new Error("Ready task retry did not queue");
      }

      expect(store.execute({
        kind: "task.reopen",
        operationId: publicId("op", 425),
        authority: blocker.authority,
        expectedWorkspaceRevision: 6,
        taskId: blocker.taskId,
        expectedTaskRevision: 1,
      }, undefined, 17)).toMatchObject({ outcome: "committed" });
      expect(database.query<{
        intent_state: string;
        due_state: string;
        last_error_code: string | null;
      }, [string]>(`
        SELECT intent.state AS intent_state, due.state AS due_state,
          due.last_error_code
        FROM local_queued_run_intents AS intent
        JOIN local_due_work AS due
          ON due.workspace_id = intent.workspace_id
          AND due.work_kind = 'queued_run'
          AND due.entity_id = intent.run_id
        WHERE intent.run_id = ?1
      `).get(retried.result.runId)).toEqual({
        intent_state: "queued",
        due_state: "cancelled",
        last_error_code: "task_not_ready",
      });

      expect(store.execute({
        kind: "dependency.remove",
        operationId: publicId("op", 426),
        authority: target.authority,
        expectedWorkspaceRevision: 7,
        taskId: target.taskId,
        expectedTaskRevision: 2,
        blockerTaskId: blocker.taskId,
        expectedBlockerRevision: 2,
      }, undefined, 18)).toMatchObject({ outcome: "committed" });
      expect(database.query<{
        intent_state: string;
        due_state: string;
        expected_revision: number | null;
        last_error_code: string | null;
      }, [string]>(`
        SELECT intent.state AS intent_state, due.state AS due_state,
          due.expected_revision, due.last_error_code
        FROM local_queued_run_intents AS intent
        JOIN local_due_work AS due
          ON due.workspace_id = intent.workspace_id
          AND due.work_kind = 'queued_run'
          AND due.entity_id = intent.run_id
        WHERE intent.run_id = ?1
      `).get(retried.result.runId)).toEqual({
        intent_state: "queued",
        due_state: "pending",
        expected_revision: 3,
        last_error_code: null,
      });
    } finally {
      database.close();
    }
  });

  test("enforces submission fences, review revisions, and agent self-review denial", () => {
    const { database, store, workspaceId } = fixture(9);
    try {
      const blocker = createCommand({
        workspaceId,
        operation: 90,
        task: 90,
        workspaceRevision: 1,
      });
      const target = createCommand({
        workspaceId,
        operation: 91,
        task: 91,
        workspaceRevision: 2,
      });
      store.execute(blocker, undefined, 10);
      store.execute(target, undefined, 11);
      store.execute({
        kind: "dependency.add",
        operationId: publicId("op", 92),
        authority: target.authority,
        expectedWorkspaceRevision: 3,
        taskId: target.taskId,
        expectedTaskRevision: 1,
        blockerTaskId: blocker.taskId,
        expectedBlockerRevision: 1,
      }, undefined, 12);
      database.query(`
        UPDATE local_tasks SET status = 'done', completed_at = 13
        WHERE workspace_id = ?1 AND task_id = ?2
      `).run(workspaceId, blocker.taskId);
      database.query(`
        UPDATE local_tasks
        SET status = 'in_progress', unresolved_blocker_count = 0
        WHERE workspace_id = ?1 AND task_id = ?2
      `).run(workspaceId, target.taskId);
      database.query(`
        INSERT INTO local_task_claims (
          workspace_id, task_id, claim_id, agent_id, fence, lease_generation,
          lease_until, state, boot_generation, created_at, updated_at
        ) VALUES (?1, ?2, 'claim_local_review', 'agent_worker', 1, 1, 1000,
          'active', 1, 13, 13)
      `).run(workspaceId, target.taskId);

      const submitted = store.execute({
        kind: "task.submit",
        operationId: publicId("op", 93),
        authority: target.authority,
        expectedWorkspaceRevision: 4,
        taskId: target.taskId,
        expectedTaskRevision: 2,
        expectedReviewRevision: 2,
        fence: 1,
        summary: "Ready for review.",
        evidence: [{ kind: "test", command: "bun test" }],
      }, { kind: "agent", agentId: "agent_worker" }, 14);
      expect(submitted).toMatchObject({
        outcome: "committed",
        result: { kind: "submission_updated", taskRevision: 3 },
      });
      if (
        submitted.outcome !== "committed" ||
        submitted.result.kind !== "submission_updated"
      ) {
        throw new Error("Submission fixture did not commit");
      }
      const selfReview = store.execute({
        kind: "review.accept",
        operationId: publicId("op", 94),
        authority: target.authority,
        expectedWorkspaceRevision: 5,
        taskId: target.taskId,
        submissionId: submitted.result.submissionId,
        expectedReviewRevision: 2,
      }, { kind: "agent", agentId: "agent_worker" }, 15);
      expect(selfReview).toMatchObject({ outcome: "rejected", code: "invalid_state" });

      const accepted = store.execute({
        kind: "review.accept",
        operationId: publicId("op", 95),
        authority: target.authority,
        expectedWorkspaceRevision: 5,
        taskId: target.taskId,
        submissionId: submitted.result.submissionId,
        expectedReviewRevision: 2,
      }, { kind: "agent", agentId: "agent_reviewer" }, 16);
      expect(accepted).toMatchObject({
        outcome: "committed",
        result: { taskRevision: 4 },
      });
      expect(store.taskDetail(workspaceId, target.taskId, 16))
        .toMatchObject({
          task: { status: "done", revision: 4, reviewRevision: 2 },
          submission: {
            id: submitted.result.submissionId,
            status: "accepted",
            reviewRevision: 2,
          },
        });
    } finally {
      database.close();
    }
  });

  test("binds cursors to immutable continuation revisions", () => {
    const { database, store, workspaceId } = fixture(5);
    try {
      for (let index = 0; index < 4; index += 1) {
        store.execute(createCommand({
          workspaceId,
          operation: 50 + index,
          task: 50 + index,
          workspaceRevision: 1 + index,
        }), undefined, 10 + index);
      }
      const first = store.listTasks({
        workspaceId,
        view: "all",
        limit: 2,
        now: 20,
      });
      expect(first.items).toHaveLength(2);
      expect(first.hasMore).toBeTrue();
      expect(first.cursor).not.toBeNull();
      const atomic = store.taskWorkspaceProjection({
        workspaceId,
        expectedWorkspaceRevision: first.projectionRevision,
        view: "all",
        selectedTaskId: null,
        minimumRevision: null,
        limit: 2,
      }, new Set(), 20);
      expect(atomic.projection.firstPage.cursor).toBe(first.cursor);
      expect(atomic.projection.continuationRevision)
        .toBe(first.projectionRevision);
      expect(store.listTasks({
        workspaceId,
        view: "all",
        cursor: atomic.projection.firstPage.cursor,
        continuationRevision: atomic.projection.continuationRevision,
        limit: 2,
      }).items).toHaveLength(2);
      store.execute({
        kind: "workspace.rename",
        operationId: publicId("op", 60),
        authority: {
          kind: "local_owner",
          workspaceId,
          installationId: INSTALLATION_ID,
        },
        expectedWorkspaceRevision: 5,
        name: "Renamed",
      }, undefined, 21);
      expect(() => store.listTasks({
        workspaceId,
        view: "all",
        cursor: first.cursor,
        continuationRevision: first.projectionRevision,
        limit: 2,
      })).toThrow(LocalProjectionRevisionConflict);
    } finally {
      database.close();
    }
  });

  test("lists any assigned task by default and supports an exact-agent filter", () => {
    const { database, store, workspaceId } = fixture(50);
    try {
      const firstTaskId = publicId("tsk", 501);
      const secondTaskId = publicId("tsk", 502);
      for (const [index, id] of [firstTaskId, secondTaskId, publicId("tsk", 503)].entries()) {
        store.execute({
          ...createCommand({
            workspaceId,
            operation: 501 + index,
            task: 501 + index,
            workspaceRevision: 1 + index,
          }),
          taskId: id,
        }, undefined, 10 + index);
      }
      store.execute({
        kind: "task.assign",
        operationId: publicId("op", 510),
        authority: {
          kind: "local_owner",
          workspaceId,
          installationId: INSTALLATION_ID,
        },
        expectedWorkspaceRevision: 4,
        taskId: firstTaskId,
        expectedTaskRevision: 1,
        assigneeAgentId: "agent_alpha",
      }, undefined, 20);
      store.execute({
        kind: "task.assign",
        operationId: publicId("op", 511),
        authority: {
          kind: "local_owner",
          workspaceId,
          installationId: INSTALLATION_ID,
        },
        expectedWorkspaceRevision: 5,
        taskId: secondTaskId,
        expectedTaskRevision: 1,
        assigneeAgentId: "agent_beta",
      }, undefined, 21);

      const anyAssigned = store.listTasks({
        workspaceId,
        view: "assigned",
        limit: 100,
        now: 30,
      });
      expect(anyAssigned.assignedAgentId).toBeUndefined();
      expect(new Set(anyAssigned.items.map(({ task }) => task.id))).toEqual(
        new Set([firstTaskId, secondTaskId]),
      );

      const exactAgent = store.listTasks({
        workspaceId,
        view: "assigned",
        assignedAgentId: "agent_alpha",
        limit: 100,
        now: 30,
      });
      expect(exactAgent.assignedAgentId).toBe("agent_alpha");
      expect(exactAgent.items.map(({ task }) => task.id)).toEqual([firstTaskId]);

      expect(() => store.listTasks({
        workspaceId,
        view: "all",
        assignedAgentId: "agent_alpha",
        limit: 100,
        now: 30,
      })).toThrow();
    } finally {
      database.close();
    }
  });

  test("reads atomic roots with a fixed query count for one or one hundred tasks", () => {
    const { database, store, repositoryId, workspaceId } = fixture(51);
    try {
      const selectedTaskId = publicId("tsk", 51_001);
      store.execute({
        ...createCommand({
          workspaceId,
          operation: 51_001,
          task: 51_001,
          workspaceRevision: 1,
        }),
        taskId: selectedTaskId,
      }, undefined, 10);
      const counted = countingStore(database);
      const read = (selectedTaskIdValue: string | null) => {
        counted.reset();
        const projection = counted.store.taskWorkspaceProjection({
          workspaceId,
          expectedWorkspaceRevision:
            store.listWorkspaceSummaries(100).find(
              ({ id }) => id === workspaceId,
            )?.revision ?? 0,
          view: "all",
          selectedTaskId: selectedTaskIdValue,
          minimumRevision: null,
          limit: 100,
        }, new Set([repositoryId]), 100);
        return { projection, queries: counted.count() };
      };

      const oneUnselected = read(null);
      const oneSelected = read(selectedTaskId);
      expect(oneUnselected.projection.projection.firstPage.items).toHaveLength(1);
      expect(oneUnselected.queries).toBeLessThanOrEqual(8);
      expect(oneSelected.queries).toBeLessThanOrEqual(19);

      for (let index = 2; index <= 100; index += 1) {
        store.execute(createCommand({
          workspaceId,
          operation: 51_000 + index,
          task: 51_000 + index,
          workspaceRevision: index,
        }), undefined, 10 + index);
      }
      const hundredUnselected = read(null);
      const hundredSelected = read(selectedTaskId);
      expect(hundredUnselected.projection.projection.firstPage.items)
        .toHaveLength(100);
      expect(hundredUnselected.queries).toBe(oneUnselected.queries);
      expect(hundredSelected.queries).toBe(oneSelected.queries);
      expect(hundredUnselected.queries).toBe(7);
      expect(hundredSelected.queries).toBe(17);
    } finally {
      database.close();
    }
  });

  test("enforces atomic projection floors, selected-task identity, and recovery remapping", () => {
    const { database, store, workspaceId } = fixture(52);
    try {
      const taskId = publicId("tsk", 52_001);
      store.execute({
        ...createCommand({
          workspaceId,
          operation: 52_001,
          task: 52_001,
          workspaceRevision: 1,
        }),
        taskId,
      }, undefined, 10);
      const input = {
        workspaceId,
        expectedWorkspaceRevision: 2,
        view: "all" as const,
        selectedTaskId: taskId,
        minimumRevision: 2,
        limit: 100,
      };
      const projection = store.taskWorkspaceProjection(
        input,
        new Set(),
        20,
      );
      expect(projection.projection).toMatchObject({
        workspaceId,
        selectedTaskId: taskId,
        projectionRevision: 2,
        continuationRevision: 2,
        detail: {
          workspaceId,
          task: { id: taskId },
        },
      });
      expect(() => store.taskWorkspaceProjection({
        ...input,
        minimumRevision: 3,
      }, new Set(), 20)).toThrow(LocalProjectionRevisionConflict);
      expect(() => store.taskWorkspaceProjection({
        ...input,
        expectedWorkspaceRevision: 1,
      }, new Set(), 20)).toThrow(LocalProjectionRevisionConflict);
      expect(() => store.taskWorkspaceProjection({
        ...input,
        selectedTaskId: publicId("tsk", 52_999),
      }, new Set(), 20)).toThrow("Task does not exist");

      database.query(`
        UPDATE local_workspaces
        SET authority_kind = 'cloud',
          promotion_id = ?2,
          authority_phase = NULL,
          cloud_workspace_id = ?3
        WHERE workspace_id = ?1
      `).run(
        workspaceId,
        "promotion_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        publicId("wsp", 52_999),
      );
      const presentedWorkspaceId = publicId("wsp", 52_999);
      const recovery = store.recoveryTaskWorkspaceProjection({
        localWorkspaceId: workspaceId,
        presentedWorkspaceId,
        expectedWorkspaceRevision: 2,
        view: "all",
        selectedTaskId: taskId,
        minimumRevision: 2,
        limit: 100,
      }, 21);
      expect(recovery.workspace.id).toBe(presentedWorkspaceId);
      expect(recovery.projection.workspaceId).toBe(presentedWorkspaceId);
      expect(recovery.projection.firstPage.workspaceId)
        .toBe(presentedWorkspaceId);
      expect(recovery.projection.detail?.workspaceId)
        .toBe(presentedWorkspaceId);
      expect(recovery.repositories.every(({ ready }) => !ready)).toBeTrue();
    } finally {
      database.close();
    }
  });

  test("bounds run interactions per run instead of across the selected detail", () => {
    const { database, store, repositoryId, workspaceId } = fixture(53);
    try {
      const taskId = publicId("tsk", 53_001);
      store.execute({
        ...createCommand({
          workspaceId,
          operation: 53_001,
          task: 53_001,
          workspaceRevision: 1,
        }),
        taskId,
      }, undefined, 10);
      const insertRun = database.query(`
        INSERT INTO local_task_runs (
          workspace_id, task_id, run_id, repository_id, phase,
          desired_state, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, 'failed', 'run', ?5, ?5)
      `);
      const insertInteraction = database.query(`
        INSERT INTO local_run_interactions (
          workspace_id, run_id, interaction_id, request_json, state,
          resolved_at, created_at, expires_at
        ) VALUES (?1, ?2, ?3, ?4, 'expired', ?5, ?6, ?7)
      `);
      const runIds = [
        "run_00000000000000000000000001",
        "run_00000000000000000000000002",
      ] as const;
      for (const [runIndex, runId] of runIds.entries()) {
        insertRun.run(
          workspaceId,
          taskId,
          runId,
          repositoryId,
          20 + runIndex,
        );
        for (
          let index = 0;
          index < taskDomain.MAX_TASK_HUMAN_INPUT_PENDING_COUNT;
          index += 1
        ) {
          const interactionId =
            `interaction_${String(
              53_000 + runIndex * 100 + index,
            ).padStart(26, "0")}`;
          const createdAt = 100 + runIndex * 100 + index;
          insertInteraction.run(
            workspaceId,
            runId,
            interactionId,
            JSON.stringify({
              id: interactionId,
              createdAt,
              expiresAt: createdAt + 1_000,
              kind: "file_change_approval",
              scope: "once",
            }),
            createdAt + 1,
            createdAt,
            createdAt + 1_000,
          );
        }
      }
      const input = {
        workspaceId,
        expectedWorkspaceRevision: 2,
        view: "all" as const,
        selectedTaskId: taskId,
        minimumRevision: null,
        limit: 100,
      };
      const bounded = store.taskWorkspaceProjection(
        input,
        new Set([repositoryId]),
        1_000,
      );
      expect(bounded.projection.detail?.runs).toHaveLength(2);
      expect(bounded.projection.detail?.runs.map(
        ({ interactions }) => interactions.length,
      )).toEqual([
        taskDomain.MAX_TASK_HUMAN_INPUT_PENDING_COUNT,
        taskDomain.MAX_TASK_HUMAN_INPUT_PENDING_COUNT,
      ]);

      const overflowId = "interaction_00000000000000000000053999";
      insertInteraction.run(
        workspaceId,
        runIds[1],
        overflowId,
        JSON.stringify({
          id: overflowId,
          createdAt: 500,
          expiresAt: 1_500,
          kind: "file_change_approval",
          scope: "once",
        }),
        501,
        500,
        1_500,
      );
      expect(() => store.taskWorkspaceProjection(
        input,
        new Set([repositoryId]),
        1_000,
      )).toThrow("Run interaction projection exceeds its bound");
    } finally {
      database.close();
    }
  });

  test("returns an old-or-new projection when a WAL writer commits mid-read", () => {
    const root = mkdtempSync(join(tmpdir(), "oprte-atomic-projection-"));
    const databasePath = join(root, "control-plane.sqlite");
    const reader = new Database(databasePath, { create: true, strict: true });
    let writer: Database | null = null;
    try {
      reader.exec("PRAGMA journal_mode = WAL");
      reader.exec("PRAGMA foreign_keys = ON");
      applyMigrations(reader);
      const setup = new LocalTaskStore(reader, FINGERPRINT_KEY);
      const workspaceId = publicId("wsp", 54);
      const repositoryId = publicId("repo", 54);
      const taskId = publicId("tsk", 54_001);
      setup.registerInstallation(INSTALLATION_ID, 1);
      setup.onboardProject({
        installationId: INSTALLATION_ID,
        repository: {
          repositoryId,
          name: "Local repository",
          canonicalRepositoryPath: "/tmp/local-54",
          canonicalGitCommonDir: "/tmp/local-54/.git",
        },
        workspace: {
          workspaceId,
          name: "Old workspace",
          slug: "old-workspace",
          keyPrefix: "W54",
        },
      }, 2);
      reader.query(`
        INSERT INTO local_tasks (
          workspace_id, task_id, task_key, title, task_type, priority,
          status, available_at, created_at, updated_at
        ) VALUES (?1, ?2, 'W54-0000001', 'Old task', 'task', 2, 'open', 0, 3, 3)
      `).run(workspaceId, taskId);
      reader.query(`
        INSERT INTO local_task_bodies (
          workspace_id, task_id, description, updated_at
        ) VALUES (?1, ?2, '', 3)
      `).run(workspaceId, taskId);

      writer = new Database(databasePath, { strict: true });
      writer.exec("PRAGMA journal_mode = WAL");
      writer.exec("PRAGMA foreign_keys = ON");
      let interleaved = false;
      const interleavedDatabase = {
        query(sql: string) {
          const statement = reader.query(sql);
          if (
            !sql.includes("FROM local_workspaces") ||
            !sql.includes("WHERE workspace_id = ?1")
          ) {
            return statement;
          }
          return {
            get(workspaceIdValue: string) {
              const row = statement.get(workspaceIdValue);
              if (!interleaved) {
                interleaved = true;
                writer?.transaction(() => {
                  writer?.query(`
                    UPDATE local_tasks
                    SET title = 'New task', revision = 2, updated_at = 11
                    WHERE workspace_id = ?1 AND task_id = ?2
                  `).run(workspaceId, taskId);
                  writer?.query(`
                    UPDATE local_workspaces
                    SET name = 'New workspace', revision = 2,
                      updated_at = 11
                    WHERE workspace_id = ?1
                  `).run(workspaceId);
                })();
              }
              return row;
            },
          };
        },
        transaction<Return, Args extends unknown[]>(
          callback: (...args: Args) => Return,
        ) {
          return reader.transaction(callback);
        },
      } as unknown as Database;
      const store = new LocalTaskStore(
        interleavedDatabase,
        FINGERPRINT_KEY,
      );
      const old = store.taskWorkspaceProjection({
        workspaceId,
        expectedWorkspaceRevision: 1,
        view: "all",
        selectedTaskId: taskId,
        minimumRevision: 1,
        limit: 100,
      }, new Set([repositoryId]), 10);
      expect(interleaved).toBeTrue();
      expect({
        revision: old.projection.projectionRevision,
        workspace: old.workspace.name,
        task: old.projection.detail?.task.title,
      }).toEqual({
        revision: 1,
        workspace: "Old workspace",
        task: "Old task",
      });

      const current = setup.taskWorkspaceProjection({
        workspaceId,
        expectedWorkspaceRevision: 2,
        view: "all",
        selectedTaskId: taskId,
        minimumRevision: 2,
        limit: 100,
      }, new Set([repositoryId]), 12);
      expect({
        revision: current.projection.projectionRevision,
        workspace: current.workspace.name,
        task: current.projection.detail?.task.title,
      }).toEqual({
        revision: 2,
        workspace: "New workspace",
        task: "New task",
      });
    } finally {
      writer?.close();
      reader.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("fails closed when durable workspace summaries exceed the renderer bound", () => {
    const { database, store } = fixture(8);
    try {
      const insert = database.query(`
        INSERT INTO local_workspaces (
          workspace_id, name, slug, key_prefix, authority_kind,
          owner_installation_id, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, 'local', ?5, ?6, ?6)
      `);
      for (let index = 0; index < 64; index += 1) {
        insert.run(
          publicId("wsp", 200_000 + index),
          `Workspace ${String(index)}`,
          `workspace-${String(index)}`,
          `W${String(index)}`,
          INSTALLATION_ID,
          100 + index,
        );
      }
      expect(() => store.listWorkspaceSummaries(1_000)).toThrow("exceeds its bound");
    } finally {
      database.close();
    }
  });

  test("handles 10,000 tasks, a 500-dependent fan-out, and bounded pages", () => {
    const { database, store, workspaceId } = fixture(6);
    try {
      const insertTasks = database.transaction(() => {
        const taskStatement = database.query(`
          INSERT INTO local_tasks (
            workspace_id, task_id, task_key, title, task_type, priority,
            status, available_at, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, 'task', 2, 'open', 0, ?5, ?5)
        `);
        const bodyStatement = database.query(`
          INSERT INTO local_task_bodies (
            workspace_id, task_id, description, updated_at
          ) VALUES (?1, ?2, '', ?3)
        `);
        for (let index = 1; index <= 10_000; index += 1) {
          const taskId = publicId("tsk", 100_000 + index);
          taskStatement.run(
            workspaceId,
            taskId,
            `L6-${taskId.slice(-7)}`,
            `Task ${String(index)}`,
            index,
          );
          bodyStatement.run(workspaceId, taskId, index);
        }
      });
      insertTasks();
      const blockerId = publicId("tsk", 100_001);
      const insertEdges = database.transaction(() => {
        const statement = database.query(`
          INSERT INTO local_task_dependencies (
            workspace_id, blocker_task_id, blocked_task_id, created_at
          ) VALUES (?1, ?2, ?3, ?4)
        `);
        for (let index = 2; index <= 501; index += 1) {
          statement.run(
            workspaceId,
            blockerId,
            publicId("tsk", 100_000 + index),
            index,
          );
        }
      });
      insertEdges();
      const page = store.listTasks({
        workspaceId,
        view: "all",
        limit: 100,
        now: 20_000,
      });
      expect(page.items).toHaveLength(100);
      expect(page.hasMore).toBeTrue();
      expect(page.cursor).not.toBeNull();
      const detail = store.taskDetail(workspaceId, blockerId, 20_000);
      expect(detail.dependents).toHaveLength(500);
      expect(detail.truncatedCollections).not.toContain("dependents");

      const overflow = store.execute({
        kind: "dependency.add",
        operationId: publicId("op", 70),
        authority: {
          kind: "local_owner",
          workspaceId,
          installationId: INSTALLATION_ID,
        },
        expectedWorkspaceRevision: 1,
        taskId: publicId("tsk", 100_502),
        expectedTaskRevision: 1,
        blockerTaskId: blockerId,
        expectedBlockerRevision: 1,
      }, undefined, 20_001);
      expect(overflow).toMatchObject({ outcome: "rejected", code: "capacity_full" });

      database.query(`
        INSERT INTO local_task_dependencies (
          workspace_id, blocker_task_id, blocked_task_id, created_at
        ) VALUES (?1, ?2, ?3, ?4)
      `).run(
        workspaceId,
        blockerId,
        publicId("tsk", 100_502),
        20_002,
      );
      const atomic = store.taskWorkspaceProjection({
        workspaceId,
        expectedWorkspaceRevision: 1,
        view: "all",
        selectedTaskId: blockerId,
        minimumRevision: 1,
        limit: 100,
      }, new Set(), 20_003);
      expect(atomic.projection.firstPage.items).toHaveLength(100);
      expect(atomic.projection.detail?.dependents).toHaveLength(500);
      expect(atomic.projection.detail?.truncatedCollections)
        .toContain("dependents");
    } finally {
      database.close();
    }
  }, 20_000);

  test("allows one operation history under 100 colliding operation IDs", () => {
    const { database, store, workspaceId } = fixture(7);
    try {
      const command = createCommand({
        workspaceId,
        operation: 80,
        task: 80,
        workspaceRevision: 1,
      });
      store.execute(command, undefined, 10);
      for (let index = 0; index < 100; index += 1) {
        expect(() => store.execute({
          ...command,
          title: `Collision ${String(index)}`,
        }, undefined, 11 + index)).toThrow(LocalOperationConflict);
      }
      expect(database.query<{ count: number }, []>(`
        SELECT count(*) AS count FROM local_operation_receipts
      `).get()?.count).toBe(1);
      expect(database.query<{ count: number }, []>(`
        SELECT count(*) AS count FROM local_workspace_events
      `).get()?.count).toBe(1);
      expect(database.query<{ count: number }, []>(`
        SELECT count(*) AS count FROM local_tasks
      `).get()?.count).toBe(1);
    } finally {
      database.close();
    }
  });
});
