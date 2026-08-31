#!/usr/bin/env bun

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { runHostCommand, type ResourceMode } from "./host-run";
import {
  canonicalIfPresent,
  command,
  commandProgramLabel,
  containsControlCharacters,
  gitIndexVisibility,
  requireCommand,
  requireOperationLabel,
  sha256,
  writeAtomic,
} from "./shared";

type ValidationOptions = {
  readonly command: readonly string[];
  readonly contexts: readonly string[];
  readonly force: boolean;
  readonly json: boolean;
  readonly label: string;
  readonly mode: ResourceMode;
  readonly reuse: boolean;
  readonly ttlMinutes: number;
};

export type Fingerprint = {
  readonly commonDirectory: string;
  readonly digest: string;
  readonly head: string;
  readonly relativeCwd: string;
  readonly root: string;
  readonly toolchain: Readonly<Record<string, string>>;
};

type Receipt = {
  readonly commandDigest: string;
  readonly contextNames: readonly string[];
  readonly cwd: string;
  readonly durationMs: number;
  readonly expiresAt: string;
  readonly fingerprint: string;
  readonly finishedAt: string;
  readonly head: string;
  readonly label: string;
  readonly mode: ResourceMode;
  readonly program: string;
  readonly result: "pass";
  readonly startedAt: string;
  readonly toolchain: Readonly<Record<string, string>>;
  readonly version: 2;
};

export function parseValidationArguments(arguments_: readonly string[]): ValidationOptions {
  const delimiter = arguments_.indexOf("--");
  if (delimiter < 0) throw new Error("hra-validate requires -- before its command");
  let force = false;
  let json = false;
  let label: string | undefined;
  let mode: ResourceMode = "shared";
  let reuse = false;
  let ttlMinutes = 60;
  const contexts: string[] = [];
  const contextNamesSeen = new Set<string>();
  for (let index = 0; index < delimiter; index += 1) {
    const argument = arguments_[index];
    if (argument === "--force") force = true;
    else if (argument === "--json") json = true;
    else if (argument === "--reuse") reuse = true;
    else if (argument?.startsWith("--label=")) label = argument.slice("--label=".length);
    else if (argument?.startsWith("--mode=")) {
      const value = argument.slice("--mode=".length);
      if (value !== "shared" && value !== "heavy" && value !== "exclusive") {
        throw new Error(`invalid resource mode: ${value}`);
      }
      mode = value;
    } else if (argument?.startsWith("--ttl-minutes=")) {
      const value = Number(argument.slice("--ttl-minutes=".length));
      if (!Number.isFinite(value) || value <= 0 || value > 24 * 60) {
        throw new Error("--ttl-minutes must be greater than zero and at most 1440");
      }
      ttlMinutes = value;
    } else if (argument === "--context") {
      const value = arguments_[index + 1];
      if (value === undefined || !value.includes("=")) {
        throw new Error("--context requires a non-secret NAME=VALUE identity");
      }
      const separator = value.indexOf("=");
      const contextName = requireOperationLabel(value.slice(0, separator), "--context name");
      if (contextNamesSeen.has(contextName)) throw new Error("--context names must be unique");
      contextNamesSeen.add(contextName);
      const contextValue = value.slice(separator + 1);
      if (contextValue === "" || contextValue.length > 512 || containsControlCharacters(contextValue)) {
        throw new Error("--context value must be 1 through 512 characters with no control characters");
      }
      contexts.push(value);
      index += 1;
    } else {
      throw new Error(`unknown hra-validate argument: ${argument}`);
    }
  }
  const command = arguments_.slice(delimiter + 1);
  if (command.length === 0 || command[0] === undefined || command[0] === "") {
    throw new Error("hra-validate requires a command");
  }
  if (label !== undefined) requireOperationLabel(label, "--label");
  return {
    command,
    contexts: [...new Set(contexts)].sort(),
    force,
    json,
    label: label ?? commandProgramLabel(command[0]),
    mode,
    reuse,
    ttlMinutes,
  };
}

function version(program: string, arguments_: readonly string[] = ["--version"]): string {
  const result = command([program, ...arguments_]);
  const value = result.stdout.trim();
  return result.exitCode === 0
    && value.length <= 64
    && /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value)
    ? value
    : `unavailable-${sha256(value).slice(0, 12)}`;
}

type GitFileMode = "100644" | "100755" | "120000";

