import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CHAT_PANE_NEXT_PALETTE_INDEX_SQL,
  CHAT_PANE_PALETTE_SCHEMA_V1_SQL,
} from "../src/state/chat-pane-palette-schema-v1";

interface PaneRow {
  readonly display_order: number;
  readonly palette_index: number;
  readonly pane_id: string;
}

function createLegacySchema(database: Database): void {
  database.exec(`
    CREATE TABLE chat_panes (
      pane_id TEXT PRIMARY KEY,
      display_order INTEGER NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
  `);
}

function insertPane(
  database: Database,
  paneId: string,
  displayOrder: number,
  createdAt: string,
): void {
  database.query(`
    INSERT INTO chat_panes(
      pane_id, display_order, created_at, palette_index
    ) VALUES (?1, ?2, ?3, ${CHAT_PANE_NEXT_PALETTE_INDEX_SQL})
  `).run(paneId, displayOrder, createdAt);
}

function rows(database: Database): readonly PaneRow[] {
  return database.query(`
    SELECT pane_id, display_order, palette_index
    FROM chat_panes
    ORDER BY palette_index
  `).all() as unknown as readonly PaneRow[];
}

describe("chat pane palette schema v1", () => {
  test("backfills by creation identity rather than mutable display order", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      createLegacySchema(database);
      database.query(`
        INSERT INTO chat_panes(pane_id, display_order, created_at)
        VALUES (?1, ?2, ?3)
      `).run("pane_z", 0, "2030-01-01T00:00:01.000Z");
      database.query(`
        INSERT INTO chat_panes(pane_id, display_order, created_at)
        VALUES (?1, ?2, ?3)
      `).run("pane_b", 2, "2030-01-01T00:00:00.000Z");
      database.query(`
        INSERT INTO chat_panes(pane_id, display_order, created_at)
        VALUES (?1, ?2, ?3)
      `).run("pane_a", 1, "2030-01-01T00:00:00.000Z");
      database.exec(CHAT_PANE_PALETTE_SCHEMA_V1_SQL);
      expect(rows(database)).toEqual([
        { pane_id: "pane_a", display_order: 1, palette_index: 0 },
        { pane_id: "pane_b", display_order: 2, palette_index: 1 },
        { pane_id: "pane_z", display_order: 0, palette_index: 2 },
      ]);

      database.query("UPDATE chat_panes SET display_order = 9 - display_order").run();
      expect(rows(database).map(({ pane_id, palette_index }) => ({ pane_id, palette_index })))
        .toEqual([
          { pane_id: "pane_a", palette_index: 0 },
          { pane_id: "pane_b", palette_index: 1 },
          { pane_id: "pane_z", palette_index: 2 },
        ]);
    } finally {
      database.close();
    }
  });

  test("allocates in the pane insert and never reuses a deleted index", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      createLegacySchema(database);
      database.exec(CHAT_PANE_PALETTE_SCHEMA_V1_SQL);
      insertPane(database, "pane_first", 0, "2030-01-01T00:00:00.000Z");
      insertPane(database, "pane_second", 1, "2030-01-01T00:00:01.000Z");
      database.query("DELETE FROM chat_panes WHERE pane_id = 'pane_first'").run();
      insertPane(database, "pane_third", 2, "2030-01-01T00:00:02.000Z");
      expect(rows(database).map(({ pane_id, palette_index }) => ({ pane_id, palette_index })))
        .toEqual([
          { pane_id: "pane_second", palette_index: 1 },
          { pane_id: "pane_third", palette_index: 2 },
        ]);
      expect(database.query(`
        SELECT next_palette_index FROM chat_pane_palette_sequence
      `).get()).toEqual({ next_palette_index: 3 });
    } finally {
      database.close();
    }
  });

  test("rejects omitted, forged, mutated, and externally advanced identity", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      createLegacySchema(database);
      database.exec(CHAT_PANE_PALETTE_SCHEMA_V1_SQL);
      expect(() => database.query(`
        INSERT INTO chat_panes(pane_id, display_order, created_at)
        VALUES ('pane_missing', 0, '2030-01-01T00:00:00.000Z')
      `).run()).toThrow();
      expect(() => database.query(`
        INSERT INTO chat_panes(pane_id, display_order, created_at, palette_index)
        VALUES ('pane_forged', 0, '2030-01-01T00:00:00.000Z', 9)
      `).run()).toThrow();
      insertPane(database, "pane_exact", 0, "2030-01-01T00:00:00.000Z");
      expect(() => database.query(`
        UPDATE chat_panes SET palette_index = 7 WHERE pane_id = 'pane_exact'
      `).run()).toThrow();
      expect(() => database.query(`
        UPDATE chat_pane_palette_sequence SET next_palette_index = 7
      `).run()).toThrow();
      expect(() => database.query("DELETE FROM chat_pane_palette_sequence").run())
        .toThrow();
    } finally {
      database.close();
    }
  });

  test("persists the monotonic sequence across restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "hra-pane-palette-"));
    const path = join(directory, "control-plane.sqlite3");
    try {
      let database = new Database(path, { strict: true });
      createLegacySchema(database);
      database.exec(CHAT_PANE_PALETTE_SCHEMA_V1_SQL);
      insertPane(database, "pane_before_restart", 0, "2030-01-01T00:00:00.000Z");
      database.close();

      database = new Database(path, { strict: true });
      insertPane(database, "pane_after_restart", 1, "2030-01-01T00:00:01.000Z");
      expect(rows(database).map(({ palette_index }) => palette_index)).toEqual([0, 1]);
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
