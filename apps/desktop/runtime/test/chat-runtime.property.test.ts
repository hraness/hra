import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { assertProperty, fc, propertyParameters } from "@hra-internal/test";

import {
  CHAT_MAX_DELTA_UTF8_BYTES,
  CHAT_MAX_PANES,
  rankChatAccountCandidates,
  type ChatAccountCandidate,
} from "../src/chat";
import type { ChatPaneActivity } from "../../contracts/runtime";
import { utf8ByteLength, utf8Chunks } from "../src/chat/text-bounds";
import { applyMigrations } from "../src/state/database";
import {
  ChatPaneStore,
  ChatPaneStoreError,
  harnessObserverPaneId,
} from "../src/state/chat-pane-store";

const ACCOUNT = "acct_property0001";
const PANE_A = "pane_property0001";
const PANE_B = "pane_property0002";
const REPOSITORY = `repo_${"2".repeat(26)}`;
const NOW = new Date("2026-08-03T12:00:00.000Z");
const ASSISTANT_ITEM = "item_propertyassist1";
const safeCharacter = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  "é",
  "界",
  "🙂",
  "\n",
);
const boundedText = fc.array(safeCharacter, { minLength: 1, maxLength: 120 })
  .map((characters) => `x${characters.join("")}`);
const PROPERTY_TIMEOUT = propertyParameters.interruptAfterTimeLimit + 5_000;

test("arbitrary Unicode display text splits into exact contract-safe chunks", () => {
  assertProperty(fc.property(
    fc.array(safeCharacter, { maxLength: 20_000 }).map((characters) => characters.join("")),
    (value) => {
      const chunks = utf8Chunks(value, CHAT_MAX_DELTA_UTF8_BYTES);
      expect(chunks.join("")).toBe(value);
      expect(chunks.every((chunk) => (
        chunk.length > 0 && utf8ByteLength(chunk) <= CHAT_MAX_DELTA_UTF8_BYTES
      ))).toBeTrue();
    },
  ), { numRuns: 100 });
});

test("account ranking is permutation-stable, cycle-free, and degrades without blocking", () => {
  assertProperty(fc.property(
    fc.uniqueArray(fc.integer({ min: 0, max: 999 }), { maxLength: 24 }),
    fc.array(fc.constantFrom(
      "healthy" as const,
      "low" as const,
      "exhausted" as const,
      "unknown" as const,
    ), { minLength: 1, maxLength: 24 }),
    fc.integer({ min: 0, max: 999 }),
    (numbers, budgets, preferredNumber) => {
      const candidates: ChatAccountCandidate[] = numbers.map((number, index) => ({
        id: accountId(number),
        selected: index === 0,
        budget: budgets[index % budgets.length] ?? "unknown",
      }));
      const visited = candidates.filter((_, index) => index % 3 === 0).map(({ id }) => id);
      const preferred = accountId(preferredNumber);
      const forward = rankChatAccountCandidates(candidates, preferred, visited);
      const reverse = rankChatAccountCandidates(candidates.toReversed(), preferred, visited);
      expect(reverse).toEqual(forward);
      expect(new Set(forward.map(({ id }) => id)).size).toBe(forward.length);
      expect(new Set(forward.map(({ id }) => id))).toEqual(new Set(candidates
        .filter(({ id, budget }) => budget !== "exhausted" && !visited.includes(id))
        .map(({ id }) => id)));
      const ranks = forward.map(({ budget }) => ({
        healthy: 0,
        unknown: 1,
        low: 2,
        exhausted: 3,
      })[budget]);
      expect(ranks).toEqual(ranks.toSorted((left, right) => left - right));
    },
  ), { numRuns: 100 });
});

