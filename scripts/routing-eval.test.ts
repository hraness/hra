import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ROUTING_EVAL_FAST_RATIO_TARGET,
  ROUTING_EVAL_HOLDOUT_MINIMUM_PAIRS,
  ROUTING_EVAL_NON_INFERIORITY_MARGIN,
  ROUTING_EVAL_PILOT_MINIMUM_PAIRS,
  analyzeRoutingEvaluation,
  parseRoutingEvaluationArguments,
  routingEvaluationCaseSetDigest,
  routingEvaluationInputSchema,
  routingEvaluationReportSchema,
  type RoutingEvaluationInput,
  type RoutingEvaluationOutcome,
} from "./routing-eval";

const PREREGISTRATION_DIGEST = "b".repeat(64);
const temporaryDirectories: string[] = [];

function outcome(
  overrides: Partial<RoutingEvaluationOutcome> = {},
): RoutingEvaluationOutcome {
  return {
    terminal: "completed",
    repair: "none",
    safety: "clean",
    wallClockMilliseconds: 100,
    providerNativeUsage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 2,
      cacheWriteInputTokens: 1,
    },
    ...overrides,
  };
}

type RoutingEvaluationInputV2 = Extract<
  RoutingEvaluationInput,
  { schemaVersion: 2 }
>;

