import { createHash } from "node:crypto";

import { z } from "@hra-internal/schema";

import {
  actorEpochIdSchema,
  actorIdSchema,
  actorTurnIdSchema,
} from "./actor-domain";
import {
  COMPLETED_PREFIX_CONTAINER_V2_PRELUDE_BYTES,
  parseCompletedPrefixContainerIndexV2,
  parseCompletedPrefixContainerPreludeV2,
  planCompletedPrefixContainerRangesV2,
  type CompletedPrefixContainerIndexV2,
  type CompletedPrefixContainerItemV2,
} from "./completed-prefix-container-v2";
import type {
  HarnessContextOperationRangeReaderV2,
  HarnessContextOperationValuePortV2,
  HarnessContextOperationValueRecordV2,
  HarnessContextValueNameDigestPortV2,
} from "./context-value-ports-v2";
import {
  contextSnapshotRecordV2Schema,
} from "./context-snapshot-authority-v2";
import {
  HARNESS_MAX_COMPLETED_PREFIX_CONTAINER_UTF8_BYTES,
  HARNESS_MAX_CONTEXT_VALUE_UTF8_BYTES,
  contextSnapshotIdSchema,
  contextValueIdSchema,
} from "./domain";
import type {
  RlmV2ActorBinding,
  RlmV2ContextOperation,
  RlmV2ContextOperationPort,
} from "./rlm-operation-router-v2";
import type { RlmV2JsonValue } from "./rlm-v2";

const MAX_QUERY_CHARACTERS = 4_096;
const MAX_SELECTION_ITEMS = 64;
const MAX_RETURNED_TEXT_UTF8_BYTES = 512 * 1_024;
const VALUE_PAGE_SIZE = 128;
const MAX_VALUE_SCAN = 4_096;

const valueMetadataSchema = z.object({
  valueId: contextValueIdSchema,
  epochId: actorEpochIdSchema,
  ownerActorId: actorIdSchema,
  sourceTurnId: actorTurnIdSchema.nullable(),
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
  nameDigest: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  utf8Bytes: z.number().int().nonnegative()
    .max(HARNESS_MAX_COMPLETED_PREFIX_CONTAINER_UTF8_BYTES),
  quotaLimitBytes: z.number().int().min(1024 * 1024)
    .max(64 * 1024 * 1024),
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
        : "context value exceeds its byte limit",
      path: value.purpose === "completedPrefix" ? ["kind"] : ["utf8Bytes"],
    });
  }
});

const openedValueSchema = z.object({
  plaintext: z.string(),
  value: valueMetadataSchema,
}).strict().superRefine((value, context) => {
  if (Buffer.byteLength(value.plaintext, "utf8") !== value.value.utf8Bytes) {
    context.addIssue({
      code: "custom",
      message: "opened context value byte length is incoherent",
      path: ["plaintext"],
    });
  }
});

const putResultSchema = z.object({
  value: valueMetadataSchema,
}).strict();

const searchArgumentsSchema = z.object({
  snapshotId: contextSnapshotIdSchema.optional(),
  query: z.string().min(1).max(MAX_QUERY_CHARACTERS),
  limit: z.number().int().min(1).max(MAX_SELECTION_ITEMS).default(16),
}).strict();

const sliceArgumentsSchema = z.object({
  snapshotId: contextSnapshotIdSchema.optional(),
  startOrdinal: z.number().int().nonnegative().safe(),
  endOrdinal: z.number().int().nonnegative().safe(),
  limit: z.number().int().min(1).max(MAX_SELECTION_ITEMS)
    .default(MAX_SELECTION_ITEMS),
}).strict().superRefine((value, context) => {
  if (value.endOrdinal < value.startOrdinal) {
    context.addIssue({
      code: "custom",
      message: "slice end must not precede its start",
      path: ["endOrdinal"],
    });
  }
});

const materializeArgumentsSchema = z.object({
  snapshotId: contextSnapshotIdSchema.optional(),
  ordinals: z.array(z.number().int().nonnegative().safe())
    .min(1).max(MAX_SELECTION_ITEMS)
    .refine((values) => new Set(values).size === values.length),
  format: z.enum(["text", "json"]).default("text"),
}).strict();

