import { harnessV2Migrations } from "./harness-v2-migrations";
import { LONGITUDINAL_ROUTING_SCHEMA_V1_SQL } from "./longitudinal-routing-schema-v1";
import { ROOT_TURN_ROUTING_SCHEMA_V1_SQL } from "./root-turn-routing-schema-v1";
import { ROOT_TURN_ROUTING_CAPABILITY_SCHEMA_V1_SQL } from
  "./root-turn-routing-capability-schema-v1";
import { CHAT_MESSAGE_LEDGER_SCHEMA_V1_SQL } from "./chat-message-ledger-schema-v1";
import { CHAT_MESSAGE_AMBIGUOUS_RESOLUTION_SCHEMA_V1_SQL } from
  "./chat-message-ambiguous-resolution-schema-v1";
import { CHAT_COMPACT_SEMANTIC_SCHEMA_V1_SQL } from
  "./chat-pane-palette-schema-v1";
import { CHAT_ATTACHMENT_VAULT_SCHEMA_V2_SQL } from
  "./chat-attachment-vault-schema-v2";
import { CHAT_MESSAGE_IDEMPOTENCY_SCHEMA_V1_SQL } from
  "./chat-message-idempotency-schema-v1";
import { PROVIDER_THREAD_ARCHIVE_JOURNAL_V57_SQL } from
  "./provider-thread-archive-journal-v57";
