import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { assertProperty, fc } from "@hra-internal/test";

import type { ChatPaneProjection } from "../../contracts/runtime";

import {
  CHAT_MAX_DELTA_UTF8_BYTES,
  CHAT_MAX_HANDOFF_HISTORY_ITEMS,
  CHAT_MAX_RESPONSE_TAIL_UTF8_BYTES,
} from "../src/chat";
import { CHAT_MAX_TURN_RECEIPTS_PER_PANE } from "../src/chat/types";
import { applyMigrations } from "../src/state/database";
import {
  ChatPaneStore,
  harnessObserverPaneId,
} from "../src/state/chat-pane-store";

const ACCOUNT = "acct_storeprimary1";
const PANE = "pane_storeprimary1";
const REPOSITORY = `repo_${"1".repeat(26)}`;
const REPOSITORY_TWO = `repo_${"2".repeat(26)}`;
const TURN = "chatturn_store001";
const ASSISTANT_ITEM = "item_storeassistant01";
const NOW = new Date("2026-08-03T12:00:00.000Z");

test("pins predecessor hash domains for durable pane and receipt identities", async () => {
  const source = await Bun.file(
    new URL("../src/state/chat-pane-store.ts", import.meta.url),
  ).text();
  expect(source).toContain('"oprte-harness-observer-pane-v1\\0"');
  expect(source).toContain('"oprte-chat-tool-v1\\0"');
  expect(source).toContain('"oprte-chat-assistant-completion-v1\\0"');
});

test("chat pane storage enforces CAS, one active turn, and private prompt custody", () => {
  withStore((store) => {
    const created = createPane(store);
    expect(created).toMatchObject({
      interactionMode: "chat",
      revision: 1,
      state: "ready",
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      activity: { ordinal: 0, kind: "idle" },
    });
    const renamed = store.rename(PANE, created.revision, "Focused pane", NOW);
    expect(renamed).toMatchObject({ revision: 2, title: "Focused pane" });
    expect(() => store.rename(PANE, created.revision, "Stale", NOW)).toThrow(
      expect.objectContaining({ code: "revision_conflict" }),
    );

    const admission = store.beginTurn({
      paneId: PANE,
      expectedRevision: renamed.revision,
      turnId: TURN,
      prompt: "private prompt",
      now: NOW,
    });
    expect(admission.kind).toBe("begun");
    const begun = admission.pane;
    expect(begun).toMatchObject({
      revision: 3,
      state: "starting",
      activity: { ordinal: 1, kind: "messageSent" },
    });
    expect(JSON.stringify(begun)).not.toContain("private prompt");
    expect(store.beginTurn({
      paneId: PANE,
      expectedRevision: begun.revision,
      turnId: TURN,
      prompt: "private prompt",
      now: NOW,
    })).toEqual({ kind: "replayed", pane: begun });
    expect(() => store.beginTurn({
      paneId: PANE,
      expectedRevision: begun.revision,
      turnId: "chatturn_store002",
      prompt: "second",
      now: NOW,
    })).toThrow(expect.objectContaining({ code: "invalid_state" }));
    expect(store.require(PANE).activePrompt).toBe("private prompt");
  });
});

test("attached harness observers are deterministic, replayable, immutable, and outer-transaction safe", () => {
  withStore((store, database) => {
    const actorId = "hactor_storeobserver01";
    const input = {
      actorId,
      repository: {
        id: REPOSITORY,
        name: "Example",
        workingDirectory: "/fixture/example",
      },
      binding: {
        accountProfileId: ACCOUNT,
        threadId: "thread_store_observer",
        restartThreadId: "raw_thread_store_observer",
      },
      title: "Research actor",
      now: NOW,
    } as const;

    expect(() => database.transaction(() => {
      store.createAttachedHarnessSession(input);
      throw new Error("rollback fixture");
    })()).toThrow("rollback fixture");
    expect(store.get(harnessObserverPaneId(actorId))).toBeNull();

    const created = database.transaction(() =>
      store.createAttachedHarnessSession(input)
    )();
    expect(created).toMatchObject({
      kind: "created",
      pane: {
        id: harnessObserverPaneId(actorId),
        interactionMode: "harnessObserver",
        accountProfileId: ACCOUNT,
        model: "gpt-5.6-sol",
        reasoningEffort: "ultra",
        title: "Research actor",
        state: "ready",
        turn: null,
      },
    });
    expect(store.require(created.pane.id).binding).toEqual(input.binding);
    expect(new ChatPaneStore(database).require(created.pane.id).projection)
      .toEqual(created.pane);
    expect(() => store.remove(created.pane.id, created.pane.revision)).toThrow(
      expect.objectContaining({ code: "invalid_state" }),
    );
    expect(store.require(created.pane.id).projection).toEqual(created.pane);

    expect(database.transaction(() =>
      store.createAttachedHarnessSession(input)
    )()).toEqual({ kind: "replayed", pane: created.pane });

    expect(() => store.configure(
      created.pane.id,
      created.pane.revision,
      "max",
      NOW,
    )).toThrow(expect.objectContaining({ code: "invalid_state" }));
    expect(() => store.selectRepository(
      created.pane.id,
      created.pane.revision,
      { id: REPOSITORY_TWO, name: "Other", workingDirectory: "/fixture/other" },
      NOW,
    )).toThrow(expect.objectContaining({ code: "invalid_state" }));
    expect(() => store.beginTurn({
      paneId: created.pane.id,
      expectedRevision: created.pane.revision,
      turnId: TURN,
      prompt: "must not send",
      now: NOW,
    })).toThrow(expect.objectContaining({ code: "invalid_state" }));
    expect(() => database.transaction(() => store.createAttachedHarnessSession({
      ...input,
      title: "Conflicting actor title",
    }))()).toThrow(expect.objectContaining({ code: "conflict" }));
  });
});

test("one provider thread cannot be attached to two harness observer panes", () => {
  withStore((store, database) => {
    const base = {
      repository: {
        id: REPOSITORY,
        name: "Example",
        workingDirectory: "/fixture/example",
      },
      binding: {
        accountProfileId: ACCOUNT,
        threadId: "thread_store_unique_observer",
        restartThreadId: "raw_thread_store_unique_observer",
      },
      title: "Observer",
      now: NOW,
    } as const;
    database.transaction(() => store.createAttachedHarnessSession({
      ...base,
      actorId: "hactor_storeobserver02",
    }))();
    expect(() => database.transaction(() => store.createAttachedHarnessSession({
      ...base,
      actorId: "hactor_storeobserver03",
    }))()).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(store.list()).toHaveLength(1);
  });
});

