import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { assertProperty, fc } from "@hra-internal/test";

import type { ChatPaneProjection } from "../../contracts/runtime";

import {
  CHAT_MAX_DELTA_UTF8_BYTES,
  CHAT_MAX_HANDOFF_HISTORY_ITEMS,
  CHAT_MAX_RESPONSE_TAIL_UTF8_BYTES,
} from "../src/chat";
import {
  CHAT_MAX_TURN_RECEIPTS_PER_PANE,
  chatProviderAttachmentAuthority,
  type ChatThreadBinding,
} from "../src/chat/types";
import type { ChatAttachmentVault } from "../src/attachments/contracts";
import { RootTurnRoutingSQLiteAuthorityV1 } from
  "../src/harness/root-turn-routing-sqlite-v1";
import { applyMigrations } from "../src/state/database";
import {
  ChatPaneStore,
  harnessObserverPaneId,
} from "../src/state/chat-pane-store";
import {
  ProviderThreadArchiveJournalV57,
  providerThreadArchiveAccountTombstonePreimageDigestV57,
  providerThreadArchiveCompleteInventoryDigestV57,
} from "../src/state/provider-thread-archive-journal-v57";

const ACCOUNT = "acct_storeprimary1";
const PANE = "pane_storeprimary1";
const REPOSITORY = `repo_${"1".repeat(26)}`;
const REPOSITORY_TWO = `repo_${"2".repeat(26)}`;
const TURN = "chatturn_store001";
const ASSISTANT_ITEM = "item_storeassistant01";
const NOW = new Date("2026-08-03T12:00:00.000Z");
const V57_RECEIPT_KEY = Uint8Array.from({ length: 32 }, (_, index) =>
  index + 1
);
const V57_CATALOG_DIGEST = "c".repeat(64);

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

    expect(() => store.recoverWorkspace(
      created.pane.id,
      created.pane.revision,
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
      now: new Date(NOW.getTime() + index),
    }));
    const initialOrder = panes.map(({ id }) => id);
    expect(store.list().map(({ id }) => id)).toEqual(initialOrder);
    expect(() => store.create({
      paneId: "pane_slotoverflow",
      repository: { id: REPOSITORY, name: "Example", workingDirectory: "/fixture/example" },
      accountProfileId: ACCOUNT,
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
    .map((characters) => characters.join(""))
    .filter((value) => value.trim().length > 0);
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

test("provider history reset preserves display rows behind a monotonic handoff floor", () => {
  withStore((store, database) => {
    const created = createPane(store);
    const firstTurnId = "chatturn_floorreset01";
    const first = store.beginTurn({
      paneId: PANE,
      expectedRevision: created.revision,
      turnId: firstTurnId,
      prompt: "displayed before reset",
      now: NOW,
    }).pane;
    const completed = completeTurnWithResponse(
      store,
      firstTurnId,
      "displayed response before reset",
      "floorone",
    );
    if (completed === null) throw new Error("Expected the first floor fixture turn to complete");
    const resetTurnId = "chatturn_floorreset02";
    store.beginTurn({
      paneId: PANE,
      expectedRevision: completed.revision,
      turnId: resetTurnId,
      prompt: "must not cross the provider floor",
      now: NOW,
    });
    const reset = store.resetContextWithAttention({
      paneId: PANE,
      turnId: resetTurnId,
      attention: {
        code: "continuation_failed",
        message: "Start with a fresh provider context.",
        retryable: false,
      },
      now: NOW,
    });
    if (reset === null) throw new Error("Expected provider context reset");

    expect(database.query(`
      SELECT sequence, role, text FROM chat_pane_history
      WHERE pane_id = ?1 ORDER BY sequence
    `).all(PANE)).toEqual([
      { sequence: 1, role: "user", text: "displayed before reset" },
      { sequence: 2, role: "assistant", text: "displayed response before reset" },
    ]);
    expect(database.query(`
      SELECT provider_history_floor_sequence AS floor
      FROM chat_panes WHERE pane_id = ?1
    `).get(PANE)).toEqual({ floor: 2 });
    expect(() => database.query(`
      UPDATE chat_panes SET provider_history_floor_sequence = 1
      WHERE pane_id = ?1
    `).run(PANE)).toThrow("provider history handoff floor cannot move backwards");
    expect(store.handoffHistory(PANE, false)).toEqual({ complete: true, items: [] });

    const freshTurnId = "chatturn_floorreset03";
    store.beginTurn({
      paneId: PANE,
      expectedRevision: reset.revision,
      turnId: freshTurnId,
      prompt: "fresh provider prompt",
      now: NOW,
    });
    const fresh = completeTurnWithResponse(
      store,
      freshTurnId,
      "fresh provider response",
      "floortwo",
    );
    if (fresh === null) throw new Error("Expected the fresh floor fixture turn to complete");
    expect(store.handoffHistory(PANE, false)).toEqual({
      complete: true,
      items: [
        { role: "user", text: "fresh provider prompt" },
        { role: "assistant", text: "fresh provider response" },
      ],
    });
    expect(database.query(`
      SELECT sequence FROM chat_pane_history
      WHERE pane_id = ?1 ORDER BY sequence
    `).all(PANE)).toEqual([
      { sequence: 1 },
      { sequence: 2 },
      { sequence: 3 },
      { sequence: 4 },
    ]);
    expect(first.state).toBe("starting");
  });
});

test("restore-required provider context rejects Retry and clears only on a fresh message", () => {
  withStore((store, database) => {
    const created = createPane(store);
    const priorTurnId = "chatturn_restorefloor01";
    store.beginTurn({
      paneId: PANE,
      expectedRevision: created.revision,
      turnId: priorTurnId,
      prompt: "visible prior prompt",
      now: NOW,
    });
    const completed = completeTurnWithResponse(
      store,
      priorTurnId,
      "visible prior response",
      "restoreone",
    );
    if (completed === null) throw new Error("Expected restore floor fixture completion");
    const interruptedTurnId = "chatturn_restorefloor02";
    store.beginTurn({
      paneId: PANE,
      expectedRevision: completed.revision,
      turnId: interruptedTurnId,
      prompt: "private restored prompt",
      now: NOW,
    });
    database.query(`
      UPDATE chat_panes
      SET active_turn_poisoned = 1,
          provider_context_reset_required = 1,
          message_queue_pause_reason = 'attention',
          message_queue_revision = message_queue_revision + 1
      WHERE pane_id = ?1
    `).run(PANE);
    expect(store.require(PANE)).toMatchObject({
      activeTurnPoisoned: true,
      providerContextResetRequired: true,
    });
    expect(store.handoffHistory(PANE, true)).toEqual({ complete: false, items: [] });

    const recovered = store.recoverInterrupted(new Date(NOW.getTime() + 1))[0];
    if (recovered === undefined) throw new Error("Expected flagged restore recovery");
    expect(recovered).toMatchObject({
      state: "attention",
      recoverablePrompt: false,
      attention: {
        code: "runtime_unavailable",
        retryable: false,
        message:
          "Attachment context from the prior Codex session is quarantined. Choose Start fresh to continue without transferring it.",
      },
      canStartFreshContext: true,
    });
    expect(store.require(PANE)).toMatchObject({
      activePrompt: "private restored prompt",
      providerContextResetRequired: true,
    });
    expect(() => store.retryTurn({
      paneId: PANE,
      expectedRevision: recovered.revision,
      priorFailedTurnId: interruptedTurnId,
      turnId: "chatturn_restorefloor03",
      now: new Date(NOW.getTime() + 2),
    })).toThrow("Provider context reset requires a fresh message, not Retry");
    expect(database.query(`
      SELECT sequence, text FROM chat_pane_history
      WHERE pane_id = ?1 ORDER BY sequence
    `).all(PANE)).toEqual([
      { sequence: 1, text: "visible prior prompt" },
      { sequence: 2, text: "visible prior response" },
    ]);

    const reset = store.startFreshProviderContext({
      paneId: PANE,
      expectedRevision: recovered.revision,
      expectedQueueRevision: recovered.messageQueue.revision,
      now: new Date(NOW.getTime() + 3),
    });
    const fresh = store.beginTurn({
      paneId: PANE,
      expectedRevision: reset.pane.revision,
      turnId: "chatturn_restorefloor04",
      prompt: "fresh explicit message",
      now: new Date(NOW.getTime() + 4),
    }).pane;
    expect(store.require(PANE).providerContextResetRequired).toBeFalse();
    expect(store.handoffHistory(PANE, true)).toEqual({
      complete: true,
      items: [{ role: "user", text: "fresh explicit message" }],
    });
    expect(database.query(`
      SELECT provider_history_floor_sequence AS floor,
        provider_context_reset_required AS reset_required
      FROM chat_panes WHERE pane_id = ?1
    `).get(PANE)).toEqual({ floor: 2, reset_required: 0 });
    expect(fresh.state).toBe("starting");
  });
});

test("provider archive success binds direct and reconciled response generations exactly", () => {
  withStore((store, database) => {
    const directPane = createPane(store);
    database.query(`
      INSERT INTO chat_provider_thread_archive_intents (
        pane_id, purpose, state, pane_revision, queue_revision,
        account_profile_id, thread_id, restart_thread_id,
        generation, generation_contained, effect_attempt, created_at, updated_at
      ) VALUES (
        ?1, 'pane_archive', 'effect_started', ?2, NULL,
        ?3, 'thread_store_archive_direct', 'raw_thread_store_archive_direct',
        7, 0, 1, ?4, ?4
      )
    `).run(PANE, directPane.revision, ACCOUNT, NOW.toISOString());

    expect(() => store.recordProviderThreadArchiveSucceeded({
      paneId: PANE,
      containmentReceipt: "direct_archive_receipt",
      expectedIntentGeneration: 7,
      responseGeneration: 8,
      streamPosition: 1,
      source: "direct",
      now: NOW,
    })).toThrow("response generation");
    expect(store.providerThreadArchiveIntent(PANE)).toMatchObject({
      state: "effect_started",
      generation: 7,
      containment_receipt: null,
    });
    const direct = store.recordProviderThreadArchiveSucceeded({
      paneId: PANE,
      containmentReceipt: "direct_archive_receipt",
      expectedIntentGeneration: 7,
      responseGeneration: 7,
      streamPosition: 1,
      source: "direct",
      now: NOW,
    });
    expect(direct).toMatchObject({
      state: "succeeded",
      generation: 7,
      response_generation: 7,
      reconciliation_disposition: null,
    });
    expect(store.recordProviderThreadArchiveSucceeded({
      paneId: PANE,
      containmentReceipt: "direct_archive_receipt",
      expectedIntentGeneration: 7,
      responseGeneration: 7,
      streamPosition: 1,
      source: "direct",
      now: NOW,
    })).toEqual(direct);

    const reconciledPaneId = "pane_storearchive02";
    const reconciledPane = createPane(store, reconciledPaneId);
    database.query(`
      INSERT INTO chat_provider_thread_archive_intents (
        pane_id, purpose, state, pane_revision, queue_revision,
        account_profile_id, thread_id, restart_thread_id,
        generation, generation_contained, generation_containment_receipt,
        effect_attempt, ambiguity_receipt, created_at, updated_at
      ) VALUES (
        ?1, 'pane_archive', 'ambiguous', ?2, NULL,
        ?3, 'thread_store_archive_reconcile', 'raw_thread_store_archive_reconcile',
        7, 1, 'generation_contained_receipt',
        1, 'archive_ambiguity_receipt', ?4, ?4
      )
    `).run(reconciledPaneId, reconciledPane.revision, ACCOUNT, NOW.toISOString());

    expect(() => store.recordProviderThreadArchiveSucceeded({
      paneId: reconciledPaneId,
      containmentReceipt: "reconciled_archive_receipt",
      expectedIntentGeneration: 7,
      responseGeneration: 7,
      streamPosition: 2,
      source: "reconciled",
      reconciliationReceipt: "stable_double_scan_receipt",
      now: NOW,
    })).toThrow("response generation");
    const reconciled = store.recordProviderThreadArchiveSucceeded({
      paneId: reconciledPaneId,
      containmentReceipt: "reconciled_archive_receipt",
      expectedIntentGeneration: 7,
      responseGeneration: 8,
      streamPosition: 2,
      source: "reconciled",
      reconciliationReceipt: "stable_double_scan_receipt",
      now: NOW,
    });
    expect(reconciled).toMatchObject({
      state: "succeeded",
      generation: 7,
      response_generation: 8,
      generation_contained: 1,
      reconciliation_disposition: "applied",
      reconciliation_receipt: "stable_double_scan_receipt",
    });
  });
});

test("provider archive retries require monotonic generations and contained not-applied evidence", () => {
  withStore((store, database) => {
    const pane = createPane(store);
    database.query(`
      INSERT INTO chat_provider_thread_archive_intents (
        pane_id, purpose, state, pane_revision, queue_revision,
        account_profile_id, thread_id, restart_thread_id,
        generation, generation_contained, effect_attempt, created_at, updated_at
      ) VALUES (
        ?1, 'pane_archive', 'prepared', ?2, NULL,
        ?3, 'thread_store_archive_retry', 'raw_thread_store_archive_retry',
        3, 0, 0, ?4, ?4
      )
    `).run(PANE, pane.revision, ACCOUNT, NOW.toISOString());

    const rebased = store.rebasePreparedProviderThreadArchive({
      paneId: PANE,
      generation: 4,
      evidenceReceipt: "prepared_restart_generation_receipt",
      now: NOW,
    });
    expect(rebased).toMatchObject({
      state: "prepared",
      generation: 4,
      effect_attempt: 0,
      reconciliation_disposition: "not_applied",
      reconciliation_receipt: "prepared_restart_generation_receipt",
    });
    expect(() => store.rebasePreparedProviderThreadArchive({
      paneId: PANE,
      generation: 3,
      evidenceReceipt: "stale_prepared_generation_receipt",
      now: NOW,
    })).toThrow("newer generation");

    store.markProviderThreadArchiveEffectStarted({
      paneId: PANE,
      expectedGeneration: 4,
      now: NOW,
    });
    store.markProviderThreadArchiveAmbiguous({
      paneId: PANE,
      expectedGeneration: 4,
      ambiguityReceipt: "archive_effect_ambiguity_receipt",
      now: NOW,
    });
    expect(() => store.resetProviderThreadArchiveAfterNotApplied({
      paneId: PANE,
      generation: 5,
      reconciliationReceipt: "uncontained_not_applied_receipt",
      now: NOW,
    })).toThrow("exact containment");
    store.markProviderThreadArchiveGenerationContained({
      paneId: PANE,
      expectedGeneration: 4,
      containmentReceipt: "old_generation_containment_receipt",
      now: NOW,
    });
    expect(() => store.resetProviderThreadArchiveAfterNotApplied({
      paneId: PANE,
      generation: 4,
      reconciliationReceipt: "same_generation_not_applied_receipt",
      now: NOW,
    })).toThrow("newer generation");
    expect(store.resetProviderThreadArchiveAfterNotApplied({
      paneId: PANE,
      generation: 5,
      reconciliationReceipt: "stable_not_applied_scan_receipt",
      now: NOW,
    })).toMatchObject({
      state: "prepared",
      generation: 5,
      generation_contained: 0,
      effect_attempt: 1,
      reconciliation_disposition: "not_applied",
      reconciliation_receipt: "stable_not_applied_scan_receipt",
    });
  });
});

test("a null-binding fresh reset consumes only account-contained archive recovery", () => {
  withStore((store, database) => {
    createPane(store);
    database.query(`
      UPDATE chat_panes SET
        state = 'attention',
        attention_code = 'runtime_unavailable',
        attention_message = 'Choose Start fresh to exclude prior provider context.',
        attention_retryable = 0,
        provider_context_reset_required = 1,
        message_queue_pause_reason = 'attention',
        message_queue_revision = message_queue_revision + 1,
        revision = revision + 1
      WHERE pane_id = ?1
    `).run(PANE);
    const quarantined = store.require(PANE);
    database.query(`
      INSERT INTO chat_provider_thread_archive_intents (
        pane_id, purpose, state, pane_revision, queue_revision,
        account_profile_id, thread_id, restart_thread_id,
        generation, generation_contained, effect_attempt, created_at, updated_at
      ) VALUES (
        ?1, 'pane_archive', 'prepared', ?2, NULL,
        ?3, 'thread_store_archive_orphan', 'raw_thread_store_archive_orphan',
        3, 0, 0, ?4, ?4
      )
    `).run(PANE, quarantined.projection.revision, ACCOUNT, NOW.toISOString());

    const blocked = store.require(PANE).projection;
    expect(blocked.canStartFreshContext).toBeFalse();
    expect(() => store.startFreshProviderContext({
      paneId: PANE,
      expectedRevision: blocked.revision,
      expectedQueueRevision: blocked.messageQueue.revision,
      now: NOW,
    })).toThrow("only its exact recovery");
    expect(store.providerThreadArchiveIntent(PANE)).toMatchObject({
      state: "prepared",
    });

    database.query(`
      UPDATE chat_provider_thread_archive_intents SET
        state = 'account_contained',
        generation_contained = 1,
        generation_containment_receipt = 'account_generation_containment_receipt',
        updated_at = ?2
      WHERE pane_id = ?1
    `).run(PANE, NOW.toISOString());
    const contained = store.require(PANE).projection;
    expect(contained.canStartFreshContext).toBeTrue();
    const fresh = store.startFreshProviderContext({
      paneId: PANE,
      expectedRevision: contained.revision,
      expectedQueueRevision: contained.messageQueue.revision,
      now: NOW,
    });
    expect(fresh.pane).toMatchObject({
      state: "ready",
      canStartFreshContext: false,
    });
    expect(store.providerThreadArchiveIntent(PANE)).toBeNull();
  });
});

test("pane close consumes exact account-contained archive authority across reopen", () => {
  withStore((initialStore, database) => {
    for (const [index, purpose] of ([
      "start_fresh",
      "pane_archive",
    ] as const).entries()) {
      const suffix = String(index + 1).padStart(2, "0");
      const paneId = `pane_accountclose${suffix}`;
      const binding = {
        accountProfileId: ACCOUNT,
        threadId: `thread_account_close_${suffix}`,
        restartThreadId: `raw_thread_account_close_${suffix}`,
      };
      createPane(initialStore, paneId);
      database.query(`
        UPDATE chat_panes SET
          provider_account_profile_id = ?1,
          provider_thread_id = ?2,
          provider_restart_thread_id = ?3
        WHERE pane_id = ?4
      `).run(
        binding.accountProfileId,
        binding.threadId,
        binding.restartThreadId,
        paneId,
      );
      if (purpose === "start_fresh") {
        database.query(`
          UPDATE chat_panes SET
            state = 'attention',
            attention_code = 'runtime_unavailable',
            attention_message = 'Choose Start fresh to exclude prior provider context.',
            attention_retryable = 0,
            provider_context_reset_required = 1,
            message_queue_pause_reason = 'attention',
            message_queue_revision = message_queue_revision + 1,
            revision = revision + 1
          WHERE pane_id = ?1
        `).run(paneId);
      }
      const preparedPane = initialStore.require(paneId);
      initialStore.prepareProviderThreadArchiveIntent({
        paneId,
        purpose,
        expectedRevision: preparedPane.projection.revision,
        expectedQueueRevision: purpose === "start_fresh"
          ? preparedPane.projection.messageQueue.revision
          : null,
        binding,
        generation: 1,
        now: NOW,
      });
      const containmentReceipt = `account_close_containment_receipt_${suffix}`;
      const quarantined = initialStore.detachUnavailableAccount(
        paneId,
        ACCOUNT,
        NOW,
        "quarantineAttachments",
        null,
        containmentReceipt,
      );
      if (quarantined === null) throw new Error("Expected account quarantine");
      expect(initialStore.require(paneId)).toMatchObject({
        binding: null,
        providerContextResetRequired: true,
      });
      expect(initialStore.providerThreadArchiveIntent(paneId)).toMatchObject({
        purpose,
        state: "account_contained",
        generation_contained: 1,
        generation_containment_receipt: containmentReceipt,
      });

      const reopened = new ChatPaneStore(database);
      expect(() => reopened.remove(
        paneId,
        quarantined.revision,
        NOW,
        `wrong_account_containment_receipt_${suffix}`,
      )).toThrow("no longer authorizes this pane archive");
      expect(reopened.providerThreadArchiveIntent(paneId)).not.toBeNull();
      if (index === 0) {
        const beforeArchive = database.query(`
          SELECT revision, archived_at FROM chat_panes WHERE pane_id = ?1
        `).get(paneId);
        database.exec(`
          CREATE TRIGGER fixture_account_containment_delete_crash
          BEFORE DELETE ON chat_provider_thread_archive_intents
          WHEN OLD.pane_id = 'pane_accountclose01'
          BEGIN
            SELECT RAISE(ABORT, 'fixture account containment delete crash');
          END;
        `);
        expect(() => reopened.remove(
          paneId,
          quarantined.revision,
          NOW,
          containmentReceipt,
        )).toThrow("fixture account containment delete crash");
        expect(database.query(`
          SELECT revision, archived_at FROM chat_panes WHERE pane_id = ?1
        `).get(paneId)).toEqual(beforeArchive);
        expect(reopened.providerThreadArchiveIntent(paneId)).toMatchObject({
          state: "account_contained",
          generation_containment_receipt: containmentReceipt,
        });
        database.exec("DROP TRIGGER fixture_account_containment_delete_crash");
      }
      expect(reopened.remove(
        paneId,
        quarantined.revision,
        NOW,
        containmentReceipt,
      )).toEqual({ paneId, revision: quarantined.revision + 1 });
      expect(reopened.get(paneId)).toBeNull();
      expect(reopened.providerThreadArchiveIntent(paneId)).toBeNull();
      expect(database.query(`
        SELECT archived_at IS NOT NULL AS archived,
          provider_account_profile_id, provider_thread_id,
          provider_restart_thread_id
        FROM chat_panes WHERE pane_id = ?1
      `).get(paneId)).toEqual({
        archived: 1,
        provider_account_profile_id: null,
        provider_thread_id: null,
        provider_restart_thread_id: null,
      });
    }
  });
});

test("pending provider-context intents fence admission and mutation across reopen", () => {
  withStore((initialStore, database) => {
    const purposes = ["start_fresh", "pane_archive"] as const;
    const states = [
      "prepared",
      "effect_started",
      "ambiguous",
      "succeeded",
    ] as const;
    const fixtures = purposes.flatMap((purpose, purposeIndex) =>
      states.map((state, stateIndex) => {
      const index = purposeIndex * states.length + stateIndex;
      const suffix = String(index + 1).padStart(2, "0");
      const paneId = `pane_intentfence${suffix}`;
      const messageId = `chatmsg_intentfence${suffix}`;
      const binding = {
        accountProfileId: ACCOUNT,
        threadId: `thread_intent_fence_${suffix}`,
        restartThreadId: `raw_thread_intent_fence_${suffix}`,
      };
      createPane(initialStore, paneId);
      initialStore.enqueueMessage({
        paneId,
        expectedQueueRevision: 1,
        messageId,
        content: { text: `queued intent fixture ${suffix}`, attachmentRefs: [] },
        now: NOW,
      });
      database.query(`
        UPDATE chat_panes SET
          provider_account_profile_id = ?1,
          provider_thread_id = ?2,
          provider_restart_thread_id = ?3
        WHERE pane_id = ?4
      `).run(
        binding.accountProfileId,
        binding.threadId,
        binding.restartThreadId,
        paneId,
      );
      if (purpose === "start_fresh") {
        database.query(`
          UPDATE chat_panes SET
            state = 'attention',
            attention_code = 'runtime_unavailable',
            attention_message = 'Choose Start fresh to exclude prior provider context.',
            attention_retryable = 0,
            provider_context_reset_required = 1,
            message_queue_pause_reason = 'attention',
            message_queue_revision = message_queue_revision + 1,
            revision = revision + 1
          WHERE pane_id = ?1
        `).run(paneId);
      }
      const current = initialStore.require(paneId).projection;
      initialStore.prepareProviderThreadArchiveIntent({
        paneId,
        purpose,
        expectedRevision: current.revision,
        expectedQueueRevision: purpose === "start_fresh"
          ? current.messageQueue.revision
          : null,
        binding,
        generation: 1,
        now: NOW,
      });
      if (state !== "prepared") {
        initialStore.markProviderThreadArchiveEffectStarted({
          paneId,
          expectedGeneration: 1,
          now: NOW,
        });
      }
      if (state === "ambiguous") {
        initialStore.markProviderThreadArchiveAmbiguous({
          paneId,
          expectedGeneration: 1,
          ambiguityReceipt: `archive_ambiguity_receipt_${suffix}`,
          now: NOW,
        });
      }
      const containmentReceipt = `archive_containment_receipt_${suffix}`;
      if (state === "succeeded") {
        initialStore.recordProviderThreadArchiveSucceeded({
          paneId,
          containmentReceipt,
          expectedIntentGeneration: 1,
          responseGeneration: 1,
          streamPosition: 1,
          source: "direct",
          now: NOW,
        });
      }
      return {
        binding,
        containmentReceipt,
        messageId,
        paneId,
        paneRevision: current.revision,
        purpose,
        queueRevision: current.messageQueue.revision,
        state,
      };
    }));

    const store = new ChatPaneStore(database);
    for (const [index, fixture] of fixtures.entries()) {
      const suffix = String(index + 1).padStart(2, "0");
      const message = store.messageQueue(fixture.paneId).messages[0];
      if (message === undefined) throw new Error("Expected queued archive fixture");
      const turnId = `chatturn_archivefence${suffix}`;
      const retryTurnId = `chatturn_archiveretry${suffix}`;
      const assertFenced = (run: () => unknown): void => {
        expect(run).toThrow("only its exact recovery");
      };

      assertFenced(() => store.beginTurn({
        paneId: fixture.paneId,
        expectedRevision: fixture.paneRevision,
        turnId,
        prompt: "must remain fenced",
        now: NOW,
      }));
      assertFenced(() => store.retryTurn({
        paneId: fixture.paneId,
        expectedRevision: fixture.paneRevision,
        priorFailedTurnId: turnId,
        turnId: retryTurnId,
        now: NOW,
      }));
      assertFenced(() => store.claimHeadMessageAndBeginTurn({
        paneId: fixture.paneId,
        expectedQueueRevision: fixture.queueRevision,
        expectedMessageRevision: message.revision,
        messageId: fixture.messageId,
        turnId,
        now: NOW,
      }));
      assertFenced(() => store.claimHeadMessage({
        paneId: fixture.paneId,
        expectedQueueRevision: fixture.queueRevision,
        expectedMessageRevision: message.revision,
        messageId: fixture.messageId,
        turnId,
        kind: "steer",
        now: NOW,
      }));
      assertFenced(() => store.enqueueMessage({
        paneId: fixture.paneId,
        expectedQueueRevision: fixture.queueRevision,
        messageId: `chatmsg_archiveblocked${suffix}`,
        content: { text: "must not enqueue", attachmentRefs: [] },
        now: NOW,
      }));
      assertFenced(() => store.editQueuedMessage({
        paneId: fixture.paneId,
        expectedQueueRevision: fixture.queueRevision,
        expectedMessageRevision: message.revision,
        messageId: fixture.messageId,
        content: { text: "must not edit", attachmentRefs: [] },
        now: NOW,
      }));
      assertFenced(() => store.removeQueuedMessage({
        paneId: fixture.paneId,
        expectedQueueRevision: fixture.queueRevision,
        expectedMessageRevision: message.revision,
        messageId: fixture.messageId,
        now: NOW,
      }));
      assertFenced(() => store.pauseMessageQueue({
        paneId: fixture.paneId,
        reason: "attention",
        now: NOW,
      }));
      assertFenced(() => store.resumeMessageQueue({
        paneId: fixture.paneId,
        expectedQueueRevision: fixture.queueRevision,
        now: NOW,
      }));
      assertFenced(() => store.reconcileMessageQueueAfterRestart(
        fixture.paneId,
        NOW,
      ));
      assertFenced(() => store.rename(
        fixture.paneId,
        fixture.paneRevision,
        "Must not rename",
        NOW,
      ));
      assertFenced(() => store.recoverWorkspace(
        fixture.paneId,
        fixture.paneRevision,
        NOW,
      ));
      assertFenced(() => store.selectRepository(
        fixture.paneId,
        fixture.paneRevision,
        { id: REPOSITORY_TWO, name: "Other", workingDirectory: "/fixture/other" },
        NOW,
      ));
      assertFenced(() => store.reserveAccount(
        fixture.paneId,
        turnId,
        ACCOUNT,
        NOW,
      ));
      assertFenced(() => store.prepareProviderThread(
        fixture.paneId,
        turnId,
        fixture.binding,
        NOW,
      ));
      assertFenced(() => store.markTurnAccepted(
        fixture.paneId,
        turnId,
        `provider_turn_archive_${suffix}`,
        NOW,
      ));
      assertFenced(() => store.beginContinuation(
        fixture.paneId,
        turnId,
        ACCOUNT,
        NOW,
      ));
      assertFenced(() => store.handoffHistory(fixture.paneId, true));

      expect(store.messageQueue(fixture.paneId)).toEqual({
        ...store.messageQueue(fixture.paneId),
        revision: fixture.queueRevision,
        messages: [message],
      });
      expect(store.require(fixture.paneId).projection.revision)
        .toBe(fixture.paneRevision);
      expect(store.providerThreadArchiveIntent(fixture.paneId)?.state)
        .toBe(fixture.state);
      if (fixture.purpose === "pane_archive") {
        expect(store.preflightPaneArchive({
          paneId: fixture.paneId,
          expectedRevision: fixture.paneRevision,
        }).projection.revision).toBe(fixture.paneRevision);
      } else {
        expect(store.preflightStartFreshProviderContext({
          paneId: fixture.paneId,
          expectedRevision: fixture.paneRevision,
          expectedQueueRevision: fixture.queueRevision,
        }).projection.revision).toBe(fixture.paneRevision);
      }
      expect(store.prepareProviderThreadArchiveIntent({
        paneId: fixture.paneId,
        purpose: fixture.purpose,
        expectedRevision: fixture.paneRevision,
        expectedQueueRevision: fixture.purpose === "start_fresh"
          ? fixture.queueRevision
          : null,
        binding: fixture.binding,
        generation: 1,
        now: NOW,
      }).state).toBe(fixture.state);
      expect(store.require(fixture.paneId).projection.canStartFreshContext)
        .toBe(fixture.purpose === "start_fresh");
      if (fixture.purpose !== "pane_archive" || fixture.state !== "succeeded") {
        expect(() => store.remove(
          fixture.paneId,
          fixture.paneRevision,
          NOW,
          fixture.containmentReceipt,
        )).toThrow("containment receipt no longer authorizes");
      }
      expect(database.query(`
        SELECT COUNT(*) AS count FROM chat_turn_receipts WHERE pane_id = ?1
      `).get(fixture.paneId)).toEqual({ count: 0 });
    }

    expect(() => store.reorder(
      fixtures.map(({ paneId }) => paneId),
      [...fixtures].reverse().map(({ paneId }) => paneId),
    )).toThrow("only its exact recovery");

    const succeeded = fixtures.find(({ purpose, state }) =>
      purpose === "pane_archive" && state === "succeeded"
    );
    if (succeeded === undefined) throw new Error("Expected succeeded archive fixture");
    expect(() => store.remove(
      succeeded.paneId,
      succeeded.paneRevision,
      NOW,
      "wrong_archive_containment_receipt",
    )).toThrow("no longer authorizes this pane archive");
    expect(store.remove(
      succeeded.paneId,
      succeeded.paneRevision,
      NOW,
      succeeded.containmentReceipt,
    )).toEqual({
      paneId: succeeded.paneId,
      revision: succeeded.paneRevision + 1,
    });
    expect(store.get(succeeded.paneId)).toBeNull();
    expect(store.providerThreadArchiveIntent(succeeded.paneId)).toBeNull();
    expect(database.query(`
      SELECT state FROM chat_message_ledger WHERE message_id = ?1
    `).get(succeeded.messageId)).toEqual({ state: "cancelled" });
  });
});

test("pane archive preflight rejects every unresolved queue effect before intent", () => {
  withStore((store, database) => {
    const blockerStates = [
      "start_effect_started",
      "steer_effect_started",
      "start_acknowledged",
      "steer_acknowledged",
      "ambiguous",
    ] as const;

    for (const [index, blockerState] of blockerStates.entries()) {
      const suffix = String(index + 1).padStart(2, "0");
      const paneId = `pane_closeblock${suffix}`;
      const messageId = `chatmsg_closeblock${suffix}`;
      const turnId = `chatturn_closeblock${suffix}`;
      const binding = {
        accountProfileId: ACCOUNT,
        threadId: `thread_close_block_${suffix}`,
        restartThreadId: `raw_thread_close_block_${suffix}`,
      };
      const created = createPane(store, paneId);
      let claimRevision: number;
      let effectKind: "start" | "steer";
      if (blockerState.startsWith("steer_")) {
        store.beginTurn({
          paneId,
          expectedRevision: created.revision,
          turnId,
          prompt: "Keep this turn active for a steer cut.",
          now: NOW,
        });
        const queued = store.enqueueMessage({
          paneId,
          expectedQueueRevision: 1,
          messageId,
          content: { text: "Unsettled steer effect.", attachmentRefs: [] },
          now: NOW,
        });
        const message = queued.messages[0];
        if (message === undefined) throw new Error("Expected steer blocker message");
        claimRevision = store.claimHeadMessage({
          paneId,
          expectedQueueRevision: queued.revision,
          expectedMessageRevision: message.revision,
          messageId,
          turnId,
          kind: "steer",
          now: NOW,
        }).claim.revision;
        effectKind = "steer";
      } else {
        const queued = store.enqueueMessage({
          paneId,
          expectedQueueRevision: 1,
          messageId,
          content: { text: "Unsettled start effect.", attachmentRefs: [] },
          now: NOW,
        });
        const message = queued.messages[0];
        if (message === undefined) throw new Error("Expected start blocker message");
        claimRevision = store.claimHeadMessageAndBeginTurn({
          paneId,
          expectedQueueRevision: queued.revision,
          expectedMessageRevision: message.revision,
          messageId,
          turnId,
          now: NOW,
        }).claim.revision;
        effectKind = "start";
      }
      store.markMessageEffectStarted({
        paneId,
        messageId,
        expectedMessageRevision: claimRevision,
        turnId,
        kind: effectKind,
        now: NOW,
      });
      if (blockerState.endsWith("acknowledged")) {
        store.acknowledgeMessageEffect({
          paneId,
          messageId,
          expectedMessageRevision: claimRevision + 1,
          turnId,
          kind: effectKind,
          now: NOW,
        });
      } else if (blockerState === "ambiguous") {
        store.markMessageEffectAmbiguous({
          paneId,
          messageId,
          expectedMessageRevision: claimRevision + 1,
          turnId,
          kind: effectKind,
          now: NOW,
        });
      }
      const terminal = store.enterAttention({
        paneId,
        turnId,
        attention: {
          code: "turn_failed",
          message: "The exact provider effect still needs containment.",
          retryable: false,
        },
        clearBinding: false,
        now: NOW,
      });
      if (terminal === null) throw new Error("Expected blocker turn terminal");
      database.query(`
        UPDATE chat_panes SET
          provider_account_profile_id = ?1,
          provider_thread_id = ?2,
          provider_restart_thread_id = ?3
        WHERE pane_id = ?4
      `).run(
        binding.accountProfileId,
        binding.threadId,
        binding.restartThreadId,
        paneId,
      );
      const beforePane = database.query(`
        SELECT * FROM chat_panes WHERE pane_id = ?1
      `).get(paneId);
      const beforeMessage = database.query(`
        SELECT * FROM chat_message_ledger WHERE message_id = ?1
      `).get(messageId);

      expect(() => store.preflightPaneArchive({
        paneId,
        expectedRevision: terminal.revision,
      })).toThrow("Contain the in-flight or ambiguous message effect");
      expect(() => store.prepareProviderThreadArchiveIntent({
        paneId,
        purpose: "pane_archive",
        expectedRevision: terminal.revision,
        expectedQueueRevision: null,
        binding,
        generation: 1,
        now: NOW,
      })).toThrow("Contain the in-flight or ambiguous message effect");
      expect(database.query(`
        SELECT COUNT(*) AS count FROM chat_provider_thread_archive_intents
        WHERE pane_id = ?1
      `).get(paneId)).toEqual({ count: 0 });
      expect(database.query(`
        SELECT * FROM chat_panes WHERE pane_id = ?1
      `).get(paneId)).toEqual(beforePane);
      expect(database.query(`
        SELECT * FROM chat_message_ledger WHERE message_id = ?1
      `).get(messageId)).toEqual(beforeMessage);
    }
  });
});

test("ordinary start and Retry reject orphan attachment authority before routing receipts", () => {
  withStore((store, database) => {
    const created = createPane(store);
    store.beginTurn({
      paneId: PANE,
      expectedRevision: created.revision,
      turnId: TURN,
      prompt: "Establish a mismatched provider thread.",
      now: NOW,
    });
    const completed = completeTurnWithResponse(
      store,
      TURN,
      "Done.",
      "orphan_mismatch",
    );
    if (completed === null) throw new Error("Expected mismatch fixture completion");
    database.query(`
      INSERT INTO chat_provider_attachment_bindings (
        binding_id, binding_key_digest, pane_id, revision, state,
        acquired_at, updated_at
      ) VALUES (?1, ?2, ?3, 1, 'active', ?4, ?4)
    `).run("attbinding_orphanmismatch01", "a".repeat(64), PANE, NOW.toISOString());
    const nextTurnId = "chatturn_orphanmismatch01";
    expect(() => store.beginTurn({
      paneId: PANE,
      expectedRevision: completed.revision,
      turnId: nextTurnId,
      prompt: "Must not route.",
      now: new Date(NOW.getTime() + 1),
    })).toThrow("Attachment custody no longer matches");
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_turn_receipts
      WHERE pane_id = ?1 AND turn_id = ?2
    `).get(PANE, nextTurnId)).toEqual({ count: 0 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM harness_root_turn_routing_receipts
      WHERE pane_id = ?1 AND chat_turn_id = ?2
    `).get(PANE, nextTurnId)).toEqual({ count: 0 });
  });

  withStore((store, database) => {
    const created = createPane(store);
    store.beginTurn({
      paneId: PANE,
      expectedRevision: created.revision,
      turnId: TURN,
      prompt: "Retain this exact Retry prompt.",
      now: NOW,
    });
    const failed = store.enterAttention({
      paneId: PANE,
      turnId: TURN,
      attention: { code: "turn_failed", message: "Try again.", retryable: true },
      clearBinding: true,
      now: NOW,
    });
    if (failed === null) throw new Error("Expected retry fixture failure");
    database.query(`
      INSERT INTO chat_provider_attachment_bindings (
        binding_id, binding_key_digest, pane_id, revision, state,
        acquired_at, updated_at
      ) VALUES (?1, ?2, ?3, 1, 'active', ?4, ?4)
    `).run("attbinding_orphannull0001", "b".repeat(64), PANE, NOW.toISOString());
    const retryTurnId = "chatturn_orphannull0001";
    expect(() => store.retryTurn({
      paneId: PANE,
      expectedRevision: failed.revision,
      priorFailedTurnId: TURN,
      turnId: retryTurnId,
      now: new Date(NOW.getTime() + 1),
    })).toThrow("Attachment custody no longer matches");
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_turn_receipts
      WHERE pane_id = ?1 AND turn_id = ?2
    `).get(PANE, retryTurnId)).toEqual({ count: 0 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM harness_root_turn_routing_receipts
      WHERE pane_id = ?1 AND chat_turn_id = ?2
    `).get(PANE, retryTurnId)).toEqual({ count: 0 });
  });
});

