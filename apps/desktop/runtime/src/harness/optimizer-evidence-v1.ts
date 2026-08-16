import { createHash } from "node:crypto";

import { z } from "@hra-internal/schema";

import {
  HRA_OPTIMIZER_ASSIGNMENT_BLOCK_SIZE,
  HRA_OPTIMIZER_MAX_FAMILIES,
  HRA_OPTIMIZER_MAX_REPLICATE_PAIRS,
  HRA_OPTIMIZER_SCHEMA_VERSION,
  assessOptimizerBenchmarkFeasibility,
  compileOptimizerAssignmentPlan,
  digestOptimizerBenchmarkRegistry,
  optimizerAssignmentKeyDigest,
  optimizerBenchmarkRegistrySchema,
  optimizerDigestSchema,
  optimizerPairAssignmentSchema,
  type OptimizerBenchmarkRegistry,
  type OptimizerFeasibilityReason,
  type OptimizerPairAssignment,
} from "./optimizer-domain-v1";

const OPTIMIZER_HASH_PREFIX = "hra.optimizer.v1";
const MAX_ASSIGNMENTS = HRA_OPTIMIZER_MAX_FAMILIES *
  HRA_OPTIMIZER_MAX_REPLICATE_PAIRS;
const MAX_OUTCOMES = MAX_ASSIGNMENTS * 2;

export const optimizerMissingQualityReasonSchema = z.enum([
  "capabilityUnavailable",
  "quotaExhaustion",
  "cancelled",
  "contained",
  "evaluatorAmbiguous",
  "reworkExhausted",
  "deadlineExceeded",
  "matchedPartitionUnavailable",
]);
export type OptimizerMissingQualityReason = z.infer<
  typeof optimizerMissingQualityReasonSchema
>;

export const optimizerQualityObservationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("observedPass") }).strict(),
  z.object({ kind: z.literal("observedFail") }).strict(),
  z.object({
    kind: z.literal("missing"),
    reason: optimizerMissingQualityReasonSchema,
  }).strict(),
]);
export type OptimizerQualityObservation = z.infer<
  typeof optimizerQualityObservationSchema
>;

export const optimizerArmDispositionSchema = z.union([
  z.literal("completed"),
  optimizerMissingQualityReasonSchema,
]);
export type OptimizerArmDisposition = z.infer<
  typeof optimizerArmDispositionSchema
>;

export const optimizerSafetyEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("exact"),
    evidenceDigest: optimizerDigestSchema,
  }).strict(),
  z.object({
    kind: z.literal("violation"),
    reason: z.enum([
      "authorityWidening",
      "workspaceViolation",
      "securityViolation",
      "nativeCollaborationEnabled",
      "capacityInvariantViolation",
    ]),
    evidenceDigest: optimizerDigestSchema,
  }).strict(),
]);

export const optimizerIntegrityEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("exact"),
    evidenceDigest: optimizerDigestSchema,
  }).strict(),
  z.object({
    kind: z.literal("conflict"),
    reason: z.enum([
      "assignmentConflict",
      "profileConflict",
      "effectLineageConflict",
      "evaluatorAmbiguity",
      "partitionCarryover",
      "isolationReuse",
    ]),
    evidenceDigest: optimizerDigestSchema,
  }).strict(),
]);

export const optimizerProfileEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("observed"),
    requestedProfile: z.enum(["lunaMax", "solMax"]),
    observedProfile: z.enum(["lunaMax", "solMax"]),
    fallbackReason: z.literal("lunaUnavailable").nullable(),
    capabilityEvidenceDigest: optimizerDigestSchema,
  }).strict(),
  z.object({
    kind: z.literal("selectedNotApplied"),
    requestedProfile: z.enum(["lunaMax", "solMax"]),
    selectedProfile: z.enum(["lunaMax", "solMax"]),
    fallbackReason: z.literal("lunaUnavailable").nullable(),
    reason: z.enum([
      "quotaExhaustion",
      "cancelled",
      "deadlineExceeded",
      "matchedPartitionUnavailable",
    ]),
    capabilityEvidenceDigest: optimizerDigestSchema,
  }).strict(),
  z.object({
    kind: z.literal("unavailable"),
    requestedProfile: z.enum(["lunaMax", "solMax"]),
    reason: z.literal("capabilityUnavailable"),
    capabilityEvidenceDigest: optimizerDigestSchema,
  }).strict(),
]);

export const optimizerEffectLineageSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("settled"),
    prepareReceiptDigest: optimizerDigestSchema,
    effectStartReceiptDigest: optimizerDigestSchema,
    terminalReceiptDigest: optimizerDigestSchema,
    processGeneration: z.number().int().positive().safe(),
    elapsedStartBoundary: z.literal(
      "afterPairLeasesSnapshotsAndArmEffectAdmission",
    ),
  }).strict(),
  z.object({
    kind: z.literal("notStarted"),
    reason: z.enum([
      "capabilityUnavailable",
      "quotaExhaustion",
      "cancelled",
      "deadlineExceeded",
      "matchedPartitionUnavailable",
    ]),
    admissionReceiptDigest: optimizerDigestSchema,
    definitiveNonApplicationEvidenceDigest: optimizerDigestSchema,
  }).strict(),
]);

export const optimizerEvaluationEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("settled"),
    validatorVerdict: z.enum(["pass", "fail"]),
    reviewerVerdict: z.enum(["pass", "fail"]),
    evaluatorReceiptDigest: optimizerDigestSchema,
    producerActorDigest: optimizerDigestSchema,
    reviewerDigest: optimizerDigestSchema,
    reviewerIndependent: z.literal(true),
    reviewerBlindedToArm: z.literal(true),
    reviewerBlindedToProfile: z.literal(true),
    reviewerBlindedToUsage: z.literal(true),
    reviewerBlindedToOtherArm: z.literal(true),
    validatorInputsBlindedToArm: z.literal(true),
    validatorInputsBlindedToProfile: z.literal(true),
    validatorInputsBlindedToUsage: z.literal(true),
    validatorInputsBlindedToOtherArm: z.literal(true),
    evaluatorInputsBlindedToArm: z.literal(true),
    evaluatorInputsBlindedToProfile: z.literal(true),
    evaluatorInputsBlindedToUsage: z.literal(true),
    evaluatorInputsBlindedToOtherArm: z.literal(true),
    actorSelfReportEligible: z.literal(false),
  }).strict().superRefine((evidence, context) => {
    if (evidence.producerActorDigest === evidence.reviewerDigest) {
      context.addIssue({
        code: "custom",
        message: "optimizer reviewer must be independent from the producer",
        path: ["reviewerDigest"],
      });
    }
  }),
  z.object({
    kind: z.literal("unavailable"),
    reason: optimizerMissingQualityReasonSchema,
    evidenceDigest: optimizerDigestSchema,
    actorSelfReportEligible: z.literal(false),
  }).strict(),
]);

