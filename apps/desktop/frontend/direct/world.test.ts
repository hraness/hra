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

  test("compact-chat surfaces are strict, bounded, and reference an initial pane", () => {
    const pane = {
      id: "pane_worldcompact01",
      revision: 1,
      title: "Compact",
      repository: { id: hraDirectTaskIds.repository, name: "hra" },
      accountProfileId: null,
      interactionMode: "chat" as const,
      state: "ready" as const,
      activity: { ordinal: 0, kind: "idle" as const },
      workspace: {
        mode: "managedWorktree" as const,
        state: "ready" as const,
        revision: 1,
        recoveryKind: null,
      },
      turn: null,
      attention: null,
      recoverablePrompt: false,
      messageQueue: { revision: 1, pauseReason: null, blockedMessage: null, messages: [] },
      harness: null,
    };
    const compact = createHRADirectWorld({
      surface: {
        kind: "compactChat",
        paneId: pane.id,
        paletteIndex: 8,
        nowUnixMilliseconds: 123_000,
        attachments: [{
          id: "attachment_worldcompact01",
          name: "preview.png",
          mimeType: "image/png",
          byteSize: 64,
        }],
      },
      gateway: {
        snapshots: [{ ...emptySnapshot(), chat: { revision: 1, panes: [pane] } }],
        encoding: { kind: "direct" },
        events: [],
      },
    });

    expect(compact.surface).toMatchObject({ kind: "compactChat", paletteIndex: 8 });
    expect(() => parseHRADirectWorld({
      ...compact,
      surface: { ...compact.surface, paneId: "pane_missingcompact1" },
    })).toThrow("must exist in the initial snapshot");
    expect(() => parseHRADirectWorld({
      ...compact,
      surface: compact.surface.kind === "compactChat"
        ? {
            ...compact.surface,
            attachments: [
              compact.surface.attachments[0],
              compact.surface.attachments[0],
            ],
          }
        : compact.surface,
    })).toThrow("compact-chat attachment IDs must be unique");
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
