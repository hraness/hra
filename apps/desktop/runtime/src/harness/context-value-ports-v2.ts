import { createHash } from "node:crypto";

import { z } from "@hra-internal/schema";

import type { PersistentActorCodexValuePort } from "./codex-persistent-actor-provider";
import {
  actorAttemptIdSchema,
  actorEpochIdSchema,
  actorIdSchema,
  actorTurnIdSchema,
} from "./actor-domain";
import {
  HARNESS_MAX_COMPLETED_PREFIX_CONTAINER_UTF8_BYTES,
  HARNESS_MAX_HEAP_UTF8_BYTES,
  contextValueIdSchema,
  programRunIdSchema,
} from "./domain";
import {
  COMPLETED_PREFIX_CONTAINER_V2_PRELUDE_BYTES,
  packCompletedPrefixContainerV2,
  parseCompletedPrefixContainerIndexV2,
  parseCompletedPrefixContainerPreludeV2,
  parseCompletedPrefixContainerV2,
} from "./completed-prefix-container-v2";
import type { PersistentActorValuePort } from "./persistent-actors";
import type { HarnessProposalValuePort } from "./proposal-service";
import type { HarnessRendererActorResponsePort } from "./renderer-effects-v2";
import {
  RLM_V2_MAX_COLLECTION_ITEMS,
  RLM_V2_MAX_SOURCE_UTF8_BYTES,
  RLM_V2_MAX_VALUE_UTF8_BYTES,
  rlmV2NodePathSchema,
  rlmV2OperationSchema,
  type RlmV2JsonValue,
} from "./rlm-v2";
import type {
  RlmRuntimeEncryptedValuePort,
  RlmRuntimeValueIdentity,
} from "./rlm-runtime-v2";

const MIB = 1024 * 1024;
const MAX_ACTOR_INPUT_UTF8_BYTES = 256 * 1024;
const MAX_ACTOR_RESULT_UTF8_BYTES = 1024 * 1024;
export const HARNESS_ACTOR_CONTINUATION_HISTORY_MAX_ITEMS = 1_024;
export const HARNESS_ACTOR_CONTINUATION_HISTORY_MAX_ITEM_UTF8_BYTES = MIB;
export const HARNESS_ACTOR_CONTINUATION_HISTORY_MAX_UTF8_BYTES = 16 * MIB;
const VALUE_PAGE_SIZE = 128;
const MAX_VALUE_SCAN = 4_096;

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const operationIdSchema = z.string().min(16).max(128)
  .regex(/^[A-Za-z][A-Za-z0-9_-]{15,127}$/u);
const valueKindSchema = z.enum(["text", "json", "selection", "agentResult"]);
const valuePurposeSchema = z.enum([
  "heap",
  "completedPrefix",
  "currentInput",
  "agentResult",
  "proposal",
  "actorTask",
  "programSource",
  "programResult",
]);
const quotaLimitSchema = z.number().int().min(MIB)
  .max(HARNESS_MAX_HEAP_UTF8_BYTES)
  .refine((value) => value % MIB === 0);
const wellFormedPlaintextSchema = z.string().refine(
  isWellFormedUtf16,
  "context plaintext is not valid Unicode",
);
const plaintextSchema = wellFormedPlaintextSchema.refine(
  (value) => !value.includes("\0"),
  "context plaintext contains NUL",
);

const activeValueSchema = z.object({
  version: z.literal(2),
  operationId: operationIdSchema,
  epochId: actorEpochIdSchema,
  ownerActorId: actorIdSchema,
  sourceTurnId: actorTurnIdSchema.nullable(),
  valueId: contextValueIdSchema,
  kind: valueKindSchema,
  purpose: valuePurposeSchema,
  schemaVersion: z.literal(1),
  nameDigest: digestSchema.nullable(),
  utf8Bytes: z.number().int().nonnegative()
    .max(HARNESS_MAX_COMPLETED_PREFIX_CONTAINER_UTF8_BYTES),
  contentDigest: digestSchema,
  quotaLimitBytes: quotaLimitSchema,
  state: z.literal("active"),
}).passthrough().superRefine((value, context) => {
  if (
    value.purpose !== "completedPrefix" &&
    value.utf8Bytes > MAX_ACTOR_RESULT_UTF8_BYTES
  ) {
    context.addIssue({
      code: "custom",
      message: "context value exceeds its purpose-specific byte limit",
      path: ["utf8Bytes"],
    });
  }
  if (value.purpose === "completedPrefix" && value.kind !== "selection") {
    context.addIssue({
      code: "custom",
      message: "completed-prefix values must use the selection kind",
      path: ["kind"],
    });
  }
});

type ActiveValue = z.infer<typeof activeValueSchema>;

const putResultSchema = z.object({
  publication: z.enum(["created", "existing", "mixed"]),
  value: activeValueSchema,
}).strict();

const getResultSchema = z.object({
  plaintext: z.string(),
  value: activeValueSchema,
}).strict();

const valueAddressSchema = z.object({
  epochId: actorEpochIdSchema,
  ownerActorId: actorIdSchema,
  sourceTurnId: actorTurnIdSchema.nullable(),
  valueId: contextValueIdSchema,
}).strict();

const actorCopySchema = z.object({
  epochId: actorEpochIdSchema,
  callerActorId: actorIdSchema,
  targetActorId: actorIdSchema,
  turnId: actorTurnIdSchema,
  sourceValueId: contextValueIdSchema,
}).strict();

const actorValueAddressSchema = z.object({
  epochId: actorEpochIdSchema,
  actorId: actorIdSchema,
  turnId: actorTurnIdSchema,
  valueId: contextValueIdSchema,
}).strict();

const actorResultPutSchema = z.object({
  operationId: operationIdSchema,
  epochId: actorEpochIdSchema,
  actorId: actorIdSchema,
  turnId: actorTurnIdSchema,
  plaintext: plaintextSchema.refine(
    (value) => utf8Bytes(value) <= MAX_ACTOR_RESULT_UTF8_BYTES,
    "actor result exceeds its byte bound",
  ),
}).strict();

const actorContinuationHistoryItemSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: wellFormedPlaintextSchema
    .refine((value) => value.length > 0, "continuation history item is empty")
    .refine(
      (value) => !value.includes("\0"),
      "continuation history item contains NUL",
    )
    .refine(
      (value) => utf8Bytes(value) <=
        HARNESS_ACTOR_CONTINUATION_HISTORY_MAX_ITEM_UTF8_BYTES,
      "continuation history item exceeds its UTF-8 byte bound",
    ),
}).strict();

const actorContinuationHistoryCapsulePutSchema = z.object({
  epochId: actorEpochIdSchema,
  actorId: actorIdSchema,
  actorTurnId: actorTurnIdSchema,
  sourceAttemptId: actorAttemptIdSchema,
  historyDigest: digestSchema,
  items: z.array(actorContinuationHistoryItemSchema)
    .min(1)
    .max(HARNESS_ACTOR_CONTINUATION_HISTORY_MAX_ITEMS),
}).strict().superRefine((input, context) => {
  const totalUtf8Bytes = continuationHistoryUtf8Bytes(input.items);
  if (totalUtf8Bytes > HARNESS_ACTOR_CONTINUATION_HISTORY_MAX_UTF8_BYTES) {
    context.addIssue({
      code: "custom",
      message: "continuation history exceeds its UTF-8 byte bound",
      path: ["items"],
    });
  }
  if (digestActorContinuationHistory(input.items) !== input.historyDigest) {
    context.addIssue({
      code: "custom",
      message: "continuation history digest does not match its ordered items",
      path: ["historyDigest"],
    });
  }
});

