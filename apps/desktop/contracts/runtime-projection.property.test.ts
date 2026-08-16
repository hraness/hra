import { expect, test } from "bun:test";
import { assertProperty, fc, propertyParameters } from "@hra-internal/test";

import {
  advanceRuntimeProjection,
  reduceRuntimeProjectionEvent,
} from "./runtime-projection";
import {
  runtimeChatPaneLimit,
  runtimeProtocolVersion,
  runtimeSnapshotSchema,
  type ChatPaneProjection,
  type RuntimeEvent,
  type RuntimeSnapshot,
} from "./runtime";

const managedWorkspace = {
  mode: "managedWorktree",
  state: "ready",
  revision: 1,
  recoveryKind: null,
} as const;

function emptySnapshot(): RuntimeSnapshot {
  return {
    revision: 1,
    lastSequence: 0,
    runtime: { state: "ready", generation: 1 },
    runner: { state: "connected" },
    accounts: [],
    retainedAccountLocalData: [],
    humanAccount: { state: "signedOut", revision: 0 },
    chat: { revision: 1, panes: [] },
    sessionSync: {
      status: {
        state: "unavailable",
        reason: "cloudConfigurationMissing",
        retryable: false,
      },
      localGridSlots: [],
      remoteSessions: [],
    },
    harness: null,
  };
}

function streamingPane(id: string, turnId: string): ChatPaneProjection {
  return {
    id,
    revision: 1,
    title: "Chat",
    repository: {
      id: "repo_00000000000000000000000000",
      name: "example",
    },
    accountProfileId: null,
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
    serviceTier: "standard",
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
      tools: [],
    },
    attention: null,
    recoverablePrompt: false,
    harness: null,
  };
}

const unicodeToken = fc.constantFrom(
  "a",
  "é",
  "漢",
  "🙂",
  "\n",
  "`",
  " ",
);

const PROPERTY_TIMEOUT = propertyParameters.interruptAfterTimeLimit + 5_000;

function lifecyclePane(index: number, revision: number): ChatPaneProjection {
  return {
    id: lifecyclePaneId(index),
    revision,
    title: `Pane ${index}`,
    repository: {
      id: "repo_00000000000000000000000000",
      name: "example",
    },
    accountProfileId: null,
    model: "gpt-5.6-sol",
    reasoningEffort: index % 2 === 0 ? "ultra" : "max",
    serviceTier: "standard",
    interactionMode: "chat",
    state: "ready",
    activity: { ordinal: 0, kind: "idle" },
    workspace: managedWorkspace,
    turn: null,
    attention: null,
    recoverablePrompt: false,
    harness: null,
  };
}

function lifecyclePaneId(index: number): string {
  return `pane_lifecycle${String(index).padStart(8, "0")}`;
}

function fullLifecycleSnapshot(): RuntimeSnapshot {
  let snapshot = emptySnapshot();
  for (let paneIndex = 0; paneIndex < runtimeChatPaneLimit; paneIndex += 1) {
    snapshot = reduceRuntimeProjectionEvent(snapshot, {
      type: "chat.pane.upserted",
      revision: 1,
      pane: lifecyclePane(paneIndex, 1),
    });
  }
  return runtimeSnapshotSchema.parse(snapshot);
}

const fullLifecycleFixture = fullLifecycleSnapshot();

function eventsFor(actions: readonly boolean[]): RuntimeEvent[] {
  return actions.map((upsert, index) => ({
    version: runtimeProtocolVersion,
    sequence: index + 1,
    event: upsert
      ? {
          type: "account.upserted" as const,
          account: {
            id: `acct_property${String(index).padStart(8, "0")}`,
            revision: index + 1,
            label: `Account ${index}`,
            selected: index % 2 === 0,
            identityLabel: null,
            planLabel: null,
            usageRemainingPercent: null,
            authState: "signedOut" as const,
            login: { state: "idle" as const },
            runtime: { state: "stopped" as const, generation: 0 },
          },
        }
      : {
          type: "account.removed" as const,
          accountProfileId: `acct_property${String(Math.floor(index / 2)).padStart(8, "0")}`,
        },
  }));
}

function replay(
  initial: RuntimeSnapshot,
  events: readonly RuntimeEvent[],
): RuntimeSnapshot {
  return events.reduce(advanceRuntimeProjection, initial);
}

test("portable projection replay is deterministic and prefix-consistent", () => {
  assertProperty(fc.property(
    fc.array(fc.boolean(), { maxLength: 64 }),
    fc.nat(),
    (actions, requestedPrefix) => {
      const events = eventsFor(actions);
      const prefixLength = Math.min(requestedPrefix, events.length);
      const initial = emptySnapshot();
      const first = replay(initial, events);
      const second = replay(initial, events);
      const prefix = replay(initial, events.slice(0, prefixLength));
      const suffix = replay(prefix, events.slice(prefixLength));

      expect(first).toEqual(second);
      expect(suffix).toEqual(first);
      expect(first.revision).toBe(initial.revision + events.length);
      expect(first.lastSequence).toBe(events.length);
    },
  ));
});

