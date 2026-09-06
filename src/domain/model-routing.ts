import { z } from "zod";

import {
  defaultPresetForProvider,
  isPresetSupportedByProvider,
  presetSchema,
  providerSchema,
} from "./presets";
import {
  modelTaskShapeRuleSchema,
  modelTaskShapeSchema,
} from "./model-task-shape";

export const modelRoutingBoundarySchema = z.enum(["new", "established"]);
export type ModelRoutingBoundary = z.infer<typeof modelRoutingBoundarySchema>;

export const modelRoutingSelectionSchema = z.enum([
  "implicit_default",
  "explicit_family_default",
  "explicit_preset",
  "existing",
]);
export type ModelRoutingSelection = z.infer<typeof modelRoutingSelectionSchema>;

export const modelRoutingSafetySchema = z.enum([
  "declared_local",
  "unknown",
  "strong_required",
]);
export type ModelRoutingSafety = z.infer<typeof modelRoutingSafetySchema>;

export const effectiveModelRouteSchema = z
  .object({
    provider: providerSchema,
    preset: presetSchema,
    fast: z.boolean(),
  })
  .strict()
  .superRefine((route, context) => {
    if (!isPresetSupportedByProvider(route.provider, route.preset)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "The effective preset is not admitted for its provider.",
        path: ["preset"],
      });
    }

    if (route.provider === "claude" && route.fast) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Claude routes cannot enable Fast mode.",
        path: ["fast"],
      });
    }
  });
export type EffectiveModelRoute = z.infer<typeof effectiveModelRouteSchema>;

const SHAPE_FOR_RULE = {
  input_too_long: "uncertain",
  input_empty: "uncertain",
  input_unsupported_format: "uncertain",
  classification_directive: "uncertain",
  conflicting_requirements: "open_ended",
  open_ended_unknown_cause: "open_ended",
  open_ended_research: "open_ended",
  open_ended_comparison: "open_ended",
  open_ended_design: "open_ended",
  open_ended_broad_scope: "open_ended",
  open_ended_conditional_authorship: "open_ended",
  mechanical_wait_only: "mechanical",
  mechanical_monitor_only: "mechanical",
  mechanical_command_only: "mechanical",
  well_defined_scope_and_outcome: "well_defined",
  default_uncertain: "uncertain",
} as const;

export const modelRoutingInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    boundary: modelRoutingBoundarySchema,
    selection: modelRoutingSelectionSchema,
    effective: effectiveModelRouteSchema,
    taskShape: modelTaskShapeSchema,
    taskRule: modelTaskShapeRuleSchema,
    safety: modelRoutingSafetySchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (SHAPE_FOR_RULE[input.taskRule] !== input.taskShape) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "The task rule does not produce the supplied task shape.",
        path: ["taskRule"],
      });
    }

    if (input.boundary === "established" && input.selection !== "existing") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Established sessions must preserve an existing selection.",
        path: ["selection"],
      });
    }

    if (input.boundary === "new" && input.selection === "existing") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Existing selections are valid only for established sessions.",
        path: ["selection"],
      });
    }

    if (
      input.selection === "implicit_default" &&
      (input.boundary !== "new" ||
        input.effective.provider !== "codex" ||
        input.effective.preset !== "ultra" ||
        input.effective.fast)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "The implicit default is new Codex Ultra with Fast disabled.",
        path: ["selection"],
      });
    }

    if (
      input.selection === "explicit_family_default" &&
      (input.boundary !== "new" ||
        input.effective.preset !==
          defaultPresetForProvider(input.effective.provider) ||
        input.effective.fast)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "A family default must be a new, explicit provider default with Fast disabled.",
        path: ["selection"],
      });
    }

    if (
      input.selection === "explicit_preset" &&
      input.boundary !== "new"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Explicit presets are new-session selections.",
        path: ["selection"],
      });
    }
  });
export type ModelRoutingInput = z.infer<typeof modelRoutingInputSchema>;

export const modelRoutingCandidateIdSchema = z.enum([
  "codex_terra_ultra",
  "codex_fast_for_terra",
  "claude_opus_effort_study",
]);
export type ModelRoutingCandidateId = z.infer<
  typeof modelRoutingCandidateIdSchema
>;

export const modelRoutingBlockerSchema = z.enum([
  "canonical_profile_absent",
  "capability_unproven",
  "private_non_inferiority_missing",
  "latency_evidence_missing",
  "price_evidence_missing",
  "effort_evidence_missing",
  "effect_class_unproven",
]);
export type ModelRoutingBlocker = z.infer<typeof modelRoutingBlockerSchema>;

export const modelRoutingCandidateSchema = z
  .object({
    id: modelRoutingCandidateIdSchema,
    status: z.literal("disabled_unlicensed"),
    blockers: z.array(modelRoutingBlockerSchema).min(1),
  })
  .strict();
export type ModelRoutingCandidate = z.infer<
  typeof modelRoutingCandidateSchema
>;

export const modelRoutingDecisionRuleSchema = z.enum([
  "preserve_established_route",
  "preserve_explicit_preset",
  "strong_profile_required",
  "task_shape_ineligible",
  "study_codex_default",
  "study_claude_family_default",
]);
export type ModelRoutingDecisionRule = z.infer<
  typeof modelRoutingDecisionRuleSchema
>;

const REASONS: Record<ModelRoutingDecisionRule, string> = {
  preserve_established_route:
    "Established sessions retain their admitted effective route.",
  preserve_explicit_preset:
    "Explicit preset choices retain their admitted effective route.",
  strong_profile_required:
    "Strong-required work is excluded from candidate study.",
  task_shape_ineligible:
    "Only new, well-defined, non-mechanical work is eligible for candidate study.",
  study_codex_default:
    "The effective Codex default is preserved while disabled alternatives are studied.",
  study_claude_family_default:
    "The effective Claude family default is preserved while a disabled alternative is studied.",
};

