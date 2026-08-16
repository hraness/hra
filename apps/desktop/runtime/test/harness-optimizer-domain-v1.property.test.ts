import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import {
  compileOptimizerAssignmentPlan,
  digestOptimizerBenchmarkRegistry,
  isLegalOptimizerDeploymentTransition,
  isLegalOptimizerExperimentTransition,
  optimizerAssignmentKeyDigest,
  optimizerBenchmarkRegistrySchema,
  optimizerDeploymentTransitionSchema,
  optimizerExperimentTransitionSchema,
  optimizerMatchedPartitionDesignSchema,
  optimizerPairAssignmentSchema,
} from "../src/harness/optimizer-domain-v1";
import { makeOptimizerRegistry } from "./harness-optimizer-fixtures";

test("property: registry digest is invariant to case iteration order", () => {
  const registry = makeOptimizerRegistry();
  const expected = digestOptimizerBenchmarkRegistry(registry);
  assertProperty(fc.property(
    fc.integer({ min: 0, max: registry.cases.length - 1 }),
    fc.boolean(),
    (offset, reverse) => {
      const rotated = [
        ...registry.cases.slice(offset),
        ...registry.cases.slice(0, offset),
      ];
      if (reverse) rotated.reverse();
      expect(digestOptimizerBenchmarkRegistry({
        ...registry,
        cases: rotated,
      })).toBe(expected);
    },
  ));
});

test("property: every assignment key produces one balanced stable block", () => {
  const registry = makeOptimizerRegistry();
  const benchmarkCase = registry.cases[0]!;
  const registryDigest = digestOptimizerBenchmarkRegistry(registry);
  assertProperty(fc.property(
    fc.uint8Array({ minLength: 32, maxLength: 32 }),
    (key) => {
      const expectedKeyDigest = optimizerAssignmentKeyDigest(key);
      expect(expectedKeyDigest).not.toBeNull();
      const result = compileOptimizerAssignmentPlan({
        registryDigest,
        benchmarkCase,
        matchedPartitionDesign: registry.matchedPartitionDesign,
        replicatePairsPerFamily: 4,
        keyVersion: 1,
        expectedKeyDigest,
      }, key);
      expect(result.kind).toBe("assigned");
      if (result.kind !== "assigned") return;
      expect(result.assignments.every((assignment) =>
        optimizerPairAssignmentSchema.safeParse(assignment).success
      )).toBeTrue();
      expect(new Set(result.assignments.map((assignment) =>
        `${assignment.executionOrder}:` +
        `${assignment.candidatePartitionDigest ===
          registry.matchedPartitionDesign.partitions[0].partitionDigest ? 0 : 1}`
      )).size).toBe(4);
      expect(compileOptimizerAssignmentPlan({
        registryDigest,
        benchmarkCase,
        matchedPartitionDesign: registry.matchedPartitionDesign,
        replicatePairsPerFamily: 4,
        keyVersion: 1,
        expectedKeyDigest,
      }, key)).toEqual(result);
    },
  ));
});

test("property: optimizer schemas and state predicates are total", () => {
  assertProperty(fc.property(fc.anything(), fc.anything(), (left, right) => {
    expect(() => optimizerBenchmarkRegistrySchema.safeParse(left)).not.toThrow();
    expect(() => optimizerMatchedPartitionDesignSchema.safeParse(left))
      .not.toThrow();
    expect(() => optimizerPairAssignmentSchema.safeParse(left)).not.toThrow();
    expect(() => optimizerExperimentTransitionSchema.safeParse(left))
      .not.toThrow();
    expect(() => optimizerDeploymentTransitionSchema.safeParse(left))
      .not.toThrow();
    expect(() => isLegalOptimizerExperimentTransition(left, right))
      .not.toThrow();
    expect(() => isLegalOptimizerDeploymentTransition(left, right))
      .not.toThrow();
  }));
});
