import { describe, expect, test } from "bun:test";
import { lstatSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ClaudeAuthStatusReader,
  ClaudeProcess,
  PinnedClaudeRuntime,
} from "../claude/index";
import { CLAUDE_PIN, CLAUDE_PIN_EFFORT, CLAUDE_PIN_MODEL } from "../claude/pin";
import { PresetProviderMismatchError } from "../domain/presets";
import { effectiveClaudeRuntimeProfileSchema } from "../domain/runtime-profile";
import { ensurePrivateDirectory } from "../storage/paths";
import {
  PinnedClaudeRuntimeManager,
  type ClaudeSessionFact,
} from "./claude-runtime-adapter";
import type { ProfileAuthority } from "./ports";

const CONFIG_DIR = "/var/hra/profiles/acct/claude";
const PROJECT_ROOT = "/var/hra/projects/demo";

const authority: ProfileAuthority = {
  codexHome: "/var/hra/profiles/acct/codex",
  desktopUserData: "/var/hra/profiles/acct/desktop",
  generation: 3,
  id: "acct_00000000000000000000000000000000",
};

class FakeClaudeProcess implements ClaudeProcess {
  readonly written: string[] = [];
  #push: ((chunk: Uint8Array) => void) | undefined;
  #finish: (() => void) | undefined;
  #resolveExit: ((code: number) => void) | undefined;
  readonly exited: Promise<number>;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array> = { async *[Symbol.asyncIterator]() { /* silent */ } };

  constructor() {
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
  }

  terminate(): void {
    this.#finish?.();
    this.#resolveExit?.(0);
  }

  forceTerminate(): void { this.terminate(); }
}

const runtime: PinnedClaudeRuntime = {
  argv: ["/usr/local/bin/claude", "--print"],
  effort: CLAUDE_PIN_EFFORT,
  executablePath: "/usr/local/bin/claude",
  model: CLAUDE_PIN_MODEL,
  version: CLAUDE_PIN,
};

const settle = async (): Promise<void> => {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  await new Promise((resolve) => { setTimeout(resolve, 1); });
};

const harness = (options: {
  clientShutdownSettlementMs?: number;
  clientShutdownTermGraceMs?: number;
  configDirFor?: ConstructorParameters<typeof PinnedClaudeRuntimeManager>[0]["configDirFor"];
  isCurrent?: (authority: ProfileAuthority) => boolean;
  processFactory?: ConstructorParameters<typeof PinnedClaudeRuntimeManager>[0]["processFactory"];
  readAuthStatus?: ClaudeAuthStatusReader;
  resolveRuntime?: ConstructorParameters<typeof PinnedClaudeRuntimeManager>[0]["resolveRuntime"];
} = {}) => {
  const facts: ClaudeSessionFact[] = [];
  const processes: FakeClaudeProcess[] = [];
  const manager = new PinnedClaudeRuntimeManager({
    configDirFor: options.configDirFor ?? (() => CONFIG_DIR),
    ...(options.clientShutdownSettlementMs === undefined
      ? {}
      : { clientShutdownSettlementMs: options.clientShutdownSettlementMs }),
    ...(options.clientShutdownTermGraceMs === undefined
      ? {}
      : { clientShutdownTermGraceMs: options.clientShutdownTermGraceMs }),
    isCurrent: options.isCurrent ?? (() => true),
    now: () => 1_700_000_000_000,
    observer: { fact: (_authority, fact) => { facts.push(fact); } },
    processFactory: options.processFactory ?? (() => {
      const process = new FakeClaudeProcess();
      processes.push(process);
      return process;
    }),
    ...(options.readAuthStatus === undefined ? {} : { readAuthStatus: options.readAuthStatus }),
    resolveRuntime: options.resolveRuntime ?? (async () => runtime),
  });
  return { facts, manager, processes };
};

const signal = (): AbortSignal => new AbortController().signal;

