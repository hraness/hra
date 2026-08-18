import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { chatPaneIdSchema } from "../../../contracts/runtime";
import { z } from "@hra-internal/schema";

import {
  actorEpochIdSchema,
  actorIdSchema,
  actorPolicyVersionSchema,
  actorTurnIdSchema,
  persistedActorWorkClassSchema,
} from "./actor-domain";
import {
  HRA_LONGITUDINAL_ROUTING_MAX_REPORTED_ARMS,
  HRA_LONGITUDINAL_ROUTING_EVIDENCE_COVERAGE_V1,
  HRA_LONGITUDINAL_ROUTING_MIN_OPERATIONAL_RESULTS_PER_ARM,
  HRA_LONGITUDINAL_ROUTING_MIN_QUALITY_RESULTS_PER_ARM,
  HRA_LONGITUDINAL_ROUTING_QUALITY_TOLERANCE_BASIS_POINTS,
  HRA_LONGITUDINAL_ROUTING_HYSTERESIS_BASIS_POINTS,
  HRA_LONGITUDINAL_ROUTING_SCHEMA_VERSION,
  longitudinalRoutingInspectionSchema,
  longitudinalRoutingProfileSchema,
  longitudinalRoutingTierSchema,
  type LongitudinalRoutingElapsed,
  type LongitudinalRoutingInspectionV1,
  type LongitudinalRoutingOperationalOutcomes,
  type LongitudinalRoutingRouteArm,
  type LongitudinalRoutingTokenDimension,
  type LongitudinalRoutingTokenTotals,
} from "./longitudinal-routing-v1";

const callerInputSchema = z.object({
  epochId: actorEpochIdSchema,
  actorId: actorIdSchema,
  turnId: actorTurnIdSchema,
}).strict();

const paneLineageRowSchema = z.object({
  pane_id: chatPaneIdSchema,
}).strict();

const paneHeadRowSchema = z.object({
  observation_revision: z.number().int().positive().safe(),
  analyzed_revision: z.number().int().nonnegative().safe(),
  result_count: z.number().int().nonnegative().safe(),
}).strict();

const armRowSchema = z.object({
  policy_version: actorPolicyVersionSchema,
  work_class: persistedActorWorkClassSchema,
  requested_profile: longitudinalRoutingProfileSchema,
  requested_service_tier: longitudinalRoutingTierSchema,
  realized_service_tier: longitudinalRoutingTierSchema,
  result_count: z.number().int().positive().safe(),
  succeeded_count: z.number().int().nonnegative().safe(),
  failed_count: z.number().int().nonnegative().safe(),
  cancelled_count: z.number().int().nonnegative().safe(),
  quota_rejected_count: z.number().int().nonnegative().safe(),
  quality_evaluated_count: z.literal(0),
  input_observed_count: z.number().int().nonnegative().safe(),
  input_tokens_total: z.number().int().nonnegative().safe(),
  cached_input_observed_count: z.number().int().nonnegative().safe(),
  cached_input_tokens_total: z.number().int().nonnegative().safe(),
  uncached_input_observed_count: z.number().int().nonnegative().safe(),
  uncached_input_tokens_total: z.number().int().nonnegative().safe(),
  output_observed_count: z.number().int().nonnegative().safe(),
  output_tokens_total: z.number().int().nonnegative().safe(),
  reasoning_output_observed_count: z.number().int().nonnegative().safe(),
  reasoning_output_tokens_total: z.number().int().nonnegative().safe(),
  elapsed_observed_count: z.number().int().nonnegative().safe(),
  elapsed_milliseconds_total: z.number().int().nonnegative().safe(),
}).strict();

const dirtyHeadRowSchema = z.object({
  pane_id: chatPaneIdSchema,
  observation_revision: z.number().int().positive().safe(),
}).strict();

const dirtyHeadPageInputSchema = z.object({
  limit: z.number().int().min(1).max(64),
  afterPaneId: chatPaneIdSchema.optional(),
}).strict();

