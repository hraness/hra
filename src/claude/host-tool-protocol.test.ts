import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  HRA_HOST_TOOL_NAMES,
} from "../domain/host-tools.ts";
import {
  CLAUDE_HOST_TOOL_SESSION_HISTORY_LIMIT,
  ClaudeHostToolMcpServer,
  digestClaudeHostToolInvocation,
  type ClaudeHostToolInvocation,
  type ClaudeHostToolInvocationOutcome,
  type ClaudeHostToolInvocationReceipt,
} from "./host-tool-protocol.ts";
import {
  CLAUDE_PIN,
  CLAUDE_PIN_MCP_PROTOCOL_VERSION,
  PINNED_CLAUDE_EVIDENCE_DIGESTS,
} from "./pin.ts";

const initialize = {
  id: 0,
  jsonrpc: "2.0",
  method: "initialize",
  params: {
    capabilities: { elicitation: {}, roots: { listChanged: true } },
    clientInfo: {
      description: "Anthropic's agentic coding tool",
      name: "claude-code",
      title: "Claude Code",
      version: CLAUDE_PIN,
      websiteUrl: "https://claude.com/claude-code",
    },
    protocolVersion: CLAUDE_PIN_MCP_PROTOCOL_VERSION,
  },
} as const;

const openServer = (input: {
  invoke?: (call: ClaudeHostToolInvocation) => Promise<ClaudeHostToolInvocationOutcome>;
  written?: (receipt: ClaudeHostToolInvocationReceipt) => Promise<void>;
} = {}): Readonly<{
  calls: ClaudeHostToolInvocation[];
  receipts: ClaudeHostToolInvocationReceipt[];
  server: ClaudeHostToolMcpServer;
}> => {
  const calls: ClaudeHostToolInvocation[] = [];
  const receipts: ClaudeHostToolInvocationReceipt[] = [];
  let nextCallId = 0;
  const server = new ClaudeHostToolMcpServer({
    handler: {
      async invoke(call) {
        calls.push(call);
        return input.invoke?.(call) ?? { ok: true, text: "{\"ok\":true}" };
      },
      async responseWritten(receipt) {
        receipts.push(receipt);
        await input.written?.(receipt);
      },
    },
    newCallId: () => `call-${String(++nextCallId).padStart(4, "0")}`,
  });
  return { calls, receipts, server };
};

const ready = async (server: ClaudeHostToolMcpServer): Promise<void> => {
  const admitted = await server.handle(initialize);
  expect(admitted?.response).toEqual({
    id: 0,
    jsonrpc: "2.0",
    result: {
      capabilities: { tools: { listChanged: false } },
      protocolVersion: CLAUDE_PIN_MCP_PROTOCOL_VERSION,
      serverInfo: {
        name: "hra",
        title: "HRA session host tools",
        version: "1",
      },
    },
  });
  expect(await server.handle({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  })).toBeNull();
};

