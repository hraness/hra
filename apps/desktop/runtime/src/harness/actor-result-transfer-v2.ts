import { createHash } from "node:crypto";

import { z } from "@hra-internal/schema";

import {
  actorEpochSchema,
  actorEpochIdSchema,
  actorIdSchema,
  actorResultSchema,
  actorSchema,
  actorTurnIdSchema,
  actorTurnSchema,
} from "./actor-domain";
import type {
  HarnessContextOperationRangeReaderV2,
  HarnessContextOperationValuePortV2,
} from "./context-value-ports-v2";
import { contextValueIdSchema } from "./domain";
import type { RlmV2ActorResultTransferPort } from
  "./rlm-operation-router-v2";

const MIB = 1024 * 1024;
const MAX_RESULT_UTF8_BYTES = 1024 * 1024;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const receiptIdSchema = z.string().min(16).max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
const quotaLimitSchema = z.number().int().min(MIB).max(64 * MIB)
  .refine((value) => value % MIB === 0);

const transferInputSchema = z.object({
  epochId: actorEpochIdSchema,
  callerActorId: actorIdSchema,
  callerTurnId: actorTurnIdSchema,
  sourceActorId: actorIdSchema,
  sourceTurnId: actorTurnIdSchema,
  sourceValueId: contextValueIdSchema,
  receiptId: receiptIdSchema,
  quotaLimitBytes: quotaLimitSchema,
}).strict();

const transferredValueSchema = z.object({
  valueId: contextValueIdSchema,
  kind: z.literal("text"),
  utf8Bytes: z.number().int().nonnegative().max(MAX_RESULT_UTF8_BYTES),
}).strict();

type MaybePromise<Value> = Value | Promise<Value>;
type TransferInput = z.infer<typeof transferInputSchema>;

export interface ActorResultTransferAuthorityV2Port {
  readActorEpoch(epochId: string): MaybePromise<unknown>;
  readActor(actorId: string): MaybePromise<unknown>;
  readActorTurn(turnId: string): MaybePromise<unknown>;
  readActorResultForTurn(turnId: string): MaybePromise<unknown>;
}

export type ActorResultTransferValuePortV2 = Pick<
  HarnessContextOperationValuePortV2,
  "putExact" | "withExactActorResultRangeReader"
>;

export type ActorResultTransferV2ErrorCode =
  | "conflict"
  | "corrupt_state"
  | "invalid_input"
  | "not_ready"
  | "quota_exceeded"
  | "unauthorized";

export class ActorResultTransferV2Error extends Error {
  readonly code: ActorResultTransferV2ErrorCode;

  constructor(code: ActorResultTransferV2ErrorCode, cause?: unknown) {
    super({
      conflict: "The immutable actor-result transfer conflicts.",
      corrupt_state: "Actor-result transfer authority returned invalid evidence.",
      invalid_input: "The actor-result transfer input is invalid.",
      not_ready: "The child actor result is not ready.",
      quota_exceeded: "The child actor result exceeds caller context capacity.",
      unauthorized: "The caller does not control this child actor result.",
    }[code], cause === undefined ? undefined : { cause });
    this.name = "ActorResultTransferV2Error";
    this.code = code;
  }
}

/**
 * Copies one proven terminal direct-child result into the caller's encrypted
 * heap. The receipt owns exactly one immutable transfer slot, so retries are
 * idempotent and a changed source, payload, or caller conflicts instead of
 * publishing a second value.
 */
export class ActorResultTransferV2 implements RlmV2ActorResultTransferPort {
  readonly #authority: ActorResultTransferAuthorityV2Port;
  readonly #values: ActorResultTransferValuePortV2;
  readonly #now: () => number;

  constructor(input: Readonly<{
    authority: ActorResultTransferAuthorityV2Port;
    values: ActorResultTransferValuePortV2;
    now?: () => number;
  }>) {
    this.#authority = input.authority;
    this.#values = input.values;
    this.#now = input.now ?? Date.now;
  }

