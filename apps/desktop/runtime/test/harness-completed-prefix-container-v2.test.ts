import { describe, expect, test } from "bun:test";

import {
  COMPLETED_PREFIX_CONTAINER_V2_PRELUDE_BYTES,
  packCompletedPrefixContainerV2,
  parseCompletedPrefixContainerIndexV2,
  parseCompletedPrefixContainerPreludeV2,
  parseCompletedPrefixContainerV2,
  planCompletedPrefixContainerRangesV2,
} from "../src/harness/completed-prefix-container-v2";
import {
  HARNESS_MAX_COMPLETED_PREFIX_CONTAINER_UTF8_BYTES,
  HARNESS_MAX_COMPLETED_PREFIX_ITEMS,
  HARNESS_MAX_COMPLETED_PREFIX_ITEM_UTF8_BYTES,
  HARNESS_MAX_COMPLETED_PREFIX_SOURCE_UTF8_BYTES,
} from "../src/harness/domain";

const witness = "a".repeat(64);
const completedThroughTurnId = "hturn_completed_prefix_anchor001";

describe("completed-prefix container v2", () => {
  test("round-trips the stable anchor, NUL, Unicode, and byte ranges", () => {
    const packed = packCompletedPrefixContainerV2({
      coverageWitnessDigest: witness,
      completedThroughTurnId,
      items: [
        {
          ordinal: 0,
          itemClass: "userMessage",
          text: "alpha\0🙂",
        },
        {
          ordinal: 4,
          itemClass: "assistantMessage",
          text: "βeta",
        },
        {
          ordinal: 9,
          itemClass: "userMessage",
          text: "\uFEFFomega",
        },
      ],
    });
    const parsed = parseCompletedPrefixContainerV2(packed.plaintext);
    expect(parsed.items).toEqual([
      {
        ordinal: 0,
        itemClass: "userMessage",
        text: "alpha\0🙂",
      },
      {
        ordinal: 4,
        itemClass: "assistantMessage",
        text: "βeta",
      },
      {
        ordinal: 9,
        itemClass: "userMessage",
        text: "\uFEFFomega",
      },
    ]);
    expect(parsed.index).toEqual(packed.index);
    expect(planCompletedPrefixContainerRangesV2(parsed.index, [0, 1, 2]))
      .toEqual([{
        startByte: parsed.index.payloadOffset,
        endByteExclusive: parsed.index.totalUtf8Bytes,
        firstItemIndex: 0,
        lastItemIndex: 2,
      }]);
    expect(planCompletedPrefixContainerRangesV2(parsed.index, [0, 2]))
      .toHaveLength(2);
  });

  test("parses the fixed prelude and index without reading payload bytes", () => {
    const packed = packCompletedPrefixContainerV2({
      coverageWitnessDigest: witness,
      completedThroughTurnId,
      items: [{
        ordinal: 3,
        itemClass: "assistantMessage",
        text: "payload remains unread",
      }],
    });
    const bytes = Buffer.from(packed.plaintext, "utf8");
    const prelude = parseCompletedPrefixContainerPreludeV2(
      bytes.subarray(0, COMPLETED_PREFIX_CONTAINER_V2_PRELUDE_BYTES),
    );
    const index = parseCompletedPrefixContainerIndexV2(
      bytes.subarray(COMPLETED_PREFIX_CONTAINER_V2_PRELUDE_BYTES, prelude.payloadOffset),
      prelude,
    );
    expect(index).toEqual(packed.index);
    expect(index.payloadOffset).toBeLessThan(index.totalUtf8Bytes);
  });

  test("fits the admitted worst-case source and item index below 18 MiB", () => {
    const items = Array.from(
      { length: HARNESS_MAX_COMPLETED_PREFIX_ITEMS },
      (_, ordinal) => ({
        ordinal,
        itemClass: ordinal % 2 === 0
          ? "userMessage" as const
          : "assistantMessage" as const,
        text: ordinal < 16
          ? "x".repeat(HARNESS_MAX_COMPLETED_PREFIX_ITEM_UTF8_BYTES)
          : "",
      }),
    );
    const packed = packCompletedPrefixContainerV2({
      coverageWitnessDigest: witness,
      completedThroughTurnId,
      items,
    });
    expect(packed.index.sourceUtf8Bytes)
      .toBe(HARNESS_MAX_COMPLETED_PREFIX_SOURCE_UTF8_BYTES);
    expect(packed.index.items).toHaveLength(HARNESS_MAX_COMPLETED_PREFIX_ITEMS);
    expect(packed.index.totalUtf8Bytes)
      .toBeLessThanOrEqual(HARNESS_MAX_COMPLETED_PREFIX_CONTAINER_UTF8_BYTES);
    expect(parseCompletedPrefixContainerV2(packed.plaintext).items.at(-1))
      .toEqual(items.at(-1));
  }, 20_000);

  test("fails closed on noncanonical indexes, invalid ranges, and truncation", () => {
    const firstTurnHistory = packCompletedPrefixContainerV2({
      coverageWitnessDigest: witness,
      completedThroughTurnId: null,
      items: [{
        ordinal: 0,
        itemClass: "userMessage",
        text: "nonempty",
      }],
    });
    expect(parseCompletedPrefixContainerV2(firstTurnHistory.plaintext).items)
      .toHaveLength(1);
    const packed = packCompletedPrefixContainerV2({
      coverageWitnessDigest: witness,
      completedThroughTurnId,
      items: [
        {
          ordinal: 1,
          itemClass: "userMessage",
          text: "one",
        },
        {
          ordinal: 2,
          itemClass: "assistantMessage",
          text: "two",
        },
      ],
    });
    expect(() => parseCompletedPrefixContainerV2(packed.plaintext.slice(0, -1)))
      .toThrow();
    expect(() => parseCompletedPrefixContainerV2(
      `X${packed.plaintext.slice(1)}`,
    )).toThrow();
    expect(() => planCompletedPrefixContainerRangesV2(packed.index, [1, 0]))
      .toThrow();
    expect(() => planCompletedPrefixContainerRangesV2(packed.index, [2]))
      .toThrow();
    for (const text of ["\uD800", "\uDC00"]) {
      expect(() => packCompletedPrefixContainerV2({
        coverageWitnessDigest: witness,
        completedThroughTurnId,
        items: [{ ordinal: 0, itemClass: "userMessage", text }],
      })).toThrow();
    }
  });
});