describe("Claude HRA MCP protocol", () => {
  test("pins the exact three-frame Claude 2.1.260 MCP startup capture", async () => {
    const fixture = await Bun.file(join(
      import.meta.dir,
      "..",
      "..",
      "docs",
      "providers",
      "claude-fixtures",
      "mcp-handshake-2.1.260.jsonl.txt",
    )).text();
    expect(createHash("sha256").update(fixture).digest("hex"))
      .toBe(PINNED_CLAUDE_EVIDENCE_DIGESTS.mcpHandshake);
    const frames = fixture.trimEnd().split("\n").map((line) => JSON.parse(line) as unknown);
    expect(frames).toEqual([
      initialize,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { id: 1, jsonrpc: "2.0", method: "tools/list" },
    ]);
  });

  test("admits the exact pinned initialize handshake and exposes only the shared manifest", async () => {
    const { server } = openServer();
    await ready(server);
    const listed = await server.handle({ id: 1, jsonrpc: "2.0", method: "tools/list" });
    const result = listed?.response.result as { tools: readonly {
      name: string;
      inputSchema: Readonly<Record<string, unknown>>;
    }[] };
    expect(result.tools.map((tool) => tool.name)).toEqual([...HRA_HOST_TOOL_NAMES]);
    expect(result.tools).toHaveLength(8);
    expect(result.tools.every((tool) => tool.inputSchema.type === "object"
      || Object.hasOwn(tool.inputSchema, "oneOf"))).toBe(true);
    expect(await server.handle({ id: 2, jsonrpc: "2.0", method: "ping" }))
      .toMatchObject({ response: { id: 2, result: {} } });
  });

  test("calls a closed host tool without accepting model-supplied actor identity", async () => {
    const { calls, receipts, server } = openServer();
    await ready(server);
    const request = {
      id: "mcp-call-1",
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: { limit: 3 }, name: "sessions_list" },
    } as const;
    const dispatch = await server.handle(request);
    expect(dispatch?.response).toEqual({
      id: "mcp-call-1",
      jsonrpc: "2.0",
      result: {
        content: [{ text: "{\"ok\":true}", type: "text" }],
        isError: false,
      },
    });
    expect(calls).toEqual([{
      callId: "call-0001",
      request: { input: { limit: 3 }, tool: "sessions_list" },
      requestDigest: digestClaudeHostToolInvocation(
        "call-0001",
        { input: { limit: 3 }, tool: "sessions_list" },
      ),
    }]);
    await dispatch?.afterWrite?.();
    await dispatch?.afterWrite?.();
    expect(receipts).toEqual([{
      callId: "call-0001",
      requestDigest: calls[0]!.requestDigest,
    }]);

    // Exact JSON-RPC replay is served from the bounded ledger without a
    // second mutation or response-written notification.
    const replay = await server.handle(request);
    expect(replay?.response).toEqual(dispatch?.response);
    await replay?.afterWrite?.();
    expect(calls).toHaveLength(1);
    expect(receipts).toHaveLength(1);

    const injected = await server.handle({
      ...request,
      id: "mcp-call-actor",
      params: {
        arguments: { actor: { providerThreadId: "forged" }, limit: 3 },
        name: "sessions_list",
      },
    });
    expect(injected?.response.error).toEqual({
      code: -32_602,
      message: "MCP tool arguments do not match an advertised HRA tool",
    });
    expect(calls).toHaveLength(1);
  });

  test("fails closed on drift, unknown methods, extra params, and request-id reuse", async () => {
    const wrongVersion = openServer().server;
    const rejected = await wrongVersion.handle({
      ...initialize,
      params: { ...initialize.params, protocolVersion: "2025-06-18" },
    });
    expect(rejected?.response.error?.code).toBe(-32_602);

    const { server } = openServer();
    expect((await server.handle({ id: 1, jsonrpc: "2.0", method: "tools/list" }))
      ?.response.error?.code).toBe(-32_600);
    await ready(server);
    expect((await server.handle({ id: 3, jsonrpc: "2.0", method: "resources/list" }))
      ?.response.error?.code).toBe(-32_601);
    expect((await server.handle({ id: 4, jsonrpc: "2.0", method: "tools/list", params: { cursor: "x" } }))
      ?.response.error?.code).toBe(-32_602);
    expect((await server.handle({
      id: 5,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: {}, name: "not_advertised" },
    }))?.response.error?.code).toBe(-32_602);

    await server.handle({
      id: 6,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: { limit: 1 }, name: "sessions_list" },
    });
    expect((await server.handle({
      id: 6,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: { limit: 2 }, name: "sessions_list" },
    }))?.response.error?.code).toBe(-32_600);

    // IDs are fenced across the entire session, not just within tools/call.
    expect((await server.handle({ id: 0, jsonrpc: "2.0", method: "ping" }))
      ?.response.error?.code).toBe(-32_600);
    expect((await server.handle({ id: 3, jsonrpc: "2.0", method: "tools/list" }))
      ?.response.error?.code).toBe(-32_600);
    expect((await server.handle({ id: 8, jsonrpc: "2.0", method: "ping" }))
      ?.response.result).toEqual({});
    expect((await server.handle({ id: 8, jsonrpc: "2.0", method: "tools/list" }))
      ?.response.error?.code).toBe(-32_600);
    expect((await server.handle({ id: 9, jsonrpc: "2.0", method: "tools/list" }))
      ?.response.result).toBeDefined();
    expect((await server.handle({
      id: 9,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: {}, name: "sessions_list" },
    }))?.response.error?.code).toBe(-32_600);
  });

  test("never responds to notifications, including malformed irrelevant cancellations", async () => {
    const { server } = openServer();
    await ready(server);
    expect(await server.handle({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { reason: { malformed: true }, requestId: ["not", "an", "id"] },
    })).toBeNull();
    expect(await server.handle({
      extra: true,
      jsonrpc: "not-json-rpc",
      method: 7,
      params: null,
    })).toBeNull();
    expect(await server.handle({
      jsonrpc: "2.0",
      method: "notifications/unknown",
      params: { arbitrary: true },
    })).toBeNull();
  });

  test("bounds session history while permanently fencing reclaimed request IDs", async () => {
    const { calls, receipts, server } = openServer();
    await ready(server);
    let latest: Awaited<ReturnType<ClaudeHostToolMcpServer["handle"]>> = null;
    // `initialize` owns the other lifetime-history slot.
    const admittedCalls = CLAUDE_HOST_TOOL_SESSION_HISTORY_LIMIT - 1;
    for (let index = 0; index < admittedCalls; index += 1) {
      latest = await server.handle({
        id: `many-${index}`,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { limit: 1 }, name: "sessions_list" },
      });
      expect(latest?.response.error).toBeUndefined();
      await latest?.afterWrite?.();
    }
    expect(calls).toHaveLength(admittedCalls);
    expect(receipts).toHaveLength(admittedCalls);

    const exhausted = await server.handle({
      id: `many-${String(admittedCalls)}`,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: { limit: 1 }, name: "sessions_list" },
    });
    expect(exhausted?.response.error).toEqual({
      code: -32_600,
      message: "MCP session request history is exhausted",
    });

    const oldReplay = await server.handle({
      id: "many-0",
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: { limit: 1 }, name: "sessions_list" },
    });
    expect(oldReplay?.response.error).toEqual({
      code: -32_600,
      message: "MCP request id replay is no longer available",
    });
    const recentReplay = await server.handle({
      id: `many-${String(admittedCalls - 1)}`,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: { limit: 1 }, name: "sessions_list" },
    });
    expect(recentReplay?.response).toEqual(latest?.response);
    await recentReplay?.afterWrite?.();
    expect(calls).toHaveLength(admittedCalls);
    expect(receipts).toHaveLength(admittedCalls);
  });

  test("returns handler failures as MCP tool errors without leaking exception text", async () => {
    const { server } = openServer({
      invoke: async () => {
        throw new Error("PRIVATE_HANDLER_DETAIL");
      },
    });
    await ready(server);
    const dispatch = await server.handle({
      id: 7,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: {}, name: "sessions_list" },
    });
    expect(dispatch?.response.result).toEqual({
      content: [{ text: "HRA could not complete this host-tool request.", type: "text" }],
      isError: true,
    });
    expect(JSON.stringify(dispatch)).not.toContain("PRIVATE_HANDLER_DETAIL");
    expect(dispatch?.afterWrite).toBeDefined();
    await dispatch?.afterWrite?.();
  });

  test("admits an exact 64-KiB escaped result and rejects one byte more", async () => {
    let text = "😀".repeat((64 * 1_024) / 4);
    const { server } = openServer({ invoke: async () => ({ ok: true, text }) });
    await ready(server);
    const exact = await server.handle({
      id: "exact-result",
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: {}, name: "sessions_list" },
    });
    expect(new TextEncoder().encode(text)).toHaveLength(64 * 1_024);
    expect(exact?.response.result).toMatchObject({ isError: false });
    await exact?.afterWrite?.();
    text += "x";
    const over = await server.handle({
      id: "over-result",
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: {}, name: "sessions_list" },
    });
    expect(over?.response.result).toEqual({
      content: [{ text: "HRA refused an invalid host-tool result.", type: "text" }],
      isError: true,
    });
  });
});
