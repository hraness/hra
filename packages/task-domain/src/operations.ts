import { z } from "@hra-internal/schema";

import {
  agentIdSchema,
  dispatchIdSchema,
  epochMsSchema,
  operationIdSchema,
  operationReceiptIdSchema,
  positiveGenerationSchema,
  repositoryIdSchema,
  runnerInstallationIdSchema,
  runInteractionIdSchema,
  taskCommentIdSchema,
  taskPublicIdSchema,
  taskReferenceIdSchema,
  taskSubmissionIdSchema,
  workspaceEventIdSchema,
  workspaceEventSequenceSchema,
  workspacePublicIdSchema,
} from "./identifiers";
import {
  portableRunInteractionRequestSchema,
  portableRunInteractionResponseSchema,
  portableRunInteractionSettlementSchema,
  validatePortableRunInteractionResponse,
} from "./interactions";
import { runPhaseSchema, type RunPhase } from "./dispatch";
import {
  reviewReasonSchema,
  submissionEvidenceInputSchema,
  submissionSummarySchema,
  taskCommentBodySchema,
  taskDescriptionSchema,
  taskEventTypeSchema,
  taskLabelSchema,
  taskPrioritySchema,
  taskTitleSchema,
  taskTypeSchema,
  taskReferenceInputSchema,
  workspaceNameSchema,
  type TaskEventType,
} from "./task";

export const localOwnerAuthoritySchema = z.object({
  kind: z.literal("local_owner"),
  workspaceId: workspacePublicIdSchema,
  installationId: runnerInstallationIdSchema,
}).strict();
export type LocalOwnerAuthority = z.infer<typeof localOwnerAuthoritySchema>;

export const workspaceAuthoritySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local"),
    localWorkspaceId: workspacePublicIdSchema,
    ownerInstallationId: runnerInstallationIdSchema,
  }).strict(),
  z.object({
    kind: z.literal("promoting"),
    localWorkspaceId: workspacePublicIdSchema,
    promotionId: z.string().regex(/^promotion_[0-9A-HJKMNP-TV-Z]{26}$/u),
    phase: z.enum([
      "snapshot_frozen",
      "staging",
      "uploading",
      "activating",
      "outcome_unknown",
    ]),
  }).strict(),
  z.object({
    kind: z.literal("cloud"),
    cloudWorkspaceId: workspacePublicIdSchema,
  }).strict(),
]);
export type WorkspaceAuthority = z.infer<typeof workspaceAuthoritySchema>;

export const portableActorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local_owner"),
    installationId: runnerInstallationIdSchema,
  }).strict(),
  z.object({ kind: z.literal("agent"), agentId: agentIdSchema }).strict(),
  z.object({
    kind: z.literal("system"),
    jobKind: z.enum([
      "defer_wake",
      "claim_expiry",
      "run_recovery",
      "interaction_expiry",
      "repair",
      "reconciliation",
    ]),
  }).strict(),
]);
export type PortableActor = z.infer<typeof portableActorSchema>;

const commandBase = {
  operationId: operationIdSchema,
  authority: localOwnerAuthoritySchema,
  expectedWorkspaceRevision: positiveGenerationSchema,
} as const;
const taskCommandBase = {
  ...commandBase,
  taskId: taskPublicIdSchema,
  expectedTaskRevision: positiveGenerationSchema,
} as const;

const taskCreationFields = {
  taskId: taskPublicIdSchema,
  title: taskTitleSchema,
  description: taskDescriptionSchema.optional(),
  type: taskTypeSchema,
  priority: taskPrioritySchema,
  availableAt: epochMsSchema,
  labels: z.array(taskLabelSchema).max(50),
  parentTaskId: taskPublicIdSchema.optional(),
  expectedParentRevision: positiveGenerationSchema.optional(),
} as const;

function taskCreationIssues(
  command: Readonly<{
    expectedParentRevision?: number | undefined;
    labels: readonly string[];
    parentTaskId?: string | undefined;
  }>,
  context: z.RefinementCtx,
): void {
  if (new Set(command.labels).size !== command.labels.length) {
    context.addIssue({
      code: "custom",
      message: "task labels must be unique",
      path: ["labels"],
    });
  }
  if (
    (command.parentTaskId === undefined) !==
      (command.expectedParentRevision === undefined)
  ) {
    context.addIssue({
      code: "custom",
      message: "a task parent and its expected revision must be supplied together",
      path: command.parentTaskId === undefined
        ? ["parentTaskId"]
        : ["expectedParentRevision"],
    });
  }
}

