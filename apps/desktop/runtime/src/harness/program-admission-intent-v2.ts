import type { Database } from "bun:sqlite";

import { z } from "@hra-internal/schema";

import {
  actorEpochIdSchema,
  actorIdSchema,
  actorTurnIdSchema,
} from "./actor-domain";
import {
  contextSnapshotIdSchema,
  contextValueIdSchema,
  programRunIdSchema,
} from "./domain";
import {
  deriveHarnessDynamicToolContextMaterializationIds,
} from "./dynamic-tool-context-identity-v2";

const DEFAULT_PAGE_LIMIT = 128;
const DEFAULT_MAX_RECORDS = 100_000;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const revisionSchema = z.number().int().positive().safe();
const timestampSchema = z.string().length(24).datetime().refine(
  (value) => new Date(Date.parse(value)).toISOString() === value,
  "program admission timestamps must use canonical UTC milliseconds",
);

export const programAdmissionIntentStateV2Schema = z.enum([
  "prepared",
  "materialized",
  "admitted",
  "abandoned",
  "recoveryRequired",
]);
export const programAdmissionRecoveryReasonV2Schema = z.enum([
  "partial_materialization",
  "materialization_conflict",
  "run_lineage_conflict",
]);

export const programAdmissionIntentRecordV2Schema = z.object({
  runId: programRunIdSchema,
  epochId: actorEpochIdSchema,
  actorId: actorIdSchema,
  turnId: actorTurnIdSchema,
  completedPrefixValueId: contextValueIdSchema,
  completedPrefixContentDigest: digestSchema.nullable(),
  completedPrefixSnapshotId: contextSnapshotIdSchema,
  completedThroughTurnId: actorTurnIdSchema.nullable(),
  currentUserInputValueId: contextValueIdSchema,
  programDigest: digestSchema,
  stableAdmissionIdentityDigest: digestSchema,
  coverageWitnessDigest: digestSchema,
  expiresAt: timestampSchema,
  state: programAdmissionIntentStateV2Schema,
  recoveryReason: programAdmissionRecoveryReasonV2Schema.nullable(),
  revision: revisionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  materializedAt: timestampSchema.nullable(),
  admittedAt: timestampSchema.nullable(),
  abandonedAt: timestampSchema.nullable(),
}).strict().superRefine((intent, context) => {
  if (
    intent.state !== "recoveryRequired" &&
    intent.completedPrefixContentDigest === null
  ) {
    context.addIssue({
      code: "custom",
      message: "live program admission intents require content evidence",
      path: ["completedPrefixContentDigest"],
    });
  }
  if ((intent.state === "recoveryRequired") !==
      (intent.recoveryReason !== null)) {
    context.addIssue({
      code: "custom",
      message: "only recovery-required intents carry a recovery reason",
      path: ["recoveryReason"],
    });
  }
  if (
    (intent.state === "materialized" || intent.state === "admitted") &&
    intent.materializedAt === null
  ) {
    context.addIssue({
      code: "custom",
      message: "materialized intents require a materialization timestamp",
      path: ["materializedAt"],
    });
  }
  if ((intent.state === "admitted") !== (intent.admittedAt !== null)) {
    context.addIssue({
      code: "custom",
      message: "only admitted intents have an admission timestamp",
      path: ["admittedAt"],
    });
  }
  if ((intent.state === "abandoned") !== (intent.abandonedAt !== null)) {
    context.addIssue({
      code: "custom",
      message: "only abandoned intents have an abandonment timestamp",
      path: ["abandonedAt"],
    });
  }
  if (
    Date.parse(intent.updatedAt) < Date.parse(intent.createdAt) ||
    Date.parse(intent.expiresAt) <= Date.parse(intent.createdAt) ||
    intent.materializedAt !== null &&
      (Date.parse(intent.materializedAt) < Date.parse(intent.createdAt) ||
        Date.parse(intent.materializedAt) > Date.parse(intent.updatedAt)) ||
    intent.admittedAt !== null && intent.admittedAt !== intent.updatedAt ||
    intent.abandonedAt !== null && intent.abandonedAt !== intent.updatedAt
  ) {
    context.addIssue({
      code: "custom",
      message: "program admission intent timestamps are incoherent",
      path: ["updatedAt"],
    });
  }
});

