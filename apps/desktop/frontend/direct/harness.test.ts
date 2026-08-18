import { describe, expect, test } from "bun:test";

import type { RuntimeSnapshot } from "../../contracts/runtime";
import { createHRADirectRuntime, type HRADirectRuntime } from "./runtime";

async function readySnapshot(
  runtime: HRADirectRuntime,
  predicate: (snapshot: RuntimeSnapshot) => boolean = () => true,
): Promise<RuntimeSnapshot> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = runtime.shell.getState();
    if (state.state === "ready" && predicate(state.snapshot)) return state.snapshot;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Direct harness state did not settle.");
}

describe("HRA Direct minimal recursive harness", () => {
  test("updates only revision-fenced public settings and keeps proposals read-only", async () => {
    const runtime = createHRADirectRuntime({
      kind: "scenario",
      scenario: "harness-settings",
    });
    try {
      await runtime.shell.connect();
      const initial = await readySnapshot(runtime);
      expect(initial.harness).toEqual({
        revision: 3,
        settings: {
          revision: 2,
          recursiveSessionsEnabled: true,
          contextQuotaBytes: 16 * 1024 * 1024,
          refinementMode: "suggest",
        },
        proposals: [{
          id: "hproposal_exactcontext01",
          revision: 1,
          title: "Prefer exact context slices",
        }],
      });

      const updated = await runtime.shell.dispatch({
        type: "harness.settings.update",
        expectedHarnessRevision: 3,
        expectedRevision: 2,
        recursiveSessionsEnabled: true,
        contextQuotaBytes: 32 * 1024 * 1024,
        refinementMode: "off",
      });
      expect(updated).toMatchObject({
        ok: true,
        result: {
          type: "harnessSettings",
          harnessRevision: 4,
          settings: { revision: 3, contextQuotaBytes: 32 * 1024 * 1024 },
        },
      });
      const settled = await readySnapshot(runtime, (snapshot) =>
        snapshot.harness?.revision === 4
      );
      expect(settled.harness?.proposals).toEqual(initial.harness?.proposals);

      const stale = await runtime.shell.dispatch({
        type: "harness.settings.update",
        expectedHarnessRevision: 3,
        expectedRevision: 2,
        recursiveSessionsEnabled: false,
        contextQuotaBytes: 8 * 1024 * 1024,
        refinementMode: "suggest",
      });
      expect(stale).toMatchObject({ ok: false, error: { code: "stale_revision" } });
    } finally {
      runtime.dispose();
    }
  });

  test("stops a failed persistent child and opens it without admitting it early", async () => {
    const runtime = createHRADirectRuntime({
      kind: "scenario",
      scenario: "harness-children-mixed",
    });
    try {
      await runtime.shell.connect();
      const initial = await readySnapshot(runtime);
      const parent = initial.chat.panes[0]!;
      const failed = parent.harness!.descendants.children.find(
        ({ state }) => state === "failed",
      )!;
      expect(initial.chat.panes).toHaveLength(1);
      expect(failed).toMatchObject({ canStop: true, openedPaneId: null });

      const stopped = await runtime.shell.dispatch({
        type: "harness.child.stop",
        parentPaneId: parent.id,
        childId: failed.id,
        expectedParentRevision: parent.revision,
        expectedChildRevision: failed.revision,
      });
      expect(stopped).toMatchObject({
        ok: true,
        result: { type: "harnessChild", child: { state: "stopped", canStop: false } },
      });
      const afterStop = await readySnapshot(runtime, (snapshot) =>
        snapshot.chat.panes[0]?.revision === parent.revision + 1
      );
      const stoppedChild = afterStop.chat.panes[0]!.harness!.descendants.children.find(
        ({ id }) => id === failed.id,
      )!;

      const opened = await runtime.shell.dispatch({
        type: "harness.child.open",
        parentPaneId: parent.id,
        childId: stoppedChild.id,
        expectedParentRevision: afterStop.chat.panes[0]!.revision,
        expectedChildRevision: stoppedChild.revision,
      });
      expect(opened).toMatchObject({
        ok: true,
        result: {
          type: "harnessChildOpened",
          child: { state: "stopped", canStop: false },
          pane: { title: stoppedChild.title, harness: null },
        },
      });
      const afterOpen = await readySnapshot(runtime, (snapshot) => snapshot.chat.panes.length === 2);
      expect(afterOpen.chat.panes[0]?.harness?.descendants.children.find(
        ({ id }) => id === failed.id,
      )?.openedPaneId).toBe(afterOpen.chat.panes[1]?.id);
    } finally {
      runtime.dispose();
    }
  });

  test("rejects stop for exactly the stopped and quarantined terminal states", async () => {
    for (const terminalState of ["stopped", "quarantined"] as const) {
      const runtime = createHRADirectRuntime({
        kind: "scenario",
        scenario: "harness-children-mixed",
      });
      try {
        await runtime.shell.connect();
        const initial = await readySnapshot(runtime);
        const parent = initial.chat.panes[0]!;
        const child = parent.harness!.descendants.children.find(
          ({ state }) => state === terminalState,
        )!;
        expect(await runtime.shell.dispatch({
          type: "harness.child.stop",
          parentPaneId: parent.id,
          childId: child.id,
          expectedParentRevision: parent.revision,
          expectedChildRevision: child.revision,
        })).toMatchObject({ ok: false, error: { code: "terminal" } });
      } finally {
        runtime.dispose();
      }
    }
  });
});
