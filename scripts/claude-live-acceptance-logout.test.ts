import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CLAUDE_PIN,
  CLAUDE_PIN_EFFORT,
  CLAUDE_PIN_MODEL,
  CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY,
  digestClaudeHostToolInvocation,
  type ClaudeHostToolResponseWritten,
  type PinnedClaudeRuntime,
  type ResolvePinnedClaudeRuntimeOptions,
} from "../src/claude/index";
import type { HraHostToolCall } from "../src/codex/protocol";
import type { ProfileId, SessionId } from "../src/domain/values";
import { profilePaths, resolveStatePaths } from "../src/storage/paths";
import { HRA_VERSION } from "../src/version";
import { BoundedProcessCleanupUnprovenError } from "./bounded-process";
import {
  ClaudeLiveAcceptanceProofCollector,
  type ClaudeLiveAcceptancePrivateReceipt,
} from "./claude-live-acceptance-proof";
import {
  createClaudeLiveAcceptanceLogout,
  createClaudeLiveAcceptanceCleanupStoppedCustody,
  ClaudeLiveAcceptanceLogoutError,
  type ClaudeLiveAcceptanceLogoutAttemptMarker,
  type ClaudeLiveAcceptanceLogoutPreflightReceipt,
  type ClaudeLiveAcceptanceStoppedOracle,
} from "./claude-live-acceptance-logout";
import type { CommandRequest, CommandResult, CommandRunner } from "./configure-hosted-sync";
import type {
  AcceptanceInstallationDescriptor,
  LiveAcceptanceCandidate,
} from "./live-acceptance-installation";
import { canonicalDigest } from "./release-evidence";

const cleanupRoots = new Set<string>();

afterEach(async () => {
  await Promise.all([...cleanupRoots].map(async (path) => {
    await rm(path, { force: true, recursive: true });
  }));
  cleanupRoots.clear();
});

const logoutHelp = [
  "Usage: claude auth logout [options]",
  "",
  "Log out from your Anthropic account",
  "",
  "Options:",
  "  -h, --help  Display help for command",
  "",
].join("\n");

const logoutHelpWithVariableProse = [
  "Usage: claude auth logout [options]",
  "",
  "Sign out of the account active in this isolated profile.",
  "This descriptive text is deliberately not an authority surface.",
  "",
  "Options:",
  "    -h,   --help      Render command help",
  "",
].join("\n");

const profileId = `acct_${"1".repeat(32)}` as ProfileId;
const providerAccountId = `pact_${"1".repeat(32)}`;
const sessionId = `sess_${"2".repeat(32)}` as SessionId;
const memory = {
  body: "The acceptance callback persisted one isolated Claude memory.",
  key: "acceptance.claude.native_logout",
  summary: "One callback was retained before native logout.",
  title: "Claude native logout acceptance",
} as const;

type Harness = Readonly<{
  configDir: string;
  descriptor: AcceptanceInstallationDescriptor;
  executablePath: string;
  expectedHomeDirectory: string;
  attempts: ClaudeLiveAcceptanceLogoutAttemptMarker[];
  events: string[];
  requests: CommandRequest[];
  root: string;
}>;

const createHarness = async (): Promise<Harness> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hra-claude-logout-")));
  cleanupRoots.add(root);
  const runId = randomUUID();
  const runRoot = join(root, `hra-live-acceptance-${runId}-fixture`);
  const expectedHomeDirectory = join(root, "acceptance-home");
  const rootDirectory = join(runRoot, "device-a-state");
  const documentsDirectory = join(runRoot, "project-a-documents");
  await Promise.all([
    mkdir(expectedHomeDirectory, { mode: 0o700 }),
    mkdir(documentsDirectory, { mode: 0o700, recursive: true }),
  ]);
  const configDir = profilePaths(resolveStatePaths({ rootDirectory }), profileId).claudeConfigDir;
  await mkdir(configDir, { mode: 0o700, recursive: true });
  const candidate: LiveAcceptanceCandidate = {
    cloudTargetDigest: "3".repeat(64),
    packageVersion: HRA_VERSION,
    sourceRevision: "4".repeat(40),
  };
  return {
    configDir,
    descriptor: {
      candidate,
      device: "a",
      documentsDirectory,
      expectedHomeDirectory,
      rootDirectory,
      runId,
      type: "hra-live-acceptance-device",
      version: 1,
    },
    executablePath: join(expectedHomeDirectory, "fixture-tools", "claude"),
    expectedHomeDirectory,
    attempts: [],
    events: [],
    requests: [],
    root,
  };
};

