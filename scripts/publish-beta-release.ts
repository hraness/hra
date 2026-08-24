import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import {
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import { assertProductionPackageOnly } from "./package-policy";
import { assertPublicTree } from "./public-text-policy";
import {
  VercelCutoverProvider,
  type AliasReadback,
  type DeploymentReadback,
  type ManagedAlias,
  type ProjectReadback,
} from "./domain-cutover";

const repository = "hraness/hra";
const repositoryId = 1_343_008_607;
const oldRepositoryId = 1_334_876_494;
const oldProjectId = "prj_eRfUBHdHkEbvIaB8x7dyyZhBc3wr";
const newProjectId = "prj_8ciIt9t9foE3utG45frRN7cxckjS";
const teamId = "team_UAd1iD2XogJlbFg4h14mRaPM";
const canonicalAlias = "hra.sh";
const fallbackAlias = "hra-weld.vercel.app";
const stagingAlias = "try-hra.vercel.app";
const immutableVersionTagsRulesetId = 21_213_369;
const releaseVersion = "0.1.0";
const releaseTag = `v${releaseVersion}`;
const workflowName = "Release";
const workflowPath = ".github/workflows/release.yml";
const workflowFile = "release.yml";
const artifactNamePrefix = `hra-release-${releaseTag}-run-`;
const title = `HRA ${releaseTag}`;
const publicationLeaseTitlePrefix = "HRA publication lease ";
const publicationLeaseWorkflowTimeoutMs = 6 * 60 * 60 * 1_000;
const publicationLeaseMaximumAgeMs = 5 * 60 * 60 * 1_000;
const publicationLeasePollIntervalMs = 2_000;
const publicationLeaseAcquireTimeoutMs = 45 * 60 * 1_000;
const publicationLeaseCandidatePageMaximum = 100;
const publicationLeaseCandidatePageSize = 100;
const repositoryRoot = resolve(import.meta.dir, "..");
const commandOutputMaximumBytes = 64 * 1024 * 1024;
const providerJsonMaximumBytes = 2 * 1024 * 1024;
const publicationLeaseRecoveryReceiptMaximumBytes = 4 * 1024;

const commitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const artifactNameSchema = z.string().regex(
  /^hra-release-v0\.1\.0-run-[1-9][0-9]*-attempt-[1-9][0-9]*$/u,
);
const deploymentIdSchema = z.string().regex(/^dpl_[A-Za-z0-9]{20,80}$/u);
const deploymentUrlSchema = z.string()
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.vercel\.app$/u)
  .refine((value) => value.endsWith(".vercel.app"));
const versionSchema = z.string().regex(/^0\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u);
const positiveIntegerSchema = z.number().int().positive().safe();

export type PublicationAction = "accept" | "publish";

export type PublicationRecoveryArguments = Readonly<{
  action: "recover";
  expectedCommit: string;
  ghCli: string;
  receipt: string;
  tag: typeof releaseTag;
}>;

export type PublicationArguments = Readonly<{
  action: PublicationAction;
  deploymentId: string;
  deploymentUrl: string;
  expectedCommit: string;
  fallbackDeploymentId: string;
  fallbackDeploymentUrl: string;
  fallbackVersion: string;
  ghCli: string;
  runAttempt: number;
  runId: number;
  tag: typeof releaseTag;
  vercelCli: string;
}>;

export type PublicationPhase =
  | "before_publication"
  | "publication_unknown"
  | "published_acceptance_failed";

export type PublicationLease = Readonly<{
  expectedCommit: string;
  holder: string;
  runAttempt: number;
  runId: number;
}>;

export type PublicationLeaseCancellation = "cancelled" | "published";

export type ReviewedSourceAuthority = Readonly<{
  archive: Buffer;
  notes: string;
}>;

export type PublicationLeaseRecoveryReceipt = Readonly<{
  expectedCommit: string;
  holder: string;
  repository: typeof repository;
  runAttempt: number | null;
  runId: number | null;
  schemaVersion: 1;
  state: "active" | "bound" | "cancelled" | "dispatching" | "published";
  tag: typeof releaseTag;
  workflow: typeof workflowPath;
}>;

export type PublicationLeaseRecoveryResult = Readonly<{
  commit: string;
  holder: string;
  status: "published" | "retry_permitted";
  tag: typeof releaseTag;
}>;

export type PublicationLeaseReceiptPersistenceBoundary =
  | "directory_opened"
  | "directory_synced"
  | "file_synced"
  | "read_back"
  | "renamed"
  | "temporary_opened"
  | "written";

type PublicationFailureCode =
  | "accepted_artifact_invalid"
  | "command_failed"
  | "draft_invalid"
  | "immutable_release_disabled"
  | "hosted_authority_invalid"
  | "local_source_invalid"
  | "provider_result_invalid"
  | "public_acceptance_failed"
  | "publication_lease_cleanup_failed"
  | "publication_lease_completed"
  | "publication_lease_lost"
  | "publication_lease_unavailable"
  | "publication_unknown"
  | "published_release_invalid"
  | "release_authority_changed"
  | "tag_protection_invalid"
  | "usage_invalid"
  | "workflow_run_invalid";

export class ReleasePublicationError extends Error {
  constructor(
    readonly code: PublicationFailureCode,
    readonly phase: PublicationPhase = "before_publication",
    readonly leaseRunId?: number,
    readonly receiptPath?: string,
  ) {
    super(code);
    this.name = "ReleasePublicationError";
  }
}

const takeOption = (values: string[], name: string): string => {
  const index = values.indexOf(name);
  if (index < 0) throw new ReleasePublicationError("usage_invalid");
  const value = values[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new ReleasePublicationError("usage_invalid");
  }
  values.splice(index, 2);
  return value;
};

const takeFlag = (values: string[], name: string): boolean => {
  const index = values.indexOf(name);
  if (index < 0) return false;
  values.splice(index, 1);
  return true;
};

export function parsePublicationArguments(arguments_: readonly string[]): PublicationArguments {
  const values = [...arguments_];
  const action = values.shift();
  if (action !== "publish" && action !== "accept") {
    throw new ReleasePublicationError("usage_invalid");
  }
  const tag = takeOption(values, "--tag");
  const expectedCommit = takeOption(values, "--expected-commit");
  const deploymentId = takeOption(values, "--deployment-id");
  const deploymentUrl = takeOption(values, "--deployment-url");
  const fallbackDeploymentId = takeOption(values, "--fallback-deployment-id");
  const fallbackDeploymentUrl = takeOption(values, "--fallback-deployment-url");
  const fallbackVersion = takeOption(values, "--fallback-version");
  const runIdText = takeOption(values, "--run-id");
  const runAttemptText = takeOption(values, "--run-attempt");
  const ghCli = takeOption(values, "--gh-cli");
  const vercelCli = takeOption(values, "--vercel-cli");
  const acknowledged = takeFlag(values, "--acknowledge-immutable-publication");
  const runId = Number(runIdText);
  const runAttempt = Number(runAttemptText);
  if (
    values.length !== 0
    || tag !== releaseTag
    || !commitSchema.safeParse(expectedCommit).success
    || !deploymentIdSchema.safeParse(deploymentId).success
    || !deploymentUrlSchema.safeParse(deploymentUrl).success
    || !deploymentIdSchema.safeParse(fallbackDeploymentId).success
    || !deploymentUrlSchema.safeParse(fallbackDeploymentUrl).success
    || !versionSchema.safeParse(fallbackVersion).success
    || deploymentId === fallbackDeploymentId
    || deploymentUrl === fallbackDeploymentUrl
    || !/^[1-9][0-9]*$/u.test(runIdText)
    || !/^[1-9][0-9]*$/u.test(runAttemptText)
    || !positiveIntegerSchema.safeParse(runId).success
    || !positiveIntegerSchema.safeParse(runAttempt).success
    || !isAbsolute(ghCli)
    || ghCli.length > 4_096
    || !isAbsolute(vercelCli)
    || vercelCli.length > 4_096
    || (action === "publish") !== acknowledged
  ) throw new ReleasePublicationError("usage_invalid");
  return {
    action,
    deploymentId,
    deploymentUrl,
    expectedCommit,
    fallbackDeploymentId,
    fallbackDeploymentUrl,
    fallbackVersion,
    ghCli,
    runAttempt,
    runId,
    tag: releaseTag,
    vercelCli,
  };
}

export function parsePublicationRecoveryArguments(
  arguments_: readonly string[],
): PublicationRecoveryArguments {
  const values = [...arguments_];
  if (values.shift() !== "recover") {
    throw new ReleasePublicationError("usage_invalid");
  }
  const tag = takeOption(values, "--tag");
  const expectedCommit = takeOption(values, "--expected-commit");
  const receipt = takeOption(values, "--receipt");
  const ghCli = takeOption(values, "--gh-cli");
  const acknowledged = takeFlag(values, "--acknowledge-cancel-prepublication-leases");
  if (
    values.length !== 0
    || tag !== releaseTag
    || !commitSchema.safeParse(expectedCommit).success
    || !isAbsolute(receipt)
    || receipt.length > 4_096
    || !isAbsolute(ghCli)
    || ghCli.length > 4_096
    || !acknowledged
  ) throw new ReleasePublicationError("usage_invalid");
  return {
    action: "recover",
    expectedCommit,
    ghCli,
    receipt,
    tag: releaseTag,
  };
}

export const releaseArtifactName = (runId: number, runAttempt: number): string => {
  if (
    !positiveIntegerSchema.safeParse(runId).success
    || !positiveIntegerSchema.safeParse(runAttempt).success
  ) throw new ReleasePublicationError("workflow_run_invalid");
  return `${artifactNamePrefix}${String(runId)}-attempt-${String(runAttempt)}`;
};

export interface ReleasePublicationProvider {
  acquirePublicationLease(expectedCommit: string): Promise<PublicationLease>;
  acceptPackedInstall(archive: string, temporaryRoot: string): Promise<void>;
  acceptPublicInstall(url: string, temporaryRoot: string, expectedDigest: string): Promise<void>;
  assertPublicationLease(lease: PublicationLease, expectedCommit: string): Promise<void>;
  cancelPublicationLease(lease: PublicationLease): Promise<PublicationLeaseCancellation>;
  completePublicationLease(lease: PublicationLease): Promise<void>;
  downloadPublicReleaseAsset(name: string, destination: string): Promise<void>;
  downloadReleaseAsset(assetId: number, destination: string): Promise<void>;
  downloadRunArtifact(runId: number, name: string, destination: string): Promise<void>;
  listReleaseAssets(releaseId: number): Promise<unknown>;
  listReleases(): Promise<unknown>;
  publishDraft(releaseId: number, notes: string): Promise<unknown>;
  readHostedAlias(aliasName: ManagedAlias): Promise<AliasReadback>;
  readHostedDeployment(deploymentId: string): Promise<DeploymentReadback>;
  readHostedDomainNames(projectId: string): Promise<readonly string[]>;
  readHostedMarker(aliasName: ManagedAlias): Promise<unknown>;
  readHostedProject(projectId: string): Promise<ProjectReadback>;
  readImmutableSetting(): Promise<unknown>;
  readMainComparison(expectedCommit: string): Promise<unknown>;
  readReviewedSourceAuthority(temporaryRoot: string): Promise<ReviewedSourceAuthority>;
  readRepository(): Promise<unknown>;
  readRun(runId: number): Promise<unknown>;
  readRunArtifacts(runId: number): Promise<unknown>;
  readTagCommit(tag: string): Promise<string>;
  readTagProtection(): Promise<unknown>;
  readWorkflow(): Promise<unknown>;
  verifyLocalSource(expectedCommit: string): Promise<void>;
  verifyVercelVersion(): Promise<void>;
}

const repositorySchema = z.object({
  full_name: z.literal(repository),
  id: z.literal(repositoryId),
}).passthrough();

const workflowSchema = z.object({
  id: positiveIntegerSchema,
  name: z.literal(workflowName),
  path: z.literal(workflowPath),
  state: z.literal("active"),
}).passthrough();

const runSchema = z.object({
  conclusion: z.literal("success"),
  event: z.literal("push"),
  head_branch: z.literal(releaseTag),
  head_sha: commitSchema,
  id: positiveIntegerSchema,
  name: z.literal(workflowName),
  path: z.string().min(1).max(512),
  repository: repositorySchema,
  run_attempt: positiveIntegerSchema,
  status: z.literal("completed"),
  workflow_id: positiveIntegerSchema,
}).passthrough();

const publicationLeaseRunSchema = z.object({
  conclusion: z.enum(["action_required", "cancelled", "failure", "neutral", "skipped", "stale", "startup_failure", "success", "timed_out"]).nullable(),
  display_title: z.string().min(1).max(256),
  event: z.literal("workflow_dispatch"),
  head_branch: z.literal(releaseTag),
  head_sha: commitSchema,
  id: positiveIntegerSchema,
  name: z.literal(workflowName),
  path: z.string().min(1).max(512),
  repository: repositorySchema,
  run_attempt: positiveIntegerSchema,
  run_started_at: z.string().datetime({ offset: true }).nullable(),
  status: z.enum(["completed", "in_progress", "pending", "queued", "requested", "waiting"]),
}).passthrough();

const publicationLeaseRunsEnvelopeSchema = z.object({
  workflow_runs: z.array(z.unknown()).max(100),
}).passthrough();

const publicationLeaseDispatchResponseSchema = z.object({
  html_url: z.string().url(),
  run_url: z.string().url(),
  workflow_run_id: positiveIntegerSchema,
}).passthrough();

