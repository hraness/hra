#!/usr/bin/env bun

import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import {
  canonicalIfPresent,
  command,
  readText,
  replaceManagedBlock,
  writeAtomic,
} from "./shared";

export type RepositoryAdoptionMode = "apply" | "check";

export type RepositoryAdoptionOptions = {
  readonly json: boolean;
  readonly mode: RepositoryAdoptionMode;
  readonly root: string;
};

export type RepositoryAdoptionReport = {
  readonly agentsPath: string;
  readonly changed: boolean;
  readonly mode: RepositoryAdoptionMode;
  readonly root: string;
  readonly status: "current" | "needs-update" | "updated";
  readonly version: 1;
};

const startMarker = "<!-- hra-local-efficiency:start -->";
const endMarker = "<!-- hra-local-efficiency:end -->";

export function parseRepositoryAdoptionArguments(
  arguments_: readonly string[],
  cwd = process.cwd(),
): RepositoryAdoptionOptions {
  let json = false;
  let mode: RepositoryAdoptionMode | undefined;
  let root = resolve(cwd);
  let rootSupplied = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--apply" || argument === "--check") {
      if (mode !== undefined) throw new Error("choose exactly one of --apply or --check");
      mode = argument.slice(2) as RepositoryAdoptionMode;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--root") {
      if (rootSupplied) throw new Error("--root may be supplied only once");
      const value = arguments_[index + 1];
      if (value === undefined || !isAbsolute(value)) {
        throw new Error("--root requires an absolute path");
      }
      root = resolve(value);
      rootSupplied = true;
      index += 1;
      continue;
    }
    throw new Error(`unknown repo-adoption argument: ${argument}`);
  }

  if (mode === undefined) throw new Error("choose --apply or --check");
  return { json, mode, root };
}

function occurrences(value: string, search: string): number {
  return value.split(search).length - 1;
}

function repositoryPolicy(): string {
  const policy = readFileSync(join(import.meta.dir, "..", "assets", "repository-policy.md"), "utf8");
  if (occurrences(policy, startMarker) !== 1 || occurrences(policy, endMarker) !== 1) {
    throw new Error("repository policy must contain exactly one managed block");
  }
  if (policy.indexOf(startMarker) > policy.indexOf(endMarker)) {
    throw new Error("repository policy managed block markers are reversed");
  }
  return policy;
}

function expectedAgents(current: string | null): string {
  if (current !== null) {
    const starts = occurrences(current, startMarker);
    const ends = occurrences(current, endMarker);
    if (starts > 1 || ends > 1) {
      throw new Error("root AGENTS.md contains duplicate hra-local-efficiency markers");
    }
  }
  return replaceManagedBlock(current, repositoryPolicy(), startMarker, endMarker);
}

export function runRepositoryAdoption(
  options: RepositoryAdoptionOptions,
): RepositoryAdoptionReport {
  const rootMetadata = lstatSync(options.root);
  if (!rootMetadata.isDirectory()) {
    throw new Error(`repository root is not a directory: ${options.root}`);
  }
  const gitRoot = command(["git", "-C", options.root, "rev-parse", "--show-toplevel"]);
  if (gitRoot.exitCode !== 0 || gitRoot.stdout === "") {
    throw new Error(`repository root is not a Git worktree: ${options.root}`);
  }
  if (canonicalIfPresent(gitRoot.stdout) !== canonicalIfPresent(options.root)) {
    throw new Error(
      `repository root must be the exact Git top-level: ${gitRoot.stdout}`,
    );
  }

  const agentsPath = join(options.root, "AGENTS.md");
  let agentsMetadata: ReturnType<typeof lstatSync> | null = null;
  try {
    agentsMetadata = lstatSync(agentsPath);
  } catch (error: unknown) {
    if (
      typeof error !== "object"
      || error === null
      || !("code" in error)
      || error.code !== "ENOENT"
    ) throw error;
  }
  if (agentsMetadata !== null && !agentsMetadata.isFile()) {
    throw new Error(`refusing to replace non-file root guidance: ${agentsPath}`);
  }

  const current = readText(agentsPath);
  let mode = 0o644;
  if (agentsMetadata !== null) mode = agentsMetadata.mode & 0o777;
  const expected = expectedAgents(current);
  const needsUpdate = current !== expected;

  if (options.mode === "apply" && needsUpdate) {
    writeAtomic(agentsPath, expected, mode);
    if (readText(agentsPath) !== expected) {
      throw new Error(`root guidance did not converge: ${agentsPath}`);
    }
  }

  return {
    agentsPath,
    changed: options.mode === "apply" && needsUpdate,
    mode: options.mode,
    root: options.root,
    status: needsUpdate
      ? options.mode === "apply" ? "updated" : "needs-update"
      : "current",
    version: 1,
  };
}

if (import.meta.main) {
  try {
    const options = parseRepositoryAdoptionArguments(process.argv.slice(2));
    const report = runRepositoryAdoption(options);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else console.log(`${report.status.toUpperCase().replace("-", "_")}\t${report.agentsPath}`);
    if (report.status === "needs-update") process.exitCode = 1;
  } catch (error: unknown) {
    console.error(`[hra-repo-adoption] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
