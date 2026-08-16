import {
  taskWorkspaceListItemSchema,
} from "@hraness/agent-tasks-domain";
import {
  canonicalJson,
} from "@hraness/direct/core";
import {
  createDirectSession,
  createExactScriptedTransport,
  type DirectSession,
  type DirectSessionActivation,
  type DirectSessionContext,
} from "@hraness/direct/testing";
import {
  TaskWorkspace,
  type TaskWorkspaceActionResult,
  type TaskWorkspaceActions,
  type TaskWorkspaceListItem,
  type TaskWorkspaceProps,
  type TaskWorkspaceSelection,
  type TaskWorkspaceView,
} from "@hraness/agent-tasks-ui";
import { z } from "@hra-internal/schema";
import { useSyncExternalStore } from "react";

import { normalizeTaskRuns } from "../app/task-run-boundary";
import {
  agentTasksDirectDefinition,
  type AgentTasksDirectRoute,
} from "./scenarios";
import {
  parseAgentTasksCommandFailure,
  parseAgentTasksCommandRequest,
  parseAgentTasksCommandResponse,
  parseAgentTasksTaskView,
  type AgentTasksDirectWorld,
  type AgentTasksCommandRequest,
  type AgentTasksCommandResponse,
} from "./world";

const eventSchema = z.never();

export interface AgentTasksDirectSnapshot {
  readonly blockedNetworkRequests: number;
  readonly disposed: boolean;
  readonly listenerFailures: number;
  readonly remainingScripts: Readonly<{ commands: number; interactions: number; pages: number }>;
  readonly requests: number;
  readonly violations: number;
}

export interface AgentTasksDirectHarness {
  readonly actions: TaskWorkspaceActions;
  readonly assertScriptsDrained: () => void;
  readonly getProps: () => TaskWorkspaceProps;
  readonly getSnapshot: () => AgentTasksDirectSnapshot;
  readonly recordBlockedNetworkRequest: () => void;
}

