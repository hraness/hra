#!/usr/bin/env bun

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { decideDiskHeadroom, readDiskHeadroom } from "./check-disk-headroom";
import { runRepositoryAdoption } from "./repo-adoption";
import { command } from "./shared";

type AuditOptions = {
  readonly fetch: boolean;
  readonly json: boolean;
  readonly roots: readonly string[];
  readonly sizes: boolean;
};

type RepositoryAudit = {
  readonly eligibleGiB: number | null;
  readonly eligibleWorktrees: number;
  readonly error?: string;
  readonly guidanceStatus: "current" | "error" | "needs-update";
  readonly path: string;
  readonly registeredWorktrees: number;
  readonly target?: string;
};

type SerializableWorkspaceAudit = {
  readonly disk: {
    readonly availableBytes: string;
    readonly kind: "fail" | "pass";
    readonly requiredBytes: string;
  };
  readonly repositories: readonly RepositoryAudit[];
};

export function parseWorkspaceAuditArguments(arguments_: readonly string[]): AuditOptions {
  let fetch = false;
  let json = false;
  let sizes = false;
  const roots: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--fetch") fetch = true;
    else if (argument === "--json") json = true;
    else if (argument === "--sizes") sizes = true;
    else if (argument === "--root") {
      const value = arguments_[index + 1];
      if (value === undefined || !value.startsWith("/")) {
        throw new Error("--root requires an absolute path");
      }
      roots.push(resolve(value));
      index += 1;
    } else throw new Error(`unknown workspace-audit argument: ${argument}`);
  }
  return {
    fetch,
    json,
    roots: roots.length === 0 ? [join(homedir(), "Documents")] : [...new Set(roots)],
    sizes,
  };
}

function repositoriesUnder(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .filter((path) => command(["git", "-C", path, "rev-parse", "--show-toplevel"]).exitCode === 0)
    .filter((path) => {
      const remote = command(["git", "-C", path, "config", "--get", "remote.origin.url"]);
      return remote.exitCode === 0 && /(?:github\.com[:/])hraness\//u.test(remote.stdout);
    });
}

function auditRepository(path: string, fetch: boolean, sizes: boolean): RepositoryAudit {
  let guidanceStatus: RepositoryAudit["guidanceStatus"] = "error";
  let guidanceError: string | undefined;
  try {
    const status = runRepositoryAdoption({ json: false, mode: "check", root: path }).status;
    guidanceStatus = status === "current" ? "current" : "needs-update";
  } catch (error: unknown) {
    guidanceError = error instanceof Error ? error.message : String(error);
  }
  const script = join(import.meta.dir, "worktree-cleanup.ts");
  const result = command([
    process.execPath,
    script,
    "--json",
    ...(fetch ? [] : ["--no-fetch"]),
    ...(sizes ? [] : ["--no-size"]),
  ], path);
  if (result.exitCode !== 0) {
    return {
      eligibleGiB: null,
      eligibleWorktrees: 0,
      error: [
        guidanceError === undefined ? undefined : `guidance audit failed: ${guidanceError}`,
        "worktree audit failed; use the worktree-cleanup.ts flow documented by $hra-local-efficiency for local diagnostics",
      ].filter((value) => value !== undefined).join("; "),
      guidanceStatus,
      path,
      registeredWorktrees: 0,
    };
  }
  const parsed = JSON.parse(result.stdout) as {
    readonly target: string;
    readonly worktrees: readonly {
      readonly decision: { readonly eligible: boolean };
      readonly sizeKiB: number | null;
    }[];
  };
  const eligible = parsed.worktrees.filter((worktree) => worktree.decision.eligible);
  const eligibleKiB = eligible.reduce((sum, worktree) => sum + (worktree.sizeKiB ?? 0), 0);
  return {
    eligibleGiB: eligible.some((worktree) => worktree.sizeKiB === null)
      ? null
      : eligibleKiB / 1_048_576,
    eligibleWorktrees: eligible.length,
    ...(guidanceError === undefined ? {} : { error: `guidance audit failed: ${guidanceError}` }),
    guidanceStatus,
    path,
    registeredWorktrees: parsed.worktrees.length,
    target: parsed.target,
  };
}

export function auditWorkspace(options: AuditOptions): {
  readonly disk: ReturnType<typeof decideDiskHeadroom>;
  readonly repositories: readonly RepositoryAudit[];
} {
  const repositories = [...new Set(options.roots.flatMap(repositoriesUnder))].sort();
  return {
    disk: decideDiskHeadroom(readDiskHeadroom(options.roots[0] ?? process.cwd())),
    repositories: repositories.map((path) => auditRepository(path, options.fetch, options.sizes)),
  };
}

export function serializableWorkspaceAudit(
  result: ReturnType<typeof auditWorkspace>,
): SerializableWorkspaceAudit {
  return {
    disk: {
      availableBytes: result.disk.availableBytes.toString(),
      kind: result.disk.kind,
      requiredBytes: result.disk.requiredBytes.toString(),
    },
    repositories: result.repositories,
  };
}

if (import.meta.main) {
  try {
    const options = parseWorkspaceAuditArguments(process.argv.slice(2));
    const result = auditWorkspace(options);
    if (options.json) console.log(JSON.stringify(serializableWorkspaceAudit(result), null, 2));
    else {
      const totalRegistered = result.repositories.reduce(
        (sum, repository) => sum + repository.registeredWorktrees,
        0,
      );
      const totalEligible = result.repositories.reduce(
        (sum, repository) => sum + repository.eligibleWorktrees,
        0,
      );
      const totalGiB = result.repositories.reduce(
        (sum, repository) => sum + (repository.eligibleGiB ?? 0),
        0,
      );
      const totalGiBKnown = !result.repositories.some(
        (repository) => repository.eligibleWorktrees > 0 && repository.eligibleGiB === null,
      );
      console.log(`DISK\t${result.disk.kind}\tavailable=${Number(result.disk.availableBytes / 1_073_741_824n)}GiB\trequired=${Number(result.disk.requiredBytes / 1_073_741_824n)}GiB`);
      for (const repository of result.repositories) {
        console.log([
          repository.error === undefined ? "REPO" : "ERROR",
          repository.path,
          `worktrees=${repository.registeredWorktrees}`,
          `eligible=${repository.eligibleWorktrees}`,
          `eligibleGiB=${repository.eligibleGiB === null ? "unknown" : repository.eligibleGiB.toFixed(1)}`,
          `guidance=${repository.guidanceStatus}`,
          repository.error ?? repository.target ?? "",
        ].join("\t"));
      }
      console.log(`TOTAL\trepositories=${result.repositories.length}\tworktrees=${totalRegistered}\teligible=${totalEligible}\teligibleGiB=${totalGiBKnown ? totalGiB.toFixed(1) : "unknown"}`);
    }
  } catch (error) {
    console.error(`[hra-workspace-audit] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
