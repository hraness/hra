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
} from "./domain";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const timestampSchema = z.string().length(24).datetime().refine(
  (value) => new Date(Date.parse(value)).toISOString() === value,
  "timestamp must use canonical UTC milliseconds",
);

export const contextSnapshotRecordV2Schema = z.object({
  id: contextSnapshotIdSchema,
  epochId: actorEpochIdSchema,
  actorId: actorIdSchema,
  completedThroughTurnId: actorTurnIdSchema.nullable(),
  coverageWitnessDigest: digestSchema,
  valueId: contextValueIdSchema,
  createdAt: timestampSchema,
  expiresAt: timestampSchema.nullable(),
}).strict().superRefine((snapshot, context) => {
  if (
    snapshot.expiresAt !== null &&
    Date.parse(snapshot.expiresAt) <= Date.parse(snapshot.createdAt)
  ) {
    context.addIssue({
      code: "custom",
      message: "context snapshot expiry must follow creation",
      path: ["expiresAt"],
    });
  }
});

export type ContextSnapshotRecordV2 = z.infer<
  typeof contextSnapshotRecordV2Schema
>;

const rowSchema = z.object({
  snapshot_id: contextSnapshotIdSchema,
  epoch_id: actorEpochIdSchema,
  actor_id: actorIdSchema,
  completed_through_turn_id: actorTurnIdSchema.nullable(),
  coverage_witness_digest: digestSchema,
  value_id: contextValueIdSchema,
  created_at: timestampSchema,
  expires_at: timestampSchema.nullable(),
}).strict();

const listInputSchema = z.object({
  actorId: actorIdSchema,
  afterSnapshotId: contextSnapshotIdSchema.nullable().default(null),
  limit: z.number().int().min(1).max(128),
}).strict();

export class ContextSnapshotAuthorityV2Error extends Error {
  readonly code: "conflict" | "corrupt_state" | "not_found";

  constructor(
    code: ContextSnapshotAuthorityV2Error["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ContextSnapshotAuthorityV2Error";
    this.code = code;
  }
}

/**
 * Content-free authority for an encrypted, completed-prefix-only transcript.
 * The plaintext and provider generation never enter SQLite. Callers must
 * prove complete coverage before creating this record; the immutable witness
 * digest binds that proof to the encrypted value.
 */
export class ContextSnapshotAuthorityV2 {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  create(inputValue: unknown): ContextSnapshotRecordV2 {
    const input = contextSnapshotRecordV2Schema.parse(inputValue);
    return this.#database.transaction(() => {
      const byId = this.#read(input.id);
      const byValue = this.#readByValueId(input.valueId);
      if (byId !== null || byValue !== null) {
        if (
          byId !== null &&
          byValue !== null &&
          byId.id === byValue.id &&
          exactJson(byId) === exactJson(input)
        ) return byId;
        throw new ContextSnapshotAuthorityV2Error(
          "conflict",
          "context snapshot identity already names different evidence",
        );
      }
      try {
        this.#database.query(`
          INSERT INTO harness_context_snapshots (
            snapshot_id, epoch_id, actor_id, completed_through_turn_id,
            coverage_witness_digest, value_id, created_at, expires_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        `).run(
          input.id,
          input.epochId,
          input.actorId,
          input.completedThroughTurnId,
          input.coverageWitnessDigest,
          input.valueId,
          input.createdAt,
          input.expiresAt,
        );
      } catch (cause: unknown) {
        throw new ContextSnapshotAuthorityV2Error(
          "conflict",
          "context snapshot lineage or identity conflicts",
          cause,
        );
      }
      return this.#require(input.id);
    })();
  }

  read(snapshotIdValue: string): ContextSnapshotRecordV2 | null {
    return this.#read(contextSnapshotIdSchema.parse(snapshotIdValue));
  }

  listForActor(inputValue: Readonly<{
    actorId: string;
    afterSnapshotId?: string | null;
    limit: number;
  }>): readonly ContextSnapshotRecordV2[] {
    const input = listInputSchema.parse(inputValue);
    const rows: unknown[] = this.#database.query(`
      SELECT * FROM harness_context_snapshots
      WHERE actor_id = ?1 AND snapshot_id > COALESCE(?2, '')
      ORDER BY snapshot_id
      LIMIT ?3
    `).all(input.actorId, input.afterSnapshotId, input.limit);
    const snapshots = rows.map(parseRow);
    let previous = input.afterSnapshotId;
    for (const snapshot of snapshots) {
      if (previous !== null && snapshot.id <= previous) {
        throw new ContextSnapshotAuthorityV2Error(
          "corrupt_state",
          "context snapshot page is duplicated or out of order",
        );
      }
      previous = snapshot.id;
    }
    return Object.freeze(snapshots);
  }

  #read(snapshotId: string): ContextSnapshotRecordV2 | null {
    const value: unknown = this.#database.query(
      "SELECT * FROM harness_context_snapshots WHERE snapshot_id = ?1",
    ).get(snapshotId);
    return value === null ? null : parseRow(value);
  }

  #readByValueId(valueId: string): ContextSnapshotRecordV2 | null {
    const value: unknown = this.#database.query(
      "SELECT * FROM harness_context_snapshots WHERE value_id = ?1",
    ).get(valueId);
    return value === null ? null : parseRow(value);
  }

  #require(snapshotId: string): ContextSnapshotRecordV2 {
    const snapshot = this.#read(snapshotId);
    if (snapshot === null) {
      throw new ContextSnapshotAuthorityV2Error(
        "not_found",
        "context snapshot does not exist",
      );
    }
    return snapshot;
  }
}

function parseRow(value: unknown): ContextSnapshotRecordV2 {
  try {
    const row = rowSchema.parse(value);
    return contextSnapshotRecordV2Schema.parse({
      id: row.snapshot_id,
      epochId: row.epoch_id,
      actorId: row.actor_id,
      completedThroughTurnId: row.completed_through_turn_id,
      coverageWitnessDigest: row.coverage_witness_digest,
      valueId: row.value_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    });
  } catch (cause: unknown) {
    throw new ContextSnapshotAuthorityV2Error(
      "corrupt_state",
      "stored context snapshot is invalid",
      cause,
    );
  }
}

function exactJson(value: unknown): string {
  return JSON.stringify(value);
}
