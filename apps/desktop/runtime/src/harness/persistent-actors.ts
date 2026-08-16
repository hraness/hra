import { createHash } from "node:crypto";

import { z } from "@hra-internal/schema";
import {
  HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256,
  pinnedCodexRequests,
  type CodexFact,
  type CodexFactConsumer,
} from "../codex";
import { HRA_RLM_PREDECESSOR_DYNAMIC_TOOL_SPEC_SHA256 } from
  "../codex/dynamic-tool";

import {
  HARNESS_MAX_DURABLE_DESCENDANTS,
  STANDARD_ACTOR_TURN_ACCELERATION,
  actorPolicyVersionSchema,
  actorBudgetSchema,
  actorEpochIdSchema,
  actorIdSchema,
  actorResultIdSchema,
  actorSchema,
  actorTurnIdSchema,
  actorTurnAccelerationSchema,
  persistedActorWorkClassSchema,
  isTerminalActorAttemptState,
  isTerminalActorTurnState,
  type Actor,
  type ActorAttempt,
  type ActorEpoch,
  type ActorResult,
  type ActorTurn,
  type ActorTurnAcceleration,
  type ActorPolicyVersion,
  type PersistedActorWorkClass,
  type ActorTurnState,
} from "./actor-domain";
import {
  metaharnessProfileFallbackReasonSchema,
  metaharnessProfileKeySchema,
  metaharnessFastFallbackReasonSchema,
  metaharnessTierSchema,
} from "./metaharness-policy-v1";
import type { HarnessActorSessionReadinessPortV2 } from
  "./actor-session-recovery-v2";
import type {
  ActorAttemptObservationBindingV2,
  ActorFastReservationRecordV2,
  ActorModelRerouteInboxRecordV2,
  ActorReconciliationTargetV2,
  ActorIncarnationRecord,
  ActorOperationRecord,
  ActorSessionBindingRecordV2,
  ActorSessionRecoveryProofV2,
  ActorWorkspaceBinding,
  PersistedActorAttempt,
} from "./sqlite-authority-v2";
import { actorSessionRecoveryProofV2Schema } from "./sqlite-authority-v2";
import type {
  PersistentActorLivenessPortV2,
  PersistentActorProviderTurnTargetV2,
  PersistentActorReconciliationRequestV2,
} from "./persistent-actor-liveness-v2";

export type { PersistentActorLivenessPortV2 } from "./persistent-actor-liveness-v2";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const canonicalTimestampSchema = z.string().length(24).datetime().refine(
  (value) => new Date(Date.parse(value)).toISOString() === value,
  "timestamp must use canonical UTC milliseconds",
);
const requestIdentitySchema = z.string().min(16).max(128)
  .refine((value) => !value.includes("\0"), "request identity contains NUL");
const boundedIdentitySchema = z.string().min(1).max(512)
  .refine((value) => !value.includes("\0"), "provider identity contains NUL");
const valueIdSchema = z.string().min(1).max(96)
  .refine((value) => !value.includes("\0"), "value identity contains NUL");
const accountProfileIdSchema = z.string().min(1).max(96)
  .refine((value) => !value.includes("\0"), "account identity contains NUL");
const laneIdSchema = z.string().min(1).max(128)
  .refine((value) => !value.includes("\0"), "workspace lane identity contains NUL");
const ACTOR_CHILD_PAGE_SIZE = 16;

export const persistentActorEffectProofSchema = z.object({
  digest: digestSchema,
  observedAt: canonicalTimestampSchema,
  definitive: z.boolean(),
  phase: z.enum(["preEffect", "postDispatch", "observation"]),
}).strict();

export type PersistentActorEffectProof = z.infer<
  typeof persistentActorEffectProofSchema
>;

const persistentActorFastCapacityReconciliationOutcomeSchema =
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("releasable"),
      successorGeneration: z.number().int().positive().safe(),
      proof: persistentActorEffectProofSchema.extend({
        definitive: z.literal(true),
        phase: z.literal("observation"),
      }).strict(),
    }).strict(),
    z.object({
      kind: z.literal("consumable"),
      successorGeneration: z.number().int().positive().safe(),
      providerTurnId: boundedIdentitySchema,
      terminal: z.enum(["completed", "interrupted", "failed"]),
      proof: persistentActorEffectProofSchema.extend({
        definitive: z.literal(true),
        phase: z.literal("observation"),
      }).strict(),
    }).strict(),
    z.object({
      kind: z.literal("held"),
      reason: z.string().min(1).max(96),
      successorGeneration: z.number().int().positive().safe().nullable(),
      proof: persistentActorEffectProofSchema.extend({
        definitive: z.literal(false),
        phase: z.literal("observation"),
      }).strict(),
    }).strict(),
  ]);

const providerNotAppliedSchema = z.object({
  kind: z.literal("notApplied"),
  reason: z.enum(["quota", "rejected", "unavailable", "notFound"]),
  proof: persistentActorEffectProofSchema,
}).strict();

const providerPendingSchema = z.object({
  kind: z.literal("pending"),
  proof: persistentActorEffectProofSchema,
}).strict();

const providerAmbiguousSchema = z.object({
  kind: z.literal("ambiguous"),
  proof: persistentActorEffectProofSchema,
}).strict();

export const persistentActorThreadOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("applied"),
    providerThreadId: boundedIdentitySchema,
    observedProfile: z.object({
      modelId: z.enum(["gpt-5.6-sol", "gpt-5.6-luna"]),
      reasoningEffort: z.enum(["ultra", "max"]),
    }).strict(),
    liveCapabilityEvidence: z.object({
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
          message: "live actor-start capability evidence must be complete",
          path: ["evidenceDigest"],
        });
      }
    }),
    sessionRecoveryProof: actorSessionRecoveryProofV2Schema,
    proof: persistentActorEffectProofSchema,
  }).strict(),
  providerNotAppliedSchema,
  providerPendingSchema,
  providerAmbiguousSchema,
]);

export type PersistentActorThreadOutcome = z.infer<
  typeof persistentActorThreadOutcomeSchema
>;

export const persistentActorTurnOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("applied"),
    providerTurnId: boundedIdentitySchema,
    proof: persistentActorEffectProofSchema,
  }).strict(),
  providerNotAppliedSchema,
  providerPendingSchema,
  providerAmbiguousSchema,
]);

export type PersistentActorTurnOutcome = z.infer<
  typeof persistentActorTurnOutcomeSchema
>;

export const persistentActorInterruptOutcomeSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("applied"),
      providerTurnId: boundedIdentitySchema,
      proof: persistentActorEffectProofSchema,
    }).strict(),
    providerNotAppliedSchema,
    providerPendingSchema,
    providerAmbiguousSchema,
  ],
);

export type PersistentActorInterruptOutcome = z.infer<
  typeof persistentActorInterruptOutcomeSchema
>;

export const persistentActorTerminalObservationSchema = z.object({
  accountProfileId: accountProfileIdSchema,
  processGeneration: z.number().int().positive().safe(),
  providerThreadId: boundedIdentitySchema,
  providerTurnId: boundedIdentitySchema,
  terminal: z.enum(["completed", "failed", "interrupted"]),
  resultValueId: valueIdSchema.nullable(),
  outcomeCode: z.string().min(1).max(96),
  quotaProof: z.literal("provider_usage_limit_exceeded").nullable(),
  inputTokens: z.number().int().nonnegative().safe().nullable(),
  outputTokens: z.number().int().nonnegative().safe().nullable(),
  proof: persistentActorEffectProofSchema,
}).strict().superRefine((event, context) => {
  if ((event.terminal === "completed") !== (event.resultValueId !== null)) {
    context.addIssue({
      code: "custom",
      message: "only a completed provider turn references a result value",
      path: ["resultValueId"],
    });
  }
  if ((event.quotaProof !== null) !==
    (event.terminal === "failed" && event.outcomeCode === "usage_limit_exceeded")) {
    context.addIssue({
      code: "custom",
      message: "only a definitive provider usage-limit failure carries quota proof",
      path: ["quotaProof"],
    });
  }
  if (
    event.quotaProof !== null &&
    (!event.proof.definitive || event.proof.phase !== "observation")
  ) {
    context.addIssue({
      code: "custom",
      message: "quota terminalization requires definitive terminal observation proof",
      path: ["proof"],
    });
  }
});

export type PersistentActorTerminalObservation = z.infer<
  typeof persistentActorTerminalObservationSchema
>;

export const persistentActorAccountCandidateSchema = z.object({
  accountProfileId: accountProfileIdSchema,
  activeTurnCount: z.number().int().nonnegative().safe(),
  capabilityEvidenceDigest: digestSchema,
  modelId: z.enum(["gpt-5.6-sol", "gpt-5.6-luna"]),
  processGeneration: z.number().int().positive().safe(),
  profileFallbackReason: metaharnessProfileFallbackReasonSchema.nullable(),
  remainingPercent: z.number().min(0).max(100).nullable(),
  selectedProfile: metaharnessProfileKeySchema,
  supportsFast: z.boolean(),
  reasoningEffort: z.enum(["ultra", "max"]),
  routingPriority: z.object({
    profileFallbackRank: z.union([z.literal(0), z.literal(1)]),
    budgetRank: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    remainingHeadroomRank: z.number().min(0).max(101),
    rendezvousScore: digestSchema,
    selected: z.boolean(),
  }).strict(),
}).strict();

export type PersistentActorAccountCandidate = z.infer<
  typeof persistentActorAccountCandidateSchema
>;

/**
 * One coherent account-routing snapshot. A signed-in, non-exhausted account
 * whose exact process generation has not converged its required capabilities
 * is temporary evidence, not proof that the subscription set is exhausted.
 */
export interface PersistentActorAccountEligibilityResult {
  readonly kind: "resolved";
  readonly candidates: readonly PersistentActorAccountCandidate[];
  readonly temporarilyUnavailableAccountProfileIds: readonly string[];
  readonly unsupportedAccountProfileIds: readonly string[];
}

export const persistentActorWorkspaceLeaseSchema = z.object({
  laneId: laneIdSchema,
  authority: z.enum(["readOnlySnapshot", "managedWrite"]),
}).strict();

export type PersistentActorWorkspaceLease = z.infer<
  typeof persistentActorWorkspaceLeaseSchema
>;

export interface PersistentActorQuotaContinuation {
  readonly sourceAttemptId: string;
  readonly historyValueId: string;
  readonly sourceAccountProfileId: string;
  readonly sourceProcessGeneration: number;
  readonly sourceProviderThreadId: string;
  readonly sourceProviderTurnId: string;
}

const persistentActorQuotaContinuationSchema: z.ZodType<PersistentActorQuotaContinuation> =
  z.object({
    sourceAttemptId: z.string().min(16).max(96)
      .regex(/^hattempt_[A-Za-z0-9_-]+$/u),
    historyValueId: z.string().min(16).max(96)
      .regex(/^ctxval_[A-Za-z0-9_-]+$/u),
    sourceAccountProfileId: accountProfileIdSchema,
    sourceProcessGeneration: z.number().int().positive().safe(),
    sourceProviderThreadId: boundedIdentitySchema,
    sourceProviderTurnId: boundedIdentitySchema,
  }).strict();

export interface PersistentActorThreadRequest {
  readonly actorId: string;
  readonly epochId: string;
  readonly policyVersion: ActorPolicyVersion;
  readonly workClass: PersistedActorWorkClass;
  readonly accountProfileId: string;
  readonly processGeneration: number;
  readonly modelId: "gpt-5.6-sol" | "gpt-5.6-luna";
  readonly reasoningEffort: "ultra" | "max";
  readonly selectedProfile: "solUltra" | "solMax" | "lunaMax";
  readonly profileFallbackReason: "lunaUnavailable" | null;
  readonly capabilityEvidenceDigest: string | null;
  readonly supportsFast: boolean;
  readonly clientRequestId: string;
  readonly threadSource: string;
  readonly toolsetDigest: string;
  readonly workspaceLaneId: string;
  readonly effectKey: string;
  readonly continuation: PersistentActorQuotaContinuation | null;
}

export interface PersistentActorTurnRequest {
  readonly actorId: string;
  readonly epochId: string;
  readonly turnId: string;
  readonly incarnationId: string;
  readonly accountProfileId: string;
  /** Generation at which the durable provider effect was admitted. */
  readonly processGeneration: number;
  /** Current proven runtime generation used only for reads and reconciliation. */
  readonly observationGeneration: number;
  readonly providerThreadId: string;
  readonly modelId: "gpt-5.6-sol" | "gpt-5.6-luna";
  readonly reasoningEffort: "ultra" | "max";
  readonly requestedAcceleration: ActorTurnAcceleration;
  readonly serviceTier: "standard" | "fast";
  readonly tierFallbackReason:
    | "automaticFastDisabled"
    | "fastUnsupported"
    | "fastReservationUnavailable"
    | null;
  readonly capabilityEvidenceDigest: string | null;
  readonly fastReservationId: string | null;
  readonly toolsetDigest: string;
  readonly clientUserMessageId: string;
  readonly inputValueId: string;
  readonly effectKey: string;
  readonly continuation: PersistentActorQuotaContinuation | null;
}

export interface PersistentActorInterruptRequest {
  readonly actorId: string;
  readonly turnId: string;
  readonly incarnationId: string;
  readonly accountProfileId: string;
  /** Generation at which the durable interrupt effect was admitted. */
  readonly processGeneration: number;
  /** Current proven runtime generation used only for reads and reconciliation. */
  readonly observationGeneration: number;
  readonly providerThreadId: string;
  readonly providerTurnId: string;
  readonly effectKey: string;
}

export interface PersistentActorTurnObservationRequest
  extends PersistentActorTurnRequest {
  readonly providerTurnId: string;
}

/**
 * The Codex adapter is deliberately unable to expose thread/fork or turn/steer.
 * Every method returns a parsed proof-bearing outcome; thrown transport errors
 * are treated as lost responses and reconciled before any further mutation.
 */
export interface PersistentActorProviderPort {
  startThread(request: PersistentActorThreadRequest): Promise<unknown>;
  reconcileThread(request: PersistentActorThreadRequest): Promise<unknown>;
  startTurn(request: PersistentActorTurnRequest): Promise<unknown>;
  reconcileTurn(request: PersistentActorTurnRequest): Promise<unknown>;
  reconcileQuarantinedFastCapacity(
    request: PersistentActorTurnRequest,
  ): Promise<unknown>;
  observeTurn(request: PersistentActorTurnObservationRequest): Promise<unknown>;
  interruptTurn(request: PersistentActorInterruptRequest): Promise<unknown>;
  reconcileInterrupt(request: PersistentActorInterruptRequest): Promise<unknown>;
}

export interface PersistentActorAccountPort {
  listEligibleAccounts(input: Readonly<{
    epochId: string;
    actorId: string;
    workClass: PersistedActorWorkClass;
  }>): Promise<unknown>;
}

export interface PersistentActorWorkspacePort {
  acquire(input: Readonly<{
    epoch: ActorEpoch;
    actor: Actor;
    bindingId: string;
  }>): Promise<unknown>;
}

export interface PersistentActorValuePort {
  prepareActorInput(input: Readonly<{
    epochId: string;
    callerActorId: string;
    targetActorId: string;
    turnId: string;
    sourceValueId: string;
  }>): Promise<unknown>;
  assertResultAvailable(input: Readonly<{
    epochId: string;
    actorId: string;
    turnId: string;
    valueId: string;
  }>): Promise<void>;
}

