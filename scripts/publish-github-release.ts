import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  assertReleaseAssetBytes,
  parseGitHubRelease,
  publicRepository,
} from "./release-distribution-policy";
import { githubPublisherEnvironment } from "./github-publisher-environment";
import {
  draftReleaseBody,
  githubReleaseRun,
  parseReleaseBody,
  publishedReleaseBody,
  type GitHubReleaseIdentityInput,
} from "./github-release-identity";
import { parseGitHubIncludedJsonResponse } from "./release-included-response";
import { assertReleasePackageReady, releaseArchiveName } from "./release-package-policy";

const [tag, archiveArgument, checksumArgument] = process.argv.slice(2);
if (tag === undefined || archiveArgument === undefined || checksumArgument === undefined) {
  throw new Error("Usage: publish-github-release.ts TAG ARTIFACT.tgz SHA256SUMS");
}
if (process.env.GITHUB_REPOSITORY !== publicRepository) {
  throw new Error(`GitHub Release publication must run in ${publicRepository}.`);
}
const verifiedSha = process.env.VERIFIED_SHA;
if (verifiedSha === undefined || !/^[0-9a-f]{40}$/u.test(verifiedSha)) {
  throw new Error("GitHub Release publication requires one verified commit.");
}
const verifiedTagObject = process.env.VERIFIED_TAG_OBJECT;
if (verifiedTagObject === undefined || !/^[0-9a-f]{40}$/u.test(verifiedTagObject)) {
  throw new Error("GitHub Release publication requires one verified annotated tag object.");
}
const defaultBranch = process.env.DEFAULT_BRANCH;
if (defaultBranch === undefined || !/^[A-Za-z0-9._/-]+$/u.test(defaultBranch)) {
  throw new Error("GitHub Release publication requires one verified default branch.");
}
const manifest = JSON.parse(await readFile(resolve(import.meta.dir, "..", "package.json"), "utf8")) as unknown;
const inspection = assertReleasePackageReady(manifest);
const archive = resolve(archiveArgument);
const checksum = resolve(checksumArgument);
if (
  tag !== `v${inspection.version}`
  || basename(archive) !== releaseArchiveName(inspection.version)
  || basename(checksum) !== "SHA256SUMS"
) throw new Error("GitHub Release coordinates do not match the public package.");
const archiveBytes = await readFile(archive);
const checksumBytes = await readFile(checksum);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const expectedTitle = `HRA ${tag}`;
const maximumArtifactBytes = 64 * 1024 * 1024;
const maximumGitHubJsonBytes = 4 * 1024 * 1024;
const releaseRun = githubReleaseRun(tag, process.env);
const releaseIdentity: GitHubReleaseIdentityInput = Object.freeze({
  artifacts: Object.freeze([
    Object.freeze({ name: basename(archive), sha256: sha256(archiveBytes), size: archiveBytes.byteLength }),
    Object.freeze({ name: basename(checksum), sha256: sha256(checksumBytes), size: checksumBytes.byteLength }),
  ]),
  commitSha: verifiedSha,
  run: releaseRun,
  tag,
  tagObjectSha: verifiedTagObject,
});
const expectedDraftBody = draftReleaseBody(releaseIdentity);

type CommandResult = Readonly<{ exitCode: number; stderr: Buffer; stdout: Buffer }>;

