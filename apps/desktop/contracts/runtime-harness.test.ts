import { describe, expect, test } from "bun:test";

import {
  harnessChildProjectionSchema,
  harnessDescendantsProjectionSchema,
  harnessSnapshotSchema,
  parseRuntimeDispatchRequest,
  parseRuntimeHarnessDispatchResponseForRequest,
  parseRuntimeSnapshotResponse,
  runtimeHarnessChildProjectionLimit,
  runtimeProtocolVersion,
  type ChatPaneProjection,
  type RuntimeHarnessDispatchRequest,
} from "./runtime";

const settings = {
  revision: 3,
  recursiveSessionsEnabled: true,
  automaticFastMode: "criticalPath",
  contextQuotaBytes: 16 * 1024 * 1024,
  refinementMode: "suggest",
} as const;

const managedWorkspace = {
  mode: "managedWorktree",
  state: "ready",
  revision: 1,
  recoveryKind: null,
} as const;

const child = {
  id: "hactor_child00000001",
  revision: 2,
  title: "Audit the replay law",
  state: "idle",
  openedPaneId: null,
  canOpen: true,
  canMessage: false,
  canStop: true,
} as const;

function pane(
  id = "pane_harnessparent1",
  harness: ChatPaneProjection["harness"] = {
    revision: 3,
    descendants: { count: 1, truncated: false, children: [child] },
  },
): ChatPaneProjection {
  return {
    id,
    revision: 7,
    title: "Recursive audit",
    repository: { id: "repo_00000000000000000000000000", name: "example" },
    accountProfileId: null,
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    serviceTier: "standard",
    interactionMode: "chat",
    state: "ready",
    activity: { ordinal: 0, kind: "idle" },
    workspace: managedWorkspace,
    turn: null,
    attention: null,
    recoverablePrompt: false,
    harness,
  };
}

function snapshot(panes: readonly ChatPaneProjection[] = [pane()]) {
  return {
    revision: 1,
    lastSequence: 0,
    runtime: { state: "ready", generation: 1 },
    runner: { state: "connected" },
    accounts: [],
    retainedAccountLocalData: [],
    humanAccount: { state: "signedOut", revision: 0 },
    chat: { revision: 1, panes },
    harness: {
      revision: 4,
      settings,
      proposals: [{
        id: "hproposal_exactcontext01",
        revision: 1,
        title: "Prefer exact context slices",
      }],
    },
  } as const;
}

function request(
  operationId: string,
  command: RuntimeHarnessDispatchRequest["command"],
): RuntimeHarnessDispatchRequest {
  return { version: runtimeProtocolVersion, operationId, command };
}

