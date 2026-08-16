import { describe, expect, test } from "bun:test";

import type { CodexFact, CodexThreadSnapshot } from "../src/codex";
import {
  createSessionEntityMap,
  deleteSessionEntity,
  setSessionEntity,
} from "../src/sessions/entity-map";
import { sessionEntityKey } from "../src/sessions/model";
import {
  SessionFactInvariantError,
  createSessionState,
  purgeSessionAccount,
  reduceSessionFact,
} from "../src/sessions/reducer";
import { SESSION_RETENTION_POLICY } from "../src/sessions/retention-policy";
import { createSessionSelectors } from "../src/sessions/selectors";

const accountProfileId = "acct_retention_fixture";

function metadata(
  streamPosition: number,
  encodedBytes = 128,
  generation = 1,
) {
  return {
    accountProfileId,
    encodedBytes,
    factIndex: 0,
    generation,
    origin: "live" as const,
    streamPosition,
  };
}

function threadSnapshot(
  streamPosition: number,
  id: string,
  input: Readonly<{
    status?: CodexThreadSnapshot["status"];
    turns?: CodexThreadSnapshot["turns"];
    updatedAt?: string;
  }> = {},
): CodexFact {
  return {
    ...metadata(streamPosition),
    type: "thread.snapshot",
    origin: "snapshot",
    thread: {
      archived: false,
      createdAt: "2026-07-29T00:00:00.000Z",
      cwd: `/fixture/${id}`,
      id,
      status: input.status ?? "idle",
      title: id,
      turns: input.turns ?? null,
      updatedAt: input.updatedAt ?? new Date(
        Date.UTC(2026, 6, 29, 0, 0, streamPosition),
      ).toISOString(),
    },
  };
}

function turn(
  id: string,
  status: "active" | "completed" = "completed",
  items: NonNullable<CodexThreadSnapshot["turns"]>[number]["items"] = [],
) {
  return {
    completedAt: status === "active" ? null : "2026-07-29T00:01:00.000Z",
    id,
    items,
    startedAt: "2026-07-29T00:00:01.000Z",
    status,
  } as const;
}

describe("immutable session entity map", () => {
  test("stays ordered and persistent under adversarial sorted insertions and deletions", () => {
    let map = createSessionEntityMap<number>();
    const snapshots = [map];
    for (let index = 0; index < 4_096; index += 1) {
      map = setSessionEntity(map, String(index).padStart(6, "0"), index);
      if (index % 1_024 === 0) snapshots.push(map);
    }
    expect(map.size).toBe(4_096);
    expect([...map.values()]).toEqual(Array.from({ length: 4_096 }, (_, index) => index));
    expect(snapshots[0]?.size).toBe(0);
    expect(snapshots[1]?.get("000000")).toBe(0);

    for (let index = 0; index < 4_096; index += 2) {
      map = deleteSessionEntity(map, String(index).padStart(6, "0"));
    }
    expect(map.size).toBe(2_048);
    expect([...map.values()]).toEqual(
      Array.from({ length: 2_048 }, (_, index) => index * 2 + 1),
    );
  });

  test("matches a mutable map across deterministic mixed updates", () => {
    let immutable = createSessionEntityMap<number>();
    const mutable = new Map<string, number>();
    let random = 0x5eed_1234;
    for (let index = 0; index < 20_000; index += 1) {
      random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
      const key = `key-${String(random % 2_048).padStart(4, "0")}`;
      if ((random & 3) === 0) {
        immutable = deleteSessionEntity(immutable, key);
        mutable.delete(key);
      } else {
        immutable = setSessionEntity(immutable, key, index);
        mutable.set(key, index);
      }
      if (index % 257 === 0) {
        expect([...immutable.entries()]).toEqual(
          [...mutable.entries()].toSorted(([left], [right]) => left.localeCompare(right)),
        );
      }
    }
    expect(immutable.size).toBe(mutable.size);
    expect([...immutable.entries()]).toEqual(
      [...mutable.entries()].toSorted(([left], [right]) => left.localeCompare(right)),
    );
  });
});

