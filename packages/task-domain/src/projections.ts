import { z } from "@hra-internal/schema";

import {
  agentIdSchema,
  dispatchIdSchema,
  epochMsSchema,
  positiveGenerationSchema,
  repositoryIdSchema,
  taskKeySchema,
  taskPublicIdSchema,
  workspacePublicIdSchema,
} from "./identifiers";
import {
  MAX_RUN_EVENTS,
  publicRunStatusEventKindSchema,
  publicRunTextEventKindSchema,
  runDisplayBudgetAfterBatch,
  runDisplayTextSchema,
  runEventViewSchema,
  runPhaseSchema,
} from "./dispatch";
import { portableRunInteractionRequestSchema } from "./interactions";
import { workspaceAuthoritySchema } from "./operations";
import {
  MAX_TASK_HUMAN_INPUT_PENDING_COUNT,
  MAX_TASK_LABELS,
  submissionEvidenceInputSchema,
  submissionSummarySchema,
  taskCommentBodySchema,
  taskDescriptionSchema,
  taskEventTypeSchema,
  taskHumanInputViewSchema,
  taskLabelSchema,
  taskPrioritySchema,
  taskReferenceViewSchema,
  taskStatusSchema,
  taskTitleSchema,
  taskTypeSchema,
  taskViewSchema,
  workspaceNameSchema,
  workspaceSlugSchema,
} from "./task";

export const MAX_PORTABLE_PROJECTION_PAGE_SIZE = 100;
export const MAX_PORTABLE_DETAIL_COLLECTION = 500;
export const MAX_PORTABLE_DETAIL_COMMENTS = 100;
export const MAX_PORTABLE_DETAIL_EVENTS = 100;
export const MAX_PORTABLE_DETAIL_REFERENCES = 100;
export const MAX_PORTABLE_DETAIL_RUNS = 50;
export const MAX_PORTABLE_RUN_EVENTS = MAX_RUN_EVENTS;
export const MAX_PORTABLE_CURSOR_CHARACTERS = 8_192;

export const taskWorkspaceViewValues = [
  "all",
  "ready",
  "blocked",
  "deferred",
  "attention",
  "assigned",
  "review",
] as const;
export const taskWorkspaceViewSchema = z.enum(taskWorkspaceViewValues);
export type TaskWorkspaceView = z.infer<typeof taskWorkspaceViewSchema>;

export const taskWorkspaceCountSchema = z.object({
  capped: z.boolean(),
  value: z.number().int().nonnegative().safe(),
}).strict();
export type TaskWorkspaceCount = z.infer<typeof taskWorkspaceCountSchema>;

export const taskWorkspaceCountsSchema = z.record(
  taskWorkspaceViewSchema,
  taskWorkspaceCountSchema,
);
export type TaskWorkspaceCounts = z.infer<typeof taskWorkspaceCountsSchema>;

export const portableTaskChangeKindValues = [
  "run.admitted",
  "run.display_changed",
  "run.event_appended",
  "run.interaction_changed",
  "run.phase_changed",
  "task.submitted",
] as const;
export const portableTaskChangeKindSchema = z.enum(
  portableTaskChangeKindValues,
);

export const taskChangeAffectedProjectionValues = [
  "workspace_summary",
  "task_list",
  "task_detail",
] as const;
const workspaceSummaryAffectedProjectionSchema = z.object({
  projection: z.literal("workspace_summary"),
}).strict();
const allTaskWorkspaceViewsSchema = z.tuple([
  z.literal("all"),
  z.literal("ready"),
  z.literal("blocked"),
  z.literal("deferred"),
  z.literal("attention"),
  z.literal("assigned"),
  z.literal("review"),
]);
const taskListAffectedProjectionSchema = z.object({
  projection: z.literal("task_list"),
  views: allTaskWorkspaceViewsSchema,
}).strict();
const taskDetailAffectedProjectionSchema = z.object({
  projection: z.literal("task_detail"),
}).strict();
export const taskChangeAffectedProjectionSchema = z.discriminatedUnion(
  "projection",
  [
    workspaceSummaryAffectedProjectionSchema,
    taskListAffectedProjectionSchema,
    taskDetailAffectedProjectionSchema,
  ],
);
export type TaskChangeAffectedProjection = z.infer<
  typeof taskChangeAffectedProjectionSchema