test("unknown and low accounts remain usable after every healthy account is unavailable", () => {
  const unknown = accountId(1);
  const low = accountId(2);
  const exhausted = accountId(3);
  const ranked = rankChatAccountCandidates([
    { id: low, selected: true, budget: "low" },
    { id: exhausted, selected: false, budget: "exhausted" },
    { id: unknown, selected: false, budget: "unknown" },
  ], low, []);
  expect(ranked.map(({ id }) => id)).toEqual([unknown, low]);
  expect(rankChatAccountCandidates([
    { id: unknown, selected: true, budget: "unknown" },
    { id: low, selected: false, budget: "low" },
  ], unknown, [unknown]).map(({ id }) => id)).toEqual([low]);
});

test("pane-local CAS transitions commute across independent panes", () => {
  assertProperty(fc.property(boundedText, boundedText, (leftTitle, rightTitle) => {
    const leftFirst = withStore((store) => {
      const [left, right] = createPair(store);
      store.rename(PANE_A, left.revision, leftTitle, NOW);
      store.rename(PANE_B, right.revision, rightTitle, NOW);
      return store.list();
    });
    const rightFirst = withStore((store) => {
      const [left, right] = createPair(store);
      store.rename(PANE_B, right.revision, rightTitle, NOW);
      store.rename(PANE_A, left.revision, leftTitle, NOW);
      return store.list();
    });
    expect(rightFirst).toEqual(leftFirst);
  }), { numRuns: 100 });
});

test("random pane allocation preserves contiguous creation order across restarts", () => {
  assertProperty(fc.property(
    fc.array(fc.record({
      kind: fc.constantFrom(
        "create" as const,
        "create" as const,
        "create" as const,
        "remove" as const,
        "restart" as const,
      ),
      target: fc.nat({ max: 255 }),
    }), { minLength: 1, maxLength: 128 }),
    (actions) => withStore((initialStore, database) => {
      let store = initialStore;
      let nextPane = 0;
      const expected: string[] = [];

      for (const [step, action] of actions.entries()) {
        if (action.kind === "restart") {
          store = new ChatPaneStore(database);
        } else if (action.kind === "remove") {
          const index = action.target % Math.max(expected.length, 1);
          const paneId = expected[index];
          if (paneId !== undefined) {
            const pane = store.require(paneId).projection;
            store.remove(paneId, pane.revision);
            expected.splice(index, 1);
          }
        } else {
          const paneId = `pane_allocproperty${String(nextPane).padStart(6, "0")}`;
          nextPane += 1;
          if (expected.length === CHAT_MAX_PANES) {
            expect(() => store.create({
              paneId,
              repository: {
                id: REPOSITORY,
                name: "Example",
                workingDirectory: "/fixture/example",
              },
              accountProfileId: ACCOUNT,
              now: new Date(NOW.getTime() + step),
            })).toThrow(expect.objectContaining({ code: "limit" }));
          } else {
            store.create({
              paneId,
              repository: {
                id: REPOSITORY,
                name: "Example",
                workingDirectory: "/fixture/example",
              },
              accountProfileId: ACCOUNT,
              now: new Date(NOW.getTime() + step),
            });
            expected.push(paneId);
          }
        }

        const actual = store.list();
        expect(actual.length).toBeLessThanOrEqual(CHAT_MAX_PANES);
        expect(actual.map(({ id }) => id)).toEqual(expected);
      }

      store = new ChatPaneStore(database);
      expect(store.list().map(({ id }) => id)).toEqual(expected);
    }),
  ), { numRuns: 100 });
}, PROPERTY_TIMEOUT);

