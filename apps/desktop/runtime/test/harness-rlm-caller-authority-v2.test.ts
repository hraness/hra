import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { fc } from "@hra-internal/test";

import {
  RlmCallerAuthorityV2,
} from "../src/harness/rlm-caller-authority-v2";
import {
  RlmRunAuthorityV2,
  type RlmRunRecord,
} from "../src/harness/rlm-run-authority-v2";
import {
  deriveRlmRuntimeAdmissionDigest,
} from "../src/harness/rlm-runtime-v2";
import {
  RlmV2OperationRouter,
} from "../src/harness/rlm-operation-router-v2";
import {
  RLM_V2_MAX_FUEL,
  deriveRlmV2ReceiptId,
  parseRlmV2Caller,
  type RlmV2OperationContext,
} from "../src/harness/rlm-v2";
import { applyMigrations } from "../src/state/database";

const at = "2030-01-01T00:00:00.000Z";
const later = "2030-01-01T00:00:01.000Z";
const laterStill = "2030-01-01T00:00:02.000Z";
const deadline = "2030-01-02T00:00:00.000Z";
const epochId = "hepoch_callerauthority01";
const actorId = "hactor_callerauthority01";
const turnId = "hturn_callerauthority001";
const runId = "rlmrun_callerauthority01";
const inputValueId = "ctxval_callerinput0001";
const programValueId = "ctxval_callerprogram001";
const prefixValueId = "ctxval_callerprefix0001";
const snapshotId = "ctxsnap_callerauthority01";
const programDigest = "a".repeat(64);
const witnessA = "b".repeat(64);
const witnessB = "c".repeat(64);
const releaseDigest = "d".repeat(64);
const quotaAccountId = "acct_caller_quota_cut_01";

const caller = parseRlmV2Caller({
  epochId,
  actorId,
  turnId,
  capabilities: ["agent.wait", "context.read"],
  admittedFeatures: ["boundedPrograms", "recursiveAgents"],
  semanticWitnessDigests: [witnessA, witnessB],
  budget: {
    depthRemaining: 3,
    activeDescendantLimit: 8,
    durableDescendantLimit: 50,
    tokenBudget: 100_000,
    deadline,
    heapByteLimit: 16 * 1024 * 1024,
    contextValueByteLimit: 1024 * 1024,
    messageByteLimit: 128 * 1024,
    laneAuthority: "readOnly",
  },
});

interface Fixture {
  readonly database: Database;
  readonly authority: RlmRunAuthorityV2;
  readonly adapter: RlmCallerAuthorityV2;
  readonly run: RlmRunRecord;
}

