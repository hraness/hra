import { z } from "@hra-internal/schema";

import { actorTurnIdSchema } from "./actor-domain";
import {
  HARNESS_MAX_COMPLETED_PREFIX_CONTAINER_UTF8_BYTES,
  HARNESS_MAX_COMPLETED_PREFIX_ITEMS,
  HARNESS_MAX_COMPLETED_PREFIX_ITEM_UTF8_BYTES,
  HARNESS_MAX_COMPLETED_PREFIX_SOURCE_UTF8_BYTES,
} from "./domain";

// Serialized v2 containers already exist with this exact predecessor magic.
// Renaming it would change authenticated/protocol bytes rather than identity.
const LEGACY_OPRTE_PRELUDE_MAGIC = "OPRTE_COMPLETED_PREFIX_V2\n";
const INDEX_BYTE_LENGTH_WIDTH = 6;
const ITEM_COUNT_WIDTH = 3;
const SOURCE_BYTE_LENGTH_WIDTH = 5;
const ORDINAL_WIDTH = 11;
const ITEM_OFFSET_WIDTH = 5;
const ITEM_BYTE_LENGTH_WIDTH = 4;
const ITEM_RECORD_BYTES = ORDINAL_WIDTH + 1 +
  ITEM_OFFSET_WIDTH + ITEM_BYTE_LENGTH_WIDTH + 1;

export const COMPLETED_PREFIX_CONTAINER_V2_PRELUDE_BYTES =
  Buffer.byteLength(LEGACY_OPRTE_PRELUDE_MAGIC, "utf8") +
  INDEX_BYTE_LENGTH_WIDTH + 1;

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const itemSchema = z.object({
  ordinal: z.number().int().nonnegative().safe(),
  itemClass: z.enum(["userMessage", "assistantMessage"]),
  text: z.string()
    .refine(isWellFormedUtf16, "completed-prefix item is not valid Unicode")
    .refine(
      (text) => Buffer.byteLength(text, "utf8") <=
        HARNESS_MAX_COMPLETED_PREFIX_ITEM_UTF8_BYTES,
      "completed-prefix item exceeds its byte limit",
    ),
}).strict();
const inputSchema = z.object({
  coverageWitnessDigest: digestSchema,
  completedThroughTurnId: actorTurnIdSchema.nullable(),
  items: z.array(itemSchema).max(HARNESS_MAX_COMPLETED_PREFIX_ITEMS),
}).strict().superRefine((input, context) => {
  let sourceUtf8Bytes = 0;
  for (let index = 0; index < input.items.length; index += 1) {
    const item = input.items[index]!;
    sourceUtf8Bytes += Buffer.byteLength(item.text, "utf8");
    if (index > 0 && input.items[index - 1]!.ordinal >= item.ordinal) {
      context.addIssue({
        code: "custom",
        message: "completed-prefix ordinals must be strictly increasing",
        path: ["items", index, "ordinal"],
      });
      break;
    }
  }
  if (sourceUtf8Bytes > HARNESS_MAX_COMPLETED_PREFIX_SOURCE_UTF8_BYTES) {
    context.addIssue({
      code: "custom",
      message: "completed-prefix source exceeds its byte limit",
      path: ["items"],
    });
  }
});

export interface CompletedPrefixContainerItemV2 {
  readonly ordinal: number;
  readonly itemClass: "userMessage" | "assistantMessage";
  readonly text: string;
}

export interface CompletedPrefixContainerInputV2 {
  readonly coverageWitnessDigest: string;
  readonly completedThroughTurnId: string | null;
  readonly items: readonly CompletedPrefixContainerItemV2[];
}

export interface CompletedPrefixContainerIndexItemV2 {
  readonly ordinal: number;
  readonly itemClass: "userMessage" | "assistantMessage";
  readonly utf8Offset: number;
  readonly utf8Bytes: number;
}

export interface CompletedPrefixContainerIndexV2 {
  readonly version: 2;
  readonly coverageWitnessDigest: string;
  readonly completedThroughTurnId: string | null;
  readonly indexUtf8Bytes: number;
  readonly payloadOffset: number;
  readonly sourceUtf8Bytes: number;
  readonly totalUtf8Bytes: number;
  readonly items: readonly CompletedPrefixContainerIndexItemV2[];
}