const startSession = async (
  manager: PinnedClaudeRuntimeManager,
): Promise<string> => {
  const review = await manager.reviewSessionStart({
    authority,
    fast: false,
    preset: "fable-max",
    projectRoot: PROJECT_ROOT,
    signal: signal(),
  });
  const started = await manager.startSession({ authority, review, signal: signal() });
  return started.providerThreadId;
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
  test("reports Claude's isolated auth status rather than inferring it from sessions", async () => {
    let signedIn = false;
    const reads: Readonly<{ configDir: string; signal: AbortSignal }>[] = [];
    const { manager } = harness({
      readAuthStatus: (input) => {
        reads.push(input);
        return Promise.resolve({ signedIn });
      },
    });
    expect(await manager.readAccount({ authority, signal: signal() })).toEqual({ signedIn: false });
    await startSession(manager);
    // A running process is not evidence that the isolated home is currently
    // authenticated; only Claude's own status command is authoritative.
    expect(await manager.readAccount({ authority, signal: signal() })).toEqual({ signedIn: false });
    signedIn = true;
    expect(await manager.readAccount({ authority, signal: signal() })).toEqual({ signedIn: true });
    expect(reads.map(({ configDir }) => configDir)).toEqual([
      CONFIG_DIR,
      CONFIG_DIR,
      CONFIG_DIR,
    ]);
    await manager.close();
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
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    });
    const review = await manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "fable-max",
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    });

    await expect(manager.startSession({ authority, review, signal: signal() }))
      .rejects.toThrow("child cleanup was incomplete");
    expect(launches).toBe(1);
    expect(terminations).toEqual(["terminate", "force"]);

    await expect(manager.reviewSessionStart({
      authority: alternateAuthority,
      fast: false,
      preset: "fable-max",
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
    const { facts, manager, processes } = harness();
    const review = await manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "fable-max",
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    });
    expect(review.kind).toBe("session_start");
    expect(effectiveClaudeRuntimeProfileSchema.parse(review.effectiveRuntimeProfile)).toEqual({
      claudeVersion: CLAUDE_PIN,
      inputFormat: "stream-json",
      isolatedConfigDir: true,
      model: CLAUDE_PIN_MODEL,
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
        claude_code_version: CLAUDE_PIN,
        model: CLAUDE_PIN_MODEL,
        permissionMode: "default",
        session_id: "sess",
        subtype: "init",
        tools: ["Bash"],
        type: "system",
      },
      {
        message: {
          content: [{ text: "ok", type: "text" }],
          id: "msg_1",
          model: CLAUDE_PIN_MODEL,
          role: "assistant",
          type: "message",
        },
        parent_tool_use_id: null,
        session_id: "sess",
        type: "assistant",
      },
      {
        duration_ms: 2_259,
        is_error: false,
        num_turns: 1,
        result: "ok",
        session_id: "sess",
        stop_reason: "end_turn",
        terminal_reason: "completed",
        type: "result",
        usage: { input_tokens: 2, output_tokens: 4 },
      },
    );
    await settle();

    expect(facts.map((fact) => fact.type)).toEqual([
      "turnStarted",
      "sessionBootstrapped",
      "assistantDelta",
      "tokenUsageUpdated",
      "turnCompleted",
      "turnSummary",
    ]);
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

  test("refuses a preset the Claude provider does not support", async () => {
    const { manager } = harness();
    await expect(manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "ultra",
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    })).rejects.toThrow(PresetProviderMismatchError);
    await expect(manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "low",
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    })).rejects.toThrow("does not support the `low` model preset");
    // Fast mode is a Codex service tier; Claude refuses it rather than ignoring it.
    await expect(manager.reviewSessionStart({
      authority,
      fast: true,
      preset: "fable-max",
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    })).rejects.toThrow("no HRA fast mode");
    await manager.close();
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
    const bashAuthority = manager.interactionAuthority(providerThreadId, "r-bash");
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
    const editAuthority = manager.interactionAuthority(providerThreadId, "r-edit");
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
    const askAuthority = manager.interactionAuthority(providerThreadId, "r-ask");
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
    const provider = manager.interactionAuthority(providerThreadId, "req-1");
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

  test("refuses a review that names no project directory", async () => {
    const { manager } = harness();
    await expect(manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "fable-max",
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
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    });
    await manager.startSession({ authority, review, signal: signal() });
    await expect(manager.startSession({ authority, review, signal: signal() }))
      .rejects.toThrow("no longer usable");
    await manager.close();
  });
});