const publicationLeaseRecoveryReceiptSchema = z.object({
  expectedCommit: commitSchema,
  holder: z.string().regex(/^[0-9a-f]{32}$/u),
  repository: z.literal(repository),
  runAttempt: positiveIntegerSchema.nullable(),
  runId: positiveIntegerSchema.nullable(),
  schemaVersion: z.literal(1),
  state: z.enum(["active", "bound", "cancelled", "dispatching", "published"]),
  tag: z.literal(releaseTag),
  workflow: z.literal(workflowPath),
}).strict().superRefine((receipt, context) => {
  const hasRunIdentity = receipt.runId !== null && receipt.runAttempt !== null;
  if ((receipt.runId === null) !== (receipt.runAttempt === null)) {
    context.addIssue({ code: "custom", message: "partial run identity" });
  }
  if (receipt.state !== "dispatching" && !hasRunIdentity) {
    context.addIssue({ code: "custom", message: "missing run identity" });
  }
  if (receipt.state === "dispatching" && hasRunIdentity) {
    context.addIssue({ code: "custom", message: "unexpected run identity" });
  }
});

const artifactSchema = z.object({
  expired: z.boolean(),
  id: positiveIntegerSchema,
  name: artifactNameSchema,
  workflow_run: z.object({ id: positiveIntegerSchema }).passthrough(),
}).passthrough();

const artifactListSchema = z.object({
  artifacts: z.array(artifactSchema).max(100),
  total_count: z.number().int().nonnegative().max(100),
}).passthrough();

const releaseSchema = z.object({
  body: z.string().max(256 * 1024),
  draft: z.boolean(),
  id: positiveIntegerSchema,
  immutable: z.boolean(),
  name: z.string().max(256),
  prerelease: z.boolean(),
  tag_name: z.string().max(128),
}).passthrough();

const releaseAssetSchema = z.object({
  id: positiveIntegerSchema,
  name: z.string().min(1).max(256),
  state: z.literal("uploaded"),
}).passthrough();

const immutableSettingSchema = z.object({
  enabled: z.literal(true),
  enforced_by_owner: z.boolean(),
}).passthrough();

const mainComparisonSchema = z.object({
  base_commit: z.object({ sha: commitSchema }).passthrough(),
  merge_base_commit: z.object({ sha: commitSchema }).passthrough(),
  status: z.enum(["ahead", "identical"]),
}).passthrough();

const tagProtectionSchema = z.object({
  bypass_actors: z.tuple([]),
  conditions: z.object({
    ref_name: z.object({
      exclude: z.tuple([]),
      include: z.tuple([z.literal("refs/tags/v*")]),
    }).strict(),
  }).strict(),
  current_user_can_bypass: z.literal("never"),
  enforcement: z.literal("active"),
  id: z.literal(immutableVersionTagsRulesetId),
  name: z.literal("Immutable version tags"),
  rules: z.array(z.object({ type: z.enum(["deletion", "update"]) }).passthrough()).length(2),
  source: z.literal(repository),
  source_type: z.literal("Repository"),
  target: z.literal("tag"),
}).passthrough();

const hostedMarkerSchema = z.object({
  generation: z.literal(1),
  product: z.literal("HRA"),
  repository: z.object({
    id: z.literal(repositoryId),
    path: z.literal(repository),
  }).strict(),
  schemaVersion: z.literal(2),
  source: z.object({ commit: commitSchema }).strict(),
  version: z.literal(releaseVersion),
}).strict();

const fallbackMarkerSchema = z.object({
  generation: z.literal(0),
  product: z.literal("HRA"),
  publication: z.object({ version: versionSchema }).passthrough(),
  repository: z.object({
    id: z.literal(oldRepositoryId),
    path: z.literal("hraness/hra-v0"),
  }).strict(),
  schemaVersion: z.literal(2),
  source: z.object({ commit: commitSchema }).strict(),
}).strict();

const hostedAliasReadbackSchema = z.object({
  alias: z.enum([canonicalAlias, fallbackAlias, stagingAlias]),
  deployment: z.object({
    id: deploymentIdSchema,
    url: deploymentUrlSchema,
  }).passthrough(),
  deploymentId: deploymentIdSchema,
  projectId: z.enum([oldProjectId, newProjectId]),
}).passthrough();

const hostedDeploymentReadbackSchema = z.object({
  gitSource: z.object({
    ref: z.literal("main"),
    repoId: z.number().int().positive(),
    sha: commitSchema,
    type: z.literal("github"),
  }).passthrough(),
  id: deploymentIdSchema,
  projectId: z.enum([oldProjectId, newProjectId]),
  readyState: z.literal("READY"),
  url: deploymentUrlSchema,
}).passthrough();

const hostedProjectReadbackSchema = z.object({
  accountId: z.literal(teamId),
  autoAssignCustomDomains: z.boolean(),
  id: z.enum([oldProjectId, newProjectId]),
}).passthrough();

const expectedReleaseAssetNames = [
  "SHA256SUMS",
  `hra-${releaseTag}.artifact.spdx.json`,
  `hra-${releaseTag}.tgz`,
  `hra-${releaseTag}.ubuntu-24.04-x64.runtime.spdx.json`,
] as const;
const expectedReleaseAssetNameSet = new Set<string>(expectedReleaseAssetNames);

const expectedChecksumNames = [
  `hra-${releaseTag}.tgz`,
  `hra-${releaseTag}.artifact.spdx.json`,
  `hra-${releaseTag}.ubuntu-24.04-x64.runtime.spdx.json`,
] as const;

const expectedAcceptedNames = [
  ...expectedReleaseAssetNames,
  "RELEASE_COMMIT",
  "RELEASE_NOTES.md",
].sort();

const readBounded = async (file: string, maximumBytes: number): Promise<Buffer> => {
  const metadata = await lstat(file);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > maximumBytes) {
    throw new ReleasePublicationError("accepted_artifact_invalid");
  }
  return await readFile(file);
};

const sha256 = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const readResponseBounded = async (
  response: Response,
  maximumBytes: number,
  failureCode: "public_acceptance_failed",
): Promise<Uint8Array> => {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null
    && (!/^[0-9]+$/u.test(contentLength) || Number(contentLength) > maximumBytes)
  ) throw new ReleasePublicationError(failureCode);
  const reader = response.body?.getReader();
  if (reader === undefined) throw new ReleasePublicationError(failureCode);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let next = await reader.read();
  while (!next.done) {
    bytes += next.value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new ReleasePublicationError(failureCode);
    }
    chunks.push(next.value);
    next = await reader.read();
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
};

type AcceptedBundle = Readonly<{
  archive: string;
  commit: string;
  notes: string;
  releaseAssets: ReadonlyMap<string, Buffer>;
}>;

const parseJsonBuffer = (value: Buffer): unknown => {
  try {
    return JSON.parse(value.toString("utf8")) as unknown;
  } catch {
    throw new ReleasePublicationError("accepted_artifact_invalid");
  }
};

const asObject = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ReleasePublicationError("accepted_artifact_invalid");
  }
  return value as Record<string, unknown>;
};

const verifyArtifactSbom = (
  value: unknown,
  archiveDigest: string,
): void => {
  const packages = asObject(value).packages;
  if (!Array.isArray(packages) || packages.length !== 1) {
    throw new ReleasePublicationError("accepted_artifact_invalid");
  }
  const package_ = asObject(packages[0]);
  if (package_.name !== "hra" || package_.versionInfo !== releaseVersion) {
    throw new ReleasePublicationError("accepted_artifact_invalid");
  }
  if (
    !Array.isArray(package_.checksums)
    || !package_.checksums.some((entry) => {
      const checksum = asObject(entry);
      return checksum.algorithm === "SHA256" && checksum.checksumValue === archiveDigest;
    })
  ) throw new ReleasePublicationError("accepted_artifact_invalid");
};

const verifyRuntimeSbom = (value: unknown): void => {
  const packages = asObject(value).packages;
  if (!Array.isArray(packages)) {
    throw new ReleasePublicationError("accepted_artifact_invalid");
  }
  const required = [
    ["hra", releaseVersion],
    ["@openai/codex", "0.149.0"],
    ["convex", "1.45.0"],
    ["zod", "4.4.3"],
  ] as const;
  for (const [name, version] of required) {
    if (!packages.some((entry) => {
      const package_ = asObject(entry);
      return package_.name === name && package_.versionInfo === version;
    })) throw new ReleasePublicationError("accepted_artifact_invalid");
  }
  const serialized = JSON.stringify(value);
  if (/\/(?:home\/runner|private\/tmp|tmp\/hra-release-publish-)/u.test(serialized)) {
    throw new ReleasePublicationError("accepted_artifact_invalid");
  }
};

export async function verifyAcceptedBundle(
  directory: string,
  expectedCommit: string,
): Promise<AcceptedBundle> {
  const names = (await readdir(directory)).sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedAcceptedNames)) {
    throw new ReleasePublicationError("accepted_artifact_invalid");
  }
  const commit = (await readBounded(join(directory, "RELEASE_COMMIT"), 128))
    .toString("utf8").trimEnd();
  if (commit !== expectedCommit || !commitSchema.safeParse(commit).success) {
    throw new ReleasePublicationError("accepted_artifact_invalid");
  }
  const notesBuffer = await readBounded(join(directory, "RELEASE_NOTES.md"), 256 * 1024);
  const notes = notesBuffer.toString("utf8");
  if (notes.trim().length === 0 || notes !== notes.trimEnd()) {
    throw new ReleasePublicationError("accepted_artifact_invalid");
  }
  const checksumBuffer = await readBounded(join(directory, "SHA256SUMS"), 8 * 1024);
  const checksumText = checksumBuffer.toString("utf8");
  if (!checksumText.endsWith("\n")) {
    throw new ReleasePublicationError("accepted_artifact_invalid");
  }
  const checksumLines = checksumText.slice(0, -1).split("\n");
  const checksums = new Map<string, string>();
  for (const line of checksumLines) {
    const match = /^([0-9a-f]{64}) {2}([^/]+)$/u.exec(line);
    if (match === null || checksums.has(match[2] ?? "")) {
      throw new ReleasePublicationError("accepted_artifact_invalid");
    }
    checksums.set(match[2] ?? "", match[1] ?? "");
  }
  if (JSON.stringify([...checksums.keys()]) !== JSON.stringify([...expectedChecksumNames])) {
    throw new ReleasePublicationError("accepted_artifact_invalid");
  }
  const releaseAssets = new Map<string, Buffer>();
  for (const name of expectedReleaseAssetNames) {
    const value = await readBounded(
      join(directory, name),
      name.endsWith(".tgz") ? 32 * 1024 * 1024 : 16 * 1024 * 1024,
    );
    releaseAssets.set(name, value);
    const expectedDigest = checksums.get(name);
    if (expectedDigest !== undefined && sha256(value) !== expectedDigest) {
      throw new ReleasePublicationError("accepted_artifact_invalid");
    }
  }
  const archiveName = `hra-${releaseTag}.tgz`;
  const archive = join(directory, archiveName);
  const archiveDigest = sha256(releaseAssets.get(archiveName) ?? Buffer.alloc(0));
  verifyArtifactSbom(
    parseJsonBuffer(releaseAssets.get(`hra-${releaseTag}.artifact.spdx.json`) ?? Buffer.alloc(0)),
    archiveDigest,
  );
  verifyRuntimeSbom(
    parseJsonBuffer(
      releaseAssets.get(`hra-${releaseTag}.ubuntu-24.04-x64.runtime.spdx.json`)
        ?? Buffer.alloc(0),
    ),
  );
  return { archive, commit, notes, releaseAssets };
}

const exactRelease = (value: unknown): z.infer<typeof releaseSchema> => {
  if (!Array.isArray(value)) throw new ReleasePublicationError("provider_result_invalid");
  const matches = value
    .map((entry) => releaseSchema.parse(entry))
    .filter((entry) => entry.tag_name === releaseTag);
  if (matches.length !== 1) throw new ReleasePublicationError("draft_invalid");
  return matches[0] as z.infer<typeof releaseSchema>;
};

const exactAssets = (value: unknown): readonly z.infer<typeof releaseAssetSchema>[] => {
  if (!Array.isArray(value)) throw new ReleasePublicationError("provider_result_invalid");
  const assets = value.map((entry) => releaseAssetSchema.parse(entry));
  const names = assets.map((entry) => entry.name).sort();
  if (JSON.stringify(names) !== JSON.stringify([...expectedReleaseAssetNames])) {
    throw new ReleasePublicationError("draft_invalid");
  }
  return assets;
};