export interface CompletedPrefixContainerV2 {
  readonly plaintext: string;
  readonly index: CompletedPrefixContainerIndexV2;
}

export interface CompletedPrefixContainerRangeV2 {
  readonly startByte: number;
  readonly endByteExclusive: number;
  readonly firstItemIndex: number;
  readonly lastItemIndex: number;
}

export function packCompletedPrefixContainerV2(
  inputValue: CompletedPrefixContainerInputV2,
): CompletedPrefixContainerV2 {
  const input = inputSchema.parse(inputValue);
  const payload: string[] = [];
  const records: string[] = [];
  const items: CompletedPrefixContainerIndexItemV2[] = [];
  let utf8Offset = 0;
  for (const item of input.items) {
    const utf8Bytes = Buffer.byteLength(item.text, "utf8");
    records.push(
      encodeBase36(item.ordinal, ORDINAL_WIDTH) +
        (item.itemClass === "userMessage" ? "u" : "a") +
        encodeBase36(utf8Offset, ITEM_OFFSET_WIDTH) +
        encodeBase36(utf8Bytes, ITEM_BYTE_LENGTH_WIDTH) + "\n",
    );
    items.push(Object.freeze({
      ordinal: item.ordinal,
      itemClass: item.itemClass,
      utf8Offset,
      utf8Bytes,
    }));
    payload.push(item.text);
    utf8Offset += utf8Bytes;
  }
  const indexPlaintext = [
    `${input.coverageWitnessDigest}\n`,
    `${input.completedThroughTurnId ?? "-"}\n`,
    `${encodeBase36(items.length, ITEM_COUNT_WIDTH)}\n`,
    `${encodeBase36(utf8Offset, SOURCE_BYTE_LENGTH_WIDTH)}\n`,
    ...records,
  ].join("");
  const indexUtf8Bytes = Buffer.byteLength(indexPlaintext, "utf8");
  const prelude = LEGACY_OPRTE_PRELUDE_MAGIC +
    encodeBase36(indexUtf8Bytes, INDEX_BYTE_LENGTH_WIDTH) + "\n";
  const plaintext = prelude + indexPlaintext + payload.join("");
  const totalUtf8Bytes = Buffer.byteLength(plaintext, "utf8");
  if (totalUtf8Bytes > HARNESS_MAX_COMPLETED_PREFIX_CONTAINER_UTF8_BYTES) {
    throw new RangeError("completed-prefix container exceeds its byte limit");
  }
  return Object.freeze({
    plaintext,
    index: freezeIndex({
      version: 2,
      coverageWitnessDigest: input.coverageWitnessDigest,
      completedThroughTurnId: input.completedThroughTurnId,
      indexUtf8Bytes,
      payloadOffset: COMPLETED_PREFIX_CONTAINER_V2_PRELUDE_BYTES + indexUtf8Bytes,
      sourceUtf8Bytes: utf8Offset,
      totalUtf8Bytes,
      items,
    }),
  });
}

export function parseCompletedPrefixContainerPreludeV2(
  value: Uint8Array | string,
): Readonly<{ indexUtf8Bytes: number; payloadOffset: number }> {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  if (bytes.byteLength !== COMPLETED_PREFIX_CONTAINER_V2_PRELUDE_BYTES) {
    throw new TypeError("completed-prefix prelude has the wrong byte length");
  }
  const plaintext = decodeUtf8(bytes);
  if (
    !plaintext.startsWith(LEGACY_OPRTE_PRELUDE_MAGIC) ||
    !plaintext.endsWith("\n")
  ) {
    throw new TypeError("completed-prefix prelude is invalid");
  }
  const encoded = plaintext.slice(LEGACY_OPRTE_PRELUDE_MAGIC.length, -1);
  const indexUtf8Bytes = decodeBase36(encoded, INDEX_BYTE_LENGTH_WIDTH);
  if (indexUtf8Bytes > HARNESS_MAX_COMPLETED_PREFIX_CONTAINER_UTF8_BYTES -
      COMPLETED_PREFIX_CONTAINER_V2_PRELUDE_BYTES) {
    throw new TypeError("completed-prefix index exceeds its byte limit");
  }
  return Object.freeze({
    indexUtf8Bytes,
    payloadOffset: COMPLETED_PREFIX_CONTAINER_V2_PRELUDE_BYTES + indexUtf8Bytes,
  });
}

