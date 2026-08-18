/**
 * Explicit user resolution for an app-owned message whose provider delivery
 * outcome cannot be proven. The original ledger row remains immutable in its
 * ambiguous state; this append-only receipt only releases queue containment.
 */
export const CHAT_MESSAGE_AMBIGUOUS_RESOLUTION_SCHEMA_V1_SQL = `
  CREATE TABLE chat_message_ambiguous_resolutions (
    message_id TEXT PRIMARY KEY,
    pane_id TEXT NOT NULL,
    claimed_turn_id TEXT NOT NULL,
    resolution TEXT NOT NULL CHECK (resolution = 'discarded'),
    resolved_at TEXT NOT NULL,
    FOREIGN KEY (message_id, pane_id)
      REFERENCES chat_message_ledger(message_id, pane_id) ON DELETE CASCADE,
    UNIQUE (pane_id, message_id, claimed_turn_id)
  ) STRICT;

  CREATE INDEX chat_message_ambiguous_resolutions_pane_idx
    ON chat_message_ambiguous_resolutions(pane_id, message_id);

  CREATE TRIGGER chat_message_ambiguous_resolution_insert_guard
  BEFORE INSERT ON chat_message_ambiguous_resolutions
  WHEN NOT EXISTS (
    SELECT 1 FROM chat_message_ledger AS message
    JOIN chat_panes AS pane ON pane.pane_id = message.pane_id
    WHERE message.message_id = NEW.message_id
      AND message.pane_id = NEW.pane_id
      AND message.claimed_turn_id = NEW.claimed_turn_id
      AND message.state = 'ambiguous'
      AND pane.archived_at IS NULL
      AND pane.active_turn_id = message.claimed_turn_id
      AND pane.turn_status IN ('completed', 'failed')
  )
  BEGIN
    SELECT RAISE(ABORT, 'only an ambiguous message can be explicitly resolved');
  END;

  CREATE TRIGGER chat_message_ambiguous_resolution_update_guard
  BEFORE UPDATE ON chat_message_ambiguous_resolutions
  BEGIN
    SELECT RAISE(ABORT, 'ambiguous message resolution evidence is immutable');
  END;

`;
