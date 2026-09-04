import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  createProfileId,
  createProjectId,
  createSessionId,
  type SessionId,
} from "../domain/values";
import {
  SESSION_TASK_LIMIT,
  SESSION_TASK_MAX_INTERVAL_MINUTES,
} from "../domain/session-tasks";
import {
  SESSION_TASK_SCHEMA_SQL,
  SessionTaskStore,
  SessionTaskStoreError,
  assertSessionTaskSchema,
  type SessionTaskStoreErrorCode,
} from "./session-task-store";

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close(false);
});

const parentSchema = `
CREATE TABLE daemon_state (
  singleton INTEGER PRIMARY KEY,
  generation INTEGER NOT NULL
) STRICT;
INSERT INTO daemon_state(singleton,generation) VALUES (1,7);
CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  process_generation INTEGER NOT NULL
) STRICT;
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL
) STRICT;
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  project_id TEXT REFERENCES projects(id),
  provider_thread_id TEXT,
  state TEXT NOT NULL
) STRICT;
CREATE TABLE queue_sequence_authority (
  singleton INTEGER PRIMARY KEY,
  next_sequence INTEGER NOT NULL
) STRICT;
INSERT INTO queue_sequence_authority(singleton,next_sequence) VALUES (1,1);
CREATE TABLE queue_entries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  state TEXT NOT NULL,
  enqueue_sequence INTEGER NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
`;

let uuidSequence = 0;
const idempotencyKey = (): string =>
  `123e4567-e89b-42d3-a456-${(++uuidSequence).toString(16).padStart(12, "0")}`;

type Fixture = Readonly<{
  database: Database;
  now: { value: number };
  otherSessionId: SessionId;
  sessionId: SessionId;
  store: SessionTaskStore;
}>;

function fixture(input: Readonly<{
  resolveProjectDirectory?: (root: string) => Promise<string | null>;
}> = {}): Fixture {
  const database = new Database(":memory:", { strict: true });
  databases.push(database);
  database.exec("PRAGMA foreign_keys=ON;");
  database.exec(parentSchema);
  database.exec(SESSION_TASK_SCHEMA_SQL);
  assertSessionTaskSchema(database);
  const accountId = createProfileId();
  const projectId = createProjectId();
  const sessionId = createSessionId();
  const otherSessionId = createSessionId();
  database.query(
    "INSERT INTO profiles(id,state,process_generation) VALUES (?,'signed_in',1)",
  ).run(accountId);
  database.query("INSERT INTO projects(id,root_path) VALUES (?,?)").run(projectId, "/project");
  for (const id of [sessionId, otherSessionId]) {
    database.query(
      `INSERT INTO sessions(id,profile_id,project_id,provider_thread_id,state)
       VALUES (?,?,? ,?,'idle')`,
    ).run(id, accountId, projectId, `thread-${id}`);
  }
  const now = { value: 1_000 };
  const store = new SessionTaskStore(database, {
    now: () => now.value,
    resolveProjectDirectory: input.resolveProjectDirectory ?? (async (root) => root),
  });
  return { database, now, otherSessionId, sessionId, store };
}

const createTask = (
  value: Fixture,
  input: Readonly<{
    idempotencyKey?: string;
    name?: string;
    prompt?: string;
    status?: "active" | "paused";
  }> = {},
) => value.store.create({
  sessionId: value.sessionId,
  name: input.name ?? "Conversation review",
  prompt: input.prompt ?? "Review this conversation.",
  minutes: 15,
  status: input.status ?? "active",
  idempotencyKey: input.idempotencyKey ?? idempotencyKey(),
});

const expectStoreCode = (
  callback: () => unknown,
  code: SessionTaskStoreErrorCode,
): void => {
  try {
    callback();
    throw new Error("Expected SessionTaskStoreError.");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(SessionTaskStoreError);
    expect((error as SessionTaskStoreError).code).toBe(code);
  }
};

