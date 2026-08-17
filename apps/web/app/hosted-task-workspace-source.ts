import {
  agentIdSchema,
  epochMsSchema,
  operationIdSchema,
  portableProjectionCursorSchema,
  repositoryIdSchema,
  repositoryNameSchema,
  runPhaseSchema,
  taskCommentIdSchema,
  taskListPageSchema,
  taskPublicIdSchema,
  taskReferenceIdSchema,
  taskSubmissionIdSchema,
  taskViewSchema,
  taskWorkspaceClientIntentSchema,
  taskWorkspaceCountsSchema,
  taskWorkspaceListItemSchema,
  taskWorkspaceMutationResultSchema,
  taskWorkspaceProjectionBundleSchema,
  taskWorkspaceViewSchema,
  taskWorkspaceViewValues,
  workspacePublicIdSchema,
  type TaskWorkspaceListItem,
  type TaskWorkspaceMutationResult,
  type TaskWorkspaceProjectionBundle,
} from "@hraness/agent-tasks-domain";
import {
  createUuidV7,
  dispatchIdSchema,
  runnerPresenceViewSchema,
  sealRunInteractionResponse,
  taskRunViewSchema,
  uuidV7Schema,
} from "@hraness/agent-tasks-protocol";
import {
  cancelled,
  confirmed,
  createAttemptId,
  rejected,
  type DispatchOutcome,
  type MutationAttemptRecord,
} from "@hra-internal/codex-app-sdk";
import {
  type TaskWorkspaceClientMutationIntent,
  type TaskWorkspaceContinuationRequest,
  type TaskWorkspaceCoordinate,
  type TaskWorkspaceEffectContext,
  type TaskWorkspaceMutationRequest,
  type TaskWorkspacePresentation,
  type TaskWorkspaceProjectionEnvelope,
  type TaskWorkspaceProjectionRequest,
  type TaskWorkspaceSource,
  type TaskWorkspaceSourceEvent,
  type TaskWorkspaceSourceResult,
} from "@hraness/agent-tasks-ui";
import { z } from "@hra-internal/schema";
import type { ConvexReactClient } from "convex/react";

import { api } from "../convex/_generated/api";
import {
  HOSTED_TASK_MUTATION_SOURCE_ID,
  HostedMutationJournalError,
  hostedMutationFingerprint,
  isOpaqueHostedMutationFingerprint,
  type HostedMutationAttemptJournal,
  type HostedMutationAttemptDefinition,
  type HostedMutationResolution,
} from "./hosted-mutation-attempt-journal";

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const LOCATOR_LENGTH = 26;
const DEFAULT_READ_TIMEOUT_MS = 30_000;
const HOSTED_PAGE_LIMIT = 50;
const CHANGE_PAGE_LIMIT = HOSTED_PAGE_LIMIT;
const MAX_CHANGE_DRAIN_PAGES = 8;
const MAX_TARGETED_PATCHES = 8;
const MAX_MUTATION_ATTEMPT_DRAIN_PAGES = 8;
const MAX_TIMER_INTERVAL_MS = 2_147_483_647;
const SOURCE_TOKEN_RENEWAL_FRACTION = 0.1;
const SOURCE_TOKEN_RENEWAL_MAX_MARGIN_MS = 30_000;
const SOURCE_EFFECT_CANCELLED = Symbol("hosted task source effect cancelled");

class SourceEffectCancelledError extends Error {
  readonly code: string;
  readonly marker = SOURCE_EFFECT_CANCELLED;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const domainErrorSchema = z.object({
  code: z.string().min(1).max(128),
  message: z.string(),
  requestId: z.string().min(1).max(128),
  details: z.unknown(),
}).strict();

const hostedSourceSchema = z.object({
  kind: z.literal("hosted"),
  token: portableProjectionCursorSchema,
  workspaceId: workspacePublicIdSchema,
  projectionRevision: z.number().int().positive().safe(),
  continuationRevision: z.number().int().positive().safe(),
  view: taskWorkspaceViewSchema,
  assignedAgentId: agentIdSchema.optional(),
  selectedTaskId: taskPublicIdSchema.optional(),
  classifiedAt: epochMsSchema,
  expiresAt: epochMsSchema,
}).strict().refine(
  (source) => source.view === "assigned" || source.assignedAgentId === undefined,
  "only assigned views may carry an assigned-agent filter",
).refine(
  (source) => source.expiresAt > source.classifiedAt,
  "hosted source expiry must follow classification",
);

const capabilitiesSchema = z.object({
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

const agentSchema = z.object({
  id: agentIdSchema,
  name: z.string().min(1).max(160),
  status: z.enum(["active", "disabled"]),
}).strict();

const repositorySchema = z.object({
  id: repositoryIdSchema,
  name: repositoryNameSchema,
  ready: z.boolean(),
}).strict();

const workspaceContextSchema = z.object({
  now: epochMsSchema,
  workspace: z.object({
    id: workspacePublicIdSchema,
    name: z.string().min(1).max(160),
    slug: z.string().min(1).max(128),
    taskKeyPrefix: z.string().min(2).max(8).regex(/^[A-Z][A-Z0-9]{1,7}$/u),
  }).strict(),
  viewer: z.object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(160),
    organizationRole: z.enum(["owner", "admin", "member"]),
    workspaceRoles: z.array(z.enum(["planner", "reviewer", "viewer"])).max(3),
  }).strict(),
  capabilities: capabilitiesSchema,
  agents: z.object({
    items: z.array(agentSchema).max(500),
    capped: z.boolean(),
  }).strict(),
}).strict();

const readinessSchema = z.object({
  presence: runnerPresenceViewSchema,
  repositories: z.array(repositorySchema).max(128),
}).strict();

const rootContextSchema = z.object({
  observedAt: epochMsSchema,
  workspace: workspaceContextSchema,
  readiness: readinessSchema,
}).strict();

const rawPageDataSchema = z.object({
  now: epochMsSchema,
  view: taskWorkspaceViewSchema,
  tasks: z.array(z.unknown()).max(100),
  cursor: portableProjectionCursorSchema.nullable(),
  counts: taskWorkspaceCountsSchema,
}).strict();

const rawPageSchema = z.object({
  workspaceId: workspacePublicIdSchema,
  projectionRevision: z.number().int().positive().safe(),
  continuationRevision: z.number().int().positive().safe(),
  view: taskWorkspaceViewSchema,
  assignedAgentId: agentIdSchema.optional(),
  data: rawPageDataSchema,
}).strict();

const rawContinuationPageSchema = rawPageSchema.extend({
  data: rawPageDataSchema.omit({ counts: true }),
}).strict();

const rawRunsSchema = z.object({
  runs: z.array(z.unknown()).max(50),
  hasMore: z.boolean(),
}).strict();

const rawSelectedSchema = z.object({
  taskId: taskPublicIdSchema,
  workspaceId: workspacePublicIdSchema,
  projectionRevision: z.number().int().positive().safe(),
  detail: z.unknown(),
  runs: rawRunsSchema,
}).strict();

const rootSuccessSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    source: hostedSourceSchema,
    context: rootContextSchema,
    page: rawPageSchema,
    selected: rawSelectedSchema.nullable(),
  }).strict(),
  requestId: z.string().min(1).max(128),
}).strict();

const rootFailureSchema = z.object({
  ok: z.literal(false),
  error: domainErrorSchema,
}).strict();

const continuationSuccessSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    source: hostedSourceSchema,
    page: rawContinuationPageSchema,
  }).strict(),
  requestId: z.string().min(1).max(128),
}).strict();

const taskViewRevisionsSchema = z.object({
  all: z.number().int().positive().safe(),
  ready: z.number().int().positive().safe(),
  blocked: z.number().int().positive().safe(),
  deferred: z.number().int().positive().safe(),
  attention: z.number().int().positive().safe(),
  assigned: z.number().int().positive().safe(),
  review: z.number().int().positive().safe(),
}).strict();

const headsSuccessSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    workspaceId: workspacePublicIdSchema,
    view: taskWorkspaceViewSchema,
    projectionRevision: z.number().int().positive().safe(),
    continuationRevision: z.number().int().positive().safe(),
    taskViewRevisions: taskViewRevisionsSchema,
  }).strict(),
  requestId: z.string().min(1).max(128),
}).strict();

const hostedChangeSchema = z.discriminatedUnion("scope", [
  z.object({
    projectionRevision: z.number().int().positive().safe(),
    scope: z.literal("workspace"),
    createdAt: epochMsSchema,
  }).strict(),
  z.object({
    projectionRevision: z.number().int().positive().safe(),
    scope: z.literal("task"),
    taskId: taskPublicIdSchema,
    views: z.array(taskWorkspaceViewSchema)
      .min(1)
      .max(taskWorkspaceViewValues.length),
    structure: z.boolean(),
    createdAt: epochMsSchema,
  }).strict(),
  z.object({
    projectionRevision: z.number().int().positive().safe(),
    scope: z.literal("run"),
    taskId: taskPublicIdSchema,
    runId: dispatchIdSchema,
    views: z.array(taskWorkspaceViewSchema)
      .min(1)
      .max(taskWorkspaceViewValues.length),
    structure: z.boolean(),
    createdAt: epochMsSchema,
  }).strict(),
]);

const changesSuccessSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    workspaceId: workspacePublicIdSchema,
    fromRevision: z.number().int().nonnegative().safe(),
    throughRevision: z.number().int().nonnegative().safe(),
    projectionRevision: z.number().int().positive().safe(),
    taskViewRevisions: taskViewRevisionsSchema,
    changes: z.array(hostedChangeSchema).max(CHANGE_PAGE_LIMIT),
    hasMore: z.boolean(),
    resetRequired: z.boolean(),
  }).strict(),
  requestId: z.string().min(1).max(128),
}).strict();

const taskPatchSuccessSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    now: epochMsSchema,
    view: taskWorkspaceViewSchema,
    taskId: taskPublicIdSchema,
    projectionRevision: z.number().int().positive().safe(),
    continuationRevision: z.number().int().positive().safe(),
    membership: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("absent") }).strict(),
      z.object({
        kind: z.literal("present"),
        item: z.unknown(),
      }).strict(),
    ]),
  }).strict(),
  requestId: z.string().min(1).max(128),
}).strict();

const presentationContextSuccessSchema = z.object({
  ok: z.literal(true),
  data: rootContextSchema,
  requestId: z.string().min(1).max(128),
}).strict();

const RAW_DETAIL_KEYS = Object.freeze([
  "task",
  "description",
  "labels",
  "parent",
  "children",
  "blockers",
  "dependents",
  "comments",
  "events",
  "references",
  "submission",
  "recoveries",
  "truncatedCollections",
]);

type HostedWatch = Readonly<{
  localQueryResult: () => unknown;
  onUpdate: (listener: () => void) => () => void;
}>;

type RootValue = Readonly<{
  classifiedAt: number;
  context: z.infer<typeof rootContextSchema>;
  continuationRevision: number;
  envelope: TaskWorkspaceProjectionEnvelope;
  expiresAt: number;
  observedAt: number;
  presentation: HostedTaskWorkspacePresentation;
  rawRuns: readonly unknown[];
  sourceToken: string;
  usableUntilMonotonic: number;
}>;

type ActiveRoot = Readonly<{
  coordinate: TaskWorkspaceCoordinate;
  coordinateKey: string;
  headsWatch: HostedWatch;
  lifecycle: number;
  presentationWatch: HostedWatch;
  sourceGeneration: number;
  unsubscribe: () => void;
}>;

type MutationAttempt = MutationAttemptRecord<HostedMutationAttemptDefinition>;

export type HostedTaskWorkspacePresentation = TaskWorkspacePresentation;

export type HostedTaskWorkspaceSource = TaskWorkspaceSource & Readonly<{
  dispose: () => void;
}>;