test("arbitrary activity traces preserve exact order across restarts", () => {
  assertProperty(fc.property(
    fc.array(fc.constantFrom(
      "tool" as const,
      "thinking" as const,
      "restart" as const,
      "stale" as const,
      "invalidComplete" as const,
      "approval" as const,
      "failure" as const,
    ), { minLength: 1, maxLength: 128 }),
    (actions) => withStore((initialStore, database) => {
      let store = initialStore;
      const created = createPane(store, PANE_A);
      store.beginTurn({
        paneId: PANE_A,
        expectedRevision: created.revision,
        turnId: "chatturn_activityproperty",
        prompt: "activity property prompt",
        now: NOW,
      });
      let expectedOrdinal = 1;
      let terminal = false;
      let expectedActivity: ChatPaneActivity = {
        ordinal: expectedOrdinal,
        kind: "messageSent" as const,
      };

      for (const action of actions) {
        const before = store.require(PANE_A);
        if (action === "restart") {
          store = new ChatPaneStore(database);
        } else if (action === "stale") {
          expect(store.recordToolStarted(PANE_A, "chatturn_activitystale", NOW)).toBeNull();
        } else if (action === "invalidComplete") {
          if (terminal) {
            expect(store.completeTurn(PANE_A, "chatturn_activityproperty", NOW)).toBeNull();
          } else {
            expect(() => store.completeTurn(PANE_A, "chatturn_activityproperty", NOW))
              .toThrow(expect.objectContaining({ code: "invalid_state" }));
          }
        } else if (action === "approval" || action === "failure") {
          const result = store.enterAttention({
            paneId: PANE_A,
            turnId: "chatturn_activityproperty",
            attention: {
              code: action === "approval" ? "approval_required" : "turn_failed",
              message: "Property terminal",
              retryable: true,
            },
            clearBinding: false,
            now: NOW,
          });
          if (terminal) {
            expect(result).toBeNull();
          } else {
            expect(result?.state).toBe("attention");
            expect(result?.activity).toEqual(expectedActivity);
            terminal = true;
          }
        } else if (action === "tool") {
          const result = store.recordToolStarted(PANE_A, "chatturn_activityproperty", NOW);
          if (terminal) {
            expect(result).toBeNull();
          } else {
            expectedOrdinal += 1;
            expectedActivity = { ordinal: expectedOrdinal, kind: "toolStarted" };
            expect(result?.activity).toEqual(expectedActivity);
          }
        } else {
          const result = store.recordThinkingCompleted(PANE_A, "chatturn_activityproperty", NOW);
          if (terminal) {
            expect(result).toBeNull();
          } else {
            expectedOrdinal += 1;
            expectedActivity = {
              ordinal: expectedOrdinal,
              kind: "thinkingCompleted",
            };
            expect(result?.activity).toEqual(expectedActivity);
          }
        }

        const after = store.require(PANE_A);
        expect(after.projection.activity).toEqual(expectedActivity);
        if (
          action === "restart" || action === "stale" || action === "invalidComplete" ||
          (terminal && (action === "tool" || action === "thinking"))
        ) {
          expect(after.projection.activity).toEqual(before.projection.activity);
        }
      }

      const restarted = new ChatPaneStore(database).require(PANE_A);
      expect(restarted.projection.activity).toEqual(expectedActivity);
      expect(restarted.projection.activity.kind).not.toBe("responseCompleted");
    }),
  ), { numRuns: 100 });
}, PROPERTY_TIMEOUT);

test("every arbitrary stale revision is rejected without changing pane state", () => {
  assertProperty(fc.property(
    fc.integer({ min: 2, max: Number.MAX_SAFE_INTEGER }),
    boundedText,
    (staleRevision, title) => withStore((store) => {
      const created = createPane(store, PANE_A);
      const before = store.require(PANE_A).projection;
      try {
        store.rename(PANE_A, staleRevision, title, NOW);
        throw new Error("Expected stale revision rejection");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ChatPaneStoreError);
        expect((error as ChatPaneStoreError).code).toBe("revision_conflict");
      }
      expect(store.require(PANE_A).projection).toEqual(before);
      expect(created.revision).toBe(1);
    }),
  ), { numRuns: 100 });
});

