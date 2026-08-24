import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { createProfileId, createSessionId } from "./values";
import { sessionEventBodySchema, sessionEventSchema } from "./session-events";

describe("session events", () => {
  test("keeps tool lifecycle identity optional, bounded, and backwards compatible", () => {
    const exactUtf8Boundary = `${"界".repeat(85)}a`;
    const overUtf8Boundary = `${exactUtf8Boundary}b`;
    expect(new TextEncoder().encode(exactUtf8Boundary).byteLength).toBe(256);
    expect(new TextEncoder().encode(overUtf8Boundary).byteLength).toBe(257);
    expect(sessionEventBodySchema.parse({
      type: "item_started",
      turnId: "turn-1",
      itemId: "item-tool",
      itemKind: "mcpToolCall",
      server: exactUtf8Boundary,
      tool: "create_issue",
    })).toMatchObject({ server: exactUtf8Boundary, tool: "create_issue" });
    expect(sessionEventBodySchema.parse({
      type: "item_completed",
      turnId: "turn-1",
      itemId: "item-tool",
      itemKind: "mcpToolCall",
      status: "completed",
    })).not.toHaveProperty("server");
    expect(() => sessionEventBodySchema.parse({
      type: "item_started",
      turnId: "turn-1",
      itemId: "item-tool",
      itemKind: "mcpToolCall",
      server: "s".repeat(257),
      tool: "create_issue",
    })).toThrow();
    expect(() => sessionEventBodySchema.parse({
      type: "item_completed",
      turnId: "turn-1",
      itemId: "item-tool",
      itemKind: "mcpToolCall",
      server: "github",
      tool: "",
    })).toThrow();
    expect(() => sessionEventBodySchema.parse({
      type: "item_completed",
      turnId: "turn-1",
      itemId: "item-tool",
      itemKind: "mcpToolCall",
      server: "github",
      tool: overUtf8Boundary,
    })).toThrow();
  });

  test("accepts provider-visible summary deltas and excludes raw reasoning or command output fields", () => {
    const safe = sessionEventBodySchema.parse({
      type: "reasoning_summary_delta",
      turnId: "turn-1",
      itemId: "item-1",
      text: "Checking the public contract.",
    });
    expect(safe.type).toBe("reasoning_summary_delta");
    expect(() => sessionEventBodySchema.parse({
      type: "reasoning_summary_delta",
      turnId: "turn-1",
      itemId: "item-1",
      text: "safe",
      rawReasoning: "hidden",
    })).toThrow();
    expect(sessionEventBodySchema.parse({
      type: "item_started",
      turnId: "turn-1",
      itemId: "item-2",
      itemKind: "commandExecution",
      liveAcceptanceCommandDigest: "a".repeat(64),
    })).toMatchObject({ liveAcceptanceCommandDigest: "a".repeat(64) });
    expect(() => sessionEventBodySchema.parse({
      type: "item_started",
      turnId: "turn-1",
      itemId: "item-2",
      itemKind: "commandExecution",
      liveAcceptanceCommandDigest: "not-a-digest",
    })).toThrow();
    expect(() => sessionEventBodySchema.parse({
      type: "tool_progress",
      turnId: "turn-1",
      itemId: "item-2",
      toolKind: "command",
      output: "secret output",
    })).toThrow();
  });

  test("keeps all public envelopes bounded and session-account fenced", () => {
    const parsed = sessionEventSchema.parse({
      version: 1,
      sessionId: createSessionId(),
      streamEpoch: crypto.randomUUID(),
      sequence: 1,
      recordedAt: Date.now(),
      accountId: createProfileId(),
      providerGeneration: 2,
      providerConnectionId: crypto.randomUUID(),
      body: { type: "warning", code: "provider_warning", message: "A bounded warning." },
    });
    expect(parsed.sequence).toBe(1);
  });

  test("is total over arbitrary candidate bodies", () => {
    fc.assert(fc.property(fc.jsonValue(), (value) => {
      const result = sessionEventBodySchema.safeParse(value);
      expect(typeof result.success).toBe("boolean");
    }), { numRuns: 500 });
  });
});