export interface PersistentActorClockPort {
  now(): Date;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export interface PersistentActorAuthorityPort {
  readActorEpoch(epochId: string): ActorEpoch | null;
  readActor(actorId: string): Actor | null;
  readActorDispatchPolicy(actorId: string): Readonly<{
    actorId: string;
    policyVersion: ActorPolicyVersion;
    workClass: PersistedActorWorkClass;
  }>;
  /** Remaining direct-turn tokens; descendant reservations stay distinct. */
  remainingActorTokens(actorId: string): number;
  recordActorTurnUsage(input: Readonly<{
    accountProfileId: string;
    processGeneration: number;
    providerThreadId: string;
    providerTurnId: string;
    streamPosition: number;
    cumulativeInputTokens: number;
    cumulativeOutputTokens: number;
    cumulativeCachedInputTokens: number;
    cumulativeReasoningOutputTokens: number;
  }>): Promise<boolean>;
  recordActorModelReroute(input: Readonly<{
    accountProfileId: string;
    observationGeneration: number;
    providerThreadId: string;
    providerTurnId: string;
    streamPosition: number;
    fromModel: string;
    toModel: string;
    reason: "highRiskCyberActivity";
    now?: string;
  }>): Promise<readonly ActorModelRerouteInboxRecordV2[]>;
  readActorModelRerouteForAttempt(
    attemptId: string,
  ): ActorModelRerouteInboxRecordV2 | null;
  listUnsettledActorModelReroutes(input: Readonly<{
    after?: Readonly<{ updatedAt: string; attemptId: string }> | null;
    limit: number;
  }>): readonly ActorModelRerouteInboxRecordV2[];
  settleActorModelReroute(input: Readonly<{
    attemptId: string;
    factDigest: string;
    expectedState: "bound" | "quarantined";
    now?: string;
  }>): ActorModelRerouteInboxRecordV2;
  readActorTurnUsage(input: Readonly<{
    accountProfileId: string;
    processGeneration: number;
    providerTurnId: string;
  }>): Readonly<{ inputTokens: number; outputTokens: number }> | null;
  listActorChildren(input: Readonly<{
    parentActorId: string;
    afterActorId?: string | null;
    limit: number;
  }>): readonly Actor[];
  createChildActor(
    actor: Actor,
    dispatchPolicy?: Readonly<{
      policyVersion: ActorPolicyVersion;
      workClass: PersistedActorWorkClass;
    }>,
  ): Actor;
  /**
   * Compensates only a pristine child whose admission did not reach a durable
   * turn.  In particular it releases the ancestor reservation in the same
   * transaction; an externally visible actor is never silently discarded.
   */
  discardPristineChildActor(actorId: string): boolean;
  requestActorStop(input: Readonly<{
    actorId: string;
    expectedRevision: number;
    now?: string;
  }>): Actor;
  settleActorStop(input: Readonly<{
    actorId: string;
    expectedRevision: number;
    nextState: "stopped" | "quarantined";
    now?: string;
  }>): Actor;
  createActorTurn(input: Readonly<{
    turnId: string;
    epochId: string;
    actorId: string;
    idempotencyKey: string;
    inputValueId: string;
    acceleration: ActorTurnAcceleration;
    createdAt?: string;
  }>): ActorTurn;
  readActorTurn(turnId: string): ActorTurn | null;
  readActorTurnAcceleration(turnId: string): Readonly<
    | ({ turnId: string } & { mode: "standard" })
    | ({ turnId: string } & {
        mode: "fast";
        criticalPath: true;
        bottleneck: "reasoning" | "fileGeneration";
      })
  >;
  transitionActorTurn(input: Readonly<{
    turnId: string;
    expectedRevision: number;
    nextState: ActorTurnState;
    outcomeCode?: string | null;
    now?: string;
  }>): ActorTurn;
  requestActorTurnStop(input: Readonly<{
    turnId: string;
    expectedRevision: number;
  }>): ActorTurn;
  prepareActorOperation(input: Readonly<{
    operationId: string;
    actorId: string;
    turnId: string | null;
    kind: ActorOperationRecord["kind"];
    requestDigest: string;
    effectKey: string;
    providerIdentityJson: string;
    createdAt?: string;
  }>): ActorOperationRecord;
  rebasePreparedActorOperation(input: Readonly<{
    operationId: string;
    expectedRequestDigest: string;
    requestDigest: string;
    effectKey: string;
    providerIdentityJson: string;
    now?: string;
  }>): ActorOperationRecord;
  transitionActorOperation(input: Readonly<{
    operationId: string;
    expectedState: ActorOperationRecord["state"];
    nextState: ActorOperationRecord["state"];
    providerIdentityJson?: string | null;
    now?: string;
  }>): ActorOperationRecord;
  readActorOperation(operationId: string): ActorOperationRecord | null;
  listRecoverableActorOperations(input: Readonly<{
    afterOperationId?: string | null;
    limit: number;
  }>): readonly ActorOperationRecord[];
  readActorReconciliationTarget(input: Readonly<{
    target: ActorReconciliationTargetV2;
    limit: number;
  }>): Readonly<{
    operations: readonly ActorOperationRecord[];
    attempts: readonly PersistedActorAttempt[];
    turns: readonly ActorTurn[];
  }>;
  createActorIncarnation(input: Readonly<{
    incarnationId: string;
    actorId: string;
    accountProfileId: string;
    processGeneration: number;
    startOperationId: string;
    clientRequestId: string;
    threadSource: string;
    toolsetDigest: string;
    profile?: Readonly<{
      modelId: "gpt-5.6-sol" | "gpt-5.6-luna";
      reasoningEffort: "ultra" | "max";
      profileFallbackReason: "lunaUnavailable" | null;
      capabilityEvidenceDigest: string | null;
      supportsFast: boolean | null;
    }>;
    createdAt?: string;
  }>): ActorIncarnationRecord;
  createActorIncarnationWithAccountLease(input: Readonly<{
    leaseId: string;
    incarnationId: string;
    actorId: string;
    candidates: readonly Readonly<{
      accountProfileId: string;
      processGeneration: number;
      profile: Readonly<{
        modelId: "gpt-5.6-sol" | "gpt-5.6-luna";
        reasoningEffort: "ultra" | "max";
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
  }>): Readonly<{ incarnation: ActorIncarnationRecord }>;
  transitionActorIncarnation(input: Readonly<{
    incarnationId: string;
    expectedState: ActorIncarnationRecord["state"];
    nextState: ActorIncarnationRecord["state"];
    providerThreadId?: string | null;
    now?: string;
  }>): ActorIncarnationRecord;
  recordActorIncarnationObservedProfile(input: Readonly<{
    incarnationId: string;
    observedProfile: Readonly<{
      modelId: string;
      reasoningEffort: "ultra" | "max";
    }>;
    observedAt?: string;
  }>): ActorIncarnationRecord;
  readActorIncarnation(incarnationId: string): ActorIncarnationRecord | null;
  readActiveIncarnationForActor(actorId: string): ActorIncarnationRecord | null;
  bindActorSession(input: Readonly<{
    incarnationId: string;
    liveCapabilityEvidence?: Readonly<{
      observationGeneration: number;
      evidenceDigest: string | null;
      supportsFast: boolean | null;
    }>;
    recoveryProof: ActorSessionRecoveryProofV2;
    createdAt?: string;
  }>): ActorSessionBindingRecordV2;
  readActorSessionBinding(
    incarnationId: string,
  ): ActorSessionBindingRecordV2 | null;
  createActorAttempt(input: Readonly<{
    attemptId: string;
    turnId: string;
    incarnationId: string;
    accountProfileId: string;
    processGeneration: number;
    clientUserMessageId: string;
    createdAt?: string;
  }>): PersistedActorAttempt;
  claimActorAttempt(input: Readonly<{
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
  }>;
  startActorTurnEffect(input: Readonly<{
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
      }
    | {
        kind: "retryStandard";
        operation: ActorOperationRecord;
        attempt: PersistedActorAttempt;
      }
  >;
  markActorFastReservationEffectStarted(input: Readonly<{
    reservationId: string;
    attemptId: string;
    now?: string;
  }>): unknown;
  readActorFastReservationForAttempt(attemptId: string): Readonly<{
    id: string;
    attemptId: string;
    state: "reserved" | "effectStarted" | "released" | "consumed" | "quarantined";
    terminalReason:
      | "preEffectTerminal"
      | "definitiveNotApplied"
      | "providerTerminal"
      | "generationFenced"
      | "ambiguousProviderEffect"
      | null;
  }> | null;
  listQuarantinedActorFastReservations(input: Readonly<{
    after?: Readonly<{
      updatedAt: string;
      reservationId: string;
    }> | null;
    limit: number;
  }>): readonly ActorFastReservationRecordV2[];
  containAmbiguousActorTurn(input: Readonly<{
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
  }>;
  settleActorFastReservation(input: Readonly<{
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
  }>): unknown;
  bindActorAttemptProviderTurn(input: Readonly<{
    attemptId: string;
    expectedState: "starting" | "reconciling";
    providerTurnId: string;
  }>): Promise<PersistedActorAttempt>;
  bindActorQuotaContinuationCapsule(input: Readonly<{
    attemptId: string;
    expectedState: "running" | "reconciling";
    continuationHistoryValueId: string;
  }>): PersistedActorAttempt;
  settleActorQuotaRejection(input: Readonly<{
    attemptId: string;
    expectedState: "running" | "reconciling";
    providerTurnId: string;
    continuationHistoryValueId?: string | null;
    quotaProofDigest: string;
    inputTokens: number;
    outputTokens: number;
    now?: string;
  }>): PersistedActorAttempt;
  settleActorTerminalObservation(input: Readonly<{
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
  }>): Readonly<{ attempt: PersistedActorAttempt; result: ActorResult }>;
  transitionActorAttempt(input: Readonly<{
    attemptId: string;
    expectedState: ActorAttempt["state"];
    nextState: ActorAttempt["state"];
    providerTurnId?: string | null;
    quotaProofDigest?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    now?: string;
  }>): PersistedActorAttempt;
  settleClaimedActorCancellation(input: Readonly<{
    resultId: string;
    operationId: string;
    attemptId: string;
    turnId: string;
    incarnationId: string;
    outcomeCode: string;
    now?: string;
  }>): ActorResult;
  readActorAttempt(attemptId: string): PersistedActorAttempt | null;
  readActorAttemptByProviderTurnId(input: Readonly<{
    accountProfileId: string;
    processGeneration: number;
    providerTurnId: string;
  }>): PersistedActorAttempt | null;
  resolveActorAttemptObservation(input: Readonly<{
    accountProfileId: string;
    observationGeneration: number;
    providerThreadId: string;
    providerTurnId: string;
  }>): ActorAttemptObservationBindingV2 | null;
  listUnsettledActorAttempts(input: Readonly<{
    afterAttemptId?: string | null;
    limit: number;
  }>): readonly PersistedActorAttempt[];
  listActorAttempts(input: Readonly<{
    turnId: string;
    afterOrdinal?: number;
    limit: number;
  }>): readonly PersistedActorAttempt[];
  listLiveActorTurns(input: Readonly<{
    afterTurnId?: string | null;
    limit: number;
  }>): readonly ActorTurn[];
  settleActorResult(input: Readonly<{
    resultId: string;
    turnId: string;
    terminalAttemptId: string | null;
    outcome: ActorResult["outcome"];
    valueId: string | null;
    expectedTurnRevision: number;
    outcomeCode: string;
    createdAt?: string;
  }>): ActorResult;
  settleActorThreadAdmissionQuotaExhaustion(input: Readonly<{
    resultId: string;
    turnId: string;
    actorStartOperationIds: readonly string[];
    expectedTurnRevision: number;
    outcomeCode: string;
    createdAt?: string;
  }>): ActorResult;
  settleInvalidQuotaContinuation(input: Readonly<{
    resultId: string;
    turnId: string;
    terminalAttemptId: string;
    expectedTurnRevision: number;
    outcomeCode: string;
    createdAt?: string;
  }>): Readonly<{ actor: Actor; result: ActorResult }>;
  readActorResult(resultId: string): ActorResult | null;
  readLatestActorResult(actorId: string): ActorResult | null;
  listActorResults(input: Readonly<{
    actorId: string;
    afterActorResultOrdinal?: number;
    limit: number;
  }>): readonly ActorResult[];
  listEpochResults(input: Readonly<{
    epochId: string;
    afterRootCompletionSequence?: number;
    limit: number;
  }>): readonly ActorResult[];
  bindActorWorkspace(input: Readonly<{
    bindingId: string;
    actorId: string;
    laneId: string;
    authority: ActorWorkspaceBinding["authority"];
    createdAt?: string;
  }>): ActorWorkspaceBinding;
}

/**
 * The third Codex fact-router consumer. It accepts only positioned exact
 * per-turn usage, never session-derived IDs, and makes duplicate delivery an
 * idempotent ledger write.
 */
export class PersistentActorTokenUsageFactConsumer implements CodexFactConsumer {
  readonly #authority: PersistentActorAuthorityPort;
  readonly #reroutes: Readonly<{
    containActorModelReroute(
      fact: Extract<CodexFact, { type: "turn.model_rerouted" }>,
    ): Promise<boolean>;
  }>;

  constructor(
    authority: PersistentActorAuthorityPort,
    reroutes: Readonly<{
      containActorModelReroute(
        fact: Extract<CodexFact, { type: "turn.model_rerouted" }>,
      ): Promise<boolean>;
    }>,
  ) {
    this.#authority = authority;
    this.#reroutes = reroutes;
  }

  async consumeCodexFacts(facts: readonly CodexFact[]): Promise<void> {
    for (const fact of facts) {
      if (fact.type === "turn.token_usage") {
        await this.#authority.recordActorTurnUsage({
          accountProfileId: fact.accountProfileId,
          processGeneration: fact.generation,
          providerThreadId: fact.threadId,
          providerTurnId: fact.turnId,
          streamPosition: fact.streamPosition,
          cumulativeInputTokens: fact.cumulativeInputTokens,
          cumulativeOutputTokens: fact.cumulativeOutputTokens,
          cumulativeCachedInputTokens: fact.cumulativeCachedInputTokens,
          cumulativeReasoningOutputTokens: fact.cumulativeReasoningOutputTokens,
        });
      } else if (fact.type === "turn.model_rerouted") {
        await this.#reroutes.containActorModelReroute(fact);
      }
    }
  }
}

export class PersistentActorError extends Error {
  readonly code:
    | "aborted"
    | "account_exhausted"
    | "actor_busy"
    | "ambiguous_effect"
    | "conflict"
    | "invalid_state"
    | "not_found"
    | "provider_pending"
    | "timeout"
    | "unauthorized";

  constructor(code: PersistentActorError["code"], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PersistentActorError";
    this.code = code;
  }
}

export interface PersistentActorStatus {
  readonly actor: Actor;
  readonly incarnation: ActorIncarnationRecord | null;
  readonly liveTurns: readonly ActorTurn[];
  readonly latestResult: ActorResult | null;
}

export interface PersistentActorTurnView {
  readonly turn: ActorTurn;
  readonly result: ActorResult | null;
}

export interface PersistentActorWaitAnyResult {
  readonly state: "terminal" | "timeout";
  readonly completed: PersistentActorTurnView | null;
  readonly pendingTurnIds: readonly string[];
}

export interface PersistentActorWaitAllResult {
  readonly state: "terminal" | "timeout";
  readonly completed: readonly PersistentActorTurnView[];
  readonly pendingTurnIds: readonly string[];
}

export interface PersistentActorCoordinatorOptions {
  readonly authority: PersistentActorAuthorityPort;
  readonly provider: PersistentActorProviderPort;
  readonly accounts: PersistentActorAccountPort;
  readonly workspaces: PersistentActorWorkspacePort;
  readonly values: PersistentActorValuePort;
  readonly toolsetDigest: string;
  readonly clock?: PersistentActorClockPort;
  readonly liveness: PersistentActorLivenessPortV2;
  readonly sessionReadiness?: HarnessActorSessionReadinessPortV2;
  readonly waitPollMilliseconds?: number;
  readonly recoveryPageSize?: number;
}

const spawnInputSchema = z.object({
  callerActorId: actorIdSchema,
  idempotencyKey: requestIdentitySchema,
  title: z.string().min(1).max(160).refine(
    (value) => !value.includes("\0"),
    "actor title contains NUL",
  ),
  budget: actorBudgetSchema,
  inputValueId: valueIdSchema,
  policyVersion: actorPolicyVersionSchema,
  workClass: persistedActorWorkClassSchema,
  acceleration: actorTurnAccelerationSchema,
}).strict().superRefine((input, context) => {
  if (
    (input.policyVersion === 0) !== (input.workClass === "legacyUnclassified")
  ) {
    context.addIssue({
      code: "custom",
      message: "only legacy policy v0 may use the legacy work class",
      path: ["workClass"],
    });
  }
});

const sendInputSchema = z.object({
  callerActorId: actorIdSchema,
  actorId: actorIdSchema,
  idempotencyKey: requestIdentitySchema,
  inputValueId: valueIdSchema,
  acceleration: actorTurnAccelerationSchema
    .default(STANDARD_ACTOR_TURN_ACCELERATION),
}).strict();

const actorTargetSchema = z.object({
  callerActorId: actorIdSchema,
  actorId: actorIdSchema,
}).strict();

const turnTargetSchema = z.object({
  callerActorId: actorIdSchema,
  turnId: actorTurnIdSchema,
}).strict();

const waitInputSchema = z.object({
  callerActorId: actorIdSchema,
  turnIds: z.array(actorTurnIdSchema).min(1).max(50),
  timeoutMs: z.number().int().min(0).max(300_000),
}).strict();

const accountEligibilitySchema: z.ZodType<PersistentActorAccountEligibilityResult> =
  z.object({
    kind: z.literal("resolved"),
    candidates: z.array(persistentActorAccountCandidateSchema).max(50),
    temporarilyUnavailableAccountProfileIds: z.array(accountProfileIdSchema)
      .max(50),
    unsupportedAccountProfileIds: z.array(accountProfileIdSchema).max(50),
  }).strict();

const actorReconciliationRequestSchema: z.ZodType<
  PersistentActorReconciliationRequestV2
> = z.object({
  limit: z.number().int().min(1).max(4_096),
  actorIds: z.array(actorIdSchema).max(4_096).optional(),
  turnIds: z.array(actorTurnIdSchema).max(4_096).optional(),
  incarnationIds: z.array(z.string().min(16).max(96).refine(
    (value) => !value.includes("\0"),
    "incarnation identity contains NUL",
  )).max(4_096).optional(),
  providerTurns: z.array(z.object({
    accountProfileId: accountProfileIdSchema,
    providerThreadId: boundedIdentitySchema,
    providerTurnId: boundedIdentitySchema,
  }).strict()).max(4_096).optional(),
}).strict();

const defaultClock: PersistentActorClockPort = {
  now: () => new Date(),
  sleep: (milliseconds, signal) => new Promise<void>((resolve, reject) => {
    const abortSignal = signal;
    if (abortSignal?.aborted === true) {
      reject(abortSignal.reason instanceof Error ? abortSignal.reason : new Error("aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortSignal?.reason instanceof Error ? abortSignal.reason : new Error("aborted"));
    };
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  }),
};

const alwaysReadyActorSessions: HarnessActorSessionReadinessPortV2 =
  Object.freeze({ isActorSessionReady: () => true });

function actorReconciliationSelection(
  input: PersistentActorReconciliationRequestV2,
): Readonly<{
  targeted: boolean;
  includesOperation(
    operation: ActorOperationRecord,
    incarnation: ActorIncarnationRecord | null,
  ): boolean;
  includesAttempt(
    attempt: PersistedActorAttempt,
    turn: ActorTurn,
    incarnation: ActorIncarnationRecord,
  ): boolean;
  includesTurn(
    turn: ActorTurn,
    attempt: PersistedActorAttempt | null,
    incarnation: ActorIncarnationRecord | null,
  ): boolean;
}> {
  const targeted = input.actorIds !== undefined || input.turnIds !== undefined ||
    input.incarnationIds !== undefined || input.providerTurns !== undefined;
  const actorIds = new Set(input.actorIds ?? []);
  const turnIds = new Set(input.turnIds ?? []);
  const incarnationIds = new Set(input.incarnationIds ?? []);
  const providerTurns = new Set(
    (input.providerTurns ?? []).map(providerTurnSelectionKey),
  );
  const includesProviderTurn = (
    attempt: PersistedActorAttempt | null,
    incarnation: ActorIncarnationRecord | null,
  ): boolean => attempt?.providerTurnId !== null &&
    attempt?.providerTurnId !== undefined &&
    incarnation?.providerThreadId !== null &&
    incarnation?.providerThreadId !== undefined &&
    providerTurns.has(providerTurnSelectionKey({
      accountProfileId: attempt.accountProfileId,
      providerThreadId: incarnation.providerThreadId,
      providerTurnId: attempt.providerTurnId,
    }));
  return Object.freeze({
    targeted,
    includesOperation: (operation, incarnation) => !targeted ||
      actorIds.has(operation.actorId) ||
      (incarnation !== null && incarnationIds.has(incarnation.id)),
    includesAttempt: (attempt, turn, incarnation) => !targeted ||
      actorIds.has(turn.actorId) || turnIds.has(turn.id) ||
      incarnationIds.has(incarnation.id) ||
      includesProviderTurn(attempt, incarnation),
    includesTurn: (turn, attempt, incarnation) => !targeted ||
      actorIds.has(turn.actorId) || turnIds.has(turn.id) ||
      (incarnation !== null && incarnationIds.has(incarnation.id)) ||
      includesProviderTurn(attempt, incarnation),
  });
}

function providerTurnSelectionKey(
  target: PersistentActorProviderTurnTargetV2,
): string {
  return [
    target.accountProfileId,
    target.providerThreadId,
    target.providerTurnId,
  ].join("\0");
}

function actorReconciliationTargets(
  input: PersistentActorReconciliationRequestV2,
): readonly ActorReconciliationTargetV2[] {
  const targets = new Map<string, ActorReconciliationTargetV2>();
  for (const actorId of input.actorIds ?? []) {
    targets.set(`actor\0${actorId}`, { kind: "actor", actorId });
  }
  for (const turnId of input.turnIds ?? []) {
    targets.set(`turn\0${turnId}`, { kind: "turn", turnId });
  }
  for (const incarnationId of input.incarnationIds ?? []) {
    targets.set(`incarnation\0${incarnationId}`, {
      kind: "incarnation",
      incarnationId,
    });
  }
  for (const providerTurn of input.providerTurns ?? []) {
    targets.set(`providerTurn\0${providerTurnSelectionKey(providerTurn)}`, {
      kind: "providerTurn",
      ...providerTurn,
    });
  }
  return [...targets.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right)).map(([, target]) => target);
}

function rotatingAuditPage<T>(input: Readonly<{
  cursor: string | null;
  limit: number;
  pageSize: number;
  load(after: string | null, limit: number): readonly T[];
  key(value: T): string;
}>): Readonly<{ values: readonly T[]; cursor: string | null }> {
  const values: T[] = [];
  const seen = new Set<string>();
  let after = input.cursor;
  let wrapped = input.cursor === null;
  scan: while (values.length < input.limit) {
    const requested = Math.min(input.pageSize, input.limit - values.length);
    const page = input.load(after, requested);
    for (const value of page) {
      const key = input.key(value);
      if (seen.has(key)) break scan;
      seen.add(key);
      values.push(value);
      after = key;
    }
    if (values.length >= input.limit) break;
    if (page.length < requested) {
      if (wrapped) break;
      wrapped = true;
      after = null;
      continue;
    }
    if (page.length === 0) break;
  }
  return Object.freeze({
    values: Object.freeze(values),
    cursor: values.length === 0 ? null : input.key(values.at(-1)!),
  });
}

export class PersistentActorCoordinator {
  readonly #authority: PersistentActorAuthorityPort;
  readonly #provider: PersistentActorProviderPort;
  readonly #accounts: PersistentActorAccountPort;
  readonly #workspaces: PersistentActorWorkspacePort;
  readonly #values: PersistentActorValuePort;
  readonly #toolsetDigest: string;
  readonly #clock: PersistentActorClockPort;
  readonly #liveness: PersistentActorLivenessPortV2;
  readonly #sessionReadiness: HarnessActorSessionReadinessPortV2;
  readonly #waitPollMilliseconds: number;
  readonly #recoveryPageSize: number;
  #operationAuditCursor: string | null = null;
  #attemptAuditCursor: string | null = null;
  #turnAuditCursor: string | null = null;
  #deadlineTurnAuditCursor: string | null = null;
  #fastCapacityAuditCursor: Readonly<{
    updatedAt: string;
    reservationId: string;
  }> | null = null;
  #modelRerouteAuditCursor: Readonly<{
    updatedAt: string;
    attemptId: string;
  }> | null = null;

  constructor(options: PersistentActorCoordinatorOptions) {
    this.#authority = options.authority;
    this.#provider = options.provider;
    this.#accounts = options.accounts;
    this.#workspaces = options.workspaces;
    this.#values = options.values;
    this.#toolsetDigest = digestSchema.parse(options.toolsetDigest);
    this.#clock = options.clock ?? defaultClock;
    this.#liveness = options.liveness;
    this.#sessionReadiness = options.sessionReadiness ?? alwaysReadyActorSessions;
    this.#waitPollMilliseconds = z.number().int().min(1).max(1_000)
      .parse(options.waitPollMilliseconds ?? 25);
    this.#recoveryPageSize = z.number().int().min(1).max(128)
      .parse(options.recoveryPageSize ?? 128);
  }

  async containActorModelReroute(
    fact: Extract<CodexFact, { type: "turn.model_rerouted" }>,
  ): Promise<boolean> {
    const records = await this.#authority.recordActorModelReroute({
      accountProfileId: fact.accountProfileId,
      observationGeneration: fact.generation,
      providerThreadId: fact.threadId,
      providerTurnId: fact.turnId,
      streamPosition: fact.streamPosition,
      fromModel: fact.fromModel,
      toModel: fact.toModel,
      reason: fact.reason,
      now: this.#timestamp(),
    });
    if (records.length === 0) return false;
    for (const record of records) {
      this.#containActorModelRerouteRecord(record);
    }
    return true;
  }