test("harness observers cache one bounded terminal response without becoming transcript authority", () => {
  withStore((store, database) => {
    const actorId = "hactor_storeobserver04";
    const pane = database.transaction(() => store.createAttachedHarnessSession({
      actorId,
      repository: {
        id: REPOSITORY,
        name: "Example",
        workingDirectory: "/fixture/example",
      },
      binding: {
        accountProfileId: ACCOUNT,
        threadId: "thread_store_response_observer",
        restartThreadId: "raw_thread_store_response_observer",
      },
      title: "Response observer",
      now: NOW,
    }))().pane;
    const markdown = `prefix-${"x".repeat(CHAT_MAX_RESPONSE_TAIL_UTF8_BYTES)}`;
    const input = {
      paneId: pane.id,
      turnId: "chatturn_storeobserver1",
      markdown,
      startedAt: NOW,
      completedAt: new Date(NOW.getTime() + 1_000),
      now: new Date(NOW.getTime() + 1_000),
    } as const;

    expect(() => database.transaction(() => {
      store.seedAttachedHarnessLatestResponse(input);
      throw new Error("rollback seeded response");
    })()).toThrow("rollback seeded response");
    expect(store.require(pane.id).projection.turn).toBeNull();

    const seeded = database.transaction(() =>
      store.seedAttachedHarnessLatestResponse(input)
    )();
    expect(seeded).toMatchObject({
      kind: "seeded",
      pane: {
        revision: 2,
        interactionMode: "harnessObserver",
        state: "ready",
        activity: { ordinal: 1, kind: "responseCompleted" },
        turn: {
          id: input.turnId,
          status: "completed",
          responseMarkdown: {
            totalUtf8Bytes: Buffer.byteLength(markdown, "utf8"),
            truncatedPrefix: true,
          },
          reasoningSummary: { tail: "", totalUtf8Bytes: 0, truncatedPrefix: false },
          tools: [],
        },
      },
    });
    expect(seeded.pane.turn?.responseMarkdown.tail)
      .toBe(markdown.slice(-CHAT_MAX_RESPONSE_TAIL_UTF8_BYTES));
    expect(store.handoffHistory(pane.id, false)).toEqual({ items: [], complete: false });
    expect(store.seedAttachedHarnessLatestResponse(input)).toEqual({
      kind: "replayed",
      pane: seeded.pane,
    });
    expect(() => store.seedAttachedHarnessLatestResponse({
      ...input,
      markdown: "different",
    })).toThrow(expect.objectContaining({ code: "conflict" }));
  });
});

test("attached actor turns settle exactly once from durable results and retain bounded history", () => {
  withStore((store, database) => {
    const pane = database.transaction(() => store.createAttachedHarnessSession({
      actorId: "hactor_storeobserver05",
      repository: {
        id: REPOSITORY,
        name: "Example",
        workingDirectory: "/fixture/example",
      },
      binding: {
        accountProfileId: ACCOUNT,
        threadId: "thread_store_followup_observer",
        restartThreadId: "raw_thread_store_followup_observer",
      },
      title: "Follow-up observer",
      now: NOW,
    }))().pane;
    const begun = store.beginAttachedHarnessTurn({
      paneId: pane.id,
      expectedRevision: pane.revision,
      turnId: TURN,
      prompt: "Inspect the next edge.",
      now: NOW,
    });
    expect(begun).toMatchObject({
      kind: "begun",
      pane: {
        interactionMode: "harnessObserver",
        state: "starting",
        turn: { id: TURN, status: "starting" },
      },
    });

    const completed = store.completeAttachedHarnessTurn({
      paneId: pane.id,
      turnId: TURN,
      markdown: "Exact actor result.",
      now: new Date(NOW.getTime() + 1_000),
    });
    expect(completed).toMatchObject({
      interactionMode: "harnessObserver",
      state: "ready",
      activity: { ordinal: 2, kind: "responseCompleted" },
      turn: {
        id: TURN,
        status: "completed",
        responseMarkdown: {
          tail: "Exact actor result.",
          totalUtf8Bytes: 19,
          truncatedPrefix: false,
        },
      },
    });
    expect(store.completeAttachedHarnessTurn({
      paneId: pane.id,
      turnId: TURN,
      markdown: "Exact actor result.",
      now: new Date(NOW.getTime() + 2_000),
    })).toEqual(completed);
    expect(store.handoffHistory(pane.id, false)).toEqual({
      complete: true,
      items: [
        { role: "user", text: "Inspect the next edge." },
        { role: "assistant", text: "Exact actor result." },
      ],
    });
    expect(() => store.beginAttachedHarnessTurn({
      paneId: pane.id,
      expectedRevision: completed!.revision,
      turnId: TURN,
      prompt: "Inspect the next edge.",
      now: new Date(NOW.getTime() + 2_000),
    })).toThrow(expect.objectContaining({ code: "conflict" }));
  });
});

test("attached actor session rebinding is exact, replayable, and mode-scoped", () => {
  withStore((store, database) => {
    database.query(`
      INSERT INTO account_profiles (
        profile_id, label, auth_state, process_generation,
        selected, created_at, updated_at
      ) VALUES ('acct_storesecondary1', 'Secondary', 'signed_in', 1, 0, ?1, ?1)
    `).run(NOW.toISOString());
    const pane = database.transaction(() => store.createAttachedHarnessSession({
      actorId: "hactor_storeobserver06",
      repository: {
        id: REPOSITORY,
        name: "Example",
        workingDirectory: "/fixture/example",
      },
      binding: {
        accountProfileId: ACCOUNT,
        threadId: "thread_store_old_observer",
        restartThreadId: "raw_thread_store_old_observer",
      },
      title: "Rebound observer",
      now: NOW,
    }))().pane;
    const nextBinding = {
      accountProfileId: "acct_storesecondary1",
      threadId: "thread_store_new_observer",
      restartThreadId: "raw_thread_store_new_observer",
    } as const;
    const rebound = store.rebindAttachedHarnessSession({
      paneId: pane.id,
      binding: nextBinding,
      now: new Date(NOW.getTime() + 1_000),
    });
    expect(rebound).toMatchObject({
      id: pane.id,
      revision: pane.revision + 1,
      accountProfileId: nextBinding.accountProfileId,
      interactionMode: "harnessObserver",
    });
    expect(store.require(pane.id).binding).toEqual(nextBinding);
    expect(store.rebindAttachedHarnessSession({
      paneId: pane.id,
      binding: nextBinding,
      now: new Date(NOW.getTime() + 2_000),
    })).toEqual(rebound);

    const ordinary = store.create({
      paneId: "pane_storeordinary2",
      repository: {
        id: REPOSITORY,
        name: "Example",
        workingDirectory: "/fixture/example",
      },
      accountProfileId: ACCOUNT,
      reasoningEffort: "ultra",
      now: NOW,
    });
    expect(() => store.rebindAttachedHarnessSession({
      paneId: ordinary.id,
      binding: nextBinding,
      now: NOW,
    })).toThrow(expect.objectContaining({ code: "invalid_state" }));
  });
});

