import { createHmac } from "node:crypto";
import type { Database } from "bun:sqlite";

import { z } from "@hra-internal/schema";

import {
  actorEpochIdSchema,
  actorIdSchema,
} from "./actor-domain";
import type {
  HarnessContextValueNameDigestPortV2,
  HarnessContextValueQuotaPortV2,
} from "./context-value-ports-v2";
import {
  deriveHarnessContextDigestKey,
  type HarnessContextKeyProvider,
} from "./key-custody";

const MIB = 1024 * 1024;
const MAX_CONTEXT_QUOTA_BYTES = 64 * MIB;

/** Stable HMAC domain bytes shared with released OPRTE state. */
export const LEGACY_OPRTE_CONTEXT_VALUE_NAME_HMAC_DOMAIN_V2 =
  "oprte.harness.context-value-name-hmac.v2";

const contextNameSchema = z.string().min(1).max(128).refine(
  (value) => value === value.trim() && !value.includes("\0"),
  "context value name must be trimmed and NUL-free",
);

const digestNameInputSchema = z.object({
  epochId: actorEpochIdSchema,
  ownerActorId: actorIdSchema,
  name: contextNameSchema,
}).strict();

const quotaInputSchema = z.object({
  epochId: actorEpochIdSchema,
  ownerActorId: actorIdSchema,
}).strict();

const quotaBytesSchema = z.number().int().min(MIB)
  .max(MAX_CONTEXT_QUOTA_BYTES)
  .refine(
    (value) => value % MIB === 0,
    "context quota must use whole MiB increments",
  );

const quotaRowSchema = z.object({
  context_quota_bytes: quotaBytesSchema,
  actor_byte_budget: quotaBytesSchema,
}).strict();

export type HarnessProductionContextAdapterV2ErrorCode =
  | "invalid_request"
  | "key_unavailable"
  | "quota_unavailable";

const ERROR_MESSAGES: Readonly<Record<
  HarnessProductionContextAdapterV2ErrorCode,
  string
>> = Object.freeze({
  invalid_request: "The production context request is invalid.",
  key_unavailable: "The context-name digest key is unavailable.",
  quota_unavailable: "The context-value quota authority is unavailable.",
});

/** Fixed messages keep names, actor identity, and stored row contents private. */
export class HarnessProductionContextAdapterV2Error extends Error {
  readonly code: HarnessProductionContextAdapterV2ErrorCode;

  constructor(code: HarnessProductionContextAdapterV2ErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "HarnessProductionContextAdapterV2Error";
    this.code = code;
  }
}

/**
 * Produces a stable logical-name handle without storing the cleartext name.
 * The installation key is narrowed to one epoch and actor with no source turn;
 * a second derivation and an explicit v2 envelope separate this use from every
 * encryption and content-integrity key in the Context Heap.
 */
export class HarnessContextValueNameDigesterV2
  implements HarnessContextValueNameDigestPortV2 {
  readonly #keys: HarnessContextKeyProvider;

  constructor(keys: HarnessContextKeyProvider) {
    this.#keys = keys;
  }

  async digestName(inputValue: Readonly<{
    epochId: string;
    ownerActorId: string;
    name: string;
  }>): Promise<string> {
    const input = parseInput(digestNameInputSchema, inputValue);
    try {
      return await this.#keys.withContextKey({
        epochId: input.epochId,
        ownerActorId: input.ownerActorId,
        sourceTurnId: null,
      }, (contextKey) => digestContextName(contextKey, input));
    } catch (cause: unknown) {
      if (cause instanceof HarnessProductionContextAdapterV2Error) throw cause;
      throw new HarnessProductionContextAdapterV2Error("key_unavailable");
    }
  }
}

/**
 * Resolves the current maximum valid Context Heap quota for one live actor.
 * Actor byte budgets that cannot themselves be represented by the downstream
 * whole-MiB quota contract are rejected instead of rounded across authority.
 */
export class HarnessContextValueQuotaAuthorityV2
  implements HarnessContextValueQuotaPortV2 {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  resolveQuotaLimit(inputValue: Readonly<{
    epochId: string;
    ownerActorId: string;
  }>): Promise<number> {
    return Promise.resolve().then(() => resolveQuotaLimit(
      this.#database,
      inputValue,
    ));
  }
}

function resolveQuotaLimit(
  database: Database,
  inputValue: unknown,
): number {
  const input = parseInput(quotaInputSchema, inputValue);
  let rows: unknown[];
  try {
    rows = database.query(`
      SELECT settings.context_quota_bytes,
        actor.byte_budget AS actor_byte_budget
      FROM harness_actor_epochs AS epoch
      JOIN harness_actors AS actor
        ON actor.epoch_id = epoch.epoch_id
        AND actor.actor_id = ?2
      JOIN harness_settings AS settings ON settings.singleton = 1
      WHERE epoch.epoch_id = ?1
        AND epoch.state = 'active'
        AND actor.state = 'active'
      LIMIT 2
    `).all(input.epochId, input.ownerActorId);
  } catch {
    throw new HarnessProductionContextAdapterV2Error("quota_unavailable");
  }
  if (rows.length !== 1) {
    throw new HarnessProductionContextAdapterV2Error("quota_unavailable");
  }
  let row: z.infer<typeof quotaRowSchema>;
  try {
    row = quotaRowSchema.parse(rows[0]);
  } catch {
    throw new HarnessProductionContextAdapterV2Error("quota_unavailable");
  }
  return Math.min(row.context_quota_bytes, row.actor_byte_budget);
}

function digestContextName(
  contextKey: Uint8Array,
  input: z.infer<typeof digestNameInputSchema>,
): string {
  let digestKey: Uint8Array | null = null;
  let envelope: Buffer | null = null;
  try {
    digestKey = deriveHarnessContextDigestKey(contextKey);
    envelope = Buffer.from(JSON.stringify({
      domain: LEGACY_OPRTE_CONTEXT_VALUE_NAME_HMAC_DOMAIN_V2,
      version: 2,
      epochId: input.epochId,
      ownerActorId: input.ownerActorId,
      sourceTurnId: null,
      name: input.name,
    }), "utf8");
    return createHmac("sha256", digestKey).update(envelope).digest("hex");
  } catch {
    throw new HarnessProductionContextAdapterV2Error("key_unavailable");
  } finally {
    digestKey?.fill(0);
    envelope?.fill(0);
  }
}

function parseInput<Output>(
  schema: z.ZodType<Output>,
  value: unknown,
): Output {
  try {
    return schema.parse(value);
  } catch {
    throw new HarnessProductionContextAdapterV2Error("invalid_request");
  }
}