export function parseCompletedPrefixContainerIndexV2(
  indexBytes: Uint8Array,
  prelude: Readonly<{ indexUtf8Bytes: number; payloadOffset: number }>,
): CompletedPrefixContainerIndexV2 {
  if (indexBytes.byteLength !== prelude.indexUtf8Bytes) {
    throw new TypeError("completed-prefix index has the wrong byte length");
  }
  const source = decodeUtf8(indexBytes);
  let cursor = 0;
  const line = (): string => {
    const end = source.indexOf("\n", cursor);
    if (end < 0) throw new TypeError("completed-prefix index line is truncated");
    const value = source.slice(cursor, end);
    cursor = end + 1;
    return value;
  };
  const coverageWitnessDigest = digestSchema.parse(line());
  const completedLine = line();
  const completedThroughTurnId = completedLine === "-"
    ? null
    : actorTurnIdSchema.parse(completedLine);
  const itemCount = decodeBase36(line(), ITEM_COUNT_WIDTH);
  const sourceUtf8Bytes = decodeBase36(line(), SOURCE_BYTE_LENGTH_WIDTH);
  if (
    itemCount > HARNESS_MAX_COMPLETED_PREFIX_ITEMS ||
    sourceUtf8Bytes > HARNESS_MAX_COMPLETED_PREFIX_SOURCE_UTF8_BYTES
  ) throw new TypeError("completed-prefix index metadata is invalid");
  if (source.length - cursor !== itemCount * ITEM_RECORD_BYTES) {
    throw new TypeError("completed-prefix item index has the wrong byte length");
  }

  const items: CompletedPrefixContainerIndexItemV2[] = [];
  let expectedOffset = 0;
  for (let index = 0; index < itemCount; index += 1) {
    const record = source.slice(cursor, cursor + ITEM_RECORD_BYTES);
    cursor += ITEM_RECORD_BYTES;
    if (record.at(-1) !== "\n") {
      throw new TypeError("completed-prefix item record is not canonical");
    }
    const ordinal = decodeBase36(record.slice(0, 11), ORDINAL_WIDTH);
    const itemClassCode = record.slice(11, 12);
    const utf8Offset = decodeBase36(record.slice(12, 17), ITEM_OFFSET_WIDTH);
    const utf8Bytes = decodeBase36(record.slice(17, 21), ITEM_BYTE_LENGTH_WIDTH);
    if (
      (itemClassCode !== "u" && itemClassCode !== "a") ||
      utf8Offset !== expectedOffset ||
      utf8Bytes > HARNESS_MAX_COMPLETED_PREFIX_ITEM_UTF8_BYTES ||
      (index > 0 && items[index - 1]!.ordinal >= ordinal)
    ) throw new TypeError("completed-prefix item record is invalid");
    items.push(Object.freeze({
      ordinal,
      itemClass: itemClassCode === "u" ? "userMessage" : "assistantMessage",
      utf8Offset,
      utf8Bytes,
    }));
    expectedOffset += utf8Bytes;
  }
  if (expectedOffset !== sourceUtf8Bytes) {
    throw new TypeError("completed-prefix payload extent is incoherent");
  }
  const totalUtf8Bytes = prelude.payloadOffset + sourceUtf8Bytes;
  if (totalUtf8Bytes > HARNESS_MAX_COMPLETED_PREFIX_CONTAINER_UTF8_BYTES) {
    throw new TypeError("completed-prefix container exceeds its byte limit");
  }
  return freezeIndex({
    version: 2,
    coverageWitnessDigest,
    completedThroughTurnId,
    indexUtf8Bytes: prelude.indexUtf8Bytes,
    payloadOffset: prelude.payloadOffset,
    sourceUtf8Bytes,
    totalUtf8Bytes,
    items,
  });
}

