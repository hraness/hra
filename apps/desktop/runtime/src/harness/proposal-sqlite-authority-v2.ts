import type { Database } from "bun:sqlite";

import { z } from "@hra-internal/schema";

import {
  actorEpochIdSchema,
  actorIdSchema,
  actorTurnIdSchema,
} from "./actor-domain";
import {
  HARNESS_PROPOSAL_ADMISSION_LIMIT,
  type HarnessProposalAuthorityPort,
  type HarnessProposalRecord,
  type HarnessProposalRecoveryAuthorityPort,
} from "./proposal-service";
import {
  deriveRlmV2ReceiptId,
  rlmV2NodePathSchema,
} from "./rlm-v2";

const proposalIdSchema = z.string().min(19).max(96)
  .regex(/^hproposal_[A-Za-z0-9_-]+$/u);
const operationIdSchema = z.string().min(16).max(128)
  .regex(/^[A-Za-z][A-Za-z0-9_-]+$/u);
const valueIdSchema = z.string().min(16).max(96)
  .regex(/^ctxval_[A-Za-z0-9_-]+$/u);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const titleSchema = z.string().min(1).max(160).refine(
  (value) => value === value.trim() && !value.includes("\0"),
  "proposal title must be trimmed and NUL-free",
);
const timestampSchema = z.string().length(24).datetime().refine(
  (value) => new Date(Date.parse(value)).toISOString() === value,
  "proposal timestamps must use canonical UTC milliseconds",
);
const stateSchema = z.enum(["prepared", "active", "recoveryRequired"]);

const prepareSchema = z.object({
  id: proposalIdSchema,
  epochId: actorEpochIdSchema,
  actorId: actorIdSchema,
  sourceTurnId: actorTurnIdSchema,
  operationId: operationIdSchema,
  title: titleSchema,
  bodyValueId: valueIdSchema,
  bodyDigest: digestSchema,
}).strict();

