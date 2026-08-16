import { z } from "@hra-internal/schema";

import {
  actorEpochIdSchema,
  actorIdSchema,
  actorTurnIdSchema,
} from "./actor-domain";
import {
  contextSnapshotRecordV2Schema,
  type ContextSnapshotRecordV2,
} from "./context-snapshot-authority-v2";
import {
  COMPLETED_PREFIX_CONTAINER_V2_PRELUDE_BYTES,
  packCompletedPrefixContainerV2,
  parseCompletedPrefixContainerIndexV2,
  parseCompletedPrefixContainerPreludeV2,
  parseCompletedPrefixContainerV2,
  planCompletedPrefixContainerRangesV2,
  type CompletedPrefixContainerIndexV2,
} from "./completed-prefix-container-v2";
import type {
  HarnessContextOperationValuePortV2,
  HarnessContextOperationValueRecordV2,
} from "./context-value-ports-v2";
import type {
  HarnessDynamicToolContextMaterializationInputV2,
  HarnessDynamicToolContextMaterializationV2,
  HarnessDynamicToolContextMaterializerPortV2,
} from "./dynamic-tool-stable-caller-v2";
import {
  HARNESS_MAX_COMPLETED_PREFIX_CONTAINER_UTF8_BYTES,
  HARNESS_MAX_COMPLETED_PREFIX_ITEMS,
  HARNESS_MAX_COMPLETED_PREFIX_ITEM_UTF8_BYTES,
  HARNESS_MAX_COMPLETED_PREFIX_SOURCE_UTF8_BYTES,
  HARNESS_MAX_CONTEXT_VALUE_UTF8_BYTES,
  HARNESS_MAX_HEAP_UTF8_BYTES,
  contextValueIdSchema,
  programRunIdSchema,
} from "./domain";
import {
  deriveHarnessDynamicToolContextMaterializationIds,
  digestHarnessDynamicToolCompletedPrefixV2,
  type HarnessDynamicToolContextMaterializationIdsV2,
} from "./dynamic-tool-context-identity-v2";
export {
  deriveHarnessDynamicToolContextMaterializationIds,
  digestHarnessDynamicToolCompletedPrefixV2,
} from "./dynamic-tool-context-identity-v2";
import {
  programAdmissionIntentRecordV2Schema,
  type ProgramAdmissionIntentRecordV2,
} from "./program-admission-intent-v2";

const MIB = 1024 * 1024;

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const timestampSchema = z.string().length(24).datetime().refine(
  (value) => new Date(Date.parse(value)).toISOString() === value,
  "timestamp must use canonical UTC milliseconds",
);
const quotaLimitSchema = z.number().int().min(MIB)
  .max(HARNESS_MAX_HEAP_UTF8_BYTES)
  .refine((value) => value % MIB === 0);
const plaintextSchema = z.string().refine(
  (value) => !value.includes("\0"),
  "context plaintext contains NUL",
);

const completedPrefixItemSchema = z.object({
  ordinal: z.number().int().nonnegative().safe(),
  itemClass: z.enum(["userMessage", "assistantMessage"]),
  text: z.string()
    .refine(
      isWellFormedUtf16,
      "completed-prefix item contains an unpaired UTF-16 surrogate",
    )
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <=
        HARNESS_MAX_COMPLETED_PREFIX_ITEM_UTF8_BYTES,
      "completed-prefix item exceeds its byte bound",
    ),
}).strict();

const currentInputProvenanceSchema = z.discriminatedUnion("purpose", [
  z.object({
    valueId: contextValueIdSchema,
    purpose: z.literal("currentInput"),
    sourceTurnId: z.null(),
  }).strict(),
  z.object({
    valueId: contextValueIdSchema,
    purpose: z.literal("actorTask"),
    sourceTurnId: actorTurnIdSchema,
  }).strict(),
]);

