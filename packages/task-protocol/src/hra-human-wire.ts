import {
  agentIdSchema,
  dispatchIdSchema,
  operationIdSchema,
  portableInvalidationSchema,
  portableTaskCommandKindValues,
  positiveGenerationSchema,
  runInteractionIdSchema,
  taskDetailProjectionSchema,
  taskListPageSchema,
  taskKeySchema,
  taskPublicIdSchema,
  taskWorkspaceLinkSchema,
  taskWorkspaceMutationIntentSchema,
  taskWorkspaceMutationResultSchema,
  taskWorkspaceViewSchema,
  taskWorkspaceViewerSchema,
  workspacePublicIdSchema,
  workspaceRepositoryViewSchema,
  workspaceSummarySchema,
  type TaskWorkspaceMutationIntent,
} from "@hraness/agent-tasks-domain";
import { z } from "@hra-internal/schema";

import { runnerPresenceViewSchema } from "./dispatch";
import { successEnvelopeSchema } from "./errors";
import {
  runInteractionRequestSchema,
  runInteractionRequestDigestSchema,
  sealedRunInteractionResponseSchema,
} from "./interactions";

export const HRA_HUMAN_HTTP_VERSION = 1 as const;
export const HRA_HUMAN_MAX_PAGE_SIZE = 100;
export const HRA_HUMAN_MAX_INVALIDATION_WAIT_MS = 25_000;
// Cursor tokens may survive the rename in persisted profiles and in-flight
// pagination. The prefix is an opaque v1 wire identifier, not product copy.
export const HRA_STABLE_PROJECTION_CURSOR_PREFIX =
  "kitchen_cursor_v1_" as const;

export const hraHumanHeaders = {
  authorization: "Authorization",
  contentType: "Content-Type",
  idempotencyKey: "Idempotency-Key",
} as const;

export const hraWorkspaceRouteParamsSchema = z.object({
  workspaceId: workspacePublicIdSchema,
}).strict();
export const hraTaskRouteParamsSchema = z.object({
  workspaceId: workspacePublicIdSchema,
  taskId: taskPublicIdSchema,
}).strict();
export const hraInteractionRouteParamsSchema = z.object({
  workspaceId: workspacePublicIdSchema,
  runId: dispatchIdSchema,
  interactionId: runInteractionIdSchema,
}).strict();

export const hraHumanMutationKindValues = portableTaskCommandKindValues
  .filter((kind) =>
    kind !== "task.submit" &&
    kind !== "interaction.respond" &&
    kind !== "interaction.settle");
export const hraHumanMutationKindSchema = z.enum(
  hraHumanMutationKindValues,
);
export type HRAHumanMutationKind =
  (typeof hraHumanMutationKindValues)[number];
export type HRAHumanMutationIntent = Extract<
  TaskWorkspaceMutationIntent,
  { kind: HRAHumanMutationKind }
>;

export const hraHumanMutationIntentSchema: z.ZodType<
  HRAHumanMutationIntent
> = taskWorkspaceMutationIntentSchema.refine(
  (intent): intent is HRAHumanMutationIntent =>
    hraHumanMutationKindSchema.safeParse(intent.kind).success,
  "this task intent is not a human workspace mutation",
);

export const hraProjectionCursorTokenSchema = z.string()
  .min(24)
  .max(8_192)
  .regex(new RegExp(
    `^${HRA_STABLE_PROJECTION_CURSOR_PREFIX}[A-Za-z0-9_-]+$`,
    "u",
  ));

export const hraProjectionCursorScopeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("task_list"),
    view: taskWorkspaceViewSchema,
    assignedAgentId: agentIdSchema.optional(),
  }).strict().superRefine((scope, context) => {
    if (scope.view !== "assigned" && scope.assignedAgentId !== undefined) {
      context.addIssue({
        code: "custom",
        message: "only assigned task cursors may identify an agent",
        path: ["assignedAgentId"],
      });
    }
  }),
  z.object({ kind: z.literal("invalidations") }).strict(),
  z.object({ kind: z.literal("workspaces") }).strict(),
  z.object({ kind: z.literal("repositories") }).strict(),
]);

