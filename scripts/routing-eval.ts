// Evaluates one explicitly named, content-free paired-routing study export.
//
//   bun ./scripts/routing-eval.ts --input /absolute/path/evaluation.json
//
// This analyzer does not discover files, run providers, infer prices, mutate
// routing, or emit pair identifiers and environment bindings.

import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { z } from "zod";

const SHA_256_DIGEST = /^[0-9a-f]{64}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HMAC_SHA_256_BINDING = /^hmac-sha256:[0-9a-f]{64}$/u;

export const ROUTING_EVAL_MAX_BYTES = 32 * 1_024 * 1_024;
export const ROUTING_EVAL_MAX_PAIRS = 4_096;
export const ROUTING_EVAL_PILOT_MINIMUM_PAIRS = 40;
export const ROUTING_EVAL_HOLDOUT_MINIMUM_PAIRS = 200;
export const ROUTING_EVAL_NON_INFERIORITY_MARGIN = 0.05;
export const ROUTING_EVAL_FAST_RATIO_TARGET = 0.9;

const routingEvaluationComparisonV1Schema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("terra_vs_sol"),
      baseline: z.literal("codex_sol_ultra"),
      candidate: z.literal("codex_terra_ultra"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("opus_vs_fable"),
      baseline: z.literal("claude_fable_max"),
      candidate: z.literal("claude_opus"),
      candidateEffort: z.enum(["high", "xhigh", "max"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("fast_vs_standard"),
      profile: z.literal("terra"),
      baselineFast: z.literal(false),
      candidateFast: z.literal(true),
    })
    .strict(),
]);

/** Current evaluation comparisons. Schema v1 remains an exact historical Sol decoder. */
export const routingEvaluationComparisonSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("terra_vs_astra"),
      baseline: z.literal("codex_astra_ultra"),
      candidate: z.literal("codex_terra_ultra"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("opus_vs_fable"),
      baseline: z.literal("claude_fable_max"),
      candidate: z.literal("claude_opus"),
      candidateEffort: z.enum(["high", "xhigh", "max"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("fast_vs_standard"),
      profile: z.literal("terra"),
      baselineFast: z.literal(false),
      candidateFast: z.literal(true),
    })
    .strict(),
]);
export type RoutingEvaluationComparison = z.infer<
  typeof routingEvaluationComparisonSchema
>;

export const routingEvaluationDesignSchema = z
  .object({
    paired: z.literal(true),
    randomizedOrder: z.literal(true),
    exactRepositoryTree: z.literal(true),
    equalTools: z.literal(true),
    equalPermissions: z.literal(true),
    declaredEffectClass: z.literal(true),
    providerNativeUsageCaptured: z.literal(true),
  })
  .strict();

export const routingEvaluationUsageSchema = z
  .object({
    inputTokens: z.number().int().min(0).max(1_000_000_000),
    outputTokens: z.number().int().min(0).max(1_000_000_000),
    cacheReadInputTokens: z.number().int().min(0).max(1_000_000_000),
    cacheWriteInputTokens: z.number().int().min(0).max(1_000_000_000),
  })
  .strict();
export type RoutingEvaluationUsage = z.infer<
  typeof routingEvaluationUsageSchema
>;

export const routingEvaluationOutcomeSchema = z
  .object({
    terminal: z.enum([
      "completed",
      "failed",
      "timeout",
      "infrastructure_invalid",
    ]),
    repair: z.enum(["none", "human_repair"]),
    safety: z.enum(["clean", "violation"]),
    wallClockMilliseconds: z.number().int().positive().max(604_800_000),
    providerNativeUsage: routingEvaluationUsageSchema,
  })
  .strict();
export type RoutingEvaluationOutcome = z.infer<
  typeof routingEvaluationOutcomeSchema
>;

export const routingEvaluationPairSchema = z
  .object({
    pairId: z.string().regex(UUID_V4, "pairId must be a lowercase UUIDv4"),
    environmentBinding: z
      .string()
      .regex(
        HMAC_SHA_256_BINDING,
        "environmentBinding must be an HMAC-SHA-256-shaped value",
      ),
    order: z.enum(["baseline_first", "candidate_first"]),
    baseline: routingEvaluationOutcomeSchema,
    candidate: routingEvaluationOutcomeSchema,
  })
  .strict();
