#!/usr/bin/env bun

import { lstatSync, readFileSync } from "node:fs";
import type { Stats } from "node:fs";
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
  readonly claudePath: string;
  readonly changed: boolean;
  readonly mode: RepositoryAdoptionMode;
  readonly root: string;
  readonly status: "current" | "needs-update" | "updated";
  readonly version: 2;
};

const startMarker = "<!-- hra-local-efficiency:start -->";
const endMarker = "<!-- hra-local-efficiency:end -->";
const claudeStartMarker = "<!-- hra-local-efficiency:claude-import:start -->";
const claudeEndMarker = "<!-- hra-local-efficiency:claude-import:end -->";
const claudeImport = "@AGENTS.md";

function withoutInlineCode(line: string): string {
  let output = "";
  let delimiterLength = 0;
  for (let index = 0; index < line.length;) {
    if (line[index] !== "`") {
      output += delimiterLength === 0 ? line.charAt(index) : " ";
      index += 1;
      continue;
    }
    let runLength = 1;
    while (line[index + runLength] === "`") runLength += 1;
    if (delimiterLength === 0) delimiterLength = runLength;
    else if (runLength === delimiterLength) delimiterLength = 0;
    output += " ".repeat(runLength);
    index += runLength;
  }
  return output;
}

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

function hasActiveClaudeImport(value: string): boolean {
  let fence: { readonly character: string; readonly length: number } | null = null;
  for (const rawLine of value.split("\n")) {
    const line = rawLine.replace(/\r$/u, "");
    if (fence === null) {
      const opening = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
      if (opening !== null) {
        const marker = opening[1] as string;
        fence = { character: marker[0] as string, length: marker.length };
        continue;
      }
    } else {
      const closing = /^ {0,3}(`{3,}|~{3,})[\t ]*$/u.exec(line);
      if (closing !== null) {
        const marker = closing[1] as string;
        if (marker[0] === fence.character && marker.length >= fence.length) {
          fence = null;
        }
      }
      continue;
    }
    if (
      /(?:^|[^A-Za-z0-9_./-])@AGENTS\.md(?:$|[^A-Za-z0-9_./-])/u
        .test(withoutInlineCode(line))
    ) return true;
  }
  return false;
}

function expectedClaude(current: string | null): string {
  if (current === null) return `${claudeImport}\n`;
  const starts = occurrences(current, claudeStartMarker);
  const ends = occurrences(current, claudeEndMarker);
  if (starts > 1 || ends > 1) {
    throw new Error("root CLAUDE.md contains duplicate hra-local-efficiency import markers");
  }
  if (starts === 0 && ends === 0 && hasActiveClaudeImport(current)) return current;
  const block = `${claudeStartMarker}\n${claudeImport}\n${claudeEndMarker}\n`;
  return replaceManagedBlock(current, block, claudeStartMarker, claudeEndMarker);
}

function guidanceMetadata(path: string, description: string): Stats | null {
  let metadata: Stats | null = null;
  try {
    metadata = lstatSync(path);
  } catch (error: unknown) {
    if (
      typeof error !== "object"
      || error === null
      || !("code" in error)
      || error.code !== "ENOENT"
    ) throw error;
  }
  if (metadata !== null && !metadata.isFile()) {
    throw new Error(`refusing to replace non-file ${description}: ${path}`);
  }
  if (metadata !== null && metadata.nlink !== 1) {
    throw new Error(`refusing to replace hard-linked ${description}: ${path}`);
  }
  return metadata;
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
  const claudePath = join(options.root, "CLAUDE.md");
  const agentsMetadata = guidanceMetadata(agentsPath, "root guidance");
  const claudeMetadata = guidanceMetadata(claudePath, "root Claude guidance");
  const currentAgents = readText(agentsPath);
  const currentClaude = readText(claudePath);
  const agentsMode = agentsMetadata === null ? 0o644 : agentsMetadata.mode & 0o777;
  const claudeMode = claudeMetadata === null ? 0o644 : claudeMetadata.mode & 0o777;
  const expectedAgentsValue = expectedAgents(currentAgents);
  const expectedClaudeValue = expectedClaude(currentClaude);
  const agentsNeedUpdate = currentAgents !== expectedAgentsValue;
  const claudeNeedsUpdate = currentClaude !== expectedClaudeValue;
  const needsUpdate = agentsNeedUpdate || claudeNeedsUpdate;

  if (options.mode === "apply" && needsUpdate) {
    if (agentsNeedUpdate) writeAtomic(agentsPath, expectedAgentsValue, agentsMode);
    if (claudeNeedsUpdate) writeAtomic(claudePath, expectedClaudeValue, claudeMode);
    if (readText(agentsPath) !== expectedAgentsValue) {
      throw new Error(`root guidance did not converge: ${agentsPath}`);
    }
    if (readText(claudePath) !== expectedClaudeValue) {
      throw new Error(`root Claude guidance did not converge: ${claudePath}`);
    }
  }

  return {
    agentsPath,
    claudePath,
    changed: options.mode === "apply" && needsUpdate,
    mode: options.mode,
    root: options.root,
    status: needsUpdate
      ? options.mode === "apply" ? "updated" : "needs-update"
      : "current",
    version: 2,
  };
}

if (import.meta.main) {
  try {
    const options = parseRepositoryAdoptionArguments(process.argv.slice(2));
    const report = runRepositoryAdoption(options);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(
        `${report.status.toUpperCase().replace("-", "_")}\t${report.agentsPath}\t${report.claudePath}`,
      );
    }
    if (report.status === "needs-update") process.exitCode = 1;
  } catch (error: unknown) {
    console.error(`[hra-repo-adoption] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
