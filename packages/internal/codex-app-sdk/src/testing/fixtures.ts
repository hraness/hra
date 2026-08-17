import {
  createAttemptId,
  type AttemptId,
} from "../client.js";
import {
  createSourceCoordinate,
  type SourceCoordinate,
} from "../coordinates.js";

export interface DeterministicNumberSource {
  readonly nextUint32: () => number;
  readonly nextInteger: (
    minimumInclusive: number,
    maximumInclusive: number,
  ) => number;
}

export function createDeterministicNumberSource(
  seed: number,
): DeterministicNumberSource {
  if (!Number.isSafeInteger(seed)) {
    throw new RangeError("seed must be a safe integer");
  }
  let state = seed >>> 0;

  const nextUint32 = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  };

  const nextInteger = (
    minimumInclusive: number,
    maximumInclusive: number,
  ): number => {
    if (
      !Number.isSafeInteger(minimumInclusive) ||
      !Number.isSafeInteger(maximumInclusive) ||
      minimumInclusive > maximumInclusive
    ) {
      throw new RangeError("integer bounds are invalid");
    }
    const width = maximumInclusive - minimumInclusive + 1;
    if (!Number.isSafeInteger(width) || width < 1 || width > 0x1_0000_0000) {
      throw new RangeError("integer range must fit within 32 bits");
    }
    return minimumInclusive + (nextUint32() % width);
  };

  return Object.freeze({ nextInteger, nextUint32 });
}

export function attemptIdFixture(
  index: number,
  prefix = "attempt",
): AttemptId {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError("fixture index must be a non-negative safe integer");
  }
  return createAttemptId(`${prefix}-${String(index).padStart(6, "0")}`);
}

export function sourceCoordinateFixture(
  overrides: Partial<SourceCoordinate> = {},
): SourceCoordinate {
  return createSourceCoordinate({
    sourceId: overrides.sourceId ?? "source-fixture",
    generation: overrides.generation ?? 1,
    sequence: overrides.sequence ?? 0,
    index: overrides.index ?? 0,
  });
}
