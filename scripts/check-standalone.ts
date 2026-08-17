import { lstat, readFile, readlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const provenanceExceptions = new Set([
  "hra-legacy-identifiers.manifest.json",
]);
const excludedWorkspaceNames = new Set([
  "@hra-internal/identity",
  "@hra-internal/suite-accounts",
]);

const forbiddenPatterns = [
  {
    label: "private monorepo package import",
    pattern: new RegExp(["@jun", "gle(?:/|\\\\/)"].join(""), "gu"),
  },
  {
    label: "former monorepo product path",
    pattern: new RegExp(["pro", "jects/", "(?:op", "rte|hra)(?:/|\\b)"].join(""), "giu"),
  },
  {
    label: "developer-specific former checkout path",
    pattern: new RegExp(
      ["/(?:Users/[^/]+/Documents|private/tmp)/", "jun", "gle(?:[-/]|\\b)"].join(""),
      "giu",
    ),
  },
  {
    label: "former repository identity assumption",
    pattern: new RegExp(
      ["\\bJun", "gle (?:monorepo|repository|workspace|checkout|root)\\b"].join(""),
      "gu",
    ),
  },
  {
    label: "former monorepo environment authority",
    pattern: new RegExp(["\\b(?:NEXT_PUBLIC_)?JUN", "GLE_"].join(""), "gu"),
  },
] as const;

const deepSharedPathPattern = new RegExp(
  ["(?:\\.\\./){4,}", "(?:packages|scripts)(?:/[^'\"`\\s]*)?"].join(""),
  "gu",
);

function containsEscapingSharedPath(path: string, source: string): boolean {
  deepSharedPathPattern.lastIndex = 0;
  for (const match of source.matchAll(deepSharedPathPattern)) {
    const target = resolve(repositoryRoot, dirname(path), match[0]);
    const fromRoot = relative(repositoryRoot, target);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      return true;
    }
  }
  return false;
}

export interface RepositorySource {
  readonly path: string;
  readonly source: string;
}

export function standaloneSourceErrors(
  sources: readonly RepositorySource[],
): readonly string[] {
  const errors: string[] = [];
  for (const { path, source } of sources.toSorted((left, right) =>
    left.path.localeCompare(right.path))) {
    if (provenanceExceptions.has(path)) continue;
    if (containsEscapingSharedPath(path, source)) {
      errors.push(`${path}: contains former monorepo-depth relative path`);
    }
    for (const { label, pattern } of forbiddenPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(source)) errors.push(`${path}: contains ${label}`);
    }
  }
  return errors;
}

export interface PackageRecord {
  readonly path: string;
  readonly value: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dependencyEntries(
  packageValue: Record<string, unknown>,
): readonly [string, string][] {
  const entries: [string, string][] = [];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const value = packageValue[field];
    if (!isRecord(value)) continue;
    for (const [name, version] of Object.entries(value)) {
      if (typeof version === "string") entries.push([name, version]);
    }
  }
  return entries;
}

export function standalonePackageErrors(
  packages: readonly PackageRecord[],
): readonly string[] {
  const errors: string[] = [];
  const packageNames = new Set<string>();
  let rootPackage: Record<string, unknown> | undefined;

  for (const record of packages) {
    if (!isRecord(record.value)) {
      errors.push(`${record.path}: package.json root must be an object`);
      continue;
    }
    const name = record.value["name"];
    if (typeof name !== "string" || name.length === 0) {
      errors.push(`${record.path}: package name is missing`);
      continue;
    }
    if (packageNames.has(name)) errors.push(`${record.path}: duplicate package name ${name}`);
    if (record.path !== "package.json" && excludedWorkspaceNames.has(name)) {
      errors.push(`${record.path}: excluded workspace ${name} is present`);
    }
    packageNames.add(name);
    if (record.path === "package.json") rootPackage = record.value;
  }

  if (rootPackage === undefined) {
    errors.push("package.json: standalone root package is missing");
    return errors;
  }
  const workspaces = rootPackage["workspaces"];
  const catalog = isRecord(workspaces) && isRecord(workspaces["catalog"])
    ? workspaces["catalog"]
    : undefined;
  if (catalog === undefined) {
    errors.push("package.json: workspaces.catalog is missing");
    return errors;
  }

  for (const record of packages) {
    if (!isRecord(record.value)) continue;
    for (const [name, version] of dependencyEntries(record.value)) {
      if (version.startsWith("workspace:") && !packageNames.has(name)) {
        errors.push(`${record.path}: ${name} uses ${version} but is not a workspace`);
      }
      if (version.startsWith("workspace:") && excludedWorkspaceNames.has(name)) {
        errors.push(`${record.path}: ${name} must not use the workspace protocol`);
      }
      if (version.startsWith("catalog:") && !(name in catalog)) {
        errors.push(`${record.path}: ${name} uses catalog: but is absent from workspaces.catalog`);
      }
    }
  }
  return errors;
}

function listRepositoryPaths(): readonly string[] {
  const result = Bun.spawnSync(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `git ls-files failed: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`,
    );
  }
  return result.stdout.toString().split("\0").filter(Boolean);
}

function missing(error: unknown): boolean {
  return isRecord(error) && error["code"] === "ENOENT";
}

async function readSources(paths: readonly string[]): Promise<readonly RepositorySource[]> {
  const sources: RepositorySource[] = [];
  for (const path of paths) {
    try {
      const absolutePath = resolve(repositoryRoot, path);
      const status = await lstat(absolutePath);
      if (status.isDirectory()) continue;
      if (status.isSymbolicLink()) {
        sources.push({ path, source: await readlink(absolutePath) });
        continue;
      }
      const bytes = await readFile(absolutePath);
      if (!bytes.includes(0)) sources.push({ path, source: bytes.toString("utf8") });
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  return sources;
}

async function readPackages(paths: readonly string[]): Promise<readonly PackageRecord[]> {
  const packages: PackageRecord[] = [];
  for (const path of paths.filter((candidate) => candidate === "package.json" || candidate.endsWith("/package.json"))) {
    try {
      const source = await readFile(resolve(repositoryRoot, path), "utf8");
      packages.push({ path, value: JSON.parse(source) as unknown });
    } catch (error) {
      if (missing(error)) continue;
      packages.push({ path, value: null });
    }
  }
  return packages;
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error("Usage: bun run check:standalone");
  const paths = listRepositoryPaths();
  const [sources, packages] = await Promise.all([readSources(paths), readPackages(paths)]);
  const errors = [
    ...standaloneSourceErrors(sources),
    ...standalonePackageErrors(packages),
  ];
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Standalone boundary clean across ${sources.length} text files and ${packages.length} packages.`);
}

if (import.meta.main) await main();
