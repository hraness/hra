import { afterAll, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

import { HRA_HOST_TOOL_NAMES } from "../domain/host-tools.ts";
import { ClaudeError } from "./errors.ts";
import {
  CLAUDE_HOST_TOOL_CALLBACK_VERSION,
  ClaudeHostToolBindingAuthority,
  ClaudeHostToolSocketClient,
  readClaudeHostToolBinding,
  runClaudeHostToolStdio,
  type ClaudeHostToolCallbackHandler,
  type ClaudeHostToolCallbackRequest,
} from "./host-tool-bridge.ts";
import {
  CLAUDE_HOST_TOOL_SESSION_HISTORY_LIMIT,
  digestClaudeHostToolInvocation,
  type ClaudeHostToolInvocation,
} from "./host-tool-protocol.ts";
import { CLAUDE_PIN, CLAUDE_PIN_MCP_PROTOCOL_VERSION } from "./pin.ts";

const roots: string[] = [];

const scratch = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(
    await realpath(process.cwd()),
    ".hra-claude-host-tools-",
  )));
  await chmod(root, 0o700);
  roots.push(root);
  return root;
};

afterAll(async () => {
  await Promise.all(roots.splice(0).map(async (root) =>
    await rm(root, { force: true, recursive: true })));
});

const deterministicAuthority = (): ClaudeHostToolBindingAuthority =>
  new ClaudeHostToolBindingAuthority({
    bridgeArguments: ["/private/hra/host-tool-bridge-main.ts"],
    bridgeCommand: process.execPath,
    newBindingId: () => `clhb_${"1".repeat(32)}`,
    newCapability: () => "A".repeat(43),
  });

const identity = {
  processGeneration: 7,
  profileId: `acct_${"2".repeat(32)}`,
  provider: "claude",
  providerThreadId: "11111111-2222-4333-8444-555555555555",
} as const;

const noOpHandler = (): ClaudeHostToolCallbackHandler => ({
  call: async () => ({ ok: true }),
  responseWritten: async () => undefined,
});

