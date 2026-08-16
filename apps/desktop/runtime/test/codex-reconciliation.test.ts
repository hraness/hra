import { describe, expect, test } from "bun:test";

import {
  reconcilePinnedCodexThreadStart,
  reconcilePinnedCodexTurnInterrupt,
  reconcilePinnedCodexTurnStart,
  pinnedCodexRequests,
  scanPinnedCodexThreadStarts,
  scanPinnedCodexTurns,
  type PinnedCodexMutationFence,
  type PinnedCodexReconciliationReader,
  type PinnedCodexThreadStartScan,
  type PinnedCodexTurn,
  type PinnedCodexTurnScan,
} from "../src/codex";
import { pinnedThreadFixture, pinnedTurnFixture } from "./codex-pinned-fixtures";

const fenced: PinnedCodexMutationFence = {
  previousGenerationTerminated: true,
  exclusiveMutationLease: true,
  externalDeletionExcluded: true,
};

function parsedHistoryItems(items: readonly unknown[]) {
  return pinnedCodexRequests.threadItemsList.outputCodec.parse({
    data: items,
    nextCursor: null,
    backwardsCursor: null,
  }).data;
}

function threadScan(
  active: PinnedCodexThreadStartScan["active"] = [pinnedThreadFixture],
  archived: PinnedCodexThreadStartScan["archived"] = [],
): PinnedCodexThreadStartScan {
  return { complete: true, active, archived };
}

function turnScan(
  status: PinnedCodexTurn["status"] = "completed",
  clientIds: readonly string[] = ["message_owned0001"],
): PinnedCodexTurnScan {
  return {
    complete: true,
    threadId: "thread-1",
    turns: [{
      turn: { ...pinnedTurnFixture, status },
      items: parsedHistoryItems(clientIds.map((clientId, index) => ({
        type: "userMessage" as const,
        id: `item-${String(index)}`,
        clientId,
        content: [{ type: "text", text: "bounded prompt", text_elements: [] }],
      }))),
    }],
  };
}

