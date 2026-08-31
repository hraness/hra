import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { readBoundedJsonResponse } from "./bounded-json-response";
import {
  npmRegistryReleaseMetadata,
  parseNpmRelease,
  type NpmReleaseCoordinate,
} from "./release-distribution-policy";
import {
  decideNpmPublicationTransition,
} from "./npm-publication-transition";
import { assertReleasePackageReady, releaseArchiveName } from "./release-package-policy";
import { verifyNpmProvenance, type NpmProvenanceAttemptPolicy } from "./verify-npm-provenance";

const maximumAttestationBytes = 512 * 1024;

const argument = process.argv[2];
if (argument === undefined) throw new Error("Usage: publish-npm-release.ts ARTIFACT.tgz");
const tarball = resolve(argument);
const bytes = await readFile(tarball);
const manifest = JSON.parse(await readFile(resolve(import.meta.dir, "..", "package.json"), "utf8")) as unknown;
const inspection = assertReleasePackageReady(manifest);
if (basename(tarball) !== releaseArchiveName(inspection.version)) {
  throw new Error("npm publication received the wrong release artifact name.");
}
const verifiedTag = process.env.VERIFIED_TAG;
const verifiedSha = process.env.VERIFIED_SHA;
const runId = process.env.GITHUB_RUN_ID;
const runAttempt = process.env.GITHUB_RUN_ATTEMPT;
const preflightArtifactState = process.env.HRA_NPM_PREFLIGHT_STATE;
const preflightRunAttempt = process.env.HRA_NPM_PREFLIGHT_RUN_ATTEMPT;
const preflightRunId = process.env.HRA_NPM_PREFLIGHT_RUN_ID;
if (
  verifiedTag !== `v${inspection.version}`
  || verifiedSha === undefined
  || !/^[0-9a-f]{40}$/u.test(verifiedSha)
  || runId === undefined
  || !/^[1-9][0-9]*$/u.test(runId)
  || runAttempt === undefined
  || !/^[1-9][0-9]*$/u.test(runAttempt)
  || (preflightArtifactState !== "absent" && preflightArtifactState !== "exact")
  || preflightRunAttempt === undefined
  || preflightRunId === undefined
) {
  throw new Error("npm publication requires one verified source and registry preflight identity.");
}
const releaseSha = verifiedSha;
const releaseTag = verifiedTag;
const workflowRunAttempt = runAttempt;
const workflowRunId = runId;
const registryPreflightState = preflightArtifactState;
const registryPreflightRunAttempt = preflightRunAttempt;
const registryPreflightRunId = preflightRunId;
const expectedIntegrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const expectedShasum = createHash("sha1").update(bytes).digest("hex");
const registry = `https://registry.npmjs.org/${encodeURIComponent(inspection.name)}`;
const versionUrl = `${registry}/${inspection.version}`;
const latestUrl = `${registry}/latest`;

async function metadata(
  url: string,
  endpoint: "latest" | "version",
): Promise<Record<string, unknown> | null> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  return npmRegistryReleaseMetadata(response, inspection.version, endpoint);
}

type CompleteNpmRelease = Readonly<{
  latest: NpmReleaseCoordinate;
  version: NpmReleaseCoordinate;
}>;

async function lookupCompleteRelease(): Promise<CompleteNpmRelease | null> {
  const versionMetadata = await metadata(versionUrl, "version");
  if (versionMetadata === null) return null;
  const latestMetadata = await metadata(latestUrl, "latest");
  if (latestMetadata === null) {
    throw new Error(`${inspection.name}@${inspection.version} exists but npm latest is missing.`);
  }
  return Object.freeze({
    latest: parseNpmRelease(latestMetadata, inspection.version),
    version: parseNpmRelease(versionMetadata, inspection.version),
  });
}

function requireExactRelease(release: CompleteNpmRelease): void {
  if (
    release.version.integrity !== expectedIntegrity
    || release.version.shasum !== expectedShasum
    || release.latest.integrity !== expectedIntegrity
    || release.latest.shasum !== expectedShasum
  ) throw new Error(`${inspection.name}@${inspection.version} is not npm latest with exact immutable bytes.`);
}

async function registryJson(url: string, label: string): Promise<unknown> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status !== 200) {
    throw new Error(`${label} returned HTTP ${String(response.status)}.`);
  }
  return readBoundedJsonResponse(response, label, maximumAttestationBytes);
}

