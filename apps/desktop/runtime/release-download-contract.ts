import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { z } from "@hra-internal/schema";

import { correspondingSourceSpecs } from "./corresponding-sources";
import { macosPackage } from "./macos-package-config";
import {
  HRA_CANONICAL_REPOSITORY,
  inspectCanonicalReleasePublication,
  inspectReleasePublicationTransition,
  inspectReleaseSourceRepository,
  inspectReleaseTag,
  type CanonicalReleasePublicationEvidence,
  type ReleasePublicationEvidence,
  type ReleaseRepositoryEvidence,
  type ReleaseTagEvidence,
} from "./release-provenance";
import { hraReleaseIdentity } from "./release-identity";
import {
  verifyMacOSApp,
  verifyMacOSReleaseArtifacts,
} from "./verify-macos-package";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const releaseDownloadPath = join(repositoryRoot, "release-download.json");
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const objectIdSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const emptyArtifactSchema = z.object({
  bytes: z.null(),
  name: z.string().min(1).max(200),
  sha256: z.null(),
}).strict();
const publishedArtifactSchema = z.object({
  bytes: z.number().int().positive().safe(),
  name: z.string().min(1).max(200),
  sha256: digestSchema,
}).strict();
const commonReleaseShape = {
  architecture: z.literal("Apple Silicon"),
  build: z.number().int().positive().safe(),
  minimumMacOS: z.string().regex(/^[1-9][0-9]*(?:\.[0-9]+)?$/u),
  tag: z.string().regex(/^v[0-9]+\.[0-9]+\.[0-9]+$/u),
  version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/u),
} as const;
const candidateReleaseSchema = z.object({
  ...commonReleaseShape,
  artifacts: z.object({
    checksum: emptyArtifactSchema,
    dmg: emptyArtifactSchema,
    manifest: emptyArtifactSchema,
  }).strict(),
  availability: z.literal("candidate"),
  source: z.object({
    commit: z.null(),
    runtimeTreeSha256: z.null(),
    tagObject: z.null(),
  }).strict(),
}).strict();
const publishedReleaseSchema = z.object({
  ...commonReleaseShape,
  artifacts: z.object({
    checksum: publishedArtifactSchema,
    dmg: publishedArtifactSchema,
    manifest: publishedArtifactSchema,
  }).strict(),
  availability: z.literal("published"),
  source: z.object({
    commit: objectIdSchema,
    runtimeTreeSha256: digestSchema,
    tagObject: objectIdSchema,
  }).strict(),
}).strict();
const releaseDownloadContractSchema = z.object({
  release: z.discriminatedUnion("availability", [
    candidateReleaseSchema,
    publishedReleaseSchema,
  ]),
  repository: z.literal(HRA_CANONICAL_REPOSITORY),
  schemaVersion: z.literal(1),
}).strict().superRefine((contract, context) => {
  const { release } = contract;
  const dmg = `HRA-${release.version}-${release.build}-macos-arm64.dmg`;
  if (
    release.tag !== `v${release.version}`
    || release.artifacts.dmg.name !== dmg
    || release.artifacts.checksum.name !== `${dmg}.sha256`
    || release.artifacts.manifest.name
      !== `HRA-${release.version}-${release.build}-release-manifest.json`
  ) {
    context.addIssue({
      code: "custom",
      message: "Release tag and artifact names must derive from version and build.",
    });
  }
});

export type ReleaseDownloadContract = z.infer<typeof releaseDownloadContractSchema>;
export type PublishedReleaseDownloadContract = Readonly<{
  release: z.infer<typeof publishedReleaseSchema>;
  repository: typeof HRA_CANONICAL_REPOSITORY;
  schemaVersion: 1;
}>;

export interface LocalReleaseCandidateEvidence {
  readonly artifacts: Readonly<{
    checksum: ReleaseArtifactEvidence;
    dmg: ReleaseArtifactEvidence;
    manifest: ReleaseArtifactEvidence;
  }>;
  readonly commit: string;
  readonly releaseDirectory: string;
  readonly repository: typeof HRA_CANONICAL_REPOSITORY;
  readonly runtimeTreeSha256: string;
  readonly status: "verified_local_candidate";
  readonly tag: "absent" | ReleaseTagEvidence;
}

export interface PublishedReleaseCandidateEvidence {
  readonly commit: string;
  readonly contract: PublishedReleaseDownloadContract;
  readonly repository: ReleaseRepositoryEvidence;
  readonly runtimeTreeSha256: string;
  readonly tag: ReleaseTagEvidence;
}