export const portableTaskCommandKindValues = [
  "workspace.rename",
  "task.create",
  "task.create_and_run",
  "task.update",
  "task.cancel",
  "task.reopen",
  "task.assign",
  "task.defer",
  "task.parent_set",
  "task.parent_clear",
  "task.label_add",
  "task.label_remove",
  "task.comment_add",
  "task.reference_add",
  "task.reference_remove",
  "dependency.add",
  "dependency.remove",
  "task.submit",
  "review.accept",
  "review.reject",
  "dispatch.stop",
  "dispatch.retry",
  "dispatch.resolve_ambiguity",
  "interaction.respond",
  "interaction.settle",
] as const;
export const portableTaskCommandKindSchema = z.enum(portableTaskCommandKindValues);

export const portableTaskCommandSchema = z.discriminatedUnion("kind", [
  z.object({
    ...commandBase,
    kind: z.literal("workspace.rename"),
    name: workspaceNameSchema,
  }).strict(),
  z.object({
    ...commandBase,
    kind: z.literal("task.create"),
    ...taskCreationFields,
    repositoryId: repositoryIdSchema.optional(),
  }).strict().superRefine(taskCreationIssues),
  z.object({
    ...commandBase,
    kind: z.literal("task.create_and_run"),
    ...taskCreationFields,
    repositoryId: repositoryIdSchema,
  }).strict().superRefine(taskCreationIssues),
  z.object({
    ...taskCommandBase,
    kind: z.literal("task.update"),
    patch: z.object({
      title: taskTitleSchema.optional(),
      description: taskDescriptionSchema.optional(),
      type: taskTypeSchema.optional(),
      priority: taskPrioritySchema.optional(),
      availableAt: epochMsSchema.optional(),
    }).strict().refine(
      (patch) => Object.keys(patch).length > 0,
      "task update patch cannot be empty",
    ),
  }).strict(),
  z.object({
    ...taskCommandBase,
    kind: z.literal("task.cancel"),
    reason: reviewReasonSchema,
  }).strict(),
  z.object({ ...taskCommandBase, kind: z.literal("task.reopen") }).strict(),
  z.object({
    ...taskCommandBase,
    kind: z.literal("task.assign"),
    assigneeAgentId: agentIdSchema.nullable(),
  }).strict(),
  z.object({
    ...taskCommandBase,
    kind: z.literal("task.defer"),
    availableAt: epochMsSchema,
  }).strict(),
  z.object({
    ...taskCommandBase,
    kind: z.literal("task.parent_set"),
    parentTaskId: taskPublicIdSchema,
    expectedParentRevision: positiveGenerationSchema,
  }).strict(),
  z.object({
    ...taskCommandBase,
    kind: z.literal("task.parent_clear"),
  }).strict(),
  z.object({
    ...taskCommandBase,
    kind: z.literal("task.label_add"),
    label: taskLabelSchema,
  }).strict(),
  z.object({
    ...taskCommandBase,
    kind: z.literal("task.label_remove"),
    label: taskLabelSchema,
  }).strict(),
  z.object({
    ...commandBase,
    taskId: taskPublicIdSchema,
    kind: z.literal("task.comment_add"),
    body: taskCommentBodySchema,
  }).strict(),
  z.object({
    ...taskCommandBase,
    kind: z.literal("task.reference_add"),
    reference: taskReferenceInputSchema,
  }).strict(),
  z.object({
    ...taskCommandBase,
    kind: z.literal("task.reference_remove"),
    referenceId: taskReferenceIdSchema,
  }).strict(),
  z.object({
    ...taskCommandBase,
    kind: z.literal("dependency.add"),
    blockerTaskId: taskPublicIdSchema,
    expectedBlockerRevision: positiveGenerationSchema,
  }).strict(),
  z.object({
    ...taskCommandBase,
    kind: z.literal("dependency.remove"),
    blockerTaskId: taskPublicIdSchema,
    expectedBlockerRevision: positiveGenerationSchema,
  }).strict(),
  z.object({
    ...taskCommandBase,
    kind: z.literal("task.submit"),
    fence: positiveGenerationSchema,
    expectedReviewRevision: positiveGenerationSchema,
    summary: submissionSummarySchema,
    evidence: z.array(submissionEvidenceInputSchema).max(50),
  }).strict(),
  z.object({
    ...commandBase,
    taskId: taskPublicIdSchema,
    kind: z.literal("review.accept"),
    submissionId: taskSubmissionIdSchema,
    expectedReviewRevision: positiveGenerationSchema,
  }).strict(),
  z.object({
    ...commandBase,
    taskId: taskPublicIdSchema,
    kind: z.literal("review.reject"),
    submissionId: taskSubmissionIdSchema,
    expectedReviewRevision: positiveGenerationSchema,
    reason: reviewReasonSchema,
  }).strict(),
  z.object({
    ...commandBase,
    kind: z.literal("dispatch.stop"),
    runId: dispatchIdSchema,
  }).strict(),
  z.object({
    ...commandBase,
    kind: z.literal("interaction.respond"),
    runId: dispatchIdSchema,
    interactionId: runInteractionIdSchema,
    request: portableRunInteractionRequestSchema,
    response: portableRunInteractionResponseSchema,
  }).strict().superRefine((command, context) => {
    if (command.request.id !== command.interactionId) {
      context.addIssue({
        code: "custom",
        message: "interaction response request must match its interaction ID",
        path: ["request", "id"],
      });
    }
    const validation = validatePortableRunInteractionResponse(
      command.request,
      command.response,
    );
    if (!validation.success) {
      context.addIssue({
        code: "custom",
        message: `interaction response does not match its request: ${validation.reason}`,
        path: ["response"],
      });
    }
  }),
  z.object({
    ...taskCommandBase,
    kind: z.literal("dispatch.retry"),
    sourceRunId: z.string().min(12).max(128).regex(/^run_[a-z0-9_-]+$/u),
  }).strict(),
  z.object({
    ...taskCommandBase,
    kind: z.literal("dispatch.resolve_ambiguity"),
    sourceRunId: z.string().min(12).max(128).regex(/^run_[a-z0-9_-]+$/u),
    reason: z.enum(["confirmed_cancelled", "declared_failed"]),
  }).strict(),
  z.object({
    ...taskCommandBase,
    kind: z.literal("interaction.settle"),
    runId: z.string().min(12).max(128).regex(/^run_[a-z0-9_-]+$/u),
    settlement: portableRunInteractionSettlementSchema,
  }).strict(),
]);
export type PortableTaskCommand = z.infer<typeof portableTaskCommandSchema>;
export type PortableTaskCommandKind = PortableTaskCommand["kind"];
/** Commands accepted from the local owner authority. */
export const localOwnerTaskCommandSchema = portableTaskCommandSchema;
export type LocalOwnerTaskCommand = PortableTaskCommand;

