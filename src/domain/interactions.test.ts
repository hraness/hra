import { describe, expect, test } from "bun:test";

import {
  interactionRecordSchema,
  protectedInteractionDetailDocumentSchema,
  mcpFormFieldSchema,
  providerInteractionAuthoritySchema,
  providerRequestIdSchema,
  permissionCategoryIsNetworkOrExternal,
  publicInteractionSchema,
} from "./interactions";
import { isNetworkOrExternalPermission } from "../daemon/autorespond";
import { projectPublicProviderIdentifier } from "../public-provider-identifier";
import { createProfileId, createSessionId } from "./values";

const providerIdentifierKey = Buffer.alloc(32, 0x41);

describe("provider interactions", () => {
  test("binds complete protected authority to one live public revision and kind", () => {
    const document = {
      type: "hra_protected_interaction_detail" as const,
      version: 1 as const,
      binding: {
        interactionId: crypto.randomUUID(),
        revision: 2,
        kind: "permission_approval" as const,
        sessionId: createSessionId(),
        profileId: createProfileId(),
        processGeneration: 3,
        connectionId: crypto.randomUUID(),
      },
      authority: {
        kind: "permission_approval" as const,
        permissions: { fileSystem: { read: ["/private/exact"] } },
        reason: "Read the exact path",
        workingDirectory: "/workspace",
        environmentId: "environment-1",
      },
    };
    expect(protectedInteractionDetailDocumentSchema.parse(document)).toEqual(document);
    expect(() => protectedInteractionDetailDocumentSchema.parse({
      ...document,
      authority: { ...document.authority, workingDirectory: null },
    })).toThrow();
    expect(() => protectedInteractionDetailDocumentSchema.parse({
      ...document,
      binding: { ...document.binding, kind: "command_approval" },
    })).toThrow();
    expect(() => protectedInteractionDetailDocumentSchema.parse({
      ...document,
      authority: { ...document.authority, permissions: { value: undefined } },
    })).toThrow();
  });

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
        availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
      },
      responseRecorded: true,
      context: {
        turnId: projectPublicProviderIdentifier("turn-1", providerIdentifierKey),
        itemId: projectPublicProviderIdentifier("item-1", providerIdentifierKey),
      },
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
      display: {
        ...value.display,
        availableDecisions: ["once", "once"],
      },
    })).toThrow("unique");
    expect(() => publicInteractionSchema.parse({
      ...value,
      responseDigest: "b".repeat(64),
    })).toThrow();
    const privateContext = `${["", "Users", "person", "private"].join("/")}/api_key=INTERACTION-CONTEXT-SECRET`;
    expect(() => publicInteractionSchema.parse({
      ...value,
      context: { ...value.context, turnId: privateContext },
    })).toThrow();
    expect(publicInteractionSchema.parse({
      ...value,
      context: {
        ...value.context,
        turnId: projectPublicProviderIdentifier(
          privateContext,
          providerIdentifierKey,
        ),
      },
    }).context.turnId).toMatch(/^opaque_v2_[a-f0-9]{64}$/u);
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

describe("permission category classification", () => {
  const permissionApproval = (names: readonly string[]) => ({
    allowsSessionScope: true,
    kind: "permission_approval" as const,
    reason: null,
    requested: names.map((name) => ({ name })),
    summary: "Allow additional permissions",
  });

  test("the network category test agrees with the autoresponder gate", () => {
    for (const name of ["network_outbound", "mcp_tool", "web_search", "remote_exec"]) {
      expect(permissionCategoryIsNetworkOrExternal(name)).toBe(true);
      expect(isNetworkOrExternalPermission(permissionApproval([name]))).toBe(true);
    }
    expect(permissionCategoryIsNetworkOrExternal("workspace_write")).toBe(false);
    expect(isNetworkOrExternalPermission(permissionApproval(["workspace_write"]))).toBe(false);
  });
});
