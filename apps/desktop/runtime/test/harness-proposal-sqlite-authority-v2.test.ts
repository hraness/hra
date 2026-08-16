import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  assertAsyncProperty,
  fc,
} from "@hra-internal/test";

import {
  HarnessProposalSQLiteAuthorityV2,
  type HarnessProposalSQLiteAuthorityV2Error,
} from "../src/harness/proposal-sqlite-authority-v2";
import { HARNESS_PROPOSAL_ADMISSION_LIMIT } from
  "../src/harness/proposal-service";
import { runtimeHarnessProposalProjectionLimit } from
  "../../contracts/runtime";
import { HarnessRendererSQLiteAdapterV2 } from
  "../src/harness/renderer-sqlite-adapter-v2";
import { RlmRunAuthorityV2 } from
  "../src/harness/rlm-run-authority-v2";
import { deriveRlmRuntimeAdmissionDigest } from
  "../src/harness/rlm-runtime-v2";
import {
  RLM_V2_MAX_FUEL,
  deriveRlmV2ReceiptId,
  parseRlmV2Caller,
  type RlmV2Operation,
} from "../src/harness/rlm-v2";
import { applyMigrations } from "../src/state/database";

const at = "2030-01-01T00:00:00.000Z";
const later = "2030-01-01T00:00:01.000Z";
const deadline = "2030-01-02T00:00:00.000Z";
const projectId = "project-proposal-v2";
const epochId = "hepoch_proposalv2001";
const actorId = "hactor_proposalv2001";
const turnId = "hturn_proposalv20001";
const inputValueId = "ctxval_proposalinput01";
const programValueId = "ctxval_proposalprogram1";
const prefixValueId = "ctxval_proposalprefix01";
const snapshotId = "ctxsnap_proposalv2001";
const runId = "rlmrun_proposalv2001";
const programDigest = "a".repeat(64);
const releaseDigest = "b".repeat(64);
const semanticWitnessDigest = "d".repeat(64);
const proposalId = `hproposal_${"a".repeat(48)}`;
const operationId = deriveRlmV2ReceiptId(
  runId,
  programDigest,
  [["step", 0]],
);
const bodyValueId = "ctxval_proposalbody001";
const bodyDigest = "c".repeat(64);
const CONCURRENT_PROPOSAL_INTERRUPT_AFTER_TIME_LIMIT = 30_000;
const PROPERTY_TIMEOUT =
  CONCURRENT_PROPOSAL_INTERRUPT_AFTER_TIME_LIMIT + 5_000;

const caller = parseRlmV2Caller({
  epochId,
  actorId,
  turnId,
  capabilities: ["context.read", "harness.propose"],
  admittedFeatures: ["boundedPrograms", "instructionCandidates"],
  semanticWitnessDigests: [semanticWitnessDigest],
  budget: {
    depthRemaining: 3,
    activeDescendantLimit: 8,
    durableDescendantLimit: 50,
    tokenBudget: 100_000,
    deadline,
    heapByteLimit: 16 * 1024 * 1024,
    contextValueByteLimit: 1024 * 1024,
    messageByteLimit: 128 * 1024,
    laneAuthority: "managedWrite",
  },
});

