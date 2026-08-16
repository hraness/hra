import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import {
  ProgramAdmissionIntentAuthorityV2,
  ProgramAdmissionIntentRecoveryV2,
  ProgramAdmissionIntentV2Error,
} from "../src/harness/program-admission-intent-v2";
import { ProgramAdmissionRlmRunRecoveryV2 } from
  "../src/harness/program-admission-run-recovery-v2";
import { deriveHarnessDynamicToolContextMaterializationIds } from
  "../src/harness/dynamic-tool-context-identity-v2";
import { RlmRunAuthorityV2 } from "../src/harness/rlm-run-authority-v2";
import { applyMigrations } from "../src/state/database";

const at = "2030-01-01T00:00:00.000Z";
const later = "2030-01-01T00:00:01.000Z";
const SQLITE_PROPERTY_INTERRUPT_AFTER_TIME_LIMIT = 30_000;
const SQLITE_PROPERTY_TIMEOUT =
  SQLITE_PROPERTY_INTERRUPT_AFTER_TIME_LIMIT + 5_000;
const deadline = "2030-01-02T00:00:00.000Z";
const otherDeadline = "2030-01-03T00:00:00.000Z";
const expiredAt = "2029-12-31T23:59:59.000Z";
const beforeExpiry = "2029-12-31T23:59:58.000Z";
const epochId = "hepoch_admissionintent1";
const actorId = "hactor_admissionintent1";
const turnId = "hturn_admissionintent01";
const inputValueId = "ctxval_admissioninput01";
const programValueId = "ctxval_admissionprogram1";
const runId = "rlmrun_admissionintent1";
const digest = "a".repeat(64);
const otherDigest = "b".repeat(64);
const materializationIds = deriveHarnessDynamicToolContextMaterializationIds({
  epochId,
  actorId,
  completedThroughTurnId: null,
  expiresAt: deadline,
  coverageWitnessDigest: digest,
  prefixContentDigest: digest,
});
const prefixValueId = materializationIds.completedPrefixValueId;
const snapshotId = materializationIds.completedPrefixSnapshotId;

interface Fixture {
  readonly database: Database;
  readonly intents: ProgramAdmissionIntentAuthorityV2;
  readonly runs: RlmRunAuthorityV2;
  setNow(value: string): void;
}

function fixture(): Fixture {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  let now = later;
  database.query(`
    INSERT INTO projects (
      project_id, canonical_repository_path, canonical_git_common_dir,
      display_name, created_at, updated_at
    ) VALUES (
      'project-admission-intent', '/tmp/admission-intent',
      '/tmp/admission-intent/.git', 'Admission intent', ?1, ?1
    )
  `).run(at);
  database.query(`
    INSERT INTO harness_actor_epochs (
      epoch_id, project_id, source_sha, root_actor_id, max_depth,
      max_active_descendants, max_durable_descendants, token_budget,
      byte_budget, deadline, lane_authority, state, revision,
      created_at, updated_at
    ) VALUES (
      ?1, 'project-admission-intent', ?2, ?3, 3, 8, 50, 100000,
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
      ?1, ?2, NULL, 0, 'Intent root', 'active', 3, 8, 50,
      100000, 16777216, ?3, 'managedWrite', 1, ?4, ?4
    )
  `).run(actorId, epochId, deadline, at);
  insertValue(database, {
    valueId: inputValueId,
    operationId: "admissioninputoperation01",
    purpose: "currentInput",
    sourceTurnId: null,
  });
  database.query(`
    INSERT INTO harness_actor_turns (
      turn_id, epoch_id, actor_id, ordinal, idempotency_key,
      input_value_id, state, desired_state, revision, created_at,
      started_at, settled_at, outcome_code
    ) VALUES (?1, ?2, ?3, 1, 'admission-intent-turn-01', ?4,
      'running', 'run', 2, ?5, ?5, NULL, NULL)
  `).run(turnId, epochId, actorId, inputValueId, at);
  const runs = new RlmRunAuthorityV2(database, {
    now: () => new Date(now),
  });
  const intents = new ProgramAdmissionIntentAuthorityV2(database, {
    now: () => new Date(now),
    runRecovery: new ProgramAdmissionRlmRunRecoveryV2(runs),
  });
  return {
    database,
    intents,
    runs,
    setNow(value: string) {
      now = value;
    },
  };
}

