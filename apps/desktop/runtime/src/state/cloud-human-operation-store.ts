import type { Database } from "bun:sqlite";
import { createHmac, randomBytes } from "node:crypto";
import {
  createUuidV7,
  taskWorkspaceMutationResultSchema,
  uuidV7Schema,
} from "@hraness/agent-tasks-protocol";
import { z } from "@hra-internal/schema";

import {
  runtimeErrorSchema,
  runtimeRendererTaskMutationIntentSchema,
  type RuntimeError,
  type RuntimeTaskMutation,
  type RuntimeTaskMutationResult,
} from "../../../contracts/runtime";
import { operationReceiptKeyByteLength } from "./operation-receipt-key";

const storedOutcomeSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      mutation: taskWorkspaceMutationResultSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: runtimeErrorSchema,
    })
    .strict(),
]);

const receiptRowSchema = z
  .object({
    workspace_id: z.string().min(1),
    command_kind: z.string().min(1),
    keyed_command_digest: z.string().regex(/^[a-f0-9]{64}$/u),
    http_idempotency_key: uuidV7Schema,
    state: z.enum(["started", "succeeded", "failed", "ambiguous"]),
    response_json: z.string().nullable(),
  })
  .strict();

export type CloudHumanOperationReceipt =
  | Readonly<{
      state: "pending";
      idempotencyKey: z.infer<typeof uuidV7Schema>;
    }>
  | Readonly<{
      state: "recorded";
      outcome: z.infer<typeof storedOutcomeSchema>;
    }>
  | Readonly<{ state: "ambiguous" }>;

export class CloudHumanOperationConflict extends Error {
  constructor() {
    super("Cloud operation ID was already used for another command.");
    this.name = "CloudHumanOperationConflict";
  }
}

/**
 * Durable bridge between portable operation IDs and HTTP idempotency keys.
 * A crash while `started` remains replayable: the same immutable command is
 * retried with the same UUIDv7, so an accepted cloud write cannot duplicate.
 */
export class CloudHumanOperationStore {
  readonly #database: Database;
  readonly #fingerprintKey: Uint8Array;

  constructor(database: Database, fingerprintKey: Uint8Array) {
    if (fingerprintKey.byteLength !== operationReceiptKeyByteLength) {
      throw new Error("Cloud operation fingerprint key has an invalid length.");
    }
    this.#database = database;
    this.#fingerprintKey = Uint8Array.from(fingerprintKey);
  }

  begin(inputValue: {
    readonly workspaceId: string;
    readonly intent: RuntimeTaskMutation;
    readonly now?: number;
  }): CloudHumanOperationReceipt {
    const intent = runtimeRendererTaskMutationIntentSchema.parse(
      inputValue.intent,
    );
    const workspaceId = inputValue.workspaceId;
    const now = inputValue.now ?? Date.now();
    if (
      workspaceId.length < 1 ||
      !Number.isSafeInteger(now) ||
      now < 0
    ) {
      throw new TypeError("Cloud operation identity is invalid.");
    }
    const digest = this.#fingerprint({ workspaceId, intent });
    return this.#database.transaction(
      (): CloudHumanOperationReceipt => {
      const existing = this.#read(intent.operationId);
      if (existing !== null) {
        if (
          existing.workspace_id !== workspaceId ||
          existing.command_kind !== intent.kind ||
          existing.keyed_command_digest !== digest
        ) {
          throw new CloudHumanOperationConflict();
        }
        if (existing.state === "ambiguous") return { state: "ambiguous" };
        if (existing.state === "succeeded" || existing.state === "failed") {
          if (existing.response_json === null) {
            throw new Error("Completed cloud operation is missing its response.");
          }
          return {
            state: "recorded",
            outcome: storedOutcomeSchema.parse(
              JSON.parse(existing.response_json) as unknown,
            ),
          };
        }
        return {
          state: "pending",
          idempotencyKey: existing.http_idempotency_key,
        };
      }
      const idempotencyKey = createUuidV7(now, randomBytes(10));
      this.#database.query(`
        INSERT INTO cloud_human_operation_receipts(
          operation_id, workspace_id, command_kind, keyed_command_digest,
          http_idempotency_key, state, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, 'started', ?6, ?6)
      `).run(
        intent.operationId,
        workspaceId,
        intent.kind,
        digest,
        idempotencyKey,
        now,
      );
      return { state: "pending", idempotencyKey };
      },
    ).immediate();
  }

  complete(
    operationId: string,
    outcomeValue:
      | Readonly<{ ok: true; mutation: RuntimeTaskMutationResult }>
      | Readonly<{ ok: false; error: RuntimeError }>,
    now = Date.now(),
  ): void {
    const outcome = storedOutcomeSchema.parse(outcomeValue);
    const serialized = JSON.stringify(outcome);
    const state = outcome.ok ? "succeeded" : "failed";
    const outcomeCode = outcome.ok
      ? outcome.mutation.commandKind
      : outcome.error.code;
    const updated = this.#database.query(`
      UPDATE cloud_human_operation_receipts
      SET state = ?2, response_json = ?3, outcome_code = ?4,
        updated_at = ?5, completed_at = ?5
      WHERE operation_id = ?1 AND state = 'started'
    `).run(operationId, state, serialized, outcomeCode, now);
    if (updated.changes === 1) return;
    const existing = this.#read(operationId);
    if (
      existing === null ||
      existing.state !== state ||
      existing.response_json !== serialized
    ) {
      throw new Error("Cloud operation receipt cannot accept this outcome.");
    }
  }

  #read(operationId: string): z.infer<typeof receiptRowSchema> | null {
    const value: unknown = this.#database.query(`
      SELECT workspace_id, command_kind, keyed_command_digest,
        http_idempotency_key, state, response_json
      FROM cloud_human_operation_receipts
      WHERE operation_id = ?1
    `).get(operationId);
    return receiptRowSchema.nullable().parse(value);
  }

  #fingerprint(value: unknown): string {
    return createHmac("sha256", this.#fingerprintKey)
      .update(canonicalJson(value))
      .digest("hex");
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
      return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
      }
      return `{${Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0
        )
        .map(([key, entry]) =>
          `${JSON.stringify(key)}:${canonicalJson(entry)}`
        )
        .join(",")}}`;
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      throw new TypeError("Cloud commands must contain only JSON values.");
  }
  throw new TypeError("Cloud commands must contain only JSON values.");
}