const actorContinuationHistoryCapsuleHandleSchema = z.object({
  version: z.literal(2),
  epochId: actorEpochIdSchema,
  actorId: actorIdSchema,
  actorTurnId: actorTurnIdSchema,
  sourceAttemptId: actorAttemptIdSchema,
  valueId: contextValueIdSchema,
}).strict();

const actorContinuationHistoryCapsuleOpenSchema = z.object({
  handle: actorContinuationHistoryCapsuleHandleSchema,
}).strict();

const proposalPutSchema = z.object({
  operationId: operationIdSchema,
  epochId: actorEpochIdSchema,
  ownerActorId: actorIdSchema,
  sourceTurnId: actorTurnIdSchema,
  valueId: contextValueIdSchema,
  kind: z.literal("json"),
  purpose: z.literal("proposal"),
  plaintext: z.string(),
  quotaLimitBytes: quotaLimitSchema,
}).strict();

const proposalGetSchema = z.object({
  epochId: actorEpochIdSchema,
  ownerActorId: actorIdSchema,
  valueId: contextValueIdSchema,
  sourceTurnId: actorTurnIdSchema.optional(),
}).strict();

const contextNameSchema = z.string().min(1).max(128).refine(
  (value) => value === value.trim() && !value.includes("\0"),
  "context value name must be trimmed and NUL-free",
);

const genericPutSchema = z.object({
  operationId: operationIdSchema,
  epochId: actorEpochIdSchema,
  ownerActorId: actorIdSchema,
  sourceTurnId: actorTurnIdSchema.nullable(),
  valueId: contextValueIdSchema,
  kind: valueKindSchema,
  purpose: valuePurposeSchema,
  plaintext: z.string(),
  quotaLimitBytes: quotaLimitSchema,
  name: contextNameSchema.nullable().default(null),
}).strict().superRefine((value, context) => {
  if (value.name !== null && value.purpose !== "heap") {
    context.addIssue({
      code: "custom",
      message: "only heap values have a cleartext logical name",
      path: ["name"],
    });
  }
});

const genericOpenSchema = z.object({
  epochId: actorEpochIdSchema,
  ownerActorId: actorIdSchema,
  sourceTurnId: actorTurnIdSchema.nullable(),
  valueId: contextValueIdSchema,
  kind: valueKindSchema,
  purpose: valuePurposeSchema,
}).strict();

const completedPrefixRangeOpenSchema = z.object({
  epochId: actorEpochIdSchema,
  ownerActorId: actorIdSchema,
  sourceTurnId: actorTurnIdSchema.nullable(),
  valueId: contextValueIdSchema,
  kind: z.literal("selection"),
  purpose: z.literal("completedPrefix"),
}).strict();

const actorResultRangeOpenSchema = z.object({
  epochId: actorEpochIdSchema,
  ownerActorId: actorIdSchema,
  sourceTurnId: actorTurnIdSchema,
  valueId: contextValueIdSchema,
  kind: z.literal("agentResult"),
  purpose: z.literal("agentResult"),
}).strict();

const byteRangeSchema = z.object({
  startByte: z.number().int().nonnegative().safe(),
  endByteExclusive: z.number().int().nonnegative().safe(),
}).strict().superRefine((range, context) => {
  if (range.endByteExclusive < range.startByte) {
    context.addIssue({
      code: "custom",
      message: "context-value range end precedes its start",
      path: ["endByteExclusive"],
    });
  }
});

const genericListSchema = z.object({
  epochId: actorEpochIdSchema,
  ownerActorId: actorIdSchema,
  afterValueId: contextValueIdSchema.nullable().default(null),
  limit: z.number().int().min(1).max(VALUE_PAGE_SIZE),
}).strict();

const rlmValueIdentitySchema: z.ZodType<RlmRuntimeValueIdentity> = z.object({
  version: z.literal(2),
  role: z.enum(["programSource", "programResult", "receiptResult"]),
  epochId: actorEpochIdSchema,
  actorId: actorIdSchema,
  turnId: actorTurnIdSchema,
  runId: programRunIdSchema,
  programDigest: digestSchema,
  receiptId: z.string().min(16).max(128).nullable(),
  nodePath: rlmV2NodePathSchema.nullable(),
  operation: rlmV2OperationSchema.nullable(),
  requestDigest: digestSchema.nullable(),
}).strict().superRefine((value, context) => {
  const receiptFields = [
    value.receiptId,
    value.nodePath,
    value.operation,
    value.requestDigest,
  ];
  const hasAll = receiptFields.every((field) => field !== null);
  const hasNone = receiptFields.every((field) => field === null);
  if (value.role === "receiptResult" ? !hasAll : !hasNone) {
    context.addIssue({
      code: "custom",
      message: "RLM receipt identity does not match its role",
    });
  }
});

const rlmEnvelopeSchema = z.object({
  domain: z.literal("oprte.harness.rlm-encrypted-value.v2"),
  identity: rlmValueIdentitySchema,
  identityDigest: digestSchema,
  contentDigest: digestSchema,
  value: z.unknown(),
}).strict();

const rlmSealSchema = z.object({
  operationId: operationIdSchema,
  identity: rlmValueIdentitySchema,
  identityDigest: digestSchema,
  contentDigest: digestSchema,
  value: z.unknown(),
}).strict();

const rlmOpenSchema = z.object({
  valueId: contextValueIdSchema,
  expectedIdentity: rlmValueIdentitySchema,
  expectedIdentityDigest: digestSchema,
  expectedContentDigest: digestSchema.nullable(),
}).strict();

export interface HarnessEncryptedContextStoreV2Port {
  put(input: unknown): Promise<unknown>;
  get(input: unknown): Promise<unknown>;
  list(input: unknown): Promise<unknown>;
  withRangeReader<Result>(
    input: unknown,
    operation: (reader: HarnessEncryptedContextRangeReaderV2) =>
      Promise<Result> | Result,
  ): Promise<Result>;
}

export interface HarnessEncryptedContextRangeReaderV2 {
  readonly value: unknown;
  readRange(input: unknown): Promise<Uint8Array>;
}

export interface HarnessContextValueNameDigestPortV2 {
  digestName(input: Readonly<{
    epochId: string;
    ownerActorId: string;
    name: string;
  }>): Promise<unknown>;
}

export interface HarnessContextValueQuotaPortV2 {
  resolveQuotaLimit(input: Readonly<{
    epochId: string;
    ownerActorId: string;
  }>): Promise<unknown>;
}

export interface HarnessActorContinuationHistoryItemV2 {
  readonly role: "user" | "assistant";
  readonly text: string;
}

/**
 * Provider-neutral reference to one immutable encrypted continuation history.
 * Every identity here belongs to HRA. Provider account, process, thread,
 * turn, and client-message identities are intentionally absent.
 */
export interface HarnessActorContinuationHistoryCapsuleHandleV2 {
  readonly version: 2;
  readonly epochId: string;
  readonly actorId: string;
  readonly actorTurnId: string;
  readonly sourceAttemptId: string;
  readonly valueId: string;
}

export interface HarnessActorContinuationHistoryCapsuleV2 {
  readonly handle: HarnessActorContinuationHistoryCapsuleHandleV2;
  readonly historyDigest: string;
  readonly itemCount: number;
  readonly historyUtf8Bytes: number;
  readonly containerUtf8Bytes: number;
  readonly items: readonly HarnessActorContinuationHistoryItemV2[];
}

export interface HarnessActorContinuationHistoryCapsulePortV2 {
  putActorContinuationHistoryCapsule(input: Readonly<{
    epochId: string;
    actorId: string;
    actorTurnId: string;
    sourceAttemptId: string;
    historyDigest: string;
    items: readonly HarnessActorContinuationHistoryItemV2[];
  }>): Promise<HarnessActorContinuationHistoryCapsuleHandleV2>;
  readActorContinuationHistoryCapsule(input: Readonly<{
    handle: HarnessActorContinuationHistoryCapsuleHandleV2;
  }>): Promise<HarnessActorContinuationHistoryCapsuleV2>;
}