export type ProgramAdmissionIntentRecordV2 = z.infer<
  typeof programAdmissionIntentRecordV2Schema
>;
export type ProgramAdmissionIntentStateV2 = ProgramAdmissionIntentRecordV2["state"];

interface ProgramRunAdmissionEvidenceV2 {
  readonly runId: string;
  readonly epochId: string;
  readonly actorId: string;
  readonly turnId: string;
  readonly programDigest: string;
  readonly completedPrefixSnapshotId: string;
  readonly currentUserInputValueId: string | null;
  readonly deadline: string;
  readonly state:
    | "prepared"
    | "running"
    | "suspended"
    | "completed"
    | "failed"
    | "stopped"
    | "recoveryRequired";
  readonly revision: number;
}

export interface ProgramAdmissionRunRecoveryPortV2 {
  markRecoveryRequired(input: Readonly<{
    runId: string;
    expectedRevision: number;
    expectedState: "prepared" | "running" | "suspended";
    now: string;
  }>): void;
}

const prepareInputSchema = z.object({
  runId: programRunIdSchema,
  epochId: actorEpochIdSchema,
  actorId: actorIdSchema,
  turnId: actorTurnIdSchema,
  completedPrefixValueId: contextValueIdSchema,
  completedPrefixContentDigest: digestSchema,
  completedPrefixSnapshotId: contextSnapshotIdSchema,
  completedThroughTurnId: actorTurnIdSchema.nullable(),
  currentUserInputValueId: contextValueIdSchema,
  programDigest: digestSchema,
  stableAdmissionIdentityDigest: digestSchema,
  coverageWitnessDigest: digestSchema,
  expiresAt: timestampSchema,
  createdAt: timestampSchema.optional(),
}).strict();

const rowSchema = z.object({
  run_id: programRunIdSchema,
  epoch_id: actorEpochIdSchema,
  actor_id: actorIdSchema,
  turn_id: actorTurnIdSchema,
  completed_prefix_value_id: contextValueIdSchema,
  completed_prefix_content_digest: digestSchema.nullable(),
  completed_prefix_snapshot_id: contextSnapshotIdSchema,
  completed_through_turn_id: actorTurnIdSchema.nullable(),
  current_user_input_value_id: contextValueIdSchema,
  program_digest: digestSchema,
  stable_admission_identity_digest: digestSchema,
  coverage_witness_digest: digestSchema,
  expires_at: timestampSchema,
  state: programAdmissionIntentStateV2Schema,
  recovery_reason: programAdmissionRecoveryReasonV2Schema.nullable(),
  revision: revisionSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
  materialized_at: timestampSchema.nullable(),
  admitted_at: timestampSchema.nullable(),
  abandoned_at: timestampSchema.nullable(),
}).strict();

const transitionInputSchema = z.object({
  runId: programRunIdSchema,
  expectedRevision: revisionSchema,
}).strict();
const recoveryTransitionInputSchema = transitionInputSchema.extend({
  reason: programAdmissionRecoveryReasonV2Schema,
}).strict();
const listInputSchema = z.object({
  afterRunId: programRunIdSchema.nullable().default(null),
  limit: z.number().int().min(1).max(128),
}).strict();

export type ProgramAdmissionIntentV2ErrorCode =
  | "bound_exceeded"
  | "conflict"
  | "corrupt_state"
  | "invalid_transition"
  | "not_found"
  | "revision_conflict";

export class ProgramAdmissionIntentV2Error extends Error {
  readonly code: ProgramAdmissionIntentV2ErrorCode;

  constructor(
    code: ProgramAdmissionIntentV2ErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProgramAdmissionIntentV2Error";
    this.code = code;
  }
}

/** Content-free two-phase authority spanning context publication and run admission. */
export class ProgramAdmissionIntentAuthorityV2 {
  readonly #database: Database;
  readonly #now: () => Date;
  readonly #runRecovery: ProgramAdmissionRunRecoveryPortV2;