>;

export const taskWorkspaceDetailCollectionValues = [
  "blockers",
  "children",
  "comments",
  "dependents",
  "events",
  "references",
  "runs",
] as const;
export const taskWorkspaceDetailCollectionSchema = z.enum(
  taskWorkspaceDetailCollectionValues,
);
export type TaskWorkspaceDetailCollection = z.infer<
  typeof taskWorkspaceDetailCollectionSchema
>;

export const taskWorkspaceRecoveryKindValues = [
  "access_revoked",
  "task_cancelled",
  "submission_rejected",
  "claim_expired",
  "cancelled_blocker",
] as const;
export const taskWorkspaceRecoveryKindSchema = z.enum(taskWorkspaceRecoveryKindValues);
export type TaskWorkspaceRecoveryKind = z.infer<
  typeof taskWorkspaceRecoveryKindSchema
>;
export const taskWorkspaceRecoverySchema = z.object({
  kind: taskWorkspaceRecoveryKindSchema,
}).strict();
export type TaskWorkspaceRecovery = z.infer<
  typeof taskWorkspaceRecoverySchema
>;

export const portableProjectionCursorSchema = z.string()
  .min(1)
  .max(MAX_PORTABLE_CURSOR_CHARACTERS);

export const workspaceSummarySchema = z.object({
  id: workspacePublicIdSchema,
  name: workspaceNameSchema,
  slug: workspaceSlugSchema,
  keyPrefix: z.string().min(2).max(8).regex(/^[A-Z][A-Z0-9]{1,7}$/u),
  revision: positiveGenerationSchema,
  authority: workspaceAuthoritySchema,
  counts: taskWorkspaceCountsSchema,
}).strict().superRefine((workspace, context) => {
  const authorityWorkspaceId = workspace.authority.kind === "cloud"
    ? workspace.authority.cloudWorkspaceId
    : workspace.authority.localWorkspaceId;
  if (authorityWorkspaceId !== workspace.id) {
    context.addIssue({
      code: "custom",
      message: "workspace summary authority must describe the same workspace",
      path: ["authority"],
    });
  }
});
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;

export const workspaceSelectionSchema = z.object({
  workspace: workspaceSummarySchema,
  selectedTaskId: taskPublicIdSchema.nullable(),
  view: taskWorkspaceViewSchema,
}).strict();
export type WorkspaceSelection = z.infer<typeof workspaceSelectionSchema>;

export const taskWorkspaceViewerSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string().min(1).max(128), kind: z.literal("human"), name: z.string().min(1).max(160) }).strict(),
  z.object({
    id: z.string().min(1).max(128),
    kind: z.literal("local_owner"),
    name: z.string().min(1).max(160),
  }).strict(),
]);
export type TaskWorkspaceViewer = z.infer<typeof taskWorkspaceViewerSchema>;

export const projectionActorSchema = z.discriminatedUnion("kind", [
  ...taskWorkspaceViewerSchema.options,
  z.object({
    id: agentIdSchema,
    kind: z.literal("agent"),
    name: z.string().min(1).max(160),
    status: z.enum(["active", "disabled"]),
  }).strict(),
  z.object({
    id: z.string().min(1).max(128),
    kind: z.literal("system"),
    jobKind: z.enum([
      "claim_expiry",
      "defer_wake",
      "run_recovery",
      "interaction_expiry",
      "repair",
      "reconciliation",
    ]),
  }).strict(),
]);
export type ProjectionActor = z.infer<typeof projectionActorSchema>;

