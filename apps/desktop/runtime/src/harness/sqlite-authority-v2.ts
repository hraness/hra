import { createHash } from "node:crypto";

import type { Database } from "bun:sqlite";
import { z } from "@hra-internal/schema";

import {
  actorAttemptIdSchema,
  actorAttemptSchema,
  actorBudgetSchema,
  actorEpochIdSchema,
  actorEpochSchema,
  actorIdSchema,
  actorLaneAuthoritySchema,
  actorOperationIdSchema,
  actorPolicyVersionSchema,
  actorResultIdSchema,
  actorResultSchema,
  actorSchema,
  actorTurnAccelerationSchema,
  actorTurnIdSchema,
  actorTurnSchema,
  persistedActorWorkClassSchema,
  ActorDomainError,
  assertNextActorResult,
  deriveChildBudget,
  isTerminalActorAttemptState,
  isTerminalActorTurnState,
  transitionActor,
  transitionActorTurn,
  type Actor,
  type ActorAttempt,
  type ActorEpoch,
  type ActorResult,
  type ActorTurn,
  type ActorTurnState,
} from "./actor-domain";
import type { ActorTokenUsageIdentityPortV2 } from "./actor-token-usage-identity-v2";
import {
  HRA_LUNA_MODEL,
  HRA_SOL_MODEL,
  metaharnessFastFallbackReasonSchema,
  metaharnessProfileFallbackReasonSchema,
  metaharnessTierSchema,
  type RealizedActorProfile,
} from "./metaharness-policy-v1";

const isoTimestampSchema = z.string().datetime({ offset: true });
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const boundedProviderIdSchema = z.string().min(1).max(512)
  .refine((value) => !value.includes("\0"), "provider identity contains NUL");
const requestIdentitySchema = z.string().min(16).max(128)
  .refine((value) => !value.includes("\0"), "request identity contains NUL");
const actorStartQuotaEvidenceEnvelopeSchema = z.object({
  version: z.literal(1),
  request: z.object({
    actorId: actorIdSchema,
    accountProfileId: z.string().min(1).max(96),
    processGeneration: z.number().int().positive().safe(),
  }).passthrough(),
  outcome: z.object({
    kind: z.literal("notApplied"),
    reason: z.literal("quota"),
    proof: z.object({
      digest: digestSchema,
      observedAt: isoTimestampSchema,
      definitive: z.literal(true),
      phase: z.literal("preEffect"),
    }).strict(),
  }).strict(),
}).strict();
const paneIdSchema = z.string().min(12).max(96)
  .regex(/^pane_[A-Za-z0-9_-]+$/u);
const laneIdSchema = z.string().min(1).max(128)
  .refine((value) => !value.includes("\0"), "lane identity contains NUL");
const actorIncarnationIdSchema = z.string().min(16).max(96)
  .regex(/^hincarnation_[A-Za-z0-9_-]+$/u);
const actorFastReservationIdSchema = z.string().min(16).max(96)
  .regex(/^hfast_[A-Za-z0-9_-]+$/u);
const actorAccountLeaseIdSchema = z.string().min(16).max(96)
  .regex(/^haccountlease_[A-Za-z0-9_-]+$/u);
export const actorDispatchWorkClassV2Schema = persistedActorWorkClassSchema;
const actorModelProfileSchema = z.enum([HRA_SOL_MODEL, HRA_LUNA_MODEL]);
const actorReasoningEffortSchema = z.enum(["ultra", "max"]);
const actorProfileFallbackReasonSchema =
  metaharnessProfileFallbackReasonSchema;
const actorTierFallbackReasonSchema = metaharnessFastFallbackReasonSchema;
const actorModelRerouteModelSchema = z.string().min(1).max(160)
  .refine((value) => !value.includes("\0"), "model identity contains NUL");
const actorModelRerouteReasonSchema = z.literal("highRiskCyberActivity");
const actorModelRerouteQuarantineReasonSchema = z.enum([
  "ambiguous_candidate",
  "provider_identity_conflict",
  "fact_conflict",
]);
const actorAccelerationBottleneckSchema = z.enum([
  "none",
  "reasoning",
  "fileGeneration",
]);

export const actorDispatchPolicyRecordV2Schema = z.object({
  actorId: actorIdSchema,
  policyVersion: actorPolicyVersionSchema,
  workClass: actorDispatchWorkClassV2Schema,
}).strict().superRefine((policy, context) => {
  if (
    (policy.policyVersion === 0) !==
      (policy.workClass === "legacyUnclassified")
  ) {
    context.addIssue({
      code: "custom",
      message: "legacy dispatch policy and work class must match",
      path: ["workClass"],
    });
  }
});

export type ActorDispatchPolicyRecordV2 = z.infer<
  typeof actorDispatchPolicyRecordV2Schema
>;

export const actorTurnAccelerationRecordV2Schema = z.discriminatedUnion(
  "mode",
  [
    actorTurnAccelerationSchema.options[0].extend({
      turnId: actorTurnIdSchema,
    }).strict(),
    actorTurnAccelerationSchema.options[1].extend({
      turnId: actorTurnIdSchema,
    }).strict(),
  ],
);

export type ActorTurnAccelerationRecordV2 = z.infer<
  typeof actorTurnAccelerationRecordV2Schema
>;

export type ActorReconciliationTargetV2 =
  | Readonly<{ kind: "actor"; actorId: string }>
  | Readonly<{ kind: "turn"; turnId: string }>
  | Readonly<{ kind: "incarnation"; incarnationId: string }>
  | Readonly<{
      kind: "providerTurn";
      accountProfileId: string;
      providerThreadId: string;
      providerTurnId: string;
    }>;

const actorReconciliationTargetV2Schema: z.ZodType<
  ActorReconciliationTargetV2
> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("actor"), actorId: actorIdSchema }).strict(),
  z.object({ kind: z.literal("turn"), turnId: actorTurnIdSchema }).strict(),
  z.object({
    kind: z.literal("incarnation"),
    incarnationId: actorIncarnationIdSchema,
  }).strict(),
  z.object({
    kind: z.literal("providerTurn"),
    accountProfileId: z.string().min(1).max(96),
    providerThreadId: boundedProviderIdSchema,
    providerTurnId: boundedProviderIdSchema,
  }).strict(),
]);

function actorReconciliationTargetPredicate(
  target: ActorReconciliationTargetV2,
  subject: "operation" | "attempt" | "turn",
): Readonly<{ sql: string; parameters: readonly string[] }> {
  if (target.kind === "actor") {
    if (subject === "operation") {
      return { sql: "operation.actor_id = ?", parameters: [target.actorId] };
    }
    if (subject === "attempt") {
      return {
        sql: `attempt.turn_id IN (
          SELECT target_turn.turn_id FROM harness_actor_turns AS target_turn
          WHERE target_turn.actor_id = ?
        )`,
        parameters: [target.actorId],
      };
    }
    return { sql: "turn.actor_id = ?", parameters: [target.actorId] };
  }
  if (target.kind === "turn") {
    return {
      sql: `${subject}.turn_id = ?`,
      parameters: [target.turnId],
    };
  }
  if (target.kind === "incarnation") {
    if (subject === "operation") {
      return {
        sql: `(operation.operation_id = (
          SELECT incarnation.start_operation_id
          FROM harness_actor_incarnations AS incarnation
          WHERE incarnation.incarnation_id = ?
        ) OR operation.turn_id IN (
          SELECT target_attempt.turn_id
          FROM harness_actor_turn_attempts AS target_attempt
          WHERE target_attempt.incarnation_id = ?
        ))`,
        parameters: [target.incarnationId, target.incarnationId],
      };
    }
    if (subject === "attempt") {
      return {
        sql: "attempt.incarnation_id = ?",
        parameters: [target.incarnationId],
      };
    }
    return {
      sql: `EXISTS (
        SELECT 1 FROM harness_actor_turn_attempts AS target_attempt
        WHERE target_attempt.turn_id = turn.turn_id
          AND target_attempt.incarnation_id = ?
      )`,
      parameters: [target.incarnationId],
    };
  }
  const exactIncarnation = `(
    SELECT incarnation.incarnation_id
    FROM harness_actor_incarnations AS incarnation
    WHERE incarnation.account_profile_id = ?
      AND incarnation.provider_thread_id = ?
  )`;
  if (subject === "operation") {
    return {
      sql: `operation.turn_id IN (
        SELECT target_attempt.turn_id
        FROM harness_actor_turn_attempts AS target_attempt
        WHERE target_attempt.incarnation_id = ${exactIncarnation}
          AND target_attempt.provider_turn_id = ?
      )`,
      parameters: [
        target.accountProfileId,
        target.providerThreadId,
        target.providerTurnId,
      ],
    };
  }
  if (subject === "attempt") {
    return {
      sql: `attempt.incarnation_id = ${exactIncarnation}
        AND attempt.provider_turn_id = ?`,
      parameters: [
        target.accountProfileId,
        target.providerThreadId,
        target.providerTurnId,
      ],
    };
  }
  return {
    sql: `turn.turn_id IN (
      SELECT target_attempt.turn_id
      FROM harness_actor_turn_attempts AS target_attempt
      WHERE target_attempt.incarnation_id = ${exactIncarnation}
        AND target_attempt.provider_turn_id = ?
    )`,
    parameters: [
      target.accountProfileId,
      target.providerThreadId,
      target.providerTurnId,
    ],
  };
}
const contextValueIdSchema = z.string().min(16).max(96)
  .regex(/^ctxval_[A-Za-z0-9_-]+$/u);
export const actorWorkspaceBindingIdSchema = z.string().min(16).max(96)
  .regex(/^hbinding_[A-Za-z0-9_-]+$/u);
const actorPaneBindingIdSchema = z.string().min(16).max(96)
  .regex(/^hpanebinding_[A-Za-z0-9_-]+$/u);
const actorSessionBindingStateSchema = z.enum([
  "bound",
  "retired",
  "quarantined",
]);
export const actorSessionQuarantineReasonV2Schema = z.enum([
  "provider_identity_mismatch",
  "thread_source_mismatch",
  "workspace_mismatch",
  "sandbox_mismatch",
  "history_unstable",
  "actor_ownership_conflict",
  "generation_regression",
  "token_evidence_regression",
  "recovery_protocol_error",
]);

export const actorSessionRecoveryProofV2Schema = z.object({
  recoveryProofDigest: digestSchema,
  priorRecoveryProofDigest: digestSchema.nullable(),
  observationGeneration: z.number().int().positive().safe(),
  historyEvidenceDigest: digestSchema,
  firstObservationPosition: z.number().int().nonnegative().safe(),
  secondObservationPosition: z.number().int().positive().safe(),
  historyTurnCount: z.number().int().min(0).max(10_000),
  historyItemCount: z.number().int().min(0).max(100_000),
}).strict().superRefine((proof, context) => {
  if (proof.secondObservationPosition <= proof.firstObservationPosition) {
    context.addIssue({
      code: "custom",
      message: "the second actor-session observation must follow the first",
      path: ["secondObservationPosition"],
    });
  }
});

export type ActorSessionRecoveryProofV2 = z.infer<
  typeof actorSessionRecoveryProofV2Schema
>;

export const actorSessionBindingRecordV2Schema = z.object({
  incarnationId: actorIncarnationIdSchema,
  actorId: actorIdSchema,
  actorTitle: z.string().min(1).max(160),
  workspaceBindingId: actorWorkspaceBindingIdSchema,
  workspaceLaneId: laneIdSchema,
  workspacePath: z.string().min(1).max(4096),
  workspaceMode: z.enum(["managed", "readOnly"]),
  accountProfileId: z.string().min(1).max(96),
  admissionGeneration: z.number().int().positive().safe(),
  liveGeneration: z.number().int().positive().safe(),
  providerThreadId: boundedProviderIdSchema,
  threadSource: z.string().min(16).max(256),
  modelId: actorModelProfileSchema,
  reasoningEffort: actorReasoningEffortSchema,
  capabilityEvidenceDigest: digestSchema.nullable(),
  supportsFast: z.boolean().nullable(),
  liveCapabilityEvidenceDigest: digestSchema.nullable(),
  liveSupportsFast: z.boolean().nullable(),
  recoveryProof: actorSessionRecoveryProofV2Schema,
  state: actorSessionBindingStateSchema,
  quarantineReason: actorSessionQuarantineReasonV2Schema.nullable(),
  revision: z.number().int().positive().safe(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  recoveredAt: isoTimestampSchema.nullable(),
  retiredAt: isoTimestampSchema.nullable(),
  quarantinedAt: isoTimestampSchema.nullable(),
}).strict().superRefine((binding, context) => {
  if (binding.liveGeneration < binding.admissionGeneration) {
    context.addIssue({
      code: "custom",
      message: "the live actor-session generation cannot precede admission",
      path: ["liveGeneration"],
    });
  }
  if (binding.recoveryProof.observationGeneration !== binding.liveGeneration) {
    context.addIssue({
      code: "custom",
      message: "the actor-session proof must observe the live generation",
      path: ["recoveryProof", "observationGeneration"],
    });
  }
  if (
    (binding.liveCapabilityEvidenceDigest === null) !==
      (binding.liveSupportsFast === null)
  ) {
    context.addIssue({
      code: "custom",
      message: "live actor-session capability evidence must be complete",
      path: ["liveCapabilityEvidenceDigest"],
    });
  }
  if (
    (binding.capabilityEvidenceDigest === null) !==
      (binding.supportsFast === null)
  ) {
    context.addIssue({
      code: "custom",
      message: "only a legacy actor session may omit capability evidence",
      path: ["capabilityEvidenceDigest"],
    });
  }
  if (
    binding.liveGeneration === binding.admissionGeneration &&
    binding.capabilityEvidenceDigest !== null &&
    (binding.liveCapabilityEvidenceDigest !==
        binding.capabilityEvidenceDigest ||
      binding.liveSupportsFast !== binding.supportsFast)
  ) {
    context.addIssue({
      code: "custom",
      message: "initial actor-session capability evidence must match admission",
      path: ["liveCapabilityEvidenceDigest"],
    });
  }
  const quarantined = binding.state === "quarantined";
  const retired = binding.state === "retired";
  if (
    quarantined !== (binding.quarantineReason !== null) ||
    quarantined !== (binding.quarantinedAt !== null) ||
    retired !== (binding.retiredAt !== null)
  ) {
    context.addIssue({
      code: "custom",
      message: "only a quarantined actor session has quarantine evidence",
      path: ["state"],
    });
  }
});

export type ActorSessionBindingRecordV2 = z.infer<
  typeof actorSessionBindingRecordV2Schema
>;

const actorOperationKindSchema = z.enum([
  "actorStart",
  "turnStart",
  "turnInterrupt",
]);
const actorOperationStateSchema = z.enum([
  "prepared",
  "effectStarted",
  "succeeded",
  "notApplied",
  "ambiguous",
  "recoveryRequired",
]);
const actorIncarnationStateSchema = z.enum([
  "starting",
  "idle",
  "running",
  "quarantined",
  "closed",
]);

export const actorOperationRecordSchema = z.object({
  id: actorOperationIdSchema,
  actorId: actorIdSchema,
  turnId: actorTurnIdSchema.nullable(),
  kind: actorOperationKindSchema,
  requestDigest: digestSchema,
  effectKey: digestSchema,
  state: actorOperationStateSchema,
  providerIdentityJson: z.string().min(2).max(64 * 1024).nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  settledAt: isoTimestampSchema.nullable(),
}).strict().superRefine((operation, context) => {
  const terminal = operation.state === "succeeded" ||
    operation.state === "notApplied" || operation.state === "ambiguous" ||
    operation.state === "recoveryRequired";
  if (terminal !== (operation.settledAt !== null)) {
    context.addIssue({
      code: "custom",
      message: "only a terminal actor operation has a settlement timestamp",
      path: ["settledAt"],
    });
  }
  if ((operation.kind === "actorStart") !== (operation.turnId === null)) {
    context.addIssue({
      code: "custom",
      message: "only actorStart omits a logical turn",
      path: ["turnId"],
    });
  }
  if (operation.providerIdentityJson !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(operation.providerIdentityJson) as unknown;
    } catch {
      context.addIssue({
        code: "custom",
        message: "provider identity must be valid JSON",
        path: ["providerIdentityJson"],
      });
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      context.addIssue({
        code: "custom",
        message: "provider identity must be a JSON object",
        path: ["providerIdentityJson"],
      });
    }
  }
});

export type ActorOperationRecord = z.infer<typeof actorOperationRecordSchema>;

export const actorIncarnationRecordSchema = z.object({
  id: actorIncarnationIdSchema,
  actorId: actorIdSchema,
  ordinal: z.number().int().positive().safe(),
  accountProfileId: z.string().min(1).max(96),
  processGeneration: z.number().int().positive().safe(),
  startOperationId: actorOperationIdSchema,
  clientRequestId: requestIdentitySchema,
  threadSource: z.string().min(16).max(256)
    .refine((value) => !value.includes("\0"), "thread source contains NUL"),
  providerThreadId: boundedProviderIdSchema.nullable(),
  tokenUsageObservationGeneration: z.number().int().positive().safe(),
  tokenUsageLatestPosition: z.number().int().nonnegative().safe().nullable(),
  tokenUsageCumulativeInputTokens: z.number().int().nonnegative().safe(),
  tokenUsageCumulativeOutputTokens: z.number().int().nonnegative().safe(),
  tokenUsageCumulativeCachedInputTokens:
    z.number().int().nonnegative().safe().nullable(),
  tokenUsageCumulativeReasoningOutputTokens:
    z.number().int().nonnegative().safe().nullable(),
  requestedModel: actorModelProfileSchema,
  requestedReasoningEffort: actorReasoningEffortSchema,
  profileFallbackReason: actorProfileFallbackReasonSchema.nullable(),
  capabilityEvidenceDigest: digestSchema.nullable(),
  supportsFast: z.boolean().nullable(),
  observedModel: actorModelProfileSchema.nullable(),
  observedReasoningEffort: actorReasoningEffortSchema.nullable(),
  observedProfileState: z.enum(["unknown", "exact", "rerouted"]),
  observedProfileAt: isoTimestampSchema.nullable(),
  toolsetDigest: digestSchema,
  state: actorIncarnationStateSchema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  closedAt: isoTimestampSchema.nullable(),
}).strict().superRefine((incarnation, context) => {
  const terminal = incarnation.state === "quarantined" ||
    incarnation.state === "closed";
  if (terminal !== (incarnation.closedAt !== null)) {
    context.addIssue({
      code: "custom",
      message: "only a terminal actor incarnation has a closed timestamp",
      path: ["closedAt"],
    });
  }
});

export type ActorIncarnationRecord = z.infer<
  typeof actorIncarnationRecordSchema
>;

export const persistedActorAttemptSchema = actorAttemptSchema.extend({
  effectGeneration: z.number().int().positive().safe().nullable(),
  providerTurnId: boundedProviderIdSchema.nullable(),
  continuationHistoryValueId: contextValueIdSchema.nullable(),
  tokenUsageIdentityDigest: digestSchema.nullable(),
  tokenUsageObservationGeneration:
    z.number().int().positive().safe().nullable(),
  tokenUsageStreamPosition: z.number().int().nonnegative().safe().nullable(),
  tokenUsageCumulativeInputTokens: z.number().int().nonnegative().safe().nullable(),
  tokenUsageCumulativeOutputTokens: z.number().int().nonnegative().safe().nullable(),
  tokenUsageCumulativeCachedInputTokens:
    z.number().int().nonnegative().safe().nullable(),
  tokenUsageCumulativeReasoningOutputTokens:
    z.number().int().nonnegative().safe().nullable(),
  inputTokens: z.number().int().nonnegative().safe().nullable(),
  outputTokens: z.number().int().nonnegative().safe().nullable(),
  cachedInputTokens: z.number().int().nonnegative().safe().nullable(),
  reasoningOutputTokens: z.number().int().nonnegative().safe().nullable(),
  requestedServiceTier: metaharnessTierSchema,
  realizedServiceTier: metaharnessTierSchema,
  tierFallbackReason: actorTierFallbackReasonSchema.nullable(),
  capabilityEvidenceDigest: digestSchema.nullable(),
  fastReservationId: actorFastReservationIdSchema.nullable(),
}).strict();

export type PersistedActorAttempt = z.infer<typeof persistedActorAttemptSchema>;

export const actorFastReservationRecordV2Schema = z.object({
  id: actorFastReservationIdSchema,
  attemptId: actorAttemptIdSchema,
  epochId: actorEpochIdSchema,
  rootActorId: actorIdSchema,
  actorId: actorIdSchema,
  accountProfileId: z.string().min(1).max(96),
  processGeneration: z.number().int().positive().safe(),
  state: z.enum([
    "reserved",
    "effectStarted",
    "released",
    "consumed",
    "quarantined",
  ]),
  terminalReason: z.enum([
    "preEffectTerminal",
    "definitiveNotApplied",
    "providerTerminal",
    "generationFenced",
    "ambiguousProviderEffect",
  ]).nullable(),
  fenceEvidenceDigest: digestSchema.nullable(),
  fencedGeneration: z.number().int().positive().safe().nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  effectStartedAt: isoTimestampSchema.nullable(),
  settledAt: isoTimestampSchema.nullable(),
  quarantinedAt: isoTimestampSchema.nullable(),
}).strict();

export type ActorFastReservationRecordV2 = z.infer<
  typeof actorFastReservationRecordV2Schema
>;

export const actorModelRerouteInboxRecordV2Schema = z.object({
  attemptId: actorAttemptIdSchema,
  providerIdentityDigest: digestSchema,
  observationGeneration: z.number().int().positive().safe(),
  streamPosition: z.number().int().nonnegative().safe(),
  fromModel: actorModelRerouteModelSchema,
  toModel: actorModelRerouteModelSchema,
  reason: actorModelRerouteReasonSchema,
  factDigest: digestSchema,
  state: z.enum(["pending", "bound", "quarantined", "settled"]),
  quarantineReason: actorModelRerouteQuarantineReasonSchema.nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  boundAt: isoTimestampSchema.nullable(),
  quarantinedAt: isoTimestampSchema.nullable(),
  settledAt: isoTimestampSchema.nullable(),
}).strict().superRefine((record, context) => {
  if ((record.state === "pending") !== (record.boundAt === null)) {
    context.addIssue({
      code: "custom",
      message: "only a pending reroute may lack an ownership binding",
      path: ["boundAt"],
    });
  }
  if ((record.quarantineReason === null) !== (record.quarantinedAt === null)) {
    context.addIssue({
      code: "custom",
      message: "reroute quarantine evidence must be complete",
      path: ["quarantineReason"],
    });
  }
  if (record.state === "quarantined" && record.quarantineReason === null) {
    context.addIssue({
      code: "custom",
      message: "a quarantined reroute requires a closed reason",
      path: ["quarantineReason"],
    });
  }
  if (
    (record.state === "pending" || record.state === "bound") &&
    record.quarantineReason !== null
  ) {
    context.addIssue({
      code: "custom",
      message: "an unsettled exact reroute cannot carry quarantine evidence",
      path: ["quarantineReason"],
    });
  }
  if ((record.state === "settled") !== (record.settledAt !== null)) {
    context.addIssue({
      code: "custom",
      message: "only a settled reroute has a settlement timestamp",
      path: ["settledAt"],
    });
  }
});

export type ActorModelRerouteInboxRecordV2 = z.infer<
  typeof actorModelRerouteInboxRecordV2Schema
>;

export const actorAccountLeaseRecordV2Schema = z.object({
  id: actorAccountLeaseIdSchema,
  incarnationId: actorIncarnationIdSchema,
  actorId: actorIdSchema,
  accountProfileId: z.string().min(1).max(96),
  processGeneration: z.number().int().positive().safe(),
  state: z.enum(["active", "released", "quarantined"]),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  settledAt: isoTimestampSchema.nullable(),
}).strict();

export type ActorAccountLeaseRecordV2 = z.infer<
  typeof actorAccountLeaseRecordV2Schema
>;

export interface ActorAttemptObservationBindingV2 {
  readonly attempt: PersistedActorAttempt;
  readonly admissionGeneration: number;
  readonly effectGeneration: number;
  readonly currentObservationGeneration: number;
  readonly sessionBindingRevision: number;
  readonly sessionRecoveryProofDigest: string;
}

