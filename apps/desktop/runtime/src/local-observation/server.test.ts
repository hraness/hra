import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  localObservationRequestByteLimit,
  parseLocalObservationResponse,
  type LocalObservationResponse,
} from "@hraness/hra-local-observation-protocol/wire";

import { localObservationEndpointPaths } from "./endpoint";
import {
  startLocalObservationServer,
  startLocalObservationServerForTest,
  type LocalObservationServer,
} from "./server";

const roots: string[] = [];
const servers: LocalObservationServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function endpointRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hra-local-observation-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function paneSource() {
  return {
    id: "pane_abcdefgh",
    title: "New chat",
    repository: { name: "hra", privateUrl: "secret-provider-url" },
    interactionMode: "chat" as const,
    state: "ready" as const,
    workspace: { state: "ready" as const, recoveryKind: null },
    messageQueue: {
      pauseReason: null,
      blockedMessage: null,
      messages: [] as unknown[],
      privateText: "secret-queued-text",
    },
    schedule: null,
    canonicalPath: "/Users/person/private/hra",
    accountProfileId: "acct_private00",
  };
}

async function start(
  root: string,
  options: Readonly<{
    timeout?: number;
    maximumConnections?: number;
    randomByte?: number;
    attention?: (signal: AbortSignal) => unknown;
    panes?: () => ReturnType<typeof paneSource>[] | Promise<ReturnType<typeof paneSource>[]>;
  }> = {},
): Promise<LocalObservationServer> {
  const server = await startLocalObservationServerForTest({
    endpointRoot: root,
    captures: {
      attention: options.attention ?? (() => ({
        version: 1,
        completeness: "complete",
        items: [],
      })),
      panes: options.panes ?? (() => [paneSource()]),
    },
    ...(options.timeout === undefined
      ? {}
      : { requestTimeoutMilliseconds: options.timeout }),
    ...(options.maximumConnections === undefined
      ? {}
      : { maximumConnections: options.maximumConnections }),
    ...(options.randomByte === undefined
      ? {}
      : { randomBytes: () => new Uint8Array(32).fill(options.randomByte!) }),
  });
  servers.push(server);
  return server;
}

function request(capability: string, operation: "attention.list" | "panes.list") {
  return JSON.stringify({ version: 1, capability, operation });
}

function exchange(socketPath: string, payload: string): Promise<LocalObservationResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    const chunks: Buffer[] = [];
    socket.once("connect", () => socket.write(`${payload}\n`));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("end", () => {
      try {
        resolve(parseLocalObservationResponse(
          JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        ));
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error("Invalid test response."));
      }
    });
  });
}

function openSilent(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath, allowHalfOpen: true });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

