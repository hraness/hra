import { describe, expect, test } from "bun:test";

import type { CodexFact, CodexThreadSnapshot } from "../src/codex";
import {
  MAX_SESSION_FACT_ENCODED_BYTES,
  SessionFactInvariantError,
  createSessionState,
  reduceSessionFact,
  reduceSessionFacts,
} from "../src/sessions/reducer";
import { sessionEntityKey } from "../src/sessions/model";
import { createSessionSelectors } from "../src/sessions/selectors";

const accountProfileId = "acct_model_fixture";

function metadata(
  streamPosition: number,
  generation = 1,
  factIndex = 0,
) {
  return {
    accountProfileId,
    encodedBytes: 128,
    factIndex,
    generation,
    origin: "live" as const,
    streamPosition,
  };
}

function snapshot(
  streamPosition: number,
  turns: CodexThreadSnapshot["turns"],
  generation = 1,
): CodexFact {
  return {
    ...metadata(streamPosition, generation),
    type: "thread.snapshot",
    origin: "snapshot",
    thread: {
      archived: false,
      createdAt: "2026-07-29T12:00:00.000Z",
      cwd: "/private/worktree",
      id: "thread-1",
      status: "active",
      title: "Fixture",
      turns,
      updatedAt: "2026-07-29T12:01:00.000Z",
    },
  };
}

const initialTurn = {
  completedAt: null,
  id: "turn-1",
  items: [],
  startedAt: "2026-07-29T12:00:01.000Z",
  status: "active" as const,
};

