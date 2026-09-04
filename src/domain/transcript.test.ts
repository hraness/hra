import { describe, expect, test } from "bun:test";

import {
  sessionEventSchema,
  type SessionEvent,
  type SessionEventBody,
} from "./session-events";
import {
  buildSessionTranscript,
  digestTranscriptRecords,
  renderTranscriptSeed,
  TRANSCRIPT_SEED_HEADER,
} from "./transcript";

const sessionId = `sess_${"a".repeat(32)}` as const;
const accountId = `acct_${"b".repeat(32)}` as const;
const streamEpoch = "8f1f2d51-8c5f-4dcb-9c3b-1c1e3f2b4a5d";
const opaque = (seed: string): string => `opaque_v2_${seed.repeat(64).slice(0, 64)}`;
const turn = opaque("1");
const messageItem = opaque("2");
const toolItem = opaque("3");

let nextSequence = 0;

const event = (body: SessionEventBody, recordedAt = 1_000): SessionEvent => {
  nextSequence += 1;
  return sessionEventSchema.parse({
    version: 1,
    sessionId,
    streamEpoch,
    sequence: nextSequence,
    recordedAt,
    accountId,
    providerGeneration: 1,
    providerConnectionId: null,
    body,
  });
};

const reset = (): void => { nextSequence = 0; };