test("harness observer replay stays exact at capacity and a 65th identity never enters", () => {
  assertProperty(fc.property(
    fc.integer({ min: 0, max: 999_999 }),
    (seed) => withStore((store, database) => {
      for (let index = 0; index < CHAT_MAX_PANES - 1; index += 1) {
        store.create({
          paneId: `pane_capacity${String(index).padStart(8, "0")}`,
          repository: {
            id: REPOSITORY,
            name: "Example",
            workingDirectory: "/fixture/example",
          },
          accountProfileId: ACCOUNT,
          now: new Date(NOW.getTime() + index),
        });
      }
      const actorId = `hactor_propertyobserver${String(seed).padStart(6, "0")}`;
      const input = {
        actorId,
        repository: {
          id: REPOSITORY,
          name: "Example",
          workingDirectory: "/fixture/example",
        },
        binding: {
          accountProfileId: ACCOUNT,
          threadId: `thread_property_observer_${String(seed)}`,
          restartThreadId: `raw_thread_property_observer_${String(seed)}`,
        },
        title: `Observer ${String(seed)}`,
        now: new Date(NOW.getTime() + CHAT_MAX_PANES),
      } as const;
      const created = database.transaction(() =>
        store.createAttachedHarnessSession(input)
      )();
      expect(created.kind).toBe("created");
      expect(created.pane.id).toBe(harnessObserverPaneId(actorId));
      expect(store.list()).toHaveLength(CHAT_MAX_PANES);

      const restarted = new ChatPaneStore(database);
      expect(database.transaction(() =>
        restarted.createAttachedHarnessSession(input)
      )()).toEqual({ kind: "replayed", pane: created.pane });
      expect(() => database.transaction(() =>
        restarted.createAttachedHarnessSession({ ...input, title: `${input.title} changed` })
      )()).toThrow(expect.objectContaining({ code: "conflict" }));
      expect(() => database.transaction(() =>
        restarted.createAttachedHarnessSession({
          ...input,
          actorId: `${actorId}next`,
          binding: {
            ...input.binding,
            threadId: `${input.binding.threadId}_next`,
            restartThreadId: `${input.binding.restartThreadId}_next`,
          },
        })
      )()).toThrow(expect.objectContaining({ code: "limit" }));
      expect(store.list()).toHaveLength(CHAT_MAX_PANES);
    }),
  ), { numRuns: 40, timeout: PROPERTY_TIMEOUT });
});

test("arbitrary attached-actor completions survive restart and never admit a duplicate turn", () => {
  assertProperty(fc.property(
    fc.array(fc.record({
      prompt: boundedText,
      response: boundedText,
      restartBeforeCompletion: fc.boolean(),
      replayCompletion: fc.boolean(),
    }), { minLength: 1, maxLength: 16 }),
    (turns) => withStore((initialStore, database) => {
      let store = initialStore;
      const pane = database.transaction(() => store.createAttachedHarnessSession({
        actorId: "hactor_propertymessaging01",
        repository: {
          id: REPOSITORY,
          name: "Example",
          workingDirectory: "/fixture/example",
        },
        binding: {
          accountProfileId: ACCOUNT,
          threadId: "thread_property_messaging",
          restartThreadId: "raw_thread_property_messaging",
        },
        title: "Messaging observer",
        now: NOW,
      }))().pane;
      const expectedHistory: Array<Readonly<{
        role: "user" | "assistant";
        text: string;
      }>> = [];

      for (const [index, action] of turns.entries()) {
        const turnId = `chatturn_actorproperty${String(index).padStart(4, "0")}`;
        const current = store.require(pane.id).projection;
        expect(store.beginAttachedHarnessTurn({
          paneId: pane.id,
          expectedRevision: current.revision,
          turnId,
          prompt: action.prompt,
          now: new Date(NOW.getTime() + index * 10 + 1),
        }).kind).toBe("begun");
        if (action.restartBeforeCompletion) store = new ChatPaneStore(database);
        const completed = store.completeAttachedHarnessTurn({
          paneId: pane.id,
          turnId,
          markdown: action.response,
          now: new Date(NOW.getTime() + index * 10 + 2),
        });
        expect(completed).toMatchObject({
          state: "ready",
          turn: {
            id: turnId,
            status: "completed",
            responseMarkdown: { tail: action.response },
          },
        });
        if (action.replayCompletion) {
          expect(store.completeAttachedHarnessTurn({
            paneId: pane.id,
            turnId,
            markdown: action.response,
            now: new Date(NOW.getTime() + index * 10 + 3),
          })).toEqual(completed);
        }
        expect(() => store.beginAttachedHarnessTurn({
          paneId: pane.id,
          expectedRevision: completed!.revision,
          turnId,
          prompt: action.prompt,
          now: new Date(NOW.getTime() + index * 10 + 4),
        })).toThrow(expect.objectContaining({ code: "conflict" }));
        expectedHistory.push(
          { role: "user", text: action.prompt },
          { role: "assistant", text: action.response },
        );
        expect(store.handoffHistory(pane.id, false)).toEqual({
          complete: true,
          items: expectedHistory,
        });
      }
      const receipt = database.query(
        "SELECT COUNT(*) AS count FROM chat_turn_receipts WHERE pane_id = ?1",
      ).get(pane.id) as { count: number };
      expect(receipt.count).toBe(turns.length);
    }),
  ), { numRuns: 100, timeout: PROPERTY_TIMEOUT });
}, PROPERTY_TIMEOUT);