import {
  SCHEDULED_CHAT_DURABLE_OFF_INTENT_SCHEMA_SQL,
  SCHEDULED_CHAT_LOCAL_SCHEMA_V1_SQL,
} from "./scheduled-chat-store";
import {
  SESSION_SYNC_HARDENING_SCHEMA_SQL,
  SESSION_SYNC_HUMAN_ORIGIN_SCHEMA_SQL,
  SESSION_SYNC_HUMAN_SCOPE_SCHEMA_SQL,
  SESSION_SYNC_OPERATION_SCHEMA_SQL,
  SESSION_SYNC_SCHEMA_SQL,
} from "./session-sync-schema";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const migrations = [
  {
    version: 1,
    name: "control-plane-foundation",
    sql: `
      CREATE TABLE account_profiles (
        profile_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        identity_label TEXT,
        auth_state TEXT NOT NULL DEFAULT 'unknown',
        process_generation INTEGER NOT NULL DEFAULT 0 CHECK (process_generation >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE projects (
        project_id TEXT PRIMARY KEY,
        canonical_repository_path TEXT NOT NULL UNIQUE,
        canonical_git_common_dir TEXT NOT NULL,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE workspace_leases (
        lane_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
        account_profile_id TEXT REFERENCES account_profiles(profile_id) ON DELETE SET NULL,
        canonical_checkout_path TEXT NOT NULL UNIQUE,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        branch_name TEXT,
        retention TEXT NOT NULL DEFAULT 'preserve',
        dirty_hint INTEGER NOT NULL DEFAULT 0 CHECK (dirty_hint IN (0, 1)),
        recovery_manifest_path TEXT,
        checkpointed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE thread_bindings (
        thread_id TEXT PRIMARY KEY,
        codex_thread_id TEXT NOT NULL,
        account_profile_id TEXT NOT NULL REFERENCES account_profiles(profile_id) ON DELETE RESTRICT,
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
        lane_id TEXT NOT NULL REFERENCES workspace_leases(lane_id) ON DELETE RESTRICT,
        archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (account_profile_id, codex_thread_id)
      ) STRICT;

      CREATE TABLE operation_receipts (
        operation_id TEXT PRIMARY KEY,
        command_type TEXT NOT NULL,
        command_fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('started', 'succeeded', 'failed', 'ambiguous')),
        outcome_code TEXT,
        entity_id TEXT,
        response_json TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      ) STRICT;

      CREATE TABLE compatibility_diagnostics (
        diagnostic_id TEXT PRIMARY KEY,
        account_profile_id TEXT REFERENCES account_profiles(profile_id) ON DELETE SET NULL,
        process_generation INTEGER NOT NULL CHECK (process_generation >= 0),
        category TEXT NOT NULL,
        method TEXT NOT NULL,
        occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX workspace_leases_project_idx ON workspace_leases(project_id);
      CREATE INDEX thread_bindings_lane_idx ON thread_bindings(lane_id);
      CREATE INDEX thread_bindings_account_idx ON thread_bindings(account_profile_id);
      CREATE INDEX compatibility_diagnostics_account_idx
        ON compatibility_diagnostics(account_profile_id, process_generation);
    `,
  },
  {
    version: 2,
    name: "isolated-account-profiles",
    sql: `
      ALTER TABLE account_profiles
        ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0);
      ALTER TABLE account_profiles
        ADD COLUMN selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1));
      ALTER TABLE account_profiles ADD COLUMN plan_label TEXT;
      ALTER TABLE account_profiles ADD COLUMN removed_at TEXT;
      ALTER TABLE account_profiles ADD COLUMN credential_state_deleted_at TEXT;

      CREATE UNIQUE INDEX account_profiles_single_selected_active_idx
        ON account_profiles(selected)
        WHERE selected = 1 AND removed_at IS NULL;
      CREATE INDEX account_profiles_active_idx
        ON account_profiles(removed_at, created_at);
    `,
  },
  {
    version: 3,
    name: "honest-account-local-data-lifecycle",
    sql: `
      ALTER TABLE account_profiles
        RENAME COLUMN credential_state_deleted_at TO local_data_deleted_at;
    `,
  },
  {
    version: 4,
    name: "durable-cloud-dispatch",
    sql: `
      CREATE TABLE repository_bindings (
        repository_public_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
        canonical_repository_path TEXT NOT NULL,
        canonical_git_common_dir TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (project_id, repository_public_id)
      ) STRICT;

      CREATE TABLE dispatch_bindings (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        claim_id TEXT NOT NULL,
        claim_fence INTEGER NOT NULL CHECK (claim_fence > 0),
        input_review_revision INTEGER NOT NULL CHECK (input_review_revision > 0),
        runtime_public_id TEXT NOT NULL,
        runtime_boot_id TEXT NOT NULL,
        repository_public_id TEXT NOT NULL
          REFERENCES repository_bindings(repository_public_id) ON DELETE RESTRICT,
        account_profile_id TEXT REFERENCES account_profiles(profile_id) ON DELETE SET NULL,
        lane_id TEXT REFERENCES workspace_leases(lane_id) ON DELETE RESTRICT,
        thread_id TEXT,
        stage TEXT NOT NULL CHECK (stage IN (
          'reserved',
          'worktree_ready',
          'thread_starting',
          'thread_ready',
          'turn_starting',
          'running',
          'waiting',
          'completed',
          'failed',
          'cancelled',
          'lease_lost',
          'ambiguous'
        )),
        base_sha TEXT,
        branch_name TEXT,
        last_event_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_event_sequence >= 0),
        failure_code TEXT,
        capacity_released_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (claim_id, claim_fence)
      ) STRICT;

      CREATE TABLE dispatch_outbox (
        run_id TEXT NOT NULL REFERENCES dispatch_bindings(run_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        event_id TEXT NOT NULL UNIQUE,
        event_kind TEXT NOT NULL,
        public_summary TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        acknowledged_at TEXT,
        PRIMARY KEY (run_id, sequence)
      ) STRICT;

      CREATE INDEX repository_bindings_project_idx
        ON repository_bindings(project_id, enabled);
      CREATE INDEX dispatch_bindings_runtime_stage_idx
        ON dispatch_bindings(runtime_public_id, stage, updated_at);
      CREATE INDEX dispatch_bindings_task_idx
        ON dispatch_bindings(task_id, updated_at);
      CREATE INDEX dispatch_outbox_pending_idx
        ON dispatch_outbox(acknowledged_at, run_id, sequence);
    `,
  },
  {
    version: 5,
    name: "dispatch-runner-installation",
    sql: `
      CREATE TABLE dispatch_runner_installation (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        runner_public_id TEXT NOT NULL UNIQUE,
        installation_id TEXT NOT NULL UNIQUE,
        boot_id TEXT NOT NULL UNIQUE,
        boot_generation INTEGER NOT NULL CHECK (boot_generation > 0),
        accepted_heartbeat_sequence INTEGER NOT NULL DEFAULT 0
          CHECK (accepted_heartbeat_sequence >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 6,
    name: "dispatch-turn-completion",
    sql: `
      ALTER TABLE dispatch_bindings ADD COLUMN task_key TEXT;
      ALTER TABLE dispatch_bindings ADD COLUMN turn_id TEXT;

      CREATE UNIQUE INDEX dispatch_bindings_owned_turn_idx
        ON dispatch_bindings(account_profile_id, thread_id, turn_id)
        WHERE account_profile_id IS NOT NULL
          AND thread_id IS NOT NULL
          AND turn_id IS NOT NULL;
    `,
  },
  {
    version: 7,
    name: "dispatch-human-interactions",
    sql: `
      CREATE TABLE dispatch_interactions (
        interaction_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES dispatch_bindings(run_id) ON DELETE CASCADE,
        request_json TEXT NOT NULL CHECK (json_valid(request_json)),
        request_digest TEXT NOT NULL CHECK (
          length(request_digest) = 64 AND request_digest NOT GLOB '*[^a-f0-9]*'
        ),
        state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'expired')),
        response_revision INTEGER CHECK (response_revision IS NULL OR response_revision > 0),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        UNIQUE (run_id, interaction_id)
      ) STRICT;

      CREATE INDEX dispatch_interactions_sync_idx
        ON dispatch_interactions(run_id, state, created_at, interaction_id);
    `,
  },
  {
    version: 8,
    name: "bounded-fair-interaction-sync",
    sql: `
      ALTER TABLE dispatch_interactions ADD COLUMN published_at INTEGER;
      ALTER TABLE dispatch_interactions ADD COLUMN settlement_reason TEXT CHECK (
        settlement_reason IS NULL OR settlement_reason IN (
          'local_deadline', 'provider_expired', 'cloud_expired'
        )
      );

      CREATE TABLE dispatch_interaction_sync_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        last_run_id TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 9,
    name: "bounded-run-display-drafts",
    sql: `
      CREATE TABLE dispatch_display_drafts (
        run_id TEXT PRIMARY KEY REFERENCES dispatch_bindings(run_id) ON DELETE CASCADE,
        event_kind TEXT NOT NULL CHECK (event_kind IN (
          'codex.reasoning_summary.delta',
          'codex.assistant_message.delta'
        )),
        display_text TEXT NOT NULL,
        display_bytes INTEGER NOT NULL CHECK (display_bytes > 0 AND display_bytes <= 2048),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 10,
    name: "local-task-authority-foundation",
    sql: `
      CREATE TABLE local_installations (
        installation_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
      ) STRICT;

      CREATE TABLE local_repositories (
        repository_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT CHECK (
          provider IS NULL OR provider IN ('github', 'gitlab', 'bitbucket', 'other')
        ),
        public_url TEXT,
        canonical_repository_path TEXT NOT NULL UNIQUE,
        canonical_git_common_dir TEXT NOT NULL UNIQUE,
        tombstoned_at INTEGER CHECK (tombstoned_at IS NULL OR tombstoned_at >= created_at),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
      ) STRICT;

      CREATE TABLE local_workspaces (
        workspace_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        event_sequence INTEGER NOT NULL DEFAULT 0 CHECK (event_sequence >= 0),
        authority_kind TEXT NOT NULL CHECK (authority_kind IN ('local', 'promoting', 'cloud')),
        owner_installation_id TEXT NOT NULL
          REFERENCES local_installations(installation_id) ON DELETE RESTRICT,
        promotion_id TEXT,
        authority_phase TEXT CHECK (
          authority_phase IS NULL OR authority_phase IN (
            'snapshot_frozen', 'staging', 'uploading', 'activating', 'outcome_unknown'
          )
        ),
        cloud_workspace_id TEXT,
        tombstoned_at INTEGER CHECK (tombstoned_at IS NULL OR tombstoned_at >= created_at),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        CHECK (
          (
            authority_kind = 'local'
            AND promotion_id IS NULL
            AND authority_phase IS NULL
            AND cloud_workspace_id IS NULL
          )
          OR (
            authority_kind = 'promoting'
            AND promotion_id IS NOT NULL
            AND authority_phase IS NOT NULL
            AND cloud_workspace_id IS NULL
          )
          OR (
            authority_kind = 'cloud'
            AND promotion_id IS NOT NULL
            AND authority_phase IS NULL
            AND cloud_workspace_id IS NOT NULL
          )
        )
      ) STRICT;

      CREATE TABLE local_workspace_repositories (
        workspace_id TEXT NOT NULL
          REFERENCES local_workspaces(workspace_id) ON DELETE CASCADE,
        repository_id TEXT NOT NULL
          REFERENCES local_repositories(repository_id) ON DELETE RESTRICT,
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        PRIMARY KEY (workspace_id, repository_id)
      ) STRICT;

      CREATE TABLE local_builtin_executors (
        workspace_id TEXT PRIMARY KEY
          REFERENCES local_workspaces(workspace_id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        UNIQUE (workspace_id, agent_id)
      ) STRICT;

      CREATE INDEX local_workspaces_authority_idx
        ON local_workspaces(authority_kind, updated_at, workspace_id);
      CREATE INDEX local_workspace_repositories_repository_idx
        ON local_workspace_repositories(repository_id, workspace_id);
    `,
  },
  {
    version: 11,
    name: "local-task-graph-and-public-projections",
    sql: `
      CREATE TABLE local_tasks (
        workspace_id TEXT NOT NULL
          REFERENCES local_workspaces(workspace_id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        task_key TEXT NOT NULL,
        title TEXT NOT NULL,
        task_type TEXT NOT NULL CHECK (task_type IN ('task', 'bug', 'feature', 'epic', 'chore')),
        priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 4),
        status TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'in_review', 'done', 'cancelled')),
        available_at INTEGER NOT NULL CHECK (available_at >= 0),
        assignee_agent_id TEXT,
        parent_task_id TEXT,
        repository_id TEXT,
        unresolved_blocker_count INTEGER NOT NULL DEFAULT 0 CHECK (unresolved_blocker_count >= 0),
        cancelled_blocker_count INTEGER NOT NULL DEFAULT 0 CHECK (cancelled_blocker_count >= 0),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        review_revision INTEGER NOT NULL DEFAULT 1 CHECK (review_revision > 0),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        completed_at INTEGER,
        cancelled_at INTEGER,
        PRIMARY KEY (workspace_id, task_id),
        UNIQUE (workspace_id, task_key),
        FOREIGN KEY (workspace_id, parent_task_id)
          REFERENCES local_tasks(workspace_id, task_id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, repository_id)
          REFERENCES local_workspace_repositories(workspace_id, repository_id)
          ON DELETE RESTRICT
      ) STRICT;

      CREATE TABLE local_task_bodies (
        workspace_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        description TEXT NOT NULL,
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
        PRIMARY KEY (workspace_id, task_id),
        FOREIGN KEY (workspace_id, task_id)
          REFERENCES local_tasks(workspace_id, task_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE local_task_dependencies (
        workspace_id TEXT NOT NULL,
        blocker_task_id TEXT NOT NULL,
        blocked_task_id TEXT NOT NULL,
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        PRIMARY KEY (workspace_id, blocker_task_id, blocked_task_id),
        CHECK (blocker_task_id <> blocked_task_id),
        FOREIGN KEY (workspace_id, blocker_task_id)
          REFERENCES local_tasks(workspace_id, task_id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, blocked_task_id)
          REFERENCES local_tasks(workspace_id, task_id) ON DELETE RESTRICT
      ) STRICT;

      CREATE TABLE local_task_labels (
        workspace_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        PRIMARY KEY (workspace_id, task_id, label),
        FOREIGN KEY (workspace_id, task_id)
          REFERENCES local_tasks(workspace_id, task_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE local_task_comments (
        workspace_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        comment_id TEXT NOT NULL,
        actor_json TEXT NOT NULL CHECK (json_valid(actor_json)),
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        PRIMARY KEY (workspace_id, comment_id),
        FOREIGN KEY (workspace_id, task_id)
          REFERENCES local_tasks(workspace_id, task_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE local_task_references (
        workspace_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        reference_id TEXT NOT NULL,
        reference_json TEXT NOT NULL CHECK (json_valid(reference_json)),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        PRIMARY KEY (workspace_id, reference_id),
        FOREIGN KEY (workspace_id, task_id)
          REFERENCES local_tasks(workspace_id, task_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE local_task_claims (
        workspace_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        claim_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        fence INTEGER NOT NULL CHECK (fence > 0),
        lease_generation INTEGER NOT NULL CHECK (lease_generation > 0),
        lease_until INTEGER NOT NULL CHECK (lease_until >= 0),
        state TEXT NOT NULL CHECK (state IN ('active', 'released', 'expired', 'submitted', 'replaced')),
        boot_generation INTEGER NOT NULL CHECK (boot_generation > 0),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        ended_at INTEGER,
        PRIMARY KEY (workspace_id, claim_id),
        UNIQUE (workspace_id, task_id, fence),
        FOREIGN KEY (workspace_id, task_id)
          REFERENCES local_tasks(workspace_id, task_id) ON DELETE CASCADE
      ) STRICT;

      CREATE UNIQUE INDEX local_task_claims_one_active_idx
        ON local_task_claims(workspace_id, task_id)
        WHERE state = 'active';

      CREATE TABLE local_task_runs (
        workspace_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN (
          'queued', 'leased', 'provisioning', 'starting', 'running', 'waiting',
          'submitted', 'failed', 'cancel_requested', 'cancelled', 'ambiguous'
        )),
        desired_state TEXT NOT NULL CHECK (desired_state IN ('run', 'stop')),
        source_run_id TEXT,
        retried_by_run_id TEXT,
        claim_id TEXT,
        fence INTEGER,
        boot_generation INTEGER,
        recovery_state TEXT CHECK (
          recovery_state IS NULL OR recovery_state IN (
            'none', 'pending', 'reconciling', 'ambiguous', 'recovered', 'abandoned'
          )
        ),
        started_at INTEGER,
        finished_at INTEGER,
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        PRIMARY KEY (workspace_id, run_id),
        UNIQUE (workspace_id, retried_by_run_id),
        FOREIGN KEY (workspace_id, task_id)
          REFERENCES local_tasks(workspace_id, task_id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id, repository_id)
          REFERENCES local_workspace_repositories(workspace_id, repository_id)
          ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, claim_id)
          REFERENCES local_task_claims(workspace_id, claim_id) ON DELETE RESTRICT
      ) STRICT;

      CREATE TABLE local_run_public_events (
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence > 0 AND sequence <= 100),
        event_id TEXT NOT NULL,
        event_kind TEXT NOT NULL,
        display_text TEXT,
        observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
        PRIMARY KEY (workspace_id, run_id, sequence),
        UNIQUE (workspace_id, event_id),
        FOREIGN KEY (workspace_id, run_id)
          REFERENCES local_task_runs(workspace_id, run_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE local_run_interactions (
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        interaction_id TEXT NOT NULL,
        request_json TEXT NOT NULL CHECK (json_valid(request_json)),
        state TEXT NOT NULL CHECK (state IN ('pending', 'answered', 'resolved', 'expired')),
        response_revision INTEGER CHECK (response_revision IS NULL OR response_revision > 0),
        responded_at INTEGER,
        resolved_at INTEGER,
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
        PRIMARY KEY (workspace_id, interaction_id),
        FOREIGN KEY (workspace_id, run_id)
          REFERENCES local_task_runs(workspace_id, run_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE local_task_submissions (
        workspace_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        submission_id TEXT NOT NULL,
        submitted_by_json TEXT NOT NULL CHECK (json_valid(submitted_by_json)),
        review_revision INTEGER NOT NULL CHECK (review_revision > 0),
        summary TEXT NOT NULL,
        evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
        status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
        submitted_at INTEGER NOT NULL CHECK (submitted_at >= 0),
        reviewed_at INTEGER,
        PRIMARY KEY (workspace_id, submission_id),
        FOREIGN KEY (workspace_id, task_id)
          REFERENCES local_tasks(workspace_id, task_id) ON DELETE CASCADE
      ) STRICT;

      CREATE UNIQUE INDEX local_task_submissions_one_pending_idx
        ON local_task_submissions(workspace_id, task_id)
        WHERE status = 'pending';

      CREATE TABLE local_task_reviews (
        workspace_id TEXT NOT NULL,
        submission_id TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected', 'cancelled')),
        reviewer_json TEXT NOT NULL CHECK (json_valid(reviewer_json)),
        reason TEXT,
        reviewed_at INTEGER NOT NULL CHECK (reviewed_at >= 0),
        PRIMARY KEY (workspace_id, submission_id),
        FOREIGN KEY (workspace_id, submission_id)
          REFERENCES local_task_submissions(workspace_id, submission_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE local_workspace_events (
        workspace_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        event_id TEXT NOT NULL,
        workspace_revision INTEGER NOT NULL CHECK (workspace_revision > 0),
        operation_id TEXT NOT NULL,
        event_kind TEXT NOT NULL,
        task_id TEXT,
        event_json TEXT NOT NULL CHECK (json_valid(event_json)),
        recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0),
        PRIMARY KEY (workspace_id, sequence),
        UNIQUE (workspace_id, event_id),
        FOREIGN KEY (workspace_id)
          REFERENCES local_workspaces(workspace_id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id, task_id)
          REFERENCES local_tasks(workspace_id, task_id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX local_tasks_list_idx
        ON local_tasks(workspace_id, updated_at DESC, task_id);
      CREATE INDEX local_tasks_parent_idx
        ON local_tasks(workspace_id, parent_task_id, updated_at DESC, task_id);
      CREATE INDEX local_task_dependencies_blocked_idx
        ON local_task_dependencies(workspace_id, blocked_task_id, blocker_task_id);
      CREATE INDEX local_task_dependencies_blocker_idx
        ON local_task_dependencies(workspace_id, blocker_task_id, blocked_task_id);
      CREATE INDEX local_task_comments_task_idx
        ON local_task_comments(workspace_id, task_id, created_at DESC, comment_id);
      CREATE INDEX local_task_references_task_idx
        ON local_task_references(workspace_id, task_id, created_at DESC, reference_id);
      CREATE INDEX local_task_runs_task_idx
        ON local_task_runs(workspace_id, task_id, updated_at DESC, run_id);
      CREATE INDEX local_workspace_events_operation_idx
        ON local_workspace_events(workspace_id, operation_id, sequence);
    `,
  },
  {
    version: 12,
    name: "local-task-replay-and-recovery",
    sql: `
      CREATE TABLE local_operation_receipts (
        operation_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL
          REFERENCES local_workspaces(workspace_id) ON DELETE CASCADE,
        command_kind TEXT NOT NULL,
        command_digest TEXT NOT NULL,
        receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
        recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0)
      ) STRICT;

      CREATE TABLE local_runtime_boot_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        installation_id TEXT NOT NULL
          REFERENCES local_installations(installation_id) ON DELETE RESTRICT,
        boot_generation INTEGER NOT NULL CHECK (boot_generation > 0),
        boot_id TEXT NOT NULL UNIQUE,
        started_at INTEGER NOT NULL CHECK (started_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= started_at)
      ) STRICT;

      CREATE TABLE local_runtime_boot_history (
        boot_generation INTEGER PRIMARY KEY CHECK (boot_generation > 0),
        boot_id TEXT NOT NULL UNIQUE,
        started_at INTEGER NOT NULL CHECK (started_at >= 0),
        stopped_at INTEGER,
        stop_reason TEXT CHECK (
          stop_reason IS NULL OR stop_reason IN ('clean', 'recovered', 'replaced')
        )
      ) STRICT;

      CREATE TABLE local_queued_run_intents (
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'queued', 'claimed', 'started', 'terminal', 'abandoned'
        )),
        fence INTEGER NOT NULL DEFAULT 1 CHECK (fence > 0),
        claimed_boot_generation INTEGER,
        available_at INTEGER NOT NULL CHECK (available_at >= 0),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        PRIMARY KEY (workspace_id, run_id),
        FOREIGN KEY (workspace_id, run_id)
          REFERENCES local_task_runs(workspace_id, run_id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id, task_id)
          REFERENCES local_tasks(workspace_id, task_id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id, repository_id)
          REFERENCES local_workspace_repositories(workspace_id, repository_id)
          ON DELETE RESTRICT
      ) STRICT;

      CREATE TABLE local_due_work (
        due_work_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL
          REFERENCES local_workspaces(workspace_id) ON DELETE CASCADE,
        work_kind TEXT NOT NULL CHECK (work_kind IN (
          'defer_wake', 'queued_run', 'claim_expiry', 'run_recovery',
          'interaction_expiry', 'repair'
        )),
        entity_id TEXT NOT NULL,
        due_at INTEGER NOT NULL CHECK (due_at >= 0),
        not_before_at INTEGER NOT NULL CHECK (not_before_at >= due_at),
        expected_revision INTEGER,
        expected_fence INTEGER,
        state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'done', 'cancelled')),
        claimed_boot_generation INTEGER,
        claimed_at INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        last_error_code TEXT,
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        UNIQUE (workspace_id, work_kind, entity_id)
      ) STRICT;

      CREATE TABLE local_recovery_records (
        recovery_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL
          REFERENCES local_workspaces(workspace_id) ON DELETE CASCADE,
        entity_kind TEXT NOT NULL CHECK (entity_kind IN ('run', 'claim', 'interaction', 'workspace')),
        entity_id TEXT NOT NULL,
        recovery_state TEXT NOT NULL CHECK (recovery_state IN (
          'pending', 'reconciling', 'resolved', 'ambiguous', 'abandoned'
        )),
        fence INTEGER NOT NULL CHECK (fence > 0),
        boot_generation INTEGER NOT NULL CHECK (boot_generation > 0),
        reason_code TEXT NOT NULL,
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        UNIQUE (workspace_id, entity_kind, entity_id)
      ) STRICT;

      CREATE TABLE local_fences (
        workspace_id TEXT NOT NULL
          REFERENCES local_workspaces(workspace_id) ON DELETE CASCADE,
        entity_kind TEXT NOT NULL CHECK (entity_kind IN ('run_intent', 'claim', 'run', 'interaction')),
        entity_id TEXT NOT NULL,
        fence INTEGER NOT NULL CHECK (fence > 0),
        boot_generation INTEGER NOT NULL CHECK (boot_generation > 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
        PRIMARY KEY (workspace_id, entity_kind, entity_id)
      ) STRICT;

      CREATE TABLE local_tombstones (
        workspace_id TEXT NOT NULL
          REFERENCES local_workspaces(workspace_id) ON DELETE CASCADE,
        entity_kind TEXT NOT NULL CHECK (entity_kind IN (
          'workspace', 'repository', 'task', 'comment', 'reference', 'run'
        )),
        entity_id TEXT NOT NULL,
        deleted_revision INTEGER NOT NULL CHECK (deleted_revision > 0),
        deleted_at INTEGER NOT NULL CHECK (deleted_at >= 0),
        PRIMARY KEY (workspace_id, entity_kind, entity_id)
      ) STRICT;

      CREATE INDEX local_due_work_ready_idx
        ON local_due_work(state, not_before_at, due_work_id);
      CREATE INDEX local_queued_run_intents_ready_idx
        ON local_queued_run_intents(state, available_at, workspace_id, run_id);
      CREATE INDEX local_operation_receipts_workspace_idx
        ON local_operation_receipts(workspace_id, recorded_at, operation_id);
    `,
  },
  {
    version: 13,
    name: "local-promotion-snapshots-and-receipts",
    sql: `
      CREATE TABLE local_promotion_sessions (
        promotion_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL UNIQUE
          REFERENCES local_workspaces(workspace_id) ON DELETE RESTRICT,
        state TEXT NOT NULL CHECK (state IN (
          'snapshot_frozen', 'staging', 'uploading', 'activating',
          'outcome_unknown', 'activated', 'aborted'
        )),
        destination_organization_id TEXT NOT NULL,
        staging_workspace_id TEXT,
        source_workspace_revision INTEGER NOT NULL CHECK (source_workspace_revision > 0),
        source_event_sequence INTEGER NOT NULL CHECK (source_event_sequence > 0),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
      ) STRICT;

      CREATE TABLE local_promotion_manifests (
        promotion_id TEXT PRIMARY KEY
          REFERENCES local_promotion_sessions(promotion_id) ON DELETE CASCADE,
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        root_digest TEXT NOT NULL,
        manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
        snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
        entity_count INTEGER NOT NULL CHECK (entity_count >= 0),
        created_at INTEGER NOT NULL CHECK (created_at >= 0)
      ) STRICT;

      CREATE TABLE local_promotion_family_digests (
        promotion_id TEXT NOT NULL
          REFERENCES local_promotion_sessions(promotion_id) ON DELETE CASCADE,
        family TEXT NOT NULL,
        entity_count INTEGER NOT NULL CHECK (entity_count >= 0),
        family_digest TEXT NOT NULL,
        PRIMARY KEY (promotion_id, family)
      ) STRICT;

      CREATE TABLE local_promotion_upload_receipts (
        promotion_id TEXT NOT NULL
          REFERENCES local_promotion_sessions(promotion_id) ON DELETE CASCADE,
        batch_id TEXT NOT NULL,
        family TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        request_digest TEXT NOT NULL,
        accepted_count INTEGER NOT NULL CHECK (accepted_count >= 0),
        cumulative_count INTEGER NOT NULL CHECK (cumulative_count >= accepted_count),
        server_digest TEXT NOT NULL,
        receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
        acceptance_sequence INTEGER NOT NULL CHECK (acceptance_sequence > 0),
        recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0),
        PRIMARY KEY (promotion_id, batch_id),
        UNIQUE (promotion_id, family, ordinal),
        UNIQUE (promotion_id, acceptance_sequence)
      ) STRICT;

      CREATE TABLE local_promotion_activation_receipts (
        promotion_id TEXT PRIMARY KEY
          REFERENCES local_promotion_sessions(promotion_id) ON DELETE CASCADE,
        cloud_workspace_id TEXT NOT NULL,
        manifest_root_digest TEXT NOT NULL,
        receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
        accepted_at INTEGER NOT NULL CHECK (accepted_at >= 0)
      ) STRICT;

      CREATE INDEX local_promotion_sessions_state_idx
        ON local_promotion_sessions(state, updated_at, promotion_id);
    `,
  },
  {
    version: 14,
    name: "durable-local-task-execution",
    sql: `
      CREATE TABLE local_run_execution_bindings (
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        task_key TEXT NOT NULL,
        claim_id TEXT NOT NULL,
        claim_fence INTEGER NOT NULL CHECK (claim_fence > 0),
        input_review_revision INTEGER NOT NULL CHECK (input_review_revision > 0),
        runtime_public_id TEXT NOT NULL,
        runtime_boot_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        account_profile_id TEXT NOT NULL,
        lane_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        stage TEXT NOT NULL CHECK (stage IN (
          'reserved',
          'worktree_ready',
          'thread_starting',
          'thread_ready',
          'turn_starting',
          'running',
          'waiting',
          'completed',
          'failed',
          'cancelled',
          'lease_lost',
          'ambiguous'
        )),
        base_sha TEXT NOT NULL,
        branch_name TEXT,
        canonical_checkout_path TEXT,
        canonical_git_common_dir TEXT,
        recovery_manifest_path TEXT,
        last_event_sequence INTEGER NOT NULL DEFAULT 1
          CHECK (last_event_sequence BETWEEN 1 AND 100),
        failure_code TEXT,
        capacity_released_at INTEGER,
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        PRIMARY KEY (workspace_id, run_id),
        UNIQUE (workspace_id, claim_id, claim_fence),
        FOREIGN KEY (workspace_id, run_id)
          REFERENCES local_task_runs(workspace_id, run_id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id, task_id)
          REFERENCES local_tasks(workspace_id, task_id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id, repository_id)
          REFERENCES local_workspace_repositories(workspace_id, repository_id)
          ON DELETE RESTRICT
      ) STRICT;

      CREATE UNIQUE INDEX local_run_execution_owned_turn_idx
        ON local_run_execution_bindings(account_profile_id, thread_id, turn_id)
        WHERE thread_id IS NOT NULL AND turn_id IS NOT NULL;

      CREATE UNIQUE INDEX local_run_execution_owned_thread_idx
        ON local_run_execution_bindings(account_profile_id, thread_id)
        WHERE thread_id IS NOT NULL;

      CREATE UNIQUE INDEX local_task_runs_global_run_idx
        ON local_task_runs(run_id);

      CREATE INDEX local_run_execution_capacity_idx
        ON local_run_execution_bindings(
          capacity_released_at, account_profile_id, stage, updated_at
        );

      CREATE TABLE local_run_display_drafts (
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        event_kind TEXT NOT NULL CHECK (event_kind IN (
          'codex.reasoning_summary.delta',
          'codex.assistant_message.delta'
        )),
        display_text TEXT NOT NULL,
        display_bytes INTEGER NOT NULL CHECK (
          display_bytes > 0 AND display_bytes <= 2048
        ),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        PRIMARY KEY (workspace_id, run_id),
        FOREIGN KEY (workspace_id, run_id)
          REFERENCES local_task_runs(workspace_id, run_id) ON DELETE CASCADE
      ) STRICT;
    `,
  },
  {
    version: 15,
    name: "local-promotion-v2-and-human-custody",
    sql: `
      ALTER TABLE local_promotion_sessions
        RENAME TO local_promotion_sessions_v1;

      CREATE TABLE local_promotion_sessions (
        promotion_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL DEFAULT 1
          CHECK (schema_version IN (1, 2)),
        workspace_id TEXT NOT NULL
          REFERENCES local_workspaces(workspace_id) ON DELETE RESTRICT,
        state TEXT NOT NULL CHECK (state IN (
          'snapshot_frozen', 'starting', 'staging', 'uploading', 'receiving',
          'validating', 'projecting', 'ready', 'activating',
          'outcome_unknown', 'aborting', 'activated', 'aborted'
        )),
        destination_organization_id TEXT NOT NULL,
        staging_workspace_id TEXT,
        cloud_workspace_id TEXT,
        source_workspace_revision INTEGER NOT NULL
          CHECK (source_workspace_revision > 0),
        source_event_sequence INTEGER NOT NULL
          CHECK (source_event_sequence > 0),
        manifest_root_digest TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0
          CHECK (attempt_count >= 0),
        next_attempt_at INTEGER,
        fault_code TEXT,
        lost_response_batch_id TEXT,
        receipt_audit_cursor TEXT,
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        CHECK (
          schema_version = 1
          OR (state = 'activated' AND cloud_workspace_id IS NOT NULL)
          OR (state <> 'activated' AND cloud_workspace_id IS NULL)
        )
      ) STRICT;

      INSERT INTO local_promotion_sessions (
        promotion_id, schema_version, workspace_id, state,
        destination_organization_id, staging_workspace_id, cloud_workspace_id,
        source_workspace_revision, source_event_sequence, manifest_root_digest,
        created_at, updated_at
      )
      SELECT
        legacy.promotion_id,
        1,
        legacy.workspace_id,
        legacy.state,
        legacy.destination_organization_id,
        legacy.staging_workspace_id,
        activation.cloud_workspace_id,
        legacy.source_workspace_revision,
        legacy.source_event_sequence,
        manifest.root_digest,
        legacy.created_at,
        legacy.updated_at
      FROM local_promotion_sessions_v1 AS legacy
      LEFT JOIN local_promotion_manifests AS manifest
        ON manifest.promotion_id = legacy.promotion_id
      LEFT JOIN local_promotion_activation_receipts AS activation
        ON activation.promotion_id = legacy.promotion_id;

      CREATE UNIQUE INDEX local_promotion_one_live_per_workspace_idx
        ON local_promotion_sessions(workspace_id)
        WHERE state NOT IN ('activated', 'aborted');
      CREATE UNIQUE INDEX local_promotion_cloud_workspace_idx
        ON local_promotion_sessions(cloud_workspace_id)
        WHERE cloud_workspace_id IS NOT NULL;
      CREATE INDEX local_promotion_sessions_v2_state_idx
        ON local_promotion_sessions(state, next_attempt_at, updated_at, promotion_id);
      CREATE INDEX local_promotion_sessions_workspace_history_idx
        ON local_promotion_sessions(workspace_id, created_at DESC, promotion_id);

      CREATE TRIGGER local_promotion_v1_session_insert_compat
      AFTER INSERT ON local_promotion_sessions
      WHEN NEW.schema_version = 1
      BEGIN
        INSERT INTO local_promotion_sessions_v1 (
          promotion_id, workspace_id, state, destination_organization_id,
          staging_workspace_id, source_workspace_revision,
          source_event_sequence, created_at, updated_at
        ) VALUES (
          NEW.promotion_id, NEW.workspace_id, NEW.state,
          NEW.destination_organization_id, NEW.staging_workspace_id,
          NEW.source_workspace_revision, NEW.source_event_sequence,
          NEW.created_at, NEW.updated_at
        );
      END;

      CREATE TRIGGER local_promotion_v1_session_update_compat
      AFTER UPDATE OF state, staging_workspace_id, updated_at
      ON local_promotion_sessions
      WHEN NEW.schema_version = 1
      BEGIN
        UPDATE local_promotion_sessions_v1
        SET state = NEW.state,
          staging_workspace_id = NEW.staging_workspace_id,
          updated_at = NEW.updated_at
        WHERE promotion_id = NEW.promotion_id;
      END;

      CREATE TABLE local_promotion_manifests_v2 (
        promotion_id TEXT PRIMARY KEY
          REFERENCES local_promotion_sessions(promotion_id) ON DELETE CASCADE,
        manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
        entity_count INTEGER NOT NULL
          CHECK (entity_count >= 0 AND entity_count <= 500000),
        serialized_entity_bytes INTEGER NOT NULL
          CHECK (serialized_entity_bytes >= 0),
        created_at INTEGER NOT NULL CHECK (created_at >= 0)
      ) STRICT;

      CREATE TABLE local_promotion_snapshot_entities (
        promotion_id TEXT NOT NULL
          REFERENCES local_promotion_sessions(promotion_id) ON DELETE CASCADE,
        family TEXT NOT NULL CHECK (family IN (
          'workspace_metadata', 'executors', 'repositories', 'tasks',
          'task_bodies', 'task_repository_links', 'parent_edges',
          'dependencies', 'labels', 'comments', 'references', 'submissions',
          'reviews', 'terminal_states', 'imported_run_summaries'
        )),
        family_ordinal INTEGER NOT NULL CHECK (family_ordinal >= 0),
        entity_identity TEXT NOT NULL,
        entity_json TEXT NOT NULL CHECK (json_valid(entity_json)),
        serialized_bytes INTEGER NOT NULL
          CHECK (serialized_bytes > 0 AND serialized_bytes <= 524288),
        PRIMARY KEY (promotion_id, family, entity_identity),
        UNIQUE (promotion_id, family, family_ordinal)
      ) STRICT;

      CREATE TABLE local_promotion_family_progress_v2 (
        promotion_id TEXT NOT NULL
          REFERENCES local_promotion_sessions(promotion_id) ON DELETE CASCADE,
        family TEXT NOT NULL CHECK (family IN (
          'workspace_metadata', 'executors', 'repositories', 'tasks',
          'task_bodies', 'task_repository_links', 'parent_edges',
          'dependencies', 'labels', 'comments', 'references', 'submissions',
          'reviews', 'terminal_states', 'imported_run_summaries'
        )),
        family_index INTEGER NOT NULL CHECK (family_index >= 0 AND family_index < 15),
        snapshot_count INTEGER NOT NULL
          CHECK (snapshot_count >= 0 AND snapshot_count <= 500000),
        snapshot_digest TEXT NOT NULL,
        snapshot_last_identity TEXT,
        accepted_batch_count INTEGER NOT NULL DEFAULT 0
          CHECK (accepted_batch_count >= 0),
        accepted_entity_count INTEGER NOT NULL DEFAULT 0
          CHECK (accepted_entity_count >= 0 AND accepted_entity_count <= snapshot_count),
        accepted_digest TEXT NOT NULL,
        accepted_last_identity TEXT,
        complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1)),
        PRIMARY KEY (promotion_id, family),
        UNIQUE (promotion_id, family_index),
        CHECK (
          (accepted_entity_count = 0 AND accepted_last_identity IS NULL)
          OR (accepted_entity_count > 0 AND accepted_last_identity IS NOT NULL)
        ),
        CHECK (complete = 0 OR accepted_entity_count = snapshot_count)
      ) STRICT;

      CREATE TABLE local_promotion_outbound_batches_v2 (
        promotion_id TEXT NOT NULL
          REFERENCES local_promotion_sessions(promotion_id) ON DELETE CASCADE,
        batch_id TEXT NOT NULL,
        family TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        request_digest TEXT NOT NULL,
        request_json TEXT NOT NULL CHECK (json_valid(request_json)),
        request_bytes INTEGER NOT NULL
          CHECK (request_bytes > 0 AND request_bytes <= 524288),
        state TEXT NOT NULL CHECK (state IN (
          'prepared', 'in_flight', 'lost_response', 'accepted'
        )),
        receipt_audit_cursor TEXT,
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        PRIMARY KEY (promotion_id, batch_id),
        UNIQUE (promotion_id, family, ordinal)
      ) STRICT;

      CREATE TABLE local_promotion_upload_receipts_v2 (
        promotion_id TEXT NOT NULL
          REFERENCES local_promotion_sessions(promotion_id) ON DELETE CASCADE,
        batch_id TEXT NOT NULL,
        family TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        request_digest TEXT NOT NULL,
        cumulative_family_count INTEGER NOT NULL CHECK (cumulative_family_count > 0),
        cumulative_family_digest TEXT NOT NULL,
        receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
        acceptance_sequence INTEGER NOT NULL CHECK (acceptance_sequence > 0),
        accepted_at INTEGER NOT NULL CHECK (accepted_at >= 0),
        PRIMARY KEY (promotion_id, batch_id),
        UNIQUE (promotion_id, family, ordinal),
        UNIQUE (promotion_id, acceptance_sequence)
      ) STRICT;

      CREATE TABLE local_promotion_decision_proofs_v2 (
        promotion_id TEXT PRIMARY KEY
          REFERENCES local_promotion_sessions(promotion_id) ON DELETE CASCADE,
        decision TEXT NOT NULL CHECK (decision IN (
          'activated', 'aborted_before_activation'
        )),
        server_receipt_id TEXT NOT NULL UNIQUE,
        receipt_digest TEXT NOT NULL UNIQUE,
        receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
        decision_sequence INTEGER NOT NULL CHECK (decision_sequence > 0),
        decided_at INTEGER NOT NULL CHECK (decided_at >= 0)
      ) STRICT;

      CREATE TABLE local_promotion_cleanup_v2 (
        promotion_id TEXT PRIMARY KEY
          REFERENCES local_promotion_sessions(promotion_id) ON DELETE CASCADE,
        scope TEXT NOT NULL CHECK (scope IN (
          'staging_rows', 'all_promotion_owned_rows'
        )),
        state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'complete')),
        deleted_entity_count INTEGER NOT NULL DEFAULT 0
          CHECK (deleted_entity_count >= 0),
        cursor TEXT,
        decision_proof_retained INTEGER NOT NULL DEFAULT 1
          CHECK (decision_proof_retained = 1),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
        CHECK ((state = 'complete') = (cursor IS NULL))
      ) STRICT;

      CREATE TABLE local_promotion_http_operations (
        promotion_id TEXT NOT NULL
          REFERENCES local_promotion_sessions(promotion_id) ON DELETE CASCADE,
        operation_key TEXT NOT NULL CHECK (
          length(operation_key) >= 1 AND length(operation_key) <= 256
        ),
        request_digest TEXT NOT NULL CHECK (
          length(request_digest) = 71
          AND substr(request_digest, 1, 7) = 'sha256_'
          AND substr(request_digest, 8) NOT GLOB '*[^0-9a-f]*'
        ),
        idempotency_key TEXT NOT NULL UNIQUE CHECK (
          length(idempotency_key) = 36
          AND lower(idempotency_key) = idempotency_key
          AND idempotency_key NOT GLOB '*[^0-9a-f-]*'
          AND substr(idempotency_key, 15, 1) = '7'
          AND substr(idempotency_key, 20, 1) GLOB '[89ab]'
          AND substr(idempotency_key, 9, 1) = '-'
          AND substr(idempotency_key, 14, 1) = '-'
          AND substr(idempotency_key, 19, 1) = '-'
          AND substr(idempotency_key, 24, 1) = '-'
        ),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        PRIMARY KEY (promotion_id, operation_key)
      ) STRICT;

      CREATE TABLE local_promotion_recovery_copies (
        promotion_id TEXT PRIMARY KEY
          REFERENCES local_promotion_sessions(promotion_id) ON DELETE CASCADE,
        local_workspace_id TEXT NOT NULL
          REFERENCES local_workspaces(workspace_id) ON DELETE RESTRICT,
        cloud_workspace_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state = 'read_only'),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        last_opened_at INTEGER,
        UNIQUE (cloud_workspace_id)
      ) STRICT;

      CREATE TABLE local_runner_pairing_pending (
        cloud_workspace_id TEXT PRIMARY KEY,
        promotion_id TEXT NOT NULL UNIQUE
          REFERENCES local_promotion_sessions(promotion_id) ON DELETE CASCADE,
        installation_id TEXT NOT NULL
          REFERENCES local_installations(installation_id) ON DELETE RESTRICT,
        state TEXT NOT NULL CHECK (state IN (
          'pending', 'pairing', 'paired', 'blocked'
        )),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        fault_code TEXT,
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
      ) STRICT;

      CREATE TABLE human_account_profiles (
        profile_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK (revision > 0),
        selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1)),
        profile_json TEXT NOT NULL CHECK (json_valid(profile_json)),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
      ) STRICT;

      CREATE UNIQUE INDEX human_account_one_selected_idx
        ON human_account_profiles(selected)
        WHERE selected = 1;

      CREATE TRIGGER human_account_profiles_reject_secrets_insert
      BEFORE INSERT ON human_account_profiles
      BEGIN
        SELECT RAISE(ABORT, 'secret-bearing account profile is forbidden')
        WHERE EXISTS (
          SELECT 1 FROM json_tree(NEW.profile_json)
          WHERE lower(CAST(key AS TEXT)) IN (
            'accesstoken', 'access_token', 'refreshtoken', 'refresh_token',
            'token', 'credential', 'credentials', 'secret'
          )
        );
      END;

      CREATE TRIGGER human_account_profiles_reject_secrets_update
      BEFORE UPDATE OF profile_json ON human_account_profiles
      BEGIN
        SELECT RAISE(ABORT, 'secret-bearing account profile is forbidden')
        WHERE EXISTS (
          SELECT 1 FROM json_tree(NEW.profile_json)
          WHERE lower(CAST(key AS TEXT)) IN (
            'accesstoken', 'access_token', 'refreshtoken', 'refresh_token',
            'token', 'credential', 'credentials', 'secret'
          )
        );
      END;

      CREATE TABLE human_account_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        credential_generation INTEGER NOT NULL
          CHECK (credential_generation >= 0),
        metadata_json TEXT NOT NULL CHECK (
          json_valid(metadata_json)
          AND json_type(metadata_json, '$.version') = 'integer'
          AND json_extract(metadata_json, '$.version') = 1
          AND json_type(metadata_json, '$.revision') = 'integer'
          AND json_extract(metadata_json, '$.revision') = revision
          AND json_type(
            metadata_json, '$.credentialGeneration'
          ) = 'integer'
          AND json_extract(
            metadata_json, '$.credentialGeneration'
          ) = credential_generation
          AND coalesce(
            json_type(metadata_json, '$.profile'), 'missing'
          ) IN ('null', 'object')
        ),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
      ) STRICT;

      CREATE TABLE human_custody_metadata (
        service TEXT NOT NULL,
        name TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        latest_generation INTEGER NOT NULL CHECK (latest_generation >= 0),
        journal_json TEXT NOT NULL CHECK (
          json_valid(journal_json)
          AND json_type(journal_json, '$.version') = 'integer'
          AND json_extract(journal_json, '$.version') = 1
          AND json_type(journal_json, '$.revision') = 'integer'
          AND json_extract(journal_json, '$.revision') = revision
          AND json_type(
            journal_json, '$.latestGeneration'
          ) = 'integer'
          AND json_extract(
            journal_json, '$.latestGeneration'
          ) = latest_generation
          AND json_type(journal_json, '$.service') = 'text'
          AND json_extract(journal_json, '$.service') = service
          AND json_type(journal_json, '$.name') = 'text'
          AND json_extract(journal_json, '$.name') = name
        ),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
        PRIMARY KEY (service, name)
      ) STRICT;

      CREATE TRIGGER human_account_metadata_reject_secrets_insert
      BEFORE INSERT ON human_account_metadata
      BEGIN
        SELECT RAISE(ABORT, 'secret-bearing account metadata is forbidden')
        WHERE EXISTS (
          SELECT 1 FROM json_tree(NEW.metadata_json)
          WHERE lower(CAST(key AS TEXT)) IN (
            'accesstoken', 'access_token', 'refreshtoken', 'refresh_token',
            'token', 'credential', 'credentials', 'secret'
          )
        );
      END;

      CREATE TRIGGER human_account_metadata_reject_secrets_update
      BEFORE UPDATE OF metadata_json ON human_account_metadata
      BEGIN
        SELECT RAISE(ABORT, 'secret-bearing account metadata is forbidden')
        WHERE EXISTS (
          SELECT 1 FROM json_tree(NEW.metadata_json)
          WHERE lower(CAST(key AS TEXT)) IN (
            'accesstoken', 'access_token', 'refreshtoken', 'refresh_token',
            'token', 'credential', 'credentials', 'secret'
          )
        );
      END;

      CREATE TRIGGER human_custody_metadata_reject_secrets_insert
      BEFORE INSERT ON human_custody_metadata
      BEGIN
        SELECT RAISE(ABORT, 'secret-bearing custody metadata is forbidden')
        WHERE EXISTS (
          SELECT 1 FROM json_tree(NEW.journal_json)
          WHERE lower(CAST(key AS TEXT)) IN (
            'accesstoken', 'access_token', 'refreshtoken', 'refresh_token',
            'token', 'credential', 'credentials', 'secret'
          )
        );
      END;

      CREATE TRIGGER human_custody_metadata_reject_secrets_update
      BEFORE UPDATE OF journal_json ON human_custody_metadata
      BEGIN
        SELECT RAISE(ABORT, 'secret-bearing custody metadata is forbidden')
        WHERE EXISTS (
          SELECT 1 FROM json_tree(NEW.journal_json)
          WHERE lower(CAST(key AS TEXT)) IN (
            'accesstoken', 'access_token', 'refreshtoken', 'refresh_token',
            'token', 'credential', 'credentials', 'secret'
          )
        );
      END;

      CREATE TABLE cloud_invalidation_heads (
        workspace_id TEXT PRIMARY KEY,
        account_user_id TEXT NOT NULL,
        credential_generation INTEGER NOT NULL
          CHECK (credential_generation >= 0),
        projection_head INTEGER NOT NULL CHECK (projection_head >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
      ) STRICT;

      CREATE INDEX cloud_invalidation_heads_account_idx
        ON cloud_invalidation_heads(
          account_user_id, credential_generation, workspace_id
        );

      CREATE TABLE human_organization_operations (
        operation_id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (
          length(name) >= 1 AND length(name) <= 160 AND trim(name) = name
        ),
        http_idempotency_key TEXT NOT NULL UNIQUE CHECK (
          length(http_idempotency_key) = 36
          AND lower(http_idempotency_key) = http_idempotency_key
          AND http_idempotency_key NOT GLOB '*[^0-9a-f-]*'
          AND substr(http_idempotency_key, 15, 1) = '7'
          AND substr(http_idempotency_key, 20, 1) GLOB '[89ab]'
          AND substr(http_idempotency_key, 9, 1) = '-'
          AND substr(http_idempotency_key, 14, 1) = '-'
          AND substr(http_idempotency_key, 19, 1) = '-'
          AND substr(http_idempotency_key, 24, 1) = '-'
        ),
        state TEXT NOT NULL CHECK (state IN (
          'started', 'succeeded', 'failed'
        )),
        response_json TEXT CHECK (
          response_json IS NULL
          OR (
            json_valid(response_json)
            AND length(CAST(response_json AS BLOB)) <= 524288
          )
        ),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        completed_at INTEGER CHECK (
          completed_at IS NULL OR completed_at >= created_at
        ),
        CHECK (
          (state = 'started' AND completed_at IS NULL)
          OR (state <> 'started' AND completed_at IS NOT NULL)
        )
      ) STRICT;

      CREATE TRIGGER human_organization_operations_reject_secrets_insert
      BEFORE INSERT ON human_organization_operations
      WHEN NEW.response_json IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'secret-bearing organization response is forbidden')
        WHERE EXISTS (
          SELECT 1 FROM json_tree(NEW.response_json)
          WHERE lower(CAST(key AS TEXT)) IN (
            'accesstoken', 'access_token', 'refreshtoken', 'refresh_token',
            'token', 'credential', 'credentials', 'secret'
          )
        );
      END;

      CREATE TRIGGER human_organization_operations_reject_secrets_update
      BEFORE UPDATE OF response_json ON human_organization_operations
      WHEN NEW.response_json IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'secret-bearing organization response is forbidden')
        WHERE EXISTS (
          SELECT 1 FROM json_tree(NEW.response_json)
          WHERE lower(CAST(key AS TEXT)) IN (
            'accesstoken', 'access_token', 'refreshtoken', 'refresh_token',
            'token', 'credential', 'credentials', 'secret'
          )
        );
      END;

      CREATE TABLE cloud_human_operation_receipts (
        operation_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        command_kind TEXT NOT NULL,
        keyed_command_digest TEXT NOT NULL CHECK (
          length(keyed_command_digest) = 64
          AND keyed_command_digest NOT GLOB '*[^0-9a-f]*'
        ),
        http_idempotency_key TEXT NOT NULL UNIQUE CHECK (
          length(http_idempotency_key) = 36
          AND lower(http_idempotency_key) = http_idempotency_key
          AND http_idempotency_key NOT GLOB '*[^0-9a-f-]*'
          AND substr(http_idempotency_key, 15, 1) = '7'
          AND substr(http_idempotency_key, 20, 1) GLOB '[89ab]'
          AND substr(http_idempotency_key, 9, 1) = '-'
          AND substr(http_idempotency_key, 14, 1) = '-'
          AND substr(http_idempotency_key, 19, 1) = '-'
          AND substr(http_idempotency_key, 24, 1) = '-'
        ),
        state TEXT NOT NULL CHECK (state IN (
          'started', 'succeeded', 'failed', 'ambiguous'
        )),
        response_json TEXT CHECK (
          response_json IS NULL
          OR (
            json_valid(response_json)
            AND length(CAST(response_json AS BLOB)) <= 524288
          )
        ),
        outcome_code TEXT,
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        completed_at INTEGER CHECK (
          completed_at IS NULL OR completed_at >= created_at
        ),
        CHECK (
          (state = 'started' AND completed_at IS NULL)
          OR (state <> 'started' AND completed_at IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX cloud_human_operation_workspace_idx
        ON cloud_human_operation_receipts(
          workspace_id, created_at, operation_id
        );
    `,
  },
  {
    version: 16,
    name: "local-promotion-rejection-proofs",
    sql: `
      CREATE TABLE local_promotion_rejection_proofs_v2 (
        promotion_id TEXT PRIMARY KEY
          REFERENCES local_promotion_sessions(promotion_id) ON DELETE CASCADE,
        source_workspace_id TEXT NOT NULL,
        staging_workspace_id TEXT NOT NULL,
        manifest_root_digest TEXT NOT NULL CHECK (
          length(manifest_root_digest) = 71
          AND substr(manifest_root_digest, 1, 7) = 'sha256_'
          AND substr(manifest_root_digest, 8) NOT GLOB '*[^0-9a-f]*'
        ),
        rejection_code TEXT NOT NULL CHECK (rejection_code IN (
          'authorization_lost', 'staged_entity_invalid',
          'family_digest_mismatch', 'projection_incomplete',
          'projection_failed'
        )),
        state_json TEXT NOT NULL CHECK (
          json_valid(state_json)
          AND length(CAST(state_json AS BLOB)) <= 524288
        ),
        observed_at INTEGER NOT NULL CHECK (observed_at >= 0)
      ) STRICT;
    `,
  },
  {
    version: 17,
    name: "dispatch-runner-pending-heartbeats",
    sql: `
      CREATE TABLE dispatch_runner_pending_heartbeats (
        runner_public_id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        boot_id TEXT NOT NULL,
        boot_generation INTEGER NOT NULL CHECK (boot_generation > 0),
        heartbeat_sequence INTEGER NOT NULL CHECK (heartbeat_sequence > 0),
        request_json TEXT NOT NULL CHECK (
          json_valid(request_json)
          AND length(CAST(request_json AS BLOB)) <= 524288
        ),
        prepared_at TEXT NOT NULL,
        FOREIGN KEY (installation_id)
          REFERENCES dispatch_runner_installation(installation_id)
          ON DELETE CASCADE
      ) STRICT;
    `,
  },
  {
    version: 18,
    name: "app-release-compatibility",
    sql: `
      CREATE TABLE app_release_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        format_version INTEGER NOT NULL CHECK (format_version = 1),
        last_writer_version TEXT NOT NULL CHECK (
          length(last_writer_version) >= 5
          AND length(last_writer_version) <= 64
        ),
        last_writer_build INTEGER NOT NULL CHECK (last_writer_build > 0),
        minimum_reader_version TEXT NOT NULL CHECK (
          length(minimum_reader_version) >= 5
          AND length(minimum_reader_version) <= 64
        ),
        minimum_reader_build INTEGER NOT NULL CHECK (minimum_reader_build > 0),
        migration_version INTEGER NOT NULL CHECK (migration_version > 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
      ) STRICT;
    `,
  },
  {
    version: 19,
    name: "human-organization-operation-aliases",
    sql: `
      CREATE TABLE human_organization_operation_aliases (
        operation_id TEXT PRIMARY KEY CHECK (
          length(operation_id) >= 1 AND length(operation_id) <= 256
        ),
        canonical_operation_id TEXT NOT NULL
          REFERENCES human_organization_operations(operation_id)
          ON DELETE RESTRICT,
        created_at INTEGER NOT NULL CHECK (created_at >= 0)
      ) STRICT;

      CREATE INDEX human_organization_operation_aliases_canonical_idx
        ON human_organization_operation_aliases(
          canonical_operation_id, created_at, operation_id
        );

      INSERT INTO human_organization_operation_aliases(
        operation_id, canonical_operation_id, created_at
      )
      SELECT operation_id, operation_id, created_at
      FROM human_organization_operations;
    `,
  },
  {
    version: 20,
    name: "local-due-work-generations",
    sql: `
      ALTER TABLE local_due_work
        ADD COLUMN work_generation INTEGER NOT NULL DEFAULT 0
          CHECK (work_generation >= 0);
    `,
  },
  {
    version: 21,
    name: "local-renderer-mutation-attempts",
    sql: `
      CREATE TABLE local_renderer_mutation_attempts (
        attempt_id TEXT PRIMARY KEY CHECK (
          length(attempt_id) >= 11 AND length(attempt_id) <= 96
        ),
        workspace_id TEXT NOT NULL
          REFERENCES local_workspaces(workspace_id)
          ON DELETE CASCADE,
        command_kind TEXT NOT NULL CHECK (command_kind IN (
          'workspace.rename',
          'task.create',
          'task.create_and_run',
          'task.update',
          'task.cancel',
          'task.reopen',
          'task.assign',
          'task.defer',
          'task.parent_set',
          'task.parent_clear',
          'task.label_add',
          'task.label_remove',
          'task.comment_add',
          'task.reference_add',
          'task.reference_remove',
          'dependency.add',
          'dependency.remove',
          'review.accept',
          'review.reject',
          'dispatch.stop',
          'dispatch.retry',
          'dispatch.resolve_ambiguity',
          'interaction.respond'
        )),
        keyed_fingerprint TEXT NOT NULL CHECK (
          length(keyed_fingerprint) = 71
          AND substr(keyed_fingerprint, 1, 7) = 'sha256_'
          AND substr(keyed_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
        ),
        state TEXT NOT NULL CHECK (
          state IN ('prepared', 'effect_started', 'settled')
        ),
        revision INTEGER NOT NULL CHECK (revision > 0),
        prepared_at INTEGER NOT NULL CHECK (prepared_at >= 0),
        effect_started_at INTEGER CHECK (
          effect_started_at IS NULL OR effect_started_at >= prepared_at
        ),
        settled_at INTEGER CHECK (
          settled_at IS NULL OR settled_at >= prepared_at
        ),
        terminal_outcome TEXT CHECK (
          terminal_outcome IS NULL OR terminal_outcome IN (
            'committed', 'rejected', 'not_applied'
          )
        ),
        CHECK (
          (
            state = 'prepared'
            AND revision = 1
            AND effect_started_at IS NULL
            AND settled_at IS NULL
            AND terminal_outcome IS NULL
          )
          OR (
            state = 'effect_started'
            AND revision >= 2
            AND effect_started_at IS NOT NULL
            AND settled_at IS NULL
            AND terminal_outcome IS NULL
          )
          OR (
            state = 'settled'
            AND revision >= 2
            AND settled_at IS NOT NULL
            AND terminal_outcome IS NOT NULL
            AND (
              terminal_outcome = 'not_applied'
              OR effect_started_at IS NOT NULL
            )
          )
        )
      ) STRICT;

      CREATE UNIQUE INDEX local_renderer_mutation_attempts_open_fingerprint_idx
        ON local_renderer_mutation_attempts(workspace_id, keyed_fingerprint)
        WHERE state != 'settled';

      CREATE UNIQUE INDEX local_renderer_mutation_attempts_open_workspace_idx
        ON local_renderer_mutation_attempts(workspace_id)
        WHERE state != 'settled';

      CREATE INDEX local_renderer_mutation_attempts_open_list_idx
        ON local_renderer_mutation_attempts(
          workspace_id, prepared_at, attempt_id
        )
        WHERE state != 'settled';

      CREATE INDEX local_renderer_mutation_attempts_terminal_idx
        ON local_renderer_mutation_attempts(
          workspace_id, settled_at DESC, attempt_id DESC
        )
        WHERE state = 'settled';
    `,
  },
  {
    version: 22,
    name: "local-renderer-mutation-command-bindings",
    sql: `
      ALTER TABLE local_renderer_mutation_attempts
        ADD COLUMN keyed_command_digest TEXT CHECK (
          keyed_command_digest IS NULL
          OR (
            length(keyed_command_digest) = 71
            AND substr(keyed_command_digest, 1, 7) = 'sha256_'
            AND substr(keyed_command_digest, 8) NOT GLOB '*[^0-9a-f]*'
          )
        );

      CREATE TABLE local_renderer_mutation_quarantines (
        attempt_id TEXT PRIMARY KEY CHECK (
          length(attempt_id) >= 11 AND length(attempt_id) <= 96
        ),
        workspace_id TEXT NOT NULL
          REFERENCES local_workspaces(workspace_id)
          ON DELETE CASCADE,
        command_kind TEXT NOT NULL,
        source_revision INTEGER NOT NULL CHECK (source_revision > 0),
        prepared_at INTEGER NOT NULL CHECK (prepared_at >= 0),
        effect_started_at INTEGER NOT NULL CHECK (
          effect_started_at >= prepared_at
        ),
        quarantined_at INTEGER NOT NULL CHECK (
          quarantined_at >= effect_started_at
        ),
        receipt_outcome TEXT NOT NULL CHECK (
          receipt_outcome IN ('committed', 'rejected')
        ),
        reason TEXT NOT NULL CHECK (reason = 'legacy_unbound_receipt')
      ) STRICT;

      CREATE INDEX local_renderer_mutation_quarantines_workspace_idx
        ON local_renderer_mutation_quarantines(
          workspace_id, quarantined_at DESC, attempt_id DESC
        );
    `,
  },
  {
    version: 23,
    name: "dispatch-managed-workspace-provenance",
    sql: `
      ALTER TABLE dispatch_bindings
        ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'legacy_unbound'
          CHECK (execution_mode IN ('managed_worktree', 'legacy_unbound'));

      UPDATE dispatch_bindings
      SET execution_mode = 'managed_worktree'
      WHERE lane_id IS NOT NULL AND branch_name IS NOT NULL;

      UPDATE dispatch_bindings
      SET
        execution_mode = 'managed_worktree',
        lane_id = run_id,
        base_sha = (
          SELECT lease.base_sha
          FROM workspace_leases AS lease
          WHERE lease.lane_id = dispatch_bindings.run_id
        ),
        branch_name = (
          SELECT lease.branch_name
          FROM workspace_leases AS lease
          WHERE lease.lane_id = dispatch_bindings.run_id
        )
      WHERE
        stage = 'reserved'
        AND lane_id IS NULL
        AND branch_name IS NULL
        AND EXISTS (
          SELECT 1
          FROM workspace_leases AS lease
          JOIN repository_bindings AS repository
            ON repository.repository_public_id = dispatch_bindings.repository_public_id
            AND repository.project_id = lease.project_id
          JOIN projects AS project
            ON project.project_id = lease.project_id
            AND project.canonical_repository_path = repository.canonical_repository_path
            AND project.canonical_git_common_dir = repository.canonical_git_common_dir
          WHERE
            lease.lane_id = dispatch_bindings.run_id
            AND lease.mode = 'managed_dispatch'
            AND lease.status IN ('provisioning', 'ready')
            AND lease.retention = 'preserve'
            AND lease.branch_name = 'codex/oprte-' || dispatch_bindings.run_id
            AND lease.recovery_manifest_path IS NOT NULL
            AND length(lease.recovery_manifest_path) > 0
            AND length(lease.base_sha) BETWEEN 40 AND 64
            AND lease.base_sha NOT GLOB '*[^a-f0-9]*'
            AND (
              dispatch_bindings.base_sha IS NULL
              OR dispatch_bindings.base_sha = lease.base_sha
            )
        );

      ALTER TABLE local_run_execution_bindings
        ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'legacy_unbound'
          CHECK (execution_mode IN ('managed_worktree', 'legacy_unbound'));

      UPDATE local_run_execution_bindings
      SET execution_mode = 'managed_worktree'
      WHERE lane_id IS NOT NULL AND branch_name IS NOT NULL;
    `,
  },
  {
    version: 24,
    name: "durable-chat-panes",
    sql: `
      CREATE TABLE chat_panes (
        pane_id TEXT PRIMARY KEY CHECK (
          length(pane_id) BETWEEN 12 AND 96
          AND pane_id GLOB 'pane_[A-Za-z0-9_-]*'
          AND substr(pane_id, 6) NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        repository_id TEXT NOT NULL CHECK (
          length(repository_id) BETWEEN 1 AND 128
          AND instr(repository_id, char(0)) = 0
        ),
        repository_name TEXT NOT NULL CHECK (
          length(repository_name) BETWEEN 1 AND 160
          AND instr(repository_name, char(0)) = 0
        ),
        revision INTEGER NOT NULL CHECK (revision > 0),
        title TEXT NOT NULL CHECK (
          length(title) BETWEEN 1 AND 160
          AND instr(title, char(0)) = 0
        ),
        account_profile_id TEXT
          REFERENCES account_profiles(profile_id) ON DELETE SET NULL,
        model TEXT NOT NULL DEFAULT 'gpt-5.6-sol'
          CHECK (model = 'gpt-5.6-sol'),
        reasoning_effort TEXT NOT NULL
          CHECK (reasoning_effort IN ('ultra', 'max')),
        state TEXT NOT NULL CHECK (state IN (
          'ready', 'starting', 'streaming', 'continuing', 'attention'
        )),
        provider_account_profile_id TEXT
          REFERENCES account_profiles(profile_id) ON DELETE SET NULL,
        provider_thread_id TEXT CHECK (
          provider_thread_id IS NULL OR (
            length(provider_thread_id) BETWEEN 1 AND 512
            AND instr(provider_thread_id, char(0)) = 0
          )
        ),
        provider_restart_thread_id TEXT CHECK (
          provider_restart_thread_id IS NULL OR (
            length(provider_restart_thread_id) BETWEEN 1 AND 512
            AND instr(provider_restart_thread_id, char(0)) = 0
          )
        ),
        active_turn_id TEXT CHECK (
          active_turn_id IS NULL OR (
            length(active_turn_id) BETWEEN 16 AND 96
            AND active_turn_id GLOB 'chatturn_[A-Za-z0-9_-]*'
            AND substr(active_turn_id, 10) NOT GLOB '*[^A-Za-z0-9_-]*'
          )
        ),
        active_provider_turn_id TEXT CHECK (
          active_provider_turn_id IS NULL OR (
            length(active_provider_turn_id) BETWEEN 1 AND 512
            AND instr(active_provider_turn_id, char(0)) = 0
          )
        ),
        active_prompt TEXT CHECK (
          active_prompt IS NULL OR instr(active_prompt, char(0)) = 0
        ),
        turn_status TEXT CHECK (
          turn_status IS NULL OR turn_status IN (
            'starting', 'streaming', 'continuing', 'completed', 'failed'
          )
        ),
        turn_started_at TEXT,
        turn_completed_at TEXT,
        continuation_count INTEGER NOT NULL DEFAULT 0 CHECK (
          continuation_count BETWEEN 0 AND 63
        ),
        response_tail TEXT NOT NULL DEFAULT '',
        response_total_utf8_bytes INTEGER NOT NULL DEFAULT 0 CHECK (
          response_total_utf8_bytes >= 0
        ),
        assistant_item_id TEXT CHECK (
          assistant_item_id IS NULL OR (
            length(assistant_item_id) BETWEEN 13 AND 96
            AND assistant_item_id GLOB 'item_[A-Za-z0-9_-]*'
            AND substr(assistant_item_id, 6) NOT GLOB '*[^A-Za-z0-9_-]*'
          )
        ),
        assistant_item_stream_text TEXT NOT NULL DEFAULT '' CHECK (
          instr(assistant_item_stream_text, char(0)) = 0
        ),
        assistant_item_stream_utf8_bytes INTEGER NOT NULL DEFAULT 0 CHECK (
          assistant_item_stream_utf8_bytes BETWEEN 0 AND 262144
        ),
        assistant_item_stream_overflow INTEGER NOT NULL DEFAULT 0 CHECK (
          assistant_item_stream_overflow IN (0, 1)
        ),
        assistant_item_verified INTEGER NOT NULL DEFAULT 0 CHECK (
          assistant_item_verified IN (0, 1)
        ),
        active_turn_poisoned INTEGER NOT NULL DEFAULT 0 CHECK (
          active_turn_poisoned IN (0, 1)
        ),
        reasoning_tail TEXT NOT NULL DEFAULT '',
        reasoning_total_utf8_bytes INTEGER NOT NULL DEFAULT 0 CHECK (
          reasoning_total_utf8_bytes >= 0
        ),
        tools_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tools_json)),
        visited_account_ids_json TEXT NOT NULL DEFAULT '[]'
          CHECK (json_valid(visited_account_ids_json)),
        attention_code TEXT CHECK (
          attention_code IS NULL OR attention_code IN (
            'account_required',
            'account_unavailable',
            'usage_limit_reached',
            'all_accounts_exhausted',
            'continuation_failed',
            'approval_required',
            'runtime_unavailable',
            'turn_failed'
          )
        ),
        attention_message TEXT CHECK (
          attention_message IS NULL OR length(attention_message) BETWEEN 1 AND 240
        ),
        attention_retryable INTEGER CHECK (
          attention_retryable IS NULL OR attention_retryable IN (0, 1)
        ),
        history_truncated INTEGER NOT NULL DEFAULT 0
          CHECK (history_truncated IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (provider_account_profile_id IS NULL) = (provider_thread_id IS NULL)
          AND (provider_thread_id IS NULL) = (provider_restart_thread_id IS NULL)
        ),
        CHECK (
          assistant_item_id IS NOT NULL OR (
            assistant_item_stream_text = ''
            AND assistant_item_stream_utf8_bytes = 0
            AND assistant_item_stream_overflow = 0
            AND assistant_item_verified = 0
          )
        ),
        CHECK (
          (state = 'attention') = (attention_code IS NOT NULL)
          AND (attention_code IS NULL) = (attention_message IS NULL)
          AND (attention_code IS NULL) = (attention_retryable IS NULL)
        ),
        CHECK (
          (active_turn_id IS NULL) = (turn_status IS NULL)
          AND (active_turn_id IS NULL) = (turn_started_at IS NULL)
        ),
        CHECK (
          turn_status IS NULL
          OR ((turn_status IN ('completed', 'failed')) = (turn_completed_at IS NOT NULL))
        ),
        CHECK (
          state NOT IN ('starting', 'streaming', 'continuing')
          OR state = turn_status
        )
      ) STRICT;

      CREATE TABLE chat_pane_history (
        pane_id TEXT NOT NULL
          REFERENCES chat_panes(pane_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        text TEXT NOT NULL CHECK (instr(text, char(0)) = 0),
        utf8_bytes INTEGER NOT NULL CHECK (utf8_bytes >= 0),
        created_at TEXT NOT NULL,
        PRIMARY KEY (pane_id, sequence)
      ) STRICT;

      CREATE TABLE chat_turn_receipts (
        pane_id TEXT NOT NULL
          REFERENCES chat_panes(pane_id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL CHECK (
          length(turn_id) BETWEEN 16 AND 96
          AND turn_id GLOB 'chatturn_[A-Za-z0-9_-]*'
          AND substr(turn_id, 10) NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        created_at TEXT NOT NULL,
        PRIMARY KEY (pane_id, turn_id)
      ) STRICT;

      CREATE TABLE chat_assistant_item_receipts (
        pane_id TEXT NOT NULL
          REFERENCES chat_panes(pane_id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL CHECK (
          length(turn_id) BETWEEN 16 AND 96
          AND turn_id GLOB 'chatturn_[A-Za-z0-9_-]*'
          AND substr(turn_id, 10) NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        assistant_item_id TEXT NOT NULL CHECK (
          length(assistant_item_id) BETWEEN 13 AND 96
          AND assistant_item_id GLOB 'item_[A-Za-z0-9_-]*'
          AND substr(assistant_item_id, 6) NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        completion_sha256 TEXT NOT NULL CHECK (
          length(completion_sha256) = 64
          AND completion_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        PRIMARY KEY (pane_id, turn_id, assistant_item_id)
      ) STRICT;

      CREATE INDEX chat_panes_repository_idx
        ON chat_panes(repository_id, created_at, pane_id);
      CREATE UNIQUE INDEX chat_panes_one_provider_thread_idx
        ON chat_panes(provider_account_profile_id, provider_thread_id)
        WHERE provider_thread_id IS NOT NULL;
      CREATE UNIQUE INDEX chat_panes_one_provider_restart_thread_idx
        ON chat_panes(provider_account_profile_id, provider_restart_thread_id)
        WHERE provider_restart_thread_id IS NOT NULL;
      CREATE INDEX chat_pane_history_global_age_idx
        ON chat_pane_history(created_at, pane_id, sequence);
      CREATE INDEX chat_turn_receipts_age_idx
        ON chat_turn_receipts(pane_id, created_at, turn_id);
      CREATE INDEX chat_assistant_item_receipts_turn_idx
        ON chat_assistant_item_receipts(pane_id, turn_id, assistant_item_id);
    `,
  },
  {
    version: 25,
    name: "chat-pane-agent-signals",
    sql: `
      ALTER TABLE chat_panes
        ADD COLUMN agent_index INTEGER CHECK (
          agent_index IS NULL OR agent_index BETWEEN 1 AND 64
        );
      ALTER TABLE chat_panes
        ADD COLUMN activity_ordinal INTEGER NOT NULL DEFAULT 0 CHECK (
          activity_ordinal >= 0
        );
      ALTER TABLE chat_panes
        ADD COLUMN activity_kind TEXT NOT NULL DEFAULT 'idle' CHECK (
          activity_kind IN (
            'idle', 'messageSent', 'thinkingCompleted',
            'toolStarted', 'responseCompleted'
          )
        );
      ALTER TABLE chat_panes
        ADD COLUMN activity_tool_tone TEXT CHECK (
          activity_tool_tone IS NULL OR activity_tool_tone IN (
            'root', 'fifth', 'octave'
          )
        );
      ALTER TABLE chat_panes
        ADD COLUMN tool_start_count INTEGER NOT NULL DEFAULT 0 CHECK (
          tool_start_count >= 0
        );

      UPDATE chat_panes AS pane
      SET agent_index = 1 + (
        SELECT COUNT(*)
        FROM chat_panes AS earlier
        WHERE earlier.created_at < pane.created_at
          OR (
            earlier.created_at = pane.created_at
            AND earlier.pane_id < pane.pane_id
          )
      );

      CREATE UNIQUE INDEX chat_panes_agent_index_idx
        ON chat_panes(agent_index);

      CREATE TRIGGER chat_panes_agent_signal_insert_guard
      BEFORE INSERT ON chat_panes
      WHEN NEW.agent_index IS NULL
        OR ((NEW.activity_kind = 'toolStarted') != (NEW.activity_tool_tone IS NOT NULL))
        OR ((NEW.activity_kind = 'idle') != (NEW.activity_ordinal = 0))
      BEGIN
        SELECT RAISE(ABORT, 'invalid chat pane agent signal state');
      END;

      CREATE TRIGGER chat_panes_agent_signal_update_guard
      BEFORE UPDATE OF agent_index, activity_ordinal, activity_kind, activity_tool_tone
      ON chat_panes
      WHEN NEW.agent_index IS NULL
        OR NEW.agent_index != OLD.agent_index
        OR NEW.activity_ordinal NOT IN (
          OLD.activity_ordinal,
          OLD.activity_ordinal + 1
        )
        OR ((NEW.activity_kind = 'toolStarted') != (NEW.activity_tool_tone IS NOT NULL))
        OR ((NEW.activity_kind = 'idle') != (NEW.activity_ordinal = 0))
      BEGIN
        SELECT RAISE(ABORT, 'invalid chat pane agent signal state');
      END;
    `,
  },
  ...harnessV2Migrations,
  {
    version: 30,
    name: "isolated-chat-pane-workspaces",
    sql: `
      ALTER TABLE chat_panes
        ADD COLUMN workspace_mode TEXT NOT NULL DEFAULT 'legacy_unbound'
          CHECK (workspace_mode IN ('legacy_unbound', 'managed_worktree'));
      ALTER TABLE chat_panes
        ADD COLUMN workspace_state TEXT NOT NULL DEFAULT 'recovery_required'
          CHECK (workspace_state IN (
            'preparing', 'waiting_capacity', 'ready', 'preserved',
            'recovery_required'
          ));
      ALTER TABLE chat_panes
        ADD COLUMN workspace_revision INTEGER NOT NULL DEFAULT 1
          CHECK (workspace_revision > 0);
      ALTER TABLE chat_panes
        ADD COLUMN workspace_recovery_reason TEXT DEFAULT 'legacy_unbound'
          CHECK (
            workspace_recovery_reason IS NULL OR
            workspace_recovery_reason IN (
              'legacy_unbound', 'capacity_unavailable', 'insufficient_disk',
              'base_mismatch', 'binding_mismatch', 'branch_without_lane',
              'checkout_mismatch', 'dirty_checkout', 'invalid_manifest',
              'manifest_missing', 'path_escape', 'repository_mismatch',
              'provision_interrupted', 'lane_missing', 'unknown'
            )
          );
      ALTER TABLE chat_panes ADD COLUMN archived_at TEXT;

      CREATE TRIGGER chat_pane_workspace_projection_insert_guard
      BEFORE INSERT ON chat_panes
      WHEN NOT (
        (
          NEW.workspace_mode = 'legacy_unbound'
          AND NEW.workspace_state = 'recovery_required'
          AND NEW.workspace_recovery_reason = 'legacy_unbound'
        ) OR (
          NEW.workspace_mode = 'managed_worktree'
          AND NEW.workspace_state = 'preparing'
          AND NEW.workspace_recovery_reason IS NULL
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'invalid chat workspace projection');
      END;

      CREATE TRIGGER chat_pane_workspace_projection_update_guard
      BEFORE UPDATE OF workspace_mode, workspace_state, workspace_revision,
        workspace_recovery_reason ON chat_panes
      WHEN (
        (
          NEW.workspace_mode IS NOT OLD.workspace_mode
          OR NEW.workspace_state IS NOT OLD.workspace_state
          OR NEW.workspace_recovery_reason IS NOT OLD.workspace_recovery_reason
        )
        AND NEW.workspace_revision != OLD.workspace_revision + 1
      ) OR (
        NOT (
          NEW.workspace_mode IS NOT OLD.workspace_mode
          OR NEW.workspace_state IS NOT OLD.workspace_state
          OR NEW.workspace_recovery_reason IS NOT OLD.workspace_recovery_reason
        )
        AND NEW.workspace_revision != OLD.workspace_revision
      ) OR (
        NEW.workspace_state IN ('waiting_capacity', 'recovery_required')
      ) != (NEW.workspace_recovery_reason IS NOT NULL)
        OR (
          NEW.workspace_state IN ('preparing', 'ready', 'preserved')
          AND NEW.workspace_recovery_reason IS NOT NULL
        )
        OR (
          OLD.workspace_mode = 'managed_worktree'
          AND NEW.workspace_mode != 'managed_worktree'
        )
        OR (
          NEW.workspace_mode = 'legacy_unbound'
          AND NOT (
            NEW.workspace_state = 'recovery_required'
            AND NEW.workspace_recovery_reason = 'legacy_unbound'
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid chat workspace projection transition');
      END;

      CREATE TRIGGER chat_pane_archive_guard
      BEFORE UPDATE OF archived_at ON chat_panes
      WHEN OLD.archived_at IS NOT NULL
        OR NEW.archived_at IS NULL
        OR NOT (
          (
            NEW.workspace_mode = 'managed_worktree'
            AND NEW.workspace_state = 'preserved'
            AND NEW.workspace_recovery_reason IS NULL
          ) OR (
            NEW.workspace_mode = 'legacy_unbound'
            AND NEW.workspace_state = 'recovery_required'
            AND NEW.workspace_recovery_reason = 'legacy_unbound'
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid chat pane archive transition');
      END;

      DROP INDEX chat_panes_agent_index_idx;
      CREATE UNIQUE INDEX chat_panes_live_agent_index_idx
        ON chat_panes(agent_index)
        WHERE archived_at IS NULL;
      CREATE INDEX chat_panes_live_order_idx
        ON chat_panes(archived_at, created_at, pane_id);

      DROP INDEX chat_panes_one_provider_thread_idx;
      CREATE UNIQUE INDEX chat_panes_one_live_provider_thread_idx
        ON chat_panes(provider_account_profile_id, provider_thread_id)
        WHERE provider_thread_id IS NOT NULL AND archived_at IS NULL;
      DROP INDEX chat_panes_one_provider_restart_thread_idx;
      CREATE UNIQUE INDEX chat_panes_one_live_provider_restart_thread_idx
        ON chat_panes(provider_account_profile_id, provider_restart_thread_id)
        WHERE provider_restart_thread_id IS NOT NULL AND archived_at IS NULL;

      CREATE TABLE chat_pane_workspace_bindings (
        binding_id TEXT PRIMARY KEY CHECK (
          length(binding_id) BETWEEN 16 AND 96
          AND binding_id GLOB 'chatws_[A-Za-z0-9_-]*'
          AND substr(binding_id, 8) NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        pane_id TEXT NOT NULL
          REFERENCES chat_panes(pane_id) ON DELETE RESTRICT,
        repository_id TEXT NOT NULL
          REFERENCES local_repositories(repository_id) ON DELETE RESTRICT,
        project_id TEXT NOT NULL
          REFERENCES projects(project_id) ON DELETE RESTRICT,
        expected_lane_id TEXT NOT NULL UNIQUE CHECK (
          length(expected_lane_id) BETWEEN 8 AND 127
          AND expected_lane_id GLOB '[a-z0-9]*'
          AND expected_lane_id NOT GLOB '*[^a-z0-9_-]*'
        ),
        workspace_lease_id TEXT NOT NULL UNIQUE
          REFERENCES workspace_leases(lane_id) ON DELETE RESTRICT,
        base_sha TEXT NOT NULL CHECK (
          length(base_sha) BETWEEN 40 AND 64
          AND base_sha NOT GLOB '*[^0-9a-f]*'
        ),
        branch_name TEXT NOT NULL CHECK (
          length(branch_name) BETWEEN 1 AND 255
          AND instr(branch_name, char(0)) = 0
        ),
        canonical_repository_path TEXT NOT NULL CHECK (
          length(canonical_repository_path) BETWEEN 1 AND 4096
          AND instr(canonical_repository_path, char(0)) = 0
        ),
        canonical_git_common_dir TEXT NOT NULL CHECK (
          length(canonical_git_common_dir) BETWEEN 1 AND 4096
          AND instr(canonical_git_common_dir, char(0)) = 0
        ),
        canonical_checkout_path TEXT NOT NULL UNIQUE CHECK (
          length(canonical_checkout_path) BETWEEN 1 AND 4096
          AND instr(canonical_checkout_path, char(0)) = 0
        ),
        recovery_manifest_path TEXT NOT NULL UNIQUE CHECK (
          length(recovery_manifest_path) BETWEEN 1 AND 4096
          AND instr(recovery_manifest_path, char(0)) = 0
        ),
        state TEXT NOT NULL CHECK (state IN (
          'provisioning', 'ready', 'preserved', 'quarantined',
          'recovery_required'
        )),
        revision INTEGER NOT NULL CHECK (revision > 0),
        recovery_reason TEXT CHECK (
          recovery_reason IS NULL OR recovery_reason IN (
            'capacity_unavailable', 'insufficient_disk', 'base_mismatch',
            'binding_mismatch', 'branch_without_lane', 'checkout_mismatch',
            'dirty_checkout', 'invalid_manifest', 'manifest_missing',
            'path_escape', 'repository_mismatch', 'provision_interrupted',
            'lane_missing', 'unknown'
          )
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          workspace_lease_id = expected_lane_id
        ),
        CHECK (
          (state IN ('quarantined', 'recovery_required'))
          = (recovery_reason IS NOT NULL)
        )
      ) STRICT;

      CREATE UNIQUE INDEX chat_pane_workspace_one_active_idx
        ON chat_pane_workspace_bindings(pane_id)
        WHERE state != 'preserved';
      CREATE INDEX chat_pane_workspace_state_idx
        ON chat_pane_workspace_bindings(state, updated_at, binding_id);

      CREATE TRIGGER chat_pane_workspace_insert_guard
      BEFORE INSERT ON chat_pane_workspace_bindings
      WHEN NOT EXISTS (
        SELECT 1 FROM chat_panes AS pane
        WHERE pane.pane_id = NEW.pane_id
          AND pane.repository_id = NEW.repository_id
          AND pane.workspace_mode = 'managed_worktree'
          AND pane.archived_at IS NULL
          AND EXISTS (
            SELECT 1 FROM local_repositories AS repository
            JOIN projects AS project
              ON project.project_id = NEW.project_id
            WHERE repository.repository_id = NEW.repository_id
              AND repository.tombstoned_at IS NULL
              AND repository.canonical_repository_path =
                NEW.canonical_repository_path
              AND repository.canonical_git_common_dir =
                NEW.canonical_git_common_dir
              AND project.canonical_repository_path =
                NEW.canonical_repository_path
              AND project.canonical_git_common_dir =
                NEW.canonical_git_common_dir
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'chat workspace binding lacks pane authority');
      END;

      CREATE TRIGGER chat_pane_workspace_repository_guard
      BEFORE UPDATE OF repository_id, workspace_mode ON chat_panes
      WHEN EXISTS (
        SELECT 1 FROM chat_pane_workspace_bindings AS binding
        WHERE binding.pane_id = OLD.pane_id
          AND binding.state != 'preserved'
      ) AND (
        NEW.repository_id != OLD.repository_id
        OR NEW.workspace_mode != 'managed_worktree'
      )
      BEGIN
        SELECT RAISE(ABORT, 'bound chat workspace repository is immutable');
      END;
    `,
  },
  {
    version: 31,
    name: "encrypted-multi-device-session-observation",
    sql: SESSION_SYNC_SCHEMA_SQL,
  },
  {
    version: 32,
    name: "session-sync-crash-journal-and-reservation-rebind",
    sql: SESSION_SYNC_OPERATION_SCHEMA_SQL,
  },
  {
    version: 33,
    name: "session-sync-storage-boundaries",
    sql: SESSION_SYNC_HARDENING_SCHEMA_SQL,
  },
  {
    version: 34,
    name: "session-sync-human-scope-authority",
    sql: SESSION_SYNC_HUMAN_SCOPE_SCHEMA_SQL,
  },
  {
    version: 35,
    name: "account-profile-capacity-recovery",
    sql: `
      CREATE TABLE account_profile_capacity_quarantine (
        profile_id TEXT PRIMARY KEY
          REFERENCES account_profiles(profile_id) ON DELETE RESTRICT,
        reason TEXT NOT NULL CHECK (reason = 'legacy_capacity_overflow'),
        evidence_revision INTEGER NOT NULL CHECK (evidence_revision > 0),
        original_removed_at TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

      INSERT INTO account_profile_capacity_quarantine (
        profile_id, reason, evidence_revision, original_removed_at, created_at
      )
      SELECT profile_id, 'legacy_capacity_overflow', revision, removed_at, created_at
      FROM (
        SELECT
          profile_id, revision, removed_at, created_at,
          ROW_NUMBER() OVER (
            ORDER BY
              CASE
                WHEN removed_at IS NULL AND selected = 1 THEN 0
                WHEN removed_at IS NULL THEN 1
                ELSE 2
              END,
              CASE WHEN removed_at IS NULL THEN created_at ELSE removed_at END,
              profile_id
          ) AS recovery_rank
        FROM account_profiles
        WHERE removed_at IS NULL
           OR (removed_at IS NOT NULL AND local_data_deleted_at IS NULL)
      ) AS ranked
      WHERE recovery_rank > 64;

      CREATE VIEW runtime_visible_account_profiles AS
      SELECT profile.*
      FROM account_profiles AS profile
      WHERE NOT EXISTS (
        SELECT 1 FROM account_profile_capacity_quarantine AS quarantine
        WHERE quarantine.profile_id = profile.profile_id
      );
    `,
  },
  {
    version: 36,
    name: "harness-actor-reconciliation-target-indexes",
    sql: `
      CREATE INDEX harness_actor_operations_actor_recovery_idx
        ON harness_actor_operations(actor_id, operation_id);
      CREATE INDEX harness_actor_operations_turn_recovery_idx
        ON harness_actor_operations(turn_id, operation_id)
        WHERE turn_id IS NOT NULL;
    `,
  },
  {
    version: 37,
    name: "legacy-keychain-identity-quarantine",
    sql: `
      CREATE TABLE human_custody_pointer_quarantine (
        service TEXT NOT NULL,
        name TEXT NOT NULL,
        pointer_kind TEXT NOT NULL CHECK (pointer_kind IN (
          'committed', 'pending', 'deleting'
        )),
        generation INTEGER NOT NULL CHECK (generation >= 0),
        slot TEXT NOT NULL CHECK (
          length(slot) BETWEEN 16 AND 128
          AND slot NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        source_revision INTEGER NOT NULL CHECK (source_revision >= 0),
        reason TEXT NOT NULL CHECK (
          reason IN (
            'legacy_identity_access_denied',
            'invalid_pointer_preserved',
            'missing_pointer_abandoned'
          )
        ),
        quarantined_at INTEGER NOT NULL CHECK (quarantined_at >= 0),
        PRIMARY KEY (service, name, slot),
        UNIQUE (service, name, generation),
        FOREIGN KEY (service, name)
          REFERENCES human_custody_metadata(service, name)
          ON DELETE RESTRICT
      ) STRICT;

      CREATE INDEX human_custody_pointer_quarantine_service_idx
        ON human_custody_pointer_quarantine(
          service, quarantined_at, name, generation
        );

      CREATE TRIGGER human_custody_pointer_quarantine_immutable_update
      BEFORE UPDATE ON human_custody_pointer_quarantine
      BEGIN
        SELECT RAISE(ABORT, 'custody quarantine evidence is immutable');
      END;

      CREATE TRIGGER human_custody_pointer_quarantine_immutable_delete
      BEFORE DELETE ON human_custody_pointer_quarantine
      BEGIN
        SELECT RAISE(ABORT, 'custody quarantine evidence is immutable');
      END;
    `,
  },
  {
    version: 38,
    name: "remove-chat-audio-cues",
    sql: `
      DROP TRIGGER chat_panes_agent_signal_insert_guard;
      DROP TRIGGER chat_panes_agent_signal_update_guard;
      DROP INDEX chat_panes_live_agent_index_idx;

      ALTER TABLE chat_panes DROP COLUMN agent_index;
      ALTER TABLE chat_panes DROP COLUMN activity_tool_tone;
      ALTER TABLE chat_panes DROP COLUMN tool_start_count;

      CREATE TRIGGER chat_panes_activity_insert_guard
      BEFORE INSERT ON chat_panes
      WHEN ((NEW.activity_kind = 'idle') != (NEW.activity_ordinal = 0))
      BEGIN
        SELECT RAISE(ABORT, 'invalid chat pane activity state');
      END;

      CREATE TRIGGER chat_panes_activity_update_guard
      BEFORE UPDATE OF activity_ordinal, activity_kind ON chat_panes
      WHEN NEW.activity_ordinal NOT IN (
        OLD.activity_ordinal,
        OLD.activity_ordinal + 1
      )
        OR ((NEW.activity_kind = 'idle') != (NEW.activity_ordinal = 0))
      BEGIN
        SELECT RAISE(ABORT, 'invalid chat pane activity state');
      END;
    `,
  },
  {
    version: 39,
    name: "durable-chat-pane-order",
    sql: `
      ALTER TABLE chat_panes
        ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0
          CHECK (display_order >= 0);

      WITH ordered AS (
        SELECT pane_id, ROW_NUMBER() OVER (
          ORDER BY created_at, pane_id
        ) - 1 AS display_order
        FROM chat_panes
        WHERE archived_at IS NULL
      )
      UPDATE chat_panes
      SET display_order = (
        SELECT ordered.display_order
        FROM ordered
        WHERE ordered.pane_id = chat_panes.pane_id
      )
      WHERE archived_at IS NULL;

      CREATE UNIQUE INDEX chat_panes_live_display_order_idx
        ON chat_panes(display_order)
        WHERE archived_at IS NULL;
    `,
  },
  {
    version: 40,
    name: "automatic-chat-account-routing",
    sql: `
      UPDATE chat_panes
      SET account_profile_id = provider_account_profile_id
      WHERE interaction_mode = 'chat'
        AND state IN ('ready', 'attention')
        AND active_turn_poisoned = 0;
    `,
  },
  {
    version: 41,
    name: "chat-service-tier",
    sql: `
      ALTER TABLE chat_panes
        ADD COLUMN service_tier TEXT NOT NULL DEFAULT 'standard'
          CHECK (service_tier IN ('standard', 'fast'));
    `,
  },
  {
    version: 42,
    name: "tokenmaxxing-metaharness-policy-evidence",
    sql: `
      ALTER TABLE harness_settings
        ADD COLUMN automatic_fast_mode TEXT NOT NULL DEFAULT 'criticalPath'
          CHECK (automatic_fast_mode IN ('off', 'criticalPath'));

      ALTER TABLE harness_actors
        ADD COLUMN dispatch_policy_version INTEGER NOT NULL DEFAULT 0
          CHECK (dispatch_policy_version IN (0, 1));
      ALTER TABLE harness_actors
        ADD COLUMN work_class TEXT NOT NULL DEFAULT 'legacyUnclassified'
          CHECK (work_class IN (
            'legacyUnclassified', 'largeChange', 'wideResearch',
            'standard', 'boundedLeaf'
          ));

      ALTER TABLE harness_actor_incarnations
        ADD COLUMN requested_model TEXT NOT NULL DEFAULT 'gpt-5.6-sol'
          CHECK (requested_model IN ('gpt-5.6-sol', 'gpt-5.6-luna'));
      ALTER TABLE harness_actor_incarnations
        ADD COLUMN requested_reasoning_effort TEXT NOT NULL DEFAULT 'ultra'
          CHECK (requested_reasoning_effort IN ('ultra', 'max'));
      ALTER TABLE harness_actor_incarnations
        ADD COLUMN profile_fallback_reason TEXT
          CHECK (
            profile_fallback_reason IS NULL
            OR profile_fallback_reason = 'lunaUnavailable'
          );
      ALTER TABLE harness_actor_incarnations
        ADD COLUMN capability_evidence_digest TEXT CHECK (
          capability_evidence_digest IS NULL OR (
            length(capability_evidence_digest) = 64
            AND capability_evidence_digest NOT GLOB '*[^0-9a-f]*'
          )
        );
      ALTER TABLE harness_actor_incarnations
        ADD COLUMN supports_fast INTEGER
          CHECK (supports_fast IS NULL OR supports_fast IN (0, 1));
      ALTER TABLE harness_actor_incarnations
        ADD COLUMN observed_model TEXT
          CHECK (observed_model IS NULL OR observed_model IN (
            'gpt-5.6-sol', 'gpt-5.6-luna'
          ));
      ALTER TABLE harness_actor_incarnations
        ADD COLUMN observed_reasoning_effort TEXT
          CHECK (observed_reasoning_effort IS NULL OR
            observed_reasoning_effort IN ('ultra', 'max'));
      ALTER TABLE harness_actor_incarnations
        ADD COLUMN observed_profile_state TEXT NOT NULL DEFAULT 'unknown'
          CHECK (observed_profile_state IN ('unknown', 'exact', 'rerouted'));
      ALTER TABLE harness_actor_incarnations
        ADD COLUMN observed_profile_at TEXT;
      ALTER TABLE harness_actor_incarnations
        ADD COLUMN token_usage_cumulative_cached_input_tokens INTEGER
          CHECK (
            token_usage_cumulative_cached_input_tokens IS NULL OR
            token_usage_cumulative_cached_input_tokens >= 0
          );
      ALTER TABLE harness_actor_incarnations
        ADD COLUMN token_usage_cumulative_reasoning_output_tokens INTEGER
          CHECK (
            token_usage_cumulative_reasoning_output_tokens IS NULL OR
            token_usage_cumulative_reasoning_output_tokens >= 0
          );

      ALTER TABLE harness_actor_session_bindings
        ADD COLUMN live_capability_evidence_digest TEXT CHECK (
          live_capability_evidence_digest IS NULL OR (
            length(live_capability_evidence_digest) = 64
            AND live_capability_evidence_digest NOT GLOB '*[^0-9a-f]*'
          )
        );
      ALTER TABLE harness_actor_session_bindings
        ADD COLUMN live_supports_fast INTEGER CHECK (
          live_supports_fast IS NULL OR live_supports_fast IN (0, 1)
        );
      UPDATE harness_actor_session_bindings
      SET live_capability_evidence_digest = (
            SELECT incarnation.capability_evidence_digest
            FROM harness_actor_incarnations AS incarnation
            WHERE incarnation.incarnation_id =
              harness_actor_session_bindings.incarnation_id
          ),
          live_supports_fast = (
            SELECT incarnation.supports_fast
            FROM harness_actor_incarnations AS incarnation
            WHERE incarnation.incarnation_id =
              harness_actor_session_bindings.incarnation_id
          );

      DROP TRIGGER harness_actor_session_binding_insert_guard;
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
          JOIN harness_actors AS actor
            ON actor.actor_id = NEW.actor_id
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
            AND (
              (actor.dispatch_policy_version = 0
                AND incarnation.capability_evidence_digest IS NULL
                AND incarnation.supports_fast IS NULL
                AND NEW.live_capability_evidence_digest IS NULL
                AND NEW.live_supports_fast IS NULL)
              OR
              (actor.dispatch_policy_version = 1
                AND incarnation.capability_evidence_digest IS NOT NULL
                AND incarnation.supports_fast IS NOT NULL
                AND NEW.live_capability_evidence_digest IS NOT NULL
                AND NEW.live_supports_fast IS NOT NULL
                AND (
                  NEW.live_generation > NEW.admission_generation
                  OR (
                    NEW.live_capability_evidence_digest =
                      incarnation.capability_evidence_digest
                    AND NEW.live_supports_fast = incarnation.supports_fast
                  )
                ))
            )
            AND incarnation.state IN ('idle', 'running')
            AND workspace.actor_id = NEW.actor_id
            AND workspace.state = 'active'
        )
      BEGIN
        SELECT RAISE(ABORT, 'actor session binding lineage is incoherent');
      END;

      DROP TRIGGER harness_actor_session_binding_transition_guard;
      CREATE TRIGGER harness_actor_session_binding_transition_guard
      BEFORE UPDATE ON harness_actor_session_bindings
      WHEN NEW.revision != OLD.revision + 1
        OR NEW.updated_at < OLD.updated_at
        OR OLD.state != 'bound'
        OR NOT (
          (NEW.state = 'bound'
            AND NEW.live_generation >= OLD.live_generation
            AND NEW.live_capability_evidence_digest IS NOT NULL
            AND NEW.live_supports_fast IS NOT NULL
            AND (
              NEW.live_generation > OLD.live_generation
              OR (
                NEW.live_capability_evidence_digest =
                  OLD.live_capability_evidence_digest
                AND NEW.live_supports_fast = OLD.live_supports_fast
              )
              OR (
                OLD.live_capability_evidence_digest IS NULL
                AND OLD.live_supports_fast IS NULL
                AND OLD.revision = 1
                AND OLD.recovered_at IS NULL
                AND (
                  SELECT actor.dispatch_policy_version
                  FROM harness_actors AS actor
                  WHERE actor.actor_id = OLD.actor_id
                ) = 0
              )
            )
            AND NEW.recovery_proof_digest != OLD.recovery_proof_digest
            AND NEW.prior_recovery_proof_digest = OLD.recovery_proof_digest
            AND NEW.recovered_at = NEW.updated_at
            AND NEW.quarantine_reason IS NULL
            AND NEW.retired_at IS NULL
            AND NEW.quarantined_at IS NULL)
          OR
          (NEW.state = 'retired'
            AND NEW.live_generation = OLD.live_generation
            AND NEW.live_capability_evidence_digest IS
              OLD.live_capability_evidence_digest
            AND NEW.live_supports_fast IS OLD.live_supports_fast
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
            AND NEW.live_capability_evidence_digest IS
              OLD.live_capability_evidence_digest
            AND NEW.live_supports_fast IS OLD.live_supports_fast
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

      DROP TRIGGER harness_actor_session_binding_identity_guard;
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

      ALTER TABLE harness_actor_turns
        ADD COLUMN acceleration_mode TEXT NOT NULL DEFAULT 'standard'
          CHECK (acceleration_mode IN ('standard', 'fast'));
      ALTER TABLE harness_actor_turns
        ADD COLUMN acceleration_critical_path INTEGER NOT NULL DEFAULT 0
          CHECK (acceleration_critical_path IN (0, 1));
      ALTER TABLE harness_actor_turns
        ADD COLUMN acceleration_bottleneck TEXT NOT NULL DEFAULT 'none'
          CHECK (acceleration_bottleneck IN (
            'none', 'reasoning', 'fileGeneration'
          ));

      ALTER TABLE harness_actor_turn_attempts
        ADD COLUMN requested_service_tier TEXT NOT NULL DEFAULT 'standard'
          CHECK (requested_service_tier IN ('standard', 'fast'));
      ALTER TABLE harness_actor_turn_attempts
        ADD COLUMN effect_generation INTEGER CHECK (
          effect_generation IS NULL OR effect_generation > 0
        );
      UPDATE harness_actor_turn_attempts
      SET effect_generation = process_generation;
      ALTER TABLE harness_actor_turn_attempts
        ADD COLUMN realized_service_tier TEXT NOT NULL DEFAULT 'standard'
          CHECK (realized_service_tier IN ('standard', 'fast'));
      ALTER TABLE harness_actor_turn_attempts
        ADD COLUMN tier_fallback_reason TEXT CHECK (
          tier_fallback_reason IS NULL OR tier_fallback_reason IN (
            'automaticFastDisabled', 'fastUnsupported',
            'fastReservationUnavailable'
          )
        );
      ALTER TABLE harness_actor_turn_attempts
        ADD COLUMN capability_evidence_digest TEXT CHECK (
          capability_evidence_digest IS NULL OR (
            length(capability_evidence_digest) = 64
            AND capability_evidence_digest NOT GLOB '*[^0-9a-f]*'
          )
        );
      ALTER TABLE harness_actor_turn_attempts
        ADD COLUMN fast_reservation_id TEXT CHECK (
          fast_reservation_id IS NULL OR (
            length(fast_reservation_id) BETWEEN 16 AND 96
            AND fast_reservation_id GLOB 'hfast_[A-Za-z0-9_-]*'
            AND substr(fast_reservation_id, 7) NOT GLOB '*[^A-Za-z0-9_-]*'
          )
        );
      ALTER TABLE harness_actor_turn_attempts
        ADD COLUMN token_usage_cumulative_cached_input_tokens INTEGER
          CHECK (
            token_usage_cumulative_cached_input_tokens IS NULL OR
            token_usage_cumulative_cached_input_tokens >= 0
          );
      ALTER TABLE harness_actor_turn_attempts
        ADD COLUMN token_usage_cumulative_reasoning_output_tokens INTEGER
          CHECK (
            token_usage_cumulative_reasoning_output_tokens IS NULL OR
            token_usage_cumulative_reasoning_output_tokens >= 0
          );
      ALTER TABLE harness_actor_turn_attempts
        ADD COLUMN cached_input_tokens INTEGER CHECK (
          cached_input_tokens IS NULL OR cached_input_tokens >= 0
        );
      ALTER TABLE harness_actor_turn_attempts
        ADD COLUMN reasoning_output_tokens INTEGER CHECK (
          reasoning_output_tokens IS NULL OR reasoning_output_tokens >= 0
        );

      ALTER TABLE harness_actor_turn_usage_inbox
        ADD COLUMN cumulative_cached_input_tokens INTEGER CHECK (
          cumulative_cached_input_tokens IS NULL OR
          cumulative_cached_input_tokens >= 0
        );
      ALTER TABLE harness_actor_turn_usage_inbox
        ADD COLUMN cumulative_reasoning_output_tokens INTEGER CHECK (
          cumulative_reasoning_output_tokens IS NULL OR
          cumulative_reasoning_output_tokens >= 0
        );

      CREATE TABLE harness_actor_account_leases (
        lease_id TEXT PRIMARY KEY CHECK (
          length(lease_id) BETWEEN 16 AND 96
          AND lease_id GLOB 'haccountlease_[A-Za-z0-9_-]*'
          AND substr(lease_id, 15) NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        incarnation_id TEXT NOT NULL UNIQUE
          REFERENCES harness_actor_incarnations(incarnation_id)
          ON DELETE RESTRICT,
        actor_id TEXT NOT NULL
          REFERENCES harness_actors(actor_id) ON DELETE RESTRICT,
        account_profile_id TEXT NOT NULL
          REFERENCES account_profiles(profile_id) ON DELETE RESTRICT,
        process_generation INTEGER NOT NULL CHECK (process_generation > 0),
        state TEXT NOT NULL CHECK (state IN (
          'active', 'released', 'quarantined'
        )),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        settled_at TEXT,
        CHECK ((state != 'active') = (settled_at IS NOT NULL))
      ) STRICT;

      CREATE INDEX harness_actor_account_lease_load_idx
        ON harness_actor_account_leases(
          account_profile_id, process_generation, state, lease_id
        );

      CREATE TRIGGER harness_actor_account_lease_insert_guard
      BEFORE INSERT ON harness_actor_account_leases
      WHEN NOT EXISTS (
        SELECT 1 FROM harness_actor_incarnations AS incarnation
        WHERE incarnation.incarnation_id = NEW.incarnation_id
          AND incarnation.actor_id = NEW.actor_id
          AND incarnation.account_profile_id = NEW.account_profile_id
          AND incarnation.process_generation = NEW.process_generation
          AND incarnation.state = 'starting'
      )
      BEGIN
        SELECT RAISE(ABORT, 'actor account lease lacks starting incarnation');
      END;

      CREATE TRIGGER harness_actor_account_lease_identity_immutable
      BEFORE UPDATE OF lease_id, incarnation_id, actor_id,
        account_profile_id, process_generation, created_at
      ON harness_actor_account_leases
      BEGIN
        SELECT RAISE(ABORT, 'actor account lease identity is immutable');
      END;

      CREATE TRIGGER harness_actor_account_lease_transition_guard
      BEFORE UPDATE OF state ON harness_actor_account_leases
      WHEN OLD.state != 'active'
        OR NEW.state NOT IN ('released', 'quarantined')
      BEGIN
        SELECT RAISE(ABORT, 'invalid actor account lease transition');
      END;

      CREATE TRIGGER harness_actor_account_lease_delete_guard
      BEFORE DELETE ON harness_actor_account_leases
      BEGIN
        SELECT RAISE(ABORT, 'actor account lease evidence is immutable');
      END;

      CREATE TABLE harness_actor_fast_reservations (
        reservation_id TEXT PRIMARY KEY CHECK (
          length(reservation_id) BETWEEN 16 AND 96
          AND reservation_id GLOB 'hfast_[A-Za-z0-9_-]*'
          AND substr(reservation_id, 7) NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        attempt_id TEXT NOT NULL UNIQUE
          REFERENCES harness_actor_turn_attempts(attempt_id) ON DELETE RESTRICT,
        epoch_id TEXT NOT NULL
          REFERENCES harness_actor_epochs(epoch_id) ON DELETE RESTRICT,
        root_actor_id TEXT NOT NULL
          REFERENCES harness_actors(actor_id) ON DELETE RESTRICT,
        actor_id TEXT NOT NULL
          REFERENCES harness_actors(actor_id) ON DELETE RESTRICT,
        account_profile_id TEXT NOT NULL
          REFERENCES account_profiles(profile_id) ON DELETE RESTRICT,
        process_generation INTEGER NOT NULL CHECK (process_generation > 0),
        state TEXT NOT NULL CHECK (state IN (
          'reserved', 'effectStarted', 'released', 'consumed', 'quarantined'
        )),
        terminal_reason TEXT CHECK (
          terminal_reason IS NULL OR terminal_reason IN (
            'preEffectTerminal', 'definitiveNotApplied', 'providerTerminal',
            'generationFenced', 'ambiguousProviderEffect'
          )
        ),
        fence_evidence_digest TEXT CHECK (
          fence_evidence_digest IS NULL OR (
            length(fence_evidence_digest) = 64
            AND fence_evidence_digest NOT GLOB '*[^0-9a-f]*'
          )
        ),
        fenced_generation INTEGER CHECK (
          fenced_generation IS NULL OR fenced_generation > 0
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        effect_started_at TEXT,
        settled_at TEXT,
        quarantined_at TEXT,
        CHECK ((state IN ('released', 'consumed')) = (settled_at IS NOT NULL)),
        CHECK ((state = 'quarantined') = (quarantined_at IS NOT NULL)),
        CHECK (
          (fence_evidence_digest IS NULL) = (fenced_generation IS NULL)
        )
      ) STRICT;

      CREATE UNIQUE INDEX harness_actor_one_held_fast_per_root_idx
        ON harness_actor_fast_reservations(root_actor_id)
        WHERE state IN ('reserved', 'effectStarted', 'quarantined');
      CREATE UNIQUE INDEX harness_actor_one_held_fast_per_account_idx
        ON harness_actor_fast_reservations(account_profile_id)
        WHERE state IN ('reserved', 'effectStarted', 'quarantined');
      CREATE INDEX harness_actor_fast_reservation_recovery_idx
        ON harness_actor_fast_reservations(state, updated_at, reservation_id);

      CREATE TRIGGER harness_actor_dispatch_policy_insert_guard
      BEFORE INSERT ON harness_actors
      WHEN NOT (
        (NEW.dispatch_policy_version = 0
          AND NEW.work_class = 'legacyUnclassified')
        OR (NEW.dispatch_policy_version = 1
          AND NEW.work_class IN (
            'largeChange', 'wideResearch', 'standard', 'boundedLeaf'
          ))
      )
      BEGIN
        SELECT RAISE(ABORT, 'invalid actor dispatch policy');
      END;

      CREATE TRIGGER harness_actor_dispatch_policy_immutable
      BEFORE UPDATE OF dispatch_policy_version, work_class ON harness_actors
      WHEN NEW.dispatch_policy_version != OLD.dispatch_policy_version
        OR NEW.work_class != OLD.work_class
      BEGIN
        SELECT RAISE(ABORT, 'actor dispatch policy is immutable');
      END;

      CREATE TRIGGER harness_actor_incarnation_profile_insert_guard
      BEFORE INSERT ON harness_actor_incarnations
      WHEN NOT EXISTS (
        SELECT 1 FROM harness_actors AS actor
        WHERE actor.actor_id = NEW.actor_id
          AND (
            (actor.dispatch_policy_version = 0
              AND NEW.requested_model = 'gpt-5.6-sol'
              AND NEW.requested_reasoning_effort = 'ultra'
              AND NEW.capability_evidence_digest IS NULL)
            OR (actor.dispatch_policy_version = 1
              AND NEW.capability_evidence_digest IS NOT NULL
              AND NEW.supports_fast IS NOT NULL
              AND (
                (actor.work_class IN ('largeChange', 'wideResearch')
                  AND NEW.requested_model = 'gpt-5.6-sol'
                  AND NEW.requested_reasoning_effort = 'ultra'
                  AND NEW.profile_fallback_reason IS NULL)
                OR (actor.work_class = 'standard'
                  AND NEW.requested_model = 'gpt-5.6-sol'
                  AND NEW.requested_reasoning_effort = 'max'
                  AND NEW.profile_fallback_reason IS NULL)
                OR (actor.work_class = 'boundedLeaf'
                  AND NEW.requested_reasoning_effort = 'max'
                  AND (
                    (NEW.requested_model = 'gpt-5.6-luna'
                      AND NEW.profile_fallback_reason IS NULL)
                    OR (NEW.requested_model = 'gpt-5.6-sol'
                      AND NEW.profile_fallback_reason = 'lunaUnavailable')
                  ))
              ))
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'invalid actor incarnation profile');
      END;

      CREATE TRIGGER harness_actor_incarnation_profile_immutable
      BEFORE UPDATE OF requested_model, requested_reasoning_effort,
        profile_fallback_reason, capability_evidence_digest, supports_fast
      ON harness_actor_incarnations
      WHEN NEW.requested_model != OLD.requested_model
        OR NEW.requested_reasoning_effort != OLD.requested_reasoning_effort
        OR NEW.profile_fallback_reason IS NOT OLD.profile_fallback_reason
        OR NEW.capability_evidence_digest IS NOT OLD.capability_evidence_digest
        OR NEW.supports_fast IS NOT OLD.supports_fast
      BEGIN
        SELECT RAISE(ABORT, 'actor incarnation requested profile is immutable');
      END;

      CREATE TRIGGER harness_actor_turn_acceleration_insert_guard
      BEFORE INSERT ON harness_actor_turns
      WHEN NOT (
        (NEW.acceleration_mode = 'standard'
          AND NEW.acceleration_critical_path = 0
          AND NEW.acceleration_bottleneck = 'none')
        OR (NEW.acceleration_mode = 'fast'
          AND NEW.acceleration_critical_path = 1
          AND NEW.acceleration_bottleneck IN ('reasoning', 'fileGeneration'))
      )
      BEGIN
        SELECT RAISE(ABORT, 'invalid actor turn acceleration');
      END;

      CREATE TRIGGER harness_actor_turn_acceleration_immutable
      BEFORE UPDATE OF acceleration_mode, acceleration_critical_path,
        acceleration_bottleneck ON harness_actor_turns
      WHEN NEW.acceleration_mode != OLD.acceleration_mode
        OR NEW.acceleration_critical_path != OLD.acceleration_critical_path
        OR NEW.acceleration_bottleneck != OLD.acceleration_bottleneck
      BEGIN
        SELECT RAISE(ABORT, 'actor turn acceleration is immutable');
      END;

      CREATE TRIGGER harness_actor_attempt_dispatch_insert_guard
      BEFORE INSERT ON harness_actor_turn_attempts
      WHEN NOT (
        (NEW.requested_service_tier = 'standard'
          AND NEW.realized_service_tier = 'standard'
          AND NEW.tier_fallback_reason IS NULL
          AND NEW.fast_reservation_id IS NULL)
        OR (NEW.requested_service_tier = 'fast'
          AND NEW.realized_service_tier = 'standard'
          AND NEW.tier_fallback_reason IS NOT NULL
          AND NEW.fast_reservation_id IS NULL)
        OR (NEW.requested_service_tier = 'fast'
          AND NEW.realized_service_tier = 'fast'
          AND NEW.tier_fallback_reason IS NULL
          AND NEW.fast_reservation_id IS NOT NULL)
      )
      BEGIN
        SELECT RAISE(ABORT, 'invalid actor attempt dispatch evidence');
      END;

      CREATE TRIGGER harness_actor_attempt_dispatch_immutable
      BEFORE UPDATE OF requested_service_tier, realized_service_tier,
        tier_fallback_reason, capability_evidence_digest, effect_generation,
        fast_reservation_id ON harness_actor_turn_attempts
      WHEN NEW.requested_service_tier != OLD.requested_service_tier
        OR NOT (
          OLD.state IN ('starting', 'reconciling')
          AND NEW.state = OLD.state
          AND OLD.provider_turn_id IS NULL
          AND NEW.provider_turn_id IS NULL
          AND NEW.effect_generation IS NOT NULL
          AND (
            (NEW.realized_service_tier = OLD.realized_service_tier
              AND NEW.tier_fallback_reason IS OLD.tier_fallback_reason
              AND NEW.fast_reservation_id IS OLD.fast_reservation_id)
            OR
            (OLD.requested_service_tier = 'fast'
              AND OLD.realized_service_tier = 'fast'
              AND OLD.tier_fallback_reason IS NULL
              AND OLD.fast_reservation_id IS NOT NULL
              AND NEW.realized_service_tier = 'standard'
              AND NEW.tier_fallback_reason = 'fastReservationUnavailable'
              AND NEW.fast_reservation_id IS NULL
              AND EXISTS (
                SELECT 1 FROM harness_actor_fast_reservations AS reservation
                WHERE reservation.reservation_id = OLD.fast_reservation_id
                  AND reservation.attempt_id = OLD.attempt_id
                  AND reservation.state = 'released'
                  AND reservation.terminal_reason = 'preEffectTerminal'
              ))
          )
          AND EXISTS (
            SELECT 1
            FROM harness_actor_operations AS operation
            JOIN harness_actor_turns AS turn
              ON turn.turn_id = OLD.turn_id
            WHERE operation.turn_id = OLD.turn_id
              AND operation.actor_id = turn.actor_id
              AND operation.kind = 'turnStart'
              AND operation.state = 'prepared'
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'actor attempt dispatch evidence is immutable');
      END;

      CREATE TRIGGER harness_actor_fast_reservation_insert_guard
      BEFORE INSERT ON harness_actor_fast_reservations
      WHEN NOT EXISTS (
        SELECT 1
        FROM harness_actor_turn_attempts AS attempt
        JOIN harness_actor_turns AS turn ON turn.turn_id = attempt.turn_id
        JOIN harness_actor_epochs AS epoch ON epoch.epoch_id = turn.epoch_id
        WHERE attempt.attempt_id = NEW.attempt_id
          AND attempt.fast_reservation_id = NEW.reservation_id
          AND attempt.requested_service_tier = 'fast'
          AND attempt.realized_service_tier = 'fast'
          AND attempt.account_profile_id = NEW.account_profile_id
          AND attempt.effect_generation = NEW.process_generation
          AND turn.actor_id = NEW.actor_id
          AND turn.epoch_id = NEW.epoch_id
          AND epoch.root_actor_id = NEW.root_actor_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Fast reservation lacks exact attempt lineage');
      END;

      CREATE TRIGGER harness_actor_fast_reservation_identity_immutable
      BEFORE UPDATE OF reservation_id, attempt_id, epoch_id, root_actor_id,
        actor_id, account_profile_id, process_generation, created_at
      ON harness_actor_fast_reservations
      BEGIN
        SELECT RAISE(ABORT, 'Fast reservation identity is immutable');
      END;

      CREATE TRIGGER harness_actor_fast_reservation_transition_guard
      BEFORE UPDATE OF state ON harness_actor_fast_reservations
      WHEN NOT (
        (OLD.state = 'reserved'
          AND NEW.state IN ('effectStarted', 'released', 'quarantined'))
        OR (OLD.state = 'effectStarted'
          AND NEW.state IN ('released', 'consumed', 'quarantined'))
        OR (OLD.state = 'quarantined'
          AND NEW.state IN ('released', 'consumed')
          AND NEW.fence_evidence_digest IS NOT NULL
          AND NEW.fenced_generation IS NOT NULL)
      )
      BEGIN
        SELECT RAISE(ABORT, 'invalid Fast reservation transition');
      END;

      CREATE TRIGGER harness_actor_fast_reservation_delete_guard
      BEFORE DELETE ON harness_actor_fast_reservations
      BEGIN
        SELECT RAISE(ABORT, 'Fast reservation evidence is immutable');
      END;

      CREATE TABLE harness_actor_model_reroute_inbox (
        attempt_id TEXT PRIMARY KEY
          REFERENCES harness_actor_turn_attempts(attempt_id)
          ON DELETE RESTRICT,
        provider_identity_digest TEXT NOT NULL CHECK (
          length(provider_identity_digest) = 64
          AND provider_identity_digest NOT GLOB '*[^0-9a-f]*'
        ),
        observation_generation INTEGER NOT NULL CHECK (
          observation_generation > 0
        ),
        stream_position INTEGER NOT NULL CHECK (
          stream_position BETWEEN 0 AND 9007199254740991
        ),
        from_model TEXT NOT NULL CHECK (
          length(from_model) BETWEEN 1 AND 160
          AND instr(from_model, char(0)) = 0
        ),
        to_model TEXT NOT NULL CHECK (
          length(to_model) BETWEEN 1 AND 160
          AND instr(to_model, char(0)) = 0
        ),
        reason TEXT NOT NULL CHECK (reason = 'highRiskCyberActivity'),
        fact_digest TEXT NOT NULL CHECK (
          length(fact_digest) = 64
          AND fact_digest NOT GLOB '*[^0-9a-f]*'
        ),
        state TEXT NOT NULL CHECK (
          state IN ('pending', 'bound', 'quarantined', 'settled')
        ),
        quarantine_reason TEXT CHECK (
          quarantine_reason IS NULL OR quarantine_reason IN (
            'ambiguous_candidate', 'provider_identity_conflict',
            'fact_conflict'
          )
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        bound_at TEXT,
        quarantined_at TEXT,
        settled_at TEXT,
        CHECK ((state = 'pending') = (bound_at IS NULL)),
        CHECK ((quarantine_reason IS NULL) = (quarantined_at IS NULL)),
        CHECK (state != 'quarantined' OR quarantine_reason IS NOT NULL),
        CHECK (state NOT IN ('pending', 'bound') OR quarantine_reason IS NULL),
        CHECK ((state = 'settled') = (settled_at IS NOT NULL)),
        CHECK (updated_at >= created_at)
      ) STRICT;

      CREATE INDEX harness_actor_model_reroute_recovery_idx
        ON harness_actor_model_reroute_inbox(
          state, updated_at, attempt_id
        );
      CREATE INDEX harness_actor_model_reroute_identity_idx
        ON harness_actor_model_reroute_inbox(provider_identity_digest);

      CREATE TRIGGER harness_actor_model_reroute_insert_guard
      BEFORE INSERT ON harness_actor_model_reroute_inbox
      WHEN NOT EXISTS (
        SELECT 1
        FROM harness_actor_turn_attempts AS attempt
        JOIN harness_actor_turns AS turn
          ON turn.turn_id = attempt.turn_id
        JOIN harness_actor_incarnations AS incarnation
          ON incarnation.incarnation_id = attempt.incarnation_id
        JOIN harness_actor_session_bindings AS session
          ON session.incarnation_id = incarnation.incarnation_id
        WHERE attempt.attempt_id = NEW.attempt_id
          AND attempt.account_profile_id = session.account_profile_id
          AND incarnation.account_profile_id = session.account_profile_id
          AND incarnation.process_generation = attempt.process_generation
          AND attempt.process_generation = session.admission_generation
          AND attempt.effect_generation IS NOT NULL
          AND attempt.effect_generation <= NEW.observation_generation
          AND NEW.observation_generation <= session.live_generation
          AND incarnation.actor_id = session.actor_id
          AND turn.actor_id = incarnation.actor_id
          AND incarnation.provider_thread_id = session.provider_thread_id
          AND (
            (NEW.state = 'pending'
              AND attempt.provider_turn_id IS NULL
              AND attempt.state IN ('starting', 'reconciling')
              AND incarnation.state IN ('idle', 'running')
              AND session.state = 'bound')
            OR
            (NEW.state = 'bound'
              AND attempt.provider_turn_id IS NOT NULL
              AND session.state IN ('bound', 'quarantined', 'retired'))
            OR
            (NEW.state = 'quarantined'
              AND (
                (attempt.provider_turn_id IS NOT NULL
                  AND session.state IN ('bound', 'quarantined', 'retired'))
                OR
                (attempt.provider_turn_id IS NULL
                  AND attempt.state IN ('starting', 'reconciling')
                  AND incarnation.state IN ('idle', 'running')
                  AND session.state = 'bound')
              ))
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'actor model reroute inbox lineage is incoherent');
      END;

      CREATE TRIGGER harness_actor_model_reroute_identity_immutable
      BEFORE UPDATE OF attempt_id, provider_identity_digest,
        observation_generation, stream_position, from_model, to_model,
        reason, fact_digest, created_at
      ON harness_actor_model_reroute_inbox
      BEGIN
        SELECT RAISE(ABORT, 'actor model reroute evidence is immutable');
      END;

      CREATE TRIGGER harness_actor_model_reroute_transition_guard
      BEFORE UPDATE ON harness_actor_model_reroute_inbox
      WHEN NEW.updated_at < OLD.updated_at
        OR NOT (
          (OLD.state = 'pending' AND NEW.state IN ('bound', 'quarantined'))
          OR (OLD.state = 'bound' AND NEW.state IN ('quarantined', 'settled'))
          OR (OLD.state = 'quarantined' AND NEW.state = 'settled')
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid actor model reroute transition');
      END;

      CREATE TRIGGER harness_actor_model_reroute_delete_guard
      BEFORE DELETE ON harness_actor_model_reroute_inbox
      BEGIN
        SELECT RAISE(ABORT, 'actor model reroute evidence is immutable');
      END;
    `,
  },
  {
    version: 43,
    name: "terminalize-provider-quota-without-history-replay",
    sql: `
      DROP TRIGGER harness_actor_turn_attempt_continuation_terminal_guard;

      CREATE TRIGGER harness_actor_turn_attempt_continuation_terminal_guard
      BEFORE UPDATE OF state ON harness_actor_turn_attempts
      WHEN NEW.continuation_history_value_id IS NOT NULL
        AND NEW.state IN ('completed', 'failed', 'interrupted', 'ambiguous')
      BEGIN
        SELECT RAISE(ABORT, 'actor continuation history terminal state is incoherent');
      END;
    `,
  },
  {
    version: 44,
    name: "longitudinal-routing-shadow-memory",
    sql: LONGITUDINAL_ROUTING_SCHEMA_V1_SQL,
  },
  {
    version: 45,
    name: "durable-root-turn-routing-receipts",
    sql: ROOT_TURN_ROUTING_SCHEMA_V1_SQL,
  },
  {
    version: 46,
    name: "actor-turn-requested-service-tier-authority",
    sql: `
      ALTER TABLE harness_actor_turns
        ADD COLUMN requested_service_tier TEXT NOT NULL DEFAULT 'standard'
          CHECK (requested_service_tier IN ('standard', 'fast'));

      UPDATE harness_actor_turns
      SET requested_service_tier = CASE
        WHEN EXISTS (
          SELECT 1 FROM harness_actors AS actor
          WHERE actor.actor_id = harness_actor_turns.actor_id
            AND actor.dispatch_policy_version = 1
            AND actor.work_class = 'boundedLeaf'
        ) THEN 'fast'
        ELSE 'standard'
      END;

      CREATE TRIGGER harness_actor_turn_requested_service_tier_insert_guard
      BEFORE INSERT ON harness_actor_turns
      WHEN NOT EXISTS (
        SELECT 1 FROM harness_actors AS actor
        WHERE actor.actor_id = NEW.actor_id
          AND NEW.requested_service_tier = CASE
            WHEN actor.dispatch_policy_version = 1
              AND actor.work_class = 'boundedLeaf'
              THEN 'fast'
            ELSE 'standard'
          END
      )
      BEGIN
        SELECT RAISE(
          ABORT,
          'actor turn requested service tier does not match its work class'
        );
      END;

      CREATE TRIGGER harness_actor_turn_requested_service_tier_immutable
      BEFORE UPDATE OF requested_service_tier ON harness_actor_turns
      WHEN NEW.requested_service_tier != OLD.requested_service_tier
      BEGIN
        SELECT RAISE(ABORT, 'actor turn requested service tier is immutable');
      END;

      DROP TRIGGER harness_actor_attempt_dispatch_insert_guard;
      CREATE TRIGGER harness_actor_attempt_dispatch_insert_guard
      BEFORE INSERT ON harness_actor_turn_attempts
      WHEN NOT (
        EXISTS (
          SELECT 1 FROM harness_actor_turns AS turn
          WHERE turn.turn_id = NEW.turn_id
            AND turn.requested_service_tier = NEW.requested_service_tier
        )
        AND (
          (NEW.requested_service_tier = 'standard'
            AND NEW.realized_service_tier = 'standard'
            AND NEW.tier_fallback_reason IS NULL
            AND NEW.fast_reservation_id IS NULL)
          OR (NEW.requested_service_tier = 'fast'
            AND NEW.realized_service_tier = 'standard'
            AND NEW.tier_fallback_reason IN (
              'fastUnsupported', 'fastReservationUnavailable'
            )
            AND NEW.fast_reservation_id IS NULL)
          OR (NEW.requested_service_tier = 'fast'
            AND NEW.realized_service_tier = 'fast'
            AND NEW.tier_fallback_reason IS NULL
            AND NEW.fast_reservation_id IS NOT NULL)
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'invalid actor attempt dispatch evidence');
      END;
    `,
  },
  {
    version: 47,
    name: "durable-app-owned-chat-message-ledger",
    sql: CHAT_MESSAGE_LEDGER_SCHEMA_V1_SQL,
  },
  {
    version: 48,
    name: "explicit-ambiguous-chat-message-resolution",
    sql: CHAT_MESSAGE_AMBIGUOUS_RESOLUTION_SCHEMA_V1_SQL,
  },
  {
    version: 49,
    name: "verified-reasoning-provider-subagents-and-pane-palette",
    sql: CHAT_COMPACT_SEMANTIC_SCHEMA_V1_SQL,
  },
  {
    version: 50,
    name: "private-durable-chat-attachment-vault",
    sql: CHAT_ATTACHMENT_VAULT_SCHEMA_V2_SQL,
  },
  {
    version: 51,
    name: "immutable-chat-message-delivery-intent",
    sql: CHAT_MESSAGE_IDEMPOTENCY_SCHEMA_V1_SQL,
  },
  {
    version: 52,
    name: "generation-fenced-root-input-capabilities",
    sql: ROOT_TURN_ROUTING_CAPABILITY_SCHEMA_V1_SQL,
  },
  {
    version: 53,
    name: "provider-history-handoff-floor",
    sql: `
      ALTER TABLE chat_panes
        ADD COLUMN provider_history_floor_sequence INTEGER NOT NULL DEFAULT 0
          CHECK (
            provider_history_floor_sequence BETWEEN 0 AND 9007199254740991
          );

      CREATE TRIGGER chat_panes_provider_history_floor_monotonic
      BEFORE UPDATE OF provider_history_floor_sequence ON chat_panes
      WHEN NEW.provider_history_floor_sequence < OLD.provider_history_floor_sequence
      BEGIN
        SELECT RAISE(ABORT, 'provider history handoff floor cannot move backwards');
      END;
    `,
  },
  {
    version: 54,
    name: "provider-context-reset-required",
    sql: `
      ALTER TABLE chat_panes
        ADD COLUMN provider_context_reset_required INTEGER NOT NULL DEFAULT 0
          CHECK (provider_context_reset_required IN (0, 1));
    `,
  },
  {
    version: 55,
    name: "one-live-provider-attachment-lineage-per-pane",
    sql: `
      CREATE UNIQUE INDEX chat_provider_attachment_bindings_one_live_per_pane
      ON chat_provider_attachment_bindings(pane_id)
      WHERE state IN ('active', 'ambiguous');
    `,
  },
  {
    version: 56,
    name: "durable-provider-thread-archive-intent",
    sql: `
      CREATE TABLE chat_provider_thread_archive_intents (
        pane_id TEXT PRIMARY KEY
          REFERENCES chat_panes(pane_id) ON DELETE RESTRICT,
        purpose TEXT NOT NULL CHECK (purpose IN ('start_fresh', 'pane_archive')),
        state TEXT NOT NULL CHECK (
          state IN (
            'prepared', 'effect_started', 'ambiguous', 'succeeded',
            'account_contained'
          )
        ),
        pane_revision INTEGER NOT NULL CHECK (pane_revision > 0),
        queue_revision INTEGER CHECK (queue_revision IS NULL OR queue_revision > 0),
        account_profile_id TEXT NOT NULL CHECK (
          length(account_profile_id) BETWEEN 1 AND 128
          AND instr(account_profile_id, char(0)) = 0
        ),
        thread_id TEXT NOT NULL CHECK (
          length(thread_id) BETWEEN 1 AND 512
          AND instr(thread_id, char(0)) = 0
        ),
        restart_thread_id TEXT NOT NULL CHECK (
          length(restart_thread_id) BETWEEN 1 AND 512
          AND instr(restart_thread_id, char(0)) = 0
        ),
        binding_id TEXT,
        binding_key_digest TEXT CHECK (
          binding_key_digest IS NULL OR (
            length(binding_key_digest) = 64
            AND binding_key_digest NOT GLOB '*[^0-9a-f]*'
          )
        ),
        binding_revision INTEGER CHECK (
          binding_revision IS NULL OR binding_revision > 0
        ),
        generation INTEGER NOT NULL CHECK (generation > 0),
        generation_contained INTEGER NOT NULL DEFAULT 0
          CHECK (generation_contained IN (0, 1)),
        generation_containment_receipt TEXT CHECK (
          generation_containment_receipt IS NULL OR
          length(generation_containment_receipt) BETWEEN 16 AND 512
        ),
        effect_attempt INTEGER NOT NULL DEFAULT 0 CHECK (effect_attempt >= 0),
        containment_receipt TEXT CHECK (
          containment_receipt IS NULL OR length(containment_receipt) BETWEEN 16 AND 512
        ),
        response_generation INTEGER CHECK (
          response_generation IS NULL OR response_generation > 0
        ),
        response_stream_position INTEGER CHECK (
          response_stream_position IS NULL OR response_stream_position >= 0
        ),
        ambiguity_receipt TEXT CHECK (
          ambiguity_receipt IS NULL OR length(ambiguity_receipt) BETWEEN 16 AND 512
        ),
        reconciliation_disposition TEXT CHECK (
          reconciliation_disposition IS NULL OR
          reconciliation_disposition IN ('applied', 'not_applied')
        ),
        reconciliation_receipt TEXT CHECK (
          reconciliation_receipt IS NULL OR
          length(reconciliation_receipt) BETWEEN 16 AND 512
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (purpose = 'start_fresh' AND queue_revision IS NOT NULL)
          OR (purpose = 'pane_archive' AND queue_revision IS NULL)
        ),
        CHECK (
          (binding_id IS NULL AND binding_key_digest IS NULL
            AND binding_revision IS NULL)
          OR (binding_id IS NOT NULL AND binding_key_digest IS NOT NULL
            AND binding_revision IS NOT NULL)
        ),
        CHECK (
          (state = 'succeeded' AND containment_receipt IS NOT NULL
            AND response_generation IS NOT NULL
            AND response_stream_position IS NOT NULL
            AND (
              response_generation = generation
              OR (
                response_generation > generation
                AND generation_contained = 1
                AND generation_containment_receipt IS NOT NULL
                AND reconciliation_disposition = 'applied'
                AND reconciliation_receipt IS NOT NULL
              )
            ))
          OR (state != 'succeeded' AND containment_receipt IS NULL
            AND response_generation IS NULL
            AND response_stream_position IS NULL)
        ),
        CHECK (
          (state = 'ambiguous' AND ambiguity_receipt IS NOT NULL)
          OR (state != 'ambiguous' AND ambiguity_receipt IS NULL)
        ),
        CHECK (
          (reconciliation_disposition IS NULL AND reconciliation_receipt IS NULL)
          OR (reconciliation_disposition IS NOT NULL
            AND reconciliation_receipt IS NOT NULL)
        ),
        CHECK (
          (generation_contained = 0 AND generation_containment_receipt IS NULL)
          OR (generation_contained = 1
            AND generation_containment_receipt IS NOT NULL
            AND state IN ('ambiguous', 'succeeded', 'account_contained'))
        )
      ) STRICT;

      CREATE TRIGGER chat_provider_thread_archive_intent_identity_immutable
      BEFORE UPDATE OF purpose, pane_revision, queue_revision,
        account_profile_id, thread_id, restart_thread_id,
        binding_id, binding_key_digest, binding_revision, created_at
      ON chat_provider_thread_archive_intents
      WHEN NEW.purpose IS NOT OLD.purpose
        OR NEW.pane_revision IS NOT OLD.pane_revision
        OR NEW.queue_revision IS NOT OLD.queue_revision
        OR NEW.account_profile_id IS NOT OLD.account_profile_id
        OR NEW.thread_id IS NOT OLD.thread_id
        OR NEW.restart_thread_id IS NOT OLD.restart_thread_id
        OR NEW.binding_id IS NOT OLD.binding_id
        OR NEW.binding_key_digest IS NOT OLD.binding_key_digest
        OR NEW.binding_revision IS NOT OLD.binding_revision
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN
        SELECT RAISE(ABORT, 'provider thread archive intent identity is immutable');
      END;

      CREATE TRIGGER chat_provider_thread_archive_intent_transition_guard
      BEFORE UPDATE OF state ON chat_provider_thread_archive_intents
      WHEN NOT (
        (OLD.state = 'prepared' AND NEW.state = 'prepared')
        OR
        (OLD.state = 'prepared' AND NEW.state = 'effect_started')
        OR (OLD.state = 'effect_started' AND NEW.state IN ('ambiguous', 'succeeded'))
        OR (OLD.state = 'ambiguous' AND NEW.state IN ('prepared', 'succeeded'))
        OR (NEW.state = 'account_contained'
          AND OLD.state IN ('prepared', 'effect_started', 'ambiguous', 'succeeded'))
      )
      BEGIN
        SELECT RAISE(ABORT, 'invalid provider thread archive intent transition');
      END;

      CREATE TRIGGER chat_provider_thread_archive_intent_fence_guard
      BEFORE UPDATE OF generation, effect_attempt
      ON chat_provider_thread_archive_intents
      WHEN NOT (
        (OLD.state = 'prepared' AND NEW.state = 'effect_started'
          AND NEW.generation = OLD.generation
          AND NEW.effect_attempt = OLD.effect_attempt + 1)
        OR (OLD.state = 'ambiguous' AND NEW.state = 'prepared'
          AND NEW.effect_attempt = OLD.effect_attempt)
        OR (OLD.state = 'prepared' AND NEW.state = 'prepared'
          AND NEW.effect_attempt = OLD.effect_attempt)
        OR (NEW.generation = OLD.generation
          AND NEW.effect_attempt = OLD.effect_attempt)
      )
      BEGIN
        SELECT RAISE(ABORT, 'invalid provider thread archive effect fence');
      END;
    `,
  },
  {
    version: 57,
    name: "keyed-provider-thread-archive-containment-journal",
    sql: PROVIDER_THREAD_ARCHIVE_JOURNAL_V57_SQL,
  },
  {
    version: 58,
    name: "global-chat-execution-settings",
    sql: `
      CREATE TABLE chat_execution_settings (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL CHECK (revision > 0),
        folder_path TEXT NOT NULL CHECK (
          length(folder_path) BETWEEN 1 AND 4096
          AND instr(folder_path, char(0)) = 0
        ),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
      ) STRICT;
    `,
  },
  {
    version: 59,
    name: "scheduled-chat-cloud-authority",
    sql: SCHEDULED_CHAT_LOCAL_SCHEMA_V1_SQL,
  },
  {
    version: 60,
    name: "scheduled-chat-proven-quota-retry",
    sql: `
      DROP TRIGGER chat_message_ledger_state_transition_guard;

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
        OR (
          OLD.state = 'start_effect_started' AND NEW.state = 'queued'
          AND EXISTS (
            SELECT 1 FROM harness_root_turn_routing_receipts AS route
            WHERE route.pane_id = OLD.pane_id
              AND route.chat_turn_id = OLD.claimed_turn_id
              AND route.state = 'terminal'
              AND route.operational_outcome = 'quotaRejected'
          )
          AND EXISTS (
            SELECT 1
            FROM chat_scheduled_chat_runs AS run
            JOIN chat_scheduled_chats AS schedule
              ON schedule.pane_id = run.pane_id
             AND schedule.session_id = run.session_id
             AND schedule.generation = run.schedule_generation
            WHERE run.pane_id = OLD.pane_id
              AND run.message_id = OLD.message_id
              AND run.cancelled_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM chat_scheduled_chat_mutations AS mutation
                WHERE mutation.pane_id = OLD.pane_id
              )
          )
        )
        OR (OLD.state = 'start_acknowledged' AND NEW.state = 'completed')
        OR (OLD.state = 'steer_prepared' AND NEW.state IN (
          'queued', 'steer_effect_started', 'cancelled'
        ))
        OR (OLD.state = 'steer_effect_started' AND NEW.state IN (
          'steer_acknowledged', 'ambiguous'
        ))
        OR (OLD.state = 'steer_acknowledged' AND NEW.state = 'completed')
      )
      BEGIN
        SELECT RAISE(ABORT, 'invalid chat message ledger transition');
      END;
    `,
  },
  {
    version: 61,
    name: "session-sync-durable-human-origin",
    sql: SESSION_SYNC_HUMAN_ORIGIN_SCHEMA_SQL,
  },
  {
    version: 62,
    name: "scheduled-chat-durable-off-intent",
    sql: SCHEDULED_CHAT_DURABLE_OFF_INTENT_SCHEMA_SQL,
  },
  {
    version: 63,
    name: "durable-workspace-setup-authority",
    sql: `
      CREATE TABLE workspace_setup_requests (
        request_id TEXT PRIMARY KEY CHECK (
          length(request_id) = 40
          AND request_id GLOB 'wssetup_[a-f0-9]*'
          AND substr(request_id, 9) NOT GLOB '*[^a-f0-9]*'
        ),
        lane_id TEXT NOT NULL
          REFERENCES workspace_leases(lane_id) ON DELETE RESTRICT,
        project_id TEXT NOT NULL
          REFERENCES projects(project_id) ON DELETE RESTRICT,
        base_sha TEXT NOT NULL CHECK (
          length(base_sha) BETWEEN 40 AND 64
          AND base_sha NOT GLOB '*[^a-f0-9]*'
        ),
        recipe_digest TEXT NOT NULL CHECK (
          length(recipe_digest) = 64
          AND recipe_digest NOT GLOB '*[^a-f0-9]*'
        ),
        executor_digest TEXT NOT NULL CHECK (
          length(executor_digest) = 64
          AND executor_digest NOT GLOB '*[^a-f0-9]*'
        ),
        pane_workspace_revision_origin INTEGER NOT NULL DEFAULT 1 CHECK (
          pane_workspace_revision_origin > 0
        ),
        state TEXT NOT NULL CHECK (state IN (
          'approval_required', 'rejected', 'prepared', 'effect_started',
          'succeeded', 'failed', 'ambiguous'
        )),
        setup_revision INTEGER NOT NULL CHECK (
          (state IN ('approval_required', 'rejected') AND setup_revision = 1)
          OR (state = 'prepared' AND setup_revision = 2)
          OR (state = 'effect_started' AND setup_revision = 3)
          OR (state IN ('succeeded', 'failed', 'ambiguous')
            AND setup_revision = 4)
        ),
        approval_binding_digest TEXT CHECK (
          approval_binding_digest IS NULL OR (
            length(approval_binding_digest) = 64
            AND approval_binding_digest NOT GLOB '*[^a-f0-9]*'
          )
        ),
        executor_instance_id TEXT CHECK (
          executor_instance_id IS NULL OR (
            length(executor_instance_id) BETWEEN 16 AND 128
            AND instr(executor_instance_id, char(0)) = 0
          )
        ),
        failure_code TEXT CHECK (
          failure_code IS NULL OR failure_code IN (
            'clean_replacement_required', 'invalid_recipe',
            'runtime_unavailable', 'exit_nonzero',
            'timeout', 'output_limit', 'containment_failed',
            'transcript_unavailable'
          )
        ),
        transcript TEXT CHECK (
          transcript IS NULL OR instr(transcript, char(0)) = 0
        ),
        transcript_bytes INTEGER CHECK (
          transcript_bytes IS NULL OR
          (transcript_bytes >= 0 AND transcript_bytes <= 262144)
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        approved_at TEXT,
        effect_started_at TEXT,
        completed_at TEXT,
        UNIQUE (lane_id, base_sha, recipe_digest, executor_digest),
        CHECK ((transcript IS NULL) = (transcript_bytes IS NULL)),
        CHECK (
          transcript IS NULL OR
          transcript_bytes = length(CAST(transcript AS BLOB))
        ),
        CHECK (
          state != 'approval_required' OR (
            approval_binding_digest IS NULL
            AND executor_instance_id IS NULL
            AND failure_code IS NULL
            AND transcript IS NULL
            AND transcript_bytes IS NULL
            AND approved_at IS NULL
            AND effect_started_at IS NULL
            AND completed_at IS NULL
          )
        ),
        CHECK (
          state != 'rejected' OR (
            approval_binding_digest IS NULL
            AND executor_instance_id IS NULL
            AND failure_code IN (
              'clean_replacement_required', 'invalid_recipe',
              'runtime_unavailable'
            )
            AND transcript IS NULL
            AND transcript_bytes IS NULL
            AND approved_at IS NULL
            AND effect_started_at IS NULL
            AND completed_at IS NOT NULL
          )
        ),
        CHECK (
          state != 'prepared' OR (
            approval_binding_digest IS NOT NULL
            AND executor_instance_id IS NULL
            AND failure_code IS NULL
            AND transcript IS NULL
            AND transcript_bytes IS NULL
            AND approved_at IS NOT NULL
            AND effect_started_at IS NULL
            AND completed_at IS NULL
          )
        ),
        CHECK (
          state != 'effect_started' OR (
            approval_binding_digest IS NOT NULL
            AND executor_instance_id IS NOT NULL
            AND failure_code IS NULL
            AND transcript IS NULL
            AND transcript_bytes IS NULL
            AND approved_at IS NOT NULL
            AND effect_started_at IS NOT NULL
            AND completed_at IS NULL
          )
        ),
        CHECK (
          state != 'succeeded' OR (
            approval_binding_digest IS NOT NULL
            AND executor_instance_id IS NOT NULL
            AND failure_code IS NULL
            AND approved_at IS NOT NULL
            AND effect_started_at IS NOT NULL
            AND completed_at IS NOT NULL
            AND transcript IS NOT NULL
          )
        ),
        CHECK (
          state != 'failed' OR (
            approval_binding_digest IS NOT NULL
            AND executor_instance_id IS NOT NULL
            AND failure_code IS NOT NULL
            AND approved_at IS NOT NULL
            AND effect_started_at IS NOT NULL
            AND completed_at IS NOT NULL
            AND transcript IS NOT NULL
          )
        ),
        CHECK (
          state != 'ambiguous' OR (
            approval_binding_digest IS NOT NULL
            AND executor_instance_id IS NOT NULL
            AND failure_code IS NULL
            AND transcript IS NULL
            AND transcript_bytes IS NULL
            AND approved_at IS NOT NULL
            AND effect_started_at IS NOT NULL
            AND completed_at IS NOT NULL
          )
        )
      ) STRICT;

      CREATE TABLE workspace_setup_lane_heads (
        lane_id TEXT PRIMARY KEY
          REFERENCES workspace_leases(lane_id) ON DELETE RESTRICT,
        request_id TEXT NOT NULL UNIQUE
          REFERENCES workspace_setup_requests(request_id) ON DELETE RESTRICT,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX workspace_setup_state_idx
        ON workspace_setup_requests(state, updated_at, request_id);

      CREATE TRIGGER workspace_setup_request_project_guard
      BEFORE INSERT ON workspace_setup_requests
      WHEN NOT EXISTS (
        SELECT 1
        FROM workspace_leases AS lease
        JOIN chat_pane_workspace_bindings AS binding
          ON binding.expected_lane_id = lease.lane_id
         AND binding.workspace_lease_id = lease.lane_id
         AND binding.project_id = lease.project_id
         AND binding.state != 'preserved'
        WHERE lease.lane_id = NEW.lane_id
          AND lease.project_id = NEW.project_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'workspace setup request project mismatch');
      END;

      CREATE TRIGGER workspace_setup_head_insert_guard
      BEFORE INSERT ON workspace_setup_lane_heads
      WHEN NOT EXISTS (
        SELECT 1 FROM workspace_setup_requests AS request
        JOIN workspace_leases AS lease
          ON lease.lane_id = request.lane_id
         AND lease.project_id = request.project_id
        JOIN chat_pane_workspace_bindings AS binding
          ON binding.expected_lane_id = request.lane_id
         AND binding.workspace_lease_id = request.lane_id
         AND binding.project_id = request.project_id
         AND binding.state != 'preserved'
        WHERE request.request_id = NEW.request_id
          AND request.lane_id = NEW.lane_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'workspace setup head identity mismatch');
      END;

      CREATE TRIGGER workspace_setup_head_update_guard
      BEFORE UPDATE OF lane_id, request_id ON workspace_setup_lane_heads
      WHEN NEW.lane_id IS NOT OLD.lane_id
        OR NEW.request_id IS OLD.request_id
        OR NOT EXISTS (
          SELECT 1 FROM workspace_setup_requests AS request
          JOIN workspace_leases AS lease
            ON lease.lane_id = request.lane_id
           AND lease.project_id = request.project_id
          JOIN chat_pane_workspace_bindings AS binding
            ON binding.expected_lane_id = request.lane_id
           AND binding.workspace_lease_id = request.lane_id
           AND binding.project_id = request.project_id
           AND binding.state != 'preserved'
          WHERE request.request_id = NEW.request_id
            AND request.lane_id = NEW.lane_id
        )
        OR EXISTS (
          SELECT 1 FROM workspace_setup_requests AS request
          WHERE request.request_id = OLD.request_id
            AND request.state NOT IN (
              'rejected', 'succeeded', 'failed', 'ambiguous'
            )
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid workspace setup head replacement');
      END;

      CREATE TRIGGER workspace_setup_identity_immutable
      BEFORE UPDATE OF request_id, lane_id, project_id, base_sha,
        recipe_digest, executor_digest, pane_workspace_revision_origin,
        created_at
      ON workspace_setup_requests
      WHEN NEW.request_id IS NOT OLD.request_id
        OR NEW.lane_id IS NOT OLD.lane_id
        OR NEW.project_id IS NOT OLD.project_id
        OR NEW.base_sha IS NOT OLD.base_sha
        OR NEW.recipe_digest IS NOT OLD.recipe_digest
        OR NEW.executor_digest IS NOT OLD.executor_digest
        OR NEW.pane_workspace_revision_origin IS NOT
          OLD.pane_workspace_revision_origin
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN
        SELECT RAISE(ABORT, 'workspace setup identity is immutable');
      END;

      CREATE TRIGGER workspace_setup_transition_guard
      BEFORE UPDATE OF state ON workspace_setup_requests
      WHEN NOT (
        (OLD.state = 'approval_required' AND OLD.setup_revision = 1
          AND NEW.state = 'prepared' AND NEW.setup_revision = 2)
        OR (OLD.state = 'prepared' AND OLD.setup_revision = 2
          AND NEW.state = 'effect_started' AND NEW.setup_revision = 3)
        OR (OLD.state = 'effect_started'
          AND OLD.setup_revision = 3
          AND NEW.state IN ('succeeded', 'failed', 'ambiguous')
          AND NEW.setup_revision = 4)
      )
      BEGIN
        SELECT RAISE(ABORT, 'invalid workspace setup transition');
      END;

      CREATE TRIGGER workspace_setup_revision_guard
      BEFORE UPDATE OF setup_revision ON workspace_setup_requests
      WHEN NEW.state IS OLD.state
        OR NEW.setup_revision != OLD.setup_revision + 1
      BEGIN
        SELECT RAISE(ABORT, 'invalid workspace setup revision');
      END;

      DROP TRIGGER IF EXISTS workspace_setup_pane_preservation_guard;
      CREATE TRIGGER workspace_setup_pane_preservation_guard
      BEFORE UPDATE OF state ON chat_pane_workspace_bindings
      WHEN OLD.state != 'preserved' AND NEW.state = 'preserved'
        AND EXISTS (
          SELECT 1
          FROM workspace_setup_lane_heads AS head
          JOIN workspace_setup_requests AS request
            ON request.request_id = head.request_id
           AND request.lane_id = head.lane_id
          JOIN workspace_leases AS lease
            ON lease.lane_id = request.lane_id
           AND lease.project_id = request.project_id
          WHERE head.lane_id = OLD.expected_lane_id
            AND request.project_id = OLD.project_id
            AND request.state = 'effect_started'
        )
      BEGIN
        SELECT RAISE(ABORT, 'workspace setup effect must settle before pane preservation');
      END;

      DROP TRIGGER chat_pane_workspace_projection_update_guard;
      CREATE TRIGGER chat_pane_workspace_projection_update_guard
      BEFORE UPDATE OF workspace_mode, workspace_state, workspace_revision,
        workspace_recovery_reason ON chat_panes
      WHEN (
        (
          NEW.workspace_mode IS NOT OLD.workspace_mode
          OR NEW.workspace_state IS NOT OLD.workspace_state
          OR NEW.workspace_recovery_reason IS NOT OLD.workspace_recovery_reason
        )
        AND NEW.workspace_revision != OLD.workspace_revision + 1
      ) OR (
        NOT (
          NEW.workspace_mode IS NOT OLD.workspace_mode
          OR NEW.workspace_state IS NOT OLD.workspace_state
          OR NEW.workspace_recovery_reason IS NOT OLD.workspace_recovery_reason
        )
        AND NOT (
          NEW.workspace_revision = OLD.workspace_revision
          OR (
            NEW.workspace_revision = OLD.workspace_revision + 1
            AND NEW.revision = OLD.revision + 1
            AND EXISTS (
              SELECT 1
              FROM workspace_setup_lane_heads AS head
              JOIN workspace_setup_requests AS request
                ON request.request_id = head.request_id
               AND request.lane_id = head.lane_id
              JOIN workspace_leases AS lease
                ON lease.lane_id = request.lane_id
               AND lease.project_id = request.project_id
              JOIN chat_pane_workspace_bindings AS binding
                ON binding.expected_lane_id = request.lane_id
               AND binding.workspace_lease_id = request.lane_id
               AND binding.project_id = request.project_id
               AND binding.state != 'preserved'
              WHERE binding.pane_id = NEW.pane_id
                AND request.pane_workspace_revision_origin
                  + request.setup_revision = NEW.workspace_revision
            )
          )
        )
      ) OR (
        NEW.workspace_state IN ('waiting_capacity', 'recovery_required')
      ) != (NEW.workspace_recovery_reason IS NOT NULL)
        OR (
          NEW.workspace_state IN ('preparing', 'ready', 'preserved')
          AND NEW.workspace_recovery_reason IS NOT NULL
        )
        OR (
          OLD.workspace_mode = 'managed_worktree'
          AND NEW.workspace_mode != 'managed_worktree'
        )
        OR (
          NEW.workspace_mode = 'legacy_unbound'
          AND NOT (
            NEW.workspace_state = 'recovery_required'
            AND NEW.workspace_recovery_reason = 'legacy_unbound'
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid chat workspace projection transition');
      END;
    `,
  },
] as const satisfies readonly Migration[];
