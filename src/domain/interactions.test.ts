import { describe, expect, test } from "bun:test";

import {
  interactionRecordSchema,
  mcpFormFieldSchema,
  providerInteractionAuthoritySchema,
  providerRequestIdSchema,
  publicInteractionSchema,
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
      intendedTerminalState: "resolved" as const,
      requestedAt: 1,
      deadlineAt: 1_801,
      updatedAt: 2,
      terminalAt: null,
    };
    expect(interactionRecordSchema.parse(value)).toEqual(value);
    expect(() => interactionRecordSchema.parse({ ...value, response: { answers: { q1: ["secret"] } } })).toThrow();
  });

  test("public interactions expose only bounded display context and response presence", () => {
    const value = {
      version: 1 as const,
      id: crypto.randomUUID(),
      sessionId: createSessionId(),
      kind: "command_approval" as const,
      state: "response_written" as const,
      revision: 3,
      blocking: true,
      display: {
        kind: "command_approval" as const,
        summary: "Run the release verification",
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        allowsSessionApproval: false,
      },
      responseRecorded: true,
      context: { turnId: "turn-1", itemId: "item-1" },
      requestedAt: 1,
      deadlineAt: 1_801,
      updatedAt: 2,
      terminalAt: null,
    };
    expect(publicInteractionSchema.parse(value)).toEqual(value);
    expect(() => publicInteractionSchema.parse({
      ...value,
      authority: { requestId: "provider-private" },
    })).toThrow();
    expect(() => publicInteractionSchema.parse({
      ...value,
      requestDigest: "a".repeat(64),
    })).toThrow();
    expect(() => publicInteractionSchema.parse({
      ...value,
      responseDigest: "b".repeat(64),
    })).toThrow();
  });

  test("durable and public interactions reject URL elicitation and incoherent displays", () => {
    const value = {
      version: 1 as const,
      id: crypto.randomUUID(),
      sessionId: null,
      kind: "mcp_elicitation" as const,
      state: "pending" as const,
      revision: 1,
      blocking: true,
      display: {
        kind: "mcp_elicitation" as const,
        summary: "Authorize the server",
        serverName: "example",
        mode: "form" as const,
        url: null,
        mayContainSecrets: true as const,
      },
      responseRecorded: false,
      context: { turnId: null, itemId: null },
      requestedAt: 1,
      deadlineAt: 1_801,
      updatedAt: 1,
      terminalAt: null,
    };
    expect(publicInteractionSchema.parse(value)).toEqual(value);
    expect(() => publicInteractionSchema.parse({
      ...value,
      display: { ...value.display, mode: "url" },
    })).toThrow();
    expect(() => publicInteractionSchema.parse({
      ...value,
      display: { ...value.display, url: "https://example.com/authorize?secret=SENTINEL" },
    })).toThrow();
    expect(() => publicInteractionSchema.parse({
      ...value,
      kind: "user_input",
    })).toThrow();
    expect(() => publicInteractionSchema.parse({
      ...value,
      display: {
        ...value.display,
        fields: [
          { name: "confirmed", type: "boolean", required: true },
          { name: "confirmed", type: "boolean", required: false },
        ],
      },
    })).toThrow();
  });

  test("keeps the public MCP field contract bounded and free of answers or presentation metadata", () => {
    expect(mcpFormFieldSchema.parse({
      name: "channel",
      type: "single_select",
      required: true,
      choices: ["stable", "fast"],
    })).toEqual({
      name: "channel",
      type: "single_select",
      required: true,
      choices: ["stable", "fast"],
    });
    for (const invalid of [
      {
        name: "channel",
        type: "single_select",
        required: true,
        choices: ["stable", "stable"],
      },
      {
        name: "bad field",
        type: "boolean",
        required: true,
      },
      {
        name: "token",
        type: "string",
        required: true,
        minLength: 8,
        maxLength: 4,
        format: null,
      },
      {
        name: "token",
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 10,
        format: null,
        answer: "MCP_FIELD_ANSWER_SENTINEL",
      },
      {
        name: "token",
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 10,
        format: null,
        title: "MCP_FIELD_TITLE_SENTINEL",
      },
    ]) expect(() => mcpFormFieldSchema.parse(invalid)).toThrow();
  });
});
