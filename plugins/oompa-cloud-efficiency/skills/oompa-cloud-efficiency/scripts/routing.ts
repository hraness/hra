import { lstatSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import {
  canonicalIfPresent,
  command,
  requireGitHubSlug,
  requireCommand,
  requireSafeIdentifier,
} from "./shared";
import type { CommandRunner } from "./shared";

export const cloudProfiles = Object.freeze([
  "linux-browser",
  "linux-media",
  "node24-web",
  "portable-bun",
  "qmd-linux",
] as const);

export const localRequirements = Object.freeze([
  "agent-network",
  "authenticated-browser",
  "hardware",
  "interactive-auth",
  "mac-native",
  "private-local-data",
  "production-mutation",
  "runtime-secret",
  "signing",
  "two-factor",
  "uncommitted-input",
] as const);

export type CloudProfile = typeof cloudProfiles[number];
export type Intent = "edit" | "read-only";
export type LocalRequirement = typeof localRequirements[number];
export type ModelPolicy = "cloud-default-ok" | "exact";
export type RouteDecision = "cloud" | "hybrid" | "local";

export type RouteOptions = {
  readonly environment: string | null;
  readonly environmentRepository: string | null;
  readonly finalNeeds: readonly LocalRequirement[];
  readonly intent: Intent;
  readonly json: boolean;
  readonly modelPolicy: ModelPolicy;
  readonly needs: readonly LocalRequirement[];
  readonly online: boolean;
  readonly owner: string;
  readonly packet: boolean;
  readonly profile: CloudProfile | null;
  readonly root: string;
};

export type RepositoryQualification = {
  readonly branch: string;
  readonly onlineVerified: boolean;
  readonly repository: string;
  readonly sha: string;
};

type BaseRouteReport = {
  readonly dispatchReady: boolean;
  readonly environmentConfigured: boolean;
  readonly finalNeeds: readonly LocalRequirement[];
  readonly intent: Intent;
  readonly modelPolicy: ModelPolicy;
  readonly needs: readonly LocalRequirement[];
  readonly next: readonly string[];
  readonly owner: string;
  readonly profile: CloudProfile | null;
  readonly version: 1;
};

export type LocalRouteReport = BaseRouteReport & {
  readonly decision: "local";
};

export type CloudRouteReport = BaseRouteReport & RepositoryQualification & {
  readonly decision: "cloud" | "hybrid";
  readonly profile: CloudProfile;
};

export type RouteReport = CloudRouteReport | LocalRouteReport;

const unsafeGitEnvironment = Object.freeze([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_EXEC_PATH",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_REPLACE_REF_BASE",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_WORK_TREE",
] as const);

function unsafeGitEnvironmentPresent(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): boolean {
  return unsafeGitEnvironment.some((name) => environment[name] !== undefined)
    || Object.keys(environment).some((name) => /^GIT_CONFIG_/u.test(name));
}

function parseChoice<T extends string>(
  value: string,
  choices: readonly T[],
  option: string,
): T {
  if (!choices.includes(value as T)) {
    throw new Error(`${option} must be one of: ${choices.join(", ")}`);
  }
  return value as T;
}

export function parseRouteArguments(
  arguments_: readonly string[],
  cwd = process.cwd(),
): RouteOptions {
  let environment: string | null = null;
  let environmentRepository: string | null = null;
  const finalNeeds: LocalRequirement[] = [];
  let intent: Intent | null = null;
  let json = false;
  let modelPolicy: ModelPolicy | null = null;
  const needs: LocalRequirement[] = [];
  let online = false;
  let owner: string | null = null;
  let packet = false;
  let profile: CloudProfile | null = null;
  let root = resolve(cwd);
  let rootSupplied = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--online") {
      online = true;
      continue;
    }
    if (argument === "--packet") {
      packet = true;
      continue;
    }
    if (
      argument === "--environment"
      || argument === "--environment-repository"
      || argument === "--final-needs"
      || argument === "--intent"
      || argument === "--model-policy"
      || argument === "--needs"
      || argument === "--owner"
      || argument === "--profile"
      || argument === "--root"
    ) {
      const value = arguments_[index + 1];
      if (value === undefined || value === "") throw new Error(`${argument} requires a value`);
      if (argument === "--environment") {
        if (environment !== null) throw new Error("--environment may be supplied only once");
        environment = requireSafeIdentifier(value, argument);
      } else if (argument === "--environment-repository") {
        if (environmentRepository !== null) {
          throw new Error("--environment-repository may be supplied only once");
        }
        environmentRepository = requireGitHubSlug(value, argument);
      } else if (argument === "--final-needs") {
        finalNeeds.push(parseChoice(value, localRequirements, argument));
      } else if (argument === "--intent") {
        if (intent !== null) throw new Error("--intent may be supplied only once");
        intent = parseChoice(value, ["edit", "read-only"] as const, argument);
      } else if (argument === "--model-policy") {
        if (modelPolicy !== null) throw new Error("--model-policy may be supplied only once");
        modelPolicy = parseChoice(value, ["cloud-default-ok", "exact"] as const, argument);
      } else if (argument === "--needs") {
        needs.push(parseChoice(value, localRequirements, argument));
      } else if (argument === "--owner") {
        if (owner !== null) throw new Error("--owner may be supplied only once");
        owner = requireSafeIdentifier(value, argument, 64);
      } else if (argument === "--profile") {
        if (profile !== null) throw new Error("--profile may be supplied only once");
        profile = parseChoice(value, cloudProfiles, argument);
      } else {
        if (rootSupplied || !isAbsolute(value)) {
          throw new Error("--root requires one absolute path");
        }
        root = resolve(value);
        rootSupplied = true;
      }
      index += 1;
      continue;
    }
    throw new Error(`unknown route argument: ${argument}`);
  }

  if (intent === null) throw new Error("--intent is required");
  if (modelPolicy === null) throw new Error("--model-policy is required");
  if (owner === null) throw new Error("--owner is required");
  const hardLocal = modelPolicy === "exact" || needs.length > 0;
  if (profile === null && !hardLocal) throw new Error("--profile is required");
  if (json && packet) throw new Error("choose only one of --json or --packet");
  if ((environment === null) !== (environmentRepository === null)) {
    throw new Error("--environment and --environment-repository must be supplied together");
  }
  return {
    environment,
    environmentRepository,
    finalNeeds: [...new Set(finalNeeds)].sort(),
    intent,
    json,
    modelPolicy,
    needs: [...new Set(needs)].sort(),
    online,
    owner,
    packet,
    profile,
    root,
  };
}

