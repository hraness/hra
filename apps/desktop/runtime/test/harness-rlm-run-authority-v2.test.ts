import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { assertProperty, fc, propertyParameters } from "@hra-internal/test";

import {
  RlmRunAuthorityV2,
  RlmRunAuthorityV2Error,
  replayClassForRlmOperation,
} from "../src/harness/rlm-run-authority-v2";
import {
  deriveRlmV2ReceiptId,
  rlmV2OperationSchema,
  type RlmV2NodePath,
  type RlmV2Operation,
} from "../src/harness/rlm-v2";
import { applyMigrations } from "../src/state/database";

const at = "2030-01-01T00:00:00.000Z";
const later = "2030-01-01T00:00:01.000Z";
const deadline = "2030-01-02T00:00:00.000Z";
const epochId = "hepoch_rlmrunfixture1";
const actorId = "hactor_rlmrunfixture1";
const turnId = "hturn_rlmrunfixture01";
const runId = "rlmrun_authorityfixture1";
const inputValueId = "ctxval_rlminputfixture1";
const programValueId = "ctxval_rlmprogramfixture1";
const prefixValueId = "ctxval_rlmprefixfixture1";
const snapshotId = "ctxsnap_rlmrunfixture1";
const digest = "a".repeat(64);
const otherDigest = "b".repeat(64);
const PROPERTY_TIMEOUT = propertyParameters.interruptAfterTimeLimit + 5_000;
const replayClasses: Readonly<Record<
  RlmV2Operation,
  ReturnType<typeof replayClassForRlmOperation>
>> = {
  "context.snapshot": "pureRead",
  "context.search": "pureRead",
  "context.slice": "pureRead",
  "context.materialize": "idempotentLocalMutation",
  "heap.put": "idempotentLocalMutation",
  "heap.get": "pureRead",
  "heap.list": "pureRead",
  "agent.spawn": "reconciledExternalMutation",
  "agent.send": "reconciledExternalMutation",
  "agent.status": "pureRead",
  "agent.waitAny": "cancelableWait",
  "agent.waitAll": "cancelableWait",
  "agent.result": "idempotentLocalMutation",
  "agent.cancel": "reconciledExternalMutation",
  "routing.inspect": "pureRead",
  "harness.propose": "idempotentLocalMutation",
};

