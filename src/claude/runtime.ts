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

export type ClaudeVersionProbe = (input: {
  readonly executablePath: string;
  readonly configDir: string;
  readonly configHome: "isolated" | "personal";
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  /** Focused test/embedding override; production uses the closed default. */
  readonly timeoutMs?: number;
  readonly spawn?: ClaudeVersionProbeSpawner;
}) => Promise<string>;

export type ClaudeVersionProbeProcess = Readonly<{
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array> | number | undefined;
  forceTerminate(): void;
}>;

export type ClaudeVersionProbeSpawner = (
  argv: readonly [string, ...string[]],
  options: Readonly<{
    env: Readonly<Record<string, string>>;
    stdin: "ignore";
    stdout: "pipe";
    stderr: "ignore";
  }>,
) => ClaudeVersionProbeProcess;

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
}

const versionPattern = /\b(\d{1,5}\.\d{1,5}\.\d{1,5})\b/u;
const VERSION_PROBE_MAX_BYTES = 4 * 1_024;
const VERSION_PROBE_TIMEOUT_MS = 3_000;
const VERSION_PROBE_EXIT_SETTLEMENT_MS = 1_000;
const sessionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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
  const timeoutMs = boundedVersionProbeTimeout(input.timeoutMs ?? VERSION_PROBE_TIMEOUT_MS);
  const env = allowlistedEnvironment(input.environment);
  if (input.configHome === "isolated") env.CLAUDE_CONFIG_DIR = input.configDir;
  env.NO_COLOR = "1";
  const spawn: ClaudeVersionProbeSpawner = input.spawn
    ?? ((argv, options) => {
      const child = Bun.spawn([...argv], options);
      return {
        exited: child.exited,
        forceTerminate: () => { child.kill("SIGKILL"); },
        stdout: child.stdout,
      };
    });
  const child = spawn([input.executablePath, "--version"], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const outputController = new AbortController();
  const stdout = collectBoundedVersionStdout(
    child.stdout,
    VERSION_PROBE_MAX_BYTES,
    outputController.signal,
  );
  const completion = Promise.all([child.exited, stdout]);
  void completion.catch(() => undefined);
  let rejectBoundary!: (reason: unknown) => void;
  let canceled = false;
  const boundary = new Promise<never>((_resolve, reject) => { rejectBoundary = reject; });
  const cancel = (reason: unknown): void => {
    if (canceled) return;
    canceled = true;
    rejectBoundary(reason);
  };
  const onAbort = (): void => cancel(input.signal.reason);
  input.signal.addEventListener("abort", onAbort, { once: true });
  if (input.signal.aborted) onAbort();
  const timer = setTimeout(
    () => cancel(new ClaudeError("TIMEOUT", "the Claude Code version probe did not settle in time")),
    timeoutMs,
  );
  timer.unref();
  try {
    const [code, text] = await Promise.race([completion, boundary]);
    input.signal.throwIfAborted();
    if (code !== 0) {
      throw new ClaudeError("RUNTIME_MISMATCH", "the Claude Code executable did not report a version");
    }
    return text.slice(0, 256);
  } catch (error: unknown) {
    try {
      child.forceTerminate();
    } catch {
      // Exact exit settlement below remains authoritative.
    }
    outputController.abort(error);
    if (!await resolvesWithin(child.exited, VERSION_PROBE_EXIT_SETTLEMENT_MS)) {
      throw new ClaudeError(
        "PROCESS_EXITED",
        "the Claude Code version probe could not be reaped after force termination",
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", onAbort);
  }
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
 * Resolves and admits the pinned Claude Code executable. HRA refuses to run
 * any other build: the stream-json surface is not a published contract, so a
 * version other than `CLAUDE_PIN` fails closed here rather than being parsed
 * hopefully.
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
  const reported = await probe({
    configDir: options.configDir,
    configHome: options.configHome ?? "isolated",
    environment,
    executablePath,
    signal,
  });
  signal.throwIfAborted();
  const version = versionPattern.exec(reported)?.[1];
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

function boundedVersionProbeTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 30_000) {
    throw new ClaudeError(
      "INVALID_INPUT",
      "the Claude Code version probe timeout must be between 1 and 30000 milliseconds",
    );
  }
  return value;
}

async function collectBoundedVersionStdout(
  stream: ReadableStream<Uint8Array> | number | undefined,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  if (stream === undefined || typeof stream === "number") {
    throw new ClaudeError("PROCESS_EXITED", "the Claude Code version probe exposed no stdout stream");
  }
  const reader = stream.getReader();
  const onAbort = (): void => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        throw new ClaudeError("PROTOCOL_LIMIT", "the Claude Code version probe exceeded its output bound");
      }
      if (next.value.byteLength > 0) chunks.push(next.value);
    }
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause: unknown) {
    throw new ClaudeError(
      "PROTOCOL_ERROR",
      "the Claude Code version probe did not emit valid UTF-8",
      { cause },
    );
  }
}

async function resolvesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([
      promise.then(
        () => true as const,
        () => false as const,
      ),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
