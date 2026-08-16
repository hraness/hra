import { createHash, createHmac } from "node:crypto";

import { z } from "@hra-internal/schema";

export const HRA_OPTIMIZER_SCHEMA_VERSION = 1 as const;
export const HRA_OPTIMIZER_MIN_FAMILIES = 64;
export const HRA_OPTIMIZER_MAX_FAMILIES = 4_096;
export const HRA_OPTIMIZER_ASSIGNMENT_BLOCK_SIZE = 4;
export const HRA_OPTIMIZER_MAX_REPLICATE_PAIRS = 64;

const OPTIMIZER_HASH_PREFIX = "hra.optimizer.v1";
const ASSIGNMENT_KEY_BYTES = 32;

export const optimizerDigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const optimizerRegistryIdentityContractSchema = z.object({
  algorithmVersion: z.literal("hmac-sha256-registry-identity-v1"),
  keyVersion: z.number().int().positive().safe(),
  keyDigest: optimizerDigestSchema,
}).strict();
export type OptimizerRegistryIdentityContract = z.infer<
  typeof optimizerRegistryIdentityContractSchema
>;

const optimizerRegistryIdentityInputSchema = z.object({
  contract: optimizerRegistryIdentityContractSchema,
  kind: z.enum(["family", "case"]),
}).strict();

export type OptimizerRegistryIdentityResult =
  | Readonly<{ kind: "minted"; identityDigest: string }>
  | Readonly<{
      kind: "recoveryRequired";
      reason: "identityKeyUnavailable" | "identityKeyMismatch";
    }>
  | Readonly<{
      kind: "invalidInput";
      reason: "invalidIdentityInput" | "invalidIdentityKey" |
        "invalidIdentityMaterial";
    }>;

export type OptimizerRegistryIdentityVerificationResult =
  | Readonly<{ kind: "verified"; identityDigest: string }>
  | Readonly<{ kind: "conflict"; identityDigest: string }>
  | Exclude<OptimizerRegistryIdentityResult, Readonly<{ kind: "minted" }>>;

export const optimizerPolicySchema = z.enum(["lunaThenSol", "solOnly"]);
export type OptimizerPolicy = z.infer<typeof optimizerPolicySchema>;

export const optimizerPolicyRevisionSchema = z.object({
  schemaVersion: z.literal(HRA_OPTIMIZER_SCHEMA_VERSION),
  largeChange: z.literal("solUltra"),
  wideResearch: z.literal("solUltra"),
  standard: z.literal("solMax"),
  boundedLeaf: optimizerPolicySchema,
  automaticFast: z.literal("inheritHarnessSetting"),
  nativeCollaboration: z.literal(false),
}).strict();
export type OptimizerPolicyRevision = z.infer<
  typeof optimizerPolicyRevisionSchema
>;

export const OPTIMIZER_CONTROL_POLICY_V1 = Object.freeze({
  schemaVersion: HRA_OPTIMIZER_SCHEMA_VERSION,
  largeChange: "solUltra",
  wideResearch: "solUltra",
  standard: "solMax",
  boundedLeaf: "lunaThenSol",
  automaticFast: "inheritHarnessSetting",
  nativeCollaboration: false,
} satisfies OptimizerPolicyRevision);

export const OPTIMIZER_CANDIDATE_POLICY_V1 = Object.freeze({
  ...OPTIMIZER_CONTROL_POLICY_V1,
  boundedLeaf: "solOnly",
} satisfies OptimizerPolicyRevision);

export const optimizerArmSchema = z.enum(["candidate", "control"]);
export type OptimizerArm = z.infer<typeof optimizerArmSchema>;

export const optimizerGateSpecSchema = z.object({
  schemaVersion: z.literal(HRA_OPTIMIZER_SCHEMA_VERSION),
  objective: z.literal("qualityUpgrade"),
  controlPolicy: optimizerPolicyRevisionSchema.extend({
    boundedLeaf: z.literal("lunaThenSol"),
  }).strict(),
  candidatePolicy: optimizerPolicyRevisionSchema.extend({
    boundedLeaf: z.literal("solOnly"),
  }).strict(),
  minimumFamilyCount: z.literal(HRA_OPTIMIZER_MIN_FAMILIES),
  maximumFamilyCount: z.literal(HRA_OPTIMIZER_MAX_FAMILIES),
  replicatePairsPerFamily: z.number().int()
    .min(HRA_OPTIMIZER_ASSIGNMENT_BLOCK_SIZE)
    .max(HRA_OPTIMIZER_MAX_REPLICATE_PAIRS)
    .refine(
      (value) => value % HRA_OPTIMIZER_ASSIGNMENT_BLOCK_SIZE === 0,
      "optimizer replicates must fill complete assignment blocks",
    ),
  qualityDeltaBasisPoints: z.literal(500),
  compositionTrimBasisPoints: z.literal(500),
  compositionDeltaBasisPoints: z.literal(200),
  maximumProviderTokenHarmBasisPoints: z.literal(11_000),
  maximumElapsedHarmBasisPoints: z.literal(11_000),
}).strict();
export type OptimizerGateSpec = z.infer<typeof optimizerGateSpecSchema>;