export const optimizerPartitionEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("exact"),
    partitionDigest: optimizerDigestSchema,
    leaseReceiptDigest: optimizerDigestSchema,
    budgetHeadroomClassDigest: optimizerDigestSchema,
    preEffectCapabilitySnapshotDigest: optimizerDigestSchema,
    preEffectQuotaSnapshotDigest: optimizerDigestSchema,
    postEffectCapabilitySnapshotDigest: optimizerDigestSchema,
    postEffectQuotaSnapshotDigest: optimizerDigestSchema,
    unrelatedAdmittedLoad: z.literal(0),
    leaseMode: z.literal("exclusive"),
  }).strict(),
  z.object({
    kind: z.literal("unavailable"),
    reason: z.literal("matchedPartitionUnavailable"),
    evidenceDigest: optimizerDigestSchema,
  }).strict(),
]);

export const optimizerIsolationEvidenceSchema = z.object({
  epochDigest: optimizerDigestSchema,
  contextDigest: optimizerDigestSchema,
  workspaceDigest: optimizerDigestSchema,
  exposedBeforeAssignment: z.literal(false),
}).strict();

export const optimizerProviderTokensSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("exact"),
    inputTokens: z.number().int().nonnegative().safe(),
    cachedInputTokens: z.number().int().nonnegative().safe(),
    outputTokens: z.number().int().nonnegative().safe(),
    reasoningOutputTokens: z.number().int().nonnegative().safe(),
    totalTokens: z.number().int().nonnegative().safe(),
  }).strict().superRefine((tokens, context) => {
    if (tokens.cachedInputTokens > tokens.inputTokens) {
      context.addIssue({
        code: "custom",
        message: "cached input tokens must be a subset of input tokens",
        path: ["cachedInputTokens"],
      });
    }
    if (tokens.reasoningOutputTokens > tokens.outputTokens) {
      context.addIssue({
        code: "custom",
        message: "reasoning output tokens must be a subset of output tokens",
        path: ["reasoningOutputTokens"],
      });
    }
    if (BigInt(tokens.inputTokens) + BigInt(tokens.outputTokens) !==
      BigInt(tokens.totalTokens)) {
      context.addIssue({
        code: "custom",
        message: "total provider tokens count input and output exactly once",
        path: ["totalTokens"],
      });
    }
  }),
  z.object({
    kind: z.literal("unavailable"),
    reason: z.enum([
      "effectNotStarted",
      "providerUsageMissing",
      "providerUsageConflict",
    ]),
    evidenceDigest: optimizerDigestSchema,
  }).strict(),
]);

export const optimizerElapsedSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("exact"),
    milliseconds: z.number().int().nonnegative().safe(),
    partitionAcquisitionWaitMilliseconds: z.number().int()
      .nonnegative().safe(),
    clock: z.literal("monotonicSingleGeneration"),
    startBoundary: z.literal(
      "afterPairLeasesSnapshotsAndArmEffectAdmission",
    ),
  }).strict(),
  z.object({
    kind: z.literal("unavailable"),
    reason: z.enum(["restartSpanning", "clockConflict", "effectNotStarted"]),
    evidenceDigest: optimizerDigestSchema,
  }).strict(),
]);