const heapPutArgumentsSchema = z.object({
  name: z.string().min(1).max(96).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/u),
  value: z.unknown(),
  format: z.enum(["text", "json"]).default("json"),
}).strict();

const heapGetArgumentsSchema = z.union([
  z.object({ valueId: contextValueIdSchema }).strict(),
  z.object({
    name: z.string().min(1).max(96).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/u),
  }).strict(),
]);

const heapListArgumentsSchema = z.object({
  afterValueId: contextValueIdSchema.nullable().default(null),
  limit: z.number().int().min(1).max(64).default(16),
}).strict();

type MaybePromise<T> = T | Promise<T>;

export interface RlmV2ContextSnapshotReadPort {
  read(snapshotId: string): MaybePromise<unknown>;
}

export interface RlmV2ContextOperationServiceOptions {
  readonly snapshots: RlmV2ContextSnapshotReadPort;
  readonly values: HarnessContextOperationValuePortV2;
  readonly names: HarnessContextValueNameDigestPortV2;
  readonly now?: () => Date;
}

export class RlmV2ContextOperationServiceError extends Error {
  readonly code: "conflict" | "invalid_request" | "not_found";

  constructor(
    code: RlmV2ContextOperationServiceError["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RlmV2ContextOperationServiceError";
    this.code = code;
  }
}

/** Closed, deterministic context and heap operations for one durable RLM caller. */
export class RlmV2ContextOperationService implements RlmV2ContextOperationPort {
  readonly #snapshots: RlmV2ContextSnapshotReadPort;
  readonly #values: HarnessContextOperationValuePortV2;
  readonly #names: HarnessContextValueNameDigestPortV2;
  readonly #now: () => Date;

  constructor(options: RlmV2ContextOperationServiceOptions) {
    this.#snapshots = options.snapshots;
    this.#values = options.values;
    this.#names = options.names;
    this.#now = options.now ?? (() => new Date());
  }

  async invoke(
    operation: RlmV2ContextOperation,
    argumentsValue: Readonly<Record<string, RlmV2JsonValue>>,
    input: Readonly<{
      binding: RlmV2ActorBinding;
      receiptId: string;
      signal: AbortSignal;
    }>,
  ): Promise<unknown> {
    throwIfAborted(input.signal);
    switch (operation) {
      case "context.snapshot":
        return await this.#snapshot(argumentsValue, input.binding);
      case "context.search":
        return await this.#search(argumentsValue, input.binding, input.signal);
      case "context.slice":
        return await this.#slice(argumentsValue, input.binding, input.signal);
      case "context.materialize":
        return await this.#materialize(argumentsValue, input, input.signal);
      case "heap.put":
        return await this.#heapPut(argumentsValue, input, input.signal);
      case "heap.get":
        return await this.#heapGet(argumentsValue, input.binding, input.signal);
      case "heap.list":
        return await this.#heapList(argumentsValue, input.binding);
    }
  }