export const taskWorkspaceLinkSchema = z.object({
  id: taskPublicIdSchema,
  key: taskKeySchema,
  priority: taskPrioritySchema,
  revision: positiveGenerationSchema,
  status: taskStatusSchema,
  title: taskTitleSchema,
}).strict();
export type TaskWorkspaceLink = z.infer<typeof taskWorkspaceLinkSchema>;

export const taskWorkspaceGraphEdgeSchema = z.object({
  createdAt: epochMsSchema,
  task: taskWorkspaceLinkSchema,
}).strict();
export type TaskWorkspaceGraphEdge = z.infer<
  typeof taskWorkspaceGraphEdgeSchema
>;

export const taskWorkspaceCommentSchema = z.object({
  actor: projectionActorSchema,
  body: taskCommentBodySchema,
  createdAt: epochMsSchema,
  id: z.string().regex(/^cmt_[0-9A-HJKMNP-TV-Z]{26}$/u),
}).strict();
export type TaskWorkspaceComment = z.infer<typeof taskWorkspaceCommentSchema>;

export const taskWorkspaceEventProjectionSchema = z.object({
  actor: projectionActorSchema,
  createdAt: epochMsSchema,
  id: z.string().min(1).max(128),
  summary: z.string().min(1).max(2_048),
  taskRevision: positiveGenerationSchema,
  type: taskEventTypeSchema,
}).strict();
export type TaskWorkspaceEvent = z.infer<
  typeof taskWorkspaceEventProjectionSchema
>;
export type TaskWorkspaceEventProjection = TaskWorkspaceEvent;

export const taskWorkspaceSubmissionSchema = z.object({
  evidence: z.array(submissionEvidenceInputSchema).max(50),
  id: z.string().regex(/^sub_[0-9A-HJKMNP-TV-Z]{26}$/u),
  reviewReason: z.string().min(1).max(16 * 1_024).optional(),
  reviewRevision: positiveGenerationSchema,
  reviewedAt: epochMsSchema.optional(),
  status: z.enum(["pending", "accepted", "rejected", "cancelled"]),
  submittedAt: epochMsSchema,
  submittedBy: projectionActorSchema,
  summary: submissionSummarySchema,
  taskKey: taskKeySchema,
}).strict();
export type TaskWorkspaceSubmission = z.infer<
  typeof taskWorkspaceSubmissionSchema
>;

const runInteractionProjectionBase = {
  runId: dispatchIdSchema,
  request: portableRunInteractionRequestSchema,
} as const;

export type RunInteractionProjectionLifecycle = Readonly<{
  state: "pending" | "answered" | "resolved" | "expired";
  responseRevision?: number | undefined;
  respondedAt?: number | undefined;
  resolvedAt?: number | undefined;
}>;

export function runInteractionProjectionLifecycleValid(
  interaction: RunInteractionProjectionLifecycle,
): boolean {
  switch (interaction.state) {
    case "pending":
      return interaction.responseRevision === undefined &&
        interaction.respondedAt === undefined &&
        interaction.resolvedAt === undefined;
    case "answered":
      return interaction.responseRevision !== undefined &&
        interaction.respondedAt !== undefined &&
        interaction.resolvedAt === undefined;
    case "resolved":
      return interaction.responseRevision !== undefined &&
        interaction.respondedAt !== undefined &&
        interaction.resolvedAt !== undefined &&
        interaction.resolvedAt >= interaction.respondedAt;
    case "expired": {
      const hasResponse = interaction.responseRevision !== undefined ||
        interaction.respondedAt !== undefined;
      return interaction.resolvedAt !== undefined &&
        (
          (!hasResponse &&
            interaction.responseRevision === undefined &&
            interaction.respondedAt === undefined) ||
          (
            interaction.responseRevision !== undefined &&
            interaction.respondedAt !== undefined &&
            interaction.resolvedAt >= interaction.respondedAt
          )
        );
    }
  }
}