export interface PublishedReleaseSourceEvidence {
  readonly contract: PublishedReleaseDownloadContract;
  readonly publication: ReleasePublicationEvidence;
  readonly repository: ReleaseRepositoryEvidence;
  readonly tag: ReleaseTagEvidence;
}

export type ReleaseSourceGateEvidence =
  | Readonly<{
      availability: "candidate";
      contract: ReleaseDownloadContract;
      status: "valid_candidate_contract";
    }>
  | Readonly<PublishedReleaseSourceEvidence & {
      availability: "published";
      status: "verified_published_source";
    }>;

export const releasePublicationCommitAllowlistEnvironmentVariable =
  "HRA_RELEASE_PUBLICATION_COMMIT_ALLOWLIST" as const;

export type VercelReleaseSourceGateEvidence =
  | Extract<ReleaseSourceGateEvidence, { availability: "candidate" }>
  | Readonly<{
      availability: "published";
      contract: PublishedReleaseDownloadContract;
      publicationCommit: string;
      status: "verified_vercel_publication_binding";
    }>;

export type ReleaseHttpFetcher = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export type RemoteReleaseGateEvidence =
  | Readonly<{
      availability: "candidate";
      contract: ReleaseDownloadContract;
      status: "candidate_has_no_remote_release";
    }>
  | Readonly<{
      assets: LocalReleaseCandidateEvidence["artifacts"];
      availability: "published";
      contract: PublishedReleaseDownloadContract;
      immutable: true;
      releaseId: number;
      status: "verified_immutable_remote_release";
    }>;

type ReleaseSourceStateOptions = Readonly<{
  environment?: Readonly<Record<string, string | undefined>>;
  repositoryRoot?: string;
}>;

interface ReleaseArtifactEvidence {
  readonly bytes: number;
  readonly name: string;
  readonly sha256: string;
}

interface RemoteReleaseArtifactEvidence extends ReleaseArtifactEvidence {
  readonly downloadUrl: string;
}