describe("immutable session reducer", () => {
  test("preserves metadata-only history and replaces complete snapshots authoritatively", () => {
    let state = reduceSessionFact(createSessionState(), snapshot(1, [{
      ...initialTurn,
      items: [{ id: "item-1", kind: "assistant_text", text: "complete", truncated: false }],
    }]));
    const itemKey = sessionEntityKey(accountProfileId, "item-1");
    const turnKey = sessionEntityKey(accountProfileId, "turn-1");
    const item = state.items.get(itemKey);
    const turn = state.turns[turnKey];

    state = reduceSessionFact(state, snapshot(2, null));
    expect(state.items.get(itemKey)).toBe(item);
    expect(state.turns[turnKey]).toBe(turn);

    state = reduceSessionFact(state, snapshot(3, [{
      ...initialTurn,
      items: null,
    }]));
    expect(state.items.get(itemKey)).toBe(item);
    expect(state.turns[turnKey]?.itemKeys).toEqual([itemKey]);

    state = reduceSessionFact(state, snapshot(4, []));
    expect(state.items.get(itemKey)).toBeUndefined();
    expect(state.turns[turnKey]).toBeUndefined();
    expect(state.threads[sessionEntityKey(accountProfileId, "thread-1")]?.turnKeys)
      .toEqual([]);
  });

  test("preserves equal adjacent deltas and makes completion authoritative", () => {
    const selectors = createSessionSelectors();
    let state = reduceSessionFact(createSessionState(), snapshot(1, [initialTurn]));
    state = reduceSessionFact(state, {
      ...metadata(2),
      type: "item.started",
      activity: null,
      itemId: "item-1",
      kind: "assistant_text",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const equalDelta: CodexFact = {
      ...metadata(3),
      type: "item.delta",
      channel: "assistant_text",
      delta: "same",
      itemId: "item-1",
      threadId: "thread-1",
      truncated: false,
      turnId: "turn-1",
    };
    state = reduceSessionFact(state, equalDelta);
    expect(reduceSessionFact(state, equalDelta)).toBe(state);
    state = reduceSessionFact(state, { ...equalDelta, ...metadata(4) });
    expect(selectors.selectItem(state, accountProfileId, "item-1")?.text).toBe("samesame");
    expect(state.items.get(sessionEntityKey(accountProfileId, "item-1"))?.text?.deltaCount)
      .toBe(2);

    state = reduceSessionFact(state, {
      ...metadata(5),
      type: "item.completed",
      item: {
        id: "item-1",
        kind: "assistant_text",
        text: "authoritative",
        truncated: false,
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const completedView = selectors.selectItem(state, accountProfileId, "item-1");
    state = reduceSessionFact(state, { ...equalDelta, ...metadata(6), delta: "late" });
    expect(selectors.selectItem(state, accountProfileId, "item-1")).toBe(completedView);
    expect(completedView).toMatchObject({
      status: "completed",
      text: "authoritative",
    });
  });

  test("marks a projector-truncated stream without retaining an unbounded chunk", () => {
    const selectors = createSessionSelectors();
    let state = reduceSessionFact(createSessionState(), snapshot(1, [initialTurn]));
    state = reduceSessionFact(state, {
      ...metadata(2),
      type: "item.delta",
      channel: "assistant_text",
      delta: "bounded prefix",
      itemId: "item-overflow",
      threadId: "thread-1",
      truncated: true,
      turnId: "turn-1",
    });
    expect(selectors.selectItem(state, accountProfileId, "item-overflow")).toMatchObject({
      overflowed: true,
      text: "bounded prefix",
    });
  });

  test("ignores stale generations and folds a hydration batch into one revision", () => {
    const facts: CodexFact[] = [
      snapshot(1, null, 2),
      {
        ...metadata(1, 2, 1),
        type: "thread.title_changed",
        threadId: "thread-1",
        title: "Hydrated",
      },
    ];
    const state = reduceSessionFacts(createSessionState(), facts);
    expect(state.revision).toBe(1);
    expect(state.threads[sessionEntityKey(accountProfileId, "thread-1")]?.title)
      .toBe("Hydrated");

    const stale = reduceSessionFact(state, {
      ...metadata(999, 1),
      type: "thread.title_changed",
      threadId: "thread-1",
      title: "Stale",
    });
    expect(stale).toBe(state);
  });

  test("prunes account-scoped volatile state at an accepted generation boundary", () => {
    const state = reduceSessionFacts(createSessionState(), [
      snapshot(1, [initialTurn]),
      {
        ...metadata(2),
        type: "interaction.requested",
        expiresAt: 2_000_000_000_000,
        interactionId: "interaction-generation-1",
        kind: "approval",
        threadId: "thread-1",
        turnId: "turn-1",
      },
      {
        ...metadata(3),
        type: "operation.changed",
        operation: "turn_start",
        operationId: "operation-generation-1",
        outcome: "pending",
        threadId: "thread-1",
      },
      {
        ...metadata(4),
        type: "hydration.changed",
        attempt: 1,
        status: "recovering",
        threadId: "thread-1",
      },
    ]);
    expect(Object.keys(state.interactions)).toHaveLength(1);
    expect(Object.keys(state.operations)).toHaveLength(1);
    expect(Object.keys(state.hydration)).toHaveLength(1);
    const boundary: CodexFact = {
      ...metadata(1, 2),
      type: "account.changed",
      availability: "signed_in",
    };

    const sequential = reduceSessionFact(state, boundary);
    const batched = reduceSessionFacts(state, [boundary]);

    expect(batched).toEqual(sequential);
    expect(Object.keys(sequential.interactions)).toHaveLength(0);
    expect(Object.keys(sequential.operations)).toHaveLength(0);
    expect(Object.keys(sequential.hydration)).toHaveLength(0);
    expect(Object.keys(sequential.threads)).toHaveLength(1);
  });

  test("deletion cascades, tombstones one generation, and allows a newer snapshot", () => {
    let state = reduceSessionFact(createSessionState(), snapshot(1, [{
      ...initialTurn,
      items: [{ id: "item-1", kind: "assistant_text", text: "done", truncated: false }],
    }]));
    state = reduceSessionFact(state, {
      ...metadata(2),
      type: "interaction.requested",
      expiresAt: 2_000_000_000_000,
      interactionId: "interaction-1",
      kind: "approval",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    state = reduceSessionFact(state, {
      ...metadata(3),
      type: "thread.deleted",
      threadId: "thread-1",
    });
    expect(Object.keys(state.threads)).toHaveLength(0);
    expect(Object.keys(state.turns)).toHaveLength(0);
    expect(state.items.size).toBe(0);
    expect(Object.keys(state.interactions)).toHaveLength(0);
    expect(Object.keys(state.threadTombstones)).toHaveLength(1);

    state = reduceSessionFact(state, snapshot(4, null));
    expect(Object.keys(state.threads)).toHaveLength(0);
    state = reduceSessionFact(state, snapshot(1, null, 2));
    expect(Object.keys(state.threads)).toHaveLength(1);
    expect(Object.keys(state.threadTombstones)).toHaveLength(0);
  });

  test("selectors retain identity when unrelated state advances", () => {
    const selectors = createSessionSelectors();
    let state = reduceSessionFact(createSessionState(), snapshot(1, [{
      ...initialTurn,
      items: [{ id: "item-1", kind: "assistant_text", text: "done", truncated: false }],
    }]));
    const thread = selectors.selectThread(state, accountProfileId, "thread-1");
    const summaries = selectors.selectThreadSummaries(state, accountProfileId);
    const item = selectors.selectItem(state, accountProfileId, "item-1");
    state = reduceSessionFact(state, {
      ...metadata(2),
      type: "operation.changed",
      operation: "thread_read",
      operationId: "operation-1",
      outcome: "confirmed",
      threadId: "thread-1",
    });
    expect(selectors.selectThread(state, accountProfileId, "thread-1")).toBe(thread);
    expect(selectors.selectThreadSummaries(state, accountProfileId)).toBe(summaries);
    expect(selectors.selectItem(state, accountProfileId, "item-1")).toBe(item);
  });

  test("rejects invalid owned-fact bounds before state mutation", () => {
    const invalid: CodexFact = {
      ...metadata(1),
      encodedBytes: MAX_SESSION_FACT_ENCODED_BYTES + 1,
      type: "runtime.changed",
      availability: "running",
    };
    expect(() => reduceSessionFact(createSessionState(), invalid))
      .toThrow(SessionFactInvariantError);
  });

  test("rejects duplicate and cross-linked provider entity identities", () => {
    expect(() => reduceSessionFact(createSessionState(), snapshot(1, [
      initialTurn,
      initialTurn,
    ]))).toThrow(SessionFactInvariantError);

    let state = reduceSessionFact(createSessionState(), snapshot(1, [initialTurn]));
    state = reduceSessionFact(state, {
      ...metadata(2),
      type: "thread.snapshot",
      origin: "snapshot",
      thread: {
        archived: false,
        createdAt: "2026-07-29T12:00:00.000Z",
        cwd: "/private/other",
        id: "thread-2",
        status: "active",
        title: "Other",
        turns: [],
        updatedAt: "2026-07-29T12:01:00.000Z",
      },
    });
    expect(() => reduceSessionFact(state, {
      ...metadata(3),
      type: "turn.snapshot",
      threadId: "thread-2",
      turn: initialTurn,
    })).toThrow(SessionFactInvariantError);
  });
});
