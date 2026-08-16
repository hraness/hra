import { describe, expect, test } from "bun:test";
import type { TaskWorkspaceClientIntent } from "@hraness/agent-tasks-domain";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { taskWorkspaceReadyFixture } from "./task-workspace-fixtures";
import {
  createTaskWorkspaceViewActions,
  taskWorkspaceModelSnapshotEqual,
  TaskWorkspaceClientView,
} from "./task-workspace-client-view";
import type {
  TaskWorkspaceClient,
  TaskWorkspaceSnapshot,
} from "./task-workspace-model";

function readySnapshot(): TaskWorkspaceSnapshot {
  if (
    taskWorkspaceReadyFixture.read.kind !== "ready" ||
    taskWorkspaceReadyFixture.read.selection.kind !== "ready"
  ) {
    throw new Error("The ready task fixture must include selected detail.");
  }
  const workspaceId = taskWorkspaceReadyFixture.workspace.id;
  const revision = 9;
  const detail = taskWorkspaceReadyFixture.read.selection.detail;
  return {
    coordinate: {
      selectedTaskId: detail.task.id,
      view: "all",
      workspaceId,
    },
    dispatchError: null,
    now: taskWorkspaceReadyFixture.now,
    pendingMutation: null,
    projection: {
      continuation: { kind: "complete" },
      envelope: {
        consistency: { kind: "atomic", sourceGeneration: 1 },
        presentation: {
          agents: taskWorkspaceReadyFixture.agents,
          capabilities: taskWorkspaceReadyFixture.capabilities,
          counts: taskWorkspaceReadyFixture.counts,
          now: taskWorkspaceReadyFixture.now,
          runner: taskWorkspaceReadyFixture.runner,
          viewer: taskWorkspaceReadyFixture.viewer,
          workspace: taskWorkspaceReadyFixture.workspace,
        },
        presentationRevision: revision,
        projection: {
          continuationRevision: revision,
          detail: { ...detail, projectionRevision: revision, workspaceId },
          firstPage: {
            cursor: null,
            hasMore: false,
            items: [...taskWorkspaceReadyFixture.read.tasks],
            projectionRevision: revision,
            view: "all",
            workspaceId,
          },
          projectionRevision: revision,
          selectedTaskId: detail.task.id,
          view: "all",
          workspaceId,
        },
      },
      kind: "ready",
      pages: [{
        cursor: null,
        hasMore: false,
        items: [...taskWorkspaceReadyFixture.read.tasks],
        projectionRevision: revision,
        view: "all",
        workspaceId,
      }],
      refresh: { kind: "idle" },
    },
    sourceGeneration: 1,
  };
}

function recordingClient(
  snapshot: TaskWorkspaceSnapshot,
  intents: TaskWorkspaceClientIntent[],
): TaskWorkspaceClient {
  return {
    dispatch: (intent) => {
      intents.push(intent);
      return Promise.resolve({ ok: true, outcome: "accepted" });
    },
    dispose: () => undefined,
    retry: () => undefined,
    start: () => undefined,
    store: {
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
    },
  };
}

describe("task workspace client view intent boundary", () => {
  test("keeps expensive model projections stable across clock-only revisions", () => {
    const snapshot = readySnapshot();
    expect(taskWorkspaceModelSnapshotEqual(
      snapshot,
      { ...snapshot, now: (snapshot.now ?? 0) + 1_000 },
    )).toBeTrue();
    expect(taskWorkspaceModelSnapshotEqual(
      snapshot,
      {
        ...snapshot,
        projection: {
          ...snapshot.projection,
        },
      },
    )).toBeFalse();
  });

  test("renders a provider-neutral retry action for projection errors", () => {
    const base = readySnapshot();
    let retries = 0;
    const client: TaskWorkspaceClient = {
      ...recordingClient(base, []),
      retry: () => {
        retries += 1;
      },
      store: {
        getSnapshot: () => ({
          ...base,
          projection: {
            error: { code: "TEMPORARY_FAILURE" },
            kind: "error",
            minimumRevision: 9,
          },
        }),
        subscribe: () => () => undefined,
      },
    };

    const html = renderToStaticMarkup(
      createElement(TaskWorkspaceClientView, { client }),
    );

    expect(html).toContain("Task workspace unavailable");
    expect(html).toContain("TEMPORARY_FAILURE");
    expect(html).toContain(">Retry</button>");
    expect(retries).toBe(0);
  });

  test("translates edits and graph links into public-ID intents", async () => {
    const snapshot = readySnapshot();
    const intents: TaskWorkspaceClientIntent[] = [];
    const actions = createTaskWorkspaceViewActions(
      recordingClient(snapshot, intents),
      snapshot,
    );
    if (snapshot.projection.kind !== "ready") {
      throw new Error("Expected a ready projection.");
    }
    const detail = snapshot.projection.envelope.projection.detail;
    if (detail === null) throw new Error("Expected selected detail.");
    const dependent = detail.dependents[0]?.task;
    if (dependent === undefined) throw new Error("Expected a dependent fixture.");

    expect(await actions.updateTask({
      description: "Updated description",
      priority: 1,
      revision: detail.task.revision,
      taskKey: detail.task.key,
      title: "Updated title",
      type: "feature",
    })).toEqual({ ok: true, requestId: "accepted" });
    expect(await actions.removeBlocker({
      blockedTaskKey: dependent.key,
      blockerKey: detail.task.key,
      revision: dependent.revision,
    })).toEqual({ ok: true, requestId: "accepted" });

    expect(intents).toEqual([
      {
        expectedTaskRevision: detail.task.revision,
        kind: "task.update",
        patch: {
          description: "Updated description",
          priority: 1,
          title: "Updated title",
          type: "feature",
        },
        taskId: detail.task.id,
      },
      {
        blockerKey: detail.task.key,
        expectedTaskRevision: dependent.revision,
        kind: "dependency.remove",
        taskId: dependent.id,
      },
    ]);
  });

  test("keeps provider interaction authority out of renderer intents", async () => {
    const snapshot = readySnapshot();
    const intents: TaskWorkspaceClientIntent[] = [];
    const actions = createTaskWorkspaceViewActions(
      recordingClient(snapshot, intents),
      snapshot,
    );

    await actions.respondToRunInteraction({
      interactionId: "interaction_fixture",
      request: {
        createdAt: 1_000,
        expiresAt: 2_000,
        id: "interaction_fixture",
        kind: "file_change_approval",
        scope: "once",
      },
      response: { decision: "approve_once", kind: "file_change_approval" },
      runId: "run_fixture",
    });

    expect(intents).toEqual([{
      interactionId: "interaction_fixture",
      kind: "interaction.respond",
      response: { decision: "approve_once", kind: "file_change_approval" },
      runId: "run_fixture",
    }]);
    expect(JSON.stringify(intents)).not.toContain("expiresAt");
    expect(JSON.stringify(intents)).not.toContain("scope");
  });
});
