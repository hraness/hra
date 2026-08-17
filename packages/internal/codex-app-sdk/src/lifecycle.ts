import type { GenerationStore } from "./persistence.js";

export interface GenerationFence {
  readonly current: () => number;
  readonly advance: (minimumExclusive?: number) => number;
  readonly isCurrent: (generation: number) => boolean;
}

export class GenerationStoreContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationStoreContractError";
  }
}

export function assertGeneration(value: number, field = "generation"): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
}

export function createGenerationFence(
  initialGeneration = 0,
): GenerationFence {
  assertGeneration(initialGeneration, "initial generation");
  let generation = initialGeneration;

  const current = (): number => generation;
  const isCurrent = (candidate: number): boolean => candidate === generation;
  const advance = (minimumExclusive = generation): number => {
    assertGeneration(minimumExclusive, "minimum generation");
    const floor = Math.max(generation, minimumExclusive);
    if (floor === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("generation space is exhausted");
    }
    generation = floor + 1;
    return generation;
  };

  return Object.freeze({ advance, current, isCurrent });
}

export async function reserveMonotonicGeneration(
  store: GenerationStore,
  scope: string,
  minimumExclusive: number,
): Promise<number> {
  if (scope.length === 0 || scope.length > 512) {
    throw new RangeError("generation scope must contain 1 to 512 characters");
  }
  assertGeneration(minimumExclusive, "minimum generation");
  const generation = await store.reserve(scope, minimumExclusive);
  try {
    assertGeneration(generation, "reserved generation");
  } catch {
    throw new GenerationStoreContractError(
      "generation store returned an invalid generation",
    );
  }
  if (generation <= minimumExclusive) {
    throw new GenerationStoreContractError(
      "generation store did not advance beyond the requested floor",
    );
  }
  return generation;
}