export function fingerprintUntrackedEntry(
  root: string,
  path: string,
): readonly [string, GitFileMode, string] {
  if (path === "" || isAbsolute(path) || path.includes("\0")) {
    throw new Error("validation received an unsafe untracked path");
  }
  const absolutePath = resolve(root, path);
  const relativePath = relative(root, absolutePath);
  if (
    relativePath === ""
    || relativePath === ".."
    || relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    || isAbsolute(relativePath)
  ) {
    throw new Error("validation received an unsafe untracked path");
  }

  const metadata = lstatSync(absolutePath);
  if (metadata.isSymbolicLink()) {
    return [path, "120000", sha256(readlinkSync(absolutePath, { encoding: "buffer" }))];
  }
  if (!metadata.isFile()) {
    throw new Error("validation refuses an untracked directory or special entry");
  }
  if (
    typeof constants.O_NOFOLLOW !== "number"
    || constants.O_NOFOLLOW === 0
    || typeof constants.O_NONBLOCK !== "number"
  ) {
    throw new Error("validation cannot safely hash untracked regular files on this platform");
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) {
      throw new Error("validation refuses an untracked directory or special entry");
    }
    const mode: GitFileMode = (opened.mode & 0o111) === 0 ? "100644" : "100755";
    return [path, mode, sha256(readFileSync(descriptor))];
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith("validation ")) throw error;
    throw new Error("validation could not safely read an untracked regular file");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function fingerprintOptionalRepositoryEntry(
  root: string,
  path: string,
): readonly [string, GitFileMode | null, string | null] {
  try {
    return fingerprintUntrackedEntry(root, path);
  } catch (error: unknown) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) return [path, null, null];
    throw error;
  }
}

export function validationFingerprint(
  cwd: string,
  commandArguments: readonly string[],
  contexts: readonly string[],
): Fingerprint {
  const canonicalCwd = canonicalIfPresent(cwd);
  const root = canonicalIfPresent(requireCommand(["git", "rev-parse", "--show-toplevel"], canonicalCwd));
  const relativeCwd = relative(root, canonicalCwd);
  if (relativeCwd === ".." || relativeCwd.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("validation cwd must be inside its Git repository");
  }
  const head = requireCommand(["git", "rev-parse", "HEAD"], root);
  const commonRaw = requireCommand(
    ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
    root,
  );
  const commonDirectory = canonicalIfPresent(
    isAbsolute(commonRaw) ? commonRaw : resolve(root, commonRaw),
  );
  const index = gitIndexVisibility(root);
  if (index.reason === "read-error") throw new Error("validation requires a readable Git index");
  if (index.reason === "hidden-index-flags") {
    throw new Error("validation refuses skip-worktree or assume-unchanged Git index entries");
  }
  if (index.reason === "populated-gitlink") {
    throw new Error("validation refuses a populated gitlink/submodule worktree entry");
  }
  if (!index.readable || !index.transparent) throw new Error("validation requires a transparent Git index");
  const diff = requireCommand(["git", "diff", "--binary", "HEAD", "--", "."], root);
  const untracked = requireCommand(
    ["git", "ls-files", "--others", "--exclude-standard", "-z"],
    root,
  ).split("\0").filter(Boolean).sort();
  const untrackedHashes = untracked.map((path) => fingerprintUntrackedEntry(root, path));
  const lockfiles = [
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
  ].map((name) => fingerprintOptionalRepositoryEntry(root, name));
  const toolchain = {
    bun: version("bun"),
    node: version("node"),
  };
  const digest = sha256(JSON.stringify({
    command: commandArguments,
    contexts,
    cwd: relativeCwd,
    diffHash: sha256(diff),
    head,
    lockfiles,
    toolchain,
    untrackedHashes,
    version: 2,
  }));
  return { commonDirectory, digest, head, relativeCwd, root, toolchain };
}

export function validationReceiptPath(fingerprint: Fingerprint): string {
  return join(
    fingerprint.commonDirectory,
    "hra-local-efficiency",
    "validation-receipts",
    `${fingerprint.digest}.json`,
  );
}

