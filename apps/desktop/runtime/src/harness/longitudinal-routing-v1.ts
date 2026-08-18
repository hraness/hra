import { z } from "@hra-internal/schema";

import {
  actorPolicyVersionSchema,
  persistedActorWorkClassSchema,
} from "./actor-domain";

export const HRA_LONGITUDINAL_ROUTING_SCHEMA_VERSION = 1 as const;
export const HRA_LONGITUDINAL_ROUTING_MAX_REPORTED_ARMS = 32;
export const HRA_LONGITUDINAL_ROUTING_MIN_OPERATIONAL_RESULTS_PER_ARM = 8;
export const HRA_LONGITUDINAL_ROUTING_MIN_QUALITY_RESULTS_PER_ARM = 8;
export const HRA_LONGITUDINAL_ROUTING_QUALITY_TOLERANCE_BASIS_POINTS = 100;
export const HRA_LONGITUDINAL_ROUTING_HYSTERESIS_BASIS_POINTS = 500;
export const HRA_LONGITUDINAL_ROUTING_EVIDENCE_COVERAGE_V1 = Object.freeze({
  outcomes: "recursiveActorOutcomesOnly" as const,
  ordinaryRootTurnSpend: "excluded" as const,
});

export const longitudinalRoutingProfileSchema = z.enum([
  "solUltra",
  "solMax",
  "lunaMax",
  "unobserved",
]);
export type LongitudinalRoutingProfile = z.infer<
  typeof longitudinalRoutingProfileSchema
>;

export const longitudinalRoutingTierSchema = z.enum([
  "standard",
  "fast",
  "unobserved",
]);
export type LongitudinalRoutingTier = z.infer<
  typeof longitudinalRoutingTierSchema
>;

export const longitudinalRoutingTokenDimensionSchema = z.object({
  observedResults: z.number().int().nonnegative().safe(),
  missingResults: z.number().int().nonnegative().safe(),
  total: z.number().int().nonnegative().safe(),
}).strict();
export type LongitudinalRoutingTokenDimension = z.infer<
  typeof longitudinalRoutingTokenDimensionSchema
>;

export const longitudinalRoutingTokenTotalsSchema = z.object({
  inputTokens: longitudinalRoutingTokenDimensionSchema,
  cachedInputTokens: longitudinalRoutingTokenDimensionSchema,
  uncachedInputTokens: longitudinalRoutingTokenDimensionSchema,
  outputTokens: longitudinalRoutingTokenDimensionSchema,
  reasoningOutputTokens: longitudinalRoutingTokenDimensionSchema,
}).strict();
export type LongitudinalRoutingTokenTotals = z.infer<
  typeof longitudinalRoutingTokenTotalsSchema
>;

export const longitudinalRoutingElapsedSchema = z.object({
  observedResults: z.number().int().nonnegative().safe(),
  missingResults: z.number().int().nonnegative().safe(),
  totalMilliseconds: z.number().int().nonnegative().safe(),
}).strict();
export type LongitudinalRoutingElapsed = z.infer<
  typeof longitudinalRoutingElapsedSchema
>;

export const longitudinalRoutingOperationalOutcomesSchema = z.object({
  succeeded: z.number().int().nonnegative().safe(),
  failed: z.number().int().nonnegative().safe(),
  cancelled: z.number().int().nonnegative().safe(),
  quotaRejected: z.number().int().nonnegative().safe(),
}).strict();
export type LongitudinalRoutingOperationalOutcomes = z.infer<
  typeof longitudinalRoutingOperationalOutcomesSchema
>;

const longitudinalRoutingTokenDimensionKeys = Object.freeze([
  "inputTokens",
  "cachedInputTokens",
  "uncachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
] as const);

