import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import type { TaskWorkspaceSnapshot } from "./task-workspace-model";
import {
  createTaskWorkspaceSelectorReader,
  useTaskWorkspaceSelector,
} from "./use-task-workspace-selector";

function loadingSnapshot(sourceGeneration: number): TaskWorkspaceSnapshot {
  return {
    coordinate: {
      selectedTaskId: null,
      view: "all",
      workspaceId: "wsp_00000000000000000000000000",
    },
    dispatchError: null,
    now: null,
    pendingMutation: null,
    projection: { kind: "loading", minimumRevision: null },
    sourceGeneration,
  };
}

describe("task workspace selector", () => {
  test("retains equal selected identities across root revisions", () => {
    let root = { sourceGeneration: 1, state: "loading" };
    let calls = 0;
    const read = createTaskWorkspaceSelectorReader(
      () => root,
      (snapshot) => {
        calls += 1;
        return { state: snapshot.state };
      },
      (left, right) => left.state === right.state,
    );

    const first = read();
    expect(read()).toBe(first);
    expect(calls).toBe(1);
    root = { sourceGeneration: 2, state: "loading" };
    expect(read()).toBe(first);
    expect(calls).toBe(2);
    root = { sourceGeneration: 3, state: "ready" };
    expect(read()).toEqual({ state: "ready" });
  });

  test("reuses a committed identity after selector replacement", () => {
    const committed = { state: "loading" };
    const read = createTaskWorkspaceSelectorReader(
      () => ({ sourceGeneration: 1, state: "loading" }),
      (snapshot) => ({ state: snapshot.state }),
      (left, right) => left.state === right.state,
      () => ({ hasValue: true, value: committed }),
    );

    expect(read()).toBe(committed);
  });

  test("uses explicit stable server and fallback snapshots", () => {
    const fallbackSnapshot = loadingSnapshot(1);
    const serverSnapshot = loadingSnapshot(2);
    function Probe(): ReturnType<typeof createElement> {
      const generation = useTaskWorkspaceSelector(
        null,
        (snapshot) => snapshot.sourceGeneration,
        { fallbackSnapshot, serverSnapshot },
      );
      return createElement("span", null, String(generation));
    }

    expect(renderToString(createElement(Probe))).toBe("<span>2</span>");
    expect(fallbackSnapshot).toBe(fallbackSnapshot);
    expect(serverSnapshot).toBe(serverSnapshot);
  });
});