function reusableReceipt(
  path: string,
  digest: string,
  requestedTtlMinutes: number,
  now = Date.now(),
): Receipt | null {
  try {
    const metadata = lstatSync(path);
    if (
      !metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.nlink !== 1
      || metadata.size < 2
      || metadata.size > 16 * 1024
    ) return null;
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof value !== "object"
      || value === null
      || Array.isArray(value)
    ) return null;
    const record = value as Record<string, unknown>;
    const keys = [
      "commandDigest",
      "contextNames",
      "cwd",
      "durationMs",
      "expiresAt",
      "fingerprint",
      "finishedAt",
      "head",
      "label",
      "mode",
      "program",
      "result",
      "startedAt",
      "toolchain",
      "version",
    ];
    if (
      Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0")
      || record.version !== 2
      || record.result !== "pass"
      || record.fingerprint !== digest
      || typeof record.commandDigest !== "string"
      || !/^[0-9a-f]{64}$/u.test(record.commandDigest)
      || typeof record.head !== "string"
      || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(record.head)
      || typeof record.cwd !== "string"
      || record.cwd.length > 512
      || containsControlCharacters(record.cwd)
      || isAbsolute(record.cwd)
      || record.cwd.split(/[\\/]/u).includes("..")
      || !Number.isInteger(record.durationMs)
      || (record.durationMs as number) < 0
      || (record.durationMs as number) > 24 * 60 * 60_000
      || typeof record.expiresAt !== "string"
      || typeof record.finishedAt !== "string"
      || typeof record.startedAt !== "string"
      || typeof record.label !== "string"
      || typeof record.program !== "string"
      || (record.mode !== "shared" && record.mode !== "heavy" && record.mode !== "exclusive")
      || !Array.isArray(record.contextNames)
      || record.contextNames.length > 32
      || !record.contextNames.every((name) => {
        try {
          return typeof name === "string" && requireOperationLabel(name, "context name") === name;
        } catch {
          return false;
        }
      })
      || typeof record.toolchain !== "object"
      || record.toolchain === null
      || Array.isArray(record.toolchain)
    ) return null;
    try {
      requireOperationLabel(record.label, "receipt label");
      requireOperationLabel(record.program, "receipt program");
    } catch {
      return null;
    }
    const toolchain = record.toolchain as Record<string, unknown>;
    if (
      Object.keys(toolchain).sort().join("\0") !== "bun\0node"
      || typeof toolchain.bun !== "string"
      || typeof toolchain.node !== "string"
      || toolchain.bun.length > 80
      || toolchain.node.length > 80
      || containsControlCharacters(toolchain.bun)
      || containsControlCharacters(toolchain.node)
    ) return null;
    const expiresAt = Date.parse(record.expiresAt);
    const finishedAt = Date.parse(record.finishedAt);
    const startedAt = Date.parse(record.startedAt);
    if (
      !Number.isFinite(expiresAt)
      || !Number.isFinite(finishedAt)
      || !Number.isFinite(startedAt)
      || startedAt > finishedAt
      || finishedAt > now + 5 * 60_000
      || expiresAt <= now
      || expiresAt < finishedAt
      || expiresAt - finishedAt > 24 * 60 * 60_000
      || now - finishedAt >= requestedTtlMinutes * 60_000
    ) return null;
    const safeContextNames: string[] = [];
    for (const name of record.contextNames) {
      if (typeof name !== "string") return null;
      safeContextNames.push(name);
    }
    return {
      commandDigest: record.commandDigest,
      contextNames: safeContextNames,
      cwd: record.cwd,
      durationMs: record.durationMs as number,
      expiresAt: record.expiresAt,
      fingerprint: digest,
      finishedAt: record.finishedAt,
      head: record.head,
      label: record.label,
      mode: record.mode,
      program: record.program,
      result: "pass",
      startedAt: record.startedAt,
      toolchain: { bun: toolchain.bun, node: toolchain.node },
      version: 2,
    };
  } catch {
    return null;
  }
}

function contextNames(contexts: readonly string[]): string[] {
  return contexts.map((value) => value.slice(0, value.indexOf("=")));
}

function output(value: unknown, json: boolean): void {
  if (json) console.log(JSON.stringify(value, null, 2));
  else if (typeof value === "string") console.log(value);
  else console.log(JSON.stringify(value));
}

export async function runValidation(
  options: ValidationOptions,
  cwd = process.cwd(),
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<number> {
  const fingerprint = validationFingerprint(cwd, options.command, options.contexts);
  const commandDigest = sha256(JSON.stringify(options.command));
  const program = commandProgramLabel(options.command[0] ?? "command");
  const path = validationReceiptPath(fingerprint);
  const cached = options.reuse && !options.force
    ? reusableReceipt(path, fingerprint.digest, options.ttlMinutes)
    : null;
  if (cached !== null) {
    output({ kind: "reused", receipt: cached }, options.json);
    return 0;
  }
  const startedAt = new Date();
  const started = performance.now();
  const exitCode = await runHostCommand({
    command: options.command,
    cwd,
    environment,
    label: options.label,
    mode: options.mode,
  });
  const finishedAt = new Date();
  if (exitCode !== 0) {
    output({
      commandDigest,
      exitCode,
      fingerprint: fingerprint.digest,
      kind: "failed",
      label: options.label,
      program,
    }, options.json);
    return exitCode;
  }
  let postFingerprint: Fingerprint;
  try {
    postFingerprint = validationFingerprint(cwd, options.command, options.contexts);
  } catch {
    output({
      fingerprint: fingerprint.digest,
      kind: "executed-not-cacheable",
      reason: "post-command fingerprint unavailable",
    }, options.json);
    return 0;
  }
  if (postFingerprint.digest !== fingerprint.digest) {
    output({
      afterFingerprint: postFingerprint.digest,
      beforeFingerprint: fingerprint.digest,
      kind: "executed-not-cacheable",
      reason: "validation command changed repository inputs",
    }, options.json);
    return 0;
  }
  const receipt: Receipt = {
    commandDigest,
    contextNames: contextNames(options.contexts),
    cwd: fingerprint.relativeCwd,
    durationMs: Math.round(performance.now() - started),
    expiresAt: new Date(finishedAt.getTime() + options.ttlMinutes * 60_000).toISOString(),
    fingerprint: fingerprint.digest,
    finishedAt: finishedAt.toISOString(),
    head: fingerprint.head,
    label: options.label,
    mode: options.mode,
    program,
    result: "pass",
    startedAt: startedAt.toISOString(),
    toolchain: fingerprint.toolchain,
    version: 2,
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeAtomic(path, `${JSON.stringify(receipt, null, 2)}\n`, 0o600);
  output({ kind: "executed", receipt }, options.json);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await runValidation(parseValidationArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(`[hra-validate] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