interface RemoteCorrespondingSourceEvidence {
  readonly archiveName: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface ReleaseArtifactSetEvidence {
  readonly artifacts: LocalReleaseCandidateEvidence["artifacts"];
  readonly commit: string;
  readonly runtimeTreeSha256: string;
}

export function parseReleaseDownloadContract(value: unknown): ReleaseDownloadContract {
  return releaseDownloadContractSchema.parse(value);
}

export async function readReleaseDownloadContract(): Promise<ReleaseDownloadContract> {
  return parseReleaseDownloadContract(
    JSON.parse(await readFile(releaseDownloadPath, "utf8")) as unknown,
  );
}

export async function verifyReleaseDownloadContract(): Promise<ReleaseDownloadContract> {
  const contract = await readReleaseDownloadContract();
  const expectedNames = releaseArtifactNames();
  const release = contract.release;
  if (
    release.version !== macosPackage.version
    || release.build !== macosPackage.build
    || release.tag !== `v${macosPackage.version}`
    || release.minimumMacOS !== macosPackage.minimumMacOS.replace(/\.0$/u, "")
    || release.artifacts.dmg.name !== expectedNames.dmg
    || release.artifacts.checksum.name !== expectedNames.checksum
    || release.artifacts.manifest.name !== expectedNames.manifest
    || hraReleaseIdentity.version !== macosPackage.version
    || hraReleaseIdentity.build !== macosPackage.build
  ) {
    throw new Error("The download contract differs from the packaged HRA identity.");
  }
  await verifyVersionSurfaces();
  return contract;
}

/**
 * Candidate source only needs the checked release contract. A published
 * contract additionally has authority to expose downloads, so it must be the
 * clean, exact C-to-P publication checkout and carry the direct annotated tag.
 * This gate deliberately does not read or require packaged artifacts.
 */
export async function verifyReleaseSourceGate(): Promise<ReleaseSourceGateEvidence> {
  return await verifyReleaseSourceState(await verifyReleaseDownloadContract());
}

/**
 * Read back the immutable GitHub prerelease before a publication commit is
 * authorized for Vercel. GitHub's immutable asset digest binds the large DMG;
 * the small checksum and manifest are additionally downloaded and parsed.
 * Candidate contracts perform no network requests.
 */
export async function verifyRemoteReleaseGate(
  fetcher: ReleaseHttpFetcher = defaultReleaseFetcher,
): Promise<RemoteReleaseGateEvidence> {
  return await verifyRemoteReleaseState(
    await verifyReleaseDownloadContract(),
    fetcher,
  );
}

export async function verifyRemoteReleaseState(
  contract: ReleaseDownloadContract,
  fetcher: ReleaseHttpFetcher,
): Promise<RemoteReleaseGateEvidence> {
  if (contract.release.availability === "candidate") {
    return Object.freeze({
      availability: "candidate",
      contract,
      status: "candidate_has_no_remote_release",
    });
  }
  const publishedContract = asPublishedContract(contract);
  const metadataUrl =
    `https://api.github.com/repos/hraness/hra/releases/tags/${publishedContract.release.tag}`;
  const metadataResponse = await fetcher(metadataUrl, {
    headers: githubJsonHeaders(),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  requireSuccessfulResponse(metadataResponse, "GitHub release metadata");
  const metadataBytes = await readBoundedResponse(
    metadataResponse,
    1_048_576,
    "GitHub release metadata",
  );
  const metadata = parseJsonRecord(metadataBytes, "GitHub release metadata");
  const releaseId = requirePositiveSafeInteger(
    metadata["id"],
    "GitHub release ID",
  );
  if (
    metadata["tag_name"] !== publishedContract.release.tag
    || metadata["draft"] !== false
    || metadata["prerelease"] !== true
    || metadata["immutable"] !== true
  ) {
    throw new Error(
      "The GitHub release must be the exact published immutable HRA prerelease.",
    );
  }
  const rawAssets = metadata["assets"];
  if (!Array.isArray(rawAssets) || rawAssets.length > 64) {
    throw new Error("GitHub release assets must be one bounded array.");
  }
  const assetsByName = new Map<string, Record<string, unknown>>();
  for (const [index, value] of rawAssets.entries()) {
    const asset = requireRecord(value, `GitHub release asset ${index}`);
    const name = requireString(asset["name"], `GitHub release asset ${index} name`);
    if (assetsByName.has(name)) {
      throw new Error(`GitHub release asset name is duplicated: ${name}.`);
    }
    assetsByName.set(name, asset);
  }

  const expected = publishedContract.release.artifacts;
  const actualNames = [...assetsByName.keys()].sort();
  const expectedNames = [
    expected.checksum.name,
    expected.dmg.name,
    expected.manifest.name,
    ...correspondingSourceSpecs.map((spec) => spec.archiveName),
  ].sort();
  if (!isDeepStrictEqual(actualNames, expectedNames)) {
    throw new Error("The immutable GitHub release has the wrong exact asset set.");
  }
  const checksum = inspectRemoteReleaseAssetMetadata(
    publishedContract.release.tag,
    expected.checksum,
    assetsByName,
  );
  const dmg = inspectRemoteReleaseAssetMetadata(
    publishedContract.release.tag,
    expected.dmg,
    assetsByName,
  );
  const manifest = inspectRemoteReleaseAssetMetadata(
    publishedContract.release.tag,
    expected.manifest,
    assetsByName,
  );
  if (checksum.bytes > 4_096 || manifest.bytes > 16 * 1_024 * 1_024) {
    throw new Error("Remote release evidence files exceed their bounded sizes.");
  }
  const checksumBytes = await downloadSmallReleaseAsset(
    fetcher,
    checksum,
    "Remote checksum",
  );
  const manifestBytes = await downloadSmallReleaseAsset(
    fetcher,
    manifest,
    "Remote release manifest",
  );
  const expectedChecksum = `${dmg.sha256}  ${dmg.name}\n`;
  if (decodeUtf8(checksumBytes, "Remote checksum") !== expectedChecksum) {
    throw new Error("The remote checksum does not bind the published DMG.");
  }
  const correspondingSources = verifyRemoteReleaseManifest(
    manifestBytes,
    publishedContract,
  );
  for (const source of correspondingSources) {
    inspectRemoteReleaseAssetMetadata(
      publishedContract.release.tag,
      {
        bytes: source.bytes,
        name: source.archiveName,
        sha256: source.sha256,
      },
      assetsByName,
    );
  }
  return Object.freeze({
    assets: Object.freeze({
      checksum: releaseArtifactEvidence(checksum),
      dmg: releaseArtifactEvidence(dmg),
      manifest: releaseArtifactEvidence(manifest),
    }),
    availability: "published",
    contract: publishedContract,
    immutable: true,
    releaseId,
    status: "verified_immutable_remote_release",
  });
}

/**
 * Vercel Git builds are intentionally shallow, so the provider consumes an
 * exact publication-commit allowlist only after CI has verified the full
 * C-to-P transition. The Vercel-owned Git identity binds that immutable commit
 * to the canonical repository without trusting a shallow local .git directory.
 */
export async function verifyVercelReleaseSourceGate(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<VercelReleaseSourceGateEvidence> {
  return await verifyVercelReleaseSourceState(
    await verifyReleaseDownloadContract(),
    environment,
  );
}

export async function verifyVercelReleaseSourceState(
  contract: ReleaseDownloadContract,
  environment: Readonly<Record<string, string | undefined>>,
  inspectCanonical: (options: Readonly<{
    candidateCommit: string;
    publicationCommit: string;
    tag: string;
  }>) => Promise<CanonicalReleasePublicationEvidence> =
    inspectCanonicalReleasePublication,
): Promise<VercelReleaseSourceGateEvidence> {
  if (
    environment.VERCEL !== "1"
    || environment.VERCEL_GIT_PROVIDER !== "github"
    || environment.VERCEL_GIT_REPO_OWNER !== "hraness"
    || environment.VERCEL_GIT_REPO_SLUG !== "hra"
  ) {
    throw new Error(
      "HRA provider source requires the canonical Vercel Git repository identity.",
    );
  }
  const target = environment.VERCEL_TARGET_ENV;
  if (
    (target !== "production" && target !== "preview")
    || environment.VERCEL_ENV !== target
  ) {
    throw new Error(
      "HRA provider source requires one exact Production or Preview Vercel target.",
    );
  }
  if (
    target === "production"
    && environment.VERCEL_GIT_COMMIT_REF !== "main"
  ) {
    throw new Error("HRA Production source must be deployed from main.");
  }
  const actualCommit = requireObjectId(
    environment.VERCEL_GIT_COMMIT_SHA,
    "Vercel source commit",
  );
  if (contract.release.availability === "candidate") {
    return Object.freeze({
      availability: "candidate",
      contract,
      status: "valid_candidate_contract",
    });
  }
  const allowedCommit = requireObjectId(
    environment[releasePublicationCommitAllowlistEnvironmentVariable],
    "Trusted Vercel publication commit allowlist",
  );
  if (actualCommit !== allowedCommit) {
    throw new Error(
      "The Vercel Git commit is not the trusted release publication commit.",
    );
  }
  const publishedContract = asPublishedContract(contract);
  const canonical = await inspectCanonical({
    candidateCommit: publishedContract.release.source.commit,
    publicationCommit: actualCommit,
    tag: publishedContract.release.tag,
  });
  verifyPublicationContractTransition(
    publishedContract,
    canonical.publication,
  );
  if (
    canonical.tag.commit !== publishedContract.release.source.commit
    || canonical.tag.object !== publishedContract.release.source.tagObject
  ) {
    throw new Error(
      "The canonical annotated release tag differs from the published contract.",
    );
  }
  return Object.freeze({
    availability: "published",
    contract: publishedContract,
    publicationCommit: actualCommit,
    status: "verified_vercel_publication_binding",
  });
}

/**
 * Apply the conditional source rule to an already parsed and version-checked
 * contract. Repository options exist so focused tests can exercise the same
 * hermetic Git boundary in isolated repositories.
 */
export async function verifyReleaseSourceState(
  contract: ReleaseDownloadContract,
  options: ReleaseSourceStateOptions = {},
): Promise<ReleaseSourceGateEvidence> {
  if (contract.release.availability === "candidate") {
    return Object.freeze({
      availability: "candidate",
      contract,
      status: "valid_candidate_contract",
    });
  }
  const publishedContract = asPublishedContract(contract);
  const repository = await inspectReleaseSourceRepository(options);
  const published = await verifyPublishedReleaseSourceEvidence(
    publishedContract,
    repository,
  );
  return Object.freeze({
    ...published,
    availability: "published",
    status: "verified_published_source",
  });
}

export async function verifyLocalReleaseCandidate(
  releaseDirectoryValue: string,
): Promise<LocalReleaseCandidateEvidence> {
  const releaseDirectory = await requireCanonicalReleaseDirectory(
    releaseDirectoryValue,
  );
  const contract = await verifyReleaseDownloadContract();
  if (contract.release.availability !== "candidate") {
    throw new Error("Local candidate verification requires a candidate download contract.");
  }
  const repository = await inspectReleaseSourceRepository();
  const evidence = await inspectReleaseArtifactSet(releaseDirectory, contract);
  if (evidence.commit !== repository.commit) {
    throw new Error("The release manifest commit differs from the clean source commit.");
  }
  const tag = await inspectReleaseTag(repository, contract.release.tag);
  if (tag !== null && tag.commit !== repository.commit) {
    throw new Error("The release tag already points to another commit.");
  }
  return Object.freeze({
    artifacts: evidence.artifacts,
    commit: repository.commit,
    releaseDirectory,
    repository: HRA_CANONICAL_REPOSITORY,
    runtimeTreeSha256: evidence.runtimeTreeSha256,
    status: "verified_local_candidate",
    tag: tag ?? "absent",
  });
}

export async function requirePublishedReleaseSource(): Promise<
  PublishedReleaseSourceEvidence
> {
  const contract = await requirePublishedContract();
  const repository = await inspectReleaseSourceRepository();
  return await verifyPublishedReleaseSourceEvidence(contract, repository);
}

export async function verifyPublishedReleaseSourceEvidence(
  contract: PublishedReleaseDownloadContract,
  repository: ReleaseRepositoryEvidence,
): Promise<PublishedReleaseSourceEvidence> {
  const publication = await inspectReleasePublicationTransition(
    repository,
    contract.release.source.commit,
  );
  verifyPublicationContractTransition(contract, publication);
  const tag = await inspectReleaseTag(repository, contract.release.tag);
  if (
    tag === null
    || tag.commit !== contract.release.source.commit
    || tag.object !== contract.release.source.tagObject
  ) {
    throw new Error("The local annotated release tag differs from the published contract.");
  }
  return Object.freeze({ contract, publication, repository, tag });
}

function verifyPublicationContractTransition(
  contract: PublishedReleaseDownloadContract,
  publication: ReleasePublicationEvidence,
): void {
  const published = parseContractText(
    publication.publicationContract,
    "The publication release contract is not JSON.",
  );
  if (!isDeepStrictEqual(published, contract)) {
    throw new Error(
      "The canonical publication contract differs from the provider source.",
    );
  }
  const candidate = parseContractText(
    publication.candidateContract,
    "The tagged candidate release contract is not JSON.",
  );
  if (candidate.release.availability !== "candidate") {
    throw new Error("The tagged source must contain the candidate release contract.");
  }
  const expectedCandidate: ReleaseDownloadContract = {
    release: {
      architecture: contract.release.architecture,
      artifacts: {
        checksum: {
          bytes: null,
          name: contract.release.artifacts.checksum.name,
          sha256: null,
        },
        dmg: {
          bytes: null,
          name: contract.release.artifacts.dmg.name,
          sha256: null,
        },
        manifest: {
          bytes: null,
          name: contract.release.artifacts.manifest.name,
          sha256: null,
        },
      },
      availability: "candidate",
      build: contract.release.build,
      minimumMacOS: contract.release.minimumMacOS,
      source: {
        commit: null,
        runtimeTreeSha256: null,
        tagObject: null,
      },
      tag: contract.release.tag,
      version: contract.release.version,
    },
    repository: contract.repository,
    schemaVersion: contract.schemaVersion,
  };
  if (!isDeepStrictEqual(candidate, expectedCandidate)) {
    throw new Error(
      "The publication contract is not the exact evidence-only transition from its candidate.",
    );
  }
}

function parseContractText(
  value: string,
  invalidJsonMessage: string,
): ReleaseDownloadContract {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(invalidJsonMessage);
  }
  return parseReleaseDownloadContract(parsed);
}

export async function verifyPublishedReleaseCandidate(
  candidateAppPath: string,
): Promise<PublishedReleaseCandidateEvidence> {
  const published = await requirePublishedReleaseSource();
  const app = await verifyMacOSApp(candidateAppPath);
  if (
    app.commit !== published.contract.release.source.commit
    || app.treeSha256 !== published.contract.release.source.runtimeTreeSha256
  ) {
    throw new Error("The HRA candidate app differs from the published release provenance.");
  }
  return Object.freeze({
    commit: app.commit,
    contract: published.contract,
    repository: published.repository,
    runtimeTreeSha256: app.treeSha256,
    tag: published.tag,
  });
}

export async function verifyPublishedReleaseArtifacts(
  releaseDirectoryValue: string,
): Promise<ReleaseArtifactSetEvidence> {
  const releaseDirectory = await requireCanonicalReleaseDirectory(
    releaseDirectoryValue,
  );
  const published = await requirePublishedReleaseSource();
  const evidence = await inspectReleaseArtifactSet(
    releaseDirectory,
    published.contract,
  );
  if (
    evidence.commit !== published.contract.release.source.commit
    || evidence.runtimeTreeSha256
      !== published.contract.release.source.runtimeTreeSha256
    || JSON.stringify(evidence.artifacts)
      !== JSON.stringify(published.contract.release.artifacts)
  ) {
    throw new Error("Local release assets differ from the published release contract.");
  }
  return evidence;
}

async function requirePublishedContract(): Promise<PublishedReleaseDownloadContract> {
  return asPublishedContract(await verifyReleaseDownloadContract());
}

function asPublishedContract(
  contract: ReleaseDownloadContract,
): PublishedReleaseDownloadContract {
  if (contract.release.availability !== "published") {
    throw new Error("The HRA release-download contract is not published.");
  }
  return Object.freeze({
    release: contract.release,
    repository: contract.repository,
    schemaVersion: contract.schemaVersion,
  });
}

async function inspectReleaseArtifactSet(
  releaseDirectory: string,
  contract: ReleaseDownloadContract,
): Promise<ReleaseArtifactSetEvidence> {
  await verifyMacOSReleaseArtifacts(releaseDirectory);
  const { checksum, dmg, manifest } = contract.release.artifacts;
  const [checksumEvidence, dmgEvidence, manifestEvidence] = await Promise.all([
    inspectRegularArtifact(releaseDirectory, checksum.name),
    inspectRegularArtifact(releaseDirectory, dmg.name),
    inspectRegularArtifact(releaseDirectory, manifest.name),
  ]);
  const checksumText = await readFile(join(releaseDirectory, checksum.name), "utf8");
  if (checksumText !== `${dmgEvidence.sha256}  ${dmg.name}\n`) {
    throw new Error("The release checksum file does not name the exact DMG hash.");
  }
  const manifestValue: unknown = JSON.parse(
    await readFile(join(releaseDirectory, manifest.name), "utf8"),
  );
  const manifestRecord = requireRecord(manifestValue, "Release manifest");
  const releaseRecord = requireRecord(manifestRecord["release"], "Release identity");
  const commit = requireObjectId(releaseRecord["commit"], "Release manifest commit");
  const runtimeTreeSha256 = requireDigest(
    manifestRecord["runtimeTreeSha256"],
    "Release runtime tree SHA-256",
  );
  return Object.freeze({
    artifacts: Object.freeze({
      checksum: checksumEvidence,
      dmg: dmgEvidence,
      manifest: manifestEvidence,
    }),
    commit,
    runtimeTreeSha256,
  });
}

async function inspectRegularArtifact(
  releaseDirectory: string,
  name: string,
): Promise<ReleaseArtifactEvidence> {
  const path = join(releaseDirectory, name);
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`Release artifact must be a regular file: ${name}`);
  }
  return Object.freeze({
    bytes: status.size,
    name,
    sha256: await sha256File(path),
  });
}

async function verifyVersionSurfaces(): Promise<void> {
  const [appManifest, packageText, buildManifest, buildSource, lockText] =
    await Promise.all([
      readFile(join(repositoryRoot, "apps/desktop/app.zon"), "utf8"),
      readFile(join(repositoryRoot, "apps/desktop/package.json"), "utf8"),
      readFile(join(repositoryRoot, "apps/desktop/build.zig.zon"), "utf8"),
      readFile(join(repositoryRoot, "apps/desktop/build.zig"), "utf8"),
      readFile(join(repositoryRoot, "bun.lock"), "utf8"),
    ]);
  const packageValue = requireRecord(
    JSON.parse(packageText) as unknown,
    "Desktop package manifest",
  );
  const lockVersion = /"apps\/desktop":\s*\{[\s\S]*?"version":\s*"([^"]+)"/u
    .exec(lockText)?.[1];
  const buildNumber = /const release_build_number = ([0-9]+);/u
    .exec(buildSource)?.[1];
  if (
    zonLiteral(appManifest, "version") !== macosPackage.version
    || zonLiteral(appManifest, "id") !== macosPackage.bundleIdentifier
    || zonLiteral(appManifest, "display_name") !== macosPackage.displayName
    || zonLiteral(buildManifest, "version") !== macosPackage.version
    || packageValue["version"] !== macosPackage.version
    || lockVersion !== macosPackage.version
    || buildNumber !== String(macosPackage.build)
  ) {
    throw new Error("A checked desktop version surface differs from the HRA release identity.");
  }
}