export type HostedTaskWorkspaceSourceOptions = Readonly<{
  client: ConvexReactClient;
  idempotencyKey?: () => string;
  monotonicNow?: () => number;
  mutationJournal: HostedMutationAttemptJournal;
  operationId?: () => string;
  readTimeoutMs?: number;
  taskId?: () => string;
  wallNow?: () => number;
  workspaceId: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function sourceFailure<Value = never>(
  code: string,
  reference?: string,
): TaskWorkspaceSourceResult<Value> {
  return {
    error: { code, ...(reference === undefined ? {} : { reference }) },
    ok: false,
  };
}

function sourceSuccess<Value>(value: Value): TaskWorkspaceSourceResult<Value> {
  return { ok: true, value };
}

function domainFailure<Value>(value: unknown): TaskWorkspaceSourceResult<Value> | null {
  const parsed = rootFailureSchema.safeParse(value);
  return parsed.success
    ? sourceFailure(parsed.data.error.code, parsed.data.error.requestId)
    : null;
}

function coordinateKey(coordinate: TaskWorkspaceCoordinate): string {
  return JSON.stringify([
    coordinate.workspaceId,
    coordinate.view,
    coordinate.assignedAgentId ?? null,
    coordinate.selectedTaskId,
  ]);
}

function validCoordinate(
  coordinate: TaskWorkspaceCoordinate,
  workspaceId: string,
): boolean {
  return coordinate.workspaceId === workspaceId &&
    workspacePublicIdSchema.safeParse(coordinate.workspaceId).success &&
    taskWorkspaceViewSchema.safeParse(coordinate.view).success &&
    (
      coordinate.selectedTaskId === null ||
      taskPublicIdSchema.safeParse(coordinate.selectedTaskId).success
    ) &&
    (
      coordinate.assignedAgentId === undefined ||
      (
        coordinate.view === "assigned" &&
        agentIdSchema.safeParse(coordinate.assignedAgentId).success
      )
    );
}

function validSourceGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function validPositiveRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function portableLocator(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(LOCATOR_LENGTH));
  let locator = "";
  for (const byte of bytes) locator += CROCKFORD_ALPHABET[byte & 31];
  return locator;
}

function createOperationId(): string {
  return operationIdSchema.parse(`op_${portableLocator()}`);
}

function createTaskId(): string {
  return taskPublicIdSchema.parse(`tsk_${portableLocator()}`);
}

function createIdempotencyKey(): string {
  return createUuidV7(Date.now(), crypto.getRandomValues(new Uint8Array(10)));
}

function rootQueryArgs(
  coordinate: TaskWorkspaceCoordinate,
  sourceToken?: string,
) {
  return {
    workspaceId: coordinate.workspaceId,
    view: coordinate.view,
    ...(coordinate.assignedAgentId === undefined
      ? {}
      : { assignedAgentId: coordinate.assignedAgentId }),
    ...(coordinate.selectedTaskId === null
      ? {}
      : { selectedTaskId: coordinate.selectedTaskId }),
    ...(sourceToken === undefined ? {} : { sourceToken }),
  };
}

function normalizePresentation(
  context: z.infer<typeof rootContextSchema>,
  counts: z.infer<typeof taskWorkspaceCountsSchema>,
): HostedTaskWorkspacePresentation | null {
  const agentIds = new Set(context.workspace.agents.items.map(({ id }) => id));
  const repositoryIds = new Set(context.readiness.repositories.map(({ id }) => id));
  if (
    agentIds.size !== context.workspace.agents.items.length ||
    repositoryIds.size !== context.readiness.repositories.length ||
    new Set(context.workspace.viewer.workspaceRoles).size !==
      context.workspace.viewer.workspaceRoles.length
  ) {
    return null;
  }
  return Object.freeze({
    agents: Object.freeze(context.workspace.agents.items.map((agent) =>
      Object.freeze({ ...agent }))),
    capabilities: Object.freeze({ ...context.workspace.capabilities }),
    counts: Object.freeze({ ...counts }),
    now: context.readiness.presence.serverTime,
    runner: Object.freeze({
      presence: Object.freeze({ ...context.readiness.presence }),
      repositories: Object.freeze(context.readiness.repositories.map(
        (repository) => Object.freeze({ ...repository }),
      )),
    }),
    viewer: Object.freeze({
      id: context.workspace.viewer.id,
      kind: "human" as const,
      name: context.workspace.viewer.name,
    }),
    workspace: Object.freeze({
      id: context.workspace.workspace.id,
      keyPrefix: context.workspace.workspace.taskKeyPrefix,
      name: context.workspace.workspace.name,
      slug: context.workspace.workspace.slug,
    }),
  });
}

function presentationContextTime(
  context: z.infer<typeof rootContextSchema>,
): number {
  return Math.max(
    context.observedAt,
    context.workspace.now,
    context.readiness.presence.serverTime,
  );
}

function normalizePage(
  page:
    | z.infer<typeof rawPageSchema>
    | z.infer<typeof rawContinuationPageSchema>,
) {
  const items = [];
  for (const value of page.data.tasks) {
    const item = taskWorkspaceListItemSchema.safeParse(value);
    if (!item.success) return null;
    items.push(item.data);
  }
  const parsed = taskListPageSchema.safeParse({
    workspaceId: page.workspaceId,
    view: page.view,
    ...(page.assignedAgentId === undefined
      ? {}
      : { assignedAgentId: page.assignedAgentId }),
    projectionRevision: page.projectionRevision,
    items,
    cursor: page.data.cursor,
    hasMore: page.data.cursor !== null,
  });
  return parsed.success ? parsed.data : null;
}

type RootReadTiming = Readonly<{
  receivedAtMonotonic: number;
  startedAtMonotonic: number;
}>;

function sourceTokenRenewalMargin(ttlMs: number): number {
  return Math.min(
    ttlMs,
    SOURCE_TOKEN_RENEWAL_MAX_MARGIN_MS,
    Math.max(1, Math.ceil(ttlMs * SOURCE_TOKEN_RENEWAL_FRACTION)),
  );
}

function sourceTokenUsableUntil(
  observedAt: number,
  expiresAt: number,
  timing: RootReadTiming,
): number | null {
  const ttlMs = expiresAt - observedAt;
  const transitMs = Math.max(
    0,
    timing.receivedAtMonotonic - timing.startedAtMonotonic,
  );
  if (
    ttlMs <= 0 ||
    !Number.isFinite(timing.startedAtMonotonic) ||
    !Number.isFinite(timing.receivedAtMonotonic) ||
    timing.receivedAtMonotonic < timing.startedAtMonotonic
  ) {
    return null;
  }
  return timing.receivedAtMonotonic + Math.max(
    0,
    ttlMs - sourceTokenRenewalMargin(ttlMs) - transitMs,
  );
}

function normalizeRootResult(
  value: unknown,
  coordinate: TaskWorkspaceCoordinate,
  sourceGeneration: number,
  timing: RootReadTiming,
): TaskWorkspaceSourceResult<RootValue> {
  const failure = domainFailure<RootValue>(value);
  if (failure !== null) return failure;
  const parsed = rootSuccessSchema.safeParse(value);
  if (!parsed.success) return sourceFailure("INVALID_PROJECTION");
  const { context, page, selected, source } = parsed.data.data;
  if (
    source.workspaceId !== coordinate.workspaceId ||
    source.view !== coordinate.view ||
    source.assignedAgentId !== coordinate.assignedAgentId ||
    (source.selectedTaskId ?? null) !== coordinate.selectedTaskId ||
    page.workspaceId !== coordinate.workspaceId ||
    page.view !== coordinate.view ||
    page.assignedAgentId !== coordinate.assignedAgentId ||
    page.data.view !== coordinate.view ||
    page.data.now !== source.classifiedAt ||
    page.projectionRevision !== source.projectionRevision ||
    page.continuationRevision !== source.continuationRevision ||
    source.continuationRevision > source.projectionRevision ||
    source.expiresAt <= context.observedAt ||
    context.workspace.workspace.id !== coordinate.workspaceId ||
    (selected === null) !== (coordinate.selectedTaskId === null)
  ) {
    return sourceFailure("PROJECTION_MISMATCH", parsed.data.requestId);
  }
  const firstPage = normalizePage(page);
  const presentation = normalizePresentation(context, page.data.counts);
  const usableUntilMonotonic = sourceTokenUsableUntil(
    context.observedAt,
    source.expiresAt,
    timing,
  );
  if (
    firstPage === null ||
    presentation === null ||
    usableUntilMonotonic === null
  ) {
    return sourceFailure("INVALID_PROJECTION", parsed.data.requestId);
  }

  let detail: TaskWorkspaceProjectionBundle["detail"] = null;
  let rawRuns: readonly unknown[] = Object.freeze([]);
  if (selected !== null) {
    if (
      selected.workspaceId !== coordinate.workspaceId ||
      selected.taskId !== coordinate.selectedTaskId ||
      selected.projectionRevision !== source.projectionRevision ||
      !isRecord(selected.detail) ||
      !hasExactKeys(selected.detail, RAW_DETAIL_KEYS)
    ) {
      return sourceFailure("PROJECTION_MISMATCH", parsed.data.requestId);
    }
    const task = taskViewSchema.safeParse(selected.detail.task);
    if (!task.success || task.data.id !== selected.taskId) {
      return sourceFailure("INVALID_PROJECTION", parsed.data.requestId);
    }
    const runs = [];
    for (const value of selected.runs.runs) {
      const run = taskRunViewSchema.safeParse(value);
      if (!run.success || run.data.taskKey !== task.data.key) {
        return sourceFailure("INVALID_PROJECTION", parsed.data.requestId);
      }
      runs.push({
        id: run.data.id,
        taskKey: run.data.taskKey,
        phase: run.data.phase,
        repositoryId: run.data.repositoryId,
        desiredState: run.data.desiredState,
        updatedAt: run.data.updatedAt,
        events: run.data.events,
        interactions: run.data.interactions.map((interaction) => ({
          runId: interaction.runId,
          request: interaction.request.kind === "file_change_approval"
            ? {
                id: interaction.request.id,
                createdAt: interaction.request.createdAt,
                expiresAt: interaction.request.expiresAt,
                kind: interaction.request.kind,
                scope: interaction.request.scope,
              }
            : {
                id: interaction.request.id,
                createdAt: interaction.request.createdAt,
                expiresAt: interaction.request.expiresAt,
                kind: interaction.request.kind,
                questions: interaction.request.questions.map((question) => ({
                  id: question.id,
                  header: question.header,
                  prompt: question.prompt,
                  allowOther: question.allowOther,
                  options: question.options.map((option) => ({
                    id: option.id,
                    label: option.label,
                    ...(option.description === undefined
                      ? {}
                      : { description: option.description }),
                  })),
                })),
              },
          state: interaction.state,
          ...(interaction.responseRevision === undefined
            ? {}
            : { responseRevision: interaction.responseRevision }),
          ...(interaction.respondedAt === undefined
            ? {}
            : { respondedAt: interaction.respondedAt }),
          ...(interaction.resolvedAt === undefined
            ? {}
            : { resolvedAt: interaction.resolvedAt }),
        })),
      });
    }
    const parsedTruncatedCollections = z.array(z.string()).max(7).safeParse(
      selected.detail.truncatedCollections,
    );
    if (!parsedTruncatedCollections.success) {
      return sourceFailure("INVALID_PROJECTION", parsed.data.requestId);
    }
    const truncatedCollections = [...parsedTruncatedCollections.data];
    if (
      selected.runs.hasMore &&
      Array.isArray(truncatedCollections) &&
      !truncatedCollections.includes("runs")
    ) {
      truncatedCollections.push("runs");
    }
    const detailResult = taskWorkspaceProjectionBundleSchema.shape.detail
      .safeParse({
        ...selected.detail,
        workspaceId: coordinate.workspaceId,
        projectionRevision: source.projectionRevision,
        runs,
        truncatedCollections,
      });
    if (!detailResult.success) {
      return sourceFailure("INVALID_PROJECTION", parsed.data.requestId);
    }
    detail = detailResult.data;
    rawRuns = Object.freeze([...selected.runs.runs]);
  }

  const bundle = taskWorkspaceProjectionBundleSchema.safeParse({
    workspaceId: coordinate.workspaceId,
    view: coordinate.view,
    ...(coordinate.assignedAgentId === undefined
      ? {}
      : { assignedAgentId: coordinate.assignedAgentId }),
    selectedTaskId: coordinate.selectedTaskId,
    continuationRevision: source.continuationRevision,
    projectionRevision: source.projectionRevision,
    firstPage,
    detail,
  });
  if (!bundle.success) {
    return sourceFailure("INVALID_PROJECTION", parsed.data.requestId);
  }
  return sourceSuccess(Object.freeze({
    classifiedAt: source.classifiedAt,
    context: Object.freeze({
      observedAt: context.observedAt,
      workspace: Object.freeze({ ...context.workspace }),
      readiness: Object.freeze({ ...context.readiness }),
    }),
    continuationRevision: source.continuationRevision,
    envelope: Object.freeze({
      consistency: Object.freeze({
        kind: "atomic" as const,
        sourceGeneration,
      }),
      presentation,
      presentationRevision: source.projectionRevision,
      projection: bundle.data,
    }),
    expiresAt: source.expiresAt,
    observedAt: context.observedAt,
    presentation,
    rawRuns,
    sourceToken: source.token,
    usableUntilMonotonic,
  }));
}