test("arbitrary delta/tool traces preserve transition and byte-accounting laws", () => {
  assertProperty(fc.property(
    fc.array(boundedText, { minLength: 1, maxLength: 32 }),
    fc.array(fc.boolean(), { maxLength: 16 }),
    (deltas, tools) => withStore((store) => {
      const created = createPane(store, PANE_A);
      const turnId = "chatturn_property01";
      store.beginTurn({
        paneId: PANE_A,
        expectedRevision: created.revision,
        turnId,
        prompt: "property prompt",
        now: NOW,
      });
      store.reserveAccount(PANE_A, turnId, ACCOUNT, NOW);
      store.prepareProviderThread(PANE_A, turnId, {
        accountProfileId: ACCOUNT,
        threadId: "thread_property_1",
        restartThreadId: "raw_thread_property_1",
      }, NOW);
      store.markTurnAccepted(PANE_A, turnId, "turn_property_1", NOW);
      let expectedOffset = 0;
      for (const delta of deltas) {
        const result = store.appendDelta({
          paneId: PANE_A,
          turnId,
          channel: "responseMarkdown",
          delta,
          assistantMessageId: ASSISTANT_ITEM,
          now: NOW,
        });
        expect(result?.delta.startUtf8Offset).toBe(expectedOffset);
        expectedOffset += utf8ByteLength(delta);
      }
      for (const complete of tools) {
        store.startTool(PANE_A, turnId, "other", NOW);
        if (complete) store.completeTool(PANE_A, turnId, "other", NOW);
      }
      store.reconcileAssistantCompletion({
        paneId: PANE_A,
        turnId,
        assistantMessageId: ASSISTANT_ITEM,
        fullText: deltas.join(""),
        truncated: false,
        now: NOW,
      });
      const completed = store.completeTurn(PANE_A, turnId, NOW);
      expect(completed?.state).toBe("ready");
      expect(completed?.turn?.responseMarkdown.totalUtf8Bytes).toBe(expectedOffset);
      expect(completed?.turn?.tools.every(({ status }) => status === "completed")).toBeTrue();
      expect(store.handoffHistory(PANE_A, false).complete).toBeTrue();
    }),
  ), { numRuns: 100 });
});