export const optimizerArmOutcomeSchema = z.object({
  schemaVersion: z.literal(HRA_OPTIMIZER_SCHEMA_VERSION),
  assignmentDigest: optimizerDigestSchema,
  familyDigest: optimizerDigestSchema,
  caseDigest: optimizerDigestSchema,
  replicateOrdinal: z.number().int().nonnegative().safe(),
  arm: z.enum(["candidate", "control"]),
  requestedPolicy: z.enum(["lunaThenSol", "solOnly"]),
  disposition: optimizerArmDispositionSchema,
  quality: optimizerQualityObservationSchema,
  safety: optimizerSafetyEvidenceSchema,
  evidenceIntegrity: optimizerIntegrityEvidenceSchema,
  profile: optimizerProfileEvidenceSchema,
  effectLineage: optimizerEffectLineageSchema,
  evaluation: optimizerEvaluationEvidenceSchema,
  partition: optimizerPartitionEvidenceSchema,
  isolation: optimizerIsolationEvidenceSchema,
  providerTokens: optimizerProviderTokensSchema,
  elapsed: optimizerElapsedSchema,
}).strict().superRefine((outcome, context) => {
  const candidate = outcome.arm === "candidate";
  const expectedPolicy = candidate ? "solOnly" : "lunaThenSol";
  const expectedRequestedProfile = candidate ? "solMax" : "lunaMax";
  if (outcome.requestedPolicy !== expectedPolicy) {
    context.addIssue({
      code: "custom",
      message: "optimizer arm requested the wrong immutable policy",
      path: ["requestedPolicy"],
    });
  }
  if (outcome.profile.requestedProfile !== expectedRequestedProfile) {
    context.addIssue({
      code: "custom",
      message: "optimizer arm requested the wrong profile",
      path: ["profile", "requestedProfile"],
    });
  }
  if (outcome.profile.kind === "observed") {
    const validCandidate = candidate &&
      outcome.profile.observedProfile === "solMax" &&
      outcome.profile.fallbackReason === null;
    const validControl = !candidate && (
      (outcome.profile.observedProfile === "lunaMax" &&
        outcome.profile.fallbackReason === null) ||
      (outcome.profile.observedProfile === "solMax" &&
        outcome.profile.fallbackReason === "lunaUnavailable")
    );
    if (!validCandidate && !validControl) {
      context.addIssue({
        code: "custom",
        message: "optimizer observed profile violates the arm policy",
        path: ["profile", "observedProfile"],
      });
    }
  }
  if (outcome.profile.kind === "selectedNotApplied") {
    const validCandidate = candidate &&
      outcome.profile.selectedProfile === "solMax" &&
      outcome.profile.fallbackReason === null;
    const validControl = !candidate && (
      (outcome.profile.selectedProfile === "lunaMax" &&
        outcome.profile.fallbackReason === null) ||
      (outcome.profile.selectedProfile === "solMax" &&
        outcome.profile.fallbackReason === "lunaUnavailable")
    );
    if (!validCandidate && !validControl) {
      context.addIssue({
        code: "custom",
        message: "optimizer selected profile violates the arm policy",
        path: ["profile", "selectedProfile"],
      });
    }
  }

  if (outcome.quality.kind === "missing") {
    if (outcome.disposition !== outcome.quality.reason) {
      context.addIssue({
        code: "custom",
        message: "optimizer missing quality must retain its ITT disposition",
        path: ["disposition"],
      });
    }
    if (outcome.evaluation.kind !== "unavailable" ||
      outcome.evaluation.reason !== outcome.quality.reason) {
      context.addIssue({
        code: "custom",
        message: "optimizer missing quality requires matching evaluator evidence",
        path: ["evaluation"],
      });
    }
  } else {
    if (outcome.disposition !== "completed") {
      context.addIssue({
        code: "custom",
        message: "optimizer observed quality requires completed disposition",
        path: ["disposition"],
      });
    }
    if (outcome.evaluation.kind !== "settled") {
      context.addIssue({
        code: "custom",
        message: "optimizer observed quality requires settled evaluation",
        path: ["evaluation"],
      });
    } else {
      const shouldPass = outcome.evaluation.validatorVerdict === "pass" &&
        outcome.evaluation.reviewerVerdict === "pass";
      if ((outcome.quality.kind === "observedPass") !== shouldPass) {
        context.addIssue({
          code: "custom",
          message: "optimizer quality must equal validators plus reviewer",
          path: ["quality"],
        });
      }
    }
  }

  const capabilityUnavailable =
    outcome.disposition === "capabilityUnavailable";
  if (capabilityUnavailable !== (outcome.profile.kind === "unavailable")) {
    context.addIssue({
      code: "custom",
      message: "optimizer capability disposition and profile evidence disagree",
      path: ["profile"],
    });
  }
  const matchedPartitionUnavailable =
    outcome.disposition === "matchedPartitionUnavailable";
  if (matchedPartitionUnavailable !==
    (outcome.partition.kind === "unavailable")) {
    context.addIssue({
      code: "custom",
      message: "optimizer partition disposition and evidence disagree",
      path: ["partition"],
    });
  }
  if (outcome.effectLineage.kind === "notStarted") {
    if (outcome.quality.kind !== "missing" ||
      outcome.disposition !== outcome.effectLineage.reason) {
      context.addIssue({
        code: "custom",
        message: "optimizer non-applied lineage must match its ITT disposition",
        path: ["effectLineage"],
      });
    }
    if (outcome.effectLineage.reason === "capabilityUnavailable") {
      if (outcome.profile.kind !== "unavailable") {
        context.addIssue({
          code: "custom",
          message: "optimizer unavailable capability needs unavailable profile",
          path: ["profile"],
        });
      }
    } else if (outcome.profile.kind !== "selectedNotApplied" ||
      outcome.profile.reason !== outcome.effectLineage.reason) {
      context.addIssue({
        code: "custom",
        message: "optimizer non-applied effect needs exact selected profile proof",
        path: ["profile"],
      });
    }
    if (outcome.providerTokens.kind !== "unavailable" ||
      outcome.providerTokens.reason !== "effectNotStarted") {
      context.addIssue({
        code: "custom",
        message: "optimizer non-applied effect cannot claim provider tokens",
        path: ["providerTokens"],
      });
    }
    if (outcome.elapsed.kind !== "unavailable" ||
      outcome.elapsed.reason !== "effectNotStarted") {
      context.addIssue({
        code: "custom",
        message: "optimizer non-applied effect cannot claim elapsed duration",
        path: ["elapsed"],
      });
    }
  } else {
    if (outcome.profile.kind !== "observed") {
      context.addIssue({
        code: "custom",
        message: "optimizer settled effect needs an observed profile",
        path: ["profile"],
      });
    }
    if (outcome.providerTokens.kind === "unavailable" &&
      outcome.providerTokens.reason === "effectNotStarted") {
      context.addIssue({
        code: "custom",
        message: "settled optimizer effect cannot use not-started token evidence",
        path: ["providerTokens"],
      });
    }
    if (outcome.elapsed.kind === "unavailable" &&
      outcome.elapsed.reason === "effectNotStarted") {
      context.addIssue({
        code: "custom",
        message: "settled optimizer effect cannot use not-started elapsed evidence",
        path: ["elapsed"],
      });
    }
  }
  if (outcome.disposition === "evaluatorAmbiguous" &&
    (outcome.evidenceIntegrity.kind !== "conflict" ||
      outcome.evidenceIntegrity.reason !== "evaluatorAmbiguity")) {
    context.addIssue({
      code: "custom",
      message: "ambiguous evaluator evidence must contain the experiment",
      path: ["evidenceIntegrity"],
    });
  }
  if (outcome.evidenceIntegrity.kind === "conflict" &&
    outcome.evidenceIntegrity.reason === "evaluatorAmbiguity" &&
    outcome.disposition !== "evaluatorAmbiguous") {
    context.addIssue({
      code: "custom",
      message: "evaluator ambiguity conflict requires its closed disposition",
      path: ["disposition"],
    });
  }
});
export type OptimizerArmOutcome = z.infer<
  typeof optimizerArmOutcomeSchema
>;

export const optimizerGateReasonSchema = z.enum([
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
  "invalidGateInput",
  "registryDigestConflict",
  "assignmentKeyUnavailable",
  "assignmentKeyMismatch",
  "assignmentIntegrityConflict",
  "assignmentMissing",
  "assignmentUnexpected",
  "assignmentDuplicate",
  "unequalReplicates",
  "executionOrderNotBalanced",
  "partitionMappingNotBalanced",
  "partitionCarryoverConflict",
  "outcomeIntegrityConflict",
  "outcomeMissing",
  "outcomeUnexpected",
  "outcomeDuplicate",
  "armContained",
  "safetyViolation",
  "evidenceIntegrityConflict",
  "profileEvidenceConflict",
  "effectLineageConflict",
  "freshIsolationConflict",
  "resourceCapViolation",
  "providerTokenEvidenceMissing",
  "elapsedEvidenceMissing",
  "zeroControlProviderTokens",
  "zeroControlElapsed",
  "qualityThresholdNotMet",
  "compositionSensitivityNotMet",
  "providerTokenHarmExceeded",
  "elapsedHarmExceeded",
]);
export type OptimizerGateReason = z.infer<typeof optimizerGateReasonSchema>;

const signedIntegerStringSchema = z.string().regex(/^-?[0-9]+$/u);
const positiveIntegerStringSchema = z.string().regex(/^[1-9][0-9]*$/u);
const nonnegativeIntegerStringSchema = z.string()
  .regex(/^(?:0|[1-9][0-9]*)$/u);

