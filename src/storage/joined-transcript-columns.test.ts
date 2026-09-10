import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { z } from "zod";

import { combined49DatabaseBytes } from "../../scripts/fixtures/combined49";
import { combined49RetiredDatabaseBytes } from "../../scripts/fixtures/combined49-retired";
import { combined49SwitchDatabaseBytes } from "../../scripts/fixtures/combined49-switch";
import { privateTask48DatabaseBytes, privateTask48Fixture } from "../../scripts/fixtures/private-task48";
import { privateTask48PinnedDatabaseBytes } from "../../scripts/fixtures/private-task48-pinned";
import { privateTask48UsageDatabaseBytes } from "../../scripts/fixtures/private-task48-usage";
import { applyJoinedAttachmentTerminalGuard, assertAttachmentCustodySchema, auditAttachmentCustody } from "./attachment-custody";
import { ATTACHMENT_CUSTODY_COLUMNS } from "./attachment-custody-schema";
import { schemaSqlBeforeJoinedTranscriptColumns } from "./joined-transcript-columns";
import { assertQueueAttachmentSchema, auditQueueAttachmentIdentities, readQueueAttachmentIdentity } from "./queue-attachment-identity";
import { normalizeSchemaSql } from "./schema-cohort";
import { assertSessionSendOwnerSchema, auditSessionSendOwners, classifySessionSendOwnership } from "./session-send-owner";

// Literal declarations from canonical43 at 97cebc44ecd2d27b8c0b6399b0814b1993d94fc1.
// These synthetic ALTERs test table-layout compatibility, not a completed join
// or historical writer output. Original fixture bytes and all old rows remain.
const transcriptColumns = [
  "transcript_finalized INTEGER NOT NULL DEFAULT 0 CHECK(transcript_finalized IN (0,1))",
  "transcript_status TEXT NOT NULL DEFAULT 'none' CHECK(transcript_status IN ('none','pending','finalized','unavailable','abandoned'))",
  "transcript_intent_json TEXT CHECK(transcript_intent_json IS NULL OR ( json_valid(transcript_intent_json) AND length(CAST(transcript_intent_json AS BLOB))<=65536 ))",
] as const;
const peerColumns = [
  "message_actor TEXT NOT NULL DEFAULT 'human' CHECK(message_actor IN ('human','peer_session'))",
  "peer_action_id TEXT REFERENCES peer_session_actions(id)",
] as const;
const checks = [
  { table: "mutation_attempts", assert: assertSessionSendOwnerSchema, error: "SESSION_SEND_OWNER_CORRUPT" },
  { table: "mutation_attempts", assert: assertAttachmentCustodySchema, error: "ATTACHMENT_CUSTODY_CORRUPT" },
  { table: "queue_entries", assert: assertQueueAttachmentSchema, error: "QUEUE_ATTACHMENT_IDENTITY_CORRUPT" },
] as const;
const captures = [
  { name: "private48", bytes: privateTask48DatabaseBytes },
  { name: "private48 pinned", bytes: privateTask48PinnedDatabaseBytes },
  { name: "private48 usage", bytes: privateTask48UsageDatabaseBytes },
  { name: "combined49", bytes: combined49DatabaseBytes },
  { name: "combined49 switch", bytes: combined49SwitchDatabaseBytes },
  { name: "combined49 retired", bytes: combined49RetiredDatabaseBytes },
] as const;
const databases: Database[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const database of databases.splice(0).reverse()) database.close(false);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function archive(bytes: Uint8Array) {
  const root = await mkdtemp(join(tmpdir(), "oompa-joined-column-audit-"));
  roots.push(root);
  const path = join(root, "state.sqlite");
  await writeFile(path, bytes, { mode: 0o600 });
  const database = new Database(path, { create: false, strict: true });
  databases.push(database);
  database.exec("PRAGMA foreign_keys=ON");
  return database;
}
function snapshot(database: Database, omitJoinedColumns = false) {
  const tables = z.array(z.object({ name: z.string().regex(/^[a-z_0-9]+$/u) }).strict()).parse(
    database.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),
  );
  return {
    version: database.query("PRAGMA user_version").get(),
    schema: z.array(z.object({ type: z.string(), name: z.string(), tbl_name: z.string(), sql: z.string().nullable() }).strict()).parse(
      database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
    ),
    changes: database.query("SELECT total_changes() AS count").get(),
    violations: database.query("PRAGMA foreign_key_check").all(),
    rows: Object.fromEntries(tables.map(({ name }) => [name,
      database.query(`SELECT * FROM "${name}"`).all().map((value) => {
        const row = z.record(z.string(), z.unknown()).parse(value);
        return JSON.stringify(Object.fromEntries(Object.entries(row).filter(([key]) =>
          !omitJoinedColumns || !["transcript_finalized", "transcript_status", "transcript_intent_json", "message_actor", "peer_action_id"].includes(key),
        )));
      }).sort(),
    ])),
  };
}
function append(database: Database, table: string, columns: readonly string[] = transcriptColumns) {
  for (const column of columns) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
}