export interface HarnessContextOperationValueRecordV2 {
  readonly epochId: string;
  readonly ownerActorId: string;
  readonly sourceTurnId: string | null;
  readonly valueId: string;
  readonly kind: ActiveValue["kind"];
  readonly purpose: ActiveValue["purpose"];
  readonly nameDigest: string | null;
  readonly utf8Bytes: number;
  readonly quotaLimitBytes: number;
}

export interface HarnessContextOperationRangeReaderV2 {
  readonly value: HarnessContextOperationValueRecordV2;
  readRange(input: Readonly<{
    startByte: number;
    endByteExclusive: number;
  }>): Promise<Uint8Array>;
}

export interface HarnessContextOperationValuePortV2 {
  putExact(input: Readonly<{
    operationId: string;
    epochId: string;
    ownerActorId: string;
    sourceTurnId: string | null;
    valueId: string;
    kind: ActiveValue["kind"];
    purpose: ActiveValue["purpose"];
    plaintext: string;
    quotaLimitBytes: number;
    name?: string | null;
  }>): Promise<Readonly<{ value: HarnessContextOperationValueRecordV2 }>>;
  openExact(input: Readonly<{
    epochId: string;
    ownerActorId: string;
    sourceTurnId: string | null;
    valueId: string;
    kind: ActiveValue["kind"];
    purpose: ActiveValue["purpose"];
  }>): Promise<Readonly<{
    plaintext: string;
    value: HarnessContextOperationValueRecordV2;
  }>>;
  withExactRangeReader<Result>(
    input: Readonly<{
      epochId: string;
      ownerActorId: string;
      sourceTurnId: string | null;
      valueId: string;
      kind: "selection";
      purpose: "completedPrefix";
    }>,
    operation: (reader: HarnessContextOperationRangeReaderV2) =>
      Promise<Result> | Result,
  ): Promise<Result>;
  withExactActorResultRangeReader<Result>(
    input: Readonly<{
      epochId: string;
      ownerActorId: string;
      sourceTurnId: string;
      valueId: string;
      kind: "agentResult";
      purpose: "agentResult";
    }>,
    operation: (reader: HarnessContextOperationRangeReaderV2) =>
      Promise<Result> | Result,
  ): Promise<Result>;
  listActive(input: Readonly<{
    epochId: string;
    ownerActorId: string;
    afterValueId?: string | null;
    limit: number;
  }>): Promise<readonly HarnessContextOperationValueRecordV2[]>;
}

export class HarnessContextValuePortsV2Error extends Error {
  readonly code: "corrupt_store" | "identity_conflict" | "not_found";

  constructor(code: HarnessContextValuePortsV2Error["code"], cause?: unknown) {
    super({
      corrupt_store: "Encrypted context-value storage returned invalid evidence.",
      identity_conflict: "The immutable context-value identity conflicts.",
      not_found: "The encrypted context value is unavailable.",
    }[code], cause === undefined ? undefined : { cause });
    this.name = "HarnessContextValuePortsV2Error";
    this.code = code;
  }
}

/**
 * One fail-closed production bridge for all v2 plaintext consumers. Provider
 * process, thread, and generation identities are deliberately absent from its
 * API and every durable value identity.
 */
