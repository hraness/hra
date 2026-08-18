import { z } from "@hra-internal/schema";

export const MAX_CHAT_PANE_PALETTE_INDEX = Number.MAX_SAFE_INTEGER - 1;

export const chatPanePaletteIndexSchema = z.number().int().nonnegative().max(
  MAX_CHAT_PANE_PALETTE_INDEX,
);
export type ChatPanePaletteIndex = z.infer<typeof chatPanePaletteIndexSchema>;

/**
 * Durable decorative identity for chat panes. Backfill order is independent of
 * the mutable display order. The singleton is advanced by the insert trigger
 * in the same SQLite statement that publishes a new pane, so deletion and
 * reordering can never recycle a palette index.
 */
export const CHAT_PANE_PALETTE_SCHEMA_V1_SQL = `
  ALTER TABLE chat_panes
    ADD COLUMN palette_index INTEGER CHECK (
      palette_index BETWEEN 0 AND ${MAX_CHAT_PANE_PALETTE_INDEX}
    );

  WITH deterministic_palette AS (
    SELECT pane_id, ROW_NUMBER() OVER (
      ORDER BY created_at, pane_id
    ) - 1 AS palette_index
    FROM chat_panes
  )
  UPDATE chat_panes
  SET palette_index = (
    SELECT deterministic_palette.palette_index
    FROM deterministic_palette
    WHERE deterministic_palette.pane_id = chat_panes.pane_id
  );

  CREATE UNIQUE INDEX chat_panes_palette_index_idx
    ON chat_panes(palette_index);

  CREATE TABLE chat_pane_palette_sequence (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    next_palette_index INTEGER NOT NULL CHECK (
      next_palette_index BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
    )
  ) STRICT;

  INSERT INTO chat_pane_palette_sequence(singleton, next_palette_index)
  SELECT 1, COALESCE(MAX(palette_index) + 1, 0)
  FROM chat_panes;

  CREATE TRIGGER chat_pane_palette_insert_guard
  BEFORE INSERT ON chat_panes
  WHEN NEW.palette_index IS NULL
    OR NEW.palette_index != (
      SELECT next_palette_index
      FROM chat_pane_palette_sequence
      WHERE singleton = 1
    )
    OR (
      SELECT next_palette_index
      FROM chat_pane_palette_sequence
      WHERE singleton = 1
    ) > ${MAX_CHAT_PANE_PALETTE_INDEX}
  BEGIN
    SELECT RAISE(ABORT, 'chat pane palette allocation is invalid');
  END;

  CREATE TRIGGER chat_pane_palette_advance
  AFTER INSERT ON chat_panes
  BEGIN
    UPDATE chat_pane_palette_sequence
    SET next_palette_index = next_palette_index + 1
    WHERE singleton = 1;
  END;

  CREATE TRIGGER chat_pane_palette_immutable
  BEFORE UPDATE OF palette_index ON chat_panes
  WHEN NEW.palette_index IS NOT OLD.palette_index
  BEGIN
    SELECT RAISE(ABORT, 'chat pane palette identity is immutable');
  END;

  CREATE TRIGGER chat_pane_palette_sequence_update_guard
  BEFORE UPDATE ON chat_pane_palette_sequence
  WHEN NEW.singleton != OLD.singleton
    OR NEW.next_palette_index != OLD.next_palette_index + 1
    OR NOT EXISTS (
      SELECT 1 FROM chat_panes
      WHERE palette_index = OLD.next_palette_index
    )
  BEGIN
    SELECT RAISE(ABORT, 'chat pane palette sequence is append-only');
  END;

  CREATE TRIGGER chat_pane_palette_sequence_delete_guard
  BEFORE DELETE ON chat_pane_palette_sequence
  BEGIN
    SELECT RAISE(ABORT, 'chat pane palette sequence is durable');
  END;
`;

/** Use directly inside the pane INSERT so the allocation and row are atomic. */
export const CHAT_PANE_NEXT_PALETTE_INDEX_SQL = `(
  SELECT next_palette_index
  FROM chat_pane_palette_sequence
  WHERE singleton = 1
)`;