// Table-layout checks do not install a whole joined store. Explicitly install
// the reviewed guard successor before selecting its joined schema contract.
function installJoinedGuard(database: Database) {
  const before = snapshot(database);
  database.transaction(() => applyJoinedAttachmentTerminalGuard(database)).immediate();
  const after = snapshot(database);
  expect(after.rows).toEqual(before.rows);
  expect(after.version).toEqual(before.version);
  expect(after.changes).toEqual(before.changes);
  expect(after.schema.filter((object) => object.name !== "attachment_terminal_projection_guard"))
    .toEqual(before.schema.filter((object) => object.name !== "attachment_terminal_projection_guard"));
}

// Schema-only control: the canonical-first route installs transcript columns
// before usage. This synthetic empty schema is not a captured database or a
// predecessor-admission/row-authority proof. Use real ALTERs for both groups.
function canonicalFirstSchema(source: Database) {
  const objects = z.array(z.object({ type: z.string(), name: z.string(), sql: z.string() }).strict()).parse(
    source.query("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),
  );
  const database = new Database(":memory:", { strict: true });
  databases.push(database);
  for (const object of objects.filter((object) => object.type === "table")) {
    const marker = object.name === "mutation_attempts" ? ", request_format "
      : object.name === "queue_entries" ? ", enqueue_identity_format " : null;
    if (marker === null) database.exec(object.sql);
    else {
      const sql = normalizeSchemaSql(object.sql);
      const start = sql.indexOf(marker);
      expect(start).toBeGreaterThan(0);
      expect(start).toBe(sql.lastIndexOf(marker));
      database.exec(sql.slice(0, start) + ") STRICT");
    }
  }
  append(database, "mutation_attempts");
  database.exec("CREATE TABLE peer_session_actions(id TEXT PRIMARY KEY) STRICT");
  append(database, "queue_entries", [...transcriptColumns, ...peerColumns]);
  append(database, "mutation_attempts", [
    "request_format TEXT CHECK(request_format IS NULL OR request_format='original_send_v1')",
    ...ATTACHMENT_CUSTODY_COLUMNS,
  ]);
  append(database, "queue_entries", [
    "enqueue_identity_format TEXT CHECK(enqueue_identity_format IS NULL OR enqueue_identity_format='atomic_attachments_v1')",
    "enqueue_identity_attempt_id TEXT REFERENCES queue_attachment_identities(attempt_id) DEFERRABLE INITIALLY DEFERRED CHECK((enqueue_identity_format IS NULL AND enqueue_identity_attempt_id IS NULL) OR (enqueue_identity_format IS 'atomic_attachments_v1' AND enqueue_identity_attempt_id IS NOT NULL))",
  ]);
  for (const object of objects.filter((object) => object.type !== "table")) database.exec(object.sql);
  database.exec("PRAGMA foreign_keys=ON");
  return database;
}

describe("exact retained-usage transcript column layouts", () => {
  for (const capture of captures) {
    test(`${capture.name}: historical admission stays closed and joined checks preserve all old data`, async () => {
      const bytes = capture.bytes();
      const untouched = Uint8Array.from(bytes);
      const database = await archive(bytes);
      const original = snapshot(database);
      for (const check of checks) {
        expect(() => check.assert(database)).not.toThrow();
        if (check.assert === assertAttachmentCustodySchema) {
          expect(() => check.assert(database, "joined")).toThrow("ATTACHMENT_CUSTODY_TERMINAL_GUARD_INVALID");
        } else expect(() => check.assert(database, "joined")).not.toThrow();
      }
      expect(snapshot(database)).toEqual(original);
      append(database, "mutation_attempts");
      append(database, "queue_entries");
      installJoinedGuard(database);
      const joined = snapshot(database);
      expect(joined.version).toEqual(original.version);
      const untouchedSchema = (schema: typeof original.schema) => schema.filter((object) =>
        object.name !== "attachment_terminal_projection_guard"
        && (object.type !== "table" || !["mutation_attempts", "queue_entries"].includes(object.name)),
      );
      expect(untouchedSchema(joined.schema)).toEqual(untouchedSchema(original.schema));
      expect(snapshot(database, true).rows).toEqual(original.rows);
      expect(joined.violations).toEqual([]);
      for (const check of checks) {
        expect(() => check.assert(database)).toThrow(check.error);
        expect(() => check.assert(database, "historical")).toThrow(check.error);
        expect(() => check.assert(database, "joined")).not.toThrow();
      }
      expect(snapshot(database)).toEqual(joined);
      expect(bytes).toEqual(untouched);
    });
  }

  for (const capture of captures) {
    test(`${capture.name}: exact canonical47 queue tail preserves historical authority`, async () => {
      const database = await archive(capture.bytes());
      // An empty peer parent isolates column compatibility, not producer output.
      database.exec("CREATE TABLE peer_session_actions(id TEXT PRIMARY KEY) STRICT");
      const original = snapshot(database);
      append(database, "mutation_attempts");
      append(database, "queue_entries", [...transcriptColumns, ...peerColumns]);
      installJoinedGuard(database);
      const joined = snapshot(database);
      expect(snapshot(database, true).rows).toEqual(original.rows);
      expect(joined.version).toEqual(original.version);
      expect(joined.violations).toEqual([]);
      for (const check of checks) {
        expect(() => check.assert(database, "historical")).toThrow(check.error);
        expect(() => check.assert(database, "joined")).not.toThrow();
      }
      expect(snapshot(database)).toEqual(joined);
    });
  }

  for (const variant of [
    { name: "partial peer append", columns: peerColumns.slice(0, 1) },
    { name: "reordered peer append", columns: [peerColumns[1], peerColumns[0]] },
    { name: "changed peer default", columns: [peerColumns[0].replace("DEFAULT 'human'", "DEFAULT 'peer_session'"), peerColumns[1]] },
    { name: "changed peer foreign key", columns: [peerColumns[0], peerColumns[1].replace("peer_session_actions", "sessions")] },
    { name: "surplus peer tail", columns: [...peerColumns, "unexpected_tail TEXT"] },
  ]) test(`refuses ${variant.name} without writes`, async () => {
    const database = await archive(privateTask48DatabaseBytes());
    database.exec("CREATE TABLE peer_session_actions(id TEXT PRIMARY KEY) STRICT");
    append(database, "queue_entries", [...transcriptColumns, ...variant.columns]);
    const before = snapshot(database);
    expect(() => assertQueueAttachmentSchema(database, "joined")).toThrow("QUEUE_ATTACHMENT_IDENTITY_CORRUPT");
    expect(snapshot(database)).toEqual(before);
  });

  for (const variant of [
    { name: "partial append", columns: transcriptColumns.slice(0, 2) },
    { name: "reordered append", columns: [transcriptColumns[1], transcriptColumns[0], transcriptColumns[2]] },
    { name: "changed JSON bound", columns: [transcriptColumns[0], transcriptColumns[1], transcriptColumns[2].replace("65536", "65537")] },
    { name: "changed status default", columns: [transcriptColumns[0], transcriptColumns[1].replace("DEFAULT 'none'", "DEFAULT 'pending'"), transcriptColumns[2]] },
    { name: "surplus tail", columns: [...transcriptColumns, "unexpected_tail TEXT"] },
  ]) {
    test(`refuses ${variant.name} without repairing schema or rows`, async () => {
      const database = await archive(privateTask48DatabaseBytes());
      append(database, "mutation_attempts", variant.columns);
      append(database, "queue_entries", variant.columns);
      installJoinedGuard(database);
      const before = snapshot(database);
      for (const check of checks) expect(() => check.assert(database, "joined")).toThrow(check.error);
      expect(snapshot(database)).toEqual(before);
    });
  }

  test("canonical-first append order retains the original absolute-tail contract", async () => {
    const source = await archive(privateTask48DatabaseBytes());
    const database = canonicalFirstSchema(source);
    const before = snapshot(database);
    for (const check of checks) {
      expect(() => check.assert(database)).not.toThrow();
    }
    expect(snapshot(database)).toEqual(before);
    installJoinedGuard(database);
    const joined = snapshot(database);
    for (const check of checks) expect(() => check.assert(database, "joined")).not.toThrow();
    expect(snapshot(database)).toEqual(joined);
  });

  test("prepared-only owner and sealed queue readers select joined layout without rewriting proof", async () => {
    const database = await archive(privateTask48DatabaseBytes());
    const owner = classifySessionSendOwnership(database, { attemptId: privateTask48Fixture.ownerAttemptId });
    const queue = readQueueAttachmentIdentity(database, privateTask48Fixture.queueId);
    expect(owner.kind).toBe("owned");
    expect(queue?.queueId).toBe(privateTask48Fixture.queueId);
    append(database, "mutation_attempts");
    database.exec("CREATE TABLE peer_session_actions(id TEXT PRIMARY KEY) STRICT");
    append(database, "queue_entries", [...transcriptColumns, ...peerColumns]);
    installJoinedGuard(database);
    const before = snapshot(database);
    expect(classifySessionSendOwnership(database, { attemptId: privateTask48Fixture.ownerAttemptId })).toEqual(owner);
    expect(readQueueAttachmentIdentity(database, privateTask48Fixture.queueId)).toEqual(queue);
    expect(() => auditSessionSendOwners(database)).not.toThrow();
    expect(() => auditQueueAttachmentIdentities(database)).not.toThrow();
    expect(() => auditAttachmentCustody(database, { kind: "source_selected", terminalGuard: "joined_v1" })).not.toThrow();
    expect(() => auditSessionSendOwners(database, { kind: "historical", format: "private_task48_v1" })).toThrow("SESSION_SEND_OWNER_CORRUPT");
    expect(() => auditQueueAttachmentIdentities(database, "historical")).toThrow("QUEUE_ATTACHMENT_IDENTITY_CORRUPT");
    expect(() => database.transaction(() => auditAttachmentCustody(database,
      { kind: "historical", format: "private_task48_v1" })).immediate()).toThrow("ATTACHMENT_CUSTODY_CORRUPT");
    expect(snapshot(database)).toEqual(before);
  });

  test("an exact textual suffix is insufficient without real SQLite columns", async () => {
    const database = await archive(privateTask48DatabaseBytes());
    for (const table of ["mutation_attempts", "queue_entries"] as const) {
      const { sql } = z.object({ sql: z.string() }).strict().parse(
        database.query("SELECT sql FROM sqlite_master WHERE name=?").get(table),
      );
      const normalized = normalizeSchemaSql(sql);
      expect(normalized.endsWith(") STRICT")).toBe(true);
      const fabricated = normalized.slice(0, -") STRICT".length) + ", " + transcriptColumns.join(", ") + ") STRICT";
      expect(schemaSqlBeforeJoinedTranscriptColumns(database, table, fabricated, "joined")).toBeNull();
      append(database, table);
      // Same exact text now has an independently observed SQLite column tail.
      expect(schemaSqlBeforeJoinedTranscriptColumns(database, table, fabricated, "joined")).toBe(normalized);
      if (table === "queue_entries") {
        const withPeers = fabricated.slice(0, -") STRICT".length) + ", " + peerColumns.join(", ") + ") STRICT";
        expect(schemaSqlBeforeJoinedTranscriptColumns(database, table, withPeers, "joined")).toBeNull();
        append(database, table, peerColumns);
        expect(schemaSqlBeforeJoinedTranscriptColumns(database, table, withPeers, "joined")).toBe(normalized);
      }
    }
  });

  test("foreign trailing columns cannot become an admitted joined layout", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 1_000_000 }), async (suffix) => {
      const database = await archive(privateTask48DatabaseBytes());
      append(database, "mutation_attempts", [...transcriptColumns, `foreign_${suffix} TEXT`]);
      append(database, "queue_entries", [...transcriptColumns, `foreign_${suffix} TEXT`]);
      installJoinedGuard(database);
      const before = snapshot(database);
      for (const check of checks) expect(() => check.assert(database, "joined")).toThrow(check.error);
      expect(snapshot(database)).toEqual(before);
      database.close(false);
      databases.splice(databases.indexOf(database), 1);
    }), { seed: 60043, numRuns: 12 });
  });
});