test("whitespace-only titles are rejected without consuming a revision", () => {
  withStore((store) => {
    const created = createPane(store);
    expect(() => store.rename(PANE, created.revision, " ", NOW)).toThrow();
    expect(store.require(PANE).projection).toEqual(created);
  });
});

test("pane order is exact, durable, contiguous, and normalized after removal", () => {
  withStore((store, database) => {
    const panes = Array.from({ length: 64 }, (_, index) => store.create({
      paneId: `pane_slot${String(index).padStart(8, "0")}`,
      repository: { id: REPOSITORY, name: "Example", workingDirectory: "/fixture/example" },
      accountProfileId: ACCOUNT,
      reasoningEffort: "ultra",
      now: new Date(NOW.getTime() + index),
    }));
    const initialOrder = panes.map(({ id }) => id);
    expect(store.list().map(({ id }) => id)).toEqual(initialOrder);
    expect(() => store.create({
      paneId: "pane_slotoverflow",
      repository: { id: REPOSITORY, name: "Example", workingDirectory: "/fixture/example" },
      accountProfileId: ACCOUNT,
      reasoningEffort: "ultra",
      now: new Date(NOW.getTime() + 65),
    })).toThrow(expect.objectContaining({ code: "limit" }));

    const reordered = initialOrder.toReversed();
    expect(store.reorder(initialOrder, reordered)).toEqual(reordered);
    expect(store.list().map(({ id }) => id)).toEqual(reordered);
    expect(new ChatPaneStore(database).list().map(({ id }) => id)).toEqual(reordered);
    expect(() => store.reorder(initialOrder, initialOrder)).toThrow(
      expect.objectContaining({ code: "conflict" }),
    );
    expect(() => store.reorder(reordered, reordered.slice(1))).toThrow(
      expect.objectContaining({ code: "conflict" }),
    );
    expect(() => store.reorder(
      reordered,
      [...reordered.slice(0, -1), "pane_orderunknown"],
    )).toThrow(
      expect.objectContaining({ code: "conflict" }),
    );

    const removed = panes[16]!;
    store.remove(removed.id, removed.revision);
    const afterRemoval = reordered.filter((paneId) => paneId !== removed.id);
    expect(store.list().map(({ id }) => id)).toEqual(afterRemoval);
    const replacement = store.create({
      paneId: "pane_slotreplacement",
      repository: { id: REPOSITORY, name: "Example", workingDirectory: "/fixture/example" },
      accountProfileId: ACCOUNT,
      reasoningEffort: "max",
      now: new Date(NOW.getTime() + 66),
    });
    const restarted = new ChatPaneStore(database);
    expect(restarted.list().map(({ id }) => id)).toEqual([
      ...afterRemoval,
      replacement.id,
    ]);
    expect(database.query(`
      SELECT display_order FROM chat_panes
      WHERE archived_at IS NULL ORDER BY display_order
    `).all()).toEqual(Array.from({ length: 64 }, (_, display_order) => ({ display_order })));

    database.query(`
      UPDATE chat_panes SET display_order = 65
      WHERE pane_id = ?1
    `).run(replacement.id);
    expect(() => restarted.list()).toThrow(
      expect.objectContaining({ code: "corrupt_state" }),
    );
  });
});

test("activity ordinals advance across the pane lifetime", () => {
  withStore((store) => {
    const created = createPane(store);
    const selected = store.selectRepository(PANE, created.revision, {
      id: REPOSITORY_TWO,
      name: "Other",
      workingDirectory: "/fixture/other",
    }, NOW);
    expect(selected.repository).toEqual({ id: REPOSITORY_TWO, name: "Other" });
    const begun = store.beginTurn({
      paneId: PANE,
      expectedRevision: selected.revision,
      turnId: TURN,
      prompt: "prompt",
      now: NOW,
    }).pane;
    expect(() => store.selectRepository(PANE, begun.revision, {
      id: REPOSITORY,
      name: "Example",
      workingDirectory: "/fixture/example",
    }, NOW)).toThrow(expect.objectContaining({ code: "invalid_state" }));

    const toolActivities = Array.from(
      { length: 4 },
      () => store.recordToolStarted(PANE, TURN, NOW)?.activity,
    );
    expect(toolActivities).toEqual([
      { ordinal: 2, kind: "toolStarted" },
      { ordinal: 3, kind: "toolStarted" },
      { ordinal: 4, kind: "toolStarted" },
      { ordinal: 5, kind: "toolStarted" },
    ]);
    const thinking = store.recordThinkingCompleted(PANE, TURN, NOW);
    expect(thinking?.activity).toEqual({
      ordinal: 6,
      kind: "thinkingCompleted",
    });
  });
});

test("pane configuration remains available while workspace preparation is pending", () => {
  withStore((store) => {
    const created = createPane(store);
    expect(created.workspace).toEqual({
      mode: "managedWorktree",
      state: "preparing",
      revision: 1,
      recoveryKind: null,
    });

    const configured = store.configure(
      PANE,
      created.revision,
      "max",
      NOW,
      "fast",
    );
    expect(configured).toMatchObject({
      accountProfileId: ACCOUNT,
      reasoningEffort: "max",
      serviceTier: "fast",
      revision: created.revision + 1,
      workspace: {
        mode: "managedWorktree",
        state: "preparing",
        revision: 1,
        recoveryKind: null,
      },
    });
    const preservedTier = store.configure(
      PANE,
      configured.revision,
      "ultra",
      NOW,
    );
    expect(preservedTier).toMatchObject({
      reasoningEffort: "ultra",
      serviceTier: "fast",
      revision: configured.revision + 1,
    });
  });
});