export const actorWorkspaceBindingSchema = z.object({
  id: actorWorkspaceBindingIdSchema,
  actorId: actorIdSchema,
  laneId: laneIdSchema,
  authority: actorLaneAuthoritySchema,
  state: z.enum(["active", "released", "quarantined"]),
  revision: z.number().int().positive().safe(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  releasedAt: isoTimestampSchema.nullable(),
}).strict().superRefine((binding, context) => {
  if ((binding.state !== "active") !== (binding.releasedAt !== null)) {
    context.addIssue({
      code: "custom",
      message: "only an inactive workspace binding has a release timestamp",
      path: ["releasedAt"],
    });
  }
});

export type ActorWorkspaceBinding = z.infer<
  typeof actorWorkspaceBindingSchema
>;

export const actorPaneBindingSchema = z.object({
  id: actorPaneBindingIdSchema,
  actorId: actorIdSchema,
  paneId: paneIdSchema,
  state: z.enum(["attached", "detached"]),
  revision: z.number().int().positive().safe(),
  attachedAt: isoTimestampSchema,
  detachedAt: isoTimestampSchema.nullable(),
}).strict().superRefine((binding, context) => {
  if ((binding.state === "detached") !== (binding.detachedAt !== null)) {
    context.addIssue({
      code: "custom",
      message: "only a detached pane binding has a detach timestamp",
      path: ["detachedAt"],
    });
  }
});

export type ActorPaneBinding = z.infer<typeof actorPaneBindingSchema>;

export class HarnessSQLiteAuthorityV2Error extends Error {
  readonly code:
    | "budget_exhausted"
    | "conflict"
    | "corrupt_state"
    | "invalid_transition"
    | "lineage_conflict"
    | "not_found"
    | "revision_conflict";

  constructor(
    code: HarnessSQLiteAuthorityV2Error["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HarnessSQLiteAuthorityV2Error";
    this.code = code;
  }
}

export interface HarnessSQLiteAuthorityV2Options {
  readonly now?: () => Date;
  readonly tokenUsageIdentities?: ActorTokenUsageIdentityPortV2;
}

export class HarnessSQLiteAuthorityV2 {
  readonly #database: Database;
  readonly #now: () => Date;
  readonly #tokenUsageIdentities: ActorTokenUsageIdentityPortV2 | null;

  constructor(
    database: Database,
    options: HarnessSQLiteAuthorityV2Options = {},
  ) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#tokenUsageIdentities = options.tokenUsageIdentities ?? null;
  }

  createActorEpoch(inputValue: Readonly<{
    epoch: ActorEpoch;
    rootActor: Actor;
    dispatchPolicy?: Readonly<{
      policyVersion: 0 | 1;
      workClass: ActorDispatchPolicyRecordV2["workClass"];
    }>;
  }>): Readonly<{ epoch: ActorEpoch; rootActor: Actor }> {
    const epoch = actorEpochSchema.parse(inputValue.epoch);
    const root = actorSchema.parse(inputValue.rootActor);
    assertFreshEpochAndRoot(epoch, root);

    return this.#database.transaction(() => {
      const existingEpoch = this.#readEpoch(epoch.id);
      const existingActor = this.#readActor(root.id);
      if (existingEpoch !== null || existingActor !== null) {
        const expectedDispatch = parseActorDispatchPolicyInput(
          root.id,
          inputValue.dispatchPolicy,
        );
        if (
          existingEpoch !== null && existingActor !== null &&
          exactJson(existingEpoch) === exactJson(epoch) &&
          exactJson(existingActor) === exactJson(root) &&
          exactJson(this.readActorDispatchPolicy(root.id)) ===
            exactJson(expectedDispatch)
        ) {
          return { epoch: existingEpoch, rootActor: existingActor };
        }
        conflict("actor epoch identity already names different state");
      }

      this.#database.query(`
        INSERT INTO harness_actor_epochs (
          epoch_id, project_id, source_sha, root_actor_id,
          max_depth, max_active_descendants, max_durable_descendants,
          token_budget, byte_budget, deadline, lane_authority,
          token_reserved, byte_reserved, next_root_completion_sequence,
          state, revision, created_at, updated_at, stopped_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
          ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19
        )
      `).run(
        epoch.id,
        epoch.projectId,
        epoch.sourceSha,
        epoch.rootActorId,
        epoch.budget.maxDepth,
        epoch.budget.maxActiveDescendants,
        epoch.budget.maxDurableDescendants,
        epoch.budget.tokenBudget,
        epoch.budget.byteBudget,
        epoch.budget.deadline,
        epoch.budget.laneAuthority,
        epoch.tokenReserved,
        epoch.byteReserved,
        epoch.nextRootCompletionSequence,
        epoch.state,
        epoch.revision,
        epoch.createdAt,
        epoch.updatedAt,
        epoch.stoppedAt,
      );
      this.#insertActor(root, inputValue.dispatchPolicy);
      return {
        epoch: this.#requireEpoch(epoch.id),
        rootActor: this.#requireActor(root.id),
      };
    })();
  }

  createChildActor(
    actorValue: Actor,
    dispatchPolicy?: Readonly<{
      policyVersion: 0 | 1;
      workClass: ActorDispatchPolicyRecordV2["workClass"];
    }>,
  ): Actor {
    const actor = actorSchema.parse(actorValue);
    assertFreshChild(actor);
    return this.#database.transaction(() => {
      const existing = this.#readActor(actor.id);
      if (existing !== null) {
        const expectedDispatch = parseActorDispatchPolicyInput(
          actor.id,
          dispatchPolicy,
        );
        if (
          exactJson(existing) === exactJson(actor) &&
          exactJson(this.readActorDispatchPolicy(actor.id)) ===
            exactJson(expectedDispatch)
        ) return existing;
        conflict("actor identity already names different state");
      }
      const parentId = actor.parentActorId;
      if (parentId === null) lineage("a child actor requires a parent");
      const parent = this.#requireActor(parentId);
      const epoch = this.#requireEpoch(parent.epochId);
      if (actor.epochId !== parent.epochId || epoch.state !== "active") {
        lineage("child actor epoch does not match its active parent");
      }
      if (actor.depth !== parent.depth + 1) {
        lineage("child actor depth does not extend its parent by one");
      }
      try {
        deriveChildBudget(parent, actor.budget);
      } catch (cause: unknown) {
        if (cause instanceof ActorDomainError) {
          throw new HarnessSQLiteAuthorityV2Error(
            cause.code === "budget_exhausted"
              ? "budget_exhausted"
              : "lineage_conflict",
            cause.message,
            cause,
          );
        }
        throw cause;
      }
      this.#assertDescendantCapacity(parent.id);

      // The lineage trigger observes the pre-reservation remainder. The child
      // insert and the reservation CAS still commit in one SQLite transaction;
      // a failed CAS rolls the insert back rather than double-counting it.
      this.#insertActor(actor, dispatchPolicy);
      const reserved = this.#database.query(`
        UPDATE harness_actors SET
          token_reserved = token_reserved + ?2,
          byte_reserved = byte_reserved + ?3,
          revision = revision + 1,
          updated_at = ?4
        WHERE actor_id = ?1 AND state = 'active'
          AND token_reserved + ?2 <= token_budget
          AND byte_reserved + ?3 <= byte_budget
      `).run(
        parent.id,
        actor.budget.tokenBudget,
        actor.budget.byteBudget,
        actor.createdAt,
      );
      if (reserved.changes !== 1) {
        throw new HarnessSQLiteAuthorityV2Error(
          "budget_exhausted",
          "parent authority changed before the child reservation committed",
        );
      }
      return this.#requireActor(actor.id);
    })();
  }

  discardPristineChildActor(actorIdValue: string): boolean {
    const actorId = actorIdSchema.parse(actorIdValue);
    return this.#database.transaction(() => {
      const actor = this.#readActor(actorId);
      if (actor === null || actor.parentActorId === null) return false;
      const dependent: unknown = this.#database.query(`
        SELECT
          (SELECT COUNT(*) FROM harness_actor_turns WHERE actor_id = ?1) AS turns,
          (SELECT COUNT(*) FROM harness_actors WHERE parent_actor_id = ?1) AS children,
          (SELECT COUNT(*) FROM harness_actor_incarnations WHERE actor_id = ?1) AS incarnations,
          (SELECT COUNT(*) FROM harness_actor_workspace_bindings WHERE actor_id = ?1) AS bindings
      `).get(actorId);
      const counts = z.object({
        turns: z.number().int().nonnegative(),
        children: z.number().int().nonnegative(),
        incarnations: z.number().int().nonnegative(),
        bindings: z.number().int().nonnegative(),
      }).strict().parse(dependent);
      if (actor.parentActorId === null ||
        actor.state !== "active" || actor.tokenReserved !== 0 ||
        actor.byteReserved !== 0 || actor.nextTurnOrdinal !== 1 ||
        actor.nextResultOrdinal !== 1 || counts.turns !== 0 ||
        counts.children !== 0 || counts.incarnations !== 0 || counts.bindings !== 0
      ) return false;
      const parent = this.#requireActor(actor.parentActorId);
      const released = this.#database.query(`
        UPDATE harness_actors SET
          token_reserved = token_reserved - ?2,
          byte_reserved = byte_reserved - ?3,
          revision = revision + 1, updated_at = ?4
        WHERE actor_id = ?1 AND token_reserved >= ?2 AND byte_reserved >= ?3
      `).run(parent.id, actor.budget.tokenBudget, actor.budget.byteBudget, this.#timestamp(undefined));
      if (released.changes !== 1) {
        throw new HarnessSQLiteAuthorityV2Error(
          "corrupt_state",
          "parent reservation vanished before pristine child rollback",
        );
      }
      const removed = this.#database.query(
        "DELETE FROM harness_actors WHERE actor_id = ?1",
      ).run(actor.id);
      if (removed.changes !== 1) throw new HarnessSQLiteAuthorityV2Error(
        "revision_conflict", "pristine actor changed during rollback",
      );
      return true;
    })();
  }

  readActorEpoch(epochId: string): ActorEpoch | null {
    return this.#readEpoch(actorEpochIdSchema.parse(epochId));
  }

  readActor(actorId: string): Actor | null {
    return this.#readActor(actorIdSchema.parse(actorId));
  }

  readActorDispatchPolicy(actorIdValue: string): ActorDispatchPolicyRecordV2 {
    const actorId = actorIdSchema.parse(actorIdValue);
    const row: unknown = this.#database.query(`
      SELECT actor_id, dispatch_policy_version, work_class
      FROM harness_actors WHERE actor_id = ?1
    `).get(actorId);
    if (row === null) notFound("actor does not exist");
    const parsed = z.object({
      actor_id: actorIdSchema,
      dispatch_policy_version: z.union([z.literal(0), z.literal(1)]),
      work_class: actorDispatchWorkClassV2Schema,
    }).strict().parse(row);
    return actorDispatchPolicyRecordV2Schema.parse({
      actorId: parsed.actor_id,
      policyVersion: parsed.dispatch_policy_version,
      workClass: parsed.work_class,
    });
  }

  remainingActorTokens(actorIdValue: string): number {
    const actor = this.#requireActor(actorIdSchema.parse(actorIdValue));
    const usage: unknown = this.#database.query(`
      SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS consumed
      FROM harness_actor_turn_attempts
      WHERE turn_id IN (
        SELECT turn_id FROM harness_actor_turns WHERE actor_id = ?1
      ) AND state IN ('completed', 'failed', 'interrupted', 'quotaRejected')
    `).get(actor.id);
    const consumed = z.object({ consumed: z.number().int().nonnegative().safe() })
      .strict().parse(usage).consumed;
    const remaining = actor.budget.tokenBudget - actor.tokenReserved - consumed;
    if (remaining < 0) {
      throw new HarnessSQLiteAuthorityV2Error(
        "corrupt_state",
        "actor terminal token usage exceeds its unreserved budget",
      );
    }
    return remaining;
  }

  async recordActorTurnUsage(inputValue: Readonly<{
    accountProfileId: string;
    processGeneration: number;
    providerThreadId: string;
    providerTurnId: string;
    streamPosition: number;
    cumulativeInputTokens: number;
    cumulativeOutputTokens: number;
    cumulativeCachedInputTokens?: number | undefined;
    cumulativeReasoningOutputTokens?: number | undefined;
  }>): Promise<boolean> {
    const input = z.object({
      accountProfileId: z.string().min(1).max(96),
      processGeneration: z.number().int().positive(),
      providerThreadId: boundedProviderIdSchema,
      providerTurnId: boundedProviderIdSchema,
      streamPosition: z.number().int().nonnegative().safe(),
      cumulativeInputTokens: z.number().int().nonnegative().safe(),
      cumulativeOutputTokens: z.number().int().nonnegative().safe(),
      cumulativeCachedInputTokens:
        z.number().int().nonnegative().safe().optional(),
      cumulativeReasoningOutputTokens:
        z.number().int().nonnegative().safe().optional(),
    }).strict().superRefine((usage, context) => {
      if (
        (usage.cumulativeCachedInputTokens === undefined) !==
          (usage.cumulativeReasoningOutputTokens === undefined)
      ) {
        context.addIssue({
          code: "custom",
          message: "actor token breakdown evidence must be complete or absent",
          path: ["cumulativeCachedInputTokens"],
        });
      }
      if (
        usage.cumulativeCachedInputTokens !== undefined &&
        usage.cumulativeCachedInputTokens > usage.cumulativeInputTokens
      ) {
        context.addIssue({
          code: "custom",
          message: "cached input cannot exceed total input",
          path: ["cumulativeCachedInputTokens"],
        });
      }
      if (
        usage.cumulativeReasoningOutputTokens !== undefined &&
        usage.cumulativeReasoningOutputTokens > usage.cumulativeOutputTokens
      ) {
        context.addIssue({
          code: "custom",
          message: "reasoning output cannot exceed total output",
          path: ["cumulativeReasoningOutputTokens"],
        });
      }
    }).parse(inputValue);
    const boundOwnerRows: unknown[] = this.#database.query(`
      SELECT attempt.attempt_id, turn.epoch_id, turn.actor_id,
        attempt.incarnation_id,
        attempt.process_generation AS admission_generation
      FROM harness_actor_turn_attempts AS attempt
      JOIN harness_actor_incarnations AS incarnation
        ON incarnation.incarnation_id = attempt.incarnation_id
      JOIN harness_actor_turns AS turn ON turn.turn_id = attempt.turn_id
      LEFT JOIN harness_actor_session_bindings AS session
        ON session.incarnation_id = attempt.incarnation_id
      WHERE attempt.account_profile_id = ?1
        AND attempt.provider_turn_id = ?3
        AND incarnation.provider_thread_id = ?4
        AND (
          (session.incarnation_id IS NULL
            AND attempt.process_generation = ?2)
          OR (session.state = 'bound' AND session.live_generation >= ?2)
        )
      ORDER BY attempt.attempt_id LIMIT 2
    `).all(
      input.accountProfileId,
      input.processGeneration,
      input.providerTurnId,
      input.providerThreadId,
    );
    const ownerSchema = z.object({
      attempt_id: actorAttemptIdSchema,
      epoch_id: actorEpochIdSchema,
      actor_id: actorIdSchema,
      incarnation_id: actorIncarnationIdSchema,
      admission_generation: z.number().int().positive().safe(),
    }).strict();
    if (boundOwnerRows.length > 1) {
      throw new HarnessSQLiteAuthorityV2Error(
        "corrupt_state",
        "provider usage matches multiple bound actor attempts",
      );
    }
    let owner = boundOwnerRows[0] === undefined
      ? null
      : ownerSchema.parse(boundOwnerRows[0]);
    let bufferUntilSessionRecovery = false;
    if (owner === null) {
      const recoveryGapOwners: unknown[] = this.#database.query(`
        SELECT attempt.attempt_id, turn.epoch_id, turn.actor_id,
          attempt.incarnation_id,
          attempt.process_generation AS admission_generation
        FROM harness_actor_turn_attempts AS attempt
        JOIN harness_actor_incarnations AS incarnation
          ON incarnation.incarnation_id = attempt.incarnation_id
        JOIN harness_actor_turns AS turn ON turn.turn_id = attempt.turn_id
        JOIN harness_actor_session_bindings AS session
          ON session.incarnation_id = attempt.incarnation_id
        JOIN account_profiles AS profile
          ON profile.profile_id = attempt.account_profile_id
        WHERE attempt.account_profile_id = ?1
          AND attempt.provider_turn_id = ?3
          AND attempt.state IN ('starting', 'running', 'reconciling')
          AND incarnation.provider_thread_id = ?4
          AND incarnation.state IN ('idle', 'running')
          AND session.state = 'bound'
          AND session.actor_id = turn.actor_id
          AND session.account_profile_id = attempt.account_profile_id
          AND session.admission_generation = attempt.process_generation
          AND session.provider_thread_id = incarnation.provider_thread_id
          AND session.live_generation < ?2
          AND profile.process_generation = ?2
        ORDER BY attempt.attempt_id LIMIT 2
      `).all(
        input.accountProfileId,
        input.processGeneration,
        input.providerTurnId,
        input.providerThreadId,
      );
      if (recoveryGapOwners.length > 1) {
        throw new HarnessSQLiteAuthorityV2Error(
          "corrupt_state",
          "successor provider usage matches multiple recovering actor attempts",
        );
      }
      if (recoveryGapOwners[0] !== undefined) {
        owner = ownerSchema.parse(recoveryGapOwners[0]);
        bufferUntilSessionRecovery = true;
      }
    }
    if (owner === null) {
      const candidateOwners: unknown[] = this.#database.query(`
        SELECT attempt.attempt_id, turn.epoch_id, turn.actor_id,
          attempt.incarnation_id,
          attempt.process_generation AS admission_generation
        FROM harness_actor_turn_attempts AS attempt
        JOIN harness_actor_incarnations AS incarnation
          ON incarnation.incarnation_id = attempt.incarnation_id
        JOIN harness_actor_turns AS turn ON turn.turn_id = attempt.turn_id
        LEFT JOIN harness_actor_session_bindings AS session
          ON session.incarnation_id = attempt.incarnation_id
        WHERE attempt.account_profile_id = ?1
          AND attempt.provider_turn_id IS NULL
          AND attempt.state IN ('starting', 'reconciling')
          AND incarnation.provider_thread_id = ?3
          AND incarnation.state IN ('idle', 'running')
          AND (
            (session.incarnation_id IS NULL
              AND attempt.process_generation = ?2)
            OR (session.state = 'bound' AND session.live_generation = ?2)
          )
        ORDER BY attempt.attempt_id LIMIT 2
      `).all(
        input.accountProfileId,
        input.processGeneration,
        input.providerThreadId,
      );
      if (candidateOwners.length > 1) {
        throw new HarnessSQLiteAuthorityV2Error(
          "corrupt_state",
          "pre-binding provider usage matches multiple actor attempts",
        );
      }
      owner = candidateOwners[0] === undefined
        ? null
        : ownerSchema.parse(candidateOwners[0]);
    }
    if (owner === null) {
      const terminalUnbound: unknown = this.#database.query(`
        SELECT 1 AS present
        FROM harness_actor_turn_attempts AS attempt
        JOIN harness_actor_incarnations AS incarnation
          ON incarnation.incarnation_id = attempt.incarnation_id
        WHERE attempt.account_profile_id = ?1
          AND attempt.provider_turn_id IS NULL
          AND attempt.state IN (
            'completed', 'failed', 'quotaRejected', 'interrupted', 'ambiguous'
          )
          AND incarnation.provider_thread_id = ?3
          AND (
            NOT EXISTS (
              SELECT 1 FROM harness_actor_session_bindings AS session
              WHERE session.incarnation_id = incarnation.incarnation_id
                AND session.state = 'bound'
            ) AND attempt.process_generation = ?2
            OR EXISTS (
              SELECT 1 FROM harness_actor_session_bindings AS session
              WHERE session.incarnation_id = incarnation.incarnation_id
                AND session.state = 'bound'
                AND session.live_generation = ?2
            )
          )
        LIMIT 1
      `).get(
        input.accountProfileId,
        input.processGeneration,
        input.providerThreadId,
      );
      if (terminalUnbound !== null) {
        throw new HarnessSQLiteAuthorityV2Error(
          "corrupt_state",
          "provider usage arrived for a terminal unbound actor attempt",
        );
      }
      return false;
    }
    const identityDigest = await this.#digestActorTurnUsageIdentity({
      epochId: owner.epoch_id,
      actorId: owner.actor_id,
      accountProfileId: input.accountProfileId,
      processGeneration: owner.admission_generation,
      providerThreadId: input.providerThreadId,
      providerTurnId: input.providerTurnId,
    });
    if (bufferUntilSessionRecovery) {
      const buffered = this.#bufferActorTurnUsageUntilSessionRecovery({
        ...input,
        attemptId: owner.attempt_id,
        incarnationId: owner.incarnation_id,
        admissionGeneration: owner.admission_generation,
        providerIdentityDigest: identityDigest,
      });
      return buffered === "buffered"
        ? true
        : await this.recordActorTurnUsage(input);
    }
    const sessionBinding = this.#readActorSessionBinding(owner.incarnation_id);
    if (sessionBinding !== null) {
      const incarnation = this.#requireActorIncarnation(owner.incarnation_id);
      try {
        const disposition = cumulativeUsageDisposition({
          observation_generation:
            incarnation.tokenUsageObservationGeneration,
          stream_position: incarnation.tokenUsageLatestPosition,
          cumulative_input_tokens:
            incarnation.tokenUsageCumulativeInputTokens,
          cumulative_output_tokens:
            incarnation.tokenUsageCumulativeOutputTokens,
          cumulative_cached_input_tokens:
            incarnation.tokenUsageCumulativeCachedInputTokens,
          cumulative_reasoning_output_tokens:
            incarnation.tokenUsageCumulativeReasoningOutputTokens,
        }, input);
        const attempt = this.#requireActorAttempt(owner.attempt_id);
        if (
          disposition === "advance" && isTerminalActorAttemptState(attempt.state) &&
          (
            input.cumulativeInputTokens !==
              incarnation.tokenUsageCumulativeInputTokens ||
            input.cumulativeOutputTokens !==
              incarnation.tokenUsageCumulativeOutputTokens
          )
        ) {
          throw new HarnessSQLiteAuthorityV2Error(
            "corrupt_state",
            "terminal actor attempt received additional token usage",
          );
        }
      } catch (cause: unknown) {
        this.quarantineActorSessionBinding({
          incarnationId: sessionBinding.incarnationId,
          expectedRevision: sessionBinding.revision,
          reason: "token_evidence_regression",
          now: this.#now().toISOString(),
        });
        throw new HarnessSQLiteAuthorityV2Error(
          "corrupt_state",
          "actor token evidence contradicted its verified session successor",
          cause,
        );
      }
    }
    return this.#database.transaction(() => {
      const row: unknown = this.#database.query(`
        SELECT attempt.attempt_id, attempt.state,
          attempt.process_generation AS admission_generation,
          attempt.input_tokens, attempt.output_tokens,
          attempt.token_usage_identity_digest,
          attempt.token_usage_observation_generation,
          attempt.token_usage_stream_position,
          attempt.token_usage_cumulative_input_tokens,
          attempt.token_usage_cumulative_output_tokens,
          attempt.token_usage_cumulative_cached_input_tokens,
          attempt.token_usage_cumulative_reasoning_output_tokens,
          attempt.cached_input_tokens, attempt.reasoning_output_tokens,
          incarnation.provider_thread_id,
          incarnation.incarnation_id,
          incarnation.token_usage_observation_generation AS
            incarnation_usage_observation_generation,
          incarnation.token_usage_latest_position,
          incarnation.token_usage_cumulative_input_tokens AS
            incarnation_cumulative_input_tokens,
          incarnation.token_usage_cumulative_output_tokens AS
            incarnation_cumulative_output_tokens,
          incarnation.token_usage_cumulative_cached_input_tokens AS
            incarnation_cumulative_cached_input_tokens,
          incarnation.token_usage_cumulative_reasoning_output_tokens AS
            incarnation_cumulative_reasoning_output_tokens
        FROM harness_actor_turn_attempts AS attempt
        JOIN harness_actor_incarnations AS incarnation
          ON incarnation.incarnation_id = attempt.incarnation_id
        WHERE attempt.attempt_id = ?1
          AND attempt.provider_turn_id = ?2
      `).get(owner.attempt_id, input.providerTurnId);
      if (row !== null) {
        const previous = z.object({
          attempt_id: actorAttemptIdSchema,
          state: actorAttemptSchema.shape.state,
          admission_generation: z.number().int().positive().safe(),
          provider_thread_id: boundedProviderIdSchema,
          incarnation_id: actorIncarnationIdSchema,
          token_usage_identity_digest: digestSchema.nullable(),
          token_usage_observation_generation:
            z.number().int().positive().safe().nullable(),
          token_usage_stream_position:
            z.number().int().nonnegative().safe().nullable(),
          token_usage_cumulative_input_tokens:
            z.number().int().nonnegative().safe().nullable(),
          token_usage_cumulative_output_tokens:
            z.number().int().nonnegative().safe().nullable(),
          token_usage_cumulative_cached_input_tokens:
            z.number().int().nonnegative().safe().nullable(),
          token_usage_cumulative_reasoning_output_tokens:
            z.number().int().nonnegative().safe().nullable(),
          input_tokens: z.number().int().nonnegative().safe().nullable(),
          output_tokens: z.number().int().nonnegative().safe().nullable(),
          cached_input_tokens: z.number().int().nonnegative().safe().nullable(),
          reasoning_output_tokens:
            z.number().int().nonnegative().safe().nullable(),
          token_usage_latest_position:
            z.number().int().nonnegative().safe().nullable(),
          incarnation_usage_observation_generation:
            z.number().int().positive().safe(),
          incarnation_cumulative_input_tokens:
            z.number().int().nonnegative().safe(),
          incarnation_cumulative_output_tokens:
            z.number().int().nonnegative().safe(),
          incarnation_cumulative_cached_input_tokens:
            z.number().int().nonnegative().safe().nullable(),
          incarnation_cumulative_reasoning_output_tokens:
            z.number().int().nonnegative().safe().nullable(),
        }).strict().parse(row);
        const incarnationInput = previous.incarnation_cumulative_input_tokens;
        const incarnationOutput = previous.incarnation_cumulative_output_tokens;
        if (
          previous.provider_thread_id !== input.providerThreadId ||
          (previous.token_usage_identity_digest !== null &&
            previous.token_usage_identity_digest !== identityDigest)
        ) {
          throw new HarnessSQLiteAuthorityV2Error(
            "corrupt_state",
            "provider turn usage contradicts its actor thread lineage",
          );
        }
        const disposition = cumulativeUsageDisposition({
          observation_generation:
            previous.incarnation_usage_observation_generation,
          stream_position: previous.token_usage_latest_position,
          cumulative_input_tokens: incarnationInput,
          cumulative_output_tokens: incarnationOutput,
          cumulative_cached_input_tokens:
            previous.incarnation_cumulative_cached_input_tokens,
          cumulative_reasoning_output_tokens:
            previous.incarnation_cumulative_reasoning_output_tokens,
        }, input);
        if (disposition === "stale" || disposition === "duplicate") {
          return true;
        }
        if (
          previous.token_usage_identity_digest !== null &&
          (
            previous.token_usage_stream_position !==
              previous.token_usage_latest_position ||
            previous.token_usage_observation_generation !==
              previous.incarnation_usage_observation_generation ||
            previous.token_usage_cumulative_input_tokens !== incarnationInput ||
            previous.token_usage_cumulative_output_tokens !== incarnationOutput
          )
        ) {
          throw new HarnessSQLiteAuthorityV2Error(
            "corrupt_state",
            "provider usage advanced an actor attempt behind its thread watermark",
          );
        }
        const inputDelta = input.cumulativeInputTokens - incarnationInput;
        const outputDelta = input.cumulativeOutputTokens - incarnationOutput;
        const cachedInputComplete =
          previous.incarnation_cumulative_cached_input_tokens !== null &&
          (previous.token_usage_identity_digest === null ||
            previous.cached_input_tokens !== null);
        const reasoningOutputComplete =
          previous.incarnation_cumulative_reasoning_output_tokens !== null &&
          (previous.token_usage_identity_digest === null ||
            previous.reasoning_output_tokens !== null);
        const cachedInputDelta =
          input.cumulativeCachedInputTokens === undefined || !cachedInputComplete
            ? null
            : input.cumulativeCachedInputTokens -
              previous.incarnation_cumulative_cached_input_tokens!;
        const reasoningOutputDelta =
          input.cumulativeReasoningOutputTokens === undefined ||
            !reasoningOutputComplete
            ? null
            : input.cumulativeReasoningOutputTokens -
              previous.incarnation_cumulative_reasoning_output_tokens!;
        if (cachedInputDelta !== null && cachedInputDelta < 0) {
          throw new HarnessSQLiteAuthorityV2Error(
            "corrupt_state",
            "later provider usage regressed cached-input evidence",
          );
        }
        if (reasoningOutputDelta !== null && reasoningOutputDelta < 0) {
          throw new HarnessSQLiteAuthorityV2Error(
            "corrupt_state",
            "later provider usage regressed reasoning-output evidence",
          );
        }
        if (
          isTerminalActorAttemptState(previous.state) &&
          (inputDelta !== 0 || outputDelta !== 0)
        ) {
          throw new HarnessSQLiteAuthorityV2Error(
            "corrupt_state",
            "terminal actor attempt received additional token usage",
          );
        }
        const updated = this.#database.query(`
          UPDATE harness_actor_turn_attempts
          SET token_usage_identity_digest = ?4,
            token_usage_observation_generation = ?5,
            token_usage_stream_position = ?6,
            token_usage_cumulative_input_tokens = ?7,
            token_usage_cumulative_output_tokens = ?8,
            input_tokens = COALESCE(input_tokens, 0) + ?9,
            output_tokens = COALESCE(output_tokens, 0) + ?10,
            token_usage_cumulative_cached_input_tokens =
              COALESCE(?11, token_usage_cumulative_cached_input_tokens),
            token_usage_cumulative_reasoning_output_tokens =
              COALESCE(?12, token_usage_cumulative_reasoning_output_tokens),
            cached_input_tokens = CASE WHEN ?13 IS NULL THEN NULL
              ELSE COALESCE(cached_input_tokens, 0) + ?13 END,
            reasoning_output_tokens = CASE WHEN ?14 IS NULL THEN NULL
              ELSE COALESCE(reasoning_output_tokens, 0) + ?14 END
          WHERE attempt_id = ?1 AND process_generation = ?2
            AND provider_turn_id = ?3
        `).run(
          previous.attempt_id,
          previous.admission_generation,
          input.providerTurnId,
          identityDigest,
          input.processGeneration,
          input.streamPosition,
          input.cumulativeInputTokens,
          input.cumulativeOutputTokens,
          inputDelta,
          outputDelta,
          input.cumulativeCachedInputTokens ?? null,
          input.cumulativeReasoningOutputTokens ?? null,
          cachedInputDelta,
          reasoningOutputDelta,
        );
        if (updated.changes !== 1) revisionConflict();
        const watermark = this.#database.query(`
          UPDATE harness_actor_incarnations SET
            token_usage_observation_generation = ?2,
            token_usage_latest_position = ?3,
            token_usage_cumulative_input_tokens = ?4,
            token_usage_cumulative_output_tokens = ?5,
            token_usage_cumulative_cached_input_tokens =
              COALESCE(?6, token_usage_cumulative_cached_input_tokens),
            token_usage_cumulative_reasoning_output_tokens =
              COALESCE(?7, token_usage_cumulative_reasoning_output_tokens)
          WHERE incarnation_id = ?1
        `).run(
          previous.incarnation_id,
          input.processGeneration,
          input.streamPosition,
          input.cumulativeInputTokens,
          input.cumulativeOutputTokens,
          input.cumulativeCachedInputTokens ?? null,
          input.cumulativeReasoningOutputTokens ?? null,
        );
        if (watermark.changes !== 1) revisionConflict();
        return true;
      }

      const candidates: unknown[] = this.#database.query(`
        SELECT attempt.attempt_id,
          attempt.process_generation AS admission_generation,
          incarnation.incarnation_id,
          incarnation.token_usage_observation_generation,
          incarnation.token_usage_latest_position,
          incarnation.token_usage_cumulative_input_tokens,
          incarnation.token_usage_cumulative_output_tokens,
          incarnation.token_usage_cumulative_cached_input_tokens,
          incarnation.token_usage_cumulative_reasoning_output_tokens,
          incarnation.token_usage_cumulative_cached_input_tokens,
          incarnation.token_usage_cumulative_reasoning_output_tokens
        FROM harness_actor_turn_attempts AS attempt
        JOIN harness_actor_incarnations AS incarnation
          ON incarnation.incarnation_id = attempt.incarnation_id
        LEFT JOIN harness_actor_session_bindings AS session
          ON session.incarnation_id = incarnation.incarnation_id
        WHERE attempt.account_profile_id = ?1
          AND attempt.provider_turn_id IS NULL
          AND attempt.token_usage_identity_digest IS NULL
          AND attempt.token_usage_observation_generation IS NULL
          AND attempt.token_usage_stream_position IS NULL
          AND attempt.token_usage_cumulative_input_tokens IS NULL
          AND attempt.token_usage_cumulative_output_tokens IS NULL
          AND attempt.input_tokens IS NULL
          AND attempt.output_tokens IS NULL
          AND attempt.state IN ('starting', 'reconciling')
          AND incarnation.account_profile_id = ?1
          AND incarnation.provider_thread_id = ?3
          AND incarnation.state IN ('idle', 'running')
          AND (
            (session.incarnation_id IS NULL
              AND incarnation.process_generation = ?2)
            OR (session.state = 'bound' AND session.live_generation = ?2)
          )
        ORDER BY attempt.attempt_id LIMIT 2
      `).all(
        input.accountProfileId,
        input.processGeneration,
        input.providerThreadId,
      );
      if (candidates.length === 0) {
        const terminalUnbound: unknown[] = this.#database.query(`
          SELECT attempt.attempt_id
          FROM harness_actor_turn_attempts AS attempt
          JOIN harness_actor_incarnations AS incarnation
            ON incarnation.incarnation_id = attempt.incarnation_id
          WHERE attempt.account_profile_id = ?1
            AND attempt.provider_turn_id IS NULL
            AND attempt.state IN (
              'completed', 'failed', 'quotaRejected', 'interrupted', 'ambiguous'
            )
            AND incarnation.provider_thread_id = ?3
            AND (
              NOT EXISTS (
                SELECT 1 FROM harness_actor_session_bindings AS session
                WHERE session.incarnation_id = incarnation.incarnation_id
                  AND session.state = 'bound'
              ) AND attempt.process_generation = ?2
              OR EXISTS (
                SELECT 1 FROM harness_actor_session_bindings AS session
                WHERE session.incarnation_id = incarnation.incarnation_id
                  AND session.state = 'bound'
                  AND session.live_generation = ?2
              )
            )
          ORDER BY attempt.attempt_id LIMIT 2
        `).all(
          input.accountProfileId,
          input.processGeneration,
          input.providerThreadId,
        );
        if (terminalUnbound.length > 0) {
          throw new HarnessSQLiteAuthorityV2Error(
            "corrupt_state",
            "provider usage arrived for a terminal unbound actor attempt",
          );
        }
        return false;
      }
      if (candidates.length !== 1) {
        throw new HarnessSQLiteAuthorityV2Error(
          "corrupt_state",
          "pre-binding provider usage matches multiple actor attempts",
        );
      }
      const candidate = z.object({
        attempt_id: actorAttemptIdSchema,
        admission_generation: z.number().int().positive().safe(),
        incarnation_id: actorIncarnationIdSchema,
        token_usage_observation_generation:
          z.number().int().positive().safe(),
        token_usage_latest_position:
          z.number().int().nonnegative().safe().nullable(),
        token_usage_cumulative_input_tokens:
          z.number().int().nonnegative().safe(),
        token_usage_cumulative_output_tokens:
          z.number().int().nonnegative().safe(),
        token_usage_cumulative_cached_input_tokens:
          z.number().int().nonnegative().safe().nullable(),
        token_usage_cumulative_reasoning_output_tokens:
          z.number().int().nonnegative().safe().nullable(),
      }).strict().parse(candidates[0]);
      const watermarkDisposition = cumulativeUsageDisposition({
        observation_generation: candidate.token_usage_observation_generation,
        stream_position: candidate.token_usage_latest_position,
        cumulative_input_tokens:
          candidate.token_usage_cumulative_input_tokens,
        cumulative_output_tokens:
          candidate.token_usage_cumulative_output_tokens,
        cumulative_cached_input_tokens:
          candidate.token_usage_cumulative_cached_input_tokens,
        cumulative_reasoning_output_tokens:
          candidate.token_usage_cumulative_reasoning_output_tokens,
      }, input);
      if (
        watermarkDisposition === "stale" ||
        watermarkDisposition === "duplicate"
      ) return true;
      const inboxRows: unknown[] = this.#database.query(`
        SELECT attempt_id, provider_identity_digest, observation_generation,
          stream_position,
          cumulative_input_tokens, cumulative_output_tokens,
          cumulative_cached_input_tokens,
          cumulative_reasoning_output_tokens
        FROM harness_actor_turn_usage_inbox
        WHERE quarantined = 0
          AND (attempt_id = ?1 OR provider_identity_digest = ?2)
        ORDER BY attempt_id LIMIT 2
      `).all(
        candidate.attempt_id,
        identityDigest,
      );
      if (inboxRows.length > 1) {
        throw new HarnessSQLiteAuthorityV2Error(
          "corrupt_state",
          "provider usage identity is bound to another actor attempt",
        );
      }
      const inboxRow = inboxRows[0] ?? null;
      if (inboxRow !== null) {
        const previous = z.object({
          attempt_id: actorAttemptIdSchema,
          provider_identity_digest: digestSchema,
          observation_generation: z.number().int().positive().safe(),
          stream_position: z.number().int().nonnegative().safe(),
          cumulative_input_tokens: z.number().int().nonnegative().safe(),
          cumulative_output_tokens: z.number().int().nonnegative().safe(),
          cumulative_cached_input_tokens:
            z.number().int().nonnegative().safe().nullable(),
          cumulative_reasoning_output_tokens:
            z.number().int().nonnegative().safe().nullable(),
        }).strict().parse(inboxRow);
        if (
          previous.attempt_id !== candidate.attempt_id ||
          previous.provider_identity_digest !== identityDigest
        ) {
          throw new HarnessSQLiteAuthorityV2Error(
            "corrupt_state",
            "provider turn published conflicting pre-binding token usage",
          );
        }
        const disposition = cumulativeUsageDisposition({
          observation_generation: previous.observation_generation,
          stream_position: previous.stream_position,
          cumulative_input_tokens: previous.cumulative_input_tokens,
          cumulative_output_tokens: previous.cumulative_output_tokens,
          cumulative_cached_input_tokens:
            previous.cumulative_cached_input_tokens,
          cumulative_reasoning_output_tokens:
            previous.cumulative_reasoning_output_tokens,
        }, input);
        if (disposition === "stale" || disposition === "duplicate") {
          return true;
        }
        const updated = this.#database.query(`
          UPDATE harness_actor_turn_usage_inbox
          SET observation_generation = ?2,
            stream_position = ?3,
            cumulative_input_tokens = ?4,
            cumulative_output_tokens = ?5,
            cumulative_cached_input_tokens =
              COALESCE(?6, cumulative_cached_input_tokens),
            cumulative_reasoning_output_tokens =
              COALESCE(?7, cumulative_reasoning_output_tokens)
          WHERE attempt_id = ?1 AND quarantined = 0
        `).run(
          candidate.attempt_id,
          input.processGeneration,
          input.streamPosition,
          input.cumulativeInputTokens,
          input.cumulativeOutputTokens,
          input.cumulativeCachedInputTokens ?? null,
          input.cumulativeReasoningOutputTokens ?? null,
        );
        if (updated.changes !== 1) revisionConflict();
        return true;
      }
      this.#database.query(`
        INSERT INTO harness_actor_turn_usage_inbox (
          attempt_id, provider_identity_digest, observation_generation,
          stream_position,
          cumulative_input_tokens, cumulative_output_tokens,
          cumulative_cached_input_tokens,
          cumulative_reasoning_output_tokens
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      `).run(
        candidate.attempt_id,
        identityDigest,
        input.processGeneration,
        input.streamPosition,
        input.cumulativeInputTokens,
        input.cumulativeOutputTokens,
        input.cumulativeCachedInputTokens ?? null,
        input.cumulativeReasoningOutputTokens ?? null,
      );
      return true;
    })();
  }

  async recordActorModelReroute(inputValue: Readonly<{
    accountProfileId: string;
    observationGeneration: number;
    providerThreadId: string;
    providerTurnId: string;
    streamPosition: number;
    fromModel: string;
    toModel: string;
    reason: "highRiskCyberActivity";
    now?: string;
  }>): Promise<readonly ActorModelRerouteInboxRecordV2[]> {
    const input = z.object({
      accountProfileId: z.string().min(1).max(96),
      observationGeneration: z.number().int().positive().safe(),
      providerThreadId: boundedProviderIdSchema,
      providerTurnId: boundedProviderIdSchema,
      streamPosition: z.number().int().nonnegative().safe(),
      fromModel: actorModelRerouteModelSchema,
      toModel: actorModelRerouteModelSchema,
      reason: actorModelRerouteReasonSchema,
      now: isoTimestampSchema.optional(),
    }).strict().parse(inputValue);
    const candidates = this.#readActorModelRerouteCandidates(input);
    if (candidates.length === 0) return Object.freeze([]);
    const evidence = await Promise.all(candidates.map(async (candidate) => {
      const providerIdentityDigest = await this.#digestActorTurnUsageIdentity({
        epochId: candidate.epoch_id,
        actorId: candidate.actor_id,
        accountProfileId: input.accountProfileId,
        processGeneration: candidate.admission_generation,
        providerThreadId: input.providerThreadId,
        providerTurnId: input.providerTurnId,
      });
      return Object.freeze({
        candidate,
        providerIdentityDigest,
        factDigest: digestActorModelRerouteFact({
          providerIdentityDigest,
          observationGeneration: input.observationGeneration,
          streamPosition: input.streamPosition,
          fromModel: input.fromModel,
          toModel: input.toModel,
          reason: input.reason,
        }),
      });
    }));
    const now = this.#timestamp(input.now);
    return this.#database.transaction(() => {
      const current = this.#readActorModelRerouteCandidates(input);
      const initialIds = candidates.map(({ attempt_id }) => attempt_id);
      const currentIds = current.map(({ attempt_id }) => attempt_id);
      if (exactJson(initialIds) !== exactJson(currentIds)) {
        revisionConflict();
      }
      const ambiguous = current.length !== 1;
      const currentByAttemptId = new Map(
        current.map((candidate) => [candidate.attempt_id, candidate] as const),
      );
      const records = new Map<string, ActorModelRerouteInboxRecordV2>();
      const quarantine = (
        record: ActorModelRerouteInboxRecordV2,
        reason: z.infer<typeof actorModelRerouteQuarantineReasonSchema>,
      ): ActorModelRerouteInboxRecordV2 => {
        if (record.state === "settled" || record.state === "quarantined") {
          return record;
        }
        const changed = this.#database.query(`
          UPDATE harness_actor_model_reroute_inbox SET
            state = 'quarantined', quarantine_reason = ?2,
            updated_at = ?3, bound_at = COALESCE(bound_at, ?3),
            quarantined_at = ?3
          WHERE attempt_id = ?1 AND state IN ('pending', 'bound')
        `).run(record.attemptId, reason, now);
        if (changed.changes !== 1) revisionConflict();
        return this.#requireActorModelRerouteInbox(record.attemptId);
      };

      for (const item of evidence) {
        const candidate = currentByAttemptId.get(item.candidate.attempt_id);
        if (candidate === undefined) revisionConflict();
        const identityRows: unknown[] = this.#database.query(`
          SELECT * FROM harness_actor_model_reroute_inbox
          WHERE provider_identity_digest = ?1 AND attempt_id != ?2
          ORDER BY attempt_id LIMIT 128
        `).all(item.providerIdentityDigest, candidate.attempt_id);
        const identityConflicts = identityRows.map(
          parseActorModelRerouteInboxRow,
        );
        for (const conflictRecord of identityConflicts) {
          const quarantined = quarantine(
            conflictRecord,
            "provider_identity_conflict",
          );
          records.set(quarantined.attemptId, quarantined);
        }

        let record = this.#readActorModelRerouteInbox(candidate.attempt_id);
        if (record !== null) {
          const exactFact =
            record.providerIdentityDigest === item.providerIdentityDigest &&
            record.observationGeneration === input.observationGeneration &&
            record.streamPosition === input.streamPosition &&
            record.fromModel === input.fromModel &&
            record.toModel === input.toModel &&
            record.reason === input.reason &&
            record.factDigest === item.factDigest;
          if (!exactFact) {
            record = quarantine(record, "fact_conflict");
          } else if (ambiguous) {
            record = quarantine(record, "ambiguous_candidate");
          } else if (identityConflicts.length > 0) {
            record = quarantine(record, "provider_identity_conflict");
          }
          records.set(record.attemptId, record);
          continue;
        }

        const quarantined = ambiguous || identityConflicts.length > 0;
        const state = quarantined
          ? "quarantined"
          : candidate.provider_turn_id === null ? "pending" : "bound";
        const quarantineReason = ambiguous
          ? "ambiguous_candidate"
          : identityConflicts.length > 0
            ? "provider_identity_conflict"
            : null;
        this.#database.query(`
          INSERT INTO harness_actor_model_reroute_inbox (
            attempt_id, provider_identity_digest, observation_generation,
            stream_position, from_model, to_model, reason, fact_digest,
            state, quarantine_reason, created_at, updated_at, bound_at,
            quarantined_at, settled_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
            ?11, ?11, ?12, ?13, NULL
          )
        `).run(
          candidate.attempt_id,
          item.providerIdentityDigest,
          input.observationGeneration,
          input.streamPosition,
          input.fromModel,
          input.toModel,
          input.reason,
          item.factDigest,
          state,
          quarantineReason,
          now,
          state === "pending" ? null : now,
          quarantined ? now : null,
        );
        record = this.#requireActorModelRerouteInbox(candidate.attempt_id);
        records.set(record.attemptId, record);
      }
      return Object.freeze([...records.values()].toSorted((left, right) =>
        left.attemptId.localeCompare(right.attemptId)
      ));
    })();
  }

  readActorModelRerouteForAttempt(
    attemptIdValue: string,
  ): ActorModelRerouteInboxRecordV2 | null {
    return this.#readActorModelRerouteInbox(
      actorAttemptIdSchema.parse(attemptIdValue),
    );
  }

  listUnsettledActorModelReroutes(inputValue: Readonly<{
    after?: Readonly<{ updatedAt: string; attemptId: string }> | null;
    limit: number;
  }>): readonly ActorModelRerouteInboxRecordV2[] {
    const input = z.object({
      after: z.object({
        updatedAt: isoTimestampSchema,
        attemptId: actorAttemptIdSchema,
      }).strict().nullable().optional(),
      limit: z.number().int().min(1).max(128),
    }).strict().parse(inputValue);
    const after = input.after ?? null;
    const rows: unknown[] = this.#database.query(`
      SELECT * FROM harness_actor_model_reroute_inbox
      WHERE state IN ('bound', 'quarantined') AND (
        ?1 IS NULL OR updated_at > ?1
        OR (updated_at = ?1 AND attempt_id > ?2)
      )
      ORDER BY updated_at, attempt_id LIMIT ?3
    `).all(after?.updatedAt ?? null, after?.attemptId ?? null, input.limit);
    return Object.freeze(rows.map(parseActorModelRerouteInboxRow));
  }

  settleActorModelReroute(inputValue: Readonly<{
    attemptId: string;
    factDigest: string;
    expectedState: "bound" | "quarantined";
    now?: string;
  }>): ActorModelRerouteInboxRecordV2 {
    const input = z.object({
      attemptId: actorAttemptIdSchema,
      factDigest: digestSchema,
      expectedState: z.enum(["bound", "quarantined"]),
      now: isoTimestampSchema.optional(),
    }).strict().parse(inputValue);
    const current = this.#requireActorModelRerouteInbox(input.attemptId);
    if (current.factDigest !== input.factDigest) {
      lineage("actor model reroute fact digest changed before settlement");
    }
    if (current.state === "settled") return current;
    if (current.state !== input.expectedState) {
      invalidTransition("actor model reroute settlement CAS changed");
    }
    const now = this.#timestamp(input.now);
    const changed = this.#database.query(`
      UPDATE harness_actor_model_reroute_inbox SET
        state = 'settled', updated_at = ?3, settled_at = ?3
      WHERE attempt_id = ?1 AND fact_digest = ?2 AND state = ?4
    `).run(input.attemptId, input.factDigest, now, input.expectedState);
    if (changed.changes !== 1) revisionConflict();
    return this.#requireActorModelRerouteInbox(input.attemptId);
  }

  readActorTurnUsage(inputValue: Readonly<{
    accountProfileId: string;
    processGeneration: number;
    providerTurnId: string;
  }>): Readonly<{
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number | null;
    reasoningOutputTokens: number | null;
  }> | null {
    const input = z.object({
      accountProfileId: z.string().min(1),
      processGeneration: z.number().int().positive(),
      providerTurnId: z.string().min(1),
    }).strict().parse(inputValue);
    const row: unknown = this.#database.query(`
      SELECT input_tokens, output_tokens, cached_input_tokens,
        reasoning_output_tokens FROM harness_actor_turn_attempts
      WHERE account_profile_id = ?1 AND process_generation = ?2
        AND provider_turn_id = ?3
    `).get(input.accountProfileId, input.processGeneration, input.providerTurnId);
    if (row === null) return null;
    const usage = z.object({
        input_tokens: z.number().int().nonnegative().nullable(),
        output_tokens: z.number().int().nonnegative().nullable(),
        cached_input_tokens: z.number().int().nonnegative().nullable(),
        reasoning_output_tokens: z.number().int().nonnegative().nullable(),
    }).strict().parse(row);
    return usage.input_tokens === null || usage.output_tokens === null
      ? null
      : Object.freeze({
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cachedInputTokens: usage.cached_input_tokens,
          reasoningOutputTokens: usage.reasoning_output_tokens,
        });
  }

  readActorTurnUsageForObservation(inputValue: Readonly<{
    accountProfileId: string;
    observationGeneration: number;
    providerThreadId: string;
    providerTurnId: string;
  }>): Readonly<{
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number | null;
    reasoningOutputTokens: number | null;
  }> | null {
    const input = z.object({
      accountProfileId: z.string().min(1).max(96),
      observationGeneration: z.number().int().positive().safe(),
      providerThreadId: boundedProviderIdSchema,
      providerTurnId: boundedProviderIdSchema,
    }).strict().parse(inputValue);
    const rows: unknown[] = this.#database.query(`
      SELECT attempt.input_tokens, attempt.output_tokens,
        attempt.cached_input_tokens, attempt.reasoning_output_tokens
      FROM harness_actor_turn_attempts AS attempt
      JOIN harness_actor_incarnations AS incarnation
        ON incarnation.incarnation_id = attempt.incarnation_id
      LEFT JOIN harness_actor_session_bindings AS session
        ON session.incarnation_id = incarnation.incarnation_id
      WHERE attempt.account_profile_id = ?1
        AND attempt.provider_turn_id = ?2
        AND incarnation.provider_thread_id = ?3
        AND (
          (session.incarnation_id IS NULL
            AND attempt.process_generation = ?4)
          OR (session.state = 'bound' AND session.live_generation = ?4)
        )
      ORDER BY attempt.attempt_id
      LIMIT 2
    `).all(
      input.accountProfileId,
      input.providerTurnId,
      input.providerThreadId,
      input.observationGeneration,
    );
    if (rows.length > 1) {
      throw new HarnessSQLiteAuthorityV2Error(
        "corrupt_state",
        "provider usage observation matches multiple actor attempts",
      );
    }
    if (rows.length === 0) return null;
    const usage = z.object({
      input_tokens: z.number().int().nonnegative().safe().nullable(),
      output_tokens: z.number().int().nonnegative().safe().nullable(),
      cached_input_tokens: z.number().int().nonnegative().safe().nullable(),
      reasoning_output_tokens: z.number().int().nonnegative().safe().nullable(),
    }).strict().parse(rows[0]);
    return usage.input_tokens === null || usage.output_tokens === null
      ? null
      : Object.freeze({
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cachedInputTokens: usage.cached_input_tokens,
          reasoningOutputTokens: usage.reasoning_output_tokens,
        });
  }

  listActorChildren(inputValue: Readonly<{
    parentActorId: string;
    afterActorId?: string | null;
    limit: number;
  }>): readonly Actor[] {
    const parentActorId = actorIdSchema.parse(inputValue.parentActorId);
    const afterActorId = actorIdSchema.nullable()
      .parse(inputValue.afterActorId ?? null);
    const limit = z.number().int().min(1).max(51).parse(inputValue.limit);
    this.#requireActor(parentActorId);
    const rows: unknown[] = this.#database.query(`
      SELECT * FROM harness_actors
      WHERE parent_actor_id = ?1 AND actor_id > COALESCE(?2, '')
      ORDER BY actor_id LIMIT ?3
    `).all(parentActorId, afterActorId, limit);
    return rows.map((row) => parseActorRow(row));
  }

  requestActorStop(inputValue: Readonly<{
    actorId: string;
    expectedRevision: number;
    now?: string;
  }>): Actor {
    const actorId = actorIdSchema.parse(inputValue.actorId);
    const expectedRevision = z.number().int().positive().safe()
      .parse(inputValue.expectedRevision);
    const now = this.#timestamp(inputValue.now);
    const actor = this.#requireActor(actorId);
    if (
      actor.state === "stopRequested" &&
      (actor.revision === expectedRevision || actor.revision === expectedRevision + 1)
    ) return actor;
    if (actor.revision !== expectedRevision) revisionConflict();
    if (actor.state !== "active") invalidTransition("actor cannot accept stop intent");
    const changed = this.#database.query(`
      UPDATE harness_actors SET
        state = 'stopRequested', revision = revision + 1, updated_at = ?3
      WHERE actor_id = ?1 AND revision = ?2 AND state = 'active'
    `).run(actorId, expectedRevision, now);
    if (changed.changes !== 1) revisionConflict();
    return this.#requireActor(actorId);
  }

  settleActorStop(inputValue: Readonly<{
    actorId: string;
    expectedRevision: number;
    nextState: "stopped" | "quarantined";
    now?: string;
  }>): Actor {
    const actorId = actorIdSchema.parse(inputValue.actorId);
    const expectedRevision = z.number().int().positive().safe()
      .parse(inputValue.expectedRevision);
    const nextState = z.enum(["stopped", "quarantined"])
      .parse(inputValue.nextState);
    const now = this.#timestamp(inputValue.now);
    const actor = this.#requireActor(actorId);
    if (
      actor.state === nextState &&
      (actor.revision === expectedRevision || actor.revision === expectedRevision + 1)
    ) return actor;
    if (actor.revision !== expectedRevision) revisionConflict();
    if (actor.state !== "active" && actor.state !== "stopRequested") {
      invalidTransition("actor cannot settle from its current state");
    }
    if (this.#countLiveDescendants(actor.id) !== 0) {
      invalidTransition("actor cannot settle while a descendant remains live");
    }
    const next = transitionActor(actor, nextState, now);
    const changed = this.#database.query(`
      UPDATE harness_actors SET
        state = ?3, revision = ?4, updated_at = ?5, stopped_at = ?6
      WHERE actor_id = ?1 AND revision = ?2 AND state = ?7
    `).run(
      actorId,
      expectedRevision,
      next.state,
      next.revision,
      next.updatedAt,
      next.stoppedAt,
      actor.state,
    );
    if (changed.changes !== 1) revisionConflict();
    return this.#requireActor(actorId);
  }

  createActorTurn(inputValue: Readonly<{
    turnId: string;
    epochId: string;
    actorId: string;
    idempotencyKey: string;
    inputValueId: string;
    acceleration?: Readonly<
      | { mode: "standard" }
      | {
          mode: "fast";
          criticalPath: true;
          bottleneck: "reasoning" | "fileGeneration";
        }
    >;
    createdAt?: string;
  }>): ActorTurn {
    const turnId = actorTurnIdSchema.parse(inputValue.turnId);
    const epochId = actorEpochIdSchema.parse(inputValue.epochId);
    const actorId = actorIdSchema.parse(inputValue.actorId);
    const idempotencyKey = requestIdentitySchema.parse(inputValue.idempotencyKey);
    const inputValueId = z.string().min(1).max(96).parse(inputValue.inputValueId);
    const createdAt = this.#timestamp(inputValue.createdAt);
    const acceleration = parseActorTurnAccelerationInput(
      turnId,
      inputValue.acceleration,
    );

    return this.#database.transaction(() => {
      const byId = this.#readTurn(turnId);
      const byKey = this.#readTurnByIdempotencyKey(actorId, idempotencyKey);
      if (byId !== null || byKey !== null) {
        if (
          byId !== null && byKey !== null && byId.id === byKey.id &&
          byId.epochId === epochId && byId.actorId === actorId &&
          byId.idempotencyKey === idempotencyKey &&
          byId.inputValueId === inputValueId &&
          exactJson(this.readActorTurnAcceleration(turnId)) ===
            exactJson(acceleration)
        ) {
          return byId;
        }
        conflict("logical turn idempotency identity is already bound");
      }

      const actor = this.#requireActor(actorId);
      if (actor.epochId !== epochId || actor.state !== "active") {
        lineage("a logical turn requires its active owning actor");
      }
      const ordinal = actor.nextTurnOrdinal;
      const advanced = this.#database.query(`
        UPDATE harness_actors SET
          next_turn_ordinal = next_turn_ordinal + 1,
          revision = revision + 1,
          updated_at = ?3
        WHERE actor_id = ?1 AND revision = ?2 AND state = 'active'
      `).run(actorId, actor.revision, createdAt);
      if (advanced.changes !== 1) revisionConflict();

      this.#database.query(`
        INSERT INTO harness_actor_turns (
          turn_id, epoch_id, actor_id, ordinal, idempotency_key,
          input_value_id, state, desired_state, revision, created_at,
          started_at, settled_at, outcome_code, acceleration_mode,
          acceleration_critical_path, acceleration_bottleneck
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, 'prepared', 'run', 1, ?7,
          NULL, NULL, NULL, ?8, ?9, ?10
        )
      `).run(
        turnId,
        epochId,
        actorId,
        ordinal,
        idempotencyKey,
        inputValueId,
        createdAt,
        acceleration.mode,
        acceleration.mode === "fast" ? 1 : 0,
        acceleration.mode === "fast" ? acceleration.bottleneck : "none",
      );
      return this.#requireTurn(turnId);
    })();
  }

  readActorTurn(turnId: string): ActorTurn | null {
    return this.#readTurn(actorTurnIdSchema.parse(turnId));
  }

  readActorTurnAcceleration(
    turnIdValue: string,
  ): ActorTurnAccelerationRecordV2 {
    const turnId = actorTurnIdSchema.parse(turnIdValue);
    const row: unknown = this.#database.query(`
      SELECT turn_id, acceleration_mode, acceleration_critical_path,
        acceleration_bottleneck
      FROM harness_actor_turns WHERE turn_id = ?1
    `).get(turnId);
    if (row === null) notFound("actor turn does not exist");
    const parsed = z.object({
      turn_id: actorTurnIdSchema,
      acceleration_mode: z.enum(["standard", "fast"]),
      acceleration_critical_path: z.union([z.literal(0), z.literal(1)]),
      acceleration_bottleneck: actorAccelerationBottleneckSchema,
    }).strict().parse(row);
    return actorTurnAccelerationRecordV2Schema.parse(
      parsed.acceleration_mode === "standard"
        ? { turnId: parsed.turn_id, mode: "standard" }
        : {
            turnId: parsed.turn_id,
            mode: "fast",
            criticalPath: parsed.acceleration_critical_path === 1,
            bottleneck: parsed.acceleration_bottleneck,
          },
    );
  }

  /**
   * Returns the exact immediately prior terminal logical turn for context
   * anchoring. A gap or live predecessor is corrupt durable lineage rather
   * than permission to expose an unanchored provider history prefix.
   */
  readActorCompletedThroughTurnId(turnIdValue: string): string | null {
    const turnId = actorTurnIdSchema.parse(turnIdValue);
    const current = this.#readTurn(turnId);
    if (current === null) notFound("actor turn does not exist");
    if (current.ordinal === 1) return null;
    const row: unknown = this.#database.query(`
      SELECT * FROM harness_actor_turns
      WHERE actor_id = ?1 AND ordinal = ?2
      ORDER BY turn_id LIMIT 1
    `).get(current.actorId, current.ordinal - 1);
    if (row === null) {
      throw new HarnessSQLiteAuthorityV2Error(
        "corrupt_state",
        "actor turn history has an ordinal gap",
      );
    }
    const prior = parseActorTurnRow(row);
    if (
      prior.epochId !== current.epochId ||
      !isTerminalActorTurnState(prior.state)
    ) {
      throw new HarnessSQLiteAuthorityV2Error(
        "corrupt_state",
        "actor turn history has no terminal completed-prefix anchor",
      );
    }
    return prior.id;
  }

  transitionActorTurn(inputValue: Readonly<{
    turnId: string;
    expectedRevision: number;
    nextState: ActorTurnState;
    outcomeCode?: string | null;
    now?: string;
  }>): ActorTurn {
    const turnId = actorTurnIdSchema.parse(inputValue.turnId);
    const expectedRevision = z.number().int().positive().safe()
      .parse(inputValue.expectedRevision);
    const nextState = actorTurnSchema.shape.state.parse(inputValue.nextState);
    const outcomeCode = inputValue.outcomeCode === undefined
      ? null
      : z.string().min(1).max(96).nullable().parse(inputValue.outcomeCode);
    const now = this.#timestamp(inputValue.now);
    const current = this.#requireTurn(turnId);
    if (current.revision !== expectedRevision) revisionConflict();
    const next = transitionActorTurn(current, nextState, now, outcomeCode);
    const changed = this.#database.query(`
      UPDATE harness_actor_turns SET
        state = ?3, revision = ?4, started_at = ?5,
        settled_at = ?6, outcome_code = ?7
      WHERE turn_id = ?1 AND revision = ?2 AND state = ?8
    `).run(
      turnId,
      expectedRevision,
      next.state,
      next.revision,
      next.startedAt,
      next.settledAt,
      next.outcomeCode,
      current.state,
    );
    if (changed.changes !== 1) revisionConflict();
    return this.#requireTurn(turnId);
  }

  requestActorTurnStop(inputValue: Readonly<{
    turnId: string;
    expectedRevision: number;
  }>): ActorTurn {
    const turnId = actorTurnIdSchema.parse(inputValue.turnId);
    const expectedRevision = z.number().int().positive().safe()
      .parse(inputValue.expectedRevision);
    const turn = this.#requireTurn(turnId);
    if (turn.revision !== expectedRevision) revisionConflict();
    if (turn.desiredState === "stop") return turn;
    if (isTerminalActorTurnState(turn.state)) {
      invalidTransition("a settled logical turn cannot accept stop intent");
    }
    const changed = this.#database.query(`
      UPDATE harness_actor_turns SET
        desired_state = 'stop', revision = revision + 1
      WHERE turn_id = ?1 AND revision = ?2 AND desired_state = 'run'
    `).run(turnId, expectedRevision);
    if (changed.changes !== 1) revisionConflict();
    return this.#requireTurn(turnId);
  }

  prepareActorOperation(inputValue: Readonly<{
    operationId: string;
    actorId: string;
    turnId: string | null;
    kind: ActorOperationRecord["kind"];
    requestDigest: string;
    effectKey: string;
    providerIdentityJson: string;
    createdAt?: string;
  }>): ActorOperationRecord {
    const operationId = actorOperationIdSchema.parse(inputValue.operationId);
    const actorId = actorIdSchema.parse(inputValue.actorId);
    const turnId = actorTurnIdSchema.nullable().parse(inputValue.turnId);
    const kind = actorOperationKindSchema.parse(inputValue.kind);
    const requestDigest = digestSchema.parse(inputValue.requestDigest);
    const effectKey = digestSchema.parse(inputValue.effectKey);
    const providerIdentityJson = parseProviderIdentityJson(
      inputValue.providerIdentityJson,
    );
    const createdAt = this.#timestamp(inputValue.createdAt);
    const proposed = actorOperationRecordSchema.parse({
      id: operationId,
      actorId,
      turnId,
      kind,
      requestDigest,
      effectKey,
      state: "prepared",
      providerIdentityJson,
      createdAt,
      updatedAt: createdAt,
      settledAt: null,
    });

    return this.#database.transaction(() => {
      const existing = this.#readActorOperation(operationId);
      if (existing !== null) {
        if (
          existing.actorId === actorId && existing.turnId === turnId &&
          existing.kind === kind && existing.requestDigest === requestDigest &&
          existing.effectKey === effectKey &&
          existing.providerIdentityJson === providerIdentityJson
        ) return existing;
        conflict("actor operation identity already names another effect");
      }
      const actor = this.#requireActor(actorId);
      if (actor.state === "stopped" || actor.state === "quarantined") {
        invalidTransition("terminal actors cannot prepare provider operations");
      }
      if (turnId !== null) {
        const turn = this.#requireTurn(turnId);
        if (turn.actorId !== actorId || turn.epochId !== actor.epochId) {
          lineage("actor operation turn belongs to another actor");
        }
      }
      this.#database.query(`
        INSERT INTO harness_actor_operations (
          operation_id, actor_id, turn_id, kind, request_digest, effect_key,
          state, provider_identity_json, created_at, updated_at, settled_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'prepared', ?7, ?8, ?8, NULL)
      `).run(
        operationId,
        actorId,
        turnId,
        kind,
        requestDigest,
        effectKey,
        providerIdentityJson,
        createdAt,
      );
      return this.#readActorOperation(operationId) ?? proposed;
    })();
  }

  rebasePreparedActorOperation(inputValue: Readonly<{
    operationId: string;
    expectedRequestDigest: string;
    requestDigest: string;
    effectKey: string;
    providerIdentityJson: string;
    now?: string;
  }>): ActorOperationRecord {
    const operationId = actorOperationIdSchema.parse(inputValue.operationId);
    const expectedRequestDigest = digestSchema.parse(
      inputValue.expectedRequestDigest,
    );
    const requestDigest = digestSchema.parse(inputValue.requestDigest);
    const effectKey = digestSchema.parse(inputValue.effectKey);
    const providerIdentityJson = parseProviderIdentityJson(
      inputValue.providerIdentityJson,
    );
    const now = this.#timestamp(inputValue.now);
    const current = this.#requireActorOperation(operationId);
    if (
      current.state !== "prepared" ||
      current.requestDigest !== expectedRequestDigest ||
      current.effectKey !== effectKey
    ) {
      invalidTransition("prepared actor operation rebase fence changed");
    }
    const changed = this.#database.query(`
      UPDATE harness_actor_operations SET
        request_digest = ?3,
        provider_identity_json = ?4,
        updated_at = ?5
      WHERE operation_id = ?1
        AND state = 'prepared'
        AND request_digest = ?2
        AND effect_key = ?6
    `).run(
      operationId,
      expectedRequestDigest,
      requestDigest,
      providerIdentityJson,
      now,
      effectKey,
    );
    if (changed.changes !== 1) {
      invalidTransition("prepared actor operation rebase fence changed");
    }
    return this.#requireActorOperation(operationId);
  }

  transitionActorOperation(inputValue: Readonly<{
    operationId: string;
    expectedState: ActorOperationRecord["state"];
    nextState: ActorOperationRecord["state"];
    providerIdentityJson?: string | null;
    now?: string;
  }>): ActorOperationRecord {
    const operationId = actorOperationIdSchema.parse(inputValue.operationId);
    const expectedState = actorOperationStateSchema.parse(inputValue.expectedState);
    const nextState = actorOperationStateSchema.parse(inputValue.nextState);
    const providerIdentityJson = inputValue.providerIdentityJson === undefined
      ? undefined
      : parseProviderIdentityJson(inputValue.providerIdentityJson);
    const now = this.#timestamp(inputValue.now);
    assertOperationTransition(expectedState, nextState);
    const current = this.#requireActorOperation(operationId);
    if (current.state !== expectedState) {
      invalidTransition("actor operation CAS state changed");
    }
    const nextProviderIdentityJson = providerIdentityJson === undefined
      ? current.providerIdentityJson
      : providerIdentityJson;
    const terminal = isTerminalOperationState(nextState);
    const changed = this.#database.query(`
      UPDATE harness_actor_operations SET
        state = ?3,
        provider_identity_json = ?4,
        updated_at = ?5,
        settled_at = ?6
      WHERE operation_id = ?1 AND state = ?2
    `).run(
      operationId,
      expectedState,
      nextState,
      nextProviderIdentityJson,
      now,
      terminal ? now : null,
    );
    if (changed.changes !== 1) {
      const existing = this.#readActorOperation(operationId);
      if (existing === null) notFound("actor operation does not exist");
      invalidTransition("actor operation CAS state changed");
    }
    return this.#requireActorOperation(operationId);
  }

  readActorOperation(operationId: string): ActorOperationRecord | null {
    return this.#readActorOperation(actorOperationIdSchema.parse(operationId));
  }

  listRecoverableActorOperations(inputValue: Readonly<{
    afterOperationId?: string | null;
    limit: number;
  }>): readonly ActorOperationRecord[] {
    const afterOperationId = actorOperationIdSchema.nullable()
      .parse(inputValue.afterOperationId ?? null);
    const limit = z.number().int().min(1).max(128).parse(inputValue.limit);
    const rows: unknown[] = this.#database.query(`
      SELECT * FROM harness_actor_operations
      WHERE operation_id > COALESCE(?1, '')
        AND (
          state IN ('prepared', 'effectStarted', 'ambiguous', 'recoveryRequired')
          OR (
            state = 'succeeded' AND kind = 'actorStart'
            AND (
              NOT EXISTS (
                SELECT 1 FROM harness_actor_incarnations AS incarnation
                WHERE incarnation.start_operation_id =
                  harness_actor_operations.operation_id
              )
              OR EXISTS (
                SELECT 1 FROM harness_actor_incarnations AS incarnation
                WHERE incarnation.start_operation_id =
                    harness_actor_operations.operation_id
                  AND incarnation.state IN ('starting', 'idle')
                  AND NOT EXISTS (
                    SELECT 1 FROM harness_actor_session_bindings AS session
                    WHERE session.incarnation_id = incarnation.incarnation_id
                      AND session.state = 'bound'
                      AND session.actor_id = incarnation.actor_id
                      AND session.account_profile_id = incarnation.account_profile_id
                      AND session.admission_generation =
                        incarnation.process_generation
                      AND session.provider_thread_id = incarnation.provider_thread_id
                  )
              )
            )
          )
        )
      ORDER BY operation_id LIMIT ?2
    `).all(afterOperationId, limit);
    return rows.map((row) => parseActorOperationRow(row));
  }

  readActorReconciliationTarget(inputValue: Readonly<{
    target: ActorReconciliationTargetV2;
    limit: number;
  }>): Readonly<{
    operations: readonly ActorOperationRecord[];
    attempts: readonly PersistedActorAttempt[];
    turns: readonly ActorTurn[];
  }> {
    const target = actorReconciliationTargetV2Schema.parse(inputValue.target);
    const limit = z.number().int().min(1).max(4_097).parse(inputValue.limit);
    const operationTarget = actorReconciliationTargetPredicate(
      target,
      "operation",
    );
    const attemptTarget = actorReconciliationTargetPredicate(target, "attempt");
    const turnTarget = actorReconciliationTargetPredicate(target, "turn");
    const operationRows: unknown[] = this.#database.query(`
      SELECT operation.* FROM harness_actor_operations AS operation
      WHERE (
        operation.state IN (
          'prepared', 'effectStarted', 'ambiguous', 'recoveryRequired'
        )
        OR (
          operation.state = 'succeeded' AND operation.kind = 'actorStart'
          AND (
            NOT EXISTS (
              SELECT 1 FROM harness_actor_incarnations AS incarnation
              WHERE incarnation.start_operation_id = operation.operation_id
            )
            OR EXISTS (
              SELECT 1 FROM harness_actor_incarnations AS incarnation
              WHERE incarnation.start_operation_id = operation.operation_id
                AND incarnation.state IN ('starting', 'idle')
                AND NOT EXISTS (
                  SELECT 1 FROM harness_actor_session_bindings AS session
                  WHERE session.incarnation_id = incarnation.incarnation_id
                    AND session.state = 'bound'
                    AND session.actor_id = incarnation.actor_id
                    AND session.account_profile_id =
                      incarnation.account_profile_id
                    AND session.admission_generation =
                      incarnation.process_generation
                    AND session.provider_thread_id =
                      incarnation.provider_thread_id
                )
            )
          )
        )
      ) AND (${operationTarget.sql})
      ORDER BY operation.operation_id LIMIT ?
    `).all(...operationTarget.parameters, limit);
    const attemptRows: unknown[] = this.#database.query(`
      SELECT attempt.* FROM harness_actor_turn_attempts AS attempt
      WHERE attempt.state IN ('starting', 'running', 'reconciling')
        AND (${attemptTarget.sql})
      ORDER BY attempt.attempt_id LIMIT ?
    `).all(...attemptTarget.parameters, limit);
    const turnRows: unknown[] = this.#database.query(`
      SELECT turn.* FROM harness_actor_turns AS turn
      WHERE turn.state IN ('prepared', 'starting', 'running', 'reconciling')
        AND (${turnTarget.sql})
      ORDER BY turn.turn_id LIMIT ?
    `).all(...turnTarget.parameters, limit);
    return Object.freeze({
      operations: Object.freeze(operationRows.map(parseActorOperationRow)),
      attempts: Object.freeze(attemptRows.map(parseActorAttemptRow)),
      turns: Object.freeze(turnRows.map(parseActorTurnRow)),
    });
  }

  createActorIncarnation(inputValue: Readonly<{
    incarnationId: string;
    actorId: string;
    accountProfileId: string;
    processGeneration: number;
    startOperationId: string;
    clientRequestId: string;
    threadSource: string;
    toolsetDigest: string;
    profile?: Readonly<RealizedActorProfile & {
      profileFallbackReason: "lunaUnavailable" | null;
      capabilityEvidenceDigest: string | null;
      supportsFast: boolean | null;
    }>;
    createdAt?: string;
  }>): ActorIncarnationRecord {
    const incarnationId = actorIncarnationIdSchema.parse(inputValue.incarnationId);
    const actorId = actorIdSchema.parse(inputValue.actorId);
    const accountProfileId = z.string().min(1).max(96)
      .parse(inputValue.accountProfileId);
    const processGeneration = z.number().int().positive().safe()
      .parse(inputValue.processGeneration);
    const startOperationId = actorOperationIdSchema.parse(inputValue.startOperationId);
    const clientRequestId = requestIdentitySchema.parse(inputValue.clientRequestId);
    const threadSource = z.string().min(16).max(256)
      .refine((value) => !value.includes("\0"), "thread source contains NUL")
      .parse(inputValue.threadSource);
    const toolsetDigest = digestSchema.parse(inputValue.toolsetDigest);
    const profile = z.object({
      modelId: actorModelProfileSchema,
      reasoningEffort: actorReasoningEffortSchema,
      profileFallbackReason: actorProfileFallbackReasonSchema.nullable(),
      capabilityEvidenceDigest: digestSchema.nullable(),
      supportsFast: z.boolean().nullable(),
    }).strict().parse(inputValue.profile ?? {
      modelId: HRA_SOL_MODEL,
      reasoningEffort: "ultra",
      profileFallbackReason: null,
      capabilityEvidenceDigest: null,
      supportsFast: null,
    });
    const createdAt = this.#timestamp(inputValue.createdAt);

    return this.#database.transaction(() => {
      const existing = this.#readActorIncarnation(incarnationId);
      if (existing !== null) {
        if (
          existing.actorId === actorId &&
          existing.accountProfileId === accountProfileId &&
          existing.processGeneration === processGeneration &&
          existing.startOperationId === startOperationId &&
          existing.clientRequestId === clientRequestId &&
          existing.threadSource === threadSource &&
          existing.toolsetDigest === toolsetDigest &&
          existing.requestedModel === profile.modelId &&
          existing.requestedReasoningEffort === profile.reasoningEffort &&
          existing.profileFallbackReason === profile.profileFallbackReason &&
          existing.capabilityEvidenceDigest === profile.capabilityEvidenceDigest &&
          existing.supportsFast === profile.supportsFast
        ) return existing;
        conflict("actor incarnation identity already names another launch");
      }
      const actor = this.#requireActor(actorId);
      if (actor.state !== "active") {
        invalidTransition("only an active actor may create an incarnation");
      }
      const operation = this.#requireActorOperation(startOperationId);
      if (
        operation.actorId !== actorId || operation.kind !== "actorStart" ||
        operation.turnId !== null ||
        (operation.state !== "prepared" &&
          operation.state !== "effectStarted" && operation.state !== "succeeded")
      ) {
        lineage("incarnation launch operation is not a live actor start");
      }
      const ordinalValue: unknown = this.#database.query(`
        SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal
        FROM harness_actor_incarnations WHERE actor_id = ?1
      `).get(actorId);
      const ordinal = z.object({ ordinal: z.number().int().positive().safe() })
        .strict().parse(ordinalValue).ordinal;
      this.#database.query(`
        INSERT INTO harness_actor_incarnations (
          incarnation_id, actor_id, ordinal, account_profile_id,
          process_generation, start_operation_id, client_request_id,
          thread_source, provider_thread_id,
          token_usage_observation_generation,
          token_usage_cumulative_cached_input_tokens,
          token_usage_cumulative_reasoning_output_tokens,
          requested_model, requested_reasoning_effort,
          profile_fallback_reason, capability_evidence_digest, supports_fast,
          toolset_digest, state,
          created_at, updated_at, closed_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?5, 0, 0,
          ?9, ?10, ?11, ?12, ?13, ?14, 'starting', ?15, ?15, NULL
        )
      `).run(
        incarnationId,
        actorId,
        ordinal,
        accountProfileId,
        processGeneration,
        startOperationId,
        clientRequestId,
        threadSource,
        profile.modelId,
        profile.reasoningEffort,
        profile.profileFallbackReason,
        profile.capabilityEvidenceDigest,
        profile.supportsFast ? 1 : profile.supportsFast === false ? 0 : null,
        toolsetDigest,
        createdAt,
      );
      return this.#requireActorIncarnation(incarnationId);
    })();
  }

  createActorIncarnationWithAccountLease(inputValue: Readonly<{
    leaseId: string;
    incarnationId: string;
    actorId: string;
    candidates: readonly Readonly<{
      accountProfileId: string;
      processGeneration: number;
      profile: Readonly<RealizedActorProfile & {
        profileFallbackReason: "lunaUnavailable" | null;
        capabilityEvidenceDigest: string;
        supportsFast: boolean;
      }>;
      routingPriority: Readonly<{
        profileFallbackRank: 0 | 1;
        budgetRank: 0 | 1 | 2;
        remainingHeadroomRank: number;
        rendezvousScore: string;
        selected: boolean;
      }>;
      operationRequest: Readonly<{
        requestDigest: string;
        effectKey: string;
        providerIdentityJson: string;
      }>;
    }>[];
    startOperationId: string;
    clientRequestId: string;
    threadSource: string;
    toolsetDigest: string;
    createdAt?: string;
  }>): Readonly<{
    incarnation: ActorIncarnationRecord;
    accountLease: ActorAccountLeaseRecordV2;
    activeLoad: number;
  }> {
    const input = z.object({
      leaseId: actorAccountLeaseIdSchema,
      incarnationId: actorIncarnationIdSchema,
      actorId: actorIdSchema,
      candidates: z.array(z.object({
        accountProfileId: z.string().min(1).max(96),
        processGeneration: z.number().int().positive().safe(),
        profile: z.object({
          modelId: actorModelProfileSchema,
          reasoningEffort: actorReasoningEffortSchema,
          profileFallbackReason: actorProfileFallbackReasonSchema.nullable(),
          capabilityEvidenceDigest: digestSchema,
          supportsFast: z.boolean(),
        }).strict(),
        routingPriority: z.object({
          profileFallbackRank: z.union([z.literal(0), z.literal(1)]),
          budgetRank: z.union([
            z.literal(0), z.literal(1), z.literal(2),
          ]),
          remainingHeadroomRank: z.number().min(0).max(101),
          rendezvousScore: digestSchema,
          selected: z.boolean(),
        }).strict(),
        operationRequest: z.object({
          requestDigest: digestSchema,
          effectKey: digestSchema,
          providerIdentityJson: z.string().min(2).max(64 * 1024),
        }).strict(),
      }).strict()).min(1).max(64).refine(
        (candidates) => new Set(candidates.map((candidate) =>
          `${candidate.accountProfileId}\0${String(candidate.processGeneration)}`
        )).size === candidates.length,
        "actor account lease candidates must be unique",
      ),
      startOperationId: actorOperationIdSchema,
      clientRequestId: requestIdentitySchema,
      threadSource: z.string().min(16).max(256)
        .refine((value) => !value.includes("\0"), "thread source contains NUL"),
      toolsetDigest: digestSchema,
      createdAt: isoTimestampSchema.optional(),
    }).strict().parse(inputValue);
    const createdAt = this.#timestamp(input.createdAt);

    return this.#database.transaction(() => {
      const existingLease = this.#readActorAccountLease(input.leaseId);
      const existingIncarnation = this.#readActorIncarnation(input.incarnationId);
      if (existingLease !== null || existingIncarnation !== null) {
        if (
          existingLease !== null && existingIncarnation !== null &&
          existingLease.incarnationId === existingIncarnation.id &&
          existingLease.actorId === input.actorId &&
          existingLease.state === "active"
        ) {
          return Object.freeze({
            incarnation: existingIncarnation,
            accountLease: existingLease,
            activeLoad: this.readActiveActorAccountLoad({
              accountProfileId: existingLease.accountProfileId,
              processGeneration: existingLease.processGeneration,
            }),
          });
        }
        conflict("actor account lease identity already names another launch");
      }

      const ranked = input.candidates.map((candidate) => Object.freeze({
        candidate,
        activeLoad: this.readActiveActorAccountLoad({
          accountProfileId: candidate.accountProfileId,
          processGeneration: candidate.processGeneration,
        }),
      })).sort((left, right) =>
        left.candidate.routingPriority.profileFallbackRank -
          right.candidate.routingPriority.profileFallbackRank ||
        left.candidate.routingPriority.budgetRank -
          right.candidate.routingPriority.budgetRank ||
        left.candidate.routingPriority.remainingHeadroomRank -
          right.candidate.routingPriority.remainingHeadroomRank ||
        left.activeLoad - right.activeLoad ||
        right.candidate.routingPriority.rendezvousScore.localeCompare(
          left.candidate.routingPriority.rendezvousScore,
        ) ||
        Number(right.candidate.routingPriority.selected) -
          Number(left.candidate.routingPriority.selected) ||
        left.candidate.accountProfileId.localeCompare(
          right.candidate.accountProfileId,
        ) ||
        left.candidate.processGeneration - right.candidate.processGeneration
      );
      const selected = ranked[0];
      if (selected === undefined) lineage("actor account lease has no candidate");
      const startOperation = this.#requireActorOperation(input.startOperationId);
      if (
        startOperation.actorId !== input.actorId ||
        startOperation.turnId !== null ||
        startOperation.kind !== "actorStart" ||
        startOperation.state !== "prepared" ||
        startOperation.effectKey !== selected.candidate.operationRequest.effectKey
      ) {
        lineage("actor account lease lacks its prepared start operation");
      }
      const selectedProviderIdentityJson = parseProviderIdentityJson(
        selected.candidate.operationRequest.providerIdentityJson,
      );
      const rebound = this.#database.query(`
        UPDATE harness_actor_operations SET
          request_digest = ?3, provider_identity_json = ?4, updated_at = ?5
        WHERE operation_id = ?1 AND state = 'prepared'
          AND request_digest = ?2 AND effect_key = ?6
      `).run(
        input.startOperationId,
        startOperation.requestDigest,
        selected.candidate.operationRequest.requestDigest,
        selectedProviderIdentityJson,
        createdAt,
        selected.candidate.operationRequest.effectKey,
      );
      if (rebound.changes !== 1) {
        revisionConflict();
      }
      const incarnation = this.createActorIncarnation({
        incarnationId: input.incarnationId,
        actorId: input.actorId,
        accountProfileId: selected.candidate.accountProfileId,
        processGeneration: selected.candidate.processGeneration,
        startOperationId: input.startOperationId,
        clientRequestId: input.clientRequestId,
        threadSource: input.threadSource,
        toolsetDigest: input.toolsetDigest,
        profile: selected.candidate.profile,
        createdAt,
      });
      this.#database.query(`
        INSERT INTO harness_actor_account_leases (
          lease_id, incarnation_id, actor_id, account_profile_id,
          process_generation, state, created_at, updated_at, settled_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?6, NULL)
      `).run(
        input.leaseId,
        incarnation.id,
        incarnation.actorId,
        incarnation.accountProfileId,
        incarnation.processGeneration,
        createdAt,
      );
      return Object.freeze({
        incarnation,
        accountLease: this.#requireActorAccountLease(input.leaseId),
        activeLoad: selected.activeLoad + 1,
      });
    })();
  }

  readActiveActorAccountLoad(inputValue: Readonly<{
    accountProfileId: string;
    processGeneration: number;
  }>): number {
    const input = z.object({
      accountProfileId: z.string().min(1).max(96),
      processGeneration: z.number().int().positive().safe(),
    }).strict().parse(inputValue);
    const row: unknown = this.#database.query(`
      SELECT COUNT(*) AS active_load
      FROM harness_actor_account_leases
      WHERE account_profile_id = ?1 AND process_generation = ?2
        AND state = 'active'
    `).get(input.accountProfileId, input.processGeneration);
    return z.object({ active_load: z.number().int().nonnegative().safe() })
      .strict().parse(row).active_load;
  }

  readAutomaticFastMode(): "off" | "criticalPath" {
    const row: unknown = this.#database.query(`
      SELECT automatic_fast_mode FROM harness_settings WHERE singleton = 1
    `).get();
    return z.object({
      automatic_fast_mode: z.enum(["off", "criticalPath"]),
    }).strict().parse(row).automatic_fast_mode;
  }

  readActorAccountLease(leaseIdValue: string): ActorAccountLeaseRecordV2 | null {
    return this.#readActorAccountLease(
      actorAccountLeaseIdSchema.parse(leaseIdValue),
    );
  }

  recordActorIncarnationObservedProfile(inputValue: Readonly<{
    incarnationId: string;
    observedProfile: Readonly<{
      modelId: string;
      reasoningEffort: RealizedActorProfile["reasoningEffort"];
    }>;
    observedAt?: string;
  }>): ActorIncarnationRecord {
    const input = z.object({
      incarnationId: actorIncarnationIdSchema,
      observedProfile: z.object({
        modelId: z.string().min(1).max(160),
        reasoningEffort: actorReasoningEffortSchema,
      }).strict(),
      observedAt: isoTimestampSchema.optional(),
    }).strict().parse(inputValue);
    const observedAt = this.#timestamp(input.observedAt);
    const current = this.#requireActorIncarnation(input.incarnationId);
    const knownObservedModel = actorModelProfileSchema.safeParse(
      input.observedProfile.modelId,
    );
    const storedObservedModel = knownObservedModel.success
      ? knownObservedModel.data
      : null;
    const observedState =
      input.observedProfile.modelId === current.requestedModel &&
        input.observedProfile.reasoningEffort ===
          current.requestedReasoningEffort
        ? "exact"
        : "rerouted";
    if (
      current.observedModel === storedObservedModel &&
      current.observedReasoningEffort === input.observedProfile.reasoningEffort &&
      current.observedProfileState === observedState
    ) return current;
    const changed = this.#database.query(`
      UPDATE harness_actor_incarnations SET
        observed_model = ?2, observed_reasoning_effort = ?3,
        observed_profile_state = ?4, observed_profile_at = ?5,
        updated_at = ?5
      WHERE incarnation_id = ?1
        AND state IN ('starting', 'idle', 'running')
    `).run(
      input.incarnationId,
      storedObservedModel,
      input.observedProfile.reasoningEffort,
      observedState,
      observedAt,
    );
    if (changed.changes !== 1) invalidTransition(
      "actor incarnation cannot record observed profile in its current state",
    );
    return this.#requireActorIncarnation(input.incarnationId);
  }

  transitionActorIncarnation(inputValue: Readonly<{
    incarnationId: string;
    expectedState: ActorIncarnationRecord["state"];
    nextState: ActorIncarnationRecord["state"];
    providerThreadId?: string | null;
    now?: string;
  }>): ActorIncarnationRecord {
    const incarnationId = actorIncarnationIdSchema.parse(inputValue.incarnationId);
    const expectedState = actorIncarnationStateSchema.parse(inputValue.expectedState);
    const nextState = actorIncarnationStateSchema.parse(inputValue.nextState);
    const providerThreadId = inputValue.providerThreadId === undefined
      ? undefined
      : boundedProviderIdSchema.nullable().parse(inputValue.providerThreadId);
    const now = this.#timestamp(inputValue.now);
    assertIncarnationTransition(expectedState, nextState);
    return this.#database.transaction(() => {
      const current = this.#requireActorIncarnation(incarnationId);
      if (current.state !== expectedState) {
        invalidTransition("incarnation CAS state changed");
      }
      const nextProviderThreadId = providerThreadId ?? current.providerThreadId;
      if (
        (nextState === "idle" || nextState === "running") &&
        nextProviderThreadId === null
      ) {
        lineage("a started incarnation requires its provider thread identity");
      }
      if (nextState === "idle" || nextState === "running") {
        const operation = this.#requireActorOperation(current.startOperationId);
        if (operation.state !== "succeeded") {
          invalidTransition("incarnation cannot become usable before start reconciliation");
        }
      }
      const terminal = nextState === "quarantined" || nextState === "closed";
      if (terminal) {
        const session = this.#database.query<{
          revision: number;
          state: string;
        }, [string]>(`
          SELECT revision, state FROM harness_actor_session_bindings
          WHERE incarnation_id = ?1
        `).get(incarnationId);
        if (session !== null && session.state === "bound") {
          const retired = nextState === "closed";
          const sessionChanged = this.#database.query(`
            UPDATE harness_actor_session_bindings SET
              state = ?3,
              quarantine_reason = ?4,
              revision = revision + 1,
              updated_at = ?5,
              retired_at = ?6,
              quarantined_at = ?7
            WHERE incarnation_id = ?1 AND revision = ?2 AND state = 'bound'
          `).run(
            incarnationId,
            session.revision,
            retired ? "retired" : "quarantined",
            retired ? null : "recovery_protocol_error",
            now,
            retired ? now : null,
            retired ? null : now,
          );
          if (sessionChanged.changes !== 1) {
            revisionConflict();
          }
        } else if (session !== null) {
          conflict("live actor incarnation has a terminal session binding");
        }
      }
      const changed = this.#database.query(`
        UPDATE harness_actor_incarnations SET
          state = ?3, provider_thread_id = ?4,
          updated_at = ?5, closed_at = ?6
        WHERE incarnation_id = ?1 AND state = ?2
      `).run(
        incarnationId,
        expectedState,
        nextState,
        nextProviderThreadId,
        now,
        terminal ? now : null,
      );
      if (changed.changes !== 1) {
        invalidTransition("incarnation CAS state changed");
      }
      if (terminal) {
        const lease = this.#readActorAccountLeaseByIncarnation(incarnationId);
        if (lease !== null && lease.state === "active") {
          const leaseChanged = this.#database.query(`
            UPDATE harness_actor_account_leases SET
              state = ?2, updated_at = ?3, settled_at = ?3
            WHERE lease_id = ?1 AND state = 'active'
          `).run(
            lease.id,
            nextState === "closed" ? "released" : "quarantined",
            now,
          );
          if (leaseChanged.changes !== 1) revisionConflict();
        }
      }
      return this.#requireActorIncarnation(incarnationId);
    })();
  }

  readActorIncarnation(incarnationId: string): ActorIncarnationRecord | null {
    return this.#readActorIncarnation(
      actorIncarnationIdSchema.parse(incarnationId),
    );
  }

  readActiveIncarnationForActor(
    actorIdValue: string,
  ): ActorIncarnationRecord | null {
    const actorId = actorIdSchema.parse(actorIdValue);
    const rows: unknown[] = this.#database.query(`
      SELECT * FROM harness_actor_incarnations
      WHERE actor_id = ?1 AND state IN ('starting', 'idle', 'running')
      ORDER BY incarnation_id LIMIT 2
    `).all(actorId);
    if (rows.length > 1) {
      throw new HarnessSQLiteAuthorityV2Error(
        "corrupt_state",
        "actor has multiple live incarnations",
      );
    }
    const row = rows[0];
    return row === undefined ? null : parseActorIncarnationRow(row);
  }

  bindActorSession(inputValue: Readonly<{
    incarnationId: string;
    liveCapabilityEvidence?: Readonly<{
      observationGeneration: number;
      evidenceDigest: string | null;
      supportsFast: boolean | null;
    }>;
    recoveryProof: ActorSessionRecoveryProofV2;
    createdAt?: string;
  }>): ActorSessionBindingRecordV2 {
    const incarnationId = actorIncarnationIdSchema.parse(inputValue.incarnationId);
    const recoveryProof = actorSessionRecoveryProofV2Schema.parse(
      inputValue.recoveryProof,
    );
    const requestedLiveCapabilityEvidence = z.object({
      observationGeneration: z.number().int().positive().safe(),
      evidenceDigest: digestSchema.nullable(),
      supportsFast: z.boolean().nullable(),
    }).strict().superRefine((evidence, context) => {
      if (
        (evidence.evidenceDigest === null) !==
          (evidence.supportsFast === null)
      ) {
        context.addIssue({
          code: "custom",
          message: "live actor-session capability evidence must be complete",
          path: ["evidenceDigest"],
        });
      }
    }).optional().parse(inputValue.liveCapabilityEvidence);
    const createdAt = this.#timestamp(inputValue.createdAt);
    return this.#database.transaction(() => {
      const incarnation = this.#requireActorIncarnation(incarnationId);
      const liveCapabilityEvidence = requestedLiveCapabilityEvidence ??
        (recoveryProof.observationGeneration === incarnation.processGeneration
          ? Object.freeze({
              observationGeneration: recoveryProof.observationGeneration,
              evidenceDigest: incarnation.capabilityEvidenceDigest,
              supportsFast: incarnation.supportsFast,
            })
          : lineage(
              "successor actor session binding requires explicit capability evidence",
            ));
      if (
        liveCapabilityEvidence.observationGeneration !==
          recoveryProof.observationGeneration
      ) {
        lineage("actor session capability evidence observed another generation");
      }
      const existing = this.#readActorSessionBinding(incarnationId);
      if (existing !== null) {
        if (
          existing.state === "bound" &&
          existing.liveGeneration === recoveryProof.observationGeneration &&
          existing.liveCapabilityEvidenceDigest ===
            liveCapabilityEvidence.evidenceDigest &&
          existing.liveSupportsFast === liveCapabilityEvidence.supportsFast &&
          exactJson(existing.recoveryProof) === exactJson(recoveryProof)
        ) return existing;
        conflict("actor incarnation already has different session evidence");
      }
      if (
        (incarnation.state !== "idle" && incarnation.state !== "running") ||
        incarnation.providerThreadId === null ||
        recoveryProof.observationGeneration < incarnation.processGeneration ||
        recoveryProof.priorRecoveryProofDigest !== null
      ) {
        lineage("only an admitted live actor thread may bind recovery evidence");
      }
      const legacyPolicy = this.readActorDispatchPolicy(incarnation.actorId)
        .policyVersion === 0;
      if (
        legacyPolicy !== (incarnation.capabilityEvidenceDigest === null) ||
        legacyPolicy !== (incarnation.supportsFast === null) ||
        legacyPolicy !== (liveCapabilityEvidence.evidenceDigest === null) ||
        legacyPolicy !== (liveCapabilityEvidence.supportsFast === null)
      ) {
        lineage("actor session capability evidence does not match its policy");
      }
      if (
        recoveryProof.observationGeneration === incarnation.processGeneration &&
        (liveCapabilityEvidence.evidenceDigest !==
            incarnation.capabilityEvidenceDigest ||
          liveCapabilityEvidence.supportsFast !== incarnation.supportsFast)
      ) {
        lineage("initial actor session capability evidence changed at admission");
      }
      const accountValue: unknown = this.#database.query(`
        SELECT process_generation, auth_state FROM account_profiles
        WHERE profile_id = ?1
      `).get(incarnation.accountProfileId);
      const account = z.object({
        process_generation: z.number().int().positive().safe(),
        auth_state: z.string(),
      }).strict().parse(accountValue);
      if (
        account.process_generation !== recoveryProof.observationGeneration ||
        account.auth_state !== "signed_in"
      ) {
        lineage("actor session evidence does not match the live account runtime");
      }
      const workspaceRows: unknown[] = this.#database.query(`
        SELECT binding_id FROM harness_actor_workspace_bindings
        WHERE actor_id = ?1 AND state = 'active'
        ORDER BY binding_id LIMIT 2
      `).all(incarnation.actorId);
      if (workspaceRows.length !== 1) {
        throw new HarnessSQLiteAuthorityV2Error(
          "corrupt_state",
          "actor session requires one exact active workspace binding",
        );
      }
      const workspaceBindingId = z.object({
        binding_id: actorWorkspaceBindingIdSchema,
      }).strict().parse(workspaceRows[0]).binding_id;
      this.#database.query(`
        INSERT INTO harness_actor_session_bindings (
          incarnation_id, actor_id, workspace_binding_id, account_profile_id,
          admission_generation, live_generation, provider_thread_id,
          thread_source, live_capability_evidence_digest, live_supports_fast,
          recovery_proof_digest, prior_recovery_proof_digest,
          history_evidence_digest, first_observation_position,
          second_observation_position, history_turn_count, history_item_count,
          state, quarantine_reason, revision, created_at, updated_at,
          recovered_at, retired_at, quarantined_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, ?12,
          ?13, ?14, ?15, ?16, 'bound', NULL, 1, ?17, ?17, NULL, NULL, NULL
        )
      `).run(
        incarnation.id,
        incarnation.actorId,
        workspaceBindingId,
        incarnation.accountProfileId,
        incarnation.processGeneration,
        recoveryProof.observationGeneration,
        incarnation.providerThreadId,
        incarnation.threadSource,
        liveCapabilityEvidence.evidenceDigest,
        liveCapabilityEvidence.supportsFast === null
          ? null
          : Number(liveCapabilityEvidence.supportsFast),
        recoveryProof.recoveryProofDigest,
        recoveryProof.historyEvidenceDigest,
        recoveryProof.firstObservationPosition,
        recoveryProof.secondObservationPosition,
        recoveryProof.historyTurnCount,
        recoveryProof.historyItemCount,
        createdAt,
      );
      return this.#requireActorSessionBinding(incarnationId);
    })();
  }

  readActorSessionBinding(
    incarnationIdValue: string,
  ): ActorSessionBindingRecordV2 | null {
    return this.#readActorSessionBinding(
      actorIncarnationIdSchema.parse(incarnationIdValue),
    );
  }

  listRecoverableActorSessions(inputValue: Readonly<{
    afterIncarnationId?: string | null;
    limit: number;
  }>): readonly ActorSessionBindingRecordV2[] {
    const afterIncarnationId = actorIncarnationIdSchema.nullable()
      .parse(inputValue.afterIncarnationId ?? null);
    const limit = z.number().int().min(1).max(128).parse(inputValue.limit);
    const rows = this.#database.query<{ incarnation_id: string }, [string | null, number]>(`
      SELECT incarnation_id FROM harness_actor_session_bindings
      WHERE incarnation_id > COALESCE(?1, '') AND state = 'bound'
      ORDER BY incarnation_id LIMIT ?2
    `).all(afterIncarnationId, limit);
    return Object.freeze(rows.map(({ incarnation_id }) =>
      this.#requireActorSessionBinding(actorIncarnationIdSchema.parse(incarnation_id))
    ));
  }

  advanceActorSessionBinding(inputValue: Readonly<{
    incarnationId: string;
    expectedRevision: number;
    expectedLiveGeneration: number;
    liveCapabilityEvidence: Readonly<{
      evidenceDigest: string;
      supportsFast: boolean;
    }>;
    recoveryProof: ActorSessionRecoveryProofV2;
    now?: string;
  }>): ActorSessionBindingRecordV2 {
    const incarnationId = actorIncarnationIdSchema.parse(inputValue.incarnationId);
    const expectedRevision = z.number().int().positive().safe()
      .parse(inputValue.expectedRevision);
    const expectedLiveGeneration = z.number().int().positive().safe()
      .parse(inputValue.expectedLiveGeneration);
    const recoveryProof = actorSessionRecoveryProofV2Schema.parse(
      inputValue.recoveryProof,
    );
    const liveCapabilityEvidence = z.object({
      evidenceDigest: digestSchema,
      supportsFast: z.boolean(),
    }).strict().parse(inputValue.liveCapabilityEvidence);
    const now = this.#timestamp(inputValue.now);
    return this.#database.transaction(() => {
      const current = this.#requireActorSessionBinding(incarnationId);
      if (
        current.state !== "bound" || current.revision !== expectedRevision ||
        current.liveGeneration !== expectedLiveGeneration
      ) revisionConflict();
      if (
        recoveryProof.observationGeneration < current.liveGeneration ||
        recoveryProof.priorRecoveryProofDigest !==
          current.recoveryProof.recoveryProofDigest ||
        recoveryProof.recoveryProofDigest ===
          current.recoveryProof.recoveryProofDigest
      ) {
        lineage("actor session recovery proof does not advance its exact chain");
      }
      const profile = this.#database.query<{ process_generation: number }, [string]>(`
        SELECT process_generation FROM account_profiles WHERE profile_id = ?1
      `).get(current.accountProfileId);
      if (profile?.process_generation !== recoveryProof.observationGeneration) {
        conflict("actor session recovery generation is not the durable account generation");
      }
      const changed = this.#database.query(`
        UPDATE harness_actor_session_bindings SET
          live_generation = ?4, recovery_proof_digest = ?5,
          prior_recovery_proof_digest = ?6, history_evidence_digest = ?7,
          first_observation_position = ?8, second_observation_position = ?9,
          history_turn_count = ?10, history_item_count = ?11,
          live_capability_evidence_digest = ?12,
          live_supports_fast = ?13,
          revision = revision + 1, updated_at = ?14, recovered_at = ?14
        WHERE incarnation_id = ?1 AND revision = ?2
          AND live_generation = ?3 AND state = 'bound'
      `).run(
        incarnationId,
        expectedRevision,
        expectedLiveGeneration,
        recoveryProof.observationGeneration,
        recoveryProof.recoveryProofDigest,
        recoveryProof.priorRecoveryProofDigest,
        recoveryProof.historyEvidenceDigest,
        recoveryProof.firstObservationPosition,
        recoveryProof.secondObservationPosition,
        recoveryProof.historyTurnCount,
        recoveryProof.historyItemCount,
        liveCapabilityEvidence.evidenceDigest,
        Number(liveCapabilityEvidence.supportsFast),
        now,
      );
      if (changed.changes !== 1) revisionConflict();
      this.#consumeActorTurnUsageAfterSessionRecovery(
        incarnationId,
        recoveryProof.observationGeneration,
      );
      return this.#requireActorSessionBinding(incarnationId);
    })();
  }

  quarantineActorSessionBinding(inputValue: Readonly<{
    incarnationId: string;
    expectedRevision: number;
    reason: z.infer<typeof actorSessionQuarantineReasonV2Schema>;
    now?: string;
  }>): ActorSessionBindingRecordV2 {
    const incarnationId = actorIncarnationIdSchema.parse(inputValue.incarnationId);
    const expectedRevision = z.number().int().positive().safe()
      .parse(inputValue.expectedRevision);
    const reason = actorSessionQuarantineReasonV2Schema.parse(inputValue.reason);
    const now = this.#timestamp(inputValue.now);
    return this.#database.transaction(() => {
      const current = this.#requireActorSessionBinding(incarnationId);
      if (current.state !== "bound" || current.revision !== expectedRevision) {
        revisionConflict();
      }
      const changed = this.#database.query(`
        UPDATE harness_actor_session_bindings SET
          state = 'quarantined', quarantine_reason = ?3,
          revision = revision + 1, updated_at = ?4, quarantined_at = ?4
        WHERE incarnation_id = ?1 AND revision = ?2 AND state = 'bound'
      `).run(incarnationId, expectedRevision, reason, now);
      if (changed.changes !== 1) revisionConflict();
      this.#database.query(`
        UPDATE harness_actor_turn_usage_inbox
        SET quarantined = 1, quarantine_reason = ?2
        WHERE quarantined = 0 AND attempt_id IN (
          SELECT attempt_id FROM harness_actor_turn_attempts
          WHERE incarnation_id = ?1
        )
      `).run(incarnationId, reason);
      const incarnation = this.#requireActorIncarnation(incarnationId);
      if (
        incarnation.state === "starting" || incarnation.state === "idle" ||
        incarnation.state === "running"
      ) {
        const quarantined = this.#database.query(`
          UPDATE harness_actor_incarnations SET
            state = 'quarantined', updated_at = ?2, closed_at = ?2
          WHERE incarnation_id = ?1 AND state IN ('starting', 'idle', 'running')
        `).run(incarnationId, now);
        if (quarantined.changes !== 1) revisionConflict();
      } else if (incarnation.state !== "quarantined") {
        conflict("a closed actor incarnation cannot be recovery-quarantined");
      }
      const lease = this.#readActorAccountLeaseByIncarnation(incarnationId);
      if (lease !== null && lease.state === "active") {
        const leaseChanged = this.#database.query(`
          UPDATE harness_actor_account_leases SET
            state = 'quarantined', updated_at = ?2, settled_at = ?2
          WHERE lease_id = ?1 AND state = 'active'
        `).run(lease.id, now);
        if (leaseChanged.changes !== 1) revisionConflict();
      }
      return this.#requireActorSessionBinding(incarnationId);
    })();
  }

  createActorAttempt(inputValue: Readonly<{
    attemptId: string;
    turnId: string;
    incarnationId: string;
    accountProfileId: string;
    processGeneration: number;
    clientUserMessageId: string;
    createdAt?: string;
  }>): PersistedActorAttempt {
    const attemptId = actorAttemptIdSchema.parse(inputValue.attemptId);
    const turnId = actorTurnIdSchema.parse(inputValue.turnId);
    const incarnationId = actorIncarnationIdSchema.parse(inputValue.incarnationId);
    const accountProfileId = z.string().min(1).max(96)
      .parse(inputValue.accountProfileId);
    const processGeneration = z.number().int().positive().safe()
      .parse(inputValue.processGeneration);
    const clientUserMessageId = requestIdentitySchema.parse(
      inputValue.clientUserMessageId,
    );
    const createdAt = this.#timestamp(inputValue.createdAt);

    return this.#database.transaction(() => {
      const existing = this.#readActorAttempt(attemptId);
      if (existing !== null) {
        if (
          existing.turnId === turnId && existing.incarnationId === incarnationId &&
          existing.accountProfileId === accountProfileId &&
          existing.processGeneration === processGeneration &&
          existing.clientUserMessageId === clientUserMessageId
        ) return existing;
        conflict("actor attempt identity already names another request");
      }
      const turn = this.#requireTurn(turnId);
      if (isTerminalActorTurnState(turn.state) || turn.desiredState === "stop") {
        invalidTransition("settled or stopped logical turns cannot start attempts");
      }
      const incarnation = this.#requireActorIncarnation(incarnationId);
      if (
        incarnation.actorId !== turn.actorId ||
        incarnation.accountProfileId !== accountProfileId ||
        incarnation.processGeneration !== processGeneration ||
        (incarnation.state !== "idle" && incarnation.state !== "running")
      ) {
        lineage("actor attempt does not match its live incarnation");
      }
      const ordinalValue: unknown = this.#database.query(`
        SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal
        FROM harness_actor_turn_attempts WHERE turn_id = ?1
      `).get(turnId);
      const ordinal = z.object({ ordinal: z.number().int().positive().safe() })
        .strict().parse(ordinalValue).ordinal;
      this.#database.query(`
        INSERT INTO harness_actor_turn_attempts (
          attempt_id, turn_id, incarnation_id, ordinal, account_profile_id,
          process_generation, effect_generation, client_user_message_id,
          provider_turn_id,
          token_usage_identity_digest, token_usage_stream_position,
          token_usage_cumulative_input_tokens,
          token_usage_cumulative_output_tokens,
          token_usage_observation_generation,
          continuation_history_value_id,
          state, quota_proof_digest, input_tokens, output_tokens,
          created_at, started_at, settled_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, NULL, NULL, NULL,
          NULL, NULL, NULL, NULL, 'starting', NULL, NULL, NULL,
          ?8, NULL, NULL
        )
      `).run(
        attemptId,
        turnId,
        incarnationId,
        ordinal,
        accountProfileId,
        processGeneration,
        clientUserMessageId,
        createdAt,
      );
      return this.#requireActorAttempt(attemptId);
    })();
  }

  claimActorAttempt(inputValue: Readonly<{
    attemptId: string;
    turnId: string;
    incarnationId: string;
    accountProfileId: string;
    processGeneration: number;
    clientUserMessageId: string;
    dispatch?: Readonly<{
      capabilityEvidenceDigest: string | null;
      fastReservationId?: string;
    }>;
    createdAt?: string;
  }>): Readonly<{
    incarnation: ActorIncarnationRecord;
    attempt: PersistedActorAttempt;
    fastReservation: ActorFastReservationRecordV2 | null;
  }> {
    const input = z.object({
      attemptId: actorAttemptIdSchema,
      turnId: actorTurnIdSchema,
      incarnationId: actorIncarnationIdSchema,
      accountProfileId: z.string().min(1).max(96),
      processGeneration: z.number().int().positive().safe(),
      clientUserMessageId: requestIdentitySchema,
      dispatch: z.object({
        capabilityEvidenceDigest: digestSchema.nullable(),
        fastReservationId: actorFastReservationIdSchema.optional(),
      }).strict().optional(),
      createdAt: isoTimestampSchema.optional(),
    }).strict().parse(inputValue);
    const createdAt = this.#timestamp(input.createdAt);
    return this.#database.transaction(() => {
      const existing = this.#readActorAttempt(input.attemptId);
      if (existing !== null) {
        if (
          existing.turnId !== input.turnId ||
          existing.incarnationId !== input.incarnationId ||
          existing.accountProfileId !== input.accountProfileId ||
          existing.processGeneration !== input.processGeneration ||
          existing.clientUserMessageId !== input.clientUserMessageId
        ) conflict("actor attempt identity already names another request");
        const existingIncarnation = this.#requireActorIncarnation(input.incarnationId);
        if (existingIncarnation.state !== "running") {
          invalidTransition("claimed actor attempt lost its running incarnation");
        }
        return Object.freeze({
          incarnation: existingIncarnation,
          attempt: existing,
          fastReservation: this.#readActorFastReservationForAttempt(existing.id),
        });
      }

      const turn = this.#requireTurn(input.turnId);
      const incarnation = this.#requireActorIncarnation(input.incarnationId);
      if (
        (turn.state !== "starting" && turn.state !== "reconciling") ||
        turn.desiredState !== "run" ||
        incarnation.actorId !== turn.actorId ||
        incarnation.accountProfileId !== input.accountProfileId ||
        incarnation.processGeneration !== input.processGeneration ||
        incarnation.providerThreadId === null ||
        (incarnation.state !== "idle" && incarnation.state !== "running")
      ) lineage("actor attempt claim does not match its live turn and incarnation");
      const session = this.#readActorSessionBinding(incarnation.id);
      if (
        session === null || session.state !== "bound" ||
        session.actorId !== incarnation.actorId ||
        session.accountProfileId !== incarnation.accountProfileId ||
        session.admissionGeneration !== incarnation.processGeneration ||
        session.providerThreadId !== incarnation.providerThreadId
      ) lineage("actor attempt claim lacks its exact live session binding");
      const competing: unknown[] = this.#database.query(`
        SELECT attempt_id FROM harness_actor_turn_attempts
        WHERE incarnation_id = ?1 AND attempt_id != ?2
          AND state IN ('starting', 'running', 'reconciling')
        ORDER BY attempt_id LIMIT 2
      `).all(incarnation.id, input.attemptId);
      if (competing.length !== 0) {
        invalidTransition("actor incarnation already owns another unsettled turn");
      }
      const acceleration = this.readActorTurnAcceleration(turn.id);
      const capabilityEvidenceDigest = input.dispatch?.capabilityEvidenceDigest ??
        null;
      if (
        capabilityEvidenceDigest !== session.liveCapabilityEvidenceDigest
      ) {
        lineage("actor attempt capability evidence is not live for its session");
      }
      const effectGeneration = session.liveGeneration;
      const requestedServiceTier = acceleration.mode;
      let realizedServiceTier: "standard" | "fast" = "standard";
      let tierFallbackReason: PersistedActorAttempt["tierFallbackReason"] = null;
      let fastReservationId: string | null = null;
      if (acceleration.mode === "fast") {
        if (this.readAutomaticFastMode() === "off") {
          tierFallbackReason = "automaticFastDisabled";
        } else if (session.liveSupportsFast !== true) {
          tierFallbackReason = "fastUnsupported";
        } else {
          fastReservationId = actorFastReservationIdSchema.parse(
            input.dispatch?.fastReservationId,
          );
          if (this.#readActorFastReservation(fastReservationId) !== null) {
            conflict("Fast reservation identity already names another attempt");
          }
          realizedServiceTier = "fast";
        }
      } else if (input.dispatch?.fastReservationId !== undefined) {
        lineage("a Standard actor turn cannot reserve Fast capacity");
      }
      if (incarnation.state === "idle") {
        const claimed = this.#database.query(`
          UPDATE harness_actor_incarnations SET state = 'running', updated_at = ?2
          WHERE incarnation_id = ?1 AND state = 'idle'
        `).run(incarnation.id, createdAt);
        if (claimed.changes !== 1) revisionConflict();
      }
      const ordinalValue: unknown = this.#database.query(`
        SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal
        FROM harness_actor_turn_attempts WHERE turn_id = ?1
      `).get(input.turnId);
      const ordinal = z.object({ ordinal: z.number().int().positive().safe() })
        .strict().parse(ordinalValue).ordinal;
      const insertAttempt = () => this.#database.query(`
        INSERT INTO harness_actor_turn_attempts (
          attempt_id, turn_id, incarnation_id, ordinal, account_profile_id,
          process_generation, effect_generation, client_user_message_id,
          provider_turn_id,
          token_usage_identity_digest, token_usage_stream_position,
          token_usage_cumulative_input_tokens,
          token_usage_cumulative_output_tokens,
          token_usage_observation_generation,
          continuation_history_value_id,
          state, quota_proof_digest, input_tokens, output_tokens,
          created_at, started_at, settled_at, requested_service_tier,
          realized_service_tier, tier_fallback_reason,
          capability_evidence_digest, fast_reservation_id
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, NULL, NULL,
          NULL, NULL, NULL, NULL, 'starting', NULL, NULL, NULL,
          ?9, NULL, NULL, ?10, ?11, ?12, ?13, ?14
        )
      `).run(
        input.attemptId,
        input.turnId,
        input.incarnationId,
        ordinal,
        input.accountProfileId,
        input.processGeneration,
        effectGeneration,
        input.clientUserMessageId,
        createdAt,
        requestedServiceTier,
        realizedServiceTier,
        tierFallbackReason,
        capabilityEvidenceDigest,
        fastReservationId,
      );
      insertAttempt();
      if (fastReservationId !== null) {
        const epoch = this.#requireEpoch(turn.epochId);
        const reserved = this.#database.query(`
          INSERT OR IGNORE INTO harness_actor_fast_reservations (
            reservation_id, attempt_id, epoch_id, root_actor_id, actor_id,
            account_profile_id, process_generation, state, terminal_reason,
            fence_evidence_digest, fenced_generation, created_at, updated_at,
            effect_started_at, settled_at, quarantined_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'reserved', NULL,
            NULL, NULL, ?8, ?8, NULL, NULL, NULL
          )
        `).run(
          fastReservationId,
          input.attemptId,
          turn.epochId,
          epoch.rootActorId,
          turn.actorId,
          input.accountProfileId,
          effectGeneration,
          createdAt,
        );
        if (reserved.changes !== 1) {
          const removed = this.#database.query(`
            DELETE FROM harness_actor_turn_attempts WHERE attempt_id = ?1
          `).run(input.attemptId);
          if (removed.changes !== 1) revisionConflict();
          realizedServiceTier = "standard";
          tierFallbackReason = "fastReservationUnavailable";
          fastReservationId = null;
          insertAttempt();
        }
      }
      return Object.freeze({
        incarnation: this.#requireActorIncarnation(input.incarnationId),
        attempt: this.#requireActorAttempt(input.attemptId),
        fastReservation: this.#readActorFastReservationForAttempt(
          input.attemptId,
        ),
      });
    })();
  }

  /**
   * Commits the exact successor-generation provider request at the final
   * pre-effect boundary. Admission identity stays immutable on
   * `processGeneration`; only this transaction may rebind effect custody while
   * both the attempt and operation are still provably pre-effect.
   */
  startActorTurnEffect(inputValue: Readonly<{
    operationId: string;
    attemptId: string;
    expectedOperationRequestDigest: string;
    expectedSessionRevision: number;
    effectGeneration: number;
    capabilityEvidenceDigest: string | null;
    requestDigest: string;
    effectKey: string;
    providerIdentityJson: string;
    now?: string;
  }>): Readonly<
    | {
        kind: "effectStarted";
        changed: boolean;
        operation: ActorOperationRecord;
        attempt: PersistedActorAttempt;
        fastReservation: ActorFastReservationRecordV2 | null;
      }
    | {
        kind: "retryStandard";
        operation: ActorOperationRecord;
        attempt: PersistedActorAttempt;
        releasedFastReservation: ActorFastReservationRecordV2;
      }
  > {
    const input = z.object({
      operationId: actorOperationIdSchema,
      attemptId: actorAttemptIdSchema,
      expectedOperationRequestDigest: digestSchema,
      expectedSessionRevision: z.number().int().positive().safe(),
      effectGeneration: z.number().int().positive().safe(),
      capabilityEvidenceDigest: digestSchema.nullable(),
      requestDigest: digestSchema,
      effectKey: digestSchema,
      providerIdentityJson: z.string().min(2).max(64 * 1024),
      now: isoTimestampSchema.optional(),
    }).strict().parse(inputValue);
    const providerIdentityJson = parseProviderIdentityJson(
      input.providerIdentityJson,
    );
    const now = this.#timestamp(input.now);
    return this.#database.transaction(() => {
      const operation = this.#requireActorOperation(input.operationId);
      const attempt = this.#requireActorAttempt(input.attemptId);
      const incarnation = this.#requireActorIncarnation(attempt.incarnationId);
      const session = this.#requireActorSessionBinding(incarnation.id);
      if (
        operation.kind !== "turnStart" || operation.turnId !== attempt.turnId ||
        operation.actorId !== incarnation.actorId ||
        operation.effectKey !== input.effectKey ||
        attempt.accountProfileId !== incarnation.accountProfileId ||
        attempt.processGeneration !== incarnation.processGeneration ||
        (attempt.state !== "starting" && attempt.state !== "reconciling") ||
        attempt.providerTurnId !== null || incarnation.state !== "running" ||
        session.state !== "bound" ||
        session.accountProfileId !== attempt.accountProfileId ||
        session.admissionGeneration !== attempt.processGeneration ||
        session.providerThreadId !== incarnation.providerThreadId
      ) {
        lineage("actor effect start lost its exact admission lineage");
      }
      if (operation.state === "effectStarted") {
        if (
          operation.requestDigest !== input.requestDigest ||
          operation.providerIdentityJson !== providerIdentityJson ||
          attempt.effectGeneration !== input.effectGeneration ||
          attempt.capabilityEvidenceDigest !== input.capabilityEvidenceDigest
        ) {
          conflict("started actor effect cannot change generation custody");
        }
        const fastReservation = this.#readActorFastReservationForAttempt(
          attempt.id,
        );
        if (
          fastReservation !== null &&
          (fastReservation.state !== "effectStarted" ||
            fastReservation.processGeneration !== attempt.effectGeneration)
        ) {
          throw new HarnessSQLiteAuthorityV2Error(
            "corrupt_state",
            "started actor effect lost its exact Fast reservation",
          );
        }
        return Object.freeze({
          kind: "effectStarted" as const,
          changed: false,
          operation,
          attempt,
          fastReservation,
        });
      }
      if (
        operation.state !== "prepared" ||
        operation.requestDigest !== input.expectedOperationRequestDigest
      ) {
        invalidTransition("actor effect start operation CAS changed");
      }
      if (
        session.revision !== input.expectedSessionRevision ||
        session.liveGeneration !== input.effectGeneration ||
        session.liveCapabilityEvidenceDigest !== input.capabilityEvidenceDigest
      ) {
        revisionConflict();
      }

      const reservation = this.#readActorFastReservationForAttempt(attempt.id);
      if (attempt.realizedServiceTier === "fast") {
        if (
          reservation === null || attempt.fastReservationId !== reservation.id ||
          reservation.state !== "reserved"
        ) {
          throw new HarnessSQLiteAuthorityV2Error(
            "corrupt_state",
            "pre-effect Fast attempt lost its exact reservation",
          );
        }
        if (
          reservation.processGeneration !== input.effectGeneration ||
          session.liveSupportsFast !== true
        ) {
          const released = this.settleActorFastReservation({
            reservationId: reservation.id,
            attemptId: attempt.id,
            expectedState: "reserved",
            nextState: "released",
            reason: "preEffectTerminal",
            now,
          });
          const fallback = this.#database.query(`
            UPDATE harness_actor_turn_attempts SET
              effect_generation = ?2,
              capability_evidence_digest = ?3,
              realized_service_tier = 'standard',
              tier_fallback_reason = 'fastReservationUnavailable',
              fast_reservation_id = NULL
            WHERE attempt_id = ?1
              AND state IN ('starting', 'reconciling')
              AND provider_turn_id IS NULL
          `).run(
            attempt.id,
            input.effectGeneration,
            input.capabilityEvidenceDigest,
          );
          if (fallback.changes !== 1) revisionConflict();
          return Object.freeze({
            kind: "retryStandard" as const,
            operation: this.#requireActorOperation(operation.id),
            attempt: this.#requireActorAttempt(attempt.id),
            releasedFastReservation: released,
          });
        }
      } else if (
        reservation !== null &&
        reservation.state === "reserved"
      ) {
        throw new HarnessSQLiteAuthorityV2Error(
          "corrupt_state",
          "Standard actor effect still holds reserved Fast capacity",
        );
      }

      const reboundAttempt = this.#database.query(`
        UPDATE harness_actor_turn_attempts SET
          effect_generation = ?2, capability_evidence_digest = ?3
        WHERE attempt_id = ?1
          AND state IN ('starting', 'reconciling')
          AND provider_turn_id IS NULL
      `).run(
        attempt.id,
        input.effectGeneration,
        input.capabilityEvidenceDigest,
      );
      if (reboundAttempt.changes !== 1) revisionConflict();
      const reboundOperation = this.#database.query(`
        UPDATE harness_actor_operations SET
          request_digest = ?3, provider_identity_json = ?4, updated_at = ?5
        WHERE operation_id = ?1 AND state = 'prepared'
          AND request_digest = ?2 AND effect_key = ?6
      `).run(
        operation.id,
        input.expectedOperationRequestDigest,
        input.requestDigest,
        providerIdentityJson,
        now,
        input.effectKey,
      );
      if (reboundOperation.changes !== 1) revisionConflict();
      if (reservation?.state === "reserved") {
        this.markActorFastReservationEffectStarted({
          reservationId: reservation.id,
          attemptId: attempt.id,
          now,
        });
      }
      const started = this.transitionActorOperation({
        operationId: operation.id,
        expectedState: "prepared",
        nextState: "effectStarted",
        providerIdentityJson,
        now,
      });
      return Object.freeze({
        kind: "effectStarted" as const,
        changed: true,
        operation: started,
        attempt: this.#requireActorAttempt(attempt.id),
        fastReservation: this.#readActorFastReservationForAttempt(attempt.id),
      });
    })();
  }

  readActorFastReservationForAttempt(
    attemptIdValue: string,
  ): ActorFastReservationRecordV2 | null {
    return this.#readActorFastReservationForAttempt(
      actorAttemptIdSchema.parse(attemptIdValue),
    );
  }

  listQuarantinedActorFastReservations(inputValue: Readonly<{
    after?: Readonly<{
      updatedAt: string;
      reservationId: string;
    }> | null;
    limit: number;
  }>): readonly ActorFastReservationRecordV2[] {
    const input = z.object({
      after: z.object({
        updatedAt: isoTimestampSchema,
        reservationId: actorFastReservationIdSchema,
      }).strict().nullable().optional(),
      limit: z.number().int().min(1).max(128),
    }).strict().parse(inputValue);
    const after = input.after ?? null;
    const rows: unknown[] = this.#database.query(`
      SELECT * FROM harness_actor_fast_reservations
      WHERE state = 'quarantined' AND (
        ?1 IS NULL OR updated_at > ?1
        OR (updated_at = ?1 AND reservation_id > ?2)
      )
      ORDER BY updated_at, reservation_id LIMIT ?3
    `).all(after?.updatedAt ?? null, after?.reservationId ?? null, input.limit);
    return Object.freeze(rows.map(parseActorFastReservationRow));
  }

  /**
   * Revokes one ambiguous logical turn in a single durable cut. `attemptId`
   * names the evidence source; a later, still-unsettled effect is found across
   * the actor and contained without rewriting either identity. Its logical
   * turn may differ from the evidence turn after a delayed observation.
   *
   * A quarantined Fast reservation is also a recovery anchor for prefixes
   * written by the former multi-transaction containment path. Recovery may
   * omit the original provider proof only when that exact anchor already
   * exists. Provider operations and their request identities are immutable
   * throughout this transaction.
   */
  containAmbiguousActorTurn(inputValue: Readonly<{
    attemptId: string;
    evidenceDigest?: string;
    now?: string;
  }>): Readonly<{
    actor: Actor;
    evidenceTurn: ActorTurn;
    containedTurn: ActorTurn | null;
    evidenceAttempt: PersistedActorAttempt;
    containedAttempt: PersistedActorAttempt | null;
    evidenceIncarnation: ActorIncarnationRecord;
    containedIncarnation: ActorIncarnationRecord | null;
    evidenceFastReservation: ActorFastReservationRecordV2 | null;
    containedFastReservation: ActorFastReservationRecordV2 | null;
  }> {
    const input = z.object({
      attemptId: actorAttemptIdSchema,
      evidenceDigest: digestSchema.optional(),
      now: isoTimestampSchema.optional(),
    }).strict().parse(inputValue);
    const requestedAt = this.#timestamp(input.now);
    return this.#database.transaction(() => {
      const evidenceAttempt = this.#requireActorAttempt(input.attemptId);
      const evidenceTurn = this.#requireTurn(evidenceAttempt.turnId);
      const actor = this.#requireActor(evidenceTurn.actorId);
      const epoch = this.#requireEpoch(evidenceTurn.epochId);
      const liveTurnRows: unknown[] = this.#database.query(`
        SELECT * FROM harness_actor_turns
        WHERE actor_id = ?1
          AND state IN ('prepared', 'starting', 'running', 'reconciling')
        ORDER BY ordinal, turn_id LIMIT 2
      `).all(actor.id);
      if (liveTurnRows.length > 1) {
        conflict("ambiguous actor has multiple nonterminal logical turns");
      }
      const liveTurn = liveTurnRows[0] === undefined
        ? null
        : parseActorTurnRow(liveTurnRows[0]);
      const unsettledRows: unknown[] = this.#database.query(`
        SELECT attempt.* FROM harness_actor_turn_attempts AS attempt
        JOIN harness_actor_turns AS current_turn
          ON current_turn.turn_id = attempt.turn_id
        WHERE current_turn.actor_id = ?1
          AND attempt.state IN ('starting', 'running', 'reconciling')
        ORDER BY current_turn.ordinal, attempt.ordinal, attempt.attempt_id
        LIMIT 2
      `).all(actor.id);
      if (unsettledRows.length > 1) {
        conflict("ambiguous actor has multiple unsettled attempts");
      }
      const unsettledAttempt = unsettledRows[0] === undefined
        ? null
        : parseActorAttemptRow(unsettledRows[0]);
      const activeIncarnation = this.readActiveIncarnationForActor(actor.id);
      const stoppedWithoutLiveLineage = actor.state === "stopped" &&
        liveTurn === null && unsettledAttempt === null &&
        activeIncarnation === null;
      if (actor.state === "stopped" && !stoppedWithoutLiveLineage) {
        conflict("stopped actor retains live ambiguous containment lineage");
      }
      if (
        !isTerminalActorAttemptState(evidenceAttempt.state) &&
        unsettledAttempt?.id !== evidenceAttempt.id
      ) {
        conflict("ambiguous evidence attempt lost its unsettled actor custody");
      }
      if (
        (!isTerminalActorTurnState(evidenceTurn.state) &&
          liveTurn?.id !== evidenceTurn.id) ||
        (unsettledAttempt !== null &&
          (liveTurn?.id !== unsettledAttempt.turnId ||
            activeIncarnation?.id !== unsettledAttempt.incarnationId))
      ) {
        conflict("ambiguous actor current turn custody is incoherent");
      }
      const attempts = unsettledAttempt === null ||
          unsettledAttempt.id === evidenceAttempt.id
        ? [evidenceAttempt]
        : [evidenceAttempt, unsettledAttempt];
      const attemptTurns = new Map<string, ActorTurn>();
      attemptTurns.set(evidenceAttempt.id, evidenceTurn);
      if (
        unsettledAttempt !== null &&
        unsettledAttempt.id !== evidenceAttempt.id
      ) {
        attemptTurns.set(
          unsettledAttempt.id,
          this.#requireTurn(unsettledAttempt.turnId),
        );
      }
      const incarnations = new Map<string, ActorIncarnationRecord>();
      const reservations = new Map<string, ActorFastReservationRecordV2>();
      for (const attempt of attempts) {
        const attemptTurn = attemptTurns.get(attempt.id);
        if (
          attemptTurn === undefined || attempt.turnId !== attemptTurn.id ||
          attemptTurn.actorId !== actor.id ||
          attemptTurn.epochId !== epoch.id
        ) {
          lineage("ambiguous containment attempt belongs to another actor");
        }
        const incarnation = this.#requireActorIncarnation(
          attempt.incarnationId,
        );
        if (
          incarnation.actorId !== actor.id ||
          incarnation.accountProfileId !== attempt.accountProfileId ||
          incarnation.processGeneration !== attempt.processGeneration
        ) {
          lineage("ambiguous containment lost its incarnation lineage");
        }
        incarnations.set(incarnation.id, incarnation);
        const reservation = this.#readActorFastReservationForAttempt(
          attempt.id,
        );
        if (reservation === null) {
          if (
            attempt.fastReservationId !== null ||
            attempt.realizedServiceTier === "fast"
          ) {
            throw new HarnessSQLiteAuthorityV2Error(
              "corrupt_state",
              "ambiguous Fast attempt lost its durable reservation",
            );
          }
          continue;
        }
        if (
          attempt.fastReservationId !== reservation.id ||
          attempt.realizedServiceTier !== "fast" ||
          attempt.effectGeneration === null ||
          reservation.epochId !== attemptTurn.epochId ||
          reservation.rootActorId !== epoch.rootActorId ||
          reservation.actorId !== actor.id ||
          reservation.accountProfileId !== attempt.accountProfileId ||
          reservation.processGeneration !== attempt.effectGeneration
        ) {
          lineage("ambiguous Fast reservation lost its exact attempt lineage");
        }
        if (
          reservation.state === "quarantined" &&
          reservation.terminalReason !== "ambiguousProviderEffect"
        ) {
          conflict("ambiguous Fast reservation has different quarantine evidence");
        }
        if (
          !isTerminalActorAttemptState(attempt.state) &&
          (reservation.state === "released" ||
            reservation.state === "consumed")
        ) {
          conflict("unsettled ambiguous attempt already released Fast capacity");
        }
        reservations.set(attempt.id, reservation);
      }
      if (activeIncarnation !== null) {
        incarnations.set(activeIncarnation.id, activeIncarnation);
      }
      const evidenceReservation = reservations.get(evidenceAttempt.id) ?? null;
      const recoveryAnchor =
        evidenceReservation?.state === "quarantined" &&
        evidenceReservation.terminalReason === "ambiguousProviderEffect";
      if (input.evidenceDigest === undefined && !recoveryAnchor) {
        conflict("ambiguous containment recovery lacks its exact Fast anchor");
      }

      const sessionRowSchema = z.object({
        incarnation_id: actorIncarnationIdSchema,
        actor_id: actorIdSchema,
        workspace_binding_id: actorWorkspaceBindingIdSchema,
        account_profile_id: z.string().min(1).max(96),
        admission_generation: z.number().int().positive().safe(),
        provider_thread_id: boundedProviderIdSchema,
        state: actorSessionBindingStateSchema,
        quarantine_reason: actorSessionQuarantineReasonV2Schema.nullable(),
        revision: z.number().int().positive().safe(),
        updated_at: isoTimestampSchema,
      }).strict();
      const sessions = new Map<
        string,
        z.infer<typeof sessionRowSchema>
      >();
      const workspaceBindings = new Map<string, ActorWorkspaceBinding>();
      const accountLeases = new Map<string, ActorAccountLeaseRecordV2>();
      for (const incarnation of incarnations.values()) {
        const sessionValue: unknown = this.#database.query(`
          SELECT incarnation_id, actor_id, workspace_binding_id,
            account_profile_id, admission_generation, provider_thread_id,
            state, quarantine_reason, revision, updated_at
          FROM harness_actor_session_bindings WHERE incarnation_id = ?1
        `).get(incarnation.id);
        if (sessionValue !== null) {
          const session = sessionRowSchema.parse(sessionValue);
          if (
            session.actor_id !== actor.id ||
            session.account_profile_id !== incarnation.accountProfileId ||
            session.admission_generation !== incarnation.processGeneration ||
            session.provider_thread_id !== incarnation.providerThreadId ||
            (session.state === "bound" &&
              incarnation.state !== "starting" &&
              incarnation.state !== "idle" &&
              incarnation.state !== "running") ||
            (session.state === "retired" &&
              incarnation.state !== "closed")
          ) {
            lineage("ambiguous containment lost its actor-session lineage");
          }
          sessions.set(incarnation.id, session);
          const workspace = this.#requireWorkspaceBinding(
            session.workspace_binding_id,
          );
          if (
            workspace.actorId !== actor.id ||
            workspace.authority !== actor.budget.laneAuthority ||
            (session.state !== "retired" && workspace.state === "released")
          ) {
            lineage("ambiguous containment lost its workspace binding");
          }
          workspaceBindings.set(workspace.id, workspace);
        } else if (attempts.some((attempt) =>
          attempt.incarnationId === incarnation.id &&
          reservations.has(attempt.id)
        )) {
          lineage("ambiguous Fast attempt lost its actor-session binding");
        }
        const accountLease = this.#readActorAccountLeaseByIncarnation(
          incarnation.id,
        );
        if (accountLease !== null) {
          if (
            accountLease.actorId !== actor.id ||
            accountLease.accountProfileId !== incarnation.accountProfileId ||
            accountLease.processGeneration !== incarnation.processGeneration ||
            (accountLease.state === "released" &&
              incarnation.state !== "closed")
          ) {
            lineage("ambiguous containment lost its account lease");
          }
          accountLeases.set(accountLease.id, accountLease);
        }
      }
      const activeWorkspaceRows: unknown[] = this.#database.query(`
        SELECT * FROM harness_actor_workspace_bindings
        WHERE actor_id = ?1 AND state = 'active'
        ORDER BY binding_id LIMIT 2
      `).all(actor.id);
      if (activeWorkspaceRows.length > 1) {
        throw new HarnessSQLiteAuthorityV2Error(
          "corrupt_state",
          "ambiguous actor has multiple active workspace bindings",
        );
      }
      if (activeWorkspaceRows[0] !== undefined) {
        const workspace = parseWorkspaceBindingRow(activeWorkspaceRows[0]);
        if (workspace.authority !== actor.budget.laneAuthority) {
          lineage("ambiguous actor workspace widened its lane authority");
        }
        workspaceBindings.set(workspace.id, workspace);
      }

      const laneRowSchema = z.object({
        lane_id: laneIdSchema,
        mode: z.string(),
        status: z.string(),
        base_sha: z.string().regex(/^[0-9a-f]{40,64}$/u),
        branch_name: z.string().min(1).nullable(),
        quarantine_reason: z.string().nullable(),
        quarantined_at: isoTimestampSchema.nullable(),
        updated_at: isoTimestampSchema,
      }).strict();
      const lanes = new Map<string, z.infer<typeof laneRowSchema>>();
      for (const workspace of workspaceBindings.values()) {
        const lane = laneRowSchema.parse(this.#database.query(`
          SELECT lane_id, mode, status, base_sha, branch_name,
            quarantine_reason, quarantined_at, updated_at
          FROM workspace_leases WHERE lane_id = ?1
        `).get(workspace.laneId));
        const expectedMode = workspace.authority === "readOnlySnapshot"
          ? "harness_read_only_snapshot"
          : "managed_worktree";
        if (
          lane.mode !== expectedMode || lane.base_sha !== epoch.sourceSha ||
          (workspace.authority === "readOnlySnapshot") !==
            (lane.branch_name === null) ||
          (workspace.authority === "readOnlySnapshot" &&
            lane.status !== "ready") ||
          (workspace.authority === "managedWrite" &&
            lane.status !== "ready" && lane.status !== "quarantined") ||
          (lane.status === "quarantined" &&
            (lane.quarantine_reason === null || lane.quarantined_at === null)) ||
          (lane.status !== "quarantined" &&
            (lane.quarantine_reason !== null || lane.quarantined_at !== null))
        ) {
          lineage("ambiguous containment lost its exact workspace lane");
        }
        lanes.set(lane.lane_id, lane);
      }

      // A delayed exact observation may finish HMAC custody after an actor has
      // already stopped cleanly. The terminal source is still valid evidence,
      // but containment must be a pure replay: there is no live authority to
      // revoke and no source/profile/operation state may be rewritten.
      if (stoppedWithoutLiveLineage) {
        return Object.freeze({
          actor: this.#requireActor(actor.id),
          evidenceTurn: this.#requireTurn(evidenceTurn.id),
          containedTurn: null,
          evidenceAttempt: this.#requireActorAttempt(evidenceAttempt.id),
          containedAttempt: null,
          evidenceIncarnation: this.#requireActorIncarnation(
            evidenceAttempt.incarnationId,
          ),
          containedIncarnation: null,
          evidenceFastReservation:
            this.#readActorFastReservationForAttempt(evidenceAttempt.id),
          containedFastReservation: null,
        });
      }

      const containmentAt = [
        requestedAt,
        actor.updatedAt,
        evidenceTurn.settledAt ?? evidenceTurn.startedAt ??
          evidenceTurn.createdAt,
        ...(liveTurn === null
          ? []
          : [liveTurn.settledAt ?? liveTurn.startedAt ?? liveTurn.createdAt]),
        ...Array.from(
          attemptTurns.values(),
          ({ settledAt, startedAt, createdAt }) =>
            settledAt ?? startedAt ?? createdAt,
        ),
        ...attempts.map(({ settledAt, startedAt, createdAt }) =>
          settledAt ?? startedAt ?? createdAt
        ),
        ...Array.from(incarnations.values(), ({ updatedAt }) => updatedAt),
        ...Array.from(reservations.values(), ({ updatedAt }) => updatedAt),
        ...Array.from(sessions.values(), ({ updated_at }) => updated_at),
        ...Array.from(
          workspaceBindings.values(),
          ({ updatedAt }) => updatedAt,
        ),
        ...Array.from(accountLeases.values(), ({ updatedAt }) => updatedAt),
        ...Array.from(lanes.values(), ({ updated_at }) => updated_at),
      ].reduce((latest, candidate) => candidate > latest ? candidate : latest);
      const ambiguityDigest = input.evidenceDigest ?? createHash("sha256")
        .update("hra.actor.fast-ambiguity-recovery.v2\0")
        .update(evidenceReservation?.id ?? evidenceAttempt.id)
        .digest("hex");

      for (const incarnation of incarnations.values()) {
        this.#database.query(`
          UPDATE harness_actor_turn_usage_inbox
          SET quarantined = 1, quarantine_reason = 'ambiguous_provider_effect'
          WHERE quarantined = 0 AND attempt_id IN (
            SELECT attempt_id FROM harness_actor_turn_attempts
            WHERE incarnation_id = ?1
          )
        `).run(incarnation.id);
      }
      if (unsettledAttempt !== null) {
        this.transitionActorAttempt({
          attemptId: unsettledAttempt.id,
          expectedState: unsettledAttempt.state,
          nextState: "ambiguous",
          now: containmentAt,
        });
      }
      const turnsToContain = new Map<string, ActorTurn>();
      for (const attemptTurn of attemptTurns.values()) {
        turnsToContain.set(attemptTurn.id, attemptTurn);
      }
      if (liveTurn !== null) turnsToContain.set(liveTurn.id, liveTurn);
      for (const attemptTurn of turnsToContain.values()) {
        const currentTurn = this.#requireTurn(attemptTurn.id);
        if (!isTerminalActorTurnState(currentTurn.state)) {
          if (currentTurn.state === "prepared") {
            const changed = this.#database.query(`
              UPDATE harness_actor_turns SET
                state = 'ambiguous', revision = revision + 1,
                started_at = ?3, settled_at = ?3, outcome_code = ?4
              WHERE turn_id = ?1 AND revision = ?2 AND state = 'prepared'
            `).run(
              currentTurn.id,
              currentTurn.revision,
              containmentAt,
              `ambiguous_${ambiguityDigest.slice(0, 16)}`,
            );
            if (changed.changes !== 1) revisionConflict();
          } else {
            this.transitionActorTurn({
              turnId: currentTurn.id,
              expectedRevision: currentTurn.revision,
              nextState: "ambiguous",
              outcomeCode: `ambiguous_${ambiguityDigest.slice(0, 16)}`,
              now: containmentAt,
            });
          }
        } else if (
          currentTurn.id === evidenceTurn.id &&
          currentTurn.state !== "ambiguous" && recoveryAnchor
        ) {
          conflict("ambiguous Fast evidence names another terminal turn outcome");
        } else if (
          unsettledAttempt?.turnId === currentTurn.id &&
          currentTurn.state !== "ambiguous"
        ) {
          conflict("unsettled actor effect belongs to a terminal logical turn");
        }
      }

      for (const session of sessions.values()) {
        if (session.state === "bound") {
          const changed = this.#database.query(`
            UPDATE harness_actor_session_bindings SET
              state = 'quarantined',
              quarantine_reason = 'recovery_protocol_error',
              revision = revision + 1, updated_at = ?3,
              retired_at = NULL, quarantined_at = ?3
            WHERE incarnation_id = ?1 AND revision = ?2 AND state = 'bound'
          `).run(session.incarnation_id, session.revision, containmentAt);
          if (changed.changes !== 1) revisionConflict();
        }
      }
      for (const incarnation of incarnations.values()) {
        if (
          incarnation.state === "starting" || incarnation.state === "idle" ||
          incarnation.state === "running"
        ) {
          const changed = this.#database.query(`
            UPDATE harness_actor_incarnations SET
              state = 'quarantined', updated_at = ?2, closed_at = ?2
            WHERE incarnation_id = ?1
              AND state IN ('starting', 'idle', 'running')
          `).run(incarnation.id, containmentAt);
          if (changed.changes !== 1) revisionConflict();
        }
      }
      for (const lease of accountLeases.values()) {
        if (lease.state === "active") {
          const changed = this.#database.query(`
            UPDATE harness_actor_account_leases SET
              state = 'quarantined', updated_at = ?2, settled_at = ?2
            WHERE lease_id = ?1 AND state = 'active'
          `).run(lease.id, containmentAt);
          if (changed.changes !== 1) revisionConflict();
        }
      }
      for (const workspace of workspaceBindings.values()) {
        if (workspace.state === "active") {
          const changed = this.#database.query(`
            UPDATE harness_actor_workspace_bindings SET
              state = 'quarantined', revision = revision + 1,
              updated_at = ?2, released_at = ?2
            WHERE binding_id = ?1 AND state = 'active'
          `).run(workspace.id, containmentAt);
          if (changed.changes !== 1) revisionConflict();
        }
        const lane = lanes.get(workspace.laneId);
        if (
          workspace.authority === "managedWrite" &&
          lane?.status === "ready"
        ) {
          const changed = this.#database.query(`
            UPDATE workspace_leases SET
              status = 'quarantined',
              quarantine_reason = 'ambiguous_provider_effect',
              quarantined_at = ?2, updated_at = ?2
            WHERE lane_id = ?1 AND status = 'ready'
              AND quarantine_reason IS NULL AND quarantined_at IS NULL
          `).run(workspace.laneId, containmentAt);
          if (changed.changes !== 1) revisionConflict();
        }
      }
      const currentActor = this.#requireActor(actor.id);
      if (
        currentActor.state === "active" ||
        currentActor.state === "stopRequested"
      ) {
        const quarantined = transitionActor(
          currentActor,
          "quarantined",
          containmentAt,
        );
        const changed = this.#database.query(`
          UPDATE harness_actors SET
            state = 'quarantined', revision = ?3,
            updated_at = ?4, stopped_at = ?4
          WHERE actor_id = ?1 AND revision = ?2
            AND state IN ('active', 'stopRequested')
        `).run(
          currentActor.id,
          currentActor.revision,
          quarantined.revision,
          containmentAt,
        );
        if (changed.changes !== 1) revisionConflict();
      } else if (currentActor.state !== "quarantined") {
        conflict("ambiguous provider effect belongs to a stopped actor");
      }

      return Object.freeze({
        actor: this.#requireActor(actor.id),
        evidenceTurn: this.#requireTurn(evidenceTurn.id),
        containedTurn: liveTurn === null
          ? null
          : this.#requireTurn(liveTurn.id),
        evidenceAttempt: this.#requireActorAttempt(evidenceAttempt.id),
        containedAttempt: unsettledAttempt === null
          ? null
          : this.#requireActorAttempt(unsettledAttempt.id),
        evidenceIncarnation: this.#requireActorIncarnation(
          evidenceAttempt.incarnationId,
        ),
        containedIncarnation: activeIncarnation === null
          ? null
          : this.#requireActorIncarnation(activeIncarnation.id),
        evidenceFastReservation: this.#readActorFastReservationForAttempt(
          evidenceAttempt.id,
        ),
        containedFastReservation: unsettledAttempt === null
          ? null
          : this.#readActorFastReservationForAttempt(unsettledAttempt.id),
      });
    })();
  }

  markActorFastReservationEffectStarted(inputValue: Readonly<{
    reservationId: string;
    attemptId: string;
    now?: string;
  }>): ActorFastReservationRecordV2 {
    const input = z.object({
      reservationId: actorFastReservationIdSchema,
      attemptId: actorAttemptIdSchema,
      now: isoTimestampSchema.optional(),
    }).strict().parse(inputValue);
    const now = this.#timestamp(input.now);
    const reservation = this.#requireActorFastReservation(input.reservationId);
    if (reservation.attemptId !== input.attemptId) {
      lineage("Fast reservation does not belong to the actor attempt");
    }
    if (reservation.state === "effectStarted") return reservation;
    if (reservation.state !== "reserved") {
      invalidTransition("Fast reservation cannot start another provider effect");
    }
    const changed = this.#database.query(`
      UPDATE harness_actor_fast_reservations SET
        state = 'effectStarted', updated_at = ?2, effect_started_at = ?2
      WHERE reservation_id = ?1 AND state = 'reserved'
    `).run(input.reservationId, now);
    if (changed.changes !== 1) revisionConflict();
    return this.#requireActorFastReservation(input.reservationId);
  }

  settleActorFastReservation(inputValue: Readonly<{
    reservationId: string;
    attemptId: string;
    expectedState: "reserved" | "effectStarted" | "quarantined";
    nextState: "released" | "consumed" | "quarantined";
    reason:
      | "preEffectTerminal"
      | "definitiveNotApplied"
      | "providerTerminal"
      | "generationFenced"
      | "ambiguousProviderEffect";
    fenceEvidenceDigest?: string | null;
    fencedGeneration?: number | null;
    now?: string;
  }>): ActorFastReservationRecordV2 {
    const input = z.object({
      reservationId: actorFastReservationIdSchema,
      attemptId: actorAttemptIdSchema,
      expectedState: z.enum(["reserved", "effectStarted", "quarantined"]),
      nextState: z.enum(["released", "consumed", "quarantined"]),
      reason: actorFastReservationRecordV2Schema.shape.terminalReason.unwrap(),
      fenceEvidenceDigest: digestSchema.nullable().optional(),
      fencedGeneration: z.number().int().positive().safe().nullable().optional(),
      now: isoTimestampSchema.optional(),
    }).strict().parse(inputValue);
    const now = this.#timestamp(input.now);
    const reservation = this.#requireActorFastReservation(input.reservationId);
    if (reservation.attemptId !== input.attemptId) {
      lineage("Fast reservation does not belong to the actor attempt");
    }
    if (reservation.state === input.nextState) {
      if (reservation.terminalReason === input.reason) return reservation;
      conflict("Fast reservation was settled with different evidence");
    }
    if (reservation.state !== input.expectedState) {
      invalidTransition("Fast reservation CAS state changed");
    }
    const fenceEvidenceDigest = input.fenceEvidenceDigest ?? null;
    const fencedGeneration = input.fencedGeneration ?? null;
    if (
      input.expectedState === "quarantined" &&
      (fenceEvidenceDigest === null || fencedGeneration === null ||
        fencedGeneration < reservation.processGeneration)
    ) {
      lineage("quarantined Fast capacity requires exact generation fence evidence");
    }
    if (
      input.expectedState !== "quarantined" &&
      (fenceEvidenceDigest !== null || fencedGeneration !== null)
    ) {
      lineage("only quarantined Fast capacity accepts generation fence evidence");
    }
    const changed = this.#database.query(`
      UPDATE harness_actor_fast_reservations SET
        state = ?3, terminal_reason = ?4,
        fence_evidence_digest = ?5, fenced_generation = ?6,
        updated_at = ?7,
        effect_started_at = CASE
          WHEN ?3 = 'quarantined' THEN COALESCE(effect_started_at, ?7)
          ELSE effect_started_at
        END,
        settled_at = CASE WHEN ?3 IN ('released', 'consumed')
          THEN ?7 ELSE NULL END,
        quarantined_at = CASE WHEN ?3 = 'quarantined' THEN ?7 ELSE NULL END
      WHERE reservation_id = ?1 AND attempt_id = ?2 AND state = ?8
    `).run(
      input.reservationId,
      input.attemptId,
      input.nextState,
      input.reason,
      fenceEvidenceDigest,
      fencedGeneration,
      now,
      input.expectedState,
    );
    if (changed.changes !== 1) revisionConflict();
    return this.#requireActorFastReservation(input.reservationId);
  }

  async bindActorAttemptProviderTurn(inputValue: Readonly<{
    attemptId: string;
    expectedState: "starting" | "reconciling";
    providerTurnId: string;
  }>): Promise<PersistedActorAttempt> {
    const attemptId = actorAttemptIdSchema.parse(inputValue.attemptId);
    const expectedState = z.enum(["starting", "reconciling"])
      .parse(inputValue.expectedState);
    const providerTurnId = boundedProviderIdSchema.parse(
      inputValue.providerTurnId,
    );
    const before = this.#requireActorAttempt(attemptId);
    if (before.state !== expectedState) invalidTransition("attempt CAS state changed");
    if (before.providerTurnId !== null) {
      if (before.providerTurnId === providerTurnId) return before;
      lineage("an actor attempt cannot change provider turn identity");
    }
    const incarnation = this.#requireActorIncarnation(before.incarnationId);
    const session = this.#readActorSessionBinding(incarnation.id);
    if (
      incarnation.providerThreadId === null ||
      (incarnation.state !== "idle" && incarnation.state !== "running") ||
      (session !== null &&
        (
          session.state !== "bound" ||
          session.actorId !== incarnation.actorId ||
          session.accountProfileId !== before.accountProfileId ||
          session.admissionGeneration !== before.processGeneration ||
          session.providerThreadId !== incarnation.providerThreadId
        ))
    ) {
      throw new HarnessSQLiteAuthorityV2Error(
        "corrupt_state",
        "actor attempt lost its live provider session identity",
      );
    }
    const turn = this.#requireTurn(before.turnId);
    const expectedIdentityDigest = await this.#digestActorTurnUsageIdentity({
      epochId: turn.epochId,
      actorId: turn.actorId,
      accountProfileId: before.accountProfileId,
      processGeneration: before.processGeneration,
      providerThreadId: incarnation.providerThreadId,
      providerTurnId,
    });
    const bindingNow = this.#timestamp(undefined);

    return this.#database.transaction(() => {
      const current = this.#requireActorAttempt(attemptId);
      if (current.state !== expectedState || current.providerTurnId !== null) {
        invalidTransition("attempt CAS state changed");
      }
      const currentIncarnation = this.#requireActorIncarnation(
        current.incarnationId,
      );
      const currentSession = this.#readActorSessionBinding(
        current.incarnationId,
      );
      const quarantinedInbox = this.#database.query<
        { count: number },
        [string]
      >(`
        SELECT COUNT(*) AS count FROM harness_actor_turn_usage_inbox
        WHERE attempt_id = ?1 AND quarantined = 1
      `).get(attemptId)?.count ?? 0;
      if (
        currentIncarnation.providerThreadId !== incarnation.providerThreadId ||
        (currentIncarnation.state !== "idle" &&
          currentIncarnation.state !== "running") ||
        quarantinedInbox !== 0 ||
        (currentSession !== null &&
          (
            currentSession.state !== "bound" ||
            currentSession.actorId !== currentIncarnation.actorId ||
            currentSession.accountProfileId !== current.accountProfileId ||
            currentSession.admissionGeneration !== current.processGeneration ||
            currentSession.providerThreadId !==
              currentIncarnation.providerThreadId
          ))
      ) {
        throw new HarnessSQLiteAuthorityV2Error(
          "corrupt_state",
          "actor attempt provider binding crossed a quarantined session fence",
        );
      }
      const reroute = this.#readActorModelRerouteInbox(attemptId);
      if (reroute?.state === "settled") {
        throw new HarnessSQLiteAuthorityV2Error(
          "corrupt_state",
          "an unbound actor attempt has already-settled reroute evidence",
        );
      }
      if (reroute?.state === "pending") {
        const exactIdentity =
          reroute.providerIdentityDigest === expectedIdentityDigest;
        const rerouteChanged = this.#database.query(`
          UPDATE harness_actor_model_reroute_inbox SET
            state = ?2, quarantine_reason = ?3,
            updated_at = ?4, bound_at = ?4,
            quarantined_at = ?5
          WHERE attempt_id = ?1 AND state = 'pending'
        `).run(
          attemptId,
          exactIdentity ? "bound" : "quarantined",
          exactIdentity ? null : "provider_identity_conflict",
          bindingNow,
          exactIdentity ? null : bindingNow,
        );
        if (rerouteChanged.changes !== 1) revisionConflict();
      }
      const watermarkValue: unknown = this.#database.query(`
        SELECT provider_thread_id, token_usage_observation_generation,
          token_usage_latest_position,
          token_usage_cumulative_input_tokens,
          token_usage_cumulative_output_tokens,
          token_usage_cumulative_cached_input_tokens,
          token_usage_cumulative_reasoning_output_tokens
        FROM harness_actor_incarnations WHERE incarnation_id = ?1
      `).get(current.incarnationId);
      const watermark = z.object({
        provider_thread_id: boundedProviderIdSchema.nullable(),
        token_usage_observation_generation:
          z.number().int().positive().safe(),
        token_usage_latest_position:
          z.number().int().nonnegative().safe().nullable(),
        token_usage_cumulative_input_tokens:
          z.number().int().nonnegative().safe(),
        token_usage_cumulative_output_tokens:
          z.number().int().nonnegative().safe(),
        token_usage_cumulative_cached_input_tokens:
          z.number().int().nonnegative().safe().nullable(),
        token_usage_cumulative_reasoning_output_tokens:
          z.number().int().nonnegative().safe().nullable(),
      }).strict().parse(watermarkValue);
      if (watermark.provider_thread_id !== currentIncarnation.providerThreadId) {
        revisionConflict();
      }
      const inboxValue: unknown = this.#database.query(`
        SELECT attempt_id, provider_identity_digest, observation_generation,
          stream_position,
          cumulative_input_tokens, cumulative_output_tokens,
          cumulative_cached_input_tokens,
          cumulative_reasoning_output_tokens
        FROM harness_actor_turn_usage_inbox
        WHERE attempt_id = ?1 AND quarantined = 0
      `).get(attemptId);
      const inbox = inboxValue === null ? null : z.object({
        attempt_id: actorAttemptIdSchema,
        provider_identity_digest: digestSchema,
        observation_generation: z.number().int().positive().safe(),
        stream_position: z.number().int().nonnegative().safe(),
        cumulative_input_tokens: z.number().int().nonnegative().safe(),
        cumulative_output_tokens: z.number().int().nonnegative().safe(),
        cumulative_cached_input_tokens:
          z.number().int().nonnegative().safe().nullable(),
        cumulative_reasoning_output_tokens:
          z.number().int().nonnegative().safe().nullable(),
      }).strict().parse(inboxValue);
      if (
        inbox !== null &&
        (
          inbox.attempt_id !== current.id ||
          inbox.provider_identity_digest !== expectedIdentityDigest
        )
      ) {
        throw new HarnessSQLiteAuthorityV2Error(
          "corrupt_state",
          "buffered actor usage contradicts its bound provider identity",
        );
      }

      let inputTokens: number | null = null;
      let outputTokens: number | null = null;
      let cachedInputTokens: number | null = null;
      let reasoningOutputTokens: number | null = null;
      if (inbox !== null) {
        const disposition = cumulativeUsageDisposition({
          observation_generation:
            watermark.token_usage_observation_generation,
          stream_position: watermark.token_usage_latest_position,
          cumulative_input_tokens:
            watermark.token_usage_cumulative_input_tokens,
          cumulative_output_tokens:
            watermark.token_usage_cumulative_output_tokens,
          cumulative_cached_input_tokens:
            watermark.token_usage_cumulative_cached_input_tokens,
          cumulative_reasoning_output_tokens:
            watermark.token_usage_cumulative_reasoning_output_tokens,
        }, {
          processGeneration: inbox.observation_generation,
          streamPosition: inbox.stream_position,
          cumulativeInputTokens: inbox.cumulative_input_tokens,
          cumulativeOutputTokens: inbox.cumulative_output_tokens,
          cumulativeCachedInputTokens:
            inbox.cumulative_cached_input_tokens ?? undefined,
          cumulativeReasoningOutputTokens:
            inbox.cumulative_reasoning_output_tokens ?? undefined,
        });
        if (disposition !== "advance") {
          throw new HarnessSQLiteAuthorityV2Error(
            "corrupt_state",
            "buffered actor usage does not advance its thread watermark",
          );
        }
        inputTokens = inbox.cumulative_input_tokens -
          watermark.token_usage_cumulative_input_tokens;
        outputTokens = inbox.cumulative_output_tokens -
          watermark.token_usage_cumulative_output_tokens;
        if (
          inbox.cumulative_cached_input_tokens !== null &&
          watermark.token_usage_cumulative_cached_input_tokens !== null
        ) {
          cachedInputTokens = inbox.cumulative_cached_input_tokens -
            watermark.token_usage_cumulative_cached_input_tokens;
          if (cachedInputTokens < 0) lineage(
            "buffered cached-input usage regressed its thread watermark",
          );
        }
        if (
          inbox.cumulative_reasoning_output_tokens !== null &&
          watermark.token_usage_cumulative_reasoning_output_tokens !== null
        ) {
          reasoningOutputTokens = inbox.cumulative_reasoning_output_tokens -
            watermark.token_usage_cumulative_reasoning_output_tokens;
          if (reasoningOutputTokens < 0) lineage(
            "buffered reasoning-output usage regressed its thread watermark",
          );
        }
      }

      const bound = this.#database.query(`
        UPDATE harness_actor_turn_attempts SET
          provider_turn_id = ?3,
          token_usage_identity_digest = ?4,
          token_usage_observation_generation = ?5,
          token_usage_stream_position = ?6,
          token_usage_cumulative_input_tokens = ?7,
          token_usage_cumulative_output_tokens = ?8,
          input_tokens = ?9, output_tokens = ?10,
          token_usage_cumulative_cached_input_tokens = ?11,
          token_usage_cumulative_reasoning_output_tokens = ?12,
          cached_input_tokens = ?13, reasoning_output_tokens = ?14
        WHERE attempt_id = ?1 AND state = ?2 AND provider_turn_id IS NULL
      `).run(
        attemptId,
        expectedState,
        providerTurnId,
        inbox === null ? null : expectedIdentityDigest,
        inbox?.observation_generation ?? null,
        inbox?.stream_position ?? null,
        inbox?.cumulative_input_tokens ?? null,
        inbox?.cumulative_output_tokens ?? null,
        inputTokens,
        outputTokens,
        inbox?.cumulative_cached_input_tokens ?? null,
        inbox?.cumulative_reasoning_output_tokens ?? null,
        cachedInputTokens,
        reasoningOutputTokens,
      );
      if (bound.changes !== 1) invalidTransition("attempt CAS state changed");

      if (inbox !== null) {
        const advanced = this.#database.query(`
          UPDATE harness_actor_incarnations SET
            token_usage_observation_generation = ?2,
            token_usage_latest_position = ?3,
            token_usage_cumulative_input_tokens = ?4,
            token_usage_cumulative_output_tokens = ?5,
            token_usage_cumulative_cached_input_tokens =
              COALESCE(?6, token_usage_cumulative_cached_input_tokens),
            token_usage_cumulative_reasoning_output_tokens =
              COALESCE(?7, token_usage_cumulative_reasoning_output_tokens)
          WHERE incarnation_id = ?1
        `).run(
          current.incarnationId,
          inbox.observation_generation,
          inbox.stream_position,
          inbox.cumulative_input_tokens,
          inbox.cumulative_output_tokens,
          inbox.cumulative_cached_input_tokens,
          inbox.cumulative_reasoning_output_tokens,
        );
        if (advanced.changes !== 1) revisionConflict();
        const consumed = this.#database.query(`
          DELETE FROM harness_actor_turn_usage_inbox WHERE attempt_id = ?1
        `).run(attemptId);
        if (consumed.changes !== 1) {
          throw new HarnessSQLiteAuthorityV2Error(
            "corrupt_state",
            "bound actor usage inbox was not consumed exactly once",
          );
        }
      }
      return this.#requireActorAttempt(attemptId);
    })();
  }

  bindActorQuotaContinuationCapsule(inputValue: Readonly<{
    attemptId: string;
    expectedState: "running" | "reconciling";
    continuationHistoryValueId: string;
  }>): PersistedActorAttempt {
    const attemptId = actorAttemptIdSchema.parse(inputValue.attemptId);
    const expectedState = z.enum(["running", "reconciling"])
      .parse(inputValue.expectedState);
    const continuationHistoryValueId = contextValueIdSchema.parse(
      inputValue.continuationHistoryValueId,
    );
    const current = this.#requireActorAttempt(attemptId);
    if (current.state !== expectedState) {
      invalidTransition("attempt CAS state changed");
    }
    if (current.continuationHistoryValueId !== null) {
      if (current.continuationHistoryValueId === continuationHistoryValueId) {
        return current;
      }
      conflict("actor attempt already has different continuation history");
    }
    if (current.providerTurnId === null) {
      lineage("continuation history requires an admitted provider turn");
    }
    const lineageValue: unknown = this.#database.query(`
      SELECT value.value_id
      FROM harness_actor_turns AS turn
      JOIN harness_context_values AS value ON value.value_id = ?2
      WHERE turn.turn_id = ?1
        AND value.epoch_id = turn.epoch_id
        AND value.owner_actor_id = turn.actor_id
        AND value.source_turn_id = turn.turn_id
        AND value.kind = 'selection'
        AND value.purpose = 'completedPrefix'
        AND value.state = 'active'
    `).get(current.turnId, continuationHistoryValueId);
    if (!z.object({ value_id: contextValueIdSchema }).strict()
      .safeParse(lineageValue).success) {
      lineage("continuation history does not match its actor attempt");
    }
    const changed = this.#database.query(`
      UPDATE harness_actor_turn_attempts
      SET continuation_history_value_id = ?3
      WHERE attempt_id = ?1 AND state = ?2
        AND provider_turn_id IS NOT NULL
        AND continuation_history_value_id IS NULL
    `).run(attemptId, expectedState, continuationHistoryValueId);
    if (changed.changes !== 1) invalidTransition("attempt CAS state changed");
    return this.#requireActorAttempt(attemptId);
  }

  settleActorQuotaRejection(inputValue: Readonly<{
    attemptId: string;
    expectedState: "running" | "reconciling";
    providerTurnId: string;
    continuationHistoryValueId?: string | null;
    quotaProofDigest: string;
    inputTokens: number;
    outputTokens: number;
    now?: string;
  }>): PersistedActorAttempt {
    const input = z.object({
      attemptId: actorAttemptIdSchema,
      expectedState: z.enum(["running", "reconciling"]),
      providerTurnId: boundedProviderIdSchema,
      continuationHistoryValueId: contextValueIdSchema.nullable().optional(),
      quotaProofDigest: digestSchema,
      inputTokens: z.number().int().nonnegative().safe(),
      outputTokens: z.number().int().nonnegative().safe(),
      now: isoTimestampSchema.optional(),
    }).strict().parse(inputValue);
    const now = this.#timestamp(input.now);
    return this.#database.transaction(() => {
      let attempt = this.#requireActorAttempt(input.attemptId);
      if (attempt.state === "quotaRejected") {
        if (
          attempt.providerTurnId !== input.providerTurnId ||
          (input.continuationHistoryValueId !== undefined &&
            attempt.continuationHistoryValueId !==
              input.continuationHistoryValueId) ||
          attempt.quotaProofDigest !== input.quotaProofDigest ||
          attempt.inputTokens !== input.inputTokens ||
          attempt.outputTokens !== input.outputTokens
        ) {
          lineage(
            "replayed quota settlement changed its exact terminal evidence",
          );
        }
        return attempt;
      }
      if (
        attempt.state !== input.expectedState ||
        attempt.providerTurnId !== input.providerTurnId
      ) invalidTransition("quota settlement attempt fence changed");
      if (
        attempt.continuationHistoryValueId === null &&
        input.continuationHistoryValueId !== null &&
        input.continuationHistoryValueId !== undefined
      ) {
        attempt = this.bindActorQuotaContinuationCapsule({
          attemptId: attempt.id,
          expectedState: input.expectedState,
          continuationHistoryValueId: input.continuationHistoryValueId,
        });
      } else if (
        input.continuationHistoryValueId !== null &&
        input.continuationHistoryValueId !== undefined &&
        attempt.continuationHistoryValueId !== input.continuationHistoryValueId
      ) {
        lineage("quota settlement changed its continuation history capsule");
      }
      return this.transitionActorAttempt({
        attemptId: attempt.id,
        expectedState: input.expectedState,
        nextState: "quotaRejected",
        providerTurnId: input.providerTurnId,
        quotaProofDigest: input.quotaProofDigest,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        now,
      });
    })();
  }

  settleActorTerminalObservation(inputValue: Readonly<{
    resultId: string;
    attemptId: string;
    expectedAttemptState: "running" | "reconciling";
    nextAttemptState: "completed" | "failed" | "interrupted";
    providerTurnId: string;
    inputTokens: number;
    outputTokens: number;
    incarnationId: string;
    turnId: string;
    expectedTurnRevision: number;
    outcome: "succeeded" | "failed" | "cancelled";
    valueId: string | null;
    outcomeCode: string;
    now?: string;
  }>): Readonly<{ attempt: PersistedActorAttempt; result: ActorResult }> {
    const input = z.object({
      resultId: actorResultIdSchema,
      attemptId: actorAttemptIdSchema,
      expectedAttemptState: z.enum(["running", "reconciling"]),
      nextAttemptState: z.enum(["completed", "failed", "interrupted"]),
      providerTurnId: boundedProviderIdSchema,
      inputTokens: z.number().int().nonnegative().safe(),
      outputTokens: z.number().int().nonnegative().safe(),
      incarnationId: actorIncarnationIdSchema,
      turnId: actorTurnIdSchema,
      expectedTurnRevision: z.number().int().positive().safe(),
      outcome: z.enum(["succeeded", "failed", "cancelled"]),
      valueId: z.string().min(1).max(96).nullable(),
      outcomeCode: z.string().min(1).max(96),
      now: isoTimestampSchema.optional(),
    }).strict().parse(inputValue);
    const expectedOutcome = input.nextAttemptState === "completed"
      ? "succeeded"
      : input.nextAttemptState === "failed" ? "failed" : "cancelled";
    if (input.outcome !== expectedOutcome) {
      lineage("terminal actor observation outcome does not match its attempt state");
    }
    const now = this.#timestamp(input.now);
    return this.#database.transaction(() => {
      const attempt = this.#requireActorAttempt(input.attemptId);
      const turn = this.#requireTurn(input.turnId);
      const incarnation = this.#requireActorIncarnation(input.incarnationId);
      const replayingTerminalAttempt = attempt.state === input.nextAttemptState;
      if (
        (!replayingTerminalAttempt &&
          attempt.state !== input.expectedAttemptState) ||
        attempt.turnId !== turn.id ||
        attempt.incarnationId !== incarnation.id ||
        attempt.providerTurnId !== input.providerTurnId ||
        turn.revision !== input.expectedTurnRevision ||
        incarnation.actorId !== turn.actorId ||
        (incarnation.state !== "running" &&
          !(replayingTerminalAttempt && incarnation.state === "idle"))
      ) invalidTransition("terminal actor observation fence changed");
      let terminalAttempt = attempt;
      if (replayingTerminalAttempt) {
        if (
          attempt.inputTokens !== input.inputTokens ||
          attempt.outputTokens !== input.outputTokens
        ) {
          lineage(
            "replayed terminal actor observation changed its exact usage",
          );
        }
      } else {
        terminalAttempt = this.transitionActorAttempt({
          attemptId: attempt.id,
          expectedState: input.expectedAttemptState,
          nextState: input.nextAttemptState,
          providerTurnId: input.providerTurnId,
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          now,
        });
      }
      if (incarnation.state === "running") {
        this.transitionActorIncarnation({
          incarnationId: incarnation.id,
          expectedState: "running",
          nextState: "idle",
          providerThreadId: incarnation.providerThreadId,
          now,
        });
      }
      const result = this.settleActorResult({
        resultId: input.resultId,
        turnId: turn.id,
        terminalAttemptId: terminalAttempt.id,
        outcome: input.outcome,
        valueId: input.valueId,
        expectedTurnRevision: turn.revision,
        outcomeCode: input.outcomeCode,
        createdAt: now,
      });
      return Object.freeze({ attempt: terminalAttempt, result });
    })();
  }

  transitionActorAttempt(inputValue: Readonly<{
    attemptId: string;
    expectedState: ActorAttempt["state"];
    nextState: ActorAttempt["state"];
    providerTurnId?: string | null;
    quotaProofDigest?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    now?: string;
  }>): PersistedActorAttempt {
    const attemptId = actorAttemptIdSchema.parse(inputValue.attemptId);
    const expectedState = actorAttemptSchema.shape.state.parse(inputValue.expectedState);
    const nextState = actorAttemptSchema.shape.state.parse(inputValue.nextState);
    const now = this.#timestamp(inputValue.now);
    return this.#database.transaction(() => {
      const current = this.#requireActorAttempt(attemptId);
      if (current.state !== expectedState) {
        invalidTransition("attempt CAS state changed");
      }
      assertAttemptTransition(expectedState, nextState);
      const providerTurnId = inputValue.providerTurnId === undefined
        ? current.providerTurnId
        : boundedProviderIdSchema.nullable().parse(inputValue.providerTurnId);
      if (
        current.providerTurnId !== null &&
        providerTurnId !== current.providerTurnId
      ) {
        lineage("an actor attempt cannot change provider turn identity");
      }
      const quotaProofDigest = inputValue.quotaProofDigest === undefined
        ? current.quotaProofDigest
        : digestSchema.nullable().parse(inputValue.quotaProofDigest);
      const suppliedInputTokens = inputValue.inputTokens === undefined
        ? undefined
        : z.number().int().nonnegative().safe().nullable()
          .parse(inputValue.inputTokens);
      const suppliedOutputTokens = inputValue.outputTokens === undefined
        ? undefined
        : z.number().int().nonnegative().safe().nullable()
          .parse(inputValue.outputTokens);
      if (
        suppliedInputTokens !== undefined &&
          suppliedInputTokens !== current.inputTokens ||
        suppliedOutputTokens !== undefined &&
          suppliedOutputTokens !== current.outputTokens
      ) {
        throw new HarnessSQLiteAuthorityV2Error(
          "corrupt_state",
          "actor terminal usage lacks matching positioned evidence",
        );
      }
      const terminal = isTerminalActorAttemptState(nextState);
      const pendingUsage = this.#database.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM harness_actor_turn_usage_inbox
        WHERE attempt_id = ?1 AND quarantined = 0
      `).get(attemptId)?.count ?? 0;
      if (
        pendingUsage !== 0 &&
        (terminal || providerTurnId !== null || nextState !== "reconciling")
      ) {
        throw new HarnessSQLiteAuthorityV2Error(
          "corrupt_state",
          "buffered actor usage must be bound before this transition",
        );
      }
      if ((nextState === "quotaRejected") !== (quotaProofDigest !== null)) {
        lineage("only a proven quota rejection may carry quota evidence");
      }
      if (
        current.continuationHistoryValueId !== null &&
        terminal && nextState !== "quotaRejected"
      ) {
        lineage("a continuation-bearing attempt may only terminalize for quota");
      }
      if (
        (nextState === "running" || nextState === "completed") &&
        providerTurnId === null
      ) {
        lineage("a running or completed attempt requires its provider turn identity");
      }
      if ((current.inputTokens === null) !== (current.outputTokens === null)) {
        lineage("actor attempt token usage must be complete or absent");
      }
      const fastReservation = this.#readActorFastReservationForAttempt(
        current.id,
      );
      if (terminal && fastReservation !== null) {
        if (
          fastReservation.state === "released" ||
          fastReservation.state === "consumed"
        ) {
          // The coordinator may persist a definitive non-application release
          // immediately before terminalizing its attempt. Provider-terminal
          // consumption follows the same ordered settlement contract.
          if (fastReservation.terminalReason === null) {
            throw new HarnessSQLiteAuthorityV2Error(
              "corrupt_state",
              "terminal Fast reservation lacks its settlement reason",
            );
          }
        } else if (fastReservation.state === "quarantined") {
          // Ambiguous provider capacity remains held until a generation fence
          // is persisted explicitly through settleActorFastReservation.
        } else if (nextState === "ambiguous") {
          this.settleActorFastReservation({
            reservationId: fastReservation.id,
            attemptId: current.id,
            expectedState: fastReservation.state,
            nextState: "quarantined",
            reason: "ambiguousProviderEffect",
            now,
          });
        } else if (
          fastReservation.state === "reserved" && providerTurnId === null
        ) {
          this.settleActorFastReservation({
            reservationId: fastReservation.id,
            attemptId: current.id,
            expectedState: "reserved",
            nextState: "released",
            reason: "preEffectTerminal",
            now,
          });
        } else {
          let effectStarted = fastReservation;
          if (effectStarted.state === "reserved") {
            effectStarted = this.markActorFastReservationEffectStarted({
              reservationId: fastReservation.id,
              attemptId: current.id,
              now,
            });
          }
          this.settleActorFastReservation({
            reservationId: effectStarted.id,
            attemptId: current.id,
            expectedState: "effectStarted",
            nextState: "consumed",
            reason: "providerTerminal",
            now,
          });
        }
      }
      const startedAt = current.startedAt ??
        (nextState === "starting" ? null : now);
      const changed = this.#database.query(`
        UPDATE harness_actor_turn_attempts SET
          state = ?3, provider_turn_id = ?4, quota_proof_digest = ?5,
          started_at = ?6, settled_at = ?7
        WHERE attempt_id = ?1 AND state = ?2
      `).run(
        attemptId,
        expectedState,
        nextState,
        providerTurnId,
        quotaProofDigest,
        startedAt,
        terminal ? now : null,
      );
      if (changed.changes !== 1) {
        invalidTransition("attempt CAS state changed");
      }
      return this.#requireActorAttempt(attemptId);
    })();
  }

  settleClaimedActorCancellation(inputValue: Readonly<{
    resultId: string;
    operationId: string;
    attemptId: string;
    turnId: string;
    incarnationId: string;
    outcomeCode: string;
    now?: string;
  }>): ActorResult {
    const input = z.object({
      resultId: actorResultIdSchema,
      operationId: actorOperationIdSchema,
      attemptId: actorAttemptIdSchema,
      turnId: actorTurnIdSchema,
      incarnationId: actorIncarnationIdSchema,
      outcomeCode: z.string().min(1).max(96),
      now: isoTimestampSchema.optional(),
    }).strict().parse(inputValue);
    const now = this.#timestamp(input.now);
    return this.#database.transaction(() => {
      const operation = this.#requireActorOperation(input.operationId);
      const attempt = this.#requireActorAttempt(input.attemptId);
      const turn = this.#requireTurn(input.turnId);
      const incarnation = this.#requireActorIncarnation(input.incarnationId);
      const pendingUsage = this.#database.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM harness_actor_turn_usage_inbox
        WHERE attempt_id = ?1 AND quarantined = 0
      `).get(attempt.id)?.count ?? 0;
      if (
        operation.kind !== "turnStart" || operation.state !== "prepared" ||
        operation.turnId !== turn.id || operation.actorId !== turn.actorId ||
        attempt.turnId !== turn.id || attempt.incarnationId !== incarnation.id ||
        (attempt.state !== "starting" && attempt.state !== "reconciling") ||
        attempt.providerTurnId !== null ||
        attempt.continuationHistoryValueId !== null || pendingUsage !== 0 ||
        turn.desiredState !== "stop" ||
        (turn.state !== "starting" && turn.state !== "reconciling") ||
        incarnation.actorId !== turn.actorId || incarnation.state !== "running"
      ) {
        invalidTransition("claimed actor cancellation lost its pre-effect fence");
      }
      const interrupted = this.transitionActorAttempt({
        attemptId: attempt.id,
        expectedState: attempt.state,
        nextState: "interrupted",
        now,
      });
      this.transitionActorIncarnation({
        incarnationId: incarnation.id,
        expectedState: "running",
        nextState: "idle",
        providerThreadId: incarnation.providerThreadId,
        now,
      });
      return this.settleActorResult({
        resultId: input.resultId,
        turnId: turn.id,
        terminalAttemptId: interrupted.id,
        outcome: "cancelled",
        valueId: null,
        expectedTurnRevision: turn.revision,
        outcomeCode: input.outcomeCode,
        createdAt: now,
      });
    })();
  }

  readActorAttempt(attemptId: string): PersistedActorAttempt | null {
    return this.#readActorAttempt(actorAttemptIdSchema.parse(attemptId));
  }

  readActorAttemptByProviderTurnId(inputValue: Readonly<{
    accountProfileId: string;
    processGeneration: number;
    providerTurnId: string;
  }>): PersistedActorAttempt | null {
    const accountProfileId = z.string().min(1).max(96)
      .parse(inputValue.accountProfileId);
    const processGeneration = z.number().int().positive().safe()
      .parse(inputValue.processGeneration);
    const providerTurnId = boundedProviderIdSchema.parse(inputValue.providerTurnId);
    const rows: unknown[] = this.#database.query(`
      SELECT * FROM harness_actor_turn_attempts
      WHERE account_profile_id = ?1 AND effect_generation = ?2
        AND provider_turn_id = ?3
      ORDER BY attempt_id LIMIT 2
    `).all(accountProfileId, processGeneration, providerTurnId);
    if (rows.length > 1) {
      throw new HarnessSQLiteAuthorityV2Error(
        "corrupt_state",
        "provider turn identity is ambiguous within its effect generation",
      );
    }
    const row = rows[0];
    return row === undefined ? null : parseActorAttemptRow(row);
  }

  resolveActorAttemptObservation(inputValue: Readonly<{
    accountProfileId: string;
    observationGeneration: number;
    providerThreadId: string;
    providerTurnId: string;
  }>): ActorAttemptObservationBindingV2 | null {
    const input = z.object({
      accountProfileId: z.string().min(1).max(96),
      observationGeneration: z.number().int().positive().safe(),
      providerThreadId: boundedProviderIdSchema,
      providerTurnId: boundedProviderIdSchema,
    }).strict().parse(inputValue);
    const rows: unknown[] = this.#database.query(`
      SELECT attempt.*,
        session.admission_generation AS session_admission_generation,
        session.live_generation AS session_live_generation,
        session.revision AS session_revision,
        session.recovery_proof_digest AS session_recovery_proof_digest
      FROM harness_actor_turn_attempts AS attempt
      JOIN harness_actor_incarnations AS incarnation
        ON incarnation.incarnation_id = attempt.incarnation_id
      JOIN harness_actor_session_bindings AS session
        ON session.incarnation_id = incarnation.incarnation_id
      WHERE attempt.account_profile_id = ?1
        AND attempt.provider_turn_id = ?2
        AND incarnation.provider_thread_id = ?3
        AND session.state = 'bound'
        AND session.account_profile_id = ?1
        AND session.provider_thread_id = ?3
        AND session.admission_generation = attempt.process_generation
        AND attempt.effect_generation IS NOT NULL
        AND attempt.effect_generation <= session.live_generation
        AND session.live_generation = ?4
      ORDER BY attempt.attempt_id LIMIT 2
    `).all(
      input.accountProfileId,
      input.providerTurnId,
      input.providerThreadId,
      input.observationGeneration,
    );
    if (rows.length > 1) {
      throw new HarnessSQLiteAuthorityV2Error(
        "corrupt_state",
        "provider observation matches multiple actor attempts",
      );
    }
    const row = rows[0];
    if (row === undefined) return null;
    const joined = actorAttemptObservationRowSchema.parse(row);
    const {
      session_admission_generation: sessionAdmissionGeneration,
      session_live_generation: sessionLiveGeneration,
      session_revision: sessionRevision,
      session_recovery_proof_digest: sessionRecoveryProofDigest,
      ...attemptRow
    } = joined;
    const attempt = parseActorAttemptRow(attemptRow);
    if (
      sessionAdmissionGeneration !== attempt.processGeneration ||
      attempt.effectGeneration === null ||
      attempt.effectGeneration > sessionLiveGeneration
    ) {
      throw new HarnessSQLiteAuthorityV2Error(
        "corrupt_state",
        "provider observation changed immutable attempt admission",
      );
    }
    return Object.freeze({
      attempt,
      admissionGeneration: sessionAdmissionGeneration,
      effectGeneration: attempt.effectGeneration,
      currentObservationGeneration: sessionLiveGeneration,
      sessionBindingRevision: sessionRevision,
      sessionRecoveryProofDigest,
    });
  }

  listUnsettledActorAttempts(inputValue: Readonly<{
    afterAttemptId?: string | null;
    limit: number;
  }>): readonly PersistedActorAttempt[] {
    const afterAttemptId = actorAttemptIdSchema.nullable()
      .parse(inputValue.afterAttemptId ?? null);
    const limit = z.number().int().min(1).max(128).parse(inputValue.limit);
    const rows: unknown[] = this.#database.query(`
      SELECT * FROM harness_actor_turn_attempts
      WHERE attempt_id > COALESCE(?1, '')
        AND state IN ('starting', 'running', 'reconciling')
      ORDER BY attempt_id LIMIT ?2
    `).all(afterAttemptId, limit);
    return rows.map((row) => parseActorAttemptRow(row));
  }

  listActorAttempts(inputValue: Readonly<{
    turnId: string;
    afterOrdinal?: number;
    limit: number;
  }>): readonly PersistedActorAttempt[] {
    const turnId = actorTurnIdSchema.parse(inputValue.turnId);
    const afterOrdinal = z.number().int().nonnegative().safe()
      .parse(inputValue.afterOrdinal ?? 0);
    const limit = z.number().int().min(1).max(128).parse(inputValue.limit);
    const rows: unknown[] = this.#database.query(`
      SELECT * FROM harness_actor_turn_attempts
      WHERE turn_id = ?1 AND ordinal > ?2
      ORDER BY ordinal, attempt_id LIMIT ?3
    `).all(turnId, afterOrdinal, limit);
    return rows.map((row) => parseActorAttemptRow(row));
  }

  listLiveActorAttempts(inputValue: Readonly<{
    afterAttemptId?: string | null;
    limit: number;
  }>): readonly PersistedActorAttempt[] {
    return this.listUnsettledActorAttempts(inputValue);
  }

  listLiveActorTurns(inputValue: Readonly<{
    afterTurnId?: string | null;
    limit: number;
  }>): readonly ActorTurn[] {
    const afterTurnId = actorTurnIdSchema.nullable()
      .parse(inputValue.afterTurnId ?? null);
    const limit = z.number().int().min(1).max(128).parse(inputValue.limit);
    const rows: unknown[] = this.#database.query(`
      SELECT * FROM harness_actor_turns
      WHERE turn_id > COALESCE(?1, '')
        AND state IN ('prepared', 'starting', 'running', 'reconciling')
      ORDER BY turn_id LIMIT ?2
    `).all(afterTurnId, limit);
    return rows.map((row) => parseActorTurnRow(row));
  }

  settleActorResult(inputValue: Readonly<{
    resultId: string;
    turnId: string;
    terminalAttemptId: string | null;
    outcome: ActorResult["outcome"];
    valueId: string | null;
    expectedTurnRevision: number;
    outcomeCode: string;
    createdAt?: string;
  }>): ActorResult {
    return this.#settleActorResult(inputValue, false);
  }

  settleActorThreadAdmissionQuotaExhaustion(inputValue: Readonly<{
    resultId: string;
    turnId: string;
    actorStartOperationIds: readonly string[];
    expectedTurnRevision: number;
    outcomeCode: string;
    createdAt?: string;
  }>): ActorResult {
    const operationIds = z.array(actorOperationIdSchema).min(1).max(50)
      .parse(inputValue.actorStartOperationIds);
    if (new Set(operationIds).size !== operationIds.length) {
      lineage("thread-admission quota evidence contains duplicate operations");
    }
    return this.#database.transaction(() => {
      const turn = this.#requireTurn(actorTurnIdSchema.parse(inputValue.turnId));
      const accountGenerations = new Set<string>();
      for (const operationId of operationIds) {
        const operation = this.#requireActorOperation(operationId);
        if (
          operation.actorId !== turn.actorId || operation.turnId !== null ||
          operation.kind !== "actorStart" || operation.state !== "notApplied"
        ) {
          lineage(
            "thread-admission quota evidence is not an exact actor-start rejection",
          );
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(operation.providerIdentityJson ?? "null") as unknown;
        } catch {
          lineage("thread-admission quota evidence is not valid JSON");
        }
        const envelope = actorStartQuotaEvidenceEnvelopeSchema.safeParse(parsed);
        if (
          !envelope.success || envelope.data.request.actorId !== turn.actorId
        ) {
          lineage(
            "thread-admission quota evidence lacks definitive pre-effect proof",
          );
        }
        const accountGeneration =
          `${envelope.data.request.accountProfileId.length}:` +
          `${envelope.data.request.accountProfileId}:` +
          String(envelope.data.request.processGeneration);
        if (accountGenerations.has(accountGeneration)) {
          lineage(
            "thread-admission quota evidence repeats an account generation",
          );
        }
        accountGenerations.add(accountGeneration);
      }
      const liveAttempts = this.#database.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM harness_actor_turn_attempts
        WHERE turn_id = ?1
      `).get(turn.id)?.count ?? 0;
      if (liveAttempts !== 0) {
        lineage(
          "thread-admission quota settlement cannot contain provider-turn attempts",
        );
      }
      return this.#settleActorResult({
        resultId: inputValue.resultId,
        turnId: turn.id,
        terminalAttemptId: null,
        outcome: "quotaRejected",
        valueId: null,
        expectedTurnRevision: inputValue.expectedTurnRevision,
        outcomeCode: inputValue.outcomeCode,
        ...(inputValue.createdAt === undefined
          ? {} : { createdAt: inputValue.createdAt }),
      }, true);
    })();
  }

  #settleActorResult(inputValue: Readonly<{
    resultId: string;
    turnId: string;
    terminalAttemptId: string | null;
    outcome: ActorResult["outcome"];
    valueId: string | null;
    expectedTurnRevision: number;
    outcomeCode: string;
    createdAt?: string;
  }>, allowEffectFreeQuota: boolean): ActorResult {
    const resultId = actorResultIdSchema.parse(inputValue.resultId);
    const turnId = actorTurnIdSchema.parse(inputValue.turnId);
    const terminalAttemptId = actorAttemptIdSchema.nullable().parse(
      inputValue.terminalAttemptId,
    );
    const outcome = actorResultSchema.shape.outcome.parse(inputValue.outcome);
    const valueId = z.string().min(1).max(96).nullable().parse(inputValue.valueId);
    const expectedTurnRevision = z.number().int().positive().safe()
      .parse(inputValue.expectedTurnRevision);
    const outcomeCode = z.string().min(1).max(96).parse(inputValue.outcomeCode);
    const createdAt = this.#timestamp(inputValue.createdAt);

    return this.#database.transaction(() => {
      const byId = this.#readActorResult(resultId);
      const byTurn = this.#readActorResultByTurn(turnId);
      if (byId !== null || byTurn !== null) {
        if (
          byId !== null && byTurn !== null && byId.id === byTurn.id &&
          byId.turnId === turnId &&
          byId.terminalAttemptId === terminalAttemptId &&
          byId.outcome === outcome && byId.valueId === valueId
        ) return byId;
        conflict("logical turn already has a different terminal result");
      }

      const turn = this.#requireTurn(turnId);
      if (turn.revision !== expectedTurnRevision) revisionConflict();
      if (isTerminalActorTurnState(turn.state)) {
        conflict("terminal logical turn is missing its unique result");
      }
      const attempt = terminalAttemptId === null ? null : this.#requireActorAttempt(terminalAttemptId);
      if (attempt !== null && (attempt.turnId !== turnId || !isTerminalActorAttemptState(attempt.state))) {
        lineage("actor result requires a terminal attempt for the same turn");
      }
      const expectedOutcome = attempt === null
        ? outcome === "quotaRejected" && allowEffectFreeQuota
          ? "quotaRejected"
          : "cancelled"
        : attempt.state === "completed"
          ? "succeeded"
          : attempt.state === "failed"
            ? "failed"
            : attempt.state === "interrupted"
              ? "cancelled"
              : attempt.state === "quotaRejected"
                ? "quotaRejected"
                : null;
      if (outcome !== expectedOutcome) {
        lineage("actor result outcome does not match its terminal attempt");
      }
      if ((outcome === "succeeded") !== (valueId !== null)) {
        lineage("only a successful actor result may reference a value");
      }
      if (valueId !== null) {
        const resultValue: unknown = this.#database.query(`
          SELECT epoch_id, owner_actor_id, source_turn_id, purpose, state
          FROM harness_context_values WHERE value_id = ?1
        `).get(valueId);
        const parsed = z.object({
          epoch_id: actorEpochIdSchema,
          owner_actor_id: actorIdSchema,
          source_turn_id: actorTurnIdSchema.nullable(),
          purpose: z.literal("agentResult"),
          state: z.literal("active"),
        }).strict().safeParse(resultValue);
        if (
          !parsed.success || parsed.data.epoch_id !== turn.epochId ||
          parsed.data.owner_actor_id !== turn.actorId ||
          parsed.data.source_turn_id !== turnId
        ) {
          lineage("successful result value does not match the logical turn");
        }
      }

      const actor = this.#requireActor(turn.actorId);
      const epoch = this.#requireEpoch(turn.epochId);
      const result = actorResultSchema.parse({
        id: resultId,
        epochId: epoch.id,
        actorId: actor.id,
        turnId,
        terminalAttemptId,
        outcome,
        valueId,
        actorResultOrdinal: actor.nextResultOrdinal,
        rootCompletionSequence: epoch.nextRootCompletionSequence,
        createdAt,
      });
      assertNextActorResult({
        actor,
        epoch,
        turn,
        attempt: attempt === null ? null : actorAttemptSchema.parse({
          id: attempt.id,
          turnId: attempt.turnId,
          incarnationId: attempt.incarnationId,
          ordinal: attempt.ordinal,
          accountProfileId: attempt.accountProfileId,
          processGeneration: attempt.processGeneration,
          clientUserMessageId: attempt.clientUserMessageId,
          state: attempt.state,
          quotaProofDigest: attempt.quotaProofDigest,
          createdAt: attempt.createdAt,
          startedAt: attempt.startedAt,
          settledAt: attempt.settledAt,
        }),
        result,
      });

      const nextTurnState: ActorTurnState = outcome === "succeeded"
        ? "succeeded"
        : outcome === "failed" ? "failed" : outcome === "quotaRejected" ? "quotaRejected" : "cancelled";
      const nextTurn = transitionActorTurn(
        turn,
        nextTurnState,
        createdAt,
        outcomeCode,
      );
      const advancedActor = this.#database.query(`
        UPDATE harness_actors SET
          next_result_ordinal = next_result_ordinal + 1,
          revision = revision + 1,
          updated_at = ?3
        WHERE actor_id = ?1 AND revision = ?2
      `).run(actor.id, actor.revision, createdAt);
      const advancedEpoch = this.#database.query(`
        UPDATE harness_actor_epochs SET
          next_root_completion_sequence = next_root_completion_sequence + 1,
          revision = revision + 1,
          updated_at = ?3
        WHERE epoch_id = ?1 AND revision = ?2
      `).run(epoch.id, epoch.revision, createdAt);
      const settledTurn = this.#database.query(`
        UPDATE harness_actor_turns SET
          state = ?3, revision = ?4, started_at = ?5,
          settled_at = ?6, outcome_code = ?7
        WHERE turn_id = ?1 AND revision = ?2
      `).run(
        turnId,
        turn.revision,
        nextTurn.state,
        nextTurn.revision,
        nextTurn.startedAt,
        nextTurn.settledAt,
        nextTurn.outcomeCode,
      );
      if (
        advancedActor.changes !== 1 || advancedEpoch.changes !== 1 ||
        settledTurn.changes !== 1
      ) revisionConflict();
      this.#database.query(`
        INSERT INTO harness_actor_results (
          result_id, epoch_id, actor_id, turn_id, terminal_attempt_id,
          outcome, value_id, actor_result_ordinal,
          root_completion_sequence, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
      `).run(
        result.id,
        result.epochId,
        result.actorId,
        result.turnId,
        result.terminalAttemptId,
        result.outcome,
        result.valueId,
        result.actorResultOrdinal,
        result.rootCompletionSequence,
        result.createdAt,
      );
      return this.#requireActorResult(resultId);
    })();
  }

  /**
   * Atomically terminalizes a turn whose durable quota-continuation capsule
   * failed exact lineage validation, contains any replacement attempt that is
   * still proven pre-effect, and revokes the owning actor. This is an
   * emergency containment transition, so it deliberately does not wait for
   * live descendants: quarantining the caller immediately removes their
   * control path while already-admitted descendants retain only their own
   * bounded authority and may settle normally.
   */
  settleInvalidQuotaContinuation(inputValue: Readonly<{
    resultId: string;
    turnId: string;
    terminalAttemptId: string;
    expectedTurnRevision: number;
    outcomeCode: string;
    createdAt?: string;
  }>): Readonly<{ actor: Actor; result: ActorResult }> {
    const createdAt = this.#timestamp(inputValue.createdAt);
    return this.#database.transaction(() => {
      const turn = this.#requireTurn(inputValue.turnId);
      const unsettledRows: unknown[] = this.#database.query(`
        SELECT * FROM harness_actor_turn_attempts
        WHERE turn_id = ?1 AND state IN ('starting', 'running', 'reconciling')
        ORDER BY ordinal, attempt_id
      `).all(turn.id);
      if (unsettledRows.length > 1) {
        conflict("invalid quota continuation has multiple live replacements");
      }
      const replacement = unsettledRows[0] === undefined
        ? null
        : parseActorAttemptRow(unsettledRows[0]);
      if (replacement !== null) {
        const incarnation = this.#requireActorIncarnation(
          replacement.incarnationId,
        );
        const session = this.#readActorSessionBinding(incarnation.id);
        const pendingUsage = this.#database.query<
          { count: number },
          [string]
        >(`
          SELECT COUNT(*) AS count FROM harness_actor_turn_usage_inbox
          WHERE attempt_id = ?1 AND quarantined = 0
        `).get(replacement.id)?.count ?? 0;
        if (
          (replacement.state !== "starting" &&
            replacement.state !== "reconciling") ||
          replacement.providerTurnId !== null ||
          replacement.continuationHistoryValueId !== null ||
          replacement.quotaProofDigest !== null ||
          replacement.inputTokens !== null ||
          replacement.outputTokens !== null ||
          pendingUsage !== 0 ||
          incarnation.actorId !== turn.actorId ||
          incarnation.state !== "running" ||
          session === null || session.state !== "bound" ||
          session.incarnationId !== incarnation.id ||
          session.actorId !== turn.actorId ||
          session.accountProfileId !== replacement.accountProfileId ||
          session.providerThreadId !== incarnation.providerThreadId
        ) {
          conflict(
            "invalid quota continuation replacement is not proven pre-effect",
          );
        }

        const operationRows: unknown[] = this.#database.query(`
          SELECT * FROM harness_actor_operations
          WHERE turn_id = ?1 AND kind = 'turnStart'
          ORDER BY operation_id
        `).all(turn.id);
        const matchingOperations = operationRows
          .map((row) => parseActorOperationRow(row))
          .filter((operation) => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(operation.providerIdentityJson ?? "null") as unknown;
            } catch {
              conflict("invalid quota continuation operation evidence is corrupt");
            }
            const envelope = z.object({
              version: z.literal(1),
              request: z.object({
                turnId: actorTurnIdSchema,
                incarnationId: actorIncarnationIdSchema,
                clientUserMessageId: requestIdentitySchema,
              }).passthrough(),
            }).passthrough().safeParse(parsed);
            if (!envelope.success) {
              conflict("invalid quota continuation operation evidence is corrupt");
            }
            return envelope.data.request.incarnationId === incarnation.id &&
              envelope.data.request.clientUserMessageId ===
                replacement.clientUserMessageId;
          });
        if (matchingOperations.length > 1) {
          conflict("invalid quota continuation has duplicate replacement effects");
        }
        const operation = matchingOperations[0] ?? null;
        if (operation !== null && operation.state !== "prepared") {
          conflict(
            "invalid quota continuation replacement may have reached the provider",
          );
        }

        this.transitionActorAttempt({
          attemptId: replacement.id,
          expectedState: replacement.state,
          nextState: "interrupted",
          now: createdAt,
        });
        this.transitionActorIncarnation({
          incarnationId: incarnation.id,
          expectedState: "running",
          nextState: "quarantined",
          providerThreadId: incarnation.providerThreadId,
          now: createdAt,
        });
      }
      const result = this.settleActorResult({
        resultId: inputValue.resultId,
        turnId: inputValue.turnId,
        terminalAttemptId: inputValue.terminalAttemptId,
        outcome: "quotaRejected",
        valueId: null,
        expectedTurnRevision: inputValue.expectedTurnRevision,
        outcomeCode: inputValue.outcomeCode,
        createdAt,
      });
      const actor = this.#requireActor(result.actorId);
      if (actor.state === "quarantined") return { actor, result };
      if (actor.state === "stopped") {
        conflict("invalid quota continuation belongs to an already stopped actor");
      }
      const quarantined = transitionActor(actor, "quarantined", createdAt);
      const changed = this.#database.query(`
        UPDATE harness_actors SET
          state = 'quarantined', revision = ?3, updated_at = ?4,
          stopped_at = ?4
        WHERE actor_id = ?1 AND revision = ?2
          AND state IN ('active', 'stopRequested')
      `).run(actor.id, actor.revision, quarantined.revision, createdAt);
      if (changed.changes !== 1) revisionConflict();
      return Object.freeze({
        actor: this.#requireActor(actor.id),
        result,
      });
    })();
  }

  readActorResult(resultId: string): ActorResult | null {
    return this.#readActorResult(actorResultIdSchema.parse(resultId));
  }

  readLatestActorResult(actorIdValue: string): ActorResult | null {
    const actorId = actorIdSchema.parse(actorIdValue);
    const row: unknown = this.#database.query(`
      SELECT * FROM harness_actor_results
      WHERE actor_id = ?1
      ORDER BY actor_result_ordinal DESC, result_id DESC
      LIMIT 1
    `).get(actorId);
    return row === null ? null : parseActorResultRow(row);
  }

  readActorResultForTurn(turnId: string): ActorResult | null {
    return this.#readActorResultByTurn(actorTurnIdSchema.parse(turnId));
  }

  listActorResults(inputValue: Readonly<{
    actorId: string;
    afterActorResultOrdinal?: number;
    limit: number;
  }>): readonly ActorResult[] {
    const actorId = actorIdSchema.parse(inputValue.actorId);
    const after = z.number().int().nonnegative().safe()
      .parse(inputValue.afterActorResultOrdinal ?? 0);
    const limit = z.number().int().min(1).max(128).parse(inputValue.limit);
    const rows: unknown[] = this.#database.query(`
      SELECT * FROM harness_actor_results
      WHERE actor_id = ?1 AND actor_result_ordinal > ?2
      ORDER BY actor_result_ordinal, result_id LIMIT ?3
    `).all(actorId, after, limit);
    return rows.map((row) => parseActorResultRow(row));
  }

  listEpochResults(inputValue: Readonly<{
    epochId: string;
    afterRootCompletionSequence?: number;
    limit: number;
  }>): readonly ActorResult[] {
    const epochId = actorEpochIdSchema.parse(inputValue.epochId);
    const after = z.number().int().nonnegative().safe()
      .parse(inputValue.afterRootCompletionSequence ?? 0);
    const limit = z.number().int().min(1).max(128).parse(inputValue.limit);
    const rows: unknown[] = this.#database.query(`
      SELECT * FROM harness_actor_results
      WHERE epoch_id = ?1 AND root_completion_sequence > ?2
      ORDER BY root_completion_sequence, result_id LIMIT ?3
    `).all(epochId, after, limit);
    return rows.map((row) => parseActorResultRow(row));
  }

  waitAnyResult(inputValue: Readonly<{
    epochId: string;
    actorIds: readonly string[];
    afterRootCompletionSequence?: number;
  }>): ActorResult | null {
    const epochId = actorEpochIdSchema.parse(inputValue.epochId);
    const actorIds = z.array(actorIdSchema).min(1).max(50).parse(inputValue.actorIds);
    if (new Set(actorIds).size !== actorIds.length) {
      conflict("waitAny actor identities must be unique");
    }
    const after = z.number().int().nonnegative().safe()
      .parse(inputValue.afterRootCompletionSequence ?? 0);
    for (const actorId of actorIds) {
      if (this.#requireActor(actorId).epochId !== epochId) {
        lineage("waitAny actor does not belong to the requested epoch");
      }
    }
    const placeholders = actorIds.map((_, index) => `?${String(index + 3)}`).join(", ");
    const row: unknown = this.#database.query(`
      SELECT * FROM harness_actor_results
      WHERE epoch_id = ?1 AND root_completion_sequence > ?2
        AND actor_id IN (${placeholders})
      ORDER BY root_completion_sequence, actor_id, turn_id LIMIT 1
    `).get(epochId, after, ...actorIds);
    return row === null ? null : parseActorResultRow(row);
  }

  bindActorWorkspace(inputValue: Readonly<{
    bindingId: string;
    actorId: string;
    laneId: string;
    authority: ActorWorkspaceBinding["authority"];
    createdAt?: string;
  }>): ActorWorkspaceBinding {
    const bindingId = actorWorkspaceBindingIdSchema.parse(inputValue.bindingId);
    const actorId = actorIdSchema.parse(inputValue.actorId);
    const laneId = laneIdSchema.parse(inputValue.laneId);
    const authority = actorLaneAuthoritySchema.parse(inputValue.authority);
    const createdAt = this.#timestamp(inputValue.createdAt);
    return this.#database.transaction(() => {
      const existing = this.#readWorkspaceBinding(bindingId);
      if (existing !== null) {
        if (
          existing.actorId === actorId && existing.laneId === laneId &&
          existing.authority === authority
        ) return existing;
        conflict("workspace binding identity already names another lane");
      }
      const actor = this.#requireActor(actorId);
      if (actor.state !== "active" || actor.budget.laneAuthority !== authority) {
        lineage("workspace authority does not match its active actor");
      }
      const laneValue: unknown = this.#database.query(`
        SELECT mode, status, base_sha, branch_name,
          quarantine_reason, quarantined_at
        FROM workspace_leases WHERE lane_id = ?1
      `).get(laneId);
      const lane = z.object({
        mode: z.string(),
        status: z.string(),
        base_sha: z.string().regex(/^[0-9a-f]{40,64}$/u),
        branch_name: z.string().min(1).nullable(),
        quarantine_reason: z.string().nullable(),
        quarantined_at: isoTimestampSchema.nullable(),
      }).strict().safeParse(laneValue);
      const expectedMode = authority === "readOnlySnapshot"
        ? "harness_read_only_snapshot"
        : "managed_worktree";
      if (
        !lane.success || lane.data.mode !== expectedMode ||
        lane.data.status !== "ready" || lane.data.base_sha !==
          this.#requireEpoch(actor.epochId).sourceSha ||
        (authority === "readOnlySnapshot") !== (lane.data.branch_name === null) ||
        lane.data.quarantine_reason !== null || lane.data.quarantined_at !== null
      ) {
        lineage("workspace lane is not a ready exact-authority actor lane");
      }
      this.#database.query(`
        INSERT INTO harness_actor_workspace_bindings (
          binding_id, actor_id, lane_id, authority, state, revision,
          created_at, updated_at, released_at
        ) VALUES (?1, ?2, ?3, ?4, 'active', 1, ?5, ?5, NULL)
      `).run(bindingId, actorId, laneId, authority, createdAt);
      return this.#requireWorkspaceBinding(bindingId);
    })();
  }

  releaseActorWorkspace(inputValue: Readonly<{
    bindingId: string;
    expectedRevision: number;
    disposition?: "released" | "quarantined";
    now?: string;
  }>): ActorWorkspaceBinding {
    const bindingId = actorWorkspaceBindingIdSchema.parse(inputValue.bindingId);
    const expectedRevision = z.number().int().positive().safe()
      .parse(inputValue.expectedRevision);
    const disposition = z.enum(["released", "quarantined"])
      .parse(inputValue.disposition ?? "released");
    const now = this.#timestamp(inputValue.now);
    const changed = this.#database.query(`
      UPDATE harness_actor_workspace_bindings SET
        state = ?3, revision = revision + 1,
        updated_at = ?4, released_at = ?4
      WHERE binding_id = ?1 AND revision = ?2 AND state = 'active'
    `).run(bindingId, expectedRevision, disposition, now);
    if (changed.changes !== 1) {
      if (this.#readWorkspaceBinding(bindingId) === null) {
        notFound("workspace binding does not exist");
      }
      revisionConflict();
    }
    return this.#requireWorkspaceBinding(bindingId);
  }

  attachActorPane(inputValue: Readonly<{
    bindingId: string;
    actorId: string;
    paneId: string;
    attachedAt?: string;
  }>): ActorPaneBinding {
    return this.#database.transaction(() =>
      this.attachActorPaneInTransaction(inputValue)
    )();
  }

  /**
   * Same durable attachment as `attachActorPane`, without opening a nested
   * transaction. Renderer effects use this only inside their one outer
   * control-plane transaction so the pane, actor binding, and semantic
   * witness cannot become independently visible after a crash.
   */
  attachActorPaneInTransaction(inputValue: Readonly<{
    bindingId: string;
    actorId: string;
    paneId: string;
    attachedAt?: string;
  }>): ActorPaneBinding {
    const bindingId = actorPaneBindingIdSchema.parse(inputValue.bindingId);
    const actorId = actorIdSchema.parse(inputValue.actorId);
    const paneId = paneIdSchema.parse(inputValue.paneId);
    const attachedAt = this.#timestamp(inputValue.attachedAt);
    const existing = this.#readPaneBinding(bindingId);
    if (existing !== null) {
      if (existing.actorId === actorId && existing.paneId === paneId) {
        return existing;
      }
      conflict("pane binding identity already names another attachment");
    }
    const actor = this.#requireActor(actorId);
    if (actor.state === "stopped" || actor.state === "quarantined") {
      invalidTransition("terminal actors cannot attach to panes");
    }
    const pane: unknown = this.#database.query(
      "SELECT pane_id FROM chat_panes WHERE pane_id = ?1",
    ).get(paneId);
    if (!z.object({ pane_id: paneIdSchema }).strict().safeParse(pane).success) {
      notFound("chat pane does not exist");
    }
    this.#database.query(`
      INSERT INTO harness_actor_pane_bindings (
        binding_id, actor_id, pane_id, state, revision,
        attached_at, detached_at
      ) VALUES (?1, ?2, ?3, 'attached', 1, ?4, NULL)
    `).run(bindingId, actorId, paneId, attachedAt);
    return this.#requirePaneBinding(bindingId);
  }

  /**
   * Atomically hands one pane from a quiescent root actor to another root.
   *
   * The caller owns the surrounding control-plane transaction. Keeping the
   * live-turn check, old-binding CAS, and new attachment in this primitive
   * prevents a source-epoch rollover from leaving the pane detached after a
   * crash or uniqueness conflict. Historical actors and epochs remain intact.
   */
  replaceActorPaneInTransaction(inputValue: Readonly<{
    paneId: string;
    expectedBindingId: string;
    expectedBindingRevision: number;
    nextBindingId: string;
    nextActorId: string;
    changedAt?: string;
  }>): Readonly<{
    previous: ActorPaneBinding;
    current: ActorPaneBinding;
  }> {
    const input = z.object({
      paneId: paneIdSchema,
      expectedBindingId: actorPaneBindingIdSchema,
      expectedBindingRevision: z.number().int().positive().safe(),
      nextBindingId: actorPaneBindingIdSchema,
      nextActorId: actorIdSchema,
      changedAt: isoTimestampSchema.optional(),
    }).strict().parse(inputValue);
    const changedAt = this.#timestamp(input.changedAt);
    if (input.expectedBindingId === input.nextBindingId) {
      conflict("pane replacement requires a different actor binding");
    }

    const previous = this.#requirePaneBinding(input.expectedBindingId);
    if (
      previous.paneId !== input.paneId || previous.state !== "attached" ||
      previous.revision !== input.expectedBindingRevision
    ) revisionConflict();
    const previousActor = this.#requireActor(previous.actorId);
    const previousEpoch = this.#requireEpoch(previousActor.epochId);
    const nextActor = this.#requireActor(input.nextActorId);
    const nextEpoch = this.#requireEpoch(nextActor.epochId);
    if (
      previousActor.parentActorId !== null ||
      previousEpoch.rootActorId !== previousActor.id ||
      nextActor.parentActorId !== null || nextEpoch.rootActorId !== nextActor.id ||
      nextActor.state !== "active"
    ) lineage("pane replacement requires two coherent root actors");

    const liveTurnsValue: unknown = this.#database.query(`
      SELECT COUNT(*) AS count FROM harness_actor_turns
      WHERE actor_id = ?1
        AND state IN ('prepared', 'starting', 'running', 'reconciling')
    `).get(previousActor.id);
    const liveTurns = z.object({
      count: z.number().int().nonnegative().safe(),
    }).strict().parse(liveTurnsValue).count;
    if (liveTurns !== 0) {
      invalidTransition("a root actor with live work cannot leave its pane");
    }

    const existingNext = this.#readPaneBinding(input.nextBindingId);
    if (
      existingNext !== null &&
      (
        existingNext.actorId !== nextActor.id ||
        existingNext.paneId !== input.paneId ||
        existingNext.state !== "detached"
      )
    ) conflict("replacement pane binding names another attachment");

    const detached = this.#database.query(`
      UPDATE harness_actor_pane_bindings SET
        state = 'detached', revision = revision + 1, detached_at = ?3
      WHERE binding_id = ?1 AND revision = ?2 AND state = 'attached'
    `).run(
      previous.id,
      input.expectedBindingRevision,
      changedAt,
    );
    if (detached.changes !== 1) revisionConflict();

    if (existingNext === null) {
      this.#database.query(`
        INSERT INTO harness_actor_pane_bindings (
          binding_id, actor_id, pane_id, state, revision,
          attached_at, detached_at
        ) VALUES (?1, ?2, ?3, 'attached', 1, ?4, NULL)
      `).run(input.nextBindingId, nextActor.id, input.paneId, changedAt);
    } else {
      const attached = this.#database.query(`
        UPDATE harness_actor_pane_bindings SET
          state = 'attached', revision = revision + 1,
          attached_at = ?3, detached_at = NULL
        WHERE binding_id = ?1 AND revision = ?2 AND state = 'detached'
      `).run(existingNext.id, existingNext.revision, changedAt);
      if (attached.changes !== 1) revisionConflict();
    }

    const detachedRecord = this.#requirePaneBinding(previous.id);
    const attachedRecord = this.#requirePaneBinding(input.nextBindingId);
    if (
      detachedRecord.state !== "detached" ||
      attachedRecord.state !== "attached" ||
      attachedRecord.actorId !== nextActor.id ||
      attachedRecord.paneId !== input.paneId
    ) {
      throw new HarnessSQLiteAuthorityV2Error(
        "corrupt_state",
        "pane replacement did not publish one exact attachment",
      );
    }
    return Object.freeze({
      previous: detachedRecord,
      current: attachedRecord,
    });
  }

  detachActorPane(inputValue: Readonly<{
    bindingId: string;
    expectedRevision: number;
    detachedAt?: string;
  }>): ActorPaneBinding {
    const bindingId = actorPaneBindingIdSchema.parse(inputValue.bindingId);
    const expectedRevision = z.number().int().positive().safe()
      .parse(inputValue.expectedRevision);
    const detachedAt = this.#timestamp(inputValue.detachedAt);
    const binding = this.#requirePaneBinding(bindingId);
    const actorBefore = this.#requireActor(binding.actorId);
    const changed = this.#database.query(`
      UPDATE harness_actor_pane_bindings SET
        state = 'detached', revision = revision + 1, detached_at = ?3
      WHERE binding_id = ?1 AND revision = ?2 AND state = 'attached'
    `).run(bindingId, expectedRevision, detachedAt);
    if (changed.changes !== 1) revisionConflict();
    const actorAfter = this.#requireActor(binding.actorId);
    if (exactJson(actorBefore) !== exactJson(actorAfter)) {
      throw new HarnessSQLiteAuthorityV2Error(
        "corrupt_state",
        "pane detachment changed actor lifecycle state",
      );
    }
    return this.#requirePaneBinding(bindingId);
  }

  readActorPaneBinding(bindingId: string): ActorPaneBinding | null {
    return this.#readPaneBinding(actorPaneBindingIdSchema.parse(bindingId));
  }

  readPaneBindingForActor(actorIdValue: string): ActorPaneBinding | null {
    const actorId = actorIdSchema.parse(actorIdValue);
    const row: unknown = this.#database.query(`
      SELECT * FROM harness_actor_pane_bindings
      WHERE actor_id = ?1 AND state = 'attached'
      ORDER BY binding_id LIMIT 1
    `).get(actorId);
    return row === null ? null : parsePaneBindingRow(row);
  }

  readActorForPane(paneIdValue: string): Actor | null {
    const paneId = paneIdSchema.parse(paneIdValue);
    const row: unknown = this.#database.query(`
      SELECT actor.* FROM harness_actors AS actor
      JOIN harness_actor_pane_bindings AS binding
        ON binding.actor_id = actor.actor_id
      WHERE binding.pane_id = ?1 AND binding.state = 'attached'
      ORDER BY actor.actor_id LIMIT 1
    `).get(paneId);
    return row === null ? null : parseActorRow(row);
  }

  #timestamp(value: string | undefined): string {
    return canonicalTimestamp(value ?? this.#now().toISOString());
  }

  #insertActor(
    actor: Actor,
    dispatchPolicy?: Readonly<{
      policyVersion: 0 | 1;
      workClass: ActorDispatchPolicyRecordV2["workClass"];
    }>,
  ): void {
    const policy = parseActorDispatchPolicyInput(actor.id, dispatchPolicy);
    this.#database.query(`
      INSERT INTO harness_actors (
        actor_id, epoch_id, parent_actor_id, depth, title, state,
        max_depth, max_active_descendants, max_durable_descendants,
        token_budget, byte_budget, deadline, lane_authority,
        token_reserved, byte_reserved, next_turn_ordinal,
        next_result_ordinal, revision, created_at, updated_at, stopped_at,
        dispatch_policy_version, work_class
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
        ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21,
        ?22, ?23
      )
    `).run(
      actor.id,
      actor.epochId,
      actor.parentActorId,
      actor.depth,
      actor.title,
      actor.state,
      actor.budget.maxDepth,
      actor.budget.maxActiveDescendants,
      actor.budget.maxDurableDescendants,
      actor.budget.tokenBudget,
      actor.budget.byteBudget,
      actor.budget.deadline,
      actor.budget.laneAuthority,
      actor.tokenReserved,
      actor.byteReserved,
      actor.nextTurnOrdinal,
      actor.nextResultOrdinal,
      actor.revision,
      actor.createdAt,
      actor.updatedAt,
      actor.stoppedAt,
      policy.policyVersion,
      policy.workClass,
    );
  }

  #assertDescendantCapacity(parentActorId: string): void {
    const ancestorRows: unknown[] = this.#database.query(`
      WITH RECURSIVE ancestors(actor_id, parent_actor_id) AS (
        SELECT actor_id, parent_actor_id FROM harness_actors WHERE actor_id = ?1
        UNION ALL
        SELECT actor.actor_id, actor.parent_actor_id
        FROM harness_actors AS actor
        JOIN ancestors ON actor.actor_id = ancestors.parent_actor_id
      )
      SELECT actor_id FROM ancestors ORDER BY actor_id
    `).all(parentActorId);
    const ancestors = z.array(z.object({ actor_id: actorIdSchema }).strict())
      .parse(ancestorRows);
    if (ancestors.length === 0) notFound("parent actor does not exist");
    for (const row of ancestors) {
      const ancestor = this.#requireActor(row.actor_id);
      if (ancestor.state !== "active") {
        invalidTransition("an actor ancestor has stopped admitting descendants");
      }
      const countsValue: unknown = this.#database.query(`
        WITH RECURSIVE descendants(actor_id, state) AS (
          SELECT actor_id, state FROM harness_actors WHERE parent_actor_id = ?1
          UNION ALL
          SELECT actor.actor_id, actor.state
          FROM harness_actors AS actor
          JOIN descendants ON actor.parent_actor_id = descendants.actor_id
        )
        SELECT
          COUNT(*) AS durable_count,
          COALESCE(SUM(CASE WHEN state IN ('active', 'stopRequested')
            THEN 1 ELSE 0 END), 0) AS active_count
        FROM descendants
      `).get(ancestor.id);
      const counts = z.object({
        durable_count: z.number().int().nonnegative().safe(),
        active_count: z.number().int().nonnegative().safe(),
      }).strict().parse(countsValue);
      if (
        counts.durable_count + 1 > ancestor.budget.maxDurableDescendants ||
        counts.active_count + 1 > ancestor.budget.maxActiveDescendants
      ) {
        throw new HarnessSQLiteAuthorityV2Error(
          "budget_exhausted",
          "recursive actor descendant capacity is exhausted",
        );
      }
    }
  }

  #countLiveDescendants(actorId: string): number {
    const value: unknown = this.#database.query(`
      WITH RECURSIVE descendants(actor_id, state) AS (
        SELECT actor_id, state FROM harness_actors WHERE parent_actor_id = ?1
        UNION ALL
        SELECT actor.actor_id, actor.state
        FROM harness_actors AS actor
        JOIN descendants ON actor.parent_actor_id = descendants.actor_id
      )
      SELECT COALESCE(SUM(CASE WHEN state IN ('active', 'stopRequested')
        THEN 1 ELSE 0 END), 0) AS count
      FROM descendants
    `).get(actorId);
    return z.object({ count: z.number().int().nonnegative().safe() })
      .strict().parse(value).count;
  }

  #readEpoch(epochId: string): ActorEpoch | null {
    const row: unknown = this.#database.query(
      "SELECT * FROM harness_actor_epochs WHERE epoch_id = ?1",
    ).get(epochId);
    return row === null ? null : parseActorEpochRow(row);
  }

  #requireEpoch(epochId: string): ActorEpoch {
    const value = this.#readEpoch(epochId);
    if (value === null) notFound("actor epoch does not exist");
    return value;
  }

  #readActor(actorId: string): Actor | null {
    const row: unknown = this.#database.query(
      "SELECT * FROM harness_actors WHERE actor_id = ?1",
    ).get(actorId);
    return row === null ? null : parseActorRow(row);
  }

  #requireActor(actorId: string): Actor {
    const value = this.#readActor(actorId);
    if (value === null) notFound("actor does not exist");
    return value;
  }

  #readTurn(turnId: string): ActorTurn | null {
    const row: unknown = this.#database.query(
      "SELECT * FROM harness_actor_turns WHERE turn_id = ?1",
    ).get(turnId);
    return row === null ? null : parseActorTurnRow(row);
  }

  #readTurnByIdempotencyKey(
    actorId: string,
    idempotencyKey: string,
  ): ActorTurn | null {
    const row: unknown = this.#database.query(`
      SELECT * FROM harness_actor_turns
      WHERE actor_id = ?1 AND idempotency_key = ?2
    `).get(actorId, idempotencyKey);
    return row === null ? null : parseActorTurnRow(row);
  }

  #requireTurn(turnId: string): ActorTurn {
    const value = this.#readTurn(turnId);
    if (value === null) notFound("logical actor turn does not exist");
    return value;
  }

  #readActorOperation(operationId: string): ActorOperationRecord | null {
    const row: unknown = this.#database.query(
      "SELECT * FROM harness_actor_operations WHERE operation_id = ?1",
    ).get(operationId);
    return row === null ? null : parseActorOperationRow(row);
  }

  #requireActorOperation(operationId: string): ActorOperationRecord {
    const value = this.#readActorOperation(operationId);
    if (value === null) notFound("actor operation does not exist");
    return value;
  }

  #readActorIncarnation(incarnationId: string): ActorIncarnationRecord | null {
    const row: unknown = this.#database.query(`
      SELECT * FROM harness_actor_incarnations WHERE incarnation_id = ?1
    `).get(incarnationId);
    return row === null ? null : parseActorIncarnationRow(row);
  }

  #requireActorIncarnation(incarnationId: string): ActorIncarnationRecord {
    const value = this.#readActorIncarnation(incarnationId);
    if (value === null) notFound("actor incarnation does not exist");
    return value;
  }

  #readActorSessionBinding(
    incarnationId: string,
  ): ActorSessionBindingRecordV2 | null {
    const row: unknown = this.#database.query(`
      SELECT session.*,
        actor.title AS actor_title,
        workspace.lane_id AS workspace_lane_id,
        workspace.authority AS workspace_authority,
        workspace.state AS workspace_state,
        lease.canonical_checkout_path AS workspace_path,
        lease.mode AS workspace_lease_mode,
        lease.status AS workspace_lease_status,
        incarnation.actor_id AS incarnation_actor_id,
        incarnation.account_profile_id AS incarnation_account_profile_id,
        incarnation.process_generation AS incarnation_admission_generation,
        incarnation.provider_thread_id AS incarnation_provider_thread_id,
        incarnation.thread_source AS incarnation_thread_source,
        incarnation.requested_model AS incarnation_requested_model,
        incarnation.requested_reasoning_effort AS
          incarnation_requested_reasoning_effort,
        incarnation.capability_evidence_digest AS
          incarnation_capability_evidence_digest,
        incarnation.supports_fast AS incarnation_supports_fast,
        incarnation.state AS incarnation_state
      FROM harness_actor_session_bindings AS session
      JOIN harness_actor_incarnations AS incarnation
        ON incarnation.incarnation_id = session.incarnation_id
      JOIN harness_actors AS actor ON actor.actor_id = session.actor_id
      JOIN harness_actor_workspace_bindings AS workspace
        ON workspace.binding_id = session.workspace_binding_id
      JOIN workspace_leases AS lease ON lease.lane_id = workspace.lane_id
      WHERE session.incarnation_id = ?1
    `).get(incarnationId);
    return row === null ? null : parseActorSessionBindingRow(row);
  }

  #requireActorSessionBinding(
    incarnationId: string,
  ): ActorSessionBindingRecordV2 {
    const value = this.#readActorSessionBinding(incarnationId);
    if (value === null) notFound("actor session binding does not exist");
    return value;
  }

  #readActorAttempt(attemptId: string): PersistedActorAttempt | null {
    const row: unknown = this.#database.query(`
      SELECT * FROM harness_actor_turn_attempts WHERE attempt_id = ?1
    `).get(attemptId);
    return row === null ? null : parseActorAttemptRow(row);
  }

  #requireActorAttempt(attemptId: string): PersistedActorAttempt {
    const value = this.#readActorAttempt(attemptId);
    if (value === null) notFound("actor turn attempt does not exist");
    return value;
  }

  #consumeActorTurnUsageAfterSessionRecovery(
    incarnationId: string,
    liveGeneration: number,
  ): void {
    const rows: unknown[] = this.#database.query(`
      SELECT inbox.attempt_id, inbox.provider_identity_digest,
        inbox.observation_generation, inbox.stream_position,
        inbox.cumulative_input_tokens, inbox.cumulative_output_tokens,
        inbox.cumulative_cached_input_tokens,
        inbox.cumulative_reasoning_output_tokens,
        attempt.state, attempt.provider_turn_id,
        attempt.token_usage_identity_digest,
        attempt.input_tokens, attempt.output_tokens,
        attempt.cached_input_tokens, attempt.reasoning_output_tokens,
        incarnation.token_usage_observation_generation,
        incarnation.token_usage_latest_position,
        incarnation.token_usage_cumulative_input_tokens,
        incarnation.token_usage_cumulative_output_tokens,
        incarnation.token_usage_cumulative_cached_input_tokens,
        incarnation.token_usage_cumulative_reasoning_output_tokens
      FROM harness_actor_turn_usage_inbox AS inbox
      JOIN harness_actor_turn_attempts AS attempt
        ON attempt.attempt_id = inbox.attempt_id
      JOIN harness_actor_incarnations AS incarnation
        ON incarnation.incarnation_id = attempt.incarnation_id
      WHERE attempt.incarnation_id = ?1
        AND inbox.quarantined = 0
        AND inbox.observation_generation <= ?2
        AND attempt.provider_turn_id IS NOT NULL
      ORDER BY inbox.attempt_id LIMIT 2
    `).all(incarnationId, liveGeneration);
    if (rows.length > 1) {
      throw new HarnessSQLiteAuthorityV2Error(
        "corrupt_state",
        "a recovered actor session has multiple buffered usage owners",
      );
    }
    if (rows.length === 0) return;
    const value = z.object({
      attempt_id: actorAttemptIdSchema,
      provider_identity_digest: digestSchema,
      observation_generation: z.number().int().positive().safe(),
      stream_position: z.number().int().nonnegative().safe(),
      cumulative_input_tokens: z.number().int().nonnegative().safe(),
      cumulative_output_tokens: z.number().int().nonnegative().safe(),
      cumulative_cached_input_tokens:
        z.number().int().nonnegative().safe().nullable(),
      cumulative_reasoning_output_tokens:
        z.number().int().nonnegative().safe().nullable(),
      state: actorAttemptSchema.shape.state,
      provider_turn_id: boundedProviderIdSchema,
      token_usage_identity_digest: digestSchema.nullable(),
      input_tokens: z.number().int().nonnegative().safe().nullable(),
      output_tokens: z.number().int().nonnegative().safe().nullable(),
      cached_input_tokens: z.number().int().nonnegative().safe().nullable(),
      reasoning_output_tokens:
        z.number().int().nonnegative().safe().nullable(),
      token_usage_observation_generation: z.number().int().positive().safe(),
      token_usage_latest_position: z.number().int().nonnegative().safe().nullable(),
      token_usage_cumulative_input_tokens: z.number().int().nonnegative().safe(),
      token_usage_cumulative_output_tokens: z.number().int().nonnegative().safe(),
      token_usage_cumulative_cached_input_tokens:
        z.number().int().nonnegative().safe().nullable(),
      token_usage_cumulative_reasoning_output_tokens:
        z.number().int().nonnegative().safe().nullable(),
    }).strict().parse(rows[0]);
    if (
      value.observation_generation > liveGeneration ||
      (value.token_usage_identity_digest !== null &&
        value.token_usage_identity_digest !== value.provider_identity_digest)
    ) {
      throw new HarnessSQLiteAuthorityV2Error(
        "corrupt_state",
        "buffered actor usage contradicts its recovered session lineage",
      );
    }
    const disposition = cumulativeUsageDisposition({
      observation_generation: value.token_usage_observation_generation,
      stream_position: value.token_usage_latest_position,
      cumulative_input_tokens: value.token_usage_cumulative_input_tokens,
      cumulative_output_tokens: value.token_usage_cumulative_output_tokens,
      cumulative_cached_input_tokens:
        value.token_usage_cumulative_cached_input_tokens,
      cumulative_reasoning_output_tokens:
        value.token_usage_cumulative_reasoning_output_tokens,
    }, {
      processGeneration: value.observation_generation,
      streamPosition: value.stream_position,
      cumulativeInputTokens: value.cumulative_input_tokens,
      cumulativeOutputTokens: value.cumulative_output_tokens,
      cumulativeCachedInputTokens:
        value.cumulative_cached_input_tokens ?? undefined,
      cumulativeReasoningOutputTokens:
        value.cumulative_reasoning_output_tokens ?? undefined,
    });
    if (disposition !== "advance") {
      throw new HarnessSQLiteAuthorityV2Error(
        "corrupt_state",
        "buffered successor usage does not advance the recovered actor watermark",
      );
    }
    const inputDelta = value.cumulative_input_tokens -
      value.token_usage_cumulative_input_tokens;
    const outputDelta = value.cumulative_output_tokens -
      value.token_usage_cumulative_output_tokens;
    const cachedInputDelta =
      value.cumulative_cached_input_tokens === null ||
        value.token_usage_cumulative_cached_input_tokens === null ||
        (value.token_usage_identity_digest !== null &&
          value.cached_input_tokens === null)
        ? null
        : value.cumulative_cached_input_tokens -
          value.token_usage_cumulative_cached_input_tokens;
    const reasoningOutputDelta =
      value.cumulative_reasoning_output_tokens === null ||
        value.token_usage_cumulative_reasoning_output_tokens === null ||
        (value.token_usage_identity_digest !== null &&
          value.reasoning_output_tokens === null)
        ? null
        : value.cumulative_reasoning_output_tokens -
          value.token_usage_cumulative_reasoning_output_tokens;
    if (
      (cachedInputDelta !== null && cachedInputDelta < 0) ||
      (reasoningOutputDelta !== null && reasoningOutputDelta < 0)
    ) lineage("buffered token breakdown regressed its recovered watermark");
    if (
      isTerminalActorAttemptState(value.state) &&
      (inputDelta !== 0 || outputDelta !== 0)
    ) {
      throw new HarnessSQLiteAuthorityV2Error(
        "corrupt_state",
        "terminal actor attempt received buffered successor usage",
      );
    }
    const attemptChanged = this.#database.query(`
      UPDATE harness_actor_turn_attempts SET
        token_usage_identity_digest = ?2,
        token_usage_observation_generation = ?3,
        token_usage_stream_position = ?4,
        token_usage_cumulative_input_tokens = ?5,
        token_usage_cumulative_output_tokens = ?6,
        input_tokens = COALESCE(input_tokens, 0) + ?7,
        output_tokens = COALESCE(output_tokens, 0) + ?8,
        token_usage_cumulative_cached_input_tokens =
          COALESCE(?10, token_usage_cumulative_cached_input_tokens),
        token_usage_cumulative_reasoning_output_tokens =
          COALESCE(?11, token_usage_cumulative_reasoning_output_tokens),
        cached_input_tokens = CASE WHEN ?12 IS NULL THEN NULL
          ELSE COALESCE(cached_input_tokens, 0) + ?12 END,
        reasoning_output_tokens = CASE WHEN ?13 IS NULL THEN NULL
          ELSE COALESCE(reasoning_output_tokens, 0) + ?13 END
      WHERE attempt_id = ?1 AND provider_turn_id = ?9
    `).run(
      value.attempt_id,
      value.provider_identity_digest,
      value.observation_generation,
      value.stream_position,
      value.cumulative_input_tokens,
      value.cumulative_output_tokens,
      inputDelta,
      outputDelta,
      value.provider_turn_id,
      value.cumulative_cached_input_tokens,
      value.cumulative_reasoning_output_tokens,
      cachedInputDelta,
      reasoningOutputDelta,
    );
    if (attemptChanged.changes !== 1) revisionConflict();
    const watermarkChanged = this.#database.query(`
      UPDATE harness_actor_incarnations SET
        token_usage_observation_generation = ?2,
        token_usage_latest_position = ?3,
        token_usage_cumulative_input_tokens = ?4,
        token_usage_cumulative_output_tokens = ?5,
        token_usage_cumulative_cached_input_tokens =
          COALESCE(?6, token_usage_cumulative_cached_input_tokens),
        token_usage_cumulative_reasoning_output_tokens =
          COALESCE(?7, token_usage_cumulative_reasoning_output_tokens)
      WHERE incarnation_id = ?1
    `).run(
      incarnationId,
      value.observation_generation,
      value.stream_position,
      value.cumulative_input_tokens,
      value.cumulative_output_tokens,
      value.cumulative_cached_input_tokens,
      value.cumulative_reasoning_output_tokens,
    );
    if (watermarkChanged.changes !== 1) revisionConflict();
    const consumed = this.#database.query(`
      DELETE FROM harness_actor_turn_usage_inbox
      WHERE attempt_id = ?1 AND quarantined = 0
    `).run(value.attempt_id);
    if (consumed.changes !== 1) {
      throw new HarnessSQLiteAuthorityV2Error(
        "corrupt_state",
        "recovered actor usage inbox was not consumed exactly once",
      );
    }
  }

  #bufferActorTurnUsageUntilSessionRecovery(input: Readonly<{
    attemptId: string;
    incarnationId: string;
    admissionGeneration: number;
    providerIdentityDigest: string;
    accountProfileId: string;
    processGeneration: number;
    providerThreadId: string;
    providerTurnId: string;
    streamPosition: number;
    cumulativeInputTokens: number;
    cumulativeOutputTokens: number;
    cumulativeCachedInputTokens?: number | undefined;
    cumulativeReasoningOutputTokens?: number | undefined;
  }>): "buffered" | "retry" {
    return this.#database.transaction(() => {
      const candidateValue: unknown = this.#database.query(`
        SELECT attempt.attempt_id, attempt.process_generation,
          attempt.provider_turn_id, attempt.state,
          attempt.token_usage_identity_digest,
          incarnation.incarnation_id, incarnation.provider_thread_id,
          incarnation.token_usage_observation_generation,
          incarnation.token_usage_latest_position,
          incarnation.token_usage_cumulative_input_tokens,
          incarnation.token_usage_cumulative_output_tokens,
          incarnation.token_usage_cumulative_cached_input_tokens,
          incarnation.token_usage_cumulative_reasoning_output_tokens,
          session.live_generation, profile.process_generation AS profile_generation
        FROM harness_actor_turn_attempts AS attempt
        JOIN harness_actor_incarnations AS incarnation
          ON incarnation.incarnation_id = attempt.incarnation_id
        JOIN harness_actor_session_bindings AS session
          ON session.incarnation_id = incarnation.incarnation_id
        JOIN account_profiles AS profile
          ON profile.profile_id = attempt.account_profile_id
        WHERE attempt.attempt_id = ?1
          AND attempt.account_profile_id = ?2
          AND attempt.provider_turn_id = ?3
          AND incarnation.incarnation_id = ?4
          AND incarnation.provider_thread_id = ?5
          AND session.state = 'bound'
          AND session.account_profile_id = attempt.account_profile_id
          AND session.admission_generation = attempt.process_generation
          AND session.provider_thread_id = incarnation.provider_thread_id
      `).get(
        input.attemptId,
        input.accountProfileId,
        input.providerTurnId,
        input.incarnationId,
        input.providerThreadId,
      );
      const candidate = z.object({
        attempt_id: actorAttemptIdSchema,
        process_generation: z.number().int().positive().safe(),
        provider_turn_id: boundedProviderIdSchema,
        state: actorAttemptSchema.shape.state,
        token_usage_identity_digest: digestSchema.nullable(),
        incarnation_id: actorIncarnationIdSchema,
        provider_thread_id: boundedProviderIdSchema,
        token_usage_observation_generation: z.number().int().positive().safe(),
        token_usage_latest_position: z.number().int().nonnegative().safe().nullable(),
        token_usage_cumulative_input_tokens: z.number().int().nonnegative().safe(),
        token_usage_cumulative_output_tokens: z.number().int().nonnegative().safe(),
        token_usage_cumulative_cached_input_tokens:
          z.number().int().nonnegative().safe().nullable(),
        token_usage_cumulative_reasoning_output_tokens:
          z.number().int().nonnegative().safe().nullable(),
        live_generation: z.number().int().positive().safe(),
        profile_generation: z.number().int().positive().safe(),
      }).strict().parse(candidateValue);
      if (
        candidate.process_generation !== input.admissionGeneration ||
        candidate.profile_generation !== input.processGeneration ||
        candidate.live_generation >= input.processGeneration ||
        candidate.provider_thread_id !== input.providerThreadId ||
        candidate.provider_turn_id !== input.providerTurnId ||
        !["starting", "running", "reconciling"].includes(candidate.state) ||
        (candidate.token_usage_identity_digest !== null &&
          candidate.token_usage_identity_digest !== input.providerIdentityDigest)
      ) {
        if (
          candidate.process_generation === input.admissionGeneration &&
          candidate.profile_generation >= input.processGeneration &&
          candidate.live_generation >= input.processGeneration &&
          candidate.provider_thread_id === input.providerThreadId &&
          candidate.provider_turn_id === input.providerTurnId
        ) return "retry";
        throw new HarnessSQLiteAuthorityV2Error(
          "revision_conflict",
          "actor session lineage changed while successor token usage was being buffered",
        );
      }
      const nextUsage = {
        processGeneration: input.processGeneration,
        streamPosition: input.streamPosition,
        cumulativeInputTokens: input.cumulativeInputTokens,
        cumulativeOutputTokens: input.cumulativeOutputTokens,
        cumulativeCachedInputTokens: input.cumulativeCachedInputTokens,
        cumulativeReasoningOutputTokens:
          input.cumulativeReasoningOutputTokens,
      };
      const inboxRows: unknown[] = this.#database.query(`
        SELECT attempt_id, provider_identity_digest, observation_generation,
          stream_position, cumulative_input_tokens, cumulative_output_tokens,
          cumulative_cached_input_tokens,
          cumulative_reasoning_output_tokens
        FROM harness_actor_turn_usage_inbox
        WHERE quarantined = 0
          AND (attempt_id = ?1 OR provider_identity_digest = ?2)
        ORDER BY attempt_id LIMIT 2
      `).all(input.attemptId, input.providerIdentityDigest);
      if (inboxRows.length > 1) {
        throw new HarnessSQLiteAuthorityV2Error(
          "corrupt_state",
          "successor provider usage identity is bound to multiple actor attempts",
        );
      }
      const inboxValue = inboxRows[0];
      if (inboxValue !== undefined) {
        const inbox = z.object({
          attempt_id: actorAttemptIdSchema,
          provider_identity_digest: digestSchema,
          observation_generation: z.number().int().positive().safe(),
          stream_position: z.number().int().nonnegative().safe(),
          cumulative_input_tokens: z.number().int().nonnegative().safe(),
          cumulative_output_tokens: z.number().int().nonnegative().safe(),
          cumulative_cached_input_tokens:
            z.number().int().nonnegative().safe().nullable(),
          cumulative_reasoning_output_tokens:
            z.number().int().nonnegative().safe().nullable(),
        }).strict().parse(inboxValue);
        if (
          inbox.attempt_id !== input.attemptId ||
          inbox.provider_identity_digest !== input.providerIdentityDigest
        ) {
          throw new HarnessSQLiteAuthorityV2Error(
            "corrupt_state",
            "successor provider usage identity changed while buffered",
          );
        }
        const disposition = cumulativeUsageDisposition({
          observation_generation: inbox.observation_generation,
          stream_position: inbox.stream_position,
          cumulative_input_tokens: inbox.cumulative_input_tokens,
          cumulative_output_tokens: inbox.cumulative_output_tokens,
          cumulative_cached_input_tokens:
            inbox.cumulative_cached_input_tokens,
          cumulative_reasoning_output_tokens:
            inbox.cumulative_reasoning_output_tokens,
        }, nextUsage);
        if (disposition === "stale" || disposition === "duplicate") return "buffered";
        const changed = this.#database.query(`
          UPDATE harness_actor_turn_usage_inbox SET
            observation_generation = ?2, stream_position = ?3,
            cumulative_input_tokens = ?4, cumulative_output_tokens = ?5,
            cumulative_cached_input_tokens =
              COALESCE(?6, cumulative_cached_input_tokens),
            cumulative_reasoning_output_tokens =
              COALESCE(?7, cumulative_reasoning_output_tokens)
          WHERE attempt_id = ?1 AND quarantined = 0
        `).run(
          input.attemptId,
          input.processGeneration,
          input.streamPosition,
          input.cumulativeInputTokens,
          input.cumulativeOutputTokens,
          input.cumulativeCachedInputTokens ?? null,
          input.cumulativeReasoningOutputTokens ?? null,
        );
        if (changed.changes !== 1) revisionConflict();
        return "buffered";
      }
      const watermarkDisposition = cumulativeUsageDisposition({
        observation_generation: candidate.token_usage_observation_generation,
        stream_position: candidate.token_usage_latest_position,
        cumulative_input_tokens: candidate.token_usage_cumulative_input_tokens,
        cumulative_output_tokens: candidate.token_usage_cumulative_output_tokens,
        cumulative_cached_input_tokens:
          candidate.token_usage_cumulative_cached_input_tokens,
        cumulative_reasoning_output_tokens:
          candidate.token_usage_cumulative_reasoning_output_tokens,
      }, nextUsage);
      if (watermarkDisposition !== "advance") {
        throw new HarnessSQLiteAuthorityV2Error(
          "corrupt_state",
          "successor provider usage does not advance its actor watermark",
        );
      }
      this.#database.query(`
        INSERT INTO harness_actor_turn_usage_inbox (
          attempt_id, provider_identity_digest, observation_generation,
          stream_position, cumulative_input_tokens, cumulative_output_tokens,
          cumulative_cached_input_tokens,
          cumulative_reasoning_output_tokens
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      `).run(
        input.attemptId,
        input.providerIdentityDigest,
        input.processGeneration,
        input.streamPosition,
        input.cumulativeInputTokens,
        input.cumulativeOutputTokens,
        input.cumulativeCachedInputTokens ?? null,
        input.cumulativeReasoningOutputTokens ?? null,
      );
      return "buffered";
    })();
  }

  async #digestActorTurnUsageIdentity(input: Readonly<{
    epochId: string;
    actorId: string;
    accountProfileId: string;
    processGeneration: number;
    providerThreadId: string;
    providerTurnId: string;
  }>): Promise<string> {
    if (this.#tokenUsageIdentities === null) {
      throw new HarnessSQLiteAuthorityV2Error(
        "corrupt_state",
        "actor token usage identity custody is unavailable",
      );
    }
    try {
      return digestSchema.parse(await this.#tokenUsageIdentities.digest(input));
    } catch (cause: unknown) {
      if (cause instanceof HarnessSQLiteAuthorityV2Error) throw cause;
      throw new HarnessSQLiteAuthorityV2Error(
        "corrupt_state",
        "actor token usage identity custody is unavailable",
        cause,
      );
    }
  }

  #readActorModelRerouteCandidates(input: Readonly<{
    accountProfileId: string;
    observationGeneration: number;
    providerThreadId: string;
    providerTurnId: string;
  }>): readonly z.infer<typeof actorModelRerouteCandidateRowSchema>[] {
    const exactRows: unknown[] = this.#database.query(`
      SELECT attempt.attempt_id, turn.epoch_id, turn.actor_id,
        attempt.process_generation AS admission_generation,
        incarnation.incarnation_id, attempt.provider_turn_id
      FROM harness_actor_turn_attempts AS attempt
      JOIN harness_actor_turns AS turn ON turn.turn_id = attempt.turn_id
      JOIN harness_actor_incarnations AS incarnation
        ON incarnation.incarnation_id = attempt.incarnation_id
      JOIN harness_actor_session_bindings AS session
        ON session.incarnation_id = incarnation.incarnation_id
      WHERE attempt.account_profile_id = ?1
        AND incarnation.account_profile_id = ?1
        AND incarnation.process_generation = attempt.process_generation
        AND incarnation.provider_thread_id = ?3
        AND session.account_profile_id = ?1
        AND session.actor_id = incarnation.actor_id
        AND turn.actor_id = incarnation.actor_id
        AND session.provider_thread_id = ?3
        AND session.admission_generation = attempt.process_generation
        AND attempt.effect_generation IS NOT NULL
        AND attempt.effect_generation <= ?2
        AND ?2 <= session.live_generation
        AND attempt.provider_turn_id = ?4
        AND session.state IN ('bound', 'quarantined', 'retired')
      ORDER BY attempt.attempt_id LIMIT 128
    `).all(
      input.accountProfileId,
      input.observationGeneration,
      input.providerThreadId,
      input.providerTurnId,
    );
    const exact = exactRows.map((row) =>
      actorModelRerouteCandidateRowSchema.parse(row)
    );
    if (exact.length > 0) return Object.freeze(exact);

    const fallbackRows: unknown[] = this.#database.query(`
      SELECT attempt.attempt_id, turn.epoch_id, turn.actor_id,
        attempt.process_generation AS admission_generation,
        incarnation.incarnation_id, attempt.provider_turn_id
      FROM harness_actor_turn_attempts AS attempt
      JOIN harness_actor_turns AS turn ON turn.turn_id = attempt.turn_id
      JOIN harness_actor_incarnations AS incarnation
        ON incarnation.incarnation_id = attempt.incarnation_id
      JOIN harness_actor_session_bindings AS session
        ON session.incarnation_id = incarnation.incarnation_id
      WHERE attempt.account_profile_id = ?1
        AND incarnation.account_profile_id = ?1
        AND incarnation.process_generation = attempt.process_generation
        AND incarnation.provider_thread_id = ?3
        AND session.account_profile_id = ?1
        AND session.actor_id = incarnation.actor_id
        AND turn.actor_id = incarnation.actor_id
        AND session.provider_thread_id = ?3
        AND session.admission_generation = attempt.process_generation
        AND attempt.effect_generation IS NOT NULL
        AND attempt.effect_generation <= ?2
        AND ?2 <= session.live_generation
        AND attempt.provider_turn_id IS NULL
        AND attempt.state IN ('starting', 'reconciling')
        AND incarnation.state IN ('idle', 'running')
        AND session.state = 'bound'
      ORDER BY attempt.attempt_id LIMIT 128
    `).all(
      input.accountProfileId,
      input.observationGeneration,
      input.providerThreadId,
    );
    return Object.freeze(fallbackRows.map((row) =>
      actorModelRerouteCandidateRowSchema.parse(row)
    ));
  }

  #readActorModelRerouteInbox(
    attemptId: string,
  ): ActorModelRerouteInboxRecordV2 | null {
    const row: unknown = this.#database.query(`
      SELECT * FROM harness_actor_model_reroute_inbox WHERE attempt_id = ?1
    `).get(attemptId);
    return row === null ? null : parseActorModelRerouteInboxRow(row);
  }

  #requireActorModelRerouteInbox(
    attemptId: string,
  ): ActorModelRerouteInboxRecordV2 {
    const record = this.#readActorModelRerouteInbox(attemptId);
    if (record === null) notFound("actor model reroute evidence does not exist");
    return record;
  }

  #readActorAccountLease(leaseId: string): ActorAccountLeaseRecordV2 | null {
    const row: unknown = this.#database.query(`
      SELECT * FROM harness_actor_account_leases WHERE lease_id = ?1
    `).get(leaseId);
    return row === null ? null : parseActorAccountLeaseRow(row);
  }

  #readActorAccountLeaseByIncarnation(
    incarnationId: string,
  ): ActorAccountLeaseRecordV2 | null {
    const row: unknown = this.#database.query(`
      SELECT * FROM harness_actor_account_leases WHERE incarnation_id = ?1
    `).get(incarnationId);
    return row === null ? null : parseActorAccountLeaseRow(row);
  }

  #requireActorAccountLease(leaseId: string): ActorAccountLeaseRecordV2 {
    const lease = this.#readActorAccountLease(leaseId);
    if (lease === null) notFound("actor account lease does not exist");
    return lease;
  }

  #readActorFastReservation(
    reservationId: string,
  ): ActorFastReservationRecordV2 | null {
    const row: unknown = this.#database.query(`
      SELECT * FROM harness_actor_fast_reservations WHERE reservation_id = ?1
    `).get(reservationId);
    return row === null ? null : parseActorFastReservationRow(row);
  }

  #readActorFastReservationForAttempt(
    attemptId: string,
  ): ActorFastReservationRecordV2 | null {
    const row: unknown = this.#database.query(`
      SELECT * FROM harness_actor_fast_reservations WHERE attempt_id = ?1
    `).get(attemptId);
    return row === null ? null : parseActorFastReservationRow(row);
  }

  #requireActorFastReservation(
    reservationId: string,
  ): ActorFastReservationRecordV2 {
    const reservation = this.#readActorFastReservation(reservationId);
    if (reservation === null) notFound("actor Fast reservation does not exist");
    return reservation;
  }

  #readActorResult(resultId: string): ActorResult | null {
    const row: unknown = this.#database.query(
      "SELECT * FROM harness_actor_results WHERE result_id = ?1",
    ).get(resultId);
    return row === null ? null : parseActorResultRow(row);
  }

  #readActorResultByTurn(turnId: string): ActorResult | null {
    const row: unknown = this.#database.query(
      "SELECT * FROM harness_actor_results WHERE turn_id = ?1",
    ).get(turnId);
    return row === null ? null : parseActorResultRow(row);
  }

  #requireActorResult(resultId: string): ActorResult {
    const value = this.#readActorResult(resultId);
    if (value === null) notFound("actor result does not exist");
    return value;
  }

  #readWorkspaceBinding(bindingId: string): ActorWorkspaceBinding | null {
    const row: unknown = this.#database.query(`
      SELECT * FROM harness_actor_workspace_bindings WHERE binding_id = ?1
    `).get(bindingId);
    return row === null ? null : parseWorkspaceBindingRow(row);
  }

  #requireWorkspaceBinding(bindingId: string): ActorWorkspaceBinding {
    const value = this.#readWorkspaceBinding(bindingId);
    if (value === null) notFound("actor workspace binding does not exist");
    return value;
  }

  #readPaneBinding(bindingId: string): ActorPaneBinding | null {
    const row: unknown = this.#database.query(`
      SELECT * FROM harness_actor_pane_bindings WHERE binding_id = ?1
    `).get(bindingId);
    return row === null ? null : parsePaneBindingRow(row);
  }

  #requirePaneBinding(bindingId: string): ActorPaneBinding {
    const value = this.#readPaneBinding(bindingId);
    if (value === null) notFound("actor pane binding does not exist");
    return value;
  }
}

const actorEpochRowSchema = z.object({
  epoch_id: actorEpochIdSchema,
  project_id: z.string().min(1).max(128),
  source_sha: z.string().regex(/^[0-9a-f]{40,64}$/u),
  root_actor_id: actorIdSchema,
  max_depth: actorBudgetSchema.shape.maxDepth,
  max_active_descendants: actorBudgetSchema.shape.maxActiveDescendants,
  max_durable_descendants: actorBudgetSchema.shape.maxDurableDescendants,
  token_budget: actorBudgetSchema.shape.tokenBudget,
  byte_budget: actorBudgetSchema.shape.byteBudget,
  deadline: isoTimestampSchema,
  lane_authority: actorLaneAuthoritySchema,
  token_reserved: z.number().int().nonnegative().safe(),
  byte_reserved: z.number().int().nonnegative().safe(),
  next_root_completion_sequence: z.number().int().positive().safe(),
  state: actorEpochSchema.shape.state,
  revision: z.number().int().positive().safe(),
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
  stopped_at: isoTimestampSchema.nullable(),
}).strict();

const actorRowSchema = z.object({
  actor_id: actorIdSchema,
  epoch_id: actorEpochIdSchema,
  parent_actor_id: actorIdSchema.nullable(),
  depth: z.number().int().min(0).max(3),
  title: z.string().min(1).max(160),
  state: actorSchema.shape.state,
  max_depth: actorBudgetSchema.shape.maxDepth,
  max_active_descendants: actorBudgetSchema.shape.maxActiveDescendants,
  max_durable_descendants: actorBudgetSchema.shape.maxDurableDescendants,
  token_budget: actorBudgetSchema.shape.tokenBudget,
  byte_budget: actorBudgetSchema.shape.byteBudget,
  deadline: isoTimestampSchema,
  lane_authority: actorLaneAuthoritySchema,
  token_reserved: z.number().int().nonnegative().safe(),
  byte_reserved: z.number().int().nonnegative().safe(),
  next_turn_ordinal: z.number().int().positive().safe(),
  next_result_ordinal: z.number().int().positive().safe(),
  revision: z.number().int().positive().safe(),
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
  stopped_at: isoTimestampSchema.nullable(),
  dispatch_policy_version: z.union([z.literal(0), z.literal(1)]),
  work_class: actorDispatchWorkClassV2Schema,
}).strict();

const actorTurnRowSchema = z.object({
  turn_id: actorTurnIdSchema,
  epoch_id: actorEpochIdSchema,
  actor_id: actorIdSchema,
  ordinal: z.number().int().positive().safe(),
  idempotency_key: requestIdentitySchema,
  input_value_id: z.string().min(1).max(96),
  state: actorTurnSchema.shape.state,
  desired_state: actorTurnSchema.shape.desiredState,
  revision: z.number().int().positive().safe(),
  created_at: isoTimestampSchema,
  started_at: isoTimestampSchema.nullable(),
  settled_at: isoTimestampSchema.nullable(),
  outcome_code: z.string().min(1).max(96).nullable(),
  acceleration_mode: z.enum(["standard", "fast"]),
  acceleration_critical_path: z.union([z.literal(0), z.literal(1)]),
  acceleration_bottleneck: actorAccelerationBottleneckSchema,
}).strict();

const actorOperationRowSchema = z.object({
  operation_id: actorOperationIdSchema,
  actor_id: actorIdSchema,
  turn_id: actorTurnIdSchema.nullable(),
  kind: actorOperationKindSchema,
  request_digest: digestSchema,
  effect_key: digestSchema,
  state: actorOperationStateSchema,
  provider_identity_json: z.string().min(2).max(64 * 1024).nullable(),
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
  settled_at: isoTimestampSchema.nullable(),
}).strict();

const actorIncarnationRowSchema = z.object({
  incarnation_id: actorIncarnationIdSchema,
  actor_id: actorIdSchema,
  ordinal: z.number().int().positive().safe(),
  account_profile_id: z.string().min(1).max(96),
  process_generation: z.number().int().positive().safe(),
  start_operation_id: actorOperationIdSchema,
  client_request_id: requestIdentitySchema,
  thread_source: z.string().min(16).max(256),
  provider_thread_id: boundedProviderIdSchema.nullable(),
  token_usage_observation_generation: z.number().int().positive().safe(),
  token_usage_latest_position: z.number().int().nonnegative().safe().nullable(),
  token_usage_cumulative_input_tokens: z.number().int().nonnegative().safe(),
  token_usage_cumulative_output_tokens: z.number().int().nonnegative().safe(),
  token_usage_cumulative_cached_input_tokens:
    z.number().int().nonnegative().safe().nullable(),
  token_usage_cumulative_reasoning_output_tokens:
    z.number().int().nonnegative().safe().nullable(),
  requested_model: actorModelProfileSchema,
  requested_reasoning_effort: actorReasoningEffortSchema,
  profile_fallback_reason: actorProfileFallbackReasonSchema.nullable(),
  capability_evidence_digest: digestSchema.nullable(),
  supports_fast: z.union([z.literal(0), z.literal(1)]).nullable(),
  observed_model: actorModelProfileSchema.nullable(),
  observed_reasoning_effort: actorReasoningEffortSchema.nullable(),
  observed_profile_state: z.enum(["unknown", "exact", "rerouted"]),
  observed_profile_at: isoTimestampSchema.nullable(),
  toolset_digest: digestSchema,
  state: actorIncarnationStateSchema,
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
  closed_at: isoTimestampSchema.nullable(),
}).strict();

const actorAttemptRowSchema = z.object({
  attempt_id: actorAttemptIdSchema,
  turn_id: actorTurnIdSchema,
  incarnation_id: actorIncarnationIdSchema,
  ordinal: z.number().int().positive().safe(),
  account_profile_id: z.string().min(1).max(96),
  process_generation: z.number().int().positive().safe(),
  effect_generation: z.number().int().positive().safe().nullable(),
  client_user_message_id: requestIdentitySchema,
  provider_turn_id: boundedProviderIdSchema.nullable(),
  continuation_history_value_id: contextValueIdSchema.nullable(),
  token_usage_identity_digest: digestSchema.nullable(),
  token_usage_observation_generation:
    z.number().int().positive().safe().nullable(),
  token_usage_stream_position: z.number().int().nonnegative().safe().nullable(),
  token_usage_cumulative_input_tokens:
    z.number().int().nonnegative().safe().nullable(),
  token_usage_cumulative_output_tokens:
    z.number().int().nonnegative().safe().nullable(),
  token_usage_cumulative_cached_input_tokens:
    z.number().int().nonnegative().safe().nullable(),
  token_usage_cumulative_reasoning_output_tokens:
    z.number().int().nonnegative().safe().nullable(),
  state: actorAttemptSchema.shape.state,
  quota_proof_digest: digestSchema.nullable(),
  input_tokens: z.number().int().nonnegative().safe().nullable(),
  output_tokens: z.number().int().nonnegative().safe().nullable(),
  cached_input_tokens: z.number().int().nonnegative().safe().nullable(),
  reasoning_output_tokens: z.number().int().nonnegative().safe().nullable(),
  requested_service_tier: z.enum(["standard", "fast"]),
  realized_service_tier: z.enum(["standard", "fast"]),
  tier_fallback_reason: actorTierFallbackReasonSchema.nullable(),
  capability_evidence_digest: digestSchema.nullable(),
  fast_reservation_id: actorFastReservationIdSchema.nullable(),
  created_at: isoTimestampSchema,
  started_at: isoTimestampSchema.nullable(),
  settled_at: isoTimestampSchema.nullable(),
}).strict();

const actorAttemptObservationRowSchema = actorAttemptRowSchema.extend({
  session_admission_generation: z.number().int().positive().safe(),
  session_live_generation: z.number().int().positive().safe(),
  session_revision: z.number().int().positive().safe(),
  session_recovery_proof_digest: digestSchema,
}).strict();

const actorModelRerouteCandidateRowSchema = z.object({
  attempt_id: actorAttemptIdSchema,
  epoch_id: actorEpochIdSchema,
  actor_id: actorIdSchema,
  admission_generation: z.number().int().positive().safe(),
  incarnation_id: actorIncarnationIdSchema,
  provider_turn_id: boundedProviderIdSchema.nullable(),
}).strict();

const actorSessionBindingRowSchema = z.object({
  incarnation_id: actorIncarnationIdSchema,
  actor_id: actorIdSchema,
  workspace_binding_id: actorWorkspaceBindingIdSchema,
  account_profile_id: z.string().min(1).max(96),
  admission_generation: z.number().int().positive().safe(),
  live_generation: z.number().int().positive().safe(),
  live_capability_evidence_digest: digestSchema.nullable(),
  live_supports_fast: z.union([z.literal(0), z.literal(1)]).nullable(),
  provider_thread_id: boundedProviderIdSchema,
  thread_source: z.string().min(16).max(256),
  recovery_proof_digest: digestSchema,
  prior_recovery_proof_digest: digestSchema.nullable(),
  history_evidence_digest: digestSchema,
  first_observation_position: z.number().int().nonnegative().safe(),
  second_observation_position: z.number().int().positive().safe(),
  history_turn_count: z.number().int().min(0).max(10_000),
  history_item_count: z.number().int().min(0).max(100_000),
  state: actorSessionBindingStateSchema,
  quarantine_reason: actorSessionQuarantineReasonV2Schema.nullable(),
  revision: z.number().int().positive().safe(),
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
  recovered_at: isoTimestampSchema.nullable(),
  retired_at: isoTimestampSchema.nullable(),
  quarantined_at: isoTimestampSchema.nullable(),
  actor_title: z.string().min(1).max(160),
  workspace_lane_id: laneIdSchema,
  workspace_authority: actorLaneAuthoritySchema,
  workspace_state: z.enum(["active", "released", "quarantined"]),
  workspace_path: z.string().min(1).max(4096),
  workspace_lease_mode: z.string(),
  workspace_lease_status: z.string(),
  incarnation_actor_id: actorIdSchema,
  incarnation_account_profile_id: z.string().min(1).max(96),
  incarnation_admission_generation: z.number().int().positive().safe(),
  incarnation_provider_thread_id: boundedProviderIdSchema.nullable(),
  incarnation_thread_source: z.string().min(16).max(256),
  incarnation_requested_model: actorModelProfileSchema,
  incarnation_requested_reasoning_effort: actorReasoningEffortSchema,
  incarnation_capability_evidence_digest: digestSchema.nullable(),
  incarnation_supports_fast:
    z.union([z.literal(0), z.literal(1)]).nullable(),
  incarnation_state: actorIncarnationStateSchema,
}).strict();

const actorAccountLeaseRowSchema = z.object({
  lease_id: actorAccountLeaseIdSchema,
  incarnation_id: actorIncarnationIdSchema,
  actor_id: actorIdSchema,
  account_profile_id: z.string().min(1).max(96),
  process_generation: z.number().int().positive().safe(),
  state: actorAccountLeaseRecordV2Schema.shape.state,
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
  settled_at: isoTimestampSchema.nullable(),
}).strict();

const actorFastReservationRowSchema = z.object({
  reservation_id: actorFastReservationIdSchema,
  attempt_id: actorAttemptIdSchema,
  epoch_id: actorEpochIdSchema,
  root_actor_id: actorIdSchema,
  actor_id: actorIdSchema,
  account_profile_id: z.string().min(1).max(96),
  process_generation: z.number().int().positive().safe(),
  state: actorFastReservationRecordV2Schema.shape.state,
  terminal_reason: actorFastReservationRecordV2Schema.shape.terminalReason,
  fence_evidence_digest: digestSchema.nullable(),
  fenced_generation: z.number().int().positive().safe().nullable(),
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
  effect_started_at: isoTimestampSchema.nullable(),
  settled_at: isoTimestampSchema.nullable(),
  quarantined_at: isoTimestampSchema.nullable(),
}).strict();

const actorModelRerouteInboxRowSchema = z.object({
  attempt_id: actorAttemptIdSchema,
  provider_identity_digest: digestSchema,
  observation_generation: z.number().int().positive().safe(),
  stream_position: z.number().int().nonnegative().safe(),
  from_model: actorModelRerouteModelSchema,
  to_model: actorModelRerouteModelSchema,
  reason: actorModelRerouteReasonSchema,
  fact_digest: digestSchema,
  state: actorModelRerouteInboxRecordV2Schema.shape.state,
  quarantine_reason: actorModelRerouteQuarantineReasonSchema.nullable(),
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
  bound_at: isoTimestampSchema.nullable(),
  quarantined_at: isoTimestampSchema.nullable(),
  settled_at: isoTimestampSchema.nullable(),
}).strict();

const actorResultRowSchema = z.object({
  result_id: actorResultIdSchema,
  epoch_id: actorEpochIdSchema,
  actor_id: actorIdSchema,
  turn_id: actorTurnIdSchema,
  terminal_attempt_id: actorAttemptIdSchema.nullable(),
  outcome: actorResultSchema.shape.outcome,
  value_id: z.string().min(1).max(96).nullable(),
  actor_result_ordinal: z.number().int().positive().safe(),
  root_completion_sequence: z.number().int().positive().safe(),
  created_at: isoTimestampSchema,
}).strict();

const workspaceBindingRowSchema = z.object({
  binding_id: actorWorkspaceBindingIdSchema,
  actor_id: actorIdSchema,
  lane_id: laneIdSchema,
  authority: actorLaneAuthoritySchema,
  state: actorWorkspaceBindingSchema.shape.state,
  revision: z.number().int().positive().safe(),
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
  released_at: isoTimestampSchema.nullable(),
}).strict();

const paneBindingRowSchema = z.object({
  binding_id: actorPaneBindingIdSchema,
  actor_id: actorIdSchema,
  pane_id: paneIdSchema,
  state: actorPaneBindingSchema.shape.state,
  revision: z.number().int().positive().safe(),
  attached_at: isoTimestampSchema,
  detached_at: isoTimestampSchema.nullable(),
}).strict();

function parseActorEpochRow(value: unknown): ActorEpoch {
  const row = parseRow(actorEpochRowSchema, value, "actor epoch");
  return actorEpochSchema.parse({
    id: row.epoch_id,
    projectId: row.project_id,
    sourceSha: row.source_sha,
    rootActorId: row.root_actor_id,
    budget: {
      maxDepth: row.max_depth,
      maxActiveDescendants: row.max_active_descendants,
      maxDurableDescendants: row.max_durable_descendants,
      tokenBudget: row.token_budget,
      byteBudget: row.byte_budget,
      deadline: row.deadline,
      laneAuthority: row.lane_authority,
    },
    tokenReserved: row.token_reserved,
    byteReserved: row.byte_reserved,
    nextRootCompletionSequence: row.next_root_completion_sequence,
    state: row.state,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stoppedAt: row.stopped_at,
  });
}

function parseActorRow(value: unknown): Actor {
  const row = parseRow(actorRowSchema, value, "actor");
  return actorSchema.parse({
    id: row.actor_id,
    epochId: row.epoch_id,
    parentActorId: row.parent_actor_id,
    depth: row.depth,
    title: row.title,
    state: row.state,
    budget: {
      maxDepth: row.max_depth,
      maxActiveDescendants: row.max_active_descendants,
      maxDurableDescendants: row.max_durable_descendants,
      tokenBudget: row.token_budget,
      byteBudget: row.byte_budget,
      deadline: row.deadline,
      laneAuthority: row.lane_authority,
    },
    tokenReserved: row.token_reserved,
    byteReserved: row.byte_reserved,
    nextTurnOrdinal: row.next_turn_ordinal,
    nextResultOrdinal: row.next_result_ordinal,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stoppedAt: row.stopped_at,
  });
}

function parseActorTurnRow(value: unknown): ActorTurn {
  const row = parseRow(actorTurnRowSchema, value, "actor turn");
  return actorTurnSchema.parse({
    id: row.turn_id,
    epochId: row.epoch_id,
    actorId: row.actor_id,
    ordinal: row.ordinal,
    idempotencyKey: row.idempotency_key,
    inputValueId: row.input_value_id,
    state: row.state,
    desiredState: row.desired_state,
    revision: row.revision,
    createdAt: row.created_at,
    startedAt: row.started_at,
    settledAt: row.settled_at,
    outcomeCode: row.outcome_code,
  });
}

function parseActorOperationRow(value: unknown): ActorOperationRecord {
  const row = parseRow(actorOperationRowSchema, value, "actor operation");
  return actorOperationRecordSchema.parse({
    id: row.operation_id,
    actorId: row.actor_id,
    turnId: row.turn_id,
    kind: row.kind,
    requestDigest: row.request_digest,
    effectKey: row.effect_key,
    state: row.state,
    providerIdentityJson: row.provider_identity_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at,
  });
}

function parseActorIncarnationRow(value: unknown): ActorIncarnationRecord {
  const row = parseRow(actorIncarnationRowSchema, value, "actor incarnation");
  return actorIncarnationRecordSchema.parse({
    id: row.incarnation_id,
    actorId: row.actor_id,
    ordinal: row.ordinal,
    accountProfileId: row.account_profile_id,
    processGeneration: row.process_generation,
    startOperationId: row.start_operation_id,
    clientRequestId: row.client_request_id,
    threadSource: row.thread_source,
    providerThreadId: row.provider_thread_id,
    tokenUsageObservationGeneration: row.token_usage_observation_generation,
    tokenUsageLatestPosition: row.token_usage_latest_position,
    tokenUsageCumulativeInputTokens:
      row.token_usage_cumulative_input_tokens,
    tokenUsageCumulativeOutputTokens:
      row.token_usage_cumulative_output_tokens,
    tokenUsageCumulativeCachedInputTokens:
      row.token_usage_cumulative_cached_input_tokens,
    tokenUsageCumulativeReasoningOutputTokens:
      row.token_usage_cumulative_reasoning_output_tokens,
    requestedModel: row.requested_model,
    requestedReasoningEffort: row.requested_reasoning_effort,
    profileFallbackReason: row.profile_fallback_reason,
    capabilityEvidenceDigest: row.capability_evidence_digest,
    supportsFast: row.supports_fast === null ? null : row.supports_fast === 1,
    observedModel: row.observed_model,
    observedReasoningEffort: row.observed_reasoning_effort,
    observedProfileState: row.observed_profile_state,
    observedProfileAt: row.observed_profile_at,
    toolsetDigest: row.toolset_digest,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  });
}

function parseActorAttemptRow(value: unknown): PersistedActorAttempt {
  const row = parseRow(actorAttemptRowSchema, value, "actor attempt");
  return persistedActorAttemptSchema.parse({
    id: row.attempt_id,
    turnId: row.turn_id,
    incarnationId: row.incarnation_id,
    ordinal: row.ordinal,
    accountProfileId: row.account_profile_id,
    processGeneration: row.process_generation,
    effectGeneration: row.effect_generation,
    clientUserMessageId: row.client_user_message_id,
    providerTurnId: row.provider_turn_id,
    continuationHistoryValueId: row.continuation_history_value_id,
    tokenUsageIdentityDigest: row.token_usage_identity_digest,
    tokenUsageObservationGeneration: row.token_usage_observation_generation,
    tokenUsageStreamPosition: row.token_usage_stream_position,
    tokenUsageCumulativeInputTokens:
      row.token_usage_cumulative_input_tokens,
    tokenUsageCumulativeOutputTokens:
      row.token_usage_cumulative_output_tokens,
    tokenUsageCumulativeCachedInputTokens:
      row.token_usage_cumulative_cached_input_tokens,
    tokenUsageCumulativeReasoningOutputTokens:
      row.token_usage_cumulative_reasoning_output_tokens,
    state: row.state,
    quotaProofDigest: row.quota_proof_digest,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedInputTokens: row.cached_input_tokens,
    reasoningOutputTokens: row.reasoning_output_tokens,
    requestedServiceTier: row.requested_service_tier,
    realizedServiceTier: row.realized_service_tier,
    tierFallbackReason: row.tier_fallback_reason,
    capabilityEvidenceDigest: row.capability_evidence_digest,
    fastReservationId: row.fast_reservation_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    settledAt: row.settled_at,
  });
}

function parseActorSessionBindingRow(value: unknown): ActorSessionBindingRecordV2 {
  const row = parseRow(actorSessionBindingRowSchema, value, "actor session binding");
  const expectedLeaseMode = row.workspace_authority === "readOnlySnapshot"
    ? "harness_read_only_snapshot"
    : "managed_worktree";
  const workspaceIsLive = row.workspace_state === "active" &&
    row.workspace_lease_status === "ready";
  const workspaceIsContained = row.workspace_state === "quarantined" &&
    (row.workspace_authority === "readOnlySnapshot"
      ? row.workspace_lease_status === "ready"
      : row.workspace_lease_status === "quarantined");
  const retiredWorkspaceIsStable = workspaceIsLive || workspaceIsContained ||
    (row.workspace_state === "released" &&
      (row.workspace_lease_status === "ready" ||
        row.workspace_lease_status === "quarantined"));
  if (
    row.actor_id !== row.incarnation_actor_id ||
    row.account_profile_id !== row.incarnation_account_profile_id ||
    row.admission_generation !== row.incarnation_admission_generation ||
    row.provider_thread_id !== row.incarnation_provider_thread_id ||
    row.thread_source !== row.incarnation_thread_source ||
    row.workspace_lease_mode !== expectedLeaseMode ||
    (row.state === "bound" && (!workspaceIsLive ||
      (row.incarnation_state !== "idle" &&
        row.incarnation_state !== "running"))) ||
    (row.state === "retired" && (!retiredWorkspaceIsStable ||
      row.incarnation_state !== "closed")) ||
    (row.state === "quarantined" &&
      (!workspaceIsLive && !workspaceIsContained ||
        row.incarnation_state !== "quarantined"))
  ) {
    throw new HarnessSQLiteAuthorityV2Error(
      "corrupt_state",
      "actor session binding lost its exact durable lineage",
    );
  }
  return actorSessionBindingRecordV2Schema.parse({
    incarnationId: row.incarnation_id,
    actorId: row.actor_id,
    actorTitle: row.actor_title,
    workspaceBindingId: row.workspace_binding_id,
    workspaceLaneId: row.workspace_lane_id,
    workspacePath: row.workspace_path,
    workspaceMode: row.workspace_authority === "readOnlySnapshot"
      ? "readOnly"
      : "managed",
    accountProfileId: row.account_profile_id,
    admissionGeneration: row.admission_generation,
    liveGeneration: row.live_generation,
    providerThreadId: row.provider_thread_id,
    threadSource: row.thread_source,
    modelId: row.incarnation_requested_model,
    reasoningEffort: row.incarnation_requested_reasoning_effort,
    capabilityEvidenceDigest: row.incarnation_capability_evidence_digest,
    supportsFast: row.incarnation_supports_fast === null
      ? null
      : row.incarnation_supports_fast === 1,
    liveCapabilityEvidenceDigest: row.live_capability_evidence_digest,
    liveSupportsFast: row.live_supports_fast === null
      ? null
      : row.live_supports_fast === 1,
    recoveryProof: {
      recoveryProofDigest: row.recovery_proof_digest,
      priorRecoveryProofDigest: row.prior_recovery_proof_digest,
      observationGeneration: row.live_generation,
      historyEvidenceDigest: row.history_evidence_digest,
      firstObservationPosition: row.first_observation_position,
      secondObservationPosition: row.second_observation_position,
      historyTurnCount: row.history_turn_count,
      historyItemCount: row.history_item_count,
    },
    state: row.state,
    quarantineReason: row.quarantine_reason,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    recoveredAt: row.recovered_at,
    retiredAt: row.retired_at,
    quarantinedAt: row.quarantined_at,
  });
}

function parseActorAccountLeaseRow(value: unknown): ActorAccountLeaseRecordV2 {
  const row = parseRow(actorAccountLeaseRowSchema, value, "actor account lease");
  return actorAccountLeaseRecordV2Schema.parse({
    id: row.lease_id,
    incarnationId: row.incarnation_id,
    actorId: row.actor_id,
    accountProfileId: row.account_profile_id,
    processGeneration: row.process_generation,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at,
  });
}

function parseActorFastReservationRow(
  value: unknown,
): ActorFastReservationRecordV2 {
  const row = parseRow(
    actorFastReservationRowSchema,
    value,
    "actor Fast reservation",
  );
  return actorFastReservationRecordV2Schema.parse({
    id: row.reservation_id,
    attemptId: row.attempt_id,
    epochId: row.epoch_id,
    rootActorId: row.root_actor_id,
    actorId: row.actor_id,
    accountProfileId: row.account_profile_id,
    processGeneration: row.process_generation,
    state: row.state,
    terminalReason: row.terminal_reason,
    fenceEvidenceDigest: row.fence_evidence_digest,
    fencedGeneration: row.fenced_generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    effectStartedAt: row.effect_started_at,
    settledAt: row.settled_at,
    quarantinedAt: row.quarantined_at,
  });
}

function parseActorModelRerouteInboxRow(
  value: unknown,
): ActorModelRerouteInboxRecordV2 {
  const row = parseRow(
    actorModelRerouteInboxRowSchema,
    value,
    "actor model reroute inbox",
  );
  return actorModelRerouteInboxRecordV2Schema.parse({
    attemptId: row.attempt_id,
    providerIdentityDigest: row.provider_identity_digest,
    observationGeneration: row.observation_generation,
    streamPosition: row.stream_position,
    fromModel: row.from_model,
    toModel: row.to_model,
    reason: row.reason,
    factDigest: row.fact_digest,
    state: row.state,
    quarantineReason: row.quarantine_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    boundAt: row.bound_at,
    quarantinedAt: row.quarantined_at,
    settledAt: row.settled_at,
  });
}

function parseActorResultRow(value: unknown): ActorResult {
  const row = parseRow(actorResultRowSchema, value, "actor result");
  return actorResultSchema.parse({
    id: row.result_id,
    epochId: row.epoch_id,
    actorId: row.actor_id,
    turnId: row.turn_id,
    terminalAttemptId: row.terminal_attempt_id,
    outcome: row.outcome,
    valueId: row.value_id,
    actorResultOrdinal: row.actor_result_ordinal,
    rootCompletionSequence: row.root_completion_sequence,
    createdAt: row.created_at,
  });
}

function parseWorkspaceBindingRow(value: unknown): ActorWorkspaceBinding {
  const row = parseRow(workspaceBindingRowSchema, value, "workspace binding");
  return actorWorkspaceBindingSchema.parse({
    id: row.binding_id,
    actorId: row.actor_id,
    laneId: row.lane_id,
    authority: row.authority,
    state: row.state,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    releasedAt: row.released_at,
  });
}

function parsePaneBindingRow(value: unknown): ActorPaneBinding {
  const row = parseRow(paneBindingRowSchema, value, "pane binding");
  return actorPaneBindingSchema.parse({
    id: row.binding_id,
    actorId: row.actor_id,
    paneId: row.pane_id,
    state: row.state,
    revision: row.revision,
    attachedAt: row.attached_at,
    detachedAt: row.detached_at,
  });
}

function parseRow<T>(
  schema: { parse(value: unknown): T },
  value: unknown,
  label: string,
): T {
  try {
    return schema.parse(value);
  } catch (cause: unknown) {
    throw new HarnessSQLiteAuthorityV2Error(
      "corrupt_state",
      `stored ${label} is invalid`,
      cause,
    );
  }
}

function assertFreshEpochAndRoot(epoch: ActorEpoch, root: Actor): void {
  if (
    epoch.rootActorId !== root.id || root.epochId !== epoch.id ||
    root.parentActorId !== null || root.depth !== 0
  ) lineage("actor epoch and root identity are incoherent");
  if (
    epoch.state !== "active" || epoch.revision !== 1 ||
    epoch.tokenReserved !== 0 || epoch.byteReserved !== 0 ||
    epoch.nextRootCompletionSequence !== 1 || epoch.stoppedAt !== null ||
    root.state !== "active" || root.revision !== 1 ||
    root.tokenReserved !== 0 || root.byteReserved !== 0 ||
    root.nextTurnOrdinal !== 1 || root.nextResultOrdinal !== 1 ||
    root.stoppedAt !== null
  ) invalidTransition("new actor epochs and roots must begin in pristine active state");
  assertCanonicalActorTimestamps(epoch, root);
  if (
    root.budget.maxDepth > epoch.budget.maxDepth ||
    root.budget.maxActiveDescendants > epoch.budget.maxActiveDescendants ||
    root.budget.maxDurableDescendants > epoch.budget.maxDurableDescendants ||
    root.budget.tokenBudget > epoch.budget.tokenBudget ||
    root.budget.byteBudget > epoch.budget.byteBudget ||
    Date.parse(root.budget.deadline) > Date.parse(epoch.budget.deadline) ||
    (epoch.budget.laneAuthority === "readOnlySnapshot" &&
      root.budget.laneAuthority !== "readOnlySnapshot")
  ) lineage("root actor widens its epoch authority");
}

function assertFreshChild(actor: Actor): void {
  if (
    actor.parentActorId === null || actor.depth === 0 ||
    actor.state !== "active" || actor.revision !== 1 ||
    actor.tokenReserved !== 0 || actor.byteReserved !== 0 ||
    actor.nextTurnOrdinal !== 1 || actor.nextResultOrdinal !== 1 ||
    actor.stoppedAt !== null
  ) invalidTransition("new child actors must begin in pristine active state");
  canonicalTimestamp(actor.createdAt);
  canonicalTimestamp(actor.updatedAt);
  canonicalTimestamp(actor.budget.deadline);
  if (actor.title.includes("\0")) lineage("actor title contains NUL");
}

function assertCanonicalActorTimestamps(epoch: ActorEpoch, actor: Actor): void {
  for (const value of [
    epoch.createdAt,
    epoch.updatedAt,
    epoch.budget.deadline,
    actor.createdAt,
    actor.updatedAt,
    actor.budget.deadline,
  ]) canonicalTimestamp(value);
  if (actor.title.includes("\0")) lineage("actor title contains NUL");
}

function canonicalTimestamp(value: string): string {
  isoTimestampSchema.parse(value);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new HarnessSQLiteAuthorityV2Error(
      "lineage_conflict",
      "harness timestamps must use canonical UTC millisecond form",
    );
  }
  return value;
}

function parseProviderIdentityJson(value: string | null): string | null {
  if (value === null) return null;
  const bounded = z.string().min(2).max(64 * 1024).parse(value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bounded) as unknown;
  } catch (cause: unknown) {
    throw new HarnessSQLiteAuthorityV2Error(
      "lineage_conflict",
      "provider identity is not valid JSON",
      cause,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    lineage("provider identity must be a JSON object");
  }
  return bounded;
}

function assertOperationTransition(
  current: ActorOperationRecord["state"],
  next: ActorOperationRecord["state"],
): void {
  const allowed: Readonly<Record<
    ActorOperationRecord["state"],
    readonly ActorOperationRecord["state"][]
  >> = {
    prepared: ["effectStarted", "recoveryRequired"],
    effectStarted: ["succeeded", "notApplied", "ambiguous", "recoveryRequired"],
    succeeded: [],
    notApplied: [],
    ambiguous: [],
    recoveryRequired: [],
  };
  if (!allowed[current].includes(next)) {
    invalidTransition(`invalid actor operation transition: ${current} -> ${next}`);
  }
}

function isTerminalOperationState(
  state: ActorOperationRecord["state"],
): boolean {
  return state === "succeeded" || state === "notApplied" ||
    state === "ambiguous" || state === "recoveryRequired";
}

function assertIncarnationTransition(
  current: ActorIncarnationRecord["state"],
  next: ActorIncarnationRecord["state"],
): void {
  const allowed: Readonly<Record<
    ActorIncarnationRecord["state"],
    readonly ActorIncarnationRecord["state"][]
  >> = {
    starting: ["idle", "quarantined", "closed"],
    idle: ["running", "quarantined", "closed"],
    running: ["idle", "quarantined", "closed"],
    quarantined: [],
    closed: [],
  };
  if (!allowed[current].includes(next)) {
    invalidTransition(`invalid actor incarnation transition: ${current} -> ${next}`);
  }
}

function assertAttemptTransition(
  current: ActorAttempt["state"],
  next: ActorAttempt["state"],
): void {
  const allowed: Readonly<Record<
    ActorAttempt["state"],
    readonly ActorAttempt["state"][]
  >> = {
    starting: [
      "running",
      "reconciling",
      "failed",
      "quotaRejected",
      "interrupted",
      "ambiguous",
    ],
    running: [
      "reconciling",
      "completed",
      "failed",
      "quotaRejected",
      "interrupted",
      "ambiguous",
    ],
    reconciling: [
      "running",
      "completed",
      "failed",
      "quotaRejected",
      "interrupted",
      "ambiguous",
    ],
    completed: [],
    failed: [],
    quotaRejected: [],
    interrupted: [],
    ambiguous: [],
  };
  if (!allowed[current].includes(next)) {
    invalidTransition(`invalid actor attempt transition: ${current} -> ${next}`);
  }
}

function cumulativeUsageDisposition(
  previous: Readonly<{
    observation_generation: number;
    stream_position: number | null;
    cumulative_input_tokens: number;
    cumulative_output_tokens: number;
    cumulative_cached_input_tokens: number | null;
    cumulative_reasoning_output_tokens: number | null;
  }>,
  next: Readonly<{
    processGeneration: number;
    streamPosition: number;
    cumulativeInputTokens: number;
    cumulativeOutputTokens: number;
    cumulativeCachedInputTokens?: number | undefined;
    cumulativeReasoningOutputTokens?: number | undefined;
  }>,
): "advance" | "duplicate" | "stale" {
  const previousPosition = previous.stream_position;
  const previousGeneration = previous.observation_generation;
  const previousInput = previous.cumulative_input_tokens;
  const previousOutput = previous.cumulative_output_tokens;
  const previousCachedInput = previous.cumulative_cached_input_tokens;
  const previousReasoningOutput =
    previous.cumulative_reasoning_output_tokens;
  const nextCachedInput = next.cumulativeCachedInputTokens;
  const nextReasoningOutput = next.cumulativeReasoningOutputTokens;
  if (previousPosition === null && (previousInput !== 0 || previousOutput !== 0)) {
    throw new HarnessSQLiteAuthorityV2Error(
      "corrupt_state",
      "actor thread usage watermark is incomplete",
    );
  }
  if (previousPosition === null) {
    return "advance";
  }
  if (next.processGeneration < previousGeneration) {
    if (
      next.cumulativeInputTokens <= previousInput &&
      next.cumulativeOutputTokens <= previousOutput
    ) return "stale";
    throw new HarnessSQLiteAuthorityV2Error(
      "corrupt_state",
      "stale provider generation exceeds newer actor token evidence",
    );
  }
  if (next.processGeneration > previousGeneration) {
    if (
      next.cumulativeInputTokens < previousInput ||
      next.cumulativeOutputTokens < previousOutput ||
      (previousCachedInput !== null && nextCachedInput !== undefined &&
        nextCachedInput < previousCachedInput) ||
      (previousReasoningOutput !== null &&
        nextReasoningOutput !== undefined &&
        nextReasoningOutput < previousReasoningOutput)
    ) {
      throw new HarnessSQLiteAuthorityV2Error(
        "corrupt_state",
        "successor provider generation regressed actor token evidence",
      );
    }
    // Even equal totals advance the generation-scoped watermark. This makes
    // a duplicate at N+1 idempotent while allowing its stream position to
    // restart below the final position from N.
    return "advance";
  }
  if (next.streamPosition === previousPosition) {
    if (
      next.cumulativeInputTokens === previousInput &&
      next.cumulativeOutputTokens === previousOutput &&
      (previousCachedInput === null || nextCachedInput === undefined ||
        nextCachedInput === previousCachedInput) &&
      (previousReasoningOutput === null || nextReasoningOutput === undefined ||
        nextReasoningOutput === previousReasoningOutput)
    ) return "duplicate";
    throw new HarnessSQLiteAuthorityV2Error(
      "corrupt_state",
      "one provider position published conflicting actor usage",
    );
  }
  if (next.streamPosition < previousPosition) {
    if (
      next.cumulativeInputTokens <= previousInput &&
      next.cumulativeOutputTokens <= previousOutput
    ) return "stale";
    throw new HarnessSQLiteAuthorityV2Error(
      "corrupt_state",
      "stale provider usage exceeds newer actor usage",
    );
  }
  if (
    next.cumulativeInputTokens < previousInput ||
    next.cumulativeOutputTokens < previousOutput ||
    (previousCachedInput !== null && nextCachedInput !== undefined &&
      nextCachedInput < previousCachedInput) ||
    (previousReasoningOutput !== null && nextReasoningOutput !== undefined &&
      nextReasoningOutput < previousReasoningOutput)
  ) {
    throw new HarnessSQLiteAuthorityV2Error(
      "corrupt_state",
      "later provider usage regressed actor token evidence",
    );
  }
  return "advance";
}

function exactJson(value: unknown): string {
  return JSON.stringify(value);
}

function digestActorModelRerouteFact(input: Readonly<{
  providerIdentityDigest: string;
  observationGeneration: number;
  streamPosition: number;
  fromModel: string;
  toModel: string;
  reason: "highRiskCyberActivity";
}>): string {
  return createHash("sha256").update(JSON.stringify([
    "hra.actor.model-rerouted.fact.v1",
    input.providerIdentityDigest,
    input.observationGeneration,
    input.streamPosition,
    input.fromModel,
    input.toModel,
    input.reason,
  ])).digest("hex");
}

function parseActorDispatchPolicyInput(
  actorId: string,
  value: Readonly<{
    policyVersion: 0 | 1;
    workClass: ActorDispatchPolicyRecordV2["workClass"];
  }> | undefined,
): ActorDispatchPolicyRecordV2 {
  return actorDispatchPolicyRecordV2Schema.parse({
    actorId,
    policyVersion: value?.policyVersion ?? 0,
    workClass: value?.workClass ?? "legacyUnclassified",
  });
}

function parseActorTurnAccelerationInput(
  turnId: string,
  value: Readonly<
    | { mode: "standard" }
    | {
        mode: "fast";
        criticalPath: true;
        bottleneck: "reasoning" | "fileGeneration";
      }
  > | undefined,
): ActorTurnAccelerationRecordV2 {
  return actorTurnAccelerationRecordV2Schema.parse({
    turnId,
    ...(value ?? { mode: "standard" as const }),
  });
}

function notFound(message: string): never {
  throw new HarnessSQLiteAuthorityV2Error("not_found", message);
}

function conflict(message: string): never {
  throw new HarnessSQLiteAuthorityV2Error("conflict", message);
}

function revisionConflict(): never {
  throw new HarnessSQLiteAuthorityV2Error(
    "revision_conflict",
    "durable harness revision changed",
  );
}

function invalidTransition(message: string): never {
  throw new HarnessSQLiteAuthorityV2Error("invalid_transition", message);
}

function lineage(message: string): never {
  throw new HarnessSQLiteAuthorityV2Error("lineage_conflict", message);
}
