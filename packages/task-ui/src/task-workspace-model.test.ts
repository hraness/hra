import { describe, expect, test } from "bun:test";
import type {
  TaskListPage,
  TaskPublicId,
  TaskWorkspaceClientIntent,
  TaskWorkspaceMutationResult,
  TaskWorkspaceProjectionBundle,
  TaskWorkspaceView,
  WorkspacePublicId,
} from "@hraness/agent-tasks-domain";

import {
  TASK_WORKSPACE_MAX_LOADED_PAGES,
  TASK_WORKSPACE_MAX_READ_CONCURRENCY,
  createTaskWorkspaceClient,
  createTaskWorkspaceClientHost,
  type TaskWorkspaceClock,
  type TaskWorkspaceContinuationRequest,
  type TaskWorkspaceEffectContext,
  type TaskWorkspaceMutationRequest,
  type TaskWorkspaceProjectionEnvelope,
  type TaskWorkspacePresentation,
  type TaskWorkspaceProjectionRequest,
  type TaskWorkspaceSource,
  type TaskWorkspaceSourceEvent,
  type TaskWorkspaceSourceResult,
} from "./task-workspace-model";

const workspaceId: WorkspacePublicId = "wsp_00000000000000000000000000";

function presentation(authorityNow = 1_000): TaskWorkspacePresentation {
  const count = { capped: false, value: 1 };
  return {
    agents: [],
    capabilities: {
      canAssign: true,
      canCancel: true,
      canComment: true,
      canCreate: true,
      canEdit: true,
      canManageGraph: true,
      canManageLabels: true,
      canManageReferences: true,
      canReopen: true,
      canReview: true,
    },
    counts: {
      all: count,
      ready: count,
      blocked: { capped: false, value: 0 },
      deferred: { capped: false, value: 0 },
      attention: { capped: false, value: 0 },
      assigned: { capped: false, value: 0 },
      review: { capped: false, value: 0 },
    },
    now: authorityNow,
    runner: {
      presence: { serverTime: authorityNow, state: "offline" },
      repositories: [],
    },
    viewer: { id: "install_test", kind: "local_owner", name: "Local owner" },
    workspace: {
      id: workspaceId,
      keyPrefix: "AT",
      name: "Agent tasks",
      slug: "agent-tasks",
    },
  };
}

function publicTaskId(index: number): TaskPublicId {
  return `tsk_${String(index).padStart(26, "0")}`;
}

function taskKey(index: number): string {
  return `AT-${String(index).padStart(7, "0")}`;
}

function listItem(index: number, revision: number, title = `Task ${String(index)}`) {
  return {
    humanInput: null,
    run: null,
    task: {
      availableAt: 1_000,
      cancelledBlockerCount: 0,
      createdAt: 1_000,
      id: publicTaskId(index),
      isReady: true,
      key: taskKey(index),
      priority: 2,
      reviewRevision: revision,
      revision,
      status: "open" as const,
      title,
      type: "task" as const,
      unresolvedBlockerCount: 0,
      updatedAt: 1_000 + revision,
    },
  };
}

function page(options: {
  cursor?: string | null;
  items?: readonly ReturnType<typeof listItem>[];
  revision: number;
  view?: TaskWorkspaceView;
}): TaskListPage {
  const cursor = options.cursor ?? null;
  return {
    cursor,
    hasMore: cursor !== null,
    items: [...(options.items ?? [listItem(1, options.revision)])],
    projectionRevision: options.revision,
    view: options.view ?? "all",
    workspaceId,
  };
}

function detail(taskIndex: number, revision: number) {
  return {
    blockers: [],
    children: [],
    comments: [],
    dependents: [],
    description: "",
    events: [],
    labels: [],
    parent: null,
    projectionRevision: revision,
    recoveries: [],
    references: [],
    runs: [],
    submission: null,
    task: listItem(taskIndex, revision).task,
    truncatedCollections: [],
    workspaceId,
  };
}

function bundle(options: {
  continuationRevision?: number;
  cursor?: string | null;
  revision: number;
  selectedTaskIndex?: number | null;
  title?: string;
  view?: TaskWorkspaceView;
}): TaskWorkspaceProjectionBundle {
  const selectedTaskIndex = options.selectedTaskIndex ?? null;
  const firstItem = listItem(1, options.revision, options.title);
  return {
    continuationRevision: options.continuationRevision ?? options.revision,
    detail: selectedTaskIndex === null
      ? null
      : detail(selectedTaskIndex, options.revision),
    firstPage: page({
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      items: [firstItem],
      revision: options.revision,
      ...(options.view === undefined ? {} : { view: options.view }),
    }),
    projectionRevision: options.revision,
    selectedTaskId: selectedTaskIndex === null
      ? null
      : publicTaskId(selectedTaskIndex),
    view: options.view ?? "all",
    workspaceId,
  };
}

function assignedBundle(
  revision: number,
  assignedAgentId?: string,
): TaskWorkspaceProjectionBundle {
  const projection = bundle({ revision, view: "assigned" });
  return {
    ...projection,
    ...(assignedAgentId === undefined ? {} : { assignedAgentId }),
    firstPage: {
      ...projection.firstPage,
      ...(assignedAgentId === undefined ? {} : { assignedAgentId }),
    },
  };
}

function envelope(
  projection: TaskWorkspaceProjectionBundle,
  sourceGeneration = 1,
  authorityPresentation = presentation(),
): TaskWorkspaceProjectionEnvelope {
  return {
    consistency: { kind: "atomic", sourceGeneration },
    presentation: authorityPresentation,
    presentationRevision: projection.projectionRevision,
    projection,
  };
}

function interactiveBundle(revision: number): TaskWorkspaceProjectionBundle {
  const selected = bundle({ revision, selectedTaskIndex: 2 });
  if (selected.detail === null) throw new Error("fixture detail is required");
  return {
    ...selected,
    detail: {
      ...selected.detail,
      runs: [{
        desiredState: "run",
        events: [],
        id: "run_interaction_test",
        interactions: [{
          request: {
            createdAt: 1_000,
            expiresAt: 2_000,
            id: "interaction_approval_test",
            kind: "file_change_approval",
            scope: "once",
          },
          runId: "run_interaction_test",
          state: "pending",
        }],
        phase: "running",
        repositoryId: "repo_00000000000000000000000000",
        taskKey: selected.detail.task.key,
        updatedAt: 1_000,
      }],
    },
  };
}

function successful<Value>(value: Value): TaskWorkspaceSourceResult<Value> {
  return { ok: true, value };
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: Value) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve: (value: Value) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

class ClockHarness implements TaskWorkspaceClock {
  readonly intervals: number[] = [];
  readonly timeouts: number[] = [];
  #intervalCallbacks = new Map<number, () => void>();
  #nextHandle = 1;
  #now = 0;
  #timeoutCallbacks = new Map<
    number,
    Readonly<{ callback: () => void; deadline: number }>
  >();
  cancelCount = 0;
  timeoutCancelCount = 0;

  get activeCount(): number {
    return this.#intervalCallbacks.size;
  }

  get activeTimeoutCount(): number {
    return this.#timeoutCallbacks.size;
  }

  cancelInterval = (handle: unknown): void => {
    if (typeof handle !== "number") return;
    if (this.#intervalCallbacks.delete(handle)) this.cancelCount += 1;
  };

  cancelTimeout = (handle: unknown): void => {
    if (typeof handle !== "number") return;
    if (this.#timeoutCallbacks.delete(handle)) this.timeoutCancelCount += 1;
  };

  monotonicNow = (): number => this.#now;

  scheduleInterval = (callback: () => void, intervalMs: number): unknown => {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    this.intervals.push(intervalMs);
    this.#intervalCallbacks.set(handle, callback);
    return handle;
  };

  scheduleTimeout = (callback: () => void, timeoutMs: number): unknown => {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    this.timeouts.push(timeoutMs);
    this.#timeoutCallbacks.set(handle, {
      callback,
      deadline: this.#now + timeoutMs,
    });
    return handle;
  };