  #containActorModelRerouteRecord(
    recordValue: ActorModelRerouteInboxRecordV2,
  ): boolean {
    let record = this.#authority.readActorModelRerouteForAttempt(
      recordValue.attemptId,
    );
    if (record === null || record.state === "pending" ||
      record.state === "settled") return false;
    const attempt = this.#requireAttempt(record.attemptId);
    let incarnation = this.#requireIncarnation(attempt.incarnationId);
    const turn = this.#requireTurn(attempt.turnId);
    const actorBeforeContainment = this.#requireActor(turn.actorId);
    if (
      record.state === "bound" && attempt.providerTurnId !== null &&
      (incarnation.state === "starting" || incarnation.state === "idle" ||
        incarnation.state === "running")
    ) {
      this.#authority.recordActorIncarnationObservedProfile({
        incarnationId: incarnation.id,
        observedProfile: {
          modelId: record.toModel,
          reasoningEffort: incarnation.requestedReasoningEffort,
        },
        observedAt: record.createdAt,
      });
      incarnation = this.#requireIncarnation(incarnation.id);
    }
    const contained = this.#authority.containAmbiguousActorTurn({
      attemptId: record.attemptId,
      evidenceDigest: record.factDigest,
      now: this.#timestamp(),
    });
    const evidenceAttemptState = isTerminalActorAttemptState(attempt.state)
      ? attempt.state
      : "ambiguous";
    const evidenceTurnState = isTerminalActorTurnState(turn.state)
      ? turn.state
      : "ambiguous";
    const evidenceIncarnationState =
        incarnation.state === "starting" || incarnation.state === "idle" ||
        incarnation.state === "running"
      ? "quarantined"
      : incarnation.state;
    const stoppedWithoutLiveLineage =
      actorBeforeContainment.state === "stopped" &&
      contained.actor.state === "stopped" &&
      contained.containedTurn === null &&
      contained.containedAttempt === null &&
      contained.containedIncarnation === null &&
      contained.containedFastReservation === null;
    const quarantinedLiveLineage =
      actorBeforeContainment.state !== "stopped" &&
      contained.actor.state === "quarantined";
    if (
      contained.evidenceAttempt.id !== attempt.id ||
      contained.evidenceAttempt.turnId !== turn.id ||
      contained.evidenceAttempt.incarnationId !== incarnation.id ||
      contained.evidenceAttempt.state !== evidenceAttemptState ||
      contained.evidenceTurn.id !== turn.id ||
      contained.evidenceTurn.actorId !== contained.actor.id ||
      contained.evidenceTurn.state !== evidenceTurnState ||
      contained.evidenceIncarnation.id !== incarnation.id ||
      contained.evidenceIncarnation.actorId !== contained.actor.id ||
      contained.evidenceIncarnation.state !== evidenceIncarnationState ||
      (!quarantinedLiveLineage && !stoppedWithoutLiveLineage) ||
      (contained.containedTurn !== null &&
        (contained.containedTurn.actorId !== contained.actor.id ||
          contained.containedTurn.state !== "ambiguous")) ||
      (contained.containedAttempt !== null &&
        (contained.containedAttempt.state !== "ambiguous" ||
          contained.containedTurn?.id !== contained.containedAttempt.turnId ||
          contained.containedIncarnation?.id !==
            contained.containedAttempt.incarnationId)) ||
      (contained.containedIncarnation !== null &&
        (contained.containedIncarnation.actorId !== contained.actor.id ||
          contained.containedIncarnation.state !== "quarantined"))
    ) {
      throw new PersistentActorError(
        "conflict",
        "actor model reroute containment returned another durable lineage",
      );
    }
    record = this.#authority.settleActorModelReroute({
      attemptId: record.attemptId,
      factDigest: record.factDigest,
      expectedState: record.state,
      now: this.#timestamp(),
    });
    if (record.state !== "settled") {
      throw new PersistentActorError(
        "conflict",
        "actor model reroute containment did not settle its durable inbox",
      );
    }
    return true;
  }

  async spawn(inputValue: unknown): Promise<Readonly<{
    actor: Actor;
    turn: PersistentActorTurnView;
  }>> {
    const input = spawnInputSchema.parse(inputValue);
    const parent = this.#requireActiveActor(input.callerActorId);
    const parentPolicy = this.#authority.readActorDispatchPolicy(parent.id);
    if (parentPolicy.workClass === "boundedLeaf") {
      throw new PersistentActorError(
        "unauthorized",
        "bounded-leaf actors cannot recursively delegate",
      );
    }
    // A child that is already expired is never admitted, so a rejected spawn
    // cannot leave either a child record or a parent reservation behind.
    if (this.#clock.now().getTime() >= Date.parse(input.budget.deadline)) {
      throw new PersistentActorError(
        "timeout",
        "requested child deadline elapsed before admission",
      );
    }
    this.#requireEpoch(parent.epochId);
    const actorId = deriveOpaqueId("hactor", "spawn", [
      parent.epochId,
      parent.id,
      input.idempotencyKey,
    ]);
    let actor = this.#authority.readActor(actorId);
    let created = false;
    if (actor === null) {
      if (input.policyVersion === 0) {
        throw new PersistentActorError(
          "unauthorized",
          "legacy actor operations are recovery-only and cannot admit a fresh child",
        );
      }
      const now = this.#timestamp();
      actor = this.#authority.createChildActor({
        id: actorId,
        epochId: parent.epochId,
        parentActorId: parent.id,
        depth: parent.depth + 1,
        title: input.title,
        state: "active",
        budget: input.budget,
        tokenReserved: 0,
        byteReserved: 0,
        nextTurnOrdinal: 1,
        nextResultOrdinal: 1,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        stoppedAt: null,
      }, {
        policyVersion: input.policyVersion,
        workClass: input.workClass,
      });
      created = true;
    } else {
      const policy = this.#authority.readActorDispatchPolicy(actor.id);
      if (
        actor.epochId !== parent.epochId || actor.parentActorId !== parent.id ||
        policy.policyVersion !== input.policyVersion ||
        policy.workClass !== input.workClass ||
        actor.title !== input.title ||
        canonicalJson(actor.budget) !== canonicalJson(input.budget)
      ) {
        throw new PersistentActorError(
          "conflict",
          "spawn idempotency identity is already bound to different actor input",
        );
      }
    }
    try {
      const turn = await this.#createAndDriveTurn({
        callerActorId: parent.id,
        actor,
        idempotencyKey: input.idempotencyKey,
        inputValueId: input.inputValueId,
        acceleration: input.acceleration,
      });
      return { actor: this.#requireActor(actor.id), turn };
    } catch (error: unknown) {
      // A definitive input-preparation failure happens before workspace
      // acquisition and before the child has a turn receipt. Do not strand an
      // invisible active child or consume a parent reservation in that case.
      // Once a turn exists, recovery owns it and pristine rollback refuses it.
      if (created) this.#authority.discardPristineChildActor(actor.id);
      throw error;
    }
  }

  async send(inputValue: unknown): Promise<PersistentActorTurnView> {
    const input = sendInputSchema.parse(inputValue);
    const actor = this.#requireControlledActor(input.callerActorId, input.actorId);
    if (actor.state !== "active") {
      throw new PersistentActorError("invalid_state", "only an active actor accepts a turn");
    }
    const dispatchPolicy = this.#authority.readActorDispatchPolicy(actor.id);
    const replayTurnId = deriveOpaqueId("hturn", "turn", [
      actor.epochId,
      actor.id,
      input.idempotencyKey,
    ]);
    if (
      dispatchPolicy.policyVersion === 0 &&
      this.#authority.readActorTurn(replayTurnId) === null
    ) {
      throw new PersistentActorError(
        "invalid_state",
        "predecessor actor policy may replay durable turns but cannot admit a new turn",
      );
    }
    this.#assertActorBeforeDeadline(actor);
    this.#assertActorIdleOrReplay(actor.id, input.idempotencyKey);
    return await this.#createAndDriveTurn({
      callerActorId: input.callerActorId,
      actor,
      idempotencyKey: input.idempotencyKey,
      inputValueId: input.inputValueId,
      acceleration: input.acceleration,
    });
  }

  async status(inputValue: unknown): Promise<PersistentActorStatus> {
    const input = actorTargetSchema.parse(inputValue);
    this.#requireControlledActor(input.callerActorId, input.actorId);
    await this.#liveness.ensureCurrent({ actorIds: [input.actorId] });
    const actor = this.#requireControlledActor(input.callerActorId, input.actorId);
    const liveTurns = this.#readActorReconciliation(actor.id).turns
      .toSorted(compareTurns);
    return await Promise.resolve({
      actor,
      incarnation: this.#authority.readActiveIncarnationForActor(actor.id),
      liveTurns,
      latestResult: this.#authority.readLatestActorResult(actor.id),
    });
  }

  async result(inputValue: unknown): Promise<PersistentActorTurnView> {
    const input = turnTargetSchema.parse(inputValue);
    this.#requireControlledTurn(input.callerActorId, input.turnId);
    await this.#liveness.ensureCurrent({ turnIds: [input.turnId] });
    const turn = this.#requireControlledTurn(input.callerActorId, input.turnId);
    return await Promise.resolve(this.#turnView(turn));
  }

  async waitAny(
    inputValue: unknown,
    signal?: AbortSignal,
  ): Promise<PersistentActorWaitAnyResult> {
    const input = parseWaitInput(inputValue);
    const deadline = this.#deadline(input.callerActorId, input.timeoutMs);
    input.turnIds.forEach((turnId) => {
      this.#requireControlledTurn(input.callerActorId, turnId);
    });
    while (true) {
      this.#throwIfAborted(signal);
      const liveness = this.#clock.now().getTime() >= deadline
        ? "timeout"
        : await this.#awaitLivenessUntil(input.turnIds, deadline, signal);
      const views = input.turnIds.map((turnId) => this.#turnView(
        this.#requireControlledTurn(input.callerActorId, turnId),
      ));
      const completed = sortTerminalViews(views.filter(isTerminalTurnView));
      if (completed.length > 0) {
        const selected = completed[0]!;
        return {
          state: "terminal",
          completed: selected,
          pendingTurnIds: views.filter((view) => !isTerminalTurnView(view))
            .map((view) => view.turn.id).sort(compareText),
        };
      }
      if (liveness === "timeout" || this.#clock.now().getTime() >= deadline) {
        return {
          state: "timeout",
          completed: null,
          pendingTurnIds: [...input.turnIds].sort(compareText),
        };
      }
      await this.#sleepUntilPoll(deadline, signal);
    }
  }

  async waitAll(
    inputValue: unknown,
    signal?: AbortSignal,
  ): Promise<PersistentActorWaitAllResult> {
    const input = parseWaitInput(inputValue);
    const deadline = this.#deadline(input.callerActorId, input.timeoutMs);
    input.turnIds.forEach((turnId) => {
      this.#requireControlledTurn(input.callerActorId, turnId);
    });
    while (true) {
      this.#throwIfAborted(signal);
      const liveness = this.#clock.now().getTime() >= deadline
        ? "timeout"
        : await this.#awaitLivenessUntil(input.turnIds, deadline, signal);
      const views = input.turnIds.map((turnId) => this.#turnView(
        this.#requireControlledTurn(input.callerActorId, turnId),
      ));
      const completed = sortTerminalViews(views.filter(isTerminalTurnView));
      const pendingTurnIds = views.filter((view) => !isTerminalTurnView(view))
        .map((view) => view.turn.id).sort(compareText);
      if (pendingTurnIds.length === 0) {
        return { state: "terminal", completed, pendingTurnIds: [] };
      }
      if (liveness === "timeout" || this.#clock.now().getTime() >= deadline) {
        return { state: "timeout", completed, pendingTurnIds };
      }
      await this.#sleepUntilPoll(deadline, signal);
    }
  }

  async cancel(inputValue: unknown): Promise<PersistentActorTurnView> {
    const input = turnTargetSchema.parse(inputValue);
    let turn = this.#requireControlledTurn(input.callerActorId, input.turnId);
    if (isTerminalActorTurnState(turn.state)) return this.#turnView(turn);
    if (turn.desiredState !== "stop") {
      turn = this.#authority.requestActorTurnStop({
        turnId: turn.id,
        expectedRevision: turn.revision,
      });
    }
    if (turn.state === "prepared") {
      const result = this.#authority.settleActorResult({
        resultId: resultId(turn.id),
        turnId: turn.id,
        terminalAttemptId: null,
        outcome: "cancelled",
        valueId: null,
        expectedTurnRevision: turn.revision,
        outcomeCode: "cancelled_before_effect",
        createdAt: this.#timestamp(),
      });
      return { turn: this.#requireTurn(turn.id), result };
    }
    const attempt = this.#findUnsettledAttempt(turn.id);
    if (attempt === null || attempt.providerTurnId === null) {
      return this.#turnView(turn);
    }
    const incarnation = this.#requireIncarnation(attempt.incarnationId);
    this.#assertActorSessionReady(incarnation);
    if (incarnation.providerThreadId === null) {
      throw new PersistentActorError("invalid_state", "turn incarnation lacks provider identity");
    }
    const request = this.#interruptRequest(turn, attempt, incarnation);
    const operation = this.#prepareOperation({
      id: interruptOperationId(turn.id, incarnation.id),
      actorId: turn.actorId,
      turnId: turn.id,
      kind: "turnInterrupt",
      request,
    });
    await this.#driveInterrupt(operation, request, attempt, turn, false);
    return this.#turnView(this.#requireTurn(turn.id));
  }

  /**
   * Makes an actor safe to settle without conflating durable stop intent with
   * terminal actor state. This phase is deliberately replayable: it persists
   * intent, requests cancellation, requires terminal turn evidence, and closes
   * the proven-idle incarnation, but it never marks the actor stopped.
   */
  async quiesceActorForStop(inputValue: unknown): Promise<Actor> {
    const input = actorTargetSchema.parse(inputValue);
    let actor = this.#requireControlledActor(input.callerActorId, input.actorId);
    if (actor.state === "stopped") {
      throw new PersistentActorError(
        "invalid_state",
        "stopped actor is already past the quiescence boundary",
      );
    }
    if (actor.state === "quarantined") {
      throw new PersistentActorError(
        "ambiguous_effect",
        "quarantined actor cannot be reported as cleanly stopped",
      );
    }
    this.#assertNoLiveDescendants(actor);
    if (actor.state === "active") {
      actor = this.#authority.requestActorStop({
        actorId: actor.id,
        expectedRevision: actor.revision,
        now: this.#timestamp(),
      });
    }
    // The intent closes descendant admission. Repeat the bounded walk after
    // the CAS so a child that raced the first read keeps this actor quiescing
    // instead of allowing premature settlement.
    this.#assertNoLiveDescendants(actor);
    const liveTurns = this.#readActorReconciliation(actor.id).turns
      .toSorted(compareTurns);
    for (const turn of liveTurns) {
      await this.cancel({ callerActorId: input.callerActorId, turnId: turn.id });
    }
    const exactRecovery = this.#readActorReconciliation(actor.id);
    const stillLive = exactRecovery.turns;
    if (stillLive.length > 0) {
      const current = this.#requireActor(actor.id);
      if (current.state === "quarantined") {
        throw new PersistentActorError(
          "ambiguous_effect",
          "actor stop encountered an ambiguous provider effect",
        );
      }
      throw new PersistentActorError(
        "provider_pending",
        "actor stop is awaiting terminal proof for every live turn",
      );
    }
    const recoverable = exactRecovery.operations;
    if (recoverable.some(({ state }) => state === "ambiguous" || state === "recoveryRequired")) {
      this.#fenceActor(actor.id);
      throw new PersistentActorError(
        "ambiguous_effect",
        "actor stop encountered an unreconciled provider mutation",
      );
    }
    if (recoverable.length > 0) {
      throw new PersistentActorError(
        "provider_pending",
        "actor stop is awaiting provider mutation reconciliation",
      );
    }
    const incarnation = this.#authority.readActiveIncarnationForActor(actor.id);
    if (incarnation?.state === "starting" || incarnation?.state === "running") {
      throw new PersistentActorError(
        "provider_pending",
        "actor incarnation is not proven idle",
      );
    }
    if (incarnation?.state === "idle") this.#closeIncarnation(incarnation);
    actor = this.#requireActor(actor.id);
    if (actor.state !== "stopRequested") {
      throw new PersistentActorError("invalid_state", "actor lost its durable stop intent");
    }
    return actor;
  }

  async stopActor(inputValue: unknown): Promise<Actor> {
    const input = actorTargetSchema.parse(inputValue);
    const current = this.#requireControlledActor(input.callerActorId, input.actorId);
    if (current.state === "stopped") return current;
    const actor = await this.quiesceActorForStop(input);
    return this.#authority.settleActorStop({
      actorId: actor.id,
      expectedRevision: actor.revision,
      nextState: "stopped",
      now: this.#timestamp(),
    });
  }

  async observeTerminal(inputValue: unknown): Promise<PersistentActorTurnView> {
    const event = persistentActorTerminalObservationSchema.parse(inputValue);
    const observation = this.#authority.resolveActorAttemptObservation({
      accountProfileId: event.accountProfileId,
      observationGeneration: event.processGeneration,
      providerThreadId: event.providerThreadId,
      providerTurnId: event.providerTurnId,
    });
    if (observation === null) {
      throw new PersistentActorError("not_found", "provider turn is not owned by a durable actor attempt");
    }
    return await this.#settleObservation(observation, event);
  }

  /**
   * Boot barrier for actor thread admissions. It may reconcile a previously
   * started thread and materialize its durable incarnation/session binding,
   * but it cannot create an attempt or start an actor turn.
   */
  async reconcileSessionAdmissions(inputValue: unknown = {}): Promise<Readonly<{
    inspectedOperations: number;
    pending: number;
    fenced: number;
  }>> {
    const input = z.object({ limit: z.number().int().min(1).max(4_096).default(4_096) })
      .strict().parse(inputValue);
    const operations = this.#listRecoverableOperations(input.limit + 1);
    if (operations.length > input.limit) {
      throw new PersistentActorError(
        "conflict",
        "actor session admission recovery exceeds its boot-time bound",
      );
    }
    let inspectedOperations = 0;
    let pending = 0;
    let fenced = 0;
    for (const operation of operations) {
      if (operation.kind !== "actorStart") continue;
      inspectedOperations += 1;
      const disposition = await this.#reconcileThreadAdmission(operation);
      if (disposition === "pending") pending += 1;
      if (disposition === "fenced") fenced += 1;
    }
    return Object.freeze({ inspectedOperations, pending, fenced });
  }

  /**
   * Reconciles only the capacity consequence of ambiguous Fast effects. The
   * turn, attempt, actor, incarnation, and provider operation remain fenced.
   * A slot moves only on a definitive strict-successor observation proof.
   */
  async reconcileQuarantinedFastCapacity(
    inputValue: unknown = {},
  ): Promise<Readonly<{
    inspected: number;
    released: number;
    consumed: number;
    held: number;
  }>> {
    const input = z.object({
      limit: z.number().int().min(1).max(4_096).default(512),
    }).strict().parse(inputValue);
    const reservations = this.#listQuarantinedFastReservationsForAudit(
      input.limit,
    );
    let released = 0;
    let consumed = 0;
    let held = 0;
    for (const reservation of reservations) {
      this.#authority.containAmbiguousActorTurn({
        attemptId: reservation.attemptId,
        now: this.#timestamp(),
      });
      const request = this.#quarantinedFastCapacityRequest(reservation);
      let rawOutcome: unknown;
      try {
        rawOutcome = await this.#provider.reconcileQuarantinedFastCapacity(
          request,
        );
      } catch {
        held += 1;
        continue;
      }
      const outcome = persistentActorFastCapacityReconciliationOutcomeSchema
        .parse(rawOutcome);
      if (outcome.kind === "held") {
        held += 1;
        continue;
      }
      if (outcome.successorGeneration <= request.processGeneration) {
        throw new PersistentActorError(
          "conflict",
          "Fast capacity settlement lacks a strict successor generation",
        );
      }
      this.#authority.settleActorFastReservation({
        reservationId: reservation.id,
        attemptId: reservation.attemptId,
        expectedState: "quarantined",
        nextState: outcome.kind === "releasable" ? "released" : "consumed",
        reason: outcome.kind === "releasable"
          ? "generationFenced"
          : "providerTerminal",
        fenceEvidenceDigest: outcome.proof.digest,
        fencedGeneration: outcome.successorGeneration,
        now: this.#timestamp(),
      });
      if (outcome.kind === "releasable") released += 1;
      else consumed += 1;
    }
    return Object.freeze({
      inspected: reservations.length,
      released,
      consumed,
      held,
    });
  }

  async reconcile(inputValue: unknown = {}): Promise<Readonly<{
    inspectedOperations: number;
    inspectedAttempts: number;
    inspectedTurns: number;
    pending: number;
    fenced: number;
  }>> {
    const input = actorReconciliationRequestSchema.parse({
      limit: 512,
      ...(typeof inputValue === "object" && inputValue !== null
        ? inputValue : {}),
    });
    for (const record of this.#listActorModelReroutesForAudit(input.limit)) {
      this.#containActorModelRerouteRecord(record);
    }
    const selection = actorReconciliationSelection(input);
    const targeted = selection.targeted
      ? this.#readTargetedReconciliation(input)
      : null;
    if (!selection.targeted) {
      await this.reconcileQuarantinedFastCapacity({ limit: input.limit });
    }
    let pending = 0;
    let fenced = 0;
    let inspectedOperations = 0;
    const operations = targeted?.operations ??
      this.#listRecoverableOperationsForAudit(input.limit);
    for (const operation of operations) {
      if (operation.kind !== "actorStart") continue;
      const incarnation = this.#authority.readActorIncarnation(
        incarnationIdFor(operation.id),
      );
      if (!selection.includesOperation(operation, incarnation)) continue;
      const operationActor = this.#requireActor(operation.actorId);
      if (
        operationActor.state === "quarantined" ||
        operationActor.state === "stopped"
      ) {
        inspectedOperations += 1;
        fenced += 1;
        continue;
      }
      const liveTurns = this.#readActorReconciliation(operation.actorId).turns;
      if (liveTurns.length > 1) {
        throw new PersistentActorError(
          "conflict",
          "actor-start recovery found multiple live logical turns",
        );
      }
      const liveTurn = liveTurns[0];
      if (
        liveTurn !== undefined &&
        this.#settleLegacyQuotaLineageBeforeProvider(liveTurn, operation) !== "none"
      ) {
        // Actor-start operations have no turn_id, so they are audited before
        // turn attempts. Retired continuation rows must be contained here,
        // before session readiness or provider thread reconciliation.
        inspectedOperations += 1;
        fenced += 1;
        continue;
      }
      if (
        incarnation !== null &&
        !this.#sessionReadiness.isActorSessionReady(incarnation.id)
      ) {
        continue;
      }
      inspectedOperations += 1;
      const disposition = await this.#reconcileThreadAdmission(operation);
      if (disposition === "pending") pending += 1;
      if (disposition === "fenced") fenced += 1;
    }

    let inspectedAttempts = 0;
    const attempts = targeted?.attempts ??
      this.#listUnsettledAttemptsForAudit(input.limit);
    for (const attempt of attempts) {
      const turn = this.#requireTurn(attempt.turnId);
      const incarnation = this.#requireIncarnation(attempt.incarnationId);
      if (!selection.includesAttempt(attempt, turn, incarnation)) continue;
      const earlierQuotaRejection = this.#listAttemptsForTurn(turn.id).some(
        (candidate) =>
          candidate.ordinal < attempt.ordinal &&
          candidate.state === "quotaRejected",
      );
      if (earlierQuotaRejection) {
        // A prerelease database may contain a replacement that was claimed or
        // started by the retired quota-continuation path. Contain a provably
        // pre-effect replacement, or expose a possibly-started effect as
        // ambiguous, before session readiness or any provider reconciliation.
        inspectedAttempts += 1;
        try {
          this.#containInvalidQuotaContinuationSource(turn);
        } catch {
          this.#fenceAmbiguousTurn(
            turn,
            attempt,
            incarnation,
            recoveryProof(),
          );
          fenced += 1;
        }
        continue;
      }
      if (incarnation.state === "quarantined" || incarnation.state === "closed") {
        inspectedAttempts += 1;
        this.#fenceAmbiguousTurn(
          turn,
          attempt,
          incarnation,
          recoveryProof(),
        );
        fenced += 1;
        continue;
      }
      if (!this.#sessionReadiness.isActorSessionReady(incarnation.id)) {
        continue;
      }
      inspectedAttempts += 1;
      if (attempt.providerTurnId === null) {
        // Re-enter the same pre-dispatch path used by a live claim. In
        // particular, do not reconstruct the continuation request here: its
        // source may have become invalid after the attempt claim and before a
        // crash. #driveExistingAttempt validates that source first and owns the
        // one atomic containment transition for a still-pre-effect replacement.
        try {
          await this.#driveExistingAttempt(turn, attempt, incarnation);
        } catch (error: unknown) {
          if (
            error instanceof PersistentActorError &&
            error.code === "provider_pending"
          ) {
            pending += 1;
          } else {
            throw error;
          }
        }
        continue;
      }
      let currentAttempt = attempt;
      let currentTurn = turn;
      const turnOperation = this.#requireOperation(
        turnOperationId(currentTurn.id, incarnation.id),
      );
      if (
        turnOperation.state === "ambiguous" ||
        turnOperation.state === "recoveryRequired"
      ) {
        this.#fenceAmbiguousTurn(
          currentTurn,
          currentAttempt,
          incarnation,
          recoveryProof(),
        );
        fenced += 1;
        continue;
      }
      if (
        (turnOperation.state === "succeeded" ||
          turnOperation.state === "notApplied") &&
        (currentAttempt.state !== "running" || currentTurn.state !== "running")
      ) {
        await this.#driveExistingAttempt(
          currentTurn,
          currentAttempt,
          incarnation,
        );
        currentAttempt = this.#requireAttempt(currentAttempt.id);
        currentTurn = this.#requireTurn(currentTurn.id);
        if (
          isTerminalActorAttemptState(currentAttempt.state) ||
          isTerminalActorTurnState(currentTurn.state)
        ) continue;
      }
      if (currentTurn.desiredState === "stop") {
        const interruptId = interruptOperationId(currentTurn.id, incarnation.id);
        const interruptRequest = this.#interruptRequest(
          currentTurn,
          currentAttempt,
          incarnation,
        );
        const interruptOperation = this.#prepareOperation({
          id: interruptId,
          actorId: currentTurn.actorId,
          turnId: currentTurn.id,
          kind: "turnInterrupt",
          request: interruptRequest,
        });
        if (interruptOperation.state === "prepared" ||
          interruptOperation.state === "effectStarted") {
          await this.#driveInterrupt(
            interruptOperation,
            interruptRequest,
            currentAttempt,
            currentTurn,
            false,
          );
          currentAttempt = this.#requireAttempt(currentAttempt.id);
          currentTurn = this.#requireTurn(currentTurn.id);
          if (
            isTerminalActorAttemptState(currentAttempt.state) ||
            isTerminalActorTurnState(currentTurn.state)
          ) continue;
        } else if (interruptOperation.state === "ambiguous" ||
          interruptOperation.state === "recoveryRequired") {
          this.#fenceAmbiguousTurn(
            currentTurn,
            currentAttempt,
            incarnation,
            recoveryProof(),
          );
          fenced += 1;
          continue;
        }
      }
      let request: PersistentActorTurnRequest;
      try {
        const currentRequest = this.#turnRequest(
          currentTurn,
          currentAttempt,
          incarnation,
        );
        const currentTurnOperation = this.#requireOperation(
          turnOperationId(currentTurn.id, incarnation.id),
        );
        request = this.#turnRequestForOperation(
          currentTurnOperation,
          currentRequest,
        );
      } catch {
        // A provider turn identity proves this effect may already be running.
        // If its exact request or quota-source lineage can no longer be
        // reconstructed, recovery must expose that uncertainty and quarantine
        // the whole live lineage. Pre-effect quota containment would hide a
        // possibly-started provider effect.
        this.#fenceAmbiguousTurn(
          currentTurn,
          currentAttempt,
          incarnation,
          recoveryProof(),
        );
        fenced += 1;
        continue;
      }
      const providerTurnId = currentAttempt.providerTurnId;
      if (providerTurnId === null) {
        throw new PersistentActorError(
          "invalid_state",
          "reconciled turn attempt lost its provider identity",
        );
      }
      const observed = await this.#provider.observeTurn({
        ...request,
        providerTurnId,
      });
      if (isTerminalObservation(observed)) {
        await this.#settleObservation(
          currentAttempt,
          persistentActorTerminalObservationSchema.parse(observed),
        );
      } else {
        const outcome = persistentActorTurnOutcomeSchema.parse(observed);
        if (outcome.kind === "ambiguous") {
          this.#fenceAmbiguousTurn(currentTurn, currentAttempt, incarnation, outcome.proof);
          fenced += 1;
        } else {
          pending += 1;
        }
      }
    }

    let inspectedTurns = 0;
    const turns = targeted?.turns ?? this.#listLiveTurnsForAudit(input.limit);
    for (const selectedTurn of turns) {
      const turn = this.#requireTurn(selectedTurn.id);
      if (isTerminalActorTurnState(turn.state)) continue;
      const actor = this.#requireActor(turn.actorId);
      // A depth-zero actor is the durable shadow of an ordinary chat pane.
      // ChatService owns its provider turn and RootSessionLifecycle owns its
      // settlement. The nested-actor reconciler must never create a second
      // Codex thread or turn for that root after restart.
      if (actor.parentActorId === null) {
        if (!selection.includesTurn(turn, null, null)) continue;
        inspectedTurns += 1;
        continue;
      }
      const unsettledAttempt = this.#findUnsettledAttempt(turn.id);
      const activeIncarnation = this.#authority.readActiveIncarnationForActor(
        actor.id,
      );
      if (!selection.includesTurn(turn, unsettledAttempt, activeIncarnation)) {
        continue;
      }
      const quotaDisposition = this.#settleLegacyQuotaLineageBeforeProvider(turn);
      if (quotaDisposition !== "none") {
        inspectedTurns += 1;
        if (quotaDisposition === "fenced") fenced += 1;
        continue;
      }
      if (
        unsettledAttempt !== null &&
        !this.#sessionReadiness.isActorSessionReady(
          unsettledAttempt.incarnationId,
        )
      ) {
        continue;
      }
      if (
        activeIncarnation !== null &&
        !this.#sessionReadiness.isActorSessionReady(activeIncarnation.id)
      ) {
        continue;
      }
      inspectedTurns += 1;
      if (turn.state !== "prepared" && unsettledAttempt !== null) {
        continue;
      }
      const epoch = this.#requireEpoch(actor.epochId);
      const lease = await this.#acquireWorkspace(epoch, actor);
      try {
        await this.#driveTurn(turn, lease.laneId);
      } catch (error: unknown) {
        if (error instanceof PersistentActorError &&
          (error.code === "provider_pending" || error.code === "actor_busy")) {
          pending += 1;
          continue;
        }
        if (
          error instanceof PersistentActorError &&
          error.code === "account_exhausted" &&
          this.#settleDurableQuotaExhaustion(turn)
        ) {
          continue;
        }
        throw error;
      }
    }
    return { inspectedOperations, inspectedAttempts, inspectedTurns, pending, fenced };
  }

  /**
   * Deadline work is deliberately durable before it is interrupting: each
   * expired live turn gains stop intent, then normal reconciliation owns the
   * one idempotent interrupt receipt and terminal observation.
   */
  sweepDeadlines(inputValue: unknown = {}): Promise<Readonly<{
    expired: number;
  }>> {
    try {
      const input = z.object({ limit: z.number().int().min(1).max(4_096).default(512) })
        .strict().parse(inputValue);
      let expired = 0;
      for (const turn of this.#listLiveTurnsForDeadlineAudit(input.limit)) {
        const actor = this.#requireActor(turn.actorId);
        if (this.#clock.now().getTime() < Date.parse(actor.budget.deadline)) continue;
        try {
          this.#assertActorBeforeDeadline(actor, turn);
        } catch (error: unknown) {
          if (!(error instanceof PersistentActorError) || error.code !== "timeout") throw error;
          expired += 1;
        }
      }
      return Promise.resolve(Object.freeze({ expired }));
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error
        ? error
        : new Error("Persistent actor deadline sweep failed.", { cause: error }));
    }
  }

  async #createAndDriveTurn(input: Readonly<{
    callerActorId: string;
    actor: Actor;
    idempotencyKey: string;
    inputValueId: string;
    acceleration: ActorTurnAcceleration;
  }>): Promise<PersistentActorTurnView> {
    const turnId = deriveOpaqueId("hturn", "turn", [
      input.actor.epochId,
      input.actor.id,
      input.idempotencyKey,
    ]);
    const preparedInput = z.object({ valueId: valueIdSchema }).strict().parse(
      await this.#values.prepareActorInput({
        epochId: input.actor.epochId,
        callerActorId: input.callerActorId,
        targetActorId: input.actor.id,
        turnId,
        sourceValueId: input.inputValueId,
      }),
    );
    const turn = this.#authority.createActorTurn({
      turnId,
      epochId: input.actor.epochId,
      actorId: input.actor.id,
      idempotencyKey: input.idempotencyKey,
      inputValueId: preparedInput.valueId,
      acceleration: input.acceleration,
      createdAt: this.#timestamp(),
    });
    // A workspace acquisition can create or recover an external Git lane. Do
    // not cross that boundary until the exact encrypted input and logical turn
    // are durable, so any later failure is a recoverable turn rather than an
    // invisible child with an unreleasable workspace binding.
    const epoch = this.#requireEpoch(input.actor.epochId);
    const lease = await this.#acquireWorkspace(epoch, input.actor);
    await this.#driveTurn(turn, lease.laneId);
    return this.#turnView(this.#requireTurn(turn.id));
  }

  async #driveTurn(
    turnValue: ActorTurn,
    workspaceLaneId: string,
  ): Promise<void> {
    let turn = this.#requireTurn(turnValue.id);
    if (isTerminalActorTurnState(turn.state)) return;
    if (this.#settleLegacyQuotaLineageBeforeProvider(turn) !== "none") return;
    if (turn.desiredState === "stop") {
      if (turn.state === "prepared") {
        this.#settlePreparedCancellation(turn, "cancelled_before_effect");
      }
      return;
    }
    const actor = this.#requireActor(turn.actorId);
    this.#assertActorBeforeDeadline(actor, turn);
    this.#assertActorTokenCapacity(actor);
    let incarnation = this.#authority.readActiveIncarnationForActor(actor.id);
    if (incarnation === null || incarnation.state === "starting") {
      incarnation = await this.#launchIncarnation(
        actor,
        turn,
        workspaceLaneId,
      );
      if (incarnation === null) {
        if (isTerminalActorTurnState(this.#requireTurn(turn.id).state)) return;
        throw new PersistentActorError(
          "provider_pending",
          "actor incarnation start is awaiting durable reconciliation",
        );
      }
    }
    this.#assertActorSessionReady(incarnation);
    turn = this.#requireTurn(turn.id);
    if (isTerminalActorTurnState(turn.state)) return;
    if (turn.desiredState === "stop") {
      if (this.#findUnsettledAttempt(turn.id) === null) {
        this.#settleEffectFreeTurn(
          turn,
          "cancelled_after_actor_start_before_turn_effect",
        );
      }
      return;
    }
    if (await this.#recoverTerminalAttempt(turn, incarnation)) return;
    if (incarnation.state === "running") {
      let ownedAttempt = this.#findUnsettledAttempt(turn.id);
      if (ownedAttempt === null && turn.state === "starting") {
        ownedAttempt = this.#authority.claimActorAttempt({
          attemptId: attemptId(turn.id, incarnation.id),
          turnId: turn.id,
          incarnationId: incarnation.id,
          accountProfileId: incarnation.accountProfileId,
          processGeneration: incarnation.processGeneration,
          clientUserMessageId: clientMessageId(turn.id, incarnation.id),
          dispatch: this.#attemptDispatch(turn, incarnation),
          createdAt: this.#timestamp(),
        }).attempt;
      }
      if (ownedAttempt === null || ownedAttempt.incarnationId !== incarnation.id) {
        if (turn.state === "prepared") {
          this.#settlePreparedCancellation(turn, "actor_busy");
        }
        throw new PersistentActorError(
          "actor_busy",
          "actor incarnation is not proven idle for this logical turn",
        );
      }
      await this.#driveExistingAttempt(turn, ownedAttempt, incarnation);
      return;
    }
    if (incarnation.state !== "idle") {
      throw new PersistentActorError(
        "invalid_state",
        "actor has no usable idle incarnation",
      );
    }
    if (turn.state === "running") {
      throw new PersistentActorError(
        "invalid_state",
        "running logical turn is missing its durable attempt",
      );
    }
    if (turn.state === "prepared") turn = this.#transitionTurn(turn, "starting");
    let attempt: PersistedActorAttempt;
    try {
      const claimed = this.#authority.claimActorAttempt({
        attemptId: attemptId(turn.id, incarnation.id),
        turnId: turn.id,
        incarnationId: incarnation.id,
        accountProfileId: incarnation.accountProfileId,
        processGeneration: incarnation.processGeneration,
        clientUserMessageId: clientMessageId(turn.id, incarnation.id),
        dispatch: this.#attemptDispatch(turn, incarnation),
        createdAt: this.#timestamp(),
      });
      incarnation = claimed.incarnation;
      attempt = claimed.attempt;
    } catch (cause: unknown) {
      const raced = this.#authority.readActiveIncarnationForActor(actor.id);
      const ownedAttempt = this.#findUnsettledAttempt(turn.id);
      if (
        raced?.state === "running" && ownedAttempt !== null &&
        ownedAttempt.incarnationId === raced.id
      ) {
        await this.#driveExistingAttempt(turn, ownedAttempt, raced);
        return;
      }
      if (!isTerminalActorTurnState(this.#requireTurn(turn.id).state)) {
        const current = this.#requireTurn(turn.id);
        if (current.state === "starting") {
          this.#transitionTurn(current, "failed", "actor_busy");
        }
      }
      throw new PersistentActorError(
        "actor_busy",
        "actor idle claim raced another logical turn",
        cause,
      );
    }
    await this.#driveExistingAttempt(turn, attempt, incarnation);
  }

  async #recoverTerminalAttempt(
    turn: ActorTurn,
    incarnation: ActorIncarnationRecord,
  ): Promise<boolean> {
    const attempt = this.#authority.readActorAttempt(attemptId(turn.id, incarnation.id));
    if (attempt === null || !isTerminalActorAttemptState(attempt.state)) return false;
    const operation = this.#authority.readActorOperation(
      turnOperationId(turn.id, incarnation.id),
    );
    if (attempt.state === "ambiguous") {
      this.#fenceAmbiguousTurn(turn, attempt, incarnation, recoveryProof());
      return true;
    }
    if (operation?.state === "notApplied") {
      const envelope = parseStoredTurnEnvelope(operation.providerIdentityJson);
      await this.#applyTurnOutcome(operation, envelope.request, attempt, turn, envelope.outcome);
      return true;
    }
    if (attempt.state === "quotaRejected") {
      this.#resumeQuotaContinuation(turn, attempt, incarnation);
      return true;
    }
    if (attempt.providerTurnId === null) {
      throw new PersistentActorError(
        "invalid_state",
        "terminal applied attempt lacks its provider turn identity",
      );
    }
    const currentRequest = this.#turnRequest(turn, attempt, incarnation);
    const turnOperation = this.#requireOperation(
      turnOperationId(turn.id, incarnation.id),
    );
    const request = this.#turnRequestForOperation(
      turnOperation,
      currentRequest,
    );
    const observed = await this.#provider.observeTurn({
      ...request,
      providerTurnId: attempt.providerTurnId,
    });
    if (isTerminalObservation(observed)) {
      await this.#settleObservation(
        attempt,
        persistentActorTerminalObservationSchema.parse(observed),
      );
    } else {
      const outcome = persistentActorTurnOutcomeSchema.parse(observed);
      if (outcome.kind === "ambiguous") {
        this.#fenceAmbiguousTurn(turn, attempt, incarnation, outcome.proof);
      }
    }
    return true;
  }

  /**
   * Converges a legacy quota-rejected attempt after any crash cut. Recovery
   * consumes only durable evidence: it never captures history, selects another
   * subscription, or creates/reconciles a replacement provider effect.
   */
  #resumeQuotaContinuation(
    turnValue: ActorTurn,
    attemptValue: PersistedActorAttempt,
    incarnationValue: ActorIncarnationRecord,
  ): void {
    let turn = this.#requireTurn(turnValue.id);
    const attempt = this.#requireAttempt(attemptValue.id);
    const incarnation = this.#requireIncarnation(incarnationValue.id);
    const existingResult = this.#authority.readActorResult(resultId(turn.id));
    if (existingResult !== null) return;
    if (
      attempt.state !== "quotaRejected" || attempt.turnId !== turn.id ||
      attempt.incarnationId !== incarnation.id ||
      attempt.quotaProofDigest === null
    ) {
      throw new PersistentActorError(
        "conflict",
        "quota continuation recovery lost its terminal source evidence",
      );
    }
    turn = this.#markTurnReconciling(turn);
    this.#closeIncarnation(incarnation);
    if (!this.#settleDurableQuotaExhaustion(turn)) {
      throw new PersistentActorError(
        "conflict",
        "legacy quota rejection did not terminalize its logical turn",
      );
    }
  }

  async #driveExistingAttempt(
    turnValue: ActorTurn,
    attemptValue: PersistedActorAttempt,
    incarnation: ActorIncarnationRecord,
  ): Promise<void> {
    const turn = this.#requireTurn(turnValue.id);
    let attempt = this.#requireAttempt(attemptValue.id);
    const priorQuotaAttempt = this.#listAttemptsForTurn(turn.id).find(
      (candidate) =>
        candidate.ordinal < attempt.ordinal && candidate.state === "quotaRejected",
    );
    if (priorQuotaAttempt !== undefined) {
      // Old prerelease databases may contain a claimed replacement. Contain a
      // proven pre-effect replacement, or fence an effect that might already
      // exist. Neither branch calls the provider.
      try {
        this.#containInvalidQuotaContinuationSource(turn);
      } catch {
        this.#fenceAmbiguousTurn(turn, attempt, incarnation, recoveryProof());
      }
      return;
    }
    this.#assertActorSessionReady(incarnation);
    if (isTerminalActorAttemptState(attempt.state)) return;
    try {
      this.#quotaContinuationSourceForTurn(turn);
    } catch (cause: unknown) {
      this.#containInvalidQuotaContinuationSource(turn);
      throw new PersistentActorError(
        "ambiguous_effect",
        "quota continuation source failed exact pre-dispatch validation",
        cause,
      );
    }
    const durableOperation = this.#authority.readActorOperation(
      turnOperationId(turn.id, incarnation.id),
    );
    let effectAdmission = durableOperation === null ||
        durableOperation.state === "prepared"
      ? this.#turnEffectAdmission(turn, attempt, incarnation)
      : null;
    let request = effectAdmission?.request ??
      this.#turnRequest(turn, attempt, incarnation);
    let operation = this.#prepareOperation({
      id: turnOperationId(turn.id, incarnation.id),
      actorId: turn.actorId,
      turnId: turn.id,
      kind: "turnStart",
      request,
    });
    if (operation.state === "succeeded") {
      const envelope = parseStoredTurnEnvelope(operation.providerIdentityJson);
      if (envelope.outcome.kind !== "applied") {
        throw new PersistentActorError("invalid_state", "succeeded turn lacks applied proof");
      }
      await this.#markTurnApplied(
        attempt,
        turn,
        incarnation,
        envelope.outcome.providerTurnId,
      );
      return;
    }
    if (operation.state === "notApplied") {
      const envelope = parseStoredTurnEnvelope(operation.providerIdentityJson);
      await this.#applyTurnOutcome(
        operation,
        envelope.request,
        attempt,
        turn,
        envelope.outcome,
      );
      return;
    }
    if (operation.state === "ambiguous" || operation.state === "recoveryRequired") {
      this.#fenceAmbiguousTurn(turn, attempt, incarnation, recoveryProof());
      return;
    }
    let wonEffectStart = false;
    if (operation.state === "prepared") {
      if (!this.#allowsFreshProviderEffect(turn.actorId, request.toolsetDigest)) {
        operation = this.#tryTransitionOperation({
          operation,
          nextState: "recoveryRequired",
          providerIdentityJson: operation.providerIdentityJson ??
            storedThreadOrTurnEnvelope({ request }),
        }).operation;
        if (
          operation.state === "ambiguous" ||
          operation.state === "recoveryRequired"
        ) {
          this.#fenceAmbiguousTurn(
            turn,
            attempt,
            incarnation,
            recoveryProof(),
          );
          return;
        }
      } else {
        if (!this.#preflightTurnStartEffect(turn, attempt, incarnation, operation)) {
          return;
        }
        effectAdmission = this.#turnEffectAdmission(
          turn,
          attempt,
          incarnation,
        );
        request = effectAdmission.request;
        operation = this.#prepareOperation({
          id: operation.id,
          actorId: turn.actorId,
          turnId: turn.id,
          kind: "turnStart",
          request,
        });
        const started = this.#authority.startActorTurnEffect({
          operationId: operation.id,
          attemptId: attempt.id,
          expectedOperationRequestDigest: operation.requestDigest,
          expectedSessionRevision: effectAdmission.session.revision,
          effectGeneration: effectAdmission.session.liveGeneration,
          capabilityEvidenceDigest:
            effectAdmission.session.liveCapabilityEvidenceDigest,
          requestDigest: digestCanonical(request),
          effectKey: request.effectKey,
          providerIdentityJson: storedThreadOrTurnEnvelope({ request }),
          now: this.#timestamp(),
        });
        if (started.kind === "retryStandard") {
          await this.#driveExistingAttempt(
            turn,
            started.attempt,
            incarnation,
          );
          return;
        }
        operation = started.operation;
        attempt = started.attempt;
        wonEffectStart = started.changed;
      }
    }
    if (operation.state !== "effectStarted") {
      await this.#driveExistingAttempt(turn, attempt, incarnation);
      return;
    }
    let outcome: PersistentActorTurnOutcome;
    const providerRequest = this.#turnRequestForOperation(
      operation,
      this.#turnRequest(turn, attempt, incarnation),
    );
    try {
      outcome = persistentActorTurnOutcomeSchema.parse(
        await (wonEffectStart
          ? this.#provider.startTurn(providerRequest)
          : this.#provider.reconcileTurn(providerRequest)),
      );
    } catch {
      this.#markAttemptReconciling(attempt);
      this.#markTurnReconciling(turn);
      throw new PersistentActorError(
        "provider_pending",
        "turn start lost its response and requires reconciliation",
      );
    }
    const settled = await this.#applyTurnOutcome(
      operation,
      providerRequest,
      attempt,
      turn,
      outcome,
    );
    if (settled === null) {
      throw new PersistentActorError(
        "provider_pending",
        "turn start remains pending durable reconciliation",
      );
    }
  }

  async #launchIncarnation(
    actorValue: Actor,
    turnValue: ActorTurn,
    workspaceLaneId: string,
  ): Promise<ActorIncarnationRecord | null> {
    const actor = this.#requireActor(actorValue.id);
    const initiatingTurn = this.#requireTurn(turnValue.id);
    if (initiatingTurn.actorId !== actor.id) {
      throw new PersistentActorError(
        "conflict",
        "actor incarnation launch lost its initiating logical turn",
      );
    }
    const existing = this.#authority.readActiveIncarnationForActor(actor.id);
    if (existing !== null && existing.state !== "starting") return existing;
    if (existing?.state === "starting") {
      return await this.#driveStartingIncarnation({
        actor,
        initiatingTurn,
        incarnation: existing,
        workspaceLaneId,
      });
    }
    const eligibility = await this.#accountCandidates(actor);
    const candidates = eligibility.candidates;
    const temporarilyUnavailable = eligibility.temporarilyUnavailableAccountProfileIds;
    const unsupported = eligibility.unsupportedAccountProfileIds;
    if (candidates.length === 0) {
      if (temporarilyUnavailable.length > 0) {
        throw new PersistentActorError(
          "provider_pending",
          "unvisited subscriptions are awaiting exact-generation capability convergence",
        );
      }
      if (unsupported.length > 0) {
        this.#settleEffectFreeTurn(
          initiatingTurn,
          "capability_unavailable_before_actor_start",
        );
        return null;
      }
      if (!this.#settleDurableQuotaExhaustion(initiatingTurn)) {
        this.#settleEffectFreeTurn(
          initiatingTurn,
          "account_unavailable_before_actor_start",
        );
      }
      return null;
    }
    const operationId = actorStartSelectionOperationId(actor.id, candidates);
    const provisionalRequest = this.#threadRequest(
      actor,
      candidates[0]!,
      workspaceLaneId,
      operationId,
    );
    let operation = this.#prepareOperation({
      id: operationId,
      actorId: actor.id,
      turnId: null,
      kind: "actorStart",
      request: provisionalRequest,
    });
    if (operation.state !== "prepared") {
      const durableRequest = this.#threadRequestForOperation(operation);
      const durableIncarnation = this.#authority.readActorIncarnation(
        incarnationIdFor(operation.id),
      );
      if (durableIncarnation?.state === "starting") {
        return await this.#driveStartingIncarnation({
          actor,
          initiatingTurn,
          incarnation: durableIncarnation,
          workspaceLaneId,
        });
      }
      if (operation.state === "succeeded") {
        const envelope = parseStoredThreadEnvelope(operation.providerIdentityJson);
        if (envelope.outcome.kind !== "applied") {
          throw new PersistentActorError(
            "invalid_state",
            "succeeded actor start lacks applied proof",
          );
        }
        return this.#materializeIncarnation(
          operation,
          durableRequest,
          envelope.outcome,
        );
      }
      if (operation.state === "notApplied") {
        const envelope = parseStoredThreadEnvelope(operation.providerIdentityJson);
        if (!isDefinitiveQuota(envelope.outcome)) {
          throw new PersistentActorError(
            "account_exhausted",
            "actor start was definitively rejected for a non-quota reason",
          );
        }
        this.#settleEffectFreeQuotaTurn(
          initiatingTurn,
          "quota_rejected_before_actor_start",
          [operation.id],
        );
        return null;
      }
      this.#fenceActorStartRecovery(operation);
      throw new PersistentActorError(
        "ambiguous_effect",
        "actor start outcome is fenced and cannot fail over",
      );
    }

    const incarnationId = incarnationIdFor(operation.id);
    const leased = this.#authority.createActorIncarnationWithAccountLease({
      leaseId: accountLeaseIdFor(operation.id),
      incarnationId,
      actorId: actor.id,
      candidates: candidates.map((candidate) => {
        const candidateRequest = this.#threadRequest(
          actor,
          candidate,
          workspaceLaneId,
          operation.id,
        );
        return Object.freeze({
          accountProfileId: candidate.accountProfileId,
          processGeneration: candidate.processGeneration,
          profile: Object.freeze({
            modelId: candidate.modelId,
            reasoningEffort: candidate.reasoningEffort,
            profileFallbackReason: candidate.profileFallbackReason,
            capabilityEvidenceDigest: candidate.capabilityEvidenceDigest,
            supportsFast: candidate.supportsFast,
          }),
          routingPriority: candidate.routingPriority,
          operationRequest: Object.freeze({
            requestDigest: digestCanonical(candidateRequest),
            effectKey: candidateRequest.effectKey,
            providerIdentityJson: storedThreadOrTurnEnvelope({
              request: candidateRequest,
            }),
          }),
        });
      }),
      startOperationId: operation.id,
      clientRequestId: clientRequestId(operation.id),
      threadSource: provisionalRequest.threadSource,
      toolsetDigest: this.#toolsetDigest,
      createdAt: this.#timestamp(),
    });
    const selected = candidates.find((candidate) =>
      candidate.accountProfileId === leased.incarnation.accountProfileId &&
      candidate.processGeneration === leased.incarnation.processGeneration &&
      candidate.modelId === leased.incarnation.requestedModel &&
      candidate.reasoningEffort === leased.incarnation.requestedReasoningEffort
    );
    if (selected === undefined) {
      throw new PersistentActorError(
        "conflict",
        "atomic account lease selected a route outside its exact candidate set",
      );
    }
    const request = this.#threadRequest(
      actor,
      selected,
      workspaceLaneId,
      operation.id,
    );
    operation = this.#requireOperation(operation.id);
    if (
      operation.requestDigest !== digestCanonical(request) ||
      operation.providerIdentityJson !== storedThreadOrTurnEnvelope({ request })
    ) {
      throw new PersistentActorError(
        "conflict",
        "atomic actor route did not commit its exact provider request",
      );
    }
    return await this.#driveStartingIncarnation({
      actor,
      initiatingTurn,
      incarnation: leased.incarnation,
      workspaceLaneId,
    });
  }

  async #driveStartingIncarnation(input: Readonly<{
    actor: Actor;
    initiatingTurn: ActorTurn;
    incarnation: ActorIncarnationRecord;
    workspaceLaneId: string;
  }>): Promise<ActorIncarnationRecord | null> {
    let operation = this.#requireOperation(input.incarnation.startOperationId);
    const request = this.#threadRequestForOperation(operation);
    if (
      request.actorId !== input.actor.id ||
      request.accountProfileId !== input.incarnation.accountProfileId ||
      request.processGeneration !== input.incarnation.processGeneration ||
      request.modelId !== input.incarnation.requestedModel ||
      request.reasoningEffort !== input.incarnation.requestedReasoningEffort ||
      request.capabilityEvidenceDigest !==
        input.incarnation.capabilityEvidenceDigest
    ) {
      throw new PersistentActorError(
        "conflict",
        "starting incarnation changed its durable route request",
      );
    }
    if (operation.state === "succeeded") {
      const envelope = parseStoredThreadEnvelope(operation.providerIdentityJson);
      if (envelope.outcome.kind !== "applied") {
        throw new PersistentActorError(
          "invalid_state",
          "succeeded actor start lacks applied proof",
        );
      }
      return this.#materializeIncarnation(operation, request, envelope.outcome);
    }
    if (operation.state === "notApplied") {
      const envelope = parseStoredThreadEnvelope(operation.providerIdentityJson);
      this.#closeIncarnation(input.incarnation);
      if (!isDefinitiveQuota(envelope.outcome)) {
        throw new PersistentActorError(
          "account_exhausted",
          "actor start was definitively rejected for a non-quota reason",
        );
      }
      this.#settleEffectFreeQuotaTurn(
        input.initiatingTurn,
        "quota_rejected_before_actor_start",
        [operation.id],
      );
      return null;
    }
    if (operation.state === "ambiguous" || operation.state === "recoveryRequired") {
      this.#fenceActorStartRecovery(operation);
      throw new PersistentActorError(
        "ambiguous_effect",
        "actor start outcome is fenced and cannot fail over",
      );
    }
    let wonEffectStart = false;
    if (operation.state === "prepared") {
      if (!this.#allowsFreshProviderEffect(input.actor.id, request.toolsetDigest)) {
        operation = this.#tryTransitionOperation({
          operation,
          nextState: "recoveryRequired",
          providerIdentityJson: operation.providerIdentityJson ??
            storedThreadOrTurnEnvelope({ request }),
        }).operation;
        if (
          operation.state === "ambiguous" ||
          operation.state === "recoveryRequired"
        ) {
          this.#fenceActorStartRecovery(operation);
          throw new PersistentActorError(
            "ambiguous_effect",
            "predecessor actor start is fenced from fresh provider mutation",
          );
        }
      } else {
        if (!this.#preflightActorStartEffect(
          input.actor.id,
          input.initiatingTurn.id,
          operation,
        )) return null;
        const transitioned = this.#tryTransitionOperation({
          operation,
          nextState: "effectStarted",
          providerIdentityJson: storedThreadOrTurnEnvelope({ request }),
        });
        operation = transitioned.operation;
        wonEffectStart = transitioned.changed;
      }
    }
    if (operation.state !== "effectStarted") {
      return await this.#launchIncarnation(
        input.actor,
        input.initiatingTurn,
        input.workspaceLaneId,
      );
    }
    let outcome: PersistentActorThreadOutcome;
    try {
      outcome = persistentActorThreadOutcomeSchema.parse(
        await (wonEffectStart
          ? this.#provider.startThread(request)
          : this.#provider.reconcileThread(request)),
      );
    } catch {
      return null;
    }
    const incarnation = this.#applyThreadOutcome(operation, request, outcome);
    if (incarnation !== null) return incarnation;
    if (isDefinitiveQuota(outcome)) {
      this.#closeIncarnation(input.incarnation);
      this.#settleEffectFreeQuotaTurn(
        input.initiatingTurn,
        "quota_rejected_before_actor_start",
        [operation.id],
      );
      return null;
    }
    if (outcome.kind === "pending") return null;
    throw new PersistentActorError(
      "account_exhausted",
      "actor start did not produce a usable incarnation",
    );
  }

  async #reconcileThreadAdmission(
    operation: ActorOperationRecord,
  ): Promise<"materialized" | "pending" | "fenced"> {
    const actor = this.#requireActor(operation.actorId);
    const liveTurns = this.#readActorReconciliation(actor.id).turns;
    if (liveTurns.length > 1) {
      throw new PersistentActorError(
        "conflict",
        "actor-start recovery found multiple live logical turns",
      );
    }
    const liveTurn = liveTurns[0];
    if (
      liveTurn !== undefined &&
      this.#settleLegacyQuotaLineageBeforeProvider(liveTurn, operation) !== "none"
    ) return "fenced";
    if (actor.state === "quarantined" || actor.state === "stopped") {
      // Emergency ambiguity containment deliberately preserves immutable
      // provider receipts. A terminal actor is the durable no-replay fence;
      // recovery must not re-observe or restart its actor-start operation.
      return "fenced";
    }
    if (operation.state === "ambiguous" || operation.state === "recoveryRequired") {
      this.#fenceActorStartRecovery(operation);
      return "fenced";
    }
    if (operation.state === "prepared") {
      // No provider mutation was started. A later authorized actor request may
      // resume this durable plan; boot recovery must not launch it.
      return "pending";
    }
    const request = this.#threadRequestForOperation(operation);
    if (operation.state === "succeeded") {
      const stored = parseStoredThreadEnvelope(operation.providerIdentityJson);
      if (stored.outcome.kind !== "applied") {
        throw new PersistentActorError(
          "invalid_state",
          "succeeded actor start lacks applied session evidence",
        );
      }
      let recovered: PersistentActorThreadOutcome;
      try {
        recovered = persistentActorThreadOutcomeSchema.parse(
          await this.#provider.reconcileThread(request),
        );
      } catch {
        return "pending";
      }
      if (recovered.kind === "pending") return "pending";
      if (
        recovered.kind !== "applied" ||
        recovered.providerThreadId !== stored.outcome.providerThreadId
      ) {
        this.#fenceActorStartRecovery(operation);
        return "fenced";
      }
      this.#materializeIncarnation(operation, request, recovered);
      return "materialized";
    }
    if (operation.state !== "effectStarted") {
      throw new PersistentActorError(
        "invalid_state",
        "actor start recovery encountered an unsupported operation state",
      );
    }
    const outcome = persistentActorThreadOutcomeSchema.parse(
      await this.#provider.reconcileThread(request),
    );
    const result = this.#applyThreadOutcome(operation, request, outcome);
    return result === null ? "pending" : "materialized";
  }

  #applyThreadOutcome(
    operationValue: ActorOperationRecord,
    request: PersistentActorThreadRequest,
    outcome: PersistentActorThreadOutcome,
  ): ActorIncarnationRecord | null {
    let operation = this.#requireOperation(operationValue.id);
    const durableRequest = this.#threadRequestForOperation(operation);
    if (!sameOperationRequestLineage(durableRequest, request)) {
      throw new PersistentActorError(
        "conflict",
        "actor start outcome is not bound to its immutable durable request",
      );
    }
    if (operation.state === "succeeded") {
      const stored = parseStoredThreadEnvelope(operation.providerIdentityJson);
      if (stored.outcome.kind !== "applied") {
        throw new PersistentActorError("invalid_state", "actor start receipt is corrupt");
      }
      return this.#materializeIncarnation(operation, durableRequest, stored.outcome);
    }
    if (operation.state !== "effectStarted") {
      if (operation.state === "notApplied") return null;
      throw new PersistentActorError("invalid_state", "actor start receipt is not reconcilable");
    }
    if (outcome.kind === "pending") return null;
    if (outcome.kind === "ambiguous" ||
      (outcome.kind === "notApplied" && !isDefinitiveNotApplied(outcome))) {
      operation = this.#authority.transitionActorOperation({
        operationId: operation.id,
        expectedState: "effectStarted",
        nextState: "ambiguous",
        providerIdentityJson: storedThreadOrTurnEnvelope({ request, outcome }),
        now: this.#timestamp(),
      });
      this.#fenceActorStartRecovery(operation);
      throw new PersistentActorError(
        "ambiguous_effect",
        "actor start lacks definitive pre-effect non-application proof",
      );
    }
    if (outcome.kind === "notApplied") {
      this.#authority.transitionActorOperation({
        operationId: operation.id,
        expectedState: "effectStarted",
        nextState: "notApplied",
        providerIdentityJson: storedThreadOrTurnEnvelope({ request, outcome }),
        now: this.#timestamp(),
      });
      return null;
    }
    operation = this.#authority.transitionActorOperation({
      operationId: operation.id,
      expectedState: "effectStarted",
      nextState: "succeeded",
      providerIdentityJson: storedThreadOrTurnEnvelope({ request, outcome }),
      now: this.#timestamp(),
    });
    return this.#materializeIncarnation(operation, durableRequest, outcome);
  }

  #materializeIncarnation(
    operation: ActorOperationRecord,
    request: PersistentActorThreadRequest,
    outcome: Extract<PersistentActorThreadOutcome, { kind: "applied" }>,
  ): ActorIncarnationRecord {
    const liveCapabilityEvidence = outcome.liveCapabilityEvidence;
    const observationGeneration =
      outcome.sessionRecoveryProof.observationGeneration;
    const legacyPolicy = request.policyVersion === 0;
    const evidenceIsLegacy = liveCapabilityEvidence.evidenceDigest === null &&
      liveCapabilityEvidence.supportsFast === null;
    const evidenceIsCurrent =
      liveCapabilityEvidence.observationGeneration === observationGeneration &&
      observationGeneration >= request.processGeneration;
    const admissionEvidenceIsExact =
      legacyPolicy || observationGeneration !== request.processGeneration ||
      (liveCapabilityEvidence.evidenceDigest ===
          request.capabilityEvidenceDigest &&
        liveCapabilityEvidence.supportsFast === request.supportsFast);
    if (
      !evidenceIsCurrent ||
      legacyPolicy !== evidenceIsLegacy ||
      !admissionEvidenceIsExact
    ) {
      this.#fenceActorStartRecovery(operation);
      throw new PersistentActorError(
        "conflict",
        "actor start live capability evidence does not match its recovery generation",
      );
    }
    let incarnation = this.#authority.createActorIncarnation({
      incarnationId: incarnationIdFor(operation.id),
      actorId: request.actorId,
      accountProfileId: request.accountProfileId,
      processGeneration: request.processGeneration,
      startOperationId: operation.id,
      clientRequestId: request.clientRequestId,
      threadSource: request.threadSource,
      toolsetDigest: request.toolsetDigest,
      profile: {
        modelId: request.modelId,
        reasoningEffort: request.reasoningEffort,
        profileFallbackReason: request.profileFallbackReason,
        capabilityEvidenceDigest: request.capabilityEvidenceDigest,
        supportsFast: request.policyVersion === 0 ? null : request.supportsFast,
      },
      createdAt: operation.createdAt,
    });
    incarnation = this.#authority.recordActorIncarnationObservedProfile({
      incarnationId: incarnation.id,
      observedProfile: outcome.observedProfile,
      observedAt: this.#timestamp(),
    });
    if (incarnation.observedProfileState !== "exact") {
      this.#fenceActorStartRecovery(operation);
      throw new PersistentActorError(
        "conflict",
        "actor incarnation observed a provider execution-profile reroute",
      );
    }
    if (incarnation.state === "starting") {
      incarnation = this.#authority.transitionActorIncarnation({
        incarnationId: incarnation.id,
        expectedState: "starting",
        nextState: "idle",
        providerThreadId: outcome.providerThreadId,
        now: this.#timestamp(),
      });
    }
    const session = this.#authority.bindActorSession({
      incarnationId: incarnation.id,
      liveCapabilityEvidence,
      recoveryProof: outcome.sessionRecoveryProof,
      createdAt: this.#timestamp(),
    });
    if (
      session.incarnationId !== incarnation.id ||
      session.accountProfileId !== incarnation.accountProfileId ||
      session.admissionGeneration !== incarnation.processGeneration ||
      session.providerThreadId !== outcome.providerThreadId ||
      session.liveGeneration !==
        outcome.sessionRecoveryProof.observationGeneration ||
      session.liveCapabilityEvidenceDigest !==
        liveCapabilityEvidence.evidenceDigest ||
      session.liveSupportsFast !== liveCapabilityEvidence.supportsFast ||
      session.recoveryProof.recoveryProofDigest !==
        outcome.sessionRecoveryProof.recoveryProofDigest ||
      session.state !== "bound"
    ) {
      throw new PersistentActorError(
        "conflict",
        "actor incarnation session evidence changed during materialization",
      );
    }
    return incarnation;
  }

  async #applyTurnOutcome(
    operationValue: ActorOperationRecord,
    request: PersistentActorTurnRequest,
    attemptValue: PersistedActorAttempt,
    turnValue: ActorTurn,
    outcome: PersistentActorTurnOutcome,
  ): Promise<PersistentActorTurnView | null> {
    let operation = this.#requireOperation(operationValue.id);
    const durableRequest = parseStoredTurnRequestEnvelope(
      operation.providerIdentityJson,
    );
    if (
      operation.kind !== "turnStart" ||
      operation.requestDigest !== digestCanonical(durableRequest) ||
      !sameOperationRequestLineage(durableRequest, request) ||
      request.observationGeneration < durableRequest.processGeneration
    ) {
      throw new PersistentActorError(
        "conflict",
        "turn outcome is not bound to its immutable durable request",
      );
    }
    let attempt = this.#requireAttempt(attemptValue.id);
    let turn = this.#requireTurn(turnValue.id);
    const incarnation = this.#requireIncarnation(attempt.incarnationId);
    if (operation.state === "succeeded") {
      const stored = parseStoredTurnEnvelope(operation.providerIdentityJson);
      if (stored.outcome.kind !== "applied") {
        throw new PersistentActorError("invalid_state", "turn receipt is corrupt");
      }
      await this.#markTurnApplied(
        attempt,
        turn,
        incarnation,
        stored.outcome.providerTurnId,
      );
      return this.#turnView(this.#requireTurn(turn.id));
    }
    const operationAlreadyNotApplied = operation.state === "notApplied";
    if (!operationAlreadyNotApplied && operation.state !== "effectStarted") {
      throw new PersistentActorError("invalid_state", "turn receipt is not reconcilable");
    }
    if (outcome.kind === "pending") {
      this.#markAttemptReconciling(attempt);
      this.#markTurnReconciling(turn);
      return null;
    }
    if (outcome.kind === "ambiguous" ||
      (outcome.kind === "notApplied" && !isDefinitiveNotApplied(outcome))) {
      if (operationAlreadyNotApplied) {
        throw new PersistentActorError(
          "invalid_state",
          "non-definitive non-application was persisted as definitive",
        );
      }
      operation = this.#authority.transitionActorOperation({
        operationId: operation.id,
        expectedState: "effectStarted",
        nextState: "ambiguous",
        providerIdentityJson: storedThreadOrTurnEnvelope({
          request: durableRequest,
          outcome,
        }),
        now: this.#timestamp(),
      });
      this.#fenceAmbiguousTurn(turn, attempt, incarnation, outcome.proof);
      throw new PersistentActorError(
        "ambiguous_effect",
        "turn start lacks definitive non-application proof and is fenced",
      );
    }
    if (outcome.kind === "notApplied") {
      const notAppliedReason = outcome.reason;
      if (!operationAlreadyNotApplied) {
        operation = this.#authority.transitionActorOperation({
          operationId: operation.id,
          expectedState: "effectStarted",
          nextState: "notApplied",
          providerIdentityJson: storedThreadOrTurnEnvelope({
            request: durableRequest,
            outcome,
          }),
          now: this.#timestamp(),
        });
      }
      this.#releaseFastReservationAfterDefinitiveNonApplication(
        attempt,
        request,
        outcome.proof,
      );
      if (isDefinitiveQuota(outcome)) {
        attempt = this.#transitionAttempt(attempt, "quotaRejected", {
          quotaProofDigest: outcome.proof.digest,
        });
        turn = this.#markTurnReconciling(turn);
        this.#closeIncarnation(incarnation);
        if (!this.#settleDurableQuotaExhaustion(turn)) {
          throw new PersistentActorError(
            "conflict",
            "proven quota rejection did not terminalize its logical turn",
          );
        }
        return this.#turnView(this.#requireTurn(turn.id));
      }
      attempt = this.#transitionAttempt(attempt, "failed");
      this.#idleIncarnation(incarnation);
      const result = this.#authority.settleActorResult({
        resultId: resultId(turn.id),
        turnId: turn.id,
        terminalAttemptId: attempt.id,
        outcome: "failed",
        valueId: null,
        expectedTurnRevision: turn.revision,
        outcomeCode: `not_applied_${notAppliedReason}`,
        createdAt: this.#timestamp(),
      });
      return { turn: this.#requireTurn(turn.id), result };
    }
    operation = this.#authority.transitionActorOperation({
      operationId: operation.id,
      expectedState: "effectStarted",
      nextState: "succeeded",
      providerIdentityJson: storedThreadOrTurnEnvelope({
        request: durableRequest,
        outcome,
      }),
      now: this.#timestamp(),
    });
    await this.#markTurnApplied(
      attempt,
      turn,
      incarnation,
      outcome.providerTurnId,
    );
    return this.#turnView(this.#requireTurn(turn.id));
  }

  async #markTurnApplied(
    attemptValue: PersistedActorAttempt,
    turnValue: ActorTurn,
    incarnation: ActorIncarnationRecord,
    providerTurnId: string,
  ): Promise<void> {
    let attempt = this.#requireAttempt(attemptValue.id);
    let turn = this.#requireTurn(turnValue.id);
    if (attempt.state === "starting" || attempt.state === "reconciling") {
      if (attempt.providerTurnId === null) {
        attempt = await this.#authority.bindActorAttemptProviderTurn({
          attemptId: attempt.id,
          expectedState: attempt.state,
          providerTurnId,
        });
      }
      const reroute = this.#authority.readActorModelRerouteForAttempt(
        attempt.id,
      );
      if (reroute?.state === "pending") {
        throw new PersistentActorError(
          "conflict",
          "bound actor turn retained unbound model reroute evidence",
        );
      }
      if (reroute?.state === "bound" || reroute?.state === "quarantined") {
        this.#containActorModelRerouteRecord(reroute);
        return;
      }
      if (reroute?.state === "settled") {
        const containedAttempt = this.#requireAttempt(attempt.id);
        if (containedAttempt.state === "ambiguous") return;
        throw new PersistentActorError(
          "conflict",
          "settled actor model reroute lost its attempt fence",
        );
      }
      attempt = this.#transitionAttempt(attempt, "running", { providerTurnId });
    } else if (attempt.state === "running" && attempt.providerTurnId !== providerTurnId) {
      throw new PersistentActorError("conflict", "attempt provider turn identity changed");
    }
    if (turn.state === "starting" || turn.state === "reconciling") {
      turn = this.#transitionTurn(turn, "running");
    }
    if (turn.desiredState === "stop") {
      await this.cancel({ callerActorId: this.#requireActor(turn.actorId).parentActorId ?? turn.actorId, turnId: turn.id });
    }
    if (incarnation.state !== "running") {
      throw new PersistentActorError("invalid_state", "applied turn lost its running incarnation fence");
    }
  }

  async #driveInterrupt(
    operationValue: ActorOperationRecord,
    request: PersistentActorInterruptRequest,
    attemptValue: PersistedActorAttempt,
    turnValue: ActorTurn,
    reconcileOnly: boolean,
  ): Promise<void> {
    let operation = this.#requireOperation(operationValue.id);
    const attempt = this.#requireAttempt(attemptValue.id);
    const turn = this.#requireTurn(turnValue.id);
    if (operation.state === "succeeded" || operation.state === "notApplied") {
      this.#markAttemptReconciling(attempt);
      this.#markTurnReconciling(turn);
      return;
    }
    if (operation.state === "ambiguous" || operation.state === "recoveryRequired") {
      this.#fenceAmbiguousTurn(
        turn,
        attempt,
        this.#requireIncarnation(attempt.incarnationId),
        recoveryProof(),
      );
      return;
    }
    this.#assertActorSessionReady(
      this.#requireIncarnation(attempt.incarnationId),
    );
    let wonEffectStart = false;
    if (operation.state === "prepared") {
      const incarnation = this.#requireIncarnation(attempt.incarnationId);
      if (!this.#allowsFreshProviderEffect(turn.actorId, incarnation.toolsetDigest)) {
        operation = this.#tryTransitionOperation({
          operation,
          nextState: "recoveryRequired",
          providerIdentityJson: operation.providerIdentityJson ??
            storedThreadOrTurnEnvelope({ request }),
        }).operation;
        if (
          operation.state === "ambiguous" ||
          operation.state === "recoveryRequired"
        ) {
          this.#fenceAmbiguousTurn(
            turn,
            attempt,
            incarnation,
            recoveryProof(),
          );
          return;
        }
      } else {
        const transitioned = this.#tryTransitionOperation({
          operation,
          nextState: "effectStarted",
          providerIdentityJson: storedThreadOrTurnEnvelope({ request }),
        });
        operation = transitioned.operation;
        wonEffectStart = transitioned.changed;
      }
    }
    const providerRequest = wonEffectStart
      ? request
      : this.#interruptRequestForOperation(operation, request);
    const durableRequest = parseStoredInterruptRequestEnvelope(
      operation.providerIdentityJson,
    );
    let outcome: PersistentActorInterruptOutcome;
    try {
      outcome = persistentActorInterruptOutcomeSchema.parse(
        await (wonEffectStart && !reconcileOnly
          ? this.#provider.interruptTurn(providerRequest)
          : this.#provider.reconcileInterrupt(providerRequest)),
      );
    } catch {
      this.#markAttemptReconciling(attempt);
      this.#markTurnReconciling(turn);
      return;
    }
    if (outcome.kind === "pending") {
      this.#markAttemptReconciling(attempt);
      this.#markTurnReconciling(turn);
      return;
    }
    if (outcome.kind === "ambiguous") {
      this.#authority.transitionActorOperation({
        operationId: operation.id,
        expectedState: "effectStarted",
        nextState: "ambiguous",
        providerIdentityJson: storedThreadOrTurnEnvelope({
          request: durableRequest,
          outcome,
        }),
        now: this.#timestamp(),
      });
      this.#fenceAmbiguousTurn(
        turn,
        attempt,
        this.#requireIncarnation(attempt.incarnationId),
        outcome.proof,
      );
      return;
    }
    if (
      outcome.kind === "applied" &&
      outcome.providerTurnId !== durableRequest.providerTurnId
    ) {
      this.#authority.transitionActorOperation({
        operationId: operation.id,
        expectedState: "effectStarted",
        nextState: "ambiguous",
        providerIdentityJson: storedThreadOrTurnEnvelope({
          request: durableRequest,
          outcome,
        }),
        now: this.#timestamp(),
      });
      this.#fenceAmbiguousTurn(
        turn,
        attempt,
        this.#requireIncarnation(attempt.incarnationId),
        outcome.proof,
      );
      return;
    }
    this.#authority.transitionActorOperation({
      operationId: operation.id,
      expectedState: "effectStarted",
      nextState: outcome.kind === "applied" ? "succeeded" : "notApplied",
      providerIdentityJson: storedThreadOrTurnEnvelope({
        request: durableRequest,
        outcome,
      }),
      now: this.#timestamp(),
    });
    // An interrupt acknowledgement, including a definitive notApplied response,
    // is not terminal evidence. The provider turn must still be observed.
    this.#markAttemptReconciling(attempt);
    this.#markTurnReconciling(turn);
  }

  async #settleObservation(
    attemptValue: PersistedActorAttempt | ActorAttemptObservationBindingV2,
    event: PersistentActorTerminalObservation,
  ): Promise<PersistentActorTurnView> {
    const candidate = "attempt" in attemptValue
      ? attemptValue.attempt
      : attemptValue;
    const observation = "attempt" in attemptValue
      ? attemptValue
      : this.#authority.resolveActorAttemptObservation({
          accountProfileId: event.accountProfileId,
          observationGeneration: event.processGeneration,
          providerThreadId: event.providerThreadId,
          providerTurnId: event.providerTurnId,
        });
    if (observation === null || observation.attempt.id !== candidate.id) {
      throw new PersistentActorError(
        "conflict",
        "terminal event does not match a live recovered actor session",
      );
    }
    let attempt = this.#requireAttempt(candidate.id);
    let turn = this.#requireTurn(attempt.turnId);
    if (
      attempt.accountProfileId !== event.accountProfileId ||
      attempt.processGeneration !== observation.admissionGeneration ||
      observation.currentObservationGeneration !== event.processGeneration ||
      attempt.providerTurnId !== event.providerTurnId ||
      this.#requireIncarnation(attempt.incarnationId).providerThreadId !==
        event.providerThreadId
    ) {
      throw new PersistentActorError("conflict", "terminal event does not match its attempt fence");
    }
    if (event.inputTokens === null || event.outputTokens === null) {
      // A terminal outcome without exact per-turn usage cannot safely release
      // the incarnation for another turn: treating it as zero would let a
      // restart overspend the actor's durable budget.
      this.#fenceAmbiguousTurn(
        turn,
        attempt,
        this.#requireIncarnation(attempt.incarnationId),
        event.proof,
      );
      throw new PersistentActorError(
        "ambiguous_effect",
        "terminal provider observation lacks exact token usage",
      );
    }
    if (event.quotaProof !== null) {
      const existingResult = this.#authority.readActorResult(resultId(turn.id));
      if (existingResult !== null) {
        return { turn: this.#requireTurn(turn.id), result: existingResult };
      }
      attempt = this.#authority.settleActorQuotaRejection({
        attemptId: attempt.id,
        expectedState: attempt.state === "running" ? "running" : "reconciling",
        providerTurnId: event.providerTurnId,
        continuationHistoryValueId: null,
        quotaProofDigest: event.proof.digest,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        now: this.#timestamp(),
      });
      turn = this.#markTurnReconciling(turn);
      this.#closeIncarnation(this.#requireIncarnation(attempt.incarnationId));
      if (!this.#settleDurableQuotaExhaustion(turn)) {
        throw new PersistentActorError(
          "conflict",
          "observed quota rejection did not terminalize its logical turn",
        );
      }
      return this.#turnView(this.#requireTurn(turn.id));
    }
    const nextAttemptState = event.terminal === "completed"
      ? "completed"
      : event.terminal === "failed" ? "failed" : "interrupted";
    const existingResult = this.#authority.readActorResult(resultId(turn.id));
    if (existingResult !== null) {
      this.#transitionAttempt(attempt, nextAttemptState, {
        providerTurnId: event.providerTurnId,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
      });
      return { turn: this.#requireTurn(turn.id), result: existingResult };
    }
    if (event.terminal === "completed") {
      const resultValueId = event.resultValueId;
      if (resultValueId === null) {
        throw new PersistentActorError("conflict", "completed turn lacks a result value");
      }
      await this.#values.assertResultAvailable({
        epochId: turn.epochId,
        actorId: turn.actorId,
        turnId: turn.id,
        valueId: resultValueId,
      });
    }
    const outcome = event.terminal === "completed"
      ? "succeeded"
      : event.terminal === "failed" ? "failed" : "cancelled";
    const settled = this.#authority.settleActorTerminalObservation({
      resultId: resultId(turn.id),
      attemptId: attempt.id,
      expectedAttemptState:
        attempt.state === "running" ? "running" : "reconciling",
      nextAttemptState,
      providerTurnId: event.providerTurnId,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      incarnationId: attempt.incarnationId,
      turnId: turn.id,
      expectedTurnRevision: turn.revision,
      outcome,
      valueId: event.resultValueId,
      outcomeCode: event.outcomeCode,
      now: this.#timestamp(),
    });
    return { turn: this.#requireTurn(turn.id), result: settled.result };
  }

  #fenceAmbiguousTurn(
    turnValue: ActorTurn,
    attemptValue: PersistedActorAttempt,
    _incarnation: ActorIncarnationRecord,
    proof: PersistentActorEffectProof,
  ): void {
    const contained = this.#authority.containAmbiguousActorTurn({
      attemptId: attemptValue.id,
      evidenceDigest: proof.digest,
      now: this.#timestamp(),
    });
    if (
      contained.evidenceTurn.id !== turnValue.id ||
      contained.evidenceAttempt.incarnationId !== _incarnation.id
    ) {
      throw new PersistentActorError(
        "conflict",
        "ambiguous actor containment returned another durable lineage",
      );
    }
  }

  #fenceActor(actorId: string): void {
    let actor = this.#requireActor(actorId);
    if (actor.state === "quarantined" || actor.state === "stopped") return;
    if (actor.state === "active") {
      actor = this.#authority.requestActorStop({
        actorId: actor.id,
        expectedRevision: actor.revision,
        now: this.#timestamp(),
      });
    }
    if (actor.state === "stopRequested") {
      this.#authority.settleActorStop({
        actorId: actor.id,
        expectedRevision: actor.revision,
        nextState: "quarantined",
        now: this.#timestamp(),
      });
    }
  }

  #fenceActorStartRecovery(operation: ActorOperationRecord): void {
    const incarnation = this.#authority.readActorIncarnation(
      incarnationIdFor(operation.id),
    );
    if (
      incarnation !== null &&
      (incarnation.state === "starting" || incarnation.state === "idle")
    ) {
      this.#authority.transitionActorIncarnation({
        incarnationId: incarnation.id,
        expectedState: incarnation.state,
        nextState: "quarantined",
        providerThreadId: incarnation.providerThreadId,
        now: this.#timestamp(),
      });
    }
    const liveTurns = this.#readActorReconciliation(operation.actorId).turns;
    if (liveTurns.length > 1) {
      throw new PersistentActorError(
        "conflict",
        "actor-start recovery found multiple live logical turns",
      );
    }
    const liveTurn = liveTurns[0];
    if (liveTurn !== undefined) {
      const attempt = this.#findUnsettledAttempt(liveTurn.id);
      if (attempt === null) {
        this.#authority.settleActorResult({
          resultId: resultId(liveTurn.id),
          turnId: liveTurn.id,
          terminalAttemptId: null,
          outcome: "cancelled",
          valueId: null,
          expectedTurnRevision: liveTurn.revision,
          outcomeCode: "actor_start_recovery_fenced",
          createdAt: this.#timestamp(),
        });
      } else {
        const attemptIncarnation = this.#requireIncarnation(attempt.incarnationId);
        this.#fenceAmbiguousTurn(
          liveTurn,
          attempt,
          attemptIncarnation,
          recoveryProof(),
        );
      }
    }
    this.#fenceActor(operation.actorId);
  }

  #allowsFreshProviderEffect(actorId: string, toolsetDigest: string): boolean {
    const policy = this.#authority.readActorDispatchPolicy(actorId);
    return policy.policyVersion === 1 &&
      policy.workClass !== "legacyUnclassified" &&
      toolsetDigest === HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256;
  }

  #preflightActorStartEffect(
    actorId: string,
    turnId: string,
    operation: ActorOperationRecord,
  ): boolean {
    const actor = this.#requireActor(actorId);
    let turn = this.#requireTurn(turnId);
    if (turn.actorId !== actor.id) {
      throw new PersistentActorError(
        "conflict",
        "actor-start preflight lost its initiating logical turn",
      );
    }
    if (isTerminalActorTurnState(turn.state)) return false;
    if (actor.state !== "active" || turn.desiredState === "stop") {
      this.#settleEffectFreeTurn(turn, "actor_start_stopped_before_effect");
      return false;
    }
    try {
      this.#assertActorBeforeDeadline(actor, turn);
    } catch (error: unknown) {
      if (!(error instanceof PersistentActorError) || error.code !== "timeout") {
        throw error;
      }
      turn = this.#requireTurn(turn.id);
      if (!isTerminalActorTurnState(turn.state)) {
        this.#settleEffectFreeTurn(turn, "deadline_before_actor_start");
      }
      return false;
    }
    this.#assertActorTokenCapacity(actor);
    if (
      this.#settleLegacyQuotaLineageBeforeProvider(turn, operation) !== "none"
    ) return false;
    return true;
  }

  #preflightTurnStartEffect(
    turnValue: ActorTurn,
    attemptValue: PersistedActorAttempt,
    incarnationValue: ActorIncarnationRecord,
    operationValue: ActorOperationRecord,
  ): boolean {
    let turn = this.#requireTurn(turnValue.id);
    const attempt = this.#requireAttempt(attemptValue.id);
    const incarnation = this.#requireIncarnation(incarnationValue.id);
    const operation = this.#requireOperation(operationValue.id);
    const actor = this.#requireActor(turn.actorId);
    if (
      attempt.turnId !== turn.id ||
      attempt.incarnationId !== incarnation.id ||
      incarnation.actorId !== actor.id ||
      operation.actorId !== actor.id ||
      operation.turnId !== turn.id ||
      operation.kind !== "turnStart" ||
      operation.state !== "prepared"
    ) {
      throw new PersistentActorError(
        "conflict",
        "turn-start preflight lost its durable effect lineage",
      );
    }
    if (isTerminalActorTurnState(turn.state)) return false;
    if (actor.state !== "active" && turn.desiredState !== "stop") {
      turn = this.#authority.requestActorTurnStop({
        turnId: turn.id,
        expectedRevision: turn.revision,
      });
    }
    if (turn.desiredState === "stop") {
      this.#settleClaimedCancellation(
        turn,
        attempt,
        incarnation,
        operation,
        "cancelled_before_turn_effect",
      );
      return false;
    }
    try {
      this.#assertActorBeforeDeadline(actor, turn);
    } catch (error: unknown) {
      if (!(error instanceof PersistentActorError) || error.code !== "timeout") {
        throw error;
      }
      turn = this.#requireTurn(turn.id);
      this.#settleClaimedCancellation(
        turn,
        attempt,
        incarnation,
        operation,
        "deadline_before_turn_effect",
      );
      return false;
    }
    this.#assertActorTokenCapacity(actor);
    try {
      this.#quotaContinuationSourceForTurn(turn, attempt.ordinal);
    } catch (cause: unknown) {
      this.#containInvalidQuotaContinuationSource(turn);
      throw new PersistentActorError(
        "ambiguous_effect",
        "quota continuation source failed exact final pre-effect validation",
        cause,
      );
    }
    return true;
  }

  #settleEffectFreeTurn(turnValue: ActorTurn, outcomeCode: string): void {
    let turn = this.#requireTurn(turnValue.id);
    if (isTerminalActorTurnState(turn.state)) return;
    if (turn.desiredState !== "stop") {
      turn = this.#authority.requestActorTurnStop({
        turnId: turn.id,
        expectedRevision: turn.revision,
      });
    }
    const attempts = this.#listAttemptsForTurn(turn.id);
    const latest = attempts.at(-1) ?? null;
    if (latest !== null && latest.state !== "quotaRejected") {
      throw new PersistentActorError(
        "conflict",
        "effect-free actor start found a non-quota terminal attempt",
      );
    }
    this.#authority.settleActorResult({
      resultId: resultId(turn.id),
      turnId: turn.id,
      terminalAttemptId: latest?.id ?? null,
      outcome: latest === null ? "cancelled" : "quotaRejected",
      valueId: null,
      expectedTurnRevision: turn.revision,
      outcomeCode,
      createdAt: this.#timestamp(),
    });
  }

  #settleEffectFreeQuotaTurn(
    turnValue: ActorTurn,
    outcomeCode: string,
    actorStartOperationIds: readonly string[],
  ): void {
    const turn = this.#requireTurn(turnValue.id);
    if (isTerminalActorTurnState(turn.state)) return;
    if (this.#listAttemptsForTurn(turn.id).length !== 0) {
      throw new PersistentActorError(
        "conflict",
        "effect-free actor quota settlement found a turn attempt",
      );
    }
    this.#authority.settleActorThreadAdmissionQuotaExhaustion({
      resultId: resultId(turn.id),
      turnId: turn.id,
      actorStartOperationIds,
      expectedTurnRevision: turn.revision,
      outcomeCode,
      createdAt: this.#timestamp(),
    });
  }

  /**
   * Retired prerelease databases may contain a quota-rejected source whose
   * logical turn was left live so a second subscription could continue it.
   * Consume that evidence locally before account selection, session readiness,
   * or any provider call. A source with no replacement settles as the original
   * quota result. Any durable replacement plan or attempt is contained and its
   * actor-start lineage is fenced without reconstructing continuation history.
   */
  #settleLegacyQuotaLineageBeforeProvider(
    turnValue: ActorTurn,
    actorStartOperation?: ActorOperationRecord,
  ): "none" | "terminalized" | "fenced" {
    const turn = this.#requireTurn(turnValue.id);
    if (isTerminalActorTurnState(turn.state)) return "terminalized";
    const attempts = this.#listAttemptsForTurn(turn.id);
    const source = attempts.find((attempt) => attempt.state === "quotaRejected");
    if (source === undefined) return "none";

    const sourceIncarnation = this.#requireIncarnation(source.incarnationId);
    const actorRecovery = this.#readActorReconciliation(turn.actorId);
    const replacementActorStarts = new Map<string, ActorOperationRecord>();
    for (const operation of actorRecovery.operations) {
      if (
        operation.kind === "actorStart" &&
        operation.id !== sourceIncarnation.startOperationId
      ) replacementActorStarts.set(operation.id, operation);
    }
    if (
      actorStartOperation !== undefined &&
      actorStartOperation.id !== sourceIncarnation.startOperationId
    ) replacementActorStarts.set(actorStartOperation.id, actorStartOperation);
    const hasLaterAttempt = attempts.some(
      (attempt) => attempt.ordinal > source.ordinal,
    );

    if (!hasLaterAttempt && replacementActorStarts.size === 0) {
      const reconciling = this.#markTurnReconciling(turn);
      if (!this.#settleDurableQuotaExhaustion(reconciling)) {
        throw new PersistentActorError(
          "conflict",
          "legacy quota rejection did not terminalize its logical turn",
        );
      }
      return "terminalized";
    }

    try {
      this.#containInvalidQuotaContinuationSource(turn);
    } catch (cause: unknown) {
      const replacementAttempt = this.#findUnsettledAttempt(turn.id);
      if (replacementAttempt !== null) {
        this.#fenceAmbiguousTurn(
          turn,
          replacementAttempt,
          this.#requireIncarnation(replacementAttempt.incarnationId),
          recoveryProof(),
        );
      } else if (replacementActorStarts.size === 0) {
        throw cause;
      }
    }
    for (const operation of replacementActorStarts.values()) {
      this.#fenceActorStartRecovery(operation);
    }
    return "fenced";
  }

  #settleDurableQuotaExhaustion(turnValue: ActorTurn): boolean {
    const turn = this.#requireTurn(turnValue.id);
    const existing = this.#authority.readActorResult(resultId(turn.id));
    if (existing !== null) return true;
    if (isTerminalActorTurnState(turn.state)) return false;
    const latest = this.#listAttemptsForTurn(turn.id).at(-1);
    if (latest === undefined || latest.state !== "quotaRejected") return false;
    this.#authority.settleActorResult({
      resultId: resultId(turn.id),
      turnId: turn.id,
      terminalAttemptId: latest.id,
      outcome: "quotaRejected",
      valueId: null,
      expectedTurnRevision: turn.revision,
      outcomeCode: "quota_exhausted",
      createdAt: this.#timestamp(),
    });
    return true;
  }

  #containInvalidQuotaContinuationSource(turnValue: ActorTurn): void {
    let turn = this.#requireTurn(turnValue.id);
    if (!isTerminalActorTurnState(turn.state)) {
      const source = this.#listAttemptsForTurn(turn.id)
        .toSorted((left, right) => right.ordinal - left.ordinal)
        .find((attempt) => attempt.state === "quotaRejected");
      if (source === undefined) {
        throw new PersistentActorError(
          "conflict",
          "quota continuation containment lacks its terminal source attempt",
        );
      }
      turn = this.#markTurnReconciling(turn);
      this.#authority.settleInvalidQuotaContinuation({
        resultId: resultId(turn.id),
        turnId: turn.id,
        terminalAttemptId: source.id,
        expectedTurnRevision: turn.revision,
        outcomeCode: "quota_continuation_source_invalid",
        createdAt: this.#timestamp(),
      });
    }
  }

  /**
   * Deadline is checked immediately before every provider-adjacent effect.
   * Persisting actor/turn stop intent first means a crash cannot later start a
   * turn that was already known to be expired.
   */
  #assertActorBeforeDeadline(actorValue: Actor, turnValue?: ActorTurn): void {
    let actor = this.#requireActor(actorValue.id);
    if (this.#clock.now().getTime() < Date.parse(actor.budget.deadline)) return;
    if (actor.state === "active") {
      actor = this.#authority.requestActorStop({
        actorId: actor.id,
        expectedRevision: actor.revision,
        now: this.#timestamp(),
      });
    }
    if (turnValue !== undefined) {
      let turn = this.#requireTurn(turnValue.id);
      if (!isTerminalActorTurnState(turn.state) && turn.desiredState !== "stop") {
        turn = this.#authority.requestActorTurnStop({
          turnId: turn.id,
          expectedRevision: turn.revision,
        });
      }
      if (turn.state === "prepared") {
        this.#settlePreparedCancellation(turn, "deadline_before_effect");
      }
    }
    throw new PersistentActorError(
      "timeout",
      "actor deadline elapsed before a provider effect could start",
    );
  }

  #assertActorTokenCapacity(actorValue: Actor): void {
    const remaining = this.#authority.remainingActorTokens(actorValue.id);
    if (remaining > 0) return;
    throw new PersistentActorError(
      "account_exhausted",
      "actor has no unreserved durable token capacity for another turn",
    );
  }

  #settlePreparedCancellation(
    turnValue: ActorTurn,
    outcomeCode: string,
  ): ActorResult {
    const turn = this.#requireTurn(turnValue.id);
    if (turn.state !== "prepared") {
      throw new PersistentActorError("invalid_state", "only a prepared turn may settle without an attempt");
    }
    return this.#authority.settleActorResult({
      resultId: resultId(turn.id),
      turnId: turn.id,
      terminalAttemptId: null,
      outcome: "cancelled",
      valueId: null,
      expectedTurnRevision: turn.revision,
      outcomeCode,
      createdAt: this.#timestamp(),
    });
  }

  #settleClaimedCancellation(
    turnValue: ActorTurn,
    attemptValue: PersistedActorAttempt,
    incarnationValue: ActorIncarnationRecord,
    operationValue: ActorOperationRecord,
    outcomeCode: string,
  ): ActorResult {
    const turn = this.#requireTurn(turnValue.id);
    const attempt = this.#requireAttempt(attemptValue.id);
    const incarnation = this.#requireIncarnation(incarnationValue.id);
    const operation = this.#requireOperation(operationValue.id);
    if (
      turn.desiredState !== "stop" ||
      attempt.providerTurnId !== null ||
      (attempt.state !== "starting" && attempt.state !== "reconciling") ||
      incarnation.state !== "running"
    ) {
      throw new PersistentActorError(
        "invalid_state",
        "claimed cancellation lost its definitive pre-effect fence",
      );
    }
    if (
      operation.kind !== "turnStart" || operation.state !== "prepared" ||
      operation.actorId !== turn.actorId || operation.turnId !== turn.id
    ) {
      throw new PersistentActorError(
        "invalid_state",
        "claimed cancellation no longer has definitive pre-effect evidence",
      );
    }
    return this.#authority.settleClaimedActorCancellation({
      resultId: resultId(turn.id),
      operationId: operation.id,
      attemptId: attempt.id,
      turnId: turn.id,
      incarnationId: incarnation.id,
      outcomeCode,
      now: this.#timestamp(),
    });
  }

  async #acquireWorkspace(
    epoch: ActorEpoch,
    actor: Actor,
  ): Promise<PersistentActorWorkspaceLease> {
    const bindingId = workspaceBindingId(actor.id);
    const lease = persistentActorWorkspaceLeaseSchema.parse(
      await this.#workspaces.acquire({ epoch, actor, bindingId }),
    );
    if (lease.authority !== actor.budget.laneAuthority) {
      throw new PersistentActorError(
        "conflict",
        "workspace lease widened or changed actor authority",
      );
    }
    this.#authority.bindActorWorkspace({
      bindingId,
      actorId: actor.id,
      laneId: lease.laneId,
      authority: lease.authority,
      createdAt: this.#timestamp(),
    });
    return lease;
  }

  async #accountCandidates(actor: Actor): Promise<PersistentActorAccountEligibilityResult> {
    const dispatchPolicy = this.#authority.readActorDispatchPolicy(actor.id);
    const parsed = accountEligibilitySchema.parse(
      await this.#accounts.listEligibleAccounts({
        epochId: actor.epochId,
        actorId: actor.id,
        workClass: dispatchPolicy.workClass,
      }),
    );
    const accountProfileIds = new Set<string>();
    for (const candidate of parsed.candidates) {
      if (accountProfileIds.has(candidate.accountProfileId)) {
        throw new PersistentActorError(
          "conflict",
          "eligible account profiles are not unique",
        );
      }
      accountProfileIds.add(candidate.accountProfileId);
    }
    let previousTemporary: string | null = null;
    for (const accountProfileId of parsed.temporarilyUnavailableAccountProfileIds) {
      if (
        accountProfileIds.has(accountProfileId) ||
        accountProfileId === previousTemporary ||
        (previousTemporary !== null && previousTemporary.localeCompare(accountProfileId) >= 0)
      ) {
        throw new PersistentActorError(
          "conflict",
          "temporary account profiles are not unique, disjoint, and sorted",
        );
      }
      accountProfileIds.add(accountProfileId);
      previousTemporary = accountProfileId;
    }
    let previousUnsupported: string | null = null;
    for (const accountProfileId of parsed.unsupportedAccountProfileIds) {
      if (
        accountProfileIds.has(accountProfileId) ||
        accountProfileId === previousUnsupported ||
        (previousUnsupported !== null &&
          previousUnsupported.localeCompare(accountProfileId) >= 0)
      ) {
        throw new PersistentActorError(
          "conflict",
          "unsupported account profiles are not unique, disjoint, and sorted",
        );
      }
      accountProfileIds.add(accountProfileId);
      previousUnsupported = accountProfileId;
    }
    // The account boundary owns health, selection, and remaining-quota rank.
    // Reordering here would silently discard that live routing decision.
    return parsed;
  }

  #threadRequest(
    actor: Actor,
    candidate: PersistentActorAccountCandidate,
    workspaceLaneId: string,
    operationId: string,
  ): PersistentActorThreadRequest {
    const dispatchPolicy = this.#authority.readActorDispatchPolicy(actor.id);
    return Object.freeze({
      actorId: actor.id,
      epochId: actor.epochId,
      policyVersion: dispatchPolicy.policyVersion,
      workClass: dispatchPolicy.workClass,
      accountProfileId: candidate.accountProfileId,
      processGeneration: candidate.processGeneration,
      modelId: candidate.modelId,
      reasoningEffort: candidate.reasoningEffort,
      selectedProfile: candidate.selectedProfile,
      profileFallbackReason: candidate.profileFallbackReason,
      capabilityEvidenceDigest: candidate.capabilityEvidenceDigest,
      supportsFast: candidate.supportsFast,
      clientRequestId: clientRequestId(operationId),
      threadSource: `oprte:harness:v2:${actor.epochId}:${actor.id}:${incarnationIdFor(operationId)}`,
      toolsetDigest: this.#toolsetDigest,
      workspaceLaneId: laneIdSchema.parse(workspaceLaneId),
      effectKey: effectKey(operationId, pinnedCodexRequests.threadStart.method),
      continuation: null,
    });
  }

  #turnRequest(
    turn: ActorTurn,
    attempt: PersistedActorAttempt,
    incarnation: ActorIncarnationRecord,
  ): PersistentActorTurnRequest {
    if (
      incarnation.actorId !== turn.actorId || attempt.turnId !== turn.id ||
      attempt.incarnationId !== incarnation.id || incarnation.providerThreadId === null
    ) {
      throw new PersistentActorError("conflict", "turn attempt lineage is inconsistent");
    }
    const session = this.#requireLiveSessionBinding(incarnation, attempt);
    if (
      attempt.effectGeneration === null ||
      attempt.effectGeneration > session.liveGeneration
    ) {
      throw new PersistentActorError(
        "conflict",
        "actor attempt lacks an exact effect-generation binding",
      );
    }
    const continuation = this.#quotaContinuationForAttempt(turn, attempt);
    const accelerationRecord = this.#authority.readActorTurnAcceleration(turn.id);
    const requestedAcceleration: ActorTurnAcceleration = accelerationRecord.mode === "standard"
      ? STANDARD_ACTOR_TURN_ACCELERATION
      : Object.freeze({
          mode: "fast" as const,
          criticalPath: true as const,
          bottleneck: accelerationRecord.bottleneck,
        });
    return Object.freeze({
      actorId: turn.actorId,
      epochId: turn.epochId,
      turnId: turn.id,
      incarnationId: incarnation.id,
      accountProfileId: attempt.accountProfileId,
      processGeneration: attempt.effectGeneration,
      observationGeneration: session.liveGeneration,
      providerThreadId: incarnation.providerThreadId,
      modelId: incarnation.requestedModel,
      reasoningEffort: incarnation.requestedReasoningEffort,
      requestedAcceleration,
      serviceTier: attempt.realizedServiceTier,
      tierFallbackReason: attempt.tierFallbackReason,
      capabilityEvidenceDigest: attempt.capabilityEvidenceDigest,
      fastReservationId: attempt.fastReservationId,
      toolsetDigest: incarnation.toolsetDigest,
      clientUserMessageId: attempt.clientUserMessageId,
      inputValueId: turn.inputValueId,
      effectKey: effectKey(
        turnOperationId(turn.id, incarnation.id),
        pinnedCodexRequests.turnStart.method,
      ),
      continuation,
    });
  }

  #turnEffectAdmission(
    turn: ActorTurn,
    attempt: PersistedActorAttempt,
    incarnation: ActorIncarnationRecord,
  ): Readonly<{
    request: PersistentActorTurnRequest;
    session: ActorSessionBindingRecordV2;
  }> {
    const session = this.#requireLiveSessionBinding(incarnation, attempt);
    const current = this.#turnRequest(turn, attempt, incarnation);
    return Object.freeze({
      session,
      request: Object.freeze({
        ...current,
        processGeneration: session.liveGeneration,
        observationGeneration: session.liveGeneration,
        capabilityEvidenceDigest: session.liveCapabilityEvidenceDigest,
      }),
    });
  }

  #attemptDispatch(
    turn: ActorTurn,
    incarnation: ActorIncarnationRecord,
  ): Readonly<{
    capabilityEvidenceDigest: string | null;
    fastReservationId?: string;
  }> {
    const acceleration = this.#authority.readActorTurnAcceleration(turn.id);
    const session = this.#authority.readActorSessionBinding(incarnation.id);
    if (
      session === null || session.state !== "bound" ||
      session.admissionGeneration !== incarnation.processGeneration ||
      session.accountProfileId !== incarnation.accountProfileId ||
      session.providerThreadId !== incarnation.providerThreadId
    ) {
      throw new PersistentActorError(
        "conflict",
        "actor attempt dispatch lacks exact live capability custody",
      );
    }
    return Object.freeze({
      capabilityEvidenceDigest: session.liveCapabilityEvidenceDigest,
      ...(acceleration.mode === "fast"
        ? { fastReservationId: fastReservationIdFor(turn.id, incarnation.id) }
        : {}),
    });
  }

  #releaseFastReservationAfterDefinitiveNonApplication(
    attempt: PersistedActorAttempt,
    request: PersistentActorTurnRequest,
    proof: PersistentActorEffectProof,
  ): void {
    const reservation = this.#authority.readActorFastReservationForAttempt(
      attempt.id,
    );
    if (reservation === null || reservation.state === "released") return;
    if (reservation.state === "consumed") {
      throw new PersistentActorError(
        "conflict",
        "definitively absent provider work already consumed Fast capacity",
      );
    }
    if (reservation.state === "quarantined") {
      this.#authority.settleActorFastReservation({
        reservationId: reservation.id,
        attemptId: attempt.id,
        expectedState: "quarantined",
        nextState: "released",
        reason: "generationFenced",
        fenceEvidenceDigest: proof.digest,
        fencedGeneration: request.observationGeneration,
        now: this.#timestamp(),
      });
      return;
    }
    this.#authority.settleActorFastReservation({
      reservationId: reservation.id,
      attemptId: attempt.id,
      expectedState: reservation.state,
      nextState: "released",
      reason: "definitiveNotApplied",
      now: this.#timestamp(),
    });
  }

  #quotaContinuationForAttempt(
    turn: ActorTurn,
    attempt: PersistedActorAttempt,
  ): PersistentActorQuotaContinuation | null {
    const sourceLineage = this.#quotaContinuationSourceForTurn(
      turn,
      attempt.ordinal,
    );
    if (sourceLineage === null) return null;
    const { source, sourceIncarnation, sourceRequest } = sourceLineage;
    if (source.accountProfileId === attempt.accountProfileId) {
      throw new PersistentActorError(
        "conflict",
        "quota continuation revisited its exhausted subscription",
      );
    }
    if (source.providerTurnId === null || source.continuationHistoryValueId === null) {
      throw new PersistentActorError(
        "conflict",
        "quota continuation source lost its terminal evidence",
      );
    }
    return Object.freeze({
      sourceAttemptId: source.id,
      historyValueId: source.continuationHistoryValueId,
      sourceAccountProfileId: source.accountProfileId,
      sourceProcessGeneration: sourceRequest.processGeneration,
      sourceProviderThreadId: sourceIncarnation.providerThreadId!,
      sourceProviderTurnId: source.providerTurnId,
    });
  }

  #quotaContinuationSourceForTurn(
    turnValue: ActorTurn,
    beforeOrdinal?: number,
  ): Readonly<{
    source: PersistedActorAttempt;
    sourceIncarnation: ActorIncarnationRecord;
    sourceRequest: PersistentActorTurnRequest;
  }> | null {
    const turn = this.#requireTurn(turnValue.id);
    const priorQuotaAttempts = this.#listAttemptsForTurn(turn.id)
      .filter((candidate) =>
        (beforeOrdinal === undefined || candidate.ordinal < beforeOrdinal) &&
        candidate.state === "quotaRejected" &&
        candidate.providerTurnId !== null
      )
      .toSorted((left, right) => right.ordinal - left.ordinal);
    const source = priorQuotaAttempts[0];
    if (source === undefined || source.providerTurnId === null) return null;
    if (source.continuationHistoryValueId === null) {
      throw new PersistentActorError(
        "conflict",
        "post-admission quota attempt lacks its encrypted history capsule",
      );
    }
    const sourceIncarnation = this.#requireIncarnation(source.incarnationId);
    const sourceSession = this.#requireHistoricalSessionBinding(
      sourceIncarnation,
      source,
    );
    const sourceOperation = this.#requireOperation(
      turnOperationId(turn.id, sourceIncarnation.id),
    );
    const sourceRequest = parseStoredTurnRequestEnvelope(
      sourceOperation.providerIdentityJson,
    );
    if (
      sourceIncarnation.providerThreadId === null ||
      sourceIncarnation.accountProfileId !== source.accountProfileId ||
      sourceIncarnation.processGeneration !== source.processGeneration ||
      sourceOperation.kind !== "turnStart" ||
      sourceOperation.requestDigest !== digestCanonical(sourceRequest) ||
      sourceRequest.turnId !== turn.id ||
      sourceRequest.incarnationId !== sourceIncarnation.id ||
      sourceRequest.accountProfileId !== source.accountProfileId ||
      sourceRequest.providerThreadId !== sourceIncarnation.providerThreadId ||
      sourceRequest.observationGeneration > sourceSession.liveGeneration
    ) {
      throw new PersistentActorError(
        "conflict",
        "quota continuation source lost exact provider lineage",
      );
    }
    return Object.freeze({ source, sourceIncarnation, sourceRequest });
  }

  #interruptRequest(
    turn: ActorTurn,
    attempt: PersistedActorAttempt,
    incarnation: ActorIncarnationRecord,
  ): PersistentActorInterruptRequest {
    if (attempt.providerTurnId === null || incarnation.providerThreadId === null) {
      throw new PersistentActorError("invalid_state", "interrupt requires exact provider identities");
    }
    const session = this.#requireLiveSessionBinding(incarnation, attempt);
    const operationId = interruptOperationId(turn.id, incarnation.id);
    return Object.freeze({
      actorId: turn.actorId,
      turnId: turn.id,
      incarnationId: incarnation.id,
      accountProfileId: attempt.accountProfileId,
      processGeneration: session.liveGeneration,
      observationGeneration: session.liveGeneration,
      providerThreadId: incarnation.providerThreadId,
      providerTurnId: attempt.providerTurnId,
      effectKey: effectKey(
        operationId,
        pinnedCodexRequests.turnInterrupt.method,
      ),
    });
  }

  #requireLiveSessionBinding(
    incarnation: ActorIncarnationRecord,
    attempt: PersistedActorAttempt,
  ): ActorSessionBindingRecordV2 {
    const session = this.#authority.readActorSessionBinding(incarnation.id);
    if (
      session === null || session.state !== "bound" ||
      session.incarnationId !== incarnation.id ||
      session.actorId !== incarnation.actorId ||
      session.accountProfileId !== attempt.accountProfileId ||
      session.admissionGeneration !== attempt.processGeneration ||
      session.providerThreadId !== incarnation.providerThreadId ||
      session.liveGeneration < session.admissionGeneration
    ) {
      throw new PersistentActorError(
        "conflict",
        "actor attempt lacks its exact live session successor binding",
      );
    }
    return session;
  }

  #requireHistoricalSessionBinding(
    incarnation: ActorIncarnationRecord,
    attempt: PersistedActorAttempt,
  ): ActorSessionBindingRecordV2 {
    const session = this.#authority.readActorSessionBinding(incarnation.id);
    if (
      session === null ||
      (session.state !== "bound" && session.state !== "retired") ||
      session.incarnationId !== incarnation.id ||
      session.actorId !== incarnation.actorId ||
      session.accountProfileId !== attempt.accountProfileId ||
      session.admissionGeneration !== attempt.processGeneration ||
      session.providerThreadId !== incarnation.providerThreadId ||
      (incarnation.state === "closed" && session.state !== "retired") ||
      (incarnation.state !== "closed" && session.state !== "bound")
    ) {
      throw new PersistentActorError(
        "conflict",
        "actor continuation source lacks its exact retired session evidence",
      );
    }
    return session;
  }

  #prepareOperation(input: Readonly<{
    id: string;
    actorId: string;
    turnId: string | null;
    kind: ActorOperationRecord["kind"];
    request: PersistentActorThreadRequest | PersistentActorTurnRequest |
      PersistentActorInterruptRequest;
  }>): ActorOperationRecord {
    const existing = this.#authority.readActorOperation(input.id);
    if (existing !== null) {
      if (
        existing.actorId !== input.actorId ||
        existing.turnId !== input.turnId ||
        existing.kind !== input.kind ||
        existing.effectKey !== input.request.effectKey
      ) {
        throw new PersistentActorError(
          "conflict",
          "actor operation identity already names another provider effect",
        );
      }
      // An actor-start selection operation is deliberately prepared before
      // its transaction-local account choice. Its opaque ID commits the exact
      // candidate identity set, while live headroom/load may reorder that set
      // after a crash. No provider effect can have started in `prepared`, so
      // the account-lease transaction is the sole authority allowed to bind
      // the final request.
      if (existing.kind === "actorStart" && existing.state === "prepared") {
        return existing;
      }
      const storedRequest = parseStoredOperationRequest(existing);
      if (
        existing.kind === "turnStart" && existing.state === "prepared" &&
        "clientUserMessageId" in storedRequest &&
        "clientUserMessageId" in input.request
      ) {
        if (!samePreparedTurnIntent(storedRequest, input.request)) {
          throw new PersistentActorError(
            "conflict",
            "prepared actor turn changed its stable provider intent",
          );
        }
        // Generation, catalog, and Fast custody are deliberately not rebound
        // here. `startActorTurnEffect` commits them together with the final
        // prepared -> effectStarted CAS.
        return existing;
      }
      if (
        existing.requestDigest !== digestCanonical(storedRequest) ||
        !sameOperationRequestLineage(storedRequest, input.request)
      ) {
        throw new PersistentActorError(
          "conflict",
          "actor operation request evidence changed across recovery",
        );
      }
      if (
        existing.state === "prepared" &&
        ("observationGeneration" in storedRequest) &&
        ("observationGeneration" in input.request) &&
        (storedRequest.processGeneration !== input.request.processGeneration ||
          storedRequest.observationGeneration !==
            input.request.observationGeneration)
      ) {
        const providerIdentityJson = storedThreadOrTurnEnvelope({
          request: input.request,
        });
        return this.#authority.rebasePreparedActorOperation({
          operationId: existing.id,
          expectedRequestDigest: existing.requestDigest,
          requestDigest: digestCanonical(input.request),
          effectKey: existing.effectKey,
          providerIdentityJson,
          now: this.#timestamp(),
        });
      }
      return existing;
    }
    const requestDigest = digestCanonical(input.request);
    return this.#authority.prepareActorOperation({
      operationId: input.id,
      actorId: input.actorId,
      turnId: input.turnId,
      kind: input.kind,
      requestDigest,
      effectKey: input.request.effectKey,
      providerIdentityJson: storedThreadOrTurnEnvelope({ request: input.request }),
      createdAt: this.#timestamp(),
    });
  }

  #turnRequestForOperation(
    operation: ActorOperationRecord,
    current: PersistentActorTurnRequest,
  ): PersistentActorTurnRequest {
    const stored = parseStoredTurnRequestEnvelope(operation.providerIdentityJson);
    if (
      operation.kind !== "turnStart" ||
      operation.actorId !== stored.actorId ||
      operation.turnId !== stored.turnId ||
      operation.effectKey !== stored.effectKey ||
      operation.requestDigest !== digestCanonical(stored) ||
      !sameOperationRequestLineage(stored, current) ||
      current.observationGeneration < stored.processGeneration
    ) {
      throw new PersistentActorError(
        "conflict",
        "turn recovery lost its immutable effect and live observation generations",
      );
    }
    return Object.freeze({
      ...stored,
      observationGeneration: current.observationGeneration,
    });
  }

  #interruptRequestForOperation(
    operation: ActorOperationRecord,
    current: PersistentActorInterruptRequest,
  ): PersistentActorInterruptRequest {
    const stored = parseStoredInterruptRequestEnvelope(
      operation.providerIdentityJson,
    );
    if (
      operation.kind !== "turnInterrupt" ||
      operation.actorId !== stored.actorId ||
      operation.turnId !== stored.turnId ||
      operation.effectKey !== stored.effectKey ||
      operation.requestDigest !== digestCanonical(stored) ||
      !sameOperationRequestLineage(stored, current) ||
      current.observationGeneration < stored.processGeneration
    ) {
      throw new PersistentActorError(
        "conflict",
        "interrupt recovery lost its immutable effect and live observation generations",
      );
    }
    return Object.freeze({
      ...stored,
      observationGeneration: current.observationGeneration,
    });
  }

  #threadRequestForOperation(
    operation: ActorOperationRecord,
  ): PersistentActorThreadRequest {
    const stored = parseStoredThreadRequestEnvelope(operation.providerIdentityJson);
    if (
      operation.kind !== "actorStart" ||
      operation.actorId !== stored.actorId ||
      operation.turnId !== null ||
      operation.effectKey !== stored.effectKey ||
      operation.requestDigest !== digestCanonical(stored)
    ) {
      throw new PersistentActorError(
        "conflict",
        "actor start recovery lost its immutable durable request",
      );
    }
    return stored;
  }

  #tryTransitionOperation(input: Readonly<{
    operation: ActorOperationRecord;
    nextState: ActorOperationRecord["state"];
    providerIdentityJson: string;
  }>): Readonly<{ operation: ActorOperationRecord; changed: boolean }> {
    try {
      return {
        operation: this.#authority.transitionActorOperation({
          operationId: input.operation.id,
          expectedState: input.operation.state,
          nextState: input.nextState,
          providerIdentityJson: input.providerIdentityJson,
          now: this.#timestamp(),
        }),
        changed: true,
      };
    } catch (cause: unknown) {
      const raced = this.#authority.readActorOperation(input.operation.id);
      if (raced === null) throw cause;
      if (
        raced.actorId !== input.operation.actorId ||
        raced.turnId !== input.operation.turnId ||
        raced.kind !== input.operation.kind ||
        raced.requestDigest !== input.operation.requestDigest ||
        raced.effectKey !== input.operation.effectKey
      ) {
        throw new PersistentActorError("conflict", "actor operation identity raced another effect", cause);
      }
      return { operation: raced, changed: false };
    }
  }

  #transitionTurn(
    turnValue: ActorTurn,
    nextState: ActorTurnState,
    outcomeCode: string | null = null,
  ): ActorTurn {
    const turn = this.#requireTurn(turnValue.id);
    if (turn.state === nextState) return turn;
    return this.#authority.transitionActorTurn({
      turnId: turn.id,
      expectedRevision: turn.revision,
      nextState,
      outcomeCode,
      now: this.#timestamp(),
    });
  }

  #markTurnReconciling(turnValue: ActorTurn): ActorTurn {
    const turn = this.#requireTurn(turnValue.id);
    if (turn.state === "reconciling" || isTerminalActorTurnState(turn.state)) return turn;
    if (turn.state !== "starting" && turn.state !== "running") {
      throw new PersistentActorError("invalid_state", "turn cannot enter reconciliation");
    }
    return this.#transitionTurn(turn, "reconciling");
  }

  #transitionAttempt(
    attemptValue: PersistedActorAttempt,
    nextState: ActorAttempt["state"],
    optional: Readonly<{
      providerTurnId?: string | null;
      quotaProofDigest?: string | null;
      inputTokens?: number | null;
      outputTokens?: number | null;
    }> = {},
  ): PersistedActorAttempt {
    const attempt = this.#requireAttempt(attemptValue.id);
    if (attempt.state === nextState) {
      assertAttemptEvidence(attempt, optional);
      return attempt;
    }
    try {
      return this.#authority.transitionActorAttempt({
        attemptId: attempt.id,
        expectedState: attempt.state,
        nextState,
        ...(optional.providerTurnId === undefined
          ? {} : { providerTurnId: optional.providerTurnId }),
        ...(optional.quotaProofDigest === undefined
          ? {} : { quotaProofDigest: optional.quotaProofDigest }),
        ...(optional.inputTokens === undefined ? {} : { inputTokens: optional.inputTokens }),
        ...(optional.outputTokens === undefined ? {} : { outputTokens: optional.outputTokens }),
        now: this.#timestamp(),
      });
    } catch (cause: unknown) {
      const raced = this.#requireAttempt(attempt.id);
      if (raced.state !== nextState) throw cause;
      assertAttemptEvidence(raced, optional);
      return raced;
    }
  }

  #markAttemptReconciling(attemptValue: PersistedActorAttempt): PersistedActorAttempt {
    const attempt = this.#requireAttempt(attemptValue.id);
    if (attempt.state === "reconciling" || isTerminalActorAttemptState(attempt.state)) {
      return attempt;
    }
    if (attempt.state !== "starting" && attempt.state !== "running") {
      throw new PersistentActorError("invalid_state", "attempt cannot enter reconciliation");
    }
    return this.#transitionAttempt(attempt, "reconciling");
  }

  #idleIncarnation(incarnationValue: ActorIncarnationRecord): ActorIncarnationRecord {
    const incarnation = this.#requireIncarnation(incarnationValue.id);
    if (incarnation.state === "idle") return incarnation;
    if (incarnation.state !== "running") {
      throw new PersistentActorError("invalid_state", "only a running incarnation becomes idle");
    }
    return this.#authority.transitionActorIncarnation({
      incarnationId: incarnation.id,
      expectedState: "running",
      nextState: "idle",
      providerThreadId: incarnation.providerThreadId,
      now: this.#timestamp(),
    });
  }

  #closeIncarnation(incarnationValue: ActorIncarnationRecord): ActorIncarnationRecord {
    const incarnation = this.#requireIncarnation(incarnationValue.id);
    if (incarnation.state === "closed") return incarnation;
    if (incarnation.state === "quarantined") return incarnation;
    return this.#authority.transitionActorIncarnation({
      incarnationId: incarnation.id,
      expectedState: incarnation.state,
      nextState: "closed",
      providerThreadId: incarnation.providerThreadId,
      now: this.#timestamp(),
    });
  }

  #assertActorIdleOrReplay(actorId: string, idempotencyKey: string): void {
    const expectedTurnId = deriveOpaqueId("hturn", "turn", [
      this.#requireActor(actorId).epochId,
      actorId,
      idempotencyKey,
    ]);
    const existing = this.#authority.readActorTurn(expectedTurnId);
    if (existing !== null) return;
    const live = this.#readActorReconciliation(actorId).turns;
    if (live.length > 0) {
      throw new PersistentActorError("actor_busy", "actor already has a live logical turn");
    }
    const incarnation = this.#authority.readActiveIncarnationForActor(actorId);
    if (incarnation?.state === "running" || incarnation?.state === "starting") {
      throw new PersistentActorError("actor_busy", "actor is not proven idle");
    }
  }

  #turnView(turnValue: ActorTurn): PersistentActorTurnView {
    const turn = this.#requireTurn(turnValue.id);
    return {
      turn,
      result: this.#authority.readActorResult(resultId(turn.id)),
    };
  }

  #requireEpoch(epochId: string): ActorEpoch {
    const epoch = this.#authority.readActorEpoch(actorEpochIdSchema.parse(epochId));
    if (epoch === null) throw new PersistentActorError("not_found", "actor epoch does not exist");
    return epoch;
  }

  #requireActor(actorId: string): Actor {
    const actor = this.#authority.readActor(actorIdSchema.parse(actorId));
    if (actor === null) throw new PersistentActorError("not_found", "actor does not exist");
    return actor;
  }

  #requireActiveActor(actorId: string): Actor {
    const actor = this.#requireActor(actorId);
    if (actor.state !== "active") {
      throw new PersistentActorError("invalid_state", "actor is not active");
    }
    return actor;
  }

  #requireControlledActor(callerActorId: string, targetActorId: string): Actor {
    const caller = this.#requireActiveActor(callerActorId);
    const target = this.#requireActor(targetActorId);
    if (target.epochId !== caller.epochId || target.parentActorId !== caller.id) {
      throw new PersistentActorError(
        "unauthorized",
        "caller controls only its direct persistent child actors",
      );
    }
    return target;
  }

  #requireControlledTurn(callerActorId: string, turnId: string): ActorTurn {
    const turn = this.#requireTurn(turnId);
    this.#requireControlledActor(callerActorId, turn.actorId);
    return turn;
  }

  #requireTurn(turnId: string): ActorTurn {
    const turn = this.#authority.readActorTurn(actorTurnIdSchema.parse(turnId));
    if (turn === null) throw new PersistentActorError("not_found", "actor turn does not exist");
    return turn;
  }

  #requireAttempt(attemptIdValue: string): PersistedActorAttempt {
    const attempt = this.#authority.readActorAttempt(attemptIdValue);
    if (attempt === null) throw new PersistentActorError("not_found", "actor attempt does not exist");
    return attempt;
  }

  #requireOperation(operationId: string): ActorOperationRecord {
    const operation = this.#authority.readActorOperation(operationId);
    if (operation === null) throw new PersistentActorError("not_found", "actor operation does not exist");
    return operation;
  }

  #requireIncarnation(incarnationId: string): ActorIncarnationRecord {
    const incarnation = this.#authority.readActorIncarnation(incarnationId);
    if (incarnation === null) {
      throw new PersistentActorError("not_found", "actor incarnation does not exist");
    }
    return incarnation;
  }

  #assertActorSessionReady(incarnation: ActorIncarnationRecord): void {
    if (this.#sessionReadiness.isActorSessionReady(incarnation.id)) return;
    throw new PersistentActorError(
      "provider_pending",
      "actor session recovery has not installed this incarnation's exact provider routing",
    );
  }

  #findUnsettledAttempt(turnId: string): PersistedActorAttempt | null {
    const attempts = this.#listAttemptsForTurn(turnId).filter(
      (attempt) => !isTerminalActorAttemptState(attempt.state),
    );
    if (attempts.length > 1) {
      throw new PersistentActorError("conflict", "logical turn has multiple unsettled attempts");
    }
    return attempts[0] ?? null;
  }

  #quarantinedFastCapacityRequest(
    reservation: ActorFastReservationRecordV2,
  ): PersistentActorTurnRequest {
    const attempt = this.#requireAttempt(reservation.attemptId);
    const turn = this.#requireTurn(attempt.turnId);
    const incarnation = this.#requireIncarnation(attempt.incarnationId);
    const actor = this.#requireActor(turn.actorId);
    const epoch = this.#requireEpoch(turn.epochId);
    const operation = this.#requireOperation(
      turnOperationId(turn.id, incarnation.id),
    );
    const request = parseStoredTurnRequestEnvelope(
      operation.providerIdentityJson,
    );
    const operationCanHaveReachedProvider =
      operation.state === "effectStarted" ||
      operation.state === "succeeded" ||
      operation.state === "ambiguous" ||
      operation.state === "recoveryRequired";
    if (
      reservation.state !== "quarantined" ||
      reservation.terminalReason !== "ambiguousProviderEffect" ||
      reservation.epochId !== turn.epochId ||
      reservation.rootActorId !== epoch.rootActorId ||
      reservation.actorId !== turn.actorId ||
      reservation.accountProfileId !== attempt.accountProfileId ||
      reservation.processGeneration !== attempt.effectGeneration ||
      attempt.state !== "ambiguous" ||
      attempt.fastReservationId !== reservation.id ||
      attempt.realizedServiceTier !== "fast" ||
      turn.state !== "ambiguous" ||
      actor.state !== "quarantined" ||
      incarnation.state !== "quarantined" ||
      incarnation.actorId !== turn.actorId ||
      incarnation.accountProfileId !== attempt.accountProfileId ||
      incarnation.providerThreadId === null ||
      operation.kind !== "turnStart" ||
      operation.turnId !== turn.id ||
      operation.actorId !== turn.actorId ||
      !operationCanHaveReachedProvider ||
      operation.effectKey !== request.effectKey ||
      operation.requestDigest !== digestCanonical(request) ||
      request.actorId !== turn.actorId ||
      request.epochId !== turn.epochId ||
      request.turnId !== turn.id ||
      request.incarnationId !== incarnation.id ||
      request.accountProfileId !== attempt.accountProfileId ||
      request.processGeneration !== reservation.processGeneration ||
      request.providerThreadId !== incarnation.providerThreadId ||
      request.modelId !== incarnation.requestedModel ||
      request.reasoningEffort !== incarnation.requestedReasoningEffort ||
      request.requestedAcceleration.mode !== "fast" ||
      request.serviceTier !== "fast" ||
      request.tierFallbackReason !== null ||
      request.fastReservationId !== reservation.id ||
      request.clientUserMessageId !== attempt.clientUserMessageId ||
      request.inputValueId !== turn.inputValueId
    ) {
      throw new PersistentActorError(
        "conflict",
        "quarantined Fast capacity lost its exact ambiguous effect lineage",
      );
    }
    return request;
  }

  #listQuarantinedFastReservationsForAudit(
    hardLimit: number,
  ): readonly ActorFastReservationRecordV2[] {
    const values: ActorFastReservationRecordV2[] = [];
    const seen = new Set<string>();
    let after = this.#fastCapacityAuditCursor;
    let wrapped = after === null;
    scan: while (values.length < hardLimit) {
      const requested = Math.min(
        this.#recoveryPageSize,
        hardLimit - values.length,
      );
      const page = this.#authority.listQuarantinedActorFastReservations({
        after,
        limit: requested,
      });
      for (const reservation of page) {
        if (seen.has(reservation.id)) break scan;
        seen.add(reservation.id);
        values.push(reservation);
        after = Object.freeze({
          updatedAt: reservation.updatedAt,
          reservationId: reservation.id,
        });
      }
      if (values.length >= hardLimit) break;
      if (page.length < requested) {
        if (wrapped) break;
        wrapped = true;
        after = null;
        continue;
      }
      if (page.length === 0) break;
    }
    this.#fastCapacityAuditCursor = values.length === 0
      ? null
      : Object.freeze({
          updatedAt: values.at(-1)!.updatedAt,
          reservationId: values.at(-1)!.id,
        });
    return Object.freeze(values);
  }

  #listActorModelReroutesForAudit(
    hardLimit: number,
  ): readonly ActorModelRerouteInboxRecordV2[] {
    const values: ActorModelRerouteInboxRecordV2[] = [];
    const seen = new Set<string>();
    let after = this.#modelRerouteAuditCursor;
    let wrapped = after === null;
    scan: while (values.length < hardLimit) {
      const requested = Math.min(
        this.#recoveryPageSize,
        hardLimit - values.length,
      );
      const page = this.#authority.listUnsettledActorModelReroutes({
        after,
        limit: requested,
      });
      for (const record of page) {
        if (seen.has(record.attemptId)) break scan;
        seen.add(record.attemptId);
        values.push(record);
        after = Object.freeze({
          updatedAt: record.updatedAt,
          attemptId: record.attemptId,
        });
      }
      if (values.length >= hardLimit) break;
      if (page.length < requested) {
        if (wrapped) break;
        wrapped = true;
        after = null;
        continue;
      }
      if (page.length === 0) break;
    }
    this.#modelRerouteAuditCursor = values.length === 0
      ? null
      : Object.freeze({
          updatedAt: values.at(-1)!.updatedAt,
          attemptId: values.at(-1)!.attemptId,
        });
    return Object.freeze(values);
  }

  #listRecoverableOperations(
    hardLimit = 4_096,
  ): readonly ActorOperationRecord[] {
    const values: ActorOperationRecord[] = [];
    let after: string | null = null;
    while (values.length < hardLimit) {
      const page = this.#authority.listRecoverableActorOperations({
        afterOperationId: after,
        limit: Math.min(this.#recoveryPageSize, hardLimit - values.length),
      });
      values.push(...page);
      if (page.length < Math.min(this.#recoveryPageSize, hardLimit - values.length + page.length)) break;
      after = page.at(-1)?.id ?? null;
      if (after === null) break;
    }
    return values;
  }

  #readTargetedReconciliation(
    input: PersistentActorReconciliationRequestV2,
  ): Readonly<{
    operations: readonly ActorOperationRecord[];
    attempts: readonly PersistedActorAttempt[];
    turns: readonly ActorTurn[];
  }> {
    const operations = new Map<string, ActorOperationRecord>();
    const attempts = new Map<string, PersistedActorAttempt>();
    const turns = new Map<string, ActorTurn>();
    for (const target of actorReconciliationTargets(input)) {
      const rows = this.#authority.readActorReconciliationTarget({
        target,
        limit: input.limit + 1,
      });
      for (const operation of rows.operations) operations.set(operation.id, operation);
      for (const attempt of rows.attempts) attempts.set(attempt.id, attempt);
      for (const turn of rows.turns) turns.set(turn.id, turn);
      if (
        operations.size > input.limit || attempts.size > input.limit ||
        turns.size > input.limit
      ) {
        throw new PersistentActorError(
          "conflict",
          "targeted actor reconciliation exceeds its bounded response",
        );
      }
    }
    return Object.freeze({
      operations: [...operations.values()].toSorted((left, right) =>
        left.id.localeCompare(right.id)),
      attempts: [...attempts.values()].toSorted((left, right) =>
        left.id.localeCompare(right.id)),
      turns: [...turns.values()].toSorted((left, right) =>
        left.id.localeCompare(right.id)),
    });
  }

  #readActorReconciliation(
    actorId: string,
  ): Readonly<{
    operations: readonly ActorOperationRecord[];
    attempts: readonly PersistedActorAttempt[];
    turns: readonly ActorTurn[];
  }> {
    const limit = 4_096;
    const rows = this.#authority.readActorReconciliationTarget({
      target: { kind: "actor", actorId },
      limit: limit + 1,
    });
    if (
      rows.operations.length > limit || rows.attempts.length > limit ||
      rows.turns.length > limit
    ) {
      throw new PersistentActorError(
        "conflict",
        "actor-local recovery state exceeds its bounded safety read",
      );
    }
    return rows;
  }

  #listRecoverableOperationsForAudit(
    hardLimit: number,
  ): readonly ActorOperationRecord[] {
    const page = rotatingAuditPage({
      cursor: this.#operationAuditCursor,
      limit: hardLimit,
      pageSize: this.#recoveryPageSize,
      load: (after, limit) => this.#authority.listRecoverableActorOperations({
        afterOperationId: after,
        limit,
      }),
      key: (operation) => operation.id,
    });
    this.#operationAuditCursor = page.cursor;
    return page.values;
  }

  #listUnsettledAttemptsForAudit(
    hardLimit: number,
  ): readonly PersistedActorAttempt[] {
    const page = rotatingAuditPage({
      cursor: this.#attemptAuditCursor,
      limit: hardLimit,
      pageSize: this.#recoveryPageSize,
      load: (after, limit) => this.#authority.listUnsettledActorAttempts({
        afterAttemptId: after,
        limit,
      }),
      key: (attempt) => attempt.id,
    });
    this.#attemptAuditCursor = page.cursor;
    return page.values;
  }

  #listLiveTurnsForAudit(hardLimit: number): readonly ActorTurn[] {
    const page = rotatingAuditPage({
      cursor: this.#turnAuditCursor,
      limit: hardLimit,
      pageSize: this.#recoveryPageSize,
      load: (after, limit) => this.#authority.listLiveActorTurns({
        afterTurnId: after,
        limit,
      }),
      key: (turn) => turn.id,
    });
    this.#turnAuditCursor = page.cursor;
    return page.values;
  }

  #listLiveTurnsForDeadlineAudit(hardLimit: number): readonly ActorTurn[] {
    const page = rotatingAuditPage({
      cursor: this.#deadlineTurnAuditCursor,
      limit: hardLimit,
      pageSize: this.#recoveryPageSize,
      load: (after, limit) => this.#authority.listLiveActorTurns({
        afterTurnId: after,
        limit,
      }),
      key: (turn) => turn.id,
    });
    this.#deadlineTurnAuditCursor = page.cursor;
    return page.values;
  }

  #listAttemptsForTurn(
    turnId: string,
    hardLimit = 1_024,
  ): readonly PersistedActorAttempt[] {
    const values: PersistedActorAttempt[] = [];
    let afterOrdinal: number | null = null;
    while (values.length < hardLimit) {
      const requested = Math.min(
        this.#recoveryPageSize,
        hardLimit - values.length,
      );
      const page = this.#authority.listActorAttempts({
        turnId,
        ...(afterOrdinal === null ? {} : { afterOrdinal }),
        limit: requested,
      });
      values.push(...page);
      if (page.length < requested) return values;
      afterOrdinal = page.at(-1)?.ordinal ?? null;
      if (afterOrdinal === null) return values;
    }
    const overflow = this.#authority.listActorAttempts({
      turnId,
      ...(afterOrdinal === null ? {} : { afterOrdinal }),
      limit: 1,
    });
    if (overflow.length !== 0) {
      throw new PersistentActorError(
        "conflict",
        "logical actor turn exceeds its bounded attempt history",
      );
    }
    return values;
  }

  #assertNoLiveDescendants(actorValue: Actor): void {
    const root = this.#requireActor(actorValue.id);
    const durableLimit = Math.min(
      root.budget.maxDurableDescendants,
      HARNESS_MAX_DURABLE_DESCENDANTS,
    );
    const pending: Actor[] = [root];
    const seen = new Set<string>([root.id]);
    let durableCount = 0;

    for (let parentIndex = 0; parentIndex < pending.length; parentIndex += 1) {
      const parent = pending[parentIndex]!;
      let afterActorId: string | null = null;
      for (;;) {
        const remainingWithOverflowWitness = durableLimit - durableCount + 1;
        const requested = Math.min(
          ACTOR_CHILD_PAGE_SIZE,
          remainingWithOverflowWitness,
        );
        const page = z.array(actorSchema).max(ACTOR_CHILD_PAGE_SIZE).parse(
          this.#authority.listActorChildren({
            parentActorId: parent.id,
            afterActorId,
            limit: requested,
          }),
        );
        if (page.length > requested) {
          throw new PersistentActorError(
            "conflict",
            "actor descendant page exceeded its requested bound",
          );
        }
        let previousActorId = afterActorId;
        for (const child of page) {
          if (
            child.parentActorId !== parent.id || child.epochId !== root.epochId ||
            child.depth !== parent.depth + 1 || seen.has(child.id) ||
            (previousActorId !== null && child.id <= previousActorId)
          ) {
            throw new PersistentActorError(
              "conflict",
              "actor descendant paging returned incoherent lineage or order",
            );
          }
          previousActorId = child.id;
          durableCount += 1;
          if (durableCount > durableLimit) {
            throw new PersistentActorError(
              "conflict",
              "actor descendants exceed their durable bound",
            );
          }
          seen.add(child.id);
          pending.push(child);
          if (child.state === "active" || child.state === "stopRequested") {
            throw new PersistentActorError(
              "actor_busy",
              "actor cannot stop while a descendant remains live",
            );
          }
        }
        if (page.length < requested) break;
        afterActorId = page.at(-1)?.id ?? null;
        if (afterActorId === null) {
          throw new PersistentActorError(
            "conflict",
            "actor descendant paging did not advance",
          );
        }
      }
    }
  }

  #deadline(callerActorId: string, timeoutMs: number): number {
    const caller = this.#requireActiveActor(callerActorId);
    return Math.min(
      Date.parse(caller.budget.deadline),
      this.#clock.now().getTime() + timeoutMs,
    );
  }

  async #sleepUntilPoll(deadline: number, signal?: AbortSignal): Promise<void> {
    const remaining = deadline - this.#clock.now().getTime();
    if (remaining <= 0) return;
    try {
      await this.#clock.sleep(Math.min(remaining, this.#waitPollMilliseconds), signal);
    } catch (cause: unknown) {
      if (signal?.aborted === true) {
        throw new PersistentActorError("aborted", "actor wait was aborted", cause);
      }
      throw cause;
    }
  }

  async #awaitLivenessUntil(
    turnIds: readonly string[],
    deadline: number,
    signal?: AbortSignal,
  ): Promise<"current" | "timeout"> {
    this.#throwIfAborted(signal);
    const remaining = deadline - this.#clock.now().getTime();
    if (remaining <= 0) return "timeout";
    const convergence = this.#liveness.ensureCurrent({ turnIds });
    const deadlineAbort = new AbortController();
    const onCallerAbort = () => deadlineAbort.abort(signal?.reason);
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    const callerBound = this.#clock.sleep(remaining, deadlineAbort.signal).then(
      () => "timeout" as const,
      (cause: unknown) => {
        if (signal?.aborted === true) {
          throw new PersistentActorError(
            "aborted",
            "actor wait was aborted",
            cause,
          );
        }
        throw cause;
      },
    );
    // Promise.race observes both branches even after one wins. Caller timeout
    // or cancellation therefore never cancels or leaves the shared durable
    // reconciliation promise unhandled for other waiters.
    try {
      const result = await Promise.race([
        convergence.then(() => "current" as const),
        callerBound,
      ]);
      if (result === "current") deadlineAbort.abort();
      return result;
    } finally {
      signal?.removeEventListener("abort", onCallerAbort);
      deadlineAbort.abort();
    }
  }

  #throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted === true) {
      throw new PersistentActorError("aborted", "actor wait was aborted", signal.reason);
    }
  }

  #timestamp(): string {
    return canonicalTimestampSchema.parse(this.#clock.now().toISOString());
  }
}