export const OPTIMIZER_GATE_SPEC_V1 = Object.freeze({
  schemaVersion: HRA_OPTIMIZER_SCHEMA_VERSION,
  objective: "qualityUpgrade",
  controlPolicy: OPTIMIZER_CONTROL_POLICY_V1,
  candidatePolicy: OPTIMIZER_CANDIDATE_POLICY_V1,
  minimumFamilyCount: HRA_OPTIMIZER_MIN_FAMILIES,
  maximumFamilyCount: HRA_OPTIMIZER_MAX_FAMILIES,
  replicatePairsPerFamily: HRA_OPTIMIZER_ASSIGNMENT_BLOCK_SIZE,
  qualityDeltaBasisPoints: 500,
  compositionTrimBasisPoints: 500,
  compositionDeltaBasisPoints: 200,
  maximumProviderTokenHarmBasisPoints: 11_000,
  maximumElapsedHarmBasisPoints: 11_000,
} satisfies OptimizerGateSpec);

const partitionProfileSetSchema = z.tuple([
  z.literal("lunaMax"),
  z.literal("solMax"),
]);

export const optimizerEvaluationPartitionSchema = z.object({
  partitionDigest: optimizerDigestSchema,
  supportedProfiles: partitionProfileSetSchema,
  budgetHeadroomClassDigest: optimizerDigestSchema,
  exclusiveLeaseRequired: z.literal(true),
  unrelatedAdmittedLoad: z.literal(0),
  freshCapabilitySnapshotRequired: z.literal(true),
  freshQuotaSnapshotRequired: z.literal(true),
}).strict();
export type OptimizerEvaluationPartition = z.infer<
  typeof optimizerEvaluationPartitionSchema
>;

export const optimizerMatchedPartitionDesignSchema = z.object({
  schemaVersion: z.literal(HRA_OPTIMIZER_SCHEMA_VERSION),
  partitions: z.tuple([
    optimizerEvaluationPartitionSchema,
    optimizerEvaluationPartitionSchema,
  ]),
  mappingBlockSize: z.literal(HRA_OPTIMIZER_ASSIGNMENT_BLOCK_SIZE),
  noPartitionReuseWithinPair: z.literal(true),
  preEffectSnapshots: z.literal("requiredFresh"),
  postEffectSnapshots: z.literal("required"),
  carryoverDisposition: z.literal("missingEvidence"),
}).strict().superRefine((design, context) => {
  const [first, second] = design.partitions;
  if (first.partitionDigest === second.partitionDigest) {
    context.addIssue({
      code: "custom",
      message: "optimizer evaluation partitions must be disjoint",
      path: ["partitions", 1, "partitionDigest"],
    });
  }
  if (first.budgetHeadroomClassDigest !== second.budgetHeadroomClassDigest) {
    context.addIssue({
      code: "custom",
      message: "optimizer evaluation partitions must have matched headroom",
      path: ["partitions", 1, "budgetHeadroomClassDigest"],
    });
  }
});
export type OptimizerMatchedPartitionDesign = z.infer<
  typeof optimizerMatchedPartitionDesignSchema
>;

export const optimizerDesignCapacitySchema = z.object({
  maximumPairAssignments: z.number().int().nonnegative().safe(),
  maximumArmOutcomes: z.number().int().nonnegative().safe(),
  maximumAggregateArmElapsedMilliseconds: z.number().int().nonnegative().safe(),
}).strict();
export type OptimizerDesignCapacity = z.infer<
  typeof optimizerDesignCapacitySchema
>;

export const optimizerNetworkRuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({
    kind: z.literal("boundedEndpoint"),
    endpointRuleDigest: optimizerDigestSchema,
  }).strict(),
]);

export const optimizerEvaluatorContractSchema = z.object({
  coverage: z.literal("complete"),
  executableDigest: optimizerDigestSchema,
  argvTemplateDigest: optimizerDigestSchema,
  validatorSetDigest: optimizerDigestSchema,
  blindedReviewerRubricDigest: optimizerDigestSchema,
  baseFixtureDigest: optimizerDigestSchema,
  allowedToolsDigest: optimizerDigestSchema,
  networkRule: optimizerNetworkRuleSchema,
  providerTokenCap: z.number().int().positive().safe(),
  elapsedMillisecondsCap: z.number().int().positive().safe(),
  qualityFormula: z.literal("validatorsAndIndependentBlindedReviewer"),
  actorSelfReportEligible: z.literal(false),
}).strict();
export type OptimizerEvaluatorContract = z.infer<
  typeof optimizerEvaluatorContractSchema