test("v57 target preparation is atomic, replayable, and binds none or one exact retained attachment", () => {
  withV57Store(({ store, database }) => {
    const nullable = seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: PANE,
      suffix: "nullable_binding_01",
    });
    const exactPaneId = "pane_v57_exact_binding01";
    const exact = seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: exactPaneId,
      suffix: "exact_binding_01",
      ownership: "effectStarted",
    });
    const startFreshPaneId = "pane_v57_start_fresh_exact1";
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: startFreshPaneId,
      suffix: "start_fresh_exact01",
    });
    const prepared = prepareV57Target({
      store,
      paneId: PANE,
      suffix: "nullable_binding_01",
    });
    expect(prepared).toMatchObject({
      targetId: "archtarget_v57_nullable_binding_01",
      paneId: PANE,
      purpose: "pane_archive",
      status: "open",
      currentAttempt: {
        attemptId: "archattempt_v57_nullable_binding_01",
        generation: 1,
        state: "effect_started",
      },
    });
    expect(database.query(`
      SELECT binding_id, binding_key_digest, binding_revision
      FROM chat_provider_thread_archive_targets_v57 WHERE target_id = ?1
    `).get(prepared.targetId)).toEqual({
      binding_id: null,
      binding_key_digest: null,
      binding_revision: null,
    });
    expect(prepareV57Target({
      store,
      paneId: PANE,
      suffix: "nullable_binding_01",
      now: new Date(NOW.getTime() + 1_000),
    })).toEqual(prepared);
    const reopened = new ChatPaneStore(database, {
      messageRequestDigestKey: V57_RECEIPT_KEY,
      paneArchiveAuthority: {
        assertPaneArchiveCompatible() {},
        assertProviderThreadArchiveV57Compatible() {},
        assertProviderThreadArchiveTerminalPostimagesV57() {},
        preparePaneArchiveInTransaction() {},
        markPaneArchivedInTransaction() {},
        releaseProviderBindingAfterResumeContainedInTransaction(): never {
          throw new Error("not used");
        },
      },
    });
    expect(reopened.verifyProviderThreadArchiveRecoveryV57().targets)
      .toEqual([prepared]);
    expect(nullable.binding.accountProfileId).toBe(ACCOUNT);

    retainExactV57AttachmentBinding(database, exactPaneId, exact.binding);
    const exactTarget = prepareV57Target({
      store,
      paneId: exactPaneId,
      suffix: "exact_binding_01",
    });
    const exactAuthority = chatProviderAttachmentAuthority(
      exactPaneId,
      exact.binding,
    );
    expect(database.query(`
      SELECT binding_id, binding_key_digest, binding_revision
      FROM chat_provider_thread_archive_targets_v57 WHERE target_id = ?1
    `).get(exactTarget.targetId)).toEqual({
      binding_id: exactAuthority.bindingId,
      binding_key_digest: exactAuthority.bindingKeyDigest,
      binding_revision: 1,
    });
    expect(reopened.verifyProviderThreadArchiveRecoveryV57().targets)
      .toHaveLength(2);

    database.query(`
      UPDATE chat_panes SET state = 'attention',
        attention_code = 'runtime_unavailable',
        attention_message = 'Choose Start fresh.', attention_retryable = 0,
        provider_context_reset_required = 1,
        message_queue_pause_reason = 'attention',
        message_queue_revision = message_queue_revision + 1,
        revision = revision + 1
      WHERE pane_id = ?1
    `).run(startFreshPaneId);
    const startFresh = prepareV57Target({
      store,
      paneId: startFreshPaneId,
      suffix: "start_fresh_exact01",
      purpose: "start_fresh",
    });
    expect(startFresh).toMatchObject({
      purpose: "start_fresh",
      currentAttempt: { state: "effect_started" },
    });
    const queueAuthority = database.query(`
      SELECT queue_revision, queue_cas_digest
      FROM chat_provider_thread_archive_targets_v57 WHERE target_id = ?1
    `).get(startFresh.targetId) as {
      queue_revision: number;
      queue_cas_digest: string;
    };
    expect(queueAuthority.queue_revision).toBe(
      store.require(startFreshPaneId).projection.messageQueue.revision,
    );
    expect(queueAuthority.queue_cas_digest).toMatch(/^[0-9a-f]{64}$/u);
  });
});

test("v57 target preparation composes with an outer transaction rollback", () => {
  withV57Store(({ store, journal, database }) => {
    const fixture = seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: PANE,
      suffix: "outer_rollback_01",
    });
    const before = database.query(`
      SELECT title, revision FROM chat_panes WHERE pane_id = ?1
    `).get(PANE);
    expect(() => database.transaction(() => {
      prepareV57Target({
        store,
        paneId: PANE,
        suffix: "outer_rollback_01",
      });
      database.query(`
        UPDATE chat_panes SET title = 'rolled back title', revision = revision + 1
        WHERE pane_id = ?1
      `).run(PANE);
      throw new Error("fixture outer rollback");
    })()).toThrow("fixture outer rollback");
    expect(database.query(`
      SELECT title, revision FROM chat_panes WHERE pane_id = ?1
    `).get(PANE)).toEqual(before);
    expect(journal.recoveryTargets()).toEqual([]);
    expect(store.require(PANE).binding).toEqual(fixture.binding);
  });
});

test("v57 recovery binding is returned only from the exact Store-owned target preimage", () => {
  withV57Store(({ store, database }) => {
    const fixture = seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: PANE,
      suffix: "recovery_binding_01",
    });
    const target = prepareV57Target({
      store,
      paneId: PANE,
      suffix: "recovery_binding_01",
    });
    expect(store.providerThreadArchiveTargetBindingV57(target.targetId))
      .toEqual(fixture.binding);

    const reopened = new ChatPaneStore(database, {
      messageRequestDigestKey: V57_RECEIPT_KEY,
      paneArchiveAuthority: {
        assertPaneArchiveCompatible() {},
        assertProviderThreadArchiveV57Compatible() {},
        assertProviderThreadArchiveTerminalPostimagesV57() {},
        preparePaneArchiveInTransaction() {},
        markPaneArchivedInTransaction() {},
        releaseProviderBindingAfterResumeContainedInTransaction(): never {
          throw new Error("not used");
        },
      },
    });
    expect(reopened.providerThreadArchiveTargetBindingV57(target.targetId))
      .toEqual(fixture.binding);

    database.query(`
      UPDATE chat_panes
      SET provider_restart_thread_id = provider_restart_thread_id || '_drift'
      WHERE pane_id = ?1
    `).run(PANE);
    expect(() =>
      reopened.providerThreadArchiveTargetBindingV57(target.targetId)
    ).toThrow();
  });
});

test("v57 provider-effect admission atomically prepares and promotes one exact effect_started descriptor", () => {
  withV57Store(({ store, journal, database }) => {
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: PANE,
      suffix: "atomic_effect_started01",
    });
    const rollbackPaneId = "pane_v57_atomic_rollback01";
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: rollbackPaneId,
      suffix: "atomic_effect_rollback01",
    });
    const markFailurePaneId = "pane_v57_mark_failure001";
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: markFailurePaneId,
      suffix: "atomic_mark_failure01",
    });
    const input = v57TargetPreparationInput({
      store,
      paneId: PANE,
      suffix: "atomic_effect_started01",
    });
    const descriptor = store.prepareProviderThreadArchiveEffectStartedV57(
      input,
    );
    expect(descriptor).toMatchObject({
      transitionId: input.targetId,
      paneId: PANE,
      purpose: "pane_archive",
      expectedGeneration: 1,
      successorGeneration: null,
      attemptOrdinal: 1,
      attemptPhase: "effect_started",
    });
    expect(store.prepareProviderThreadArchiveEffectStartedV57({
      ...input,
      now: new Date(NOW.getTime() + 1_000),
    })).toEqual(descriptor);
    expect(journal.reopenTarget(input.targetId).currentAttempt.state)
      .toBe("effect_started");
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM chat_provider_thread_archive_attempts_v57
      WHERE state = 'prepared'
    `).get()).toEqual({ count: 0 });

    const rollbackInput = v57TargetPreparationInput({
      store,
      paneId: rollbackPaneId,
      suffix: "atomic_effect_rollback01",
    });
    expect(() => database.transaction(() => {
      store.prepareProviderThreadArchiveEffectStartedV57(rollbackInput);
      throw new Error("fixture effect-start outer rollback");
    })()).toThrow("fixture effect-start outer rollback");
    expect(journal.recoveryTargets().map((target) => target.targetId))
      .toEqual([input.targetId]);

    const markFailureInput = v57TargetPreparationInput({
      store,
      paneId: markFailurePaneId,
      suffix: "atomic_mark_failure01",
    });
    database.exec(`
      CREATE TRIGGER fixture_v57_effect_start_failure
      BEFORE UPDATE OF state ON chat_provider_thread_archive_attempts_v57
      WHEN NEW.attempt_id = 'archattempt_v57_atomic_mark_failure01'
        AND NEW.state = 'effect_started'
      BEGIN
        SELECT RAISE(ABORT, 'fixture v57 effect-start failure');
      END;
    `);
    expect(() => store.prepareProviderThreadArchiveEffectStartedV57(
      markFailureInput,
    )).toThrow("fixture v57 effect-start failure");
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM chat_provider_thread_archive_targets_v57 WHERE target_id = ?1
    `).get(markFailureInput.targetId)).toEqual({ count: 0 });
    database.exec("DROP TRIGGER fixture_v57_effect_start_failure");

    expect(new ChatPaneStore(database, {
      messageRequestDigestKey: V57_RECEIPT_KEY,
      paneArchiveAuthority: {
        assertPaneArchiveCompatible() {},
        assertProviderThreadArchiveV57Compatible() {},
        assertProviderThreadArchiveTerminalPostimagesV57() {},
        preparePaneArchiveInTransaction() {},
        markPaneArchivedInTransaction() {},
        releaseProviderBindingAfterResumeContainedInTransaction(): never {
          throw new Error("not used");
        },
      },
    }).verifyProviderThreadArchiveRecoveryV57().targets).toHaveLength(1);
  });
});

