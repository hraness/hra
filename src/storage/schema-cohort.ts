import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";

const objectSchema = z.object({
  type: z.enum(["table", "index", "trigger"]),
  name: z.string(),
  tbl_name: z.string(),
  sql: z.string(),
}).strict();
export type SchemaCohortObject = z.infer<typeof objectSchema>;

type SqlToken = Readonly<{
  kind: "word" | "space" | "punctuation" | "quoted" | "comment";
  value: string;
}>;
const sqlWhitespace = /[\t\n\f\r ]/u;
const sqlWord = /[A-Za-z0-9_$\u0080-\uFFFF]/u;

/** Normalize SQLite layout, never bytes within a value, identifier or comment. */
export const normalizeSchemaSql = (sql: string): string => {
  if (sql.includes("\0")) throw new Error("STATE_SCHEMA_COHORT_SQL_INVALID");
  const tokens: SqlToken[] = [];
  let cursor = 0;
  while (cursor < sql.length) {
    const start = cursor;
    const character = sql.charAt(cursor);
    if (character === "'" || character === '"' || character === "`" || character === "[") {
      const closing = character === "[" ? "]" : character;
      let closed = false;
      cursor++;
      while (cursor < sql.length) {
        if (sql.charAt(cursor++) !== closing) continue;
        if (closing !== "]" && sql.charAt(cursor) === closing) {
          cursor++;
          continue;
        }
        closed = true;
        break;
      }
      if (!closed) throw new Error("STATE_SCHEMA_COHORT_SQL_INVALID");
      tokens.push({ kind: "quoted", value: sql.slice(start, cursor) });
    } else if (sql.startsWith("--", cursor)) {
      const end = sql.indexOf("\n", cursor + 2);
      cursor = end === -1 ? sql.length : end + 1;
      tokens.push({ kind: "comment", value: sql.slice(start, cursor) });
    } else if (sql.startsWith("/*", cursor)) {
      const end = sql.indexOf("*/", cursor + 2);
      if (end === -1) throw new Error("STATE_SCHEMA_COHORT_SQL_INVALID");
      cursor = end + 2;
      tokens.push({ kind: "comment", value: sql.slice(start, cursor) });
    } else if (sqlWhitespace.test(character)) {
      while (cursor < sql.length && sqlWhitespace.test(sql.charAt(cursor))) cursor++;
      tokens.push({ kind: "space", value: " " });
    } else if (sqlWord.test(character)) {
      while (cursor < sql.length && sqlWord.test(sql.charAt(cursor))) cursor++;
      tokens.push({ kind: "word", value: sql.slice(start, cursor) });
    } else {
      cursor++;
      tokens.push({ kind: "punctuation", value: character });
    }
  }

  // SQLite omits this optional clause from sqlite_master. Recognize only
  // CREATE's clause, not a matching phrase in an expression or identifier.
  const significant = tokens.map((token, index) => ({ token, index }))
    .filter(({ token }) => token.kind !== "space" && token.kind !== "comment");
  const wordAt = (index: number): string | undefined => {
    const token = significant[index]?.token;
    return token?.kind === "word" ? token.value.toUpperCase() : undefined;
  };
  const omitted = new Set<number>();
  let head = 1;
  if (wordAt(head) === "TEMP" || wordAt(head) === "TEMPORARY") head++;
  if (wordAt(head) === "UNIQUE") head++;
  if (wordAt(0) === "CREATE" && ["TABLE", "INDEX", "TRIGGER", "VIEW"].includes(wordAt(head) ?? "")
    && wordAt(head + 1) === "IF" && wordAt(head + 2) === "NOT" && wordAt(head + 3) === "EXISTS") {
    for (const item of significant.slice(head + 1, head + 4)) omitted.add(item.index);
  }
  const last = significant.at(-1);
  if (last?.token.kind === "punctuation" && last.token.value === ";") omitted.add(last.index);
  let result = "";
  let pendingSpace = false;
  for (const [index, token] of tokens.entries()) {
    if (omitted.has(index)) continue;
    if (token.kind === "space") {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && result.length > 0) result += " ";
    result += token.value;
    pendingSpace = false;
  }
  return result;
};