export class HarnessContextValuePortsV2 implements
  PersistentActorValuePort,
  PersistentActorCodexValuePort,
  HarnessActorContinuationHistoryCapsulePortV2,
  HarnessRendererActorResponsePort,
  HarnessProposalValuePort,
  RlmRuntimeEncryptedValuePort,
  HarnessContextOperationValuePortV2 {
  readonly #store: HarnessEncryptedContextStoreV2Port;
  readonly #names: HarnessContextValueNameDigestPortV2 | null;
  readonly #quotas: HarnessContextValueQuotaPortV2 | null;

  constructor(
    store: HarnessEncryptedContextStoreV2Port,
    names: HarnessContextValueNameDigestPortV2 | null = null,
    quotas: HarnessContextValueQuotaPortV2 | null = null,
  ) {
    this.#store = store;
    this.#names = names;
    this.#quotas = quotas;
  }

  async putActorContinuationHistoryCapsule(inputValue: Readonly<{
    epochId: string;
    actorId: string;
    actorTurnId: string;
    sourceAttemptId: string;
    historyDigest: string;
    items: readonly HarnessActorContinuationHistoryItemV2[];
  }>): Promise<HarnessActorContinuationHistoryCapsuleHandleV2> {
    const input = actorContinuationHistoryCapsulePutSchema.parse(inputValue);
    const identity = continuationHistoryCapsuleIdentity(input);
    const packed = packCompletedPrefixContainerV2({
      coverageWitnessDigest: input.historyDigest,
      completedThroughTurnId: input.actorTurnId,
      items: input.items.map((item, ordinal) => ({
        ordinal,
        itemClass: item.role === "user" ? "userMessage" : "assistantMessage",
        text: item.text,
      })),
    });
    const historyUtf8Bytes = continuationHistoryUtf8Bytes(input.items);
    const quotaLimitBytes = await this.#quotaForTurn(
      input.epochId,
      input.actorId,
      input.actorTurnId,
    );
    const publication = await this.#put({
      version: 2,
      operationId: identity.operationId,
      epochId: input.epochId,
      ownerActorId: input.actorId,
      sourceTurnId: input.actorTurnId,
      valueId: identity.valueId,
      kind: "selection",
      purpose: "completedPrefix",
      schemaVersion: 1,
      nameDigest: identity.lineageDigest,
      plaintext: packed.plaintext,
      quotaLimitBytes,
    }, {
      epochId: input.epochId,
      ownerActorId: input.actorId,
      sourceTurnId: input.actorTurnId,
      valueId: identity.valueId,
      kind: "selection",
      purpose: "completedPrefix",
      nameDigest: identity.lineageDigest,
      utf8Bytes: packed.index.totalUtf8Bytes,
    });
    if (publication.value.contentDigest !== sha256(packed.plaintext)) {
      throw new HarnessContextValuePortsV2Error("corrupt_store");
    }
    const handle = freezeContinuationHistoryCapsuleHandle({
      version: 2,
      epochId: input.epochId,
      actorId: input.actorId,
      actorTurnId: input.actorTurnId,
      sourceAttemptId: input.sourceAttemptId,
      valueId: identity.valueId,
    });

    // A successful put is not sufficient evidence that durable encrypted
    // bytes can be reopened. Exact readback also makes replay return the same
    // verified capsule after a prior publication or process restart.
    const readback = await this.readActorContinuationHistoryCapsule({ handle });
    if (
      readback.historyDigest !== input.historyDigest ||
      readback.itemCount !== input.items.length ||
      readback.historyUtf8Bytes !== historyUtf8Bytes ||
      readback.containerUtf8Bytes !== packed.index.totalUtf8Bytes ||
      !continuationHistoryItemsEqual(readback.items, input.items)
    ) {
      throw new HarnessContextValuePortsV2Error("corrupt_store");
    }
    return handle;
  }

  async readActorContinuationHistoryCapsule(inputValue: Readonly<{
    handle: HarnessActorContinuationHistoryCapsuleHandleV2;
  }>): Promise<HarnessActorContinuationHistoryCapsuleV2> {
    const input = actorContinuationHistoryCapsuleOpenSchema.parse(inputValue);
    const handle = freezeContinuationHistoryCapsuleHandle(input.handle);
    const identity = continuationHistoryCapsuleIdentity(handle);
    if (identity.valueId !== handle.valueId) {
      throw new HarnessContextValuePortsV2Error("identity_conflict");
    }
    return await this.#store.withRangeReader({
      epochId: handle.epochId,
      ownerActorId: handle.actorId,
      sourceTurnId: handle.actorTurnId,
      valueId: handle.valueId,
    }, async (rawReader) => {
      let value: ActiveValue;
      try {
        value = activeValueSchema.parse(rawReader.value);
      } catch (cause: unknown) {
        throw new HarnessContextValuePortsV2Error("corrupt_store", cause);
      }
      assertValueIdentity(value, {
        epochId: handle.epochId,
        ownerActorId: handle.actorId,
        sourceTurnId: handle.actorTurnId,
        valueId: handle.valueId,
        kind: "selection",
        purpose: "completedPrefix",
        nameDigest: identity.lineageDigest,
        utf8Bytes: value.utf8Bytes,
      });

      let preludeBytes: Uint8Array | null = null;
      let indexBytes: Uint8Array | null = null;
      let payloadBytes: Uint8Array | null = null;
      try {
        preludeBytes = await readExactRange(rawReader, {
          startByte: 0,
          endByteExclusive: COMPLETED_PREFIX_CONTAINER_V2_PRELUDE_BYTES,
        });
        const prelude = parseCompletedPrefixContainerPreludeV2(preludeBytes);
        indexBytes = await readExactRange(rawReader, {
          startByte: COMPLETED_PREFIX_CONTAINER_V2_PRELUDE_BYTES,
          endByteExclusive: prelude.payloadOffset,
        });
        const index = parseCompletedPrefixContainerIndexV2(indexBytes, prelude);
        if (
          index.completedThroughTurnId !== handle.actorTurnId ||
          index.items.length === 0 ||
          index.items.length > HARNESS_ACTOR_CONTINUATION_HISTORY_MAX_ITEMS ||
          index.sourceUtf8Bytes === 0 ||
          index.sourceUtf8Bytes >
            HARNESS_ACTOR_CONTINUATION_HISTORY_MAX_UTF8_BYTES ||
          index.totalUtf8Bytes !== value.utf8Bytes
        ) throw new HarnessContextValuePortsV2Error("identity_conflict");
        payloadBytes = await readExactRange(rawReader, {
          startByte: index.payloadOffset,
          endByteExclusive: index.totalUtf8Bytes,
        });

        const contentHash = createHash("sha256");
        contentHash.update(preludeBytes).update(indexBytes).update(payloadBytes);
        if (contentHash.digest("hex") !== value.contentDigest) {
          throw new HarnessContextValuePortsV2Error("corrupt_store");
        }
        const items = Object.freeze(index.items.map((item, ordinal) => {
          if (item.ordinal !== ordinal) {
            throw new HarnessContextValuePortsV2Error("corrupt_store");
          }
          const text = decodeUtf8Exact(payloadBytes!.subarray(
            item.utf8Offset,
            item.utf8Offset + item.utf8Bytes,
          ));
          return Object.freeze({
            role: item.itemClass === "userMessage"
              ? "user" as const
              : "assistant" as const,
            text,
          });
        }));
        const historyUtf8Bytes = continuationHistoryUtf8Bytes(items);
        const historyDigest = digestActorContinuationHistory(items);
        if (
          items.length !== index.items.length ||
          historyUtf8Bytes !== index.sourceUtf8Bytes ||
          historyDigest !== index.coverageWitnessDigest
        ) throw new HarnessContextValuePortsV2Error("identity_conflict");

        const canonical = packCompletedPrefixContainerV2({
          coverageWitnessDigest: historyDigest,
          completedThroughTurnId: handle.actorTurnId,
          items: items.map((item, ordinal) => ({
            ordinal,
            itemClass: item.role === "user"
              ? "userMessage" as const
              : "assistantMessage" as const,
            text: item.text,
          })),
        });
        if (
          canonical.index.totalUtf8Bytes !== value.utf8Bytes ||
          sha256(canonical.plaintext) !== value.contentDigest
        ) throw new HarnessContextValuePortsV2Error("corrupt_store");
        return Object.freeze({
          handle,
          historyDigest,
          itemCount: items.length,
          historyUtf8Bytes,
          containerUtf8Bytes: index.totalUtf8Bytes,
          items,
        });
      } catch (cause: unknown) {
        if (cause instanceof HarnessContextValuePortsV2Error) throw cause;
        throw new HarnessContextValuePortsV2Error("corrupt_store", cause);
      } finally {
        preludeBytes?.fill(0);
        indexBytes?.fill(0);
        payloadBytes?.fill(0);
      }
    });
  }

  async putExact(inputValue: Readonly<{
    operationId: string;
    epochId: string;
    ownerActorId: string;
    sourceTurnId: string | null;
    valueId: string;
    kind: ActiveValue["kind"];
    purpose: ActiveValue["purpose"];
    plaintext: string;
    quotaLimitBytes: number;
    name?: string | null;
  }>): Promise<Readonly<{ value: HarnessContextOperationValueRecordV2 }>> {
    const input = genericPutSchema.parse(inputValue);
    const plaintext = validatePlaintextForKind(
      input.kind,
      input.purpose,
      input.plaintext,
    );
    let nameDigest: string | null = null;
    if (input.name !== null) {
      if (this.#names === null) {
        throw new HarnessContextValuePortsV2Error("identity_conflict");
      }
      const source: unknown = await this.#names.digestName({
        epochId: input.epochId,
        ownerActorId: input.ownerActorId,
        name: input.name,
      });
      try {
        nameDigest = digestSchema.parse(source);
      } catch (cause: unknown) {
        throw new HarnessContextValuePortsV2Error("corrupt_store", cause);
      }
    }
    const result = await this.#put({
      version: 2,
      operationId: input.operationId,
      epochId: input.epochId,
      ownerActorId: input.ownerActorId,
      sourceTurnId: input.sourceTurnId,
      valueId: input.valueId,
      kind: input.kind,
      purpose: input.purpose,
      schemaVersion: 1,
      nameDigest,
      plaintext,
      quotaLimitBytes: input.quotaLimitBytes,
    }, {
      epochId: input.epochId,
      ownerActorId: input.ownerActorId,
      sourceTurnId: input.sourceTurnId,
      valueId: input.valueId,
      kind: input.kind,
      purpose: input.purpose,
      nameDigest,
      utf8Bytes: utf8Bytes(plaintext),
    });
    return Object.freeze({ value: publicValue(result.value) });
  }

  async openExact(inputValue: Readonly<{
    epochId: string;
    ownerActorId: string;
    sourceTurnId: string | null;
    valueId: string;
    kind: ActiveValue["kind"];
    purpose: ActiveValue["purpose"];
  }>): Promise<Readonly<{
    plaintext: string;
    value: HarnessContextOperationValueRecordV2;
  }>> {
    const input = genericOpenSchema.parse(inputValue);
    if (input.purpose === "completedPrefix") {
      throw new HarnessContextValuePortsV2Error("identity_conflict");
    }
    const opened = await this.#getExact({
      epochId: input.epochId,
      ownerActorId: input.ownerActorId,
      sourceTurnId: input.sourceTurnId,
      valueId: input.valueId,
    }, {
      kind: input.kind,
      purpose: input.purpose,
    });
    const plaintext = validatePlaintextForKind(
      input.kind,
      input.purpose,
      opened.plaintext,
    );
    return Object.freeze({ plaintext, value: publicValue(opened.value) });
  }

  async withExactRangeReader<Result>(
    inputValue: Readonly<{
      epochId: string;
      ownerActorId: string;
      sourceTurnId: string | null;
      valueId: string;
      kind: "selection";
      purpose: "completedPrefix";
    }>,
    operation: (reader: HarnessContextOperationRangeReaderV2) =>
      Promise<Result> | Result,
  ): Promise<Result> {
    const input = completedPrefixRangeOpenSchema.parse(inputValue);
    return await this.#withExactRawRangeReader(input, operation);
  }

  async withExactActorResultRangeReader<Result>(
    inputValue: Readonly<{
      epochId: string;
      ownerActorId: string;
      sourceTurnId: string;
      valueId: string;
      kind: "agentResult";
      purpose: "agentResult";
    }>,
    operation: (reader: HarnessContextOperationRangeReaderV2) =>
      Promise<Result> | Result,
  ): Promise<Result> {
    const input = actorResultRangeOpenSchema.parse(inputValue);
    return await this.#withExactRawRangeReader(input, operation);
  }

  async #withExactRawRangeReader<Result>(
    input: Readonly<{
      epochId: string;
      ownerActorId: string;
      sourceTurnId: string | null;
      valueId: string;
      kind: ActiveValue["kind"];
      purpose: ActiveValue["purpose"];
    }>,
    operation: (reader: HarnessContextOperationRangeReaderV2) =>
      Promise<Result> | Result,
  ): Promise<Result> {
    if (typeof operation !== "function") {
      throw new HarnessContextValuePortsV2Error("identity_conflict");
    }
    return await this.#store.withRangeReader({
      epochId: input.epochId,
      ownerActorId: input.ownerActorId,
      sourceTurnId: input.sourceTurnId,
      valueId: input.valueId,
    }, async (rawReader) => {
      let value: ActiveValue;
      try {
        value = activeValueSchema.parse(rawReader.value);
      } catch (cause: unknown) {
        throw new HarnessContextValuePortsV2Error("corrupt_store", cause);
      }
      assertValueIdentity(value, {
        ...input,
        nameDigest: null,
        utf8Bytes: value.utf8Bytes,
      });
      const reader: HarnessContextOperationRangeReaderV2 = Object.freeze({
        value: publicValue(value),
        readRange: async (rangeValue: Readonly<{
          startByte: number;
          endByteExclusive: number;
        }>) => {
          const range = byteRangeSchema.parse(rangeValue);
          if (range.endByteExclusive > value.utf8Bytes) {
            throw new HarnessContextValuePortsV2Error("identity_conflict");
          }
          const bytes = await rawReader.readRange(range);
          if (
            !(bytes instanceof Uint8Array) ||
            bytes.byteLength !== range.endByteExclusive - range.startByte
          ) throw new HarnessContextValuePortsV2Error("corrupt_store");
          return Uint8Array.from(bytes);
        },
      });
      return await operation(reader);
    });
  }

  async listActive(inputValue: Readonly<{
    epochId: string;
    ownerActorId: string;
    afterValueId?: string | null;
    limit: number;
  }>): Promise<readonly HarnessContextOperationValueRecordV2[]> {
    const input = genericListSchema.parse(inputValue);
    const output: HarnessContextOperationValueRecordV2[] = [];
    let afterValueId = input.afterValueId;
    let scanned = 0;
    let exhausted = false;
    while (output.length < input.limit && scanned < MAX_VALUE_SCAN) {
      const page = await this.#listPage(input.epochId, afterValueId);
      for (const value of page) {
        scanned += 1;
        if (value.ownerActorId === input.ownerActorId) {
          output.push(publicValue(value));
          if (output.length === input.limit) break;
        }
      }
      if (page.length < VALUE_PAGE_SIZE) {
        exhausted = true;
        break;
      }
      if (output.length === input.limit) break;
      afterValueId = page.at(-1)!.valueId;
    }
    if (!exhausted && output.length < input.limit && scanned >= MAX_VALUE_SCAN) {
      throw new HarnessContextValuePortsV2Error("corrupt_store");
    }
    return Object.freeze(output);
  }

  async prepareActorInput(inputValue: Readonly<{
    epochId: string;
    callerActorId: string;
    targetActorId: string;
    turnId: string;
    sourceValueId: string;
  }>): Promise<unknown> {
    const input = actorCopySchema.parse(inputValue);
    const source = await this.#findValue({
      epochId: input.epochId,
      ownerActorId: input.callerActorId,
      valueId: input.sourceValueId,
    });
    const opened = await this.#getExact(addressOf(source));
    const plaintext = boundedPlaintext(opened.plaintext, MAX_ACTOR_INPUT_UTF8_BYTES);
    const operationId = opaqueId("actorinput", "actor-input-operation", [
      input.epochId,
      input.callerActorId,
      input.targetActorId,
      input.turnId,
      input.sourceValueId,
    ]);
    const valueId = contextValueIdSchema.parse(opaqueId(
      "ctxval",
      "actor-input-value",
      [input.epochId, input.targetActorId, input.turnId, input.sourceValueId],
    ));
    const targetQuota = await this.#quotaForActor(
      input.epochId,
      input.targetActorId,
      source.quotaLimitBytes,
    );
    const result = await this.#put({
      version: 2,
      operationId,
      epochId: input.epochId,
      ownerActorId: input.targetActorId,
      sourceTurnId: input.turnId,
      valueId,
      kind: "text",
      purpose: "actorTask",
      schemaVersion: 1,
      nameDigest: null,
      plaintext,
      quotaLimitBytes: targetQuota,
    }, {
      epochId: input.epochId,
      ownerActorId: input.targetActorId,
      sourceTurnId: input.turnId,
      valueId,
      kind: "text",
      purpose: "actorTask",
      nameDigest: null,
      utf8Bytes: utf8Bytes(plaintext),
    });
    return Object.freeze({ valueId: result.value.valueId });
  }

  async assertResultAvailable(inputValue: Readonly<{
    epochId: string;
    actorId: string;
    turnId: string;
    valueId: string;
  }>): Promise<void> {
    const input = actorValueAddressSchema.parse(inputValue);
    await this.#getExact({
      epochId: input.epochId,
      ownerActorId: input.actorId,
      sourceTurnId: input.turnId,
      valueId: input.valueId,
    }, { kind: "agentResult", purpose: "agentResult" });
  }

  async readInput(inputValue: Readonly<{
    epochId: string;
    actorId: string;
    turnId: string;
    valueId: string;
  }>): Promise<unknown> {
    const input = actorValueAddressSchema.parse(inputValue);
    const opened = await this.#getExact({
      epochId: input.epochId,
      ownerActorId: input.actorId,
      sourceTurnId: input.turnId,
      valueId: input.valueId,
    }, { kind: "text", purpose: "actorTask" });
    return boundedPlaintext(opened.plaintext, MAX_ACTOR_INPUT_UTF8_BYTES);
  }

  async putResult(inputValue: Readonly<{
    operationId: string;
    epochId: string;
    actorId: string;
    turnId: string;
    plaintext: string;
  }>): Promise<unknown> {
    const input = actorResultPutSchema.parse(inputValue);
    const quotaLimitBytes = await this.#quotaForTurn(
      input.epochId,
      input.actorId,
      input.turnId,
    );
    const valueId = contextValueIdSchema.parse(opaqueId(
      "ctxval",
      "actor-result-value",
      [input.operationId, input.epochId, input.actorId, input.turnId],
    ));
    const result = await this.#put({
      version: 2,
      operationId: input.operationId,
      epochId: input.epochId,
      ownerActorId: input.actorId,
      sourceTurnId: input.turnId,
      valueId,
      kind: "agentResult",
      purpose: "agentResult",
      schemaVersion: 1,
      nameDigest: null,
      plaintext: input.plaintext,
      quotaLimitBytes,
    }, {
      epochId: input.epochId,
      ownerActorId: input.actorId,
      sourceTurnId: input.turnId,
      valueId,
      kind: "agentResult",
      purpose: "agentResult",
      nameDigest: null,
      utf8Bytes: utf8Bytes(input.plaintext),
    });
    return result.value.valueId;
  }

  async readActorResponse(inputValue: Readonly<{
    epochId: string;
    actorId: string;
    turnId: string;
    valueId: string;
  }>): Promise<unknown> {
    const input = actorValueAddressSchema.parse(inputValue);
    const opened = await this.#getExact({
      epochId: input.epochId,
      ownerActorId: input.actorId,
      sourceTurnId: input.turnId,
      valueId: input.valueId,
    }, { kind: "agentResult", purpose: "agentResult" });
    return boundedPlaintext(opened.plaintext, MAX_ACTOR_RESULT_UTF8_BYTES);
  }

  async put(inputValue: Readonly<{
    operationId: string;
    epochId: string;
    ownerActorId: string;
    sourceTurnId: string;
    valueId: string;
    kind: "json";
    purpose: "proposal";
    plaintext: string;
    quotaLimitBytes: number;
  }>): Promise<unknown> {
    const input = proposalPutSchema.parse(inputValue);
    const parsedJson = parseJson(input.plaintext);
    if (canonicalJson(parsedJson) !== input.plaintext) {
      throw new HarnessContextValuePortsV2Error("identity_conflict");
    }
    const result = await this.#put({ version: 2, schemaVersion: 1, nameDigest: null, ...input }, {
      epochId: input.epochId,
      ownerActorId: input.ownerActorId,
      sourceTurnId: input.sourceTurnId,
      valueId: input.valueId,
      kind: "json",
      purpose: "proposal",
      nameDigest: null,
      utf8Bytes: utf8Bytes(input.plaintext),
    });
    return Object.freeze({ valueId: result.value.valueId });
  }

  async get(inputValue: Readonly<{
    epochId: string;
    ownerActorId: string;
    valueId: string;
    sourceTurnId?: string;
  }>): Promise<Readonly<{ plaintext: string }>> {
    const input = proposalGetSchema.parse(inputValue);
    const metadata = input.sourceTurnId === undefined
      ? await this.#findValue(input)
      : (await this.#getExact({
          epochId: input.epochId,
          ownerActorId: input.ownerActorId,
          sourceTurnId: input.sourceTurnId,
          valueId: input.valueId,
        }, { kind: "json", purpose: "proposal" })).value;
    if (metadata.kind !== "json" || metadata.purpose !== "proposal" ||
        metadata.sourceTurnId === null) {
      throw new HarnessContextValuePortsV2Error("identity_conflict");
    }
    const opened = await this.#getExact(addressOf(metadata), {
      kind: "json",
      purpose: "proposal",
    });
    const parsedJson = parseJson(opened.plaintext);
    if (canonicalJson(parsedJson) !== opened.plaintext) {
      throw new HarnessContextValuePortsV2Error("corrupt_store");
    }
    return Object.freeze({ plaintext: opened.plaintext });
  }

  async sealJson(inputValue: Readonly<{
    operationId: string;
    identity: RlmRuntimeValueIdentity;
    identityDigest: string;
    contentDigest: string;
    value: RlmV2JsonValue;
  }>): Promise<unknown> {
    const input = rlmSealSchema.parse(inputValue);
    const value = normalizeJson(input.value);
    const identityDigest = digestRlmIdentity(input.identity);
    const contentDigest = sha256(canonicalJson(value));
    if (identityDigest !== input.identityDigest || contentDigest !== input.contentDigest) {
      throw new HarnessContextValuePortsV2Error("identity_conflict");
    }
    const valueLimit = input.identity.role === "programSource"
      ? RLM_V2_MAX_SOURCE_UTF8_BYTES
      : RLM_V2_MAX_VALUE_UTF8_BYTES;
    if (utf8Bytes(canonicalJson(value)) > valueLimit) {
      throw new HarnessContextValuePortsV2Error("identity_conflict");
    }
    const quotaLimitBytes = await this.#quotaForTurn(
      input.identity.epochId,
      input.identity.actorId,
      input.identity.turnId,
    );
    const valueId = contextValueIdSchema.parse(opaqueId(
      "ctxval",
      "rlm-value",
      [input.operationId, identityDigest],
    ));
    const purpose = input.identity.role === "programSource"
      ? "programSource" as const
      : "programResult" as const;
    const envelope = {
      domain: "oprte.harness.rlm-encrypted-value.v2" as const,
      identity: input.identity,
      identityDigest,
      contentDigest,
      value,
    };
    const plaintext = canonicalJson(envelope);
    await this.#put({
      version: 2,
      operationId: input.operationId,
      epochId: input.identity.epochId,
      ownerActorId: input.identity.actorId,
      sourceTurnId: input.identity.turnId,
      valueId,
      kind: "json",
      purpose,
      schemaVersion: 1,
      nameDigest: identityDigest,
      plaintext,
      quotaLimitBytes,
    }, {
      epochId: input.identity.epochId,
      ownerActorId: input.identity.actorId,
      sourceTurnId: input.identity.turnId,
      valueId,
      kind: "json",
      purpose,
      nameDigest: identityDigest,
      utf8Bytes: utf8Bytes(plaintext),
    });
    return Object.freeze({ valueId, contentDigest, identityDigest });
  }

  async openJson(inputValue: Readonly<{
    valueId: string;
    expectedIdentity: RlmRuntimeValueIdentity;
    expectedIdentityDigest: string;
    expectedContentDigest: string | null;
  }>): Promise<unknown> {
    const input = rlmOpenSchema.parse(inputValue);
    const identityDigest = digestRlmIdentity(input.expectedIdentity);
    if (identityDigest !== input.expectedIdentityDigest) {
      throw new HarnessContextValuePortsV2Error("identity_conflict");
    }
    const purpose = input.expectedIdentity.role === "programSource"
      ? "programSource" as const
      : "programResult" as const;
    const opened = await this.#getExact({
      epochId: input.expectedIdentity.epochId,
      ownerActorId: input.expectedIdentity.actorId,
      sourceTurnId: input.expectedIdentity.turnId,
      valueId: input.valueId,
    }, { kind: "json", purpose, nameDigest: identityDigest });
    const parsed = parseJson(opened.plaintext);
    if (canonicalJson(parsed) !== opened.plaintext) {
      throw new HarnessContextValuePortsV2Error("corrupt_store");
    }
    let envelope: z.infer<typeof rlmEnvelopeSchema>;
    try {
      envelope = rlmEnvelopeSchema.parse(parsed);
    } catch (cause: unknown) {
      throw new HarnessContextValuePortsV2Error("corrupt_store", cause);
    }
    const value = normalizeJson(envelope.value);
    if (
      canonicalJson(envelope.identity) !== canonicalJson(input.expectedIdentity) ||
      envelope.identityDigest !== identityDigest ||
      digestRlmIdentity(envelope.identity) !== identityDigest ||
      sha256(canonicalJson(value)) !== envelope.contentDigest ||
      (input.expectedContentDigest !== null &&
        envelope.contentDigest !== input.expectedContentDigest)
    ) throw new HarnessContextValuePortsV2Error("identity_conflict");
    return Object.freeze({
      valueId: input.valueId,
      contentDigest: envelope.contentDigest,
      identityDigest,
      value,
    });
  }

  async #put(command: Readonly<Record<string, unknown>>, expected: Readonly<{
    epochId: string;
    ownerActorId: string;
    sourceTurnId: string | null;
    valueId: string;
    kind: ActiveValue["kind"];
    purpose: ActiveValue["purpose"];
    nameDigest: string | null;
    utf8Bytes: number;
  }>): Promise<z.infer<typeof putResultSchema>> {
    const source: unknown = await this.#store.put(command);
    let parsed: z.infer<typeof putResultSchema>;
    try {
      parsed = putResultSchema.parse(source);
    } catch (cause: unknown) {
      throw new HarnessContextValuePortsV2Error("corrupt_store", cause);
    }
    assertValueIdentity(parsed.value, expected);
    return parsed;
  }

  async #getExact(
    addressValue: z.infer<typeof valueAddressSchema>,
    expected?: Readonly<{
      kind: ActiveValue["kind"];
      purpose: ActiveValue["purpose"];
      nameDigest?: string | null;
    }>,
  ): Promise<z.infer<typeof getResultSchema>> {
    const address = valueAddressSchema.parse(addressValue);
    const source: unknown = await this.#store.get(address);
    let parsed: z.infer<typeof getResultSchema>;
    try {
      parsed = getResultSchema.parse(source);
    } catch (cause: unknown) {
      throw new HarnessContextValuePortsV2Error("corrupt_store", cause);
    }
    assertValueIdentity(parsed.value, {
      ...address,
      kind: expected?.kind ?? parsed.value.kind,
      purpose: expected?.purpose ?? parsed.value.purpose,
      nameDigest: expected?.nameDigest ?? parsed.value.nameDigest,
      utf8Bytes: utf8Bytes(parsed.plaintext),
    });
    return parsed;
  }

  async #findValue(input: Readonly<{
    epochId: string;
    ownerActorId: string;
    valueId: string;
  }>): Promise<ActiveValue> {
    const epochId = actorEpochIdSchema.parse(input.epochId);
    const ownerActorId = actorIdSchema.parse(input.ownerActorId);
    const valueId = contextValueIdSchema.parse(input.valueId);
    let afterValueId: string | null = null;
    let scanned = 0;
    while (scanned < MAX_VALUE_SCAN) {
      const page = await this.#listPage(epochId, afterValueId);
      for (const value of page) {
        scanned += 1;
        if (value.valueId === valueId) {
          if (value.ownerActorId !== ownerActorId) {
            throw new HarnessContextValuePortsV2Error("identity_conflict");
          }
          return value;
        }
      }
      if (page.length < VALUE_PAGE_SIZE) break;
      afterValueId = page.at(-1)!.valueId;
    }
    if (scanned >= MAX_VALUE_SCAN) {
      throw new HarnessContextValuePortsV2Error("corrupt_store");
    }
    throw new HarnessContextValuePortsV2Error("not_found");
  }

  async #quotaForTurn(
    epochIdValue: string,
    actorIdValue: string,
    turnIdValue: string,
  ): Promise<number> {
    const epochId = actorEpochIdSchema.parse(epochIdValue);
    const actorId = actorIdSchema.parse(actorIdValue);
    const turnId = actorTurnIdSchema.parse(turnIdValue);
    if (this.#quotas !== null) {
      return await this.#quotaForActor(epochId, actorId, null);
    }
    let afterValueId: string | null = null;
    let scanned = 0;
    let quota: number | null = null;
    let exhausted = false;
    while (scanned < MAX_VALUE_SCAN) {
      const page = await this.#listPage(epochId, afterValueId);
      for (const value of page) {
        scanned += 1;
        if (value.ownerActorId === actorId && value.sourceTurnId === turnId) {
          quota = quota === null
            ? value.quotaLimitBytes
            : Math.min(quota, value.quotaLimitBytes);
        }
      }
      if (page.length < VALUE_PAGE_SIZE) {
        exhausted = true;
        break;
      }
      afterValueId = page.at(-1)!.valueId;
    }
    if (!exhausted && scanned >= MAX_VALUE_SCAN) {
      throw new HarnessContextValuePortsV2Error("corrupt_store");
    }
    if (quota === null) throw new HarnessContextValuePortsV2Error("not_found");
    return quota;
  }

  async #quotaForActor(
    epochIdValue: string,
    actorIdValue: string,
    fallback: number | null,
  ): Promise<number> {
    const epochId = actorEpochIdSchema.parse(epochIdValue);
    const ownerActorId = actorIdSchema.parse(actorIdValue);
    if (this.#quotas === null) {
      if (fallback === null) {
        throw new HarnessContextValuePortsV2Error("not_found");
      }
      return quotaLimitSchema.parse(fallback);
    }
    const source: unknown = await this.#quotas.resolveQuotaLimit({
      epochId,
      ownerActorId,
    });
    try {
      return quotaLimitSchema.parse(source);
    } catch (cause: unknown) {
      throw new HarnessContextValuePortsV2Error("corrupt_store", cause);
    }
  }

  async #listPage(
    epochId: string,
    afterValueId: string | null,
  ): Promise<readonly ActiveValue[]> {
    const source: unknown = await this.#store.list({
      epochId,
      afterValueId,
      limit: VALUE_PAGE_SIZE,
    });
    if (!Array.isArray(source) || source.length > VALUE_PAGE_SIZE) {
      throw new HarnessContextValuePortsV2Error("corrupt_store");
    }
    let previous = afterValueId;
    return Object.freeze(source.map((item) => {
      let value: ActiveValue;
      try {
        value = activeValueSchema.parse(item);
      } catch (cause: unknown) {
        throw new HarnessContextValuePortsV2Error("corrupt_store", cause);
      }
      if (value.epochId !== epochId ||
          (previous !== null && value.valueId <= previous)) {
        throw new HarnessContextValuePortsV2Error("corrupt_store");
      }
      previous = value.valueId;
      return value;
    }));
  }
}

