import { createHmac } from "node:crypto";

import {
  createAttemptId,
  createMutationFingerprint,
  type MutationAttemptJournal,
} from "@hra-internal/codex-app-sdk";
import { createMemoryMutationAttemptJournal } from "@hra-internal/codex-app-sdk/testing";
import type { TaskWorkspaceView } from "@hraness/agent-tasks-domain";
import type {
  TaskWorkspaceEffectContext,
  TaskWorkspaceSourceEvent,
} from "@hraness/agent-tasks-ui";
import type { ConvexReactClient } from "convex/react";
import { describe, expect, test } from "bun:test";

import {
  HOSTED_TASK_MUTATION_SOURCE_ID,
  type HostedMutationAttemptJournal,
  type HostedMutationAttemptDefinition,
  type HostedMutationFingerprintResolver,
} from "./hosted-mutation-attempt-journal";
import { createHostedTaskWorkspaceSource } from "./hosted-task-workspace-source";

const WORKSPACE_ID = "wsp_00000000000000000000000001";
const TASK_ID = "tsk_00000000000000000000000001";
const RELATED_TASK_ID = "tsk_00000000000000000000000003";
const OPERATION_ID = "op_00000000000000000000000001";
const SUPPLIED_TASK_ID = "tsk_00000000000000000000000002";
const IDEMPOTENCY_KEY = "018f0f7d-8b4c-7000-8000-000000000001";
const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);
const TEST_FINGERPRINT_KEY = "hra-hosted-source-test-key";

const resolveTestHostedMutationFingerprint:
  HostedMutationFingerprintResolver = (clientFingerprint) => {
    const digest = createHmac("sha256", TEST_FINGERPRINT_KEY)
      .update(clientFingerprint)
      .digest("base64url");
    return Promise.resolve(
      createMutationFingerprint(`hmac_sha256_${digest}`),
    );
  };

function withTestFingerprintResolver(
  journal: MutationAttemptJournal<HostedMutationAttemptDefinition>,
  resolveFingerprint:
    HostedMutationFingerprintResolver = resolveTestHostedMutationFingerprint,
): HostedMutationAttemptJournal {
  return Object.freeze({
    ...journal,
    resolveFingerprint,
  });
}

function createReceiptPresentMutationJournal():
  MutationAttemptJournal<HostedMutationAttemptDefinition> {
  const durable =
    createMemoryMutationAttemptJournal<HostedMutationAttemptDefinition>();
  return Object.freeze({
    ...durable,
    settle: async (
      settlement: Parameters<typeof durable.settle>[0],
    ) => {
      const current = await durable.get(settlement.attemptId);
      if (
        settlement.outcome.status === "cancelled" &&
        current?.state === "effect-started"
      ) {
        return { status: "invalid-transition" as const, current };
      }
      return durable.settle(settlement);
    },
  });
}

const COUNTS = {
  all: { capped: false, value: 1 },
  assigned: { capped: false, value: 0 },
  attention: { capped: false, value: 0 },
  blocked: { capped: false, value: 0 },
  deferred: { capped: false, value: 0 },
  ready: { capped: false, value: 1 },
  review: { capped: false, value: 0 },
} as const;

function task(
  revision = 1,
  id = TASK_ID,
  key = id === TASK_ID ? "OP-0000001" : "OP-0000003",
) {
  return {
    id,
    key,
    title: "Keep the hosted source atomic",
    type: "task" as const,
    priority: 1,
    availableAt: NOW - 1_000,
    isReady: true,
    unresolvedBlockerCount: 0,
    cancelledBlockerCount: 0,
    revision,
    reviewRevision: 1,
    status: "open" as const,
    createdAt: NOW - 2_000,
    updatedAt: NOW - 1_000 + revision,
  };
}

function rootResult(
  revision: number,
  options: Readonly<{
    continuationRevision?: number;
    extraData?: Readonly<Record<string, unknown>>;
    expiresAt?: number;
    observedAt?: number;
    runnerLeaseUntil?: number;
    runnerServerTime?: number;
    selected?: unknown;
    selectedTaskId?: string;
    tasks?: readonly unknown[];
    token?: string;
    view?: TaskWorkspaceView;
    assignedAgentId?: string;
  }> = {},
) {
  const view = options.view ?? "all";
  const continuationRevision = options.continuationRevision ?? revision;
  return {
    ok: true as const,
    data: {
      source: {
        kind: "hosted" as const,
        token: options.token ??
          `source-token-${String(continuationRevision)}-${view}`,
        workspaceId: WORKSPACE_ID,
        projectionRevision: revision,
        continuationRevision,
        view,
        ...(options.assignedAgentId === undefined
          ? {}
          : { assignedAgentId: options.assignedAgentId }),
        classifiedAt: NOW,
        expiresAt: options.expiresAt ?? NOW + 300_000,
        ...(options.selectedTaskId === undefined
          ? {}
          : { selectedTaskId: options.selectedTaskId }),
      },
      context: {
        observedAt: options.observedAt ?? NOW,
        workspace: {
          now: NOW,
          workspace: {
            id: WORKSPACE_ID,
            name: "HRA",
            slug: "hra",
            taskKeyPrefix: "OP",
          },
          viewer: {
            id: "usr_00000000000000000000000001",
            name: "Ada",
            organizationRole: "owner" as const,
            workspaceRoles: ["planner", "reviewer", "viewer"] as const,
          },
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
          agents: {
            items: [{ id: "agt_worker", name: "Worker", status: "active" as const }],
            capped: false,
          },
        },
        readiness: {
          presence: {
            state: "ready" as const,
            serverTime: options.runnerServerTime ?? NOW,
            leaseUntil: options.runnerLeaseUntil ?? NOW + 45_000,
            availableCapacity: 1,
          },
          repositories: [{
            id: "repo_00000000000000000000000001",
            name: "hra",
            ready: true,
          }],
        },
      },
      page: {
        workspaceId: WORKSPACE_ID,
        projectionRevision: revision,
        continuationRevision,
        view,
        ...(options.assignedAgentId === undefined
          ? {}
          : { assignedAgentId: options.assignedAgentId }),
        data: {
          now: NOW,
          view,
          tasks: options.tasks ?? [],
          cursor: "next-page-token",
          counts: COUNTS,
        },
      },
      selected: options.selected ?? null,
      ...options.extraData,
    },
    requestId: "req_00000000000000000000000001",
  };
}

function continuationResult(
  revision: number,
  continuationRevision = revision,
  token?: string,
  options: Readonly<{
    cursor?: string | null;
    tasks?: readonly unknown[];
  }> = {},
) {
  const root = rootResult(revision, {
    continuationRevision,
    ...(token === undefined ? {} : { token }),
  });
  const { counts, ...pageData } = root.data.page.data;
  void counts;
  return {
    ok: true as const,
    data: {
      source: root.data.source,
      page: {
        ...root.data.page,
        data: {
          ...pageData,
          cursor: options.cursor ?? null,
          tasks: options.tasks ?? pageData.tasks,
        },
      },
    },
    requestId: root.requestId,
  };
}

function headsResult(
  projectionRevision: number,
  continuationRevision = projectionRevision,
  view: TaskWorkspaceView = "all",
  overrides: Partial<Record<
    "all" | "ready" | "blocked" | "deferred" | "attention" | "assigned" | "review",
    number
  >> = {},
) {
  const taskViewRevisions = {
    all: continuationRevision,
    ready: continuationRevision,
    blocked: continuationRevision,
    deferred: continuationRevision,
    attention: continuationRevision,
    assigned: continuationRevision,
    review: continuationRevision,
    ...overrides,
  };
  return {
    ok: true as const,
    data: {
      workspaceId: WORKSPACE_ID,
      view,
      projectionRevision,
      continuationRevision,
      taskViewRevisions,
    },
    requestId: "req_00000000000000000000000001",
  };
}

function presentationResult(
  options: Readonly<{
    name?: string;
    observedAt?: number;
    runnerLeaseUntil?: number;
    runnerServerTime?: number;
  }> = {},
) {
  const root = rootResult(1, {
    ...(options.observedAt === undefined
      ? {}
      : { observedAt: options.observedAt }),
    ...(options.runnerLeaseUntil === undefined
      ? {}
      : { runnerLeaseUntil: options.runnerLeaseUntil }),
    ...(options.runnerServerTime === undefined
      ? {}
      : { runnerServerTime: options.runnerServerTime }),
  });
  return {
    ok: true as const,
    data: {
      ...root.data.context,
      workspace: {
        ...root.data.context.workspace,
        now: options.observedAt ?? root.data.context.workspace.now,
        viewer: {
          ...root.data.context.workspace.viewer,
          name: options.name ?? root.data.context.workspace.viewer.name,
        },
      },
    },
    requestId: root.requestId,
  };
}

