import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initialize, main, renderRemoteSuccess, resolveSessionEventCursorCodec, selectDaemonCloudControl } from "./cli";
import {
  CloudDaemonJournalRecoveryBlocker,
  MemoryCloudDaemonJournal,
  type CloudProjectionRecoveryJournalEntry,
} from "./cloud/daemon-journal";
import type { CommandResponse, LocalCommand } from "./domain/contracts";
import { DAEMON_PROTOCOL, DaemonLock } from "./daemon/daemon-lock";
import { initializeStatePaths, resolveStatePaths } from "./storage/paths";
import { FileSecretBackend, GenerationalSecretCustody } from "./storage/secret-custody";

const capture = () => {
  let stdout = "";
  let stderr = "";
  return {
    output: { writeStdout: (value: string) => { stdout += value; }, writeStderr: (value: string) => { stderr += value; } },
    read: () => ({ stdout, stderr }),
  };
};

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

describe("CLI entry point", () => {
  test("help is offline and stable", async () => {
    const captured = capture();
    expect(await main(["--help"], captured.output)).toBe(0);
    expect(captured.read().stdout).toContain("hra session");
    expect(captured.read().stderr).toBe("");

    const group = capture();
    expect(await main(["session", "--help"], group.output)).toBe(0);
    expect(group.read().stdout).toContain("HRA session");
    expect(group.read().stdout).toContain("hra session events");
    expect(group.read().stdout).not.toContain("hra device pair");
    expect(group.read().stderr).toBe("");

    const protectedGroup = capture();
    expect(await main(["interaction", "answer", "--help"], protectedGroup.output)).toBe(0);
    expect(protectedGroup.read().stdout).toContain("--input-stdin|--input-fd");
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
            data: { usage: [{ account: { id: command.account } }] },
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
        usage: Array<{ account: { id: string } }>;
      };
    };
    expect(payload.data.refresh.outcomes.map((outcome) => outcome.accountId)).toEqual(
      accounts.map((account) => account.id),
    );
    expect(payload.data.refresh.outcomes[0]).toMatchObject({ state: "skipped" });
    expect(payload.data.refresh.outcomes[3]).toMatchObject({ code: "UNAVAILABLE", state: "failed" });
    expect(payload.data.usage.map((entry) => entry.account.id)).toEqual(accounts.map((account) => account.id));
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

  test("version is sourced from package metadata", async () => {
    const captured = capture();
    expect(await main(["--version"], captured.output)).toBe(0);
    expect(captured.read()).toEqual({ stdout: "hra 0.1.0\n", stderr: "" });
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
          data: { accepted: true },
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

  test("surfaces selected-session updates while the human prompt is waiting and drains on exit", async () => {
    const captured = capture();
    const sessionId = `sess_${"2".repeat(32)}`;
    const accountId = `acct_${"1".repeat(32)}`;
    const streamEpoch = "90000000-0000-4000-8000-000000000011";
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
              version: 1,
              session: { id: sessionId, profileId: accountId },
              eventStream: { cursor: "head-0" },
              pendingInteractions: [{
                id: "70000000-0000-4000-8000-000000000011",
                kind: "command_approval",
                state: "pending",
                revision: 2,
                blocking: true,
                display: { summary: "Run the release verification" },
              }],
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
              requestedCursor: "head-0",
              retentionFloorCursor: "floor",
              observedThroughCursor: "head-3",
              nextCursor: "head-3",
              gap: null,
              events: [
                { ...base, sequence: 1, body: { type: "assistant_delta" as const, turnId: "turn-1", itemId: "assistant-1", text: "release " } },
                { ...base, sequence: 2, body: { type: "assistant_delta" as const, turnId: "turn-1", itemId: "assistant-1", text: "is ready" } },
                { ...base, sequence: 3, body: { type: "turn_completed" as const, turnId: "turn-1", status: "completed" as const } },
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

  test("keeps session event cursor signatures stable across daemon restarts", async () => {
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
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("remote commands remain explicit and offline when no cloud URL is configured", async () => {
    const previous = process.env.HRA_CONVEX_URL;
    delete process.env.HRA_CONVEX_URL;
    try {
      const captured = capture();
      expect(await main(["remote", "list", "--json"], captured.output)).toBe(5);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: expect.stringContaining("not configured") },
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
