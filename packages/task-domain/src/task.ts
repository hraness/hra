import { z } from "@hra-internal/schema";

import {
  agentIdSchema,
  epochMsSchema,
  positiveGenerationSchema,
  repositoryIdSchema,
  taskCommentIdSchema,
  taskKeySchema,
  taskPublicIdSchema,
  taskReferenceIdSchema,
  taskSubmissionIdSchema,
} from "./identifiers";

export const MAX_TASK_DESCRIPTION_BYTES = 32 * 1_024;
export const MAX_TASK_COMMENT_BYTES = 16 * 1_024;
export const MAX_SUBMISSION_SUMMARY_BYTES = 16 * 1_024;
export const MAX_TASK_LABELS = 50;
export const MAX_SUBMISSION_EVIDENCE = 50;
export const MAX_GRAPH_DEPTH = 100;
export const MAX_GRAPH_NODES = 500;
export const MAX_TASK_HUMAN_INPUT_PENDING_COUNT = 32;
export const MAX_TASK_HUMAN_INPUT_PREVIEW_UTF8_BYTES = 512;

function hasOnlyAllowedOwnedTextControls(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint <= 31 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13) ||
        codePoint === 127)
    ) {
      return false;
    }
  }
  return true;
}

function boundedName(maximumBytes: number) {
  return z.string().transform((value) => value.trim()).pipe(
    z.string().min(1)
      .refine(hasOnlyAllowedOwnedTextControls, "name contains a disallowed control character")
      .refine(
        (value) => new TextEncoder().encode(value).length <= maximumBytes,
        `name exceeds ${maximumBytes} UTF-8 bytes`,
      ),
  );
}

function boundedUtf8String(maximumBytes: number, label: string) {
  return z.string()
    .refine(hasOnlyAllowedOwnedTextControls, `${label} contains a disallowed control character`)
    .refine(
      (value) => new TextEncoder().encode(value).length <= maximumBytes,
      `${label} exceeds ${maximumBytes} UTF-8 bytes`,
    );
}

export const taskStatusValues = ["open", "in_progress", "in_review", "done", "cancelled"] as const;
export const taskStatusSchema = z.enum(taskStatusValues);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskTypeValues = ["task", "bug", "feature", "epic", "chore"] as const;
export const taskTypeSchema = z.enum(taskTypeValues);
export type TaskType = z.infer<typeof taskTypeSchema>;

export const taskPrioritySchema = z.number().int().min(0).max(4);
export type TaskPriority = z.infer<typeof taskPrioritySchema>;

export const claimStateValues = ["active", "released", "expired", "submitted", "replaced"] as const;
export const claimStateSchema = z.enum(claimStateValues);
export type ClaimState = z.infer<typeof claimStateSchema>;

export const taskEventTypeValues = [
  "task.created",
  "task.deferred",
  "task.became_ready",
  "task.claimed",
  "task.claim_renewed",
  "task.claim_released",
  "task.claim_expired",
  "task.reclaimed",
  "task.submitted",
  "task.accepted",
  "task.rejected",
  "task.updated",
  "task.cancelled",
  "task.reopened",
  "task.assigned",
  "task.parent_set",
  "task.parent_cleared",
  "task.label_added",
  "task.label_removed",
  "task.comment_added",
  "task.reference_added",
  "task.reference_removed",
  "dependency.added",
  "dependency.removed",
] as const;
export const taskEventTypeSchema = z.enum(taskEventTypeValues);
export type TaskEventType = z.infer<typeof taskEventTypeSchema>;

export const phaseOneTaskEventByTransition = {
  create: "task.created",
  deferWake: "task.became_ready",
  claim: "task.claimed",
  reclaim: "task.reclaimed",
  renew: "task.claim_renewed",
  release: "task.claim_released",
  expire: "task.claim_expired",
} as const satisfies Record<string, TaskEventType>;

export const workspaceSlugSchema = z.string().min(1).max(80)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/u, "invalid workspace slug");
export const workspaceNameSchema = boundedName(160);

export const taskTitleSchema = z.string().min(1)
  .refine(hasOnlyAllowedOwnedTextControls, "task title contains a disallowed control character")
  .refine(
    (value) => new TextEncoder().encode(value).length <= 512,
    "task title exceeds 512 UTF-8 bytes",
  );