describe("session transcript", () => {
  test("rebuilds an ordered conversation and coalesces one text stream", () => {
    reset();
    const events = [
      event({ type: "user_message", turnId: null, actor: "human", text: "fix the build", omittedCharacters: 0 }),
      event({ type: "turn_started", turnId: turn }),
      event({ type: "item_started", turnId: turn, itemId: toolItem, itemKind: "commandExecution", callId: toolItem, summary: "commandExecution: bun test" }),
      event({ type: "item_completed", turnId: turn, itemId: toolItem, itemKind: "commandExecution", status: "completed", callId: toolItem, summary: "commandExecution: bun test" }),
      event({ type: "item_started", turnId: turn, itemId: messageItem, itemKind: "agentMessage" }),
      event({ type: "reasoning_summary_delta", turnId: turn, itemId: messageItem, text: "checking" }),
      event({ type: "assistant_delta", turnId: turn, itemId: messageItem, text: "The build " }),
      event({ type: "assistant_delta", turnId: turn, itemId: messageItem, text: "is green." }),
      event({ type: "token_usage", turnId: turn, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2, modelContextWindow: 10 }),
      event({ type: "turn_completed", turnId: turn, status: "completed" }),
    ];
    const transcript = buildSessionTranscript({ sessionId, events });
    expect(transcript.records.map((record) => record.kind)).toEqual([
      "user",
      "tool_call",
      "tool_result",
      "reasoning",
      "assistant",
    ]);
    const assistant = transcript.records[4];
    if (assistant?.kind !== "assistant") throw new Error("Expected an assistant record.");
    expect(assistant.text).toBe("The build is green.");
    expect(assistant.sequence).toBe(7);
    expect(assistant.throughSequence).toBe(8);
    const result = transcript.records[2];
    const call = transcript.records[1];
    if (result?.kind !== "tool_result" || call?.kind !== "tool_call") {
      throw new Error("Expected one tool call and one result.");
    }
    expect(result.callId).toBe(call.callId);
    expect(result.ok).toBe(true);
    expect(transcript.nextSequence).toBeNull();
    expect(transcript.throughSequence).toBe(10);
    expect(transcript.digest).toBe(digestTranscriptRecords(transcript.records));
  });

  test("does not treat an agent-message or reasoning item as a tool call", () => {
    reset();
    const transcript = buildSessionTranscript({
      sessionId,
      events: [
        event({ type: "item_started", turnId: turn, itemId: messageItem, itemKind: "agentMessage" }),
        event({ type: "item_completed", turnId: turn, itemId: messageItem, itemKind: "reasoning", status: "completed" }),
        event({ type: "item_started", turnId: turn, itemId: toolItem, itemKind: "unknownFutureKind" }),
      ],
    });
    // An unknown item kind is still a tool call: HRA would rather record an
    // unfamiliar call than silently drop it.
    expect(transcript.records.map((record) => record.kind)).toEqual(["tool_call"]);
  });

  test("pages at the record limit and names the cursor to resume from", () => {
    reset();
    const events = [
      event({ type: "user_message", turnId: null, actor: "human", text: "one", omittedCharacters: 0 }),
      event({ type: "user_message", turnId: null, actor: "human", text: "two", omittedCharacters: 0 }),
      event({ type: "user_message", turnId: null, actor: "human", text: "three", omittedCharacters: 0 }),
    ];
    const first = buildSessionTranscript({ sessionId, events, limit: 2 });
    expect(first.records).toHaveLength(2);
    expect(first.omittedRecords).toBe(1);
    expect(first.nextSequence).toBe(3);
    const second = buildSessionTranscript({
      sessionId,
      events: events.filter((value) => value.sequence >= 3),
      limit: 2,
    });
    expect(second.records).toHaveLength(1);
    expect(second.nextSequence).toBeNull();
  });

  test("bounds record text and reports the exact omitted character count", () => {
    reset();
    const transcript = buildSessionTranscript({
      sessionId,
      events: [
        event({ type: "assistant_delta", turnId: turn, itemId: messageItem, text: "x".repeat(200) }),
      ],
      textLimit: 64,
    });
    const assistant = transcript.records[0];
    if (assistant?.kind !== "assistant") throw new Error("Expected an assistant record.");
    expect(assistant.text).toHaveLength(64);
    expect(assistant.omittedCharacters).toBe(136);
    expect(transcript.omittedCharacters).toBe(136);
  });

  test("carries a stored user-message omission count through to the record", () => {
    reset();
    const transcript = buildSessionTranscript({
      sessionId,
      events: [
        event({ type: "user_message", turnId: turn, actor: "autorespond", text: "yes", omittedCharacters: 7 }),
      ],
    });
    expect(transcript.records[0]).toMatchObject({
      actor: "autorespond",
      kind: "user",
      omittedCharacters: 7,
      turnId: turn,
    });
  });

  test("renders a bounded handoff seed that keeps the end of the conversation", () => {
    reset();
    const events = Array.from({ length: 40 }, (_unused, index) => event({
      type: "user_message",
      turnId: null,
      actor: "human",
      text: `message ${String(index)} ${"y".repeat(120)}`,
      omittedCharacters: 0,
    }));
    const transcript = buildSessionTranscript({ sessionId, events });
    const seed = renderTranscriptSeed({
      transcript,
      fromProvider: "codex",
      toProvider: "claude",
      maxCharacters: 600,
    });
    expect(seed.text.startsWith(TRANSCRIPT_SEED_HEADER)).toBe(true);
    expect(seed.text).toContain("This conversation ran on codex and now runs on claude.");
    expect(seed.omittedRecords).toBe(40 - seed.includedRecords);
    expect(seed.text).toContain(`${String(seed.omittedRecords)} earlier records were omitted`);
    // The tail is what a handoff needs, so the last message survives and an
    // early one does not.
    expect(seed.text).toContain("message 39");
    expect(seed.text).not.toContain("message 0 ");
    expect(seed.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("says plainly when nothing was omitted", () => {
    reset();
    const transcript = buildSessionTranscript({
      sessionId,
      events: [event({ type: "user_message", turnId: null, actor: "human", text: "hello", omittedCharacters: 0 })],
    });
    const seed = renderTranscriptSeed({ transcript, fromProvider: "claude", toProvider: "codex" });
    expect(seed.text).toContain("No records were omitted.");
    expect(seed.omittedRecords).toBe(0);
    expect(seed.includedRecords).toBe(1);
  });

  test("digests the same records identically and different records differently", () => {
    reset();
    const one = buildSessionTranscript({
      sessionId,
      events: [event({ type: "user_message", turnId: null, actor: "human", text: "same", omittedCharacters: 0 })],
    });
    reset();
    const two = buildSessionTranscript({
      sessionId,
      events: [event({ type: "user_message", turnId: null, actor: "human", text: "same", omittedCharacters: 0 })],
    });
    reset();
    const three = buildSessionTranscript({
      sessionId,
      events: [event({ type: "user_message", turnId: null, actor: "human", text: "other", omittedCharacters: 0 })],
    });
    expect(one.digest).toBe(two.digest);
    expect(one.digest).not.toBe(three.digest);
  });
});
