import { describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  admitExactDaemonStop,
  daemonRunProcessArguments,
  daemonRunProcessOptions,
  HUMAN_SESSION_WATCH_BOOTSTRAP_MAXIMUM_BYTES,
  initialize,
  main,
  protectedTerminalControlLibrariesForPlatform,
  protectedTerminalInputQueueForPlatform,
  readHiddenProtectedLineFromTerminal,
  renderRemoteSuccess,
  resolveDaemonCloudStartup,
  resolveSessionEventCursorCodec,
  selectDaemonCloudControl,
  stopDaemonWithExactAuthority,
  withProtectedTerminalLifecycle,
  type DaemonStopDependencies,
} from "./cli";
import { ShellTerminalCoordinator } from "./cli/shell-terminal";
import {
  CloudDaemonJournalRecoveryBlocker,
  CustodyCloudDaemonJournal,
  MemoryCloudDaemonJournal,
  type CloudProjectionRecoveryJournalEntry,
} from "./cloud/daemon-journal";
import {
  cloudDeploymentAuthorityFromEnvironment,
  DeploymentScopedCloudSecretCustody,
  IdentityScopedCloudSecretCustody,
} from "./cloud/identity-custody";
import type { CloudSecretCustodyPort } from "./cloud/local-control";
import type { CommandResponse, LocalCommand } from "./domain/contracts";
import {
  PROTECTED_INTERACTION_TERMINAL_MAXIMUM_BYTES,
  type ProtectedInteractionDetailDocument,
} from "./domain/interactions";
import type { RootStatus } from "./domain/observation";
import { renderProtectedInteractionDetail } from "./cli/render";
import {
  DAEMON_PROTOCOL,
  DaemonAuthoritySafetyError,
  DaemonLock,
  daemonAuthorityDatabasePath,
  readDaemonAuthorityReceipt,
  type DaemonAuthorityReceipt,
} from "./daemon/daemon-lock";
import {
  LocalDaemonIndeterminateError,
  LocalDaemonUnavailableError,
} from "./daemon/local-transport";
import { createAcceptanceInstallation } from "../scripts/live-acceptance-installation";
import { initializeStatePaths, resolveStatePaths } from "./storage/paths";
import { FileSecretBackend, GenerationalSecretCustody } from "./storage/secret-custody";
import { StateStore } from "./storage/state-store";

const capture = () => {
  let stdout = "";
  let stderr = "";
  return {
    output: { writeStdout: (value: string) => { stdout += value; }, writeStderr: (value: string) => { stderr += value; } },
    read: () => ({ stdout, stderr }),
  };
};

const cursorWireSignature = "A".repeat(43);
const cursorWire = (label: string): string =>
  `hra1.${Buffer.from(`fixture:${label}`).toString("base64url")}.${cursorWireSignature}`;

const emptyRootStatus = (): RootStatus => ({
  version: 1,
  scope: "local_only",
  localObservation: {
    source: "sqlite",
    coverage: "complete",
    freshness: "fresh",
    observedAt: 1,
    tables: [
      "profiles",
      "sessions",
      "provider_interactions",
      "queue_entries",
      "usage_snapshots",
      "usage_poll_failures",
    ],
  },
  providerObservation: {
    source: "codex_app_server",
    coverage: "not_attempted",
    freshness: "unknown",
    observedAt: null,
  },
  cloudObservation: {
    source: "convex",
    coverage: "not_attempted",
    freshness: "unknown",
    observedAt: null,
    devices: { registered: null, online: null },
  },
  counts: {
    accounts: { signedOut: 0, loginPending: 0, signedIn: 0, recoveryRequired: 0 },
    sessions: { starting: 0, active: 0, idle: 0, terminal: 0, recoveryRequired: 0 },
    interactions: {
      pending: 0,
      responsePrepared: 0,
      responseWritten: 0,
      resolved: 0,
      declined: 0,
      canceled: 0,
      expired: 0,
      resolutionUnknown: 0,
    },
    queue: { pending: 0, dispatching: 0, applied: 0, failed: 0, ambiguous: 0, cancelled: 0 },
    usage: { observed: 0, failed: 0, missing: 0 },
  },
  attention: { records: [], total: 0, truncated: false },
});

const rawTerminalInput = (): PassThrough & {
  isRaw: boolean;
  isTTY: true;
  rawModes: boolean[];
  setRawMode(mode: boolean): PassThrough;
} => {
  const input = new PassThrough() as PassThrough & {
    isRaw: boolean;
    isTTY: true;
    rawModes: boolean[];
    setRawMode(mode: boolean): PassThrough;
  };
  input.isTTY = true;
  input.isRaw = false;
  input.rawModes = [];
  input.setRawMode = (mode: boolean) => {
    input.rawModes.push(mode);
    input.isRaw = mode;
    return input;
  };
  return input;
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for CLI test state.");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
};

const resumePhraseFrom = (stderr: string): string => {
  const match = /Type (RESUME-[A-F0-9]{6})/u.exec(stderr);
  if (match?.[1] === undefined) throw new Error("Protected-input resume phrase was not rendered.");
  return match[1];
};

const beginPhraseFrom = (stderr: string): string => {
  const match = /Type (BEGIN-[A-F0-9]{6})/u.exec(stderr);
  if (match?.[1] === undefined) throw new Error("Protected-input begin phrase was not rendered.");
  return match[1];
};

class MemoryCloudCustody implements CloudSecretCustodyPort {
  readonly values = new Map<string, Readonly<{ generation: number; value: string }>>();

  read(slot: string): Promise<Readonly<{ generation: number; value: string }> | null> {
    return Promise.resolve(this.values.get(slot) ?? null);
  }

  compareAndSwap(
    slot: string,
    expectedGeneration: number | null,
    value: string,
  ): Promise<Readonly<{ generation: number; value: string }> | null> {
    const current = this.values.get(slot) ?? null;
    if ((current?.generation ?? null) !== expectedGeneration) return Promise.resolve(null);
    const committed = { generation: (current?.generation ?? -1) + 1, value };
    this.values.set(slot, committed);
    return Promise.resolve(committed);
  }

  clearIfGeneration(slot: string, expectedGeneration: number): Promise<boolean> {
    if (this.values.get(slot)?.generation !== expectedGeneration) return Promise.resolve(false);
    return Promise.resolve(this.values.delete(slot));
  }
}

const runningDaemonResponse = () => ({
  ok: true as const,
  version: 1 as const,
  requestId: crypto.randomUUID(),
  data: {
    running: true as const,
    daemon: {
      protocol: DAEMON_PROTOCOL,
      pid: 123,
      nonce: "018bcfe5-6800-7000-8000-000000000700",
      generation: 1,
      bootId: `boot_${"a".repeat(32)}`,
    },
  },
});

const readyDaemonStatus = () => {
  const daemon = runningDaemonResponse().data.daemon;
  return { running: true as const, pid: daemon.pid, daemon };
};

const stopDaemonIdentity = runningDaemonResponse().data.daemon;

const daemonAuthorityReceipt = (
  state: DaemonAuthorityReceipt["state"],
  identity = stopDaemonIdentity,
): DaemonAuthorityReceipt => ({
  version: 2,
  protocol: DAEMON_PROTOCOL,
  pid: identity.pid,
  nonce: identity.nonce,
  state,
  acquiredAt: 1,
  updatedAt: 2,
  generation: identity.generation,
  bootId: identity.bootId,
  ...(state === "failed" ? { failure: "bounded shutdown failure" } : {}),
});

const acknowledgedDaemonStopResponse = (): CommandResponse => ({
  ok: true,
  version: 1,
  requestId: crypto.randomUUID(),
  data: {
    stopping: true,
    running: true,
    daemon: stopDaemonIdentity,
  },
});

const exactStopDependencies = (
  overrides: Partial<DaemonStopDependencies> = {},
): DaemonStopDependencies => ({
  requestStop: () => Promise.resolve(acknowledgedDaemonStopResponse()),
  observeReceipt: () => Promise.resolve(daemonAuthorityReceipt("ready")),
  waitForRelease: () => Promise.resolve({
    replacement: null,
    finalReceipt: daemonAuthorityReceipt("stopped"),
  }),
  inspectAuthority: () => Promise.resolve({
    state: "held",
    database: { authority: "held", custody: "safe" },
    receipt: { custody: "safe", state: "ready" },
  }),
  authorityHeld: () => Promise.resolve(false),
  sleep: () => Promise.resolve(),
  ...overrides,
});