export type RoutingEvaluationPair = z.infer<
  typeof routingEvaluationPairSchema
>;

/** Binds an export to the exact ordered set of opaque evaluation case ids. */
export function routingEvaluationCaseSetDigest(
  pairs: readonly Pick<
    RoutingEvaluationPair,
    "pairId" | "environmentBinding"
  >[],
): string {
  return createHash("sha256")
    .update("hra-routing-evaluation-case-set-v1\0", "utf8")
    .update(
      JSON.stringify(
        pairs.map(({ pairId, environmentBinding }) => ({
          pairId,
          environmentBinding,
        })),
      ),
      "utf8",
    )
    .digest("hex");
}

const routingEvaluationInputTailShape = {
    taskShape: z.literal("well_defined"),
    caseSetDigest: z.string().regex(SHA_256_DIGEST),
    preregistrationDigest: z.string().regex(SHA_256_DIGEST).nullable(),
    design: routingEvaluationDesignSchema,
    pairs: z
      .array(routingEvaluationPairSchema)
      .min(2)
      .max(ROUTING_EVAL_MAX_PAIRS),
} as const;

export const routingEvaluationInputSchema = z
  .discriminatedUnion("schemaVersion", [
    z.object({
      schemaVersion: z.literal(1),
      study: z.enum(["pilot", "holdout"]),
      comparison: routingEvaluationComparisonV1Schema,
      ...routingEvaluationInputTailShape,
    }).strict(),
    z.object({
      schemaVersion: z.literal(2),
      study: z.enum(["pilot", "holdout"]),
      comparison: routingEvaluationComparisonSchema,
      ...routingEvaluationInputTailShape,
    }).strict(),
  ])
  .superRefine((input, context) => {
    const pairIds = new Set<string>();
    const bindings = new Set<string>();
    let baselineFirst = 0;
    let candidateFirst = 0;
    let priorPairId: string | undefined;

    for (const [index, pair] of input.pairs.entries()) {
      if (pairIds.has(pair.pairId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "pairId values must be unique",
          path: ["pairs", index, "pairId"],
        });
      }
      pairIds.add(pair.pairId);

      if (bindings.has(pair.environmentBinding)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "environment bindings must be unique",
          path: ["pairs", index, "environmentBinding"],
        });
      }
      bindings.add(pair.environmentBinding);

      if (priorPairId !== undefined && pair.pairId <= priorPairId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "pairs must be ordered by ascending pairId",
          path: ["pairs", index, "pairId"],
        });
      }
      priorPairId = pair.pairId;

      if (pair.order === "baseline_first") baselineFirst += 1;
      else candidateFirst += 1;
    }

    if (baselineFirst !== candidateFirst) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "baseline-first and candidate-first order must be balanced",
        path: ["pairs"],
      });
    }

    const expectedCaseSetDigest = routingEvaluationCaseSetDigest(input.pairs);
    if (input.caseSetDigest !== expectedCaseSetDigest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "caseSetDigest must bind the ordered pairId set",
        path: ["caseSetDigest"],
      });
    }
  });
export type RoutingEvaluationInput = z.infer<
  typeof routingEvaluationInputSchema
>;

const countSchema = z.number().int().min(0).max(ROUTING_EVAL_MAX_PAIRS * 2);
const rateSchema = z.number().min(0).max(1);
const differenceSchema = z.number().min(-1).max(1);

const routingEvaluationReportBlockerSchema = z.enum([
  "pilot_only",
  "pilot_sample_below_40",
  "holdout_sample_below_200",
  "preregistration_missing",
  "preregistration_chronology_unverified",
  "capability_not_assessed",
  "infrastructure_invalid",
  "candidate_safety_violation",
  "quality_non_inferiority_failed",
  "fast_latency_target_failed",
  "price_evidence_missing",
  "phase_3_shadow_only",
]);

const usageTotalCounterSchema = z
  .number()
  .int()
  .min(0)
  .max(ROUTING_EVAL_MAX_PAIRS * 1_000_000_000);
