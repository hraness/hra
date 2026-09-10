import assert from "node:assert/strict";

export const APP_SOURCE_MARKER_PATH = ".well-known/oompa-app.json";
const exactGitCommitPattern = /^[0-9a-f]{40}$/u;
const packageVersionPattern = /^0\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;

export type AppSourceMarker = Readonly<{
  generation: 1;
  product: "Oompa App";
  repository: Readonly<{ id: 1343008607; path: "hraness/oompa" }>;
  schemaVersion: 1;
  source: Readonly<{ commit: string }>;
  version: string;
}>;

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), "Expected an app source-marker object");
  assert.ok(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), "Unexpected app source-marker fields");
}

function version(value: unknown): string {
  assert.ok(typeof value === "string" && packageVersionPattern.test(value), "The Oompa app package version is invalid.");
  return value;
}

/** Preserve the deployment source contract independently of compiler receipts. */
export function resolveAppSourceCommit(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  if (environment.VERCEL === "1") {
    const commit = environment.VERCEL_GIT_COMMIT_SHA;
    assert.ok(commit !== undefined && exactGitCommitPattern.test(commit), "A Vercel app build requires an exact source commit marker.");
    return commit;
  }
  const commit = environment.VERCEL_GIT_COMMIT_SHA ?? environment.OOMPA_RELEASE_COMMIT;
  if (commit === undefined) return "local";
  assert.ok(exactGitCommitPattern.test(commit), "An app build source commit must be a lowercase 40-character Git SHA.");
  return commit;
}

export function createAppSourceMarker(
  manifest: unknown,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const metadata = record(manifest);
  const marker: AppSourceMarker = {
    generation: 1,
    product: "Oompa App",
    repository: { id: 1343008607, path: "hraness/oompa" },
    schemaVersion: 1,
    source: { commit: resolveAppSourceCommit(environment) },
    version: version(metadata.version),
  };
  return `${JSON.stringify(marker, null, 2)}\n`;
}

/** This validates only the public app marker, never arbitrary JSON output. */
export function parseAppSourceMarker(value: unknown): AppSourceMarker {
  const marker = record(value);
  exactKeys(marker, ["generation", "product", "repository", "schemaVersion", "source", "version"]);
  assert.equal(marker.generation, 1);
  assert.equal(marker.product, "Oompa App");
  assert.equal(marker.schemaVersion, 1);
  const repository = record(marker.repository);
  exactKeys(repository, ["id", "path"]);
  assert.equal(repository.id, 1343008607);
  assert.equal(repository.path, "hraness/oompa");
  const source = record(marker.source);
  exactKeys(source, ["commit"]);
  assert.ok(typeof source.commit === "string" && (source.commit === "local" || exactGitCommitPattern.test(source.commit)), "Invalid app source commit");
  return {
    generation: 1,
    product: "Oompa App",
    repository: { id: 1343008607, path: "hraness/oompa" },
    schemaVersion: 1,
    source: { commit: source.commit },
    version: version(marker.version),
  };
}
