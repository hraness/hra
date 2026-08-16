import {
  MAX_RUN_INTERACTION_SETTLEMENTS,
  MAX_RUN_INTERACTION_UPSERTS,
  runInteractionRequestSchema,
  type RunInteractionRequest,
  type RunInteractionSettlement,
} from "@hraness/agent-tasks-protocol";
import { z } from "@hra-internal/schema";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

const interactionRowSchema = z.object({
  interaction_id: z.string(),
  run_id: z.string(),
  request_json: z.string(),
  request_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  state: z.enum(["pending", "applied", "expired"]),
  response_revision: z.number().int().positive().nullable(),
  published_at: z.number().int().nonnegative().nullable(),
  settlement_reason: z.enum(["local_deadline", "provider_expired", "cloud_expired"]).nullable(),
  created_at: z.number().int().nonnegative(),
  expires_at: z.number().int().positive(),
  updated_at: z.number().int().nonnegative(),
}).strict();

export interface PendingDispatchInteraction {
  readonly runId: string;
  readonly request: RunInteractionRequest;
}

export interface DispatchInteractionSyncBatch {
  readonly upserts: readonly RunInteractionRequest[];
  readonly settlements: readonly RunInteractionSettlement[];
}

export class DispatchInteractionConflict extends Error {
  constructor() {
    super("Dispatch interaction conflicts with durable local state");
    this.name = "DispatchInteractionConflict";
  }
}