export const optimizerExactThresholdMeasureSchema = z.object({
  numerator: signedIntegerStringSchema,
  denominator: positiveIntegerStringSchema,
  thresholdBasisPoints: z.number().int().safe(),
  observedBasisPointsFloor: z.number().int().safe(),
  passes: z.boolean(),
}).strict();

export const optimizerExactHarmRatioSchema = z.object({
  candidateNumerator: nonnegativeIntegerStringSchema,
  controlDenominator: positiveIntegerStringSchema,
  maximumBasisPoints: z.number().int().positive().safe(),
  observedBasisPointsFloor: nonnegativeIntegerStringSchema,
  passes: z.boolean(),
}).strict();

export const optimizerFiniteBenchmarkMetricsSchema = z.object({
  familyCount: z.number().int().positive().safe(),
  replicatePairsPerFamily: z.number().int().positive().safe(),
  candidateMissingQualityCount: z.number().int().nonnegative().safe(),
  controlMissingQualityCount: z.number().int().nonnegative().safe(),
  qualityDelta: optimizerExactThresholdMeasureSchema,
  compositionSensitivity: optimizerExactThresholdMeasureSchema.extend({
    removedFamilyCount: z.number().int().positive().safe(),
  }).strict(),
  providerTokenHarm: optimizerExactHarmRatioSchema,
  elapsedHarm: optimizerExactHarmRatioSchema,
}).strict();
export type OptimizerFiniteBenchmarkMetrics = z.infer<
  typeof optimizerFiniteBenchmarkMetricsSchema
>;

const optimizerGateResultReasonsSchema = z.array(optimizerGateReasonSchema)
  .max(64)
  .refine(
    (reasons) => new Set(reasons).size === reasons.length,
    "optimizer gate reasons must be unique",
  );
const optimizerGateResultBaseShape = {
  schemaVersion: z.literal(HRA_OPTIMIZER_SCHEMA_VERSION),
  researchOnly: z.literal(true),
  policyAuthorization: z.literal("none"),
  rolloutAuthorization: z.literal("none"),
  registryDigest: optimizerDigestSchema.nullable(),
  cellSetDigest: optimizerDigestSchema.nullable(),
  requiredPairAssignments: z.number().int().nonnegative().safe().nullable(),
  requiredArmOutcomes: z.number().int().nonnegative().safe().nullable(),
  reasons: optimizerGateResultReasonsSchema,
  gateReceiptDigest: optimizerDigestSchema,
} as const;

export const optimizerFiniteBenchmarkGateResultSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      ...optimizerGateResultBaseShape,
      kind: z.literal("infeasible"),
      metrics: z.null(),
    }).strict(),
    z.object({
      ...optimizerGateResultBaseShape,
      kind: z.literal("recoveryRequired"),
      metrics: z.null(),
    }).strict(),
    z.object({
      ...optimizerGateResultBaseShape,
      kind: z.literal("inconclusive"),
      metrics: z.null(),
    }).strict(),
    z.object({
      ...optimizerGateResultBaseShape,
      kind: z.literal("contained"),
      metrics: z.null(),
    }).strict(),
    z.object({
      ...optimizerGateResultBaseShape,
      kind: z.literal("failed"),
      metrics: optimizerFiniteBenchmarkMetricsSchema,
    }).strict(),
    z.object({
      ...optimizerGateResultBaseShape,
      kind: z.literal("recommendCanary"),
      metrics: optimizerFiniteBenchmarkMetricsSchema,
    }).strict(),
  ],
).superRefine((result, context) => {
  if (result.kind === "recommendCanary" && result.reasons.length !== 0) {
    context.addIssue({
      code: "custom",
      message: "optimizer recommendation cannot retain failed gates",
      path: ["reasons"],
    });
  }
  const { gateReceiptDigest, ...payload } = result;
  if (gateReceiptDigest !== optimizerEvidenceDigest("gate-result", payload)) {
    context.addIssue({
      code: "custom",
      message: "optimizer gate receipt digest is invalid",
      path: ["gateReceiptDigest"],
    });
  }
});
export type OptimizerFiniteBenchmarkGateResult = z.infer<
  typeof optimizerFiniteBenchmarkGateResultSchema
>;

const optimizerFiniteBenchmarkGateEnvelopeSchema = z.object({
  schemaVersion: z.literal(HRA_OPTIMIZER_SCHEMA_VERSION),
  registry: z.unknown(),
  registryDigest: optimizerDigestSchema,
  assignmentKeyVersion: z.number().int().positive().safe(),
  assignmentKey: z.unknown(),
  assignments: z.array(z.unknown()).max(MAX_ASSIGNMENTS),
  outcomes: z.array(z.unknown()).max(MAX_OUTCOMES),
}).strict();

