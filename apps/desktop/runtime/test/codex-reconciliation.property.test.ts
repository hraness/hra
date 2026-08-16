import { expect, test } from "bun:test";
import { fc } from "@hra-internal/test";

import {
  reconcilePinnedCodexThreadStart,
  reconcilePinnedCodexTurnInterrupt,
  reconcilePinnedCodexTurnStart,
  pinnedCodexRequests,
  pinnedCodexTurnScanEvidenceDigest,
  pinnedCodexTurnScansHaveExactEvidence,
  scanPinnedCodexTurns,
  type PinnedCodexReconciliationReader,
  type PinnedCodexThreadStartScan,
  type PinnedCodexTurnScan,
} from "../src/codex";
import { pinnedThreadFixture, pinnedTurnFixture } from "./codex-pinned-fixtures";

const fence = {
  previousGenerationTerminated: true,
  exclusiveMutationLease: true,
  externalDeletionExcluded: true,
} as const;

function parsedHistoryItems(items: readonly unknown[]) {
  return pinnedCodexRequests.threadItemsList.outputCodec.parse({
    data: items,
    nextCursor: null,
    backwardsCursor: null,
  }).data;
}

test("thread-start reconciliation is invariant to complete page ordering", () => {
  fc.assert(fc.property(
    fc.uniqueArray(fc.integer({ min: 1, max: 10_000 }), { minLength: 1, maxLength: 32 }),
    (ids) => {
      const target = ids[0]!;
      const threads = ids.map((id) => ({
        ...pinnedThreadFixture,
        id: `thread-${String(id)}`,
        threadSource: id === target ? "oprte_target_source" : `oprte_source_${String(id)}`,
        turns: pinnedThreadFixture.turns.map((turn) => ({
          ...turn,
          items: turn.items.map((item) => ({ ...item })),
        })),
      }));
      const first: PinnedCodexThreadStartScan = {
        complete: true,
        active: threads,
        archived: [],
      };
      const second: PinnedCodexThreadStartScan = {
        complete: true,
        active: [...threads].reverse(),
        archived: [],
      };
      expect(reconcilePinnedCodexThreadStart({
        threadSource: "oprte_target_source",
        cwd: pinnedThreadFixture.cwd,
        ephemeral: false,
        historyMode: "paginated",
      }, first, second, fence)).toEqual({
        kind: "applied",
        threadId: `thread-${String(target)}`,
      });
    },
  ), { numRuns: 200 });
});

test("a duplicated client message identity can never reconcile as applied", () => {
  fc.assert(fc.property(
    fc.stringMatching(/^message_[A-Za-z0-9_-]{8,32}$/u),
    fc.integer({ min: 2, max: 32 }),
    (clientId, count) => {
      const scan: PinnedCodexTurnScan = {
        complete: true,
        threadId: "thread-property",
        turns: Array.from({ length: count }, (_, index) => ({
          turn: { ...pinnedTurnFixture, id: `turn-${String(index)}` },
          items: parsedHistoryItems([{
            type: "userMessage" as const,
            id: `item-${String(index)}`,
            clientId,
            content: [{ type: "text", text: "prompt", text_elements: [] }],
          }]),
        })),
      };
      expect(reconcilePinnedCodexTurnStart(clientId, scan, scan, fence)).toEqual({
        kind: "ambiguous",
        reason: "duplicate_client_message_id",
      });
    },
  ), { numRuns: 200 });
});