const storedEnvelopeSchema = z.object({
  version: z.literal(1),
  request: z.record(z.string(), z.unknown()),
  outcome: z.unknown().optional(),
}).strict();

function parseWaitInput(value: unknown): z.infer<typeof waitInputSchema> {
  const input = waitInputSchema.parse(value);
  if (new Set(input.turnIds).size !== input.turnIds.length) {
    throw new PersistentActorError("conflict", "wait turn identities must be unique");
  }
  return input;
}

function parseStoredThreadEnvelope(value: string | null): Readonly<{
  request: PersistentActorThreadRequest;
  outcome: PersistentActorThreadOutcome;
}> {
  const envelope = parseStoredEnvelope(value);
  const request = parseThreadRequest(envelope.request);
  const outcome = persistentActorThreadOutcomeSchema.parse(envelope.outcome);
  return { request, outcome };
}

function parseStoredThreadRequestEnvelope(
  value: string | null,
): PersistentActorThreadRequest {
  return parseThreadRequest(parseStoredEnvelope(value).request);
}

function parseStoredTurnEnvelope(value: string | null): Readonly<{
  request: PersistentActorTurnRequest;
  outcome: PersistentActorTurnOutcome;
}> {
  const envelope = parseStoredEnvelope(value);
  const request = parseTurnRequest(envelope.request);
  const outcome = persistentActorTurnOutcomeSchema.parse(envelope.outcome);
  return { request, outcome };
}