interface Fixture {
  readonly authority: RlmRunAuthorityV2;
  readonly database: Database;
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
      'project-rlm-authority', '/tmp/rlm-authority',
      '/tmp/rlm-authority/.git', 'RLM Authority', ?1, ?1
    )
  `).run(at);
  database.query(`
    INSERT INTO harness_actor_epochs (
      epoch_id, project_id, source_sha, root_actor_id, max_depth,
      max_active_descendants, max_durable_descendants, token_budget,
      byte_budget, deadline, lane_authority, state, revision,
      created_at, updated_at
    ) VALUES (
      ?1, 'project-rlm-authority', ?2, ?3, 3, 8, 50, 100000,
      16777216, ?4, 'managedWrite', 'active', 1, ?5, ?5
    )
  `).run(epochId, "c".repeat(40), actorId, deadline, at);
  database.query(`
    INSERT INTO harness_actors (
      actor_id, epoch_id, parent_actor_id, depth, title, state,
      max_depth, max_active_descendants, max_durable_descendants,
      token_budget, byte_budget, deadline, lane_authority,
      revision, created_at, updated_at
    ) VALUES (
      ?1, ?2, NULL, 0, 'RLM root', 'active', 3, 8, 50,
      100000, 16777216, ?3, 'managedWrite', 1, ?4, ?4
    )
  `).run(actorId, epochId, deadline, at);
  insertValue(database, {
    id: inputValueId,
    operationId: "rlminputoperation0001",
    purpose: "currentInput",
  });
  insertValue(database, {
    id: programValueId,
    operationId: "rlmprogramoperation01",
    purpose: "programSource",
  });
  insertValue(database, {
    id: prefixValueId,
    operationId: "rlmprefixoperation001",
    purpose: "completedPrefix",
  });
  database.query(`
    INSERT INTO harness_actor_turns (
      turn_id, epoch_id, actor_id, ordinal, idempotency_key,
      input_value_id, state, desired_state, revision, created_at,
      started_at, settled_at, outcome_code
    ) VALUES (?1, ?2, ?3, 1, 'rlm-turn-request-0001', ?4,
      'running', 'run', 2, ?5, ?5, NULL, NULL)
  `).run(turnId, epochId, actorId, inputValueId, at);
  database.query(`
    INSERT INTO harness_context_snapshots (
      snapshot_id, epoch_id, actor_id, completed_through_turn_id,
      coverage_witness_digest, value_id, created_at, expires_at
    ) VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, NULL)
  `).run(snapshotId, epochId, actorId, digest, prefixValueId, at);
  return {
    authority: new RlmRunAuthorityV2(database, {
      now: () => new Date(later),
    }),
    database,
  };
}

function insertValue(
  database: Database,
  input: Readonly<{
    id: string;
    operationId: string;
    purpose:
      | "completedPrefix"
      | "currentInput"
      | "programResult"
      | "programSource";
    sourceTurnId?: string | null;
  }>,
): void {
  database.query(`
    INSERT INTO harness_context_values (
      value_id, operation_id, epoch_id, owner_actor_id, source_turn_id,
      kind, purpose, schema_version, name_digest, utf8_bytes,
      content_digest, chunk_size, chunk_count, manifest_digest,
      manifest_byte_length, quota_limit_bytes, state, recovery_reason,
      revision, created_at, updated_at, effect_started_at, activated_at
    ) VALUES (
      ?1, ?2, ?3, ?4, ?5,
      CASE WHEN ?6 = 'completedPrefix' THEN 'selection' ELSE 'json' END,
      ?6, 1, NULL, 2, ?7,
      65536, 1, ?7, 64, 16777216, 'active', NULL, 3,
      ?8, ?8, ?8, ?8
    )
  `).run(
    input.id,
    input.operationId,
    epochId,
    actorId,
    input.sourceTurnId ?? null,
    input.purpose,
    digest,
    at,
  );
  database.query(`
    INSERT INTO harness_context_value_chunks (
      value_id, ordinal, plaintext_bytes, object_digest, object_byte_length
    ) VALUES (?1, 0, 2, ?2, 64)
  `).run(input.id, digest);
}

function admission(overrides: Readonly<Record<string, unknown>> = {}) {
  const runDeadline = typeof overrides.deadline === "string"
    ? overrides.deadline
    : deadline;
  return {
    id: runId,
    epochId,
    actorId,
    turnId,
    programValueId,
    programDigest: digest,
    completedPrefixSnapshotId: snapshotId,
    currentUserInputValueId: inputValueId,
    capabilities: ["context.read", "agent.spawn", "heap.write"] as const,
    admittedFeatures: ["boundedPrograms", "recursiveAgents"] as const,
    semanticWitnessDigests: [digest, otherDigest] as const,
    budget: {
      depthRemaining: 3,
      activeDescendantLimit: 8,
      durableDescendantLimit: 50,
      tokenBudget: 100_000,
      deadline: runDeadline,
      heapByteLimit: 16 * 1024 * 1024,
      contextValueByteLimit: 1024 * 1024,
      messageByteLimit: 128 * 1024,
      laneAuthority: "managedWrite" as const,
    },
    fuelLimit: 512,
    deadline,
    releaseIdentityDigest: digest,
    admissionDigest: otherDigest,
    createdAt: at,
    ...overrides,
  };
}

function startRun(authority: RlmRunAuthorityV2) {
  const prepared = authority.prepareRun(admission());
  return authority.transitionRun({
    runId,
    expectedRevision: prepared.revision,
    expectedState: "prepared",
    nextState: "running",
    now: later,
  });
}

function receiptId(nodePath: RlmV2NodePath): string {
  return deriveRlmV2ReceiptId(runId, digest, nodePath);
}

function expectAuthorityCode(
  operation: () => unknown,
  code: RlmRunAuthorityV2Error["code"],
): void {
  let caught: unknown;
  try {
    operation();
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RlmRunAuthorityV2Error);
  expect(caught).toMatchObject({ code });
}

describe("RLM v2 durable run authority", () => {
  test("admits one exact immutable run and rejects identity reuse", () => {
    const value = fixture();
    try {
      const first = value.authority.prepareRun(admission());
      const replay = value.authority.prepareRun(admission());
      expect(replay).toEqual(first);
      expect(value.authority.prepareRun(admission({
        capabilities: ["heap.write", "context.read", "agent.spawn"],
        admittedFeatures: ["recursiveAgents", "boundedPrograms"],
        semanticWitnessDigests: [otherDigest, digest],
      }))).toEqual(first);
      expect(value.authority.prepareRun(admission({
        createdAt: "2030-01-03T00:00:00.000Z",
      }))).toEqual(first);
      expect(first).toMatchObject({
        state: "prepared",
        desiredState: "run",
        revision: 1,
      });
      expect(() => value.authority.prepareRun(admission({
        admissionDigest: digest,
      }))).toThrow(RlmRunAuthorityV2Error);
      for (const changed of [
        { admittedFeatures: ["boundedPrograms"] },
        { semanticWitnessDigests: [digest] },
        {
          budget: {
            ...admission().budget,
            tokenBudget: 99_999,
          },
        },
      ]) {
        expect(() => value.authority.prepareRun(admission(changed)))
          .toThrow(RlmRunAuthorityV2Error);
      }
    } finally {
      value.database.close();
    }
  });

  test("admits distinct immutable runs for multiple provider calls in one turn", () => {
    const value = fixture();
    try {
      const first = value.authority.prepareRun(admission());
      const second = value.authority.prepareRun(admission({
        id: "rlmrun_authorityfixture2",
        admissionDigest: digest,
      }));

      expect(first.id).toBe(runId);
      expect(second).toMatchObject({
        id: "rlmrun_authorityfixture2",
        turnId,
        state: "prepared",
      });
      expect(value.database.query(`
        SELECT run_id FROM harness_program_runs
        WHERE turn_id = ?1 ORDER BY run_id
      `).all(turnId)).toEqual([
        { run_id: runId },
        { run_id: "rlmrun_authorityfixture2" },
      ].toSorted((left, right) => left.run_id.localeCompare(right.run_id)));
    } finally {
      value.database.close();
    }
  });

  test("keeps suspend and stop intent durable and closes terminal transitions", () => {
    const value = fixture();
    try {
      const prepared = value.authority.prepareRun(admission());
      const running = value.authority.transitionRun({
        runId,
        expectedRevision: prepared.revision,
        expectedState: "prepared",
        nextState: "running",
        now: later,
      });
      const suspendedIntent = value.authority.requestDesiredState({
        runId,
        expectedRevision: running.revision,
        expectedDesiredState: "run",
        desiredState: "suspend",
        now: later,
      });
      const suspended = value.authority.transitionRun({
        runId,
        expectedRevision: suspendedIntent.revision,
        expectedState: "running",
        nextState: "suspended",
        now: later,
      });
      const stopping = value.authority.requestDesiredState({
        runId,
        expectedRevision: suspended.revision,
        expectedDesiredState: "suspend",
        desiredState: "stop",
        now: later,
      });
      const stopped = value.authority.transitionRun({
        runId,
        expectedRevision: stopping.revision,
        expectedState: "suspended",
        nextState: "stopped",
        terminalCode: "stop_requested",
        now: later,
      });
      expect(stopped).toMatchObject({
        desiredState: "stop",
        state: "stopped",
        terminalCode: "stop_requested",
        settledAt: later,
      });
      expect(value.authority.listRecoverableRuns({ limit: 10 })).toEqual([]);
      expect(() => value.authority.requestDesiredState({
        runId,
        expectedRevision: stopped.revision,
        expectedDesiredState: "stop",
        desiredState: "run",
      })).toThrow(RlmRunAuthorityV2Error);
    } finally {
      value.database.close();
    }
  });

  test("checkpoints run intent durably, fences new effects, and preserves explicit suspend", () => {
    const value = fixture();
    try {
      const running = startRun(value.authority);
      const checkpointed = value.authority.requestLifecycleCheckpoint({
        runId,
        expectedRevision: running.revision,
        now: later,
      });
      expect(checkpointed).toMatchObject({
        state: "running",
        desiredState: "run",
        lifecycleCheckpoint: true,
      });
      expect(() => value.database.query(`
        UPDATE harness_program_runs SET desired_state = 'suspend'
        WHERE run_id = ?1
      `).run(runId)).toThrow("CHECK constraint failed");

      const nodePath = [["step", 0]] as const;
      const receipt = value.authority.prepareReceipt({
        id: receiptId(nodePath),
        runId,
        nodePath,
        operation: "context.snapshot",
        requestDigest: digest,
        effectKey: otherDigest,
      });
      expectAuthorityCode(() => value.authority.transitionReceipt({
        receiptId: receipt.id,
        expectedState: "prepared",
        nextState: "effectStarted",
        now: later,
      }), "invalid_transition");

      const suspended = value.authority.transitionRun({
        runId,
        expectedRevision: checkpointed.revision,
        expectedState: "running",
        nextState: "suspended",
        now: later,
      });
      expectAuthorityCode(() => value.authority.transitionRun({
        runId,
        expectedRevision: suspended.revision,
        expectedState: "suspended",
        nextState: "running",
        now: later,
      }), "invalid_transition");
      const released = value.authority.releaseLifecycleCheckpoint({
        runId,
        expectedRevision: suspended.revision,
        now: later,
      });
      expect(released).toMatchObject({
        state: "suspended",
        desiredState: "run",
        lifecycleCheckpoint: false,
      });
      const resumed = value.authority.transitionRun({
        runId,
        expectedRevision: released.revision,
        expectedState: "suspended",
        nextState: "running",
        now: later,
      });
      const secondCheckpoint = value.authority.requestLifecycleCheckpoint({
        runId,
        expectedRevision: resumed.revision,
        now: later,
      });
      const explicitSuspend = value.authority.requestDesiredState({
        runId,
        expectedRevision: secondCheckpoint.revision,
        expectedDesiredState: "run",
        desiredState: "suspend",
        now: later,
      });
      expect(explicitSuspend).toMatchObject({
        desiredState: "suspend",
        lifecycleCheckpoint: false,
      });
    } finally {
      value.database.close();
    }
  });

  test("persists structural receipts without plaintext and verifies result lineage", () => {
    const value = fixture();
    try {
      startRun(value.authority);
      const nodePath = [["step", 0]] as const;
      const receipt = value.authority.prepareReceipt({
        id: receiptId(nodePath),
        runId,
        nodePath,
        operation: "agent.spawn",
        requestDigest: digest,
        effectKey: otherDigest,
        createdAt: later,
      });
      expect(receipt.replayClass).toBe("reconciledExternalMutation");
      expect(value.authority.prepareReceipt({
        id: receipt.id,
        runId,
        nodePath,
        operation: "agent.spawn",
        requestDigest: digest,
        effectKey: otherDigest,
        createdAt: later,
      })).toEqual(receipt);
      const effect = value.authority.transitionReceipt({
        receiptId: receipt.id,
        expectedState: "prepared",
        nextState: "effectStarted",
        now: later,
      });
      const resultValueId = "ctxval_rlmresultfixture1";
      insertValue(value.database, {
        id: resultValueId,
        operationId: "rlmresultoperation001",
        purpose: "programResult",
        sourceTurnId: turnId,
      });
      const succeeded = value.authority.transitionReceipt({
        receiptId: receipt.id,
        expectedState: effect.state,
        nextState: "succeeded",
        resultValueId,
        now: later,
      });
      expect(succeeded).toMatchObject({
        state: "succeeded",
        resultValueId,
        error: null,
      });
      expect(value.authority.listRecoverableReceipts({ limit: 10 })).toEqual([]);
      expect(JSON.stringify(succeeded)).not.toContain("secret-result");
    } finally {
      value.database.close();
    }
  });

  test("keeps effect uncertainty visible for boot reconciliation", () => {
    const value = fixture();
    try {
      startRun(value.authority);
      const nodePath = [["step", 1]] as const;
      const receipt = value.authority.prepareReceipt({
        id: receiptId(nodePath),
        runId,
        nodePath,
        operation: "heap.put",
        requestDigest: digest,
        effectKey: otherDigest,
      });
      value.authority.transitionReceipt({
        receiptId: receipt.id,
        expectedState: "prepared",
        nextState: "effectStarted",
      });
      expect(value.authority.listRecoverableReceipts({ limit: 10 })).toEqual([
        expect.objectContaining({
          id: receipt.id,
          state: "effectStarted",
          replayClass: "idempotentLocalMutation",
        }),
      ]);
    } finally {
      value.database.close();
    }
  });

  test("stores routing inspection through an unambiguous additive receipt alias", () => {
    const value = fixture();
    try {
      const prepared = value.authority.prepareRun(admission({
        capabilities: ["agent.wait", "routing.inspect"],
      }));
      value.authority.transitionRun({
        runId,
        expectedRevision: prepared.revision,
        expectedState: "prepared",
        nextState: "running",
        now: later,
      });
      const routingPath = [["step", 90]] as const;
      const routing = value.authority.prepareReceipt({
        id: receiptId(routingPath),
        runId,
        nodePath: routingPath,
        operation: "routing.inspect",
        requestDigest: digest,
        effectKey: otherDigest,
        createdAt: later,
      });
      expect(routing).toMatchObject({
        operation: "routing.inspect",
        replayClass: "pureRead",
      });
      expect(value.database.query(`
        SELECT operation, semantic_operation
        FROM harness_program_operation_receipts WHERE receipt_id = ?1
      `).get(routing.id)).toEqual({
        operation: "agent.status",
        semantic_operation: "routing.inspect",
      });
      expectAuthorityCode(() => value.authority.prepareReceipt({
        id: routing.id,
        runId,
        nodePath: routingPath,
        operation: "agent.status",
        requestDigest: digest,
        effectKey: otherDigest,
        createdAt: later,
      }), "conflict");

      const statusPath = [["step", 91]] as const;
      const status = value.authority.prepareReceipt({
        id: receiptId(statusPath),
        runId,
        nodePath: statusPath,
        operation: "agent.status",
        requestDigest: digest,
        effectKey: otherDigest,
        createdAt: later,
      });
      expect(status.operation).toBe("agent.status");
      expect(value.database.query(`
        SELECT operation, semantic_operation
        FROM harness_program_operation_receipts WHERE receipt_id = ?1
      `).get(status.id)).toEqual({
        operation: "agent.status",
        semantic_operation: null,
      });
      expect(value.authority.listRecoverableReceipts({ limit: 10 }).map(
        ({ operation }) => operation,
      ).toSorted()).toEqual(["agent.status", "routing.inspect"]);
    } finally {
      value.database.close();
    }
  });

  test("suspends automatically only with durable external replay evidence", () => {
    const value = fixture();
    try {
      const running = startRun(value.authority);
      expectAuthorityCode(() => value.authority.transitionRun({
        runId,
        expectedRevision: running.revision,
        expectedState: "running",
        nextState: "suspended",
        now: later,
      }), "invalid_transition");

      const nodePath = [["step", 31]] as const;
      const receipt = value.authority.prepareReceipt({
        id: receiptId(nodePath),
        runId,
        nodePath,
        operation: "agent.spawn",
        requestDigest: digest,
        effectKey: otherDigest,
      });
      value.authority.transitionReceipt({
        receiptId: receipt.id,
        expectedState: "prepared",
        nextState: "effectStarted",
        now: later,
      });
      value.authority.transitionReceipt({
        receiptId: receipt.id,
        expectedState: "effectStarted",
        nextState: "replayRequired",
        now: later,
      });

      const suspended = value.authority.transitionRun({
        runId,
        expectedRevision: running.revision,
        expectedState: "running",
        nextState: "suspended",
        now: later,
      });
      expect(suspended).toMatchObject({
        state: "suspended",
        desiredState: "run",
      });
      expect(value.authority.transitionRun({
        runId,
        expectedRevision: suspended.revision,
        expectedState: "suspended",
        nextState: "running",
        now: later,
      })).toMatchObject({
        state: "running",
        desiredState: "run",
      });
    } finally {
      value.database.close();
    }
  });

  test("drains accepted external stop debt before allowing terminal stop", () => {
    const value = fixture();
    try {
      const running = startRun(value.authority);
      const nodePath = [["step", 32]] as const;
      const prepared = value.authority.prepareReceipt({
        id: receiptId(nodePath),
        runId,
        nodePath,
        operation: "agent.spawn",
        requestDigest: digest,
        effectKey: otherDigest,
      });
      value.authority.transitionReceipt({
        receiptId: prepared.id,
        expectedState: "prepared",
        nextState: "effectStarted",
        now: later,
      });
      const stopping = value.authority.requestDesiredState({
        runId,
        expectedRevision: running.revision,
        expectedDesiredState: "run",
        desiredState: "stop",
        now: later,
      });
      expectAuthorityCode(() => value.authority.transitionRun({
        runId,
        expectedRevision: stopping.revision,
        expectedState: "running",
        nextState: "stopped",
        terminalCode: "stopped",
        now: later,
      }), "invalid_transition");

      const suspended = value.authority.transitionRun({
        runId,
        expectedRevision: stopping.revision,
        expectedState: "running",
        nextState: "suspended",
        now: later,
      });
      value.authority.transitionReceipt({
        receiptId: prepared.id,
        expectedState: "effectStarted",
        nextState: "replayRequired",
        now: later,
      });
      const afterDeadline = "2030-01-03T00:00:00.000Z";
      const draining = value.authority.transitionRun({
        runId,
        expectedRevision: suspended.revision,
        expectedState: "suspended",
        nextState: "running",
        now: afterDeadline,
      });
      value.authority.transitionReceipt({
        receiptId: prepared.id,
        expectedState: "replayRequired",
        nextState: "effectStarted",
        now: afterDeadline,
      });
      value.authority.transitionReceipt({
        receiptId: prepared.id,
        expectedState: "effectStarted",
        nextState: "failed",
        error: { code: "provider_rejected", retryable: false },
        now: afterDeadline,
      });
      expect(value.authority.transitionRun({
        runId,
        expectedRevision: draining.revision,
        expectedState: "running",
        nextState: "stopped",
        terminalCode: "stopped",
        now: afterDeadline,
      })).toMatchObject({ state: "stopped", desiredState: "stop" });
    } finally {
      value.database.close();
    }
  });

  test("uses explicit state witnesses for idempotent CAS and durable intent", () => {
    const value = fixture();
    try {
      const prepared = value.authority.prepareRun(admission());
      expectAuthorityCode(() => value.authority.transitionRun({
        runId,
        expectedRevision: prepared.revision,
        expectedState: "prepared",
        nextState: "suspended",
      }), "invalid_transition");

      const running = value.authority.transitionRun({
        runId,
        expectedRevision: prepared.revision,
        expectedState: "prepared",
        nextState: "running",
        now: later,
      });
      expect(value.authority.transitionRun({
        runId,
        expectedRevision: prepared.revision,
        expectedState: "prepared",
        nextState: "running",
        now: later,
      })).toEqual(running);

      const suspendIntent = value.authority.requestDesiredState({
        runId,
        expectedRevision: running.revision,
        expectedDesiredState: "run",
        desiredState: "suspend",
        now: later,
      });
      expect(value.authority.requestDesiredState({
        runId,
        expectedRevision: running.revision,
        expectedDesiredState: "run",
        desiredState: "suspend",
        now: later,
      })).toEqual(suspendIntent);
      expectAuthorityCode(() => value.authority.transitionRun({
        runId,
        expectedRevision: suspendIntent.revision,
        expectedState: "prepared",
        nextState: "running",
      }), "invalid_transition");
      const suspended = value.authority.transitionRun({
        runId,
        expectedRevision: suspendIntent.revision,
        expectedState: "running",
        nextState: "suspended",
        now: later,
      });
      expectAuthorityCode(() => value.authority.transitionRun({
        runId,
        expectedRevision: suspended.revision,
        expectedState: "suspended",
        nextState: "stopped",
        terminalCode: "stop_requested",
      }), "invalid_transition");
      expectAuthorityCode(() => value.authority.requestDesiredState({
        runId,
        expectedRevision: suspended.revision,
        expectedDesiredState: "suspend",
        desiredState: "suspend",
      }), "invalid_transition");
    } finally {
      value.database.close();
    }
  });

  test("derives receipt identity and enforces the admitted capability set", () => {
    const value = fixture();
    try {
      startRun(value.authority);
      const nodePath = [["step", 2]] as const;
      expectAuthorityCode(() => value.authority.prepareReceipt({
        id: "rlmop_not_the_structural_identity",
        runId,
        nodePath,
        operation: "agent.spawn",
        requestDigest: digest,
        effectKey: otherDigest,
      }), "conflict");
      expectAuthorityCode(() => value.authority.prepareReceipt({
        id: receiptId(nodePath),
        runId,
        nodePath,
        operation: "harness.propose",
        requestDigest: digest,
        effectKey: otherDigest,
      }), "conflict");

      const receipt = value.authority.prepareReceipt({
        id: receiptId(nodePath),
        runId,
        nodePath,
        operation: "agent.spawn",
        requestDigest: digest,
        effectKey: otherDigest,
      });
      expectAuthorityCode(() => value.authority.prepareReceipt({
        id: receipt.id,
        runId,
        nodePath,
        operation: "agent.spawn",
        requestDigest: otherDigest,
        effectKey: otherDigest,
      }), "conflict");
    } finally {
      value.database.close();
    }
  });

  test("rejects incoherent program and receipt-result lineage", () => {
    const value = fixture();
    try {
      expectAuthorityCode(() => value.authority.prepareRun(admission({
        programDigest: otherDigest,
      })), "conflict");

      startRun(value.authority);
      const nodePath = [["step", 3]] as const;
      const receipt = value.authority.prepareReceipt({
        id: receiptId(nodePath),
        runId,
        nodePath,
        operation: "heap.put",
        requestDigest: digest,
        effectKey: otherDigest,
      });
      const effect = value.authority.transitionReceipt({
        receiptId: receipt.id,
        expectedState: "prepared",
        nextState: "effectStarted",
      });
      const wrongResultValueId = "ctxval_wronglineageresult1";
      insertValue(value.database, {
        id: wrongResultValueId,
        operationId: "rlmwronglineageoperation1",
        purpose: "programResult",
      });
      expectAuthorityCode(() => value.authority.transitionReceipt({
        receiptId: receipt.id,
        expectedState: effect.state,
        nextState: "succeeded",
        resultValueId: wrongResultValueId,
      }), "conflict");
      expect(value.authority.readReceipt(receipt.id)?.state)
        .toBe("effectStarted");
    } finally {
      value.database.close();
    }
  });

  test("fails closed on noncanonical or relationally corrupted stored evidence", () => {
    const noncanonical = fixture();
    try {
      noncanonical.authority.prepareRun(admission());
      expect(() => noncanonical.database.query(`
        UPDATE harness_program_runs
        SET capabilities_json = '[ "agent.spawn", "context.read", "heap.write" ]'
        WHERE run_id = ?1
      `).run(runId)).toThrow("program-run admission is immutable");
      expect(noncanonical.authority.readRun(runId)?.capabilities).toEqual([
        "agent.spawn",
        "context.read",
        "heap.write",
      ]);
    } finally {
      noncanonical.database.close();
    }

    const lineage = fixture();
    try {
      lineage.authority.prepareRun(admission());
      lineage.database.query(`
        UPDATE harness_context_values SET content_digest = ?2
        WHERE value_id = ?1
      `).run(programValueId, otherDigest);
      expectAuthorityCode(
        () => lineage.authority.readRun(runId),
        "corrupt_state",
      );
    } finally {
      lineage.database.close();
    }

    const coordinate = fixture();
    try {
      startRun(coordinate.authority);
      const nodePath = [["step", 4]] as const;
      const receipt = coordinate.authority.prepareReceipt({
        id: receiptId(nodePath),
        runId,
        nodePath,
        operation: "context.snapshot",
        requestDigest: digest,
        effectKey: otherDigest,
      });
      coordinate.database.query(`
        UPDATE harness_program_operation_receipts
        SET canonical_node_path = '[ [ "step", 4 ] ]'
        WHERE receipt_id = ?1
      `).run(receipt.id);
      expectAuthorityCode(
        () => coordinate.authority.readReceipt(receipt.id),
        "corrupt_state",
      );
    } finally {
      coordinate.database.close();
    }

    const result = fixture();
    try {
      result.authority.prepareRun(admission());
      const wrongResultValueId = "ctxval_wrongstoredresult01";
      insertValue(result.database, {
        id: wrongResultValueId,
        operationId: "rlmwrongstoredoperation01",
        purpose: "programResult",
      });
      result.database.query(`
        UPDATE harness_program_runs SET
          state = 'completed', terminal_result_value_id = ?2,
          terminal_code = 'completed', revision = revision + 1,
          updated_at = ?3, settled_at = ?3
        WHERE run_id = ?1
      `).run(runId, wrongResultValueId, later);
      expectAuthorityCode(
        () => result.authority.readRun(runId),
        "corrupt_state",
      );
    } finally {
      result.database.close();
    }
  });

  test("paginates every recoverable receipt state without admitting settled failures", () => {
    const value = fixture();
    try {
      startRun(value.authority);
      const receipts = Array.from({ length: 5 }, (_, index) => {
        const nodePath = [["step", index + 5]] as const;
        return value.authority.prepareReceipt({
          id: receiptId(nodePath),
          runId,
          nodePath,
          operation: "heap.put",
          requestDigest: digest,
          effectKey: otherDigest,
        });
      });
      value.authority.transitionReceipt({
        receiptId: receipts[1]!.id,
        expectedState: "prepared",
        nextState: "effectStarted",
      });
      value.authority.transitionReceipt({
        receiptId: receipts[2]!.id,
        expectedState: "prepared",
        nextState: "replayRequired",
      });
      value.authority.transitionReceipt({
        receiptId: receipts[3]!.id,
        expectedState: "prepared",
        nextState: "recoveryRequired",
        error: { code: "uncertain_effect", retryable: false },
      });
      value.authority.transitionReceipt({
        receiptId: receipts[4]!.id,
        expectedState: "prepared",
        nextState: "effectStarted",
      });
      value.authority.transitionReceipt({
        receiptId: receipts[4]!.id,
        expectedState: "effectStarted",
        nextState: "failed",
        error: { code: "operation_failed", retryable: true },
      });

      const expectedIds = receipts.slice(0, 4).map((receipt) => receipt.id)
        .toSorted();
      const first = value.authority.listRecoverableReceipts({ limit: 2 });
      const second = value.authority.listRecoverableReceipts({
        afterReceiptId: first.at(-1)!.id,
        limit: 2,
      });
      const third = value.authority.listRecoverableReceipts({
        afterReceiptId: second.at(-1)!.id,
        limit: 2,
      });
      expect([...first, ...second, ...third].map((receipt) => receipt.id))
        .toEqual(expectedIds);
      expect(value.authority.listRecoverableRuns({ limit: 1 }))
        .toHaveLength(1);
      expect(value.authority.listRecoverableRuns({
        afterRunId: runId,
        limit: 1,
      })).toEqual([]);
    } finally {
      value.database.close();
    }
  });

  test("keeps recovery-required runs visible without reopening them", () => {
    const value = fixture();
    try {
      const prepared = value.authority.prepareRun(admission());
      const recovery = value.authority.transitionRun({
        runId,
        expectedRevision: prepared.revision,
        expectedState: "prepared",
        nextState: "recoveryRequired",
        terminalCode: "ambiguous_recovery",
      });
      expect(value.authority.listRecoverableRuns({ limit: 1 })).toEqual([
        recovery,
      ]);
      expectAuthorityCode(() => value.authority.transitionRun({
        runId,
        expectedRevision: recovery.revision,
        expectedState: "recoveryRequired",
        nextState: "running",
      }), "invalid_transition");
    } finally {
      value.database.close();
    }
  });

  test("bounds admission and effects by monotonic actor-owned deadlines", () => {
    const invalidAdmission = fixture();
    try {
      expectAuthorityCode(() => invalidAdmission.authority.prepareRun(admission({
        deadline: at,
      })), "invalid_transition");
      expectAuthorityCode(() => invalidAdmission.authority.prepareRun(admission({
        deadline: "2030-01-03T00:00:00.000Z",
      })), "conflict");
    } finally {
      invalidAdmission.database.close();
    }

    const value = fixture();
    try {
      const running = startRun(value.authority);
      expectAuthorityCode(() => value.authority.requestDesiredState({
        runId,
        expectedRevision: running.revision,
        expectedDesiredState: "run",
        desiredState: "suspend",
        now: at,
      }), "invalid_transition");
      const nodePath = [["step", 10]] as const;
      expectAuthorityCode(() => value.authority.prepareReceipt({
        id: receiptId(nodePath),
        runId,
        nodePath,
        operation: "heap.put",
        requestDigest: digest,
        effectKey: otherDigest,
        createdAt: at,
      }), "invalid_transition");
      const receipt = value.authority.prepareReceipt({
        id: receiptId(nodePath),
        runId,
        nodePath,
        operation: "heap.put",
        requestDigest: digest,
        effectKey: otherDigest,
        createdAt: later,
      });
      expectAuthorityCode(() => value.authority.transitionReceipt({
        receiptId: receipt.id,
        expectedState: "prepared",
        nextState: "effectStarted",
        now: at,
      }), "invalid_transition");
      expect(value.authority.readReceipt(receipt.id)?.state).toBe("prepared");
    } finally {
      value.database.close();
    }

    const expired = fixture();
    try {
      const prepared = expired.authority.prepareRun(admission());
      expectAuthorityCode(() => expired.authority.transitionRun({
        runId,
        expectedRevision: prepared.revision,
        expectedState: "prepared",
        nextState: "running",
        now: deadline,
      }), "invalid_transition");
      expect(expired.authority.readRun(runId)?.state).toBe("prepared");
    } finally {
      expired.database.close();
    }
  });

  test("every closed operation has one fixed replay class", () => {
    const operations = rlmV2OperationSchema.options;
    expect(Object.keys(replayClasses).toSorted()).toEqual(
      [...operations].toSorted(),
    );
    assertProperty(fc.property(
      fc.constantFrom(...operations),
      (operation) => {
        const replayClass = replayClassForRlmOperation(operation);
        expect(replayClass).toBe(replayClasses[operation]);
        expect(replayClassForRlmOperation(operation)).toBe(replayClass);
      },
    ), {
      ...propertyParameters,
      interruptAfterTimeLimit: PROPERTY_TIMEOUT,
    });
  });
});