  async #snapshot(
    argumentsValue: unknown,
    binding: RlmV2ActorBinding,
  ): Promise<unknown> {
    z.object({}).strict().parse(argumentsValue);
    const snapshot = await this.#requireSnapshot(
      binding.completedPrefixSnapshotId,
      binding,
    );
    return Object.freeze({
      snapshotId: snapshot.id,
      completedThroughTurnId: snapshot.completedThroughTurnId,
      coverageWitnessDigest: snapshot.coverageWitnessDigest,
      currentInputValueId: binding.currentUserInputValueId,
    });
  }

  async #search(
    argumentsValue: unknown,
    binding: RlmV2ActorBinding,
    signal: AbortSignal,
  ): Promise<unknown> {
    const arguments_ = searchArgumentsSchema.parse(argumentsValue);
    const snapshotId = arguments_.snapshotId ??
      binding.completedPrefixSnapshotId;
    const needle = arguments_.query.toLowerCase();
    return await this.#withPrefixIndex(
      snapshotId,
      binding,
      signal,
      async ({ reader, index }) => {
        const matches: CompletedPrefixContainerItemV2[] = [];
        let returnedBytes = 0;
        for (let itemIndex = 0; itemIndex < index.items.length; itemIndex += 1) {
          throwIfAborted(signal);
          const [item] = await readIndexedPrefixItems(
            reader,
            index,
            [itemIndex],
            signal,
          );
          if (item === undefined) conflict("completed-prefix item is unavailable");
          if (!item.text.toLowerCase().includes(needle)) continue;
          if (
            returnedBytes + index.items[itemIndex]!.utf8Bytes >
              MAX_RETURNED_TEXT_UTF8_BYTES
          ) break;
          matches.push(item);
          returnedBytes += index.items[itemIndex]!.utf8Bytes;
          if (matches.length === arguments_.limit) break;
        }
        return Object.freeze({
          snapshotId,
          matches: Object.freeze(matches),
        });
      },
    );
  }

  async #slice(
    argumentsValue: unknown,
    binding: RlmV2ActorBinding,
    signal: AbortSignal,
  ): Promise<unknown> {
    const arguments_ = sliceArgumentsSchema.parse(argumentsValue);
    const snapshotId = arguments_.snapshotId ?? binding.completedPrefixSnapshotId;
    return await this.#withPrefixIndex(
      snapshotId,
      binding,
      signal,
      async ({ reader, index }) => {
        const itemIndexes: number[] = [];
        let returnedBytes = 0;
        for (let itemIndex = 0; itemIndex < index.items.length; itemIndex += 1) {
          throwIfAborted(signal);
          const item = index.items[itemIndex]!;
          if (item.ordinal < arguments_.startOrdinal) continue;
          if (item.ordinal > arguments_.endOrdinal) break;
          if (
            returnedBytes + item.utf8Bytes > MAX_RETURNED_TEXT_UTF8_BYTES
          ) break;
          itemIndexes.push(itemIndex);
          returnedBytes += item.utf8Bytes;
          if (itemIndexes.length === arguments_.limit) break;
        }
        const items = await readIndexedPrefixItems(
          reader,
          index,
          itemIndexes,
          signal,
        );
        return Object.freeze({ snapshotId, items });
      },
    );
  }

  async #materialize(
    argumentsValue: unknown,
    input: Readonly<{
      binding: RlmV2ActorBinding;
      receiptId: string;
    }>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const arguments_ = materializeArgumentsSchema.parse(argumentsValue);
    const snapshotId = arguments_.snapshotId ??
      input.binding.completedPrefixSnapshotId;
    const requested = new Set(arguments_.ordinals);
    const selected = await this.#withPrefixIndex(
      snapshotId,
      input.binding,
      signal,
      async ({ reader, index }) => {
        const itemIndexes: number[] = [];
        for (let itemIndex = 0; itemIndex < index.items.length; itemIndex += 1) {
          throwIfAborted(signal);
          if (requested.has(index.items[itemIndex]!.ordinal)) {
            itemIndexes.push(itemIndex);
          }
        }
        if (itemIndexes.length !== requested.size) {
          throw new RlmV2ContextOperationServiceError(
            "not_found",
            "one or more requested completed-prefix items are unavailable",
          );
        }
        return await readIndexedPrefixItems(
          reader,
          index,
          itemIndexes,
          signal,
        );
      },
    );
    throwIfAborted(signal);
    const plaintext = arguments_.format === "json"
      ? canonicalJson(selected)
      : selected.map((item) => item.text).join("\n\n");
    const identity = derivedValueIdentity("materialize", input.receiptId);
    const result = putResultSchema.parse(await this.#values.putExact({
      operationId: identity.operationId,
      epochId: input.binding.epochId,
      ownerActorId: input.binding.actorId,
      sourceTurnId: input.binding.turnId,
      valueId: identity.valueId,
      kind: arguments_.format === "json" ? "json" : "selection",
      purpose: "heap",
      name: null,
      plaintext,
      quotaLimitBytes: input.binding.contextQuotaBytes,
    }));
    assertWrittenValue(result.value, input.binding, {
      valueId: identity.valueId,
      sourceTurnId: input.binding.turnId,
      kind: arguments_.format === "json" ? "json" : "selection",
      nameDigest: null,
      plaintext,
    });
    return publicValue(result.value);
  }

  async #heapPut(
    argumentsValue: unknown,
    input: Readonly<{
      binding: RlmV2ActorBinding;
      receiptId: string;
    }>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const arguments_ = heapPutArgumentsSchema.parse(argumentsValue);
    const plaintext = arguments_.format === "text"
      ? z.string().parse(arguments_.value)
      : canonicalJson(arguments_.value);
    throwIfAborted(signal);
    const identity = derivedValueIdentity("heap-put", input.receiptId);
    const nameDigest = await this.#digestName(
      input.binding,
      arguments_.name,
    );
    throwIfAborted(signal);
    const result = putResultSchema.parse(await this.#values.putExact({
      operationId: identity.operationId,
      epochId: input.binding.epochId,
      ownerActorId: input.binding.actorId,
      sourceTurnId: input.binding.turnId,
      valueId: identity.valueId,
      kind: arguments_.format,
      purpose: "heap",
      name: arguments_.name,
      plaintext,
      quotaLimitBytes: input.binding.contextQuotaBytes,
    }));
    assertWrittenValue(result.value, input.binding, {
      valueId: identity.valueId,
      sourceTurnId: input.binding.turnId,
      kind: arguments_.format,
      nameDigest,
      plaintext,
    });
    return publicValue(result.value);
  }

  async #heapGet(
    argumentsValue: unknown,
    binding: RlmV2ActorBinding,
    signal: AbortSignal,
  ): Promise<unknown> {
    const arguments_ = heapGetArgumentsSchema.parse(argumentsValue);
    const metadata = "valueId" in arguments_
      ? await this.#findHeapValueById(binding, arguments_.valueId)
      : await this.#findHeapValueByName(binding, arguments_.name);
    const raw: unknown = await this.#values.openExact({
      epochId: binding.epochId,
      ownerActorId: binding.actorId,
      sourceTurnId: metadata.sourceTurnId,
      valueId: metadata.valueId,
      kind: metadata.kind,
      purpose: "heap",
    });
    throwIfAborted(signal);
    const opened = openedValueSchema.parse(raw);
    assertSameValue(opened.value, metadata);
    assertValueOwner(opened.value, binding, "heap");
    return Object.freeze({
      valueId: opened.value.valueId,
      kind: opened.value.kind,
      value: opened.value.kind === "json"
        ? parseJson(opened.plaintext)
        : opened.plaintext,
    });
  }

  async #heapList(
    argumentsValue: unknown,
    binding: RlmV2ActorBinding,
  ): Promise<unknown> {
    const arguments_ = heapListArgumentsSchema.parse(argumentsValue);
    const values = await this.#listHeapValues(
      binding,
      arguments_.afterValueId,
      arguments_.limit,
    );
    return Object.freeze(values.map((value) => Object.freeze({
      valueId: value.valueId,
      kind: value.kind,
      utf8Bytes: value.utf8Bytes,
    })));
  }

  async #withPrefixIndex<Result>(
    snapshotId: string,
    binding: RlmV2ActorBinding,
    signal: AbortSignal,
    operation: (input: Readonly<{
      reader: HarnessContextOperationRangeReaderV2;
      index: CompletedPrefixContainerIndexV2;
    }>) => Promise<Result> | Result,
  ): Promise<Result> {
    const snapshot = await this.#requireSnapshot(snapshotId, binding);
    throwIfAborted(signal);
    return await this.#values.withExactRangeReader({
      epochId: binding.epochId,
      ownerActorId: binding.actorId,
      sourceTurnId: snapshot.completedThroughTurnId,
      valueId: snapshot.valueId,
      kind: "selection",
      purpose: "completedPrefix",
    }, async (reader) => {
      throwIfAborted(signal);
      const value = valueMetadataSchema.parse(reader.value);
      assertValueOwner(value, binding, "completedPrefix");
      if (
        value.sourceTurnId !== snapshot.completedThroughTurnId ||
        value.valueId !== snapshot.valueId ||
        value.kind !== "selection" ||
        value.nameDigest !== null ||
        value.quotaLimitBytes !== binding.contextQuotaBytes
      ) conflict("completed-prefix value identity changed");
      const index = await readCompletedPrefixIndex(
        reader,
        value.utf8Bytes,
        signal,
      );
      if (
        index.coverageWitnessDigest !== snapshot.coverageWitnessDigest ||
        index.completedThroughTurnId !== snapshot.completedThroughTurnId ||
        index.totalUtf8Bytes !== value.utf8Bytes
      ) conflict("completed-prefix value does not match its snapshot witness");
      return await operation(Object.freeze({ reader, index }));
    });
  }

  async #digestName(binding: RlmV2ActorBinding, name: string): Promise<string> {
    const source: unknown = await this.#names.digestName({
      epochId: binding.epochId,
      ownerActorId: binding.actorId,
      name,
    });
    return z.string().regex(/^[a-f0-9]{64}$/u).parse(source);
  }

  async #findHeapValueById(
    binding: RlmV2ActorBinding,
    valueId: string,
  ): Promise<z.infer<typeof valueMetadataSchema>> {
    let afterValueId: string | null = null;
    let scanned = 0;
    while (scanned < MAX_VALUE_SCAN) {
      const values = await this.#listActorPage(binding, afterValueId);
      for (const value of values) {
        scanned += 1;
        if (value.valueId === valueId) {
          if (value.purpose !== "heap") conflict("requested value is not heap data");
          return value;
        }
      }
      if (values.length < VALUE_PAGE_SIZE) break;
      afterValueId = values.at(-1)!.valueId;
    }
    if (scanned >= MAX_VALUE_SCAN) conflict("heap lookup exceeded its scan bound");
    throw new RlmV2ContextOperationServiceError(
      "not_found",
      "heap value is unavailable",
    );
  }

  async #findHeapValueByName(
    binding: RlmV2ActorBinding,
    name: string,
  ): Promise<z.infer<typeof valueMetadataSchema>> {
    const nameDigest = await this.#digestName(binding, name);
    let afterValueId: string | null = null;
    let scanned = 0;
    let match: z.infer<typeof valueMetadataSchema> | null = null;
    let exhausted = false;
    while (scanned < MAX_VALUE_SCAN) {
      const values = await this.#listActorPage(binding, afterValueId);
      for (const value of values) {
        scanned += 1;
        if (value.purpose !== "heap" || value.nameDigest !== nameDigest) continue;
        if (match !== null) conflict("heap name resolves to multiple values");
        match = value;
      }
      if (values.length < VALUE_PAGE_SIZE) {
        exhausted = true;
        break;
      }
      afterValueId = values.at(-1)!.valueId;
    }
    if (!exhausted && scanned >= MAX_VALUE_SCAN) {
      conflict("heap name lookup exceeded its scan bound");
    }
    if (match === null) {
      throw new RlmV2ContextOperationServiceError(
        "not_found",
        "named heap value is unavailable",
      );
    }
    return match;
  }

  async #listHeapValues(
    binding: RlmV2ActorBinding,
    afterValueIdValue: string | null,
    limit: number,
  ): Promise<readonly z.infer<typeof valueMetadataSchema>[]> {
    const output: z.infer<typeof valueMetadataSchema>[] = [];
    let afterValueId = afterValueIdValue;
    let scanned = 0;
    let exhausted = false;
    while (output.length < limit && scanned < MAX_VALUE_SCAN) {
      const values = await this.#listActorPage(binding, afterValueId);
      for (const value of values) {
        scanned += 1;
        if (value.purpose === "heap") {
          output.push(value);
          if (output.length === limit) break;
        }
      }
      if (values.length < VALUE_PAGE_SIZE) {
        exhausted = true;
        break;
      }
      if (output.length === limit) break;
      afterValueId = values.at(-1)!.valueId;
    }
    if (!exhausted && output.length < limit && scanned >= MAX_VALUE_SCAN) {
      conflict("heap list exceeded its scan bound");
    }
    return Object.freeze(output);
  }

  async #listActorPage(
    binding: RlmV2ActorBinding,
    afterValueId: string | null,
  ): Promise<readonly z.infer<typeof valueMetadataSchema>[]> {
    const source: unknown = await this.#values.listActive({
      epochId: binding.epochId,
      ownerActorId: binding.actorId,
      afterValueId,
      limit: VALUE_PAGE_SIZE,
    });
    const values = z.array(valueMetadataSchema).max(VALUE_PAGE_SIZE).parse(source);
    let previous = afterValueId;
    for (const value of values) {
      assertValueOwner(value, binding, value.purpose);
      if (previous !== null && value.valueId <= previous) {
        conflict("context-value page is duplicated or out of order");
      }
      previous = value.valueId;
    }
    return Object.freeze(values);
  }

  async #requireSnapshot(
    snapshotId: string,
    binding: RlmV2ActorBinding,
  ) {
    if (snapshotId !== binding.completedPrefixSnapshotId) {
      throw new RlmV2ContextOperationServiceError(
        "conflict",
        "RLM context operation requested a snapshot outside its admission",
      );
    }
    const snapshot = contextSnapshotRecordV2Schema.parse(
      await this.#snapshots.read(snapshotId),
    );
    if (
      snapshot.epochId !== binding.epochId ||
      snapshot.actorId !== binding.actorId ||
      (snapshot.expiresAt !== null &&
        Date.parse(snapshot.expiresAt) <= this.#now().getTime())
    ) conflict("RLM completed-prefix snapshot is unavailable");
    return snapshot;
  }
}

