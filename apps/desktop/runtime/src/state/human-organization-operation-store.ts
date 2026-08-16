import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import {
  createUuidV7,
  organizationViewSchema,
  uuidV7Schema,
  type OrganizationView,
} from "@hraness/agent-tasks-protocol";
import { z } from "@hra-internal/schema";

import type { HumanAccountSafeError } from "../cloud/human-account-service";

const safeErrorCodeSchema = z.enum([
  "AUTHENTICATION_FAILED",
  "AUTH_REFRESH_INDETERMINATE",
  "CONFIGURATION_UNAVAILABLE",
  "CREDENTIAL_RECOVERY_REQUIRED",
  "NOT_FOUND",
  "PROVISIONING_FAILED",
  "PROVISIONING_IN_PROGRESS",
  "SERVICE_UNAVAILABLE",
  "SIGNED_OUT",
  "VALIDATION_ERROR",
]);

const outcomeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), organization: organizationViewSchema }).strict(),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: safeErrorCodeSchema,
      message: z.string().min(1).max(240),
      retryable: z.boolean(),
    }).strict(),
  }).strict(),
]);

const rowSchema = z.object({
  operation_id: z.string().min(1),
  name: z.string().min(1).max(160),
  http_idempotency_key: uuidV7Schema,
  state: z.enum(["started", "succeeded", "failed"]),
  response_json: z.string().nullable(),
}).strict();

const startedRowSchema = rowSchema.extend({
  created_at: z.number().int().nonnegative().safe(),
}).strict();

const startedCursorSchema = z.object({
  createdAt: z.number().int().nonnegative().safe(),
  operationId: z.string().min(1).max(256),
}).strict();

export type HumanOrganizationOperationCursor = z.infer<
  typeof startedCursorSchema
>;

export type HumanOrganizationOperation =
  | Readonly<{
      state: "started";
      operationId: string;
      name: string;
      idempotencyKey: z.infer<typeof uuidV7Schema>;
    }>
  | Readonly<{
      state: "recorded";
      operationId: string;
      outcome: z.infer<typeof outcomeSchema>;
    }>;

export class HumanOrganizationOperationConflict extends Error {
  constructor() {
    super("Organization operation ID was already used for another name.");
    this.name = "HumanOrganizationOperationConflict";
  }
}