  constructor(
    database: Database,
    options: Readonly<{
      now?: () => Date;
      runRecovery: ProgramAdmissionRunRecoveryPortV2;
    }>,
  ) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#runRecovery = options.runRecovery;
  }

  prepare(inputValue: z.input<typeof prepareInputSchema>): ProgramAdmissionIntentRecordV2 {
    const input = prepareInputSchema.parse(inputValue);
    const createdAt = this.#timestamp(input.createdAt);
    const proposed = programAdmissionIntentRecordV2Schema.parse({
      ...input,
      state: "prepared",
      recoveryReason: null,
      revision: 1,
      createdAt,
      updatedAt: createdAt,
      materializedAt: null,
      admittedAt: null,
      abandonedAt: null,
    });
    return this.#database.transaction(() => {
      const existing = this.#read(proposed.runId);
      if (existing !== null) {
        if (sameImmutableIntent(existing, proposed)) return existing;
        conflict("program admission intent identity already names other evidence");
      }
      try {
        this.#database.query(`
          INSERT INTO harness_program_admission_intents (
            run_id, epoch_id, actor_id, turn_id,
            completed_prefix_value_id, completed_prefix_content_digest,
            completed_prefix_snapshot_id, completed_through_turn_id,
            current_user_input_value_id, program_digest,
            stable_admission_identity_digest, coverage_witness_digest,
            expires_at, state, recovery_reason, revision, created_at,
            updated_at, materialized_at, admitted_at, abandoned_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
            'prepared', NULL, 1, ?14, ?14, NULL, NULL, NULL
          )
        `).run(
          proposed.runId,
          proposed.epochId,
          proposed.actorId,
          proposed.turnId,
          proposed.completedPrefixValueId,
          proposed.completedPrefixContentDigest,
          proposed.completedPrefixSnapshotId,
          proposed.completedThroughTurnId,
          proposed.currentUserInputValueId,
          proposed.programDigest,
          proposed.stableAdmissionIdentityDigest,
          proposed.coverageWitnessDigest,
          proposed.expiresAt,
          proposed.createdAt,
        );
      } catch (cause: unknown) {
        const winner = this.#read(proposed.runId);
        if (winner !== null && sameImmutableIntent(winner, proposed)) {
          return winner;
        }
        throw new ProgramAdmissionIntentV2Error(
          "conflict",
          "program admission intent conflicts with durable lineage",
          cause,
        );
      }
      return this.#require(proposed.runId);
    })();
  }

  read(runIdValue: string): ProgramAdmissionIntentRecordV2 | null {
    return this.#read(programRunIdSchema.parse(runIdValue));
  }

  markMaterialized(inputValue: Readonly<{
    runId: string;
    expectedRevision: number;
  }>): ProgramAdmissionIntentRecordV2 {
    const input = transitionInputSchema.parse(inputValue);
    return this.#database.transaction(() => {
      const current = this.#require(input.runId);
      if (current.state === "materialized" || current.state === "admitted") {
        return current;
      }
      if (current.state !== "prepared") {
        invalidTransition("only a prepared program intent may materialize");
      }
      if (this.#inspectMaterialization(current) !== "complete") {
        conflict("program admission intent lacks exact materialization evidence");
      }
      return this.#transition(current, input.expectedRevision, {
        state: "materialized",
        recoveryReason: null,
        materializedAt: this.#timestamp(),
        admittedAt: null,
        abandonedAt: null,
      });
    })();
  }

  markAdmitted(inputValue: Readonly<{
    runId: string;
    expectedRevision: number;
  }>): ProgramAdmissionIntentRecordV2 {
    const input = transitionInputSchema.parse(inputValue);
    return this.#database.transaction(() => {
      const current = this.#require(input.runId);
      if (current.state === "admitted") return current;
      if (current.state !== "prepared" && current.state !== "materialized") {
        invalidTransition("only a live program intent may become admitted");
      }
      if (this.#inspectMaterialization(current) !== "complete") {
        conflict("program admission intent lacks exact materialization evidence");
      }
      const run = this.#readRunEvidence(current.runId);
      if (run === null) {
        invalidTransition(
          "program admission intent lacks its exact durable run",
        );
      }
      if (!runMatchesIntent(run, current)) {
        conflict("program admission intent run lineage conflicts");
      }
      const timestamp = this.#timestamp();
      return this.#transition(current, input.expectedRevision, {
        state: "admitted",
        recoveryReason: null,
        materializedAt: current.materializedAt ?? timestamp,
        admittedAt: timestamp,
        abandonedAt: null,
      });
    })();
  }

  completeAdmission(runIdValue: string): ProgramAdmissionIntentRecordV2 {
    const runId = programRunIdSchema.parse(runIdValue);
    return this.#database.transaction(() => {
      const current = this.#require(runId);
      if (current.state === "admitted") return current;
      return this.markAdmitted({
        runId,
        expectedRevision: current.revision,
      });
    })();
  }

  markRecoveryRequired(inputValue: Readonly<{
    runId: string;
    expectedRevision: number;
    reason: z.infer<typeof programAdmissionRecoveryReasonV2Schema>;
  }>): ProgramAdmissionIntentRecordV2 {
    const input = recoveryTransitionInputSchema.parse(inputValue);
    return this.#database.transaction(() => {
      const current = this.#require(input.runId);
      if (current.state === "recoveryRequired") {
        if (current.recoveryReason === input.reason) return current;
        conflict("program admission recovery reason is already immutable");
      }
      if (current.state === "admitted" || current.state === "abandoned") {
        invalidTransition("terminal program intent cannot enter recovery");
      }
      return this.#transition(current, input.expectedRevision, {
        state: "recoveryRequired",
        recoveryReason: input.reason,
        materializedAt: current.materializedAt,
        admittedAt: null,
        abandonedAt: null,
      });
    })();
  }

  abandonExpired(inputValue: Readonly<{
    runId: string;
    expectedRevision: number;
  }>): ProgramAdmissionIntentRecordV2 {
    const input = transitionInputSchema.parse(inputValue);
    return this.#database.transaction(() => {
      const current = this.#require(input.runId);
      if (current.state === "abandoned") return current;
      if (current.state !== "prepared" && current.state !== "materialized") {
        invalidTransition("only an unadmitted program intent may be abandoned");
      }
      const timestamp = this.#timestamp();
      if (Date.parse(current.expiresAt) > Date.parse(timestamp)) {
        invalidTransition("live program admission intent cannot be abandoned");
      }
      if (this.#readRunEvidence(current.runId) !== null) {
        invalidTransition("a durable program run still references this intent");
      }
      return this.#transition(current, input.expectedRevision, {
        state: "abandoned",
        recoveryReason: null,
        materializedAt: current.materializedAt,
        admittedAt: null,
        abandonedAt: timestamp,
      });
    })();
  }

  listRecoverable(inputValue: Readonly<{
    afterRunId?: string | null;
    limit: number;
  }>): readonly ProgramAdmissionIntentRecordV2[] {
    const input = listInputSchema.parse(inputValue);
    const rows: unknown[] = this.#database.query(`
      SELECT * FROM harness_program_admission_intents
      WHERE state IN ('prepared', 'materialized')
        AND run_id > COALESCE(?1, '')
      ORDER BY run_id
      LIMIT ?2
    `).all(input.afterRunId, input.limit);
    return parseOrderedPage(rows, input.afterRunId);
  }

  listRecoveryRequired(inputValue: Readonly<{
    afterRunId?: string | null;
    limit: number;
  }>): readonly ProgramAdmissionIntentRecordV2[] {
    const input = listInputSchema.parse(inputValue);
    const rows: unknown[] = this.#database.query(`
      SELECT * FROM harness_program_admission_intents
      WHERE state = 'recoveryRequired'
        AND run_id > COALESCE(?1, '')
      ORDER BY run_id
      LIMIT ?2
    `).all(input.afterRunId, input.limit);
    return parseOrderedPage(rows, input.afterRunId);
  }

  reconcile(runIdValue: string): ProgramAdmissionIntentRecordV2 {
    const runId = programRunIdSchema.parse(runIdValue);
    return this.#database.transaction(() => {
      let current = this.#require(runId);
      if (
        current.state === "admitted" || current.state === "abandoned" ||
        current.state === "recoveryRequired"
      ) return current;
      const observedNow = this.#timestamp();

      let materialization = this.#inspectMaterialization(current);
      if (materialization === "conflict" ||
          (current.state === "materialized" && materialization !== "complete")) {
        return this.#quarantine(
          current,
          this.#readRunEvidence(runId),
          materialization === "missing"
            ? "partial_materialization"
            : "materialization_conflict",
        );
      }
      if (
        current.state === "prepared" && materialization === "valueOnly" &&
        Date.parse(current.expiresAt) > Date.parse(observedNow)
      ) {
        materialization = this.#repairSnapshot(current, observedNow)
          ? "complete"
          : "conflict";
        if (materialization === "conflict") {
          return this.#quarantine(
            current,
            this.#readRunEvidence(runId),
            "materialization_conflict",
          );
        }
      }
      const run = this.#readRunEvidence(runId);
      if (run !== null && materialization !== "complete") {
        return this.#quarantine(
          current,
          run,
          materialization === "missing"
            ? "partial_materialization"
            : "materialization_conflict",
        );
      }
      if (materialization === "complete" && current.state === "prepared") {
        current = this.markMaterialized({
          runId,
          expectedRevision: current.revision,
        });
      }
      if (run !== null) {
        if (!runMatchesIntent(run, current)) {
          return this.#quarantine(current, run, "run_lineage_conflict");
        }
        return this.markAdmitted({
          runId,
          expectedRevision: current.revision,
        });
      }
      if (Date.parse(current.expiresAt) <= Date.parse(observedNow)) {
        return this.abandonExpired({
          runId,
          expectedRevision: current.revision,
        });
      }
      return current;
    })();
  }

  #quarantine(
    current: ProgramAdmissionIntentRecordV2,
    run: ProgramRunAdmissionEvidenceV2 | null,
    reason: NonNullable<ProgramAdmissionIntentRecordV2["recoveryReason"]>,
  ): ProgramAdmissionIntentRecordV2 {
    if (
      run !== null && sameRunOwner(run, current) &&
      (run.state === "prepared" || run.state === "running" ||
        run.state === "suspended")
    ) {
      this.#runRecovery.markRecoveryRequired({
        runId: run.runId,
        expectedRevision: run.revision,
        expectedState: run.state,
        now: this.#timestamp(),
      });
    }
    return this.markRecoveryRequired({
      runId: current.runId,
      expectedRevision: current.revision,
      reason,
    });
  }

  #transition(
    current: ProgramAdmissionIntentRecordV2,
    expectedRevision: number,
    next: Readonly<{
      state: ProgramAdmissionIntentStateV2;
      recoveryReason: ProgramAdmissionIntentRecordV2["recoveryReason"];
      materializedAt: string | null;
      admittedAt: string | null;
      abandonedAt: string | null;
    }>,
  ): ProgramAdmissionIntentRecordV2 {
    if (current.revision !== expectedRevision) {
      revisionConflict("program admission intent revision changed");
    }
    const updatedAt = next.admittedAt ?? next.abandonedAt ?? this.#timestamp();
    const changes = (() => {
      try {
        return this.#database.query(`
          UPDATE harness_program_admission_intents
          SET state = ?1, recovery_reason = ?2, revision = revision + 1,
            updated_at = ?3, materialized_at = ?4, admitted_at = ?5,
            abandoned_at = ?6
          WHERE run_id = ?7 AND revision = ?8
        `).run(
          next.state,
          next.recoveryReason,
          updatedAt,
          next.materializedAt,
          next.admittedAt,
          next.abandonedAt,
          current.runId,
          expectedRevision,
        ).changes;
      } catch (cause: unknown) {
        throw new ProgramAdmissionIntentV2Error(
          "conflict",
          "program admission intent transition conflicts with durable evidence",
          cause,
        );
      }
    })();
    if (changes !== 1) {
      const winner = this.#read(current.runId);
      if (
        winner !== null && winner.revision === expectedRevision + 1 &&
        winner.state === next.state &&
        winner.recoveryReason === next.recoveryReason
      ) return winner;
      revisionConflict("program admission intent transition lost its CAS");
    }
    return this.#require(current.runId);
  }

  #inspectMaterialization(
    intent: ProgramAdmissionIntentRecordV2,
  ): "complete" | "conflict" | "missing" | "valueOnly" {
    if (intent.completedPrefixContentDigest === null) return "conflict";
    const expectedIds = deriveHarnessDynamicToolContextMaterializationIds({
      epochId: intent.epochId,
      actorId: intent.actorId,
      completedThroughTurnId: intent.completedThroughTurnId,
      expiresAt: intent.expiresAt,
      coverageWitnessDigest: intent.coverageWitnessDigest,
      prefixContentDigest: intent.completedPrefixContentDigest,
    });
    if (
      expectedIds.completedPrefixValueId !== intent.completedPrefixValueId ||
      expectedIds.completedPrefixSnapshotId !==
        intent.completedPrefixSnapshotId
    ) return "conflict";
    const evidence = z.object({
      value_count: z.number().int().nonnegative(),
      exact_value_count: z.number().int().nonnegative(),
      snapshot_count: z.number().int().nonnegative(),
      snapshot_created_at: z.string().nullable(),
      exact_count: z.number().int().nonnegative(),
    }).strict().parse(this.#database.query(`
      SELECT
        (SELECT COUNT(*) FROM harness_context_values
          WHERE value_id = ?1) AS value_count,
        (SELECT COUNT(*) FROM harness_context_values
          WHERE value_id = ?1
            AND epoch_id = ?3
            AND owner_actor_id = ?4
            AND source_turn_id IS ?6
            AND purpose = 'completedPrefix'
            AND kind = 'selection'
            AND state = 'active') AS exact_value_count,
        (SELECT COUNT(*) FROM harness_context_snapshots
          WHERE snapshot_id = ?2) AS snapshot_count,
        (SELECT created_at FROM harness_context_snapshots
          WHERE snapshot_id = ?2) AS snapshot_created_at,
        (SELECT COUNT(*)
          FROM harness_context_values AS value
          JOIN harness_context_snapshots AS snapshot
            ON snapshot.snapshot_id = ?2
          WHERE value.value_id = ?1
            AND value.epoch_id = ?3
            AND value.owner_actor_id = ?4
            AND value.purpose = 'completedPrefix'
            AND value.kind = 'selection'
            AND value.state = 'active'
            AND snapshot.value_id = value.value_id
            AND snapshot.epoch_id = ?3
            AND snapshot.actor_id = ?4
            AND snapshot.coverage_witness_digest = ?5
            AND value.source_turn_id IS ?6
            AND snapshot.completed_through_turn_id IS ?6
            AND snapshot.expires_at = ?7
        ) AS exact_count
    `).get(
      intent.completedPrefixValueId,
      intent.completedPrefixSnapshotId,
      intent.epochId,
      intent.actorId,
      intent.coverageWitnessDigest,
      intent.completedThroughTurnId,
      intent.expiresAt,
    ));
    if (evidence.value_count === 0 && evidence.snapshot_count === 0) {
      return "missing";
    }
    if (
      evidence.value_count === 1 && evidence.exact_value_count === 1 &&
      evidence.snapshot_count === 0
    ) return "valueOnly";
    const snapshotCreatedAt = timestampSchema.safeParse(
      evidence.snapshot_created_at,
    );
    return evidence.value_count === 1 && evidence.exact_value_count === 1 &&
        evidence.snapshot_count === 1 &&
        evidence.exact_count === 1 && snapshotCreatedAt.success &&
        Date.parse(snapshotCreatedAt.data) < Date.parse(intent.expiresAt)
      ? "complete"
      : "conflict";
  }

  #repairSnapshot(
    intent: ProgramAdmissionIntentRecordV2,
    createdAt: string,
  ): boolean {
    try {
      this.#database.query(`
        INSERT INTO harness_context_snapshots (
          snapshot_id, epoch_id, actor_id, completed_through_turn_id,
          coverage_witness_digest, value_id, created_at, expires_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      `).run(
        intent.completedPrefixSnapshotId,
        intent.epochId,
        intent.actorId,
        intent.completedThroughTurnId,
        intent.coverageWitnessDigest,
        intent.completedPrefixValueId,
        createdAt,
        intent.expiresAt,
      );
    } catch {
      // An exact concurrent winner is accepted only after full reinspection.
    }
    return this.#inspectMaterialization(intent) === "complete";
  }

  #readRunEvidence(runId: string): ProgramRunAdmissionEvidenceV2 | null {
    const value: unknown = this.#database.query(`
      SELECT run_id, epoch_id, actor_id, turn_id, program_digest,
        completed_prefix_snapshot_id, current_user_input_value_id,
        deadline, state, revision
      FROM harness_program_runs WHERE run_id = ?1
    `).get(runId);
    if (value === null) return null;
    const row = z.object({
      run_id: programRunIdSchema,
      epoch_id: actorEpochIdSchema,
      actor_id: actorIdSchema,
      turn_id: actorTurnIdSchema,
      program_digest: digestSchema,
      completed_prefix_snapshot_id: contextSnapshotIdSchema,
      current_user_input_value_id: contextValueIdSchema.nullable(),
      deadline: timestampSchema,
      state: z.enum([
        "prepared", "running", "suspended", "completed", "failed",
        "stopped", "recoveryRequired",
      ]),
      revision: revisionSchema,
    }).strict().parse(value);
    return Object.freeze({
      runId: row.run_id,
      epochId: row.epoch_id,
      actorId: row.actor_id,
      turnId: row.turn_id,
      programDigest: row.program_digest,
      completedPrefixSnapshotId: row.completed_prefix_snapshot_id,
      currentUserInputValueId: row.current_user_input_value_id,
      deadline: row.deadline,
      state: row.state,
      revision: row.revision,
    });
  }

  #read(runId: string): ProgramAdmissionIntentRecordV2 | null {
    const value: unknown = this.#database.query(
      "SELECT * FROM harness_program_admission_intents WHERE run_id = ?1",
    ).get(runId);
    return value === null ? null : parseRow(value);
  }

  #require(runId: string): ProgramAdmissionIntentRecordV2 {
    const value = this.#read(runId);
    if (value === null) {
      throw new ProgramAdmissionIntentV2Error(
        "not_found",
        "program admission intent does not exist",
      );
    }
    return value;
  }

  #timestamp(value?: string): string {
    try {
      return timestampSchema.parse(value ?? this.#now().toISOString());
    } catch (cause: unknown) {
      throw new ProgramAdmissionIntentV2Error(
        "corrupt_state",
        "program admission clock returned an invalid timestamp",
        cause,
      );
    }
  }
}

export interface ProgramAdmissionIntentRecoveryReportV2 {
  readonly inspectedRunIds: readonly string[];
  readonly preparedRunIds: readonly string[];
  readonly materializedRunIds: readonly string[];
  readonly admittedRunIds: readonly string[];
  readonly abandonedRunIds: readonly string[];
  readonly recoveryRequiredRunIds: readonly string[];
}

export class ProgramAdmissionIntentRecoveryV2 {
  readonly #authority: ProgramAdmissionIntentAuthorityV2;
  readonly #pageLimit: number;
  readonly #maxRecords: number;

  constructor(input: Readonly<{
    authority: ProgramAdmissionIntentAuthorityV2;
    pageLimit?: number;
    maxRecords?: number;
  }>) {
    this.#authority = input.authority;
    this.#pageLimit = z.number().int().min(1).max(128)
      .parse(input.pageLimit ?? DEFAULT_PAGE_LIMIT);
    this.#maxRecords = z.number().int().min(1).max(1_000_000)
      .parse(input.maxRecords ?? DEFAULT_MAX_RECORDS);
  }

  recover(): ProgramAdmissionIntentRecoveryReportV2 {
    const inspected: string[] = [];
    const outcomes: Record<ProgramAdmissionIntentStateV2, string[]> = {
      prepared: [],
      materialized: [],
      admitted: [],
      abandoned: [],
      recoveryRequired: [],
    };
    let afterRunId: string | null = null;
    while (true) {
      const page = this.#authority.listRecoverable({
        afterRunId,
        limit: this.#pageLimit,
      });
      if (inspected.length + page.length > this.#maxRecords) {
        throw new ProgramAdmissionIntentV2Error(
          "bound_exceeded",
          "program admission recovery exceeded its scan bound",
        );
      }
      for (const intent of page) {
        const reconciled = this.#authority.reconcile(intent.runId);
        inspected.push(intent.runId);
        outcomes[reconciled.state].push(intent.runId);
      }
      if (page.length < this.#pageLimit) break;
      afterRunId = page.at(-1)!.runId;
    }
    return Object.freeze({
      inspectedRunIds: Object.freeze(inspected),
      preparedRunIds: Object.freeze(outcomes.prepared),
      materializedRunIds: Object.freeze(outcomes.materialized),
      admittedRunIds: Object.freeze(outcomes.admitted),
      abandonedRunIds: Object.freeze(outcomes.abandoned),
      recoveryRequiredRunIds: Object.freeze(outcomes.recoveryRequired),
    });
  }
}

function parseRow(value: unknown): ProgramAdmissionIntentRecordV2 {
  try {
    const row = rowSchema.parse(value);
    return programAdmissionIntentRecordV2Schema.parse({
      runId: row.run_id,
      epochId: row.epoch_id,
      actorId: row.actor_id,
      turnId: row.turn_id,
      completedPrefixValueId: row.completed_prefix_value_id,
      completedPrefixContentDigest: row.completed_prefix_content_digest,
      completedPrefixSnapshotId: row.completed_prefix_snapshot_id,
      completedThroughTurnId: row.completed_through_turn_id,
      currentUserInputValueId: row.current_user_input_value_id,
      programDigest: row.program_digest,
      stableAdmissionIdentityDigest: row.stable_admission_identity_digest,
      coverageWitnessDigest: row.coverage_witness_digest,
      expiresAt: row.expires_at,
      state: row.state,
      recoveryReason: row.recovery_reason,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      materializedAt: row.materialized_at,
      admittedAt: row.admitted_at,
      abandonedAt: row.abandoned_at,
    });
  } catch (cause: unknown) {
    throw new ProgramAdmissionIntentV2Error(
      "corrupt_state",
      "stored program admission intent is invalid",
      cause,
    );
  }
}

function parseOrderedPage(
  rows: readonly unknown[],
  afterRunId: string | null,
): readonly ProgramAdmissionIntentRecordV2[] {
  const values = rows.map(parseRow);
  let previous = afterRunId;
  for (const value of values) {
    if (previous !== null && value.runId <= previous) {
      throw new ProgramAdmissionIntentV2Error(
        "corrupt_state",
        "program admission recovery page is duplicated or out of order",
      );
    }
    previous = value.runId;
  }
  return Object.freeze(values);
}

function runMatchesIntent(
  run: ProgramRunAdmissionEvidenceV2,
  intent: ProgramAdmissionIntentRecordV2,
): boolean {
  return run.runId === intent.runId && run.epochId === intent.epochId &&
    run.actorId === intent.actorId && run.turnId === intent.turnId &&
    run.programDigest === intent.programDigest &&
    run.completedPrefixSnapshotId === intent.completedPrefixSnapshotId &&
    run.currentUserInputValueId === intent.currentUserInputValueId &&
    run.deadline === intent.expiresAt;
}

function sameRunOwner(
  run: ProgramRunAdmissionEvidenceV2,
  intent: ProgramAdmissionIntentRecordV2,
): boolean {
  return run.runId === intent.runId && run.epochId === intent.epochId &&
    run.actorId === intent.actorId && run.turnId === intent.turnId;
}

function sameImmutableIntent(
  left: ProgramAdmissionIntentRecordV2,
  right: ProgramAdmissionIntentRecordV2,
): boolean {
  return left.runId === right.runId && left.epochId === right.epochId &&
    left.actorId === right.actorId && left.turnId === right.turnId &&
    left.completedPrefixValueId === right.completedPrefixValueId &&
    left.completedPrefixContentDigest === right.completedPrefixContentDigest &&
    left.completedPrefixSnapshotId === right.completedPrefixSnapshotId &&
    left.completedThroughTurnId === right.completedThroughTurnId &&
    left.currentUserInputValueId === right.currentUserInputValueId &&
    left.programDigest === right.programDigest &&
    left.stableAdmissionIdentityDigest === right.stableAdmissionIdentityDigest &&
    left.coverageWitnessDigest === right.coverageWitnessDigest &&
    left.expiresAt === right.expiresAt;
}

function conflict(message: string): never {
  throw new ProgramAdmissionIntentV2Error("conflict", message);
}

function invalidTransition(message: string): never {
  throw new ProgramAdmissionIntentV2Error("invalid_transition", message);
}

function revisionConflict(message: string): never {
  throw new ProgramAdmissionIntentV2Error("revision_conflict", message);
}