const usageTotalsSchema = z
  .object({
    inputTokens: usageTotalCounterSchema,
    outputTokens: usageTotalCounterSchema,
    cacheReadInputTokens: usageTotalCounterSchema,
    cacheWriteInputTokens: usageTotalCounterSchema,
  })
  .strict();

const routingEvaluationReportTailShape = {
    taskShape: z.literal("well_defined"),
    caseSetDigest: z.string().regex(SHA_256_DIGEST),
    preregistrationDigest: z.string().regex(SHA_256_DIGEST).nullable(),
    counts: z
      .object({
        pairs: countSchema,
        baselineFirst: countSchema,
        candidateFirst: countSchema,
        baselinePasses: countSchema,
        candidatePasses: countSchema,
        baselineTimeouts: countSchema,
        candidateTimeouts: countSchema,
        baselineRepairs: countSchema,
        candidateRepairs: countSchema,
        baselineSafetyViolations: countSchema,
        candidateSafetyViolations: countSchema,
        infrastructureInvalidPairs: countSchema,
        discordantBaselineOnlyPasses: countSchema,
        discordantCandidateOnlyPasses: countSchema,
      })
      .strict(),
    quality: z
      .object({
        baselinePassRate: rateSchema,
        candidatePassRate: rateSchema,
        pairedDifference: differenceSchema,
        conservativePaired95Interval: z
          .object({ lower: differenceSchema, upper: differenceSchema })
          .strict(),
        nonInferiorityMargin: z.literal(
          ROUTING_EVAL_NON_INFERIORITY_MARGIN,
        ),
        nonInferiorityMet: z.boolean(),
      })
      .strict(),
    latency: z
      .object({
        required: z.boolean(),
        method: z.literal("paired_log_ratio_student_t"),
        assumption: z.literal("independent_approximately_normal_log_ratios"),
        geometricWallClockRatio: z.number().positive().nullable(),
        oneSided95UpperBound: z.number().positive().nullable(),
        criticalValue: z.number().positive().nullable(),
        maximumAllowedUpperBound: z.literal(ROUTING_EVAL_FAST_RATIO_TARGET),
        targetMet: z.boolean(),
      })
      .strict(),
    usageTotals: z
      .object({
        baseline: usageTotalsSchema,
        candidate: usageTotalsSchema,
      })
      .strict(),
    gates: z
      .object({
        minimumPairCount: z.union([
          z.literal(ROUTING_EVAL_PILOT_MINIMUM_PAIRS),
          z.literal(ROUTING_EVAL_HOLDOUT_MINIMUM_PAIRS),
        ]),
        minimumPairCountMet: z.boolean(),
        holdoutInfrastructureValid: z.boolean(),
        candidateSafetyClear: z.boolean(),
        qualityNonInferiorityMet: z.boolean(),
        fastLatencyTargetMet: z.boolean(),
        economicsResolved: z.literal(false),
        activationLicensed: z.literal(false),
      })
      .strict(),
    economics: z.literal("unresolved_price_evidence_missing"),
    capabilityProof: z.literal("not_assessed"),
    preregistrationChronology: z.literal("externally_unverified"),
    liveRouting: z.literal("forbidden_phase_3_shadow_only"),
    decision: z.literal("no_activation"),
    blockers: z.array(routingEvaluationReportBlockerSchema),
} as const;

export const routingEvaluationReportSchema = z.discriminatedUnion(
  "schemaVersion",
  [
    z.object({
      schemaVersion: z.literal(1),
      mode: z.literal("shadow"),
      study: z.enum(["pilot", "holdout"]),
      comparison: routingEvaluationComparisonV1Schema,
      ...routingEvaluationReportTailShape,
    }).strict(),
    z.object({
      schemaVersion: z.literal(2),
      mode: z.literal("shadow"),
      study: z.enum(["pilot", "holdout"]),
      comparison: routingEvaluationComparisonSchema,
      ...routingEvaluationReportTailShape,
    }).strict(),
  ],
);
export type RoutingEvaluationReport = z.infer<
  typeof routingEvaluationReportSchema
