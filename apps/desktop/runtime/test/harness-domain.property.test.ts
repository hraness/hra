import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import {
  HARNESS_MAX_ACTIVE_DESCENDANTS,
  HARNESS_MAX_CONTEXT_VALUE_UTF8_BYTES,
  HARNESS_MAX_DURABLE_DESCENDANTS,
  HARNESS_MAX_HEAP_UTF8_BYTES,
  HARNESS_MAX_MESSAGE_UTF8_BYTES,
  HARNESS_MAX_RECURSION_DEPTH,
  recursiveBudgetSchema,
} from "../src/harness/domain";

const deadline = "2030-01-01T00:00:00.000Z";

test("recursive budget parsing preserves every coherent authority dimension", () => {
  assertProperty(fc.property(
    fc.integer({ min: 0, max: HARNESS_MAX_RECURSION_DEPTH }),
    fc.integer({ min: 1, max: HARNESS_MAX_ACTIVE_DESCENDANTS }),
    fc.integer({ min: 1, max: HARNESS_MAX_DURABLE_DESCENDANTS }),
    fc.integer({ min: 1, max: 1_000_000 }),
    fc.integer({ min: 1, max: HARNESS_MAX_HEAP_UTF8_BYTES }),
    fc.integer({ min: 1, max: HARNESS_MAX_CONTEXT_VALUE_UTF8_BYTES }),
    fc.integer({ min: 1, max: HARNESS_MAX_MESSAGE_UTF8_BYTES }),
    fc.constantFrom("readOnly" as const, "managedWrite" as const),
    (depth, active, durableCandidate, tokens, heap, contextCandidate, message, laneAuthority) => {
      const input = {
        depthRemaining: depth,
        activeDescendantLimit: active,
        durableDescendantLimit: Math.max(active, durableCandidate),
        tokenBudget: tokens,
        deadline,
        heapByteLimit: heap,
        contextValueByteLimit: Math.min(contextCandidate, heap),
        messageByteLimit: message,
        laneAuthority,
      };
      const parsed = recursiveBudgetSchema.parse(input);
      expect(parsed).toEqual(input);
      expect(parsed.activeDescendantLimit).toBeLessThanOrEqual(
        parsed.durableDescendantLimit,
      );
      expect(parsed.contextValueByteLimit).toBeLessThanOrEqual(parsed.heapByteLimit);
    },
  ));
});

test("recursive budget parsing rejects incoherent descendant capacity", () => {
  assertProperty(fc.property(
    fc.integer({ min: 2, max: HARNESS_MAX_ACTIVE_DESCENDANTS }),
    fc.nat(),
    (active, offset) => {
      const durable = 1 + offset % (active - 1);
      expect(recursiveBudgetSchema.safeParse({
        depthRemaining: HARNESS_MAX_RECURSION_DEPTH,
        activeDescendantLimit: active,
        durableDescendantLimit: durable,
        tokenBudget: 1,
        deadline,
        heapByteLimit: 1,
        contextValueByteLimit: 1,
        messageByteLimit: 1,
        laneAuthority: "readOnly",
      }).success).toBeFalse();
    },
  ));
});

test("recursive budget parser is total for arbitrary foreign values", () => {
  assertProperty(fc.property(fc.anything(), (value) => {
    expect(() => recursiveBudgetSchema.safeParse(value)).not.toThrow();
  }));
});