export function parseGitHubRepository(remoteUrl: string): string {
  const trimmed = remoteUrl.trim();
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(trimmed);
  if (match === null) throw new Error("origin must be one supported GitHub repository URL");
  return `${match[1]}/${match[2]}`;
}

function hiddenIndexFlags(output: string): boolean {
  return output.split("\0").filter(Boolean).some((entry) => {
    const tag = entry[0] ?? "";
    return tag === "S" || /^[a-z]$/u.test(tag);
  });
}

function hasGitlink(output: string): boolean {
  return output.split("\0").filter(Boolean).some((entry) => entry.startsWith("160000 "));
}

function exactCommit(value: string, description: string): string {
  const normalized = value.trim();
  if (!/^[0-9a-f]{40}$/u.test(normalized)) throw new Error(`${description} is not one exact commit`);
  return normalized;
}

function branchFromTrackingRef(value: string, description: string): string {
  const match = /^origin\/(.+)$/u.exec(value.trim());
  if (match === null || command(["git", "check-ref-format", "--branch", match[1] ?? ""]).exitCode !== 0) {
    throw new Error(`${description} is not one valid origin branch`);
  }
  return match[1] ?? "";
}

function remoteDefaultBranch(output: string): string {
  const symbolic = output.split("\n").filter((row) => row.startsWith("ref: "));
  if (symbolic.length !== 1) throw new Error("remote default branch did not resolve to one symbolic ref");
  const match = /^ref: refs\/heads\/(.+)\tHEAD$/u.exec(symbolic[0] ?? "");
  if (match === null || command(["git", "check-ref-format", "--branch", match[1] ?? ""]).exitCode !== 0) {
    throw new Error("remote default branch response was not exact");
  }
  return match[1] ?? "";
}

