import { describe, expect, test } from "bun:test";

import fc from "fast-check";

import { localCommandSchema } from "./contracts";
import { presetRequirements } from "./presets";
import { canTransitionMutation, mutationStateSchema } from "./transitions";
import { selectByIdOrLabel, utf8Bytes } from "./values";

describe("domain laws", () => {
  test("owns one exact reduced preset mapping", () => {
    expect(presetRequirements).toEqual({
      low: { model: "gpt-5.6-luna", effort: "max" },
      high: { model: "gpt-5.6-sol", effort: "max" },
      ultra: { model: "gpt-5.6-sol", effort: "ultra" },
    });
  });

  test("command parsing is total for arbitrary JSON-like input", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(() => localCommandSchema.safeParse(value)).not.toThrow();
      }),
      { numRuns: 1_000 },
    );
  });

  test("terminal mutation states are absorbing", () => {
    fc.assert(
      fc.property(fc.constantFrom("applied", "failed", "ambiguous", "cancelled", "reconciled"), fc.constantFrom(...mutationStateSchema.options), (from, to) => {
        expect(canTransitionMutation(from, to)).toBe(false);
      }),
    );
  });

  test("selection is exact-id first and otherwise unambiguous case-insensitive label", () => {
    const values = [
      { id: "acct_a", label: "Work" },
      { id: "acct_b", label: "work" },
      { id: "acct_c", label: "Personal" },
    ];
    expect(selectByIdOrLabel(values, "acct_b")).toEqual({ kind: "found", value: values[1]! });
    expect(selectByIdOrLabel(values, "WORK").kind).toBe("ambiguous");
    expect(selectByIdOrLabel(values, "personal")).toEqual({ kind: "found", value: values[2]! });
  });

  test("UTF-8 byte accounting does not confuse code points with bytes", () => {
    expect(utf8Bytes("🙂".repeat(40))).toBe(160);
  });
});