async function readCompletedPrefixIndex(
  reader: HarnessContextOperationRangeReaderV2,
  valueUtf8Bytes: number,
  signal: AbortSignal,
): Promise<CompletedPrefixContainerIndexV2> {
  throwIfAborted(signal);
  const preludeBytes = await reader.readRange({
    startByte: 0,
    endByteExclusive: COMPLETED_PREFIX_CONTAINER_V2_PRELUDE_BYTES,
  });
  let prelude: Readonly<{
    indexUtf8Bytes: number;
    payloadOffset: number;
  }>;
  try {
    throwIfAborted(signal);
    prelude = parseCompletedPrefixContainerPreludeV2(preludeBytes);
  } finally {
    preludeBytes.fill(0);
  }
  if (prelude.payloadOffset > valueUtf8Bytes) {
    conflict("completed-prefix index exceeds its value");
  }

  throwIfAborted(signal);
  const indexBytes = await reader.readRange({
    startByte: COMPLETED_PREFIX_CONTAINER_V2_PRELUDE_BYTES,
    endByteExclusive: prelude.payloadOffset,
  });
  try {
    throwIfAborted(signal);
    return parseCompletedPrefixContainerIndexV2(indexBytes, prelude);
  } finally {
    indexBytes.fill(0);
  }
}