>;

type WilsonInterval = Readonly<{ lower: number; upper: number }>;

function wilsonInterval(
  successes: number,
  total: number,
  zScore: number,
): WilsonInterval {
  const proportion = successes / total;
  const zSquared = zScore * zScore;
  const denominator = 1 + zSquared / total;
  const center = (proportion + zSquared / (2 * total)) / denominator;
  const radius =
    (zScore / denominator) *
    Math.sqrt(
      (proportion * (1 - proportion)) / total +
        zSquared / (4 * total * total),
    );
  return {
    lower: Math.max(0, center - radius),
    upper: Math.min(1, center + radius),
  };
}

function passed(outcome: RoutingEvaluationOutcome): boolean {
  return (
    outcome.terminal === "completed" &&
    outcome.repair === "none" &&
    outcome.safety === "clean"
  );
}

function emptyUsage(): RoutingEvaluationUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
  };
}

function addUsage(
  total: RoutingEvaluationUsage,
  usage: RoutingEvaluationUsage,
): void {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.cacheReadInputTokens += usage.cacheReadInputTokens;
  total.cacheWriteInputTokens += usage.cacheWriteInputTokens;
}

// NIST 0.95 one-sided Student-t critical values, rounded upward by 0.001.
// Values above the table breakpoints deliberately reuse the lower degree of
// freedom, which is conservative because the critical value decreases with df.
const ONE_SIDED_95_STUDENT_T_CRITICAL_UPPER = [
  6.315, 2.921, 2.354, 2.133, 2.016, 1.944, 1.896, 1.861, 1.834, 1.813,
  1.797, 1.783, 1.772, 1.762, 1.754, 1.747, 1.741, 1.735, 1.73, 1.726,
  1.722, 1.718, 1.715, 1.712, 1.709, 1.707, 1.704, 1.702, 1.7, 1.698,
] as const;

function conservativeOneSided95StudentTCritical(
  degreesOfFreedom: number,
): number {
  if (degreesOfFreedom <= 30) {
    const criticalValue =
      ONE_SIDED_95_STUDENT_T_CRITICAL_UPPER[degreesOfFreedom - 1];
    if (criticalValue === undefined) {
      throw new Error("a Fast study requires at least two pairs");
    }
    return criticalValue;
  }
  if (degreesOfFreedom <= 40) return 1.698;
  if (degreesOfFreedom <= 60) return 1.685;
  if (degreesOfFreedom <= 80) return 1.672;
  if (degreesOfFreedom <= 100) return 1.665;
  return 1.661;
}

function geometricRatioBounds(
  pairs: readonly RoutingEvaluationPair[],
): Readonly<{ ratio: number; upper: number; criticalValue: number }> {
  const logRatios = pairs.map((pair) =>
    Math.log(
      pair.candidate.wallClockMilliseconds /
        pair.baseline.wallClockMilliseconds,
    ),
  );
  const mean =
    logRatios.reduce((total, value) => total + value, 0) / logRatios.length;
  const squaredError = logRatios.reduce(
    (total, value) => total + (value - mean) ** 2,
    0,
  );
  const sampleDeviation = Math.sqrt(squaredError / (logRatios.length - 1));
  const criticalValue = conservativeOneSided95StudentTCritical(
    logRatios.length - 1,
  );
  return {
    ratio: Math.exp(mean),
    upper: Math.exp(
      mean +
        criticalValue * (sampleDeviation / Math.sqrt(logRatios.length)),
    ),
    criticalValue,
  };
}