test("exhaustive turn scanning is invariant to turn and item page sizes", async () => {
  await fc.assert(fc.asyncProperty(
    fc.uniqueArray(fc.integer({ min: 1, max: 10_000 }), {
      minLength: 1,
      maxLength: 24,
    }),
    fc.integer({ min: 1, max: 7 }),
    fc.integer({ min: 1, max: 3 }),
    async (ids, turnPageSize, itemPageSize) => {
      const turns = ids.map((id) => ({
        ...pinnedTurnFixture,
        id: `turn-${String(id)}`,
        items: [],
      }));
      const items = new Map(turns.map((turn) => [turn.id, parsedHistoryItems(
        [0, 1, 2].map((index) => ({
          type: "userMessage" as const,
          id: `${turn.id}-item-${String(index)}`,
          clientId: `${turn.id}-message-${String(index)}`,
          content: [{ type: "text", text: "prompt", text_elements: [] }],
        })),
      )]));
      const reader: Pick<
        PinnedCodexReconciliationReader,
        "threadTurnsList" | "threadItemsList"
      > = {
        threadTurnsList: (input) => {
          const offset = Number(input.cursor ?? "0");
          const data = turns.slice(offset, offset + turnPageSize);
          const nextOffset = offset + data.length;
          return Promise.resolve({
            data,
            nextCursor: nextOffset < turns.length ? String(nextOffset) : null,
            backwardsCursor: null,
          });
        },
        threadItemsList: (input) => {
          const allItems = items.get(input.turnId ?? "") ?? [];
          const offset = Number(input.cursor ?? "0");
          const data = allItems.slice(offset, offset + itemPageSize);
          const nextOffset = offset + data.length;
          return Promise.resolve({
            data,
            nextCursor: nextOffset < allItems.length ? String(nextOffset) : null,
            backwardsCursor: null,
          });
        },
      };

      const scan = await scanPinnedCodexTurns(reader, "thread-property");
      expect(scan.complete).toBeTrue();
      expect(scan.turns.map(({ turn }) => turn.id)).toEqual(
        turns.map(({ id }) => id),
      );
      expect(scan.turns.flatMap(({ items: turnItems }) =>
        turnItems.map(({ id }) => id))).toEqual(
        turns.flatMap((turn) => items.get(turn.id)!.map(({ id }) => id)),
      );
    },
  ), { numRuns: 100 });
});

test("ordered scan evidence detects every turn-order and visible-text mutation", () => {
  fc.assert(fc.property(
    fc.uniqueArray(fc.integer({ min: 1, max: 10_000 }), {
      minLength: 2,
      maxLength: 24,
    }),
    fc.string({ minLength: 1, maxLength: 64 }),
    (ids, changedText) => {
      const scan: PinnedCodexTurnScan = {
        complete: true,
        threadId: "thread-property",
        turns: ids.map((id) => ({
          turn: { ...pinnedTurnFixture, id: `turn-${String(id)}` },
          items: parsedHistoryItems([{
            type: "agentMessage" as const,
            id: `item-${String(id)}`,
            phase: "final_answer" as const,
            text: "stable",
            memoryCitation: null,
          }]),
        })),
      };
      const clone: PinnedCodexTurnScan = structuredClone(scan);
      expect(pinnedCodexTurnScansHaveExactEvidence(scan, clone)).toBeTrue();
      expect(pinnedCodexTurnScanEvidenceDigest(scan)).toBe(
        pinnedCodexTurnScanEvidenceDigest(clone),
      );

      const reordered: PinnedCodexTurnScan = {
        ...scan,
        turns: [...scan.turns].reverse(),
      };
      expect(pinnedCodexTurnScansHaveExactEvidence(scan, reordered)).toBeFalse();

      const changed: PinnedCodexTurnScan = {
        ...scan,
        turns: scan.turns.map((entry, index) => index === 0
          ? {
              ...entry,
              items: parsedHistoryItems([{
                type: "agentMessage",
                id: entry.items[0]!.id,
                phase: "final_answer",
                text: `stable:${changedText}`,
                memoryCitation: null,
              }]),
            }
          : entry),
      };
      expect(pinnedCodexTurnScansHaveExactEvidence(scan, changed)).toBeFalse();
      expect(pinnedCodexTurnScanEvidenceDigest(scan)).not.toBe(
        pinnedCodexTurnScanEvidenceDigest(changed),
      );
    },
  ), { numRuns: 200 });
});

