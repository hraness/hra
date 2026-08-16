/**
 * Migration-owned session-sync schema body. Kept separate so narrow store
 * tests can install the exact production tables without replaying unrelated
 * control-plane migrations.
 */
export const SESSION_SYNC_SCHEMA_SQL = `
  CREATE TABLE session_sync_settings (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    device_name TEXT NOT NULL CHECK (
      length(device_name) BETWEEN 1 AND 80
      AND instr(device_name, char(0)) = 0
    ),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
  ) STRICT;

  INSERT INTO session_sync_settings(
    singleton, revision, enabled, device_name, updated_at
  ) VALUES (1, 0, 0, 'This Mac', 0);

  CREATE TABLE session_sync_device_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    enrollment_state TEXT NOT NULL CHECK (enrollment_state IN (
      'unregistered', 'pending', 'active', 'revoked',
      'conflict', 'update_required'
    )),
    device_id TEXT UNIQUE CHECK (
      device_id IS NULL OR (
        length(device_id) = 43
        AND device_id GLOB 'syncdevice_[A-Za-z0-9_-]*'
        AND substr(device_id, 12) NOT GLOB '*[^A-Za-z0-9_-]*'
      )
    ),
    public_keys_json TEXT NOT NULL CHECK (
      length(public_keys_json) BETWEEN 2 AND 4096
      AND instr(public_keys_json, char(0)) = 0
    ),
    pending_enrollment_json TEXT CHECK (
      pending_enrollment_json IS NULL OR (
        length(pending_enrollment_json) BETWEEN 2 AND 16384
        AND instr(pending_enrollment_json, char(0)) = 0
      )
    ),
    credential_generation INTEGER NOT NULL CHECK (credential_generation >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    CHECK ((enrollment_state = 'unregistered') = (device_id IS NULL)),
    CHECK ((enrollment_state = 'pending') = (pending_enrollment_json IS NOT NULL))
  ) STRICT;

  CREATE TABLE session_sync_vault_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    state TEXT NOT NULL CHECK (state IN ('active', 'conflict', 'retired')),
    tenant_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    vault_id TEXT NOT NULL,
    vault_generation TEXT NOT NULL,
    membership_epoch TEXT NOT NULL,
    membership_digest TEXT NOT NULL,
    membership_head_json TEXT NOT NULL CHECK (
      length(membership_head_json) BETWEEN 2 AND 131072
      AND instr(membership_head_json, char(0)) = 0
    ),
    wrapped_root_json TEXT NOT NULL CHECK (
      length(wrapped_root_json) BETWEEN 2 AND 131072
      AND instr(wrapped_root_json, char(0)) = 0
    ),
    root_key_epoch TEXT NOT NULL,
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    CHECK (length(tenant_id) = 43),
    CHECK (length(organization_id) = 40),
    CHECK (length(owner_user_id) = 41),
    CHECK (length(vault_id) = 42),
    CHECK (membership_digest GLOB 'sha256_[0-9a-f]*' AND length(membership_digest) = 71)
  ) STRICT;

  CREATE TABLE session_sync_boot_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    boot_id TEXT NOT NULL UNIQUE CHECK (
      length(boot_id) = 41
      AND boot_id GLOB 'syncboot_[A-Za-z0-9_-]*'
      AND substr(boot_id, 10) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    boot_generation TEXT,
    heartbeat_sequence TEXT NOT NULL,
    acknowledged INTEGER NOT NULL CHECK (acknowledged IN (0, 1)),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
  ) STRICT;

  CREATE TABLE session_sync_clock_calibration (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    server_observed_at INTEGER NOT NULL CHECK (server_observed_at >= 0),
    client_observed_at INTEGER NOT NULL CHECK (client_observed_at >= 0),
    uncertainty_ms INTEGER NOT NULL CHECK (
      uncertainty_ms >= 0 AND uncertainty_ms <= 60000
    ),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
  ) STRICT;

  CREATE TABLE session_sync_grid_positions (
    session_id TEXT PRIMARY KEY CHECK (
      length(session_id) = 44
      AND session_id GLOB 'syncsession_[A-Za-z0-9_-]*'
      AND substr(session_id, 13) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    grid_position INTEGER NOT NULL UNIQUE CHECK (
      grid_position >= 0 AND grid_position < 512
    ),
    origin TEXT NOT NULL CHECK (origin IN ('local', 'remote')),
    discovered_at INTEGER NOT NULL CHECK (discovered_at >= 0)
  ) STRICT;

  CREATE TABLE session_sync_pane_bindings (
    pane_id TEXT PRIMARY KEY
      REFERENCES chat_panes(pane_id) ON DELETE RESTRICT,
    session_id TEXT NOT NULL UNIQUE
      REFERENCES session_sync_grid_positions(session_id) ON DELETE RESTRICT,
    tenant_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    vault_id TEXT NOT NULL,
    vault_generation TEXT NOT NULL,
    origin_device_id TEXT,
    included INTEGER NOT NULL CHECK (included IN (0, 1)),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    CHECK (length(session_id) = 44),
    CHECK (length(origin_device_id) = 43)
  ) STRICT;

  CREATE TRIGGER session_sync_binding_coordinates_immutable
  BEFORE UPDATE OF session_id, tenant_id, organization_id, owner_user_id,
    vault_id, vault_generation, origin_device_id
  ON session_sync_pane_bindings
  BEGIN
    SELECT RAISE(ABORT, 'session sync binding coordinates are immutable');
  END;

  CREATE TABLE session_sync_dirty_panes (
    pane_id TEXT PRIMARY KEY
      REFERENCES session_sync_pane_bindings(pane_id) ON DELETE CASCADE,
    source_revision INTEGER NOT NULL CHECK (source_revision > 0),
    event_kind TEXT NOT NULL CHECK (event_kind IN (
      'created', 'projection_changed', 'turn_started', 'activity',
      'terminal', 'attention', 'archived', 'deleted'
    )),
    barrier INTEGER NOT NULL CHECK (barrier IN (0, 1)),
    marked_at INTEGER NOT NULL CHECK (marked_at >= 0)
  ) STRICT;

  CREATE TRIGGER session_sync_chat_pane_dirty_update
  AFTER UPDATE OF revision, state, activity_kind, attention_code, archived_at
  ON chat_panes
  WHEN EXISTS (
    SELECT 1 FROM session_sync_pane_bindings AS binding
    JOIN session_sync_settings AS settings ON settings.singleton = 1
    WHERE binding.pane_id = NEW.pane_id
      AND binding.included = 1
      AND settings.enabled = 1
  )
  BEGIN
    INSERT INTO session_sync_dirty_panes(
      pane_id, source_revision, event_kind, barrier, marked_at
    ) VALUES (
      NEW.pane_id,
      NEW.revision,
      CASE
        WHEN NEW.archived_at IS NOT NULL THEN 'archived'
        WHEN NEW.state = 'attention' THEN 'attention'
        WHEN NEW.state IN ('starting', 'streaming', 'continuing') THEN 'activity'
        ELSE 'terminal'
      END,
      CASE
        WHEN NEW.archived_at IS NOT NULL OR NEW.state IN ('attention', 'ready')
          THEN 1
        ELSE 0
      END,
      CAST(strftime('%s', 'now') AS INTEGER) * 1000
    )
    ON CONFLICT(pane_id) DO UPDATE SET
      source_revision = MAX(source_revision, excluded.source_revision),
      event_kind = CASE
        WHEN excluded.source_revision >= source_revision
          THEN excluded.event_kind
        ELSE event_kind
      END,
      barrier = MAX(barrier, excluded.barrier),
      marked_at = MAX(marked_at, excluded.marked_at);
  END;

  CREATE TABLE session_sync_session_heads (
    session_id TEXT PRIMARY KEY
      REFERENCES session_sync_grid_positions(session_id) ON DELETE RESTRICT,
    directory_ordinal TEXT,
    mirror_epoch TEXT NOT NULL,
    writer_generation TEXT NOT NULL,
    boot_id TEXT NOT NULL,
    boot_generation TEXT NOT NULL,
    membership_epoch TEXT NOT NULL,
    key_epoch TEXT NOT NULL,
    acknowledged_sequence TEXT NOT NULL,
    acknowledged_digest TEXT,
    acknowledged_source_revision INTEGER NOT NULL CHECK (
      acknowledged_source_revision >= 0
    ),
    sync_state TEXT NOT NULL CHECK (sync_state IN (
      'idle', 'publishing', 'conflict', 'rekey_required', 'revoked'
    )),
    nonce_state_json TEXT NOT NULL CHECK (
      length(nonce_state_json) BETWEEN 2 AND 1024
      AND instr(nonce_state_json, char(0)) = 0
    ),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    CHECK ((acknowledged_sequence = '0') = (acknowledged_digest IS NULL)),
    CHECK (
      acknowledged_digest IS NULL OR (
        length(acknowledged_digest) = 71
        AND acknowledged_digest GLOB 'sha256_[0-9a-f]*'
      )
    )
  ) STRICT;

  CREATE TABLE session_sync_local_nonce_state (
    session_id TEXT PRIMARY KEY
      REFERENCES session_sync_grid_positions(session_id) ON DELETE RESTRICT,
    key_epoch TEXT NOT NULL,
    nonce_state_json TEXT NOT NULL CHECK (
      length(nonce_state_json) BETWEEN 2 AND 1024
      AND instr(nonce_state_json, char(0)) = 0
    )
  ) STRICT;

  CREATE TABLE session_sync_outbox_intents (
    intent_id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL
      REFERENCES session_sync_grid_positions(session_id) ON DELETE RESTRICT,
    source_revision INTEGER NOT NULL CHECK (source_revision > 0),
    event_kind TEXT NOT NULL CHECK (event_kind IN (
      'created', 'projection_changed', 'turn_started', 'activity',
      'terminal', 'attention', 'archived', 'deleted'
    )),
    barrier INTEGER NOT NULL CHECK (barrier IN (0, 1)),
    sealed_intent_json TEXT NOT NULL CHECK (
      length(sealed_intent_json) BETWEEN 2 AND 8192
      AND instr(sealed_intent_json, char(0)) = 0
    ),
    ciphertext_digest TEXT NOT NULL CHECK (
      length(ciphertext_digest) = 71
      AND ciphertext_digest GLOB 'sha256_[0-9a-f]*'
    ),
    ciphertext_bytes INTEGER NOT NULL CHECK (
      ciphertext_bytes BETWEEN 17 AND 4096
    ),
    created_at INTEGER NOT NULL CHECK (created_at >= 0)
  ) STRICT;

  CREATE UNIQUE INDEX session_sync_one_replaceable_intent_idx
    ON session_sync_outbox_intents(session_id)
    WHERE barrier = 0;
  CREATE INDEX session_sync_outbox_order_idx
    ON session_sync_outbox_intents(intent_id, session_id);

  CREATE TABLE session_sync_attempted_envelopes (
    session_id TEXT PRIMARY KEY
      REFERENCES session_sync_session_heads(session_id) ON DELETE RESTRICT,
    intent_id INTEGER NOT NULL UNIQUE
      REFERENCES session_sync_outbox_intents(intent_id) ON DELETE RESTRICT,
    sync_sequence TEXT NOT NULL,
    ciphertext_digest TEXT NOT NULL CHECK (
      length(ciphertext_digest) = 71
      AND ciphertext_digest GLOB 'sha256_[0-9a-f]*'
    ),
    envelope_json TEXT NOT NULL CHECK (
      length(envelope_json) BETWEEN 2 AND 16384
      AND instr(envelope_json, char(0)) = 0
    ),
    attempted_at INTEGER NOT NULL CHECK (attempted_at >= 0)
  ) STRICT;

  CREATE TABLE session_sync_remote_entries (
    session_id TEXT PRIMARY KEY
      REFERENCES session_sync_grid_positions(session_id) ON DELETE RESTRICT,
    record_kind TEXT NOT NULL CHECK (record_kind IN (
      'head', 'tombstone', 'retired'
    )),
    origin_device_id TEXT,
    directory_ordinal TEXT NOT NULL,
    directory_version TEXT NOT NULL,
    mirror_epoch TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    record_json TEXT NOT NULL CHECK (
      length(record_json) BETWEEN 2 AND 32768
      AND instr(record_json, char(0)) = 0
    ),
    ciphertext_digest TEXT,
    installed_at INTEGER NOT NULL CHECK (installed_at >= 0),
    CHECK (
      (record_kind = 'head') = (ciphertext_digest IS NOT NULL)
    )
  ) STRICT;

  CREATE INDEX session_sync_remote_directory_idx
    ON session_sync_remote_entries(directory_ordinal, session_id);

  CREATE TABLE session_sync_snapshot_entries (
    session_id TEXT PRIMARY KEY,
    record_kind TEXT NOT NULL CHECK (record_kind IN (
      'head', 'tombstone', 'retired'
    )),
    origin_device_id TEXT,
    directory_ordinal TEXT NOT NULL,
    directory_version TEXT NOT NULL,
    mirror_epoch TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    record_json TEXT NOT NULL CHECK (
      length(record_json) BETWEEN 2 AND 32768
      AND instr(record_json, char(0)) = 0
    ),
    ciphertext_digest TEXT,
    CHECK (
      (record_kind = 'head') = (ciphertext_digest IS NOT NULL)
    )
  ) STRICT;

  CREATE TABLE session_sync_directory_cursor (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    mode TEXT NOT NULL CHECK (mode IN ('idle', 'snapshot', 'changes')),
    snapshot_id TEXT,
    snapshot_version TEXT,
    snapshot_cursor_json TEXT,
    change_version TEXT NOT NULL,
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    CHECK (
      (mode = 'snapshot') =
        (snapshot_id IS NOT NULL AND snapshot_version IS NOT NULL)
    ),
    CHECK (
      snapshot_cursor_json IS NULL OR length(snapshot_cursor_json) <= 1024
    )
  ) STRICT;

  INSERT INTO session_sync_directory_cursor(
    singleton, revision, mode, snapshot_id, snapshot_version,
    snapshot_cursor_json, change_version, updated_at
  ) VALUES (1, 0, 'idle', NULL, NULL, NULL, '0', 0);

  CREATE TABLE session_sync_retry_state (
    worker TEXT PRIMARY KEY CHECK (worker IN (
      'enrollment', 'publisher', 'observer', 'heartbeat'
    )),
    attempt INTEGER NOT NULL CHECK (attempt BETWEEN 0 AND 31),
    not_before INTEGER NOT NULL CHECK (not_before >= 0),
    error_code TEXT,
    generation INTEGER NOT NULL CHECK (generation >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
  ) STRICT;

  CREATE TABLE session_sync_signed_membership_epochs (
    membership_epoch TEXT PRIMARY KEY,
    statement_digest TEXT NOT NULL CHECK (
      length(statement_digest) = 71
      AND statement_digest GLOB 'sha256_[0-9a-f]*'
    ),
    signed_at INTEGER NOT NULL CHECK (signed_at >= 0)
  ) STRICT;
`;