const stoppedOracle = (proofBindingDigest: string): ClaudeLiveAcceptanceStoppedOracle => ({
  version: 1,
  phase: "stopped",
  source: "independent_private_readback",
  snapshotDigest: "5".repeat(64),
  nativeStart: true,
  directSend: true,
  soleRemember: true,
  workingPage: true,
  managedClaudeSignedIn: true,
  processBound: true,
  hostBinding: true,
  pinnedProcessArgv: true,
  processArgvDigest: "b".repeat(64),
  proofBindingDigest,
  processReleased: true,
  processNotLive: true,
  privateArtifactsAbsent: true,
  lifecycleInvalidated: true,
});

const cleanupStoppedCustody = (
  descriptor: AcceptanceInstallationDescriptor,
  receipt: ClaudeLiveAcceptanceLogoutPreflightReceipt,
  retainedSessionProcess: "absent" | "released_not_live" = "absent",
) => {
  if (descriptor.candidate === undefined) throw new Error("test_candidate_missing");
  return createClaudeLiveAcceptanceCleanupStoppedCustody({
    candidateBindingDigest: canonicalDigest(descriptor.candidate),
    daemonAuthorityReleased: true,
    daemonJoined: true,
    daemonPrivateArtifactsAbsent: true,
    phase: "stopped",
    preflightBindingDigest: receipt.bindingDigest,
    profileId,
    retainedSessionProcess,
    runId: descriptor.runId,
    source: "worker_shutdown_private",
    unreleasedProcessesAbsent: true,
    version: 1,
    workerNotLive: true,
    workerPid: 41_041,
  });
};

const privateReceipt = async (
  descriptor: AcceptanceInstallationDescriptor,
): Promise<ClaudeLiveAcceptancePrivateReceipt> => {
  const candidate = descriptor.candidate;
  if (candidate === undefined) throw new Error("test_candidate_missing");
  const collector = new ClaudeLiveAcceptanceProofCollector({
    candidate,
    runId: descriptor.runId,
  });
  const callId = "acceptance-call-one";
  const request = { input: memory, tool: "memory_remember" } as const;
  const requestDigest = digestClaudeHostToolInvocation(callId, request);
  const call: HraHostToolCall = {
    authority: { processGeneration: 7, profileId, provider: "claude", providerAccountId, bindingGeneration: 1 },
    callId,
    connectionId: "acceptance-connection-one",
    input: memory,
    requestDigest,
    requestId: { type: "string", value: callId },
    threadId: "acceptance-thread-one",
    tool: "memory_remember",
    turnId: "acceptance-turn-one",
  };
  collector.beginDaemonGeneration(11);
  collector.armFreshSession({
    daemonGeneration: 11,
    memory,
    profileGeneration: 7,
    profileId,
    providerThreadId: call.threadId,
    sendIdempotencyKey: "00000000-0000-4000-8000-000000000802",
    sessionId,
  });
  collector.corroborateAppliedSend({
    daemonGeneration: 11,
    idempotencyKey: "00000000-0000-4000-8000-000000000802",
    sessionId,
    turnId: call.turnId,
  });
  const result = {
    idempotencyRetainedUntil: "2026-09-07T00:00:00.000Z",
    ok: true,
    page: {
      key: memory.key,
      operationSha256: "6".repeat(64),
      recordSha256: "7".repeat(64),
    },
    receiptSha256: "8".repeat(64),
    replay: false,
    submission: {
      id: `memsub_${"9".repeat(32)}`,
      kind: "remember",
      state: "applied",
    },
    version: 1,
    workingHead: {
      digest: "a".repeat(64),
      operationSha256: "6".repeat(64),
      sequence: 1,
    },
  } as const;
  await collector.handleManagedHostToolCall({
    authority: {
      codexHome: join(tmpdir(), "hra-logout-proof-codex-home"),
      desktopUserData: join(tmpdir(), "hra-logout-proof-desktop-data"),
      generation: 7,
      id: profileId,
      provider: "claude",
      providerAccountId,
      bindingGeneration: 1,
    },
    call,
    dispatch: async () => result,
  });
  const written: ClaudeHostToolResponseWritten = {
    bindingId: "acceptance-binding-one",
    callId,
    processGeneration: 7,
    profileId,
    provider: "claude",
    providerThreadId: call.threadId,
    request,
    requestDigest,
  };
  collector.handleManagedHostToolResponseWritten(written);
  collector.closeDaemonGeneration(11);
  return collector.readPrivateReceipt();
};