type WithoutAuthority<Command> = Command extends Readonly<{
  authority: LocalOwnerAuthority;
}>
  ? Omit<Command, "authority">
  : never;

/**
 * A renderer-safe mutation request. The authority adapter materializes the
 * local-owner envelope or authorizes the same intent for a cloud human.
 */
export type TaskWorkspaceMutationIntent = WithoutAuthority<PortableTaskCommand>;

const INTENT_VALIDATION_AUTHORITY = {
  kind: "local_owner",
  workspaceId: "wsp_00000000000000000000000000",
  installationId: "install_contract_validation",
} as const satisfies LocalOwnerAuthority;

export const taskWorkspaceMutationIntentSchema: z.ZodType<
  TaskWorkspaceMutationIntent
> = z.preprocess((value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Readonly<Record<string, unknown>>;
  if ("authority" in record) {
    return { invalidTaskWorkspaceMutationIntent: true };
  }
  return { ...record, authority: INTENT_VALIDATION_AUTHORITY };
}, portableTaskCommandSchema).transform((command) => {
  const { authority, ...intent } = command;
  void authority;
  return intent;
});

/** Injects installation authority only inside the trusted gateway boundary. */
export function materializeLocalOwnerTaskCommand(
  intent: TaskWorkspaceMutationIntent,
  authority: LocalOwnerAuthority,
): LocalOwnerTaskCommand {
  const parsedIntent = taskWorkspaceMutationIntentSchema.parse(intent);
  return localOwnerTaskCommandSchema.parse({ ...parsedIntent, authority });
}

export const portableSystemCommandKindValues = [
  "defer.wake",
  "claim.expire",
  "run.reconcile",
  "interaction.expire",
  "workspace.repair",
] as const;
export const portableSystemCommandKindSchema = z.enum(
  portableSystemCommandKindValues,
);
export const systemCommandActorJobKinds = {
  "defer.wake": "defer_wake",
  "claim.expire": "claim_expiry",
  "run.reconcile": "run_recovery",
  "interaction.expire": "interaction_expiry",
  "workspace.repair": "repair",
} as const satisfies Record<
  (typeof portableSystemCommandKindValues)[number],
  Extract<PortableActor, { kind: "system" }>["jobKind"]
