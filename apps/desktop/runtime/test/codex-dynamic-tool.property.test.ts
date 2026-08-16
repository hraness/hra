import { expect, test } from "bun:test";
import { assertAsyncProperty, fc } from "@hra-internal/test";

import {
  PinnedCodexDynamicToolLedger,
  acceptPinnedCodexDynamicToolProbeWitness,
  parsePinnedCodexDynamicToolCall,
} from "../src/codex";

const jsonLeaf = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.string({ maxLength: 80 }),
);

const boundedJson = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: "small", maxDepth: 4 },
    jsonLeaf,
    fc.array(tie("value"), { maxLength: 8 }),
    fc.dictionary(
      fc.stringMatching(/^[a-z][a-z0-9]{0,15}$/u),
      tie("value"),
      { maxKeys: 8 },
    ),
  ),
})).value;

function call(argumentsValue: unknown) {
  return {
    threadId: "thread-property",
    turnId: "turn-property",
    callId: "call-property",
    namespace: "oprte",
    tool: "rlm_run",
    arguments: {
      schemaVersion: 1,
      action: "submit",
      program: argumentsValue,
    },
  };
}

test("dynamic tool parsing is total over arbitrary foreign values", () => {
  fc.assert(fc.property(fc.anything({ withBigInt: true, withMap: true, withSet: true }), (value) => {
    expect(() => parsePinnedCodexDynamicToolCall(value)).not.toThrow();
  }), { numRuns: 300 });
});

test("probe witness acceptance is total and disabled without trusted custody", async () => {
  await assertAsyncProperty(fc.asyncProperty(
    fc.anything({ withBigInt: true, withMap: true, withSet: true }),
    async (value) => {
      expect(await acceptPinnedCodexDynamicToolProbeWitness(value)).toBeNull();
    },
  ), { numRuns: 300 });
});

test("generation-local receipts admit once and classify exact replays", () => {
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 1_000_000 }),
    boundedJson,
    (generation, argumentsValue) => {
      const parsed = parsePinnedCodexDynamicToolCall(call(argumentsValue));
      if (parsed === null) return;
      const ledger = new PinnedCodexDynamicToolLedger();
      expect(ledger.admit(generation, parsed).kind).toBe("accepted");
      expect(ledger.admit(generation, parsed).kind).toBe("duplicate");
      const conflict = parsePinnedCodexDynamicToolCall(call([argumentsValue]));
      if (conflict !== null) {
        expect(ledger.admit(generation, conflict).kind).toBe("replay_conflict");
      }
      expect(ledger.admit(generation + 1, parsed).kind).toBe("accepted");
    },
  ), { numRuns: 200 });
});

test("canonical argument identity is independent of object insertion order", () => {
  fc.assert(fc.property(
    fc.dictionary(
      fc.stringMatching(/^[a-z][a-z0-9]{0,12}$/u),
      jsonLeaf,
      { maxKeys: 20 },
    ),
    (value) => {
      const reversed = Object.fromEntries(Object.entries(value).reverse());
      const first = parsePinnedCodexDynamicToolCall(call(value));
      const second = parsePinnedCodexDynamicToolCall(call(reversed));
      if (first === null || second === null) return;
      expect(second.argumentsSha256).toBe(first.argumentsSha256);
    },
  ), { numRuns: 200 });
});
