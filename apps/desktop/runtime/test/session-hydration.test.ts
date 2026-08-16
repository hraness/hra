import { describe, expect, test } from "bun:test";

import type { CodexFact, CodexThreadSnapshot } from "../src/codex";
import {
  CODEX_0_144_6_THREAD_READ_COVERAGE,
  SESSION_HYDRATION_POLICY,
  SessionHydrationBuffer,
  SessionHydrationBufferPool,
  SessionHydrationInvariantError,
  decideHydrationRead,
  hydrationRetryDelay,
} from "../src/sessions/hydration";

const terminalSnapshot: CodexThreadSnapshot = {
  archived: false,
  createdAt: "2026-07-29T00:00:00.000Z",
  cwd: "/tmp/project",
  id: "thread_1",
  status: "idle",
  title: "Thread",
  turns: [],
  updatedAt: "2026-07-29T00:01:00.000Z",
};

function delta(streamPosition: number, encodedBytes = 8): CodexFact {
  return {
    accountProfileId: "account_1",
    encodedBytes,
    factIndex: 0,
    generation: 7,
    origin: "live",
    streamPosition,
    type: "item.delta",
    channel: "assistant_text",
    delta: "x",
    itemId: "item_1",
    threadId: "thread_1",
    truncated: false,
    turnId: "turn_1",
  };
}

describe("session hydration", () => {
  test("folds only the proven post-response suffix", () => {
    const pool = new SessionHydrationBufferPool();
    const buffer = new SessionHydrationBuffer({
      accountProfileId: "account_1",
      generation: 7,
      startedAt: 0,
      pool,
    });
    expect(buffer.append(delta(9), 1)).toEqual({ kind: "accepted" });
    expect(buffer.append(delta(10), 2)).toEqual({ kind: "accepted" });
    expect(buffer.append(delta(11), 3)).toEqual({ kind: "accepted" });

    const decision = decideHydrationRead({
      accountProfileId: "account_1",
      generation: 7,
      responsePosition: 10,
      snapshot: terminalSnapshot,
      snapshotBytes: 128,
      suffix: buffer.suffixAfter(10),
      coverage: "proven",
    });
    expect(decision.state).toBe("ready");
    expect(decision.facts.map((entry) => [entry.type, entry.streamPosition])).toEqual([
      ["thread.snapshot", 10],
      ["hydration.changed", 10],
      ["item.delta", 11],
    ]);
    buffer.close();
    expect(pool.usage()).toEqual({ bytes: 0, facts: 0 });
  });

  test("keeps an active thread recovering when response coverage is unproven", () => {
    expect(CODEX_0_144_6_THREAD_READ_COVERAGE).toBe("unproven");
    const decision = decideHydrationRead({
      accountProfileId: "account_1",
      generation: 7,
      responsePosition: 10,
      snapshot: {
        ...terminalSnapshot,
        status: "active",
      },
      snapshotBytes: 128,
      suffix: [delta(11)],
      coverage: CODEX_0_144_6_THREAD_READ_COVERAGE,
    });
    expect(decision.state).toBe("recovering");
    expect(decision.facts).toEqual([
      expect.objectContaining({ type: "hydration.changed", status: "recovering" }),
    ]);
  });

  test("fails closed for oversize history, count overflow, deadline, and generation drift", () => {
    const unavailable = decideHydrationRead({
      accountProfileId: "account_1",
      generation: 7,
      responsePosition: 10,
      snapshot: terminalSnapshot,
      snapshotBytes: SESSION_HYDRATION_POLICY.maxSemanticHistoryBytes + 1,
      suffix: [],
      coverage: "proven",
    });
    expect(unavailable.state).toBe("history_unavailable");
    expect(unavailable.facts).toEqual([
      expect.objectContaining({
        type: "hydration.changed",
        status: "history_unavailable",
      }),
    ]);

    const countPool = new SessionHydrationBufferPool();
    const countBuffer = new SessionHydrationBuffer({
      accountProfileId: "account_1",
      generation: 7,
      startedAt: 0,
      pool: countPool,
    });
    for (let index = 0; index < SESSION_HYDRATION_POLICY.maxFactsPerAccount; index += 1) {
      expect(countBuffer.append(delta(index + 1, 0), 1)).toEqual({ kind: "accepted" });
    }
    expect(countBuffer.append(delta(3_000, 0), 1)).toEqual({
      kind: "overflow",
      limit: "count",
    });
    expect(countPool.usage()).toEqual({ bytes: 0, facts: 0 });

    const deadlinePool = new SessionHydrationBufferPool();
    const deadlineBuffer = new SessionHydrationBuffer({
      accountProfileId: "account_1",
      generation: 7,
      startedAt: 100,
      pool: deadlinePool,
    });
    expect(deadlineBuffer.append(
      delta(1),
      100 + SESSION_HYDRATION_POLICY.attemptDeadlineMs,
    )).toEqual({ kind: "deadline_exceeded" });

    const generationPool = new SessionHydrationBufferPool();
    const generationBuffer = new SessionHydrationBuffer({
      accountProfileId: "account_1",
      generation: 7,
      startedAt: 0,
      pool: generationPool,
    });
    expect(generationBuffer.append({ ...delta(1), generation: 8 }, 1)).toEqual({
      kind: "generation_mismatch",
    });
    generationBuffer.close();

    expect(() => decideHydrationRead({
      accountProfileId: "account_1",
      generation: 7,
      responsePosition: 10,
      snapshot: terminalSnapshot,
      snapshotBytes: 128,
      suffix: [{ ...delta(11), accountProfileId: "account_2" }],
      coverage: "proven",
    })).toThrow(SessionHydrationInvariantError);
  });

  test("uses a bounded retry circuit", () => {
    expect([0, 1, 2, 3, 4, 5].map(hydrationRetryDelay)).toEqual([
      250,
      500,
      1_000,
      2_000,
      5_000,
      null,
    ]);
  });
});
