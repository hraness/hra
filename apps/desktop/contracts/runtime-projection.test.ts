import { describe, expect, test } from "bun:test";

import {
  advanceRuntimeProjection,
  nextRuntimeProjectionSequence,
  reduceRuntimeProjectionEvent,
} from "./runtime-projection";
import { runtimeChatPaneStateProjection } from "./runtime-delivery";
import {
  runtimeProtocolVersion,
  runtimeSnapshotSchema,
  type AccountSummary,
  type ChatPaneProjection,
  type RetainedAccountLocalData,
  type RuntimeEvent,
  type RuntimeSnapshot,
} from "./runtime";

const managedWorkspace = {
  mode: "managedWorktree",
  state: "ready",
  revision: 1,
  recoveryKind: null,
} as const;

const resolvedStandardRoute = {
  policyVersion: 1,
  classificationReason: "conservativeDefault",
  workClass: "standard",
  requestedProfile: "solMax",
  selectedProfile: "solMax",
  profileFallbackReason: null,
  requestedServiceTier: "standard",
  selectedServiceTier: "standard",
  serviceTierFallbackReason: null,
} as const;

function chatPane(
  id = "pane_projection01",
  turnId = "chatturn_projection01",
): ChatPaneProjection {
  return {
    id,
    paletteIndex: 0,
    revision: 1,
    title: "New chat",
    repository: {
      id: "repo_00000000000000000000000000",
      name: "example",
    },
    accountProfileId: account.id,
    interactionMode: "chat",
    state: "streaming",
    activity: { ordinal: 1, kind: "messageSent" },
    workspace: managedWorkspace,
    turn: {
      id: turnId,
      status: "streaming",
      startedAt: "2026-08-03T12:00:00.000Z",
      completedAt: null,
      continuationCount: 0,
      responseMarkdown: { tail: "", totalUtf8Bytes: 0, truncatedPrefix: false },
      reasoningSummary: { tail: "", totalUtf8Bytes: 0, truncatedPrefix: false },
      reasoningSummaryVerified: false,
      tools: [],
      providerSubagents: { agents: [], overflowCount: 0 },
      routing: resolvedStandardRoute,
    },
    attention: null,
    recoverablePrompt: false,
    canStartFreshContext: false,
    messageQueue: { revision: 1, pauseReason: null, blockedMessage: null, messages: [] },
    attachments: { drafts: [], referenced: [] },
    harness: null,
  };
}

const account: AccountSummary = {
  id: "acct_projection01",
  revision: 1,
  label: "Personal",
  selected: true,
  identityLabel: "builder@example.com",
  planLabel: "pro",
  usageRemainingPercent: 73,
  authState: "signedIn",
  login: { state: "idle" },
  runtime: { state: "ready", generation: 1 },
};

const retainedLocalData: RetainedAccountLocalData = {
  id: account.id,
  revision: 2,
  label: account.label,
  removedAt: "2026-07-30T12:00:00.000Z",
};

function snapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return runtimeSnapshotSchema.parse({
    revision: 1,
    lastSequence: 0,
    runtime: { state: "ready", generation: 1 },
    runner: { state: "connected" },
    accounts: [],
    retainedAccountLocalData: [],
    humanAccount: { state: "signedOut", revision: 0 },
    chat: { revision: 1, panes: [] },
    harness: null,
    ...overrides,
  });
}