function parseStoredTurnRequestEnvelope(
  value: string | null,
): PersistentActorTurnRequest {
  return parseTurnRequest(parseStoredEnvelope(value).request);
}

function parseStoredInterruptRequestEnvelope(
  value: string | null,
): PersistentActorInterruptRequest {
  return parseInterruptRequest(parseStoredEnvelope(value).request);
}

function parseStoredEnvelope(value: string | null): z.infer<typeof storedEnvelopeSchema> {
  if (value === null) {
    throw new PersistentActorError("invalid_state", "provider operation lacks its request envelope");
  }
  try {
    return storedEnvelopeSchema.parse(JSON.parse(value) as unknown);
  } catch (cause: unknown) {
    throw new PersistentActorError("invalid_state", "provider operation envelope is corrupt", cause);
  }
}

function parseThreadRequest(value: unknown): PersistentActorThreadRequest {
  const request = z.object({
    actorId: actorIdSchema,
    epochId: actorEpochIdSchema,
    policyVersion: actorPolicyVersionSchema.default(0),
    workClass: persistedActorWorkClassSchema.default("legacyUnclassified"),
    accountProfileId: accountProfileIdSchema,
    processGeneration: z.number().int().positive().safe(),
    modelId: z.enum(["gpt-5.6-sol", "gpt-5.6-luna"])
      .default("gpt-5.6-sol"),
    reasoningEffort: z.enum(["ultra", "max"]).default("ultra"),
    selectedProfile: metaharnessProfileKeySchema.default("solUltra"),
    profileFallbackReason: metaharnessProfileFallbackReasonSchema.nullable()
      .default(null),
    capabilityEvidenceDigest: digestSchema.nullable().default(null),
    supportsFast: z.boolean().default(false),
    clientRequestId: requestIdentitySchema,
    threadSource: z.string().min(16).max(256),
    toolsetDigest: digestSchema,
    workspaceLaneId: laneIdSchema,
    effectKey: digestSchema,
    continuation: persistentActorQuotaContinuationSchema.nullable().default(null),
  }).strict().parse(value);
  if (
    (request.policyVersion === 0) !==
      (request.workClass === "legacyUnclassified") ||
    (request.policyVersion === 0) !==
      (request.capabilityEvidenceDigest === null)
  ) {
    throw new PersistentActorError(
      "conflict",
      "actor start request policy evidence is inconsistent",
    );
  }
  return request;
}