async function admitProvenance(
  attemptPolicy: NpmProvenanceAttemptPolicy,
  maximumAttempt: string,
): Promise<void> {
  const tufCachePath = await mkdtemp(join(tmpdir(), "hra-publish-sigstore-tuf-"));
  try {
    await verifyNpmProvenance({
      attemptPolicy,
      attestations: await registryJson(
        `https://registry.npmjs.org/-/npm/v1/attestations/@hraness%2fhra@${inspection.version}`,
        "npm Sigstore attestations",
      ),
      integrity: expectedIntegrity,
      maximumAttempt,
      registryKeys: await registryJson(
        "https://registry.npmjs.org/-/npm/v1/keys",
        "npm registry keys",
      ),
      runAttempt: workflowRunAttempt,
      runId: workflowRunId,
      sha: releaseSha,
      tag: releaseTag,
      tufCachePath,
    });
  } finally {
    await rm(tufCachePath, { force: true, recursive: true });
  }
}

const existing = await lookupCompleteRelease();
const transition = decideNpmPublicationTransition({
  currentArtifactState: existing === null ? "absent" : "exact",
  currentRunAttempt: workflowRunAttempt,
  currentRunId: workflowRunId,
  preflightArtifactState: registryPreflightState,
  preflightRunAttempt: registryPreflightRunAttempt,
  preflightRunId: registryPreflightRunId,
});
if (transition.action === "admit_existing") {
  if (existing === null) throw new Error("The exact npm release disappeared after transition planning.");
  requireExactRelease(existing);
  await admitProvenance(transition.attemptPolicy, transition.maximumProvenanceAttempt);
  console.log(`${inspection.name}@${inspection.version} already contains the exact trusted-publisher bytes.`);
} else {
  if (process.env.HRA_APPROVE_NPM_PUBLICATION !== `publish:${inspection.name}@${inspection.version}`) {
    throw new Error("The first npm publication requires its exact explicit approval value.");
  }
  const cleanEnvironment = Object.fromEntries([
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "CI",
    "GITHUB_ACTION",
    "GITHUB_ACTIONS",
    "GITHUB_ACTOR_ID",
    "GITHUB_EVENT_NAME",
    "GITHUB_JOB",
    "GITHUB_REF",
    "GITHUB_REF_NAME",
    "GITHUB_REPOSITORY",
    "GITHUB_REPOSITORY_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_RUN_ID",
    "GITHUB_SERVER_URL",
    "GITHUB_SHA",
    "GITHUB_WORKFLOW",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_WORKFLOW_SHA",
    "HOME",
    "NPM_CONFIG_REGISTRY",
    "PATH",
    "RUNNER_ENVIRONMENT",
  ].flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value]];
  }));
  const child = Bun.spawn([
    "npm", "publish", tarball, "--access", "public", "--provenance",
  ], { env: cleanEnvironment, stderr: "pipe", stdin: "ignore", stdout: "pipe" });
  const timer = setTimeout(() => child.kill(9), 5 * 60_000);
  const boundedOutput = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = stream.getReader();
    let bytes = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > 1024 * 1024) {
          child.kill(9);
          throw new Error("npm trusted publication exceeded its output bound.");
        }
      }
    } finally {
      reader.releaseLock();
    }
  };
  const [exitCode] = await Promise.all([
    child.exited.finally(() => clearTimeout(timer)),
    boundedOutput(child.stdout),
    boundedOutput(child.stderr),
  ]);
  if (exitCode !== 0) throw new Error("npm trusted publication failed without exposing provider output.");
  let observed: CompleteNpmRelease | null = null;
  let lookupFailure: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (attempt > 0) await Bun.sleep(3_000);
    try {
      const candidate = await lookupCompleteRelease();
      if (candidate !== null) {
        requireExactRelease(candidate);
        observed = candidate;
        break;
      }
    } catch (error) {
      lookupFailure = error;
    }
  }
  if (observed === null) {
    const detail = lookupFailure instanceof Error ? ` ${lookupFailure.message}` : "";
    throw new Error(`npm publication did not become readable as latest with exact provenance-bearing bytes.${detail}`);
  }
  await admitProvenance("exact", workflowRunAttempt);
  console.log(`Published exact ${inspection.name}@${inspection.version} through npm trusted publishing.`);
}
