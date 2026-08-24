import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeStatePaths, resolveStatePaths } from "../storage/paths";
import {
  callLocalDaemon,
  callWithSafeAutostart,
  commandFailureBrand,
  LocalDaemonIndeterminateError,
  LocalDaemonServer,
  LocalDaemonShutdownTimeoutError,
  LocalDaemonUnavailableError,
} from "./local-transport";

const servers: LocalDaemonServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

async function fixture(deadlineMs = 200): Promise<{ paths: ReturnType<typeof resolveStatePaths>; server: LocalDaemonServer }> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hra-daemon-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const server = await LocalDaemonServer.start({
    paths,
    deadlineMs,
    handler: async (command) => ({ command: command.kind }),
  });
  servers.push(server);
  return { paths, server };
}

describe("local daemon transport", () => {
  test("accepts one authenticated bounded command", async () => {
    const { paths } = await fixture();
    expect(await callLocalDaemon({ paths, command: { kind: "daemon.status" } })).toEqual({
      ok: true,
      version: 1,
      requestId: expect.any(String),
      data: { command: "daemon.status" },
    });
    expect((await readFile(paths.capability, "utf8")).trim()).toHaveLength(43);
  });

  test("closes unexpected daemon failures without returning runtime diagnostics", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-daemon-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const secret = "OPAQUE_RUNTIME_SENTINEL_DO_NOT_RETURN";
    const server = await LocalDaemonServer.start({
      paths,
      handler: () => {
        throw Object.assign(
          new Error(`provider unavailable ${secret} at /private/runtime\u001b]52;c;attack\u0007`),
          { code: "UNAVAILABLE", details: { diagnostic: secret } },
        );
      },
    });
    servers.push(server);
    const response = await callLocalDaemon({ paths, command: { kind: "daemon.status" } });
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "INTERNAL",
        message: "The local request failed before a safe diagnostic was available.",
      },
    });
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(JSON.stringify(response)).not.toContain("/private/runtime");
    expect(JSON.stringify(response)).not.toContain("\u001b");
  });

  test("maps declared command failures to closed messages without echoing their diagnostic", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-daemon-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const secret = "DECLARED_FAILURE_SENTINEL_DO_NOT_RETURN";
    const server = await LocalDaemonServer.start({
      paths,
      handler: () => {
        throw Object.assign(new Error(`provider unavailable ${secret}`), {
          [commandFailureBrand]: true as const,
          code: "INTERACTION_REQUIRED" as const,
          details: {
            accountSelector: "acct_11111111111111111111111111111111",
            accountState: "signed_out",
            nextCommand: "hra account login acct_11111111111111111111111111111111",
          },
        });
      },
    });
    servers.push(server);
    const response = await callLocalDaemon({ paths, command: { kind: "daemon.status" } });
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "INTERACTION_REQUIRED",
        details: {
          accountSelector: "acct_11111111111111111111111111111111",
          accountState: "signed_out",
          nextCommand: "hra account login acct_11111111111111111111111111111111",
        },
        message: "The local command requires an explicit interaction.",
      },
    });
    expect(JSON.stringify(response)).not.toContain(secret);
  });

  test("uses an absolute client deadline", async () => {
    const { paths } = await fixture(5_000);
    const started = Date.now();
    await expect(callLocalDaemon({ paths, command: { kind: "daemon.status" }, deadlineMs: 20 })).resolves.toMatchObject({ ok: true });
    expect(Date.now() - started).toBeLessThan(200);
  });

  test("rejects an already-aborted client request before opening daemon dispatch", async () => {
    const { paths } = await fixture();
    const controller = new AbortController();
    const reason = new Error("cancelled before dispatch");
    controller.abort(reason);
    await expect(callLocalDaemon({
      paths,
      command: { kind: "daemon.status" },
      signal: controller.signal,
    })).rejects.toBe(reason);
  });

  test("destroys the client socket on abort so the daemon handler is canceled", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-daemon-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let resolveEntered!: () => void;
    const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
    let resolveHandlerAbort!: () => void;
    const handlerAborted = new Promise<void>((resolve) => { resolveHandlerAbort = resolve; });
    const server = await LocalDaemonServer.start({
      paths,
      handler: async (_command, context) => {
        resolveEntered();
        await new Promise<void>((resolve) => {
          const aborted = () => {
            resolveHandlerAbort();
            resolve();
          };
          if (context.signal.aborted) aborted();
          else context.signal.addEventListener("abort", aborted, { once: true });
        });
        return { canceled: true };
      },
    });
    servers.push(server);
    const controller = new AbortController();
    const call = callLocalDaemon({
      paths,
      command: { kind: "daemon.status" },
      deadlineMs: 5_000,
      signal: controller.signal,
    });
    await entered;
    controller.abort(new Error("stop following"));
    await expect(call).rejects.toBeInstanceOf(LocalDaemonIndeterminateError);
    await handlerAborted;
  });

  test("closes admission and removes endpoint authority", async () => {
    const { paths, server } = await fixture();
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    await expect(callLocalDaemon({ paths, command: { kind: "daemon.status" } })).rejects.toThrow();
  });

  test("runs shutdown callbacks only after the response flushes", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-daemon-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let acknowledged = false;
    const server = await LocalDaemonServer.start({ paths, handler: async (_command, context) => {
      context.afterResponse(() => { acknowledged = true; });
      return { stopping: true };
    } });
    servers.push(server);
    expect(await callLocalDaemon({ paths, command: { kind: "daemon.stop" } })).toMatchObject({ ok: true, data: { stopping: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(acknowledged).toBe(true);
  });

  test("runs response callbacks once after a disconnected response becomes impossible", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-daemon-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let releaseHandler!: () => void;
    let signalHandlerEntered!: () => void;
    let signalCallbackRan!: () => void;
    const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve; });
    const handlerEntered = new Promise<void>((resolve) => { signalHandlerEntered = resolve; });
    const callbackRan = new Promise<void>((resolve) => { signalCallbackRan = resolve; });
    let callbackCalls = 0;
    const server = await LocalDaemonServer.start({
      paths,
      handler: async (_command, context) => {
        context.afterResponse(() => {
          callbackCalls += 1;
          signalCallbackRan();
        });
        signalHandlerEntered();
        await handlerGate;
        return { stopping: true };
      },
    });
    servers.push(server);
    const controller = new AbortController();
    const call = callLocalDaemon({
      paths,
      command: { kind: "daemon.stop" },
      deadlineMs: 5_000,
      signal: controller.signal,
    });
    await handlerEntered;
    controller.abort(new Error("disconnect before the response"));
    await expect(call).rejects.toBeInstanceOf(LocalDaemonIndeterminateError);
    expect(callbackCalls).toBe(0);

    releaseHandler();
    await callbackRan;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(callbackCalls).toBe(1);
  });

  test("classifies an absent endpoint as unavailable before dispatch", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-daemon-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    await expect(callLocalDaemon({ paths, command: { kind: "daemon.status" }, deadlineMs: 20 })).rejects.toBeInstanceOf(LocalDaemonUnavailableError);
  });

  test("classifies reset after connect as indeterminate and never autostarts", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-daemon-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    await writeFile(paths.capability, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
    let observed = false;
    const raw = createServer((socket) => {
      socket.once("data", () => {
        observed = true;
        socket.destroy();
      });
    });
    await new Promise<void>((resolve, reject) => {
      raw.once("error", reject);
      raw.listen(paths.socket, resolve);
    });
    await chmod(paths.socket, 0o600);
    let starts = 0;
    try {
      await expect(callWithSafeAutostart(
        async () => await callLocalDaemon({ paths, command: { kind: "daemon.status" }, deadlineMs: 100 }),
        async () => { starts += 1; },
      )).rejects.toBeInstanceOf(LocalDaemonIndeterminateError);
      expect(observed).toBe(true);
      expect(starts).toBe(0);
    } finally {
      await new Promise<void>((resolve) => raw.close(() => resolve()));
      await Promise.all([unlink(paths.socket).catch(() => undefined), unlink(paths.capability).catch(() => undefined)]);
    }
  });

  test("staged shutdown aborts admission and returns at an absolute join deadline", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-daemon-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let resolveEntered!: () => void;
    const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
    const server = await LocalDaemonServer.start({
      paths,
      handler: async () => {
        resolveEntered();
        return await new Promise<never>(() => undefined);
      },
    });
    const call = callLocalDaemon({ paths, command: { kind: "daemon.status" }, deadlineMs: 1_000 }).catch((error: unknown) => error);
    await entered;
    const started = Date.now();
    await expect(server.close({ deadlineMs: 20 })).rejects.toBeInstanceOf(LocalDaemonShutdownTimeoutError);
    expect(Date.now() - started).toBeLessThan(250);
    expect(await call).toBeInstanceOf(LocalDaemonIndeterminateError);
  });
});