  advance(milliseconds: number): void {
    this.#now += milliseconds;
    while (true) {
      const due = [...this.#timeoutCallbacks.entries()]
        .filter(([, timeout]) => timeout.deadline <= this.#now)
        .sort(([leftHandle, left], [rightHandle, right]) =>
          left.deadline - right.deadline || leftHandle - rightHandle
        )[0];
      if (due === undefined) break;
      const [handle, timeout] = due;
      this.#timeoutCallbacks.delete(handle);
      timeout.callback();
    }
    for (const callback of [...this.#intervalCallbacks.values()]) callback();
  }
}

type OptionalSourceGeneration<Event> = Event extends TaskWorkspaceSourceEvent
  ? Omit<Event, "sourceGeneration"> &
    Readonly<{ sourceGeneration?: number }>
  : never;

type SourceHarnessEvent = {
  [Kind in TaskWorkspaceSourceEvent["kind"]]:
    OptionalSourceGeneration<
      Extract<TaskWorkspaceSourceEvent, { kind: Kind }>
    >;
}[TaskWorkspaceSourceEvent["kind"]];

class SourceHarness implements TaskWorkspaceSource {
  readonly acknowledgementContexts: TaskWorkspaceEffectContext[] = [];
  readonly acknowledgements: TaskWorkspaceMutationResult[] = [];
  readonly projectionAcknowledgementContexts: TaskWorkspaceEffectContext[] = [];
  readonly projectionAcknowledgements: TaskWorkspaceProjectionEnvelope[] = [];
  readonly continuationContexts: TaskWorkspaceEffectContext[] = [];
  readonly continuationRequests: TaskWorkspaceContinuationRequest[] = [];
  readonly mutationContexts: TaskWorkspaceEffectContext[] = [];
  readonly mutationRequests: TaskWorkspaceMutationRequest[] = [];
  readonly projectionContexts: TaskWorkspaceEffectContext[] = [];
  readonly projectionRequests: TaskWorkspaceProjectionRequest[] = [];
  readonly #continuationResponses: Array<
    Deferred<TaskWorkspaceSourceResult<TaskListPage>>
  > = [];
  readonly #mutationResponses: Array<
    Deferred<TaskWorkspaceSourceResult<TaskWorkspaceMutationResult>>
  > = [];
  readonly #mutationAcknowledgementResponses: Array<Deferred<void>> = [];
  readonly #projectionAcknowledgementResponses: Array<Deferred<void>> = [];
  readonly #projectionResponses: Array<
    Deferred<TaskWorkspaceSourceResult<TaskWorkspaceProjectionEnvelope>>
  > = [];
  #activeReads = 0;
  #listener: ((event: TaskWorkspaceSourceEvent) => void) | null = null;
  #maxActiveReads = 0;
  #sourceGeneration = 1;
  subscribeCount = 0;
  unsubscribeCount = 0;

  get maxActiveReads(): number {
    return this.#maxActiveReads;
  }

  acknowledgeMutation(
    result: TaskWorkspaceMutationResult,
    context: TaskWorkspaceEffectContext,
  ): Promise<void> {
    this.acknowledgements.push(result);
    this.acknowledgementContexts.push(context);
    return this.#mutationAcknowledgementResponses.shift()?.promise ??
      Promise.resolve();
  }

  acknowledgeProjection(
    envelope: TaskWorkspaceProjectionEnvelope,
    context: TaskWorkspaceEffectContext,
  ): Promise<void> {
    this.projectionAcknowledgements.push(envelope);
    this.projectionAcknowledgementContexts.push(context);
    return this.#projectionAcknowledgementResponses.shift()?.promise ??
      Promise.resolve();
  }

  nextContinuation(): Deferred<TaskWorkspaceSourceResult<TaskListPage>> {
    const response = deferred<TaskWorkspaceSourceResult<TaskListPage>>();
    this.#continuationResponses.push(response);
    return response;
  }

  nextMutation(): Deferred<TaskWorkspaceSourceResult<TaskWorkspaceMutationResult>> {
    const response = deferred<TaskWorkspaceSourceResult<TaskWorkspaceMutationResult>>();
    this.#mutationResponses.push(response);
    return response;
  }

  nextMutationAcknowledgement(): Deferred<void> {
    const response = deferred<void>();
    this.#mutationAcknowledgementResponses.push(response);
    return response;
  }

  nextProjectionAcknowledgement(): Deferred<void> {
    const response = deferred<void>();
    this.#projectionAcknowledgementResponses.push(response);
    return response;
  }

  nextProjection(): Deferred<
    TaskWorkspaceSourceResult<TaskWorkspaceProjectionEnvelope>
  > {
    const response = deferred<TaskWorkspaceSourceResult<TaskWorkspaceProjectionEnvelope>>();
    this.#projectionResponses.push(response);
    return response;
  }

  emit(event: SourceHarnessEvent): void {
    const sourceGeneration = event.sourceGeneration ?? this.#sourceGeneration;
    this.#listener?.({
      ...event,
      sourceGeneration,
    });
    if (
      event.kind === "source.replaced" &&
      sourceGeneration === this.#sourceGeneration
    ) {
      this.#sourceGeneration += 1;
    }
  }

  emitUnchecked(event: unknown): void {
    this.#listener?.(event as TaskWorkspaceSourceEvent);
  }

  execute(
    request: TaskWorkspaceMutationRequest,
    context: TaskWorkspaceEffectContext,
  ): Promise<TaskWorkspaceSourceResult<TaskWorkspaceMutationResult>> {
    this.mutationRequests.push(request);
    this.mutationContexts.push(context);
    const response = this.#mutationResponses.shift();
    if (response === undefined) return Promise.reject(new Error("missing mutation response"));
    return response.promise;
  }

  readContinuation(
    request: TaskWorkspaceContinuationRequest,
    context: TaskWorkspaceEffectContext,
  ): Promise<TaskWorkspaceSourceResult<TaskListPage>> {
    this.continuationRequests.push(request);
    this.continuationContexts.push(context);
    const response = this.#continuationResponses.shift();
    if (response === undefined) {
      return Promise.reject(new Error("missing continuation response"));
    }
    return this.#trackRead(response.promise);
  }

  readProjection(
    request: TaskWorkspaceProjectionRequest,
    context: TaskWorkspaceEffectContext,
  ): Promise<TaskWorkspaceSourceResult<TaskWorkspaceProjectionEnvelope>> {
    this.projectionRequests.push(request);
    this.projectionContexts.push(context);
    const response = this.#projectionResponses.shift();
    if (response === undefined) return Promise.reject(new Error("missing projection response"));
    return this.#trackRead(response.promise);
  }

  subscribe(listener: (event: TaskWorkspaceSourceEvent) => void): () => void {
    this.subscribeCount += 1;
    this.#listener = listener;
    return () => {
      this.unsubscribeCount += 1;
      if (this.#listener === listener) this.#listener = null;
    };
  }

  async #trackRead<Value>(promise: Promise<Value>): Promise<Value> {
    this.#activeReads += 1;
    this.#maxActiveReads = Math.max(this.#maxActiveReads, this.#activeReads);
    try {
      return await promise;
    } finally {
      this.#activeReads -= 1;
    }
  }
}

class RetryableSubscriptionSource extends SourceHarness {
  #remainingFailures = 1;

  override subscribe(
    listener: (event: TaskWorkspaceSourceEvent) => void,
  ): () => void {
    if (this.#remainingFailures > 0) {
      this.#remainingFailures -= 1;
      this.subscribeCount += 1;
      throw new Error("subscription transport unavailable");
    }
    return super.subscribe(listener);
  }
}

function createClient(source: SourceHarness) {
  const client = createTaskWorkspaceClient({
    coordinate: {
      selectedTaskId: null,
      view: "all",
      workspaceId,
    },
    source,
  });
  client.start();
  return client;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Bun.sleep(0);
}

async function waitFor(
  predicate: () => boolean,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function createTaskIntent(): Extract<
  TaskWorkspaceClientIntent,
  { kind: "task.create" }
> {
  return {
    availableAt: 1_000,
    labels: [],
    kind: "task.create",
    priority: 2,
    title: "Created task",
    type: "task",
  };
}

function mutationResult(
  revision: number,
  commandKind: "task.create" | "task.create_and_run" = "task.create",
): TaskWorkspaceMutationResult {
  if (commandKind === "task.create_and_run") {
    return {
      commandKind,
      operationId: "op_00000000000000000000000000",
      projectionRevision: revision,
      result: {
        kind: "task_created",
        runId: "run_created_task",
        taskId: publicTaskId(9),
        taskRevision: revision,
      },
      workspaceId,
      workspaceRevision: revision,
    };
  }
  return {
    commandKind,
    operationId: "op_00000000000000000000000000",
    projectionRevision: revision,
    result: {
      kind: "task_created",
      taskId: publicTaskId(9),
      taskRevision: revision,
    },
    workspaceId,
    workspaceRevision: revision,
  };
}

describe("headless task workspace client", () => {
  test("starts explicitly, idempotently, and remains inert during construction", async () => {
    const source = new SourceHarness();
    const clock = new ClockHarness();
    const initial = source.nextProjection();
    const client = createTaskWorkspaceClient({
      clock,
      coordinate: { selectedTaskId: null, view: "all", workspaceId },
      source,
    });

    expect(source.subscribeCount).toBe(0);
    expect(source.projectionRequests).toHaveLength(0);
    expect(clock.activeCount).toBe(0);
    client.start();
    client.start();
    expect(source.subscribeCount).toBe(1);
    expect(source.projectionRequests).toHaveLength(1);
    expect(clock.activeCount).toBe(1);
    expect(clock.intervals).toEqual([1_000]);
    initial.resolve(successful(envelope(bundle({ revision: 1 }))));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "explicitly started projection",
    );
    client.dispose();
    expect(clock.activeCount).toBe(0);
    expect(clock.cancelCount).toBe(1);

    const neverStartedSource = new SourceHarness();
    const neverStarted = createTaskWorkspaceClient({
      coordinate: { selectedTaskId: null, view: "all", workspaceId },
      source: neverStartedSource,
    });
    neverStarted.dispose();
    neverStarted.start();
    expect(neverStartedSource.subscribeCount).toBe(0);
    expect(neverStartedSource.projectionRequests).toHaveLength(0);
  });

  test("reacquires a failed source subscription before retrying projection reads", async () => {
    const source = new RetryableSubscriptionSource();
    const initial = source.nextProjection();
    const refresh = source.nextProjection();
    const client = createTaskWorkspaceClient({
      coordinate: { selectedTaskId: null, view: "all", workspaceId },
      source,
    });

    client.start();
    expect(source.subscribeCount).toBe(1);
    expect(source.projectionRequests).toHaveLength(0);
    expect(client.store.getSnapshot().projection).toEqual({
      error: { code: "SUBSCRIPTION_UNAVAILABLE" },
      kind: "error",
      minimumRevision: null,
    });

    client.retry();
    await waitFor(() => source.projectionRequests.length === 1, "retried subscription read");
    expect(source.subscribeCount).toBe(2);
    initial.resolve(successful(envelope(bundle({ revision: 1 }))));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "projection after subscription recovery",
    );

    source.emit({
      kind: "projection.invalidated",
      minimumRevision: 2,
      views: ["all"],
      workspaceId,
    });
    await waitFor(() => source.projectionRequests.length === 2, "live invalidation read");
    refresh.resolve(successful(envelope(bundle({ revision: 2 }))));
    await waitFor(() => {
      const projection = client.store.getSnapshot().projection;
      return projection.kind === "ready" &&
        projection.envelope.projection.projectionRevision === 2;
    }, "live projection after recovered subscription");
    client.dispose();
    expect(source.unsubscribeCount).toBe(1);
  });

  test("replaces an effect-owned client across Strict Mode cleanup replay", async () => {
    const firstSource = new SourceHarness();
    const firstClock = new ClockHarness();
    const firstProjection = firstSource.nextProjection();
    const secondSource = new SourceHarness();
    const secondClock = new ClockHarness();
    const secondProjection = secondSource.nextProjection();
    const host = createTaskWorkspaceClientHost({
      selectedTaskId: null,
      view: "all",
      workspaceId,
    });
    const firstClient = createTaskWorkspaceClient({
      clock: firstClock,
      coordinate: { selectedTaskId: null, view: "all", workspaceId },
      source: firstSource,
    });
    const cleanupFirst = host.install(firstClient);
    firstProjection.resolve(successful(envelope(bundle({ revision: 1 }))));
    await waitFor(
      () => host.client.store.getSnapshot().projection.kind === "ready",
      "first hosted client",
    );

    cleanupFirst();
    expect(firstSource.unsubscribeCount).toBe(1);
    expect(firstClock.activeCount).toBe(0);
    const secondClient = createTaskWorkspaceClient({
      clock: secondClock,
      coordinate: { selectedTaskId: null, view: "all", workspaceId },
      source: secondSource,
    });
    const cleanupSecond = host.install(secondClient);
    secondProjection.resolve(successful(envelope(bundle({ revision: 2 }))));
    await waitFor(() => {
      const projection = host.client.store.getSnapshot().projection;
      return projection.kind === "ready" &&
        projection.envelope.projection.projectionRevision === 2;
    }, "replacement hosted client");

    const secondRetry = secondSource.nextProjection();
    host.client.retry();
    await waitFor(
      () => secondSource.projectionRequests.length === 2,
      "hosted client retry delegation",
    );
    expect(firstSource.projectionRequests).toHaveLength(1);
    secondRetry.resolve(successful(envelope(bundle({ revision: 3 }))));
    await waitFor(() => {
      const projection = host.client.store.getSnapshot().projection;
      return projection.kind === "ready" &&
        projection.envelope.projection.projectionRevision === 3;
    }, "retried hosted projection");

    cleanupFirst();
    expect(secondSource.unsubscribeCount).toBe(0);
    expect(secondClock.activeCount).toBe(1);
    cleanupSecond();
    expect(secondSource.unsubscribeCount).toBe(1);
    expect(secondClock.activeCount).toBe(0);
  });

  test("installs one coherent envelope and isolates faulty listeners", async () => {
    const source = new SourceHarness();
    const initial = source.nextProjection();
    const client = createClient(source);
    let healthyListenerCalls = 0;
    client.store.subscribe(() => {
      throw new Error("consumer failure");
    });
    client.store.subscribe(() => {
      healthyListenerCalls += 1;
    });

    initial.resolve(successful(envelope(bundle({ revision: 1 }))));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "initial projection",
    );

    const snapshot = client.store.getSnapshot();
    expect(client.store.getSnapshot()).toBe(snapshot);
    expect(healthyListenerCalls).toBe(1);
    expect(snapshot.projection.kind).toBe("ready");
    if (snapshot.projection.kind === "ready") {
      expect(snapshot.projection.envelope.projection.projectionRevision).toBe(1);
      expect(snapshot.projection.pages).toHaveLength(1);
      expect(snapshot.projection.refresh).toEqual({ kind: "idle" });
    }
    client.dispose();
  });

  test("advances a monotonic authority-calibrated clock without source events", async () => {
    const source = new SourceHarness();
    const clock = new ClockHarness();
    const initial = source.nextProjection();
    const client = createTaskWorkspaceClient({
      clock,
      coordinate: { selectedTaskId: null, view: "all", workspaceId },
      source,
    });
    client.start();
    initial.resolve(successful(envelope(
      bundle({ revision: 1 }),
      1,
      presentation(1_000),
    )));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "clock authority projection",
    );
    expect(client.store.getSnapshot().now).toBe(1_000);

    clock.advance(1_500);
    expect(client.store.getSnapshot().now).toBe(2_500);
    source.emit({
      kind: "presentation.updated",
      presentation: presentation(4_000),
      presentationRevision: 2,
      workspaceId,
    });
    expect(client.store.getSnapshot().now).toBe(4_000);

    clock.advance(500);
    expect(client.store.getSnapshot().now).toBe(4_500);
    source.emit({
      kind: "presentation.updated",
      presentation: presentation(3_000),
      presentationRevision: 3,
      workspaceId,
    });
    expect(client.store.getSnapshot().now).toBe(4_500);
    const recalibrated = client.store.getSnapshot().projection;
    expect(
      recalibrated.kind === "ready" &&
        recalibrated.envelope.presentation.now,
    ).toBe(3_000);

    clock.advance(500);
    expect(client.store.getSnapshot().now).toBe(5_000);
    const beforeRegression = client.store.getSnapshot();
    clock.advance(-1_000);
    expect(client.store.getSnapshot()).toBe(beforeRegression);

    const beforeDispose = client.store.getSnapshot();
    client.dispose();
    clock.advance(1_000);
    expect(clock.activeCount).toBe(0);
    expect(client.store.getSnapshot()).toBe(beforeDispose);
  });