function parseTurnRequest(value: unknown): PersistentActorTurnRequest {
  const request = z.object({
    actorId: actorIdSchema,
    epochId: actorEpochIdSchema,
    turnId: actorTurnIdSchema,
    incarnationId: z.string().min(16).max(96),
    accountProfileId: accountProfileIdSchema,
    processGeneration: z.number().int().positive().safe(),
    observationGeneration: z.number().int().positive().safe(),
    providerThreadId: boundedIdentitySchema,
    modelId: z.enum(["gpt-5.6-sol", "gpt-5.6-luna"])
      .default("gpt-5.6-sol"),
    reasoningEffort: z.enum(["ultra", "max"]).default("ultra"),
    requestedAcceleration: actorTurnAccelerationSchema
      .default(STANDARD_ACTOR_TURN_ACCELERATION),
    serviceTier: metaharnessTierSchema.default("standard"),
    tierFallbackReason: metaharnessFastFallbackReasonSchema.nullable()
      .default(null),
    capabilityEvidenceDigest: digestSchema.nullable().default(null),
    fastReservationId: z.string().min(16).max(96)
      .regex(/^hfast_[A-Za-z0-9_-]+$/u).nullable().default(null),
    toolsetDigest: digestSchema.default(
      HRA_RLM_PREDECESSOR_DYNAMIC_TOOL_SPEC_SHA256,
    ),
    clientUserMessageId: requestIdentitySchema,
    inputValueId: valueIdSchema,
    effectKey: digestSchema,
    continuation: persistentActorQuotaContinuationSchema.nullable().default(null),
  }).strict().parse(value);
  if (request.observationGeneration < request.processGeneration) {
    throw new PersistentActorError(
      "conflict",
      "turn observation generation predates its immutable effect generation",
    );
  }
  return request;
}