function fixture(): Fixture {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.query(`
    INSERT INTO projects (
      project_id, canonical_repository_path, canonical_git_common_dir,
      display_name, created_at, updated_at
    ) VALUES (
      'project-caller-authority', '/tmp/caller-authority',
      '/tmp/caller-authority/.git', 'Caller authority', ?1, ?1
    )
  `).run(at);
  database.query(`
    INSERT INTO harness_actor_epochs (
      epoch_id, project_id, source_sha, root_actor_id, max_depth,
      max_active_descendants, max_durable_descendants, token_budget,
      byte_budget, deadline, lane_authority, state, revision,
      created_at, updated_at
    ) VALUES (
      ?1, 'project-caller-authority', ?2, ?3, 3, 8, 50, 100000,
      16777216, ?4, 'managedWrite', 'active', 1, ?5, ?5
    )
  `).run(epochId, "e".repeat(40), actorId, deadline, at);
  database.query(`
    INSERT INTO harness_actors (
      actor_id, epoch_id, parent_actor_id, depth, title, state,
      max_depth, max_active_descendants, max_durable_descendants,
      token_budget, byte_budget, deadline, lane_authority,
      revision, created_at, updated_at
    ) VALUES (
      ?1, ?2, NULL, 0, 'Caller root', 'active', 3, 8, 50,
      100000, 16777216, ?3, 'managedWrite', 1, ?4, ?4
    )
  `).run(actorId, epochId, deadline, at);
  insertValue(database, inputValueId, "callerinputoperation01", "currentInput");
  insertValue(database, programValueId, "callerprogramoperation1", "programSource");
  insertValue(database, prefixValueId, "callerprefixoperation01", "completedPrefix");
  database.query(`
    INSERT INTO harness_actor_turns (
      turn_id, epoch_id, actor_id, ordinal, idempotency_key,
      input_value_id, state, desired_state, revision, created_at,
      started_at, settled_at, outcome_code
    ) VALUES (
      ?1, ?2, ?3, 1, 'caller-turn-request-0001', ?4,
      'running', 'run', 2, ?5, ?5, NULL, NULL
    )
  `).run(turnId, epochId, actorId, inputValueId, at);
  database.query(`
    INSERT INTO harness_context_snapshots (
      snapshot_id, epoch_id, actor_id, completed_through_turn_id,
      coverage_witness_digest, value_id, created_at, expires_at
    ) VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, NULL)
  `).run(snapshotId, epochId, actorId, witnessA, prefixValueId, at);

  const admission = {
    id: runId,
    epochId,
    actorId,
    turnId,
    programValueId,
    programDigest,
    completedPrefixSnapshotId: snapshotId,
    currentUserInputValueId: inputValueId,
    capabilities: caller.capabilities,
    admittedFeatures: caller.admittedFeatures,
    semanticWitnessDigests: caller.semanticWitnessDigests,
    budget: caller.budget,
    fuelLimit: RLM_V2_MAX_FUEL,
    deadline,
    releaseIdentityDigest: releaseDigest,
    admissionDigest: deriveRlmRuntimeAdmissionDigest({
      runId,
      epochId,
      actorId,
      turnId,
      completedPrefixSnapshotId: snapshotId,
      currentUserInputValueId: inputValueId,
      releaseIdentityDigest: releaseDigest,
      fuelLimit: RLM_V2_MAX_FUEL,
      programDigest,
      caller,
    }),
    createdAt: at,
  } as const;
  const authority = new RlmRunAuthorityV2(database, {
    now: () => new Date(later),
  });
  const prepared = authority.prepareRun(admission);
  const run = authority.transitionRun({
    runId,
    expectedRevision: prepared.revision,
    expectedState: "prepared",
    nextState: "running",
    now: later,
  });
  return {
    database,
    authority,
    adapter: new RlmCallerAuthorityV2(database, {
      now: () => new Date(later),
    }),
    run,
  };
}

function insertValue(
  database: Database,
  id: string,
  operationId: string,
  purpose: "currentInput" | "programSource" | "completedPrefix",
): void {
  database.query(`
    INSERT INTO harness_context_values (
      value_id, operation_id, epoch_id, owner_actor_id, source_turn_id,
      kind, purpose, schema_version, name_digest, utf8_bytes,
      content_digest, chunk_size, chunk_count, manifest_digest,
      manifest_byte_length, quota_limit_bytes, state, recovery_reason,
      revision, created_at, updated_at, effect_started_at, activated_at
    ) VALUES (
      ?1, ?2, ?3, ?4, NULL,
      CASE WHEN ?5 = 'completedPrefix' THEN 'selection' ELSE 'json' END,
      ?5, 1, NULL, 2, ?6,
      65536, 1, ?6, 64, 16777216, 'active', NULL, 3,
      ?7, ?7, ?7, ?7
    )
  `).run(id, operationId, epochId, actorId, purpose, programDigest, at);
  database.query(`
    INSERT INTO harness_context_value_chunks (
      value_id, ordinal, plaintext_bytes, object_digest, object_byte_length
    ) VALUES (?1, 0, 2, ?2, 64)
  `).run(id, programDigest);
}

function operationContext(
  run: RlmRunRecord,
  nodePath: RlmV2OperationContext["nodePath"] = [["step", 0]],
): RlmV2OperationContext {
  return {
    ...caller,
    programRunId: run.id,
    programDigest: run.programDigest,
    receiptId: deriveRlmV2ReceiptId(run.id, run.programDigest, nodePath),
    nodePath,
    signal: new AbortController().signal,
  };
}