export function evaluateOptimizerFiniteBenchmark(
  value: unknown,
): OptimizerFiniteBenchmarkGateResult {
  const envelope = optimizerFiniteBenchmarkGateEnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    return sealGateResult({
      kind: "inconclusive",
      registryDigest: null,
      cellSetDigest: null,
      requiredPairAssignments: null,
      requiredArmOutcomes: null,
      reasons: ["invalidGateInput"],
      metrics: null,
    });
  }

  const feasibility = assessOptimizerBenchmarkFeasibility(
    envelope.data.registry,
  );
  if (feasibility.kind === "infeasible") {
    return sealGateResult({
      kind: "infeasible",
      registryDigest: feasibility.registryDigest,
      cellSetDigest: null,
      requiredPairAssignments: feasibility.requiredPairAssignments,
      requiredArmOutcomes: feasibility.requiredArmOutcomes,
      reasons: feasibility.reasons,
      metrics: null,
    });
  }
  const registry = optimizerBenchmarkRegistrySchema.parse(
    envelope.data.registry,
  );
  const registryDigest = digestOptimizerBenchmarkRegistry(registry);
  if (registryDigest !== envelope.data.registryDigest) {
    return sealGateResult({
      kind: "contained",
      registryDigest,
      cellSetDigest: null,
      requiredPairAssignments: feasibility.requiredPairAssignments,
      requiredArmOutcomes: feasibility.requiredArmOutcomes,
      reasons: ["registryDigestConflict"],
      metrics: null,
    });
  }

  const assignmentKeyDigest = optimizerAssignmentKeyDigest(
    envelope.data.assignmentKey,
  );
  if (assignmentKeyDigest === null) {
    return sealGateResult({
      kind: "recoveryRequired",
      registryDigest,
      cellSetDigest: null,
      requiredPairAssignments: feasibility.requiredPairAssignments,
      requiredArmOutcomes: feasibility.requiredArmOutcomes,
      reasons: ["assignmentKeyUnavailable"],
      metrics: null,
    });
  }

  const assignmentValidation = validateAssignments(
    registry,
    registryDigest,
    envelope.data.assignments,
    envelope.data.assignmentKeyVersion,
    assignmentKeyDigest,
    envelope.data.assignmentKey as Uint8Array,
  );
  if (assignmentValidation.kind !== "valid") {
    return sealGateResult({
      kind: assignmentValidation.kind,
      registryDigest,
      cellSetDigest: null,
      requiredPairAssignments: feasibility.requiredPairAssignments,
      requiredArmOutcomes: feasibility.requiredArmOutcomes,
      reasons: assignmentValidation.reasons,
      metrics: null,
    });
  }

  const outcomeValidation = validateOutcomes(
    registry,
    assignmentValidation.assignments,
    envelope.data.outcomes,
  );
  const cellSetDigest = outcomeValidation.cellSetDigest;
  if (outcomeValidation.kind !== "valid") {
    return sealGateResult({
      kind: outcomeValidation.kind,
      registryDigest,
      cellSetDigest,
      requiredPairAssignments: feasibility.requiredPairAssignments,
      requiredArmOutcomes: feasibility.requiredArmOutcomes,
      reasons: outcomeValidation.reasons,
      metrics: null,
    });
  }

  const metricsResult = calculateMetrics(
    registry,
    assignmentValidation.assignments,
    outcomeValidation.outcomes,
  );
  if (metricsResult.kind === "inconclusive") {
    return sealGateResult({
      kind: "inconclusive",
      registryDigest,
      cellSetDigest,
      requiredPairAssignments: feasibility.requiredPairAssignments,
      requiredArmOutcomes: feasibility.requiredArmOutcomes,
      reasons: metricsResult.reasons,
      metrics: null,
    });
  }

  const failedReasons: OptimizerGateReason[] = [];
  if (!metricsResult.metrics.qualityDelta.passes) {
    failedReasons.push("qualityThresholdNotMet");
  }
  if (!metricsResult.metrics.compositionSensitivity.passes) {
    failedReasons.push("compositionSensitivityNotMet");
  }
  if (!metricsResult.metrics.providerTokenHarm.passes) {
    failedReasons.push("providerTokenHarmExceeded");
  }
  if (!metricsResult.metrics.elapsedHarm.passes) {
    failedReasons.push("elapsedHarmExceeded");
  }
  return sealGateResult({
    kind: failedReasons.length === 0 ? "recommendCanary" : "failed",
    registryDigest,
    cellSetDigest,
    requiredPairAssignments: feasibility.requiredPairAssignments,
    requiredArmOutcomes: feasibility.requiredArmOutcomes,
    reasons: failedReasons,
    metrics: metricsResult.metrics,
  });
}

type ValidAssignments = Readonly<{
  kind: "valid";
  assignments: readonly OptimizerPairAssignment[];
}>;
type InvalidAssignments = Readonly<{
  kind: "contained" | "inconclusive" | "recoveryRequired";
  reasons: readonly OptimizerGateReason[];
}>;

function validateAssignments(
  registry: OptimizerBenchmarkRegistry,
  registryDigest: string,
  values: readonly unknown[],
  assignmentKeyVersion: number,
  assignmentKeyDigest: string,
  assignmentKey: Uint8Array,
): ValidAssignments | InvalidAssignments {
  const parsed: OptimizerPairAssignment[] = [];
  for (const value of values) {
    const result = optimizerPairAssignmentSchema.safeParse(value);
    if (!result.success) {
      return Object.freeze({
        kind: "contained",
        reasons: Object.freeze([
          "assignmentIntegrityConflict" as const,
        ]),
      });
    }
    parsed.push(result.data);
  }
  parsed.sort(compareAssignments);

  const integrityReasons = new Set<OptimizerGateReason>();
  const incompleteReasons = new Set<OptimizerGateReason>();
  const caseByFamily = new Map(registry.cases.map((benchmarkCase) =>
    [benchmarkCase.familyDigest, benchmarkCase] as const
  ));
  const expectedByCell = new Map<string, OptimizerPairAssignment>();
  for (const benchmarkCase of registry.cases) {
    const plan = compileOptimizerAssignmentPlan({
      registryDigest,
      benchmarkCase,
      matchedPartitionDesign: registry.matchedPartitionDesign,
      replicatePairsPerFamily: registry.gate.replicatePairsPerFamily,
      keyVersion: assignmentKeyVersion,
      expectedKeyDigest: assignmentKeyDigest,
    }, assignmentKey);
    if (plan.kind !== "assigned") {
      return Object.freeze({
        kind: "recoveryRequired",
        reasons: Object.freeze(["assignmentKeyMismatch" as const]),
      });
    }
    for (const assignment of plan.assignments) {
      expectedByCell.set(assignmentCellKey(
        assignment.familyDigest,
        assignment.replicateOrdinal,
      ), assignment);
    }
  }
  const byCell = new Map<string, OptimizerPairAssignment>();
  for (const assignment of parsed) {
    if (assignment.keyVersion !== assignmentKeyVersion ||
      assignment.keyDigest !== assignmentKeyDigest) {
      return Object.freeze({
        kind: "recoveryRequired",
        reasons: Object.freeze(["assignmentKeyMismatch" as const]),
      });
    }
    if (assignment.registryDigest !== registryDigest) {
      integrityReasons.add("assignmentIntegrityConflict");
    }
    const benchmarkCase = caseByFamily.get(assignment.familyDigest);
    if (benchmarkCase === undefined ||
      benchmarkCase.caseDigest !== assignment.caseDigest ||
      assignment.replicateOrdinal >=
        registry.gate.replicatePairsPerFamily) {
      integrityReasons.add("assignmentUnexpected");
    }
    const key = assignmentCellKey(
      assignment.familyDigest,
      assignment.replicateOrdinal,
    );
    if (byCell.has(key)) integrityReasons.add("assignmentDuplicate");
    else byCell.set(key, assignment);
    const expected = expectedByCell.get(key);
    if (expected !== undefined &&
      expected.assignmentDigest !== assignment.assignmentDigest) {
      integrityReasons.add("assignmentIntegrityConflict");
    }
  }

  const [firstPartition, secondPartition] =
    registry.matchedPartitionDesign.partitions;
  const allowedPartitions = new Set([
    firstPartition.partitionDigest,
    secondPartition.partitionDigest,
  ]);
  for (const benchmarkCase of registry.cases) {
    let observedReplicates = 0;
    for (let replicateOrdinal = 0;
      replicateOrdinal < registry.gate.replicatePairsPerFamily;
      replicateOrdinal += 1) {
      if (byCell.has(assignmentCellKey(
        benchmarkCase.familyDigest,
        replicateOrdinal,
      ))) observedReplicates += 1;
      else incompleteReasons.add("assignmentMissing");
    }
    if (observedReplicates !== registry.gate.replicatePairsPerFamily) {
      incompleteReasons.add("unequalReplicates");
    }

    const blockCount = registry.gate.replicatePairsPerFamily /
      HRA_OPTIMIZER_ASSIGNMENT_BLOCK_SIZE;
    for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
      const combinations = new Set<string>();
      const permutationWitnesses = new Set<string>();
      for (let offset = 0;
        offset < HRA_OPTIMIZER_ASSIGNMENT_BLOCK_SIZE;
        offset += 1) {
        const assignment = byCell.get(assignmentCellKey(
          benchmarkCase.familyDigest,
          blockIndex * HRA_OPTIMIZER_ASSIGNMENT_BLOCK_SIZE + offset,
        ));
        if (assignment === undefined) continue;
        permutationWitnesses.add(assignment.permutationWitnessDigest);
        if (!allowedPartitions.has(assignment.candidatePartitionDigest) ||
          !allowedPartitions.has(assignment.controlPartitionDigest)) {
          integrityReasons.add("partitionCarryoverConflict");
          continue;
        }
        const candidatePartitionIndex =
          assignment.candidatePartitionDigest === firstPartition.partitionDigest
            ? 0
            : 1;
        combinations.add(
          `${assignment.executionOrder}:${candidatePartitionIndex}`,
        );
      }
      const candidateFirstCount = [...combinations].filter((value) =>
        value.startsWith("candidateFirst:")
      ).length;
      const controlFirstCount = [...combinations].filter((value) =>
        value.startsWith("controlFirst:")
      ).length;
      const firstMappingCount = [...combinations].filter((value) =>
        value.endsWith(":0")
      ).length;
      const secondMappingCount = [...combinations].filter((value) =>
        value.endsWith(":1")
      ).length;
      if (candidateFirstCount !== 2 || controlFirstCount !== 2) {
        incompleteReasons.add("executionOrderNotBalanced");
      }
      if (firstMappingCount !== 2 || secondMappingCount !== 2) {
        incompleteReasons.add("partitionMappingNotBalanced");
      }
      if (permutationWitnesses.size > 1) {
        integrityReasons.add("assignmentIntegrityConflict");
      }
    }
  }

  if (integrityReasons.size > 0) {
    return Object.freeze({
      kind: "contained",
      reasons: freezeReasons(integrityReasons),
    });
  }
  if (incompleteReasons.size > 0) {
    return Object.freeze({
      kind: "inconclusive",
      reasons: freezeReasons(incompleteReasons),
    });
  }
  return Object.freeze({
    kind: "valid",
    assignments: Object.freeze(parsed),
  });
}

