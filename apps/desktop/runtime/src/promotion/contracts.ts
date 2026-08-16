import {
  promotionCleanupProgressSchema,
  promotionEntityFamilyValues,
  promotionIdSchema,
  promotionManifestV2Schema,
  taskDomain,
  workspacePublicIdSchema,
  type AcceptHRAPromotionBatchRequest,
  type ActivateHRAPromotionRequest,
  type AdvanceHRAPromotionCleanupRequest,
  type IdempotencyKey,
  type PromotionAbortReceiptV2,
  type PromotionActivationReceiptV2,
  type PromotionBatchReceiptPage,
  type PromotionBatchReceiptV2,
  type PromotionBatchV2,
  type PromotionCleanupProgress,
  type PromotionManifestV2,
  type StartHRAPromotionRequest,
  type WorkspaceAuthority,
  type WorkspacePromotionStateV2,
} from "@hraness/agent-tasks-protocol";
import { z } from "@hra-internal/schema";

export const localPromotionFaultCodeValues = [
  "workspace_not_found",
  "authority_conflict",
  "live_local_work",
  "nonportable_task_state",
  "nonportable_executor",
  "unsafe_repository",
  "nonportable_reference",
  "nonportable_evidence",
  "snapshot_capacity_exceeded",
  "snapshot_invalid",
  "state_conflict",
  "receipt_conflict",
  "abort_proof_invalid",
  "activation_proof_invalid",
  "transport_offline",
  "transport_unauthorized",
  "transport_rejected",
  "transport_outcome_unknown",
  "remote_not_found",
  "legacy_session",
] as const;
export const localPromotionFaultCodeSchema = z.enum(
  localPromotionFaultCodeValues,
);
export type LocalPromotionFaultCode = z.infer<
  typeof localPromotionFaultCodeSchema
>;

const retryableFaultCodes = new Set<LocalPromotionFaultCode>([
  "transport_offline",
  "transport_outcome_unknown",
]);

const safeFaultMessages = {
  workspace_not_found: "The local workspace no longer exists.",
  authority_conflict: "The workspace authority changed.",
  live_local_work: "Local work must finish or be abandoned before syncing.",
  nonportable_task_state: "A task is still owned by local execution.",
  nonportable_executor: "The workspace executor cannot be promoted.",
  unsafe_repository: "A repository needs a credential-free HTTPS remote.",
  nonportable_reference: "A task reference cannot be safely promoted.",
  nonportable_evidence: "Submission evidence cannot be safely promoted.",
  snapshot_capacity_exceeded: "The workspace exceeds the promotion limit.",
  snapshot_invalid: "The local workspace snapshot is inconsistent.",
  state_conflict: "The durable promotion state changed.",
  receipt_conflict: "The cloud receipt conflicts with the frozen request.",
  abort_proof_invalid: "The cloud abort proof does not match this promotion.",
  activation_proof_invalid:
    "The cloud activation proof does not match this promotion.",
  transport_offline: "Sync is waiting for a network connection.",
  transport_unauthorized: "Sign in again to continue syncing.",
  transport_rejected: "The cloud rejected this promotion.",
  transport_outcome_unknown:
    "The cloud outcome is being reconciled before syncing can continue.",
  remote_not_found: "The cloud promotion was not found.",
  legacy_session: "This older promotion session requires recovery.",
} as const satisfies Record<LocalPromotionFaultCode, string>;

export class LocalPromotionError extends Error {
  readonly code: LocalPromotionFaultCode;
  readonly retryable: boolean;

  constructor(code: LocalPromotionFaultCode) {
    super(safeFaultMessages[code]);
    this.name = "LocalPromotionError";
    this.code = code;
    this.retryable = retryableFaultCodes.has(code);
  }

