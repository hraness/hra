/**
 * Durable app-owned chat message ledger.
 *
 * Message payloads stay private to the local control plane. Renderer-facing
 * code receives only the bounded projection defined by HRA's runtime contract;
 * provider identities and attachment paths never enter this schema.
 */
export const CHAT_MESSAGE_LEDGER_SCHEMA_V1_SQL = `
  ALTER TABLE chat_panes
    ADD COLUMN message_queue_revision INTEGER NOT NULL DEFAULT 1
      CHECK (message_queue_revision > 0);
  ALTER TABLE chat_panes
    ADD COLUMN next_message_ordinal INTEGER NOT NULL DEFAULT 1
      CHECK (next_message_ordinal > 0);
  ALTER TABLE chat_panes
    ADD COLUMN message_queue_pause_reason TEXT CHECK (
      message_queue_pause_reason IS NULL
      OR message_queue_pause_reason IN (
        'stop', 'runtime_restart', 'attention', 'ambiguous_effect'
      )
    );

  CREATE TABLE chat_message_ledger (
    message_id TEXT PRIMARY KEY CHECK (
      length(message_id) BETWEEN 15 AND 96
      AND message_id GLOB 'chatmsg_[A-Za-z0-9_-]*'
      AND substr(message_id, 9) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    pane_id TEXT NOT NULL
      REFERENCES chat_panes(pane_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal > 0),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    message_text TEXT NOT NULL CHECK (
      instr(message_text, char(0)) = 0
      AND length(CAST(message_text AS BLOB)) <= 131072
    ),
    message_utf8_bytes INTEGER NOT NULL CHECK (
      message_utf8_bytes BETWEEN 0 AND 131072
      AND message_utf8_bytes = length(CAST(message_text AS BLOB))
    ),
    state TEXT NOT NULL CHECK (state IN (
      'queued',
      'start_claimed',
      'start_effect_started',
      'start_acknowledged',
      'steer_prepared',
      'steer_effect_started',
      'steer_acknowledged',
      'completed',
      'cancelled',
      'ambiguous'
    )),
    claimed_turn_id TEXT CHECK (
      claimed_turn_id IS NULL OR (
        length(claimed_turn_id) BETWEEN 16 AND 96
        AND claimed_turn_id GLOB 'chatturn_[A-Za-z0-9_-]*'
        AND substr(claimed_turn_id, 10) NOT GLOB '*[^A-Za-z0-9_-]*'
      )
    ),
    effect_started_at TEXT,
    acknowledged_at TEXT,
    terminal_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (pane_id, ordinal),
    UNIQUE (message_id, pane_id),
    CHECK (
      (state = 'queued' AND claimed_turn_id IS NULL
        AND effect_started_at IS NULL AND acknowledged_at IS NULL AND terminal_at IS NULL)
      OR (state IN ('start_claimed', 'steer_prepared') AND claimed_turn_id IS NOT NULL
        AND effect_started_at IS NULL AND acknowledged_at IS NULL AND terminal_at IS NULL)
      OR (state IN ('start_effect_started', 'steer_effect_started')
        AND claimed_turn_id IS NOT NULL AND effect_started_at IS NOT NULL
        AND acknowledged_at IS NULL AND terminal_at IS NULL)
      OR (state IN ('start_acknowledged', 'steer_acknowledged')
        AND claimed_turn_id IS NOT NULL AND effect_started_at IS NOT NULL
        AND acknowledged_at IS NOT NULL AND terminal_at IS NULL)
      OR (state = 'completed' AND claimed_turn_id IS NOT NULL
        AND effect_started_at IS NOT NULL AND acknowledged_at IS NOT NULL
        AND terminal_at IS NOT NULL)
      OR (state = 'cancelled' AND effect_started_at IS NULL
        AND acknowledged_at IS NULL AND terminal_at IS NOT NULL)
      OR (state = 'ambiguous' AND claimed_turn_id IS NOT NULL
        AND effect_started_at IS NOT NULL AND acknowledged_at IS NULL
        AND terminal_at IS NOT NULL)
    )
  ) STRICT;

  CREATE TABLE chat_attachments (
    attachment_id TEXT PRIMARY KEY CHECK (
      length(attachment_id) BETWEEN 18 AND 96
      AND attachment_id GLOB 'attachment_[A-Za-z0-9_-]*'
      AND substr(attachment_id, 12) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    upload_id TEXT NOT NULL UNIQUE CHECK (
      length(upload_id) BETWEEN 15 AND 96
      AND upload_id GLOB 'upload_[A-Za-z0-9_-]*'
      AND substr(upload_id, 8) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    pane_id TEXT NOT NULL
      REFERENCES chat_panes(pane_id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL CHECK (revision > 0),
    state TEXT NOT NULL CHECK (state IN (
      'creating', 'receiving', 'normalizing', 'publishing',
      'ready', 'corrupt', 'deleting'
    )),
    expected_input_bytes INTEGER NOT NULL CHECK (
      expected_input_bytes BETWEEN 1 AND 25165824
    ),
    received_input_bytes INTEGER NOT NULL CHECK (
      received_input_bytes BETWEEN 0 AND expected_input_bytes
    ),
    next_chunk_ordinal INTEGER NOT NULL CHECK (next_chunk_ordinal >= 0),
    prepared_chunk_ordinal INTEGER CHECK (
      prepared_chunk_ordinal IS NULL OR prepared_chunk_ordinal >= 0
    ),
    prepared_offset INTEGER CHECK (
      prepared_offset IS NULL OR prepared_offset >= 0
    ),
    prepared_byte_length INTEGER CHECK (
      prepared_byte_length IS NULL
      OR prepared_byte_length BETWEEN 1 AND 524288
    ),
    prepared_sha256 TEXT CHECK (
      prepared_sha256 IS NULL OR (
        length(prepared_sha256) = 64
        AND prepared_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
    input_sha256 TEXT CHECK (
      input_sha256 IS NULL OR (
        length(input_sha256) = 64
        AND input_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
    source_media_type TEXT CHECK (
      source_media_type IS NULL OR source_media_type IN (
        'image/png', 'image/jpeg', 'image/heic', 'image/webp'
      )
    ),
    width INTEGER CHECK (width IS NULL OR width BETWEEN 1 AND 8192),
    height INTEGER CHECK (height IS NULL OR height BETWEEN 1 AND 8192),
    pixel_count INTEGER CHECK (
      pixel_count IS NULL OR pixel_count BETWEEN 1 AND 16777216
    ),
    canonical_bytes INTEGER CHECK (
      canonical_bytes IS NULL OR canonical_bytes BETWEEN 1 AND 67108864
    ),
    canonical_sha256 TEXT CHECK (
      canonical_sha256 IS NULL OR (
        length(canonical_sha256) = 64
        AND canonical_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
    preview_bytes INTEGER CHECK (
      preview_bytes IS NULL OR preview_bytes BETWEEN 1 AND 524288
    ),
    preview_sha256 TEXT CHECK (
      preview_sha256 IS NULL OR (
        length(preview_sha256) = 64
        AND preview_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
    ready_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (attachment_id, pane_id),
    CHECK (
      (prepared_chunk_ordinal IS NULL)
        = (prepared_offset IS NULL)
      AND (prepared_offset IS NULL)
        = (prepared_byte_length IS NULL)
      AND (prepared_byte_length IS NULL)
        = (prepared_sha256 IS NULL)
    ),
    CHECK (
      prepared_chunk_ordinal IS NULL OR (
        prepared_chunk_ordinal = next_chunk_ordinal
        AND prepared_offset = received_input_bytes
        AND prepared_offset + prepared_byte_length <= expected_input_bytes
      )
    ),
    CHECK (
      pixel_count IS NULL OR (
        width IS NOT NULL AND height IS NOT NULL
        AND pixel_count = width * height
      )
    ),
    CHECK (
      state != 'ready' OR (
        received_input_bytes = expected_input_bytes
        AND prepared_chunk_ordinal IS NULL
        AND input_sha256 IS NOT NULL
        AND source_media_type IS NOT NULL
        AND width IS NOT NULL
        AND height IS NOT NULL
        AND pixel_count IS NOT NULL
        AND canonical_bytes IS NOT NULL
        AND canonical_sha256 IS NOT NULL
        AND preview_bytes IS NOT NULL
        AND preview_sha256 IS NOT NULL
        AND ready_at IS NOT NULL
      )
    ),
    CHECK (
      state NOT IN ('creating', 'receiving') OR (
        input_sha256 IS NULL
        AND source_media_type IS NULL
        AND width IS NULL
        AND height IS NULL
        AND pixel_count IS NULL
        AND canonical_bytes IS NULL
        AND canonical_sha256 IS NULL
        AND preview_bytes IS NULL
        AND preview_sha256 IS NULL
        AND ready_at IS NULL
      )
    )
  ) STRICT;

  CREATE TABLE chat_attachment_vault_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    generation INTEGER NOT NULL CHECK (generation >= 0)
  ) STRICT;

  INSERT INTO chat_attachment_vault_state (singleton, generation)
  VALUES (1, 0);

  CREATE TABLE chat_attachment_draft_leases (
    attachment_id TEXT PRIMARY KEY,
    pane_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (attachment_id, pane_id)
      REFERENCES chat_attachments(attachment_id, pane_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE chat_message_attachment_refs (
    message_id TEXT NOT NULL,
    pane_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 7),
    attachment_id TEXT NOT NULL,
    PRIMARY KEY (message_id, position),
    UNIQUE (message_id, pane_id, attachment_id),
    FOREIGN KEY (message_id, pane_id)
      REFERENCES chat_message_ledger(message_id, pane_id) ON DELETE CASCADE,
    FOREIGN KEY (attachment_id, pane_id)
      REFERENCES chat_attachments(attachment_id, pane_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE chat_attachment_turn_leases (
    attachment_id TEXT NOT NULL,
    pane_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    turn_id TEXT NOT NULL CHECK (
      length(turn_id) BETWEEN 16 AND 96
      AND turn_id GLOB 'chatturn_[A-Za-z0-9_-]*'
      AND substr(turn_id, 10) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    state TEXT NOT NULL CHECK (state IN ('active', 'ambiguous', 'released')),
    acquired_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    released_at TEXT,
    PRIMARY KEY (attachment_id, message_id, turn_id),
    FOREIGN KEY (message_id, pane_id, attachment_id)
      REFERENCES chat_message_attachment_refs(
        message_id, pane_id, attachment_id
      ) ON DELETE CASCADE,
    CHECK ((state = 'released') = (released_at IS NOT NULL))
  ) STRICT;

  CREATE UNIQUE INDEX chat_message_ledger_pane_ordinal_idx
    ON chat_message_ledger(pane_id, ordinal);
  CREATE INDEX chat_message_ledger_queued_head_idx
    ON chat_message_ledger(pane_id, ordinal, message_id)
    WHERE state = 'queued';
  CREATE INDEX chat_message_ledger_claimed_turn_idx
    ON chat_message_ledger(pane_id, claimed_turn_id, state)
    WHERE claimed_turn_id IS NOT NULL;
  CREATE UNIQUE INDEX chat_message_ledger_one_uncertain_effect_idx
    ON chat_message_ledger(pane_id)
    WHERE state IN (
      'start_claimed', 'start_effect_started',
      'steer_prepared', 'steer_effect_started'
    );
  CREATE INDEX chat_message_ledger_active_payload_idx
    ON chat_message_ledger(state, pane_id, message_utf8_bytes)
    WHERE state NOT IN ('completed', 'cancelled');
  CREATE INDEX chat_message_attachment_refs_attachment_idx
    ON chat_message_attachment_refs(attachment_id, pane_id, message_id);
  CREATE INDEX chat_attachment_draft_leases_expiry_idx
    ON chat_attachment_draft_leases(expires_at, pane_id, attachment_id);
  CREATE INDEX chat_attachment_turn_leases_live_idx
    ON chat_attachment_turn_leases(pane_id, turn_id, state, attachment_id)
    WHERE state != 'released';

  CREATE TRIGGER chat_message_attachment_ready_insert_guard
  BEFORE INSERT ON chat_message_attachment_refs
  WHEN NOT EXISTS (
    SELECT 1 FROM chat_attachments AS attachment
    WHERE attachment.attachment_id = NEW.attachment_id
      AND attachment.pane_id = NEW.pane_id
      AND attachment.state = 'ready'
  )
  BEGIN
    SELECT RAISE(ABORT, 'chat message attachment is not ready for this pane');
  END;

  CREATE TRIGGER chat_message_ledger_identity_guard
  BEFORE UPDATE OF message_id, pane_id, ordinal ON chat_message_ledger
  WHEN NEW.message_id != OLD.message_id
    OR NEW.pane_id != OLD.pane_id
    OR NEW.ordinal != OLD.ordinal
  BEGIN
    SELECT RAISE(ABORT, 'chat message identity and FIFO ordinal are immutable');
  END;

  CREATE TRIGGER chat_message_ledger_revision_guard
  BEFORE UPDATE ON chat_message_ledger
  WHEN NEW.revision != OLD.revision + 1
  BEGIN
    SELECT RAISE(ABORT, 'chat message revision must advance exactly once');
  END;

  CREATE TRIGGER chat_message_ledger_state_transition_guard
  BEFORE UPDATE OF state ON chat_message_ledger
  WHEN NOT (
    (OLD.state = 'queued' AND NEW.state IN (
      'start_claimed', 'steer_prepared', 'cancelled'
    ))
    OR (OLD.state = 'start_claimed' AND NEW.state IN (
      'queued', 'start_effect_started', 'cancelled'
    ))
    OR (OLD.state = 'start_effect_started' AND NEW.state IN (
      'start_acknowledged', 'ambiguous'
    ))
    OR (OLD.state = 'start_acknowledged' AND NEW.state = 'completed')
    OR (OLD.state = 'steer_prepared' AND NEW.state IN (
      'queued', 'steer_effect_started', 'cancelled'
    ))
    OR (OLD.state = 'steer_effect_started' AND NEW.state IN (
      'steer_acknowledged', 'ambiguous'
    ))
    OR (OLD.state = 'steer_acknowledged' AND NEW.state = 'completed')
    OR (OLD.state = 'ambiguous' AND NEW.state IN ('completed', 'cancelled'))
  )
  BEGIN
    SELECT RAISE(ABORT, 'invalid chat message ledger transition');
  END;
`;