function evaluation(
  pairCount: number,
  overrides: Partial<RoutingEvaluationInputV2> = {},
): RoutingEvaluationInputV2 {
  const pairs = Array.from({ length: pairCount }, (_, index) => ({
    pairId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    environmentBinding: `hmac-sha256:${(index + 1)
      .toString(16)
      .padStart(64, "0")}`,
    order: index % 2 === 0 ? "baseline_first" : "candidate_first",
    baseline: outcome(),
    candidate: outcome(),
  })) as RoutingEvaluationInput["pairs"];
  return {
    schemaVersion: 2,
    study: "holdout",
    comparison: {
      kind: "terra_vs_astra",
      baseline: "codex_astra_ultra",
      candidate: "codex_terra_ultra",
    },
    taskShape: "well_defined",
    caseSetDigest: routingEvaluationCaseSetDigest(pairs),
    preregistrationDigest: PREREGISTRATION_DIGEST,
    design: {
      paired: true,
      randomizedOrder: true,
      exactRepositoryTree: true,
      equalTools: true,
      equalPermissions: true,
      declaredEffectClass: true,
      providerNativeUsageCaptured: true,
    },
    pairs,
    ...overrides,
  };
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("routing evaluation input", () => {
  test("accepts only the three closed comparison families", () => {
    for (const comparison of [
      {
        kind: "terra_vs_astra",
        baseline: "codex_astra_ultra",
        candidate: "codex_terra_ultra",
      },
      {
        kind: "opus_vs_fable",
        baseline: "claude_fable_max",
        candidate: "claude_opus",
        candidateEffort: "xhigh",
      },
      {
        kind: "fast_vs_standard",
        profile: "terra",
        baselineFast: false,
        candidateFast: true,
      },
    ] as const) {
      expect(
        routingEvaluationInputSchema.safeParse(
          evaluation(2, { comparison }),
        ).success,
      ).toBe(true);
    }
  });

  test.each([
    { privateTaskText: "must never enter an export" },
    { schemaVersion: 3 },
    { taskShape: "mechanical" },
    { design: { ...evaluation(2).design, paired: false } },
    { caseSetDigest: "not-a-digest" },
    {
      comparison: {
        kind: "terra_vs_astra",
        baseline: "codex_terra_ultra",
        candidate: "codex_astra_ultra",
      },
    },
    {
      comparison: {
        kind: "fast_vs_standard",
        profile: "sol",
        baselineFast: false,
        candidateFast: true,
      },
    },
  ])("rejects unknown or non-preregistered structure %#", (override) => {
    expect(
      routingEvaluationInputSchema.safeParse({
        ...evaluation(2),
        ...override,
      }).success,
    ).toBe(false);
  });

  test("preserves schema v1 as an exact historical Sol comparison", () => {
    const historical = {
      ...evaluation(2),
      schemaVersion: 1 as const,
      comparison: {
        kind: "terra_vs_sol" as const,
        baseline: "codex_sol_ultra" as const,
        candidate: "codex_terra_ultra" as const,
      },
    };
    const parsedHistorical = routingEvaluationInputSchema.parse(historical);
    expect(Object.keys(parsedHistorical).slice(0, 4)).toEqual([
      "schemaVersion",
      "study",
      "comparison",
      "taskShape",
    ]);
    const historicalReport = analyzeRoutingEvaluation(historical);
    expect(historicalReport.schemaVersion).toBe(1);
    expect(Object.keys(historicalReport).slice(0, 5)).toEqual([
      "schemaVersion",
      "mode",
      "study",
      "comparison",
      "taskShape",
    ]);

    expect(routingEvaluationInputSchema.safeParse({
      ...historical,
      comparison: evaluation(2).comparison,
    }).success).toBe(false);
    expect(routingEvaluationInputSchema.safeParse({
      ...evaluation(2),
      comparison: historical.comparison,
    }).success).toBe(false);
  });

  test("requires unique ordered UUID pairs, unique HMAC bindings, and balanced order", () => {
    const unordered = evaluation(2);
    unordered.pairs.reverse();
    expect(routingEvaluationInputSchema.safeParse(unordered).success).toBe(false);

    const duplicateBinding = evaluation(2);
    duplicateBinding.pairs[1]!.environmentBinding =
      duplicateBinding.pairs[0]!.environmentBinding;
    expect(
      routingEvaluationInputSchema.safeParse(duplicateBinding).success,
    ).toBe(false);

    const unbalanced = evaluation(2);
    unbalanced.pairs[1]!.order = "baseline_first";
    expect(routingEvaluationInputSchema.safeParse(unbalanced).success).toBe(
      false,
    );
  });

  test("requires the case-set digest to bind exact ordered ids and environments", () => {
    const changed = evaluation(2);
    changed.pairs[1]!.pairId = "00000000-0000-4000-8000-000000000003";

    expect(routingEvaluationInputSchema.safeParse(changed).success).toBe(false);
    expect(
      routingEvaluationInputSchema.safeParse({
        ...changed,
        caseSetDigest: routingEvaluationCaseSetDigest(changed.pairs),
      }).success,
    ).toBe(true);

    const changedEnvironment = evaluation(2);
    changedEnvironment.pairs[1]!.environmentBinding =
      `hmac-sha256:${"c".repeat(64)}`;
    expect(
      routingEvaluationInputSchema.safeParse(changedEnvironment).success,
    ).toBe(false);
  });
});

describe("routing evaluation report", () => {
  test("keeps a complete pilot shadow-only at the pilot floor", () => {
    const report = analyzeRoutingEvaluation(
      evaluation(ROUTING_EVAL_PILOT_MINIMUM_PAIRS, {
        study: "pilot",
        preregistrationDigest: null,
      }),
    );

    expect(report.gates.minimumPairCount).toBe(
      ROUTING_EVAL_PILOT_MINIMUM_PAIRS,
    );
    expect(report.gates.minimumPairCountMet).toBe(true);
    expect(report.gates.activationLicensed).toBe(false);
    expect(report.blockers).toContain("pilot_only");
    expect(report.blockers).toContain("preregistration_missing");
    expect(report.capabilityProof).toBe("not_assessed");
    expect(report.preregistrationChronology).toBe("externally_unverified");
    expect(report.liveRouting).toBe("forbidden_phase_3_shadow_only");
    expect(routingEvaluationReportSchema.parse(report)).toEqual(report);
  });

  test("does not confuse the pilot floor with the holdout minimum", () => {
    const report = analyzeRoutingEvaluation(
      evaluation(ROUTING_EVAL_PILOT_MINIMUM_PAIRS),
    );

    expect(report.gates.minimumPairCount).toBe(
      ROUTING_EVAL_HOLDOUT_MINIMUM_PAIRS,
    );
    expect(report.gates.minimumPairCountMet).toBe(false);
    expect(report.blockers).toContain("holdout_sample_below_200");
    expect(report.gates.activationLicensed).toBe(false);
  });

  test("uses paired discordances and a conservative Wilson-derived interval", () => {
    const input = evaluation(ROUTING_EVAL_HOLDOUT_MINIMUM_PAIRS);
    input.pairs[0]!.candidate = outcome({ terminal: "timeout" });
    input.pairs[1]!.baseline = outcome({ terminal: "failed" });
    const report = analyzeRoutingEvaluation(input);

    expect(report.counts.candidateTimeouts).toBe(1);
    expect(report.counts.discordantBaselineOnlyPasses).toBe(1);
    expect(report.counts.discordantCandidateOnlyPasses).toBe(1);
    expect(report.quality.pairedDifference).toBe(0);
    expect(report.quality.conservativePaired95Interval.lower).toBeLessThan(
      0,
    );
    expect(report.quality.conservativePaired95Interval.upper).toBeGreaterThan(
      0,
    );
    expect(report.quality.nonInferiorityMargin).toBe(
      ROUTING_EVAL_NON_INFERIORITY_MARGIN,
    );
  });

  test("invalidates a holdout on either infrastructure-invalid outcome", () => {
    const input = evaluation(ROUTING_EVAL_HOLDOUT_MINIMUM_PAIRS);
    input.pairs[0]!.baseline = outcome({
      terminal: "infrastructure_invalid",
    });
    const report = analyzeRoutingEvaluation(input);

    expect(report.counts.infrastructureInvalidPairs).toBe(1);
    expect(report.gates.holdoutInfrastructureValid).toBe(false);
    expect(report.blockers).toContain("infrastructure_invalid");
    expect(report.gates.activationLicensed).toBe(false);
  });

  test("blocks on any candidate safety violation", () => {
    const input = evaluation(ROUTING_EVAL_HOLDOUT_MINIMUM_PAIRS);
    input.pairs[0]!.candidate = outcome({ safety: "violation" });
    const report = analyzeRoutingEvaluation(input);

    expect(report.counts.candidateSafetyViolations).toBe(1);
    expect(report.gates.candidateSafetyClear).toBe(false);
    expect(report.blockers).toContain("candidate_safety_violation");
    expect(report.gates.activationLicensed).toBe(false);
  });

  test("requires both quality and the Fast wall-clock upper bound", () => {
    const input = evaluation(ROUTING_EVAL_HOLDOUT_MINIMUM_PAIRS, {
      comparison: {
        kind: "fast_vs_standard",
        profile: "terra",
        baselineFast: false,
        candidateFast: true,
      },
    });
    for (const pair of input.pairs) {
      pair.baseline.wallClockMilliseconds = 100;
      pair.candidate.wallClockMilliseconds = 80;
    }
    const report = analyzeRoutingEvaluation(input);

    expect(report.quality.nonInferiorityMet).toBe(true);
    expect(report.latency.oneSided95UpperBound).toBeLessThanOrEqual(
      ROUTING_EVAL_FAST_RATIO_TARGET,
    );
    expect(report.latency.method).toBe("paired_log_ratio_student_t");
    expect(report.latency.criticalValue).toBe(1.661);
    expect(report.latency.targetMet).toBe(true);
    expect(report.gates.economicsResolved).toBe(false);
    expect(report.economics).toBe("unresolved_price_evidence_missing");
    expect(report.blockers).toContain("price_evidence_missing");
    expect(report.gates.activationLicensed).toBe(false);
  });

  test("fails the Fast latency gate when its upper bound exceeds 0.90", () => {
    const input = evaluation(ROUTING_EVAL_HOLDOUT_MINIMUM_PAIRS, {
      comparison: {
        kind: "fast_vs_standard",
        profile: "terra",
        baselineFast: false,
        candidateFast: true,
      },
    });
    for (const pair of input.pairs) {
      pair.candidate.wallClockMilliseconds = 95;
    }
    const report = analyzeRoutingEvaluation(input);

    expect(report.latency.targetMet).toBe(false);
    expect(report.blockers).toContain("fast_latency_target_failed");
  });

  test("uses a conservative Student-t critical value for a small Fast study", () => {
    const input = evaluation(2, {
      comparison: {
        kind: "fast_vs_standard",
        profile: "terra",
        baselineFast: false,
        candidateFast: true,
      },
    });
    input.pairs[0]!.candidate.wallClockMilliseconds = 80;
    input.pairs[1]!.candidate.wallClockMilliseconds = 90;

    const report = analyzeRoutingEvaluation(input);
    expect(report.latency.criticalValue).toBe(6.315);
    expect(report.latency.assumption).toBe(
      "independent_approximately_normal_log_ratios",
    );
  });

  test("aggregates provider-native usage without deriving prices", () => {
    const report = analyzeRoutingEvaluation(evaluation(2));

    expect(report.usageTotals.baseline).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      cacheReadInputTokens: 4,
      cacheWriteInputTokens: 2,
    });
    expect(JSON.stringify(report)).not.toContain("dollar");
    expect(JSON.stringify(report)).not.toContain("cost");
  });

  test("remains total when valid per-run usage sums exceed a per-run bound", () => {
    const input = evaluation(2);
    for (const pair of input.pairs) {
      pair.baseline.providerNativeUsage.inputTokens = 600_000_000;
      pair.candidate.providerNativeUsage.outputTokens = 600_000_000;
    }

    const report = analyzeRoutingEvaluation(input);
    expect(report.usageTotals.baseline.inputTokens).toBe(1_200_000_000);
    expect(report.usageTotals.candidate.outputTokens).toBe(1_200_000_000);
  });
});

