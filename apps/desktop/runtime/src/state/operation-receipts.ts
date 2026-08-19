import type { Database } from "bun:sqlite";
import { z } from "@hra-internal/schema";
import { createHmac } from "node:crypto";
import {
  chatMessageIdSchema,
  chatPaneIdSchema,
  operationIdSchema,
  parseRuntimeDispatchResponse,
  runtimeProtocolVersion,
  type RuntimeDomainCommand,
  type RuntimeDispatchResponse,
} from "../../../contracts/runtime";
import { operationReceiptKeyByteLength } from "./operation-receipt-key";

const receiptRowSchema = z
  .object({
    operation_id: z.string(),
    command_type: z.string(),
    command_fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    state: z.enum(["started", "succeeded", "failed", "ambiguous"]),
    response_json: z.string().nullable(),
  })
  .strict();

export type OperationReceipt =
  | Readonly<{ state: "new" }>
  | Readonly<{ state: "inFlight" }>
  | Readonly<{ state: "ambiguous" }>
  | Readonly<{
      state: "recorded";
      response: RuntimeDispatchResponse | StoredChatOperationReceiptResponse;
    }>;

const storedChatOperationReceiptResponseSchema = z.object({
  version: z.literal(runtimeProtocolVersion),
  operationId: operationIdSchema,
  ok: z.literal(true),
  result: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("chatPaneReceipt"),
      paneId: chatPaneIdSchema,
      revision: z.number().int().positive().safe(),
    }).strict(),
    z.object({
      type: z.literal("chatMessageQueueReceipt"),
      paneId: chatPaneIdSchema,
      revision: z.number().int().positive().safe(),
      disposition: z.enum(["applied", "notApplied", "replayed"]),
      messageId: chatMessageIdSchema.nullable(),
    }).strict(),
  ]),
}).strict();

export type StoredChatOperationReceiptResponse = z.infer<
  typeof storedChatOperationReceiptResponseSchema
>;

export class OperationReceiptConflict extends Error {
  constructor() {
    super("Operation ID was already used for another command");
    this.name = "OperationReceiptConflict";
  }
}

export class OperationReceiptStore {
  readonly #database: Database;
  readonly #fingerprintKey: Uint8Array;

  constructor(database: Database, fingerprintKey: Uint8Array) {
    if (fingerprintKey.byteLength !== operationReceiptKeyByteLength) {
      throw new Error("Operation-receipt fingerprint key has an invalid length");
    }
    this.#database = database;
    this.#fingerprintKey = Uint8Array.from(fingerprintKey);
  }

  recoverInterrupted(now = new Date()): number {
    const result = this.#database
      .query(
        `UPDATE operation_receipts
         SET state = 'ambiguous', outcome_code = 'upstream_ambiguous', completed_at = ?1
         WHERE state = 'started'`,
      )
      .run(now.toISOString());
    return result.changes;
  }

