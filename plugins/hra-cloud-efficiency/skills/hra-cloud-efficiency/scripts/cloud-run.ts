#!/usr/bin/env bun

import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { command, requireGitHubSlug, requireSafeIdentifier } from "./shared";
import {
  cloudProfiles,
  dispatchPacketHeader,
  localRequirements,
} from "./routing";
import type { CloudRouteReport, LocalRequirement } from "./routing";

export type CloudExecOptions = {
  readonly attempts: number;
  readonly environment: string;
  readonly promptFile: string;
  readonly routeFile: string;
};

export type CloudLaunchRoute = CloudRouteReport;

export type CloudExecDependencies = {
  readonly codexCli?: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly scratchParent?: string;
};

const maximumPromptBytes = 64 * 1024;
const cloudEnvironmentAllowlist = Object.freeze([
  "CODEX_HOME",
  "COLORTERM",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TERM",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
] as const);

export function cloudChildEnvironment(
  source: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of cloudEnvironmentAllowlist) {
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function currentUserId(): number {
  if (typeof process.getuid !== "function") {
    throw new Error("private Cloud handoff files require a POSIX user identity");
  }
  return process.getuid();
}

function validBranch(value: string): string {
  if (value.length < 1 || value.length > 240 || value.includes("\0")) {
    throw new Error("--branch must be one bounded Git branch name");
  }
  if (command(["git", "check-ref-format", "--branch", value]).exitCode !== 0) {
    throw new Error("--branch must be one valid Git branch name");
  }
  return value;
}

export function parseCloudExecArguments(arguments_: readonly string[]): CloudExecOptions {
  let attempts = 1;
  let attemptsSupplied = false;
  let environment: string | null = null;
  let promptFile: string | null = null;
  let routeFile: string | null = null;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (
      argument === "--attempts"
      || argument === "--environment"
      || argument === "--prompt-file"
      || argument === "--route-file"
    ) {
      const value = arguments_[index + 1];
      if (value === undefined || value === "") throw new Error(`${argument} requires a value`);
      if (argument === "--attempts") {
        if (attemptsSupplied) throw new Error("--attempts may be supplied only once");
        attempts = Number(value);
        if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 4) {
          throw new Error("--attempts must be an integer from 1 through 4");
        }
        attemptsSupplied = true;
      } else if (argument === "--environment") {
        if (environment !== null) throw new Error("--environment may be supplied only once");
        environment = requireSafeIdentifier(value, argument);
      } else if (argument === "--route-file") {
        if (routeFile !== null || !isAbsolute(value)) {
          throw new Error("--route-file requires one absolute path");
        }
        routeFile = resolve(value);
      } else {
        if (promptFile !== null || !isAbsolute(value)) {
          throw new Error("--prompt-file requires one absolute path");
        }
        promptFile = resolve(value);
      }
      index += 1;
      continue;
    }
    throw new Error(`unknown Cloud exec argument: ${argument}`);
  }

  if (environment === null) throw new Error("--environment is required");
  if (routeFile === null) throw new Error("--route-file is required");
  if (promptFile === null) throw new Error("--prompt-file is required");
  return { attempts, environment, promptFile, routeFile };
}

function validatePrompt(value: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 1 || bytes > maximumPromptBytes) {
    throw new Error(`Cloud prompt must be 1 through ${maximumPromptBytes} UTF-8 bytes`);
  }
  if (value.includes("\0")) throw new Error("Cloud prompt must not contain NUL bytes");
  return value;
}

function exactSourcePrompt(route: CloudLaunchRoute, taskPrompt: string): string {
  const guard = [
    "Mandatory exact-source preflight:",
    "Before reading the task scope or editing any file, verify all four conditions below.",
    `1. The origin GitHub repository is exactly ${route.repository}.`,
    `2. git symbolic-ref --quiet --short HEAD is exactly ${route.branch}.`,
    `3. git rev-parse HEAD is exactly ${route.sha}.`,
    "4. git status --porcelain=v1 --untracked-files=all is empty.",
    "If any condition differs or cannot be proved, make no edits, run no task command, and report only the mismatch.",
    "After the preflight succeeds, obey these routing controls:",
    dispatchPacketHeader(route),
    "Task objective:",
    "",
  ].join("\n");
  return validatePrompt(`${guard}${taskPrompt}`);
}

export function readPromptFile(path: string): string {
  const before = lstatSync(path);
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || before.uid !== currentUserId()
    || (before.mode & 0o077) !== 0
    || before.size < 1
    || before.size > maximumPromptBytes
  ) throw new Error("prompt file must be one private bounded single-link regular file");
  const value = readFileSync(path, "utf8");
  const after = lstatSync(path);
  if (
    !after.isFile()
    || after.isSymbolicLink()
    || after.nlink !== 1
    || after.dev !== before.dev
    || after.ino !== before.ino
    || after.size !== before.size
    || after.mtimeMs !== before.mtimeMs
    || Buffer.byteLength(value, "utf8") !== after.size
  ) throw new Error("prompt file changed while it was read");
  return validatePrompt(value);
}