test("Unicode deltas retain exact UTF-8 offsets and survive terminal timestamp skew", () => {
  withStore((store) => {
    const created = createPane(store);
    store.beginTurn({
      paneId: PANE,
      expectedRevision: created.revision,
      turnId: TURN,
      prompt: "prompt",
      now: NOW,
    });
    store.reserveAccount(PANE, TURN, ACCOUNT, NOW);
    store.prepareProviderThread(PANE, TURN, {
      accountProfileId: ACCOUNT,
      threadId: "thread_store_1",
      restartThreadId: "raw_thread_store_1",
    }, NOW);
    store.markTurnAccepted(PANE, TURN, "turn_store_1", NOW);

    const first = store.appendDelta({
      paneId: PANE,
      turnId: TURN,
      channel: "responseMarkdown",
      delta: "é🙂",
      assistantMessageId: ASSISTANT_ITEM,
      now: NOW,
    });
    const second = store.appendDelta({
      paneId: PANE,
      turnId: TURN,
      channel: "responseMarkdown",
      delta: "界",
      assistantMessageId: ASSISTANT_ITEM,
      now: NOW,
    });
    expect(first?.delta.startUtf8Offset).toBe(0);
    expect(second?.delta.startUtf8Offset).toBe(Buffer.byteLength("é🙂"));
    expect(second?.pane.turn?.responseMarkdown).toEqual({
      tail: "é🙂界",
      totalUtf8Bytes: Buffer.byteLength("é🙂界"),
      truncatedPrefix: false,
    });
    expect(store.reconcileAssistantCompletion({
      paneId: PANE,
      turnId: TURN,
      assistantMessageId: ASSISTANT_ITEM,
      fullText: "é🙂界",
      truncated: false,
      now: NOW,
    })).toEqual({ kind: "verified" });

    const completed = store.completeTurn(
      PANE,
      TURN,
      new Date("2026-08-03T11:59:00.000Z"),
    );
    expect(completed?.turn?.completedAt).toBe(NOW.toISOString());
    expect(store.handoffHistory(PANE, false)).toEqual({
      complete: true,
      items: [
        { role: "user", text: "prompt" },
        { role: "assistant", text: "é🙂界" },
      ],
    });
  });
});

test("one durable stream batch preserves every contract revision and UTF-8 offset", () => {
  withStore((store) => {
    const created = createPane(store);
    store.beginTurn({
      paneId: PANE,
      expectedRevision: created.revision,
      turnId: TURN,
      prompt: "batch prompt",
      now: NOW,
    });
    store.reserveAccount(PANE, TURN, ACCOUNT, NOW);
    store.prepareProviderThread(PANE, TURN, {
      accountProfileId: ACCOUNT,
      threadId: "thread_store_batch",
      restartThreadId: "raw_thread_store_batch",
    }, NOW);
    const accepted = store.markTurnAccepted(PANE, TURN, "turn_store_batch", NOW);
    const fragments = ["é", "🙂", "界", "\nfinal"] as const;

    const result = store.appendDeltaBatch({
      paneId: PANE,
      turnId: TURN,
      channel: "responseMarkdown",
      deltas: fragments,
      assistantMessageId: ASSISTANT_ITEM,
      now: NOW,
    });

    expect(result?.deltas.map(({ revision }) => revision)).toEqual(
      fragments.map((_, index) => accepted.revision + index + 1),
    );
    expect(result?.deltas.map(({ startUtf8Offset }) => startUtf8Offset)).toEqual([
      0,
      Buffer.byteLength("é"),
      Buffer.byteLength("é🙂"),
      Buffer.byteLength("é🙂界"),
    ]);
    expect(result?.pane.turn?.responseMarkdown).toEqual({
      tail: fragments.join(""),
      totalUtf8Bytes: Buffer.byteLength(fragments.join("")),
      truncatedPrefix: false,
    });
    expect(result?.pane.revision).toBe(accepted.revision + fragments.length);
    expect(store.require(PANE).assistantItem).toMatchObject({
      id: ASSISTANT_ITEM,
      streamText: fragments.join(""),
      overflowed: false,
      verified: false,
    });
  });
});

test("a batch crossing the response window keeps the tail and drops unusable duplicate text", () => {
  withStore((store) => {
    const created = createPane(store);
    store.beginTurn({
      paneId: PANE,
      expectedRevision: created.revision,
      turnId: TURN,
      prompt: "batch overflow prompt",
      now: NOW,
    });
    store.reserveAccount(PANE, TURN, ACCOUNT, NOW);
    store.prepareProviderThread(PANE, TURN, {
      accountProfileId: ACCOUNT,
      threadId: "thread_store_batch_overflow",
      restartThreadId: "raw_thread_store_batch_overflow",
    }, NOW);
    store.markTurnAccepted(PANE, TURN, "turn_store_batch_overflow", NOW);
    const chunk = "x".repeat(CHAT_MAX_DELTA_UTF8_BYTES);
    store.appendDeltaBatch({
      paneId: PANE,
      turnId: TURN,
      channel: "responseMarkdown",
      deltas: Array.from({ length: 63 }, () => chunk),
      assistantMessageId: ASSISTANT_ITEM,
      now: NOW,
    });

    const crossed = store.appendDeltaBatch({
      paneId: PANE,
      turnId: TURN,
      channel: "responseMarkdown",
      deltas: [chunk, chunk],
      assistantMessageId: ASSISTANT_ITEM,
      now: NOW,
    });

    expect(crossed?.pane.turn?.responseMarkdown).toMatchObject({
      totalUtf8Bytes: 65 * CHAT_MAX_DELTA_UTF8_BYTES,
      truncatedPrefix: true,
    });
    expect(Buffer.byteLength(crossed?.pane.turn?.responseMarkdown.tail ?? ""))
      .toBe(CHAT_MAX_RESPONSE_TAIL_UTF8_BYTES);
    expect(store.require(PANE).assistantItem).toMatchObject({
      streamText: "",
      overflowed: true,
      verified: false,
    });
  });
});

