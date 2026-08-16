import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  CONTEXT_VALUE_CHUNK_BYTES,
  COMPLETED_PREFIX_CONTEXT_VALUE_MAX_BYTES,
  ContextValueQuotaExceededError,
  type ContextValuePrepareInput,
  type ContextValueRecord,
} from "../src/harness/context-value-store";
import {
  ContextValueSQLiteAdapterV2,
} from "../src/harness/context-value-sqlite-adapter-v2";
import type {
  ContextValueSQLiteAdapterV2Error,
} from "../src/harness/context-value-sqlite-adapter-v2";
import { applyMigrations } from "../src/state/database";

const at = "2031-01-01T00:00:00.000Z";
const later = "2031-01-01T00:00:01.000Z";
const deadline = "2031-01-02T00:00:00.000Z";
const projectId = "project-context-values-v2";
const epochId = "hepoch_contextvaluev2001";
const actorId = "hactor_contextvaluev2001";
const turnId = "hturn_contextvaluev20001";

function fixture() {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.query(`
    INSERT INTO projects (
      project_id, canonical_repository_path, canonical_git_common_dir,
      display_name, created_at, updated_at
    ) VALUES (?1, '/tmp/context-values-v2', '/tmp/context-values-v2/.git',
      'Context values v2', ?2, ?2)
  `).run(projectId, at);
  database.query(`
    INSERT INTO harness_actor_epochs (
      epoch_id, project_id, source_sha, root_actor_id,
      max_depth, max_active_descendants, max_durable_descendants,
      token_budget, byte_budget, deadline, lane_authority,
      token_reserved, byte_reserved, next_root_completion_sequence,
      state, revision, created_at, updated_at, stopped_at
    ) VALUES (
      ?1, ?2, ?3, ?4, 3, 8, 50, 100000, 16777216, ?5,
      'managedWrite', 0, 0, 1, 'active', 1, ?6, ?6, NULL
    )
  `).run(epochId, projectId, "a".repeat(40), actorId, deadline, at);
  database.query(`
    INSERT INTO harness_actors (
      actor_id, epoch_id, parent_actor_id, depth, title, state,
      max_depth, max_active_descendants, max_durable_descendants,
      token_budget, byte_budget, deadline, lane_authority,
      token_reserved, byte_reserved, next_turn_ordinal, next_result_ordinal,
      revision, created_at, updated_at, stopped_at
    ) VALUES (
      ?1, ?2, NULL, 0, 'Root actor', 'active', 3, 8, 50,
      100000, 16777216, ?3, 'managedWrite', 0, 0, 2, 1,
      1, ?4, ?4, NULL
    )
  `).run(actorId, epochId, deadline, at);
  const times = [later, "2031-01-01T00:00:02.000Z",
    "2031-01-01T00:00:03.000Z", "2031-01-01T00:00:04.000Z"];
  let timeIndex = 0;
  const authority = new ContextValueSQLiteAdapterV2(database, {
    now: () => new Date(times[Math.min(timeIndex++, times.length - 1)]!),
  });
  return { authority, database };
}

function input(
  marker: string,
  overrides: Partial<ContextValuePrepareInput> = {},
): ContextValuePrepareInput {
  const digestMarker = (marker.codePointAt(0) ?? 0).toString(16).slice(-1);
  const utf8Bytes = overrides.utf8Bytes ?? 13;
  const chunkCount = Math.max(1, Math.ceil(
    utf8Bytes / CONTEXT_VALUE_CHUNK_BYTES,
  ));
  const chunks = Array.from({ length: chunkCount }, (_, ordinal) => ({
    ordinal,
    plaintextBytes: utf8Bytes === 0
      ? 0
      : Math.min(
        CONTEXT_VALUE_CHUNK_BYTES,
        utf8Bytes - ordinal * CONTEXT_VALUE_CHUNK_BYTES,
      ),
    objectDigest: digestMarker.repeat(64),
    objectByteLength: 128,
  }));
  return {
    version: 2,
    operationId: `contextop_${marker.repeat(16)}`,
    epochId,
    ownerActorId: actorId,
    sourceTurnId: null,
    valueId: `ctxval_${marker.repeat(16)}`,
    kind: "text",
    purpose: "heap",
    schemaVersion: 1,
    nameDigest: null,
    utf8Bytes,
    contentDigest: digestMarker.repeat(64),
    chunkSize: CONTEXT_VALUE_CHUNK_BYTES,
    chunkCount,
    chunks,
    manifestDigest: marker === "f" ? "0".repeat(64) : "f".repeat(64),
    manifestByteLength: 256,
    quotaLimitBytes: 16 * 1024 * 1024,
    ...overrides,
  };
}

