import { lstat, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

import { z } from "zod";

import { ClaudeError } from "./errors.ts";
import {
  CLAUDE_NATIVE_FALLBACK_UNAVAILABLE_REASON,
  CLAUDE_PIN,
  CLAUDE_PIN_EFFORT,
  CLAUDE_PIN_FALLBACK_MODEL,
  CLAUDE_PIN_MODEL,
  CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY,
  type ClaudeNativeFallbackCapability,
} from "./pin.ts";
import { allowlistedEnvironment } from "./process.ts";
import { assertPinnedClaudeMatrices, assertPinnedClaudeVersion } from "./protocol.ts";

export interface PinnedClaudeRuntime {
  readonly executablePath: string;
  readonly version: typeof CLAUDE_PIN;
  readonly model: typeof CLAUDE_PIN_MODEL;
  readonly effort: typeof CLAUDE_PIN_EFFORT;
  readonly nativeFallback: ClaudeNativeFallbackCapability;
  readonly argv: readonly [string, ...string[]];
}

export type ClaudeVersionProbe = (input: {
  readonly executablePath: string;
  readonly configDir: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Tests and callers may lower, but never raise, the production bound. */
  readonly timeoutMs?: number;
}) => Promise<string>;

export type ClaudeAuthReadiness = "signed_in" | "signed_out" | "unverified";

export type ClaudeAuthStatusProbe = (input: {
  readonly executablePath: string;
  readonly configDir: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  /** Tests and callers may lower, but never raise, the production bounds. */
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
}) => Promise<ClaudeAuthReadiness>;

export interface ResolvePinnedClaudeRuntimeOptions {
  /** Absolute path to the `claude` executable. Located on PATH when omitted. */
  readonly executablePath?: string;
  /** Absolute, isolated `CLAUDE_CONFIG_DIR` for this profile. */
  readonly configDir: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly probeVersion?: ClaudeVersionProbe;
}

const versionPattern = /\b(\d{1,5}\.\d{1,5}\.\d{1,5})\b/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const CLAUDE_PROBE_TIMEOUT_MS = 5_000;
const CLAUDE_VERSION_OUTPUT_BYTES = 256;
const CLAUDE_AUTH_STATUS_OUTPUT_BYTES = 4 * 1_024;
const claudeSignedOutAuthStatusSchema = z.object({
  analyticsDisabled: z.boolean(),
  apiProvider: z.literal("firstParty"),
  authMethod: z.literal("none"),
  loggedIn: z.literal(false),
  // This value is deliberately validated and dropped. It is local path data,
  // not account identity or readiness evidence.
  projectsDirectory: z.string().min(1).max(4_096),
}).strict();
const hasExactKeys = (
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean => {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => key in value);
};

/**
 * Builds the two reviewed argv forms without starting a process. Production
 * resolution passes only the pinned capability above; keeping construction
 * pure lets the armed shape remain testable while the live gate is closed.
 */
export function buildPinnedClaudeRuntimeArgv(input: {
  readonly executablePath: string;
  readonly nativeFallback: ClaudeNativeFallbackCapability;
}): readonly [string, ...string[]] {
  // Keep the runtime check even though TypeScript callers carry the closed
  // union: tests, injected adapters, and plain JavaScript can still cross
  // this exported boundary without the compiler's protection.
  const nativeFallback = input.nativeFallback as unknown;
  if (typeof nativeFallback !== "object" || nativeFallback === null || Array.isArray(nativeFallback)) {
    throw new ClaudeError("INVALID_INPUT", "The Claude native fallback capability is invalid");
  }
  const capability = nativeFallback as Readonly<Record<string, unknown>>;
  if (capability.model !== CLAUDE_PIN_FALLBACK_MODEL) {
    throw new ClaudeError(
      "INVALID_INPUT",
      "The Claude native fallback must match the exact pinned fallback model",
    );
  }
  let fallbackArgument: readonly string[] = [];
  if (capability.status === "unavailable") {
    if (!hasExactKeys(capability, ["model", "reason", "status"])
      || capability.reason !== CLAUDE_NATIVE_FALLBACK_UNAVAILABLE_REASON) {
      throw new ClaudeError(
        "INVALID_INPUT",
        "The unavailable Claude native fallback must carry the reviewed reason",
      );
    }
  } else if (capability.status === "armed") {
    if (!hasExactKeys(capability, ["evidenceDigest", "model", "status"])
      || typeof capability.evidenceDigest !== "string"
      || !sha256Pattern.test(capability.evidenceDigest)) {
      throw new ClaudeError(
        "INVALID_INPUT",
        "An armed Claude native fallback requires one sanitized acceptance evidence digest",
      );
    }
    fallbackArgument = ["--fallback-model", CLAUDE_PIN_FALLBACK_MODEL];
  } else {
    throw new ClaudeError(
      "INVALID_INPUT",
      "The Claude native fallback capability has an unknown status",
    );
  }
  return [
    input.executablePath,
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
    ...fallbackArgument,
    "--effort",
    CLAUDE_PIN_EFFORT,
  ];
}

type BoundedProbeResult = Readonly<{
  exitCode: number;
  output: Uint8Array;
}>;

const loweredPositiveBound = (requested: number | undefined, maximum: number): number =>
  requested === undefined
    ? maximum
    : Number.isSafeInteger(requested) && requested > 0
      ? Math.min(requested, maximum)
      : maximum;

/**
 * Runs one read-only Claude inspection without retaining provider output past
 * the call. The byte cap is applied before concatenation or UTF-8 decoding,
 * and every timeout, overflow, spawn failure, or non-piped stdout fails
 * closed. An explicit caller cancellation remains cancellation rather than an
 * account observation.
 */
async function runBoundedClaudeProbe(input: {
  readonly argv: readonly [string, ...string[]];
  readonly configDir: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}): Promise<BoundedProbeResult | null> {
  input.signal?.throwIfAborted();
  const env = allowlistedEnvironment(input.environment);
  env.CLAUDE_CONFIG_DIR = input.configDir;
  env.NO_COLOR = "1";

  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([...input.argv], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    return null;
  }

  const stdout = child.stdout;
  if (stdout === undefined || typeof stdout === "number") {
    child.kill("SIGKILL");
    await child.exited.catch(() => undefined);
    return null;
  }

  const state: { canceled: boolean; invalid: boolean } = {
    canceled: false,
    invalid: false,
  };
  const terminate = (): void => {
    try {
      child.kill("SIGKILL");
    } catch {
      // A process that exited between observation and termination is already
      // in the desired state.
    }
  };
  const onAbort = (): void => {
    state.canceled = true;
    terminate();
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    state.invalid = true;
    terminate();
  }, input.timeoutMs);
  timer.unref();

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const reader = stdout.getReader();
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      if (result.value.byteLength === 0) continue;
      byteLength += result.value.byteLength;
      if (byteLength > input.maxOutputBytes) {
        state.invalid = true;
        terminate();
        break;
      }
      chunks.push(result.value);
    }
    const exitCode = await child.exited;
    input.signal?.throwIfAborted();
    if (state.invalid || state.canceled) return null;
    const output = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { exitCode, output };
  } catch {
    state.invalid = true;
    terminate();
    input.signal?.throwIfAborted();
    return null;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
    if (state.invalid || state.canceled) {
      terminate();
      await child.exited.catch(() => undefined);
    }
  }
}

