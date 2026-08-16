import { describe, expect, test } from "bun:test";

import {
  digestOptimizerPairAssignmentPayload,
} from "../src/harness/optimizer-domain-v1";
import {
  evaluateOptimizerFiniteBenchmark,
  optimizerArmOutcomeSchema,
  optimizerFiniteBenchmarkGateResultSchema,
  optimizerProviderTokensSchema,
} from "../src/harness/optimizer-evidence-v1";
import {
  OPTIMIZER_FIXTURE_ASSIGNMENT_KEY,
  fixtureDigest,
  makePassingOptimizerGateFixture,
} from "./harness-optimizer-fixtures";

function evaluateFixture(
  fixture: ReturnType<typeof makePassingOptimizerGateFixture>,
  overrides: Readonly<{
    assignments?: readonly unknown[];
    outcomes?: readonly unknown[];
  }> = {},
) {
  return evaluateOptimizerFiniteBenchmark({
    schemaVersion: 1,
    registry: fixture.registry,
    registryDigest: fixture.registryDigest,
    assignmentKeyVersion: 1,
    assignmentKey: OPTIMIZER_FIXTURE_ASSIGNMENT_KEY,
    assignments: overrides.assignments ?? fixture.assignments,
    outcomes: overrides.outcomes ?? fixture.outcomes,
  });
}