export function readRouteFile(path: string): CloudLaunchRoute {
  const before = lstatSync(path);
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || before.uid !== currentUserId()
    || (before.mode & 0o077) !== 0
    || before.size < 1
    || before.size > 16 * 1024
  ) throw new Error("route file must be one private bounded single-link regular file");
  const source = readFileSync(path, "utf8");
  const after = lstatSync(path);
  if (
    !after.isFile()
    || after.isSymbolicLink()
    || after.nlink !== 1
    || after.dev !== before.dev
    || after.ino !== before.ino
    || after.size !== before.size
    || after.mtimeMs !== before.mtimeMs
    || Buffer.byteLength(source, "utf8") !== after.size
  ) throw new Error("route file changed while it was read");

  let decoded: unknown;
  try {
    decoded = JSON.parse(source) as unknown;
  } catch {
    throw new Error("route file is not valid JSON");
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new Error("route file is not one route report");
  }
  const report = decoded as Record<string, unknown>;
  if (
    report.version !== 1
    || report.dispatchReady !== true
    || report.environmentConfigured !== true
    || report.onlineVerified !== true
    || report.modelPolicy !== "cloud-default-ok"
    || (report.decision !== "cloud" && report.decision !== "hybrid")
    || !Array.isArray(report.needs)
    || report.needs.length !== 0
  ) throw new Error("route report is not dispatch-ready");
  if (typeof report.branch !== "string") throw new Error("route report branch is invalid");
  const branch = validBranch(report.branch);
  if (typeof report.repository !== "string") throw new Error("route report repository is invalid");
  const repository = requireGitHubSlug(report.repository, "route report repository");
  if (typeof report.sha !== "string" || !/^[0-9a-f]{40}$/u.test(report.sha)) {
    throw new Error("route report commit is invalid");
  }
  if (report.intent !== "edit" && report.intent !== "read-only") {
    throw new Error("route report intent is invalid");
  }
  if (typeof report.owner !== "string") throw new Error("route report owner is invalid");
  const owner = requireSafeIdentifier(report.owner, "route report owner", 64);
  if (typeof report.profile !== "string" || !cloudProfiles.includes(report.profile as never)) {
    throw new Error("route report profile is invalid");
  }
  if (
    !Array.isArray(report.finalNeeds)
    || report.finalNeeds.some((value) => (
      typeof value !== "string" || !localRequirements.includes(value as never)
    ))
  ) throw new Error("route report final requirements are invalid");
  const finalNeeds = [...new Set(report.finalNeeds as LocalRequirement[])].sort();
  if (JSON.stringify(finalNeeds) !== JSON.stringify(report.finalNeeds)) {
    throw new Error("route report final requirements are not canonical");
  }
  if (
    (report.decision === "cloud" && finalNeeds.length !== 0)
    || (report.decision === "hybrid" && finalNeeds.length === 0)
  ) throw new Error("route report decision and final requirements differ");
  return {
    branch,
    decision: report.decision,
    dispatchReady: true,
    environmentConfigured: true,
    finalNeeds,
    intent: report.intent,
    modelPolicy: "cloud-default-ok",
    needs: [],
    next: [],
    onlineVerified: true,
    owner,
    profile: report.profile as CloudRouteReport["profile"],
    repository,
    sha: report.sha,
    version: 1,
  };
}

function resolveCodexCli(supplied?: string): string {
  const candidate = supplied ?? Bun.which("codex");
  if (candidate === null || !isAbsolute(candidate)) {
    throw new Error("the Codex CLI is unavailable on PATH");
  }
  const canonical = realpathSync(candidate);
  const metadata = lstatSync(canonical);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("the Codex CLI does not resolve to one regular file");
  }
  return canonical;
}

function resolveScratchParent(supplied?: string): string {
  const candidate = resolve(supplied ?? tmpdir());
  if (!isAbsolute(candidate)) throw new Error("scratch parent must be absolute");
  const metadata = lstatSync(candidate);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("scratch parent must be one real directory");
  }
  return realpathSync(candidate);
}

export async function runCloudExec(
  options: CloudExecOptions,
  dependencies: CloudExecDependencies = {},
): Promise<number> {
  const route = readRouteFile(options.routeFile);
  const taskPrompt = readPromptFile(options.promptFile);
  const prompt = exactSourcePrompt(route, taskPrompt);
  const codexCli = resolveCodexCli(dependencies.codexCli);
  const scratchParent = resolveScratchParent(dependencies.scratchParent);
  const previousUmask = process.umask(0o077);
  let scratch: string | null = null;
  try {
    scratch = mkdtempSync(join(scratchParent, "hra-cloud-exec-"));
    chmodSync(scratch, 0o700);
    const child = Bun.spawn([
      codexCli,
      "cloud",
      "exec",
      "--env",
      options.environment,
      "--attempts",
      String(options.attempts),
      "--branch",
      route.branch,
    ], {
      cwd: scratch,
      env: dependencies.environment ?? cloudChildEnvironment(),
      stderr: "inherit",
      stdin: "pipe",
      stdout: "inherit",
    });
    process.umask(previousUmask);

    const signals = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"] as const;
    const handlers = new Map<NodeJS.Signals, () => void>();
    for (const signal of signals) {
      const handler = (): void => {
        try {
          child.kill(signal);
        } catch { /* The child may already be terminal. */ }
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    try {
      await child.stdin.write(prompt);
      await child.stdin.end();
      return await child.exited;
    } finally {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    }
  } finally {
    process.umask(previousUmask);
    if (scratch !== null) rmSync(scratch, { force: false, recursive: true });
  }
}

if (import.meta.main) {
  try {
    const options = parseCloudExecArguments(process.argv.slice(2));
    process.exitCode = await runCloudExec(options);
  } catch (error: unknown) {
    console.error(`[hra-cloud-exec] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