const statusResult = (configDir: string, signedIn: boolean): CommandResult => ({
  exitCode: signedIn ? 0 : 1,
  stderr: "",
  stdout: JSON.stringify({
    loggedIn: signedIn,
    authMethod: signedIn ? "oauth" : "none",
    apiProvider: "firstParty",
    analyticsDisabled: true,
    projectsDirectory: join(configDir, "projects"),
  }),
});

const fakeResolver = (
  executablePath: string,
): ((options: ResolvePinnedClaudeRuntimeOptions) => Promise<PinnedClaudeRuntime>) =>
  async (options) => {
    if (options.probeVersion === undefined) throw new Error("test_probe_missing");
    const version = await options.probeVersion({
      configDir: options.configDir,
      configHome: "isolated",
      deadlineMs: options.versionProbeDeadlineMs ?? 5_000,
      environment: options.environment ?? {},
      executablePath,
      signal: options.signal ?? new AbortController().signal,
    });
    if (version !== `${CLAUDE_PIN}\n`) throw new Error("test_version_rejected");
    return {
      argv: [executablePath, "--print"],
      effort: CLAUDE_PIN_EFFORT,
      executablePath,
      model: CLAUDE_PIN_MODEL,
      nativeFallback: CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY,
      version: CLAUDE_PIN,
    };
  };

const runner = (input: Readonly<{
  harness: Harness;
  help?: string;
  logoutFailure?: Error;
  statuses: boolean[];
}>): CommandRunner => async (request) => {
  input.harness.requests.push(request);
  const args = request.arguments.join(" ");
  input.harness.events.push(`command:${args}`);
  if (args === "--version") return { exitCode: 0, stderr: "", stdout: `${CLAUDE_PIN}\n` };
  if (args === "auth logout --help") {
    return { exitCode: 0, stderr: "", stdout: input.help ?? logoutHelp };
  }
  if (args === "auth status --json") {
    const signedIn = input.statuses.shift();
    if (signedIn === undefined) throw new Error("test_status_exhausted");
    return statusResult(input.harness.configDir, signedIn);
  }
  if (args === "auth logout") {
    if (input.logoutFailure !== undefined) throw input.logoutFailure;
    return { exitCode: 0, stderr: "", stdout: "" };
  }
  throw new Error("test_command_unexpected");
};

const controller = (
  harness: Harness,
  run: CommandRunner,
  persistAttempt: (marker: ClaudeLiveAcceptanceLogoutAttemptMarker) => Promise<void> =
    async (marker) => {
      harness.attempts.push(marker);
      harness.events.push("attempt:persisted");
    },
) => createClaudeLiveAcceptanceLogout({
  descriptor: harness.descriptor,
  environment: {
    HOME: harness.expectedHomeDirectory,
    PATH: join(harness.expectedHomeDirectory, "fixture-tools"),
  },
  profileId,
  persistAttempt,
  resolveRuntime: fakeResolver(harness.executablePath),
  run,
});