describe("SessionTaskStore schema authority", () => {
  const databaseWithSchema = (schema: string): Database => {
    const database = new Database(":memory:", { strict: true });
    databases.push(database);
    database.exec("PRAGMA foreign_keys=ON;");
    database.exec(parentSchema);
    database.exec(schema);
    return database;
  };

  test("rejects wrong object types, non-STRICT tables, foreign-key drift, and invariant drift", () => {
    const wrongType = databaseWithSchema(SESSION_TASK_SCHEMA_SQL);
    wrongType.exec(`
      DROP INDEX session_tasks_due;
      CREATE TABLE session_tasks_due (value INTEGER) STRICT;
    `);
    expect(() => assertSessionTaskSchema(wrongType)).toThrow(
      "STATE_SESSION_TASK_SCHEMA_INVALID",
    );

    const nonStrict = databaseWithSchema(SESSION_TASK_SCHEMA_SQL.replace(
      ") STRICT;\nCREATE TABLE IF NOT EXISTS session_tasks",
      ");\nCREATE TABLE IF NOT EXISTS session_tasks",
    ));
    expect(() => assertSessionTaskSchema(nonStrict)).toThrow(
      "STATE_SESSION_TASK_SCHEMA_INVALID",
    );

    const foreignKeyDrift = databaseWithSchema(SESSION_TASK_SCHEMA_SQL.replace(
      "session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,",
      "session_id TEXT PRIMARY KEY REFERENCES sessions(id),",
    ));
    expect(() => assertSessionTaskSchema(foreignKeyDrift)).toThrow(
      "STATE_SESSION_TASK_SCHEMA_INVALID",
    );

    const invariantDrift = databaseWithSchema(SESSION_TASK_SCHEMA_SQL.replace(
      "BEGIN SELECT RAISE(ABORT,'SESSION_TASK_LIMIT'); END;",
      "BEGIN SELECT RAISE(ABORT,'SESSION_TASK_LIMIT_TAMPERED'); END;",
    ));
    expect(() => assertSessionTaskSchema(invariantDrift)).toThrow(
      "STATE_SESSION_TASK_SCHEMA_INVALID",
    );
  });
});

