import type {
  TaskListPage,
  TaskPublicId,
  TaskWorkspaceListItem,
  TaskWorkspaceClientIntent,
  TaskWorkspaceMutationResult,
  TaskWorkspaceProjectionBundle,
  TaskWorkspaceView,
  WorkspacePublicId,
} from "@hraness/agent-tasks-domain";
import {
  agentIdSchema,
  epochMsSchema,
  repositoryIdSchema,
  repositoryNameSchema,
  taskListPageSchema,
  taskWorkspaceClientIntentSchema,
  taskWorkspaceCountsSchema,
  taskWorkspaceListItemSchema,
  taskWorkspaceMutationResultSchema,
  taskWorkspaceProjectionBundleSchema,
  taskWorkspaceViewerSchema,
  taskWorkspaceViewValues,
  validatePortableRunInteractionResponse,
  workspaceNameSchema,
  workspacePublicIdSchema,
  workspaceSlugSchema,
} from "@hraness/agent-tasks-domain";
import { runnerPresenceViewSchema } from "@hraness/agent-tasks-protocol";
import {
  createReducerStore,
  type ExternalStore,
} from "@hra-internal/codex-app-sdk";

import type {
  TaskWorkspaceAgent,
  TaskWorkspaceCapabilities,
  TaskWorkspaceCounts,
  TaskWorkspaceError,
  TaskWorkspaceProps,
} from "./task-workspace-state";

export const TASK_WORKSPACE_MAX_READ_CONCURRENCY = 2;
export const TASK_WORKSPACE_MAX_PROJECTION_PATCHES = 100;
export const TASK_WORKSPACE_MAX_LOADED_PAGES = 100;
export const TASK_WORKSPACE_CLOCK_INTERVAL_MS = 1_000;
export const TASK_WORKSPACE_EFFECT_TIMEOUT_MS = 30_000;

export type TaskWorkspaceClock = Readonly<{
  cancelInterval: (handle: unknown) => void;
  cancelTimeout: (handle: unknown) => void;
  monotonicNow: () => number;
  scheduleInterval: (callback: () => void, intervalMs: number) => unknown;
  scheduleTimeout: (callback: () => void, timeoutMs: number) => unknown;
}>;

export type TaskWorkspaceEffectContext = Readonly<{
  /** Monotonic deadline owned by the client, never an epoch timestamp. */
  deadlineMonotonicMs: number;
  signal: AbortSignal;
}>;

export type HraStore<Snapshot> = ExternalStore<Snapshot>;

export type TaskWorkspaceCoordinate = Readonly<{
  assignedAgentId?: string;
  selectedTaskId: TaskPublicId | null;
  view: TaskWorkspaceView;
  workspaceId: WorkspacePublicId;
}>;

export type TaskWorkspaceProjectionConsistency =
  | Readonly<{
      kind: "atomic";
      sourceGeneration: number;
    }>
  | Readonly<{
      attempts: number;
      kind: "revision_joined";
      sourceGeneration: number;
    }>;

export type TaskWorkspaceProjectionEnvelope = Readonly<{
  consistency: TaskWorkspaceProjectionConsistency;
  presentation: TaskWorkspacePresentation;
  /** Source-owned revision of the independently reusable presentation slice. */
  presentationRevision: number;
  projection: TaskWorkspaceProjectionBundle;
}>;

export type TaskWorkspacePresentation = Readonly<{
  agents: readonly TaskWorkspaceAgent[];
  capabilities: TaskWorkspaceCapabilities;
  counts: TaskWorkspaceCounts;
  now: number;
  runner: TaskWorkspaceProps["runner"];
  viewer: TaskWorkspaceProps["viewer"];
  workspace: TaskWorkspaceProps["workspace"];
}>;

export type TaskWorkspaceSourceResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ error: TaskWorkspaceError; ok: false }>;

type TaskWorkspaceProjectionPatchScope =
  | Readonly<{
      assignedAgentId?: string;
      view: "assigned";
    }>
  | Readonly<{
      assignedAgentId?: never;
      view: Exclude<TaskWorkspaceView, "assigned">;
    }>;

export type TaskWorkspaceProjectionPatchEvent =
  & Readonly<{
    continuationRevision: number;
    kind: "projection.patched";
    patches: readonly Readonly<{
      item: TaskWorkspaceListItem;
      taskId: TaskPublicId;
    }>[];
    projectionRevision: number;
    sourceGeneration: number;
    workspaceId: WorkspacePublicId;
  }>
  & TaskWorkspaceProjectionPatchScope;

export type TaskWorkspaceSourceEvent =
  | Readonly<{
      kind: "presentation.updated";
      presentation: TaskWorkspacePresentation;
      presentationRevision: number;
      sourceGeneration: number;
      workspaceId: WorkspacePublicId;
    }>
  | TaskWorkspaceProjectionPatchEvent
  | Readonly<{
      kind: "projection.invalidated";
      continuationRevision?: number;
      minimumRevision: number;
      sourceGeneration: number;
      views: readonly TaskWorkspaceView[];
      workspaceId: WorkspacePublicId;
    }>
  | Readonly<{
      kind: "source.replaced";
      minimumRevision?: number;
      sourceGeneration: number;
      workspaceId: WorkspacePublicId;
    }>;

export type TaskWorkspaceProjectionRequest = Readonly<{
  coordinate: TaskWorkspaceCoordinate;
  minimumRevision: number | null;
  sourceGeneration: number;
}>;

export type TaskWorkspaceContinuationRequest = Readonly<{
  coordinate: TaskWorkspaceCoordinate;
  continuationRevision: number;
  cursor: string;
  projectionRevision: number;
  sourceGeneration: number;
}>;

export type TaskWorkspaceClientMutationIntent = Exclude<
  TaskWorkspaceClientIntent,
  Readonly<{
    kind: "page.load_more" | "task.select" | "view.select";
  }>
>;

export type TaskWorkspaceMutationRequest = Readonly<{
  basis: Readonly<{
    coordinate: TaskWorkspaceCoordinate;
    projectionRevision: number;
    sourceGeneration: number;
  }>;
  intent: TaskWorkspaceClientMutationIntent;
}>;

export type TaskWorkspaceSource = Readonly<{
  /**
   * Called after a validated projection is synchronously installed. Providers
   * can retire exact recovery tokens observed before the corresponding read.
   */
  acknowledgeProjection: (
    envelope: TaskWorkspaceProjectionEnvelope,
    context: TaskWorkspaceEffectContext,
  ) => Promise<void>;
  /**
   * Called only after the model has validated and installed a committed result.
   * Providers use this boundary to retire durable recovery evidence without
   * creating a lost-response duplication window.
   */
  acknowledgeMutation: (
    result: TaskWorkspaceMutationResult,
    context: TaskWorkspaceEffectContext,
  ) => Promise<void>;
  execute: (
    request: TaskWorkspaceMutationRequest,
    context: TaskWorkspaceEffectContext,
  ) => Promise<TaskWorkspaceSourceResult<TaskWorkspaceMutationResult>>;
  readContinuation: (
    request: TaskWorkspaceContinuationRequest,
    context: TaskWorkspaceEffectContext,
  ) => Promise<TaskWorkspaceSourceResult<TaskListPage>>;
  readProjection: (
    request: TaskWorkspaceProjectionRequest,
    context: TaskWorkspaceEffectContext,
  ) => Promise<TaskWorkspaceSourceResult<TaskWorkspaceProjectionEnvelope>>;
  subscribe: (
    listener: (event: TaskWorkspaceSourceEvent) => void,
  ) => () => void;
}>;

export type TaskWorkspaceContinuationState =
  | Readonly<{ kind: "complete" }>
  | Readonly<{ cursor: string; kind: "idle" }>
  | Readonly<{ cursor: string; kind: "loading" }>
  | Readonly<{
      cursor: string;
      error: TaskWorkspaceError;
      kind: "error";
    }>;

export type TaskWorkspaceRefreshState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{
      continuationSafe: boolean;
      kind: "refreshing";
      minimumRevision: number;
    }>
  | Readonly<{
      continuationSafe: boolean;
      error: TaskWorkspaceError;
      kind: "error";
      minimumRevision: number;
    }>;

export type TaskWorkspaceProjectionState =
  | Readonly<{
      kind: "loading";
      minimumRevision: number | null;
    }>
  | Readonly<{
      error: TaskWorkspaceError;
      kind: "error";
      minimumRevision: number | null;
    }>
  | Readonly<{
      continuation: TaskWorkspaceContinuationState;
      envelope: TaskWorkspaceProjectionEnvelope;
      kind: "ready";
      pages: readonly TaskListPage[];
      refresh: TaskWorkspaceRefreshState;
    }>;

export type TaskWorkspacePendingMutation =
  | Readonly<{
      basis: TaskWorkspaceMutationRequest["basis"];
      intent: TaskWorkspaceClientMutationIntent;
      phase: "dispatching";
    }>
  | Readonly<{
      basis: TaskWorkspaceMutationRequest["basis"];
      intent: TaskWorkspaceClientMutationIntent;
      phase: "acknowledging";
      result: TaskWorkspaceMutationResult;
    }>
  | Readonly<{
      basis: TaskWorkspaceMutationRequest["basis"];
      intent: TaskWorkspaceClientMutationIntent;
      phase: "synchronizing";
      result: TaskWorkspaceMutationResult;
    }>
  | Readonly<{
      basis: TaskWorkspaceMutationRequest["basis"];
      intent: TaskWorkspaceClientMutationIntent;
      phase: "outcome_unknown";
    }>;