function releaseArtifactNames() {
  const dmg = `${macosPackage.artifactBaseName}.dmg`;
  return Object.freeze({
    checksum: `${dmg}.sha256`,
    dmg,
    manifest:
      `HRA-${macosPackage.version}-${macosPackage.build}-release-manifest.json`,
  });
}

function zonLiteral(source: string, key: string): string {
  const value = new RegExp(`\\.${key}\\s*=\\s*"([^"]+)"`, "u").exec(source)?.[1];
  if (value === undefined) throw new Error(`A Zig manifest is missing ${key}.`);
  return value;
}

async function requireCanonicalReleaseDirectory(value: string): Promise<string> {
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw new Error("Release directory must be an absolute normalized path.");
  }
  const status = await lstat(value);
  if (!status.isDirectory() || status.isSymbolicLink() || await realpath(value) !== value) {
    throw new Error("Release directory must be a real canonical directory.");
  }
  return value;
}

async function sha256File(path: string): Promise<string> {
  const handle = await open(path, "r");
  const hasher = createHash("sha256");
  try {
    for await (const chunk of handle.readableWebStream()) {
      hasher.update(chunk as Uint8Array);
    }
  } finally {
    await handle.close();
  }
  return hasher.digest("hex");
}

function defaultReleaseFetcher(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, init);
}

