import { describe, expect, test } from "bun:test";
import { taskWorkspaceViewValues } from "@hraness/agent-tasks-protocol";

import {
  createHRADirectWorld,
  emptySnapshot,
  fixtureAccount,
  fixtureCurrentRunTaskChange,
  hraDirectTaskIds,
  parseHRADirectWorld,
} from "./world";

describe("HRA Direct world", () => {
  test("strictly parses and clones its versioned JSON boundary", () => {
    const world = createHRADirectWorld();
    const parsed = parseHRADirectWorld(JSON.parse(JSON.stringify(world)) as unknown);

    expect(parsed).toEqual(world);
    expect(parsed).not.toBe(world);
    expect(parsed.gateway).not.toBe(world.gateway);
    expect(() => parseHRADirectWorld({ ...world, surprise: true })).toThrow();
    expect(() => parseHRADirectWorld({ ...world, version: 1 })).toThrow();
  });

  test("rejects ambiguous profile selection and sequence regression", () => {
    const first = fixtureAccount({ id: "acct_fixture01", label: "First", selected: true });
    const second = fixtureAccount({ id: "acct_fixture02", label: "Second", selected: true });
    expect(() => createHRADirectWorld({
      gateway: {
        snapshots: [{ ...emptySnapshot(), accounts: [first, second] }],
        encoding: { kind: "direct" },
        events: [],
      },
    })).toThrow("cannot select more than one account");

    expect(() => createHRADirectWorld({
      gateway: {
        snapshots: [emptySnapshot(undefined, 4), emptySnapshot(undefined, 3)],
        encoding: { kind: "direct" },
        events: [],
      },
    })).toThrow("must not regress");
  });

  test("produces the real composite current-run benchmark change", () => {
    expect(fixtureCurrentRunTaskChange(12)).toEqual({
      workspaceId: hraDirectTaskIds.workspace,
      projectionRevision: 12,
      scope: "task_change",
      taskId: hraDirectTaskIds.currentTask,
      runId: hraDirectTaskIds.currentRun,
      changeKind: "run.display_changed",
      affectedProjections: [{
        projection: "task_list",
        views: [...taskWorkspaceViewValues],
      }, {
        projection: "task_detail",
      }],
    });
  });
});