export function inspectRepository(
  options: Pick<RouteOptions, "intent" | "online" | "root">,
  runner: CommandRunner = command,
): RepositoryQualification {
  if (unsafeGitEnvironmentPresent()) {
    throw new Error("repository qualification refuses Git environment overrides");
  }
  const metadata = lstatSync(options.root);
  if (!metadata.isDirectory()) throw new Error("repository root is not a directory");
  const topLevel = requireCommand(
    ["git", "rev-parse", "--show-toplevel"],
    options.root,
    runner,
    "repository root is not a Git worktree",
  );
  if (canonicalIfPresent(topLevel) !== canonicalIfPresent(options.root)) {
    throw new Error("--root must be the exact Git top-level");
  }
  if (requireCommand(
    ["git", "for-each-ref", "--format=%(refname)", "refs/replace"],
    options.root,
    runner,
    "Git replacement refs could not be inspected",
  ) !== "") throw new Error("repository contains Git replacement refs");
  const grafts = requireCommand(
    ["git", "rev-parse", "--git-path", "info/grafts"],
    options.root,
    runner,
    "Git graft path could not be inspected",
  );
  try {
    lstatSync(isAbsolute(grafts) ? grafts : resolve(options.root, grafts));
    throw new Error("repository contains a legacy Git graft file");
  } catch (error: unknown) {
    if (
      typeof error !== "object"
      || error === null
      || !("code" in error)
      || error.code !== "ENOENT"
    ) throw error;
  }
  if (requireCommand(
    ["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    options.root,
    runner,
    "Git status could not be read",
  ) !== "") throw new Error("repository has staged, tracked, or untracked changes");

  const branch = requireCommand(
    ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
    options.root,
    runner,
    "repository must be on one named branch",
  ).trim();
  if (branch === "" || runner(["git", "check-ref-format", "--branch", branch], options.root).exitCode !== 0) {
    throw new Error("current branch is invalid");
  }
  const defaultResult = runner(
    ["git", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    options.root,
  );
  if (options.intent === "edit" && defaultResult.exitCode !== 0) {
    throw new Error("editable Cloud work requires a known origin default branch");
  }
  const defaultBranch = defaultResult.exitCode === 0
    ? branchFromTrackingRef(defaultResult.stdout, "origin default branch")
    : null;
  if (options.intent === "edit" && branch === defaultBranch) {
    throw new Error("editable Cloud work requires one unique non-default branch");
  }

  const upstream = requireCommand(
    ["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    options.root,
    runner,
    "current branch must have one upstream",
  ).trim();
  if (upstream !== `origin/${branch}`) {
    throw new Error("current branch must track the same branch name on origin");
  }

  const sha = exactCommit(requireCommand(
    ["git", "rev-parse", "HEAD"],
    options.root,
    runner,
    "HEAD could not be read",
  ), "HEAD");
  const trackingSha = exactCommit(requireCommand(
    ["git", "rev-parse", `refs/remotes/origin/${branch}`],
    options.root,
    runner,
    "upstream tracking commit could not be read",
  ), "upstream tracking commit");
  if (trackingSha !== sha) throw new Error("local HEAD does not equal its upstream tracking commit");

  const indexFlags = requireCommand(
    ["git", "ls-files", "-v", "-z"],
    options.root,
    runner,
    "Git index visibility could not be read",
  );
  if (hiddenIndexFlags(indexFlags)) throw new Error("Git index contains hidden skip-worktree or assume-unchanged state");
  const staged = requireCommand(
    ["git", "ls-files", "--stage", "-z"],
    options.root,
    runner,
    "Git index entries could not be read",
  );
  if (hasGitlink(staged)) throw new Error("Git index contains a repository link that Cloud cannot qualify exactly");

  const origin = requireCommand(
    ["git", "remote", "get-url", "origin"],
    options.root,
    runner,
    "origin URL could not be read",
  );
  const repository = parseGitHubRepository(origin);

  if (options.online) {
    const remoteHead = runner(["git", "ls-remote", "--symref", "origin", "HEAD"], options.root);
    if (remoteHead.exitCode !== 0) throw new Error("remote default branch could not be verified");
    const verifiedDefaultBranch = remoteDefaultBranch(remoteHead.stdout);
    if (defaultBranch !== null && verifiedDefaultBranch !== defaultBranch) {
      throw new Error("local and remote default branch identity differ");
    }
    const remote = runner(["git", "ls-remote", "--exit-code", "origin", `refs/heads/${branch}`], options.root);
    if (remote.exitCode !== 0) throw new Error("remote branch could not be verified");
    const rows = remote.stdout.split("\n").filter(Boolean);
    if (rows.length !== 1) throw new Error("remote branch did not resolve to one ref");
    const [remoteSha, remoteRef, extra] = rows[0]?.split("\t") ?? [];
    if (extra !== undefined || remoteRef !== `refs/heads/${branch}`) {
      throw new Error("remote branch response was not exact");
    }
    if (exactCommit(remoteSha ?? "", "remote branch commit") !== sha) {
      throw new Error("remote branch changed or does not equal local HEAD");
    }
  }

  return { branch, onlineVerified: options.online, repository, sha };
}

export function decideRoute(
  options: RouteOptions,
  repository?: RepositoryQualification,
): RouteReport {
  const decision = routeDecision(options);
  const next: string[] = [];
  if (decision === "local") {
    if (options.modelPolicy === "exact") next.push("preserve the selected model and reasoning effort on a local or compatible connected host");
    if (options.needs.length > 0) next.push("keep execution on the authoritative local capability lane");
    return {
      decision,
      dispatchReady: false,
      environmentConfigured: options.environment !== null,
      finalNeeds: options.finalNeeds,
      intent: options.intent,
      modelPolicy: options.modelPolicy,
      needs: options.needs,
      next,
      owner: options.owner,
      profile: options.profile,
      version: 1,
    };
  }

  if (repository === undefined) throw new Error("Cloud route requires repository qualification");
  if (options.profile === null) throw new Error("Cloud route requires an environment profile");
  if (
    options.environmentRepository !== null
    && options.environmentRepository !== repository.repository
  ) throw new Error("configured environment repository does not match the qualified repository");
  if (options.environment === null) next.push("configure and name one Codex Cloud environment");
  if (!options.online) next.push("repeat the route check with --online immediately before dispatch");
  if (decision === "hybrid") next.push("assign one local owner for every final-only capability");

  return {
    ...repository,
    decision,
    dispatchReady: options.environment !== null && options.online,
    environmentConfigured: options.environment !== null,
    finalNeeds: options.finalNeeds,
    intent: options.intent,
    modelPolicy: options.modelPolicy,
    needs: options.needs,
    next,
    owner: options.owner,
    profile: options.profile,
    version: 1,
  };
}

export function routeDecision(options: RouteOptions): RouteDecision {
  if (options.modelPolicy === "exact" || options.needs.length > 0) return "local";
  if (options.finalNeeds.length > 0) return "hybrid";
  return "cloud";
}

export function routeTask(
  options: RouteOptions,
  runner: CommandRunner = command,
): RouteReport {
  return routeDecision(options) === "local"
    ? decideRoute(options)
    : decideRoute(options, inspectRepository(options, runner));
}

export function dispatchPacketHeader(report: RouteReport): string {
  if (report.decision === "local") {
    throw new Error("a local route cannot produce a Codex Cloud dispatch packet");
  }
  const localFinal = report.finalNeeds.length === 0 ? "none" : report.finalNeeds.join(", ");
  return [
    "Bounded Codex Cloud repository worker",
    `Repository: ${report.repository}`,
    `Governed branch: ${report.branch}`,
    `Governed commit: ${report.sha}`,
    `Intent: ${report.intent}`,
    `Owner: ${report.owner}`,
    `Environment profile: ${report.profile}`,
    "Worker model label: cloud-default; do not claim local model or reasoning inheritance.",
    `Final local-only proofs: ${localFinal}`,
    "Before any other work, verify origin identifies the governed repository, HEAD equals the governed commit, and Git status is clean. Stop without edits on any mismatch.",
    "Do not merge, release, deploy, mutate providers, use private local inputs, or weaken repository gates.",
    "Read repository AGENTS.md, stay within the bounded objective, run focused validation, and report exact commands and results.",
  ].join("\n");
}
