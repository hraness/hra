import { createHash } from "node:crypto";

import {
  HRA_OPTIMIZER_SCHEMA_VERSION,
  OPTIMIZER_GATE_SPEC_V1,
  compileOptimizerAssignmentPlan,
  digestOptimizerBenchmarkRegistry,
  optimizerAssignmentKeyDigest,
  optimizerBenchmarkRegistrySchema,
  optimizerRegistryIdentityKeyDigest,
  mintOptimizerRegistryIdentity,
  type OptimizerBenchmarkRegistry,
  type OptimizerPairAssignment,
} from "../src/harness/optimizer-domain-v1";
import {
  optimizerArmOutcomeSchema,
  type OptimizerArmOutcome,
} from "../src/harness/optimizer-evidence-v1";

export const OPTIMIZER_FIXTURE_ASSIGNMENT_KEY = Uint8Array.from(
  { length: 32 },
  (_, index) => index + 1,
);
export const OPTIMIZER_FIXTURE_IDENTITY_KEY = Uint8Array.from(
  { length: 32 },
  (_, index) => 255 - index,
);
export const OPTIMIZER_FIXTURE_HEADROOM_DIGEST = fixtureDigest("headroom");

export function fixtureDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function makeOptimizerRegistry(options: Readonly<{
  familyCount?: number;
  replicatePairsPerFamily?: number;
  maximumPairAssignments?: number;
  maximumArmOutcomes?: number;
  maximumAggregateArmElapsedMilliseconds?: number;
  providerTokenCap?: number;
  elapsedMillisecondsCap?: number;
}> = {}): OptimizerBenchmarkRegistry {
  const familyCount = options.familyCount ?? 64;
  const replicatePairsPerFamily = options.replicatePairsPerFamily ?? 4;
  const identityKeyDigest = optimizerRegistryIdentityKeyDigest(
    OPTIMIZER_FIXTURE_IDENTITY_KEY,
  );
  if (identityKeyDigest === null) {
    throw new Error("fixture registry identity key is invalid");
  }
  const identityContract = {
    algorithmVersion: "hmac-sha256-registry-identity-v1" as const,
    keyVersion: 1,
    keyDigest: identityKeyDigest,
  };
  const identity = (kind: "family" | "case", marker: string): string => {
    const result = mintOptimizerRegistryIdentity(
      { contract: identityContract, kind },
      new TextEncoder().encode(marker),
      OPTIMIZER_FIXTURE_IDENTITY_KEY,
    );
    if (result.kind !== "minted") {
      throw new Error(`fixture registry identity failed: ${result.kind}`);
    }
    return result.identityDigest;
  };
  return optimizerBenchmarkRegistrySchema.parse({
    schemaVersion: HRA_OPTIMIZER_SCHEMA_VERSION,
    benchmarkVersion: "fixture-v1",
    state: "frozen",
    identityContract,
    gate: {
      ...OPTIMIZER_GATE_SPEC_V1,
      replicatePairsPerFamily,
    },
    matchedPartitionDesign: {
      schemaVersion: HRA_OPTIMIZER_SCHEMA_VERSION,
      partitions: [
        {
          partitionDigest: fixtureDigest("partition-a"),
          supportedProfiles: ["lunaMax", "solMax"],
          budgetHeadroomClassDigest: OPTIMIZER_FIXTURE_HEADROOM_DIGEST,
          exclusiveLeaseRequired: true,
          unrelatedAdmittedLoad: 0,
          freshCapabilitySnapshotRequired: true,
          freshQuotaSnapshotRequired: true,
        },
        {
          partitionDigest: fixtureDigest("partition-b"),
          supportedProfiles: ["lunaMax", "solMax"],
          budgetHeadroomClassDigest: OPTIMIZER_FIXTURE_HEADROOM_DIGEST,
          exclusiveLeaseRequired: true,
          unrelatedAdmittedLoad: 0,
          freshCapabilitySnapshotRequired: true,
          freshQuotaSnapshotRequired: true,
        },
      ],
      mappingBlockSize: 4,
      noPartitionReuseWithinPair: true,
      preEffectSnapshots: "requiredFresh",
      postEffectSnapshots: "required",
      carryoverDisposition: "missingEvidence",
    },
    capacity: {
      maximumPairAssignments: options.maximumPairAssignments ??
        familyCount * replicatePairsPerFamily,
      maximumArmOutcomes: options.maximumArmOutcomes ??
        familyCount * replicatePairsPerFamily * 2,
      maximumAggregateArmElapsedMilliseconds:
        options.maximumAggregateArmElapsedMilliseconds ??
          familyCount * replicatePairsPerFamily * 2 *
            (options.elapsedMillisecondsCap ?? 1_000),
    },
    tuningFamilyDigests: [],
    cases: Array.from({ length: familyCount }, (_, index) => ({
      familyDigest: identity("family", `family:${index}`),
      caseDigest: identity("case", `case:${index}`),
      partition: "holdout",
      workClass: "boundedLeaf",
      fixtureDigest: fixtureDigest(`fixture:${index}`),
      evaluator: {
        coverage: "complete",
        executableDigest: fixtureDigest("evaluator-executable"),
        argvTemplateDigest: fixtureDigest("evaluator-argv"),
        validatorSetDigest: fixtureDigest("validator-set"),
        blindedReviewerRubricDigest: fixtureDigest("reviewer-rubric"),
        baseFixtureDigest: fixtureDigest(`base-fixture:${index}`),
        allowedToolsDigest: fixtureDigest("allowed-tools"),
        networkRule: { kind: "none" },
        providerTokenCap: options.providerTokenCap ?? 10_000,
        elapsedMillisecondsCap: options.elapsedMillisecondsCap ?? 1_000,
        qualityFormula: "validatorsAndIndependentBlindedReviewer",
        actorSelfReportEligible: false,
      },
      freshEpochPerArmRequired: true,
      freshContextPerArmRequired: true,
      freshWorkspacePerArmRequired: true,
      reworkPolicy: "retainFamilyPairAndOrder",
    })),
  });
}