const materializationInputSchema = z.object({
  runId: programRunIdSchema,
  epochId: actorEpochIdSchema,
  actorId: actorIdSchema,
  turnId: actorTurnIdSchema,
  currentInputValueId: contextValueIdSchema,
  currentInputProvenance: currentInputProvenanceSchema,
  completedThroughTurnId: actorTurnIdSchema.nullable(),
  expiresAt: timestampSchema,
  programDigest: digestSchema,
  stableAdmissionIdentityDigest: digestSchema,
  coverageWitnessDigest: digestSchema,
  completedPrefix: z.array(completedPrefixItemSchema)
    .max(HARNESS_MAX_COMPLETED_PREFIX_ITEMS),
  currentInput: plaintextSchema.refine(
    (value) => Buffer.byteLength(value, "utf8") <=
      HARNESS_MAX_CONTEXT_VALUE_UTF8_BYTES,
    "current input exceeds its byte bound",
  ),
}).strict().superRefine((input, context) => {
  if (input.currentInputValueId !== input.currentInputProvenance.valueId) {
    context.addIssue({
      code: "custom",
      message: "current-input identity and provenance disagree",
      path: ["currentInputProvenance", "valueId"],
    });
  }
  if (
    input.currentInputProvenance.purpose === "actorTask" &&
    input.currentInputProvenance.sourceTurnId !== input.turnId
  ) {
    context.addIssue({
      code: "custom",
      message: "actor-task input must originate from the stable actor turn",
      path: ["currentInputProvenance", "sourceTurnId"],
    });
  }
  for (let index = 1; index < input.completedPrefix.length; index += 1) {
    if (
      input.completedPrefix[index - 1]!.ordinal >=
        input.completedPrefix[index]!.ordinal
    ) {
      context.addIssue({
        code: "custom",
        message: "completed-prefix ordinals must be strictly increasing",
        path: ["completedPrefix", index, "ordinal"],
      });
      break;
    }
  }
});

const valueRecordSchema = z.object({
  epochId: actorEpochIdSchema,
  ownerActorId: actorIdSchema,
  sourceTurnId: actorTurnIdSchema.nullable(),
  valueId: contextValueIdSchema,
  kind: z.enum(["text", "json", "selection", "agentResult"]),
  purpose: z.enum([
    "heap",
    "completedPrefix",
    "currentInput",
    "agentResult",
    "proposal",
    "actorTask",
    "programSource",
    "programResult",
  ]),
  nameDigest: digestSchema.nullable(),
  utf8Bytes: z.number().int().nonnegative()
    .max(HARNESS_MAX_COMPLETED_PREFIX_CONTAINER_UTF8_BYTES),
  quotaLimitBytes: quotaLimitSchema,
}).strict().superRefine((value, context) => {
  if (
    value.purpose === "completedPrefix"
      ? value.kind !== "selection"
      : value.utf8Bytes > HARNESS_MAX_CONTEXT_VALUE_UTF8_BYTES
  ) {
    context.addIssue({
      code: "custom",
      message: value.purpose === "completedPrefix"
        ? "completed-prefix values must use indexed selection encoding"
        : "context value exceeds its byte bound",
      path: value.purpose === "completedPrefix" ? ["kind"] : ["utf8Bytes"],
    });
  }
});
const openedValueSchema = z.object({
  plaintext: z.string(),
  value: valueRecordSchema,
}).strict().superRefine((opened, context) => {
  if (Buffer.byteLength(opened.plaintext, "utf8") !== opened.value.utf8Bytes) {
    context.addIssue({
      code: "custom",
      message: "opened value byte length is incoherent",
      path: ["plaintext"],
    });
  }
});
const putResultSchema = z.object({ value: valueRecordSchema }).strict();
const prefixEncodingSchema = z.object({
  kind: z.literal("selection"),
  plaintext: z.string(),
  utf8Bytes: z.number().int().nonnegative().safe()
    .max(HARNESS_MAX_COMPLETED_PREFIX_CONTAINER_UTF8_BYTES),
}).strict().superRefine((encoding, context) => {
  if (Buffer.byteLength(encoding.plaintext, "utf8") !== encoding.utf8Bytes) {
    context.addIssue({
      code: "custom",
      message: "completed-prefix encoding byte length is incoherent",
      path: ["utf8Bytes"],
    });
  }
});

type MaterializationInput = z.infer<typeof materializationInputSchema>;
type MaterializationIds = HarnessDynamicToolContextMaterializationIdsV2;
type EncodedPrefix = HarnessDynamicToolCompletedPrefixEncodingV2 & Readonly<{
  index: CompletedPrefixContainerIndexV2;
}>;
type MaybePromise<Value> = Value | Promise<Value>;