test("attachment-only and structured-metadata mutations cannot share scan evidence", () => {
  fc.assert(fc.property(
    fc.constantFrom("image", "localImage", "skill", "mention", "textElement"),
    fc.stringMatching(/^[A-Za-z0-9_-]{1,32}$/u),
    fc.stringMatching(/^[A-Za-z0-9_-]{1,32}$/u)
      .filter((right) => right !== "left"),
    (kind, leftValue, candidateRightValue) => {
      const rightValue = candidateRightValue === leftValue
        ? `${candidateRightValue}_changed`
        : candidateRightValue;
      const structured = (value: string) => kind === "textElement"
        ? [{
            type: "text" as const,
            text: "stable visible text",
            text_elements: [{
              byteRange: { start: 0, end: 6 },
              placeholder: value,
            }],
          }]
        : [{ type: "text" as const, text: "stable visible text", text_elements: [] },
            kind === "image"
              ? { type: "image" as const, url: `https://example.test/${value}` }
              : kind === "localImage"
                ? { type: "localImage" as const, path: `/tmp/${value}.png` }
                : kind === "skill"
                  ? { type: "skill" as const, name: "skill", path: `/tmp/${value}` }
                  : { type: "mention" as const, name: "mention", path: `/tmp/${value}` }];
      const scan = (value: string): PinnedCodexTurnScan => ({
        complete: true,
        threadId: "thread-property",
        turns: [{
          turn: { ...pinnedTurnFixture, id: "turn-structured" },
          items: parsedHistoryItems([{
            type: "userMessage",
            id: "item-structured",
            clientId: "message_structured0001",
            content: structured(value),
          }]),
        }],
      });
      const first = scan(leftValue);
      const second = scan(rightValue);
      expect(first.turns[0]?.items[0]).toMatchObject({
        context: { kind: "nonRepresentable" },
      });
      expect(pinnedCodexTurnScansHaveExactEvidence(first, second)).toBeFalse();
      expect(pinnedCodexTurnScanEvidenceDigest(first)).not.toBe(
        pinnedCodexTurnScanEvidenceDigest(second),
      );
      expect(reconcilePinnedCodexTurnStart(
        "message_structured0001",
        first,
        second,
        fence,
      )).toEqual({ kind: "pending", reason: "unstable_scan" });
    },
  ), { numRuns: 200 });
});

test("assistant metadata-only mutations cannot admit an otherwise stable turn", () => {
  fc.assert(fc.property(
    fc.stringMatching(/^[A-Za-z0-9 _-]{1,64}$/u),
    fc.stringMatching(/^[A-Za-z0-9 _-]{1,64}$/u),
    (leftNote, candidateRightNote) => {
      const rightNote = candidateRightNote === leftNote
        ? `${candidateRightNote} changed`
        : candidateRightNote;
      const scan = (note: string): PinnedCodexTurnScan => ({
        complete: true,
        threadId: "thread-property",
        turns: [{
          turn: { ...pinnedTurnFixture, id: "turn-metadata" },
          items: parsedHistoryItems([{
            type: "userMessage",
            id: "item-user",
            clientId: "message_metadata0001",
            content: [{ type: "text", text: "stable", text_elements: [] }],
          }, {
            type: "agentMessage",
            id: "item-assistant",
            phase: "final_answer",
            text: "stable answer",
            memoryCitation: {
              entries: [{
                path: "/tmp/evidence.md",
                lineStart: 1,
                lineEnd: 1,
                note,
              }],
              threadIds: [],
            },
          }]),
        }],
      });
      const first = scan(leftNote);
      const second = scan(rightNote);
      expect(first.turns[0]?.items[1]).toMatchObject({
        context: { kind: "nonRepresentable" },
      });
      expect(pinnedCodexTurnScansHaveExactEvidence(first, second)).toBeFalse();
      expect(pinnedCodexTurnScanEvidenceDigest(first)).not.toBe(
        pinnedCodexTurnScanEvidenceDigest(second),
      );
      expect(reconcilePinnedCodexTurnStart(
        "message_metadata0001",
        first,
        second,
        fence,
      )).toEqual({ kind: "pending", reason: "unstable_scan" });
    },
  ), { numRuns: 200 });
});

test("interrupt reconciliation returns a terminal result only for a persisted terminal status", () => {
  fc.assert(fc.property(
    fc.constantFrom("inProgress", "interrupted", "completed", "failed"),
    (status) => {
      const scan: PinnedCodexTurnScan = {
        complete: true,
        threadId: "thread-property",
        turns: [{
          turn: { ...pinnedTurnFixture, status },
          items: [],
        }],
      };
      const result = reconcilePinnedCodexTurnInterrupt("turn-1", scan, scan);
      expect(result.kind === "pending").toBe(status === "inProgress");
      expect(result.kind === "cancelled").toBe(status === "interrupted");
      expect(result.kind === "completed").toBe(status === "completed");
      expect(result.kind === "failed").toBe(status === "failed");
    },
  ), { numRuns: 200 });
});
