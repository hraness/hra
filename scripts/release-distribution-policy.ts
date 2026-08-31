import { releaseArchiveName } from "./release-package-policy";

type JsonRecord = Record<string, unknown>;

const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const OIDC_CONFIGURATION = /^oidc:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const GITHUB_BRANCH = /^[A-Za-z0-9._/-]+$/u;

export const publicPackageName = "@hraness/hra";
export const publicRepository = "hraness/hra";

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function text(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

export function parseGitHubBranchCommitSha(value: unknown, branch: string): string {
  text(branch, GITHUB_BRANCH, "GitHub branch");
  const reference = record(value, `GitHub branch ${branch}`);
  const object = record(reference.object, `GitHub branch ${branch} object`);
  if (
    reference.ref !== `refs/heads/${branch}`
    || object.type !== "commit"
    || typeof object.sha !== "string"
    || !SHA1.test(object.sha)
  ) throw new Error(`GitHub branch ${branch} is invalid.`);
  return object.sha;
}

export function assertReviewedReleaseCommitOnStableBranch(
  comparisonValue: unknown,
  finalHeadValue: unknown,
  input: Readonly<{ branch: string; headSha: string; reviewedSha: string }>,
): void {
  text(input.branch, GITHUB_BRANCH, "GitHub branch");
  text(input.headSha, SHA1, "GitHub branch commit");
  text(input.reviewedSha, SHA1, "Reviewed release commit");
  const finalHeadSha = parseGitHubBranchCommitSha(finalHeadValue, input.branch);
  if (finalHeadSha !== input.headSha) {
    throw new Error(`GitHub branch ${input.branch} moved during release authority verification.`);
  }

  const comparison = record(comparisonValue, `GitHub ${input.branch} ancestry comparison`);
  const base = record(comparison.base_commit, "GitHub comparison base");
  const mergeBase = record(comparison.merge_base_commit, "GitHub comparison merge base");
  const aheadBy = comparison.ahead_by;
  const expectedUrl =
    `https://api.github.com/repos/${publicRepository}/compare/${input.reviewedSha}...${input.headSha}`;
  if (
    !Number.isSafeInteger(aheadBy)
    || Number(aheadBy) < 0
    || comparison.behind_by !== 0
    || (aheadBy === 0 ? comparison.status !== "identical" : comparison.status !== "ahead")
    || comparison.url !== expectedUrl
    || base.sha !== input.reviewedSha
    || mergeBase.sha !== input.reviewedSha
  ) {
    throw new Error(
      `Reviewed release commit ${input.reviewedSha} is not an ancestor of current ${input.branch}.`,
    );
  }
}

export type NpmReleaseCoordinate = Readonly<{ integrity: string; shasum: string; tarball: string }>;

export function parseNpmRelease(value: unknown, version: string): NpmReleaseCoordinate {
  text(version, SEMVER, "npm release version");
  const release = record(value, "npm release");
  if (release.name !== publicPackageName || release.version !== version || release.license !== "MIT") {
    throw new Error(`npm ${publicPackageName}@${version} has the wrong identity or license.`);
  }
  const dist = record(release.dist, "npm release dist");
  const expectedTarball = `https://registry.npmjs.org/@hraness/hra/-/hra-${version}.tgz`;
  if (dist.tarball !== expectedTarball) throw new Error("npm release tarball URL is not canonical.");
  const npmUser = record(release._npmUser, "npm trusted publisher identity");
  const trustedPublisher = record(npmUser.trustedPublisher, "npm trusted publisher");
  const attestations = record(dist.attestations, "npm release attestations");
  const provenance = record(attestations.provenance, "npm release provenance");
  const expectedAttestationUrl =
    `https://registry.npmjs.org/-/npm/v1/attestations/@hraness%2fhra@${version}`;
  if (
    npmUser.name !== "GitHub Actions"
    || npmUser.email !== "npm-oidc-no-reply@github.com"
    || trustedPublisher.id !== "github"
    || typeof trustedPublisher.oidcConfigId !== "string"
    || !OIDC_CONFIGURATION.test(trustedPublisher.oidcConfigId)
    || attestations.url !== expectedAttestationUrl
    || provenance.predicateType !== "https://slsa.dev/provenance/v1"
  ) throw new Error("npm trusted-publisher provenance is missing or invalid.");
  return Object.freeze({
    integrity: text(dist.integrity, SHA512_INTEGRITY, "npm release integrity"),
    shasum: text(dist.shasum, SHA1, "npm release SHA-1"),
    tarball: expectedTarball,
  });
}

export type GitHubReleaseAsset = Readonly<{
  browserDownloadUrl: string;
  digest: string;
  id: number;
  name: string;
  size: number;
}>;

export type GitHubReleaseCoordinate = Readonly<{
  checksum: GitHubReleaseAsset;
  tarball: GitHubReleaseAsset;
}>;

function parseAsset(value: unknown, name: string, tag: string): GitHubReleaseAsset {
  const asset = record(value, `GitHub Release asset ${name}`);
  const browserDownloadUrl = `https://github.com/${publicRepository}/releases/download/${tag}/${name}`;
  if (asset.name !== name || asset.state !== "uploaded" || asset.browser_download_url !== browserDownloadUrl) {
    throw new Error(`GitHub Release asset ${name} has the wrong identity or state.`);
  }
  return Object.freeze({
    browserDownloadUrl,
    digest: text(asset.digest, SHA256_DIGEST, `GitHub Release asset ${name} digest`),
    id: positiveInteger(asset.id, `GitHub Release asset ${name} id`),
    name,
    size: positiveInteger(asset.size, `GitHub Release asset ${name} size`),
  });
}

export function parseGitHubRelease(value: unknown, version: string): GitHubReleaseCoordinate {
  text(version, SEMVER, "GitHub release version");
  const tag = `v${version}`;
  const release = record(value, "GitHub Release");
  if (
    release.tag_name !== tag
    || release.draft !== false
    || release.prerelease !== false
    || release.immutable !== true
    || !Array.isArray(release.assets)
    || release.assets.length !== 2
  ) throw new Error(`GitHub Release ${tag} is not exact, published, immutable, and artifact-complete.`);
  const byName = new Map(release.assets.map((asset) => {
    const item = record(asset, "GitHub Release asset");
    return [item.name, asset] as const;
  }));
  if (byName.size !== 2) throw new Error(`GitHub Release ${tag} contains duplicate asset names.`);
  const archive = releaseArchiveName(version);
  return Object.freeze({
    checksum: parseAsset(byName.get("SHA256SUMS"), "SHA256SUMS", tag),
    tarball: parseAsset(byName.get(archive), archive, tag),
  });
}

export function assertReleaseAssetBytes(
  coordinate: GitHubReleaseCoordinate,
  tarball: Uint8Array,
  checksum: Uint8Array,
  sha256: (bytes: Uint8Array) => string,
): void {
  const tarballDigest = sha256(tarball);
  const checksumDigest = sha256(checksum);
  if (
    coordinate.tarball.size !== tarball.byteLength
    || coordinate.tarball.digest !== `sha256:${tarballDigest}`
    || coordinate.checksum.size !== checksum.byteLength
    || coordinate.checksum.digest !== `sha256:${checksumDigest}`
  ) throw new Error("GitHub Release asset bytes do not match their immutable metadata.");
  const expected = `${tarballDigest}  ${coordinate.tarball.name}\n`;
  if (new TextDecoder("utf-8", { fatal: true }).decode(checksum) !== expected) {
    throw new Error("SHA256SUMS does not describe the exact release tarball.");
  }
}