function continuationHistoryCapsuleIdentity(input: Readonly<{
  epochId: string;
  actorId: string;
  actorTurnId: string;
  sourceAttemptId: string;
}>): Readonly<{
  operationId: string;
  valueId: string;
  lineageDigest: string;
}> {
  const lineage = [
    actorEpochIdSchema.parse(input.epochId),
    actorIdSchema.parse(input.actorId),
    actorTurnIdSchema.parse(input.actorTurnId),
    actorAttemptIdSchema.parse(input.sourceAttemptId),
  ] as const;
  return Object.freeze({
    operationId: operationIdSchema.parse(opaqueId(
      "actorhistory",
      "actor-continuation-history-operation",
      lineage,
    )),
    valueId: contextValueIdSchema.parse(opaqueId(
      "ctxval",
      "actor-continuation-history-value",
      lineage,
    )),
    lineageDigest: digestOpaqueParts(
      "actor-continuation-history-lineage",
      lineage,
    ),
  });
}

function freezeContinuationHistoryCapsuleHandle(
  input: z.input<typeof actorContinuationHistoryCapsuleHandleSchema>,
): HarnessActorContinuationHistoryCapsuleHandleV2 {
  const parsed = actorContinuationHistoryCapsuleHandleSchema.parse(input);
  return Object.freeze({ ...parsed });
}

