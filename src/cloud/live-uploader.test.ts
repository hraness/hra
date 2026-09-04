import { describe, expect, test } from "bun:test";

import type { SessionEvent, SessionEventBody } from "../domain/session-events";

import {
  assignDetailSequences,
  LIVE_BATCH_MAX_BYTES,
  LIVE_REDACTION_CARRY_BYTES,
  LiveBatcher,
  LiveRedactionWindow,
  redactLiveText,
} from "./live-uploader";
import { parseDetailSessionEvents } from "./projection";

const turn = "turn_00000000000000000000000001";
let sequence = 0;
const event = (body: SessionEventBody, recordedAt = 1_000): SessionEvent => ({
  version: 1,
  sessionId: "sess_0123456789abcdef0123456789abcdef",
  streamEpoch: "0192a3b4-c5d6-7e8f-8a9b-0c1d2e3f4a5b",
  sequence: (sequence += 1),
  recordedAt,
  accountId: "acct_0123456789abcdef0123456789abcdef",
  providerGeneration: 1,
  providerConnectionId: null,
  body,
});
const delta = (text: string, type: "assistant_delta" | "reasoning_summary_delta" = "assistant_delta") =>
  event({ type, turnId: turn, itemId: "item_1", text });

describe("live redaction window", () => {
  test("holds back a carry so a token split across batches is redacted whole", () => {
    const window = new LiveRedactionWindow();
    const token = ["sk-ant", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");
    window.append(`prefix text ${token.slice(0, 10)}`);
    const first = window.take(false);
    expect(first).not.toContain("sk-ant");
    window.append(`${token.slice(10)} suffix`);
    const rest = window.take(true);
    expect(`${first}${rest}`).not.toContain(token);
    expect(`${first}${rest}`).toContain("[redacted]");
    expect(`${first}${rest}`).toContain("prefix text");
    expect(`${first}${rest}`).toContain("suffix");
  });

  test("releases everything but the carry while open and everything on close", () => {
    const window = new LiveRedactionWindow();
    const text = "a".repeat(LIVE_REDACTION_CARRY_BYTES + 100);
    window.append(text);
    const released = window.take(false);
    expect(released.length).toBe(100);
    expect(window.pendingCharacters).toBe(LIVE_REDACTION_CARRY_BYTES);
    expect(window.take(true)).toBe("a".repeat(LIVE_REDACTION_CARRY_BYTES));
    expect(window.take(true)).toBe("");
  });

  test("redacts absolute paths and known secret shapes", () => {
    const userPath = ["", "Users", "someone", "project", "file.ts"].join("/");
    expect(redactLiveText(`see ${userPath} and ghp_${"a".repeat(26)}`))
      .not.toMatch(/\/Users\/|ghp_/u);
    expect(redactLiveText(`AKIA${"A".repeat(16)} is a key`)).toContain("[redacted]");
  });
});

describe("live batcher", () => {
  test("coalesces contiguous deltas per turn and flushes on turn completion", () => {
    const batcher = new LiveBatcher({ includeThinking: false });
    batcher.observe(event({ type: "turn_started", turnId: turn }, 5_000));
    batcher.observe(delta("Hello, "));
    batcher.observe(delta("world."));
    batcher.observe(delta("thinking", "reasoning_summary_delta"));
    const open = batcher.drain();
    expect(open.flush).toBe(false);
    expect(open.bodies).toEqual([{ at: 5_000, turnId: turn, type: "turn_started" }]);
    expect(batcher.hasOpenStream).toBe(true);

    batcher.observe(event({ type: "turn_completed", turnId: turn, status: "completed" }));
    const closed = batcher.drain();
    expect(closed.flush).toBe(true);
    expect(closed.bodies).toEqual([{ text: "Hello, world.", turnId: turn, type: "assistant_delta" }]);
    expect(batcher.hasOpenStream).toBe(false);
  });

  test("includes reasoning summaries only when thinking is enabled", () => {
    const batcher = new LiveBatcher({ includeThinking: true });
    batcher.observe(delta("plan step", "reasoning_summary_delta"));
    batcher.observe(event({ type: "turn_completed", turnId: turn, status: "completed" }));
    expect(batcher.drain().bodies).toEqual([
      { text: "plan step", turnId: turn, type: "reasoning_summary_delta" },
    ]);
  });

  test("projects session_state and turn boundaries and ignores other events", () => {
    const batcher = new LiveBatcher({ includeThinking: false });
    batcher.observe(event({ type: "item_started", turnId: turn, itemId: "item_1", itemKind: "commandExecution" }));
    batcher.observe(event({
      type: "session_state",
      state: "needs_approval",
      attention: false,
      reason: "do you approve",
      verbatimRequired: false,
      lastActivityAt: 9_000,
      revision: 3,
    }));
    const batch = batcher.drain();
    expect(batch.flush).toBe(true);
    expect(batch.bodies).toEqual([{
      attention: false,
      lastActivityAt: 9_000,
      reason: "do you approve",
      revision: 3,
      state: "needs_approval",
      type: "session_state",
      verbatimRequired: false,
    }]);
  });

  test("queues subagent activity so the grid can show a running subagent", () => {
    const agentId = `opaque_v2_${"b".repeat(64)}`;
    const batcher = new LiveBatcher({ includeThinking: false });
    batcher.observe(event({
      type: "subagent_activity",
      turnId: turn,
      agentId,
      kind: "started",
      depth: 1,
      nickname: "quiet-otter",
      role: "reviewer",
    }));
    batcher.observe(event({ type: "subagent_activity", turnId: turn, agentId, kind: "completed" }));
    const batch = batcher.drain();
    expect(batch.bodies).toEqual([
      { agentId, depth: 1, kind: "started", nickname: "quiet-otter", role: "reviewer", turnId: turn, type: "subagent_activity" },
      { agentId, kind: "completed", turnId: turn, type: "subagent_activity" },
    ]);
    expect(parseDetailSessionEvents(assignDetailSequences(batch.bodies, 0))).toHaveLength(2);
  });

  test("bounds a batch by bytes and keeps the remainder queued", () => {
    const batcher = new LiveBatcher({ includeThinking: false });
    const big = "x".repeat(LIVE_BATCH_MAX_BYTES);
    for (let index = 0; index < 3; index += 1) {
      batcher.observe(event({ type: "turn_started", turnId: `turn_0000000000000000000000000${String(index)}` }));
      batcher.observe(event({ type: "assistant_delta", turnId: `turn_0000000000000000000000000${String(index)}`, itemId: "item_1", text: big }));
      batcher.observe(event({ type: "turn_completed", turnId: `turn_0000000000000000000000000${String(index)}`, status: "completed" }));
    }
    const first = batcher.drain();
    expect(first.bodies.length).toBeGreaterThan(0);
    expect(first.bodies.length).toBeLessThan(6);
    const second = batcher.drain();
    expect(second.bodies.length).toBeGreaterThan(0);
  });

  test("assigned detail sequences parse as a contiguous detail chunk", () => {
    const batcher = new LiveBatcher({ includeThinking: false });
    batcher.observe(event({ type: "turn_started", turnId: turn }, 1));
    batcher.observe(delta("done"));
    batcher.observe(event({ type: "turn_completed", turnId: turn, status: "completed" }));
    const events = assignDetailSequences(batcher.drain().bodies, 41);
    expect(events.map((body) => body.sequence)).toEqual([42, 43]);
    expect(parseDetailSessionEvents(events)).not.toBeNull();
  });
});