function intent(
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    runId,
    epochId,
    actorId,
    turnId,
    completedPrefixValueId: prefixValueId,
    completedPrefixContentDigest: digest,
    completedPrefixSnapshotId: snapshotId,
    completedThroughTurnId: null,
    currentUserInputValueId: inputValueId,
    programDigest: digest,
    stableAdmissionIdentityDigest: otherDigest,
    coverageWitnessDigest: digest,
    expiresAt: deadline,
    createdAt: at,
    ...overrides,
  };
}

function materialize(database: Database, options: Readonly<{
  value?: boolean;
  snapshot?: boolean;
  witnessDigest?: string;
  expiresAt?: string;
  createdAt?: string;
  valueId?: string;
  snapshotId?: string;
}> = {}): void {
  const materializedValueId = options.valueId ?? prefixValueId;
  const materializedSnapshotId = options.snapshotId ?? snapshotId;
  if (options.value !== false) {
    insertValue(database, {
      valueId: materializedValueId,
      operationId: "admissionprefixoperation1",
      purpose: "completedPrefix",
      sourceTurnId: null,
    });
  }
  if (options.snapshot !== false) {
    database.query(`
      INSERT INTO harness_context_snapshots (
        snapshot_id, epoch_id, actor_id, completed_through_turn_id,
        coverage_witness_digest, value_id, created_at, expires_at
      ) VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7)
    `).run(
      materializedSnapshotId,
      epochId,
      actorId,
      options.witnessDigest ?? digest,
      materializedValueId,
      options.createdAt ?? at,
      options.expiresAt ?? deadline,
    );
  }
}

function admitRun(value: Fixture): void {
  insertValue(value.database, {
    valueId: programValueId,
    operationId: "admissionprogramoperation1",
    purpose: "programSource",
    sourceTurnId: turnId,
  });
  value.runs.prepareRun({
    id: runId,
    epochId,
    actorId,
    turnId,
    programValueId,
    programDigest: digest,
    completedPrefixSnapshotId: snapshotId,
    currentUserInputValueId: inputValueId,
    capabilities: ["context.read"],
    admittedFeatures: ["boundedPrograms"],
    semanticWitnessDigests: [digest],
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
    fuelLimit: 512,
    deadline,
    releaseIdentityDigest: digest,
    admissionDigest: otherDigest,
    createdAt: at,
  });
}

function insertValue(database: Database, input: Readonly<{
  valueId: string;
  operationId: string;
  purpose: "completedPrefix" | "currentInput" | "programSource";
  sourceTurnId: string | null;
}>): void {
  database.query(`
    INSERT INTO harness_context_values (
      value_id, operation_id, epoch_id, owner_actor_id, source_turn_id,
      kind, purpose, schema_version, name_digest, utf8_bytes,
      content_digest, chunk_size, chunk_count, manifest_digest,
      manifest_byte_length, quota_limit_bytes, state, recovery_reason,
      revision, created_at, updated_at, effect_started_at, activated_at
    ) VALUES (
      ?1, ?2, ?3, ?4, ?5,
      CASE WHEN ?6 = 'completedPrefix' THEN 'selection'
        WHEN ?6 = 'programSource' THEN 'json' ELSE 'text' END,
      ?6, 1, NULL, 2, ?7, 65536, 1, ?7, 64, 16777216,
      'active', NULL, 3, ?8, ?8, ?8, ?8
    )
  `).run(
    input.valueId,
    input.operationId,
    epochId,
    actorId,
    input.sourceTurnId,
    input.purpose,
    digest,
    at,
  );
  database.query(`
    INSERT INTO harness_context_value_chunks (
      value_id, ordinal, plaintext_bytes, object_digest, object_byte_length
    ) VALUES (?1, 0, 2, ?2, 64)
  `).run(input.valueId, digest);
}