describe("continuous session retention", () => {
  test("opens a streaming circuit after bounded one-byte deltas and heals on completion", () => {
    const selectors = createSessionSelectors();
    let state = reduceSessionFact(createSessionState(), threadSnapshot(1, "thread", {
      status: "active",
      turns: [turn("turn", "active")],
    }));
    for (
      let index = 0;
      index < SESSION_RETENTION_POLICY.maxStreamingDeltasPerItem + 128;
      index += 1
    ) {
      state = reduceSessionFact(state, {
        ...metadata(index + 2),
        type: "item.delta",
        channel: "assistant_text",
        delta: "x",
        itemId: "item",
        threadId: "thread",
        truncated: false,
        turnId: "turn",
      });
    }
    const itemKey = sessionEntityKey(accountProfileId, "item");
    const streaming = state.items.get(itemKey);
    expect(streaming?.text).toMatchObject({
      deltaCount: SESSION_RETENTION_POLICY.maxStreamingDeltasPerItem,
      overflowed: true,
      utf8Bytes: SESSION_RETENTION_POLICY.maxStreamingDeltasPerItem,
    });
    expect(selectors.selectItem(state, accountProfileId, "item")?.text?.length)
      .toBe(SESSION_RETENTION_POLICY.maxStreamingDeltasPerItem);

    const oversized = "y".repeat(
      SESSION_RETENTION_POLICY.maxDisplayBytesPerThread + 4_096,
    );
    state = reduceSessionFact(state, {
      ...metadata(
        SESSION_RETENTION_POLICY.maxStreamingDeltasPerItem + 130,
        oversized.length + 512,
      ),
      type: "item.completed",
      item: {
        id: "item",
        kind: "assistant_text",
        text: oversized,
        truncated: false,
      },
      threadId: "thread",
      turnId: "turn",
    });
    const completed = state.items.get(itemKey);
    expect(completed?.text).toMatchObject({
      complete: true,
      overflowed: true,
      utf8Bytes: SESSION_RETENTION_POLICY.maxDisplayBytesPerThread,
    });
    expect(selectors.selectItem(state, accountProfileId, "item")?.text?.length)
      .toBe(SESSION_RETENTION_POLICY.maxDisplayBytesPerThread);
  });

  test("retains bounded metadata and resident history without fabricating deletion", () => {
    let state = createSessionState();
    const total = SESSION_RETENTION_POLICY.maxMetadataThreadsPerAccount + 1;
    for (let index = 0; index < total; index += 1) {
      state = reduceSessionFact(state, threadSnapshot(index + 1, `thread-${String(index)}`));
    }
    expect(Object.values(state.threads)).toHaveLength(
      SESSION_RETENTION_POLICY.maxMetadataThreadsPerAccount,
    );
    expect(state.threads[sessionEntityKey(accountProfileId, "thread-0")]).toBeUndefined();
    expect(state.threadTombstones).toEqual({});

    state = createSessionState();
    const histories = SESSION_RETENTION_POLICY.maxHistoryThreadsPerAccount + 1;
    for (let index = 0; index < histories; index += 1) {
      state = reduceSessionFact(state, threadSnapshot(index + 1, `history-${String(index)}`, {
        turns: [turn(`turn-${String(index)}`)],
      }));
    }
    expect(Object.values(state.threads).filter(({ turnKeys }) => turnKeys.length > 0))
      .toHaveLength(SESSION_RETENTION_POLICY.maxHistoryThreadsPerAccount);
    expect(state.threads[sessionEntityKey(accountProfileId, "history-0")]?.turnKeys)
      .toEqual([]);
  });

  test("keeps only the newest bounded complete display items per thread", () => {
    const itemCount = SESSION_RETENTION_POLICY.maxDisplayItemsPerThread + 1;
    const items = Array.from({ length: itemCount }, (_, index) => ({
      id: `item-${String(index)}`,
      kind: "assistant_text" as const,
      text: String(index),
      truncated: false,
    }));
    const state = reduceSessionFact(createSessionState(), threadSnapshot(1, "thread", {
      turns: [turn("turn", "completed", items)],
    }));
    expect(state.items.size).toBe(SESSION_RETENTION_POLICY.maxDisplayItemsPerThread);
    expect(state.items.get(sessionEntityKey(accountProfileId, "item-0"))).toBeUndefined();
    expect(state.items.get(sessionEntityKey(accountProfileId, `item-${String(itemCount - 1)}`)))
      .toBeDefined();
    const retainedTurn = state.turns[sessionEntityKey(accountProfileId, "turn")];
    expect(retainedTurn?.itemKeys).toHaveLength(
      SESSION_RETENTION_POLICY.maxDisplayItemsPerThread,
    );
  });

  test("bounds active item and pending authority cardinality", () => {
    let state = reduceSessionFact(createSessionState(), threadSnapshot(1, "thread", {
      status: "active",
      turns: [turn("turn", "active")],
    }));
    let position = 1;
    for (let index = 0; index < SESSION_RETENTION_POLICY.maxActiveItemsPerTurn; index += 1) {
      position += 1;
      state = reduceSessionFact(state, {
        ...metadata(position),
        type: "item.started",
        activity: null,
        itemId: `item-${String(index)}`,
        kind: "assistant_text",
        threadId: "thread",
        turnId: "turn",
      });
    }
    position += 1;
    expect(() => reduceSessionFact(state, {
      ...metadata(position),
      type: "item.started",
      activity: null,
      itemId: "item-overflow",
      kind: "assistant_text",
      threadId: "thread",
      turnId: "turn",
    })).toThrow(SessionFactInvariantError);

    state = reduceSessionFact(createSessionState(), threadSnapshot(1, "thread", {
      status: "active",
      turns: [turn("turn", "active")],
    }));
    position = 1;
    for (
      let index = 0;
      index < SESSION_RETENTION_POLICY.maxPendingInteractionsPerAccount;
      index += 1
    ) {
      position += 1;
      state = reduceSessionFact(state, {
        ...metadata(position),
        type: "interaction.requested",
        expiresAt: 2_000_000_000_000,
        interactionId: `interaction-${String(index)}`,
        kind: "approval",
        threadId: "thread",
        turnId: "turn",
      });
    }
    position += 1;
    expect(() => reduceSessionFact(state, {
      ...metadata(position),
      type: "interaction.requested",
      expiresAt: 2_000_000_000_000,
      interactionId: "interaction-overflow",
      kind: "approval",
      threadId: "thread",
      turnId: "turn",
    })).toThrow(SessionFactInvariantError);
  });

  test("forgets terminal authorities and generation-scoped tombstones", () => {
    let state = reduceSessionFact(createSessionState(), {
      ...metadata(1),
      type: "thread.deleted",
      threadId: "unknown",
    });
    expect(state.threadTombstones).toEqual({});

    state = reduceSessionFact(state, threadSnapshot(2, "thread", {
      status: "active",
      turns: [turn("turn", "active")],
    }));
    state = reduceSessionFact(state, {
      ...metadata(3),
      type: "interaction.requested",
      expiresAt: 2_000_000_000_000,
      interactionId: "interaction",
      kind: "approval",
      threadId: "thread",
      turnId: "turn",
    });
    state = reduceSessionFact(state, {
      ...metadata(4),
      type: "interaction.settled",
      interactionId: "interaction",
      outcome: "answered",
    });
    expect(state.interactions).toEqual({});

    state = reduceSessionFact(state, {
      ...metadata(5),
      type: "operation.changed",
      operation: "turn_start",
      operationId: "operation",
      outcome: "confirmed",
      threadId: "thread",
    });
    expect(state.operations).toEqual({});
    state = reduceSessionFact(state, {
      ...metadata(6),
      type: "thread.deleted",
      threadId: "thread",
    });
    expect(Object.keys(state.threadTombstones)).toHaveLength(1);
    state = reduceSessionFact(state, {
      ...metadata(1, 128, 2),
      type: "account.changed",
      availability: "signed_in",
    });
    expect(state.threadTombstones).toEqual({});
  });

  test("fails closed before same-generation tombstones can grow without bound", () => {
    let state = createSessionState();
    let position = 0;
    for (
      let index = 0;
      index < SESSION_RETENTION_POLICY.maxThreadTombstonesPerAccount;
      index += 1
    ) {
      const threadId = `thread-${String(index)}`;
      position += 1;
      state = reduceSessionFact(state, threadSnapshot(position, threadId));
      position += 1;
      state = reduceSessionFact(state, {
        ...metadata(position),
        type: "thread.deleted",
        threadId,
      });
    }
    expect(Object.keys(state.threadTombstones)).toHaveLength(
      SESSION_RETENTION_POLICY.maxThreadTombstonesPerAccount,
    );
    position += 1;
    state = reduceSessionFact(state, threadSnapshot(position, "thread-overflow"));
    position += 1;
    expect(() => reduceSessionFact(state, {
      ...metadata(position),
      type: "thread.deleted",
      threadId: "thread-overflow",
    })).toThrow(SessionFactInvariantError);
  });

  test("bounds global completed display text and rejects excess mandatory text", () => {
    const oneMiB = "z".repeat(SESSION_RETENTION_POLICY.maxDisplayBytesPerThread);
    let state = createSessionState();
    for (let index = 0; index < 17; index += 1) {
      state = reduceSessionFact(state, threadSnapshot(index + 1, `thread-${String(index)}`, {
        turns: [turn(`turn-${String(index)}`, "completed", [{
          id: `item-${String(index)}`,
          kind: "assistant_text",
          text: oneMiB,
          truncated: false,
        }])],
      }));
    }
    expect(state.retainedDisplayTextUtf8Bytes)
      .toBe(SESSION_RETENTION_POLICY.maxDisplayBytesTotal);
    expect(state.items.size).toBe(16);

    state = createSessionState();
    let position = 0;
    for (let index = 0; index < 16; index += 1) {
      position += 1;
      state = reduceSessionFact(state, threadSnapshot(position, `active-${String(index)}`, {
        status: "active",
        turns: [turn(`turn-${String(index)}`, "active")],
      }));
      position += 1;
      state = reduceSessionFact(state, {
        ...metadata(position, oneMiB.length + 512),
        type: "item.delta",
        channel: "assistant_text",
        delta: oneMiB,
        itemId: `active-item-${String(index)}`,
        threadId: `active-${String(index)}`,
        truncated: false,
        turnId: `turn-${String(index)}`,
      });
    }
    position += 1;
    state = reduceSessionFact(state, threadSnapshot(position, "active-16", {
      status: "active",
      turns: [turn("turn-16", "active")],
    }));
    position += 1;
    expect(() => reduceSessionFact(state, {
      ...metadata(position, oneMiB.length + 512),
      type: "item.delta",
      channel: "assistant_text",
      delta: oneMiB,
      itemId: "active-item-16",
      threadId: "active-16",
      truncated: false,
      turnId: "turn-16",
    })).toThrow(SessionFactInvariantError);
  });

  test("forgets an account completely without affecting another account", () => {
    let state = reduceSessionFact(createSessionState(), threadSnapshot(1, "removed", {
      turns: [turn("removed-turn", "completed", [{
        id: "removed-item",
        kind: "assistant_text",
        text: "removed text",
        truncated: false,
      }])],
    }));
    state = reduceSessionFact(state, {
      ...threadSnapshot(1, "retained", {
        turns: [turn("retained-turn")],
      }),
      accountProfileId: "acct_retained",
    });
    const purged = purgeSessionAccount(state, accountProfileId);
    expect(Object.values(purged.threads).map(({ accountProfileId: id }) => id))
      .toEqual(["acct_retained"]);
    expect([...purged.items.values()].map(({ accountProfileId: id }) => id))
      .toEqual([]);
    expect(purged.cursors[sessionEntityKey(accountProfileId, "")]).toBeUndefined();
    expect(purged.retainedDisplayTextUtf8Bytes).toBe(0);
    expect(purgeSessionAccount(purged, accountProfileId)).toBe(purged);
  });
});
