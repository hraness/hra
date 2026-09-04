import { describe, expect, test } from "bun:test";

import type { CompactSessionEvent } from "../hra/cloud";
import { deriveTranscript, mergeCompactEvents } from "./transcript";

const userMessage = (
  sequence: number,
  text: string,
  extra: Partial<Extract<CompactSessionEvent, { kind: "user_message" }>> = {},
): CompactSessionEvent => ({
  kind: "user_message",
  sequence,
  text,
  turnId: "turn-1",
  ...extra,
});

const assistantMessage = (
  sequence: number,
  text: string,
  turnId = "turn-1",
): CompactSessionEvent => ({ kind: "assistant_message", sequence, text, turnId });

const turnSummary = (sequence: number, turnId = "turn-1"): CompactSessionEvent => ({
  filesTouched: ["a.ts", "b.ts"],
  gitActions: [{ kind: "commit", label: "commit c0ffee" }],
  kind: "turn_summary",
  runtimeMs: 12_000,
  sequence,
  turnId,
});

describe("mergeCompactEvents", () => {
  test("orders by sequence and drops duplicates", () => {
    const merged = mergeCompactEvents(
      [userMessage(1, "one"), assistantMessage(2, "two")],
      [assistantMessage(2, "two"), turnSummary(3)],
    );
    expect(merged.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  test("a later list wins for the same sequence", () => {
    const merged = mergeCompactEvents(
      [assistantMessage(4, "stale")],
      [assistantMessage(4, "fresh")],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ text: "fresh" });
  });

  test("merges nothing into nothing", () => {
    expect(mergeCompactEvents([], [])).toEqual([]);
  });
});

describe("deriveTranscript", () => {
  test("renders user messages, assistant messages, and turn markers in order", () => {
    const entries = deriveTranscript(
      [userMessage(1, "do it"), assistantMessage(2, "done"), turnSummary(3)],
      { streamingText: "", turnId: null },
    );
    expect(entries.map((entry) => entry.kind)).toEqual(["user", "assistant", "turn_summary"]);
    expect(entries[0]).toMatchObject({ actor: "human", text: "do it" });
    expect(entries[2]).toMatchObject({
      filesTouched: 2,
      gitActions: ["commit c0ffee"],
      runtimeMs: 12_000,
    });
  });

  test("labels an autoresponse by its actor", () => {
    const entries = deriveTranscript(
      [userMessage(1, "approved", { actor: "autorespond" })],
      { streamingText: "", turnId: null },
    );
    expect(entries[0]).toMatchObject({ actor: "autorespond", kind: "user" });
  });

  test("appends the live text for a turn the compact stream has not closed", () => {
    const entries = deriveTranscript(
      [userMessage(1, "go")],
      { streamingText: "partial answ", turnId: "turn-1" },
    );
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ kind: "assistant", streaming: true, text: "partial answ" });
  });

  test("does not repeat the live text once the compact message arrives", () => {
    const entries = deriveTranscript(
      [userMessage(1, "go"), assistantMessage(2, "the answer")],
      { streamingText: "the answer", turnId: "turn-1" },
    );
    expect(entries.filter((entry) => entry.kind === "assistant")).toHaveLength(1);
    expect(entries[1]).toMatchObject({ streaming: false, text: "the answer" });
  });

  test("keeps live text for a new turn even when an earlier turn is closed", () => {
    const entries = deriveTranscript(
      [assistantMessage(1, "first answer", "turn-1")],
      { streamingText: "second answ", turnId: "turn-2" },
    );
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ streaming: true, text: "second answ" });
  });

  test("drops interaction events, which the panel renders instead", () => {
    const entries = deriveTranscript(
      [{
        blocking: true,
        interactionId: "b1f0c0de-0000-4000-8000-000000000000",
        interactionKind: "command_approval",
        kind: "interaction_state",
        revision: 1,
        sequence: 1,
        state: "pending",
        summary: "Codex requests command approval",
      }],
      { streamingText: "", turnId: null },
    );
    expect(entries).toEqual([]);
  });

  test("gives every entry a distinct key", () => {
    const entries = deriveTranscript(
      [userMessage(1, "a"), assistantMessage(2, "b", "turn-1")],
      { streamingText: "c", turnId: "turn-2" },
    );
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(entries.length);
  });

  test("adds nothing for an empty live tail", () => {
    expect(deriveTranscript([], { streamingText: "", turnId: "turn-1" })).toEqual([]);
    expect(deriveTranscript([], { streamingText: "text", turnId: null })).toEqual([]);
  });
});
