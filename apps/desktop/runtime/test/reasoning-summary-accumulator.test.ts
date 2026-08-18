import { describe, expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import {
  MAX_REASONING_SUMMARY_DISPLAY_UTF8_BYTES,
  ReasoningSummaryAccumulator,
  type ReasoningSummaryScope,
} from "../src/sessions/reasoning-summary-accumulator";

const scope: ReasoningSummaryScope = Object.freeze({
  accountProfileId: "account-private-1",
  generation: 7,
  itemId: "provider-reasoning-private-1",
  threadId: "provider-thread-private-1",
  turnId: "provider-turn-private-1",
});

function cursor(streamPosition: number, factIndex = 0) {
  return { generation: scope.generation, streamPosition, factIndex };
}

describe("ReasoningSummaryAccumulator", () => {
  test("proves an ordered completion and repairs only its exact missing suffix", () => {
    const accumulator = new ReasoningSummaryAccumulator();
    expect(accumulator.observePart({ ...scope, cursor: cursor(1), summaryIndex: 0 }))
      .toBeTrue();
    expect(accumulator.observeDelta({
      ...scope,
      cursor: cursor(2),
      summaryIndex: 0,
      delta: "Checking the seam",
      truncated: false,
    })).toBeTrue();
    expect(accumulator.observePart({ ...scope, cursor: cursor(3), summaryIndex: 1 }))
      .toBeTrue();
    expect(accumulator.observeDelta({
      ...scope,
      cursor: cursor(4),
      summaryIndex: 1,
      delta: "Running",
      truncated: false,
    })).toBeTrue();

    const receipt = accumulator.complete({
      ...scope,
      cursor: cursor(5),
      summaryParts: ["Checking the seam", "Running focused tests"],
      truncated: false,
    });
    expect(receipt).toMatchObject({
      state: "verified",
      overflowed: false,
      repairedSuffix: true,
      terminalVisible: true,
      summary: {
        tail: "Checking the seam\nRunning focused tests",
        truncatedPrefix: false,
      },
    });
    expect(accumulator.complete({
      ...scope,
      cursor: cursor(6),
      summaryParts: ["Checking the seam", "Running focused tests"],
      truncated: false,
    })).toBe(receipt);
  });

  test("taints middle gaps, conflicts, cursor reuse, and late activity", () => {
    const middleGap = new ReasoningSummaryAccumulator();
    middleGap.observeDelta({
      ...scope,
      cursor: cursor(1),
      summaryIndex: 0,
      delta: "first",
      truncated: false,
    });
    middleGap.observeDelta({
      ...scope,
      cursor: cursor(2),
      summaryIndex: 2,
      delta: "third",
      truncated: false,
    });
    expect(middleGap.complete({
      ...scope,
      cursor: cursor(3),
      summaryParts: ["first", "missing", "third"],
      truncated: false,
    })).toMatchObject({
      state: "tainted",
      reason: "nonSuffixGap",
      summary: null,
      terminalVisible: false,
    });

    const conflict = new ReasoningSummaryAccumulator();
    conflict.observeDelta({
      ...scope,
      cursor: cursor(1),
      summaryIndex: 0,
      delta: "left",
      truncated: false,
    });
    expect(conflict.complete({
      ...scope,
      cursor: cursor(2),
      summaryParts: ["right"],
      truncated: false,
    })).toMatchObject({ state: "tainted", reason: "summaryConflict" });

    const reusedCursor = new ReasoningSummaryAccumulator();
    reusedCursor.observeDelta({
      ...scope,
      cursor: cursor(1),
      summaryIndex: 0,
      delta: "first",
      truncated: false,
    });
    expect(reusedCursor.observeDelta({
      ...scope,
      cursor: cursor(1),
      summaryIndex: 0,
      delta: "changed",
      truncated: false,
    })).toBeFalse();
    expect(reusedCursor.complete({
      ...scope,
      cursor: cursor(2),
      summaryParts: ["first"],
      truncated: false,
    })).toMatchObject({ state: "tainted", reason: "cursorConflict" });

    const late = new ReasoningSummaryAccumulator();
    const verified = late.complete({
      ...scope,
      cursor: cursor(1),
      summaryParts: ["authoritative snapshot"],
      truncated: false,
    });
    expect(verified.state).toBe("verified");
    expect(late.observeDelta({
      ...scope,
      cursor: cursor(2),
      summaryIndex: 0,
      delta: "late",
      truncated: false,
    })).toBeFalse();
    expect(late.receipt(scope)).toMatchObject({
      state: "tainted",
      reason: "lateActivity",
      terminalVisible: false,
    });
  });

  test("retains a Unicode-safe bounded tail and records overflow", () => {
    const accumulator = new ReasoningSummaryAccumulator();
    const full = `${"a".repeat(MAX_REASONING_SUMMARY_DISPLAY_UTF8_BYTES)}🙂suffix`;
    accumulator.observeDelta({
      ...scope,
      cursor: cursor(1),
      summaryIndex: 0,
      delta: full,
      truncated: false,
    });
    const receipt = accumulator.complete({
      ...scope,
      cursor: cursor(2),
      summaryParts: [full],
      truncated: false,
    });
    expect(receipt).toMatchObject({
      state: "verified",
      overflowed: true,
      repairedSuffix: true,
      terminalVisible: true,
    });
    if (receipt.state !== "verified") throw new Error("expected verified receipt");
    expect(new TextEncoder().encode(receipt.summary.tail).byteLength)
      .toBeLessThanOrEqual(MAX_REASONING_SUMMARY_DISPLAY_UTF8_BYTES);
    expect(receipt.summary.tail.endsWith("🙂suffix")).toBeTrue();
    expect(receipt.summary.truncatedPrefix).toBeTrue();
  });

  test("generation and privacy cuts synchronously forget private provider scope", () => {
    const accumulator = new ReasoningSummaryAccumulator();
    accumulator.observeDelta({
      ...scope,
      cursor: cursor(1),
      summaryIndex: 0,
      delta: "safe summary",
      truncated: false,
    });
    const receipt = accumulator.complete({
      ...scope,
      cursor: cursor(2),
      summaryParts: ["safe summary"],
      truncated: false,
    });
    expect(JSON.stringify(receipt)).not.toContain(scope.accountProfileId);
    expect(JSON.stringify(receipt)).not.toContain(scope.threadId);
    expect(JSON.stringify(receipt)).not.toContain(scope.turnId);
    expect(JSON.stringify(receipt)).not.toContain(scope.itemId);
    accumulator.advanceGeneration(scope.accountProfileId, scope.generation + 1);
    expect(accumulator.activeItemCount).toBe(0);

    accumulator.complete({
      ...scope,
      cursor: cursor(3),
      summaryParts: ["safe summary"],
      truncated: false,
    });
    accumulator.purgeAccount(scope.accountProfileId);
    expect(accumulator.activeItemCount).toBe(0);
  });

  test("arbitrary ordered chunking reconciles to the same terminal summary", () => {
    assertProperty(fc.property(
      fc.array(
        fc.array(fc.constantFrom("a", "Z", " ", "\n", "é", "界", "🙂"), {
          minLength: 1,
          maxLength: 24,
        }).map((characters) => characters.join("")),
        { minLength: 1, maxLength: 8 },
      ),
      fc.integer({ min: 1, max: 7 }),
      (parts, requestedChunkSize) => {
        const accumulator = new ReasoningSummaryAccumulator();
        let position = 1;
        for (let summaryIndex = 0; summaryIndex < parts.length; summaryIndex += 1) {
          accumulator.observePart({
            ...scope,
            cursor: cursor(position++),
            summaryIndex,
          });
          const characters = [...parts[summaryIndex]!];
          for (let offset = 0; offset < characters.length; offset += requestedChunkSize) {
            accumulator.observeDelta({
              ...scope,
              cursor: cursor(position++),
              summaryIndex,
              delta: characters.slice(offset, offset + requestedChunkSize).join(""),
              truncated: false,
            });
          }
        }
        const receipt = accumulator.complete({
          ...scope,
          cursor: cursor(position),
          summaryParts: parts,
          truncated: false,
        });
        expect(receipt.state).toBe("verified");
        if (receipt.state === "verified") {
          expect(receipt.summary.tail).toBe(parts.join("\n"));
          expect(receipt.repairedSuffix).toBeFalse();
        }
      },
    ));
  });
});