function seedQuotaRejectedAttemptCrashCut(database: Database): void {
  database.query(`
    INSERT INTO account_profiles (
      profile_id, label, auth_state, process_generation,
      selected, created_at, updated_at
    ) VALUES (?1, ?1, 'signed_in', 1, 1, ?2, ?2)
  `).run(quotaAccountId, at);
  database.query(`
    INSERT INTO harness_actor_operations (
      operation_id, actor_id, turn_id, kind, request_digest, effect_key,
      state, provider_identity_json, created_at, updated_at, settled_at
    ) VALUES (
      'hoperation_callerquotacut01', ?1, NULL, 'actorStart', ?2, ?3,
      'succeeded', '{}', ?4, ?4, ?4
    )
  `).run(actorId, witnessA, witnessB, later);
  database.query(`
    INSERT INTO harness_actor_incarnations (
      incarnation_id, actor_id, ordinal, account_profile_id,
      process_generation, start_operation_id, client_request_id,
      thread_source, provider_thread_id, toolset_digest, state,
      created_at, updated_at, closed_at,
      token_usage_observation_generation
    ) VALUES (
      'hincarnation_callerquotacut01', ?1, 1, ?2, 1,
      'hoperation_callerquotacut01', 'client-request-caller-quota-cut-01',
      'oprte:caller-authority:quota-cut', 'provider-thread-caller-quota-cut',
      ?3, 'closed', ?4, ?4, ?4, 1
    )
  `).run(actorId, quotaAccountId, releaseDigest, later);
  database.query(`
    INSERT INTO harness_actor_turn_attempts (
      attempt_id, turn_id, incarnation_id, ordinal, account_profile_id,
      process_generation, client_user_message_id, provider_turn_id,
      state, quota_proof_digest, input_tokens, output_tokens,
      created_at, started_at, settled_at
    ) VALUES (
      'hattempt_callerquotacut01', ?1,
      'hincarnation_callerquotacut01', 1, ?2, 1,
      'client-message-caller-quota-cut-01',
      'provider-turn-caller-quota-cut', 'running', NULL, NULL, NULL,
      ?3, ?3, NULL
    )
  `).run(turnId, quotaAccountId, later);
  database.query(`
    UPDATE harness_actor_turn_attempts
    SET state = 'quotaRejected', quota_proof_digest = ?2, settled_at = ?3
    WHERE attempt_id = ?1
  `).run("hattempt_callerquotacut01", witnessA, laterStill);
}

async function expectAuthorityError(
  operation: Promise<unknown>,
  code: "corrupt_state" | "not_found" | "revoked",
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toMatchObject({ code });
}