>;

export const optimizerBenchmarkCaseSchema = z.object({
  familyDigest: optimizerDigestSchema,
  caseDigest: optimizerDigestSchema,
  partition: z.literal("holdout"),
  workClass: z.literal("boundedLeaf"),
  fixtureDigest: optimizerDigestSchema,
  evaluator: optimizerEvaluatorContractSchema,
  freshEpochPerArmRequired: z.literal(true),
  freshContextPerArmRequired: z.literal(true),
  freshWorkspacePerArmRequired: z.literal(true),
  reworkPolicy: z.literal("retainFamilyPairAndOrder"),
}).strict();
export type OptimizerBenchmarkCase = z.infer<
  typeof optimizerBenchmarkCaseSchema
>;

const optimizerBenchmarkRegistryShapeSchema = z.object({
  schemaVersion: z.literal(HRA_OPTIMIZER_SCHEMA_VERSION),
  benchmarkVersion: z.string().min(1).max(64)
    .regex(/^[A-Za-z0-9._-]+$/u),
  state: z.literal("frozen"),
  identityContract: optimizerRegistryIdentityContractSchema,
  gate: optimizerGateSpecSchema,
  matchedPartitionDesign: optimizerMatchedPartitionDesignSchema,
  capacity: optimizerDesignCapacitySchema,
  tuningFamilyDigests: z.array(optimizerDigestSchema)
    .max(HRA_OPTIMIZER_MAX_FAMILIES),
  cases: z.array(optimizerBenchmarkCaseSchema)
    .min(1)
    .max(HRA_OPTIMIZER_MAX_FAMILIES),
}).strict();

export const optimizerBenchmarkRegistrySchema =
  optimizerBenchmarkRegistryShapeSchema.superRefine((registry, context) => {
    const familyDigests = registry.cases.map(({ familyDigest }) => familyDigest);
    const caseDigests = registry.cases.map(({ caseDigest }) => caseDigest);
    if (new Set(familyDigests).size !== familyDigests.length) {
      context.addIssue({
        code: "custom",
        message: "optimizer registry requires exactly one case per family",
        path: ["cases"],
      });
    }
    if (new Set(caseDigests).size !== caseDigests.length) {
      context.addIssue({
        code: "custom",
        message: "optimizer case digests must be unique",
        path: ["cases"],
      });
    }
    if (new Set(registry.tuningFamilyDigests).size !==
      registry.tuningFamilyDigests.length) {
      context.addIssue({
        code: "custom",
        message: "optimizer tuning family digests must be unique",
        path: ["tuningFamilyDigests"],
      });
    }
    const tuning = new Set(registry.tuningFamilyDigests);
    for (const [index, familyDigest] of familyDigests.entries()) {
      if (tuning.has(familyDigest)) {
        context.addIssue({
          code: "custom",
          message: "optimizer tuning and holdout families must be disjoint",
          path: ["cases", index, "familyDigest"],
        });
      }
    }
  });
export type OptimizerBenchmarkRegistry = z.infer<
  typeof optimizerBenchmarkRegistrySchema
>;

export const optimizerFeasibilityReasonSchema = z.enum([
  "invalidRegistry",
  "duplicateFamily",
  "duplicateCase",
  "duplicateTuningFamily",
  "familyLeakage",
  "familyCountBelowMinimum",
  "familyCountAboveMaximum",
  "replicateCountNotBlockBalanced",
  "compositionResolutionInsufficient",
  "pairAssignmentCapacityInsufficient",
  "armOutcomeCapacityInsufficient",
  "runtimeCapacityInsufficient",
]);
export type OptimizerFeasibilityReason = z.infer<
  typeof optimizerFeasibilityReasonSchema
>;

export type OptimizerFeasibilityResult =
  | Readonly<{
      kind: "feasible";
      registryDigest: string;
      requiredPairAssignments: number;
      requiredArmOutcomes: number;
      requiredAggregateArmElapsedMilliseconds: string;
    }>
  | Readonly<{
      kind: "infeasible";
      reasons: readonly OptimizerFeasibilityReason[];
      registryDigest: string | null;
      requiredPairAssignments: number | null;
      requiredArmOutcomes: number | null;
      requiredAggregateArmElapsedMilliseconds: string | null;
    }>;