function parseInterruptRequest(value: unknown): PersistentActorInterruptRequest {
  const request = z.object({
    actorId: actorIdSchema,
    turnId: actorTurnIdSchema,
    incarnationId: z.string().min(16).max(96),
    accountProfileId: accountProfileIdSchema,
    processGeneration: z.number().int().positive().safe(),
    observationGeneration: z.number().int().positive().safe(),
    providerThreadId: boundedIdentitySchema,
    providerTurnId: boundedIdentitySchema,
    effectKey: digestSchema,
  }).strict().parse(value);
  if (request.observationGeneration < request.processGeneration) {
    throw new PersistentActorError(
      "conflict",
      "interrupt observation generation predates its immutable effect generation",
    );
  }
  return request;
}

function parseStoredOperationRequest(
  operation: ActorOperationRecord,
): PersistentActorThreadRequest | PersistentActorTurnRequest |
  PersistentActorInterruptRequest {
  const request = parseStoredEnvelope(operation.providerIdentityJson).request;
  switch (operation.kind) {
    case "actorStart":
      return parseThreadRequest(request);
    case "turnStart":
      return parseTurnRequest(request);
    case "turnInterrupt":
      return parseInterruptRequest(request);
  }
}

function sameOperationRequestLineage(
  left: PersistentActorThreadRequest | PersistentActorTurnRequest |
    PersistentActorInterruptRequest,
  right: PersistentActorThreadRequest | PersistentActorTurnRequest |
    PersistentActorInterruptRequest,
): boolean {
  if ("clientRequestId" in left || "clientRequestId" in right) {
    return "clientRequestId" in left && "clientRequestId" in right &&
      digestCanonical(left) === digestCanonical(right);
  }
  if ("clientUserMessageId" in left || "clientUserMessageId" in right) {
    if (!("clientUserMessageId" in left) || !("clientUserMessageId" in right)) {
      return false;
    }
    return digestCanonical(turnRequestLineage(left)) ===
      digestCanonical(turnRequestLineage(right));
  }
  if (!("providerTurnId" in left) || !("providerTurnId" in right)) return false;
  return digestCanonical(interruptRequestLineage(left)) ===
    digestCanonical(interruptRequestLineage(right));
}

