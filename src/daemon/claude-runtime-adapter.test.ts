import { describe, expect, spyOn, test } from "bun:test";
import { lstatSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ClaudeAuthStatusReader,
  ClaudeHostToolBindingIdentity,
  ClaudeHostToolBindingLease,
  ClaudeHostToolCall,
  ClaudeHostToolPublicResult,
  ClaudeProcess,
  ClaudeProcessIdentity,
  PinnedClaudeRuntime,
} from "../claude/index";
import { ClaudeDeltaAssembler } from "../claude/assembler";
import { ClaudeError } from "../claude/errors";
import { CLAUDE_PIN, CLAUDE_PIN_EFFORT, CLAUDE_PIN_MODEL, CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY } from "../claude/pin";
import { presetRequirements, PresetProviderMismatchError } from "../domain/presets";
import {
  CLAUDE_HOST_TOOL_SESSION_HISTORY_LIMIT,
  digestClaudeHostToolInvocation,
} from "../claude/index";
import type { HraHostToolCall } from "../codex/protocol";
import { HRA_SESSION_PREAMBLE } from "../domain/hra-preamble";
import { effectiveClaudeRuntimeProfileSchema } from "../domain/runtime-profile";
import { ensurePrivateDirectory } from "../storage/paths";
import {
  PinnedClaudeRuntimeManager,
  type ClaudeProcessFactory,
  type ClaudeSessionFact,
} from "./claude-runtime-adapter";
import {
  ClaudeProcessExitUnprovenError,
  ClaudeSessionObservationError,
  type ProfileAuthority,
} from "./ports";

const CONFIG_DIR = "/var/hra/profiles/acct/claude";
const PROJECT_ROOT = "/var/hra/projects/demo";
const ADOPTED_PROVIDER_THREAD_ID = "726b1b3d-ed97-4b55-9904-e58fa7d7eb45";
const ADOPTED_TITLE = "Existing Claude conversation";
const PROCESS_IDENTITY: ClaudeProcessIdentity = Object.freeze({
  pid: 8_123,
  pidDomain: "darwin",
  procStart: "Fri Sep  4 12:00:00 2026",
});
const HOST_TOOL_PRIVATE_ROOT = "/var/hra/private";
const HOST_TOOL_SOCKET = "/var/hra/private/callback.sock";

const authority: ProfileAuthority = {
  codexHome: "/var/hra/profiles/acct/codex",
  desktopUserData: "/var/hra/profiles/acct/desktop",
  generation: 3,
  id: "acct_00000000000000000000000000000000",
  provider: "claude",
  providerAccountId: "pact_00000000000000000000000000000000",
  bindingGeneration: 1,
};

class FakeClaudeProcess implements ClaudeProcess {
  readonly written: string[] = [];
  readonly signals: string[] = [];
  terminated = false;
  readonly identity: Promise<ClaudeProcessIdentity>;
  readonly #ignoreTerm: boolean;
  readonly #ignoreKill: boolean;
  onTerminate: (() => void) | undefined;
  onWrite: (() => void) | undefined;
  #push: ((chunk: Uint8Array) => void) | undefined;
  #finish: (() => void) | undefined;
  #resolveExit: ((code: number) => void) | undefined;
  readonly exited: Promise<number>;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array> = { async *[Symbol.asyncIterator]() { /* silent */ } };