export function assessOptimizerBenchmarkFeasibility(
  value: unknown,
): OptimizerFeasibilityResult {
  const shape = optimizerBenchmarkRegistryShapeSchema.safeParse(value);
  if (!shape.success) {
    return Object.freeze({
      kind: "infeasible",
      reasons: Object.freeze([
        "invalidRegistry" as const,
      ]),
      registryDigest: null,
      requiredPairAssignments: null,
      requiredArmOutcomes: null,
      requiredAggregateArmElapsedMilliseconds: null,
    });
  }

  const registry = shape.data;
  const reasons = new Set<OptimizerFeasibilityReason>();
  const familyDigests = registry.cases.map(({ familyDigest }) => familyDigest);
  const caseDigests = registry.cases.map(({ caseDigest }) => caseDigest);
  if (new Set(familyDigests).size !== familyDigests.length) {
    reasons.add("duplicateFamily");
  }
  if (new Set(caseDigests).size !== caseDigests.length) {
    reasons.add("duplicateCase");
  }
  if (new Set(registry.tuningFamilyDigests).size !==
    registry.tuningFamilyDigests.length) {
    reasons.add("duplicateTuningFamily");
  }
  const tuning = new Set(registry.tuningFamilyDigests);
  if (familyDigests.some((familyDigest) => tuning.has(familyDigest))) {
    reasons.add("familyLeakage");
  }

  const familyCount = registry.cases.length;
  if (familyCount < registry.gate.minimumFamilyCount) {
    reasons.add("familyCountBelowMinimum");
  }
  if (familyCount > registry.gate.maximumFamilyCount) {
    reasons.add("familyCountAboveMaximum");
  }
  const replicates = registry.gate.replicatePairsPerFamily;
  if (replicates % registry.matchedPartitionDesign.mappingBlockSize !== 0) {
    reasons.add("replicateCountNotBlockBalanced");
  }

  const trimmedFamilies = ceilRatio(
    BigInt(familyCount) *
      BigInt(registry.gate.compositionTrimBasisPoints),
    10_000n,
  );
  const remainingFamilyCount = BigInt(familyCount) - trimmedFamilies;
  if (remainingFamilyCount <= 0n ||
    remainingFamilyCount * BigInt(replicates) < 50n) {
    reasons.add("compositionResolutionInsufficient");
  }

  const requiredPairAssignments = familyCount * replicates;
  const requiredArmOutcomes = requiredPairAssignments * 2;
  if (registry.capacity.maximumPairAssignments < requiredPairAssignments) {
    reasons.add("pairAssignmentCapacityInsufficient");
  }
  if (registry.capacity.maximumArmOutcomes < requiredArmOutcomes) {
    reasons.add("armOutcomeCapacityInsufficient");
  }
  const requiredAggregateArmElapsedMilliseconds = registry.cases.reduce(
    (total, benchmarkCase) => total +
      BigInt(benchmarkCase.evaluator.elapsedMillisecondsCap) *
        BigInt(replicates) * 2n,
    0n,
  );
  if (BigInt(registry.capacity.maximumAggregateArmElapsedMilliseconds) <
    requiredAggregateArmElapsedMilliseconds) {
    reasons.add("runtimeCapacityInsufficient");
  }

  const registryResult = optimizerBenchmarkRegistrySchema.safeParse(registry);
  const registryDigest = registryResult.success
    ? digestOptimizerBenchmarkRegistry(registryResult.data)
    : null;
  if (!registryResult.success && reasons.size === 0) {
    reasons.add("invalidRegistry");
  }
  if (reasons.size > 0) {
    return Object.freeze({
      kind: "infeasible",
      reasons: Object.freeze([...reasons].sort()),
      registryDigest,
      requiredPairAssignments,
      requiredArmOutcomes,
      requiredAggregateArmElapsedMilliseconds:
        requiredAggregateArmElapsedMilliseconds.toString(),
    });
  }
  if (registryDigest === null) {
    throw new Error("feasible optimizer registry is missing its digest");
  }
  return Object.freeze({
    kind: "feasible",
    registryDigest,
    requiredPairAssignments,
    requiredArmOutcomes,
    requiredAggregateArmElapsedMilliseconds:
      requiredAggregateArmElapsedMilliseconds.toString(),
  });
}

const optimizerAssignmentPlanInputSchema = z.object({
  registryDigest: optimizerDigestSchema,
  benchmarkCase: optimizerBenchmarkCaseSchema,
  matchedPartitionDesign: optimizerMatchedPartitionDesignSchema,
  replicatePairsPerFamily: z.number().int()
    .min(HRA_OPTIMIZER_ASSIGNMENT_BLOCK_SIZE)
    .max(HRA_OPTIMIZER_MAX_REPLICATE_PAIRS)
    .refine(
      (value) => value % HRA_OPTIMIZER_ASSIGNMENT_BLOCK_SIZE === 0,
      "optimizer assignment plans require complete blocks",
    ),
  keyVersion: z.number().int().positive().safe(),
  expectedKeyDigest: optimizerDigestSchema,
}).strict();
export type OptimizerAssignmentPlanInput = z.infer<
  typeof optimizerAssignmentPlanInputSchema
>;

export const optimizerExecutionOrderSchema = z.enum([
  "candidateFirst",
  "controlFirst",
]);
export type OptimizerExecutionOrder = z.infer<
  typeof optimizerExecutionOrderSchema