  /** Remove any sensitive reveal rows written by an older runtime. */
  purgeTransientSecretReceipts(): number {
    return this.#database.query(`
      DELETE FROM operation_receipts
      WHERE command_type = 'sessionSync.recovery.reveal'
    `).run().changes;
  }

  begin(operationId: string, command: RuntimeDomainCommand, now = new Date()): OperationReceipt {
    const commandType = command.type;
    const commandFingerprint = fingerprintRuntimeCommand(command, this.#fingerprintKey);
    return this.#database.transaction(() => {
      const existing = this.#read(operationId);
      if (existing !== null) return this.#existing(existing, commandType, commandFingerprint);
      this.#database
        .query(
          `INSERT INTO operation_receipts
            (operation_id, command_type, command_fingerprint, state, created_at)
           VALUES (?1, ?2, ?3, 'started', ?4)`,
        )
        .run(operationId, commandType, commandFingerprint, now.toISOString());
      return { state: "new" } as const;
    })();
  }

  complete(response: RuntimeDispatchResponse, entityId: string | null = null, now = new Date()): void {
    if (response.ok && response.result.type === "sessionSyncRecoveryKit") {
      throw new Error("Recovery-kit reveals cannot be persisted in operation receipts");
    }
    const state = response.ok ? "succeeded" : "failed";
    const outcomeCode = response.ok ? response.result.type : response.error.code;
    const result = this.#database
      .query(
        `UPDATE operation_receipts
         SET state = ?2, outcome_code = ?3, entity_id = ?4, response_json = ?5, completed_at = ?6
         WHERE operation_id = ?1 AND state = 'started'`,
      )
      .run(
        response.operationId,
        state,
        outcomeCode,
        entityId,
        JSON.stringify(storableOperationResponse(response)),
        now.toISOString(),
      );
    if (result.changes !== 1) throw new Error("Operation receipt is not in flight");
  }

  markAmbiguous(operationId: string, now = new Date()): void {
    const result = this.#database
      .query(
        `UPDATE operation_receipts
         SET state = 'ambiguous', outcome_code = 'upstream_ambiguous', completed_at = ?2
         WHERE operation_id = ?1 AND state = 'started'`,
      )
      .run(operationId, now.toISOString());
    if (result.changes !== 1) throw new Error("Operation receipt is not in flight");
  }

  #read(operationId: string): z.infer<typeof receiptRowSchema> | null {
    const value: unknown = this.#database
      .query(
        `SELECT operation_id, command_type, command_fingerprint, state, response_json
         FROM operation_receipts WHERE operation_id = ?1`,
      )
      .get(operationId);
    return value === null ? null : receiptRowSchema.parse(value);
  }

  #existing(
    existing: z.infer<typeof receiptRowSchema>,
    commandType: string,
    commandFingerprint: string,
  ): OperationReceipt {
    if (
      existing.command_type !== commandType ||
      existing.command_fingerprint !== commandFingerprint
    ) {
      throw new OperationReceiptConflict();
    }
    switch (existing.state) {
      case "started":
        return { state: "inFlight" };
      case "ambiguous":
        return { state: "ambiguous" };
      case "succeeded":
      case "failed":
        if (existing.response_json === null) throw new Error("Recorded operation is missing its response");
        return {
          state: "recorded",
          response: parseStoredOperationResponse(
            JSON.parse(existing.response_json) as unknown,
          ),
        };
    }
  }
}

function storableOperationResponse(
  response: RuntimeDispatchResponse,
): RuntimeDispatchResponse | StoredChatOperationReceiptResponse {
  if (!response.ok) return response;
  if (response.result.type === "chatPane") {
    return storedChatOperationReceiptResponseSchema.parse({
      version: response.version,
      operationId: response.operationId,
      ok: true,
      result: {
        type: "chatPaneReceipt",
        paneId: response.result.pane.id,
        revision: response.result.appliedRevision,
      },
    });
  }
  if (response.result.type === "chatMessageQueue") {
    return storedChatOperationReceiptResponseSchema.parse({
      version: response.version,
      operationId: response.operationId,
      ok: true,
      result: {
        type: "chatMessageQueueReceipt",
        paneId: response.result.paneId,
        revision: response.result.queue.revision,
        disposition: response.result.disposition,
        messageId: response.result.messageId,
      },
    });
  }
  return response;
}

function parseStoredOperationResponse(
  value: unknown,
): RuntimeDispatchResponse | StoredChatOperationReceiptResponse {
  const chat = storedChatOperationReceiptResponseSchema.safeParse(value);
  return chat.success ? chat.data : parseRuntimeDispatchResponse(value);
}

export function fingerprintRuntimeCommand(
  command: RuntimeDomainCommand,
  fingerprintKey: Uint8Array,
): string {
  if (fingerprintKey.byteLength !== operationReceiptKeyByteLength) {
    throw new Error("Operation-receipt fingerprint key has an invalid length");
  }
  return createHmac("sha256", fingerprintKey).update(canonicalJson(command)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
      return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      return `{${Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
        .join(",")}}`;
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      throw new TypeError("Runtime commands must contain only JSON values");
  }
  throw new TypeError("Runtime commands must contain only JSON values");
}
