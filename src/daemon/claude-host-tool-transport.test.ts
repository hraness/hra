import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";

import {
  ClaudeHostToolBindingAuthority,
  ClaudeHostToolSocketClient,
  digestClaudeHostToolInvocation,
  readClaudeHostToolBinding,
} from "../claude/index.ts";
import { initializeStatePaths, resolveStatePaths } from "../storage/paths.ts";
import {
  ClaudeHostToolCallbackServer,
  claudeHostToolCallbackSocketPath,
} from "./claude-host-tool-transport.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) =>
    await rm(root, { force: true, recursive: true })));
});

describe("Claude host-tool callback transport", () => {
  test("routes one authenticated frame and its exact response-written receipt", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-claude-callback-")));
    roots.push(home);
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    await chmod(paths.runtime, 0o700);
    const authority = new ClaudeHostToolBindingAuthority({
      bridgeArguments: ["/private/hra/host-tool-bridge-main.ts"],
      bridgeCommand: process.execPath,
      newBindingId: () => `clhb_${"1".repeat(32)}`,
      newCapability: () => "A".repeat(43),
    });
    const calls: string[] = [];
    const receipts: string[] = [];
    const server = await ClaudeHostToolCallbackServer.start({
      paths,
      authority,
      handler: {
        call: async (call) => {
          calls.push(call.callId);
          return { ok: true, callId: call.callId };
        },
        responseWritten: async (call) => { receipts.push(call.callId); },
      },
    });
    const lease = await authority.provision({
      privateRoot: paths.runtime,
      callbackSocketPath: server.path,
      identity: {
        provider: "claude",
        providerThreadId: "claude-thread",
        profileId: `acct_${"2".repeat(32)}`,
        processGeneration: 3,
      },
    });
    await authority.activate(lease.bindingId);
    const client = new ClaudeHostToolSocketClient(
      await readClaudeHostToolBinding(lease.bindingPath),
    );
    const call = {
      callId: "call-one",
      request: { tool: "sessions_list" as const, input: { limit: 2 } },
      requestDigest: "",
    };
    const invocation = {
      ...call,
      requestDigest: digestClaudeHostToolInvocation(call.callId, call.request),
    };
    await expect(client.invoke(invocation)).resolves.toMatchObject({
      ok: true,
      text: expect.stringContaining("call-one"),
    });
    expect(receipts).toEqual([]);
    await client.responseWritten(invocation);
    await client.responseWritten(invocation);
    expect(calls).toEqual(["call-one"]);
    expect(receipts).toEqual(["call-one"]);
    expect(server.path).toBe(claudeHostToolCallbackSocketPath(paths));
    await authority.close();
    await server.close();
  });

  test("closes malformed and unauthenticated frames without dispatching", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-claude-callback-")));
    roots.push(home);
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const authority = new ClaudeHostToolBindingAuthority();
    let calls = 0;
    const server = await ClaudeHostToolCallbackServer.start({
      paths,
      authority,
      handler: {
        call: async () => { calls += 1; return "unreachable"; },
        responseWritten: async () => undefined,
      },
    });
    // The first test proves the normal socket exchange. This negative case
    // uses a raw connection so malformed bytes cannot be normalized.
    const { createConnection } = await import("node:net");
    await new Promise<void>((resolveClosed, rejectClosed) => {
      const raw = createConnection({ path: server.path });
      const timer = setTimeout(() => rejectClosed(new Error("callback did not close")), 1_000);
      raw.once("connect", () => raw.write("{not-json}\n"));
      raw.once("close", () => { clearTimeout(timer); resolveClosed(); });
      raw.once("error", () => undefined);
    });
    expect(calls).toBe(0);
    await authority.close();
    await server.close();
  });

  test("owns a listener error for the full server lifetime and shuts down", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-claude-callback-")));
    roots.push(home);
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const authority = new ClaudeHostToolBindingAuthority();
    let rawServer: Server | undefined;
    const fatal: Error[] = [];
    const server = await ClaudeHostToolCallbackServer.start({
      paths,
      authority,
      handler: {
        call: async () => "unreachable",
        responseWritten: async () => undefined,
      },
      onFatalError: (error) => { fatal.push(error); },
      serverFactory: (accept) => {
        rawServer = createServer(accept);
        return rawServer;
      },
    });
    const injected = new Error("post-start listener failure");
    rawServer?.emit("error", injected);
    await Bun.sleep(0);
    expect(fatal).toEqual([injected]);
    await authority.close();
    await server.close();
  });
});