const rowSchema = z.object({
  proposal_id: proposalIdSchema,
  epoch_id: actorEpochIdSchema,
  actor_id: actorIdSchema,
  source_turn_id: actorTurnIdSchema,
  operation_id: operationIdSchema,
  title: titleSchema,
  body_value_id: valueIdSchema,
  body_digest: digestSchema,
  state: stateSchema,
  recovery_reason: z.string().min(1).max(96).nullable(),
  revision: z.number().int().positive().safe(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  activated_at: timestampSchema.nullable(),
}).strict();

const settingsRowSchema = z.object({
  refinement_mode: z.enum(["off", "suggest"]),
}).strict();
const countRowSchema = z.object({
  proposal_count: z.number().int().nonnegative().safe(),
}).strict();
const liveProposalReceiptRowSchema = z.object({
  run_id: z.string().min(15).max(96)
    .regex(/^rlmrun_[A-Za-z0-9_-]+$/u),
  program_digest: digestSchema,
  canonical_node_path: z.string().min(2).max(1024),
}).strict();

export class HarnessProposalSQLiteAuthorityV2Error extends Error {
  readonly code:
    | "capacity_exhausted"
    | "conflict"
    | "corrupt_state"
    | "disabled"
    | "not_found"
    | "revision_conflict";

  constructor(
    code: HarnessProposalSQLiteAuthorityV2Error["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HarnessProposalSQLiteAuthorityV2Error";
    this.code = code;
  }
}

/**
 * Content-free SQLite authority for the suggest-only proposal ledger.
 * Proposal rows retain the receipt identity and re-derive its immutable RLM
 * run/node coordinate from the owning tables on admission and every read.
 */
export class HarnessProposalSQLiteAuthorityV2
  implements HarnessProposalAuthorityPort, HarnessProposalRecoveryAuthorityPort {
  readonly #database: Database;
  readonly #now: () => Date;

  constructor(
    database: Database,
    options: Readonly<{ now?: () => Date }> = {},
  ) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
  }

  async refinementMode(): Promise<"off" | "suggest"> {
    await Promise.resolve();
    const value: unknown = this.#database.query(
      "SELECT refinement_mode FROM harness_settings WHERE singleton = 1",
    ).get();
    try {
      return settingsRowSchema.parse(value).refinement_mode;
    } catch (cause: unknown) {
      throw new HarnessProposalSQLiteAuthorityV2Error(
        "corrupt_state",
        "harness proposal settings are unavailable",
        cause,
      );
    }
  }

  async prepare(inputValue: Readonly<{
    id: string;
    epochId: string;
    actorId: string;
    sourceTurnId: string;
    operationId: string;
    title: string;
    bodyValueId: string;
    bodyDigest: string;
  }>): Promise<HarnessProposalRecord> {
    await Promise.resolve();
    const input = prepareSchema.parse(inputValue);
    const createdAt = timestampSchema.parse(this.#now().toISOString());
    const record = this.#database.transaction(() => {
      this.#assertSuggestEnabled();
      const collisions = this.#readCollisions(input);
      if (collisions.length > 0) {
        if (collisions.length === 1 && sameIdentity(collisions[0]!, input)) {
          return collisions[0]!;
        }
        conflict("proposal identity is already bound to different immutable input");
      }
      this.#assertLiveLineage(input);
      this.#assertAdmissionCapacity();
      try {
        this.#database.query(`
          INSERT INTO harness_proposals (
            proposal_id, epoch_id, actor_id, source_turn_id, operation_id,
            title, body_value_id, body_digest, state, recovery_reason,
            revision, created_at, updated_at, activated_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
            'prepared', NULL, 1, ?9, ?9, NULL
          )
        `).run(
          input.id,
          input.epochId,
          input.actorId,
          input.sourceTurnId,
          input.operationId,
          input.title,
          input.bodyValueId,
          input.bodyDigest,
          createdAt,
        );
      } catch (cause: unknown) {
        throw new HarnessProposalSQLiteAuthorityV2Error(
          "conflict",
          "proposal admission conflicts with durable authority",
          cause,
        );
      }
      return this.#require(input.id);
    })();
    return record;
  }

  async activate(inputValue: Readonly<{
    id: string;
    expectedRevision: number;
  }>): Promise<HarnessProposalRecord> {
    await Promise.resolve();
    const input = z.object({
      id: proposalIdSchema,
      expectedRevision: z.number().int().positive().safe(),
    }).strict().parse(inputValue);
    const now = timestampSchema.parse(this.#now().toISOString());
    const record = this.#database.transaction(() => {
      this.#assertSuggestEnabled();
      const current = this.#require(input.id);
      if (current.state === "active" && current.revision === input.expectedRevision + 1) {
        return current;
      }
      if (current.revision !== input.expectedRevision) revisionConflict();
      if (current.state !== "prepared") {
        conflict("only a prepared proposal may become active");
      }
      this.#assertLiveLineage(current);
      if (this.#activeProposalCount() >= HARNESS_PROPOSAL_ADMISSION_LIMIT) {
        return this.#markCapacityRecovery(current, now);
      }
      try {
        const changed = this.#database.query(`
          UPDATE harness_proposals SET
            state = 'active', revision = revision + 1,
            updated_at = ?3, activated_at = ?3
          WHERE proposal_id = ?1 AND revision = ?2 AND state = 'prepared'
        `).run(input.id, input.expectedRevision, now);
        if (changed.changes !== 1) revisionConflict();
      } catch (cause: unknown) {
        if (cause instanceof HarnessProposalSQLiteAuthorityV2Error) throw cause;
        throw new HarnessProposalSQLiteAuthorityV2Error(
          "conflict",
          "proposal body lineage is not ready for activation",
          cause,
        );
      }
      return this.#require(input.id);
    })();
    return record;
  }

  async read(idValue: string): Promise<HarnessProposalRecord | null> {
    await Promise.resolve();
    const id = proposalIdSchema.parse(idValue);
    return this.#read(id);
  }

  async list(inputValue: Readonly<{
    afterProposalId: string | null;
    limit: number;
  }>): Promise<readonly HarnessProposalRecord[]> {
    await Promise.resolve();
    const input = z.object({
      afterProposalId: proposalIdSchema.nullable(),
      limit: z.number().int().min(1).max(32),
    }).strict().parse(inputValue);
    const rows: unknown[] = this.#database.query(`
      SELECT * FROM harness_proposals
      WHERE state = 'active' AND proposal_id > COALESCE(?1, '')
      ORDER BY proposal_id LIMIT ?2
    `).all(input.afterProposalId, input.limit);
    return Object.freeze(rows.map((row) => this.#parse(row)));
  }

  async listPrepared(inputValue: Readonly<{
    afterProposalId: string | null;
    limit: number;
  }>): Promise<readonly HarnessProposalRecord[]> {
    await Promise.resolve();
    const input = z.object({
      afterProposalId: proposalIdSchema.nullable(),
      limit: z.number().int().min(1).max(32),
    }).strict().parse(inputValue);
    const rows: unknown[] = this.#database.query(`
      SELECT * FROM harness_proposals
      WHERE state = 'prepared' AND proposal_id > COALESCE(?1, '')
      ORDER BY proposal_id LIMIT ?2
    `).all(input.afterProposalId, input.limit);
    return Object.freeze(rows.map((row) => this.#parse(row)));
  }

  async inspectPreparedBody(
    idValue: string,
  ): Promise<"missing" | "exact" | "conflict"> {
    await Promise.resolve();
    const proposal = this.#require(proposalIdSchema.parse(idValue));
    if (proposal.state !== "prepared") {
      throw new HarnessProposalSQLiteAuthorityV2Error(
        "conflict",
        "only a prepared proposal has recoverable body evidence",
      );
    }
    return this.#inspectBody(proposal);
  }

  async activateRecovered(inputValue: Readonly<{
    id: string;
    expectedRevision: number;
  }>): Promise<HarnessProposalRecord> {
    await Promise.resolve();
    const input = z.object({
      id: proposalIdSchema,
      expectedRevision: z.number().int().positive().safe(),
    }).strict().parse(inputValue);
    const now = timestampSchema.parse(this.#now().toISOString());
    return this.#database.transaction(() => {
      const current = this.#require(input.id);
      if (current.state === "active") return current;
      if (current.revision !== input.expectedRevision) revisionConflict();
      if (current.state !== "prepared" || this.#inspectBody(current) !== "exact") {
        conflict("prepared proposal lacks exact recovery body evidence");
      }
      if (this.#activeProposalCount() >= HARNESS_PROPOSAL_ADMISSION_LIMIT) {
        return this.#markCapacityRecovery(current, now);
      }
      const changed = this.#database.query(`
        UPDATE harness_proposals SET
          state = 'active', revision = revision + 1,
          recovery_reason = NULL, updated_at = ?3, activated_at = ?3
        WHERE proposal_id = ?1 AND revision = ?2 AND state = 'prepared'
      `).run(current.id, current.revision, now);
      if (changed.changes !== 1) revisionConflict();
      return this.#require(current.id);
    })();
  }

  async markRecoveryRequired(inputValue: Readonly<{
    id: string;
    expectedRevision: number;
    reason:
      | "body_missing"
      | "body_conflict"
      | "body_content_mismatch"
      | "capacity_exhausted";
  }>): Promise<HarnessProposalRecord> {
    await Promise.resolve();
    const input = z.object({
      id: proposalIdSchema,
      expectedRevision: z.number().int().positive().safe(),
      reason: z.enum([
        "body_missing",
        "body_conflict",
        "body_content_mismatch",
        "capacity_exhausted",
      ]),
    }).strict().parse(inputValue);
    const now = timestampSchema.parse(this.#now().toISOString());
    return this.#database.transaction(() => {
      const current = this.#require(input.id);
      if (current.state === "active") return current;
      if (current.state === "recoveryRequired") {
        if (current.recoveryReason === input.reason) return current;
        conflict("proposal already has different recovery evidence");
      }
      if (current.revision !== input.expectedRevision) revisionConflict();
      if (current.state !== "prepared") {
        conflict("only a prepared proposal may require recovery");
      }
      const changed = this.#database.query(`
        UPDATE harness_proposals SET
          state = 'recoveryRequired', recovery_reason = ?3,
          revision = revision + 1, updated_at = ?4, activated_at = NULL
        WHERE proposal_id = ?1 AND revision = ?2 AND state = 'prepared'
      `).run(current.id, current.revision, input.reason, now);
      if (changed.changes !== 1) revisionConflict();
      return this.#require(current.id);
    })();
  }

  #read(id: string): HarnessProposalRecord | null {
    const value: unknown = this.#database.query(
      "SELECT * FROM harness_proposals WHERE proposal_id = ?1",
    ).get(id);
    return value === null ? null : this.#parse(value);
  }

  #assertSuggestEnabled(): void {
    const value: unknown = this.#database.query(
      "SELECT refinement_mode FROM harness_settings WHERE singleton = 1",
    ).get();
    let mode: z.infer<typeof settingsRowSchema>;
    try {
      mode = settingsRowSchema.parse(value);
    } catch (cause: unknown) {
      throw new HarnessProposalSQLiteAuthorityV2Error(
        "corrupt_state",
        "harness proposal settings are unavailable",
        cause,
      );
    }
    if (mode.refinement_mode !== "suggest") {
      throw new HarnessProposalSQLiteAuthorityV2Error(
        "disabled",
        "harness proposal suggestions are disabled",
      );
    }
  }

  #require(id: string): HarnessProposalRecord {
    const value = this.#read(id);
    if (value === null) {
      throw new HarnessProposalSQLiteAuthorityV2Error(
        "not_found",
        "harness proposal does not exist",
      );
    }
    return value;
  }

  #readCollisions(input: z.infer<typeof prepareSchema>): HarnessProposalRecord[] {
    const rows: unknown[] = this.#database.query(`
      SELECT * FROM harness_proposals
      WHERE proposal_id = ?1 OR operation_id = ?2 OR body_value_id = ?3
      ORDER BY proposal_id
    `).all(input.id, input.operationId, input.bodyValueId);
    return rows.map((row) => this.#parse(row));
  }

  #assertAdmissionCapacity(): void {
    const count = countRowSchema.parse(this.#database.query(`
      SELECT COUNT(*) AS proposal_count
      FROM harness_proposals
      WHERE state IN ('prepared', 'active')
    `).get()).proposal_count;
    if (count >= HARNESS_PROPOSAL_ADMISSION_LIMIT) {
      throw new HarnessProposalSQLiteAuthorityV2Error(
        "capacity_exhausted",
        "harness proposal admission is at its renderer-safe bound",
      );
    }
  }

  #activeProposalCount(): number {
    return countRowSchema.parse(this.#database.query(`
      SELECT COUNT(*) AS proposal_count
      FROM harness_proposals
      WHERE state = 'active'
    `).get()).proposal_count;
  }

  #markCapacityRecovery(
    current: HarnessProposalRecord,
    now: string,
  ): HarnessProposalRecord {
    const changed = this.#database.query(`
      UPDATE harness_proposals SET
        state = 'recoveryRequired', recovery_reason = 'capacity_exhausted',
        revision = revision + 1, updated_at = ?3, activated_at = NULL
      WHERE proposal_id = ?1 AND revision = ?2 AND state = 'prepared'
    `).run(current.id, current.revision, now);
    if (changed.changes !== 1) revisionConflict();
    return this.#require(current.id);
  }

  #parse(value: unknown): HarnessProposalRecord {
    let row: z.infer<typeof rowSchema>;
    try {
      row = rowSchema.parse(value);
    } catch (cause: unknown) {
      throw new HarnessProposalSQLiteAuthorityV2Error(
        "corrupt_state",
        "stored harness proposal is invalid",
        cause,
      );
    }
    const record: HarnessProposalRecord = {
      id: row.proposal_id,
      epochId: row.epoch_id,
      actorId: row.actor_id,
      sourceTurnId: row.source_turn_id,
      operationId: row.operation_id,
      title: row.title,
      bodyValueId: row.body_value_id,
      bodyDigest: row.body_digest,
      state: row.state,
      recoveryReason: row.recovery_reason,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      activatedAt: row.activated_at,
    };
    if (
      (record.state === "active") !== (record.activatedAt !== null) ||
      (record.state === "recoveryRequired") !==
        (record.recoveryReason !== null) ||
      Date.parse(record.updatedAt) < Date.parse(record.createdAt)
    ) {
      throw new HarnessProposalSQLiteAuthorityV2Error(
        "corrupt_state",
        "stored harness proposal lifecycle is incoherent",
      );
    }
    this.#assertStoredLineage(record);
    return Object.freeze(record);
  }

  #assertLiveLineage(input: Readonly<{
    epochId: string;
    actorId: string;
    sourceTurnId: string;
    operationId: string;
  }>): void {
    const rows: unknown[] = this.#database.query(`
      SELECT run.run_id, run.program_digest, receipt.canonical_node_path
      FROM harness_actor_epochs AS epoch
      JOIN harness_actors AS actor
        ON actor.actor_id = ?2 AND actor.epoch_id = epoch.epoch_id
      JOIN harness_actor_turns AS turn
        ON turn.turn_id = ?3 AND turn.epoch_id = epoch.epoch_id
        AND turn.actor_id = actor.actor_id
      JOIN harness_program_runs AS run
        ON run.epoch_id = epoch.epoch_id
        AND run.actor_id = actor.actor_id
        AND run.turn_id = turn.turn_id
      JOIN harness_program_operation_receipts AS receipt
        ON receipt.run_id = run.run_id AND receipt.receipt_id = ?4
      WHERE epoch.epoch_id = ?1
        AND epoch.state = 'active' AND actor.state = 'active'
        AND turn.state IN ('running', 'succeeded')
        AND turn.desired_state = 'run'
        AND run.state = 'running' AND run.desired_state = 'run'
        AND run.deadline > ?5
        AND receipt.operation = 'harness.propose'
        AND receipt.replay_class = 'idempotentLocalMutation'
        AND receipt.state = 'effectStarted'
        AND EXISTS (
          SELECT 1 FROM json_each(run.capabilities_json)
          WHERE json_each.value = 'harness.propose'
        )
        AND EXISTS (
          SELECT 1 FROM json_each(run.admitted_features_json)
          WHERE json_each.value = 'instructionCandidates'
        )
      LIMIT 2
    `).all(
      input.epochId,
      input.actorId,
      input.sourceTurnId,
      input.operationId,
      timestampSchema.parse(this.#now().toISOString()),
    );
    if (rows.length === 0) {
      conflict("proposal source lacks one live immutable RLM operation receipt");
    }
    this.#assertExactReceiptIdentity(
      rows,
      input.operationId,
      "harness proposal receipt identity is incoherent",
    );
  }

  #assertExactReceiptIdentity(
    rows: readonly unknown[],
    operationId: string,
    message: string,
  ): void {
    if (rows.length !== 1) {
      throw new HarnessProposalSQLiteAuthorityV2Error(
        "corrupt_state",
        message,
      );
    }
    let proof: z.infer<typeof liveProposalReceiptRowSchema>;
    try {
      proof = liveProposalReceiptRowSchema.parse(rows[0]);
    } catch (cause: unknown) {
      throw new HarnessProposalSQLiteAuthorityV2Error(
        "corrupt_state",
        "harness proposal receipt evidence is invalid",
        cause,
      );
    }
    let nodePath: z.infer<typeof rlmV2NodePathSchema>;
    try {
      const parsed: unknown = JSON.parse(proof.canonical_node_path) as unknown;
      nodePath = rlmV2NodePathSchema.parse(parsed);
    } catch (cause: unknown) {
      throw new HarnessProposalSQLiteAuthorityV2Error(
        "corrupt_state",
        "harness proposal receipt coordinate is invalid",
        cause,
      );
    }
    if (
      JSON.stringify(nodePath) !== proof.canonical_node_path ||
      deriveRlmV2ReceiptId(proof.run_id, proof.program_digest, nodePath) !==
        operationId
    ) {
      throw new HarnessProposalSQLiteAuthorityV2Error(
        "corrupt_state",
        message,
      );
    }
  }

  #assertStoredLineage(record: HarnessProposalRecord): void {
    const value: unknown = this.#database.query(`
      SELECT 1 AS coherent
      FROM harness_actor_epochs AS epoch
      JOIN harness_actors AS actor
        ON actor.actor_id = ?2 AND actor.epoch_id = epoch.epoch_id
      JOIN harness_actor_turns AS turn
        ON turn.turn_id = ?3 AND turn.epoch_id = epoch.epoch_id
        AND turn.actor_id = actor.actor_id
      WHERE epoch.epoch_id = ?1
    `).get(record.epochId, record.actorId, record.sourceTurnId);
    if (!z.object({ coherent: z.literal(1) }).strict().safeParse(value).success) {
      throw new HarnessProposalSQLiteAuthorityV2Error(
        "corrupt_state",
        "stored harness proposal lineage is incoherent",
      );
    }
    const receiptRows: unknown[] = this.#database.query(`
      SELECT run.run_id, run.program_digest, receipt.canonical_node_path
      FROM harness_program_operation_receipts AS receipt
      JOIN harness_program_runs AS run ON run.run_id = receipt.run_id
      WHERE receipt.receipt_id = ?1
        AND receipt.operation = 'harness.propose'
        AND receipt.replay_class = 'idempotentLocalMutation'
        AND receipt.state != 'prepared'
        AND run.epoch_id = ?2 AND run.actor_id = ?3 AND run.turn_id = ?4
        AND EXISTS (
          SELECT 1 FROM json_each(run.capabilities_json)
          WHERE json_each.value = 'harness.propose'
        )
        AND EXISTS (
          SELECT 1 FROM json_each(run.admitted_features_json)
          WHERE json_each.value = 'instructionCandidates'
        )
      LIMIT 2
    `).all(
      record.operationId,
      record.epochId,
      record.actorId,
      record.sourceTurnId,
    );
    this.#assertExactReceiptIdentity(
      receiptRows,
      record.operationId,
      "stored harness proposal origin is incoherent",
    );
    if (record.state !== "active") return;
    const body: unknown = this.#database.query(`
      SELECT 1 AS coherent FROM harness_context_values
      WHERE value_id = ?1 AND epoch_id = ?2 AND owner_actor_id = ?3
        AND source_turn_id = ?4 AND purpose = 'proposal'
        AND kind = 'json' AND state = 'active'
    `).get(
      record.bodyValueId,
      record.epochId,
      record.actorId,
      record.sourceTurnId,
    );
    if (!z.object({ coherent: z.literal(1) }).strict().safeParse(body).success) {
      throw new HarnessProposalSQLiteAuthorityV2Error(
        "corrupt_state",
        "active harness proposal body lineage is incoherent",
      );
    }
  }

  #inspectBody(
    record: HarnessProposalRecord,
  ): "missing" | "exact" | "conflict" {
    const value: unknown = this.#database.query(`
      SELECT
        COUNT(*) AS value_count,
        SUM(CASE WHEN epoch_id = ?2 AND owner_actor_id = ?3
          AND source_turn_id = ?4 AND purpose = 'proposal'
          AND kind = 'json' AND state = 'active' THEN 1 ELSE 0 END)
          AS exact_count
      FROM harness_context_values WHERE value_id = ?1
    `).get(
      record.bodyValueId,
      record.epochId,
      record.actorId,
      record.sourceTurnId,
    );
    const evidence = z.object({
      value_count: z.number().int().nonnegative().safe(),
      exact_count: z.number().int().nonnegative().safe().nullable(),
    }).strict().parse(value);
    if (evidence.value_count === 0) return "missing";
    return evidence.value_count === 1 && evidence.exact_count === 1
      ? "exact"
      : "conflict";
  }
}

function sameIdentity(
  record: HarnessProposalRecord,
  input: z.infer<typeof prepareSchema>,
): boolean {
  return record.id === input.id && record.epochId === input.epochId &&
    record.actorId === input.actorId &&
    record.sourceTurnId === input.sourceTurnId &&
    record.operationId === input.operationId && record.title === input.title &&
    record.bodyValueId === input.bodyValueId &&
    record.bodyDigest === input.bodyDigest;
}

function conflict(message: string): never {
  throw new HarnessProposalSQLiteAuthorityV2Error("conflict", message);
}

function revisionConflict(): never {
  throw new HarnessProposalSQLiteAuthorityV2Error(
    "revision_conflict",
    "harness proposal revision changed",
  );
}
