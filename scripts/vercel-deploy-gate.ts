import { execFileSync } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const productionDependencySections = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const nonBuildDevDependencies = new Set([
  "@eslint/js",
  "@hra-internal/eslint-config",
  "@hra-internal/test",
  "convex-test",
  "eslint",
  "eslint-config-next",
  "fast-check",
  "typescript-eslint",
]);

const exactAlwaysGlobalInputs = new Set([
  ".vercelignore",
  "bunfig.toml",
  "scripts/vercel-deploy-gate.ts",
]);
const exactTargetScopedInputs = new Set(["bun.lock", "package.json"]);
const globalInputPrefixes = ["patches/"] as const;
const exactCommitPattern = /^[0-9a-f]{40}$/iu;
const rootInstallLifecycleScripts = new Set([
  "install",
  "postinstall",
  "postprepare",
  "preinstall",
  "preprepare",
  "prepare",
]);
const workspaceManifestPattern =
  /^(?:apps\/[^/]+|packages\/[^/]+|packages\/internal\/[^/]+)\/package\.json$/u;

export interface WorkspaceDeploymentNode {
  readonly dependencies: readonly string[];
  readonly name: string;
  readonly rootDirectory: string;
}

export interface DeploymentDecision {
  readonly action: "build" | "skip";
  readonly matchedPaths: readonly string[];
  readonly reason: string;
}

interface CliOptions {
  base?: string;
  head: string;
  workspace?: string;
}

export interface GitCommitRecovery {
  readonly fetchExactCommit: (ref: string) => void;
  readonly hasCommit: (ref: string) => boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function normalizeRepositoryPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function isWithinRoot(path: string, rootDirectory: string): boolean {
  return path === rootDirectory || path.startsWith(`${rootDirectory}/`);
}

function isGlobalInput(path: string, targetScopedGlobalInputs?: ReadonlySet<string>): boolean {
  return (
    exactAlwaysGlobalInputs.has(path) ||
    (exactTargetScopedInputs.has(path) &&
      (targetScopedGlobalInputs === undefined || targetScopedGlobalInputs.has(path))) ||
    globalInputPrefixes.some((prefix) => path.startsWith(prefix))
  );
}

function relevantWorkspaceNames(
  targetWorkspace: string,
  workspaces: readonly WorkspaceDeploymentNode[],
): ReadonlySet<string> | undefined {
  const workspaceByName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  if (!workspaceByName.has(targetWorkspace)) return undefined;

  const relevantNames = new Set<string>();
  const pending = [targetWorkspace];
  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined || relevantNames.has(name)) continue;
    relevantNames.add(name);
    const workspace = workspaceByName.get(name);
    if (workspace === undefined) continue;
    for (const dependency of workspace.dependencies) {
      if (workspaceByName.has(dependency)) pending.push(dependency);
    }
  }
  return relevantNames;
}

export function decideVercelDeployment(
  targetWorkspace: string,
  changedPaths: readonly string[],
  workspaces: readonly WorkspaceDeploymentNode[],
  targetScopedGlobalInputs?: ReadonlySet<string>,
): DeploymentDecision {
  const workspaceByName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const relevantNames = relevantWorkspaceNames(targetWorkspace, workspaces);
  if (relevantNames === undefined) {
    return {
      action: "build",
      matchedPaths: [],
      reason: `workspace ${targetWorkspace} is missing from the repository graph`,
    };
  }

  const relevantRoots = [...relevantNames].flatMap((name) => {
    const workspace = workspaceByName.get(name);
    return workspace === undefined ? [] : [normalizeRepositoryPath(workspace.rootDirectory)];
  });

  const normalizedChanges = changedPaths.map(normalizeRepositoryPath).filter((path) => path.length > 0);
  const matchedPaths = normalizedChanges.filter(
    (path) => {
      return (
        isGlobalInput(path, targetScopedGlobalInputs) ||
        relevantRoots.some((root) => isWithinRoot(path, root))
      );
    },
  );
  if (matchedPaths.length > 0) {
    return {
      action: "build",
      matchedPaths,
      reason: "the deployable workspace, a transitive dependency, or a global build input changed",
    };
  }
  return {
    action: "skip",
    matchedPaths: [],
    reason: "only unrelated workspace or repository files changed",
  };
}

async function childDirectories(directory: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(directory, entry.name));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function childManifestPaths(directory: string): Promise<readonly string[]> {
  const candidates = (await childDirectories(directory)).map((child) => join(child, "package.json"));
  const existing = await Promise.all(
    candidates.map(async (path) => ({ exists: await fileExists(path), path })),
  );
  return existing.filter((candidate) => candidate.exists).map((candidate) => candidate.path);
}