test("v57 direct outcome and lost-response entry reject raw journal request or effect authority", () => {
  withV57Store(({ store, journal, database }) => {
    const requestPaneId = "pane_v57_raw_request01";
    const requestFixture = seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: requestPaneId,
      suffix: "raw_request01",
    });
    const effectPaneId = "pane_v57_raw_effect001";
    const effectFixture = seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: effectPaneId,
      suffix: "raw_effect01",
    });
    const prepareRaw = (input: Readonly<{
      paneId: string;
      suffix: string;
      binding: ChatThreadBinding;
      exactRequest: boolean;
    }>): Readonly<{ targetId: string; attemptId: string }> => {
      const pane = store.require(input.paneId).projection;
      const targetId = `archtarget_v57_${input.suffix}`;
      const attemptId = `archattempt_v57_${input.suffix}`;
      const paneCasDigest = v57Digest("a");
      const requestEvidenceDigest = input.exactRequest
        ? v57StoreHmac("target-request-evidence", {
            targetId,
            attemptId,
            paneId: input.paneId,
            purpose: "pane_archive",
            accountProfileId: ACCOUNT,
            threadId: input.binding.threadId,
            restartThreadId: input.binding.restartThreadId,
            generation: 1,
            paneCasDigest,
            queueCasDigest: null,
            binding: { kind: "none" },
          })
        : v57Digest("b");
      const requestRevisionDigest = input.exactRequest
        ? v57StoreHmac("target-request-revision", {
            targetId,
            attemptId,
            paneRevision: pane.revision,
            queueRevision: null,
            accountProfileRevision: 1,
            generation: 1,
          })
        : v57Digest("c");
      journal.prepareTarget({
        targetId,
        paneId: input.paneId,
        purpose: "pane_archive",
        paneRevision: pane.revision,
        queueRevision: null,
        paneCasDigest,
        queueCasDigest: null,
        accountProfileId: ACCOUNT,
        accountProfileRevision: 1,
        threadId: input.binding.threadId,
        restartThreadId: input.binding.restartThreadId,
        binding: { kind: "none" },
        attempt: {
          attemptId,
          generation: 1,
          accountProfileRevision: 1,
          requestEvidenceDigest,
          requestRevisionDigest,
        },
        now: NOW,
      });
      journal.markEffectStarted({
        attemptId,
        effectEvidenceDigest: v57Digest("d"),
        effectRevisionDigest: v57Digest("e"),
        now: NOW,
      });
      return { targetId, attemptId };
    };
    const rawRequest = prepareRaw({
      paneId: requestPaneId,
      suffix: "raw_request01",
      binding: requestFixture.binding,
      exactRequest: false,
    });
    const rawEffect = prepareRaw({
      paneId: effectPaneId,
      suffix: "raw_effect01",
      binding: effectFixture.binding,
      exactRequest: true,
    });

    expect(() => store.recordProviderThreadArchiveDirectAppliedV57({
      targetId: rawRequest.targetId,
      responseGeneration: 1,
      responseStreamPosition: 1,
      providerContainmentReceipt: "raw-request-must-not-be-adopted",
      now: NOW,
    })).toThrow("exact store-owned request authority");
    expect(() => store.beginProviderThreadArchiveLostResponseCutV57({
      targetId: rawRequest.targetId,
      cutId: "archcut_v57_raw_request01",
      cause: "lost_response",
      now: NOW,
    })).toThrow("exact store-owned request authority");
    expect(() => store.recordProviderThreadArchiveDirectAppliedV57({
      targetId: rawEffect.targetId,
      responseGeneration: 1,
      responseStreamPosition: 2,
      providerContainmentReceipt: "raw-effect-must-not-be-adopted",
      now: NOW,
    })).toThrow("exact store-owned effect evidence");
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_provider_thread_archive_cuts_v57
    `).get()).toEqual({ count: 0 });
    expect(journal.reopenTarget(rawRequest.targetId).currentAttempt.state)
      .toBe("effect_started");
    expect(journal.reopenTarget(rawEffect.targetId).currentAttempt.state)
      .toBe("effect_started");
  });
});

test("v57 account quarantine blocks ordinary and Harness bootstrap in the same transaction", () => {
  withV57Store(({ store, journal, database }) => {
    const reservePaneId = "pane_v57_quarantine_reserve01";
    const reserveCreated = createPane(store, reservePaneId);
    const reserveTurnId = "chatturn_v57_quarantine_reserve01";
    store.beginTurn({
      paneId: reservePaneId,
      expectedRevision: reserveCreated.revision,
      turnId: reserveTurnId,
      prompt: "reserve after quarantine",
      now: NOW,
    });

    const preparePaneId = "pane_v57_quarantine_prepare01";
    const prepareCreated = createPane(store, preparePaneId);
    const prepareTurnId = "chatturn_v57_quarantine_prepare01";
    store.beginTurn({
      paneId: preparePaneId,
      expectedRevision: prepareCreated.revision,
      turnId: prepareTurnId,
      prompt: "prepare after quarantine",
      now: NOW,
    });
    store.reserveAccount(
      preparePaneId,
      prepareTurnId,
      ACCOUNT,
      NOW,
    );

    const secondaryAccount = "acct_v57_quarantine_secondary01";
    database.query(`
      INSERT INTO account_profiles (
        profile_id, label, auth_state, process_generation,
        selected, created_at, updated_at
      ) VALUES (?1, 'Secondary', 'signed_in', 1, 0, ?2, ?2)
    `).run(secondaryAccount, NOW.toISOString());
    const harness = database.transaction(() =>
      store.createAttachedHarnessSession({
        actorId: "hactor_v57_quarantine_rebind01",
        repository: {
          id: REPOSITORY,
          name: "Quarantine Harness",
          workingDirectory: "/fixture/quarantine-harness",
        },
        binding: {
          accountProfileId: secondaryAccount,
          threadId: "thread_v57_quarantine_secondary01",
          restartThreadId: "raw_thread_v57_quarantine_secondary01",
        },
        title: "Quarantine Harness",
        now: NOW,
      })
    )();

    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: PANE,
      suffix: "account_quarantine_target01",
    });
    prepareV57Target({
      store,
      paneId: PANE,
      suffix: "account_quarantine_target01",
    });

    const reserveBefore = store.require(reservePaneId).projection;
    expect(() => store.reserveAccount(
      reservePaneId,
      reserveTurnId,
      ACCOUNT,
      NOW,
    )).toThrow("quarantined by a pending v57 archive transition");
    expect(store.require(reservePaneId).projection).toEqual(reserveBefore);

    const prepareBefore = store.require(preparePaneId).projection;
    expect(() => store.prepareProviderThread(
      preparePaneId,
      prepareTurnId,
      {
        accountProfileId: ACCOUNT,
        threadId: "thread_v57_quarantine_prepare01",
        restartThreadId: "raw_thread_v57_quarantine_prepare01",
      },
      NOW,
    )).toThrow("quarantined by a pending v57 archive transition");
    expect(store.require(preparePaneId).projection).toEqual(prepareBefore);

    expect(() => database.transaction(() =>
      store.createAttachedHarnessSession({
        actorId: "hactor_v57_quarantine_attach01",
        repository: {
          id: REPOSITORY,
          name: "Blocked Harness",
          workingDirectory: "/fixture/blocked-harness",
        },
        binding: {
          accountProfileId: ACCOUNT,
          threadId: "thread_v57_quarantine_attach01",
          restartThreadId: "raw_thread_v57_quarantine_attach01",
        },
        title: "Blocked Harness",
        now: NOW,
      })
    )()).toThrow("quarantined by a pending v57 archive transition");
    expect(store.get(harnessObserverPaneId(
      "hactor_v57_quarantine_attach01",
    ))).toBeNull();

    expect(() => store.rebindAttachedHarnessSession({
      paneId: harness.pane.id,
      binding: {
        accountProfileId: ACCOUNT,
        threadId: "thread_v57_quarantine_rebind01",
        restartThreadId: "raw_thread_v57_quarantine_rebind01",
      },
      now: NOW,
    })).toThrow("quarantined by a pending v57 archive transition");
    expect(store.require(harness.pane.id).binding?.accountProfileId)
      .toBe(secondaryAccount);

    const destinationAccount = "acct_v57_quarantine_destination1";
    database.query(`
      INSERT INTO account_profiles (
        profile_id, label, auth_state, process_generation,
        selected, created_at, updated_at
      ) VALUES (?1, 'Destination', 'signed_in', 1, 0, ?2, ?2)
    `).run(destinationAccount, NOW.toISOString());
    journal.createCut({
      cutId: "archcut_v57_quarantine_removal01",
      accountProfileId: secondaryAccount,
      accountProfileRevision: 1,
      sourceGeneration: 1,
      cause: "account_removal",
      initiatingAttemptId: null,
      predecessorCutId: null,
      identityEvidenceDigest: v57Digest("7"),
      identityRevisionDigest: v57Digest("8"),
      now: NOW,
    });
    const harnessResponse = {
      paneId: harness.pane.id,
      turnId: "chatturn_v57_quarantine_harness01",
      markdown: "must remain frozen",
      startedAt: NOW,
      completedAt: new Date(NOW.getTime() + 1_000),
      now: new Date(NOW.getTime() + 1_000),
    } as const;
    expect(() => store.seedAttachedHarnessLatestResponse(harnessResponse))
      .toThrow("active v57 source-generation cut");
    expect(() => store.seedAttachedHarnessLatestFailure({
      paneId: harness.pane.id,
      turnId: harnessResponse.turnId,
      attention: {
        code: "turn_failed",
        message: "must remain frozen",
        retryable: false,
      },
      startedAt: NOW,
      completedAt: new Date(NOW.getTime() + 1_000),
      now: new Date(NOW.getTime() + 1_000),
    })).toThrow("active v57 source-generation cut");
    expect(() => store.completeAttachedHarnessTurn({
      paneId: harness.pane.id,
      turnId: harnessResponse.turnId,
      markdown: harnessResponse.markdown,
      now: new Date(NOW.getTime() + 1_000),
    })).toThrow("active v57 source-generation cut");
    expect(() => store.rebindAttachedHarnessSession({
      paneId: harness.pane.id,
      binding: {
        accountProfileId: destinationAccount,
        threadId: "thread_v57_quarantine_destination1",
        restartThreadId: "raw_thread_v57_quarantine_destination1",
      },
      now: NOW,
    })).toThrow("active v57 source-generation cut");
    expect(store.require(harness.pane.id).projection).toEqual(harness.pane);
  });
});

test("v57 direct outcome and pane finalization are replayable with the journal marker last", () => {
  withV57Store(({ store, journal, database }) => {
    const fixture = seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: PANE,
      suffix: "direct_finalize01",
    });
    database.query(`
      UPDATE chat_panes SET state = 'attention',
        attention_code = 'runtime_unavailable',
        attention_message = 'Choose Start fresh.', attention_retryable = 0,
        provider_context_reset_required = 1,
        message_queue_pause_reason = 'attention',
        message_queue_revision = message_queue_revision + 1,
        revision = revision + 1
      WHERE pane_id = ?1
    `).run(PANE);
    expect(store.require(PANE).projection.canStartFreshContext).toBeTrue();
    retainExactV57AttachmentBinding(database, PANE, fixture.binding);
    const preparation = v57TargetPreparationInput({
      store,
      paneId: PANE,
      suffix: "direct_finalize01",
    });
    store.prepareProviderThreadArchiveEffectStartedV57(preparation);
    expect(store.require(PANE).projection.canStartFreshContext).toBeFalse();
    const direct = store.recordProviderThreadArchiveDirectAppliedV57({
      targetId: preparation.targetId,
      responseGeneration: 1,
      responseStreamPosition: 17,
      providerContainmentReceipt: "provider-direct-containment-01",
      now: NOW,
    });
    expect(direct).toMatchObject({
      transitionId: preparation.targetId,
      attemptPhase: "direct_applied",
      expectedGeneration: 1,
    });
    expect(store.recordProviderThreadArchiveDirectAppliedV57({
      targetId: preparation.targetId,
      responseGeneration: 1,
      responseStreamPosition: 17,
      providerContainmentReceipt: "provider-direct-containment-01",
      now: new Date(NOW.getTime() + 1_000),
    })).toEqual(direct);
    expect(() => store.recordProviderThreadArchiveDirectAppliedV57({
      targetId: preparation.targetId,
      responseGeneration: 1,
      responseStreamPosition: 17,
      providerContainmentReceipt: "provider-direct-containment-drift",
      now: NOW,
    })).toThrow("changed after it was recorded");

    database.exec(`
      CREATE TEMP TRIGGER fail_v57_target_commit_last
      BEFORE UPDATE OF status ON chat_provider_thread_archive_targets_v57
      WHEN NEW.target_id = 'archtarget_v57_direct_finalize01'
        AND NEW.status = 'committed'
      BEGIN
        SELECT RAISE(ABORT, 'injected v57 target commit failure');
      END;
    `);
    expect(() => store.finalizeProviderThreadArchiveTargetV57({
      targetId: preparation.targetId,
      now: NOW,
    })).toThrow("injected v57 target commit failure");
    expect(database.query(`
      SELECT archived_at FROM chat_panes WHERE pane_id = ?1
    `).get(PANE)).toEqual({ archived_at: null });
    expect(database.query(`
      SELECT state, revision FROM chat_provider_attachment_bindings
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ state: "active", revision: 1 });
    expect(journal.reopenTarget(preparation.targetId)).toMatchObject({
      status: "open",
      currentAttempt: { state: "direct_applied" },
    });
    database.exec("DROP TRIGGER fail_v57_target_commit_last");

    const finalized = store.finalizeProviderThreadArchiveTargetV57({
      targetId: preparation.targetId,
      now: NOW,
    });
    expect(finalized).toMatchObject({
      kind: "pane_archive",
      removed: { paneId: PANE },
    });
    expect(finalized.containmentReceipt).toMatch(/^[0-9a-f]{64}$/u);
    expect(journal.reopenTarget(preparation.targetId).status).toBe("committed");
    expect(store.verifyProviderThreadArchiveTerminalAuthorityV57())
      .toEqual([preparation.targetId]);
    expect(database.query(`
      SELECT archived_at FROM chat_panes WHERE pane_id = ?1
    `).get(PANE)).toEqual({ archived_at: NOW.toISOString() });
    expect(database.query(`
      SELECT state, revision FROM chat_provider_attachment_bindings
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ state: "released", revision: 2 });
    const reopened = new ChatPaneStore(database, {
      messageRequestDigestKey: V57_RECEIPT_KEY,
    });
    expect(reopened.finalizeProviderThreadArchiveTargetV57({
      targetId: preparation.targetId,
      now: new Date(NOW.getTime() + 5_000),
    })).toEqual(finalized);
  });
});

test("v57 start-fresh finalization preserves local content, rolls back, and replays", () => {
  withV57Store(({ store, journal, database }) => {
    const fixture = seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: PANE,
      suffix: "start_finalize01",
    });
    retainExactV57AttachmentBinding(database, PANE, fixture.binding);
    const queued = store.enqueueMessage({
      paneId: PANE,
      expectedQueueRevision: store.messageQueue(PANE).revision,
      messageId: "chatmsg_v57_start_finalize01",
      content: {
        text: "keep this queued message after the provider reset",
        attachmentRefs: [],
      },
      now: NOW,
    });
    database.query(`
      INSERT INTO chat_pane_history (
        pane_id, sequence, role, text, utf8_bytes, created_at
      ) VALUES (?1, 1, 'assistant', ?2, ?3, ?4)
    `).run(
      PANE,
      "keep this displayed history row",
      Buffer.byteLength("keep this displayed history row", "utf8"),
      NOW.toISOString(),
    );
    database.query(`
      UPDATE chat_panes SET state = 'attention',
        attention_code = 'runtime_unavailable',
        attention_message = 'Choose Start fresh.', attention_retryable = 0,
        provider_context_reset_required = 1,
        message_queue_pause_reason = 'attention',
        message_queue_revision = message_queue_revision + 1,
        revision = revision + 1
      WHERE pane_id = ?1
    `).run(PANE);
    const preflight = store.require(PANE).projection;
    expect(preflight.canStartFreshContext).toBeTrue();
    expect(preflight.messageQueue.revision).toBe(queued.revision + 1);
    const preparation = v57TargetPreparationInput({
      store,
      paneId: PANE,
      suffix: "start_finalize01",
      purpose: "start_fresh",
    });
    store.prepareProviderThreadArchiveEffectStartedV57(preparation);
    expect(store.require(PANE).projection.canStartFreshContext).toBeTrue();
    store.recordProviderThreadArchiveDirectAppliedV57({
      targetId: preparation.targetId,
      responseGeneration: 1,
      responseStreamPosition: 31,
      providerContainmentReceipt: "provider-start-fresh-containment-01",
      now: NOW,
    });
    const paneBefore = database.query(`
      SELECT revision, message_queue_revision, state, attention_code,
        provider_context_reset_required, provider_account_profile_id,
        provider_thread_id, provider_restart_thread_id
      FROM chat_panes WHERE pane_id = ?1
    `).get(PANE);
    const messagesBefore = database.query(`
      SELECT message_id, state, revision, message_text, claimed_turn_id
      FROM chat_message_ledger WHERE pane_id = ?1 ORDER BY ordinal
    `).all(PANE);
    const historyBefore = database.query(`
      SELECT sequence, role, text, utf8_bytes
      FROM chat_pane_history WHERE pane_id = ?1 ORDER BY sequence
    `).all(PANE);

    database.exec(`
      CREATE TEMP TRIGGER fail_v57_start_fresh_commit_last
      BEFORE UPDATE OF status ON chat_provider_thread_archive_targets_v57
      WHEN NEW.target_id = 'archtarget_v57_start_finalize01'
        AND NEW.status = 'committed'
      BEGIN
        SELECT RAISE(ABORT, 'injected v57 start-fresh commit failure');
      END;
    `);
    expect(() => store.finalizeProviderThreadArchiveTargetV57({
      targetId: preparation.targetId,
      now: NOW,
    })).toThrow("injected v57 start-fresh commit failure");
    expect(database.query(`
      SELECT revision, message_queue_revision, state, attention_code,
        provider_context_reset_required, provider_account_profile_id,
        provider_thread_id, provider_restart_thread_id
      FROM chat_panes WHERE pane_id = ?1
    `).get(PANE)).toEqual(paneBefore);
    expect(database.query(`
      SELECT state, revision FROM chat_provider_attachment_bindings
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ state: "active", revision: 1 });
    expect(database.query(`
      SELECT message_id, state, revision, message_text, claimed_turn_id
      FROM chat_message_ledger WHERE pane_id = ?1 ORDER BY ordinal
    `).all(PANE)).toEqual(messagesBefore);
    expect(database.query(`
      SELECT sequence, role, text, utf8_bytes
      FROM chat_pane_history WHERE pane_id = ?1 ORDER BY sequence
    `).all(PANE)).toEqual(historyBefore);
    expect(journal.reopenTarget(preparation.targetId)).toMatchObject({
      status: "open",
      currentAttempt: { state: "direct_applied" },
    });
    database.exec("DROP TRIGGER fail_v57_start_fresh_commit_last");

    const finalized = store.finalizeProviderThreadArchiveTargetV57({
      targetId: preparation.targetId,
      now: NOW,
    });
    expect(finalized).toMatchObject({
      kind: "start_fresh",
      pane: {
        id: PANE,
        revision: preflight.revision + 1,
        state: "ready",
        canStartFreshContext: false,
      },
      queue: {
        revision: preflight.messageQueue.revision + 1,
        messages: queued.messages,
      },
    });
    expect(finalized.containmentReceipt).toMatch(/^[0-9a-f]{64}$/u);
    expect(database.query(`
      SELECT provider_account_profile_id, provider_thread_id,
        provider_restart_thread_id, provider_context_reset_required,
        provider_history_floor_sequence
      FROM chat_panes WHERE pane_id = ?1
    `).get(PANE)).toEqual({
      provider_account_profile_id: null,
      provider_thread_id: null,
      provider_restart_thread_id: null,
      provider_context_reset_required: 0,
      provider_history_floor_sequence: 1,
    });
    expect(database.query(`
      SELECT state, revision FROM chat_provider_attachment_bindings
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ state: "released", revision: 2 });
    expect(database.query(`
      SELECT message_id, state, revision, message_text, claimed_turn_id
      FROM chat_message_ledger WHERE pane_id = ?1 ORDER BY ordinal
    `).all(PANE)).toEqual(messagesBefore);
    expect(database.query(`
      SELECT sequence, role, text, utf8_bytes
      FROM chat_pane_history WHERE pane_id = ?1 ORDER BY sequence
    `).all(PANE)).toEqual(historyBefore);
    expect(journal.reopenTarget(preparation.targetId).status).toBe("committed");
    expect(store.verifyProviderThreadArchiveTerminalAuthorityV57())
      .toEqual([preparation.targetId]);
    expect(() => store.rename(
      PANE,
      finalized.kind === "start_fresh"
        ? finalized.pane.revision
        : preflight.revision,
      "must remain frozen until archive authority is released",
      new Date(NOW.getTime() + 2_000),
    )).toThrow("v57 provider-context transition is pending");
    expect(() => store.prepareProviderThread(
      PANE,
      "chatturn_v57_start_finalize_blocked01",
      fixture.binding,
      new Date(NOW.getTime() + 2_000),
    )).toThrow("quarantined by a pending v57 archive transition");
    const reopened = new ChatPaneStore(database, {
      messageRequestDigestKey: V57_RECEIPT_KEY,
    });
    expect(reopened.finalizeProviderThreadArchiveTargetV57({
      targetId: preparation.targetId,
      now: new Date(NOW.getTime() + 5_000),
    })).toEqual(finalized);
  });
});

test("v57 terminal component harvest waits for every commit and replays the exact sorted cohort", () => {
  withV57Store(({ store, journal, database }) => {
    const firstPaneId = "pane_v57_terminal_harvesta01";
    const secondPaneId = "pane_v57_terminal_harvestb01";
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: firstPaneId,
      suffix: "terminal_harvesta01",
    });
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: secondPaneId,
      suffix: "terminal_harvestb01",
    });
    database.query(`
      UPDATE chat_panes SET state = 'attention',
        attention_code = 'runtime_unavailable',
        attention_message = 'Choose Start fresh.', attention_retryable = 0,
        provider_context_reset_required = 1,
        message_queue_pause_reason = 'attention',
        message_queue_revision = message_queue_revision + 1,
        revision = revision + 1
      WHERE pane_id = ?1
    `).run(firstPaneId);
    const first = v57TargetPreparationInput({
      store,
      paneId: firstPaneId,
      suffix: "terminal_harvesta01",
      purpose: "start_fresh",
    });
    const second = v57TargetPreparationInput({
      store,
      paneId: secondPaneId,
      suffix: "terminal_harvestb01",
    });
    store.prepareProviderThreadArchiveEffectStartedV57(first);
    store.prepareProviderThreadArchiveEffectStartedV57(second);
    const cutId = "archcut_v57_terminal_harvest01";
    store.beginProviderThreadArchiveLostResponseCutV57({
      targetId: second.targetId,
      cutId,
      cause: "lost_response",
      now: NOW,
    });
    const successorRevision = advanceV57AccountGeneration(database, 2);
    journal.recordFence({
      cutId,
      successorGeneration: 2,
      successorAccountProfileRevision: successorRevision,
      fenceEvidenceDigest: v57Digest("1"),
      fenceRevisionDigest: v57Digest("2"),
      now: NOW,
    });
    const sealed = store.sealProviderThreadArchiveSourceInventoryV57({
      cutId,
      now: NOW,
    });
    for (const member of sealed.members) {
      store.settleProviderThreadArchiveMemberV57({
        memberId: member.memberId,
        now: NOW,
      });
    }
    store.markProviderThreadArchiveCutContainedV57({ cutId, now: NOW });
    for (const [index, targetId] of [first.targetId, second.targetId]
      .entries()) {
      store.recordProviderThreadArchiveReconciliationV57({
        targetId,
        result: {
          disposition: "applied",
          responseGeneration: 2,
          responseStreamPosition: 50 + index,
          providerContainmentReceipt: `terminal harvest ${index}`,
        },
        now: NOW,
      });
    }

    const firstResult = store.finalizeProviderThreadArchiveTargetV57({
      targetId: first.targetId,
      now: NOW,
    });
    const targetIds = [first.targetId, second.targetId].toSorted();
    const targets = [
      { targetId: first.targetId, paneId: firstPaneId },
      { targetId: second.targetId, paneId: secondPaneId },
    ].toSorted((left, right) =>
      left.targetId < right.targetId
        ? -1
        : left.targetId > right.targetId ? 1 : 0
    );
    expect(store.verifiedProviderThreadArchiveTerminalComponentV57(
      first.targetId,
    )).toEqual({
      component: {
        accountProfileId: ACCOUNT,
        targetIds,
        cutIds: [cutId],
        allTargetsCommitted: false,
      },
      targets,
      finalizations: [],
    });

    const secondResult = store.finalizeProviderThreadArchiveTargetV57({
      targetId: second.targetId,
      now: NOW,
    });
    const expectedFinalizations = [
      {
        targetId: first.targetId,
        paneId: firstPaneId,
        result: firstResult,
      },
      {
        targetId: second.targetId,
        paneId: secondPaneId,
        result: secondResult,
      },
    ].toSorted((left, right) =>
      left.targetId < right.targetId
        ? -1
        : left.targetId > right.targetId ? 1 : 0
    );
    const complete = store.verifiedProviderThreadArchiveTerminalComponentV57(
      second.targetId,
    );
    expect(complete).toEqual({
      component: {
        accountProfileId: ACCOUNT,
        targetIds,
        cutIds: [cutId],
        allTargetsCommitted: true,
      },
      targets,
      finalizations: expectedFinalizations,
    });
    expect(store.verifiedProviderThreadArchiveTerminalComponentV57(
      first.targetId,
    )).toEqual(complete);
    expect(database.transaction(() =>
      store.verifiedProviderThreadArchiveTerminalComponentV57(first.targetId)
    )()).toEqual(complete);

    database.query(`
      UPDATE chat_panes SET revision = revision + 1 WHERE pane_id = ?1
    `).run(firstPaneId);
    expect(() => store.verifiedProviderThreadArchiveTerminalComponentV57(
      second.targetId,
    )).toThrow("exact local postimage");
  });
});

test("v57 terminal component harvest rejects a raw journal commit without the Store postimage", () => {
  withV57Store(({ store, journal, database }) => {
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: PANE,
      suffix: "terminal_raw_commit01",
    });
    const preparation = v57TargetPreparationInput({
      store,
      paneId: PANE,
      suffix: "terminal_raw_commit01",
    });
    store.prepareProviderThreadArchiveEffectStartedV57(preparation);
    store.recordProviderThreadArchiveDirectAppliedV57({
      targetId: preparation.targetId,
      responseGeneration: 1,
      responseStreamPosition: 61,
      providerContainmentReceipt: "terminal raw commit",
      now: NOW,
    });
    journal.markTargetCommitted({
      targetId: preparation.targetId,
      commitEvidenceDigest: v57Digest("a"),
      commitRevisionDigest: v57Digest("b"),
      now: NOW,
    });

    expect(() => store.verifiedProviderThreadArchiveTerminalComponentV57(
      preparation.targetId,
    )).toThrow("exact local postimage");
    expect(journal.reopenTarget(preparation.targetId).status).toBe("committed");
  });
});

test("v57 startup terminal sweep rolls two component deletion back byte-for-byte when the second fails", () => {
  withV57Store(({
    store,
    database,
    terminalPostimageAssertions,
  }) => {
    const [first, second] = finalizeV57IndependentDirectTargets({
      store,
      database,
      targets: [{
        paneId: "pane_v57_sweep_rollbacka01",
        suffix: "sweep_rollbacka01",
      }, {
        paneId: "pane_v57_sweep_rollbackb01",
        suffix: "sweep_rollbackb01",
      }],
    });
    if (first === undefined || second === undefined) {
      throw new Error("Expected two v57 rollback targets");
    }
    const targetIds = [first.targetId, second.targetId].toSorted();
    database.exec(`
      CREATE TEMP TRIGGER fail_v57_second_terminal_component
      BEFORE DELETE ON chat_provider_thread_archive_targets_v57
      WHEN OLD.target_id = 'archtarget_v57_sweep_rollbackb01'
      BEGIN
        SELECT RAISE(ABORT, 'injected second v57 terminal deletion failure');
      END;
    `);
    const bytesBefore = Uint8Array.from(database.serialize());

    expect(() => store.sweepProviderThreadArchiveTerminalAuthorityV57(
      targetIds,
    )).toThrow("injected second v57 terminal deletion failure");
    expect(Uint8Array.from(database.serialize())).toEqual(bytesBefore);
    expect(store.verifyProviderThreadArchiveTerminalAuthorityV57())
      .toEqual(targetIds);
    expect(terminalPostimageAssertions).toEqual([targetIds]);
  });
});

test("v57 startup terminal sweep verifies every settled source-only member before deletion", () => {
  withV57Store(({ store, journal, database }) => {
    const fixture = sealV57MemberFixture({
      store,
      journal,
      database,
      suffix: "sweep_source_postimage01",
      exactBinding: true,
    });
    const sealed = journal.reopenCut(fixture.cutId);
    for (const member of sealed.members) {
      store.settleProviderThreadArchiveMemberV57({
        memberId: member.memberId,
        now: NOW,
      });
    }
    store.markProviderThreadArchiveCutContainedV57({
      cutId: fixture.cutId,
      now: NOW,
    });
    store.recordProviderThreadArchiveReconciliationV57({
      targetId: fixture.target.targetId,
      result: {
        disposition: "applied",
        responseGeneration: 2,
        responseStreamPosition: 144,
        providerContainmentReceipt: "source-only postimage containment",
      },
      now: NOW,
    });
    store.finalizeProviderThreadArchiveTargetV57({
      targetId: fixture.target.targetId,
      now: NOW,
    });
    const siblingPostimage = database.query<{
      attention_message: string;
    }, [string]>(`
      SELECT attention_message FROM chat_panes WHERE pane_id = ?1
    `).get(fixture.sibling.pane.projection.id);
    if (siblingPostimage === null) {
      throw new Error("Expected a settled v57 source-only sibling postimage");
    }
    database.query(`
      UPDATE chat_panes SET attention_message = 'drifted source postimage'
      WHERE pane_id = ?1
    `).run(fixture.sibling.pane.projection.id);
    const driftedBytes = Uint8Array.from(database.serialize());

    expect(() => store.sweepProviderThreadArchiveTerminalAuthorityV57([
      fixture.target.targetId,
    ])).toThrow("exact detached postimage");
    expect(Uint8Array.from(database.serialize())).toEqual(driftedBytes);
    expect(database.query(`
      SELECT
        (SELECT COUNT(*) FROM chat_provider_thread_archive_targets_v57)
          AS targets,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_attempts_v57)
          AS attempts,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_cuts_v57)
          AS cuts,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_cut_members_v57)
          AS members
    `).get()).toEqual({ targets: 1, attempts: 1, cuts: 1, members: 2 });

    database.query(`
      UPDATE chat_panes SET attention_message = ?2 WHERE pane_id = ?1
    `).run(
      fixture.sibling.pane.projection.id,
      siblingPostimage.attention_message,
    );
    expect(store.sweepProviderThreadArchiveTerminalAuthorityV57([
      fixture.target.targetId,
    ]).cleanup).toEqual({
      deletedTargetIds: [fixture.target.targetId],
      deletedCutIds: [fixture.cutId],
    });
    expect(database.query(`
      SELECT
        (SELECT COUNT(*) FROM chat_provider_thread_archive_targets_v57)
          AS targets,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_attempts_v57)
          AS attempts,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_cuts_v57)
          AS cuts,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_cut_members_v57)
          AS members
    `).get()).toEqual({ targets: 0, attempts: 0, cuts: 0, members: 0 });
  });
});

test("v57 startup terminal sweep retains a whole mixed committed and open component", () => {
  withV57Store(({
    store,
    journal,
    database,
    terminalPostimageAssertions,
  }) => {
    const firstPaneId = "pane_v57_sweep_mixeda01";
    const secondPaneId = "pane_v57_sweep_mixedb01";
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: firstPaneId,
      suffix: "sweep_mixeda01",
    });
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: secondPaneId,
      suffix: "sweep_mixedb01",
    });
    const first = v57TargetPreparationInput({
      store,
      paneId: firstPaneId,
      suffix: "sweep_mixeda01",
    });
    const second = v57TargetPreparationInput({
      store,
      paneId: secondPaneId,
      suffix: "sweep_mixedb01",
    });
    store.prepareProviderThreadArchiveEffectStartedV57(first);
    store.prepareProviderThreadArchiveEffectStartedV57(second);
    const cutId = "archcut_v57_sweep_mixed01";
    store.beginProviderThreadArchiveLostResponseCutV57({
      targetId: second.targetId,
      cutId,
      cause: "lost_response",
      now: NOW,
    });
    const successorRevision = advanceV57AccountGeneration(database, 2);
    journal.recordFence({
      cutId,
      successorGeneration: 2,
      successorAccountProfileRevision: successorRevision,
      fenceEvidenceDigest: v57Digest("1"),
      fenceRevisionDigest: v57Digest("2"),
      now: NOW,
    });
    const sealed = store.sealProviderThreadArchiveSourceInventoryV57({
      cutId,
      now: NOW,
    });
    for (const member of sealed.members) {
      store.settleProviderThreadArchiveMemberV57({
        memberId: member.memberId,
        now: NOW,
      });
    }
    store.markProviderThreadArchiveCutContainedV57({ cutId, now: NOW });
    for (const [index, targetId] of [first.targetId, second.targetId]
      .entries()) {
      store.recordProviderThreadArchiveReconciliationV57({
        targetId,
        result: {
          disposition: "applied",
          responseGeneration: 2,
          responseStreamPosition: 70 + index,
          providerContainmentReceipt: `sweep mixed containment ${index}`,
        },
        now: NOW,
      });
    }
    store.finalizeProviderThreadArchiveTargetV57({
      targetId: first.targetId,
      now: NOW,
    });

    const result = store.sweepProviderThreadArchiveTerminalAuthorityV57([
      first.targetId,
    ]);
    expect(result.cleanup).toEqual({
      deletedTargetIds: [],
      deletedCutIds: [],
    });
    expect(result.recoveryInventory.targets.map(({ targetId }) => targetId))
      .toEqual([second.targetId]);
    expect(result.recoveryInventory.activeCuts.map(({ cutId: id }) => id))
      .toEqual([]);
    expect(terminalPostimageAssertions).toEqual([[first.targetId]]);
    expect(store.verifiedProviderThreadArchiveTerminalComponentV57(
      first.targetId,
    ).component).toEqual({
      accountProfileId: ACCOUNT,
      targetIds: [first.targetId, second.targetId].toSorted(),
      cutIds: [cutId],
      allTargetsCommitted: false,
    });
    expect(database.query(`
      SELECT
        (SELECT COUNT(*) FROM chat_provider_thread_archive_targets_v57)
          AS targets,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_cuts_v57)
          AS cuts
    `).get()).toEqual({ targets: 2, cuts: 1 });
  });
});

test("v57 startup terminal sweep deletes exact pane transitions and preserves zero-target removal authority", () => {
  withV57Store(({
    store,
    journal,
    database,
    terminalPostimageAssertions,
  }) => {
    const componentCutId = "archcut_v57_sweep_component01";
    const component = finalizeV57ConnectedAppliedTargets({
      store,
      journal,
      database,
      cutId: componentCutId,
      targets: [{
        paneId: "pane_v57_sweep_archive01",
        suffix: "sweep_archive01",
      }, {
        paneId: "pane_v57_sweep_fresh01",
        suffix: "sweep_fresh01",
        purpose: "start_fresh",
      }],
    });
    const [paneArchive, startFresh] = component.targets;
    if (paneArchive === undefined || startFresh === undefined) {
      throw new Error("Expected both v57 startup transitions");
    }
    const targetIds = [paneArchive.targetId, startFresh.targetId].toSorted();
    const removalCutId = "archcut_v57_sweep_removal01";
    seedV57ContainedZeroTargetRemovalCut({
      journal,
      database,
      cutId: removalCutId,
    });

    const result = store.sweepProviderThreadArchiveTerminalAuthorityV57(
      targetIds,
    );
    expect(result.cleanup).toEqual({
      deletedTargetIds: targetIds,
      deletedCutIds: [componentCutId],
    });
    expect(result.recoveryInventory).toEqual({
      admissionDescriptors: [],
      activeCuts: [],
      removalAdmissionDescriptors: [],
      removalCuts: [],
      targets: [],
    });
    expect(database.query(`
      SELECT
        (SELECT COUNT(*) FROM chat_provider_thread_archive_targets_v57)
          AS targets,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_attempts_v57)
          AS attempts,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_cut_members_v57)
          AS members,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_cuts_v57
          WHERE cut_id = ?1 AND cause = 'account_removal'
            AND state = 'contained' AND target_count = 0) AS removal_cuts
    `).get(removalCutId)).toEqual({
      targets: 0,
      attempts: 0,
      members: 0,
      removal_cuts: 1,
    });

    const repeated = store.sweepProviderThreadArchiveTerminalAuthorityV57([]);
    expect(repeated.cleanup).toEqual({
      deletedTargetIds: [],
      deletedCutIds: [],
    });
    expect(repeated.recoveryInventory).toEqual(result.recoveryInventory);
    expect(terminalPostimageAssertions).toEqual([targetIds, []]);
    expect(journal.reopenCut(removalCutId)).toMatchObject({
      cause: "account_removal",
      state: "contained",
      targetCount: 0,
    });
  });
});

test("v57 startup terminal sweep fails closed when zero-target removal authority shares a component", () => {
  withV57Store(({ store, journal, database }) => {
    const componentCutId = "archcut_v57_sweep_zero_predecessor01";
    const component = finalizeV57ConnectedAppliedTargets({
      store,
      journal,
      database,
      cutId: componentCutId,
      targets: [{
        paneId: "pane_v57_sweep_zero_predecessor01",
        suffix: "sweep_zero_predecessor01",
      }],
    });
    const removalCutId = "archcut_v57_sweep_zero_successor01";
    seedV57ContainedZeroTargetRemovalCut({
      journal,
      database,
      cutId: removalCutId,
      accountProfileId: ACCOUNT,
      createAccountProfile: false,
      predecessorCutId: componentCutId,
    });
    const targetIds = component.targets.map(({ targetId }) => targetId);
    const bytesBefore = Uint8Array.from(database.serialize());

    expect(() => store.sweepProviderThreadArchiveTerminalAuthorityV57(
      targetIds,
    )).toThrow("zero-target account-removal authority");
    expect(Uint8Array.from(database.serialize())).toEqual(bytesBefore);
    expect(store.verifyProviderThreadArchiveTerminalAuthorityV57())
      .toEqual(targetIds);
    expect(journal.reopenCut(removalCutId)).toMatchObject({
      cause: "account_removal",
      state: "contained",
      targetCount: 0,
    });
  });
});

test("v57 startup terminal sweep rejects stale or noncanonical approval and Vault failure without deletion", () => {
  withV57Store(({
    store,
    database,
    terminalPostimageAssertions,
    terminalPostimageAssertionFailure,
  }) => {
    const [first, second] = finalizeV57IndependentDirectTargets({
      store,
      database,
      targets: [{
        paneId: "pane_v57_sweep_rejecta01",
        suffix: "sweep_rejecta01",
      }, {
        paneId: "pane_v57_sweep_rejectb01",
        suffix: "sweep_rejectb01",
      }],
    });
    if (first === undefined || second === undefined) {
      throw new Error("Expected two v57 rejection targets");
    }
    const targetIds = [first.targetId, second.targetId].toSorted();
    const bytesBefore = Uint8Array.from(database.serialize());

    expect(() => store.sweepProviderThreadArchiveTerminalAuthorityV57([
      targetIds[0]!,
    ])).toThrow("committed-target set changed");
    expect(() => store.sweepProviderThreadArchiveTerminalAuthorityV57([
      targetIds[0]!,
      targetIds[0]!,
    ])).toThrow("not canonical");
    expect(() => store.sweepProviderThreadArchiveTerminalAuthorityV57(
      [...targetIds].reverse(),
    )).toThrow("not canonical");
    terminalPostimageAssertionFailure.current = new Error(
      "injected Vault terminal postimage failure",
    );
    expect(() => store.sweepProviderThreadArchiveTerminalAuthorityV57(
      targetIds,
    )).toThrow("injected Vault terminal postimage failure");

    expect(Uint8Array.from(database.serialize())).toEqual(bytesBefore);
    expect(store.verifyProviderThreadArchiveTerminalAuthorityV57())
      .toEqual(targetIds);
    expect(terminalPostimageAssertions).toEqual([targetIds]);
  });
});

test("v57 startup terminal sweep remains subordinate to a caller outer rollback", () => {
  withV57Store(({ store, database }) => {
    const terminal = finalizeV57DirectTarget({
      store,
      database,
      paneId: "pane_v57_sweep_outerrollback01",
      suffix: "sweep_outerrollback01",
    });
    const bytesBefore = Uint8Array.from(database.serialize());
    expect(() => database.transaction(() => {
      expect(store.sweepProviderThreadArchiveTerminalAuthorityV57([
        terminal.targetId,
      ]).cleanup.deletedTargetIds).toEqual([terminal.targetId]);
      throw new Error("rollback outer v57 terminal sweep");
    })()).toThrow("rollback outer v57 terminal sweep");
    expect(Uint8Array.from(database.serialize())).toEqual(bytesBefore);
    expect(store.verifyProviderThreadArchiveTerminalAuthorityV57())
      .toEqual([terminal.targetId]);
  });
});

test("v57 lost-response coordination binds every effect, seals atomically, reconciles, and appends N plus one", () => {
  withV57Store(({ store, journal, database }) => {
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: PANE,
      suffix: "lost_cut_targeta01",
    });
    const secondPaneId = "pane_v57_lost_cut_targetb01";
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: secondPaneId,
      suffix: "lost_cut_targetb01",
    });
    const untargetedPaneId = "pane_v57_lost_cut_sibling01";
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: untargetedPaneId,
      suffix: "lost_cut_sibling01",
    });
    const first = v57TargetPreparationInput({
      store,
      paneId: PANE,
      suffix: "lost_cut_targeta01",
    });
    const second = v57TargetPreparationInput({
      store,
      paneId: secondPaneId,
      suffix: "lost_cut_targetb01",
    });
    store.prepareProviderThreadArchiveEffectStartedV57(first);
    store.prepareProviderThreadArchiveEffectStartedV57(second);
    const cutId = "archcut_v57_lost_coordination01";
    database.exec(`
      CREATE TEMP TRIGGER fail_second_v57_ambiguity
      BEFORE UPDATE OF state ON chat_provider_thread_archive_attempts_v57
      WHEN NEW.attempt_id = 'archattempt_v57_lost_cut_targetb01'
        AND NEW.state = 'ambiguous'
      BEGIN
        SELECT RAISE(ABORT, 'injected second ambiguity failure');
      END;
    `);
    expect(() => store.beginProviderThreadArchiveLostResponseCutV57({
      targetId: first.targetId,
      cutId,
      cause: "lost_response",
      now: NOW,
    })).toThrow("injected second ambiguity failure");
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_provider_thread_archive_cuts_v57
      WHERE cut_id = ?1
    `).get(cutId)).toEqual({ count: 0 });
    expect(journal.recoveryTargets().map((target) => ({
      targetId: target.targetId,
      state: target.currentAttempt.state,
      cutId: target.currentAttempt.cutId,
    }))).toEqual([
      { targetId: first.targetId, state: "effect_started", cutId: null },
      { targetId: second.targetId, state: "effect_started", cutId: null },
    ]);
    database.exec("DROP TRIGGER fail_second_v57_ambiguity");

    const begun = store.beginProviderThreadArchiveLostResponseCutV57({
      targetId: first.targetId,
      cutId,
      cause: "lost_response",
      now: NOW,
    });
    expect(begun).toMatchObject({
      cut: { cutId, state: "fence_started", targetCount: 2 },
      affectedTargetIds: [first.targetId, second.targetId].toSorted(),
    });
    expect(store.beginProviderThreadArchiveLostResponseCutV57({
      targetId: first.targetId,
      cutId,
      cause: "lost_response",
      now: new Date(NOW.getTime() + 1_000),
    })).toEqual(begun);
    expect(journal.recoveryTargets().map((target) =>
      target.currentAttempt.state
    )).toEqual(["ambiguous", "ambiguous"]);
    const untargetedBeforeFence = store.require(untargetedPaneId).projection;
    const untargetedAfterRename = store.rename(
      untargetedPaneId,
      untargetedBeforeFence.revision,
      "settled history stays outside generation fencing",
      NOW,
    );
    expect(untargetedAfterRename.title).toBe(
      "settled history stays outside generation fencing",
    );
    expect(store.providerThreadArchiveRecoveryPaneIdsV57()).toEqual(
      [PANE, secondPaneId].toSorted(),
    );

    const successorRevision = advanceV57AccountGeneration(database, 2);
    journal.recordFence({
      cutId,
      successorGeneration: 2,
      successorAccountProfileRevision: successorRevision,
      fenceEvidenceDigest: v57Digest("1"),
      fenceRevisionDigest: v57Digest("2"),
      now: NOW,
    });
    expect(store.enqueueMessage({
      paneId: untargetedPaneId,
      expectedQueueRevision: untargetedAfterRename.messageQueue.revision,
      messageId: "chatmsg_v57_fenced_sibling01",
      content: { text: "independent settled context", attachmentRefs: [] },
      now: NOW,
    }).messages).toHaveLength(1);
    database.exec(`
      CREATE TEMP TRIGGER fail_second_v57_member_insert
      BEFORE INSERT ON chat_provider_thread_archive_cut_members_v57
      WHEN NEW.cut_id = 'archcut_v57_lost_coordination01'
        AND NEW.ordinal = 2
      BEGIN
        SELECT RAISE(ABORT, 'injected second inventory member failure');
      END;
    `);
    expect(() => store.sealProviderThreadArchiveSourceInventoryV57({
      cutId,
      now: NOW,
    })).toThrow("injected second inventory member failure");
    expect(journal.reopenCut(cutId)).toMatchObject({
      state: "fenced",
      members: [],
    });
    database.exec("DROP TRIGGER fail_second_v57_member_insert");
    const sealed = store.sealProviderThreadArchiveSourceInventoryV57({
      cutId,
      now: NOW,
    });
    expect(sealed).toMatchObject({ state: "sealed", targetCount: 2 });
    expect(sealed.members).toHaveLength(2);
    expect(store.sealProviderThreadArchiveSourceInventoryV57({
      cutId,
      now: new Date(NOW.getTime() + 1_000),
    })).toEqual(sealed);
    for (const member of sealed.members) {
      store.settleProviderThreadArchiveMemberV57({
        memberId: member.memberId,
        now: NOW,
      });
    }

    database.exec(`
      CREATE TEMP TRIGGER fail_v57_cut_containment_marker
      BEFORE UPDATE OF state ON chat_provider_thread_archive_cuts_v57
      WHEN NEW.cut_id = 'archcut_v57_lost_coordination01'
        AND NEW.state = 'contained'
      BEGIN
        SELECT RAISE(ABORT, 'injected cut containment failure');
      END;
    `);
    expect(() => store.markProviderThreadArchiveCutContainedV57({
      cutId,
      now: NOW,
    })).toThrow("injected cut containment failure");
    expect(journal.reopenCut(cutId).state).toBe("sealed");
    database.exec("DROP TRIGGER fail_v57_cut_containment_marker");
    const contained = store.markProviderThreadArchiveCutContainedV57({
      cutId,
      now: NOW,
    });
    expect(contained.state).toBe("contained");
    expect(store.markProviderThreadArchiveCutContainedV57({
      cutId,
      now: new Date(NOW.getTime() + 1_000),
    })).toEqual(contained);

    const ambiguous = store.recordProviderThreadArchiveReconciliationV57({
      targetId: first.targetId,
      result: { disposition: "ambiguous" },
      now: NOW,
    });
    expect(ambiguous).toMatchObject({
      disposition: "ambiguous",
      descriptor: { attemptPhase: "ambiguous" },
    });
    expect(store.recordProviderThreadArchiveReconciliationV57({
      targetId: first.targetId,
      result: {
        disposition: "applied",
        responseGeneration: 2,
        responseStreamPosition: 23,
        providerContainmentReceipt: "provider-reconciled-applied-01",
      },
      now: NOW,
    })).toMatchObject({
      disposition: "applied",
      descriptor: { attemptPhase: "reconciled_applied" },
    });
    expect(store.finalizeProviderThreadArchiveTargetV57({
      targetId: first.targetId,
      now: NOW,
    })).toMatchObject({
      kind: "pane_archive",
      removed: { paneId: PANE },
    });
    const committedMember = sealed.members.find((member) =>
      member.paneId === PANE
    );
    if (committedMember === undefined) {
      throw new Error("Expected committed target member");
    }
    expect(store.settleProviderThreadArchiveMemberV57({
      memberId: committedMember.memberId,
      now: new Date(NOW.getTime() + 500),
    })).toMatchObject({
      member: { memberId: committedMember.memberId, state: "settled" },
      pane: null,
    });
    expect(new ChatPaneStore(database, {
      messageRequestDigestKey: V57_RECEIPT_KEY,
      paneArchiveAuthority: {
        assertPaneArchiveCompatible() {},
        assertProviderThreadArchiveV57Compatible() {},
        assertProviderThreadArchiveTerminalPostimagesV57() {},
        preparePaneArchiveInTransaction() {},
        markPaneArchivedInTransaction() {},
        releaseProviderBindingAfterResumeContainedInTransaction(): never {
          throw new Error("not used");
        },
      },
    }).verifyProviderThreadArchiveRecoveryV57().targets.map((target) =>
      target.targetId
    )).toEqual([second.targetId]);
    const notApplied = store.recordProviderThreadArchiveReconciliationV57({
      targetId: second.targetId,
      result: {
        disposition: "not_applied",
        providerReconciliationReceipt: "provider-reconciled-not-applied-01",
      },
      now: NOW,
    });
    expect(notApplied).toMatchObject({
      disposition: "not_applied",
      descriptor: { attemptPhase: "reconciled_not_applied" },
    });

    const successorAttemptId = "archattempt_v57_lost_successor02";
    database.exec(`
      CREATE TEMP TRIGGER fail_v57_successor_effect_start
      BEFORE UPDATE OF state ON chat_provider_thread_archive_attempts_v57
      WHEN NEW.attempt_id = 'archattempt_v57_lost_successor02'
        AND NEW.state = 'effect_started'
      BEGIN
        SELECT RAISE(ABORT, 'injected successor effect-start failure');
      END;
    `);
    expect(() => store.appendProviderThreadArchiveSuccessorEffectStartedV57({
      targetId: second.targetId,
      attemptId: successorAttemptId,
      now: NOW,
    })).toThrow("injected successor effect-start failure");
    expect(journal.reopenTarget(second.targetId)).toMatchObject({
      currentAttempt: {
        attemptId: second.attemptId,
        state: "reconciled_not_applied",
      },
      attempts: [expect.anything()],
    });
    database.exec("DROP TRIGGER fail_v57_successor_effect_start");
    const successor = store.appendProviderThreadArchiveSuccessorEffectStartedV57({
      targetId: second.targetId,
      attemptId: successorAttemptId,
      now: NOW,
    });
    expect(successor).toMatchObject({
      expectedGeneration: 2,
      attemptOrdinal: 2,
      attemptPhase: "effect_started",
      successorGeneration: null,
    });
    expect(store.appendProviderThreadArchiveSuccessorEffectStartedV57({
      targetId: second.targetId,
      attemptId: successorAttemptId,
      now: new Date(NOW.getTime() + 1_000),
    })).toEqual(successor);
    expect(new ChatPaneStore(database, {
      messageRequestDigestKey: V57_RECEIPT_KEY,
      paneArchiveAuthority: {
        assertPaneArchiveCompatible() {},
        assertProviderThreadArchiveV57Compatible() {},
        assertProviderThreadArchiveTerminalPostimagesV57() {},
        preparePaneArchiveInTransaction() {},
        markPaneArchivedInTransaction() {},
        releaseProviderBindingAfterResumeContainedInTransaction(): never {
          throw new Error("not used");
        },
      },
    }).verifyProviderThreadArchiveRecoveryV57().targets).toHaveLength(1);
  });
});