/** Builds a content-free statistical report. It can never license routing. */
export function analyzeRoutingEvaluation(input: unknown): RoutingEvaluationReport {
  const parsed = routingEvaluationInputSchema.parse(input);
  let baselineFirst = 0;
  let baselinePasses = 0;
  let candidatePasses = 0;
  let baselineTimeouts = 0;
  let candidateTimeouts = 0;
  let baselineRepairs = 0;
  let candidateRepairs = 0;
  let baselineSafetyViolations = 0;
  let candidateSafetyViolations = 0;
  let infrastructureInvalidPairs = 0;
  let discordantBaselineOnlyPasses = 0;
  let discordantCandidateOnlyPasses = 0;
  const baselineUsage = emptyUsage();
  const candidateUsage = emptyUsage();

  for (const pair of parsed.pairs) {
    if (pair.order === "baseline_first") baselineFirst += 1;
    const baselinePassed = passed(pair.baseline);
    const candidatePassed = passed(pair.candidate);
    if (baselinePassed) baselinePasses += 1;
    if (candidatePassed) candidatePasses += 1;
    if (baselinePassed && !candidatePassed) discordantBaselineOnlyPasses += 1;
    if (!baselinePassed && candidatePassed) discordantCandidateOnlyPasses += 1;
    if (pair.baseline.terminal === "timeout") baselineTimeouts += 1;
    if (pair.candidate.terminal === "timeout") candidateTimeouts += 1;
    if (pair.baseline.repair !== "none") baselineRepairs += 1;
    if (pair.candidate.repair !== "none") candidateRepairs += 1;
    if (pair.baseline.safety === "violation") baselineSafetyViolations += 1;
    if (pair.candidate.safety === "violation") candidateSafetyViolations += 1;
    if (
      pair.baseline.terminal === "infrastructure_invalid" ||
      pair.candidate.terminal === "infrastructure_invalid"
    ) {
      infrastructureInvalidPairs += 1;
    }
    addUsage(baselineUsage, pair.baseline.providerNativeUsage);
    addUsage(candidateUsage, pair.candidate.providerNativeUsage);
  }

  const totalPairs = parsed.pairs.length;
  const candidateOnlyInterval = wilsonInterval(
    discordantCandidateOnlyPasses,
    totalPairs,
    1.959963984540054,
  );
  const baselineOnlyInterval = wilsonInterval(
    discordantBaselineOnlyPasses,
    totalPairs,
    1.959963984540054,
  );
  const conservativeLower =
    candidateOnlyInterval.lower - baselineOnlyInterval.upper;
  const conservativeUpper =
    candidateOnlyInterval.upper - baselineOnlyInterval.lower;
  const nonInferiorityMet =
    conservativeLower >= -ROUTING_EVAL_NON_INFERIORITY_MARGIN;
  const fastRequired = parsed.comparison.kind === "fast_vs_standard";
  const latencyBounds = fastRequired
    ? geometricRatioBounds(parsed.pairs)
    : undefined;
  const latencyTargetMet =
    latencyBounds !== undefined &&
    latencyBounds.upper <= ROUTING_EVAL_FAST_RATIO_TARGET;
  const minimumPairCount =
    parsed.study === "pilot"
      ? ROUTING_EVAL_PILOT_MINIMUM_PAIRS
      : ROUTING_EVAL_HOLDOUT_MINIMUM_PAIRS;
  const minimumPairCountMet = totalPairs >= minimumPairCount;
  const holdoutInfrastructureValid =
    parsed.study !== "holdout" || infrastructureInvalidPairs === 0;
  const candidateSafetyClear = candidateSafetyViolations === 0;

  const blockers: z.infer<typeof routingEvaluationReportBlockerSchema>[] = [];
  if (parsed.study === "pilot") blockers.push("pilot_only");
  if (
    parsed.study === "pilot" &&
    totalPairs < ROUTING_EVAL_PILOT_MINIMUM_PAIRS
  ) {
    blockers.push("pilot_sample_below_40");
  }
  if (
    parsed.study === "holdout" &&
    totalPairs < ROUTING_EVAL_HOLDOUT_MINIMUM_PAIRS
  ) {
    blockers.push("holdout_sample_below_200");
  }
  if (parsed.preregistrationDigest === null) {
    blockers.push("preregistration_missing");
  }
  blockers.push("preregistration_chronology_unverified");
  blockers.push("capability_not_assessed");
  if (!holdoutInfrastructureValid) blockers.push("infrastructure_invalid");
  if (!candidateSafetyClear) blockers.push("candidate_safety_violation");
  if (!nonInferiorityMet) blockers.push("quality_non_inferiority_failed");
  if (fastRequired && !latencyTargetMet) {
    blockers.push("fast_latency_target_failed");
  }
  if (fastRequired) blockers.push("price_evidence_missing");
  blockers.push("phase_3_shadow_only");

  return routingEvaluationReportSchema.parse({
    schemaVersion: parsed.schemaVersion,
    mode: "shadow",
    study: parsed.study,
    comparison: { ...parsed.comparison },
    taskShape: parsed.taskShape,
    caseSetDigest: parsed.caseSetDigest,
    preregistrationDigest: parsed.preregistrationDigest,
    counts: {
      pairs: totalPairs,
      baselineFirst,
      candidateFirst: totalPairs - baselineFirst,
      baselinePasses,
      candidatePasses,
      baselineTimeouts,
      candidateTimeouts,
      baselineRepairs,
      candidateRepairs,
      baselineSafetyViolations,
      candidateSafetyViolations,
      infrastructureInvalidPairs,
      discordantBaselineOnlyPasses,
      discordantCandidateOnlyPasses,
    },
    quality: {
      baselinePassRate: baselinePasses / totalPairs,
      candidatePassRate: candidatePasses / totalPairs,
      pairedDifference: (candidatePasses - baselinePasses) / totalPairs,
      conservativePaired95Interval: {
        lower: conservativeLower,
        upper: conservativeUpper,
      },
      nonInferiorityMargin: ROUTING_EVAL_NON_INFERIORITY_MARGIN,
      nonInferiorityMet,
    },
    latency: {
      required: fastRequired,
      method: "paired_log_ratio_student_t",
      assumption: "independent_approximately_normal_log_ratios",
      geometricWallClockRatio: latencyBounds?.ratio ?? null,
      oneSided95UpperBound: latencyBounds?.upper ?? null,
      criticalValue: latencyBounds?.criticalValue ?? null,
      maximumAllowedUpperBound: ROUTING_EVAL_FAST_RATIO_TARGET,
      targetMet: fastRequired ? latencyTargetMet : false,
    },
    usageTotals: {
      baseline: baselineUsage,
      candidate: candidateUsage,
    },
    gates: {
      minimumPairCount,
      minimumPairCountMet,
      holdoutInfrastructureValid,
      candidateSafetyClear,
      qualityNonInferiorityMet: nonInferiorityMet,
      fastLatencyTargetMet: fastRequired ? latencyTargetMet : false,
      economicsResolved: false,
      activationLicensed: false,
    },
    economics: "unresolved_price_evidence_missing",
    capabilityProof: "not_assessed",
    preregistrationChronology: "externally_unverified",
    liveRouting: "forbidden_phase_3_shadow_only",
    decision: "no_activation",
    blockers,
  });
}