type ValidOutcomes = Readonly<{
  kind: "valid";
  outcomes: readonly OptimizerArmOutcome[];
  cellSetDigest: string;
}>;
type InvalidOutcomes = Readonly<{
  kind: "contained" | "inconclusive";
  reasons: readonly OptimizerGateReason[];
  cellSetDigest: string | null;
}>;

function validateOutcomes(
  registry: OptimizerBenchmarkRegistry,
  assignments: readonly OptimizerPairAssignment[],
  values: readonly unknown[],
): ValidOutcomes | InvalidOutcomes {
  const parsed: OptimizerArmOutcome[] = [];
  for (const value of values) {
    const result = optimizerArmOutcomeSchema.safeParse(value);
    if (!result.success) {
      return Object.freeze({
        kind: "contained",
        reasons: Object.freeze([
          "outcomeIntegrityConflict" as const,
        ]),
        cellSetDigest: null,
      });
    }
    parsed.push(result.data);
  }
  parsed.sort(compareOutcomes);
  const cellSetDigest = optimizerEvidenceDigest("cell-set", {
    assignments: assignments.map(({ assignmentDigest }) => assignmentDigest),
    outcomes: parsed.map((outcome) => optimizerEvidenceDigest(
      "arm-outcome",
      outcome,
    )),
  });

  const integrityReasons = new Set<OptimizerGateReason>();
  const incompleteReasons = new Set<OptimizerGateReason>();
  const assignmentByDigest = new Map(assignments.map((assignment) =>
    [assignment.assignmentDigest, assignment] as const
  ));
  const caseByFamily = new Map(registry.cases.map((benchmarkCase) =>
    [benchmarkCase.familyDigest, benchmarkCase] as const
  ));
  const outcomesByCell = new Map<string, OptimizerArmOutcome>();
  const isolationDigests = new Set<string>();
  const [firstPartition, secondPartition] =
    registry.matchedPartitionDesign.partitions;
  const partitionByDigest = new Map([
    [firstPartition.partitionDigest, firstPartition] as const,
    [secondPartition.partitionDigest, secondPartition] as const,
  ]);

  for (const outcome of parsed) {
    const assignment = assignmentByDigest.get(outcome.assignmentDigest);
    if (assignment === undefined) {
      integrityReasons.add("outcomeUnexpected");
      continue;
    }
    const key = outcomeCellKey(outcome.assignmentDigest, outcome.arm);
    if (outcomesByCell.has(key)) integrityReasons.add("outcomeDuplicate");
    else outcomesByCell.set(key, outcome);
    if (outcome.familyDigest !== assignment.familyDigest ||
      outcome.caseDigest !== assignment.caseDigest ||
      outcome.replicateOrdinal !== assignment.replicateOrdinal) {
      integrityReasons.add("outcomeIntegrityConflict");
    }
    const benchmarkCase = caseByFamily.get(outcome.familyDigest);
    if (benchmarkCase === undefined ||
      (outcome.providerTokens.kind === "exact" &&
        outcome.providerTokens.totalTokens >
          benchmarkCase.evaluator.providerTokenCap) ||
      (outcome.elapsed.kind === "exact" &&
        outcome.elapsed.milliseconds >
          benchmarkCase.evaluator.elapsedMillisecondsCap)) {
      integrityReasons.add("resourceCapViolation");
    }
    const expectedPartition = outcome.arm === "candidate"
      ? assignment.candidatePartitionDigest
      : assignment.controlPartitionDigest;
    const designPartition = partitionByDigest.get(expectedPartition);
    if (outcome.partition.kind === "exact" &&
      (outcome.partition.partitionDigest !== expectedPartition ||
        designPartition === undefined ||
        outcome.partition.budgetHeadroomClassDigest !==
          designPartition.budgetHeadroomClassDigest)) {
      integrityReasons.add("partitionCarryoverConflict");
    }
    for (const isolationDigest of [
      outcome.isolation.epochDigest,
      outcome.isolation.contextDigest,
      outcome.isolation.workspaceDigest,
    ]) {
      if (isolationDigests.has(isolationDigest)) {
        integrityReasons.add("freshIsolationConflict");
      }
      isolationDigests.add(isolationDigest);
    }
    if (outcome.safety.kind === "violation") {
      integrityReasons.add("safetyViolation");
    }
    if (outcome.disposition === "contained") {
      integrityReasons.add("armContained");
    }
    if (outcome.evidenceIntegrity.kind === "conflict") {
      integrityReasons.add("evidenceIntegrityConflict");
      switch (outcome.evidenceIntegrity.reason) {
        case "profileConflict":
          integrityReasons.add("profileEvidenceConflict");
          break;
        case "effectLineageConflict":
          integrityReasons.add("effectLineageConflict");
          break;
        case "partitionCarryover":
          integrityReasons.add("partitionCarryoverConflict");
          break;
        case "isolationReuse":
          integrityReasons.add("freshIsolationConflict");
          break;
        case "assignmentConflict":
        case "evaluatorAmbiguity":
          break;
      }
    }
  }

  for (const assignment of assignments) {
    for (const arm of ["candidate", "control"] as const) {
      if (!outcomesByCell.has(outcomeCellKey(assignment.assignmentDigest, arm))) {
        incompleteReasons.add("outcomeMissing");
      }
    }
    const candidate = outcomesByCell.get(outcomeCellKey(
      assignment.assignmentDigest,
      "candidate",
    ));
    const control = outcomesByCell.get(outcomeCellKey(
      assignment.assignmentDigest,
      "control",
    ));
    if (candidate !== undefined && control !== undefined &&
      (candidate.partition.kind === "unavailable") !==
        (control.partition.kind === "unavailable")) {
      integrityReasons.add("partitionCarryoverConflict");
    }
  }
  if (integrityReasons.size > 0) {
    return Object.freeze({
      kind: "contained",
      reasons: freezeReasons(integrityReasons),
      cellSetDigest,
    });
  }
  if (incompleteReasons.size > 0) {
    return Object.freeze({
      kind: "inconclusive",
      reasons: freezeReasons(incompleteReasons),
      cellSetDigest,
    });
  }
  return Object.freeze({
    kind: "valid",
    outcomes: Object.freeze(parsed),
    cellSetDigest,
  });
}