describe("routing evaluation CLI", () => {
  test("accepts exactly one absolute --input argument", () => {
    expect(parseRoutingEvaluationArguments(["--input", "/tmp/input.json"])).toBe(
      "/tmp/input.json",
    );
    for (const arguments_ of [
      [],
      ["--input"],
      ["--input", "relative.json"],
      ["--input", "/tmp/a.json", "--extra"],
      ["--other", "/tmp/a.json"],
    ]) {
      expect(() => parseRoutingEvaluationArguments(arguments_)).toThrow(
        "usage:",
      );
    }
  });

  test("prints one content-free report and withholds pair identifiers and bindings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hra-routing-eval-"));
    temporaryDirectories.push(directory);
    const inputPath = join(directory, "private-study.json");
    const input = evaluation(2);
    await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 });

    const process_ = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "routing-eval.ts"), "--input", inputPath],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process_.exited,
      new Response(process_.stdout).text(),
      new Response(process_.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim().split("\n")).toHaveLength(1);
    const report = routingEvaluationReportSchema.parse(JSON.parse(stdout));
    expect(report.counts.pairs).toBe(2);
    expect(stdout).not.toContain(input.pairs[0]!.pairId);
    expect(stdout).not.toContain(input.pairs[0]!.environmentBinding);
    expect(stdout).not.toContain(inputPath);
  });

  test("rejects private extra fields without echoing them or the path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hra-routing-eval-"));
    temporaryDirectories.push(directory);
    const inputPath = join(directory, "secret-path-name.json");
    await writeFile(
      inputPath,
      JSON.stringify({
        ...evaluation(2),
        privateTaskText: "sensitive-marker-must-not-escape",
      }),
      { mode: 0o600 },
    );

    const process_ = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "routing-eval.ts"), "--input", inputPath],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process_.exited,
      new Response(process_.stdout).text(),
      new Response(process_.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("routing evaluation rejected\n");
    expect(stderr).not.toContain("sensitive-marker-must-not-escape");
    expect(stderr).not.toContain(inputPath);
  });

  test("rejects an explicitly named symbolic link without disclosing its path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hra-routing-eval-"));
    temporaryDirectories.push(directory);
    const targetPath = join(directory, "private-study.json");
    const linkPath = join(directory, "study-link.json");
    await writeFile(targetPath, JSON.stringify(evaluation(2)), { mode: 0o600 });
    await symlink(targetPath, linkPath);

    const process_ = Bun.spawn({
      cmd: [
        process.execPath,
        join(import.meta.dir, "routing-eval.ts"),
        "--input",
        linkPath,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process_.exited,
      new Response(process_.stdout).text(),
      new Response(process_.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("routing evaluation rejected\n");
    expect(stderr).not.toContain(linkPath);
    expect(stderr).not.toContain(targetPath);
  });
});
