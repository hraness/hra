import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { parseNpmRelease } from "./release-distribution-policy";
import { assertReleasePackageReady, releaseArchiveName } from "./release-package-policy";

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
const runAttempt = process.env.GITHUB_RUN_ATTEMPT;
if (verifiedTag !== `v${inspection.version}` || runAttempt === undefined || !/^[1-9][0-9]*$/u.test(runAttempt)) {
  throw new Error("npm publication requires one verified tag and workflow attempt.");
}
const expectedIntegrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const expectedShasum = createHash("sha1").update(bytes).digest("hex");
const url = `https://registry.npmjs.org/${encodeURIComponent(inspection.name)}/${inspection.version}`;

async function lookup(): Promise<boolean> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return false;
  if (response.status !== 200) throw new Error(`npm registry returned HTTP ${String(response.status)}.`);
  const payload = await response.json() as unknown;
  const coordinate = parseNpmRelease(payload, inspection.version);
  if (coordinate.integrity !== expectedIntegrity || coordinate.shasum !== expectedShasum) {
    throw new Error(`${inspection.name}@${inspection.version} exists with different immutable bytes.`);
  }
  return true;
}

if (await lookup()) {
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
  ].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name] as string]]));
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
  let observed = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (attempt > 0) await Bun.sleep(3_000);
    if (await lookup()) {
      observed = true;
      break;
    }
  }
  if (!observed) throw new Error("npm publication did not become readable with exact provenance-bearing bytes.");
  console.log(`Published exact ${inspection.name}@${inspection.version} through npm trusted publishing.`);
}
