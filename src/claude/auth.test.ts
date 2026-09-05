import { describe, expect, test } from "bun:test";

import {
  parseClaudeAuthStatus,
  readClaudeAuthStatus,
  runClaudeForegroundLogin,
  type ClaudeAuthStatusProcess,
  type ClaudeLoginSignal,
  type ClaudeLoginSignalSource,
} from "./auth";
import { ClaudeError } from "./errors";
import { CLAUDE_PIN, CLAUDE_PIN_EFFORT, CLAUDE_PIN_MODEL } from "./pin";
import type { PinnedClaudeRuntime } from "./runtime";

const CONFIG_DIR = "/var/hra/profiles/acct/claude-config";
const encoder = new TextEncoder();

const runtime: PinnedClaudeRuntime = {
  argv: ["/opt/hra/claude", "--print"],
  effort: CLAUDE_PIN_EFFORT,
  executablePath: "/opt/hra/claude",
  model: CLAUDE_PIN_MODEL,
  version: CLAUDE_PIN,
};

const statusDocument = (overrides: Readonly<Record<string, unknown>> = {}): Uint8Array =>
  encoder.encode(JSON.stringify({
    loggedIn: false,
    authMethod: "none",
    apiProvider: "firstParty",
    analyticsDisabled: false,
    projectsDirectory: `${CONFIG_DIR}/projects`,
    ...overrides,
  }));

const chunks = (values: readonly Uint8Array[]): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    for (const value of values) yield value;
  },
});

const completedStatusProcess = (
  stdout: Uint8Array,
  exitCode: number,
  stderr = new Uint8Array(),
): ClaudeAuthStatusProcess => ({
  exited: Promise.resolve(exitCode),
  forceTerminate: () => undefined,
  stderr: chunks([stderr]),
  stdout: chunks([stdout]),
  terminate: () => undefined,
});

class HangingStatusProcess implements ClaudeAuthStatusProcess {
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly exited: Promise<number>;
  terminated = false;
  forceTerminated = false;
  #resolveClosed!: () => void;
  #resolveExit!: (code: number) => void;