/** Server-issued opaque token plus the immutable projection head it binds. */
export const hraProjectionCursorSchema = z.object({
  version: z.literal(HRA_HUMAN_HTTP_VERSION),
  token: hraProjectionCursorTokenSchema,
  workspaceId: workspacePublicIdSchema.optional(),
  projectionHead: positiveGenerationSchema.optional(),
  scope: hraProjectionCursorScopeSchema,
}).strict().superRefine((cursor, context) => {
  const isWorkspaceScoped = cursor.scope.kind !== "workspaces";
  if (
    isWorkspaceScoped !==
      (cursor.workspaceId !== undefined && cursor.projectionHead !== undefined)
  ) {
    context.addIssue({
      code: "custom",
      message: "workspace cursors must bind both workspace and projection head",
      path: ["projectionHead"],
    });
  }
});
export type HRAProjectionCursor = z.infer<
  typeof hraProjectionCursorSchema
>;

const hraPageLimitQuerySchema = z.string()
  .regex(/^(?:[1-9]|[1-9][0-9]|100)$/u)
  .transform(Number)
  .pipe(z.number().int().min(1).max(HRA_HUMAN_MAX_PAGE_SIZE))
  .optional()
  .transform((value) => value ?? 50);

export const listHRAWorkspacesQuerySchema = z.object({
  cursor: hraProjectionCursorTokenSchema.optional(),
  limit: hraPageLimitQuerySchema,
}).strict();

export const listHRAWorkspacesResponseSchema = z.object({
  workspaces: z.array(workspaceSummarySchema).max(HRA_HUMAN_MAX_PAGE_SIZE),
  cursor: hraProjectionCursorSchema.nullable(),
}).strict().superRefine((response, context) => {
  response.workspaces.forEach((workspace, index) => {
    if (workspace.authority.kind !== "cloud") {
      context.addIssue({
        code: "custom",
        message: "HRA cloud workspace lists cannot invent local authority",
        path: ["workspaces", index, "authority"],
      });
    }
  });
  if (
    response.cursor !== null &&
    response.cursor.scope.kind !== "workspaces"
  ) {
    context.addIssue({
      code: "custom",
      message: "workspace list cursor has the wrong scope",
      path: ["cursor", "scope"],
    });
  }
});
export const listHRAWorkspacesEnvelopeSchema = successEnvelopeSchema(
  listHRAWorkspacesResponseSchema,
);

export const getHRAWorkspaceResponseSchema = z.object({
  workspace: workspaceSummarySchema,
}).strict().superRefine((response, context) => {
  if (response.workspace.authority.kind !== "cloud") {
    context.addIssue({
      code: "custom",
      message: "HRA human HTTP exposes cloud authority only",
      path: ["workspace", "authority"],
    });
  }
});
export const getHRAWorkspaceEnvelopeSchema = successEnvelopeSchema(
  getHRAWorkspaceResponseSchema,
);

export const hraWorkspaceCapabilitiesSchema = z.object({
  canAssign: z.boolean(),
  canCancel: z.boolean(),
  canComment: z.boolean(),
  canCreate: z.boolean(),
  canEdit: z.boolean(),
  canManageGraph: z.boolean(),
  canManageLabels: z.boolean(),
  canManageReferences: z.boolean(),
  canReopen: z.boolean(),
  canReview: z.boolean(),
}).strict();

export const hraWorkspaceAgentSchema = z.object({
  id: agentIdSchema,
  name: z.string().min(1).max(160),
  status: z.enum(["active", "disabled"]),
}).strict();

export const hraWorkspaceRepositorySchema = z.object({
  repository: workspaceRepositoryViewSchema,
  ready: z.boolean(),
}).strict();

export const getHRAWorkspaceContextResponseSchema = z.object({
  workspace: workspaceSummarySchema,
  projectionHead: positiveGenerationSchema,
  viewer: taskWorkspaceViewerSchema,
  capabilities: hraWorkspaceCapabilitiesSchema,
  agents: z.array(hraWorkspaceAgentSchema).max(500),
  runner: runnerPresenceViewSchema,
  repositories: z.array(hraWorkspaceRepositorySchema).max(128),
  serverTime: z.number().int().nonnegative().safe(),
}).strict().superRefine((response, context) => {
  if (response.workspace.authority.kind !== "cloud") {
    context.addIssue({
      code: "custom",
      message: "HRA human context requires cloud workspace authority",
      path: ["workspace", "authority"],
    });
  }
  if (response.viewer.kind !== "human") {
    context.addIssue({
      code: "custom",
      message: "the signed-in cloud context viewer must be human",
      path: ["viewer", "kind"],
    });
  }
  if (response.runner.serverTime !== response.serverTime) {
    context.addIssue({
      code: "custom",
      message: "runner and workspace context must share one server clock",
      path: ["runner", "serverTime"],
    });
  }
  for (const [path, ids] of [
    ["agents", response.agents.map(({ id }) => id)],
    ["repositories", response.repositories.map(({ repository }) =>
      repository.id)],
  ] as const) {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: `HRA context ${path} must be unique`,
        path: [path],
      });
    }
  }
});
export const getHRAWorkspaceContextEnvelopeSchema = successEnvelopeSchema(
  getHRAWorkspaceContextResponseSchema,
);