test("Unicode delta partitions produce the same exact UTF-8 projection", () => {
  assertProperty(fc.property(
    fc.array(unicodeToken, { minLength: 1, maxLength: 96 }),
    (tokens) => {
      const pane = streamingPane("pane_unicode001", "chatturn_unicode001");
      const initial = { ...emptySnapshot(), chat: { revision: 1, panes: [pane] } };
      let partitioned = initial;
      let offset = 0;
      tokens.forEach((delta, index) => {
        partitioned = reduceRuntimeProjectionEvent(partitioned, {
          type: "chat.turn.delta",
          paneId: pane.id,
          turnId: pane.turn!.id,
          revision: index + 2,
          channel: "responseMarkdown",
          startUtf8Offset: offset,
          delta,
        });
        offset += new TextEncoder().encode(delta).byteLength;
      });
      const combined = tokens.join("");
      const unpartitioned = reduceRuntimeProjectionEvent(initial, {
        type: "chat.turn.delta",
        paneId: pane.id,
        turnId: pane.turn!.id,
        revision: 2,
        channel: "responseMarkdown",
        startUtf8Offset: 0,
        delta: combined,
      });

      expect(partitioned.chat.panes[0]!.turn!.responseMarkdown).toEqual(
        unpartitioned.chat.panes[0]!.turn!.responseMarkdown,
      );
      expect(partitioned.chat.panes[0]!.turn!.responseMarkdown.totalUtf8Bytes)
        .toBe(new TextEncoder().encode(combined).byteLength);
    },
  ));
});

test("independent pane deltas commute and preserve untouched references", () => {
  assertProperty(fc.property(
    fc.array(unicodeToken, { minLength: 1, maxLength: 32 }).map((parts) => parts.join("")),
    fc.array(unicodeToken, { minLength: 1, maxLength: 32 }).map((parts) => parts.join("")),
    (firstDelta, secondDelta) => {
      const first = streamingPane("pane_commute001", "chatturn_commute001");
      const second = streamingPane("pane_commute002", "chatturn_commute002");
      const initial = {
        ...emptySnapshot(),
        chat: { revision: 1, panes: [first, second] },
      };
      const firstEvent = {
        type: "chat.turn.delta" as const,
        paneId: first.id,
        turnId: first.turn!.id,
        revision: 2,
        channel: "reasoningSummary" as const,
        startUtf8Offset: 0,
        delta: firstDelta,
      };
      const secondEvent = {
        type: "chat.turn.delta" as const,
        paneId: second.id,
        turnId: second.turn!.id,
        revision: 2,
        channel: "responseMarkdown" as const,
        startUtf8Offset: 0,
        delta: secondDelta,
      };
      const firstThenSecond = reduceRuntimeProjectionEvent(
        reduceRuntimeProjectionEvent(initial, firstEvent),
        secondEvent,
      );
      const secondThenFirst = reduceRuntimeProjectionEvent(
        reduceRuntimeProjectionEvent(initial, secondEvent),
        firstEvent,
      );

      expect(firstThenSecond).toEqual(secondThenFirst);
      const afterFirst = reduceRuntimeProjectionEvent(initial, firstEvent);
      expect(afterFirst.chat.panes[1]).toBe(second);
      expect(afterFirst.accounts).toBe(initial.accounts);
    },
  ));
});

test("pane capacity rejects a new identity without changing the full snapshot", () => {
  const full = structuredClone(fullLifecycleFixture);
  const fullSnapshot = structuredClone(full);
  const fullChat = full.chat;
  const fullPanes = full.chat.panes;
  const rejectedPaneIndex = runtimeChatPaneLimit;

  expect(() => reduceRuntimeProjectionEvent(full, {
    type: "chat.pane.upserted",
    revision: 1,
    pane: lifecyclePane(rejectedPaneIndex, 1),
  })).toThrow(`Chat pane capacity ${runtimeChatPaneLimit} is full`);
  expect(full).toEqual(fullSnapshot);
  expect(full.chat).toBe(fullChat);
  expect(full.chat.panes).toBe(fullPanes);

  const updated = reduceRuntimeProjectionEvent(full, {
    type: "chat.pane.upserted",
    revision: 2,
    pane: lifecyclePane(0, 2),
  });
  expect(updated.chat.panes).toHaveLength(runtimeChatPaneLimit);
  expect(updated.chat.revision).toBe(full.chat.revision + 1);
  expect(updated.chat.panes.find(({ id }) => id === lifecyclePaneId(0))?.revision)
    .toBe(2);

  const removed = reduceRuntimeProjectionEvent(updated, {
    type: "chat.pane.removed",
    paneId: lifecyclePaneId(1),
    revision: 2,
  });
  expect(removed.chat.panes).toHaveLength(runtimeChatPaneLimit - 1);
  expect(removed.chat.revision).toBe(updated.chat.revision + 1);
  expect(removed.chat.panes.some(({ id }) => id === lifecyclePaneId(1))).toBe(false);

  const inserted = reduceRuntimeProjectionEvent(removed, {
    type: "chat.pane.upserted",
    revision: 1,
    pane: lifecyclePane(rejectedPaneIndex, 1),
  });
  expect(inserted.chat.panes).toHaveLength(runtimeChatPaneLimit);
  expect(inserted.chat.revision).toBe(removed.chat.revision + 1);
  expect(inserted.chat.panes.find(({ id }) => id === lifecyclePaneId(rejectedPaneIndex))?.revision)
    .toBe(1);
  expect(() => runtimeSnapshotSchema.parse(inserted)).not.toThrow();
});