function fixture() {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.query(`
    INSERT INTO projects (
      project_id, canonical_repository_path, canonical_git_common_dir,
      display_name, created_at, updated_at
    ) VALUES (?1, '/tmp/proposal-v2', '/tmp/proposal-v2/.git',
      'Proposal V2', ?2, ?2)
  `).run(projectId, at);
  database.query(`
    INSERT INTO harness_actor_epochs (
      epoch_id, project_id, source_sha, root_actor_id,
      max_depth, max_active_descendants, max_durable_descendants,
      token_budget, byte_budget, deadline, lane_authority,
      token_reserved, byte_reserved, next_root_completion_sequence,
      state, revision, created_at, updated_at, stopped_at
    ) VALUES (
      ?1, ?2, ?3, ?4, 3, 8, 50, 100000, 16777216, ?5,
      'managedWrite', 0, 0, 1, 'active', 1, ?6, ?6, NULL
    )
  `).run(epochId, projectId, "d".repeat(40), actorId, deadline, at);
  database.query(`
    INSERT INTO harness_actors (
      actor_id, epoch_id, parent_actor_id, depth, title, state,
      max_depth, max_active_descendants, max_durable_descendants,
      token_budget, byte_budget, deadline, lane_authority,
      token_reserved, byte_reserved, next_turn_ordinal, next_result_ordinal,
      revision, created_at, updated_at, stopped_at
    ) VALUES (
      ?1, ?2, NULL, 0, 'Root actor', 'active', 3, 8, 50,
      100000, 16777216, ?3, 'managedWrite', 0, 0, 2, 1,
      1, ?4, ?4, NULL
    )
  `).run(actorId, epochId, deadline, at);
  insertValue(database, {
    valueId: inputValueId,
    operationId: "contextop_proposalinput01",
    purpose: "currentInput",
    kind: "text",
    sourceTurnId: null,
    marker: "e",
  });
  insertValue(database, {
    valueId: programValueId,
    operationId: "contextop_proposalprogram1",
    purpose: "programSource",
    kind: "json",
    sourceTurnId: null,
    marker: "a",
  });
  insertValue(database, {
    valueId: prefixValueId,
    operationId: "contextop_proposalprefix01",
    purpose: "completedPrefix",
    kind: "selection",
    sourceTurnId: null,
    marker: "d",
  });
  database.query(`
    INSERT INTO harness_actor_turns (
      turn_id, epoch_id, actor_id, ordinal, idempotency_key,
      input_value_id, state, desired_state, revision,
      created_at, started_at, settled_at, outcome_code
    ) VALUES (
      ?1, ?2, ?3, 1, 'proposal_turn_idempotency', ?4,
      'running', 'run', 2, ?5, ?5, NULL, NULL
    )
  `).run(turnId, epochId, actorId, inputValueId, at);
  database.query(`
    INSERT INTO harness_context_snapshots (
      snapshot_id, epoch_id, actor_id, completed_through_turn_id,
      coverage_witness_digest, value_id, created_at, expires_at
    ) VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, NULL)
  `).run(snapshotId, epochId, actorId, semanticWitnessDigest, prefixValueId, at);
  const runs = new RlmRunAuthorityV2(database, {
    now: () => new Date(at),
  });
  const preparedRun = runs.prepareRun({
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
  });
  runs.transitionRun({
    runId,
    expectedRevision: preparedRun.revision,
    expectedState: "prepared",
    nextState: "running",
    now: later,
  });
  admitOperation(runs, 0, "harness.propose");
  const authority = new HarnessProposalSQLiteAuthorityV2(database, {
    now: () => new Date(later),
  });
  return { authority, database, runs };
}

function prepareInput(overrides: Readonly<Record<string, string>> = {}) {
  return {
    id: proposalId,
    epochId,
    actorId,
    sourceTurnId: turnId,
    operationId,
    title: "Prefer bounded context slices",
    bodyValueId,
    bodyDigest,
    ...overrides,
  };
}

function setRefinementMode(
  database: Database,
  mode: "off" | "suggest",
  revision: number,
): void {
  database.query(`
    UPDATE harness_settings SET refinement_mode = ?1, revision = ?2,
      updated_at = ?3 WHERE singleton = 1
  `).run(mode, revision, later);
}