export const listHRARepositoriesQuerySchema = z.object({
  cursor: hraProjectionCursorTokenSchema.optional(),
  projectionHead: z.string()
    .regex(/^[1-9][0-9]*$/u)
    .transform(Number)
    .pipe(positiveGenerationSchema)
    .optional(),
  limit: hraPageLimitQuerySchema,
}).strict().superRefine((query, context) => {
  if ((query.cursor === undefined) !== (query.projectionHead === undefined)) {
    context.addIssue({
      code: "custom",
      message: "repository cursor and projection head must be supplied together",
      path: ["projectionHead"],
    });
  }
});

export const listHRARepositoriesResponseSchema = z.object({
  workspaceId: workspacePublicIdSchema,
  projectionHead: positiveGenerationSchema,
  repositories: z.array(hraWorkspaceRepositorySchema)
    .max(HRA_HUMAN_MAX_PAGE_SIZE),
  cursor: hraProjectionCursorSchema.nullable(),
}).strict().superRefine((response, context) => {
  if (
    response.cursor !== null &&
    (
      response.cursor.scope.kind !== "repositories" ||
      response.cursor.workspaceId !== response.workspaceId ||
      response.cursor.projectionHead !== response.projectionHead
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "repository cursor must bind its workspace projection head",
      path: ["cursor"],
    });
  }
});
export const listHRARepositoriesEnvelopeSchema = successEnvelopeSchema(
  listHRARepositoriesResponseSchema,
);

export const listHRATasksQuerySchema = z.object({
  view: taskWorkspaceViewSchema,
  assignedAgentId: agentIdSchema.optional(),
  cursor: hraProjectionCursorTokenSchema.optional(),
  projectionHead: z.string()
    .regex(/^[1-9][0-9]*$/u)
    .transform(Number)
    .pipe(positiveGenerationSchema)
    .optional(),
  limit: hraPageLimitQuerySchema,
}).strict().superRefine((query, context) => {
  if (query.view !== "assigned" && query.assignedAgentId !== undefined) {
    context.addIssue({
      code: "custom",
      message: "only assigned task queries may identify an exact agent",
      path: ["assignedAgentId"],
    });
  }
  if ((query.cursor === undefined) !== (query.projectionHead === undefined)) {
    context.addIssue({
      code: "custom",
      message: "task cursor and projection head must be supplied together",
      path: ["projectionHead"],
    });
  }
});

export const listHRATasksResponseSchema = z.object({
  page: taskListPageSchema,
  cursor: hraProjectionCursorSchema.nullable(),
}).strict().superRefine((response, context) => {
  if (
    (response.page.cursor === null) !== (response.cursor === null)
  ) {
    context.addIssue({
      code: "custom",
      message: "task page and bound cursor availability must agree",
      path: ["cursor"],
    });
  }
  if (
    response.cursor !== null &&
    (
      response.cursor.token !== response.page.cursor ||
      response.cursor.workspaceId !== response.page.workspaceId ||
      response.cursor.projectionHead !== response.page.projectionRevision ||
      response.cursor.scope.kind !== "task_list" ||
      response.cursor.scope.view !== response.page.view ||
      response.cursor.scope.assignedAgentId !== response.page.assignedAgentId
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "task cursor must bind the exact immutable list projection",
      path: ["cursor"],
    });
  }
});
export const listHRATasksEnvelopeSchema = successEnvelopeSchema(
  listHRATasksResponseSchema,
);

