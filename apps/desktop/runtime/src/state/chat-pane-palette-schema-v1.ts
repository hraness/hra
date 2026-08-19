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

/**
 * Renderer-safe, restart-stable state for verified reasoning summaries and
 * provider-native collaboration. Raw provider identities never enter these
 * columns. Pre-migration reasoning bytes remain stored but are not copied into
 * the proof-authorized fields, so they cannot become terminally visible.
 */
export const CHAT_COMPACT_SEMANTIC_SCHEMA_V1_SQL = `
  ${CHAT_PANE_PALETTE_SCHEMA_V1_SQL}

  ALTER TABLE chat_panes
    ADD COLUMN provider_subagents_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE chat_panes
    ADD COLUMN provider_subagent_overflow_count INTEGER NOT NULL DEFAULT 0
      CHECK (provider_subagent_overflow_count BETWEEN 0 AND 120);
  ALTER TABLE chat_panes
    ADD COLUMN reasoning_verified_tail TEXT NOT NULL DEFAULT '';
  ALTER TABLE chat_panes
    ADD COLUMN reasoning_verified_total_utf8_bytes INTEGER NOT NULL DEFAULT 0
      CHECK (reasoning_verified_total_utf8_bytes >= 0);
  ALTER TABLE chat_panes
    ADD COLUMN reasoning_active_item_id TEXT;
  ALTER TABLE chat_panes
    ADD COLUMN reasoning_proof_tainted INTEGER NOT NULL DEFAULT 0
      CHECK (reasoning_proof_tainted IN (0, 1));

  CREATE TABLE chat_reasoning_item_receipts (
    pane_id TEXT NOT NULL REFERENCES chat_panes(pane_id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    receipt_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('verified', 'tainted')),
    completion_digest TEXT,
    completion_generation INTEGER NOT NULL CHECK (completion_generation >= 1),
    completion_stream_position INTEGER NOT NULL CHECK (completion_stream_position >= 0),
    completion_fact_index INTEGER NOT NULL CHECK (completion_fact_index >= 0),
    overflowed INTEGER NOT NULL CHECK (overflowed IN (0, 1)),
    repaired_suffix INTEGER NOT NULL CHECK (repaired_suffix IN (0, 1)),
    taint_reason TEXT,
    summary_tail TEXT,
    summary_total_utf8_bytes INTEGER,
    summary_truncated_prefix INTEGER CHECK (
      summary_truncated_prefix IS NULL OR summary_truncated_prefix IN (0, 1)
    ),
    created_at TEXT NOT NULL,
    PRIMARY KEY (pane_id, turn_id, item_id),
    UNIQUE (receipt_id),
    CHECK (
      (state = 'verified'
        AND completion_digest IS NOT NULL
        AND taint_reason IS NULL
        AND summary_tail IS NOT NULL
        AND summary_total_utf8_bytes IS NOT NULL
        AND summary_total_utf8_bytes >= 0
        AND summary_truncated_prefix IS NOT NULL)
      OR
      (state = 'tainted'
        AND completion_digest IS NULL
        AND repaired_suffix = 0
        AND taint_reason IS NOT NULL
        AND summary_tail IS NULL
        AND summary_total_utf8_bytes IS NULL
        AND summary_truncated_prefix IS NULL)
    )
  ) STRICT;

  CREATE TRIGGER chat_reasoning_item_receipt_immutable
  BEFORE UPDATE ON chat_reasoning_item_receipts
  BEGIN
    SELECT RAISE(ABORT, 'reasoning completion receipts are immutable');
  END;
`;
