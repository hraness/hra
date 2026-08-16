import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import {
  evaluateOptimizerFiniteBenchmark,
  optimizerArmOutcomeSchema,
  optimizerElapsedSchema,
  optimizerFiniteBenchmarkGateResultSchema,
  optimizerProviderTokensSchema,
} from "../src/harness/optimizer-evidence-v1";
import {
  OPTIMIZER_FIXTURE_ASSIGNMENT_KEY,
  makePassingOptimizerGateFixture,
} from "./harness-optimizer-fixtures";

function rotate<T>(values: readonly T[], offset: number, reverse: boolean): T[] {
  const index = offset % values.length;
  const rotated = [...values.slice(index), ...values.slice(0, index)];
  return reverse ? rotated.reverse() : rotated;
}

test("property: the finite gate is invariant to assignment and evidence order", () => {
  const fixture = makePassingOptimizerGateFixture();
  const expected = evaluateOptimizerFiniteBenchmark({
    schemaVersion: 1,
    registry: fixture.registry,
    registryDigest: fixture.registryDigest,
    assignmentKeyVersion: 1,
    assignmentKey: OPTIMIZER_FIXTURE_ASSIGNMENT_KEY,
    assignments: fixture.assignments,
    outcomes: fixture.outcomes,
  });
  assertProperty(fc.property(
    fc.integer({ min: 0, max: fixture.assignments.length - 1 }),
    fc.integer({ min: 0, max: fixture.outcomes.length - 1 }),
    fc.boolean(),
    fc.boolean(),
    (assignmentOffset, outcomeOffset, reverseAssignments, reverseOutcomes) => {
      expect(evaluateOptimizerFiniteBenchmark({
        schemaVersion: 1,
        registry: fixture.registry,
        registryDigest: fixture.registryDigest,
        assignmentKeyVersion: 1,
        assignmentKey: OPTIMIZER_FIXTURE_ASSIGNMENT_KEY,
        assignments: rotate(
          fixture.assignments,
          assignmentOffset,
          reverseAssignments,
        ),
        outcomes: rotate(fixture.outcomes, outcomeOffset, reverseOutcomes),
      })).toEqual(expected);
    },
  ), { numRuns: 60 });
});

test("property: strict evidence schemas and gate parsing are total", () => {
  assertProperty(fc.property(fc.anything(), (value) => {
    expect(() => optimizerArmOutcomeSchema.safeParse(value)).not.toThrow();
    expect(() => optimizerProviderTokensSchema.safeParse(value)).not.toThrow();
    expect(() => optimizerElapsedSchema.safeParse(value)).not.toThrow();
    expect(() => optimizerFiniteBenchmarkGateResultSchema.safeParse(value))
      .not.toThrow();
    expect(() => evaluateOptimizerFiniteBenchmark(value)).not.toThrow();
  }));
});