function insertValue(
  database: Database,
  input: Readonly<{
    valueId: string;
    operationId: string;
    purpose:
      | "currentInput"
      | "proposal"
      | "programSource"
      | "completedPrefix";
    kind: "text" | "json" | "selection";
    sourceTurnId: string | null;
    marker: string;
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
      ?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, NULL, 2,
      ?8, 65536, 1, ?9, 4, 16777216, 'active', NULL,
      3, ?10, ?10, ?10, ?10
    )
  `).run(
    input.valueId,
    input.operationId,
    epochId,
    actorId,
    input.sourceTurnId,
    input.kind,
    input.purpose,
    input.marker.repeat(64),
    (input.marker === "f" ? "0" : "f").repeat(64),
    at,
  );
  database.query(`
    INSERT INTO harness_context_value_chunks (
      value_id, ordinal, plaintext_bytes, object_digest, object_byte_length
    ) VALUES (?1, 0, 2, ?2, 4)
  `).run(input.valueId, "9".repeat(64));
}

function admitOperation(
  runs: RlmRunAuthorityV2,
  ordinal: number,
  operation: RlmV2Operation,
): string {
  const nodePath = [["step", ordinal]] as const;
  const receiptId = deriveRlmV2ReceiptId(runId, programDigest, nodePath);
  const prepared = runs.prepareReceipt({
    id: receiptId,
    runId,
    nodePath,
    operation,
    requestDigest: ordinal.toString(16).padStart(64, "0"),
    effectKey: (ordinal + 256).toString(16).padStart(64, "0"),
    createdAt: later,
  });
  runs.transitionReceipt({
    receiptId,
    expectedState: prepared.state,
    nextState: "effectStarted",
    now: later,
  });
  return receiptId;
}

function indexedProposalInput(
  runs: RlmRunAuthorityV2,
  ordinal: number,
) {
  const marker = ordinal.toString(16).padStart(48, "0");
  return {
    id: `hproposal_${marker}`,
    epochId,
    actorId,
    sourceTurnId: turnId,
    operationId: ordinal === 0
      ? operationId
      : admitOperation(runs, ordinal, "harness.propose"),
    title: `Proposal ${ordinal}`,
    bodyValueId: `ctxval_${marker}`,
    bodyDigest: ordinal.toString(16).padStart(64, "0"),
  };
}

describe("SQLite suggest-only proposal authority", () => {
  test("keeps durable admission at the renderer's exact projection bound", () => {
    expect(HARNESS_PROPOSAL_ADMISSION_LIMIT).toBe(
      runtimeHarnessProposalProjectionLimit,
    );
  });

  test("prepares intent before body publication and activates only exact lineage", async () => {
    const { authority, database } = fixture();
    expect(await authority.refinementMode()).toBe("off");
    setRefinementMode(database, "suggest", 2);
    expect(await authority.refinementMode()).toBe("suggest");

    const prepared = await authority.prepare(prepareInput());
    expect(prepared).toMatchObject({
      id: proposalId,
      state: "prepared",
      revision: 1,
      bodyValueId,
    });
    expect(await rejection(authority.activate({ id: proposalId, expectedRevision: 1 })))
      .toMatchObject({
        code: "conflict",
      } satisfies Partial<HarnessProposalSQLiteAuthorityV2Error>);
    expect((await authority.read(proposalId))?.state).toBe("prepared");

    insertValue(database, {
      valueId: bodyValueId,
      operationId: "proposalbody_operation001",
      purpose: "proposal",
      kind: "json",
      sourceTurnId: turnId,
      marker: "8",
    });
    const active = await authority.activate({ id: proposalId, expectedRevision: 1 });
    expect(active).toMatchObject({ state: "active", revision: 2 });
    expect(await authority.list({ afterProposalId: null, limit: 32 }))
      .toEqual([active]);
  });

  test("admits a background proposal after origin success only through its exact live RLM receipt", async () => {
    const { authority, database, runs } = fixture();
    setRefinementMode(database, "suggest", 2);
    database.query(`
      UPDATE harness_actor_turns SET state = 'succeeded', revision = 3,
        settled_at = ?2, outcome_code = 'completed'
      WHERE turn_id = ?1
    `).run(turnId, later);

    const prepared = await authority.prepare(prepareInput());
    expect(prepared).toMatchObject({
      state: "prepared",
      operationId,
    });
    insertValue(database, {
      valueId: bodyValueId,
      operationId: "proposalbody_background001",
      purpose: "proposal",
      kind: "json",
      sourceTurnId: turnId,
      marker: "8",
    });
    expect(await authority.activate({
      id: proposalId,
      expectedRevision: prepared.revision,
    })).toMatchObject({ state: "active", revision: 2 });

    const forged = indexedProposalInput(runs, 1);
    runs.transitionReceipt({
      receiptId: forged.operationId,
      expectedState: "effectStarted",
      nextState: "failed",
      error: { code: "finished_before_proposal", retryable: false },
      now: later,
    });
    expect(await rejection(authority.prepare(forged))).toMatchObject({
      code: "conflict",
    } satisfies Partial<HarnessProposalSQLiteAuthorityV2Error>);
  });

  test("never widens succeeded-turn authority without an admitted proposal operation", async () => {
    const { authority, database, runs } = fixture();
    setRefinementMode(database, "suggest", 2);
    database.query(`
      UPDATE harness_actor_turns SET state = 'succeeded', revision = 3,
        settled_at = ?2, outcome_code = 'completed'
      WHERE turn_id = ?1
    `).run(turnId, later);
    const input = indexedProposalInput(runs, 2);
    database.query(`
      DELETE FROM harness_program_operation_receipts WHERE receipt_id = ?1
    `).run(input.operationId);

    expect(await rejection(authority.prepare(input))).toMatchObject({
      code: "conflict",
    } satisfies Partial<HarnessProposalSQLiteAuthorityV2Error>);
    expect(await authority.read(input.id)).toBeNull();
  });

  test("rejects a receipt whose stored node coordinate no longer derives its identity", async () => {
    const { authority, database } = fixture();
    setRefinementMode(database, "suggest", 2);
    database.query(`
      UPDATE harness_program_operation_receipts
      SET canonical_node_path = '[["step",7]]'
      WHERE receipt_id = ?1
    `).run(operationId);

    expect(await rejection(authority.prepare(prepareInput()))).toMatchObject({
      code: "corrupt_state",
    } satisfies Partial<HarnessProposalSQLiteAuthorityV2Error>);
    expect(await authority.read(proposalId)).toBeNull();
  });

  test("replays exact admission and rejects every colliding identity", async () => {
    const { authority, database } = fixture();
    setRefinementMode(database, "suggest", 2);
    const first = await authority.prepare(prepareInput());
    expect(await authority.prepare(prepareInput())).toEqual(first);
    expect(await rejection(authority.prepare(prepareInput({ title: "Different title" }))))
      .toMatchObject({ code: "conflict" });
    expect(await rejection(authority.prepare(prepareInput({
      id: `hproposal_${"f".repeat(48)}`,
    })))).toMatchObject({ code: "conflict" });
  });

  test("atomically admits at most 32 prepared or active proposals", async () => {
    const { authority, database, runs } = fixture();
    try {
      setRefinementMode(database, "suggest", 2);
      const inputs = Array.from(
        { length: 33 },
        (_unused, ordinal) => indexedProposalInput(runs, ordinal),
      );
      const settled = await Promise.allSettled(
        inputs.map(async (input) => await authority.prepare(input)),
      );
      const admitted = settled.flatMap((result, index) =>
        result.status === "fulfilled" ? [{ input: inputs[index]!, record: result.value }] : []
      );
      const rejected = settled.filter((result) => result.status === "rejected");
      expect(admitted).toHaveLength(32);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({
        reason: { code: "capacity_exhausted" },
      });

      for (const [index, entry] of admitted.entries()) {
        insertValue(database, {
          valueId: entry.input.bodyValueId,
          operationId: `proposalbody_capacity_${String(index).padStart(3, "0")}`,
          purpose: "proposal",
          kind: "json",
          sourceTurnId: turnId,
          marker: (index % 16).toString(16),
        });
        expect(await authority.activate({
          id: entry.input.id,
          expectedRevision: entry.record.revision,
        })).toMatchObject({ state: "active" });
      }
      expect(await authority.list({ afterProposalId: null, limit: 32 }))
        .toHaveLength(32);
      expect(() => new HarnessRendererSQLiteAdapterV2(database).read())
        .not.toThrow();
    } finally {
      database.close();
    }
  });

  test("property: concurrent proposal admission is order-independent and replay-safe", async () => {
    const ordinals = Array.from({ length: 33 }, (_unused, index) => index);
    await assertAsyncProperty(fc.asyncProperty(
      fc.shuffledSubarray(ordinals, { minLength: 33, maxLength: 33 }),
      async (order) => {
        const { authority, database, runs } = fixture();
        try {
          setRefinementMode(database, "suggest", 2);
          const inputs = order.map((ordinal) =>
            indexedProposalInput(runs, ordinal)
          );
          const settled = await Promise.allSettled(
            inputs.map(async (input) => await authority.prepare(input)),
          );
          const admitted = settled.flatMap((result, index) =>
            result.status === "fulfilled" ? [inputs[index]!] : []
          );
          expect(admitted).toHaveLength(32);
          expect(settled.filter(({ status }) => status === "rejected"))
            .toHaveLength(1);
          expect(database.query<{ proposal_count: number }, []>(`
            SELECT COUNT(*) AS proposal_count FROM harness_proposals
            WHERE state IN ('prepared', 'active')
          `).get()?.proposal_count).toBe(32);
          expect(await authority.prepare(admitted[0]!)).toMatchObject({
            id: admitted[0]!.id,
            state: "prepared",
          });
        } finally {
          database.close();
        }
      },
    ), {
      interruptAfterTimeLimit:
        CONCURRENT_PROPOSAL_INTERRUPT_AFTER_TIME_LIMIT,
      numRuns: 50,
    });
  }, PROPERTY_TIMEOUT);

  test("recovery quarantines a legacy 33rd prepared proposal without bricking projection", async () => {
    const { authority, database, runs } = fixture();
    try {
      setRefinementMode(database, "suggest", 2);
      for (let ordinal = 0; ordinal < 32; ordinal += 1) {
        const input = indexedProposalInput(runs, ordinal);
        const prepared = await authority.prepare(input);
        insertValue(database, {
          valueId: input.bodyValueId,
          operationId: `proposalbody_recovery_${String(ordinal).padStart(3, "0")}`,
          purpose: "proposal",
          kind: "json",
          sourceTurnId: turnId,
          marker: (ordinal % 16).toString(16),
        });
        await authority.activate({
          id: input.id,
          expectedRevision: prepared.revision,
        });
      }

      const overflow = indexedProposalInput(runs, 32);
      database.query(`
        INSERT INTO harness_proposals (
          proposal_id, epoch_id, actor_id, source_turn_id, operation_id,
          title, body_value_id, body_digest, state, recovery_reason,
          revision, created_at, updated_at, activated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
          'prepared', NULL, 1, ?9, ?9, NULL
        )
      `).run(
        overflow.id,
        overflow.epochId,
        overflow.actorId,
        overflow.sourceTurnId,
        overflow.operationId,
        overflow.title,
        overflow.bodyValueId,
        overflow.bodyDigest,
        at,
      );
      insertValue(database, {
        valueId: overflow.bodyValueId,
        operationId: "proposalbody_recovery_overflow",
        purpose: "proposal",
        kind: "json",
        sourceTurnId: turnId,
        marker: "f",
      });
      expect(await authority.inspectPreparedBody(overflow.id)).toBe("exact");
      expect(await authority.activateRecovered({
        id: overflow.id,
        expectedRevision: 1,
      })).toMatchObject({
        state: "recoveryRequired",
        recoveryReason: "capacity_exhausted",
        revision: 2,
      });
      expect(await authority.list({ afterProposalId: null, limit: 32 }))
        .toHaveLength(32);
      expect(() => new HarnessRendererSQLiteAdapterV2(database).read())
        .not.toThrow();
    } finally {
      database.close();
    }
  });

  test("fails closed when an active proposal loses its value evidence", async () => {
    const { authority, database } = fixture();
    setRefinementMode(database, "suggest", 2);
    await authority.prepare(prepareInput());
    insertValue(database, {
      valueId: bodyValueId,
      operationId: "proposalbody_operation001",
      purpose: "proposal",
      kind: "json",
      sourceTurnId: turnId,
      marker: "8",
    });
    await authority.activate({ id: proposalId, expectedRevision: 1 });
    database.query("DELETE FROM harness_context_value_chunks WHERE value_id = ?1")
      .run(bodyValueId);
    database.query("DELETE FROM harness_context_values WHERE value_id = ?1")
      .run(bodyValueId);
    expect(await rejection(authority.read(proposalId))).toMatchObject({
      code: "corrupt_state",
    } satisfies Partial<HarnessProposalSQLiteAuthorityV2Error>);
  });

  test("fails closed when a stored proposal loses its immutable RLM origin receipt", async () => {
    const { authority, database } = fixture();
    setRefinementMode(database, "suggest", 2);
    await authority.prepare(prepareInput());
    database.query(`
      DELETE FROM harness_program_operation_receipts WHERE receipt_id = ?1
    `).run(operationId);
    expect(await rejection(authority.read(proposalId))).toMatchObject({
      code: "corrupt_state",
    } satisfies Partial<HarnessProposalSQLiteAuthorityV2Error>);
  });

  test("atomically refuses prepare and activation when Suggest flips Off across awaits", async () => {
    const { authority, database } = fixture();

    setRefinementMode(database, "suggest", 2);
    const pendingPrepare = authority.prepare(prepareInput());
    setRefinementMode(database, "off", 3);
    expect(await rejection(pendingPrepare)).toMatchObject({
      code: "disabled",
    } satisfies Partial<HarnessProposalSQLiteAuthorityV2Error>);
    expect(await authority.read(proposalId)).toBeNull();

    setRefinementMode(database, "suggest", 4);
    await authority.prepare(prepareInput());
    insertValue(database, {
      valueId: bodyValueId,
      operationId: "proposalbody_operation001",
      purpose: "proposal",
      kind: "json",
      sourceTurnId: turnId,
      marker: "8",
    });
    const pendingActivation = authority.activate({
      id: proposalId,
      expectedRevision: 1,
    });
    setRefinementMode(database, "off", 5);
    expect(await rejection(pendingActivation))
      .toMatchObject({
        code: "disabled",
      } satisfies Partial<HarnessProposalSQLiteAuthorityV2Error>);
    expect((await authority.read(proposalId))?.state).toBe("prepared");
  });

  test("recovers prepared proposals after their source turn becomes terminal", async () => {
    const { authority, database } = fixture();
    setRefinementMode(database, "suggest", 2);
    await authority.prepare(prepareInput());
    insertValue(database, {
      valueId: bodyValueId,
      operationId: "proposalbody_operation001",
      purpose: "proposal",
      kind: "json",
      sourceTurnId: turnId,
      marker: "8",
    });
    database.query(`
      UPDATE harness_actor_turns SET state = 'succeeded', revision = 3,
        settled_at = ?2, outcome_code = 'completed'
      WHERE turn_id = ?1
    `).run(turnId, later);
    setRefinementMode(database, "off", 3);

    expect(await authority.inspectPreparedBody(proposalId)).toBe("exact");
    expect(await authority.listPrepared({
      afterProposalId: null,
      limit: 32,
    })).toHaveLength(1);
    const active = await authority.activateRecovered({
      id: proposalId,
      expectedRevision: 1,
    });
    expect(active).toMatchObject({ state: "active", revision: 2 });
    expect(await authority.activateRecovered({
      id: proposalId,
      expectedRevision: 1,
    })).toEqual(active);
    expect(await authority.listPrepared({
      afterProposalId: null,
      limit: 32,
    })).toEqual([]);
  });

  test("durably quarantines a prepared proposal whose body is absent", async () => {
    const { authority, database } = fixture();
    setRefinementMode(database, "suggest", 2);
    await authority.prepare(prepareInput());
    expect(await authority.inspectPreparedBody(proposalId)).toBe("missing");
    const recovery = await authority.markRecoveryRequired({
      id: proposalId,
      expectedRevision: 1,
      reason: "body_missing",
    });
    expect(recovery).toMatchObject({
      state: "recoveryRequired",
      recoveryReason: "body_missing",
      revision: 2,
    });
    expect(await authority.markRecoveryRequired({
      id: proposalId,
      expectedRevision: 1,
      reason: "body_missing",
    })).toEqual(recovery);
  });
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected promise to reject");
}
