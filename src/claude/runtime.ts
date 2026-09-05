import { lstat, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

import { ClaudeError } from "./errors.ts";
import { CLAUDE_PIN, CLAUDE_PIN_EFFORT, CLAUDE_PIN_MODEL } from "./pin.ts";
import { allowlistedEnvironment } from "./process.ts";
import { assertPinnedClaudeMatrices, assertPinnedClaudeVersion } from "./protocol.ts";

export interface PinnedClaudeRuntime {
  readonly executablePath: string;
  readonly version: typeof CLAUDE_PIN;
  readonly model: typeof CLAUDE_PIN_MODEL;
  readonly effort: typeof CLAUDE_PIN_EFFORT;
  readonly argv: readonly [string, ...string[]];
}

export type ClaudeSessionLaunch = Readonly<{
  kind: "create" | "resume";
  providerThreadId: string;
}>;

export interface ClaudeVersionProbeProcess {
  readonly exited: Promise<number>;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  terminate(): void;
  forceTerminate(): void;
}

export type ClaudeVersionProbeProcessFactory = (input: Readonly<{
  argv: readonly [string, "--version"];
  environment: Readonly<Record<string, string>>;
}>) => ClaudeVersionProbeProcess;

export type ClaudeVersionProbe = (input: {
  readonly executablePath: string;
  readonly configDir: string;
  readonly configHome: "isolated" | "personal";
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
  readonly processFactory?: ClaudeVersionProbeProcessFactory;
}) => Promise<string>;

export interface ResolvePinnedClaudeRuntimeOptions {
  /** Absolute path to the `claude` executable. Located on PATH when omitted. */
  readonly executablePath?: string;
  /** Absolute reviewed home; exported as `CLAUDE_CONFIG_DIR` only in isolated mode. */
  readonly configDir: string;
  /** Defaults to an explicitly selected isolated home. */
  readonly configHome?: "isolated" | "personal";
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly probeVersion?: ClaudeVersionProbe;
  readonly signal?: AbortSignal;
  readonly versionProbeDeadlineMs?: number;
  readonly versionProbeProcessFactory?: ClaudeVersionProbeProcessFactory;
}

// Claude Code currently reports either `x.y.z` or `x.y.z (Claude Code)`, with
// an optional final line ending. The whole output is the version assertion: accepting
// a matching substring would let a wrapper, prerelease, or multi-version line
// masquerade as the pinned executable.
const versionOutputPattern = /^(\d{1,5}\.\d{1,5}\.\d{1,5})(?: \(Claude Code\))?\r?\n?$/u;
const VERSION_PROBE_DEADLINE_MS = 5_000;
const VERSION_PROBE_STDOUT_MAX_BYTES = 512;
const VERSION_PROBE_STDERR_MAX_BYTES = 4 * 1024;
const VERSION_PROBE_TERMINATION_GRACE_MS = 250;
const VERSION_PROBE_FORCE_JOIN_MS = 1_000;
const sessionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const chunks = async function* (
  stream: ReadableStream<Uint8Array> | number | undefined,
): AsyncIterable<Uint8Array> {
  if (stream === undefined || typeof stream === "number") return;
  const reader = stream.getReader();
  try {
    let next = await reader.read();
    while (!next.done) {
      if (next.value.byteLength > 0) yield next.value;
      next = await reader.read();
    }
  } finally {
    reader.releaseLock();
  }
};

const defaultVersionProbeProcess: ClaudeVersionProbeProcessFactory = (input) => {
  const child = Bun.spawn([...input.argv], {
    env: input.environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exited: child.exited,
    stdout: chunks(child.stdout),
    stderr: chunks(child.stderr),
    terminate: () => { child.kill("SIGTERM"); },
    forceTerminate: () => { child.kill("SIGKILL"); },
  };
};

const collectVersionOutput = async (
  stream: AsyncIterable<Uint8Array>,
  maximumBytes: number,
): Promise<Uint8Array> => {
  const values: Uint8Array[] = [];
  let size = 0;
  for await (const value of stream) {
    size += value.byteLength;
    if (size > maximumBytes) {
      throw new ClaudeError("PROTOCOL_LIMIT", "Claude version output exceeded its bounded limit.");
    }
    values.push(value);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const value of values) {
    joined.set(value, offset);
    offset += value.byteLength;
  }
  return joined;
};

const wait = (milliseconds: number): Promise<"timeout"> => new Promise((resolve) => {
  const timer = setTimeout(() => resolve("timeout"), milliseconds);
  timer.unref();
});

const stopVersionProbe = async (
  child: ClaudeVersionProbeProcess,
  exit: Promise<number>,
  exitResolved: () => boolean,
  drains: readonly Promise<unknown>[],
): Promise<void> => {
  try { child.terminate(); } catch { /* force below */ }
  await Promise.race([
    exit.then(() => true, () => true),
    wait(VERSION_PROBE_TERMINATION_GRACE_MS).then(() => false),
  ]);
  if (!exitResolved()) {
    try { child.forceTerminate(); } catch { /* bounded join remains authoritative */ }
    await Promise.race([
      exit.then(() => true, () => true),
      wait(VERSION_PROBE_FORCE_JOIN_MS).then(() => false),
    ]);
  }
  if (!exitResolved()) {
    throw new ClaudeError("PROCESS_EXITED", "Claude version probe could not be joined after forced termination.");
  }
  const drained = await Promise.race([
    Promise.allSettled(drains).then(() => true),
    wait(VERSION_PROBE_FORCE_JOIN_MS).then(() => false),
  ]);
  if (!drained) throw new ClaudeError("PROCESS_EXITED", "Claude version probe output could not be drained after termination.");
};

/**
 * Binds one process invocation to one durable Claude session. Creation and
 * resume are deliberately distinct flags: a typo must never make Claude
 * allocate a new conversation while HRA believes it reclaimed an old one.
 */
export function claudeSessionArgv(
  runtime: PinnedClaudeRuntime,
  launch: ClaudeSessionLaunch,
): readonly [string, ...string[]] {
  if (!sessionIdPattern.test(launch.providerThreadId)) {
    throw new ClaudeError(
      "INVALID_INPUT",
      "A Claude provider session id must be a canonical lowercase UUID.",
    );
  }
  return [
    ...runtime.argv,
    launch.kind === "create" ? "--session-id" : "--resume",
    launch.providerThreadId,
  ];
}

/** Reads `claude --version` inside the reviewed home, bounded and non-interactive. */
export const spawnClaudeVersionProbe: ClaudeVersionProbe = async (input) => {
  input.signal.throwIfAborted();
  const env = allowlistedEnvironment(input.environment);
  if (input.configHome === "isolated") env.CLAUDE_CONFIG_DIR = input.configDir;
  env.NO_COLOR = "1";
  let child: ClaudeVersionProbeProcess;
  try {
    child = (input.processFactory ?? defaultVersionProbeProcess)({
      argv: [input.executablePath, "--version"],
      environment: env,
    });
  } catch (error: unknown) {
    throw new ClaudeError("RUNTIME_MISMATCH", "the Claude Code version probe could not be started", { cause: error });
  }
  const stdout = collectVersionOutput(child.stdout, VERSION_PROBE_STDOUT_MAX_BYTES);
  const stderr = collectVersionOutput(child.stderr, VERSION_PROBE_STDERR_MAX_BYTES);
  let exitResolved = false;
  const exit = child.exited.then(
    (code) => { exitResolved = true; return code; },
    (error: unknown) => { throw error; },
  );
  const completion = Promise.all([stdout, stderr, exit]);
  let abort!: () => void;
  const aborted = new Promise<"aborted">((resolve) => { abort = () => resolve("aborted"); });
  input.signal.addEventListener("abort", abort, { once: true });
  if (input.signal.aborted) abort();
  let outcome: Awaited<typeof completion>;
  let stopped = false;
  try {
    const settled = await Promise.race([completion, aborted, wait(input.deadlineMs)]);
    if (settled === "aborted" || settled === "timeout") {
      await stopVersionProbe(child, exit, () => exitResolved, [stdout, stderr]);
      stopped = true;
      throw new ClaudeError(
        settled === "timeout" ? "TIMEOUT" : "PROCESS_EXITED",
        settled === "timeout" ? "Claude version probe exceeded its bounded deadline." : "Claude version probe was canceled.",
      );
    }
    outcome = settled;
  } catch (error: unknown) {
    if (!stopped) await stopVersionProbe(child, exit, () => exitResolved, [stdout, stderr]);
    if (error instanceof ClaudeError) throw error;
    throw new ClaudeError("RUNTIME_MISMATCH", "the Claude Code version probe failed", { cause: error });
  } finally {
    input.signal.removeEventListener("abort", abort);
  }
  const [output, diagnostic, code] = outcome;
  void diagnostic;
  if (code !== 0) {
    throw new ClaudeError("RUNTIME_MISMATCH", "the Claude Code executable did not report a version");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(output).slice(0, 256);
};

/**
 * Finds `claude` on the allowlisted PATH. No shell is involved, and only a
 * regular file is accepted.
 */
export async function locateClaudeExecutable(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  const path = environment.PATH ?? "";
  for (const entry of path.split(delimiter)) {
    if (entry.length === 0 || !isAbsolute(entry)) continue;
    const candidate = join(entry, "claude");
    const stat = await lstat(candidate).catch(() => null);
    if (stat === null) continue;
    if (stat.isFile() || stat.isSymbolicLink()) return candidate;
  }
  throw new ClaudeError("RUNTIME_MISMATCH", "the pinned Claude Code executable is not installed");
}

/**
 * Resolves the Claude Code executable and admits only the pinned self-reported
 * version. This is a compatibility assertion, not executable provenance: the
 * stream-json surface is not a published contract, so any other reported
 * version fails closed here rather than being parsed hopefully.
 */
export async function resolvePinnedClaudeRuntime(
  options: ResolvePinnedClaudeRuntimeOptions,
): Promise<PinnedClaudeRuntime> {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  assertPinnedClaudeMatrices();
  if (!isAbsolute(options.configDir)) {
    throw new ClaudeError("INVALID_INPUT", "CLAUDE_CONFIG_DIR must be an absolute path");
  }
  const environment = options.environment ?? process.env;
  const requested = options.executablePath ?? (await locateClaudeExecutable(environment));
  if (!isAbsolute(requested)) {
    throw new ClaudeError("INVALID_INPUT", "the Claude Code executable path must be absolute");
  }
  const executablePath = await realpath(requested).catch((error: unknown) => {
    throw new ClaudeError("RUNTIME_MISMATCH", "the pinned Claude Code executable is unavailable", {
      cause: error,
    });
  });
  const stat = await lstat(executablePath);
  if (!stat.isFile()) {
    throw new ClaudeError("RUNTIME_MISMATCH", "the Claude Code executable is not a regular file");
  }

  const probe = options.probeVersion ?? spawnClaudeVersionProbe;
  const deadlineMs = options.versionProbeDeadlineMs ?? VERSION_PROBE_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000) {
    throw new ClaudeError("INVALID_INPUT", "Claude version probe deadline is invalid");
  }
  const reported = await probe({
    configDir: options.configDir,
    configHome: options.configHome ?? "isolated",
    environment,
    executablePath,
    signal,
    deadlineMs,
    ...(options.versionProbeProcessFactory === undefined ? {} : {
      processFactory: options.versionProbeProcessFactory,
    }),
  });
  signal.throwIfAborted();
  const version = versionOutputPattern.exec(reported)?.[1];
  if (version === undefined) {
    throw new ClaudeError("RUNTIME_MISMATCH", "the Claude Code executable reported no exact version");
  }
  assertPinnedClaudeVersion(version);

  return {
    argv: [
      executablePath,
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
    ],
    effort: CLAUDE_PIN_EFFORT,
    executablePath,
    model: CLAUDE_PIN_MODEL,
    version: CLAUDE_PIN,
  };
}