>;
export const portableSystemCommandSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("defer.wake"),
    operationId: operationIdSchema,
    workspaceId: workspacePublicIdSchema,
    taskId: taskPublicIdSchema,
    expectedTaskRevision: positiveGenerationSchema,
    scheduledFor: epochMsSchema,
  }).strict(),
  z.object({
    kind: z.literal("claim.expire"),
    operationId: operationIdSchema,
    workspaceId: workspacePublicIdSchema,
    taskId: taskPublicIdSchema,
    claimId: z.string().min(1).max(128),
    fence: positiveGenerationSchema,
    leaseGeneration: positiveGenerationSchema,
    expectedDeadline: epochMsSchema,
  }).strict(),
  z.object({
    kind: z.literal("run.reconcile"),
    operationId: operationIdSchema,
    workspaceId: workspacePublicIdSchema,
    runId: dispatchIdSchema,
    bootGeneration: positiveGenerationSchema,
  }).strict(),
  z.object({
    kind: z.literal("interaction.expire"),
    operationId: operationIdSchema,
    workspaceId: workspacePublicIdSchema,
    runId: dispatchIdSchema,
    interactionId: runInteractionIdSchema,
    expectedDeadline: epochMsSchema,
  }).strict(),
  z.object({
    kind: z.literal("workspace.repair"),
    operationId: operationIdSchema,
    workspaceId: workspacePublicIdSchema,
    expectedWorkspaceRevision: positiveGenerationSchema,
  }).strict(),
]);
export type PortableSystemCommand = z.infer<typeof portableSystemCommandSchema>;
export type PortableSystemCommandKind = PortableSystemCommand["kind"];

export const localWorkspaceCommandKindValues = [
  ...portableTaskCommandKindValues,
  ...portableSystemCommandKindValues,
] as const;
export const localWorkspaceCommandKindSchema = z.enum(
  localWorkspaceCommandKindValues,
);
export const localWorkspaceCommandSchema = z.union([
  portableTaskCommandSchema,
  portableSystemCommandSchema,
]);
export type LocalWorkspaceCommand = z.infer<typeof localWorkspaceCommandSchema>;
export type LocalWorkspaceCommandKind = LocalWorkspaceCommand["kind"];

const receiptBase = {
  receiptId: operationReceiptIdSchema,
  operationId: operationIdSchema,
  workspaceId: workspacePublicIdSchema,
  commandKind: localWorkspaceCommandKindSchema,
  commandDigest: z.string().regex(/^sha256_[a-f0-9]{64}$/u),
  recordedAt: epochMsSchema,
} as const;

export const committedOperationResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("workspace"),
    workspaceRevision: positiveGenerationSchema,
  }).strict(),
  z.object({
    kind: z.literal("task_created"),
    taskId: taskPublicIdSchema,
    taskRevision: positiveGenerationSchema,
    runId: dispatchIdSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("task_updated"),
    taskId: taskPublicIdSchema,
    taskRevision: positiveGenerationSchema,
  }).strict(),
  z.object({
    kind: z.literal("comment_added"),
    taskId: taskPublicIdSchema,
    commentId: taskCommentIdSchema,
  }).strict(),
  z.object({
    kind: z.literal("reference_added"),
    taskId: taskPublicIdSchema,
    referenceId: taskReferenceIdSchema,
  }).strict(),
  z.object({
    kind: z.literal("reference_removed"),
    taskId: taskPublicIdSchema,
    referenceId: taskReferenceIdSchema,
  }).strict(),
  z.object({
    kind: z.literal("submission_updated"),
    taskId: taskPublicIdSchema,
    submissionId: taskSubmissionIdSchema,
    taskRevision: positiveGenerationSchema,
  }).strict(),
  z.object({
    kind: z.literal("run_updated"),
    runId: dispatchIdSchema,
    phase: runPhaseSchema,
  }).strict(),
  z.object({
    kind: z.literal("interaction_updated"),
    runId: dispatchIdSchema,
    interactionId: runInteractionIdSchema,
    state: z.enum(["pending", "answered", "resolved", "expired"]),
  }).strict(),
]);
type CommittedOperationResultKind = z.infer<typeof committedOperationResultSchema>["kind"];
export type CommittedOperationResult = z.infer<typeof committedOperationResultSchema>;

