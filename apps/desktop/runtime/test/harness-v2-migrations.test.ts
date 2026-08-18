import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { RlmRunAuthorityV2 } from "../src/harness/rlm-run-authority-v2";
import { RlmRuntimeV2 } from "../src/harness/rlm-runtime-v2";
import {
  deriveRlmV2ReceiptId,
  type RlmV2NodePath,
} from "../src/harness/rlm-v2";
import { applyMigrations } from "../src/state/database";
import { migrations } from "../src/state/migrations";

const now = "2026-08-06T12:00:00.000Z";
const later = "2026-08-06T12:01:00.000Z";
const deadline = "2026-08-06T13:00:00.000Z";
const otherDeadline = "2026-08-06T12:30:00.000Z";
const digest = "a".repeat(64);
const rawDigest = "b".repeat(64);

function database(): Database {
  const value = new Database(":memory:", { strict: true });
  value.exec("PRAGMA foreign_keys = ON");
  applyMigrations(value);
  return value;
}

function databaseThrough(throughVersion: number): Database {
  const value = new Database(":memory:", { strict: true });
  value.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations) {
    if (migration.version > throughVersion) break;
    value.exec(migration.sql);
  }
  return value;
}

function seedProject(value: Database): void {
  value.query(`
    INSERT INTO projects (
      project_id, canonical_repository_path, canonical_git_common_dir,
      display_name, created_at, updated_at
    ) VALUES (
      'project_harnessv2', '/repo/example', '/repo/example/.git',
      'Example', ?1, ?1
    )
  `).run(now);
}

function seedEpochAndRoot(value: Database): void {
  seedProject(value);
  value.query(`
    INSERT INTO harness_actor_epochs (
      epoch_id, project_id, source_sha, root_actor_id, max_depth,
      max_active_descendants, max_durable_descendants, token_budget,
      byte_budget, deadline, lane_authority, state, revision,
      created_at, updated_at
    ) VALUES (
      'hepoch_fixture0001', 'project_harnessv2', ?1,
      'hactor_rootfixture01', 3, 8, 50, 100000, 16777216,
      ?2, 'managedWrite', 'active', 1, ?3, ?3
    )
  `).run("b".repeat(40), deadline, now);
  value.query(`
    INSERT INTO harness_actors (
      actor_id, epoch_id, parent_actor_id, depth, title, state,
      max_depth, max_active_descendants, max_durable_descendants,
      token_budget, byte_budget, deadline, lane_authority,
      revision, created_at, updated_at
    ) VALUES (
      'hactor_rootfixture01', 'hepoch_fixture0001', NULL, 0,
      'Root actor', 'active', 3, 8, 50, 100000, 16777216,
      ?1, 'managedWrite', 1, ?2, ?2
    )
  `).run(deadline, now);
}

function insertValue(
  value: Database,
  input: Readonly<{
    valueId: string;
    operationId: string;
    ownerActorId?: string;
    purpose?: "currentInput" | "agentResult";
  }>,
): void {
  value.query(`
    INSERT INTO harness_context_values (
      value_id, operation_id, epoch_id, owner_actor_id, source_turn_id,
      kind, purpose, schema_version, name_digest, utf8_bytes,
      content_digest, chunk_size, chunk_count, manifest_digest,
      manifest_byte_length, quota_limit_bytes, state, recovery_reason,
      revision, created_at, updated_at, effect_started_at, activated_at
    ) VALUES (
      ?1, ?2, 'hepoch_fixture0001', ?3, NULL,
      'text', ?4, 1, NULL, 1, ?5, 65536, 1, ?5,
      64, 16777216, 'active', NULL, 3, ?6, ?6, ?6, ?6
    )
  `).run(
    input.valueId,
    input.operationId,
    input.ownerActorId ?? "hactor_rootfixture01",
    input.purpose ?? "currentInput",
    digest,
    now,
  );
  value.query(`
    INSERT INTO harness_context_value_chunks (
      value_id, ordinal, plaintext_bytes, object_digest, object_byte_length
    ) VALUES (?1, 0, 1, ?2, 32)
  `).run(input.valueId, digest);
}

function insertCompletedPrefix(
  value: Database,
  input: Readonly<{
    valueId: string;
    operationId: string;
    sourceTurnId: string | null;
    utf8Bytes?: number;
    chunkCount?: number;
  }>,
): void {
  value.query(`
    INSERT INTO harness_context_values (
      value_id, operation_id, epoch_id, owner_actor_id, source_turn_id,
      kind, purpose, schema_version, name_digest, utf8_bytes,
      content_digest, chunk_size, chunk_count, manifest_digest,
      manifest_byte_length, quota_limit_bytes, state, recovery_reason,
      revision, created_at, updated_at, effect_started_at, activated_at
    ) VALUES (
      ?1, ?2, 'hepoch_fixture0001', 'hactor_rootfixture01', ?3,
      'selection', 'completedPrefix', 1, NULL, ?4, ?5, 65536, ?6, ?5,
      64, 67108864, 'active', NULL, 3, ?7, ?7, ?7, ?7
    )
  `).run(
    input.valueId,
    input.operationId,
    input.sourceTurnId,
    input.utf8Bytes ?? 1,
    digest,
    input.chunkCount ?? 1,
    now,
  );
}

function seedProgramAdmissionTurns(value: Database): void {
  seedEpochAndRoot(value);
  insertValue(value, {
    valueId: "ctxval_admissionpriorinput01",
    operationId: "operation_admissionpriorinput01",
  });
  insertValue(value, {
    valueId: "ctxval_admissioncurrentinput1",
    operationId: "operation_admissioncurrentinput1",
  });
  value.query(`
    INSERT INTO harness_actor_turns (
      turn_id, epoch_id, actor_id, ordinal, idempotency_key,
      input_value_id, state, desired_state, revision,
      created_at, started_at, settled_at, outcome_code
    ) VALUES (
      'hturn_admissionprior001', 'hepoch_fixture0001',
      'hactor_rootfixture01', 1, 'idempotency_admission_prior',
      'ctxval_admissionpriorinput01', 'succeeded', 'run', 3,
      ?1, ?1, ?1, 'completed'
    )
  `).run(now);
  value.query(`
    INSERT INTO harness_actor_turns (
      turn_id, epoch_id, actor_id, ordinal, idempotency_key,
      input_value_id, state, desired_state, revision,
      created_at, started_at, settled_at, outcome_code
    ) VALUES (
      'hturn_admissioncurrent01', 'hepoch_fixture0001',
      'hactor_rootfixture01', 2, 'idempotency_admission_current',
      'ctxval_admissioncurrentinput1', 'running', 'run', 2,
      ?1, ?1, NULL, NULL
    )
  `).run(now);
}

