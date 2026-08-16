import type { Database } from "bun:sqlite";

import { z } from "@hra-internal/schema";

import {
  actorEpochIdSchema,
  actorIdSchema,
  actorTurnIdSchema,
} from "./actor-domain";
import { programRunIdSchema } from "./domain";
import type {
  RlmV2ActorBinding,
  RlmV2ActorBindingPort,
} from "./rlm-operation-router-v2";
import {
  RlmRunAuthorityV2,
  rlmRunRecordSchema,
  type RlmRunRecord,
} from "./rlm-run-authority-v2";
import {
  deriveRlmRuntimeAdmissionDigest,
  type RlmRuntimeCallerPort,
} from "./rlm-runtime-v2";
import {
  deriveRlmV2ReceiptId,
  parseRlmV2Caller,
  rlmV2NodePathSchema,
  type RlmV2Caller,
  type RlmV2OperationContext,
} from "./rlm-v2";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const receiptIdSchema = z.string().min(16).max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);

const operationIdentitySchema = z.object({
  epochId: actorEpochIdSchema,
  actorId: actorIdSchema,
  turnId: actorTurnIdSchema,
  programRunId: programRunIdSchema,
  programDigest: digestSchema,
  receiptId: receiptIdSchema,
  nodePath: rlmV2NodePathSchema,
}).strict();

const executableBindingRowSchema = z.object({
  epoch_state: z.enum(["active", "stopRequested", "stopped", "quarantined"]),
  epoch_root_actor_id: actorIdSchema,
  actor_state: z.enum(["active", "stopRequested", "stopped", "quarantined"]),
  actor_parent_actor_id: actorIdSchema.nullable(),
  actor_depth: z.number().int().min(0).max(3),
  actor_byte_budget: z.number().int().min(1024 * 1024)
    .max(64 * 1024 * 1024),
  turn_state: z.enum([
    "prepared",
    "starting",
    "running",
    "reconciling",
    "succeeded",
    "failed",
    "cancelled",
    "quotaRejected",
    "ambiguous",
  ]),
  turn_desired_state: z.enum(["run", "stop"]),
  turn_outcome_code: z.string().min(1).max(96).nullable(),
  turn_settled_at: z.string().length(24).datetime().nullable(),
  pane_binding_count: z.number().int().nonnegative().safe(),
  quota_rejected_attempt_count: z.number().int().nonnegative().safe(),
  context_quota_bytes: z.number().int().min(1024 * 1024)
    .max(64 * 1024 * 1024),
}).strict();

const ROOT_RESTART_OUTCOME = "codex_runtime_restarted_after_provider_start";

export class RlmCallerAuthorityV2Error extends Error {
  readonly code: "corrupt_state" | "not_found" | "revoked";

  constructor(
    code: RlmCallerAuthorityV2Error["code"],
    cause?: unknown,
  ) {
    super(ERROR_MESSAGES[code], cause === undefined ? undefined : { cause });
    this.name = "RlmCallerAuthorityV2Error";
    this.code = code;
  }
}

const ERROR_MESSAGES: Readonly<Record<
  RlmCallerAuthorityV2Error["code"],
  string
>> = {
  corrupt_state: "RLM caller authority is corrupt",
  not_found: "RLM caller authority does not exist",
  revoked: "RLM caller authority is no longer live",
};

/**
 * Provider-neutral custody for an admitted RLM caller. The only identities
 * read here are the stable epoch, actor, turn, and run identities.
 */