export const portableCommandEventKindValues = [
  "task.changed",
  "workspace.renamed",
  "run.changed",
  "interaction.changed",
  "system.defer_woke",
  "system.claim_expired",
  "system.run_reconciled",
  "system.interaction_expired",
  "system.workspace_repaired",
] as const;
export const portableCommandEventKindSchema = z.enum(
  portableCommandEventKindValues,
);
export type PortableCommandEventKind =
  (typeof portableCommandEventKindValues)[number];

export const commandResultKinds = {
  "workspace.rename": ["workspace"],
  "task.create": ["task_created"],
  "task.create_and_run": ["task_created"],
  "task.update": ["task_updated"],
  "task.cancel": ["task_updated"],
  "task.reopen": ["task_updated"],
  "task.assign": ["task_updated"],
  "task.defer": ["task_updated"],
  "task.parent_set": ["task_updated"],
  "task.parent_clear": ["task_updated"],
  "task.label_add": ["task_updated"],
  "task.label_remove": ["task_updated"],
  "task.comment_add": ["comment_added"],
  "task.reference_add": ["reference_added"],
  "task.reference_remove": ["reference_removed"],
  "dependency.add": ["task_updated"],
  "dependency.remove": ["task_updated"],
  "task.submit": ["submission_updated"],
  "review.accept": ["submission_updated"],
  "review.reject": ["submission_updated"],
  "dispatch.stop": ["run_updated"],
  "dispatch.retry": ["run_updated"],
  "dispatch.resolve_ambiguity": ["run_updated"],
  "interaction.respond": ["interaction_updated"],
  "interaction.settle": ["interaction_updated"],
  "defer.wake": ["task_updated"],
  "claim.expire": ["task_updated"],
  "run.reconcile": ["run_updated"],
  "interaction.expire": ["interaction_updated"],
  "workspace.repair": ["workspace"],
} as const satisfies Record<LocalWorkspaceCommandKind, readonly CommittedOperationResultKind[]>;

export const commandEventKinds = {
  "workspace.rename": ["workspace.renamed"],
  "task.create": ["task.changed"],
  "task.create_and_run": ["task.changed", "run.changed"],
  "task.update": ["task.changed"],
  "task.cancel": ["task.changed"],
  "task.reopen": ["task.changed"],
  "task.assign": ["task.changed"],
  "task.defer": ["task.changed"],
  "task.parent_set": ["task.changed"],
  "task.parent_clear": ["task.changed"],
  "task.label_add": ["task.changed"],
  "task.label_remove": ["task.changed"],
  "task.comment_add": ["task.changed"],
  "task.reference_add": ["task.changed"],
  "task.reference_remove": ["task.changed"],
  "dependency.add": ["task.changed"],
  "dependency.remove": ["task.changed"],
  "task.submit": ["task.changed"],
  "review.accept": ["task.changed"],
  "review.reject": ["task.changed"],
  "dispatch.stop": ["run.changed"],
  "dispatch.retry": ["run.changed"],
  "dispatch.resolve_ambiguity": ["run.changed"],
  "interaction.respond": ["interaction.changed"],
  "interaction.settle": ["interaction.changed"],
  "defer.wake": ["system.defer_woke", "task.changed"],
  "claim.expire": ["system.claim_expired", "task.changed"],
  "run.reconcile": ["system.run_reconciled", "run.changed"],
  "interaction.expire": ["system.interaction_expired", "interaction.changed"],
  "workspace.repair": ["system.workspace_repaired"],
} as const satisfies Record<LocalWorkspaceCommandKind, readonly PortableCommandEventKind[]>;

export const commandTaskEventTypes = {
  "task.create": "task.created",
  "task.create_and_run": "task.created",
  "task.update": "task.updated",
  "task.cancel": "task.cancelled",
  "task.reopen": "task.reopened",
  "task.assign": "task.assigned",
  "task.defer": "task.deferred",
  "task.parent_set": "task.parent_set",
  "task.parent_clear": "task.parent_cleared",
  "task.label_add": "task.label_added",
  "task.label_remove": "task.label_removed",
  "task.comment_add": "task.comment_added",
  "task.reference_add": "task.reference_added",
  "task.reference_remove": "task.reference_removed",
  "dependency.add": "dependency.added",
  "dependency.remove": "dependency.removed",
  "task.submit": "task.submitted",
  "review.accept": "task.accepted",
  "review.reject": "task.rejected",
  "defer.wake": "task.became_ready",
  "claim.expire": "task.claim_expired",
} as const satisfies Partial<Record<LocalWorkspaceCommandKind, TaskEventType>>;