test("cross-pane stream co-commit isolates one rejected pane at a savepoint", () => {
  withStore((store) => {
    const secondPane = "pane_storesecondary";
    const secondTurn = "chatturn_storesecond";
    const prepare = (
      paneId: string,
      turnId: string,
      providerSuffix: string,
    ) => {
      const created = createPane(store, paneId);
      store.beginTurn({
        paneId,
        expectedRevision: created.revision,
        turnId,
        prompt: "savepoint prompt",
        now: NOW,
      });
      store.reserveAccount(paneId, turnId, ACCOUNT, NOW);
      store.prepareProviderThread(paneId, turnId, {
        accountProfileId: ACCOUNT,
        threadId: `thread_store_${providerSuffix}`,
        restartThreadId: `raw_thread_store_${providerSuffix}`,
      }, NOW);
      return store.markTurnAccepted(paneId, turnId, `turn_store_${providerSuffix}`, NOW);
    };
    const firstAccepted = prepare(PANE, TURN, "savepoint_a");
    prepare(secondPane, secondTurn, "savepoint_b");
    store.appendDelta({
      paneId: secondPane,
      turnId: secondTurn,
      channel: "responseMarkdown",
      delta: "unverified",
      assistantMessageId: "item_storeprevious01",
      now: NOW,
    });

    const outcomes = store.appendDeltaBatches([
      {
        paneId: PANE,
        turnId: TURN,
        channel: "responseMarkdown",
        deltas: ["healthy"],
        assistantMessageId: ASSISTANT_ITEM,
        now: NOW,
      },
      {
        paneId: secondPane,
        turnId: secondTurn,
        channel: "responseMarkdown",
        deltas: ["must roll back"],
        assistantMessageId: "item_storenewassist01",
        now: NOW,
      },
    ]);

    expect(outcomes.map(({ kind }) => kind)).toEqual(["written", "rejected"]);
    expect(store.require(PANE).projection).toMatchObject({
      revision: firstAccepted.revision + 1,
      turn: { responseMarkdown: { tail: "healthy" } },
    });
    expect(store.require(secondPane)).toMatchObject({
      assistantItem: { id: "item_storeprevious01", streamText: "unverified" },
      projection: { turn: { responseMarkdown: { tail: "unverified" } } },
    });
  });
});

test("a truncated response tail permanently marks handoff history incomplete", () => {
  withStore((store) => {
    const created = createPane(store);
    store.beginTurn({
      paneId: PANE,
      expectedRevision: created.revision,
      turnId: TURN,
      prompt: "retain completeness truth",
      now: NOW,
    });
    store.reserveAccount(PANE, TURN, ACCOUNT, NOW);
    store.prepareProviderThread(PANE, TURN, {
      accountProfileId: ACCOUNT,
      threadId: "thread_store_large",
      restartThreadId: "raw_thread_store_large",
    }, NOW);
    store.markTurnAccepted(PANE, TURN, "turn_store_large", NOW);

    const fragment = "🙂".repeat(CHAT_MAX_DELTA_UTF8_BYTES / 4);
    const iterations = Math.floor(CHAT_MAX_RESPONSE_TAIL_UTF8_BYTES / CHAT_MAX_DELTA_UTF8_BYTES) + 1;
    for (let index = 0; index < iterations; index += 1) {
      store.appendDelta({
        paneId: PANE,
        turnId: TURN,
        channel: "responseMarkdown",
        delta: fragment,
        assistantMessageId: ASSISTANT_ITEM,
        now: NOW,
      });
    }
    const active = store.require(PANE).projection;
    expect(active.turn?.responseMarkdown.truncatedPrefix).toBeTrue();
    expect(Buffer.byteLength(active.turn?.responseMarkdown.tail ?? ""))
      .toBe(CHAT_MAX_RESPONSE_TAIL_UTF8_BYTES);

    expect(store.reconcileAssistantCompletion({
      paneId: PANE,
      turnId: TURN,
      assistantMessageId: ASSISTANT_ITEM,
      fullText: "",
      truncated: true,
      now: NOW,
    })).toEqual({ kind: "tainted" });
    expect(() => store.completeTurn(PANE, TURN, NOW)).toThrow(
      expect.objectContaining({ code: "invalid_state" }),
    );
    store.poisonTurn(PANE, TURN, NOW);
    const history = store.handoffHistory(PANE, false);
    expect(history.complete).toBeFalse();
    expect(store.require(PANE).historyTruncated).toBeTrue();
  });
});

test("handoff history caps provider items without splitting an exchange", () => {
  withStore((store) => {
    let pane = createPane(store);
    for (let index = 0; index < 513; index += 1) {
      const suffix = String(index).padStart(4, "0");
      const turnId = `chatturn_handoff${suffix}`;
      const assistantMessageId = `item_handoff${suffix}`;
      pane = store.beginTurn({
        paneId: PANE,
        expectedRevision: pane.revision,
        turnId,
        prompt: `user-${String(index)}`,
        now: NOW,
      }).pane;
      store.reserveAccount(PANE, turnId, ACCOUNT, NOW);
      store.prepareProviderThread(PANE, turnId, {
        accountProfileId: ACCOUNT,
        threadId: "thread_handoff",
        restartThreadId: "raw_thread_handoff",
      }, NOW);
      store.markTurnAccepted(PANE, turnId, `turn_handoff_${suffix}`, NOW);
      store.appendDelta({
        paneId: PANE,
        turnId,
        channel: "responseMarkdown",
        delta: `assistant-${String(index)}`,
        assistantMessageId,
        now: NOW,
      });
      expect(store.reconcileAssistantCompletion({
        paneId: PANE,
        turnId,
        assistantMessageId,
        fullText: `assistant-${String(index)}`,
        truncated: false,
        now: NOW,
      })).toEqual({ kind: "verified" });
      const completed = store.completeTurn(PANE, turnId, NOW);
      if (completed === null) throw new Error("fixture turn did not complete");
      pane = completed;
    }

    const history = store.handoffHistory(PANE, false);
    expect(history.complete).toBeFalse();
    expect(history.items).toHaveLength(CHAT_MAX_HANDOFF_HISTORY_ITEMS);
    expect(history.items.slice(0, 2)).toEqual([
      { role: "user", text: "user-1" },
      { role: "assistant", text: "assistant-1" },
    ]);
    expect(history.items.slice(-2)).toEqual([
      { role: "user", text: "user-512" },
      { role: "assistant", text: "assistant-512" },
    ]);
    for (let index = 0; index < history.items.length; index += 2) {
      expect(history.items[index]?.role).toBe("user");
      expect(history.items[index + 1]?.role).toBe("assistant");
    }
  });
});