const analysisInputSchema = z.object({
  paneId: chatPaneIdSchema,
  expectedObservationRevision: z.number().int().positive().safe(),
  inspection: longitudinalRoutingInspectionSchema,
}).strict();

const analysisRowSchema = z.object({
  shadow_status: z.enum([
    "collectingOperationalEvidence",
    "qualityEvidenceRequired",
  ]),
  reason: z.enum([
    "insufficientOperationalEvidence",
    "qualityEvidenceAbsent",
  ]),
  summary_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  policy_authorization: z.literal("none"),
}).strict();

export interface LongitudinalRoutingInspectionPortV1 {
  inspectForCaller(input: Readonly<{
    epochId: string;
    actorId: string;
    turnId: string;
  }>): LongitudinalRoutingInspectionV1;
}

export interface LongitudinalRoutingDirtyPaneHeadV1 {
  readonly paneId: string;
  readonly observationRevision: number;
}

export class LongitudinalRoutingSQLiteAuthorityV1
  implements LongitudinalRoutingInspectionPortV1 {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  inspectForCaller(inputValue: Readonly<{
    epochId: string;
    actorId: string;
    turnId: string;
  }>): LongitudinalRoutingInspectionV1 {
    const input = callerInputSchema.parse(inputValue);
    const rows = this.#database.query(`
      SELECT binding.pane_id
      FROM harness_actor_epochs AS epoch
      JOIN harness_actors AS actor
        ON actor.actor_id = ?2 AND actor.epoch_id = epoch.epoch_id
      JOIN harness_actor_turns AS turn
        ON turn.turn_id = ?3 AND turn.epoch_id = epoch.epoch_id
          AND turn.actor_id = actor.actor_id
      JOIN harness_actor_pane_bindings AS binding
        ON binding.actor_id = epoch.root_actor_id
      WHERE epoch.epoch_id = ?1
      GROUP BY binding.pane_id
      ORDER BY binding.pane_id
      LIMIT 2
    `).all(input.epochId, input.actorId, input.turnId)
      .map((row) => paneLineageRowSchema.parse(row));
    if (rows.length === 0) return unavailable("paneLineageUnavailable");
    if (rows.length !== 1) return unavailable("paneLineageAmbiguous");
    return this.inspectPane(rows[0]!.pane_id);
  }

  /** Internal lifecycle read. The returned value still contains no pane ID. */
  inspectPane(paneIdValue: string): LongitudinalRoutingInspectionV1 {
    const paneId = chatPaneIdSchema.parse(paneIdValue);
    const rows = this.#readArms(paneId);
    const routes = rows.slice(0, HRA_LONGITUDINAL_ROUTING_MAX_REPORTED_ARMS)
      .map((row) => armFromRow(row));
    const totals = rows.reduce(
      (value, row) => addArmToTotals(value, row),
      emptyTotals(),
    );
    const headValue: unknown = this.#database.query(`
      SELECT observation_revision, analyzed_revision, result_count
      FROM harness_longitudinal_routing_pane_heads
      WHERE pane_id = ?1
    `).get(paneId);
    const head = headValue === null ? null : paneHeadRowSchema.parse(headValue);
    if (head !== null && head.result_count !== totals.results) {
      throw new Error("longitudinal routing pane head disagrees with arm stats");
    }
    const eligibleArms = rows.filter((row) =>
      row.result_count >=
        HRA_LONGITUDINAL_ROUTING_MIN_OPERATIONAL_RESULTS_PER_ARM
    ).length;
    const shadowState = eligibleArms >= 2
      ? "qualityEvidenceRequired" as const
      : "collectingOperationalEvidence" as const;
    return longitudinalRoutingInspectionSchema.parse({
      kind: "available",
      schemaVersion: HRA_LONGITUDINAL_ROUTING_SCHEMA_VERSION,
      mode: "shadow",
      policyAuthorization: "none",
      coverage: HRA_LONGITUDINAL_ROUTING_EVIDENCE_COVERAGE_V1,
      scope: "chatPaneAcrossEpochs",
      evidence: {
        results: totals.results,
        operationalOutcomes: totals.operationalOutcomes,
        quality: {
          state: "absent",
          evaluatedResults: 0,
          interpretation: "operational completion is not a quality signal",
        },
        tokens: totals.tokens,
        elapsed: totals.elapsed,
      },
      analysis: {
        freshness: head === null ||
            head.analyzed_revision === head.observation_revision
          ? "current"
          : "pending",
      },
      routeArmCount: rows.length,
      reportedRouteArmCount: routes.length,
      routeArmsTruncated: rows.length > routes.length,
      routes,
      shadow: {
        state: shadowState,
        minimumOperationalResultsPerArm:
          HRA_LONGITUDINAL_ROUTING_MIN_OPERATIONAL_RESULTS_PER_ARM,
        minimumQualityResultsPerArm:
          HRA_LONGITUDINAL_ROUTING_MIN_QUALITY_RESULTS_PER_ARM,
        qualityToleranceBasisPoints:
          HRA_LONGITUDINAL_ROUTING_QUALITY_TOLERANCE_BASIS_POINTS,
        hysteresisBasisPoints:
          HRA_LONGITUDINAL_ROUTING_HYSTERESIS_BASIS_POINTS,
        recommendation: null,
      },
    });
  }

  listDirtyPaneHeads(
    inputValue: Readonly<{
      limit: number;
      afterPaneId?: string;
    }> = { limit: 32 },
  ): readonly LongitudinalRoutingDirtyPaneHeadV1[] {
    const input = dirtyHeadPageInputSchema.parse(inputValue);
    const rows = this.#database.query(`
      SELECT pane_id, observation_revision
      FROM harness_longitudinal_routing_pane_heads
      WHERE analyzed_revision < observation_revision
        AND pane_id > COALESCE(?1, '')
      ORDER BY pane_id
      LIMIT ?2
    `).all(input.afterPaneId ?? null, input.limit);
    const wrappedRows = rows.length === 0 && input.afterPaneId !== undefined
      ? this.#database.query(`
        SELECT pane_id, observation_revision
        FROM harness_longitudinal_routing_pane_heads
        WHERE analyzed_revision < observation_revision
        ORDER BY pane_id
      LIMIT ?1
      `).all(input.limit)
      : rows;
    return wrappedRows.map((row) => {
      const parsed = dirtyHeadRowSchema.parse(row);
      return Object.freeze({
        paneId: parsed.pane_id,
        observationRevision: parsed.observation_revision,
      });
    });
  }

  acknowledgeAnalyzedPane(
    inputValue: z.input<typeof analysisInputSchema>,
  ): boolean {
    const input = analysisInputSchema.parse(inputValue);
    if (input.inspection.kind !== "available") {
      throw new Error("pane analysis requires an available inspection");
    }
    const shadowStatus = input.inspection.shadow.state;
    const reason = shadowStatus === "collectingOperationalEvidence"
      ? "insufficientOperationalEvidence" as const
      : "qualityEvidenceAbsent" as const;
    const summaryDigest = createHash("sha256")
      .update(JSON.stringify(input.inspection))
      .digest("hex");
    return this.#database.transaction(() => {
      const headValue: unknown = this.#database.query(`
        SELECT observation_revision, analyzed_revision, result_count
        FROM harness_longitudinal_routing_pane_heads
        WHERE pane_id = ?1
      `).get(input.paneId);
      if (headValue === null) return false;
      const head = paneHeadRowSchema.parse(headValue);
      if (head.observation_revision !== input.expectedObservationRevision) {
        return false;
      }
      const existingValue: unknown = this.#database.query(`
        SELECT shadow_status, reason, summary_digest, policy_authorization
        FROM harness_longitudinal_routing_analyses
        WHERE pane_id = ?1 AND observation_revision = ?2
      `).get(input.paneId, input.expectedObservationRevision);
      if (existingValue !== null) {
        const existing = analysisRowSchema.parse(existingValue);
        if (
          existing.shadow_status !== shadowStatus ||
          existing.reason !== reason ||
          existing.summary_digest !== summaryDigest
        ) {
          throw new Error("analysis revision already has different evidence");
        }
      } else {
        this.#database.query(`
          INSERT INTO harness_longitudinal_routing_analyses (
            pane_id, observation_revision, shadow_status, reason,
            summary_digest, policy_authorization
          ) VALUES (?1, ?2, ?3, ?4, ?5, 'none')
        `).run(
          input.paneId,
          input.expectedObservationRevision,
          shadowStatus,
          reason,
          summaryDigest,
        );
      }
      if (head.analyzed_revision < input.expectedObservationRevision) {
        const changed = this.#database.query(`
          UPDATE harness_longitudinal_routing_pane_heads
          SET analyzed_revision = ?2
          WHERE pane_id = ?1 AND observation_revision = ?2
            AND analyzed_revision < ?2
        `).run(input.paneId, input.expectedObservationRevision);
        if (changed.changes !== 1) {
          return false;
        }
      }
      return true;
    })();
  }

  #readArms(paneId: string): readonly z.infer<typeof armRowSchema>[] {
    const rows: unknown[] = this.#database.query(`
      SELECT policy_version, work_class,
        routed_profile AS requested_profile,
        requested_service_tier, realized_service_tier,
        result_count, succeeded_count,
        failed_count, cancelled_count, quota_rejected_count,
        quality_evaluated_count, input_observed_count,
        input_tokens_total, cached_input_observed_count,
        cached_input_tokens_total, uncached_input_observed_count,
        uncached_input_tokens_total, output_observed_count,
        output_tokens_total, reasoning_output_observed_count,
        reasoning_output_tokens_total, elapsed_observed_count,
        elapsed_milliseconds_total
      FROM harness_longitudinal_routing_arm_stats
      WHERE pane_id = ?1
      ORDER BY result_count DESC, policy_version DESC,
        work_class, routed_profile, requested_service_tier,
        realized_service_tier
    `).all(paneId);
    return rows.map((row) => armRowSchema.parse(row));
  }
}

function unavailable(
  reason: "paneLineageUnavailable" | "paneLineageAmbiguous",
): LongitudinalRoutingInspectionV1 {
  return longitudinalRoutingInspectionSchema.parse({
    kind: "unavailable",
    schemaVersion: HRA_LONGITUDINAL_ROUTING_SCHEMA_VERSION,
    mode: "shadow",
    policyAuthorization: "none",
    coverage: HRA_LONGITUDINAL_ROUTING_EVIDENCE_COVERAGE_V1,
    reason,
  });
}

function dimension(
  results: number,
  observedResults: number,
  total: number,
): LongitudinalRoutingTokenDimension {
  return Object.freeze({
    observedResults,
    missingResults: results - observedResults,
    total,
  });
}

function elapsed(
  results: number,
  observedResults: number,
  totalMilliseconds: number,
): LongitudinalRoutingElapsed {
  return Object.freeze({
    observedResults,
    missingResults: results - observedResults,
    totalMilliseconds,
  });
}

function armFromRow(row: z.infer<typeof armRowSchema>): LongitudinalRoutingRouteArm {
  return Object.freeze({
    policyVersion: row.policy_version,
    workClass: row.work_class,
    requestedProfile: row.requested_profile,
    requestedTier: row.requested_service_tier,
    realizedTier: row.realized_service_tier,
    results: row.result_count,
    operationalOutcomes: outcomesFromRow(row),
    quality: Object.freeze({ state: "absent", evaluatedResults: 0 }),
    tokens: tokensFromRow(row),
    elapsed: elapsed(
      row.result_count,
      row.elapsed_observed_count,
      row.elapsed_milliseconds_total,
    ),
  });
}

function outcomesFromRow(
  row: z.infer<typeof armRowSchema>,
): LongitudinalRoutingOperationalOutcomes {
  return Object.freeze({
    succeeded: row.succeeded_count,
    failed: row.failed_count,
    cancelled: row.cancelled_count,
    quotaRejected: row.quota_rejected_count,
  });
}

function tokensFromRow(row: z.infer<typeof armRowSchema>): LongitudinalRoutingTokenTotals {
  return Object.freeze({
    inputTokens: dimension(
      row.result_count,
      row.input_observed_count,
      row.input_tokens_total,
    ),
    cachedInputTokens: dimension(
      row.result_count,
      row.cached_input_observed_count,
      row.cached_input_tokens_total,
    ),
    uncachedInputTokens: dimension(
      row.result_count,
      row.uncached_input_observed_count,
      row.uncached_input_tokens_total,
    ),
    outputTokens: dimension(
      row.result_count,
      row.output_observed_count,
      row.output_tokens_total,
    ),
    reasoningOutputTokens: dimension(
      row.result_count,
      row.reasoning_output_observed_count,
      row.reasoning_output_tokens_total,
    ),
  });
}

interface MutableTotals {
  results: number;
  operationalOutcomes: LongitudinalRoutingOperationalOutcomes;
  tokens: LongitudinalRoutingTokenTotals;
  elapsed: LongitudinalRoutingElapsed;
}

function emptyTotals(): MutableTotals {
  return {
    results: 0,
    operationalOutcomes: {
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      quotaRejected: 0,
    },
    tokens: {
      inputTokens: dimension(0, 0, 0),
      cachedInputTokens: dimension(0, 0, 0),
      uncachedInputTokens: dimension(0, 0, 0),
      outputTokens: dimension(0, 0, 0),
      reasoningOutputTokens: dimension(0, 0, 0),
    },
    elapsed: elapsed(0, 0, 0),
  };
}

function addArmToTotals(
  totals: MutableTotals,
  row: z.infer<typeof armRowSchema>,
): MutableTotals {
  const nextResults = safeAdd(totals.results, row.result_count);
  const armTokens = tokensFromRow(row);
  return {
    results: nextResults,
    operationalOutcomes: {
      succeeded: safeAdd(
        totals.operationalOutcomes.succeeded,
        row.succeeded_count,
      ),
      failed: safeAdd(totals.operationalOutcomes.failed, row.failed_count),
      cancelled: safeAdd(
        totals.operationalOutcomes.cancelled,
        row.cancelled_count,
      ),
      quotaRejected: safeAdd(
        totals.operationalOutcomes.quotaRejected,
        row.quota_rejected_count,
      ),
    },
    tokens: {
      inputTokens: addDimensions(totals.tokens.inputTokens, armTokens.inputTokens),
      cachedInputTokens: addDimensions(
        totals.tokens.cachedInputTokens,
        armTokens.cachedInputTokens,
      ),
      uncachedInputTokens: addDimensions(
        totals.tokens.uncachedInputTokens,
        armTokens.uncachedInputTokens,
      ),
      outputTokens: addDimensions(
        totals.tokens.outputTokens,
        armTokens.outputTokens,
      ),
      reasoningOutputTokens: addDimensions(
        totals.tokens.reasoningOutputTokens,
        armTokens.reasoningOutputTokens,
      ),
    },
    elapsed: {
      observedResults: safeAdd(
        totals.elapsed.observedResults,
        row.elapsed_observed_count,
      ),
      missingResults: safeAdd(
        totals.elapsed.missingResults,
        row.result_count - row.elapsed_observed_count,
      ),
      totalMilliseconds: safeAdd(
        totals.elapsed.totalMilliseconds,
        row.elapsed_milliseconds_total,
      ),
    },
  };
}

function addDimensions(
  left: LongitudinalRoutingTokenDimension,
  right: LongitudinalRoutingTokenDimension,
): LongitudinalRoutingTokenDimension {
  return {
    observedResults: safeAdd(left.observedResults, right.observedResults),
    missingResults: safeAdd(left.missingResults, right.missingResults),
    total: safeAdd(left.total, right.total),
  };
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error("longitudinal routing aggregate exceeds safe integer bounds");
  }
  return result;
}