export type TaskWorkspaceSnapshot = Readonly<{
  coordinate: TaskWorkspaceCoordinate;
  dispatchError: TaskWorkspaceError | null;
  /** Authority-calibrated display time advanced by the client clock. */
  now: number | null;
  pendingMutation: TaskWorkspacePendingMutation | null;
  projection: TaskWorkspaceProjectionState;
  sourceGeneration: number;
}>;

export type TaskWorkspaceDispatchResult =
  | Readonly<{ ok: true; outcome: "accepted" }>
  | Readonly<{
      ok: true;
      outcome: "committed";
      result: TaskWorkspaceMutationResult;
    }>
  | Readonly<{ error: TaskWorkspaceError; ok: false }>;

export type TaskWorkspaceClient = Readonly<{
  dispatch: (
    intent: TaskWorkspaceClientIntent,
  ) => Promise<TaskWorkspaceDispatchResult>;
  dispose: () => void;
  /** Retries the current projection while retaining its revision floor. */
  retry: () => void;
  start: () => void;
  store: HraStore<TaskWorkspaceSnapshot>;
}>;

export type TaskWorkspaceClientHost = Readonly<{
  client: TaskWorkspaceClient;
  /** Installs one effect-owned client and returns its idempotent cleanup. */
  install: (client: TaskWorkspaceClient) => () => void;
}>;

export type CreateTaskWorkspaceClientOptions = Readonly<{
  clock?: TaskWorkspaceClock;
  coordinate: TaskWorkspaceCoordinate;
  effectTimeoutMs?: number;
  source: TaskWorkspaceSource;
}>;

type ScheduledReadKind = "continuation" | "projection";

type ScheduledRead = Readonly<{
  cancel: () => void;
  kind: ScheduledReadKind;
  run: () => void;
}>;

const CANCELLED_READ = Symbol("cancelled task workspace read");

class CancelledReadError extends Error {
  readonly marker = CANCELLED_READ;
}

const EFFECT_DEADLINE_EXCEEDED = Symbol(
  "task workspace effect deadline exceeded",
);

class EffectDeadlineExceededError extends Error {
  readonly marker = EFFECT_DEADLINE_EXCEEDED;
}

const SYSTEM_TASK_WORKSPACE_CLOCK: TaskWorkspaceClock = Object.freeze({
  cancelInterval: (handle: unknown): void => {
    globalThis.clearInterval(
      handle as ReturnType<typeof globalThis.setInterval>,
    );
  },
  cancelTimeout: (handle: unknown): void => {
    globalThis.clearTimeout(
      handle as ReturnType<typeof globalThis.setTimeout>,
    );
  },
  monotonicNow: (): number => globalThis.performance?.now() ?? Date.now(),
  scheduleInterval: (callback: () => void, intervalMs: number): unknown =>
    globalThis.setInterval(callback, intervalMs),
  scheduleTimeout: (callback: () => void, timeoutMs: number): unknown =>
    globalThis.setTimeout(callback, timeoutMs),
});

type SourceEffectRuntime = Readonly<{
  cancelTimeout: TaskWorkspaceClock["cancelTimeout"];
  monotonicNow: TaskWorkspaceClock["monotonicNow"];
  scheduleTimeout: TaskWorkspaceClock["scheduleTimeout"];
  timeoutMs: number;
}>;

class SourceEffectBoundary<Value> {
  readonly #controller = new AbortController();
  readonly #promise: Promise<Value>;
  readonly #runtime: SourceEffectRuntime;
  #invoked = false;
  #reject: (error: Error) => void = () => undefined;
  #resolve: (value: Value) => void = () => undefined;
  #settled = false;
  #started = false;
  #timerHandle: unknown;
  #timerReady = false;

  constructor(runtime: SourceEffectRuntime) {
    this.#runtime = runtime;
    this.#promise = new Promise<Value>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  get invoked(): boolean {
    return this.#invoked;
  }

  get promise(): Promise<Value> {
    return this.#promise;
  }

  cancel(error: Error): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#cancelTimer();
    try {
      this.#controller.abort(error);
    } catch {
      try {
        this.#controller.abort();
      } catch {
        // A hostile abort observer cannot prevent logical cancellation.
      }
    }
    this.#reject(error);
  }

  start(
    effect: (context: TaskWorkspaceEffectContext) => Promise<Value>,
  ): void {
    if (this.#started || this.#settled) return;
    this.#started = true;
    let monotonicNow: number;
    try {
      monotonicNow = this.#runtime.monotonicNow();
    } catch (error) {
      this.#settleError(error instanceof Error
        ? error
        : new Error("Task workspace monotonic clock failed."));
      return;
    }
    if (this.#settled) return;
    const context: TaskWorkspaceEffectContext = Object.freeze({
      deadlineMonotonicMs: Math.min(
        Number.MAX_SAFE_INTEGER,
        monotonicNow + this.#runtime.timeoutMs,
      ),
      signal: this.#controller.signal,
    });
    try {
      const handle = this.#runtime.scheduleTimeout(() => {
        this.cancel(new EffectDeadlineExceededError(
          "Task workspace effect deadline exceeded.",
        ));
      }, this.#runtime.timeoutMs);
      this.#timerHandle = handle;
      this.#timerReady = true;
      if (this.#settled) {
        this.#cancelTimer();
        return;
      }
    } catch (error) {
      this.#settleError(error instanceof Error
        ? error
        : new Error("Task workspace effect timer failed."));
      return;
    }

    this.#invoked = true;
    let result: Promise<Value>;
    try {
      result = effect(context);
    } catch (error) {
      this.#settleError(error instanceof Error
        ? error
        : new Error("Task workspace source failed."));
      return;
    }
    void Promise.resolve(result).then(
      (value) => this.#settleValue(value),
      (error: unknown) => this.#settleError(error instanceof Error
        ? error
        : new Error("Task workspace source failed.")),
    );
  }

  #cancelTimer(): void {
    if (!this.#timerReady) return;
    this.#timerReady = false;
    try {
      this.#runtime.cancelTimeout(this.#timerHandle);
    } catch {
      // A settled boundary remains fenced even when timer cleanup is faulty.
    }
  }

  #settleError(error: Error): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#cancelTimer();
    this.#reject(error);
  }

  #settleValue(value: Value): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#cancelTimer();
    this.#resolve(value);
  }
}

class BoundedReadScheduler {
  readonly #active = new Set<ScheduledRead>();
  readonly #limit: number;
  readonly #runtime: SourceEffectRuntime;
  #pending: ScheduledRead[] = [];

  constructor(limit: number, runtime: SourceEffectRuntime) {
    this.#limit = limit;
    this.#runtime = runtime;
  }