const ALL_VIEW_REVISIONS = {
  all: 1,
  ready: 1,
  blocked: 1,
  deferred: 1,
  attention: 1,
  assigned: 1,
  review: 1,
} as const;

type ViewRevisions = Readonly<Record<keyof typeof ALL_VIEW_REVISIONS, number>>;

function changesResult(
  fromRevision: number,
  projectionRevision: number,
  changes: readonly unknown[],
  options: Readonly<{
    hasMore?: boolean;
    resetRequired?: boolean;
    taskViewRevisions?: ViewRevisions;
    throughRevision?: number;
  }> = {},
) {
  return {
    ok: true as const,
    data: {
      workspaceId: WORKSPACE_ID,
      fromRevision,
      throughRevision: options.throughRevision ?? projectionRevision,
      projectionRevision,
      taskViewRevisions: options.taskViewRevisions ?? ALL_VIEW_REVISIONS,
      changes,
      hasMore: options.hasMore ?? false,
      resetRequired: options.resetRequired ?? false,
    },
    requestId: "req_00000000000000000000000002",
  };
}

function taskChange(
  projectionRevision: number,
  taskId = TASK_ID,
  options: Readonly<{
    scope?: "task" | "run";
    structure?: boolean;
    views?: readonly TaskWorkspaceView[];
  }> = {},
) {
  const scope = options.scope ?? "task";
  return {
    projectionRevision,
    scope,
    taskId,
    ...(scope === "run"
      ? { runId: "run_00000000000000000000000000" }
      : {}),
    views: options.views ?? ["all"],
    structure: options.structure ?? false,
    createdAt: NOW + projectionRevision,
  };
}

function taskPatchResult(
  projectionRevision: number,
  changedTask: ReturnType<typeof task>,
  options: Readonly<{
    continuationRevision?: number;
    membership?: "absent" | "present";
    view?: TaskWorkspaceView;
  }> = {},
) {
  return {
    ok: true as const,
    data: {
      now: NOW,
      view: options.view ?? "all",
      taskId: changedTask.id,
      projectionRevision,
      continuationRevision: options.continuationRevision ?? 1,
      membership: options.membership === "absent"
        ? { kind: "absent" as const }
        : {
            kind: "present" as const,
            item: { task: changedTask, humanInput: null, run: null },
          },
    },
    requestId: "req_00000000000000000000000003",
  };
}

class FakeWatch {
  value: unknown;
  readonly listeners = new Set<() => void>();
  throwOnSubscribe = false;
  unsubscribeCount = 0;

  localQueryResult(): unknown {
    if (this.value instanceof Error) throw this.value;
    return this.value;
  }

  onUpdate(listener: () => void): () => void {
    if (this.throwOnSubscribe) throw new Error("watch subscription failed");
    this.listeners.add(listener);
    return () => {
      if (!this.listeners.delete(listener)) return;
      this.unsubscribeCount += 1;
    };
  }

  update(value: unknown): void {
    this.value = value;
    for (const listener of [...this.listeners]) listener();
  }
}

class FakeConvexClient {
  readonly watches: FakeWatch[] = [];
  readonly watchArgs: unknown[] = [];
  readonly queryArgs: unknown[] = [];
  readonly queryReferences: unknown[] = [];
  readonly mutationArgs: unknown[] = [];
  queryResults: unknown[] = [];
  mutationResults: unknown[] = [];
  throwOnWatchCall: number | null = null;
  throwOnWatchSubscribeCall: number | null = null;

  watchQuery(_reference: unknown, args: unknown): FakeWatch {
    const call = this.watchArgs.length + 1;
    if (this.throwOnWatchCall === call) {
      this.throwOnWatchCall = null;
      throw new Error("watch creation failed");
    }
    const watch = new FakeWatch();
    watch.throwOnSubscribe = this.throwOnWatchSubscribeCall === call;
    if (watch.throwOnSubscribe) this.throwOnWatchSubscribeCall = null;
    this.watches.push(watch);
    this.watchArgs.push(args);
    return watch;
  }

  query(reference: unknown, args: unknown): Promise<unknown> {
    this.queryReferences.push(reference);
    this.queryArgs.push(args);
    const result = this.queryResults.shift();
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve(result);
  }

  mutation(_reference: unknown, args: unknown): Promise<unknown> {
    this.mutationArgs.push(args);
    const result = this.mutationResults.shift();
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve(result);
  }
}

function deferred<Value>() {
  let resolve: (value: Value) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  attempts = 100,
): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function source(
  client: FakeConvexClient,
  options: Readonly<{
    idempotencyKey?: () => string;
    fingerprintResolver?: HostedMutationFingerprintResolver;
    monotonicNow?: () => number;
    mutationJournal?: MutationAttemptJournal<HostedMutationAttemptDefinition>;
    operationId?: () => string;
    readTimeoutMs?: number;
    taskId?: () => string;
    wallNow?: () => number;
  }> = {},
) {
  const hosted = createHostedTaskWorkspaceSource({
    client: client as unknown as ConvexReactClient,
    idempotencyKey: options.idempotencyKey ?? (() => IDEMPOTENCY_KEY),
    monotonicNow: options.monotonicNow ?? (() => 0),
    mutationJournal: withTestFingerprintResolver(
      options.mutationJournal ??
        createMemoryMutationAttemptJournal<HostedMutationAttemptDefinition>(),
      options.fingerprintResolver,
    ),
    operationId: options.operationId ?? (() => OPERATION_ID),
    readTimeoutMs: options.readTimeoutMs ?? 1_000,
    taskId: options.taskId ?? (() => SUPPLIED_TASK_ID),
    wallNow: options.wallNow ?? (() => NOW),
    workspaceId: WORKSPACE_ID,
  });
  const defaultContext = (): TaskWorkspaceEffectContext => ({
    deadlineMonotonicMs: Number.MAX_SAFE_INTEGER,
    signal: new AbortController().signal,
  });
  return Object.freeze({
    acknowledgeMutation: (
      result: Parameters<typeof hosted.acknowledgeMutation>[0],
      context: TaskWorkspaceEffectContext = defaultContext(),
    ) => hosted.acknowledgeMutation(result, context),
    acknowledgeProjection: (
      envelope: Parameters<typeof hosted.acknowledgeProjection>[0],
      context: TaskWorkspaceEffectContext = defaultContext(),
    ) => hosted.acknowledgeProjection(envelope, context),
    dispose: hosted.dispose,
    execute: (
      request: Parameters<typeof hosted.execute>[0],
      context: TaskWorkspaceEffectContext = defaultContext(),
    ) => hosted.execute(request, context),
    readContinuation: (
      request: Parameters<typeof hosted.readContinuation>[0],
      context: TaskWorkspaceEffectContext = defaultContext(),
    ) => hosted.readContinuation(request, context),
    readProjection: (
      request: Parameters<typeof hosted.readProjection>[0],
      context: TaskWorkspaceEffectContext = defaultContext(),
    ) => hosted.readProjection(request, context),
    subscribe: hosted.subscribe,
  });
}

const coordinate = {
  selectedTaskId: null,
  view: "all" as const,
  workspaceId: WORKSPACE_ID,
};

