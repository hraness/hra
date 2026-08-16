import type { Database } from "bun:sqlite";

import { z } from "@hra-internal/schema";

import {
  actorEpochIdSchema,
  actorIdSchema,
  actorTurnIdSchema,
} from "./actor-domain";
import {
  recursiveBudgetSchema,
  type RecursiveBudget,
} from "./domain";
import {
  RLM_V2_MAX_FUEL,
  capabilityForRlmV2Operation,
  deriveRlmV2ReceiptId,
  parseRlmV2Caller,
  rlmV2CapabilitySchema,
  rlmV2NodePathSchema,
  rlmV2OperationSchema,
  type RlmV2Capability,
  type RlmV2Caller,
  type RlmV2NodePath,
  type RlmV2Operation,
} from "./rlm-v2";
import { harnessFeatureSchema, type HarnessFeature } from "./semantic-gate";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const outcomeCodeSchema = z.string().min(1).max(96)
  .regex(/^[a-z0-9_]+$/u);
const timestampSchema = z.string().length(24).datetime().refine((value) => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value;
}, "RLM timestamps must use canonical UTC milliseconds");
const runIdSchema = z.string().min(15).max(96)
  .regex(/^rlmrun_[A-Za-z0-9_-]+$/u);
const receiptIdSchema = z.string().min(16).max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
const contextValueIdSchema = z.string().min(16).max(96)
  .regex(/^ctxval_[A-Za-z0-9_-]+$/u);
const snapshotIdSchema = z.string().min(16).max(96)
  .regex(/^ctxsnap_[A-Za-z0-9_-]+$/u);

export const rlmRunDesiredStateSchema = z.enum(["run", "suspend", "stop"]);
export const rlmRunStateSchema = z.enum([
  "prepared",
  "running",
  "suspended",
  "completed",
  "failed",
  "stopped",
  "recoveryRequired",
]);
export const rlmReceiptReplayClassSchema = z.enum([
  "pureRead",
  "cancelableWait",
  "idempotentLocalMutation",
  "reconciledExternalMutation",
]);
export const rlmReceiptStateSchema = z.enum([
  "prepared",
  "effectStarted",
  "succeeded",
  "failed",
  "replayRequired",
  "recoveryRequired",
]);
const failureEvidenceSchema = z.object({
  code: outcomeCodeSchema,
  retryable: z.boolean(),
}).strict();