export class HumanOrganizationOperationStore {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  begin(input: {
    readonly operationId: string;
    readonly name: string;
    readonly now?: number;
  }): HumanOrganizationOperation {
    const now = input.now ?? Date.now();
    return this.#database.transaction(
      (): HumanOrganizationOperation => {
        const existing = this.#read(input.operationId);
        if (existing !== null) {
          if (existing.name !== input.name) {
            throw new HumanOrganizationOperationConflict();
          }
          return operationFromRow(existing);
        }
        const sameName: unknown = this.#database.query(`
          SELECT operation_id, name, http_idempotency_key, state, response_json
          FROM human_organization_operations
          WHERE state = 'started' AND name = ?1
          ORDER BY created_at ASC
          LIMIT 1
        `).get(input.name);
        const shared = rowSchema.nullable().parse(sameName);
        if (shared !== null) {
          this.#insertAlias(input.operationId, shared.operation_id, now);
          return operationFromRow(shared);
        }
        const idempotencyKey = createUuidV7(now, randomBytes(10));
        this.#database.query(`
          INSERT INTO human_organization_operations(
            operation_id, name, http_idempotency_key, state,
            created_at, updated_at
          ) VALUES (?1, ?2, ?3, 'started', ?4, ?4)
        `).run(input.operationId, input.name, idempotencyKey, now);
        this.#insertAlias(input.operationId, input.operationId, now);
        return {
          state: "started",
          operationId: input.operationId,
          name: input.name,
          idempotencyKey,
        };
      },
    ).immediate();
  }

  started(limit = 100): readonly Extract<
    HumanOrganizationOperation,
    { readonly state: "started" }
  >[] {
    const values: unknown[] = this.#database.query(`
      SELECT operation_id, name, http_idempotency_key, state, response_json
      FROM human_organization_operations
      WHERE state = 'started'
      ORDER BY created_at ASC
      LIMIT ?1
    `).all(limit);
    return values.map((value) => {
      const operation = operationFromRow(rowSchema.parse(value));
      if (operation.state !== "started") {
        throw new Error("Started organization query returned a terminal row.");
      }
      return operation;
    });
  }

  startedById(operationId: string): Extract<
    HumanOrganizationOperation,
    { readonly state: "started" }
  > | null {
    const row = this.#read(operationId);
    if (row === null || row.state !== "started") return null;
    const operation = operationFromRow(row);
    if (operation.state !== "started") {
      throw new Error("Started organization lookup returned a terminal row.");
    }
    return operation;
  }

  startedPage(inputValue: {
    readonly after?: HumanOrganizationOperationCursor | undefined;
    readonly limit?: number | undefined;
  } = {}): Readonly<{
    operations: readonly Extract<
      HumanOrganizationOperation,
      { readonly state: "started" }
    >[];
    nextCursor: HumanOrganizationOperationCursor | null;
  }> {
    const input = z.object({
      after: startedCursorSchema.optional(),
      limit: z.number().int().min(1).max(100).default(100),
    }).strict().parse(inputValue);
    const after = input.after ?? null;
    const values: unknown[] = this.#database.query(`
      SELECT operation_id, name, http_idempotency_key, state, response_json,
        created_at
      FROM human_organization_operations
      WHERE state = 'started'
        AND (
          ?1 IS NULL
          OR created_at > ?1
          OR (created_at = ?1 AND operation_id > ?2)
        )
      ORDER BY created_at ASC, operation_id ASC
      LIMIT ?3
    `).all(
      after?.createdAt ?? null,
      after?.operationId ?? null,
      input.limit + 1,
    );
    const rows = values.map((value) => startedRowSchema.parse(value));
    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const last = pageRows.at(-1);
    return {
      operations: pageRows.map((row) => {
        const operation = operationFromRow(row);
        if (operation.state !== "started") {
          throw new Error("Started organization page returned a terminal row.");
        }
        return operation;
      }),
      nextCursor: hasMore && last !== undefined
        ? { createdAt: last.created_at, operationId: last.operation_id }
        : null,
    };
  }

  complete(
    operationId: string,
    outcomeValue:
      | Readonly<{ ok: true; organization: OrganizationView }>
      | Readonly<{ ok: false; error: HumanAccountSafeError }>,
    now = Date.now(),
  ): void {
    const outcome = outcomeSchema.parse(outcomeValue);
    const serialized = JSON.stringify(outcome);
    const state = outcome.ok ? "succeeded" : "failed";
    const updated = this.#database.query(`
      UPDATE human_organization_operations
      SET state = ?2, response_json = ?3, updated_at = ?4, completed_at = ?4
      WHERE operation_id = ?1 AND state = 'started'
    `).run(operationId, state, serialized, now);
    if (updated.changes === 1) return;
    const existing = this.#read(operationId);
    if (
      existing === null ||
      existing.state !== state ||
      existing.response_json !== serialized
    ) {
      throw new Error("Organization operation cannot accept this outcome.");
    }
  }

  #read(operationId: string): z.infer<typeof rowSchema> | null {
    const value: unknown = this.#database.query(`
      SELECT canonical.operation_id, canonical.name,
        canonical.http_idempotency_key, canonical.state,
        canonical.response_json
      FROM human_organization_operation_aliases AS alias
      JOIN human_organization_operations AS canonical
        ON canonical.operation_id = alias.canonical_operation_id
      WHERE alias.operation_id = ?1
    `).get(operationId);
    return rowSchema.nullable().parse(value);
  }

  #insertAlias(
    operationId: string,
    canonicalOperationId: string,
    now: number,
  ): void {
    this.#database.query(`
      INSERT INTO human_organization_operation_aliases(
        operation_id, canonical_operation_id, created_at
      ) VALUES (?1, ?2, ?3)
    `).run(operationId, canonicalOperationId, now);
  }
}

function operationFromRow(
  row: z.infer<typeof rowSchema>,
): HumanOrganizationOperation {
  if (row.state === "started") {
    return {
      state: "started",
      operationId: row.operation_id,
      name: row.name,
      idempotencyKey: row.http_idempotency_key,
    };
  }
  if (row.response_json === null) {
    throw new Error("Terminal organization operation is missing its response.");
  }
  return {
    state: "recorded",
    operationId: row.operation_id,
    outcome: outcomeSchema.parse(JSON.parse(row.response_json) as unknown),
  };
}