  constructor(options: Readonly<{
    identity?: Promise<ClaudeProcessIdentity>;
    ignoreKill?: boolean;
    ignoreTerm?: boolean;
  }> = {}) {
    this.identity = options.identity ?? Promise.resolve(PROCESS_IDENTITY);
    this.#ignoreKill = options.ignoreKill ?? false;
    this.#ignoreTerm = options.ignoreTerm ?? false;
    this.exited = new Promise((resolve) => { this.#resolveExit = resolve; });
    const queue: Uint8Array[] = [];
    let waiter: (() => void) | undefined;
    let done = false;
    this.#push = (chunk) => { queue.push(chunk); waiter?.(); waiter = undefined; };
    this.#finish = () => { done = true; waiter?.(); waiter = undefined; };
    this.stdout = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const chunk = queue.shift();
          if (chunk !== undefined) { yield chunk; continue; }
          if (done) return;
          await new Promise<void>((resolve) => { waiter = resolve; });
        }
      },
    };
  }

  emit(...lines: readonly unknown[]): void {
    this.#push?.(new TextEncoder().encode(lines.map((line) => `${JSON.stringify(line)}\n`).join("")));
  }

  async write(bytes: Uint8Array): Promise<void> {
    this.written.push(new TextDecoder().decode(bytes));
    this.onWrite?.();
  }

  endOutput(): void {
    this.#finish?.();
  }

  terminate(): void {
    this.terminated = true;
    this.signals.push("SIGTERM");
    this.onTerminate?.();
    if (this.#ignoreTerm) return;
    this.end();
  }

  end(): void {
    this.#finish?.();
    this.#resolveExit?.(0);
  }

  forceTerminate(): void {
    this.terminated = true;
    this.signals.push("SIGKILL");
    if (!this.#ignoreKill) this.end();
  }
}

class FakeClaudeBindingAuthority {
  readonly provisions: Array<Readonly<{
    callbackSocketPath: string;
    identity: ClaudeHostToolBindingIdentity;
    privateRoot: string;
  }>> = [];
  readonly activations: string[] = [];
  readonly rebinds: Array<Readonly<{
    bindingId: string;
    expectedIdentity: ClaudeHostToolBindingIdentity;
    nextIdentity: ClaudeHostToolBindingIdentity;
  }>> = [];
  readonly revocations: string[] = [];
  failRevocations: number;
  revokeGate: Promise<void> | undefined;

  constructor(failRevocations = 0) {
    this.failRevocations = failRevocations;
  }

  async provision(input: {
    callbackSocketPath: string;
    identity: ClaudeHostToolBindingIdentity;
    privateRoot: string;
  }): Promise<ClaudeHostToolBindingLease> {
    this.provisions.push(input);
    const suffix = String(this.provisions.length);
    return {
      bindingId: `clhb_${suffix.padStart(32, "0")}`,
      bindingPath: `${HOST_TOOL_PRIVATE_ROOT}/binding-${suffix}/binding.json`,
      directory: `${HOST_TOOL_PRIVATE_ROOT}/binding-${suffix}`,
      mcpConfigPath: `${HOST_TOOL_PRIVATE_ROOT}/binding-${suffix}/mcp.json`,
    };
  }

  activate(bindingId: string): Promise<void> {
    this.activations.push(bindingId);
    return Promise.resolve();
  }

  rebind(bindingId: string, input: Readonly<{
    expectedIdentity: ClaudeHostToolBindingIdentity;
    nextIdentity: ClaudeHostToolBindingIdentity;
  }>): void {
    this.rebinds.push({ bindingId, ...input });
  }

  async revoke(bindingId: string): Promise<void> {
    this.revocations.push(bindingId);
    if (this.failRevocations > 0) {
      this.failRevocations -= 1;
      throw new Error("injected binding cleanup failure");
    }
    await this.revokeGate;
  }
}

const runtime: PinnedClaudeRuntime = {
  argv: [
    "/usr/local/bin/claude",
    "--print",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    "default",
    "--model",
    CLAUDE_PIN_MODEL,
    "--effort",
    CLAUDE_PIN_EFFORT,
    "--system-prompt-snapshot",
    "on",
  ],
  effort: CLAUDE_PIN_EFFORT,
  executablePath: "/usr/local/bin/claude",
  model: CLAUDE_PIN_MODEL,
  nativeFallback: CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY,
  version: CLAUDE_PIN,
};

const settle = async (): Promise<void> => {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  await new Promise((resolve) => { setTimeout(resolve, 1); });
};

type InitializationOverride = Readonly<{
  model?: string;
  permissionMode?: string;
  providerThreadId?: string;
  version?: string;
}>;

const harness = (options: {
  bindingAuthority?: FakeClaudeBindingAuthority;
  clientShutdownSettlementMs?: number;
  clientShutdownTermGraceMs?: number;
  configDirFor?: ConstructorParameters<typeof PinnedClaudeRuntimeManager>[0]["configDirFor"];
  configHome?: "isolated" | "personal";
  exitAfterInitialization?: boolean;
  initialization?: InitializationOverride | "silent";
  initializationTimeoutMs?: number;
  isCurrent?: ConstructorParameters<typeof PinnedClaudeRuntimeManager>[0]["isCurrent"];
  onFact?: (
    authority: ProfileAuthority,
    fact: ClaudeSessionFact,
  ) => void | Promise<void>;
  processIdentity?: ClaudeProcessIdentity | "reject";
  processIgnoresKill?: boolean;
  processIgnoresTerm?: boolean;
  hostTool?: (call: HraHostToolCall) => ClaudeHostToolPublicResult | Promise<ClaudeHostToolPublicResult>;
  hostToolResponseWritten?: (call: HraHostToolCall) => void | Promise<void>;
  processFactory?: ConstructorParameters<typeof PinnedClaudeRuntimeManager>[0]["processFactory"];
  readAuthStatus?: ClaudeAuthStatusReader;
  resolveRuntime?: ConstructorParameters<typeof PinnedClaudeRuntimeManager>[0]["resolveRuntime"];
} = {}) => {
  const facts: ClaudeSessionFact[] = [];
  const processes: FakeClaudeProcess[] = [];
  const launches: Parameters<ClaudeProcessFactory>[0][] = [];
  const launchedRuntimes: PinnedClaudeRuntime[] = [];
  const bindingAuthority = options.bindingAuthority ?? new FakeClaudeBindingAuthority();
  const manager = new PinnedClaudeRuntimeManager({
    configHome: options.configHome ?? "isolated",
    configDirFor: options.configDirFor ?? (() => CONFIG_DIR),
    ...(options.clientShutdownSettlementMs === undefined
      ? {}
      : { clientShutdownSettlementMs: options.clientShutdownSettlementMs }),
    ...(options.clientShutdownTermGraceMs === undefined
      ? {}
      : { clientShutdownTermGraceMs: options.clientShutdownTermGraceMs }),
    ...(options.initializationTimeoutMs === undefined
      ? {}
      : { initializationTimeoutMs: options.initializationTimeoutMs }),
    isCurrent: options.isCurrent ?? (() => true),
    now: () => 1_700_000_000_000,
    hostTools: {
      bindingAuthority,
      callbackSocketPath: HOST_TOOL_SOCKET,
      privateRoot: HOST_TOOL_PRIVATE_ROOT,
    },
    observer: {
      fact: (factAuthority, fact) => {
        facts.push(fact);
        return options.onFact?.(factAuthority, fact);
      },
      ...(options.hostTool === undefined
        ? {}
        : { hraHostTool: (_authority: ProfileAuthority, call: HraHostToolCall) => options.hostTool?.(call) ?? "" }),
      ...(options.hostToolResponseWritten === undefined
        ? {}
        : {
            hraHostToolResponseWritten: (
              _authority: ProfileAuthority,
              call: HraHostToolCall,
            ) => options.hostToolResponseWritten?.(call),
          }),
    },
    processFactory: (launch) => {
      launches.push(launch);
      launchedRuntimes.push(launch.runtime);
      const process = options.processFactory?.(launch) ?? new FakeClaudeProcess({
          identity: options.processIdentity === "reject"
            ? Promise.reject(new Error("identity unavailable"))
            : Promise.resolve(options.processIdentity ?? PROCESS_IDENTITY),
          ...(options.processIgnoresKill === undefined
            ? {}
            : { ignoreKill: options.processIgnoresKill }),
          ...(options.processIgnoresTerm === undefined
            ? {}
            : { ignoreTerm: options.processIgnoresTerm }),
        });
      if (!(process instanceof FakeClaudeProcess)) return process;
      processes.push(process);
      if (options.initialization !== "silent") {
        const override = options.initialization ?? {};
        const requestedId = launch.argv.at(-1);
        if (requestedId === undefined) throw new Error("expected a session-bound Claude argv");
        queueMicrotask(() => {
          process.emit({
            claude_code_version: override.version ?? CLAUDE_PIN,
            model: override.model ?? CLAUDE_PIN_MODEL,
            permissionMode: override.permissionMode ?? "default",
            session_id: override.providerThreadId ?? requestedId,
            subtype: "init",
            tools: ["Bash"],
            type: "system",
          });
          if (options.exitAfterInitialization === true) process.end();
        });
      }
      return process;
    },
    readAuthStatus: options.readAuthStatus ?? (async () => ({ signedIn: false })),
    resolveRuntime: options.resolveRuntime ?? (async () => runtime),
  });
  return { bindingAuthority, facts, launches, launchedRuntimes, manager, processes };
};

const signal = (): AbortSignal => new AbortController().signal;

const startSession = async (
  manager: PinnedClaudeRuntimeManager,
): Promise<string> => {
  const review = await manager.reviewSessionStart({
    authority,
    fast: false,
    preset: "fable-max",
    requirement: presetRequirements["fable-max"],
    projectRoot: PROJECT_ROOT,
    signal: signal(),
  });
  const started = await manager.startSession({ authority, review, signal: signal() });
  await manager.activateSessionHostTools({
    authority,
    providerThreadId: started.providerThreadId,
    signal: signal(),
  });
  return started.providerThreadId;
};

const hostToolCall = (
  providerThreadId: string,
  bindingId: string,
  callId: string,
): ClaudeHostToolCall => {
  const request = { input: {}, tool: "sessions_list" } as const;
  return {
    bindingId,
    callId,
    processGeneration: authority.generation,
    profileId: authority.id,
    provider: "claude",
    providerThreadId,
    request,
    requestDigest: digestClaudeHostToolInvocation(callId, request),
  };
};

const startTurn = async (
  manager: PinnedClaudeRuntimeManager,
  providerThreadId: string,
  message: string,
): Promise<string> => {
  const review = await manager.reviewTurnStart({
    authority,
    fast: false,
    preset: "fable-max",
    requirement: presetRequirements["fable-max"],
    projectRoot: PROJECT_ROOT,
    providerThreadId,
    signal: signal(),
  });
  const turn = await manager.startTurn({
    authority,
    clientMessageId: "client-1",
    message,
    providerThreadId,
    review,
    signal: signal(),
  });
  return turn.turnId;
};

describe("pinned Claude runtime manager", () => {
  test("retains the exact child after an observer-local cleanup join is refused", async () => {
    let closeError: unknown;
    let observedResult!: () => void;
    const resultObserved = new Promise<void>((resolve) => { observedResult = resolve; });
    const value = harness({
      onFact: async (factAuthority, fact) => {
        if (fact.type === "turnStarted") {
          try {
            await value.manager.endSession({
              authority: factAuthority, providerThreadId: fact.providerThreadId, signal: signal(),
            });
          } catch (error: unknown) { closeError = error; }
        }
        if (fact.type === "turnSummary") observedResult();
      },
    });
    try {
      const providerThreadId = await startSession(value.manager);
      const turnId = await startTurn(value.manager, providerThreadId, "Keep exact cleanup custody");
      expect(closeError).toMatchObject({ code: "INVALID_INPUT" });
      const process = value.processes[0];
      if (process === undefined) throw new Error("expected the exact child");
      expect(process.signals).toEqual([]);
      await expect(value.manager.readSessionProcessIdentity({ authority, providerThreadId, signal: signal() }))
        .resolves.toEqual(PROCESS_IDENTITY);
      await expect(value.manager.observeSession({ authority, providerThreadId, signal: signal() }))
        .rejects.toBeInstanceOf(ClaudeSessionObservationError);
      await expect(startSession(value.manager)).rejects.toThrow("still unjoined");
      expect(value.processes).toHaveLength(1);
      process.emit({
        type: "result", session_id: providerThreadId, subtype: "success", is_error: false,
        result: "Actual result remains observable", duration_ms: 1,
        usage: { input_tokens: 1, output_tokens: 2 },
      });
      await resultObserved;
      expect(value.facts.filter((fact) => fact.type === "turnSummary"))
        .toMatchObject([{ turnId, status: "completed", resultText: "Actual result remains observable" }]);
      await value.manager.endSession({ authority, providerThreadId, signal: signal() });
      expect(process.signals).toEqual(["SIGTERM"]);
      await expect(value.manager.readSessionProcessIdentity({ authority, providerThreadId, signal: signal() }))
        .rejects.toThrow("not running");
      await startSession(value.manager);
      expect(value.processes).toHaveLength(2);
    } finally { await value.manager.close(); }
  });

  test("rejects another provider before reviewing or spawning Claude", async () => {
    const { manager, processes } = harness();
    await expect(manager.reviewSessionStart({
      authority: {
        ...authority,
        provider: "codex",
        providerAccountId: "acct_00000000000000000000000000000000",
      },
      fast: false,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    })).rejects.toThrow("authority changed");
    expect(processes).toHaveLength(0);
    await manager.close();
  });

  test("keeps reviewed adoption identity separate from readiness and rejects a retired identity read", async () => {
    let current = true;
    let retireDuringRead = false;
    let reads = 0;
    const identity = {
      accountId: "claude-account",
      email: "claude@example.com",
      organizationId: "claude-organization",
      signedIn: true,
    };
    const { manager, processes } = harness({
      isCurrent: () => current,
      readAuthStatus: async () => {
        reads += 1;
        if (retireDuringRead) current = false;
        return identity;
      },
    });
    await expect(manager.readProviderAccountIdentity({ authority, signal: signal() }))
      .resolves.toEqual(identity);
    await expect(manager.readAccount({ authority, signal: signal() })).resolves.toEqual({
      observedAt: 1_700_000_000_000,
      readiness: "signed_in",
    });
    retireDuringRead = true;
    await expect(manager.readProviderAccountIdentity({ authority, signal: signal() }))
      .rejects.toMatchObject({ code: "AUTHORITY_STALE" });
    await expect(manager.readProviderAccountIdentity({ authority, signal: signal() }))
      .rejects.toMatchObject({ code: "AUTHORITY_STALE" });
    expect(reads).toBe(3);
    expect(processes).toHaveLength(0);
    await manager.close();
  });

  test("reports unverified when the pinned runtime cannot be admitted for an auth observation", async () => {
    let probed = false;
    const manager = new PinnedClaudeRuntimeManager({
      configHome: "isolated",
      configDirFor: () => CONFIG_DIR,
      isCurrent: () => true,
      now: () => 1_700_000_000_123,
      observer: { fact: () => undefined },
      hostTools: {
        bindingAuthority: new FakeClaudeBindingAuthority(),
        callbackSocketPath: HOST_TOOL_SOCKET,
        privateRoot: HOST_TOOL_PRIVATE_ROOT,
      },
      readAuthStatus: async () => {
        probed = true;
        return { signedIn: true };
      },
      resolveRuntime: async () => { throw new Error("not installed"); },
    });
    await expect(manager.readAccount({ authority, signal: signal() })).resolves.toEqual({
      observedAt: 1_700_000_000_123,
      readiness: "unverified",
    });
    expect(probed).toBe(false);
    await manager.close();
  });

  test.each(["account", "session review", "turn review"] as const)(
    "cancels an in-flight version probe during %s admission",
    async (operation) => {
      const controller = new AbortController();
      let markProbeStarted!: () => void;
      const probeStarted = new Promise<void>((resolve) => { markProbeStarted = resolve; });
      let releaseProbe!: () => void;
      let probeCanceled = false;
      let authReads = 0;
      const { manager, processes } = harness({
        readAuthStatus: async () => {
          authReads += 1;
          return { signedIn: true };
        },
        resolveRuntime: (input) => new Promise((resolve, reject) => {
          const abort = () => {
            probeCanceled = true;
            reject(new Error("Version probe canceled after cleanup"));
          };
          input.signal?.addEventListener("abort", abort, { once: true });
          releaseProbe = () => {
            input.signal?.removeEventListener("abort", abort);
            resolve(runtime);
          };
          markProbeStarted();
        }),
      });
      const review = {
        authority,
        fast: false,
        preset: "fable-max" as const,
        requirement: presetRequirements["fable-max"],
        projectRoot: PROJECT_ROOT,
        signal: controller.signal,
      };
      const pending = operation === "account"
        ? manager.readAccount({ authority, signal: controller.signal })
        : operation === "session review"
          ? manager.reviewSessionStart(review)
          : manager.reviewTurnStart({ ...review, providerThreadId: "claude-session-1" });
      void pending.catch(() => undefined);
      try {
        await probeStarted;
        controller.abort();
        expect(probeCanceled).toBe(true);
        // Caller cancellation remains cancellation even when the underlying
        // version probe rejects while cleaning itself up. Misclassifying this
        // as an installation mismatch would give unsafe retry guidance.
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect(authReads).toBe(0);
        expect(processes).toHaveLength(0);
      } finally {
        releaseProbe();
        await pending.catch(() => undefined);
        await manager.close();
      }
    },
  );

  test("reports Claude's isolated auth status rather than inferring it from sessions", async () => {
    let signedIn = false;
    const reads: Readonly<{ configDir: string; signal: AbortSignal }>[] = [];
    const { manager } = harness({
      readAuthStatus: (input) => {
        reads.push(input);
        return Promise.resolve({ signedIn });
      },
    });
    expect(await manager.readAccount({ authority, signal: signal() })).toEqual({ readiness: "signed_out", observedAt: 1_700_000_000_000 });
    await startSession(manager);
    // A running process is not evidence that the isolated home is currently
    // authenticated; only Claude's own status command is authoritative.
    expect(await manager.readAccount({ authority, signal: signal() })).toEqual({ readiness: "signed_out", observedAt: 1_700_000_000_000 });
    signedIn = true;
    expect(await manager.readAccount({ authority, signal: signal() })).toEqual({ readiness: "signed_in", observedAt: 1_700_000_000_000 });
    expect(reads.map(({ configDir }) => configDir)).toEqual([
      CONFIG_DIR,
      CONFIG_DIR,
      CONFIG_DIR,
    ]);
    await manager.close();
  });

  test("permits an exact initial-generation account observation but no session effect", async () => {
    const initialAuthority = { ...authority, generation: 0 };
    let current = true;
    let statusReads = 0;
    const { manager, processes } = harness({
      isCurrent: (candidate) => current && candidate === initialAuthority,
      readAuthStatus: async () => {
        statusReads += 1;
        return { signedIn: false };
      },
    });
    await expect(manager.readAccount({ authority: initialAuthority, signal: signal() }))
      .resolves.toEqual({ readiness: "signed_out", observedAt: 1_700_000_000_000 });
    await expect(manager.reviewSessionStart({
      authority: initialAuthority,
      fast: false,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    })).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
    current = false;
    await expect(manager.readAccount({ authority: initialAuthority, signal: signal() }))
      .rejects.toMatchObject({ code: "AUTHORITY_STALE" });
    expect(statusReads).toBe(1);
    expect(processes).toHaveLength(0);
    await manager.close();
  });

  test("keeps malformed auth evidence unverified without swallowing custody failures", async () => {
    const malformed = harness({
      readAuthStatus: async () => { throw new ClaudeError("PROTOCOL_ERROR", "invalid status"); },
    });
    expect(await malformed.manager.readAccount({ authority, signal: signal() })).toEqual({
      readiness: "unverified",
      observedAt: 1_700_000_000_000,
    });
    await malformed.manager.close();

    for (const code of ["CONFIG_DIR_MISMATCH", "PROCESS_EXITED", "TIMEOUT"] as const) {
      const unsafe = harness({
        readAuthStatus: async () => { throw new ClaudeError(code, "custody not proven"); },
      });
      await expect(unsafe.manager.readAccount({ authority, signal: signal() }))
        .rejects.toMatchObject({ code });
      await unsafe.manager.close();
    }
  });

  test("requires the exact durable model and effort before admitting a review", async () => {
    for (const requirement of [
      { model: "claude-opus-4-6", effort: "max" as const },
      { model: CLAUDE_PIN_MODEL, effort: "ultra" as const },
    ]) {
      const { manager, processes } = harness();
      await expect(manager.reviewSessionStart({
        authority,
        fast: false,
        preset: "fable-max",
        requirement,
        projectRoot: PROJECT_ROOT,
        signal: signal(),
      })).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
      expect(processes).toEqual([]);
      await manager.close();
    }
  });

  test("refuses a Claude config directory symlinked across account custody before any launch", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "hra-claude-config-link-")));
    try {
      const sourceRoot = join(root, "profiles", "source");
      const target = join(root, "profiles", "target", "claude-config");
      const source = join(sourceRoot, "claude-config");
      await mkdir(sourceRoot, { mode: 0o700, recursive: true });
      await mkdir(target, { mode: 0o700, recursive: true });
      await symlink(target, source, "dir");
      let statusLaunches = 0;
      let runtimeLaunches = 0;
      const { manager } = harness({
        configDirFor: async () => await ensurePrivateDirectory(source),
        readAuthStatus: async () => {
          statusLaunches += 1;
          return { signedIn: true };
        },
        resolveRuntime: async () => {
          runtimeLaunches += 1;
          return runtime;
        },
      });

      await expect(manager.readAccount({ authority, signal: signal() }))
        .rejects.toThrow(/regular directory|symbolic link/u);
      await expect(manager.reviewSessionStart({
        authority,
        fast: false,
        preset: "fable-max",
        requirement: presetRequirements["fable-max"],
        projectRoot: PROJECT_ROOT,
        signal: signal(),
      })).rejects.toThrow(/regular directory|symbolic link/u);
      expect({ runtimeLaunches, statusLaunches }).toEqual({
        runtimeLaunches: 0,
        statusLaunches: 0,
      });
      await manager.close();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("repairs owned permissive Claude config custody immediately before each launch", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "hra-claude-config-mode-")));
    try {
      const configDir = join(root, "claude-config");
      await mkdir(configDir, { mode: 0o700 });
      const launchModes: number[] = [];
      const { manager } = harness({
        configDirFor: async () => await ensurePrivateDirectory(configDir),
        processFactory: () => {
          launchModes.push(lstatSync(configDir).mode & 0o777);
          return new FakeClaudeProcess();
        },
        readAuthStatus: async () => {
          launchModes.push((await lstat(configDir)).mode & 0o777);
          return { signedIn: true };
        },
        resolveRuntime: async () => {
          launchModes.push((await lstat(configDir)).mode & 0o777);
          return runtime;
        },
      });

      await chmod(configDir, 0o777);
      await manager.readAccount({ authority, signal: signal() });
      await chmod(configDir, 0o777);
      const review = await manager.reviewSessionStart({
        authority,
        fast: false,
        preset: "fable-max",
        requirement: presetRequirements["fable-max"],
        projectRoot: PROJECT_ROOT,
        signal: signal(),
      });
      await chmod(configDir, 0o777);
      await manager.startSession({ authority, review, signal: signal() });
      expect(launchModes).toEqual([0o700, 0o700, 0o700, 0o700]);
      await manager.close();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("refuses a wrong-shaped Claude config path before status or runtime admission", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "hra-claude-config-shape-")));
    try {
      const configDir = join(root, "claude-config");
      await writeFile(configDir, "not a directory", { mode: 0o600 });
      let statusLaunches = 0;
      let runtimeLaunches = 0;
      const { manager } = harness({
        configDirFor: async () => await ensurePrivateDirectory(configDir),
        readAuthStatus: async () => {
          statusLaunches += 1;
          return { signedIn: true };
        },
        resolveRuntime: async () => {
          runtimeLaunches += 1;
          return runtime;
        },
      });

      await expect(manager.readAccount({ authority, signal: signal() })).rejects.toThrow();
      await expect(manager.reviewSessionStart({
        authority,
        fast: false,
        preset: "fable-max",
        requirement: presetRequirements["fable-max"],
        projectRoot: PROJECT_ROOT,
        signal: signal(),
      })).rejects.toThrow();
      expect({ runtimeLaunches, statusLaunches }).toEqual({
        runtimeLaunches: 0,
        statusLaunches: 0,
      });
      await manager.close();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("does not launch or retain status, review, or session state after close wins custody awaits", async () => {
    let releaseStatusConfig!: (value: string) => void;
    const statusConfig = new Promise<string>((resolve) => { releaseStatusConfig = resolve; });
    let statusLaunches = 0;
    const statusHarness = harness({
      configDirFor: () => statusConfig,
      readAuthStatus: async () => {
        statusLaunches += 1;
        return { signedIn: true };
      },
    });
    const pendingStatus = statusHarness.manager.readAccount({ authority, signal: signal() });
    const statusOutcome = pendingStatus.catch((error: unknown) => error);
    await statusHarness.manager.close();
    releaseStatusConfig(CONFIG_DIR);
    expect(await statusOutcome).toMatchObject({ message: expect.stringContaining("closed") });
    expect(statusLaunches).toBe(0);

    let enteredRuntime!: () => void;
    let releaseRuntime!: (value: PinnedClaudeRuntime) => void;
    const runtimeEntered = new Promise<void>((resolve) => { enteredRuntime = resolve; });
    const deferredRuntime = new Promise<PinnedClaudeRuntime>((resolve) => { releaseRuntime = resolve; });
    const reviewHarness = harness({
      resolveRuntime: async () => {
        enteredRuntime();
        return await deferredRuntime;
      },
    });
    const pendingReview = reviewHarness.manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    });
    await runtimeEntered;
    const reviewOutcome = pendingReview.catch((error: unknown) => error);
    await reviewHarness.manager.close();
    releaseRuntime(runtime);
    expect(await reviewOutcome).toMatchObject({ message: expect.stringContaining("closed") });
    expect(reviewHarness.processes).toEqual([]);

    let configCalls = 0;
    let releaseSessionConfig!: (value: string) => void;
    const sessionConfig = new Promise<string>((resolve) => { releaseSessionConfig = resolve; });
    let sessionLaunches = 0;
    const sessionHarness = harness({
      configDirFor: () => {
        configCalls += 1;
        return configCalls === 1 ? CONFIG_DIR : sessionConfig;
      },
      processFactory: () => {
        sessionLaunches += 1;
        return new FakeClaudeProcess();
      },
    });
    const review = await sessionHarness.manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    });
    const pendingSession = sessionHarness.manager.startSession({
      authority,
      review,
      signal: signal(),
    });
    const sessionOutcome = pendingSession.catch((error: unknown) => error);
    await sessionHarness.manager.close();
    releaseSessionConfig(CONFIG_DIR);
    expect(await sessionOutcome).toMatchObject({ message: expect.stringContaining("closed") });
    expect(sessionLaunches).toBe(0);
    await expect(sessionHarness.manager.startSession({ authority, review, signal: signal() }))
      .rejects.toThrow("closed");
  });

  test("joins a spawned child when account authority changes before session insertion", async () => {
    let current = true;
    const termination: string[] = [];
    let child: FakeClaudeProcess | undefined;
    const { manager } = harness({
      isCurrent: () => current,
      processFactory: () => {
        const process = new FakeClaudeProcess();
        const exit = process.terminate.bind(process);
        process.terminate = () => { termination.push("terminate"); };
        process.forceTerminate = () => {
          termination.push("force");
          exit();
        };
        child = process;
        current = false;
        return process;
      },
    });
    const review = await manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    });

    await expect(manager.startSession({ authority, review, signal: signal() }))
      .rejects.toThrow("authority changed");

    expect(termination).toEqual(["terminate", "force"]);
    expect(child).toBeDefined();
    if (child === undefined) throw new Error("Claude child was not launched.");
    await expect(child.exited).resolves.toBe(0);
    await manager.close();
  });

  test("retains a post-launch authority failure until the exact child can be joined", async () => {
    const alternateAuthority: ProfileAuthority = {
      ...authority,
      codexHome: "/var/hra/profiles/alternate/codex",
      desktopUserData: "/var/hra/profiles/alternate/desktop",
      generation: 1,
      id: "acct_11111111111111111111111111111111",
    };
    let current = true;
    let launches = 0;
    let forceAttempts = 0;
    const terminations: string[] = [];
    let child: FakeClaudeProcess | undefined;
    const { manager } = harness({
      clientShutdownSettlementMs: 5,
      clientShutdownTermGraceMs: 1,
      isCurrent: (candidate) => candidate.id === alternateAuthority.id || current,
      processFactory: () => {
        launches += 1;
        const process = new FakeClaudeProcess();
        const exit = process.terminate.bind(process);
        process.terminate = () => { terminations.push("terminate"); };
        process.forceTerminate = () => {
          terminations.push("force");
          forceAttempts += 1;
          if (forceAttempts === 2) exit();
        };
        child = process;
        current = false;
        return process;
      },
    });
    const alternateReview = await manager.reviewSessionStart({
      authority: alternateAuthority,
      fast: false,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    });
    const review = await manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    });

    await expect(manager.startSession({ authority, review, signal: signal() }))
      .rejects.toBeInstanceOf(ClaudeProcessExitUnprovenError);
    expect(launches).toBe(1);
    expect(terminations).toEqual(["terminate", "force"]);

    await expect(manager.reviewSessionStart({
      authority: alternateAuthority,
      fast: false,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    })).rejects.toThrow("still unjoined");
    await expect(manager.startSession({
      authority: alternateAuthority,
      review: alternateReview,
      signal: signal(),
    })).rejects.toThrow("still unjoined");
    expect(launches).toBe(1);

    await manager.close();
    expect(terminations).toEqual(["terminate", "force", "terminate", "force"]);
    expect(launches).toBe(1);
    expect(child).toBeDefined();
    if (child === undefined) throw new Error("Claude child was not launched.");
    await expect(child.exited).resolves.toBe(0);

    // Once the exact child is joined, close is idempotent and cannot launch or
    // signal anything new on behalf of the failed session start.
    await manager.close();
    expect(terminations).toEqual(["terminate", "force", "terminate", "force"]);
    expect(launches).toBe(1);
  });

  test("retains an unjoined session child and retries its exact close before forgetting it", async () => {
    const terminations: string[] = [];
    let forceAttempts = 0;
    const { manager } = harness({
      clientShutdownSettlementMs: 5,
      clientShutdownTermGraceMs: 1,
      processFactory: () => {
        const process = new FakeClaudeProcess();
        const exit = process.terminate.bind(process);
        process.terminate = () => { terminations.push("terminate"); };
        process.forceTerminate = () => {
          terminations.push("force");
          forceAttempts += 1;
          if (forceAttempts === 2) exit();
        };
        return process;
      },
    });
    const providerThreadId = await startSession(manager);

    await expect(manager.endSession({ authority, providerThreadId, signal: signal() }))
      .rejects.toThrow("could not be joined");
    await expect(manager.readSession({
      authority,
      detail: false,
      providerThreadId,
      signal: signal(),
    })).rejects.toThrow("cleanup is unresolved");

    await manager.endSession({ authority, providerThreadId, signal: signal() });
    expect(terminations).toEqual(["terminate", "force", "terminate", "force"]);
    await expect(manager.readSession({
      authority,
      detail: false,
      providerThreadId,
      signal: signal(),
    })).rejects.toThrow("not running");
    await manager.close();
  });

  test("refuses invalid child cleanup bounds before any process can launch", () => {
    let launches = 0;
    expect(() => harness({
      clientShutdownSettlementMs: 0,
      processFactory: () => {
        launches += 1;
        return new FakeClaudeProcess();
      },
    })).toThrow("between 1 and 30000 milliseconds");
    expect(launches).toBe(0);
  });

  test("retains failed child ownership across manager close and retries it exactly", async () => {
    const terminations: string[] = [];
    let forceAttempts = 0;
    const { manager } = harness({
      clientShutdownSettlementMs: 5,
      clientShutdownTermGraceMs: 1,
      processFactory: () => {
        const process = new FakeClaudeProcess();
        const exit = process.terminate.bind(process);
        process.terminate = () => { terminations.push("terminate"); };
        process.forceTerminate = () => {
          terminations.push("force");
          forceAttempts += 1;
          if (forceAttempts === 2) exit();
        };
        return process;
      },
    });
    await startSession(manager);

    await expect(manager.close()).rejects.toThrow(
      "One or more Claude session children could not be joined",
    );
    await manager.close();
    expect(terminations).toEqual(["terminate", "force", "terminate", "force"]);
    await manager.close();
  });

  test("refuses stale generation authority for exact session cleanup", async () => {
    const { manager } = harness();
    const providerThreadId = await startSession(manager);

    await expect(manager.endSession({
      authority: { ...authority, generation: authority.generation - 1 },
      providerThreadId,
      signal: signal(),
    })).rejects.toThrow("another authority");
    await manager.endSession({ authority, providerThreadId, signal: signal() });
    await manager.close();
  });

  test("replays only an exact same-manager close proof and fails closed after restart", async () => {
    const { manager } = harness();

    await expect(manager.endSession({
      authority,
      providerThreadId: "unknown-claude-thread",
      signal: signal(),
    })).rejects.toMatchObject({
      code: "PROCESS_EXITED",
      message: expect.stringContaining("cleanup cannot be proven"),
    });

    const providerThreadId = await startSession(manager);
    await manager.endSession({ authority, providerThreadId, signal: signal() });
    await manager.endSession({ authority, providerThreadId, signal: signal() });
    await expect(manager.endSession({
      authority: { ...authority, generation: authority.generation + 1 },
      providerThreadId,
      signal: signal(),
    }))
      .rejects.toMatchObject({
        code: "PROCESS_EXITED",
        message: expect.stringContaining("cleanup cannot be proven"),
      });
    await manager.close();

    const { manager: restarted } = harness();
    await expect(restarted.endSession({ authority, providerThreadId, signal: signal() }))
      .rejects.toMatchObject({
        code: "PROCESS_EXITED",
        message: expect.stringContaining("cleanup cannot be proven"),
      });
    await restarted.close();
  });

  test("rechecks account authority after the status subprocess settles", async () => {
    let current = true;
    let settleStatus!: (value: { signedIn: boolean }) => void;
    const status = new Promise<{ signedIn: boolean }>((resolve) => { settleStatus = resolve; });
    const { manager } = harness({
      isCurrent: () => current,
      readAuthStatus: () => status,
    });
    const pending = manager.readAccount({ authority, signal: signal() });
    current = false;
    settleStatus({ signedIn: true });
    await expect(pending).rejects.toThrow("authority changed");
    await manager.close();
  });

  test("explicitly releases an unconsumed runtime review", async () => {
    const { manager, processes } = harness();
    const review = await manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    });
    manager.discardRuntimeReview(review);
    await expect(manager.startSession({ authority, review, signal: signal() }))
      .rejects.toThrow("no longer usable");
    expect(processes).toEqual([]);
    await manager.close();
  });

  test("reviews, starts, runs, and completes one full turn", async () => {
    const { facts, launches, manager, processes } = harness();
    const review = await manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    });
    expect(review.kind).toBe("session_start");
    expect(effectiveClaudeRuntimeProfileSchema.parse(review.effectiveRuntimeProfile)).toEqual({
      claudeVersion: CLAUDE_PIN,
      configHome: "isolated",
      inputFormat: "stream-json",
      model: CLAUDE_PIN_MODEL,
      nativeFallback: CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY,
      observedAt: 1_700_000_000_000,
      outputFormat: "stream-json",
      permissionMode: "default",
      preset: "fable-max",
      processGeneration: 3,
      profileId: authority.id,
      reasoningEffort: "max",
    });
    expect(manager.pinnedVersion()).toBe(CLAUDE_PIN);

    const started = await manager.startSession({ authority, review, signal: signal() });
    expect(started.status).toBe("idle");
    expect(started.projectRoot).toBe(PROJECT_ROOT);
    expect(launches[0]?.launch).toBe("create");
    expect(launches[0]?.argv.slice(-2)).toEqual(["--session-id", started.providerThreadId]);
    await expect(manager.readSessionProcessIdentity({
      authority,
      providerThreadId: started.providerThreadId,
      signal: signal(),
    })).resolves.toEqual(PROCESS_IDENTITY);
    await manager.activateSessionHostTools({
      authority,
      providerThreadId: started.providerThreadId,
      signal: signal(),
    });

    const turnId = await startTurn(manager, started.providerThreadId, "say ok");
    const process = processes[0];
    if (process === undefined) throw new Error("expected one spawned process");
    expect(JSON.parse(process.written[0] ?? "") as unknown).toEqual({
      message: { content: [{ text: "say ok", type: "text" }], role: "user" },
      type: "user",
    });
    expect((await manager.readSession({
      authority,
      detail: false,
      providerThreadId: started.providerThreadId,
      signal: signal(),
    })).activeTurnId).toBe(turnId);

    process.emit(
      {
        message: {
          content: [{ text: "ok", type: "text" }],
          id: "msg_1",
          model: CLAUDE_PIN_MODEL,
          role: "assistant",
          type: "message",
        },
        parent_tool_use_id: null,
        session_id: started.providerThreadId,
        type: "assistant",
      },
      {
        duration_ms: 2_259,
        is_error: false,
        num_turns: 1,
        result: "ok",
        session_id: started.providerThreadId,
        stop_reason: "end_turn",
        terminal_reason: "completed",
        type: "result",
        usage: { input_tokens: 2, output_tokens: 4 },
        uuid: "00000000-0000-4000-8000-000000000010",
      },
    );
    await settle();

    expect(facts.map((fact) => fact.type)).toEqual([
      "turnStarted",
      "assistantDelta",
      "tokenUsageUpdated",
      "turnCompleted",
      "turnSummary",
      "usageAccountingObserved",
    ]);
    const accountingFact = facts[5];
    if (accountingFact?.type !== "usageAccountingObserved") {
      throw new Error("expected accounted terminal result");
    }
    expect(accountingFact).toMatchObject({
      accounting: {
        models: [],
        tokens: { inputTokens: 2, outputTokens: 4 },
        totalCostUsd: null,
      },
      observationRevision: 1,
      observedAt: 1_700_000_000_000,
      receivedAt: 1_700_000_000_000,
      sourceEventId: "00000000-0000-4000-8000-000000000010",
      turnId,
      type: "usageAccountingObserved",
    });
    expect(accountingFact.sourceEventDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(facts.every((fact) => fact.providerThreadId === started.providerThreadId)).toBe(true);
    const observation = await manager.observeSession({
      authority,
      providerThreadId: started.providerThreadId,
      signal: signal(),
    });
    expect(observation.projection.status).toBe("idle");
    expect(observation.projection.activeTurnId).toBeUndefined();
    await manager.close();
  });

  test("passes a reserved session id directly to Claude before process admission", async () => {
    const { launches, manager } = harness();
    const review = await manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    });
    const admittedIdentities: ClaudeProcessIdentity[] = [];
    const started = await manager.startSession({
      authority,
      admitProcessIdentity: (identity) => {
        admittedIdentities.push(identity);
        return Promise.resolve();
      },
      providerThreadId: ADOPTED_PROVIDER_THREAD_ID,
      review,
      signal: signal(),
    });

    expect(started.providerThreadId).toBe(ADOPTED_PROVIDER_THREAD_ID);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.argv).toEqual([
      ...runtime.argv,
      "--append-system-prompt",
      HRA_SESSION_PREAMBLE.text,
      "--mcp-config",
      `${HOST_TOOL_PRIVATE_ROOT}/binding-1/mcp.json`,
      "--strict-mcp-config",
      "--session-id",
      ADOPTED_PROVIDER_THREAD_ID,
    ]);
    expect(admittedIdentities).toEqual([PROCESS_IDENTITY]);
    await manager.close();
  });

  test("keeps the initialized child unobservable while process admission is pending", async () => {
    const { manager, processes } = harness();
    const review = await manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    });
    let markCallbackEntered!: () => void;
    const callbackEntered = new Promise<void>((resolve) => {
      markCallbackEntered = resolve;
    });
    let releaseCallback!: () => void;
    const callbackRelease = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });
    let callbackIdentity: ClaudeProcessIdentity | undefined;
    const starting = manager.startSession({
      authority,
      admitProcessIdentity: async (identity) => {
        callbackIdentity = identity;
        markCallbackEntered();
        await callbackRelease;
      },
      providerThreadId: ADOPTED_PROVIDER_THREAD_ID,
      review,
      signal: signal(),
    });

    await callbackEntered;
    let startSettled = false;
    void starting.then(
      () => { startSettled = true; },
      () => { startSettled = true; },
    );
    await Promise.resolve();
    try {
      expect(callbackIdentity).toEqual(PROCESS_IDENTITY);
      expect(startSettled).toBe(false);
      expect(processes).toHaveLength(1);
      expect(processes[0]?.terminated).toBe(false);
      await expect(manager.observeSession({
        authority,
        providerThreadId: ADOPTED_PROVIDER_THREAD_ID,
        signal: signal(),
      })).rejects.toMatchObject({ reason: "not_running" });
    } finally {
      releaseCallback();
    }

    const started = await starting;
    expect(started.providerThreadId).toBe(ADOPTED_PROVIDER_THREAD_ID);
    await expect(manager.observeSession({
      authority,
      providerThreadId: ADOPTED_PROVIDER_THREAD_ID,
      signal: signal(),
    })).resolves.toMatchObject({
      projection: { providerThreadId: ADOPTED_PROVIDER_THREAD_ID },
    });
    await manager.close();
  });

  test("rejects process admission failure only after proving child cleanup", async () => {
    const { manager, processes } = harness();
    const review = await manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    });
    const admissionFailure = new Error("durable process custody rejected");
    await expect(manager.startSession({
      authority,
      admitProcessIdentity: () => Promise.reject(admissionFailure),
      providerThreadId: ADOPTED_PROVIDER_THREAD_ID,
      review,
      signal: signal(),
    })).rejects.toBe(admissionFailure);

    const rejectedProcess = processes[0];
    if (rejectedProcess === undefined) throw new Error("expected a rejected child process");
    expect(rejectedProcess.signals).toEqual(["SIGTERM"]);
    await expect(rejectedProcess.exited).resolves.toBe(0);
    await expect(manager.observeSession({
      authority,
      providerThreadId: ADOPTED_PROVIDER_THREAD_ID,
      signal: signal(),
    })).rejects.toMatchObject({ reason: "not_running" });

    const retryReview = await manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    });
    await expect(manager.startSession({
      authority,
      providerThreadId: ADOPTED_PROVIDER_THREAD_ID,
      review: retryReview,
      signal: signal(),
    })).resolves.toMatchObject({ providerThreadId: ADOPTED_PROVIDER_THREAD_ID });
    expect(processes).toHaveLength(2);
    await manager.close();
  });

  test("retains typed unproven-exit custody when admission cleanup cannot prove exit", async () => {
    const { manager, processes } = harness({
      processIgnoresKill: true,
      processIgnoresTerm: true,
      clientShutdownSettlementMs: 5,
      clientShutdownTermGraceMs: 5,
    });
    const review = await manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    });
    await expect(manager.startSession({
      authority,
      admitProcessIdentity: () => Promise.reject(new Error("durable process custody rejected")),
      providerThreadId: ADOPTED_PROVIDER_THREAD_ID,
      review,
      signal: signal(),
    })).rejects.toBeInstanceOf(ClaudeProcessExitUnprovenError);

    expect(processes[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);
    await expect(manager.observeSession({
      authority,
      providerThreadId: ADOPTED_PROVIDER_THREAD_ID,
      signal: signal(),
    })).rejects.toMatchObject({ reason: "not_running" });
    await expect(manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    })).rejects.toThrow("still unjoined");
    expect(processes).toHaveLength(1);

    processes[0]?.end();
    await expect(manager.close()).resolves.toBeUndefined();
  });

  test("refuses a preset the Claude provider does not support", async () => {
    const { manager } = harness();
    await expect(manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "ultra",
      requirement: presetRequirements.ultra,
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    })).rejects.toThrow(PresetProviderMismatchError);
    await expect(manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "low",
      requirement: presetRequirements.low,
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    })).rejects.toThrow("does not support the `low` model preset");
    // Fast mode is a Codex service tier; Claude refuses it rather than ignoring it.
    await expect(manager.reviewSessionStart({
      authority,
      fast: true,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    })).rejects.toThrow("no HRA fast mode");
    await manager.close();
  });

  test("requires the passed exact preset tuple before admitting a Claude runtime", async () => {
    const unadmitted = harness();
    await expect(unadmitted.manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "fable-max",
      requirement: { model: CLAUDE_PIN_MODEL, effort: "ultra" },
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    })).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    await unadmitted.manager.close();

    const mismatched = harness({
      resolveRuntime: async () => ({
        ...runtime,
        model: "claude-other-model",
      }) as unknown as PinnedClaudeRuntime,
    });
    await expect(mismatched.manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    })).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    await mismatched.manager.close();
  });

  test("maps every can_use_tool request onto its HRA interaction kind", async () => {
    const { facts, manager, processes } = harness();
    const providerThreadId = await startSession(manager);
    await startTurn(manager, providerThreadId, "work");
    const process = processes[0];
    if (process === undefined) throw new Error("expected one spawned process");

    const ask = (requestId: string, toolName: string, input: unknown, extra: object = {}): void => {
      process.emit({
        request: {
          display_name: toolName,
          input,
          subtype: "can_use_tool",
          tool_name: toolName,
          tool_use_id: `toolu_${requestId}`,
          ...extra,
        },
        request_id: requestId,
        type: "control_request",
      });
    };
    ask("r-bash", "Bash", { command: "true" });
    ask("r-edit", "Edit", { file_path: "notes.md" });
    ask("r-write", "Write", { file_path: "notes.md" });
    ask("r-notebook", "NotebookEdit", { notebook_path: "a.ipynb" });
    ask("r-fetch", "WebFetch", { url: "https://example.com" });
    ask("r-ask", "AskUserQuestion", {
      questions: [{
        header: "Indent",
        multiSelect: false,
        options: [{ description: "", label: "tabs" }, { description: "", label: "spaces" }],
        question: "Tabs or spaces?",
      }],
    }, { requires_user_interaction: true });
    await settle();

    expect(facts.filter((fact) => fact.type === "interactionRequested").map((fact) => fact.kind))
      .toEqual([
        "command_approval",
        "file_change_approval",
        "file_change_approval",
        "file_change_approval",
        "permission_approval",
        "user_input",
      ]);

    // Answering goes through the provider authority, which fences the exact
    // request the daemon recorded.
    const bashAuthority = manager.interactionAuthority(authority, providerThreadId, "r-bash");
    expect(typeof bashAuthority.connectionId).toBe("string");
    expect(bashAuthority).toMatchObject({
      itemId: "toolu_r-bash",
      method: "claude/control_request/can_use_tool",
      processGeneration: 3,
      profileId: authority.id,
      requestId: { type: "string", value: "r-bash" },
      threadId: providerThreadId,
    });
    const validated = await manager.validateInteractionResolution({
      authority,
      kind: "command_approval",
      provider: bashAuthority,
      resolution: { decision: "once", kind: "approval_decision" },
      signal: signal(),
    });
    const written = await manager.resolveInteraction({
      authority,
      deadlineAt: 1_700_000_100_000,
      kind: "command_approval",
      provider: bashAuthority,
      resolution: { decision: "once", kind: "approval_decision" },
      signal: signal(),
    });
    expect(written).toEqual({ responseWritten: true });
    expect(validated.responseDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.parse(process.written.at(-1) ?? "") as unknown).toEqual({
      response: {
        request_id: "r-bash",
        response: { behavior: "allow", toolUseID: "toolu_r-bash", updatedInput: { command: "true" } },
        subtype: "success",
      },
      type: "control_response",
    });

    // A session-scoped grant is refused: Claude's control response can only
    // ever authorise this one tool use.
    const editAuthority = manager.interactionAuthority(authority, providerThreadId, "r-edit");
    await expect(manager.resolveInteraction({
      authority,
      deadlineAt: 1_700_000_100_000,
      kind: "file_change_approval",
      provider: editAuthority,
      resolution: { decision: "session", kind: "approval_decision" },
      signal: signal(),
    })).rejects.toThrow("session scope is not available");

    // A declined approval writes a deny with no updated input.
    await manager.resolveInteraction({
      authority,
      deadlineAt: 1_700_000_100_000,
      kind: "file_change_approval",
      provider: editAuthority,
      resolution: { decision: "decline", kind: "approval_decision" },
      signal: signal(),
    });
    expect(JSON.parse(process.written.at(-1) ?? "") as unknown).toMatchObject({
      response: { response: { behavior: "deny", toolUseID: "toolu_r-edit" } },
    });

    // A question is answered by id; the wire map is keyed by question text.
    const askAuthority = manager.interactionAuthority(authority, providerThreadId, "r-ask");
    await manager.resolveInteraction({
      authority,
      deadlineAt: 1_700_000_100_000,
      kind: "user_input",
      provider: askAuthority,
      resolution: { answers: { q0: { answers: ["spaces"] } }, kind: "user_answers" },
      signal: signal(),
    });
    expect(JSON.parse(process.written.at(-1) ?? "") as unknown).toMatchObject({
      response: { response: { updatedInput: { answers: { "Tabs or spaces?": "spaces" } } } },
    });
    await manager.close();
  });

  test("times an unanswered request out with a deny", async () => {
    const { manager, processes } = harness();
    const providerThreadId = await startSession(manager);
    await startTurn(manager, providerThreadId, "work");
    const process = processes[0];
    if (process === undefined) throw new Error("expected one spawned process");
    process.emit({
      request: {
        display_name: "Bash",
        input: { command: "true" },
        subtype: "can_use_tool",
        tool_name: "Bash",
        tool_use_id: "toolu_1",
      },
      request_id: "req-1",
      type: "control_request",
    });
    await settle();
    const provider = manager.interactionAuthority(authority, providerThreadId, "req-1");
    const validated = await manager.validateInteractionTimeout({ authority, provider, signal: signal() });
    expect(validated.responseDigest).toMatch(/^[a-f0-9]{64}$/u);
    await manager.timeoutInteraction({ authority, provider, signal: signal() });
    expect(JSON.parse(process.written.at(-1) ?? "") as unknown).toMatchObject({
      response: { response: { behavior: "deny" } },
    });
    await manager.close();
  });

  test("steers and interrupts the in-flight turn", async () => {
    const { manager, processes } = harness();
    const providerThreadId = await startSession(manager);
    const turnId = await startTurn(manager, providerThreadId, "count to 40");
    await manager.steer({
      activeTurnId: turnId,
      authority,
      clientMessageId: "client-2",
      message: "stop counting now",
      providerThreadId,
      signal: signal(),
    });
    const process = processes[0];
    if (process === undefined) throw new Error("expected one spawned process");
    expect(JSON.parse(process.written[1] ?? "") as unknown).toEqual({
      message: { content: [{ text: "stop counting now", type: "text" }], role: "user" },
      type: "user",
    });
    await manager.interrupt({ activeTurnId: turnId, authority, providerThreadId, signal: signal() });
    expect(JSON.parse(process.written.at(-1) ?? "") as unknown)
      .toMatchObject({ request: { subtype: "interrupt" }, type: "control_request" });
    await expect(manager.steer({
      activeTurnId: "another-turn",
      authority,
      clientMessageId: "client-3",
      message: "no",
      providerThreadId,
      signal: signal(),
    })).rejects.toThrow("no longer active");
    await manager.close();
  });

  test("fences every operation on the exact account authority", async () => {
    let current = true;
    const { manager } = harness({ isCurrent: () => current });
    const providerThreadId = await startSession(manager);
    current = false;
    await expect(manager.readSession({
      authority,
      detail: false,
      providerThreadId,
      signal: signal(),
    })).rejects.toThrow("authority changed");
    current = true;
    await expect(manager.readSession({
      authority: { ...authority, generation: 4 },
      detail: false,
      providerThreadId,
      signal: signal(),
    })).rejects.toThrow("another authority");
    await manager.close();
  });

  test("drops a callback before mutating projection state after authority retirement", async () => {
    let current = true;
    const { facts, manager, processes } = harness({ isCurrent: () => current });
    const providerThreadId = await startSession(manager);
    const turnId = await startTurn(manager, providerThreadId, "keep running");
    const process = processes[0];
    if (process === undefined) throw new Error("expected one spawned process");
    facts.length = 0;
    current = false;
    process.emit(
      {
        message: {
          content: [{ text: "stale reply", type: "text" }],
          id: "msg_stale",
          model: CLAUDE_PIN_MODEL,
          role: "assistant",
          type: "message",
        },
        parent_tool_use_id: null,
        session_id: "stale-session",
        type: "assistant",
      },
      {
        duration_ms: 1,
        is_error: false,
        num_turns: 1,
        result: "stale reply",
        session_id: "stale-session",
        stop_reason: "end_turn",
        terminal_reason: "completed",
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    );
    await settle();
    expect(facts).toEqual([]);

    // Re-enable only to inspect the in-memory object. Real generations are
    // monotonic; this proves the rejected callback did not mutate it first.
    current = true;
    const projection = await manager.readSession({
      authority,
      detail: true,
      providerThreadId,
      signal: signal(),
    });
    expect(projection.status).toBe("active");
    expect(projection.activeTurnId).toBe(turnId);
    expect(projection.messages?.map((message) => message.text)).toEqual(["keep running"]);
    await manager.close();
  });

  test("a stale generation cannot release a replacement session controller", async () => {
    const { manager, processes } = harness();
    const providerThreadId = await startSession(manager);
    const process = processes[0];
    if (process === undefined) throw new Error("expected one spawned process");

    await expect(manager.endSession({
      authority: { ...authority, generation: authority.generation - 1 },
      providerThreadId,
      signal: signal(),
    })).rejects.toMatchObject({ code: "AUTHORITY_STALE" });

    await expect(manager.observeSession({
      authority,
      providerThreadId,
      signal: signal(),
    })).resolves.toMatchObject({ projection: { providerThreadId } });
    expect(process.signals).toEqual([]);
    await manager.close();
  });

  test("rekeys an idle live session and its host binding across one exact provider generation", async () => {
    const handled: HraHostToolCall[] = [];
    const value = harness({
      hostTool: (call) => {
        handled.push(call);
        return { sessions: [] };
      },
    });
    const providerThreadId = await startSession(value.manager);
    const nextAuthority = { ...authority, generation: authority.generation + 1 };
    const bindingId = `clhb_${"1".padStart(32, "0")}`;

    for (const invalidNext of [
      { ...nextAuthority, provider: "codex" as const },
      { ...nextAuthority, providerAccountId: `pact_${"f".repeat(32)}` },
      { ...nextAuthority, bindingGeneration: authority.bindingGeneration + 1 },
      { ...nextAuthority, codexHome: `${authority.codexHome}/changed` },
      { ...nextAuthority, generation: authority.generation + 2 },
    ]) {
      expect(() => value.manager.rebindProfileAuthority({
        expectedAuthority: authority,
        nextAuthority: invalidNext,
      })).toThrow("exactly one safe generation");
    }
    expect(value.bindingAuthority.rebinds).toEqual([]);
    value.manager.rebindProfileAuthority({
      expectedAuthority: authority,
      nextAuthority,
    });
    value.manager.rebindProfileAuthority({ expectedAuthority: authority, nextAuthority });
    expect(value.bindingAuthority.rebinds).toEqual([{
      bindingId,
      expectedIdentity: {
        processGeneration: authority.generation,
        profileId: authority.id,
        provider: "claude",
        providerThreadId,
      },
      nextIdentity: {
        processGeneration: nextAuthority.generation,
        profileId: nextAuthority.id,
        provider: "claude",
        providerThreadId,
      },
    }]);
    await expect(value.manager.observeSession({
      authority,
      providerThreadId,
      signal: signal(),
    })).rejects.toThrow("another authority");
    await expect(value.manager.observeSession({
      authority: nextAuthority,
      providerThreadId,
      signal: signal(),
    })).resolves.toMatchObject({ projection: { providerThreadId, status: "idle" } });

    const review = await value.manager.reviewTurnStart({
      authority: nextAuthority,
      fast: false,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      providerThreadId,
      signal: signal(),
    });
    const turn = await value.manager.startTurn({
      authority: nextAuthority,
      clientMessageId: "client-after-rebind",
      message: "continue after rekey",
      providerThreadId,
      review,
      signal: signal(),
    });
    await expect(value.manager.handleSessionHostToolCall({
      ...hostToolCall(providerThreadId, bindingId, "call-after-rebind"),
      processGeneration: nextAuthority.generation,
    })).resolves.toEqual({ sessions: [] });
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({
      authority: {
        processGeneration: nextAuthority.generation,
        profileId: nextAuthority.id,
      },
      threadId: providerThreadId,
      turnId: turn.turnId,
    });
    expect(() => value.manager.rebindProfileAuthority({
      expectedAuthority: nextAuthority,
      nextAuthority: { ...nextAuthority, generation: nextAuthority.generation + 1 },
    })).toThrow("active Claude turn");
    await value.manager.close();
  });

  test("starts a historical V1 target without provisioning or activating new host tools", async () => {
    const value = harness();
    const review = await value.manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    });
    for (const hostCapabilities of ["disabled", "legacy", null]) {
      await expect(value.manager.startSession({
        authority, review, signal: signal(), hostCapabilities,
      } as unknown as Parameters<PinnedClaudeRuntimeManager["startSession"]>[0]))
        .rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(value.launches).toEqual([]);
    const started = await value.manager.startSession({
      authority, review, signal: signal(), hostCapabilities: "historical_v1",
    });
    expect(value.bindingAuthority.provisions).toEqual([]);
    expect(value.launches[0]?.argv).toEqual([...runtime.argv, "--session-id", started.providerThreadId]);
    await expect(value.manager.activateSessionHostTools({
      authority, providerThreadId: started.providerThreadId, signal: signal(),
    })).rejects.toThrow("no admitted host tools");
    await startTurn(value.manager, started.providerThreadId, "historical seed");
    expect(value.bindingAuthority.activations).toEqual([]);
    await value.manager.close();
  });

  test("claims one non-live durable session with full runtime authority", async () => {
    const { launches, manager, processes } = harness({ configHome: "personal" });
    const claimed = await manager.claimSession({
      authority,
      fast: false,
      hostTools: "required",
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      providerThreadId: ADOPTED_PROVIDER_THREAD_ID,
      signal: signal(),
      sourceLiveness: "not_live",
      title: ADOPTED_TITLE,
    });
    expect(claimed).toMatchObject({
      effectiveRuntimeProfile: { configHome: "personal", permissionMode: "default" },
      providerThreadId: ADOPTED_PROVIDER_THREAD_ID,
      status: "idle",
      title: ADOPTED_TITLE,
    });
    expect(launches[0]?.launch).toBe("resume");
    expect(launches[0]?.argv.slice(-2)).toEqual(["--resume", ADOPTED_PROVIDER_THREAD_ID]);
    expect(launches[0]?.argv).toEqual([
      ...runtime.argv,
      "--append-system-prompt",
      HRA_SESSION_PREAMBLE.text,
      "--mcp-config",
      `${HOST_TOOL_PRIVATE_ROOT}/binding-1/mcp.json`,
      "--strict-mcp-config",
      "--resume",
      ADOPTED_PROVIDER_THREAD_ID,
    ]);
    await manager.activateSessionHostTools({
      authority,
      providerThreadId: ADOPTED_PROVIDER_THREAD_ID,
      signal: signal(),
    });
    await expect(manager.observeSession({
      authority,
      providerThreadId: ADOPTED_PROVIDER_THREAD_ID,
      signal: signal(),
    })).resolves.toMatchObject({ resumed: true });

    const turnId = await startTurn(manager, ADOPTED_PROVIDER_THREAD_ID, "continue");
    const process = processes[0];
    if (process === undefined) throw new Error("expected resumed process");
    expect(typeof turnId).toBe("string");
    expect(JSON.parse(process.written[0] ?? "") as unknown).toMatchObject({ type: "user" });
    await expect(manager.readSession({
      authority,
      detail: false,
      providerThreadId: ADOPTED_PROVIDER_THREAD_ID,
      signal: signal(),
    })).resolves.toMatchObject({ title: ADOPTED_TITLE });

    // A second local writer is refused instead of spawning a duplicate copy.
    await expect(manager.claimSession({
      authority,
      fast: false,
      hostTools: "required",
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      providerThreadId: ADOPTED_PROVIDER_THREAD_ID,
      signal: signal(),
      sourceLiveness: "not_live",
      title: ADOPTED_TITLE,
    })).rejects.toThrow("already has a runtime owner");
    expect(processes).toHaveLength(1);
    await manager.close();
  });

  test("validates and bounds the durable title before resuming Claude", async () => {
    const invalid = harness();
    await expect(invalid.manager.claimSession({
      authority,
      fast: false,
      hostTools: "required",
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      providerThreadId: ADOPTED_PROVIDER_THREAD_ID,
      signal: signal(),
      sourceLiveness: "not_live",
      title: 42 as never,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(invalid.processes).toHaveLength(0);
    await invalid.manager.close();

    const bounded = harness();
    const claimed = await bounded.manager.claimSession({
      authority,
      fast: false,
      hostTools: "required",
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      providerThreadId: ADOPTED_PROVIDER_THREAD_ID,
      signal: signal(),
      sourceLiveness: "not_live",
      title: `Existing ${"é".repeat(100)}`,
    });
    expect(claimed.title.startsWith("Existing ")).toBe(true);
    expect(new TextEncoder().encode(claimed.title).byteLength).toBeLessThanOrEqual(120);
    await bounded.manager.close();
  });

  test("rejects the former daemon-fence shortcut without spawning a writer", async () => {
    const prior = harness();
    const providerThreadId = await startSession(prior.manager);
    await prior.manager.close();

    const replacement = harness();
    await expect(replacement.manager.observeSession({
      authority,
      providerThreadId,
      signal: signal(),
    })).rejects.toBeInstanceOf(ClaudeSessionObservationError);
    await expect(replacement.manager.claimSession({
      authority,
      fast: false,
      hostTools: "required",
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      providerThreadId,
      signal: signal(),
      sourceLiveness: "prior_hra_daemon_fenced" as never,
      title: ADOPTED_TITLE,
    })).rejects.toThrow("source process is not live");
    expect(replacement.launches).toHaveLength(0);
    await replacement.manager.close();
  });

  test("refuses a claim without the closed non-live proof", async () => {
    const { manager, processes } = harness();
    await expect(manager.claimSession({
      authority,
      fast: false,
      hostTools: "required",
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      providerThreadId: ADOPTED_PROVIDER_THREAD_ID,
      signal: signal(),
      // Exercises the runtime boundary against an untyped or stale caller.
      sourceLiveness: "live" as never,
      title: ADOPTED_TITLE,
    })).rejects.toThrow("source process is not live");
    expect(processes).toHaveLength(0);
    await manager.close();
  });

  test("requires an explicit host-tool admission mode before resuming Claude", async () => {
    const { manager, processes } = harness();
    await expect(manager.claimSession({
      authority,
      fast: false,
      // Exercises the runtime boundary against an untyped or stale caller.
      hostTools: undefined as never,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      providerThreadId: ADOPTED_PROVIDER_THREAD_ID,
      signal: signal(),
      sourceLiveness: "not_live",
      title: ADOPTED_TITLE,
    })).rejects.toThrow("Unknown Claude host-tool admission mode");
    expect(processes).toHaveLength(0);
    await manager.close();
  });

  test("fails closed and cleans up every mismatched initialization identity", async () => {
    const mismatches: readonly InitializationOverride[] = [
      { providerThreadId: "069d2fc6-b09a-4ced-8932-14b1229cc043" },
      { version: "2.1.259" },
      { model: "claude-fable-5" },
      { permissionMode: "bypassPermissions" },
    ];
    for (const initialization of mismatches) {
      const { manager, processes } = harness({ initialization });
      await expect(manager.claimSession({
        authority,
        fast: false,
        hostTools: "required",
        preset: "fable-max",
        requirement: presetRequirements["fable-max"],
        projectRoot: PROJECT_ROOT,
        providerThreadId: ADOPTED_PROVIDER_THREAD_ID,
        signal: signal(),
        sourceLiveness: "not_live",
        title: ADOPTED_TITLE,
      })).rejects.toBeInstanceOf(Error);
      expect(processes[0]?.terminated).toBe(true);
      await expect(manager.observeSession({
        authority,
        providerThreadId: ADOPTED_PROVIDER_THREAD_ID,
        signal: signal(),
      })).rejects.toMatchObject({ reason: "not_running" });
      await manager.close();
    }
  });

  test("fails closed and reaps a child whose exact process identity is unavailable", async () => {
    const { manager, processes } = harness({ processIdentity: "reject" });
    await expect(manager.claimSession({
      authority,
      fast: false,
      hostTools: "required",
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      providerThreadId: ADOPTED_PROVIDER_THREAD_ID,
      signal: signal(),
      sourceLiveness: "not_live",
      title: ADOPTED_TITLE,
    })).rejects.toThrow("identity unavailable");
    expect(processes[0]?.terminated).toBe(true);
    await expect(manager.observeSession({
      authority,
      providerThreadId: ADOPTED_PROVIDER_THREAD_ID,
      signal: signal(),
    })).rejects.toBeInstanceOf(ClaudeSessionObservationError);
    await manager.close();
  });

  test("retains an unproven admission cleanup fence until manager close can retry", async () => {
    const { manager, processes } = harness({
      processIdentity: "reject",
      processIgnoresKill: true,
      processIgnoresTerm: true,
      clientShutdownSettlementMs: 5,
      clientShutdownTermGraceMs: 5,
    });
    const claim = (): ReturnType<PinnedClaudeRuntimeManager["claimSession"]> =>
      manager.claimSession({
        authority,
        fast: false,
        hostTools: "required",
        preset: "fable-max",
        requirement: presetRequirements["fable-max"],
        projectRoot: PROJECT_ROOT,
        providerThreadId: ADOPTED_PROVIDER_THREAD_ID,
        signal: signal(),
        sourceLiveness: "not_live",
        title: ADOPTED_TITLE,
      });
    await expect(claim()).rejects.toThrow("exit could not be proven");
    await expect(claim()).rejects.toThrow("still unjoined");
    expect(processes).toHaveLength(1);

    processes[0]?.end();
    await expect(manager.close()).resolves.toBeUndefined();
  });

  test("does not admit a process that reaches EOF immediately after initialization", async () => {
    const { manager, processes } = harness({ exitAfterInitialization: true });
    await expect(startSession(manager)).rejects.toMatchObject({ code: "PROCESS_EXITED" });
    await expect(processes[0]?.exited).resolves.toBe(0);
    await manager.close();
  });

  test("retains cleanup identity and reports one committed process that exits", async () => {
    const { facts, manager, processes } = harness();
    const providerThreadId = await startSession(manager);
    const process = processes[0];
    if (process === undefined) throw new Error("expected one spawned process");
    process.end();
    await settle();

    await expect(manager.observeSession({
      authority,
      providerThreadId,
      signal: signal(),
    })).rejects.toBeInstanceOf(ClaudeSessionObservationError);
    await expect(manager.readSessionProcessIdentity({
      authority,
      providerThreadId,
      signal: signal(),
    })).resolves.toEqual(PROCESS_IDENTITY);
    await expect(startSession(manager)).rejects.toThrow("still unjoined");
    expect(processes).toHaveLength(1);
    expect(facts.filter((fact) => fact.type === "providerDisconnected")).toHaveLength(1);
    await manager.endSession({ authority, providerThreadId, signal: signal() });
    await expect(manager.readSessionProcessIdentity({ authority, providerThreadId, signal: signal() }))
      .rejects.toThrow("not running");
    await manager.close();
  });

  test("drops late disconnect and turn facts from a replaced Claude connection", async () => {
    const evictionSentinel = "hra_test_evict_old_claude_connection";
    // The spy delegates with `.call(this, ...)`, preserving the exact assembler instance.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalApply = ClaudeDeltaAssembler.prototype.apply;
    const applySpy = spyOn(ClaudeDeltaAssembler.prototype, "apply").mockImplementation(function (
      this: ClaudeDeltaAssembler,
      event: Parameters<ClaudeDeltaAssembler["apply"]>[0],
    ): ReturnType<ClaudeDeltaAssembler["apply"]> {
      if (event.type === "protocol_notice" && event.event === evictionSentinel) {
        return [{ type: "providerDisconnected", reason: "process_exit" }];
      }
      return originalApply.call(this, event);
    });
    let resolveInitialDisconnect!: () => void;
    const initialDisconnect = new Promise<void>((resolve) => {
      resolveInitialDisconnect = resolve;
    });
    const value = harness({
      onFact: (_factAuthority, fact) => {
        if (fact.type === "providerDisconnected") resolveInitialDisconnect();
      },
    });
    let oldProcess: FakeClaudeProcess | undefined;
    try {
      const providerThreadId = await startSession(value.manager);
      const oldObservation = await value.manager.observeSession({
        authority,
        providerThreadId,
        signal: signal(),
      });
      await startTurn(value.manager, providerThreadId, "old connection turn");
      oldProcess = value.processes[0];
      if (oldProcess === undefined) throw new Error("expected the old Claude process");

      // This test-only sentinel reaches the manager through the real stream
      // client callback and models the disconnect that first evicts the old
      // runtime. Its process stays readable so later old-client callbacks can
      // race a newly admitted owner for the same provider thread.
      oldProcess.emit({ type: evictionSentinel });
      await initialDisconnect;
      await expect(value.manager.observeSession({
        authority,
        providerThreadId,
        signal: signal(),
      })).rejects.toBeInstanceOf(ClaudeSessionObservationError);

      // Disconnect fences provider effects immediately, but the exact old
      // client remains owned until its process and output drains are joined.
      await value.manager.endSession({ authority, providerThreadId, signal: signal() });

      await value.manager.claimSession({
        authority,
        fast: false,
        hostTools: "required",
        preset: "fable-max",
        requirement: presetRequirements["fable-max"],
        projectRoot: PROJECT_ROOT,
        providerThreadId,
        signal: signal(),
        sourceLiveness: "not_live",
        title: ADOPTED_TITLE,
      });
      const replacement = await value.manager.observeSession({
        authority,
        providerThreadId,
        signal: signal(),
      });
      expect(replacement.connectionId).not.toBe(oldObservation.connectionId);
      const factsBeforeLateCallbacks = [...value.facts];

      oldProcess.emit({
        message: {
          content: [{ text: "stale output from the old connection", type: "text" }],
          id: "stale-old-connection-message",
          role: "assistant",
          type: "message",
        },
        parent_tool_use_id: null,
        session_id: providerThreadId,
        type: "assistant",
      });
      // The old client's natural exit publishes abandoned-turn mutations and
      // then a second providerDisconnected through its captured connection.
      oldProcess.end();
      await settle();

      await expect(value.manager.observeSession({
        authority,
        providerThreadId,
        signal: signal(),
      })).resolves.toMatchObject({
        connectionId: replacement.connectionId,
        projection: {
          messages: [],
          status: "idle",
          title: ADOPTED_TITLE,
        },
        resumed: true,
      });
      expect(value.facts).toEqual(factsBeforeLateCallbacks);
      expect(value.facts.filter((fact) => fact.type === "providerDisconnected"))
        .toHaveLength(1);
      expect(value.processes).toHaveLength(2);
    } finally {
      oldProcess?.end();
      await value.manager.close();
      applySpy.mockRestore();
    }
  });

  test("retains ambiguous close custody and permits an exact release retry", async () => {
    const { manager, processes } = harness({
      processIgnoresKill: true,
      processIgnoresTerm: true,
      clientShutdownSettlementMs: 5,
      clientShutdownTermGraceMs: 5,
    });
    const providerThreadId = await startSession(manager);
    const process = processes[0];
    if (process === undefined) throw new Error("expected one spawned process");

    try {
    await expect(manager.endSession({ authority, providerThreadId, signal: signal() }))
      .rejects.toMatchObject({ code: "TIMEOUT" });
    // Cleanup can identify the retained child without admitting any operation
    // on its failed client. Execution and new launches stay fenced until join.
    await expect(manager.readSessionProcessIdentity({
      authority,
      providerThreadId,
      signal: signal(),
    })).resolves.toEqual(PROCESS_IDENTITY);
    for (const changed of [
      { ...authority, id: "acct_11111111111111111111111111111111" as const },
      { ...authority, providerAccountId: "pact_11111111111111111111111111111111" as const },
      { ...authority, provider: "codex" as const },
      { ...authority, generation: authority.generation + 1 },
      { ...authority, bindingGeneration: authority.bindingGeneration + 1 },
    ]) {
      await expect(manager.readSessionProcessIdentity({
        authority: changed, providerThreadId, signal: signal(),
      })).rejects.toThrow("another authority");
    }
    await expect(manager.readSessionProcessIdentity({
      authority, providerThreadId: "unowned-thread", signal: signal(),
    })).rejects.toThrow("not running");
    await expect(manager.observeSession({ authority, providerThreadId, signal: signal() }))
      .rejects.toBeInstanceOf(ClaudeSessionObservationError);
    await expect(startSession(manager)).rejects.toThrow("still unjoined");
    expect(processes).toHaveLength(1);

    process.end();
    await expect(manager.endSession({ authority, providerThreadId, signal: signal() }))
      .resolves.toBeUndefined();
    await expect(manager.observeSession({ authority, providerThreadId, signal: signal() }))
      .rejects.toBeInstanceOf(ClaudeSessionObservationError);
    expect(process.signals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM"]);
    } finally {
      process.end();
      await manager.close();
    }
  });

  test("times out and cleans up a resumed process that never initializes", async () => {
    const { manager, processes } = harness({
      initialization: "silent",
      initializationTimeoutMs: 1,
    });
    await expect(manager.claimSession({
      authority,
      fast: false,
      hostTools: "required",
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      providerThreadId: ADOPTED_PROVIDER_THREAD_ID,
      signal: signal(),
      sourceLiveness: "not_live",
      title: ADOPTED_TITLE,
    })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(processes[0]?.terminated).toBe(true);
    await manager.close();
  });

  test("retains disconnected child custody until shutdown proves its exit", async () => {
    const { manager, processes } = harness({
      processIgnoresTerm: true,
      processIgnoresKill: true,
      clientShutdownSettlementMs: 5,
      clientShutdownTermGraceMs: 5,
    });
    await startSession(manager);
    const child = processes[0];
    if (child === undefined) throw new Error("expected one spawned process");
    let exits = 0;
    void child.exited.then(() => { exits += 1; });
    child.endOutput();
    await settle();
    expect(exits).toBe(0);
    await expect(startSession(manager)).rejects.toThrow("still unjoined");
    expect(processes).toHaveLength(1);
    child.end();
    await manager.close();
    expect(exits).toBe(1);
  });

  test("fences reviews, sessions, and interactions on provider-account generation", async () => {
    const boundAuthority: ProfileAuthority = {
      ...authority,
      bindingGeneration: 7,
      provider: "claude",
      providerAccountId: "pact_11111111111111111111111111111111",
    };
    const { manager, processes } = harness();
    const review = await manager.reviewSessionStart({
      authority: boundAuthority,
      fast: false,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    });
    const started = await manager.startSession({
      authority: boundAuthority,
      review,
      signal: signal(),
    });
    await manager.activateSessionHostTools({
      authority: boundAuthority,
      providerThreadId: started.providerThreadId,
      signal: signal(),
    });
    const turnReview = await manager.reviewTurnStart({
      authority: boundAuthority,
      fast: false,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      providerThreadId: started.providerThreadId,
      signal: signal(),
    });
    await manager.startTurn({
      authority: boundAuthority,
      clientMessageId: "client-bound",
      message: "work",
      providerThreadId: started.providerThreadId,
      review: turnReview,
      signal: signal(),
    });
    const process = processes[0];
    if (process === undefined) throw new Error("expected one spawned process");
    process.emit({
      request: {
        display_name: "Bash",
        input: { command: "true" },
        subtype: "can_use_tool",
        tool_name: "Bash",
        tool_use_id: "toolu_bound",
      },
      request_id: "req-bound",
      type: "control_request",
    });
    await settle();

    const interaction = manager.interactionAuthority(
      boundAuthority,
      started.providerThreadId,
      "req-bound",
    );
    expect(interaction).toMatchObject({
      bindingGeneration: 7,
      processGeneration: 3,
      provider: "claude",
      providerAccountId: boundAuthority.providerAccountId,
    });
    expect(() => manager.interactionAuthority(
      { ...boundAuthority, bindingGeneration: 8 },
      started.providerThreadId,
      "req-bound",
    )).toThrow("another authority");
    await expect(manager.validateInteractionResolution({
      authority: boundAuthority,
      kind: "command_approval",
      provider: { ...interaction, bindingGeneration: 8 },
      resolution: { decision: "once", kind: "approval_decision" },
      signal: signal(),
    })).rejects.toThrow("interaction authority changed");
    await expect(manager.readSession({
      authority: { ...boundAuthority, bindingGeneration: 8 },
      detail: false,
      providerThreadId: started.providerThreadId,
      signal: signal(),
    })).rejects.toThrow("another authority");
    const staleReview = await manager.reviewSessionStart({
      authority: boundAuthority,
      fast: false,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    });
    await expect(manager.startSession({
      authority: { ...boundAuthority, bindingGeneration: 8 },
      review: staleReview,
      signal: signal(),
    })).rejects.toThrow("runtime review belongs to another authority");
    await expect(manager.reviewSessionStart({
      authority: { ...boundAuthority, provider: "codex" },
      fast: false,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    })).rejects.toThrow("account authority changed");
    await manager.close();
  });

  test("refuses a review that names no project directory", async () => {
    const { manager } = harness();
    await expect(manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      signal: signal(),
    })).rejects.toThrow("requires a project directory");
    await manager.close();
  });

  test("consumes a runtime review exactly once", async () => {
    const { manager } = harness();
    const review = await manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    });
    await manager.startSession({ authority, review, signal: signal() });
    await expect(manager.startSession({ authority, review, signal: signal() }))
      .rejects.toThrow("no longer usable");
    await manager.close();
  });

  for (const configHome of ["isolated", "personal"] as const) {
    test(`resumes a legacy ${configHome} Claude session without granting unbound host tools`, async () => {
      const value = harness({ configHome });
      try {
        const started = await value.manager.claimSession({
          authority,
          fast: false,
          hostTools: "disabled",
          preset: "fable-max",
          requirement: presetRequirements["fable-max"],
          projectRoot: PROJECT_ROOT,
          providerThreadId: ADOPTED_PROVIDER_THREAD_ID,
          title: ADOPTED_TITLE,
          sourceLiveness: "not_live",
          signal: signal(),
        });
        expect(value.bindingAuthority.provisions).toEqual([]);
        expect(value.launches[0]?.argv).not.toContain("--mcp-config");
        expect(value.launches[0]?.argv).not.toContain("--append-system-prompt");
        expect(value.manager.hasLiveSession({
          authority,
          providerThreadId: started.providerThreadId,
        })).toBe(true);
        await expect(value.manager.activateSessionHostTools({
          authority,
          providerThreadId: started.providerThreadId,
          signal: signal(),
        })).rejects.toThrow("no admitted host tools");
        const call = hostToolCall(started.providerThreadId, `clhb_${"a".repeat(32)}`, "legacy");
        expect(value.manager.ownsSessionHostToolBinding(call)).toBe(false);
        await expect(value.manager.handleSessionHostToolCall(call)).rejects.toThrow();
        const turn = await startTurn(value.manager, started.providerThreadId, "Continue legacy work.");
        expect(turn).toMatch(/^[0-9a-f-]{36}$/u);
        await expect(value.manager.readSession({
          authority,
          providerThreadId: started.providerThreadId,
          detail: true,
          signal: signal(),
        })).resolves.toMatchObject({ status: "active", activeTurnId: turn });
        expect(value.bindingAuthority.activations).toEqual([]);
      } finally {
        await value.manager.close();
      }
      expect(value.bindingAuthority.revocations).toEqual([]);
    });
  }

  test("provisions a strict MCP binding before spawn and activates it only after session commit", async () => {
    const handled: HraHostToolCall[] = [];
    const receipts: HraHostToolCall[] = [];
    const value = harness({
      hostTool: (call) => { handled.push(call); return { sessions: [] }; },
      hostToolResponseWritten: (call) => { receipts.push(call); },
    });
    const review = await value.manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    });
    const started = await value.manager.startSession({ authority, review, signal: signal() });
    const bindingId = `clhb_${"1".padStart(32, "0")}`;
    const routedCall = hostToolCall(started.providerThreadId, bindingId, "call-retained");
    expect(value.manager.ownsSessionHostToolBinding(routedCall)).toBe(false);
    expect(value.bindingAuthority.provisions).toEqual([{
      callbackSocketPath: HOST_TOOL_SOCKET,
      identity: {
        processGeneration: authority.generation,
        profileId: authority.id,
        provider: "claude",
        providerThreadId: started.providerThreadId,
      },
      privateRoot: HOST_TOOL_PRIVATE_ROOT,
    }]);
    expect(value.launchedRuntimes[0]?.argv.slice(-3)).toEqual([
      "--mcp-config",
      `${HOST_TOOL_PRIVATE_ROOT}/binding-1/mcp.json`,
      "--strict-mcp-config",
    ]);

    const turnReview = await value.manager.reviewTurnStart({
      authority,
      fast: false,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      projectRoot: PROJECT_ROOT,
      providerThreadId: started.providerThreadId,
      signal: signal(),
    });
    await expect(value.manager.startTurn({
      authority,
      clientMessageId: "before-activation",
      message: "work",
      providerThreadId: started.providerThreadId,
      review: turnReview,
      signal: signal(),
    })).rejects.toThrow("not active");
    await value.manager.activateSessionHostTools({
      authority,
      providerThreadId: started.providerThreadId,
      signal: signal(),
    });
    await value.manager.activateSessionHostTools({
      authority,
      providerThreadId: started.providerThreadId,
      signal: signal(),
    });
    expect(value.bindingAuthority.activations).toEqual([bindingId]);
    expect(value.manager.ownsSessionHostToolBinding(routedCall)).toBe(true);
    expect(value.manager.ownsSessionHostToolBinding({
      ...routedCall,
      processGeneration: authority.generation + 1,
    })).toBe(false);
    const turn = await value.manager.startTurn({
      authority,
      clientMessageId: "after-activation",
      message: "work",
      providerThreadId: started.providerThreadId,
      review: turnReview,
      signal: signal(),
    });
    const call = routedCall;
    await expect(value.manager.handleSessionHostToolCall(call)).resolves.toEqual({ sessions: [] });
    await value.manager.handleSessionHostToolResponseWritten(call);
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({
      authority: { processGeneration: authority.generation, profileId: authority.id },
      callId: "call-retained",
      requestId: { type: "string", value: "call-retained" },
      threadId: started.providerThreadId,
      tool: "sessions_list",
      turnId: turn.turnId,
    });
    expect(receipts).toEqual(handled);
    await expect(value.manager.handleSessionHostToolResponseWritten(call)).rejects.toThrow("stale");
    await value.manager.endSession({
      authority,
      providerThreadId: started.providerThreadId,
      signal: signal(),
    });
    expect(value.manager.ownsSessionHostToolBinding(routedCall)).toBe(false);
    expect(value.bindingAuthority.revocations).toEqual([bindingId]);
    await value.manager.close();
  });

  test("rechecks exact live host-tool authority after serialization and fences disconnects", async () => {
    let markHostToolEntered!: () => void;
    let releaseHostTool!: () => void;
    let markDisconnected!: () => void;
    let markTurnResultReceived!: () => void;
    let releaseTurnResult!: () => void;
    const hostToolEntered = new Promise<void>((resolve) => { markHostToolEntered = resolve; });
    const hostToolGate = new Promise<void>((resolve) => { releaseHostTool = resolve; });
    const disconnected = new Promise<void>((resolve) => { markDisconnected = resolve; });
    const turnResultReceived = new Promise<void>((resolve) => { markTurnResultReceived = resolve; });
    const turnResultGate = new Promise<void>((resolve) => { releaseTurnResult = resolve; });
    let normalizedCall: HraHostToolCall | undefined;
    const value = harness({
      hostTool: async (call) => {
        normalizedCall = call;
        markHostToolEntered();
        await hostToolGate;
        return { sessions: [] };
      },
      onFact: async (_factAuthority, fact) => {
        if (fact.type === "tokenUsageUpdated") {
          markTurnResultReceived();
          await turnResultGate;
        }
        if (fact.type === "providerDisconnected") markDisconnected();
      },
    });
    const providerThreadId = await startSession(value.manager);
    const turnId = await startTurn(value.manager, providerThreadId, "exercise live admission");
    const bindingId = `clhb_${"1".padStart(32, "0")}`;
    const call = hostToolCall(providerThreadId, bindingId, "call-live-admission");
    const pending = value.manager.handleSessionHostToolCall(call);
    void pending.catch(() => undefined);
    try {
      await hostToolEntered;
      if (normalizedCall === undefined) throw new Error("Expected a normalized host-tool call.");
      const liveAuthority = {
        authority,
        providerThreadId,
        connectionId: normalizedCall.connectionId,
        turnId,
        callId: normalizedCall.callId,
        requestDigest: normalizedCall.requestDigest,
      };
      expect(value.manager.hasLiveHostToolCall(liveAuthority)).toBe(true);
      expect(normalizedCall.authority).toEqual({
        bindingGeneration: authority.bindingGeneration,
        processGeneration: authority.generation,
        profileId: authority.id,
        provider: "claude",
        providerAccountId: authority.providerAccountId,
      });
      for (const changedAuthority of [
        { ...authority, bindingGeneration: authority.bindingGeneration + 1 },
        { ...authority, providerAccountId: `pact_${"f".repeat(32)}` },
        { ...authority, provider: "codex" as const },
      ]) {
        expect(value.manager.hasLiveHostToolCall({ ...liveAuthority, authority: changedAuthority })).toBe(false);
        expect(value.manager.hasLiveSession({ authority: changedAuthority, providerThreadId })).toBe(false);
      }
      expect(value.manager.hasLiveHostToolCall({
        ...liveAuthority,
        connectionId: "30000000-0000-4000-8000-000000000099",
      })).toBe(false);
      expect(value.manager.hasLiveHostToolCall({
        ...liveAuthority,
        turnId: "stale-turn",
      })).toBe(false);
      expect(value.manager.hasLiveHostToolCall({
        ...liveAuthority,
        requestDigest: "f".repeat(64),
      })).toBe(false);

      const process = value.processes[0];
      if (process === undefined) throw new Error("Expected one spawned Claude process.");
      process.emit({
        duration_ms: 25,
        is_error: false,
        num_turns: 1,
        result: "complete",
        session_id: providerThreadId,
        stop_reason: "end_turn",
        terminal_reason: "completed",
        type: "result",
        usage: { input_tokens: 2, output_tokens: 4 },
      });
      await turnResultReceived;
      expect(value.manager.hasLiveHostToolCall(liveAuthority)).toBe(false);
      releaseTurnResult();
      await settle();
      await expect(value.manager.handleSessionHostToolCall(hostToolCall(
        providerThreadId,
        bindingId,
        "call-after-completion",
      ))).rejects.toThrow("active turn");

      process.end();
      await disconnected;
      expect(value.manager.hasLiveHostToolCall(liveAuthority)).toBe(false);
      expect(value.bindingAuthority.revocations).toEqual([bindingId]);
      await expect(value.manager.handleSessionHostToolCall(hostToolCall(
        providerThreadId,
        bindingId,
        "call-after-disconnect",
      ))).rejects.toThrow("stale");

      releaseHostTool();
      await expect(pending).resolves.toEqual({ sessions: [] });
    } finally {
      releaseTurnResult();
      releaseHostTool();
      await pending.catch(() => undefined);
      await value.manager.close();
    }
  });

  test("fails closed at the bounded session-lifetime host-tool call history", async () => {
    let handled = 0;
    let receipts = 0;
    const value = harness({
      hostTool: () => { handled += 1; return { sessions: [] }; },
      hostToolResponseWritten: () => { receipts += 1; },
    });
    const providerThreadId = await startSession(value.manager);
    await startTurn(value.manager, providerThreadId, "exercise host tools");
    const bindingId = `clhb_${"1".padStart(32, "0")}`;
    let first: ClaudeHostToolCall | undefined;
    for (let index = 0; index < CLAUDE_HOST_TOOL_SESSION_HISTORY_LIMIT; index += 1) {
      const call = hostToolCall(providerThreadId, bindingId, `bounded-call-${String(index)}`);
      first ??= call;
      await value.manager.handleSessionHostToolCall(call);
      await value.manager.handleSessionHostToolResponseWritten(call);
    }
    expect(handled).toBe(CLAUDE_HOST_TOOL_SESSION_HISTORY_LIMIT);
    expect(receipts).toBe(CLAUDE_HOST_TOOL_SESSION_HISTORY_LIMIT);
    await expect(value.manager.handleSessionHostToolCall(first!)).rejects.toThrow("already completed");
    await expect(value.manager.handleSessionHostToolCall(hostToolCall(
      providerThreadId,
      bindingId,
      `bounded-call-${String(CLAUDE_HOST_TOOL_SESSION_HISTORY_LIMIT)}`,
    ))).rejects.toThrow("history is exhausted");
    expect(handled).toBe(CLAUDE_HOST_TOOL_SESSION_HISTORY_LIMIT);
    expect(receipts).toBe(CLAUDE_HOST_TOOL_SESSION_HISTORY_LIMIT);
    await value.manager.close();
  });

  test("retains exact session custody when binding cleanup fails and retries before forgetting", async () => {
    const bindingAuthority = new FakeClaudeBindingAuthority(1);
    const value = harness({ bindingAuthority });
    const providerThreadId = await startSession(value.manager);

    await expect(value.manager.endSession({ authority, providerThreadId, signal: signal() }))
      .rejects.toThrow("cleanup was incomplete");
    expect(value.manager.hasLiveSession({ authority, providerThreadId })).toBe(false);
    await expect(value.manager.readSession({
      authority,
      detail: false,
      providerThreadId,
      signal: signal(),
    })).rejects.toThrow("cleanup is unresolved");
    let releaseRetry!: () => void;
    bindingAuthority.revokeGate = new Promise((resolve) => { releaseRetry = resolve; });
    const retry = value.manager.endSession({ authority, providerThreadId, signal: signal() });
    const joinedRetry = value.manager.endSession({ authority, providerThreadId, signal: signal() });
    let retrySettled = false;
    void retry.then(() => { retrySettled = true; });
    await Promise.resolve();
    expect(retrySettled).toBe(false);
    await expect(value.manager.readSession({
      authority,
      detail: false,
      providerThreadId,
      signal: signal(),
    })).rejects.toThrow("cleanup is unresolved");
    expect(bindingAuthority.revocations).toEqual([
      `clhb_${"1".padStart(32, "0")}`,
      `clhb_${"1".padStart(32, "0")}`,
    ]);
    releaseRetry();
    await Promise.all([retry, joinedRetry]);
    await value.manager.endSession({ authority, providerThreadId, signal: signal() });
    expect(bindingAuthority.revocations).toEqual([
      `clhb_${"1".padStart(32, "0")}`,
      `clhb_${"1".padStart(32, "0")}`,
    ]);
    await value.manager.close();
  });
});