/**
 * Crash-law additions applied after the original observation schema. Kept as
 * a separate migration so already-created v31 stores and narrow tests share
 * the same upgrade path.
 */
export const SESSION_SYNC_OPERATION_SCHEMA_SQL = `
  ALTER TABLE session_sync_pane_bindings
    ADD COLUMN binding_state TEXT NOT NULL DEFAULT 'pending'
      CHECK (binding_state IN ('pending', 'accepted'));
  ALTER TABLE session_sync_pane_bindings
    ADD COLUMN creation_grant_digest TEXT CHECK (
      creation_grant_digest IS NULL OR (
        length(creation_grant_digest) = 71
        AND creation_grant_digest GLOB 'sha256_[0-9a-f]*'
      )
    );
  ALTER TABLE session_sync_pane_bindings
    ADD COLUMN reserved_at INTEGER CHECK (
      reserved_at IS NULL OR reserved_at >= 0
    );

  UPDATE session_sync_pane_bindings
  SET binding_state = 'accepted'
  WHERE EXISTS (
    SELECT 1 FROM session_sync_session_heads AS head
    WHERE head.session_id = session_sync_pane_bindings.session_id
      AND head.acknowledged_sequence != '0'
  );

  CREATE TRIGGER session_sync_binding_state_monotonic
  BEFORE UPDATE OF binding_state ON session_sync_pane_bindings
  WHEN OLD.binding_state = 'accepted' AND NEW.binding_state != 'accepted'
  BEGIN
    SELECT RAISE(ABORT, 'accepted session sync binding cannot become pending');
  END;

  CREATE TRIGGER session_sync_creation_grant_immutable
  BEFORE UPDATE OF creation_grant_digest ON session_sync_pane_bindings
  WHEN OLD.creation_grant_digest IS NOT NULL
    AND NEW.creation_grant_digest IS NOT OLD.creation_grant_digest
  BEGIN
    SELECT RAISE(ABORT, 'session sync creation grant is immutable');
  END;

  CREATE TABLE session_sync_retired_pane_bindings (
    retired_session_id TEXT PRIMARY KEY CHECK (
      length(retired_session_id) = 44
      AND retired_session_id GLOB 'syncsession_[A-Za-z0-9_-]*'
    ),
    pane_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    vault_id TEXT NOT NULL,
    vault_generation TEXT NOT NULL,
    origin_device_id TEXT NOT NULL,
    creation_grant_digest TEXT,
    retirement_reason TEXT NOT NULL CHECK (
      retirement_reason IN ('grant_expired', 'retired')
    ),
    retired_at INTEGER NOT NULL CHECK (retired_at >= 0),
    CHECK (
      creation_grant_digest IS NULL OR (
        length(creation_grant_digest) = 71
        AND creation_grant_digest GLOB 'sha256_[0-9a-f]*'
      )
    )
  ) STRICT;

  CREATE INDEX session_sync_retired_pane_history_idx
    ON session_sync_retired_pane_bindings(pane_id, retired_at, retired_session_id);

  CREATE TABLE session_sync_operation_journal (
    operation_id TEXT PRIMARY KEY CHECK (
      length(operation_id) BETWEEN 11 AND 96
      AND operation_id GLOB 'syncop_[A-Za-z0-9_-]*'
    ),
    operation_kind TEXT NOT NULL CHECK (
      length(operation_kind) BETWEEN 3 AND 64
      AND instr(operation_kind, char(0)) = 0
    ),
    replay_policy TEXT NOT NULL CHECK (
      replay_policy IN ('exact_replay', 'deterministic_reconcile')
    ),
    scope_kind TEXT NOT NULL CHECK (
      scope_kind IN ('global', 'heartbeat', 'observer', 'session')
    ),
    scope_id TEXT,
    state TEXT NOT NULL CHECK (
      state IN ('prepared', 'dispatched', 'ambiguous', 'terminal')
    ),
    request_digest TEXT NOT NULL CHECK (
      length(request_digest) = 71
      AND request_digest GLOB 'sha256_[0-9a-f]*'
    ),
    canonical_request_json TEXT NOT NULL CHECK (
      length(canonical_request_json) BETWEEN 2 AND 131072
      AND json_valid(canonical_request_json)
      AND instr(canonical_request_json, char(0)) = 0
    ),
    keychain_references_json TEXT NOT NULL CHECK (
      length(keychain_references_json) BETWEEN 2 AND 4096
      AND json_valid(keychain_references_json)
      AND instr(keychain_references_json, char(0)) = 0
    ),
    response_digest TEXT CHECK (
      response_digest IS NULL OR (
        length(response_digest) = 71
        AND response_digest GLOB 'sha256_[0-9a-f]*'
      )
    ),
    outcome_json TEXT CHECK (
      outcome_json IS NULL OR (
        length(outcome_json) BETWEEN 2 AND 32768
        AND json_valid(outcome_json)
        AND instr(outcome_json, char(0)) = 0
      )
    ),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    terminal_at INTEGER CHECK (
      (state = 'terminal') = (terminal_at IS NOT NULL)
      AND (terminal_at IS NULL OR terminal_at >= created_at)
    ),
    CHECK ((state = 'terminal') = (response_digest IS NOT NULL)),
    CHECK ((state = 'terminal') = (outcome_json IS NOT NULL)),
    CHECK ((scope_kind = 'session') = (scope_id IS NOT NULL))
  ) STRICT;

  CREATE UNIQUE INDEX session_sync_one_global_control_operation_idx
    ON session_sync_operation_journal(scope_kind)
    WHERE scope_kind = 'global' AND state != 'terminal';
  CREATE UNIQUE INDEX session_sync_one_heartbeat_operation_idx
    ON session_sync_operation_journal(scope_kind)
    WHERE scope_kind = 'heartbeat' AND state != 'terminal';
  CREATE UNIQUE INDEX session_sync_one_observer_operation_idx
    ON session_sync_operation_journal(scope_kind)
    WHERE scope_kind = 'observer' AND state != 'terminal';
  CREATE UNIQUE INDEX session_sync_one_operation_per_session_idx
    ON session_sync_operation_journal(scope_id)
    WHERE scope_kind = 'session' AND state != 'terminal';
  CREATE INDEX session_sync_operation_recovery_idx
    ON session_sync_operation_journal(state, scope_kind, updated_at, operation_id);
`;