export const runInteractionProjectionSchema = z.union([
  z.object({
    ...runInteractionProjectionBase,
    state: z.literal("pending"),
  }).strict(),
  z.object({
    ...runInteractionProjectionBase,
    state: z.literal("answered"),
    responseRevision: positiveGenerationSchema,
    respondedAt: epochMsSchema,
  }).strict(),
  z.object({
    ...runInteractionProjectionBase,
    state: z.literal("resolved"),
    responseRevision: positiveGenerationSchema,
    respondedAt: epochMsSchema,
    resolvedAt: epochMsSchema,
  }).strict().refine(
    runInteractionProjectionLifecycleValid,
    "resolved interaction timestamp must follow its response",
  ),
  z.union([
    z.object({
      ...runInteractionProjectionBase,
      state: z.literal("expired"),
      resolvedAt: epochMsSchema,
    }).strict(),
    z.object({
      ...runInteractionProjectionBase,
      state: z.literal("expired"),
      responseRevision: positiveGenerationSchema,
      respondedAt: epochMsSchema,
      resolvedAt: epochMsSchema,
    }).strict().refine(
      runInteractionProjectionLifecycleValid,
      "expired interaction timestamp must follow its response",
    ),
  ]),
]);
export type RunInteractionProjection = z.infer<
  typeof runInteractionProjectionSchema
>;

export const portableRunProjectionSchema = z.object({
  id: dispatchIdSchema,
  taskKey: taskKeySchema,
  phase: runPhaseSchema,
  repositoryId: repositoryIdSchema,
  desiredState: z.enum(["run", "stop"]),
  updatedAt: epochMsSchema,
  events: z.array(runEventViewSchema).max(MAX_PORTABLE_RUN_EVENTS),
  interactions: z.array(runInteractionProjectionSchema).max(MAX_TASK_HUMAN_INPUT_PENDING_COUNT),
}).strict().superRefine((run, context) => {
  if (new Set(run.events.map(({ id }) => id)).size !== run.events.length) {
    context.addIssue({
      code: "custom",
      message: "run projection event IDs must be unique",
      path: ["events"],
    });
  }
  const eventLaw = runDisplayBudgetAfterBatch({
    acceptedThroughSequence: run.events.length,
    existingEvents: run.events,
    events: [],
  });
  if (eventLaw.kind !== "accepted") {
    context.addIssue({
      code: "custom",
      message: "run projection events violate sequence or display budget laws",
      path: ["events"],
    });
  }
  const interactionIds = new Set<string>();
  run.interactions.forEach((interaction, index) => {
    if (interaction.runId !== run.id) {
      context.addIssue({
        code: "custom",
        message: "interaction projection must belong to the enclosing run",
        path: ["interactions", index, "runId"],
      });
    }
    if (interactionIds.has(interaction.request.id)) {
      context.addIssue({
        code: "custom",
        message: "run projection interaction IDs must be unique",
        path: ["interactions", index, "request", "id"],
      });
    }
    interactionIds.add(interaction.request.id);
  });
});
export type PortableRunProjection = z.infer<typeof portableRunProjectionSchema>;

export const taskWorkspaceListItemSchema = z.object({
  humanInput: taskHumanInputViewSchema.nullable(),
  run: z.object({
    latestDisplay: z.union([
      z.object({
        kind: publicRunStatusEventKindSchema,
        observedAt: epochMsSchema,
      }).strict(),
      z.object({
        kind: publicRunTextEventKindSchema,
        observedAt: epochMsSchema,
        displayText: runDisplayTextSchema,
      }).strict(),
    ]).nullable(),
    phase: runPhaseSchema,
    updatedAt: epochMsSchema,
  }).strict().nullable(),
  task: taskViewSchema,
}).strict().superRefine((item, context) => {
  if (!taskPublicIdSchema.safeParse(item.task.id).success) {
    context.addIssue({
      code: "custom",
      message: "portable list items require stable public task IDs",
      path: ["task", "id"],
    });
  }
});
export type TaskWorkspaceListItem = z.infer<
  typeof taskWorkspaceListItemSchema
