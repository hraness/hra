import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fc from "fast-check";

import { assertSchemaCohortObjects, normalizeSchemaSql, schemaCohortDigest, schemaCohortObjects } from "./schema-cohort";
import { WORK_SCHEMA_SQL } from "./work-store";

const table = (sql: string) => ({ type: "table" as const, name: "literal_probe", tbl_name: "literal_probe", sql });
const assertChangedTableRefused = (expected: string, observed: string): void => {
  const database = new Database(":memory:", { strict: true });
  try {
    database.exec(observed);
    expect(() => assertSchemaCohortObjects(database, [table(expected)], "literal-probe"))
      .toThrow("STATE_SCHEMA_COHORT_INVALID");
  } finally { database.close(); }
};

test("exact cohort comparison refuses IF NOT EXISTS injected inside a real Work digest GLOB", () => {
  const expected = schemaCohortObjects(WORK_SCHEMA_SQL).find((object) =>
    object.type === "table" && object.sql.includes("NOT GLOB '*[^0-9a-f]*'"));
  if (expected === undefined) throw new Error("Expected the frozen Work digest constraint.");
  const original = "*[^0-9a-f]*";
  const changed = "*[IF NOT EXISTS^0-9a-f]*";
  const database = new Database(":memory:", { strict: true });
  try {
    database.exec(expected.sql.replaceAll(original, changed));
    expect(database.query("SELECT ?1 NOT GLOB ?2 AS valid, ?1 NOT GLOB ?3 AS weakened")
      .get("g".repeat(64), original, changed)).toEqual({ valid: 0, weakened: 1 });
    expect(() => assertSchemaCohortObjects(database, [expected], "literal-probe"))
      .toThrow("STATE_SCHEMA_COHORT_INVALID");
  } finally { database.close(); }
});

test("exact cohort comparison preserves the Claude procStart control-class literal", () => {
  const original = "*[^ -~]*";
  const changed = "*[^ \t-~]*";
  const database = new Database(":memory:", { strict: true });
  try {
    expect(database.query("SELECT ?1 GLOB ?2 AS rejected, ?1 GLOB ?3 AS weakened")
      .get("\t", original, changed)).toEqual({ rejected: 1, weakened: 0 });
  } finally { database.close(); }
  assertChangedTableRefused(
    `CREATE TABLE literal_probe (value TEXT CHECK(value NOT GLOB '${original}')) STRICT;`,
    `CREATE TABLE literal_probe (value TEXT CHECK(value NOT GLOB '${changed}')) STRICT;`,
  );
});

test.each(["'", '"', "`", "["])("exact cohort comparison preserves whitespace inside %s quoted spans", (quote) => {
  const end = quote === "[" ? "]" : quote;
  const expected = quote === "'"
    ? "CREATE TABLE literal_probe (value TEXT CHECK(value != 'two  words')) STRICT;"
    : `CREATE TABLE literal_probe (${quote}two  words${end} TEXT) STRICT;`;
  assertChangedTableRefused(expected, expected.replace("two  words", "two words"));
});

test("exact cohort comparison preserves the newline that ends a SQL comment", () => {
  assertChangedTableRefused(
    "CREATE TABLE literal_probe (value INTEGER CHECK(value>0 -- lower bound\n AND value<10\n)) STRICT;",
    "CREATE TABLE literal_probe (value INTEGER CHECK(value>0 -- lower bound AND value<10\n)) STRICT;",
  );
});

test("exact cohort comparison permits exterior formatting and the optional CREATE clause", () => {
  const expected = "CREATE TABLE IF NOT EXISTS literal_probe (value TEXT CHECK(value != 'IF NOT EXISTS  isn''t whitespace')) STRICT;";
  const observed = "CREATE  TABLE literal_probe\n(value TEXT CHECK(value != 'IF NOT EXISTS  isn''t whitespace'))\tSTRICT";
  const database = new Database(":memory:", { strict: true });
  try {
    database.exec(observed);
    // Keep punctuation spacing identical: whitespace normalization must not
    // remove significant literal bytes or invent general SQL equivalence.
    expect(() => assertSchemaCohortObjects(database, [table(expected)], "literal-probe"))
      .not.toThrow();
  } finally { database.close(); }
});

test.each(["'unfinished", '"unfinished', "`unfinished", "[unfinished", "/* unfinished"])(
  "schema normalization fails closed on an unterminated %s span", (span) => {
    expect(() => schemaCohortDigest([table(`CREATE TABLE literal_probe (value TEXT ${span}`)]))
      .toThrow("STATE_SCHEMA_COHORT_SQL_INVALID");
  },
);

test.each(["literal", "block_comment", "line_comment"] as const)(
  "schema normalization refuses NUL inside a protected span: %s", (kind) => {
    const span = { literal: "'nul\0literal'", block_comment: "/* nul\0comment */", line_comment: "-- nul\0comment\n" }[kind];
    expect(() => normalizeSchemaSql(`CREATE TABLE literal_probe (value TEXT ${span});`))
      .toThrow("STATE_SCHEMA_COHORT_SQL_INVALID");
  },
);

const quotedText = fc.array(fc.constantFrom("a", " ", "\t", "\n", "'", "--", "/*", "*/", "IF NOT EXISTS"), { maxLength: 12 })
  .map((parts) => `isn't ${parts.join("")}`);
const quoteSql = (value: string): string => `'${value.replaceAll("'", "''")}'`;

test("SQL normalization preserves distinct bounded quoted values", () => {
  fc.assert(fc.property(quotedText, (value) => {
    const literal = quoteSql(value);
    const changed = quoteSql(value + " ");
    const statement = (input: string) => `CREATE TABLE literal_probe (value TEXT CHECK(value != ${input})) STRICT;`;
    const normalized = normalizeSchemaSql(statement(literal));
    expect(normalized).toContain(literal);
    expect(normalized).not.toBe(normalizeSchemaSql(statement(changed)));
  }), { seed: 49_001, numRuns: 64 });
});

test("SQL normalization consistently accepts safe exterior CREATE layout", () => {
  const whitespace = fc.constantFrom(" ", "\t", "\n", "\r\n", "\f", "  ");
  fc.assert(fc.property(whitespace, whitespace, whitespace, fc.boolean(), (first, second, third, optional) => {
    const statement = `CREATE${first}TABLE${second}${optional ? `IF${first}NOT${third}EXISTS${second}` : ""}literal_probe${third}(value TEXT)${first}STRICT;`;
    expect(normalizeSchemaSql(statement)).toBe("CREATE TABLE literal_probe (value TEXT) STRICT");
  }), { seed: 49_002, numRuns: 64 });
});

test("SQL normalization is idempotent without losing comment termination", () => {
  const comment = fc.array(fc.constantFrom("a", " ", "\t", "IF NOT EXISTS"), { maxLength: 12 })
    .map((parts) => parts.join(""));
  fc.assert(fc.property(quotedText, comment, (value, text) => {
    const statement = `CREATE TABLE IF NOT EXISTS literal_probe (value TEXT -- ${text}\n CHECK(value != ${quoteSql(value)})) STRICT;`;
    const normalized = normalizeSchemaSql(statement);
    expect(normalized).toContain(`-- ${text}\n`);
    expect(normalized).toContain(quoteSql(value));
    expect(normalizeSchemaSql(normalized)).toBe(normalized);
  }), { seed: 49_003, numRuns: 64 });
});
