import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { z } from "zod";

import {
  automaticPointerMoveRequestDigest,
  automaticPointerMoveCapsuleDigest,
  verifyAutomaticPointerMoveCapsule,
  type AutomaticPointerMoveCapsule,
} from "../domain/automatic-pointer-move";
import { canonicalProviderUsageJson } from "../domain/provider-usage";
import { AUTOMATIC_USAGE_MOVE_LINEAGE_LIMIT, settledAutomaticPointerMoveSchema, type SettledAutomaticPointerMove } from "../domain/usage-policy";
import { attemptIdSchema } from "../domain/values";
import { normalizeSchemaSql } from "./schema-cohort";

export const AUTOMATIC_POINTER_MOVE_KIND = "usage.pointer.move";
export const AUTOMATIC_POINTER_MOVE_AUTHORITY = "provider:codex";
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class AutomaticPointerMoveStoreError extends Error {
  constructor(readonly code: "AUTOMATIC_POINTER_MOVE_CORRUPT" | "AUTOMATIC_POINTER_MOVE_CLOSED_API_REQUIRED"
    | "AUTOMATIC_POINTER_MOVE_REQUEST_CONFLICT" | "AUTOMATIC_POINTER_MOVE_CAS_CONFLICT"
    | "AUTOMATIC_POINTER_MOVE_NOT_ADMITTED" | "AUTOMATIC_POINTER_MOVE_LINEAGE_GAP" | "AUTOMATIC_POINTER_MOVE_LINEAGE_OVERFLOW") {
    super(code); this.name = "AutomaticPointerMoveStoreError";
  }
}
const fail = (): never => { throw new AutomaticPointerMoveStoreError("AUTOMATIC_POINTER_MOVE_CORRUPT"); };
const tables = [
  { name: "automatic_pointer_moves", sql: `CREATE TABLE IF NOT EXISTS automatic_pointer_moves(
    attempt_id TEXT PRIMARY KEY REFERENCES mutation_attempts(id), original_key TEXT NOT NULL UNIQUE,
    move_id TEXT NOT NULL UNIQUE CHECK(length(move_id)=40 AND move_id NOT GLOB '*[^0-9a-f]*'),
    provider TEXT NOT NULL CHECK(provider='codex'), from_pointer_revision INTEGER NOT NULL CHECK(from_pointer_revision BETWEEN 1 AND 9007199254740990),
    to_pointer_revision INTEGER NOT NULL CHECK(to_pointer_revision=from_pointer_revision+1),
    source_provider_account_id TEXT NOT NULL REFERENCES provider_accounts(id), target_provider_account_id TEXT NOT NULL REFERENCES provider_accounts(id),
    request_digest TEXT NOT NULL CHECK(length(request_digest)=64), capsule_digest TEXT NOT NULL CHECK(length(capsule_digest)=64),
    capsule_json TEXT NOT NULL CHECK(json_valid(capsule_json) AND length(CAST(capsule_json AS BLOB))<=4194304),
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB))<=16384),
    receipt_digest TEXT NOT NULL CHECK(length(receipt_digest)=64), recorded_at INTEGER NOT NULL CHECK(recorded_at BETWEEN 0 AND 9007199254740991),
    UNIQUE(provider,from_pointer_revision), UNIQUE(provider,to_pointer_revision),
    CHECK(source_provider_account_id!=target_provider_account_id)
  ) STRICT;` },
  { name: "automatic_pointer_move_anchors", sql: `CREATE TABLE IF NOT EXISTS automatic_pointer_move_anchors(
    attempt_id TEXT PRIMARY KEY REFERENCES automatic_pointer_moves(attempt_id), original_key TEXT NOT NULL UNIQUE,
    move_id TEXT NOT NULL UNIQUE, request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
    from_pointer_revision INTEGER NOT NULL UNIQUE CHECK(from_pointer_revision BETWEEN 1 AND 9007199254740990),
    to_pointer_revision INTEGER NOT NULL UNIQUE CHECK(to_pointer_revision=from_pointer_revision+1),
    capsule_digest TEXT NOT NULL CHECK(length(capsule_digest)=64), receipt_digest TEXT NOT NULL CHECK(length(receipt_digest)=64),
    recorded_at INTEGER NOT NULL CHECK(recorded_at BETWEEN 0 AND 9007199254740991)
  ) STRICT;` },
] as const;
const owned = (id: string, key: string, kind: string): string => `(${kind}='${AUTOMATIC_POINTER_MOVE_KIND}'
  OR EXISTS(SELECT 1 FROM automatic_pointer_moves move WHERE move.attempt_id=${id} OR move.original_key=${key})
  OR EXISTS(SELECT 1 FROM automatic_pointer_move_anchors anchor WHERE anchor.attempt_id=${id} OR anchor.original_key=${key}))`;