export const commandRunPhases = {
  "task.create_and_run": ["queued"],
  "dispatch.stop": ["cancel_requested", "cancelled"],
  "dispatch.retry": ["queued"],
  "dispatch.resolve_ambiguity": ["cancelled", "failed"],
} as const satisfies Partial<Record<LocalWorkspaceCommandKind, readonly RunPhase[]>>;

export const commandInteractionStates = {
  "interaction.respond": ["answered"],
  "interaction.settle": ["resolved", "expired"],
  "interaction.expire": ["expired"],
} as const satisfies Partial<
  Record<
    LocalWorkspaceCommandKind,
    readonly ("pending" | "answered" | "resolved" | "expired")[]
  >
>;

export const taskWorkspaceMutationResultSchema = z.object({
  operationId: operationIdSchema,
  workspaceId: workspacePublicIdSchema,
  commandKind: portableTaskCommandKindSchema,
  workspaceRevision: positiveGenerationSchema,
  projectionRevision: positiveGenerationSchema,
  result: committedOperationResultSchema,
}).strict().superRefine((value, context) => {
  if (
    !commandResultKinds[value.commandKind].some(
      (kind) => kind === value.result.kind,
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "workspace mutation result does not match its intent kind",
      path: ["result", "kind"],
    });
  }
  if (
    value.result.kind === "workspace" &&
    value.result.workspaceRevision !== value.workspaceRevision
  ) {
    context.addIssue({
      code: "custom",
      message: "workspace mutation result revisions must agree",
      path: ["result", "workspaceRevision"],
    });
  }
  if (value.result.kind === "task_created") {
    const requiresRun = value.commandKind === "task.create_and_run";
    const forbidsRun = value.commandKind === "task.create";
    if (
      (requiresRun && value.result.runId === undefined) ||
      (forbidsRun && value.result.runId !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: requiresRun
          ? "create-and-run results require the atomically created run"
          : "create-only results cannot claim a run",
        path: ["result", "runId"],
      });
    }
  }
  if (value.result.kind === "run_updated") {
    const allowed = commandRunPhases[
      value.commandKind as keyof typeof commandRunPhases
    ] as readonly RunPhase[] | undefined;
    if (allowed !== undefined && !allowed.includes(value.result.phase)) {
      context.addIssue({
        code: "custom",
        message: "workspace mutation run phase does not match its intent kind",
        path: ["result", "phase"],
      });
    }
  }
  if (value.result.kind === "interaction_updated") {
    const allowed = commandInteractionStates[
      value.commandKind as keyof typeof commandInteractionStates
    ] as readonly typeof value.result.state[] | undefined;
    if (allowed !== undefined && !allowed.includes(value.result.state)) {
      context.addIssue({
        code: "custom",
        message: "workspace mutation interaction state does not match its intent kind",
        path: ["result", "state"],
      });
    }
  }
});
export type TaskWorkspaceMutationResult = z.infer<
  typeof taskWorkspaceMutationResultSchema
>;