function run(
  arguments_: string[],
  allowFailure = false,
  maximumStdoutBytes = maximumGitHubJsonBytes,
): CommandResult {
  const result = Bun.spawnSync({
    cmd: arguments_,
    env: githubPublisherEnvironment(process.env),
    killSignal: "SIGKILL",
    maxBuffer: maximumStdoutBytes + 1,
    stderr: "pipe",
    stdout: "pipe",
    timeout: 120_000,
  });
  if (result.exitedDueToTimeout || result.exitedDueToMaxBuffer) {
    throw new Error(`GitHub ${arguments_[1] ?? "command"} exceeded its execution bound.`);
  }
  if (result.stdout.byteLength > maximumStdoutBytes) {
    throw new Error(`GitHub ${arguments_[1] ?? "command"} exceeded its output byte bound.`);
  }
  if (result.exitCode !== 0 && !allowFailure) {
    const diagnosticState = result.stderr.byteLength === 0
      ? "without diagnostic output"
      : "with redacted diagnostic output";
    throw new Error(`GitHub ${arguments_[1] ?? "command"} failed ${diagnosticState}.`);
  }
  return Object.freeze({
    exitCode: result.exitCode,
    stderr: Buffer.from(result.stderr),
    stdout: Buffer.from(result.stdout),
  });
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be one JSON object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function readJson(arguments_: string[]): Readonly<Record<string, unknown>> {
  const value = JSON.parse(run(arguments_).stdout.toString("utf8")) as unknown;
  return record(value, `GitHub ${arguments_[1] ?? "command"} response`);
}

function verifyRemoteAnnotatedTag(): void {
  const tagRef = readJson(["gh", "api", `/repos/${publicRepository}/git/ref/tags/${tag}`]);
  const tagObject = record(tagRef.object, `Remote release ref ${tag} object`);
  if (
    tagRef.ref !== `refs/tags/${tag}`
    || tagObject.type !== "tag"
    || tagObject.sha !== verifiedTagObject
  ) throw new Error(`Remote release ref ${tag} is not the verified annotated tag object.`);
  const annotated = readJson([
    "gh", "api", `/repos/${publicRepository}/git/tags/${verifiedTagObject}`,
  ]);
  const target = record(annotated.object, `Remote annotated tag ${tag} target`);
  if (annotated.tag !== tag || target.type !== "commit" || target.sha !== verifiedSha) {
    throw new Error(`Remote annotated tag ${tag} does not target the verified commit.`);
  }
  const head = readJson([
    "gh", "api", `/repos/${publicRepository}/git/ref/heads/${defaultBranch}`,
  ]);
  const headObject = record(head.object, `Remote ${defaultBranch} ref object`);
  if (
    head.ref !== `refs/heads/${defaultBranch}`
    || headObject.type !== "commit"
    || typeof headObject.sha !== "string"
    || !/^[0-9a-f]{40}$/u.test(headObject.sha)
  ) throw new Error(`Remote ${defaultBranch} ref is invalid.`);
  const comparison = readJson([
    "gh", "api", `/repos/${publicRepository}/compare/${verifiedSha}...${defaultBranch}`,
  ]);
  const base = record(comparison.base_commit, "Reviewed-main comparison base");
  const mergeBase = record(comparison.merge_base_commit, "Reviewed-main merge base");
  const comparisonHead = record(comparison.head_commit, "Reviewed-main comparison head");
  if (
    !["ahead", "identical"].includes(String(comparison.status))
    || base.sha !== verifiedSha
    || mergeBase.sha !== verifiedSha
    || comparisonHead.sha !== headObject.sha
  ) throw new Error(`Reviewed release commit is not an ancestor of current ${defaultBranch}.`);
}

function release(): unknown {
  return JSON.parse(run([
    "gh", "api", `/repos/${publicRepository}/releases/tags/${tag}`,
  ]).stdout.toString("utf8")) as unknown;
}

function releaseById(id: number): Readonly<Record<string, unknown>> {
  return readJson(["gh", "api", `/repos/${publicRepository}/releases/${String(id)}`]);
}

function releaseId(value: unknown, label: string): number {
  const item = record(value, label);
  if (!Number.isSafeInteger(item.id) || Number(item.id) <= 0) {
    throw new Error(`${label} has no positive numeric identity.`);
  }
  return Number(item.id);
}

type ExactDraft = Readonly<{
  assets: readonly Readonly<Record<string, unknown>>[];
  createdAttempt: number;
  id: number;
}>;

function exactDraft(value: unknown): ExactDraft {
  const draft = record(value, `Residual GitHub Release draft ${tag}`);
  if (
    draft.tag_name !== tag
    || draft.name !== expectedTitle
    || draft.draft !== true
    || draft.prerelease !== false
    || draft.immutable !== false
    || draft.published_at !== null
    || !Number.isSafeInteger(draft.id)
    || Number(draft.id) <= 0
    || !Array.isArray(draft.assets)
    || draft.assets.length > 2
  ) throw new Error(`Residual draft for ${tag} does not match the exact recoverable release.`);
  const identity = parseReleaseBody(draft.body, releaseIdentity, "draft");
  const assets = draft.assets.map((asset) => record(asset, "Residual draft asset"));
  const names = new Set(assets.map((asset) => asset.name));
  if (
    names.size !== assets.length
    || [...names].some((name) => name !== basename(archive) && name !== basename(checksum))
  ) throw new Error(`Residual draft for ${tag} contains ambiguous assets.`);
  return Object.freeze({
    assets: Object.freeze(assets),
    createdAttempt: identity.createdAttempt,
    id: Number(draft.id),
  });
}

function findDraft(): ExactDraft | null {
  const inventory = JSON.parse(run([
    "gh", "api", `/repos/${publicRepository}/releases?per_page=100&page=1`,
  ]).stdout.toString("utf8")) as unknown;
  if (!Array.isArray(inventory) || inventory.length >= 100) {
    throw new Error("GitHub Release draft inventory is malformed or incomplete.");
  }
  const matches = inventory.filter((item) => {
    const candidate = record(item, "GitHub Release inventory item");
    return candidate.draft === true && candidate.tag_name === tag;
  });
  if (matches.length > 1) throw new Error(`Multiple residual drafts exist for ${tag}.`);
  return matches.length === 0 ? null : exactDraft(matches[0]);
}

function assertNoResidualDraft(): void {
  const residual = findDraft();
  if (residual !== null) {
    throw new Error(`Residual draft ${tag} remains after immutable publication.`);
  }
}

function readExactDraftById(id: number): ExactDraft {
  const draft = exactDraft(readJson([
    "gh", "api", `/repos/${publicRepository}/releases/${String(id)}`,
  ]));
  if (draft.id !== id) {
    throw new Error(`Residual draft ${tag} changed identity during recovery.`);
  }
  return draft;
}

function verifyDraftAssets(draft: ExactDraft): readonly string[] {
  const missing: string[] = [];
  for (const source of [archive, checksum]) {
    const expectedName = basename(source);
    const sourceBytes = source === archive ? archiveBytes : checksumBytes;
    const asset = draft.assets.find((candidate) => candidate.name === expectedName);
    if (asset === undefined) {
      missing.push(source);
      continue;
    }
    if (
      asset.state !== "uploaded"
      || !Number.isSafeInteger(asset.id)
      || Number(asset.id) <= 0
      || asset.size !== sourceBytes.byteLength
      || asset.digest !== `sha256:${sha256(sourceBytes)}`
    ) throw new Error(`Residual draft asset ${expectedName} has different immutable metadata.`);
    const downloaded = run([
      "gh", "api", "-H", "Accept: application/octet-stream",
      `/repos/${publicRepository}/releases/assets/${String(asset.id)}`,
    ], false, maximumArtifactBytes).stdout;
    if (!downloaded.equals(sourceBytes)) {
      throw new Error(`Residual draft asset ${expectedName} has different bytes.`);
    }
  }
  return Object.freeze(missing);
}

function completeDraftAssets(draft: ExactDraft): ExactDraft {
  let current = readExactDraftById(draft.id);
  for (const source of verifyDraftAssets(current)) {
    current = readExactDraftById(draft.id);
    if (!verifyDraftAssets(current).includes(source)) continue;
    const name = basename(source);
    run([
      "gh", "api", "--method", "POST",
      "--header", "Accept: application/vnd.github+json",
      "--header", "Content-Type: application/octet-stream",
      "--input", source,
      `https://uploads.github.com/repos/${publicRepository}/releases/${String(draft.id)}/assets?name=${encodeURIComponent(name)}`,
    ]);
    current = readExactDraftById(draft.id);
    if (verifyDraftAssets(current).includes(source)) {
      throw new Error(`Residual draft ${tag} did not retain exact asset ${name}.`);
    }
  }
  current = readExactDraftById(draft.id);
  if (verifyDraftAssets(current).length !== 0) {
    throw new Error(`Residual draft ${tag} could not be completed exactly.`);
  }
  return current;
}

function publishDraft(draft: ExactDraft): number {
  verifyRemoteAnnotatedTag();
  const publishedBody = publishedReleaseBody(releaseIdentity, draft.createdAttempt);
  const published = readJson([
    "gh", "api", "--method", "PATCH",
    `/repos/${publicRepository}/releases/${String(draft.id)}`,
    "-f", `name=${expectedTitle}`,
    "-f", `body=${publishedBody}`,
    "-F", "draft=false", "-F", "prerelease=false", "-f", "make_latest=true",
  ]);
  if (releaseId(published, `Published GitHub Release ${tag}`) !== draft.id) {
    throw new Error(`Published GitHub Release ${tag} switched numeric identity.`);
  }
  if (published.body !== publishedBody) {
    throw new Error(`Published GitHub Release ${tag} did not retain its exact publication-attempt identity.`);
  }
  parseReleaseBody(published.body, releaseIdentity, "published");
  return draft.id;
}

async function verifyPublishedRelease(expectedId: number): Promise<void> {
  let lastError: unknown;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const published = releaseById(expectedId);
      if (releaseId(published, `GitHub Release ${tag}`) !== expectedId || published.name !== expectedTitle) {
        throw new Error(`GitHub Release ${tag} changed numeric or display identity.`);
      }
      parseReleaseBody(published.body, releaseIdentity, "published");
      const coordinate = parseGitHubRelease(published, inspection.version);
      assertReleaseAssetBytes(coordinate, archiveBytes, checksumBytes, sha256);
      for (const [asset, sourceBytes] of [
        [coordinate.tarball, archiveBytes],
        [coordinate.checksum, checksumBytes],
      ] as const) {
        const downloaded = run([
          "gh", "api", "-H", "Accept: application/octet-stream",
          `/repos/${publicRepository}/releases/assets/${String(asset.id)}`,
        ], false, maximumArtifactBytes).stdout;
        if (!downloaded.equals(sourceBytes)) {
          throw new Error(`GitHub Release ${tag} contains different ${asset.name} bytes.`);
        }
      }
      if (releaseId(release(), `Tag-resolved GitHub Release ${tag}`) !== expectedId) {
        throw new Error(`Tag-resolved GitHub Release ${tag} switched numeric identity.`);
      }
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(3_000);
    }
  }
  const detail = lastError instanceof Error ? ` ${lastError.message}` : "";
  throw new Error(`GitHub Release ${tag} did not become exact and immutable.${detail}`);
}