export const longitudinalRoutingRouteArmSchema = z.object({
  policyVersion: actorPolicyVersionSchema,
  workClass: persistedActorWorkClassSchema,
  requestedProfile: longitudinalRoutingProfileSchema,
  requestedTier: longitudinalRoutingTierSchema,
  realizedTier: longitudinalRoutingTierSchema,
  results: z.number().int().positive().safe(),
  operationalOutcomes: longitudinalRoutingOperationalOutcomesSchema,
  quality: z.object({
    state: z.literal("absent"),
    evaluatedResults: z.literal(0),
  }).strict(),
  tokens: longitudinalRoutingTokenTotalsSchema,
  elapsed: longitudinalRoutingElapsedSchema,
}).strict().superRefine((arm, context) => {
  const operationalResults = Object.values(arm.operationalOutcomes)
    .reduce((total, count) => total + count, 0);
  if (operationalResults !== arm.results) {
    context.addIssue({
      code: "custom",
      message: "operational outcomes must account for every route result",
      path: ["operationalOutcomes"],
    });
  }
  for (const dimension of longitudinalRoutingTokenDimensionKeys) {
    const tokens = arm.tokens[dimension];
    if (tokens.observedResults + tokens.missingResults !== arm.results) {
      context.addIssue({
        code: "custom",
        message: "token evidence must account for every route result",
        path: ["tokens", dimension],
      });
    }
  }
  if (
    arm.elapsed.observedResults + arm.elapsed.missingResults !== arm.results
  ) {
    context.addIssue({
      code: "custom",
      message: "elapsed evidence must account for every route result",
      path: ["elapsed"],
    });
  }
});
export type LongitudinalRoutingRouteArm = z.infer<
  typeof longitudinalRoutingRouteArmSchema
>;

export const longitudinalRoutingShadowStateSchema = z.enum([
  "collectingOperationalEvidence",
  "qualityEvidenceRequired",
]);

const longitudinalRoutingInspectionBaseSchema = z.object({
  schemaVersion: z.literal(HRA_LONGITUDINAL_ROUTING_SCHEMA_VERSION),
  mode: z.literal("shadow"),
  policyAuthorization: z.literal("none"),
  coverage: z.object({
    outcomes: z.literal(
      HRA_LONGITUDINAL_ROUTING_EVIDENCE_COVERAGE_V1.outcomes,
    ),
    ordinaryRootTurnSpend: z.literal(
      HRA_LONGITUDINAL_ROUTING_EVIDENCE_COVERAGE_V1.ordinaryRootTurnSpend,
    ),
  }).strict(),
}).strict();

export const longitudinalRoutingUnavailableInspectionSchema =
  longitudinalRoutingInspectionBaseSchema.extend({
    kind: z.literal("unavailable"),
    reason: z.enum([
      "paneLineageUnavailable",
      "paneLineageAmbiguous",
    ]),
  }).strict();

export const longitudinalRoutingAvailableInspectionSchema =
  longitudinalRoutingInspectionBaseSchema.extend({
    kind: z.literal("available"),
    scope: z.literal("chatPaneAcrossEpochs"),
    evidence: z.object({
      results: z.number().int().nonnegative().safe(),
      operationalOutcomes: longitudinalRoutingOperationalOutcomesSchema,
      quality: z.object({
        state: z.literal("absent"),
        evaluatedResults: z.literal(0),
        interpretation: z.literal(
          "operational completion is not a quality signal",
        ),
      }).strict(),
      tokens: longitudinalRoutingTokenTotalsSchema,
      elapsed: longitudinalRoutingElapsedSchema,
    }).strict(),
    analysis: z.object({
      freshness: z.enum(["current", "pending"]),
    }).strict(),
    routeArmCount: z.number().int().nonnegative().safe(),
    reportedRouteArmCount: z.number().int().nonnegative()
      .max(HRA_LONGITUDINAL_ROUTING_MAX_REPORTED_ARMS),
    routeArmsTruncated: z.boolean(),
    routes: z.array(longitudinalRoutingRouteArmSchema)
      .max(HRA_LONGITUDINAL_ROUTING_MAX_REPORTED_ARMS),
    shadow: z.object({
      state: longitudinalRoutingShadowStateSchema,
      minimumOperationalResultsPerArm: z.literal(
        HRA_LONGITUDINAL_ROUTING_MIN_OPERATIONAL_RESULTS_PER_ARM,
      ),
      minimumQualityResultsPerArm: z.literal(
        HRA_LONGITUDINAL_ROUTING_MIN_QUALITY_RESULTS_PER_ARM,
      ),
      qualityToleranceBasisPoints: z.literal(
        HRA_LONGITUDINAL_ROUTING_QUALITY_TOLERANCE_BASIS_POINTS,
      ),
      hysteresisBasisPoints: z.literal(
        HRA_LONGITUDINAL_ROUTING_HYSTERESIS_BASIS_POINTS,
      ),
      recommendation: z.null(),
    }).strict(),
  }).strict().superRefine((inspection, context) => {
    const operationalResults = Object.values(
      inspection.evidence.operationalOutcomes,
    ).reduce((total, count) => total + count, 0);
    if (operationalResults !== inspection.evidence.results) {
      context.addIssue({
        code: "custom",
        message: "operational outcomes must account for every result",
        path: ["evidence", "operationalOutcomes"],
      });
    }
    for (const dimension of longitudinalRoutingTokenDimensionKeys) {
      const tokens = inspection.evidence.tokens[dimension];
      if (
        tokens.observedResults + tokens.missingResults !==
          inspection.evidence.results
      ) {
        context.addIssue({
          code: "custom",
          message: "token evidence must account for every result",
          path: ["evidence", "tokens", dimension],
        });
      }
    }
    if (
      inspection.evidence.elapsed.observedResults +
          inspection.evidence.elapsed.missingResults !==
        inspection.evidence.results
    ) {
      context.addIssue({
        code: "custom",
        message: "elapsed evidence must account for every result",
        path: ["evidence", "elapsed"],
      });
    }
    if (inspection.reportedRouteArmCount !== inspection.routes.length) {
      context.addIssue({
        code: "custom",
        message: "reported route count must equal the bounded route list",
        path: ["reportedRouteArmCount"],
      });
    }
    if (
      inspection.routeArmsTruncated !==
        (inspection.routeArmCount > inspection.reportedRouteArmCount)
    ) {
      context.addIssue({
        code: "custom",
        message: "route truncation must describe omitted route arms exactly",
        path: ["routeArmsTruncated"],
      });
    }
  });