function githubJsonHeaders(): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "hraness-hra-release-verifier",
    "X-GitHub-Api-Version": "2026-03-10",
  };
}

function requireSuccessfulResponse(response: Response, label: string): void {
  if (!response.ok || response.status !== 200) {
    throw new Error(`${label} returned HTTP ${response.status}.`);
  }
}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
  label: string,
): Promise<Uint8Array> {
  if (response.body === null) throw new Error(`${label} has no response body.`);
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsedLength)
      || parsedLength < 0
      || parsedLength > maximumBytes
    ) {
      throw new Error(`${label} has an invalid or oversized Content-Length.`);
    }
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) {
        throw new Error(`${label} exceeds its byte limit.`);
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseJsonRecord(bytes: Uint8Array, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(bytes, label)) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message.includes("UTF-8")) throw error;
    throw new Error(`${label} is not valid JSON.`);
  }
  return requireRecord(value, label);
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
}

function inspectRemoteReleaseAssetMetadata(
  tag: string,
  expected: PublishedReleaseDownloadContract["release"]["artifacts"]["dmg"],
  assetsByName: ReadonlyMap<string, Record<string, unknown>>,
): RemoteReleaseArtifactEvidence {
  const metadata = assetsByName.get(expected.name);
  if (metadata === undefined) {
    throw new Error(`The GitHub release is missing ${expected.name}.`);
  }
  const id = requirePositiveSafeInteger(
    metadata["id"],
    `GitHub release asset ${expected.name} ID`,
  );
  const expectedDownloadUrl =
    `${HRA_CANONICAL_REPOSITORY}/releases/download/${tag}/${expected.name}`;
  const expectedApiUrl =
    `https://api.github.com/repos/hraness/hra/releases/assets/${id}`;
  if (
    metadata["state"] !== "uploaded"
    || metadata["size"] !== expected.bytes
    || metadata["digest"] !== `sha256:${expected.sha256}`
    || metadata["browser_download_url"] !== expectedDownloadUrl
    || metadata["url"] !== expectedApiUrl
  ) {
    throw new Error(
      `GitHub release metadata differs from published evidence for ${expected.name}.`,
    );
  }
  return Object.freeze({
    bytes: expected.bytes,
    downloadUrl: expectedDownloadUrl,
    name: expected.name,
    sha256: expected.sha256,
  });
}

