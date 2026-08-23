import { describe, expect, test } from "bun:test";

import {
  interactionRecordSchema,
  providerInteractionAuthoritySchema,
  providerRequestIdSchema,
} from "./interactions";
import { createProfileId, createSessionId } from "./values";

describe("provider interactions", () => {
  test("preserves numeric and string JSON-RPC request IDs as different authority", () => {
    expect(providerRequestIdSchema.parse({ type: "number", value: 1 })).not.toEqual(
      providerRequestIdSchema.parse({ type: "string", value: "1" }),
    );
  });

  test("allows nullable MCP context while keeping method, digest, connection, and generation exact", () => {
    const authority = providerInteractionAuthoritySchema.parse({
      profileId: createProfileId(),
      processGeneration: 4,
      connectionId: crypto.randomUUID(),
      requestId: { type: "string", value: "elicitation-1" },
      method: "mcpServer/elicitation/request",
      requestDigest: "a".repeat(64),
      threadId: null,
      turnId: null,
      itemId: null,
      approvalId: null,
    });
    expect(authority.turnId).toBeNull();
  });

  test("durable records contain sanitized display and response digest, not response secrets", () => {
    const value = {
      version: 1 as const,
      publicId: crypto.randomUUID(),
      sessionId: createSessionId(),
      authority: {
        profileId: createProfileId(),
        processGeneration: 1,
        connectionId: crypto.randomUUID(),
        requestId: { type: "number" as const, value: 7 },
        method: "item/tool/requestUserInput",
        requestDigest: "b".repeat(64),
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        approvalId: null,
      },
      kind: "user_input" as const,
      state: "response_prepared" as const,
      revision: 2,
      blocking: true,
      display: {
        kind: "user_input" as const,
        summary: "Codex needs one answer.",
        blocking: true,
        questions: [{ id: "q1", header: "Token", question: "Enter it", options: null, allowsOther: false, secret: true }],
      },
      responseDigest: "c".repeat(64),
      requestedAt: 1,
      updatedAt: 2,
      terminalAt: null,
    };
    expect(interactionRecordSchema.parse(value)).toEqual(value);
    expect(() => interactionRecordSchema.parse({ ...value, response: { answers: { q1: ["secret"] } } })).toThrow();
  });
});