test("v57 successor waves are complete and a lost N plus one response seals against frozen target ownership", () => {
  withV57Store(({ store, journal, database }) => {
    const secondPaneId = "pane_v57_wave_targetb01";
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: PANE,
      suffix: "wave_targeta01",
    });
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: secondPaneId,
      suffix: "wave_targetb01",
    });
    const first = v57TargetPreparationInput({
      store,
      paneId: PANE,
      suffix: "wave_targeta01",
    });
    const second = v57TargetPreparationInput({
      store,
      paneId: secondPaneId,
      suffix: "wave_targetb01",
    });
    store.prepareProviderThreadArchiveEffectStartedV57(first);
    store.prepareProviderThreadArchiveEffectStartedV57(second);
    const firstCutId = "archcut_v57_wave_source01";
    store.beginProviderThreadArchiveLostResponseCutV57({
      targetId: first.targetId,
      cutId: firstCutId,
      cause: "lost_response",
      now: NOW,
    });
    const generationTwoRevision = advanceV57AccountGeneration(database, 2);
    journal.recordFence({
      cutId: firstCutId,
      successorGeneration: 2,
      successorAccountProfileRevision: generationTwoRevision,
      fenceEvidenceDigest: v57Digest("1"),
      fenceRevisionDigest: v57Digest("2"),
      now: NOW,
    });
    const firstCut = store.sealProviderThreadArchiveSourceInventoryV57({
      cutId: firstCutId,
      now: NOW,
    });
    for (const member of firstCut.members) {
      store.settleProviderThreadArchiveMemberV57({
        memberId: member.memberId,
        now: NOW,
      });
    }
    store.markProviderThreadArchiveCutContainedV57({
      cutId: firstCutId,
      now: NOW,
    });
    for (const targetId of [first.targetId, second.targetId]) {
      store.recordProviderThreadArchiveReconciliationV57({
        targetId,
        result: {
          disposition: "not_applied",
          providerReconciliationReceipt: `not applied ${targetId}`,
        },
        now: NOW,
      });
    }
    expect(() => store.assertProviderThreadArchiveSuccessorWaveReadyV57({
      cutId: firstCutId,
    })).toThrow("exact effect-started N plus one successor");
    expect(() => store.appendProviderThreadArchiveSuccessorEffectStartedV57({
      targetId: first.targetId,
      attemptId: "archattempt_v57_wave_successora02",
      now: NOW,
    })).toThrow("complete not-applied cohort");

    const attempts = [
      {
        targetId: first.targetId,
        attemptId: "archattempt_v57_wave_successora02",
      },
      {
        targetId: second.targetId,
        attemptId: "archattempt_v57_wave_successorb02",
      },
    ] as const;
    database.exec(`
      CREATE TEMP TRIGGER fail_second_v57_wave_effect
      BEFORE UPDATE OF state ON chat_provider_thread_archive_attempts_v57
      WHEN NEW.attempt_id = 'archattempt_v57_wave_successorb02'
        AND NEW.state = 'effect_started'
      BEGIN
        SELECT RAISE(ABORT, 'injected second wave effect failure');
      END;
    `);
    expect(() =>
      store.appendProviderThreadArchiveSuccessorWaveEffectStartedV57({
        cutId: firstCutId,
        attempts,
        now: NOW,
      })
    ).toThrow("injected second wave effect failure");
    expect(journal.reopenTarget(first.targetId).currentAttempt.state)
      .toBe("reconciled_not_applied");
    expect(journal.reopenTarget(second.targetId).currentAttempt.state)
      .toBe("reconciled_not_applied");
    database.exec("DROP TRIGGER fail_second_v57_wave_effect");

    const wave =
      store.appendProviderThreadArchiveSuccessorWaveEffectStartedV57({
        cutId: firstCutId,
        attempts: attempts.toReversed(),
        now: NOW,
      });
    expect(wave).toHaveLength(2);
    expect(wave.map((descriptor) => ({
      transitionId: descriptor.transitionId,
      expectedGeneration: descriptor.expectedGeneration,
      attemptPhase: descriptor.attemptPhase,
    }))).toEqual([
      {
        transitionId: first.targetId,
        expectedGeneration: 2,
        attemptPhase: "effect_started" as const,
      },
      {
        transitionId: second.targetId,
        expectedGeneration: 2,
        attemptPhase: "effect_started" as const,
      },
    ].toSorted((left, right) =>
      left.transitionId < right.transitionId ? -1 : 1
    ));
    expect(store.assertProviderThreadArchiveSuccessorWaveReadyV57({
      cutId: firstCutId,
    })).toEqual(wave);
    expect(store.appendProviderThreadArchiveSuccessorWaveEffectStartedV57({
      cutId: firstCutId,
      attempts,
      now: new Date(NOW.getTime() + 1_000),
    })).toEqual(wave);

    const directResults = [
      {
        targetId: first.targetId,
        responseGeneration: 2,
        responseStreamPosition: 41,
        providerContainmentReceipt: "wave-direct-containment-a",
      },
      {
        targetId: second.targetId,
        responseGeneration: 2,
        responseStreamPosition: 42,
        providerContainmentReceipt: "wave-direct-containment-b",
      },
    ] as const;
    expect(() => store.recordProviderThreadArchiveDirectAppliedCohortV57({
      cutId: firstCutId,
      results: directResults.slice(0, 1),
      now: NOW,
    })).toThrow("complete successor cohort");
    database.exec(`
      CREATE TEMP TRIGGER fail_second_v57_wave_direct_outcome
      BEFORE UPDATE OF state ON chat_provider_thread_archive_attempts_v57
      WHEN NEW.attempt_id = 'archattempt_v57_wave_successorb02'
        AND NEW.state = 'direct_applied'
      BEGIN
        SELECT RAISE(ABORT, 'injected second wave direct outcome failure');
      END;
    `);
    expect(() => store.recordProviderThreadArchiveDirectAppliedCohortV57({
      cutId: firstCutId,
      results: directResults.toReversed(),
      now: NOW,
    })).toThrow("injected second wave direct outcome failure");
    expect(journal.reopenTarget(first.targetId).currentAttempt.state)
      .toBe("effect_started");
    expect(journal.reopenTarget(second.targetId).currentAttempt.state)
      .toBe("effect_started");
    database.exec("DROP TRIGGER fail_second_v57_wave_direct_outcome");
    expect(() => database.transaction(() => {
      const recorded =
        store.recordProviderThreadArchiveDirectAppliedCohortV57({
          cutId: firstCutId,
          results: directResults,
          now: NOW,
        });
      expect(recorded.map((descriptor) => descriptor.attemptPhase))
        .toEqual(["direct_applied", "direct_applied"]);
      expect(store.recordProviderThreadArchiveDirectAppliedCohortV57({
        cutId: firstCutId,
        results: directResults.toReversed(),
        now: new Date(NOW.getTime() + 1_000),
      })).toEqual(recorded);
      throw new Error("rollback successful wave outcome fixture");
    })()).toThrow("rollback successful wave outcome fixture");
    expect(journal.reopenTarget(first.targetId).currentAttempt.state)
      .toBe("effect_started");
    expect(journal.reopenTarget(second.targetId).currentAttempt.state)
      .toBe("effect_started");

    const secondCutId = "archcut_v57_wave_retry_lost02";
    expect(store.beginProviderThreadArchiveLostResponseCutV57({
      targetId: first.targetId,
      cutId: secondCutId,
      cause: "lost_response",
      now: new Date(NOW.getTime() + 2_000),
    })).toMatchObject({
      cut: { sourceGeneration: 2, targetCount: 2 },
      affectedTargetIds: [first.targetId, second.targetId].toSorted(),
    });
    const generationThreeRevision = advanceV57AccountGeneration(database, 3);
    journal.recordFence({
      cutId: secondCutId,
      successorGeneration: 3,
      successorAccountProfileRevision: generationThreeRevision,
      fenceEvidenceDigest: v57Digest("3"),
      fenceRevisionDigest: v57Digest("4"),
      now: new Date(NOW.getTime() + 2_000),
    });
    const retryCut = store.sealProviderThreadArchiveSourceInventoryV57({
      cutId: secondCutId,
      now: new Date(NOW.getTime() + 2_000),
    });
    expect(retryCut).toMatchObject({
      sourceGeneration: 2,
      successorGeneration: 3,
      targetCount: 2,
      state: "sealed",
    });
    expect(retryCut.members).toHaveLength(2);
    expect(retryCut.members.every((member) => member.role === "target"))
      .toBeTrue();
    const predecessorMember = firstCut.members.find((member) =>
      member.paneId === PANE
    );
    const successorMember = retryCut.members.find((member) =>
      member.paneId === PANE
    );
    if (predecessorMember === undefined || successorMember === undefined) {
      throw new Error("Expected exact predecessor and successor target members");
    }

    // A successor member may pass only an already-settled predecessor that is
    // keyed to its exact target attempt lineage. A foreign pending member
    // that merely copies that target identity remains a quarantine boundary.
    database.exec(`
      CREATE TEMP TABLE v57_successor_foreign_cut AS
      SELECT * FROM chat_provider_thread_archive_cuts_v57
      WHERE cut_id = '${firstCutId}';
      UPDATE v57_successor_foreign_cut
      SET cut_id = 'archcut_v57_wave_foreign01';
      DROP TRIGGER chat_provider_thread_archive_cut_insert_guard_v57;
    `);
    database.query(`
      INSERT INTO chat_provider_thread_archive_cuts_v57
      SELECT * FROM v57_successor_foreign_cut
    `).run();
    database.exec(`
      CREATE TEMP TABLE v57_successor_foreign_member AS
      SELECT * FROM chat_provider_thread_archive_cut_members_v57
      WHERE member_id = '${predecessorMember.memberId}';
      UPDATE v57_successor_foreign_member
      SET member_id = 'archmember_v57_wave_foreign01',
        cut_id = 'archcut_v57_wave_foreign01', state = 'pending',
        settlement_evidence_digest = NULL, settlement_revision_digest = NULL,
        settled_at = NULL, settlement_hmac = NULL;
      DROP TRIGGER chat_provider_thread_archive_member_insert_guard_v57;
    `);
    database.query(`
      INSERT INTO chat_provider_thread_archive_cut_members_v57
      SELECT * FROM v57_successor_foreign_member
    `).run();
    expect(database.query(`
      SELECT cut_id FROM chat_provider_thread_archive_cuts_v57
      WHERE cut_id = 'archcut_v57_wave_foreign01'
    `).get()).toEqual({ cut_id: "archcut_v57_wave_foreign01" });
    expect(database.query(`
      SELECT member_id, cut_id, pane_id, target_id, attempt_id,
        target_attempt_ordinal, state
      FROM v57_successor_foreign_member
    `).get()).toMatchObject({
      cut_id: "archcut_v57_wave_foreign01",
      pane_id: PANE,
      target_id: first.targetId,
      state: "pending",
    });
    expect(database.query(`
      SELECT member_id, cut_id, pane_id, target_id, attempt_id,
        target_attempt_ordinal, state
      FROM chat_provider_thread_archive_cut_members_v57
      WHERE member_id = 'archmember_v57_wave_foreign01'
    `).get()).toMatchObject({
      cut_id: "archcut_v57_wave_foreign01",
      pane_id: PANE,
      target_id: first.targetId,
      state: "pending",
    });
    expect(() => store.settleProviderThreadArchiveMemberV57({
      memberId: successorMember.memberId,
      now: new Date(NOW.getTime() + 2_000),
    })).toThrow("v57 provider-context transition is pending");
    database.query(`
      DELETE FROM chat_provider_thread_archive_cut_members_v57
      WHERE member_id = 'archmember_v57_wave_foreign01'
    `).run();
    database.query(`
      DELETE FROM chat_provider_thread_archive_cuts_v57
      WHERE cut_id = 'archcut_v57_wave_foreign01'
    `).run();
    database.exec(`
      DROP TABLE v57_successor_foreign_member;
      DROP TABLE v57_successor_foreign_cut;
    `);

    // The authentic predecessor is an exact, settled target lineage, so both
    // members of the second cut can settle and contain normally.
    for (const member of retryCut.members) {
      expect(store.settleProviderThreadArchiveMemberV57({
        memberId: member.memberId,
        now: new Date(NOW.getTime() + 2_000),
      }).member).toMatchObject({ memberId: member.memberId, state: "settled" });
    }
    expect(store.markProviderThreadArchiveCutContainedV57({
      cutId: secondCutId,
      now: new Date(NOW.getTime() + 2_000),
    })).toMatchObject({ state: "contained" });
    expect(store.verifyProviderThreadArchiveRecoveryV57().targets)
      .toHaveLength(2);
  });
});