  async transfer(inputValue: Readonly<{
    epochId: string;
    callerActorId: string;
    callerTurnId: string;
    sourceActorId: string;
    sourceTurnId: string;
    sourceValueId: string;
    receiptId: string;
    quotaLimitBytes: number;
  }>): Promise<z.infer<typeof transferredValueSchema>> {
    let input: TransferInput;
    try {
      input = transferInputSchema.parse(inputValue);
    } catch (cause: unknown) {
      throw new ActorResultTransferV2Error("invalid_input", cause);
    }
    await this.#assertLineage(input);
    return await this.#copy(input);
  }

  async #assertLineage(input: TransferInput): Promise<void> {
    const evidence = await Promise.all([
      this.#authority.readActorEpoch(input.epochId),
      this.#authority.readActor(input.callerActorId),
      this.#authority.readActorTurn(input.callerTurnId),
      this.#authority.readActor(input.sourceActorId),
      this.#authority.readActorTurn(input.sourceTurnId),
      this.#authority.readActorResultForTurn(input.sourceTurnId),
    ]);
    const epoch = actorEpochSchema.safeParse(evidence[0]);
    const caller = actorSchema.safeParse(evidence[1]);
    const callerTurn = actorTurnSchema.safeParse(evidence[2]);
    const source = actorSchema.safeParse(evidence[3]);
    const sourceTurn = actorTurnSchema.safeParse(evidence[4]);
    const result = actorResultSchema.safeParse(evidence[5]);
    if (
      !epoch.success || !caller.success || !callerTurn.success ||
      !source.success || !sourceTurn.success || !result.success
    ) {
      throw new ActorResultTransferV2Error("corrupt_state");
    }
    if (
      epoch.data.id !== input.epochId || epoch.data.state !== "active" ||
      caller.data.id !== input.callerActorId ||
      caller.data.epochId !== input.epochId ||
      caller.data.state !== "active" ||
      Date.parse(caller.data.budget.deadline) <= this.#now() ||
      callerTurn.data.id !== input.callerTurnId ||
      callerTurn.data.epochId !== input.epochId ||
      callerTurn.data.actorId !== caller.data.id ||
      (callerTurn.data.state !== "running" &&
        callerTurn.data.state !== "succeeded") ||
      callerTurn.data.desiredState !== "run" ||
      source.data.id !== input.sourceActorId ||
      source.data.epochId !== input.epochId ||
      source.data.parentActorId !== caller.data.id ||
      source.data.depth !== caller.data.depth + 1 ||
      sourceTurn.data.id !== input.sourceTurnId ||
      sourceTurn.data.epochId !== input.epochId ||
      sourceTurn.data.actorId !== source.data.id
    ) {
      throw new ActorResultTransferV2Error("unauthorized");
    }
    if (sourceTurn.data.state !== "succeeded") {
      throw new ActorResultTransferV2Error("not_ready");
    }
    if (
      result.data.epochId !== input.epochId ||
      result.data.actorId !== source.data.id ||
      result.data.turnId !== sourceTurn.data.id ||
      result.data.outcome !== "succeeded" ||
      result.data.valueId !== input.sourceValueId
    ) {
      throw new ActorResultTransferV2Error("conflict");
    }
  }

  async #copy(input: TransferInput): Promise<z.infer<
    typeof transferredValueSchema
  >> {
    const identity = transferIdentity(input);
    try {
      return await this.#values.withExactActorResultRangeReader({
        epochId: input.epochId,
        ownerActorId: input.sourceActorId,
        sourceTurnId: input.sourceTurnId,
        valueId: input.sourceValueId,
        kind: "agentResult",
        purpose: "agentResult",
      }, async (reader) => {
        assertSourceMetadata(reader, input);
        if (
          reader.value.utf8Bytes > MAX_RESULT_UTF8_BYTES ||
          reader.value.utf8Bytes > input.quotaLimitBytes
        ) {
          throw new ActorResultTransferV2Error("quota_exceeded");
        }
        const bytes = await reader.readRange({
          startByte: 0,
          endByteExclusive: reader.value.utf8Bytes,
        });
        try {
          if (bytes.byteLength !== reader.value.utf8Bytes) {
            throw new ActorResultTransferV2Error("corrupt_state");
          }
          const contentDigest = sha256Bytes(bytes);
          const plaintext = decodeUtf8(bytes);
          if (
            plaintext.includes("\0") ||
            Buffer.byteLength(plaintext, "utf8") !== bytes.byteLength
          ) {
            throw new ActorResultTransferV2Error("conflict");
          }
          const result = await this.#values.putExact({
            operationId: identity.operationId,
            epochId: input.epochId,
            ownerActorId: input.callerActorId,
            sourceTurnId: input.callerTurnId,
            valueId: identity.valueId,
            kind: "text",
            purpose: "heap",
            name: transferBindingName(input, contentDigest),
            plaintext,
            quotaLimitBytes: input.quotaLimitBytes,
          });
          const value = result.value;
          if (
            value.epochId !== input.epochId ||
            value.ownerActorId !== input.callerActorId ||
            value.sourceTurnId !== input.callerTurnId ||
            value.valueId !== identity.valueId ||
            value.kind !== "text" || value.purpose !== "heap" ||
            value.nameDigest === null || value.utf8Bytes !== bytes.byteLength ||
            value.quotaLimitBytes !== input.quotaLimitBytes
          ) {
            throw new ActorResultTransferV2Error("corrupt_state");
          }
          return transferredValueSchema.parse({
            valueId: value.valueId,
            kind: "text",
            utf8Bytes: value.utf8Bytes,
          });
        } finally {
          bytes.fill(0);
        }
      });
    } catch (cause: unknown) {
      if (cause instanceof ActorResultTransferV2Error) throw cause;
      throw new ActorResultTransferV2Error("conflict", cause);
    }
  }
}

