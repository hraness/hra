import { z } from "zod";

import {
  admitCommitCiRequiredJob,
  admitCommitCiRun,
} from "./check-commit-ci-run";
import { publicRepository } from "./release-distribution-policy";

const ownerUserId = 894_119;
const repositoryId = 1_343_008_607;
const repositoryOwnerId = 307_125_679;
const defaultBranch = "main";
const maximumOutputBytes = 512 * 1_024;
const stableVersionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const shaPattern = /^[0-9a-f]{40}$/u;
const exactOriginPattern = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)(?:hraness\/hra)(?:\.git)?$/u;

type CommandResult = Readonly<{ exitCode: number; stderr: string; stdout: string }>;
type CommandRunner = (command: readonly string[]) => CommandResult;

const userSchema = z.object({ id: z.number().int().positive(), type: z.string() });
const repositorySchema = z.object({
  default_branch: z.string(),
  full_name: z.string(),
  id: z.number().int().positive(),
  owner: z.object({ id: z.number().int().positive() }),
  private: z.literal(false),
  visibility: z.literal("public"),
});
const rulesetSummarySchema = z.array(z.object({ id: z.number().int().positive(), name: z.string() })).max(100);
const rulesetSchema = z.object({
  bypass_actors: z.array(z.object({
    actor_id: z.number().int().positive(),
    actor_type: z.string(),
    bypass_mode: z.string(),
  })).max(10),
  conditions: z.object({
    ref_name: z.object({ exclude: z.array(z.string()), include: z.array(z.string()) }),
  }),
  enforcement: z.string(),
  name: z.string(),
  rules: z.array(z.object({ type: z.string() }).passthrough()).max(20),
  target: z.string(),
});
const workflowSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  path: z.string(),
  state: z.string(),
});
const releaseEnvironmentSchema = z.object({
  can_admins_bypass: z.literal(false),
  deployment_branch_policy: z.object({
    custom_branch_policies: z.literal(true),
    protected_branches: z.literal(false),
  }),
  name: z.literal("npm-release"),
  protection_rules: z.array(z.object({ type: z.string() })).max(10),
});
const releaseEnvironmentPoliciesSchema = z.object({
  branch_policies: z.array(z.object({ name: z.string(), type: z.string() })).max(100),
  total_count: z.number().int().nonnegative(),
});

type StableVersion = readonly [bigint, bigint, bigint];

function commandText(command: readonly string[]): string {
  return command.map((part) => JSON.stringify(part)).join(" ");
}

function runCommand(command: readonly string[]): CommandResult {
  const result = Bun.spawnSync({
    cmd: [...command],
    env: {
      ...process.env,
      GCM_INTERACTIVE: "never",
      GH_PROMPT_DISABLED: "1",
      GIT_TERMINAL_PROMPT: "0",
      SSH_ASKPASS_REQUIRE: "never",
    },
    maxBuffer: maximumOutputBytes,
    stderr: "pipe",
    stdout: "pipe",
    timeout: 60_000,
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString("utf8"),
    stdout: result.stdout.toString("utf8"),
  };
}

function requireCommand(runner: CommandRunner, command: readonly string[]): string {
  const result = runner(command);
  if (result.exitCode !== 0) {
    throw new Error(`Release tag preflight command failed: ${commandText(command)}\n${result.stderr.trim()}`);
  }
  if (Buffer.byteLength(result.stdout) > maximumOutputBytes) {
    throw new Error(`Release tag preflight command exceeded its output bound: ${commandText(command)}`);
  }
  return result.stdout.trim();
}

function requireJson(runner: CommandRunner, command: readonly string[], label: string): unknown {
  const output = requireCommand(runner, command);
  try {
    return JSON.parse(output) as unknown;
  } catch {
    throw new Error(`${label} returned malformed JSON.`);
  }
}

export function parseStableVersion(value: string): StableVersion {
  const match = stableVersionPattern.exec(value);
  if (match === null) throw new Error("Release tag creation requires one canonical stable semantic version.");
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error("Release tag creation requires one canonical stable semantic version.");
  }
  return [BigInt(major), BigInt(minor), BigInt(patch)];
}