export interface HarnessDynamicToolCompletedPrefixEncodingV2 {
  readonly kind: "selection";
  readonly plaintext: string;
  readonly utf8Bytes: number;
}

export interface HarnessDynamicToolCompletedPrefixEncoderPortV2 {
  encode(input: Readonly<{
    coverageWitnessDigest: string;
    completedThroughTurnId: string | null;
    items: readonly Readonly<{
      ordinal: number;
      itemClass: "userMessage" | "assistantMessage";
      text: string;
    }>[];
  }>): MaybePromise<unknown>;
}

export interface HarnessDynamicToolContextSnapshotPortV2 {
  read(snapshotId: string): MaybePromise<unknown>;
  create(snapshot: ContextSnapshotRecordV2): MaybePromise<unknown>;
}

export interface HarnessDynamicToolProgramAdmissionIntentPortV2 {
  prepare(input: Readonly<{
    runId: string;
    epochId: string;
    actorId: string;
    turnId: string;
    completedPrefixValueId: string;
    completedPrefixContentDigest: string;
    completedPrefixSnapshotId: string;
    completedThroughTurnId: string | null;
    currentUserInputValueId: string;
    programDigest: string;
    stableAdmissionIdentityDigest: string;
    coverageWitnessDigest: string;
    expiresAt: string;
  }>): MaybePromise<unknown>;
  markMaterialized(input: Readonly<{
    runId: string;
    expectedRevision: number;
  }>): MaybePromise<unknown>;
}

export interface HarnessDynamicToolContextMaterializerV2Options {
  readonly admissions: HarnessDynamicToolProgramAdmissionIntentPortV2;
  readonly snapshots: HarnessDynamicToolContextSnapshotPortV2;
  readonly values: HarnessContextOperationValuePortV2;
  readonly prefixEncoder?: HarnessDynamicToolCompletedPrefixEncoderPortV2;
  readonly now?: () => Date;
}

export type HarnessDynamicToolContextMaterializerV2ErrorCode =
  | "capacity_exceeded"
  | "conflict"
  | "corrupt_state"
  | "expired"
  | "invalid_input";

export class HarnessDynamicToolContextMaterializerV2Error extends Error {
  readonly code: HarnessDynamicToolContextMaterializerV2ErrorCode;

  constructor(
    code: HarnessDynamicToolContextMaterializerV2ErrorCode,
    cause?: unknown,
  ) {
    super({
      capacity_exceeded:
        "The indexed completed prefix exceeds its context-value capacity.",
      conflict: "The immutable dynamic-tool context admission conflicts.",
      corrupt_state: "Dynamic-tool context authority returned invalid evidence.",
      expired: "The actor context admission deadline has elapsed.",
      invalid_input: "The dynamic-tool context materialization input is invalid.",
    }[code], cause === undefined ? undefined : { cause });
    this.name = "HarnessDynamicToolContextMaterializerV2Error";
    this.code = code;
  }
}

/**
 * Verifies the already-published current input and publishes only the exact
 * completed prefix. Provider identities and cancellation never enter this
 * deterministic, replay-safe boundary.
 */