async function readIndexedPrefixItems(
  reader: HarnessContextOperationRangeReaderV2,
  index: CompletedPrefixContainerIndexV2,
  itemIndexes: readonly number[],
  signal: AbortSignal,
): Promise<readonly CompletedPrefixContainerItemV2[]> {
  const ranges = planCompletedPrefixContainerRangesV2(index, itemIndexes);
  const items: CompletedPrefixContainerItemV2[] = [];
  let itemCursor = 0;
  for (const range of ranges) {
    throwIfAborted(signal);
    const bytes = await reader.readRange({
      startByte: range.startByte,
      endByteExclusive: range.endByteExclusive,
    });
    try {
      throwIfAborted(signal);
      while (
        itemCursor < itemIndexes.length &&
        itemIndexes[itemCursor]! <= range.lastItemIndex
      ) {
        const itemIndex = itemIndexes[itemCursor]!;
        if (itemIndex < range.firstItemIndex) {
          conflict("completed-prefix range plan is incoherent");
        }
        const item = index.items[itemIndex]!;
        const startByte = index.payloadOffset + item.utf8Offset -
          range.startByte;
        const endByteExclusive = startByte + item.utf8Bytes;
        if (
          startByte < 0 || endByteExclusive < startByte ||
          endByteExclusive > bytes.byteLength
        ) conflict("completed-prefix item range is incoherent");
        items.push(Object.freeze({
          ordinal: item.ordinal,
          itemClass: item.itemClass,
          text: decodePrefixUtf8(bytes.subarray(startByte, endByteExclusive)),
        }));
        itemCursor += 1;
      }
    } finally {
      bytes.fill(0);
    }
  }
  if (itemCursor !== itemIndexes.length) {
    conflict("completed-prefix range plan omitted an item");
  }
  return Object.freeze(items);
}

function decodePrefixUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(bytes);
  } catch (cause: unknown) {
    throw new RlmV2ContextOperationServiceError(
      "conflict",
      "completed-prefix item is not valid UTF-8",
      cause,
    );
  }
}

function assertValueOwner(
  value: z.infer<typeof valueMetadataSchema>,
  binding: RlmV2ActorBinding,
  purpose: HarnessContextOperationValueRecordV2["purpose"],
): void {
  if (
    value.epochId !== binding.epochId ||
    value.ownerActorId !== binding.actorId || value.purpose !== purpose
  ) conflict("context value does not belong to the durable caller");
}

function assertWrittenValue(
  value: z.infer<typeof valueMetadataSchema>,
  binding: RlmV2ActorBinding,
  expected: Readonly<{
    valueId: string;
    sourceTurnId: string;
    kind: "text" | "json" | "selection";
    nameDigest: string | null;
    plaintext: string;
  }>,
): void {
  assertValueOwner(value, binding, "heap");
  if (
    value.valueId !== expected.valueId ||
    value.sourceTurnId !== expected.sourceTurnId ||
    value.kind !== expected.kind ||
    value.nameDigest !== expected.nameDigest ||
    value.utf8Bytes !== Buffer.byteLength(expected.plaintext, "utf8") ||
    value.quotaLimitBytes !== binding.contextQuotaBytes
  ) conflict("written context value identity changed");
}