>;

export const taskListPageSchema = z.object({
  workspaceId: workspacePublicIdSchema,
  view: taskWorkspaceViewSchema,
  assignedAgentId: agentIdSchema.optional(),
  projectionRevision: positiveGenerationSchema,
  items: z.array(taskWorkspaceListItemSchema).max(MAX_PORTABLE_PROJECTION_PAGE_SIZE),
  cursor: portableProjectionCursorSchema.nullable(),
  hasMore: z.boolean(),
}).strict().superRefine((page, context) => {
  if (page.hasMore !== (page.cursor !== null)) {
    context.addIssue({
      code: "custom",
      message: "a portable task page cursor exists exactly when another page exists",
      path: ["cursor"],
    });
  }
  if (page.view !== "assigned" && page.assignedAgentId !== undefined) {
    context.addIssue({
      code: "custom",
      message: "only assigned views may carry an assigned-agent filter",
      path: ["assignedAgentId"],
    });
  }
  const taskIds = new Set<string>();
  page.items.forEach((item, index) => {
    if (taskIds.has(item.task.id)) {
      context.addIssue({
        code: "custom",
        message: "portable task page task IDs must be unique",
        path: ["items", index, "task", "id"],
      });
    }
    taskIds.add(item.task.id);
  });
});
export type TaskListPage = z.infer<typeof taskListPageSchema>;

const taskWorkspaceDetailFields = {
  task: taskViewSchema,
  description: taskDescriptionSchema,
  labels: z.array(taskLabelSchema).max(MAX_TASK_LABELS),
  parent: taskWorkspaceLinkSchema.nullable(),
  blockers: z.array(taskWorkspaceGraphEdgeSchema).max(MAX_PORTABLE_DETAIL_COLLECTION),
  dependents: z.array(taskWorkspaceGraphEdgeSchema).max(MAX_PORTABLE_DETAIL_COLLECTION),
  children: z.array(taskWorkspaceLinkSchema).max(MAX_PORTABLE_DETAIL_COLLECTION),
  comments: z.array(taskWorkspaceCommentSchema).max(MAX_PORTABLE_DETAIL_COMMENTS),
  events: z.array(taskWorkspaceEventProjectionSchema).max(MAX_PORTABLE_DETAIL_EVENTS),
  references: z.array(taskReferenceViewSchema).max(MAX_PORTABLE_DETAIL_REFERENCES),
  runs: z.array(portableRunProjectionSchema).max(MAX_PORTABLE_DETAIL_RUNS),
  submission: taskWorkspaceSubmissionSchema.nullable(),
  recoveries: z.array(taskWorkspaceRecoverySchema).max(
    taskWorkspaceRecoveryKindValues.length,
  ),
  truncatedCollections: z.array(taskWorkspaceDetailCollectionSchema)
    .max(taskWorkspaceDetailCollectionValues.length),
} as const;

const taskWorkspaceDetailBaseSchema = z.object(
  taskWorkspaceDetailFields,
).strict();
type TaskWorkspaceDetailCandidate = z.infer<
  typeof taskWorkspaceDetailBaseSchema
>;