test("v57 preparation rejects stale CAS, wrong purpose, privacy, orphan custody, and generation drift without journal mutation", () => {
  withV57Store(({ store, journal, database, privacyBlockedPaneIds }) => {
    const stalePaneId = "pane_v57_stale_cas001";
    const stale = seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: stalePaneId,
      suffix: "stale_cas_01",
    });
    expect(() => store.prepareProviderThreadArchiveEffectStartedV57({
      targetId: "archtarget_v57_stale_cas_01",
      attemptId: "archattempt_v57_stale_cas_01",
      paneId: stalePaneId,
      purpose: "pane_archive",
      expectedRevision: stale.pane.projection.revision - 1,
      expectedQueueRevision: null,
      generation: 1,
      now: NOW,
    })).toThrow(expect.objectContaining({ code: "revision_conflict" }));

    const wrongPurposePaneId = "pane_v57_wrong_purpose1";
    const wrongPurpose = seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: wrongPurposePaneId,
      suffix: "wrong_purpose_01",
    });
    expect(() => store.prepareProviderThreadArchiveEffectStartedV57({
      targetId: "archtarget_v57_wrong_purpose_01",
      attemptId: "archattempt_v57_wrong_purpose_01",
      paneId: wrongPurposePaneId,
      purpose: "start_fresh",
      expectedRevision: wrongPurpose.pane.projection.revision,
      expectedQueueRevision:
        wrongPurpose.pane.projection.messageQueue.revision,
      generation: 1,
      now: NOW,
    })).toThrow("no quarantined provider context");

    const freshPaneId = "pane_v57_fresh_queue01";
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: freshPaneId,
      suffix: "fresh_queue_01",
    });
    database.query(`
      UPDATE chat_panes SET
        state = 'attention', attention_code = 'runtime_unavailable',
        attention_message = 'Choose Start fresh.', attention_retryable = 0,
        provider_context_reset_required = 1,
        message_queue_pause_reason = 'attention',
        message_queue_revision = message_queue_revision + 1,
        revision = revision + 1
      WHERE pane_id = ?1
    `).run(freshPaneId);
    const fresh = store.require(freshPaneId).projection;
    expect(() => store.prepareProviderThreadArchiveEffectStartedV57({
      targetId: "archtarget_v57_fresh_queue_01",
      attemptId: "archattempt_v57_fresh_queue_01",
      paneId: freshPaneId,
      purpose: "start_fresh",
      expectedRevision: fresh.revision,
      expectedQueueRevision: fresh.messageQueue.revision - 1,
      generation: 1,
      now: NOW,
    })).toThrow(expect.objectContaining({ code: "revision_conflict" }));

    const privacyPaneId = "pane_v57_privacy_block1";
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: privacyPaneId,
      suffix: "privacy_block_01",
    });
    privacyBlockedPaneIds.add(privacyPaneId);
    expect(() => prepareV57Target({
      store,
      paneId: privacyPaneId,
      suffix: "privacy_block_01",
    })).toThrow("fixture attachment privacy transition is pending");

    const orphanPaneId = "pane_v57_orphan_binding1";
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: orphanPaneId,
      suffix: "orphan_binding_01",
    });
    database.query(`
      INSERT INTO chat_provider_attachment_bindings (
        binding_id, binding_key_digest, pane_id, revision, state,
        acquired_at, updated_at
      ) VALUES (?1, ?2, ?3, 1, 'active', ?4, ?4)
    `).run(
      "attbinding_v57_orphan01",
      v57Digest("f"),
      orphanPaneId,
      NOW.toISOString(),
    );
    expect(() => prepareV57Target({
      store,
      paneId: orphanPaneId,
      suffix: "orphan_binding_01",
    })).toThrow("Attachment custody no longer matches");

    const generationPaneId = "pane_v57_generation001";
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: generationPaneId,
      suffix: "generation_01",
    });
    database.query(`
      UPDATE account_profiles SET process_generation = 2,
        revision = revision + 1, updated_at = ?2 WHERE profile_id = ?1
    `).run(ACCOUNT, NOW.toISOString());
    expect(() => prepareV57Target({
      store,
      paneId: generationPaneId,
      suffix: "generation_01",
      generation: 1,
    })).toThrow("account generation changed");
    expect(journal.recoveryTargets()).toEqual([]);
  });
});

test("v57 target preparation preflights only live ordinary source-generation siblings", () => {
  withV57Store(({ store, journal, database }) => {
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: PANE,
      suffix: "sibling_legacy_target01",
    });
    const siblingPaneId = "pane_v57_sibling_legacy01";
    const sibling = seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: siblingPaneId,
      suffix: "sibling_legacy01",
      ownership: "effectStarted",
    });
    store.prepareProviderThreadArchiveIntent({
      paneId: siblingPaneId,
      purpose: "pane_archive",
      expectedRevision: sibling.pane.projection.revision,
      expectedQueueRevision: null,
      binding: sibling.binding,
      generation: 1,
      now: NOW,
    });
    database.query(`
      UPDATE chat_provider_thread_archive_intents SET
        state = 'account_contained', generation_contained = 1,
        generation_containment_receipt = 'legacy_sibling_containment_receipt'
      WHERE pane_id = ?1
    `).run(siblingPaneId);
    expect(() => prepareV57Target({
      store,
      paneId: PANE,
      suffix: "sibling_legacy_target01",
    })).toThrow("legacy provider-context transition");
    expect(journal.recoveryTargets()).toEqual([]);
  });

  withV57Store(({ store, journal, database, privacyBlockedPaneIds }) => {
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: PANE,
      suffix: "sibling_privacy_target01",
    });
    const siblingPaneId = "pane_v57_sibling_privacy1";
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: siblingPaneId,
      suffix: "sibling_privacy01",
      ownership: "effectStarted",
    });
    privacyBlockedPaneIds.add(siblingPaneId);
    expect(() => prepareV57Target({
      store,
      paneId: PANE,
      suffix: "sibling_privacy_target01",
    })).toThrow("fixture attachment privacy transition is pending");
    expect(journal.recoveryTargets()).toEqual([]);
  });

  withV57Store(({ store, journal, database }) => {
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: PANE,
      suffix: "sibling_orphan_target01",
    });
    const siblingPaneId = "pane_v57_sibling_orphan01";
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: siblingPaneId,
      suffix: "sibling_orphan01",
      ownership: "effectStarted",
    });
    database.query(`
      INSERT INTO chat_provider_attachment_bindings (
        binding_id, binding_key_digest, pane_id, revision, state,
        acquired_at, updated_at
      ) VALUES (?1, ?2, ?3, 1, 'active', ?4, ?4)
    `).run(
      "attbinding_v57_sibling_orphan01",
      v57Digest("f"),
      siblingPaneId,
      NOW.toISOString(),
    );
    expect(() => prepareV57Target({
      store,
      paneId: PANE,
      suffix: "sibling_orphan_target01",
    })).toThrow("Attachment custody no longer matches");
    expect(journal.recoveryTargets()).toEqual([]);
  });

  withV57Store(({ store, journal, database }) => {
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: PANE,
      suffix: "sibling_queue_target01",
    });
    const siblingPaneId = "pane_v57_sibling_queue01";
    const sibling = seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: siblingPaneId,
      suffix: "sibling_queue01",
    });
    const queue = store.enqueueMessage({
      paneId: siblingPaneId,
      expectedQueueRevision: sibling.pane.projection.messageQueue.revision,
      messageId: "chatmsg_v57_sibling_queue01",
      content: { text: "unresolved source effect", attachmentRefs: [] },
      now: NOW,
    });
    const message = queue.messages[0];
    if (message === undefined) throw new Error("Expected sibling queue row");
    database.query(`
      UPDATE chat_message_ledger SET state = 'start_claimed',
        claimed_turn_id = ?2, revision = revision + 1, updated_at = ?3
      WHERE message_id = ?1
    `).run(message.id, sibling.turnId, NOW.toISOString());
    database.query(`
      UPDATE chat_message_ledger SET state = 'start_effect_started',
        effect_started_at = ?2, revision = revision + 1, updated_at = ?2
      WHERE message_id = ?1
    `).run(message.id, NOW.toISOString());
    expect(() => prepareV57Target({
      store,
      paneId: PANE,
      suffix: "sibling_queue_target01",
    })).toThrow("Contain the in-flight or ambiguous message effect");
    expect(journal.recoveryTargets()).toEqual([]);
  });
});

test("v57 preparation fences unresolved queue effects and conflicting v56 or v57 targets", () => {
  withV57Store(({ store, journal, database }) => {
    const queuePaneId = "pane_v57_queue_block001";
    const created = createPane(store, queuePaneId);
    const queued = store.enqueueMessage({
      paneId: queuePaneId,
      expectedQueueRevision: created.messageQueue.revision,
      messageId: "chatmsg_v57_queue_block001",
      content: { text: "Hold this queue effect.", attachmentRefs: [] },
      now: NOW,
    });
    const message = queued.messages[0];
    if (message === undefined) throw new Error("Expected v57 queue message");
    const turnId = "chatturn_v57_queue_block001";
    const claim = store.claimHeadMessageAndBeginTurn({
      paneId: queuePaneId,
      expectedQueueRevision: queued.revision,
      expectedMessageRevision: message.revision,
      messageId: message.id,
      turnId,
      now: NOW,
    }).claim;
    store.reserveAccount(queuePaneId, turnId, ACCOUNT, NOW);
    const routing = new RootTurnRoutingSQLiteAuthorityV1(database);
    const classified = routing.readTurnRouting(queuePaneId, turnId);
    if (classified === null) throw new Error("Expected queue route");
    routing.resolve({
      paneId: queuePaneId,
      chatTurnId: turnId,
      selectedProfile: classified.requestedProfile,
      profileFallbackReason: null,
      selectedServiceTier: classified.requestedServiceTier,
      serviceTierFallbackReason: null,
      catalogGeneration: 1,
      catalogDigest: V57_CATALOG_DIGEST,
      now: NOW,
    });
    const binding = {
      accountProfileId: ACCOUNT,
      threadId: "thread_v57_queue_block001",
      restartThreadId: "raw_thread_v57_queue_block001",
    } as const;
    store.prepareProviderThread(queuePaneId, turnId, binding, NOW);
    routing.markEffectStarted({ paneId: queuePaneId, chatTurnId: turnId, now: NOW });
    store.markMessageEffectStarted({
      paneId: queuePaneId,
      messageId: message.id,
      expectedMessageRevision: claim.revision,
      turnId,
      kind: "start",
      now: NOW,
    });
    store.enterAttention({
      paneId: queuePaneId,
      turnId,
      attention: { code: "turn_failed", message: "Contain it.", retryable: false },
      clearBinding: false,
      now: NOW,
    });
    expect(() => prepareV57Target({
      store,
      paneId: queuePaneId,
      suffix: "queue_block_01",
    })).toThrow("Contain the in-flight or ambiguous message effect");
    database.query(`
      UPDATE chat_panes SET provider_account_profile_id = NULL,
        provider_thread_id = NULL, provider_restart_thread_id = NULL
      WHERE pane_id = ?1
    `).run(queuePaneId);

    const legacyPaneId = "pane_v57_legacy_block01";
    const legacy = seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: legacyPaneId,
      suffix: "legacy_block_01",
    });
    database.query(`
      INSERT INTO chat_provider_thread_archive_intents (
        pane_id, purpose, state, pane_revision, queue_revision,
        account_profile_id, thread_id, restart_thread_id,
        generation, generation_contained, effect_attempt, created_at, updated_at
      ) VALUES (?1, 'pane_archive', 'prepared', ?2, NULL, ?3, ?4, ?5,
        1, 0, 0, ?6, ?6)
    `).run(
      legacyPaneId,
      legacy.pane.projection.revision,
      ACCOUNT,
      legacy.binding.threadId,
      legacy.binding.restartThreadId,
      NOW.toISOString(),
    );
    expect(() => prepareV57Target({
      store,
      paneId: legacyPaneId,
      suffix: "legacy_block_01",
    })).toThrow("legacy provider-context transition");
    database.query(`
      DELETE FROM chat_provider_thread_archive_intents WHERE pane_id = ?1
    `).run(legacyPaneId);
    database.query(`
      UPDATE chat_panes SET provider_account_profile_id = NULL,
        provider_thread_id = NULL, provider_restart_thread_id = NULL
      WHERE pane_id = ?1
    `).run(legacyPaneId);

    const v57PaneId = "pane_v57_duplicate_open1";
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: v57PaneId,
      suffix: "duplicate_open_01",
    });
    prepareV57Target({
      store,
      paneId: v57PaneId,
      suffix: "duplicate_open_01",
    });
    const pane = store.require(v57PaneId).projection;
    expect(() => store.prepareProviderThreadArchiveEffectStartedV57({
      targetId: "archtarget_v57_duplicate_open_02",
      attemptId: "archattempt_v57_duplicate_open_02",
      paneId: v57PaneId,
      purpose: "pane_archive",
      expectedRevision: pane.revision,
      expectedQueueRevision: null,
      generation: 1,
      now: NOW,
    })).toThrow("Another durable provider-thread archive target");
    expect(journal.recoveryTargets()).toHaveLength(1);
  });
});

