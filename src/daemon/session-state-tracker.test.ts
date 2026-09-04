import { describe, expect, test } from "bun:test";

import { SessionStateTracker } from "./session-state-tracker";

const turn = "turn_00000000000000000000000001";

describe("session state tracker", () => {
  test("marks a session working on turn start and classifies the accumulated text on completion", () => {
    let now = 1_000;
    const tracker = new SessionStateTracker(() => now);
    const started = tracker.observe("sess_a", { type: "turn_started", turnId: turn });
    expect(started).toMatchObject({ type: "session_state", state: "working", attention: false, revision: 1 });

    expect(tracker.observe("sess_a", { type: "assistant_delta", turnId: turn, itemId: "item_1", text: "Migration prepared. " })).toBeNull();
    expect(tracker.observe("sess_a", { type: "assistant_delta", turnId: turn, itemId: "item_1", text: "Do you approve running it now?" })).toBeNull();
    now = 2_000;
    const completed = tracker.observe("sess_a", { type: "turn_completed", turnId: turn, status: "completed" });
    expect(completed).toMatchObject({
      type: "session_state",
      state: "needs_approval",
      attention: false,
      verbatimRequired: false,
      lastActivityAt: 2_000,
      revision: 2,
    });
    expect(tracker.snapshot("sess_a")?.state).toBe("needs_approval");
  });

  test("does not re-emit an unchanged state and bumps the revision when it changes", () => {
    const tracker = new SessionStateTracker(() => 5);
    tracker.observe("sess_b", { type: "turn_started", turnId: turn });
    expect(tracker.observe("sess_b", { type: "turn_started", turnId: turn })).toBeNull();
    const done = tracker.observe("sess_b", { type: "turn_completed", turnId: turn, status: "completed" });
    expect(done).toMatchObject({ state: "done", revision: 2 });
  });

  test("aborted turns and terminal sessions classify without text", () => {
    const tracker = new SessionStateTracker(() => 1);
    tracker.observe("sess_c", { type: "turn_started", turnId: turn });
    expect(tracker.observe("sess_c", { type: "turn_completed", turnId: turn, status: "interrupted" }))
      .toMatchObject({ state: "aborted" });
    const other = new SessionStateTracker(() => 1);
    other.observe("sess_d", { type: "turn_started", turnId: turn });
    expect(other.observe("sess_d", { type: "session_status", status: "system_error", activeTurnId: null }))
      .toMatchObject({ state: "aborted" });
  });

  test("pending interactions reclassify a completed turn and clear again", () => {
    const tracker = new SessionStateTracker(() => 1);
    tracker.observe("sess_e", { type: "turn_started", turnId: turn });
    tracker.observe("sess_e", { type: "assistant_delta", turnId: turn, itemId: "item_1", text: "Done." });
    tracker.observe("sess_e", { type: "turn_completed", turnId: turn, status: "completed" });
    const requested = tracker.observe(
      "sess_e",
      { type: "interaction_requested", interactionId: "0192a3b4-c5d6-7e8f-8a9b-0c1d2e3f4a5b", interactionKind: "user_input", summary: "Which one?", blocking: true, revision: 1 },
      { pendingInteraction: { kind: "user_input" } },
    );
    expect(requested).toMatchObject({ state: "needs_answer", attention: true });
    const resolved = tracker.observe(
      "sess_e",
      { type: "interaction_state", interactionId: "0192a3b4-c5d6-7e8f-8a9b-0c1d2e3f4a5b", state: "resolved", revision: 2 },
      {},
    );
    expect(resolved).toMatchObject({ state: "done" });
  });

  test("seeding keeps revisions monotonic across restarts", () => {
    const tracker = new SessionStateTracker(() => 1);
    tracker.seed("sess_f", {
      state: "done",
      attention: false,
      reason: "no cue matched",
      verbatimRequired: false,
      verbatimLiteral: undefined,
      lastActivityAt: 0,
      revision: 7,
    });
    const next = tracker.observe("sess_f", { type: "turn_started", turnId: turn });
    expect(next).toMatchObject({ state: "working", revision: 8 });
  });

  test("open subagents keep a completed turn working", () => {
    const tracker = new SessionStateTracker(() => 1);
    tracker.setOpenSubagents("sess_g", 2);
    tracker.observe("sess_g", { type: "turn_started", turnId: turn });
    tracker.observe("sess_g", { type: "assistant_delta", turnId: turn, itemId: "item_1", text: "Fanned out." });
    expect(tracker.observe("sess_g", { type: "turn_completed", turnId: turn, status: "completed" }))
      .toMatchObject({ state: "working" });
  });
});