function taskWorkspaceDetailIssues(
  detail: TaskWorkspaceDetailCandidate,
  context: z.RefinementCtx,
): void {
  if (!taskPublicIdSchema.safeParse(detail.task.id).success) {
    context.addIssue({
      code: "custom",
      message: "portable task detail requires a stable public task ID",
      path: ["task", "id"],
    });
  }
  detail.runs.forEach((run, index) => {
    if (run.taskKey !== detail.task.key) {
      context.addIssue({
        code: "custom",
        message: "run projection task key must match the enclosing task",
        path: ["runs", index, "taskKey"],
      });
    }
  });
  for (const [path, values] of [
    ["labels", detail.labels],
    ["references", detail.references.map(({ id }) => id)],
    ["runs", detail.runs.map(({ id }) => id)],
    ["recoveries", detail.recoveries.map(({ kind }) => kind)],
    ["truncatedCollections", detail.truncatedCollections],
  ] as const) {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", message: `${path} must be unique`, path: [path] });
    }
  }
}

export const taskWorkspaceDetailSchema = taskWorkspaceDetailBaseSchema
  .superRefine(taskWorkspaceDetailIssues);
export type TaskWorkspaceDetail = z.infer<typeof taskWorkspaceDetailSchema>;

export const taskDetailProjectionSchema = z.object({
  workspaceId: workspacePublicIdSchema,
  projectionRevision: positiveGenerationSchema,
  ...taskWorkspaceDetailFields,
}).strict().superRefine(taskWorkspaceDetailIssues);
export type TaskDetailProjection = z.infer<typeof taskDetailProjectionSchema>;

/**
 * `projectionRevision` versions all visible values in this atomic bundle.
 * `continuationRevision` versions only list membership, filtering, and order,
 * so immutable cursors can survive unrelated detail and run-display updates.
 */
export const taskWorkspaceProjectionBundleSchema = z.object({
  workspaceId: workspacePublicIdSchema,
  view: taskWorkspaceViewSchema,
  assignedAgentId: agentIdSchema.optional(),
  selectedTaskId: taskPublicIdSchema.nullable(),
  projectionRevision: positiveGenerationSchema,
  continuationRevision: positiveGenerationSchema,
  firstPage: taskListPageSchema,
  detail: taskDetailProjectionSchema.nullable(),
}).strict().superRefine((bundle, context) => {
  if (bundle.continuationRevision > bundle.projectionRevision) {
    context.addIssue({
      code: "custom",
      message: "continuation revision cannot exceed the atomic projection revision",
      path: ["continuationRevision"],
    });
  }
  if (bundle.view !== "assigned" && bundle.assignedAgentId !== undefined) {
    context.addIssue({
      code: "custom",
      message: "only assigned views may carry an assigned-agent filter",
      path: ["assignedAgentId"],
    });
  }
  if (bundle.firstPage.workspaceId !== bundle.workspaceId) {
    context.addIssue({
      code: "custom",
      message: "first page must belong to the bundle workspace",
      path: ["firstPage", "workspaceId"],
    });
  }
  if (bundle.firstPage.view !== bundle.view) {
    context.addIssue({
      code: "custom",
      message: "first page must use the bundle view",
      path: ["firstPage", "view"],
    });
  }
  if (bundle.firstPage.assignedAgentId !== bundle.assignedAgentId) {
    context.addIssue({
      code: "custom",
      message: "first page must use the bundle assigned-agent filter",
      path: ["firstPage", "assignedAgentId"],
    });
  }
  if (bundle.firstPage.projectionRevision !== bundle.projectionRevision) {
    context.addIssue({
      code: "custom",
      message: "first page must use the bundle projection revision",
      path: ["firstPage", "projectionRevision"],
    });
  }
  if ((bundle.selectedTaskId === null) !== (bundle.detail === null)) {
    context.addIssue({
      code: "custom",
      message: "bundle detail exists exactly when a task is selected",
      path: ["detail"],
    });
  }
  if (bundle.detail === null) return;
  if (bundle.detail.workspaceId !== bundle.workspaceId) {
    context.addIssue({
      code: "custom",
      message: "task detail must belong to the bundle workspace",
      path: ["detail", "workspaceId"],
    });
  }
  if (bundle.detail.projectionRevision !== bundle.projectionRevision) {
    context.addIssue({
      code: "custom",
      message: "task detail must use the bundle projection revision",
      path: ["detail", "projectionRevision"],
    });
  }
  if (bundle.detail.task.id !== bundle.selectedTaskId) {
    context.addIssue({
      code: "custom",
      message: "task detail must describe the selected public task ID",
      path: ["detail", "task", "id"],
    });
  }
});
export type TaskWorkspaceProjectionBundle = z.infer<
  typeof taskWorkspaceProjectionBundleSchema
