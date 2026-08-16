"use client";

import type {
  TaskPublicId,
  TaskWorkspaceClientIntent,
} from "@hraness/agent-tasks-domain";
import { Button, InlineAlert } from "@hra-internal/design-kit/react";
import { useMemo } from "react";

import { TaskWorkspace as TaskWorkspaceView } from "./task-workspace";
import type {
  TaskWorkspaceClient,
  TaskWorkspaceDispatchResult,
  TaskWorkspaceSnapshot,
} from "./task-workspace-model";
import type {
  TaskWorkspaceActionResult,
  TaskWorkspaceActions,
  TaskWorkspaceCapabilities,
  TaskWorkspaceReadState,
} from "./task-workspace-state";
import { useTaskWorkspaceSelector } from "./use-task-workspace-selector";

export type TaskWorkspaceClientViewProps = Readonly<{
  client: TaskWorkspaceClient;
}>;

export type { TaskWorkspacePresentation } from "./task-workspace-model";

const selectSnapshot = (snapshot: TaskWorkspaceSnapshot): TaskWorkspaceSnapshot =>
  snapshot;
const selectNow = (snapshot: TaskWorkspaceSnapshot): number | null =>
  snapshot.now;

/**
 * The authority clock advances independently of durable task state. Retain
 * the last task-state root so clock ticks do not rebuild flattened pages,
 * action closures, or capability projections.
 */
export function taskWorkspaceModelSnapshotEqual(
  left: TaskWorkspaceSnapshot,
  right: TaskWorkspaceSnapshot,
): boolean {
  return left.coordinate === right.coordinate &&
    left.dispatchError === right.dispatchError &&
    left.pendingMutation === right.pendingMutation &&
    left.projection === right.projection &&
    left.sourceGeneration === right.sourceGeneration;
}

function actionResult(
  result: TaskWorkspaceDispatchResult,
): TaskWorkspaceActionResult {
  if (!result.ok) return result;
  return {
    ok: true,
    requestId: result.outcome === "committed"
      ? result.result.operationId
      : "accepted",
  };
}

function readState(snapshot: TaskWorkspaceSnapshot): TaskWorkspaceReadState {
  const { projection } = snapshot;
  if (projection.kind === "loading") {
    return { kind: "loading", view: snapshot.coordinate.view };
  }
  if (projection.kind === "error") {
    return {
      error: projection.error,
      kind: "error",
      view: snapshot.coordinate.view,
    };
  }

  const tasks = projection.pages.flatMap((page) => page.items);
  const detail = projection.envelope.projection.detail;
  const selection = detail === null
    ? { kind: "none" as const }
    : { detail, kind: "ready" as const };
  const cursor = projection.continuation.kind === "idle" ||
      projection.continuation.kind === "error"
    ? projection.continuation.cursor
    : null;
  return {
    cursor,
    kind: "ready",
    selection,
    tasks,
    view: snapshot.coordinate.view,
  };
}

function targetTaskId(
  snapshot: TaskWorkspaceSnapshot,
  taskKey: string,
): TaskPublicId | null {
  const projection = snapshot.projection;
  if (projection.kind !== "ready") return null;
  const detail = projection.envelope.projection.detail;
  const selected = detail?.task;
  if (selected?.key === taskKey) return selected.id;
  if (detail !== null) {
    const linked = [
      ...(detail.parent === null ? [] : [detail.parent]),
      ...detail.children,
      ...detail.blockers.map(({ task }) => task),
      ...detail.dependents.map(({ task }) => task),
    ].find((task) => task.key === taskKey);
    if (linked !== undefined) return linked.id;
  }
  for (const page of projection.pages) {
    const item = page.items.find(({ task }) => task.key === taskKey);
    if (item !== undefined) return item.task.id;
  }
  return null;
}

function targetError(): TaskWorkspaceActionResult {
  return { error: { code: "TASK_NOT_FOUND" }, ok: false };
}

function mutationCapabilities(
  snapshot: TaskWorkspaceSnapshot,
  configured: TaskWorkspaceCapabilities,
): TaskWorkspaceCapabilities {
  const mutable = snapshot.pendingMutation === null &&
    snapshot.projection.kind === "ready" &&
    snapshot.projection.refresh.kind === "idle";
  if (mutable) return configured;
  return {
    canAssign: false,
    canCancel: false,
    canComment: false,
    canCreate: false,
    canEdit: false,
    canManageGraph: false,
    canManageLabels: false,
    canManageReferences: false,
    canReopen: false,
    canReview: false,
  };
}