describe("RLM v2 durable caller authority", () => {
  test("reconstructs the exact canonical caller across authority restart", async () => {
    const value = fixture();
    try {
      const restarted = new RlmCallerAuthorityV2(value.database, {
        now: () => new Date(later),
      });
      expect(await restarted.resolveCaller(value.run)).toEqual(caller);
      expect(await restarted.resolve(operationContext(value.run))).toEqual({
        epochId,
        actorId,
        turnId,
        actorDepth: 0,
        completedPrefixSnapshotId: snapshotId,
        currentUserInputValueId: inputValueId,
        contextQuotaBytes: 16 * 1024 * 1024,
      });
      const columns = value.database.query<{ name: string }, []>(
        "PRAGMA table_info(harness_program_runs)",
      ).all().map(({ name }) => name);
      expect(columns).not.toContain("provider_thread_id");
      expect(columns).not.toContain("process_generation");
    } finally {
      value.database.close();
    }
  });

  test("continues execution after a successful origin settles and restart", async () => {
    const value = fixture();
    try {
      value.database.query(`
        UPDATE harness_actor_turns
        SET state = 'succeeded', revision = revision + 1,
          settled_at = ?2, outcome_code = 'completed'
        WHERE turn_id = ?1
      `).run(turnId, laterStill);
      const restarted = new RlmCallerAuthorityV2(value.database, {
        now: () => new Date(laterStill),
      });
      expect(await restarted.resolveCaller(value.run)).toEqual(caller);
      expect(await restarted.resolve(operationContext(value.run))).toEqual({
        epochId,
        actorId,
        turnId,
        actorDepth: 0,
        completedPrefixSnapshotId: snapshotId,
        currentUserInputValueId: inputValueId,
        contextQuotaBytes: 16 * 1024 * 1024,
      });
    } finally {
      value.database.close();
    }
  });

  test("revokes every provider-adjacent operation while its origin turn reconciles", async () => {
    const value = fixture();
    try {
      value.database.query(`
        UPDATE harness_actor_turns SET state = 'reconciling'
        WHERE turn_id = ?1
      `).run(turnId);
      const invokedReceipts: string[] = [];
      const unused = () => Promise.reject(new Error("unused test port"));
      const router = new RlmV2OperationRouter({
        bindings: value.adapter,
        context: {
          invoke(_operation, _argumentsValue, input) {
            invokedReceipts.push(input.receiptId);
            return Promise.resolve({ ok: true });
          },
        },
        actors: {
          spawn: unused,
          send: unused,
          status: unused,
          waitAny: unused,
          waitAll: unused,
          result: unused,
          cancel: unused,
        },
        actorResults: { transfer: unused },
        proposals: { propose: unused },
      });
      await expectAuthorityError(
        router.invoke("context.snapshot", {}, operationContext(value.run)),
        "revoked",
      );
      expect(invokedReceipts).toEqual([]);
    } finally {
      value.database.close();
    }
  });

  test("revokes the quota-settlement crash cut before the turn row reconciles", async () => {
    const value = fixture();
    try {
      seedQuotaRejectedAttemptCrashCut(value.database);
      expect(value.database.query<{ state: string }, [string]>(`
        SELECT state FROM harness_actor_turns WHERE turn_id = ?1
      `).get(turnId)).toEqual({ state: "running" });
      expect(value.database.query<{ state: string }, []>(`
        SELECT state FROM harness_actor_turn_attempts
        WHERE attempt_id = 'hattempt_callerquotacut01'
      `).get()).toEqual({ state: "quotaRejected" });

      await expectAuthorityError(value.adapter.resolveCaller(value.run), "revoked");

      const invokedReceipts: string[] = [];
      const unused = () => Promise.reject(new Error("unused test port"));
      const router = new RlmV2OperationRouter({
        bindings: value.adapter,
        context: {
          invoke(_operation, _argumentsValue, input) {
            invokedReceipts.push(input.receiptId);
            return Promise.resolve({ ok: true });
          },
        },
        actors: {
          spawn: unused,
          send: unused,
          status: unused,
          waitAny: unused,
          waitAll: unused,
          result: unused,
          cancel: unused,
        },
        actorResults: { transfer: unused },
        proposals: { propose: unused },
      });
      await expectAuthorityError(
        router.invoke("context.snapshot", {}, operationContext(value.run)),
        "revoked",
      );
      expect(invokedReceipts).toEqual([]);
    } finally {
      value.database.close();
    }
  });

  test("makes every admitted caller input immutable in SQLite", () => {
    const value = fixture();
    try {
      for (const [column, replacement] of [
        ["capabilities_json", "[]"],
        ["admitted_features_json", '["boundedPrograms"]'],
        ["semantic_witness_digests_json", "[]"],
        ["recursive_budget_json", "{}"],
      ] as const) {
        expect(() => value.database.query(`
          UPDATE harness_program_runs SET ${column} = ?2 WHERE run_id = ?1
        `).run(runId, replacement)).toThrow("program-run admission is immutable");
      }
      expect(value.authority.readRun(runId)).toEqual(value.run);
    } finally {
      value.database.close();
    }
  });

  test("detects canonical caller corruption against the admission digest", async () => {
    const value = fixture();
    try {
      value.database.exec("DROP TRIGGER harness_program_run_admission_immutable_guard");
      value.database.query(`
        UPDATE harness_program_runs
        SET semantic_witness_digests_json = ?2
        WHERE run_id = ?1
      `).run(runId, JSON.stringify(["f".repeat(64)]));
      await expectAuthorityError(
        value.adapter.resolveCaller(value.run),
        "corrupt_state",
      );
    } finally {
      value.database.close();
    }
  });

  test("property: every changed durable caller coordinate is rejected", async () => {
    const value = fixture();
    try {
      const base = operationContext(value.run);
      const mutations = [
        () => ({ ...base, epochId: "hepoch_callerauthority02" }),
        () => ({ ...base, actorId: "hactor_callerauthority02" }),
        () => ({ ...base, turnId: "hturn_callerauthority002" }),
        () => ({ ...base, capabilities: ["agent.wait"] as const }),
        () => ({ ...base, admittedFeatures: ["boundedPrograms"] as const }),
        () => ({ ...base, semanticWitnessDigests: [witnessA] as const }),
        () => ({
          ...base,
          budget: { ...base.budget, tokenBudget: base.budget.tokenBudget - 1 },
        }),
        () => ({ ...base, programDigest: "f".repeat(64) }),
        () => ({ ...base, nodePath: [["step", 1]] as const }),
      ] as const;
      await fc.assert(fc.asyncProperty(
        fc.integer({ min: 0, max: mutations.length - 1 }),
        async (index) => {
          await expectAuthorityError(
            value.adapter.resolve(mutations[index]!()),
            "corrupt_state",
          );
        },
      ), { numRuns: 100 });
    } finally {
      value.database.close();
    }
  });

  test("revokes operation binding when durable turn authority changes", async () => {
    const value = fixture();
    try {
      value.database.query(`
        UPDATE harness_actor_turns SET desired_state = 'stop'
        WHERE turn_id = ?1
      `).run(turnId);
      await expectAuthorityError(
        value.adapter.resolve(operationContext(value.run)),
        "revoked",
      );
    } finally {
      value.database.close();
    }
  });

  test("fails closed for unsuccessful origin settlements", async () => {
    for (const state of [
      "failed",
      "cancelled",
      "quotaRejected",
      "ambiguous",
    ] as const) {
      const value = fixture();
      try {
        value.database.query(`
          UPDATE harness_actor_turns
          SET state = ?2, revision = revision + 1,
            settled_at = ?3, outcome_code = ?4
          WHERE turn_id = ?1
        `).run(turnId, state, laterStill, `origin_${state.toLowerCase()}`);
        await expectAuthorityError(
          value.adapter.resolveCaller(value.run),
          "revoked",
        );
        await expectAuthorityError(
          value.adapter.resolve(operationContext(value.run)),
          "revoked",
        );
      } finally {
        value.database.close();
      }
    }

    const forgedRecoveryCode = fixture();
    try {
      forgedRecoveryCode.database.query(`
        UPDATE harness_actor_turns
        SET state = 'failed', revision = revision + 1,
          settled_at = ?2,
          outcome_code = 'codex_runtime_restarted_after_provider_start'
        WHERE turn_id = ?1
      `).run(turnId, laterStill);
      await expectAuthorityError(
        forgedRecoveryCode.adapter.resolveCaller(forgedRecoveryCode.run),
        "revoked",
      );
    } finally {
      forgedRecoveryCode.database.close();
    }
  });

  test("revokes stopped, quarantined, expired, and recovery-required execution", async () => {
    const stopped = fixture();
    try {
      stopped.authority.requestDesiredState({
        runId,
        expectedRevision: stopped.run.revision,
        expectedDesiredState: "run",
        desiredState: "stop",
        now: laterStill,
      });
      await expectAuthorityError(
        stopped.adapter.resolveCaller(stopped.run),
        "revoked",
      );
    } finally {
      stopped.database.close();
    }

    const quarantined = fixture();
    try {
      quarantined.database.query(`
        UPDATE harness_actor_epochs
        SET state = 'quarantined', revision = revision + 1,
          updated_at = ?2, stopped_at = ?2
        WHERE epoch_id = ?1
      `).run(epochId, laterStill);
      await expectAuthorityError(
        quarantined.adapter.resolve(operationContext(quarantined.run)),
        "revoked",
      );
    } finally {
      quarantined.database.close();
    }

    const expired = fixture();
    try {
      const afterDeadline = new RlmCallerAuthorityV2(expired.database, {
        now: () => new Date(deadline),
      });
      await expectAuthorityError(
        afterDeadline.resolveCaller(expired.run),
        "revoked",
      );
    } finally {
      expired.database.close();
    }

    const recovery = fixture();
    try {
      recovery.authority.transitionRun({
        runId,
        expectedRevision: recovery.run.revision,
        expectedState: "running",
        nextState: "recoveryRequired",
        terminalCode: "recovery_required",
        now: laterStill,
      });
      await expectAuthorityError(
        recovery.adapter.resolveCaller(recovery.run),
        "revoked",
      );
    } finally {
      recovery.database.close();
    }
  });
});