test("every uncommitted v57 target fences ordinary admission and mutation across reopen", () => {
  withV57Store(({ store, journal, database }) => {
    const fixture = seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: PANE,
      suffix: "mutation_fence01",
    });
    const input = v57TargetPreparationInput({
      store,
      paneId: PANE,
      suffix: "mutation_fence01",
    });
    store.prepareProviderThreadArchiveEffectStartedV57(input);
    const reopened = new ChatPaneStore(database, {
      messageRequestDigestKey: V57_RECEIPT_KEY,
      paneArchiveAuthority: {
        assertPaneArchiveCompatible() {},
        assertProviderThreadArchiveV57Compatible() {},
        assertProviderThreadArchiveTerminalPostimagesV57() {},
        preparePaneArchiveInTransaction() {},
        markPaneArchivedInTransaction() {},
        releaseProviderBindingAfterResumeContainedInTransaction(): never {
          throw new Error("not used");
        },
      },
    });
    const before = reopened.require(PANE).projection;
    const assertFenced = (run: () => unknown): void => {
      expect(run).toThrow("only its exact recovery");
    };
    assertFenced(() => reopened.rename(PANE, before.revision, "blocked", NOW));
    assertFenced(() => reopened.enqueueMessage({
      paneId: PANE,
      expectedQueueRevision: before.messageQueue.revision,
      messageId: "chatmsg_v57_mutation_fence01",
      content: { text: "must remain frozen", attachmentRefs: [] },
      now: NOW,
    }));
    assertFenced(() => reopened.selectRepository(
      PANE,
      before.revision,
      { id: REPOSITORY_TWO, name: "Other", workingDirectory: "/fixture/other" },
      NOW,
    ));
    assertFenced(() => reopened.preflightPaneArchive({
      paneId: PANE,
      expectedRevision: before.revision,
    }));
    assertFenced(() => reopened.preflightStartFreshProviderContext({
      paneId: PANE,
      expectedRevision: before.revision,
      expectedQueueRevision: before.messageQueue.revision,
    }));
    assertFenced(() => reopened.prepareProviderThreadArchiveIntent({
      paneId: PANE,
      purpose: "pane_archive",
      expectedRevision: before.revision,
      expectedQueueRevision: null,
      binding: fixture.binding,
      generation: 1,
      now: NOW,
    }));
    assertFenced(() => reopened.remove(PANE, before.revision, NOW));
    assertFenced(() => reopened.detachUnavailableAccount(
      PANE,
      ACCOUNT,
      NOW,
    ));
    assertFenced(() => reopened.handoffHistory(PANE, true));
    assertFenced(() => reopened.reorder([PANE], [PANE]));
    assertFenced(() => database.transaction(() =>
      reopened.assertProviderThreadArchivePaneMutationAllowedV57(PANE)
    )());
    expect(reopened.require(PANE).projection).toEqual(before);
    expect(journal.reopenTarget(input.targetId).currentAttempt.state)
      .toBe("effect_started");
  });
});

test("v57 recovery reopens every target and fails closed on restart or queue preimage drift", () => {
  withV57Store(({ store, journal, database }) => {
    const fixture = seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: PANE,
      suffix: "recovery_preimage_01",
    });
    const target = prepareV57Target({
      store,
      paneId: PANE,
      suffix: "recovery_preimage_01",
    });
    expect(store.verifyProviderThreadArchiveRecoveryV57().targets)
      .toEqual([target]);

    database.query(`
      UPDATE chat_panes SET provider_restart_thread_id = ?2
      WHERE pane_id = ?1
    `).run(PANE, "raw_thread_v57_recovery_preimage_drift");
    expect(() => store.verifyProviderThreadArchiveRecoveryV57())
      .toThrow("target preimage does not match");
    database.query(`
      UPDATE chat_panes SET provider_restart_thread_id = ?2
      WHERE pane_id = ?1
    `).run(PANE, fixture.binding.restartThreadId);
    expect(store.verifyProviderThreadArchiveRecoveryV57().targets)
      .toEqual([target]);

    database.query(`
      UPDATE chat_panes SET message_queue_revision = message_queue_revision + 1
      WHERE pane_id = ?1
    `).run(PANE);
    expect(() => store.verifyProviderThreadArchiveRecoveryV57())
      .toThrow("target preimage does not match");
    expect(journal.recoveryTargets()).toEqual([target]);
  });
});

test("v57 source enumeration is complete, keyed, generation-exact, and ordinary-only", () => {
  withV57Store(({ store, journal, database }) => {
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: PANE,
      suffix: "inventory_target_01",
    });
    const siblingPaneId = "pane_v57_inventory_sib1";
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: siblingPaneId,
      suffix: "inventory_sibling_01",
      ownership: "effectStarted",
    });
    const newerPaneId = "pane_v57_inventory_gen2";
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: newerPaneId,
      suffix: "inventory_generation_02",
      generation: 2,
    });
    const target = prepareV57Target({
      store,
      paneId: PANE,
      suffix: "inventory_target_01",
    });
    const cut = store.beginProviderThreadArchiveLostResponseCutV57({
      targetId: target.targetId,
      cutId: "archcut_v57_inventory01",
      cause: "ambiguous_response",
      now: NOW,
    }).cut;
    expect(cut.targetCount).toBe(1);
    database.query(`
      UPDATE account_profiles SET process_generation = 2,
        revision = 2, updated_at = ?2 WHERE profile_id = ?1
    `).run(ACCOUNT, NOW.toISOString());
    journal.recordFence({
      cutId: cut.cutId,
      successorGeneration: 2,
      successorAccountProfileRevision: 2,
      fenceEvidenceDigest: v57Digest("a"),
      fenceRevisionDigest: v57Digest("b"),
      now: NOW,
    });
    const beforeCounts = database.query(`
      SELECT
        (SELECT COUNT(*) FROM chat_provider_thread_archive_cut_members_v57)
          AS members,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_targets_v57)
          AS targets
    `).get();
    const enumeration = store.enumerateProviderThreadArchiveSourceOwnershipV57({
      cutId: cut.cutId,
      accountProfileId: ACCOUNT,
      sourceGeneration: 1,
      now: NOW,
    });
    expect(enumeration).toMatchObject({
      accountProfileId: ACCOUNT,
      sourceGeneration: 1,
      expectedMemberCount: 2,
    });
    expect(enumeration.expectedInventoryDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(enumeration.enumerationAuthorityDigest).toMatch(/^[0-9a-f]{64}$/u);
    const expectedMembers = ([
      {
        paneId: PANE,
        role: "target",
        action: "preserved_target",
        binding: "none",
      },
      {
        paneId: siblingPaneId,
        role: "sibling",
        action: "detach_binding_only",
        binding: "none",
      },
    ] as const).toSorted((left, right) =>
      left.paneId < right.paneId ? -1 : 1
    );
    expect(enumeration.members.map((member) => ({
      paneId: member.paneId,
      role: member.role,
      action: member.action,
      binding: member.binding.kind,
    }))).toEqual(expectedMembers);
    expect(enumeration.members.some((member) =>
      member.paneId === newerPaneId
    )).toBeFalse();
    expect(database.query(`
      SELECT
        (SELECT COUNT(*) FROM chat_provider_thread_archive_cut_members_v57)
          AS members,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_targets_v57)
          AS targets
    `).get()).toEqual(beforeCounts);
    expect(store.enumerateProviderThreadArchiveSourceOwnershipV57({
      cutId: cut.cutId,
      accountProfileId: ACCOUNT,
      sourceGeneration: 1,
      now: new Date(NOW.getTime() + 1_000),
    })).toMatchObject({
      expectedMemberCount: enumeration.expectedMemberCount,
      expectedInventoryDigest: enumeration.expectedInventoryDigest,
      enumerationAuthorityDigest: enumeration.enumerationAuthorityDigest,
    });

    store.sealProviderThreadArchiveSourceInventoryV57({
      cutId: cut.cutId,
      now: NOW,
    });
    const recovery = store.verifyProviderThreadArchiveRecoveryV57();
    expect(recovery.targets).toHaveLength(1);
    expect(recovery.activeCuts[0]?.members).toHaveLength(2);
  });
});

test("v57 source preflight rejects an ambiguous resolution whose exact turn identity drifted", () => {
  withV57Store(({ store, journal, database }) => {
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: PANE,
      suffix: "ambiguous_join_target01",
    });
    const siblingPaneId = "pane_v57_ambiguous_join_sib1";
    const sibling = seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: siblingPaneId,
      suffix: "ambiguous_join_sibling01",
    });
    const effect = insertV57AmbiguousMessageEffect(
      database,
      siblingPaneId,
      "ambiguous_join_sibling01",
      sibling.turnId,
    );
    resolveV57AmbiguousMessageEffect(database, siblingPaneId, effect);
    database.query(`
      UPDATE chat_message_ledger SET claimed_turn_id = ?2,
        revision = revision + 1, updated_at = ?3
      WHERE message_id = ?1 AND state = 'ambiguous'
    `).run(
      effect.messageId,
      "chatturn_v57_ambiguous_join_wrong1",
      new Date(NOW.getTime() + 3).toISOString(),
    );
    expect(() => prepareV57Target({
      store,
      paneId: PANE,
      suffix: "ambiguous_join_target01",
    })).toThrow("Contain the in-flight or ambiguous message effect");
    expect(journal.recoveryTargets()).toEqual([]);
  });
});

test("pending v57 cut members fence ordinary mutation and every pre-effect claim transition", () => {
  withV57Store(({ store, journal, database }) => {
    const fixture = sealV57MemberFixture({
      store,
      journal,
      database,
      suffix: "member_fence_start01",
      claim: "start_claimed",
    });
    if (fixture.message === null) throw new Error("Expected frozen start claim");
    const before = store.require(fixture.siblingMember.paneId).projection;
    const assertFenced = (operation: () => unknown) => {
      expect(operation).toThrow("v57 provider-context transition is pending");
    };
    assertFenced(() => store.rename(
      fixture.siblingMember.paneId,
      before.revision,
      "must remain frozen",
      NOW,
    ));
    assertFenced(() => store.returnClaimedMessageToQueue({
      paneId: fixture.siblingMember.paneId,
      messageId: fixture.message!.messageId,
      expectedMessageRevision: fixture.message!.revision,
      turnId: fixture.message!.turnId,
      kind: "start",
      now: NOW,
    }));
    assertFenced(() => store.markMessageEffectStarted({
      paneId: fixture.siblingMember.paneId,
      messageId: fixture.message!.messageId,
      expectedMessageRevision: fixture.message!.revision,
      turnId: fixture.message!.turnId,
      kind: "start",
      now: NOW,
    }));
    expect(database.query(`
      SELECT state, revision FROM chat_message_ledger WHERE message_id = ?1
    `).get(fixture.message.messageId)).toEqual({
      state: "start_claimed",
      revision: fixture.message.revision,
    });
  });

  withV57Store(({ store, journal, database }) => {
    const fixture = sealV57MemberFixture({
      store,
      journal,
      database,
      suffix: "member_fence_steer01",
      claim: "steer_prepared",
    });
    if (fixture.message === null) throw new Error("Expected frozen steer claim");
    expect(() => store.cancelPreparedSteerMessage({
      paneId: fixture.siblingMember.paneId,
      messageId: fixture.message!.messageId,
      expectedMessageRevision: fixture.message!.revision,
      turnId: fixture.message!.turnId,
      kind: "steer",
      now: NOW,
    })).toThrow("v57 provider-context transition is pending");
    expect(database.query(`
      SELECT state, revision FROM chat_message_ledger WHERE message_id = ?1
    `).get(fixture.message.messageId)).toEqual({
      state: "steer_prepared",
      revision: fixture.message.revision,
    });
  });
});

test("v57 member settlement contains local effects and records the journal marker last", () => {
  withV57Store(({ store, journal, database }) => {
    const fixture = sealV57MemberFixture({
      store,
      journal,
      database,
      suffix: "member_settle_exact01",
      exactBinding: true,
      claim: "start_claimed",
    });
    if (fixture.message === null) throw new Error("Expected settlement claim");
    database.exec(`
      CREATE TEMP TRIGGER v57_member_marker_must_be_last
      BEFORE UPDATE OF state ON chat_provider_thread_archive_cut_members_v57
      WHEN NEW.state = 'settled' AND (
        EXISTS (
          SELECT 1 FROM chat_panes AS pane
          WHERE pane.pane_id = NEW.pane_id AND (
            pane.provider_account_profile_id IS NOT NULL
            OR pane.provider_thread_id IS NOT NULL
            OR pane.provider_restart_thread_id IS NOT NULL
            OR pane.provider_context_reset_required != 1
          )
        )
        OR EXISTS (
          SELECT 1 FROM harness_root_turn_routing_receipts AS route
          WHERE route.pane_id = NEW.pane_id AND route.settled_at IS NULL
        )
        OR EXISTS (
          SELECT 1 FROM chat_message_ledger AS message
          WHERE message.pane_id = NEW.pane_id AND message.state IN (
            'start_claimed', 'steer_prepared',
            'start_effect_started', 'steer_effect_started',
            'start_acknowledged', 'steer_acknowledged'
          )
        )
        OR EXISTS (
          SELECT 1 FROM chat_attachment_turn_leases AS lease
          WHERE lease.pane_id = NEW.pane_id AND lease.state != 'released'
        )
        OR EXISTS (
          SELECT 1 FROM chat_provider_attachment_bindings AS binding
          WHERE binding.pane_id = NEW.pane_id
            AND binding.state IN ('active', 'ambiguous')
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'v57 member journal marker was not last');
      END;
    `);
    const settled = store.settleProviderThreadArchiveMemberV57({
      memberId: fixture.siblingMember.memberId,
      now: NOW,
    });
    expect(settled).toMatchObject({
      member: { memberId: fixture.siblingMember.memberId, state: "settled" },
      pane: {
        id: fixture.siblingMember.paneId,
        state: "attention",
        attention: { code: "runtime_unavailable", retryable: false },
      },
    });
    expect(store.require(fixture.siblingMember.paneId)).toMatchObject({
      binding: null,
      providerContextResetRequired: true,
    });
    expect(database.query(`
      SELECT state, claimed_turn_id FROM chat_message_ledger
      WHERE message_id = ?1
    `).get(fixture.message.messageId)).toEqual({
      state: "queued",
      claimed_turn_id: null,
    });
    expect(new RootTurnRoutingSQLiteAuthorityV1(database).readTurnRouting(
      fixture.siblingMember.paneId,
      fixture.sibling.turnId,
    )).toMatchObject({ state: "ambiguous", operationalOutcome: "ambiguous" });
    expect(database.query(`
      SELECT state, revision FROM chat_provider_attachment_bindings
      WHERE pane_id = ?1
    `).get(fixture.siblingMember.paneId)).toEqual({
      state: "released",
      revision: 2,
    });
    const recoveredCut = store.verifyProviderThreadArchiveRecoveryV57()
      .activeCuts[0];
    expect(recoveredCut?.cutId).toBe(fixture.cutId);
    expect(recoveredCut?.members.find((member) =>
      member.memberId === fixture.siblingMember.memberId
    )).toMatchObject({
      memberId: fixture.siblingMember.memberId,
      state: "settled",
    });
    for (const assignment of [
      "archived_at = '2026-08-09T01:00:00.000Z'",
      "state = 'ready'",
      "active_prompt = 'drift'",
      "active_provider_turn_id = 'turn_v57_postimage_drift01'",
      "provider_context_reset_required = 0",
      "attention_code = NULL",
      "attention_message = 'drift'",
      "attention_retryable = 1",
      "message_queue_pause_reason = NULL",
      "account_profile_id = NULL",
    ]) {
      expect(() => database.transaction(() => {
        database.query(`
          UPDATE chat_panes SET ${assignment} WHERE pane_id = ?1
        `).run(fixture.siblingMember.paneId);
        store.verifyProviderThreadArchiveRecoveryV57();
      })()).toThrow();
    }
    expect(() => database.transaction(() => {
      database.query(`
        UPDATE chat_panes SET title = title || ' drift', revision = revision + 1
        WHERE pane_id = ?1
      `).run(fixture.siblingMember.paneId);
      store.verifyProviderThreadArchiveRecoveryV57();
    })()).toThrow("detached postimage");
    expect(() => database.transaction(() => {
      database.query(`
        UPDATE chat_panes SET message_queue_revision = message_queue_revision + 1
        WHERE pane_id = ?1
      `).run(fixture.siblingMember.paneId);
      store.verifyProviderThreadArchiveRecoveryV57();
    })()).toThrow("local settlement evidence");
    expect(store.providerThreadArchiveRecoveryPaneIdsV57()).toEqual(
      [PANE, fixture.siblingMember.paneId].toSorted(),
    );
    const settledPane = settled.pane;
    if (settledPane === null) {
      throw new Error("Expected live detached sibling projection");
    }
    expect(() => store.rename(
      fixture.siblingMember.paneId,
      settledPane.revision,
      "still quarantined",
      NOW,
    )).toThrow("v57 provider-context transition is pending");
    expect(store.settleProviderThreadArchiveMemberV57({
      memberId: fixture.siblingMember.memberId,
      now: NOW,
    })).toEqual(settled);
  });
});

test("v57 member settlement rejects foreign sealed authority before local mutation", () => {
  withV57Store(({ store, journal, database }) => {
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: PANE,
      suffix: "foreign_seal_target01",
    });
    const siblingPaneId = "pane_v57_foreign_seal_sibling1";
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: siblingPaneId,
      suffix: "foreign_seal_sibling01",
      ownership: "effectStarted",
    });
    const target = prepareV57Target({
      store,
      paneId: PANE,
      suffix: "foreign_seal_target01",
    });
    const cutId = "archcut_v57_foreign_seal01";
    store.beginProviderThreadArchiveLostResponseCutV57({
      targetId: target.targetId,
      cutId,
      cause: "lost_response",
      now: NOW,
    });
    const successorRevision = advanceV57AccountGeneration(database, 2);
    journal.recordFence({
      cutId,
      successorGeneration: 2,
      successorAccountProfileRevision: successorRevision,
      fenceEvidenceDigest: v57Digest("1"),
      fenceRevisionDigest: v57Digest("2"),
      now: NOW,
    });
    const inventory = store.enumerateProviderThreadArchiveSourceOwnershipV57({
      cutId,
      accountProfileId: ACCOUNT,
      sourceGeneration: 1,
      now: NOW,
    });
    for (const member of inventory.members) journal.addCutMember(member);
    journal.sealCutInventory({
      cutId,
      expectedMemberCount: inventory.expectedMemberCount,
      expectedInventoryDigest: inventory.expectedInventoryDigest,
      enumerationAuthorityDigest: v57Digest("3"),
      sealRevisionDigest: v57Digest("4"),
      now: NOW,
    });
    const siblingMember = journal.reopenCut(cutId).members.find((member) =>
      member.paneId === siblingPaneId
    );
    if (siblingMember === undefined) {
      throw new Error("Expected foreign-seal sibling member");
    }
    const paneBefore = database.query(`
      SELECT * FROM chat_panes WHERE pane_id = ?1
    `).get(siblingPaneId);

    expect(() => store.settleProviderThreadArchiveMemberV57({
      memberId: siblingMember.memberId,
      now: NOW,
    })).toThrow("exact store-owned sealed inventory authority");
    expect(database.query(`
      SELECT * FROM chat_panes WHERE pane_id = ?1
    `).get(siblingPaneId)).toEqual(paneBefore);
    expect(journal.reopenCut(cutId).members.find((member) =>
      member.memberId === siblingMember.memberId
    )?.state).toBe("pending");
  });
});

test("v57 member settlement rolls back every local containment write when the final marker fails", () => {
  withV57Store(({ store, journal, database }) => {
    const fixture = sealV57MemberFixture({
      store,
      journal,
      database,
      suffix: "member_settle_rollback01",
      exactBinding: true,
      claim: "start_claimed",
    });
    if (fixture.message === null) throw new Error("Expected rollback claim");
    const before = {
      pane: database.query(`SELECT * FROM chat_panes WHERE pane_id = ?1`)
        .get(fixture.siblingMember.paneId),
      message: database.query(`
        SELECT * FROM chat_message_ledger WHERE message_id = ?1
      `).get(fixture.message.messageId),
      route: database.query(`
        SELECT * FROM harness_root_turn_routing_receipts
        WHERE pane_id = ?1 AND chat_turn_id = ?2
      `).get(fixture.siblingMember.paneId, fixture.sibling.turnId),
      binding: database.query(`
        SELECT * FROM chat_provider_attachment_bindings WHERE pane_id = ?1
      `).get(fixture.siblingMember.paneId),
    };
    database.exec(`
      CREATE TEMP TRIGGER v57_member_marker_injected_failure
      BEFORE UPDATE OF state ON chat_provider_thread_archive_cut_members_v57
      WHEN NEW.state = 'settled'
      BEGIN
        SELECT RAISE(ABORT, 'injected v57 final marker failure');
      END;
    `);
    expect(() => store.settleProviderThreadArchiveMemberV57({
      memberId: fixture.siblingMember.memberId,
      now: NOW,
    })).toThrow("injected v57 final marker failure");
    expect(database.query(`SELECT * FROM chat_panes WHERE pane_id = ?1`)
      .get(fixture.siblingMember.paneId)).toEqual(before.pane);
    expect(database.query(`
      SELECT * FROM chat_message_ledger WHERE message_id = ?1
    `).get(fixture.message.messageId)).toEqual(before.message);
    expect(database.query(`
      SELECT * FROM harness_root_turn_routing_receipts
      WHERE pane_id = ?1 AND chat_turn_id = ?2
    `).get(fixture.siblingMember.paneId, fixture.sibling.turnId))
      .toEqual(before.route);
    expect(database.query(`
      SELECT * FROM chat_provider_attachment_bindings WHERE pane_id = ?1
    `).get(fixture.siblingMember.paneId)).toEqual(before.binding);
    expect(journal.reopenCut(fixture.cutId).members.find((member) =>
      member.memberId === fixture.siblingMember.memberId
    )?.state).toBe("pending");
  });
});