describe("Claude pre-acquisition reservation cleanup", () => {
  test("admits one fresh reviewed reservation with an injected process", async () => {
    const { manager, processes, bindingAuthority } = harness();
    try {
      const review = await manager.reviewSessionStart({
        authority, fast: false, preset: "fable-max", requirement: presetRequirements["fable-max"],
        projectRoot: PROJECT_ROOT, signal: signal(),
      });
      const started = await manager.startSession({
        authority, review, providerThreadId: ADOPTED_PROVIDER_THREAD_ID, signal: signal(),
      });
      expect(started.providerThreadId).toBe(ADOPTED_PROVIDER_THREAD_ID);
      expect(processes).toHaveLength(1);
      expect(bindingAuthority.provisions).toHaveLength(1);
    } finally { await manager.close(); }
  });

  test.each(["lookup_rejection", "abort_after_lookup"] as const)(
    "releases the reserved ID after pre-acquisition failure (%s)",
    async (failure) => {
      let lookups = 0;
      const controller = new AbortController();
      const reason = new Error("Synthetic start-only configuration failure.");
      const { manager, processes, bindingAuthority } = harness({
        configDirFor: () => {
          lookups++;
          if (lookups === 2) {
            if (failure === "lookup_rejection") return Promise.reject(reason);
            controller.abort(reason);
          }
          return CONFIG_DIR;
        },
      });
      const review = () => manager.reviewSessionStart({
        authority, fast: false, preset: "fable-max", requirement: presetRequirements["fable-max"],
        projectRoot: PROJECT_ROOT, signal: signal(),
      });
      try {
        const original = await review();
        expect(lookups).toBe(1);
        await expect(manager.startSession({
          authority, review: original, providerThreadId: ADOPTED_PROVIDER_THREAD_ID, signal: controller.signal,
        })).rejects.toBe(reason);
        expect(lookups).toBe(2);
        expect(processes).toEqual([]);
        expect(bindingAuthority.provisions).toEqual([]);
        const renewed = await review();
        expect(renewed).not.toBe(original);
        expect(renewed.reviewId).not.toBe(original.reviewId);
        expect(lookups).toBe(3);
        const started = await manager.startSession({
          authority, review: renewed, providerThreadId: ADOPTED_PROVIDER_THREAD_ID, signal: signal(),
        });
        expect(started.providerThreadId).toBe(ADOPTED_PROVIDER_THREAD_ID);
        expect(lookups).toBe(4);
        expect(processes).toHaveLength(1);
        expect(bindingAuthority.provisions).toHaveLength(1);
      } finally { await manager.close(); }
    },
  );

  test.each(["resolve", "reject"] as const)(
    "R1 start-time configuration settles before successful manager close (%s)",
    async (disposition) => {
      type Outcome = Readonly<{ status: "fulfilled" }>
        | Readonly<{ status: "rejected"; reason: unknown }>;
      const events: string[] = [];
      const observe = (work: Promise<unknown>, label: string): Promise<Outcome> => work.then(
        () => { events.push(`${label}-fulfilled`); return { status: "fulfilled" }; },
        (reason: unknown) => {
          events.push(`${label}-rejected`);
          return { status: "rejected", reason };
        },
      );
      const lookupReason: unknown = undefined;
      let resolveLookup!: (value: string) => void;
      let rejectLookup!: (reason: unknown) => void;
      const lookup = new Promise<string>((resolve, reject) => {
        resolveLookup = resolve;
        rejectLookup = reject;
      });
      // Observe the original handle without replacing what the manager awaits.
      const lookupObserved = observe(lookup, "lookup");
      let lookupReleased = false;
      const releaseLookup = (): void => {
        if (lookupReleased) return;
        lookupReleased = true;
        events.push("lookup-release-requested");
        if (disposition === "resolve") resolveLookup(CONFIG_DIR);
        else rejectLookup(lookupReason);
      };
      let lookups = 0;
      let lookupEntered = false;
      const { manager, launches, processes, bindingAuthority } = harness({
        configDirFor: () => {
          lookups++;
          if (lookups === 2) {
            lookupEntered = true;
            events.push("lookup-entered");
            return lookup;
          }
          return CONFIG_DIR;
        },
      });
      const counts = () => ({
        launches: launches.length,
        processes: processes.length,
        provisions: bindingAuthority.provisions.length,
      });
      let startObserved: Promise<Outcome> | undefined;
      let closeObserved: Promise<Outcome> | undefined;
      let handoff: Promise<void> | undefined;
      let releaseTimer: ReturnType<typeof setTimeout> | undefined;
      let beforeRelease: ReturnType<typeof counts> | undefined;
      let enteredBeforeReturn = false;
      let primaryFailure: Readonly<{ reason: unknown }> | undefined;
      try {
        const review = await manager.reviewSessionStart({
          authority, fast: false, preset: "fable-max", requirement: presetRequirements["fable-max"],
          projectRoot: PROJECT_ROOT, signal: signal(),
        });
        expect(lookups).toBe(1);
        events.push("review-completed");
        const starting = manager.startSession({
          authority, review, providerThreadId: ADOPTED_PROVIDER_THREAD_ID, signal: signal(),
        });
        startObserved = observe(starting, "start");
        events.push("start-returned");
        enteredBeforeReturn = lookupEntered;
        beforeRelease = counts();
        events.push("close-called");
        const closing = manager.close();
        closeObserved = observe(closing, "close");
        events.push("close-returned");
        // One later native event-loop turn releases the exact pending lookup.
        // Its duration is not the oracle: the recorded settlement order is.
        handoff = new Promise<void>((resolve) => {
          releaseTimer = setTimeout(() => {
            events.push("release-handoff-entered");
            releaseLookup();
            resolve();
          }, 0);
        });
        const [lookupOutcome, startOutcome, closeOutcome] = await Promise.all([
          lookupObserved, startObserved, closeObserved, handoff,
        ]);
        expect(enteredBeforeReturn).toBe(true);
        expect(beforeRelease).toEqual({ launches: 0, processes: 0, provisions: 0 });
        expect(counts()).toEqual({ launches: 0, processes: 0, provisions: 0 });
        expect(lookups).toBe(2);
        expect(lookupOutcome.status).toBe(disposition === "resolve" ? "fulfilled" : "rejected");
        expect(startOutcome.status).toBe("rejected");
        if (startOutcome.status === "rejected") {
          if (disposition === "reject") expect(startOutcome.reason).toBe(lookupReason);
          else expect(startOutcome.reason).toMatchObject({ code: "PROCESS_EXITED" });
        }
        expect(closeOutcome.status).toBe("fulfilled");
        const lookupIndex = events.indexOf(`lookup-${lookupOutcome.status}`);
        const closeIndex = events.indexOf("close-fulfilled");
        expect(lookupIndex).toBeGreaterThanOrEqual(0);
        expect(closeIndex).toBeGreaterThanOrEqual(0);
        expect(closeIndex < lookupIndex).toBe(false);
      } catch (reason: unknown) {
        primaryFailure = { reason };
      } finally {
        // Assertion failure cannot strand the original lookup or a started call.
        releaseLookup();
        const lookupOutcome = await lookupObserved;
        const startOutcome = await startObserved;
        const closeOutcome = await closeObserved;
        await handoff;
        if (releaseTimer !== undefined) clearTimeout(releaseTimer);
        const cleanup = await observe(manager.close(), "cleanup");
        const lookupIndex = events.indexOf(`lookup-${lookupOutcome.status}`);
        const closeIndex = events.indexOf("close-fulfilled");
        const successfulCloseBeforeLookup = lookupIndex >= 0 && closeIndex >= 0
          ? closeIndex < lookupIndex
          : null;
        console.info(JSON.stringify({
          schema: "hra-r1-config-close-trace-v1",
          disposition,
          events,
          enteredBeforeReturn,
          beforeRelease,
          afterJoin: counts(),
          lookupStatus: lookupOutcome.status,
          startStatus: startOutcome?.status,
          originalLookupReasonPreserved: disposition === "reject"
            && startOutcome?.status === "rejected" && startOutcome.reason === lookupReason,
          closeStatus: closeOutcome?.status,
          successfulCloseBeforeLookup,
          cleanup: {
            lookupJoined: true,
            startJoined: startObserved !== undefined,
            closeJoined: closeObserved !== undefined,
            handoffJoined: handoff !== undefined,
            finalCloseStatus: cleanup.status,
          },
        }));
        if (cleanup.status === "rejected" && primaryFailure === undefined) {
          primaryFailure = { reason: cleanup.reason };
        }
      }
      if (primaryFailure !== undefined) throw primaryFailure.reason;
    },
  );

});