export const taskDescriptionSchema = boundedUtf8String(
  MAX_TASK_DESCRIPTION_BYTES,
  "task description",
);
export const taskCommentBodySchema = boundedUtf8String(MAX_TASK_COMMENT_BYTES, "task comment")
  .refine((value) => value.trim().length > 0, "task comment cannot be blank");
export const submissionSummarySchema = boundedUtf8String(
  MAX_SUBMISSION_SUMMARY_BYTES,
  "submission summary",
).refine((value) => value.trim().length > 0, "submission summary cannot be blank");
export const reviewReasonSchema = boundedUtf8String(MAX_TASK_COMMENT_BYTES, "review reason")
  .refine((value) => value.trim().length > 0, "review reason cannot be blank");

export const taskLabelSchema = z.string().transform((value) => value.trim().toLowerCase()).pipe(
  z.string().min(1).max(64)
    .regex(/^[a-z0-9](?:[a-z0-9._/-]{0,62}[a-z0-9])?$/u, "invalid task label"),
);

export const repositoryProviderValues = ["github", "gitlab", "bitbucket", "other"] as const;
export const repositoryProviderSchema = z.enum(repositoryProviderValues);
export type RepositoryProvider = z.infer<typeof repositoryProviderSchema>;

export const absoluteHttpsUrlSchema = z.string().url().max(2_048)
  .refine((value) => new URL(value).protocol === "https:", "URL must use HTTPS")
  .refine((value) => {
    const url = new URL(value);
    return url.username.length === 0 && url.password.length === 0;
  }, "URL must not contain credentials");

export const repositoryNameSchema = boundedName(160);
export const workspaceRepositoryViewSchema = z.object({
  id: repositoryIdSchema,
  name: repositoryNameSchema,
  provider: repositoryProviderSchema,
  url: absoluteHttpsUrlSchema,
  createdAt: epochMsSchema,
}).strict();
export type WorkspaceRepositoryView = z.infer<typeof workspaceRepositoryViewSchema>;

export const taskReferenceKindValues = [
  "repository",
  "pull_request",
  "commit",
  "artifact",
  "url",
] as const;
export const taskReferenceKindSchema = z.enum(taskReferenceKindValues);
export type TaskReferenceKind = z.infer<typeof taskReferenceKindSchema>;

const referenceLabelSchema = boundedName(160);
const commitShaSchema = z.string().regex(/^[0-9a-f]{7,64}$/iu, "invalid commit SHA")
  .transform((value) => value.toLowerCase());

export const taskReferenceInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("repository"), repositoryId: repositoryIdSchema }).strict(),
  z.object({
    kind: z.literal("pull_request"),
    url: absoluteHttpsUrlSchema,
    repositoryId: repositoryIdSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("commit"),
    sha: commitShaSchema,
    repositoryId: repositoryIdSchema.optional(),
    url: absoluteHttpsUrlSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("artifact"),
    name: referenceLabelSchema,
    url: absoluteHttpsUrlSchema,
  }).strict(),
  z.object({
    kind: z.literal("url"),
    label: referenceLabelSchema,
    url: absoluteHttpsUrlSchema,
  }).strict(),
]);
export type TaskReferenceInput = z.infer<typeof taskReferenceInputSchema>;

const taskReferenceViewBase = {
  id: taskReferenceIdSchema,
  createdAt: epochMsSchema,
} as const;
export const taskReferenceViewSchema = z.discriminatedUnion("kind", [
  z.object({
    ...taskReferenceViewBase,
    kind: z.literal("repository"),
    repositoryId: repositoryIdSchema,
  }).strict(),
  z.object({
    ...taskReferenceViewBase,
    kind: z.literal("pull_request"),
    url: absoluteHttpsUrlSchema,
    repositoryId: repositoryIdSchema.optional(),
  }).strict(),
  z.object({
    ...taskReferenceViewBase,
    kind: z.literal("commit"),
    sha: commitShaSchema,
    repositoryId: repositoryIdSchema.optional(),
    url: absoluteHttpsUrlSchema.optional(),
  }).strict(),
  z.object({
    ...taskReferenceViewBase,
    kind: z.literal("artifact"),
    name: referenceLabelSchema,
    url: absoluteHttpsUrlSchema,
  }).strict(),
  z.object({
    ...taskReferenceViewBase,
    kind: z.literal("url"),
    label: referenceLabelSchema,
    url: absoluteHttpsUrlSchema,
  }).strict(),
]);
export type TaskReferenceView = z.infer<typeof taskReferenceViewSchema>;