test("restart recovery fails active work closed and preserves the private prompt for exact retry", () => {
  withStore((store, database) => {
    const created = createPane(store);
    store.beginTurn({
      paneId: PANE,
      expectedRevision: created.revision,
      turnId: TURN,
      prompt: "interrupted prompt",
      now: NOW,
    });
    store.reserveAccount(PANE, TURN, ACCOUNT, NOW);
    store.prepareProviderThread(PANE, TURN, {
      accountProfileId: ACCOUNT,
      threadId: "thread_store_restart",
      restartThreadId: "raw_thread_store_restart",
    }, NOW);
    store.markTurnAccepted(PANE, TURN, "turn_store_restart", NOW);
    store.startTool(PANE, TURN, "filesystem", NOW);

    const [recovered] = store.recoverInterrupted(new Date(NOW.getTime() + 1));
    expect(recovered).toMatchObject({
      state: "attention",
      attention: { code: "runtime_unavailable", retryable: true },
      turn: { status: "failed", tools: [expect.objectContaining({ status: "completed" })] },
      recoverablePrompt: true,
    });
    expect(store.require(PANE)).toMatchObject({
      binding: null,
      providerTurnId: null,
      activePrompt: "interrupted prompt",
    });
    expect(JSON.stringify(recovered)).not.toContain("interrupted prompt");
    expect(JSON.stringify(store.list())).not.toContain("interrupted prompt");

    const restartedStore = new ChatPaneStore(database);
    expect(restartedStore.require(PANE).activePrompt).toBe("interrupted prompt");
    const retry = restartedStore.retryTurn({
      paneId: PANE,
      expectedRevision: recovered?.revision ?? 0,
      priorFailedTurnId: TURN,
      turnId: "chatturn_store002",
      now: new Date(NOW.getTime() + 2),
    });
    expect(retry).toMatchObject({
      kind: "begun",
      pane: {
        state: "starting",
        turn: { id: "chatturn_store002" },
        recoverablePrompt: false,
      },
    });
    expect(restartedStore.require(PANE).activePrompt).toBe("interrupted prompt");
    expect(JSON.stringify(retry)).not.toContain("interrupted prompt");
  });
});

test("retryable terminal paths retain only the bounded gateway-private prompt", () => {
  const cases = [
    ["provider attention", (store: ChatPaneStore) => store.enterAttention({
      paneId: PANE,
      turnId: TURN,
      attention: { code: "turn_failed", message: "Retry this turn.", retryable: true },
      clearBinding: true,
      now: NOW,
    })],
    ["context reset", (store: ChatPaneStore) => store.resetContextWithAttention({
      paneId: PANE,
      turnId: TURN,
      attention: {
        code: "continuation_failed",
        message: "Retry without prior context.",
        retryable: true,
      },
      now: NOW,
    })],
    ["account detachment", (store: ChatPaneStore) =>
      store.detachUnavailableAccount(PANE, ACCOUNT, NOW)],
    ["poison containment", (store: ChatPaneStore) => store.poisonTurn(PANE, TURN, NOW)],
  ] as const;

  for (const [label, terminate] of cases) {
    withStore((store) => {
      const prompt = `private ${label} prompt`;
      const created = createPane(store);
      store.beginTurn({
        paneId: PANE,
        expectedRevision: created.revision,
        turnId: TURN,
        prompt,
        now: NOW,
      });
      const failed = terminate(store);
      expect(failed, label).toMatchObject({
        state: "attention",
        attention: { retryable: true },
        turn: { id: TURN, status: "failed" },
        recoverablePrompt: true,
      });
      expect(store.require(PANE).activePrompt, label).toBe(prompt);
      expect(JSON.stringify(failed), label).not.toContain(prompt);
      expect(JSON.stringify(store.list()), label).not.toContain(prompt);
    });
  }

  withStore((store) => {
    const created = createPane(store);
    store.beginTurn({
      paneId: PANE,
      expectedRevision: created.revision,
      turnId: TURN,
      prompt: "must be discarded",
      now: NOW,
    });
    store.enterAttention({
      paneId: PANE,
      turnId: TURN,
      attention: { code: "turn_failed", message: "Terminal failure.", retryable: false },
      clearBinding: true,
      now: NOW,
    });
    expect(store.require(PANE).activePrompt).toBeNull();
  });
});

test("an exact retry completes its retained prompt into history once", () => {
  withStore((store) => {
    const created = createPane(store);
    store.beginTurn({
      paneId: PANE,
      expectedRevision: created.revision,
      turnId: TURN,
      prompt: "retry this exact prompt",
      now: NOW,
    });
    const failed = store.enterAttention({
      paneId: PANE,
      turnId: TURN,
      attention: { code: "turn_failed", message: "Try once more.", retryable: true },
      clearBinding: true,
      now: NOW,
    });
    const retryTurnId = "chatturn_store_retry01";
    const retried = store.retryTurn({
      paneId: PANE,
      expectedRevision: failed?.revision ?? 0,
      priorFailedTurnId: TURN,
      turnId: retryTurnId,
      now: new Date(NOW.getTime() + 1),
    }).pane;
    expect(retried.recoverablePrompt).toBeFalse();
    expect(() => store.retryTurn({
      paneId: PANE,
      expectedRevision: retried.revision,
      priorFailedTurnId: TURN,
      turnId: "chatturn_store_retry02",
      now: new Date(NOW.getTime() + 2),
    })).toThrow(expect.objectContaining({ code: "invalid_state" }));

    const completed = completeTurnWithResponse(
      store,
      retryTurnId,
      "retried response",
      "retry_exact",
    );
    expect(completed).toMatchObject({ state: "ready", turn: { status: "completed" } });
    expect(store.require(PANE).activePrompt).toBeNull();
    expect(store.completeTurn(PANE, retryTurnId, NOW)).toBeNull();
    expect(store.handoffHistory(PANE, false)).toEqual({
      complete: true,
      items: [
        { role: "user", text: "retry this exact prompt" },
        { role: "assistant", text: "retried response" },
      ],
    });
  });
});

test("normal admission replaces a retained prompt and pane removal clears it", () => {
  withStore((store, database) => {
    const created = createPane(store);
    store.beginTurn({
      paneId: PANE,
      expectedRevision: created.revision,
      turnId: TURN,
      prompt: "discarded failed prompt",
      now: NOW,
    });
    const failed = store.enterAttention({
      paneId: PANE,
      turnId: TURN,
      attention: { code: "turn_failed", message: "Replace or retry.", retryable: true },
      clearBinding: true,
      now: NOW,
    });
    const replacementTurnId = "chatturn_store_replace1";
    store.beginTurn({
      paneId: PANE,
      expectedRevision: failed?.revision ?? 0,
      turnId: replacementTurnId,
      prompt: "replacement prompt",
      now: new Date(NOW.getTime() + 1),
    });
    expect(store.require(PANE).activePrompt).toBe("replacement prompt");
    completeTurnWithResponse(store, replacementTurnId, "replacement response", "replacement");
    expect(store.handoffHistory(PANE, false).items).toEqual([
      { role: "user", text: "replacement prompt" },
      { role: "assistant", text: "replacement response" },
    ]);

    const removalPane = "pane_storeremoval1";
    const removalTurn = "chatturn_storeremoval1";
    const removable = createPane(store, removalPane);
    store.beginTurn({
      paneId: removalPane,
      expectedRevision: removable.revision,
      turnId: removalTurn,
      prompt: "removed private prompt",
      now: NOW,
    });
    const removableFailure = store.enterAttention({
      paneId: removalPane,
      turnId: removalTurn,
      attention: { code: "turn_failed", message: "Close this pane.", retryable: true },
      clearBinding: true,
      now: NOW,
    });
    store.remove(removalPane, removableFailure?.revision ?? 0, NOW);
    expect(store.get(removalPane)).toBeNull();
    expect(database.query(
      "SELECT active_prompt FROM chat_panes WHERE pane_id = ?1",
    ).get(removalPane)).toEqual({ active_prompt: null });
  });
});

