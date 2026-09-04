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

export type ClaudeVersionProbe = (input: {
  readonly executablePath: string;
  readonly configDir: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}) => Promise<string>;

export interface ResolvePinnedClaudeRuntimeOptions {
  /** Absolute path to the `claude` executable. Located on PATH when omitted. */
  readonly executablePath?: string;
  /** Absolute, isolated `CLAUDE_CONFIG_DIR` for this profile. */
  readonly configDir: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly probeVersion?: ClaudeVersionProbe;
}

const versionPattern = /\b(\d{1,5}\.\d{1,5}\.\d{1,5})\b/u;

/** Reads `claude --version` inside the isolated home, bounded and non-interactive. */
export const spawnClaudeVersionProbe: ClaudeVersionProbe = async (input) => {
  const env = allowlistedEnvironment(input.environment);
  env.CLAUDE_CONFIG_DIR = input.configDir;
  env.NO_COLOR = "1";
  const child = Bun.spawn([input.executablePath, "--version"], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(child.stdout).text();
  const code = await child.exited;
  if (code !== 0) {
    throw new ClaudeError("RUNTIME_MISMATCH", "the Claude Code executable did not report a version");
  }
  return text.slice(0, 256);
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