function assertSameValue(
  observed: z.infer<typeof valueMetadataSchema>,
  expected: z.infer<typeof valueMetadataSchema>,
): void {
  if (canonicalJson(observed) !== canonicalJson(expected)) {
    conflict("opened context value metadata changed");
  }
}

function publicValue(
  value: z.infer<typeof valueMetadataSchema>,
): Readonly<{ valueId: string; kind: string; utf8Bytes: number }> {
  return Object.freeze({
    valueId: value.valueId,
    kind: value.kind,
    utf8Bytes: value.utf8Bytes,
  });
}

function derivedValueIdentity(
  purpose: "materialize" | "heap-put",
  receiptId: string,
): Readonly<{ operationId: string; valueId: string }> {
  const digest = createHash("sha256")
    .update("oprte.rlm.context-operation.v2\0", "utf8")
    .update(purpose, "utf8")
    .update("\0", "utf8")
    .update(receiptId, "utf8")
    .digest("hex");
  return Object.freeze({
    operationId: `contextop_${digest.slice(0, 48)}`,
    valueId: `ctxval_${digest.slice(0, 48)}`,
  });
}

function parseJson(value: string): RlmV2JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (cause: unknown) {
    throw new RlmV2ContextOperationServiceError(
      "conflict",
      "stored JSON context value is invalid",
      cause,
    );
  }
  return jsonValueSchema.parse(parsed);
}

const jsonValueSchema: z.ZodType<RlmV2JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

function canonicalJson(value: unknown): string {
  const parsed = jsonValueSchema.parse(value);
  return canonicalize(parsed);
}

function canonicalize(value: RlmV2JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Readonly<Record<string, RlmV2JsonValue>>;
  const fields: string[] = [];
  for (const key of Object.keys(record).toSorted()) {
    const child: unknown = record[key];
    fields.push(`${JSON.stringify(key)}:${canonicalize(jsonValueSchema.parse(child))}`);
  }
  return `{${fields.join(",")}}`;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("RLM context operation aborted");
}

function conflict(message: string): never {
  throw new RlmV2ContextOperationServiceError("conflict", message);
}