const guards = [
  { name: "automatic_pointer_move_insert_guard", table: "automatic_pointer_moves", sql: `CREATE TRIGGER IF NOT EXISTS automatic_pointer_move_insert_guard
    BEFORE INSERT ON automatic_pointer_moves WHEN NOT EXISTS(
      SELECT 1 FROM mutation_attempts mutation JOIN provider_account_states pointer ON pointer.provider='codex'
      JOIN daemon_state daemon ON daemon.singleton=1
      JOIN provider_accounts source ON source.id=NEW.source_provider_account_id
      JOIN provider_accounts target ON target.id=NEW.target_provider_account_id
      JOIN profiles source_profile ON source_profile.id=source.profile_id AND source_profile.state!='removed' AND source_profile.process_generation=source.process_generation
      JOIN profiles target_profile ON target_profile.id=target.profile_id AND target_profile.state!='removed' AND target_profile.process_generation=target.process_generation
      JOIN account_rate_limit_reset_policies reset ON reset.profile_id=source.profile_id
      WHERE mutation.id=NEW.attempt_id AND mutation.idempotency_key=NEW.original_key AND mutation.kind='${AUTOMATIC_POINTER_MOVE_KIND}'
        AND mutation.authority_id='${AUTOMATIC_POINTER_MOVE_AUTHORITY}' AND mutation.authority_generation=NEW.from_pointer_revision
        AND mutation.request_digest=NEW.request_digest AND mutation.state='prepared' AND mutation.result_json IS NULL
        AND pointer.pointer_revision=NEW.from_pointer_revision AND pointer.active_provider_account_id=source.id
        AND pointer.order_revision=json_extract(NEW.capsule_json,'$.request.expectedOrderRevision')
        AND daemon.generation=json_extract(NEW.capsule_json,'$.request.daemonGeneration')
        AND daemon.boot_id=json_extract(NEW.capsule_json,'$.request.bootId') AND daemon.stopped_at IS NULL
        AND source.provider='codex' AND target.provider='codex' AND source.readiness='signed_in' AND target.readiness='signed_in'
        AND source.process_generation>0 AND target.process_generation>0
        AND NOT EXISTS(SELECT 1 FROM mutation_attempts auth LEFT JOIN mutation_resolutions resolution ON resolution.attempt_id=auth.id
          WHERE auth.authority_id IN (source.profile_id,target.profile_id) AND auth.kind IN ('account.login','account.logout','account.login-cancel')
            AND auth.state IN ('prepared','effect_started','ambiguous') AND resolution.attempt_id IS NULL)
        AND NOT EXISTS(SELECT 1 FROM account_rate_limit_reset_attempts attempt WHERE attempt.profile_id IN (source.profile_id,target.profile_id)
          AND attempt.state NOT IN ('settled','closed'))
        AND source.binding_generation=json_extract(NEW.capsule_json,'$.move.authority.source.authority.bindingGeneration')
        AND source.process_generation=json_extract(NEW.capsule_json,'$.move.authority.source.authority.processGeneration')
        AND target.binding_generation=json_extract(NEW.capsule_json,'$.move.target.authority.bindingGeneration')
        AND target.process_generation=json_extract(NEW.capsule_json,'$.move.target.authority.processGeneration')
        AND reset.revision=json_extract(NEW.capsule_json,'$.request.expectedResetPolicyRevision')
        AND (SELECT MAX(automatic_policy_revision) FROM automatic_usage_policy_revisions)=json_extract(NEW.capsule_json,'$.request.expectedAutomaticPolicyRevision'))
    BEGIN SELECT RAISE(ABORT,'AUTOMATIC_POINTER_MOVE_CAS_CONFLICT'); END;` },
  { name: "automatic_pointer_move_anchor_insert_guard", table: "automatic_pointer_move_anchors", sql: `CREATE TRIGGER IF NOT EXISTS automatic_pointer_move_anchor_insert_guard
    BEFORE INSERT ON automatic_pointer_move_anchors WHEN NOT EXISTS(SELECT 1 FROM automatic_pointer_moves move
      WHERE move.attempt_id=NEW.attempt_id AND move.original_key=NEW.original_key AND move.move_id=NEW.move_id
        AND move.from_pointer_revision=NEW.from_pointer_revision AND move.to_pointer_revision=NEW.to_pointer_revision
        AND move.request_digest=NEW.request_digest AND move.capsule_digest=NEW.capsule_digest
        AND move.receipt_digest=NEW.receipt_digest AND move.recorded_at=NEW.recorded_at)
    BEGIN SELECT RAISE(ABORT,'AUTOMATIC_POINTER_MOVE_CORRUPT'); END;` },
  { name: "automatic_pointer_move_mutation_insert_guard", table: "mutation_attempts", sql: `CREATE TRIGGER IF NOT EXISTS automatic_pointer_move_mutation_insert_guard
    BEFORE INSERT ON mutation_attempts WHEN EXISTS(SELECT 1 FROM automatic_pointer_moves move WHERE move.attempt_id=NEW.id OR move.original_key=NEW.idempotency_key)
      OR EXISTS(SELECT 1 FROM automatic_pointer_move_anchors anchor WHERE anchor.attempt_id=NEW.id OR anchor.original_key=NEW.idempotency_key)
    BEGIN SELECT RAISE(ABORT,'AUTOMATIC_POINTER_MOVE_CORRUPT'); END;` },
  { name: "automatic_pointer_move_mutation_update_guard", table: "mutation_attempts", sql: `CREATE TRIGGER IF NOT EXISTS automatic_pointer_move_mutation_update_guard
    BEFORE UPDATE ON mutation_attempts WHEN (${owned("OLD.id", "OLD.idempotency_key", "OLD.kind")} OR ${owned("NEW.id", "NEW.idempotency_key", "NEW.kind")}) AND NOT (
      NEW.id=OLD.id AND NEW.idempotency_key=OLD.idempotency_key AND NEW.kind=OLD.kind AND NEW.authority_id=OLD.authority_id
      AND NEW.authority_generation=OLD.authority_generation AND NEW.request_digest=OLD.request_digest AND NEW.created_at=OLD.created_at
      AND NEW.request_format IS OLD.request_format AND NEW.request_format IS NULL AND EXISTS(
        SELECT 1 FROM automatic_pointer_moves move JOIN automatic_pointer_move_anchors anchor ON anchor.attempt_id=move.attempt_id
        WHERE move.attempt_id=OLD.id AND anchor.original_key=OLD.idempotency_key AND anchor.receipt_digest=move.receipt_digest
          AND NEW.updated_at=move.recorded_at AND (
            (OLD.state='prepared' AND NEW.state='effect_started' AND NEW.result_json IS NULL)
            OR (OLD.state='effect_started' AND NEW.state='applied' AND NEW.result_json IS move.receipt_json
              AND EXISTS(SELECT 1 FROM provider_account_states pointer WHERE pointer.provider='codex'
                AND pointer.pointer_revision=move.to_pointer_revision AND pointer.active_provider_account_id=move.target_provider_account_id)))))
    BEGIN SELECT RAISE(ABORT,'AUTOMATIC_POINTER_MOVE_CLOSED_API_REQUIRED'); END;` },
  { name: "automatic_pointer_move_mutation_delete_guard", table: "mutation_attempts", sql: `CREATE TRIGGER IF NOT EXISTS automatic_pointer_move_mutation_delete_guard
    BEFORE DELETE ON mutation_attempts WHEN ${owned("OLD.id", "OLD.idempotency_key", "OLD.kind")}
    BEGIN SELECT RAISE(ABORT,'AUTOMATIC_POINTER_MOVE_CLOSED_API_REQUIRED'); END;` },
  ...["mutation_effect_evidence", "mutation_resolutions", "mutation_provider_authorities"].map((table) => ({
    name: `${table}_automatic_pointer_move_guard`, table, sql: `CREATE TRIGGER IF NOT EXISTS ${table}_automatic_pointer_move_guard
      BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM mutation_attempts m WHERE m.id=NEW.attempt_id AND ${owned("m.id", "m.idempotency_key", "m.kind")})
        OR EXISTS(SELECT 1 FROM automatic_pointer_moves move WHERE move.attempt_id=NEW.attempt_id)
        OR EXISTS(SELECT 1 FROM automatic_pointer_move_anchors anchor WHERE anchor.attempt_id=NEW.attempt_id)
      BEGIN SELECT RAISE(ABORT,'AUTOMATIC_POINTER_MOVE_CLOSED_API_REQUIRED'); END;`,
  })),
  ...tables.flatMap((table) => ["UPDATE", "DELETE"].map((event) => ({
    name: `${table.name}_immutable_${event.toLowerCase()}`, table: table.name,
    sql: `CREATE TRIGGER IF NOT EXISTS ${table.name}_immutable_${event.toLowerCase()} BEFORE ${event} ON ${table.name}
      BEGIN SELECT RAISE(ABORT,'AUTOMATIC_POINTER_MOVE_CORRUPT'); END;`,
  }))),
];
export const AUTOMATIC_POINTER_MOVE_SCHEMA_OBJECTS = [
  ...tables.map((table) => ({ ...table, table: table.name, type: "table" as const })),
  { name: "automatic_pointer_move_mutation_head", table: "mutation_attempts", type: "index" as const,
    sql: `CREATE INDEX IF NOT EXISTS automatic_pointer_move_mutation_head ON mutation_attempts(authority_generation DESC) WHERE kind='usage.pointer.move';` },
  ...guards.map((guard) => ({ ...guard, type: "trigger" as const })),
] as const;
export function applyAutomaticPointerMoveSchema(database: Database): void {
  for (const object of AUTOMATIC_POINTER_MOVE_SCHEMA_OBJECTS) database.exec(object.sql);
}
export function assertAutomaticPointerMoveSchema(database: Database): void {
  for (const object of AUTOMATIC_POINTER_MOVE_SCHEMA_OBJECTS) {
    const row = database.query("SELECT type,tbl_name,sql FROM sqlite_master WHERE name=?").get(object.name) as
      { type: string; tbl_name: string; sql: string } | null;
    if (row === null || row.type !== object.type || row.tbl_name !== object.table || normalizeSchemaSql(row.sql) !== normalizeSchemaSql(object.sql)) fail();
  }
}
export type AutomaticPointerMoveHistory = Readonly<{
  kind: "automatic_pointer_move"; attemptId: z.infer<typeof attemptIdSchema>; idempotencyKey: string;
  capsule: AutomaticPointerMoveCapsule; capsuleDigest: string; move: SettledAutomaticPointerMove;
}>;
type Lookup = { idempotencyKey: string } | { attemptId: string };
export function classifyAutomaticPointerMove(database: Database, lookup: Lookup):
  { kind: "absent" } | { kind: "legacy" } | AutomaticPointerMoveHistory {
  // The shared legacy classifier also runs in genuine pre-v46/minimal fixtures.
  const version = (database.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version < 46 && database.query("SELECT 1 FROM sqlite_master WHERE name IN ('automatic_pointer_moves','automatic_pointer_move_anchors') LIMIT 1").get() === null) return { kind: "absent" };
  assertAutomaticPointerMoveSchema(database);
  const byKey = "idempotencyKey" in lookup;
  const value = byKey ? z.string().uuid().parse(lookup.idempotencyKey) : z.string().min(1).max(200).parse(lookup.attemptId);
  const ids = database.query(`SELECT id AS attempt_id FROM mutation_attempts WHERE ${byKey ? "idempotency_key" : "id"}=?
    UNION SELECT attempt_id FROM automatic_pointer_moves WHERE ${byKey ? "original_key" : "attempt_id"}=?
    UNION SELECT attempt_id FROM automatic_pointer_move_anchors WHERE ${byKey ? "original_key" : "attempt_id"}=? LIMIT 2`)
    .all(value, value, value) as Array<{ attempt_id: string }>;
  if (ids.length === 0) return { kind: "absent" };
  if (ids.length !== 1 || ids[0] === undefined) return fail();
  const id = ids[0].attempt_id;
  const mutation = database.query("SELECT * FROM mutation_attempts WHERE id=?").get(id) as Record<string, unknown> | null;
  const row = database.query("SELECT * FROM automatic_pointer_moves WHERE attempt_id=?").get(id) as Record<string, unknown> | null;
  const anchor = database.query("SELECT * FROM automatic_pointer_move_anchors WHERE attempt_id=?").get(id) as Record<string, unknown> | null;
  if (mutation !== null && mutation.kind !== AUTOMATIC_POINTER_MOVE_KIND && row === null && anchor === null) return { kind: "legacy" };
  if (row === null || anchor === null || mutation === null) return fail();
  try {
    const json = z.string().max(4 * 1024 * 1024).parse(row.capsule_json);
    const capsule = verifyAutomaticPointerMoveCapsule(JSON.parse(json) as unknown);
    if (canonicalProviderUsageJson(capsule) !== json) return fail();
    const capsuleDigest = automaticPointerMoveCapsuleDigest(capsule);
    const move = settledAutomaticPointerMoveSchema.parse(capsule.move);
    const receipt = JSON.stringify(move);
    const attemptId = attemptIdSchema.parse(id);
    if (row.original_key !== capsule.request.idempotencyKey || row.move_id !== move.moveId || row.provider !== "codex"
      || row.from_pointer_revision !== move.authority.pointerRevision || row.to_pointer_revision !== move.toPointerRevision
      || row.source_provider_account_id !== move.authority.source.authority.providerAccountId || row.target_provider_account_id !== move.target.authority.providerAccountId
      || row.request_digest !== automaticPointerMoveRequestDigest(capsule.request) || row.capsule_digest !== capsuleDigest
      || row.receipt_json !== receipt || row.receipt_digest !== digest(move) || row.recorded_at !== move.settledAt
      || mutation.idempotency_key !== row.original_key || mutation.kind !== AUTOMATIC_POINTER_MOVE_KIND
      || mutation.authority_id !== AUTOMATIC_POINTER_MOVE_AUTHORITY || mutation.authority_generation !== row.from_pointer_revision
      || mutation.request_digest !== row.request_digest || mutation.state !== "applied" || mutation.result_json !== receipt
      || mutation.request_format !== null || mutation.created_at !== move.settledAt || mutation.updated_at !== move.settledAt
      || anchor.original_key !== row.original_key || anchor.move_id !== row.move_id || anchor.request_digest !== row.request_digest
      || anchor.from_pointer_revision !== row.from_pointer_revision || anchor.to_pointer_revision !== row.to_pointer_revision
      || anchor.capsule_digest !== row.capsule_digest || anchor.receipt_digest !== row.receipt_digest || anchor.recorded_at !== row.recorded_at) return fail();
    if (database.query(`SELECT 1 FROM mutation_effect_evidence WHERE attempt_id=? UNION SELECT 1 FROM mutation_resolutions WHERE attempt_id=?
      UNION SELECT 1 FROM mutation_provider_authorities WHERE attempt_id=? LIMIT 1`).get(id, id, id) !== null) return fail();
    return { kind: "automatic_pointer_move", attemptId, idempotencyKey: capsule.request.idempotencyKey, capsule, capsuleDigest, move };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "SQLiteError") throw error;
    return fail();
  }
}
export function assertNoAutomaticPointerMoveOwnership(database: Database, lookup: Lookup): void {
  if (classifyAutomaticPointerMove(database, lookup).kind === "automatic_pointer_move") {
    throw new AutomaticPointerMoveStoreError("AUTOMATIC_POINTER_MOVE_CLOSED_API_REQUIRED");
  }
}
export function assertAutomaticPointerMoveHead(database: Database): void {
  assertAutomaticPointerMoveSchema(database);
  const head = database.query("SELECT active_provider_account_id,pointer_revision FROM provider_account_states WHERE provider='codex'").get() as
    { active_provider_account_id: string | null; pointer_revision: number } | null;
  if (head === null) return fail();
  // Each independent owner can identify the newest automatic transition even
  // when another table was sparsely deleted. A higher mutable pointer alone is
  // never evidence that the missing transition was a manual change.
  const anchored = database.query("SELECT original_key,to_pointer_revision FROM automatic_pointer_move_anchors ORDER BY to_pointer_revision DESC LIMIT 1").get() as
    { original_key: string; to_pointer_revision: number } | null;
  const mutation = database.query(`SELECT idempotency_key,authority_generation FROM mutation_attempts WHERE kind='${AUTOMATIC_POINTER_MOVE_KIND}' ORDER BY authority_generation DESC LIMIT 1`).get() as
    { idempotency_key: string; authority_generation: number } | null;
  const latest = database.query("SELECT original_key,to_pointer_revision,target_provider_account_id FROM automatic_pointer_moves WHERE provider='codex' ORDER BY to_pointer_revision DESC LIMIT 1").get() as
    { original_key: string; to_pointer_revision: number; target_provider_account_id: string } | null;
  if ((latest === null) !== (anchored === null) || (latest === null) !== (mutation === null)) return fail();
  if (latest !== null) {
    if (anchored?.original_key !== latest.original_key || anchored.to_pointer_revision !== latest.to_pointer_revision
      || mutation?.idempotency_key !== latest.original_key || mutation.authority_generation + 1 !== latest.to_pointer_revision) return fail();
    if (latest.to_pointer_revision > head.pointer_revision || (latest.to_pointer_revision === head.pointer_revision
      && latest.target_provider_account_id !== head.active_provider_account_id)) return fail();
    classifyAutomaticPointerMove(database, { idempotencyKey: latest.original_key });
  }
}
export function auditAutomaticPointerMoves(database: Database): void {
  assertAutomaticPointerMoveSchema(database);
  let after = "";
  for (;;) {
    const rows = database.query(`SELECT id AS attempt_id FROM mutation_attempts WHERE kind='${AUTOMATIC_POINTER_MOVE_KIND}' AND id>?
      UNION SELECT attempt_id FROM automatic_pointer_moves WHERE attempt_id>?
      UNION SELECT attempt_id FROM automatic_pointer_move_anchors WHERE attempt_id>?
      ORDER BY attempt_id LIMIT 100`).all(after, after, after) as Array<{ attempt_id: string }>;
    if (rows.length === 0) break;
    for (const row of rows) { classifyAutomaticPointerMove(database, { attemptId: row.attempt_id }); after = row.attempt_id; }
  }
  assertAutomaticPointerMoveHead(database);
}
export function readAutomaticPointerMoveLineage(database: Database, fromPointerRevision: number, throughPointerRevision: number): readonly SettledAutomaticPointerMove[] {
  const from = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(fromPointerRevision);
  const through = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(throughPointerRevision);
  if (through < from) throw new AutomaticPointerMoveStoreError("AUTOMATIC_POINTER_MOVE_LINEAGE_GAP");
  if (through - from > AUTOMATIC_USAGE_MOVE_LINEAGE_LIMIT) throw new AutomaticPointerMoveStoreError("AUTOMATIC_POINTER_MOVE_LINEAGE_OVERFLOW");
  assertAutomaticPointerMoveSchema(database);
  assertAutomaticPointerMoveHead(database);
  const current = database.query("SELECT pointer_revision FROM provider_account_states WHERE provider='codex'").get() as { pointer_revision: number };
  if (through > current.pointer_revision) throw new AutomaticPointerMoveStoreError("AUTOMATIC_POINTER_MOVE_LINEAGE_GAP");
  const rows = database.query("SELECT original_key FROM automatic_pointer_moves WHERE provider='codex' AND from_pointer_revision>=? AND to_pointer_revision<=? ORDER BY from_pointer_revision LIMIT ?")
    .all(from, through, AUTOMATIC_USAGE_MOVE_LINEAGE_LIMIT + 1) as Array<{ original_key: string }>;
  if (rows.length !== through - from) throw new AutomaticPointerMoveStoreError("AUTOMATIC_POINTER_MOVE_LINEAGE_GAP");
  const moves = rows.map((row) => {
    const record = classifyAutomaticPointerMove(database, { idempotencyKey: row.original_key });
    if (record.kind !== "automatic_pointer_move") return fail();
    return record.move;
  });
  let previous: SettledAutomaticPointerMove | undefined;
  const processes = new Map<string, number>();
  for (const [index, move] of moves.entries()) {
    if (move.authority.pointerRevision !== from + index || (previous !== undefined && (
      previous.target.authority.providerAccountId !== move.authority.source.authority.providerAccountId
      || previous.target.authority.bindingGeneration !== move.authority.source.authority.bindingGeneration
      || previous.target.authority.processGeneration > move.authority.source.authority.processGeneration
      || previous.settledAt > move.authority.evaluatedAt
      || previous.authority.orderRevision > move.authority.orderRevision
      || previous.authority.automaticPolicyRevision > move.authority.automaticPolicyRevision))) throw new AutomaticPointerMoveStoreError("AUTOMATIC_POINTER_MOVE_LINEAGE_GAP");
    for (const { authority } of [move.authority.source, move.target]) {
      const key = `${authority.providerAccountId}:${authority.bindingGeneration}`;
      if ((processes.get(key) ?? 0) > authority.processGeneration) throw new AutomaticPointerMoveStoreError("AUTOMATIC_POINTER_MOVE_LINEAGE_GAP");
      processes.set(key, authority.processGeneration);
    }
    previous = move;
  }
  return moves;
}
export function insertAutomaticPointerMove(database: Database, attemptId: string, capsule: AutomaticPointerMoveCapsule): AutomaticPointerMoveHistory {
  const verified = verifyAutomaticPointerMoveCapsule(capsule);
  const move = verified.move;
  const request = verified.request;
  const requestDigest = automaticPointerMoveRequestDigest(request);
  const capsuleDigest = automaticPointerMoveCapsuleDigest(verified);
  const receiptDigest = digest(move);
  const receipt = JSON.stringify(move);
  database.query(`INSERT INTO mutation_attempts(id,idempotency_key,kind,authority_id,authority_generation,request_digest,state,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'prepared',?,?)`).run(attemptId, request.idempotencyKey, AUTOMATIC_POINTER_MOVE_KIND, AUTOMATIC_POINTER_MOVE_AUTHORITY,
    move.authority.pointerRevision, requestDigest, move.settledAt, move.settledAt);
  database.query(`INSERT INTO automatic_pointer_moves(attempt_id,original_key,move_id,provider,from_pointer_revision,to_pointer_revision,
    source_provider_account_id,target_provider_account_id,request_digest,capsule_digest,capsule_json,receipt_json,receipt_digest,recorded_at)
    VALUES(?,?,?,'codex',?,?,?,?,?,?,?,?,?,?)`).run(attemptId, request.idempotencyKey, move.moveId, move.authority.pointerRevision, move.toPointerRevision,
    move.authority.source.authority.providerAccountId, move.target.authority.providerAccountId, requestDigest, capsuleDigest,
    canonicalProviderUsageJson(verified), receipt, receiptDigest, move.settledAt);
  database.query(`INSERT INTO automatic_pointer_move_anchors(attempt_id,original_key,move_id,from_pointer_revision,to_pointer_revision,request_digest,capsule_digest,receipt_digest,recorded_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(attemptId, request.idempotencyKey, move.moveId, move.authority.pointerRevision, move.toPointerRevision, requestDigest, capsuleDigest, receiptDigest, move.settledAt);
  if (database.query("UPDATE mutation_attempts SET state='effect_started' WHERE id=? AND state='prepared'").run(attemptId).changes !== 1) return fail();
  const changed = database.query(`UPDATE provider_account_states SET active_provider_account_id=?,pointer_revision=pointer_revision+1,updated_at=MAX(updated_at,?)
    WHERE provider='codex' AND active_provider_account_id=? AND pointer_revision=? AND order_revision=?`)
    .run(move.target.authority.providerAccountId, move.settledAt, move.authority.source.authority.providerAccountId,
      move.authority.pointerRevision, move.authority.orderRevision);
  if (changed.changes !== 1) throw new AutomaticPointerMoveStoreError("AUTOMATIC_POINTER_MOVE_CAS_CONFLICT");
  if (database.query("UPDATE mutation_attempts SET state='applied',result_json=? WHERE id=? AND state='effect_started'").run(receipt, attemptId).changes !== 1) return fail();
  const record = classifyAutomaticPointerMove(database, { idempotencyKey: request.idempotencyKey });
  if (record.kind !== "automatic_pointer_move") return fail();
  assertAutomaticPointerMoveHead(database);
  return record;
}
