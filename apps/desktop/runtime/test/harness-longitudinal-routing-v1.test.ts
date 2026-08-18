import { describe, expect, test } from "bun:test";

import {
  evaluateLongitudinalRoutingShadowComparison,
  longitudinalRoutingInspectionSchema,
  longitudinalRoutingRouteArmSchema,
  longitudinalRoutingShadowComparisonSchema,
} from "../src/harness/longitudinal-routing-v1";

function comparisonArm(overrides: Readonly<{
  operationalResults?: number;
  qualityEvaluatedResults?: number;
  qualityPassedResults?: number;
  uncachedInputObservedResults?: number;
  uncachedInputTokens?: number;
}> = {}) {
  const operationalResults = overrides.operationalResults ?? 8;
  return {
    operationalResults,
    qualityEvaluatedResults:
      overrides.qualityEvaluatedResults ?? operationalResults,
    qualityPassedResults: overrides.qualityPassedResults ??
      overrides.qualityEvaluatedResults ?? operationalResults,
    uncachedInputObservedResults:
      overrides.uncachedInputObservedResults ?? operationalResults,
    uncachedInputTokens: overrides.uncachedInputTokens ?? 800,
  };
}

function tokenDimension(results: number, total: number) {
  return { observedResults: results, missingResults: 0, total };
}

function routeArm() {
  return {
    policyVersion: 1,
    workClass: "boundedLeaf",
    requestedProfile: "lunaMax",
    requestedTier: "fast",
    realizedTier: "standard",
    results: 1,
    operationalOutcomes: {
      succeeded: 1,
      failed: 0,
      cancelled: 0,
      quotaRejected: 0,
    },
    quality: { state: "absent", evaluatedResults: 0 },
    tokens: {
      inputTokens: tokenDimension(1, 100),
      cachedInputTokens: tokenDimension(1, 40),
      uncachedInputTokens: tokenDimension(1, 60),
      outputTokens: tokenDimension(1, 30),
      reasoningOutputTokens: tokenDimension(1, 20),
    },
    elapsed: { observedResults: 1, missingResults: 0, totalMilliseconds: 250 },
  };
}

describe("longitudinal routing v1", () => {
  test("names requested route intent without implying provider compliance", () => {
    const arm = routeArm();
    expect(longitudinalRoutingRouteArmSchema.parse(arm)).toMatchObject({
      requestedProfile: "lunaMax",
      requestedTier: "fast",
      realizedTier: "standard",
    });
    expect(() => longitudinalRoutingRouteArmSchema.parse({
      ...arm,
      routedProfile: "lunaMax",
    })).toThrow();
  });

  test("requires recursive-only coverage on every inspection response", () => {
    expect(longitudinalRoutingInspectionSchema.parse({
      kind: "unavailable",
      schemaVersion: 1,
      mode: "shadow",
      policyAuthorization: "none",
      coverage: {
        outcomes: "recursiveActorOutcomesOnly",
        ordinaryRootTurnSpend: "excluded",
      },
      reason: "paneLineageUnavailable",
    })).toMatchObject({
      coverage: {
        outcomes: "recursiveActorOutcomesOnly",
        ordinaryRootTurnSpend: "excluded",
      },
    });
    expect(() => longitudinalRoutingInspectionSchema.parse({
      kind: "unavailable",
      schemaVersion: 1,
      mode: "shadow",
      policyAuthorization: "none",
      reason: "paneLineageUnavailable",
    })).toThrow();
  });

  test("keeps every comparison descriptive and quality-first", () => {
    expect(evaluateLongitudinalRoutingShadowComparison({
      control: comparisonArm({ operationalResults: 7 }),
      candidate: comparisonArm(),
    }).state).toBe("collectingOperationalEvidence");

    expect(evaluateLongitudinalRoutingShadowComparison({
      control: comparisonArm({ qualityEvaluatedResults: 7 }),
      candidate: comparisonArm(),
    }).state).toBe("qualityEvidenceRequired");

    expect(evaluateLongitudinalRoutingShadowComparison({
      control: comparisonArm(),
      candidate: comparisonArm({ qualityPassedResults: 7 }),
    }).state).toBe("qualityFloorHold");

    expect(evaluateLongitudinalRoutingShadowComparison({
      control: comparisonArm({ uncachedInputObservedResults: 7 }),
      candidate: comparisonArm(),
    }).state).toBe("tokenEvidenceRequired");

    expect(evaluateLongitudinalRoutingShadowComparison({
      control: comparisonArm(),
      candidate: comparisonArm({ uncachedInputTokens: 770 }),
    }).state).toBe("hysteresisHold");

    expect(evaluateLongitudinalRoutingShadowComparison({
      control: comparisonArm(),
      candidate: comparisonArm({ uncachedInputTokens: 720 }),
    })).toEqual({
      mode: "shadow",
      policyAuthorization: "none",
      state: "shadowCandidate",
      controlQualityBasisPoints: 10_000,
      candidateQualityBasisPoints: 10_000,
      tokenSavingsBasisPoints: 1_000,
    });
  });

  test("bounds negative savings without granting policy authority", () => {
    expect(longitudinalRoutingShadowComparisonSchema.parse(
      evaluateLongitudinalRoutingShadowComparison({
        control: comparisonArm({ uncachedInputTokens: 0 }),
        candidate: comparisonArm({ uncachedInputTokens: 1 }),
      }),
    )).toMatchObject({
      mode: "shadow",
      policyAuthorization: "none",
      state: "hysteresisHold",
      tokenSavingsBasisPoints: -10_000,
    });
  });

  test("rejects contradictory model-visible aggregates", () => {
    const arm = routeArm();
    expect(() => longitudinalRoutingRouteArmSchema.parse({
      ...arm,
      operationalOutcomes: {
        ...arm.operationalOutcomes,
        failed: 1,
      },
    })).toThrow();
    expect(() => longitudinalRoutingRouteArmSchema.parse({
      ...arm,
      tokens: {
        ...arm.tokens,
        inputTokens: { observedResults: 1, missingResults: 1, total: 100 },
      },
    })).toThrow();

    expect(() => longitudinalRoutingInspectionSchema.parse({
      schemaVersion: 1,
      mode: "shadow",
      policyAuthorization: "none",
      coverage: {
        outcomes: "recursiveActorOutcomesOnly",
        ordinaryRootTurnSpend: "excluded",
      },
      kind: "available",
      scope: "chatPaneAcrossEpochs",
      evidence: {
        results: 1,
        operationalOutcomes: {
          succeeded: 0,
          failed: 0,
          cancelled: 0,
          quotaRejected: 0,
        },
        quality: {
          state: "absent",
          evaluatedResults: 0,
          interpretation: "operational completion is not a quality signal",
        },
        tokens: arm.tokens,
        elapsed: arm.elapsed,
      },
      analysis: { freshness: "pending" },
      routeArmCount: 1,
      reportedRouteArmCount: 1,
      routeArmsTruncated: false,
      routes: [arm],
      shadow: {
        state: "qualityEvidenceRequired",
        minimumOperationalResultsPerArm: 8,
        minimumQualityResultsPerArm: 8,
        qualityToleranceBasisPoints: 100,
        hysteresisBasisPoints: 500,
        recommendation: null,
      },
    })).toThrow();
  });
});