function continuationHistoryUtf8Bytes(
  items: readonly Readonly<{ text: string }>[],
): number {
  let total = 0;
  for (const item of items) {
    total += utf8Bytes(item.text);
    if (!Number.isSafeInteger(total)) {
      throw new HarnessContextValuePortsV2Error("identity_conflict");
    }
  }
  return total;
}

/** Must remain byte-for-byte compatible with the verified SessionService proof. */
function digestActorContinuationHistory(
  items: readonly Readonly<{
    role: "user" | "assistant";
    text: string;
  }>[],
): string {
  const hash = createHash("sha256");
  hash.update("oprte.harness.actor-continuation-history.v1\0", "utf8");
  for (const item of items) {
    const byteLength = utf8Bytes(item.text);
    hash.update(item.role, "utf8")
      .update("\0", "utf8")
      .update(String(byteLength), "utf8")
      .update(":", "utf8")
      .update(item.text, "utf8")
      .update("\0", "utf8");
  }
  return hash.digest("hex");
}

function continuationHistoryItemsEqual(
  left: readonly HarnessActorContinuationHistoryItemV2[],
  right: readonly HarnessActorContinuationHistoryItemV2[],
): boolean {
  return left.length === right.length && left.every((item, index) =>
    item.role === right[index]?.role && item.text === right[index]?.text
  );
}

