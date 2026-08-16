import { describe, expect, test } from "bun:test";
import {
  TaskWorkspaceClientView,
  createTaskWorkspaceClientHost,
  type TaskWorkspaceClient,
  type TaskWorkspaceSnapshot,
} from "@hraness/agent-tasks-ui";
import type { TaskListPage } from "@hraness/agent-tasks-domain";
import {
  taskWorkspaceReadyFixture,
} from "@hraness/agent-tasks-ui/fixtures";
import { renderToStaticMarkup } from "react-dom/server";

function readySnapshot(
  revision: number,
  allCount = taskWorkspaceReadyFixture.counts.all,
): TaskWorkspaceSnapshot {
  const read = taskWorkspaceReadyFixture.read;
  if (read.kind !== "ready" || read.selection.kind !== "ready") {
    throw new Error("The ready task fixture must include selected detail.");
  }
  const workspaceId = taskWorkspaceReadyFixture.workspace.id;
  const detail = read.selection.detail;
  const firstPage: TaskListPage = {
    cursor: read.cursor,
    hasMore: read.cursor !== null,
    items: [...read.tasks],
    projectionRevision: revision,
    view: read.view,
    workspaceId,
  };
  return {
    coordinate: {
      selectedTaskId: detail.task.id,
      view: read.view,
      workspaceId,
    },
    dispatchError: null,
    now: taskWorkspaceReadyFixture.now,
    pendingMutation: null,
    projection: {
      continuation: read.cursor === null
        ? { kind: "complete" }
        : { cursor: read.cursor, kind: "idle" },
      envelope: {
        consistency: { kind: "atomic", sourceGeneration: 1 },
        presentation: {
          agents: taskWorkspaceReadyFixture.agents,
          capabilities: taskWorkspaceReadyFixture.capabilities,
          counts: {
            ...taskWorkspaceReadyFixture.counts,
            all: allCount,
          },
          now: taskWorkspaceReadyFixture.now,
          runner: taskWorkspaceReadyFixture.runner,
          viewer: taskWorkspaceReadyFixture.viewer,
          workspace: taskWorkspaceReadyFixture.workspace,
        },
        presentationRevision: revision,
        projection: {
          continuationRevision: revision,
          detail: { ...detail, projectionRevision: revision, workspaceId },
          firstPage,
          projectionRevision: revision,
          selectedTaskId: detail.task.id,
          view: read.view,
          workspaceId,
        },
      },
      kind: "ready",
      pages: [firstPage],
      refresh: { kind: "idle" },
    },
    sourceGeneration: 1,
  };
}

function clientFor(
  snapshot: TaskWorkspaceSnapshot,
  lifecycle: { disposes: number; starts: number } = { disposes: 0, starts: 0 },
): TaskWorkspaceClient {
  return {
    dispatch: () => Promise.resolve({ ok: true, outcome: "accepted" }),
    dispose: () => {
      lifecycle.disposes += 1;
    },
    retry: () => undefined,
    start: () => {
      lifecycle.starts += 1;
    },
    store: {
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
    },
  };
}

describe("hosted task workspace client presentation", () => {
  test("keeps loading and domain failures accessible through the client boundary", () => {
    const base = readySnapshot(9);
    const loading = renderToStaticMarkup(
      <TaskWorkspaceClientView
        client={clientFor({
          ...base,
          projection: { kind: "loading", minimumRevision: null },
        })}
      />,
    );
    const error = renderToStaticMarkup(
      <TaskWorkspaceClientView
        client={clientFor({
          ...base,
          projection: {
            error: { code: "SERVICE_UNAVAILABLE", reference: "req_fixture" },
            kind: "error",
            minimumRevision: 9,
          },
        })}
      />,
    );
    expect(loading).toContain('role="status"');
    expect(error).toContain('role="alert"');
    expect(error).toContain("SERVICE_UNAVAILABLE");
    expect(error).toContain(">Retry</button>");
  });

  test("renders counts and identities from the same coherent client snapshot", () => {
    const html = renderToStaticMarkup(
      <TaskWorkspaceClientView
        client={clientFor(readySnapshot(9, { capped: true, value: 3 }))}
      />,
    );
    expect(html).toContain("All · 3+</option>");
    expect(html).toContain("Human · Mara Chen");
    expect(html).toContain("Agent · Build Scout");
    expect(html).toContain("System · claim expiry");
  });

  test("survives an effect setup-cleanup-setup replay with a fresh client", () => {
    const workspaceId = taskWorkspaceReadyFixture.workspace.id;
    const host = createTaskWorkspaceClientHost({
      selectedTaskId: null,
      view: "all",
      workspaceId,
    });
    const firstLifecycle = { disposes: 0, starts: 0 };
    const secondLifecycle = { disposes: 0, starts: 0 };

    const cleanupFirst = host.install(clientFor(readySnapshot(9), firstLifecycle));
    cleanupFirst();
    const cleanupSecond = host.install(clientFor(readySnapshot(10), secondLifecycle));

    expect(firstLifecycle).toEqual({ disposes: 1, starts: 1 });
    expect(secondLifecycle).toEqual({ disposes: 0, starts: 1 });
    const projection = host.client.store.getSnapshot().projection;
    expect(projection.kind).toBe("ready");
    if (projection.kind !== "ready") {
      throw new Error("The replacement client projection must be ready.");
    }
    expect(projection.envelope.projection.projectionRevision).toBe(10);

    cleanupFirst();
    expect(secondLifecycle.disposes).toBe(0);
    cleanupSecond();
    expect(secondLifecycle.disposes).toBe(1);
  });
});