describe("minimal recursive harness renderer contract", () => {
  test("projects only settings, read-only proposal summaries, and bounded descendants", () => {
    const parsed = parseRuntimeSnapshotResponse({
      version: runtimeProtocolVersion,
      snapshot: snapshot(),
    }).snapshot;

    expect(parsed.harness?.settings).toEqual(settings);
    expect(parsed.harness?.proposals).toEqual([{
      id: "hproposal_exactcontext01",
      revision: 1,
      title: "Prefer exact context slices",
    }]);
    expect(parsed.chat.panes[0]?.harness?.descendants.children).toEqual([child]);
    expect(Object.keys(parsed.chat.panes[0]!.harness!).toSorted()).toEqual([
      "descendants",
      "revision",
    ]);
    expect(Object.keys(parsed.harness!.proposals[0]!).toSorted()).toEqual([
      "id",
      "revision",
      "title",
    ]);
  });

  test("keeps ordinary panes free of harness chrome", () => {
    const ordinary = pane("pane_ordinary0000001", null);
    expect(parseRuntimeSnapshotResponse({
      version: runtimeProtocolVersion,
      snapshot: snapshot([ordinary]),
    }).snapshot.chat.panes[0]?.harness).toBeNull();
  });

  test("keeps failed persistent actors stoppable and only terminal actors inert", () => {
    for (const state of ["starting", "running", "waiting", "idle", "failed"] as const) {
      expect(harnessChildProjectionSchema.parse({
        ...child,
        state,
        canOpen: state === "idle" || state === "failed",
      }).canStop).toBeTrue();
    }
    for (const state of ["stopped", "quarantined"] as const) {
      expect(harnessChildProjectionSchema.parse({
        ...child,
        state,
        canOpen: false,
        canMessage: false,
        canStop: false,
      }).canStop).toBeFalse();
      expect(() => harnessChildProjectionSchema.parse({
        ...child,
        state,
        canOpen: false,
      })).toThrow();
    }
  });

  test("makes Open and Message an explicit mutually exclusive action set", () => {
    expect(harnessChildProjectionSchema.parse(child)).toMatchObject({
      canOpen: true,
      canMessage: false,
      openedPaneId: null,
    });
    expect(harnessChildProjectionSchema.parse({
      ...child,
      openedPaneId: "pane_harnesschild01",
      canOpen: false,
      canMessage: true,
    })).toMatchObject({
      canOpen: false,
      canMessage: true,
    });
    expect(() => harnessChildProjectionSchema.parse({
      ...child,
      canOpen: true,
      canMessage: true,
    })).toThrow();
    expect(() => harnessChildProjectionSchema.parse({
      ...child,
      state: "running",
      canOpen: true,
    })).toThrow();
  });

  test("makes descendant capacity, truncation, identity, and opened panes exact", () => {
    const children = Array.from({ length: runtimeHarnessChildProjectionLimit }, (_, index) => ({
      ...child,
      id: `hactor_child${String(index).padStart(8, "0")}`,
      title: `Child ${String(index + 1)}`,
    }));
    expect(harnessDescendantsProjectionSchema.parse({
      count: children.length,
      truncated: false,
      children,
    }).children).toHaveLength(runtimeHarnessChildProjectionLimit);
    expect(() => harnessDescendantsProjectionSchema.parse({
      count: children.length + 1,
      truncated: false,
      children,
    })).toThrow();
    expect(() => harnessDescendantsProjectionSchema.parse({
      count: 2,
      truncated: false,
      children: [child, { ...child, title: "Duplicate" }],
    })).toThrow();
    expect(() => parseRuntimeSnapshotResponse({
      version: runtimeProtocolVersion,
      snapshot: snapshot([pane("pane_harnessparent1", {
        revision: 3,
        descendants: {
          count: 1,
          truncated: false,
          children: [{
            ...child,
            openedPaneId: "pane_missing0000001",
            canOpen: false,
            canMessage: true,
          }],
        },
      })]),
    })).toThrow("opened harness children");
  });

  test("admits exactly the three revision-fenced command families", () => {
    const commands = [{
      type: "harness.settings.update",
      expectedHarnessRevision: 4,
      expectedRevision: 3,
      recursiveSessionsEnabled: false,
      automaticFastMode: "off",
      contextQuotaBytes: 8 * 1024 * 1024,
      refinementMode: "off",
    }, {
      type: "harness.child.open",
      parentPaneId: "pane_harnessparent1",
      childId: child.id,
      expectedParentRevision: 7,
      expectedChildRevision: child.revision,
    }, {
      type: "harness.child.stop",
      parentPaneId: "pane_harnessparent1",
      childId: child.id,
      expectedParentRevision: 7,
      expectedChildRevision: child.revision,
    }] as const;
    expect(commands.map((command, index) => parseRuntimeDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: `op_harnessaction${String(index).padStart(2, "0")}`,
      command,
    }).command.type)).toEqual(commands.map(({ type }) => type));

    for (const type of [
      "harness.candidate.review",
      "harness.candidate.decide",
      "harness.goal.stop",
      "harness.data.preview",
      "harness.data.delete",
      "harness.tree.stop",
      "harness.sync",
    ]) {
      expect(() => parseRuntimeDispatchRequest({
        version: runtimeProtocolVersion,
        operationId: "op_harnesslegacy01",
        command: { type },
      })).toThrow();
    }
  });

  test("correlates settings and child results to exact identities and revisions", () => {
    const settingsRequest = request("op_harnesssettings1", {
      type: "harness.settings.update",
      expectedHarnessRevision: 4,
      expectedRevision: 3,
      recursiveSessionsEnabled: false,
      automaticFastMode: "off",
      contextQuotaBytes: 8 * 1024 * 1024,
      refinementMode: "off",
    });
    expect(parseRuntimeHarnessDispatchResponseForRequest({
      version: runtimeProtocolVersion,
      operationId: settingsRequest.operationId,
      ok: true,
      result: {
        type: "harnessSettings",
        harnessRevision: 5,
        settings: {
          revision: 4,
          recursiveSessionsEnabled: false,
          automaticFastMode: "off",
          contextQuotaBytes: 8 * 1024 * 1024,
          refinementMode: "off",
        },
      },
    }, settingsRequest).ok).toBeTrue();
    expect(() => parseRuntimeHarnessDispatchResponseForRequest({
      version: runtimeProtocolVersion,
      operationId: settingsRequest.operationId,
      ok: true,
      result: {
        type: "harnessSettings",
        harnessRevision: 5,
        settings: {
          revision: 4,
          recursiveSessionsEnabled: false,
          automaticFastMode: "criticalPath",
          contextQuotaBytes: 8 * 1024 * 1024,
          refinementMode: "off",
        },
      },
    }, settingsRequest)).toThrow("settings update");

    const openRequest = request("op_harnessopen0001", {
      type: "harness.child.open",
      parentPaneId: "pane_harnessparent1",
      childId: child.id,
      expectedParentRevision: 7,
      expectedChildRevision: 2,
    });
    const openedPane = pane("pane_harnesschild01", null);
    const openResponse = {
      version: runtimeProtocolVersion,
      operationId: openRequest.operationId,
      ok: true,
      result: {
        type: "harnessChildOpened",
        parentPaneId: "pane_harnessparent1",
        parentRevision: 8,
        child: {
          ...child,
          revision: 3,
          openedPaneId: openedPane.id,
          canOpen: false,
          canMessage: true,
        },
        pane: openedPane,
      },
    } as const;
    expect(parseRuntimeHarnessDispatchResponseForRequest(openResponse, openRequest).ok)
      .toBeTrue();
    expect(() => parseRuntimeHarnessDispatchResponseForRequest({
      ...openResponse,
      result: {
        ...openResponse.result,
        parentRevision: 9,
      },
    }, openRequest)).toThrow("child open");

    const stopRequest = request("op_harnessstop0001", {
      type: "harness.child.stop",
      parentPaneId: "pane_harnessparent1",
      childId: child.id,
      expectedParentRevision: 7,
      expectedChildRevision: 2,
    });
    expect(parseRuntimeHarnessDispatchResponseForRequest({
      version: runtimeProtocolVersion,
      operationId: stopRequest.operationId,
      ok: true,
      result: {
        type: "harnessChild",
        parentPaneId: "pane_harnessparent1",
        parentRevision: 8,
        child: {
          ...child,
          revision: 3,
          state: "stopped",
          canOpen: false,
          canMessage: false,
          canStop: false,
        },
      },
    }, stopRequest).ok).toBeTrue();
  });

  test("rejects private authority and prototype lifecycle metadata at every public edge", () => {
    const parsed = harnessSnapshotSchema.parse(snapshot().harness);
    for (const field of [
      "providerId",
      "threadId",
      "turnId",
      "path",
      "transcript",
      "heap",
      "program",
      "trial",
      "canary",
      "activation",
      "rollback",
    ]) {
      expect(() => harnessSnapshotSchema.parse({ ...parsed, [field]: "private" })).toThrow();
      expect(() => harnessSnapshotSchema.parse({
        ...parsed,
        proposals: [{ ...parsed.proposals[0]!, [field]: "private" }],
      })).toThrow();
    }
  });
});