export function makeOptimizerAssignments(
  registry: OptimizerBenchmarkRegistry,
  key: Uint8Array = OPTIMIZER_FIXTURE_ASSIGNMENT_KEY,
): readonly OptimizerPairAssignment[] {
  const registryDigest = digestOptimizerBenchmarkRegistry(registry);
  const keyDigest = optimizerAssignmentKeyDigest(key);
  if (keyDigest === null) throw new Error("fixture assignment key is invalid");
  const assignments: OptimizerPairAssignment[] = [];
  for (const benchmarkCase of registry.cases) {
    const plan = compileOptimizerAssignmentPlan({
      registryDigest,
      benchmarkCase,
      matchedPartitionDesign: registry.matchedPartitionDesign,
      replicatePairsPerFamily: registry.gate.replicatePairsPerFamily,
      keyVersion: 1,
      expectedKeyDigest: keyDigest,
    }, key);
    if (plan.kind !== "assigned") {
      throw new Error(`fixture assignment failed: ${plan.kind}`);
    }
    assignments.push(...plan.assignments);
  }
  return Object.freeze(assignments);
}

export function makeOptimizerOutcome(
  assignment: OptimizerPairAssignment,
  arm: "candidate" | "control",
): OptimizerArmOutcome {
  const marker = `${assignment.assignmentDigest}:${arm}`;
  const candidate = arm === "candidate";
  return optimizerArmOutcomeSchema.parse({
    schemaVersion: HRA_OPTIMIZER_SCHEMA_VERSION,
    assignmentDigest: assignment.assignmentDigest,
    familyDigest: assignment.familyDigest,
    caseDigest: assignment.caseDigest,
    replicateOrdinal: assignment.replicateOrdinal,
    arm,
    requestedPolicy: candidate ? "solOnly" : "lunaThenSol",
    disposition: "completed",
    quality: { kind: candidate ? "observedPass" : "observedFail" },
    safety: {
      kind: "exact",
      evidenceDigest: fixtureDigest(`safety:${marker}`),
    },
    evidenceIntegrity: {
      kind: "exact",
      evidenceDigest: fixtureDigest(`integrity:${marker}`),
    },
    profile: {
      kind: "observed",
      requestedProfile: candidate ? "solMax" : "lunaMax",
      observedProfile: candidate ? "solMax" : "lunaMax",
      fallbackReason: null,
      capabilityEvidenceDigest: fixtureDigest(`profile:${marker}`),
    },
    effectLineage: {
      kind: "settled",
      prepareReceiptDigest: fixtureDigest(`prepare:${marker}`),
      effectStartReceiptDigest: fixtureDigest(`effect:${marker}`),
      terminalReceiptDigest: fixtureDigest(`terminal:${marker}`),
      processGeneration: 1,
      elapsedStartBoundary:
        "afterPairLeasesSnapshotsAndArmEffectAdmission",
    },
    evaluation: {
      kind: "settled",
      validatorVerdict: candidate ? "pass" : "fail",
      reviewerVerdict: candidate ? "pass" : "fail",
      evaluatorReceiptDigest: fixtureDigest(`evaluator:${marker}`),
      producerActorDigest: fixtureDigest(`producer:${marker}`),
      reviewerDigest: fixtureDigest(`reviewer:${marker}`),
      reviewerIndependent: true,
      reviewerBlindedToArm: true,
      reviewerBlindedToProfile: true,
      reviewerBlindedToUsage: true,
      reviewerBlindedToOtherArm: true,
      validatorInputsBlindedToArm: true,
      validatorInputsBlindedToProfile: true,
      validatorInputsBlindedToUsage: true,
      validatorInputsBlindedToOtherArm: true,
      evaluatorInputsBlindedToArm: true,
      evaluatorInputsBlindedToProfile: true,
      evaluatorInputsBlindedToUsage: true,
      evaluatorInputsBlindedToOtherArm: true,
      actorSelfReportEligible: false,
    },
    partition: {
      kind: "exact",
      partitionDigest: candidate
        ? assignment.candidatePartitionDigest
        : assignment.controlPartitionDigest,
      leaseReceiptDigest: fixtureDigest(`lease:${marker}`),
      budgetHeadroomClassDigest: OPTIMIZER_FIXTURE_HEADROOM_DIGEST,
      preEffectCapabilitySnapshotDigest: fixtureDigest(
        `pre-capability:${marker}`,
      ),
      preEffectQuotaSnapshotDigest: fixtureDigest(`pre-quota:${marker}`),
      postEffectCapabilitySnapshotDigest: fixtureDigest(
        `post-capability:${marker}`,
      ),
      postEffectQuotaSnapshotDigest: fixtureDigest(`post-quota:${marker}`),
      unrelatedAdmittedLoad: 0,
      leaseMode: "exclusive",
    },
    isolation: {
      epochDigest: fixtureDigest(`epoch:${marker}`),
      contextDigest: fixtureDigest(`context:${marker}`),
      workspaceDigest: fixtureDigest(`workspace:${marker}`),
      exposedBeforeAssignment: false,
    },
    providerTokens: {
      kind: "exact",
      inputTokens: 80,
      cachedInputTokens: 20,
      outputTokens: 20,
      reasoningOutputTokens: 10,
      totalTokens: 100,
    },
    elapsed: {
      kind: "exact",
      milliseconds: 1_000,
      partitionAcquisitionWaitMilliseconds: 25,
      clock: "monotonicSingleGeneration",
      startBoundary: "afterPairLeasesSnapshotsAndArmEffectAdmission",
    },
  });
}

export function makePassingOptimizerGateFixture(options: Readonly<{
  providerTokenCap?: number;
  elapsedMillisecondsCap?: number;
}> = {}): Readonly<{
  registry: OptimizerBenchmarkRegistry;
  registryDigest: string;
  assignments: readonly OptimizerPairAssignment[];
  outcomes: readonly OptimizerArmOutcome[];
}> {
  const registry = makeOptimizerRegistry(options);
  const registryDigest = digestOptimizerBenchmarkRegistry(registry);
  const assignments = makeOptimizerAssignments(registry);
  const outcomes = assignments.flatMap((assignment) => [
    makeOptimizerOutcome(assignment, "candidate"),
    makeOptimizerOutcome(assignment, "control"),
  ]);
  return Object.freeze({
    registry,
    registryDigest,
    assignments,
    outcomes: Object.freeze(outcomes),
  });
}
