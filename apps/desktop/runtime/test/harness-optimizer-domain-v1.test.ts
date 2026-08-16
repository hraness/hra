import { describe, expect, test } from "bun:test";

import {
  HRA_OPTIMIZER_ASSIGNMENT_BLOCK_SIZE,
  OPTIMIZER_CANDIDATE_POLICY_V1,
  OPTIMIZER_CONTROL_POLICY_V1,
  assessOptimizerBenchmarkFeasibility,
  compileOptimizerAssignmentPlan,
  digestOptimizerBenchmarkRegistry,
  digestOptimizerPolicyRevision,
  isLegalOptimizerDeploymentTransition,
  isLegalOptimizerExperimentTransition,
  optimizerAssignmentKeyDigest,
  optimizerBenchmarkRegistrySchema,
  optimizerDeploymentTransitionSchema,
  optimizerExperimentTransitionSchema,
  mintOptimizerRegistryIdentity,
  verifyOptimizerRegistryIdentity,
} from "../src/harness/optimizer-domain-v1";
import {
  OPTIMIZER_FIXTURE_ASSIGNMENT_KEY,
  OPTIMIZER_FIXTURE_IDENTITY_KEY,
  makeOptimizerRegistry,
} from "./harness-optimizer-fixtures";

describe("optimizer Phase 0 domain", () => {
  test("freezes one holdout case per family and hashes registry order canonically", () => {
    const registry = makeOptimizerRegistry();
    const reversed = optimizerBenchmarkRegistrySchema.parse({
      ...registry,
      cases: [...registry.cases].reverse(),
    });
    expect(registry.cases).toHaveLength(64);
    expect(new Set(registry.cases.map(({ familyDigest }) => familyDigest)).size)
      .toBe(64);
    expect(digestOptimizerBenchmarkRegistry(reversed))
      .toBe(digestOptimizerBenchmarkRegistry(registry));
    expect(assessOptimizerBenchmarkFeasibility(registry)).toMatchObject({
      kind: "feasible",
      requiredPairAssignments: 256,
      requiredArmOutcomes: 512,
      requiredAggregateArmElapsedMilliseconds: "512000",
    });
  });

  test("freezes the candidate to one bounded-leaf change with native collaboration off", () => {
    expect(OPTIMIZER_CONTROL_POLICY_V1).toEqual({
      schemaVersion: 1,
      largeChange: "solUltra",
      wideResearch: "solUltra",
      standard: "solMax",
      boundedLeaf: "lunaThenSol",
      automaticFast: "inheritHarnessSetting",
      nativeCollaboration: false,
    });
    expect(OPTIMIZER_CANDIDATE_POLICY_V1).toEqual({
      ...OPTIMIZER_CONTROL_POLICY_V1,
      boundedLeaf: "solOnly",
    });
    expect(digestOptimizerPolicyRevision(OPTIMIZER_CANDIDATE_POLICY_V1))
      .not.toBe(digestOptimizerPolicyRevision(OPTIMIZER_CONTROL_POLICY_V1));
  });

  test("fails family leakage, duplicate families, and structural capacity closed", () => {
    const registry = makeOptimizerRegistry();
    const first = registry.cases[0]!;
    const second = registry.cases[1]!;
    const leakage = {
      ...registry,
      tuningFamilyDigests: [first.familyDigest],
    };
    expect(optimizerBenchmarkRegistrySchema.safeParse(leakage).success)
      .toBeFalse();
    expect(assessOptimizerBenchmarkFeasibility(leakage)).toMatchObject({
      kind: "infeasible",
      reasons: ["familyLeakage"],
    });

    const duplicateFamily = {
      ...registry,
      cases: [
        first,
        { ...second, familyDigest: first.familyDigest },
        ...registry.cases.slice(2),
      ],
    };
    expect(optimizerBenchmarkRegistrySchema.safeParse(duplicateFamily).success)
      .toBeFalse();
    expect(assessOptimizerBenchmarkFeasibility(duplicateFamily)).toMatchObject({
      kind: "infeasible",
      reasons: ["duplicateFamily"],
    });

    expect(assessOptimizerBenchmarkFeasibility(makeOptimizerRegistry({
      maximumPairAssignments: 255,
    }))).toMatchObject({
      kind: "infeasible",
      reasons: ["pairAssignmentCapacityInsufficient"],
    });
    expect(assessOptimizerBenchmarkFeasibility(makeOptimizerRegistry({
      familyCount: 63,
    }))).toMatchObject({
      kind: "infeasible",
      reasons: ["familyCountBelowMinimum"],
    });
  });

  test("mints every family and case under one registry-wide keyed contract", () => {
    const registry = makeOptimizerRegistry();
    const first = registry.cases[0]!;
    const familyMaterial = new TextEncoder().encode("family:0");
    expect(verifyOptimizerRegistryIdentity(
      { contract: registry.identityContract, kind: "family" },
      first.familyDigest,
      familyMaterial,
      OPTIMIZER_FIXTURE_IDENTITY_KEY,
    )).toEqual({
      kind: "verified",
      identityDigest: first.familyDigest,
    });
    expect(verifyOptimizerRegistryIdentity(
      { contract: registry.identityContract, kind: "family" },
      first.familyDigest,
      new TextEncoder().encode("another-family"),
      OPTIMIZER_FIXTURE_IDENTITY_KEY,
    )).toMatchObject({ kind: "conflict" });
    expect(mintOptimizerRegistryIdentity(
      { contract: registry.identityContract, kind: "case" },
      new TextEncoder().encode("case:0"),
      null,
    )).toEqual({
      kind: "recoveryRequired",
      reason: "identityKeyUnavailable",
    });
  });

  test("commits deterministic complete blocks and never recovers by rekeying", () => {
    const registry = makeOptimizerRegistry();
    const keyDigest = optimizerAssignmentKeyDigest(
      OPTIMIZER_FIXTURE_ASSIGNMENT_KEY,
    );
    expect(keyDigest).not.toBeNull();
    const input = {
      registryDigest: digestOptimizerBenchmarkRegistry(registry),
      benchmarkCase: registry.cases[0],
      matchedPartitionDesign: registry.matchedPartitionDesign,
      replicatePairsPerFamily: registry.gate.replicatePairsPerFamily,
      keyVersion: 7,
      expectedKeyDigest: keyDigest,
    };
    const first = compileOptimizerAssignmentPlan(
      input,
      OPTIMIZER_FIXTURE_ASSIGNMENT_KEY,
    );
    const second = compileOptimizerAssignmentPlan(
      input,
      OPTIMIZER_FIXTURE_ASSIGNMENT_KEY,
    );
    expect(first).toEqual(second);
    expect(first.kind).toBe("assigned");
    if (first.kind !== "assigned") throw new Error("assignment was not built");
    expect(first.assignments).toHaveLength(HRA_OPTIMIZER_ASSIGNMENT_BLOCK_SIZE);
    expect(new Set(first.assignments.map((assignment) =>
      `${assignment.executionOrder}:` +
      `${assignment.candidatePartitionDigest ===
        registry.matchedPartitionDesign.partitions[0].partitionDigest ? 0 : 1}`
    ))).toEqual(new Set([
      "candidateFirst:0",
      "candidateFirst:1",
      "controlFirst:0",
      "controlFirst:1",
    ]));
    expect(new Set(first.assignments.map(({ blockId }) => blockId)).size).toBe(1);

    expect(compileOptimizerAssignmentPlan(input, null)).toEqual({
      kind: "recoveryRequired",
      reason: "assignmentKeyUnavailable",
    });
    expect(compileOptimizerAssignmentPlan(
      input,
      Uint8Array.from({ length: 32 }, () => 99),
    )).toEqual({
      kind: "recoveryRequired",
      reason: "assignmentKeyMismatch",
    });
    expect(compileOptimizerAssignmentPlan(input, new Uint8Array(31))).toEqual({
      kind: "invalidInput",
      reason: "invalidAssignmentKey",
    });
  });

  test("admits only exact experiment and deployment state edges", () => {
    expect(isLegalOptimizerExperimentTransition("preparing", "evaluating"))
      .toBeTrue();
    expect(isLegalOptimizerExperimentTransition(
      "evaluating",
      "recommendCanary",
    )).toBeTrue();
    expect(isLegalOptimizerExperimentTransition(
      "recoveryRequired",
      "evaluating",
    )).toBeTrue();
    expect(isLegalOptimizerExperimentTransition("passed", "evaluating"))
      .toBeFalse();
    expect(isLegalOptimizerExperimentTransition(
      "recommendCanary",
      "rolloutRunning",
    )).toBeFalse();
    expect(optimizerExperimentTransitionSchema.safeParse({
      from: "evaluating",
      to: "recommendCanary",
      fromRevision: 4,
      toRevision: 5,
    }).success).toBeTrue();
    expect(optimizerExperimentTransitionSchema.safeParse({
      from: "evaluating",
      to: "recommendCanary",
      fromRevision: 4,
      toRevision: 6,
    }).success).toBeFalse();

    expect(isLegalOptimizerDeploymentTransition("inactive", "staged"))
      .toBeTrue();
    expect(isLegalOptimizerDeploymentTransition("staged", "accepted"))
      .toBeTrue();
    expect(isLegalOptimizerDeploymentTransition("accepted", "rolledBack"))
      .toBeTrue();
    expect(isLegalOptimizerDeploymentTransition("rolledBack", "accepted"))
      .toBeFalse();
    expect(optimizerDeploymentTransitionSchema.safeParse({
      from: "staged",
      to: "accepted",
      fromRevision: 1,
      toRevision: 2,
    }).success).toBeTrue();
  });
});