  run<Value>(
    kind: ScheduledReadKind,
    effect: (context: TaskWorkspaceEffectContext) => Promise<Value>,
  ): Promise<Value> {
    return new Promise<Value>((resolve, reject) => {
      let boundary: SourceEffectBoundary<Value> | null = null;
      let phase: "active" | "pending" | "settled" = "pending";
      const scheduled: ScheduledRead = {
        cancel: () => {
          if (phase === "settled") return;
          if (phase === "pending") {
            phase = "settled";
            reject(new CancelledReadError());
            return;
          }
          boundary?.cancel(new CancelledReadError());
        },
        kind,
        run: () => {
          if (phase !== "pending") return;
          phase = "active";
          this.#active.add(scheduled);
          try {
            boundary = new SourceEffectBoundary<Value>(this.#runtime);
          } catch (error) {
            phase = "settled";
            this.#active.delete(scheduled);
            reject(error instanceof Error
              ? error
              : new Error("Task workspace read failed."));
            this.#pump();
            return;
          }
          void boundary.promise.then(
            (value) => {
              if (phase !== "active") return;
              phase = "settled";
              resolve(value);
            },
            (error: unknown) => {
              if (phase !== "active") return;
              phase = "settled";
              reject(error instanceof Error
                ? error
                : new Error("Task workspace read failed."));
            },
          ).finally(() => {
            this.#active.delete(scheduled);
            this.#pump();
          });
          boundary.start(effect);
        },
      };
      this.#pending.push(scheduled);
      this.#pump();
    });
  }

  cancelAll(): void {
    const pending = this.#pending;
    this.#pending = [];
    for (const scheduled of pending) scheduled.cancel();
    for (const scheduled of [...this.#active]) scheduled.cancel();
  }

  cancelKind(kind: ScheduledReadKind): void {
    const retained: ScheduledRead[] = [];
    for (const scheduled of this.#pending) {
      if (scheduled.kind === kind) scheduled.cancel();
      else retained.push(scheduled);
    }
    this.#pending = retained;
    for (const scheduled of [...this.#active]) {
      if (scheduled.kind === kind) scheduled.cancel();
    }
  }

  #pump(): void {
    while (this.#active.size < this.#limit) {
      const scheduled = this.#pending.shift();
      if (scheduled === undefined) return;
      scheduled.run();
    }
  }
}

function publicError(code: string): TaskWorkspaceError {
  return { code };
}

function normalizeSourceError(error: unknown): TaskWorkspaceError {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.length > 0 &&
    error.code.length <= 128 &&
    (
      !("reference" in error) ||
      error.reference === undefined ||
      (
        typeof error.reference === "string" &&
        error.reference.length > 0 &&
        error.reference.length <= 256
      )
    )
  ) {
    const reference = "reference" in error ? error.reference : undefined;
    return typeof reference === "string"
      ? { code: error.code, reference }
      : { code: error.code };
  }
  return publicError("INVALID_SOURCE_ERROR");
}

function serviceUnavailable(): TaskWorkspaceSourceResult<never> {
  return { error: publicError("SERVICE_UNAVAILABLE"), ok: false };
}

function mutationOutcomeUnknown(): TaskWorkspaceSourceResult<never> {
  return { error: publicError("MUTATION_OUTCOME_UNKNOWN"), ok: false };
}

function normalizeSourceResult<Value>(result: unknown): TaskWorkspaceSourceResult<Value> {
  if (
    result !== null &&
    typeof result === "object" &&
    "ok" in result
  ) {
    if (result.ok === true && "value" in result) {
      return { ok: true, value: result.value as Value };
    }
    if (result.ok === false && "error" in result) {
      return { error: normalizeSourceError(result.error), ok: false };
    }
  }
  return serviceUnavailable();
}

async function settleSourceEffect<Value>(
  effect: () => Promise<TaskWorkspaceSourceResult<Value>>,
): Promise<TaskWorkspaceSourceResult<Value>> {
  try {
    return normalizeSourceResult<Value>(await effect());
  } catch (error) {
    if (error instanceof CancelledReadError) throw error;
    return serviceUnavailable();
  }
}

function coordinateKey(coordinate: TaskWorkspaceCoordinate): string {
  return [
    coordinate.workspaceId,
    coordinate.view,
    coordinate.assignedAgentId ?? "",
    coordinate.selectedTaskId ?? "",
  ].join("\u0000");
}

function sameCoordinate(
  left: TaskWorkspaceCoordinate,
  right: TaskWorkspaceCoordinate,
): boolean {
  return coordinateKey(left) === coordinateKey(right);
}

function freezeCoordinate(
  coordinate: TaskWorkspaceCoordinate,
): TaskWorkspaceCoordinate {
  return Object.freeze({
    ...(coordinate.assignedAgentId === undefined
      ? {}
      : { assignedAgentId: coordinate.assignedAgentId }),
    selectedTaskId: coordinate.selectedTaskId,
    view: coordinate.view,
    workspaceId: coordinate.workspaceId,
  });
}

function maximumRevision(
  left: number | null,
  right: number | null,
): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

function continuationForPage(page: TaskListPage): TaskWorkspaceContinuationState {
  return page.cursor === null
    ? { kind: "complete" }
    : { cursor: page.cursor, kind: "idle" };
}

function sameFirstPageStructure(
  left: TaskListPage,
  right: TaskListPage,
): boolean {
  return left.cursor === right.cursor &&
    left.hasMore === right.hasMore &&
    left.items.length === right.items.length &&
    left.items.every(({ task }, index) => task.id === right.items[index]?.task.id);
}

function projectionRevision(
  projection: TaskWorkspaceProjectionState,
): number | null {
  return projection.kind === "ready"
    ? projection.envelope.projection.projectionRevision
    : null;
}

function projectionMinimumRevision(
  projection: TaskWorkspaceProjectionState,
): number | null {
  if (projection.kind !== "ready") return projection.minimumRevision;
  return projection.refresh.kind === "idle"
    ? null
    : projection.refresh.minimumRevision;
}

function validPositiveRevision(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0;
}

function validTaskWorkspaceView(value: unknown): value is TaskWorkspaceView {
  return typeof value === "string" &&
    (taskWorkspaceViewValues as readonly string[]).includes(value);
}

const TASK_WORKSPACE_PROJECTION_PATCH_EVENT_KEYS = Object.freeze([
  "continuationRevision",
  "kind",
  "patches",
  "projectionRevision",
  "sourceGeneration",
  "view",
  "workspaceId",
] as const);

function validProjectionPatchEvent(
  event: TaskWorkspaceProjectionPatchEvent,
  coordinate: TaskWorkspaceCoordinate,
): boolean {
  const hasAssignedAgentId = Object.prototype.hasOwnProperty.call(
    event,
    "assignedAgentId",
  );
  const allowedKeys: readonly string[] = hasAssignedAgentId
    ? [...TASK_WORKSPACE_PROJECTION_PATCH_EVENT_KEYS, "assignedAgentId"]
    : TASK_WORKSPACE_PROJECTION_PATCH_EVENT_KEYS;
  const actualKeys = Object.keys(event);
  return actualKeys.length === allowedKeys.length &&
    actualKeys.every((key) => allowedKeys.includes(key)) &&
    validPositiveRevision(event.projectionRevision) &&
    validPositiveRevision(event.continuationRevision) &&
    validTaskWorkspaceView(event.view) &&
    (
      !hasAssignedAgentId ||
      (
        event.view === "assigned" &&
        agentIdSchema.safeParse(event.assignedAgentId).success
      )
    ) &&
    event.view === coordinate.view &&
    event.assignedAgentId === coordinate.assignedAgentId &&
    Array.isArray(event.patches) &&
    event.patches.length <= TASK_WORKSPACE_MAX_PROJECTION_PATCHES;
}

function validConsistency(
  consistency: unknown,
  sourceGeneration: number,
): consistency is TaskWorkspaceProjectionConsistency {
  if (
    consistency === null ||
    typeof consistency !== "object" ||
    !("sourceGeneration" in consistency) ||
    !("kind" in consistency)
  ) {
    return false;
  }
  if (consistency.sourceGeneration !== sourceGeneration) return false;
  if (consistency.kind === "atomic") {
    return Object.keys(consistency).length === 2;
  }
  return consistency.kind === "revision_joined" &&
    Object.keys(consistency).length === 3 &&
    "attempts" in consistency &&
    typeof consistency.attempts === "number" &&
    Number.isSafeInteger(consistency.attempts) &&
    consistency.attempts > 0;
}

const TASK_WORKSPACE_CAPABILITY_KEYS = Object.freeze([
  "canAssign",
  "canCancel",
  "canComment",
  "canCreate",
  "canEdit",
  "canManageGraph",
  "canManageLabels",
  "canManageReferences",
  "canReopen",
  "canReview",
] as const);

function presentationRecord(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactPresentationKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    keys.every((key) => expected.includes(key));
}

/** Parses the provider-neutral presentation slice before it enters React. */
export function parseTaskWorkspacePresentation(
  value: unknown,
): TaskWorkspacePresentation | null {
  if (
    !presentationRecord(value) ||
    !hasExactPresentationKeys(value, [
      "agents",
      "capabilities",
      "counts",
      "now",
      "runner",
      "viewer",
      "workspace",
    ]) ||
    !Array.isArray(value.agents) ||
    value.agents.length > 500 ||
    !presentationRecord(value.capabilities) ||
    !hasExactPresentationKeys(
      value.capabilities,
      TASK_WORKSPACE_CAPABILITY_KEYS,
    ) ||
    !presentationRecord(value.runner) ||
    !hasExactPresentationKeys(value.runner, ["presence", "repositories"]) ||
    !Array.isArray(value.runner.repositories) ||
    value.runner.repositories.length > 128 ||
    !presentationRecord(value.workspace) ||
    !hasExactPresentationKeys(
      value.workspace,
      ["id", "keyPrefix", "name", "slug"],
    )
  ) {
    return null;
  }
  const rawCapabilities = value.capabilities;
  if (!TASK_WORKSPACE_CAPABILITY_KEYS.every(
    (key) => typeof rawCapabilities[key] === "boolean"
  )) {
    return null;
  }

  const agents: TaskWorkspaceAgent[] = [];
  const agentIds = new Set<string>();
  for (const candidate of value.agents) {
    if (
      !presentationRecord(candidate) ||
      !hasExactPresentationKeys(candidate, ["id", "name", "status"]) ||
      !agentIdSchema.safeParse(candidate.id).success ||
      typeof candidate.name !== "string" ||
      candidate.name.length < 1 ||
      candidate.name.length > 160 ||
      (candidate.status !== "active" && candidate.status !== "disabled") ||
      agentIds.has(candidate.id as string)
    ) {
      return null;
    }
    agentIds.add(candidate.id as string);
    agents.push(Object.freeze({
      id: candidate.id as string,
      name: candidate.name,
      status: candidate.status,
    }));
  }

  const repositories: Array<Readonly<{
    id: string;
    name: string;
    ready: boolean;
  }>> = [];
  const repositoryIds = new Set<string>();
  for (const candidate of value.runner.repositories) {
    if (
      !presentationRecord(candidate) ||
      !hasExactPresentationKeys(candidate, ["id", "name", "ready"]) ||
      !repositoryIdSchema.safeParse(candidate.id).success ||
      !repositoryNameSchema.safeParse(candidate.name).success ||
      typeof candidate.ready !== "boolean" ||
      repositoryIds.has(candidate.id as string)
    ) {
      return null;
    }
    repositoryIds.add(candidate.id as string);
    repositories.push(Object.freeze({
      id: candidate.id as string,
      name: candidate.name as string,
      ready: candidate.ready,
    }));
  }

  const counts = taskWorkspaceCountsSchema.safeParse(value.counts);
  const now = epochMsSchema.safeParse(value.now);
  const presence = runnerPresenceViewSchema.safeParse(value.runner.presence);
  const viewer = taskWorkspaceViewerSchema.safeParse(value.viewer);
  const workspaceId = workspacePublicIdSchema.safeParse(value.workspace.id);
  const workspaceName = workspaceNameSchema.safeParse(value.workspace.name);
  const workspaceSlug = workspaceSlugSchema.safeParse(value.workspace.slug);
  if (
    !counts.success ||
    !now.success ||
    !presence.success ||
    presence.data.serverTime !== now.data ||
    !viewer.success ||
    !workspaceId.success ||
    !workspaceName.success ||
    !workspaceSlug.success ||
    typeof value.workspace.keyPrefix !== "string" ||
    !/^[A-Z][A-Z0-9]{1,7}$/u.test(value.workspace.keyPrefix)
  ) {
    return null;
  }

  const capabilities = Object.freeze(Object.fromEntries(
    TASK_WORKSPACE_CAPABILITY_KEYS.map((key) => [
      key,
      rawCapabilities[key],
    ]),
  )) as TaskWorkspaceCapabilities;
  const frozenCounts = Object.freeze(Object.fromEntries(
    taskWorkspaceViewValues.map((view) => [
      view,
      Object.freeze({ ...counts.data[view] }),
    ]),
  )) as TaskWorkspaceCounts;
  return Object.freeze({
    agents: Object.freeze(agents),
    capabilities,
    counts: frozenCounts,
    now: now.data,
    runner: Object.freeze({
      presence: Object.freeze({ ...presence.data }),
      repositories: Object.freeze(repositories),
    }),
    viewer: Object.freeze({ ...viewer.data }),
    workspace: Object.freeze({
      id: workspaceId.data,
      keyPrefix: value.workspace.keyPrefix,
      name: workspaceName.data,
      slug: workspaceSlug.data,
    }),
  });
}

function bundleMatchesCoordinate(
  bundle: TaskWorkspaceProjectionBundle,
  coordinate: TaskWorkspaceCoordinate,
): boolean {
  return bundle.workspaceId === coordinate.workspaceId &&
    bundle.view === coordinate.view &&
    bundle.assignedAgentId === coordinate.assignedAgentId &&
    bundle.selectedTaskId === coordinate.selectedTaskId;
}

function parseEnvelope(
  envelope: unknown,
  request: TaskWorkspaceProjectionRequest,
): TaskWorkspaceSourceResult<TaskWorkspaceProjectionEnvelope> {
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    !("projection" in envelope) ||
    !("presentation" in envelope) ||
    !("presentationRevision" in envelope) ||
    !("consistency" in envelope)
  ) {
    return { error: publicError("INVALID_PROJECTION"), ok: false };
  }
  const parsed = taskWorkspaceProjectionBundleSchema.safeParse(envelope.projection);
  const presentation = parseTaskWorkspacePresentation(envelope.presentation);
  if (
    !parsed.success ||
    presentation === null ||
    !validPositiveRevision(envelope.presentationRevision) ||
    !validConsistency(envelope.consistency, request.sourceGeneration) ||
    !bundleMatchesCoordinate(parsed.data, request.coordinate) ||
    presentation.workspace.id !== parsed.data.workspaceId ||
    (
      request.minimumRevision !== null &&
      parsed.data.projectionRevision < request.minimumRevision
    )
  ) {
    return { error: publicError("INVALID_PROJECTION"), ok: false };
  }
  return {
    ok: true,
    value: {
      consistency: envelope.consistency.kind === "atomic"
        ? Object.freeze({
            kind: "atomic" as const,
            sourceGeneration: envelope.consistency.sourceGeneration,
          })
        : Object.freeze({
            attempts: envelope.consistency.attempts,
            kind: "revision_joined" as const,
            sourceGeneration: envelope.consistency.sourceGeneration,
          }),
      presentation,
      presentationRevision: envelope.presentationRevision,
      projection: parsed.data,
    },
  };
}

function parseContinuationPage(
  page: TaskListPage,
  request: TaskWorkspaceContinuationRequest,
): TaskWorkspaceSourceResult<TaskListPage> {
  const parsed = taskListPageSchema.safeParse(page);
  if (
    !parsed.success ||
    parsed.data.workspaceId !== request.coordinate.workspaceId ||
    parsed.data.view !== request.coordinate.view ||
    parsed.data.assignedAgentId !== request.coordinate.assignedAgentId ||
    parsed.data.projectionRevision !== request.projectionRevision ||
    parsed.data.cursor === request.cursor
  ) {
    return { error: publicError("INVALID_CONTINUATION"), ok: false };
  }
  return { ok: true, value: parsed.data };
}

function mutationIntent(
  intent: TaskWorkspaceClientIntent,
): intent is TaskWorkspaceClientMutationIntent {
  return intent.kind !== "view.select" &&
    intent.kind !== "task.select" &&
    intent.kind !== "page.load_more";
}

function mutationResultMatchesIntent(
  intent: TaskWorkspaceClientMutationIntent,
  result: TaskWorkspaceMutationResult,
): boolean {
  if (result.commandKind === intent.kind) return true;
  return intent.kind === "task.create" &&
    intent.repositoryId !== undefined &&
    result.commandKind === "task.create_and_run";
}

function accepted(): TaskWorkspaceDispatchResult {
  return { ok: true, outcome: "accepted" };
}

function failed(error: TaskWorkspaceError): TaskWorkspaceDispatchResult {
  return { error, ok: false };
}

function isCancelledRead(error: unknown): boolean {
  return error instanceof CancelledReadError && error.marker === CANCELLED_READ;
}

function effectTimeoutMs(value: number | undefined): number {
  const resolved = value ?? TASK_WORKSPACE_EFFECT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > 2_147_483_647
  ) {
    throw new RangeError(
      "Task workspace effectTimeoutMs must be a positive 32-bit timer interval.",
    );
  }
  return resolved;
}

