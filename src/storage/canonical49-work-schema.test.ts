import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import {
  CANONICAL_40_WORK_AUTHORITY_TRIGGER_DEFINITIONS,
  CANONICAL_49_WORK_PRESET_GUARD_DEFINITIONS,
  CANONICAL_WORK_NON_AUTHORITY_TRIGGER_DEFINITIONS,
} from "./canonical49-work-schema";
import { normalizeSchemaSql } from "./schema-cohort";

const canonical49Authority = new Map<string, string>(CANONICAL_40_WORK_AUTHORITY_TRIGGER_DEFINITIONS);
for (const [name, sql] of CANONICAL_49_WORK_PRESET_GUARD_DEFINITIONS) {
  canonical49Authority.set(name, sql);
}
const digest = (entries: readonly (readonly [string, string])[]): string => createHash("sha256")
  .update(JSON.stringify(entries.map(([name, sql]) => [name, normalizeSchemaSql(sql)])))
  .digest("hex");

describe("frozen canonical Work trigger definitions", () => {
  test("pins archived v40 and v42-v49 definitions independently of current runtime SQL", () => {
    expect(CANONICAL_40_WORK_AUTHORITY_TRIGGER_DEFINITIONS).toHaveLength(13);
    expect(CANONICAL_49_WORK_PRESET_GUARD_DEFINITIONS).toHaveLength(2);
    expect(CANONICAL_WORK_NON_AUTHORITY_TRIGGER_DEFINITIONS).toHaveLength(70);
    // Grammar-aware normalization preserves the line-comment newlines that
    // the archived producer's whitespace-only diagnostic digest collapsed.
    expect(digest(CANONICAL_40_WORK_AUTHORITY_TRIGGER_DEFINITIONS))
      .toBe("7fed3c3c00bbe0dcd39bb6622b33be93106d0a8811536a03ba7c90889d38512a");
    expect(digest([...canonical49Authority]))
      .toBe("2322bd18c124ba8ab90b165875f7f3c1ae95b2203464c0fab87815792b076c9a");
    expect(digest(CANONICAL_WORK_NON_AUTHORITY_TRIGGER_DEFINITIONS))
      .toBe("b2973f3c9279e5b6af86c49fbdc59659384451b003c202522e12e7c890eef4b4");
    const archivedNormalize = (sql: string): string => sql.replace(/\bIF NOT EXISTS\b/giu, "")
      .replace(/\s+/gu, " ").trim().replace(/;$/u, "");
    expect(createHash("sha256").update(JSON.stringify(
      CANONICAL_40_WORK_AUTHORITY_TRIGGER_DEFINITIONS.map(([name, sql]) => [name, archivedNormalize(sql)]),
    )).digest("hex"))
      .toBe("91f02f0c7af299245be21bc28b8005392d536de426875eb5f2804d11744d5ca2");
  });

  test("freezes every exported definition tuple and keeps exact variant membership", () => {
    for (const entries of [
      CANONICAL_40_WORK_AUTHORITY_TRIGGER_DEFINITIONS,
      CANONICAL_49_WORK_PRESET_GUARD_DEFINITIONS,
      CANONICAL_WORK_NON_AUTHORITY_TRIGGER_DEFINITIONS,
    ]) {
      expect(Object.isFrozen(entries)).toBe(true);
      for (const entry of entries) expect(Object.isFrozen(entry)).toBe(true);
    }
    expect(CANONICAL_49_WORK_PRESET_GUARD_DEFINITIONS.map(([name]) => name)).toEqual([
      "work_devin_preset_contract_guard", "work_session_devin_contract_guard",
    ]);
    for (const [name, sql] of canonical49Authority) {
      if (name === "work_devin_preset_contract_guard" || name === "work_session_devin_contract_guard") continue;
      const expected = new Map<string, string>(CANONICAL_40_WORK_AUTHORITY_TRIGGER_DEFINITIONS).get(name);
      if (expected === undefined) throw new Error("Missing historical Work authority definition.");
      expect(sql).toBe(expected);
    }
  });

  test("SQLite retains the exact closed trigger bodies in an explicitly empty synthetic DDL unit", () => {
    // This is only a trigger-definition parser oracle. The minimal target
    // tables below are not released Work tables, and this is not a populated
    // historical Work fixture or a StateStore migration/admission proof.
    const database = new Database(":memory:", { strict: true });
    try {
      const entries = [...canonical49Authority, ...CANONICAL_WORK_NON_AUTHORITY_TRIGGER_DEFINITIONS];
      const targets = new Set(entries.map(([, sql]) => {
        const target = /\bON ([a-z_]+)\b/u.exec(sql)?.[1];
        if (target === undefined) throw new Error("Frozen trigger target missing.");
        return target;
      }));
      for (const table of targets) database.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY) STRICT;`);
      for (const [, sql] of entries) database.exec(sql);
      expect(database.query("SELECT name FROM sqlite_master WHERE type='trigger'").all()).toHaveLength(83);
      for (const [name, sql] of entries) {
        const row = database.query("SELECT type,sql FROM sqlite_master WHERE name=?").get(name) as {
          type: string;
          sql: string;
        };
        expect(row.type).toBe("trigger");
        expect(normalizeSchemaSql(row.sql)).toBe(normalizeSchemaSql(sql));
      }
      for (const table of targets) expect(database.query(`SELECT * FROM ${table}`).all()).toEqual([]);
    } finally {
      database.close(false);
    }
  });
});