describe("program admission intent v2", () => {
  test("exact duplicate phases are revision-stable under arbitrary retries", () => {
    assertProperty(fc.property(fc.record({
      prepareRetries: fc.integer({ min: 1, max: 8 }),
      materializeRetries: fc.integer({ min: 1, max: 8 }),
      admissionRetries: fc.integer({ min: 1, max: 8 }),
    }), ({ prepareRetries, materializeRetries, admissionRetries }) => {
      const value = fixture();
      try {
        let prepared = value.intents.prepare(intent());
        for (let index = 1; index < prepareRetries; index += 1) {
          prepared = value.intents.prepare(intent());
        }
        expect(prepared).toMatchObject({ state: "prepared", revision: 1 });

        materialize(value.database);
        let materialized = value.intents.markMaterialized({
          runId,
          expectedRevision: 1,
        });
        for (let index = 1; index < materializeRetries; index += 1) {
          materialized = value.intents.markMaterialized({
            runId,
            expectedRevision: 1,
          });
        }
        expect(materialized).toMatchObject({
          state: "materialized",
          revision: 2,
        });

        admitRun(value);
        let admitted = value.intents.markAdmitted({
          runId,
          expectedRevision: 2,
        });
        for (let index = 1; index < admissionRetries; index += 1) {
          admitted = value.intents.markAdmitted({
            runId,
            expectedRevision: 2,
          });
        }
        expect(admitted).toMatchObject({ state: "admitted", revision: 3 });
      } finally {
        value.database.close();
      }
    }), {
      numRuns: 50,
      interruptAfterTimeLimit: SQLITE_PROPERTY_INTERRUPT_AFTER_TIME_LIMIT,
    });
  }, SQLITE_PROPERTY_TIMEOUT);

  test("prepares before context publication and replays exact immutable identity", () => {
    const value = fixture();
    try {
      const prepared = value.intents.prepare(intent());
      expect(prepared.state).toBe("prepared");
      expect(value.intents.prepare(intent())).toEqual(prepared);
      expect(() => value.intents.prepare(intent({
        programDigest: otherDigest,
      }))).toThrow(ProgramAdmissionIntentV2Error);
      expect(value.database.query(`
        SELECT COUNT(*) AS count FROM harness_context_values
        WHERE value_id = ?1
      `).get(prefixValueId)).toEqual({ count: 0 });
    } finally {
      value.database.close();
    }
  });

  test("binds materialization and exact durable run in two CAS phases", () => {
    const value = fixture();
    try {
      const prepared = value.intents.prepare(intent());
      materialize(value.database);
      const materialized = value.intents.markMaterialized({
        runId,
        expectedRevision: prepared.revision,
      });
      expect(materialized.state).toBe("materialized");
      expect(value.intents.markMaterialized({
        runId,
        expectedRevision: prepared.revision,
      })).toEqual(materialized);
      expect(() => value.intents.markAdmitted({
        runId,
        expectedRevision: materialized.revision,
      })).toThrow("lacks its exact durable run");

      admitRun(value);
      const admitted = value.intents.markAdmitted({
        runId,
        expectedRevision: materialized.revision,
      });
      expect(admitted.state).toBe("admitted");
      expect(admitted.admittedAt).toBe(later);
      expect(value.intents.markAdmitted({
        runId,
        expectedRevision: materialized.revision,
      })).toEqual(admitted);
      expect(() => value.intents.abandonExpired({
        runId,
        expectedRevision: admitted.revision,
      })).toThrow("unadmitted");
    } finally {
      value.database.close();
    }
  });

  test("recovers crashes after publication and after run admission", () => {
    const value = fixture();
    try {
      value.intents.prepare(intent());
      materialize(value.database);
      expect(value.intents.reconcile(runId).state).toBe("materialized");
      admitRun(value);
      expect(value.intents.reconcile(runId).state).toBe("admitted");
      expect(new ProgramAdmissionIntentRecoveryV2({
        authority: value.intents,
      }).recover().inspectedRunIds).toEqual([]);
    } finally {
      value.database.close();
    }
  });

  test("tracks expired missing or complete publications without deleting bytes", () => {
    const missing = fixture();
    try {
      missing.setNow(at);
      missing.intents.prepare(intent({
        expiresAt: expiredAt,
        createdAt: beforeExpiry,
      }));
      const abandoned = missing.intents.reconcile(runId);
      expect(abandoned.state).toBe("abandoned");
      expect(abandoned.materializedAt).toBeNull();
    } finally {
      missing.database.close();
    }

    const complete = fixture();
    try {
      complete.setNow(at);
      const expiredIds = deriveHarnessDynamicToolContextMaterializationIds({
        epochId,
        actorId,
        completedThroughTurnId: null,
        expiresAt: expiredAt,
        coverageWitnessDigest: digest,
        prefixContentDigest: digest,
      });
      complete.intents.prepare(intent({
        expiresAt: expiredAt,
        createdAt: beforeExpiry,
        completedPrefixValueId: expiredIds.completedPrefixValueId,
        completedPrefixSnapshotId: expiredIds.completedPrefixSnapshotId,
      }));
      materialize(complete.database, {
        expiresAt: expiredAt,
        createdAt: beforeExpiry,
        valueId: expiredIds.completedPrefixValueId,
        snapshotId: expiredIds.completedPrefixSnapshotId,
      });
      const abandoned = complete.intents.reconcile(runId);
      expect(abandoned.state).toBe("abandoned");
      expect(abandoned.materializedAt).toBe(at);
      expect(complete.database.query(`
        SELECT COUNT(*) AS count FROM harness_context_values
        WHERE value_id = ?1
      `).get(expiredIds.completedPrefixValueId)).toEqual({ count: 1 });
      expect(complete.database.query(`
        SELECT COUNT(*) AS count FROM harness_context_snapshots
        WHERE snapshot_id = ?1
      `).get(expiredIds.completedPrefixSnapshotId)).toEqual({ count: 1 });
    } finally {
      complete.database.close();
    }
  });

  test("repairs an exact prefix-only crash and quarantines conflicting evidence", () => {
    const partial = fixture();
    try {
      partial.intents.prepare(intent());
      materialize(partial.database, { snapshot: false });
      expect(partial.intents.reconcile(runId)).toMatchObject({
        state: "materialized",
        recoveryReason: null,
      });
      expect(partial.database.query(`
        SELECT snapshot_id, value_id, expires_at
        FROM harness_context_snapshots WHERE snapshot_id = ?1
      `).get(snapshotId)).toEqual({
        snapshot_id: snapshotId,
        value_id: prefixValueId,
        expires_at: deadline,
      });
    } finally {
      partial.database.close();
    }

    const conflict = fixture();
    try {
      conflict.intents.prepare(intent());
      materialize(conflict.database, { witnessDigest: otherDigest });
      expect(conflict.intents.reconcile(runId)).toMatchObject({
        state: "recoveryRequired",
        recoveryReason: "materialization_conflict",
      });
    } finally {
      conflict.database.close();
    }

    const wrongExpiry = fixture();
    try {
      wrongExpiry.intents.prepare(intent());
      materialize(wrongExpiry.database, { expiresAt: otherDeadline });
      expect(wrongExpiry.intents.reconcile(runId)).toMatchObject({
        state: "recoveryRequired",
        recoveryReason: "materialization_conflict",
      });
    } finally {
      wrongExpiry.database.close();
    }

    const impossibleCreation = fixture();
    try {
      impossibleCreation.intents.prepare(intent());
      materialize(impossibleCreation.database, { createdAt: otherDeadline });
      expect(impossibleCreation.intents.reconcile(runId)).toMatchObject({
        state: "recoveryRequired",
        recoveryReason: "materialization_conflict",
      });
    } finally {
      impossibleCreation.database.close();
    }
  });

  test("does not repair an expired prefix-only crash", () => {
    const value = fixture();
    try {
      value.setNow(at);
      value.intents.prepare(intent({
        expiresAt: expiredAt,
        createdAt: beforeExpiry,
        completedPrefixValueId:
          deriveHarnessDynamicToolContextMaterializationIds({
            epochId,
            actorId,
            completedThroughTurnId: null,
            expiresAt: expiredAt,
            coverageWitnessDigest: digest,
            prefixContentDigest: digest,
          }).completedPrefixValueId,
        completedPrefixSnapshotId:
          deriveHarnessDynamicToolContextMaterializationIds({
            epochId,
            actorId,
            completedThroughTurnId: null,
            expiresAt: expiredAt,
            coverageWitnessDigest: digest,
            prefixContentDigest: digest,
          }).completedPrefixSnapshotId,
      }));
      const expiredIds = deriveHarnessDynamicToolContextMaterializationIds({
        epochId,
        actorId,
        completedThroughTurnId: null,
        expiresAt: expiredAt,
        coverageWitnessDigest: digest,
        prefixContentDigest: digest,
      });
      insertValue(value.database, {
        valueId: expiredIds.completedPrefixValueId,
        operationId: "expiredprefixoperation1",
        purpose: "completedPrefix",
        sourceTurnId: null,
      });
      expect(value.intents.reconcile(runId).state).toBe("abandoned");
      expect(value.database.query(`
        SELECT COUNT(*) AS count FROM harness_context_snapshots
        WHERE snapshot_id = ?1
      `).get(expiredIds.completedPrefixSnapshotId)).toEqual({ count: 0 });
    } finally {
      value.database.close();
    }
  });

  test("fences a same-lineage run before quarantining corrupt context", () => {
    const value = fixture();
    try {
      value.intents.prepare(intent());
      materialize(value.database, { witnessDigest: otherDigest });
      admitRun(value);
      expect(value.intents.reconcile(runId)).toMatchObject({
        state: "recoveryRequired",
        recoveryReason: "materialization_conflict",
      });
      expect(value.runs.readRun(runId)).toMatchObject({
        state: "recoveryRequired",
        terminalCode: "program_admission_recovery",
      });
    } finally {
      value.database.close();
    }
  });

  test("fences a same-lineage run whose deadline differs from the intent", () => {
    const value = fixture();
    try {
      value.intents.prepare(intent({ expiresAt: otherDeadline }));
      materialize(value.database, { expiresAt: otherDeadline });
      admitRun(value);
      expect(value.intents.reconcile(runId)).toMatchObject({
        state: "recoveryRequired",
        recoveryReason: "run_lineage_conflict",
      });
      expect(value.runs.readRun(runId)).toMatchObject({
        state: "recoveryRequired",
        terminalCode: "program_admission_recovery",
      });
    } finally {
      value.database.close();
    }
  });

  test("boot recovery is ordered, bounded, and does not abandon live intents", () => {
    const value = fixture();
    try {
      const prepared = value.intents.prepare(intent());
      const report = new ProgramAdmissionIntentRecoveryV2({
        authority: value.intents,
        pageLimit: 1,
      }).recover();
      expect(report.inspectedRunIds).toEqual([runId]);
      expect(report.preparedRunIds).toEqual([runId]);
      expect(value.intents.read(runId)).toEqual(prepared);
      expect(() => new ProgramAdmissionIntentRecoveryV2({
        authority: value.intents,
        maxRecords: 0,
      })).toThrow();
    } finally {
      value.database.close();
    }
  });

  test("rejects direct SQLite transition and immutable-identity drift", () => {
    const value = fixture();
    try {
      value.intents.prepare(intent());
      expect(() => value.database.query(`
        UPDATE harness_program_admission_intents
        SET revision = revision + 1
        WHERE run_id = ?1
      `).run(runId)).toThrow("transition is incoherent");
      expect(() => value.database.query(`
        UPDATE harness_program_admission_intents
        SET state = 'materialized', revision = revision + 1,
          updated_at = ?2, materialized_at = ?2
        WHERE run_id = ?1
      `).run(runId, later)).toThrow("materialized program admission intent");
      expect(() => value.database.query(`
        UPDATE harness_program_admission_intents
        SET program_digest = ?2, revision = revision + 1,
          updated_at = ?3, state = 'recoveryRequired',
          recovery_reason = 'materialization_conflict'
        WHERE run_id = ?1
      `).run(runId, otherDigest, later)).toThrow();

      const recovery = value.intents.markRecoveryRequired({
        runId,
        expectedRevision: 1,
        reason: "materialization_conflict",
      });
      expect(recovery.state).toBe("recoveryRequired");
      expect(value.intents.listRecoverable({ limit: 1 })).toEqual([]);
      expect(value.intents.listRecoveryRequired({ limit: 1 }))
        .toEqual([recovery]);
      expect(() => value.database.query(`
        UPDATE harness_program_admission_intents
        SET recovery_reason = 'run_lineage_conflict',
          revision = revision + 1, updated_at = ?2
        WHERE run_id = ?1
      `).run(runId, later)).toThrow("transition is incoherent");
    } finally {
      value.database.close();
    }
  });
});