function required<Value>(result:
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; error: Readonly<{ message: string }> }>,
): Value {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function encode(value: unknown): string {
  return required(canonicalJson(value));
}

function pushBounded(values: string[], value: string): void {
  if (values.length === 256) values.shift();
  values.push(value);
}

function commandResult(
  response: AgentTasksCommandResponse,
): TaskWorkspaceActionResult {
  return { ok: true, requestId: response.requestId };
}

function createAgentTasksDirectHarness(
  context: DirectSessionContext<AgentTasksDirectWorld, AgentTasksDirectRoute>,
  onListenerFailure: () => undefined,
  readListenerFailures: () => number,
): AgentTasksDirectHarness {
  let blockedNetworkRequests = 0;
  let disposed = false;
  const { activity, clock: runtime, onDispose, store } = context;
  const transport = required(createExactScriptedTransport({
    activity,
    activityNamespace: "agent-tasks-command",
    parseRequest: parseAgentTasksCommandRequest,
    parseResponse: parseAgentTasksCommandResponse,
    parseEvent: (input) => eventSchema.parse(input),
    parseFailure: parseAgentTasksCommandFailure,
    runtime,
    steps: context.world.scripts.commands,
    onListenerError: onListenerFailure,
  }));

  function transact(namespace: string, update: (world: AgentTasksDirectWorld) => void): void {
    if (disposed) throw new Error("The deterministic Agent Tasks runtime is disposed.");
    const snapshot = store.getSnapshot();
    const result = store.transact(
      snapshot.generation,
      runtime.nextOperationId(namespace),
      update,
    );
    if (!result.ok) throw new Error(result.error.message);
  }

  function violation(message: string): void {
    transact("violation", (world) => pushBounded(world.diagnostics.violations, message));
  }

  function consumeWorldCommand(request: AgentTasksCommandRequest): void {
    transact("consume-command", (world) => {
      const step = world.scripts.commands.shift();
      if (step === undefined || encode(step.request) !== encode(request)) {
        pushBounded(world.diagnostics.violations, "The exact command transport diverged from its world queue.");
      }
    });
  }

  function updateTask(
    world: AgentTasksDirectWorld,
    taskKey: string,
    update: (task: AgentTasksDirectWorld["details"][number]["task"]) => unknown,
  ): AgentTasksDirectWorld["details"][number]["task"] {
    const detail = world.details.find(({ task }) => task.key === taskKey);
    if (detail === undefined) throw new Error(`Missing deterministic detail for ${taskKey}.`);
    const next = parseAgentTasksTaskView(update(detail.task));
    detail.task = next;
    for (const view of Object.keys(world.views) as TaskWorkspaceView[]) {
      const state = world.views[view];
      if (state.kind !== "ready") continue;
      state.tasks = state.tasks.map((task) => task.key === taskKey ? next : task);
    }
    return next;
  }

  function appendEvent(
    world: AgentTasksDirectWorld,
    detail: AgentTasksDirectWorld["details"][number],
    type: "task.accepted" | "task.cancelled" | "task.rejected",
    summary: string,
  ): void {
    detail.events.push({
      actor: structuredClone(world.viewer),
      createdAt: world.now,
      id: `evt_direct_${String(detail.events.length + 1)}`,
      summary,
      taskRevision: detail.task.revision,
      type,
    });
  }

  function detailForRun(
    world: AgentTasksDirectWorld,
    runId: string,
  ): AgentTasksDirectWorld["details"][number] {
    const detail = world.details.find(({ runs }) => runs?.some(({ id }) => id === runId));
    if (detail === undefined) throw new Error(`Missing deterministic run ${runId}.`);
    return detail;
  }

  function replaceRun(
    detail: AgentTasksDirectWorld["details"][number],
    runId: string,
    replacement: Extract<AgentTasksCommandResponse, { readonly run: unknown }>,
  ): void {
    const runs = detail.runs ?? [];
    const index = runs.findIndex(({ id }) => id === runId);
    if (index === -1) throw new Error(`Missing deterministic run ${runId}.`);
    if (replacement.run.taskKey !== detail.task.key) {
      throw new Error(`Run ${replacement.run.id} must belong to ${detail.task.key}.`);
    }
    runs[index] = structuredClone(replacement.run);
    detail.runs = runs;
  }

  function applyResponse(
    world: AgentTasksDirectWorld,
    request: AgentTasksCommandRequest,
    response: AgentTasksCommandResponse,
  ): void {
    if (response.transition === "created") {
      world.details.push(structuredClone(response.detail));
      for (const view of ["all", ...(response.task.isReady ? ["ready" as const] : [])] as const) {
        const state = world.views[view];
        if (state.kind !== "ready") throw new Error(`${view} must be ready for deterministic creation.`);
        state.tasks = [structuredClone(response.task), ...state.tasks];
        world.counts[view].value += 1;
      }
      world.selectedTaskKey = response.task.key;
      return;
    }
    if (response.transition === "stop_recorded") {
      if (request.kind !== "requestRunStop" || response.run.id !== request.runId) {
        throw new Error("A stop response must replace the requested run.");
      }
      replaceRun(detailForRun(world, request.runId), request.runId, response);
      return;
    }
    if (response.transition === "retried") {
      if (request.kind !== "retryRun") throw new Error("A retry response requires a retry request.");
      const detail = detailForRun(world, request.runId);
      if (response.run.phase !== "queued" || response.run.desiredState !== "run") {
        throw new Error("A deterministic retry must create one runnable queued attempt.");
      }
      if (response.run.taskKey !== detail.task.key) {
        throw new Error(`Retried run ${response.run.id} must belong to ${detail.task.key}.`);
      }
      if ((detail.runs ?? []).some(({ id }) => id === response.run.id)) {
        throw new Error(`Retried run ${response.run.id} already exists.`);
      }
      detail.runs = [structuredClone(response.run), ...(detail.runs ?? [])];
      return;
    }
    if (response.transition === "ambiguity_resolved") {
      if (request.kind !== "abandonAmbiguousRun" || response.run.id !== request.runId) {
        throw new Error("An ambiguity response must replace the requested run.");
      }
      if (
        (request.reason === "confirmed_cancelled" && response.run.phase !== "cancelled")
        || (request.reason === "declared_failed" && response.run.phase !== "failed")
      ) {
        throw new Error("An ambiguity response must match its declared terminal outcome.");
      }
      const detail = detailForRun(world, request.runId);
      replaceRun(detail, request.runId, response);
      const isReady = detail.task.availableAt <= world.now
        && detail.task.unresolvedBlockerCount === 0
        && detail.task.cancelledBlockerCount === 0;
      const next = updateTask(world, detail.task.key, (task) => {
        const candidate: Record<string, unknown> = {
          ...task,
          isReady,
          revision: task.revision + 1,
          status: "open",
          updatedAt: world.now,
        };
        delete candidate.currentClaim;
        return candidate;
      });
      const ready = world.views.ready;
      if (isReady && ready.kind === "ready" && !ready.tasks.some(({ key }) => key === next.key)) {
        ready.tasks.unshift(next);
        world.counts.ready.value += 1;
      }
      return;
    }
    if (request.kind === "createTask") {
      throw new Error("A create request received a non-create response.");
    }
    if (
      request.kind === "requestRunStop"
      || request.kind === "retryRun"
      || request.kind === "abandonAmbiguousRun"
    ) {
      throw new Error(`The ${request.kind} request received an unrelated response.`);
    }
    const detail = world.details.find(({ task }) => task.key === request.taskKey);
    if (detail === undefined) throw new Error(`Missing deterministic detail for ${request.taskKey}.`);
    if (response.transition === "accepted") {
      const next = updateTask(world, request.taskKey, (task) => ({
        ...task,
        isReady: false,
        revision: task.revision + 1,
        status: "done",
        updatedAt: world.now,
      }));
      detail.task = next;
      if (detail.submission !== null) {
        detail.submission.status = "accepted";
        detail.submission.reviewedAt = world.now;
      }
      const review = world.views.review;
      if (review.kind === "ready") review.tasks = review.tasks.filter(({ key }) => key !== request.taskKey);
      world.counts.review.value = Math.max(0, world.counts.review.value - 1);
      appendEvent(world, detail, "task.accepted", "Accepted the immutable submission.");
      return;
    }
    if (response.transition === "rejected" && request.kind === "rejectSubmission") {
      const next = updateTask(world, request.taskKey, (task) => ({
        ...task,
        isReady: true,
        reviewRevision: task.reviewRevision + 1,
        revision: task.revision + 1,
        status: "open",
        updatedAt: world.now,
      }));
      detail.task = next;
      if (detail.submission !== null) {
        detail.submission.status = "rejected";
        detail.submission.reviewReason = request.reason;
        detail.submission.reviewedAt = world.now;
      }
      if (!detail.recoveries.some(({ kind }) => kind === "submission_rejected")) {
        detail.recoveries.push({ kind: "submission_rejected" });
      }
      const review = world.views.review;
      if (review.kind === "ready") review.tasks = review.tasks.filter(({ key }) => key !== request.taskKey);
      const ready = world.views.ready;
      if (ready.kind === "ready" && !ready.tasks.some(({ key }) => key === request.taskKey)) ready.tasks.unshift(next);
      world.counts.review.value = Math.max(0, world.counts.review.value - 1);
      world.counts.ready.value += 1;
      appendEvent(world, detail, "task.rejected", "Rejected the immutable submission and reopened work.");
      return;
    }
    if (response.transition === "cancelled" && request.kind === "cancelTask") {
      const next = updateTask(world, request.taskKey, (task) => {
        const candidate: Record<string, unknown> = {
          ...task,
          isReady: false,
          revision: task.revision + 1,
          status: "cancelled",
          updatedAt: world.now,
        };
        delete candidate.currentClaim;
        return candidate;
      });
      detail.task = next;
      if (!detail.recoveries.some(({ kind }) => kind === "task_cancelled")) {
        detail.recoveries.push({ kind: "task_cancelled" });
      }
      appendEvent(world, detail, "task.cancelled", "Cancelled the task while retaining its audit history.");
      return;
    }
    throw new Error(`The ${request.kind} request cannot apply ${response.transition}.`);
  }

  async function execute(request: AgentTasksCommandRequest): Promise<TaskWorkspaceActionResult> {
    if (disposed) return { error: { code: "CLIENT_UNAVAILABLE" }, ok: false };
    transact("record-request", (world) => {
      pushBounded(world.diagnostics.requests, `${request.kind}:${encode(request)}`);
    });
    const result = await transport.request(request);
    if (!result.ok) {
      if (result.error.kind === "scripted") {
        consumeWorldCommand(request);
        return { error: result.error.failure, ok: false };
      }
      violation(`Unexpected ${request.kind} request: ${result.error.error.code}.`);
      return { error: { code: "DIRECT_SCRIPT_MISMATCH" }, ok: false };
    }
    consumeWorldCommand(request);
    transact(
      `apply-${result.value.transition.replaceAll("_", "-")}`,
      (world) => applyResponse(world, request, result.value),
    );
    return commandResult(result.value);
  }

  function unsupported(name: string): Promise<TaskWorkspaceActionResult> {
    if (!disposed) violation(`Unsupported deterministic action invoked: ${name}.`);
    return Promise.resolve({
      error: { code: "DIRECT_UNSUPPORTED_ACTION" },
      ok: false,
    });
  }

  async function respondToRunInteraction(
    input: Parameters<TaskWorkspaceActions["respondToRunInteraction"]>[0],
  ): Promise<TaskWorkspaceActionResult> {
    if (disposed) return { error: { code: "CLIENT_UNAVAILABLE" }, ok: false };
    const tracked = await activity.run("agent-tasks-interaction", () => {
      let result: TaskWorkspaceActionResult = {
        error: { code: "DIRECT_SCRIPT_MISMATCH" },
        ok: false,
      };
      transact("respond-to-interaction", (world) => {
        pushBounded(
          world.diagnostics.requests,
          `respondToRunInteraction:${input.runId}:${input.interactionId}:${input.response.kind}`,
        );
        const step = world.scripts.interactions[0];
        if (step === undefined || encode(step.request) !== encode(input)) {
          pushBounded(world.diagnostics.violations, "The exact HITL response diverged from its world queue.");
          return;
        }
        world.scripts.interactions.shift();
        if (step.outcome.kind === "failure") {
          result = { error: step.outcome.error, ok: false };
          return;
        }
        const detail = world.details.find(({ runs }) => runs?.some(({ id }) => id === input.runId));
        const run = detail?.runs?.find(({ id }) => id === input.runId);
        const interaction = run?.interactions.find(
          ({ request }) => request.id === input.interactionId,
        );
        if (
          interaction === undefined
          || interaction.state !== "pending"
          || interaction.request.expiresAt <= world.now
        ) {
          pushBounded(world.diagnostics.violations, "The exact HITL response targeted a non-pending interaction.");
          return;
        }
        interaction.state = "answered";
        interaction.responseRevision = 1;
        interaction.respondedAt = world.now;
        result = { ok: true, requestId: step.outcome.requestId };
      });
      return result;
    });
    if (tracked.ok) return tracked.value;
    if (!disposed) violation(`HITL response activity failed: ${tracked.error.message}`);
    return { error: { code: "CLIENT_UNAVAILABLE" }, ok: false };
  }

  const actions: TaskWorkspaceActions = Object.freeze({
    acceptSubmission: (input) => execute({ kind: "acceptSubmission", ...input }),
    abandonAmbiguousRun: (input) => execute({ kind: "abandonAmbiguousRun", ...input }),
    addBlocker: () => unsupported("addBlocker"),
    addComment: () => unsupported("addComment"),
    addLabel: () => unsupported("addLabel"),
    addReference: () => unsupported("addReference"),
    cancelTask: (input) => execute({ kind: "cancelTask", ...input }),
    clearParent: () => unsupported("clearParent"),
    createTask: (input) => execute({
      description: input.description,
      kind: "createTask",
      labels: [...input.labels],
      priority: input.priority,
      title: input.title,
      type: input.type,
      ...(input.availableAt === undefined ? {} : { availableAt: input.availableAt }),
      ...(input.parentKey === undefined ? {} : { parentKey: input.parentKey }),
      ...(input.repositoryId === undefined ? {} : { repositoryId: input.repositoryId }),
    }),
    deferTask: () => unsupported("deferTask"),
    loadMore: (pageCursor, view) => {
      if (disposed) return;
      transact("load-more", (world) => {
        const step = world.scripts.pages.shift();
        if (step === undefined || step.cursor !== pageCursor || step.view !== view) {
          pushBounded(world.diagnostics.violations, `Unexpected page request ${view}:${pageCursor}.`);
          return;
        }
        const state = world.views[view];
        if (state.kind !== "ready") {
          pushBounded(world.diagnostics.violations, `Cannot append a page to the ${view} ${state.kind} state.`);
          return;
        }
        const known = new Set(state.tasks.map(({ key }) => key));
        state.tasks = [...state.tasks, ...step.tasks.filter(({ key }) => !known.has(key))];
        state.cursor = step.nextCursor;
      });
    },
    rejectSubmission: (input) => execute({ kind: "rejectSubmission", ...input }),
    removeBlocker: () => unsupported("removeBlocker"),
    removeLabel: () => unsupported("removeLabel"),
    removeReference: () => unsupported("removeReference"),
    reopenTask: () => unsupported("reopenTask"),
    respondToRunInteraction,
    requestRunStop: (input) => execute({ kind: "requestRunStop", ...input }),
    retryRun: (input) => execute({ kind: "retryRun", ...input }),
    selectTask: (taskKey) => {
      if (disposed) return;
      transact("select-task", (world) => {
        if (taskKey === null) {
          world.selectedTaskKey = null;
          return;
        }
        const state = world.views[world.activeView];
        if (state.kind !== "ready" || !state.tasks.some(({ key }) => key === taskKey)) {
          pushBounded(world.diagnostics.violations, `Cannot select ${taskKey} outside the active queue.`);
          return;
        }
        world.selectedTaskKey = taskKey;
      });
    },
    setAssignee: () => unsupported("setAssignee"),
    setParent: () => unsupported("setParent"),
    updateTask: () => unsupported("updateTask"),
    viewChanged: (view) => {
      if (disposed) return;
      transact("change-view", (world) => {
        world.activeView = view;
        const state = world.views[view];
        world.selectedTaskKey = state.kind === "ready" ? state.tasks[0]?.key ?? null : null;
      });
    },
  });

  function getProps(): TaskWorkspaceProps {
    const world = store.getSnapshot().world;
    const state = world.views[world.activeView];
    let read: TaskWorkspaceProps["read"];
    if (state.kind === "loading") {
      read = { kind: "loading", view: world.activeView };
    } else if (state.kind === "error") {
      read = { error: state.error, kind: "error", view: world.activeView };
    } else {
      const selected = world.selectedTaskKey === null
        ? null
        : world.details.find(({ task }) => task.key === world.selectedTaskKey);
      const normalizedRuns = selected === undefined || selected === null
        ? null
        : normalizeTaskRuns(selected.runs ?? [], selected.task.key);
      const selection: TaskWorkspaceSelection =
        selected === undefined || selected === null
          ? { kind: "none" }
          : normalizedRuns === null
            ? {
                error: { code: "DIRECT_PROJECTION_MISMATCH" },
                kind: "error",
                taskKey: selected.task.key,
              }
            : {
                detail: { ...selected, runs: [...normalizedRuns] },
                kind: "ready",
              };
      const tasks: TaskWorkspaceListItem[] = state.tasks.map((task) => {
        const taskDetail = world.details.find((candidate) => candidate.task.key === task.key);
        const run = taskDetail?.runs?.[0];
        const pendingInteractions = (run?.interactions ?? [])
          .filter((interaction) =>
            interaction.state === "pending" && interaction.request.expiresAt > world.now,
          )
          .sort((left, right) =>
            left.request.createdAt - right.request.createdAt ||
            left.request.id.localeCompare(right.request.id),
          );
        const oldest = pendingInteractions[0];
        const humanInput = oldest === undefined
          ? null
          : oldest.request.kind === "file_change_approval"
            ? {
                expiresAt: oldest.request.expiresAt,
                kind: "approval" as const,
                oldestRequestedAt: oldest.request.createdAt,
                pendingCount: pendingInteractions.length,
                preview: "Allow this task to change files?",
              }
            : {
                expiresAt: oldest.request.expiresAt,
                kind: "user_input" as const,
                oldestRequestedAt: oldest.request.createdAt,
                pendingCount: pendingInteractions.length,
                preview: oldest.request.questions[0]?.prompt ?? "This task needs your input.",
              };
        const latestEvent = run?.events.at(-1);
        return taskWorkspaceListItemSchema.parse({
          humanInput,
          run: run === undefined
            ? null
            : {
                latestDisplay: latestEvent === undefined
                  ? null
                  : {
                      kind: latestEvent.kind,
                      observedAt: latestEvent.observedAt,
                      ...("displayText" in latestEvent
                        ? { displayText: latestEvent.displayText }
                        : {}),
                    },
                phase: run.phase,
                updatedAt: run.updatedAt,
              },
          task,
        });
      });
      read = {
        cursor: state.cursor,
        kind: "ready",
        selection,
        tasks,
        view: world.activeView,
      };
    }
    return {
      actions,
      agents: world.agents,
      capabilities: world.capabilities,
      counts: world.counts,
      now: world.now,
      read,
      runner: world.runner ?? {
        presence: { serverTime: world.now, state: "offline" },
        repositories: [],
      },
      viewer: world.viewer,
      workspace: world.workspace,
    };
  }

  const dispose = (): undefined => {
    if (disposed) return undefined;
    disposed = true;
    transport.dispose();
    return undefined;
  };
  onDispose(dispose);

  const harness: AgentTasksDirectHarness = {
    actions,
    assertScriptsDrained: () => {
      const transportResult = transport.assertDrained();
      const world = store.getSnapshot().world;
      if (
        transportResult.ok
        && world.scripts.commands.length === 0
        && world.scripts.interactions.length === 0
        && world.scripts.pages.length === 0
        && world.diagnostics.violations.length === 0
      ) return;
      throw new Error([
        "The deterministic Agent Tasks runtime did not drain cleanly.",
        ...world.diagnostics.violations,
        ...(transportResult.ok ? [] : [transportResult.error.message]),
        ...(world.scripts.interactions.length === 0 ? [] : [`${String(world.scripts.interactions.length)} HITL scripts remain.`]),
        ...(world.scripts.pages.length === 0 ? [] : [`${String(world.scripts.pages.length)} page scripts remain.`]),
      ].join("\n"));
    },
    getProps,
    getSnapshot: () => {
      const world = store.getSnapshot().world;
      return Object.freeze({
        blockedNetworkRequests,
        disposed,
        listenerFailures: readListenerFailures(),
        remainingScripts: Object.freeze({
          commands: transport.remainingSteps(),
          interactions: world.scripts.interactions.length,
          pages: world.scripts.pages.length,
        }),
        requests: world.diagnostics.requests.length,
        violations: world.diagnostics.violations.length + transport.violationCount(),
      });
    },
    recordBlockedNetworkRequest: () => { blockedNetworkRequests += 1; },
  };
  return Object.freeze(harness);
}

export type AgentTasksDirectSession = DirectSession<
  AgentTasksDirectWorld,
  AgentTasksDirectRoute,
  AgentTasksDirectHarness
>;

export function createAgentTasksDirectSession(
  activation: DirectSessionActivation,
) {
  let listenerFailures = 0;
  const onListenerFailure = (): undefined => {
    listenerFailures += 1;
    return undefined;
  };
  return createDirectSession({
    definition: agentTasksDirectDefinition,
    activation,
    storeOptions: { onListenerError: onListenerFailure },
    create: (context) => createAgentTasksDirectHarness(
      context,
      onListenerFailure,
      () => listenerFailures,
    ),
    observe: (harness) => ({
      violations: [
        {
          name: "blockedNetworkRequests",
          read: () => harness.getSnapshot().blockedNetworkRequests,
        },
        {
          name: "listenerFailures",
          read: () => harness.getSnapshot().listenerFailures,
        },
        {
          name: "scenarioViolations",
          read: () => harness.getSnapshot().violations,
        },
      ],
      readRemainingWork: () => ({
        disposed: harness.getSnapshot().disposed,
        scripts: harness.getSnapshot().remainingScripts,
      }),
    }),
  });
}

export function AgentTasksDirectSurface({
  session,
}: Readonly<{ session: AgentTasksDirectSession }>) {
  useSyncExternalStore(
    session.store.subscribe,
    session.store.getSnapshot,
    session.store.getSnapshot,
  );
  return (
    <div className="workspace-panel">
      <TaskWorkspace {...session.harness.getProps()} />
    </div>
  );
}
