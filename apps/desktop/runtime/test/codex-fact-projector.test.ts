import { describe, expect, test } from "bun:test";

import {
  MAX_CODEX_FACT_ENCODED_BYTES,
  MAX_CODEX_FACT_DISPLAY_TEXT_UTF8_BYTES,
  codexServerRequestResolutionKey,
  type CodexNotification,
  type PinnedCodexThread,
} from "../src/codex";
import {
  CodexFactProjectionError,
  projectCodexNotificationFacts,
  projectCodexThreadSnapshot,
} from "../src/codex/fact-projector";
import { parseCodexNotification } from "../src/codex/pinned-codecs";

function thread(overrides: Partial<PinnedCodexThread> = {}): PinnedCodexThread {
  return {
    id: "thread_1",
    ephemeral: false,
    preview: "preview",
    createdAt: 1_753_776_000,
    updatedAt: 1_753_776_001,
    status: { type: "active", activeFlags: [] },
    cwd: "/tmp/project",
    historyMode: "paginated",
    name: "Thread",
    threadSource: null,
    turns: [],
    ...overrides,
  };
}

function parseFailedTurnCompletion(
  codexErrorInfo: unknown,
  streamPosition: number,
): CodexNotification | null {
  const parsed = parseCodexNotification("turn/completed", {
    threadId: "thread_quota_boundary",
    turn: {
      id: "turn_quota_boundary",
      items: [],
      itemsView: "full",
      status: "failed",
      error: {
        message: "Private provider failure prose",
        codexErrorInfo,
        additionalDetails: "Private provider failure details",
      },
      startedAt: 1_753_776_000,
      completedAt: 1_753_776_001,
    },
  });
  if (parsed === null) return null;
  if (parsed.method !== "turn/completed") {
    throw new Error("Expected a parsed turn completion");
  }
  return {
    ...parsed,
    generation: 4,
    streamPosition,
  };
}