export class HarnessDynamicToolContextMaterializerV2
implements HarnessDynamicToolContextMaterializerPortV2 {
  readonly #admissions: HarnessDynamicToolProgramAdmissionIntentPortV2;
  readonly #snapshots: HarnessDynamicToolContextSnapshotPortV2;
  readonly #values: HarnessContextOperationValuePortV2;
  readonly #prefixEncoder: HarnessDynamicToolCompletedPrefixEncoderPortV2;
  readonly #now: () => Date;

  constructor(options: HarnessDynamicToolContextMaterializerV2Options) {
    this.#admissions = options.admissions;
    this.#snapshots = options.snapshots;
    this.#values = options.values;
    this.#prefixEncoder = options.prefixEncoder ??
      new HarnessDynamicToolIndexedSelectionPrefixEncoderV2();
    this.#now = options.now ?? (() => new Date());
  }

  async materialize(
    inputValue: HarnessDynamicToolContextMaterializationInputV2,
  ): Promise<HarnessDynamicToolContextMaterializationV2> {
    let input: MaterializationInput;
    try {
      input = materializationInputSchema.parse(inputValue);
    } catch (cause: unknown) {
      throw new HarnessDynamicToolContextMaterializerV2Error(
        "invalid_input",
        cause,
      );
    }
    const now = this.#timestamp();
    if (Date.parse(input.expiresAt) <= Date.parse(now)) {
      throw new HarnessDynamicToolContextMaterializerV2Error("expired");
    }

    const current = await this.#openCurrentInput(input);
    const prefix = await this.#encodePrefix(input);
    if (
      prefix.utf8Bytes > HARNESS_MAX_COMPLETED_PREFIX_CONTAINER_UTF8_BYTES ||
      prefix.utf8Bytes > current.quotaLimitBytes
    ) {
      throw new HarnessDynamicToolContextMaterializerV2Error(
        "capacity_exceeded",
      );
    }
    const prefixContentDigest =
      digestHarnessDynamicToolCompletedPrefixV2(prefix.plaintext);
    const ids = deriveHarnessDynamicToolContextMaterializationIds({
      epochId: input.epochId,
      actorId: input.actorId,
      completedThroughTurnId: input.completedThroughTurnId,
      expiresAt: input.expiresAt,
      coverageWitnessDigest: input.coverageWitnessDigest,
      prefixContentDigest,
    });
    const intent = await this.#prepareIntent(ids, input, prefixContentDigest);
    if (intent.state === "abandoned" || intent.state === "recoveryRequired") {
      throw new HarnessDynamicToolContextMaterializerV2Error("conflict");
    }
    const existing = await this.#readSnapshot(ids, input);
    if (existing !== null) {
      await this.#verifyPrefix(ids, input, prefix, current.quotaLimitBytes);
      await this.#markMaterialized(intent);
      return materializationResult(existing, input);
    }

    await this.#putAndVerifyPrefix(
      ids,
      input,
      prefix,
      current.quotaLimitBytes,
    );
    const proposed = contextSnapshotRecordV2Schema.parse({
      id: ids.completedPrefixSnapshotId,
      epochId: input.epochId,
      actorId: input.actorId,
      completedThroughTurnId: input.completedThroughTurnId,
      coverageWitnessDigest: input.coverageWitnessDigest,
      valueId: ids.completedPrefixValueId,
      createdAt: now,
      expiresAt: input.expiresAt,
    });
    let created: ContextSnapshotRecordV2;
    try {
      created = this.#parseSnapshot(await this.#snapshots.create(proposed));
      assertSnapshotIdentity(created, ids, input);
    } catch (cause: unknown) {
      if (cause instanceof HarnessDynamicToolContextMaterializerV2Error) {
        throw cause;
      }
      const raced = await this.#readSnapshot(ids, input);
      if (raced === null) {
        throw new HarnessDynamicToolContextMaterializerV2Error(
          "conflict",
          cause,
        );
      }
      created = raced;
    }
    const durable = await this.#readSnapshot(ids, input);
    if (durable === null || exactJson(durable) !== exactJson(created)) {
      throw new HarnessDynamicToolContextMaterializerV2Error("corrupt_state");
    }
    await this.#verifyPrefix(ids, input, prefix, current.quotaLimitBytes);
    await this.#markMaterialized(intent);
    return materializationResult(durable, input);
  }

  async #prepareIntent(
    ids: MaterializationIds,
    input: MaterializationInput,
    prefixContentDigest: string,
  ): Promise<ProgramAdmissionIntentRecordV2> {
    try {
      const intent = programAdmissionIntentRecordV2Schema.parse(
        await this.#admissions.prepare({
          runId: input.runId,
          epochId: input.epochId,
          actorId: input.actorId,
          turnId: input.turnId,
          completedPrefixValueId: ids.completedPrefixValueId,
          completedPrefixContentDigest: prefixContentDigest,
          completedPrefixSnapshotId: ids.completedPrefixSnapshotId,
          completedThroughTurnId: input.completedThroughTurnId,
          currentUserInputValueId: input.currentInputValueId,
          programDigest: input.programDigest,
          stableAdmissionIdentityDigest: input.stableAdmissionIdentityDigest,
          coverageWitnessDigest: input.coverageWitnessDigest,
          expiresAt: input.expiresAt,
        }),
      );
      assertIntentIdentity(intent, ids, input, prefixContentDigest);
      return intent;
    } catch (cause: unknown) {
      throw new HarnessDynamicToolContextMaterializerV2Error(
        "conflict",
        cause,
      );
    }
  }

  async #markMaterialized(
    intent: ProgramAdmissionIntentRecordV2,
  ): Promise<void> {
    try {
      const materialized = programAdmissionIntentRecordV2Schema.parse(
        await this.#admissions.markMaterialized({
          runId: intent.runId,
          expectedRevision: intent.revision,
        }),
      );
      if (
        materialized.runId !== intent.runId ||
        (materialized.state !== "materialized" &&
          materialized.state !== "admitted")
      ) {
        throw new TypeError("program admission intent did not materialize");
      }
    } catch (cause: unknown) {
      throw new HarnessDynamicToolContextMaterializerV2Error(
        "conflict",
        cause,
      );
    }
  }

  async #openCurrentInput(
    input: MaterializationInput,
  ): Promise<HarnessContextOperationValueRecordV2> {
    let opened: z.infer<typeof openedValueSchema>;
    try {
      opened = openedValueSchema.parse(await this.#values.openExact({
        epochId: input.epochId,
        ownerActorId: input.actorId,
        sourceTurnId: input.currentInputProvenance.sourceTurnId,
        valueId: input.currentInputValueId,
        kind: "text",
        purpose: input.currentInputProvenance.purpose,
      }));
    } catch (cause: unknown) {
      throw new HarnessDynamicToolContextMaterializerV2Error(
        "conflict",
        cause,
      );
    }
    if (
      opened.plaintext !== input.currentInput ||
      opened.value.epochId !== input.epochId ||
      opened.value.ownerActorId !== input.actorId ||
      opened.value.sourceTurnId !== input.currentInputProvenance.sourceTurnId ||
      opened.value.valueId !== input.currentInputValueId ||
      opened.value.kind !== "text" ||
      opened.value.purpose !== input.currentInputProvenance.purpose ||
      opened.value.nameDigest !== null
    ) {
      throw new HarnessDynamicToolContextMaterializerV2Error("conflict");
    }
    return opened.value;
  }

  async #putAndVerifyPrefix(
    ids: MaterializationIds,
    input: MaterializationInput,
    prefix: EncodedPrefix,
    quotaLimitBytes: number,
  ): Promise<void> {
    let result: z.infer<typeof putResultSchema>;
    try {
      result = putResultSchema.parse(await this.#values.putExact({
        operationId: ids.operationId,
        epochId: input.epochId,
        ownerActorId: input.actorId,
        sourceTurnId: input.completedThroughTurnId,
        valueId: ids.completedPrefixValueId,
        kind: prefix.kind,
        purpose: "completedPrefix",
        plaintext: prefix.plaintext,
        quotaLimitBytes,
        name: null,
      }));
    } catch (cause: unknown) {
      throw new HarnessDynamicToolContextMaterializerV2Error(
        "conflict",
        cause,
      );
    }
    assertPrefixMetadata(
      result.value,
      ids,
      input,
      prefix,
      quotaLimitBytes,
    );
  }

  async #verifyPrefix(
    ids: MaterializationIds,
    input: MaterializationInput,
    prefix: EncodedPrefix,
    quotaLimitBytes: number,
  ): Promise<void> {
    const expectedBytes = Buffer.from(prefix.plaintext, "utf8");
    try {
      await this.#values.withExactRangeReader({
        epochId: input.epochId,
        ownerActorId: input.actorId,
        sourceTurnId: input.completedThroughTurnId,
        valueId: ids.completedPrefixValueId,
        kind: "selection",
        purpose: "completedPrefix",
      }, async (reader) => {
        const value = valueRecordSchema.parse(reader.value);
        assertPrefixMetadata(value, ids, input, prefix, quotaLimitBytes);

        const preludeBytes = await reader.readRange({
          startByte: 0,
          endByteExclusive: COMPLETED_PREFIX_CONTAINER_V2_PRELUDE_BYTES,
        });
        let prelude: Readonly<{
          indexUtf8Bytes: number;
          payloadOffset: number;
        }>;
        try {
          prelude = parseCompletedPrefixContainerPreludeV2(preludeBytes);
        } finally {
          preludeBytes.fill(0);
        }
        if (prelude.payloadOffset > value.utf8Bytes) {
          throw new HarnessDynamicToolContextMaterializerV2Error("conflict");
        }

        const indexBytes = await reader.readRange({
          startByte: COMPLETED_PREFIX_CONTAINER_V2_PRELUDE_BYTES,
          endByteExclusive: prelude.payloadOffset,
        });
        let index: CompletedPrefixContainerIndexV2;
        try {
          index = parseCompletedPrefixContainerIndexV2(indexBytes, prelude);
        } finally {
          indexBytes.fill(0);
        }
        if (
          index.totalUtf8Bytes !== value.utf8Bytes ||
          exactJson(index) !== exactJson(prefix.index)
        ) {
          throw new HarnessDynamicToolContextMaterializerV2Error("conflict");
        }

        const itemIndexes = index.items.map((_, itemIndex) => itemIndex);
        for (const range of planCompletedPrefixContainerRangesV2(
          index,
          itemIndexes,
        )) {
          const stored = await reader.readRange({
            startByte: range.startByte,
            endByteExclusive: range.endByteExclusive,
          });
          try {
            if (!sameBytes(
              stored,
              expectedBytes.subarray(range.startByte, range.endByteExclusive),
            )) {
              throw new HarnessDynamicToolContextMaterializerV2Error(
                "conflict",
              );
            }
          } finally {
            stored.fill(0);
          }
        }
      });
    } catch (cause: unknown) {
      throw new HarnessDynamicToolContextMaterializerV2Error(
        "conflict",
        cause,
      );
    } finally {
      expectedBytes.fill(0);
    }
  }

  async #readSnapshot(
    ids: MaterializationIds,
    input: MaterializationInput,
  ): Promise<ContextSnapshotRecordV2 | null> {
    let source: unknown;
    try {
      source = await this.#snapshots.read(ids.completedPrefixSnapshotId);
    } catch (cause: unknown) {
      throw new HarnessDynamicToolContextMaterializerV2Error(
        "corrupt_state",
        cause,
      );
    }
    if (source === null) return null;
    const snapshot = this.#parseSnapshot(source);
    assertSnapshotIdentity(snapshot, ids, input);
    return snapshot;
  }

  #parseSnapshot(value: unknown): ContextSnapshotRecordV2 {
    try {
      return contextSnapshotRecordV2Schema.parse(value);
    } catch (cause: unknown) {
      throw new HarnessDynamicToolContextMaterializerV2Error(
        "corrupt_state",
        cause,
      );
    }
  }

  #timestamp(): string {
    try {
      return timestampSchema.parse(this.#now().toISOString());
    } catch (cause: unknown) {
      throw new HarnessDynamicToolContextMaterializerV2Error(
        "corrupt_state",
        cause,
      );
    }
  }

  async #encodePrefix(
    input: MaterializationInput,
  ): Promise<EncodedPrefix> {
    try {
      const encoding = prefixEncodingSchema.parse(
        await this.#prefixEncoder.encode({
          coverageWitnessDigest: input.coverageWitnessDigest,
          completedThroughTurnId: input.completedThroughTurnId,
          items: input.completedPrefix,
        }),
      );
      const parsed = parseCompletedPrefixContainerV2(encoding.plaintext);
      if (
        parsed.index.coverageWitnessDigest !== input.coverageWitnessDigest ||
        parsed.index.completedThroughTurnId !==
          input.completedThroughTurnId ||
        exactJson(parsed.items) !== exactJson(input.completedPrefix)
      ) {
        throw new TypeError("completed-prefix encoder changed its input");
      }
      return Object.freeze({ ...encoding, index: parsed.index });
    } catch (cause: unknown) {
      if (cause instanceof HarnessDynamicToolContextMaterializerV2Error) {
        throw cause;
      }
      throw new HarnessDynamicToolContextMaterializerV2Error(
        "corrupt_state",
        cause,
      );
    }
  }
}