describe("local observation AF_UNIX server", () => {
  test("creates fresh owner-private material and returns minimized panes", async () => {
    const root = endpointRoot();
    await start(root, { randomByte: 7 });
    const paths = localObservationEndpointPaths(root);
    const capability = readFileSync(paths.capability, "utf8");
    expect(capability).toHaveLength(43);
    expect(lstatSync(paths.directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(paths.capability).mode & 0o777).toBe(0o600);
    expect(lstatSync(paths.capability).nlink).toBe(1);
    expect(lstatSync(paths.socket).mode & 0o777).toBe(0o600);
    expect(lstatSync(paths.socket).isSocket()).toBe(true);

    const response = await exchange(paths.socket, request(capability, "panes.list"));
    expect(response.ok).toBe(true);
    const serialized = JSON.stringify(response);
    for (const sentinel of [
      "secret-provider-url",
      "secret-queued-text",
      "/Users/person/private/hra",
      "acct_private00",
    ]) expect(serialized).not.toContain(sentinel);
  });

  test("captures fresh state for each authorized request", async () => {
    const root = endpointRoot();
    let captures = 0;
    await start(root, {
      panes: () => {
        captures += 1;
        return [{ ...paneSource(), title: `Capture ${captures}` }];
      },
    });
    const paths = localObservationEndpointPaths(root);
    const capability = readFileSync(paths.capability, "utf8");
    const first = await exchange(paths.socket, request(capability, "panes.list"));
    const second = await exchange(paths.socket, request(capability, "panes.list"));
    expect(first.ok && first.result.type === "panes"
      ? first.result.projection.panes[0]?.title
      : null).toBe("Capture 1");
    expect(second.ok && second.result.type === "panes"
      ? second.result.projection.panes[0]?.title
      : null).toBe("Capture 2");
  });

  test("rejects wrong and stale generation capabilities", async () => {
    const root = endpointRoot();
    const first = await start(root, { randomByte: 1 });
    const paths = localObservationEndpointPaths(root);
    const stale = readFileSync(paths.capability, "utf8");
    expect((await exchange(paths.socket, request("A".repeat(43), "panes.list"))).ok)
      .toBe(false);
    await first.close();
    servers.splice(servers.indexOf(first), 1);

    await start(root, { randomByte: 2 });
    expect(readFileSync(paths.capability, "utf8")).not.toBe(stale);
    const response = await exchange(paths.socket, request(stale, "panes.list"));
    expect(response).toEqual({
      version: 1,
      ok: false,
      error: { code: "unauthorized" },
    });
  });

  test("closes malformed, multiple, and oversized request frames", async () => {
    const root = endpointRoot();
    await start(root);
    const paths = localObservationEndpointPaths(root);
    const capability = readFileSync(paths.capability, "utf8");
    for (const payload of [
      "not-json",
      `${request(capability, "panes.list")}${request(capability, "panes.list")}`,
      "x".repeat(localObservationRequestByteLimit + 1),
    ]) {
      const response = await exchange(paths.socket, payload);
      expect(response).toEqual({
        version: 1,
        ok: false,
        error: { code: "invalid_request" },
      });
    }
  });

  test("bounds silent clients and concurrent connections", async () => {
    const root = endpointRoot();
    await start(root, { timeout: 30, maximumConnections: 1 });
    const paths = localObservationEndpointPaths(root);
    const first = await openSilent(paths.socket);
    const capability = readFileSync(paths.capability, "utf8");
    const overflow = await exchange(paths.socket, request(capability, "panes.list"));
    expect(overflow).toEqual({
      version: 1,
      ok: false,
      error: { code: "runtime_unavailable" },
    });
    const timedOut = await new Promise<LocalObservationResponse>((resolve, reject) => {
      const chunks: Buffer[] = [];
      first.on("data", (chunk: Buffer) => chunks.push(chunk));
      first.once("error", reject);
      first.once("end", () => {
        resolve(parseLocalObservationResponse(
          JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        ));
      });
    });
    expect(timedOut).toEqual({
      version: 1,
      ok: false,
      error: { code: "invalid_request" },
    });
  });

  test("uses one absolute deadline even while an unauthenticated peer trickles bytes", async () => {
    const root = endpointRoot();
    await start(root, { timeout: 25 });
    const paths = localObservationEndpointPaths(root);
    const socket = await openSilent(paths.socket);
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    const ended = new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("end", resolve);
    });
    const trickle = setInterval(() => {
      if (!socket.destroyed) socket.write("{");
    }, 5);
    const outcome = await Promise.race([
      ended.then(() => "ended" as const),
      new Promise<"late">((resolve) => setTimeout(() => resolve("late"), 200)),
    ]);
    clearInterval(trickle);
    if (outcome === "late") socket.destroy();

    expect(outcome).toBe("ended");
    expect(parseLocalObservationResponse(
      JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
    )).toEqual({
      version: 1,
      ok: false,
      error: { code: "invalid_request" },
    });
  });

  test("aborts an authorized capture at the request deadline", async () => {
    const root = endpointRoot();
    let markAborted!: () => void;
    const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
    await start(root, {
      timeout: 20,
      attention: async (signal) => await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          markAborted();
          reject(new Error("request capture aborted"));
        }, { once: true });
      }),
    });
    const paths = localObservationEndpointPaths(root);
    const capability = readFileSync(paths.capability, "utf8");

    expect(await exchange(
      paths.socket,
      request(capability, "attention.list"),
    )).toEqual({
      version: 1,
      ok: false,
      error: { code: "observation_unavailable" },
    });
    await aborted;
  });

  test("aborts an authorized capture when its client disconnects", async () => {
    const root = endpointRoot();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let markAborted!: () => void;
    const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
    await start(root, {
      attention: async (signal) => {
        markStarted();
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            markAborted();
            reject(new Error("disconnected capture aborted"));
          }, { once: true });
        });
      },
    });
    const paths = localObservationEndpointPaths(root);
    const capability = readFileSync(paths.capability, "utf8");
    const socket = await openSilent(paths.socket);
    socket.write(`${request(capability, "attention.list")}\n`);
    await started;
    socket.destroy();
    await aborted;
  });

  test("disables automation and recovery profiles before filesystem access", async () => {
    for (const profile of ["automation", "recovery"] as const) {
      expect(await startLocalObservationServer({
        endpointRoot: "/path/that/must/not/be/touched",
        profile,
        captures: {
          attention: () => { throw new Error("must not capture"); },
          panes: () => { throw new Error("must not capture"); },
        },
      })).toBeNull();
    }
  });

  test("removes only its exact endpoint generation on close", async () => {
    const root = endpointRoot();
    const server = await start(root);
    const paths = localObservationEndpointPaths(root);
    expect(existsSync(paths.socket)).toBe(true);
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    expect(existsSync(paths.socket)).toBe(false);
    expect(existsSync(paths.capability)).toBe(false);
    expect(existsSync(paths.directory)).toBe(false);
    mkdirSync(paths.directory, { mode: 0o700 });
  });

  test("aborts and joins an authorized capture before endpoint cleanup", async () => {
    const root = endpointRoot();
    let captureSignal: AbortSignal | undefined;
    let markCaptureStarted!: () => void;
    const captureStarted = new Promise<void>((resolve) => {
      markCaptureStarted = resolve;
    });
    let releaseCapture!: () => void;
    const captureReleased = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const server = await start(root, {
      attention: async (signal) => {
        captureSignal = signal;
        markCaptureStarted();
        await captureReleased;
        return { version: 1, completeness: "complete", items: [] };
      },
    });
    const paths = localObservationEndpointPaths(root);
    const capability = readFileSync(paths.capability, "utf8");
    const response = exchange(
      paths.socket,
      request(capability, "attention.list"),
    ).catch(() => null);
    await captureStarted;

    let closed = false;
    const closing = server.close().then(() => { closed = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(captureSignal?.aborted).toBe(true);
    expect(closed).toBe(false);
    expect(existsSync(paths.capability)).toBe(true);

    releaseCapture();
    await closing;
    servers.splice(servers.indexOf(server), 1);
    await response;
    expect(existsSync(paths.capability)).toBe(false);
    expect(existsSync(paths.directory)).toBe(false);
  });
});