  constructor(initialStdout: readonly Uint8Array[] = []) {
    const closed = new Promise<void>((resolve) => { this.#resolveClosed = resolve; });
    this.exited = new Promise<number>((resolve) => { this.#resolveExit = resolve; });
    this.stdout = {
      async *[Symbol.asyncIterator]() {
        for (const value of initialStdout) yield value;
        await closed;
      },
    };
    this.stderr = {
      async *[Symbol.asyncIterator]() { await closed; yield new Uint8Array(); },
    };
  }

  terminate(): void {
    this.terminated = true;
    this.#resolveClosed();
    this.#resolveExit(143);
  }

  forceTerminate(): void {
    this.forceTerminated = true;
    this.#resolveClosed();
    this.#resolveExit(137);
  }
}

class FakeSignalSource implements ClaudeLoginSignalSource {
  readonly listeners = new Map<ClaudeLoginSignal, Set<() => void>>();

  add(signal: ClaudeLoginSignal, listener: () => void): void {
    const listeners = this.listeners.get(signal) ?? new Set();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  }

  remove(signal: ClaudeLoginSignal, listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  emit(signal: ClaudeLoginSignal): void {
    for (const listener of this.listeners.get(signal) ?? []) listener();
  }
}

class ImmediateSignalSource extends FakeSignalSource {
  #emitted = false;

  constructor(private readonly immediate: ClaudeLoginSignal) {
    super();
  }

  override add(signal: ClaudeLoginSignal, listener: () => void): void {
    super.add(signal, listener);
    if (signal === this.immediate && !this.#emitted) {
      this.#emitted = true;
      listener();
    }
  }
}

describe("Claude authentication status", () => {
  test("accepts only coherent pinned signed-in and signed-out results", () => {
    expect(parseClaudeAuthStatus({
      configDir: CONFIG_DIR,
      exitCode: 1,
      stdout: statusDocument(),
    })).toEqual({ signedIn: false });
    expect(parseClaudeAuthStatus({
      configDir: CONFIG_DIR,
      exitCode: 0,
      stdout: statusDocument({
        loggedIn: true,
        authMethod: "claude.ai",
        email: "person@example.test",
        orgId: "org-private",
        orgName: "Private Org",
        subscriptionType: "max",
      }),
    })).toEqual({ signedIn: true });

    for (const value of [
      { exitCode: 0, stdout: statusDocument() },
      { exitCode: 1, stdout: statusDocument({ loggedIn: true, authMethod: "claude.ai" }) },
      { exitCode: 0, stdout: statusDocument({ loggedIn: true, authMethod: "none" }) },
    ]) {
      expect(() => parseClaudeAuthStatus({ configDir: CONFIG_DIR, ...value }))
        .toThrow("incoherent authentication status");
    }
  });

  test("fails closed on malformed, widened, misplaced, and unexpected-exit documents", () => {
    expect(() => parseClaudeAuthStatus({
      configDir: CONFIG_DIR,
      exitCode: 1,
      stdout: encoder.encode("not-json"),
    })).toThrow(ClaudeError);
    expect(() => parseClaudeAuthStatus({
      configDir: CONFIG_DIR,
      exitCode: 1,
      stdout: statusDocument({ unexpected: true }),
    })).toThrow("invalid authentication status document");
    expect(() => parseClaudeAuthStatus({
      configDir: CONFIG_DIR,
      exitCode: 1,
      stdout: statusDocument({ projectsDirectory: "/another/profile/projects" }),
    })).toThrow("isolated profile directory");
    expect(() => parseClaudeAuthStatus({
      configDir: CONFIG_DIR,
      exitCode: 2,
      stdout: statusDocument(),
    })).toThrow("exited without a status result");
  });

  test("runs exact direct argv under the isolated allowlisted environment", async () => {
    let launch: Parameters<NonNullable<Parameters<typeof readClaudeAuthStatus>[0]["processFactory"]>>[0] | undefined;
    const result = await readClaudeAuthStatus({
      configDir: CONFIG_DIR,
      environment: {
        ANTHROPIC_API_KEY: "must-not-cross",
        HOME: "/Users/test",
        HTTPS_PROXY: "https://must-not-cross.invalid",
        PATH: "/usr/bin:/bin",
      },
      processFactory: (input) => {
        launch = input;
        return completedStatusProcess(statusDocument(), 1);
      },
      resolveRuntime: async (options) => {
        expect(options.configDir).toBe(CONFIG_DIR);
        return runtime;
      },
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ signedIn: false });
    expect(launch?.argv).toEqual([runtime.executablePath, "auth", "status", "--json"]);
    expect(launch?.environment).toEqual({
      CLAUDE_CONFIG_DIR: CONFIG_DIR,
      HOME: "/Users/test",
      NO_COLOR: "1",
      PATH: "/usr/bin:/bin",
    });
  });

  test("bounds output and terminates before rejecting an oversized process", async () => {
    const process = new HangingStatusProcess([new Uint8Array(16 * 1024 + 1)]);
    await expect(readClaudeAuthStatus({
      configDir: CONFIG_DIR,
      processFactory: () => process,
      resolveRuntime: async () => runtime,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "PROTOCOL_LIMIT" });
    expect(process.terminated).toBe(true);
  });

  test("terminates and joins on deadline and caller abort", async () => {
    const timedOut = new HangingStatusProcess();
    await expect(readClaudeAuthStatus({
      configDir: CONFIG_DIR,
      deadlineMs: 1,
      processFactory: () => timedOut,
      resolveRuntime: async () => runtime,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(timedOut.terminated).toBe(true);

    const controller = new AbortController();
    const aborted = new HangingStatusProcess();
    let spawned!: () => void;
    const didSpawn = new Promise<void>((resolve) => { spawned = resolve; });
    const pending = readClaudeAuthStatus({
      configDir: CONFIG_DIR,
      processFactory: () => { spawned(); return aborted; },
      resolveRuntime: async () => runtime,
      signal: controller.signal,
    });
    await didSpawn;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "PROCESS_EXITED" });
    expect(aborted.terminated).toBe(true);
  });

  test("bounds the final join even when a broken process ignores forced termination", async () => {
    const never = new Promise<never>(() => undefined);
    const process: ClaudeAuthStatusProcess & { forced: boolean; terminated: boolean } = {
      exited: never,
      forced: false,
      forceTerminate() { this.forced = true; },
      stderr: { async *[Symbol.asyncIterator]() { await never; yield new Uint8Array(); } },
      stdout: { async *[Symbol.asyncIterator]() { await never; yield new Uint8Array(); } },
      terminate() { this.terminated = true; },
      terminated: false,
    };
    const startedAt = Date.now();
    await expect(readClaudeAuthStatus({
      configDir: CONFIG_DIR,
      deadlineMs: 1,
      processFactory: () => process,
      resolveRuntime: async () => runtime,
      signal: new AbortController().signal,
    })).rejects.toThrow("could not be joined after forced termination");
    expect(process.terminated).toBe(true);
    expect(process.forced).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("force-terminates when the status exit observer rejects without proving process exit", async () => {
    const process: ClaudeAuthStatusProcess & { forced: boolean; terminated: boolean } = {
      exited: Promise.reject(new Error("broken wait")),
      forced: false,
      forceTerminate() { this.forced = true; },
      stderr: chunks([new Uint8Array()]),
      stdout: chunks([statusDocument()]),
      terminate() { this.terminated = true; },
      terminated: false,
    };
    await expect(readClaudeAuthStatus({
      configDir: CONFIG_DIR,
      processFactory: () => process,
      resolveRuntime: async () => runtime,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "PROCESS_EXITED" });
    expect(process.terminated).toBe(true);
    expect(process.forced).toBe(true);
  });
});

describe("Claude foreground login", () => {
  test("consumes interruption before spawn without creating a child", async () => {
    for (const interruptedBy of ["SIGINT", "SIGTERM"] as const) {
      let spawnCalls = 0;
      await expect(runClaudeForegroundLogin({
        configDir: CONFIG_DIR,
        processFactory: () => {
          spawnCalls += 1;
          throw new Error("must not spawn");
        },
        runtime,
        signal: new AbortController().signal,
        signalSource: new ImmediateSignalSource(interruptedBy),
        stdio: { stdin: 0, stdout: 1, stderr: 2 },
      })).resolves.toEqual({
        state: "not_started",
        reason: "interrupted_before_spawn",
        interruptedBy,
      });
      expect(spawnCalls).toBe(0);
    }

    const controller = new AbortController();
    controller.abort();
    let spawnCalls = 0;
    await expect(runClaudeForegroundLogin({
      configDir: CONFIG_DIR,
      processFactory: () => {
        spawnCalls += 1;
        throw new Error("must not spawn");
      },
      runtime,
      signal: controller.signal,
      stdio: { stdin: 0, stdout: 1, stderr: 2 },
    })).resolves.toEqual({
      state: "not_started",
      reason: "interrupted_before_spawn",
      interruptedBy: "SIGTERM",
    });
    expect(spawnCalls).toBe(0);
  });

  test("runs the exact subscription-login argv with explicit stdio and scrubbed env", async () => {
    let launch: Parameters<NonNullable<Parameters<typeof runClaudeForegroundLogin>[0]["processFactory"]>>[0] | undefined;
    const result = await runClaudeForegroundLogin({
      configDir: CONFIG_DIR,
      environment: {
        ANTHROPIC_API_KEY: "must-not-cross",
        HOME: "/Users/test",
        PATH: "/usr/bin:/bin",
      },
      processFactory: (input) => {
        launch = input;
        return {
          exited: Promise.resolve(0),
          forceTerminate: () => undefined,
          sendSignal: () => undefined,
        };
      },
      resolveRuntime: async () => runtime,
      signal: new AbortController().signal,
      signalSource: new FakeSignalSource(),
      stdio: { stdin: 10, stdout: 11, stderr: 12 },
    });
    expect(result).toEqual({ state: "joined", exitCode: 0, interruptedBy: null });
    expect(launch).toEqual({
      argv: [runtime.executablePath, "auth", "login", "--claudeai"],
      environment: {
        CLAUDE_CONFIG_DIR: CONFIG_DIR,
        HOME: "/Users/test",
        NO_COLOR: "1",
        PATH: "/usr/bin:/bin",
      },
      stdin: 10,
      stdout: 11,
      stderr: 12,
    });
  });

  test("does not double-forward terminal process-group signals", async () => {
    const signalSource = new FakeSignalSource();
    const forwarded: ClaudeLoginSignal[] = [];
    let resolveExit!: (code: number) => void;
    const pending = runClaudeForegroundLogin({
      configDir: CONFIG_DIR,
      processFactory: () => ({
        exited: new Promise((resolve) => { resolveExit = resolve; }),
        forceTerminate: () => undefined,
        sendSignal: (signal) => { forwarded.push(signal); },
      }),
      resolveRuntime: async () => runtime,
      signal: new AbortController().signal,
      signalSource,
      stdio: { stdin: 0, stdout: 1, stderr: 2 },
    });
    await Promise.resolve();
    signalSource.emit("SIGINT");
    resolveExit(130);
    await expect(pending).resolves.toEqual({ state: "joined", exitCode: 130, interruptedBy: "SIGINT" });
    expect(forwarded).toEqual([]);
    expect(signalSource.listeners.get("SIGINT")?.size ?? 0).toBe(0);
    expect(signalSource.listeners.get("SIGTERM")?.size ?? 0).toBe(0);
  });

  test("forwards only explicit abort, force-terminates, and joins the child", async () => {
    const controller = new AbortController();
    const forwarded: ClaudeLoginSignal[] = [];
    let resolveExit!: (code: number) => void;
    let spawned!: () => void;
    const didSpawn = new Promise<void>((resolve) => { spawned = resolve; });
    const pending = runClaudeForegroundLogin({
      configDir: CONFIG_DIR,
      processFactory: () => {
        spawned();
        return {
          exited: new Promise((resolve) => { resolveExit = resolve; }),
          forceTerminate: () => { resolveExit(137); },
          sendSignal: (signal) => { forwarded.push(signal); },
        };
      },
      resolveRuntime: async () => runtime,
      signal: controller.signal,
      signalGraceMs: 1,
      stdio: { stdin: 0, stdout: 1, stderr: 2 },
    });
    await didSpawn;
    controller.abort();
    await expect(pending).resolves.toEqual({ state: "joined", exitCode: 137, interruptedBy: "SIGTERM" });
    expect(forwarded).toEqual(["SIGTERM"]);
  });

  test("force-terminates when the foreground exit observer rejects", async () => {
    let forced = false;
    await expect(runClaudeForegroundLogin({
      configDir: CONFIG_DIR,
      processFactory: () => ({
        exited: Promise.reject(new Error("broken foreground wait")),
        forceTerminate: () => { forced = true; },
        sendSignal: () => undefined,
      }),
      runtime,
      signal: new AbortController().signal,
      signalSource: new FakeSignalSource(),
      stdio: { stdin: 0, stdout: 1, stderr: 2 },
    })).rejects.toMatchObject({ code: "PROCESS_EXITED" });
    expect(forced).toBe(true);
  });
});