async function readExactRange(
  reader: HarnessEncryptedContextRangeReaderV2,
  range: Readonly<{ startByte: number; endByteExclusive: number }>,
): Promise<Uint8Array> {
  const parsed = byteRangeSchema.parse(range);
  const bytes = await reader.readRange(parsed);
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength !== parsed.endByteExclusive - parsed.startByte
  ) throw new HarnessContextValuePortsV2Error("corrupt_store");
  return bytes;
}

function decodeUtf8Exact(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (cause: unknown) {
    throw new HarnessContextValuePortsV2Error("corrupt_store", cause);
  }
}

function digestOpaqueParts(domain: string, parts: readonly string[]): string {
  const hash = createHash("sha256").update(`oprte.harness.${domain}.v2\0`, "utf8");
  for (const part of parts) hash.update(part, "utf8").update("\0", "utf8");
  return hash.digest("hex");
}

function assertValueIdentity(value: ActiveValue, expected: Readonly<{
  epochId: string;
  ownerActorId: string;
  sourceTurnId: string | null;
  valueId: string;
  kind: ActiveValue["kind"];
  purpose: ActiveValue["purpose"];
  nameDigest: string | null;
  utf8Bytes: number;
}>): void {
  if (
    value.epochId !== expected.epochId ||
    value.ownerActorId !== expected.ownerActorId ||
    value.sourceTurnId !== expected.sourceTurnId ||
    value.valueId !== expected.valueId ||
    value.kind !== expected.kind ||
    value.purpose !== expected.purpose ||
    value.nameDigest !== expected.nameDigest ||
    value.utf8Bytes !== expected.utf8Bytes
  ) throw new HarnessContextValuePortsV2Error("identity_conflict");
}