function insertProgramAdmissionIntent(
  value: Database,
  input: Readonly<{
    runId: string;
    completedThroughTurnId: string | null;
    expiresAt?: string;
    completedPrefixContentDigest?: string;
    includeContentDigest?: boolean;
  }>,
): void {
  value.query(`
    INSERT INTO harness_program_admission_intents (
      run_id, epoch_id, actor_id, turn_id, completed_prefix_value_id,
      completed_prefix_snapshot_id, current_user_input_value_id,
      program_digest, stable_admission_identity_digest,
      coverage_witness_digest, expires_at, state, recovery_reason,
      revision, created_at, updated_at, materialized_at, admitted_at,
      abandoned_at, completed_prefix_content_digest,
      completed_through_turn_id
    ) VALUES (
      ?1, 'hepoch_fixture0001', 'hactor_rootfixture01',
      'hturn_admissioncurrent01', 'ctxval_admissionprefix001',
      'ctxsnap_admissionprefix001', 'ctxval_admissioncurrentinput1',
      ?4, ?3, ?4, ?5, 'prepared', NULL, 1, ?6, ?6, NULL, NULL, NULL,
      ?7, ?2
    )
  `).run(
    input.runId,
    input.completedThroughTurnId,
    rawDigest,
    digest,
    input.expiresAt ?? deadline,
    now,
    input.includeContentDigest === false
      ? null
      : input.completedPrefixContentDigest ?? digest,
  );
}

function insertProgramSource(value: Database): void {
  value.query(`
    INSERT INTO harness_context_values (
      value_id, operation_id, epoch_id, owner_actor_id, source_turn_id,
      kind, purpose, schema_version, name_digest, utf8_bytes,
      content_digest, chunk_size, chunk_count, manifest_digest,
      manifest_byte_length, quota_limit_bytes, state, recovery_reason,
      revision, created_at, updated_at, effect_started_at, activated_at
    ) VALUES (
      'ctxval_admissionprogram001', 'operation_admissionprogram001',
      'hepoch_fixture0001', 'hactor_rootfixture01',
      'hturn_admissioncurrent01', 'json', 'programSource', 1, NULL, 1,
      ?1, 65536, 1, ?1, 64, 16777216, 'active', NULL, 3,
      ?2, ?2, ?2, ?2
    )
  `).run(digest, now);
  value.query(`
    INSERT INTO harness_context_value_chunks (
      value_id, ordinal, plaintext_bytes, object_digest, object_byte_length
    ) VALUES ('ctxval_admissionprogram001', 0, 1, ?1, 32)
  `).run(digest);
}

function insertProgramRun(value: Database, runDeadline: string): void {
  value.query(`
    INSERT INTO harness_program_runs (
      run_id, epoch_id, actor_id, turn_id, program_value_id,
      program_digest, completed_prefix_snapshot_id,
      current_user_input_value_id, capabilities_json,
      admitted_features_json, semantic_witness_digests_json,
      recursive_budget_json, fuel_limit, deadline,
      release_identity_digest, admission_digest, desired_state, state,
      terminal_result_value_id, terminal_code, revision, created_at,
      updated_at, settled_at
    ) VALUES (
      'rlmrun_admissionguard01', 'hepoch_fixture0001',
      'hactor_rootfixture01', 'hturn_admissioncurrent01',
      'ctxval_admissionprogram001', ?1, 'ctxsnap_admissionprefix001',
      'ctxval_admissioncurrentinput1', '["agent.spawn"]',
      '["boundedPrograms"]', '[]',
      json_object(
        'activeDescendantLimit', 8,
        'contextValueByteLimit', 1048576,
        'deadline', ?2,
        'depthRemaining', 3,
        'durableDescendantLimit', 50,
        'heapByteLimit', 16777216,
        'laneAuthority', 'managedWrite',
        'messageByteLimit', 131072,
        'tokenBudget', 100000
      ), 1, ?2, ?1, ?3, 'run', 'prepared',
      NULL, NULL, 1, ?4, ?4, NULL
    )
  `).run(digest, runDeadline, rawDigest, now);
}

function insertLegacyProgramReceipt(
  value: Database,
  input: Readonly<{
    nodePath: RlmV2NodePath;
    state: "prepared" | "effectStarted" | "replayRequired";
    updatedAt: string;
  }>,
): string {
  const receiptId = deriveRlmV2ReceiptId(
    "rlmrun_admissionguard01",
    digest,
    input.nodePath,
  );
  value.query(`
    INSERT INTO harness_program_operation_receipts (
      receipt_id, run_id, canonical_node_path, operation,
      request_digest, effect_key, replay_class, state,
      result_value_id, error_json, created_at, updated_at, settled_at
    ) VALUES (
      ?1, 'rlmrun_admissionguard01', ?2, 'agent.spawn',
      ?3, ?4, 'reconciledExternalMutation', ?5,
      NULL, NULL, ?6, ?7, NULL
    )
  `).run(
    receiptId,
    JSON.stringify(input.nodePath),
    digest,
    rawDigest,
    input.state,
    now,
    input.updatedAt,
  );
  return receiptId;
}

