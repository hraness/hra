import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

import { initializeStatePaths, resolveStatePaths } from "../storage/paths";
import {
  callLocalDaemon,
  callWithSafeAutostart,
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
  const home = await mkdtemp(join("/private/tmp", "hra-daemon-"));
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

  test("uses an absolute client deadline", async () => {
    const { paths } = await fixture(5_000);
    const started = Date.now();
    await expect(callLocalDaemon({ paths, command: { kind: "daemon.status" }, deadlineMs: 20 })).resolves.toMatchObject({ ok: true });
    expect(Date.now() - started).toBeLessThan(200);
  });

  test("closes admission and removes endpoint authority", async () => {
    const { paths, server } = await fixture();
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    await expect(callLocalDaemon({ paths, command: { kind: "daemon.status" } })).rejects.toThrow();
  });

  test("runs shutdown callbacks only after the response flushes", async () => {
    const home = await mkdtemp(join("/private/tmp", "hra-daemon-"));
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

  test("classifies an absent endpoint as unavailable before dispatch", async () => {
    const home = await mkdtemp(join("/private/tmp", "hra-daemon-"));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    await expect(callLocalDaemon({ paths, command: { kind: "daemon.status" }, deadlineMs: 20 })).rejects.toBeInstanceOf(LocalDaemonUnavailableError);
  });

  test("classifies reset after connect as indeterminate and never autostarts", async () => {
    const home = await mkdtemp(join("/private/tmp", "hra-daemon-"));
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
    const home = await mkdtemp(join("/private/tmp", "hra-daemon-"));
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