function addressOf(value: ActiveValue): z.infer<typeof valueAddressSchema> {
  return {
    epochId: value.epochId,
    ownerActorId: value.ownerActorId,
    sourceTurnId: value.sourceTurnId,
    valueId: value.valueId,
  };
}

function publicValue(value: ActiveValue): HarnessContextOperationValueRecordV2 {
  return Object.freeze({
    epochId: value.epochId,
    ownerActorId: value.ownerActorId,
    sourceTurnId: value.sourceTurnId,
    valueId: value.valueId,
    kind: value.kind,
    purpose: value.purpose,
    nameDigest: value.nameDigest,
    utf8Bytes: value.utf8Bytes,
    quotaLimitBytes: value.quotaLimitBytes,
  });
}

function validatePlaintextForKind(
  kind: ActiveValue["kind"],
  purpose: ActiveValue["purpose"],
  plaintext: string,
): string {
  if (purpose === "completedPrefix") {
    if (
      kind !== "selection" ||
      utf8Bytes(plaintext) > HARNESS_MAX_COMPLETED_PREFIX_CONTAINER_UTF8_BYTES
    ) throw new HarnessContextValuePortsV2Error("identity_conflict");
    try {
      parseCompletedPrefixContainerV2(plaintext);
    } catch (cause: unknown) {
      throw new HarnessContextValuePortsV2Error("identity_conflict", cause);
    }
    return plaintext;
  }
  if (utf8Bytes(plaintext) > MAX_ACTOR_RESULT_UTF8_BYTES) {
    throw new HarnessContextValuePortsV2Error("identity_conflict");
  }
  if (kind === "json") {
    const value = parseJson(plaintext);
    if (canonicalJson(value) !== plaintext) {
      throw new HarnessContextValuePortsV2Error("identity_conflict");
    }
    return plaintext;
  }
  if (kind === "selection" && purpose === "heap") {
    return wellFormedPlaintextSchema.parse(plaintext);
  }
  return boundedPlaintext(plaintext, MAX_ACTOR_RESULT_UTF8_BYTES);
}

function boundedPlaintext(value: string, maxUtf8Bytes: number): string {
  const parsed = plaintextSchema.parse(value);
  if (utf8Bytes(parsed) > maxUtf8Bytes) {
    throw new HarnessContextValuePortsV2Error("identity_conflict");
  }
  return parsed;
}

function opaqueId(prefix: string, domain: string, parts: readonly string[]): string {
  const hash = createHash("sha256").update(`oprte.harness.${domain}.v2\0`, "utf8");
  for (const part of parts) hash.update(part, "utf8").update("\0", "utf8");
  return `${prefix}_${hash.digest("base64url")}`;
}

function digestRlmIdentity(identityValue: RlmRuntimeValueIdentity): string {
  const identity = rlmValueIdentitySchema.parse(identityValue);
  return sha256(canonicalJson({
    domain: "oprte.rlm.encrypted-value-identity.v2",
    ...identity,
  }));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const following = value.charCodeAt(index + 1);
      if (following < 0xdc00 || following > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function parseJson(plaintext: string): RlmV2JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext) as unknown;
  } catch (cause: unknown) {
    throw new HarnessContextValuePortsV2Error("corrupt_store", cause);
  }
  return normalizeJson(parsed);
}

function normalizeJson(value: unknown): RlmV2JsonValue {
  const active = new WeakSet<object>();
  let nodes = 0;
  const visit = (current: unknown, depth: number): RlmV2JsonValue => {
    nodes += 1;
    if (nodes > 100_000 || depth > 64) {
      throw new HarnessContextValuePortsV2Error("identity_conflict");
    }
    if (current === null || typeof current === "boolean" || typeof current === "string") {
      return current;
    }
    if (typeof current === "number" && Number.isFinite(current) &&
        Math.abs(current) <= Number.MAX_SAFE_INTEGER) return current;
    if (typeof current !== "object" || active.has(current)) {
      throw new HarnessContextValuePortsV2Error("identity_conflict");
    }
    const prototype: unknown = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
      throw new HarnessContextValuePortsV2Error("identity_conflict");
    }
    active.add(current);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(current);
      if (Reflect.ownKeys(descriptors).some((key) => typeof key === "symbol")) {
        throw new HarnessContextValuePortsV2Error("identity_conflict");
      }
      if (Array.isArray(current)) {
        if (current.length > RLM_V2_MAX_COLLECTION_ITEMS ||
            Object.keys(descriptors).some((key) =>
              key !== "length" && !/^(0|[1-9][0-9]*)$/u.test(key)
            )) {
          throw new HarnessContextValuePortsV2Error("identity_conflict");
        }
        const output: RlmV2JsonValue[] = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined || !("value" in descriptor)) {
            throw new HarnessContextValuePortsV2Error("identity_conflict");
          }
          output.push(visit(descriptor.value, depth + 1));
        }
        return output;
      }
      if (Object.keys(descriptors).length > RLM_V2_MAX_COLLECTION_ITEMS) {
        throw new HarnessContextValuePortsV2Error("identity_conflict");
      }
      const output = Object.create(null) as Record<string, RlmV2JsonValue>;
      for (const key of Object.keys(descriptors).toSorted()) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new HarnessContextValuePortsV2Error("identity_conflict");
        }
        const descriptor = descriptors[key];
        if (descriptor === undefined || !("value" in descriptor)) {
          throw new HarnessContextValuePortsV2Error("identity_conflict");
        }
        output[key] = visit(descriptor.value, depth + 1);
      }
      return output;
    } finally {
      active.delete(current);
    }
  };
  return visit(value, 0);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).toSorted().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}