async function activate(
  authority: ContextValueSQLiteAdapterV2,
  intent: ContextValuePrepareInput,
): Promise<ContextValueRecord> {
  const prepared = await authority.prepareContextValue(intent);
  const started = await authority.markContextValueEffectStarted({
    operationId: intent.operationId,
    expectedRevision: prepared.revision,
  });
  return await authority.activateContextValue({
    operationId: intent.operationId,
    expectedRevision: started.revision,
    expectedState: "effectStarted",
    manifestDigest: intent.manifestDigest,
  });
}

async function rejection(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected operation to reject");
}

async function insertTurn(
  authority: ContextValueSQLiteAdapterV2,
  database: Database,
): Promise<void> {
  const currentInput = input("i", {
    valueId: "ctxval_contextinput001",
    operationId: "contextop_contextinput001",
    purpose: "currentInput",
  });
  await activate(authority, currentInput);
  database.query(`
    INSERT INTO harness_actor_turns (
      turn_id, epoch_id, actor_id, ordinal, idempotency_key,
      input_value_id, state, desired_state, revision,
      created_at, started_at, settled_at, outcome_code
    ) VALUES (
      ?1, ?2, ?3, 1, 'context_value_turn_idempotency', ?4,
      'running', 'run', 2, ?5, ?5, NULL, NULL
    )
  `).run(turnId, epochId, actorId, currentInput.valueId, at);
}