describe("Codex fact projection", () => {
  test("projects exact model reroutes instead of discarding containment evidence", () => {
    const parsed = parseCodexNotification("model/rerouted", {
      threadId: "thread_rerouted_1",
      turnId: "turn_rerouted_1",
      fromModel: "gpt-5.6-sol",
      toModel: "safety-reroute-model",
      reason: "highRiskCyberActivity",
    });
    expect(parsed).not.toBeNull();
    expect(projectCodexNotificationFacts("account_1", {
      ...parsed!,
      generation: 7,
      streamPosition: 19,
    })).toMatchObject([{
      type: "turn.model_rerouted",
      accountProfileId: "account_1",
      generation: 7,
      streamPosition: 19,
      threadId: "thread_rerouted_1",
      turnId: "turn_rerouted_1",
      fromModel: "gpt-5.6-sol",
      toModel: "safety-reroute-model",
    }]);
  });

  test("normalizes a thread and preserves partial item views", () => {
    const notification: CodexNotification = {
      generation: 4,
      streamPosition: 12,
      method: "thread/started",
      params: {
        thread: thread({
          turns: [{
            id: "turn_1",
            items: [{ type: "agentMessage", id: "item_1", text: "partial" }],
            itemsView: "summary",
            status: "inProgress",
            startedAt: null,
            completedAt: null,
          }],
        }),
      },
    };
    const projected = projectCodexNotificationFacts("account_1", notification);
    expect(projected).toHaveLength(1);
    const observed = projected[0];
    expect(observed).toMatchObject({
      accountProfileId: "account_1",
      factIndex: 0,
      generation: 4,
      origin: "live",
      streamPosition: 12,
      type: "thread.snapshot",
    });
    if (observed?.type !== "thread.snapshot") throw new Error("Expected thread snapshot");
    expect(observed.thread.status).toBe("active");
    expect(observed.thread.turns?.[0]).toMatchObject({ items: null, startedAt: null });
  });

  test("preserves equal adjacent deltas as distinct positioned facts", () => {
    const first: CodexNotification = {
      generation: 4,
      streamPosition: 12,
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "item_1",
        delta: "same",
      },
    };
    const second = { ...first, streamPosition: 13 };
    const projected = [
      ...projectCodexNotificationFacts("account_1", first),
      ...projectCodexNotificationFacts("account_1", second),
    ];
    expect(projected.map(({ streamPosition, type }) => [streamPosition, type])).toEqual([
      [12, "item.delta"],
      [13, "item.delta"],
    ]);
    expect(projected[0]?.encodedBytes).toBeGreaterThan(0);
  });

  test("projects cumulative turn usage separately from the latest interaction", () => {
    const projected = projectCodexNotificationFacts("account_1", {
      generation: 4,
      streamPosition: 14,
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        tokenUsage: {
          total: {
            totalTokens: 233,
            inputTokens: 144,
            cachedInputTokens: 80,
            outputTokens: 89,
            reasoningOutputTokens: 34,
          },
          last: {
            totalTokens: 21,
            inputTokens: 13,
            cachedInputTokens: 8,
            outputTokens: 8,
            reasoningOutputTokens: 3,
          },
          modelContextWindow: 258_400,
        },
      },
    });

    expect(projected).toEqual([
      expect.objectContaining({
        type: "turn.token_usage",
        streamPosition: 14,
        threadId: "thread_1",
        turnId: "turn_1",
        cumulativeCachedInputTokens: 80,
        cumulativeInputTokens: 144,
        cumulativeOutputTokens: 89,
        cumulativeReasoningOutputTokens: 34,
        cachedInputTokens: 8,
        inputTokens: 13,
        outputTokens: 8,
        reasoningOutputTokens: 3,
      }),
    ]);
  });

  test("sanitizes terminal controls and bounds retained display prose", () => {
    const projected = projectCodexNotificationFacts("account_1", {
      generation: 4,
      streamPosition: 12,
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "item_1",
        delta: `safe\u0000\u007f\n${"🙂".repeat(
          MAX_CODEX_FACT_DISPLAY_TEXT_UTF8_BYTES / 4 + 1,
        )}`,
      },
    });
    const fact = projected[0];
    if (fact?.type !== "item.delta") throw new Error("Expected item delta");
    expect(fact.delta.startsWith("safe��\n")).toBeTrue();
    const retainedBytes = new TextEncoder().encode(fact.delta).byteLength;
    expect(retainedBytes).toBeLessThanOrEqual(MAX_CODEX_FACT_DISPLAY_TEXT_UTF8_BYTES);
    expect(retainedBytes).toBeGreaterThan(MAX_CODEX_FACT_DISPLAY_TEXT_UTF8_BYTES - 4);
    expect(fact.truncated).toBeTrue();
    expect(fact.encodedBytes).toBeLessThan(8 * 1_024 * 1_024);
  });

  test("emits ordered lifecycle facts and rejects impossible completion", () => {
    const base = {
      generation: 4,
      streamPosition: 12,
      method: "turn/completed" as const,
      params: {
        threadId: "thread_1",
        turn: {
          id: "turn_1",
          items: [],
          itemsView: "full" as const,
          status: "completed" as const,
          startedAt: 1_753_776_000,
          completedAt: 1_753_776_001,
        },
      },
    };
    expect(projectCodexNotificationFacts("account_1", base)
      .map(({ type, factIndex }) => [type, factIndex])).toEqual([
      ["turn.snapshot", 0],
      ["turn.completed", 1],
    ]);
    expect(() => projectCodexNotificationFacts("account_1", {
      ...base,
      params: {
        ...base.params,
        turn: { ...base.params.turn, status: "inProgress", completedAt: null },
      },
    })).toThrow(CodexFactProjectionError);
  });

  test("trusts only the exact parsed provider usage-limit proof", () => {
    const exact = parseFailedTurnCompletion("usageLimitExceeded", 13);
    if (exact === null) throw new Error("Exact provider quota proof was rejected");
    const exactFacts = projectCodexNotificationFacts("account_1", exact);
    expect(exactFacts).toHaveLength(2);
    expect(exactFacts[0]).toMatchObject({
      type: "turn.snapshot",
      turn: {
        id: "turn_quota_boundary",
        quotaProof: "provider_usage_limit_exceeded",
        status: "failed",
      },
    });
    expect(JSON.stringify(exactFacts)).not.toContain("Private provider failure");

    for (const [index, codexErrorInfo] of [
      "sessionBudgetExceeded",
      "serverOverloaded",
      null,
    ].entries()) {
      const parsed = parseFailedTurnCompletion(codexErrorInfo, 14 + index);
      if (parsed === null) throw new Error("A supported non-quota failure was rejected");
      const facts = projectCodexNotificationFacts("account_1", parsed);
      expect(JSON.stringify(facts)).not.toContain("quotaProof");
    }

    expect(parseFailedTurnCompletion("usage_limit_exceeded", 17)).toBeNull();
    expect(parseFailedTurnCompletion({ usageLimitExceeded: true }, 18)).toBeNull();
  });

  test("projects the complete owned thread lifecycle", () => {
    const notifications: CodexNotification[] = [{
      generation: 4,
      streamPosition: 1,
      method: "thread/archived",
      params: { threadId: "thread_1" },
    }, {
      generation: 4,
      streamPosition: 2,
      method: "thread/unarchived",
      params: { threadId: "thread_1" },
    }, {
      generation: 4,
      streamPosition: 3,
      method: "thread/name/updated",
      params: { threadId: "thread_1", threadName: null },
    }, {
      generation: 4,
      streamPosition: 4,
      method: "thread/status/changed",
      params: { threadId: "thread_1", status: { type: "systemError" } },
    }, {
      generation: 4,
      streamPosition: 5,
      method: "thread/closed",
      params: { threadId: "thread_1" },
    }, {
      generation: 4,
      streamPosition: 6,
      method: "thread/deleted",
      params: { threadId: "thread_1" },
    }];
    expect(notifications.flatMap((notification) =>
      projectCodexNotificationFacts("account_1", notification)
    ).map((fact) => [fact.type, "archived" in fact ? fact.archived : null,
      "status" in fact ? fact.status : null])).toEqual([
      ["thread.archived", true, null],
      ["thread.archived", false, null],
      ["thread.title_changed", null, null],
      ["thread.status_changed", null, "system_error"],
      ["thread.status_changed", null, "not_loaded"],
      ["thread.deleted", null, null],
    ]);
  });

  test("correlates provider resolution without retaining provider authority", () => {
    const [first] = projectCodexNotificationFacts("account_1", {
      generation: 4,
      streamPosition: 18,
      method: "serverRequest/resolved",
      params: { threadId: "thread_1", requestId: "provider-secret-request-id" },
    });
    const [numberId] = projectCodexNotificationFacts("account_1", {
      generation: 4,
      streamPosition: 19,
      method: "serverRequest/resolved",
      params: { threadId: "thread_1", requestId: 7 },
    });
    const [stringId] = projectCodexNotificationFacts("account_1", {
      generation: 4,
      streamPosition: 20,
      method: "serverRequest/resolved",
      params: { threadId: "thread_1", requestId: "7" },
    });
    expect(first).toMatchObject({
      type: "server_request.resolved",
      threadId: "thread_1",
    });
    expect(JSON.stringify(first)).not.toContain("provider-secret-request-id");
    if (
      numberId?.type !== "server_request.resolved" ||
      stringId?.type !== "server_request.resolved"
    ) throw new Error("Expected resolution facts");
    expect(numberId.requestKey).not.toBe(stringId.requestKey);
    expect(codexServerRequestResolutionKey("account_1", 4, "same"))
      .not.toBe(codexServerRequestResolutionKey("account_2", 4, "same"));
    expect(codexServerRequestResolutionKey("account_1", 4, "same"))
      .not.toBe(codexServerRequestResolutionKey("account_1", 5, "same"));
  });

  test("marks no-turn reads as metadata-only and rejects unrenderable dates", () => {
    expect(projectCodexThreadSnapshot(thread(), {
      archived: false,
      turns: "metadata_only",
    }).turns).toBeNull();
    expect(() => projectCodexThreadSnapshot(thread({ createdAt: Number.MAX_SAFE_INTEGER }), {
      archived: false,
      turns: "present",
    })).toThrow(CodexFactProjectionError);
  });

  test("fails closed before an aggregate owned fact crosses its byte bound", () => {
    const text = "x".repeat(MAX_CODEX_FACT_DISPLAY_TEXT_UTF8_BYTES);
    const oversized = thread({
      turns: [{
        id: "turn_1",
        items: Array.from({ length: 5 }, (_, index) => ({
          type: "agentMessage" as const,
          id: `item_${String(index)}`,
          text,
        })),
        itemsView: "full",
        status: "completed",
        startedAt: 1_753_776_000,
        completedAt: 1_753_776_001,
      }],
    });
    expect(() => projectCodexNotificationFacts("account_1", {
      generation: 4,
      streamPosition: 21,
      method: "thread/started",
      params: { thread: oversized },
    })).toThrow(CodexFactProjectionError);
    expect(MAX_CODEX_FACT_ENCODED_BYTES).toBe(8 * 1_024 * 1_024);
  });
});