describe("portable runtime projection", () => {
  test("rejects a 65th account identity before mutating renderer state", () => {
    const accounts = Array.from({ length: 64 }, (_, index): AccountSummary => ({
      ...account,
      id: `acct_capacity${String(index).padStart(4, "0")}`,
      label: `Account ${String(index + 1)}`,
      selected: index === 0,
    }));
    const retained = Array.from({ length: 64 }, (_, index): RetainedAccountLocalData => ({
      ...retainedLocalData,
      id: `acct_retained${String(index).padStart(4, "0")}`,
      label: `Retained ${String(index + 1)}`,
    }));
    const full = snapshot({ accounts, retainedAccountLocalData: retained });

    expect(() => reduceRuntimeProjectionEvent(full, {
      type: "account.upserted",
      account: { ...account, id: "acct_overflow0001" },
    })).toThrow("account profile capacity is full");
    expect(() => reduceRuntimeProjectionEvent(full, {
      type: "accountLocalData.upserted",
      localData: { ...retainedLocalData, id: "acct_overflow0002" },
    })).toThrow("retained account local data capacity is full");

    const replacement = reduceRuntimeProjectionEvent(full, {
      type: "account.upserted",
      account: { ...accounts[0]!, revision: 2, label: "Updated" },
    });
    expect(replacement.accounts).toHaveLength(64);
    expect(replacement.accounts[0]).toMatchObject({ revision: 2, label: "Updated" });
    expect(full.accounts[0]).toEqual(accounts[0]);
  });

  test("applies domain changes with structural sharing outside the affected branch", () => {
    const otherAccount: AccountSummary = {
      ...account,
      id: "acct_projection02",
      label: "Other",
      selected: false,
    };
    const initial = snapshot({ accounts: [account, otherAccount] });
    const retainedOtherAccount = initial.accounts[1]!;
    const replacement: AccountSummary = { ...account, revision: 2, label: "Updated" };
    const updated = reduceRuntimeProjectionEvent(initial, {
      type: "account.upserted",
      account: replacement,
    });

    expect(updated).not.toBe(initial);
    expect(updated.accounts).not.toBe(initial.accounts);
    expect(updated.accounts).toEqual([replacement, otherAccount]);
    expect(updated.accounts[0]).not.toBe(replacement);
    expect(updated.accounts[1]).toBe(retainedOtherAccount);
    expect(updated.runtime).toBe(initial.runtime);
    expect(updated.runner).toBe(initial.runner);
    expect(updated.retainedAccountLocalData).toBe(initial.retainedAccountLocalData);
    expect(updated.humanAccount).toBe(initial.humanAccount);

    const absentRemoval = reduceRuntimeProjectionEvent(updated, {
      type: "account.removed",
      accountProfileId: "acct_absent001",
    });
    expect(absentRemoval.accounts).toBe(updated.accounts);
    const removed = reduceRuntimeProjectionEvent(updated, {
      type: "account.removed",
      accountProfileId: replacement.id,
    });
    expect(removed.accounts).toEqual([otherAccount]);
    expect(removed.accounts[0]).toBe(retainedOtherAccount);
  });

  test("owns every portable branch and leaves exact-delivery events domain-neutral", () => {
    const initial = snapshot({ accounts: [account] });
    const runtime = reduceRuntimeProjectionEvent(initial, {
      type: "runtime.changed",
      runtime: { state: "stopped", generation: 2 },
    });
    expect(runtime.runtime).toEqual({ state: "stopped", generation: 2 });
    expect(runtime.accounts).toBe(initial.accounts);

    const runnerAttention = reduceRuntimeProjectionEvent(initial, {
      type: "runner.changed",
      runner: { state: "attention", reason: "noRepository" },
    });
    expect(runnerAttention.runner).toEqual({
      state: "attention",
      reason: "noRepository",
    });
    const runner = reduceRuntimeProjectionEvent(initial, {
      type: "runner.changed",
      runner: { state: "recovering" },
    });
    expect(runner.runner).toEqual({ state: "recovering" });

    const retained = reduceRuntimeProjectionEvent(initial, {
      type: "accountLocalData.upserted",
      localData: retainedLocalData,
    });
    expect(retained.retainedAccountLocalData).toEqual([retainedLocalData]);
    expect(retained.retainedAccountLocalData[0]).not.toBe(retainedLocalData);
    expect(reduceRuntimeProjectionEvent(retained, {
      type: "accountLocalData.removed",
      accountProfileId: account.id,
    }).retainedAccountLocalData).toEqual([]);

    const humanAccount = { state: "signedOut", revision: 3 } as const;
    const human = reduceRuntimeProjectionEvent(initial, {
      type: "humanAccount.changed",
      humanAccount,
    });
    expect(human.humanAccount).toEqual(humanAccount);
    expect(human.humanAccount).not.toBe(humanAccount);

    for (const event of [
      { type: "snapshot.invalidated", reason: "projectionOverflow" },
      {
        type: "operation.completed",
        operationId: "op_projection01",
        outcome: { ok: true },
      },
      {
        type: "task.invalidated",
        invalidation: {
          workspaceId: "wsp_00000000000000000000000000",
          projectionRevision: 1,
          scope: "workspace",
        },
      },
    ] as const) {
      expect(reduceRuntimeProjectionEvent(initial, event)).toBe(initial);
    }
  });

  test("checks contiguous sequence and revision advancement", () => {
    const initial = snapshot({ revision: 7, lastSequence: 11 });
    const event: RuntimeEvent = {
      version: runtimeProtocolVersion,
      sequence: 12,
      event: { type: "runner.changed", runner: { state: "connecting" } },
    };
    expect(advanceRuntimeProjection(initial, event)).toMatchObject({
      revision: 8,
      lastSequence: 12,
      runner: { state: "connecting" },
    });
    expect(() => advanceRuntimeProjection(initial, { ...event, sequence: 13 })).toThrow(
      "Runtime projection sequence must advance from 11 to 12; received 13",
    );
    expect(() => advanceRuntimeProjection(
      snapshot({ revision: Number.MAX_SAFE_INTEGER }),
      { ...event, sequence: 1 },
    )).toThrow("runtime projection revision exhausted");
    expect(() => nextRuntimeProjectionSequence(
      snapshot({ lastSequence: Number.MAX_SAFE_INTEGER }),
    )).toThrow("runtime projection sequence exhausted");
  });

  test("applies exact pane revisions and UTF-8 offsets without corrupting stale state", () => {
    const inserted = reduceRuntimeProjectionEvent(snapshot(), {
      type: "chat.pane.upserted",
      revision: 1,
      pane: chatPane(),
    });
    const beforeDelta = inserted.chat.panes[0]!;
    const streamed = reduceRuntimeProjectionEvent(inserted, {
      type: "chat.turn.delta",
      paneId: beforeDelta.id,
      turnId: beforeDelta.turn!.id,
      revision: 2,
      channel: "responseMarkdown",
      startUtf8Offset: 0,
      delta: "Hello, 世界 🙂",
    });
    expect(streamed.chat).toMatchObject({ revision: 3 });
    expect(streamed.chat.panes[0]).toMatchObject({
      revision: 2,
      turn: {
        responseMarkdown: {
          tail: "Hello, 世界 🙂",
          totalUtf8Bytes: 18,
          truncatedPrefix: false,
        },
      },
    });
    expect(() => reduceRuntimeProjectionEvent(streamed, {
      type: "chat.turn.delta",
      paneId: beforeDelta.id,
      turnId: beforeDelta.turn!.id,
      revision: 2,
      channel: "responseMarkdown",
      startUtf8Offset: 18,
      delta: "stale",
    })).toThrow("revision must advance to 3; received 2");
    expect(() => reduceRuntimeProjectionEvent(streamed, {
      type: "chat.turn.delta",
      paneId: beforeDelta.id,
      turnId: beforeDelta.turn!.id,
      revision: 3,
      channel: "responseMarkdown",
      startUtf8Offset: 17,
      delta: "offset",
    })).toThrow("must start at UTF-8 byte 18; received 17");
    expect(streamed.chat.panes[0]!.turn!.responseMarkdown.tail).toBe("Hello, 世界 🙂");
  });

  test("isolates references across panes and rejects out-of-order removal", () => {
    const first = chatPane();
    const second = chatPane("pane_projection02", "chatturn_projection02");
    const initial = snapshot({ chat: { revision: 4, panes: [first, second] } });
    const retainedFirst = initial.chat.panes[0]!;
    const retainedSecond = initial.chat.panes[1]!;
    const updated = reduceRuntimeProjectionEvent(initial, {
      type: "chat.turn.delta",
      paneId: first.id,
      turnId: first.turn!.id,
      revision: 2,
      channel: "reasoningSummary",
      startUtf8Offset: 0,
      delta: "Checking",
    });
    expect(updated.chat.panes[0]).not.toBe(retainedFirst);
    expect(updated.chat.panes[1]).toBe(retainedSecond);
    expect(updated.accounts).toBe(initial.accounts);
    expect(() => reduceRuntimeProjectionEvent(updated, {
      type: "chat.pane.removed",
      paneId: second.id,
      revision: 3,
    })).toThrow("revision must advance to 2; received 3");
    expect(updated.chat.panes).toHaveLength(2);
  });

  test("applies bounded lifecycle state while preserving long tails and sibling identity", () => {
    const longResponse = "response🙂".repeat(1_000);
    const first = {
      ...chatPane(),
      turn: {
        ...chatPane().turn!,
        responseMarkdown: {
          tail: longResponse,
          totalUtf8Bytes: new TextEncoder().encode(longResponse).byteLength,
          truncatedPrefix: false,
        },
      },
    } satisfies ChatPaneProjection;
    const second = chatPane("pane_projection02", "chatturn_projection02");
    const initial = snapshot({ chat: { revision: 4, panes: [first, second] } });
    const retainedSecond = initial.chat.panes[1]!;
    const updated = reduceRuntimeProjectionEvent(initial, {
      type: "chat.pane.stateChanged",
      revision: 2,
      pane: {
        id: first.id,
        paletteIndex: first.paletteIndex,
        revision: 2,
        title: "Finished",
        accountProfileId: first.accountProfileId,
        interactionMode: first.interactionMode,
        state: "ready",
        activity: { ordinal: 2, kind: "responseCompleted" },
        workspace: first.workspace,
        turn: {
          id: first.turn.id,
          status: "completed",
          startedAt: first.turn.startedAt,
          completedAt: "2026-08-03T12:01:00.000Z",
          continuationCount: 0,
          tools: [{
            id: "chattool_projection01",
            category: "command",
            status: "completed",
          }],
          providerSubagents: { agents: [], overflowCount: 0 },
          routing: first.turn.routing,
        },
        attention: null,
        recoverablePrompt: false,
        canStartFreshContext: false,
      },
    });

    expect(updated.chat.panes[0]).toMatchObject({
      revision: 2,
      title: "Finished",
      state: "ready",
      turn: {
        status: "completed",
        responseMarkdown: { tail: longResponse },
        tools: [{ status: "completed" }],
      },
    });
    expect(updated.chat.panes[0]!.turn!.responseMarkdown)
      .toEqual(first.turn.responseMarkdown);
    expect(updated.chat.panes[1]).toBe(retainedSecond);
    expect(() => reduceRuntimeProjectionEvent(initial, {
      type: "chat.pane.stateChanged",
      revision: 2,
      pane: {
        id: first.id,
        paletteIndex: first.paletteIndex,
        revision: 2,
        title: first.title,
        accountProfileId: first.accountProfileId,
        interactionMode: first.interactionMode,
        state: "streaming",
        activity: first.activity,
        workspace: first.workspace,
        turn: {
          id: "chatturn_replacement01",
          status: first.turn.status,
          startedAt: first.turn.startedAt,
          completedAt: first.turn.completedAt,
          continuationCount: first.turn.continuationCount,
          tools: first.turn.tools,
          providerSubagents: first.turn.providerSubagents,
          routing: first.turn.routing,
        },
        attention: null,
        recoverablePrompt: false,
        canStartFreshContext: false,
      },
    })).toThrow("cannot replace its latest turn");
  });

  test("keeps harness decoration authoritative across ordinary chat updates", () => {
    const decoration = {
      revision: 3,
      descendants: {
        count: 1,
        truncated: false,
        children: [{
          id: "hactor_projection01",
          revision: 2,
          title: "Research",
          state: "idle" as const,
          openedPaneId: null,
          canOpen: false,
          canMessage: false,
          canStop: true,
        }],
      },
    };
    const first = { ...chatPane(), harness: decoration } satisfies ChatPaneProjection;
    const initial = snapshot({ chat: { revision: 2, panes: [first] } });

    const upserted = reduceRuntimeProjectionEvent(initial, {
      type: "chat.pane.upserted",
      revision: 2,
      pane: {
        ...first,
        revision: 2,
        title: "Renamed",
        harness: null,
      },
    });
    expect(upserted.chat.panes[0]?.harness).toEqual(decoration);

    const stateChanged = reduceRuntimeProjectionEvent(upserted, {
      type: "chat.pane.stateChanged",
      revision: 3,
      pane: {
        id: first.id,
        paletteIndex: first.paletteIndex,
        revision: 3,
        title: "Finished",
        accountProfileId: first.accountProfileId,
        interactionMode: first.interactionMode,
        state: "ready",
        activity: { ordinal: 2, kind: "responseCompleted" },
        workspace: first.workspace,
        turn: {
          id: first.turn!.id,
          status: "completed",
          startedAt: first.turn!.startedAt,
          completedAt: "2026-08-03T12:01:00.000Z",
          continuationCount: 0,
          tools: [],
          providerSubagents: { agents: [], overflowCount: 0 },
          routing: first.turn!.routing,
        },
        attention: null,
        recoverablePrompt: false,
        canStartFreshContext: false,
      },
    });
    expect(stateChanged.chat.panes[0]?.harness).toEqual(decoration);
  });

  test("compact pane lifecycle events cannot change interaction mode", () => {
    const first = chatPane();
    const initial = snapshot({ chat: { revision: 1, panes: [first] } });
    expect(() => reduceRuntimeProjectionEvent(initial, {
      type: "chat.pane.stateChanged",
      revision: 2,
      pane: {
        ...runtimeChatPaneStateProjection(first),
        revision: 2,
        interactionMode: "harnessObserver",
        workspace: null,
      },
    })).toThrow("cannot change its interaction mode");
  });
});