>;

const optimizerPairAssignmentPayloadSchema = z.object({
  schemaVersion: z.literal(HRA_OPTIMIZER_SCHEMA_VERSION),
  algorithmVersion: z.literal("hmac-sha256-complete-block-v1"),
  registryDigest: optimizerDigestSchema,
  familyDigest: optimizerDigestSchema,
  caseDigest: optimizerDigestSchema,
  keyVersion: z.number().int().positive().safe(),
  keyDigest: optimizerDigestSchema,
  blockId: optimizerDigestSchema,
  blockIndex: z.number().int().nonnegative().safe(),
  blockPosition: z.number().int().min(0)
    .max(HRA_OPTIMIZER_ASSIGNMENT_BLOCK_SIZE - 1),
  replicateOrdinal: z.number().int().nonnegative().safe(),
  executionOrder: optimizerExecutionOrderSchema,
  candidatePartitionDigest: optimizerDigestSchema,
  controlPartitionDigest: optimizerDigestSchema,
  permutationWitnessDigest: optimizerDigestSchema,
}).strict().superRefine((assignment, context) => {
  if (assignment.replicateOrdinal !==
    assignment.blockIndex * HRA_OPTIMIZER_ASSIGNMENT_BLOCK_SIZE +
      assignment.blockPosition) {
    context.addIssue({
      code: "custom",
      message: "optimizer replicate ordinal must match its block position",
      path: ["replicateOrdinal"],
    });
  }
  if (assignment.candidatePartitionDigest ===
    assignment.controlPartitionDigest) {
    context.addIssue({
      code: "custom",
      message: "optimizer pair cannot reuse one partition",
      path: ["controlPartitionDigest"],
    });
  }
  const expectedBlockId = optimizerDomainDigest("assignment-block", {
    registryDigest: assignment.registryDigest,
    familyDigest: assignment.familyDigest,
    caseDigest: assignment.caseDigest,
    keyVersion: assignment.keyVersion,
    keyDigest: assignment.keyDigest,
    blockIndex: assignment.blockIndex,
  });
  if (assignment.blockId !== expectedBlockId) {
    context.addIssue({
      code: "custom",
      message: "optimizer assignment block identity is invalid",
      path: ["blockId"],
    });
  }
});
export type OptimizerPairAssignmentPayload = z.infer<
  typeof optimizerPairAssignmentPayloadSchema
>;

export function digestOptimizerPairAssignmentPayload(value: unknown): string {
  return optimizerDomainDigest(
    "pair-assignment",
    optimizerPairAssignmentPayloadSchema.parse(value),
  );
}

export const optimizerPairAssignmentSchema =
  optimizerPairAssignmentPayloadSchema.safeExtend({
    assignmentDigest: optimizerDigestSchema,
  }).superRefine((assignment, context) => {
    const { assignmentDigest, ...payload } = assignment;
    if (assignmentDigest !== digestOptimizerPairAssignmentPayload(payload)) {
      context.addIssue({
        code: "custom",
        message: "optimizer assignment digest is invalid",
        path: ["assignmentDigest"],
      });
    }
  });
export type OptimizerPairAssignment = z.infer<
  typeof optimizerPairAssignmentSchema
>;

export type OptimizerAssignmentPlanResult =
  | Readonly<{
      kind: "assigned";
      keyDigest: string;
      assignments: readonly OptimizerPairAssignment[];
      planDigest: string;
    }>
  | Readonly<{
      kind: "recoveryRequired";
      reason: "assignmentKeyUnavailable" | "assignmentKeyMismatch";
    }>
  | Readonly<{
      kind: "invalidInput";
      reason: "invalidAssignmentPlan" | "invalidAssignmentKey";
    }>;

export function optimizerAssignmentKeyDigest(keyValue: unknown): string | null {
  if (!(keyValue instanceof Uint8Array) ||
    keyValue.byteLength !== ASSIGNMENT_KEY_BYTES) return null;
  return optimizerByteDigest("assignment-key", keyValue);
}

export function optimizerRegistryIdentityKeyDigest(
  keyValue: unknown,
): string | null {
  if (!(keyValue instanceof Uint8Array) ||
    keyValue.byteLength !== ASSIGNMENT_KEY_BYTES) return null;
  return optimizerByteDigest("registry-identity-key", keyValue);
}