test("batched Unicode persistence is observationally identical to scalar commits", () => {
  assertProperty(fc.property(
    fc.array(boundedText, { minLength: 1, maxLength: 64 }),
    (deltas) => {
      const exercise = (batched: boolean) => withStore((store) => {
        const created = createPane(store, PANE_A);
        const turnId = "chatturn_propertybatch";
        store.beginTurn({
          paneId: PANE_A,
          expectedRevision: created.revision,
          turnId,
          prompt: "batch equivalence",
          now: NOW,
        });
        store.reserveAccount(PANE_A, turnId, ACCOUNT, NOW);
        store.prepareProviderThread(PANE_A, turnId, {
          accountProfileId: ACCOUNT,
          threadId: "thread_property_batch",
          restartThreadId: "raw_thread_property_batch",
        }, NOW);
        store.markTurnAccepted(PANE_A, turnId, "turn_property_batch", NOW);
        const projected = batched
          ? store.appendDeltaBatch({
              paneId: PANE_A,
              turnId,
              channel: "responseMarkdown",
              deltas,
              assistantMessageId: ASSISTANT_ITEM,
              now: NOW,
            })?.deltas ?? []
          : deltas.flatMap((delta) => {
              const result = store.appendDelta({
                paneId: PANE_A,
                turnId,
                channel: "responseMarkdown",
                delta,
                assistantMessageId: ASSISTANT_ITEM,
                now: NOW,
              });
              return result === null ? [] : [result.delta];
            });
        return { projected, record: store.require(PANE_A) };
      });

      expect(exercise(true)).toEqual(exercise(false));
    },
  ), { numRuns: 100 });
});

test("assistant completion reconciliation accepts only exact-prefix stream histories", () => {
  assertProperty(fc.property(
    fc.boolean(),
    boundedText,
    boundedText,
    (repairable, prefix, suffix) => withStore((store) => {
      const created = createPane(store, PANE_A);
      const turnId = "chatturn_property06";
      store.beginTurn({
        paneId: PANE_A,
        expectedRevision: created.revision,
        turnId,
        prompt: "reconcile property prompt",
        now: NOW,
      });
      store.reserveAccount(PANE_A, turnId, ACCOUNT, NOW);
      store.prepareProviderThread(PANE_A, turnId, {
        accountProfileId: ACCOUNT,
        threadId: "thread_property_reconcile",
        restartThreadId: "raw_thread_property_reconcile",
      }, NOW);
      store.markTurnAccepted(PANE_A, turnId, "turn_property_reconcile", NOW);
      const streamed = repairable ? prefix : `b${prefix}`;
      const completed = repairable ? `${prefix}${suffix}` : `a${suffix}`;
      store.appendDelta({
        paneId: PANE_A,
        turnId,
        channel: "responseMarkdown",
        delta: streamed,
        assistantMessageId: ASSISTANT_ITEM,
        now: NOW,
      });
      const result = store.reconcileAssistantCompletion({
        paneId: PANE_A,
        turnId,
        assistantMessageId: ASSISTANT_ITEM,
        fullText: completed,
        truncated: false,
        now: NOW,
      });
      if (repairable) {
        expect(result.kind).toBe("repaired");
        expect(store.require(PANE_A).projection.turn?.responseMarkdown.tail).toBe(completed);
        expect(store.completeTurn(PANE_A, turnId, NOW)?.state).toBe("ready");
      } else {
        expect(result).toEqual({ kind: "tainted" });
        expect(() => store.completeTurn(PANE_A, turnId, NOW)).toThrow(
          expect.objectContaining({ code: "invalid_state" }),
        );
        expect(store.handoffHistory(PANE_A, true).complete).toBeFalse();
      }
    }),
  ), { numRuns: 100 });
});

