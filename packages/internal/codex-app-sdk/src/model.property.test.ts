import { describe, expect, test } from "bun:test";

import {
  compareSourceCoordinates,
  createSourceCoordinate,
  type SourceCoordinateRelation,
} from "./coordinates";
import { createGenerationFence } from "./lifecycle";
import { createDeterministicNumberSource } from "./testing/fixtures";

function invert(
  relation: SourceCoordinateRelation,
): SourceCoordinateRelation {
  if (relation === "before") return "after";
  if (relation === "after") return "before";
  return relation;
}

describe("model properties", () => {
  test("coordinate ordering is antisymmetric and transitive within a source", () => {
    const numbers = createDeterministicNumberSource(0xc0de);

    for (let run = 0; run < 1_000; run += 1) {
      const values = Array.from(
        { length: 9 },
        () => numbers.nextInteger(0, 10_000),
      );
      const left = createSourceCoordinate({
        sourceId: "source",
        generation: values[0] ?? 0,
        sequence: values[1] ?? 0,
        index: values[2] ?? 0,
      });
      const middle = createSourceCoordinate({
        sourceId: "source",
        generation: values[3] ?? 0,
        sequence: values[4] ?? 0,
        index: values[5] ?? 0,
      });
      const right = createSourceCoordinate({
        sourceId: "source",
        generation: values[6] ?? 0,
        sequence: values[7] ?? 0,
        index: values[8] ?? 0,
      });
      const leftToMiddle = compareSourceCoordinates(left, middle);
      expect(compareSourceCoordinates(middle, left)).toBe(
        invert(leftToMiddle),
      );
      if (
        leftToMiddle !== "after" &&
        compareSourceCoordinates(middle, right) !== "after"
      ) {
        expect(compareSourceCoordinates(left, right)).not.toBe("after");
      }
    }
  });

  test("generation advancement is strictly above every observed floor", () => {
    const numbers = createDeterministicNumberSource(0xfece);
    const fence = createGenerationFence();
    let previous = fence.current();

    for (let run = 0; run < 1_000; run += 1) {
      const floor = Math.max(
        previous,
        numbers.nextInteger(0, 1_000_000),
      );
      const next = fence.advance(floor);
      expect(next).toBeGreaterThan(floor);
      expect(fence.isCurrent(next)).toBe(true);
      previous = next;
    }
  });
});