type MetricsResult =
  | Readonly<{
      kind: "complete";
      metrics: OptimizerFiniteBenchmarkMetrics;
    }>
  | Readonly<{
      kind: "inconclusive";
      reasons: readonly OptimizerGateReason[];
    }>;

function calculateMetrics(
  registry: OptimizerBenchmarkRegistry,
  assignments: readonly OptimizerPairAssignment[],
  outcomes: readonly OptimizerArmOutcome[],
): MetricsResult {
  const outcomeByCell = new Map(outcomes.map((outcome) =>
    [outcomeCellKey(outcome.assignmentDigest, outcome.arm), outcome] as const
  ));
  const assignmentsByFamily = new Map<string, OptimizerPairAssignment[]>();
  for (const assignment of assignments) {
    const family = assignmentsByFamily.get(assignment.familyDigest) ?? [];
    family.push(assignment);
    assignmentsByFamily.set(assignment.familyDigest, family);
  }

  const familyQuality: Array<Readonly<{
    familyDigest: string;
    deltaNumerator: bigint;
  }>> = [];
  let candidateMissingQualityCount = 0;
  let controlMissingQualityCount = 0;
  let candidateTokenTotal = 0n;
  let controlTokenTotal = 0n;
  let candidateElapsedTotal = 0n;
  let controlElapsedTotal = 0n;
  const incompleteReasons = new Set<OptimizerGateReason>();

  for (const benchmarkCase of [...registry.cases].sort((left, right) =>
    left.familyDigest.localeCompare(right.familyDigest)
  )) {
    const familyAssignments = assignmentsByFamily.get(
      benchmarkCase.familyDigest,
    );
    if (familyAssignments === undefined) {
      throw new Error("validated optimizer family lost its assignments");
    }
    let candidatePasses = 0n;
    let controlPasses = 0n;
    for (const assignment of familyAssignments) {
      const candidate = outcomeByCell.get(outcomeCellKey(
        assignment.assignmentDigest,
        "candidate",
      ));
      const control = outcomeByCell.get(outcomeCellKey(
        assignment.assignmentDigest,
        "control",
      ));
      if (candidate === undefined || control === undefined) {
        throw new Error("validated optimizer assignment lost an arm outcome");
      }
      candidatePasses += BigInt(conservativeQuality(candidate));
      controlPasses += BigInt(conservativeQuality(control));
      if (candidate.quality.kind === "missing") {
        candidateMissingQualityCount += 1;
      }
      if (control.quality.kind === "missing") {
        controlMissingQualityCount += 1;
      }

      if (candidate.providerTokens.kind === "exact") {
        candidateTokenTotal += BigInt(candidate.providerTokens.totalTokens);
      } else incompleteReasons.add("providerTokenEvidenceMissing");
      if (control.providerTokens.kind === "exact") {
        controlTokenTotal += BigInt(control.providerTokens.totalTokens);
      } else incompleteReasons.add("providerTokenEvidenceMissing");
      if (candidate.elapsed.kind === "exact") {
        candidateElapsedTotal += BigInt(candidate.elapsed.milliseconds);
      } else incompleteReasons.add("elapsedEvidenceMissing");
      if (control.elapsed.kind === "exact") {
        controlElapsedTotal += BigInt(control.elapsed.milliseconds);
      } else incompleteReasons.add("elapsedEvidenceMissing");
    }
    familyQuality.push(Object.freeze({
      familyDigest: benchmarkCase.familyDigest,
      deltaNumerator: candidatePasses - controlPasses,
    }));
  }

  if (controlTokenTotal === 0n) {
    incompleteReasons.add("zeroControlProviderTokens");
  }
  if (controlElapsedTotal === 0n) {
    incompleteReasons.add("zeroControlElapsed");
  }
  if (incompleteReasons.size > 0) {
    return Object.freeze({
      kind: "inconclusive",
      reasons: freezeReasons(incompleteReasons),
    });
  }

  const replicates = BigInt(registry.gate.replicatePairsPerFamily);
  const qualityNumerator = familyQuality.reduce(
    (total, family) => total + family.deltaNumerator,
    0n,
  );
  const qualityDenominator = BigInt(familyQuality.length) * replicates;
  const trimCount = Number(ceilRatio(
    BigInt(familyQuality.length) *
      BigInt(registry.gate.compositionTrimBasisPoints),
    10_000n,
  ));
  const sensitivityFamilies = [...familyQuality].sort((left, right) => {
    if (left.deltaNumerator > right.deltaNumerator) return -1;
    if (left.deltaNumerator < right.deltaNumerator) return 1;
    return left.familyDigest.localeCompare(right.familyDigest);
  }).slice(trimCount);
  const sensitivityNumerator = sensitivityFamilies.reduce(
    (total, family) => total + family.deltaNumerator,
    0n,
  );
  const sensitivityDenominator =
    BigInt(sensitivityFamilies.length) * replicates;

  const metrics = optimizerFiniteBenchmarkMetricsSchema.parse({
    familyCount: familyQuality.length,
    replicatePairsPerFamily: registry.gate.replicatePairsPerFamily,
    candidateMissingQualityCount,
    controlMissingQualityCount,
    qualityDelta: exactThresholdMeasure(
      qualityNumerator,
      qualityDenominator,
      registry.gate.qualityDeltaBasisPoints,
    ),
    compositionSensitivity: {
      ...exactThresholdMeasure(
        sensitivityNumerator,
        sensitivityDenominator,
        registry.gate.compositionDeltaBasisPoints,
      ),
      removedFamilyCount: trimCount,
    },
    providerTokenHarm: exactHarmRatio(
      candidateTokenTotal,
      controlTokenTotal,
      registry.gate.maximumProviderTokenHarmBasisPoints,
    ),
    elapsedHarm: exactHarmRatio(
      candidateElapsedTotal,
      controlElapsedTotal,
      registry.gate.maximumElapsedHarmBasisPoints,
    ),
  });
  return Object.freeze({ kind: "complete", metrics });
}