describe("optimizer Phase 0 finite evidence gate", () => {
  test("emits only a research-only recommendation after every finite gate passes", () => {
    const fixture = makePassingOptimizerGateFixture();
    const result = evaluateFixture(fixture);
    expect(result).toMatchObject({
      kind: "recommendCanary",
      researchOnly: true,
      policyAuthorization: "none",
      rolloutAuthorization: "none",
      reasons: [],
      requiredPairAssignments: 256,
      requiredArmOutcomes: 512,
      metrics: {
        familyCount: 64,
        replicatePairsPerFamily: 4,
        qualityDelta: {
          numerator: "256",
          denominator: "256",
          passes: true,
        },
        compositionSensitivity: {
          removedFamilyCount: 4,
          numerator: "240",
          denominator: "240",
          passes: true,
        },
        providerTokenHarm: { passes: true },
        elapsedHarm: { passes: true },
      },
    });
    expect(optimizerFiniteBenchmarkGateResultSchema.safeParse({
      ...result,
      gateReceiptDigest: "0".repeat(64),
    }).success).toBeFalse();
  });

  test("requires live assignment-key custody before recomputing every block", () => {
    const fixture = makePassingOptimizerGateFixture();
    expect(evaluateOptimizerFiniteBenchmark({
      schemaVersion: 1,
      registry: fixture.registry,
      registryDigest: fixture.registryDigest,
      assignmentKeyVersion: 1,
      assignmentKey: null,
      assignments: fixture.assignments,
      outcomes: fixture.outcomes,
    })).toMatchObject({
      kind: "recoveryRequired",
      reasons: ["assignmentKeyUnavailable"],
      policyAuthorization: "none",
      metrics: null,
    });
    expect(evaluateOptimizerFiniteBenchmark({
      schemaVersion: 1,
      registry: fixture.registry,
      registryDigest: fixture.registryDigest,
      assignmentKeyVersion: 1,
      assignmentKey: Uint8Array.from({ length: 32 }, () => 99),
      assignments: fixture.assignments,
      outcomes: fixture.outcomes,
    })).toMatchObject({
      kind: "recoveryRequired",
      reasons: ["assignmentKeyMismatch"],
      metrics: null,
    });

    const original = fixture.assignments[0]!;
    const { assignmentDigest: _assignmentDigest, ...payload } = original;
    expect(_assignmentDigest).toBe(original.assignmentDigest);
    const tamperedPayload = {
      ...payload,
      executionOrder: original.executionOrder === "candidateFirst"
        ? "controlFirst" as const
        : "candidateFirst" as const,
    };
    const tampered = {
      ...tamperedPayload,
      assignmentDigest: digestOptimizerPairAssignmentPayload(tamperedPayload),
    };
    expect(evaluateFixture(fixture, {
      assignments: [tampered, ...fixture.assignments.slice(1)],
    })).toMatchObject({
      kind: "contained",
      reasons: ["assignmentIntegrityConflict"],
      metrics: null,
    });
  });

  test("keeps raw missing outcomes and applies the asymmetric conservative bound", () => {
    const fixture = makePassingOptimizerGateFixture();
    const outcomes = [...fixture.outcomes];
    for (const index of [0, 1]) {
      const original = outcomes[index]!;
      outcomes[index] = optimizerArmOutcomeSchema.parse({
        ...original,
        disposition: "cancelled",
        quality: { kind: "missing", reason: "cancelled" },
        evaluation: {
          kind: "unavailable",
          reason: "cancelled",
          evidenceDigest: fixtureDigest(`cancelled:${index}`),
          actorSelfReportEligible: false,
        },
      });
    }
    const result = evaluateFixture(fixture, { outcomes });
    expect(outcomes[0]?.quality).toEqual({
      kind: "missing",
      reason: "cancelled",
    });
    expect(outcomes[1]?.quality).toEqual({
      kind: "missing",
      reason: "cancelled",
    });
    expect(result).toMatchObject({
      kind: "recommendCanary",
      metrics: {
        candidateMissingQualityCount: 1,
        controlMissingQualityCount: 1,
        qualityDelta: {
          numerator: "254",
          denominator: "256",
        },
      },
    });
  });

  test("makes assignment loss and unequal replicates inconclusive", () => {
    const fixture = makePassingOptimizerGateFixture();
    const removed = fixture.assignments[0]!;
    const assignments = fixture.assignments.slice(1);
    const outcomes = fixture.outcomes.filter((outcome) =>
      outcome.assignmentDigest !== removed.assignmentDigest
    );
    const result = evaluateFixture(fixture, { assignments, outcomes });
    expect(result.kind).toBe("inconclusive");
    expect(result.reasons).toContain("assignmentMissing");
    expect(result.reasons).toContain("unequalReplicates");
    expect(result.policyAuthorization).toBe("none");
  });

  test("contains safety, partition carryover, and evaluator ambiguity", () => {
    const fixture = makePassingOptimizerGateFixture();
    const original = fixture.outcomes[0]!;
    const safetyViolation = optimizerArmOutcomeSchema.parse({
      ...original,
      safety: {
        kind: "violation",
        reason: "securityViolation",
        evidenceDigest: fixtureDigest("safety-violation"),
      },
    });
    let outcomes = [safetyViolation, ...fixture.outcomes.slice(1)];
    expect(evaluateFixture(fixture, { outcomes })).toMatchObject({
      kind: "contained",
      reasons: ["safetyViolation"],
    });

    if (original.partition.kind !== "exact") {
      throw new Error("passing fixture lost exact partition evidence");
    }
    const originalPartitionDigest = original.partition.partitionDigest;
    const otherPartition = fixture.registry.matchedPartitionDesign.partitions
      .find(({ partitionDigest }) =>
        partitionDigest !== originalPartitionDigest
      )!;
    const carryover = optimizerArmOutcomeSchema.parse({
      ...original,
      partition: {
        ...original.partition,
        partitionDigest: otherPartition.partitionDigest,
      },
    });
    outcomes = [carryover, ...fixture.outcomes.slice(1)];
    expect(evaluateFixture(fixture, { outcomes })).toMatchObject({
      kind: "contained",
      reasons: ["partitionCarryoverConflict"],
    });

    const ambiguousWithExactIntegrity = {
      ...original,
      disposition: "evaluatorAmbiguous",
      quality: { kind: "missing", reason: "evaluatorAmbiguous" },
      evaluation: {
        kind: "unavailable",
        reason: "evaluatorAmbiguous",
        evidenceDigest: fixtureDigest("ambiguous-evaluator"),
        actorSelfReportEligible: false,
      },
    };
    expect(optimizerArmOutcomeSchema.safeParse(ambiguousWithExactIntegrity).success)
      .toBeFalse();
    const ambiguity = optimizerArmOutcomeSchema.parse({
      ...ambiguousWithExactIntegrity,
      evidenceIntegrity: {
        kind: "conflict",
        reason: "evaluatorAmbiguity",
        evidenceDigest: fixtureDigest("ambiguous-integrity"),
      },
    });
    outcomes = [ambiguity, ...fixture.outcomes.slice(1)];
    expect(evaluateFixture(fixture, { outcomes })).toMatchObject({
      kind: "contained",
      reasons: ["evidenceIntegrityConflict"],
    });

    const containedArm = optimizerArmOutcomeSchema.parse({
      ...original,
      disposition: "contained",
      quality: { kind: "missing", reason: "contained" },
      evaluation: {
        kind: "unavailable",
        reason: "contained",
        evidenceDigest: fixtureDigest("contained-evaluator"),
        actorSelfReportEligible: false,
      },
    });
    outcomes = [containedArm, ...fixture.outcomes.slice(1)];
    expect(evaluateFixture(fixture, { outcomes })).toMatchObject({
      kind: "contained",
      reasons: ["armContained"],
      metrics: null,
    });
  });

  test("represents definitive pre-effect ITT outcomes without inventing an effect", () => {
    const fixture = makePassingOptimizerGateFixture();
    const original = fixture.outcomes[0]!;
    const notApplied = {
      ...original,
      disposition: "quotaExhaustion",
      quality: { kind: "missing", reason: "quotaExhaustion" },
      profile: {
        kind: "selectedNotApplied",
        requestedProfile: "solMax",
        selectedProfile: "solMax",
        fallbackReason: null,
        reason: "quotaExhaustion",
        capabilityEvidenceDigest: fixtureDigest("quota-profile"),
      },
      effectLineage: {
        kind: "notStarted",
        reason: "quotaExhaustion",
        admissionReceiptDigest: fixtureDigest("quota-admission"),
        definitiveNonApplicationEvidenceDigest: fixtureDigest(
          "quota-not-applied",
        ),
      },
      evaluation: {
        kind: "unavailable",
        reason: "quotaExhaustion",
        evidenceDigest: fixtureDigest("quota-evaluator"),
        actorSelfReportEligible: false,
      },
      providerTokens: {
        kind: "unavailable",
        reason: "effectNotStarted",
        evidenceDigest: fixtureDigest("quota-tokens"),
      },
      elapsed: {
        kind: "unavailable",
        reason: "effectNotStarted",
        evidenceDigest: fixtureDigest("quota-elapsed"),
      },
    };
    expect(optimizerArmOutcomeSchema.safeParse(notApplied).success).toBeTrue();
    expect(optimizerArmOutcomeSchema.safeParse({
      ...notApplied,
      providerTokens: original.providerTokens,
    }).success).toBeFalse();
    expect(optimizerArmOutcomeSchema.safeParse({
      ...notApplied,
      elapsed: original.elapsed,
    }).success).toBeFalse();
  });

  test("represents unavailable matched capacity as a closed missing pair", () => {
    const fixture = makePassingOptimizerGateFixture();
    const firstAssignment = fixture.assignments[0]!;
    const outcomes = fixture.outcomes.map((outcome) => {
      if (outcome.assignmentDigest !== firstAssignment.assignmentDigest) {
        return outcome;
      }
      const marker = `${outcome.assignmentDigest}:${outcome.arm}`;
      const candidate = outcome.arm === "candidate";
      return optimizerArmOutcomeSchema.parse({
        ...outcome,
        disposition: "matchedPartitionUnavailable",
        quality: {
          kind: "missing",
          reason: "matchedPartitionUnavailable",
        },
        profile: {
          kind: "selectedNotApplied",
          requestedProfile: candidate ? "solMax" : "lunaMax",
          selectedProfile: candidate ? "solMax" : "lunaMax",
          fallbackReason: null,
          reason: "matchedPartitionUnavailable",
          capabilityEvidenceDigest: fixtureDigest(`capacity-profile:${marker}`),
        },
        effectLineage: {
          kind: "notStarted",
          reason: "matchedPartitionUnavailable",
          admissionReceiptDigest: fixtureDigest(`capacity-admission:${marker}`),
          definitiveNonApplicationEvidenceDigest: fixtureDigest(
            `capacity-not-applied:${marker}`,
          ),
        },
        evaluation: {
          kind: "unavailable",
          reason: "matchedPartitionUnavailable",
          evidenceDigest: fixtureDigest(`capacity-evaluator:${marker}`),
          actorSelfReportEligible: false,
        },
        partition: {
          kind: "unavailable",
          reason: "matchedPartitionUnavailable",
          evidenceDigest: fixtureDigest(`capacity-partition:${marker}`),
        },
        providerTokens: {
          kind: "unavailable",
          reason: "effectNotStarted",
          evidenceDigest: fixtureDigest(`capacity-tokens:${marker}`),
        },
        elapsed: {
          kind: "unavailable",
          reason: "effectNotStarted",
          evidenceDigest: fixtureDigest(`capacity-elapsed:${marker}`),
        },
      });
    });
    expect(evaluateFixture(fixture, { outcomes })).toMatchObject({
      kind: "inconclusive",
      reasons: [
        "elapsedEvidenceMissing",
        "providerTokenEvidenceMissing",
      ],
      metrics: null,
    });
  });

  test("requires evaluator inputs as well as review to remain blinded", () => {
    const fixture = makePassingOptimizerGateFixture();
    const original = fixture.outcomes[0]!;
    if (original.evaluation.kind !== "settled") {
      throw new Error("passing fixture lost settled evaluation evidence");
    }
    expect(optimizerArmOutcomeSchema.safeParse({
      ...original,
      evaluation: {
        ...original.evaluation,
        evaluatorInputsBlindedToArm: false,
      },
    }).success).toBeFalse();
    expect(optimizerArmOutcomeSchema.safeParse({
      ...original,
      evaluation: {
        ...original.evaluation,
        validatorInputsBlindedToUsage: false,
      },
    }).success).toBeFalse();
  });

  test("seals duplicate logical cells independently of input order", () => {
    const fixture = makePassingOptimizerGateFixture();
    const original = fixture.outcomes[0]!;
    const duplicate = optimizerArmOutcomeSchema.parse({
      ...original,
      safety: {
        kind: "violation",
        reason: "securityViolation",
        evidenceDigest: fixtureDigest("duplicate-safety"),
      },
    });
    const appended = evaluateFixture(fixture, {
      outcomes: [...fixture.outcomes, duplicate],
    });
    const prepended = evaluateFixture(fixture, {
      outcomes: [duplicate, ...fixture.outcomes],
    });
    expect(appended.kind).toBe("contained");
    expect(prepended).toEqual(appended);
  });

  test("seals conflicting duplicate assignments independently of input order", () => {
    const fixture = makePassingOptimizerGateFixture();
    const original = fixture.assignments[0]!;
    const { assignmentDigest: originalDigest, ...payload } = original;
    expect(originalDigest).toBe(original.assignmentDigest);
    const conflictingPayload = {
      ...payload,
      candidatePartitionDigest: fixtureDigest("third-partition"),
    };
    const conflicting = {
      ...conflictingPayload,
      assignmentDigest: digestOptimizerPairAssignmentPayload(
        conflictingPayload,
      ),
    };
    const appended = evaluateFixture(fixture, {
      assignments: [...fixture.assignments, conflicting],
    });
    const prepended = evaluateFixture(fixture, {
      assignments: [conflicting, ...fixture.assignments],
    });
    expect(appended.kind).toBe("contained");
    expect(appended.reasons).toContain("assignmentDuplicate");
    expect(prepended).toEqual(appended);
  });

  test("makes missing resources and zero denominators inconclusive", () => {
    const fixture = makePassingOptimizerGateFixture();
    const first = fixture.outcomes[0]!;
    let outcomes = [
      optimizerArmOutcomeSchema.parse({
        ...first,
        elapsed: {
          kind: "unavailable",
          reason: "restartSpanning",
          evidenceDigest: fixtureDigest("restart-spanning"),
        },
      }),
      ...fixture.outcomes.slice(1),
    ];
    expect(evaluateFixture(fixture, { outcomes })).toMatchObject({
      kind: "inconclusive",
      reasons: ["elapsedEvidenceMissing"],
    });

    outcomes = fixture.outcomes.map((outcome) =>
      outcome.arm === "control"
        ? optimizerArmOutcomeSchema.parse({
            ...outcome,
            providerTokens: {
              kind: "exact",
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
              totalTokens: 0,
            },
          })
        : outcome
    );
    expect(evaluateFixture(fixture, { outcomes })).toMatchObject({
      kind: "inconclusive",
      reasons: ["zeroControlProviderTokens"],
    });
  });

  test("uses exact bigint aggregation and rejects unsafe or double-counted tokens", () => {
    expect(optimizerProviderTokensSchema.safeParse({
      kind: "exact",
      inputTokens: Number.MAX_SAFE_INTEGER,
      cachedInputTokens: 0,
      outputTokens: 1,
      reasoningOutputTokens: 0,
      totalTokens: Number.MAX_SAFE_INTEGER,
    }).success).toBeFalse();
    expect(optimizerProviderTokensSchema.safeParse({
      kind: "exact",
      inputTokens: 80,
      cachedInputTokens: 20,
      outputTokens: 20,
      reasoningOutputTokens: 10,
      totalTokens: 130,
    }).success).toBeFalse();

    const fixture = makePassingOptimizerGateFixture({
      elapsedMillisecondsCap: 2_000,
    });
    const outcomes = fixture.outcomes.map((outcome) =>
      outcome.arm === "candidate"
        ? optimizerArmOutcomeSchema.parse({
            ...outcome,
            providerTokens: {
              kind: "exact",
              inputTokens: 160,
              cachedInputTokens: 20,
              outputTokens: 40,
              reasoningOutputTokens: 10,
              totalTokens: 200,
            },
            elapsed: {
              ...outcome.elapsed,
              milliseconds: 2_000,
            },
          })
        : outcome
    );
    expect(evaluateFixture(fixture, { outcomes })).toMatchObject({
      kind: "failed",
      reasons: ["elapsedHarmExceeded", "providerTokenHarmExceeded"],
      metrics: {
        providerTokenHarm: { passes: false },
        elapsedHarm: { passes: false },
      },
    });

    const largeFixture = makePassingOptimizerGateFixture({
      providerTokenCap: Number.MAX_SAFE_INTEGER,
    });
    const largeOutcomes = largeFixture.outcomes.map((outcome) =>
      optimizerArmOutcomeSchema.parse({
        ...outcome,
        providerTokens: outcome.arm === "candidate"
          ? {
              kind: "exact",
              inputTokens: Number.MAX_SAFE_INTEGER,
              cachedInputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
              totalTokens: Number.MAX_SAFE_INTEGER,
            }
          : {
              kind: "exact",
              inputTokens: 1,
              cachedInputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
              totalTokens: 1,
            },
      })
    );
    expect(evaluateFixture(largeFixture, {
      outcomes: largeOutcomes,
    })).toMatchObject({
      kind: "failed",
      reasons: ["providerTokenHarmExceeded"],
      metrics: {
        providerTokenHarm: {
          observedBasisPointsFloor:
            (BigInt(Number.MAX_SAFE_INTEGER) * 10_000n).toString(),
          passes: false,
        },
      },
    });
  });
});