export function compareStableVersions(left: StableVersion, right: StableVersion): number {
  const pairs: readonly (readonly [bigint, bigint])[] = [
    [left[0], right[0]],
    [left[1], right[1]],
    [left[2], right[2]],
  ];
  for (const [a, b] of pairs) {
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

type RemoteTag = Readonly<{ commit: string | null; object: string; tag: string }>;

export function parseRemoteTags(output: string): readonly RemoteTag[] {
  if (Buffer.byteLength(output) > maximumOutputBytes) throw new Error("Remote tag inventory exceeded its output bound.");
  const records = new Map<string, { commit: string | null; object: string }>();
  for (const line of output.trim().length === 0 ? [] : output.trim().split("\n")) {
    const match = /^([0-9a-f]{40})\trefs\/tags\/(v[^\s^]+)(\^\{\})?$/u.exec(line);
    if (match === null) throw new Error("Remote tag inventory was malformed.");
    const [, sha, tag, peeled] = match;
    if (sha === undefined || tag === undefined) throw new Error("Remote tag inventory was malformed.");
    const existing = records.get(tag) ?? { commit: null, object: "" };
    if (peeled === undefined) {
      if (existing.object.length !== 0) throw new Error("Remote tag inventory contained a duplicate tag ref.");
      existing.object = sha;
    } else {
      if (existing.commit !== null) throw new Error("Remote tag inventory contained a duplicate peeled tag ref.");
      existing.commit = sha;
    }
    records.set(tag, existing);
  }
  return [...records.entries()].map(([tag, value]) => {
    if (value.object.length === 0) throw new Error("Remote tag inventory omitted its tag object.");
    return Object.freeze({ commit: value.commit, object: value.object, tag });
  });
}

export function assertMonotonicReleaseTag(
  version: string,
  sha: string,
  tags: readonly RemoteTag[],
): Readonly<{ alreadyPublished: boolean; tag: string }> {
  if (!shaPattern.test(sha)) throw new Error("Release tag creation requires one lowercase commit SHA.");
  const requested = parseStableVersion(version);
  const tag = `v${version}`;
  const exact = tags.filter((candidate) => candidate.tag === tag);
  if (exact.length > 1) throw new Error("Remote tag inventory contained an ambiguous release tag.");
  if (exact.length === 1) {
    const [existing] = exact;
    if (existing?.commit !== sha) throw new Error("The requested release tag already names different or lightweight bytes.");
    return Object.freeze({ alreadyPublished: true, tag });
  }
  const stable = tags.flatMap((candidate) => {
    const match = /^v(.+)$/u.exec(candidate.tag);
    const version = match?.[1];
    if (version === undefined || !stableVersionPattern.test(version)) return [];
    return [parseStableVersion(version)];
  });
  if (stable.some((candidate) => compareStableVersions(requested, candidate) <= 0)) {
    throw new Error("The requested release version is not newer than every remote stable version tag.");
  }
  return Object.freeze({ alreadyPublished: false, tag });
}

function assertRuleset(
  value: unknown,
  expected: Readonly<{ bypassOwner: boolean; name: string; rules: readonly string[] }>,
): void {
  const parsed = rulesetSchema.parse(value);
  if (
    parsed.name !== expected.name
    || parsed.target !== "tag"
    || parsed.enforcement !== "active"
    || parsed.conditions.ref_name.exclude.length !== 0
    || parsed.conditions.ref_name.include.length !== 1
    || parsed.conditions.ref_name.include[0] !== "refs/tags/v*"
  ) throw new Error(`${expected.name} ruleset does not protect the exact release tag namespace.`);
  const ruleTypes = parsed.rules.map((rule) => rule.type).sort();
  if (JSON.stringify(ruleTypes) !== JSON.stringify([...expected.rules].sort())) {
    throw new Error(`${expected.name} ruleset has unexpected rules.`);
  }
  const expectedBypass = expected.bypassOwner
    ? [{ actor_id: ownerUserId, actor_type: "User", bypass_mode: "always" }]
    : [];
  if (JSON.stringify(parsed.bypass_actors) !== JSON.stringify(expectedBypass)) {
    throw new Error(`${expected.name} ruleset has unexpected bypass authority.`);
  }
}

export function assertReleaseRulesets(listValue: unknown, detailValues: ReadonlyMap<string, unknown>): void {
  const list = rulesetSummarySchema.parse(listValue);
  for (const expected of [
    { bypassOwner: true, name: "Release tag creation", rules: ["creation"] },
    { bypassOwner: false, name: "Immutable version tags", rules: ["deletion", "update"] },
  ] as const) {
    const candidates = list.filter((item) => item.name === expected.name);
    if (candidates.length !== 1) throw new Error(`Expected exactly one active ${expected.name} ruleset.`);
    const detail = detailValues.get(expected.name);
    if (detail === undefined) throw new Error(`Missing ${expected.name} ruleset readback.`);
    assertRuleset(detail, expected);
  }
}

function exactBranchRuleset(value: unknown, name: string): ReturnType<typeof rulesetSchema.parse> {
  const parsed = rulesetSchema.parse(value);
  if (
    parsed.name !== name
    || parsed.target !== "branch"
    || parsed.enforcement !== "active"
    || parsed.bypass_actors.length !== 0
    || parsed.conditions.ref_name.exclude.length !== 0
    || parsed.conditions.ref_name.include.length !== 1
    || parsed.conditions.ref_name.include[0] !== "refs/heads/main"
  ) throw new Error(`${name} ruleset does not protect exact main without bypass.`);
  return parsed;
}

export function assertMainRulesets(listValue: unknown, detailValues: ReadonlyMap<string, unknown>): void {
  const list = rulesetSummarySchema.parse(listValue);
  const details = (name: string): unknown => {
    if (list.filter((item) => item.name === name).length !== 1) {
      throw new Error(`Expected exactly one active ${name} ruleset.`);
    }
    const detail = detailValues.get(name);
    if (detail === undefined) throw new Error(`Missing ${name} ruleset readback.`);
    return detail;
  };
  const immutable = exactBranchRuleset(details("Immutable main"), "Immutable main");
  if (JSON.stringify(immutable.rules.map((rule) => rule.type).sort()) !== JSON.stringify([
    "deletion", "non_fast_forward", "required_linear_history",
  ])) throw new Error("Immutable main ruleset has unexpected rules.");

  const protection = exactBranchRuleset(details("Protect main"), "Protect main");
  if (JSON.stringify(protection.rules.map((rule) => rule.type).sort()) !== JSON.stringify([
    "pull_request", "required_status_checks",
  ])) throw new Error("Protect main ruleset has unexpected rules.");
  const pullRequest = protection.rules.find((rule) => rule.type === "pull_request");
  const statusChecks = protection.rules.find((rule) => rule.type === "required_status_checks");
  const pullParameters = z.object({
    allowed_merge_methods: z.array(z.string()),
    require_extra_approval_for_unattributed_changes: z.literal(true),
    required_approving_review_count: z.literal(0),
    required_review_thread_resolution: z.literal(true),
  }).passthrough().parse(pullRequest?.parameters);
  if (JSON.stringify([...pullParameters.allowed_merge_methods].sort()) !== JSON.stringify(["rebase", "squash"])) {
    throw new Error("Protect main ruleset has unexpected merge methods.");
  }
  const statusParameters = z.object({
    do_not_enforce_on_create: z.literal(false),
    required_status_checks: z.array(z.object({
      context: z.literal("Required"),
      integration_id: z.literal(15_368),
    })).length(1),
    strict_required_status_checks_policy: z.literal(true),
  }).parse(statusChecks?.parameters);
  void statusParameters;
}

export function assertActiveCiWorkflow(value: unknown): void {
  const workflow = workflowSchema.parse(value);
  if (
    workflow.id !== 340_428_685
    || workflow.name !== "CI"
    || workflow.path !== ".github/workflows/ci.yml"
    || workflow.state !== "active"
  ) throw new Error("The required CI workflow is not the exact active repository workflow.");
}

export function assertReleaseEnvironment(environmentValue: unknown, policiesValue: unknown): void {
  const environment = releaseEnvironmentSchema.parse(environmentValue);
  if (JSON.stringify(environment.protection_rules.map((rule) => rule.type)) !== JSON.stringify(["branch_policy"])) {
    throw new Error("npm-release environment has unexpected protection rules.");
  }
  const policies = releaseEnvironmentPoliciesSchema.parse(policiesValue);
  const [policy] = policies.branch_policies;
  if (
    policies.total_count !== 1
    || policies.branch_policies.length !== 1
    || policy === undefined
    || policy.name !== "v*"
    || policy.type !== "tag"
  ) throw new Error("npm-release environment must admit only version tags.");
}

export function assertReleaseRepository(value: unknown): void {
  const repository = repositorySchema.parse(value);
  if (
    repository.full_name !== publicRepository
    || repository.id !== repositoryId
    || repository.owner.id !== repositoryOwnerId
    || repository.default_branch !== defaultBranch
  ) throw new Error("Release tag creation found the wrong GitHub repository identity.");
}

export function assertExactOriginUrls(fetchOutput: string, pushOutput: string): void {
  const fetchOrigins = fetchOutput.split("\n");
  const pushOrigins = pushOutput.split("\n");
  if (
    fetchOrigins.length !== 1
    || pushOrigins.length !== 1
    || !exactOriginPattern.test(fetchOrigins[0] ?? "")
    || !exactOriginPattern.test(pushOrigins[0] ?? "")
  ) throw new Error(`Release tag creation requires ${publicRepository} as origin.`);
}

function exactSha(output: string, label: string): string {
  const fields = output.split(/\s+/u);
  const [sha] = fields;
  if (fields.length !== 2 || sha === undefined || !shaPattern.test(sha)) throw new Error(`${label} was malformed.`);
  return sha;
}

export function assertTransparentGitIndex(output: string): void {
  const entries = output.split("\0").filter(Boolean);
  if (entries.some((entry) => entry[0] === "S" || /^[a-z]$/u.test(entry[0] ?? ""))) {
    throw new Error("Release tag creation refuses skip-worktree or assume-unchanged Git index entries.");
  }
}

export async function createReleaseTag(
  runner: CommandRunner = runCommand,
  readManifest: () => Promise<unknown> = async () => Bun.file("package.json").json() as Promise<unknown>,
): Promise<string> {
  const user = userSchema.parse(requireJson(runner, ["gh", "api", "user"], "GitHub user identity"));
  if (user.id !== ownerUserId || user.type !== "User") {
    throw new Error(`Release tag creation requires authenticated immutable owner User ID ${String(ownerUserId)}.`);
  }
  assertReleaseRepository(requireJson(
    runner,
    ["gh", "api", `repos/${publicRepository}`],
    "GitHub repository identity",
  ));

  const root = requireCommand(runner, ["git", "rev-parse", "--show-toplevel"]);
  if (root !== process.cwd()) throw new Error("Release tag creation must run from the repository root.");
  if (requireCommand(runner, ["git", "status", "--porcelain=v1", "--untracked-files=all"]).length !== 0) {
    throw new Error("Release tag creation requires a clean working tree.");
  }
  assertTransparentGitIndex(requireCommand(runner, ["git", "ls-files", "-v", "-z"]));
  if (requireCommand(runner, ["git", "branch", "--show-current"]) !== defaultBranch) {
    throw new Error(`Release tag creation must run on ${defaultBranch}.`);
  }
  assertExactOriginUrls(
    requireCommand(runner, ["git", "remote", "get-url", "--all", "origin"]),
    requireCommand(runner, ["git", "remote", "get-url", "--push", "--all", "origin"]),
  );
  const sha = requireCommand(runner, ["git", "rev-parse", "--verify", "HEAD^{commit}"]);
  if (!shaPattern.test(sha)) throw new Error("Release tag creation found an invalid HEAD commit.");
  const remoteMain = exactSha(
    requireCommand(runner, ["git", "ls-remote", "--heads", "origin", `refs/heads/${defaultBranch}`]),
    "Remote main readback",
  );
  if (remoteMain !== sha) throw new Error("Release tag creation requires HEAD to equal current remote main.");

  const manifestSchema = z.object({ name: z.literal("@hraness/hra"), version: z.string() });
  const committedManifest = manifestSchema.parse(requireJson(
    runner,
    ["git", "show", "HEAD:package.json"],
    "Committed package manifest",
  ));
  const manifest = manifestSchema.parse(await readManifest());
  if (manifest.version !== committedManifest.version) {
    throw new Error("Working package manifest does not match the exact committed package manifest.");
  }
  const tagInventory = requireCommand(runner, ["git", "ls-remote", "--tags", "origin", "refs/tags/v*"]);
  const plan = assertMonotonicReleaseTag(manifest.version, sha, parseRemoteTags(tagInventory));

  const rulesets = rulesetSummarySchema.parse(requireJson(
    runner,
    ["gh", "api", "--method", "GET", `repos/${publicRepository}/rulesets`, "-f", "per_page=100"],
    "GitHub ruleset inventory",
  ));
  const details = new Map<string, unknown>();
  for (const name of ["Release tag creation", "Immutable version tags", "Immutable main", "Protect main"] as const) {
    const candidate = rulesets.filter((item) => item.name === name);
    if (candidate.length !== 1) throw new Error(`Expected exactly one active ${name} ruleset.`);
    const [summary] = candidate;
    if (summary === undefined) throw new Error(`Expected exactly one active ${name} ruleset.`);
    details.set(name, requireJson(
      runner,
      ["gh", "api", `repos/${publicRepository}/rulesets/${String(summary.id)}`],
      `${name} ruleset`,
    ));
  }
  assertReleaseRulesets(rulesets, details);
  assertMainRulesets(rulesets, details);
  assertActiveCiWorkflow(requireJson(
    runner,
    ["gh", "api", `repos/${publicRepository}/actions/workflows/ci.yml`],
    "CI workflow metadata",
  ));
  assertReleaseEnvironment(
    requireJson(
      runner,
      ["gh", "api", `repos/${publicRepository}/environments/npm-release`],
      "npm-release environment",
    ),
    requireJson(
      runner,
      ["gh", "api", "--method", "GET", `repos/${publicRepository}/environments/npm-release/deployment-branch-policies`, "-f", "per_page=100"],
      "npm-release environment policies",
    ),
  );

  const identity = { defaultBranch, repository: publicRepository, sha } as const;
  const runInventory = requireJson(runner, [
    "gh", "api", "--method", "GET", `repos/${publicRepository}/actions/workflows/ci.yml/runs`,
    "-f", `branch=${defaultBranch}`, "-f", "event=push", "-f", `head_sha=${sha}`, "-f", "per_page=100",
  ], "CI run inventory");
  const run = admitCommitCiRun(runInventory, identity);
  const jobs = requireJson(runner, [
    "gh", "api", "--method", "GET", `repos/${publicRepository}/actions/runs/${String(run.runId)}/jobs`,
    "-f", "filter=latest", "-f", "per_page=100",
  ], "CI job inventory");
  admitCommitCiRequiredJob(jobs, run, identity);

  if (plan.alreadyPublished) return `Release tag ${plan.tag} already immutably names ${sha}.`;
  const local = runner(["git", "show-ref", "--verify", "--quiet", `refs/tags/${plan.tag}`]);
  if (local.exitCode === 0) {
    throw new Error("The unreleased local tag already exists; refuse to adopt pre-existing tag authority.");
  } else if (local.exitCode === 1) {
    requireCommand(runner, ["git", "-c", "tag.gpgSign=false", "tag", "-a", plan.tag, "-m", `Release ${plan.tag}`, sha]);
  } else {
    throw new Error("Local release tag inspection failed.");
  }
  const tagObject = requireCommand(runner, ["git", "rev-parse", "--verify", `${plan.tag}^{tag}`]);
  try {
    const finalRemoteMain = exactSha(
      requireCommand(runner, ["git", "ls-remote", "--heads", "origin", `refs/heads/${defaultBranch}`]),
      "Final remote main readback",
    );
    if (finalRemoteMain !== sha) {
      throw new Error("Remote main advanced during release tag preflight.");
    }
    requireCommand(runner, ["git", "push", "origin", `refs/tags/${plan.tag}:refs/tags/${plan.tag}`]);
    const exactRemote = parseRemoteTags(requireCommand(
      runner,
      ["git", "ls-remote", "--tags", "origin", `refs/tags/${plan.tag}`, `refs/tags/${plan.tag}^{}`],
    ));
    const [remote] = exactRemote;
    if (exactRemote.length !== 1 || remote === undefined || remote.object !== tagObject || remote.commit !== sha) {
      throw new Error("Remote release tag readback did not match the exact local annotated tag object.");
    }
  } catch (error) {
    const cleanup = runner(["git", "update-ref", "-d", `refs/tags/${plan.tag}`, tagObject]);
    const remaining = runner(["git", "show-ref", "--verify", "--quiet", `refs/tags/${plan.tag}`]);
    if (cleanup.exitCode !== 0 || remaining.exitCode !== 1) {
      throw new Error("Release tag push failed and exact transient local-tag cleanup could not be proven.", {
        cause: error,
      });
    }
    throw error;
  }
  return `Created immutable ${plan.tag} (${tagObject}) for ${sha}; the protected release workflow now owns publication.`;
}

if (import.meta.main) {
  try {
    console.log(await createReleaseTag());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