function normalizeContinuationResult(
  value: unknown,
  request: TaskWorkspaceContinuationRequest,
  cached: RootValue,
) {
  const failure = domainFailure<z.infer<typeof taskListPageSchema>>(value);
  if (failure !== null) return failure;
  const parsed = continuationSuccessSchema.safeParse(value);
  if (!parsed.success) return sourceFailure("INVALID_CONTINUATION");
  const { page, source } = parsed.data.data;
  const cachedRevision = cached.envelope.projection.projectionRevision;
  if (
    source.projectionRevision !== cachedRevision ||
    page.projectionRevision !== cachedRevision
  ) {
    return sourceFailure("TASK_STATE_CONFLICT", parsed.data.requestId);
  }
  if (
    source.token !== cached.sourceToken ||
    source.expiresAt !== cached.expiresAt ||
    source.continuationRevision > source.projectionRevision ||
    source.workspaceId !== request.coordinate.workspaceId ||
    source.projectionRevision !== request.projectionRevision ||
    source.continuationRevision !== request.continuationRevision ||
    source.view !== request.coordinate.view ||
    source.assignedAgentId !== request.coordinate.assignedAgentId ||
    (source.selectedTaskId ?? null) !== request.coordinate.selectedTaskId ||
    page.workspaceId !== request.coordinate.workspaceId ||
    page.projectionRevision !== source.projectionRevision ||
    page.continuationRevision !== request.continuationRevision ||
    page.view !== request.coordinate.view ||
    page.assignedAgentId !== request.coordinate.assignedAgentId ||
    page.data.view !== request.coordinate.view ||
    page.data.now !== source.classifiedAt
  ) {
    return sourceFailure("PROJECTION_MISMATCH", parsed.data.requestId);
  }
  const normalized = normalizePage(page);
  return normalized === null
    ? sourceFailure("INVALID_CONTINUATION", parsed.data.requestId)
    : sourceSuccess(normalized);
}

type HostedTaskWorkspaceHeads = z.infer<typeof headsSuccessSchema>["data"];

function normalizeHeadsResult(
  value: unknown,
): TaskWorkspaceSourceResult<HostedTaskWorkspaceHeads> | null {
  if (value === undefined) return null;
  const failure = domainFailure<HostedTaskWorkspaceHeads>(value);
  if (failure !== null) return failure;
  const parsed = headsSuccessSchema.safeParse(value);
  return parsed.success
    ? sourceSuccess(parsed.data.data)
    : sourceFailure("INVALID_PROJECTION");
}

type HostedTaskWorkspaceChanges = z.infer<typeof changesSuccessSchema>["data"];

function normalizeChangesResult(
  value: unknown,
): TaskWorkspaceSourceResult<HostedTaskWorkspaceChanges> {
  const failure = domainFailure<HostedTaskWorkspaceChanges>(value);
  if (failure !== null) return failure;
  const parsed = changesSuccessSchema.safeParse(value);
  if (!parsed.success) return sourceFailure("INVALID_PROJECTION");
  for (const change of parsed.data.data.changes) {
    if (
      change.scope !== "workspace" &&
      new Set(change.views).size !== change.views.length
    ) {
      return sourceFailure("INVALID_PROJECTION");
    }
  }
  return sourceSuccess(parsed.data.data);
}

function normalizeTaskPatchResult(
  value: unknown,
  expected: Readonly<{
    classifiedAt: number;
    projectionRevision: number;
    taskId: string;
    view: TaskWorkspaceCoordinate["view"];
  }>,
): TaskWorkspaceSourceResult<Readonly<{
  continuationRevision: number;
  item: TaskWorkspaceListItem | null;
  projectionRevision: number;
}>> {
  const failure = domainFailure<Readonly<{
    continuationRevision: number;
    item: TaskWorkspaceListItem | null;
    projectionRevision: number;
  }>>(value);
  if (failure !== null) return failure;
  const parsed = taskPatchSuccessSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.data.now !== expected.classifiedAt ||
    parsed.data.data.taskId !== expected.taskId ||
    parsed.data.data.view !== expected.view ||
    parsed.data.data.projectionRevision !== expected.projectionRevision ||
    parsed.data.data.continuationRevision > expected.projectionRevision
  ) {
    return sourceFailure("INVALID_PROJECTION");
  }
  if (parsed.data.data.membership.kind === "absent") {
    return sourceSuccess({
      continuationRevision: parsed.data.data.continuationRevision,
      item: null,
      projectionRevision: parsed.data.data.projectionRevision,
    });
  }
  const item = taskWorkspaceListItemSchema.safeParse(
    parsed.data.data.membership.item,
  );
  return item.success && item.data.task.id === expected.taskId
    ? sourceSuccess({
        continuationRevision: parsed.data.data.continuationRevision,
        item: item.data,
        projectionRevision: parsed.data.data.projectionRevision,
      })
    : sourceFailure("INVALID_PROJECTION");
}

function exhaustiveIntent(intent: never): never {
  throw new Error(`Unsupported hosted task mutation intent: ${String(intent)}`);
}

function taskKeyForIntent(
  root: RootValue,
  taskId: string,
  expectedRevision?: number,
): string | null {
  const detail = root.envelope.projection.detail;
  const tasks = [
    ...root.envelope.projection.firstPage.items.map(({ task }) => task),
    ...(detail === null
      ? []
      : [
          detail.task,
          ...(detail.parent === null ? [] : [detail.parent]),
          ...detail.children,
          ...detail.blockers.map(({ task }) => task),
          ...detail.dependents.map(({ task }) => task),
        ]),
  ];
  const matches = tasks.filter(({ id }) => id === taskId);
  const identities = new Set(matches.map(({ key, revision }) =>
    `${key}:${String(revision)}`));
  if (
    matches.length < 1 ||
    identities.size !== 1 ||
    (
      expectedRevision !== undefined &&
      matches[0]?.revision !== expectedRevision
    )
  ) {
    return null;
  }
  return matches[0]?.key ?? null;
}

function convexReferenceInput(
  reference: Extract<
    TaskWorkspaceClientMutationIntent,
    { kind: "task.reference_add" }
  >["reference"],
) {
  switch (reference.kind) {
    case "repository":
      return { kind: reference.kind, repositoryId: reference.repositoryId } as const;
    case "pull_request":
      return {
        kind: reference.kind,
        url: reference.url,
        ...(reference.repositoryId === undefined
          ? {}
          : { repositoryId: reference.repositoryId }),
      } as const;
    case "commit":
      return {
        kind: reference.kind,
        sha: reference.sha,
        ...(reference.repositoryId === undefined
          ? {}
          : { repositoryId: reference.repositoryId }),
        ...(reference.url === undefined ? {} : { url: reference.url }),
      } as const;
    case "artifact":
      return { kind: reference.kind, name: reference.name, url: reference.url } as const;
    case "url":
      return { kind: reference.kind, label: reference.label, url: reference.url } as const;
  }
}

function successfulMutationData(value: unknown) {
  if (!isRecord(value)) return null;
  const failure = rootFailureSchema.safeParse(value);
  if (failure.success) {
    return { kind: "failure" as const, error: failure.data.error };
  }
  if (
    !hasExactKeys(value, ["ok", "data", "requestId"]) ||
    value.ok !== true ||
    !isRecord(value.data) ||
    typeof value.requestId !== "string" ||
    value.requestId.length < 1
  ) {
    return null;
  }
  return {
    kind: "success" as const,
    data: value.data,
    requestId: value.requestId,
  };
}

function parseTaskMutationData(
  data: Record<string, unknown>,
  taskId: string,
) {
  const task = taskViewSchema.safeParse(data.task);
  return task.success && task.data.id === taskId ? task.data : null;
}

function committedResult(
  intent: TaskWorkspaceClientMutationIntent,
  commandKind: TaskWorkspaceMutationResult["commandKind"],
  data: Record<string, unknown>,
  suppliedTaskId: string,
): TaskWorkspaceMutationResult["result"] | null {
  switch (intent.kind) {
    case "task.create": {
      const expectedKeys = commandKind === "task.create_and_run"
        ? ["task", "run"]
        : ["task"];
      if (!hasExactKeys(data, expectedKeys)) return null;
      const task = taskViewSchema.safeParse(data.task);
      if (!task.success || task.data.id !== suppliedTaskId) return null;
      if (commandKind === "task.create_and_run") {
        const run = taskRunViewSchema.safeParse(data.run);
        if (!run.success || run.data.taskKey !== task.data.key) return null;
        return {
          kind: "task_created",
          taskId: task.data.id,
          taskRevision: task.data.revision,
          runId: run.data.id,
        };
      }
      return {
        kind: "task_created",
        taskId: task.data.id,
        taskRevision: task.data.revision,
      };
    }
    case "task.update":
    case "task.cancel":
    case "task.reopen":
    case "task.assign":
    case "task.defer":
    case "task.parent_set":
    case "task.parent_clear":
    case "task.label_add":
    case "task.label_remove": {
      const allowed = data.parentKey === undefined
        ? ["task", "description", "labels"]
        : ["task", "description", "labels", "parentKey"];
      if (!hasExactKeys(data, allowed)) return null;
      const task = parseTaskMutationData(data, intent.taskId);
      return task === null
        ? null
        : { kind: "task_updated", taskId: task.id, taskRevision: task.revision };
    }
    case "dependency.add":
    case "dependency.remove": {
      if (!hasExactKeys(data, ["dependency", "task"])) return null;
      const task = parseTaskMutationData(data, intent.taskId);
      return task === null
        ? null
        : { kind: "task_updated", taskId: task.id, taskRevision: task.revision };
    }
    case "task.comment_add": {
      if (!hasExactKeys(data, ["comment"]) || !isRecord(data.comment)) return null;
      const id = taskCommentIdSchema.safeParse(data.comment.id);
      return id.success
        ? { kind: "comment_added", taskId: intent.taskId, commentId: id.data }
        : null;
    }
    case "task.reference_add": {
      if (!hasExactKeys(data, ["reference", "task"]) || !isRecord(data.reference)) {
        return null;
      }
      const task = parseTaskMutationData(data, intent.taskId);
      const id = taskReferenceIdSchema.safeParse(data.reference.id);
      return task !== null && id.success
        ? { kind: "reference_added", taskId: task.id, referenceId: id.data }
        : null;
    }
    case "task.reference_remove": {
      if (!hasExactKeys(data, ["referenceId", "task"])) return null;
      const task = parseTaskMutationData(data, intent.taskId);
      const id = taskReferenceIdSchema.safeParse(data.referenceId);
      return task !== null && id.success && id.data === intent.referenceId
        ? { kind: "reference_removed", taskId: task.id, referenceId: id.data }
        : null;
    }
    case "review.accept":
    case "review.reject": {
      if (!hasExactKeys(data, ["task", "submission"]) || !isRecord(data.submission)) {
        return null;
      }
      const task = parseTaskMutationData(data, intent.taskId);
      const submissionId = taskSubmissionIdSchema.safeParse(data.submission.id);
      return task !== null && submissionId.success &&
          submissionId.data === intent.submissionId
        ? {
            kind: "submission_updated",
            taskId: task.id,
            submissionId: submissionId.data,
            taskRevision: task.revision,
          }
        : null;
    }
    case "dispatch.stop": {
      if (!hasExactKeys(data, ["runId", "phase", "desiredState", "updatedAt"])) {
        return null;
      }
      const phase = runPhaseSchema.safeParse(data.phase);
      return data.runId === intent.runId && data.desiredState === "stop" && phase.success
        ? { kind: "run_updated", runId: intent.runId, phase: phase.data }
        : null;
    }
    case "dispatch.retry":
    case "dispatch.resolve_ambiguity": {
      if (!hasExactKeys(data, ["run"])) return null;
      const run = taskRunViewSchema.safeParse(data.run);
      return run.success
        ? { kind: "run_updated", runId: run.data.id, phase: run.data.phase }
        : null;
    }
    case "interaction.respond": {
      if (!hasExactKeys(data, ["interactionId", "responseRevision", "state"])) {
        return null;
      }
      return data.interactionId === intent.interactionId &&
          data.state === "answered" &&
          validPositiveRevision(data.responseRevision)
        ? {
            kind: "interaction_updated",
            runId: intent.runId,
            interactionId: intent.interactionId,
            state: "answered",
          }
        : null;
    }
    default:
      return exhaustiveIntent(intent);
  }
}

/**
 * Adapts one reactive Convex root query and one-shot commands to the shared
 * provider-free task client contract.
 */
