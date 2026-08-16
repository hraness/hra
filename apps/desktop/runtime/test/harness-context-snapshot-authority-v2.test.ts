import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  actorEpochSchema,
  actorSchema,
} from "../src/harness/actor-domain";
import {
  ContextSnapshotAuthorityV2,
} from "../src/harness/context-snapshot-authority-v2";
import { HarnessSQLiteAuthorityV2 } from "../src/harness/sqlite-authority-v2";
import { applyMigrations } from "../src/state/database";

const at = "2030-01-01T00:00:00.000Z";
const expiresAt = "2030-01-02T00:00:00.000Z";
const deadline = "2030-01-03T00:00:00.000Z";
const projectId = "project-context-snapshot-v2";
const epochId = "hepoch_context_snapshot01";
const actorId = "hactor_context_snapshot01";

function fixture(): Readonly<{
  authority: ContextSnapshotAuthorityV2;
  database: Database;
}> {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.query(`
    INSERT INTO projects (
      project_id, canonical_repository_path, canonical_git_common_dir,
      display_name, created_at, updated_at
    ) VALUES (?1, '/tmp/context-snapshot', '/tmp/context-snapshot/.git',
      'Context snapshot', ?2, ?2)
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
  new HarnessSQLiteAuthorityV2(database, { now: () => new Date(at) })
    .createActorEpoch({
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
  seedActiveValue(database, "ctxval_snapshot_value01", "completedPrefix");
  seedActiveValue(database, "ctxval_snapshot_value02", "completedPrefix");
  seedActiveValue(database, "ctxval_snapshot_heap0001", "heap");
  return { database, authority: new ContextSnapshotAuthorityV2(database) };
}

function seedActiveValue(
  database: Database,
  valueId: string,
  purpose: "completedPrefix" | "heap",
): void {
  database.query(`
    INSERT INTO harness_context_values (
      value_id, operation_id, epoch_id, owner_actor_id, source_turn_id,
      kind, purpose, schema_version, name_digest, utf8_bytes,
      content_digest, chunk_size, chunk_count, manifest_digest,
      manifest_byte_length, quota_limit_bytes, state, recovery_reason,
      revision, created_at, updated_at, effect_started_at, activated_at
    ) VALUES (
      ?1, ?2, ?3, ?4, NULL,
      CASE WHEN ?5 = 'completedPrefix' THEN 'selection' ELSE 'json' END,
      ?5, 1, NULL, 2,
      ?6, 65536, 1, ?7, 64, 16777216, 'active', NULL,
      3, ?8, ?8, ?8, ?8
    )
  `).run(
    valueId,
    `op_${valueId}`,
    epochId,
    actorId,
    purpose,
    "b".repeat(64),
    "c".repeat(64),
    at,
  );
  database.query(`
    INSERT INTO harness_context_value_chunks (
      value_id, ordinal, plaintext_bytes, object_digest, object_byte_length
    ) VALUES (?1, 0, 2, ?2, 32)
  `).run(valueId, "d".repeat(64));
}

function snapshot(
  id = "ctxsnap_context_snapshot01",
  valueId = "ctxval_snapshot_value01",
) {
  return {
    id,
    epochId,
    actorId,
    completedThroughTurnId: null,
    coverageWitnessDigest: "e".repeat(64),
    valueId,
    createdAt: at,
    expiresAt,
  };
}

describe("ContextSnapshotAuthorityV2", () => {
  test("creates and exact-replays one content-free completed-prefix witness", () => {
    const { authority, database } = fixture();
    try {
      const created = authority.create(snapshot());
      expect(authority.create(snapshot())).toEqual(created);
      expect(authority.read(created.id)).toEqual(created);
      expect(authority.listForActor({ actorId, limit: 1 })).toEqual([created]);
      expect(authority.listForActor({
        actorId,
        afterSnapshotId: created.id,
        limit: 1,
      })).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("rejects immutable identity and one-value-to-one-snapshot conflicts", () => {
    const { authority, database } = fixture();
    try {
      authority.create(snapshot());
      expect(() => authority.create({
        ...snapshot(),
        coverageWitnessDigest: "f".repeat(64),
      })).toThrow(/identity/i);
      expect(() => authority.create(snapshot(
        "ctxsnap_context_snapshot02",
        "ctxval_snapshot_value01",
      ))).toThrow(/identity/i);
    } finally {
      database.close();
    }
  });

  test("fails closed when the encrypted value is not a completed prefix", () => {
    const { authority, database } = fixture();
    try {
      expect(() => authority.create(snapshot(
        "ctxsnap_context_snapshot03",
        "ctxval_snapshot_heap0001",
      ))).toThrow(/lineage/i);
    } finally {
      database.close();
    }
  });

  test("returns deterministic bounded pages and rejects stored corruption", () => {
    const { authority, database } = fixture();
    try {
      const second = authority.create(snapshot(
        "ctxsnap_context_snapshot02",
        "ctxval_snapshot_value02",
      ));
      const first = authority.create(snapshot());
      expect(authority.listForActor({ actorId, limit: 2 }).map(({ id }) => id))
        .toEqual([first.id, second.id]);
      database.query(`
        UPDATE harness_context_snapshots
        SET expires_at = '2029-01-01T00:00:00.000Z'
        WHERE snapshot_id = ?1
      `).run(first.id);
      expect(() => authority.read(first.id)).toThrow(/stored/i);
    } finally {
      database.close();
    }
  });
});