test("retry admission rejects stale, wrong, missing, and duplicate identities atomically", () => {
  withStore((store, database) => {
    const created = createPane(store);
    const usedTurnId = "chatturn_store_used001";
    store.beginTurn({
      paneId: PANE,
      expectedRevision: created.revision,
      turnId: usedTurnId,
      prompt: "earlier prompt",
      now: NOW,
    });
    const earlierFailed = store.enterAttention({
      paneId: PANE,
      turnId: usedTurnId,
      attention: { code: "turn_failed", message: "Earlier failure.", retryable: true },
      clearBinding: true,
      now: NOW,
    });
    store.beginTurn({
      paneId: PANE,
      expectedRevision: earlierFailed?.revision ?? 0,
      turnId: TURN,
      prompt: "current recoverable prompt",
      now: NOW,
    });
    const failed = store.enterAttention({
      paneId: PANE,
      turnId: TURN,
      attention: { code: "turn_failed", message: "Current failure.", retryable: true },
      clearBinding: true,
      now: NOW,
    });
    if (failed === null) throw new Error("fixture failure did not settle");

    const retry = (overrides: Partial<Parameters<ChatPaneStore["retryTurn"]>[0]> = {}) =>
      store.retryTurn({
        paneId: PANE,
        expectedRevision: failed.revision,
        priorFailedTurnId: TURN,
        turnId: "chatturn_store_fresh001",
        now: NOW,
        ...overrides,
      });
    expect(() => retry({ expectedRevision: failed.revision - 1 })).toThrow(
      expect.objectContaining({ code: "revision_conflict" }),
    );
    expect(() => retry({ priorFailedTurnId: usedTurnId })).toThrow(
      expect.objectContaining({ code: "conflict" }),
    );
    expect(() => retry({ turnId: TURN })).toThrow(
      expect.objectContaining({ code: "conflict" }),
    );
    expect(() => retry({ turnId: usedTurnId })).toThrow(
      expect.objectContaining({ code: "conflict" }),
    );
    expect(store.require(PANE).activePrompt).toBe("current recoverable prompt");

    database.query("UPDATE chat_panes SET active_prompt = NULL WHERE pane_id = ?1").run(PANE);
    expect(() => retry()).toThrow(expect.objectContaining({ code: "invalid_state" }));
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_turn_receipts
      WHERE pane_id = ?1 AND turn_id = 'chatturn_store_fresh001'
    `).get(PANE)).toEqual({ count: 0 });
  });
});

test("arbitrary failure, retry, replacement, restart, completion, and removal lifecycles preserve prompt laws", () => {
  const character = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789 ", "é", "界", "🙂");
  const prompt = fc.array(character, { minLength: 1, maxLength: 48 })
    .map((characters) => characters.join(""));
  assertProperty(fc.property(
    fc.array(fc.record({
      prompt,
      replacement: prompt,
      failure: fc.constantFrom(
        "attention" as const,
        "poison" as const,
        "restart" as const,
        "reset" as const,
      ),
      admission: fc.constantFrom("retry" as const, "replace" as const),
      reopenAfterFailure: fc.boolean(),
    }), { minLength: 1, maxLength: 8 }),
    fc.boolean(),
    (steps, removeAtEnd) => withStore((initialStore, database) => {
      let store = initialStore;
      let pane = createPane(store);
      let expectedHistory: Array<Readonly<{ role: "user" | "assistant"; text: string }>> = [];

      for (const [index, step] of steps.entries()) {
        const suffix = String(index).padStart(4, "0");
        const failedTurnId = `chatturn_lifecycle_f${suffix}`;
        pane = store.beginTurn({
          paneId: PANE,
          expectedRevision: pane.revision,
          turnId: failedTurnId,
          prompt: step.prompt,
          now: new Date(NOW.getTime() + index * 10),
        }).pane;
        const failed = step.failure === "attention"
          ? store.enterAttention({
              paneId: PANE,
              turnId: failedTurnId,
              attention: { code: "turn_failed", message: "Property failure.", retryable: true },
              clearBinding: true,
              now: new Date(NOW.getTime() + index * 10 + 1),
            })
          : step.failure === "poison"
          ? store.poisonTurn(PANE, failedTurnId, new Date(NOW.getTime() + index * 10 + 1))
          : step.failure === "reset"
          ? store.resetContextWithAttention({
              paneId: PANE,
              turnId: failedTurnId,
              attention: {
                code: "continuation_failed",
                message: "Property context reset.",
                retryable: true,
              },
              now: new Date(NOW.getTime() + index * 10 + 1),
            })
          : store.recoverInterrupted(new Date(NOW.getTime() + index * 10 + 1))[0] ?? null;
        if (failed === null) throw new Error("property failure did not settle");
        expect(store.require(PANE).activePrompt).toBe(step.prompt);
        expect(failed.recoverablePrompt).toBeTrue();
        expect(Object.hasOwn(failed, "activePrompt")).toBeFalse();
        expect(store.list().every((projection) => !Object.hasOwn(projection, "activePrompt")))
          .toBeTrue();
        if (step.reopenAfterFailure) store = new ChatPaneStore(database);
        expect(store.require(PANE).activePrompt).toBe(step.prompt);

        const nextTurnId = step.admission === "retry"
          ? `chatturn_lifecycle_r${suffix}`
          : `chatturn_lifecycle_n${suffix}`;
        pane = step.admission === "retry"
          ? store.retryTurn({
              paneId: PANE,
              expectedRevision: failed.revision,
              priorFailedTurnId: failedTurnId,
              turnId: nextTurnId,
              now: new Date(NOW.getTime() + index * 10 + 2),
            }).pane
          : store.beginTurn({
              paneId: PANE,
              expectedRevision: failed.revision,
              turnId: nextTurnId,
              prompt: step.replacement,
              now: new Date(NOW.getTime() + index * 10 + 2),
            }).pane;
        const admittedPrompt = step.admission === "retry" ? step.prompt : step.replacement;
        expect(store.require(PANE).activePrompt).toBe(admittedPrompt);
        expect(pane.recoverablePrompt).toBeFalse();
        expect(Object.hasOwn(pane, "activePrompt")).toBeFalse();

        if (step.failure !== "attention") expectedHistory = [];
        const response = `response-${suffix}`;
        const completed = completeTurnWithResponse(
          store,
          nextTurnId,
          response,
          `lifecycle_${suffix}`,
        );
        if (completed === null) throw new Error("property completion did not settle");
        pane = completed;
        expectedHistory.push(
          { role: "user", text: admittedPrompt },
          { role: "assistant", text: response },
        );
        expect(store.require(PANE).activePrompt).toBeNull();
        expect(store.handoffHistory(PANE, false)).toEqual({
          complete: true,
          items: expectedHistory,
        });
        expect(store.completeTurn(PANE, nextTurnId, NOW)).toBeNull();
        const receipt = database.query(`
          SELECT COUNT(*) AS count FROM chat_turn_receipts WHERE pane_id = ?1
        `).get(PANE) as { count: number };
        expect(receipt.count).toBeLessThanOrEqual(CHAT_MAX_TURN_RECEIPTS_PER_PANE);
      }

      if (removeAtEnd) {
        store.remove(PANE, pane.revision, NOW);
        expect(store.get(PANE)).toBeNull();
        expect(database.query(
          "SELECT active_prompt FROM chat_panes WHERE pane_id = ?1",
        ).get(PANE)).toEqual({ active_prompt: null });
      }
    }),
  ), { numRuns: 75 });
});

test("restart recovery preserves only attached turns for trusted actor replay", () => {
  withStore((store, database) => {
    const pane = database.transaction(() => store.createAttachedHarnessSession({
      actorId: "hactor_storerestartobserver",
      repository: {
        id: REPOSITORY,
        name: "Example",
        workingDirectory: "/fixture/example",
      },
      binding: {
        accountProfileId: ACCOUNT,
        threadId: "thread_store_restart_observer",
        restartThreadId: "raw_thread_store_restart_observer",
      },
      title: "Restart observer",
      now: NOW,
    }))().pane;
    const begun = store.beginAttachedHarnessTurn({
      paneId: pane.id,
      expectedRevision: pane.revision,
      turnId: TURN,
      prompt: "preserved actor prompt",
      now: NOW,
    }).pane;

    expect(store.recoverInterrupted(new Date(NOW.getTime() + 1), {
      preserveAttachedHarness: true,
    })).toEqual([]);
    expect(store.require(pane.id)).toMatchObject({
      projection: begun,
      activePrompt: "preserved actor prompt",
      providerTurnId: null,
    });
    expect(store.completeAttachedHarnessTurn({
      paneId: pane.id,
      turnId: TURN,
      markdown: "exact recovered answer",
      now: new Date(NOW.getTime() + 2),
    })).toMatchObject({
      state: "ready",
      turn: {
        status: "completed",
        responseMarkdown: { tail: "exact recovered answer" },
      },
    });
  });
});

test("migration identifier checks match the contract and reject invalid suffix characters", () => {
  withStore((store, database) => {
    expect(() => store.create({
      paneId: "pane_1234567",
      repository: { id: REPOSITORY, name: "Shortest", workingDirectory: "/fixture" },
      accountProfileId: ACCOUNT,
      reasoningEffort: "max",
      now: NOW,
    })).not.toThrow();
    expect(() => database.query(`
      INSERT INTO chat_panes (
        pane_id, repository_id, repository_name, revision, title,
        account_profile_id, model, reasoning_effort, state, created_at, updated_at
      ) VALUES ('pane_valid?bad', ?1, 'Invalid', 1, 'Invalid', ?2,
        'gpt-5.6-sol', 'ultra', 'ready', ?3, ?3)
    `).run(REPOSITORY, ACCOUNT, NOW.toISOString())).toThrow();
  });
});

function createPane(store: ChatPaneStore, paneId = PANE): ChatPaneProjection {
  return store.create({
    paneId,
    repository: {
      id: REPOSITORY,
      name: "Example",
      workingDirectory: "/fixture/example",
    },
    accountProfileId: ACCOUNT,
    reasoningEffort: "ultra",
    now: NOW,
  });
}

function completeTurnWithResponse(
  store: ChatPaneStore,
  turnId: string,
  response: string,
  providerSuffix: string,
): ChatPaneProjection | null {
  const assistantMessageId = `item_store_${providerSuffix}`;
  store.reserveAccount(PANE, turnId, ACCOUNT, NOW);
  store.prepareProviderThread(PANE, turnId, {
    accountProfileId: ACCOUNT,
    threadId: `thread_store_${providerSuffix}`,
    restartThreadId: `raw_thread_store_${providerSuffix}`,
  }, NOW);
  store.markTurnAccepted(PANE, turnId, `turn_store_${providerSuffix}`, NOW);
  store.appendDelta({
    paneId: PANE,
    turnId,
    channel: "responseMarkdown",
    delta: response,
    assistantMessageId,
    now: NOW,
  });
  expect(store.reconcileAssistantCompletion({
    paneId: PANE,
    turnId,
    assistantMessageId,
    fullText: response,
    truncated: false,
    now: NOW,
  })).toEqual({ kind: "verified" });
  return store.completeTurn(PANE, turnId, NOW);
}

function withStore(run: (store: ChatPaneStore, database: Database) => void): void {
  const database = Database.deserialize(pristineDatabase.slice(), { strict: true });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    run(new ChatPaneStore(database), database);
  } finally {
    database.close();
  }
}

function createPristineDatabase(): Uint8Array {
  const database = new Database(":memory:", { strict: true });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
    database.query(`
      INSERT INTO account_profiles (
        profile_id, label, auth_state, process_generation,
        selected, created_at, updated_at
      ) VALUES (?1, 'Store account', 'signed_in', 1, 1, ?2, ?2)
    `).run(ACCOUNT, NOW.toISOString());
    return database.serialize();
  } finally {
    database.close();
  }
}

const pristineDatabase = createPristineDatabase();
