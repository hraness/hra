import { z } from "@hra-internal/schema";

import {
  agentIdSchema,
  dispatchIdSchema,
  epochMsSchema,
  positiveGenerationSchema,
  repositoryIdSchema,
  runInteractionIdSchema,
  taskKeySchema,
  taskPublicIdSchema,
  taskReferenceIdSchema,
  taskSubmissionIdSchema,
} from "./identifiers";
import {
  portableRunInteractionResponseSchema,
} from "./interactions";
import {
  portableTaskCommandKindValues,
  type PortableTaskCommandKind,
} from "./operations";
import { taskWorkspaceViewSchema } from "./projections";
import {
  MAX_TASK_LABELS,
  reviewReasonSchema,
  taskCommentBodySchema,
  taskDescriptionSchema,
  taskLabelSchema,
  taskPrioritySchema,
  taskReferenceInputSchema,
  taskTitleSchema,
  taskTypeSchema,
} from "./task";

export const taskWorkspaceClientNavigationIntentKindValues = [
  "view.select",
  "task.select",
  "page.load_more",
] as const;

/**
 * Top-level concurrency observations identify the read a command was built
 * from, not the user-requested effect. Durable retry identity excludes these
 * fields while retaining every nested and semantic value.
 */
export const taskWorkspaceMutationFenceFieldValues = Object.freeze([
  "expectedReviewRevision",
  "expectedTaskRevision",
  "expectedWorkspaceRevision",
  "revision",
  "reviewRevision",
  "taskRevision",
] as const);

type NonClientTaskWorkspaceMutationIntentKind =
  | "workspace.rename"
  | "task.create_and_run"
  | "task.submit"
  | "interaction.settle";
export type TaskWorkspaceClientMutationIntentKind = Exclude<
  PortableTaskCommandKind,
  NonClientTaskWorkspaceMutationIntentKind
>;

const nonClientTaskWorkspaceMutationIntentKinds = new Set<
  PortableTaskCommandKind
>([
  "workspace.rename",
  "task.create_and_run",
  "task.submit",
  "interaction.settle",
]);

export const taskWorkspaceClientMutationIntentKindValues =
  Object.freeze(portableTaskCommandKindValues.filter(
    (kind): kind is TaskWorkspaceClientMutationIntentKind =>
      !nonClientTaskWorkspaceMutationIntentKinds.has(kind),
  ));

export const taskWorkspaceClientIntentKindValues = [
  ...taskWorkspaceClientNavigationIntentKindValues,
  ...taskWorkspaceClientMutationIntentKindValues,
] as const;
export const taskWorkspaceClientIntentKindSchema = z.enum(
  taskWorkspaceClientIntentKindValues,
);
export type TaskWorkspaceClientIntentKind = z.infer<
  typeof taskWorkspaceClientIntentKindSchema
>;

const selectedViewFields = {
  view: taskWorkspaceViewSchema,
  assignedAgentId: agentIdSchema.optional(),
} as const;

const taskIntentFields = {
  taskId: taskPublicIdSchema,
  expectedTaskRevision: positiveGenerationSchema,
} as const;

const taskCreationFields = {
  title: taskTitleSchema,
  description: taskDescriptionSchema.optional(),
  type: taskTypeSchema,
  priority: taskPrioritySchema,
  availableAt: epochMsSchema.optional(),
  labels: z.array(taskLabelSchema).max(MAX_TASK_LABELS),
  parentKey: taskKeySchema.optional(),
  repositoryId: repositoryIdSchema.optional(),
} as const;

export const taskWorkspaceClientIntentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("view.select"),
    ...selectedViewFields,
  }).strict(),
  z.object({
    kind: z.literal("task.select"),
    taskId: taskPublicIdSchema.nullable(),
  }).strict(),
  z.object({
    kind: z.literal("page.load_more"),
  }).strict(),
  z.object({
    kind: z.literal("task.create"),
    ...taskCreationFields,
  }).strict(),
  z.object({
    kind: z.literal("task.update"),
    ...taskIntentFields,
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
    kind: z.literal("task.cancel"),
    ...taskIntentFields,
    reason: reviewReasonSchema,
  }).strict(),
  z.object({
    kind: z.literal("task.reopen"),
    ...taskIntentFields,
  }).strict(),
  z.object({
    kind: z.literal("task.assign"),
    ...taskIntentFields,
    assigneeAgentId: agentIdSchema.nullable(),
  }).strict(),
  z.object({
    kind: z.literal("task.defer"),
    ...taskIntentFields,
    availableAt: epochMsSchema,
  }).strict(),
  z.object({
    kind: z.literal("task.parent_set"),
    ...taskIntentFields,
    parentKey: taskKeySchema,
  }).strict(),
  z.object({
    kind: z.literal("task.parent_clear"),
    ...taskIntentFields,
  }).strict(),
  z.object({
    kind: z.literal("task.label_add"),
    ...taskIntentFields,
    label: taskLabelSchema,
  }).strict(),
  z.object({
    kind: z.literal("task.label_remove"),
    ...taskIntentFields,
    label: taskLabelSchema,
  }).strict(),
  z.object({
    kind: z.literal("task.comment_add"),
    taskId: taskPublicIdSchema,
    body: taskCommentBodySchema,
  }).strict(),
  z.object({
    kind: z.literal("task.reference_add"),
    ...taskIntentFields,
    reference: taskReferenceInputSchema,
  }).strict(),
  z.object({
    kind: z.literal("task.reference_remove"),
    ...taskIntentFields,
    referenceId: taskReferenceIdSchema,
  }).strict(),
  z.object({
    kind: z.literal("dependency.add"),
    ...taskIntentFields,
    blockerKey: taskKeySchema,
  }).strict(),
  z.object({
    kind: z.literal("dependency.remove"),
    ...taskIntentFields,
    blockerKey: taskKeySchema,
  }).strict(),
  z.object({
    kind: z.literal("review.accept"),
    taskId: taskPublicIdSchema,
    submissionId: taskSubmissionIdSchema,
    expectedReviewRevision: positiveGenerationSchema,
  }).strict(),
  z.object({
    kind: z.literal("review.reject"),
    taskId: taskPublicIdSchema,
    submissionId: taskSubmissionIdSchema,
    expectedReviewRevision: positiveGenerationSchema,
    reason: reviewReasonSchema,
  }).strict(),
  z.object({
    kind: z.literal("dispatch.stop"),
    runId: dispatchIdSchema,
  }).strict(),
  z.object({
    kind: z.literal("dispatch.retry"),
    taskId: taskPublicIdSchema,
    expectedTaskRevision: positiveGenerationSchema,
    sourceRunId: dispatchIdSchema,
  }).strict(),
  z.object({
    kind: z.literal("dispatch.resolve_ambiguity"),
    taskId: taskPublicIdSchema,
    expectedTaskRevision: positiveGenerationSchema,
    sourceRunId: dispatchIdSchema,
    reason: z.enum(["confirmed_cancelled", "declared_failed"]),
  }).strict(),
  z.object({
    kind: z.literal("interaction.respond"),
    runId: dispatchIdSchema,
    interactionId: runInteractionIdSchema,
    response: portableRunInteractionResponseSchema,
  }).strict(),
]).superRefine((intent, context) => {
  if (
    intent.kind === "view.select" &&
    intent.view !== "assigned" &&
    intent.assignedAgentId !== undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "only assigned views may carry an assigned-agent filter",
      path: ["assignedAgentId"],
    });
  }
  if (intent.kind === "task.create") {
    if (new Set(intent.labels).size !== intent.labels.length) {
      context.addIssue({
        code: "custom",
        message: "task labels must be unique",
        path: ["labels"],
      });
    }
  }
});
export type TaskWorkspaceClientIntent = z.infer<
  typeof taskWorkspaceClientIntentSchema
>;

export type TaskWorkspaceClientMutationIntent = Exclude<
  TaskWorkspaceClientIntent,
  Readonly<{ kind: "page.load_more" | "task.select" | "view.select" }>
>;