export const operationReceiptSchema = z.discriminatedUnion("outcome", [
  z.object({
    ...receiptBase,
    outcome: z.literal("committed"),
    workspaceRevision: positiveGenerationSchema,
    eventSequence: workspaceEventSequenceSchema,
    eventIds: z.array(workspaceEventIdSchema).min(1).max(16),
    eventKinds: z.array(portableCommandEventKindSchema).min(1).max(16),
    result: committedOperationResultSchema,
  }).strict(),
  z.object({
    ...receiptBase,
    outcome: z.literal("rejected"),
    code: z.enum([
      "authority_mismatch",
      "revision_conflict",
      "invalid_state",
      "graph_cycle",
      "graph_limit",
      "not_found",
      "terminal",
      "capacity_full",
      "operation_conflict",
    ]),
  }).strict(),
]).superRefine((receipt, context) => {
  if (
    receipt.outcome === "committed" &&
    !commandResultKinds[receipt.commandKind].some((kind) => kind === receipt.result.kind)
  ) {
    context.addIssue({
      code: "custom",
      message: "operation result does not match its command kind",
      path: ["result", "kind"],
    });
  }
  if (receipt.outcome === "committed") {
    if (receipt.eventIds.length !== receipt.eventKinds.length) {
      context.addIssue({
        code: "custom",
        message: "receipt event IDs and kinds must have equal cardinality",
        path: ["eventKinds"],
      });
    }
    if (new Set(receipt.eventIds).size !== receipt.eventIds.length) {
      context.addIssue({
        code: "custom",
        message: "receipt event IDs must be unique",
        path: ["eventIds"],
      });
    }
    const requiredEventKinds: readonly string[] =
      commandEventKinds[receipt.commandKind];
    if (
      receipt.eventKinds.length !== requiredEventKinds.length ||
      receipt.eventKinds.some((kind, index) => kind !== requiredEventKinds[index])
    ) {
      context.addIssue({
        code: "custom",
        message: "receipt event kinds must exactly match the command event sequence",
        path: ["eventKinds"],
      });
    }
    receipt.eventKinds.forEach((kind, index) => {
      if (!requiredEventKinds.includes(kind)) {
        context.addIssue({
          code: "custom",
          message: "receipt event kind does not match its command kind",
          path: ["eventKinds", index],
        });
      }
    });
    if (receipt.eventSequence < receipt.eventIds.length) {
      context.addIssue({
        code: "custom",
        message: "receipt final event sequence cannot precede its emitted event count",
        path: ["eventSequence"],
      });
    }
    if (receipt.result.kind === "task_created") {
      const requiresRun = receipt.commandKind === "task.create_and_run";
      const forbidsRun = receipt.commandKind === "task.create";
      if (
        (requiresRun && receipt.result.runId === undefined) ||
        (forbidsRun && receipt.result.runId !== undefined)
      ) {
        context.addIssue({
          code: "custom",
          message: requiresRun
            ? "create-and-run receipts require the atomically created run"
            : "create-only receipts cannot claim a run",
          path: ["result", "runId"],
        });
      }
    }
    if (
      receipt.result.kind === "workspace" &&
      receipt.result.workspaceRevision !== receipt.workspaceRevision
    ) {
      context.addIssue({
        code: "custom",
        message: "workspace result revision must match its committed receipt",
        path: ["result", "workspaceRevision"],
      });
    }
    if (receipt.result.kind === "run_updated") {
      const allowed = commandRunPhases[
        receipt.commandKind as keyof typeof commandRunPhases
      ] as readonly RunPhase[] | undefined;
      if (allowed !== undefined && !allowed.includes(receipt.result.phase)) {
        context.addIssue({
          code: "custom",
          message: "operation result run phase does not match its command kind",
          path: ["result", "phase"],
        });
      }
    }
    if (receipt.result.kind === "interaction_updated") {
      const allowed = commandInteractionStates[
        receipt.commandKind as keyof typeof commandInteractionStates
      ] as readonly typeof receipt.result.state[] | undefined;
      if (allowed !== undefined && !allowed.includes(receipt.result.state)) {
        context.addIssue({
          code: "custom",
          message: "operation result interaction state does not match its command kind",
          path: ["result", "state"],
        });
      }
    }
  }
});
export type OperationReceipt = z.infer<typeof operationReceiptSchema>;

export type OperationReplayDisposition = "execute" | "replay" | "conflict";

export function operationReplayDisposition(
  existing: Readonly<{ operationId: string; commandDigest: string }> | null,
  incoming: Readonly<{ operationId: string; commandDigest: string }>,
): OperationReplayDisposition {
  if (existing === null || existing.operationId !== incoming.operationId) return "execute";
  return existing.commandDigest === incoming.commandDigest ? "replay" : "conflict";
}

const commandEventBase = {
  id: workspaceEventIdSchema,
  workspaceId: workspacePublicIdSchema,
  sequence: workspaceEventSequenceSchema,
  workspaceRevision: positiveGenerationSchema,
  operationId: operationIdSchema,
  commandKind: localWorkspaceCommandKindSchema,
  actor: portableActorSchema,
  recordedAt: epochMsSchema,
} as const;

