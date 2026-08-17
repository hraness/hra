import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const legacyManifestPath = "hra-legacy-identifiers.manifest.json";
const joinLiteral = (...parts: readonly string[]): string => parts.join("");

const ignoredDirectoryNames = new Set([".git", ".zig-cache", "node_modules"]);
const ignoredGeneratedFilePattern = /\.tsbuildinfo$/u;
const forbiddenExactPaths = new Set([
  joinLiteral(".public-", "bootstrap"),
  joinLiteral(".github/workflows/hra-", "preview-release.yml"),
  joinLiteral(".github/workflows/hra-", "release.yml"),
  "OPERATIONS.md",
  "THREAT_MODEL.md",
  joinLiteral("docs/migration-", "inventory.md"),
  joinLiteral("public-source-", "inventory.json"),
  joinLiteral("release-", "authority.json"),
  joinLiteral("scripts/check-legacy-", "identifiers.test.ts"),
  joinLiteral("scripts/check-legacy-", "identifiers.ts"),
  joinLiteral("scripts/check-public-source-", "inventory.test.ts"),
  joinLiteral("scripts/check-public-source-", "inventory.ts"),
  joinLiteral("scripts/check-release-", "authority.test.ts"),
  joinLiteral("scripts/check-release-", "authority.ts"),
]);
const forbiddenPathPrefixes = [
  joinLiteral(".public-", "bootstrap/"),
  joinLiteral("packages/codex-", "app-sdk/"),
  joinLiteral("packages/internal/", "identity/"),
  joinLiteral("packages/internal/", "suite-accounts/"),
] as const;
const forbiddenPackageFiles = new Set([
  joinLiteral("packages/internal/convex/src/vercel-", "build.property.test.ts"),
  joinLiteral("packages/internal/convex/src/vercel-", "build.test.ts"),
  joinLiteral("packages/internal/convex/src/vercel-", "build.ts"),
  joinLiteral("packages/internal/design-kit/src/next-", "config.test.ts"),
  joinLiteral("packages/internal/design-kit/src/next-", "config.ts"),
]);
const forbiddenPrivateOperationBasenames = new Set([
  joinLiteral("notarize-", "macos.ts"),
  joinLiteral("publish-preview-", "release.ts"),
  joinLiteral("publish-stable-", "release.ts"),
  joinLiteral("sign-", "macos.ts"),
  joinLiteral("stable-release-", "authority.ts"),
  joinLiteral("stable-release-", "publisher.ts"),
  joinLiteral("preview-release-", "publisher.ts"),
  joinLiteral("preview-blob-", "store.ts"),
]);
const buildOutputPattern =
  /(?:^|\/)(?:(?:\.next|\.turbo|\.zig-cache|build|coverage|dist|out|target)(?:\/|$)|[^/]+\.tsbuildinfo$)/u;
const privateEnvironmentFilePattern = /(?:^|\/)\.env(?:\.[^/]+)?$/u;
const allowedEnvironmentFilePattern = /(?:^|\/)\.env\.(?:example|sample)$/u;
const providerIdentifierPattern = /\b(?:dpl|prj|team)_[A-Za-z0-9]{8,}\b/gu;
const numericRepositoryIdentifierPattern =
  /(?:repository(?:Id|_id)|repository ID)[^\n]{0,24}\b\d{8,}\b/giu;
