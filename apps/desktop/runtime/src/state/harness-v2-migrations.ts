export const harnessV2Migrations = [
  {
    version: 26,
    name: "replay-harness-authority",
    sql: `
      ALTER TABLE chat_panes
        ADD COLUMN interaction_mode TEXT NOT NULL DEFAULT 'chat'
          CHECK (interaction_mode IN ('chat', 'harnessObserver'));

      CREATE TABLE harness_settings (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL CHECK (revision > 0),
        recursive_sessions_enabled INTEGER NOT NULL
          CHECK (recursive_sessions_enabled IN (0, 1)),
        context_quota_bytes INTEGER NOT NULL CHECK (
          context_quota_bytes BETWEEN 1048576 AND 67108864
          AND context_quota_bytes % 1048576 = 0
        ),
        refinement_mode TEXT NOT NULL CHECK (refinement_mode IN ('off', 'suggest')),
        updated_at TEXT NOT NULL
      ) STRICT;

      INSERT INTO harness_settings (
        singleton, revision, recursive_sessions_enabled,
        context_quota_bytes, refinement_mode, updated_at
      ) VALUES (1, 1, 0, 67108864, 'off', '1970-01-01T00:00:00.000Z');

      CREATE TABLE harness_actor_epochs (
        epoch_id TEXT PRIMARY KEY CHECK (
          length(epoch_id) BETWEEN 16 AND 96
          AND epoch_id GLOB 'hepoch_[A-Za-z0-9_-]*'
          AND substr(epoch_id, 8) NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
        source_sha TEXT NOT NULL CHECK (
          length(source_sha) BETWEEN 40 AND 64
          AND source_sha NOT GLOB '*[^0-9a-f]*'
        ),
        root_actor_id TEXT NOT NULL UNIQUE CHECK (
          length(root_actor_id) BETWEEN 16 AND 96
          AND root_actor_id GLOB 'hactor_[A-Za-z0-9_-]*'
          AND substr(root_actor_id, 8) NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        max_depth INTEGER NOT NULL CHECK (max_depth BETWEEN 0 AND 3),
        max_active_descendants INTEGER NOT NULL
          CHECK (max_active_descendants BETWEEN 1 AND 8),
        max_durable_descendants INTEGER NOT NULL
          CHECK (max_durable_descendants BETWEEN 1 AND 50),
        token_budget INTEGER NOT NULL CHECK (token_budget > 0),
        byte_budget INTEGER NOT NULL CHECK (
          byte_budget BETWEEN 1048576 AND 67108864
          AND byte_budget % 1048576 = 0
        ),
        deadline TEXT NOT NULL CHECK (
          length(deadline) = 24 AND substr(deadline, 24, 1) = 'Z'
        ),
        lane_authority TEXT NOT NULL
          CHECK (lane_authority IN ('readOnlySnapshot', 'managedWrite')),
        token_reserved INTEGER NOT NULL DEFAULT 0
          CHECK (token_reserved BETWEEN 0 AND token_budget),
        byte_reserved INTEGER NOT NULL DEFAULT 0
          CHECK (byte_reserved BETWEEN 0 AND byte_budget),
        next_root_completion_sequence INTEGER NOT NULL DEFAULT 1
          CHECK (next_root_completion_sequence > 0),
        state TEXT NOT NULL CHECK (
          state IN ('active', 'stopRequested', 'stopped', 'quarantined')
        ),
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        stopped_at TEXT,
        CHECK (
          (state IN ('stopped', 'quarantined')) = (stopped_at IS NOT NULL)
        )
      ) STRICT;

      CREATE TABLE harness_actors (
        actor_id TEXT PRIMARY KEY CHECK (
          length(actor_id) BETWEEN 16 AND 96
          AND actor_id GLOB 'hactor_[A-Za-z0-9_-]*'
          AND substr(actor_id, 8) NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        epoch_id TEXT NOT NULL
          REFERENCES harness_actor_epochs(epoch_id) ON DELETE RESTRICT,
        parent_actor_id TEXT REFERENCES harness_actors(actor_id) ON DELETE RESTRICT,
        depth INTEGER NOT NULL CHECK (depth BETWEEN 0 AND 3),
        title TEXT NOT NULL CHECK (
          length(title) BETWEEN 1 AND 160 AND instr(title, char(0)) = 0
        ),
        state TEXT NOT NULL CHECK (
          state IN ('active', 'stopRequested', 'stopped', 'quarantined')
        ),
        max_depth INTEGER NOT NULL CHECK (max_depth BETWEEN depth AND 3),
        max_active_descendants INTEGER NOT NULL
          CHECK (max_active_descendants BETWEEN 1 AND 8),
        max_durable_descendants INTEGER NOT NULL
          CHECK (max_durable_descendants BETWEEN 1 AND 50),
        token_budget INTEGER NOT NULL CHECK (token_budget > 0),
        byte_budget INTEGER NOT NULL CHECK (
          byte_budget BETWEEN 1048576 AND 67108864
          AND byte_budget % 1048576 = 0
        ),
        deadline TEXT NOT NULL CHECK (
          length(deadline) = 24 AND substr(deadline, 24, 1) = 'Z'
        ),
        lane_authority TEXT NOT NULL
          CHECK (lane_authority IN ('readOnlySnapshot', 'managedWrite')),
        token_reserved INTEGER NOT NULL DEFAULT 0
          CHECK (token_reserved BETWEEN 0 AND token_budget),
        byte_reserved INTEGER NOT NULL DEFAULT 0
          CHECK (byte_reserved BETWEEN 0 AND byte_budget),
        next_turn_ordinal INTEGER NOT NULL DEFAULT 1 CHECK (next_turn_ordinal > 0),
        next_result_ordinal INTEGER NOT NULL DEFAULT 1 CHECK (next_result_ordinal > 0),
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        stopped_at TEXT,
        CHECK ((parent_actor_id IS NULL) = (depth = 0)),
        CHECK (
          (state IN ('stopped', 'quarantined')) = (stopped_at IS NOT NULL)
        )
      ) STRICT;

      CREATE UNIQUE INDEX harness_actors_one_root_idx
        ON harness_actors(epoch_id) WHERE parent_actor_id IS NULL;
      CREATE INDEX harness_actors_parent_idx
        ON harness_actors(epoch_id, parent_actor_id, actor_id);

      CREATE TRIGGER harness_actor_lineage_insert_guard
      BEFORE INSERT ON harness_actors
      WHEN NOT (
        (NEW.parent_actor_id IS NULL AND EXISTS (
          SELECT 1 FROM harness_actor_epochs AS epoch
          WHERE epoch.epoch_id = NEW.epoch_id
            AND epoch.root_actor_id = NEW.actor_id
            AND NEW.depth = 0
            AND NEW.max_depth <= epoch.max_depth
            AND NEW.max_active_descendants <= epoch.max_active_descendants
            AND NEW.max_durable_descendants <= epoch.max_durable_descendants
            AND NEW.token_budget <= epoch.token_budget
            AND NEW.byte_budget <= epoch.byte_budget
            AND NEW.deadline <= epoch.deadline
            AND (
              epoch.lane_authority = 'managedWrite'
              OR NEW.lane_authority = 'readOnlySnapshot'
            )
        ))
        OR (NEW.parent_actor_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM harness_actors AS parent
          WHERE parent.actor_id = NEW.parent_actor_id
            AND parent.epoch_id = NEW.epoch_id
            AND parent.state = 'active'
            AND NEW.depth = parent.depth + 1
            AND NEW.max_depth <= parent.max_depth
            AND NEW.max_active_descendants <= parent.max_active_descendants
            AND NEW.max_durable_descendants <= parent.max_durable_descendants
            AND NEW.token_budget <= parent.token_budget - parent.token_reserved
            AND NEW.byte_budget <= parent.byte_budget - parent.byte_reserved
            AND NEW.deadline <= parent.deadline
            AND (
              parent.lane_authority = 'managedWrite'
              OR NEW.lane_authority = 'readOnlySnapshot'
            )
        ))
      )
      BEGIN
        SELECT RAISE(ABORT, 'recursive actor lineage or budget is incoherent');
      END;

      CREATE TABLE harness_context_values (
        value_id TEXT PRIMARY KEY CHECK (
          length(value_id) BETWEEN 16 AND 96
          AND value_id GLOB 'ctxval_[A-Za-z0-9_-]*'
          AND substr(value_id, 8) NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        operation_id TEXT NOT NULL UNIQUE CHECK (
          length(operation_id) BETWEEN 16 AND 128
          AND operation_id NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        epoch_id TEXT NOT NULL
          REFERENCES harness_actor_epochs(epoch_id) ON DELETE RESTRICT,
        owner_actor_id TEXT NOT NULL
          REFERENCES harness_actors(actor_id) ON DELETE RESTRICT,
        source_turn_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('text', 'json', 'selection', 'agentResult')),
        purpose TEXT NOT NULL CHECK (purpose IN (
          'heap', 'completedPrefix', 'currentInput', 'agentResult', 'proposal',
          'actorTask', 'programSource', 'programResult'
        )),
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        name_digest TEXT CHECK (
          name_digest IS NULL OR (
            length(name_digest) = 64 AND name_digest NOT GLOB '*[^0-9a-f]*'
          )
        ),
        utf8_bytes INTEGER NOT NULL CHECK (
          (purpose = 'completedPrefix' AND utf8_bytes BETWEEN 0 AND 18874368)
          OR (purpose != 'completedPrefix' AND utf8_bytes BETWEEN 0 AND 1048576)
        ),
        content_digest TEXT NOT NULL CHECK (
          length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'
        ),
        chunk_size INTEGER NOT NULL CHECK (chunk_size = 65536),
        chunk_count INTEGER NOT NULL CHECK (
          (purpose = 'completedPrefix' AND chunk_count BETWEEN 1 AND 288)
          OR (purpose != 'completedPrefix' AND chunk_count BETWEEN 1 AND 16)
        ),
        manifest_digest TEXT NOT NULL CHECK (
          length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'
        ),
        manifest_byte_length INTEGER NOT NULL
          CHECK (manifest_byte_length BETWEEN 1 AND 2097152),
        quota_limit_bytes INTEGER NOT NULL CHECK (
          quota_limit_bytes BETWEEN 1048576 AND 67108864
          AND quota_limit_bytes % 1048576 = 0
        ),
        state TEXT NOT NULL CHECK (state IN (
          'prepared', 'effectStarted', 'replayRequired', 'active', 'recoveryRequired'
        )),
        recovery_reason TEXT CHECK (
          recovery_reason IS NULL OR recovery_reason IN (
            'ciphertext_invalid', 'immutable_object_conflict',
            'metadata_conflict', 'object_missing_after_activation'
          )
        ),
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        effect_started_at TEXT,
        activated_at TEXT,
        CHECK ((state = 'recoveryRequired') = (recovery_reason IS NOT NULL)),
        CHECK (purpose != 'completedPrefix' OR kind = 'selection'),
        CHECK ((state IN ('effectStarted', 'replayRequired', 'active', 'recoveryRequired'))
          = (effect_started_at IS NOT NULL)),
        CHECK ((state = 'active') = (activated_at IS NOT NULL))
      ) STRICT;

      CREATE UNIQUE INDEX harness_context_values_active_name_idx
        ON harness_context_values(epoch_id, owner_actor_id, name_digest)
        WHERE state = 'active' AND name_digest IS NOT NULL;
      CREATE INDEX harness_context_values_active_list_idx
        ON harness_context_values(epoch_id, value_id) WHERE state = 'active';
      CREATE INDEX harness_context_values_recovery_idx
        ON harness_context_values(state, operation_id)
        WHERE state != 'active';

      CREATE TABLE harness_context_value_chunks (
        value_id TEXT NOT NULL
          REFERENCES harness_context_values(value_id) ON DELETE RESTRICT,
        ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 287),
        plaintext_bytes INTEGER NOT NULL CHECK (plaintext_bytes BETWEEN 0 AND 65536),
        object_digest TEXT NOT NULL CHECK (
          length(object_digest) = 64 AND object_digest NOT GLOB '*[^0-9a-f]*'
        ),
        object_byte_length INTEGER NOT NULL
          CHECK (object_byte_length BETWEEN 1 AND 2097152),
        PRIMARY KEY (value_id, ordinal)
      ) STRICT;

      CREATE TRIGGER harness_context_value_chunk_insert_guard
      BEFORE INSERT ON harness_context_value_chunks
      WHEN NOT EXISTS (
        SELECT 1 FROM harness_context_values AS value
        WHERE value.value_id = NEW.value_id
          AND NEW.ordinal < value.chunk_count
          AND (value.purpose = 'completedPrefix' OR NEW.ordinal < 16)
      )
      BEGIN
        SELECT RAISE(ABORT, 'context value chunk exceeds its purpose capacity');
      END;

      CREATE TABLE harness_actor_turns (
        turn_id TEXT PRIMARY KEY CHECK (
          length(turn_id) BETWEEN 15 AND 96
          AND turn_id GLOB 'hturn_[A-Za-z0-9_-]*'
          AND substr(turn_id, 7) NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        epoch_id TEXT NOT NULL
          REFERENCES harness_actor_epochs(epoch_id) ON DELETE RESTRICT,
        actor_id TEXT NOT NULL REFERENCES harness_actors(actor_id) ON DELETE RESTRICT,
        ordinal INTEGER NOT NULL CHECK (ordinal > 0),
        idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
        input_value_id TEXT NOT NULL
          REFERENCES harness_context_values(value_id) ON DELETE RESTRICT,
        state TEXT NOT NULL CHECK (state IN (
          'prepared', 'starting', 'running', 'reconciling', 'succeeded',
          'failed', 'cancelled', 'quotaRejected', 'ambiguous'
        )),
        desired_state TEXT NOT NULL CHECK (desired_state IN ('run', 'stop')),
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        started_at TEXT,
        settled_at TEXT,
        outcome_code TEXT,
        UNIQUE (actor_id, ordinal),
        UNIQUE (actor_id, idempotency_key),
        CHECK ((state != 'prepared') = (started_at IS NOT NULL)),
        CHECK ((state IN ('succeeded', 'failed', 'cancelled', 'quotaRejected', 'ambiguous'))
          = (settled_at IS NOT NULL)),
        CHECK ((settled_at IS NOT NULL) = (outcome_code IS NOT NULL))
      ) STRICT;

      CREATE TRIGGER harness_actor_turn_lineage_insert_guard
      BEFORE INSERT ON harness_actor_turns
      WHEN NOT EXISTS (
        SELECT 1
        FROM harness_actors AS actor
        JOIN harness_context_values AS input ON input.value_id = NEW.input_value_id
        WHERE actor.actor_id = NEW.actor_id
          AND actor.epoch_id = NEW.epoch_id
          AND actor.state = 'active'
          AND input.epoch_id = NEW.epoch_id
          AND input.owner_actor_id = NEW.actor_id
          AND input.purpose IN ('currentInput', 'actorTask')
          AND input.state = 'active'
      )
      BEGIN
        SELECT RAISE(ABORT, 'actor turn lineage or input is incoherent');
      END;

      CREATE TRIGGER harness_context_value_source_turn_insert_guard
      BEFORE INSERT ON harness_context_values
      WHEN NEW.source_turn_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM harness_actor_turns AS turn
        WHERE turn.turn_id = NEW.source_turn_id
          AND turn.epoch_id = NEW.epoch_id
          AND turn.actor_id = NEW.owner_actor_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'context value source turn is incoherent');
      END;

      CREATE TRIGGER harness_context_value_source_turn_update_guard
      BEFORE UPDATE OF source_turn_id, epoch_id, owner_actor_id
        ON harness_context_values
      WHEN NEW.source_turn_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM harness_actor_turns AS turn
        WHERE turn.turn_id = NEW.source_turn_id
          AND turn.epoch_id = NEW.epoch_id
          AND turn.actor_id = NEW.owner_actor_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'context value source turn is incoherent');
      END;

      CREATE TABLE harness_context_snapshots (
        snapshot_id TEXT PRIMARY KEY CHECK (
          length(snapshot_id) BETWEEN 16 AND 96
          AND snapshot_id GLOB 'ctxsnap_[A-Za-z0-9_-]*'
          AND substr(snapshot_id, 9) NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        epoch_id TEXT NOT NULL
          REFERENCES harness_actor_epochs(epoch_id) ON DELETE RESTRICT,
        actor_id TEXT NOT NULL REFERENCES harness_actors(actor_id) ON DELETE RESTRICT,
        completed_through_turn_id TEXT REFERENCES harness_actor_turns(turn_id)
          ON DELETE RESTRICT,
        coverage_witness_digest TEXT NOT NULL CHECK (
          length(coverage_witness_digest) = 64
          AND coverage_witness_digest NOT GLOB '*[^0-9a-f]*'
        ),
        value_id TEXT NOT NULL UNIQUE
          REFERENCES harness_context_values(value_id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        expires_at TEXT
      ) STRICT;

      CREATE TRIGGER harness_context_snapshot_insert_guard
      BEFORE INSERT ON harness_context_snapshots
      WHEN NOT EXISTS (
        SELECT 1 FROM harness_context_values AS value
        WHERE value.value_id = NEW.value_id
          AND value.epoch_id = NEW.epoch_id
          AND value.owner_actor_id = NEW.actor_id
          AND value.purpose = 'completedPrefix'
          AND value.kind = 'selection'
          AND value.source_turn_id IS NEW.completed_through_turn_id
          AND value.state = 'active'
      ) OR (
        NEW.completed_through_turn_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM harness_actor_turns AS turn
          WHERE turn.turn_id = NEW.completed_through_turn_id
            AND turn.epoch_id = NEW.epoch_id
            AND turn.actor_id = NEW.actor_id
            AND turn.state IN ('succeeded', 'failed', 'cancelled', 'quotaRejected')
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'completed-prefix snapshot is incoherent');
      END;

      CREATE TRIGGER harness_context_snapshot_update_guard
      BEFORE UPDATE OF epoch_id, actor_id, completed_through_turn_id, value_id
        ON harness_context_snapshots
      WHEN NOT EXISTS (
        SELECT 1 FROM harness_context_values AS value
        WHERE value.value_id = NEW.value_id
          AND value.epoch_id = NEW.epoch_id
          AND value.owner_actor_id = NEW.actor_id
          AND value.purpose = 'completedPrefix'
          AND value.kind = 'selection'
          AND value.source_turn_id IS NEW.completed_through_turn_id
          AND value.state = 'active'
      ) OR (
        NEW.completed_through_turn_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM harness_actor_turns AS turn
          WHERE turn.turn_id = NEW.completed_through_turn_id
            AND turn.epoch_id = NEW.epoch_id
            AND turn.actor_id = NEW.actor_id
            AND turn.state IN ('succeeded', 'failed', 'cancelled', 'quotaRejected')
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'completed-prefix snapshot is incoherent');
      END;

      CREATE TABLE harness_program_runs (
        run_id TEXT PRIMARY KEY CHECK (
          length(run_id) BETWEEN 15 AND 96
          AND run_id GLOB 'rlmrun_[A-Za-z0-9_-]*'
          AND substr(run_id, 8) NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        epoch_id TEXT NOT NULL
          REFERENCES harness_actor_epochs(epoch_id) ON DELETE RESTRICT,
        actor_id TEXT NOT NULL REFERENCES harness_actors(actor_id) ON DELETE RESTRICT,
        turn_id TEXT NOT NULL
          REFERENCES harness_actor_turns(turn_id) ON DELETE RESTRICT,
        program_value_id TEXT NOT NULL
          REFERENCES harness_context_values(value_id) ON DELETE RESTRICT,
        program_digest TEXT NOT NULL CHECK (
          length(program_digest) = 64 AND program_digest NOT GLOB '*[^0-9a-f]*'
        ),
        completed_prefix_snapshot_id TEXT NOT NULL
          REFERENCES harness_context_snapshots(snapshot_id) ON DELETE RESTRICT,
        current_user_input_value_id TEXT
          REFERENCES harness_context_values(value_id) ON DELETE RESTRICT,
        capabilities_json TEXT NOT NULL CHECK (
          json_valid(capabilities_json)
          AND json_type(capabilities_json) = 'array'
          AND length(capabilities_json) BETWEEN 2 AND 512
        ),
        admitted_features_json TEXT NOT NULL CHECK (
          json_valid(admitted_features_json)
          AND json_type(admitted_features_json) = 'array'
          AND length(admitted_features_json) BETWEEN 2 AND 512
        ),
        semantic_witness_digests_json TEXT NOT NULL CHECK (
          json_valid(semantic_witness_digests_json)
          AND json_type(semantic_witness_digests_json) = 'array'
          AND length(semantic_witness_digests_json) BETWEEN 2 AND 4096
        ),
        recursive_budget_json TEXT NOT NULL CHECK (
          json_valid(recursive_budget_json)
          AND json_type(recursive_budget_json) = 'object'
          AND length(recursive_budget_json) BETWEEN 2 AND 2048
        ),
        fuel_limit INTEGER NOT NULL CHECK (fuel_limit BETWEEN 1 AND 1024),
        deadline TEXT NOT NULL CHECK (
          length(deadline) = 24 AND substr(deadline, 24, 1) = 'Z'
        ),
        release_identity_digest TEXT NOT NULL CHECK (
          length(release_identity_digest) = 64
          AND release_identity_digest NOT GLOB '*[^0-9a-f]*'
        ),
        admission_digest TEXT NOT NULL CHECK (
          length(admission_digest) = 64
          AND admission_digest NOT GLOB '*[^0-9a-f]*'
        ),
        desired_state TEXT NOT NULL CHECK (desired_state IN ('run', 'suspend', 'stop')),
        state TEXT NOT NULL CHECK (state IN (
          'prepared', 'running', 'suspended', 'completed', 'failed',
          'stopped', 'recoveryRequired'
        )),
        terminal_result_value_id TEXT
          REFERENCES harness_context_values(value_id) ON DELETE RESTRICT,
        terminal_code TEXT,
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        settled_at TEXT,
        CHECK ((state IN ('completed', 'failed', 'stopped', 'recoveryRequired'))
          = (settled_at IS NOT NULL)),
        CHECK ((state = 'completed') = (terminal_result_value_id IS NOT NULL)),
        CHECK ((settled_at IS NOT NULL) = (terminal_code IS NOT NULL)),
        CHECK (deadline = json_extract(recursive_budget_json, '$.deadline'))
      ) STRICT;

      CREATE INDEX harness_program_runs_turn_lineage_idx
        ON harness_program_runs(turn_id);

      CREATE TRIGGER harness_program_run_lineage_insert_guard
      BEFORE INSERT ON harness_program_runs
      WHEN NOT EXISTS (
        SELECT 1
        FROM harness_actor_turns AS turn
        JOIN harness_context_values AS program
          ON program.value_id = NEW.program_value_id
        JOIN harness_context_snapshots AS snapshot
          ON snapshot.snapshot_id = NEW.completed_prefix_snapshot_id
        WHERE turn.turn_id = NEW.turn_id
          AND turn.epoch_id = NEW.epoch_id
          AND turn.actor_id = NEW.actor_id
          AND program.epoch_id = NEW.epoch_id
          AND program.owner_actor_id = NEW.actor_id
          AND program.purpose = 'programSource'
          AND program.state = 'active'
          AND snapshot.epoch_id = NEW.epoch_id
          AND snapshot.actor_id = NEW.actor_id
          AND (
            NEW.current_user_input_value_id IS NULL
            OR NEW.current_user_input_value_id = turn.input_value_id
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'program-run lineage is incoherent');
      END;

      CREATE TRIGGER harness_program_run_admission_immutable_guard
      BEFORE UPDATE OF
        run_id, epoch_id, actor_id, turn_id, program_value_id,
        program_digest, completed_prefix_snapshot_id,
        current_user_input_value_id, capabilities_json,
        admitted_features_json, semantic_witness_digests_json,
        recursive_budget_json, fuel_limit, deadline,
        release_identity_digest, admission_digest, created_at
      ON harness_program_runs
      WHEN NEW.run_id != OLD.run_id
        OR NEW.epoch_id != OLD.epoch_id
        OR NEW.actor_id != OLD.actor_id
        OR NEW.turn_id != OLD.turn_id
        OR NEW.program_value_id != OLD.program_value_id
        OR NEW.program_digest != OLD.program_digest
        OR NEW.completed_prefix_snapshot_id != OLD.completed_prefix_snapshot_id
        OR NEW.current_user_input_value_id IS NOT OLD.current_user_input_value_id
        OR NEW.capabilities_json != OLD.capabilities_json
        OR NEW.admitted_features_json != OLD.admitted_features_json
        OR NEW.semantic_witness_digests_json != OLD.semantic_witness_digests_json
        OR NEW.recursive_budget_json != OLD.recursive_budget_json
        OR NEW.fuel_limit != OLD.fuel_limit
        OR NEW.deadline != OLD.deadline
        OR NEW.release_identity_digest != OLD.release_identity_digest
        OR NEW.admission_digest != OLD.admission_digest
        OR NEW.created_at != OLD.created_at
      BEGIN
        SELECT RAISE(ABORT, 'program-run admission is immutable');
      END;

      CREATE TABLE harness_program_operation_receipts (
        receipt_id TEXT PRIMARY KEY CHECK (
          length(receipt_id) BETWEEN 16 AND 128
          AND receipt_id NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        run_id TEXT NOT NULL
          REFERENCES harness_program_runs(run_id) ON DELETE RESTRICT,
        canonical_node_path TEXT NOT NULL CHECK (
          json_valid(canonical_node_path) AND length(canonical_node_path) BETWEEN 2 AND 1024
        ),
        operation TEXT NOT NULL CHECK (operation IN (
          'context.snapshot', 'context.search', 'context.slice', 'context.materialize',
          'heap.put', 'heap.get', 'heap.list', 'agent.spawn', 'agent.send',
          'agent.status', 'agent.waitAny', 'agent.waitAll', 'agent.result',
          'agent.cancel', 'harness.list', 'harness.get', 'harness.propose'
        )),
        request_digest TEXT NOT NULL CHECK (
          length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
        ),
        effect_key TEXT NOT NULL CHECK (
          length(effect_key) = 64 AND effect_key NOT GLOB '*[^0-9a-f]*'
        ),
        replay_class TEXT NOT NULL CHECK (replay_class IN (
          'pureRead', 'cancelableWait', 'idempotentLocalMutation',
          'reconciledExternalMutation'
        )),
        state TEXT NOT NULL CHECK (state IN (
          'prepared', 'effectStarted', 'succeeded', 'failed',
          'replayRequired', 'recoveryRequired'
        )),
        result_value_id TEXT
          REFERENCES harness_context_values(value_id) ON DELETE RESTRICT,
        error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        settled_at TEXT,
        UNIQUE (run_id, canonical_node_path),
        CHECK ((state IN ('succeeded', 'failed', 'recoveryRequired'))
          = (settled_at IS NOT NULL)),
        CHECK (result_value_id IS NULL OR state = 'succeeded'),
        CHECK (error_json IS NULL OR state IN ('failed', 'recoveryRequired'))
      ) STRICT;

      CREATE INDEX harness_program_receipts_recovery_idx
        ON harness_program_operation_receipts(state, receipt_id)
        WHERE state IN ('effectStarted', 'replayRequired', 'recoveryRequired');

      CREATE TABLE harness_proposals (
        proposal_id TEXT PRIMARY KEY CHECK (
          length(proposal_id) BETWEEN 19 AND 96
          AND proposal_id GLOB 'hproposal_[A-Za-z0-9_-]*'
          AND substr(proposal_id, 11) NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        epoch_id TEXT NOT NULL
          REFERENCES harness_actor_epochs(epoch_id) ON DELETE RESTRICT,
        actor_id TEXT NOT NULL REFERENCES harness_actors(actor_id) ON DELETE RESTRICT,
        source_turn_id TEXT NOT NULL
          REFERENCES harness_actor_turns(turn_id) ON DELETE RESTRICT,
        operation_id TEXT NOT NULL UNIQUE CHECK (
          length(operation_id) BETWEEN 16 AND 128
          AND operation_id NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        title TEXT NOT NULL CHECK (
          length(title) BETWEEN 1 AND 160 AND instr(title, char(0)) = 0
        ),
        body_value_id TEXT NOT NULL UNIQUE CHECK (
          length(body_value_id) BETWEEN 16 AND 96
          AND body_value_id GLOB 'ctxval_[A-Za-z0-9_-]*'
          AND substr(body_value_id, 8) NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        body_digest TEXT NOT NULL CHECK (
          length(body_digest) = 64 AND body_digest NOT GLOB '*[^0-9a-f]*'
        ),
        state TEXT NOT NULL CHECK (state IN ('prepared', 'active', 'recoveryRequired')),
        recovery_reason TEXT CHECK (
          recovery_reason IS NULL OR length(recovery_reason) BETWEEN 1 AND 96
        ),
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        activated_at TEXT,
        CHECK ((state = 'active') = (activated_at IS NOT NULL)),
        CHECK ((state = 'recoveryRequired') = (recovery_reason IS NOT NULL))
      ) STRICT;

      CREATE INDEX harness_proposals_list_idx
        ON harness_proposals(created_at DESC, proposal_id) WHERE state = 'active';

      CREATE TRIGGER harness_proposal_activation_guard
      BEFORE UPDATE OF state ON harness_proposals
      WHEN NEW.state = 'active' AND NOT EXISTS (
        SELECT 1
        FROM harness_context_values AS body
        JOIN harness_actor_turns AS turn
          ON turn.turn_id = NEW.source_turn_id
          AND turn.epoch_id = NEW.epoch_id
          AND turn.actor_id = NEW.actor_id
        WHERE body.value_id = NEW.body_value_id
          AND body.epoch_id = NEW.epoch_id
          AND body.owner_actor_id = NEW.actor_id
          AND body.source_turn_id = NEW.source_turn_id
          AND body.purpose = 'proposal'
          AND body.kind = 'json'
          AND body.state = 'active'
      )
      BEGIN
        SELECT RAISE(ABORT, 'active proposal body lineage is incoherent');
      END;
    `,
  },
  {
    version: 27,
    name: "recursive-actor-workspaces",
    sql: `
      ALTER TABLE workspace_leases ADD COLUMN quarantine_reason TEXT;
      ALTER TABLE workspace_leases ADD COLUMN quarantined_at TEXT;

      CREATE UNIQUE INDEX workspace_read_only_snapshot_identity_idx
        ON workspace_leases(project_id, base_sha)
        WHERE mode = 'harness_read_only_snapshot';

      CREATE TABLE harness_actor_workspace_bindings (
        binding_id TEXT PRIMARY KEY CHECK (
          length(binding_id) BETWEEN 16 AND 96
          AND binding_id GLOB 'hbinding_[A-Za-z0-9_-]*'
          AND substr(binding_id, 10) NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        actor_id TEXT NOT NULL REFERENCES harness_actors(actor_id) ON DELETE RESTRICT,
        lane_id TEXT NOT NULL REFERENCES workspace_leases(lane_id) ON DELETE RESTRICT,
        authority TEXT NOT NULL CHECK (authority IN ('readOnlySnapshot', 'managedWrite')),
        state TEXT NOT NULL CHECK (state IN ('active', 'released', 'quarantined')),
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        released_at TEXT,
        CHECK ((state != 'active') = (released_at IS NOT NULL))
      ) STRICT;

      CREATE UNIQUE INDEX harness_actor_workspace_one_active_idx
        ON harness_actor_workspace_bindings(actor_id) WHERE state = 'active';
      CREATE UNIQUE INDEX harness_actor_workspace_managed_lane_idx
        ON harness_actor_workspace_bindings(lane_id)
        WHERE state = 'active' AND authority = 'managedWrite';
      CREATE INDEX harness_actor_workspace_shared_lane_idx
        ON harness_actor_workspace_bindings(lane_id, actor_id)
        WHERE state = 'active' AND authority = 'readOnlySnapshot';

      CREATE TABLE harness_actor_operations (
        operation_id TEXT PRIMARY KEY CHECK (
          length(operation_id) BETWEEN 16 AND 128
          AND operation_id NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        actor_id TEXT NOT NULL REFERENCES harness_actors(actor_id) ON DELETE RESTRICT,
        turn_id TEXT REFERENCES harness_actor_turns(turn_id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK (kind IN ('actorStart', 'turnStart', 'turnInterrupt')),
        request_digest TEXT NOT NULL CHECK (
          length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
        ),
        effect_key TEXT NOT NULL CHECK (
          length(effect_key) = 64 AND effect_key NOT GLOB '*[^0-9a-f]*'
        ),
        state TEXT NOT NULL CHECK (state IN (
          'prepared', 'effectStarted', 'succeeded', 'notApplied',
          'ambiguous', 'recoveryRequired'
        )),
        provider_identity_json TEXT CHECK (
          provider_identity_json IS NULL OR json_valid(provider_identity_json)
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        settled_at TEXT,
        CHECK ((state IN ('succeeded', 'notApplied', 'ambiguous', 'recoveryRequired'))
          = (settled_at IS NOT NULL))
      ) STRICT;

      CREATE TABLE harness_actor_incarnations (
        incarnation_id TEXT PRIMARY KEY CHECK (
          length(incarnation_id) BETWEEN 16 AND 96
          AND incarnation_id GLOB 'hincarnation_[A-Za-z0-9_-]*'
          AND substr(incarnation_id, 14) NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        actor_id TEXT NOT NULL REFERENCES harness_actors(actor_id) ON DELETE RESTRICT,
        ordinal INTEGER NOT NULL CHECK (ordinal > 0),
        account_profile_id TEXT NOT NULL
          REFERENCES account_profiles(profile_id) ON DELETE RESTRICT,
        process_generation INTEGER NOT NULL CHECK (process_generation > 0),
        start_operation_id TEXT NOT NULL UNIQUE
          REFERENCES harness_actor_operations(operation_id) ON DELETE RESTRICT,
        client_request_id TEXT NOT NULL CHECK (length(client_request_id) BETWEEN 16 AND 128),
        thread_source TEXT NOT NULL CHECK (length(thread_source) BETWEEN 16 AND 256),
        provider_thread_id TEXT CHECK (
          provider_thread_id IS NULL OR length(provider_thread_id) BETWEEN 1 AND 512
        ),
        toolset_digest TEXT NOT NULL CHECK (
          length(toolset_digest) = 64 AND toolset_digest NOT GLOB '*[^0-9a-f]*'
        ),
        state TEXT NOT NULL CHECK (
          state IN ('starting', 'idle', 'running', 'quarantined', 'closed')
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        UNIQUE (actor_id, ordinal),
        UNIQUE (account_profile_id, provider_thread_id),
        CHECK ((state IN ('quarantined', 'closed')) = (closed_at IS NOT NULL))
      ) STRICT;

      CREATE UNIQUE INDEX harness_actor_one_live_incarnation_idx
        ON harness_actor_incarnations(actor_id)
        WHERE state IN ('starting', 'idle', 'running');

      CREATE TABLE harness_actor_turn_attempts (
        attempt_id TEXT PRIMARY KEY CHECK (
          length(attempt_id) BETWEEN 17 AND 96
          AND attempt_id GLOB 'hattempt_[A-Za-z0-9_-]*'
          AND substr(attempt_id, 10) NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        turn_id TEXT NOT NULL REFERENCES harness_actor_turns(turn_id) ON DELETE RESTRICT,
        incarnation_id TEXT NOT NULL
          REFERENCES harness_actor_incarnations(incarnation_id) ON DELETE RESTRICT,
        ordinal INTEGER NOT NULL CHECK (ordinal > 0),
        account_profile_id TEXT NOT NULL
          REFERENCES account_profiles(profile_id) ON DELETE RESTRICT,
        process_generation INTEGER NOT NULL CHECK (process_generation > 0),
        client_user_message_id TEXT NOT NULL CHECK (
          length(client_user_message_id) BETWEEN 16 AND 128
        ),
        provider_turn_id TEXT CHECK (
          provider_turn_id IS NULL OR length(provider_turn_id) BETWEEN 1 AND 512
        ),
        state TEXT NOT NULL CHECK (state IN (
          'starting', 'running', 'reconciling', 'completed', 'failed',
          'quotaRejected', 'interrupted', 'ambiguous'
        )),
        quota_proof_digest TEXT CHECK (
          quota_proof_digest IS NULL OR (
            length(quota_proof_digest) = 64
            AND quota_proof_digest NOT GLOB '*[^0-9a-f]*'
          )
        ),
        input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
        output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
        created_at TEXT NOT NULL,
        started_at TEXT,
        settled_at TEXT,
        UNIQUE (turn_id, ordinal),
        UNIQUE (incarnation_id, provider_turn_id),
        CHECK ((state IN ('completed', 'failed', 'quotaRejected', 'interrupted', 'ambiguous'))
          = (settled_at IS NOT NULL)),
        CHECK ((state = 'quotaRejected') = (quota_proof_digest IS NOT NULL))
      ) STRICT;

      CREATE UNIQUE INDEX harness_actor_provider_turn_identity_idx
        ON harness_actor_turn_attempts(
          account_profile_id, process_generation, provider_turn_id
        ) WHERE provider_turn_id IS NOT NULL;

      CREATE TABLE harness_actor_results (
        result_id TEXT PRIMARY KEY CHECK (
          length(result_id) BETWEEN 16 AND 96
          AND result_id GLOB 'hresult_[A-Za-z0-9_-]*'
          AND substr(result_id, 9) NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        epoch_id TEXT NOT NULL
          REFERENCES harness_actor_epochs(epoch_id) ON DELETE RESTRICT,
        actor_id TEXT NOT NULL REFERENCES harness_actors(actor_id) ON DELETE RESTRICT,
        turn_id TEXT NOT NULL UNIQUE
          REFERENCES harness_actor_turns(turn_id) ON DELETE RESTRICT,
        terminal_attempt_id TEXT UNIQUE
          REFERENCES harness_actor_turn_attempts(attempt_id) ON DELETE RESTRICT,
        outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'cancelled', 'quotaRejected')),
        value_id TEXT REFERENCES harness_context_values(value_id) ON DELETE RESTRICT,
        actor_result_ordinal INTEGER NOT NULL CHECK (actor_result_ordinal > 0),
        root_completion_sequence INTEGER NOT NULL CHECK (root_completion_sequence > 0),
        created_at TEXT NOT NULL,
        UNIQUE (actor_id, actor_result_ordinal),
        UNIQUE (epoch_id, root_completion_sequence),
        CHECK ((outcome = 'succeeded') = (value_id IS NOT NULL))
      ) STRICT;

      CREATE INDEX harness_actor_results_actor_order_idx
        ON harness_actor_results(actor_id, actor_result_ordinal);
      CREATE INDEX harness_actor_results_root_order_idx
        ON harness_actor_results(epoch_id, root_completion_sequence);

      CREATE TABLE harness_actor_pane_bindings (
        binding_id TEXT PRIMARY KEY CHECK (
          length(binding_id) BETWEEN 16 AND 96
          AND binding_id GLOB 'hpanebinding_[A-Za-z0-9_-]*'
          AND substr(binding_id, 14) NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        actor_id TEXT NOT NULL REFERENCES harness_actors(actor_id) ON DELETE RESTRICT,
        pane_id TEXT NOT NULL REFERENCES chat_panes(pane_id) ON DELETE RESTRICT,
        state TEXT NOT NULL CHECK (state IN ('attached', 'detached')),
        revision INTEGER NOT NULL CHECK (revision > 0),
        attached_at TEXT NOT NULL,
        detached_at TEXT,
        CHECK ((state = 'detached') = (detached_at IS NOT NULL))
      ) STRICT;

      CREATE UNIQUE INDEX harness_actor_one_attached_pane_idx
        ON harness_actor_pane_bindings(actor_id) WHERE state = 'attached';
      CREATE UNIQUE INDEX harness_pane_one_attached_actor_idx
        ON harness_actor_pane_bindings(pane_id) WHERE state = 'attached';

      CREATE TABLE harness_actor_projection_witnesses (
        actor_id TEXT PRIMARY KEY
          REFERENCES harness_actors(actor_id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK (revision > 0),
        semantic_digest TEXT NOT NULL CHECK (
          length(semantic_digest) = 64
          AND semantic_digest NOT GLOB '*[^0-9a-f]*'
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 28,
    name: "recursive-program-admission-intents",
    sql: `
      CREATE TABLE harness_program_admission_intents (
        run_id TEXT PRIMARY KEY CHECK (
          length(run_id) BETWEEN 15 AND 96
          AND run_id GLOB 'rlmrun_[A-Za-z0-9_-]*'
          AND substr(run_id, 8) NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        epoch_id TEXT NOT NULL
          REFERENCES harness_actor_epochs(epoch_id) ON DELETE RESTRICT,
        actor_id TEXT NOT NULL
          REFERENCES harness_actors(actor_id) ON DELETE RESTRICT,
        turn_id TEXT NOT NULL
          REFERENCES harness_actor_turns(turn_id) ON DELETE RESTRICT,
        completed_prefix_value_id TEXT NOT NULL CHECK (
          length(completed_prefix_value_id) BETWEEN 16 AND 96
          AND completed_prefix_value_id GLOB 'ctxval_[A-Za-z0-9_-]*'
          AND substr(completed_prefix_value_id, 8) NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        completed_prefix_snapshot_id TEXT NOT NULL CHECK (
          length(completed_prefix_snapshot_id) BETWEEN 16 AND 96
          AND completed_prefix_snapshot_id GLOB 'ctxsnap_[A-Za-z0-9_-]*'
          AND substr(completed_prefix_snapshot_id, 9) NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        current_user_input_value_id TEXT NOT NULL
          REFERENCES harness_context_values(value_id) ON DELETE RESTRICT,
        program_digest TEXT NOT NULL CHECK (
          length(program_digest) = 64
          AND program_digest NOT GLOB '*[^0-9a-f]*'
        ),
        stable_admission_identity_digest TEXT NOT NULL CHECK (
          length(stable_admission_identity_digest) = 64
          AND stable_admission_identity_digest NOT GLOB '*[^0-9a-f]*'
        ),
        coverage_witness_digest TEXT NOT NULL CHECK (
          length(coverage_witness_digest) = 64
          AND coverage_witness_digest NOT GLOB '*[^0-9a-f]*'
        ),
        expires_at TEXT NOT NULL CHECK (
          length(expires_at) = 24 AND substr(expires_at, 24, 1) = 'Z'
        ),
        state TEXT NOT NULL CHECK (state IN (
          'prepared', 'materialized', 'admitted', 'abandoned',
          'recoveryRequired'
        )),
        recovery_reason TEXT CHECK (
          recovery_reason IS NULL OR recovery_reason IN (
            'partial_materialization', 'materialization_conflict',
            'run_lineage_conflict'
          )
        ),
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        materialized_at TEXT,
        admitted_at TEXT,
        abandoned_at TEXT,
        CHECK (expires_at > created_at),
        CHECK (updated_at >= created_at),
        CHECK ((state = 'recoveryRequired') = (recovery_reason IS NOT NULL)),
        CHECK (state NOT IN ('materialized', 'admitted')
          OR materialized_at IS NOT NULL),
        CHECK (state != 'prepared' OR materialized_at IS NULL),
        CHECK ((state = 'admitted') = (admitted_at IS NOT NULL)),
        CHECK ((state = 'abandoned') = (abandoned_at IS NOT NULL)),
        CHECK (admitted_at IS NULL OR abandoned_at IS NULL),
        CHECK (materialized_at IS NULL OR (
          materialized_at >= created_at AND materialized_at <= updated_at
        )),
        CHECK (admitted_at IS NULL OR admitted_at = updated_at),
        CHECK (abandoned_at IS NULL OR abandoned_at = updated_at)
      ) STRICT;

      CREATE INDEX harness_program_admission_intents_recovery_idx
        ON harness_program_admission_intents(state, run_id)
        WHERE state IN ('prepared', 'materialized', 'recoveryRequired');

      CREATE TRIGGER harness_program_admission_intent_insert_guard
      BEFORE INSERT ON harness_program_admission_intents
      WHEN NEW.state != 'prepared'
        OR NEW.recovery_reason IS NOT NULL
        OR NEW.revision != 1
        OR NEW.updated_at != NEW.created_at
        OR NEW.materialized_at IS NOT NULL
        OR NEW.admitted_at IS NOT NULL
        OR NEW.abandoned_at IS NOT NULL
        OR NOT EXISTS (
        SELECT 1
        FROM harness_actor_turns AS turn
        JOIN harness_actors AS actor ON actor.actor_id = NEW.actor_id
        JOIN harness_context_values AS input
          ON input.value_id = NEW.current_user_input_value_id
        WHERE turn.turn_id = NEW.turn_id
          AND turn.epoch_id = NEW.epoch_id
          AND turn.actor_id = NEW.actor_id
          AND actor.epoch_id = NEW.epoch_id
          AND input.epoch_id = NEW.epoch_id
          AND input.owner_actor_id = NEW.actor_id
          AND input.value_id = turn.input_value_id
          AND input.purpose IN ('currentInput', 'actorTask')
          AND input.state = 'active'
      )
      BEGIN
        SELECT RAISE(ABORT, 'program admission intent lineage is incoherent');
      END;

      CREATE TRIGGER harness_program_admission_intent_materialized_guard
      BEFORE UPDATE OF state ON harness_program_admission_intents
      WHEN (
        NEW.state IN ('materialized', 'admitted')
        OR (NEW.state = 'abandoned' AND NEW.materialized_at IS NOT NULL)
      )
        AND NOT EXISTS (
          SELECT 1
          FROM harness_context_values AS value
          JOIN harness_context_snapshots AS snapshot
            ON snapshot.snapshot_id = NEW.completed_prefix_snapshot_id
          WHERE value.value_id = NEW.completed_prefix_value_id
            AND value.epoch_id = NEW.epoch_id
            AND value.owner_actor_id = NEW.actor_id
            AND value.purpose = 'completedPrefix'
            AND value.kind = 'selection'
            AND value.state = 'active'
            AND snapshot.value_id = value.value_id
            AND snapshot.epoch_id = NEW.epoch_id
            AND snapshot.actor_id = NEW.actor_id
            AND snapshot.coverage_witness_digest =
              NEW.coverage_witness_digest
            AND snapshot.completed_through_turn_id IS value.source_turn_id
            AND snapshot.expires_at = NEW.expires_at
        )
      BEGIN
        SELECT RAISE(ABORT, 'materialized program admission intent is incoherent');
      END;

      CREATE TRIGGER harness_program_admission_intent_admitted_guard
      BEFORE UPDATE OF state ON harness_program_admission_intents
      WHEN NEW.state = 'admitted' AND NOT EXISTS (
        SELECT 1 FROM harness_program_runs AS run
        WHERE run.run_id = NEW.run_id
          AND run.epoch_id = NEW.epoch_id
          AND run.actor_id = NEW.actor_id
          AND run.turn_id = NEW.turn_id
          AND run.program_digest = NEW.program_digest
          AND run.completed_prefix_snapshot_id =
            NEW.completed_prefix_snapshot_id
          AND run.current_user_input_value_id =
            NEW.current_user_input_value_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'admitted program intent lacks its exact run');
      END;

      CREATE TRIGGER harness_program_admission_intent_transition_guard
      BEFORE UPDATE ON harness_program_admission_intents
      WHEN NEW.revision != OLD.revision + 1
        OR NEW.updated_at < OLD.updated_at
        OR NOT (
          (OLD.state = 'prepared' AND NEW.state IN (
            'materialized', 'admitted', 'abandoned', 'recoveryRequired'
          ))
          OR (OLD.state = 'materialized' AND NEW.state IN (
            'admitted', 'abandoned', 'recoveryRequired'
          ))
        )
        OR (
          OLD.state = 'prepared' AND NEW.state = 'materialized'
          AND NOT (
            NEW.materialized_at = NEW.updated_at
            AND NEW.admitted_at IS NULL
            AND NEW.abandoned_at IS NULL
            AND NEW.recovery_reason IS NULL
          )
        )
        OR (
          OLD.state = 'prepared' AND NEW.state = 'admitted'
          AND NOT (
            NEW.materialized_at = NEW.updated_at
            AND NEW.admitted_at = NEW.updated_at
            AND NEW.abandoned_at IS NULL
            AND NEW.recovery_reason IS NULL
          )
        )
        OR (
          OLD.state = 'prepared' AND NEW.state = 'abandoned'
          AND NOT (
            NEW.materialized_at IS NULL
            AND NEW.admitted_at IS NULL
            AND NEW.abandoned_at = NEW.updated_at
            AND NEW.recovery_reason IS NULL
          )
        )
        OR (
          OLD.state = 'prepared' AND NEW.state = 'recoveryRequired'
          AND NOT (
            NEW.materialized_at IS NULL
            AND NEW.admitted_at IS NULL
            AND NEW.abandoned_at IS NULL
            AND NEW.recovery_reason IS NOT NULL
          )
        )
        OR (
          OLD.state = 'materialized'
          AND NEW.materialized_at IS NOT OLD.materialized_at
        )
        OR (
          OLD.state = 'materialized' AND NEW.state = 'admitted'
          AND NOT (
            NEW.admitted_at = NEW.updated_at
            AND NEW.abandoned_at IS NULL
            AND NEW.recovery_reason IS NULL
          )
        )
        OR (
          OLD.state = 'materialized' AND NEW.state = 'abandoned'
          AND NOT (
            NEW.admitted_at IS NULL
            AND NEW.abandoned_at = NEW.updated_at
            AND NEW.recovery_reason IS NULL
          )
        )
        OR (
          OLD.state = 'materialized' AND NEW.state = 'recoveryRequired'
          AND NOT (
            NEW.admitted_at IS NULL
            AND NEW.abandoned_at IS NULL
            AND NEW.recovery_reason IS NOT NULL
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'program admission intent transition is incoherent');
      END;

      CREATE TRIGGER harness_program_admission_intent_immutable_guard
      BEFORE UPDATE OF
        run_id, epoch_id, actor_id, turn_id, completed_prefix_value_id,
        completed_prefix_snapshot_id, current_user_input_value_id,
        program_digest, stable_admission_identity_digest,
        coverage_witness_digest, expires_at, created_at
      ON harness_program_admission_intents
      WHEN NEW.run_id != OLD.run_id
        OR NEW.epoch_id != OLD.epoch_id
        OR NEW.actor_id != OLD.actor_id
        OR NEW.turn_id != OLD.turn_id
        OR NEW.completed_prefix_value_id != OLD.completed_prefix_value_id
        OR NEW.completed_prefix_snapshot_id != OLD.completed_prefix_snapshot_id
        OR NEW.current_user_input_value_id != OLD.current_user_input_value_id
        OR NEW.program_digest != OLD.program_digest
        OR NEW.stable_admission_identity_digest !=
          OLD.stable_admission_identity_digest
        OR NEW.coverage_witness_digest != OLD.coverage_witness_digest
        OR NEW.expires_at != OLD.expires_at
        OR NEW.created_at != OLD.created_at
      BEGIN
        SELECT RAISE(ABORT, 'program admission intent identity is immutable');
      END;
    `,
  },
  {
    version: 29,
    name: "program-admission-recovery-evidence",
    sql: `
      ALTER TABLE harness_program_runs
        ADD COLUMN lifecycle_checkpoint INTEGER NOT NULL DEFAULT 0
          CHECK (
            lifecycle_checkpoint = 0 OR (
              lifecycle_checkpoint = 1
              AND desired_state = 'run'
              AND state IN ('prepared', 'running', 'suspended')
            )
          );

      ALTER TABLE harness_program_admission_intents
        ADD COLUMN completed_prefix_content_digest TEXT CHECK (
          completed_prefix_content_digest IS NULL OR (
            length(completed_prefix_content_digest) = 64
            AND completed_prefix_content_digest NOT GLOB '*[^0-9a-f]*'
          )
        );
      ALTER TABLE harness_program_admission_intents
        ADD COLUMN completed_through_turn_id TEXT
          REFERENCES harness_actor_turns(turn_id) ON DELETE RESTRICT;

      DROP TRIGGER harness_program_admission_intent_insert_guard;
      DROP TRIGGER harness_program_admission_intent_materialized_guard;
      DROP TRIGGER harness_program_admission_intent_admitted_guard;
      DROP TRIGGER harness_program_admission_intent_transition_guard;
      DROP TRIGGER harness_program_admission_intent_immutable_guard;

      UPDATE harness_program_admission_intents
      SET state = 'recoveryRequired',
          recovery_reason = 'partial_materialization',
          revision = revision + 1,
          admitted_at = NULL,
          abandoned_at = NULL
      WHERE state != 'recoveryRequired';

      UPDATE harness_program_operation_receipts
      SET state = 'recoveryRequired',
          result_value_id = NULL,
          error_json = '{"code":"admission_evidence_missing","retryable":false}',
          settled_at = updated_at
      WHERE state IN ('prepared', 'effectStarted', 'replayRequired')
        AND run_id IN (
          SELECT run_id FROM harness_program_runs
          WHERE state IN ('prepared', 'running', 'suspended')
        );

      UPDATE harness_program_runs
      SET desired_state = 'stop',
          state = 'recoveryRequired',
          terminal_result_value_id = NULL,
          terminal_code = 'admission_evidence_missing',
          revision = revision + 1,
          settled_at = updated_at
      WHERE state IN ('prepared', 'running', 'suspended');

      CREATE TRIGGER harness_program_admission_intent_insert_guard
      BEFORE INSERT ON harness_program_admission_intents
      WHEN NEW.state != 'prepared'
        OR NEW.recovery_reason IS NOT NULL
        OR NEW.revision != 1
        OR NEW.updated_at != NEW.created_at
        OR NEW.materialized_at IS NOT NULL
        OR NEW.admitted_at IS NOT NULL
        OR NEW.abandoned_at IS NOT NULL
        OR NEW.completed_prefix_content_digest IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM harness_actor_turns AS turn
          JOIN harness_actors AS actor ON actor.actor_id = NEW.actor_id
          JOIN harness_context_values AS input
            ON input.value_id = NEW.current_user_input_value_id
          WHERE turn.turn_id = NEW.turn_id
            AND turn.epoch_id = NEW.epoch_id
            AND turn.actor_id = NEW.actor_id
            AND actor.epoch_id = NEW.epoch_id
            AND input.epoch_id = NEW.epoch_id
            AND input.owner_actor_id = NEW.actor_id
            AND input.value_id = turn.input_value_id
            AND input.purpose IN ('currentInput', 'actorTask')
            AND input.state = 'active'
            AND (
              NEW.completed_through_turn_id IS NULL
              OR EXISTS (
                SELECT 1 FROM harness_actor_turns AS previous_turn
                WHERE previous_turn.turn_id = NEW.completed_through_turn_id
                  AND previous_turn.epoch_id = NEW.epoch_id
                  AND previous_turn.actor_id = NEW.actor_id
                  AND previous_turn.ordinal = turn.ordinal - 1
                  AND previous_turn.state = 'succeeded'
              )
            )
        )
      BEGIN
        SELECT RAISE(ABORT, 'program admission intent lineage is incoherent');
      END;

      CREATE TRIGGER harness_program_admission_intent_materialized_guard
      BEFORE UPDATE OF state ON harness_program_admission_intents
      WHEN (
        NEW.state IN ('materialized', 'admitted')
        OR (NEW.state = 'abandoned' AND NEW.materialized_at IS NOT NULL)
      )
        AND NOT EXISTS (
          SELECT 1
          FROM harness_context_values AS value
          JOIN harness_context_snapshots AS snapshot
            ON snapshot.snapshot_id = NEW.completed_prefix_snapshot_id
          WHERE value.value_id = NEW.completed_prefix_value_id
            AND value.epoch_id = NEW.epoch_id
            AND value.owner_actor_id = NEW.actor_id
            AND value.purpose = 'completedPrefix'
            AND value.kind = 'selection'
            AND value.state = 'active'
            AND value.content_digest =
              NEW.completed_prefix_content_digest
            AND snapshot.value_id = value.value_id
            AND snapshot.epoch_id = NEW.epoch_id
            AND snapshot.actor_id = NEW.actor_id
            AND snapshot.coverage_witness_digest =
              NEW.coverage_witness_digest
            AND snapshot.completed_through_turn_id IS
              NEW.completed_through_turn_id
            AND snapshot.completed_through_turn_id IS value.source_turn_id
            AND snapshot.expires_at = NEW.expires_at
        )
      BEGIN
        SELECT RAISE(ABORT, 'materialized program admission intent is incoherent');
      END;

      CREATE TRIGGER harness_program_admission_intent_admitted_guard
      BEFORE UPDATE OF state ON harness_program_admission_intents
      WHEN NEW.state = 'admitted' AND NOT EXISTS (
        SELECT 1 FROM harness_program_runs AS run
        WHERE run.run_id = NEW.run_id
          AND run.epoch_id = NEW.epoch_id
          AND run.actor_id = NEW.actor_id
          AND run.turn_id = NEW.turn_id
          AND run.program_digest = NEW.program_digest
          AND run.completed_prefix_snapshot_id =
            NEW.completed_prefix_snapshot_id
          AND run.current_user_input_value_id =
            NEW.current_user_input_value_id
          AND run.deadline = NEW.expires_at
      )
      BEGIN
        SELECT RAISE(ABORT, 'admitted program intent lacks its exact run');
      END;

      CREATE TRIGGER harness_program_admission_intent_transition_guard
      BEFORE UPDATE ON harness_program_admission_intents
      WHEN NEW.revision != OLD.revision + 1
        OR NEW.updated_at < OLD.updated_at
        OR NOT (
          (OLD.state = 'prepared' AND NEW.state IN (
            'materialized', 'admitted', 'abandoned', 'recoveryRequired'
          ))
          OR (OLD.state = 'materialized' AND NEW.state IN (
            'admitted', 'abandoned', 'recoveryRequired'
          ))
        )
        OR (
          OLD.state = 'prepared' AND NEW.state = 'materialized'
          AND NOT (
            NEW.materialized_at = NEW.updated_at
            AND NEW.admitted_at IS NULL
            AND NEW.abandoned_at IS NULL
            AND NEW.recovery_reason IS NULL
          )
        )
        OR (
          OLD.state = 'prepared' AND NEW.state = 'admitted'
          AND NOT (
            NEW.materialized_at = NEW.updated_at
            AND NEW.admitted_at = NEW.updated_at
            AND NEW.abandoned_at IS NULL
            AND NEW.recovery_reason IS NULL
          )
        )
        OR (
          OLD.state = 'prepared' AND NEW.state = 'abandoned'
          AND NOT (
            NEW.materialized_at IS NULL
            AND NEW.admitted_at IS NULL
            AND NEW.abandoned_at = NEW.updated_at
            AND NEW.recovery_reason IS NULL
          )
        )
        OR (
          OLD.state = 'prepared' AND NEW.state = 'recoveryRequired'
          AND NOT (
            NEW.materialized_at IS NULL
            AND NEW.admitted_at IS NULL
            AND NEW.abandoned_at IS NULL
            AND NEW.recovery_reason IS NOT NULL
          )
        )
        OR (
          OLD.state = 'materialized'
          AND NEW.materialized_at IS NOT OLD.materialized_at
        )
        OR (
          OLD.state = 'materialized' AND NEW.state = 'admitted'
          AND NOT (
            NEW.admitted_at = NEW.updated_at
            AND NEW.abandoned_at IS NULL
            AND NEW.recovery_reason IS NULL
          )
        )
        OR (
          OLD.state = 'materialized' AND NEW.state = 'abandoned'
          AND NOT (
            NEW.admitted_at IS NULL
            AND NEW.abandoned_at = NEW.updated_at
            AND NEW.recovery_reason IS NULL
          )
        )
        OR (
          OLD.state = 'materialized' AND NEW.state = 'recoveryRequired'
          AND NOT (
            NEW.admitted_at IS NULL
            AND NEW.abandoned_at IS NULL
            AND NEW.recovery_reason IS NOT NULL
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'program admission intent transition is incoherent');
      END;

      CREATE TRIGGER harness_program_admission_intent_immutable_guard
      BEFORE UPDATE OF
        run_id, epoch_id, actor_id, turn_id, completed_prefix_value_id,
        completed_prefix_content_digest, completed_prefix_snapshot_id,
        completed_through_turn_id, current_user_input_value_id,
        program_digest, stable_admission_identity_digest,
        coverage_witness_digest, expires_at, created_at
      ON harness_program_admission_intents
      WHEN NEW.run_id != OLD.run_id
        OR NEW.epoch_id != OLD.epoch_id
        OR NEW.actor_id != OLD.actor_id
        OR NEW.turn_id != OLD.turn_id
        OR NEW.completed_prefix_value_id != OLD.completed_prefix_value_id
        OR NEW.completed_prefix_content_digest IS NOT
          OLD.completed_prefix_content_digest
        OR NEW.completed_prefix_snapshot_id != OLD.completed_prefix_snapshot_id
        OR NEW.completed_through_turn_id IS NOT OLD.completed_through_turn_id
        OR NEW.current_user_input_value_id != OLD.current_user_input_value_id
        OR NEW.program_digest != OLD.program_digest
        OR NEW.stable_admission_identity_digest !=
          OLD.stable_admission_identity_digest
        OR NEW.coverage_witness_digest != OLD.coverage_witness_digest
        OR NEW.expires_at != OLD.expires_at
        OR NEW.created_at != OLD.created_at
      BEGIN
        SELECT RAISE(ABORT, 'program admission intent identity is immutable');
      END;

      UPDATE harness_actor_turn_attempts
      SET state = 'ambiguous', settled_at = COALESCE(started_at, created_at)
      WHERE state IN ('starting', 'running', 'reconciling')
        AND incarnation_id IN (
          SELECT incarnation_id FROM harness_actor_incarnations
          WHERE state IN ('starting', 'idle', 'running')
        );

      UPDATE harness_actor_incarnations
      SET state = 'quarantined', closed_at = updated_at
      WHERE state IN ('starting', 'idle', 'running');

      CREATE TABLE harness_actor_session_bindings (
        incarnation_id TEXT PRIMARY KEY
          REFERENCES harness_actor_incarnations(incarnation_id) ON DELETE RESTRICT,
        actor_id TEXT NOT NULL
          REFERENCES harness_actors(actor_id) ON DELETE RESTRICT,
        workspace_binding_id TEXT NOT NULL
          REFERENCES harness_actor_workspace_bindings(binding_id) ON DELETE RESTRICT,
        account_profile_id TEXT NOT NULL
          REFERENCES account_profiles(profile_id) ON DELETE RESTRICT,
        admission_generation INTEGER NOT NULL CHECK (admission_generation > 0),
        live_generation INTEGER NOT NULL CHECK (
          live_generation >= admission_generation
        ),
        provider_thread_id TEXT NOT NULL CHECK (
          length(provider_thread_id) BETWEEN 1 AND 512
          AND instr(provider_thread_id, char(0)) = 0
        ),
        thread_source TEXT NOT NULL CHECK (
          length(thread_source) BETWEEN 16 AND 256
          AND instr(thread_source, char(0)) = 0
        ),
        recovery_proof_digest TEXT NOT NULL UNIQUE CHECK (
          length(recovery_proof_digest) = 64
          AND recovery_proof_digest NOT GLOB '*[^0-9a-f]*'
        ),
        prior_recovery_proof_digest TEXT CHECK (
          prior_recovery_proof_digest IS NULL OR (
            length(prior_recovery_proof_digest) = 64
            AND prior_recovery_proof_digest NOT GLOB '*[^0-9a-f]*'
          )
        ),
        history_evidence_digest TEXT NOT NULL CHECK (
          length(history_evidence_digest) = 64
          AND history_evidence_digest NOT GLOB '*[^0-9a-f]*'
        ),
        first_observation_position INTEGER NOT NULL CHECK (
          first_observation_position BETWEEN 0 AND 9007199254740991
        ),
        second_observation_position INTEGER NOT NULL CHECK (
          second_observation_position > first_observation_position
          AND second_observation_position BETWEEN 1 AND 9007199254740991
        ),
        history_turn_count INTEGER NOT NULL CHECK (
          history_turn_count BETWEEN 0 AND 10000
        ),
        history_item_count INTEGER NOT NULL CHECK (
          history_item_count BETWEEN 0 AND 100000
        ),
        state TEXT NOT NULL CHECK (
          state IN ('bound', 'retired', 'quarantined')
        ),
        quarantine_reason TEXT CHECK (
          quarantine_reason IS NULL OR quarantine_reason IN (
            'provider_identity_mismatch', 'thread_source_mismatch',
            'workspace_mismatch', 'sandbox_mismatch', 'history_unstable',
            'actor_ownership_conflict', 'generation_regression',
            'token_evidence_regression', 'recovery_protocol_error'
          )
        ),
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        recovered_at TEXT,
        retired_at TEXT,
        quarantined_at TEXT,
        CHECK ((state = 'quarantined') = (quarantine_reason IS NOT NULL)),
        CHECK ((state = 'quarantined') = (quarantined_at IS NOT NULL)),
        CHECK ((state = 'retired') = (retired_at IS NOT NULL)),
        CHECK (updated_at >= created_at),
        CHECK (recovered_at IS NULL OR (
          recovered_at >= created_at AND recovered_at <= updated_at
        )),
        CHECK (retired_at IS NULL OR retired_at = updated_at),
        CHECK (quarantined_at IS NULL OR quarantined_at = updated_at)
      ) STRICT;

      CREATE INDEX harness_actor_session_recovery_idx
        ON harness_actor_session_bindings(state, incarnation_id)
        WHERE state = 'bound';

      CREATE TRIGGER harness_actor_session_binding_insert_guard
      BEFORE INSERT ON harness_actor_session_bindings
      WHEN NEW.state != 'bound'
        OR NEW.quarantine_reason IS NOT NULL
        OR NEW.retired_at IS NOT NULL
        OR NEW.quarantined_at IS NOT NULL
        OR NEW.revision != 1
        OR NEW.updated_at != NEW.created_at
        OR NEW.prior_recovery_proof_digest IS NOT NULL
        OR NOT EXISTS (
          SELECT 1
          FROM harness_actor_incarnations AS incarnation
          JOIN account_profiles AS account
            ON account.profile_id = NEW.account_profile_id
          JOIN harness_actor_workspace_bindings AS workspace
            ON workspace.binding_id = NEW.workspace_binding_id
          WHERE incarnation.incarnation_id = NEW.incarnation_id
            AND incarnation.actor_id = NEW.actor_id
            AND incarnation.account_profile_id = NEW.account_profile_id
            AND incarnation.process_generation = NEW.admission_generation
            AND account.process_generation = NEW.live_generation
            AND account.auth_state = 'signed_in'
            AND incarnation.provider_thread_id = NEW.provider_thread_id
            AND incarnation.thread_source = NEW.thread_source
            AND incarnation.state IN ('idle', 'running')
            AND workspace.actor_id = NEW.actor_id
            AND workspace.state = 'active'
        )
      BEGIN
        SELECT RAISE(ABORT, 'actor session binding lineage is incoherent');
      END;

      CREATE TRIGGER harness_actor_session_binding_transition_guard
      BEFORE UPDATE ON harness_actor_session_bindings
      WHEN NEW.revision != OLD.revision + 1
        OR NEW.updated_at < OLD.updated_at
        OR OLD.state != 'bound'
        OR NOT (
          (NEW.state = 'bound'
            AND NEW.live_generation >= OLD.live_generation
            AND NEW.recovery_proof_digest != OLD.recovery_proof_digest
            AND NEW.prior_recovery_proof_digest = OLD.recovery_proof_digest
            AND NEW.recovered_at = NEW.updated_at
            AND NEW.quarantine_reason IS NULL
            AND NEW.retired_at IS NULL
            AND NEW.quarantined_at IS NULL)
          OR
          (NEW.state = 'retired'
            AND NEW.live_generation = OLD.live_generation
            AND NEW.recovery_proof_digest = OLD.recovery_proof_digest
            AND NEW.prior_recovery_proof_digest IS
              OLD.prior_recovery_proof_digest
            AND NEW.history_evidence_digest = OLD.history_evidence_digest
            AND NEW.first_observation_position =
              OLD.first_observation_position
            AND NEW.second_observation_position =
              OLD.second_observation_position
            AND NEW.history_turn_count = OLD.history_turn_count
            AND NEW.history_item_count = OLD.history_item_count
            AND NEW.recovered_at IS OLD.recovered_at
            AND NEW.quarantine_reason IS NULL
            AND NEW.retired_at = NEW.updated_at
            AND NEW.quarantined_at IS NULL)
          OR
          (NEW.state = 'quarantined'
            AND NEW.live_generation = OLD.live_generation
            AND NEW.recovery_proof_digest = OLD.recovery_proof_digest
            AND NEW.prior_recovery_proof_digest IS
              OLD.prior_recovery_proof_digest
            AND NEW.history_evidence_digest = OLD.history_evidence_digest
            AND NEW.first_observation_position =
              OLD.first_observation_position
            AND NEW.second_observation_position =
              OLD.second_observation_position
            AND NEW.history_turn_count = OLD.history_turn_count
            AND NEW.history_item_count = OLD.history_item_count
            AND NEW.recovered_at IS OLD.recovered_at
            AND NEW.quarantine_reason IS NOT NULL
            AND NEW.retired_at IS NULL
            AND NEW.quarantined_at = NEW.updated_at)
        )
      BEGIN
        SELECT RAISE(ABORT, 'actor session binding transition is incoherent');
      END;

      CREATE TRIGGER harness_actor_session_binding_identity_guard
      BEFORE UPDATE OF
        incarnation_id, actor_id, workspace_binding_id, account_profile_id,
        admission_generation, provider_thread_id, thread_source, created_at
      ON harness_actor_session_bindings
      WHEN NEW.incarnation_id != OLD.incarnation_id
        OR NEW.actor_id != OLD.actor_id
        OR NEW.workspace_binding_id != OLD.workspace_binding_id
        OR NEW.account_profile_id != OLD.account_profile_id
        OR NEW.admission_generation != OLD.admission_generation
        OR NEW.provider_thread_id != OLD.provider_thread_id
        OR NEW.thread_source != OLD.thread_source
        OR NEW.created_at != OLD.created_at
      BEGIN
        SELECT RAISE(ABORT, 'actor session binding identity is immutable');
      END;

      CREATE TRIGGER harness_actor_session_binding_delete_guard
      BEFORE DELETE ON harness_actor_session_bindings
      BEGIN
        SELECT RAISE(ABORT, 'actor session binding evidence is append-only');
      END;

      ALTER TABLE harness_actor_incarnations
        ADD COLUMN token_usage_latest_position INTEGER CHECK (
          token_usage_latest_position IS NULL OR
          token_usage_latest_position BETWEEN 0 AND 9007199254740991
        );
      ALTER TABLE harness_actor_incarnations
        ADD COLUMN token_usage_cumulative_input_tokens INTEGER NOT NULL
          DEFAULT 0 CHECK (
            token_usage_cumulative_input_tokens
              BETWEEN 0 AND 9007199254740991
          );
      ALTER TABLE harness_actor_incarnations
        ADD COLUMN token_usage_cumulative_output_tokens INTEGER NOT NULL
          DEFAULT 0 CHECK (
            token_usage_cumulative_output_tokens
              BETWEEN 0 AND 9007199254740991
          );
      ALTER TABLE harness_actor_incarnations
        ADD COLUMN token_usage_observation_generation INTEGER CHECK (
          token_usage_observation_generation IS NULL OR
          token_usage_observation_generation > 0
        );

      UPDATE harness_actor_incarnations
      SET token_usage_observation_generation = process_generation;

      CREATE TRIGGER harness_actor_incarnation_usage_guard
      BEFORE UPDATE OF
        token_usage_observation_generation,
        token_usage_latest_position,
        token_usage_cumulative_input_tokens,
        token_usage_cumulative_output_tokens
      ON harness_actor_incarnations
      WHEN (
        NEW.provider_thread_id IS NULL
        OR NEW.token_usage_observation_generation IS NULL
        OR (
          NEW.token_usage_latest_position IS NULL AND (
            NEW.token_usage_cumulative_input_tokens != 0
            OR NEW.token_usage_cumulative_output_tokens != 0
          )
        )
        OR NEW.token_usage_observation_generation <
          OLD.token_usage_observation_generation
        OR NEW.token_usage_cumulative_input_tokens <
          OLD.token_usage_cumulative_input_tokens
        OR NEW.token_usage_cumulative_output_tokens <
          OLD.token_usage_cumulative_output_tokens
        OR (
          NEW.token_usage_observation_generation =
            OLD.token_usage_observation_generation
          AND OLD.token_usage_latest_position IS NOT NULL
          AND (
            NEW.token_usage_latest_position IS NULL
            OR NEW.token_usage_latest_position <=
              OLD.token_usage_latest_position
          )
        )
        OR (
          NEW.token_usage_observation_generation >
            OLD.token_usage_observation_generation
          AND NOT EXISTS (
            SELECT 1 FROM harness_actor_session_bindings AS binding
            WHERE binding.incarnation_id = NEW.incarnation_id
              AND binding.state = 'bound'
              AND binding.admission_generation = NEW.process_generation
              AND binding.live_generation =
                NEW.token_usage_observation_generation
          )
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'actor thread token watermark is incoherent');
      END;

      ALTER TABLE harness_actor_turn_attempts
        ADD COLUMN token_usage_identity_digest TEXT CHECK (
          token_usage_identity_digest IS NULL OR (
            length(token_usage_identity_digest) = 64
            AND token_usage_identity_digest NOT GLOB '*[^0-9a-f]*'
          )
        );
      ALTER TABLE harness_actor_turn_attempts
        ADD COLUMN token_usage_stream_position INTEGER CHECK (
          token_usage_stream_position IS NULL OR
          token_usage_stream_position BETWEEN 0 AND 9007199254740991
        );
      ALTER TABLE harness_actor_turn_attempts
        ADD COLUMN token_usage_cumulative_input_tokens INTEGER CHECK (
          token_usage_cumulative_input_tokens IS NULL OR
          token_usage_cumulative_input_tokens
            BETWEEN 0 AND 9007199254740991
        );
      ALTER TABLE harness_actor_turn_attempts
        ADD COLUMN token_usage_cumulative_output_tokens INTEGER CHECK (
          token_usage_cumulative_output_tokens IS NULL OR
          token_usage_cumulative_output_tokens
            BETWEEN 0 AND 9007199254740991
          );
      ALTER TABLE harness_actor_turn_attempts
        ADD COLUMN token_usage_observation_generation INTEGER CHECK (
          token_usage_observation_generation IS NULL OR
          token_usage_observation_generation > 0
        );
      ALTER TABLE harness_actor_turn_attempts
        ADD COLUMN continuation_history_value_id TEXT
          REFERENCES harness_context_values(value_id) ON DELETE RESTRICT;

      CREATE TRIGGER harness_actor_turn_attempt_usage_insert_guard
      BEFORE INSERT ON harness_actor_turn_attempts
      WHEN NEW.token_usage_identity_digest IS NOT NULL
        OR NEW.token_usage_observation_generation IS NOT NULL
        OR NEW.token_usage_stream_position IS NOT NULL
        OR NEW.token_usage_cumulative_input_tokens IS NOT NULL
        OR NEW.token_usage_cumulative_output_tokens IS NOT NULL
        OR NEW.input_tokens IS NOT NULL
        OR NEW.output_tokens IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'new actor attempt cannot contain token usage');
      END;

      CREATE TRIGGER harness_actor_turn_attempt_continuation_insert_guard
      BEFORE INSERT ON harness_actor_turn_attempts
      WHEN NEW.continuation_history_value_id IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'new actor attempt cannot contain continuation history');
      END;

      CREATE TRIGGER harness_actor_turn_attempt_continuation_guard
      BEFORE UPDATE OF continuation_history_value_id
      ON harness_actor_turn_attempts
      WHEN OLD.continuation_history_value_id IS NOT NULL
        OR NEW.continuation_history_value_id IS NULL
        OR NEW.provider_turn_id IS NULL
        OR NEW.state NOT IN ('running', 'reconciling')
        OR NOT EXISTS (
          SELECT 1
          FROM harness_actor_turns AS turn
          JOIN harness_context_values AS value
            ON value.value_id = NEW.continuation_history_value_id
          WHERE turn.turn_id = NEW.turn_id
            AND value.epoch_id = turn.epoch_id
            AND value.owner_actor_id = turn.actor_id
            AND value.source_turn_id = turn.turn_id
            AND value.kind = 'selection'
            AND value.purpose = 'completedPrefix'
            AND value.state = 'active'
        )
      BEGIN
        SELECT RAISE(ABORT, 'actor continuation history lineage is incoherent');
      END;

      CREATE TRIGGER harness_actor_turn_attempt_continuation_terminal_guard
      BEFORE UPDATE OF state ON harness_actor_turn_attempts
      WHEN (
        NEW.state = 'quotaRejected'
        AND NEW.provider_turn_id IS NOT NULL
        AND NEW.continuation_history_value_id IS NULL
      ) OR (
        NEW.continuation_history_value_id IS NOT NULL
        AND NEW.state IN ('completed', 'failed', 'interrupted', 'ambiguous')
      )
      BEGIN
        SELECT RAISE(ABORT, 'actor continuation history terminal state is incoherent');
      END;

      CREATE TRIGGER harness_actor_turn_attempt_usage_guard
      BEFORE UPDATE OF
        token_usage_identity_digest, token_usage_observation_generation,
        token_usage_stream_position,
        token_usage_cumulative_input_tokens,
        token_usage_cumulative_output_tokens,
        input_tokens, output_tokens
      ON harness_actor_turn_attempts
      WHEN (
        (NEW.token_usage_identity_digest IS NULL) !=
          (NEW.token_usage_observation_generation IS NULL)
        OR (NEW.token_usage_identity_digest IS NULL) !=
          (NEW.token_usage_stream_position IS NULL)
        OR (NEW.token_usage_identity_digest IS NULL) !=
          (NEW.token_usage_cumulative_input_tokens IS NULL)
        OR (NEW.token_usage_identity_digest IS NULL) !=
          (NEW.token_usage_cumulative_output_tokens IS NULL)
        OR (NEW.token_usage_identity_digest IS NULL) !=
          (NEW.input_tokens IS NULL)
        OR (NEW.token_usage_identity_digest IS NULL) !=
          (NEW.output_tokens IS NULL)
        OR (
          OLD.token_usage_stream_position IS NOT NULL AND (
            NEW.token_usage_identity_digest !=
              OLD.token_usage_identity_digest
            OR NEW.token_usage_observation_generation <
              OLD.token_usage_observation_generation
            OR NEW.token_usage_cumulative_input_tokens <
              OLD.token_usage_cumulative_input_tokens
            OR NEW.token_usage_cumulative_output_tokens <
              OLD.token_usage_cumulative_output_tokens
            OR NEW.input_tokens < OLD.input_tokens
            OR NEW.output_tokens < OLD.output_tokens
            OR (
              NEW.token_usage_observation_generation =
                OLD.token_usage_observation_generation
              AND NEW.token_usage_stream_position =
                OLD.token_usage_stream_position
              AND (
                NEW.token_usage_cumulative_input_tokens !=
                  OLD.token_usage_cumulative_input_tokens
                OR NEW.token_usage_cumulative_output_tokens !=
                  OLD.token_usage_cumulative_output_tokens
                OR
                NEW.input_tokens != OLD.input_tokens
                OR NEW.output_tokens != OLD.output_tokens
              )
            )
            OR (
              NEW.token_usage_observation_generation =
                OLD.token_usage_observation_generation
              AND NEW.token_usage_stream_position <
                OLD.token_usage_stream_position
            )
            OR (
              NEW.token_usage_observation_generation >
                OLD.token_usage_observation_generation
              AND NOT EXISTS (
                SELECT 1 FROM harness_actor_session_bindings AS binding
                WHERE binding.incarnation_id = NEW.incarnation_id
                  AND binding.state = 'bound'
                  AND binding.live_generation >=
                    NEW.token_usage_observation_generation
              )
            )
            OR NEW.input_tokens - OLD.input_tokens !=
              NEW.token_usage_cumulative_input_tokens -
                OLD.token_usage_cumulative_input_tokens
            OR NEW.output_tokens - OLD.output_tokens !=
              NEW.token_usage_cumulative_output_tokens -
                OLD.token_usage_cumulative_output_tokens
          )
        )
        OR (
          OLD.token_usage_identity_digest IS NULL
          AND NEW.token_usage_identity_digest IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM harness_actor_incarnations AS incarnation
            WHERE incarnation.incarnation_id = NEW.incarnation_id
              AND (
                incarnation.token_usage_latest_position IS NULL
                OR NEW.token_usage_observation_generation >
                  incarnation.token_usage_observation_generation
                OR (
                  NEW.token_usage_observation_generation =
                    incarnation.token_usage_observation_generation
                  AND NEW.token_usage_stream_position >
                    incarnation.token_usage_latest_position
                )
              )
              AND NEW.token_usage_cumulative_input_tokens >=
                incarnation.token_usage_cumulative_input_tokens
              AND NEW.token_usage_cumulative_output_tokens >=
                incarnation.token_usage_cumulative_output_tokens
              AND NEW.input_tokens =
                NEW.token_usage_cumulative_input_tokens -
                  incarnation.token_usage_cumulative_input_tokens
              AND NEW.output_tokens =
                NEW.token_usage_cumulative_output_tokens -
                  incarnation.token_usage_cumulative_output_tokens
          )
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'actor attempt token usage is incoherent');
      END;

      CREATE TABLE harness_actor_turn_usage_inbox (
        attempt_id TEXT PRIMARY KEY
          REFERENCES harness_actor_turn_attempts(attempt_id) ON DELETE RESTRICT,
        provider_identity_digest TEXT NOT NULL UNIQUE CHECK (
          length(provider_identity_digest) = 64
          AND provider_identity_digest NOT GLOB '*[^0-9a-f]*'
        ),
        observation_generation INTEGER NOT NULL CHECK (
          observation_generation > 0
        ),
        stream_position INTEGER NOT NULL CHECK (
          stream_position BETWEEN 0 AND 9007199254740991
        ),
        cumulative_input_tokens INTEGER NOT NULL CHECK (
          cumulative_input_tokens BETWEEN 0 AND 9007199254740991
        ),
        cumulative_output_tokens INTEGER NOT NULL CHECK (
          cumulative_output_tokens BETWEEN 0 AND 9007199254740991
        ),
        quarantined INTEGER NOT NULL DEFAULT 0 CHECK (quarantined IN (0, 1)),
        quarantine_reason TEXT CHECK (
          quarantine_reason IS NULL OR length(quarantine_reason) BETWEEN 1 AND 96
        ),
        CHECK ((quarantined = 1) = (quarantine_reason IS NOT NULL))
      ) STRICT;

      CREATE TRIGGER harness_actor_turn_usage_inbox_insert_guard
      BEFORE INSERT ON harness_actor_turn_usage_inbox
      WHEN NOT EXISTS (
        SELECT 1
        FROM harness_actor_turn_attempts AS attempt
        JOIN harness_actor_incarnations AS incarnation
          ON incarnation.incarnation_id = attempt.incarnation_id
        WHERE attempt.attempt_id = NEW.attempt_id
          AND NEW.quarantined = 0
          AND NEW.quarantine_reason IS NULL
          AND (
            (
              attempt.provider_turn_id IS NULL
              AND attempt.token_usage_identity_digest IS NULL
              AND attempt.token_usage_observation_generation IS NULL
              AND attempt.token_usage_stream_position IS NULL
              AND attempt.token_usage_cumulative_input_tokens IS NULL
              AND attempt.token_usage_cumulative_output_tokens IS NULL
              AND attempt.input_tokens IS NULL
              AND attempt.output_tokens IS NULL
              AND attempt.state IN ('starting', 'reconciling')
            )
            OR (
              attempt.provider_turn_id IS NOT NULL
              AND attempt.state IN ('starting', 'running', 'reconciling')
              AND EXISTS (
                SELECT 1
                FROM harness_actor_session_bindings AS session
                JOIN account_profiles AS profile
                  ON profile.profile_id = session.account_profile_id
                WHERE session.incarnation_id = incarnation.incarnation_id
                  AND session.state = 'bound'
                  AND session.actor_id = incarnation.actor_id
                  AND session.account_profile_id = attempt.account_profile_id
                  AND session.admission_generation = attempt.process_generation
                  AND session.provider_thread_id = incarnation.provider_thread_id
                  AND session.live_generation < NEW.observation_generation
                  AND profile.process_generation = NEW.observation_generation
              )
            )
          )
          AND incarnation.account_profile_id = attempt.account_profile_id
          AND incarnation.process_generation = attempt.process_generation
          AND incarnation.provider_thread_id IS NOT NULL
          AND incarnation.state IN ('idle', 'running')
          AND (
            incarnation.token_usage_latest_position IS NULL
            OR NEW.observation_generation >
              incarnation.token_usage_observation_generation
            OR (
              NEW.observation_generation =
                incarnation.token_usage_observation_generation
              AND NEW.stream_position > incarnation.token_usage_latest_position
            )
          )
          AND NEW.cumulative_input_tokens >=
            incarnation.token_usage_cumulative_input_tokens
          AND NEW.cumulative_output_tokens >=
            incarnation.token_usage_cumulative_output_tokens
      )
      BEGIN
        SELECT RAISE(ABORT, 'actor usage inbox lineage is incoherent');
      END;

      CREATE TRIGGER harness_actor_turn_usage_inbox_update_guard
      BEFORE UPDATE ON harness_actor_turn_usage_inbox
      WHEN (
        NEW.quarantined = OLD.quarantined
        AND NEW.quarantine_reason IS OLD.quarantine_reason
        AND (
          NEW.attempt_id != OLD.attempt_id
          OR NEW.provider_identity_digest != OLD.provider_identity_digest
          OR NEW.observation_generation < OLD.observation_generation
          OR (
            NEW.observation_generation = OLD.observation_generation
            AND NEW.stream_position <= OLD.stream_position
          )
          OR NEW.cumulative_input_tokens < OLD.cumulative_input_tokens
          OR NEW.cumulative_output_tokens < OLD.cumulative_output_tokens
        )
      ) OR (
        (
          NEW.quarantined != OLD.quarantined
          OR NEW.quarantine_reason IS NOT OLD.quarantine_reason
        ) AND NOT (
          OLD.quarantined = 0 AND OLD.quarantine_reason IS NULL
          AND NEW.quarantined = 1 AND NEW.quarantine_reason IS NOT NULL
          AND NEW.attempt_id = OLD.attempt_id
          AND NEW.provider_identity_digest = OLD.provider_identity_digest
          AND NEW.observation_generation = OLD.observation_generation
          AND NEW.stream_position = OLD.stream_position
          AND NEW.cumulative_input_tokens = OLD.cumulative_input_tokens
          AND NEW.cumulative_output_tokens = OLD.cumulative_output_tokens
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'actor usage inbox update is incoherent');
      END;

      CREATE TRIGGER harness_actor_turn_usage_inbox_delete_guard
      BEFORE DELETE ON harness_actor_turn_usage_inbox
      WHEN NOT EXISTS (
        SELECT 1 FROM harness_actor_turn_attempts AS attempt
        WHERE attempt.attempt_id = OLD.attempt_id
          AND attempt.provider_turn_id IS NOT NULL
          AND attempt.token_usage_identity_digest =
            OLD.provider_identity_digest
          AND attempt.token_usage_observation_generation =
            OLD.observation_generation
          AND attempt.token_usage_stream_position = OLD.stream_position
          AND attempt.token_usage_cumulative_input_tokens =
            OLD.cumulative_input_tokens
          AND attempt.token_usage_cumulative_output_tokens =
            OLD.cumulative_output_tokens
          AND EXISTS (
            SELECT 1
            FROM harness_actor_incarnations AS incarnation
            WHERE incarnation.incarnation_id = attempt.incarnation_id
              AND incarnation.token_usage_observation_generation =
                OLD.observation_generation
              AND incarnation.token_usage_latest_position =
                OLD.stream_position
              AND incarnation.token_usage_cumulative_input_tokens =
                OLD.cumulative_input_tokens
              AND incarnation.token_usage_cumulative_output_tokens =
                OLD.cumulative_output_tokens
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'actor usage inbox may only be consumed exactly');
      END;

      CREATE TABLE harness_semantic_evidence_bundles (
        bundle_digest TEXT PRIMARY KEY CHECK (
          length(bundle_digest) = 64
          AND bundle_digest NOT GLOB '*[^0-9a-f]*'
        ),
        provider_id TEXT NOT NULL CHECK (
          length(provider_id) BETWEEN 1 AND 128
          AND provider_id NOT GLOB '*[^A-Za-z0-9._-]*'
        ),
        account_profile_id TEXT NOT NULL
          REFERENCES account_profiles(profile_id) ON DELETE RESTRICT,
        account_generation INTEGER NOT NULL CHECK (account_generation > 0),
        process_generation INTEGER NOT NULL CHECK (process_generation > 0),
        runtime_binary_sha256 TEXT NOT NULL CHECK (
          length(runtime_binary_sha256) = 64
          AND runtime_binary_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        codex_version TEXT NOT NULL CHECK (
          length(codex_version) BETWEEN 1 AND 64
          AND codex_version NOT GLOB '*[^0-9A-Za-z.+_-]*'
        ),
        observed_at TEXT NOT NULL CHECK (
          length(observed_at) = 24 AND substr(observed_at, 24, 1) = 'Z'
        ),
        expires_at TEXT NOT NULL CHECK (
          length(expires_at) = 24 AND substr(expires_at, 24, 1) = 'Z'
        ),
        signer_key_id TEXT NOT NULL CHECK (
          length(signer_key_id) BETWEEN 1 AND 128
          AND signer_key_id NOT GLOB '*[^A-Za-z0-9._:-]*'
        ),
        manifest_digest TEXT NOT NULL CHECK (
          length(manifest_digest) = 64
          AND manifest_digest NOT GLOB '*[^0-9a-f]*'
        ),
        manifest_signature TEXT NOT NULL CHECK (
          length(manifest_signature) BETWEEN 43 AND 512
          AND manifest_signature NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        state TEXT NOT NULL CHECK (
          state IN ('active', 'superseded', 'quarantined')
        ),
        quarantine_reason TEXT CHECK (
          quarantine_reason IS NULL OR quarantine_reason IN (
            'signature_invalid', 'manifest_invalid', 'runtime_mismatch',
            'generation_mismatch', 'provider_mismatch', 'expired',
            'recovery_protocol_error'
          )
        ),
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL CHECK (
          length(created_at) = 24 AND substr(created_at, 24, 1) = 'Z'
        ),
        updated_at TEXT NOT NULL CHECK (
          length(updated_at) = 24 AND substr(updated_at, 24, 1) = 'Z'
        ),
        CHECK (account_generation = process_generation),
        CHECK (observed_at <= created_at),
        CHECK (expires_at > observed_at),
        CHECK (updated_at >= created_at),
        CHECK ((state = 'quarantined') = (quarantine_reason IS NOT NULL))
      ) STRICT;

      CREATE UNIQUE INDEX harness_semantic_evidence_active_runtime_idx
        ON harness_semantic_evidence_bundles(
          provider_id, account_profile_id, account_generation,
          process_generation, runtime_binary_sha256, codex_version
        )
        WHERE state = 'active';

      CREATE INDEX harness_semantic_evidence_expiry_idx
        ON harness_semantic_evidence_bundles(state, expires_at);

      CREATE TRIGGER harness_semantic_evidence_bundle_insert_guard
      BEFORE INSERT ON harness_semantic_evidence_bundles
      WHEN NEW.state != 'active'
        OR NEW.quarantine_reason IS NOT NULL
        OR NEW.revision != 1
        OR NEW.updated_at != NEW.created_at
      BEGIN
        SELECT RAISE(ABORT, 'semantic evidence bundle insert is incoherent');
      END;

      CREATE TRIGGER harness_semantic_evidence_bundle_transition_guard
      BEFORE UPDATE ON harness_semantic_evidence_bundles
      WHEN OLD.state != 'active'
        OR NEW.state NOT IN ('superseded', 'quarantined')
        OR NEW.revision != OLD.revision + 1
        OR NEW.updated_at < OLD.updated_at
        OR (NEW.state = 'superseded' AND NEW.quarantine_reason IS NOT NULL)
        OR (NEW.state = 'quarantined' AND NEW.quarantine_reason IS NULL)
      BEGIN
        SELECT RAISE(ABORT, 'semantic evidence bundle transition is incoherent');
      END;

      CREATE TRIGGER harness_semantic_evidence_bundle_identity_guard
      BEFORE UPDATE OF
        bundle_digest, provider_id, account_profile_id, account_generation,
        process_generation, runtime_binary_sha256, codex_version,
        observed_at, expires_at, signer_key_id, manifest_digest,
        manifest_signature, created_at
      ON harness_semantic_evidence_bundles
      WHEN NEW.bundle_digest != OLD.bundle_digest
        OR NEW.provider_id != OLD.provider_id
        OR NEW.account_profile_id != OLD.account_profile_id
        OR NEW.account_generation != OLD.account_generation
        OR NEW.process_generation != OLD.process_generation
        OR NEW.runtime_binary_sha256 != OLD.runtime_binary_sha256
        OR NEW.codex_version != OLD.codex_version
        OR NEW.observed_at != OLD.observed_at
        OR NEW.expires_at != OLD.expires_at
        OR NEW.signer_key_id != OLD.signer_key_id
        OR NEW.manifest_digest != OLD.manifest_digest
        OR NEW.manifest_signature != OLD.manifest_signature
        OR NEW.created_at != OLD.created_at
      BEGIN
        SELECT RAISE(ABORT, 'semantic evidence bundle identity is immutable');
      END;

      CREATE TRIGGER harness_semantic_evidence_bundle_delete_guard
      BEFORE DELETE ON harness_semantic_evidence_bundles
      BEGIN
        SELECT RAISE(ABORT, 'semantic evidence bundles are append-only');
      END;

      CREATE TABLE harness_actor_continuation_intents (
        intent_id TEXT PRIMARY KEY CHECK (
          length(intent_id) = 78
          AND intent_id GLOB 'hcontinuation_[0-9a-f]*'
          AND substr(intent_id, 15) NOT GLOB '*[^0-9a-f]*'
        ),
        actor_id TEXT NOT NULL
          REFERENCES harness_actors(actor_id) ON DELETE RESTRICT,
        actor_turn_id TEXT NOT NULL
          REFERENCES harness_actor_turns(turn_id) ON DELETE RESTRICT,
        target_process_generation INTEGER NOT NULL CHECK (
          target_process_generation > 0
        ),
        source_identity_digest TEXT NOT NULL CHECK (
          length(source_identity_digest) = 64
          AND source_identity_digest NOT GLOB '*[^0-9a-f]*'
        ),
        effect_identity_digest TEXT NOT NULL UNIQUE CHECK (
          length(effect_identity_digest) = 64
          AND effect_identity_digest NOT GLOB '*[^0-9a-f]*'
        ),
        metadata_digest TEXT NOT NULL UNIQUE CHECK (
          length(metadata_digest) = 64
          AND metadata_digest NOT GLOB '*[^0-9a-f]*'
        ),
        predecessor_intent_id TEXT UNIQUE
          REFERENCES harness_actor_continuation_intents(intent_id)
          ON DELETE RESTRICT,
        recovery_proof_digest TEXT CHECK (
          recovery_proof_digest IS NULL OR (
            length(recovery_proof_digest) = 64
            AND recovery_proof_digest NOT GLOB '*[^0-9a-f]*'
          )
        ),
        state TEXT NOT NULL CHECK (state IN (
          'prepared', 'injectionEffectStarted', 'injected',
          'continueDispatchPrepared', 'continueDispatchEffectStarted',
          'ambiguous', 'supersededApplied', 'supersededNotApplied'
        )),
        revision INTEGER NOT NULL CHECK (revision > 0),
        exact_readback_verified INTEGER NOT NULL CHECK (
          exact_readback_verified IN (0, 1)
        ),
        absence_proof_digest TEXT CHECK (
          absence_proof_digest IS NULL OR (
            length(absence_proof_digest) = 64
            AND absence_proof_digest NOT GLOB '*[^0-9a-f]*'
          )
        ),
        ambiguity_code TEXT CHECK (ambiguity_code IS NULL OR ambiguity_code IN (
          'history_identity_mismatch', 'injection_readback_mismatch',
          'continue_definitively_absent_after_dispatch'
        )),
        created_at TEXT NOT NULL CHECK (
          length(created_at) = 24 AND substr(created_at, 24, 1) = 'Z'
        ),
        updated_at TEXT NOT NULL CHECK (
          length(updated_at) = 24 AND substr(updated_at, 24, 1) = 'Z'
        ),
        settled_at TEXT CHECK (
          settled_at IS NULL OR (
            length(settled_at) = 24 AND substr(settled_at, 24, 1) = 'Z'
          )
        ),
        CHECK (intent_id = 'hcontinuation_' || effect_identity_digest),
        CHECK ((state = 'ambiguous') = (ambiguity_code IS NOT NULL)),
        CHECK (
          (state IN (
            'ambiguous', 'supersededApplied', 'supersededNotApplied'
          )) = (settled_at IS NOT NULL)
        ),
        CHECK (
          (predecessor_intent_id IS NULL) OR
            (recovery_proof_digest IS NOT NULL)
        ),
        CHECK (
          (state IN ('supersededApplied', 'supersededNotApplied')) <=
            (recovery_proof_digest IS NOT NULL)
        ),
        CHECK (
          (state IN (
            'injected', 'continueDispatchPrepared',
            'continueDispatchEffectStarted'
          )) <= exact_readback_verified
        ),
        CHECK (
          (state = 'continueDispatchEffectStarted') <=
            (absence_proof_digest IS NOT NULL)
        )
      ) STRICT;

      CREATE UNIQUE INDEX harness_actor_continuation_live_source_idx
        ON harness_actor_continuation_intents(source_identity_digest)
        WHERE state IN (
          'prepared', 'injectionEffectStarted', 'injected',
          'continueDispatchPrepared', 'continueDispatchEffectStarted'
        );

      CREATE INDEX harness_actor_continuation_predecessor_idx
        ON harness_actor_continuation_intents(predecessor_intent_id)
        WHERE predecessor_intent_id IS NOT NULL;

      CREATE TRIGGER harness_actor_continuation_intent_insert_guard
      BEFORE INSERT ON harness_actor_continuation_intents
      WHEN NEW.state != 'prepared'
        OR NEW.revision != 1
        OR NEW.exact_readback_verified != 0
        OR NEW.absence_proof_digest IS NOT NULL
        OR NEW.ambiguity_code IS NOT NULL
        OR NEW.settled_at IS NOT NULL
        OR NEW.updated_at != NEW.created_at
        OR (
          NEW.predecessor_intent_id IS NULL AND (
            NEW.recovery_proof_digest IS NOT NULL
            OR EXISTS (
              SELECT 1 FROM harness_actor_continuation_intents AS existing
              WHERE existing.source_identity_digest =
                NEW.source_identity_digest
            )
          )
        )
        OR (
          NEW.predecessor_intent_id IS NOT NULL AND (
            NEW.recovery_proof_digest IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM harness_actor_continuation_intents AS predecessor
              WHERE predecessor.intent_id = NEW.predecessor_intent_id
                AND predecessor.actor_id = NEW.actor_id
                AND predecessor.actor_turn_id = NEW.actor_turn_id
                AND NEW.target_process_generation >
                  predecessor.target_process_generation
                AND predecessor.source_identity_digest =
                  NEW.source_identity_digest
                AND predecessor.recovery_proof_digest =
                  NEW.recovery_proof_digest
                AND predecessor.state IN (
                  'supersededApplied', 'supersededNotApplied'
                )
            )
          )
        )
        OR NOT EXISTS (
          SELECT 1 FROM harness_actor_turns AS turn
          WHERE turn.turn_id = NEW.actor_turn_id
            AND turn.actor_id = NEW.actor_id
        )
      BEGIN
        SELECT RAISE(ABORT, 'actor continuation intent lineage is incoherent');
      END;

      CREATE TRIGGER harness_actor_continuation_intent_identity_guard
      BEFORE UPDATE OF intent_id, actor_id, actor_turn_id,
        target_process_generation,
        source_identity_digest, effect_identity_digest,
        metadata_digest, predecessor_intent_id, created_at
      ON harness_actor_continuation_intents
      WHEN NEW.intent_id != OLD.intent_id
        OR NEW.actor_id != OLD.actor_id
        OR NEW.actor_turn_id != OLD.actor_turn_id
        OR NEW.target_process_generation != OLD.target_process_generation
        OR NEW.source_identity_digest != OLD.source_identity_digest
        OR NEW.effect_identity_digest != OLD.effect_identity_digest
        OR NEW.metadata_digest != OLD.metadata_digest
        OR NEW.predecessor_intent_id IS NOT OLD.predecessor_intent_id
        OR NEW.created_at != OLD.created_at
      BEGIN
        SELECT RAISE(ABORT, 'actor continuation intent identity is immutable');
      END;

      CREATE TRIGGER harness_actor_continuation_intent_transition_guard
      BEFORE UPDATE ON harness_actor_continuation_intents
      WHEN NEW.revision != OLD.revision + 1
        OR NEW.updated_at < OLD.updated_at
        OR OLD.state IN (
          'ambiguous', 'supersededApplied', 'supersededNotApplied'
        )
        OR NOT (
          (OLD.state = 'prepared' AND NEW.state IN (
            'injectionEffectStarted', 'ambiguous'
          ))
          OR (OLD.state = 'injectionEffectStarted' AND NEW.state IN (
            'injected', 'ambiguous'
          ))
          OR (OLD.state = 'injected' AND NEW.state IN (
            'continueDispatchPrepared', 'ambiguous'
          ))
          OR (OLD.state = 'continueDispatchPrepared' AND NEW.state IN (
            'continueDispatchEffectStarted', 'ambiguous'
          ))
          OR (
            OLD.state = 'continueDispatchEffectStarted'
            AND NEW.state IN (
              'ambiguous', 'supersededApplied', 'supersededNotApplied'
            )
          )
          OR (
            OLD.state IN (
              'prepared', 'injectionEffectStarted', 'injected',
              'continueDispatchPrepared'
            ) AND NEW.state IN (
              'supersededApplied', 'supersededNotApplied'
            )
          )
        )
        OR (
          NEW.state NOT IN ('supersededApplied', 'supersededNotApplied')
          AND NEW.recovery_proof_digest IS NOT OLD.recovery_proof_digest
        )
        OR (
          NEW.state = 'injectionEffectStarted' AND NOT (
            NEW.exact_readback_verified = 0
            AND NEW.absence_proof_digest IS NULL
            AND NEW.ambiguity_code IS NULL
            AND NEW.settled_at IS NULL
          )
        )
        OR (
          NEW.state IN ('injected', 'continueDispatchPrepared') AND NOT (
            NEW.exact_readback_verified = 1
            AND NEW.absence_proof_digest IS NULL
            AND NEW.ambiguity_code IS NULL
            AND NEW.settled_at IS NULL
          )
        )
        OR (
          NEW.state = 'continueDispatchEffectStarted' AND NOT (
            NEW.exact_readback_verified = 1
            AND NEW.absence_proof_digest IS NOT NULL
            AND NEW.ambiguity_code IS NULL
            AND NEW.settled_at IS NULL
          )
        )
        OR (
          NEW.state = 'ambiguous' AND NOT (
            NEW.ambiguity_code IS NOT NULL
            AND NEW.settled_at = NEW.updated_at
            AND NEW.exact_readback_verified =
              OLD.exact_readback_verified
            AND NEW.absence_proof_digest IS
              OLD.absence_proof_digest
          )
        )
        OR (
          NEW.state IN ('supersededApplied', 'supersededNotApplied')
          AND NOT (
            NEW.recovery_proof_digest IS NOT NULL
            AND NEW.recovery_proof_digest IS NOT OLD.recovery_proof_digest
            AND NEW.exact_readback_verified =
              OLD.exact_readback_verified
            AND NEW.absence_proof_digest IS OLD.absence_proof_digest
            AND NEW.ambiguity_code IS NULL
            AND NEW.settled_at = NEW.updated_at
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'actor continuation intent transition is incoherent');
      END;

      CREATE TRIGGER harness_actor_continuation_intent_delete_guard
      BEFORE DELETE ON harness_actor_continuation_intents
      BEGIN
        SELECT RAISE(ABORT, 'actor continuation intent evidence is append-only');
      END;
    `,
  },
] as const;