export const taskWorkspaceInteractionResponseSemanticInputSchema = z.object({
  kind: z.literal("interaction.respond"),
  interactionId: runInteractionIdSchema,
  runId: dispatchIdSchema,
}).strict();
export type TaskWorkspaceInteractionResponseSemanticInput = z.infer<
  typeof taskWorkspaceInteractionResponseSemanticInputSchema
>;
export type TaskWorkspaceMutationSemanticInput =
  | TaskWorkspaceClientIntent
  | TaskWorkspaceInteractionResponseSemanticInput;

/**
 * Builds the target-only identity that lets the server verify an encrypted
 * interaction response without learning or fingerprinting its plaintext.
 */
export function taskWorkspaceInteractionResponseSemanticKey(
  value: TaskWorkspaceInteractionResponseSemanticInput,
): Readonly<TaskWorkspaceInteractionResponseSemanticInput> {
  return Object.freeze(
    taskWorkspaceInteractionResponseSemanticInputSchema.parse(value),
  );
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) &&
    value.every((entry): entry is string => typeof entry === "string");
}

function semanticRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Canonicalizes the set-like fields shared by browser and trusted-runtime
 * mutation commands while retaining every other caller-owned field.
 *
 * Callers remain responsible for parsing the command and omitting top-level
 * optimistic-concurrency fences. This deliberately accepts the richer trusted
 * runtime command shape, whose generated IDs and resolved graph targets are
 * not part of the narrower browser intent schema.
 */
export function normalizeTaskWorkspaceSemanticValue(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  let normalized: Readonly<Record<string, unknown>> = value;
  if (
    (value.kind === "task.create" || value.kind === "task.create_and_run") &&
    stringArray(value.labels)
  ) {
    normalized = {
      ...normalized,
      labels: Object.freeze([...value.labels].sort()),
    };
  }
  if (
    value.kind === "interaction.respond" &&
    semanticRecord(value.response) &&
    value.response.kind === "user_input" &&
    Array.isArray(value.response.answers) &&
    value.response.answers.every((answer) =>
      semanticRecord(answer) &&
      typeof answer.questionId === "string" &&
      stringArray(answer.selectedOptionIds)
    )
  ) {
    const answers = value.response.answers.map((answer) => {
      const record = answer as Readonly<Record<string, unknown>> & Readonly<{
        questionId: string;
        selectedOptionIds: readonly string[];
      }>;
      return Object.freeze({
        ...record,
        selectedOptionIds: Object.freeze([...record.selectedOptionIds].sort()),
      });
    }).sort(({ questionId: left }, { questionId: right }) =>
      left < right ? -1 : left > right ? 1 : 0
    );
    normalized = {
      ...normalized,
      response: Object.freeze({
        ...value.response,
        answers: Object.freeze(answers),
      }),
    };
  }
  return Object.freeze(normalized);
}

/**
 * Returns the provider-neutral semantic identity of one validated mutation.
 * Read-observation fences never distinguish retries. Interaction answers are
 * one-shot encrypted payloads, so their durable identity is the authority
 * target and the first accepted answer wins.
 */
export function taskWorkspaceMutationSemanticKey(
  value: TaskWorkspaceMutationSemanticInput,
): Readonly<Record<string, unknown>> {
  if (
    value.kind === "interaction.respond" &&
    !("response" in value)
  ) {
    return taskWorkspaceInteractionResponseSemanticKey(value);
  }
  const intent = taskWorkspaceClientIntentSchema.parse(value);
  if (
    intent.kind === "page.load_more" ||
    intent.kind === "task.select" ||
    intent.kind === "view.select"
  ) {
    throw new TypeError("Task workspace navigation has no mutation semantic key.");
  }
  if (intent.kind === "interaction.respond") {
    return taskWorkspaceInteractionResponseSemanticKey({
      kind: intent.kind,
      interactionId: intent.interactionId,
      runId: intent.runId,
    });
  }
  const semantic = normalizeTaskWorkspaceSemanticValue(Object.fromEntries(
    Object.entries(intent).filter(
      ([key]) =>
        !(taskWorkspaceMutationFenceFieldValues as readonly string[])
          .includes(key),
    ),
  ));
  return semantic;
}