const githubSecretPattern = /\bsecrets\.[A-Z0-9_]+\b/gu;
const privateUserPathPattern = /\/Users\/([^/\s"'`]+)\//gu;
const placeholderUserNames = new Set([
  "alice",
  "example",
  "local",
  "oprte",
  "person",
  "private",
  "private-person",
  "runner",
  "test",
  "user",
]);
const formerWorkspaceWord = joinLiteral("jun", "gle");
const allowedFormerWorkspaceCompatibilityPattern = new RegExp(
  `(?:${formerWorkspaceWord}-[a-z0-9_-]*|com\\.${formerWorkspaceWord}\\.(?:oprte|kitchen|taskctl))`,
  "giu",
);
const formerWorkspaceLabelPattern = new RegExp(`\\b${formerWorkspaceWord}\\b`, "giu");
const formerWorkspaceEnvironmentPattern = new RegExp(
  `\\b(?:NEXT_PUBLIC_)?${formerWorkspaceWord.toUpperCase()}_`,
  "gu",
);
const forbiddenCredentialNames = [
  joinLiteral("APPLE_", "ID"),
  joinLiteral("APPLE_TEAM_", "ID"),
  joinLiteral("APPLE_APP_SPECIFIC_", "PASSWORD"),
  joinLiteral("BLOB_READ_", "WRITE_TOKEN"),
  joinLiteral("CONVEX_DEPLOY_", "KEY"),
  joinLiteral("CONVEX_DEPLOYMENT_", "TOKEN"),
  joinLiteral("SPARKLE_PRIVATE_", "KEY"),
  joinLiteral("VERCEL_", "TOKEN"),
] as const;
const forbiddenCredentialPattern = new RegExp(
  `\\b(?:${forbiddenCredentialNames.join("|")})\\b`,
  "gu",
);
const forbiddenSourceLiterals = [
  {
    label: "bootstrap source path",
    value: joinLiteral(".public-", "bootstrap"),
  },
  {
    label: "private operations repository",
    value: joinLiteral("hraness/hra-", "ops"),
  },
  {
    label: "private release authority",
    value: joinLiteral("release-", "authority.json"),
  },
  {
    label: "private source inventory",
    value: joinLiteral("public-source-", "inventory.json"),
  },
] as const;
const legacyExcludedPaths = new Set([
  legacyManifestPath,
  "scripts/check-public-boundary.test.ts",
  "scripts/check-public-boundary.ts",
  "scripts/public-tree.manifest.json",
]);

export type PublicEntryKind = "directory" | "file" | "special" | "symlink";

export interface PublicBoundaryEntry {
  readonly kind: PublicEntryKind;
  readonly path: string;
  readonly source?: string;
}

export interface RepositorySource {
  readonly path: string;
  readonly source: string;
}

export interface LegacyEntry {
  readonly category: "compatibility";
  readonly matchingLinesSha256: string;
  readonly occurrences: Readonly<{
    kitchen: number;
    operateStylized: number;
    oprte: number;
  }>;
  readonly path: string;
}

export interface LegacyManifest {
  readonly entries: readonly LegacyEntry[];
  readonly version: 1;
}

function comparePaths(
  left: Readonly<{ path: string }>,
  right: Readonly<{ path: string }>,
): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function basename(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? path : path.slice(separator + 1);
}

function hasForbiddenPathPrefix(path: string): boolean {
  return forbiddenPathPrefixes.some((prefix) =>
    path === prefix.slice(0, -1) || path.startsWith(prefix));
}

function forbiddenPathError(entry: PublicBoundaryEntry): string | undefined {
  if (entry.path.startsWith("/") || entry.path.split("/").includes("..")) {
    return `${entry.path}: repository path must be normalized and relative`;
  }
  if (
    forbiddenExactPaths.has(entry.path)
    || forbiddenPackageFiles.has(entry.path)
    || hasForbiddenPathPrefix(entry.path)
  ) {
    return `${entry.path}: excluded private path is present`;
  }
  if (forbiddenPrivateOperationBasenames.has(basename(entry.path))) {
    return `${entry.path}: private release operation is present`;
  }
  if (buildOutputPattern.test(entry.path)) {
    return `${entry.path}: generated build output is present`;
  }
  if (
    privateEnvironmentFilePattern.test(entry.path)
    && !allowedEnvironmentFilePattern.test(entry.path)
  ) {
    return `${entry.path}: private environment file is present`;
  }
  if (entry.path.endsWith("/.DS_Store") || entry.path === ".DS_Store") {
    return `${entry.path}: local filesystem metadata is present`;
  }
  return undefined;
}

function hasPrivateUserPath(source: string): boolean {
  privateUserPathPattern.lastIndex = 0;
  for (const match of source.matchAll(privateUserPathPattern)) {
    const userName = match[1]?.toLowerCase();
    if (userName !== undefined && !placeholderUserNames.has(userName)) return true;
  }
  return false;
}

function sourceErrors(path: string, source: string): readonly string[] {
  if (path === legacyManifestPath) return [];
  const errors: string[] = [];
  const withoutCompatibilityTokens = source.replace(
    allowedFormerWorkspaceCompatibilityPattern,
    "",
  );
  formerWorkspaceLabelPattern.lastIndex = 0;
  if (formerWorkspaceLabelPattern.test(withoutCompatibilityTokens)) {
    errors.push(`${path}: contains an unaudited former-workspace label`);
  }
  formerWorkspaceEnvironmentPattern.lastIndex = 0;
  if (formerWorkspaceEnvironmentPattern.test(source)) {
    errors.push(`${path}: contains former-workspace environment authority`);
  }
  providerIdentifierPattern.lastIndex = 0;
  if (providerIdentifierPattern.test(source)) {
    errors.push(`${path}: contains a provider deployment identifier`);
  }
  numericRepositoryIdentifierPattern.lastIndex = 0;
  if (numericRepositoryIdentifierPattern.test(source)) {
    errors.push(`${path}: contains a numeric repository identifier`);
  }
  forbiddenCredentialPattern.lastIndex = 0;
  if (forbiddenCredentialPattern.test(source)) {
    errors.push(`${path}: contains a private provider credential name`);
  }
  githubSecretPattern.lastIndex = 0;
  if (githubSecretPattern.test(source)) {
    errors.push(`${path}: contains a GitHub Actions secret reference`);
  }
  if (hasPrivateUserPath(source)) {
    errors.push(`${path}: contains a developer-specific absolute path`);
  }
  const privateTemporaryRoot = joinLiteral("/private/tmp/hra-public-", "release");
  if (source.includes(privateTemporaryRoot)) {
    errors.push(`${path}: contains a private bootstrap checkout path`);
  }
  for (const literal of forbiddenSourceLiterals) {
    if (source.includes(literal.value)) {
      errors.push(`${path}: contains ${literal.label}`);
    }
  }
  return errors;
}

export function publicBoundaryErrors(
  entries: readonly PublicBoundaryEntry[],
): readonly string[] {
  const errors: string[] = [];
  const paths = new Set<string>();
  for (const entry of entries.toSorted(comparePaths)) {
    if (paths.has(entry.path)) {
      errors.push(`${entry.path}: duplicate repository path`);
      continue;
    }
    paths.add(entry.path);
    const pathError = forbiddenPathError(entry);
    if (pathError !== undefined) errors.push(pathError);
    if (entry.kind === "symlink") {
      errors.push(`${entry.path}: symbolic links are forbidden`);
    } else if (entry.kind === "special") {
      errors.push(`${entry.path}: special files are forbidden`);
    }
    if (entry.source !== undefined) {
      errors.push(...sourceErrors(entry.path, entry.source));
    }
  }
  return errors;
}

function identifierCount(source: string, identifier: "kitchen" | "oprte"): number {
  return [...source.matchAll(new RegExp(identifier, "giu"))].length;
}

export function legacyEntryForSource(
  path: string,
  source: string,
): LegacyEntry | undefined {
  const occurrences = {
    kitchen: identifierCount(source, "kitchen"),
    operateStylized: [...source.matchAll(/OPeRaTE/gu)].length,
    oprte: identifierCount(source, "oprte"),
  } as const;
  if (
    occurrences.kitchen === 0
    && occurrences.operateStylized === 0
    && occurrences.oprte === 0
  ) return undefined;
  const matchingLines = source.replaceAll("\r\n", "\n").split("\n")
    .flatMap((line, index) =>
      /(?:oprte|kitchen)/iu.test(line) || line.includes("OPeRaTE")
        ? [`${index + 1}\0${line}`]
        : []);
  return {
    category: "compatibility",
    matchingLinesSha256: createHash("sha256")
      .update(matchingLines.join("\n"))
      .digest("hex"),
    occurrences,
    path,
  };
}

export function buildLegacyManifest(
  sources: readonly RepositorySource[],
): LegacyManifest {
  return {
    entries: sources
      .filter(({ path }) => !legacyExcludedPaths.has(path))
      .toSorted(comparePaths)
      .flatMap(({ path, source }) => {
        const entry = legacyEntryForSource(path, source);
        return entry === undefined ? [] : [entry];
      }),
    version: 1,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseLegacyManifest(value: unknown): LegacyManifest {
  if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["entries"])) {
    throw new Error("manifest must be a version 1 object with entries");
  }
  const entries: LegacyEntry[] = value["entries"].map((entry, index) => {
    if (
      !isRecord(entry)
      || typeof entry["path"] !== "string"
      || entry["category"] !== "compatibility"
    ) {
      throw new Error(`entry ${index} must describe one compatibility path`);
    }
    const occurrences = entry["occurrences"];
    if (
      !isRecord(occurrences)
      || !Number.isInteger(occurrences["oprte"])
      || !Number.isInteger(occurrences["kitchen"])
      || !Number.isInteger(occurrences["operateStylized"])
      || Number(occurrences["oprte"]) < 0
      || Number(occurrences["kitchen"]) < 0
      || Number(occurrences["operateStylized"]) < 0
      || Number(occurrences["oprte"])
        + Number(occurrences["kitchen"])
        + Number(occurrences["operateStylized"]) < 1
    ) {
      throw new Error(`entry ${index} has invalid occurrence counts`);
    }
    const digest = entry["matchingLinesSha256"];
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) {
      throw new Error(`entry ${index} has an invalid matching-lines digest`);
    }
    return {
      category: "compatibility",
      matchingLinesSha256: digest,
      occurrences: {
        kitchen: Number(occurrences["kitchen"]),
        operateStylized: Number(occurrences["operateStylized"]),
        oprte: Number(occurrences["oprte"]),
      },
      path: entry["path"],
    };
  });
  return { entries, version: 1 };
}

export function validateLegacyManifest(
  actual: LegacyManifest,
  expected: LegacyManifest,
): readonly string[] {
  const errors: string[] = [];
  const expectedPaths = new Set<string>();
  for (const entry of expected.entries) {
    if (expectedPaths.has(entry.path)) {
      errors.push(`${legacyManifestPath}: duplicate ${entry.path}`);
    }
    expectedPaths.add(entry.path);
  }
  const actualJson = new Map(
    actual.entries.map((entry) => [entry.path, JSON.stringify(entry)]),
  );
  const expectedJson = new Map(
    expected.entries.map((entry) => [entry.path, JSON.stringify(entry)]),
  );
  for (const [path, value] of actualJson) {
    if (!expectedJson.has(path)) {
      errors.push(`${path}: legacy identifiers are not audited`);
    } else if (expectedJson.get(path) !== value) {
      errors.push(`${path}: legacy identifier evidence drifted`);
    }
  }
  for (const path of expectedJson.keys()) {
    if (!actualJson.has(path)) errors.push(`${legacyManifestPath}: stale entry for ${path}`);
  }
  return errors;
}

function entryKind(status: Awaited<ReturnType<typeof lstat>>): PublicEntryKind {
  if (status.isDirectory()) return "directory";
  if (status.isFile()) return "file";
  if (status.isSymbolicLink()) return "symlink";
  return "special";
}

export async function collectPublicBoundaryEntries(
  root: string,
): Promise<readonly PublicBoundaryEntry[]> {
  const entries: PublicBoundaryEntry[] = [];
  const visit = async (relativePath: string): Promise<void> => {
    const absolutePath = resolve(root, relativePath);
    const status = await lstat(absolutePath);
    const kind = entryKind(status);
    if (relativePath !== "") {
      if (kind === "symlink") {
        entries.push({ kind, path: relativePath, source: await readlink(absolutePath) });
      } else if (kind === "file") {
        const bytes = await readFile(absolutePath);
        entries.push({
          kind,
          path: relativePath,
          ...(bytes.includes(0) ? {} : { source: bytes.toString("utf8") }),
        });
      } else {
        entries.push({ kind, path: relativePath });
      }
    }
    if (kind !== "directory") return;
    if (
      relativePath !== ""
      && (buildOutputPattern.test(relativePath)
        || forbiddenExactPaths.has(relativePath)
        || hasForbiddenPathPrefix(relativePath))
    ) return;
    for (const child of await readdir(absolutePath, { withFileTypes: true })) {
      if (
        ignoredDirectoryNames.has(child.name)
        || ignoredGeneratedFilePattern.test(child.name)
      ) continue;
      await visit(relativePath === "" ? child.name : `${relativePath}/${child.name}`);
    }
  };
  await visit("");
  return entries.toSorted(comparePaths);
}

async function main(): Promise<void> {
  const writeLegacy = process.argv.length === 3
    && process.argv[2] === "--write-legacy-manifest";
  if (!writeLegacy && process.argv.length !== 2) {
    throw new Error(
      "Usage: bun run check:public-boundary [--write-legacy-manifest]",
    );
  }
  const entries = await collectPublicBoundaryEntries(repositoryRoot);
  const boundaryErrors = publicBoundaryErrors(entries);
  if (boundaryErrors.length > 0) {
    for (const error of boundaryErrors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  const actualLegacy = buildLegacyManifest(
    entries.flatMap(({ path, source }) =>
      source === undefined ? [] : [{ path, source }]),
  );
  if (writeLegacy) {
    await writeFile(
      resolve(repositoryRoot, legacyManifestPath),
      `${JSON.stringify(actualLegacy, undefined, 2)}\n`,
      "utf8",
    );
    console.log(`Wrote ${actualLegacy.entries.length} compatibility entries.`);
    return;
  }
  let expectedLegacy: LegacyManifest;
  try {
    expectedLegacy = parseLegacyManifest(
      JSON.parse(
        await readFile(resolve(repositoryRoot, legacyManifestPath), "utf8"),
      ) as unknown,
    );
  } catch (error) {
    console.error(
      `- ${legacyManifestPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
    return;
  }
  const legacyErrors = validateLegacyManifest(actualLegacy, expectedLegacy);
  if (legacyErrors.length > 0) {
    for (const error of legacyErrors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Public boundary clean across ${entries.length} paths with ${actualLegacy.entries.length} reviewed compatibility files.`,
  );
}

if (import.meta.main) await main();