  toJSON(): Readonly<{
    code: LocalPromotionFaultCode;
    message: string;
    retryable: boolean;
  }> {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

export const localPromotionPhaseSchema = z.enum([
  "snapshot_frozen",
  "starting",
  "receiving",
  "validating",
  "projecting",
  "ready",
  "activating",
  "outcome_unknown",
  "aborting",
  "activated",
  "aborted",
]);
export type LocalPromotionPhase = z.infer<typeof localPromotionPhaseSchema>;

export const localPromotionFamilyProgressSchema = z.object({
  family: taskDomain.promotionEntityFamilySchema,
  preparedCount: z.number().int().nonnegative().max(500_000),
  acceptedCount: z.number().int().nonnegative().max(500_000),
  acceptedBatchCount: z.number().int().nonnegative().max(1_000_001),
  complete: z.boolean(),
}).strict().superRefine((progress, context) => {
  if (progress.acceptedCount > progress.preparedCount) {
    context.addIssue({
      code: "custom",
      message: "accepted promotion progress exceeds the frozen snapshot",
    });
  }
  if (progress.complete && progress.acceptedCount !== progress.preparedCount) {
    context.addIssue({
      code: "custom",
      message: "completed promotion progress must match the frozen snapshot",
    });
  }
});

export const localPromotionProgressSchema = z.object({
  promotionId: promotionIdSchema,
  sourceWorkspaceId: workspacePublicIdSchema,
  destinationWorkspaceId: workspacePublicIdSchema.nullable(),
  phase: localPromotionPhaseSchema,
  frozenAt: taskDomain.epochMsSchema,
  updatedAt: taskDomain.epochMsSchema,
  preparedEntityCount: z.number().int().nonnegative().max(500_000),
  acceptedEntityCount: z.number().int().nonnegative().max(500_000),
  acceptedBatchCount: z.number().int().nonnegative().max(1_000_001),
  families: z.array(localPromotionFamilyProgressSchema).length(
    promotionEntityFamilyValues.length,
  ),
  nextAttemptAt: taskDomain.epochMsSchema.nullable(),
  fault: z.object({
    code: localPromotionFaultCodeSchema,
    message: z.string().min(1).max(240),
    retryable: z.boolean(),
  }).strict().nullable(),
  canAbort: z.boolean(),
  localWritable: z.boolean(),
  recoveryCopyAvailable: z.boolean(),
  runnerPairing: z.enum(["not_applicable", "pending", "pairing", "paired", "blocked"]),
}).strict().superRefine((progress, context) => {
  if (progress.acceptedEntityCount > progress.preparedEntityCount) {
    context.addIssue({
      code: "custom",
      message: "promotion total exceeds the frozen snapshot",
      path: ["acceptedEntityCount"],
    });
  }
  if (
    progress.phase === "activated" &&
    (
      progress.localWritable ||
      !progress.recoveryCopyAvailable ||
      progress.destinationWorkspaceId === null
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "activated promotion requires cloud authority and recovery",
    });
  }
  if (progress.phase === "aborted" && !progress.localWritable) {
    context.addIssue({
      code: "custom",
      message: "proven abort must restore local writes",
    });
  }
});
export type LocalPromotionProgress = z.infer<
  typeof localPromotionProgressSchema
>;

export const localPromotionRecoveryCopySchema = z.object({
  promotionId: promotionIdSchema,
  localWorkspaceId: workspacePublicIdSchema,
  cloudWorkspaceId: workspacePublicIdSchema,
  access: z.literal("read_only"),
  createdAt: taskDomain.epochMsSchema,
  lastOpenedAt: taskDomain.epochMsSchema.nullable(),
}).strict();
export type LocalPromotionRecoveryCopy = z.infer<
  typeof localPromotionRecoveryCopySchema
>;

export const localPromotionAuthorityOverlaySchema = z.object({
  sourceLocalWorkspaceId: workspacePublicIdSchema,
  presentedWorkspaceId: workspacePublicIdSchema,
  authority: taskDomain.workspaceAuthoritySchema,
  sourceAccess: z.enum(["read_write", "frozen", "read_only_recovery"]),
}).strict().superRefine((overlay, context) => {
  const authorityId = overlay.authority.kind === "cloud"
    ? overlay.authority.cloudWorkspaceId
    : overlay.authority.localWorkspaceId;
  if (authorityId !== overlay.presentedWorkspaceId) {
    context.addIssue({
      code: "custom",
      message: "promotion overlay presentation must follow durable authority",
    });
  }
});
export type LocalPromotionAuthorityOverlay = z.infer<
  typeof localPromotionAuthorityOverlaySchema
>;

export type LocalPromotionTransportFailure =
  | Readonly<{ ok: false; kind: "offline" }>
  | Readonly<{ ok: false; kind: "unauthorized" }>
  | Readonly<{ ok: false; kind: "not_found" }>
  | Readonly<{ ok: false; kind: "rejected" }>
  | Readonly<{ ok: false; kind: "outcome_unknown" }>;

export type LocalPromotionTransportResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | LocalPromotionTransportFailure;

/**
 * Durable operation-key journal used by the HTTP adapter. The implementation
 * must return the same UUIDv7 for an exact replay and reject a changed request
 * digest under the same operation key.
 */
export interface LocalPromotionIdempotencyKeyStore {
  cleanupHttpOperationKey(promotionId: string): string;
  getOrCreateHttpIdempotencyKey(input: Readonly<{
    promotionId: string;
    operationKey: string;
    requestDigest: string;
    now: number;
  }>): IdempotencyKey;
}

/**
 * Promotion-only HTTP port. Implementations adapt the reviewed HRA
 * promotion routes and return already parsed response bodies, never tokens.
 */
export interface LocalPromotionTransport {
  start(
    request: StartHRAPromotionRequest,
  ): Promise<LocalPromotionTransportResult<Readonly<{
    promotionId: string;
    stagingWorkspaceId: string;
    state: "receiving";
  }>>>;
  acceptBatch(
    promotionId: string,
    request: AcceptHRAPromotionBatchRequest,
  ): Promise<LocalPromotionTransportResult<Readonly<{
    receipt: PromotionBatchReceiptV2;
  }>>>;
  lookup(
    promotionId: string,
  ): Promise<LocalPromotionTransportResult<Readonly<{
    promotion: WorkspacePromotionStateV2;
  }>>>;
  activate(
    promotionId: string,
    request: ActivateHRAPromotionRequest,
  ): Promise<LocalPromotionTransportResult<Readonly<{
    receipt: PromotionActivationReceiptV2;
  }>>>;
  abort(
    promotionId: string,
    request: Readonly<{ manifestRoot: string }>,
  ): Promise<LocalPromotionTransportResult<Readonly<{
    receipt: PromotionAbortReceiptV2;
  }>>>;
  listReceipts(
    promotionId: string,
    input: Readonly<{ cursor?: string; limit: number }>,
  ): Promise<LocalPromotionTransportResult<PromotionBatchReceiptPage>>;
  advanceCleanup(
    promotionId: string,
    request: AdvanceHRAPromotionCleanupRequest,
  ): Promise<LocalPromotionTransportResult<Readonly<{
    cleanup: PromotionCleanupProgress;
  }>>>;
  cleanupStatus(
    promotionId: string,
  ): Promise<LocalPromotionTransportResult<Readonly<{
    cleanup: PromotionCleanupProgress;
  }>>>;
}

export interface PreparedLocalPromotionBatch {
  readonly batch: PromotionBatchV2;
  readonly serializedBytes: number;
}

export interface FrozenLocalPromotion {
  readonly manifest: PromotionManifestV2;
  readonly organizationId: string;
}

export type LocalPromotionCheckpoint =
  | "snapshot.after_read_before_persist"
  | "snapshot.after_entities_before_authority"
  | "batch.after_prepare"
  | "batch.after_receipt_before_progress"
  | "activation.after_proof_before_authority"
  | "abort.after_proof_before_authority";

export interface LocalPromotionFaultInjector {
  (checkpoint: LocalPromotionCheckpoint): void;
}

export type LocalPromotionCoordinatorCheckpoint =
  | "start.before_request"
  | "start.after_response_before_persist"
  | "batch.before_request"
  | "batch.after_response_before_persist"
  | "lookup.before_request"
  | "lookup.after_response_before_persist"
  | "activation.before_request"
  | "activation.after_response_before_persist"
  | "abort.before_request"
  | "abort.after_response_before_persist"
  | "cleanup.before_request"
  | "cleanup.after_response_before_persist";

export interface LocalPromotionCoordinatorFaultInjector {
  (checkpoint: LocalPromotionCoordinatorCheckpoint): void;
}

export function promotionTransportFailureCode(
  failure: LocalPromotionTransportFailure,
): LocalPromotionFaultCode {
  switch (failure.kind) {
    case "offline":
      return "transport_offline";
    case "unauthorized":
      return "transport_unauthorized";
    case "not_found":
      return "remote_not_found";
    case "rejected":
      return "transport_rejected";
    case "outcome_unknown":
      return "transport_outcome_unknown";
  }
}

export function assertTransportManifest(value: unknown): PromotionManifestV2 {
  return promotionManifestV2Schema.parse(value);
}

export function assertCleanupProgress(value: unknown): PromotionCleanupProgress {
  return promotionCleanupProgressSchema.parse(value);
}

export function cloudAuthority(cloudWorkspaceId: string): WorkspaceAuthority {
  return taskDomain.workspaceAuthoritySchema.parse({
    kind: "cloud",
    cloudWorkspaceId,
  });
}