  test("atomically installs independent presentation updates without regression", async () => {
    const source = new SourceHarness();
    const initial = source.nextProjection();
    const projectionRefresh = source.nextProjection();
    const client = createClient(source);
    initial.resolve(successful({
      ...envelope(bundle({ revision: 1 })),
      presentationRevision: 5,
    }));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "initial independent presentation revision",
    );
    const before = client.store.getSnapshot();
    if (before.projection.kind !== "ready") {
      throw new Error("Expected a ready projection.");
    }
    const updatedPresentation = {
      ...presentation(),
      capabilities: {
        ...presentation().capabilities,
        canCreate: false,
      },
    };

    source.emit({
      kind: "presentation.updated",
      presentation: updatedPresentation,
      presentationRevision: 7,
      workspaceId,
    });

    const updated = client.store.getSnapshot();
    expect(updated).not.toBe(before);
    expect(updated.coordinate).toBe(before.coordinate);
    expect(updated.pendingMutation).toBe(before.pendingMutation);
    if (updated.projection.kind !== "ready") {
      throw new Error("Presentation update must retain the ready projection.");
    }
    expect(updated.projection.pages).toBe(before.projection.pages);
    expect(updated.projection.envelope.projection).toBe(
      before.projection.envelope.projection,
    );
    expect(updated.projection.envelope.presentationRevision).toBe(7);
    expect(updated.projection.envelope.presentation.capabilities.canCreate).toBeFalse();
    expect(updated.projection.envelope.projection.projectionRevision).toBe(1);

    const stable = updated;
    source.emit({
      kind: "presentation.updated",
      presentation: presentation(),
      presentationRevision: 6,
      workspaceId,
    });
    source.emit({
      kind: "presentation.updated",
      presentation: { hostile: true },
      presentationRevision: 8,
      workspaceId,
    } as unknown as TaskWorkspaceSourceEvent);
    source.emit({
      kind: "presentation.updated",
      presentation: presentation(),
      presentationRevision: 8,
      workspaceId: "wsp_99999999999999999999999999",
    });
    expect(client.store.getSnapshot()).toBe(stable);

    source.emit({
      kind: "projection.invalidated",
      minimumRevision: 2,
      views: ["all"],
      workspaceId,
    });
    projectionRefresh.resolve(successful(envelope(bundle({ revision: 2 }))));
    await waitFor(() => {
      const projection = client.store.getSnapshot().projection;
      return projection.kind === "ready" &&
        projection.envelope.projection.projectionRevision === 2 &&
        projection.refresh.kind === "idle";
    }, "projection refresh with retained presentation");
    const refreshed = client.store.getSnapshot().projection;
    if (refreshed.kind !== "ready") {
      throw new Error("Projection refresh must return to ready.");
    }
    expect(refreshed.envelope.presentationRevision).toBe(7);
    expect(refreshed.envelope.presentation.capabilities.canCreate).toBeFalse();
    client.dispose();
  });

  test("installs coherent intermediate heads and converges under continuous invalidations", async () => {
    const source = new SourceHarness();
    const first = source.nextProjection();
    const second = source.nextProjection();
    const third = source.nextProjection();
    const client = createClient(source);
    const installed: number[] = [];
    client.store.subscribe(() => {
      const projection = client.store.getSnapshot().projection;
      if (projection.kind === "ready") {
        const revision = projection.envelope.projection.projectionRevision;
        if (installed.at(-1) !== revision) installed.push(revision);
      }
    });

    source.emit({
      kind: "projection.invalidated",
      minimumRevision: 2,
      views: ["all"],
      workspaceId,
    });
    source.emit({
      kind: "projection.invalidated",
      minimumRevision: 3,
      views: ["all"],
      workspaceId,
    });
    first.resolve(successful(envelope(bundle({ revision: 1 }))));
    await waitFor(() => source.projectionRequests.length === 2, "revision 3 read");
    expect(source.projectionRequests[1]?.minimumRevision).toBe(3);

    source.emit({
      kind: "projection.invalidated",
      minimumRevision: 4,
      views: ["all"],
      workspaceId,
    });
    second.resolve(successful(envelope(bundle({ revision: 3 }))));
    await waitFor(() => source.projectionRequests.length === 3, "revision 4 read");
    third.resolve(successful(envelope(bundle({ revision: 4 }))));
    await waitFor(() => {
      const projection = client.store.getSnapshot().projection;
      return projection.kind === "ready" &&
        projection.envelope.projection.projectionRevision === 4 &&
        projection.refresh.kind === "idle";
    }, "terminal projection");

    expect(installed).toEqual([1, 3, 4]);
    expect(source.maxActiveReads).toBeLessThanOrEqual(
      TASK_WORKSPACE_MAX_READ_CONCURRENCY,
    );
    client.dispose();
  });

  test("deduplicates an active equal floor and retries it after refresh failure", async () => {
    const source = new SourceHarness();
    const initial = source.nextProjection();
    const failedRefresh = source.nextProjection();
    const retry = source.nextProjection();
    const client = createClient(source);
    initial.resolve(successful(envelope(bundle({ revision: 1 }))));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "initial projection",
    );

    source.emit({
      kind: "projection.invalidated",
      minimumRevision: 2,
      views: ["all"],
      workspaceId,
    });
    await waitFor(() => source.projectionRequests.length === 2, "first recovery read");
    source.emit({
      kind: "projection.invalidated",
      minimumRevision: 2,
      views: ["all"],
      workspaceId,
    });
    await settle();
    expect(source.projectionRequests).toHaveLength(2);
    expect(source.maxActiveReads).toBe(1);

    failedRefresh.resolve({
      error: { code: "TEMPORARY_FAILURE" },
      ok: false,
    });
    await waitFor(() => {
      const projection = client.store.getSnapshot().projection;
      return projection.kind === "ready" && projection.refresh.kind === "error";
    }, "equal-floor refresh error");
    source.emit({
      kind: "projection.invalidated",
      minimumRevision: 2,
      views: ["all"],
      workspaceId,
    });
    await waitFor(() => source.projectionRequests.length === 3, "errored floor retry");
    retry.resolve(successful(envelope(bundle({ revision: 2, title: "fresh" }))));
    await waitFor(() => {
      const projection = client.store.getSnapshot().projection;
      return projection.kind === "ready" &&
        projection.envelope.projection.firstPage.items[0]?.task.title === "fresh";
    }, "fresh equal-floor projection");
    client.dispose();
  });

  test("carries the list floor across selection and rejects obsolete detail", async () => {
    const source = new SourceHarness();
    const initial = source.nextProjection();
    const obsoleteSelection = source.nextProjection();
    const currentSelection = source.nextProjection();
    const client = createClient(source);
    initial.resolve(successful(envelope(bundle({ revision: 5 }))));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "initial projection",
    );

    await client.dispatch({ kind: "task.select", taskId: publicTaskId(2) });
    await waitFor(() => source.projectionRequests.length === 2, "first selection read");
    expect(source.projectionRequests[1]?.minimumRevision).toBe(5);
    await client.dispatch({ kind: "task.select", taskId: publicTaskId(3) });
    await waitFor(() => source.projectionRequests.length === 3, "second selection read");
    expect(source.projectionRequests[2]?.minimumRevision).toBe(5);
    expect(source.maxActiveReads).toBe(2);

    obsoleteSelection.resolve(successful(envelope(bundle({
      revision: 5,
      selectedTaskIndex: 2,
      title: "obsolete",
    }))));
    await settle();
    expect(client.store.getSnapshot().projection.kind).toBe("loading");

    currentSelection.resolve(successful(envelope(bundle({
      revision: 5,
      selectedTaskIndex: 3,
      title: "current",
    }))));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "current selection",
    );
    expect(client.store.getSnapshot().coordinate.selectedTaskId).toBe(publicTaskId(3));
    client.dispose();
  });

  test("starts the current read after two obsolete reads ignore cancellation forever", async () => {
    const source = new SourceHarness();
    source.nextProjection();
    source.nextProjection();
    const currentSelection = source.nextProjection();
    const client = createClient(source);
    await waitFor(() => source.projectionRequests.length === 1, "first hung read");

    expect(await client.dispatch({
      kind: "task.select",
      taskId: publicTaskId(2),
    })).toEqual({ ok: true, outcome: "accepted" });
    await waitFor(() => source.projectionRequests.length === 2, "second hung read");

    expect(await client.dispatch({
      kind: "task.select",
      taskId: publicTaskId(3),
    })).toEqual({ ok: true, outcome: "accepted" });
    await waitFor(() => source.projectionRequests.length === 3, "current read");

    expect(source.projectionContexts[0]?.signal.aborted).toBeTrue();
    expect(source.projectionContexts[1]?.signal.aborted).toBeTrue();
    expect(source.projectionContexts[2]?.signal.aborted).toBeFalse();
    currentSelection.resolve(successful(envelope(bundle({
      revision: 1,
      selectedTaskIndex: 3,
    }))));
    await waitFor(() => {
      const snapshot = client.store.getSnapshot();
      return snapshot.projection.kind === "ready" &&
        snapshot.coordinate.selectedTaskId === publicTaskId(3);
    }, "current projection after ignored aborts");
    client.dispose();
  });

  test("releases a read slot at its monotonic deadline", async () => {
    const source = new SourceHarness();
    const clock = new ClockHarness();
    source.nextProjection();
    source.nextProjection();
    const recovered = source.nextProjection();
    const client = createTaskWorkspaceClient({
      clock,
      coordinate: { selectedTaskId: null, view: "all", workspaceId },
      effectTimeoutMs: 100,
      source,
    });
    client.start();
    await waitFor(() => source.projectionRequests.length === 1, "deadline read");
    expect(source.projectionContexts[0]?.deadlineMonotonicMs).toBe(100);
    expect(clock.activeTimeoutCount).toBe(1);

    clock.advance(100);
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "error",
      "deadline error",
    );
    expect(source.projectionContexts[0]?.signal.aborted).toBeTrue();
    expect(client.store.getSnapshot().projection).toEqual({
      error: { code: "SERVICE_UNAVAILABLE" },
      kind: "error",
      minimumRevision: null,
    });

    client.retry();
    await waitFor(() => source.projectionRequests.length === 2, "second deadline read");
    expect(source.projectionContexts[1]?.deadlineMonotonicMs).toBe(200);
    clock.advance(100);
    await waitFor(() => {
      const projection = client.store.getSnapshot().projection;
      return projection.kind === "error" &&
        source.projectionContexts[1]?.signal.aborted === true;
    }, "second deadline error");

    client.retry();
    await waitFor(
      () => source.projectionRequests.length === 3,
      "read after two ignored deadline aborts",
    );
    expect(source.projectionContexts[2]?.deadlineMonotonicMs).toBe(300);
    recovered.resolve(successful(envelope(bundle({ revision: 1 }))));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "projection after deadline retry",
    );
    client.dispose();
  });

  test("treats a mutation deadline after invocation as outcome unknown", async () => {
    const source = new SourceHarness();
    const clock = new ClockHarness();
    const initial = source.nextProjection();
    source.nextMutation();
    const client = createTaskWorkspaceClient({
      clock,
      coordinate: { selectedTaskId: null, view: "all", workspaceId },
      effectTimeoutMs: 100,
      source,
    });
    client.start();
    initial.resolve(successful(envelope(bundle({ revision: 1 }))));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "mutation deadline projection",
    );

    const dispatch = client.dispatch(createTaskIntent());
    await waitFor(() => source.mutationRequests.length === 1, "hung mutation");
    expect(source.mutationContexts[0]?.deadlineMonotonicMs).toBe(100);
    clock.advance(100);

    expect(await dispatch).toEqual({
      error: { code: "MUTATION_OUTCOME_UNKNOWN" },
      ok: false,
    });
    expect(source.mutationContexts[0]?.signal.aborted).toBeTrue();
    expect(client.store.getSnapshot().pendingMutation?.phase).toBe(
      "outcome_unknown",
    );
    client.dispose();
  });

  test("retains failed floors, fences mutations, and retries through the client boundary", async () => {
    const source = new SourceHarness();
    const initial = source.nextProjection();
    const failedRefresh = source.nextProjection();
    const retry = source.nextProjection();
    const client = createClient(source);
    initial.resolve(successful(envelope(bundle({ revision: 1 }))));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "initial projection",
    );

    source.emit({
      kind: "projection.invalidated",
      minimumRevision: 3,
      views: ["all"],
      workspaceId,
    });
    failedRefresh.resolve({
      error: { code: "TEMPORARY_FAILURE" },
      ok: false,
    });
    await waitFor(() => {
      const projection = client.store.getSnapshot().projection;
      return projection.kind === "ready" && projection.refresh.kind === "error";
    }, "retained refresh error");
    const projection = client.store.getSnapshot().projection;
    if (projection.kind === "ready" && projection.refresh.kind === "error") {
      expect(projection.refresh.minimumRevision).toBe(3);
    }

    expect(await client.dispatch(createTaskIntent())).toEqual({
      error: { code: "MUTATION_FENCED" },
      ok: false,
    });
    expect(source.mutationRequests).toHaveLength(0);

    client.retry();
    await waitFor(() => source.projectionRequests.length === 3, "explicit retry");
    expect(source.projectionRequests[2]?.minimumRevision).toBe(3);
    retry.resolve(successful(envelope(bundle({ revision: 3 }))));
    await waitFor(() => {
      const current = client.store.getSnapshot().projection;
      return current.kind === "ready" && current.refresh.kind === "idle";
    }, "recovered projection");
    client.dispose();
  });

  test("appends immutable continuations, removes overlap, and discards a stale page", async () => {
    const source = new SourceHarness();
    const initial = source.nextProjection();
    const continuation = source.nextContinuation();
    const staleContinuation = source.nextContinuation();
    const refresh = source.nextProjection();
    const client = createClient(source);
    initial.resolve(successful(envelope(bundle({ cursor: "cursor-1", revision: 1 }))));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "initial projection",
    );

    const firstLoad = client.dispatch({ kind: "page.load_more" });
    await waitFor(() => source.continuationRequests.length === 1, "first continuation");
    continuation.resolve(successful(page({
      cursor: "cursor-2",
      items: [listItem(1, 1), listItem(2, 1)],
      revision: 1,
    })));
    expect(await firstLoad).toEqual({ ok: true, outcome: "accepted" });
    const appended = client.store.getSnapshot().projection;
    expect(appended.kind).toBe("ready");
    if (appended.kind === "ready") {
      expect(appended.pages).toHaveLength(2);
      expect(appended.pages[1]?.items.map(({ task }) => task.id)).toEqual([
        publicTaskId(2),
      ]);
    }

    const secondLoad = client.dispatch({ kind: "page.load_more" });
    await waitFor(() => source.continuationRequests.length === 2, "second continuation");
    source.emit({
      kind: "projection.invalidated",
      minimumRevision: 2,
      views: ["all"],
      workspaceId,
    });
    staleContinuation.resolve(successful(page({
      items: [listItem(3, 1)],
      revision: 1,
    })));
    expect(await secondLoad).toEqual({
      error: { code: "REQUEST_SUPERSEDED" },
      ok: false,
    });
    refresh.resolve(successful(envelope(bundle({ revision: 2 }))));
    await waitFor(() => {
      const current = client.store.getSnapshot().projection;
      return current.kind === "ready" &&
        current.envelope.projection.projectionRevision === 2;
    }, "new projection head");
    const current = client.store.getSnapshot().projection;
    if (current.kind === "ready") expect(current.pages).toHaveLength(1);
    client.dispose();
  });

  test("rejects a continuation from a newer projection without relabeling the root", async () => {
    const source = new SourceHarness();
    const initial = source.nextProjection();
    const continuation = source.nextContinuation();
    const client = createClient(source);
    initial.resolve(successful(envelope(bundle({
      continuationRevision: 1,
      cursor: "cursor-1",
      revision: 1,
      title: "Retained root content",
    }))));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "initial continuation root",
    );

    const load = client.dispatch({ kind: "page.load_more" });
    await waitFor(
      () => source.continuationRequests.length === 1,
      "newer continuation request",
    );
    continuation.resolve(successful(page({
      items: [listItem(2, 2)],
      revision: 2,
    })));
    expect(await load).toEqual({
      error: { code: "INVALID_CONTINUATION" },
      ok: false,
    });

    const retained = client.store.getSnapshot().projection;
    if (retained.kind !== "ready") {
      throw new Error("Continuation append must retain a ready projection.");
    }
    expect(retained.envelope.projection.projectionRevision).toBe(1);
    expect(retained.envelope.projection.continuationRevision).toBe(1);
    expect(retained.envelope.projection.firstPage.items[0]?.task.title).toBe(
      "Retained root content",
    );
    expect(retained.pages).toHaveLength(1);
    client.dispose();
  });

  test("rejects a continuation when a projection patch wins the commit race", async () => {
    const source = new SourceHarness();
    const initial = source.nextProjection();
    const continuation = source.nextContinuation();
    const client = createClient(source);
    initial.resolve(successful(envelope(bundle({
      continuationRevision: 1,
      cursor: "cursor-1",
      revision: 1,
    }))));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "continuation race root",
    );

    const load = client.dispatch({ kind: "page.load_more" });
    await waitFor(
      () => source.continuationRequests.length === 1,
      "continuation race request",
    );
    source.emit({
      continuationRevision: 1,
      kind: "projection.patched",
      patches: [],
      projectionRevision: 2,
      view: "all",
      workspaceId,
    });
    continuation.resolve(successful(page({
      items: [listItem(2, 1)],
      revision: 1,
    })));

    expect(await load).toEqual({
      error: { code: "REQUEST_SUPERSEDED" },
      ok: false,
    });
    const retained = client.store.getSnapshot().projection;
    if (retained.kind !== "ready") {
      throw new Error("A superseded continuation must retain ready state.");
    }
    expect(retained.envelope.projection.projectionRevision).toBe(2);
    expect(retained.pages).toHaveLength(1);
    expect(retained.pages[0]?.projectionRevision).toBe(2);
    expect(retained.pages[0]?.items.map(({ task }) => task.id)).toEqual([
      publicTaskId(1),
    ]);
    expect(retained.continuation).toEqual({
      cursor: "cursor-1",
      kind: "idle",
    });
    client.dispose();
  });

  test("atomically patches loaded tasks across pages and permits revision-only advances", async () => {
    const source = new SourceHarness();
    const initial = source.nextProjection();
    const continuation = source.nextContinuation();
    const client = createClient(source);
    initial.resolve(successful(envelope(bundle({
      continuationRevision: 1,
      cursor: "cursor-1",
      revision: 1,
    }))));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "patchable projection root",
    );
    const load = client.dispatch({ kind: "page.load_more" });
    continuation.resolve(successful(page({
      items: [listItem(2, 1)],
      revision: 1,
    })));
    expect(await load).toEqual({ ok: true, outcome: "accepted" });

    source.emit({
      continuationRevision: 1,
      kind: "projection.patched",
      patches: [
        { item: listItem(2, 2, "Patched second page"), taskId: publicTaskId(2) },
        { item: listItem(1, 2, "Patched first page"), taskId: publicTaskId(1) },
      ],
      projectionRevision: 2,
      view: "all",
      workspaceId,
    });

    const patched = client.store.getSnapshot().projection;
    if (patched.kind !== "ready") {
      throw new Error("Projection patch must retain ready state.");
    }
    expect(patched.pages[0]?.items[0]?.task.title).toBe("Patched first page");
    expect(patched.pages[1]?.items[0]?.task.title).toBe("Patched second page");
    expect(patched.pages.map(({ projectionRevision }) => projectionRevision)).toEqual([
      2,
      2,
    ]);
    expect(patched.envelope.projection.firstPage.items[0]?.task.title).toBe(
      "Patched first page",
    );
    expect(patched.envelope.projection.projectionRevision).toBe(2);
    expect(patched.envelope.projection.continuationRevision).toBe(1);

    const titles = patched.pages.map((pageValue) =>
      pageValue.items.map(({ task }) => task.title)
    );
    source.emit({
      continuationRevision: 1,
      kind: "projection.patched",
      patches: [],
      projectionRevision: 3,
      view: "all",
      workspaceId,
    });
    const advanced = client.store.getSnapshot().projection;
    if (advanced.kind !== "ready") {
      throw new Error("Revision-only patch must retain ready state.");
    }
    expect(advanced.pages.map((pageValue) =>
      pageValue.items.map(({ task }) => task.title)
    )).toEqual(titles);
    expect(advanced.pages.map(({ projectionRevision }) => projectionRevision)).toEqual([
      3,
      3,
    ]);
    expect(advanced.envelope.projection.projectionRevision).toBe(3);
    expect(advanced.envelope.projection.continuationRevision).toBe(1);
    client.dispose();
  });

  test("scopes projection patches to the exact assigned-agent coordinate", async () => {
    const filters = [
      undefined,
      "agent_alpha",
      "agent_beta",
    ] as const;

    for (const coordinateFilter of filters) {
      for (const eventFilter of filters) {
        const source = new SourceHarness();
        const initial = source.nextProjection();
        const client = createTaskWorkspaceClient({
          coordinate: {
            ...(coordinateFilter === undefined
              ? {}
              : { assignedAgentId: coordinateFilter }),
            selectedTaskId: null,
            view: "assigned",
            workspaceId,
          },
          source,
        });
        client.start();
        initial.resolve(successful(envelope(
          assignedBundle(1, coordinateFilter),
        )));
        await waitFor(
          () => client.store.getSnapshot().projection.kind === "ready",
          "assigned projection patch root",
        );
        const stable = client.store.getSnapshot();

        source.emit({
          ...(eventFilter === undefined
            ? {}
            : { assignedAgentId: eventFilter }),
          continuationRevision: 1,
          kind: "projection.patched",
          patches: [],
          projectionRevision: 2,
          view: "assigned",
          workspaceId,
        });

        const next = client.store.getSnapshot();
        if (coordinateFilter !== eventFilter) {
          expect(next).toBe(stable);
        } else {
          expect(next.projection.kind).toBe("ready");
          if (next.projection.kind === "ready") {
            expect(next.projection.envelope.projection.projectionRevision).toBe(2);
          }
        }
        client.dispose();
      }
    }
  });

  test("rejects non-canonical projection patch event shapes", async () => {
    const source = new SourceHarness();
    const initial = source.nextProjection();
    const client = createClient(source);
    initial.resolve(successful(envelope(bundle({ revision: 1 }))));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "strict projection patch root",
    );
    const stable = client.store.getSnapshot();

    for (const event of [
      {
        assignedAgentId: "agent_alpha",
        continuationRevision: 1,
        kind: "projection.patched",
        patches: [],
        projectionRevision: 2,
        sourceGeneration: 1,
        view: "all",
        workspaceId,
      },
      {
        continuationRevision: 1,
        extra: true,
        kind: "projection.patched",
        patches: [],
        projectionRevision: 2,
        sourceGeneration: 1,
        view: "all",
        workspaceId,
      },
      {
        assignedAgentId: undefined,
        continuationRevision: 1,
        kind: "projection.patched",
        patches: [],
        projectionRevision: 2,
        sourceGeneration: 1,
        view: "all",
        workspaceId,
      },
    ]) {
      source.emitUnchecked(event);
      expect(client.store.getSnapshot()).toBe(stable);
    }
    client.dispose();
  });

  test("rejects duplicate, hostile, oversized, and absent projection patch batches atomically", async () => {
    const source = new SourceHarness();
    const initial = source.nextProjection();
    const client = createClient(source);
    initial.resolve(successful(envelope(bundle({ revision: 1 }))));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "projection patch rejection root",
    );
    const stable = client.store.getSnapshot();
    const event = {
      continuationRevision: 1,
      kind: "projection.patched" as const,
      projectionRevision: 2,
      view: "all" as const,
      workspaceId,
    };

    source.emit({
      ...event,
      patches: [
        { item: listItem(1, 2, "First duplicate"), taskId: publicTaskId(1) },
        { item: listItem(1, 2, "Second duplicate"), taskId: publicTaskId(1) },
      ],
    });
    expect(client.store.getSnapshot()).toBe(stable);
    source.emit({
      ...event,
      patches: [{
        item: listItem(2, 2, "Mismatched item"),
        taskId: publicTaskId(1),
      }],
    });
    expect(client.store.getSnapshot()).toBe(stable);
    source.emit({
      ...event,
      patches: [
        { item: listItem(1, 2, "Must not partially apply"), taskId: publicTaskId(1) },
        { item: listItem(3, 2, "Absent task"), taskId: publicTaskId(3) },
      ],
    });
    expect(client.store.getSnapshot()).toBe(stable);
    source.emit({
      ...event,
      patches: Array.from({ length: 101 }, (_, index) => ({
        item: listItem(index + 1, 2),
        taskId: publicTaskId(index + 1),
      })),
    });
    expect(client.store.getSnapshot()).toBe(stable);
    client.dispose();
  });

  test("rejects a list patch for the selected task instead of relabeling stale detail", async () => {
    const source = new SourceHarness();
    const initial = source.nextProjection();
    const client = createTaskWorkspaceClient({
      coordinate: {
        selectedTaskId: publicTaskId(1),
        view: "all",
        workspaceId,
      },
      source,
    });
    client.start();
    initial.resolve(successful(envelope(bundle({
      revision: 1,
      selectedTaskIndex: 1,
    }))));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "selected projection patch root",
    );
    const stable = client.store.getSnapshot();

    source.emit({
      continuationRevision: 1,
      kind: "projection.patched",
      patches: [{
        item: listItem(1, 2, "Selected task changed"),
        taskId: publicTaskId(1),
      }],
      projectionRevision: 2,
      view: "all",
      workspaceId,
    });

    expect(client.store.getSnapshot()).toBe(stable);
    client.dispose();
  });

  test("keeps paging available while display-only projection heads advance", async () => {
    const source = new SourceHarness();
    const initial = source.nextProjection();
    const refresh = source.nextProjection();
    const continuation = source.nextContinuation();
    const client = createClient(source);
    initial.resolve(successful(envelope(bundle({
      continuationRevision: 1,
      cursor: "cursor-1",
      revision: 1,
    }))));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "initial stable continuation",
    );

    source.emit({
      kind: "projection.invalidated",
      continuationRevision: 1,
      minimumRevision: 2,
      views: ["all"],
      workspaceId,
    });
    await waitFor(() => source.projectionRequests.length === 2, "display refresh");
    const load = client.dispatch({ kind: "page.load_more" });
    await waitFor(
      () => source.continuationRequests.length === 1,
      "continuation during display refresh",
    );
    expect(source.continuationRequests[0]?.continuationRevision).toBe(1);
    continuation.resolve(successful(page({
      items: [listItem(2, 2)],
      revision: 1,
    })));
    expect(await load).toEqual({ ok: true, outcome: "accepted" });

    refresh.resolve(successful(envelope(bundle({
      continuationRevision: 1,
      cursor: "cursor-1",
      revision: 2,
      title: "Updated display projection",
    }))));
    await waitFor(() => {
      const projection = client.store.getSnapshot().projection;
      return projection.kind === "ready" &&
        projection.envelope.projection.projectionRevision === 2 &&
        projection.refresh.kind === "idle";
    }, "display refresh convergence");
    const projection = client.store.getSnapshot().projection;
    if (projection.kind !== "ready") throw new Error("projection must remain ready");
    expect(projection.pages).toHaveLength(2);
    expect(projection.pages[0]?.items[0]?.task.title).toBe(
      "Updated display projection",
    );
    expect(projection.pages[1]?.items[0]?.task.id).toBe(publicTaskId(2));
    client.dispose();
  });

  test("caps retained continuation pages before another source read", async () => {
    const source = new SourceHarness();
    const initial = source.nextProjection();
    const client = createClient(source);
    initial.resolve(successful(envelope(bundle({
      cursor: "cursor-1",
      revision: 1,
    }))));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "page-limit root",
    );

    for (
      let pageIndex = 1;
      pageIndex < TASK_WORKSPACE_MAX_LOADED_PAGES;
      pageIndex += 1
    ) {
      const continuation = source.nextContinuation();
      const load = client.dispatch({ kind: "page.load_more" });
      await waitFor(
        () => source.continuationRequests.length === pageIndex,
        `page-limit continuation ${String(pageIndex)}`,
      );
      continuation.resolve(successful(page({
        cursor: `cursor-${String(pageIndex + 1)}`,
        items: [listItem(pageIndex + 1, 1)],
        revision: 1,
      })));
      expect(await load).toEqual({ ok: true, outcome: "accepted" });
    }

    const beforeLimit = source.continuationRequests.length;
    expect(await client.dispatch({ kind: "page.load_more" })).toEqual({
      error: { code: "PAGE_LIMIT_REACHED" },
      ok: false,
    });
    expect(source.continuationRequests).toHaveLength(beforeLimit);
    const projection = client.store.getSnapshot().projection;
    expect(projection.kind).toBe("ready");
    if (projection.kind === "ready") {
      expect(projection.pages).toHaveLength(TASK_WORKSPACE_MAX_LOADED_PAGES);
    }
    client.dispose();
  });

  test("moves mutations from dispatching through synchronizing to idle", async () => {
    const source = new SourceHarness();
    const initial = source.nextProjection();
    const mutation = source.nextMutation();
    const synchronized = source.nextProjection();
    const client = createClient(source);
    initial.resolve(successful(envelope(bundle({ revision: 1 }))));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "initial projection",
    );
    const phases: string[] = [];
    client.store.subscribe(() => {
      const phase = client.store.getSnapshot().pendingMutation?.phase ?? "idle";
      if (phases.at(-1) !== phase) phases.push(phase);
    });

    const dispatched = client.dispatch(createTaskIntent());
    await waitFor(
      () => client.store.getSnapshot().pendingMutation?.phase === "dispatching",
      "dispatching mutation",
    );
    mutation.resolve(successful(mutationResult(2)));
    expect(await dispatched).toEqual({
      ok: true,
      outcome: "committed",
      result: mutationResult(2),
    });
    await waitFor(
      () => client.store.getSnapshot().pendingMutation?.phase === "synchronizing",
      "synchronizing mutation",
    );
    expect(source.projectionRequests.at(-1)?.minimumRevision).toBe(2);
    synchronized.resolve(successful(envelope(bundle({ revision: 2 }))));
    await waitFor(
      () => client.store.getSnapshot().pendingMutation === null,
      "idle mutation",
    );

    expect(phases).toEqual([
      "dispatching",
      "acknowledging",
      "synchronizing",
      "idle",
    ]);
    client.dispose();
  });

  test("returns a committed result before supervised acknowledgement settles", async () => {
    const source = new SourceHarness();
    const initial = source.nextProjection();
    const mutation = source.nextMutation();
    const acknowledgement = source.nextMutationAcknowledgement();
    const synchronized = source.nextProjection();
    const client = createClient(source);
    initial.resolve(successful(envelope(bundle({ revision: 1 }))));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "acknowledgement root",
    );

    const phasesAtAcknowledgement: string[] = [];
    const unsubscribe = client.store.subscribe(() => {
      if (source.acknowledgements.length === 0) return;
      phasesAtAcknowledgement.push(
        client.store.getSnapshot().pendingMutation?.phase ?? "idle",
      );
    });
    const dispatch = client.dispatch(createTaskIntent());
    mutation.resolve(successful(mutationResult(2)));
    expect(await dispatch).toEqual({
      ok: true,
      outcome: "committed",
      result: mutationResult(2),
    });
    expect(source.acknowledgements).toEqual([mutationResult(2)]);
    expect(client.store.getSnapshot().pendingMutation?.phase).toBe(
      "acknowledging",
    );
    expect(await client.dispatch(createTaskIntent())).toEqual({
      error: { code: "MUTATION_FENCED" },
      ok: false,
    });

    synchronized.resolve(successful(envelope(bundle({ revision: 2 }))));
    await waitFor(
      () => {
        const projection = client.store.getSnapshot().projection;
        return projection.kind === "ready" &&
          projection.envelope.projection.projectionRevision === 2;
      },
      "projection installed while acknowledgement remains open",
    );
    expect(client.store.getSnapshot().pendingMutation?.phase).toBe(
      "acknowledging",
    );
    acknowledgement.reject(new Error("receipt retirement unavailable"));
    await waitFor(
      () => client.store.getSnapshot().pendingMutation === null,
      "committed acknowledgement failure",
    );
    expect(client.store.getSnapshot().dispatchError).toBeNull();
    expect(phasesAtAcknowledgement).toContain("acknowledging");
    unsubscribe();
    client.dispose();
  });

  test("cancels owned acknowledgement effects on replacement and disposal", async () => {
    const source = new SourceHarness();
    const projectionAcknowledgement = source.nextProjectionAcknowledgement();
    const initial = source.nextProjection();
    const mutation = source.nextMutation();
    const mutationAcknowledgement = source.nextMutationAcknowledgement();
    const supersededSynchronization = source.nextProjection();
    const replacement = source.nextProjection();
    const client = createClient(source);
    initial.resolve(successful(envelope(bundle({ revision: 1 }))));
    await waitFor(
      () => source.projectionAcknowledgementContexts.length === 1,
      "projection acknowledgement start",
    );
    expect(
      source.projectionAcknowledgementContexts[0]?.signal.aborted,
    ).toBeFalse();

    const dispatch = client.dispatch(createTaskIntent());
    mutation.resolve(successful(mutationResult(2)));
    expect((await dispatch).ok).toBeTrue();
    expect(
      source.acknowledgementContexts[0]?.signal.aborted,
    ).toBeFalse();

    source.emit({ kind: "source.replaced", workspaceId });
    expect(
      source.projectionAcknowledgementContexts[0]?.signal.aborted,
    ).toBeTrue();
    expect(source.acknowledgementContexts[0]?.signal.aborted).toBeTrue();
    expect(client.store.getSnapshot().pendingMutation?.phase).toBe(
      "synchronizing",
    );
    replacement.resolve(successful(envelope(bundle({ revision: 2 }), 2)));
    await waitFor(
      () => client.store.getSnapshot().pendingMutation === null,
      "replacement synchronization",
    );

    const disposalAcknowledgement = source.nextProjectionAcknowledgement();
    const acknowledgementCountBeforeRefresh =
      source.projectionAcknowledgementContexts.length;
    const refresh = source.nextProjection();
    source.emit({
      kind: "projection.invalidated",
      minimumRevision: 3,
      views: ["all"],
      workspaceId,
    });
    refresh.resolve(successful(envelope(bundle({ revision: 3 }), 2)));
    await waitFor(
      () =>
        source.projectionAcknowledgementContexts.length ===
          acknowledgementCountBeforeRefresh + 1,
      "disposal acknowledgement start",
    );
    client.dispose();
    expect(
      source.projectionAcknowledgementContexts[
        acknowledgementCountBeforeRefresh
      ]?.signal.aborted,
    ).toBeTrue();

    projectionAcknowledgement.resolve();
    mutationAcknowledgement.resolve();
    disposalAcknowledgement.resolve();
    supersededSynchronization.resolve(successful(envelope(bundle({
      revision: 2,
    }))));
  });

  test("accepts the durable create-and-run result for repository-backed creation", async () => {
    const source = new SourceHarness();
    const initial = source.nextProjection();
    const mutation = source.nextMutation();
    const synchronized = source.nextProjection();
    const client = createClient(source);
    initial.resolve(successful(envelope(bundle({ revision: 1 }))));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "initial projection",
    );

    const dispatch = client.dispatch({
      ...createTaskIntent(),
      repositoryId: "repo_00000000000000000000000000",
    });
    mutation.resolve(successful(mutationResult(2, "task.create_and_run")));
    expect(await dispatch).toEqual({
      ok: true,
      outcome: "committed",
      result: mutationResult(2, "task.create_and_run"),
    });
    synchronized.resolve(successful(envelope(bundle({ revision: 2 }))));
    await waitFor(
      () => client.store.getSnapshot().pendingMutation === null,
      "create-and-run synchronization",
    );
    client.dispose();
  });

  test("rejects stale editor bases and validates interaction responses from installed authority", async () => {
    const source = new SourceHarness();
    const initial = source.nextProjection();
    const client = createTaskWorkspaceClient({
      coordinate: {
        selectedTaskId: publicTaskId(2),
        view: "all",
        workspaceId,
      },
      source,
    });
    client.start();
    initial.resolve(successful(envelope(interactiveBundle(5))));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "interactive projection",
    );

    expect(await client.dispatch({
      expectedTaskRevision: 4,
      kind: "task.update",
      patch: { title: "Stale title" },
      taskId: publicTaskId(2),
    })).toEqual({
      error: { code: "TASK_STATE_CONFLICT" },
      ok: false,
    });
    expect(await client.dispatch({
      interactionId: "interaction_approval_test",
      kind: "interaction.respond",
      response: {
        answers: [{
          otherText: "Use the safer option.",
          questionId: "question_model_test",
          selectedOptionIds: [],
        }],
        kind: "user_input",
      },
      runId: "run_interaction_test",
    })).toEqual({
      error: { code: "INVALID_INTERACTION_RESPONSE" },
      ok: false,
    });
    expect(source.mutationRequests).toHaveLength(0);
    client.dispose();
  });

  test("separates source generation from revision and fences late source completions", async () => {
    const source = new SourceHarness();
    const oldSource = source.nextProjection();
    const newSource = source.nextProjection();
    const client = createClient(source);
    source.emit({ kind: "source.replaced", workspaceId });
    await waitFor(() => source.projectionRequests.length === 2, "replacement read");
    expect(source.projectionRequests[0]?.sourceGeneration).toBe(1);
    expect(source.projectionRequests[1]?.sourceGeneration).toBe(2);

    oldSource.resolve(successful(envelope(bundle({ revision: 9 }), 1)));
    await settle();
    expect(client.store.getSnapshot().projection.kind).toBe("loading");
    newSource.resolve(successful(envelope(bundle({ revision: 1 }), 2)));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "new source projection",
    );
    expect(client.store.getSnapshot().sourceGeneration).toBe(2);

    const currentGeneration = client.store.getSnapshot();
    source.emit({
      kind: "presentation.updated",
      presentation: presentation(2_000),
      presentationRevision: 2,
      sourceGeneration: 1,
      workspaceId,
    });
    source.emit({
      continuationRevision: 1,
      kind: "projection.patched",
      patches: [],
      projectionRevision: 2,
      sourceGeneration: 1,
      view: "all",
      workspaceId,
    });
    source.emit({
      kind: "projection.invalidated",
      minimumRevision: 10,
      sourceGeneration: 1,
      views: ["all"],
      workspaceId,
    });
    source.emit({
      kind: "source.replaced",
      sourceGeneration: 1,
      workspaceId,
    });
    expect(client.store.getSnapshot()).toBe(currentGeneration);
    expect(source.projectionRequests).toHaveLength(2);

    const beforeDispose = currentGeneration;
    client.dispose();
    client.dispose();
    source.emit({
      kind: "projection.invalidated",
      minimumRevision: 10,
      views: ["all"],
      workspaceId,
    });
    expect(client.store.getSnapshot()).toBe(beforeDispose);
    expect(source.unsubscribeCount).toBe(1);
  });

  test("rejects missing, malformed, and mismatched source generations", async () => {
    const source = new SourceHarness();
    const initial = source.nextProjection();
    const client = createClient(source);
    initial.resolve(successful(envelope(bundle({ revision: 1 }))));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "source generation validation root",
    );
    const stable = client.store.getSnapshot();

    source.emitUnchecked({
      kind: "presentation.updated",
      presentation: presentation(2_000),
      presentationRevision: 2,
      workspaceId,
    });
    expect(client.store.getSnapshot()).toBe(stable);
    source.emit({
      kind: "projection.invalidated",
      minimumRevision: 2,
      sourceGeneration: 0,
      views: ["all"],
      workspaceId,
    });
    expect(client.store.getSnapshot()).toBe(stable);
    source.emit({
      continuationRevision: 1,
      kind: "projection.patched",
      patches: [],
      projectionRevision: 2,
      sourceGeneration: 2,
      view: "all",
      workspaceId,
    });
    expect(client.store.getSnapshot()).toBe(stable);
    source.emit({
      kind: "source.replaced",
      sourceGeneration: Number.NaN,
      workspaceId,
    });
    expect(client.store.getSnapshot()).toBe(stable);
    expect(source.projectionRequests).toHaveLength(1);
    client.dispose();
  });

  test("retains an unknown mutation outcome across replacement projection install", async () => {
    const source = new SourceHarness();
    const initial = source.nextProjection();
    const mutation = source.nextMutation();
    const replacement = source.nextProjection();
    const client = createClient(source);
    initial.resolve(successful(envelope(bundle({ revision: 1 }))));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "initial projection",
    );

    const dispatch = client.dispatch(createTaskIntent());
    await waitFor(
      () => client.store.getSnapshot().pendingMutation?.phase === "dispatching",
      "dispatching mutation",
    );
    source.emit({ kind: "source.replaced", workspaceId });
    expect(client.store.getSnapshot().dispatchError).toEqual({
      code: "MUTATION_OUTCOME_UNKNOWN",
    });
    replacement.resolve(successful(envelope(bundle({ revision: 1 }), 2)));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "replacement projection",
    );
    expect(client.store.getSnapshot().dispatchError).toEqual({
      code: "MUTATION_OUTCOME_UNKNOWN",
    });

    expect(await dispatch).toEqual({
      error: { code: "MUTATION_OUTCOME_UNKNOWN" },
      ok: false,
    });
    mutation.resolve(successful(mutationResult(2)));
    await settle();
    expect(client.store.getSnapshot().dispatchError).toEqual({
      code: "MUTATION_OUTCOME_UNKNOWN",
    });
    client.dispose();
  });

  test("fences an ambiguous thrown mutation until an operator resolves it", async () => {
    const source = new SourceHarness();
    const initial = source.nextProjection();
    const mutation = source.nextMutation();
    const replacement = source.nextProjection();
    const client = createClient(source);
    initial.resolve(successful(envelope(bundle({ revision: 1 }))));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "initial projection",
    );

    const dispatch = client.dispatch(createTaskIntent());
    mutation.reject(new Error("response lost after write"));
    expect(await dispatch).toEqual({
      error: { code: "MUTATION_OUTCOME_UNKNOWN" },
      ok: false,
    });
    expect(client.store.getSnapshot().pendingMutation?.phase).toBe(
      "outcome_unknown",
    );
    expect(await client.dispatch(createTaskIntent())).toEqual({
      error: { code: "MUTATION_FENCED" },
      ok: false,
    });

    source.emit({ kind: "source.replaced", workspaceId });
    replacement.resolve(successful(envelope(bundle({ revision: 2 }), 2)));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "replacement projection",
    );
    expect(client.store.getSnapshot().pendingMutation?.phase).toBe(
      "outcome_unknown",
    );
    client.dispose();
  });

  test("treats a successful receipt below its mutation basis as ambiguous", async () => {
    const source = new SourceHarness();
    const initial = source.nextProjection();
    const mutation = source.nextMutation();
    const client = createClient(source);
    initial.resolve(successful(envelope(bundle({ revision: 5 }))));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "revision five projection",
    );

    const dispatch = client.dispatch(createTaskIntent());
    mutation.resolve(successful(mutationResult(4)));
    expect(await dispatch).toEqual({
      error: { code: "MUTATION_OUTCOME_UNKNOWN" },
      ok: false,
    });
    expect(client.store.getSnapshot().pendingMutation?.phase).toBe(
      "outcome_unknown",
    );
    client.dispose();
  });

  test("rejects cursor cycles and refreshes from root on a stale continuation", async () => {
    const source = new SourceHarness();
    const initial = source.nextProjection();
    const secondPage = source.nextContinuation();
    const cycle = source.nextContinuation();
    const replacement = source.nextProjection();
    const client = createClient(source);
    initial.resolve(successful(envelope(bundle({ cursor: "cursor-1", revision: 3 }))));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "initial paged projection",
    );

    const firstLoad = client.dispatch({ kind: "page.load_more" });
    secondPage.resolve(successful(page({
      cursor: "cursor-2",
      items: [listItem(2, 3)],
      revision: 3,
    })));
    expect(await firstLoad).toEqual({ ok: true, outcome: "accepted" });

    const secondLoad = client.dispatch({ kind: "page.load_more" });
    cycle.resolve(successful(page({
      cursor: "cursor-1",
      items: [listItem(3, 3)],
      revision: 3,
    })));
    expect(await secondLoad).toEqual({
      error: { code: "INVALID_CONTINUATION" },
      ok: false,
    });

    const stale = source.nextContinuation();
    const state = client.store.getSnapshot().projection;
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") throw new Error("projection must remain ready");
    const retry = client.dispatch({ kind: "page.load_more" });
    stale.resolve({ error: { code: "TASK_STATE_CONFLICT" }, ok: false });
    expect(await retry).toEqual({
      error: { code: "TASK_STATE_CONFLICT" },
      ok: false,
    });
    await waitFor(
      () => source.projectionRequests.length === 2,
      "root refresh after stale continuation",
    );
    expect(source.projectionRequests[1]?.sourceGeneration).toBe(2);
    replacement.resolve(successful(envelope(bundle({ revision: 4 }), 2)));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "ready",
      "replacement root projection",
    );
    client.dispose();
  });

  test("rejects non-exact consistency metadata and ignores hostile source events", async () => {
    const source = new SourceHarness();
    const invalid = source.nextProjection();
    const client = createClient(source);
    source.emit({
      kind: "projection.invalidated",
      minimumRevision: Number.NaN,
      views: ["all"],
      workspaceId,
    });
    source.emit({
      kind: "projection.invalidated",
      minimumRevision: 9,
      views: ["hostile"],
      workspaceId,
    } as unknown as TaskWorkspaceSourceEvent);
    expect(source.projectionRequests).toHaveLength(1);

    invalid.resolve(successful({
      consistency: {
        extra: "provider metadata",
        kind: "atomic",
        sourceGeneration: 1,
      },
      presentation: presentation(),
      presentationRevision: 1,
      projection: bundle({ revision: 1 }),
    } as unknown as TaskWorkspaceProjectionEnvelope));
    await waitFor(
      () => client.store.getSnapshot().projection.kind === "error",
      "invalid consistency rejection",
    );
    const projection = client.store.getSnapshot().projection;
    expect(projection.kind).toBe("error");
    if (projection.kind === "error") {
      expect(projection.error).toEqual({ code: "INVALID_PROJECTION" });
    }
    client.dispose();
  });

  test("routes invalidations only to each of the seven affected views", async () => {
    const views = [
      "all",
      "ready",
      "blocked",
      "deferred",
      "attention",
      "assigned",
      "review",
    ] as const satisfies readonly TaskWorkspaceView[];

    for (const view of views) {
      const source = new SourceHarness();
      const initial = source.nextProjection();
      const refresh = source.nextProjection();
      const client = createTaskWorkspaceClient({
        coordinate: { selectedTaskId: null, view, workspaceId },
        source,
      });
      client.start();
      initial.resolve(successful(envelope(bundle({ revision: 1, view }))));
      await waitFor(
        () => client.store.getSnapshot().projection.kind === "ready",
        `${view} initial projection`,
      );
      source.emit({
        kind: "projection.invalidated",
        minimumRevision: 2,
        views: views.filter((candidate) => candidate !== view),
        workspaceId,
      });
      await settle();
      expect(source.projectionRequests).toHaveLength(1);
      source.emit({
        kind: "projection.invalidated",
        minimumRevision: 2,
        views: [view],
        workspaceId,
      });
      await waitFor(
        () => source.projectionRequests.length === 2,
        `${view} invalidation`,
      );
      refresh.resolve(successful(envelope(bundle({ revision: 2, view }))));
      await waitFor(() => {
        const current = client.store.getSnapshot().projection;
        return current.kind === "ready" &&
          current.envelope.projection.projectionRevision === 2;
      }, `${view} refreshed projection`);
      client.dispose();
    }
  });
});