export function createTaskWorkspaceViewActions(
  client: TaskWorkspaceClient,
  snapshot: TaskWorkspaceSnapshot,
): TaskWorkspaceActions {
  const dispatch = async (
    intent: TaskWorkspaceClientIntent,
  ): Promise<TaskWorkspaceActionResult> =>
    actionResult(await client.dispatch(intent));
  const withTask = async (
    taskKey: string,
    intent: (taskId: TaskPublicId) => TaskWorkspaceClientIntent,
  ): Promise<TaskWorkspaceActionResult> => {
    const taskId = targetTaskId(snapshot, taskKey);
    return taskId === null ? targetError() : dispatch(intent(taskId));
  };

  return Object.freeze({
    abandonAmbiguousRun: async (input) => {
      const task = snapshot.projection.kind === "ready"
        ? snapshot.projection.envelope.projection.detail?.task
        : undefined;
      return task === undefined
        ? targetError()
        : dispatch({
            expectedTaskRevision: input.taskRevision,
            kind: "dispatch.resolve_ambiguity",
            reason: input.reason,
            sourceRunId: input.runId,
            taskId: task.id,
          });
    },
    acceptSubmission: async (input) => withTask(input.taskKey, (taskId) => ({
      expectedReviewRevision: input.reviewRevision,
      kind: "review.accept",
      submissionId: input.submissionId,
      taskId,
    })),
    addBlocker: async (input) => withTask(input.taskKey, (taskId) => ({
      blockerKey: input.blockerKey,
      expectedTaskRevision: input.revision,
      kind: "dependency.add",
      taskId,
    })),
    addComment: async (input) => withTask(input.taskKey, (taskId) => ({
      body: input.body,
      kind: "task.comment_add",
      taskId,
    })),
    addLabel: async (input) => withTask(input.taskKey, (taskId) => ({
      expectedTaskRevision: input.revision,
      kind: "task.label_add",
      label: input.label,
      taskId,
    })),
    addReference: async (input) => withTask(input.taskKey, (taskId) => ({
      expectedTaskRevision: input.revision,
      kind: "task.reference_add",
      reference: input.reference,
      taskId,
    })),
    cancelTask: async (input) => withTask(input.taskKey, (taskId) => ({
      expectedTaskRevision: input.revision,
      kind: "task.cancel",
      reason: input.reason,
      taskId,
    })),
    clearParent: async (input) => withTask(input.taskKey, (taskId) => ({
      expectedTaskRevision: input.revision,
      kind: "task.parent_clear",
      taskId,
    })),
    createTask: async (input) => dispatch({
      ...(input.availableAt === undefined
        ? {}
        : { availableAt: input.availableAt }),
      ...(input.description.length === 0
        ? {}
        : { description: input.description }),
      ...(input.parentKey === undefined ? {} : { parentKey: input.parentKey }),
      ...(input.repositoryId === undefined
        ? {}
        : { repositoryId: input.repositoryId }),
      kind: "task.create",
      labels: [...input.labels],
      priority: input.priority,
      title: input.title,
      type: input.type,
    }),
    deferTask: async (input) => withTask(input.taskKey, (taskId) => ({
      availableAt: input.availableAt,
      expectedTaskRevision: input.revision,
      kind: "task.defer",
      taskId,
    })),
    loadMore: () => {
      void client.dispatch({ kind: "page.load_more" });
    },
    rejectSubmission: async (input) => withTask(input.taskKey, (taskId) => ({
      expectedReviewRevision: input.reviewRevision,
      kind: "review.reject",
      reason: input.reason,
      submissionId: input.submissionId,
      taskId,
    })),
    removeBlocker: async (input) => withTask(
      input.blockedTaskKey,
      (taskId) => ({
        blockerKey: input.blockerKey,
        expectedTaskRevision: input.revision,
        kind: "dependency.remove",
        taskId,
      }),
    ),
    removeLabel: async (input) => withTask(input.taskKey, (taskId) => ({
      expectedTaskRevision: input.revision,
      kind: "task.label_remove",
      label: input.label,
      taskId,
    })),
    removeReference: async (input) => withTask(input.taskKey, (taskId) => ({
      expectedTaskRevision: input.revision,
      kind: "task.reference_remove",
      referenceId: input.referenceId,
      taskId,
    })),
    reopenTask: async (input) => withTask(input.taskKey, (taskId) => ({
      expectedTaskRevision: input.revision,
      kind: "task.reopen",
      taskId,
    })),
    requestRunStop: async (input) => dispatch({
      kind: "dispatch.stop",
      runId: input.runId,
    }),
    respondToRunInteraction: async (input) => dispatch({
      interactionId: input.interactionId,
      kind: "interaction.respond",
      response: input.response,
      runId: input.runId,
    }),
    retryRun: async (input) => {
      const task = snapshot.projection.kind === "ready"
        ? snapshot.projection.envelope.projection.detail?.task
        : undefined;
      return task === undefined
        ? targetError()
        : dispatch({
            expectedTaskRevision: input.taskRevision,
            kind: "dispatch.retry",
            sourceRunId: input.runId,
            taskId: task.id,
          });
    },
    selectTask: (taskKey) => {
      const taskId = taskKey === null ? null : targetTaskId(snapshot, taskKey);
      if (taskKey !== null && taskId === null) return;
      void client.dispatch({ kind: "task.select", taskId });
    },
    setAssignee: async (input) => withTask(input.taskKey, (taskId) => ({
      assigneeAgentId: input.agentId,
      expectedTaskRevision: input.revision,
      kind: "task.assign",
      taskId,
    })),
    setParent: async (input) => withTask(input.taskKey, (taskId) => ({
      expectedTaskRevision: input.revision,
      kind: "task.parent_set",
      parentKey: input.parentKey,
      taskId,
    })),
    updateTask: async (input) => withTask(input.taskKey, (taskId) => ({
      expectedTaskRevision: input.revision,
      kind: "task.update",
      patch: {
        description: input.description,
        priority: input.priority,
        title: input.title,
        type: input.type,
      },
      taskId,
    })),
    viewChanged: (view) => {
      void client.dispatch({ kind: "view.select", view });
    },
  });
}