export const portableWorkspaceEventSchema = z.discriminatedUnion("kind", [
  z.object({
    ...commandEventBase,
    kind: z.literal("task.changed"),
    taskId: taskPublicIdSchema,
    taskRevision: positiveGenerationSchema,
    eventType: taskEventTypeSchema,
  }).strict(),
  z.object({
    id: workspaceEventIdSchema,
    workspaceId: workspacePublicIdSchema,
    sequence: workspaceEventSequenceSchema,
    workspaceRevision: positiveGenerationSchema,
    operationId: operationIdSchema,
    actor: portableActorSchema,
    kind: z.literal("task.imported"),
    taskId: taskPublicIdSchema,
    taskRevision: positiveGenerationSchema,
    sourceWorkspaceId: workspacePublicIdSchema,
    sourceTaskId: taskPublicIdSchema,
    recordedAt: epochMsSchema,
  }).strict(),
  z.object({
    ...commandEventBase,
    kind: z.literal("workspace.renamed"),
  }).strict(),
  z.object({
    ...commandEventBase,
    kind: z.literal("run.changed"),
    taskId: taskPublicIdSchema,
    runId: dispatchIdSchema,
    phase: runPhaseSchema,
  }).strict(),
  z.object({
    ...commandEventBase,
    kind: z.literal("interaction.changed"),
    taskId: taskPublicIdSchema,
    runId: dispatchIdSchema,
    interactionId: runInteractionIdSchema,
    state: z.enum(["pending", "answered", "resolved", "expired"]),
  }).strict(),
  z.object({
    ...commandEventBase,
    kind: z.literal("system.defer_woke"),
    taskId: taskPublicIdSchema,
    scheduledFor: epochMsSchema,
  }).strict(),
  z.object({
    ...commandEventBase,
    kind: z.literal("system.claim_expired"),
    taskId: taskPublicIdSchema,
    claimId: z.string().min(1).max(128),
    fence: positiveGenerationSchema,
  }).strict(),
  z.object({
    ...commandEventBase,
    kind: z.literal("system.run_reconciled"),
    runId: dispatchIdSchema,
    bootGeneration: positiveGenerationSchema,
  }).strict(),
  z.object({
    ...commandEventBase,
    kind: z.literal("system.interaction_expired"),
    runId: dispatchIdSchema,
    interactionId: runInteractionIdSchema,
  }).strict(),
  z.object({
    ...commandEventBase,
    kind: z.literal("system.workspace_repaired"),
  }).strict(),
  z.object({
    id: workspaceEventIdSchema,
    workspaceId: workspacePublicIdSchema,
    sequence: workspaceEventSequenceSchema,
    workspaceRevision: positiveGenerationSchema,
    operationId: operationIdSchema,
    actor: portableActorSchema,
    kind: z.literal("promotion.changed"),
    state: z.enum(["promoting", "activated", "aborted", "outcome_unknown"]),
    recordedAt: epochMsSchema,
  }).strict(),
]).superRefine((event, context) => {
  if (
    event.kind === "task.imported" &&
    event.sourceWorkspaceId === event.workspaceId
  ) {
    context.addIssue({
      code: "custom",
      message: "an imported task source must differ from its destination workspace",
      path: ["sourceWorkspaceId"],
    });
  }
  if ("commandKind" in event) {
    const allowedKinds: readonly string[] = commandEventKinds[event.commandKind];
    if (!allowedKinds.includes(event.kind)) {
      context.addIssue({
        code: "custom",
        message: "workspace event kind does not match its command kind",
        path: ["commandKind"],
      });
    }
    const isSystemCommand = portableSystemCommandKindValues.some(
      (kind) => kind === event.commandKind,
    );
    if ((event.actor.kind === "system") !== isSystemCommand) {
      context.addIssue({
        code: "custom",
        message: "system commands require system actors and owner commands require non-system actors",
        path: ["actor", "kind"],
      });
    }
    if (
      isSystemCommand &&
      event.actor.kind === "system" &&
      event.actor.jobKind !== systemCommandActorJobKinds[
        event.commandKind as PortableSystemCommandKind
      ]
    ) {
      context.addIssue({
        code: "custom",
        message: "system command and actor job kinds must agree",
        path: ["actor", "jobKind"],
      });
    }
    if (event.kind === "task.changed") {
      const expected = commandTaskEventTypes[
        event.commandKind as keyof typeof commandTaskEventTypes
      ] as TaskEventType | undefined;
      if (expected === undefined || event.eventType !== expected) {
        context.addIssue({
          code: "custom",
          message: "task event type does not match its command kind",
          path: ["eventType"],
        });
      }
    }
    if (event.kind === "run.changed") {
      const allowed = commandRunPhases[
        event.commandKind as keyof typeof commandRunPhases
      ] as readonly RunPhase[] | undefined;
      if (allowed !== undefined && !allowed.includes(event.phase)) {
        context.addIssue({
          code: "custom",
          message: "run event phase does not match its command kind",
          path: ["phase"],
        });
      }
    }
    if (event.kind === "interaction.changed") {
      const allowed = commandInteractionStates[
        event.commandKind as keyof typeof commandInteractionStates
      ] as readonly typeof event.state[] | undefined;
      if (allowed !== undefined && !allowed.includes(event.state)) {
        context.addIssue({
          code: "custom",
          message: "interaction event state does not match its command kind",
          path: ["state"],
        });
      }
    }
  }
});
export type PortableWorkspaceEvent = z.infer<typeof portableWorkspaceEventSchema>;