function conservativeQuality(outcome: OptimizerArmOutcome): 0 | 1 {
  switch (outcome.quality.kind) {
    case "observedPass":
      return 1;
    case "observedFail":
      return 0;
    case "missing":
      return outcome.arm === "candidate" ? 0 : 1;
  }
}

function exactThresholdMeasure(
  numerator: bigint,
  denominator: bigint,
  thresholdBasisPoints: number,
): z.infer<typeof optimizerExactThresholdMeasureSchema> {
  if (denominator <= 0n) {
    throw new Error("optimizer threshold denominator must be positive");
  }
  return Object.freeze({
    numerator: numerator.toString(),
    denominator: denominator.toString(),
    thresholdBasisPoints,
    observedBasisPointsFloor: Number(floorRatio(
      numerator * 10_000n,
      denominator,
    )),
    passes: numerator * 10_000n >=
      denominator * BigInt(thresholdBasisPoints),
  });
}

function exactHarmRatio(
  candidate: bigint,
  control: bigint,
  maximumBasisPoints: number,
): z.infer<typeof optimizerExactHarmRatioSchema> {
  if (candidate < 0n || control <= 0n) {
    throw new Error("optimizer harm ratio denominator must be positive");
  }
  return Object.freeze({
    candidateNumerator: candidate.toString(),
    controlDenominator: control.toString(),
    maximumBasisPoints,
    observedBasisPointsFloor: (candidate * 10_000n / control).toString(),
    passes: candidate * 10_000n <= control * BigInt(maximumBasisPoints),
  });
}

type SealGateResultInput = Readonly<{
  kind: "infeasible" | "recoveryRequired" | "inconclusive" | "contained" |
    "failed" | "recommendCanary";
  registryDigest: string | null;
  cellSetDigest: string | null;
  requiredPairAssignments: number | null;
  requiredArmOutcomes: number | null;
  reasons: readonly (OptimizerGateReason | OptimizerFeasibilityReason)[];
  metrics: OptimizerFiniteBenchmarkMetrics | null;
}>;

function sealGateResult(
  input: SealGateResultInput,
): OptimizerFiniteBenchmarkGateResult {
  const reasons = [...new Set(input.reasons)].sort();
  const payload = {
    schemaVersion: HRA_OPTIMIZER_SCHEMA_VERSION,
    researchOnly: true,
    policyAuthorization: "none",
    rolloutAuthorization: "none",
    kind: input.kind,
    registryDigest: input.registryDigest,
    cellSetDigest: input.cellSetDigest,
    requiredPairAssignments: input.requiredPairAssignments,
    requiredArmOutcomes: input.requiredArmOutcomes,
    reasons,
    metrics: input.metrics,
  };
  return optimizerFiniteBenchmarkGateResultSchema.parse({
    ...payload,
    gateReceiptDigest: optimizerEvidenceDigest("gate-result", payload),
  });
}

function assignmentCellKey(
  familyDigest: string,
  replicateOrdinal: number,
): string {
  return `${familyDigest}:${replicateOrdinal}`;
}

function outcomeCellKey(assignmentDigest: string, arm: string): string {
  return `${assignmentDigest}:${arm}`;
}

function compareAssignments(
  left: OptimizerPairAssignment,
  right: OptimizerPairAssignment,
): number {
  return left.familyDigest.localeCompare(right.familyDigest) ||
    left.replicateOrdinal - right.replicateOrdinal ||
    left.assignmentDigest.localeCompare(right.assignmentDigest);
}

function compareOutcomes(
  left: OptimizerArmOutcome,
  right: OptimizerArmOutcome,
): number {
  return left.familyDigest.localeCompare(right.familyDigest) ||
    left.replicateOrdinal - right.replicateOrdinal ||
    left.arm.localeCompare(right.arm) ||
    optimizerEvidenceDigest("arm-outcome", left).localeCompare(
      optimizerEvidenceDigest("arm-outcome", right),
    );
}

function freezeReasons(
  reasons: ReadonlySet<OptimizerGateReason>,
): readonly OptimizerGateReason[] {
  return Object.freeze([...reasons].sort());
}

function optimizerEvidenceDigest(domain: string, value: unknown): string {
  const domainBytes = Buffer.byteLength(domain, "utf8");
  return createHash("sha256")
    .update(`${OPTIMIZER_HASH_PREFIX}\0${domainBytes}:${domain}\0`, "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" ||
    typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("optimizer evidence must use finite JSON numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new TypeError("optimizer evidence must be canonical JSON");
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("optimizer evidence must use plain JSON objects");
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}

function ceilRatio(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function floorRatio(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder < 0n ? quotient - 1n : quotient;
}