/** Close the v31 retry diagnostic boundary without retaining foreign text. */
export const SESSION_SYNC_HARDENING_SCHEMA_SQL = `
  ALTER TABLE session_sync_retry_state RENAME TO session_sync_retry_state_v32;

  CREATE TABLE session_sync_retry_state (
    worker TEXT PRIMARY KEY CHECK (worker IN (
      'enrollment', 'publisher', 'observer', 'heartbeat'
    )),
    attempt INTEGER NOT NULL CHECK (attempt BETWEEN 0 AND 31),
    not_before INTEGER NOT NULL CHECK (not_before >= 0),
    error_code TEXT CHECK (
      error_code IS NULL OR error_code IN (
        'AUTHORIZATION_DENIED', 'BOOT_ACTIVE', 'CLOCK_SKEW', 'CONFLICT',
        'GRANT_EXPIRED', 'INVALID_REQUEST', 'KEY_EPOCH_LIMIT',
        'MAINTENANCE_REQUIRED', 'NOT_FOUND', 'PROOF_EXPIRED',
        'PROOF_INVALID', 'PROOF_REPLAYED', 'QUOTA_EXCEEDED', 'RATE_LIMITED',
        'RETIRED', 'SEQUENCE_GAP', 'SERVICE_UNAVAILABLE', 'SNAPSHOT_EXPIRED',
        'STALE_BOOT', 'STALE_MEMBERSHIP', 'STALE_MIRROR', 'STALE_REVISION',
        'STALE_WRITER', 'UPDATE_REQUIRED', 'LOCAL_AUTH_UNAVAILABLE',
        'LOCAL_CANCELLED', 'LOCAL_CORRUPT_STATE',
        'LOCAL_KEYCHAIN_UNAVAILABLE', 'LOCAL_NETWORK_UNAVAILABLE',
        'LOCAL_UNKNOWN'
      )
    ),
    generation INTEGER NOT NULL CHECK (generation >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
  ) STRICT;

  INSERT INTO session_sync_retry_state(
    worker, attempt, not_before, error_code, generation, updated_at
  )
  SELECT worker, attempt, not_before,
    CASE
      WHEN error_code IS NULL THEN NULL
      WHEN error_code IN (
        'AUTHORIZATION_DENIED', 'BOOT_ACTIVE', 'CLOCK_SKEW', 'CONFLICT',
        'GRANT_EXPIRED', 'INVALID_REQUEST', 'KEY_EPOCH_LIMIT',
        'MAINTENANCE_REQUIRED', 'NOT_FOUND', 'PROOF_EXPIRED',
        'PROOF_INVALID', 'PROOF_REPLAYED', 'QUOTA_EXCEEDED', 'RATE_LIMITED',
        'RETIRED', 'SEQUENCE_GAP', 'SERVICE_UNAVAILABLE', 'SNAPSHOT_EXPIRED',
        'STALE_BOOT', 'STALE_MEMBERSHIP', 'STALE_MIRROR', 'STALE_REVISION',
        'STALE_WRITER', 'UPDATE_REQUIRED', 'LOCAL_AUTH_UNAVAILABLE',
        'LOCAL_CANCELLED', 'LOCAL_CORRUPT_STATE',
        'LOCAL_KEYCHAIN_UNAVAILABLE', 'LOCAL_NETWORK_UNAVAILABLE',
        'LOCAL_UNKNOWN'
      ) THEN error_code
      ELSE 'LOCAL_UNKNOWN'
    END,
    generation, updated_at
  FROM session_sync_retry_state_v32;

  DROP TABLE session_sync_retry_state_v32;

  CREATE TABLE session_sync_coordinate_boundary_check (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    valid INTEGER NOT NULL CHECK (valid = 1)
  ) STRICT;
  INSERT INTO session_sync_coordinate_boundary_check(singleton, valid)
  SELECT 1, CASE WHEN
    EXISTS (
      SELECT 1 FROM session_sync_pane_bindings
      WHERE length(tenant_id) != 43
        OR length(organization_id) != 40
        OR length(owner_user_id) != 41
        OR length(vault_id) != 42
        OR length(vault_generation) NOT BETWEEN 1 AND 20
    ) OR EXISTS (
      SELECT 1 FROM session_sync_retired_pane_bindings
      WHERE length(tenant_id) != 43
        OR length(organization_id) != 40
        OR length(owner_user_id) != 41
        OR length(vault_id) != 42
        OR length(vault_generation) NOT BETWEEN 1 AND 20
        OR length(origin_device_id) != 43
    ) THEN 0 ELSE 1 END;
  DROP TABLE session_sync_coordinate_boundary_check;

  CREATE TRIGGER session_sync_binding_coordinate_bounds_insert
  BEFORE INSERT ON session_sync_pane_bindings
  WHEN length(NEW.tenant_id) != 43
    OR length(NEW.organization_id) != 40
    OR length(NEW.owner_user_id) != 41
    OR length(NEW.vault_id) != 42
    OR length(NEW.vault_generation) NOT BETWEEN 1 AND 20
  BEGIN
    SELECT RAISE(ABORT, 'session sync binding coordinates are invalid');
  END;

  CREATE TRIGGER session_sync_retired_binding_coordinate_bounds_insert
  BEFORE INSERT ON session_sync_retired_pane_bindings
  WHEN length(NEW.tenant_id) != 43
    OR length(NEW.organization_id) != 40
    OR length(NEW.owner_user_id) != 41
    OR length(NEW.vault_id) != 42
    OR length(NEW.vault_generation) NOT BETWEEN 1 AND 20
    OR length(NEW.origin_device_id) != 43
  BEGIN
    SELECT RAISE(ABORT, 'retired session sync coordinates are invalid');
  END;

  CREATE TRIGGER session_sync_retired_binding_coordinate_bounds_update
  BEFORE UPDATE OF tenant_id, organization_id, owner_user_id, vault_id,
    vault_generation, origin_device_id
  ON session_sync_retired_pane_bindings
  WHEN length(NEW.tenant_id) != 43
    OR length(NEW.organization_id) != 40
    OR length(NEW.owner_user_id) != 41
    OR length(NEW.vault_id) != 42
    OR length(NEW.vault_generation) NOT BETWEEN 1 AND 20
    OR length(NEW.origin_device_id) != 43
  BEGIN
    SELECT RAISE(ABORT, 'retired session sync coordinates are invalid');
  END;
`;