describe("hosted task workspace source", () => {
  test("requires an explicit hosted mutation fingerprint resolver", () => {
    const client = new FakeConvexClient();
    const mutationJournal =
      createMemoryMutationAttemptJournal<HostedMutationAttemptDefinition>();

    expect(() =>
      createHostedTaskWorkspaceSource({
        client: client as unknown as ConvexReactClient,
        mutationJournal:
          mutationJournal as unknown as HostedMutationAttemptJournal,
        workspaceId: WORKSPACE_ID,
      })
    ).toThrow(
      "Hosted task sources require an opaque mutation fingerprint resolver.",
    );
  });

  test("rejects a resolver that returns the raw browser fingerprint", async () => {
    const client = new FakeConvexClient();
    const mutationJournal =
      createMemoryMutationAttemptJournal<HostedMutationAttemptDefinition>();
    const hosted = source(client, {
      fingerprintResolver: (clientFingerprint) =>
        Promise.resolve(clientFingerprint),
      mutationJournal,
    });
    hosted.subscribe(() => undefined);
    client.queryResults.push(rootResult(1, {
      tasks: [{ task: task(), humanInput: null, run: null }],
    }));
    const initial = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    client.watches[0]?.update(headsResult(1));
    expect((await initial).ok).toBeTrue();

    expect(await hosted.execute({
      basis: { coordinate, projectionRevision: 1, sourceGeneration: 1 },
      intent: {
        kind: "task.comment_add",
        taskId: TASK_ID,
        body: "Never persist the browser fingerprint.",
      },
    })).toEqual({
      error: { code: "INVALID_PROJECTION" },
      ok: false,
    });
    expect(await mutationJournal.listOpen({
      sourceId: HOSTED_TASK_MUTATION_SOURCE_ID,
      after: null,
      limit: 50,
    })).toEqual({
      attempts: [],
      hasMore: false,
      nextCursor: null,
    });
    expect(client.mutationArgs).toHaveLength(0);
    hosted.dispose();
  });

  test("coalesces concurrent root reads behind one serialized query", async () => {
    const client = new FakeConvexClient();
    const hosted = source(client);
    hosted.subscribe(() => undefined);
    const pendingRoot = deferred<unknown>();
    client.queryResults.push(pendingRoot.promise);

    const first = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    const second = hosted.readProjection({
      coordinate,
      minimumRevision: 1,
      sourceGeneration: 1,
    });
    client.watches[0]?.update(headsResult(1));
    await Promise.resolve();
    await Promise.resolve();
    expect(client.queryArgs).toHaveLength(1);

    pendingRoot.resolve(rootResult(1));
    expect((await first).ok).toBeTrue();
    expect((await second).ok).toBeTrue();
    expect(client.queryArgs).toHaveLength(1);
    hosted.dispose();
  });

  test("keeps one heads and one presentation watch per coordinate", async () => {
    const client = new FakeConvexClient();
    const hosted = source(client);
    const unsubscribe = hosted.subscribe(() => undefined);

    client.queryResults.push(rootResult(1));
    const first = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    expect(client.watches).toHaveLength(2);
    client.watches[0]?.update(headsResult(1));
    expect(await first).toMatchObject({
      ok: true,
      value: {
        consistency: { kind: "atomic", sourceGeneration: 1 },
        projection: { projectionRevision: 1 },
      },
    });

    expect((await hosted.readProjection({
      coordinate,
      minimumRevision: 1,
      sourceGeneration: 1,
    })).ok).toBeTrue();
    expect(client.watches).toHaveLength(2);

    const readyCoordinate = { ...coordinate, view: "ready" as const };
    client.queryResults.push(rootResult(2, { view: "ready" }));
    const second = hosted.readProjection({
      coordinate: readyCoordinate,
      minimumRevision: null,
      sourceGeneration: 2,
    });
    expect(client.watches).toHaveLength(4);
    expect(client.watches[0]?.unsubscribeCount).toBe(1);
    expect(client.watches[1]?.unsubscribeCount).toBe(1);
    client.watches[2]?.update(headsResult(2, 2, "ready"));
    expect(await second).toMatchObject({
      ok: true,
      value: { consistency: { sourceGeneration: 2 } },
    });

    unsubscribe();
    expect(client.watches[2]?.unsubscribeCount).toBe(1);
    expect(client.watches[3]?.unsubscribeCount).toBe(1);
    expect(client.watchArgs).toEqual([
      { workspaceId: WORKSPACE_ID, view: "all" },
      { workspaceId: WORKSPACE_ID },
      { workspaceId: WORKSPACE_ID, view: "ready" },
      { workspaceId: WORKSPACE_ID },
    ]);
  });

  test("rolls back partial watch subscription and retries from a clean root", async () => {
    const client = new FakeConvexClient();
    const hosted = source(client);
    hosted.subscribe(() => undefined);

    client.throwOnWatchSubscribeCall = 2;
    expect(await hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    })).toEqual({
      error: { code: "SERVICE_UNAVAILABLE" },
      ok: false,
    });
    expect(client.watches[0]?.unsubscribeCount).toBe(1);
    expect(client.watches[0]?.listeners.size).toBe(0);

    client.queryResults.push(rootResult(1));
    const recovered = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    client.watches.at(-2)?.update(headsResult(1));
    expect((await recovered).ok).toBeTrue();
    hosted.dispose();
  });

  test("contains a watch creation failure without retaining an active root", async () => {
    const client = new FakeConvexClient();
    const hosted = source(client);
    hosted.subscribe(() => undefined);

    client.throwOnWatchCall = 2;
    expect(await hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    })).toEqual({
      error: { code: "SERVICE_UNAVAILABLE" },
      ok: false,
    });

    client.queryResults.push(rootResult(1));
    const recovered = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    client.watches.at(-2)?.update(headsResult(1));
    expect((await recovered).ok).toBeTrue();
    hosted.dispose();
  });

  test("embeds presentation in the atomic root and publishes later context atomically", async () => {
    const client = new FakeConvexClient();
    const hosted = source(client);
    const events: TaskWorkspaceSourceEvent[] = [];
    hosted.subscribe((event) => events.push(event));
    client.queryResults.push(rootResult(1));
    const initial = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    client.watches[0]?.update(headsResult(1));
    expect(await initial).toMatchObject({
      ok: true,
      value: {
        presentation: {
          workspace: { id: WORKSPACE_ID, keyPrefix: "OP" },
          viewer: { kind: "human", name: "Ada" },
          counts: { all: { value: 1 } },
          runner: { repositories: [{ name: "hra", ready: true }] },
        },
        presentationRevision: 1,
        projection: { projectionRevision: 1 },
      },
    });

    client.watches[1]?.update(presentationResult({
      name: "Grace",
      observedAt: NOW + 1_000,
      runnerServerTime: NOW + 1_000,
      runnerLeaseUntil: NOW + 46_000,
    }));
    expect(events).toEqual([{
      kind: "presentation.updated",
      presentation: expect.objectContaining({
        viewer: expect.objectContaining({ name: "Grace" }),
      }),
      presentationRevision: 2,
      sourceGeneration: 1,
      workspaceId: WORKSPACE_ID,
    }]);
    hosted.dispose();
  });

  test("pins one source token while display revisions advance", async () => {
    const client = new FakeConvexClient();
    const hosted = source(client);
    const events: TaskWorkspaceSourceEvent[] = [];
    hosted.subscribe((event) => events.push(event));
    client.queryResults.push(rootResult(1, {
      continuationRevision: 1,
      tasks: [{ task: task(), humanInput: null, run: null }],
    }));
    const initial = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    client.watches[0]?.update(headsResult(1, 1));
    expect((await initial).ok).toBeTrue();

    client.queryResults.push(changesResult(1, 2, [
      taskChange(2, RELATED_TASK_ID, { scope: "run" }),
    ]));
    client.watches[0]?.update(headsResult(2, 1));
    await flushMicrotasks();
    expect(events).toEqual([{
      kind: "projection.patched",
      continuationRevision: 1,
      patches: [],
      projectionRevision: 2,
      sourceGeneration: 1,
      view: "all",
      workspaceId: WORKSPACE_ID,
    }]);
    const refreshed = await hosted.readProjection({
      coordinate,
      minimumRevision: 2,
      sourceGeneration: 1,
    });
    expect(refreshed).toMatchObject({
      ok: true,
      value: {
        projection: { continuationRevision: 1, projectionRevision: 2 },
      },
    });
    expect(client.queryArgs[1]).toEqual({
      workspaceId: WORKSPACE_ID,
      afterRevision: 1,
      limit: 50,
    });

    client.queryResults.push(continuationResult(
      2,
      1,
      "source-token-1-all",
    ));
    expect(await hosted.readContinuation({
      coordinate,
      continuationRevision: 1,
      cursor: "next-page-token",
      projectionRevision: 2,
      sourceGeneration: 1,
    })).toMatchObject({ ok: true, value: { projectionRevision: 2 } });
    expect(client.queryArgs[2]).toMatchObject({
      sourceToken: "source-token-1-all",
    });
    hosted.dispose();
  });

  test("emits task patches with the exact assigned-agent filter", async () => {
    const client = new FakeConvexClient();
    const hosted = source(client);
    const events: TaskWorkspaceSourceEvent[] = [];
    const assignedAgentId = "agt_worker";
    const assignedCoordinate = {
      assignedAgentId,
      selectedTaskId: null,
      view: "assigned" as const,
      workspaceId: WORKSPACE_ID,
    };
    hosted.subscribe((event) => events.push(event));
    client.queryResults.push(rootResult(1, {
      assignedAgentId,
      tasks: [{ task: task(), humanInput: null, run: null }],
      view: "assigned",
    }));
    const initial = hosted.readProjection({
      coordinate: assignedCoordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    client.watches[0]?.update(headsResult(1, 1, "assigned"));
    expect((await initial).ok).toBeTrue();

    client.queryResults.push(
      changesResult(1, 2, [
        taskChange(2, TASK_ID, { views: ["assigned"] }),
      ]),
      taskPatchResult(2, task(2), { view: "assigned" }),
    );
    client.watches[0]?.update(headsResult(2, 1, "assigned"));
    await flushMicrotasks();

    expect(events).toEqual([{
      assignedAgentId,
      continuationRevision: 1,
      kind: "projection.patched",
      patches: [{
        item: { humanInput: null, run: null, task: task(2) },
        taskId: TASK_ID,
      }],
      projectionRevision: 2,
      sourceGeneration: 1,
      view: "assigned",
      workspaceId: WORKSPACE_ID,
    }]);
    expect(client.watchArgs[0]).toEqual({
      view: "assigned",
      workspaceId: WORKSPACE_ID,
    });
    expect(client.queryArgs.at(-1)).toMatchObject({
      assignedAgentId,
      taskId: TASK_ID,
      view: "assigned",
    });
    hosted.dispose();
  });

  test("turns same-continuation token rollover into a source generation fence", async () => {
    const client = new FakeConvexClient();
    const hosted = source(client);
    const events: TaskWorkspaceSourceEvent[] = [];
    hosted.subscribe((event) => events.push(event));
    client.queryResults.push(rootResult(1, {
      continuationRevision: 1,
      token: "source-token-a",
    }));
    const initial = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    client.watches[0]?.update(headsResult(1, 1));
    expect((await initial).ok).toBeTrue();

    client.watches[0]?.update(headsResult(2, 1));
    client.queryResults.push(rootResult(2, {
      continuationRevision: 1,
      token: "source-token-b",
    }));
    expect(await hosted.readProjection({
      coordinate,
      minimumRevision: 2,
      sourceGeneration: 1,
    })).toEqual({ error: { code: "SOURCE_REPLACED" }, ok: false });
    expect(events.at(-1)).toEqual({
      kind: "source.replaced",
      minimumRevision: 2,
      sourceGeneration: 1,
      workspaceId: WORKSPACE_ID,
    });
    hosted.dispose();
  });

  test("rejects every cached-token operation at the renewal boundary", async () => {
    const client = new FakeConvexClient();
    let monotonicTime = 100;
    const hosted = source(client, { monotonicNow: () => monotonicTime });
    const events: TaskWorkspaceSourceEvent[] = [];
    hosted.subscribe((event) => events.push(event));
    client.queryResults.push(rootResult(1, {
      tasks: [{ task: task(), humanInput: null, run: null }],
    }));
    const initial = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    client.watches[0]?.update(headsResult(1));
    expect((await initial).ok).toBeTrue();

    monotonicTime += 270_000;
    expect(await hosted.readProjection({
      coordinate,
      minimumRevision: 1,
      sourceGeneration: 1,
    })).toEqual({ error: { code: "SOURCE_REPLACED" }, ok: false });
    expect(await hosted.readContinuation({
      coordinate,
      continuationRevision: 1,
      cursor: "next-page-token",
      projectionRevision: 1,
      sourceGeneration: 1,
    })).toEqual({ error: { code: "SOURCE_REPLACED" }, ok: false });
    expect(await hosted.execute({
      basis: { coordinate, projectionRevision: 1, sourceGeneration: 1 },
      intent: {
        kind: "task.comment_add",
        taskId: TASK_ID,
        body: "Do not dispatch with an expiring token.",
      },
    })).toEqual({ error: { code: "SOURCE_REPLACED" }, ok: false });
    expect(client.queryArgs).toHaveLength(1);
    expect(client.mutationArgs).toHaveLength(0);
    expect(events).toEqual([{
      kind: "source.replaced",
      minimumRevision: 1,
      sourceGeneration: 1,
      workspaceId: WORKSPACE_ID,
    }]);
    hosted.dispose();
  });

  test("uses one-shot continuation queries without adding a watch", async () => {
    const client = new FakeConvexClient();
    const hosted = source(client);
    hosted.subscribe(() => undefined);
    client.queryResults.push(rootResult(4));
    const initial = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    client.watches[0]?.update(headsResult(4));
    await initial;
    client.queryResults.push(continuationResult(4));

    const continuation = await hosted.readContinuation({
      coordinate,
      continuationRevision: 4,
      cursor: "next-page-token",
      projectionRevision: 4,
      sourceGeneration: 1,
    });
    expect(continuation).toMatchObject({
      ok: true,
      value: { cursor: null, hasMore: false, projectionRevision: 4 },
    });
    expect(client.watches).toHaveLength(2);
    expect(client.queryArgs[1]).toEqual({
      workspaceId: WORKSPACE_ID,
      sourceToken: "source-token-4-all",
      cursor: "next-page-token",
      limit: 50,
    });
  });

  test("rejects an inexact atomic root instead of publishing partial data", async () => {
    const client = new FakeConvexClient();
    const hosted = source(client);
    hosted.subscribe(() => undefined);
    client.queryResults.push(rootResult(1, { extraData: { hostile: true } }));
    const read = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    expect(await read).toEqual({
      error: { code: "INVALID_PROJECTION" },
      ok: false,
    });
    hosted.dispose();
  });

  test("replaces a failed source generation and installs fresh paired watches", async () => {
    const client = new FakeConvexClient();
    const hosted = source(client);
    const events: TaskWorkspaceSourceEvent[] = [];
    hosted.subscribe((event) => events.push(event));
    client.queryResults.push({ hostile: true });
    const failed = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    expect((await failed).ok).toBeFalse();

    client.queryResults.push(rootResult(1));
    const retried = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 2,
    });
    expect(client.watches).toHaveLength(4);
    expect(client.watches[0]?.unsubscribeCount).toBe(1);
    expect(client.watches[1]?.unsubscribeCount).toBe(1);
    client.watches[2]?.update(headsResult(1));
    expect((await retried).ok).toBeTrue();
    expect(events).toEqual([]);
    hosted.dispose();
  });

  test("drains a newer feed head that arrives while a task patch is in flight", async () => {
    const client = new FakeConvexClient();
    const hosted = source(client);
    const events: TaskWorkspaceSourceEvent[] = [];
    hosted.subscribe((event) => events.push(event));
    client.queryResults.push(rootResult(1, {
      tasks: [{ task: task(), humanInput: null, run: null }],
    }));
    const initial = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    client.watches[0]?.update(headsResult(1));
    expect((await initial).ok).toBeTrue();

    const pendingPatch = deferred<unknown>();
    client.queryResults.push(
      changesResult(1, 2, [taskChange(2)]),
      pendingPatch.promise,
    );
    client.watches[0]?.update(headsResult(2, 1));
    await flushMicrotasks();
    expect(client.queryArgs).toHaveLength(3);
    expect(client.queryArgs[2]).toMatchObject({ expectedProjectionRevision: 2 });

    client.queryResults.push(
      changesResult(2, 3, [taskChange(3)]),
      taskPatchResult(3, task(3)),
    );
    client.watches[0]?.update(headsResult(3, 1));
    pendingPatch.resolve(taskPatchResult(2, task(2)));
    await flushMicrotasks(30);

    expect(events).toEqual([
      {
        kind: "projection.patched",
        continuationRevision: 1,
        patches: [{ taskId: TASK_ID, item: {
          task: task(2), humanInput: null, run: null,
        } }],
        projectionRevision: 2,
        sourceGeneration: 1,
        view: "all",
        workspaceId: WORKSPACE_ID,
      },
      {
        kind: "projection.patched",
        continuationRevision: 1,
        patches: [{ taskId: TASK_ID, item: {
          task: task(3), humanInput: null, run: null,
        } }],
        projectionRevision: 3,
        sourceGeneration: 1,
        view: "all",
        workspaceId: WORKSPACE_ID,
      },
    ]);
    expect(client.queryArgs).toHaveLength(5);
    expect(client.queryArgs[2]).toMatchObject({
      expectedProjectionRevision: 2,
    });
    expect(client.queryArgs[4]).toMatchObject({
      expectedProjectionRevision: 3,
    });
    hosted.dispose();
  });

  test("patches an item loaded on a continuation page without replacing pagination", async () => {
    const client = new FakeConvexClient();
    const hosted = source(client);
    const events: TaskWorkspaceSourceEvent[] = [];
    hosted.subscribe((event) => events.push(event));
    client.queryResults.push(rootResult(1, {
      tasks: [{ task: task(), humanInput: null, run: null }],
    }));
    const initial = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    client.watches[0]?.update(headsResult(1));
    expect((await initial).ok).toBeTrue();

    client.queryResults.push(continuationResult(1, 1, undefined, {
      tasks: [{
        task: task(1, RELATED_TASK_ID),
        humanInput: null,
        run: null,
      }],
    }));
    expect((await hosted.readContinuation({
      coordinate,
      continuationRevision: 1,
      cursor: "next-page-token",
      projectionRevision: 1,
      sourceGeneration: 1,
    })).ok).toBeTrue();

    client.queryResults.push(
      changesResult(1, 2, [taskChange(2, RELATED_TASK_ID)]),
      taskPatchResult(2, task(2, RELATED_TASK_ID)),
    );
    client.watches[0]?.update(headsResult(2, 1));
    await flushMicrotasks();
    expect(events).toEqual([{
      kind: "projection.patched",
      continuationRevision: 1,
      patches: [{
        taskId: RELATED_TASK_ID,
        item: {
          task: task(2, RELATED_TASK_ID),
          humanInput: null,
          run: null,
        },
      }],
      projectionRevision: 2,
      sourceGeneration: 1,
      view: "all",
      workspaceId: WORKSPACE_ID,
    }]);
    expect(client.queryArgs.at(-1)).toMatchObject({
      taskId: RELATED_TASK_ID,
      expectedProjectionRevision: 2,
    });
    hosted.dispose();
  });

  test("publishes multiple loaded-task patches as one atomic revision event", async () => {
    const client = new FakeConvexClient();
    const hosted = source(client);
    const events: TaskWorkspaceSourceEvent[] = [];
    hosted.subscribe((event) => events.push(event));
    client.queryResults.push(rootResult(1, {
      tasks: [
        { task: task(), humanInput: null, run: null },
        { task: task(1, RELATED_TASK_ID), humanInput: null, run: null },
      ],
    }));
    const initial = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    client.watches[0]?.update(headsResult(1));
    expect((await initial).ok).toBeTrue();

    client.queryResults.push(
      changesResult(1, 3, [taskChange(2), taskChange(3, RELATED_TASK_ID)]),
      taskPatchResult(3, task(2)),
      taskPatchResult(3, task(2, RELATED_TASK_ID)),
    );
    client.watches[0]?.update(headsResult(3, 1));
    await flushMicrotasks(24);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "projection.patched",
      continuationRevision: 1,
      projectionRevision: 3,
      patches: [
        { taskId: TASK_ID, item: { task: { revision: 2 } } },
        { taskId: RELATED_TASK_ID, item: { task: { revision: 2 } } },
      ],
    });
    expect(client.queryArgs.slice(-2)).toEqual([
      expect.objectContaining({
        taskId: TASK_ID,
        expectedProjectionRevision: 3,
      }),
      expect.objectContaining({
        taskId: RELATED_TASK_ID,
        expectedProjectionRevision: 3,
      }),
    ]);
    hosted.dispose();
  });

  test("invalidates conservatively for a structural change without a continuation claim", async () => {
    const client = new FakeConvexClient();
    const hosted = source(client);
    const events: TaskWorkspaceSourceEvent[] = [];
    hosted.subscribe((event) => events.push(event));
    client.queryResults.push(rootResult(1));
    const initial = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    client.watches[0]?.update(headsResult(1));
    expect((await initial).ok).toBeTrue();

    client.queryResults.push(changesResult(1, 2, [
      taskChange(2, TASK_ID, { structure: true }),
    ], {
      taskViewRevisions: {
        ...ALL_VIEW_REVISIONS,
        all: 2,
      },
    }));
    client.watches[0]?.update(headsResult(2, 2, "all", { all: 2 }));
    await flushMicrotasks();
    expect(events).toEqual([{
      kind: "projection.invalidated",
      minimumRevision: 2,
      sourceGeneration: 1,
      views: ["all"],
      workspaceId: WORKSPACE_ID,
    }]);
    expect(events[0]).not.toHaveProperty("continuationRevision");
    hosted.dispose();
  });

  test("invalidates conservatively when a feed page has a revision gap", async () => {
    const client = new FakeConvexClient();
    const hosted = source(client);
    const events: TaskWorkspaceSourceEvent[] = [];
    hosted.subscribe((event) => events.push(event));
    client.queryResults.push(rootResult(1));
    const initial = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    client.watches[0]?.update(headsResult(1));
    expect((await initial).ok).toBeTrue();

    client.queryResults.push(changesResult(1, 3, [taskChange(3)]));
    client.watches[0]?.update(headsResult(3, 1));
    await flushMicrotasks();
    expect(events).toEqual([{
      kind: "projection.invalidated",
      minimumRevision: 3,
      sourceGeneration: 1,
      views: ["all"],
      workspaceId: WORKSPACE_ID,
    }]);
    expect(events[0]).not.toHaveProperty("continuationRevision");
    hosted.dispose();
  });

  test("uses a newer presentation watch value when an older root arrives later", async () => {
    const client = new FakeConvexClient();
    const hosted = source(client);
    hosted.subscribe(() => undefined);
    const pendingRoot = deferred<unknown>();
    client.queryResults.push(pendingRoot.promise);
    const read = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    client.watches[1]?.update(presentationResult({
      name: "Grace",
      observedAt: NOW + 1_000,
      runnerServerTime: NOW + 1_000,
      runnerLeaseUntil: NOW + 46_000,
    }));
    client.watches[0]?.update(headsResult(1));
    pendingRoot.resolve(rootResult(1));
    expect(await read).toMatchObject({
      ok: true,
      value: {
        presentation: { viewer: { name: "Grace" } },
      },
    });
    hosted.dispose();
  });

  test("turns either reactive watch failure into one source replacement fence", async () => {
    const client = new FakeConvexClient();
    const hosted = source(client);
    const events: TaskWorkspaceSourceEvent[] = [];
    hosted.subscribe((event) => events.push(event));
    client.queryResults.push(rootResult(1));
    const read = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    client.watches[0]?.update(headsResult(1));
    expect((await read).ok).toBeTrue();
    client.watches[0]?.update(new Error("heads failed"));
    client.watches[1]?.update(new Error("presentation failed"));
    expect(events).toEqual([{
      kind: "source.replaced",
      minimumRevision: 1,
      sourceGeneration: 1,
      workspaceId: WORKSPACE_ID,
    }]);
    hosted.dispose();
  });

  test("fences continuation reads by exact revision and rejects cursor cycles", async () => {
    const client = new FakeConvexClient();
    const hosted = source(client);
    hosted.subscribe(() => undefined);
    client.queryResults.push(rootResult(2, { continuationRevision: 1 }));
    const initial = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    client.watches[0]?.update(headsResult(2, 1));
    expect((await initial).ok).toBeTrue();

    expect(await hosted.readContinuation({
      coordinate,
      continuationRevision: 2,
      cursor: "next-page-token",
      projectionRevision: 2,
      sourceGeneration: 1,
    })).toEqual({ error: { code: "SOURCE_REPLACED" }, ok: false });
    expect(client.queryArgs).toHaveLength(1);

    client.queryResults.push(continuationResult(
      2,
      1,
      "source-token-1-all",
      { cursor: "next-page-token" },
    ));
    expect(await hosted.readContinuation({
      coordinate,
      continuationRevision: 1,
      cursor: "next-page-token",
      projectionRevision: 2,
      sourceGeneration: 1,
    })).toEqual({ error: { code: "INVALID_CONTINUATION" }, ok: false });
    hosted.dispose();
  });

  test("replays an exact receipt at an already-installed equal revision", async () => {
    const journal = createReceiptPresentMutationJournal();
    const firstClient = new FakeConvexClient();
    const first = source(firstClient, { mutationJournal: journal });
    first.subscribe(() => undefined);
    firstClient.queryResults.push(rootResult(1, {
      tasks: [{ task: task(), humanInput: null, run: null }],
    }));
    const initial = first.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    firstClient.watches[0]?.update(headsResult(1));
    await initial;
    const request = {
      basis: {
        coordinate,
        projectionRevision: 1,
        sourceGeneration: 1,
      },
      intent: {
        kind: "task.update" as const,
        taskId: TASK_ID,
        expectedTaskRevision: 1,
        patch: { title: "Keep the hosted source strictly atomic" },
      },
    };

    firstClient.mutationResults.push(new Error("response lost"));
    expect(await first.execute(request)).toEqual({
      error: { code: "MUTATION_OUTCOME_UNKNOWN", reference: OPERATION_ID },
      ok: false,
    });
    first.dispose();

    const failIfMinted = () => {
      throw new Error("receipt replay must reuse durable controls");
    };
    const secondClient = new FakeConvexClient();
    const second = source(secondClient, {
      idempotencyKey: failIfMinted,
      mutationJournal: journal,
      operationId: failIfMinted,
      taskId: failIfMinted,
    });
    second.subscribe(() => undefined);
    secondClient.queryResults.push(rootResult(2, {
      tasks: [{ task: task(2), humanInput: null, run: null }],
    }));
    const reinstalled = second.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    secondClient.watches[0]?.update(headsResult(2));
    expect((await reinstalled).ok).toBeTrue();

    secondClient.mutationResults.push({
      ok: true,
      data: {
        task: { ...task(2), title: request.intent.patch.title },
        description: "",
        labels: [],
      },
      requestId: "req_00000000000000000000000002",
    });
    secondClient.queryResults.push(rootResult(2, {
      tasks: [{
        task: { ...task(2), title: request.intent.patch.title },
        humanInput: null,
        run: null,
      }],
    }));
    const replayed = await second.execute({
      ...request,
      basis: { ...request.basis, projectionRevision: 2 },
      intent: { ...request.intent, expectedTaskRevision: 2 },
    });
    expect(replayed).toMatchObject({
      ok: true,
      value: {
        operationId: OPERATION_ID,
        commandKind: "task.update",
        workspaceRevision: 2,
        projectionRevision: 2,
        result: { kind: "task_updated", taskId: TASK_ID, taskRevision: 2 },
      },
    });
    if (!replayed.ok) throw new Error("Receipt replay did not commit.");
    await second.acknowledgeMutation(replayed.value);
    expect(await journal.get(createAttemptId(OPERATION_ID))).toMatchObject({
      state: "settled",
      outcome: { status: "confirmed" },
    });
    expect(firstClient.mutationArgs).toHaveLength(1);
    expect(secondClient.mutationArgs).toHaveLength(1);
    expect(firstClient.mutationArgs[0]).toMatchObject({
      idempotencyKey: IDEMPOTENCY_KEY,
      hraOperationId: OPERATION_ID,
    });
    expect(secondClient.mutationArgs[0]).toMatchObject({
      idempotencyKey: IDEMPOTENCY_KEY,
      hraOperationId: OPERATION_ID,
    });
    second.dispose();
  });

  test("never dispatches a recovered effect-started attempt after proving receipt absence", async () => {
    const durable =
      createMemoryMutationAttemptJournal<HostedMutationAttemptDefinition>();
    let loseMarkResponse = true;
    const journal: MutationAttemptJournal<HostedMutationAttemptDefinition> =
      Object.freeze({
      ...durable,
      markEffectStarted: async (
        attemptId: Parameters<typeof durable.markEffectStarted>[0],
        expectedRevision: Parameters<
          typeof durable.markEffectStarted
        >[1],
        effectStartedAtMs: Parameters<
          typeof durable.markEffectStarted
        >[2],
      ) => {
        const transition = await durable.markEffectStarted(
          attemptId,
          expectedRevision,
          effectStartedAtMs,
        );
        if (loseMarkResponse) {
          loseMarkResponse = false;
          throw new Error("effect-start transition response lost");
        }
        return transition;
      },
    });
    const firstClient = new FakeConvexClient();
    const first = source(firstClient, { mutationJournal: journal });
    first.subscribe(() => undefined);
    firstClient.queryResults.push(rootResult(1, {
      tasks: [{ task: task(), humanInput: null, run: null }],
    }));
    const initial = first.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    firstClient.watches[0]?.update(headsResult(1));
    expect((await initial).ok).toBeTrue();
    const request = {
      basis: { coordinate, projectionRevision: 1, sourceGeneration: 1 },
      intent: {
        kind: "task.comment_add" as const,
        taskId: TASK_ID,
        body: "Recover the marked attempt after a crash.",
      },
    };
    expect(await first.execute(request)).toEqual({
      error: { code: "MUTATION_OUTCOME_UNKNOWN", reference: OPERATION_ID },
      ok: false,
    });
    expect(firstClient.mutationArgs).toHaveLength(0);
    expect(await durable.get(createAttemptId(OPERATION_ID))).toMatchObject({
      state: "effect-started",
      recovery: {
        idempotencyKey: IDEMPOTENCY_KEY,
        hraOperationId: OPERATION_ID,
        suppliedTaskId: SUPPLIED_TASK_ID,
      },
    });
    first.dispose();

    const secondClient = new FakeConvexClient();
    const failIfMinted = () => {
      throw new Error("recovery must not mint new controls");
    };
    const second = source(secondClient, {
      idempotencyKey: failIfMinted,
      mutationJournal: journal,
      operationId: failIfMinted,
      taskId: failIfMinted,
    });
    second.subscribe(() => undefined);
    secondClient.queryResults.push(rootResult(1, {
      tasks: [{ task: task(), humanInput: null, run: null }],
    }));
    const reinstalled = second.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    secondClient.watches[0]?.update(headsResult(1));
    expect((await reinstalled).ok).toBeTrue();
    expect(await second.execute(request)).toEqual({
      error: { code: "MUTATION_OUTCOME_UNKNOWN", reference: OPERATION_ID },
      ok: false,
    });
    expect(secondClient.mutationArgs).toHaveLength(0);
    expect(await durable.get(createAttemptId(OPERATION_ID))).toMatchObject({
      state: "settled",
      outcome: { status: "cancelled", reason: "superseded" },
    });
    second.dispose();
  });

  test("does not replay a confirmed effect when acknowledgement response is lost", async () => {
    const durable =
      createMemoryMutationAttemptJournal<HostedMutationAttemptDefinition>();
    let loseSettlementResponse = true;
    const journal: MutationAttemptJournal<HostedMutationAttemptDefinition> =
      Object.freeze({
      ...durable,
      settle: async (
        settlement: Parameters<typeof durable.settle>[0],
      ) => {
        const transition = await durable.settle(settlement);
        if (loseSettlementResponse) {
          loseSettlementResponse = false;
          throw new Error("settlement response lost");
        }
        return transition;
      },
    });
    const firstClient = new FakeConvexClient();
    const first = source(firstClient, { mutationJournal: journal });
    first.subscribe(() => undefined);
    firstClient.queryResults.push(rootResult(1, {
      tasks: [{ task: task(), humanInput: null, run: null }],
    }));
    const initial = first.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    firstClient.watches[0]?.update(headsResult(1));
    expect((await initial).ok).toBeTrue();
    firstClient.mutationResults.push({
      ok: true,
      data: { comment: { id: "cmt_00000000000000000000000001" } },
      requestId: "req_00000000000000000000000008",
    });
    firstClient.queryResults.push(rootResult(2, {
      tasks: [{ task: task(2), humanInput: null, run: null }],
    }));
    const executed = await first.execute({
      basis: { coordinate, projectionRevision: 1, sourceGeneration: 1 },
      intent: {
        kind: "task.comment_add",
        taskId: TASK_ID,
        body: "Settle exactly once.",
      },
    });
    expect(executed).toMatchObject({
      ok: true,
      value: {
        operationId: OPERATION_ID,
        projectionRevision: 2,
      },
    });
    if (!executed.ok) throw new Error("Mutation fixture did not commit.");
    await expect(
      first.acknowledgeMutation(executed.value),
    ).rejects.toThrow("settlement response lost");
    expect(await durable.get(createAttemptId(OPERATION_ID))).toMatchObject({
      state: "settled",
      outcome: { status: "confirmed" },
    });
    expect(await durable.listOpen({
      sourceId: HOSTED_TASK_MUTATION_SOURCE_ID,
      after: null,
      limit: 50,
    })).toEqual({
      attempts: [],
      nextCursor: null,
      hasMore: false,
    });
    first.dispose();

    let mintedControls = 0;
    const trackMint = () => {
      mintedControls += 1;
      return OPERATION_ID;
    };
    const secondClient = new FakeConvexClient();
    const second = source(secondClient, {
      idempotencyKey: trackMint,
      mutationJournal: journal,
      operationId: trackMint,
      taskId: trackMint,
    });
    second.subscribe(() => undefined);
    secondClient.queryResults.push(rootResult(2, {
      tasks: [{ task: task(2), humanInput: null, run: null }],
    }));
    const reinstalled = second.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    secondClient.watches[0]?.update(headsResult(2));
    expect((await reinstalled).ok).toBeTrue();
    await flushMicrotasks();
    expect(mintedControls).toBe(0);
    expect(secondClient.mutationArgs).toHaveLength(0);
    second.dispose();
  });

  test("rejects generated control collisions before any mutation effect", async () => {
    const journal =
      createMemoryMutationAttemptJournal<HostedMutationAttemptDefinition>();
    await journal.prepare({
      attemptId: createAttemptId(OPERATION_ID),
      fingerprint: createMutationFingerprint(`sha256_${"A".repeat(43)}`),
      operation: "task.comment_add",
      sourceId: HOSTED_TASK_MUTATION_SOURCE_ID,
      preparedAtMs: NOW - 1,
      recovery: {
        idempotencyKey: IDEMPOTENCY_KEY,
        hraOperationId: OPERATION_ID,
        suppliedTaskId: SUPPLIED_TASK_ID,
        targetTaskId: TASK_ID,
      },
    });
    const client = new FakeConvexClient();
    const hosted = source(client, { mutationJournal: journal });
    hosted.subscribe(() => undefined);
    client.queryResults.push(rootResult(1, {
      tasks: [{ task: task(), humanInput: null, run: null }],
    }));
    const initial = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    client.watches[0]?.update(headsResult(1));
    expect((await initial).ok).toBeTrue();
    expect(await hosted.execute({
      basis: { coordinate, projectionRevision: 1, sourceGeneration: 1 },
      intent: {
        kind: "task.comment_add",
        taskId: TASK_ID,
        body: "This intent has a distinct digest.",
      },
    })).toEqual({
      error: { code: "IDEMPOTENCY_CONFLICT", reference: OPERATION_ID },
      ok: false,
    });
    expect(client.mutationArgs).toHaveLength(0);
    hosted.dispose();
  });

  test("honors a pre-aborted mutation context before preparing an attempt", async () => {
    const journal =
      createMemoryMutationAttemptJournal<HostedMutationAttemptDefinition>();
    const client = new FakeConvexClient();
    const hosted = source(client, { mutationJournal: journal });
    hosted.subscribe(() => undefined);
    client.queryResults.push(rootResult(1, {
      tasks: [{ task: task(), humanInput: null, run: null }],
    }));
    const initial = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    client.watches[0]?.update(headsResult(1));
    expect((await initial).ok).toBeTrue();
    const controller = new AbortController();
    controller.abort();
    expect(await hosted.execute({
      basis: { coordinate, projectionRevision: 1, sourceGeneration: 1 },
      intent: {
        kind: "task.comment_add",
        taskId: TASK_ID,
        body: "Never prepare this attempt.",
      },
    }, {
      deadlineMonotonicMs: 1_000,
      signal: controller.signal,
    })).toEqual({
      error: { code: "REQUEST_SUPERSEDED" },
      ok: false,
    });
    expect(await journal.listOpen({
      sourceId: HOSTED_TASK_MUTATION_SOURCE_ID,
      after: null,
      limit: 50,
    })).toEqual({
      attempts: [],
      nextCursor: null,
      hasMore: false,
    });
    expect(client.mutationArgs).toHaveLength(0);
    hosted.dispose();
  });

  test("keeps an effect-started attempt ambiguous when the caller aborts dispatch", async () => {
    const journal = createReceiptPresentMutationJournal();
    const client = new FakeConvexClient();
    const hosted = source(client, { mutationJournal: journal });
    hosted.subscribe(() => undefined);
    client.queryResults.push(rootResult(1, {
      tasks: [{ task: task(), humanInput: null, run: null }],
    }));
    const initial = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    client.watches[0]?.update(headsResult(1));
    expect((await initial).ok).toBeTrue();
    const pendingMutation = deferred<unknown>();
    client.mutationResults.push(pendingMutation.promise);
    const controller = new AbortController();
    const executing = hosted.execute({
      basis: { coordinate, projectionRevision: 1, sourceGeneration: 1 },
      intent: {
        kind: "task.comment_add",
        taskId: TASK_ID,
        body: "Abort only after dispatch begins.",
      },
    }, {
      deadlineMonotonicMs: 1_000,
      signal: controller.signal,
    });
    await waitFor(
      () => client.mutationArgs.length === 1,
      "caller-aborted mutation dispatch",
    );
    expect(client.mutationArgs).toHaveLength(1);
    controller.abort();
    expect(await executing).toEqual({
      error: { code: "MUTATION_OUTCOME_UNKNOWN", reference: OPERATION_ID },
      ok: false,
    });
    expect(await journal.get(createAttemptId(OPERATION_ID))).toMatchObject({
      state: "effect-started",
    });
    hosted.dispose();
  });

  test("uses the caller deadline and removes its abort listener after a read", async () => {
    const client = new FakeConvexClient();
    const hosted = source(client, {
      monotonicNow: () => 0,
      readTimeoutMs: 1_000,
    });
    hosted.subscribe(() => undefined);
    client.queryResults.push(new Promise<never>(() => undefined));
    let added = 0;
    let removed = 0;
    const signal = {
      aborted: false,
      addEventListener: (type: string) => {
        if (type === "abort") added += 1;
      },
      removeEventListener: (type: string) => {
        if (type === "abort") removed += 1;
      },
    } as unknown as AbortSignal;
    const result = await hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    }, {
      deadlineMonotonicMs: 5,
      signal,
    });
    expect(result).toEqual({
      error: { code: "REQUEST_SUPERSEDED" },
      ok: false,
    });
    expect({ added, removed }).toEqual({ added: 1, removed: 1 });
    hosted.dispose();
  });

  test("retains the exact attempt when mutation dispatch times out", async () => {
    const client = new FakeConvexClient();
    const hosted = source(client, {
      mutationJournal: createReceiptPresentMutationJournal(),
      readTimeoutMs: 10,
    });
    hosted.subscribe(() => undefined);
    client.queryResults.push(rootResult(1, {
      tasks: [{ task: task(), humanInput: null, run: null }],
    }));
    const initial = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    client.watches[0]?.update(headsResult(1));
    expect((await initial).ok).toBeTrue();
    const request = {
      basis: { coordinate, projectionRevision: 1, sourceGeneration: 1 },
      intent: {
        kind: "task.comment_add" as const,
        taskId: TASK_ID,
        body: "Bound mutation dispatch.",
      },
    };
    const lateMutation = deferred<unknown>();
    client.mutationResults.push(lateMutation.promise);
    expect(await hosted.execute(request)).toEqual({
      error: { code: "MUTATION_OUTCOME_UNKNOWN", reference: OPERATION_ID },
      ok: false,
    });

    client.mutationResults.push({
      ok: true,
      data: { comment: { id: "cmt_00000000000000000000000001" } },
      requestId: "req_00000000000000000000000004",
    });
    client.queryResults.push(rootResult(2, {
      tasks: [{ task: task(2), humanInput: null, run: null }],
    }));
    expect((await hosted.execute(request)).ok).toBeTrue();
    expect(client.mutationArgs[0]).toMatchObject({
      idempotencyKey: IDEMPOTENCY_KEY,
      hraOperationId: OPERATION_ID,
    });
    expect(client.mutationArgs[1]).toMatchObject({
      idempotencyKey: IDEMPOTENCY_KEY,
      hraOperationId: OPERATION_ID,
    });
    lateMutation.resolve({
      ok: true,
      data: { comment: { id: "cmt_00000000000000000000000001" } },
      requestId: "req_00000000000000000000000004",
    });
    expect((await hosted.readProjection({
      coordinate,
      minimumRevision: 2,
      sourceGeneration: 1,
    })).ok).toBeTrue();
    hosted.dispose();
  });

  test("requires a strictly newer root for a fresh dispatch", async () => {
    const client = new FakeConvexClient();
    const journal =
      createMemoryMutationAttemptJournal<HostedMutationAttemptDefinition>();
    const hosted = source(client, { mutationJournal: journal });
    hosted.subscribe(() => undefined);
    client.queryResults.push(rootResult(1, {
      tasks: [{ task: task(), humanInput: null, run: null }],
    }));
    const initial = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    client.watches[0]?.update(headsResult(1));
    expect((await initial).ok).toBeTrue();
    const request = {
      basis: { coordinate, projectionRevision: 1, sourceGeneration: 1 },
      intent: {
        kind: "task.comment_add" as const,
        taskId: TASK_ID,
        body: "Observe the committed projection.",
      },
    };
    const committed = {
      ok: true,
      data: { comment: { id: "cmt_00000000000000000000000001" } },
      requestId: "req_00000000000000000000000005",
    };
    client.mutationResults.push(committed);
    client.queryResults.push(rootResult(1, {
      tasks: [{ task: task(), humanInput: null, run: null }],
    }));
    expect(await hosted.execute(request)).toEqual({
      error: { code: "MUTATION_OUTCOME_UNKNOWN", reference: OPERATION_ID },
      ok: false,
    });
    expect(client.mutationArgs).toHaveLength(1);
    expect(client.mutationArgs[0]).toMatchObject({
      idempotencyKey: IDEMPOTENCY_KEY,
      hraOperationId: OPERATION_ID,
    });
    expect(await journal.get(createAttemptId(OPERATION_ID))).toMatchObject({
      state: "effect-started",
    });
    hosted.dispose();
  });

  test("preserves an in-flight attempt across subscription churn", async () => {
    const client = new FakeConvexClient();
    const hosted = source(client, {
      mutationJournal: createReceiptPresentMutationJournal(),
    });
    const firstUnsubscribe = hosted.subscribe(() => undefined);
    client.queryResults.push(rootResult(1, {
      tasks: [{ task: task(), humanInput: null, run: null }],
    }));
    const initial = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    client.watches[0]?.update(headsResult(1));
    expect((await initial).ok).toBeTrue();
    const firstRequest = {
      basis: { coordinate, projectionRevision: 1, sourceGeneration: 1 },
      intent: {
        kind: "task.comment_add" as const,
        taskId: TASK_ID,
        body: "Survive a StrictMode lifecycle replay.",
      },
    };
    const lateMutation = deferred<unknown>();
    client.mutationResults.push(lateMutation.promise);
    const firstExecution = hosted.execute(firstRequest);
    await waitFor(
      () => client.mutationArgs.length === 1,
      "subscription-churn mutation dispatch",
    );
    expect(client.mutationArgs).toHaveLength(1);
    firstUnsubscribe();
    expect(await firstExecution).toEqual({
      error: { code: "MUTATION_OUTCOME_UNKNOWN", reference: OPERATION_ID },
      ok: false,
    });
    expect(client.watches[0]?.unsubscribeCount).toBe(1);
    expect(client.watches[1]?.unsubscribeCount).toBe(1);

    const secondUnsubscribe = hosted.subscribe(() => undefined);
    client.queryResults.push(rootResult(1, {
      tasks: [{ task: task(), humanInput: null, run: null }],
    }));
    const reinstalled = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 2,
    });
    expect(client.watches).toHaveLength(4);
    client.watches[2]?.update(headsResult(1));
    expect((await reinstalled).ok).toBeTrue();
    client.mutationResults.push({
      ok: true,
      data: { comment: { id: "cmt_00000000000000000000000001" } },
      requestId: "req_00000000000000000000000006",
    });
    client.queryResults.push(rootResult(2, {
      tasks: [{ task: task(2), humanInput: null, run: null }],
    }));
    expect((await hosted.execute({
      ...firstRequest,
      basis: { ...firstRequest.basis, sourceGeneration: 2 },
    })).ok).toBeTrue();
    expect(client.mutationArgs[0]).toMatchObject({
      idempotencyKey: IDEMPOTENCY_KEY,
      hraOperationId: OPERATION_ID,
    });
    expect(client.mutationArgs[1]).toMatchObject({
      idempotencyKey: IDEMPOTENCY_KEY,
      hraOperationId: OPERATION_ID,
    });
    lateMutation.resolve({
      ok: true,
      data: { comment: { id: "cmt_00000000000000000000000001" } },
      requestId: "req_00000000000000000000000006",
    });
    secondUnsubscribe();
    expect(client.watches[2]?.unsubscribeCount).toBe(1);
    expect(client.watches[3]?.unsubscribeCount).toBe(1);
  });

  test("resolves mutation targets from selected graph edges", async () => {
    const client = new FakeConvexClient();
    const hosted = source(client);
    hosted.subscribe(() => undefined);
    const selectedCoordinate = { ...coordinate, selectedTaskId: TASK_ID };
    const related = {
      id: RELATED_TASK_ID,
      key: "OP-0000003",
      priority: 2,
      revision: 3,
      status: "open" as const,
      title: "Linked dependent",
    };
    const selected = {
      taskId: TASK_ID,
      workspaceId: WORKSPACE_ID,
      projectionRevision: 1,
      detail: {
        task: task(),
        description: "",
        labels: [],
        parent: null,
        children: [],
        blockers: [],
        dependents: [{ createdAt: NOW - 10, task: related }],
        comments: [],
        events: [],
        references: [],
        submission: null,
        recoveries: [],
        truncatedCollections: [],
      },
      runs: { runs: [], hasMore: false },
    };
    client.queryResults.push(rootResult(1, {
      selected,
      selectedTaskId: TASK_ID,
      tasks: [{ task: task(), humanInput: null, run: null }],
    }));
    const initial = hosted.readProjection({
      coordinate: selectedCoordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    client.watches[0]?.update(headsResult(1));
    expect((await initial).ok).toBeTrue();
    client.mutationResults.push({
      ok: false,
      error: {
        code: "TASK_STATE_CONFLICT",
        message: "conflict",
        requestId: "req_00000000000000000000000003",
        details: {},
      },
    });

    expect(await hosted.execute({
      basis: {
        coordinate: selectedCoordinate,
        projectionRevision: 1,
        sourceGeneration: 1,
      },
      intent: {
        kind: "dependency.remove",
        taskId: RELATED_TASK_ID,
        expectedTaskRevision: 3,
        blockerKey: task().key,
      },
    })).toMatchObject({
      ok: false,
      error: { code: "TASK_STATE_CONFLICT" },
    });
    expect(client.mutationArgs).toHaveLength(1);
    expect(client.mutationArgs[0]).toMatchObject({
      key: related.key,
      blockerKey: task().key,
      revision: related.revision,
    });
  });

  test("retains ambiguous attempts without eviction across journal pages", async () => {
    const client = new FakeConvexClient();
    const journal = createReceiptPresentMutationJournal();
    let idempotencyIndex = 1;
    let operationIndex = 1;
    let taskIndex = 1;
    const hosted = source(client, {
      idempotencyKey: () =>
        `018f0f7d-8b4c-7000-8000-${(idempotencyIndex++)
          .toString(16)
          .padStart(12, "0")}`,
      mutationJournal: journal,
      operationId: () =>
        `op_${String(operationIndex++).padStart(26, "0")}`,
      taskId: () =>
        `tsk_${String(taskIndex++).padStart(26, "0")}`,
    });
    hosted.subscribe(() => undefined);
    client.queryResults.push(rootResult(1, {
      tasks: [{ task: task(), humanInput: null, run: null }],
    }));
    const initial = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    client.watches[0]?.update(headsResult(1));
    await initial;
    client.mutationResults.push(
      ...Array.from({ length: 60 }, () => new Error("response lost")),
    );
    for (let index = 0; index < 60; index += 1) {
      const result = await hosted.execute({
        basis: { coordinate, projectionRevision: 1, sourceGeneration: 1 },
        intent: {
          kind: "task.comment_add",
          taskId: TASK_ID,
          body: `Ambiguous comment ${String(index)}`,
        },
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "MUTATION_OUTCOME_UNKNOWN" },
      });
    }
    const first = await journal.listOpen({
      sourceId: HOSTED_TASK_MUTATION_SOURCE_ID,
      after: null,
      limit: 50,
    });
    expect(first).toMatchObject({
      attempts: { length: 50 },
      hasMore: true,
    });
    expect(first.nextCursor).not.toBeNull();
    const second = await journal.listOpen({
      sourceId: HOSTED_TASK_MUTATION_SOURCE_ID,
      after: first.nextCursor,
      limit: 50,
    });
    expect(second.attempts).toHaveLength(10);
    expect(second.hasMore).toBeFalse();
    expect(second.nextCursor).toEqual({
      attemptId: createAttemptId("op_00000000000000000000000060"),
      preparedAtMs: NOW,
    });
    expect(client.mutationArgs).toHaveLength(60);
  });

  test("reports an unknown outcome when disposal follows dispatch", async () => {
    const client = new FakeConvexClient();
    const hosted = source(client, {
      mutationJournal: createReceiptPresentMutationJournal(),
    });
    hosted.subscribe(() => undefined);
    client.queryResults.push(rootResult(1, {
      tasks: [{ task: task(), humanInput: null, run: null }],
    }));
    const initial = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    client.watches[0]?.update(headsResult(1));
    expect((await initial).ok).toBeTrue();
    client.mutationResults.push(deferred<unknown>().promise);
    const executing = hosted.execute({
      basis: { coordinate, projectionRevision: 1, sourceGeneration: 1 },
      intent: {
        kind: "task.comment_add",
        taskId: TASK_ID,
        body: "Preserve ambiguity through disposal.",
      },
    });
    await waitFor(
      () => client.mutationArgs.length === 1,
      "dispose-after-dispatch mutation",
    );
    expect(client.mutationArgs).toHaveLength(1);

    hosted.dispose();
    expect(await executing).toEqual({
      error: { code: "MUTATION_OUTCOME_UNKNOWN", reference: OPERATION_ID },
      ok: false,
    });
  });

  test("dispose closes the watch and settles outstanding reads", async () => {
    const client = new FakeConvexClient();
    const hosted = source(client);
    hosted.subscribe(() => undefined);
    client.queryResults.push(new Promise<never>(() => undefined));
    const pending = hosted.readProjection({
      coordinate,
      minimumRevision: null,
      sourceGeneration: 1,
    });
    hosted.dispose();
    expect(await pending).toEqual({ error: { code: "SOURCE_DISPOSED" }, ok: false });
    expect(client.watches[0]?.unsubscribeCount).toBe(1);
    expect(client.watches[1]?.unsubscribeCount).toBe(1);
  });
});