async function collectWorkspaceManifestPaths(root: string): Promise<readonly string[]> {
  const [appPaths, packagePaths, internalPackagePaths] = await Promise.all([
    childManifestPaths(join(root, "apps")),
    childManifestPaths(join(root, "packages")),
    childManifestPaths(join(root, "packages", "internal")),
  ]);
  return [...appPaths, ...packagePaths, ...internalPackagePaths].sort();
}

export function parseBuildDependencyNames(
  value: Record<string, unknown>,
  path: string,
): readonly string[] {
  const dependencies = new Set<string>();
  for (const section of productionDependencySections) {
    const dependencyMap = value[section];
    if (dependencyMap === undefined) continue;
    if (!isRecord(dependencyMap)) throw new Error(`${path} ${section} must be an object`);
    for (const [name, version] of Object.entries(dependencyMap)) {
      if (typeof version !== "string") throw new Error(`${path} ${section}.${name} must be a string`);
      dependencies.add(name);
    }
  }

  const devDependencies = value.devDependencies;
  if (devDependencies !== undefined) {
    if (!isRecord(devDependencies)) throw new Error(`${path} devDependencies must be an object`);
    for (const [name, version] of Object.entries(devDependencies)) {
      if (typeof version !== "string") {
        throw new Error(`${path} devDependencies.${name} must be a string`);
      }
      if (!nonBuildDevDependencies.has(name)) dependencies.add(name);
    }
  }

  return [...dependencies].sort();
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalizeJson(child)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

function rootPackageBuildProjection(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must contain an object`);
  const projection = { ...value };
  const scripts = projection.scripts;
  if (scripts === undefined) return projection;
  if (!isRecord(scripts)) throw new Error(`${path}.scripts must be an object`);
  const installScripts = Object.fromEntries(
    Object.entries(scripts)
      .filter(([name]) => rootInstallLifecycleScripts.has(name))
      .map(([name, command]) => {
        if (typeof command !== "string") {
          throw new Error(`${path}.scripts.${name} must be a string`);
        }
        return [name, command];
      }),
  );
  if (Object.keys(installScripts).length === 0) delete projection.scripts;
  else projection.scripts = installScripts;
  return projection;
}

export function rootPackageChangeAffectsBuild(before: unknown, after: unknown): boolean {
  return (
    canonicalJson(rootPackageBuildProjection(before, "package.json before change")) !==
    canonicalJson(rootPackageBuildProjection(after, "package.json after change"))
  );
}

function packageNameFromLockIdentifier(identifier: string): string {
  const value = identifier.startsWith("npm:") ? identifier.slice(4) : identifier;
  if (value.startsWith("@")) {
    const slash = value.indexOf("/");
    if (slash === -1) return value;
    const versionSeparator = value.indexOf("@", slash);
    return versionSeparator === -1 ? value : value.slice(0, versionSeparator);
  }
  const versionSeparator = value.indexOf("@");
  return versionSeparator === -1 ? value : value.slice(0, versionSeparator);
}

function projectedWorkspaceLockEntry(
  value: unknown,
  path: string,
): {
  readonly dependencyNames: readonly string[];
  readonly value: Record<string, unknown>;
} {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const projection: Record<string, unknown> = {};
  for (const section of productionDependencySections) {
    const dependencies = value[section];
    if (dependencies === undefined) continue;
    if (!isRecord(dependencies)) throw new Error(`${path}.${section} must be an object`);
    projection[section] = dependencies;
  }

  const devDependencies = value.devDependencies;
  if (devDependencies !== undefined) {
    if (!isRecord(devDependencies)) throw new Error(`${path}.devDependencies must be an object`);
    projection.devDependencies = Object.fromEntries(
      Object.entries(devDependencies).filter(
        ([name]) => !nonBuildDevDependencies.has(name),
      ),
    );
  }

  return {
    dependencyNames: parseBuildDependencyNames(projection, path),
    value: projection,
  };
}

function lockPackageDependencyNames(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  const metadata: unknown = (value as readonly unknown[])[2];
  if (metadata === undefined || metadata === "") return [];
  if (!isRecord(metadata)) throw new Error(`${path}[2] must be an object`);
  return parseBuildDependencyNames(metadata, `${path}[2]`);
}

function lockProjection(
  content: string,
  relevantRoots: readonly string[],
  path: string,
): unknown {
  const parsed: unknown = Bun.JSONC.parse(content);
  if (!isRecord(parsed)) throw new Error(`${path} must contain an object`);
  const workspaces = parsed.workspaces;
  const packages = parsed.packages;
  if (!isRecord(workspaces)) throw new Error(`${path}.workspaces must be an object`);
  if (!isRecord(packages)) throw new Error(`${path}.packages must be an object`);

  const projectedWorkspaces: Record<string, unknown> = {};
  const pendingPackageNames: string[] = [];
  for (const root of relevantRoots) {
    const workspace = projectedWorkspaceLockEntry(
      workspaces[root],
      `${path}.workspaces.${root}`,
    );
    projectedWorkspaces[root] = workspace.value;
    pendingPackageNames.push(...workspace.dependencyNames);
  }

  const packageEntriesByName = new Map<string, Array<readonly [string, unknown]>>();
  for (const [key, value] of Object.entries(packages)) {
    const names = new Set([packageNameFromLockIdentifier(key)]);
    if (Array.isArray(value) && typeof value[0] === "string") {
      names.add(packageNameFromLockIdentifier(value[0]));
    }
    for (const name of names) {
      const entries = packageEntriesByName.get(name) ?? [];
      entries.push([key, value]);
      packageEntriesByName.set(name, entries);
    }
  }

  const projectedPackages: Record<string, unknown> = {};
  const visitedPackageNames = new Set<string>();
  while (pendingPackageNames.length > 0) {
    const name = pendingPackageNames.pop();
    if (name === undefined || visitedPackageNames.has(name)) continue;
    visitedPackageNames.add(name);
    for (const [key, value] of packageEntriesByName.get(name) ?? []) {
      if (!(key in projectedPackages)) {
        projectedPackages[key] = value;
        pendingPackageNames.push(
          ...lockPackageDependencyNames(value, `${path}.packages.${key}`),
        );
      }
    }
  }

  return {
    packages: projectedPackages,
    unresolvedPackageNames: [...visitedPackageNames]
      .filter((name) => !packageEntriesByName.has(name))
      .sort(),
    workspaces: projectedWorkspaces,
  };
}

export function bunLockChangeAffectsWorkspace(
  before: string,
  after: string,
  targetWorkspace: string,
  workspaces: readonly WorkspaceDeploymentNode[],
): boolean {
  const relevantNames = relevantWorkspaceNames(targetWorkspace, workspaces);
  if (relevantNames === undefined) {
    throw new Error(`workspace ${targetWorkspace} is missing from the repository graph`);
  }
  const workspaceByName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const relevantRoots = [...relevantNames]
    .map((name) => workspaceByName.get(name))
    .filter((workspace): workspace is WorkspaceDeploymentNode => workspace !== undefined)
    .map((workspace) => normalizeRepositoryPath(workspace.rootDirectory))
    .sort();

  return (
    canonicalJson(lockProjection(before, relevantRoots, "bun.lock before change")) !==
    canonicalJson(lockProjection(after, relevantRoots, "bun.lock after change"))
  );
}

async function readWorkspaceGraph(root: string): Promise<readonly WorkspaceDeploymentNode[]> {
  const workspaces: WorkspaceDeploymentNode[] = [];
  const names = new Set<string>();
  for (const manifestPath of await collectWorkspaceManifestPaths(root)) {
    const raw: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    if (!isRecord(raw) || typeof raw.name !== "string" || raw.name.length === 0) {
      throw new Error(`${relative(root, manifestPath)} must contain a non-empty package name`);
    }
    if (names.has(raw.name)) throw new Error(`duplicate workspace name ${raw.name}`);
    names.add(raw.name);
    workspaces.push({
      dependencies: parseBuildDependencyNames(raw, relative(root, manifestPath)),
      name: raw.name,
      rootDirectory: normalizeRepositoryPath(relative(root, dirname(manifestPath))),
    });
  }
  return workspaces;
}

function parseCliOptions(arguments_: readonly string[]): CliOptions {
  const options: CliOptions = { head: process.env.VERCEL_GIT_COMMIT_SHA?.trim() || "HEAD" };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (argument === "--workspace" || argument === "--base" || argument === "--head") {
      if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (argument === "--workspace") options.workspace = value;
      else if (argument === "--base") options.base = value;
      else options.head = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument ${argument ?? ""}`);
  }
  return options;
}

