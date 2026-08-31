import { existsSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

import { gitIndexVisibility } from "./shared";

type CommandResult = {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
};

export type Worktree = {
  readonly path: string;
  readonly head: string;
  readonly branch: string | null;
};

export type SafetyEvidence = {
  readonly registered: boolean;
  readonly primary: boolean;
  readonly current: boolean;
  readonly exists: boolean;
  readonly clean: boolean;
  readonly merged: boolean;
  readonly statusReadable: boolean;
};

export type SafetyDecision = {
  readonly eligible: boolean;
  readonly reason:
    | "eligible"
    | "dirty"
    | "current"
    | "missing"
    | "primary"
    | "status-error"
    | "unmerged"
    | "unregistered";
};

export type Options = {
  readonly fetch: boolean;
  readonly json: boolean;
  readonly remove: readonly string[];
  readonly sizes: boolean;
  readonly target: string | null;
};

export type Target = {
  readonly branch: string;
  readonly ref: string;
  readonly remote: string;
};

function command(args: readonly string[], cwd = process.cwd()): CommandResult {
  const result = Bun.spawnSync({
    cmd: [...args],
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString().trim(),
    // Git terminates this output with LF. Remove only that byte: paths may
    // legally end in spaces or CR and must remain byte-for-byte comparable
    // with `git worktree list --porcelain`.
    stdout: result.stdout.toString().replace(/\n$/u, ""),
  };
}

function requireCommand(args: readonly string[], cwd = process.cwd()): string {
  const result = command(args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed${result.stderr === "" ? "" : `:\n${result.stderr}`}`);
  }
  return result.stdout;
}

export function parseWorktreePorcelain(output: string): Worktree[] {
  const records: Worktree[] = [];
  let path: string | undefined;
  let head: string | undefined;
  let branch: string | null = null;

  const flush = (): void => {
    if (path === undefined && head === undefined) return;
    if (path === undefined || head === undefined) {
      throw new Error("Malformed git worktree record");
    }
    records.push({ path, head, branch });
    path = undefined;
    head = undefined;
    branch = null;
  };

  for (const line of `${output}\n`.split("\n")) {
    if (line === "") {
      flush();
    } else if (line.startsWith("worktree ")) {
      path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      branch = null;
    }
  }
  return records;
}

export function classifySafety(evidence: SafetyEvidence): SafetyDecision {
  if (evidence.primary) return { eligible: false, reason: "primary" };
  if (evidence.current) return { eligible: false, reason: "current" };
  if (!evidence.registered) return { eligible: false, reason: "unregistered" };
  if (!evidence.exists) return { eligible: false, reason: "missing" };
  if (!evidence.statusReadable) return { eligible: false, reason: "status-error" };
  if (!evidence.clean) return { eligible: false, reason: "dirty" };
  if (!evidence.merged) return { eligible: false, reason: "unmerged" };
  return { eligible: true, reason: "eligible" };
}

export function parseArgs(argv: readonly string[]): Options {
  const remove: string[] = [];
  let fetch = true;
  let json = false;
  let sizes = true;
  let target: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    switch (argument) {
      case "--json":
        json = true;
        break;
      case "--no-fetch":
        fetch = false;
        break;
      case "--no-size":
        sizes = false;
        break;
      case "--target": {
        const ref = argv[index + 1];
        if (ref === undefined || ref.startsWith("-")) {
          throw new Error("--target requires a remote-tracking ref such as upstream/trunk");
        }
        target = ref;
        index += 1;
        break;
      }
      case "--remove": {
        const path = argv[index + 1];
        if (path === undefined) throw new Error("--remove requires an exact absolute path");
        if (!isAbsolute(path)) throw new Error(`--remove requires an absolute path; received ${path}`);
        remove.push(path);
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (remove.length > 0 && !fetch) {
    throw new Error("--no-fetch is audit-only and cannot be combined with --remove");
  }
  if (remove.length > 0 && json) {
    throw new Error("--json cannot be combined with --remove");
  }
  return { fetch, json, remove: [...new Set(remove)], sizes, target };
}

export function chooseDefaultRemote(remotes: readonly string[]): string {
  if (remotes.includes("origin")) return "origin";
  if (remotes.length === 1 && remotes[0] !== undefined) return remotes[0];
  if (remotes.length === 0) {
    throw new Error("No Git remote is configured; pass --target after adding a remote");
  }
  throw new Error("Several Git remotes are configured and none is named origin; pass --target <remote>/<branch>");
}

export function normalizeTarget(value: string, remotes: readonly string[]): Target {
  const shorthand = value.replace(/^refs\/remotes\//, "");
  const remote = [...remotes]
    .sort((left, right) => right.length - left.length)
    .find((candidate) => shorthand.startsWith(`${candidate}/`) && shorthand.length > candidate.length + 1);
  if (remote === undefined) {
    throw new Error(`--target must name a configured remote-tracking ref; received ${value}`);
  }
  const branch = shorthand.slice(remote.length + 1);
  return { branch, ref: `refs/remotes/${remote}/${branch}`, remote };
}

function sizeKiB(path: string): number | null {
  const result = command(["du", "-sk", path]);
  if (result.exitCode !== 0) return null;
  const value = Number.parseInt(result.stdout.split(/\s+/)[0] ?? "", 10);
  return Number.isFinite(value) ? value : null;
}

function formatGiB(kib: number | null): string {
  return kib === null ? "unknown" : `${(kib / 1_048_576).toFixed(1)} GiB`;
}

type ProtectedPaths = {
  readonly current: string;
  readonly primary: string;
};

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function samePath(left: string, right: string): boolean {
  return left === right || canonicalPath(left) === canonicalPath(right);
}

function evidenceFor(worktree: Worktree, protectedPaths: ProtectedPaths, targetRef: string): SafetyEvidence {
  const exists = existsSync(worktree.path);
  if (!exists) {
    return {
      registered: true,
      primary: samePath(worktree.path, protectedPaths.primary),
      current: samePath(worktree.path, protectedPaths.current),
      exists: false,
      clean: false,
      merged: false,
      statusReadable: false,
    };
  }
  const status = command([
    "git",
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
    "--ignored=matching",
    "--ignore-submodules=none",
  ], worktree.path);
  const index = gitIndexVisibility(worktree.path);
  const merged = command(["git", "merge-base", "--is-ancestor", "HEAD", targetRef], worktree.path);
  return {
    registered: true,
    primary: samePath(worktree.path, protectedPaths.primary),
    current: samePath(worktree.path, protectedPaths.current),
    exists,
    clean: status.exitCode === 0 && status.stdout === "" && index.transparent,
    merged: merged.exitCode === 0,
    statusReadable: status.exitCode === 0 && index.readable,
  };
}

type AuditRow = {
  readonly branch: string;
  readonly decision: SafetyDecision;
  readonly head: string;
  readonly path: string;
  readonly sizeKiB: number | null;
};

function audit(
  worktrees: readonly Worktree[],
  protectedPaths: ProtectedPaths,
  sizes: boolean,
  targetRef: string,
): AuditRow[] {
  return worktrees.map((worktree) => {
    const decision = classifySafety(evidenceFor(worktree, protectedPaths, targetRef));
    return {
      branch: worktree.branch ?? "DETACHED",
      decision,
      head: worktree.head,
      path: worktree.path,
      sizeKiB: sizes && decision.eligible ? sizeKiB(worktree.path) : null,
    };
  });
}

function printAudit(rows: readonly AuditRow[], json: boolean, targetRef: string): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ target: targetRef, worktrees: rows }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`TARGET\t${targetRef}\n`);
  const ordered = [...rows].sort(
    (left, right) => (right.sizeKiB ?? -1) - (left.sizeKiB ?? -1) || left.path.localeCompare(right.path),
  );
  for (const row of ordered) {
    process.stdout.write(
      `${row.decision.eligible ? "ELIGIBLE" : "KEEP"}\t${formatGiB(row.sizeKiB)}\t${row.decision.reason}\t${row.branch}\t${row.path}\n`,
    );
  }
  const eligible = rows.filter((row) => row.decision.eligible);
  const total = eligible.some((row) => row.sizeKiB === null)
    ? null
    : eligible.reduce((sum, row) => sum + (row.sizeKiB ?? 0), 0);
  process.stdout.write(`ELIGIBLE_TOTAL\t${eligible.length} worktrees\t${formatGiB(total)}\n`);
}

function configuredRemotes(): string[] {
  const output = requireCommand(["git", "remote"]);
  return output === "" ? [] : output.split("\n").filter((remote) => remote !== "");
}

function remoteDefaultBranch(remote: string): string {
  const result = command(["git", "ls-remote", "--symref", remote, "HEAD"]);
  if (result.exitCode !== 0) {
    throw new Error(`Unable to resolve the current default branch for ${remote}`);
  }
  const prefix = "ref: refs/heads/";
  const branch = result.stdout
    .split("\n")
    .find((line) => line.startsWith(prefix) && line.endsWith("\tHEAD"))
    ?.slice(prefix.length, -"\tHEAD".length);
  if (
    branch === undefined
    || branch === ""
    || command(["git", "check-ref-format", "--branch", branch]).exitCode !== 0
  ) {
    throw new Error(`The current default branch for ${remote} is unavailable`);
  }
  return branch;
}

function fetchExactTarget(target: Target): void {
  const result = command([
    "git",
    "fetch",
    "--no-tags",
    target.remote,
    `+refs/heads/${target.branch}:${target.ref}`,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`Unable to fetch the exact ${target.remote}/${target.branch} target`);
  }
}

function resolveTarget(explicitTarget: string | null, fetch: boolean): Target {
  const remotes = configuredRemotes();
  if (explicitTarget !== null) {
    const target = normalizeTarget(explicitTarget, remotes);
    if (fetch) fetchExactTarget(target);
    requireCommand(["git", "rev-parse", "--verify", `${target.ref}^{commit}`]);
    return target;
  }

  const remote = chooseDefaultRemote(remotes);
  if (fetch) {
    const target = normalizeTarget(`${remote}/${remoteDefaultBranch(remote)}`, remotes);
    fetchExactTarget(target);
    requireCommand(["git", "rev-parse", "--verify", `${target.ref}^{commit}`]);
    return target;
  }
  const symbolicHead = command([
    "git",
    "symbolic-ref",
    "--quiet",
    "--short",
    `refs/remotes/${remote}/HEAD`,
  ]);
  if (symbolicHead.exitCode !== 0 || symbolicHead.stdout === "") {
    const conventionalMain = `refs/remotes/${remote}/main`;
    if (command(["git", "rev-parse", "--verify", `${conventionalMain}^{commit}`]).exitCode === 0) {
      return { branch: "main", ref: conventionalMain, remote };
    }
    throw new Error(
      `The default branch for ${remote} is unavailable and ${conventionalMain} does not exist; pass --target ${remote}/<branch>`,
    );
  }
  const target = normalizeTarget(symbolicHead.stdout, remotes);
  requireCommand(["git", "rev-parse", "--verify", `${target.ref}^{commit}`]);
  return target;
}

function removeExact(
  options: Options,
  worktrees: readonly Worktree[],
  protectedPaths: ProtectedPaths,
  targetRef: string,
): void {
  const byPath = new Map(worktrees.map((worktree) => [worktree.path, worktree]));
  const reviewed = options.remove.map((path) => {
    const worktree = byPath.get(path);
    const evidence =
      worktree === undefined
        ? {
            registered: false,
            primary: samePath(path, protectedPaths.primary),
            current: samePath(path, protectedPaths.current),
            exists: existsSync(path),
            clean: false,
            merged: false,
            statusReadable: false,
          }
        : evidenceFor(worktree, protectedPaths, targetRef);
    return { path, worktree, decision: classifySafety(evidence), sizeKiB: sizeKiB(path) };
  });
  const refused = reviewed.filter((item) => !item.decision.eligible);
  if (refused.length > 0) {
    for (const item of refused) {
      process.stderr.write(`REFUSE\t${item.decision.reason}\t${item.path}\n`);
    }
    throw new Error("The manifest changed or contains unsafe targets; removed nothing");
  }

  let removedKiB = 0;
  for (const item of reviewed) {
    const current = parseWorktreePorcelain(requireCommand(["git", "worktree", "list", "--porcelain"])).find(
      (worktree) => worktree.path === item.path,
    );
    const decision =
      current === undefined
        ? { eligible: false, reason: "unregistered" as const }
        : classifySafety(evidenceFor(current, protectedPaths, targetRef));
    if (!decision.eligible) {
      throw new Error(`REFUSE at action time: ${decision.reason}: ${item.path}`);
    }
    requireCommand(["git", "worktree", "remove", item.path]);
    removedKiB += item.sizeKiB ?? 0;
    process.stdout.write(`REMOVED\t${formatGiB(item.sizeKiB)}\t${item.path}\n`);
  }
  process.stdout.write(`REMOVED_TOTAL\t${reviewed.length} worktrees\t${formatGiB(removedKiB)} estimated\n`);
}

export function main(argv: readonly string[]): void {
  const options = parseArgs(argv);
  const current = requireCommand(["git", "rev-parse", "--show-toplevel"]);
  const worktrees = parseWorktreePorcelain(requireCommand(["git", "worktree", "list", "--porcelain"]));
  const primary = worktrees[0]?.path;
  if (primary === undefined) throw new Error("Git did not report a primary worktree");
  const protectedPaths = { current, primary };
  const target = resolveTarget(options.target, options.fetch);
  if (options.remove.length === 0) {
    printAudit(audit(worktrees, protectedPaths, options.sizes, target.ref), options.json, target.ref);
  } else {
    removeExact(options, worktrees, protectedPaths, target.ref);
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(2));
}