describe("Claude live-acceptance native logout", () => {
  test("preflights the exact pinned capability and logs out only after stopped proof", async () => {
    const harness = await createHarness();
    const value = controller(harness, runner({
      harness,
      help: logoutHelpWithVariableProse,
      statuses: [false, true, false],
    }));
    const signal = new AbortController().signal;
    const preflight = await value.preflightBeforeLogin(signal);
    expect(preflight).toMatchObject({
      helpSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      receipt: {
        bindingDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        phase: "preflight_complete",
      },
      version: CLAUDE_PIN,
    });
    const receipt = await privateReceipt(harness.descriptor);
    const evidence = await value.logoutAfterStoppedOracle({
      receipt,
      signal,
      stoppedOracle: stoppedOracle(receipt.candidateBindingDigest),
    });
    expect(evidence).toEqual({
      helpSha256: preflight.helpSha256,
      logoutDispatched: true,
      recovered: false,
      signedOut: true,
      version: CLAUDE_PIN,
    });
    expect(harness.requests.map((request) => request.arguments)).toEqual([
      ["--version"],
      ["auth", "logout", "--help"],
      ["auth", "status", "--json"],
      ["auth", "status", "--json"],
      ["auth", "logout"],
      ["auth", "status", "--json"],
    ]);
    expect(harness.attempts).toHaveLength(1);
    expect(harness.events.indexOf("attempt:persisted"))
      .toBeLessThan(harness.events.indexOf("command:auth logout"));
    for (const request of harness.requests) {
      expect(request).toMatchObject({
        containment: "authority",
        cwd: harness.configDir,
        environment: {
          CLAUDE_CONFIG_DIR: harness.configDir,
          HOME: harness.expectedHomeDirectory,
          LANG: "C",
          LC_ALL: "C",
          NO_COLOR: "1",
        },
        executable: harness.executablePath,
        outputMaximumBytes: 16 * 1024,
        stdin: "",
        timeoutMs: 5_000,
      });
      expect(request.environment.TMPDIR).toStartWith(harness.root);
    }
    value.close();
    await expect(value.logoutAfterStoppedOracle({
      receipt,
      signal,
      stoppedOracle: stoppedOracle(receipt.candidateBindingDigest),
    })).rejects.toBeInstanceOf(ClaudeLiveAcceptanceLogoutError);
    expect(harness.requests).toHaveLength(6);
  });

  test("skips the one-shot effect when cleanup status is already signed out", async () => {
    const harness = await createHarness();
    const value = controller(harness, runner({ harness, statuses: [false, false] }));
    const signal = new AbortController().signal;
    await value.preflightBeforeLogin(signal);
    const receipt = await privateReceipt(harness.descriptor);
    await expect(value.logoutAfterStoppedOracle({
      receipt,
      signal,
      stoppedOracle: stoppedOracle(receipt.candidateBindingDigest),
    })).resolves.toMatchObject({ logoutDispatched: false, signedOut: true });
    expect(harness.requests.some((request) =>
      request.arguments.length === 2 && request.arguments[0] === "auth"
      && request.arguments[1] === "logout"
    )).toBeFalse();
  });

  test("refuses a stopped oracle from a different exact callback proof", async () => {
    const harness = await createHarness();
    const value = controller(harness, runner({ harness, statuses: [false] }));
    const signal = new AbortController().signal;
    await value.preflightBeforeLogin(signal);
    const receipt = await privateReceipt(harness.descriptor);
    await expect(value.logoutAfterStoppedOracle({
      receipt,
      signal,
      stoppedOracle: stoppedOracle("d".repeat(64)),
    })).rejects.toMatchObject({ code: "scope_refused" });
    expect(harness.requests).toHaveLength(3);
    expect(harness.attempts).toHaveLength(0);
  });

  test("refuses a changed help vocabulary before reading authentication", async () => {
    const harness = await createHarness();
    const value = controller(harness, runner({
      harness,
      help: logoutHelp.replace(
        "  -h, --help  Display help for command",
        "  -h, --help  Display help for command\n  --token     Select a token",
      ),
      statuses: [],
    }));
    await expect(value.preflightBeforeLogin(new AbortController().signal))
      .rejects.toMatchObject({ code: "capability_refused" });
    expect(harness.requests.map((request) => request.arguments)).toEqual([
      ["--version"],
      ["auth", "logout", "--help"],
    ]);
  });

  test("refuses dirty profile custody and aborted work before any child launch", async () => {
    const dirty = await createHarness();
    await mkdir(join(dirty.configDir, "unexpected-entry"), { mode: 0o700 });
    const dirtyValue = controller(dirty, runner({ harness: dirty, statuses: [] }));
    await expect(dirtyValue.preflightBeforeLogin(new AbortController().signal))
      .rejects.toMatchObject({ code: "directory_refused" });
    expect(dirty.requests).toHaveLength(0);

    const aborted = await createHarness();
    const abortedValue = controller(aborted, runner({ harness: aborted, statuses: [] }));
    const controllerSignal = new AbortController();
    controllerSignal.abort();
    await expect(abortedValue.preflightBeforeLogin(controllerSignal.signal))
      .rejects.toMatchObject({ code: "aborted" });
    expect(aborted.requests).toHaveLength(0);
  });

  test("poisons concurrent preflight and rejects a replaced directory before logout", async () => {
    const concurrent = await createHarness();
    let releaseVersion!: () => void;
    let markVersionEntered!: () => void;
    const versionGate = new Promise<void>((resolve) => { releaseVersion = resolve; });
    const versionEntered = new Promise<void>((resolve) => { markVersionEntered = resolve; });
    const base = runner({ harness: concurrent, statuses: [] });
    const gated: CommandRunner = async (request) => {
      if (request.arguments.length === 1 && request.arguments[0] === "--version") {
        concurrent.requests.push(request);
        markVersionEntered();
        await versionGate;
        return { exitCode: 0, stderr: "", stdout: `${CLAUDE_PIN}\n` };
      }
      return await base(request);
    };
    const concurrentValue = controller(concurrent, gated);
    const first = concurrentValue.preflightBeforeLogin(new AbortController().signal);
    await versionEntered;
    await expect(concurrentValue.preflightBeforeLogin(new AbortController().signal))
      .rejects.toMatchObject({ code: "concurrent_operation" });
    releaseVersion();
    await expect(first).rejects.toMatchObject({ code: "concurrent_operation" });
    expect(concurrent.requests).toHaveLength(1);

    const replaced = await createHarness();
    const replacedValue = controller(replaced, runner({ harness: replaced, statuses: [false] }));
    await replacedValue.preflightBeforeLogin(new AbortController().signal);
    await rename(replaced.configDir, `${replaced.configDir}-old`);
    await mkdir(replaced.configDir, { mode: 0o700 });
    const receipt = await privateReceipt(replaced.descriptor);
    await expect(replacedValue.logoutAfterStoppedOracle({
      receipt,
      signal: new AbortController().signal,
      stoppedOracle: stoppedOracle(receipt.candidateBindingDigest),
    })).rejects.toMatchObject({ code: "directory_refused" });
    expect(replaced.requests).toHaveLength(3);
  });

  test("propagates uncertain cleanup and recovers by status without replaying logout", async () => {
    const harness = await createHarness();
    const cleanupFailure = new BoundedProcessCleanupUnprovenError(
      51_515,
      "claude-live-acceptance-logout",
    );
    const statuses = [false, true, false];
    let failLogout = true;
    const base = runner({ harness, statuses });
    const run: CommandRunner = async (request) => {
      if (
        failLogout
        && request.arguments.length === 2
        && request.arguments[0] === "auth"
        && request.arguments[1] === "logout"
      ) {
        harness.requests.push(request);
        failLogout = false;
        throw cleanupFailure;
      }
      return await base(request);
    };
    const value = controller(harness, run);
    const signal = new AbortController().signal;
    await value.preflightBeforeLogin(signal);
    const receipt = await privateReceipt(harness.descriptor);
    await expect(value.logoutAfterStoppedOracle({
      receipt,
      signal,
      stoppedOracle: stoppedOracle(receipt.candidateBindingDigest),
    })).rejects.toBe(cleanupFailure);
    await expect(value.logoutAfterStoppedOracle({
      receipt,
      signal,
      stoppedOracle: stoppedOracle(receipt.candidateBindingDigest),
    })).rejects.toMatchObject({ code: "recovery_required" });
    const requestsBeforeInvalidRecovery = harness.requests.length;
    await expect(value.recoverUncertainLogout({
      cleanupRecovered: false,
      receipt,
      signal,
      stoppedOracle: stoppedOracle(receipt.candidateBindingDigest),
    } as never)).rejects.toMatchObject({ code: "recovery_required" });
    expect(harness.requests).toHaveLength(requestsBeforeInvalidRecovery);
    await expect(value.recoverUncertainLogout({
      receipt,
      signal,
      stoppedOracle: stoppedOracle(receipt.candidateBindingDigest),
    } as never)).rejects.toMatchObject({ code: "recovery_required" });
    expect(harness.requests).toHaveLength(requestsBeforeInvalidRecovery);
    const recovered = await value.recoverUncertainLogout({
      cleanupRecovered: true,
      receipt,
      signal,
      stoppedOracle: stoppedOracle(receipt.candidateBindingDigest),
    });
    expect(recovered).toMatchObject({
      logoutDispatched: false,
      recovered: true,
      signedOut: true,
    });
    expect(harness.requests.filter((request) =>
      request.arguments.length === 2
      && request.arguments[0] === "auth"
      && request.arguments[1] === "logout"
    )).toHaveLength(1);
  });

  test("does not mint or persist new authority after lifecycle close", async () => {
    const harness = await createHarness();
    let releaseStatus!: () => void;
    let markStatusEntered!: () => void;
    const statusGate = new Promise<void>((resolve) => { releaseStatus = resolve; });
    const statusEntered = new Promise<void>((resolve) => { markStatusEntered = resolve; });
    let statusCalls = 0;
    const base = runner({ harness, statuses: [false] });
    const run: CommandRunner = async (request) => {
      if (request.arguments.join(" ") === "auth status --json") {
        statusCalls += 1;
        if (statusCalls === 2) {
          harness.requests.push(request);
          harness.events.push("command:auth status --json");
          markStatusEntered();
          await statusGate;
          return statusResult(harness.configDir, true);
        }
      }
      return await base(request);
    };
    const value = controller(harness, run);
    const signal = new AbortController().signal;
    await value.preflightBeforeLogin(signal);
    const receipt = await privateReceipt(harness.descriptor);
    const pending = value.logoutAfterStoppedOracle({
      receipt,
      signal,
      stoppedOracle: stoppedOracle(receipt.candidateBindingDigest),
    });
    await statusEntered;
    value.close();
    releaseStatus();
    await expect(pending).rejects.toMatchObject({ code: "authority_changed" });
    expect(harness.attempts).toHaveLength(0);
    expect(harness.requests.some((request) => request.arguments.join(" ") === "auth logout"))
      .toBeFalse();
  });

  test("rechecks abort after durable attempt persistence and before child admission", async () => {
    const harness = await createHarness();
    const run = runner({ harness, statuses: [false, true] });
    let abortedRead = 0;
    let abortAtRead = Number.POSITIVE_INFINITY;
    const postAttemptSignal = {
      get aborted() {
        abortedRead += 1;
        return abortedRead >= abortAtRead;
      },
    } as unknown as AbortSignal;
    const value = controller(harness, run, async (marker) => {
      harness.attempts.push(marker);
      harness.events.push("attempt:persisted");
      // One check follows persistence; the next is the post-filesystem
      // admission fence immediately before invoking the command runner.
      abortAtRead = abortedRead + 2;
    });
    await value.preflightBeforeLogin(new AbortController().signal);
    const receipt = await privateReceipt(harness.descriptor);
    await expect(value.logoutAfterStoppedOracle({
      receipt,
      signal: postAttemptSignal,
      stoppedOracle: stoppedOracle(receipt.candidateBindingDigest),
    })).rejects.toMatchObject({ code: "aborted" });
    expect(harness.attempts).toHaveLength(1);
    expect(harness.requests.some((request) => request.arguments.join(" ") === "auth logout"))
      .toBeFalse();
  });

  test("resumes cleanup from durable preflight custody without minting acceptance evidence", async () => {
    const harness = await createHarness();
    const signal = new AbortController().signal;
    const initial = controller(harness, runner({ harness, statuses: [false] }));
    const preflight = await initial.preflightBeforeLogin(signal);
    initial.close();

    const resumedRequests = harness.requests.length;
    const resumed = controller(harness, runner({ harness, statuses: [true, false] }));
    const validStoppedCustody = cleanupStoppedCustody(harness.descriptor, preflight.receipt);
    expect(() => cleanupStoppedCustody(
      harness.descriptor,
      preflight.receipt,
      "active" as never,
    )).toThrow();
    const evidence = await resumed.resumeCleanupAfterStoppedCustody({
      preflightReceipt: preflight.receipt,
      signal,
      stoppedCustody: validStoppedCustody,
    });
    expect(evidence).toEqual({
      logoutDispatched: true,
      preflightBindingDigest: preflight.receipt.bindingDigest,
      recovered: true,
      signedOut: true,
      source: "cleanup_only",
      version: CLAUDE_PIN,
    });
    expect(harness.requests.slice(resumedRequests).map((request) => request.arguments)).toEqual([
      ["--version"],
      ["auth", "logout", "--help"],
      ["auth", "status", "--json"],
      ["auth", "logout"],
      ["auth", "status", "--json"],
    ]);
    expect(harness.attempts).toHaveLength(1);
    const attemptMarker = harness.attempts[0];
    if (attemptMarker === undefined) throw new Error("test_attempt_missing");

    const uncertainResume = controller(
      harness,
      runner({ harness, statuses: [true] }),
    );
    await expect(uncertainResume.resumeCleanupAfterStoppedCustody({
      attemptMarker,
      preflightReceipt: preflight.receipt,
      signal,
      stoppedCustody: cleanupStoppedCustody(harness.descriptor, preflight.receipt),
    })).rejects.toMatchObject({ code: "recovery_required" });
    expect(harness.attempts).toHaveLength(1);
  });
});