test("account unavailability detaches every reachable pane state exactly once", () => {
  assertProperty(fc.property(
    fc.constantFrom("starting" as const, "streaming" as const, "completed" as const, "attention" as const),
    fc.array(boundedText, { maxLength: 8 }),
    fc.array(fc.boolean(), { maxLength: 8 }),
    (stage, deltas, tools) => withStore((store) => {
      const created = createPane(store, PANE_A);
      const turnId = "chatturn_property02";
      store.beginTurn({
        paneId: PANE_A,
        expectedRevision: created.revision,
        turnId,
        prompt: "detach property prompt",
        now: NOW,
      });
      store.reserveAccount(PANE_A, turnId, ACCOUNT, NOW);
      if (stage !== "starting") {
        store.prepareProviderThread(PANE_A, turnId, {
          accountProfileId: ACCOUNT,
          threadId: "thread_property_detach",
          restartThreadId: "raw_thread_property_detach",
        }, NOW);
        store.markTurnAccepted(PANE_A, turnId, "turn_property_detach", NOW);
        for (const delta of deltas) {
          store.appendDelta({
            paneId: PANE_A,
            turnId,
            channel: "responseMarkdown",
            delta,
            assistantMessageId: ASSISTANT_ITEM,
            now: NOW,
          });
        }
        for (const complete of tools) {
          store.startTool(PANE_A, turnId, "other", NOW);
          if (complete) store.completeTool(PANE_A, turnId, "other", NOW);
        }
        if (stage === "completed") {
          store.reconcileAssistantCompletion({
            paneId: PANE_A,
            turnId,
            assistantMessageId: ASSISTANT_ITEM,
            fullText: deltas.join(""),
            truncated: false,
            now: NOW,
          });
          store.completeTurn(PANE_A, turnId, NOW);
        }
        if (stage === "attention") {
          store.enterAttention({
            paneId: PANE_A,
            turnId,
            attention: { code: "turn_failed", message: "Fixture failure", retryable: true },
            clearBinding: false,
            now: NOW,
          });
        }
      }
      const before = store.require(PANE_A);
      const historyBefore = store.handoffHistory(PANE_A, false);
      expect(store.paneIdsReferencingAccount(ACCOUNT)).toContain(PANE_A);

      const detached = store.detachUnavailableAccount(PANE_A, ACCOUNT, NOW);
      expect(detached?.revision).toBe(before.projection.revision + 1);
      const after = store.require(PANE_A);
      expect(after.binding).toBeNull();
      expect(after.providerTurnId).toBeNull();
      expect(after.projection.accountProfileId).toBeNull();
      expect(store.paneIdsReferencingAccount(ACCOUNT)).not.toContain(PANE_A);
      if (stage === "starting" || stage === "streaming") {
        expect(after.projection).toMatchObject({
          state: "attention",
          attention: {
            code: "account_unavailable",
            message: "This Codex subscription became unavailable. HRA will choose another connected subscription when you send again.",
            retryable: true,
          },
          turn: { status: "failed" },
        });
        expect(after.projection.turn?.tools.every(({ status }) => status === "completed")).toBeTrue();
      } else {
        expect(after.projection.state).toBe(before.projection.state);
        expect(store.handoffHistory(PANE_A, false)).toEqual(historyBefore);
      }
      const stable = after.projection;
      expect(store.detachUnavailableAccount(PANE_A, ACCOUNT, NOW)).toBeNull();
      expect(store.require(PANE_A).projection).toEqual(stable);
    }),
  ), { numRuns: 100 });
});

