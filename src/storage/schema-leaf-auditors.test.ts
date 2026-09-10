import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertAttachmentCustodySchema } from "./attachment-custody";
import { assertAutomaticPointerMoveSchema } from "./automatic-pointer-move";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { assertQueueAttachmentSchema } from "./queue-attachment-identity";
import { assertSessionSendOwnerSchema } from "./session-send-owner";
import { StateStore } from "./state-store";

let database: Database;
let home: string;
// This suite creates a current database; historical component tests select
// their frozen predecessor guard explicitly in their own fixtures.
const assertCurrentAttachmentCustodySchema = (db: Database): void =>
  assertAttachmentCustodySchema(db, "joined", "acknowledged_v1");
beforeAll(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "oompa-leaf-ddl-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const store = new StateStore(paths);
  store.close();
  database = new Database(paths.database, { strict: true });
  database.exec("PRAGMA foreign_keys=ON");
});
afterAll(async () => {
  database.close(false);
  await rm(home, { force: true, recursive: true });
});

const schemaDigest = (): string => createHash("sha256").update(JSON.stringify(database.query(
  "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
).all())).digest("hex");

function substituteDdl(name: string, original: string, replacement: string): void {
  const row = database.query("SELECT type,sql FROM sqlite_master WHERE name=?").get(name) as
    { type: "table" | "trigger" | "index"; sql: string } | null;
  if (row === null || !row.sql.includes(original)) throw new Error(`Missing original DDL fragment: ${name}`);
  // These disposable tables are empty. Preserve every dependent guard/index so
  // refusal cannot be explained by an accidentally missing schema object.
  const dependencies = row.type === "table" ? database.query(
    "SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('trigger','index') AND sql IS NOT NULL ORDER BY name",
  ).all(name) as { sql: string }[] : [];
  if (row.type === "table") {
    expect(database.query(`SELECT COUNT(*) AS count FROM ${name}`).get()).toEqual({ count: 0 });
  }
  database.exec(`DROP ${row.type.toUpperCase()} ${name}`);
  database.exec(row.sql.replaceAll(original, replacement));
  for (const dependency of dependencies) database.exec(dependency.sql);
}

function assertLiteralTamperingRefused(input: {
  name: string; original: string; replacement: string;
  audit: (database: Database) => void; error: string;
}): void {
  expect(() => input.audit(database)).not.toThrow();
  database.exec("BEGIN IMMEDIATE");
  try {
    substituteDdl(input.name, input.original, input.replacement);
    const before = schemaDigest();
    expect(() => input.audit(database)).toThrow(input.error);
    expect(schemaDigest()).toBe(before);
  } finally {
    database.exec("ROLLBACK");
  }
  expect(() => input.audit(database)).not.toThrow();
}

test("all four leaf auditors accept authentic current SQLite ALTER formatting", () => {
  for (const audit of [assertQueueAttachmentSchema, assertSessionSendOwnerSchema,
    assertAutomaticPointerMoveSchema, assertCurrentAttachmentCustodySchema]) {
    expect(() => audit(database)).not.toThrow();
  }
});

test.each([
  { name: "queue_entries", original: "'atomic_attachments_v1'", replacement: "'atomic_ attachments_v1'",
    audit: assertQueueAttachmentSchema, error: "QUEUE_ATTACHMENT_IDENTITY_CORRUPT" },
  { name: "mutation_attempts", original: "'original_send_v1'", replacement: "'original_ send_v1'",
    audit: assertSessionSendOwnerSchema, error: "SESSION_SEND_OWNER_CORRUPT" },
  { name: "mutation_attempts", original: "'empty_v1'", replacement: "'empty_ v1'",
    audit: assertCurrentAttachmentCustodySchema, error: "ATTACHMENT_CUSTODY_CORRUPT" },
  { name: "attachment_custody_members", original: "'text/plain'", replacement: "'text/ plain'",
    audit: assertCurrentAttachmentCustodySchema, error: "ATTACHMENT_CUSTODY_CORRUPT" },
])("leaf auditor preserves semantic literal whitespace: $name / $original", (input) => {
  expect(database.query(`SELECT ?1=${input.original} AS original, ?1=${input.replacement} AS changed`)
    .get(input.replacement.slice(1, -1))).toEqual({ original: 0, changed: 1 });
  assertLiteralTamperingRefused(input);
});

test("pointer leaf auditor refuses an IF NOT EXISTS injection that weakens a digest GLOB", () => {
  const original = "*[^0-9a-f]*";
  const replacement = "*[IF NOT EXISTS^0-9a-f]*";
  expect(database.query("SELECT ?1 NOT GLOB ?2 AS original, ?1 NOT GLOB ?3 AS changed")
    .get("g".repeat(40), original, replacement)).toEqual({ original: 0, changed: 1 });
  assertLiteralTamperingRefused({ name: "automatic_pointer_moves", original, replacement,
    audit: assertAutomaticPointerMoveSchema, error: "AUTOMATIC_POINTER_MOVE_CORRUPT" });
});

test.each([
  { name: "queue_attachment_identity_insert_guard", audit: assertQueueAttachmentSchema,
    error: "QUEUE_ATTACHMENT_IDENTITY_CORRUPT" },
  { name: "session_send_owner_insert_guard", audit: assertSessionSendOwnerSchema,
    error: "SESSION_SEND_OWNER_CORRUPT" },
  { name: "attachment_empty_anchor_guard", audit: assertCurrentAttachmentCustodySchema,
    error: "ATTACHMENT_CUSTODY_CORRUPT" },
])("leaf auditor preserves IF NOT EXISTS within a JSON path: $name", (input) => {
  const row = database.query("SELECT sql FROM sqlite_master WHERE name=?").get(input.name) as { sql: string };
  const original = /'\$\.[^']*'/u.exec(row.sql)?.[0];
  if (original === undefined) throw new Error("Expected a real immutable JSON-path guard.");
  const replacement = original.replace("'$", "'IF NOT EXISTS$");
  expect(() => database.query(`SELECT json_extract('{}',${original})`).get()).not.toThrow();
  expect(() => database.query(`SELECT json_extract('{}',${replacement})`).get()).toThrow();
  assertLiteralTamperingRefused({ ...input, original, replacement });
});

test("queue column audit ignores a decoy definition inside an unrelated quoted identifier", () => {
  const expectedColumn = "enqueue_identity_format TEXT CHECK(enqueue_identity_format IS NULL OR enqueue_identity_format='atomic_attachments_v1')";
  const row = database.query("SELECT sql FROM sqlite_master WHERE name='queue_entries'").get() as { sql: string };
  const weakened = row.sql.replace(expectedColumn, "enqueue_identity_format TEXT CHECK(1)");
  expect(weakened).not.toBe(row.sql);
  const closing = weakened.lastIndexOf(") STRICT");
  if (closing < 0) throw new Error("Expected the authentic STRICT table suffix.");
  const replacement = `${weakened.slice(0, closing)}, "${expectedColumn}" TEXT${weakened.slice(closing)}`;
  assertLiteralTamperingRefused({ name: "queue_entries", original: row.sql, replacement,
    audit: assertQueueAttachmentSchema, error: "QUEUE_ATTACHMENT_IDENTITY_CORRUPT" });
});