/**
 * Creates one provider-free task client. The client owns every asynchronous
 * projection fence, while the source owns only validated effects.
 */
export function createTaskWorkspaceClient(
  options: CreateTaskWorkspaceClientOptions,
): TaskWorkspaceClient {
  const source = options.source;
  const clock = options.clock ?? SYSTEM_TASK_WORKSPACE_CLOCK;
  const timeoutMs = effectTimeoutMs(options.effectTimeoutMs);
  const subscriberCleanups = new Set<() => void>();
  let disposed = false;
  let lifecycle = 1;
  let sourceGeneration = 1;
  let coordinate = freezeCoordinate(options.coordinate);
  let targetRevision: number | null = null;
  let drainGeneration = 1;
  let continuationGeneration = 1;
  let mutationGeneration = 0;
  let clockGeneration = 0;
  let clockTimer: Readonly<{ generation: number; handle: unknown }> | null = null;
  let monotonicFloor: number | null = null;
  let clockCalibration: Readonly<{
    authorityNow: number;
    monotonicAt: number;
  }> | null = null;
  let activeMutation: SourceEffectBoundary<
    TaskWorkspaceSourceResult<TaskWorkspaceMutationResult>
  > | null = null;
  const activeDrainGenerations = new Set<number>();
  let started = false;
  let sourceSubscribed = false;
  let unsubscribeSource: () => void = () => undefined;
  let latestPresentation: Readonly<{
    presentation: TaskWorkspacePresentation;
    revision: number;
  }> | null = null;
  let snapshot: TaskWorkspaceSnapshot = Object.freeze({
    coordinate,
    dispatchError: null,
    now: null,
    pendingMutation: null,
    projection: {
      kind: "loading",
      minimumRevision: null,
    },
    sourceGeneration,
  } satisfies TaskWorkspaceSnapshot);
  const snapshotStore = createReducerStore<
    TaskWorkspaceSnapshot,
    (current: TaskWorkspaceSnapshot) => TaskWorkspaceSnapshot
  >(
    snapshot,
    (current, update) => {
      const next = update(current);
      return Object.is(next, current) ? current : Object.freeze(next);
    },
  );

  const replaceSnapshot = (
    update: (current: TaskWorkspaceSnapshot) => TaskWorkspaceSnapshot,
  ): void => {
    if (disposed) return;
    snapshot = snapshotStore.dispatch(update).snapshot;
  };

  const readMonotonicNow = (): number => {
    let candidate: number;
    try {
      candidate = clock.monotonicNow();
    } catch {
      candidate = monotonicFloor ?? 0;
    }
    if (!Number.isFinite(candidate)) candidate = monotonicFloor ?? 0;
    candidate = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, candidate));
    monotonicFloor = monotonicFloor === null
      ? candidate
      : Math.max(monotonicFloor, candidate);
    return monotonicFloor;
  };

  const sourceEffectRuntime: SourceEffectRuntime = Object.freeze({
    cancelTimeout: (handle: unknown) => clock.cancelTimeout(handle),
    monotonicNow: readMonotonicNow,
    scheduleTimeout: (callback: () => void, delayMs: number) =>
      clock.scheduleTimeout(callback, delayMs),
    timeoutMs,
  });
  const scheduler = new BoundedReadScheduler(
    TASK_WORKSPACE_MAX_READ_CONCURRENCY,
    sourceEffectRuntime,
  );
  const activeAcknowledgements = new Set<SourceEffectBoundary<void>>();

  const startAcknowledgement = (
    effect: (context: TaskWorkspaceEffectContext) => Promise<void>,
    onSettled: () => void = () => undefined,
  ): void => {
    const acknowledgement = new SourceEffectBoundary<void>(
      sourceEffectRuntime,
    );
    activeAcknowledgements.add(acknowledgement);
    acknowledgement.start(effect);
    void acknowledgement.promise
      .catch(() => undefined)
      .finally(() => {
        activeAcknowledgements.delete(acknowledgement);
        onSettled();
      });
  };

  const cancelAcknowledgements = (reason: string): void => {
    for (const acknowledgement of [...activeAcknowledgements]) {
      acknowledgement.cancel(new Error(reason));
    }
  };

  const supersedeContinuationReads = (): void => {
    continuationGeneration += 1;
    scheduler.cancelKind("continuation");
  };

  const supersedeAllReads = (): void => {
    continuationGeneration += 1;
    scheduler.cancelAll();
  };

  const calibratedNowAt = (monotonicNow: number): number | null => {
    if (clockCalibration === null) return null;
    const elapsed = Math.max(
      0,
      Math.floor(monotonicNow - clockCalibration.monotonicAt),
    );
    return Math.min(
      Number.MAX_SAFE_INTEGER,
      clockCalibration.authorityNow + elapsed,
    );
  };

  const calibrateAuthorityNow = (authorityNow: number): number => {
    const monotonicNow = readMonotonicNow();
    const current = calibratedNowAt(monotonicNow);
    const next = Math.max(authorityNow, current ?? snapshot.now ?? authorityNow);
    clockCalibration = Object.freeze({
      authorityNow: next,
      monotonicAt: monotonicNow,
    });
    return next;
  };

  const advanceClock = (): void => {
    const next = calibratedNowAt(readMonotonicNow());
    if (next === null) return;
    replaceSnapshot((current) =>
      current.now !== null && current.now >= next
        ? current
        : { ...current, now: next }
    );
  };

  const startClock = (): void => {
    clockGeneration += 1;
    const ownedGeneration = clockGeneration;
    const ownedLifecycle = lifecycle;
    try {
      const handle = clock.scheduleInterval(() => {
        if (
          disposed ||
          !started ||
          lifecycle !== ownedLifecycle ||
          clockGeneration !== ownedGeneration
        ) {
          return;
        }
        advanceClock();
      }, TASK_WORKSPACE_CLOCK_INTERVAL_MS);
      clockTimer = Object.freeze({ generation: ownedGeneration, handle });
    } catch {
      clockTimer = null;
    }
  };

  const stopClock = (): void => {
    clockGeneration += 1;
    const timer = clockTimer;
    clockTimer = null;
    if (timer === null) return;
    try {
      clock.cancelInterval(timer.handle);
    } catch {
      // Lifecycle fencing still makes a faulty timer cleanup inert.
    }
  };

  const currentDrain = (generation: number): boolean =>
    !disposed && generation === drainGeneration;

  const minimumForNextRead = (): number | null => maximumRevision(
    targetRevision,
    projectionRevision(snapshot.projection),
  );

  const refreshProjectionState = (
    projection: TaskWorkspaceProjectionState,
    minimumRevision: number | null,
    continuationSafe = false,
  ): TaskWorkspaceProjectionState => {
    if (projection.kind !== "ready") {
      return { kind: "loading", minimumRevision };
    }
    if (minimumRevision === null) return projection;
    return continuationSafe
      ? {
          ...projection,
          refresh: { continuationSafe: true, kind: "refreshing", minimumRevision },
        }
      : {
          ...projection,
          continuation: continuationForPage(
            projection.envelope.projection.firstPage,
          ),
          pages: Object.freeze([projection.envelope.projection.firstPage]),
          refresh: { continuationSafe: false, kind: "refreshing", minimumRevision },
        };
  };

  const failProjection = (
    error: TaskWorkspaceError,
    minimumRevision: number | null,
  ): void => {
    replaceSnapshot((current) => {
      if (current.projection.kind !== "ready") {
        return {
          ...current,
          projection: { error, kind: "error", minimumRevision },
        };
      }
      const retainedMinimum = minimumRevision ??
        current.projection.envelope.projection.projectionRevision;
      const continuationSafe = current.projection.refresh.kind !== "idle" &&
        current.projection.refresh.continuationSafe;
      return {
        ...current,
        projection: {
          ...current.projection,
          refresh: {
            continuationSafe,
            error,
            kind: "error",
            minimumRevision: retainedMinimum,
          },
        },
      };
    });
  };

  const installProjection = (
    envelope: TaskWorkspaceProjectionEnvelope,
  ): void => {
    const revision = envelope.projection.projectionRevision;
    const installedEnvelope = latestPresentation !== null &&
        latestPresentation.revision >= envelope.presentationRevision
      ? Object.freeze({
          ...envelope,
          presentation: latestPresentation.presentation,
          presentationRevision: latestPresentation.revision,
        })
      : envelope;
    if (
      latestPresentation === null ||
      envelope.presentationRevision > latestPresentation.revision
    ) {
      latestPresentation = Object.freeze({
        presentation: envelope.presentation,
        revision: envelope.presentationRevision,
      });
    }
    const calibratedNow = calibrateAuthorityNow(installedEnvelope.presentation.now);
    const mustContinue = targetRevision !== null && targetRevision > revision;
    if (!mustContinue) targetRevision = null;
    const previous = snapshot.projection.kind === "ready"
      ? snapshot.projection
      : null;
    const sameContinuation = previous !== null &&
      previous.envelope.projection.continuationRevision ===
        installedEnvelope.projection.continuationRevision;
    const preservePages = sameContinuation && sameFirstPageStructure(
      previous.envelope.projection.firstPage,
      installedEnvelope.projection.firstPage,
    );
    if (!preservePages) supersedeContinuationReads();
    replaceSnapshot((current) => {
      const pendingMutation = current.pendingMutation?.phase === "synchronizing" &&
          current.pendingMutation.result.projectionRevision <= revision
        ? null
        : current.pendingMutation;
      const pages = preservePages
        ? Object.freeze([
            installedEnvelope.projection.firstPage,
            ...previous.pages.slice(1),
          ])
        : Object.freeze([installedEnvelope.projection.firstPage]);
      return {
        ...current,
        dispatchError: current.dispatchError,
        now: Math.max(current.now ?? calibratedNow, calibratedNow),
        pendingMutation,
        projection: {
          continuation: preservePages
            ? previous.continuation
            : continuationForPage(installedEnvelope.projection.firstPage),
          envelope: installedEnvelope,
          kind: "ready",
          pages,
          refresh: mustContinue && targetRevision !== null
            ? {
                continuationSafe: preservePages,
                kind: "refreshing",
                minimumRevision: targetRevision,
              }
            : { kind: "idle" },
        },
      };
    });
  };

  const ensureProjectionDrain = (): void => {
    if (disposed) return;
    const generation = drainGeneration;
    if (activeDrainGenerations.has(generation)) return;
    activeDrainGenerations.add(generation);
    const ownedLifecycle = lifecycle;

    void (async () => {
      while (currentDrain(generation) && lifecycle === ownedLifecycle) {
        const request: TaskWorkspaceProjectionRequest = {
          coordinate,
          minimumRevision: minimumForNextRead(),
          sourceGeneration,
        };
        let sourceResult: TaskWorkspaceSourceResult<TaskWorkspaceProjectionEnvelope>;
        try {
          sourceResult = await scheduler.run("projection", async (context) => {
            if (!currentDrain(generation) || lifecycle !== ownedLifecycle) {
              throw new CancelledReadError();
            }
            return settleSourceEffect(() =>
              source.readProjection(request, context)
            );
          });
        } catch (error) {
          if (isCancelledRead(error)) return;
          sourceResult = serviceUnavailable();
        }
        if (!currentDrain(generation) || lifecycle !== ownedLifecycle) return;
        if (!sourceResult.ok) {
          failProjection(sourceResult.error, targetRevision ?? request.minimumRevision);
          return;
        }
        const parsed = parseEnvelope(sourceResult.value, request);
        if (!parsed.ok) {
          failProjection(parsed.error, targetRevision ?? request.minimumRevision);
          return;
        }
        installProjection(parsed.value);
        startAcknowledgement((context) =>
          source.acknowledgeProjection(parsed.value, context));
        if (targetRevision === null) return;
      }
    })().finally(() => {
      activeDrainGenerations.delete(generation);
    });
  };

  const retryProjection = (): void => {
    const continuationSafe = snapshot.projection.kind === "ready" &&
      snapshot.projection.refresh.kind !== "idle" &&
      snapshot.projection.refresh.continuationSafe;
    const retainedFloor = maximumRevision(
      targetRevision,
      projectionMinimumRevision(snapshot.projection),
    );
    targetRevision = maximumRevision(
      retainedFloor,
      projectionRevision(snapshot.projection),
    );
    drainGeneration += 1;
    supersedeAllReads();
    replaceSnapshot((current) => ({
      ...current,
      dispatchError: current.pendingMutation?.phase === "outcome_unknown"
        ? current.dispatchError
        : null,
      projection: refreshProjectionState(
        current.projection,
        targetRevision,
        continuationSafe,
      ),
    }));
    ensureProjectionDrain();
  };

  const selectCoordinate = (next: TaskWorkspaceCoordinate): void => {
    const frozen = freezeCoordinate(next);
    if (sameCoordinate(frozen, coordinate)) {
      if (
        snapshot.projection.kind === "error" ||
        (
          snapshot.projection.kind === "ready" &&
          snapshot.projection.refresh.kind === "error"
        )
      ) {
        retryProjection();
      }
      return;
    }

    const sameView = frozen.view === coordinate.view &&
      frozen.assignedAgentId === coordinate.assignedAgentId;
    const carriedRevision = sameView
      ? maximumRevision(
          targetRevision,
          projectionRevision(snapshot.projection),
        )
      : null;
    coordinate = frozen;
    targetRevision = carriedRevision;
    drainGeneration += 1;
    supersedeAllReads();
    replaceSnapshot((current) => ({
      ...current,
      coordinate,
      dispatchError: current.pendingMutation?.phase === "outcome_unknown"
        ? current.dispatchError
        : null,
      projection: {
        kind: "loading",
        minimumRevision: carriedRevision,
      },
    }));
    ensureProjectionDrain();
  };

  const invalidate = (
    minimumRevision: number,
    continuationRevision?: number,
  ): void => {
    const installedRevision = projectionRevision(snapshot.projection);
    const continuationSafe = snapshot.projection.kind === "ready" &&
      continuationRevision !== undefined &&
      continuationRevision ===
        snapshot.projection.envelope.projection.continuationRevision;
    if (
      targetRevision === null &&
      installedRevision !== null &&
      minimumRevision <= installedRevision
    ) {
      return;
    }
    if (targetRevision !== null && minimumRevision <= targetRevision) {
      const refreshErrored = snapshot.projection.kind === "error" ||
        (
          snapshot.projection.kind === "ready" &&
          snapshot.projection.refresh.kind === "error"
        );
      if (minimumRevision === targetRevision && refreshErrored) retryProjection();
      return;
    }
    targetRevision = maximumRevision(targetRevision, minimumRevision);
    if (!continuationSafe) supersedeContinuationReads();
    replaceSnapshot((current) => ({
      ...current,
      projection: refreshProjectionState(
        current.projection,
        targetRevision,
        continuationSafe,
      ),
    }));
    ensureProjectionDrain();
  };

  const replaceSourceGeneration = (minimumRevision: number | null): void => {
    const installedRevision = projectionRevision(snapshot.projection);
    const committedMutationRevision =
      snapshot.pendingMutation?.phase === "acknowledging" ||
        snapshot.pendingMutation?.phase === "synchronizing"
        ? snapshot.pendingMutation.result.projectionRevision
        : null;
    targetRevision = maximumRevision(
      maximumRevision(
        maximumRevision(targetRevision, installedRevision),
        minimumRevision,
      ),
      committedMutationRevision,
    );
    sourceGeneration += 1;
    drainGeneration += 1;
    supersedeAllReads();
    activeMutation?.cancel(new Error("Task workspace source was replaced."));
    cancelAcknowledgements("Task workspace source was replaced.");
    replaceSnapshot((current) => ({
      ...current,
      dispatchError: current.pendingMutation?.phase === "dispatching"
        ? publicError("MUTATION_OUTCOME_UNKNOWN")
        : current.dispatchError,
      pendingMutation: current.pendingMutation?.phase === "dispatching"
        ? {
            basis: current.pendingMutation.basis,
            intent: current.pendingMutation.intent,
            phase: "outcome_unknown" as const,
          }
        : current.pendingMutation?.phase === "acknowledging"
        ? {
            basis: current.pendingMutation.basis,
            intent: current.pendingMutation.intent,
            phase: "synchronizing" as const,
            result: current.pendingMutation.result,
          }
        : current.pendingMutation,
      projection: { kind: "loading", minimumRevision: targetRevision },
      sourceGeneration,
    }));
    ensureProjectionDrain();
  };

  const applyProjectionPatch = (
    event: Extract<TaskWorkspaceSourceEvent, { kind: "projection.patched" }>,
  ): void => {
    const projection = snapshot.projection;
    if (
      projection.kind !== "ready" ||
      projection.refresh.kind !== "idle" ||
      event.view !== coordinate.view ||
      event.assignedAgentId !== coordinate.assignedAgentId ||
      event.continuationRevision !==
        projection.envelope.projection.continuationRevision ||
      event.projectionRevision <=
        projection.envelope.projection.projectionRevision
    ) {
      return;
    }
    const parsedPatches = new Map<TaskPublicId, TaskWorkspaceListItem>();
    for (const patch of event.patches) {
      if (
        patch === null ||
        typeof patch !== "object" ||
        Array.isArray(patch) ||
        Object.keys(patch).length !== 2 ||
        !("item" in patch) ||
        !("taskId" in patch)
      ) {
        return;
      }
      const parsedItem = taskWorkspaceListItemSchema.safeParse(patch.item);
      if (
        !parsedItem.success ||
        parsedItem.data.task.id !== patch.taskId ||
        parsedItem.data.task.id ===
          projection.envelope.projection.selectedTaskId ||
        parsedPatches.has(parsedItem.data.task.id)
      ) {
        return;
      }
      parsedPatches.set(parsedItem.data.task.id, parsedItem.data);
    }
    for (const taskId of parsedPatches.keys()) {
      const occurrenceCount = projection.pages.reduce(
        (count, page) => count + page.items.filter(
          ({ task }) => task.id === taskId,
        ).length,
        0,
      );
      if (occurrenceCount !== 1) return;
    }
    const pages: TaskListPage[] = projection.pages.map((page) => {
      const items = page.items.map((item) =>
        parsedPatches.get(item.task.id) ?? item
      );
      Object.freeze(items);
      return Object.freeze({
        ...page,
        items,
        projectionRevision: event.projectionRevision,
      });
    });
    const detail = projection.envelope.projection.detail;
    const nextProjection = taskWorkspaceProjectionBundleSchema.safeParse({
      ...projection.envelope.projection,
      detail: detail === null
        ? null
        : { ...detail, projectionRevision: event.projectionRevision },
      firstPage: pages[0],
      projectionRevision: event.projectionRevision,
    });
    if (!nextProjection.success || pages[0] === undefined) return;
    let patched = false;
    replaceSnapshot((current) => {
      if (
        current.projection.kind !== "ready" ||
        current.projection.envelope.projection.projectionRevision >=
          event.projectionRevision ||
        current.projection.envelope.projection.continuationRevision !==
          event.continuationRevision
      ) {
        return current;
      }
      patched = true;
      return {
        ...current,
        projection: {
          ...current.projection,
          envelope: {
            ...current.projection.envelope,
            projection: nextProjection.data,
          },
          pages: Object.freeze(pages),
        },
      };
    });
    if (patched) supersedeContinuationReads();
  };

  const applyPresentationUpdate = (
    event: Extract<TaskWorkspaceSourceEvent, { kind: "presentation.updated" }>,
  ): void => {
    if (
      snapshot.projection.kind !== "ready" ||
      !validPositiveRevision(event.presentationRevision) ||
      (
        latestPresentation !== null &&
        event.presentationRevision <= latestPresentation.revision
      )
    ) {
      return;
    }
    const presentation = parseTaskWorkspacePresentation(event.presentation);
    if (presentation === null || presentation.workspace.id !== coordinate.workspaceId) {
      return;
    }
    latestPresentation = Object.freeze({
      presentation,
      revision: event.presentationRevision,
    });
    const calibratedNow = calibrateAuthorityNow(presentation.now);
    replaceSnapshot((current) => current.projection.kind !== "ready"
      ? current
      : {
          ...current,
          now: Math.max(current.now ?? calibratedNow, calibratedNow),
          projection: {
            ...current.projection,
            envelope: Object.freeze({
              ...current.projection.envelope,
              presentation,
              presentationRevision: event.presentationRevision,
            }),
          },
        });
  };

  const receiveSourceEvent = (event: TaskWorkspaceSourceEvent): void => {
    if (
      disposed ||
      event === null ||
      typeof event !== "object" ||
      !("workspaceId" in event) ||
      !("kind" in event) ||
      !("sourceGeneration" in event) ||
      !validPositiveRevision(event.sourceGeneration) ||
      event.sourceGeneration !== sourceGeneration ||
      event.workspaceId !== coordinate.workspaceId
    ) {
      return;
    }
    if (event.kind === "presentation.updated") {
      applyPresentationUpdate(event);
      return;
    }
    if (event.kind === "projection.patched") {
      if (!validProjectionPatchEvent(event, coordinate)) return;
      applyProjectionPatch(event);
      return;
    }
    if (event.kind === "projection.invalidated") {
      if (
        !validPositiveRevision(event.minimumRevision) ||
        (
          event.continuationRevision !== undefined &&
          !validPositiveRevision(event.continuationRevision)
        ) ||
        !Array.isArray(event.views) ||
        event.views.length < 1 ||
        event.views.length > taskWorkspaceViewValues.length ||
        !event.views.every(validTaskWorkspaceView) ||
        new Set(event.views).size !== event.views.length ||
        !event.views.includes(coordinate.view)
      ) {
        return;
      }
      invalidate(event.minimumRevision, event.continuationRevision);
      return;
    }
    if (event.kind === "source.replaced") {
      if (
        event.minimumRevision !== undefined &&
        !validPositiveRevision(event.minimumRevision)
      ) {
        return;
      }
      replaceSourceGeneration(event.minimumRevision ?? null);
    }
  };

  const loadMore = async (): Promise<TaskWorkspaceDispatchResult> => {
    if (disposed) return failed(publicError("CLIENT_DISPOSED"));
    const projection = snapshot.projection;
    if (
      projection.kind !== "ready" ||
      (
        projection.refresh.kind !== "idle" &&
        !projection.refresh.continuationSafe
      ) ||
      projection.continuation.kind === "complete"
    ) {
      return failed(publicError("CONTINUATION_UNAVAILABLE"));
    }
    if (projection.continuation.kind === "loading") {
      return failed(publicError("CONTINUATION_PENDING"));
    }
    if (projection.pages.length >= TASK_WORKSPACE_MAX_LOADED_PAGES) {
      return failed(publicError("PAGE_LIMIT_REACHED"));
    }

    const cursor = projection.continuation.cursor;
    const ownedContinuation = continuationGeneration;
    const ownedLifecycle = lifecycle;
    const request: TaskWorkspaceContinuationRequest = {
      coordinate,
      continuationRevision: projection.envelope.projection.continuationRevision,
      cursor,
      projectionRevision: projection.envelope.projection.projectionRevision,
      sourceGeneration,
    };
    replaceSnapshot((current) => current.projection.kind !== "ready"
      ? current
      : {
          ...current,
          projection: {
            ...current.projection,
            continuation: { cursor, kind: "loading" },
          },
        });

    let sourceResult: TaskWorkspaceSourceResult<TaskListPage>;
    try {
      sourceResult = await scheduler.run("continuation", async (context) => {
        if (
          disposed ||
          ownedContinuation !== continuationGeneration ||
          ownedLifecycle !== lifecycle
        ) {
          throw new CancelledReadError();
        }
        return settleSourceEffect(() =>
          source.readContinuation(request, context)
        );
      });
    } catch (error) {
      if (isCancelledRead(error)) {
        replaceSnapshot((current) => {
          if (
            current.projection.kind !== "ready" ||
            current.projection.continuation.kind !== "loading" ||
            current.projection.continuation.cursor !== cursor
          ) {
            return current;
          }
          const lastPage = current.projection.pages.at(-1);
          return lastPage === undefined
            ? current
            : {
                ...current,
                projection: {
                  ...current.projection,
                  continuation: continuationForPage(lastPage),
                },
              };
        });
        return failed(publicError("REQUEST_SUPERSEDED"));
      }
      sourceResult = serviceUnavailable();
    }
    if (
      disposed ||
      ownedContinuation !== continuationGeneration ||
      ownedLifecycle !== lifecycle ||
      !sameCoordinate(request.coordinate, coordinate)
    ) {
      return failed(publicError("REQUEST_SUPERSEDED"));
    }
    if (!sourceResult.ok) {
      if (sourceResult.error.code === "TASK_STATE_CONFLICT") {
        replaceSourceGeneration(request.projectionRevision);
        return failed(sourceResult.error);
      }
      replaceSnapshot((current) => current.projection.kind !== "ready"
        ? current
        : {
            ...current,
            projection: {
              ...current.projection,
              continuation: {
                cursor,
                error: sourceResult.error,
                kind: "error",
              },
            },
          });
      return failed(sourceResult.error);
    }
    const parsed = parseContinuationPage(sourceResult.value, request);
    if (!parsed.ok) {
      replaceSnapshot((current) => current.projection.kind !== "ready"
        ? current
        : {
            ...current,
            projection: {
              ...current.projection,
              continuation: {
                cursor,
                error: parsed.error,
                kind: "error",
              },
            },
          });
      return failed(parsed.error);
    }
    const currentProjection = snapshot.projection;
    if (
      parsed.value.cursor !== null &&
      currentProjection.kind === "ready" &&
      currentProjection.pages.some(({ cursor: seenCursor }) =>
        seenCursor === parsed.value.cursor)
    ) {
      const error = publicError("INVALID_CONTINUATION");
      replaceSnapshot((current) => current.projection.kind !== "ready"
        ? current
        : {
            ...current,
            projection: {
              ...current.projection,
              continuation: { cursor, error, kind: "error" },
            },
          });
      return failed(error);
    }

    let appended = false;
    replaceSnapshot((current) => {
      if (
        current.projection.kind !== "ready" ||
        current.projection.envelope.projection.continuationRevision !==
          request.continuationRevision ||
        current.projection.envelope.projection.projectionRevision !==
          request.projectionRevision
      ) {
        if (
          current.projection.kind !== "ready" ||
          current.projection.continuation.kind !== "loading" ||
          current.projection.continuation.cursor !== cursor
        ) {
          return current;
        }
        const lastPage = current.projection.pages.at(-1);
        return lastPage === undefined
          ? current
          : {
              ...current,
              projection: {
                ...current.projection,
                continuation: continuationForPage(lastPage),
              },
            };
      }
      const seenTaskIds = new Set(
        current.projection.pages.flatMap((page) =>
          page.items.map(({ task }) => task.id)
        ),
      );
      const items = parsed.value.items.filter(({ task }) => {
        if (seenTaskIds.has(task.id)) return false;
        seenTaskIds.add(task.id);
        return true;
      });
      Object.freeze(items);
      const page = Object.freeze({
        ...parsed.value,
        items,
      });
      appended = true;
      return {
        ...current,
        projection: {
          ...current.projection,
          continuation: continuationForPage(page),
          pages: Object.freeze([...current.projection.pages, page]),
        },
      };
    });
    return appended
      ? accepted()
      : failed(publicError("REQUEST_SUPERSEDED"));
  };

  const executeMutation = async (
    intent: TaskWorkspaceClientMutationIntent,
  ): Promise<TaskWorkspaceDispatchResult> => {
    if (disposed) return failed(publicError("CLIENT_DISPOSED"));
    const projection = snapshot.projection;
    if (
      snapshot.pendingMutation !== null ||
      projection.kind !== "ready" ||
      projection.refresh.kind !== "idle" ||
      targetRevision !== null
    ) {
      return failed(publicError("MUTATION_FENCED"));
    }

    const detail = projection.envelope.projection.detail;
    if (
      "expectedTaskRevision" in intent &&
      "taskId" in intent &&
      detail?.task.id === intent.taskId &&
      detail.task.revision !== intent.expectedTaskRevision
    ) {
      return failed(publicError("TASK_STATE_CONFLICT"));
    }
    if (
      "expectedReviewRevision" in intent &&
      "taskId" in intent &&
      detail?.task.id === intent.taskId &&
      detail.task.reviewRevision !== intent.expectedReviewRevision
    ) {
      return failed(publicError("TASK_STATE_CONFLICT"));
    }
    if (intent.kind === "interaction.respond") {
      const run = detail?.runs.find(({ id }) => id === intent.runId);
      const interaction = run?.interactions.find(
        ({ request }) => request.id === intent.interactionId,
      );
      if (interaction === undefined || interaction.state !== "pending") {
        return failed(publicError("INTERACTION_NOT_PENDING"));
      }
      const validation = validatePortableRunInteractionResponse(
        interaction.request,
        intent.response,
      );
      if (!validation.success) {
        return failed(publicError("INVALID_INTERACTION_RESPONSE"));
      }
    }

    mutationGeneration += 1;
    const ownedMutation = mutationGeneration;
    const ownedLifecycle = lifecycle;
    const request: TaskWorkspaceMutationRequest = {
      basis: {
        coordinate,
        projectionRevision: projection.envelope.projection.projectionRevision,
        sourceGeneration,
      },
      intent,
    };
    replaceSnapshot((current) => ({
      ...current,
      dispatchError: null,
      pendingMutation: {
        basis: request.basis,
        intent,
        phase: "dispatching",
      },
    }));

    let sourceResult: TaskWorkspaceSourceResult<TaskWorkspaceMutationResult>;
    let mutationEffect: SourceEffectBoundary<
      TaskWorkspaceSourceResult<TaskWorkspaceMutationResult>
    > | null = null;
    try {
      mutationEffect = new SourceEffectBoundary(sourceEffectRuntime);
      activeMutation = mutationEffect;
      mutationEffect.start((context) => source.execute(request, context));
      sourceResult = normalizeSourceResult<TaskWorkspaceMutationResult>(
        await mutationEffect.promise,
      );
    } catch {
      sourceResult = mutationEffect?.invoked === true
        ? mutationOutcomeUnknown()
        : serviceUnavailable();
    } finally {
      if (activeMutation === mutationEffect) activeMutation = null;
    }
    if (!sourceResult.ok) {
      if (
        !disposed &&
        ownedLifecycle === lifecycle &&
        ownedMutation === mutationGeneration &&
        request.basis.sourceGeneration === sourceGeneration
      ) {
        const unknown = sourceResult.error.code === "MUTATION_OUTCOME_UNKNOWN";
        replaceSnapshot((current) => ({
          ...current,
          dispatchError: sourceResult.error,
          pendingMutation: unknown
            ? {
                basis: request.basis,
                intent,
                phase: "outcome_unknown" as const,
              }
            : null,
        }));
      }
      return failed(sourceResult.error);
    }

    const parsed = taskWorkspaceMutationResultSchema.safeParse(sourceResult.value);
    if (
      !parsed.success ||
      parsed.data.workspaceId !== request.basis.coordinate.workspaceId ||
      parsed.data.projectionRevision < request.basis.projectionRevision ||
      !mutationResultMatchesIntent(intent, parsed.data)
    ) {
      const error = publicError("MUTATION_OUTCOME_UNKNOWN");
      if (
        !disposed &&
        ownedLifecycle === lifecycle &&
        ownedMutation === mutationGeneration &&
        request.basis.sourceGeneration === sourceGeneration
      ) {
        replaceSnapshot((current) => ({
          ...current,
          dispatchError: error,
          pendingMutation: {
            basis: request.basis,
            intent,
            phase: "outcome_unknown" as const,
          },
        }));
      }
      return failed(error);
    }

    let acceptedByModel = false;
    if (
      !disposed &&
      ownedLifecycle === lifecycle &&
      ownedMutation === mutationGeneration &&
      request.basis.sourceGeneration === sourceGeneration
    ) {
      acceptedByModel = true;
      const installedRevision = projectionRevision(snapshot.projection);
      const synchronizationRequired =
        installedRevision === null ||
        installedRevision < parsed.data.projectionRevision;
      if (synchronizationRequired) {
        targetRevision = maximumRevision(
          targetRevision,
          parsed.data.projectionRevision,
        );
        supersedeContinuationReads();
      }
      replaceSnapshot((current) => ({
        ...current,
        dispatchError: null,
        pendingMutation: {
          basis: request.basis,
          intent,
          phase: "acknowledging",
          result: parsed.data,
        },
        ...(synchronizationRequired
          ? {
              projection: refreshProjectionState(
                current.projection,
                targetRevision,
              ),
            }
          : {}),
      }));
      if (synchronizationRequired) ensureProjectionDrain();
    }
    if (acceptedByModel) {
      startAcknowledgement(
        (context) => source.acknowledgeMutation(parsed.data, context),
        () => {
          if (
            disposed ||
            ownedLifecycle !== lifecycle ||
            ownedMutation !== mutationGeneration ||
            request.basis.sourceGeneration !== sourceGeneration
          ) {
            return;
          }
          const installedRevision = projectionRevision(snapshot.projection);
          replaceSnapshot((current) => {
            if (
              current.pendingMutation?.phase !== "acknowledging" ||
              current.pendingMutation.result.operationId !==
                parsed.data.operationId
            ) {
              return current;
            }
            return {
              ...current,
              pendingMutation:
                installedRevision !== null &&
                  installedRevision >= parsed.data.projectionRevision
                  ? null
                  : {
                      basis: request.basis,
                      intent,
                      phase: "synchronizing" as const,
                      result: parsed.data,
                    },
            };
          });
        },
      );
    }
    return { ok: true, outcome: "committed", result: parsed.data };
  };

  const dispatch = async (
    intent: TaskWorkspaceClientIntent,
  ): Promise<TaskWorkspaceDispatchResult> => {
    if (disposed) return failed(publicError("CLIENT_DISPOSED"));
    const parsedIntent = taskWorkspaceClientIntentSchema.safeParse(intent);
    if (!parsedIntent.success) return failed(publicError("INVALID_INTENT"));
    const validIntent = parsedIntent.data;
    if (validIntent.kind === "view.select") {
      selectCoordinate({
        ...(validIntent.assignedAgentId === undefined
          ? {}
          : { assignedAgentId: validIntent.assignedAgentId }),
        selectedTaskId: null,
        view: validIntent.view,
        workspaceId: coordinate.workspaceId,
      });
      return accepted();
    }
    if (validIntent.kind === "task.select") {
      selectCoordinate({
        ...(coordinate.assignedAgentId === undefined
          ? {}
          : { assignedAgentId: coordinate.assignedAgentId }),
        selectedTaskId: validIntent.taskId,
        view: coordinate.view,
        workspaceId: coordinate.workspaceId,
      });
      return accepted();
    }
    if (validIntent.kind === "page.load_more") return loadMore();
    if (!mutationIntent(validIntent)) {
      return failed(publicError("UNSUPPORTED_INTENT"));
    }
    return executeMutation(validIntent);
  };

  const subscribeToSource = (): boolean => {
    if (sourceSubscribed) return true;
    try {
      unsubscribeSource = source.subscribe(receiveSourceEvent);
      sourceSubscribed = true;
      return true;
    } catch {
      unsubscribeSource = () => undefined;
      return false;
    }
  };

  const start = (): void => {
    if (disposed || started) return;
    started = true;
    startClock();
    if (!subscribeToSource()) {
      failProjection(publicError("SUBSCRIPTION_UNAVAILABLE"), null);
      return;
    }
    ensureProjectionDrain();
  };

  const store: HraStore<TaskWorkspaceSnapshot> = Object.freeze({
    getSnapshot: snapshotStore.getSnapshot,
    subscribe: (listener: () => void) => {
      if (disposed) return () => undefined;
      const unsubscribe = snapshotStore.subscribe(listener);
      let subscribed = true;
      const cleanup = (): void => {
        if (!subscribed) return;
        subscribed = false;
        subscriberCleanups.delete(cleanup);
        unsubscribe();
      };
      subscriberCleanups.add(cleanup);
      return cleanup;
    },
  });

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    lifecycle += 1;
    drainGeneration += 1;
    supersedeAllReads();
    mutationGeneration += 1;
    stopClock();
    activeMutation?.cancel(new Error("Task workspace client was disposed."));
    cancelAcknowledgements("Task workspace client was disposed.");
    for (const cleanup of [...subscriberCleanups]) cleanup();
    try {
      unsubscribeSource();
    } catch {
      // Disposal remains idempotent even when a source cleanup is faulty.
    }
    unsubscribeSource = () => undefined;
    sourceSubscribed = false;
  };

  const retry = (): void => {
    if (disposed || !started) return;
    if (!subscribeToSource()) {
      failProjection(
        publicError("SUBSCRIPTION_UNAVAILABLE"),
        projectionMinimumRevision(snapshot.projection),
      );
      return;
    }
    retryProjection();
  };

  return Object.freeze({ dispatch, dispose, retry, start, store });
}

