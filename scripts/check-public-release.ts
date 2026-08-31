import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  assertReleaseAssetBytes,
  npmRegistryReleaseMetadata,
  parseGitHubRelease,
  parseNpmRelease,
  publicPackageName,
  publicRepository,
} from "./release-distribution-policy";
import { assertReleasePackageReady } from "./release-package-policy";
import { verifyNpmProvenance } from "./verify-npm-provenance";

const maximumJsonBytes = 512 * 1024;
const maximumArtifactBytes = 64 * 1024 * 1024;

function environment(name: string, pattern?: RegExp): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0 || (pattern !== undefined && !pattern.test(value))) {
    throw new Error(`Public release admission requires a valid ${name}.`);
  }
  return value;
}

async function boundedBytes(response: Response, label: string, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > maximum)) {
    throw new Error(`${label} exceeds its declared byte bound.`);
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error(`${label} has no body.`);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maximum) throw new Error(`${label} exceeds its byte bound.`);
      chunks.push(item.value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* the bounded result remains authoritative */ }
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function json(url: string, label: string, token?: string): Promise<unknown> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github+json",
      "Cache-Control": "no-cache",
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      "User-Agent": "hra-release-admission",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status !== 200) throw new Error(`${label} returned HTTP ${String(response.status)}.`);
  const bytes = await boundedBytes(response, label, maximumJsonBytes);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error(`${label} returned malformed JSON.`);
  }
}

async function artifact(url: string, label: string): Promise<Uint8Array> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache", "User-Agent": "hra-release-admission" },
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  if (response.status !== 200) throw new Error(`${label} returned HTTP ${String(response.status)}.`);
  return boundedBytes(response, label, maximumArtifactBytes);
}

async function npmMetadata(
  url: string,
  label: string,
  version: string,
  endpoint: "latest" | "version",
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-cache",
      "User-Agent": "hra-release-admission",
    },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const metadata: Record<string, unknown> | null = await npmRegistryReleaseMetadata(
    response,
    version,
    endpoint,
  );
  if (metadata === null) throw new Error(`${label} is absent.`);
  return metadata;
}

if (environment("GITHUB_REPOSITORY") !== publicRepository) {
  throw new Error(`Public release admission must run in ${publicRepository}.`);
}
const token = environment("GITHUB_TOKEN");
const verifiedSha = environment("VERIFIED_SHA", /^[0-9a-f]{40}$/u);
const verifiedTagObject = environment("VERIFIED_TAG_OBJECT", /^[0-9a-f]{40}$/u);
const verifiedTag = environment("VERIFIED_TAG", /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u);
const runId = environment("GITHUB_RUN_ID", /^[1-9][0-9]*$/u);
const runAttempt = environment("GITHUB_RUN_ATTEMPT", /^[1-9][0-9]*$/u);
const preflightState = environment("HRA_NPM_PREFLIGHT_STATE", /^(?:absent|exact)$/u);
const preflightRunId = environment("HRA_NPM_PREFLIGHT_RUN_ID", /^[1-9][0-9]*$/u);
const preflightRunAttempt = environment("HRA_NPM_PREFLIGHT_RUN_ATTEMPT", /^[1-9][0-9]*$/u);
if (preflightRunId !== runId || BigInt(preflightRunAttempt) > BigInt(runAttempt)) {
  throw new Error("Public release admission requires this run's bounded npm preflight observation.");
}
const manifest = JSON.parse(await readFile(resolve(import.meta.dir, "..", "package.json"), "utf8")) as unknown;
const inspection = assertReleasePackageReady(manifest);
if (verifiedTag !== `v${inspection.version}`) throw new Error("Release tag and package version do not agree.");

const registry = `https://registry.npmjs.org/${encodeURIComponent(publicPackageName)}`;
const npmRelease = parseNpmRelease(
  await npmMetadata(
    `${registry}/${encodeURIComponent(inspection.version)}`,
    "npm exact release",
    inspection.version,
    "version",
  ),
  inspection.version,
);
const npmLatest = parseNpmRelease(await npmMetadata(
  `${registry}/latest`,
  "npm latest release",
  inspection.version,
  "latest",
), inspection.version);
if (npmLatest.integrity !== npmRelease.integrity || npmLatest.shasum !== npmRelease.shasum) {
  throw new Error("npm latest does not resolve to the exact admitted version.");
}
const npmBytes = await artifact(npmRelease.tarball, "npm release tarball");
if (
  `sha512-${createHash("sha512").update(npmBytes).digest("base64")}` !== npmRelease.integrity
  || createHash("sha1").update(npmBytes).digest("hex") !== npmRelease.shasum
) throw new Error("npm release bytes do not match registry integrity metadata.");
const tufCachePath = await mkdtemp(`${tmpdir()}/hra-sigstore-tuf-`);
try {
  const attestationsUrl = `https://registry.npmjs.org/-/npm/v1/attestations/@hraness%2fhra@${inspection.version}`;
  await verifyNpmProvenance({
    attemptPolicy: "same_run_not_later",
    attestations: await json(attestationsUrl, "npm Sigstore attestations"),
    integrity: npmRelease.integrity,
    maximumAttempt: preflightState === "exact" ? preflightRunAttempt : runAttempt,
    registryKeys: await json("https://registry.npmjs.org/-/npm/v1/keys", "npm registry keys"),
    runAttempt,
    runId,
    sha: verifiedSha,
    tag: verifiedTag,
    tufCachePath,
  });
} finally {
  await rm(tufCachePath, { force: true, recursive: true });
}

const api = `https://api.github.com/repos/${publicRepository}`;
const tagRef = await json(`${api}/git/ref/tags/${verifiedTag}`, "GitHub annotated tag ref", token) as {
  object?: { sha?: unknown; type?: unknown; url?: unknown };
};
if (
  tagRef.object?.type !== "tag"
  || tagRef.object.sha !== verifiedTagObject
  || tagRef.object.url !== `${api}/git/tags/${verifiedTagObject}`
) throw new Error("GitHub release ref is not the verified annotated tag object.");
const tag = await json(`${api}/git/tags/${verifiedTagObject}`, "GitHub annotated tag", token) as {
  object?: { sha?: unknown; type?: unknown };
  tag?: unknown;
};
if (tag.tag !== verifiedTag || tag.object?.type !== "commit" || tag.object.sha !== verifiedSha) {
  throw new Error("GitHub annotated tag does not target the verified release commit.");
}
const release = parseGitHubRelease(
  await json(`${api}/releases/tags/${verifiedTag}`, "GitHub Release", token),
  inspection.version,
);
const [githubTarball, githubChecksum] = await Promise.all([
  artifact(release.tarball.browserDownloadUrl, "GitHub Release tarball"),
  artifact(release.checksum.browserDownloadUrl, "GitHub Release checksum"),
]);
assertReleaseAssetBytes(
  release,
  githubTarball,
  githubChecksum,
  (bytes) => createHash("sha256").update(bytes).digest("hex"),
);
if (!Buffer.from(githubTarball).equals(Buffer.from(npmBytes))) {
  throw new Error("npm and GitHub do not expose the same exact release tarball bytes.");
}
console.log(`Public release admission passed for ${inspection.name}@${inspection.version}.`);