export const getHRATaskQuerySchema = z.object({
  projectionHead: z.string()
    .regex(/^[1-9][0-9]*$/u)
    .transform(Number)
    .pipe(positiveGenerationSchema)
    .optional(),
}).strict();
export const getHRATaskResponseSchema = z.object({
  workspaceId: workspacePublicIdSchema,
  taskId: taskPublicIdSchema,
  projectionHead: positiveGenerationSchema,
  detail: taskDetailProjectionSchema,
}).strict().superRefine((response, context) => {
  if (
    response.detail.workspaceId !== response.workspaceId ||
    response.detail.task.id !== response.taskId ||
    response.detail.projectionRevision !== response.projectionHead
  ) {
    context.addIssue({
      code: "custom",
      message: "task detail must bind the requested workspace, task, and projection head",
      path: ["detail"],
    });
  }
});
export const getHRATaskEnvelopeSchema = successEnvelopeSchema(
  getHRATaskResponseSchema,
);

export const lookupHRATaskQuerySchema = z.object({
  key: taskKeySchema,
  projectionHead: z.string()
    .regex(/^[1-9][0-9]*$/u)
    .transform(Number)
    .pipe(positiveGenerationSchema)
    .optional(),
}).strict();
export const lookupHRATaskResponseSchema = z.object({
  workspaceId: workspacePublicIdSchema,
  projectionHead: positiveGenerationSchema,
  key: taskKeySchema,
  task: taskWorkspaceLinkSchema.nullable(),
}).strict().superRefine((response, context) => {
  if (response.task !== null && response.task.key !== response.key) {
    context.addIssue({
      code: "custom",
      message: "task lookup result must match the requested key",
      path: ["task", "key"],
    });
  }
});
export const lookupHRATaskEnvelopeSchema = successEnvelopeSchema(
  lookupHRATaskResponseSchema,
);

export const mutateHRAWorkspaceRequestSchema = z.object({
  expectedProjectionHead: positiveGenerationSchema,
  intent: hraHumanMutationIntentSchema,
}).strict();
export type MutateHRAWorkspaceRequest = z.infer<
  typeof mutateHRAWorkspaceRequestSchema
>;
export const mutateHRAWorkspaceResponseSchema = z.object({
  mutation: taskWorkspaceMutationResultSchema,
}).strict();
export const mutateHRAWorkspaceEnvelopeSchema = successEnvelopeSchema(
  mutateHRAWorkspaceResponseSchema,
);

export const respondHRARunInteractionRequestSchema = z.object({
  operationId: operationIdSchema,
  workspaceId: workspacePublicIdSchema,
  expectedWorkspaceRevision: positiveGenerationSchema,
  expectedProjectionHead: positiveGenerationSchema,
  requestDigest: runInteractionRequestDigestSchema,
  sealedResponse: sealedRunInteractionResponseSchema,
}).strict().superRefine((request, context) => {
  if (request.sealedResponse.workspaceId !== request.workspaceId) {
    context.addIssue({
      code: "custom",
      message: "sealed interaction response must bind its workspace",
      path: ["sealedResponse", "workspaceId"],
    });
  }
});
export type RespondHRARunInteractionRequest = z.infer<
  typeof respondHRARunInteractionRequestSchema
>;
export const respondHRARunInteractionResponseSchema = z.object({
  mutation: taskWorkspaceMutationResultSchema,
}).strict();
export const respondHRARunInteractionEnvelopeSchema = successEnvelopeSchema(
  respondHRARunInteractionResponseSchema,
);

export const getHRARunInteractionReplyAuthorityQuerySchema = z.object({
  projectionHead: z.string()
    .regex(/^[1-9][0-9]*$/u)
    .transform(Number)
    .pipe(positiveGenerationSchema),
  requestDigest: runInteractionRequestDigestSchema,
}).strict();

export const getHRARunInteractionReplyAuthorityResponseSchema = z.object({
  workspaceId: workspacePublicIdSchema,
  runId: dispatchIdSchema,
  interactionId: runInteractionIdSchema,
  requestDigest: runInteractionRequestDigestSchema,
  projectionHead: positiveGenerationSchema,
  request: runInteractionRequestSchema,
}).strict().superRefine((response, context) => {
  if (response.request.id !== response.interactionId) {
    context.addIssue({
      code: "custom",
      message: "reply authority request must bind the routed interaction",
      path: ["request", "id"],
    });
  }
  if (response.request.reply.requestDigest !== response.requestDigest) {
    context.addIssue({
      code: "custom",
      message: "reply authority request must bind the requested digest",
      path: ["request", "reply", "requestDigest"],
    });
  }
});
export type GetHRARunInteractionReplyAuthorityResponse = z.infer<
  typeof getHRARunInteractionReplyAuthorityResponseSchema