export class RlmCallerAuthorityV2
  implements RlmRuntimeCallerPort, RlmV2ActorBindingPort {
  readonly #database: Database;
  readonly #runs: RlmRunAuthorityV2;
  readonly #now: () => Date;

  constructor(
    database: Database,
    options: Readonly<{
      now?: () => Date;
    }> = {},
  ) {
    this.#database = database;
    this.#runs = new RlmRunAuthorityV2(database);
    this.#now = options.now ?? (() => new Date());
  }

  resolveCaller(runValue: RlmRunRecord): Promise<RlmV2Caller> {
    try {
      const supplied = rlmRunRecordSchema.parse(runValue);
      return Promise.resolve(this.#database.transaction(() => {
        const current = this.#runs.readRun(supplied.id);
        if (current === null) throw new RlmCallerAuthorityV2Error("not_found");
        assertSameAdmission(supplied, current);
        const caller = callerFromRun(current);
        assertAdmissionDigest(current, caller);
        this.#requireExecutableBinding(current);
        return caller;
      })());
    } catch (cause: unknown) {
      return Promise.reject(normalizeError(cause));
    }
  }

  resolve(contextValue: RlmV2OperationContext): Promise<RlmV2ActorBinding> {
    try {
      const context = parseOperationContext(contextValue);
      return Promise.resolve(this.#database.transaction(() => {
        const run = this.#runs.readRun(context.identity.programRunId);
        if (run === null) throw new RlmCallerAuthorityV2Error("not_found");
        const caller = callerFromRun(run);
        assertAdmissionDigest(run, caller);
        assertExactOperationContext(run, caller, context);
        const row = this.#requireExecutableBinding(run);
        return Object.freeze({
          epochId: run.epochId,
          actorId: run.actorId,
          turnId: run.turnId,
          actorDepth: row.actor_depth,
          completedPrefixSnapshotId: run.completedPrefixSnapshotId,
          currentUserInputValueId: run.currentUserInputValueId,
          contextQuotaBytes: Math.min(
            row.actor_byte_budget,
            row.context_quota_bytes,
          ),
        } satisfies RlmV2ActorBinding);
      })());
    } catch (cause: unknown) {
      return Promise.reject(normalizeError(cause));
    }
  }

  /**
   * The run's turn is immutable origin provenance. This resolver never admits
   * a new run: it only revalidates a durable run that is already `running`.
   * Such a run may cross a successful origin settlement or the one root-only
   * restart settlement below. A reconciling quota-rejected origin is revoked;
   * recovery cannot authorize another provider-adjacent operation. New
   * admissions stay restricted to `running` turns by RlmRunAuthorityV2.
   */
  #requireExecutableBinding(
    run: RlmRunRecord,
  ): z.infer<typeof executableBindingRowSchema> {
    if (
      run.state !== "running" || run.desiredState !== "run" ||
      Date.parse(run.deadline) <= this.#now().getTime()
    ) {
      throw new RlmCallerAuthorityV2Error("revoked");
    }
    const rows: unknown[] = this.#database.query(`
      SELECT epoch.state AS epoch_state,
        epoch.root_actor_id AS epoch_root_actor_id,
        actor.state AS actor_state,
        actor.parent_actor_id AS actor_parent_actor_id,
        actor.depth AS actor_depth,
        actor.byte_budget AS actor_byte_budget,
        turn.state AS turn_state,
        turn.desired_state AS turn_desired_state,
        turn.outcome_code AS turn_outcome_code,
        turn.settled_at AS turn_settled_at,
        (
          SELECT COUNT(*) FROM harness_actor_pane_bindings AS pane_binding
          WHERE pane_binding.actor_id = actor.actor_id
        ) AS pane_binding_count,
        (
          SELECT COUNT(*) FROM harness_actor_turn_attempts AS attempt
          WHERE attempt.turn_id = turn.turn_id
            AND attempt.state = 'quotaRejected'
        ) AS quota_rejected_attempt_count,
        settings.context_quota_bytes AS context_quota_bytes
      FROM harness_program_runs AS run
      JOIN harness_actor_epochs AS epoch
        ON epoch.epoch_id = run.epoch_id
      JOIN harness_actors AS actor
        ON actor.actor_id = run.actor_id
        AND actor.epoch_id = run.epoch_id
      JOIN harness_actor_turns AS turn
        ON turn.turn_id = run.turn_id
        AND turn.epoch_id = run.epoch_id
        AND turn.actor_id = run.actor_id
      JOIN harness_settings AS settings ON settings.singleton = 1
      WHERE run.run_id = ?1
      LIMIT 2
    `).all(run.id);
    if (rows.length !== 1) {
      throw new RlmCallerAuthorityV2Error("corrupt_state");
    }
    const row = executableBindingRowSchema.parse(rows[0]);
    const ordinaryLiveOrigin = row.turn_state === "running" ||
      row.turn_state === "succeeded";
    const recoveredRootOrigin = row.turn_state === "failed" &&
      row.turn_outcome_code === ROOT_RESTART_OUTCOME &&
      row.turn_settled_at !== null &&
      Date.parse(run.createdAt) <= Date.parse(row.turn_settled_at) &&
      row.actor_parent_actor_id === null &&
      row.epoch_root_actor_id === run.actorId &&
      row.pane_binding_count === 1;
    if (
      row.epoch_state !== "active" || row.actor_state !== "active" ||
      row.quota_rejected_attempt_count !== 0 ||
      (!ordinaryLiveOrigin && !recoveredRootOrigin) ||
      row.turn_desired_state !== "run"
    ) {
      throw new RlmCallerAuthorityV2Error("revoked");
    }
    return row;
  }
}

function callerFromRun(run: RlmRunRecord): RlmV2Caller {
  return parseRlmV2Caller({
    epochId: run.epochId,
    actorId: run.actorId,
    turnId: run.turnId,
    capabilities: run.capabilities,
    admittedFeatures: run.admittedFeatures,
    semanticWitnessDigests: run.semanticWitnessDigests,
    budget: run.budget,
  });
}

function assertAdmissionDigest(run: RlmRunRecord, caller: RlmV2Caller): void {
  const derived = deriveRlmRuntimeAdmissionDigest({
    runId: run.id,
    epochId: run.epochId,
    actorId: run.actorId,
    turnId: run.turnId,
    completedPrefixSnapshotId: run.completedPrefixSnapshotId,
    currentUserInputValueId: run.currentUserInputValueId,
    releaseIdentityDigest: run.releaseIdentityDigest,
    fuelLimit: run.fuelLimit,
    programDigest: run.programDigest,
    caller,
  });
  if (derived !== run.admissionDigest) {
    throw new RlmCallerAuthorityV2Error("corrupt_state");
  }
}

function assertSameAdmission(left: RlmRunRecord, right: RlmRunRecord): void {
  if (canonicalJson(admissionFields(left)) !== canonicalJson(admissionFields(right))) {
    throw new RlmCallerAuthorityV2Error("corrupt_state");
  }
}

function admissionFields(run: RlmRunRecord): Readonly<Record<string, unknown>> {
  return {
    id: run.id,
    epochId: run.epochId,
    actorId: run.actorId,
    turnId: run.turnId,
    programValueId: run.programValueId,
    programDigest: run.programDigest,
    completedPrefixSnapshotId: run.completedPrefixSnapshotId,
    currentUserInputValueId: run.currentUserInputValueId,
    capabilities: run.capabilities,
    admittedFeatures: run.admittedFeatures,
    semanticWitnessDigests: run.semanticWitnessDigests,
    budget: run.budget,
    fuelLimit: run.fuelLimit,
    deadline: run.deadline,
    releaseIdentityDigest: run.releaseIdentityDigest,
    admissionDigest: run.admissionDigest,
    createdAt: run.createdAt,
  };
}

function parseOperationContext(context: RlmV2OperationContext): Readonly<{
  identity: z.infer<typeof operationIdentitySchema>;
  caller: RlmV2Caller;
}> {
  const identity = operationIdentitySchema.parse({
    epochId: context.epochId,
    actorId: context.actorId,
    turnId: context.turnId,
    programRunId: context.programRunId,
    programDigest: context.programDigest,
    receiptId: context.receiptId,
    nodePath: context.nodePath,
  });
  const caller = parseRlmV2Caller({
    epochId: context.epochId,
    actorId: context.actorId,
    turnId: context.turnId,
    capabilities: context.capabilities,
    admittedFeatures: context.admittedFeatures,
    semanticWitnessDigests: context.semanticWitnessDigests,
    budget: context.budget,
  });
  return Object.freeze({ identity, caller });
}

function assertExactOperationContext(
  run: RlmRunRecord,
  caller: RlmV2Caller,
  context: Readonly<{
    identity: z.infer<typeof operationIdentitySchema>;
    caller: RlmV2Caller;
  }>,
): void {
  if (
    context.identity.epochId !== run.epochId ||
    context.identity.actorId !== run.actorId ||
    context.identity.turnId !== run.turnId ||
    context.identity.programDigest !== run.programDigest ||
    context.identity.receiptId !== deriveRlmV2ReceiptId(
      run.id,
      run.programDigest,
      context.identity.nodePath,
    ) ||
    canonicalJson(context.caller) !== canonicalJson(caller)
  ) {
    throw new RlmCallerAuthorityV2Error("corrupt_state");
  }
}

function normalizeError(cause: unknown): RlmCallerAuthorityV2Error {
  return cause instanceof RlmCallerAuthorityV2Error
    ? cause
    : new RlmCallerAuthorityV2Error("corrupt_state", cause);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).toSorted().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}
