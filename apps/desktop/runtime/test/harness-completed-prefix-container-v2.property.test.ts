import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import {
  packCompletedPrefixContainerV2,
  parseCompletedPrefixContainerV2,
  planCompletedPrefixContainerRangesV2,
} from "../src/harness/completed-prefix-container-v2";

const textArbitrary = fc.array(fc.oneof(
  fc.constant("\0"),
  fc.constant("🙂"),
  fc.constant("\uFEFFlead"),
  fc.constant("\n"),
  fc.string({ maxLength: 8 }),
), { maxLength: 12 }).map((parts) => parts.join(""));

test("completed-prefix packing is deterministic and round-trips arbitrary UTF-8", () => {
  assertProperty(fc.property(
    fc.array(fc.record({
      assistant: fc.boolean(),
      text: textArbitrary,
      ordinalGap: fc.integer({ min: 1, max: 9 }),
    }), { maxLength: 48 }),
    (source) => {
      let ordinal = 0;
      const items = source.map((item) => {
        ordinal += item.ordinalGap;
        return {
          ordinal,
          itemClass: item.assistant
            ? "assistantMessage" as const
            : "userMessage" as const,
          text: item.text,
        };
      });
      const input = {
        coverageWitnessDigest: "f".repeat(64),
        completedThroughTurnId: items.length === 0
          ? null
          : "hturn_property_anchor001",
        items,
      } as const;
      const first = packCompletedPrefixContainerV2(input);
      const second = packCompletedPrefixContainerV2(input);
      expect(second).toEqual(first);
      expect(parseCompletedPrefixContainerV2(first.plaintext).items).toEqual(items);
      expect(planCompletedPrefixContainerRangesV2(
        first.index,
        first.index.items.map((_, index) => index),
      )).toHaveLength(items.length === 0 ? 0 : 1);
    },
  ));
});