export function mintOptimizerRegistryIdentity(
  inputValue: unknown,
  identityMaterialValue: unknown,
  keyValue: unknown,
): OptimizerRegistryIdentityResult {
  const input = optimizerRegistryIdentityInputSchema.safeParse(inputValue);
  if (!input.success) {
    return Object.freeze({
      kind: "invalidInput",
      reason: "invalidIdentityInput",
    });
  }
  if (keyValue === null) {
    return Object.freeze({
      kind: "recoveryRequired",
      reason: "identityKeyUnavailable",
    });
  }
  if (!(keyValue instanceof Uint8Array) ||
    keyValue.byteLength !== ASSIGNMENT_KEY_BYTES) {
    return Object.freeze({
      kind: "invalidInput",
      reason: "invalidIdentityKey",
    });
  }
  if (!(identityMaterialValue instanceof Uint8Array) ||
    identityMaterialValue.byteLength === 0 ||
    identityMaterialValue.byteLength > 4_096) {
    return Object.freeze({
      kind: "invalidInput",
      reason: "invalidIdentityMaterial",
    });
  }
  const keyDigest = optimizerRegistryIdentityKeyDigest(keyValue);
  if (keyDigest === null) {
    throw new Error("validated registry identity key lost its digest");
  }
  if (keyDigest !== input.data.contract.keyDigest) {
    return Object.freeze({
      kind: "recoveryRequired",
      reason: "identityKeyMismatch",
    });
  }
  return Object.freeze({
    kind: "minted",
    identityDigest: optimizerIdentityHmac(
      keyValue,
      input.data.kind,
      input.data.contract,
      identityMaterialValue,
    ),
  });
}

export function verifyOptimizerRegistryIdentity(
  inputValue: unknown,
  expectedIdentityDigestValue: unknown,
  identityMaterialValue: unknown,
  keyValue: unknown,
): OptimizerRegistryIdentityVerificationResult {
  const expected = optimizerDigestSchema.safeParse(expectedIdentityDigestValue);
  if (!expected.success) {
    return Object.freeze({
      kind: "invalidInput",
      reason: "invalidIdentityInput",
    });
  }
  const minted = mintOptimizerRegistryIdentity(
    inputValue,
    identityMaterialValue,
    keyValue,
  );
  if (minted.kind !== "minted") return minted;
  return minted.identityDigest === expected.data
    ? Object.freeze({ kind: "verified", identityDigest: minted.identityDigest })
    : Object.freeze({ kind: "conflict", identityDigest: minted.identityDigest });
}

export function compileOptimizerAssignmentPlan(
  inputValue: unknown,
  keyValue: unknown,
): OptimizerAssignmentPlanResult {
  const inputResult = optimizerAssignmentPlanInputSchema.safeParse(inputValue);
  if (!inputResult.success) {
    return Object.freeze({
      kind: "invalidInput",
      reason: "invalidAssignmentPlan",
    });
  }
  if (keyValue === null) {
    return Object.freeze({
      kind: "recoveryRequired",
      reason: "assignmentKeyUnavailable",
    });
  }
  if (!(keyValue instanceof Uint8Array) ||
    keyValue.byteLength !== ASSIGNMENT_KEY_BYTES) {
    return Object.freeze({
      kind: "invalidInput",
      reason: "invalidAssignmentKey",
    });
  }
  const input = inputResult.data;
  const keyDigest = optimizerAssignmentKeyDigest(keyValue);
  if (keyDigest === null) {
    throw new Error("validated optimizer key is missing its digest");
  }
  if (keyDigest !== input.expectedKeyDigest) {
    return Object.freeze({
      kind: "recoveryRequired",
      reason: "assignmentKeyMismatch",
    });
  }

  const assignments: OptimizerPairAssignment[] = [];
  const blockCount = input.replicatePairsPerFamily /
    HRA_OPTIMIZER_ASSIGNMENT_BLOCK_SIZE;
  for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
    assignments.push(...compileAssignmentBlock(input, keyValue, blockIndex));
  }
  const frozenAssignments = Object.freeze(assignments);
  return Object.freeze({
    kind: "assigned",
    keyDigest,
    assignments: frozenAssignments,
    planDigest: optimizerDomainDigest(
      "assignment-plan",
      frozenAssignments.map(({ assignmentDigest }) => assignmentDigest),
    ),
  });
}

type AssignmentCombination = Readonly<{
  executionOrder: OptimizerExecutionOrder;
  candidatePartitionIndex: 0 | 1;
}>;

const ASSIGNMENT_COMBINATIONS: readonly AssignmentCombination[] = Object.freeze([
  Object.freeze({
    executionOrder: "candidateFirst",
    candidatePartitionIndex: 0,
  }),
  Object.freeze({
    executionOrder: "candidateFirst",
    candidatePartitionIndex: 1,
  }),
  Object.freeze({
    executionOrder: "controlFirst",
    candidatePartitionIndex: 0,
  }),
  Object.freeze({
    executionOrder: "controlFirst",
    candidatePartitionIndex: 1,
  }),
]);

