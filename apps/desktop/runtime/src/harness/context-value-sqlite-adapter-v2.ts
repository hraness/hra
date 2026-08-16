import type { Database } from "bun:sqlite";

import { z } from "@hra-internal/schema";

import {
  actorEpochIdSchema,
  actorIdSchema,
  actorTurnIdSchema,
} from "./actor-domain";
import {
  CONTEXT_VALUE_CHUNK_BYTES,
  CONTEXT_VALUE_MAX_OBJECT_BYTES,
  COMPLETED_PREFIX_CONTEXT_VALUE_MAX_BYTES,
  COMPLETED_PREFIX_CONTEXT_VALUE_MAX_CHUNKS,
  ContextValueQuotaExceededError,
  contextValueChunkMetadataSchema,
  contextValueLifecycleRecordSchema,
  contextValuePrepareInputSchema,
  contextValueRecoveryReasonSchema,
  type ContextValueMetadataPort,
  type ContextValuePrepareInput,
  type ContextValueRecord,
  type ContextValueRecoveryReason,
} from "./context-value-store";
import { contextValueIdSchema } from "./domain";

const operationIdSchema = contextValuePrepareInputSchema.shape.operationId;
const revisionSchema = z.number().int().positive().safe();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const timestampSchema = z.string().length(24).datetime().refine(
  (value) => new Date(Date.parse(value)).toISOString() === value,
  "context-value timestamps must use canonical UTC milliseconds",
);
const stateSchema = contextValueLifecycleRecordSchema.shape.state;

const rowSchema = z.object({
  value_id: contextValueIdSchema,
  operation_id: operationIdSchema,
  epoch_id: actorEpochIdSchema,
  owner_actor_id: actorIdSchema,
  source_turn_id: actorTurnIdSchema.nullable(),
  kind: contextValuePrepareInputSchema.shape.kind,
  purpose: contextValuePrepareInputSchema.shape.purpose,
  schema_version: z.literal(1),
  name_digest: digestSchema.nullable(),
  utf8_bytes: z.number().int().nonnegative()
    .max(COMPLETED_PREFIX_CONTEXT_VALUE_MAX_BYTES),
  content_digest: digestSchema,
  chunk_size: z.literal(CONTEXT_VALUE_CHUNK_BYTES),
  chunk_count: z.number().int().min(1)
    .max(COMPLETED_PREFIX_CONTEXT_VALUE_MAX_CHUNKS),
  manifest_digest: digestSchema,
  manifest_byte_length: z.number().int().positive()
    .max(CONTEXT_VALUE_MAX_OBJECT_BYTES),
  quota_limit_bytes: z.number().int().min(1024 * 1024).max(64 * 1024 * 1024),
  state: stateSchema,
  recovery_reason: contextValueRecoveryReasonSchema.nullable(),
  revision: revisionSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
  effect_started_at: timestampSchema.nullable(),
  activated_at: timestampSchema.nullable(),
}).strict();

const chunkRowSchema = z.object({
  value_id: contextValueIdSchema,
  ordinal: z.number().int().min(0)
    .max(COMPLETED_PREFIX_CONTEXT_VALUE_MAX_CHUNKS - 1),
  plaintext_bytes: z.number().int().min(0).max(CONTEXT_VALUE_CHUNK_BYTES),
  object_digest: digestSchema,
  object_byte_length: z.number().int().positive()
    .max(CONTEXT_VALUE_MAX_OBJECT_BYTES),
}).strict();

const quotaRowSchema = z.object({
  context_quota_bytes: z.number().int().min(1024 * 1024)
    .max(64 * 1024 * 1024),
  total_used_bytes: z.number().int().nonnegative().safe(),
  epoch_work_used_bytes: z.number().int().nonnegative().safe(),
  owner_work_used_bytes: z.number().int().nonnegative().safe(),
  epoch_byte_budget: z.number().int().positive().safe(),
  owner_byte_budget: z.number().int().positive().safe(),
  owner_byte_reserved: z.number().int().nonnegative().safe(),
}).strict();

const workPurposes = Object.freeze([
  "heap",
  "agentResult",
  "proposal",
  "programSource",
  "programResult",
] as const);

const transitionBaseSchema = z.object({
  operationId: operationIdSchema,
  expectedRevision: revisionSchema,
}).strict();

