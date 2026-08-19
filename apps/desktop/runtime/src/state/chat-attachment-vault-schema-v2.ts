/**
 * Attachment-vault storage replacing the image-only reservation installed by
 * migration 47. The migration rebuilds the four attachment tables inside one
 * SQLite transaction so generic files become first-class without weakening
 * existing message and turn lease foreign keys.
 */
export const CHAT_ATTACHMENT_VAULT_SCHEMA_V2_SQL = `
  DROP TRIGGER chat_message_attachment_ready_insert_guard;

  CREATE TABLE chat_attachments_v2 (
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
    deletion_reason TEXT CHECK (
      deletion_reason IS NULL OR deletion_reason IN (
        'cancelled', 'removed', 'archive', 'gc', 'privacy'
      )
    ),
    kind TEXT NOT NULL CHECK (kind IN ('image', 'file')),
    display_name TEXT NOT NULL CHECK (
      length(CAST(display_name AS BLOB)) BETWEEN 1 AND 160
      AND instr(display_name, char(0)) = 0
      AND instr(display_name, '/') = 0
      AND instr(display_name, char(92)) = 0
    ),
    declared_media_type TEXT NOT NULL CHECK (
      length(CAST(declared_media_type AS BLOB)) BETWEEN 1 AND 127
      AND instr(declared_media_type, char(0)) = 0
    ),
    effective_media_type TEXT CHECK (
      effective_media_type IS NULL OR (
        length(CAST(effective_media_type AS BLOB)) BETWEEN 1 AND 127
        AND instr(effective_media_type, char(0)) = 0
      )
    ),
    internal_suffix TEXT NOT NULL CHECK (
      length(internal_suffix) BETWEEN 1 AND 16
      AND internal_suffix NOT GLOB '*[^a-z0-9]*'
    ),
    expected_input_bytes INTEGER NOT NULL CHECK (
      expected_input_bytes BETWEEN 1 AND 25165824
    ),
    received_input_bytes INTEGER NOT NULL CHECK (
      received_input_bytes BETWEEN 0 AND expected_input_bytes
    ),
    source_retained INTEGER NOT NULL DEFAULT 1 CHECK (source_retained IN (0, 1)),
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
    finalize_request_revision INTEGER CHECK (
      finalize_request_revision IS NULL OR finalize_request_revision > 0
    ),
    requested_input_sha256 TEXT CHECK (
      requested_input_sha256 IS NULL OR (
        length(requested_input_sha256) = 64
        AND requested_input_sha256 NOT GLOB '*[^0-9a-f]*'
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
    preview_width INTEGER CHECK (
      preview_width IS NULL OR preview_width BETWEEN 1 AND 320
    ),
    preview_height INTEGER CHECK (
      preview_height IS NULL OR preview_height BETWEEN 1 AND 320
    ),
    preview_sha256 TEXT CHECK (
      preview_sha256 IS NULL OR (
        length(preview_sha256) = 64
        AND preview_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
    provider_bytes INTEGER CHECK (
      provider_bytes IS NULL OR provider_bytes BETWEEN 1 AND 67108864
    ),
    provider_sha256 TEXT CHECK (
      provider_sha256 IS NULL OR (
        length(provider_sha256) = 64
        AND provider_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
    ready_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (attachment_id, pane_id),
    UNIQUE (upload_id, attachment_id, pane_id),
    CHECK (
      (state = 'deleting') = (deletion_reason IS NOT NULL)
    ),
    CHECK (
      (prepared_chunk_ordinal IS NULL) = (prepared_offset IS NULL)
      AND (prepared_offset IS NULL) = (prepared_byte_length IS NULL)
      AND (prepared_byte_length IS NULL) = (prepared_sha256 IS NULL)
    ),
    CHECK (
      prepared_chunk_ordinal IS NULL OR (
        prepared_chunk_ordinal = next_chunk_ordinal
        AND prepared_offset = received_input_bytes
        AND prepared_offset + prepared_byte_length <= expected_input_bytes
      )
    ),
    CHECK (
      (finalize_request_revision IS NULL) = (requested_input_sha256 IS NULL)
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
        AND finalize_request_revision IS NOT NULL
        AND requested_input_sha256 = input_sha256
        AND input_sha256 IS NOT NULL
        AND effective_media_type IS NOT NULL
        AND provider_bytes IS NOT NULL
        AND provider_sha256 IS NOT NULL
        AND ready_at IS NOT NULL
        AND (
          (kind = 'image'
            AND effective_media_type = 'image/png'
            AND source_media_type IS NOT NULL
            AND width IS NOT NULL AND height IS NOT NULL
            AND pixel_count IS NOT NULL
            AND canonical_bytes = provider_bytes
            AND canonical_sha256 = provider_sha256
            AND preview_bytes IS NOT NULL
            AND preview_width IS NOT NULL
            AND preview_height IS NOT NULL
            AND preview_sha256 IS NOT NULL)
          OR
          (kind = 'file'
            AND source_retained = 0
            AND source_media_type IS NULL
            AND width IS NULL AND height IS NULL AND pixel_count IS NULL
            AND canonical_bytes IS NULL AND canonical_sha256 IS NULL
            AND preview_bytes IS NULL AND preview_width IS NULL
            AND preview_height IS NULL AND preview_sha256 IS NULL
            AND provider_bytes = expected_input_bytes
            AND provider_sha256 = input_sha256)
        )
      )
    ),
    CHECK (
      state NOT IN ('creating', 'receiving') OR (
        source_retained = 1
        AND finalize_request_revision IS NULL
        AND requested_input_sha256 IS NULL
        AND input_sha256 IS NULL
        AND effective_media_type IS NULL
        AND source_media_type IS NULL
        AND width IS NULL AND height IS NULL AND pixel_count IS NULL
        AND canonical_bytes IS NULL AND canonical_sha256 IS NULL
        AND preview_bytes IS NULL AND preview_width IS NULL
        AND preview_height IS NULL AND preview_sha256 IS NULL
        AND provider_bytes IS NULL AND provider_sha256 IS NULL
        AND ready_at IS NULL
      )
    )
  ) STRICT;

  INSERT INTO chat_attachments_v2 (
    attachment_id, upload_id, pane_id, revision, state, deletion_reason,
    kind, display_name, declared_media_type, effective_media_type,
    internal_suffix, expected_input_bytes, received_input_bytes,
    source_retained,
    next_chunk_ordinal, prepared_chunk_ordinal, prepared_offset,
    prepared_byte_length, prepared_sha256, finalize_request_revision,
    requested_input_sha256, input_sha256, source_media_type,
    width, height, pixel_count, canonical_bytes, canonical_sha256,
    preview_bytes, preview_width, preview_height, preview_sha256,
    provider_bytes, provider_sha256,
    ready_at, created_at, updated_at
  )
  SELECT
    attachment_id, upload_id, pane_id, revision, state,
    CASE WHEN state = 'deleting' THEN 'gc' ELSE NULL END,
    'image', 'image.png', COALESCE(source_media_type, 'image/png'),
    CASE WHEN state = 'ready' THEN 'image/png' ELSE NULL END,
    'png', expected_input_bytes, received_input_bytes,
    CASE WHEN state = 'ready' THEN 0 ELSE 1 END,
    next_chunk_ordinal, prepared_chunk_ordinal, prepared_offset,
    prepared_byte_length, prepared_sha256,
    CASE WHEN input_sha256 IS NOT NULL THEN revision ELSE NULL END,
    input_sha256, input_sha256, source_media_type,
    width, height, pixel_count, canonical_bytes, canonical_sha256,
    preview_bytes,
    CASE WHEN preview_bytes IS NULL THEN NULL ELSE MIN(width, 320) END,
    CASE WHEN preview_bytes IS NULL THEN NULL ELSE MIN(height, 320) END,
    preview_sha256, canonical_bytes, canonical_sha256,
    ready_at, created_at, updated_at
  FROM chat_attachments;

  CREATE TABLE chat_attachment_draft_leases_v2 (
    attachment_id TEXT PRIMARY KEY,
    pane_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (attachment_id, pane_id)
      REFERENCES chat_attachments_v2(attachment_id, pane_id) ON DELETE RESTRICT
  ) STRICT;

  INSERT INTO chat_attachment_draft_leases_v2
  SELECT * FROM chat_attachment_draft_leases;

  CREATE TABLE chat_message_attachment_refs_v2 (
    message_id TEXT NOT NULL,
    pane_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 7),
    attachment_id TEXT NOT NULL,
    consumed_draft_expires_at TEXT NOT NULL,
    PRIMARY KEY (message_id, position),
    UNIQUE (message_id, pane_id, attachment_id),
    FOREIGN KEY (message_id, pane_id)
      REFERENCES chat_message_ledger(message_id, pane_id) ON DELETE CASCADE,
    FOREIGN KEY (attachment_id, pane_id)
      REFERENCES chat_attachments_v2(attachment_id, pane_id) ON DELETE RESTRICT
  ) STRICT;

  INSERT INTO chat_message_attachment_refs_v2
  SELECT * FROM chat_message_attachment_refs;

  CREATE TABLE chat_attachment_turn_leases_v2 (
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
      REFERENCES chat_message_attachment_refs_v2(
        message_id, pane_id, attachment_id
      ) ON DELETE CASCADE,
    CHECK ((state = 'released') = (released_at IS NOT NULL))
  ) STRICT;

  INSERT INTO chat_attachment_turn_leases_v2
  SELECT * FROM chat_attachment_turn_leases;

  DROP TABLE chat_attachment_turn_leases;
  DROP TABLE chat_message_attachment_refs;
  DROP TABLE chat_attachment_draft_leases;
  DROP TABLE chat_attachments;

  ALTER TABLE chat_attachments_v2 RENAME TO chat_attachments;
  ALTER TABLE chat_attachment_draft_leases_v2
    RENAME TO chat_attachment_draft_leases;
  ALTER TABLE chat_message_attachment_refs_v2
    RENAME TO chat_message_attachment_refs;
  ALTER TABLE chat_attachment_turn_leases_v2
    RENAME TO chat_attachment_turn_leases;

  CREATE TABLE chat_attachment_upload_chunks (
    attachment_id TEXT NOT NULL,
    upload_id TEXT NOT NULL,
    pane_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    request_revision INTEGER NOT NULL CHECK (request_revision > 0),
    byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
    byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 524288),
    sha256 TEXT NOT NULL CHECK (
      length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    state TEXT NOT NULL CHECK (state IN ('prepared', 'committed', 'rolled_back')),
    settled_revision INTEGER CHECK (
      settled_revision IS NULL OR settled_revision > request_revision
    ),
    created_at TEXT NOT NULL,
    settled_at TEXT,
    PRIMARY KEY (attachment_id, ordinal, request_revision),
    UNIQUE (upload_id, ordinal, request_revision),
    FOREIGN KEY (upload_id, attachment_id, pane_id)
      REFERENCES chat_attachments(upload_id, attachment_id, pane_id)
      ON DELETE CASCADE,
    CHECK (
      (state = 'prepared' AND settled_revision IS NULL AND settled_at IS NULL)
      OR
      (state IN ('committed', 'rolled_back')
        AND settled_revision IS NOT NULL AND settled_at IS NOT NULL)
    )
  ) STRICT;

  CREATE TABLE chat_provider_attachment_bindings (
    binding_id TEXT PRIMARY KEY CHECK (
      length(binding_id) BETWEEN 19 AND 96
      AND binding_id GLOB 'attbinding_[A-Za-z0-9_-]*'
      AND substr(binding_id, 12) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    binding_key_digest TEXT NOT NULL CHECK (
      length(binding_key_digest) = 64
      AND binding_key_digest NOT GLOB '*[^0-9a-f]*'
    ),
    pane_id TEXT NOT NULL
      REFERENCES chat_panes(pane_id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL CHECK (revision > 0),
    state TEXT NOT NULL CHECK (state IN ('active', 'ambiguous', 'released')),
    ambiguity_receipt_digest TEXT CHECK (
      ambiguity_receipt_digest IS NULL OR (
        length(ambiguity_receipt_digest) = 64
        AND ambiguity_receipt_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    containment_receipt_digest TEXT CHECK (
      containment_receipt_digest IS NULL OR (
        length(containment_receipt_digest) = 64
        AND containment_receipt_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    acquired_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    released_at TEXT,
    UNIQUE (binding_id, pane_id),
    CHECK (
      (state = 'active' AND ambiguity_receipt_digest IS NULL
        AND containment_receipt_digest IS NULL AND released_at IS NULL)
      OR
      (state = 'ambiguous' AND ambiguity_receipt_digest IS NOT NULL
        AND containment_receipt_digest IS NULL AND released_at IS NULL)
      OR
      (state = 'released' AND containment_receipt_digest IS NOT NULL
        AND released_at IS NOT NULL)
    )
  ) STRICT;

  CREATE TABLE chat_provider_attachment_leases (
    binding_id TEXT NOT NULL,
    pane_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    PRIMARY KEY (binding_id, attachment_id),
    FOREIGN KEY (binding_id, pane_id)
      REFERENCES chat_provider_attachment_bindings(binding_id, pane_id)
      ON DELETE CASCADE,
    FOREIGN KEY (attachment_id, pane_id)
      REFERENCES chat_attachments(attachment_id, pane_id)
      ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE chat_attachment_deletion_receipts (
    attachment_id TEXT PRIMARY KEY,
    upload_id TEXT NOT NULL UNIQUE,
    pane_id TEXT NOT NULL CHECK (
      length(pane_id) BETWEEN 12 AND 96
      AND pane_id GLOB 'pane_[A-Za-z0-9_-]*'
      AND substr(pane_id, 6) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    final_revision INTEGER NOT NULL CHECK (final_revision > 0),
    reason TEXT NOT NULL CHECK (reason IN ('cancelled', 'removed', 'archive', 'gc')),
    deleted_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE chat_attachment_pane_archive_intents (
    pane_id TEXT PRIMARY KEY
      REFERENCES chat_panes(pane_id) ON DELETE RESTRICT,
    containment_receipt_digest TEXT NOT NULL CHECK (
      length(containment_receipt_digest) = 64
      AND containment_receipt_digest NOT GLOB '*[^0-9a-f]*'
    ),
    state TEXT NOT NULL CHECK (state IN (
      'prepared', 'pane_archived', 'completed'
    )),
    prepared_at TEXT NOT NULL,
    pane_archived_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL,
    CHECK (
      (state = 'prepared'
        AND pane_archived_at IS NULL AND completed_at IS NULL)
      OR
      (state = 'pane_archived'
        AND pane_archived_at IS NOT NULL AND completed_at IS NULL)
      OR
      (state = 'completed'
        AND pane_archived_at IS NOT NULL AND completed_at IS NOT NULL)
    )
  ) STRICT;

  CREATE TABLE chat_attachment_privacy_deletion_intents (
    pane_id TEXT PRIMARY KEY
      REFERENCES chat_panes(pane_id) ON DELETE RESTRICT,
    authorization_receipt_digest TEXT NOT NULL CHECK (
      length(authorization_receipt_digest) = 64
      AND authorization_receipt_digest NOT GLOB '*[^0-9a-f]*'
    ),
    containment_receipt_digest TEXT NOT NULL CHECK (
      length(containment_receipt_digest) = 64
      AND containment_receipt_digest NOT GLOB '*[^0-9a-f]*'
      AND containment_receipt_digest != authorization_receipt_digest
    ),
    contained_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE chat_attachment_privacy_tombstones (
    pane_id TEXT PRIMARY KEY
      REFERENCES chat_panes(pane_id) ON DELETE CASCADE,
    completed_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE chat_attachment_storage_quarantines (
    attachment_id TEXT PRIMARY KEY,
    pane_id TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('normalizer_cleanup')),
    detected_at TEXT NOT NULL,
    FOREIGN KEY (attachment_id, pane_id)
      REFERENCES chat_attachments(attachment_id, pane_id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX chat_message_attachment_refs_attachment_idx
    ON chat_message_attachment_refs(attachment_id, pane_id, message_id);
  CREATE INDEX chat_attachment_draft_leases_expiry_idx
    ON chat_attachment_draft_leases(expires_at, pane_id, attachment_id);
  CREATE INDEX chat_attachment_turn_leases_live_idx
    ON chat_attachment_turn_leases(pane_id, turn_id, state, attachment_id)
    WHERE state != 'released';
  CREATE INDEX chat_attachments_pane_state_idx
    ON chat_attachments(pane_id, state, created_at, attachment_id);
  CREATE INDEX chat_attachments_gc_idx
    ON chat_attachments(state, updated_at, pane_id, attachment_id)
    WHERE state IN ('ready', 'corrupt', 'deleting');
  CREATE UNIQUE INDEX chat_attachment_upload_one_prepared_idx
    ON chat_attachment_upload_chunks(attachment_id)
    WHERE state = 'prepared';
  CREATE UNIQUE INDEX chat_attachment_upload_one_committed_ordinal_idx
    ON chat_attachment_upload_chunks(attachment_id, ordinal)
    WHERE state = 'committed';
  CREATE INDEX chat_provider_attachment_binding_state_idx
    ON chat_provider_attachment_bindings(pane_id, state, binding_id);
  CREATE INDEX chat_provider_attachment_lease_attachment_idx
    ON chat_provider_attachment_leases(attachment_id, pane_id, binding_id);
  CREATE INDEX chat_attachment_pane_archive_state_idx
    ON chat_attachment_pane_archive_intents(state, pane_id);

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

  CREATE TRIGGER chat_attachment_identity_guard
  BEFORE UPDATE OF
    attachment_id, upload_id, pane_id, kind, display_name,
    declared_media_type, internal_suffix, expected_input_bytes, created_at
  ON chat_attachments
  WHEN NEW.attachment_id != OLD.attachment_id
    OR NEW.upload_id != OLD.upload_id
    OR NEW.pane_id != OLD.pane_id
    OR NEW.kind != OLD.kind
    OR NEW.display_name != OLD.display_name
    OR NEW.declared_media_type != OLD.declared_media_type
    OR NEW.internal_suffix != OLD.internal_suffix
    OR NEW.expected_input_bytes != OLD.expected_input_bytes
    OR NEW.created_at != OLD.created_at
  BEGIN
    SELECT RAISE(ABORT, 'chat attachment identity is immutable');
  END;

  CREATE TRIGGER chat_attachment_revision_guard
  BEFORE UPDATE ON chat_attachments
  WHEN NEW.revision != OLD.revision + 1
  BEGIN
    SELECT RAISE(ABORT, 'chat attachment revision must advance exactly once');
  END;

  CREATE TRIGGER chat_attachment_state_transition_guard
  BEFORE UPDATE OF state ON chat_attachments
  WHEN NEW.state != OLD.state AND NOT (
    (OLD.state = 'creating' AND NEW.state IN ('receiving', 'corrupt', 'deleting'))
    OR (OLD.state = 'receiving' AND NEW.state IN (
      'normalizing', 'publishing', 'corrupt', 'deleting'
    ))
    OR (OLD.state = 'normalizing' AND NEW.state IN (
      'publishing', 'corrupt', 'deleting'
    ))
    OR (OLD.state = 'publishing' AND NEW.state IN (
      'ready', 'corrupt', 'deleting'
    ))
    OR (OLD.state = 'ready' AND NEW.state IN ('corrupt', 'deleting'))
    OR (OLD.state = 'corrupt' AND NEW.state = 'deleting')
  )
  BEGIN
    SELECT RAISE(ABORT, 'invalid chat attachment state transition');
  END;

  CREATE TRIGGER chat_attachment_deletion_reason_guard
  BEFORE UPDATE OF deletion_reason ON chat_attachments
  WHEN OLD.deletion_reason IS NOT NULL
    AND NEW.deletion_reason != OLD.deletion_reason
  BEGIN
    SELECT RAISE(ABORT, 'chat attachment deletion reason is immutable');
  END;

  CREATE TRIGGER chat_attachment_live_custody_delete_guard
  BEFORE DELETE ON chat_attachments
  WHEN EXISTS (
    SELECT 1 FROM chat_attachment_draft_leases AS draft
    WHERE draft.attachment_id = OLD.attachment_id
  ) OR EXISTS (
    SELECT 1 FROM chat_message_attachment_refs AS ref
    WHERE ref.attachment_id = OLD.attachment_id
  ) OR EXISTS (
    SELECT 1 FROM chat_attachment_turn_leases AS turn_lease
    WHERE turn_lease.attachment_id = OLD.attachment_id
      AND turn_lease.state != 'released'
  ) OR EXISTS (
    SELECT 1
    FROM chat_provider_attachment_leases AS provider_lease
    JOIN chat_provider_attachment_bindings AS binding
      ON binding.binding_id = provider_lease.binding_id
    WHERE provider_lease.attachment_id = OLD.attachment_id
      AND binding.state != 'released'
  )
  BEGIN
    SELECT RAISE(ABORT, 'chat attachment has live custody');
  END;

  CREATE TRIGGER chat_provider_attachment_binding_identity_guard
  BEFORE UPDATE OF binding_id, binding_key_digest, pane_id, acquired_at
  ON chat_provider_attachment_bindings
  WHEN NEW.binding_id != OLD.binding_id
    OR NEW.binding_key_digest != OLD.binding_key_digest
    OR NEW.pane_id != OLD.pane_id
    OR NEW.acquired_at != OLD.acquired_at
  BEGIN
    SELECT RAISE(ABORT, 'provider attachment binding identity is immutable');
  END;

  CREATE TRIGGER chat_provider_attachment_binding_revision_guard
  BEFORE UPDATE ON chat_provider_attachment_bindings
  WHEN NEW.revision != OLD.revision + 1
  BEGIN
    SELECT RAISE(ABORT, 'provider attachment binding revision must advance exactly once');
  END;

  CREATE TRIGGER chat_provider_attachment_binding_state_guard
  BEFORE UPDATE OF state ON chat_provider_attachment_bindings
  WHEN NEW.state != OLD.state AND NOT (
    (OLD.state = 'active' AND NEW.state IN ('ambiguous', 'released'))
    OR (OLD.state = 'ambiguous' AND NEW.state = 'released')
  )
  BEGIN
    SELECT RAISE(ABORT, 'invalid provider attachment binding transition');
  END;

  CREATE TRIGGER chat_attachment_pane_archive_identity_guard
  BEFORE UPDATE OF pane_id, containment_receipt_digest, prepared_at
  ON chat_attachment_pane_archive_intents
  WHEN NEW.pane_id != OLD.pane_id
    OR NEW.containment_receipt_digest != OLD.containment_receipt_digest
    OR NEW.prepared_at != OLD.prepared_at
  BEGIN
    SELECT RAISE(ABORT, 'attachment pane archive identity is immutable');
  END;

  CREATE TRIGGER chat_attachment_pane_archive_state_guard
  BEFORE UPDATE OF state ON chat_attachment_pane_archive_intents
  WHEN NOT (
    (OLD.state = 'prepared' AND NEW.state = 'pane_archived')
    OR (OLD.state = 'pane_archived' AND NEW.state = 'completed')
  )
  BEGIN
    SELECT RAISE(ABORT, 'invalid attachment pane archive transition');
  END;

  CREATE TRIGGER chat_attachment_privacy_intent_update_guard
  BEFORE UPDATE ON chat_attachment_privacy_deletion_intents
  BEGIN
    SELECT RAISE(ABORT, 'attachment privacy deletion intent is immutable');
  END;
`;