/**
 * Creates a stable React-facing facade for effect-owned clients.
 *
 * React Strict Mode can replay effect setup and cleanup without recreating
 * memoized values. The facade stays stable while each setup owns a fresh
 * source/client pair, so replay cannot resurrect a disposed client.
 */
export function createTaskWorkspaceClientHost(
  initialCoordinate: TaskWorkspaceCoordinate,
): TaskWorkspaceClientHost {
  const coordinate = freezeCoordinate(initialCoordinate);
  const listeners = new Set<() => void>();
  let installed: TaskWorkspaceClient | null = null;
  let unsubscribeInstalled: () => void = () => undefined;
  let installGeneration = 0;
  let snapshot: TaskWorkspaceSnapshot = Object.freeze({
    coordinate,
    dispatchError: null,
    now: null,
    pendingMutation: null,
    projection: { kind: "loading", minimumRevision: null },
    sourceGeneration: 1,
  } satisfies TaskWorkspaceSnapshot);

  const emit = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // One React consumer cannot interrupt the remaining consumers.
      }
    }
  };
  const replaceSnapshot = (next: TaskWorkspaceSnapshot): void => {
    if (Object.is(snapshot, next)) return;
    snapshot = next;
    emit();
  };
  const uninstallCurrent = (): void => {
    const previous = installed;
    installed = null;
    unsubscribeInstalled();
    unsubscribeInstalled = () => undefined;
    previous?.dispose();
    replaceSnapshot(Object.freeze({
      coordinate,
      dispatchError: null,
      now: null,
      pendingMutation: null,
      projection: { kind: "loading", minimumRevision: null },
      sourceGeneration: snapshot.sourceGeneration + 1,
    } satisfies TaskWorkspaceSnapshot));
  };

  const install = (client: TaskWorkspaceClient): (() => void) => {
    installGeneration += 1;
    const ownedGeneration = installGeneration;
    if (installed !== null) uninstallCurrent();
    installed = client;
    unsubscribeInstalled = client.store.subscribe(() => {
      if (
        installed === client &&
        ownedGeneration === installGeneration
      ) {
        replaceSnapshot(client.store.getSnapshot());
      }
    });
    client.start();
    replaceSnapshot(client.store.getSnapshot());
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (
        installed !== client ||
        ownedGeneration !== installGeneration
      ) {
        return;
      }
      installGeneration += 1;
      uninstallCurrent();
    };
  };

  const client: TaskWorkspaceClient = Object.freeze({
    dispatch: (intent) => installed === null
      ? Promise.resolve(failed(publicError("CLIENT_UNAVAILABLE")))
      : installed.dispatch(intent),
    dispose: () => {
      installGeneration += 1;
      if (installed !== null) uninstallCurrent();
    },
    retry: () => installed?.retry(),
    start: () => undefined,
    store: Object.freeze({
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        let subscribed = true;
        return () => {
          if (!subscribed) return;
          subscribed = false;
          listeners.delete(listener);
        };
      },
    }),
  });
  return Object.freeze({ client, install });
}