export class HarnessDynamicToolIndexedSelectionPrefixEncoderV2
implements HarnessDynamicToolCompletedPrefixEncoderPortV2 {
  encode(input: Readonly<{
    coverageWitnessDigest: string;
    completedThroughTurnId: string | null;
    items: readonly Readonly<{
      ordinal: number;
      itemClass: "userMessage" | "assistantMessage";
      text: string;
    }>[];
  }>): HarnessDynamicToolCompletedPrefixEncodingV2 {
    const sourceUtf8Bytes = input.items.reduce(
      (total, item) => total + Buffer.byteLength(item.text, "utf8"),
      0,
    );
    if (sourceUtf8Bytes > HARNESS_MAX_COMPLETED_PREFIX_SOURCE_UTF8_BYTES) {
      throw new HarnessDynamicToolContextMaterializerV2Error(
        "capacity_exceeded",
      );
    }
    let plaintext: string;
    try {
      plaintext = packCompletedPrefixContainerV2(input).plaintext;
    } catch (cause: unknown) {
      if (cause instanceof RangeError) {
        throw new HarnessDynamicToolContextMaterializerV2Error(
          "capacity_exceeded",
          cause,
        );
      }
      throw cause;
    }
    return Object.freeze({
      kind: "selection",
      plaintext,
      utf8Bytes: Buffer.byteLength(plaintext, "utf8"),
    });
  }
}