>;
export const getHRARunInteractionReplyAuthorityEnvelopeSchema =
  successEnvelopeSchema(getHRARunInteractionReplyAuthorityResponseSchema);

export const pollHRAInvalidationsQuerySchema = z.object({
  afterProjectionHead: z.string()
    .regex(/^[0-9]+$/u)
    .transform(Number)
    .pipe(z.number().int().nonnegative().safe()),
  cursor: hraProjectionCursorTokenSchema.optional(),
  cursorProjectionHead: z.string()
    .regex(/^[1-9][0-9]*$/u)
    .transform(Number)
    .pipe(positiveGenerationSchema)
    .optional(),
  limit: hraPageLimitQuerySchema,
  waitMs: z.string()
    .regex(/^[0-9]+$/u)
    .transform(Number)
    .pipe(z.number().int().min(0).max(HRA_HUMAN_MAX_INVALIDATION_WAIT_MS))
    .optional()
    .transform((value) => value ?? HRA_HUMAN_MAX_INVALIDATION_WAIT_MS),
}).strict().superRefine((query, context) => {
  if (
    (query.cursor === undefined) !==
      (query.cursorProjectionHead === undefined)
  ) {
    context.addIssue({
      code: "custom",
      message: "invalidation cursor and projection head must be supplied together",
      path: ["cursorProjectionHead"],
    });
  }
  if (
    query.cursorProjectionHead !== undefined &&
    query.cursorProjectionHead < query.afterProjectionHead
  ) {
    context.addIssue({
      code: "custom",
      message: "invalidation cursor cannot precede its requested head",
      path: ["cursorProjectionHead"],
    });
  }
});

export const pollHRAInvalidationsResponseSchema = z.object({
  workspaceId: workspacePublicIdSchema,
  afterProjectionHead: z.number().int().nonnegative().safe(),
  projectionHead: positiveGenerationSchema,
  invalidations: z.array(portableInvalidationSchema)
    .max(HRA_HUMAN_MAX_PAGE_SIZE),
  cursor: hraProjectionCursorSchema.nullable(),
  hasMore: z.boolean(),
}).strict().superRefine((response, context) => {
  if (response.projectionHead < response.afterProjectionHead) {
    context.addIssue({
      code: "custom",
      message: "invalidation response head cannot move backwards",
      path: ["projectionHead"],
    });
  }
  const invalidationIdentities = new Set<string>();
  let previousRevision = response.afterProjectionHead;
  response.invalidations.forEach((invalidation, index) => {
    if (
      invalidation.workspaceId !== response.workspaceId ||
      invalidation.projectionRevision < previousRevision ||
      invalidation.projectionRevision <= response.afterProjectionHead ||
      invalidation.projectionRevision > response.projectionHead
    ) {
      context.addIssue({
        code: "custom",
        message: "invalidations must advance monotonically within one workspace head",
        path: ["invalidations", index],
      });
    }
    const identity = JSON.stringify(invalidation);
    if (invalidationIdentities.has(identity)) {
      context.addIssue({
        code: "custom",
        message: "invalidation pages cannot repeat the same scope record",
        path: ["invalidations", index],
      });
    }
    invalidationIdentities.add(identity);
    previousRevision = invalidation.projectionRevision;
  });
  if (response.hasMore !== (response.cursor !== null)) {
    context.addIssue({
      code: "custom",
      message: "invalidation cursor exists exactly when another page exists",
      path: ["cursor"],
    });
  }
  if (
    response.cursor !== null &&
    (
      response.cursor.scope.kind !== "invalidations" ||
      response.cursor.workspaceId !== response.workspaceId ||
      response.cursor.projectionHead !== response.projectionHead
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "invalidation cursor must bind its workspace projection head",
      path: ["cursor"],
    });
  }
});
export const pollHRAInvalidationsEnvelopeSchema = successEnvelopeSchema(
  pollHRAInvalidationsResponseSchema,
);

function workspacePath(workspaceId: string): string {
  const parsed = hraWorkspaceRouteParamsSchema.parse({ workspaceId });
  return `/v1/hra/workspaces/${encodeURIComponent(parsed.workspaceId)}`;
}

function legacyOprteWorkspacePath(workspaceId: string): string {
  const parsed = hraWorkspaceRouteParamsSchema.parse({ workspaceId });
  return `/v1/oprte/workspaces/${encodeURIComponent(parsed.workspaceId)}`;
}