const REQUIRED_CANDIDATE_BLOCKERS: Record<
  ModelRoutingCandidateId,
  readonly ModelRoutingBlocker[]
> = {
  codex_terra_ultra: [
    "canonical_profile_absent",
    "capability_unproven",
    "private_non_inferiority_missing",
  ],
  codex_fast_for_terra: [
    "canonical_profile_absent",
    "capability_unproven",
    "private_non_inferiority_missing",
    "latency_evidence_missing",
    "price_evidence_missing",
  ],
  claude_opus_effort_study: [
    "canonical_profile_absent",
    "capability_unproven",
    "private_non_inferiority_missing",
    "effort_evidence_missing",
  ],
};

export const modelRoutingDecisionSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.literal("shadow"),
    runtimeMutationAllowed: z.literal(false),
    effective: effectiveModelRouteSchema,
    rule: modelRoutingDecisionRuleSchema,
    reason: z.string().min(1).max(160),
    candidates: z.array(modelRoutingCandidateSchema).max(2),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.reason !== REASONS[value.rule]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "The decision reason must match its rule.",
        path: ["reason"],
      });
    }

    for (const [index, candidate] of value.candidates.entries()) {
      const required = REQUIRED_CANDIDATE_BLOCKERS[candidate.id];
      const allowed = new Set<ModelRoutingBlocker>([
        ...required,
        "effect_class_unproven",
      ]);
      if (
        new Set(candidate.blockers).size !== candidate.blockers.length ||
        required.some((blocker) => !candidate.blockers.includes(blocker)) ||
        candidate.blockers.some((blocker) => !allowed.has(blocker))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Candidate blockers must match the disabled study.",
          path: ["candidates", index, "blockers"],
        });
      }
    }

    const candidateIds = value.candidates.map((candidate) => candidate.id);
    switch (value.rule) {
      case "study_codex_default":
        if (
          value.effective.provider !== "codex" ||
          value.effective.preset !== "ultra" ||
          value.effective.fast ||
          candidateIds.length !== 2 ||
          candidateIds[0] !== "codex_terra_ultra" ||
          candidateIds[1] !== "codex_fast_for_terra"
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "The Codex study rule requires the Ultra default and its exact disabled candidates.",
            path: ["rule"],
          });
        }
        break;
      case "study_claude_family_default":
        if (
          value.effective.provider !== "claude" ||
          value.effective.preset !== "fable-max" ||
          value.effective.fast ||
          candidateIds.length !== 1 ||
          candidateIds[0] !== "claude_opus_effort_study"
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "The Claude study rule requires its family default and exact disabled candidate.",
            path: ["rule"],
          });
        }
        break;
      case "preserve_established_route":
      case "preserve_explicit_preset":
      case "strong_profile_required":
      case "task_shape_ineligible":
        if (candidateIds.length !== 0) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "A preservation or exclusion rule cannot carry candidates.",
            path: ["candidates"],
          });
        }
        break;
    }
  });
export type ModelRoutingDecision = z.infer<
  typeof modelRoutingDecisionSchema
>;

function withUnknownSafetyBlocker(
  blockers: readonly ModelRoutingBlocker[],
  safety: ModelRoutingSafety,
): ModelRoutingBlocker[] {
  return safety === "unknown"
    ? [...blockers, "effect_class_unproven"]
    : [...blockers];
}

function decision(
  effective: EffectiveModelRoute,
  rule: ModelRoutingDecisionRule,
  candidates: ModelRoutingCandidate[],
): ModelRoutingDecision {
  return modelRoutingDecisionSchema.parse({
    schemaVersion: 1,
    mode: "shadow",
    runtimeMutationAllowed: false,
    effective: { ...effective },
    rule,
    reason: REASONS[rule],
    candidates,
  });
}

/**
 * Produces an explainable, content-free shadow decision. It never mutates the
 * supplied effective route and never licenses a candidate for runtime use.
 */
export function decideModelRouting(input: unknown): ModelRoutingDecision {
  const parsed = modelRoutingInputSchema.parse(input);

  if (parsed.boundary === "established") {
    return decision(parsed.effective, "preserve_established_route", []);
  }

  if (parsed.selection === "explicit_preset") {
    return decision(parsed.effective, "preserve_explicit_preset", []);
  }

  if (parsed.safety === "strong_required") {
    return decision(parsed.effective, "strong_profile_required", []);
  }

  if (parsed.taskShape !== "well_defined") {
    return decision(parsed.effective, "task_shape_ineligible", []);
  }

  if (parsed.effective.provider === "codex") {
    return decision(parsed.effective, "study_codex_default", [
      {
        id: "codex_terra_ultra",
        status: "disabled_unlicensed",
        blockers: withUnknownSafetyBlocker(
          [
            "canonical_profile_absent",
            "capability_unproven",
            "private_non_inferiority_missing",
          ],
          parsed.safety,
        ),
      },
      {
        id: "codex_fast_for_terra",
        status: "disabled_unlicensed",
        blockers: withUnknownSafetyBlocker(
          [
            "canonical_profile_absent",
            "capability_unproven",
            "private_non_inferiority_missing",
            "latency_evidence_missing",
            "price_evidence_missing",
          ],
          parsed.safety,
        ),
      },
    ]);
  }

  return decision(parsed.effective, "study_claude_family_default", [
    {
      id: "claude_opus_effort_study",
      status: "disabled_unlicensed",
      blockers: withUnknownSafetyBlocker(
        [
          "canonical_profile_absent",
          "capability_unproven",
          "private_non_inferiority_missing",
          "effort_evidence_missing",
        ],
        parsed.safety,
      ),
    },
  ]);
}
