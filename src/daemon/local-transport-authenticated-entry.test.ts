import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commandResponseSchema, LOCAL_COMMAND_REQUEST_VERSION } from "../domain/contracts";
import { initializeStatePaths, resolveStatePaths } from "../storage/paths";
import { StateStore } from "../storage/state-store";
import { LocalDaemonServer } from "./local-transport";
import type { ClaudeRuntimePort, CloudControlPort, CodexRuntimePort, DevinRuntimePort } from "./ports";
import { HraService } from "./service";

const rawRequest = async (socketPath: string, envelope: unknown) => await new Promise<unknown>((resolve, reject) => {
  const socket = createConnection(socketPath);
  const chunks: Buffer[] = [];
  let settled = false;
  let size = 0;
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    if (error !== undefined) reject(error);
    else {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (caught: unknown) { reject(caught); }
    }
  };
  const timer = setTimeout(() => finish(new Error("The fixture response deadline expired.")), 2_000);
  socket.once("connect", () => socket.write(`${JSON.stringify(envelope)}\n`));
  socket.on("data", (data: Buffer) => {
    size += data.byteLength;
    if (size > 16_384) finish(new Error("The fixture response exceeded its bound."));
    else chunks.push(data);
  });
  socket.once("end", () => finish());
  socket.once("error", (error) => finish(error));
  socket.once("close", () => { if (!settled) finish(new Error("The fixture socket closed without a response.")); });
});

test("only an authenticated local frame can invoke the retained service composition entry", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hra-local-composition-")));
  const paths = resolveStatePaths({ homeDirectory: root, platform: "darwin" });
  let store: StateStore | undefined;
  let composition: ReturnType<typeof HraService.createLocalComposition> | undefined;
  const closed: string[] = [];
  const forbidden: string[] = [];
  const port = (name: string): unknown => new Proxy({}, {
    get: (_target, property) => {
      if (property === "close") return async () => { closed.push(name); };
      if (name === "devin" && property === "closeCustody") return undefined;
      forbidden.push(`${name}.${String(property)}`);
      throw new Error("A transport-only fixture accessed a provider operation.");
    },
  });
  let server: LocalDaemonServer | undefined;
  try {
    await initializeStatePaths(paths);
    store = new StateStore(paths, { resolveMachineTimeZone: () => "UTC" });
    const activeComposition = HraService.createLocalComposition({ store, paths,
      codex: port("codex") as CodexRuntimePort, claude: port("claude") as ClaudeRuntimePort,
      devin: port("devin") as DevinRuntimePort, cloud: port("cloud") as CloudControlPort,
      daemonAuthority: { assertCurrent: async () => undefined, close: () => undefined }, requestStop: () => undefined });
    composition = activeComposition;
    let handlerCalls = 0;
    let flushed = 0;
    let genericCalls = 0;
    activeComposition.service.execute = async () => { genericCalls += 1; throw new Error("The generic entry was intercepted."); };
    server = await LocalDaemonServer.start({ paths, handler: async (command, context) => {
      handlerCalls += 1;
      context.afterResponse(() => { flushed += 1; });
      return await activeComposition.executeAuthenticatedLocal(command, {
        signal: context.signal, afterResponse: (callback) => context.afterResponse(callback),
      });
    } });
    const capability = (await readFile(paths.capability, "utf8")).trim();
    const command = { kind: "account.list", provider: "claude" };
    const requestId = randomUUID();
    const base = { version: LOCAL_COMMAND_REQUEST_VERSION, requestId, command };
    const wrong = `${capability.startsWith("a") ? "b" : "a"}${capability.slice(1)}`;
    for (const envelope of [base, { ...base, capability: null }, { ...base, capability: "x" },
      { ...base, capability: wrong },
      { ...base, capability, command: { ...command, origin: "direct_local" } },
      { ...base, capability, actor: "human" }]) {
      const result = commandResponseSchema.parse(await rawRequest(paths.socket, envelope));
      expect(result.ok).toBe(false);
      expect(handlerCalls).toBe(0);
      expect(genericCalls).toBe(0);
      expect(flushed).toBe(0);
      expect(forbidden).toEqual([]);
    }
    const result = commandResponseSchema.parse(await rawRequest(paths.socket, { ...base, capability }));
    expect(result).toEqual({ ok: true, version: 1, requestId, data: {
      version: 1, provider: "claude", orderRevision: 1, pointerRevision: 1,
      activeProviderAccountId: null, accounts: [],
    } });
    expect(handlerCalls).toBe(1);
    expect(genericCalls).toBe(0);
    expect(flushed).toBe(1);
    expect(forbidden).toEqual([]);
    expect("executeAuthenticatedLocal" in activeComposition.service).toBe(false);
  } finally {
    try { await server?.close(); }
    finally {
      try { await composition?.service.close(); }
      finally { store?.close(); await rm(root, { recursive: true, force: true }); }
    }
  }
  expect(closed.toSorted()).toEqual(["claude", "codex", "devin"]);
  expect(forbidden).toEqual([]);
});

test("CLI retains the composition entry only in the authenticated handler after exact daemon-stop admission", async () => {
  const source = await readFile(new URL("../cli.ts", import.meta.url), "utf8");
  expect(source).toContain("const { service: activeService, executeAuthenticatedLocal } = HraService.createLocalComposition({");
  expect([...source.matchAll(/\bexecuteAuthenticatedLocal\b/gu)]).toHaveLength(2);
  const start = source.indexOf("server = await LocalDaemonServer.start({");
  const end = source.indexOf("    checkpointBoot();", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const handler = source.slice(start, end);
  const fence = handler.indexOf("await daemonLock.assertCurrent()");
  const stop = handler.indexOf("admitExactDaemonStop({");
  const dispatch = handler.indexOf("await executeAuthenticatedLocal(command,");
  for (const index of [fence, stop, dispatch]) expect(index).toBeGreaterThanOrEqual(0);
  expect(fence).toBeLessThan(stop);
  expect(stop).toBeLessThan(dispatch);
  expect(handler).toMatch(/if \(command\.kind === "daemon\.stop"\) \{\s*return admitExactDaemonStop\(\{/u);
  expect(handler).toContain("signal: context.signal, afterResponse: (callback) => context.afterResponse(callback)");
  expect(handler).toContain('if (command.kind !== "daemon.status") return data;');
  expect(source).toMatch(/executeLocal: async \(command, options\) => \{[^]*?return await current\.execute\(command, \{ signal: options\.signal \}\);/u);
  expect(source).toMatch(/poll: async \(accountId, signal\) => \{\s*await activeService\.execute\(/u);
  expect(source).toContain("serviceReference.current = activeService;");
  expect(source).toContain("const recovery = activeService.recover();");
  expect(source).toContain("serviceShutdown ??= service.close();");
});