test("v57 recovery proves settled postimages and sealed or contained complete inventory", () => {
  withV57Store(({ store, journal, database }) => {
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: PANE,
      suffix: "postimage_target01",
    });
    const siblingPaneId = "pane_v57_postimage_sibling1";
    const sibling = seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: siblingPaneId,
      suffix: "postimage_sibling01",
      ownership: "effectStarted",
    });
    const successorPaneId = "pane_v57_postimage_successor1";
    const successor = seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: successorPaneId,
      suffix: "postimage_successor01",
      generation: 2,
    });
    const roguePaneId = "pane_v57_postimage_rogue001";
    const rogue = seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: roguePaneId,
      suffix: "postimage_rogue01",
      generation: 1,
      ownership: "effectStarted",
    });
    const containedRoguePaneId = "pane_v57_contained_rogue01";
    const containedRogue = seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: containedRoguePaneId,
      suffix: "contained_rogue01",
      generation: 1,
      ownership: "effectStarted",
    });
    database.query(`
      UPDATE chat_panes SET provider_account_profile_id = NULL,
        provider_thread_id = NULL, provider_restart_thread_id = NULL
      WHERE pane_id IN (?1, ?2)
    `).run(roguePaneId, containedRoguePaneId);
    const input = v57TargetPreparationInput({
      store,
      paneId: PANE,
      suffix: "postimage_target01",
    });
    store.prepareProviderThreadArchiveEffectStartedV57(input);
    const target = journal.reopenTarget(input.targetId);
    const cutId = "archcut_v57_postimage01";
    store.beginProviderThreadArchiveLostResponseCutV57({
      targetId: target.targetId,
      cutId,
      cause: "ambiguous_response",
      now: NOW,
    });
    const successorRevision = advanceV57AccountGeneration(database, 2);
    journal.recordFence({
      cutId,
      successorGeneration: 2,
      successorAccountProfileRevision: successorRevision,
      fenceEvidenceDigest: v57Digest("5"),
      fenceRevisionDigest: v57Digest("6"),
      now: NOW,
    });
    const enumeration = store.enumerateProviderThreadArchiveSourceOwnershipV57({
      cutId,
      accountProfileId: ACCOUNT,
      sourceGeneration: 1,
      now: NOW,
    });
    store.sealProviderThreadArchiveSourceInventoryV57({
      cutId,
      now: NOW,
    });
    const siblingMember = enumeration.members.find((member) =>
      member.paneId === siblingPaneId
    );
    const targetMember = enumeration.members.find((member) =>
      member.paneId === PANE
    );
    if (siblingMember === undefined || targetMember === undefined) {
      throw new Error("Expected complete v57 inventory members");
    }
    store.settleProviderThreadArchiveMemberV57({
      memberId: siblingMember.memberId,
      now: NOW,
    });
    expect(store.verifyProviderThreadArchiveRecoveryV57().activeCuts[0])
      .toMatchObject({ cutId, state: "sealed" });
    const unresolvedSiblingEffect = insertV57UnresolvedMessageEffect(
      database,
      siblingPaneId,
      "postimage_sibling01",
    );
    insertV57RetainedTurnLease(
      database,
      siblingPaneId,
      unresolvedSiblingEffect,
      "postimage_sibling01",
    );
    expect(() => store.verifyProviderThreadArchiveRecoveryV57())
      .toThrow("unresolved local provider-effect evidence");
    acknowledgeV57MessageEffect(database, unresolvedSiblingEffect);
    expect(() => store.verifyProviderThreadArchiveRecoveryV57())
      .toThrow("unresolved local provider-effect evidence");
    completeV57MessageEffect(database, unresolvedSiblingEffect);
    expect(() => store.verifyProviderThreadArchiveRecoveryV57())
      .toThrow("unresolved local provider-effect evidence");
    releaseV57TurnLease(database, unresolvedSiblingEffect);
    expect(store.verifyProviderThreadArchiveRecoveryV57().activeCuts[0])
      .toMatchObject({ cutId, state: "sealed" });
    const ambiguousSiblingEffect = insertV57AmbiguousMessageEffect(
      database,
      siblingPaneId,
      "postimage_ambiguous01",
    );
    insertV57RetainedTurnLease(
      database,
      siblingPaneId,
      ambiguousSiblingEffect,
      "postimage_ambiguous01",
      "ambiguous",
    );
    expect(() => store.verifyProviderThreadArchiveRecoveryV57())
      .toThrow("unresolved local provider-effect evidence");
    resolveV57AmbiguousMessageEffect(
      database,
      siblingPaneId,
      ambiguousSiblingEffect,
    );
    expect(() => store.verifyProviderThreadArchiveRecoveryV57())
      .toThrow("unresolved local provider-effect evidence");
    releaseV57TurnLease(database, ambiguousSiblingEffect);
    expect(store.verifyProviderThreadArchiveRecoveryV57().activeCuts[0])
      .toMatchObject({ cutId, state: "sealed" });
    const wrongResolvedTurnId = "chatturn_v57_wrong_resolution01";
    database.query(`
      UPDATE chat_message_ledger SET claimed_turn_id = ?2,
        revision = revision + 1, updated_at = ?3
      WHERE message_id = ?1 AND state = 'ambiguous'
    `).run(
      ambiguousSiblingEffect.messageId,
      wrongResolvedTurnId,
      new Date(NOW.getTime() + 5).toISOString(),
    );
    expect(() => store.verifyProviderThreadArchiveRecoveryV57())
      .toThrow("unresolved local provider-effect evidence");
    database.query(`
      UPDATE chat_message_ledger SET claimed_turn_id = ?2,
        revision = revision + 1, updated_at = ?3
      WHERE message_id = ?1 AND state = 'ambiguous'
    `).run(
      ambiguousSiblingEffect.messageId,
      ambiguousSiblingEffect.turnId,
      new Date(NOW.getTime() + 6).toISOString(),
    );
    expect(store.verifyProviderThreadArchiveRecoveryV57().activeCuts[0])
      .toMatchObject({ cutId, state: "sealed" });

    database.query(`
      UPDATE chat_panes SET provider_thread_id = ?2,
        provider_restart_thread_id = ?3 WHERE pane_id = ?1
    `).run(
      successorPaneId,
      sibling.binding.threadId,
      sibling.binding.restartThreadId,
    );
    expect(() => store.verifyProviderThreadArchiveRecoveryV57())
      .toThrow("reassigned its frozen provider identity");
    database.query(`
      UPDATE chat_panes SET provider_thread_id = ?2,
        provider_restart_thread_id = ?3 WHERE pane_id = ?1
    `).run(
      successorPaneId,
      successor.binding.threadId,
      successor.binding.restartThreadId,
    );

    database.query(`
      UPDATE chat_panes SET provider_account_profile_id = ?2,
        provider_thread_id = ?3, provider_restart_thread_id = ?4
      WHERE pane_id = ?1
    `).run(
      roguePaneId,
      ACCOUNT,
      rogue.binding.threadId,
      rogue.binding.restartThreadId,
    );
    expect(() => store.verifyProviderThreadArchiveRecoveryV57())
      .toThrow("sealed v57 inventory");
    database.query(`
      UPDATE chat_panes SET provider_account_profile_id = NULL,
        provider_thread_id = NULL, provider_restart_thread_id = NULL
      WHERE pane_id = ?1
    `).run(roguePaneId);

    store.settleProviderThreadArchiveMemberV57({
      memberId: targetMember.memberId,
      now: NOW,
    });
    store.markProviderThreadArchiveCutContainedV57({
      cutId,
      now: NOW,
    });
    expect(journal.recoveryInventory().activeCuts).toEqual([]);
    expect(store.verifyProviderThreadArchiveRecoveryV57().targets)
      .toHaveLength(1);
    expect(store.providerThreadArchiveRecoveryPaneIdsV57()).toEqual(
      [PANE, siblingPaneId].toSorted(),
    );
    store.recordProviderThreadArchiveReconciliationV57({
      targetId: target.targetId,
      result: {
        disposition: "not_applied",
        providerReconciliationReceipt: "postimage reconciliation receipt",
      },
      now: NOW,
    });
    store.appendProviderThreadArchiveSuccessorEffectStartedV57({
      targetId: target.targetId,
      attemptId: "archattempt_v57_postimage_successor01",
      now: NOW,
    });
    expect(store.verifyProviderThreadArchiveRecoveryV57().targets[0])
      .toMatchObject({
        currentAttempt: { generation: 2, state: "effect_started" },
      });

    database.query(`
      UPDATE chat_panes SET provider_account_profile_id = ?2,
        provider_thread_id = ?3, provider_restart_thread_id = ?4
      WHERE pane_id = ?1
    `).run(
      containedRoguePaneId,
      ACCOUNT,
      containedRogue.binding.threadId,
      containedRogue.binding.restartThreadId,
    );
    expect(() => store.verifyProviderThreadArchiveRecoveryV57())
      .toThrow("sealed v57 inventory");

    database.transaction(() => {
      database.query(`
        UPDATE chat_panes SET workspace_state = 'preserved',
          workspace_revision = workspace_revision + 1, archived_at = ?2,
          provider_account_profile_id = ?3, provider_thread_id = ?4,
          provider_restart_thread_id = ?5
        WHERE pane_id = ?1
      `).run(
        siblingPaneId,
        NOW.toISOString(),
        ACCOUNT,
        sibling.binding.threadId,
        sibling.binding.restartThreadId,
      );
      database.query(`
        UPDATE chat_panes SET display_order = display_order + 100
        WHERE archived_at IS NULL AND display_order > 1
      `).run();
      database.query(`
        UPDATE chat_panes SET display_order = display_order - 101
        WHERE archived_at IS NULL AND display_order >= 102
      `).run();
    })();
    expect(() => store.verifyProviderThreadArchiveRecoveryV57())
      .toThrow("detached postimage");
  });
});

test("v57 recovery accepts only the exact account-contained target postimage", () => {
  withV57Store(({ store, journal, database }) => {
    const fixture = seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: PANE,
      suffix: "account_contained01",
    });
    const input = v57TargetPreparationInput({
      store,
      paneId: PANE,
      suffix: "account_contained01",
    });
    store.prepareProviderThreadArchiveEffectStartedV57(input);
    const target = journal.reopenTarget(input.targetId);
    const cutId = "archcut_v57_account_remove01";
    journal.createCut({
      cutId,
      accountProfileId: ACCOUNT,
      accountProfileRevision: 1,
      sourceGeneration: 1,
      cause: "account_removal",
      initiatingAttemptId: null,
      predecessorCutId: null,
      identityEvidenceDigest: v57Digest("1"),
      identityRevisionDigest: v57Digest("2"),
      now: NOW,
    });
    journal.bindAllAffectedTargets(cutId);
    journal.recordFence({
      cutId,
      successorGeneration: null,
      successorAccountProfileRevision: null,
      fenceEvidenceDigest: v57Digest("3"),
      fenceRevisionDigest: v57Digest("4"),
      now: NOW,
    });
    const frozen = database.query<{
      pane_revision: number;
      pane_cas_digest: string;
      thread_id: string;
      restart_thread_id: string;
      binding_id: string | null;
      binding_key_digest: string | null;
      binding_revision: number | null;
    }, [string]>(`
      SELECT pane_revision, pane_cas_digest, thread_id, restart_thread_id,
        binding_id, binding_key_digest, binding_revision
      FROM chat_provider_thread_archive_targets_v57 WHERE target_id = ?1
    `).get(target.targetId);
    if (frozen === null) throw new Error("Expected frozen removal target");
    const member = {
      memberId: "archmember_v57_account_remove01",
      cutId,
      paneId: PANE,
      paneRevision: frozen.pane_revision,
      paneCasDigest: frozen.pane_cas_digest,
      threadId: frozen.thread_id,
      restartThreadId: frozen.restart_thread_id,
      role: "target" as const,
      targetId: target.targetId,
      attemptId: target.currentAttempt.attemptId,
      targetAttemptOrdinal: target.currentAttempt.ordinal,
      action: "preserved_target" as const,
      binding: frozen.binding_id === null
        ? { kind: "none" as const }
        : {
            kind: "exact" as const,
            bindingId: frozen.binding_id,
            bindingKeyDigest: frozen.binding_key_digest!,
            bindingRevision: frozen.binding_revision!,
          },
      identityEvidenceDigest: v57Digest("5"),
      identityRevisionDigest: v57Digest("6"),
      now: NOW,
    };
    journal.addCutMember(member);
    journal.sealCutInventory({
      cutId,
      expectedMemberCount: 1,
      expectedInventoryDigest:
        providerThreadArchiveCompleteInventoryDigestV57([member]),
      enumerationAuthorityDigest: v57Digest("7"),
      sealRevisionDigest: v57Digest("8"),
      now: NOW,
    });
    database.transaction(() => {
      database.query(`
        UPDATE chat_panes SET provider_account_profile_id = NULL,
          provider_thread_id = NULL, provider_restart_thread_id = NULL,
          provider_context_reset_required = 1
        WHERE pane_id = ?1
      `).run(PANE);
      journal.settleMember({
        memberId: member.memberId,
        settlementEvidenceDigest: v57Digest("9"),
        settlementRevisionDigest: v57Digest("a"),
        now: NOW,
      });
    })();
    journal.markRemovalAwaitingTombstone({
      cutId,
      containmentEvidenceDigest: v57Digest("b"),
      containmentRevisionDigest: v57Digest("c"),
      targets: [{
        targetId: target.targetId,
        containmentEvidenceDigest: v57Digest("d"),
        containmentRevisionDigest: v57Digest("e"),
      }],
      now: NOW,
    });
    const unresolvedTargetEffect = insertV57UnresolvedMessageEffect(
      database,
      PANE,
      "account_contained01",
    );
    expect(() => store.verifyProviderThreadArchiveRecoveryV57())
      .toThrow("unresolved local provider-effect evidence");
    acknowledgeV57MessageEffect(database, unresolvedTargetEffect);
    completeV57MessageEffect(database, unresolvedTargetEffect);
    const claimedTargetMessage = insertV57PreparedMessageClaim(
      database,
      PANE,
      "account_contained_claim01",
      "start_claimed",
    );
    expect(() => store.verifyProviderThreadArchiveRecoveryV57())
      .toThrow("unresolved local provider-effect evidence");
    returnV57PreparedMessageToQueue(database, claimedTargetMessage);
    const preparedTargetSteer = insertV57PreparedMessageClaim(
      database,
      PANE,
      "account_contained_steer01",
      "steer_prepared",
    );
    expect(() => store.verifyProviderThreadArchiveRecoveryV57())
      .toThrow("unresolved local provider-effect evidence");
    returnV57PreparedMessageToQueue(database, preparedTargetSteer);
    expect(store.verifyProviderThreadArchiveRecoveryV57().targets[0])
      .toMatchObject({
        targetId: target.targetId,
        status: "account_contained",
        currentAttempt: { state: "account_contained" },
      });

    database.query(`
      UPDATE chat_panes SET provider_account_profile_id = ?2,
        provider_thread_id = ?3, provider_restart_thread_id = ?4
      WHERE pane_id = ?1
    `).run(
      PANE,
      ACCOUNT,
      fixture.binding.threadId,
      fixture.binding.restartThreadId,
    );
    expect(() => store.verifyProviderThreadArchiveRecoveryV57())
      .toThrow("account-contained v57 target");
  });
});

test("v57 preflight rejects attached and headless bound Harness source sessions before journal mutation", () => {
  withV57Store(({ store, journal, database }) => {
    seedV57OrdinaryProviderPane({
      store,
      database,
      paneId: PANE,
      suffix: "harness_census_target01",
    });
    const harness = seedV57HarnessProviderPane({
      store,
      database,
      suffix: "harness_census_bound01",
    });
    expect(() => prepareV57Target({
      store,
      paneId: PANE,
      suffix: "harness_census_target01",
    })).toThrow("bound Harness session");
    expect(journal.recoveryTargets()).toEqual([]);

    database.query(`
      DELETE FROM harness_actor_pane_bindings WHERE pane_id = ?1
    `).run(harness.paneId);
    expect(database.query(`
      SELECT COUNT(*) AS count FROM harness_actor_pane_bindings
      WHERE pane_id = ?1
    `).get(harness.paneId)).toEqual({ count: 0 });
    expect(() => prepareV57Target({
      store,
      paneId: PANE,
      suffix: "harness_census_target01",
    })).toThrow("bound Harness session");
    expect(journal.recoveryTargets()).toEqual([]);
  });
});

type V57StoreFixture = Readonly<{
  store: ChatPaneStore;
  journal: ProviderThreadArchiveJournalV57;
  database: Database;
  privacyBlockedPaneIds: Set<string>;
  terminalPostimageAssertions: string[][];
  terminalPostimageAssertionFailure: { current: Error | null };
}>;

function withV57Store(run: (fixture: V57StoreFixture) => void): void {
  const database = Database.deserialize(pristineDatabase.slice(), { strict: true });
  const privacyBlockedPaneIds = new Set<string>();
  const terminalPostimageAssertions: string[][] = [];
  const terminalPostimageAssertionFailure: { current: Error | null } = {
    current: null,
  };
  try {
    database.exec("PRAGMA foreign_keys = ON");
    const journal = new ProviderThreadArchiveJournalV57(
      database,
      V57_RECEIPT_KEY,
    );
    const paneArchiveAuthority: Pick<
      ChatAttachmentVault,
      | "assertPaneArchiveCompatible"
      | "assertProviderThreadArchiveV57Compatible"
      | "assertProviderThreadArchiveTerminalPostimagesV57"
      | "preparePaneArchiveInTransaction"
      | "markPaneArchivedInTransaction"
      | "releaseProviderBindingAfterResumeContainedInTransaction"
    > = {
      assertPaneArchiveCompatible(paneId) {
        if (privacyBlockedPaneIds.has(paneId)) {
          throw new Error("fixture attachment privacy transition is pending");
        }
      },
      assertProviderThreadArchiveV57Compatible(paneId) {
        if (privacyBlockedPaneIds.has(paneId)) {
          throw new Error("fixture attachment privacy transition is pending");
        }
      },
      assertProviderThreadArchiveTerminalPostimagesV57(targetIds) {
        terminalPostimageAssertions.push([...targetIds]);
        if (terminalPostimageAssertionFailure.current !== null) {
          throw terminalPostimageAssertionFailure.current;
        }
      },
      preparePaneArchiveInTransaction() {},
      markPaneArchivedInTransaction() {},
      releaseProviderBindingAfterResumeContainedInTransaction(input) {
        const releasedAt = input.now.toISOString();
        const released = database.query(`
          UPDATE chat_provider_attachment_bindings SET
            state = 'released', containment_receipt_digest = ?5,
            revision = revision + 1, released_at = ?6, updated_at = ?6
          WHERE binding_id = ?1 AND binding_key_digest = ?2
            AND pane_id = ?3 AND revision = ?4
            AND state IN ('active', 'ambiguous')
        `).run(
          input.bindingId,
          input.bindingKeyDigest,
          input.paneId,
          input.expectedRevision,
          v57Digest("f"),
          releasedAt,
        );
        if (released.changes !== 1) {
          throw new Error("fixture provider binding changed before release");
        }
        return {
          bindingId: input.bindingId,
          revision: input.expectedRevision + 1,
          state: "released",
          changed: true,
        };
      },
    };
    const store = new ChatPaneStore(database, {
      messageRequestDigestKey: V57_RECEIPT_KEY,
      paneArchiveAuthority,
    });
    run({
      store,
      journal,
      database,
      privacyBlockedPaneIds,
      terminalPostimageAssertions,
      terminalPostimageAssertionFailure,
    });
  } finally {
    database.close();
  }
}

function seedV57OrdinaryProviderPane(input: Readonly<{
  store: ChatPaneStore;
  database: Database;
  paneId: string;
  suffix: string;
  generation?: number;
  ownership?: "accepted" | "effectStarted";
}>): Readonly<{
  pane: ReturnType<ChatPaneStore["require"]>;
  binding: ChatThreadBinding;
  turnId: string;
}> {
  const generation = input.generation ?? 1;
  const ownership = input.ownership ?? "accepted";
  const created = createPane(input.store, input.paneId);
  const turnId = `chatturn_v57_${input.suffix}`;
  input.store.beginTurn({
    paneId: input.paneId,
    expectedRevision: created.revision,
    turnId,
    prompt: `v57 provider ownership ${input.suffix}`,
    now: NOW,
  });
  input.store.reserveAccount(input.paneId, turnId, ACCOUNT, NOW);
  const routing = new RootTurnRoutingSQLiteAuthorityV1(input.database);
  const classified = routing.readTurnRouting(input.paneId, turnId);
  if (classified === null) throw new Error("Expected v57 routing classification");
  routing.resolve({
    paneId: input.paneId,
    chatTurnId: turnId,
    selectedProfile: classified.requestedProfile,
    profileFallbackReason: null,
    selectedServiceTier: classified.requestedServiceTier,
    serviceTierFallbackReason: null,
    catalogGeneration: generation,
    catalogDigest: V57_CATALOG_DIGEST,
    now: NOW,
  });
  const binding = {
    accountProfileId: ACCOUNT,
    threadId: `thread_v57_${input.suffix}`,
    restartThreadId: `raw_thread_v57_${input.suffix}`,
  } as const;
  input.store.prepareProviderThread(input.paneId, turnId, binding, NOW);
  routing.markEffectStarted({
    paneId: input.paneId,
    chatTurnId: turnId,
    now: NOW,
  });
  if (ownership === "accepted") {
    routing.accept({
      paneId: input.paneId,
      chatTurnId: turnId,
      acceptedGeneration: generation,
      acceptedStreamPosition: 0,
      now: NOW,
    });
    input.store.markTurnAccepted(
      input.paneId,
      turnId,
      `provider_turn_v57_${input.suffix}`,
      NOW,
    );
    routing.settle({
      paneId: input.paneId,
      chatTurnId: turnId,
      outcome: "failed",
      now: NOW,
    });
    const terminal = input.store.enterAttention({
      paneId: input.paneId,
      turnId,
      attention: {
        code: "turn_failed",
        message: "The accepted provider turn is terminal.",
        retryable: false,
      },
      clearBinding: false,
      now: NOW,
    });
    if (terminal === null) throw new Error("Expected accepted v57 pane terminal");
  } else {
    const terminal = input.store.enterAttention({
      paneId: input.paneId,
      turnId,
      attention: {
        code: "turn_failed",
        message: "The provider effect needs exact recovery.",
        retryable: false,
      },
      clearBinding: false,
      now: NOW,
    });
    if (terminal === null) throw new Error("Expected v57 effect-started pane");
  }
  return {
    pane: input.store.require(input.paneId),
    binding,
    turnId,
  };
}

function retainExactV57AttachmentBinding(
  database: Database,
  paneId: string,
  binding: ChatThreadBinding,
): void {
  const authority = chatProviderAttachmentAuthority(paneId, binding);
  database.query(`
    INSERT INTO chat_provider_attachment_bindings (
      binding_id, binding_key_digest, pane_id, revision, state,
      acquired_at, updated_at
    ) VALUES (?1, ?2, ?3, 1, 'active', ?4, ?4)
  `).run(
    authority.bindingId,
    authority.bindingKeyDigest,
    paneId,
    NOW.toISOString(),
  );
}

type V57UnresolvedMessageEffectFixture = Readonly<{
  messageId: string;
  turnId: string;
}>;

function insertV57PreparedMessageClaim(
  database: Database,
  paneId: string,
  suffix: string,
  state: "start_claimed" | "steer_prepared",
): V57UnresolvedMessageEffectFixture {
  const messageId = `chatmsg_v57_${suffix}`;
  const turnId = `chatturn_v57_claim_${suffix}`;
  database.query(`
    INSERT INTO chat_message_ledger (
      message_id, pane_id, ordinal, revision, message_text,
      message_utf8_bytes, state, claimed_turn_id,
      effect_started_at, acknowledged_at, terminal_at,
      created_at, updated_at
    ) VALUES (
      ?1, ?2,
      (SELECT COALESCE(MAX(ordinal), 0) + 1
        FROM chat_message_ledger WHERE pane_id = ?2),
      1, 'prepared', 8, ?3, ?4, NULL, NULL, NULL, ?5, ?5
    )
  `).run(messageId, paneId, state, turnId, NOW.toISOString());
  return { messageId, turnId };
}

function returnV57PreparedMessageToQueue(
  database: Database,
  effect: V57UnresolvedMessageEffectFixture,
): void {
  database.query(`
    UPDATE chat_message_ledger SET state = 'queued', claimed_turn_id = NULL,
      revision = revision + 1, updated_at = ?2
    WHERE message_id = ?1 AND state IN ('start_claimed', 'steer_prepared')
  `).run(effect.messageId, new Date(NOW.getTime() + 1).toISOString());
}

function insertV57UnresolvedMessageEffect(
  database: Database,
  paneId: string,
  suffix: string,
): V57UnresolvedMessageEffectFixture {
  const messageId = `chatmsg_v57_${suffix}`;
  const turnId = `chatturn_v57_ledger_${suffix}`;
  database.query(`
    INSERT INTO chat_message_ledger (
      message_id, pane_id, ordinal, revision, message_text,
      message_utf8_bytes, state, claimed_turn_id,
      effect_started_at, acknowledged_at, terminal_at,
      created_at, updated_at
    ) VALUES (
      ?1, ?2,
      (SELECT COALESCE(MAX(ordinal), 0) + 1
        FROM chat_message_ledger WHERE pane_id = ?2),
      1, 'unresolved v57 provider effect', 30,
      'start_effect_started', ?3, ?4, NULL, NULL, ?4, ?4
    )
  `).run(messageId, paneId, turnId, NOW.toISOString());
  return { messageId, turnId };
}

function acknowledgeV57MessageEffect(
  database: Database,
  effect: V57UnresolvedMessageEffectFixture,
): void {
  const acknowledgedAt = new Date(NOW.getTime() + 1).toISOString();
  database.query(`
    UPDATE chat_message_ledger SET state = 'start_acknowledged',
      revision = revision + 1, acknowledged_at = ?2, updated_at = ?2
    WHERE message_id = ?1 AND state = 'start_effect_started'
  `).run(effect.messageId, acknowledgedAt);
}

function completeV57MessageEffect(
  database: Database,
  effect: V57UnresolvedMessageEffectFixture,
): void {
  const completedAt = new Date(NOW.getTime() + 2).toISOString();
  database.query(`
    UPDATE chat_message_ledger SET state = 'completed',
      revision = revision + 1, terminal_at = ?2, updated_at = ?2
    WHERE message_id = ?1 AND state = 'start_acknowledged'
  `).run(effect.messageId, completedAt);
}

function insertV57RetainedTurnLease(
  database: Database,
  paneId: string,
  effect: V57UnresolvedMessageEffectFixture,
  suffix: string,
  state: "active" | "ambiguous" = "active",
): void {
  const attachmentId = `attachment_v57_${suffix}`;
  const uploadId = `upload_v57_${suffix}`;
  const digest = v57Digest("d");
  database.query(`
    INSERT INTO chat_attachments (
      attachment_id, upload_id, pane_id, revision, state, kind,
      display_name, declared_media_type, effective_media_type,
      internal_suffix, expected_input_bytes, received_input_bytes,
      source_retained, next_chunk_ordinal, finalize_request_revision,
      requested_input_sha256, input_sha256, source_media_type,
      width, height, pixel_count, canonical_bytes, canonical_sha256,
      preview_bytes, preview_width, preview_height, preview_sha256,
      provider_bytes, provider_sha256, ready_at, created_at, updated_at
    ) VALUES (
      ?1, ?2, ?3, 1, 'ready', 'image',
      'v57.png', 'image/png', 'image/png',
      'png', 100, 100, 0, 1, 1,
      ?4, ?4, 'image/png', 10, 10, 100, 100, ?4,
      50, 10, 10, ?4, 100, ?4, ?5, ?5, ?5
    )
  `).run(attachmentId, uploadId, paneId, digest, NOW.toISOString());
  database.query(`
    INSERT INTO chat_message_attachment_refs (
      message_id, pane_id, position, attachment_id,
      consumed_draft_expires_at
    ) VALUES (?1, ?2, 0, ?3, ?4)
  `).run(effect.messageId, paneId, attachmentId, NOW.toISOString());
  database.query(`
    INSERT INTO chat_attachment_turn_leases (
      attachment_id, pane_id, message_id, turn_id, state,
      acquired_at, updated_at, released_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, NULL)
  `).run(
    attachmentId,
    paneId,
    effect.messageId,
    effect.turnId,
    state,
    NOW.toISOString(),
  );
}

function insertV57AmbiguousMessageEffect(
  database: Database,
  paneId: string,
  suffix: string,
  claimedTurnId?: string,
): V57UnresolvedMessageEffectFixture {
  const messageId = `chatmsg_v57_${suffix}`;
  const turnId = claimedTurnId ?? `chatturn_v57_ledger_${suffix}`;
  const terminalAt = new Date(NOW.getTime() + 1).toISOString();
  database.query(`
    INSERT INTO chat_message_ledger (
      message_id, pane_id, ordinal, revision, message_text,
      message_utf8_bytes, state, claimed_turn_id,
      effect_started_at, acknowledged_at, terminal_at,
      created_at, updated_at
    ) VALUES (
      ?1, ?2,
      (SELECT COALESCE(MAX(ordinal), 0) + 1
        FROM chat_message_ledger WHERE pane_id = ?2),
      1, 'ambiguous', 9, 'ambiguous', ?3,
      ?4, NULL, ?5, ?4, ?5
    )
  `).run(
    messageId,
    paneId,
    turnId,
    NOW.toISOString(),
    terminalAt,
  );
  return { messageId, turnId };
}