export const submissionEvidenceInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("commit"),
    sha: commitShaSchema,
    url: absoluteHttpsUrlSchema.optional(),
  }).strict(),
  z.object({ kind: z.literal("pull_request"), url: absoluteHttpsUrlSchema }).strict(),
  z.object({
    kind: z.literal("artifact"),
    name: referenceLabelSchema,
    url: absoluteHttpsUrlSchema,
  }).strict(),
  z.object({
    kind: z.literal("url"),
    label: referenceLabelSchema,
    url: absoluteHttpsUrlSchema,
  }).strict(),
  z.object({
    kind: z.literal("test"),
    command: boundedUtf8String(4_096, "test command")
      .refine((value) => value.trim().length > 0, "test command cannot be blank"),
  }).strict(),
  z.object({
    kind: z.literal("note"),
    text: boundedUtf8String(4_096, "evidence note")
      .refine((value) => value.trim().length > 0, "evidence note cannot be blank"),
  }).strict(),
]);
export type SubmissionEvidenceInput = z.infer<typeof submissionEvidenceInputSchema>;

export const claimViewSchema = z.object({
  id: z.string().min(1),
  agentId: agentIdSchema,
  fence: positiveGenerationSchema,
  leaseGeneration: positiveGenerationSchema,
  leaseUntil: epochMsSchema,
}).strict();
export type ClaimView = z.infer<typeof claimViewSchema>;

export const taskHumanInputViewSchema = z.object({
  pendingCount: z.number().int().min(1).max(MAX_TASK_HUMAN_INPUT_PENDING_COUNT),
  oldestRequestedAt: epochMsSchema,
  expiresAt: epochMsSchema,
  kind: z.enum(["approval", "user_input"]),
  preview: boundedUtf8String(
    MAX_TASK_HUMAN_INPUT_PREVIEW_UTF8_BYTES,
    "human input preview",
  ).refine((value) => value.trim().length > 0, "human input preview cannot be blank"),
}).strict().superRefine((value, context) => {
  if (value.expiresAt <= value.oldestRequestedAt) {
    context.addIssue({
      code: "custom",
      message: "human input expiry must follow its request time",
      path: ["expiresAt"],
    });
  }
});
export type TaskHumanInputView = z.infer<typeof taskHumanInputViewSchema>;

const taskViewBaseSchema = z.object({
  id: taskPublicIdSchema,
  key: taskKeySchema,
  title: taskTitleSchema,
  type: taskTypeSchema,
  priority: taskPrioritySchema,
  availableAt: epochMsSchema,
  isReady: z.boolean(),
  unresolvedBlockerCount: z.number().int().nonnegative(),
  cancelledBlockerCount: z.number().int().nonnegative(),
  revision: positiveGenerationSchema,
  reviewRevision: positiveGenerationSchema,
  assigneeAgentId: agentIdSchema.optional(),
  createdAt: epochMsSchema,
  updatedAt: epochMsSchema,
}).strict();

export const openTaskViewSchema = taskViewBaseSchema.extend({ status: z.literal("open") });
export const inProgressTaskViewSchema = taskViewBaseSchema.extend({
  status: z.literal("in_progress"),
  currentClaim: claimViewSchema,
});
export const inReviewTaskViewSchema = taskViewBaseSchema.extend({ status: z.literal("in_review") });
export const doneTaskViewSchema = taskViewBaseSchema.extend({ status: z.literal("done") });
export const cancelledTaskViewSchema = taskViewBaseSchema.extend({ status: z.literal("cancelled") });
export const taskViewSchema = z.discriminatedUnion("status", [
  openTaskViewSchema,
  inProgressTaskViewSchema,
  inReviewTaskViewSchema,
  doneTaskViewSchema,
  cancelledTaskViewSchema,
]);
export const readyTaskViewSchema = z.discriminatedUnion("status", [
  openTaskViewSchema.extend({
    isReady: z.literal(true),
    unresolvedBlockerCount: z.literal(0),
    cancelledBlockerCount: z.literal(0),
  }),
  inProgressTaskViewSchema.extend({
    isReady: z.literal(false),
    unresolvedBlockerCount: z.literal(0),
    cancelledBlockerCount: z.literal(0),
  }),
]);
export type TaskView = z.infer<typeof taskViewSchema>;

export const taskPortableIdSchemas = {
  repository: repositoryIdSchema,
  reference: taskReferenceIdSchema,
  comment: taskCommentIdSchema,
  submission: taskSubmissionIdSchema,
} as const;