function gitRefExists(root: string, ref: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${ref}^{commit}`], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function fetchExactCommit(root: string, ref: string): void {
  execFileSync("git", ["fetch", "--no-tags", "--depth=1", "origin", ref], {
    cwd: root,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: "ignore",
    timeout: 20_000,
  });
}

export function ensureComparisonCommit(ref: string, recovery: GitCommitRecovery): boolean {
  if (recovery.hasCommit(ref)) return true;
  if (!exactCommitPattern.test(ref)) return false;
  try {
    recovery.fetchExactCommit(ref);
  } catch {
    return false;
  }
  return recovery.hasCommit(ref);
}

export function parseGitNameStatus(output: string): readonly string[] {
  const tokens = output.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const paths: string[] = [];
  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index];
    if (status === undefined || !/^(?:[ACDMTUXB]|[RC][0-9]{1,3})$/u.test(status)) {
      throw new Error("git diff returned an invalid name-status record");
    }
    index += 1;
    const pathCount = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    for (let pathIndex = 0; pathIndex < pathCount; pathIndex += 1) {
      const path = tokens[index];
      if (path === undefined || path.length === 0) {
        throw new Error("git diff returned a truncated name-status record");
      }
      paths.push(path);
      index += 1;
    }
  }
  return [...new Set(paths)];
}

function changedPathsBetween(root: string, base: string, head: string): readonly string[] {
  const output = execFileSync(
    "git",
    ["diff", "--name-status", "-z", "--diff-filter=ACDMRTUXB", base, head, "--"],
    { cwd: root, encoding: "utf8" },
  );
  return parseGitNameStatus(output);
}

function gitFileContent(root: string, ref: string, path: string): string {
  return execFileSync("git", ["show", `${ref}:${path}`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function workspaceManifestCanExplainLockChange(path: string): boolean {
  return workspaceManifestPattern.test(path);
}

export function hasBoundedWorkspaceLockExplanation(changedPaths: readonly string[]): boolean {
  const changedWorkspaceManifests = changedPaths.filter(
    (path) => path !== "package.json" && path.endsWith("/package.json"),
  );
  return (
    changedWorkspaceManifests.length > 0 &&
    changedWorkspaceManifests.every(workspaceManifestCanExplainLockChange)
  );
}

function targetScopedGlobalInputs(
  root: string,
  base: string,
  head: string,
  targetWorkspace: string,
  changedPaths: readonly string[],
  workspaces: readonly WorkspaceDeploymentNode[],
): ReadonlySet<string> {
  const globalInputs = new Set<string>();
  if (changedPaths.includes("package.json")) {
    const before: unknown = JSON.parse(gitFileContent(root, base, "package.json"));
    const after: unknown = JSON.parse(gitFileContent(root, head, "package.json"));
    if (rootPackageChangeAffectsBuild(before, after)) globalInputs.add("package.json");
  }

  if (changedPaths.includes("bun.lock")) {
    if (
      !hasBoundedWorkspaceLockExplanation(changedPaths) ||
      bunLockChangeAffectsWorkspace(
        gitFileContent(root, base, "bun.lock"),
        gitFileContent(root, head, "bun.lock"),
        targetWorkspace,
        workspaces,
      )
    ) {
      globalInputs.add("bun.lock");
    }
  }
  return globalInputs;
}

function logDecision(workspace: string, decision: DeploymentDecision): void {
  console.log(`[vercel-deploy-gate] ${decision.action} ${workspace}: ${decision.reason}`);
  if (decision.matchedPaths.length > 0) {
    console.log(`[vercel-deploy-gate] matched ${decision.matchedPaths.join(", ")}`);
  }
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseCliOptions(process.argv.slice(2));
  } catch (error) {
    console.error(`[vercel-deploy-gate] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  if (options.workspace === undefined) {
    console.error("[vercel-deploy-gate] --workspace is required; proceeding with the build");
    process.exitCode = 1;
    return;
  }

  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const previousDeployment = process.env.VERCEL_GIT_PREVIOUS_SHA?.trim();
  const base = options.base ?? previousDeployment;
  if (base === undefined || base.length === 0) {
    if (process.env.VERCEL === "1") {
      logDecision(options.workspace, {
        action: "build",
        matchedPaths: [],
        reason: "this branch has no previous successful deployment",
      });
      process.exitCode = 1;
      return;
    }
    options.base = "HEAD^";
  }
  const resolvedBase = options.base ?? base;
  if (
    resolvedBase === undefined ||
    !ensureComparisonCommit(resolvedBase, {
      fetchExactCommit: (ref) => fetchExactCommit(root, ref),
      hasCommit: (ref) => gitRefExists(root, ref),
    }) ||
    !gitRefExists(root, options.head)
  ) {
    logDecision(options.workspace, {
      action: "build",
      matchedPaths: [],
      reason: "the comparison commit is unavailable in the shallow clone",
    });
    process.exitCode = 1;
    return;
  }

  try {
    const changedPaths = changedPathsBetween(root, resolvedBase, options.head);
    const workspaces = await readWorkspaceGraph(root);
    const decision = decideVercelDeployment(
      options.workspace,
      changedPaths,
      workspaces,
      targetScopedGlobalInputs(
        root,
        resolvedBase,
        options.head,
        options.workspace,
        changedPaths,
        workspaces,
      ),
    );
    logDecision(options.workspace, decision);
    process.exitCode = decision.action === "build" ? 1 : 0;
  } catch (error) {
    console.error(
      `[vercel-deploy-gate] unable to evaluate changes; proceeding with the build: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