function resolveV57AmbiguousMessageEffect(
  database: Database,
  paneId: string,
  effect: V57UnresolvedMessageEffectFixture,
): void {
  const resolvedAt = new Date(NOW.getTime() + 2).toISOString();
  database.query(`
    UPDATE chat_panes SET active_turn_id = ?2 WHERE pane_id = ?1
  `).run(paneId, effect.turnId);
  database.query(`
    INSERT INTO chat_message_ambiguous_resolutions (
      message_id, pane_id, claimed_turn_id, resolution, resolved_at
    ) VALUES (?1, ?2, ?3, 'discarded', ?4)
  `).run(effect.messageId, paneId, effect.turnId, resolvedAt);
}

function releaseV57TurnLease(
  database: Database,
  effect: V57UnresolvedMessageEffectFixture,
): void {
  const releasedAt = new Date(NOW.getTime() + 3).toISOString();
  database.query(`
    UPDATE chat_attachment_turn_leases SET state = 'released',
      released_at = ?2, updated_at = ?2
    WHERE message_id = ?1 AND turn_id = ?3 AND state != 'released'
  `).run(effect.messageId, releasedAt, effect.turnId);
}

function seedV57HarnessProviderPane(input: Readonly<{
  store: ChatPaneStore;
  database: Database;
  suffix: string;
  generation?: number;
}>): Readonly<{ paneId: string; binding: ChatThreadBinding }> {
  const generation = input.generation ?? 1;
  const projectId = `project_v57_${input.suffix}`;
  const laneId = `lane_v57_${input.suffix}`;
  const epochId = `hepoch_v57_${input.suffix}`;
  const actorId = `hactor_v57_${input.suffix}`;
  const workspaceBindingId = `hbinding_v57_${input.suffix}`;
  const operationId = `hoperation_v57_${input.suffix}`;
  const incarnationId = `hincarnation_v57_${input.suffix}`;
  const providerThreadId = `raw_thread_v57_${input.suffix}`;
  const threadSource = `thread_source_v57_${input.suffix}`;
  const paneBindingId = `hpanebinding_v57_${input.suffix}`;
  const binding = {
    accountProfileId: ACCOUNT,
    threadId: `thread_v57_${input.suffix}`,
    restartThreadId: providerThreadId,
  } as const;
  input.database.query(`
    INSERT INTO projects (
      project_id, canonical_repository_path, canonical_git_common_dir,
      display_name, created_at, updated_at
    ) VALUES (?1, ?2, ?3, 'v57 harness', ?4, ?4)
  `).run(
    projectId,
    `/fixture/${input.suffix}`,
    `/fixture/${input.suffix}/.git`,
    NOW.toISOString(),
  );
  input.database.query(`
    INSERT INTO workspace_leases (
      lane_id, project_id, account_profile_id, canonical_checkout_path,
      mode, status, base_sha, retention, dirty_hint, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, 'harness_read_only_snapshot', 'active',
      ?5, 'preserve', 0, ?6, ?6)
  `).run(
    laneId,
    projectId,
    ACCOUNT,
    `/fixture/${input.suffix}/checkout`,
    "a".repeat(40),
    NOW.toISOString(),
  );
  input.database.query(`
    INSERT INTO harness_actor_epochs (
      epoch_id, project_id, source_sha, root_actor_id, max_depth,
      max_active_descendants, max_durable_descendants, token_budget,
      byte_budget, deadline, lane_authority, state, revision,
      created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, 3, 8, 50, 100000, 16777216,
      '2026-08-04T12:00:00.000Z', 'readOnlySnapshot', 'active', 1, ?5, ?5)
  `).run(
    epochId,
    projectId,
    "b".repeat(40),
    actorId,
    NOW.toISOString(),
  );
  input.database.query(`
    INSERT INTO harness_actors (
      actor_id, epoch_id, parent_actor_id, depth, title, state,
      max_depth, max_active_descendants, max_durable_descendants,
      token_budget, byte_budget, deadline, lane_authority,
      revision, created_at, updated_at
    ) VALUES (?1, ?2, NULL, 0, 'v57 harness actor', 'active',
      3, 8, 50, 100000, 16777216, '2026-08-04T12:00:00.000Z',
      'readOnlySnapshot', 1, ?3, ?3)
  `).run(actorId, epochId, NOW.toISOString());
  input.database.query(`
    INSERT INTO harness_actor_workspace_bindings (
      binding_id, actor_id, lane_id, authority, state, revision,
      created_at, updated_at
    ) VALUES (?1, ?2, ?3, 'readOnlySnapshot', 'active', 1, ?4, ?4)
  `).run(workspaceBindingId, actorId, laneId, NOW.toISOString());
  input.database.query(`
    INSERT INTO harness_actor_operations (
      operation_id, actor_id, turn_id, kind, request_digest, effect_key,
      state, provider_identity_json, created_at, updated_at, settled_at
    ) VALUES (?1, ?2, NULL, 'actorStart', ?3, ?4, 'succeeded', '{}',
      ?5, ?5, ?5)
  `).run(
    operationId,
    actorId,
    v57Digest("1"),
    v57Digest("2"),
    NOW.toISOString(),
  );
  input.database.query(`
    INSERT INTO harness_actor_incarnations (
      incarnation_id, actor_id, ordinal, account_profile_id,
      process_generation, start_operation_id, client_request_id,
      thread_source, provider_thread_id, toolset_digest, state,
      created_at, updated_at
    ) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
      'idle', ?10, ?10)
  `).run(
    incarnationId,
    actorId,
    ACCOUNT,
    generation,
    operationId,
    `client_request_v57_${input.suffix}`,
    threadSource,
    providerThreadId,
    v57Digest("3"),
    NOW.toISOString(),
  );
  input.database.query(`
    INSERT INTO harness_actor_session_bindings (
      incarnation_id, actor_id, workspace_binding_id, account_profile_id,
      admission_generation, live_generation, provider_thread_id,
      thread_source, recovery_proof_digest, history_evidence_digest,
      first_observation_position, second_observation_position,
      history_turn_count, history_item_count, state, revision,
      created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, ?8, ?9,
      0, 1, 0, 0, 'bound', 1, ?10, ?10)
  `).run(
    incarnationId,
    actorId,
    workspaceBindingId,
    ACCOUNT,
    generation,
    providerThreadId,
    threadSource,
    v57Digest("4"),
    v57Digest("5"),
    NOW.toISOString(),
  );
  const created = input.database.transaction(() =>
    input.store.createAttachedHarnessSession({
      actorId,
      repository: {
        id: REPOSITORY,
        name: "v57 harness",
        workingDirectory: `/fixture/${input.suffix}/checkout`,
      },
      binding,
      title: "v57 harness",
      now: NOW,
    })
  )();
  input.database.query(`
    INSERT INTO harness_actor_pane_bindings (
      binding_id, actor_id, pane_id, state, revision, attached_at
    ) VALUES (?1, ?2, ?3, 'attached', 1, ?4)
  `).run(paneBindingId, actorId, created.pane.id, NOW.toISOString());
  return { paneId: created.pane.id, binding };
}

function prepareV57Target(input: Readonly<{
  store: ChatPaneStore;
  paneId: string;
  suffix: string;
  generation?: number;
  purpose?: "pane_archive" | "start_fresh";
  now?: Date;
}>) {
  const preparation = v57TargetPreparationInput(input);
  input.store.prepareProviderThreadArchiveEffectStartedV57(preparation);
  const target = input.store.verifyProviderThreadArchiveRecoveryV57().targets
    .find((candidate) => candidate.targetId === preparation.targetId);
  if (target === undefined) {
    throw new Error("Expected atomic v57 target preparation");
  }
  return target;
}

function finalizeV57DirectTarget(input: Readonly<{
  store: ChatPaneStore;
  database: Database;
  paneId: string;
  suffix: string;
  purpose?: "pane_archive" | "start_fresh";
}>): Readonly<{ targetId: string; paneId: string }> {
  const fixture = seedV57OrdinaryProviderPane({
    store: input.store,
    database: input.database,
    paneId: input.paneId,
    suffix: input.suffix,
  });
  retainExactV57AttachmentBinding(
    input.database,
    input.paneId,
    fixture.binding,
  );
  const purpose = input.purpose ?? "pane_archive";
  if (purpose === "start_fresh") {
    const changed = input.database.query(`
      UPDATE chat_panes SET state = 'attention',
        attention_code = 'runtime_unavailable',
        attention_message = 'Choose Start fresh.', attention_retryable = 0,
        provider_context_reset_required = 1,
        message_queue_pause_reason = 'attention',
        message_queue_revision = message_queue_revision + 1,
        revision = revision + 1
      WHERE pane_id = ?1
    `).run(input.paneId);
    if (changed.changes !== 1) {
      throw new Error("Expected a v57 Start fresh fixture pane");
    }
  }
  const preparation = v57TargetPreparationInput({
    store: input.store,
    paneId: input.paneId,
    suffix: input.suffix,
    purpose,
  });
  input.store.prepareProviderThreadArchiveEffectStartedV57(preparation);
  input.store.recordProviderThreadArchiveDirectAppliedV57({
    targetId: preparation.targetId,
    responseGeneration: 1,
    responseStreamPosition: 1,
    providerContainmentReceipt: `provider containment ${input.suffix}`,
    now: NOW,
  });
  input.store.finalizeProviderThreadArchiveTargetV57({
    targetId: preparation.targetId,
    now: NOW,
  });
  return Object.freeze({
    targetId: preparation.targetId,
    paneId: input.paneId,
  });
}

function finalizeV57IndependentDirectTargets(input: Readonly<{
  store: ChatPaneStore;
  database: Database;
  targets: readonly Readonly<{
    paneId: string;
    suffix: string;
    purpose?: "pane_archive" | "start_fresh";
  }>[];
}>): readonly Readonly<{ targetId: string; paneId: string }>[] {
  const seeded = input.targets.map((target) => {
    const fixture = seedV57OrdinaryProviderPane({
      store: input.store,
      database: input.database,
      paneId: target.paneId,
      suffix: target.suffix,
    });
    retainExactV57AttachmentBinding(
      input.database,
      target.paneId,
      fixture.binding,
    );
    const purpose = target.purpose ?? "pane_archive";
    if (purpose === "start_fresh") {
      const changed = input.database.query(`
        UPDATE chat_panes SET state = 'attention',
          attention_code = 'runtime_unavailable',
          attention_message = 'Choose Start fresh.', attention_retryable = 0,
          provider_context_reset_required = 1,
          message_queue_pause_reason = 'attention',
          message_queue_revision = message_queue_revision + 1,
          revision = revision + 1
        WHERE pane_id = ?1
      `).run(target.paneId);
      if (changed.changes !== 1) {
        throw new Error("Expected a v57 Start fresh fixture pane");
      }
    }
    return Object.freeze({
      paneId: target.paneId,
      suffix: target.suffix,
      preparation: v57TargetPreparationInput({
        store: input.store,
        paneId: target.paneId,
        suffix: target.suffix,
        purpose,
      }),
    });
  });
  for (const { preparation } of seeded) {
    input.store.prepareProviderThreadArchiveEffectStartedV57(preparation);
  }
  for (const [index, { preparation, suffix }] of seeded.entries()) {
    input.store.recordProviderThreadArchiveDirectAppliedV57({
      targetId: preparation.targetId,
      responseGeneration: 1,
      responseStreamPosition: index + 1,
      providerContainmentReceipt: `provider containment ${suffix}`,
      now: NOW,
    });
  }
  return Object.freeze(seeded.map(({ paneId, preparation }) => {
    input.store.finalizeProviderThreadArchiveTargetV57({
      targetId: preparation.targetId,
      now: NOW,
    });
    return Object.freeze({ targetId: preparation.targetId, paneId });
  }));
}

function finalizeV57ConnectedAppliedTargets(input: Readonly<{
  store: ChatPaneStore;
  journal: ProviderThreadArchiveJournalV57;
  database: Database;
  cutId: string;
  targets: readonly Readonly<{
    paneId: string;
    suffix: string;
    purpose?: "pane_archive" | "start_fresh";
  }>[];
}>): Readonly<{
  cutId: string;
  targets: readonly Readonly<{ targetId: string; paneId: string }>[];
}> {
  const seeded = input.targets.map((target) => {
    const fixture = seedV57OrdinaryProviderPane({
      store: input.store,
      database: input.database,
      paneId: target.paneId,
      suffix: target.suffix,
    });
    retainExactV57AttachmentBinding(
      input.database,
      target.paneId,
      fixture.binding,
    );
    const purpose = target.purpose ?? "pane_archive";
    if (purpose === "start_fresh") {
      const changed = input.database.query(`
        UPDATE chat_panes SET state = 'attention',
          attention_code = 'runtime_unavailable',
          attention_message = 'Choose Start fresh.', attention_retryable = 0,
          provider_context_reset_required = 1,
          message_queue_pause_reason = 'attention',
          message_queue_revision = message_queue_revision + 1,
          revision = revision + 1
        WHERE pane_id = ?1
      `).run(target.paneId);
      if (changed.changes !== 1) {
        throw new Error("Expected a connected v57 Start fresh fixture pane");
      }
    }
    return Object.freeze({
      paneId: target.paneId,
      preparation: v57TargetPreparationInput({
        store: input.store,
        paneId: target.paneId,
        suffix: target.suffix,
        purpose,
      }),
    });
  });
  if (seeded.length === 0) {
    throw new Error("Expected at least one connected v57 target");
  }
  for (const { preparation } of seeded) {
    input.store.prepareProviderThreadArchiveEffectStartedV57(preparation);
  }
  input.store.beginProviderThreadArchiveLostResponseCutV57({
    targetId: seeded[0]!.preparation.targetId,
    cutId: input.cutId,
    cause: "lost_response",
    now: NOW,
  });
  const successorRevision = advanceV57AccountGeneration(input.database, 2);
  input.journal.recordFence({
    cutId: input.cutId,
    successorGeneration: 2,
    successorAccountProfileRevision: successorRevision,
    fenceEvidenceDigest: v57Digest("1"),
    fenceRevisionDigest: v57Digest("2"),
    now: NOW,
  });
  const sealed = input.store.sealProviderThreadArchiveSourceInventoryV57({
    cutId: input.cutId,
    now: NOW,
  });
  for (const member of sealed.members) {
    input.store.settleProviderThreadArchiveMemberV57({
      memberId: member.memberId,
      now: NOW,
    });
  }
  input.store.markProviderThreadArchiveCutContainedV57({
    cutId: input.cutId,
    now: NOW,
  });
  for (const [index, { preparation }] of seeded.entries()) {
    input.store.recordProviderThreadArchiveReconciliationV57({
      targetId: preparation.targetId,
      result: {
        disposition: "applied",
        responseGeneration: 2,
        responseStreamPosition: 100 + index,
        providerContainmentReceipt: `connected sweep containment ${index}`,
      },
      now: NOW,
    });
  }
  return Object.freeze({
    cutId: input.cutId,
    targets: Object.freeze(seeded.map(({ paneId, preparation }) => {
      input.store.finalizeProviderThreadArchiveTargetV57({
        targetId: preparation.targetId,
        now: NOW,
      });
      return Object.freeze({ targetId: preparation.targetId, paneId });
    })),
  });
}

function seedV57ContainedZeroTargetRemovalCut(input: Readonly<{
  journal: ProviderThreadArchiveJournalV57;
  database: Database;
  cutId: string;
  accountProfileId?: string;
  createAccountProfile?: boolean;
  predecessorCutId?: string | null;
}>): void {
  const accountProfileId = input.accountProfileId ??
    "acct_v57_sweep_removal1";
  if (input.createAccountProfile !== false) {
    input.database.query(`
      INSERT INTO account_profiles (
        profile_id, label, auth_state, process_generation,
        selected, created_at, updated_at
      ) VALUES (?1, 'Removal fixture', 'signed_in', 1, 0, ?2, ?2)
    `).run(accountProfileId, NOW.toISOString());
  }
  const profileBefore = input.database.query<{
    revision: number;
    process_generation: number;
  }, [string]>(`
    SELECT revision, process_generation FROM account_profiles
    WHERE profile_id = ?1 AND removed_at IS NULL
  `).get(accountProfileId);
  if (profileBefore === null) {
    throw new Error("Expected the live v57 removal account profile");
  }
  input.journal.createCut({
    cutId: input.cutId,
    accountProfileId,
    accountProfileRevision: profileBefore.revision,
    sourceGeneration: profileBefore.process_generation,
    cause: "account_removal",
    initiatingAttemptId: null,
    predecessorCutId: input.predecessorCutId ?? null,
    identityEvidenceDigest: v57Digest("1"),
    identityRevisionDigest: v57Digest("2"),
    now: NOW,
  });
  input.journal.recordFence({
    cutId: input.cutId,
    successorGeneration: null,
    successorAccountProfileRevision: null,
    fenceEvidenceDigest: v57Digest("3"),
    fenceRevisionDigest: v57Digest("4"),
    now: NOW,
  });
  input.journal.sealCutInventory({
    cutId: input.cutId,
    expectedMemberCount: 0,
    expectedInventoryDigest:
      providerThreadArchiveCompleteInventoryDigestV57([]),
    enumerationAuthorityDigest: v57Digest("5"),
    sealRevisionDigest: v57Digest("6"),
    now: NOW,
  });
  input.journal.markRemovalAwaitingTombstone({
    cutId: input.cutId,
    containmentEvidenceDigest: v57Digest("7"),
    containmentRevisionDigest: v57Digest("8"),
    targets: [],
    now: NOW,
  });
  const removedAt = new Date(NOW.getTime() + 1_000).toISOString();
  const accountProfileRevision = profileBefore.revision + 1;
  const updated = input.database.query(`
    UPDATE account_profiles SET removed_at = ?2, selected = 0,
      local_data_deleted_at = NULL,
      identity_label = NULL, plan_label = NULL, auth_state = 'signedOut',
      revision = ?3, updated_at = ?2
    WHERE profile_id = ?1 AND revision = ?4 AND removed_at IS NULL
  `).run(
    accountProfileId,
    removedAt,
    accountProfileRevision,
    profileBefore.revision,
  );
  if (updated.changes !== 1) {
    throw new Error("Expected the v57 removal account tombstone");
  }
  const profilePreimageDigest =
    providerThreadArchiveAccountTombstonePreimageDigestV57({
      accountProfileId,
      accountProfileRevision,
      processGeneration: profileBefore.process_generation,
      removedAt,
      localDataDeletedAt: null,
    });
  input.journal.markRemovalTombstoned({
    cutId: input.cutId,
    tombstoneEvidenceDigest: v57Digest("9"),
    tombstoneRevisionDigest: v57Digest("a"),
    accountProfileRevision,
    removedAt,
    localDataDeletedAt: null,
    profilePreimageDigest,
    now: new Date(NOW.getTime() + 2_000),
  });
}

function v57TargetPreparationInput(input: Readonly<{
  store: ChatPaneStore;
  paneId: string;
  suffix: string;
  generation?: number;
  purpose?: "pane_archive" | "start_fresh";
  now?: Date;
}>) {
  const pane = input.store.require(input.paneId).projection;
  const purpose = input.purpose ?? "pane_archive";
  const base = {
    targetId: `archtarget_v57_${input.suffix}`,
    attemptId: `archattempt_v57_${input.suffix}`,
    paneId: input.paneId,
    expectedRevision: pane.revision,
    generation: input.generation ?? 1,
    now: input.now ?? NOW,
  } as const;
  return purpose === "start_fresh"
    ? ({
        ...base,
        purpose,
        expectedQueueRevision: pane.messageQueue.revision,
      } as const)
    : ({
        ...base,
        purpose,
        expectedQueueRevision: null,
      } as const);
}

function v57Digest(character: string): string {
  return character.repeat(64);
}

function v57StoreHmac(domain: string, value: unknown): string {
  return createHmac("sha256", V57_RECEIPT_KEY)
    .update(`hra-provider-thread-archive-store-v57:${domain}\0`)
    .update(canonicalV57StoreJson(value))
    .digest("hex");
}

function canonicalV57StoreJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
      return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) {
        return `[${value.map(canonicalV57StoreJson).join(",")}]`;
      }
      return `{${Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) =>
          `${JSON.stringify(key)}:${canonicalV57StoreJson(entry)}`
        ).join(",")}}`;
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      throw new TypeError("Fixture v57 HMAC requires a JSON value");
  }
  throw new TypeError("Fixture v57 HMAC requires a JSON value");
}

function advanceV57AccountGeneration(
  database: Database,
  generation: number,
): number {
  const profile = database.query<
    { process_generation: number; revision: number },
    [string]
  >(`
    SELECT process_generation, revision FROM account_profiles
    WHERE profile_id = ?1
  `).get(ACCOUNT);
  if (
    profile === null ||
    generation !== profile.process_generation + 1
  ) {
    throw new Error("Fixture v57 generation cannot advance");
  }
  const revision = profile.revision + 1;
  const changed = database.query(`
    UPDATE account_profiles SET process_generation = ?2,
      revision = ?3, updated_at = ?4
    WHERE profile_id = ?1 AND revision = ?5 AND removed_at IS NULL
  `).run(
    ACCOUNT,
    generation,
    revision,
    NOW.toISOString(),
    profile.revision,
  );
  if (changed.changes !== 1) {
    throw new Error("Fixture v57 generation changed concurrently");
  }
  return revision;
}

type SealedV57MemberFixture = Readonly<{
  cutId: string;
  sibling: ReturnType<typeof seedV57OrdinaryProviderPane>;
  siblingMember: ReturnType<
    ChatPaneStore["enumerateProviderThreadArchiveSourceOwnershipV57"]
  >["members"][number];
  target: ReturnType<typeof prepareV57Target>;
  message: Readonly<{
    messageId: string;
    turnId: string;
    revision: number;
    kind: "start" | "steer";
  }> | null;
}>;

function sealV57MemberFixture(input: Readonly<{
  store: ChatPaneStore;
  journal: ProviderThreadArchiveJournalV57;
  database: Database;
  suffix: string;
  exactBinding?: boolean;
  claim?: "start_claimed" | "steer_prepared";
}>): SealedV57MemberFixture {
  seedV57OrdinaryProviderPane({
    store: input.store,
    database: input.database,
    paneId: PANE,
    suffix: `${input.suffix}_target`,
  });
  const siblingPaneId = `pane_v57_${input.suffix}_sibling`;
  const sibling = seedV57OrdinaryProviderPane({
    store: input.store,
    database: input.database,
    paneId: siblingPaneId,
    suffix: `${input.suffix}_sibling`,
    ownership: "effectStarted",
  });
  if (input.exactBinding === true) {
    retainExactV57AttachmentBinding(
      input.database,
      siblingPaneId,
      sibling.binding,
    );
  }
  let message: SealedV57MemberFixture["message"] = null;
  if (input.claim !== undefined) {
    const messageId = `chatmsg_v57_${input.suffix}_claim`;
    const turnId = `chatturn_v57_${input.suffix}_claim`;
    const pane = input.store.require(siblingPaneId).projection;
    const enqueued = input.store.enqueueMessageIdempotently({
      paneId: siblingPaneId,
      expectedQueueRevision: pane.messageQueue.revision,
      messageId,
      content: { text: "frozen pre-effect claim", attachmentRefs: [] },
      delivery: input.claim === "steer_prepared"
        ? { kind: "steerHead", expectedTurnId: turnId }
        : { kind: "queue" },
      now: NOW,
    });
    const queued = enqueued.queue.messages[0];
    if (queued === undefined) throw new Error("Expected v57 claim fixture row");
    if (input.claim === "start_claimed") {
      const claimed = input.store.claimHeadMessage({
        paneId: siblingPaneId,
        expectedQueueRevision: enqueued.queue.revision,
        messageId,
        expectedMessageRevision: queued.revision,
        turnId,
        kind: "start",
        now: NOW,
      });
      message = {
        messageId,
        turnId,
        revision: claimed.claim.revision,
        kind: "start",
      };
    } else {
      const prepared = input.database.query(`
        UPDATE chat_message_ledger SET state = 'steer_prepared',
          claimed_turn_id = ?2, revision = revision + 1, updated_at = ?3
        WHERE message_id = ?1 AND state = 'queued'
      `).run(messageId, turnId, NOW.toISOString());
      if (prepared.changes !== 1) throw new Error("Expected prepared steer fixture");
      message = {
        messageId,
        turnId,
        revision: queued.revision + 1,
        kind: "steer",
      };
    }
  }
  const target = prepareV57Target({
    store: input.store,
    paneId: PANE,
    suffix: `${input.suffix}_target`,
  });
  const cutId = `archcut_v57_${input.suffix}`;
  input.store.beginProviderThreadArchiveLostResponseCutV57({
    targetId: target.targetId,
    cutId,
    cause: "ambiguous_response",
    now: NOW,
  });
  const successorRevision = advanceV57AccountGeneration(input.database, 2);
  input.journal.recordFence({
    cutId,
    successorGeneration: 2,
    successorAccountProfileRevision: successorRevision,
    fenceEvidenceDigest: v57Digest("5"),
    fenceRevisionDigest: v57Digest("6"),
    now: NOW,
  });
  const inventory = input.store.enumerateProviderThreadArchiveSourceOwnershipV57({
    cutId,
    accountProfileId: ACCOUNT,
    sourceGeneration: 1,
    now: NOW,
  });
  input.store.sealProviderThreadArchiveSourceInventoryV57({
    cutId,
    now: NOW,
  });
  const siblingMember = inventory.members.find((member) =>
    member.paneId === siblingPaneId
  );
  if (siblingMember === undefined) {
    throw new Error("Expected sealed v57 sibling member");
  }
  return { cutId, sibling, siblingMember, target, message };
}

function createPane(store: ChatPaneStore, paneId = PANE): ChatPaneProjection {
  return store.create({
    paneId,
    repository: {
      id: REPOSITORY,
      name: "Example",
      workingDirectory: "/fixture/example",
    },
    accountProfileId: ACCOUNT,
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