function assertSourceMetadata(
  reader: HarnessContextOperationRangeReaderV2,
  input: TransferInput,
): void {
  const value = reader.value;
  if (
    value.epochId !== input.epochId ||
    value.ownerActorId !== input.sourceActorId ||
    value.sourceTurnId !== input.sourceTurnId ||
    value.valueId !== input.sourceValueId ||
    value.kind !== "agentResult" || value.purpose !== "agentResult" ||
    value.nameDigest !== null
  ) throw new ActorResultTransferV2Error("conflict");
}

function transferIdentity(input: TransferInput): Readonly<{
  operationId: string;
  valueId: string;
}> {
  const digest = digestParts("oprte.harness.actor-result-transfer-slot.v2", [
    input.epochId,
    input.callerActorId,
    input.callerTurnId,
    input.receiptId,
  ]);
  return Object.freeze({
    operationId: `actorresulttransfer_${digest.slice(0, 48)}`,
    valueId: contextValueIdSchema.parse(`ctxval_${digest.slice(0, 48)}`),
  });
}

function transferBindingName(input: TransferInput, contentDigest: string): string {
  const digest = digestSchema.parse(digestParts(
    "oprte.harness.actor-result-transfer-binding.v2",
    [
      input.epochId,
      input.callerActorId,
      input.callerTurnId,
      input.sourceActorId,
      input.sourceTurnId,
      input.sourceValueId,
      input.receiptId,
      contentDigest,
    ],
  ));
  return `rlm-result-${digest}`;
}

function digestParts(domain: string, parts: readonly string[]): string {
  const hash = createHash("sha256").update(domain, "utf8");
  for (const part of parts) hash.update("\0", "utf8").update(part, "utf8");
  return hash.digest("hex");
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(bytes);
  } catch (cause: unknown) {
    throw new ActorResultTransferV2Error("corrupt_state", cause);
  }
}