describe("pinned Codex lost-response reconciliation", () => {
  test("exhausts active and archived thread pages", async () => {
    const requests: Parameters<PinnedCodexReconciliationReader["threadList"]>[0][] = [];
    const reader: Pick<PinnedCodexReconciliationReader, "threadList"> = {
      threadList: (input) => {
        requests.push(input);
        if (input.archived === true) {
          return Promise.resolve({
            data: [{ ...pinnedThreadFixture, id: "thread-archived" }],
            nextCursor: null,
            backwardsCursor: null,
          });
        }
        return Promise.resolve(input.cursor === null
          ? {
              data: [{ ...pinnedThreadFixture, id: "thread-active-1" }],
              nextCursor: "active-next",
              backwardsCursor: null,
            }
          : {
              data: [{ ...pinnedThreadFixture, id: "thread-active-2" }],
              nextCursor: null,
              backwardsCursor: "active-back",
            });
      },
    };

    const scan = await scanPinnedCodexThreadStarts(reader);
    expect(scan.complete).toBeTrue();
    expect(scan.active.map(({ id }) => id)).toEqual([
      "thread-active-1",
      "thread-active-2",
    ]);
    expect(scan.archived.map(({ id }) => id)).toEqual(["thread-archived"]);
    expect(requests).toEqual([
      {
        cursor: null,
        limit: 256,
        sortKey: "created_at",
        sortDirection: "asc",
        archived: false,
      },
      {
        cursor: "active-next",
        limit: 256,
        sortKey: "created_at",
        sortDirection: "asc",
        archived: false,
      },
      {
        cursor: null,
        limit: 256,
        sortKey: "created_at",
        sortDirection: "asc",
        archived: true,
      },
    ]);
  });

  test("exhausts every turn and item page and fails closed on a cursor cycle", async () => {
    const itemRequests: Parameters<
      PinnedCodexReconciliationReader["threadItemsList"]
    >[0][] = [];
    const reader: Pick<
      PinnedCodexReconciliationReader,
      "threadTurnsList" | "threadItemsList"
    > = {
      threadTurnsList: (input) => Promise.resolve(input.cursor === null
        ? {
            data: [{ ...pinnedTurnFixture, id: "turn-1", items: [] }],
            nextCursor: "turn-next",
            backwardsCursor: null,
          }
        : {
            data: [{ ...pinnedTurnFixture, id: "turn-2", items: [] }],
            nextCursor: null,
            backwardsCursor: "turn-back",
          }),
      threadItemsList: (input) => {
        itemRequests.push(input);
        if (input.turnId === "turn-1" && input.cursor === null) {
          return Promise.resolve({
            data: parsedHistoryItems([{
              type: "userMessage",
              id: "item-1",
              clientId: "message_owned0001",
              content: [{ type: "text", text: "first", text_elements: [] }],
            }]),
            nextCursor: "item-next",
            backwardsCursor: null,
          });
        }
        if (input.turnId === "turn-1") {
          return Promise.resolve({
            data: parsedHistoryItems([{
              type: "agentMessage",
              id: "item-2",
              text: "done",
              phase: null,
              memoryCitation: null,
            }]),
            nextCursor: null,
            backwardsCursor: "item-back",
          });
        }
        return Promise.resolve({
          data: parsedHistoryItems([{
            type: "userMessage",
            id: "item-3",
            clientId: "message_owned0002",
            content: [{ type: "text", text: "second", text_elements: [] }],
          }]),
          nextCursor: null,
          backwardsCursor: null,
        });
      },
    };

    const scan = await scanPinnedCodexTurns(reader, "thread-1");
    expect(scan).toMatchObject({
      complete: true,
      threadId: "thread-1",
      turns: [
        { turn: { id: "turn-1" }, items: [{ id: "item-1" }, { id: "item-2" }] },
        { turn: { id: "turn-2" }, items: [{ id: "item-3" }] },
      ],
    });
    expect(itemRequests.map(({ turnId, cursor }) => [turnId, cursor])).toEqual([
      ["turn-1", null],
      ["turn-1", "item-next"],
      ["turn-2", null],
    ]);

    const cyclic = await scanPinnedCodexTurns({
      threadTurnsList: () => Promise.resolve({
        data: [],
        nextCursor: "cycle",
        backwardsCursor: null,
      }),
      threadItemsList: reader.threadItemsList,
    }, "thread-1");
    expect(cyclic.complete).toBeFalse();
  });

  test("fails closed when exhaustive turn evidence exceeds the owned bound", async () => {
    let turnPages = 0;
    let itemPages = 0;
    const scan = await scanPinnedCodexTurns({
      threadTurnsList: () => {
        const page = turnPages;
        turnPages += 1;
        return Promise.resolve({
          data: Array.from({ length: 128 }, (_, index) => ({
            ...pinnedTurnFixture,
            id: `turn-${String(page * 128 + index)}`,
            items: [],
          })),
          nextCursor: `page-${String(turnPages)}`,
          backwardsCursor: null,
        });
      },
      threadItemsList: () => {
        itemPages += 1;
        return Promise.resolve({ data: [], nextCursor: null, backwardsCursor: null });
      },
    }, "thread-1");

    expect(scan.complete).toBeFalse();
    expect(turnPages).toBe(79);
    expect(itemPages).toBe(0);
  });

  test("binds thread/start only to one stable exact thread-source identity", () => {
    const identity = {
      threadSource: pinnedThreadFixture.threadSource,
      cwd: pinnedThreadFixture.cwd,
      ephemeral: pinnedThreadFixture.ephemeral,
      historyMode: pinnedThreadFixture.historyMode,
    } as const;
    const scan = threadScan();
    expect(reconcilePinnedCodexThreadStart(identity, scan, scan, fenced)).toEqual({
      kind: "applied",
      threadId: "thread-1",
    });
    expect(reconcilePinnedCodexThreadStart(
      { ...identity, cwd: "/tmp/other" },
      scan,
      scan,
      fenced,
    )).toEqual({ kind: "ambiguous", reason: "identity_mismatch" });
    const duplicate = threadScan([
      pinnedThreadFixture,
      { ...pinnedThreadFixture, id: "thread-2" },
    ]);
    expect(reconcilePinnedCodexThreadStart(identity, duplicate, duplicate, fenced)).toEqual({
      kind: "ambiguous",
      reason: "duplicate_identity",
    });
  });

  test("classifies stable absence only after the complete generation fence", () => {
    const empty = threadScan([]);
    const identity = {
      threadSource: "oprte_missing_thread",
      cwd: "/tmp/oprte-worktree",
      ephemeral: false,
      historyMode: "paginated" as const,
    };
    expect(reconcilePinnedCodexThreadStart(
      identity,
      empty,
      empty,
      { ...fenced, previousGenerationTerminated: false },
    )).toEqual({ kind: "pending", reason: "generation_not_fenced" });
    expect(reconcilePinnedCodexThreadStart(identity, empty, empty, fenced)).toEqual({
      kind: "not_applied",
    });
  });

  test("binds turn/start by one exact clientUserMessageId across exhaustive item pages", () => {
    const scan = turnScan();
    expect(reconcilePinnedCodexTurnStart(
      "message_owned0001",
      scan,
      scan,
      fenced,
    )).toEqual({ kind: "applied", threadId: "thread-1", turnId: "turn-1" });
    const duplicate = turnScan("completed", ["message_owned0001", "message_owned0001"]);
    expect(reconcilePinnedCodexTurnStart(
      "message_owned0001",
      duplicate,
      duplicate,
      fenced,
    )).toEqual({ kind: "ambiguous", reason: "duplicate_client_message_id" });
    const active = turnScan("inProgress", []);
    expect(reconcilePinnedCodexTurnStart("message_owned0001", active, active, fenced)).toEqual({
      kind: "pending",
      reason: "turn_active",
    });
    const terminal = turnScan("completed", []);
    expect(reconcilePinnedCodexTurnStart(
      "message_owned0001",
      terminal,
      terminal,
      fenced,
    )).toEqual({ kind: "not_applied" });
  });

  test("keeps interrupt pending until one stable terminal turn is observed", () => {
    const active = turnScan("inProgress");
    expect(reconcilePinnedCodexTurnInterrupt("turn-1", active, active)).toEqual({
      kind: "pending",
      reason: "turn_in_progress",
    });
    for (const [status, kind] of [
      ["interrupted", "cancelled"],
      ["completed", "completed"],
      ["failed", "failed"],
    ] as const) {
      const terminal = turnScan(status);
      expect(reconcilePinnedCodexTurnInterrupt("turn-1", terminal, terminal)).toEqual({ kind });
    }
    expect(reconcilePinnedCodexTurnInterrupt("missing", active, active)).toEqual({
      kind: "ambiguous",
      reason: "missing_turn",
    });
  });
});