describe("SessionTaskStore mutation authority", () => {
  test("cascades list receipts when their conversation is removed", () => {
    const value = fixture();
    const key = idempotencyKey();
    value.store.listIdempotent(value.sessionId, key, "0".repeat(64));
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM session_task_receipts WHERE session_id=?",
    ).get(value.sessionId)).toEqual({ count: 1 });

    value.database.query("DELETE FROM sessions WHERE id=?").run(value.sessionId);

    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM session_task_receipts WHERE session_id=?",
    ).get(value.sessionId)).toEqual({ count: 0 });
  });

  test("replays immutable list and view snapshots and globally fences receipt keys", () => {
    const value = fixture();
    const created = createTask(value);
    const listKey = idempotencyKey();
    const listDigest = "1".repeat(64);
    const listed = value.store.listIdempotent(
      value.sessionId,
      listKey,
      listDigest,
    );

    value.now.value = 2_000;
    const edited = value.store.edit({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: 1,
      patch: { name: "Updated after list" },
      idempotencyKey: idempotencyKey(),
    });
    expect(value.store.listIdempotent(
      value.sessionId,
      listKey,
      listDigest,
    )).toEqual(listed);
    expect(listed.tasks[0]).toMatchObject({
      id: created.id,
      name: "Conversation review",
      revision: 1,
    });
    expect(value.store.list(value.sessionId)[0]).toMatchObject({
      id: created.id,
      name: "Updated after list",
      revision: 2,
    });

    const beforeCrossMode = value.store.require(value.sessionId, created.id);
    expectStoreCode(() => value.store.requireIdempotent(
      value.sessionId,
      created.id,
      listKey,
      listDigest,
    ), "IDEMPOTENCY_CONFLICT");
    expectStoreCode(() => value.store.listIdempotent(
      value.otherSessionId,
      listKey,
      "3".repeat(64),
    ), "IDEMPOTENCY_CONFLICT");
    expectStoreCode(() => value.store.create({
      sessionId: value.sessionId,
      name: "Must not be created",
      prompt: "A cross-mode receipt replay cannot mutate state.",
      minutes: 15,
      status: "active",
      idempotencyKey: listKey,
      receiptDigest: listDigest,
    }), "IDEMPOTENCY_CONFLICT");
    expect(value.store.require(value.sessionId, created.id)).toEqual(beforeCrossMode);
    expect(value.store.list(value.sessionId)).toHaveLength(1);

    const viewKey = idempotencyKey();
    const viewDigest = "2".repeat(64);
    const viewed = value.store.requireIdempotent(
      value.sessionId,
      created.id,
      viewKey,
      viewDigest,
    );
    value.now.value = 3_000;
    const editedAgain = value.store.edit({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: edited.revision,
      patch: { prompt: "Updated after view" },
      idempotencyKey: idempotencyKey(),
    });
    expect(value.store.requireIdempotent(
      value.sessionId,
      created.id,
      viewKey,
      viewDigest,
    )).toEqual(viewed);
    expect(viewed).toMatchObject({
      id: created.id,
      prompt: "Review this conversation.",
      revision: 2,
    });
    expectStoreCode(() => value.store.listIdempotent(
      value.sessionId,
      viewKey,
      viewDigest,
    ), "IDEMPOTENCY_CONFLICT");
    expect(value.store.require(value.sessionId, created.id)).toEqual(editedAgain);
    expect(value.database.query(
      `SELECT operation,request_digest
       FROM session_task_receipts
       WHERE idempotency_key IN (?,?)
       ORDER BY operation`,
    ).all(listKey, viewKey)).toEqual([
      {
        operation: "list",
        request_digest: listDigest,
      },
      {
        operation: "view",
        request_digest: viewDigest,
      },
    ]);
  });

  test("fences same-operation digest and task drift while replaying a deleted task snapshot", () => {
    const value = fixture();
    const first = createTask(value, { name: "First task" });
    const second = createTask(value, { name: "Second task" });
    const listKey = idempotencyKey();
    value.store.listIdempotent(value.sessionId, listKey, "4".repeat(64));
    expectStoreCode(() => value.store.listIdempotent(
      value.sessionId,
      listKey,
      "5".repeat(64),
    ), "IDEMPOTENCY_CONFLICT");

    const viewKey = idempotencyKey();
    const digest = "6".repeat(64);
    const viewed = value.store.requireIdempotent(
      value.sessionId,
      first.id,
      viewKey,
      digest,
    );
    expectStoreCode(() => value.store.requireIdempotent(
      value.sessionId,
      second.id,
      viewKey,
      digest,
    ), "IDEMPOTENCY_CONFLICT");

    value.now.value = 2_000;
    value.store.delete({
      sessionId: value.sessionId,
      taskId: first.id,
      expectedRevision: first.revision,
      idempotencyKey: idempotencyKey(),
    });
    expect(value.store.requireIdempotent(
      value.sessionId,
      first.id,
      viewKey,
      digest,
    )).toEqual(viewed);
    expectStoreCode(() => value.store.require(value.sessionId, first.id), "NOT_FOUND");
  });

  test("fails closed on noncanonical or authority-mismatched stored read snapshots", () => {
    const value = fixture();
    const noncanonicalKey = idempotencyKey();
    const noncanonicalDigest = "7".repeat(64);
    const noncanonical = JSON.stringify({
      scope: "conversation",
      sessionId: value.sessionId,
      tasks: [],
    }, null, 1);
    value.database.query(
      `INSERT INTO session_task_receipts(
         idempotency_key,request_digest,operation,session_id,task_id,
         result_revision,result_updated_at,result_next_due_at,result_deleted_at,
         result_json,created_at
       ) VALUES (?,?,'list',?,NULL,NULL,NULL,NULL,NULL,?,?)`,
    ).run(
      noncanonicalKey,
      noncanonicalDigest,
      value.sessionId,
      noncanonical,
      value.now.value,
    );
    expect(() => value.store.listIdempotent(
      value.sessionId,
      noncanonicalKey,
      noncanonicalDigest,
    )).toThrow("SESSION_TASK_LIST_RECEIPT_INVALID");

    const mismatchedKey = idempotencyKey();
    const mismatchedDigest = "8".repeat(64);
    value.database.query(
      `INSERT INTO session_task_receipts(
         idempotency_key,request_digest,operation,session_id,task_id,
         result_revision,result_updated_at,result_next_due_at,result_deleted_at,
         result_json,created_at
       ) VALUES (?,?,'list',?,NULL,NULL,NULL,NULL,NULL,?,?)`,
    ).run(
      mismatchedKey,
      mismatchedDigest,
      value.sessionId,
      JSON.stringify({
        scope: "conversation",
        sessionId: value.otherSessionId,
        tasks: [],
      }),
      value.now.value,
    );
    expect(() => value.store.listIdempotent(
      value.sessionId,
      mismatchedKey,
      mismatchedDigest,
    )).toThrow("SESSION_TASK_LIST_RECEIPT_INVALID");
    expect(() => value.database.query(
      "UPDATE session_task_receipts SET created_at=created_at+1 WHERE idempotency_key=?",
    ).run(mismatchedKey)).toThrow("SESSION_TASK_RECEIPT_IMMUTABLE");
  });

  test("rejects a changed dynamic digest for normalization-equivalent create input", () => {
    const value = fixture();
    const key = idempotencyKey();
    const originalDigest = "a".repeat(64);
    const changedDigest = "b".repeat(64);
    const created = value.store.create({
      sessionId: value.sessionId,
      name: "Canonical name",
      prompt: "Canonical prompt",
      minutes: 15,
      status: "active",
      idempotencyKey: key,
      receiptDigest: originalDigest,
    });

    expectStoreCode(() => value.store.create({
      sessionId: value.sessionId,
      name: "  Canonical name  ",
      prompt: "  Canonical prompt  ",
      minutes: 15,
      status: "active",
      idempotencyKey: key,
      receiptDigest: changedDigest,
    }), "IDEMPOTENCY_CONFLICT");
    expect(value.store.require(value.sessionId, created.id)).toEqual(created);
    expect(value.store.list(value.sessionId)).toHaveLength(1);
    expect(value.database.query(
      `SELECT request_digest,operation
       FROM session_task_receipts WHERE idempotency_key=?`,
    ).get(key)).toEqual({
      request_digest: originalDigest,
      operation: "create",
    });
  });

  test("replays lost create, edit, and delete responses and rejects changed key reuse", () => {
    const value = fixture();
    const createKey = idempotencyKey();
    const created = createTask(value, { idempotencyKey: createKey });
    expect(createTask(value, { idempotencyKey: createKey })).toEqual(created);
    expect(value.store.list(value.sessionId)).toHaveLength(1);
    expectStoreCode(() => createTask(value, {
      idempotencyKey: createKey,
      prompt: "Changed reuse must fail.",
    }), "IDEMPOTENCY_CONFLICT");
    expect(value.store.require(value.sessionId, created.id).prompt).toBe("Review this conversation.");

    value.now.value = 2_000;
    const editKey = idempotencyKey();
    const edited = value.store.edit({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: 1,
      patch: { name: "Updated review" },
      idempotencyKey: editKey,
    });
    expect(createTask(value, { idempotencyKey: createKey })).toEqual(created);
    expect(value.store.edit({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: 1,
      patch: { name: "Updated review" },
      idempotencyKey: editKey,
    })).toEqual(edited);
    expectStoreCode(() => value.store.edit({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: 2,
      patch: { name: "Changed reuse" },
      idempotencyKey: editKey,
    }), "IDEMPOTENCY_CONFLICT");

    value.now.value = 3_000;
    const deleteKey = idempotencyKey();
    const deleted = value.store.delete({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: 2,
      idempotencyKey: deleteKey,
    });
    expect(value.store.delete({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: 2,
      idempotencyKey: deleteKey,
    })).toEqual(deleted);
    expect(createTask(value, { idempotencyKey: createKey })).toEqual(created);
    expect(value.store.edit({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: 1,
      patch: { name: "Updated review" },
      idempotencyKey: editKey,
    })).toEqual(edited);
    expect(value.store.list(value.sessionId)).toEqual([]);
    expectStoreCode(
      () => value.store.require(value.sessionId, created.id),
      "NOT_FOUND",
    );
  });

  test("fences cross-session IDs, stale revisions, no-op edits, and the per-session quota", () => {
    const value = fixture();
    const smuggledCreate = {
      sessionId: value.sessionId,
      name: "Standalone smuggling",
      prompt: "Must fail.",
      minutes: 15,
      status: "active" as const,
      idempotencyKey: idempotencyKey(),
      destination: "local",
    };
    expect(() => value.store.create(smuggledCreate)).toThrow();
    const created = createTask(value);
    expectStoreCode(
      () => value.store.require(value.otherSessionId, created.id),
      "NOT_FOUND",
    );
    expectStoreCode(() => value.store.edit({
      sessionId: value.otherSessionId,
      taskId: created.id,
      expectedRevision: 1,
      patch: { name: "Cross-session" },
      idempotencyKey: idempotencyKey(),
    }), "NOT_FOUND");
    expectStoreCode(() => value.store.edit({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: 2,
      patch: { name: "Stale" },
      idempotencyKey: idempotencyKey(),
    }), "REVISION_CONFLICT");
    expectStoreCode(() => value.store.edit({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: 1,
      patch: { name: created.name },
      idempotencyKey: idempotencyKey(),
    }), "NO_CHANGES");

    for (let index = 1; index < SESSION_TASK_LIMIT; index += 1) {
      createTask(value, { name: `Task ${String(index)}`, status: "paused" });
    }
    expectStoreCode(
      () => createTask(value, { name: "Overflow", status: "paused" }),
      "TASK_LIMIT",
    );
    value.store.delete({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: 1,
      idempotencyKey: idempotencyKey(),
    });
    expect(() => createTask(value, { name: "Replacement", status: "paused" })).not.toThrow();
  });

  test("anchors resume and active interval edits while preserving due time for prompt edits", () => {
    const value = fixture();
    const created = createTask(value);
    expect(created.nextDueAt).toBe(901_000);
    value.now.value = 2_000;
    const promptEdited = value.store.edit({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: 1,
      patch: { prompt: "Replacement prompt" },
      idempotencyKey: idempotencyKey(),
    });
    expect(promptEdited.nextDueAt).toBe(901_000);
    value.now.value = 3_000;
    const paused = value.store.edit({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: 2,
      patch: { status: "paused" },
      idempotencyKey: idempotencyKey(),
    });
    expect(paused.nextDueAt).toBeNull();
    value.now.value = 4_000;
    const resumed = value.store.edit({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: 3,
      patch: { status: "active" },
      idempotencyKey: idempotencyKey(),
    });
    expect(resumed.nextDueAt).toBe(904_000);
    value.now.value = 5_000;
    const rescheduled = value.store.edit({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: 4,
      patch: { minutes: SESSION_TASK_MAX_INTERVAL_MINUTES },
      idempotencyKey: idempotencyKey(),
    });
    expect(rescheduled.nextDueAt).toBe(604_805_000);
  });
});