function turnRequestLineage(request: PersistentActorTurnRequest): object {
  return {
    actorId: request.actorId,
    epochId: request.epochId,
    turnId: request.turnId,
    incarnationId: request.incarnationId,
    accountProfileId: request.accountProfileId,
    providerThreadId: request.providerThreadId,
    modelId: request.modelId,
    reasoningEffort: request.reasoningEffort,
    requestedAcceleration: request.requestedAcceleration,
    serviceTier: request.serviceTier,
    tierFallbackReason: request.tierFallbackReason,
    capabilityEvidenceDigest: request.capabilityEvidenceDigest,
    fastReservationId: request.fastReservationId,
    toolsetDigest: request.toolsetDigest,
    clientUserMessageId: request.clientUserMessageId,
    inputValueId: request.inputValueId,
    effectKey: request.effectKey,
    continuation: request.continuation,
  };
}

function samePreparedTurnIntent(
  left: PersistentActorTurnRequest,
  right: PersistentActorTurnRequest,
): boolean {
  const stableIntent = (request: PersistentActorTurnRequest) => ({
    actorId: request.actorId,
    epochId: request.epochId,
    turnId: request.turnId,
    incarnationId: request.incarnationId,
    accountProfileId: request.accountProfileId,
    providerThreadId: request.providerThreadId,
    modelId: request.modelId,
    reasoningEffort: request.reasoningEffort,
    requestedAcceleration: request.requestedAcceleration,
    toolsetDigest: request.toolsetDigest,
    clientUserMessageId: request.clientUserMessageId,
    inputValueId: request.inputValueId,
    effectKey: request.effectKey,
    continuation: request.continuation,
  });
  return digestCanonical(stableIntent(left)) ===
    digestCanonical(stableIntent(right));
}

function interruptRequestLineage(
  request: PersistentActorInterruptRequest,
): object {
  return {
    actorId: request.actorId,
    turnId: request.turnId,
    incarnationId: request.incarnationId,
    accountProfileId: request.accountProfileId,
    providerThreadId: request.providerThreadId,
    providerTurnId: request.providerTurnId,
    effectKey: request.effectKey,
  };
}

function storedThreadOrTurnEnvelope(input: Readonly<{
  request: PersistentActorThreadRequest | PersistentActorTurnRequest |
    PersistentActorInterruptRequest;
  outcome?: PersistentActorThreadOutcome | PersistentActorTurnOutcome |
    PersistentActorInterruptOutcome;
}>): string {
  return canonicalJson({
    version: 1,
    request: input.request,
    ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
  });
}

function isTerminalObservation(value: unknown): value is PersistentActorTerminalObservation {
  return persistentActorTerminalObservationSchema.safeParse(value).success;
}

function assertAttemptEvidence(
  attempt: PersistedActorAttempt,
  expected: Readonly<{
    providerTurnId?: string | null;
    quotaProofDigest?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
  }>,
): void {
  if (
    (expected.providerTurnId !== undefined &&
      attempt.providerTurnId !== expected.providerTurnId) ||
    (expected.quotaProofDigest !== undefined &&
      attempt.quotaProofDigest !== expected.quotaProofDigest) ||
    (expected.inputTokens !== undefined &&
      attempt.inputTokens !== expected.inputTokens) ||
    (expected.outputTokens !== undefined &&
      attempt.outputTokens !== expected.outputTokens)
  ) {
    throw new PersistentActorError(
      "conflict",
      "duplicate provider observation conflicts with durable attempt evidence",
    );
  }
}

function isDefinitiveQuota(
  outcome: PersistentActorThreadOutcome | PersistentActorTurnOutcome,
): boolean {
  return outcome.kind === "notApplied" && outcome.reason === "quota" &&
    isDefinitiveNotApplied(outcome);
}

function isDefinitiveNotApplied(
  outcome: Extract<
    PersistentActorThreadOutcome | PersistentActorTurnOutcome,
    { kind: "notApplied" }
  >,
): boolean {
  return outcome.proof.definitive && outcome.proof.phase === "preEffect";
}

// Released actor rows and receipts bind these exact predecessor domain bytes.
const LEGACY_OPRTE_RECOVERY_REQUIRED_DIGEST_DOMAIN =
  "oprte.recovery-required.v1";
const LEGACY_OPRTE_ACTOR_EFFECT_DIGEST_DOMAIN = "oprte.actor.effect.v2";

function recoveryProof(): PersistentActorEffectProof {
  return {
    digest: createHash("sha256")
      .update(LEGACY_OPRTE_RECOVERY_REQUIRED_DIGEST_DOMAIN)
      .digest("hex"),
    observedAt: "1970-01-01T00:00:00.000Z",
    definitive: false,
    phase: "observation",
  };
}

function deriveOpaqueId(
  prefix: string,
  namespace: string,
  parts: readonly (string | number)[],
): string {
  const hash = createHash("sha256").update(`oprte.${namespace}.v2\0`);
  for (const part of parts) hash.update(String(part)).update("\0");
  return `${prefix}_${hash.digest("base64url").slice(0, 48)}`;
}

function actorStartSelectionOperationId(
  actorId: string,
  candidates: readonly PersistentActorAccountCandidate[],
): string {
  const identities = candidates.map((candidate) => canonicalJson({
    accountProfileId: candidate.accountProfileId,
    processGeneration: candidate.processGeneration,
    modelId: candidate.modelId,
    reasoningEffort: candidate.reasoningEffort,
    profileFallbackReason: candidate.profileFallbackReason,
    capabilityEvidenceDigest: candidate.capabilityEvidenceDigest,
  })).toSorted();
  return deriveOpaqueId("hoperation", "actor-start-selection", [
    actorId,
    ...identities,
  ]);
}

function turnOperationId(turnId: string, incarnationId: string): string {
  return deriveOpaqueId("hoperation", "turn-start", [turnId, incarnationId]);
}

function interruptOperationId(turnId: string, incarnationId: string): string {
  return deriveOpaqueId("hoperation", "turn-interrupt", [turnId, incarnationId]);
}

function incarnationIdFor(operationId: string): string {
  return deriveOpaqueId("hincarnation", "incarnation", [operationId]);
}

function accountLeaseIdFor(operationId: string): string {
  return deriveOpaqueId("haccountlease", "account-lease", [operationId]);
}

function attemptId(turnId: string, incarnationId: string): string {
  return deriveOpaqueId("hattempt", "attempt", [turnId, incarnationId]);
}

function fastReservationIdFor(turnId: string, incarnationId: string): string {
  return deriveOpaqueId("hfast", "fast-reservation", [turnId, incarnationId]);
}

function resultId(turnId: string): string {
  return actorResultIdSchema.parse(deriveOpaqueId("hresult", "result", [turnId]));
}

function workspaceBindingId(actorId: string): string {
  return deriveOpaqueId("hbinding", "workspace-binding", [actorId]);
}

function clientRequestId(operationId: string): string {
  return deriveOpaqueId("client", "thread-request", [operationId]);
}

function clientMessageId(turnId: string, incarnationId: string): string {
  return deriveOpaqueId("message", "turn-message", [turnId, incarnationId]);
}

function effectKey(operationId: string, subtype: string): string {
  return digestCanonical([
    LEGACY_OPRTE_ACTOR_EFFECT_DIGEST_DOMAIN,
    operationId,
    subtype,
  ]);
}

function digestCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort(compareText).map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}

function isTerminalTurnView(view: PersistentActorTurnView): boolean {
  return isTerminalActorTurnState(view.turn.state);
}

function sortTerminalViews(
  views: readonly PersistentActorTurnView[],
): readonly PersistentActorTurnView[] {
  return [...views].sort((left, right) => {
    const leftSequence = left.result?.rootCompletionSequence ?? Number.MAX_SAFE_INTEGER;
    const rightSequence = right.result?.rootCompletionSequence ?? Number.MAX_SAFE_INTEGER;
    return leftSequence - rightSequence || compareText(left.turn.id, right.turn.id);
  });
}

function compareTurns(left: ActorTurn, right: ActorTurn): number {
  return left.ordinal - right.ordinal || compareText(left.id, right.id);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