function compileAssignmentBlock(
  input: OptimizerAssignmentPlanInput,
  key: Uint8Array,
  blockIndex: number,
): readonly OptimizerPairAssignment[] {
  const blockScope = {
    registryDigest: input.registryDigest,
    familyDigest: input.benchmarkCase.familyDigest,
    caseDigest: input.benchmarkCase.caseDigest,
    keyVersion: input.keyVersion,
    expectedKeyDigest: input.expectedKeyDigest,
    blockIndex,
  };
  const ranked = ASSIGNMENT_COMBINATIONS.map((combination) => ({
    combination,
    rank: optimizerAssignmentHmac(key, "assignment-rank", {
      ...blockScope,
      combination,
    }),
  })).sort((left, right) =>
    left.rank.localeCompare(right.rank) ||
    combinationKey(left.combination).localeCompare(
      combinationKey(right.combination),
    )
  );
  const permutationWitnessDigest = optimizerAssignmentHmac(
    key,
    "assignment-permutation",
    ranked.map(({ combination }) => combination),
  );
  const blockId = optimizerDomainDigest("assignment-block", {
    registryDigest: input.registryDigest,
    familyDigest: input.benchmarkCase.familyDigest,
    caseDigest: input.benchmarkCase.caseDigest,
    keyVersion: input.keyVersion,
    keyDigest: input.expectedKeyDigest,
    blockIndex,
  });
  const [firstPartition, secondPartition] =
    input.matchedPartitionDesign.partitions;

  return ranked.map(({ combination }, blockPosition) => {
    const candidatePartition = combination.candidatePartitionIndex === 0
      ? firstPartition
      : secondPartition;
    const controlPartition = combination.candidatePartitionIndex === 0
      ? secondPartition
      : firstPartition;
    const payload = optimizerPairAssignmentPayloadSchema.parse({
      schemaVersion: HRA_OPTIMIZER_SCHEMA_VERSION,
      algorithmVersion: "hmac-sha256-complete-block-v1",
      registryDigest: input.registryDigest,
      familyDigest: input.benchmarkCase.familyDigest,
      caseDigest: input.benchmarkCase.caseDigest,
      keyVersion: input.keyVersion,
      keyDigest: input.expectedKeyDigest,
      blockId,
      blockIndex,
      blockPosition,
      replicateOrdinal:
        blockIndex * HRA_OPTIMIZER_ASSIGNMENT_BLOCK_SIZE + blockPosition,
      executionOrder: combination.executionOrder,
      candidatePartitionDigest: candidatePartition.partitionDigest,
      controlPartitionDigest: controlPartition.partitionDigest,
      permutationWitnessDigest,
    });
    return Object.freeze({
      ...payload,
      assignmentDigest: digestOptimizerPairAssignmentPayload(payload),
    });
  });
}

function combinationKey(combination: AssignmentCombination): string {
  return `${combination.executionOrder}:${combination.candidatePartitionIndex}`;
}

export function digestOptimizerBenchmarkRegistry(value: unknown): string {
  const registry = optimizerBenchmarkRegistrySchema.parse(value);
  return optimizerDomainDigest("benchmark-registry", {
    ...registry,
    tuningFamilyDigests: [...registry.tuningFamilyDigests].sort(),
    cases: [...registry.cases].sort((left, right) =>
      left.familyDigest.localeCompare(right.familyDigest) ||
      left.caseDigest.localeCompare(right.caseDigest)
    ),
  });
}

export function digestOptimizerPolicyRevision(value: unknown): string {
  return optimizerDomainDigest(
    "policy-revision",
    optimizerPolicyRevisionSchema.parse(value),
  );
}

export const optimizerExperimentStateSchema = z.enum([
  "preparing",
  "evaluating",
  "recommendCanary",
  "reviewApproved",
  "rolloutRunning",
  "passed",
  "failed",
  "inconclusive",
  "contained",
  "superseded",
  "recoveryRequired",
]);
export type OptimizerExperimentState = z.infer<
  typeof optimizerExperimentStateSchema
>;

const EXPERIMENT_TRANSITIONS = Object.freeze({
  preparing: Object.freeze(["evaluating", "superseded"]),
  evaluating: Object.freeze([
    "recommendCanary",
    "failed",
    "inconclusive",
    "contained",
    "superseded",
    "recoveryRequired",
  ]),
  recommendCanary: Object.freeze(["reviewApproved", "failed", "superseded"]),
  reviewApproved: Object.freeze([
    "rolloutRunning",
    "superseded",
    "recoveryRequired",
  ]),
  rolloutRunning: Object.freeze([
    "passed",
    "failed",
    "inconclusive",
    "contained",
    "recoveryRequired",
  ]),
  passed: Object.freeze([]),
  failed: Object.freeze([]),
  inconclusive: Object.freeze([]),
  contained: Object.freeze([]),
  superseded: Object.freeze([]),
  recoveryRequired: Object.freeze([
    "evaluating",
    "rolloutRunning",
    "contained",
  ]),
} satisfies Readonly<Record<
  OptimizerExperimentState,
  readonly OptimizerExperimentState[]
>>);