export const rlmRunRecordSchema = z.object({
  id: runIdSchema,
  epochId: actorEpochIdSchema,
  actorId: actorIdSchema,
  turnId: actorTurnIdSchema,
  programValueId: contextValueIdSchema,
  programDigest: digestSchema,
  completedPrefixSnapshotId: snapshotIdSchema,
  currentUserInputValueId: contextValueIdSchema.nullable(),
  capabilities: z.array(rlmV2CapabilitySchema).max(10).refine(
    (values) => new Set(values).size === values.length,
    "RLM run capabilities must be unique",
  ).refine(
    (values) => values.every((value, index) =>
      index === 0 || values[index - 1]! < value
    ),
    "RLM run capabilities must use canonical lexical order",
  ),
  admittedFeatures: z.array(harnessFeatureSchema).min(1).max(6).refine(
    (values) => values.includes("boundedPrograms") &&
      new Set(values).size === values.length,
    "RLM run features must be unique and include boundedPrograms",
  ).refine(
    (values) => values.every((value, index) =>
      index === 0 || values[index - 1]! < value
    ),
    "RLM run features must use canonical lexical order",
  ),
  semanticWitnessDigests: z.array(digestSchema).max(32).refine(
    (values) => new Set(values).size === values.length,
    "RLM run semantic witnesses must be unique",
  ).refine(
    (values) => values.every((value, index) =>
      index === 0 || values[index - 1]! < value
    ),
    "RLM run semantic witnesses must use canonical lexical order",
  ),
  budget: recursiveBudgetSchema,
  fuelLimit: z.number().int().min(1).max(RLM_V2_MAX_FUEL),
  deadline: timestampSchema,
  releaseIdentityDigest: digestSchema,
  admissionDigest: digestSchema,
  desiredState: rlmRunDesiredStateSchema,
  lifecycleCheckpoint: z.boolean(),
  state: rlmRunStateSchema,
  terminalResultValueId: contextValueIdSchema.nullable(),
  terminalCode: outcomeCodeSchema.nullable(),
  revision: z.number().int().positive().safe(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  settledAt: timestampSchema.nullable(),
}).strict().superRefine((run, context) => {
  if (run.deadline !== run.budget.deadline) {
    context.addIssue({
      code: "custom",
      message: "RLM run deadline must equal its immutable recursive budget deadline",
      path: ["deadline"],
    });
  }
  const terminal = isTerminalRunState(run.state);
  if (terminal !== (run.settledAt !== null && run.terminalCode !== null)) {
    context.addIssue({
      code: "custom",
      message: "only a terminal RLM run has terminal evidence",
      path: ["settledAt"],
    });
  }
  if ((run.state === "completed") !== (run.terminalResultValueId !== null)) {
    context.addIssue({
      code: "custom",
      message: "only a completed RLM run has a result value",
      path: ["terminalResultValueId"],
    });
  }
  if (Date.parse(run.updatedAt) < Date.parse(run.createdAt)) {
    context.addIssue({
      code: "custom",
      message: "RLM run updates cannot predate admission",
      path: ["updatedAt"],
    });
  }
  if (run.settledAt !== null && run.settledAt !== run.updatedAt) {
    context.addIssue({
      code: "custom",
      message: "terminal RLM run settlement must be its final update",
      path: ["settledAt"],
    });
  }
  if (run.lifecycleCheckpoint &&
      (run.desiredState !== "run" || isTerminalRunState(run.state))) {
    context.addIssue({
      code: "custom",
      message: "only recoverable durable run intent may carry a lifecycle checkpoint",
      path: ["lifecycleCheckpoint"],
    });
  }
});

export type RlmRunRecord = z.infer<typeof rlmRunRecordSchema>;

export const rlmReceiptRecordSchema = z.object({
  id: receiptIdSchema,
  runId: runIdSchema,
  nodePath: rlmV2NodePathSchema,
  operation: rlmV2OperationSchema,
  requestDigest: digestSchema,
  effectKey: digestSchema,
  replayClass: rlmReceiptReplayClassSchema,
  state: rlmReceiptStateSchema,
  resultValueId: contextValueIdSchema.nullable(),
  error: failureEvidenceSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  settledAt: timestampSchema.nullable(),
}).strict().superRefine((receipt, context) => {
  if (receipt.replayClass !== replayClassForRlmOperation(receipt.operation)) {
    context.addIssue({
      code: "custom",
      message: "RLM receipt replay class does not match its operation",
      path: ["replayClass"],
    });
  }
  const terminal = receipt.state === "succeeded" ||
    receipt.state === "failed" || receipt.state === "recoveryRequired";
  if (terminal !== (receipt.settledAt !== null)) {
    context.addIssue({
      code: "custom",
      message: "only terminal RLM receipts have a settlement timestamp",
      path: ["settledAt"],
    });
  }
  if ((receipt.state === "succeeded") !== (receipt.resultValueId !== null)) {
    context.addIssue({
      code: "custom",
      message: "only a successful RLM receipt has a result value",
      path: ["resultValueId"],
    });
  }
  if ((receipt.state === "failed" || receipt.state === "recoveryRequired") !==
      (receipt.error !== null)) {
    context.addIssue({
      code: "custom",
      message: "failed and recovery-required receipts need content-free error evidence",
      path: ["error"],
    });
  }
  if (Date.parse(receipt.updatedAt) < Date.parse(receipt.createdAt)) {
    context.addIssue({
      code: "custom",
      message: "RLM receipt updates cannot predate preparation",
      path: ["updatedAt"],
    });
  }
  if (receipt.settledAt !== null && receipt.settledAt !== receipt.updatedAt) {
    context.addIssue({
      code: "custom",
      message: "terminal RLM receipt settlement must be its final update",
      path: ["settledAt"],
    });
  }
});

export type RlmReceiptRecord = z.infer<typeof rlmReceiptRecordSchema>;

export class RlmRunAuthorityV2Error extends Error {
  readonly code:
    | "conflict"
    | "corrupt_state"
    | "invalid_transition"
    | "not_found"
    | "revision_conflict";

  constructor(
    code: RlmRunAuthorityV2Error["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RlmRunAuthorityV2Error";
    this.code = code;
  }
}

export class RlmRunAuthorityV2 {
  readonly #database: Database;
  readonly #now: () => Date;

  constructor(
    database: Database,
    options: Readonly<{ now?: () => Date }> = {},
  ) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
  }

  prepareRun(inputValue: Readonly<{
    id: string;
    epochId: string;
    actorId: string;
    turnId: string;
    programValueId: string;
    programDigest: string;
    completedPrefixSnapshotId: string;
    currentUserInputValueId: string | null;
    capabilities: readonly RlmV2Capability[];
    admittedFeatures: readonly HarnessFeature[];
    semanticWitnessDigests: readonly string[];
    budget: RecursiveBudget;
    fuelLimit: number;
    deadline: string;
    releaseIdentityDigest: string;
    admissionDigest: string;
    createdAt?: string;
  }>): RlmRunRecord {
    const createdAt = this.#timestamp(inputValue.createdAt);
    const caller = canonicalCaller({
      epochId: inputValue.epochId,
      actorId: inputValue.actorId,
      turnId: inputValue.turnId,
      capabilities: inputValue.capabilities,
      admittedFeatures: inputValue.admittedFeatures,
      semanticWitnessDigests: inputValue.semanticWitnessDigests,
      budget: inputValue.budget,
    });
    const proposed = rlmRunRecordSchema.parse({
      ...inputValue,
      capabilities: caller.capabilities,
      admittedFeatures: caller.admittedFeatures,
      semanticWitnessDigests: caller.semanticWitnessDigests,
      budget: caller.budget,
      desiredState: "run",
      lifecycleCheckpoint: false,
      state: "prepared",
      terminalResultValueId: null,
      terminalCode: null,
      revision: 1,
      createdAt,
      updatedAt: createdAt,
      settledAt: null,
    });
    return this.#database.transaction(() => {
      const existing = this.#readRun(proposed.id);
      if (existing !== null) {
        if (sameRunAdmission(existing, proposed)) return existing;
        conflict("RLM run identity already names another admission");
      }
      if (Date.parse(proposed.deadline) <= Date.parse(proposed.createdAt)) {
        invalidTransition("RLM run deadline must follow admission");
      }
      this.#assertRunLineage(proposed, "admission");
      const turnState: unknown = this.#database.query(
        "SELECT state, started_at FROM harness_actor_turns WHERE turn_id = ?1",
      ).get(proposed.turnId);
      const runningTurn = z.object({
        state: z.literal("running"),
        started_at: timestampSchema,
      }).strict().safeParse(turnState);
      if (
        !runningTurn.success ||
        Date.parse(proposed.createdAt) < Date.parse(runningTurn.data.started_at)
      ) {
        invalidTransition("only a running actor turn can admit an RLM run");
      }
      this.#database.query(`
        INSERT INTO harness_program_runs (
          run_id, epoch_id, actor_id, turn_id, program_value_id,
          program_digest, completed_prefix_snapshot_id,
          current_user_input_value_id, capabilities_json,
          admitted_features_json, semantic_witness_digests_json,
          recursive_budget_json, fuel_limit, deadline,
          release_identity_digest, admission_digest,
          desired_state, lifecycle_checkpoint, state,
          terminal_result_value_id, terminal_code,
          revision, created_at, updated_at, settled_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
          ?13, ?14, ?15, ?16, 'run', 0, 'prepared', NULL, NULL, 1,
          ?17, ?17, NULL
        )
      `).run(
        proposed.id,
        proposed.epochId,
        proposed.actorId,
        proposed.turnId,
        proposed.programValueId,
        proposed.programDigest,
        proposed.completedPrefixSnapshotId,
        proposed.currentUserInputValueId,
        canonicalJson(proposed.capabilities),
        canonicalJson(proposed.admittedFeatures),
        canonicalJson(proposed.semanticWitnessDigests),
        canonicalJson(proposed.budget),
        proposed.fuelLimit,
        proposed.deadline,
        proposed.releaseIdentityDigest,
        proposed.admissionDigest,
        proposed.createdAt,
      );
      return this.#requireRun(proposed.id);
    })();
  }

  transitionRun(inputValue: Readonly<{
    runId: string;
    expectedRevision: number;
    expectedState: RlmRunRecord["state"];
    nextState: RlmRunRecord["state"];
    terminalResultValueId?: string | null;
    terminalCode?: string | null;
    now?: string;
  }>): RlmRunRecord {
    const runId = runIdSchema.parse(inputValue.runId);
    const expectedRevision = z.number().int().positive().safe()
      .parse(inputValue.expectedRevision);
    const expectedState = rlmRunStateSchema.parse(inputValue.expectedState);
    const nextState = rlmRunStateSchema.parse(inputValue.nextState);
    const terminalResultValueId = contextValueIdSchema.nullable()
      .parse(inputValue.terminalResultValueId ?? null);
    const terminalCode = outcomeCodeSchema.nullable()
      .parse(inputValue.terminalCode ?? null);
    const now = this.#timestamp(inputValue.now);
    const terminal = isTerminalRunState(nextState);
    if (terminal !== (terminalCode !== null)) {
      invalidTransition("terminal RLM transitions require one outcome code");
    }
    if ((nextState === "completed") !== (terminalResultValueId !== null)) {
      invalidTransition("only completed RLM runs may reference a result value");
    }
    assertRunTransition(expectedState, nextState);
    return this.#database.transaction(() => {
      const current = this.#requireRun(runId);
      if (Date.parse(now) < Date.parse(current.updatedAt)) {
        invalidTransition("RLM run updates must be temporally monotonic");
      }
      if (
        current.revision === expectedRevision + 1 &&
        current.state === nextState &&
        current.terminalResultValueId === terminalResultValueId &&
        current.terminalCode === terminalCode
      ) return current;
      if (current.revision !== expectedRevision) revisionConflict();
      if (current.state !== expectedState) {
        invalidTransition("RLM run CAS state changed");
      }
      assertRunTransitionIntent(current, nextState);
      if (
        current.desiredState === "stop" &&
        (nextState === "suspended" || nextState === "running")
      ) {
        this.#assertExternalDrainEvidence(
          current,
          nextState === "running" ? ["replayRequired"] : [
            "effectStarted",
            "replayRequired",
          ],
        );
      }
      if (
        nextState === "suspended" && current.desiredState === "run" &&
        !current.lifecycleCheckpoint
      ) {
        this.#assertExternalReplaySuspension(current);
      }
      if (isTerminalRunState(nextState) && nextState !== "recoveryRequired") {
        this.#assertNoUnsettledExternalReceipts(current);
      }
      if (
        nextState === "running" && current.desiredState !== "stop" &&
        Date.parse(now) >= Date.parse(current.deadline)
      ) {
        invalidTransition("expired RLM runs cannot start or resume");
      }
      if (terminalResultValueId !== null) {
        this.#assertActiveValue(
          terminalResultValueId,
          current,
          "programResult",
          current.turnId,
        );
      }
      const changed = this.#database.query(`
        UPDATE harness_program_runs SET
          state = ?4, terminal_result_value_id = ?5, terminal_code = ?6,
          lifecycle_checkpoint = CASE WHEN ?9 = 1 THEN 0
            ELSE lifecycle_checkpoint END,
          revision = revision + 1, updated_at = ?7, settled_at = ?8
        WHERE run_id = ?1 AND revision = ?2 AND state = ?3
      `).run(
        runId,
        expectedRevision,
        expectedState,
        nextState,
        terminalResultValueId,
        terminalCode,
        now,
        terminal ? now : null,
        terminal ? 1 : 0,
      );
      if (changed.changes !== 1) revisionConflict();
      return this.#requireRun(runId);
    })();
  }

  requestDesiredState(inputValue: Readonly<{
    runId: string;
    expectedRevision: number;
    expectedDesiredState: RlmRunRecord["desiredState"];
    desiredState: RlmRunRecord["desiredState"];
    now?: string;
  }>): RlmRunRecord {
    const runId = runIdSchema.parse(inputValue.runId);
    const expectedRevision = z.number().int().positive().safe()
      .parse(inputValue.expectedRevision);
    const expectedDesiredState = rlmRunDesiredStateSchema
      .parse(inputValue.expectedDesiredState);
    const desiredState = rlmRunDesiredStateSchema.parse(inputValue.desiredState);
    const now = this.#timestamp(inputValue.now);
    assertDesiredStateTransition(expectedDesiredState, desiredState);
    return this.#database.transaction(() => {
      const current = this.#requireRun(runId);
      if (Date.parse(now) < Date.parse(current.updatedAt)) {
        invalidTransition("RLM run updates must be temporally monotonic");
      }
      if (
        current.revision === expectedRevision + 1 &&
        current.desiredState === desiredState &&
        !current.lifecycleCheckpoint
      ) return current;
      if (current.revision !== expectedRevision) revisionConflict();
      if (current.desiredState !== expectedDesiredState) {
        invalidTransition("RLM desired-state CAS changed");
      }
      if (isTerminalRunState(current.state)) {
        invalidTransition("terminal RLM runs reject desired-state changes");
      }
      if (
        desiredState === "run" && Date.parse(now) >= Date.parse(current.deadline)
      ) invalidTransition("expired RLM runs cannot resume");
      const changed = this.#database.query(`
        UPDATE harness_program_runs SET
          desired_state = ?4, lifecycle_checkpoint = 0,
          revision = revision + 1, updated_at = ?5
        WHERE run_id = ?1 AND revision = ?2 AND desired_state = ?3
      `).run(
        runId,
        expectedRevision,
        expectedDesiredState,
        desiredState,
        now,
      );
      if (changed.changes !== 1) revisionConflict();
      return this.#requireRun(runId);
    })();
  }

  requestLifecycleCheckpoint(inputValue: Readonly<{
    runId: string;
    expectedRevision: number;
    now?: string;
  }>): RlmRunRecord {
    const runId = runIdSchema.parse(inputValue.runId);
    const expectedRevision = z.number().int().positive().safe()
      .parse(inputValue.expectedRevision);
    const now = this.#timestamp(inputValue.now);
    return this.#database.transaction(() => {
      const current = this.#requireRun(runId);
      if (Date.parse(now) < Date.parse(current.updatedAt)) {
        invalidTransition("RLM run updates must be temporally monotonic");
      }
      if (
        current.revision === expectedRevision + 1 &&
        current.lifecycleCheckpoint
      ) return current;
      if (current.revision !== expectedRevision) revisionConflict();
      if (current.lifecycleCheckpoint) return current;
      if (isTerminalRunState(current.state)) {
        invalidTransition("terminal RLM runs reject lifecycle checkpoints");
      }
      if (current.desiredState !== "run") {
        invalidTransition("lifecycle checkpoints require durable run intent");
      }
      const changed = this.#database.query(`
        UPDATE harness_program_runs SET lifecycle_checkpoint = 1,
          revision = revision + 1, updated_at = ?3
        WHERE run_id = ?1 AND revision = ?2
          AND desired_state = 'run' AND lifecycle_checkpoint = 0
      `).run(runId, expectedRevision, now);
      if (changed.changes !== 1) revisionConflict();
      return this.#requireRun(runId);
    })();
  }

  releaseLifecycleCheckpoint(inputValue: Readonly<{
    runId: string;
    expectedRevision: number;
    now?: string;
  }>): RlmRunRecord {
    const runId = runIdSchema.parse(inputValue.runId);
    const expectedRevision = z.number().int().positive().safe()
      .parse(inputValue.expectedRevision);
    const now = this.#timestamp(inputValue.now);
    return this.#database.transaction(() => {
      const current = this.#requireRun(runId);
      if (Date.parse(now) < Date.parse(current.updatedAt)) {
        invalidTransition("RLM run updates must be temporally monotonic");
      }
      if (
        current.revision === expectedRevision + 1 &&
        !current.lifecycleCheckpoint
      ) return current;
      if (current.revision !== expectedRevision) revisionConflict();
      if (!current.lifecycleCheckpoint) {
        invalidTransition("RLM run has no lifecycle checkpoint to release");
      }
      const changed = this.#database.query(`
        UPDATE harness_program_runs SET lifecycle_checkpoint = 0,
          revision = revision + 1, updated_at = ?3
        WHERE run_id = ?1 AND revision = ?2 AND lifecycle_checkpoint = 1
      `).run(runId, expectedRevision, now);
      if (changed.changes !== 1) revisionConflict();
      return this.#requireRun(runId);
    })();
  }

  readRun(runIdValue: string): RlmRunRecord | null {
    return this.#readRun(runIdSchema.parse(runIdValue));
  }

  listRecoverableRuns(inputValue: Readonly<{
    afterRunId?: string | null;
    limit: number;
  }>): readonly RlmRunRecord[] {
    const after = runIdSchema.nullable().parse(inputValue.afterRunId ?? null);
    const limit = z.number().int().min(1).max(128).parse(inputValue.limit);
    const rows: unknown[] = this.#database.query(`
      SELECT * FROM harness_program_runs
      WHERE run_id > COALESCE(?1, '')
        AND state IN ('prepared', 'running', 'suspended', 'recoveryRequired')
      ORDER BY run_id LIMIT ?2
    `).all(after, limit);
    return rows.map((row) => this.#parseRunRow(row));
  }

  prepareReceipt(inputValue: Readonly<{
    id: string;
    runId: string;
    nodePath: RlmV2NodePath;
    operation: RlmV2Operation;
    requestDigest: string;
    effectKey: string;
    createdAt?: string;
  }>): RlmReceiptRecord {
    const createdAt = this.#timestamp(inputValue.createdAt);
    const proposed = rlmReceiptRecordSchema.parse({
      ...inputValue,
      replayClass: replayClassForRlmOperation(inputValue.operation),
      state: "prepared",
      resultValueId: null,
      error: null,
      createdAt,
      updatedAt: createdAt,
      settledAt: null,
    });
    return this.#database.transaction(() => {
      const run = this.#requireRun(proposed.runId);
      if (
        proposed.id !== deriveRlmV2ReceiptId(
          proposed.runId,
          run.programDigest,
          proposed.nodePath,
        )
      ) conflict("RLM receipt identity does not match its structural coordinate");
      const existing = this.#readReceipt(proposed.id);
      const byPath = this.#readReceiptByPath(proposed.runId, proposed.nodePath);
      if (existing !== null || byPath !== null) {
        if (
          existing !== null && byPath !== null && existing.id === byPath.id &&
          sameReceiptAdmission(existing, proposed)
        ) return existing;
        conflict("RLM operation coordinate already names another request");
      }
      if (run.state !== "running" || run.desiredState !== "run") {
        invalidTransition("only an actively running RLM run can prepare operations");
      }
      if (
        Date.parse(proposed.createdAt) < Date.parse(run.updatedAt) ||
        Date.parse(proposed.createdAt) >= Date.parse(run.deadline)
      ) invalidTransition("RLM operation preparation is outside its run window");
      const requiredCapability = capabilityForRlmV2Operation(proposed.operation);
      if (!run.capabilities.includes(requiredCapability)) {
        conflict("RLM operation exceeds the run's admitted capabilities");
      }
      this.#database.query(`
        INSERT INTO harness_program_operation_receipts (
          receipt_id, run_id, canonical_node_path, operation,
          request_digest, effect_key, replay_class, state,
          result_value_id, error_json, created_at, updated_at, settled_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'prepared',
          NULL, NULL, ?8, ?8, NULL
        )
      `).run(
        proposed.id,
        proposed.runId,
        canonicalNodePath(proposed.nodePath),
        proposed.operation,
        proposed.requestDigest,
        proposed.effectKey,
        proposed.replayClass,
        proposed.createdAt,
      );
      return this.#requireReceipt(proposed.id);
    })();
  }

  transitionReceipt(inputValue: Readonly<{
    receiptId: string;
    expectedState: RlmReceiptRecord["state"];
    nextState: RlmReceiptRecord["state"];
    resultValueId?: string | null;
    error?: z.input<typeof failureEvidenceSchema> | null;
    now?: string;
  }>): RlmReceiptRecord {
    const receiptId = receiptIdSchema.parse(inputValue.receiptId);
    const expectedState = rlmReceiptStateSchema.parse(inputValue.expectedState);
    const nextState = rlmReceiptStateSchema.parse(inputValue.nextState);
    const resultValueId = contextValueIdSchema.nullable()
      .parse(inputValue.resultValueId ?? null);
    const error = failureEvidenceSchema.nullable().parse(inputValue.error ?? null);
    const now = this.#timestamp(inputValue.now);
    const terminal = nextState === "succeeded" || nextState === "failed" ||
      nextState === "recoveryRequired";
    if ((nextState === "succeeded") !== (resultValueId !== null)) {
      invalidTransition("only successful RLM receipts may reference a result value");
    }
    if ((nextState === "failed" || nextState === "recoveryRequired") !==
        (error !== null)) {
      invalidTransition("failed receipts require content-free error evidence");
    }
    assertReceiptTransition(expectedState, nextState);
    return this.#database.transaction(() => {
      const current = this.#requireReceipt(receiptId);
      if (Date.parse(now) < Date.parse(current.updatedAt)) {
        invalidTransition("RLM receipt updates must be temporally monotonic");
      }
      if (
        current.state === nextState &&
        current.resultValueId === resultValueId &&
        canonicalJson(current.error) === canonicalJson(error)
      ) return current;
      if (current.state !== expectedState) {
        invalidTransition("RLM receipt CAS state changed");
      }
      const run = this.#requireRun(current.runId);
      const ordinaryEffect = run.state === "running" &&
        run.desiredState === "run" && !run.lifecycleCheckpoint;
      const drainReplay = run.state === "running" &&
        run.desiredState === "stop" &&
        current.state === "replayRequired" &&
        current.replayClass === "reconciledExternalMutation";
      if (nextState === "effectStarted" && !ordinaryEffect && !drainReplay) {
        invalidTransition("RLM effects require an actively running parent run");
      }
      if (
        nextState === "effectStarted" &&
        !drainReplay &&
        Date.parse(now) >= Date.parse(run.deadline)
      ) invalidTransition("expired RLM runs cannot start effects");
      if (resultValueId !== null) {
        this.#assertActiveValue(resultValueId, run, "programResult", run.turnId);
      }
      const changed = this.#database.query(`
        UPDATE harness_program_operation_receipts SET
          state = ?3, result_value_id = ?4, error_json = ?5,
          updated_at = ?6, settled_at = ?7
        WHERE receipt_id = ?1 AND state = ?2
      `).run(
        receiptId,
        expectedState,
        nextState,
        resultValueId,
        error === null ? null : canonicalJson(error),
        now,
        terminal ? now : null,
      );
      if (changed.changes !== 1) {
        invalidTransition("RLM receipt CAS state changed");
      }
      return this.#requireReceipt(receiptId);
    })();
  }

  readReceipt(receiptIdValue: string): RlmReceiptRecord | null {
    return this.#readReceipt(receiptIdSchema.parse(receiptIdValue));
  }

  listRecoverableReceipts(inputValue: Readonly<{
    afterReceiptId?: string | null;
    limit: number;
  }>): readonly RlmReceiptRecord[] {
    const after = receiptIdSchema.nullable()
      .parse(inputValue.afterReceiptId ?? null);
    const limit = z.number().int().min(1).max(128).parse(inputValue.limit);
    const rows: unknown[] = this.#database.query(`
      SELECT * FROM harness_program_operation_receipts
      WHERE receipt_id > COALESCE(?1, '')
        AND state IN ('prepared', 'effectStarted', 'replayRequired', 'recoveryRequired')
      ORDER BY receipt_id LIMIT ?2
    `).all(after, limit);
    return rows.map((row) => this.#parseReceiptRow(row));
  }

  #timestamp(value: string | undefined): string {
    return timestampSchema.parse(value ?? this.#now().toISOString());
  }

  #readRun(id: string): RlmRunRecord | null {
    const row: unknown = this.#database.query(
      "SELECT * FROM harness_program_runs WHERE run_id = ?1",
    ).get(id);
    return row === null ? null : this.#parseRunRow(row);
  }

  #requireRun(id: string): RlmRunRecord {
    const run = this.#readRun(id);
    if (run === null) notFound("RLM run does not exist");
    return run;
  }

  #readReceipt(id: string): RlmReceiptRecord | null {
    const row: unknown = this.#database.query(
      "SELECT * FROM harness_program_operation_receipts WHERE receipt_id = ?1",
    ).get(id);
    return row === null ? null : this.#parseReceiptRow(row);
  }

  #readReceiptByPath(
    runId: string,
    nodePath: RlmV2NodePath,
  ): RlmReceiptRecord | null {
    const row: unknown = this.#database.query(`
      SELECT * FROM harness_program_operation_receipts
      WHERE run_id = ?1 AND canonical_node_path = ?2
    `).get(runId, canonicalNodePath(nodePath));
    return row === null ? null : this.#parseReceiptRow(row);
  }

  #requireReceipt(id: string): RlmReceiptRecord {
    const receipt = this.#readReceipt(id);
    if (receipt === null) notFound("RLM receipt does not exist");
    return receipt;
  }

  #parseRunRow(row: unknown): RlmRunRecord {
    const run = parseRunRow(row);
    if (Date.parse(run.deadline) <= Date.parse(run.createdAt)) {
      corruptState("stored RLM run deadline does not follow admission");
    }
    this.#assertRunLineage(run, "stored");
    if (run.terminalResultValueId !== null) {
      try {
        this.#assertActiveValue(
          run.terminalResultValueId,
          run,
          "programResult",
          run.turnId,
        );
      } catch (cause: unknown) {
        throw new RlmRunAuthorityV2Error(
          "corrupt_state",
          "stored RLM run result has incoherent lineage",
          cause,
        );
      }
    }
    return run;
  }

  #parseReceiptRow(row: unknown): RlmReceiptRecord {
    const receipt = parseReceiptRow(row);
    const run = this.#requireRun(receipt.runId);
    if (
      receipt.id !== deriveRlmV2ReceiptId(
        receipt.runId,
        run.programDigest,
        receipt.nodePath,
      ) ||
      !run.capabilities.includes(capabilityForRlmV2Operation(receipt.operation))
    ) corruptState("stored RLM receipt has incoherent authority");
    if (receipt.resultValueId !== null) {
      try {
        this.#assertActiveValue(
          receipt.resultValueId,
          run,
          "programResult",
          run.turnId,
        );
      } catch (cause: unknown) {
        throw new RlmRunAuthorityV2Error(
          "corrupt_state",
          "stored RLM receipt result has incoherent lineage",
          cause,
        );
      }
    }
    return receipt;
  }

  #assertRunLineage(
    run: Pick<
      RlmRunRecord,
      | "epochId"
      | "actorId"
      | "turnId"
      | "programValueId"
      | "programDigest"
      | "completedPrefixSnapshotId"
      | "currentUserInputValueId"
      | "deadline"
    >,
    boundary: "admission" | "stored",
  ): void {
    const row: unknown = this.#database.query(`
      SELECT 1 AS coherent, epoch.deadline AS epoch_deadline,
        actor.deadline AS actor_deadline
      FROM harness_actor_epochs AS epoch
      JOIN harness_actors AS actor
        ON actor.actor_id = ?2 AND actor.epoch_id = epoch.epoch_id
      JOIN harness_actor_turns AS turn
        ON turn.turn_id = ?3
        AND turn.epoch_id = epoch.epoch_id
        AND turn.actor_id = actor.actor_id
      JOIN harness_context_values AS program
        ON program.value_id = ?4
        AND program.epoch_id = epoch.epoch_id
        AND program.owner_actor_id = actor.actor_id
        AND program.purpose = 'programSource'
        AND program.state = 'active'
        AND program.content_digest = ?5
      JOIN harness_context_snapshots AS snapshot
        ON snapshot.snapshot_id = ?6
        AND snapshot.epoch_id = epoch.epoch_id
        AND snapshot.actor_id = actor.actor_id
      JOIN harness_context_values AS prefix
        ON prefix.value_id = snapshot.value_id
        AND prefix.epoch_id = epoch.epoch_id
        AND prefix.owner_actor_id = actor.actor_id
        AND prefix.purpose = 'completedPrefix'
        AND prefix.state = 'active'
      WHERE epoch.epoch_id = ?1
        AND (
          ?7 IS NULL OR (
            turn.input_value_id = ?7 AND EXISTS (
              SELECT 1 FROM harness_context_values AS input
              WHERE input.value_id = ?7
                AND input.epoch_id = epoch.epoch_id
                AND input.owner_actor_id = actor.actor_id
                AND input.purpose = 'currentInput'
                AND input.state = 'active'
            )
          )
        )
    `).get(
      run.epochId,
      run.actorId,
      run.turnId,
      run.programValueId,
      run.programDigest,
      run.completedPrefixSnapshotId,
      run.currentUserInputValueId,
    );
    const parsed = z.object({
      coherent: z.literal(1),
      epoch_deadline: z.string().datetime({ offset: true }),
      actor_deadline: z.string().datetime({ offset: true }),
    }).strict().safeParse(row);
    const coherent = parsed.success &&
      Date.parse(run.deadline) <= Date.parse(parsed.data.epoch_deadline) &&
      Date.parse(run.deadline) <= Date.parse(parsed.data.actor_deadline);
    if (coherent) return;
    if (boundary === "admission") {
      conflict("RLM run admission has incoherent durable lineage");
    }
    corruptState("stored RLM run has incoherent durable lineage");
  }

  #assertActiveValue(
    valueId: string,
    run: Pick<RlmRunRecord, "epochId" | "actorId">,
    purpose: "programResult",
    sourceTurnId: string,
  ): void {
    const row: unknown = this.#database.query(`
      SELECT epoch_id, owner_actor_id, source_turn_id, purpose, state
      FROM harness_context_values WHERE value_id = ?1
    `).get(valueId);
    const parsed = z.object({
      epoch_id: actorEpochIdSchema,
      owner_actor_id: actorIdSchema,
      source_turn_id: actorTurnIdSchema.nullable(),
      purpose: z.literal(purpose),
      state: z.literal("active"),
    }).strict().safeParse(row);
    if (
      !parsed.success || parsed.data.epoch_id !== run.epochId ||
      parsed.data.owner_actor_id !== run.actorId ||
      parsed.data.source_turn_id !== sourceTurnId
    ) conflict("RLM result value has incoherent lineage");
  }

  #assertExternalReplaySuspension(run: RlmRunRecord): void {
    if (run.state !== "running") {
      invalidTransition(
        "only a running RLM run may suspend for external reconciliation",
      );
    }
    const evidence: unknown = this.#database.query(`
      SELECT 1 AS present
      FROM harness_program_operation_receipts
      WHERE run_id = ?1
        AND replay_class = 'reconciledExternalMutation'
        AND state = 'replayRequired'
      LIMIT 1
    `).get(run.id);
    if (!z.object({ present: z.literal(1) }).strict().safeParse(evidence).success) {
      invalidTransition(
        "automatic RLM suspension requires external replay evidence",
      );
    }
  }

  #assertExternalDrainEvidence(
    run: RlmRunRecord,
    states: readonly ("effectStarted" | "replayRequired")[],
  ): void {
    const evidence = this.#externalDrainEvidence(run.id, states);
    if (evidence) return;
    invalidTransition(
      "RLM stop drain requires an already-admitted uncertain external effect",
    );
  }

  #assertNoUnsettledExternalReceipts(run: RlmRunRecord): void {
    if (this.#externalDrainEvidence(run.id, [
      "effectStarted",
      "replayRequired",
      "recoveryRequired",
    ])) {
      invalidTransition(
        "terminal RLM transition would orphan an unsettled external effect",
      );
    }
  }

  #externalDrainEvidence(
    runId: string,
    states: readonly (
      | "effectStarted"
      | "replayRequired"
      | "recoveryRequired"
    )[],
  ): boolean {
    const placeholders = states.map((_state, index) => `?${index + 2}`)
      .join(", ");
    const evidence: unknown = this.#database.query(`
      SELECT 1 AS present
      FROM harness_program_operation_receipts
      WHERE run_id = ?1
        AND replay_class = 'reconciledExternalMutation'
        AND state IN (${placeholders})
      LIMIT 1
    `).get(runId, ...states);
    return z.object({ present: z.literal(1) }).strict()
      .safeParse(evidence).success;
  }
}

export function replayClassForRlmOperation(
  operationValue: RlmV2Operation,
): RlmReceiptRecord["replayClass"] {
  const operation = rlmV2OperationSchema.parse(operationValue);
  switch (operation) {
    case "agent.waitAny":
    case "agent.waitAll":
      return "cancelableWait";
    case "context.materialize":
    case "heap.put":
    case "agent.result":
    case "harness.propose":
      return "idempotentLocalMutation";
    case "agent.spawn":
    case "agent.send":
    case "agent.cancel":
      return "reconciledExternalMutation";
    case "context.snapshot":
    case "context.search":
    case "context.slice":
    case "heap.get":
    case "heap.list":
    case "agent.status":
      return "pureRead";
  }
}

export function isTerminalRunState(state: RlmRunRecord["state"]): boolean {
  return state === "completed" || state === "failed" ||
    state === "stopped" || state === "recoveryRequired";
}

function assertRunTransition(
  current: RlmRunRecord["state"],
  next: RlmRunRecord["state"],
): void {
  const allowed: Readonly<Record<
    RlmRunRecord["state"],
    readonly RlmRunRecord["state"][]
  >> = {
    prepared: ["running", "suspended", "stopped", "recoveryRequired"],
    running: ["suspended", "completed", "failed", "stopped", "recoveryRequired"],
    suspended: ["running", "stopped", "recoveryRequired"],
    completed: [],
    failed: [],
    stopped: [],
    recoveryRequired: [],
  };
  if (!allowed[current].includes(next)) {
    invalidTransition(`invalid RLM run transition: ${current} -> ${next}`);
  }
}

function assertRunTransitionIntent(
  current: Pick<
    RlmRunRecord,
    "desiredState" | "lifecycleCheckpoint" | "state"
  >,
  next: RlmRunRecord["state"],
): void {
  if (next === "running" && current.lifecycleCheckpoint) {
    invalidTransition(
      "checkpointed RLM runs must be released before they resume",
    );
  }
  if (
    next === "running" && current.desiredState !== "run" &&
    !(current.desiredState === "stop" && current.state === "suspended")
  ) {
    invalidTransition("running RLM transitions require durable run intent");
  }
  if (
    next === "suspended" && current.desiredState !== "suspend" &&
    current.desiredState !== "run" && current.desiredState !== "stop"
  ) {
    invalidTransition("suspended RLM transitions require durable intent");
  }
  if (next === "stopped" && current.desiredState !== "stop") {
    invalidTransition("stopped RLM transitions require durable stop intent");
  }
}

function assertDesiredStateTransition(
  current: RlmRunRecord["desiredState"],
  next: RlmRunRecord["desiredState"],
): void {
  const allowed: Readonly<Record<
    RlmRunRecord["desiredState"],
    readonly RlmRunRecord["desiredState"][]
  >> = {
    run: ["suspend", "stop"],
    suspend: ["run", "stop"],
    stop: [],
  };
  if (!allowed[current].includes(next)) {
    invalidTransition(`invalid RLM desired-state transition: ${current} -> ${next}`);
  }
}

function assertReceiptTransition(
  current: RlmReceiptRecord["state"],
  next: RlmReceiptRecord["state"],
): void {
  const allowed: Readonly<Record<
    RlmReceiptRecord["state"],
    readonly RlmReceiptRecord["state"][]
  >> = {
    prepared: ["effectStarted", "replayRequired", "recoveryRequired"],
    effectStarted: ["succeeded", "failed", "replayRequired", "recoveryRequired"],
    replayRequired: ["effectStarted", "recoveryRequired"],
    succeeded: [],
    failed: [],
    recoveryRequired: [],
  };
  if (!allowed[current].includes(next)) {
    invalidTransition(`invalid RLM receipt transition: ${current} -> ${next}`);
  }
}

const runRowSchema = z.object({
  run_id: runIdSchema,
  epoch_id: actorEpochIdSchema,
  actor_id: actorIdSchema,
  turn_id: actorTurnIdSchema,
  program_value_id: contextValueIdSchema,
  program_digest: digestSchema,
  completed_prefix_snapshot_id: snapshotIdSchema,
  current_user_input_value_id: contextValueIdSchema.nullable(),
  capabilities_json: z.string().min(2).max(512),
  admitted_features_json: z.string().min(2).max(512),
  semantic_witness_digests_json: z.string().min(2).max(4_096),
  recursive_budget_json: z.string().min(2).max(2_048),
  fuel_limit: z.number().int(),
  deadline: timestampSchema,
  release_identity_digest: digestSchema,
  admission_digest: digestSchema,
  desired_state: rlmRunDesiredStateSchema,
  lifecycle_checkpoint: z.union([z.literal(0), z.literal(1)]),
  state: rlmRunStateSchema,
  terminal_result_value_id: contextValueIdSchema.nullable(),
  terminal_code: outcomeCodeSchema.nullable(),
  revision: z.number().int().positive().safe(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  settled_at: timestampSchema.nullable(),
}).strict();

const receiptRowSchema = z.object({
  receipt_id: receiptIdSchema,
  run_id: runIdSchema,
  canonical_node_path: z.string().min(2).max(1024),
  operation: rlmV2OperationSchema,
  request_digest: digestSchema,
  effect_key: digestSchema,
  replay_class: rlmReceiptReplayClassSchema,
  state: rlmReceiptStateSchema,
  result_value_id: contextValueIdSchema.nullable(),
  error_json: z.string().min(2).max(256).nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  settled_at: timestampSchema.nullable(),
}).strict();

function parseRunRow(value: unknown): RlmRunRecord {
  try {
    const row = runRowSchema.parse(value);
    const capabilities = parseJson(
      rlmV2CapabilitiesSchema,
      row.capabilities_json,
    );
    const admittedFeatures = parseJson(
      rlmV2AdmittedFeaturesSchema,
      row.admitted_features_json,
    );
    const semanticWitnessDigests = parseJson(
      rlmV2SemanticWitnessDigestsSchema,
      row.semantic_witness_digests_json,
    );
    const budget = parseJson(
      recursiveBudgetSchema,
      row.recursive_budget_json,
    );
    if (row.capabilities_json !== canonicalJson(capabilities)) {
      throw new Error("stored RLM capabilities are not canonical JSON");
    }
    if (row.admitted_features_json !== canonicalJson(admittedFeatures)) {
      throw new Error("stored RLM features are not canonical JSON");
    }
    if (
      row.semantic_witness_digests_json !==
        canonicalJson(semanticWitnessDigests)
    ) {
      throw new Error("stored RLM semantic witnesses are not canonical JSON");
    }
    if (row.recursive_budget_json !== canonicalJson(budget)) {
      throw new Error("stored RLM recursive budget is not canonical JSON");
    }
    return rlmRunRecordSchema.parse({
      id: row.run_id,
      epochId: row.epoch_id,
      actorId: row.actor_id,
      turnId: row.turn_id,
      programValueId: row.program_value_id,
      programDigest: row.program_digest,
      completedPrefixSnapshotId: row.completed_prefix_snapshot_id,
      currentUserInputValueId: row.current_user_input_value_id,
      capabilities,
      admittedFeatures,
      semanticWitnessDigests,
      budget,
      fuelLimit: row.fuel_limit,
      deadline: row.deadline,
      releaseIdentityDigest: row.release_identity_digest,
      admissionDigest: row.admission_digest,
      desiredState: row.desired_state,
      lifecycleCheckpoint: row.lifecycle_checkpoint === 1,
      state: row.state,
      terminalResultValueId: row.terminal_result_value_id,
      terminalCode: row.terminal_code,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      settledAt: row.settled_at,
    });
  } catch (cause: unknown) {
    throw new RlmRunAuthorityV2Error(
      "corrupt_state",
      "stored RLM run is invalid",
      cause,
    );
  }
}

function parseReceiptRow(value: unknown): RlmReceiptRecord {
  try {
    const row = receiptRowSchema.parse(value);
    const nodePath = parseJson(
      rlmV2NodePathSchema,
      row.canonical_node_path,
    );
    if (row.canonical_node_path !== canonicalNodePath(nodePath)) {
      throw new Error("stored RLM node path is not canonical JSON");
    }
    const error = row.error_json === null
      ? null
      : parseJson(failureEvidenceSchema, row.error_json);
    if (row.error_json !== null && row.error_json !== canonicalJson(error)) {
      throw new Error("stored RLM error evidence is not canonical JSON");
    }
    return rlmReceiptRecordSchema.parse({
      id: row.receipt_id,
      runId: row.run_id,
      nodePath,
      operation: row.operation,
      requestDigest: row.request_digest,
      effectKey: row.effect_key,
      replayClass: row.replay_class,
      state: row.state,
      resultValueId: row.result_value_id,
      error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      settledAt: row.settled_at,
    });
  } catch (cause: unknown) {
    throw new RlmRunAuthorityV2Error(
      "corrupt_state",
      "stored RLM receipt is invalid",
      cause,
    );
  }
}

const rlmV2CapabilitiesSchema = z.array(rlmV2CapabilitySchema).max(10).refine(
  (values) => new Set(values).size === values.length,
  "stored RLM capabilities must be unique",
).refine(
  (values) => values.every((value, index) =>
    index === 0 || values[index - 1]! < value
  ),
  "stored RLM capabilities must use canonical lexical order",
);

const rlmV2AdmittedFeaturesSchema = z.array(harnessFeatureSchema).min(1).max(6)
  .refine(
    (values) => values.includes("boundedPrograms") &&
      new Set(values).size === values.length,
    "stored RLM features must be unique and include boundedPrograms",
  ).refine(
    (values) => values.every((value, index) =>
      index === 0 || values[index - 1]! < value
    ),
    "stored RLM features must use canonical lexical order",
  );

const rlmV2SemanticWitnessDigestsSchema = z.array(digestSchema).max(32)
  .refine(
    (values) => new Set(values).size === values.length,
    "stored RLM semantic witnesses must be unique",
  ).refine(
    (values) => values.every((value, index) =>
      index === 0 || values[index - 1]! < value
    ),
    "stored RLM semantic witnesses must use canonical lexical order",
  );

function parseJson<T>(schema: { parse(value: unknown): T }, source: string): T {
  return schema.parse(JSON.parse(source) as unknown);
}

function canonicalNodePath(pathValue: RlmV2NodePath): string {
  return JSON.stringify(rlmV2NodePathSchema.parse(pathValue));
}

function canonicalCaller(value: RlmV2Caller): RlmV2Caller {
  const caller = parseRlmV2Caller(value);
  return parseRlmV2Caller({
    ...caller,
    capabilities: caller.capabilities.toSorted(),
    admittedFeatures: caller.admittedFeatures.toSorted(),
    semanticWitnessDigests: caller.semanticWitnessDigests.toSorted(),
  });
}

function sameRunAdmission(left: RlmRunRecord, right: RlmRunRecord): boolean {
  return left.id === right.id && left.epochId === right.epochId &&
    left.actorId === right.actorId && left.turnId === right.turnId &&
    left.programValueId === right.programValueId &&
    left.programDigest === right.programDigest &&
    left.completedPrefixSnapshotId === right.completedPrefixSnapshotId &&
    left.currentUserInputValueId === right.currentUserInputValueId &&
    canonicalJson(left.capabilities) === canonicalJson(right.capabilities) &&
    canonicalJson(left.admittedFeatures) ===
      canonicalJson(right.admittedFeatures) &&
    canonicalJson(left.semanticWitnessDigests) ===
      canonicalJson(right.semanticWitnessDigests) &&
    canonicalJson(left.budget) === canonicalJson(right.budget) &&
    left.fuelLimit === right.fuelLimit && left.deadline === right.deadline &&
    left.releaseIdentityDigest === right.releaseIdentityDigest &&
    left.admissionDigest === right.admissionDigest;
}

function sameReceiptAdmission(
  left: RlmReceiptRecord,
  right: RlmReceiptRecord,
): boolean {
  return left.id === right.id && left.runId === right.runId &&
    canonicalNodePath(left.nodePath) === canonicalNodePath(right.nodePath) &&
    left.operation === right.operation &&
    left.requestDigest === right.requestDigest &&
    left.effectKey === right.effectKey &&
    left.replayClass === right.replayClass;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).toSorted().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}

function notFound(message: string): never {
  throw new RlmRunAuthorityV2Error("not_found", message);
}

function conflict(message: string): never {
  throw new RlmRunAuthorityV2Error("conflict", message);
}

function revisionConflict(): never {
  throw new RlmRunAuthorityV2Error(
    "revision_conflict",
    "RLM run revision changed",
  );
}

function invalidTransition(message: string): never {
  throw new RlmRunAuthorityV2Error("invalid_transition", message);
}

function corruptState(message: string): never {
  throw new RlmRunAuthorityV2Error("corrupt_state", message);
}