const effectStartedInputSchema = transitionBaseSchema;
const replayRequiredInputSchema = transitionBaseSchema.extend({
  expectedState: z.literal("effectStarted"),
}).strict();
const activateInputSchema = transitionBaseSchema.extend({
  expectedState: z.enum(["effectStarted", "replayRequired"]),
  manifestDigest: digestSchema,
}).strict();
const recoveryInputSchema = transitionBaseSchema.extend({
  expectedState: z.enum([
    "prepared",
    "effectStarted",
    "replayRequired",
    "active",
  ]),
  reason: contextValueRecoveryReasonSchema,
}).strict();

const activeAddressSchema = z.object({
  epochId: actorEpochIdSchema,
  ownerActorId: actorIdSchema,
  sourceTurnId: actorTurnIdSchema.nullable(),
  valueId: contextValueIdSchema,
}).strict();

const activeListSchema = z.object({
  epochId: actorEpochIdSchema,
  afterValueId: contextValueIdSchema.nullable(),
  limit: z.number().int().min(1).max(128),
}).strict();

const recoveryListSchema = z.object({
  afterOperationId: operationIdSchema.nullable(),
  limit: z.number().int().min(1).max(128),
}).strict();

export class ContextValueSQLiteAdapterV2Error extends Error {
  readonly code:
    | "conflict"
    | "corrupt_state"
    | "not_found"
    | "revision_conflict";

  constructor(
    code: ContextValueSQLiteAdapterV2Error["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ContextValueSQLiteAdapterV2Error";
    this.code = code;
  }
}

/** Exact content-free SQLite authority for encrypted v2 context values. */
export class ContextValueSQLiteAdapterV2 implements ContextValueMetadataPort {
  readonly #database: Database;
  readonly #now: () => Date;

  constructor(
    database: Database,
    options: Readonly<{ now?: () => Date }> = {},
  ) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
  }