test("context reset preserves displayed history while provider handoff starts at a fresh floor", () => {
  assertProperty(fc.property(
    boundedText,
    boundedText,
    fc.boolean(),
    (priorPrompt, priorResponse, markTruncated) => withStore((store, database) => {
      const created = createPane(store, PANE_A);
      const firstTurnId = "chatturn_property03";
      store.beginTurn({
        paneId: PANE_A,
        expectedRevision: created.revision,
        turnId: firstTurnId,
        prompt: priorPrompt,
        now: NOW,
      });
      store.reserveAccount(PANE_A, firstTurnId, ACCOUNT, NOW);
      store.prepareProviderThread(PANE_A, firstTurnId, {
        accountProfileId: ACCOUNT,
        threadId: "thread_property_reset",
        restartThreadId: "raw_thread_property_reset",
      }, NOW);
      store.markTurnAccepted(PANE_A, firstTurnId, "turn_property_reset", NOW);
      store.appendDelta({
        paneId: PANE_A,
        turnId: firstTurnId,
        channel: "responseMarkdown",
        delta: priorResponse,
        assistantMessageId: ASSISTANT_ITEM,
        now: NOW,
      });
      store.reconcileAssistantCompletion({
        paneId: PANE_A,
        turnId: firstTurnId,
        assistantMessageId: ASSISTANT_ITEM,
        fullText: priorResponse,
        truncated: false,
        now: NOW,
      });
      const completed = store.completeTurn(PANE_A, firstTurnId, NOW);
      if (completed === null) throw new Error("Expected completed fixture turn");
      if (markTruncated) {
        database.query("UPDATE chat_panes SET history_truncated = 1 WHERE pane_id = ?1")
          .run(PANE_A);
      }
      const secondTurnId = "chatturn_property04";
      store.beginTurn({
        paneId: PANE_A,
        expectedRevision: completed.revision,
        turnId: secondTurnId,
        prompt: "unsafe continuation",
        now: NOW,
      });
      store.reserveAccount(PANE_A, secondTurnId, ACCOUNT, NOW);
      const before = store.require(PANE_A);

      const reset = store.resetContextWithAttention({
        paneId: PANE_A,
        turnId: secondTurnId,
        attention: {
          code: "continuation_failed",
          message: "Context was reset by the property fixture.",
          retryable: true,
        },
        now: NOW,
      });
      expect(reset?.revision).toBe(before.projection.revision + 1);
      expect(database.query(`
        SELECT role, text FROM chat_pane_history
        WHERE pane_id = ?1 ORDER BY sequence
      `).all(PANE_A)).toEqual([
        { role: "user", text: priorPrompt },
        { role: "assistant", text: priorResponse },
      ]);
      expect(store.require(PANE_A)).toMatchObject({
        activePrompt: "unsafe continuation",
        binding: null,
        historyTruncated: false,
        providerTurnId: null,
        projection: {
          state: "attention",
          attention: { code: "continuation_failed", retryable: true },
          turn: { status: "failed" },
        },
      });
      expect(store.handoffHistory(PANE_A, false)).toEqual({ complete: true, items: [] });

      const fresh = store.beginTurn({
        paneId: PANE_A,
        expectedRevision: reset?.revision ?? 0,
        turnId: "chatturn_property05",
        prompt: "fresh prompt",
        now: NOW,
      }).pane;
      expect(fresh.state).toBe("starting");
      expect(store.handoffHistory(PANE_A, true)).toEqual({
        complete: true,
        items: [{ role: "user", text: "fresh prompt" }],
      });
    }),
  ), { numRuns: 100 });
});

function accountId(number: number): `acct_${string}` {
  return `acct_property_${String(number).padStart(3, "0")}`;
}

function createPair(store: ChatPaneStore) {
  return [createPane(store, PANE_A), createPane(store, PANE_B)] as const;
}

function createPane(store: ChatPaneStore, paneId: typeof PANE_A | typeof PANE_B) {
  return store.create({
    paneId,
    repository: { id: REPOSITORY, name: "Example", workingDirectory: "/fixture/example" },
    accountProfileId: ACCOUNT,
    now: NOW,
  });
}

function withStore<T>(run: (store: ChatPaneStore, database: Database) => T): T {
  const database = Database.deserialize(pristineDatabase.slice(), { strict: true });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    return run(new ChatPaneStore(database), database);
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
      ) VALUES (?1, 'Property account', 'signed_in', 1, 1, ?2, ?2)
    `).run(ACCOUNT, NOW.toISOString());
    return database.serialize();
  } finally {
    database.close();
  }
}

const pristineDatabase = createPristineDatabase();