describe("CLI entry point", () => {
  test("reads root status locally without daemon autostart or transport", async () => {
    const captured = capture();
    let daemonCalls = 0;
    let daemonStarts = 0;
    let localReads = 0;
    expect(await main(["status", "--json"], captured.output, {
      callDaemon: async () => {
        daemonCalls += 1;
        throw new Error("root status must not call the daemon");
      },
      startDaemon: async () => {
        daemonStarts += 1;
        return readyDaemonStatus();
      },
      readRootStatus: () => {
        localReads += 1;
        return emptyRootStatus();
      },
    })).toBe(0);
    expect({ daemonCalls, daemonStarts, localReads }).toEqual({
      daemonCalls: 0,
      daemonStarts: 0,
      localReads: 1,
    });
    expect(JSON.parse(captured.read().stdout)).toMatchObject({
      ok: true,
      version: 1,
      command: "status",
      data: {
        scope: "local_only",
        providerObservation: { coverage: "not_attempted" },
        cloudObservation: { coverage: "not_attempted" },
      },
    });
    expect(captured.read().stderr).toBe("");
  });

  test("diagnoses corrupt local status state without describing daemon startup", async () => {
    const runId = "018f1f55-3f10-7c1a-8f7b-c6dc608bcd4d";
    const runRoot = await realpath(await mkdtemp(join(tmpdir(), `hra-live-acceptance-${runId}-`)));
    const installation = createAcceptanceInstallation({
      device: "a",
      documentsDirectory: join(runRoot, "project-a-corrupt"),
      expectedHomeDirectory: process.env.HOME ?? "/missing-home",
      rootDirectory: join(runRoot, "device-a-corrupt"),
      runId,
      type: "hra-live-acceptance-device",
      version: 1,
    });
    try {
      await initializeStatePaths(installation.paths);
      await writeFile(installation.paths.database, "not a sqlite database", { mode: 0o600 });
      const captured = capture();
      expect(await main(["status", "--json"], captured.output, {
        installation,
        startDaemon: () => { throw new Error("Local status must not start the daemon."); },
        callDaemon: () => { throw new Error("Local status must not call the daemon."); },
      })).toBe(7);
      const rendered = JSON.parse(captured.read().stdout) as {
        error: { message: string };
      };
      expect(rendered.error.message).toContain("before reading local status");
      expect(rendered.error.message).not.toContain("starting the daemon");
      expect(captured.read().stderr).toBe("");
    } finally {
      await rm(runRoot, { force: true, recursive: true });
    }
  });

  test("human watch seeds current interaction revisions and treats closed stdout as completion", async () => {
    const sessionId = `sess_${"2".repeat(32)}`;
    const accountId = `acct_${"1".repeat(32)}`;
    const interactionId = "10300000-0000-4000-8000-000000000001";
    const pendingInteractionId = "10300000-0000-4000-8000-000000000003";
    const streamEpoch = "10300000-0000-4000-8000-000000000002";
    const turnId = `opaque_v2_${"c".repeat(64)}`;
    const itemId = `opaque_v2_${"d".repeat(64)}`;
    const calls: LocalCommand[] = [];
    let stdout = "";
    let stderr = "";
    let stdoutWrites = 0;
    const exitCode = await main([
      "session",
      "watch",
      "current",
      "--cursor",
      cursorWire("status-cursor"),
    ], {
      writeStdout: (value) => {
        stdout += value;
        stdoutWrites += 1;
        if (stdoutWrites > 1) {
          throw Object.assign(new Error("stdout closed"), { code: "EPIPE" });
        }
      },
      writeStderr: (value) => { stderr += value; },
    }, {
      callDaemon: (command) => {
        calls.push(command);
        if (command.kind === "session.interactions") {
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: {
              sessionId,
              interactions: [
                {
                  id: interactionId,
                  sessionId,
                  kind: "command_approval",
                  state: "response_prepared",
                  revision: 2,
                  blocking: true,
                  display: { summary: "Prepared response" },
                },
                {
                  id: pendingInteractionId,
                  sessionId,
                  kind: "user_input",
                  state: "pending",
                  revision: 4,
                  blocking: true,
                  display: { summary: "Choose a release channel" },
                },
              ],
              nextCursor: null,
            },
          });
        }
        if (command.kind !== "session.events") {
          throw new Error(`Unexpected watch command: ${command.kind}`);
        }
        const base = {
          version: 1 as const,
          sessionId,
          streamEpoch,
          recordedAt: 1_700_000_000_000,
          accountId,
          providerGeneration: 1,
          providerConnectionId: null,
        };
        return Promise.resolve({
          ok: true,
          version: 1,
          requestId: crypto.randomUUID(),
          data: {
            version: 1,
            sessionId,
            requestedCursor: cursorWire("status-cursor"),
            retentionFloorCursor: cursorWire("floor"),
            observedThroughCursor: cursorWire("next-cursor"),
            nextCursor: cursorWire("next-cursor"),
            gap: null,
            events: [
              {
                ...base,
                sequence: 1,
                body: {
                  type: "interaction_requested" as const,
                  interactionId,
                  interactionKind: "command_approval" as const,
                  revision: 1,
                  blocking: true,
                  summary: "Stale request",
                },
              },
              {
                ...base,
                sequence: 2,
                body: {
                  type: "item_started" as const,
                  turnId,
                  itemId,
                  itemKind: "assistant" as const,
                },
              },
              {
                ...base,
                sequence: 3,
                body: {
                  type: "assistant_delta" as const,
                  turnId,
                  itemId,
                  text: "partial output",
                },
              },
            ],
          },
        });
      },
    });

    expect(exitCode).toBe(0);
    expect(calls.map((command) => command.kind)).toEqual([
      "session.interactions",
      "session.events",
    ]);
    expect(calls[1]).toMatchObject({
      session: sessionId,
      cursor: cursorWire("status-cursor"),
    });
    expect(stdout).toContain(`Interaction in progress: command approval ${interactionId}`);
    expect(stdout).not.toContain(`Interaction required: command approval ${interactionId}`);
    expect(stdout).toContain(`Show: hra interaction show ${pendingInteractionId}`);
    expect(stdout).toContain("does not carry complete decision authority");
    expect(stdout).not.toContain(
      `hra interaction answer ${pendingInteractionId} --revision 4 --input-stdin`,
    );
    expect(stdout).not.toMatch(/\n\s*\//u);
    expect(stdout).toContain("Trailing live delta text omitted");
    expect(stderr).toBe("");
  });

  test("human watch removes signal listeners before a final output failure escapes", async () => {
    const sessionId = `sess_${"4".repeat(32)}`;
    const accountId = `acct_${"5".repeat(32)}`;
    const interactionId = "10400000-0000-4000-8000-000000000001";
    const streamEpoch = "10400000-0000-4000-8000-000000000002";
    const turnId = `opaque_v2_${"e".repeat(64)}`;
    const itemId = `opaque_v2_${"f".repeat(64)}`;
    const listenerCounts = {
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
    };
    let eventReads = 0;
    let stdoutWrites = 0;
    let stderr = "";
    const exitCode = await main([
      "session",
      "watch",
      sessionId,
      "--cursor",
      cursorWire("status-cursor"),
    ], {
      writeStdout: () => { throw new Error("Human watch must use the async output boundary."); },
      writeStdoutAsync: (value) => {
        stdoutWrites += 1;
        if (stdoutWrites <= 2 && (stdoutWrites > 1 || value.includes("Interaction in progress"))) {
          return Promise.resolve();
        }
        return Promise.reject(new Error("final output failed"));
      },
      writeStderr: (value) => { stderr += value; },
    }, {
      callDaemon: (command) => {
        if (command.kind === "session.interactions") {
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: {
              sessionId,
              interactions: [{
                id: interactionId,
                sessionId,
                kind: "command_approval",
                state: "response_prepared",
                revision: 2,
                blocking: true,
                display: { summary: "Prepared response" },
              }],
              nextCursor: null,
            },
          });
        }
        if (command.kind !== "session.events") throw new Error("Expected session events.");
        eventReads += 1;
        if (eventReads > 1) {
          return Promise.resolve({
            ok: false,
            version: 1,
            requestId: crypto.randomUUID(),
            error: { code: "INVALID_INPUT", message: "Stop the fixture." },
          });
        }
        const base = {
          version: 1 as const,
          sessionId,
          streamEpoch,
          recordedAt: 1_700_000_000_000,
          accountId,
          providerGeneration: 1,
          providerConnectionId: null,
        };
        return Promise.resolve({
          ok: true,
          version: 1,
          requestId: crypto.randomUUID(),
          data: {
            version: 1,
            sessionId,
            requestedCursor: command.cursor ?? null,
            retentionFloorCursor: cursorWire("floor"),
            observedThroughCursor: cursorWire("next-cursor"),
            nextCursor: cursorWire("next-cursor"),
            gap: null,
            events: [
              {
                ...base,
                sequence: 1,
                body: {
                  type: "item_started" as const,
                  turnId,
                  itemId,
                  itemKind: "assistant" as const,
                },
              },
              {
                ...base,
                sequence: 2,
                body: {
                  type: "assistant_delta" as const,
                  turnId,
                  itemId,
                  text: "api_key=",
                },
              },
            ],
          },
        });
      },
    });

    expect(exitCode).not.toBe(0);
    expect(stdoutWrites).toBe(3);
    expect(stderr).not.toBe("");
    expect(process.listenerCount("SIGINT")).toBe(listenerCounts.sigint);
    expect(process.listenerCount("SIGTERM")).toBe(listenerCounts.sigterm);
  });

  test("human watch withholds partial interaction guidance when bootstrap fails", async () => {
    const sessionId = `sess_${"6".repeat(32)}`;
    const interactionId = "10500000-0000-4000-8000-000000000001";
    let stdout = "";
    let stderr = "";
    let interactionPages = 0;
    let eventCalls = 0;
    const exitCode = await main([
      "session",
      "watch",
      sessionId,
      "--cursor",
      cursorWire("status-cursor"),
    ], {
      writeStdout: (value) => { stdout += value; },
      writeStderr: (value) => { stderr += value; },
    }, {
      callDaemon: (command) => {
        if (command.kind === "session.events") {
          eventCalls += 1;
          throw new Error("Event follow must not begin after an incomplete bootstrap.");
        }
        if (command.kind !== "session.interactions") {
          throw new Error("Expected interaction bootstrap.");
        }
        interactionPages += 1;
        return Promise.resolve({
          ok: true,
          version: 1,
          requestId: crypto.randomUUID(),
          data: {
            sessionId,
            interactions: [{
              id: interactionId,
              sessionId,
              kind: "command_approval",
              state: "pending",
              revision: 1,
              blocking: true,
              display: { summary: "Must remain withheld" },
            }],
            nextCursor: interactionPages === 1 ? "page-2" : null,
          },
        });
      },
    });

    expect(exitCode).not.toBe(0);
    expect(interactionPages).toBe(2);
    expect(eventCalls).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).not.toBe("");
    expect(stderr).not.toContain(interactionId);
    expect(stderr).not.toContain("Must remain withheld");
  });

  test("human watch bounds its atomic interaction bootstrap before writing stdout", async () => {
    const sessionId = `sess_${"b".repeat(32)}`;
    let bootstrapObserved = false;
    let eventCalls = 0;
    let interactionPages = 0;
    let stdout = "";
    let stderr = "";
    const interactionsPerPage = 100;
    const maximumFixturePages = 10;

    const exitCode = await main([
      "session",
      "watch",
      sessionId,
      "--cursor",
      cursorWire("bounded-bootstrap-status"),
    ], {
      writeStdout: (value) => { stdout += value; },
      writeStderr: (value) => { stderr += value; },
    }, {
      callDaemon: (command) => {
        if (command.kind === "session.events") {
          eventCalls += 1;
          throw new Error("Event follow must not begin after bootstrap output exceeds its bound.");
        }
        if (command.kind !== "session.interactions") {
          throw new Error("Expected a bounded interaction bootstrap.");
        }
        const pageIndex = interactionPages;
        interactionPages += 1;
        return Promise.resolve({
          ok: true,
          version: 1,
          requestId: crypto.randomUUID(),
          data: {
            sessionId,
            interactions: Array.from({ length: interactionsPerPage }, (_, index) => ({
              id: `10700000-0000-4000-8000-${String(
                pageIndex * interactionsPerPage + index + 1,
              ).padStart(12, "0")}`,
              sessionId,
              kind: "user_input",
              state: "pending",
              revision: 1,
              blocking: true,
              display: { summary: "x".repeat(2_048) },
            })),
            nextCursor: interactionPages < maximumFixturePages
              ? `bootstrap-page-${String(interactionPages + 1)}`
              : null,
          },
        });
      },
      onHumanSessionObserverBootstrap: () => { bootstrapObserved = true; },
    });

    expect(HUMAN_SESSION_WATCH_BOOTSTRAP_MAXIMUM_BYTES).toBe(1_048_576);
    expect(exitCode).not.toBe(0);
    expect(interactionPages).toBeGreaterThan(1);
    expect(interactionPages).toBeLessThan(maximumFixturePages);
    expect(eventCalls).toBe(0);
    expect(bootstrapObserved).toBe(false);
    expect(stdout).toBe("");
    expect(stderr).toContain("Pending interaction guidance exceeds the bounded human watch bootstrap");
    expect(stderr).not.toContain("10700000-0000-4000-8000-");
  });

  test("human watch rejects a foreign bootstrap page for an exact session ID", async () => {
    const requestedSessionId = `sess_${"7".repeat(32)}`;
    const foreignSessionId = `sess_${"8".repeat(32)}`;
    let stdout = "";
    let stderr = "";
    let eventCalls = 0;
    const exitCode = await main([
      "session",
      "watch",
      requestedSessionId,
      "--cursor",
      cursorWire("status-cursor"),
    ], {
      writeStdout: (value) => { stdout += value; },
      writeStderr: (value) => { stderr += value; },
    }, {
      callDaemon: (command) => {
        if (command.kind === "session.events") {
          eventCalls += 1;
          throw new Error("Foreign bootstrap must prevent event follow.");
        }
        if (command.kind !== "session.interactions") {
          throw new Error("Expected interaction bootstrap.");
        }
        return Promise.resolve({
          ok: true,
          version: 1,
          requestId: crypto.randomUUID(),
          data: {
            sessionId: foreignSessionId,
            interactions: [],
            nextCursor: null,
          },
        });
      },
    });

    expect(exitCode).not.toBe(0);
    expect(eventCalls).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).not.toBe("");
    expect(stderr).not.toContain(foreignSessionId);
  });

  test("human watch rejects a foreign interaction nested in a correctly scoped bootstrap page", async () => {
    const requestedSessionId = `sess_${"9".repeat(32)}`;
    const foreignSessionId = `sess_${"a".repeat(32)}`;
    const foreignInteractionId = "10600000-0000-4000-8000-000000000001";
    let stdout = "";
    let stderr = "";
    let eventCalls = 0;
    const exitCode = await main([
      "session",
      "watch",
      requestedSessionId,
      "--cursor",
      cursorWire("status-cursor"),
    ], {
      writeStdout: (value) => { stdout += value; },
      writeStderr: (value) => { stderr += value; },
    }, {
      callDaemon: (command) => {
        if (command.kind === "session.events") {
          eventCalls += 1;
          throw new Error("Foreign nested interaction must prevent event follow.");
        }
        if (command.kind !== "session.interactions") {
          throw new Error("Expected interaction bootstrap.");
        }
        return Promise.resolve({
          ok: true,
          version: 1,
          requestId: crypto.randomUUID(),
          data: {
            sessionId: requestedSessionId,
            interactions: [{
              id: foreignInteractionId,
              sessionId: foreignSessionId,
              kind: "command_approval",
              state: "pending",
              revision: 1,
              blocking: true,
              display: { summary: "Foreign interaction" },
            }],
            nextCursor: null,
          },
        });
      },
    });

    expect(exitCode).not.toBe(0);
    expect(eventCalls).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).not.toBe("");
    expect(stderr).not.toContain(foreignSessionId);
    expect(stderr).not.toContain(foreignInteractionId);
  });

  test("uses each supported platform's native terminal input queue selector", () => {
    expect(protectedTerminalInputQueueForPlatform("darwin")).toBe(1);
    expect(protectedTerminalInputQueueForPlatform("linux")).toBe(0);
    expect(protectedTerminalInputQueueForPlatform("win32")).toBeNull();
    expect(protectedTerminalControlLibrariesForPlatform("darwin", "arm64")).toEqual([
      "/usr/lib/libSystem.B.dylib",
    ]);
    expect(protectedTerminalControlLibrariesForPlatform("linux", "x64")).toContain(
      "libc.musl-x86_64.so.1",
    );
    expect(protectedTerminalControlLibrariesForPlatform("linux", "arm64")).toContain(
      "libc.musl-aarch64.so.1",
    );
    expect(protectedTerminalControlLibrariesForPlatform("win32", "x64")).toEqual([]);
  });

  test("hidden terminal input settles on EOF and restores raw mode", async () => {
    const input = rawTerminalInput();
    const captured = capture();
    const read = readHiddenProtectedLineFromTerminal(input, captured.output, () => undefined);
    await waitFor(() => captured.read().stderr.includes("Type BEGIN-"));
    input.end();
    await expect(read).rejects.toThrow("ended before a document");
    expect(input.rawModes).toEqual([true, false]);
  });

  test("hidden terminal input discards pretype injected at both flush boundaries", async () => {
    const input = rawTerminalInput();
    const captured = capture();
    const stale = '{"answer":"stale-pretyped"}';
    let flushes = 0;
    const read = readHiddenProtectedLineFromTerminal(input, captured.output, () => {
      flushes += 1;
      input.write(`${stale}\n`);
    });
    await waitFor(() => captured.read().stderr.includes("Type BEGIN-"));
    input.write(`${beginPhraseFrom(captured.read().stderr)}\n`);
    await waitFor(() => captured.read().stderr.includes("Protected JSON input (hidden)"));
    input.write('{"answer":"fresh"}\n');
    await waitFor(() => captured.read().stderr.includes("Protected input captured"));
    input.write(`${resumePhraseFrom(captured.read().stderr)}\n`);
    const bytes = await read;
    expect(bytes.toString("utf8")).toBe('{"answer":"fresh"}');
    expect(bytes.toString("utf8")).not.toContain("stale-pretyped");
    expect(flushes).toBe(3);
    expect(input.rawModes).toEqual([true, false]);
    bytes.fill(0);
  });

  test("hidden terminal input drains a split trailing paste before ordinary input resumes", async () => {
    const input = rawTerminalInput();
    const captured = capture();
    const read = readHiddenProtectedLineFromTerminal(input, captured.output, () => undefined);
    await waitFor(() => captured.read().stderr.includes("Type BEGIN-"));
    input.write(`${beginPhraseFrom(captured.read().stderr)}\r`);
    await waitFor(() => captured.read().stderr.includes("Protected JSON input (hidden)"));
    input.write('{"answer":"secret"}\r');
    setTimeout(() => input.write("SECRET_TAIL\n"), 30);
    await waitFor(() => captured.read().stderr.includes("Trailing input was discarded"));
    input.write(`${resumePhraseFrom(captured.read().stderr)}\n`);
    const bytes = await read;
    expect(bytes.toString("utf8")).toBe('{"answer":"secret"}');
    expect(input.read()).toBeNull();
    bytes.fill(0);

    const output = new PassThrough();
    const coordinator = new ShellTerminalCoordinator({
      flushInput: () => undefined,
      input,
      output,
      terminal: true,
    });
    const next = coordinator.question("next> ");
    input.write("safe\n");
    expect(await next).toBe("safe");
    coordinator.close();
  });

  test("hidden terminal input requires its unpredictable readiness phrase", async () => {
    const input = rawTerminalInput();
    const captured = capture();
    let scheduled = false;
    const output = {
      writeStdout: captured.output.writeStdout,
      writeStderr: (value: string) => {
        captured.output.writeStderr(value);
        if (!scheduled && value.includes("Type BEGIN-")) {
          scheduled = true;
          input.write("stale-first-line\r");
          setTimeout(() => input.write('{"answer":"pre-scheduled"}\r'), 30);
        }
      },
    };
    const read = readHiddenProtectedLineFromTerminal(input, output, () => undefined);
    await waitFor(() => captured.read().stderr.match(/Queued input was discarded/gu)?.length === 2);
    input.write(`${beginPhraseFrom(captured.read().stderr)}\r`);
    await waitFor(() => captured.read().stderr.includes("Protected JSON input (hidden)"));
    input.write('{"answer":"fresh"}\r');
    await waitFor(() => captured.read().stderr.includes("Protected input captured"));
    input.write(`${resumePhraseFrom(captured.read().stderr)}\r`);
    const bytes = await read;
    expect(bytes.toString("utf8")).toBe('{"answer":"fresh"}');
    expect(bytes.toString("utf8")).not.toContain("pre-scheduled");
    bytes.fill(0);
  });

  test("hidden terminal accepts bytes entered in direct response to its visible document prompt", async () => {
    const input = rawTerminalInput();
    let stderr = "";
    const fresh = '{"answer":"prompt-response"}';
    const output = {
      writeStdout: () => undefined,
      writeStderr: (value: string) => {
        stderr += value;
        if (value.includes("Protected JSON input (hidden)")) input.write(`${fresh}\r`);
        const phrase = /Type (RESUME-[A-F0-9]{6})/u.exec(value)?.[1];
        if (phrase !== undefined) input.write(`${phrase}\r`);
      },
    };
    const read = readHiddenProtectedLineFromTerminal(input, output, () => undefined);
    await waitFor(() => stderr.includes("Type BEGIN-"));
    input.write(`${beginPhraseFrom(stderr)}\r`);
    const bytes = await read;
    expect(bytes.toString("utf8")).toBe(fresh);
    bytes.fill(0);
  });

  test("hidden terminal input bounds a no-newline paste and quarantines its tail", async () => {
    const input = rawTerminalInput();
    const captured = capture();
    const read = readHiddenProtectedLineFromTerminal(input, captured.output, () => undefined);
    await waitFor(() => captured.read().stderr.includes("Type BEGIN-"));
    input.write(`${beginPhraseFrom(captured.read().stderr)}\n`);
    await waitFor(() => captured.read().stderr.includes("Protected JSON input (hidden)"));
    input.write("x".repeat(64 * 1_024 + 1));
    await waitFor(() => captured.read().stderr.includes("exceeded its bound"));
    input.write("tail-must-be-drained\n");
    input.end();
    await expect(read).rejects.toThrow("exceeds 65536 UTF-8 bytes");
    expect(input.read()).toBeNull();
    expect(input.rawModes).toEqual([true, false]);
  });

  test("hidden terminal bounds repeated readiness and return-handoff attempts", async () => {
    for (const phase of ["readiness", "return"] as const) {
      const input = rawTerminalInput();
      const captured = capture();
      const read = readHiddenProtectedLineFromTerminal(input, captured.output, () => undefined);
      await waitFor(() => captured.read().stderr.includes("Type BEGIN-"));
      if (phase === "return") {
        input.write(`${beginPhraseFrom(captured.read().stderr)}\r`);
        await waitFor(() => captured.read().stderr.includes("Protected JSON input (hidden)"));
        input.write('{"answer":"must-be-zeroed"}\r');
        await waitFor(() => captured.read().stderr.includes("Protected input captured"));
      }
      const repeatedNotice = phase === "readiness" ? "Queued input was discarded" : "Trailing input was discarded";
      for (let attempt = 1; attempt < 8; attempt += 1) {
        input.write(`wrong-${String(attempt)}\r`);
        await waitFor(() => (captured.read().stderr.match(new RegExp(repeatedNotice, "gu"))?.length ?? 0) >= attempt);
      }
      input.write("wrong-8\r");
      await waitFor(() => captured.read().stderr.includes("could not prove a human handoff"));
      input.end();
      await expect(read).rejects.toThrow("bounded");
      expect(captured.read().stderr).not.toContain("must-be-zeroed");
      expect(input.rawModes).toEqual([true, false]);
    }
  });

  test("hidden terminal flush quarantine survives a throwing display", async () => {
    const input = rawTerminalInput();
    const read = readHiddenProtectedLineFromTerminal(input, {
      writeStdout: () => undefined,
      writeStderr: () => { throw new Error("display unavailable"); },
    }, () => { throw new Error("tcflush failed"); });
    await expect(read).rejects.toThrow("could not establish an empty input queue");
    expect(input.destroyed).toBe(true);
    expect(input.read()).toBeNull();
  });

  test("hidden terminal aborts and fences an initial flush quarantine", async () => {
    const input = rawTerminalInput();
    const captured = capture();
    const controller = new AbortController();
    const read = readHiddenProtectedLineFromTerminal(
      input,
      captured.output,
      () => { throw new Error("tcflush failed"); },
      controller.signal,
    );
    await waitFor(() => captured.read().stderr.includes("discard input until EOF"));
    controller.abort(new Error("display closed"));
    await expect(read).rejects.toThrow("could not establish an empty input queue");
    expect(input.destroyed).toBe(true);
    expect(input.read()).toBeNull();
  });

  test("hidden terminal prompt failure restores raw mode before returning", async () => {
    const input = rawTerminalInput();
    const read = readHiddenProtectedLineFromTerminal(input, {
      writeStdout: () => undefined,
      writeStderr: () => { throw new Error("prompt unavailable"); },
    }, () => undefined);
    await expect(read).rejects.toThrow("prompt became unavailable");
    expect(input.rawModes).toEqual([true, false]);
    expect(input.destroyed).toBe(true);
  });

  test("hidden terminal restores and fences before honoring raw Ctrl-Z", async () => {
    const input = rawTerminalInput();
    const captured = capture();
    const read = readHiddenProtectedLineFromTerminal(input, captured.output, () => undefined);
    await waitFor(() => captured.read().stderr.includes("Type BEGIN-"));
    input.write("\u001a");
    await expect(read).rejects.toThrow("was suspended");
    expect(input.rawModes).toEqual([true, false]);
    expect(input.destroyed).toBe(true);
  });

  test("hidden terminal drains delayed Ctrl-backslash and Ctrl-Z tails before re-signalling", async () => {
    for (const [byte, expectedSignal] of [[0x1c, "SIGQUIT"], [0x1a, "SIGTSTP"]] as const) {
      const input = rawTerminalInput();
      const captured = capture();
      const signalListeners = new Map<NodeJS.Signals, () => void>();
      const resignalled: NodeJS.Signals[] = [];
      const propagationStates: Array<Readonly<{
        destroyed: boolean;
        listenerCount: number;
        raw: boolean;
      }>> = [];
      let flushes = 0;
      const read = withProtectedTerminalLifecycle(
        async (signal) => await readHiddenProtectedLineFromTerminal(
          input,
          captured.output,
          () => { flushes += 1; },
          signal,
        ),
        undefined,
        {
          onOutputFailure: () => () => undefined,
          onSignal: (signal, listener) => {
            signalListeners.set(signal, listener);
            return () => { signalListeners.delete(signal); };
          },
          resignal: (signal) => {
            propagationStates.push({
              destroyed: input.destroyed,
              listenerCount: signalListeners.size,
              raw: input.isRaw,
            });
            resignalled.push(signal);
          },
        },
      );
      await waitFor(() => captured.read().stderr.includes("Type BEGIN-"));
      input.write(Buffer.from([byte]));
      let delayedTailArrivedWhileRaw = false;
      setTimeout(() => {
        delayedTailArrivedWhileRaw = input.isRaw;
        input.write("must-not-reach-parent\n");
      }, 30);
      await expect(read).rejects.toThrow(expectedSignal === "SIGQUIT" ? "SIGQUIT" : "was suspended");
      expect(delayedTailArrivedWhileRaw).toBe(true);
      expect(flushes).toBe(2);
      expect(input.rawModes).toEqual([true, false]);
      expect(input.destroyed).toBe(true);
      expect(input.read()).toBeNull();
      expect(resignalled).toEqual([expectedSignal]);
      expect(propagationStates).toEqual([{ destroyed: true, listenerCount: 0, raw: false }]);
    }
  });

  test("hidden terminal fails closed when the final raw-signal flush is unavailable", async () => {
    const input = rawTerminalInput();
    const captured = capture();
    const resignalled: NodeJS.Signals[] = [];
    let flushes = 0;
    const read = withProtectedTerminalLifecycle(
      async (signal) => await readHiddenProtectedLineFromTerminal(
        input,
        captured.output,
        () => {
          flushes += 1;
          if (flushes === 2) throw new Error("final flush unavailable");
        },
        signal,
      ),
      undefined,
      {
        onOutputFailure: () => () => undefined,
        onSignal: () => () => undefined,
        resignal: (signal) => { resignalled.push(signal); },
      },
    );
    await waitFor(() => captured.read().stderr.includes("Type BEGIN-"));
    input.write("\u001c");
    await expect(read).rejects.toThrow("quiet signal boundary");
    expect(resignalled).toEqual([]);
    expect(input.rawModes).toEqual([true, false]);
    expect(input.destroyed).toBe(true);
  });

  test("hidden terminal restores and re-signals raw Ctrl-backslash at every protected handoff", async () => {
    for (const phase of ["readiness", "document", "return"] as const) {
      const input = rawTerminalInput();
      const captured = capture();
      const resignalled: NodeJS.Signals[] = [];
      const read = withProtectedTerminalLifecycle(
        async (signal) => await readHiddenProtectedLineFromTerminal(
          input,
          captured.output,
          () => undefined,
          signal,
        ),
        undefined,
        {
          onOutputFailure: () => () => undefined,
          onSignal: () => () => undefined,
          resignal: (signal) => { resignalled.push(signal); },
        },
      );
      await waitFor(() => captured.read().stderr.includes("Type BEGIN-"));
      if (phase !== "readiness") {
        input.write(`${beginPhraseFrom(captured.read().stderr)}\r`);
        await waitFor(() => captured.read().stderr.includes("Protected JSON input (hidden)"));
      }
      if (phase === "return") {
        input.write('{"answer":"must-be-zeroed"}\r');
        await waitFor(() => captured.read().stderr.includes("Protected input captured"));
      }
      input.write("\u001c");
      await expect(read).rejects.toThrow("SIGQUIT");
      expect(input.rawModes).toEqual([true, false]);
      expect(input.destroyed).toBe(true);
      expect(resignalled).toEqual(["SIGQUIT"]);
      expect(captured.read().stderr).not.toContain("must-be-zeroed");
    }
  });

  test("hidden terminal treats Ctrl-D during its quiet handoff as cancellation", async () => {
    const input = rawTerminalInput();
    const captured = capture();
    const read = readHiddenProtectedLineFromTerminal(input, captured.output, () => undefined);
    await waitFor(() => captured.read().stderr.includes("Type BEGIN-"));
    input.write(`${beginPhraseFrom(captured.read().stderr)}\r`);
    setTimeout(() => input.write("\u0004"), 5);
    await waitFor(() => captured.read().stderr.includes("remains hidden while HRA discards its tail"));
    input.write("\u0004");
    await expect(read).rejects.toThrow("ended before a document");
    expect(captured.read().stderr).not.toContain("Protected JSON input (hidden)");
    expect(input.rawModes).toEqual([true, false]);
    expect(input.destroyed).toBe(true);
  });

  test("direct hidden input restores before propagating process termination", async () => {
    const input = rawTerminalInput();
    const captured = capture();
    const signalListeners = new Map<NodeJS.Signals, () => void>();
    let outputFailure: (() => void) | null = null;
    const resignalled: NodeJS.Signals[] = [];
    const read = withProtectedTerminalLifecycle(
      async (signal) => await readHiddenProtectedLineFromTerminal(
        input,
        captured.output,
        () => undefined,
        signal,
      ),
      undefined,
      {
        onOutputFailure: (listener) => {
          outputFailure = listener;
          return () => { outputFailure = null; };
        },
        onSignal: (signal, listener) => {
          signalListeners.set(signal, listener);
          return () => { signalListeners.delete(signal); };
        },
        resignal: (signal) => { resignalled.push(signal); },
      },
    );
    await waitFor(() => captured.read().stderr.includes("Type BEGIN-"));
    expect(outputFailure).not.toBeNull();
    signalListeners.get("SIGTERM")?.();
    await expect(read).rejects.toThrow("cancelled");
    expect(input.rawModes).toEqual([true, false]);
    expect(input.destroyed).toBe(true);
    expect(signalListeners.size).toBe(0);
    expect(outputFailure).toBeNull();
    expect(resignalled).toEqual(["SIGTERM"]);
  });

  test("hidden terminal fences input when raw activation is a silent no-op", async () => {
    const input = rawTerminalInput();
    input.setRawMode = (mode: boolean) => {
      input.rawModes.push(mode);
      return input;
    };
    const captured = capture();
    await expect(readHiddenProtectedLineFromTerminal(
      input,
      captured.output,
      () => undefined,
    )).rejects.toThrow("could not establish raw no-echo mode");
    expect(input.rawModes).toEqual([true, true]);
    expect(input.isRaw).toBe(false);
    expect(input.destroyed).toBe(true);
    expect(captured.read().stderr).toContain("could not disable echo");
    expect(captured.read().stderr).not.toContain("remains hidden");
  });

  test("hidden terminal couples raw input to the coordinator display lifecycle", async () => {
    const input = rawTerminalInput();
    const terminalOutput = new PassThrough();
    let stderr = "";
    const coordinator = new ShellTerminalCoordinator({
      flushInput: () => undefined,
      input,
      output: terminalOutput,
      terminal: true,
    });
    const read = readHiddenProtectedLineFromTerminal(input, {
      writeStdout: () => undefined,
      writeStderr: (value: string) => {
        stderr += value;
        terminalOutput.write(value);
      },
    }, () => undefined, coordinator.lifecycleSignal);
    await waitFor(() => stderr.includes("Type BEGIN-"));
    terminalOutput.destroy();
    await expect(read).rejects.toThrow("cancelled");
    expect(input.isRaw).toBe(false);
    expect(input.destroyed).toBe(true);
    expect(await coordinator.question("must-not-open> ")).toBeNull();
    coordinator.close();
  });

  test("hidden terminal keeps echo disabled while quarantining a cancelled secret tail", async () => {
    const input = rawTerminalInput();
    const captured = capture();
    const read = readHiddenProtectedLineFromTerminal(input, captured.output, () => undefined);
    await waitFor(() => captured.read().stderr.includes("Type BEGIN-"));
    input.write(`${beginPhraseFrom(captured.read().stderr)}\r`);
    await waitFor(() => captured.read().stderr.includes("Protected JSON input (hidden)"));
    input.write("\u0003");
    await waitFor(() => captured.read().stderr.includes("remains hidden"));
    let tailArrivedWhileRaw = false;
    setTimeout(() => {
      tailArrivedWhileRaw = input.isRaw;
      input.write("SECRET_AFTER_CANCEL\n");
      setTimeout(() => {
        input.write("\u0004");
        setTimeout(() => input.write("SECRET_AFTER_QUARANTINE_EXIT\n", () => undefined), 30);
      }, 10);
    }, 30);
    await expect(read).rejects.toThrow("cancelled");
    await new Promise<void>((resolve) => setTimeout(resolve, 45));
    expect(tailArrivedWhileRaw).toBe(true);
    expect(input.destroyed).toBe(true);
    expect(input.read()).toBeNull();
    expect(input.rawModes).toEqual([true, false]);
  });

  test("hidden terminal closes input when raw-mode restoration cannot be proven", async () => {
    const input = rawTerminalInput();
    input.setRawMode = (mode: boolean) => {
      input.rawModes.push(mode);
      if (!mode) throw new Error("restore failed");
      input.isRaw = true;
      return input;
    };
    const captured = capture();
    const read = readHiddenProtectedLineFromTerminal(input, captured.output, () => undefined);
    await waitFor(() => captured.read().stderr.includes("Type BEGIN-"));
    input.write(`${beginPhraseFrom(captured.read().stderr)}\r`);
    await waitFor(() => captured.read().stderr.includes("Protected JSON input (hidden)"));
    input.write('{"answer":"secret"}\r');
    await waitFor(() => captured.read().stderr.includes("Protected input captured"));
    input.write(`${resumePhraseFrom(captured.read().stderr)}\r`);
    await expect(read).rejects.toThrow("raw mode restoration failed");
    expect(input.destroyed).toBe(true);
    expect(input.rawModes.filter((mode) => !mode)).toHaveLength(2);
  });

  test("hidden terminal rejects a silent raw-mode restoration no-op and zeroes custody", async () => {
    const input = rawTerminalInput();
    input.setRawMode = (mode: boolean) => {
      input.rawModes.push(mode);
      if (mode) input.isRaw = true;
      return input;
    };
    const captured = capture();
    const read = readHiddenProtectedLineFromTerminal(input, captured.output, () => undefined);
    await waitFor(() => captured.read().stderr.includes("Type BEGIN-"));
    input.write(`${beginPhraseFrom(captured.read().stderr)}\r`);
    await waitFor(() => captured.read().stderr.includes("Protected JSON input (hidden)"));
    input.write('{"answer":"secret"}\r');
    await waitFor(() => captured.read().stderr.includes("Protected input captured"));
    input.write(`${resumePhraseFrom(captured.read().stderr)}\r`);
    await expect(read).rejects.toThrow("raw mode could not be restored");
    expect(input.destroyed).toBe(true);
    expect(input.rawModes.filter((mode) => !mode)).toHaveLength(2);
  });

  test("help is offline and stable", async () => {
    const captured = capture();
    expect(await main(["--help"], captured.output)).toBe(0);
    expect(captured.read().stdout).toContain("hra session");
    expect(captured.read().stdout).toContain("Usage:\n  hra\n");
    expect(captured.read().stdout).toContain("--json                    Emit one versioned JSON result");
    expect(captured.read().stdout).toContain("hra device list|pair|approve|revoke|key-loss");
    expect(captured.read().stdout).toContain("Run bare `hra` in a TTY to start the persistent agent-and-human shell.");
    expect(captured.read().stderr).toBe("");

    const group = capture();
    expect(await main(["session", "--help"], group.output)).toBe(0);
    expect(group.read().stdout).toContain("HRA session");
    expect(group.read().stdout).toContain("hra session events");
    expect(group.read().stdout).toContain("hra session interactions <session> [--pending] [--limit <1..100>] [--cursor <cursor>]");
    expect(group.read().stdout).not.toContain("hra device pair");
    expect(group.read().stderr).toBe("");

    const protectedGroup = capture();
    expect(await main(["interaction", "answer", "--help"], protectedGroup.output)).toBe(0);
    expect(protectedGroup.read().stdout).toContain("--input-stdin|--input-fd");
    expect(protectedGroup.read().stdout).toContain("hra interaction list [session] [--pending] [--limit <1..100>] [--cursor <cursor>]");
    expect(protectedGroup.read().stdout).toContain("Protected values");
    expect(protectedGroup.read().stderr).toBe("");
  });

  test("offline doctor returns one JSON value", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hra-doctor-"));
    try {
      const captured = capture();
      const statePaths = resolveStatePaths({ homeDirectory: temporary, platform: process.platform });
      expect(await main(["doctor", "--offline", "--json"], captured.output, { statePaths })).toBe(0);
      const parsed = JSON.parse(captured.read().stdout) as { ok: boolean; data: { networkChecks: string } };
      expect(parsed).toMatchObject({ ok: true, data: { networkChecks: "skipped" } });
      expect(captured.read().stderr).toBe("");
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("offline doctor treats a private pre-initialization root without a database as not initialized", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "hra-doctor-preinit-")));
    try {
      const statePaths = resolveStatePaths({ homeDirectory: temporary, platform: process.platform });
      await mkdir(statePaths.root, { recursive: true, mode: 0o700 });
      const captured = capture();
      expect(await main(["doctor", "--offline", "--json"], captured.output, { statePaths })).toBe(0);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        ok: true,
        data: {
          healthy: true,
          state: { database: "not_initialized", initialized: false },
        },
      });
      expect(captured.read().stderr).toBe("");
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("offline doctor makes a released failed daemon receipt an explicit restart-safe observation", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "hra-doctor-daemon-failed-")));
    const statePaths = resolveStatePaths({ homeDirectory: temporary, platform: process.platform });
    try {
      await initializeStatePaths(statePaths);
      const authority = await DaemonLock.acquire(statePaths, { state: "maintenance" });
      await authority.release({ state: "failed", failure: "bounded test failure" });
      expect(await stopDaemonWithExactAuthority(statePaths)).toMatchObject({
        error: { code: "RECOVERY_REQUIRED", details: { nextCommand: "hra doctor --offline" } },
        kind: "failure",
      });

      const json = capture();
      expect(await main(["doctor", "--offline", "--json"], json.output, { statePaths })).toBe(0);
      expect(JSON.parse(json.read().stdout)).toMatchObject({
        data: {
          healthy: true,
          state: {
            daemonAuthority: {
              database: { authority: "released", custody: "safe" },
              receipt: { custody: "safe", state: "failed" },
              state: "released",
            },
          },
        },
        ok: true,
      });

      const human = capture();
      expect(await main(["doctor", "--offline"], human.output, { statePaths })).toBe(0);
      expect(human.read().stdout).toContain(
        "daemon authority released after a failed daemon; safe to restart after these checks.",
      );
      expect(human.read().stderr).toBe("");
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("offline doctor refuses restart when a live receipt outlives its named authority database", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "hra-doctor-daemon-missing-authority-")));
    const statePaths = resolveStatePaths({ homeDirectory: temporary, platform: process.platform });
    try {
      await initializeStatePaths(statePaths);
      const authority = await DaemonLock.acquire(statePaths, { state: "maintenance" });
      await authority.publish({
        bootId: `boot_${"1".repeat(32)}`,
        generation: 1,
        state: "ready",
      });
      await authority.release();
      const receipt = await readDaemonAuthorityReceipt(statePaths);
      if (receipt === null) throw new Error("Expected a daemon receipt fixture.");
      await writeFile(statePaths.daemonLock, `${JSON.stringify({ ...receipt, state: "ready" })}\n`);
      await unlink(daemonAuthorityDatabasePath(statePaths));

      const captured = capture();
      expect(await main(["doctor", "--offline", "--json"], captured.output, { statePaths })).toBe(1);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        data: {
          healthy: false,
          state: {
            daemonAuthority: {
              database: { custody: "absent" },
              receipt: { custody: "safe", state: "ready" },
              state: "indeterminate",
            },
          },
        },
        ok: true,
      });
      expect(captured.read().stderr).toBe("");
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("offline doctor diagnoses every immediate daemon-stop authority recovery without leaking paths", async () => {
    for (const scenario of ["unsafe_receipt", "unsafe_database", "invalid_database"] as const) {
      const temporary = await realpath(await mkdtemp(join(tmpdir(), `hra-doctor-daemon-${scenario}-`)));
      const statePaths = resolveStatePaths({ homeDirectory: temporary, platform: process.platform });
      try {
        await initializeStatePaths(statePaths);
        const authority = await DaemonLock.acquire(statePaths, { state: "maintenance" });
        await authority.release();
        if (scenario === "unsafe_receipt") {
          await chmod(statePaths.daemonLock, 0o640);
        } else if (scenario === "unsafe_database") {
          await chmod(daemonAuthorityDatabasePath(statePaths), 0o640);
        } else {
          await writeFile(daemonAuthorityDatabasePath(statePaths), "not a sqlite database");
        }

        expect(await stopDaemonWithExactAuthority(statePaths)).toMatchObject({
          error: { code: "RECOVERY_REQUIRED", details: { nextCommand: "hra doctor --offline" } },
          kind: "failure",
        });
        const captured = capture();
        expect(await main(["doctor", "--offline", "--json"], captured.output, { statePaths })).toBe(1);
        const result = JSON.parse(captured.read().stdout) as unknown;
        expect(result).toMatchObject({
          data: {
            healthy: false,
            state: { daemonAuthority: { state: scenario } },
          },
          ok: true,
        });
        expect(JSON.stringify(result)).not.toContain(temporary);
        expect(captured.read().stderr).toBe("");
      } finally {
        await rm(temporary, { force: true, recursive: true });
      }
    }
  });

  test("offline doctor rejects a state root not owned by the invoking user", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "hra-doctor-owner-")));
    try {
      const statePaths = resolveStatePaths({ rootDirectory: join(temporary, "state") });
      await mkdir(statePaths.root, { recursive: true, mode: 0o700 });
      const metadata = await lstat(statePaths.root);
      const captured = capture();
      expect(await main(["doctor", "--offline", "--json"], captured.output, {
        offlineDoctorOwnerUid: metadata.uid + 1,
        statePaths,
      })).toBe(1);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        ok: true,
        data: {
          healthy: false,
          problems: ["The state root is not a private canonical directory."],
          state: { database: "not_initialized", initialized: false },
        },
      });
      expect(captured.read().stderr).toBe("");
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("offline doctor rejects a state root reached through a symbolic-link ancestor", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hra-doctor-symlink-"));
    try {
      const actualParent = join(temporary, "actual");
      const linkedParent = join(temporary, "linked");
      await mkdir(join(actualParent, "state"), { recursive: true, mode: 0o700 });
      await symlink(actualParent, linkedParent);
      const statePaths = resolveStatePaths({ rootDirectory: join(linkedParent, "state") });
      const captured = capture();
      expect(await main(["doctor", "--offline", "--json"], captured.output, {
        statePaths,
      })).toBe(1);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        ok: true,
        data: {
          healthy: false,
          problems: ["The state root is not a private canonical directory."],
        },
      });
      expect(captured.read().stderr).toBe("");
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("offline doctor rejects a group-readable local database", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "hra-doctor-database-mode-")));
    try {
      const statePaths = resolveStatePaths({ rootDirectory: join(temporary, "state") });
      await initializeStatePaths(statePaths);
      const store = new StateStore(statePaths);
      store.close();
      await chmod(statePaths.database, 0o640);
      const captured = capture();
      expect(await main(["doctor", "--offline", "--json"], captured.output, {
        statePaths,
      })).toBe(1);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        ok: true,
        data: {
          healthy: false,
          problems: ["The local database check failed without exposing its runtime diagnostic."],
          state: { database: "invalid", initialized: false },
        },
      });
      expect(captured.read().stderr).toBe("");
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("offline doctor rejects a dangling state-root symbolic link instead of treating it as absent", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "hra-doctor-dangling-root-")));
    try {
      const statePaths = resolveStatePaths({ rootDirectory: join(temporary, "state") });
      await symlink(join(temporary, "missing-target"), statePaths.root);
      const captured = capture();
      expect(await main(["doctor", "--offline", "--json"], captured.output, {
        statePaths,
      })).toBe(1);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        ok: true,
        data: {
          healthy: false,
          problems: ["The state root is not a private canonical directory."],
          state: { database: "not_initialized", initialized: false },
        },
      });
      expect(captured.read().stderr).toBe("");
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("threads a source-only installation through initialization without changing HOME", async () => {
    const runId = "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b";
    const runRoot = await realpath(
      await mkdtemp(join(tmpdir(), `hra-live-acceptance-${runId}-`)),
    );
    const documentsDirectory = join(runRoot, "project-a-fixture");
    await mkdir(documentsDirectory, { mode: 0o700 });
    try {
      const expectedHomeDirectory = process.env.HOME;
      if (expectedHomeDirectory === undefined) throw new Error("Test requires HOME.");
      const installation = createAcceptanceInstallation({
        device: "a",
        documentsDirectory,
        expectedHomeDirectory,
        rootDirectory: join(runRoot, "device-a-fixture"),
        runId,
        type: "hra-live-acceptance-device",
        version: 1,
      });
      const captured = capture();

      expect(await main(["init", "--yes", "--json"], captured.output, {
        installation,
      })).toBe(0);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        data: {
          defaultProjectCreated: true,
          initialized: true,
          stateRoot: installation.paths.root,
        },
        ok: true,
        version: 1,
      });
      expect(process.env.HOME).toBe(expectedHomeDirectory);
      expect((await lstat(installation.paths.database)).isFile()).toBe(true);
    } finally {
      await rm(runRoot, { force: true, recursive: true });
    }
  });

  test("refresh-all skips signed-out accounts, bounds concurrency, and reports every outcome", async () => {
    const accounts = Array.from({ length: 7 }, (_, index) => ({
      id: `acct_${String(index).padStart(32, "0")}`,
      label: `Account ${String(index)}`,
      processGeneration: index === 0 ? 0 : 1,
      providerEmail: undefined,
      providerPlan: undefined,
      state: index === 0 ? "signed_out" as const : "signed_in" as const,
      updatedAt: index,
    }));
    let active = 0;
    let maximumActive = 0;
    let releaseWave!: () => void;
    const firstWave = new Promise<void>((resolve) => { releaseWave = resolve; });
    const commands: LocalCommand[] = [];
    const captured = capture();
    const automaticReset = (accountId: string) => ({
      threshold: { remainingPercent: 1, usedPercent: 99 },
      observation: {
        state: "unavailable" as const,
        reason: "weekly_window_unavailable" as const,
      },
      lastAttempt: accountId === accounts[1]?.id
        ? {
            state: "settled" as const,
            outcome: "reset" as const,
            weeklyWindowResetsAt: 2_000_000_000_000,
          }
        : null,
    });
    expect(await main(["account", "usage", "--refresh", "--json"], captured.output, {
      callDaemon: async (command) => {
        commands.push(command);
        if (command.kind === "account.list") {
          return { ok: true, version: 1, requestId: crypto.randomUUID(), data: { accounts: [...accounts].reverse() } };
        }
        if (command.kind === "account.usage" && command.refresh && command.account !== undefined) {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          if (maximumActive === 4) releaseWave();
          await firstWave;
          active -= 1;
          if (command.account === accounts[3]?.id) {
            return {
              ok: false,
              version: 1,
              requestId: crypto.randomUUID(),
              error: {
                code: "UNAVAILABLE",
                message: "provider token=do-not-return failed at /private/account",
              },
            };
          }
          return {
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: {
              usage: [{
                account: { id: command.account },
                automaticReset: automaticReset(command.account),
              }],
            },
          };
        }
        if (command.kind === "account.usage" && !command.refresh && command.account === undefined) {
          return {
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: {
              usage: [...accounts].reverse().map((account) => ({
                account,
                automaticReset: automaticReset(account.id),
                poll: { state: "never_observed" },
                snapshot: null,
                velocity: {},
              })),
            },
          };
        }
        throw new Error("Unexpected refresh-all command.");
      },
    })).toBe(0);
    expect(maximumActive).toBe(4);
    expect(commands.filter((command) => command.kind === "account.usage" && command.refresh)).toHaveLength(6);
    expect(commands.some((command) =>
      command.kind === "account.usage" && command.refresh && command.account === accounts[0]?.id)).toBe(false);
    const payload = JSON.parse(captured.read().stdout) as {
      data: {
        refresh: { outcomes: Array<{ accountId: string; code?: string; state: string }> };
        usage: Array<{
          account: { id: string };
          automaticReset?: unknown;
        }>;
      };
    };
    expect(payload.data.refresh.outcomes.map((outcome) => outcome.accountId)).toEqual(
      accounts.map((account) => account.id),
    );
    expect(payload.data.refresh.outcomes[0]).toMatchObject({ state: "skipped" });
    expect(payload.data.refresh.outcomes[3]).toMatchObject({ code: "UNAVAILABLE", state: "failed" });
    expect(payload.data.usage.map((entry) => entry.account.id)).toEqual(accounts.map((account) => account.id));
    expect(payload.data.usage[1]).toMatchObject({
      automaticReset: {
        lastAttempt: {
          state: "settled",
          outcome: "reset",
          weeklyWindowResetsAt: 2_000_000_000_000,
        },
      },
    });
    expect(captured.read().stdout).not.toContain("do-not-return");
    expect(captured.read().stdout).not.toContain("/private/account");
    expect(captured.read().stderr).toBe("");
  });

  test("refresh-all rejects an oversized account set before any usage effect", async () => {
    const accounts = Array.from({ length: 33 }, (_, index) => ({
      id: `acct_${index.toString(16).padStart(32, "0")}`,
      label: `Account ${String(index)}`,
      processGeneration: 1,
      state: "signed_in" as const,
      updatedAt: index,
    }));
    const commands: LocalCommand[] = [];
    const captured = capture();
    expect(await main(["account", "usage", "--refresh", "--json"], captured.output, {
      callDaemon: (command) => {
        commands.push(command);
        return Promise.resolve({
          ok: true,
          version: 1,
          requestId: crypto.randomUUID(),
          data: { accounts },
        });
      },
    })).toBe(5);
    expect(commands).toEqual([{ kind: "account.list" }]);
    expect(JSON.parse(captured.read().stdout)).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        details: { accountCount: 33, accountLimit: 32 },
      },
    });
  });

  test("refresh-all retains every outcome when the post-effect usage view is unavailable", async () => {
    const accounts = [
      {
        id: `acct_${"1".repeat(32)}`,
        label: "Signed in",
        processGeneration: 1,
        state: "signed_in" as const,
        updatedAt: 1,
      },
      {
        id: `acct_${"2".repeat(32)}`,
        label: "Signed out",
        processGeneration: 0,
        state: "signed_out" as const,
        updatedAt: 2,
      },
    ];
    const secret = "POST_REFRESH_HISTORY_SENTINEL_DO_NOT_RETURN";
    for (const historyFailure of ["invalid_response", "internal_failure"] as const) {
      const captured = capture();
      let refreshEffects = 0;
      expect(await main(["account", "usage", "--refresh", "--json"], captured.output, {
        callDaemon: async (command) => {
          if (command.kind === "account.list") {
            return {
              data: { accounts: [...accounts].reverse() },
              ok: true,
              requestId: crypto.randomUUID(),
              version: 1,
            };
          }
          if (command.kind === "account.usage" && command.refresh && command.account === accounts[0]?.id) {
            refreshEffects += 1;
            return {
              data: { usage: [{ account: { id: command.account } }] },
              ok: true,
              requestId: crypto.randomUUID(),
              version: 1,
            };
          }
          if (command.kind === "account.usage" && !command.refresh && command.account === undefined) {
            return historyFailure === "invalid_response"
              ? {
                  data: { diagnostic: secret, usage: "malformed" },
                  ok: true,
                  requestId: crypto.randomUUID(),
                  version: 1,
                }
              : {
                  error: {
                    code: "INTERNAL" as const,
                    details: { diagnostic: secret },
                    message: `provider unavailable ${secret}`,
                  },
                  ok: false,
                  requestId: crypto.randomUUID(),
                  version: 1,
                };
          }
          throw new Error("Unexpected refresh-all command.");
        },
      })).toBe(5);
      expect(refreshEffects).toBe(1);
      const payload = JSON.parse(captured.read().stdout) as {
        error: {
          code: string;
          details: {
            refresh: {
              accountLimit: number;
              concurrency: number;
              outcomes: Array<{ accountId: string; state: string }>;
            };
            usageView: { reasonCode: string; state: string };
          };
          message: string;
        };
      };
      expect(payload.error).toMatchObject({
        code: "UNAVAILABLE",
        details: {
          refresh: {
            accountLimit: 32,
            concurrency: 4,
            outcomes: [
              { accountId: accounts[0]?.id, state: "refreshed" },
              { accountId: accounts[1]?.id, state: "skipped" },
            ],
          },
          usageView: {
            reasonCode: historyFailure === "invalid_response" ? "INVALID_RESPONSE" : "INTERNAL",
            state: "unavailable",
          },
        },
        message: "Refresh outcomes were recorded, but the final usage view is unavailable.",
      });
      expect(captured.read().stdout).not.toContain(secret);
      expect(captured.read().stderr).toBe("");
    }
  });

  test("invalid input writes diagnostics only to stderr", async () => {
    const captured = capture();
    expect(await main(["session", "fast", "x", "maybe"], captured.output)).toBe(2);
    expect(captured.read().stdout).toBe("");
    expect(captured.read().stderr).toContain("Fast must be");
  });

  test("argv and unexpected runtime failures never echo foreign diagnostics", async () => {
    const attack = "token=do-not-echo\u001b]52;c;attack\u0007";
    const usage = capture();
    expect(await main(["account", "list", attack], usage.output)).toBe(2);
    expect(usage.read().stderr).not.toContain("do-not-echo");
    expect(usage.read().stderr).not.toContain("\u001b");

    const runtime = capture();
    expect(await main(["account", "list", "--json"], runtime.output, {
      callDaemon: () => { throw new Error(`/private/runtime ${attack}`); },
    })).toBe(1);
    expect(JSON.parse(runtime.read().stdout)).toEqual({
      ok: false,
      version: 1,
      error: {
        code: "INTERNAL",
        message: "HRA could not complete the request safely.",
      },
    });
    expect(runtime.read().stdout).not.toContain("do-not-echo");
    expect(runtime.read().stdout).not.toContain("/private/runtime");
  });

  test("json intent survives parser and startup failures as one machine value", async () => {
    const captured = capture();
    expect(await main(["session", "fast", "x", "maybe", "--json"], captured.output)).toBe(2);
    expect(JSON.parse(captured.read().stdout)).toMatchObject({
      ok: false,
      version: 1,
      error: { code: "INVALID_INPUT", message: "Fast must be `on` or `off`." },
    });
    expect(captured.read().stdout.trim().split("\n")).toHaveLength(1);
    expect(captured.read().stderr).toBe("");
  });

  test("jsonl and follow intent keep malformed invocations machine-readable on stderr", async () => {
    for (const argv of [
      ["session", "events", "release", "--jsonl", "--wait-ms", "0"],
      ["account", "list", "--follow"],
    ]) {
      const captured = capture();
      expect(await main(argv, captured.output)).toBe(2);
      expect(captured.read().stdout).toBe("");
      expect(captured.read().stderr.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(captured.read().stderr)).toMatchObject({
        error: { code: "INVALID_INPUT" },
        ok: false,
        version: 1,
      });
      expect(captured.read().stderr).not.toContain("Usage:");
    }
  });

  test("rejects malformed command-specific success data as INVALID_RESPONSE", async () => {
    const secret = "PRIVATE-MALFORMED-DEVICE-RESPONSE";
    const json = capture();
    expect(await main(["device", "list", "--json"], json.output, {
      callDaemon: () => Promise.resolve({
        data: { devices: [{ encryptedLabel: secret }] },
        ok: true,
        requestId: "018bcfe5-6800-7000-8000-000000000799",
        version: 1,
      }),
    })).toBe(1);
    expect(json.read().stderr).toBe("");
    expect(JSON.parse(json.read().stdout)).toMatchObject({
      error: {
        code: "INVALID_RESPONSE",
        message: "The HRA daemon returned an invalid response for this command.",
      },
      ok: false,
      version: 1,
    });
    expect(json.read().stdout).not.toContain(secret);

    const human = capture();
    expect(await main(["device", "list"], human.output, {
      callDaemon: () => Promise.resolve({
        data: { devices: [{ encryptedLabel: secret }] },
        ok: true,
        requestId: "018bcfe5-6800-7000-8000-000000000799",
        version: 1,
      }),
    })).toBe(1);
    expect(human.read().stdout).toBe("");
    expect(human.read().stderr).toBe("hra: The HRA daemon returned an invalid response for this command.\n");
    expect(human.read().stderr).not.toContain(secret);
  });

  test("version is sourced from package metadata", async () => {
    const captured = capture();
    expect(await main(["--version"], captured.output)).toBe(0);
    expect(captured.read()).toEqual({ stdout: "hra 0.1.3\n", stderr: "" });
  });

  test("completes protected interaction input outside argv and never renders its value", async () => {
    const captured = capture();
    const commands: unknown[] = [];
    const interaction = "018bcfe5-6800-7000-8000-000000000777";
    const secretAnswer = "value-that-must-not-be-rendered";
    expect(await main([
      "interaction",
      "answer",
      interaction,
      "--revision",
      "4",
      "--input-stdin",
      "--json",
    ], captured.output, {
      callDaemon: (command) => {
        commands.push(command);
        return Promise.resolve({
          ok: true,
          version: 1,
          requestId: "018bcfe5-6800-7000-8000-000000000778",
          data: {
            interaction: {
              version: 1,
              id: interaction,
              sessionId: null,
              kind: "user_input",
              state: "response_written",
              revision: 6,
              blocking: true,
              display: {
                kind: "user_input",
                summary: "Answer recorded",
                blocking: true,
                questions: [{
                  id: "question_1",
                  header: "Question",
                  question: "Provide an answer.",
                  options: null,
                  allowsOther: true,
                  secret: true,
                }],
              },
              responseRecorded: true,
              context: { turnId: null, itemId: null },
              requestedAt: 1_000,
              deadlineAt: 61_000,
              updatedAt: 2_000,
              terminalAt: null,
            },
            responseWritten: true,
          },
        });
      },
      isTerminalDescriptor: () => false,
      readProtectedDocument: () => Promise.resolve({
        answers: { question_1: { answers: [secretAnswer] } },
      }),
    })).toBe(0);
    expect(commands).toEqual([{
      kind: "interaction.resolve",
      interaction,
      expectedRevision: 4,
      resolution: {
        kind: "user_answers",
        answers: { question_1: { answers: [secretAnswer] } },
      },
    }]);
    expect(JSON.stringify(captured.read())).not.toContain(secretAnswer);
  });

  test("keeps identity invites and verification codes off argv and output", async () => {
    const captured = capture();
    const commands: LocalCommand[] = [];
    const invite = `hra_invite_identity_v1_${"A".repeat(43)}`;
    const argv = ["auth", "login", "--input-fd", "3", "--json"];
    expect(argv.join(" ")).not.toContain(invite);
    expect(await main(argv, captured.output, {
      callDaemon: (command) => {
        commands.push(command);
        return Promise.resolve({
          data: { codeRequestedOrRejected: true, signedIn: false },
          ok: true,
          requestId: "018bcfe5-6800-7000-8000-000000000779",
          version: 1,
        });
      },
      isTerminalDescriptor: () => false,
      readProtectedDocument: () => Promise.resolve({
        email: "reader@example.com",
        invite,
      }),
    })).toBe(0);
    expect(commands).toEqual([{
      email: "reader@example.com",
      invite,
      kind: "auth.login",
    }]);
    expect(JSON.stringify(captured.read())).not.toContain(invite);
  });

  test("json protected commands refuse terminal input before reading or prompting", async () => {
    const interaction = "018bcfe5-6800-7000-8000-000000000777";
    for (const argv of [
      ["auth", "login", "--input-stdin", "--json"],
      [
        "interaction",
        "answer",
        interaction,
        "--revision",
        "4",
        "--input-stdin",
        "--json",
      ],
    ] as const) {
      const captured = capture();
      let reads = 0;
      let daemonCalls = 0;
      expect(await main(argv, captured.output, {
        callDaemon: () => {
          daemonCalls += 1;
          throw new Error("Daemon must not be called.");
        },
        isTerminalDescriptor: (fd) => {
          expect(fd).toBe(0);
          return true;
        },
        readProtectedDocument: () => {
          reads += 1;
          throw new Error("Protected input must not be read.");
        },
      })).toBe(6);
      expect(reads).toBe(0);
      expect(daemonCalls).toBe(0);
      expect(captured.read().stderr).toBe("");
      const response = JSON.parse(captured.read().stdout) as {
        error: { code: string; details: { nextCommand: string } };
        ok: boolean;
      };
      expect(response).toMatchObject({
        ok: false,
        error: {
          code: "INTERACTION_REQUIRED",
          details: { nextCommand: expect.stringContaining("--input-stdin --json") },
        },
      });
      expect(captured.read().stdout).not.toContain("hidden");
    }
  });

  test("human protected commands refuse an invisible terminal prompt", async () => {
    const captured = capture();
    let daemonCalls = 0;
    expect(await main([
      "interaction",
      "answer",
      "018bcfe5-6800-7000-8000-000000000777",
      "--revision",
      "4",
      "--input-stdin",
    ], captured.output, {
      callDaemon: () => {
        daemonCalls += 1;
        throw new Error("Daemon must not be called.");
      },
      interactive: false,
      isTerminalDescriptor: () => true,
    })).toBe(2);
    expect(daemonCalls).toBe(0);
    expect(captured.read().stderr).toContain("visible terminal on stderr");
    expect(captured.read().stderr).not.toContain("Type BEGIN-");
  });

  test("requires a protected account-login handoff before noninteractive dispatch", async () => {
    for (const argv of [
      ["account", "login", "personal", "--device-code", "--json"],
      ["account", "login", "personal", "--device-code"],
    ] as const) {
      const captured = capture();
      let daemonCalls = 0;
      expect(await main(argv, captured.output, {
        callDaemon: () => {
          daemonCalls += 1;
          throw new Error("Login must not dispatch.");
        },
        interactive: false,
      })).toBe(6);
      expect(daemonCalls).toBe(0);
      const rendered = `${captured.read().stdout}${captured.read().stderr}`;
      expect(rendered).toContain("--idempotency-key");
      expect(rendered).toContain("--handoff-file /absolute/path/to/empty-protected-login.json");
    }
  });

  test("requires protected output before inspecting live approval authority noninteractively", async () => {
    const captured = capture();
    let daemonCalls = 0;
    const interaction = "40000000-0000-4000-8000-000000000001";
    expect(await main([
      "interaction",
      "inspect",
      interaction,
      "--revision",
      "3",
      "--json",
    ], captured.output, {
      callDaemon: () => {
        daemonCalls += 1;
        throw new Error("Protected inspection must not dispatch.");
      },
      interactive: false,
    })).toBe(6);
    expect(daemonCalls).toBe(0);
    expect(JSON.parse(captured.read().stdout)).toMatchObject({
      error: {
        code: "INTERACTION_REQUIRED",
        details: {
          nextCommand: `hra interaction inspect ${interaction} --revision 3 --handoff-file /absolute/path/to/empty-protected-approval.json --json`,
        },
      },
      ok: false,
    });
  });

  test("writes exact live approval authority only to the pre-proven protected file", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "hra-cli-approval-"));
    const handoff = join(root, "approval.json");
    await chmod(root, 0o700);
    await writeFile(handoff, "", { flag: "wx", mode: 0o600 });
    const interaction = "40000000-0000-4000-8000-000000000001";
    const privateCommand = "git reset --hard CLI-PRIVATE-APPROVAL-SENTINEL";
    const document = {
      type: "hra_protected_interaction_detail" as const,
      version: 1 as const,
      binding: {
        interactionId: interaction,
        revision: 3,
        kind: "command_approval" as const,
        sessionId: `sess_${"2".repeat(32)}`,
        profileId: `acct_${"1".repeat(32)}`,
        processGeneration: 4,
        connectionId: "40000000-0000-4000-8000-000000000002",
      },
      authority: {
        kind: "command_approval" as const,
        command: privateCommand,
        reason: "Apply the exact reset",
        availableDecisions: ["accept", "decline", "cancel"],
        workingDirectory: "/private/workspace",
        environmentId: "environment-1",
        commandActions: [{ type: "unknown", command: privateCommand }],
        networkApprovalContext: { host: "private.example", protocol: "https" },
        additionalPermissions: { network: { enabled: true } },
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
      },
    };
    const captured = capture();
    try {
      expect(await main([
        "interaction",
        "inspect",
        interaction,
        "--revision",
        "3",
        "--handoff-file",
        handoff,
        "--json",
      ], captured.output, {
        callDaemon: (command) => {
          expect(command).toEqual({
            kind: "interaction.inspect",
            interaction,
            expectedRevision: 3,
          });
          return Promise.resolve({
            data: document,
            ok: true as const,
            requestId: crypto.randomUUID(),
            version: 1 as const,
          });
        },
        interactive: false,
      })).toBe(0);
      const rendered = captured.read();
      expect(rendered.stderr).toBe("");
      expect(rendered.stdout).not.toContain("CLI-PRIVATE-APPROVAL-SENTINEL");
      expect(rendered.stdout).not.toContain("/private/workspace");
      expect(JSON.parse(rendered.stdout)).toMatchObject({
        data: {
          interactionId: interaction,
          revision: 3,
          protectedOutput: {
            disposition: "preserved_caller_removes_after_decision",
            documentVersion: 1,
            path: handoff,
            status: "written",
          },
        },
        ok: true,
      });
      expect(JSON.parse(await readFile(handoff, "utf8"))).toEqual(document);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("shows exact approval authority only in a proven foreground terminal", async () => {
    const interaction = "40000000-0000-4000-8000-000000000001";
    const privatePermission = "/private/PERMISSION-VALUE-SENTINEL";
    const captured = capture();
    const protectedTerminalOutput = {
      ...captured.output,
      writeProtectedStderr: captured.output.writeStderr,
    };
    expect(await main([
      "interaction",
      "inspect",
      interaction,
      "--revision",
      "4",
    ], protectedTerminalOutput, {
      callDaemon: () => Promise.resolve({
        data: {
          type: "hra_protected_interaction_detail",
          version: 1,
          binding: {
            interactionId: interaction,
            revision: 4,
            kind: "permission_approval",
            sessionId: null,
            profileId: `acct_${"1".repeat(32)}`,
            processGeneration: 4,
            connectionId: "40000000-0000-4000-8000-000000000002",
          },
          authority: {
            kind: "permission_approval",
            permissions: { fileSystem: { read: [privatePermission] } },
            reason: "Read the exact path",
            workingDirectory: "/private/workspace",
            environmentId: null,
          },
        },
        ok: true,
        requestId: crypto.randomUUID(),
        version: 1,
      }),
      interactive: true,
      isTerminalDescriptor: (fd) => fd === 2,
    })).toBe(0);
    expect(captured.read().stderr).toContain(privatePermission);
    expect(captured.read().stderr).toContain("Exact requested permissions");
    expect(captured.read().stdout).toContain("shown in the foreground terminal");
    expect(captured.read().stdout).not.toContain(privatePermission);
  });

  test("uses one exact terminal byte limit and requires a protected file above it", async () => {
    const interaction = "40000000-0000-4000-8000-000000000001";
    const sentinel = "TERMINAL-APPROVAL-SENTINEL";
    const base: ProtectedInteractionDetailDocument = {
      type: "hra_protected_interaction_detail",
      version: 1,
      binding: {
        interactionId: interaction,
        revision: 5,
        kind: "command_approval",
        sessionId: null,
        profileId: `acct_${"1".repeat(32)}`,
        processGeneration: 4,
        connectionId: "40000000-0000-4000-8000-000000000002",
      },
      authority: {
        kind: "command_approval",
        command: `git status ${sentinel}`,
        reason: "Inspect terminal bound",
        availableDecisions: ["accept", "decline", "cancel"],
        workingDirectory: "/workspace",
        environmentId: null,
        commandActions: [],
        networkApprovalContext: null,
        additionalPermissions: "",
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
      },
    };
    const emptyEncoded = new TextEncoder().encode(renderProtectedInteractionDetail(base));
    const fillerBytes = PROTECTED_INTERACTION_TERMINAL_MAXIMUM_BYTES - emptyEncoded.byteLength;
    emptyEncoded.fill(0);
    const baseAuthority = base.authority;
    if (fillerBytes < 0 || baseAuthority.kind !== "command_approval") {
      throw new Error("Terminal approval fixture is invalid.");
    }
    const documentAt = (bytes: number): ProtectedInteractionDetailDocument => ({
      ...base,
      authority: {
        ...baseAuthority,
        additionalPermissions: "a".repeat(fillerBytes + bytes - PROTECTED_INTERACTION_TERMINAL_MAXIMUM_BYTES),
      },
    });
    for (const target of [
      PROTECTED_INTERACTION_TERMINAL_MAXIMUM_BYTES,
      PROTECTED_INTERACTION_TERMINAL_MAXIMUM_BYTES + 1,
    ]) {
      const document = documentAt(target);
      const encoded = new TextEncoder().encode(renderProtectedInteractionDetail(document));
      expect(encoded.byteLength).toBe(target);
      encoded.fill(0);
      const captured = capture();
      const protectedTerminalOutput = {
        ...captured.output,
        writeProtectedStderr: captured.output.writeStderr,
      };
      expect(await main([
        "interaction",
        "inspect",
        interaction,
        "--revision",
        "5",
      ], protectedTerminalOutput, {
        callDaemon: () => Promise.resolve({
          data: document,
          ok: true,
          requestId: crypto.randomUUID(),
          version: 1,
        }),
        interactive: true,
        isTerminalDescriptor: (fd) => fd === 2,
      })).toBe(target === PROTECTED_INTERACTION_TERMINAL_MAXIMUM_BYTES ? 0 : 6);
      if (target === PROTECTED_INTERACTION_TERMINAL_MAXIMUM_BYTES) {
        expect(captured.read().stderr).toContain(sentinel);
      } else {
        expect(captured.read().stderr).not.toContain(sentinel);
        expect(captured.read().stderr).toContain(
          `hra interaction inspect ${interaction} --revision 5 --handoff-file /absolute/path/to/empty-protected-approval.json`,
        );
      }
    }
  });

  test("does not invent cancellation authority when the pre-effect account lookup is uncertain", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "hra-cli-login-lookup-"));
    const handoff = join(root, "login.json");
    await chmod(root, 0o700);
    await writeFile(handoff, "", { flag: "wx", mode: 0o600 });
    const captured = capture();
    let calls = 0;
    try {
      expect(await main([
        "account",
        "login",
        "Personal",
        "--device-code",
        "--handoff-file",
        handoff,
        "--json",
      ], captured.output, {
        callDaemon: () => {
          calls += 1;
          throw new LocalDaemonIndeterminateError("read response lost");
        },
        interactive: false,
      })).toBe(5);
      expect(calls).toBe(1);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        error: {
          code: "UNAVAILABLE",
          details: { providerEffectDispatched: false },
        },
        ok: false,
      });
      expect(captured.read().stdout).not.toContain("cancelCommand");
      expect(await readFile(handoff, "utf8")).toBe("");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("surfaces the exact generated device key after an indeterminate daemon response", async () => {
    const captured = capture();
    let generatedKey = "";
    expect(await main([
      "device",
      "approve",
      "device_pending",
      "--json",
    ], captured.output, {
      callDaemon: (command) => {
        if (command.kind === "device.approve") generatedKey = command.idempotencyKey;
        throw new LocalDaemonIndeterminateError("device response lost");
      },
    })).toBe(7);
    expect(generatedKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    const rendered = JSON.parse(captured.read().stdout) as {
      error: {
        code: string;
        details: { idempotencyKey: string; nextCommand: string; sameKeyReplay: boolean };
      };
    };
    expect(rendered).toMatchObject({
      error: {
        code: "RECOVERY_REQUIRED",
        details: { idempotencyKey: generatedKey, sameKeyReplay: true },
      },
    });
    expect(rendered.error.details.nextCommand)
      .toBe(`hra device approve device_pending --idempotency-key ${generatedKey} --json`);
  });

  test("keeps rejected projection recovery as an immutable receipt with one status action", async () => {
    const session = `sess_${"6".repeat(32)}`;
    const idempotencyKey = "018bcfe5-6800-7000-8000-000000000700";
    for (const json of [false, true]) {
      const captured = capture();
      expect(await main([
        "sync",
        "projection",
        "recover",
        session,
        "--acknowledge-gap",
        "--idempotency-key",
        idempotencyKey,
        ...(json ? ["--json"] : []),
      ], captured.output, {
        callDaemon: () => Promise.resolve({
          data: {
            idempotencyKey,
            phase: "rejected",
            rejectionCode: "REMOTE_HEAD_CHANGED",
            sessionPublicId: session,
          },
          ok: true,
          requestId: crypto.randomUUID(),
          version: 1,
        }),
      })).toBe(0);
      const rendered = captured.read();
      const replayCommand = [
        "hra sync projection recover",
        session,
        "--acknowledge-gap --idempotency-key",
        idempotencyKey,
        ...(json ? ["--json"] : []),
      ].join(" ");
      if (json) {
        expect(JSON.parse(rendered.stdout)).toEqual({
          command: "sync.projection-recover",
          data: {
            idempotencyKey,
            nextCommand: "hra sync status --json",
            phase: "rejected",
            rejectionCode: "REMOTE_HEAD_CHANGED",
            sameKeyReplay: { command: replayCommand, supported: true },
            session,
          },
          ok: true,
          version: 1,
        });
      } else {
        expect(rendered.stdout).toBe([
          `Projection recovery rejected for ${session}.`,
          "Reason: REMOTE_HEAD_CHANGED",
          "Encrypted cloud history and provider/app state were unchanged.",
          `Same-key replay: ${replayCommand}`,
          "Next: hra sync status --json",
          "",
        ].join("\n"));
      }
      expect(rendered.stderr).toBe("");
    }
  });

  test("preserves only the exact projection-status recovery action across human and JSON failures", async () => {
    const session = `sess_${"7".repeat(32)}`;
    const idempotencyKey = "018bcfe5-6800-7000-8000-000000000701";
    const providerSentinel = "PRIVATE-PROVIDER-PROJECTION-DETAIL";
    for (const json of [false, true]) {
      const captured = capture();
      expect(await main([
        "sync",
        "projection",
        "recover",
        session,
        "--acknowledge-gap",
        "--idempotency-key",
        idempotencyKey,
        ...(json ? ["--json"] : []),
      ], captured.output, {
        callDaemon: () => Promise.resolve({
          error: {
            code: "RECOVERY_REQUIRED",
            details: {
              nextCommand: "hra sync status --json",
              providerDetail: providerSentinel,
              providerPath: "/private/provider/projection",
            },
            message: "Projection recovery requires local status inspection.",
          },
          ok: false,
          requestId: crypto.randomUUID(),
          version: 1,
        }),
      })).toBe(7);
      const rendered = captured.read();
      expect(rendered.stdout).not.toContain(providerSentinel);
      expect(rendered.stderr).not.toContain(providerSentinel);
      expect(rendered.stdout).not.toContain("/private/provider/projection");
      expect(rendered.stderr).not.toContain("/private/provider/projection");
      if (json) {
        expect(JSON.parse(rendered.stdout)).toEqual({
          error: {
            code: "RECOVERY_REQUIRED",
            details: { nextCommand: "hra sync status --json" },
            message: "Projection recovery requires local status inspection.",
          },
          ok: false,
          version: 1,
        });
        expect(rendered.stderr).toBe("");
      } else {
        expect(rendered.stdout).toBe("");
        expect(rendered.stderr).toBe([
          "hra: Projection recovery requires local status inspection.",
          "Next: hra sync status --json",
          "",
        ].join("\n"));
      }
    }
  });

  test("drops every unrecognized projection-recovery failure detail", async () => {
    const session = `sess_${"8".repeat(32)}`;
    const idempotencyKey = "018bcfe5-6800-7000-8000-000000000702";
    const providerSentinel = "PRIVATE-PROVIDER-FAILURE-DETAIL";
    for (const details of [
      { nextCommand: "hra sync status --json; touch /tmp/unsafe", providerDetail: providerSentinel },
      { nextCommand: "hra doctor", providerDetail: providerSentinel },
      { providerDetail: providerSentinel },
    ]) {
      for (const json of [false, true]) {
        const captured = capture();
        expect(await main([
          "sync",
          "projection",
          "recover",
          session,
          "--acknowledge-gap",
          "--idempotency-key",
          idempotencyKey,
          ...(json ? ["--json"] : []),
        ], captured.output, {
          callDaemon: () => Promise.resolve({
            error: {
              code: "RECOVERY_REQUIRED",
              details,
              message: "Projection recovery requires local status inspection.",
            },
            ok: false,
            requestId: crypto.randomUUID(),
            version: 1,
          }),
        })).toBe(7);
        const rendered = captured.read();
        expect(rendered.stdout).not.toContain(providerSentinel);
        expect(rendered.stderr).not.toContain(providerSentinel);
        expect(rendered.stdout).not.toContain("touch /tmp/unsafe");
        expect(rendered.stderr).not.toContain("touch /tmp/unsafe");
        if (json) {
          const document = JSON.parse(rendered.stdout) as { error: Record<string, unknown> };
          expect(document.error).not.toHaveProperty("details");
          expect(rendered.stderr).toBe("");
        } else {
          expect(rendered.stdout).toBe("");
          expect(rendered.stderr).toBe(
            "hra: Projection recovery requires local status inspection.\n",
          );
        }
      }
    }
  });

  test("surfaces same-key replay arguments for every indeterminate local mutation without echoing its payload", async () => {
    const privatePayload = "message-private-sentinel";
    const commands = [
      ["account", "logout", "personal", "--json"],
      ["account", "switch", "personal", "--json"],
      ["session", "start", "personal", "--json"],
      ["session", "send", "session-1", privatePayload, "--json"],
      ["session", "queue", "session-1", privatePayload, "--json"],
      ["session", "steer", "session-1", privatePayload, "--json"],
      ["session", "stop", "session-1", "--json"],
      ["session", "rename", "session-1", privatePayload, "--json"],
    ] as const;

    for (const argv of commands) {
      const captured = capture();
      let generatedKey = "";
      expect(await main(argv, captured.output, {
        callDaemon: (command) => {
          generatedKey = "idempotencyKey" in command
            && typeof command.idempotencyKey === "string"
            ? command.idempotencyKey
            : "";
          throw new LocalDaemonIndeterminateError("mutation response lost");
        },
      })).toBe(7);
      expect(generatedKey).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      const rendered = JSON.parse(captured.read().stdout) as {
        error: {
          code: string;
          details: {
            idempotencyKey: string;
            replayArguments: string[];
            replayPlacement: string;
            sameKeyReplay: boolean;
          };
        };
      };
      expect(rendered).toMatchObject({
        error: {
          code: "RECOVERY_REQUIRED",
          details: {
            idempotencyKey: generatedKey,
            replayArguments: ["--idempotency-key", generatedKey],
            replayPlacement: "before_double_dash",
            sameKeyReplay: true,
          },
        },
      });
      expect(captured.read().stdout).not.toContain(privatePayload);
    }

    const human = capture();
    let humanKey = "";
    expect(await main([
      "session",
      "queue",
      "session-1",
      "--",
      privatePayload,
    ], human.output, {
      callDaemon: (command) => {
        humanKey = command.kind === "session.queue"
          && typeof command.idempotencyKey === "string"
          ? command.idempotencyKey
          : "";
        throw new LocalDaemonIndeterminateError("mutation response lost");
      },
    })).toBe(7);
    expect(human.read().stdout).toBe("");
    expect(human.read().stderr).toContain(humanKey);
    expect(human.read().stderr).toContain("before_double_dash");
    expect(human.read().stderr).not.toContain(privatePayload);
  });

  test("writes first-use Codex login secrets only to the held protected file", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "hra-cli-login-"));
    const handoff = join(root, "login.json");
    await chmod(root, 0o700);
    await writeFile(handoff, "", { flag: "wx", mode: 0o600 });
    const secretCode = "CLIX-SECRET-CODE";
    const secretUrl = "https://example.test/device?secret=cli-sentinel";
    const captured = capture();
    try {
      expect(await main([
        "account",
        "login",
        "personal",
        "--device-code",
        "--handoff-file",
        handoff,
        "--json",
      ], captured.output, {
        callDaemon: (command) => {
          if (command.kind === "account.list") {
            return Promise.resolve({
              data: {
                accounts: [{
                  id: `acct_${"1".repeat(32)}`,
                  label: "Personal",
                  processGeneration: 0,
                  state: "signed_out",
                  updatedAt: 0,
                }],
              },
              ok: true as const,
              requestId: crypto.randomUUID(),
              version: 1 as const,
            });
          }
          if (command.kind !== "account.login" || command.idempotencyKey === undefined) {
            throw new Error("Expected account login.");
          }
          expect(command.account).toBe(`acct_${"1".repeat(32)}`);
          return Promise.resolve({
            data: {
              account: {
                id: `acct_${"1".repeat(32)}`,
                label: "Personal",
                processGeneration: 1,
                state: "login_pending",
                updatedAt: 1,
              },
              idempotencyKey: command.idempotencyKey,
              login: {
                loginId: "provider-login",
                next: `hra account login-cancel acct_${"1".repeat(32)}`,
                status: "pending",
                userCode: secretCode,
                verificationUrl: secretUrl,
              },
            },
            ok: true,
            requestId: crypto.randomUUID(),
            version: 1,
          });
        },
        interactive: false,
      })).toBe(0);
      const rendered = JSON.stringify(captured.read());
      expect(rendered).not.toContain(secretCode);
      expect(rendered).not.toContain("cli-sentinel");
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        data: {
          login: {
            handoff: {
              disposition: "preserved_caller_removes_after_login",
              documentVersion: 1,
              path: handoff,
              status: "written",
            },
            status: "pending",
          },
        },
      });
      expect(JSON.parse(await readFile(handoff, "utf8"))).toMatchObject({
        type: "codex_device_login",
        userCode: secretCode,
        verificationUrl: secretUrl,
        version: 1,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("reports recovery without leaking or claiming success when the held login file is rebound", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "hra-cli-login-rebound-"));
    const handoff = join(root, "login.json");
    const moved = join(root, "held-login.json");
    await chmod(root, 0o700);
    await writeFile(handoff, "", { flag: "wx", mode: 0o600 });
    const accountId = `acct_${"1".repeat(32)}`;
    const idempotencyKey = "00000000-0000-4000-8000-000000000102";
    const secretCode = "ABCD-EFGH";
    const secretUrl = "https://example.test/device?secret=rebound";
    const captured = capture();
    try {
      expect(await main([
        "account",
        "login",
        "Personal",
        "--device-code",
        "--handoff-file",
        handoff,
        "--idempotency-key",
        idempotencyKey,
        "--json",
      ], captured.output, {
        callDaemon: async (command) => {
          if (command.kind === "account.list") {
            return {
              data: {
                accounts: [{
                  id: accountId,
                  label: "Personal",
                  processGeneration: 0,
                  state: "signed_out",
                  updatedAt: 0,
                }],
              },
              ok: true as const,
              requestId: crypto.randomUUID(),
              version: 1 as const,
            };
          }
          if (command.kind !== "account.login") throw new Error("Expected exact login dispatch.");
          await rename(handoff, moved);
          await writeFile(handoff, "", { flag: "wx", mode: 0o600 });
          return {
            data: {
              account: {
                id: accountId,
                label: "Personal",
                processGeneration: 1,
                state: "login_pending",
                updatedAt: 1,
              },
              idempotencyKey,
              login: {
                loginId: "provider-login",
                next: `hra account login-cancel ${accountId}`,
                status: "pending",
                userCode: secretCode,
                verificationUrl: secretUrl,
              },
            },
            ok: true as const,
            requestId: crypto.randomUUID(),
            version: 1 as const,
          };
        },
        interactive: false,
      })).toBe(7);
      const rendered = captured.read();
      expect(rendered.stderr).toBe("");
      expect(rendered.stdout.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(rendered.stdout)).toMatchObject({
        error: {
          code: "RECOVERY_REQUIRED",
          details: {
            cancelCommand: `hra account login-cancel ${accountId}`,
            idempotencyKey,
          },
        },
        ok: false,
      });
      expect(JSON.stringify(rendered)).not.toContain(secretCode);
      expect(JSON.stringify(rendered)).not.toContain("secret=rebound");
      expect(await readFile(handoff, "utf8")).toBe("");
      expect(await readFile(moved, "utf8")).toBe("");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("never claims or rewrites a one-time handoff on same-key replay", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "hra-cli-login-replay-"));
    const handoff = join(root, "login.json");
    await chmod(root, 0o700);
    await writeFile(handoff, "", { flag: "wx", mode: 0o600 });
    const idempotencyKey = "00000000-0000-4000-8000-000000000101";
    const captured = capture();
    try {
      expect(await main([
        "account",
        "login",
        "personal",
        "--device-code",
        "--handoff-file",
        handoff,
        "--idempotency-key",
        idempotencyKey,
        "--json",
      ], captured.output, {
        callDaemon: (command) => Promise.resolve(command.kind === "account.list"
          ? {
              data: {
                accounts: [{
                  id: `acct_${"1".repeat(32)}`,
                  label: "Personal",
                  processGeneration: 1,
                  state: "login_pending",
                  updatedAt: 1,
                }],
              },
              ok: true as const,
              requestId: crypto.randomUUID(),
              version: 1 as const,
            }
          : {
              data: {
                account: {
                  id: `acct_${"1".repeat(32)}`,
                  label: "Personal",
                  processGeneration: 1,
                  state: "login_pending",
                  updatedAt: 1,
                },
                idempotencyKey,
                login: {
                  loginId: "provider-login",
                  next: `hra account login-cancel acct_${"1".repeat(32)}`,
                  status: "pending",
                },
              },
              ok: true as const,
              requestId: crypto.randomUUID(),
              version: 1 as const,
            },
        ),
        interactive: false,
      })).toBe(0);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        data: { login: { handoff: { status: "unavailable_on_replay" } } },
      });
      expect(await readFile(handoff, "utf8")).toBe("");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("limits raw login instructions to the dedicated foreground terminal renderer", async () => {
    const captured = capture();
    const secretCode = "FOREGROUND-ONLY-CODE";
    const secretUrl = "https://example.test/device?secret=foreground-only";
    expect(await main([
      "account",
      "login",
      "personal",
      "--device-code",
    ], captured.output, {
      callDaemon: (command) => Promise.resolve(command.kind === "account.list"
        ? {
            data: {
              accounts: [{
                id: `acct_${"1".repeat(32)}`,
                label: "Personal",
                processGeneration: 0,
                state: "signed_out",
                updatedAt: 0,
              }],
            },
            ok: true as const,
            requestId: crypto.randomUUID(),
            version: 1 as const,
          }
        : {
            data: {
              account: {
                id: `acct_${"1".repeat(32)}`,
                label: "Personal",
                processGeneration: 1,
                state: "login_pending",
                updatedAt: 1,
              },
              idempotencyKey: "idempotencyKey" in command ? command.idempotencyKey : "",
              login: {
                loginId: "provider-login",
                next: `hra account login-cancel acct_${"1".repeat(32)}`,
                status: "pending",
                userCode: secretCode,
                verificationUrl: secretUrl,
              },
            },
            ok: true as const,
            requestId: crypto.randomUUID(),
            version: 1 as const,
          },
      ),
      interactive: true,
    })).toBe(0);
    expect(captured.read().stdout).not.toContain(secretCode);
    expect(captured.read().stdout).not.toContain("foreground-only");
    expect(captured.read().stderr).toContain(secretCode);
    expect(captured.read().stderr).toContain(secretUrl);
  });

  test("starts the persistent shell on no-argument interactive use and carries exact selections", async () => {
    const captured = capture();
    const lines = ["/account personal", "/session current", "hello from shell", "/exit"];
    const commands: LocalCommand[] = [];
    expect(await main([], captured.output, {
      interactive: true,
      readShellLine: () => Promise.resolve(lines.shift() ?? null),
      callDaemon: (command) => {
        commands.push(command);
        if (command.kind === "daemon.status") return Promise.resolve(runningDaemonResponse());
        if (command.kind === "account.show") {
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: { account: { id: "acct_11111111111111111111111111111111" } },
          });
        }
        if (command.kind === "session.status") {
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: {
              version: 1,
              session: {
                id: "sess_22222222222222222222222222222222",
                profileId: "acct_11111111111111111111111111111111",
              },
            },
          });
        }
        return Promise.resolve({
          ok: true,
          version: 1,
          requestId: crypto.randomUUID(),
          data: { sent: true },
        });
      },
    })).toBe(0);
    expect(commands[0]).toEqual({ kind: "daemon.status" });
    expect(commands[3]).toMatchObject({
      kind: "session.send",
      session: "sess_22222222222222222222222222222222",
      message: "hello from shell",
    });
    expect(captured.read().stderr).toContain("HRA shell");
  });

  test("rejects malformed daemon selection identities without changing the shell prompt", async () => {
    const captured = capture();
    const prompts: string[] = [];
    const lines = ["/account malformed", "/session malformed", "/exit"];
    expect(await main([], captured.output, {
      interactive: true,
      readShellLine: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve(lines.shift() ?? null);
      },
      callDaemon: (command) => {
        if (command.kind === "daemon.status") return Promise.resolve(runningDaemonResponse());
        if (command.kind === "account.show") {
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: { account: { id: `acct_${"x".repeat(4_096)}` } },
          });
        }
        if (command.kind === "session.status") {
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: {
              version: 99,
              session: {
                id: `sess_${"2".repeat(32)}`,
                profileId: `acct_${"2".repeat(32)}`,
              },
            },
          });
        }
        throw new Error(`Unexpected shell selection command: ${command.kind}`);
      },
    })).toBe(0);
    expect(prompts).toEqual(["hra> ", "hra> ", "hra> "]);
    expect(captured.read().stderr).toContain("Selected account response is invalid.");
    expect(captured.read().stderr).toContain("Selected session response is invalid.");
    expect(captured.read().stderr).not.toContain("x".repeat(128));
  });

  test("binds exact persistent-shell selectors to the exact returned identity", async () => {
    const captured = capture();
    const prompts: string[] = [];
    const requestedAccount = `acct_${"1".repeat(32)}`;
    const foreignAccount = `acct_${"2".repeat(32)}`;
    const requestedSession = `sess_${"3".repeat(32)}`;
    const foreignSession = `sess_${"4".repeat(32)}`;
    const lines = [
      `/account ${requestedAccount}`,
      `/session ${requestedSession}`,
      "/exit",
    ];
    expect(await main([], captured.output, {
      interactive: true,
      readShellLine: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve(lines.shift() ?? null);
      },
      callDaemon: (command) => {
        if (command.kind === "daemon.status") return Promise.resolve(runningDaemonResponse());
        if (command.kind === "account.show") {
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: { account: { id: foreignAccount } },
          });
        }
        if (command.kind === "session.status") {
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: {
              version: 1,
              session: { id: foreignSession, profileId: foreignAccount },
            },
          });
        }
        throw new Error(`Unexpected shell selection command: ${command.kind}`);
      },
    })).toBe(0);
    expect(prompts).toEqual(["hra> ", "hra> ", "hra> "]);
    expect(captured.read().stderr).toContain(
      "Selected account response does not match the exact requested account.",
    );
    expect(captured.read().stderr).toContain(
      "Selected session response does not match the exact requested session.",
    );
    expect(captured.read().stderr).not.toContain("Selected account acct_");
    expect(captured.read().stderr).not.toContain("Selected session sess_");
  });

  test("rejects a selected session without its authoritative account identity", async () => {
    const captured = capture();
    const prompts: string[] = [];
    const lines = ["/account personal", "/session current", "/exit"];
    expect(await main([], captured.output, {
      interactive: true,
      readShellLine: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve(lines.shift() ?? null);
      },
      callDaemon: (command) => {
        if (command.kind === "daemon.status") return Promise.resolve(runningDaemonResponse());
        if (command.kind === "account.show") {
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: { account: { id: "acct_11111111111111111111111111111111" } },
          });
        }
        if (command.kind === "session.status") {
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: { version: 1, session: { id: "sess_22222222222222222222222222222222" } },
          });
        }
        throw new Error(`Unexpected shell selection command: ${command.kind}`);
      },
    })).toBe(0);
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toBe(prompts[2]);
    expect(prompts[1]).toContain("acct_111111111111111111111");
    expect(prompts[1]).not.toContain("sess_");
    expect(captured.read().stderr).toContain("Selected session account response is invalid.");
  });

  test("starts the daemon before the first shell prompt and leaves it running on exit", async () => {
    const captured = capture();
    const commands: LocalCommand[] = [];
    let readStarted = false;
    expect(await main([], captured.output, {
      interactive: true,
      readShellLine: () => {
        readStarted = true;
        return Promise.resolve("/exit");
      },
      callDaemon: (command) => {
        expect(readStarted).toBe(false);
        commands.push(command);
        return Promise.resolve(runningDaemonResponse());
      },
    })).toBe(0);
    expect(commands).toEqual([{ kind: "daemon.status" }]);
    expect(captured.read().stderr).toContain("leaves the daemon running");
  });

  test("contains persistent-shell startup failures before opening a prompt", async () => {
    const captured = capture();
    let prompts = 0;
    expect(await main([], captured.output, {
      interactive: true,
      readShellLine: () => {
        prompts += 1;
        return Promise.resolve("/exit");
      },
      callDaemon: () => Promise.reject(new Error("foreign startup detail")),
    })).toBe(1);
    expect(prompts).toBe(0);
    expect(captured.read().stderr).toContain("could not start or continue the shell safely");
    expect(captured.read().stderr).not.toContain("foreign startup detail");
  });

  test("surfaces selected-session updates while the human prompt is waiting and drains on exit", async () => {
    const captured = capture();
    const sessionId = `sess_${"2".repeat(32)}`;
    const accountId = `acct_${"1".repeat(32)}`;
    const streamEpoch = "90000000-0000-4000-8000-000000000011";
    const turnId = `opaque_v2_${"1".repeat(64)}`;
    const itemId = `opaque_v2_${"2".repeat(64)}`;
    let releaseExit: (line: string | null) => void = () => undefined;
    const exitLine = new Promise<string | null>((resolve) => { releaseExit = resolve; });
    let readCount = 0;
    let eventReads = 0;
    const commands: LocalCommand[] = [];
    const shell = main([], captured.output, {
      interactive: true,
      readShellLine: () => {
        readCount += 1;
        return readCount === 1 ? Promise.resolve("/session current") : exitLine;
      },
      callDaemon: (command) => {
        commands.push(command);
        if (command.kind === "daemon.status") return Promise.resolve(runningDaemonResponse());
        if (command.kind === "session.status") {
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: {
              version: 2,
              session: {
                id: sessionId,
                accountId,
                projectId: null,
                title: "Current session",
                execution: "active",
                activeTurnId: turnId,
                revision: 4,
                createdAt: 1_700_000_000_000,
                updatedAt: 1_700_000_000_001,
              },
              advisory: {
                execution: "active",
                attention: "human_action_required",
                queueDepth: 0,
              },
              localObservation: {
                source: "sqlite",
                coverage: "complete",
                freshness: "fresh",
                observedAt: 1_700_000_000_001,
              },
              providerObservation: {
                source: "codex_app_server",
                basis: "provider_read",
                coverage: "complete",
                freshness: "fresh",
                observedAt: 1_700_000_000_001,
                connectionId: "90000000-0000-4000-8000-000000000099",
                mode: "resubscribed",
                profileGeneration: 1,
                state: "live",
              },
              eventStream: {
                streamEpoch,
                floorSequence: 1,
                observedThroughSequence: 0,
                cursor: cursorWire("head-0"),
                retentionFloorCursor: cursorWire("floor"),
              },
              interactions: {
                pendingCount: 1,
                responseInFlightCount: 0,
                pending: [{
                  id: "70000000-0000-4000-8000-000000000011",
                  kind: "command_approval",
                  revision: 2,
                  blocking: true,
                  summary: "Run the release verification",
                  requestedAt: 1_700_000_000_000,
                  deadlineAt: 1_700_000_030_000,
                }],
                truncated: false,
              },
              queue: {
                depth: 0,
                dispatchingCount: 0,
                ambiguousCount: 0,
                failedCount: 0,
              },
            },
          });
        }
        if (command.kind === "session.interactions") {
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: {
              sessionId,
              interactions: [{
                id: "70000000-0000-4000-8000-000000000011",
                sessionId,
                kind: "command_approval",
                state: "pending",
                revision: 2,
                blocking: true,
                display: { summary: "Run the release verification" },
              }],
              nextCursor: null,
            },
          });
        }
        if (command.kind === "session.events") {
          eventReads += 1;
          if (eventReads > 1) return new Promise<CommandResponse>(() => undefined);
          const base = {
            version: 1 as const,
            sessionId,
            streamEpoch,
            recordedAt: 1_700_000_000_000,
            accountId,
            providerGeneration: 1,
            providerConnectionId: null,
          };
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: {
              version: 1,
              sessionId,
              requestedCursor: cursorWire("head-0"),
              retentionFloorCursor: cursorWire("floor"),
              observedThroughCursor: cursorWire("head-4"),
              nextCursor: cursorWire("head-4"),
              gap: null,
              events: [
                { ...base, sequence: 1, body: { type: "item_started" as const, turnId, itemId, itemKind: "assistant" } },
                { ...base, sequence: 2, body: { type: "assistant_delta" as const, turnId, itemId, text: "release " } },
                { ...base, sequence: 3, body: { type: "assistant_delta" as const, turnId, itemId, text: "is ready" } },
                { ...base, sequence: 4, body: { type: "turn_completed" as const, turnId, status: "completed" as const } },
              ],
            },
          });
        }
        throw new Error(`Unexpected shell command: ${command.kind}`);
      },
    });

    const deadline = Date.now() + 1_000;
    while (!captured.read().stderr.includes("release is ready")) {
      if (Date.now() >= deadline) throw new Error("Live update did not arrive while the prompt was blocked.");
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(readCount).toBe(2);
    expect(captured.read().stderr).toContain("Interaction required: command approval");
    expect(captured.read().stderr.match(/Codex\n/gu)).toHaveLength(1);
    expect(captured.read().stderr).not.toContain("{\"version\"");

    releaseExit("/exit");
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100));
    expect(await Promise.race([shell.then(() => "exited" as const), timeout])).toBe("exited");
    expect(await shell).toBe(0);
    expect(commands.some((command) => command.kind === "daemon.stop")).toBe(false);
  });

  test("gives foreground watch exclusive observer output and resumes from a fresh status cut", async () => {
    const captured = capture();
    const sessionId = `sess_${"2".repeat(32)}`;
    const accountId = `acct_${"1".repeat(32)}`;
    const streamEpoch = "90000000-0000-4000-8000-000000000012";
    const marker = "foreground ownership marker";
    const postWatchInteractionMarker = "post-watch pending ownership marker";
    const turnId = `opaque_v2_${"a".repeat(64)}`;
    const itemId = `opaque_v2_${"b".repeat(64)}`;
    let statusReads = 0;
    let interactionReads = 0;
    let backgroundEventReads = 0;
    let foregroundEventReads = 0;
    let resolveBackgroundBuffered: () => void = () => undefined;
    const backgroundBuffered = new Promise<void>((resolve) => {
      resolveBackgroundBuffered = resolve;
    });
    let resolveExit: (line: string) => void = () => undefined;
    const exitLine = new Promise<string>((resolve) => { resolveExit = resolve; });
    let lineRead = 0;
    const statusData = (
      cursor: string,
      observedThroughSequence: number,
      pendingCount = 0,
    ): unknown => ({
      version: 2,
      session: {
        id: sessionId,
        accountId,
        projectId: null,
        title: "Observer ownership",
        execution: "active",
        activeTurnId: null,
        revision: 1,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_001,
      },
      advisory: {
        execution: "active",
        attention: pendingCount > 0 ? "human_action_required" : "none",
        queueDepth: 0,
      },
      localObservation: {
        source: "sqlite",
        coverage: "complete",
        freshness: "fresh",
        observedAt: 1_700_000_000_001,
      },
      providerObservation: {
        source: "codex_app_server",
        basis: "provider_read",
        state: "live",
        coverage: "complete",
        freshness: "fresh",
        profileGeneration: 1,
        observedAt: 1_700_000_000_001,
        connectionId: "90000000-0000-4000-8000-000000000099",
        mode: "resubscribed",
      },
      eventStream: {
        streamEpoch,
        floorSequence: 1,
        observedThroughSequence,
        cursor: cursorWire(cursor),
        retentionFloorCursor: cursorWire("floor"),
      },
      interactions: {
        pendingCount,
        responseInFlightCount: 0,
        pending: pendingCount === 0 ? [] : [{
          id: "70000000-0000-4000-8000-000000000019",
          kind: "user_input",
          revision: 1,
          blocking: true,
          summary: "foreground pending ownership marker",
          requestedAt: 1_700_000_000_000,
          deadlineAt: 1_700_000_030_000,
        }],
        truncated: false,
      },
      queue: { depth: 0, dispatchingCount: 0, ambiguousCount: 0, failedCount: 0 },
    });
    const event = (sequence: number, body: Record<string, unknown>) => ({
      version: 1 as const,
      sessionId,
      streamEpoch,
      sequence,
      recordedAt: 1_700_000_000_000 + sequence,
      accountId,
      providerGeneration: 1,
      providerConnectionId: null,
      body,
    });
    const page = (
      requestedCursor: string | null,
      nextCursor: string,
      events: readonly unknown[],
    ): unknown => ({
      version: 1,
      sessionId,
      requestedCursor: requestedCursor === null
        ? null
        : cursorWire(requestedCursor),
      retentionFloorCursor: cursorWire("floor"),
      observedThroughCursor: cursorWire(nextCursor),
      nextCursor: cursorWire(nextCursor),
      gap: null,
      events,
    });
    const waitUntilAbort = (signal: AbortSignal | undefined): Promise<CommandResponse> =>
      new Promise<CommandResponse>((_resolve, reject) => {
        if (signal === undefined) {
          reject(new Error("Expected cancellable event observation."));
          return;
        }
        const abort = () => reject(signal.reason ?? new Error("Observation stopped."));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });

    const shell = main([], captured.output, {
      interactive: true,
      sessionObserverSignalMode: "foreground_interrupt",
      readShellLine: async () => {
        lineRead += 1;
        if (lineRead === 1) return "/session current";
        if (lineRead === 2) {
          await backgroundBuffered;
          return "/watch";
        }
        if (lineRead === 3) return await exitLine;
        return null;
      },
      callDaemon: (command, signal) => {
        if (command.kind === "daemon.status") return Promise.resolve(runningDaemonResponse());
        if (command.kind === "session.status") {
          statusReads += 1;
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: statusReads === 1
              ? statusData("background-0", 0)
              : statusData("foreground-3", 3, 1),
          });
        }
        if (command.kind === "session.interactions") {
          interactionReads += 1;
          const foregroundInteraction = {
            id: "70000000-0000-4000-8000-000000000019",
            sessionId,
            kind: "user_input" as const,
            state: "pending" as const,
            revision: 1,
            blocking: true,
            display: { summary: "foreground pending ownership marker" },
          };
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: {
              sessionId,
              interactions: interactionReads === 1
                ? []
                : interactionReads === 2
                  ? [foregroundInteraction]
                  : [
                      foregroundInteraction,
                      {
                        ...foregroundInteraction,
                        id: "70000000-0000-4000-8000-000000000020",
                        display: { summary: postWatchInteractionMarker },
                      },
                    ],
              nextCursor: null,
            },
          });
        }
        if (command.kind !== "session.events") {
          throw new Error(`Unexpected observer ownership command: ${command.kind}`);
        }
        if (command.waitMs === 1_000) {
          backgroundEventReads += 1;
          if (backgroundEventReads === 1) {
            return Promise.resolve({
              ok: true,
              version: 1,
              requestId: crypto.randomUUID(),
              data: page("background-0", "background-2", [
                event(1, {
                  type: "item_started",
                  turnId,
                  itemId,
                  itemKind: "assistant",
                }),
                event(2, {
                  type: "assistant_delta",
                  turnId,
                  itemId,
                  text: marker,
                }),
              ]),
            });
          }
          if (backgroundEventReads === 2) resolveBackgroundBuffered();
          else resolveExit("/exit");
          return waitUntilAbort(signal);
        }
        foregroundEventReads += 1;
        if (foregroundEventReads === 1) {
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: page(null, "foreground-3", [
              event(1, {
                type: "item_started",
                turnId,
                itemId,
                itemKind: "assistant",
              }),
              event(2, {
                type: "assistant_delta",
                turnId,
                itemId,
                text: marker,
              }),
              event(3, {
                type: "turn_completed",
                turnId,
                status: "completed",
              }),
            ]),
          });
        }
        queueMicrotask(() => { process.emit("SIGINT"); });
        return waitUntilAbort(signal);
      },
    });

    expect(await shell).toBe(0);
    expect(statusReads).toBe(2);
    expect(interactionReads).toBe(3);
    expect(backgroundEventReads).toBe(3);
    expect(foregroundEventReads).toBe(2);
    expect(`${captured.read().stdout}${captured.read().stderr}`.match(
      new RegExp(marker, "gu"),
    )).toHaveLength(1);
    expect(`${captured.read().stdout}${captured.read().stderr}`.match(
      /foreground pending ownership marker/gu,
    )).toHaveLength(1);
    expect(`${captured.read().stdout}${captured.read().stderr}`.match(
      new RegExp(postWatchInteractionMarker, "gu"),
    )).toHaveLength(1);
  });

  test("cancels a persistent-shell event long poll with Ctrl-C and returns to the prompt", async () => {
    const captured = capture();
    const sessionId = `sess_${"3".repeat(32)}`;
    const lines = [`/session events ${sessionId} --wait-ms 30000`, "/exit"];
    const originalSigintListeners = process.listenerCount("SIGINT");
    let observedSignal: AbortSignal | undefined;
    let reads = 0;
    expect(await main([], captured.output, {
      interactive: true,
      sessionObserverSignalMode: "foreground_interrupt",
      readShellLine: () => {
        reads += 1;
        return Promise.resolve(lines.shift() ?? null);
      },
      callDaemon: (command, signal) => {
        if (command.kind === "daemon.status") return Promise.resolve(runningDaemonResponse());
        if (command.kind !== "session.events") {
          throw new Error(`Unexpected event cancellation command: ${command.kind}`);
        }
        observedSignal = signal;
        queueMicrotask(() => { process.emit("SIGINT"); });
        return new Promise<CommandResponse>((_resolve, reject) => {
          if (signal === undefined) {
            reject(new Error("Event long poll did not receive cancellation authority."));
            return;
          }
          const abort = () => reject(signal.reason ?? new Error("Event read canceled."));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      },
    })).toBe(0);
    expect(reads).toBe(2);
    expect(observedSignal?.aborted).toBe(true);
    expect(process.listenerCount("SIGINT")).toBe(originalSigintListeners);
    expect(captured.read().stderr).toContain("HRA shell");
    expect(captured.read().stderr).not.toContain("could not start or continue");
  });

  test("keeps event and interaction cursor signatures stable across daemon restarts", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "hra-cursor-custody-")));
    try {
      const paths = resolveStatePaths({ homeDirectory: temporary, platform: "linux" });
      await initializeStatePaths(paths);
      const custody = new GenerationalSecretCustody(
        paths,
        new FileSecretBackend(join(paths.root, "test-secret-values")),
      );
      const first = await resolveSessionEventCursorCodec(custody);
      const cursor = first.encode({
        version: 1,
        sessionId: "sess_33333333333333333333333333333333",
        streamEpoch: crypto.randomUUID(),
        sequence: 17,
      });
      const reopened = await resolveSessionEventCursorCodec(custody);
      expect(reopened.decode(cursor)).toMatchObject({ sequence: 17 });
      const interactionCursor = first.encodeInteraction({
        version: 1,
        type: "interaction",
        scope: { type: "session", sessionId: "sess_33333333333333333333333333333333" },
        pending: true,
        requestedAt: 1_700_000_000_000,
        publicId: "76000000-0000-4000-8000-000000000001",
      });
      expect(reopened.decodeInteraction(interactionCursor, {
        scope: { type: "session", sessionId: "sess_33333333333333333333333333333333" },
        pending: true,
      })).toMatchObject({ publicId: "76000000-0000-4000-8000-000000000001" });
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("refuses to replace a lost cursor key after durable event authority exists", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "hra-lost-cursor-key-")));
    try {
      const paths = resolveStatePaths({ homeDirectory: temporary, platform: "linux" });
      await initializeStatePaths(paths);
      const custody = new GenerationalSecretCustody(
        paths,
        new FileSecretBackend(join(paths.root, "test-secret-values")),
      );
      const store = new StateStore(paths, { now: () => 1_000 });
      try {
        expect(store.canInitializeDaemonCursorAuthority()).toBe(true);
        const codec = await resolveSessionEventCursorCodec(custody);
        store.configurePublicProviderIdentifierProjector(
          (value) => codec.projectPublicProviderIdentifier(value),
        );
        const profile = store.createProfile("Lost cursor key");
        const session = store.createSession({
          profileId: profile.id,
          title: "Lost cursor key",
          preset: "high",
          fastEnabled: false,
        });
        store.appendSessionEvent({
          sessionId: session.id,
          accountId: profile.id,
          providerGeneration: profile.processGeneration,
          providerConnectionId: null,
          body: { type: "turn_started", turnId: "low-entropy-turn" },
        });
        expect(store.canInitializeDaemonCursorAuthority()).toBe(false);
        const authority = await custody.read("session-cursor-key");
        if (authority === null) throw new Error("Expected cursor authority.");
        expect(await custody.clearIfGeneration(
          "session-cursor-key",
          authority.generation,
        )).toBe(true);
        await expect(resolveSessionEventCursorCodec(custody, {
          allowInitialization: store.canInitializeDaemonCursorAuthority(),
        })).rejects.toThrow("Restore the original local secret");
        expect(await custody.read("session-cursor-key")).toBeNull();
      } finally {
        store.close();
      }
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("remote commands remain explicit and offline when cloud is explicitly disabled", async () => {
    const previous = process.env.HRA_CONVEX_URL;
    process.env.HRA_CONVEX_URL = "";
    try {
      const captured = capture();
      expect(await main(["remote", "list", "--json"], captured.output)).toBe(5);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: expect.stringContaining("disabled") },
      });
      expect(captured.read().stderr).toBe("");
    } finally {
      if (previous === undefined) delete process.env.HRA_CONVEX_URL;
      else process.env.HRA_CONVEX_URL = previous;
    }
  });

  test("remote deployment configuration failures stay static and actionable", async () => {
    const previous = process.env.HRA_CONVEX_URL;
    process.env.HRA_CONVEX_URL = "not a deployment URL";
    try {
      const captured = capture();
      expect(await main(["remote", "list", "--json"], captured.output)).toBe(5);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "Cloud sync is unavailable because HRA_CONVEX_URL is invalid.",
        },
      });
      expect(captured.read().stderr).toBe("");
    } finally {
      if (previous === undefined) delete process.env.HRA_CONVEX_URL;
      else process.env.HRA_CONVEX_URL = previous;
    }
  });

  test("daemon cloud selection keeps durable projection recovery admission while transport is absent", async () => {
    const affectedSession = `sess_${"1".repeat(32)}`;
    const unrelatedSession = `sess_${"2".repeat(32)}`;
    const recovery: CloudProjectionRecoveryJournalEntry = {
      authority: { bootGeneration: 1, bootId: "boot_cli_restart_12345678", fence: 1 },
      baselineCompletedTurns: [],
      epochPublicId: "018bcfe5-6800-7000-8000-000000000891",
      expectedCompactStreamEpoch: 0,
      expectedHeadSequence: 300,
      expectedTailDigest: "a".repeat(64),
      idempotencyKey: "018bcfe5-6800-7000-8000-000000000892",
      lineageCommitment: "b".repeat(64),
      localAuthority: {
        profileGeneration: 1,
        profileId: "profile_cli_restart_12345678",
        providerUpdatedAt: 10,
        providerThreadId: "thread_cli_restart_12345678",
        sessionRevision: 1,
      },
      phase: "prepared",
      replacementCacheId: "cache_cli_replacement_12345678",
      requestDigest: "c".repeat(64),
      requestedAt: 1_700_000_000_000,
      sessionPublicId: affectedSession,
      sourceDevicePublicId: "device_cli_restart_12345678",
      sourceCacheId: "cache_cli_source_12345678",
      userPublicId: "user_cli_restart_12345678",
    };
    const journal = new MemoryCloudDaemonJournal();
    expect(await journal.compareAndSwap(null, {
      commands: [],
      pendingUsageAccount: null,
      projectionRecoveries: [recovery],
      projectionRecoveryReceipts: [],
      usageAccounts: [],
      version: 3,
    })).not.toBeNull();

    const control = selectDaemonCloudControl(
      null,
      new CloudDaemonJournalRecoveryBlocker(journal),
    );
    expect(await control.isCompactProjectionRecoveryUnsettled(affectedSession)).toBe(true);
    expect(await control.isCompactProjectionRecoveryUnsettled(unrelatedSession)).toBe(false);
    expect(() => control.recoverCompactProjection({
      acknowledgeGap: true,
      idempotencyKey: recovery.idempotencyKey,
      sessionPublicId: affectedSession,
      signal: new AbortController().signal,
    })).toThrow("not configured");
    expect(await control.isCompactProjectionRecoveryUnsettled(affectedSession)).toBe(true);
  });

  test("daemon startup reads a mismatched target's scoped journal without enabling transport", async () => {
    const raw = new MemoryCloudCustody();
    const authority = await cloudDeploymentAuthorityFromEnvironment(raw, {
      HRA_CONVEX_URL: "https://bound.convex.cloud",
    });
    if (authority === null) throw new Error("fixture authority is disabled");
    expect(authority.custodyMode).toBe("scoped");
    const deploymentCustody = new DeploymentScopedCloudSecretCustody(raw, authority);
    const unselected = await IdentityScopedCloudSecretCustody.open(deploymentCustody);
    await unselected.activateIdentity("user_cli_recovery_12345678");
    const identityCustody = await IdentityScopedCloudSecretCustody.open(deploymentCustody);
    const journal = new CustodyCloudDaemonJournal(identityCustody);
    const affectedSession = `sess_${"4".repeat(32)}`;
    expect(await journal.compareAndSwap(null, {
      commands: [],
      pendingUsageAccount: null,
      projectionRecoveries: [{
        authority: { bootGeneration: 1, bootId: "boot_cli_scoped_12345678", fence: 1 },
        baselineCompletedTurns: [],
        epochPublicId: "018bcfe5-6800-7000-8000-000000000893",
        expectedCompactStreamEpoch: 0,
        expectedHeadSequence: 400,
        expectedTailDigest: "d".repeat(64),
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000894",
        lineageCommitment: "e".repeat(64),
        localAuthority: {
          profileGeneration: 1,
          profileId: "profile_cli_scoped_12345678",
          providerUpdatedAt: 10,
          providerThreadId: "thread_cli_scoped_12345678",
          sessionRevision: 1,
        },
        phase: "prepared",
        replacementCacheId: "cache_cli_scoped_replacement_12345678",
        requestDigest: "f".repeat(64),
        requestedAt: 1_700_000_000_000,
        sessionPublicId: affectedSession,
        sourceDevicePublicId: "device_cli_scoped_12345678",
        sourceCacheId: "cache_cli_scoped_source_12345678",
        userPublicId: "user_cli_recovery_12345678",
      }],
      projectionRecoveryReceipts: [],
      usageAccounts: [],
      version: 3,
    })).not.toBeNull();
    expect(await raw.read("cloud-daemon-journal")).toBeNull();

    const startup = await resolveDaemonCloudStartup({
      environment: { HRA_CONVEX_URL: "https://requested.convex.cloud" },
      secretCustody: raw,
    });
    expect(startup.deploymentAuthority).toBeNull();
    expect(startup.diagnostic)
      .toBe("Cloud sync is unavailable because this state root is bound to another deployment.");
    expect(startup.journal).not.toBeNull();
    expect(startup.identityNamespace).toBe(identityCustody.cacheNamespace);
    expect(await startup.projectionRecoveryBlocker
      .isCompactProjectionRecoveryUnsettled(affectedSession)).toBe(true);
    expect(await startup.projectionRecoveryBlocker
      .isCompactProjectionRecoveryUnsettled(`sess_${"5".repeat(32)}`)).toBe(false);
  });

  test("daemon startup fails projection recovery admission closed for corrupt authority", async () => {
    const raw = new MemoryCloudCustody();
    expect(await raw.compareAndSwap("cloud-deployment-authority", null, "corrupt"))
      .not.toBeNull();
    const startup = await resolveDaemonCloudStartup({
      environment: { HRA_CONVEX_URL: "https://requested.convex.cloud" },
      secretCustody: raw,
    });
    expect(startup.deploymentAuthority).toBeNull();
    expect(startup.journal).toBeNull();
    expect(await startup.projectionRecoveryBlocker
      .isCompactProjectionRecoveryUnsettled(`sess_${"6".repeat(32)}`)).toBe(true);
    expect(await startup.projectionRecoveryBlocker
      .isCompactProjectionRecoveryUnsettledForProfile("profile_cli_corrupt_12345678"))
      .toBe(true);
    expect(await startup.projectionRecoveryBlocker.supersedeTerminalCompactProjectionRecoveries())
      .toEqual({ superseded: 0 });
    await expect(startup.projectionRecoveryBlocker
      .supersedeCompactProjectionRecoveryForProviderDeletion(`sess_${"6".repeat(32)}`))
      .rejects.toThrow("Cloud projection recovery custody requires recovery.");
  });

  test("daemon cloud degradation preserves recovery reads and one bounded binding diagnostic", async () => {
    const blocker = {
      isCompactProjectionRecoveryUnsettled: async () => true,
      isCompactProjectionRecoveryUnsettledForProfile: async () => false,
      supersedeCompactProjectionRecoveryForProviderDeletion: async () => ({ superseded: false }),
      supersedeTerminalCompactProjectionRecoveries: async () => ({ superseded: 0 }),
    };
    const diagnostic = "Cloud sync is unavailable until HRA_CONVEX_URL explicitly selects the legacy deployment.";
    const control = selectDaemonCloudControl(null, blocker, diagnostic);
    expect(await control.status(new AbortController().signal)).toEqual({
      configured: false,
      diagnostic,
      signedIn: false,
      unavailability: "recovery_required",
    });
    expect(await control.isCompactProjectionRecoveryUnsettled("sess_33333333"))
      .toBe(true);
    expect(() => control.auth({ email: "reader@example.com", signal: new AbortController().signal }))
      .toThrow(diagnostic);
    expect(() => control.sync(new AbortController().signal)).toThrow(diagnostic);
    expect(() => control.listDevices(new AbortController().signal)).toThrow(diagnostic);
  });

  test("marks an explicitly disabled cloud deployment as optional machine state", async () => {
    const startup = await resolveDaemonCloudStartup({
      environment: { HRA_CONVEX_URL: "" },
      secretCustody: new MemoryCloudCustody(),
    });
    expect(startup).toMatchObject({
      deploymentAuthority: null,
      diagnostic: "Cloud sync is disabled for this daemon. Unset HRA_CONVEX_URL and restart the daemon to use hosted sync.",
      reenable: { kind: "use_hosted_default" },
      unavailability: "disabled",
    });
    const control = selectDaemonCloudControl(
      null,
      startup.projectionRecoveryBlocker,
      startup.diagnostic,
      startup.unavailability,
      () => Promise.resolve({
        recoveries: [{
          cacheActivated: false,
          idempotencyKey: "018bcfe5-6800-7000-8000-000000000895",
          phase: "effect_started",
          sessionPublicId: `sess_${"7".repeat(32)}`,
        }],
        recoveriesTruncated: false,
        totalRecoveries: 1,
      }),
      startup.reenable,
    );
    expect(await control.status(new AbortController().signal)).toEqual({
      configured: false,
      diagnostic: "Cloud sync is disabled for this daemon. Unset HRA_CONVEX_URL and restart the daemon to use hosted sync.",
      projectionRecovery: {
        recoveries: [{
          cacheActivated: false,
          idempotencyKey: "018bcfe5-6800-7000-8000-000000000895",
          phase: "effect_started",
          sessionPublicId: `sess_${"7".repeat(32)}`,
        }],
        recoveriesTruncated: false,
        totalRecoveries: 1,
      },
      reenable: { kind: "use_hosted_default" },
      signedIn: false,
      unavailability: "disabled",
    });
  });

  test("preserves a self-managed binding when cloud transport is explicitly disabled", async () => {
    const raw = new MemoryCloudCustody();
    const authority = await cloudDeploymentAuthorityFromEnvironment(raw, {
      HRA_CONVEX_URL: "https://self-managed.convex.cloud",
    });
    if (authority === null) throw new Error("Expected a deployment authority fixture.");

    const startup = await resolveDaemonCloudStartup({
      environment: { HRA_CONVEX_URL: "" },
      secretCustody: raw,
    });
    expect(startup).toMatchObject({
      deploymentAuthority: null,
      diagnostic: "Cloud sync is disabled for this daemon. Restore this state root's bound HRA_CONVEX_URL deployment and restart the daemon.",
      reenable: {
        deploymentUrl: "https://self-managed.convex.cloud",
        kind: "restore_bound_deployment",
      },
      unavailability: "disabled",
    });
  });

  test("overrides disabled mode when deployment or journal custody requires recovery", async () => {
    const corruptAuthority = new MemoryCloudCustody();
    expect(await corruptAuthority.compareAndSwap("cloud-deployment-authority", null, "corrupt"))
      .not.toBeNull();
    const authorityStartup = await resolveDaemonCloudStartup({
      environment: { HRA_CONVEX_URL: "" },
      secretCustody: corruptAuthority,
    });
    expect(authorityStartup).toMatchObject({
      deploymentAuthority: null,
      diagnostic: "Cloud sync is unavailable because deployment custody requires recovery.",
      journal: null,
      unavailability: "recovery_required",
    });
    expect(authorityStartup).not.toHaveProperty("reenable");
    expect(await authorityStartup.projectionRecoveryBlocker
      .isCompactProjectionRecoveryUnsettled(`sess_${"8".repeat(32)}`)).toBe(true);

    const corruptJournal = new MemoryCloudCustody();
    const authority = await cloudDeploymentAuthorityFromEnvironment(corruptJournal, {
      HRA_CONVEX_URL: "https://self-managed.convex.cloud",
    });
    if (authority === null) throw new Error("Expected a deployment authority fixture.");
    const deploymentCustody = new DeploymentScopedCloudSecretCustody(corruptJournal, authority);
    const unselected = await IdentityScopedCloudSecretCustody.open(deploymentCustody);
    await unselected.activateIdentity("user_cli_corrupt_journal_12345678");
    const identityCustody = await IdentityScopedCloudSecretCustody.open(deploymentCustody);
    expect(await identityCustody.compareAndSwap(
      "cloud-daemon-journal",
      null,
      "corrupt",
    )).not.toBeNull();
    const journalStartup = await resolveDaemonCloudStartup({
      environment: { HRA_CONVEX_URL: "" },
      secretCustody: corruptJournal,
    });
    expect(journalStartup).toMatchObject({
      deploymentAuthority: null,
      diagnostic: "Cloud sync is unavailable because local cloud custody requires recovery.",
      journal: null,
      unavailability: "recovery_required",
    });
    expect(journalStartup).not.toHaveProperty("reenable");
    expect(await journalStartup.projectionRecoveryBlocker
      .isCompactProjectionRecoveryUnsettled(`sess_${"9".repeat(32)}`)).toBe(true);
  });

  test("remote sessions render stable human and JSON output", () => {
    const human = capture();
    renderRemoteSuccess({ kind: "remote.list", limit: 50 }, {
      sessions: [{
        compactHeadSequence: 3,
        createdAt: 1,
        executionDevicePublicId: "device_12345678",
        metadata: { name: "Release", note: null },
        publicId: "session_12345678",
        state: "idle",
        updatedAt: 2,
      }],
      truncated: false,
    }, false, human.output);
    expect(human.read()).toEqual({
      stdout: "Release  idle\n  session_12345678  device device_12345678\n",
      stderr: "",
    });

    const json = capture();
    renderRemoteSuccess({ kind: "remote.stop", session: "session_12345678" }, {
      commandPublicId: "018bcfe5-6800-7000-8000-000000000001",
      idempotencyKey: "018bcfe5-6800-7000-8000-000000000001",
      kind: "stop",
      replay: false,
      sessionPublicId: "session_12345678",
      state: "pending",
      targetDevicePublicId: "device_12345678",
    }, true, json.output);
    expect(JSON.parse(json.read().stdout)).toMatchObject({
      ok: true,
      version: 1,
      command: "remote.stop",
      data: {
        commandPublicId: "018bcfe5-6800-7000-8000-000000000001",
        targetDevicePublicId: "device_12345678",
      },
    });
    expect(json.read().stderr).toBe("");
  });

  test("remote human output escapes paired-origin terminal controls", () => {
    const attack = "\u001b]52;c;owned\u0007\u202etxt";
    const human = capture();
    renderRemoteSuccess({ kind: "remote.show", session: "session_12345678" }, {
      complete: true,
      createdAt: 1,
      events: [
        { kind: "assistant_message", sequence: 1, text: attack, turnId: "turn_12345678" },
        {
          blocking: true,
          interactionId: "70000000-0000-4000-8000-000000000001",
          interactionKind: "permission_approval",
          kind: "interaction_state",
          revision: 3,
          sequence: 2,
          state: "pending",
          summary: `Review ${attack}`,
        },
        {
          filesTouched: [`src/${attack}.ts`],
          gitActions: [{ kind: "status", label: attack }],
          kind: "turn_summary",
          runtimeMs: 1,
          sequence: 3,
          turnId: "turn_12345678",
        },
      ],
      executionDevicePublicId: "device_12345678",
      metadata: { name: attack, note: null },
      publicId: "session_12345678",
      state: "idle",
      updatedAt: 2,
    }, false, human.output);
    const rendered = human.read().stdout;
    expect(rendered).not.toContain("\u001b");
    expect(rendered).not.toContain("\u0007");
    expect(rendered).not.toContain("\u202e");
    expect(rendered).toContain("\\u{001b}");
    expect(rendered).toContain("\\u{0007}");
    expect(rendered).toContain("\\u{202e}");
    expect(rendered).toContain("Interaction 70000000-0000-4000-8000-000000000001  permission approval");
    expect(rendered).toContain("pending  revision 3  blocking");
    expect(rendered).toContain("Resolve on the execution device. Remote interaction responses are not enabled.");
  });

  test("remote human output reduces recovered interactions to the safest latest revision", () => {
    const interactionId = "70000000-0000-4000-8000-000000000099";
    const data = {
      compactHasRecoveryGap: true,
      compactHeadSequence: 4,
      compactStreamEpoch: 4,
      complete: true,
      createdAt: 1,
      events: [
        {
          blocking: true,
          interactionId,
          interactionKind: "command_approval" as const,
          kind: "interaction_state" as const,
          revision: 1,
          sequence: 1,
          state: "pending" as const,
          summary: "Interaction state updated",
        },
        {
          blocking: true,
          interactionId,
          interactionKind: "command_approval" as const,
          kind: "interaction_state" as const,
          revision: 2,
          sequence: 2,
          state: "expired" as const,
          summary: "Interaction state updated",
        },
        {
          blocking: true,
          interactionId,
          interactionKind: "command_approval" as const,
          kind: "interaction_state" as const,
          revision: 2,
          sequence: 3,
          state: "pending" as const,
          summary: "Conflicting stale recovery row",
        },
        {
          blocking: true,
          interactionId: "70000000-0000-4000-8000-000000000100",
          interactionKind: "user_input" as const,
          kind: "interaction_state" as const,
          revision: 1,
          sequence: 4,
          state: "pending" as const,
          summary: "Pre-baseline pending state",
        },
      ],
      executionDevicePublicId: "device_12345678",
      metadata: { name: "Recovered", note: null },
      publicId: "session_12345678",
      recoveryGap: { kind: "projection_cache_recovery" as const, streamEpoch: 4 },
      state: "idle" as const,
      updatedAt: 2,
    };
    const human = capture();
    renderRemoteSuccess({ kind: "remote.show", session: "session_12345678" }, data, false, human.output);
    const rendered = human.read().stdout;
    expect(rendered).toContain("Recovery gap: compact projection cache recovery at stream epoch 4.");
    expect(rendered.match(new RegExp(interactionId, "gu"))).toHaveLength(1);
    expect(rendered).toContain("expired  revision 2");
    expect(rendered).not.toContain("Resolve on the execution device");
    expect(rendered).toContain("Interaction action guidance is suppressed while remote recovery settles.");

    const json = capture();
    renderRemoteSuccess({ kind: "remote.show", session: "session_12345678" }, data, true, json.output);
    const payload = JSON.parse(json.read().stdout) as { data: { events: unknown[] } };
    expect(payload.data.events).toHaveLength(4);
  });

  test("stopping an absent daemon does not initialize or autostart it", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hra-stop-"));
    const stateRoot = join(temporary, "Library", "Application Support", "HRA");
    const previousHome = process.env.HOME;
    process.env.HOME = temporary;
    try {
      const captured = capture();
      expect(await main(["daemon", "stop", "--json"], captured.output)).toBe(0);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        ok: true,
        data: { stopping: false, running: false },
      });
      await expect(lstat(stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("builds the exact detached daemon spawn descriptor inside the private state root", () => {
    expect(daemonRunProcessArguments("/opt/hra/bun", "/opt/hra/src/cli.ts")).toEqual([
      "/opt/hra/bun",
      "--no-env-file",
      "/opt/hra/src/cli.ts",
      "daemon",
      "run",
    ]);
    expect(daemonRunProcessOptions("/var/lib/hra-control-plane-v1")).toEqual({
      cwd: "/var/lib/hra-control-plane-v1",
      detached: true,
      env: process.env,
      stderr: "ignore",
      stdin: "ignore",
      stdout: "ignore",
    });
  });

  test("daemon start renders the starter's verified identity without a second status request", async () => {
    const runId = "018f1f55-3f10-7c1a-8f7b-c6dc608bcd4d";
    const runRoot = await realpath(
      await mkdtemp(join(tmpdir(), `hra-live-acceptance-${runId}-`)),
    );
    const installation = createAcceptanceInstallation({
      device: "a",
      documentsDirectory: join(runRoot, "project-a-daemon-start"),
      expectedHomeDirectory: process.env.HOME ?? "/missing-home",
      rootDirectory: join(runRoot, "device-a-daemon-start"),
      runId,
      type: "hra-live-acceptance-device",
      version: 1,
    });
    let daemonStarts = 0;
    const input = {
      installation,
      startDaemon: async () => {
        daemonStarts += 1;
        return readyDaemonStatus();
      },
    };
    try {
      const initialized = capture();
      expect(await main(["init", "--yes", "--json"], initialized.output, input)).toBe(0);

      const started = capture();
      expect(await main(["daemon", "start", "--json"], started.output, input)).toBe(0);
      expect(JSON.parse(started.read().stdout)).toEqual({
        command: "daemon.status",
        data: readyDaemonStatus(),
        ok: true,
        version: 1,
      });
      expect(started.read().stderr).toBe("");
      expect(daemonStarts).toBe(1);
    } finally {
      await rm(runRoot, { force: true, recursive: true });
    }
  });

  test("pre-initialization commands require init without creating daemon state", async () => {
    const runId = "018f1f55-3f10-7c1a-8f7b-c6dc608bcd4c";
    const runRoot = await realpath(
      await mkdtemp(join(tmpdir(), `hra-live-acceptance-${runId}-`)),
    );
    const installation = createAcceptanceInstallation({
      device: "a",
      documentsDirectory: join(runRoot, "project-a-first-run"),
      expectedHomeDirectory: process.env.HOME ?? "/missing-home",
      rootDirectory: join(runRoot, "device-a-first-run"),
      runId,
      type: "hra-live-acceptance-device",
      version: 1,
    });
    let daemonStarts = 0;
    const input = {
      installation,
      startDaemon: async () => {
        daemonStarts += 1;
        return readyDaemonStatus();
      },
    };
    try {
      for (const argv of [
        ["account", "add", "Personal", "--json"],
        ["doctor", "--json"],
        ["project", "list", "--json"],
        ["daemon", "start", "--json"],
      ] as const) {
        const captured = capture();
        expect(await main(argv, captured.output, input)).toBe(6);
        expect(JSON.parse(captured.read().stdout)).toEqual({
          error: {
            code: "INTERACTION_REQUIRED",
            details: { nextCommand: "hra init --yes" },
            message: "Initialize HRA before starting its daemon.",
          },
          ok: false,
          version: 1,
        });
        expect(captured.read().stderr).toBe("");
        expect(daemonStarts).toBe(0);
        await expect(lstat(installation.paths.database)).rejects.toMatchObject({ code: "ENOENT" });
      }

      const status = capture();
      expect(await main(["status", "--json"], status.output, input)).toBe(6);
      expect(JSON.parse(status.read().stdout)).toEqual({
        error: {
          code: "INTERACTION_REQUIRED",
          details: { nextCommand: "hra init --yes" },
          message: "Initialize HRA before reading local status.",
        },
        ok: false,
        version: 1,
      });
      expect(status.read().stderr).toBe("");
      expect(daemonStarts).toBe(0);
      await expect(lstat(installation.paths.database)).rejects.toMatchObject({ code: "ENOENT" });

      const initialized = capture();
      expect(await main(["init", "--yes", "--json"], initialized.output, input)).toBe(0);
      expect(JSON.parse(initialized.read().stdout)).toMatchObject({
        data: { defaultProjectCreated: true, initialized: true },
        ok: true,
        version: 1,
      });
      expect((await lstat(installation.paths.database)).isFile()).toBe(true);
    } finally {
      await rm(runRoot, { force: true, recursive: true });
    }
  });

  test("stops only after the acknowledged authority is exactly released and gives the request a bounded five-second response window", async () => {
    const captured = capture();
    let deadlineMs = 0;
    let requestedAuthority: unknown;
    const dependencies = exactStopDependencies({
      requestStop: (input) => {
        deadlineMs = input.deadlineMs;
        requestedAuthority = input.command.expected;
        return Promise.resolve(acknowledgedDaemonStopResponse());
      },
    });

    expect(await main(["daemon", "stop", "--json"], captured.output, {
      daemonStopDependencies: dependencies,
    })).toBe(0);
    expect(deadlineMs).toBe(5_000);
    expect(requestedAuthority).toEqual(stopDaemonIdentity);
    expect(JSON.parse(captured.read().stdout)).toMatchObject({
      ok: true,
      data: {
        stopping: false,
        running: false,
        daemon: stopDaemonIdentity,
        released: true,
      },
    });
    expect(captured.read().stdout).not.toContain('"reconciled"');
    expect(captured.read().stderr).toBe("");
  });

  test("reconciles an indeterminate stop response only against its captured pre-stop authority", async () => {
    const captured = capture();
    expect(await main(["daemon", "stop", "--json"], captured.output, {
      daemonStopDependencies: exactStopDependencies({
        requestStop: () => Promise.reject(new LocalDaemonIndeterminateError("response lost")),
      }),
    })).toBe(0);
    expect(JSON.parse(captured.read().stdout)).toMatchObject({
      ok: true,
      data: {
        stopping: false,
        running: false,
        daemon: stopDaemonIdentity,
        released: true,
        reconciled: true,
      },
    });
    expect(captured.read().stderr).toBe("");
  });

  test("treats a malformed successful stop response as indeterminate and reconciles exact authority", async () => {
    const malformed: CommandResponse = {
      data: { daemon: { pid: "invalid" }, running: true, stopping: true },
      ok: true,
      requestId: crypto.randomUUID(),
      version: 1,
    };
    const released = capture();
    expect(await main(["daemon", "stop", "--json"], released.output, {
      daemonStopDependencies: exactStopDependencies({
        requestStop: () => Promise.resolve(malformed),
      }),
    })).toBe(0);
    expect(JSON.parse(released.read().stdout)).toMatchObject({
      data: {
        daemon: stopDaemonIdentity,
        reconciled: true,
        released: true,
        running: false,
        stopping: false,
      },
      ok: true,
    });

    const held = capture();
    expect(await main(["daemon", "stop", "--json"], held.output, {
      daemonStopDependencies: exactStopDependencies({
        requestStop: () => Promise.resolve(malformed),
        waitForRelease: () => Promise.resolve({
          finalReceipt: daemonAuthorityReceipt("ready"),
          replacement: null,
        }),
      }),
    })).toBe(7);
    expect(JSON.parse(held.read().stdout)).toMatchObject({
      error: {
        code: "RECOVERY_REQUIRED",
        details: { nextCommand: "hra daemon status --json" },
      },
      ok: false,
    });
    expect(held.read().stdout).not.toContain('"released":true');
  });

  test("reconciles one generic release-observation error through the exact terminal publication window", async () => {
    const captured = capture();
    const receipts = [
      daemonAuthorityReceipt("ready"),
      daemonAuthorityReceipt("stopped"),
      daemonAuthorityReceipt("stopped"),
    ];
    const sleeps: number[] = [];
    expect(await main(["daemon", "stop", "--json"], captured.output, {
      daemonStopDependencies: exactStopDependencies({
        observeReceipt: () => Promise.resolve(receipts.shift() ?? null),
        waitForRelease: () => Promise.reject(new Error("transient release observation")),
        authorityHeld: () => Promise.resolve(false),
        sleep: (milliseconds) => {
          sleeps.push(milliseconds);
          return Promise.resolve();
        },
      }),
    })).toBe(0);
    expect(sleeps).toEqual([25]);
    expect(receipts).toHaveLength(0);
    expect(JSON.parse(captured.read().stdout)).toMatchObject({
      ok: true,
      data: {
        running: false,
        released: true,
        reconciled: true,
      },
    });
  });

  test("does not reconcile a generic observation error while the exact stopped authority remains held", async () => {
    const captured = capture();
    const receipts = [
      daemonAuthorityReceipt("ready"),
      daemonAuthorityReceipt("stopped"),
      daemonAuthorityReceipt("stopped"),
    ];
    expect(await main(["daemon", "stop", "--json"], captured.output, {
      daemonStopDependencies: exactStopDependencies({
        observeReceipt: () => Promise.resolve(receipts.shift() ?? null),
        waitForRelease: () => Promise.reject(new Error("transient release observation")),
        authorityHeld: () => Promise.resolve(true),
      }),
    })).toBe(7);
    expect(JSON.parse(captured.read().stdout)).toMatchObject({
      ok: false,
      error: {
        code: "RECOVERY_REQUIRED",
        details: { nextCommand: "hra daemon status --json" },
      },
    });
    expect(captured.read().stdout).not.toContain('"released":true');
  });

  test("turns daemon-authority safety errors into an actionable closed recovery", async () => {
    const safety = new DaemonAuthoritySafetyError("unsafe authority fixture");
    let observations = 0;
    const paths = resolveStatePaths({ rootDirectory: join(tmpdir(), "hra-unused-stop-safety") });
    await expect(stopDaemonWithExactAuthority(paths, exactStopDependencies({
      observeReceipt: () => {
        observations += 1;
        return Promise.reject(safety);
      },
    }))).resolves.toMatchObject({
      kind: "failure",
      error: {
        code: "RECOVERY_REQUIRED",
        details: { nextCommand: "hra doctor --offline" },
      },
    });
    expect(observations).toBe(1);
  });

  test("turns an invalid daemon-authority database into an actionable closed recovery", async () => {
    const invalid = new Error("The daemon authority database is invalid and requires manual recovery.");
    let observations = 0;
    const paths = resolveStatePaths({ rootDirectory: join(tmpdir(), "hra-unused-stop-invalid") });
    await expect(stopDaemonWithExactAuthority(paths, exactStopDependencies({
      observeReceipt: () => {
        observations += 1;
        return Promise.reject(invalid);
      },
    }))).resolves.toMatchObject({
      kind: "failure",
      error: {
        code: "RECOVERY_REQUIRED",
        details: { nextCommand: "hra doctor --offline" },
      },
    });
    expect(observations).toBe(1);
  });

  test("rejects a replacement before registering any daemon stop callback", () => {
    let callbacks = 0;
    const replacement = {
      ...stopDaemonIdentity,
      pid: 456,
      nonce: "018bcfe5-6800-7000-8000-000000000799",
      generation: 2,
      bootId: `boot_${"f".repeat(32)}`,
    };
    expect(() => admitExactDaemonStop({
      command: { kind: "daemon.stop", expected: stopDaemonIdentity },
      receipt: daemonAuthorityReceipt("ready", replacement),
      afterResponse: () => { callbacks += 1; },
      requestStop: () => { callbacks += 100; },
    })).toThrow("No daemon was stopped");
    expect(callbacks).toBe(0);
  });

  test("treats a released maintenance receipt with no runtime generation as already stopped", async () => {
    const maintenanceReceipt: DaemonAuthorityReceipt = {
      version: 2,
      protocol: DAEMON_PROTOCOL,
      pid: 123,
      nonce: "018bcfe5-6800-7000-8000-000000000798",
      state: "stopped",
      acquiredAt: 1,
      updatedAt: 2,
    };
    let requests = 0;
    const paths = resolveStatePaths({ rootDirectory: join(tmpdir(), "hra-unused-maintenance-stop") });
    await expect(stopDaemonWithExactAuthority(paths, exactStopDependencies({
      observeReceipt: () => Promise.resolve(maintenanceReceipt),
      inspectAuthority: () => Promise.resolve({
        state: "released",
        database: { authority: "released", custody: "safe" },
        receipt: { custody: "safe", state: "stopped" },
      }),
      authorityHeld: () => Promise.resolve(false),
      requestStop: () => {
        requests += 1;
        return Promise.resolve(acknowledgedDaemonStopResponse());
      },
    }))).resolves.toEqual({
      kind: "success",
      data: { stopping: false, running: false, released: false },
    });
    expect(requests).toBe(0);
  });

  test("requires database-backed release proof before calling a terminal or malformed receipt stopped", async () => {
    const paths = resolveStatePaths({ rootDirectory: join(tmpdir(), "hra-unused-terminal-stop-proof") });
    const absentDatabaseWithStoppedReceipt = exactStopDependencies({
      observeReceipt: () => Promise.resolve(daemonAuthorityReceipt("stopped")),
      inspectAuthority: () => Promise.resolve({
        state: "indeterminate",
        database: { custody: "absent" },
        receipt: { custody: "safe", state: "stopped" },
      }),
    });
    await expect(stopDaemonWithExactAuthority(
      paths,
      absentDatabaseWithStoppedReceipt,
    )).resolves.toMatchObject({
      error: { code: "RECOVERY_REQUIRED" },
      kind: "failure",
    });

    const absentDatabaseWithMalformedReceipt = exactStopDependencies({
      observeReceipt: () => Promise.resolve(null),
      inspectAuthority: () => Promise.resolve({
        state: "indeterminate",
        database: { custody: "absent" },
        receipt: { custody: "invalid" },
      }),
    });
    await expect(stopDaemonWithExactAuthority(
      paths,
      absentDatabaseWithMalformedReceipt,
    )).resolves.toMatchObject({
      error: { code: "RECOVERY_REQUIRED" },
      kind: "failure",
    });

    let requests = 0;
    const safeReleasedTerminal = exactStopDependencies({
      observeReceipt: () => Promise.resolve(daemonAuthorityReceipt("stopped")),
      inspectAuthority: () => Promise.resolve({
        state: "released",
        database: { authority: "released", custody: "safe" },
        receipt: { custody: "safe", state: "stopped" },
      }),
      requestStop: () => {
        requests += 1;
        return Promise.resolve(acknowledgedDaemonStopResponse());
      },
    });
    await expect(stopDaemonWithExactAuthority(paths, safeReleasedTerminal)).resolves.toEqual({
      data: { released: false, running: false, stopping: false },
      kind: "success",
    });
    expect(requests).toBe(0);
  });

  test("treats safely released stale receipt evidence as already stopped without hiding it from doctor", async () => {
    for (const receiptKind of ["live", "malformed"] as const) {
      const temporary = await realpath(await mkdtemp(join(tmpdir(), `hra-stop-stale-${receiptKind}-`)));
      const statePaths = resolveStatePaths({ homeDirectory: temporary, platform: process.platform });
      try {
        await initializeStatePaths(statePaths);
        const authority = await DaemonLock.acquire(statePaths, { state: "maintenance" });
        await authority.publish({
          bootId: `boot_${"7".repeat(32)}`,
          generation: 1,
          state: "ready",
        });
        await authority.release();
        const terminal = await readDaemonAuthorityReceipt(statePaths);
        if (terminal === null) throw new Error("Expected a terminal daemon receipt fixture.");
        await writeFile(
          statePaths.daemonLock,
          receiptKind === "live"
            ? `${JSON.stringify({ ...terminal, failure: undefined, state: "ready" })}\n`
            : "malformed receipt\n",
          { encoding: "utf8", mode: 0o600 },
        );

        const stopped = capture();
        expect(await main(["daemon", "stop", "--json"], stopped.output, { statePaths })).toBe(0);
        expect(JSON.parse(stopped.read().stdout)).toMatchObject({
          data: { released: false, running: false, stopping: false },
          ok: true,
        });
        expect(stopped.read().stdout).not.toContain("reconciled");

        const doctor = capture();
        expect(await main(["doctor", "--offline", "--json"], doctor.output, { statePaths })).toBe(0);
        expect(JSON.parse(doctor.read().stdout)).toMatchObject({
          data: {
            healthy: true,
            state: { daemonAuthority: { state: "stale_recoverable" } },
          },
          ok: true,
        });
      } finally {
        await rm(temporary, { force: true, recursive: true });
      }
    }
  });

  test("fails closed when the stop response acknowledges a replacement of the pre-observed live authority", async () => {
    const captured = capture();
    let releaseWaits = 0;
    const replacement = {
      ...stopDaemonIdentity,
      pid: 456,
      nonce: "018bcfe5-6800-7000-8000-000000000701",
      generation: 2,
      bootId: `boot_${"b".repeat(32)}`,
    };
    expect(await main(["daemon", "stop", "--json"], captured.output, {
      daemonStopDependencies: exactStopDependencies({
        requestStop: () => Promise.resolve({
          ...acknowledgedDaemonStopResponse(),
          data: { stopping: true, running: true, daemon: replacement },
        }),
        waitForRelease: () => {
          releaseWaits += 1;
          return Promise.resolve({ replacement: null, finalReceipt: daemonAuthorityReceipt("stopped") });
        },
      }),
    })).toBe(7);
    expect(releaseWaits).toBe(0);
    expect(JSON.parse(captured.read().stdout)).toMatchObject({
      ok: false,
      error: { code: "RECOVERY_REQUIRED" },
    });
    expect(captured.read().stdout).not.toContain('"released":true');
  });

  test("fails closed when a replacement authority appears during release observation", async () => {
    const captured = capture();
    const replacement = {
      ...stopDaemonIdentity,
      pid: 456,
      nonce: "018bcfe5-6800-7000-8000-000000000702",
      generation: 2,
      bootId: `boot_${"c".repeat(32)}`,
    };
    expect(await main(["daemon", "stop", "--json"], captured.output, {
      daemonStopDependencies: exactStopDependencies({
        waitForRelease: () => Promise.resolve({
          replacement,
          finalReceipt: daemonAuthorityReceipt("ready", replacement),
        }),
      }),
    })).toBe(7);
    expect(JSON.parse(captured.read().stdout)).toMatchObject({
      ok: false,
      error: { code: "RECOVERY_REQUIRED" },
    });
    expect(captured.read().stdout).not.toContain('"released":true');
  });

  test("fails closed when the exact daemon releases a failed receipt", async () => {
    const captured = capture();
    expect(await main(["daemon", "stop", "--json"], captured.output, {
      daemonStopDependencies: exactStopDependencies({
        waitForRelease: () => Promise.resolve({
          replacement: null,
          finalReceipt: daemonAuthorityReceipt("failed"),
        }),
      }),
    })).toBe(7);
    expect(JSON.parse(captured.read().stdout)).toMatchObject({
      ok: false,
      error: {
        code: "RECOVERY_REQUIRED",
        details: { nextCommand: "hra doctor --offline" },
      },
    });
    expect(captured.read().stdout).not.toContain("bounded shutdown failure");
    expect(captured.read().stdout).not.toContain('"released":true');
  });

  test("reports a failed terminal publication only after its exact authority is released", async () => {
    const captured = capture();
    const receipts = [
      daemonAuthorityReceipt("ready"),
      daemonAuthorityReceipt("failed"),
      daemonAuthorityReceipt("failed"),
    ];
    const sleeps: number[] = [];
    expect(await main(["daemon", "stop", "--json"], captured.output, {
      daemonStopDependencies: exactStopDependencies({
        observeReceipt: () => Promise.resolve(receipts.shift() ?? null),
        waitForRelease: () => Promise.reject(new Error("transient failed-release observation")),
        authorityHeld: () => Promise.resolve(false),
        sleep: (milliseconds) => {
          sleeps.push(milliseconds);
          return Promise.resolve();
        },
      }),
    })).toBe(7);
    expect(sleeps).toEqual([25]);
    expect(receipts).toHaveLength(0);
    expect(JSON.parse(captured.read().stdout)).toMatchObject({
      ok: false,
      error: {
        code: "RECOVERY_REQUIRED",
        details: { nextCommand: "hra doctor --offline" },
      },
    });
  });

  test("accepts pre-dispatch unavailability only after the captured authority is exactly released", async () => {
    const captured = capture();
    expect(await main(["daemon", "stop", "--json"], captured.output, {
      daemonStopDependencies: exactStopDependencies({
        requestStop: () => Promise.reject(new LocalDaemonUnavailableError("endpoint disappeared")),
      }),
    })).toBe(0);
    expect(JSON.parse(captured.read().stdout)).toMatchObject({
      ok: true,
      data: {
        daemon: stopDaemonIdentity,
        running: false,
        released: true,
        reconciled: true,
      },
    });
  });

  test("init without explicit acceptance reports the next command without creating state", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "hra-init-confirm-")));
    const paths = resolveStatePaths({ homeDirectory: temporary, platform: process.platform });
    const previousHome = process.env.HOME;
    process.env.HOME = temporary;
    try {
      const captured = capture();
      expect(await main(["init", "--json"], captured.output)).toBe(6);
      expect(captured.read().stderr).toBe("");
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        ok: false,
        error: {
          code: "INTERACTION_REQUIRED",
          message: "Confirm the default Documents project with `hra init --yes`.",
        },
      });
      await expect(lstat(paths.root)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("init creates a missing default Documents directory before committing local state", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "hra-init-empty-home-")));
    const paths = resolveStatePaths({ homeDirectory: temporary, platform: process.platform });
    const documents = join(temporary, "Documents");
    try {
      const captured = capture();
      expect(await initialize(true, true, captured.output, { paths, documentsDirectory: documents })).toBe(0);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        ok: true,
        data: {
          defaultProjectCreated: true,
          initialized: true,
        },
      });
      const documentsMetadata = await lstat(documents);
      expect(documentsMetadata.isDirectory()).toBe(true);
      expect(documentsMetadata.isSymbolicLink()).toBe(false);
      const store = new StateStore(paths, { readonly: true });
      try {
        expect(store.listProjects()).toHaveLength(1);
        expect(store.listProjects()[0]?.rootPath).toBe(documents);
      } finally {
        store.close();
      }
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("init escapes terminal-format scalars in its JSON state-root value", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "hra-init-json-control-")));
    const paths = resolveStatePaths({ rootDirectory: join(temporary, "state-\u202e-private") });
    const documents = join(temporary, "Documents");
    try {
      const captured = capture();
      expect(await initialize(true, true, captured.output, { paths, documentsDirectory: documents })).toBe(0);
      expect(captured.read().stdout).toContain("\\u202e");
      expect(captured.read().stdout).not.toContain("\u202e");
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        data: { stateRoot: paths.root },
        ok: true,
      });
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("project add rejects missing or unusable paths locally with actionable output", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "hra-project-add-path-")));
    const missing = join(temporary, "missing-private-project");
    const regularFile = join(temporary, "not-a-directory-private-project");
    await writeFile(regularFile, "not a project directory", { mode: 0o600 });
    let daemonCalls = 0;
    const callDaemon = (): Promise<never> => {
      daemonCalls += 1;
      return Promise.reject(new Error("Project validation must not call the daemon."));
    };
    try {
      const json = capture();
      expect(await main([
        "project",
        "add",
        missing,
        "--name",
        "Missing",
        "--json",
      ], json.output, { callDaemon })).toBe(2);
      expect(JSON.parse(json.read().stdout)).toMatchObject({
        error: {
          code: "INVALID_INPUT",
          message: "The project directory does not exist or is not readable, writable, traversable, and canonical. Restore access or choose another directory, then retry.",
        },
        ok: false,
      });
      expect(json.read().stderr).toBe("");

      const human = capture();
      expect(await main([
        "project",
        "add",
        regularFile,
        "--name",
        "Invalid",
      ], human.output, { callDaemon })).toBe(2);
      expect(human.read().stdout).toBe("");
      expect(human.read().stderr).toContain("Restore access or choose another directory, then retry.");
      expect(daemonCalls).toBe(0);
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("init rejects an unsafe default Documents path before creating the database", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "hra-init-unsafe-documents-")));
    const paths = resolveStatePaths({ homeDirectory: temporary, platform: process.platform });
    const documents = join(temporary, "Documents");
    await writeFile(documents, "not a directory", { encoding: "utf8", mode: 0o600 });
    try {
      const captured = capture();
      expect(await initialize(true, true, captured.output, { paths, documentsDirectory: documents })).toBe(5);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "The default Documents project is not a readable, writable, and traversable canonical directory. Repair it, then run `hra init --yes` again.",
        },
      });
      await expect(lstat(paths.database)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("init rejects a non-traversable default directory before creating the database", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "hra-init-nontraversable-")));
    const paths = resolveStatePaths({ homeDirectory: temporary, platform: process.platform });
    const documents = join(temporary, "Documents");
    await mkdir(documents, { mode: 0o600 });
    try {
      const captured = capture();
      expect(await initialize(true, true, captured.output, { paths, documentsDirectory: documents })).toBe(5);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "The default Documents project is not a readable, writable, and traversable canonical directory. Repair it, then run `hra init --yes` again.",
        },
      });
      await expect(lstat(paths.database)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await chmod(documents, 0o700);
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("repeated init leaves unrelated default paths untouched after initialization", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "hra-init-idempotent-")));
    const paths = resolveStatePaths({ homeDirectory: temporary, platform: process.platform });
    const documents = join(temporary, "Documents");
    const absent = join(temporary, "Absent Documents");
    const unsafe = join(temporary, "Unsafe Documents");
    try {
      expect(await initialize(true, true, capture().output, { paths, documentsDirectory: documents })).toBe(0);

      const absentCapture = capture();
      expect(await initialize(true, true, absentCapture.output, { paths, documentsDirectory: absent })).toBe(0);
      expect(JSON.parse(absentCapture.read().stdout)).toMatchObject({
        ok: true,
        data: { defaultProjectCreated: false, initialized: true },
      });
      await expect(lstat(absent)).rejects.toMatchObject({ code: "ENOENT" });

      await writeFile(unsafe, "not a directory", { encoding: "utf8", mode: 0o600 });
      const unsafeCapture = capture();
      expect(await initialize(true, true, unsafeCapture.output, { paths, documentsDirectory: unsafe })).toBe(0);
      expect(JSON.parse(unsafeCapture.read().stdout)).toMatchObject({
        ok: true,
        data: { defaultProjectCreated: false, initialized: true },
      });
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("offline doctor reports a projectless database as incomplete initialization", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "hra-doctor-projectless-")));
    const paths = resolveStatePaths({ homeDirectory: temporary, platform: process.platform });
    try {
      await initializeStatePaths(paths);
      const store = new StateStore(paths);
      store.close();
      const captured = capture();
      expect(await main(["doctor", "--offline", "--json"], captured.output, { statePaths: paths })).toBe(1);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        ok: true,
        data: {
          healthy: false,
          problems: ["No project directory is configured. Run `hra init --yes`."],
          state: {
            database: "ready",
            initialized: false,
            projectCount: 0,
          },
        },
      });
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("offline doctor separates unusable project roots from a healthy database", async () => {
    const problem = "A configured project directory is missing or unsafe. Run `hra project list`, then restore or repair every listed directory so it is readable, writable, traversable, and canonical.";
    for (const scenario of ["missing", "symlink", "non_traversable"] as const) {
      const temporary = await realpath(await mkdtemp(join(tmpdir(), `hra-doctor-project-${scenario}-`)));
      const paths = resolveStatePaths({ homeDirectory: temporary, platform: process.platform });
      const documents = join(temporary, "Documents");
      try {
        expect(await initialize(true, true, capture().output, { paths, documentsDirectory: documents })).toBe(0);
        if (scenario === "missing") {
          await rename(documents, join(temporary, "Documents moved"));
        } else if (scenario === "symlink") {
          const target = join(temporary, "Documents target");
          await rename(documents, target);
          await symlink(target, documents);
        } else {
          await chmod(documents, 0o600);
        }

        const captured = capture();
        expect(await main(["doctor", "--offline", "--json"], captured.output, { statePaths: paths })).toBe(1);
        expect(JSON.parse(captured.read().stdout)).toMatchObject({
          ok: true,
          data: {
            healthy: false,
            problems: [problem],
            state: {
              database: "ready",
              initialized: true,
              projectCount: 1,
            },
          },
        });
      } finally {
        if (scenario === "non_traversable") await chmod(documents, 0o700).catch(() => undefined);
        await rm(temporary, { force: true, recursive: true });
      }
    }
  });

  test("online doctor preserves one success envelope while its exit code follows validated health", async () => {
    for (const entry of [
      { data: { healthy: true, problems: [] }, exitCode: 0 },
      { data: { healthy: false, problems: ["Cloud projection recovery is unsettled."] }, exitCode: 1 },
      { data: { healthy: "yes", problems: [] }, exitCode: 1 },
      { data: { healthy: true, problems: ["Cloud status is inconsistent."] }, exitCode: 1 },
      { data: { healthy: true, problems: "none" }, exitCode: 1 },
      { data: { healthy: true, problems: [1] }, exitCode: 1 },
    ] as const) {
      const captured = capture();
      expect(await main(["doctor", "--json"], captured.output, {
        callDaemon: (command) => {
          expect(command).toEqual({ kind: "doctor", offline: false });
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: entry.data,
          });
        },
      })).toBe(entry.exitCode);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        ok: true,
        command: "doctor",
        data: entry.data,
      });
      expect(captured.read().stderr).toBe("");
    }
  });

  test("init never opens or migrates the state database outside exclusive authority", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "hra-init-lock-")));
    const paths = resolveStatePaths({ homeDirectory: temporary, platform: process.platform });
    await initializeStatePaths(paths);
    const documents = join(temporary, "Documents");
    await mkdir(documents, { mode: 0o700 });
    const owner = await DaemonLock.acquire(paths);
    try {
      const captured = capture();
      await expect(initialize(true, true, captured.output, { paths, documentsDirectory: documents })).rejects.toThrow("already owns");
      expect(captured.read()).toEqual({ stdout: "", stderr: "" });
      await expect(lstat(paths.database)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await owner.release();
      await rm(temporary, { force: true, recursive: true });
    }
  });
});