function assertPrefixMetadata(
  value: HarnessContextOperationValueRecordV2,
  ids: MaterializationIds,
  input: MaterializationInput,
  prefix: HarnessDynamicToolCompletedPrefixEncodingV2,
  quotaLimitBytes: number,
): void {
  if (
    value.epochId !== input.epochId ||
    value.ownerActorId !== input.actorId ||
    value.sourceTurnId !== input.completedThroughTurnId ||
    value.valueId !== ids.completedPrefixValueId ||
    value.kind !== prefix.kind ||
    value.purpose !== "completedPrefix" ||
    value.nameDigest !== null ||
    value.utf8Bytes !== prefix.utf8Bytes ||
    value.quotaLimitBytes !== quotaLimitBytes
  ) {
    throw new HarnessDynamicToolContextMaterializerV2Error("conflict");
  }
}

function assertSnapshotIdentity(
  snapshot: ContextSnapshotRecordV2,
  ids: MaterializationIds,
  input: MaterializationInput,
): void {
  if (
    snapshot.id !== ids.completedPrefixSnapshotId ||
    snapshot.epochId !== input.epochId ||
    snapshot.actorId !== input.actorId ||
    snapshot.completedThroughTurnId !== input.completedThroughTurnId ||
    snapshot.coverageWitnessDigest !== input.coverageWitnessDigest ||
    snapshot.valueId !== ids.completedPrefixValueId ||
    snapshot.expiresAt !== input.expiresAt
  ) {
    throw new HarnessDynamicToolContextMaterializerV2Error("conflict");
  }
}