export const longitudinalRoutingInspectionSchema = z.union([
  longitudinalRoutingUnavailableInspectionSchema,
  longitudinalRoutingAvailableInspectionSchema,
]);
export type LongitudinalRoutingInspectionV1 = z.infer<
  typeof longitudinalRoutingInspectionSchema
>;

const shadowComparisonArmSchema = z.object({
  operationalResults: z.number().int().nonnegative().safe(),
  qualityEvaluatedResults: z.number().int().nonnegative().safe(),
  qualityPassedResults: z.number().int().nonnegative().safe(),
  uncachedInputObservedResults: z.number().int().nonnegative().safe(),
  uncachedInputTokens: z.number().int().nonnegative().safe(),
}).strict().superRefine((arm, context) => {
  if (arm.qualityPassedResults > arm.qualityEvaluatedResults) {
    context.addIssue({
      code: "custom",
      message: "quality passes cannot exceed evaluated results",
      path: ["qualityPassedResults"],
    });
  }
  if (arm.qualityEvaluatedResults > arm.operationalResults) {
    context.addIssue({
      code: "custom",
      message: "quality evidence cannot exceed operational evidence",
      path: ["qualityEvaluatedResults"],
    });
  }
  if (arm.uncachedInputObservedResults > arm.operationalResults) {
    context.addIssue({
      code: "custom",
      message: "token evidence cannot exceed operational evidence",
      path: ["uncachedInputObservedResults"],
    });
  }
});

const shadowComparisonInputSchema = z.object({
  control: shadowComparisonArmSchema,
  candidate: shadowComparisonArmSchema,
}).strict();

export const longitudinalRoutingShadowComparisonSchema = z.object({
  mode: z.literal("shadow"),
  policyAuthorization: z.literal("none"),
  state: z.enum([
    "collectingOperationalEvidence",
    "qualityEvidenceRequired",
    "tokenEvidenceRequired",
    "qualityFloorHold",
    "hysteresisHold",
    "shadowCandidate",
  ]),
  controlQualityBasisPoints: z.number().int().min(0).max(10_000).nullable(),
  candidateQualityBasisPoints: z.number().int().min(0).max(10_000).nullable(),
  tokenSavingsBasisPoints: z.number().int().min(-10_000).max(10_000).nullable(),
}).strict();
export type LongitudinalRoutingShadowComparison = z.infer<
  typeof longitudinalRoutingShadowComparisonSchema
>;

/**
 * Descriptive eligibility only. It cannot activate a route and treats missing
 * quality as missing evidence, never as success inferred from completion.
 */