describe("SessionTaskStore due materialization", () => {
  test("returns after one atomic handoff before resolving the next candidate", async () => {
    let rejectSecond = true;
    const resolvedRoots: string[] = [];
    const value = fixture({
      resolveProjectDirectory: async (root) => {
        resolvedRoots.push(root);
        if (root === "/second" && rejectSecond) {
          throw new Error("The second candidate must remain untouched on this pass.");
        }
        return root;
      },
    });
    value.database.query("UPDATE projects SET root_path='/first'").run();
    const secondProjectId = createProjectId();
    value.database.query("INSERT INTO projects(id,root_path) VALUES (?,?)")
      .run(secondProjectId, "/second");
    value.database.query("UPDATE sessions SET project_id=? WHERE id=?")
      .run(secondProjectId, value.otherSessionId);

    const first = createTask(value, {
      name: "First due task",
      prompt: "Materialize first.",
    });
    value.now.value = 2_000;
    const second = value.store.create({
      sessionId: value.otherSessionId,
      name: "Second due task",
      prompt: "Materialize on the next pass.",
      minutes: 15,
      status: "active",
      idempotencyKey: idempotencyKey(),
    });
    const dueAt = second.nextDueAt ?? 0;

    expect(await value.store.materializeDue({ now: dueAt }))
      .toMatchObject([{
        task: { id: first.id },
        occurrence: { taskId: first.id },
        queue: { message: "Materialize first." },
      }]);
    expect(resolvedRoots).toEqual(["/first"]);

    rejectSecond = false;
    expect(await value.store.materializeDue({ now: dueAt }))
      .toMatchObject([{
        task: { id: second.id },
        occurrence: { taskId: second.id },
        queue: { message: "Materialize on the next pass." },
      }]);
    expect(resolvedRoots).toEqual(["/first", "/second"]);
    expect(value.store.listOccurrences(value.sessionId, first.id)).toHaveLength(1);
    expect(value.store.listOccurrences(value.otherSessionId, second.id)).toHaveLength(1);
  });

  test("advances its bounded scan past more than 128 unusable tasks", async () => {
    const value = fixture({
      resolveProjectDirectory: async (root) => root === "/valid" ? root : null,
    });
    const accountId = createProfileId();
    const invalidProjectId = createProjectId();
    const validProjectId = createProjectId();
    value.database.query(
      "INSERT INTO profiles(id,state,process_generation) VALUES (?,'signed_in',1)",
    ).run(accountId);
    value.database.query("INSERT INTO projects(id,root_path) VALUES (?,?)")
      .run(invalidProjectId, "/invalid");
    value.database.query("INSERT INTO projects(id,root_path) VALUES (?,?)")
      .run(validProjectId, "/valid");

    const invalidSessionIds = Array.from({ length: 5 }, () => createSessionId());
    for (const sessionId of invalidSessionIds) {
      value.database.query(
        `INSERT INTO sessions(id,profile_id,project_id,provider_thread_id,state)
         VALUES (?,?,?,?,'idle')`,
      ).run(sessionId, accountId, invalidProjectId, `thread-${sessionId}`);
    }
    for (const [sessionIndex, sessionId] of invalidSessionIds.entries()) {
      const taskCount = sessionIndex < 4 ? SESSION_TASK_LIMIT : 1;
      for (let taskIndex = 0; taskIndex < taskCount; taskIndex += 1) {
        value.store.create({
          sessionId,
          name: `Unusable ${String(sessionIndex)}-${String(taskIndex)}`,
          prompt: "This task has no usable canonical project directory.",
          minutes: 15,
          status: "active",
          idempotencyKey: idempotencyKey(),
        });
      }
    }

    value.now.value = 2_000;
    const validSessionId = createSessionId();
    value.database.query(
      `INSERT INTO sessions(id,profile_id,project_id,provider_thread_id,state)
       VALUES (?,?,?,?,'idle')`,
    ).run(validSessionId, accountId, validProjectId, `thread-${validSessionId}`);
    const valid = value.store.create({
      sessionId: validSessionId,
      name: "Eligible after bounded scan",
      prompt: "Materialize this later eligible task.",
      minutes: 15,
      status: "active",
      idempotencyKey: idempotencyKey(),
    });
    const dueAt = valid.nextDueAt ?? 0;

    expect(await value.store.materializeDue({
      now: dueAt,
    })).toEqual([]);
    expect(await value.store.materializeDue({
      now: dueAt,
    })).toMatchObject([{
      task: { id: valid.id, sessionId: validSessionId },
      occurrence: { taskId: valid.id, sessionId: validSessionId },
      queue: {
        sessionId: validSessionId,
        message: "Materialize this later eligible task.",
      },
    }]);
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM session_task_occurrences",
    ).get()).toEqual({ count: 1 });
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM queue_entries",
    ).get()).toEqual({ count: 1 });
  });

  test("atomically coalesces downtime into one ordinary queue entry", async () => {
    const value = fixture();
    const created = createTask(value);
    const scheduledFor = created.nextDueAt ?? 0;
    const dueNow = scheduledFor + 3 * 15 * 60_000;
    const materialized = await value.store.materializeDue({ now: dueNow });
    expect(materialized).toHaveLength(1);
    expect(materialized[0]).toMatchObject({
      task: {
        id: created.id,
        sessionId: value.sessionId,
        nextDueAt: scheduledFor + 4 * 15 * 60_000,
      },
      occurrence: {
        taskId: created.id,
        sessionId: value.sessionId,
        taskRevision: 1,
        scheduledFor,
        coalescedIntervals: 3,
      },
      queue: {
        sessionId: value.sessionId,
        message: "Review this conversation.",
        state: "pending",
      },
    });
    expect(value.store.listOccurrences(value.sessionId, created.id)).toHaveLength(1);
    expect(await value.store.materializeDue({
      now: scheduledFor + 8 * 15 * 60_000,
    })).toEqual([]);
    expect(await value.store.materializeDue({ now: scheduledFor - 1 })).toEqual([]);
  });

  test("never rewrites an already queued prompt and permits one later run after settlement", async () => {
    const value = fixture();
    const created = createTask(value);
    const first = await value.store.materializeDue({ now: created.nextDueAt ?? 0 });
    const firstRun = first[0];
    if (firstRun === undefined) throw new Error("Expected first materialization.");
    value.now.value = 902_000;
    const edited = value.store.edit({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: 1,
      patch: { prompt: "Use the new prompt." },
      idempotencyKey: idempotencyKey(),
    });
    const storedFirst = value.database.query(
      "SELECT message FROM queue_entries WHERE id=?",
    ).get(firstRun.queue.id);
    expect(storedFirst).toEqual({ message: "Review this conversation." });
    value.database.query("UPDATE queue_entries SET state='applied' WHERE id=?").run(firstRun.queue.id);
    const second = await value.store.materializeDue({ now: edited.nextDueAt ?? 0 });
    expect(second).toHaveLength(1);
    expect(second[0]?.queue.message).toBe("Use the new prompt.");
    expect(value.store.listOccurrences(value.sessionId, created.id)).toHaveLength(2);
  });

  test("rechecks revision after project validation so edit-versus-due cannot hybridize", async () => {
    const fixtureReference: { value?: Fixture } = {};
    let intervened = false;
    const createdFixture = fixture({
      resolveProjectDirectory: async (root) => {
        if (!intervened) {
          intervened = true;
          const value = fixtureReference.value;
          const current = value?.store.list(value.sessionId)[0];
          if (value === undefined || current === undefined) throw new Error("Missing race fixture.");
          value.store.edit({
            sessionId: value.sessionId,
            taskId: current.id,
            expectedRevision: current.revision,
            patch: { prompt: "Revision two prompt" },
            idempotencyKey: idempotencyKey(),
          });
        }
        return root;
      },
    });
    fixtureReference.value = createdFixture;
    const value = createdFixture;
    const created = createTask(value);
    expect(await value.store.materializeDue({ now: created.nextDueAt ?? 0 })).toEqual([]);
    const retried = await value.store.materializeDue({ now: created.nextDueAt ?? 0 });
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({
      task: { revision: 2 },
      occurrence: { taskRevision: 2 },
      queue: { message: "Revision two prompt" },
    });
  });

  test("linearizes pause and delete before the due transaction without leaving a queue half", async () => {
    for (const operation of ["pause", "delete"] as const) {
      const fixtureReference: { value?: Fixture } = {};
      let intervened = false;
      const value = fixture({
        resolveProjectDirectory: async (root) => {
          if (!intervened) {
            intervened = true;
            const currentFixture = fixtureReference.value;
            const current = currentFixture?.store.list(currentFixture.sessionId)[0];
            if (currentFixture === undefined || current === undefined) {
              throw new Error("Missing race fixture.");
            }
            if (operation === "pause") {
              currentFixture.store.edit({
                sessionId: currentFixture.sessionId,
                taskId: current.id,
                expectedRevision: current.revision,
                patch: { status: "paused" },
                idempotencyKey: idempotencyKey(),
              });
            } else {
              currentFixture.store.delete({
                sessionId: currentFixture.sessionId,
                taskId: current.id,
                expectedRevision: current.revision,
                idempotencyKey: idempotencyKey(),
              });
            }
          }
          return root;
        },
      });
      fixtureReference.value = value;
      const created = createTask(value);
      expect(await value.store.materializeDue({
        now: created.nextDueAt ?? 0,
      })).toEqual([]);
      expect(value.database.query("SELECT COUNT(*) AS count FROM queue_entries").get()).toEqual({ count: 0 });
      expect(value.store.listOccurrences(value.sessionId, created.id)).toEqual([]);
    }
  });

  test("leaves due tasks untouched while any local execution authority is ineligible", async () => {
    const value = fixture();
    const created = createTask(value);
    const dueAt = created.nextDueAt ?? 0;
    const cases = [
      "UPDATE profiles SET state='signed_out'",
      "UPDATE sessions SET provider_thread_id=NULL",
      "UPDATE sessions SET state='recovery_required'",
      "UPDATE sessions SET state='terminal'",
      "UPDATE sessions SET project_id=NULL",
    ];
    for (const statement of cases) {
      const isolated = fixture();
      const task = createTask(isolated);
      isolated.database.exec(statement);
      expect(await isolated.store.materializeDue({ now: task.nextDueAt ?? dueAt })).toEqual([]);
      expect(isolated.store.listOccurrences(isolated.sessionId, task.id)).toEqual([]);
    }
    const unusable = fixture({ resolveProjectDirectory: async () => null });
    const unusableTask = createTask(unusable);
    expect(await unusable.store.materializeDue({
      now: unusableTask.nextDueAt ?? dueAt,
    })).toEqual([]);
  });

  test("rolls back queue allocation, occurrence, and due advance as one unit", async () => {
    const value = fixture();
    const created = createTask(value);
    value.database.query(
      "UPDATE queue_sequence_authority SET next_sequence=9007199254740991 WHERE singleton=1",
    ).run();
    await expect(value.store.materializeDue({
      now: created.nextDueAt ?? 0,
    })).rejects.toThrow("QUEUE_SEQUENCE_EXHAUSTED");
    expect(value.database.query("SELECT COUNT(*) AS count FROM queue_entries").get()).toEqual({ count: 0 });
    expect(value.store.listOccurrences(value.sessionId, created.id)).toEqual([]);
    expect(value.store.require(value.sessionId, created.id).nextDueAt).toBe(created.nextDueAt);
  });

  test("fences the materialization commit with daemon generation authority", async () => {
    const value = fixture();
    const created = createTask(value);
    await expect(value.store.materializeDue({
      now: created.nextDueAt ?? 0,
      daemonGeneration: 6,
    })).rejects.toMatchObject({ code: "DAEMON_AUTHORITY_CHANGED" });
    expect(value.database.query("SELECT COUNT(*) AS count FROM queue_entries").get()).toEqual({ count: 0 });
    expect(value.store.listOccurrences(value.sessionId, created.id)).toEqual([]);
    expect(await value.store.materializeDue({
      now: created.nextDueAt ?? 0,
      daemonGeneration: 7,
    })).toHaveLength(1);
  });
});