describe("v2 context-value SQLite metadata authority", () => {
  test("atomically reserves exact immutable metadata and chunk rows", async () => {
    const { authority, database } = fixture();
    const intent = input("b", {
      utf8Bytes: CONTEXT_VALUE_CHUNK_BYTES + 7,
      chunkCount: 2,
      chunks: [
        {
          ordinal: 0,
          plaintextBytes: CONTEXT_VALUE_CHUNK_BYTES,
          objectDigest: "b".repeat(64),
          objectByteLength: 128,
        },
        {
          ordinal: 1,
          plaintextBytes: 7,
          objectDigest: "c".repeat(64),
          objectByteLength: 96,
        },
      ],
    });
    const prepared = await authority.prepareContextValue(intent);
    expect(prepared).toMatchObject({
      epochId,
      ownerActorId: actorId,
      sourceTurnId: null,
      state: "prepared",
      revision: 1,
      chunks: intent.chunks,
    });
    expect(await authority.prepareContextValue(intent)).toEqual(prepared);
    expect(database.query(
      "SELECT COUNT(*) AS count FROM harness_context_value_chunks",
    ).get()).toEqual({ count: 2 });

    expect(await rejection(authority.prepareContextValue({
      ...intent,
      contentDigest: "d".repeat(64),
    }))).toMatchObject({
      code: "conflict",
    } satisfies Partial<ContextValueSQLiteAdapterV2Error>);
    expect(database.query(
      "SELECT COUNT(*) AS count FROM harness_context_values",
    ).get()).toEqual({ count: 1 });
  });

  test("compares every immutable replay field before returning authority", async () => {
    const { authority } = fixture();
    const intent = input("r");
    await authority.prepareContextValue(intent);
    const mutations: ContextValuePrepareInput[] = [
      { ...intent, valueId: "ctxval_replaymutation01" },
      { ...intent, epochId: "hepoch_replaymutation01" },
      { ...intent, ownerActorId: "hactor_replaymutation01" },
      { ...intent, sourceTurnId: "hturn_replaymutation001" },
      { ...intent, kind: "selection" },
      { ...intent, purpose: "programSource" },
      { ...intent, nameDigest: "1".repeat(64) },
      { ...intent, utf8Bytes: 12, chunks: [{ ...intent.chunks[0]!,
        plaintextBytes: 12 }] },
      { ...intent, contentDigest: "0".repeat(64) },
      { ...intent, chunks: [{ ...intent.chunks[0]!,
        objectDigest: "3".repeat(64) }] },
      { ...intent, manifestDigest: "4".repeat(64) },
      { ...intent, manifestByteLength: 257 },
      { ...intent, quotaLimitBytes: 8 * 1024 * 1024 },
    ];
    for (const changed of mutations) {
      expect(await rejection(authority.prepareContextValue(changed)))
        .toMatchObject({
        code: "conflict",
      } satisfies Partial<ContextValueSQLiteAdapterV2Error>);
    }
    expect(await authority.readContextValueOperation(intent.operationId))
      .toMatchObject(intent);
  });

  test("fences lineage and binds nullable source turns to the owning actor", async () => {
    const { authority, database } = fixture();
    expect(await rejection(authority.prepareContextValue(input("c", {
      epochId: "hepoch_missinglineage001",
    })))).toMatchObject({ code: "conflict" });
    expect(await rejection(authority.prepareContextValue(input("d", {
      sourceTurnId: turnId,
    })))).toMatchObject({ code: "conflict" });

    await insertTurn(authority, database);
    const result = await authority.prepareContextValue(input("e", {
      sourceTurnId: turnId,
      purpose: "programSource",
    }));
    expect(result).toMatchObject({ sourceTurnId: turnId, state: "prepared" });
  });

  test("makes every lifecycle CAS exactly replayable and preserves evidence", async () => {
    const { authority } = fixture();
    const intent = input("g");
    const prepared = await authority.prepareContextValue(intent);
    const started = await authority.markContextValueEffectStarted({
      operationId: intent.operationId,
      expectedRevision: prepared.revision,
    });
    expect(await authority.markContextValueEffectStarted({
      operationId: intent.operationId,
      expectedRevision: prepared.revision,
    })).toEqual(started);
    const replay = await authority.markContextValueReplayRequired({
      operationId: intent.operationId,
      expectedRevision: started.revision,
      expectedState: "effectStarted",
    });
    expect(await authority.markContextValueReplayRequired({
      operationId: intent.operationId,
      expectedRevision: started.revision,
      expectedState: "effectStarted",
    })).toEqual(replay);
    const active = await authority.activateContextValue({
      operationId: intent.operationId,
      expectedRevision: replay.revision,
      expectedState: "replayRequired",
      manifestDigest: intent.manifestDigest,
    });
    expect(await authority.activateContextValue({
      operationId: intent.operationId,
      expectedRevision: replay.revision,
      expectedState: "replayRequired",
      manifestDigest: intent.manifestDigest,
    })).toEqual(active);
    const recovery = await authority.markContextValueRecoveryRequired({
      operationId: intent.operationId,
      expectedRevision: active.revision,
      expectedState: "active",
      reason: "object_missing_after_activation",
    });
    expect(recovery).toMatchObject({
      state: "recoveryRequired",
      recoveryReason: "object_missing_after_activation",
      revision: 5,
    });
    expect(await authority.markContextValueRecoveryRequired({
      operationId: intent.operationId,
      expectedRevision: active.revision,
      expectedState: "active",
      reason: "object_missing_after_activation",
    })).toEqual(recovery);
    expect(await rejection(authority.markContextValueRecoveryRequired({
      operationId: intent.operationId,
      expectedRevision: active.revision,
      expectedState: "active",
      reason: "metadata_conflict",
    }))).toMatchObject({ code: "revision_conflict" });
  });

  test("accounts quota across every lifecycle state and reserves names early", async () => {
    const { authority, database } = fixture();
    database.query(`
      UPDATE harness_settings SET context_quota_bytes = 1048576,
        revision = revision + 1, updated_at = ?1 WHERE singleton = 1
    `).run(later);
    const full = input("h", {
      utf8Bytes: 1024 * 1024,
      quotaLimitBytes: 1024 * 1024,
    });
    const prepared = await authority.prepareContextValue(full);
    await authority.markContextValueRecoveryRequired({
      operationId: full.operationId,
      expectedRevision: prepared.revision,
      expectedState: "prepared",
      reason: "metadata_conflict",
    });
    expect(await rejection(authority.prepareContextValue(input("j", {
      utf8Bytes: 0,
      quotaLimitBytes: 2 * 1024 * 1024,
    })))).toBeInstanceOf(ContextValueQuotaExceededError);
    expect(await rejection(authority.prepareContextValue(input("k", {
      utf8Bytes: 1,
      quotaLimitBytes: 1024 * 1024,
    })))).toBeInstanceOf(ContextValueQuotaExceededError);

    const name = "9".repeat(64);
    const named = input("l", { nameDigest: name, utf8Bytes: 0,
      quotaLimitBytes: 1024 * 1024 });
    await authority.prepareContextValue(named);
    expect(await rejection(authority.prepareContextValue(input("m", {
      nameDigest: name,
      utf8Bytes: 0,
      quotaLimitBytes: 1024 * 1024,
    })))).toMatchObject({ code: "conflict" });
  });

  test("separates admission storage from actor and epoch work budgets", async () => {
    const { authority } = fixture();
    await authority.prepareContextValue(input("u", {
      kind: "selection",
      purpose: "completedPrefix",
      utf8Bytes: COMPLETED_PREFIX_CONTEXT_VALUE_MAX_BYTES,
      quotaLimitBytes: 64 * 1024 * 1024,
    }));
    await authority.prepareContextValue(input("v", {
      purpose: "currentInput",
      utf8Bytes: 1024 * 1024,
      quotaLimitBytes: 64 * 1024 * 1024,
    }));
    for (const marker of "abcdefghijklmnop") {
      await authority.prepareContextValue(input(marker, {
        purpose: "heap",
        utf8Bytes: 1024 * 1024,
        quotaLimitBytes: 16 * 1024 * 1024,
      }));
    }
    expect(await rejection(authority.prepareContextValue(input("x", {
      purpose: "programResult",
      utf8Bytes: 1,
      quotaLimitBytes: 16 * 1024 * 1024,
    })))).toBeInstanceOf(ContextValueQuotaExceededError);
  });

  test("charges work to owner availability and reserves total quota atomically", async () => {
    const reserved = fixture();
    reserved.database.query(`
      UPDATE harness_actors SET byte_reserved = 8388608
      WHERE actor_id = ?1
    `).run(actorId);
    for (const marker of "abcdefgh") {
      await reserved.authority.prepareContextValue(input(marker, {
        utf8Bytes: 1024 * 1024,
        quotaLimitBytes: 16 * 1024 * 1024,
      }));
    }
    expect(await rejection(reserved.authority.prepareContextValue(input("i", {
      utf8Bytes: 1,
      quotaLimitBytes: 16 * 1024 * 1024,
    })))).toBeInstanceOf(ContextValueQuotaExceededError);

    const concurrent = fixture();
    concurrent.database.query(`
      UPDATE harness_settings SET context_quota_bytes = 1048576
      WHERE singleton = 1
    `).run();
    const outcomes = await Promise.allSettled([
      concurrent.authority.prepareContextValue(input("2", {
        utf8Bytes: 700 * 1024,
        quotaLimitBytes: 1024 * 1024,
      })),
      concurrent.authority.prepareContextValue(input("3", {
        utf8Bytes: 700 * 1024,
        quotaLimitBytes: 1024 * 1024,
      })),
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
  });

  test("returns bounded strictly ordered active and recovery pages", async () => {
    const { authority } = fixture();
    const first = input("n");
    const second = input("o");
    const third = input("p");
    await activate(authority, third);
    await authority.prepareContextValue(first);
    await activate(authority, second);

    expect((await authority.listActiveContextValues({
      epochId,
      afterValueId: null,
      limit: 1,
    })).map(({ valueId }) => valueId)).toEqual([second.valueId]);
    expect((await authority.listActiveContextValues({
      epochId,
      afterValueId: second.valueId,
      limit: 2,
    })).map(({ valueId }) => valueId)).toEqual([third.valueId]);
    expect((await authority.listRecoverableContextValues({
      afterOperationId: null,
      limit: 1,
    })).map(({ operationId }) => operationId)).toEqual([first.operationId]);
    expect(await authority.readActiveContextValue({
      epochId,
      ownerActorId: actorId,
      sourceTurnId: null,
      valueId: second.valueId,
    })).toMatchObject({ valueId: second.valueId, state: "active" });
    expect(await authority.readActiveContextValue({
      epochId,
      ownerActorId: actorId,
      sourceTurnId: turnId,
      valueId: second.valueId,
    })).toBeNull();
  });

  test("fails closed when chunk rows no longer match immutable metadata", async () => {
    const { authority, database } = fixture();
    const intent = input("q");
    await authority.prepareContextValue(intent);
    database.query(`
      UPDATE harness_context_value_chunks SET plaintext_bytes = 1
      WHERE value_id = ?1 AND ordinal = 0
    `).run(intent.valueId);
    expect(await rejection(authority.readContextValueOperation(
      intent.operationId,
    ))).toMatchObject({
        code: "corrupt_state",
      } satisfies Partial<ContextValueSQLiteAdapterV2Error>);
  });
});