/** Reads `claude --version` inside the isolated home, bounded and non-interactive. */
export const spawnClaudeVersionProbe: ClaudeVersionProbe = async (input) => {
  const result = await runBoundedClaudeProbe({
    argv: [input.executablePath, "--version"],
    configDir: input.configDir,
    environment: input.environment,
    maxOutputBytes: CLAUDE_VERSION_OUTPUT_BYTES,
    timeoutMs: loweredPositiveBound(input.timeoutMs, CLAUDE_PROBE_TIMEOUT_MS),
  });
  if (result === null || result.exitCode !== 0) {
    throw new ClaudeError("RUNTIME_MISMATCH", "the Claude Code executable did not report a version");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(result.output);
  } catch {
    throw new ClaudeError("RUNTIME_MISMATCH", "the Claude Code executable did not report a version");
  }
};

/**
 * Admits only the exact unauthenticated matrix observed from pinned Claude
 * 2.1.260 in a fresh isolated configuration. No authenticated shape has been
 * reviewed, so exit 0 always remains unverified. The parsed object and its
 * path-bearing field are dropped before returning.
 */
export const spawnClaudeAuthStatusProbe: ClaudeAuthStatusProbe = async (input) => {
  const result = await runBoundedClaudeProbe({
    argv: [input.executablePath, "auth", "status", "--json"],
    configDir: input.configDir,
    environment: input.environment ?? process.env,
    maxOutputBytes: loweredPositiveBound(
      input.maxOutputBytes,
      CLAUDE_AUTH_STATUS_OUTPUT_BYTES,
    ),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    timeoutMs: loweredPositiveBound(input.timeoutMs, CLAUDE_PROBE_TIMEOUT_MS),
  });
  if (result === null || result.exitCode !== 1) return "unverified";

  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(result.output);
    const parsed: unknown = JSON.parse(decoded);
    return claudeSignedOutAuthStatusSchema.safeParse(parsed).success
      ? "signed_out"
      : "unverified";
  } catch {
    return "unverified";
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
  const reported = await probe({ configDir: options.configDir, environment, executablePath });
  const version = versionPattern.exec(reported)?.[1];
  if (version === undefined) {
    throw new ClaudeError("RUNTIME_MISMATCH", "the Claude Code executable reported no exact version");
  }
  assertPinnedClaudeVersion(version);

  const nativeFallback = CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY;
  return {
    argv: buildPinnedClaudeRuntimeArgv({ executablePath, nativeFallback }),
    effort: CLAUDE_PIN_EFFORT,
    executablePath,
    model: CLAUDE_PIN_MODEL,
    nativeFallback,
    version: CLAUDE_PIN,
  };
}