verifyRemoteAnnotatedTag();
const existing = run([
  "gh", "api", "--include", `/repos/${publicRepository}/releases/tags/${tag}`,
], true);
const existingResponse = parseGitHubIncludedJsonResponse(existing.stdout);
let publishedReleaseId: number;
if (existing.exitCode === 0 && existingResponse.status === 200) {
  if (existingResponse.body.draft === true) {
    const draft = exactDraft(existingResponse.body);
    verifyDraftAssets(draft);
    const completeDraft = completeDraftAssets(draft);
    publishedReleaseId = publishDraft(completeDraft);
    await verifyPublishedRelease(publishedReleaseId);
  } else {
    publishedReleaseId = releaseId(existingResponse.body, `Existing GitHub Release ${tag}`);
    await verifyPublishedRelease(publishedReleaseId);
  }
} else {
  if (
    existing.exitCode === 0
    || existingResponse.status !== 404
    || existingResponse.body.message !== "Not Found"
    || existingResponse.body.status !== "404"
  ) throw new Error(`Could not determine whether GitHub Release ${tag} exists.`);
  let draft = findDraft();
  if (draft === null) {
    verifyRemoteAnnotatedTag();
    const created = exactDraft(readJson([
      "gh", "api", "--method", "POST", `/repos/${publicRepository}/releases`,
      "-f", `tag_name=${tag}`, "-f", `name=${expectedTitle}`, "-f", `body=${expectedDraftBody}`,
      "-F", "draft=true", "-F", "prerelease=false", "-F", "generate_release_notes=false",
    ]));
    draft = findDraft();
    if (draft === null || draft.id !== created.id) {
      throw new Error(`GitHub did not inventory the same exact draft for ${tag}.`);
    }
  }
  verifyDraftAssets(draft);
  const completeDraft = completeDraftAssets(draft);
  publishedReleaseId = publishDraft(completeDraft);
  await verifyPublishedRelease(publishedReleaseId);
}
const latest = readJson(["gh", "api", `/repos/${publicRepository}/releases/latest`]);
if (latest.tag_name !== tag || releaseId(latest, "Latest GitHub Release") !== publishedReleaseId) {
  throw new Error(`Latest GitHub Release is not the exact numeric ${tag} release.`);
}
parseReleaseBody(latest.body, releaseIdentity, "published");
assertNoResidualDraft();
verifyRemoteAnnotatedTag();
console.log(`GitHub Release ${tag} contains the exact immutable HRA artifacts.`);