export function parseCompletedPrefixContainerV2(
  plaintext: string,
): Readonly<{
  index: CompletedPrefixContainerIndexV2;
  items: readonly CompletedPrefixContainerItemV2[];
}> {
  const bytes = Buffer.from(plaintext, "utf8");
  if (bytes.byteLength > HARNESS_MAX_COMPLETED_PREFIX_CONTAINER_UTF8_BYTES) {
    throw new TypeError("completed-prefix container exceeds its byte limit");
  }
  const prelude = parseCompletedPrefixContainerPreludeV2(
    bytes.subarray(0, COMPLETED_PREFIX_CONTAINER_V2_PRELUDE_BYTES),
  );
  const index = parseCompletedPrefixContainerIndexV2(
    bytes.subarray(COMPLETED_PREFIX_CONTAINER_V2_PRELUDE_BYTES, prelude.payloadOffset),
    prelude,
  );
  if (bytes.byteLength !== index.totalUtf8Bytes) {
    throw new TypeError("completed-prefix payload has the wrong byte length");
  }
  const items = index.items.map((item) => Object.freeze({
    ordinal: item.ordinal,
    itemClass: item.itemClass,
    text: decodeUtf8(bytes.subarray(
      index.payloadOffset + item.utf8Offset,
      index.payloadOffset + item.utf8Offset + item.utf8Bytes,
    )),
  }));
  return Object.freeze({ index, items: Object.freeze(items) });
}

export function planCompletedPrefixContainerRangesV2(
  index: CompletedPrefixContainerIndexV2,
  itemIndexesValue: readonly number[],
): readonly CompletedPrefixContainerRangeV2[] {
  const itemIndexes = [...itemIndexesValue];
  for (let position = 0; position < itemIndexes.length; position += 1) {
    const itemIndex = itemIndexes[position]!;
    if (
      !Number.isSafeInteger(itemIndex) || itemIndex < 0 ||
      itemIndex >= index.items.length ||
      (position > 0 && itemIndexes[position - 1]! >= itemIndex)
    ) throw new TypeError("completed-prefix item indexes must be strict and valid");
  }
  const ranges: CompletedPrefixContainerRangeV2[] = [];
  for (const itemIndex of itemIndexes) {
    const item = index.items[itemIndex]!;
    const startByte = index.payloadOffset + item.utf8Offset;
    const endByteExclusive = startByte + item.utf8Bytes;
    const previous = ranges.at(-1);
    if (previous !== undefined && previous.endByteExclusive === startByte) {
      ranges[ranges.length - 1] = Object.freeze({
        ...previous,
        endByteExclusive,
        lastItemIndex: itemIndex,
      });
    } else {
      ranges.push(Object.freeze({
        startByte,
        endByteExclusive,
        firstItemIndex: itemIndex,
        lastItemIndex: itemIndex,
      }));
    }
  }
  return Object.freeze(ranges);
}

function freezeIndex(
  index: Omit<CompletedPrefixContainerIndexV2, "items"> & {
    readonly items: readonly CompletedPrefixContainerIndexItemV2[];
  },
): CompletedPrefixContainerIndexV2 {
  return Object.freeze({ ...index, items: Object.freeze([...index.items]) });
}

function encodeBase36(value: number, width: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("base36 value must be a nonnegative safe integer");
  }
  const encoded = value.toString(36);
  if (encoded.length > width) throw new RangeError("base36 value exceeds its field");
  return encoded.padStart(width, "0");
}

function decodeBase36(value: string, width: number): number {
  if (value.length !== width || !/^[0-9a-z]+$/u.test(value)) {
    throw new TypeError("base36 field is not canonical");
  }
  let decoded = 0;
  for (const character of value) {
    const digit = Number.parseInt(character, 36);
    decoded = decoded * 36 + digit;
    if (!Number.isSafeInteger(decoded)) throw new TypeError("base36 field is unsafe");
  }
  if (encodeBase36(decoded, width) !== value) {
    throw new TypeError("base36 field is not canonical");
  }
  return decoded;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (cause: unknown) {
    throw new TypeError("completed-prefix bytes are not valid UTF-8", { cause });
  }
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