function legacyKitchenWorkspacePath(workspaceId: string): string {
  const parsed = hraWorkspaceRouteParamsSchema.parse({ workspaceId });
  return `/v1/kitchen/workspaces/${encodeURIComponent(parsed.workspaceId)}`;
}

function legacyTaskPath(
  workspacePathBuilder: (workspaceId: string) => string,
  workspaceId: string,
  taskId: string,
): string {
  const parsed = hraTaskRouteParamsSchema.parse({ workspaceId, taskId });
  return `${workspacePathBuilder(parsed.workspaceId)}/tasks/${encodeURIComponent(
    parsed.taskId,
  )}`;
}

function legacyInteractionPath(
  workspacePathBuilder: (workspaceId: string) => string,
  workspaceId: string,
  runId: string,
  interactionId: string,
  surface: "reply-authority" | "responses",
): string {
  const parsed = hraInteractionRouteParamsSchema.parse({
    workspaceId,
    runId,
    interactionId,
  });
  return `${workspacePathBuilder(parsed.workspaceId)}/runs/${encodeURIComponent(
    parsed.runId,
  )}/interactions/${encodeURIComponent(parsed.interactionId)}/${surface}`;
}

function taskPath(workspaceId: string, taskId: string): string {
  const parsed = hraTaskRouteParamsSchema.parse({ workspaceId, taskId });
  return `${workspacePath(parsed.workspaceId)}/tasks/${encodeURIComponent(
    parsed.taskId,
  )}`;
}

function interactionResponsePath(
  workspaceId: string,
  runId: string,
  interactionId: string,
): string {
  const parsed = hraInteractionRouteParamsSchema.parse({
    workspaceId,
    runId,
    interactionId,
  });
  return `${workspacePath(parsed.workspaceId)}/runs/${encodeURIComponent(
    parsed.runId,
  )}/interactions/${encodeURIComponent(parsed.interactionId)}/responses`;
}

function interactionReplyAuthorityPath(
  workspaceId: string,
  runId: string,
  interactionId: string,
): string {
  const parsed = hraInteractionRouteParamsSchema.parse({
    workspaceId,
    runId,
    interactionId,
  });
  return `${workspacePath(parsed.workspaceId)}/runs/${encodeURIComponent(
    parsed.runId,
  )}/interactions/${encodeURIComponent(
    parsed.interactionId,
  )}/reply-authority`;
}

export const hraHumanApiRoutes = {
  workspaces: "/v1/hra/workspaces",
  workspace: workspacePath,
  context: (workspaceId: string): string =>
    `${workspacePath(workspaceId)}/context`,
  repositories: (workspaceId: string): string =>
    `${workspacePath(workspaceId)}/repositories`,
  tasks: (workspaceId: string): string =>
    `${workspacePath(workspaceId)}/tasks`,
  taskLookup: (workspaceId: string): string =>
    `${workspacePath(workspaceId)}/task-lookup`,
  task: taskPath,
  mutations: (workspaceId: string): string =>
    `${workspacePath(workspaceId)}/mutations`,
  invalidations: (workspaceId: string): string =>
    `${workspacePath(workspaceId)}/invalidations`,
  interactionReplyAuthority: interactionReplyAuthorityPath,
  interactionResponse: interactionResponsePath,
} as const;

function legacyHumanApiRoutes(
  root: "/v1/oprte/workspaces" | "/v1/kitchen/workspaces",
  workspacePathBuilder: (workspaceId: string) => string,
) {
  return {
    workspaces: root,
    workspace: workspacePathBuilder,
    context: (workspaceId: string): string =>
      `${workspacePathBuilder(workspaceId)}/context`,
    repositories: (workspaceId: string): string =>
      `${workspacePathBuilder(workspaceId)}/repositories`,
    tasks: (workspaceId: string): string =>
      `${workspacePathBuilder(workspaceId)}/tasks`,
    taskLookup: (workspaceId: string): string =>
      `${workspacePathBuilder(workspaceId)}/task-lookup`,
    task: (workspaceId: string, taskId: string): string =>
      legacyTaskPath(workspacePathBuilder, workspaceId, taskId),
    mutations: (workspaceId: string): string =>
      `${workspacePathBuilder(workspaceId)}/mutations`,
    invalidations: (workspaceId: string): string =>
      `${workspacePathBuilder(workspaceId)}/invalidations`,
    interactionReplyAuthority: (
      workspaceId: string,
      runId: string,
      interactionId: string,
    ): string => legacyInteractionPath(
      workspacePathBuilder,
      workspaceId,
      runId,
      interactionId,
      "reply-authority",
    ),
    interactionResponse: (
      workspaceId: string,
      runId: string,
      interactionId: string,
    ): string => legacyInteractionPath(
      workspacePathBuilder,
      workspaceId,
      runId,
      interactionId,
      "responses",
    ),
  } as const;
}