describe("Claude host-tool binding authority", () => {
  test("provisions mode-0600 material and an eight-tool strict MCP launch without putting the capability in argv", async () => {
    const root = await scratch();
    const authority = deterministicAuthority();
    const lease = await authority.provision({
      callbackSocketPath: join(root, "callback.sock"),
      identity,
      privateRoot: root,
    });
    expect((await lstat(lease.directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(lease.bindingPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(lease.mcpConfigPath)).mode & 0o777).toBe(0o600);

    const material = await readClaudeHostToolBinding(lease.bindingPath);
    expect(material).toEqual({
      bindingId: `clhb_${"1".repeat(32)}`,
      callbackSocketPath: join(root, "callback.sock"),
      capability: "A".repeat(43),
      version: 1,
    });
    const configText = await Bun.file(lease.mcpConfigPath).text();
    const config = JSON.parse(configText) as {
      mcpServers: Record<string, { args: string[]; command: string; type: string }>;
    };
    expect(Object.keys(config.mcpServers)).toEqual(["hra"]);
    expect(config.mcpServers.hra).toEqual({
      args: ["/private/hra/host-tool-bridge-main.ts", "--binding", lease.bindingPath],
      command: process.execPath,
      type: "stdio",
    });
    expect(configText).not.toContain("A".repeat(43));
    expect(configText).not.toContain(identity.providerThreadId);
    await authority.activate(lease.bindingId);
    await authority.close();
    expect(await lstat(lease.directory).catch(() => null)).toBeNull();
  });

  test("accepts the initial nonnegative profile generation", async () => {
    const root = await scratch();
    const authority = new ClaudeHostToolBindingAuthority({
      bridgeArguments: ["/private/hra/host-tool-bridge-main.ts"],
      bridgeCommand: process.execPath,
      newBindingId: () => `clhb_${"0".repeat(32)}`,
      newCapability: () => "Z".repeat(43),
    });
    const lease = await authority.provision({
      callbackSocketPath: join(root, "callback.sock"),
      identity: { ...identity, processGeneration: 0 },
      privateRoot: root,
    });
    await authority.activate(lease.bindingId);
    await authority.revoke(lease.bindingId);
  });

  test("joins an in-flight provision and retries its private-directory cleanup before close succeeds", async () => {
    const root = await scratch();
    let attempts = 0;
    let leakedDirectory: string | undefined;
    let closeTask!: Promise<void>;
    let announceRetry!: () => void;
    let releaseRetry!: () => void;
    const retryStarted = new Promise<void>((resolve) => { announceRetry = resolve; });
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
    const authority = new ClaudeHostToolBindingAuthority({
      bridgeArguments: ["/private/hra/host-tool-bridge-main.ts"],
      bridgeCommand: process.execPath,
      newBindingId: () => `clhb_${"4".repeat(32)}`,
      newCapability: () => {
        closeTask = authority.close();
        return "D".repeat(43);
      },
      removeDirectory: async (path) => {
        attempts += 1;
        leakedDirectory = path;
        if (attempts === 1) throw new Error("injected provision cleanup failure");
        announceRetry();
        await retryGate;
        await rm(path, { force: true, maxRetries: 0, recursive: true });
      },
    });

    await expect(authority.provision({
      callbackSocketPath: join(root, "callback.sock"),
      identity,
      privateRoot: root,
    })).rejects.toThrow("private-directory cleanup was incomplete");
    await retryStarted;
    let closeSettled = false;
    void closeTask.then(() => { closeSettled = true; });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(leakedDirectory).toBeDefined();
    expect(await lstat(leakedDirectory ?? "").catch(() => null)).not.toBeNull();

    releaseRetry();
    await closeTask;
    expect(attempts).toBe(2);
    expect(await lstat(leakedDirectory ?? "").catch(() => null)).toBeNull();
  });

  test("derives caller identity from the binding, rejects forgery, and revokes before cleanup", async () => {
    const root = await scratch();
    const authority = deterministicAuthority();
    const lease = await authority.provision({
      callbackSocketPath: join(root, "callback.sock"),
      identity,
      privateRoot: root,
    });
    const material = await readClaudeHostToolBinding(lease.bindingPath);
    const invocation: ClaudeHostToolInvocation = {
      callId: "call-1",
      request: { input: { limit: 2 }, tool: "sessions_list" },
      requestDigest: digestClaudeHostToolInvocation(
        "call-1",
        { input: { limit: 2 }, tool: "sessions_list" },
      ),
    };
    const calls: unknown[] = [];
    const receipts: unknown[] = [];
    const handler: ClaudeHostToolCallbackHandler = {
      async call(call) {
        calls.push(call);
        return { sessions: [] };
      },
      async responseWritten(receipt) {
        receipts.push(receipt);
      },
    };
    const request = {
      bindingId: material.bindingId,
      callId: invocation.callId,
      capability: material.capability,
      input: invocation.request.input,
      kind: "call",
      requestDigest: invocation.requestDigest,
      tool: invocation.request.tool,
      version: CLAUDE_HOST_TOOL_CALLBACK_VERSION,
    } as const;
    await expect(authority.handleCallback(request, handler)).rejects.toThrow("binding is unavailable");
    await authority.activate(lease.bindingId);
    expect(await authority.handleCallback(request, handler)).toMatchObject({
      kind: "call_result",
      ok: true,
      text: "{\"sessions\":[]}",
    });
    expect(await authority.handleCallback(request, handler)).toMatchObject({
      kind: "call_result",
      ok: true,
    });
    expect(calls).toEqual([{
      ...identity,
      bindingId: lease.bindingId,
      ...invocation,
    }]);

    const receipt = {
      bindingId: material.bindingId,
      callId: invocation.callId,
      capability: material.capability,
      kind: "response_written",
      requestDigest: invocation.requestDigest,
      version: CLAUDE_HOST_TOOL_CALLBACK_VERSION,
    } as const;
    await authority.handleCallback(receipt, handler);
    await authority.handleCallback(receipt, handler);
    expect(receipts).toEqual([{
      ...identity,
      bindingId: lease.bindingId,
      callId: invocation.callId,
      request: invocation.request,
      requestDigest: invocation.requestDigest,
    }]);

    await expect(authority.handleCallback({
      ...request,
      capability: "B".repeat(43),
    }, handler)).rejects.toThrow("binding is unavailable");
    await expect(authority.handleCallback({
      ...request,
      actor: { providerThreadId: "forged" },
    }, handler)).rejects.toThrow("closed contract");

    await authority.revoke(lease.bindingId);
    expect(await lstat(lease.directory).catch(() => null)).toBeNull();
    await expect(authority.handleCallback(request, handler)).rejects.toThrow("binding is unavailable");
  });

  test("invalidates immediately and retains retryable cleanup custody after removal fails", async () => {
    const root = await scratch();
    let attempts = 0;
    let releaseRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
    const authority = new ClaudeHostToolBindingAuthority({
      bridgeArguments: ["/private/hra/host-tool-bridge-main.ts"],
      bridgeCommand: process.execPath,
      newBindingId: () => `clhb_${"3".repeat(32)}`,
      newCapability: () => "C".repeat(43),
      removeDirectory: async (path) => {
        attempts += 1;
        if (attempts === 1) throw new Error("injected cleanup failure");
        await retryGate;
        await rm(path, { force: true, maxRetries: 0, recursive: true });
      },
    });
    const lease = await authority.provision({
      callbackSocketPath: join(root, "callback.sock"),
      identity,
      privateRoot: root,
    });
    await authority.activate(lease.bindingId);
    const material = await readClaudeHostToolBinding(lease.bindingPath);
    const request = {
      bindingId: material.bindingId,
      callId: "call-revoke-retry",
      capability: material.capability,
      input: {},
      kind: "call",
      requestDigest: digestClaudeHostToolInvocation(
        "call-revoke-retry",
        { input: {}, tool: "sessions_list" },
      ),
      tool: "sessions_list",
      version: CLAUDE_HOST_TOOL_CALLBACK_VERSION,
    } as const;

    const failed = authority.revoke(lease.bindingId);
    await expect(authority.handleCallback(request, noOpHandler()))
      .rejects.toThrow("binding is unavailable");
    await expect(failed).rejects.toThrow("injected cleanup failure");
    expect(await lstat(lease.directory).catch(() => null)).not.toBeNull();
    await expect(authority.provision({
      callbackSocketPath: join(root, "callback.sock"),
      identity,
      privateRoot: root,
    })).rejects.toThrow("binding id was reused");

    const retry = authority.revoke(lease.bindingId);
    const joinedRetry = authority.revoke(lease.bindingId);
    expect(attempts).toBe(2);
    releaseRetry();
    await Promise.all([retry, joinedRetry]);
    expect(await lstat(lease.directory).catch(() => null)).toBeNull();
    expect(attempts).toBe(2);
    await authority.revoke(lease.bindingId);
    expect(attempts).toBe(2);
  });

  test("refuses non-private roots and binding files", async () => {
    const root = await scratch();
    await chmod(root, 0o755);
    const authority = deterministicAuthority();
    await expect(authority.provision({
      callbackSocketPath: join(root, "callback.sock"),
      identity,
      privateRoot: root,
    })).rejects.toThrow("not private");
    await chmod(root, 0o700);
    const lease = await authority.provision({
      callbackSocketPath: join(root, "callback.sock"),
      identity,
      privateRoot: root,
    });
    await chmod(lease.bindingPath, 0o644);
    await expect(readClaudeHostToolBinding(lease.bindingPath)).rejects.toThrow("not private");
    await chmod(lease.bindingPath, 0o600);
    await chmod(lease.directory, 0o755);
    await expect(readClaudeHostToolBinding(lease.bindingPath)).rejects.toThrow("not private");
    await authority.close();
  });

  test("requires the callback socket path to remain beneath a canonical private directory", async () => {
    const root = await scratch();
    const otherRoot = await scratch();
    const authority = deterministicAuthority();
    await expect(authority.provision({
      callbackSocketPath: join(otherRoot, "callback.sock"),
      identity,
      privateRoot: root,
    })).rejects.toThrow("beneath the private root");
    await expect(authority.provision({
      callbackSocketPath: join(root, "missing", "callback.sock"),
      identity,
      privateRoot: root,
    })).rejects.toThrow("parent is unavailable");
    await authority.close();
  });
});

describe("Claude host-tool stdio bridge", () => {
  test("carries only the opaque binding over a local socket and reports response-written", async () => {
    const root = await scratch();
    const socketPath = join(root, "callback.sock");
    const authority = deterministicAuthority();
    const lease = await authority.provision({ callbackSocketPath: socketPath, identity, privateRoot: root });
    await authority.activate(lease.bindingId);
    const material = await readClaudeHostToolBinding(lease.bindingPath);
    const calls: unknown[] = [];
    const receipts: unknown[] = [];
    const handler: ClaudeHostToolCallbackHandler = {
      async call(call) {
        calls.push(call);
        return { accepted: true };
      },
      async responseWritten(receipt) {
        receipts.push(receipt);
      },
    };
    const transported: ClaudeHostToolCallbackRequest[] = [];
    const client = new ClaudeHostToolSocketClient(material, async (path, value) => {
      expect(path).toBe(socketPath);
      transported.push(value);
      return await authority.handleCallback(value, handler);
    });
    const invocation: ClaudeHostToolInvocation = {
      callId: "call-socket",
      request: { input: {}, tool: "sessions_list" },
      requestDigest: digestClaudeHostToolInvocation(
        "call-socket",
        { input: {}, tool: "sessions_list" },
      ),
    };
    await expect(client.invoke(invocation)).resolves.toEqual({
      ok: true,
      text: "{\"accepted\":true}",
    });
    await client.responseWritten(invocation);
    expect(calls).toEqual([{
      ...identity,
      bindingId: lease.bindingId,
      ...invocation,
    }]);
    expect(receipts).toHaveLength(1);
    expect(transported.map((request) => request.kind)).toEqual(["call", "response_written"]);
    expect(transported.every((request) => !Object.hasOwn(request, "actor"))).toBe(true);
    await authority.close();
  });

  test("implements initialize, tools/list, and tools/call as bounded JSONL", async () => {
    const observed: ClaudeHostToolInvocation[] = [];
    const receipts: unknown[] = [];
    const frames = [
      {
        id: 0,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: { elicitation: {}, roots: { listChanged: true } },
          clientInfo: { name: "claude-code", version: CLAUDE_PIN },
          protocolVersion: CLAUDE_PIN_MCP_PROTOCOL_VERSION,
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { id: 1, jsonrpc: "2.0", method: "tools/list" },
      {
        id: 2,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: {}, name: "sessions_list" },
      },
    ];
    const bytes = new TextEncoder().encode(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`);
    async function* source(): AsyncIterable<Uint8Array> {
      yield bytes.subarray(0, 31);
      yield bytes.subarray(31);
    }
    const output: string[] = [];
    await runClaudeHostToolStdio({
      handler: {
        async invoke(call) {
          observed.push(call);
          return { ok: true, text: "done" };
        },
        async responseWritten(receipt) {
          receipts.push(receipt);
        },
      },
      source: source(),
      write: (line) => { output.push(line); },
    });
    const responses = output.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(responses).toHaveLength(3);
    const listed = (responses[1]?.result as { tools: { name: string }[] }).tools;
    expect(listed.map((tool) => tool.name)).toEqual([...HRA_HOST_TOOL_NAMES]);
    expect(responses[2]).toMatchObject({
      id: 2,
      result: { content: [{ text: "done", type: "text" }], isError: false },
    });
    expect(observed).toHaveLength(1);
    expect(receipts).toHaveLength(1);
  });

  test("accepts a schema-maximum body with worst-case JSON escaping", async () => {
    const body = "\\".repeat(512 * 1_024);
    const frames = [
      {
        id: 0,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "claude-code", version: CLAUDE_PIN },
          protocolVersion: CLAUDE_PIN_MCP_PROTOCOL_VERSION,
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      {
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: { body, key: "boundary", summary: "s", title: "t" },
          name: "memory_remember",
        },
      },
    ];
    const encoded = new TextEncoder().encode(
      `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`,
    );
    expect(encoded.byteLength).toBeGreaterThan(1024 * 1_024);
    async function* source(): AsyncIterable<Uint8Array> { yield encoded; }
    const output: string[] = [];
    await runClaudeHostToolStdio({
      handler: {
        invoke: async (call) => {
          expect(call.request).toMatchObject({ input: { body }, tool: "memory_remember" });
          return { ok: true, text: "ok" };
        },
        responseWritten: async () => undefined,
      },
      source: source(),
      write: (line) => { output.push(line); },
    });
    expect(output.map((line) => JSON.parse(line) as unknown)).toHaveLength(2);
  });

  test("bounds completed callback history without losing old-call idempotency", async () => {
    const root = await scratch();
    const authority = deterministicAuthority();
    const lease = await authority.provision({
      callbackSocketPath: join(root, "callback.sock"),
      identity,
      privateRoot: root,
    });
    await authority.activate(lease.bindingId);
    const material = await readClaudeHostToolBinding(lease.bindingPath);
    const calls: string[] = [];
    const receipts: string[] = [];
    const handler: ClaudeHostToolCallbackHandler = {
      call: async (call) => { calls.push(call.callId); return "ok"; },
      responseWritten: async (receipt) => { receipts.push(receipt.callId); },
    };
    let firstCall: ClaudeHostToolCallbackRequest | undefined;
    let firstReceipt: ClaudeHostToolCallbackRequest | undefined;
    for (let index = 0; index < CLAUDE_HOST_TOOL_SESSION_HISTORY_LIMIT; index += 1) {
      const callId = `callback-${index}`;
      const request = { input: {}, tool: "sessions_list" } as const;
      const requestDigest = digestClaudeHostToolInvocation(callId, request);
      const call = {
        bindingId: material.bindingId,
        callId,
        capability: material.capability,
        input: request.input,
        kind: "call",
        requestDigest,
        tool: request.tool,
        version: CLAUDE_HOST_TOOL_CALLBACK_VERSION,
      } as const;
      const receipt = {
        bindingId: material.bindingId,
        callId,
        capability: material.capability,
        kind: "response_written",
        requestDigest,
        version: CLAUDE_HOST_TOOL_CALLBACK_VERSION,
      } as const;
      firstCall ??= call;
      firstReceipt ??= receipt;
      expect(await authority.handleCallback(call, handler)).toMatchObject({ ok: true });
      expect(await authority.handleCallback(receipt, handler)).toMatchObject({ ok: true });
    }
    expect(calls).toHaveLength(CLAUDE_HOST_TOOL_SESSION_HISTORY_LIMIT);
    expect(receipts).toHaveLength(CLAUDE_HOST_TOOL_SESSION_HISTORY_LIMIT);
    await expect(authority.handleCallback(firstCall!, handler)).rejects.toThrow("already completed");
    await expect(authority.handleCallback(firstReceipt!, handler)).resolves.toMatchObject({ ok: true });
    const exhaustedId = `callback-${String(CLAUDE_HOST_TOOL_SESSION_HISTORY_LIMIT)}`;
    const exhaustedRequest = { input: {}, tool: "sessions_list" } as const;
    await expect(authority.handleCallback({
      bindingId: material.bindingId,
      callId: exhaustedId,
      capability: material.capability,
      input: exhaustedRequest.input,
      kind: "call",
      requestDigest: digestClaudeHostToolInvocation(exhaustedId, exhaustedRequest),
      tool: exhaustedRequest.tool,
      version: CLAUDE_HOST_TOOL_CALLBACK_VERSION,
    }, handler)).rejects.toThrow("history is exhausted");
    expect(calls).toHaveLength(CLAUDE_HOST_TOOL_SESSION_HISTORY_LIMIT);
    expect(receipts).toHaveLength(CLAUDE_HOST_TOOL_SESSION_HISTORY_LIMIT);
    await authority.close();
  });

  test("fits an exact 64-KiB worst-escaped result inside the callback envelope", async () => {
    const root = await scratch();
    const authority = deterministicAuthority();
    const lease = await authority.provision({
      callbackSocketPath: join(root, "callback.sock"),
      identity,
      privateRoot: root,
    });
    await authority.activate(lease.bindingId);
    const material = await readClaudeHostToolBinding(lease.bindingPath);
    const text = String.fromCharCode(1).repeat(64 * 1_024);
    const client = new ClaudeHostToolSocketClient(material, async (_path, value, maximumBytes) => {
      const response = await authority.handleCallback(value, {
        call: async () => text,
        responseWritten: async () => undefined,
      });
      const wireBytes = new TextEncoder().encode(`${JSON.stringify(response)}\n`).byteLength;
      if (response.kind === "call_result") {
        expect(wireBytes).toBeGreaterThan(384 * 1_024);
      }
      expect(wireBytes).toBeLessThanOrEqual(maximumBytes);
      return response;
    });
    const invocation: ClaudeHostToolInvocation = {
      callId: "escaped-boundary",
      request: { input: {}, tool: "sessions_list" },
      requestDigest: digestClaudeHostToolInvocation(
        "escaped-boundary",
        { input: {}, tool: "sessions_list" },
      ),
    };
    await expect(client.invoke(invocation)).resolves.toEqual({ ok: true, text });
    await client.responseWritten(invocation);
    await authority.close();
  });

  test("refuses malformed callback frames without dispatching", async () => {
    const root = await scratch();
    const authority = deterministicAuthority();
    const lease = await authority.provision({
      callbackSocketPath: join(root, "callback.sock"),
      identity,
      privateRoot: root,
    });
    const material = await readClaudeHostToolBinding(lease.bindingPath);
    await authority.activate(lease.bindingId);
    const invalid: ClaudeHostToolCallbackRequest = {
      bindingId: material.bindingId,
      callId: "call-invalid",
      capability: material.capability,
      input: { unexpected: true },
      kind: "call",
      requestDigest: "0".repeat(64),
      tool: "sessions_list",
      version: CLAUDE_HOST_TOOL_CALLBACK_VERSION,
    };
    await expect(authority.handleCallback(invalid, noOpHandler())).rejects.toThrow(ClaudeError);
    await authority.close();
  });
});