>;

const portableTaskChangeRecordBase = {
  workspaceId: workspacePublicIdSchema,
  projectionRevision: positiveGenerationSchema,
  scope: z.literal("task_change"),
  taskId: taskPublicIdSchema,
  runId: dispatchIdSchema,
} as const;
const taskChangeAffectedProjectionsSchema = z.tuple([
  taskListAffectedProjectionSchema,
  taskDetailAffectedProjectionSchema,
]);
const taskChangeAffectedProjectionsWithSummarySchema = z.tuple([
  workspaceSummaryAffectedProjectionSchema,
  taskListAffectedProjectionSchema,
  taskDetailAffectedProjectionSchema,
]);

export const portableTaskChangeRecordSchema = z.discriminatedUnion(
  "changeKind",
  [
    z.object({
      ...portableTaskChangeRecordBase,
      changeKind: z.literal("run.admitted"),
      affectedProjections: taskChangeAffectedProjectionsWithSummarySchema,
    }).strict(),
    z.object({
      ...portableTaskChangeRecordBase,
      changeKind: z.literal("run.display_changed"),
      affectedProjections: taskChangeAffectedProjectionsSchema,
    }).strict(),
    z.object({
      ...portableTaskChangeRecordBase,
      changeKind: z.literal("run.event_appended"),
      affectedProjections: z.union([
        taskChangeAffectedProjectionsSchema,
        taskChangeAffectedProjectionsWithSummarySchema,
      ]),
    }).strict(),
    z.object({
      ...portableTaskChangeRecordBase,
      changeKind: z.literal("run.interaction_changed"),
      affectedProjections: taskChangeAffectedProjectionsSchema,
    }).strict(),
    z.object({
      ...portableTaskChangeRecordBase,
      changeKind: z.literal("run.phase_changed"),
      affectedProjections: taskChangeAffectedProjectionsSchema,
    }).strict(),
    z.object({
      ...portableTaskChangeRecordBase,
      changeKind: z.literal("task.submitted"),
      affectedProjections: taskChangeAffectedProjectionsWithSummarySchema,
    }).strict(),
  ],
);
export type PortableTaskChangeRecord = z.infer<
  typeof portableTaskChangeRecordSchema
>;

export const portableInvalidationSchema = z.union([
  z.object({
    workspaceId: workspacePublicIdSchema,
    projectionRevision: positiveGenerationSchema,
    scope: z.literal("workspace"),
  }).strict(),
  z.object({
    workspaceId: workspacePublicIdSchema,
    projectionRevision: positiveGenerationSchema,
    scope: z.literal("task_list"),
    view: taskWorkspaceViewSchema,
  }).strict(),
  z.object({
    workspaceId: workspacePublicIdSchema,
    projectionRevision: positiveGenerationSchema,
    scope: z.literal("task_detail"),
    taskId: taskPublicIdSchema,
  }).strict(),
  portableTaskChangeRecordSchema,
]);
export type PortableInvalidation = z.infer<typeof portableInvalidationSchema>;

// The shared UI list and detail shapes depend on these literals. Exporting the
// complete closed sets gives adapters one seam to verify without importing UI.
export const taskWorkspaceProjectionLiterals = {
  views: taskWorkspaceViewValues,
  detailCollections: taskWorkspaceDetailCollectionValues,
  recoveryKinds: taskWorkspaceRecoveryKindValues,
  taskTypes: taskTypeSchema.options,
} as const;