function assertIntentIdentity(
  intent: ProgramAdmissionIntentRecordV2,
  ids: MaterializationIds,
  input: MaterializationInput,
  prefixContentDigest: string,
): void {
  if (
    intent.runId !== input.runId || intent.epochId !== input.epochId ||
    intent.actorId !== input.actorId || intent.turnId !== input.turnId ||
    intent.completedPrefixValueId !== ids.completedPrefixValueId ||
    intent.completedPrefixContentDigest !== prefixContentDigest ||
    intent.completedPrefixSnapshotId !== ids.completedPrefixSnapshotId ||
    intent.completedThroughTurnId !== input.completedThroughTurnId ||
    intent.currentUserInputValueId !== input.currentInputValueId ||
    intent.programDigest !== input.programDigest ||
    intent.stableAdmissionIdentityDigest !==
      input.stableAdmissionIdentityDigest ||
    intent.coverageWitnessDigest !== input.coverageWitnessDigest ||
    intent.expiresAt !== input.expiresAt
  ) {
    throw new HarnessDynamicToolContextMaterializerV2Error("conflict");
  }
}

function materializationResult(
  snapshot: ContextSnapshotRecordV2,
  input: MaterializationInput,
): HarnessDynamicToolContextMaterializationV2 {
  return Object.freeze({
    completedPrefixSnapshotId: snapshot.id,
    currentUserInputValueId: input.currentInputValueId,
    coverageWitnessDigest: snapshot.coverageWitnessDigest,
  });
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
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

function exactJson(value: unknown): string {
  return JSON.stringify(value);
}