export function parseRoutingEvaluationArguments(
  argv: readonly string[],
): string {
  if (
    argv.length !== 2 ||
    argv[0] !== "--input" ||
    argv[1] === undefined ||
    !isAbsolute(argv[1])
  ) {
    throw new Error(
      "usage: bun ./scripts/routing-eval.ts --input <absolute-json-path>",
    );
  }
  return argv[1];
}

async function readExplicitEvaluation(inputPath: string): Promise<unknown> {
  const handle = await open(
    inputPath,
    constants.O_RDONLY |
      constants.O_NONBLOCK |
      constants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > ROUTING_EVAL_MAX_BYTES) {
      throw new Error("input is not one bounded regular file");
    }
    const bytes = Buffer.alloc(ROUTING_EVAL_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
    if (bytesRead > ROUTING_EVAL_MAX_BYTES) {
      throw new Error("input exceeds the byte limit");
    }
    if (bytesRead !== metadata.size) {
      throw new Error("input changed or was not read completely");
    }
    const source = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, bytesRead),
    );
    return JSON.parse(source) as unknown;
  } finally {
    await handle.close();
  }
}

if (import.meta.main) {
  try {
    const inputPath = parseRoutingEvaluationArguments(process.argv.slice(2));
    const input = await readExplicitEvaluation(inputPath);
    const report = analyzeRoutingEvaluation(input);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    const message =
      error instanceof Error && error.message.startsWith("usage:")
        ? error.message
        : "routing evaluation rejected";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