function refreshError(snapshot: TaskWorkspaceSnapshot) {
  if (snapshot.projection.kind !== "ready") return null;
  if (snapshot.projection.refresh.kind === "error") {
    return snapshot.projection.refresh.error;
  }
  if (snapshot.projection.continuation.kind === "error") {
    return snapshot.projection.continuation.error;
  }
  return null;
}

/**
 * Provider-free production feature boundary. React renders one immutable
 * client snapshot and emits only the closed task intent union.
 */
export function TaskWorkspaceClientView({
  client,
}: TaskWorkspaceClientViewProps) {
  const fallbackSnapshot = client.store.getSnapshot();
  const snapshot = useTaskWorkspaceSelector(
    client.store,
    selectSnapshot,
    {
      fallbackSnapshot,
      isEqual: taskWorkspaceModelSnapshotEqual,
      serverSnapshot: fallbackSnapshot,
    },
  );
  const now = useTaskWorkspaceSelector(
    client.store,
    selectNow,
    { fallbackSnapshot, serverSnapshot: fallbackSnapshot },
  );
  const actions = useMemo(
    () => createTaskWorkspaceViewActions(client, snapshot),
    [client, snapshot],
  );
  const read = useMemo(() => readState(snapshot), [snapshot]);
  const presentation = snapshot.projection.kind === "ready"
    ? snapshot.projection.envelope.presentation
    : null;
  const capabilities = useMemo(
    () => presentation === null
      ? null
      : mutationCapabilities(snapshot, presentation.capabilities),
    [presentation, snapshot],
  );
  const error = refreshError(snapshot);

  if (snapshot.projection.kind === "loading") {
    return <div role="status">Loading task workspace…</div>;
  }
  if (
    snapshot.projection.kind === "error" ||
    presentation === null ||
    capabilities === null ||
    now === null
  ) {
    const boundaryError = snapshot.projection.kind === "error"
      ? snapshot.projection.error
      : { code: "INVALID_PROJECTION" };
    return (
      <InlineAlert isLive title="Task workspace unavailable" tone="danger">
        {boundaryError.code}
        <Button onPress={client.retry} size="compact" variant="quiet">
          Retry
        </Button>
      </InlineAlert>
    );
  }

  return (
    <>
      {error === null ? null : (
        <InlineAlert isLive title="Task view needs refresh" tone="warning">
          {error.code}
          <Button onPress={client.retry} size="compact" variant="quiet">
            Retry
          </Button>
        </InlineAlert>
      )}
      {snapshot.pendingMutation?.phase !== "outcome_unknown" ? null : (
        <InlineAlert isLive title="Task change outcome is unknown" tone="danger">
          HRA stopped further task changes because the authority may have
          committed the last request. Reopen the workspace after checking its
          current state.
        </InlineAlert>
      )}
      <TaskWorkspaceView
        actions={actions}
        agents={presentation.agents}
        capabilities={capabilities}
        counts={presentation.counts}
        now={now}
        read={read}
        runner={presentation.runner}
        viewer={presentation.viewer}
        workspace={presentation.workspace}
      />
    </>
  );
}