export function createHostedTaskWorkspaceSource(
  options: HostedTaskWorkspaceSourceOptions,
): HostedTaskWorkspaceSource {
  const workspaceId = workspacePublicIdSchema.parse(options.workspaceId);
  const resolveMutationFingerprint =
    options.mutationJournal.resolveFingerprint;
  if (typeof resolveMutationFingerprint !== "function") {
    throw new TypeError(
      "Hosted task sources require an opaque mutation fingerprint resolver.",
    );
  }
  const operationId = options.operationId ?? createOperationId;
  const idempotencyKey = options.idempotencyKey ?? createIdempotencyKey;
  const taskId = options.taskId ?? createTaskId;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const wallNow = options.wallNow ?? Date.now;
  const readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(readTimeoutMs) ||
    readTimeoutMs < 1 ||
    readTimeoutMs > MAX_TIMER_INTERVAL_MS
  ) {
    throw new Error(
      "Hosted task source read timeout must be a positive 32-bit timer interval.",
    );
  }

  const sourceListeners = new Set<(event: TaskWorkspaceSourceEvent) => void>();
  const pendingEffectCancellations = new Set<(code: string) => void>();
  const loadedTaskIds = new Set<string>();
  const seenPageCursors = new Set<string>();
  let disposed = false;
  let lifecycle = 0;
  let active: ActiveRoot | null = null;
  let rootValue: RootValue | null = null;
  let observedHeads: HostedTaskWorkspaceHeads | null = null;
  let processedRevision: number | null = null;
  let feedDrainOwner: number | null = null;
  let feedEpoch = 0;
  let observedPresentationContext: z.infer<typeof rootContextSchema> | null = null;
  let presentationRevision = 0;
  let presentationFingerprint = "";
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let lastErrorSignature = "";
  let replacementPublished = false;
  let rootQueryTail: Promise<void> = Promise.resolve();
  let recoveryPreflightRequired = true;
  let recoveryRootReadRequired = false;

  const preflightRecovery = async (
    context?: TaskWorkspaceEffectContext,
  ): Promise<void> => {
    if (!recoveryPreflightRequired) return;
    if (options.mutationJournal.drainOpen === undefined) {
      recoveryPreflightRequired = false;
      return;
    }
    const drained = await effectWithinBoundary(
      () => options.mutationJournal.drainOpen?.() ??
        Promise.resolve({
          blocked: 0,
          pendingReceipts: 0,
          reconciled: 0,
        }),
      context,
    );
    recoveryRootReadRequired = drained.pendingReceipts > 0;
    recoveryPreflightRequired = false;
  };

  const publish = (event: TaskWorkspaceSourceEvent): void => {
    for (const listener of [...sourceListeners]) {
      try {
        listener(event);
      } catch {
        // One subscriber cannot interrupt the Convex delivery loop.
      }
    }
  };

  const publishReplacement = (minimumRevision?: number): void => {
    if (replacementPublished) return;
    const sourceGeneration = active?.sourceGeneration;
    if (sourceGeneration === undefined) return;
    replacementPublished = true;
    publish({
      kind: "source.replaced",
      ...(minimumRevision === undefined ? {} : { minimumRevision }),
      sourceGeneration,
      workspaceId,
    });
  };

  const stopActive = (code = "SOURCE_REPLACED"): void => {
    for (const cancel of [...pendingEffectCancellations]) cancel(code);
    lifecycle += 1;
    const previous = active;
    active = null;
    rootValue = null;
    observedHeads = null;
    processedRevision = null;
    feedDrainOwner = null;
    feedEpoch += 1;
    observedPresentationContext = null;
    presentationFingerprint = "";
    loadedTaskIds.clear();
    seenPageCursors.clear();
    lastErrorSignature = "";
    replacementPublished = false;
    if (expiryTimer !== null) clearTimeout(expiryTimer);
    expiryTimer = null;
    previous?.unsubscribe();
  };

  const effectContextActive = (
    context?: TaskWorkspaceEffectContext,
  ): boolean => {
    if (context === undefined) return true;
    let now: number;
    try {
      now = monotonicNow();
    } catch {
      return false;
    }
    return !context.signal.aborted &&
      Number.isFinite(context.deadlineMonotonicMs) &&
      now < context.deadlineMonotonicMs;
  };

  const effectWithinBoundary = async <Value>(
    effect: () => Promise<Value>,
    context?: TaskWorkspaceEffectContext,
  ): Promise<Value> => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let cancel: (code: string) => void = () => undefined;
    let removeAbortListener: () => void = () => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = (code) => reject(new SourceEffectCancelledError(code));
    });
    const callerCancelled = new Promise<never>((_resolve, reject) => {
      if (context === undefined) return;
      const abort = () =>
        reject(new SourceEffectCancelledError("REQUEST_SUPERSEDED"));
      if (context.signal.aborted) {
        abort();
        return;
      }
      context.signal.addEventListener("abort", abort, { once: true });
      removeAbortListener = () =>
        context.signal.removeEventListener("abort", abort);
    });
    pendingEffectCancellations.add(cancel);
    try {
      const startedAt = monotonicNow();
      const sourceDeadline = startedAt + readTimeoutMs;
      const deadline = context === undefined
        ? sourceDeadline
        : Math.min(sourceDeadline, context.deadlineMonotonicMs);
      const callerOwnsDeadline = context !== undefined &&
        context.deadlineMonotonicMs < sourceDeadline;
      if (
        !Number.isFinite(startedAt) ||
        !Number.isFinite(deadline) ||
        deadline <= startedAt ||
        context?.signal.aborted === true
      ) {
        throw new SourceEffectCancelledError("REQUEST_SUPERSEDED");
      }
      return await Promise.race([
        effect(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                callerOwnsDeadline
                  ? new SourceEffectCancelledError("REQUEST_SUPERSEDED")
                  : new Error("Hosted task source effect timed out."),
              ),
            Math.max(0, deadline - startedAt),
          );
        }),
        cancelled,
        callerCancelled,
      ]);
    } finally {
      pendingEffectCancellations.delete(cancel);
      removeAbortListener();
      if (timeout !== null) clearTimeout(timeout);
    }
  };

  const serializeRootQuery = <Value>(
    effect: () => Promise<Value>,
  ): Promise<Value> => {
    const result = rootQueryTail.then(effect);
    rootQueryTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const publishInvalidation = (
    minimumRevision: number,
    views: readonly TaskWorkspaceCoordinate["view"][],
  ): void => {
    const sourceGeneration = active?.sourceGeneration;
    if (sourceGeneration === undefined) return;
    publish({
      kind: "projection.invalidated",
      minimumRevision,
      sourceGeneration,
      views,
      workspaceId,
    });
  };

  const scheduleRenewal = (
    value: RootValue,
    ownedLifecycle: number,
  ): void => {
    if (expiryTimer !== null) clearTimeout(expiryTimer);
    const delay = Math.max(
      0,
      value.usableUntilMonotonic - monotonicNow(),
    );
    expiryTimer = setTimeout(() => {
      expiryTimer = null;
      if (
        disposed ||
        active?.lifecycle !== ownedLifecycle ||
        rootValue?.sourceToken !== value.sourceToken
      ) {
        return;
      }
      publishReplacement(value.envelope.projection.projectionRevision);
    }, delay);
    (expiryTimer as ReturnType<typeof setTimeout> & { unref?: () => void })
      .unref?.();
  };

  const rootIsUsable = (value: RootValue): boolean => {
    if (
      replacementPublished ||
      monotonicNow() >= value.usableUntilMonotonic
    ) {
      publishReplacement(value.envelope.projection.projectionRevision);
      return false;
    }
    return true;
  };

  const installPresentation = (
    value: RootValue,
    presentation: HostedTaskWorkspacePresentation,
    context: z.infer<typeof rootContextSchema>,
    publishUpdate: boolean,
  ): RootValue => {
    const fingerprint = JSON.stringify(presentation);
    const changed = fingerprint !== presentationFingerprint;
    presentationRevision = changed
      ? Math.max(presentationRevision + 1, value.envelope.presentationRevision)
      : Math.max(presentationRevision, value.envelope.presentationRevision);
    presentationFingerprint = fingerprint;
    const next = Object.freeze({
      ...value,
      context,
      envelope: Object.freeze({
        ...value.envelope,
        presentation,
        presentationRevision,
      }),
      presentation,
    });
    if (publishUpdate && changed) {
      const sourceGeneration = active?.sourceGeneration;
      if (sourceGeneration === undefined) return next;
      publish({
        kind: "presentation.updated",
        presentation,
        presentationRevision,
        sourceGeneration,
        workspaceId,
      });
    }
    return next;
  };

  const publishObservedPresentation = (ownedLifecycle: number): void => {
    const current = rootValue;
    if (
      disposed ||
      active?.lifecycle !== ownedLifecycle ||
      current === null ||
      observedPresentationContext === null
    ) {
      return;
    }
    const context = observedPresentationContext;
    const presentation = normalizePresentation(
      context,
      current.presentation.counts,
    );
    if (presentation === null) {
      publishReplacement(current.envelope.projection.projectionRevision);
      return;
    }
    const next = installPresentation(current, presentation, context, true);
    if (next !== current) rootValue = next;
  };

  const advanceRootForTaskPatches = (
    revision: number,
    patches: readonly Readonly<{
      item: TaskWorkspaceListItem;
      taskId: string;
    }>[],
  ): boolean => {
    const current = rootValue;
    if (current === null) return false;
    const projection = current.envelope.projection;
    if (revision <= projection.projectionRevision) return true;
    const itemsByTask = new Map(patches.map(({ item, taskId }) => [taskId, item]));
    const firstPageItems = projection.firstPage.items.map((candidate) =>
      itemsByTask.get(candidate.task.id) ?? candidate
    );
    Object.freeze(firstPageItems);
    const nextProjection: TaskWorkspaceProjectionBundle = Object.freeze({
      ...projection,
      projectionRevision: revision,
      firstPage: Object.freeze({
        ...projection.firstPage,
        items: firstPageItems,
        projectionRevision: revision,
      }),
      detail: projection.detail === null
        ? null
        : Object.freeze({ ...projection.detail, projectionRevision: revision }),
    });
    rootValue = Object.freeze({
      ...current,
      envelope: Object.freeze({
        ...current.envelope,
        projection: nextProjection,
      }),
    });
    return true;
  };

  const acceptRoot = (
    normalized: TaskWorkspaceSourceResult<RootValue>,
    ownedLifecycle: number,
  ): TaskWorkspaceSourceResult<TaskWorkspaceProjectionEnvelope> => {
    if (disposed || active?.lifecycle !== ownedLifecycle) {
      return sourceFailure("SOURCE_REPLACED");
    }
    if (replacementPublished) return sourceFailure("SOURCE_REPLACED");
    if (!normalized.ok) {
      const signature = `${normalized.error.code}:${normalized.error.reference ?? ""}`;
      if (rootValue !== null && signature !== lastErrorSignature) {
        lastErrorSignature = signature;
        publishReplacement(rootValue.envelope.projection.projectionRevision);
      }
      return normalized;
    }
    const revision = normalized.value.envelope.projection.projectionRevision;
    if (
      rootValue !== null &&
      revision < rootValue.envelope.projection.projectionRevision
    ) {
      return sourceFailure("PROJECTION_MISMATCH");
    }
    if (
      rootValue !== null &&
      rootValue.sourceToken !== normalized.value.sourceToken &&
      rootValue.continuationRevision === normalized.value.continuationRevision
    ) {
      publishReplacement(Math.max(
        rootValue.envelope.projection.projectionRevision,
        revision,
      ));
      return sourceFailure("SOURCE_REPLACED");
    }
    const acceptedContext =
      observedPresentationContext !== null &&
      presentationContextTime(observedPresentationContext) >=
        presentationContextTime(normalized.value.context)
        ? observedPresentationContext
        : normalized.value.context;
    const acceptedPresentation = normalizePresentation(
      acceptedContext,
      normalized.value.presentation.counts,
    );
    if (acceptedPresentation === null) {
      return sourceFailure("INVALID_PROJECTION");
    }
    const acceptedRoot = installPresentation(
      normalized.value,
      acceptedPresentation,
      acceptedContext,
      false,
    );
    const previousRoot = rootValue;
    const preserveLoadedPages = previousRoot !== null &&
      previousRoot.continuationRevision === acceptedRoot.continuationRevision &&
      previousRoot.envelope.projection.firstPage.cursor ===
        acceptedRoot.envelope.projection.firstPage.cursor &&
      previousRoot.envelope.projection.firstPage.hasMore ===
        acceptedRoot.envelope.projection.firstPage.hasMore &&
      previousRoot.envelope.projection.firstPage.items.length ===
        acceptedRoot.envelope.projection.firstPage.items.length &&
      previousRoot.envelope.projection.firstPage.items.every(({ task }, index) =>
        task.id === acceptedRoot.envelope.projection.firstPage.items[index]?.task.id
      );
    feedEpoch += 1;
    rootValue = acceptedRoot;
    observedPresentationContext = acceptedContext;
    if (!preserveLoadedPages) {
      loadedTaskIds.clear();
      seenPageCursors.clear();
    }
    for (const { task } of acceptedRoot.envelope.projection.firstPage.items) {
      loadedTaskIds.add(task.id);
    }
    if (acceptedRoot.envelope.projection.firstPage.cursor !== null) {
      seenPageCursors.add(acceptedRoot.envelope.projection.firstPage.cursor);
    }
    lastErrorSignature = "";
    processedRevision = Math.max(processedRevision ?? 0, revision);
    if (!rootIsUsable(acceptedRoot)) {
      return sourceFailure("SOURCE_REPLACED");
    }
    scheduleRenewal(acceptedRoot, ownedLifecycle);
    if (
      observedHeads !== null &&
      observedHeads.projectionRevision > revision
    ) {
      void drainChanges(ownedLifecycle);
    }
    return sourceSuccess(acceptedRoot.envelope);
  };

  const headsAreValid = (
    heads: HostedTaskWorkspaceHeads,
    coordinate: TaskWorkspaceCoordinate,
  ): boolean => heads.workspaceId === workspaceId &&
    heads.view === coordinate.view &&
    heads.continuationRevision === heads.taskViewRevisions[coordinate.view] &&
    taskWorkspaceViewValues.every((view) =>
      heads.taskViewRevisions[view] <= heads.projectionRevision
    ) &&
    (
      observedHeads === null ||
      (
        heads.projectionRevision >= observedHeads.projectionRevision &&
        taskWorkspaceViewValues.every((view) =>
          heads.taskViewRevisions[view] >= observedHeads!.taskViewRevisions[view]
        )
      )
    );

  const requestConservativeRefresh = (
    revision: number,
    ownedLifecycle: number,
  ): void => {
    const current = active;
    if (
      disposed ||
      current === null ||
      current.lifecycle !== ownedLifecycle ||
      !validPositiveRevision(revision)
    ) {
      return;
    }
    feedEpoch += 1;
    processedRevision = Math.max(processedRevision ?? 0, revision);
    loadedTaskIds.clear();
    seenPageCursors.clear();
    if (rootValue !== null) {
      for (const { task } of rootValue.envelope.projection.firstPage.items) {
        loadedTaskIds.add(task.id);
      }
      if (rootValue.envelope.projection.firstPage.cursor !== null) {
        seenPageCursors.add(rootValue.envelope.projection.firstPage.cursor);
      }
    }
    publishInvalidation(revision, [current.coordinate.view]);
  };

  async function drainChanges(ownedLifecycle: number): Promise<void> {
    const owned = active;
    if (
      disposed ||
      feedDrainOwner !== null ||
      owned === null ||
      owned.lifecycle !== ownedLifecycle ||
      rootValue === null ||
      processedRevision === null ||
      observedHeads === null ||
      observedHeads.projectionRevision <= processedRevision
    ) {
      return;
    }
    feedDrainOwner = ownedLifecycle;
    const ownedFeedEpoch = feedEpoch;
    const drainStartedAt = monotonicNow();
    const drainBudgetExpired = (): boolean => {
      const currentTime = monotonicNow();
      return !Number.isFinite(drainStartedAt) ||
        !Number.isFinite(currentTime) ||
        currentTime < drainStartedAt ||
        currentTime - drainStartedAt >= readTimeoutMs;
    };
    let cursor = processedRevision;
    let targetContinuation = rootValue.continuationRevision;
    const patchTaskIds = new Set<string>();
    let forceRefresh = false;
    let refreshRevision = observedHeads.projectionRevision;
    try {
      for (let page = 0; ; page += 1) {
        if (
          disposed ||
          active?.lifecycle !== ownedLifecycle ||
          feedEpoch !== ownedFeedEpoch ||
          rootValue === null
        ) {
          return;
        }
        const target = observedHeads;
        if (target === null || target.projectionRevision <= cursor) break;
        if (page >= MAX_CHANGE_DRAIN_PAGES) {
          forceRefresh = true;
          refreshRevision = target.projectionRevision;
          break;
        }
        if (drainBudgetExpired()) {
          forceRefresh = true;
          refreshRevision = target.projectionRevision;
          break;
        }
        const raw = await effectWithinBoundary(() =>
          options.client.query(api.humanTaskWorkspace.changes, {
            workspaceId,
            afterRevision: cursor,
            limit: CHANGE_PAGE_LIMIT,
          }),
        );
        if (
          disposed ||
          active?.lifecycle !== ownedLifecycle ||
          feedEpoch !== ownedFeedEpoch
        ) return;
        const normalized = normalizeChangesResult(raw);
        if (!normalized.ok) {
          forceRefresh = true;
          refreshRevision = target.projectionRevision;
          break;
        }
        const feed = normalized.value;
        const revisionsValid = taskWorkspaceViewValues.every((view) =>
          feed.taskViewRevisions[view] <= feed.projectionRevision
        );
        const contiguous = feed.changes.every((change, index) =>
          change.projectionRevision === cursor + index + 1
        );
        const lastChangeRevision = feed.changes.at(-1)?.projectionRevision ?? cursor;
        if (
          feed.workspaceId !== workspaceId ||
          feed.fromRevision !== cursor ||
          feed.throughRevision < cursor ||
          feed.throughRevision > feed.projectionRevision ||
          !revisionsValid ||
          !contiguous ||
          (
            !feed.resetRequired &&
            feed.throughRevision !== lastChangeRevision
          ) ||
          (
            !feed.resetRequired &&
            feed.hasMore !== (feed.throughRevision < feed.projectionRevision)
          )
        ) {
          forceRefresh = true;
          refreshRevision = Math.max(target.projectionRevision, feed.projectionRevision);
          break;
        }
        refreshRevision = feed.projectionRevision;
        targetContinuation = feed.taskViewRevisions[owned.coordinate.view];
        if (feed.resetRequired) {
          cursor = feed.throughRevision;
          forceRefresh = true;
          break;
        }
        for (const change of feed.changes) {
          if (change.scope === "workspace") {
            forceRefresh = true;
            break;
          }
          if (
            change.structure ||
            change.taskId === owned.coordinate.selectedTaskId
          ) {
            forceRefresh = true;
            break;
          }
          if (
            change.views.includes(owned.coordinate.view) &&
            loadedTaskIds.has(change.taskId)
          ) {
            patchTaskIds.add(change.taskId);
          }
        }
        cursor = feed.throughRevision;
        if (forceRefresh || !feed.hasMore) {
          if (
            !forceRefresh &&
            observedHeads !== null &&
            observedHeads.projectionRevision > cursor
          ) {
            continue;
          }
          break;
        }
      }

      if (
        disposed ||
        active?.lifecycle !== ownedLifecycle ||
        feedEpoch !== ownedFeedEpoch ||
        rootValue === null
      ) {
        return;
      }
      if (
        forceRefresh ||
        patchTaskIds.size > MAX_TARGETED_PATCHES ||
        targetContinuation !== rootValue.continuationRevision
      ) {
        requestConservativeRefresh(refreshRevision, ownedLifecycle);
        return;
      }

      const pinnedToken = rootValue.sourceToken;
      const pinnedClassifiedAt = rootValue.classifiedAt;
      const patches: Array<Readonly<{
        item: TaskWorkspaceListItem;
        taskId: string;
      }>> = [];
      for (const changedTaskId of patchTaskIds) {
        if (drainBudgetExpired()) {
          requestConservativeRefresh(cursor, ownedLifecycle);
          return;
        }
        const raw = await effectWithinBoundary(() =>
          options.client.query(api.humanTaskQueries.taskPatch, {
            workspaceId,
            taskId: changedTaskId,
            view: owned.coordinate.view,
            ...(owned.coordinate.assignedAgentId === undefined
              ? {}
              : { assignedAgentId: owned.coordinate.assignedAgentId }),
            classifiedAt: pinnedClassifiedAt,
            expectedProjectionRevision: cursor,
          }),
        );
        if (
          disposed ||
          active?.lifecycle !== ownedLifecycle ||
          feedEpoch !== ownedFeedEpoch ||
          rootValue?.sourceToken !== pinnedToken
        ) {
          return;
        }
        const patch = normalizeTaskPatchResult(raw, {
          classifiedAt: pinnedClassifiedAt,
          projectionRevision: cursor,
          taskId: changedTaskId,
          view: owned.coordinate.view,
        });
        if (
          !patch.ok ||
          patch.value.item === null ||
          patch.value.continuationRevision !== targetContinuation
        ) {
          requestConservativeRefresh(
            Math.max(cursor, observedHeads?.projectionRevision ?? cursor),
            ownedLifecycle,
          );
          return;
        }
        patches.push({ item: patch.value.item, taskId: changedTaskId });
      }
      if (!advanceRootForTaskPatches(cursor, patches)) {
        requestConservativeRefresh(cursor, ownedLifecycle);
        return;
      }
      processedRevision = cursor;
      const patchEvent = {
        kind: "projection.patched",
        continuationRevision: targetContinuation,
        patches: Object.freeze(patches),
        projectionRevision: cursor,
        sourceGeneration: owned.sourceGeneration,
        workspaceId,
      } as const;
      publish(owned.coordinate.view === "assigned"
        ? {
            ...patchEvent,
            view: "assigned",
            ...(owned.coordinate.assignedAgentId === undefined
              ? {}
              : { assignedAgentId: owned.coordinate.assignedAgentId }),
          }
        : {
            ...patchEvent,
            view: owned.coordinate.view,
          });
    } catch (cause) {
      if (
        cause instanceof SourceEffectCancelledError &&
        cause.marker === SOURCE_EFFECT_CANCELLED
      ) {
        return;
      }
      publishReplacement(rootValue?.envelope.projection.projectionRevision);
    } finally {
      if (feedDrainOwner === ownedLifecycle) feedDrainOwner = null;
      if (
        !disposed &&
        active?.lifecycle === ownedLifecycle &&
        feedEpoch === ownedFeedEpoch &&
        observedHeads !== null &&
        processedRevision !== null &&
        observedHeads.projectionRevision > processedRevision
      ) {
        queueMicrotask(() => void drainChanges(ownedLifecycle));
      }
    }
  }

  const consumeHeadsWatch = (ownedLifecycle: number): void => {
    const current = active;
    if (disposed || current === null || current.lifecycle !== ownedLifecycle) return;
    let value: unknown;
    try {
      value = current.headsWatch.localQueryResult();
    } catch {
      publishReplacement(rootValue?.envelope.projection.projectionRevision);
      return;
    }
    const normalized = normalizeHeadsResult(value);
    if (normalized === null) return;
    if (!normalized.ok || !headsAreValid(normalized.value, current.coordinate)) {
      publishReplacement(rootValue?.envelope.projection.projectionRevision);
      return;
    }
    observedHeads = normalized.value;
    void drainChanges(ownedLifecycle);
  };

  const consumePresentationWatch = (ownedLifecycle: number): void => {
    const current = active;
    if (disposed || current === null || current.lifecycle !== ownedLifecycle) return;
    let value: unknown;
    try {
      value = current.presentationWatch.localQueryResult();
    } catch {
      publishReplacement(rootValue?.envelope.projection.projectionRevision);
      return;
    }
    if (value === undefined) return;
    const failure = domainFailure(value);
    if (failure !== null) {
      publishReplacement(rootValue?.envelope.projection.projectionRevision);
      return;
    }
    const parsed = presentationContextSuccessSchema.safeParse(value);
    if (!parsed.success || parsed.data.data.workspace.workspace.id !== workspaceId) {
      publishReplacement(rootValue?.envelope.projection.projectionRevision);
      return;
    }
    if (
      observedPresentationContext !== null &&
      presentationContextTime(parsed.data.data) <
        presentationContextTime(observedPresentationContext)
    ) {
      return;
    }
    observedPresentationContext = parsed.data.data;
    publishObservedPresentation(ownedLifecycle);
  };

  const install = (
    coordinate: TaskWorkspaceCoordinate,
    sourceGeneration: number,
  ): ActiveRoot => {
    stopActive();
    const ownedLifecycle = lifecycle;
    const headsWatch = options.client.watchQuery(
      api.humanTaskWorkspace.heads,
      { workspaceId, view: coordinate.view },
    ) as HostedWatch;
    const presentationWatch = options.client.watchQuery(
      api.humanTaskWorkspace.presentation,
      { workspaceId },
    ) as HostedWatch;
    let unsubscribeHeads: () => void = () => undefined;
    let unsubscribePresentation: () => void = () => undefined;
    const candidate: ActiveRoot = {
      coordinate: Object.freeze({ ...coordinate }),
      coordinateKey: coordinateKey(coordinate),
      headsWatch,
      lifecycle: ownedLifecycle,
      presentationWatch,
      sourceGeneration,
      unsubscribe: () => {
        unsubscribeHeads();
        unsubscribePresentation();
      },
    };
    active = candidate;
    try {
      unsubscribeHeads = headsWatch.onUpdate(() =>
        consumeHeadsWatch(ownedLifecycle));
      unsubscribePresentation = presentationWatch.onUpdate(() =>
        consumePresentationWatch(ownedLifecycle));
      consumeHeadsWatch(ownedLifecycle);
      consumePresentationWatch(ownedLifecycle);
      return candidate;
    } catch (error) {
      if (active === candidate) stopActive();
      else candidate.unsubscribe();
      throw error;
    }
  };

  const ensureActive = (
    coordinate: TaskWorkspaceCoordinate,
    sourceGeneration: number,
  ): ActiveRoot => {
    if (
      active === null ||
      active.coordinateKey !== coordinateKey(coordinate) ||
      active.sourceGeneration !== sourceGeneration
    ) {
      return install(coordinate, sourceGeneration);
    }
    return active;
  };

  const readProjection = async (
    request: TaskWorkspaceProjectionRequest,
    context?: TaskWorkspaceEffectContext,
  ): Promise<TaskWorkspaceSourceResult<TaskWorkspaceProjectionEnvelope>> => {
    if (
      disposed ||
      !validCoordinate(request.coordinate, workspaceId) ||
      !validSourceGeneration(request.sourceGeneration) ||
      (
        request.minimumRevision !== null &&
        !validPositiveRevision(request.minimumRevision)
      )
    ) {
      return sourceFailure(disposed ? "SOURCE_DISPOSED" : "INVALID_PROJECTION_REQUEST");
    }
    let current: ActiveRoot;
    try {
      current = ensureActive(request.coordinate, request.sourceGeneration);
    } catch {
      return sourceFailure("SERVICE_UNAVAILABLE");
    }
    const floor = request.minimumRevision ?? 1;
    return serializeRootQuery(async () => {
      if (
        disposed ||
        active?.lifecycle !== current.lifecycle ||
        active.sourceGeneration !== request.sourceGeneration
      ) {
        return sourceFailure(disposed ? "SOURCE_DISPOSED" : "SOURCE_REPLACED");
      }
      if (rootValue !== null && !rootIsUsable(rootValue)) {
        return sourceFailure("SOURCE_REPLACED");
      }
      try {
        await preflightRecovery(context);
      } catch (cause) {
        return sourceFailure(
          cause instanceof HostedMutationJournalError
            ? cause.code
            : "SERVICE_UNAVAILABLE",
        );
      }
      if (
        !recoveryRootReadRequired &&
        rootValue !== null &&
        rootValue.envelope.consistency.sourceGeneration === request.sourceGeneration &&
        rootValue.envelope.projection.projectionRevision >= floor &&
        (
          processedRevision === null ||
          rootValue.envelope.projection.projectionRevision >= processedRevision
        ) &&
        (
          observedHeads === null ||
          rootValue.envelope.projection.projectionRevision >=
            observedHeads.projectionRevision
        )
      ) {
        return sourceSuccess(rootValue.envelope);
      }
      const startedAtMonotonic = monotonicNow();
      try {
        const value = await effectWithinBoundary(
          () =>
            options.client.query(
              api.humanTaskWorkspace.projection,
              rootQueryArgs(request.coordinate, rootValue?.sourceToken),
            ),
          context,
        );
        const receivedAtMonotonic = monotonicNow();
        if (
          disposed ||
          active?.lifecycle !== current.lifecycle ||
          active.sourceGeneration !== request.sourceGeneration
        ) {
          return sourceFailure(disposed ? "SOURCE_DISPOSED" : "SOURCE_REPLACED");
        }
        const normalized = normalizeRootResult(
          value,
          request.coordinate,
          request.sourceGeneration,
          { receivedAtMonotonic, startedAtMonotonic },
        );
        if (
          normalized.ok &&
          normalized.value.envelope.projection.projectionRevision < floor
        ) {
          return sourceFailure("PROJECTION_MISMATCH");
        }
        const accepted = acceptRoot(normalized, current.lifecycle);
        if (accepted.ok) recoveryRootReadRequired = false;
        return accepted;
      } catch (cause) {
        if (
          cause instanceof SourceEffectCancelledError &&
          cause.marker === SOURCE_EFFECT_CANCELLED
        ) {
          return sourceFailure(cause.code);
        }
        return sourceFailure("SERVICE_UNAVAILABLE");
      }
    });
  };

  const readContinuation = async (
    request: TaskWorkspaceContinuationRequest,
    context?: TaskWorkspaceEffectContext,
  ) => {
    if (
      disposed ||
      !validCoordinate(request.coordinate, workspaceId) ||
      !validSourceGeneration(request.sourceGeneration) ||
      !validPositiveRevision(request.continuationRevision) ||
      !validPositiveRevision(request.projectionRevision) ||
      !portableProjectionCursorSchema.safeParse(request.cursor).success
    ) {
      return sourceFailure(disposed ? "SOURCE_DISPOSED" : "INVALID_CONTINUATION_REQUEST");
    }
    const current = active;
    const cached = rootValue;
    if (
      current === null ||
      cached === null ||
      current.coordinateKey !== coordinateKey(request.coordinate) ||
      current.sourceGeneration !== request.sourceGeneration ||
      cached.continuationRevision !== request.continuationRevision ||
      cached.envelope.projection.projectionRevision !== request.projectionRevision ||
      processedRevision !== request.projectionRevision
    ) {
      return sourceFailure("SOURCE_REPLACED");
    }
    if (!rootIsUsable(cached)) return sourceFailure("SOURCE_REPLACED");
    try {
      const value = await effectWithinBoundary(
        () =>
          options.client.query(
            api.humanTaskWorkspace.continuePage,
            {
              workspaceId,
              sourceToken: cached.sourceToken,
              cursor: request.cursor,
              limit: HOSTED_PAGE_LIMIT,
            },
          ),
        context,
      );
      if (
        disposed ||
        active?.lifecycle !== current.lifecycle ||
        active.sourceGeneration !== request.sourceGeneration ||
        rootValue?.sourceToken !== cached.sourceToken ||
        !rootIsUsable(cached)
      ) {
        return sourceFailure(disposed ? "SOURCE_DISPOSED" : "SOURCE_REPLACED");
      }
      if (
        rootValue.envelope.projection.projectionRevision !==
          cached.envelope.projection.projectionRevision ||
        processedRevision !== cached.envelope.projection.projectionRevision
      ) {
        return sourceFailure("TASK_STATE_CONFLICT");
      }
      const normalized = normalizeContinuationResult(value, request, cached);
      if (!normalized.ok) return normalized;
      if (
        normalized.value.cursor !== null &&
        seenPageCursors.has(normalized.value.cursor)
      ) {
        return sourceFailure("INVALID_CONTINUATION");
      }
      for (const { task } of normalized.value.items) {
        if (!loadedTaskIds.has(task.id)) loadedTaskIds.add(task.id);
      }
      if (normalized.value.cursor !== null) {
        seenPageCursors.add(normalized.value.cursor);
      }
      return normalized;
    } catch (error) {
      if (
        error instanceof SourceEffectCancelledError &&
        error.marker === SOURCE_EFFECT_CANCELLED
      ) {
        return sourceFailure(error.code);
      }
      return sourceFailure("SERVICE_UNAVAILABLE");
    }
  };

  const callMutation = async (
    intent: TaskWorkspaceClientMutationIntent,
    attempt: MutationAttempt,
    root: RootValue,
    mutation: ConvexReactClient["mutation"],
  ): Promise<Readonly<{
    commandKind: TaskWorkspaceMutationResult["commandKind"];
    raw: unknown;
  }> | TaskWorkspaceSourceResult<never>> => {
    const controls = {
      workspaceId,
      idempotencyKey: attempt.recovery.idempotencyKey,
      hraOperationId: attempt.recovery.hraOperationId,
    } as const;
    const targetKey = "taskId" in intent
      ? taskKeyForIntent(
          root,
          intent.taskId,
          "expectedTaskRevision" in intent
            ? intent.expectedTaskRevision
            : undefined,
        )
      : null;
    if ("taskId" in intent && targetKey === null) {
      return sourceFailure("TASK_STATE_CONFLICT");
    }
    switch (intent.kind) {
      case "task.create":
        if (intent.repositoryId === undefined) {
          return {
            commandKind: "task.create",
            raw: await mutation(api.humanTaskMutations.createTask, {
              ...controls,
              suppliedTaskId: attempt.recovery.suppliedTaskId,
              title: intent.title,
              ...(intent.description === undefined
                ? {}
                : { description: intent.description }),
              type: intent.type,
              priority: intent.priority,
              ...(intent.availableAt === undefined
                ? {}
                : { availableAt: intent.availableAt }),
              ...(intent.parentKey === undefined
                ? {}
                : { parentKey: intent.parentKey }),
              labels: [...intent.labels],
            }),
          };
        }
        return {
          commandKind: "task.create_and_run",
          raw: await mutation(api.dispatch.createTaskAndDispatch, {
          ...controls,
          suppliedTaskId: attempt.recovery.suppliedTaskId,
            repositoryId: intent.repositoryId,
            title: intent.title,
            ...(intent.description === undefined
              ? {}
              : { description: intent.description }),
            type: intent.type,
            priority: intent.priority,
            ...(intent.availableAt === undefined
              ? {}
              : { availableAt: intent.availableAt }),
            ...(intent.parentKey === undefined
              ? {}
              : { parentKey: intent.parentKey }),
            labels: [...intent.labels],
          }),
        };
      case "task.update":
        return {
          commandKind: intent.kind,
          raw: await mutation(api.humanTaskMutations.updateTask, {
            ...controls,
            key: targetKey ?? "",
            revision: intent.expectedTaskRevision,
            ...(intent.patch.title === undefined
              ? {}
              : { title: intent.patch.title }),
            ...(intent.patch.description === undefined
              ? {}
              : { description: intent.patch.description }),
            ...(intent.patch.type === undefined
              ? {}
              : { type: intent.patch.type }),
            ...(intent.patch.priority === undefined
              ? {}
              : { priority: intent.patch.priority }),
            ...(intent.patch.availableAt === undefined
              ? {}
              : { availableAt: intent.patch.availableAt }),
          }),
        };
      case "task.cancel":
        return {
          commandKind: intent.kind,
          raw: await mutation(api.humanTaskMutations.cancelTask, {
            ...controls,
            key: targetKey ?? "",
            revision: intent.expectedTaskRevision,
            reason: intent.reason,
          }),
        };
      case "task.reopen":
        return {
          commandKind: intent.kind,
          raw: await mutation(api.humanTaskMutations.reopenTask, {
            ...controls,
            key: targetKey ?? "",
            revision: intent.expectedTaskRevision,
          }),
        };
      case "task.assign":
        return {
          commandKind: intent.kind,
          raw: await mutation(api.humanTaskMutations.assignTask, {
            ...controls,
            key: targetKey ?? "",
            revision: intent.expectedTaskRevision,
            agentId: intent.assigneeAgentId,
          }),
        };
      case "task.defer":
        return {
          commandKind: intent.kind,
          raw: await mutation(api.humanTaskMutations.deferTask, {
            ...controls,
            key: targetKey ?? "",
            revision: intent.expectedTaskRevision,
            availableAt: intent.availableAt,
          }),
        };
      case "task.parent_set":
        return {
          commandKind: intent.kind,
          raw: await mutation(api.humanTaskMutations.setTaskParent, {
            ...controls,
            key: targetKey ?? "",
            revision: intent.expectedTaskRevision,
            parentKey: intent.parentKey,
          }),
        };
      case "task.parent_clear":
        return {
          commandKind: intent.kind,
          raw: await mutation(api.humanTaskMutations.clearTaskParent, {
            ...controls,
            key: targetKey ?? "",
            revision: intent.expectedTaskRevision,
          }),
        };
      case "task.label_add":
      case "task.label_remove": {
        const reference = intent.kind === "task.label_add"
          ? api.humanTaskMutations.addTaskLabel
          : api.humanTaskMutations.removeTaskLabel;
        return {
          commandKind: intent.kind,
          raw: await mutation(reference, {
            ...controls,
            key: targetKey ?? "",
            revision: intent.expectedTaskRevision,
            label: intent.label,
          }),
        };
      }
      case "task.comment_add":
        return {
          commandKind: intent.kind,
          raw: await mutation(api.humanTaskMutations.addTaskComment, {
            ...controls,
            key: targetKey ?? "",
            body: intent.body,
          }),
        };
      case "task.reference_add":
        return {
          commandKind: intent.kind,
          raw: await mutation(api.humanTaskMutations.addTaskReference, {
            ...controls,
            key: targetKey ?? "",
            revision: intent.expectedTaskRevision,
            reference: convexReferenceInput(intent.reference),
          }),
        };
      case "task.reference_remove":
        return {
          commandKind: intent.kind,
          raw: await mutation(api.humanTaskMutations.removeTaskReference, {
            ...controls,
            key: targetKey ?? "",
            revision: intent.expectedTaskRevision,
            referenceId: intent.referenceId,
          }),
        };
      case "dependency.add":
      case "dependency.remove": {
        const reference = intent.kind === "dependency.add"
          ? api.humanTaskMutations.addTaskDependency
          : api.humanTaskMutations.removeTaskDependency;
        return {
          commandKind: intent.kind,
          raw: await mutation(reference, {
            ...controls,
            key: targetKey ?? "",
            revision: intent.expectedTaskRevision,
            blockerKey: intent.blockerKey,
          }),
        };
      }
      case "review.accept":
      case "review.reject": {
        const reference = intent.kind === "review.accept"
          ? api.humanTaskMutations.acceptSubmission
          : api.humanTaskMutations.rejectSubmission;
        return {
          commandKind: intent.kind,
          raw: await mutation(reference, {
            ...controls,
            key: targetKey ?? "",
            reviewRevision: intent.expectedReviewRevision,
            submissionId: intent.submissionId,
            ...(intent.kind === "review.reject" ? { reason: intent.reason } : {}),
          }),
        };
      }
      case "dispatch.stop":
        return {
          commandKind: intent.kind,
          raw: await mutation(api.dispatch.requestRunStop, {
            ...controls,
            runId: intent.runId,
          }),
        };
      case "dispatch.retry":
        return {
          commandKind: intent.kind,
          raw: await mutation(api.dispatch.retryRun, {
            ...controls,
            runId: intent.sourceRunId,
            taskRevision: intent.expectedTaskRevision,
          }),
        };
      case "dispatch.resolve_ambiguity":
        return {
          commandKind: intent.kind,
          raw: await mutation(api.dispatch.abandonAmbiguousRun, {
            ...controls,
            runId: intent.sourceRunId,
            taskRevision: intent.expectedTaskRevision,
            reason: intent.reason,
          }),
        };
      case "interaction.respond": {
        let requestValue: z.infer<typeof taskRunViewSchema>["interactions"][number]["request"] | null = null;
        for (const value of root.rawRuns) {
          const run = taskRunViewSchema.safeParse(value);
          if (!run.success || run.data.id !== intent.runId) continue;
          for (const interaction of run.data.interactions) {
            if (interaction.request.id !== intent.interactionId) continue;
            if (requestValue !== null || interaction.state !== "pending") {
              return sourceFailure("PROJECTION_MISMATCH");
            }
            requestValue = interaction.request;
          }
        }
        if (requestValue === null) return sourceFailure("INTERACTION_NOT_PENDING");
        const sealedResponse = await sealRunInteractionResponse(
          requestValue,
          { runId: intent.runId, workspaceId },
          intent.response,
        );
        return {
          commandKind: intent.kind,
          raw: await mutation(
            api.dispatchInteractions.respondToRunInteraction,
            {
              ...controls,
              runId: intent.runId,
              interactionId: intent.interactionId,
              sealedResponse,
            },
          ),
        };
      }
      default:
        return exhaustiveIntent(intent);
    }
  };

  const readPostMutationProjection = (
    request: TaskWorkspaceMutationRequest,
    current: ActiveRoot,
    requireAdvancement: boolean,
    context?: TaskWorkspaceEffectContext,
  ): Promise<TaskWorkspaceSourceResult<RootValue>> =>
    serializeRootQuery(async () => {
      if (
        disposed ||
        active?.lifecycle !== current.lifecycle ||
        active.sourceGeneration !== request.basis.sourceGeneration
      ) {
        return sourceFailure(disposed ? "SOURCE_DISPOSED" : "SOURCE_REPLACED");
      }
      const pinned = rootValue;
      if (
        pinned === null ||
        pinned.envelope.consistency.sourceGeneration !==
          request.basis.sourceGeneration ||
        !rootIsUsable(pinned)
      ) {
        return sourceFailure("SOURCE_REPLACED");
      }
      const startedAtMonotonic = monotonicNow();
      try {
        const value = await effectWithinBoundary(
          () =>
            options.client.query(
              api.humanTaskWorkspace.projection,
              rootQueryArgs(request.basis.coordinate, pinned.sourceToken),
            ),
          context,
        );
        const receivedAtMonotonic = monotonicNow();
        if (
          disposed ||
          active?.lifecycle !== current.lifecycle ||
          active.sourceGeneration !== request.basis.sourceGeneration
        ) {
          return sourceFailure(disposed ? "SOURCE_DISPOSED" : "SOURCE_REPLACED");
        }
        const normalized = normalizeRootResult(
          value,
          request.basis.coordinate,
          request.basis.sourceGeneration,
          { receivedAtMonotonic, startedAtMonotonic },
        );
        if (
          !normalized.ok ||
          (
            requireAdvancement
              ? normalized.value.envelope.projection.projectionRevision <=
                request.basis.projectionRevision
              : normalized.value.envelope.projection.projectionRevision <
                request.basis.projectionRevision
          )
        ) {
          return normalized.ok
            ? sourceFailure("PROJECTION_NOT_ADVANCED")
            : normalized;
        }
        const accepted = acceptRoot(normalized, current.lifecycle);
        return accepted.ok ? normalized : accepted;
      } catch (cause) {
        if (
          cause instanceof SourceEffectCancelledError &&
          cause.marker === SOURCE_EFFECT_CANCELLED
        ) {
          return sourceFailure(cause.code);
        }
        return sourceFailure("SERVICE_UNAVAILABLE");
      }
    });

  const targetTaskIdForIntent = (
    intent: TaskWorkspaceClientMutationIntent,
  ): string | undefined => "taskId" in intent ? intent.taskId : undefined;

  const validAttemptForIntent = (
    attempt: MutationAttempt,
    intent: TaskWorkspaceClientMutationIntent,
    expectedFingerprint: string,
  ): boolean =>
    attempt.sourceId === HOSTED_TASK_MUTATION_SOURCE_ID &&
    attempt.operation === intent.kind &&
    attempt.fingerprint === expectedFingerprint &&
    attempt.attemptId === attempt.recovery.hraOperationId &&
    operationIdSchema.safeParse(attempt.recovery.hraOperationId).success &&
    uuidV7Schema.safeParse(attempt.recovery.idempotencyKey).success &&
    taskPublicIdSchema.safeParse(attempt.recovery.suppliedTaskId).success &&
    attempt.recovery.targetTaskId === targetTaskIdForIntent(intent);

  const findOpenMutationAttempt = async (
    intent: TaskWorkspaceClientMutationIntent,
    fingerprint: string,
    context?: TaskWorkspaceEffectContext,
  ): Promise<MutationAttempt | null> => {
    let cursor: Parameters<
      HostedMutationAttemptJournal["listOpen"]
    >[0]["after"] = null;
    let matching: MutationAttempt | null = null;
    for (let pageIndex = 0; pageIndex < MAX_MUTATION_ATTEMPT_DRAIN_PAGES; pageIndex += 1) {
      const page = await effectWithinBoundary(
        () =>
          options.mutationJournal.listOpen({
            sourceId: HOSTED_TASK_MUTATION_SOURCE_ID,
            after: cursor,
            limit: HOSTED_PAGE_LIMIT,
          }),
        context,
      );
      for (const candidate of page.attempts) {
        if (candidate.fingerprint !== fingerprint) continue;
        if (
          !validAttemptForIntent(candidate, intent, fingerprint) ||
          (
            matching !== null &&
            matching.attemptId !== candidate.attemptId
          )
        ) {
          throw new HostedMutationJournalError("IDEMPOTENCY_CONFLICT");
        }
        matching = candidate;
      }
      if (!page.hasMore) return matching;
      if (
        page.nextCursor === null ||
        (
          cursor !== null &&
          page.nextCursor.preparedAtMs === cursor.preparedAtMs &&
          page.nextCursor.attemptId === cursor.attemptId
        )
      ) {
        throw new HostedMutationJournalError("INVALID_PROJECTION");
      }
      cursor = page.nextCursor;
    }
    throw new HostedMutationJournalError("MUTATION_ATTEMPT_CAPACITY");
  };

  const prepareMutationAttempt = async (
    intent: TaskWorkspaceClientMutationIntent,
    context?: TaskWorkspaceEffectContext,
  ): Promise<Readonly<{
    attempt: MutationAttempt;
    recovered: boolean;
  }>> => {
    if (!effectContextActive(context)) {
      throw new SourceEffectCancelledError("REQUEST_SUPERSEDED");
    }
    const clientFingerprint = await hostedMutationFingerprint({ intent });
    if (!effectContextActive(context)) {
      throw new SourceEffectCancelledError("REQUEST_SUPERSEDED");
    }
    const fingerprint = await effectWithinBoundary(
      () => resolveMutationFingerprint(clientFingerprint),
      context,
    );
    if (!isOpaqueHostedMutationFingerprint(fingerprint)) {
      throw new HostedMutationJournalError("INVALID_PROJECTION");
    }
    if (!effectContextActive(context)) {
      throw new SourceEffectCancelledError("REQUEST_SUPERSEDED");
    }
    const existing = await findOpenMutationAttempt(
      intent,
      fingerprint,
      context,
    );
    if (existing !== null) {
      return { attempt: existing, recovered: true };
    }

    await preflightRecovery(context);

    const recovery = Object.freeze({
      idempotencyKey: idempotencyKey(),
      hraOperationId: operationId(),
      suppliedTaskId: taskId(),
      ...(targetTaskIdForIntent(intent) === undefined
        ? {}
        : { targetTaskId: targetTaskIdForIntent(intent) }),
    });
    const preparedAtMs = wallNow();
    if (
      !uuidV7Schema.safeParse(recovery.idempotencyKey).success ||
      !operationIdSchema.safeParse(recovery.hraOperationId).success ||
      !taskPublicIdSchema.safeParse(recovery.suppliedTaskId).success ||
      !Number.isSafeInteger(preparedAtMs) ||
      preparedAtMs < 0
    ) {
      throw new HostedMutationJournalError("SERVICE_UNAVAILABLE");
    }
    const prepared = await effectWithinBoundary(
      () =>
        options.mutationJournal.prepare({
          attemptId: createAttemptId(recovery.hraOperationId),
          fingerprint,
          operation: intent.kind,
          sourceId: HOSTED_TASK_MUTATION_SOURCE_ID,
          preparedAtMs,
          recovery,
        }),
      context,
    );
    if (prepared.status === "collision") {
      throw new HostedMutationJournalError(
        "IDEMPOTENCY_CONFLICT",
        prepared.current.attemptId,
      );
    }
    if (!validAttemptForIntent(prepared.record, intent, fingerprint)) {
      throw new HostedMutationJournalError("IDEMPOTENCY_CONFLICT");
    }
    return {
      attempt: prepared.record,
      recovered: prepared.status === "existing",
    };
  };

  const sameSettlementOutcome = (
    left: DispatchOutcome<HostedMutationResolution>,
    right: DispatchOutcome<HostedMutationResolution>,
  ): boolean => {
    if (left.status !== right.status || left.attemptId !== right.attemptId) {
      return false;
    }
    switch (left.status) {
      case "confirmed":
        return right.status === "confirmed" &&
          left.value.kind === right.value.kind &&
          left.value.commandKind === right.value.commandKind;
      case "rejected":
        return right.status === "rejected" &&
          left.error.code === right.error.code &&
          left.error.retryable === right.error.retryable;
      case "cancelled":
        return right.status === "cancelled" &&
          left.reason === right.reason;
      case "ambiguous":
        return right.status === "ambiguous";
    }
  };

  const settleMutationAttempt = async (
    currentAttempt: MutationAttempt,
    outcome: DispatchOutcome<HostedMutationResolution>,
    context?: TaskWorkspaceEffectContext,
  ): Promise<MutationAttempt | null> => {
    if (
      currentAttempt.state === "settled" &&
      sameSettlementOutcome(currentAttempt.outcome, outcome)
    ) {
      return currentAttempt;
    }
    if (currentAttempt.state === "settled") return null;
    try {
      const transition = await effectWithinBoundary(
        () =>
          options.mutationJournal.settle({
            operation: currentAttempt.operation,
            attemptId: currentAttempt.attemptId,
            expectedRevision: currentAttempt.revision,
            outcome,
            settledAtMs: Math.max(
              wallNow(),
              currentAttempt.preparedAtMs,
            ),
          }),
        context,
      );
      if (
        transition.status === "applied" &&
        transition.record.state === "settled" &&
        sameSettlementOutcome(transition.record.outcome, outcome)
      ) {
        return transition.record;
      }
      if (
        (
          transition.status === "conflict" ||
          transition.status === "invalid-transition"
        ) &&
        transition.current.state === "settled" &&
        sameSettlementOutcome(transition.current.outcome, outcome)
      ) {
        return transition.current;
      }
      return null;
    } catch {
      try {
        const durable = await effectWithinBoundary(
          () => options.mutationJournal.get(currentAttempt.attemptId),
          context,
        );
        return durable?.state === "settled" &&
            sameSettlementOutcome(durable.outcome, outcome)
          ? durable
          : null;
      } catch {
        return null;
      }
    }
  };

  const rejectedMutationOutcome = (
    attempt: MutationAttempt,
    code: string,
  ): DispatchOutcome<HostedMutationResolution> =>
    rejected(attempt.attemptId, {
      code,
      message: "The hosted mutation was rejected.",
      retryable: false,
    });

  const mutationFailureRequiresReconciliation = (code: string): boolean =>
    code === "IDEMPOTENCY_CONFLICT" ||
    code === "IDEMPOTENCY_EXPIRED" ||
    code === "INTERNAL_ERROR";

  const unknownMutationOutcome = (
    hraOperationId: string,
  ): TaskWorkspaceSourceResult<never> => {
    recoveryPreflightRequired = true;
    return sourceFailure("MUTATION_OUTCOME_UNKNOWN", hraOperationId);
  };

  const execute = async (
    request: TaskWorkspaceMutationRequest,
    context?: TaskWorkspaceEffectContext,
  ): Promise<TaskWorkspaceSourceResult<TaskWorkspaceMutationResult>> => {
    if (
      disposed ||
      !validCoordinate(request.basis.coordinate, workspaceId) ||
      !validSourceGeneration(request.basis.sourceGeneration) ||
      !validPositiveRevision(request.basis.projectionRevision)
    ) {
      return sourceFailure(disposed ? "SOURCE_DISPOSED" : "INVALID_MUTATION_REQUEST");
    }
    const parsedIntent = taskWorkspaceClientIntentSchema.safeParse(request.intent);
    if (!parsedIntent.success) {
      return sourceFailure("INVALID_INTENT");
    }
    const intent = parsedIntent.data;
    if (
      intent.kind === "view.select" ||
      intent.kind === "task.select" ||
      intent.kind === "page.load_more"
    ) return sourceFailure("INVALID_INTENT");
    const current = active;
    const cached = rootValue;
    if (
      current === null ||
      cached === null ||
      current.coordinateKey !== coordinateKey(request.basis.coordinate) ||
      current.sourceGeneration !== request.basis.sourceGeneration ||
      cached.envelope.projection.projectionRevision !== request.basis.projectionRevision
    ) {
      return sourceFailure("TASK_STATE_CONFLICT");
    }
    if (!rootIsUsable(cached)) return sourceFailure("SOURCE_REPLACED");
    let attempt: MutationAttempt;
    let recovered = false;
    try {
      const prepared = await prepareMutationAttempt(intent, context);
      attempt = prepared.attempt;
      recovered = prepared.recovered;
    } catch (cause) {
      if (cause instanceof HostedMutationJournalError) {
        return sourceFailure(cause.code, cause.reference);
      }
      if (
        cause instanceof SourceEffectCancelledError &&
        cause.marker === SOURCE_EFFECT_CANCELLED
      ) {
        return sourceFailure(cause.code);
      }
      return sourceFailure("SERVICE_UNAVAILABLE");
    }

    let receiptReplayProven = false;
    if (recovered && attempt.state !== "settled") {
      try {
        const reconciliation = await options.mutationJournal.settle({
          operation: attempt.operation,
          attemptId: attempt.attemptId,
          expectedRevision: attempt.revision,
          outcome: cancelled(attempt.attemptId, "superseded"),
          settledAtMs: Math.max(wallNow(), attempt.preparedAtMs),
        });
        if (
          reconciliation.status === "invalid-transition" &&
          reconciliation.current.state === "effect-started" &&
          validAttemptForIntent(
            reconciliation.current,
            intent,
            attempt.fingerprint,
          )
        ) {
          attempt = reconciliation.current;
          receiptReplayProven = true;
        } else {
          return unknownMutationOutcome(
            attempt.recovery.hraOperationId,
          );
        }
      } catch {
        return unknownMutationOutcome(attempt.recovery.hraOperationId);
      }
    }

    let effectBoundaryEntered = attempt.state !== "prepared";
    let dispatchStarted = false;
    let executionClosed = false;
    const trackedMutation: ConvexReactClient["mutation"] = async (
      reference,
      ...argsAndOptions
    ) => {
      if (attempt.state === "prepared") {
        effectBoundaryEntered = true;
        const transition = await options.mutationJournal.markEffectStarted(
          attempt.attemptId,
          attempt.revision,
          Math.max(wallNow(), attempt.preparedAtMs),
        );
        if (
          transition.status === "applied" &&
          transition.record.state !== "prepared" &&
          validAttemptForIntent(
            transition.record,
            intent,
            attempt.fingerprint,
          )
        ) {
          attempt = transition.record;
        } else if (
          (
            transition.status === "conflict" ||
            transition.status === "invalid-transition"
          ) &&
          transition.current.state !== "prepared" &&
          validAttemptForIntent(
            transition.current,
            intent,
            attempt.fingerprint,
          )
        ) {
          attempt = transition.current;
        } else {
          throw new HostedMutationJournalError("IDEMPOTENCY_CONFLICT");
        }
      }
      if (recovered && !receiptReplayProven) {
        throw new HostedMutationJournalError("IDEMPOTENCY_CONFLICT");
      }
      if (
        executionClosed ||
        !effectContextActive(context) ||
        disposed ||
        active?.lifecycle !== current.lifecycle ||
        active.sourceGeneration !== request.basis.sourceGeneration
      ) {
        throw new SourceEffectCancelledError("REQUEST_SUPERSEDED");
      }
      dispatchStarted = true;
      return options.client.mutation(reference, ...argsAndOptions);
    };

    try {
      const called = await effectWithinBoundary(
        () =>
          callMutation(
            intent,
            attempt,
            cached,
            trackedMutation,
          ),
        context,
      );
      if ("ok" in called) {
        if (!called.ok) {
          const settled = await settleMutationAttempt(
            attempt,
            rejectedMutationOutcome(attempt, called.error.code),
            context,
          );
          if (settled === null) {
            return unknownMutationOutcome(
              attempt.recovery.hraOperationId,
            );
          }
          attempt = settled;
        }
        return called;
      }
      const raw = successfulMutationData(called.raw);
      if (raw === null) {
        return unknownMutationOutcome(attempt.recovery.hraOperationId);
      }
      if (raw.kind === "failure") {
        if (mutationFailureRequiresReconciliation(raw.error.code)) {
          return unknownMutationOutcome(
            attempt.recovery.hraOperationId,
          );
        }
        const settled = await settleMutationAttempt(
          attempt,
          rejectedMutationOutcome(attempt, raw.error.code),
          context,
        );
        if (settled === null) {
          return unknownMutationOutcome(
            attempt.recovery.hraOperationId,
          );
        }
        attempt = settled;
        return sourceFailure(raw.error.code, raw.error.requestId);
      }
      const result = committedResult(
        intent,
        called.commandKind,
        raw.data,
        attempt.recovery.suppliedTaskId,
      );
      if (result === null) {
        return unknownMutationOutcome(attempt.recovery.hraOperationId);
      }
      if (
        disposed ||
        active?.lifecycle !== current.lifecycle ||
        active.sourceGeneration !== request.basis.sourceGeneration
      ) {
        return unknownMutationOutcome(attempt.recovery.hraOperationId);
      }
      const refreshed = await readPostMutationProjection(
        request,
        current,
        !receiptReplayProven,
        context,
      );
      if (!refreshed.ok) {
        return unknownMutationOutcome(attempt.recovery.hraOperationId);
      }
      const projectionRevision = refreshed.value.envelope.projection.projectionRevision;
      const mutation = taskWorkspaceMutationResultSchema.safeParse({
        operationId: attempt.recovery.hraOperationId,
        workspaceId,
        commandKind: called.commandKind,
        workspaceRevision: projectionRevision,
        projectionRevision,
        result,
      });
      if (!mutation.success) {
        return unknownMutationOutcome(attempt.recovery.hraOperationId);
      }
      return sourceSuccess(mutation.data);
    } catch (cause) {
      if (!effectBoundaryEntered && !dispatchStarted) {
        if (
          cause instanceof SourceEffectCancelledError &&
          cause.marker === SOURCE_EFFECT_CANCELLED
        ) {
          return sourceFailure(cause.code);
        }
        const settled = await settleMutationAttempt(
          attempt,
          rejectedMutationOutcome(attempt, "SERVICE_UNAVAILABLE"),
          context,
        );
        if (settled === null) {
          return unknownMutationOutcome(
            attempt.recovery.hraOperationId,
          );
        }
        return sourceFailure("SERVICE_UNAVAILABLE");
      }
      if (attempt.state === "effect-started") {
        try {
          const reconciliation = await options.mutationJournal.settle({
            operation: attempt.operation,
            attemptId: attempt.attemptId,
            expectedRevision: attempt.revision,
            outcome: cancelled(attempt.attemptId, "superseded"),
            settledAtMs: Math.max(wallNow(), attempt.preparedAtMs),
          });
          if (
            reconciliation.status === "applied" &&
            reconciliation.record.state === "settled" &&
            reconciliation.record.outcome.status === "cancelled"
          ) {
            return sourceFailure(
              cause instanceof SourceEffectCancelledError
                ? cause.code
                : "SERVICE_UNAVAILABLE",
            );
          }
        } catch {
          // A receipt may have committed concurrently. Preserve ambiguity.
        }
      }
      return unknownMutationOutcome(attempt.recovery.hraOperationId);
    } finally {
      executionClosed = true;
    }
  };

  const acknowledgeMutation: TaskWorkspaceSource["acknowledgeMutation"] =
    async (result, context) => {
      recoveryPreflightRequired = true;
      if (
        result.workspaceId !== workspaceId ||
        !operationIdSchema.safeParse(result.operationId).success
      ) {
        throw new HostedMutationJournalError("INVALID_MUTATION_REQUEST");
      }
      const attemptId = createAttemptId(result.operationId);
      const record = await effectWithinBoundary(
        () => options.mutationJournal.get(attemptId),
        context,
      );
      if (
        record === null ||
        record.recovery.hraOperationId !== result.operationId
      ) {
        throw new HostedMutationJournalError("IDEMPOTENCY_CONFLICT");
      }
      const outcome = confirmed(attemptId, {
        kind: "committed" as const,
        commandKind: result.commandKind,
      });
      if (
        record.state === "settled" &&
        sameSettlementOutcome(record.outcome, outcome)
      ) {
        return;
      }
      if (record.state !== "effect-started") {
        throw new HostedMutationJournalError("IDEMPOTENCY_CONFLICT");
      }
      const transition = await effectWithinBoundary(
        () =>
          options.mutationJournal.settle({
            operation: record.operation,
            attemptId: record.attemptId,
            expectedRevision: record.revision,
            outcome,
            settledAtMs: Math.max(wallNow(), record.preparedAtMs),
          }),
        context,
      );
      if (
        transition.status === "applied" &&
        transition.record.state === "settled" &&
        sameSettlementOutcome(transition.record.outcome, outcome)
      ) {
        return;
      }
      if (
        (
          transition.status === "conflict" ||
          transition.status === "invalid-transition"
        ) &&
        transition.current.state === "settled" &&
        sameSettlementOutcome(transition.current.outcome, outcome)
      ) {
        return;
      }
      throw new HostedMutationJournalError("MUTATION_OUTCOME_UNKNOWN");
    };

  const acknowledgeProjection: TaskWorkspaceSource["acknowledgeProjection"] =
    async (envelope) => {
      if (envelope.projection.workspaceId !== workspaceId) {
        throw new HostedMutationJournalError("INVALID_PROJECTION");
      }
      // A filtered projection cannot prove that a specific recovered effect
      // was presented. Hosted recovery remains open for exact semantic replay
      // (or bounded stale quarantine) and is acknowledged only through the
      // validated mutation result hook.
    };

  const maybeStop = (): void => {
    if (sourceListeners.size === 0) stopActive();
  };

  const subscribe = (
    listener: (event: TaskWorkspaceSourceEvent) => void,
  ): (() => void) => {
    if (disposed) return () => undefined;
    sourceListeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      sourceListeners.delete(listener);
      maybeStop();
    };
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    stopActive("SOURCE_DISPOSED");
    sourceListeners.clear();
  };

  return Object.freeze({
    acknowledgeProjection,
    acknowledgeMutation,
    dispose,
    execute,
    readContinuation,
    readProjection,
    subscribe,
  });
}