/**
 * Bind locally retained vault authority to the exact signed-in human scope.
 * Existing pre-binding rows remain NULL and are deliberately unusable until
 * the vault is explicitly reset and enrolled again.
 */
export const SESSION_SYNC_HUMAN_SCOPE_SCHEMA_SQL = `
  ALTER TABLE session_sync_vault_state
    ADD COLUMN human_user_id TEXT CHECK (
      human_user_id IS NULL OR (
        length(human_user_id) BETWEEN 1 AND 256
        AND instr(human_user_id, char(0)) = 0
      )
    );

  ALTER TABLE session_sync_vault_state
    ADD COLUMN human_organization_id TEXT CHECK (
      human_organization_id IS NULL OR (
        length(human_organization_id) BETWEEN 1 AND 256
        AND instr(human_organization_id, char(0)) = 0
      )
    );

  CREATE TRIGGER session_sync_vault_human_scope_insert_guard
  BEFORE INSERT ON session_sync_vault_state
  WHEN (NEW.human_user_id IS NULL) != (NEW.human_organization_id IS NULL)
  BEGIN
    SELECT RAISE(ABORT, 'session sync human scope is incomplete');
  END;

  CREATE TRIGGER session_sync_vault_human_scope_update_guard
  BEFORE UPDATE OF human_user_id, human_organization_id
    ON session_sync_vault_state
  WHEN (NEW.human_user_id IS NULL) != (NEW.human_organization_id IS NULL)
  BEGIN
    SELECT RAISE(ABORT, 'session sync human scope is incomplete');
  END;
`;