async function downloadSmallReleaseAsset(
  fetcher: ReleaseHttpFetcher,
  artifact: RemoteReleaseArtifactEvidence,
  label: string,
): Promise<Uint8Array> {
  const response = await fetcher(artifact.downloadUrl, {
    headers: {
      Accept: "application/octet-stream",
      "User-Agent": "hraness-hra-release-verifier",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  requireSuccessfulResponse(response, label);
  const bytes = await readBoundedResponse(response, artifact.bytes, label);
  if (bytes.byteLength !== artifact.bytes) {
    throw new Error(`${label} has the wrong byte count.`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== artifact.sha256) {
    throw new Error(`${label} has the wrong SHA-256 digest.`);
  }
  return bytes;
}

function releaseArtifactEvidence(
  artifact: RemoteReleaseArtifactEvidence,
): ReleaseArtifactEvidence {
  return Object.freeze({
    bytes: artifact.bytes,
    name: artifact.name,
    sha256: artifact.sha256,
  });
}

function verifyRemoteReleaseManifest(
  bytes: Uint8Array,
  contract: PublishedReleaseDownloadContract,
): readonly RemoteCorrespondingSourceEvidence[] {
  const manifest = parseJsonRecord(bytes, "Remote release manifest");
  const artifact = requireRecord(
    manifest["artifact"],
    "Remote release manifest artifact",
  );
  const release = requireRecord(
    manifest["release"],
    "Remote release manifest identity",
  );
  const runtimeManifest = requireRecord(
    manifest["runtimeManifest"],
    "Remote runtime manifest",
  );
  const runtimeRelease = requireRecord(
    runtimeManifest["release"],
    "Remote runtime manifest release",
  );
  const runtime = requireRecord(
    runtimeManifest["runtime"],
    "Remote runtime manifest runtime",
  );
  const rawSources = manifest["correspondingSources"];
  if (
    !Array.isArray(rawSources)
    || rawSources.length !== correspondingSourceSpecs.length
  ) {
    throw new Error(
      "The remote release manifest has the wrong corresponding-source set.",
    );
  }
  const expected = contract.release;
  if (
    manifest["schemaVersion"] !== 1
    || artifact["bytes"] !== expected.artifacts.dmg.bytes
    || artifact["name"] !== expected.artifacts.dmg.name
    || artifact["sha256"] !== expected.artifacts.dmg.sha256
    || release["architecture"] !== "arm64"
    || release["build"] !== expected.build
    || release["commit"] !== expected.source.commit
    || normalizeMinimumMacOS(release["minimumMacOS"]) !== expected.minimumMacOS
    || release["notarized"] !== false
    || release["signing"] !== "adhoc"
    || release["version"] !== expected.version
    || manifest["runtimeTreeSha256"] !== expected.source.runtimeTreeSha256
    || manifest["sourceTreeCleanAtPackaging"] !== true
    || runtimeManifest["schemaVersion"] !== 1
    || runtimeRelease["commit"] !== expected.source.commit
    || runtimeRelease["version"] !== expected.version
    || runtimeRelease["build"] !== expected.build
    || runtime["treeSha256"] !== expected.source.runtimeTreeSha256
  ) {
    throw new Error(
      "The remote release manifest does not bind the published HRA evidence.",
    );
  }
  const sources: RemoteCorrespondingSourceEvidence[] = [];
  for (const [index, spec] of correspondingSourceSpecs.entries()) {
    const source = requireRecord(
      rawSources[index],
      `Remote corresponding source ${index}`,
    );
    const bytes = requirePositiveSafeInteger(
      source["bytes"],
      `Remote corresponding source ${index} bytes`,
    );
    const sha256 = requireDigest(
      source["sha256"],
      `Remote corresponding source ${index} SHA-256`,
    );
    if (
      source["archiveName"] !== spec.archiveName
      || source["commit"] !== spec.commit
      || source["project"] !== spec.project
      || source["repository"] !== spec.repository
      || !isDeepStrictEqual(source["externalSources"], spec.externalSources)
      || !isDeepStrictEqual(source["submodules"], spec.submodules)
    ) {
      throw new Error(
        `Remote corresponding-source evidence differs for ${spec.project}.`,
      );
    }
    sources.push(Object.freeze({
      archiveName: spec.archiveName,
      bytes,
      sha256,
    }));
  }
  return Object.freeze(sources);
}

function normalizeMinimumMacOS(value: unknown): string | null {
  return typeof value === "string" && /^[1-9][0-9]*(?:\.[0-9]+)?$/u.test(value)
    ? value.replace(/\.0$/u, "")
    : null;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a nonempty string.`);
  }
  return value;
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be one positive safe integer.`);
  }
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireObjectId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`${label} must be one full SHA-1 object ID.`);
  }
  return value;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be one SHA-256 digest.`);
  }
  return value;
}

async function main(): Promise<void> {
  const [command, flag, value] = process.argv.slice(2);
  if (command === "contract" && flag === undefined) {
    const contract = await verifyReleaseDownloadContract();
    process.stdout.write(`${JSON.stringify({ contract, status: "valid" })}\n`);
    return;
  }
  if (command === "source" && flag === undefined) {
    process.stdout.write(`${JSON.stringify(await verifyReleaseSourceGate())}\n`);
    return;
  }
  if (command === "remote" && flag === undefined) {
    process.stdout.write(`${JSON.stringify(await verifyRemoteReleaseGate())}\n`);
    return;
  }
  if (
    command === "candidate"
    && flag === "--release-directory"
    && value !== undefined
  ) {
    process.stdout.write(
      `${JSON.stringify(await verifyLocalReleaseCandidate(value))}\n`,
    );
    return;
  }
  if (
    command === "published"
    && flag === "--release-directory"
    && value !== undefined
  ) {
    process.stdout.write(
      `${JSON.stringify(await verifyPublishedReleaseArtifacts(value))}\n`,
    );
    return;
  }
  throw new Error(
    "Usage: release-download-contract.ts contract | source | remote | candidate --release-directory ABS | published --release-directory ABS",
  );
}

if (import.meta.main) await main();