/** Input-only alias retained for clients deployed before the HRA cutover. */
export const legacyOprteHumanApiRoutes = legacyHumanApiRoutes(
  "/v1/oprte/workspaces",
  legacyOprteWorkspacePath,
);

/** Input-only alias retained for the original Kitchen route family. */
export const legacyKitchenHumanApiRoutes = legacyHumanApiRoutes(
  "/v1/kitchen/workspaces",
  legacyKitchenWorkspacePath,
);

/** @deprecated Use legacyKitchenHumanApiRoutes. */
export const legacyPredecessorHumanApiRoutes = legacyKitchenHumanApiRoutes;

export const hraHumanRouteOperationSchema = z.enum([
  "list_workspaces",
  "get_workspace",
  "get_context",
  "list_repositories",
  "list_tasks",
  "lookup_task",
  "get_task",
  "mutate",
  "poll_invalidations",
  "get_interaction_reply_authority",
  "respond_interaction",
]);
export type HRAHumanRouteOperation = z.infer<
  typeof hraHumanRouteOperationSchema
>;

export type HRAHumanRouteMatch = Readonly<{
  operation: HRAHumanRouteOperation;
  workspaceId?: string;
  taskId?: string;
  runId?: string;
  interactionId?: string;
}>;

function decodeRoutePart(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Exact method-aware parser used by HTTP actions before dispatch. */
export function parseHRAHumanRoute(input: Readonly<{
  method: string;
  pathname: string;
}>): HRAHumanRouteMatch | null {
  const method = input.method.toUpperCase();
  if (
    input.pathname === hraHumanApiRoutes.workspaces
    || input.pathname === legacyOprteHumanApiRoutes.workspaces
    || input.pathname === legacyPredecessorHumanApiRoutes.workspaces
  ) {
    return method === "GET" ? { operation: "list_workspaces" } : null;
  }
  if (
    !input.pathname.startsWith("/") ||
    input.pathname.endsWith("/") ||
    input.pathname.includes("//")
  ) {
    return null;
  }
  const segments = input.pathname.slice(1).split("/");
  if (
    segments[0] !== "v1" ||
    (segments[1] !== "hra" && segments[1] !== "oprte" && segments[1] !== "kitchen") ||
    segments[2] !== "workspaces"
  ) {
    return null;
  }
  const workspaceId = decodeRoutePart(segments[3]);
  if (
    workspaceId === null ||
    !workspacePublicIdSchema.safeParse(workspaceId).success
  ) {
    return null;
  }
  if (segments.length === 4) {
    return method === "GET"
      ? { operation: "get_workspace", workspaceId }
      : null;
  }
  const surface = segments[4];
  if (segments.length === 5) {
    const operation =
      surface === "context" && method === "GET" ? "get_context"
        : surface === "repositories" && method === "GET" ? "list_repositories"
          : surface === "tasks" && method === "GET" ? "list_tasks"
            : surface === "task-lookup" && method === "GET" ? "lookup_task"
            : surface === "mutations" && method === "POST" ? "mutate"
              : surface === "invalidations" && method === "GET"
                ? "poll_invalidations"
                : null;
    return operation === null ? null : { operation, workspaceId };
  }
  if (surface === "tasks" && segments.length === 6 && method === "GET") {
    const taskId = decodeRoutePart(segments[5]);
    return taskId !== null && taskPublicIdSchema.safeParse(taskId).success
      ? { operation: "get_task", workspaceId, taskId }
      : null;
  }
  if (
    surface === "runs" &&
    segments[6] === "interactions" &&
    segments.length === 9 &&
    (
      (segments[8] === "responses" && method === "POST") ||
      (segments[8] === "reply-authority" && method === "GET")
    )
  ) {
    const runId = decodeRoutePart(segments[5]);
    const interactionId = decodeRoutePart(segments[7]);
    return runId !== null &&
        interactionId !== null &&
        dispatchIdSchema.safeParse(runId).success &&
        runInteractionIdSchema.safeParse(interactionId).success
      ? {
        operation: segments[8] === "responses"
          ? "respond_interaction"
          : "get_interaction_reply_authority",
        workspaceId,
        runId,
        interactionId,
      }
      : null;
  }
  return null;
}

const hraHumanOperationMetadata = {
  authorization: "oprte-human-bearer",
  credentials: "authorization_header_only",
  session: false,
} as const;

export const hraHumanApiOperations = {
  listWorkspaces: {
    ...hraHumanOperationMetadata,
    method: "GET",
    path: hraHumanApiRoutes.workspaces,
    idempotency: false,
    querySchema: listHRAWorkspacesQuerySchema,
    responseSchema: listHRAWorkspacesEnvelopeSchema,
  },
  getWorkspace: {
    ...hraHumanOperationMetadata,
    method: "GET",
    path: hraHumanApiRoutes.workspace,
    pathParamsSchema: hraWorkspaceRouteParamsSchema,
    idempotency: false,
    responseSchema: getHRAWorkspaceEnvelopeSchema,
  },
  context: {
    ...hraHumanOperationMetadata,
    method: "GET",
    path: hraHumanApiRoutes.context,
    pathParamsSchema: hraWorkspaceRouteParamsSchema,
    idempotency: false,
    responseSchema: getHRAWorkspaceContextEnvelopeSchema,
  },
  repositories: {
    ...hraHumanOperationMetadata,
    method: "GET",
    path: hraHumanApiRoutes.repositories,
    pathParamsSchema: hraWorkspaceRouteParamsSchema,
    idempotency: false,
    querySchema: listHRARepositoriesQuerySchema,
    responseSchema: listHRARepositoriesEnvelopeSchema,
  },
  listTasks: {
    ...hraHumanOperationMetadata,
    method: "GET",
    path: hraHumanApiRoutes.tasks,
    pathParamsSchema: hraWorkspaceRouteParamsSchema,
    idempotency: false,
    querySchema: listHRATasksQuerySchema,
    responseSchema: listHRATasksEnvelopeSchema,
  },
  lookupTask: {
    ...hraHumanOperationMetadata,
    method: "GET",
    path: hraHumanApiRoutes.taskLookup,
    pathParamsSchema: hraWorkspaceRouteParamsSchema,
    idempotency: false,
    querySchema: lookupHRATaskQuerySchema,
    responseSchema: lookupHRATaskEnvelopeSchema,
  },
  getTask: {
    ...hraHumanOperationMetadata,
    method: "GET",
    path: hraHumanApiRoutes.task,
    pathParamsSchema: hraTaskRouteParamsSchema,
    idempotency: false,
    querySchema: getHRATaskQuerySchema,
    responseSchema: getHRATaskEnvelopeSchema,
  },
  mutate: {
    ...hraHumanOperationMetadata,
    method: "POST",
    path: hraHumanApiRoutes.mutations,
    pathParamsSchema: hraWorkspaceRouteParamsSchema,
    idempotency: true,
    requestSchema: mutateHRAWorkspaceRequestSchema,
    responseSchema: mutateHRAWorkspaceEnvelopeSchema,
  },
  pollInvalidations: {
    ...hraHumanOperationMetadata,
    method: "GET",
    path: hraHumanApiRoutes.invalidations,
    pathParamsSchema: hraWorkspaceRouteParamsSchema,
    idempotency: false,
    querySchema: pollHRAInvalidationsQuerySchema,
    responseSchema: pollHRAInvalidationsEnvelopeSchema,
  },
  interactionReplyAuthority: {
    ...hraHumanOperationMetadata,
    method: "GET",
    path: hraHumanApiRoutes.interactionReplyAuthority,
    pathParamsSchema: hraInteractionRouteParamsSchema,
    idempotency: false,
    querySchema: getHRARunInteractionReplyAuthorityQuerySchema,
    responseSchema: getHRARunInteractionReplyAuthorityEnvelopeSchema,
  },
  respondInteraction: {
    ...hraHumanOperationMetadata,
    method: "POST",
    path: hraHumanApiRoutes.interactionResponse,
    pathParamsSchema: hraInteractionRouteParamsSchema,
    idempotency: true,
    requestSchema: respondHRARunInteractionRequestSchema,
    responseSchema: respondHRARunInteractionEnvelopeSchema,
  },
} as const;