export const optimizerDeploymentStateSchema = z.enum([
  "inactive",
  "staged",
  "accepted",
  "rolledBack",
  "superseded",
]);
export type OptimizerDeploymentState = z.infer<
  typeof optimizerDeploymentStateSchema
>;

const DEPLOYMENT_TRANSITIONS = Object.freeze({
  inactive: Object.freeze(["staged"]),
  staged: Object.freeze(["accepted", "rolledBack", "superseded"]),
  accepted: Object.freeze(["rolledBack", "superseded"]),
  rolledBack: Object.freeze([]),
  superseded: Object.freeze([]),
} satisfies Readonly<Record<
  OptimizerDeploymentState,
  readonly OptimizerDeploymentState[]
>>);

export const optimizerExperimentTransitionSchema = z.object({
  from: optimizerExperimentStateSchema,
  to: optimizerExperimentStateSchema,
  fromRevision: z.number().int().positive().safe(),
  toRevision: z.number().int().positive().safe(),
}).strict().superRefine((transition, context) => {
  if (!isLegalOptimizerExperimentTransition(transition.from, transition.to)) {
    context.addIssue({
      code: "custom",
      message: "optimizer experiment transition is illegal",
      path: ["to"],
    });
  }
  if (transition.fromRevision === Number.MAX_SAFE_INTEGER ||
    transition.toRevision !== transition.fromRevision + 1) {
    context.addIssue({
      code: "custom",
      message: "optimizer experiment transition must advance one revision",
      path: ["toRevision"],
    });
  }
});

export const optimizerDeploymentTransitionSchema = z.object({
  from: optimizerDeploymentStateSchema,
  to: optimizerDeploymentStateSchema,
  fromRevision: z.number().int().positive().safe(),
  toRevision: z.number().int().positive().safe(),
}).strict().superRefine((transition, context) => {
  if (!isLegalOptimizerDeploymentTransition(transition.from, transition.to)) {
    context.addIssue({
      code: "custom",
      message: "optimizer deployment transition is illegal",
      path: ["to"],
    });
  }
  if (transition.fromRevision === Number.MAX_SAFE_INTEGER ||
    transition.toRevision !== transition.fromRevision + 1) {
    context.addIssue({
      code: "custom",
      message: "optimizer deployment transition must advance one revision",
      path: ["toRevision"],
    });
  }
});

export function isLegalOptimizerExperimentTransition(
  fromValue: unknown,
  toValue: unknown,
): boolean {
  const from = optimizerExperimentStateSchema.safeParse(fromValue);
  const to = optimizerExperimentStateSchema.safeParse(toValue);
  return from.success && to.success &&
    EXPERIMENT_TRANSITIONS[from.data].some((state) => state === to.data);
}

export function isLegalOptimizerDeploymentTransition(
  fromValue: unknown,
  toValue: unknown,
): boolean {
  const from = optimizerDeploymentStateSchema.safeParse(fromValue);
  const to = optimizerDeploymentStateSchema.safeParse(toValue);
  return from.success && to.success &&
    DEPLOYMENT_TRANSITIONS[from.data].some((state) => state === to.data);
}

function optimizerDomainDigest(domain: string, value: unknown): string {
  const domainBytes = Buffer.byteLength(domain, "utf8");
  return createHash("sha256")
    .update(`${OPTIMIZER_HASH_PREFIX}\0${domainBytes}:${domain}\0`, "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function optimizerByteDigest(domain: string, value: Uint8Array): string {
  const domainBytes = Buffer.byteLength(domain, "utf8");
  return createHash("sha256")
    .update(`${OPTIMIZER_HASH_PREFIX}\0${domainBytes}:${domain}\0`, "utf8")
    .update(value)
    .digest("hex");
}

function optimizerAssignmentHmac(
  key: Uint8Array,
  domain: string,
  value: unknown,
): string {
  const domainBytes = Buffer.byteLength(domain, "utf8");
  return createHmac("sha256", key)
    .update(`${OPTIMIZER_HASH_PREFIX}\0${domainBytes}:${domain}\0`, "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function optimizerIdentityHmac(
  key: Uint8Array,
  kind: "family" | "case",
  contract: OptimizerRegistryIdentityContract,
  identityMaterial: Uint8Array,
): string {
  const domain = `registry-${kind}-identity`;
  const domainBytes = Buffer.byteLength(domain, "utf8");
  return createHmac("sha256", key)
    .update(`${OPTIMIZER_HASH_PREFIX}\0${domainBytes}:${domain}\0`, "utf8")
    .update(canonicalJson(contract), "utf8")
    .update("\0", "utf8")
    .update(identityMaterial)
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" ||
    typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("optimizer digest values must be finite JSON numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new TypeError("optimizer digest values must be canonical JSON");
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("optimizer digest values must be plain JSON objects");
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}

function ceilRatio(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}