const downloadAndVerifyAssets = async (
  provider: ReleasePublicationProvider,
  releaseId: number,
  directory: string,
  accepted: AcceptedBundle,
): Promise<string> => {
  await mkdir(directory, { mode: 0o700 });
  const assets = exactAssets(await provider.listReleaseAssets(releaseId));
  for (const asset of assets) {
    const destination = join(directory, asset.name);
    await provider.downloadReleaseAsset(asset.id, destination);
    const downloaded = await readBounded(destination, 32 * 1024 * 1024);
    const expected = accepted.releaseAssets.get(asset.name);
    if (expected === undefined || !downloaded.equals(expected)) {
      throw new ReleasePublicationError("draft_invalid");
    }
  }
  return JSON.stringify(
    assets
      .map((asset) => ({ id: asset.id, name: asset.name, state: asset.state }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  );
};

const verifyDraftIdentity = async (
  provider: ReleasePublicationProvider,
  accepted: AcceptedBundle,
  releaseId: number,
  expectedAssetIdentity: string,
): Promise<void> => {
  const release = exactRelease(await provider.listReleases());
  verifyReleaseMetadata(release, accepted, true);
  if (release.id !== releaseId) throw new ReleasePublicationError("draft_invalid");
  const assets = exactAssets(await provider.listReleaseAssets(release.id));
  const identity = JSON.stringify(
    assets
      .map((asset) => ({ id: asset.id, name: asset.name, state: asset.state }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  );
  if (identity !== expectedAssetIdentity) throw new ReleasePublicationError("draft_invalid");
};

const verifyPublishedIdentity = async (
  provider: ReleasePublicationProvider,
  accepted: AcceptedBundle,
  releaseId: number,
  expectedAssetIdentity: string,
): Promise<void> => {
  const release = exactRelease(await provider.listReleases());
  verifyReleaseMetadata(release, accepted, false);
  if (release.id !== releaseId) {
    throw new ReleasePublicationError("published_release_invalid");
  }
  const assets = exactAssets(await provider.listReleaseAssets(release.id));
  const identity = JSON.stringify(
    assets
      .map((asset) => ({ id: asset.id, name: asset.name, state: asset.state }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  );
  if (identity !== expectedAssetIdentity) {
    throw new ReleasePublicationError("published_release_invalid");
  }
};

const recoverAcceptedBundleFromPublishedRelease = async (
  provider: ReleasePublicationProvider,
  release: z.infer<typeof releaseSchema>,
  expectedCommit: string,
  directory: string,
): Promise<AcceptedBundle> => {
  if (
    release.tag_name !== releaseTag
    || release.name !== title
    || !release.prerelease
    || release.draft
    || !release.immutable
    || release.body.trim().length === 0
    || release.body !== release.body.trimEnd()
  ) throw new ReleasePublicationError(
    "published_release_invalid",
    "published_acceptance_failed",
  );
  await mkdir(directory, { mode: 0o700 });
  await Promise.all(expectedReleaseAssetNames.map(async (name) => {
    await provider.downloadPublicReleaseAsset(name, join(directory, name));
  }));
  await Promise.all([
    writeFile(join(directory, "RELEASE_COMMIT"), `${expectedCommit}\n`, {
      flag: "wx",
      mode: 0o600,
    }),
    writeFile(join(directory, "RELEASE_NOTES.md"), release.body, {
      flag: "wx",
      mode: 0o600,
    }),
  ]);
  try {
    return await verifyAcceptedBundle(directory, expectedCommit);
  } catch {
    throw new ReleasePublicationError(
      "published_release_invalid",
      "published_acceptance_failed",
    );
  }
};

const recoverAcceptedBundleFromDraftRelease = async (
  provider: ReleasePublicationProvider,
  release: z.infer<typeof releaseSchema>,
  expectedCommit: string,
  directory: string,
): Promise<Readonly<{ accepted: AcceptedBundle; assetIdentity: string }>> => {
  if (
    release.tag_name !== releaseTag
    || release.name !== title
    || !release.prerelease
    || !release.draft
    || release.immutable
    || release.body.trim().length === 0
    || release.body !== release.body.trimEnd()
  ) throw new ReleasePublicationError("draft_invalid");
  await mkdir(directory, { mode: 0o700 });
  const assets = exactAssets(await provider.listReleaseAssets(release.id));
  for (const asset of assets) {
    await provider.downloadReleaseAsset(asset.id, join(directory, asset.name));
  }
  await Promise.all([
    writeFile(join(directory, "RELEASE_COMMIT"), `${expectedCommit}\n`, {
      flag: "wx",
      mode: 0o600,
    }),
    writeFile(join(directory, "RELEASE_NOTES.md"), release.body, {
      flag: "wx",
      mode: 0o600,
    }),
  ]);
  const accepted = await verifyAcceptedBundle(directory, expectedCommit);
  verifyReleaseMetadata(release, accepted, true);
  return {
    accepted,
    assetIdentity: JSON.stringify(
      assets
        .map((asset) => ({ id: asset.id, name: asset.name, state: asset.state }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    ),
  };
};

const verifyReviewedSourceAuthority = async (
  provider: ReleasePublicationProvider,
  accepted: AcceptedBundle,
  temporaryRoot: string,
  phase: PublicationPhase,
): Promise<void> => {
  let reviewed: ReviewedSourceAuthority;
  try {
    reviewed = await provider.readReviewedSourceAuthority(temporaryRoot);
  } catch {
    throw new ReleasePublicationError(
      phase === "before_publication" ? "accepted_artifact_invalid" : "published_release_invalid",
      phase,
    );
  }
  const archive = accepted.releaseAssets.get(`hra-${releaseTag}.tgz`);
  if (
    archive === undefined
    || !archive.equals(reviewed.archive)
    || accepted.notes !== reviewed.notes
  ) throw new ReleasePublicationError(
    phase === "before_publication" ? "accepted_artifact_invalid" : "published_release_invalid",
    phase,
  );
};

const verifyRunIdentity = async (
  provider: ReleasePublicationProvider,
  arguments_: PublicationArguments,
): Promise<void> => {
  repositorySchema.parse(await provider.readRepository());
  const workflow = workflowSchema.parse(await provider.readWorkflow());
  const run = runSchema.parse(await provider.readRun(arguments_.runId));
  const fullTagRef = ["refs", "tags", releaseTag].join("/");
  const acceptedPaths = [workflowPath, `${workflowPath}@${releaseTag}`, `${workflowPath}@${fullTagRef}`];
  if (
    run.id !== arguments_.runId
    || run.run_attempt !== arguments_.runAttempt
    || run.workflow_id !== workflow.id
    || run.head_sha !== arguments_.expectedCommit
    || !acceptedPaths.includes(run.path)
  ) throw new ReleasePublicationError("workflow_run_invalid");
};

const verifyRunArtifactAuthority = async (
  provider: ReleasePublicationProvider,
  arguments_: PublicationArguments,
): Promise<string> => {
  const artifactList = artifactListSchema.parse(await provider.readRunArtifacts(arguments_.runId));
  const expectedArtifactName = releaseArtifactName(arguments_.runId, arguments_.runAttempt);
  const attempts = new Set<number>();
  for (const artifact of artifactList.artifacts) {
    const prefix = `${artifactNamePrefix}${String(arguments_.runId)}-attempt-`;
    const attemptText = artifact.name.startsWith(prefix)
      ? artifact.name.slice(prefix.length)
      : "";
    const attempt = Number(attemptText);
    if (
      artifact.workflow_run.id !== arguments_.runId
      || !/^[1-9][0-9]*$/u.test(attemptText)
      || !positiveIntegerSchema.safeParse(attempt).success
      || attempts.has(attempt)
    ) throw new ReleasePublicationError("workflow_run_invalid");
    attempts.add(attempt);
  }
  const exactArtifacts = artifactList.artifacts.filter(
    (artifact) => artifact.name === expectedArtifactName,
  );
  if (
    artifactList.total_count !== artifactList.artifacts.length
    || exactArtifacts.length !== 1
    || exactArtifacts[0]?.expired !== false
  ) throw new ReleasePublicationError("workflow_run_invalid");
  return expectedArtifactName;
};

const verifyReleaseMetadata = (
  release: z.infer<typeof releaseSchema>,
  accepted: AcceptedBundle,
  expectedDraft: boolean,
): void => {
  if (
    release.tag_name !== releaseTag
    || release.name !== title
    || release.body !== accepted.notes
    || !release.prerelease
    || release.draft !== expectedDraft
    || release.immutable !== !expectedDraft
  ) throw new ReleasePublicationError(expectedDraft ? "draft_invalid" : "published_release_invalid");
};

const verifyFinalPublicationAuthority = async (
  provider: ReleasePublicationProvider,
  arguments_: Pick<PublicationArguments, "expectedCommit" | "tag">,
): Promise<void> => {
  const [tagCommit, mainComparisonValue, tagProtectionValue, immutableSetting] = await Promise.all([
    provider.readTagCommit(arguments_.tag),
    provider.readMainComparison(arguments_.expectedCommit),
    provider.readTagProtection(),
    provider.readImmutableSetting(),
  ]);
  const mainComparison = mainComparisonSchema.safeParse(mainComparisonValue);
  if (
    tagCommit !== arguments_.expectedCommit
    || !mainComparison.success
    || mainComparison.data.base_commit.sha !== arguments_.expectedCommit
    || mainComparison.data.merge_base_commit.sha !== arguments_.expectedCommit
  ) {
    throw new ReleasePublicationError("release_authority_changed");
  }
  const tagProtection = tagProtectionSchema.safeParse(tagProtectionValue);
  if (
    !tagProtection.success
    || JSON.stringify(tagProtection.data.rules.map((rule) => rule.type).sort())
      !== JSON.stringify(["deletion", "update"])
  ) throw new ReleasePublicationError("tag_protection_invalid");
  try {
    immutableSettingSchema.parse(immutableSetting);
  } catch {
    throw new ReleasePublicationError("immutable_release_disabled");
  }
};

const aliasMatches = (
  value: AliasReadback,
  alias: ManagedAlias,
  deploymentId: string,
  deploymentUrl: string,
  projectId: string,
): boolean => value.alias === alias
  && value.deploymentId === deploymentId
  && value.deployment.id === deploymentId
  && value.deployment.url === deploymentUrl
  && value.projectId === projectId;

const deploymentMatches = (
  value: DeploymentReadback,
  deploymentId: string,
  deploymentUrl: string,
  projectId: string,
  expectedRepositoryId: number,
  expectedCommit?: string,
): boolean => value.id === deploymentId
  && value.url === deploymentUrl
  && value.projectId === projectId
  && value.gitSource.repoId === expectedRepositoryId
  && (expectedCommit === undefined || value.gitSource.sha === expectedCommit);

const verifyHostedPublicationAuthority = async (
  provider: ReleasePublicationProvider,
  arguments_: PublicationArguments,
): Promise<void> => {
  try {
    await provider.verifyVercelVersion();
    const [
      oldProject,
      newProject,
      deployment,
      fallbackDeployment,
      canonical,
      fallback,
      staging,
      oldDomains,
      newDomains,
      canonicalMarker,
      fallbackMarker,
      stagingMarker,
    ] = await Promise.all([
      provider.readHostedProject(oldProjectId),
      provider.readHostedProject(newProjectId),
      provider.readHostedDeployment(arguments_.deploymentId),
      provider.readHostedDeployment(arguments_.fallbackDeploymentId),
      provider.readHostedAlias(canonicalAlias),
      provider.readHostedAlias(fallbackAlias),
      provider.readHostedAlias(stagingAlias),
      provider.readHostedDomainNames(oldProjectId),
      provider.readHostedDomainNames(newProjectId),
      provider.readHostedMarker(canonicalAlias),
      provider.readHostedMarker(fallbackAlias),
      provider.readHostedMarker(stagingAlias),
    ]);
    const oldProjectValue = hostedProjectReadbackSchema.parse(oldProject);
    const newProjectValue = hostedProjectReadbackSchema.parse(newProject);
    const deploymentValue = hostedDeploymentReadbackSchema.parse(deployment);
    const fallbackDeploymentValue = hostedDeploymentReadbackSchema.parse(fallbackDeployment);
    const canonicalValue = hostedAliasReadbackSchema.parse(canonical);
    const fallbackValue = hostedAliasReadbackSchema.parse(fallback);
    const stagingValue = hostedAliasReadbackSchema.parse(staging);
    const canonicalMarkerValue = hostedMarkerSchema.safeParse(canonicalMarker);
    const fallbackMarkerValue = fallbackMarkerSchema.safeParse(fallbackMarker);
    const stagingMarkerValue = hostedMarkerSchema.safeParse(stagingMarker);
    if (
      oldProjectValue.id !== oldProjectId
      || newProjectValue.id !== newProjectId
      || oldProjectValue.autoAssignCustomDomains
      || newProjectValue.autoAssignCustomDomains
      || !deploymentMatches(
        deploymentValue,
        arguments_.deploymentId,
        arguments_.deploymentUrl,
        newProjectId,
        repositoryId,
        arguments_.expectedCommit,
      )
      || !deploymentMatches(
        fallbackDeploymentValue,
        arguments_.fallbackDeploymentId,
        arguments_.fallbackDeploymentUrl,
        oldProjectId,
        oldRepositoryId,
      )
      || !aliasMatches(
        canonicalValue,
        canonicalAlias,
        arguments_.deploymentId,
        arguments_.deploymentUrl,
        newProjectId,
      )
      || !aliasMatches(
        fallbackValue,
        fallbackAlias,
        arguments_.fallbackDeploymentId,
        arguments_.fallbackDeploymentUrl,
        oldProjectId,
      )
      || !aliasMatches(
        stagingValue,
        stagingAlias,
        arguments_.deploymentId,
        arguments_.deploymentUrl,
        newProjectId,
      )
      || oldDomains.filter((name) => name === canonicalAlias).length !== 0
      || newDomains.filter((name) => name === canonicalAlias).length !== 1
      || !canonicalMarkerValue.success
      || canonicalMarkerValue.data.source.commit !== arguments_.expectedCommit
      || !stagingMarkerValue.success
      || stagingMarkerValue.data.source.commit !== arguments_.expectedCommit
      || !fallbackMarkerValue.success
      || fallbackMarkerValue.data.source.commit !== fallbackDeploymentValue.gitSource.sha
      || fallbackMarkerValue.data.publication.version !== arguments_.fallbackVersion
    ) throw new ReleasePublicationError("hosted_authority_invalid");
  } catch (error: unknown) {
    if (error instanceof ReleasePublicationError) throw error;
    throw new ReleasePublicationError("hosted_authority_invalid");
  }
};

const verifyPublished = async (
  provider: ReleasePublicationProvider,
  accepted: AcceptedBundle,
  temporaryRoot: string,
  expectedReleaseId: number,
): Promise<void> => {
  try {
    const release = exactRelease(await provider.listReleases());
    verifyReleaseMetadata(release, accepted, false);
    if (release.id !== expectedReleaseId) {
      throw new ReleasePublicationError("published_release_invalid");
    }
    await downloadAndVerifyAssets(provider, release.id, join(temporaryRoot, "published-assets"), accepted);
    const publicUrl = `https://github.com/${repository}/releases/download/${releaseTag}/hra-${releaseTag}.tgz`;
    const archive = accepted.releaseAssets.get(`hra-${releaseTag}.tgz`);
    if (archive === undefined) throw new ReleasePublicationError("published_release_invalid");
    await provider.acceptPublicInstall(
      publicUrl,
      join(temporaryRoot, "public-install"),
      sha256(archive),
    );
  } catch (error: unknown) {
    const code = error instanceof ReleasePublicationError
      ? error.code
      : "published_release_invalid";
    throw new ReleasePublicationError(
      code === "public_acceptance_failed" ? code : "published_release_invalid",
      "published_acceptance_failed",
    );
  }
};

const verifyHostedAfterPublication = async (
  provider: ReleasePublicationProvider,
  arguments_: PublicationArguments,
): Promise<void> => {
  try {
    await verifyHostedPublicationAuthority(provider, arguments_);
  } catch {
    throw new ReleasePublicationError(
      "hosted_authority_invalid",
      "published_acceptance_failed",
    );
  }
};

const cancelLeaseAfterRefusal = async (
  provider: ReleasePublicationProvider,
  lease: PublicationLease,
  error: unknown,
  accepted: AcceptedBundle,
  releaseId: number,
  expectedAssetIdentity: string,
): Promise<never> => {
  let outcome: PublicationLeaseCancellation;
  try {
    outcome = await provider.cancelPublicationLease(lease);
  } catch {
    throw new ReleasePublicationError(
      "publication_lease_cleanup_failed",
      "before_publication",
      lease.runId,
    );
  }
  if (outcome === "published") {
    try {
      await verifyPublishedIdentity(
        provider,
        accepted,
        releaseId,
        expectedAssetIdentity,
      );
    } catch {
      throw new ReleasePublicationError(
        "publication_unknown",
        "publication_unknown",
        lease.runId,
      );
    }
    throw new ReleasePublicationError(
      "publication_lease_completed",
      "published_acceptance_failed",
      lease.runId,
    );
  }
  throw error;
};

const acceptPublicInstallationInLease = async (
  provider: ReleasePublicationProvider,
  expectedCommit: string,
): Promise<void> => {
  let lease: PublicationLease;
  try {
    lease = await provider.acquirePublicationLease(expectedCommit);
  } catch (error: unknown) {
    if (
      error instanceof ReleasePublicationError
      && error.code === "publication_lease_completed"
      && error.leaseRunId !== undefined
    ) return;
    const code = error instanceof ReleasePublicationError
      ? error.code
      : "publication_lease_cleanup_failed";
    throw new ReleasePublicationError(
      code,
      "published_acceptance_failed",
      error instanceof ReleasePublicationError ? error.leaseRunId : undefined,
    );
  }
  try {
    await provider.completePublicationLease(lease);
  } catch (error: unknown) {
    if (
      error instanceof ReleasePublicationError
      && error.code === "publication_lease_lost"
    ) throw new ReleasePublicationError(
      "publication_lease_lost",
      "published_acceptance_failed",
      lease.runId,
    );
    throw new ReleasePublicationError(
      "publication_lease_cleanup_failed",
      "published_acceptance_failed",
      lease.runId,
    );
  }
};

export async function executeReleasePublication(options: Readonly<{
  arguments: PublicationArguments;
  provider: ReleasePublicationProvider;
  temporaryRoot: string;
}>): Promise<Readonly<{ commit: string; status: "accepted" | "published"; tag: string }>> {
  const { arguments: arguments_, provider, temporaryRoot } = options;
  await provider.verifyLocalSource(arguments_.expectedCommit);
  await verifyRunIdentity(provider, arguments_);
  const acceptedDirectory = join(temporaryRoot, "accepted");
  let accepted: AcceptedBundle;
  if (arguments_.action === "accept") {
    const publishedRelease = exactRelease(await provider.listReleases());
    accepted = await recoverAcceptedBundleFromPublishedRelease(
      provider,
      publishedRelease,
      arguments_.expectedCommit,
      acceptedDirectory,
    );
  } else {
    const acceptedArtifactName = await verifyRunArtifactAuthority(provider, arguments_);
    await mkdir(acceptedDirectory, { mode: 0o700 });
    await provider.downloadRunArtifact(
      arguments_.runId,
      acceptedArtifactName,
      acceptedDirectory,
    );
    accepted = await verifyAcceptedBundle(acceptedDirectory, arguments_.expectedCommit);
  }
  await verifyReviewedSourceAuthority(
    provider,
    accepted,
    join(temporaryRoot, "reviewed-source"),
    arguments_.action === "publish" ? "before_publication" : "published_acceptance_failed",
  );
  try {
    await provider.acceptPackedInstall(accepted.archive, join(temporaryRoot, "packed-install"));
  } catch {
    if (arguments_.action === "accept") {
      throw new ReleasePublicationError(
        "published_release_invalid",
        "published_acceptance_failed",
      );
    }
    throw new ReleasePublicationError("accepted_artifact_invalid");
  }
  if (arguments_.action === "accept") {
    let acceptedReleaseId: number | undefined;
    try {
      const release = exactRelease(await provider.listReleases());
      verifyReleaseMetadata(release, accepted, false);
      acceptedReleaseId = release.id;
      await downloadAndVerifyAssets(
        provider,
        release.id,
        join(temporaryRoot, "staged-assets"),
        accepted,
      );
    } catch (error: unknown) {
      const code = error instanceof ReleasePublicationError
        ? error.code
        : "published_release_invalid";
      throw new ReleasePublicationError(code, "published_acceptance_failed");
    }
    try {
      await verifyFinalPublicationAuthority(provider, arguments_);
    } catch (error: unknown) {
      const code = error instanceof ReleasePublicationError
        ? error.code
        : "published_release_invalid";
      throw new ReleasePublicationError(code, "published_acceptance_failed");
    }
    await verifyHostedAfterPublication(provider, arguments_);
    await verifyPublished(provider, accepted, temporaryRoot, acceptedReleaseId);
    await acceptPublicInstallationInLease(provider, arguments_.expectedCommit);
    await verifyHostedAfterPublication(provider, arguments_);
    return { commit: accepted.commit, status: "accepted", tag: releaseTag };
  }

  const release = exactRelease(await provider.listReleases());
  verifyReleaseMetadata(release, accepted, true);
  const stagedAssetIdentity = await downloadAndVerifyAssets(
    provider,
    release.id,
    join(temporaryRoot, "staged-assets"),
    accepted,
  );

  await verifyFinalPublicationAuthority(provider, arguments_);
  await verifyHostedPublicationAuthority(provider, arguments_);
  let lease: PublicationLease;
  try {
    lease = await provider.acquirePublicationLease(arguments_.expectedCommit);
  } catch (error: unknown) {
    if (
      error instanceof ReleasePublicationError
      && error.code === "publication_lease_completed"
      && error.leaseRunId !== undefined
    ) {
      try {
        await verifyPublishedIdentity(
          provider,
          accepted,
          release.id,
          stagedAssetIdentity,
        );
      } catch {
        throw new ReleasePublicationError(
          "publication_unknown",
          "publication_unknown",
          error.leaseRunId,
        );
      }
      throw new ReleasePublicationError(
        "publication_lease_completed",
        "published_acceptance_failed",
        error.leaseRunId,
      );
    }
    throw error;
  }
  try {
    await verifyFinalPublicationAuthority(provider, arguments_);
    await verifyHostedPublicationAuthority(provider, arguments_);
    const finalAssetIdentity = await downloadAndVerifyAssets(
      provider,
      release.id,
      join(temporaryRoot, "publication-assets"),
      accepted,
    );
    if (finalAssetIdentity !== stagedAssetIdentity) {
      throw new ReleasePublicationError("draft_invalid");
    }
    await provider.assertPublicationLease(lease, arguments_.expectedCommit);
    await verifyDraftIdentity(provider, accepted, release.id, stagedAssetIdentity);
    await provider.assertPublicationLease(lease, arguments_.expectedCommit);
    try {
      const response = await provider.publishDraft(release.id, accepted.notes);
      const published = releaseSchema.safeParse(response);
      if (published.success && published.data.id === release.id && !published.data.draft) {
        try {
          verifyReleaseMetadata(published.data, accepted, false);
        } catch {
          throw new ReleasePublicationError(
            "published_release_invalid",
            "published_acceptance_failed",
            lease.runId,
          );
        }
      } else {
        throw new ReleasePublicationError("published_release_invalid");
      }
    } catch (error: unknown) {
      if (
        error instanceof ReleasePublicationError
        && error.phase === "published_acceptance_failed"
      ) throw error;
      try {
        await verifyPublishedIdentity(
          provider,
          accepted,
          release.id,
          stagedAssetIdentity,
        );
      } catch {
        // A lost PATCH response cannot be distinguished from a request that never
        // reached GitHub. Keep the exact workflow lease alive for manual readback.
        throw new ReleasePublicationError(
          "publication_unknown",
          "publication_unknown",
          lease.runId,
        );
      }
    }
  } catch (error: unknown) {
    if (
      error instanceof ReleasePublicationError
      && error.phase === "publication_unknown"
    ) throw error;
    if (
      error instanceof ReleasePublicationError
      && error.phase === "published_acceptance_failed"
    ) {
      try {
        await provider.completePublicationLease(lease);
      } catch (completionError: unknown) {
        if (
          completionError instanceof ReleasePublicationError
          && completionError.code === "publication_lease_lost"
        ) throw new ReleasePublicationError(
          "publication_lease_lost",
          "published_acceptance_failed",
          lease.runId,
        );
        throw new ReleasePublicationError(
          "publication_lease_cleanup_failed",
          "published_acceptance_failed",
          lease.runId,
        );
      }
      throw error;
    }
    await cancelLeaseAfterRefusal(
      provider,
      lease,
      error,
      accepted,
      release.id,
      stagedAssetIdentity,
    );
  }
  try {
    await provider.completePublicationLease(lease);
  } catch (completionError: unknown) {
    if (
      completionError instanceof ReleasePublicationError
      && completionError.code === "publication_lease_lost"
    ) throw new ReleasePublicationError(
      "publication_lease_lost",
      "published_acceptance_failed",
      lease.runId,
    );
    throw new ReleasePublicationError(
      "publication_lease_cleanup_failed",
      "published_acceptance_failed",
      lease.runId,
    );
  }
  await verifyHostedAfterPublication(provider, arguments_);
  await verifyPublished(provider, accepted, temporaryRoot, release.id);
  await verifyHostedAfterPublication(provider, arguments_);
  return { commit: accepted.commit, status: "published", tag: releaseTag };
}

type ProcessResult = Readonly<{
  exitCode: number;
  stderr: Buffer;
  stdout: Buffer;
}>;

type ProcessRequest = Readonly<{
  arguments: readonly string[];
  cwd?: string;
  environment?: Readonly<NodeJS.ProcessEnv>;
  executable: string;
  outputMaximumBytes?: number;
  timeoutMs?: number;
}>;

const runProcess = async (request: ProcessRequest): Promise<ProcessResult> =>
  await new Promise<ProcessResult>((resolvePromise) => {
    const child = spawn(request.executable, [...request.arguments], {
      cwd: request.cwd ?? repositoryRoot,
      env: request.environment ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let finished = false;
    const maximum = request.outputMaximumBytes ?? commandOutputMaximumBytes;
    const finish = (exitCode: number): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolvePromise({
        exitCode,
        stderr: Buffer.concat(stderr),
        stdout: Buffer.concat(stdout),
      });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(124);
    }, request.timeoutMs ?? 120_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= maximum) stdout.push(chunk);
      else {
        child.kill("SIGKILL");
        finish(1);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= maximum) stderr.push(chunk);
      else {
        child.kill("SIGKILL");
        finish(1);
      }
    });
    child.once("error", () => finish(1));
    child.once("close", (exitCode) => finish(exitCode ?? 1));
  });

const requireSuccess = (result: ProcessResult): ProcessResult => {
  if (result.exitCode !== 0) throw new ReleasePublicationError("command_failed");
  return result;
};

const parseJson = (result: ProcessResult): unknown => {
  const stdout = requireSuccess(result).stdout;
  if (stdout.byteLength === 0 || stdout.byteLength > providerJsonMaximumBytes) {
    throw new ReleasePublicationError("provider_result_invalid");
  }
  try {
    return JSON.parse(stdout.toString("utf8")) as unknown;
  } catch {
    throw new ReleasePublicationError("provider_result_invalid");
  }
};

const withoutEnvironmentKeys = (
  source: Readonly<NodeJS.ProcessEnv>,
  names: readonly string[],
): NodeJS.ProcessEnv => {
  const omitted = new Set(names);
  return Object.fromEntries(
    Object.entries(source).filter(([name]) => !omitted.has(name)),
  );
};

export const buildGitHubCliEnvironment = (
  source: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv => withoutEnvironmentKeys(source, [
    "GH_ENTERPRISE_TOKEN",
    "GH_HOST",
    "GH_TOKEN",
    "GITHUB_AUTH_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "GITHUB_TOKEN",
  ]);

export const assertLocalOperatorEnvironment = (
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  if (
    environment.GITHUB_ACTIONS === "true"
    || ["1", "true"].includes(environment.CI?.toLowerCase() ?? "")
  ) throw new ReleasePublicationError("local_source_invalid");
};

export const buildCandidateInspectionEnvironment = async (
  temporaryRoot: string,
): Promise<NodeJS.ProcessEnv> => {
  const homeDirectory = join(temporaryRoot, "home");
  const temporaryDirectory = join(temporaryRoot, "tmp");
  const xdgRoot = join(temporaryRoot, "xdg");
  await Promise.all([
    mkdir(homeDirectory, { mode: 0o700 }),
    mkdir(temporaryDirectory, { mode: 0o700 }),
    mkdir(join(xdgRoot, "cache"), { recursive: true, mode: 0o700 }),
    mkdir(join(xdgRoot, "config"), { recursive: true, mode: 0o700 }),
    mkdir(join(xdgRoot, "data"), { recursive: true, mode: 0o700 }),
    mkdir(join(xdgRoot, "state"), { recursive: true, mode: 0o700 }),
  ]);
  return {
    DO_NOT_TRACK: "1",
    HOME: homeDirectory,
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    TMPDIR: temporaryDirectory,
    XDG_CACHE_HOME: join(xdgRoot, "cache"),
    XDG_CONFIG_HOME: join(xdgRoot, "config"),
    XDG_DATA_HOME: join(xdgRoot, "data"),
    XDG_STATE_HOME: join(xdgRoot, "state"),
  };
};

const delay = async (milliseconds: number): Promise<void> =>
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

const publicationLeaseRunTitle = (holder: string): string =>
  `${publicationLeaseTitlePrefix}${holder}`;

export const publicationLeaseDispatchRunId = (value: unknown): number | undefined => {
  const parsed = publicationLeaseDispatchResponseSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const runId = parsed.data.workflow_run_id;
  try {
    const apiUrl = new URL(parsed.data.run_url);
    const htmlUrl = new URL(parsed.data.html_url);
    if (
      apiUrl.origin !== "https://api.github.com"
      || apiUrl.pathname !== `/repos/${repository}/actions/runs/${String(runId)}`
      || htmlUrl.origin !== "https://github.com"
      || htmlUrl.pathname !== `/${repository}/actions/runs/${String(runId)}`
    ) return undefined;
  } catch {
    return undefined;
  }
  return runId;
};

export type PublicationLeaseCandidateScan = Readonly<{
  candidates: readonly z.infer<typeof publicationLeaseRunSchema>[];
  identities: readonly Readonly<{ runAttempt: number | null; runId: number }>[];
  malformedMatchingCandidate: boolean;
  matchingCount: number;
  unidentifiedMatchingCandidate: boolean;
}>;

export const scanPublicationLeaseCandidates = (
  value: unknown,
  holder: string,
): PublicationLeaseCandidateScan => {
  const envelope = publicationLeaseRunsEnvelopeSchema.parse(value);
  const expectedTitle = publicationLeaseRunTitle(holder);
  const matching = envelope.workflow_runs.filter((entry) => (
    typeof entry === "object"
    && entry !== null
    && !Array.isArray(entry)
    && Reflect.get(entry, "display_title") === expectedTitle
  ));
  const candidates: z.infer<typeof publicationLeaseRunSchema>[] = [];
  const identities: Array<Readonly<{ runAttempt: number | null; runId: number }>> = [];
  let malformedMatchingCandidate = false;
  let unidentifiedMatchingCandidate = false;
  for (const entry of matching) {
    const entryObject = entry as object;
    const runId = positiveIntegerSchema.safeParse(Reflect.get(entryObject, "id"));
    const runAttempt = positiveIntegerSchema.safeParse(Reflect.get(entryObject, "run_attempt"));
    if (runId.success) {
      identities.push({
        runAttempt: runAttempt.success ? runAttempt.data : null,
        runId: runId.data,
      });
    } else {
      unidentifiedMatchingCandidate = true;
    }
    const parsed = publicationLeaseRunSchema.safeParse(entry);
    if (parsed.success) candidates.push(parsed.data);
    else malformedMatchingCandidate = true;
  }
  return {
    candidates,
    identities,
    malformedMatchingCandidate,
    matchingCount: matching.length,
    unidentifiedMatchingCandidate,
  };
};

const acceptedWorkflowRunPath = (path: string): boolean => {
  const fullTagRef = ["refs", "tags", releaseTag].join("/");
  return [
    workflowPath,
    `${workflowPath}@${releaseTag}`,
    `${workflowPath}@${fullTagRef}`,
  ].includes(path);
};

export const assertPublicationLeaseRun = (
  value: unknown,
  lease: PublicationLease,
  expectedCommit: string,
  expectedStatus: "active" | "any" | "completed" | "in_progress",
): z.infer<typeof publicationLeaseRunSchema> => {
  const run = publicationLeaseRunSchema.safeParse(value);
  if (
    !run.success
    || run.data.id !== lease.runId
    || run.data.run_attempt !== lease.runAttempt
    || run.data.display_title !== publicationLeaseRunTitle(lease.holder)
    || run.data.head_sha !== expectedCommit
    || !acceptedWorkflowRunPath(run.data.path)
    || (
      expectedStatus === "active"
        ? run.data.status === "completed"
        : expectedStatus !== "any" && run.data.status !== expectedStatus
    )
  ) {
    throw new ReleasePublicationError(
      "publication_lease_lost",
      "before_publication",
      lease.runId,
    );
  }
  if (expectedStatus === "in_progress") {
    const started = run.data.run_started_at === null
      ? Number.NaN
      : Date.parse(run.data.run_started_at);
    const age = Date.now() - started;
    if (!Number.isFinite(age) || age < -5 * 60 * 1_000 || age >= publicationLeaseMaximumAgeMs) {
      throw new ReleasePublicationError(
        "publication_lease_lost",
        "before_publication",
        lease.runId,
      );
    }
  }
  return run.data;
};

export const publicationLeaseCancellationOutcome = (
  value: unknown,
  lease: PublicationLease,
): PublicationLeaseCancellation => {
  const run = assertPublicationLeaseRun(
    value,
    lease,
    lease.expectedCommit,
    "completed",
  );
  if (run.conclusion === "cancelled") return "cancelled";
  if (run.conclusion === "success") return "published";
  throw new ReleasePublicationError(
    "publication_lease_cleanup_failed",
    "before_publication",
    lease.runId,
  );
};

export class GitHubReleasePublicationProvider implements ReleasePublicationProvider {
  private readonly vercelProvider: VercelCutoverProvider;

  constructor(
    private readonly options: Readonly<{
      environment?: Readonly<NodeJS.ProcessEnv>;
      fetcher?: typeof fetch;
      ghCli: string;
      githubCommand?: (
        arguments_: readonly string[],
        maximum: number,
      ) => Promise<ProcessResult>;
      leaseAcquireTimeoutMs?: number;
      leaseCleanupTimeoutMs?: number;
      leaseCompletionTimeoutMs?: number;
      leaseReceiptBoundary?: (
        boundary: PublicationLeaseReceiptPersistenceBoundary,
        state: PublicationLeaseRecoveryReceipt["state"],
        temporaryPath: string,
      ) => void;
      leaseReceiptDirectory?: string;
      now?: () => number;
      randomHolder?: () => string;
      root?: string;
      sleep?: (milliseconds: number) => Promise<void>;
      vercelCli: string;
      writeStderr?: (value: string) => void;
    }>,
  ) {
    this.vercelProvider = new VercelCutoverProvider({
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
      vercelCli: options.vercelCli,
    });
  }

  private get environment(): Readonly<NodeJS.ProcessEnv> {
    return this.options.environment ?? process.env;
  }

  private get ghEnvironment(): Readonly<NodeJS.ProcessEnv> {
    return buildGitHubCliEnvironment(this.environment);
  }

  private get root(): string {
    return this.options.root ?? repositoryRoot;
  }

  private get now(): () => number {
    return this.options.now ?? Date.now;
  }

  private async sleep(milliseconds: number): Promise<void> {
    await (this.options.sleep ?? delay)(milliseconds);
  }

  private get leaseReceiptDirectory(): string {
    if (this.options.leaseReceiptDirectory !== undefined) {
      if (!isAbsolute(this.options.leaseReceiptDirectory)) {
        throw new ReleasePublicationError("local_source_invalid");
      }
      return this.options.leaseReceiptDirectory;
    }
    const xdgState = this.environment.XDG_STATE_HOME;
    if (xdgState !== undefined && isAbsolute(xdgState)) {
      return join(xdgState, "hra", "release-publication");
    }
    const home = this.environment.HOME;
    if (home === undefined || !isAbsolute(home)) {
      throw new ReleasePublicationError("local_source_invalid");
    }
    return join(home, ".local", "state", "hra", "release-publication");
  }

  private async persistPublicationLeaseRecoveryReceipt(
    lease: Readonly<{
      expectedCommit: string;
      holder: string;
      runAttempt?: number;
      runId?: number;
    }>,
    state: PublicationLeaseRecoveryReceipt["state"],
  ): Promise<string> {
    const receipt: PublicationLeaseRecoveryReceipt = {
      expectedCommit: lease.expectedCommit,
      holder: lease.holder,
      repository,
      runAttempt: lease.runAttempt ?? null,
      runId: lease.runId ?? null,
      schemaVersion: 1,
      state,
      tag: releaseTag,
      workflow: workflowPath,
    };
    const encoded = Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8");
    const observed = Buffer.alloc(encoded.byteLength);
    const eofProbe = Buffer.alloc(1);
    let directoryDescriptor: number | undefined;
    let temporaryDescriptor: number | undefined;
    let temporary = "";
    let renamed = false;
    try {
      if (
        encoded.byteLength === 0
        || encoded.byteLength > publicationLeaseRecoveryReceiptMaximumBytes
      ) throw new Error("publication_lease_receipt_oversize");
      const directory = this.leaseReceiptDirectory;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const owner = process.getuid?.();
      const pathStats = lstatSync(directory);
      const canonicalDirectory = realpathSync(directory);
      if (
        owner === undefined
        || !pathStats.isDirectory()
        || pathStats.isSymbolicLink()
        || pathStats.uid !== owner
        || (pathStats.mode & 0o777) !== 0o700
      ) throw new Error("publication_lease_receipt_directory_invalid");
      directoryDescriptor = openSync(
        canonicalDirectory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const directoryStats = fstatSync(directoryDescriptor);
      if (
        !directoryStats.isDirectory()
        || directoryStats.dev !== pathStats.dev
        || directoryStats.ino !== pathStats.ino
        || directoryStats.uid !== owner
        || (directoryStats.mode & 0o777) !== 0o700
      ) throw new Error("publication_lease_receipt_directory_changed");
      const destination = join(canonicalDirectory, `${releaseTag}-${lease.holder}.json`);
      temporary = join(
        canonicalDirectory,
        `.${releaseTag}-${lease.holder}.${randomBytes(8).toString("hex")}.tmp`,
      );
      this.options.leaseReceiptBoundary?.("directory_opened", state, temporary);
      temporaryDescriptor = openSync(
        temporary,
        constants.O_CREAT
          | constants.O_EXCL
          | constants.O_NOFOLLOW
          | constants.O_RDWR,
        0o600,
      );
      fchmodSync(temporaryDescriptor, 0o600);
      const temporaryIdentity = fstatSync(temporaryDescriptor);
      if (
        !temporaryIdentity.isFile()
        || temporaryIdentity.uid !== owner
        || temporaryIdentity.nlink !== 1
        || (temporaryIdentity.mode & 0o777) !== 0o600
        || temporaryIdentity.size !== 0
      ) throw new Error("publication_lease_receipt_temporary_invalid");
      this.options.leaseReceiptBoundary?.("temporary_opened", state, temporary);
      let written = 0;
      while (written < encoded.byteLength) {
        const count = writeSync(
          temporaryDescriptor,
          encoded,
          written,
          encoded.byteLength - written,
          written,
        );
        if (count <= 0) throw new Error("publication_lease_receipt_write_failed");
        written += count;
      }
      this.options.leaseReceiptBoundary?.("written", state, temporary);
      fsyncSync(temporaryDescriptor);
      this.options.leaseReceiptBoundary?.("file_synced", state, temporary);
      let read = 0;
      while (read < observed.byteLength) {
        const count = readSync(
          temporaryDescriptor,
          observed,
          read,
          observed.byteLength - read,
          read,
        );
        if (count === 0) break;
        read += count;
      }
      const extra = readSync(
        temporaryDescriptor,
        eofProbe,
        0,
        eofProbe.byteLength,
        observed.byteLength,
      );
      const writtenIdentity = fstatSync(temporaryDescriptor);
      if (
        read !== encoded.byteLength
        || extra !== 0
        || !observed.equals(encoded)
        || !writtenIdentity.isFile()
        || writtenIdentity.dev !== temporaryIdentity.dev
        || writtenIdentity.ino !== temporaryIdentity.ino
        || writtenIdentity.uid !== owner
        || writtenIdentity.nlink !== 1
        || (writtenIdentity.mode & 0o777) !== 0o600
        || writtenIdentity.size !== encoded.byteLength
      ) throw new Error("publication_lease_receipt_write_unproven");
      this.options.leaseReceiptBoundary?.("read_back", state, temporary);
      const postDirectoryPathStats = lstatSync(directory);
      const postDirectoryStats = fstatSync(directoryDescriptor);
      if (
        postDirectoryPathStats.dev !== pathStats.dev
        || postDirectoryPathStats.ino !== pathStats.ino
        || postDirectoryStats.dev !== pathStats.dev
        || postDirectoryStats.ino !== pathStats.ino
        || postDirectoryPathStats.uid !== owner
        || postDirectoryStats.uid !== owner
        || (postDirectoryPathStats.mode & 0o777) !== 0o700
        || (postDirectoryStats.mode & 0o777) !== 0o700
        || realpathSync(directory) !== canonicalDirectory
      ) throw new Error("publication_lease_receipt_directory_changed");
      renameSync(temporary, destination);
      renamed = true;
      const destinationStats = lstatSync(destination);
      if (
        !destinationStats.isFile()
        || destinationStats.isSymbolicLink()
        || destinationStats.dev !== temporaryIdentity.dev
        || destinationStats.ino !== temporaryIdentity.ino
        || destinationStats.uid !== owner
        || destinationStats.nlink !== 1
        || (destinationStats.mode & 0o777) !== 0o600
        || destinationStats.size !== encoded.byteLength
      ) throw new Error("publication_lease_receipt_rename_unproven");
      this.options.leaseReceiptBoundary?.("renamed", state, temporary);
      fsyncSync(directoryDescriptor);
      const finalDirectoryPathStats = lstatSync(canonicalDirectory);
      const finalDirectoryStats = fstatSync(directoryDescriptor);
      if (
        !finalDirectoryPathStats.isDirectory()
        || finalDirectoryPathStats.isSymbolicLink()
        || finalDirectoryPathStats.dev !== pathStats.dev
        || finalDirectoryPathStats.ino !== pathStats.ino
        || finalDirectoryStats.dev !== pathStats.dev
        || finalDirectoryStats.ino !== pathStats.ino
        || finalDirectoryPathStats.uid !== owner
        || finalDirectoryStats.uid !== owner
        || (finalDirectoryPathStats.mode & 0o777) !== 0o700
        || (finalDirectoryStats.mode & 0o777) !== 0o700
        || realpathSync(directory) !== canonicalDirectory
      ) throw new Error("publication_lease_receipt_directory_changed");
      this.options.leaseReceiptBoundary?.("directory_synced", state, temporary);
      return destination;
    } catch {
      throw new ReleasePublicationError(
        state === "dispatching" && lease.runId === undefined
          ? "local_source_invalid"
          : "publication_lease_cleanup_failed",
        state === "published" ? "published_acceptance_failed" : "before_publication",
        lease.runId,
      );
    } finally {
      encoded.fill(0);
      observed.fill(0);
      eofProbe.fill(0);
      if (temporaryDescriptor !== undefined) closeSync(temporaryDescriptor);
      if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
      if (!renamed && temporary !== "") {
        try {
          unlinkSync(temporary);
        } catch {
          // A failed receipt never permits the remote effect to advance.
        }
      }
    }
  }

  private emitPublicationLeaseRecoveryReceipt(
    receiptPath: string,
    holder: string,
  ): void {
    const value = `${JSON.stringify({
      holder,
      receiptPath,
      repository,
      schemaVersion: 1,
      status: "publication_lease_recovery",
      tag: releaseTag,
    })}\n`;
    (this.options.writeStderr ?? ((message: string): void => {
      process.stderr.write(message);
    }))(value);
  }

  private async gh(arguments_: readonly string[], maximum = providerJsonMaximumBytes): Promise<ProcessResult> {
    if (this.options.githubCommand !== undefined) {
      return await this.options.githubCommand(arguments_, maximum);
    }
    return await runProcess({
      arguments: [...arguments_],
      cwd: this.root,
      environment: this.ghEnvironment,
      executable: this.options.ghCli,
      outputMaximumBytes: maximum,
    });
  }

  private async ghJson(arguments_: readonly string[]): Promise<unknown> {
    return parseJson(await this.gh(arguments_));
  }

  private async readPublicationLeaseRun(runId: number): Promise<unknown> {
    return await this.ghJson([
      "api",
      `repos/${repository}/actions/runs/${String(runId)}`,
    ]);
  }

  private async readExactPublicationLeaseRun(
    lease: PublicationLease,
  ): Promise<z.infer<typeof publicationLeaseRunSchema>> {
    const run = publicationLeaseRunSchema.parse(
      await this.readPublicationLeaseRun(lease.runId),
    );
    return assertPublicationLeaseRun(
      run,
      lease,
      lease.expectedCommit,
      "any",
    );
  }

  private readPublicationLeaseRecoveryReceipt(
    receiptPath: string,
    expectedCommit: string,
  ): PublicationLeaseRecoveryReceipt {
    let descriptor: number | undefined;
    let directoryDescriptor: number | undefined;
    const observed = Buffer.alloc(publicationLeaseRecoveryReceiptMaximumBytes + 1);
    try {
      if (!isAbsolute(receiptPath)) throw new Error("receipt_path_not_absolute");
      const configuredDirectory = this.leaseReceiptDirectory;
      const receiptDirectory = dirname(receiptPath);
      if (resolve(receiptDirectory) !== resolve(configuredDirectory)) {
        throw new Error("receipt_directory_mismatch");
      }
      const configuredDirectoryStats = lstatSync(configuredDirectory);
      const receiptDirectoryStats = lstatSync(receiptDirectory);
      const canonicalConfiguredDirectory = realpathSync(configuredDirectory);
      const canonicalReceiptDirectory = realpathSync(receiptDirectory);
      if (canonicalConfiguredDirectory !== canonicalReceiptDirectory) {
        throw new Error("receipt_directory_mismatch");
      }
      const owner = process.getuid?.();
      const directoryPathStats = lstatSync(canonicalReceiptDirectory);
      if (
        owner === undefined
        || !configuredDirectoryStats.isDirectory()
        || configuredDirectoryStats.isSymbolicLink()
        || configuredDirectoryStats.uid !== owner
        || (configuredDirectoryStats.mode & 0o777) !== 0o700
        || !receiptDirectoryStats.isDirectory()
        || receiptDirectoryStats.isSymbolicLink()
        || receiptDirectoryStats.dev !== configuredDirectoryStats.dev
        || receiptDirectoryStats.ino !== configuredDirectoryStats.ino
        || receiptDirectoryStats.uid !== owner
        || (receiptDirectoryStats.mode & 0o777) !== 0o700
        || !directoryPathStats.isDirectory()
        || directoryPathStats.isSymbolicLink()
        || directoryPathStats.dev !== configuredDirectoryStats.dev
        || directoryPathStats.ino !== configuredDirectoryStats.ino
        || directoryPathStats.uid !== owner
        || (directoryPathStats.mode & 0o777) !== 0o700
      ) throw new Error("receipt_directory_invalid");
      directoryDescriptor = openSync(
        canonicalReceiptDirectory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const directoryIdentity = fstatSync(directoryDescriptor);
      if (
        !directoryIdentity.isDirectory()
        || directoryIdentity.dev !== directoryPathStats.dev
        || directoryIdentity.ino !== directoryPathStats.ino
        || directoryIdentity.uid !== owner
        || (directoryIdentity.mode & 0o777) !== 0o700
      ) throw new Error("receipt_directory_changed");
      descriptor = openSync(receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const identity = fstatSync(descriptor);
      if (
        !identity.isFile()
        || identity.uid !== owner
        || identity.nlink !== 1
        || (identity.mode & 0o777) !== 0o600
        || identity.size <= 0
        || identity.size > publicationLeaseRecoveryReceiptMaximumBytes
      ) throw new Error("receipt_file_invalid");
      let bytesRead = 0;
      while (bytesRead < observed.byteLength) {
        const count = readSync(
          descriptor,
          observed,
          bytesRead,
          observed.byteLength - bytesRead,
          bytesRead,
        );
        if (count === 0) break;
        bytesRead += count;
      }
      const finalIdentity = fstatSync(descriptor);
      const pathIdentity = lstatSync(receiptPath);
      const finalDirectoryIdentity = fstatSync(directoryDescriptor);
      if (
        bytesRead !== identity.size
        || !finalIdentity.isFile()
        || finalIdentity.dev !== identity.dev
        || finalIdentity.ino !== identity.ino
        || finalIdentity.uid !== owner
        || finalIdentity.nlink !== 1
        || (finalIdentity.mode & 0o777) !== 0o600
        || finalIdentity.size !== identity.size
        || pathIdentity.isSymbolicLink()
        || pathIdentity.dev !== identity.dev
        || pathIdentity.ino !== identity.ino
        || pathIdentity.uid !== owner
        || pathIdentity.nlink !== 1
        || (pathIdentity.mode & 0o777) !== 0o600
        || finalDirectoryIdentity.dev !== directoryIdentity.dev
        || finalDirectoryIdentity.ino !== directoryIdentity.ino
        || realpathSync(receiptDirectory) !== canonicalReceiptDirectory
      ) throw new Error("receipt_identity_changed");
      const encoded = observed.subarray(0, bytesRead).toString("utf8");
      if (!encoded.endsWith("\n") || encoded.slice(0, -1).includes("\n")) {
        throw new Error("receipt_encoding_invalid");
      }
      const receipt = publicationLeaseRecoveryReceiptSchema.parse(
        JSON.parse(encoded.slice(0, -1)) as unknown,
      );
      if (
        receipt.expectedCommit !== expectedCommit
        || basename(receiptPath) !== `${releaseTag}-${receipt.holder}.json`
      ) throw new Error("receipt_binding_invalid");
      return receipt;
    } catch {
      throw new ReleasePublicationError(
        "publication_lease_cleanup_failed",
        "before_publication",
        undefined,
        receiptPath,
      );
    } finally {
      observed.fill(0);
      if (descriptor !== undefined) closeSync(descriptor);
      if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
    }
  }

  private async scanPublicationLeaseHolderPages(
    expectedCommit: string,
    holder: string,
  ): Promise<PublicationLeaseCandidateScan> {
    const candidates: z.infer<typeof publicationLeaseRunSchema>[] = [];
    const identities: Array<Readonly<{ runAttempt: number | null; runId: number }>> = [];
    let malformedMatchingCandidate = false;
    let matchingCount = 0;
    let unidentifiedMatchingCandidate = false;
    for (let page = 1; page <= publicationLeaseCandidatePageMaximum; page += 1) {
      const value = await this.ghJson([
        "api",
        `repos/${repository}/actions/workflows/${workflowFile}/runs?event=workflow_dispatch&head_sha=${expectedCommit}&per_page=${String(publicationLeaseCandidatePageSize)}&page=${String(page)}`,
      ]);
      const envelope = publicationLeaseRunsEnvelopeSchema.parse(value);
      const scan = scanPublicationLeaseCandidates(envelope, holder);
      candidates.push(...scan.candidates);
      identities.push(...scan.identities);
      malformedMatchingCandidate ||= scan.malformedMatchingCandidate;
      matchingCount += scan.matchingCount;
      unidentifiedMatchingCandidate ||= scan.unidentifiedMatchingCandidate;
      if (envelope.workflow_runs.length < publicationLeaseCandidatePageSize) {
        return {
          candidates,
          identities,
          malformedMatchingCandidate,
          matchingCount,
          unidentifiedMatchingCandidate,
        };
      }
    }
    throw new ReleasePublicationError("publication_lease_cleanup_failed");
  }

  async acquirePublicationLease(expectedCommit: string): Promise<PublicationLease> {
    const holder = (this.options.randomHolder ?? (() => randomBytes(16).toString("hex")))();
    if (!/^[0-9a-f]{32}$/u.test(holder)) {
      throw new ReleasePublicationError("provider_result_invalid");
    }
    const recoveryReceiptPath = await this.persistPublicationLeaseRecoveryReceipt(
      { expectedCommit, holder },
      "dispatching",
    );
    this.emitPublicationLeaseRecoveryReceipt(recoveryReceiptPath, holder);
    const dispatch = await this.gh([
      "api",
      "--method",
      "POST",
      "-f",
      `ref=${releaseTag}`,
      "-f",
      `inputs[publication_lease]=${holder}`,
      "-F",
      "return_run_details=true",
      `repos/${repository}/actions/workflows/${workflowFile}/dispatches`,
    ]);
    let returnedRunId: number | undefined;
    if (
      dispatch.exitCode === 0
      && dispatch.stdout.byteLength > 0
      && dispatch.stdout.byteLength <= providerJsonMaximumBytes
    ) {
      try {
        returnedRunId = publicationLeaseDispatchRunId(
          JSON.parse(dispatch.stdout.toString("utf8")) as unknown,
        );
      } catch {
        returnedRunId = undefined;
      }
    }
    let discoveredLease = returnedRunId === undefined
      ? undefined
      : {
          expectedCommit,
          holder,
          runAttempt: 1,
          runId: returnedRunId,
        } satisfies PublicationLease;
    if (discoveredLease !== undefined) {
      await this.persistPublicationLeaseRecoveryReceipt(discoveredLease, "bound");
    }
    const cleanupLeases = new Map<string, PublicationLease>();
    const partialLeaseRunIds = new Set<number>();
    const observedLeaseRunIds = new Set<number>();
    const rememberLease = (lease: PublicationLease): void => {
      cleanupLeases.set(`${String(lease.runId)}:${String(lease.runAttempt)}`, lease);
    };
    if (discoveredLease !== undefined) rememberLease(discoveredLease);
    const unidentifiedMatchingCandidates = new Set<"present">();
    const rememberScan = (scan: PublicationLeaseCandidateScan): void => {
      if (scan.unidentifiedMatchingCandidate) {
        unidentifiedMatchingCandidates.add("present");
      }
      for (const identity of scan.identities) {
        observedLeaseRunIds.add(identity.runId);
        if (identity.runAttempt === null) partialLeaseRunIds.add(identity.runId);
        else {
          rememberLease({
            expectedCommit,
            holder,
            runAttempt: identity.runAttempt,
            runId: identity.runId,
          });
        }
      }
    };
    const deadline = this.now() + (
      this.options.leaseAcquireTimeoutMs ?? publicationLeaseAcquireTimeoutMs
    );
    while (this.now() < deadline) {
      try {
        let run: z.infer<typeof publicationLeaseRunSchema> | undefined;
        if (discoveredLease === undefined) {
          const scan = await this.scanPublicationLeaseHolderPages(
            expectedCommit,
            holder,
          );
          rememberScan(scan);
          if (
            scan.matchingCount === 1
            && scan.identities.length === 1
            && observedLeaseRunIds.size === 1
            && unidentifiedMatchingCandidates.size === 0
          ) {
            const identity = scan.identities[0] as Readonly<{
              runAttempt: number | null;
              runId: number;
            }>;
            const listedCandidate = scan.candidates.find((candidate) => (
              candidate.id === identity.runId
              && candidate.run_attempt === identity.runAttempt
            ));
            const candidateRun = identity.runAttempt === null || listedCandidate === undefined
              ? publicationLeaseRunSchema.parse(
                  await this.readPublicationLeaseRun(identity.runId),
                )
              : listedCandidate;
            const candidateLease: PublicationLease = {
              expectedCommit,
              holder,
              runAttempt: identity.runAttempt ?? candidateRun.run_attempt,
              runId: identity.runId,
            };
            discoveredLease = candidateLease;
            rememberLease(candidateLease);
            await this.persistPublicationLeaseRecoveryReceipt(candidateLease, "bound");
            assertPublicationLeaseRun(
              candidateRun,
              candidateLease,
              expectedCommit,
              "any",
            );
            run = candidateRun;
          }
        } else {
          run = publicationLeaseRunSchema.parse(
            await this.readPublicationLeaseRun(discoveredLease.runId),
          );
          assertPublicationLeaseRun(
            run,
            discoveredLease,
            expectedCommit,
            "any",
          );
        }
        if (run !== undefined && discoveredLease !== undefined) {
          if (run.status === "in_progress") {
            assertPublicationLeaseRun(
              run,
              discoveredLease,
              expectedCommit,
              "in_progress",
            );
            await this.persistPublicationLeaseRecoveryReceipt(discoveredLease, "active");
            return discoveredLease;
          }
          if (run.status === "completed") {
            if (run.conclusion === "success") {
              await this.persistPublicationLeaseRecoveryReceipt(discoveredLease, "published");
              throw new ReleasePublicationError(
                "publication_lease_completed",
                "publication_unknown",
                discoveredLease.runId,
              );
            }
            if (run.conclusion === "cancelled") {
              await this.persistPublicationLeaseRecoveryReceipt(discoveredLease, "cancelled");
              throw new ReleasePublicationError(
                "publication_lease_unavailable",
                "before_publication",
                discoveredLease.runId,
              );
            }
            throw new ReleasePublicationError(
              "publication_lease_cleanup_failed",
              "before_publication",
              discoveredLease.runId,
            );
          }
        }
      } catch (error: unknown) {
        if (
          error instanceof ReleasePublicationError
          && [
            "publication_lease_cleanup_failed",
            "publication_lease_completed",
            "publication_lease_unavailable",
          ].includes(error.code)
        ) throw error;
        // The dispatch may be visible before every run read settles. Retry
        // command, transport, envelope, and holder-candidate parse failures.
      }
      await this.sleep(publicationLeasePollIntervalMs);
    }
    const terminalScan = await this.scanPublicationLeaseHolderPages(
      expectedCommit,
      holder,
    ).catch(() => undefined);
    if (terminalScan !== undefined) {
      rememberScan(terminalScan);
    } else {
      // A lost dispatch response is not absence until a complete terminal scan
      // reaches a short final page. Keep the durable receipt authoritative.
    }
    let cleanupFailed = unidentifiedMatchingCandidates.size > 0 || terminalScan === undefined;
    let firstLeaseRunId: number | undefined;
    let publishedLeaseRunId: number | undefined;
    for (const runId of partialLeaseRunIds) {
      try {
        const run = publicationLeaseRunSchema.parse(
          await this.readPublicationLeaseRun(runId),
        );
        const cleanupLease: PublicationLease = {
          expectedCommit,
          holder,
          runAttempt: run.run_attempt,
          runId,
        };
        assertPublicationLeaseRun(run, cleanupLease, expectedCommit, "any");
        rememberLease(cleanupLease);
      } catch {
        cleanupFailed = true;
        firstLeaseRunId ??= runId;
      }
    }
    for (const cleanupLease of cleanupLeases.values()) {
      firstLeaseRunId ??= cleanupLease.runId;
      try {
        const outcome = await this.cancelPublicationLease(cleanupLease);
        if (outcome === "published") publishedLeaseRunId ??= cleanupLease.runId;
      } catch {
        cleanupFailed = true;
      }
    }
    if (publishedLeaseRunId !== undefined) throw new ReleasePublicationError(
      "publication_lease_completed",
      "publication_unknown",
      publishedLeaseRunId,
    );
    if (cleanupFailed) throw new ReleasePublicationError(
      "publication_lease_cleanup_failed",
      "before_publication",
      firstLeaseRunId,
      recoveryReceiptPath,
    );
    throw new ReleasePublicationError(
      "publication_lease_unavailable",
      "before_publication",
      firstLeaseRunId,
      recoveryReceiptPath,
    );
  }

  async assertPublicationLease(
    lease: PublicationLease,
    expectedCommit: string,
  ): Promise<void> {
    if (lease.expectedCommit !== expectedCommit) {
      throw new ReleasePublicationError(
        "publication_lease_lost",
        "before_publication",
        lease.runId,
      );
    }
    assertPublicationLeaseRun(
      await this.readPublicationLeaseRun(lease.runId),
      lease,
      expectedCommit,
      "in_progress",
    );
  }

  async cancelPublicationLease(
    lease: PublicationLease,
  ): Promise<PublicationLeaseCancellation> {
    const deadline = this.now() + (this.options.leaseCleanupTimeoutMs ?? 3 * 60 * 1_000);
    const acceptTerminal = async (
      value: unknown,
    ): Promise<PublicationLeaseCancellation> => {
      const outcome = publicationLeaseCancellationOutcome(value, lease);
      await this.persistPublicationLeaseRecoveryReceipt(
        lease,
        outcome === "cancelled" ? "cancelled" : "published",
      );
      return outcome;
    };
    const readExactUntilAvailable = async (): Promise<z.infer<typeof publicationLeaseRunSchema>> => {
      while (this.now() < deadline) {
        try {
          return await this.readExactPublicationLeaseRun(lease);
        } catch (error: unknown) {
          if (
            error instanceof ReleasePublicationError
            && error.code === "publication_lease_lost"
          ) throw error;
        }
        await this.sleep(publicationLeasePollIntervalMs);
      }
      throw new ReleasePublicationError(
        "publication_lease_cleanup_failed",
        "before_publication",
        lease.runId,
      );
    };
    const current = await readExactUntilAvailable();
    if (current.status === "completed") {
      return await acceptTerminal(current);
    }
    await this.gh([
      "api",
      "--method",
      "POST",
      `repos/${repository}/actions/runs/${String(lease.runId)}/cancel`,
    ]);
    while (this.now() < deadline) {
      const run = await readExactUntilAvailable();
      if (run.status === "completed") {
        return await acceptTerminal(run);
      }
      await this.sleep(publicationLeasePollIntervalMs);
    }
    throw new ReleasePublicationError(
      "publication_lease_cleanup_failed",
      "before_publication",
      lease.runId,
    );
  }

  async completePublicationLease(lease: PublicationLease): Promise<void> {
    const configuredDeadline = this.now() + (
      this.options.leaseCompletionTimeoutMs
      ?? this.options.leaseCleanupTimeoutMs
      ?? publicationLeaseWorkflowTimeoutMs
    );
    let deadline = configuredDeadline;
    while (this.now() < deadline) {
      try {
        const run = await this.readExactPublicationLeaseRun(lease);
        if (run.run_started_at !== null) {
          const startedAt = Date.parse(run.run_started_at);
          if (Number.isFinite(startedAt)) {
            deadline = Math.min(
              deadline,
              startedAt + publicationLeaseWorkflowTimeoutMs,
            );
          }
        }
        if (run.status === "completed") {
          if (run.conclusion === "success") {
            await this.persistPublicationLeaseRecoveryReceipt(lease, "published");
            return;
          }
          break;
        }
      } catch (error: unknown) {
        if (error instanceof ReleasePublicationError) {
          if (error.code === "publication_lease_lost") throw error;
          if (!["command_failed", "provider_result_invalid"].includes(error.code)) {
            throw error;
          }
        }
      }
      await this.sleep(publicationLeasePollIntervalMs);
    }
    throw new ReleasePublicationError(
      "publication_lease_cleanup_failed",
      "published_acceptance_failed",
      lease.runId,
    );
  }

  async recoverPublicationLease(
    arguments_: PublicationRecoveryArguments,
    temporaryRoot: string,
  ): Promise<PublicationLeaseRecoveryResult> {
    const receiptPath = arguments_.receipt;
    try {
      const receipt = this.readPublicationLeaseRecoveryReceipt(
        receiptPath,
        arguments_.expectedCommit,
      );
      await this.verifyLocalSource(arguments_.expectedCommit);
      const [repositoryValue, workflowValue] = await Promise.all([
        this.readRepository(),
        this.readWorkflow(),
      ]);
      repositorySchema.parse(repositoryValue);
      workflowSchema.parse(workflowValue);
      await verifyFinalPublicationAuthority(this, {
        expectedCommit: receipt.expectedCommit,
        tag: releaseTag,
      });

      const exactLeases = async (): Promise<Map<string, PublicationLease>> => {
        const scan = await this.scanPublicationLeaseHolderPages(
          receipt.expectedCommit,
          receipt.holder,
        );
        if (
          scan.unidentifiedMatchingCandidate
          || scan.malformedMatchingCandidate
          || scan.matchingCount !== scan.candidates.length
          || scan.matchingCount !== scan.identities.length
        ) throw new ReleasePublicationError("publication_lease_cleanup_failed");
        const leases = new Map<string, PublicationLease>();
        for (const candidate of scan.candidates) {
          const lease: PublicationLease = {
            expectedCommit: receipt.expectedCommit,
            holder: receipt.holder,
            runAttempt: candidate.run_attempt,
            runId: candidate.id,
          };
          assertPublicationLeaseRun(candidate, lease, receipt.expectedCommit, "any");
          const key = `${String(lease.runId)}:${String(lease.runAttempt)}`;
          if (leases.has(key)) {
            throw new ReleasePublicationError("publication_lease_cleanup_failed");
          }
          leases.set(key, lease);
        }
        if (receipt.runId !== null && receipt.runAttempt !== null) {
          const receiptLease: PublicationLease = {
            expectedCommit: receipt.expectedCommit,
            holder: receipt.holder,
            runAttempt: receipt.runAttempt,
            runId: receipt.runId,
          };
          await this.readExactPublicationLeaseRun(receiptLease);
          leases.set(`${String(receipt.runId)}:${String(receipt.runAttempt)}`, receiptLease);
        }
        return leases;
      };

      const acceptExactPublicState = async (
        release: z.infer<typeof releaseSchema>,
        leases: ReadonlyMap<string, PublicationLease>,
      ): Promise<PublicationLeaseRecoveryResult> => {
        const accepted = await recoverAcceptedBundleFromPublishedRelease(
          this,
          release,
          receipt.expectedCommit,
          join(temporaryRoot, "public-release"),
        );
        await verifyReviewedSourceAuthority(
          this,
          accepted,
          join(temporaryRoot, "reviewed-source"),
          "published_acceptance_failed",
        );
        await this.acceptPackedInstall(accepted.archive, join(temporaryRoot, "packed-install"));
        const assetIdentity = await downloadAndVerifyAssets(
          this,
          release.id,
          join(temporaryRoot, "authenticated-public-assets"),
          accepted,
        );
        await verifyPublishedIdentity(this, accepted, release.id, assetIdentity);
        for (const lease of leases.values()) {
          await this.readExactPublicationLeaseRun(lease);
        }
        if (receipt.runId !== null && receipt.runAttempt !== null) {
          await this.persistPublicationLeaseRecoveryReceipt({
            expectedCommit: receipt.expectedCommit,
            holder: receipt.holder,
            runAttempt: receipt.runAttempt,
            runId: receipt.runId,
          }, "published");
        }
        return {
          commit: receipt.expectedCommit,
          holder: receipt.holder,
          status: "published",
          tag: releaseTag,
        };
      };

      let leases = await exactLeases();
      let release = exactRelease(await this.listReleases());
      if (!release.draft) {
        return await acceptExactPublicState(release, leases);
      }
      if (receipt.state === "published") {
        throw new ReleasePublicationError("publication_unknown", "publication_unknown");
      }
      const recoveredDraft = await recoverAcceptedBundleFromDraftRelease(
        this,
        release,
        receipt.expectedCommit,
        join(temporaryRoot, "draft-release"),
      );
      await verifyReviewedSourceAuthority(
        this,
        recoveredDraft.accepted,
        join(temporaryRoot, "reviewed-source"),
        "before_publication",
      );
      await this.acceptPackedInstall(
        recoveredDraft.accepted.archive,
        join(temporaryRoot, "packed-install"),
      );
      await verifyDraftIdentity(
        this,
        recoveredDraft.accepted,
        release.id,
        recoveredDraft.assetIdentity,
      );

      for (let pass = 0; pass < 3; pass += 1) {
        for (const lease of leases.values()) {
          const run = await this.readExactPublicationLeaseRun(lease);
          if (run.status === "completed") {
            if (run.conclusion === "cancelled") continue;
            if (run.conclusion === "success") {
              release = exactRelease(await this.listReleases());
              if (!release.draft) {
                return await acceptExactPublicState(release, leases);
              }
            }
            throw new ReleasePublicationError(
              "publication_lease_cleanup_failed",
              "before_publication",
              lease.runId,
            );
          }
          const outcome = await this.cancelPublicationLease(lease);
          if (outcome === "published") {
            release = exactRelease(await this.listReleases());
            if (!release.draft) {
              return await acceptExactPublicState(release, leases);
            }
            throw new ReleasePublicationError(
              "publication_unknown",
              "publication_unknown",
              lease.runId,
            );
          }
        }

        release = exactRelease(await this.listReleases());
        if (!release.draft) {
          return await acceptExactPublicState(release, leases);
        }
        await verifyDraftIdentity(
          this,
          recoveredDraft.accepted,
          release.id,
          recoveredDraft.assetIdentity,
        );
        const proofLeases = await exactLeases();
        const newLease = [...proofLeases].find(([key]) => !leases.has(key));
        if (newLease !== undefined) {
          leases = new Map([...leases, ...proofLeases]);
          continue;
        }
        for (const lease of leases.values()) {
          const run = await this.readExactPublicationLeaseRun(lease);
          if (run.status !== "completed" || run.conclusion !== "cancelled") {
            throw new ReleasePublicationError(
              "publication_lease_cleanup_failed",
              "before_publication",
              lease.runId,
            );
          }
        }
        return {
          commit: receipt.expectedCommit,
          holder: receipt.holder,
          status: "retry_permitted",
          tag: releaseTag,
        };
      }
      throw new ReleasePublicationError("publication_lease_cleanup_failed");
    } catch (error: unknown) {
      if (error instanceof ReleasePublicationError) {
        throw new ReleasePublicationError(
          error.code,
          error.phase,
          error.leaseRunId,
          receiptPath,
        );
      }
      throw new ReleasePublicationError(
        "publication_lease_cleanup_failed",
        "before_publication",
        undefined,
        receiptPath,
      );
    }
  }

  async verifyLocalSource(expectedCommit: string): Promise<void> {
    assertLocalOperatorEnvironment(this.environment);
    requireSuccess(await runProcess({
      arguments: ["fetch", "origin", "main", "--tags"],
      cwd: this.root,
      environment: this.environment,
      executable: "git",
    }));
    const query = async (arguments_: readonly string[]): Promise<string> =>
      requireSuccess(await runProcess({
        arguments: [...arguments_],
        cwd: this.root,
        environment: this.environment,
        executable: "git",
        outputMaximumBytes: 64 * 1024,
      })).stdout.toString("utf8").trimEnd();
    const [status, head, tagCommit, remote] = await Promise.all([
      query(["status", "--porcelain=v1", "--untracked-files=all"]),
      query(["rev-parse", "HEAD^{commit}"]),
      query(["rev-parse", `refs/tags/${releaseTag}^{commit}`]),
      query(["remote", "get-url", "origin"]),
    ]);
    const remoteAccepted = remote === "https://github.com/hraness/hra.git"
      || remote === "git@github.com:hraness/hra.git";
    if (
      status !== ""
      || head !== expectedCommit
      || tagCommit !== expectedCommit
      || !remoteAccepted
    ) throw new ReleasePublicationError("local_source_invalid");
  }

  async readReviewedSourceAuthority(temporaryRoot: string): Promise<ReviewedSourceAuthority> {
    await mkdir(temporaryRoot, { mode: 0o700 });
    const environment = await buildCandidateInspectionEnvironment(temporaryRoot);
    requireSuccess(await runProcess({
      arguments: [
        "pm",
        "pack",
        "--ignore-scripts",
        "--destination",
        temporaryRoot,
        "--quiet",
      ],
      cwd: this.root,
      environment,
      executable: process.execPath,
      outputMaximumBytes: 64 * 1024,
    }));
    const archiveName = `hra-${releaseVersion}.tgz`;
    if (JSON.stringify((await readdir(temporaryRoot)).sort()) !== JSON.stringify([
      "home",
      archiveName,
      "tmp",
      "xdg",
    ])) throw new ReleasePublicationError(
      "published_release_invalid",
      "published_acceptance_failed",
    );
    const notes = (await readBounded(
      join(this.root, "docs", "beta-release-notes.md"),
      256 * 1024,
    )).toString("utf8").trimEnd();
    return {
      archive: await readBounded(join(temporaryRoot, archiveName), 32 * 1024 * 1024),
      notes,
    };
  }

  async readRepository(): Promise<unknown> {
    return await this.ghJson(["api", `repos/${repository}`]);
  }

  async readWorkflow(): Promise<unknown> {
    return await this.ghJson(["api", `repos/${repository}/actions/workflows/release.yml`]);
  }

  async readRun(runId: number): Promise<unknown> {
    return await this.ghJson(["api", `repos/${repository}/actions/runs/${String(runId)}`]);
  }

  async readRunArtifacts(runId: number): Promise<unknown> {
    return await this.ghJson([
      "api",
      `repos/${repository}/actions/runs/${String(runId)}/artifacts?per_page=100`,
    ]);
  }

  async downloadRunArtifact(runId: number, name: string, destination: string): Promise<void> {
    requireSuccess(await this.gh([
      "run",
      "download",
      String(runId),
      "--repo",
      repository,
      "--name",
      name,
      "--dir",
      destination,
    ]));
  }

  async listReleases(): Promise<unknown> {
    const pages = await this.ghJson([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repository}/releases?per_page=100`,
    ]);
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
      throw new ReleasePublicationError("provider_result_invalid");
    }
    return pages.flat();
  }

  async listReleaseAssets(releaseId: number): Promise<unknown> {
    return await this.ghJson([
      "api",
      `repos/${repository}/releases/${String(releaseId)}/assets?per_page=100`,
    ]);
  }

  async downloadReleaseAsset(assetId: number, destination: string): Promise<void> {
    const result = requireSuccess(await this.gh([
      "api",
      "-H",
      "Accept: application/octet-stream",
      `repos/${repository}/releases/assets/${String(assetId)}`,
    ], commandOutputMaximumBytes));
    await writeFile(destination, result.stdout, { flag: "wx", mode: 0o600 });
  }

  async downloadPublicReleaseAsset(name: string, destination: string): Promise<void> {
    if (!expectedReleaseAssetNameSet.has(name)) {
      throw new ReleasePublicationError(
        "public_acceptance_failed",
        "published_acceptance_failed",
      );
    }
    const fetcher = this.options.fetcher ?? fetch;
    let response: Response;
    try {
      response = await fetcher(
        `https://github.com/${repository}/releases/download/${releaseTag}/${encodeURIComponent(name)}`,
        {
          cache: "no-store",
          redirect: "follow",
          signal: AbortSignal.timeout(60_000),
        },
      );
    } catch {
      throw new ReleasePublicationError(
        "public_acceptance_failed",
        "published_acceptance_failed",
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = await readResponseBounded(
        response,
        name.endsWith(".tgz") ? 32 * 1024 * 1024 : 16 * 1024 * 1024,
        "public_acceptance_failed",
      );
    } catch {
      throw new ReleasePublicationError(
        "public_acceptance_failed",
        "published_acceptance_failed",
      );
    }
    if (response.status !== 200 || !response.url.startsWith("https://") || bytes.byteLength === 0) {
      throw new ReleasePublicationError(
        "public_acceptance_failed",
        "published_acceptance_failed",
      );
    }
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  }

  async readTagCommit(tag: string): Promise<string> {
    const value = z.object({ sha: commitSchema }).passthrough().parse(
      await this.ghJson(["api", `repos/${repository}/commits/refs/tags/${tag}`]),
    );
    return value.sha;
  }

  async readMainComparison(expectedCommit: string): Promise<unknown> {
    if (!commitSchema.safeParse(expectedCommit).success) {
      throw new ReleasePublicationError("release_authority_changed");
    }
    return await this.ghJson([
      "api",
      `repos/${repository}/compare/${expectedCommit}...main`,
    ]);
  }

  async readTagProtection(): Promise<unknown> {
    return await this.ghJson([
      "api",
      `repos/${repository}/rulesets/${String(immutableVersionTagsRulesetId)}`,
    ]);
  }

  async readImmutableSetting(): Promise<unknown> {
    return await this.ghJson(["api", `repos/${repository}/immutable-releases`]);
  }

  async verifyVercelVersion(): Promise<void> {
    await this.vercelProvider.verifyVersion();
  }

  async readHostedAlias(aliasName: ManagedAlias): Promise<AliasReadback> {
    return await this.vercelProvider.readAlias(aliasName);
  }

  async readHostedDeployment(deploymentId: string): Promise<DeploymentReadback> {
    return await this.vercelProvider.readDeployment(deploymentId);
  }

  async readHostedDomainNames(projectId: string): Promise<readonly string[]> {
    return await this.vercelProvider.readDomainNames(projectId);
  }

  async readHostedMarker(aliasName: ManagedAlias): Promise<unknown> {
    return await this.vercelProvider.readMarker(aliasName);
  }

  async readHostedProject(projectId: string): Promise<ProjectReadback> {
    return await this.vercelProvider.readProject(projectId);
  }

  async publishDraft(releaseId: number, notes: string): Promise<unknown> {
    return await this.ghJson([
      "api",
      "--method",
      "PATCH",
      "-f",
      `tag_name=${releaseTag}`,
      "-f",
      `name=${title}`,
      "-f",
      `body=${notes}`,
      "-F",
      "draft=false",
      "-F",
      "prerelease=true",
      "-f",
      "make_latest=false",
      `repos/${repository}/releases/${String(releaseId)}`,
    ]);
  }

  async acceptPackedInstall(archive: string, temporaryRoot: string): Promise<void> {
    await mkdir(temporaryRoot, { mode: 0o700 });
    const environment = await buildCandidateInspectionEnvironment(temporaryRoot);
    const listing = requireSuccess(await runProcess({
      arguments: ["-tzf", archive],
      cwd: this.root,
      environment,
      executable: "/usr/bin/tar",
      outputMaximumBytes: 4 * 1024 * 1024,
    })).stdout.toString("utf8");
    const verboseListing = requireSuccess(await runProcess({
      arguments: ["-tvzf", archive],
      cwd: this.root,
      environment,
      executable: "/usr/bin/tar",
      outputMaximumBytes: 8 * 1024 * 1024,
    })).stdout.toString("utf8").trimEnd().split("\n");
    const entries = listing.trimEnd().split("\n");
    if (
      entries.length === 0
      || entries.length > 10_000
      || verboseListing.length !== entries.length
      || verboseListing.some((entry) => !entry.startsWith("-") && !entry.startsWith("d"))
      || entries.some((entry) => {
        const segments = entry.split("/");
        return !entry.startsWith("package/")
          || entry.startsWith("/")
          || segments.includes("..")
          || entry.includes("\\");
      })
    ) throw new ReleasePublicationError("accepted_artifact_invalid");
    const extracted = join(temporaryRoot, "extracted");
    await mkdir(extracted, { mode: 0o700 });
    requireSuccess(await runProcess({
      arguments: ["-xzf", archive, "-C", extracted],
      cwd: this.root,
      environment,
      executable: "/usr/bin/tar",
    }));
    await assertPublicTree(extracted);
    await assertProductionPackageOnly(extracted);
  }

  async acceptPublicInstall(
    url: string,
    _temporaryRoot: string,
    expectedDigest: string,
  ): Promise<void> {
    const fetcher = this.options.fetcher ?? fetch;
    let response: Response;
    try {
      response = await fetcher(url, {
        cache: "no-store",
        redirect: "follow",
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new ReleasePublicationError("public_acceptance_failed", "published_acceptance_failed");
    }
    let publicBytes: Uint8Array;
    try {
      publicBytes = await readResponseBounded(
        response,
        32 * 1024 * 1024,
        "public_acceptance_failed",
      );
    } catch {
      throw new ReleasePublicationError("public_acceptance_failed", "published_acceptance_failed");
    }
    if (
      response.status !== 200
      || !response.url.startsWith("https://")
      || publicBytes.byteLength === 0
      || sha256(publicBytes) !== expectedDigest
    ) throw new ReleasePublicationError("public_acceptance_failed", "published_acceptance_failed");
  }
}

export async function withBestEffortReleaseCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  try {
    return await operation();
  } finally {
    // Cleanup removes temporary public bytes and static-inspection state. This is
    // hygiene, not filesystem, network, or keychain containment, and it must
    // never replace the authoritative pre- or post-publication outcome.
    await cleanup().catch(() => undefined);
  }
}

export async function runReleasePublication(options: Readonly<{
  arguments: PublicationArguments;
  provider: ReleasePublicationProvider;
  temporaryParent?: string;
}>): Promise<Readonly<{ commit: string; status: "accepted" | "published"; tag: string }>> {
  const parent = options.temporaryParent ?? tmpdir();
  const temporaryRoot = await realpath(await mkdtemp(join(parent, "hra-release-publish-")));
  return await withBestEffortReleaseCleanup(
    async () => await executeReleasePublication({
      arguments: options.arguments,
      provider: options.provider,
      temporaryRoot,
    }),
    async () => await rm(temporaryRoot, { force: true, recursive: true }),
  );
}

export async function runPublicationLeaseRecovery(options: Readonly<{
  arguments: PublicationRecoveryArguments;
  provider: GitHubReleasePublicationProvider;
  temporaryParent?: string;
}>): Promise<PublicationLeaseRecoveryResult> {
  const parent = options.temporaryParent ?? tmpdir();
  const temporaryRoot = await realpath(await mkdtemp(join(parent, "hra-release-recover-")));
  return await withBestEffortReleaseCleanup(
    async () => await options.provider.recoverPublicationLease(
      options.arguments,
      temporaryRoot,
    ),
    async () => await rm(temporaryRoot, { force: true, recursive: true }),
  );
}

if (import.meta.main) {
  let exitCode = 1;
  try {
    const rawArguments = process.argv.slice(2);
    const recovery = rawArguments[0] === "recover";
    const result = recovery
      ? await (async (): Promise<PublicationLeaseRecoveryResult> => {
          const arguments_ = parsePublicationRecoveryArguments(rawArguments);
          return await runPublicationLeaseRecovery({
            arguments: arguments_,
            provider: new GitHubReleasePublicationProvider({
              ghCli: arguments_.ghCli,
              vercelCli: "/usr/bin/false",
            }),
          });
        })()
      : await (async (): Promise<Readonly<{
          commit: string;
          status: "accepted" | "published";
          tag: string;
        }>> => {
          const arguments_ = parsePublicationArguments(rawArguments);
          return await runReleasePublication({
            arguments: arguments_,
            provider: new GitHubReleasePublicationProvider({
              ghCli: arguments_.ghCli,
              vercelCli: arguments_.vercelCli,
            }),
          });
        })();
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...result })}\n`);
    exitCode = 0;
  } catch (error: unknown) {
    const failure = error instanceof ReleasePublicationError
      ? error
      : new ReleasePublicationError("provider_result_invalid");
    process.stderr.write(`${JSON.stringify({
      code: failure.code,
      ...(failure.leaseRunId === undefined ? {} : { leaseRunId: failure.leaseRunId }),
      phase: failure.phase,
      ...(failure.receiptPath === undefined ? {} : { receiptPath: failure.receiptPath }),
      schemaVersion: 1,
      status: "refused",
    })}\n`);
  }
  process.exitCode = exitCode;
}