/** Parse only trusted, frozen DDL constants, never database-supplied SQL. */
export const schemaCohortObjects = (...sources: readonly string[]): readonly SchemaCohortObject[] => {
  const objects = new Map<string, SchemaCohortObject>();
  for (const source of sources) {
    for (const statement of source.split(/(?=^(?:CREATE|DROP) )/mu)) {
      const head = /^CREATE (?:UNIQUE )?(TABLE|INDEX|TRIGGER) (?:IF NOT EXISTS )?([a-z0-9_]+)/u.exec(statement);
      if (head === null) continue;
      const kind = head[1]?.toLowerCase();
      const name = head[2];
      if (name === undefined || (kind !== "table" && kind !== "index" && kind !== "trigger")) {
        throw new Error("STATE_SCHEMA_COHORT_DEFINITION_INVALID");
      }
      const table = kind === "table" ? name : /\bON ([a-z0-9_]+)/u.exec(statement)?.[1];
      if (table === undefined) throw new Error(`STATE_SCHEMA_COHORT_DEFINITION_INVALID:${name}`);
      const end = kind === "table" ? statement.indexOf(") STRICT;") + 9
        : kind === "index" ? statement.indexOf(";") + 1
        : statement.lastIndexOf("END;") + 4;
      if (end < 1) throw new Error(`STATE_SCHEMA_COHORT_DEFINITION_INVALID:${name}`);
      objects.set(name, { type: kind, name, tbl_name: table, sql: statement.slice(0, end).trim() });
    }
  }
  return [...objects.values()].sort((a, b) => a.name.localeCompare(b.name));
};

export const schemaCohortDigest = (objects: readonly SchemaCohortObject[]): string =>
  createHash("sha256").update(objects.map((object) => [
    object.type, object.name, object.tbl_name, normalizeSchemaSql(object.sql),
  ].join("\u0000")).join("\n")).digest("hex");

export const assertSchemaCohortObjects = (
  database: Database,
  objects: readonly SchemaCohortObject[],
  cohort: string,
): void => {
  for (const expected of objects) {
    const observed = objectSchema.safeParse(database.query(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name=?",
    ).get(expected.name));
    if (!observed.success || observed.data.type !== expected.type
      || observed.data.tbl_name !== expected.tbl_name
      || normalizeSchemaSql(observed.data.sql) !== normalizeSchemaSql(expected.sql)) {
      throw new Error(`STATE_SCHEMA_COHORT_INVALID:${cohort}:${expected.name}`);
    }
  }
};

export const assertSchemaCohortMigrationTail = (
  database: Database,
  finalVersion: 40 | 48 | 49,
): void => {
  const rows = z.object({
    version: z.number().int(), applied_at: z.number().int().nonnegative().safe(),
  }).strict().array().parse(database.query(
    "SELECT version,applied_at FROM migrations WHERE version>=35 ORDER BY version",
  ).all());
  if (rows.length !== finalVersion - 34
    || rows.some((row, index) => row.version !== index + 35)) {
    throw new Error("STATE_SCHEMA_COHORT_LEDGER_INVALID");
  }
};

/** Caller owns one IMMEDIATE transaction and has audited the entire private cohort. */
export const relocatePrivateTaskMigrationTail = (database: Database, adoptedAt: number): void => {
  assertSchemaCohortMigrationTail(database, 48);
  for (let from = 48; from >= 40; from--) {
    const moved = database.query("UPDATE migrations SET version=? WHERE version=?").run(from + 1, from);
    if (moved.changes !== 1) throw new Error("STATE_SCHEMA_COHORT_RELOCATION_CONFLICT");
  }
  database.query("INSERT INTO migrations(version,applied_at) VALUES(40,?)").run(
    z.number().int().nonnegative().safe().parse(adoptedAt),
  );
  assertSchemaCohortMigrationTail(database, 49);
};
