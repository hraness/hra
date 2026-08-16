import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { collectPublicBoundaryEntries } from "./check-public-boundary";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifestPath = "scripts/public-tree.manifest.json";

export interface PublicTreeManifest {
  readonly paths: readonly string[];
  readonly version: 1;
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function createPublicTreeManifest(
  paths: readonly string[],
): PublicTreeManifest {
  return {
    paths: [...new Set(paths)].toSorted(comparePath),
    version: 1,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePublicTreeManifest(value: unknown): PublicTreeManifest {
  if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["paths"])) {
    throw new Error("manifest must be a version 1 object with paths");
  }
  if (!value["paths"].every((path): path is string =>
    typeof path === "string"
    && path.length > 0
    && !path.startsWith("/")
    && !path.split("/").includes(".."))) {
    throw new Error("manifest paths must be normalized repository-relative strings");
  }
  const canonical = createPublicTreeManifest(value["paths"]);
  if (JSON.stringify(canonical.paths) !== JSON.stringify(value["paths"])) {
    throw new Error("manifest paths must be unique and byte-order sorted");
  }
  return canonical;
}

export function publicTreeManifestErrors(
  actualPaths: readonly string[],
  expected: PublicTreeManifest,
): readonly string[] {
  const errors: string[] = [];
  const actual = new Set(actualPaths);
  const expectedPaths = new Set(expected.paths);
  for (const path of [...actual].toSorted(comparePath)) {
    if (!expectedPaths.has(path)) errors.push(`${path}: path is not in the public tree manifest`);
  }
  for (const path of expected.paths) {
    if (!actual.has(path)) errors.push(`${manifestPath}: stale path ${path}`);
  }
  return errors;
}

async function main(): Promise<void> {
  const write = process.argv.length === 3 && process.argv[2] === "--write";
  if (!write && process.argv.length !== 2) {
    throw new Error("Usage: bun run check:public-tree [--write]");
  }
  const entries = await collectPublicBoundaryEntries(repositoryRoot);
  const actualPaths = entries.flatMap(({ kind, path }) =>
    kind === "file" ? [path] : []);
  const actual = createPublicTreeManifest(actualPaths);
  if (write) {
    await writeFile(
      resolve(repositoryRoot, manifestPath),
      `${JSON.stringify(actual, undefined, 2)}\n`,
      "utf8",
    );
    console.log(`Wrote ${actual.paths.length} public source paths.`);
    return;
  }
  let expected: PublicTreeManifest;
  try {
    expected = parsePublicTreeManifest(
      JSON.parse(await readFile(resolve(repositoryRoot, manifestPath), "utf8")) as unknown,
    );
  } catch (error) {
    console.error(
      `- ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return;
  }
  const errors = publicTreeManifestErrors(actual.paths, expected);
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Public tree manifest clean: ${actual.paths.length} files.`);
}

if (import.meta.main) await main();