describe("clean recursive harness migrations", () => {
  test("contains only replay-v2 authority after the released v25 boundary", () => {
    const value = database();
    try {
      const tables = new Set(value.query<{ name: string }, []>(`
        SELECT name FROM sqlite_schema WHERE type = 'table'
      `).all().map(({ name }) => name));
      for (const required of [
        "harness_actor_epochs",
        "harness_actors",
        "harness_actor_turns",
        "harness_context_values",
        "harness_context_value_chunks",
        "harness_program_runs",
        "harness_program_operation_receipts",
        "harness_program_admission_intents",
        "harness_proposals",
        "harness_actor_incarnations",
        "harness_actor_turn_attempts",
        "harness_actor_turn_usage_inbox",
        "harness_actor_continuation_intents",
        "harness_actor_results",
      ]) expect(tables.has(required)).toBeTrue();
      for (const removed of [
        "harness_private_thread_bindings",
        "harness_heap_put_operations",
        "harness_program_checkpoints",
        "harness_agent_invocations",
        "harness_goals",
        "harness_trials",
        "harness_activation_decisions",
        "harness_data_storage_state",
      ]) expect(tables.has(removed)).toBeFalse();
      const paneColumns = new Set(value.query<{ name: string }, []>(
        "PRAGMA table_info(chat_panes)",
      ).all().map(({ name }) => name));
      expect(paneColumns.has("interaction_mode")).toBeTrue();
      const programRunColumns = new Set(value.query<{ name: string }, []>(
        "PRAGMA table_info(harness_program_runs)",
      ).all().map(({ name }) => name));
      expect(programRunColumns.has("lifecycle_checkpoint")).toBeTrue();
      expect(value.query(`
        SELECT context_quota_bytes FROM harness_settings WHERE singleton = 1
      `).get()).toEqual({ context_quota_bytes: 64 * 1024 * 1024 });
    } finally {
      value.close();
    }
  });

  test("migration 29 atomically quarantines legacy admission and ambiguous effects", async () => {
    const value = databaseThrough(28);
    try {
      seedProgramAdmissionTurns(value);
      value.query(`
        INSERT INTO harness_program_admission_intents (
          run_id, epoch_id, actor_id, turn_id,
          completed_prefix_value_id, completed_prefix_snapshot_id,
          current_user_input_value_id, program_digest,
          stable_admission_identity_digest, coverage_witness_digest,
          expires_at, state, recovery_reason, revision, created_at,
          updated_at, materialized_at, admitted_at, abandoned_at
        ) VALUES (
          'rlmrun_legacyadmission01', 'hepoch_fixture0001',
          'hactor_rootfixture01', 'hturn_admissioncurrent01',
          'ctxval_admissionprefix001', 'ctxsnap_admissionprefix001',
          'ctxval_admissioncurrentinput1', ?1, ?2, ?1, ?3,
          'prepared', NULL, 1, ?4, ?4, NULL, NULL, NULL
        )
      `).run(digest, rawDigest, deadline, now);

      value.query(`
        INSERT INTO harness_program_admission_intents (
          run_id, epoch_id, actor_id, turn_id,
          completed_prefix_value_id, completed_prefix_snapshot_id,
          current_user_input_value_id, program_digest,
          stable_admission_identity_digest, coverage_witness_digest,
          expires_at, state, recovery_reason, revision, created_at,
          updated_at, materialized_at, admitted_at, abandoned_at
        ) VALUES (
          'rlmrun_admissionguard01', 'hepoch_fixture0001',
          'hactor_rootfixture01', 'hturn_admissioncurrent01',
          'ctxval_admissionprefix001', 'ctxsnap_admissionprefix001',
          'ctxval_admissioncurrentinput1', ?1, ?2, ?1, ?3,
          'prepared', NULL, 1, ?4, ?4, NULL, NULL, NULL
        )
      `).run(digest, rawDigest, deadline, now);
      insertCompletedPrefix(value, {
        valueId: "ctxval_admissionprefix001",
        operationId: "operation_admissionprefix001",
        sourceTurnId: "hturn_admissionprior001",
      });
      value.query(`
        INSERT INTO harness_context_value_chunks (
          value_id, ordinal, plaintext_bytes, object_digest, object_byte_length
        ) VALUES ('ctxval_admissionprefix001', 0, 1, ?1, 32)
      `).run(digest);
      value.query(`
        INSERT INTO harness_context_snapshots (
          snapshot_id, epoch_id, actor_id, completed_through_turn_id,
          coverage_witness_digest, value_id, created_at, expires_at
        ) VALUES (
          'ctxsnap_admissionprefix001', 'hepoch_fixture0001',
          'hactor_rootfixture01', 'hturn_admissionprior001', ?1,
          'ctxval_admissionprefix001', ?2, ?3
        )
      `).run(digest, now, deadline);
      insertProgramSource(value);
      insertProgramRun(value, deadline);
      const receiptIds = [
        insertLegacyProgramReceipt(value, {
          nodePath: [["step", 0]],
          state: "prepared",
          updatedAt: now,
        }),
        insertLegacyProgramReceipt(value, {
          nodePath: [["step", 1]],
          state: "effectStarted",
          updatedAt: later,
        }),
        insertLegacyProgramReceipt(value, {
          nodePath: [["step", 2]],
          state: "replayRequired",
          updatedAt: later,
        }),
      ];
      value.query(`
        UPDATE harness_program_admission_intents
        SET state = 'admitted', revision = revision + 1,
          updated_at = ?2, materialized_at = ?2, admitted_at = ?2
        WHERE run_id = ?1
      `).run("rlmrun_admissionguard01", later);

      const migration = migrations.find(({ version }) => version === 29);
      if (migration === undefined) throw new Error("migration 29 is missing");
      value.transaction(() => value.exec(migration.sql))();

      expect(value.query(`
        SELECT state, recovery_reason, revision,
          completed_prefix_content_digest, completed_through_turn_id,
          admitted_at, abandoned_at
        FROM harness_program_admission_intents
        WHERE run_id = 'rlmrun_legacyadmission01'
      `).get()).toEqual({
        state: "recoveryRequired",
        recovery_reason: "partial_materialization",
        revision: 2,
        completed_prefix_content_digest: null,
        completed_through_turn_id: null,
        admitted_at: null,
        abandoned_at: null,
      });
      expect(() => value.query(`
        UPDATE harness_program_admission_intents
        SET completed_prefix_content_digest = ?1
        WHERE run_id = 'rlmrun_legacyadmission01'
      `).run(rawDigest)).toThrow("identity is immutable");
      expect(value.query(`
        SELECT state, recovery_reason, revision,
          completed_prefix_content_digest, completed_through_turn_id,
          admitted_at
        FROM harness_program_admission_intents
        WHERE run_id = 'rlmrun_admissionguard01'
      `).get()).toEqual({
        state: "recoveryRequired",
        recovery_reason: "partial_materialization",
        revision: 3,
        completed_prefix_content_digest: null,
        completed_through_turn_id: null,
        admitted_at: null,
      });
      expect(value.query(`
        SELECT desired_state, lifecycle_checkpoint, state, terminal_code,
          settled_at, revision
        FROM harness_program_runs
        WHERE run_id = 'rlmrun_admissionguard01'
      `).get()).toEqual({
        desired_state: "stop",
        lifecycle_checkpoint: 0,
        state: "recoveryRequired",
        terminal_code: "admission_evidence_missing",
        settled_at: now,
        revision: 2,
      });
      expect(value.query(`
        SELECT receipt_id, state, result_value_id, error_json,
          updated_at, settled_at
        FROM harness_program_operation_receipts
        WHERE run_id = 'rlmrun_admissionguard01'
        ORDER BY receipt_id
      `).all()).toEqual(receiptIds.toSorted().map((receiptId) => {
        const receiptUpdatedAt = receiptId === receiptIds[0] ? now : later;
        return {
          receipt_id: receiptId,
          state: "recoveryRequired",
          result_value_id: null,
          error_json:
            '{"code":"admission_evidence_missing","retryable":false}',
          updated_at: receiptUpdatedAt,
          settled_at: receiptUpdatedAt,
        };
      }));

      let operationCalls = 0;
      const runtime = new RlmRuntimeV2({
        authority: new RlmRunAuthorityV2(value),
        values: {
          sealJson: () => Promise.reject(new Error("unexpected value seal")),
          openJson: () => Promise.reject(new Error("unexpected value open")),
        },
        callers: {
          resolveCaller: () => Promise.reject(new Error("unexpected caller lookup")),
        },
        operations: {
          invoke: () => {
            operationCalls += 1;
            return Promise.reject(new Error("unexpected effect replay"));
          },
        },
      });
      expect(await runtime.reconcileOnBoot()).toEqual({
        scheduledRunIds: [],
        suspendedRunIds: [],
        stoppedRunIds: [],
        recoveryRequiredRunIds: ["rlmrun_admissionguard01"],
        replayPreparedReceiptIds: [],
      });
      expect(operationCalls).toBe(0);
    } finally {
      value.close();
    }
  });

  test("migration 36 adds exact actor-operation target indexes over a v35 database", () => {
    const value = databaseThrough(35);
    try {
      const names = () => new Set(value.query<{ name: string }, []>(
        "PRAGMA index_list('harness_actor_operations')",
      ).all().map(({ name }) => name));
      expect(names().has("harness_actor_operations_actor_recovery_idx"))
        .toBeFalse();
      expect(names().has("harness_actor_operations_turn_recovery_idx"))
        .toBeFalse();

      const migration = migrations.find(({ version }) => version === 36);
      if (migration === undefined) throw new Error("migration 36 is missing");
      value.transaction(() => value.exec(migration.sql))();
      expect(names().has("harness_actor_operations_actor_recovery_idx"))
        .toBeTrue();
      expect(names().has("harness_actor_operations_turn_recovery_idx"))
        .toBeTrue();
      const actorPlan = value.query<{ detail: string }, [string]>(`
        EXPLAIN QUERY PLAN
        SELECT operation_id FROM harness_actor_operations
        WHERE actor_id = ?1 ORDER BY operation_id LIMIT 1
      `).all("hactor_rootfixture01").map(({ detail }) => detail).join("\n");
      const turnPlan = value.query<{ detail: string }, [string]>(`
        EXPLAIN QUERY PLAN
        SELECT operation_id FROM harness_actor_operations
        WHERE turn_id = ?1 ORDER BY operation_id LIMIT 1
      `).all("hturn_admissioncurrent01").map(({ detail }) => detail).join("\n");
      expect(actorPlan).toContain("harness_actor_operations_actor_recovery_idx");
      expect(turnPlan).toContain("harness_actor_operations_turn_recovery_idx");
      expect(value.query("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
    } finally {
      value.close();
    }
  });

  test("migration 42 classifies legacy actors honestly and locks policy evidence", () => {
    const value = databaseThrough(41);
    try {
      seedEpochAndRoot(value);
      insertValue(value, {
        valueId: "ctxval_policy42input001",
        operationId: "operation_policy42input001",
      });
      value.query(`
        INSERT INTO harness_actor_turns (
          turn_id, epoch_id, actor_id, ordinal, idempotency_key,
          input_value_id, state, desired_state, revision,
          created_at, started_at, settled_at, outcome_code
        ) VALUES (
          'hturn_policy42legacy001', 'hepoch_fixture0001',
          'hactor_rootfixture01', 1, 'idempotency_policy42_legacy',
          'ctxval_policy42input001', 'starting', 'run', 2,
          ?1, ?1, NULL, NULL
        )
      `).run(now);
      value.query(`
        INSERT INTO account_profiles (
          profile_id, label, auth_state, process_generation,
          created_at, updated_at
        ) VALUES (
          'account_policy42legacy', 'Legacy Codex', 'signedIn', 1, ?1, ?1
        )
      `).run(now);
      value.query(`
        INSERT INTO harness_actor_operations (
          operation_id, actor_id, turn_id, kind, request_digest,
          effect_key, state, provider_identity_json,
          created_at, updated_at, settled_at
        ) VALUES (
          'hoperation_policy42start01', 'hactor_rootfixture01', NULL,
          'actorStart', ?1, ?2, 'succeeded', '{}', ?3, ?3, ?3
        )
      `).run(digest, rawDigest, now);
      value.query(`
        INSERT INTO harness_actor_incarnations (
          incarnation_id, actor_id, ordinal, account_profile_id,
          process_generation, start_operation_id, client_request_id,
          thread_source, provider_thread_id, toolset_digest, state,
          created_at, updated_at, closed_at
        ) VALUES (
          'hincarnation_policy42legacy01', 'hactor_rootfixture01', 1,
          'account_policy42legacy', 1, 'hoperation_policy42start01',
          'client-request-policy42-legacy', 'hra:policy42:legacy:fixture',
          'provider-thread-policy42', ?1, 'idle', ?2, ?2, NULL
        )
      `).run(digest, now);
      value.query(`
        INSERT INTO harness_actor_turn_attempts (
          attempt_id, turn_id, incarnation_id, ordinal,
          account_profile_id, process_generation, client_user_message_id,
          provider_turn_id, state, quota_proof_digest,
          created_at, started_at, settled_at
        ) VALUES (
          'hattempt_policy42legacy01', 'hturn_policy42legacy001',
          'hincarnation_policy42legacy01', 1, 'account_policy42legacy', 1,
          'client-message-policy42-legacy', NULL, 'starting', NULL,
          ?1, NULL, NULL
        )
      `).run(now);

      const migration = migrations.find((candidate) => candidate.version === 42);
      if (migration === undefined) throw new Error("migration 42 is missing");
      value.exec(migration.sql);

      expect(value.query(`
        SELECT dispatch_policy_version, work_class FROM harness_actors
        WHERE actor_id = 'hactor_rootfixture01'
      `).get()).toEqual({
        dispatch_policy_version: 0,
        work_class: "legacyUnclassified",
      });
      expect(value.query(`
        SELECT requested_model, requested_reasoning_effort,
          capability_evidence_digest, supports_fast,
          token_usage_cumulative_cached_input_tokens,
          token_usage_cumulative_reasoning_output_tokens
        FROM harness_actor_incarnations
        WHERE incarnation_id = 'hincarnation_policy42legacy01'
      `).get()).toEqual({
        requested_model: "gpt-5.6-sol",
        requested_reasoning_effort: "ultra",
        capability_evidence_digest: null,
        supports_fast: null,
        token_usage_cumulative_cached_input_tokens: null,
        token_usage_cumulative_reasoning_output_tokens: null,
      });
      expect(value.query(`
        SELECT acceleration_mode, acceleration_critical_path,
          acceleration_bottleneck FROM harness_actor_turns
        WHERE turn_id = 'hturn_policy42legacy001'
      `).get()).toEqual({
        acceleration_mode: "standard",
        acceleration_critical_path: 0,
        acceleration_bottleneck: "none",
      });
      expect(value.query(`
        SELECT requested_service_tier, realized_service_tier,
          tier_fallback_reason, cached_input_tokens, reasoning_output_tokens
        FROM harness_actor_turn_attempts
        WHERE attempt_id = 'hattempt_policy42legacy01'
      `).get()).toEqual({
        requested_service_tier: "standard",
        realized_service_tier: "standard",
        tier_fallback_reason: null,
        cached_input_tokens: null,
        reasoning_output_tokens: null,
      });
      expect(value.query(`
        SELECT automatic_fast_mode FROM harness_settings WHERE singleton = 1
      `).get()).toEqual({ automatic_fast_mode: "criticalPath" });
      expect(() => value.query(`
        UPDATE harness_actors SET work_class = 'standard'
        WHERE actor_id = 'hactor_rootfixture01'
      `).run()).toThrow("immutable");
      expect(() => value.query(`
        UPDATE harness_actor_turns SET acceleration_mode = 'fast'
        WHERE turn_id = 'hturn_policy42legacy001'
      `).run()).toThrow("immutable");
    } finally {
      value.close();
    }
  });

  test("migration 46 derives turn tier authority from immutable work class", () => {
    const value = databaseThrough(45);
    try {
      seedEpochAndRoot(value);
      const insertActor = value.query(`
        INSERT INTO harness_actors (
          actor_id, epoch_id, parent_actor_id, depth, title, state,
          max_depth, max_active_descendants, max_durable_descendants,
          token_budget, byte_budget, deadline, lane_authority,
          revision, created_at, updated_at,
          dispatch_policy_version, work_class
        ) VALUES (
          ?1, 'hepoch_fixture0001', 'hactor_rootfixture01', 1, ?2, 'active',
          3, 2, 4, 1000, 1048576, ?3, 'readOnlySnapshot',
          1, ?4, ?4, 1, ?5
        )
      `);
      insertActor.run(
        "hactor_policy46bounded01",
        "Bounded leaf",
        deadline,
        now,
        "boundedLeaf",
      );
      insertActor.run(
        "hactor_policy46standard01",
        "Standard work",
        deadline,
        now,
        "standard",
      );
      insertValue(value, {
        valueId: "ctxval_policy46bounded001",
        operationId: "operation_policy46bounded001",
        ownerActorId: "hactor_policy46bounded01",
        purpose: "currentInput",
      });
      insertValue(value, {
        valueId: "ctxval_policy46standard001",
        operationId: "operation_policy46standard001",
        ownerActorId: "hactor_policy46standard01",
        purpose: "currentInput",
      });
      value.query(`
        INSERT INTO harness_actor_turns (
          turn_id, epoch_id, actor_id, ordinal, idempotency_key,
          input_value_id, state, desired_state, revision, created_at,
          started_at, settled_at, outcome_code
        ) VALUES (
          'hturn_policy46bounded001', 'hepoch_fixture0001',
          'hactor_policy46bounded01', 1, 'idempotency-policy46-bounded',
          'ctxval_policy46bounded001', 'prepared', 'run', 1, ?1,
          NULL, NULL, NULL
        )
      `).run(now);
      value.query(`
        INSERT INTO harness_actor_turns (
          turn_id, epoch_id, actor_id, ordinal, idempotency_key,
          input_value_id, state, desired_state, revision, created_at,
          started_at, settled_at, outcome_code, acceleration_mode,
          acceleration_critical_path, acceleration_bottleneck
        ) VALUES (
          'hturn_policy46standard001', 'hepoch_fixture0001',
          'hactor_policy46standard01', 1, 'idempotency-policy46-standard',
          'ctxval_policy46standard001', 'prepared', 'run', 1, ?1,
          NULL, NULL, NULL, 'fast', 1, 'reasoning'
        )
      `).run(now);

      const migration = migrations.find((candidate) => candidate.version === 46);
      if (migration === undefined) throw new Error("migration 46 is missing");
      value.exec(migration.sql);

      expect(value.query(`
        SELECT actor_id, requested_service_tier FROM harness_actor_turns
        WHERE turn_id IN (
          'hturn_policy46bounded001', 'hturn_policy46standard001'
        ) ORDER BY actor_id
      `).all()).toEqual([
        {
          actor_id: "hactor_policy46bounded01",
          requested_service_tier: "fast",
        },
        {
          actor_id: "hactor_policy46standard01",
          requested_service_tier: "standard",
        },
      ]);
      expect(value.query(`
        SELECT turn_id, acceleration_mode, acceleration_critical_path,
          acceleration_bottleneck FROM harness_actor_turns
        WHERE turn_id IN (
          'hturn_policy46bounded001', 'hturn_policy46standard001'
        ) ORDER BY turn_id
      `).all()).toEqual([
        {
          turn_id: "hturn_policy46bounded001",
          acceleration_mode: "standard",
          acceleration_critical_path: 0,
          acceleration_bottleneck: "none",
        },
        {
          turn_id: "hturn_policy46standard001",
          acceleration_mode: "fast",
          acceleration_critical_path: 1,
          acceleration_bottleneck: "reasoning",
        },
      ]);
      expect(() => value.query(`
        UPDATE harness_actor_turns SET requested_service_tier = 'standard'
        WHERE turn_id = 'hturn_policy46bounded001'
      `).run()).toThrow("requested service tier is immutable");

      insertValue(value, {
        valueId: "ctxval_policy46bounded002",
        operationId: "operation_policy46bounded002",
        ownerActorId: "hactor_policy46bounded01",
        purpose: "currentInput",
      });
      expect(() => value.query(`
        INSERT INTO harness_actor_turns (
          turn_id, epoch_id, actor_id, ordinal, idempotency_key,
          input_value_id, state, desired_state, revision, created_at,
          started_at, settled_at, outcome_code
        ) VALUES (
          'hturn_policy46bounded002', 'hepoch_fixture0001',
          'hactor_policy46bounded01', 2, 'idempotency-policy46-bounded-two',
          'ctxval_policy46bounded002', 'prepared', 'run', 1, ?1,
          NULL, NULL, NULL
        )
      `).run(now)).toThrow("does not match its work class");
      value.query(`
        INSERT INTO harness_actor_turns (
          turn_id, epoch_id, actor_id, ordinal, idempotency_key,
          input_value_id, state, desired_state, revision, created_at,
          started_at, settled_at, outcome_code, requested_service_tier
        ) VALUES (
          'hturn_policy46bounded002', 'hepoch_fixture0001',
          'hactor_policy46bounded01', 2, 'idempotency-policy46-bounded-two',
          'ctxval_policy46bounded002', 'prepared', 'run', 1, ?1,
          NULL, NULL, NULL, 'fast'
        )
      `).run(now);
      expect(value.query("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
    } finally {
      value.close();
    }
  });

  test("binds new admission recovery evidence, materialization, and run expiry", () => {
    const value = database();
    try {
      seedProgramAdmissionTurns(value);
      expect(() => insertProgramAdmissionIntent(value, {
        runId: "rlmrun_admissionguard00",
        completedThroughTurnId: "hturn_admissionprior001",
        includeContentDigest: false,
      })).toThrow("lineage is incoherent");
      expect(() => insertProgramAdmissionIntent(value, {
        runId: "rlmrun_admissionguard04",
        completedThroughTurnId: "hturn_admissioncurrent01",
      })).toThrow("lineage is incoherent");

      insertProgramAdmissionIntent(value, {
        runId: "rlmrun_admissionguard01",
        completedThroughTurnId: "hturn_admissionprior001",
      });
      insertCompletedPrefix(value, {
        valueId: "ctxval_admissionprefix001",
        operationId: "operation_admissionprefix001",
        sourceTurnId: "hturn_admissionprior001",
      });
      value.query(`
        INSERT INTO harness_context_value_chunks (
          value_id, ordinal, plaintext_bytes, object_digest, object_byte_length
        ) VALUES ('ctxval_admissionprefix001', 0, 1, ?1, 32)
      `).run(digest);
      value.query(`
        INSERT INTO harness_context_snapshots (
          snapshot_id, epoch_id, actor_id, completed_through_turn_id,
          coverage_witness_digest, value_id, created_at, expires_at
        ) VALUES (
          'ctxsnap_admissionprefix001', 'hepoch_fixture0001',
          'hactor_rootfixture01', 'hturn_admissionprior001', ?1,
          'ctxval_admissionprefix001', ?2, ?3
        )
      `).run(digest, now, deadline);
      insertProgramAdmissionIntent(value, {
        runId: "rlmrun_admissionguard05",
        completedThroughTurnId: "hturn_admissionprior001",
        completedPrefixContentDigest: rawDigest,
      });
      expect(() => value.query(`
        UPDATE harness_program_admission_intents
        SET state = 'materialized', revision = revision + 1,
          updated_at = ?2, materialized_at = ?2
        WHERE run_id = ?1
      `).run("rlmrun_admissionguard05", later)).toThrow(
        "materialized program admission intent is incoherent",
      );
      expect(value.query(`
        UPDATE harness_program_admission_intents
        SET state = 'materialized', revision = revision + 1,
          updated_at = ?2, materialized_at = ?2
        WHERE run_id = ?1
      `).run("rlmrun_admissionguard01", later).changes).toBe(1);
      expect(value.query(`
        SELECT completed_prefix_content_digest, state
        FROM harness_program_admission_intents
        WHERE run_id = 'rlmrun_admissionguard01'
      `).get()).toEqual({
        completed_prefix_content_digest: digest,
        state: "materialized",
      });

      expect(() => value.query(`
        UPDATE harness_program_admission_intents
        SET completed_prefix_content_digest = ?2,
          state = 'recoveryRequired',
          recovery_reason = 'materialization_conflict',
          revision = revision + 1, updated_at = ?3
        WHERE run_id = ?1
      `).run("rlmrun_admissionguard01", rawDigest, later)).toThrow(
        "identity is immutable",
      );

      insertProgramAdmissionIntent(value, {
        runId: "rlmrun_admissionguard02",
        completedThroughTurnId: null,
      });
      expect(() => value.query(`
        UPDATE harness_program_admission_intents
        SET state = 'materialized', revision = revision + 1,
          updated_at = ?2, materialized_at = ?2
        WHERE run_id = ?1
      `).run("rlmrun_admissionguard02", later)).toThrow(
        "materialized program admission intent is incoherent",
      );

      insertProgramAdmissionIntent(value, {
        runId: "rlmrun_admissionguard03",
        completedThroughTurnId: "hturn_admissionprior001",
        expiresAt: otherDeadline,
      });
      expect(() => value.query(`
        UPDATE harness_program_admission_intents
        SET state = 'materialized', revision = revision + 1,
          updated_at = ?2, materialized_at = ?2
        WHERE run_id = ?1
      `).run("rlmrun_admissionguard03", later)).toThrow(
        "materialized program admission intent is incoherent",
      );

      insertProgramSource(value);
      insertProgramRun(value, otherDeadline);
      expect(() => value.query(`
        UPDATE harness_program_admission_intents
        SET state = 'admitted', revision = revision + 1,
          updated_at = ?2, admitted_at = ?2
        WHERE run_id = ?1
      `).run("rlmrun_admissionguard01", later)).toThrow(
        "lacks its exact run",
      );
      value.query(`
        DELETE FROM harness_program_runs
        WHERE run_id = 'rlmrun_admissionguard01'
      `).run();
      insertProgramRun(value, deadline);
      expect(value.query(`
        UPDATE harness_program_admission_intents
        SET state = 'admitted', revision = revision + 1,
          updated_at = ?2, admitted_at = ?2
        WHERE run_id = ?1
      `).run("rlmrun_admissionguard01", later).changes).toBe(1);
    } finally {
      value.close();
    }
  });

  test("enforces purpose-specific value capacity and exact snapshot lineage", () => {
    const value = database();
    try {
      seedEpochAndRoot(value);
      expect(() => value.query(`
        INSERT INTO harness_context_values (
          value_id, operation_id, epoch_id, owner_actor_id, source_turn_id,
          kind, purpose, schema_version, name_digest, utf8_bytes,
          content_digest, chunk_size, chunk_count, manifest_digest,
          manifest_byte_length, quota_limit_bytes, state, recovery_reason,
          revision, created_at, updated_at, effect_started_at, activated_at
        ) VALUES (
          'ctxval_oversizedheap01', 'operation_oversizedheap01',
          'hepoch_fixture0001', 'hactor_rootfixture01', NULL,
          'text', 'heap', 1, NULL, 1048577, ?1, 65536, 17, ?1,
          64, 67108864, 'prepared', NULL, 1, ?2, ?2, NULL, NULL
        )
      `).run(digest, now)).toThrow();
      expect(() => value.query(`
        INSERT INTO harness_context_values (
          value_id, operation_id, epoch_id, owner_actor_id, source_turn_id,
          kind, purpose, schema_version, name_digest, utf8_bytes,
          content_digest, chunk_size, chunk_count, manifest_digest,
          manifest_byte_length, quota_limit_bytes, state, recovery_reason,
          revision, created_at, updated_at, effect_started_at, activated_at
        ) VALUES (
          'ctxval_wrongprefixkind1', 'operation_wrongprefixkind1',
          'hepoch_fixture0001', 'hactor_rootfixture01', NULL,
          'json', 'completedPrefix', 1, NULL, 1, ?1, 65536, 1, ?1,
          64, 67108864, 'prepared', NULL, 1, ?2, ?2, NULL, NULL
        )
      `).run(digest, now)).toThrow();

      insertValue(value, {
        valueId: "ctxval_snapshotinput001",
        operationId: "operation_snapshotinput001",
      });
      value.query(`
        INSERT INTO harness_actor_turns (
          turn_id, epoch_id, actor_id, ordinal, idempotency_key,
          input_value_id, state, desired_state, revision,
          created_at, started_at, settled_at, outcome_code
        ) VALUES (
          'hturn_snapshotanchor001', 'hepoch_fixture0001',
          'hactor_rootfixture01', 1, 'idempotency_snapshot_anchor',
          'ctxval_snapshotinput001', 'succeeded', 'run', 3,
          ?1, ?1, ?1, 'completed'
        )
      `).run(now);
      expect(() => insertCompletedPrefix(value, {
        valueId: "ctxval_badsourceprefix01",
        operationId: "operation_badsourceprefix01",
        sourceTurnId: "hturn_missinganchor001",
      })).toThrow("source turn is incoherent");
      insertCompletedPrefix(value, {
        valueId: "ctxval_snapshotprefix001",
        operationId: "operation_snapshotprefix001",
        sourceTurnId: "hturn_snapshotanchor001",
      });
      value.query(`
        INSERT INTO harness_context_value_chunks (
          value_id, ordinal, plaintext_bytes, object_digest, object_byte_length
        ) VALUES ('ctxval_snapshotprefix001', 0, 1, ?1, 32)
      `).run(digest);
      value.query(`
        INSERT INTO harness_context_snapshots (
          snapshot_id, epoch_id, actor_id, completed_through_turn_id,
          coverage_witness_digest, value_id, created_at, expires_at
        ) VALUES (
          'ctxsnap_snapshotexact001', 'hepoch_fixture0001',
          'hactor_rootfixture01', 'hturn_snapshotanchor001', ?1,
          'ctxval_snapshotprefix001', ?2, NULL
        )
      `).run(digest, now);
      expect(() => value.query(`
        UPDATE harness_context_snapshots SET completed_through_turn_id = NULL
        WHERE snapshot_id = 'ctxsnap_snapshotexact001'
      `).run()).toThrow();
    } finally {
      value.close();
    }
  });

  test("enforces root identity and monotonically decreasing child authority", () => {
    const value = database();
    try {
      seedEpochAndRoot(value);
      const insertChild = value.query(`
        INSERT INTO harness_actors (
          actor_id, epoch_id, parent_actor_id, depth, title, state,
          max_depth, max_active_descendants, max_durable_descendants,
          token_budget, byte_budget, deadline, lane_authority,
          revision, created_at, updated_at
        ) VALUES (
          ?1, 'hepoch_fixture0001', 'hactor_rootfixture01', 1,
          'Child actor', 'active', 3, 4, 20, ?2, 8388608,
          ?3, ?4, 1, ?5, ?5
        )
      `);
      expect(() => insertChild.run(
        "hactor_wideningfixture1",
        100001,
        deadline,
        "managedWrite",
        now,
      )).toThrow("lineage or budget");
      insertChild.run(
        "hactor_childfixture001",
        50000,
        deadline,
        "readOnlySnapshot",
        now,
      );
      expect(value.query(`
        SELECT state, depth FROM harness_actors
        WHERE actor_id = 'hactor_childfixture001'
      `).get()).toEqual({ state: "active", depth: 1 });
    } finally {
      value.close();
    }
  });

  test("keeps actors alive across turns and enforces both result orders", () => {
    const value = database();
    try {
      seedEpochAndRoot(value);
      insertValue(value, {
        valueId: "ctxval_inputfixture001",
        operationId: "operation_inputfixture001",
      });
      insertValue(value, {
        valueId: "ctxval_inputfixture002",
        operationId: "operation_inputfixture002",
      });
      for (const ordinal of [1, 2]) {
        value.query(`
          INSERT INTO harness_actor_turns (
            turn_id, epoch_id, actor_id, ordinal, idempotency_key,
            input_value_id, state, desired_state, revision,
            created_at, started_at, settled_at, outcome_code
          ) VALUES (
            ?1, 'hepoch_fixture0001', 'hactor_rootfixture01', ?2, ?3,
            ?4, 'succeeded', 'run', 4, ?5, ?5, ?5, 'completed'
          )
        `).run(
          `hturn_fixture00000${String(ordinal)}`,
          ordinal,
          `idempotency_fixture_${String(ordinal)}`,
          `ctxval_inputfixture00${String(ordinal)}`,
          now,
        );
      }
      value.query(`
        INSERT INTO account_profiles (
          profile_id, label, identity_label, auth_state,
          process_generation, created_at, updated_at
        ) VALUES ('account_harnessfixture', 'Codex', NULL, 'signedIn', 1, ?1, ?1)
      `).run(now);
      value.query(`
        INSERT INTO harness_actor_operations (
          operation_id, actor_id, turn_id, kind, request_digest,
          effect_key, state, provider_identity_json,
          created_at, updated_at, settled_at
        ) VALUES (
          'hoperation_startfixture1', 'hactor_rootfixture01', NULL,
          'actorStart', ?1, ?1, 'succeeded', '{}', ?2, ?2, ?2
        )
      `).run(digest, now);
      value.query(`
        INSERT INTO harness_actor_incarnations (
          incarnation_id, actor_id, ordinal, account_profile_id,
          process_generation, start_operation_id, client_request_id,
          thread_source, provider_thread_id, toolset_digest, state,
          created_at, updated_at, closed_at
        ) VALUES (
          'hincarnation_fixture01', 'hactor_rootfixture01', 1,
          'account_harnessfixture', 1, 'hoperation_startfixture1',
          'clientrequest_fixture01', 'oprte-actor-fixture-source',
          'provider-thread-fixture', ?1, 'idle', ?2, ?2, NULL
        )
      `).run(digest, now);
      for (const ordinal of [1, 2]) {
        const turnId = `hturn_fixture00000${String(ordinal)}`;
        const attemptId = `hattempt_fixture000${String(ordinal)}`;
        value.query(`
          INSERT INTO harness_actor_turn_attempts (
            attempt_id, turn_id, incarnation_id, ordinal,
            account_profile_id, process_generation, client_user_message_id,
            provider_turn_id, state, quota_proof_digest,
            created_at, started_at, settled_at
          ) VALUES (
            ?1, ?2, 'hincarnation_fixture01', 1,
            'account_harnessfixture', 1, ?3, ?4,
            'completed', NULL, ?5, ?5, ?5
          )
        `).run(
          attemptId,
          turnId,
          `clientmessage_fixture${String(ordinal)}`,
          `provider-turn-${String(ordinal)}`,
          now,
        );
        insertValue(value, {
          valueId: `ctxval_resultfixture00${String(ordinal)}`,
          operationId: `operation_resultfixture00${String(ordinal)}`,
          purpose: "agentResult",
        });
        value.query(`
          INSERT INTO harness_actor_results (
            result_id, epoch_id, actor_id, turn_id, terminal_attempt_id,
            outcome, value_id, actor_result_ordinal,
            root_completion_sequence, created_at
          ) VALUES (
            ?1, 'hepoch_fixture0001', 'hactor_rootfixture01', ?2, ?3,
            'succeeded', ?4, ?5, ?5, ?6
          )
        `).run(
          `hresult_fixture0000${String(ordinal)}`,
          turnId,
          attemptId,
          `ctxval_resultfixture00${String(ordinal)}`,
          ordinal,
          now,
        );
      }
      expect(value.query(`
        SELECT state FROM harness_actors WHERE actor_id = 'hactor_rootfixture01'
      `).get()).toEqual({ state: "active" });
      expect(value.query(`
        SELECT actor_result_ordinal, root_completion_sequence
        FROM harness_actor_results ORDER BY actor_result_ordinal
      `).all()).toEqual([
        { actor_result_ordinal: 1, root_completion_sequence: 1 },
        { actor_result_ordinal: 2, root_completion_sequence: 2 },
      ]);
      expect(() => value.query(`
        UPDATE harness_actor_results SET root_completion_sequence = 1
        WHERE root_completion_sequence = 2
      `).run()).toThrow();
    } finally {
      value.close();
    }
  });

  test("preserves quarantined read-only snapshot identity", () => {
    const value = database();
    try {
      seedProject(value);
      value.query(`
        INSERT INTO workspace_leases (
          lane_id, project_id, account_profile_id, canonical_checkout_path,
          mode, status, base_sha, branch_name, retention, dirty_hint,
          recovery_manifest_path, checkpointed_at, created_at, updated_at,
          quarantine_reason, quarantined_at
        ) VALUES (
          'lane_snapshotfixture1', 'project_harnessv2', NULL, '/tmp/snapshot-one',
          'harness_read_only_snapshot', 'quarantined', ?1, NULL,
          'preserve', 1, NULL, NULL, ?2, ?2, 'dirty_checkout', ?2
        )
      `).run("c".repeat(40), now);
      expect(() => value.query(`
        INSERT INTO workspace_leases (
          lane_id, project_id, account_profile_id, canonical_checkout_path,
          mode, status, base_sha, branch_name, retention, dirty_hint,
          created_at, updated_at
        ) VALUES (
          'lane_snapshotfixture2', 'project_harnessv2', NULL, '/tmp/snapshot-two',
          'harness_read_only_snapshot', 'ready', ?1, NULL,
          'preserve', 0, ?2, ?2
        )
      `).run("c".repeat(40), now)).toThrow();
    } finally {
      value.close();
    }
  });
});