export function evaluateLongitudinalRoutingShadowComparison(
  inputValue: unknown,
): LongitudinalRoutingShadowComparison {
  const input = shadowComparisonInputSchema.parse(inputValue);
  const base = {
    mode: "shadow" as const,
    policyAuthorization: "none" as const,
  };
  if (
    input.control.operationalResults <
      HRA_LONGITUDINAL_ROUTING_MIN_OPERATIONAL_RESULTS_PER_ARM ||
    input.candidate.operationalResults <
      HRA_LONGITUDINAL_ROUTING_MIN_OPERATIONAL_RESULTS_PER_ARM
  ) {
    return longitudinalRoutingShadowComparisonSchema.parse({
      ...base,
      state: "collectingOperationalEvidence",
      controlQualityBasisPoints: null,
      candidateQualityBasisPoints: null,
      tokenSavingsBasisPoints: null,
    });
  }
  if (
    input.control.qualityEvaluatedResults <
      HRA_LONGITUDINAL_ROUTING_MIN_QUALITY_RESULTS_PER_ARM ||
    input.candidate.qualityEvaluatedResults <
      HRA_LONGITUDINAL_ROUTING_MIN_QUALITY_RESULTS_PER_ARM
  ) {
    return longitudinalRoutingShadowComparisonSchema.parse({
      ...base,
      state: "qualityEvidenceRequired",
      controlQualityBasisPoints: null,
      candidateQualityBasisPoints: null,
      tokenSavingsBasisPoints: null,
    });
  }
  const controlQualityBasisPoints = rateBasisPoints(
    input.control.qualityPassedResults,
    input.control.qualityEvaluatedResults,
  );
  const candidateQualityBasisPoints = rateBasisPoints(
    input.candidate.qualityPassedResults,
    input.candidate.qualityEvaluatedResults,
  );
  if (
    candidateQualityBasisPoints +
      HRA_LONGITUDINAL_ROUTING_QUALITY_TOLERANCE_BASIS_POINTS <
        controlQualityBasisPoints
  ) {
    return longitudinalRoutingShadowComparisonSchema.parse({
      ...base,
      state: "qualityFloorHold",
      controlQualityBasisPoints,
      candidateQualityBasisPoints,
      tokenSavingsBasisPoints: null,
    });
  }
  if (
    input.control.uncachedInputObservedResults <
      HRA_LONGITUDINAL_ROUTING_MIN_OPERATIONAL_RESULTS_PER_ARM ||
    input.candidate.uncachedInputObservedResults <
      HRA_LONGITUDINAL_ROUTING_MIN_OPERATIONAL_RESULTS_PER_ARM
  ) {
    return longitudinalRoutingShadowComparisonSchema.parse({
      ...base,
      state: "tokenEvidenceRequired",
      controlQualityBasisPoints,
      candidateQualityBasisPoints,
      tokenSavingsBasisPoints: null,
    });
  }
  const tokenSavingsBasisPoints = averageSavingsBasisPoints(
    input.control.uncachedInputTokens,
    input.control.uncachedInputObservedResults,
    input.candidate.uncachedInputTokens,
    input.candidate.uncachedInputObservedResults,
  );
  return longitudinalRoutingShadowComparisonSchema.parse({
    ...base,
    state: tokenSavingsBasisPoints >=
        HRA_LONGITUDINAL_ROUTING_HYSTERESIS_BASIS_POINTS
      ? "shadowCandidate"
      : "hysteresisHold",
    controlQualityBasisPoints,
    candidateQualityBasisPoints,
    tokenSavingsBasisPoints,
  });
}

function rateBasisPoints(passed: number, evaluated: number): number {
  return Number(
    BigInt(passed) * 10_000n / BigInt(evaluated),
  );
}

function averageSavingsBasisPoints(
  controlTokens: number,
  controlCount: number,
  candidateTokens: number,
  candidateCount: number,
): number {
  if (controlTokens === 0) return candidateTokens === 0 ? 0 : -10_000;
  const controlScaled = BigInt(controlTokens) * BigInt(candidateCount);
  const candidateScaled = BigInt(candidateTokens) * BigInt(controlCount);
  const savings = (controlScaled - candidateScaled) * 10_000n / controlScaled;
  const bounded = savings < -10_000n ? -10_000n
    : savings > 10_000n ? 10_000n
    : savings;
  return Number(bounded);
}