test("pane lifecycle preserves the capacity and revision model", () => {
  assertProperty(fc.property(
    fc.array(fc.record({
      kind: fc.constantFrom("upsert" as const, "remove" as const),
      paneIndex: fc.integer({ min: 0, max: runtimeChatPaneLimit + 6 }),
    }), { maxLength: 160 }),
    (actions) => {
      let state = structuredClone(fullLifecycleFixture);
      const revisions = new Map<number, number>(
        Array.from(
          { length: runtimeChatPaneLimit },
          (_, paneIndex) => [paneIndex, 1] as const,
        ),
      );

      for (const action of actions) {
        const previousChatRevision = state.chat.revision;
        const currentRevision = revisions.get(action.paneIndex);
        if (action.kind === "remove") {
          if (currentRevision === undefined) continue;
          state = reduceRuntimeProjectionEvent(state, {
            type: "chat.pane.removed",
            paneId: lifecyclePaneId(action.paneIndex),
            revision: currentRevision + 1,
          });
          revisions.delete(action.paneIndex);
          expect(state.chat.revision).toBe(previousChatRevision + 1);
          expect(state.chat.panes.some(({ id }) => id === lifecyclePaneId(action.paneIndex)))
            .toBe(false);
        } else {
          const nextRevision = currentRevision === undefined ? 1 : currentRevision + 1;
          const event = {
            type: "chat.pane.upserted" as const,
            revision: nextRevision,
            pane: lifecyclePane(action.paneIndex, nextRevision),
          };
          if (
            currentRevision === undefined &&
            revisions.size === runtimeChatPaneLimit
          ) {
            expect(() => reduceRuntimeProjectionEvent(state, event))
              .toThrow(`Chat pane capacity ${runtimeChatPaneLimit} is full`);
            expect(state.chat.revision).toBe(previousChatRevision);
            expect(state.chat.panes.some(({ id }) => id === lifecyclePaneId(action.paneIndex)))
              .toBe(false);
          } else {
            state = reduceRuntimeProjectionEvent(state, event);
            revisions.set(action.paneIndex, nextRevision);
            expect(state.chat.revision).toBe(previousChatRevision + 1);
            expect(state.chat.panes.find(({ id }) => id === lifecyclePaneId(action.paneIndex))?.revision)
              .toBe(nextRevision);
          }
        }

        expect(state.chat.panes).toHaveLength(revisions.size);
        expect(state.chat.panes.length).toBeLessThanOrEqual(runtimeChatPaneLimit);
      }

      const actualRevisions = new Map(
        state.chat.panes.map(({ id, revision }) => [id, revision] as const),
      );
      const expectedRevisions = new Map(
        [...revisions].map(([paneIndex, revision]) => [
          lifecyclePaneId(paneIndex),
          revision,
        ] as const),
      );
      expect(actualRevisions.size).toBe(state.chat.panes.length);
      expect(actualRevisions).toEqual(expectedRevisions);
      expect(() => runtimeSnapshotSchema.parse(state)).not.toThrow();
    },
  ));
}, PROPERTY_TIMEOUT);

test("terminal chat turns are immutable under every delta channel", () => {
  assertProperty(fc.property(
    fc.constantFrom("completed" as const, "failed" as const),
    fc.constantFrom("responseMarkdown" as const, "reasoningSummary" as const),
    fc.array(unicodeToken, { minLength: 1, maxLength: 32 }).map((parts) => parts.join("")),
    (status, channel, delta) => {
      const active = streamingPane("pane_terminal01", "chatturn_terminal01");
      const pane: ChatPaneProjection = {
        ...active,
        state: "ready",
        turn: {
          ...active.turn!,
          status,
          completedAt: "2026-08-03T12:01:00.000Z",
        },
      };
      const initial = {
        ...emptySnapshot(),
        chat: { revision: 1, panes: [pane] },
      };
      const before = structuredClone(initial);

      expect(() => reduceRuntimeProjectionEvent(initial, {
        type: "chat.turn.delta",
        paneId: pane.id,
        turnId: pane.turn!.id,
        revision: 2,
        channel,
        startUtf8Offset: 0,
        delta,
      })).toThrow("is terminal and cannot accept deltas");
      expect(initial).toEqual(before);
      expect(initial.chat.panes[0]).toBe(pane);
    },
  ));
});