  prepareContextValue(
    inputValue: ContextValuePrepareInput,
  ): Promise<ContextValueRecord> {
    return deferredResult(() => {
      const input = contextValuePrepareInputSchema.parse(inputValue);
      const timestamp = this.#timestamp();
      return this.#database.transaction(() => {
      const collisions = this.#readCollisions(input);
      if (collisions.length > 0) {
        if (collisions.length === 1 && sameImmutable(collisions[0]!, input)) {
          return collisions[0]!;
        }
        conflict("context-value identity is bound to different immutable input");
      }
      this.#assertLiveLineage(input);
      this.#assertNameAvailable(input);
      this.#reserveQuota(input);
      try {
        this.#database.query(`
          INSERT INTO harness_context_values (
            value_id, operation_id, epoch_id, owner_actor_id, source_turn_id,
            kind, purpose, schema_version, name_digest, utf8_bytes,
            content_digest, chunk_size, chunk_count, manifest_digest,
            manifest_byte_length, quota_limit_bytes, state, recovery_reason,
            revision, created_at, updated_at, effect_started_at, activated_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
            ?14, ?15, ?16, 'prepared', NULL, 1, ?17, ?17, NULL, NULL
          )
        `).run(
          input.valueId,
          input.operationId,
          input.epochId,
          input.ownerActorId,
          input.sourceTurnId,
          input.kind,
          input.purpose,
          input.schemaVersion,
          input.nameDigest,
          input.utf8Bytes,
          input.contentDigest,
          input.chunkSize,
          input.chunkCount,
          input.manifestDigest,
          input.manifestByteLength,
          input.quotaLimitBytes,
          timestamp,
        );
        const statement = this.#database.query(`
          INSERT INTO harness_context_value_chunks (
            value_id, ordinal, plaintext_bytes, object_digest,
            object_byte_length
          ) VALUES (?1, ?2, ?3, ?4, ?5)
        `);
        for (const chunk of input.chunks) {
          statement.run(
            input.valueId,
            chunk.ordinal,
            chunk.plaintextBytes,
            chunk.objectDigest,
            chunk.objectByteLength,
          );
        }
      } catch (cause: unknown) {
        throw new ContextValueSQLiteAdapterV2Error(
          "conflict",
          "context-value admission conflicts with durable authority",
          cause,
        );
      }
        return this.#requireByOperation(input.operationId);
      })();
    });
  }

  markContextValueEffectStarted(inputValue: Readonly<{
    operationId: string;
    expectedRevision: number;
  }>): Promise<ContextValueRecord> {
    return deferredResult(() => {
      const input = effectStartedInputSchema.parse(inputValue);
      return this.#transition({
        operationId: input.operationId,
        expectedRevision: input.expectedRevision,
        expectedState: "prepared",
        nextState: "effectStarted",
        recoveryReason: null,
      });
    });
  }

  markContextValueReplayRequired(inputValue: Readonly<{
    operationId: string;
    expectedRevision: number;
    expectedState: "effectStarted";
  }>): Promise<ContextValueRecord> {
    return deferredResult(() => {
      const input = replayRequiredInputSchema.parse(inputValue);
      return this.#transition({
        ...input,
        nextState: "replayRequired",
        recoveryReason: null,
      });
    });
  }

  activateContextValue(inputValue: Readonly<{
    operationId: string;
    expectedRevision: number;
    expectedState: "effectStarted" | "replayRequired";
    manifestDigest: string;
  }>): Promise<ContextValueRecord> {
    return deferredResult(() => {
      const input = activateInputSchema.parse(inputValue);
      return this.#database.transaction(() => {
        const current = this.#requireByOperation(input.operationId);
        if (
          current.state === "active" &&
          current.revision === input.expectedRevision + 1 &&
          current.manifestDigest === input.manifestDigest
        ) return current;
        this.#assertExpected(current, input.expectedRevision, input.expectedState);
        if (current.manifestDigest !== input.manifestDigest) {
          conflict("context-value manifest identity changed before activation");
        }
        this.#assertLiveLineage(current);
        this.#assertNameAvailable(current, current.valueId);
        return this.#updateState({
          current,
          nextState: "active",
          recoveryReason: null,
          timestamp: this.#timestamp(),
        });
      })();
    });
  }

  markContextValueRecoveryRequired(inputValue: Readonly<{
    operationId: string;
    expectedRevision: number;
    expectedState: "prepared" | "effectStarted" | "replayRequired" | "active";
    reason: ContextValueRecoveryReason;
  }>): Promise<ContextValueRecord> {
    return deferredResult(() => {
      const input = recoveryInputSchema.parse(inputValue);
      return this.#database.transaction(() => {
        const current = this.#requireByOperation(input.operationId);
        if (
          current.state === "recoveryRequired" &&
          current.revision === input.expectedRevision + 1 &&
          current.recoveryReason === input.reason
        ) return current;
        this.#assertExpected(current, input.expectedRevision, input.expectedState);
        return this.#updateState({
          current,
          nextState: "recoveryRequired",
          recoveryReason: input.reason,
          timestamp: this.#timestamp(),
        });
      })();
    });
  }

  readContextValueOperation(
    operationIdValue: string,
  ): Promise<ContextValueRecord | null> {
    return deferredResult(() =>
      this.#readByOperation(operationIdSchema.parse(operationIdValue))
    );
  }

  readActiveContextValue(inputValue: Readonly<{
    epochId: string;
    ownerActorId: string;
    sourceTurnId: string | null;
    valueId: string;
  }>): Promise<ContextValueRecord | null> {
    return deferredResult(() => {
      const input = activeAddressSchema.parse(inputValue);
      const value: unknown = this.#database.query(`
        SELECT * FROM harness_context_values
        WHERE value_id = ?1 AND epoch_id = ?2 AND owner_actor_id = ?3
          AND source_turn_id IS ?4 AND state = 'active'
      `).get(
        input.valueId,
        input.epochId,
        input.ownerActorId,
        input.sourceTurnId,
      );
      return value === null ? null : this.#parse(value);
    });
  }

  listActiveContextValues(inputValue: Readonly<{
    epochId: string;
    afterValueId: string | null;
    limit: number;
  }>): Promise<readonly ContextValueRecord[]> {
    return deferredResult(() => {
      const input = activeListSchema.parse(inputValue);
      const rows: unknown[] = this.#database.query(`
        SELECT * FROM harness_context_values
        WHERE epoch_id = ?1 AND state = 'active'
          AND value_id > COALESCE(?2, '')
        ORDER BY value_id
        LIMIT ?3
      `).all(input.epochId, input.afterValueId, input.limit);
      return this.#parseOrdered(rows, input.afterValueId, "valueId");
    });
  }

  listRecoverableContextValues(inputValue: Readonly<{
    afterOperationId: string | null;
    limit: number;
  }>): Promise<readonly ContextValueRecord[]> {
    return deferredResult(() => {
      const input = recoveryListSchema.parse(inputValue);
      const rows: unknown[] = this.#database.query(`
        SELECT * FROM harness_context_values
        WHERE state != 'active' AND operation_id > COALESCE(?1, '')
        ORDER BY operation_id
        LIMIT ?2
      `).all(input.afterOperationId, input.limit);
      return this.#parseOrdered(rows, input.afterOperationId, "operationId");
    });
  }

  #transition(input: Readonly<{
    operationId: string;
    expectedRevision: number;
    expectedState: "prepared" | "effectStarted";
    nextState: "effectStarted" | "replayRequired";
    recoveryReason: null;
  }>): ContextValueRecord {
    return this.#database.transaction(() => {
      const current = this.#requireByOperation(input.operationId);
      if (
        current.state === input.nextState &&
        current.revision === input.expectedRevision + 1
      ) return current;
      this.#assertExpected(current, input.expectedRevision, input.expectedState);
      return this.#updateState({
        current,
        nextState: input.nextState,
        recoveryReason: null,
        timestamp: this.#timestamp(),
      });
    })();
  }

  #updateState(input: Readonly<{
    current: ContextValueRecord;
    nextState: "effectStarted" | "replayRequired" | "active" | "recoveryRequired";
    recoveryReason: ContextValueRecoveryReason | null;
    timestamp: string;
  }>): ContextValueRecord {
    const effectStartedAt = input.nextState === "effectStarted" ||
        input.current.state === "prepared"
      ? input.timestamp
      : null;
    const activatedAt = input.nextState === "active" ? input.timestamp : null;
    const changed = this.#database.query(`
      UPDATE harness_context_values SET
        state = ?4,
        recovery_reason = ?5,
        revision = revision + 1,
        updated_at = ?6,
        effect_started_at = COALESCE(effect_started_at, ?7),
        activated_at = ?8
      WHERE operation_id = ?1 AND revision = ?2 AND state = ?3
    `).run(
      input.current.operationId,
      input.current.revision,
      input.current.state,
      input.nextState,
      input.recoveryReason,
      input.timestamp,
      effectStartedAt,
      activatedAt,
    );
    if (changed.changes !== 1) revisionConflict();
    const next = this.#requireByOperation(input.current.operationId);
    if (
      next.revision !== input.current.revision + 1 ||
      next.state !== input.nextState ||
      next.recoveryReason !== input.recoveryReason ||
      !sameImmutable(next, input.current)
    ) corrupt("context-value CAS committed an incoherent transition");
    return next;
  }

  #assertExpected(
    current: ContextValueRecord,
    expectedRevision: number,
    expectedState: ContextValueRecord["state"],
  ): void {
    if (current.revision !== expectedRevision) revisionConflict();
    if (current.state !== expectedState) {
      conflict("context-value lifecycle transition is not permitted");
    }
  }

  #readByOperation(operationId: string): ContextValueRecord | null {
    const value: unknown = this.#database.query(`
      SELECT * FROM harness_context_values WHERE operation_id = ?1
    `).get(operationId);
    return value === null ? null : this.#parse(value);
  }

  #requireByOperation(operationId: string): ContextValueRecord {
    const value = this.#readByOperation(operationId);
    if (value === null) {
      throw new ContextValueSQLiteAdapterV2Error(
        "not_found",
        "context-value operation does not exist",
      );
    }
    return value;
  }

  #readCollisions(input: ContextValuePrepareInput): ContextValueRecord[] {
    const rows: unknown[] = this.#database.query(`
      SELECT * FROM harness_context_values
      WHERE operation_id = ?1 OR value_id = ?2
      ORDER BY value_id
    `).all(input.operationId, input.valueId);
    return rows.map((row) => this.#parse(row));
  }

  #assertLiveLineage(input: Readonly<{
    epochId: string;
    ownerActorId: string;
    sourceTurnId: string | null;
  }>): void {
    const value: unknown = input.sourceTurnId === null
      ? this.#database.query(`
          SELECT 1 AS coherent
          FROM harness_actor_epochs AS epoch
          JOIN harness_actors AS actor
            ON actor.actor_id = ?2 AND actor.epoch_id = epoch.epoch_id
          WHERE epoch.epoch_id = ?1
            AND epoch.state = 'active' AND actor.state = 'active'
        `).get(input.epochId, input.ownerActorId)
      : this.#database.query(`
          SELECT 1 AS coherent
          FROM harness_actor_epochs AS epoch
          JOIN harness_actors AS actor
            ON actor.actor_id = ?2 AND actor.epoch_id = epoch.epoch_id
          JOIN harness_actor_turns AS turn
            ON turn.turn_id = ?3 AND turn.epoch_id = epoch.epoch_id
            AND turn.actor_id = actor.actor_id
          WHERE epoch.epoch_id = ?1
            AND epoch.state = 'active' AND actor.state = 'active'
        `).get(input.epochId, input.ownerActorId, input.sourceTurnId);
    if (!z.object({ coherent: z.literal(1) }).strict().safeParse(value).success) {
      conflict("context-value owner is not one live actor lineage");
    }
  }

  #assertNameAvailable(
    input: Pick<ContextValuePrepareInput,
      "epochId" | "ownerActorId" | "nameDigest"
    >,
    exceptValueId: string | null = null,
  ): void {
    if (input.nameDigest === null) return;
    const value: unknown = this.#database.query(`
      SELECT value_id FROM harness_context_values
      WHERE epoch_id = ?1 AND owner_actor_id = ?2 AND name_digest = ?3
        AND value_id != COALESCE(?4, '')
      LIMIT 1
    `).get(
      input.epochId,
      input.ownerActorId,
      input.nameDigest,
      exceptValueId,
    );
    if (value !== null) {
      conflict("context-value name is already reserved by this actor");
    }
  }

  #reserveQuota(input: ContextValuePrepareInput): void {
    const value: unknown = this.#database.query(`
      SELECT settings.context_quota_bytes,
        COALESCE(SUM(value.utf8_bytes), 0) AS total_used_bytes,
        COALESCE(SUM(CASE WHEN value.purpose IN (
          'heap', 'agentResult', 'proposal', 'programSource', 'programResult'
        ) THEN value.utf8_bytes ELSE 0 END), 0) AS epoch_work_used_bytes,
        COALESCE(SUM(CASE WHEN value.owner_actor_id = ?2
          AND value.purpose IN (
            'heap', 'agentResult', 'proposal', 'programSource', 'programResult'
          ) THEN value.utf8_bytes ELSE 0 END), 0) AS owner_work_used_bytes,
        epoch.byte_budget AS epoch_byte_budget,
        actor.byte_budget AS owner_byte_budget,
        actor.byte_reserved AS owner_byte_reserved
      FROM harness_actor_epochs AS epoch
      JOIN harness_settings AS settings ON settings.singleton = 1
      JOIN harness_actors AS actor
        ON actor.actor_id = ?2 AND actor.epoch_id = epoch.epoch_id
      LEFT JOIN harness_context_values AS value
        ON value.epoch_id = epoch.epoch_id
      WHERE epoch.epoch_id = ?1 AND epoch.state = 'active'
        AND actor.state = 'active'
      GROUP BY settings.context_quota_bytes, epoch.byte_budget,
        actor.byte_budget, actor.byte_reserved
    `).get(input.epochId, input.ownerActorId);
    let quota: z.infer<typeof quotaRowSchema>;
    try {
      quota = quotaRowSchema.parse(value);
    } catch (cause: unknown) {
      throw new ContextValueSQLiteAdapterV2Error(
        "corrupt_state",
        "context-value quota authority is unavailable",
        cause,
      );
    }
    if (
      input.quotaLimitBytes > quota.context_quota_bytes ||
      quota.total_used_bytes > Number.MAX_SAFE_INTEGER - input.utf8Bytes ||
      quota.total_used_bytes + input.utf8Bytes > quota.context_quota_bytes
    ) throw new ContextValueQuotaExceededError();
    if (!workPurposes.includes(input.purpose as typeof workPurposes[number])) {
      return;
    }
    const ownerAvailableBytes = quota.owner_byte_budget -
      quota.owner_byte_reserved;
    const ownerLimit = Math.min(input.quotaLimitBytes, ownerAvailableBytes);
    if (
      ownerAvailableBytes < 0 ||
      quota.epoch_work_used_bytes > Number.MAX_SAFE_INTEGER - input.utf8Bytes ||
      quota.owner_work_used_bytes > Number.MAX_SAFE_INTEGER - input.utf8Bytes ||
      quota.epoch_work_used_bytes + input.utf8Bytes > quota.epoch_byte_budget ||
      quota.owner_work_used_bytes + input.utf8Bytes > ownerLimit
    ) throw new ContextValueQuotaExceededError();
  }

  #parse(value: unknown): ContextValueRecord {
    let row: z.infer<typeof rowSchema>;
    try {
      row = rowSchema.parse(value);
    } catch (cause: unknown) {
      throw new ContextValueSQLiteAdapterV2Error(
        "corrupt_state",
        "stored context-value metadata is invalid",
        cause,
      );
    }
    const chunkRows: unknown[] = this.#database.query(`
      SELECT value_id, ordinal, plaintext_bytes, object_digest,
        object_byte_length
      FROM harness_context_value_chunks
      WHERE value_id = ?1
      ORDER BY ordinal
    `).all(row.value_id);
    let chunks: ContextValueRecord["chunks"];
    try {
      chunks = chunkRows.map((chunkValue) => {
        const chunk = chunkRowSchema.parse(chunkValue);
        if (chunk.value_id !== row.value_id) {
          throw new Error("chunk owner changed during projection");
        }
        return contextValueChunkMetadataSchema.parse({
          ordinal: chunk.ordinal,
          plaintextBytes: chunk.plaintext_bytes,
          objectDigest: chunk.object_digest,
          objectByteLength: chunk.object_byte_length,
        });
      });
    } catch (cause: unknown) {
      throw new ContextValueSQLiteAdapterV2Error(
        "corrupt_state",
        "stored context-value chunk metadata is invalid",
        cause,
      );
    }
    const projected: unknown = {
      version: 2,
      operationId: row.operation_id,
      epochId: row.epoch_id,
      ownerActorId: row.owner_actor_id,
      sourceTurnId: row.source_turn_id,
      valueId: row.value_id,
      kind: row.kind,
      purpose: row.purpose,
      schemaVersion: row.schema_version,
      nameDigest: row.name_digest,
      utf8Bytes: row.utf8_bytes,
      contentDigest: row.content_digest,
      chunkSize: row.chunk_size,
      chunkCount: row.chunk_count,
      chunks,
      manifestDigest: row.manifest_digest,
      manifestByteLength: row.manifest_byte_length,
      quotaLimitBytes: row.quota_limit_bytes,
      state: row.state,
      recoveryReason: row.recovery_reason,
      revision: row.revision,
    };
    let record: ContextValueRecord;
    try {
      record = contextValueLifecycleRecordSchema.parse(projected);
    } catch (cause: unknown) {
      throw new ContextValueSQLiteAdapterV2Error(
        "corrupt_state",
        "stored context-value record is incoherent",
        cause,
      );
    }
    if (
      Date.parse(row.updated_at) < Date.parse(row.created_at) ||
      ((record.state === "prepared") !== (row.effect_started_at === null)) ||
      ((record.state === "active") !== (row.activated_at !== null))
    ) corrupt("stored context-value timestamps are incoherent");
    return Object.freeze(record);
  }

  #parseOrdered(
    rows: readonly unknown[],
    after: string | null,
    key: "valueId" | "operationId",
  ): readonly ContextValueRecord[] {
    const records = rows.map((row) => this.#parse(row));
    let previous = after;
    for (const record of records) {
      if (previous !== null && record[key] <= previous) {
        corrupt("context-value scan is not strictly ordered");
      }
      previous = record[key];
    }
    return Object.freeze(records);
  }

  #timestamp(): string {
    return timestampSchema.parse(this.#now().toISOString());
  }
}

function immutableMetadata(
  value: ContextValueRecord | ContextValuePrepareInput,
): ContextValuePrepareInput {
  return {
    version: value.version,
    operationId: value.operationId,
    epochId: value.epochId,
    ownerActorId: value.ownerActorId,
    sourceTurnId: value.sourceTurnId,
    valueId: value.valueId,
    kind: value.kind,
    purpose: value.purpose,
    schemaVersion: value.schemaVersion,
    nameDigest: value.nameDigest,
    utf8Bytes: value.utf8Bytes,
    contentDigest: value.contentDigest,
    chunkSize: value.chunkSize,
    chunkCount: value.chunkCount,
    chunks: value.chunks,
    manifestDigest: value.manifestDigest,
    manifestByteLength: value.manifestByteLength,
    quotaLimitBytes: value.quotaLimitBytes,
  };
}

function sameImmutable(
  left: ContextValueRecord | ContextValuePrepareInput,
  right: ContextValueRecord | ContextValuePrepareInput,
): boolean {
  return JSON.stringify(immutableMetadata(left)) ===
    JSON.stringify(immutableMetadata(right));
}

function deferredResult<T>(operation: () => T): Promise<T> {
  return Promise.resolve().then(operation);
}

function conflict(message: string): never {
  throw new ContextValueSQLiteAdapterV2Error("conflict", message);
}

function corrupt(message: string): never {
  throw new ContextValueSQLiteAdapterV2Error("corrupt_state", message);
}

function revisionConflict(): never {
  throw new ContextValueSQLiteAdapterV2Error(
    "revision_conflict",
    "context-value revision changed",
  );
}
