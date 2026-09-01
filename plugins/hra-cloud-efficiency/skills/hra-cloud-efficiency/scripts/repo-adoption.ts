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
  readonly changed: boolean;
  readonly mode: RepositoryAdoptionMode;
  readonly status: "current" | "needs-update" | "updated";
  readonly version: 1;
};

const startMarker = "<!-- hra-cloud-efficiency:start -->";
const endMarker = "<!-- hra-cloud-efficiency:end -->";

export function parseRepositoryAdoptionArguments(
  arguments_: readonly string[],
  cwd = process.cwd(),
): RepositoryAdoptionOptions {
  let json = false;
  let mode: RepositoryAdoptionMode | null = null;
  let root = resolve(cwd);
  let rootSupplied = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--apply" || argument === "--check") {
      if (mode !== null) throw new Error("choose exactly one of --apply or --check");
      mode = argument.slice(2) as RepositoryAdoptionMode;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--root") {
      const value = arguments_[index + 1];
      if (rootSupplied || value === undefined || !isAbsolute(value)) {
        throw new Error("--root requires one absolute path");
      }
      root = resolve(value);
      rootSupplied = true;
      index += 1;
      continue;
    }
    throw new Error(`unknown repository-adoption argument: ${argument}`);
  }
  if (mode === null) throw new Error("choose --apply or --check");
  return { json, mode, root };
}

function repositoryPolicy(): string {
  const value = readFileSync(join(import.meta.dir, "..", "assets", "repository-policy.md"), "utf8");
  if (value.split(startMarker).length !== 2 || value.split(endMarker).length !== 2) {
    throw new Error("repository policy must contain exactly one managed block");
  }
  return value;
}

export function runRepositoryAdoption(
  options: RepositoryAdoptionOptions,
): RepositoryAdoptionReport {
  const rootMetadata = lstatSync(options.root);
  if (!rootMetadata.isDirectory()) throw new Error("repository root is not a directory");
  const gitRoot = command(["git", "rev-parse", "--show-toplevel"], options.root);
  if (gitRoot.exitCode !== 0 || gitRoot.stdout === "") {
    throw new Error("repository root is not a Git worktree");
  }
  if (canonicalIfPresent(gitRoot.stdout) !== canonicalIfPresent(options.root)) {
    throw new Error("repository root must be the exact Git top-level");
  }

  const agentsPath = join(options.root, "AGENTS.md");
  let mode = 0o644;
  try {
    const metadata = lstatSync(agentsPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error("refusing to replace non-regular root guidance");
    }
    mode = metadata.mode & 0o777;
  } catch (error: unknown) {
    if (
      typeof error !== "object"
      || error === null
      || !("code" in error)
      || error.code !== "ENOENT"
    ) throw error;
  }

  const current = readText(agentsPath);
  const expected = replaceManagedBlock(
    current,
    repositoryPolicy(),
    startMarker,
    endMarker,
  );
  const needsUpdate = current !== expected;
  if (options.mode === "apply" && needsUpdate) {
    writeAtomic(agentsPath, expected, mode);
    if (readText(agentsPath) !== expected) throw new Error("root guidance did not converge");
  }
  return {
    changed: options.mode === "apply" && needsUpdate,
    mode: options.mode,
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
    else console.log(`${report.status.toUpperCase().replace("-", "_")}\tcloud-routing-policy`);
    if (report.status === "needs-update") process.exitCode = 1;
  } catch (error: unknown) {
    console.error(`[hra-cloud-adoption] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