/** Persists provider-declared non-secret request text and settlement metadata, never answers. */
export class DispatchInteractionStore {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  upsert(runId: string, request: RunInteractionRequest, now = Date.now()): void {
    const parsed = runInteractionRequestSchema.parse(request);
    const encoded = JSON.stringify(parsed);
    const digest = createHash("sha256").update(encoded).digest("hex");
    const existing = this.#readRow(parsed.id);
    if (existing !== null) {
      if (existing.run_id !== runId || existing.request_digest !== digest) {
        throw new DispatchInteractionConflict();
      }
      return;
    }
    this.#database.query(`
      INSERT INTO dispatch_interactions (
        interaction_id, run_id, request_json, request_digest, state,
        created_at, expires_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7)
    `).run(parsed.id, runId, encoded, digest, parsed.createdAt, parsed.expiresAt, now);
  }

  pending(interactionId: string): PendingDispatchInteraction | null {
    const row = this.#readRow(interactionId);
    if (row === null || row.state !== "pending") return null;
    return { runId: row.run_id, request: parseStoredRequest(row) };
  }

  settlement(interactionId: string): RunInteractionSettlement | null {
    const row = this.#readRow(interactionId);
    if (row === null || row.state === "pending") return null;
    return settlementFromRow(row);
  }

  syncBatch(runId: string): DispatchInteractionSyncBatch {
    const upsertValues: unknown[] = this.#database.query(`
      SELECT interaction_id, run_id, request_json, request_digest, state,
        response_revision, published_at, settlement_reason, created_at, expires_at, updated_at
      FROM dispatch_interactions
      WHERE run_id = ?1 AND published_at IS NULL
      ORDER BY created_at, interaction_id
      LIMIT ?2
    `).all(runId, MAX_RUN_INTERACTION_UPSERTS);
    const settlementValues: unknown[] = this.#database.query(`
      SELECT interaction_id, run_id, request_json, request_digest, state,
        response_revision, published_at, settlement_reason, created_at, expires_at, updated_at
      FROM dispatch_interactions
      WHERE run_id = ?1 AND state IN ('applied', 'expired') AND published_at IS NOT NULL
      ORDER BY updated_at, interaction_id
      LIMIT ?2
    `).all(runId, MAX_RUN_INTERACTION_SETTLEMENTS);
    const upserts = upsertValues.map((value) => parseStoredRequest(interactionRowSchema.parse(value)));
    const settlements = settlementValues.map((value) =>
      settlementFromRow(interactionRowSchema.parse(value)));
    return { upserts, settlements };
  }

  pendingRunIds(): readonly string[] {
    const values: unknown[] = this.#database.query(`
      SELECT DISTINCT run_id
      FROM dispatch_interactions
      ORDER BY run_id
    `).all();
    return z.array(z.object({ run_id: z.string() }).strict()).parse(values)
      .map(({ run_id }) => run_id);
  }

  nextRunId(currentRunIds: readonly string[]): string | undefined {
    const current = new Set(currentRunIds);
    const candidates = this.pendingRunIds().filter((runId) => current.has(runId));
    if (candidates.length === 0) return undefined;
    const cursorValue: unknown = this.#database.query(`
      SELECT last_run_id FROM dispatch_interaction_sync_state WHERE singleton = 1
    `).get();
    const cursor = cursorValue === null
      ? null
      : z.object({ last_run_id: z.string() }).strict().parse(cursorValue).last_run_id;
    const selected = candidates.find((runId) => cursor === null || runId > cursor) ?? candidates[0];
    if (selected === undefined) return undefined;
    this.#database.query(`
      INSERT INTO dispatch_interaction_sync_state (singleton, last_run_id)
      VALUES (1, ?1)
      ON CONFLICT(singleton) DO UPDATE SET last_run_id = excluded.last_run_id
    `).run(selected);
    return selected;
  }

  markPublished(interactionIds: readonly string[], now = Date.now()): number {
    let updated = 0;
    this.#database.transaction(() => {
      for (const interactionId of new Set(interactionIds)) {
        updated += this.#database.query(`
          UPDATE dispatch_interactions
          SET published_at = COALESCE(published_at, ?2), updated_at = MAX(updated_at, ?2)
          WHERE interaction_id = ?1
        `).run(interactionId, now).changes;
      }
    })();
    return updated;
  }

  settle(
    interactionId: string,
    responseRevision: number | undefined,
    outcome: "applied" | "expired",
    reason?: "local_deadline" | "provider_expired" | "cloud_expired",
    now = Date.now(),
  ): void {
    if (
      (outcome === "applied" && (responseRevision === undefined || reason !== undefined)) ||
      (outcome === "expired" && reason === undefined) ||
      (responseRevision !== undefined &&
        (!Number.isSafeInteger(responseRevision) || responseRevision <= 0))
    ) {
      throw new DispatchInteractionConflict();
    }
    const row = this.#readRow(interactionId);
    if (row === null) return;
    if (row.state !== "pending") {
      if (
        row.state !== outcome ||
        row.response_revision !== (responseRevision ?? null) ||
        row.settlement_reason !== (reason ?? null)
      ) {
        throw new DispatchInteractionConflict();
      }
      return;
    }
    const result = this.#database.query(`
      UPDATE dispatch_interactions
      SET state = ?2, response_revision = ?3, settlement_reason = ?4, updated_at = ?5
      WHERE interaction_id = ?1 AND state = 'pending'
    `).run(interactionId, outcome, responseRevision ?? null, reason ?? null, now);
    if (result.changes !== 1) throw new DispatchInteractionConflict();
  }

  acknowledgeSettlements(interactionIds: readonly string[]): number {
    let removed = 0;
    this.#database.transaction(() => {
      for (const interactionId of new Set(interactionIds)) {
        removed += this.#database.query(`
          DELETE FROM dispatch_interactions
          WHERE interaction_id = ?1 AND state IN ('applied', 'expired')
        `).run(interactionId).changes;
      }
    })();
    return removed;
  }

  deleteRun(runId: string): number {
    return this.#database.query(`
      DELETE FROM dispatch_interactions
      WHERE run_id = ?1
    `).run(runId).changes;
  }

  #readRow(interactionId: string): z.infer<typeof interactionRowSchema> | null {
    const value: unknown = this.#database.query(`
      SELECT interaction_id, run_id, request_json, request_digest, state,
        response_revision, published_at, settlement_reason, created_at, expires_at, updated_at
      FROM dispatch_interactions
      WHERE interaction_id = ?1
    `).get(interactionId);
    return value === null ? null : interactionRowSchema.parse(value);
  }
}

function requiredSettlementReason(
  row: z.infer<typeof interactionRowSchema>,
): "local_deadline" | "provider_expired" | "cloud_expired" {
  if (row.settlement_reason === null) throw new DispatchInteractionConflict();
  return row.settlement_reason;
}

function settlementFromRow(
  row: z.infer<typeof interactionRowSchema>,
): RunInteractionSettlement {
  if (row.state === "pending" || (row.state === "applied" && row.response_revision === null)) {
    throw new DispatchInteractionConflict();
  }
  if (row.state === "applied") {
    if (row.response_revision === null) throw new DispatchInteractionConflict();
    return {
      interactionId: row.interaction_id,
      outcome: "applied",
      responseRevision: row.response_revision,
    };
  }
  return row.response_revision === null
    ? {
        interactionId: row.interaction_id,
        outcome: "expired",
        reason: requiredSettlementReason(row),
      }
    : {
        interactionId: row.interaction_id,
        outcome: "expired",
        responseRevision: row.response_revision,
        reason: requiredSettlementReason(row),
      };
}

function parseStoredRequest(
  row: z.infer<typeof interactionRowSchema>,
): RunInteractionRequest {
  let value: unknown;
  try {
    value = JSON.parse(row.request_json) as unknown;
  } catch {
    throw new DispatchInteractionConflict();
  }
  const request = runInteractionRequestSchema.parse(value);
  const digest = createHash("sha256").update(JSON.stringify(request)).digest("hex");
  if (
    request.id !== row.interaction_id ||
    request.createdAt !== row.created_at ||
    request.expiresAt !== row.expires_at ||
    digest !== row.request_digest
  ) {
    throw new DispatchInteractionConflict();
  }
  return request;
}
