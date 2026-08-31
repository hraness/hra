import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertLocalOperatorEnvironment,
  assertPublicationLeaseRun,
  buildCandidateInspectionEnvironment,
  buildGitHubCliEnvironment,
  executeReleasePublication,
  GitHubReleasePublicationProvider,
  parsePublicationArguments,
  parsePublicationRecoveryArguments,
  publicationLeaseCancellationOutcome,
  publicationLeaseDispatchRunId,
  releaseArtifactName,
  ReleasePublicationError,
  scanPublicationLeaseCandidates,
  verifyAcceptedBundle,
  withBestEffortReleaseCleanup,
  type PublicationArguments,
  type PublicationLeaseCancellation,
  type PublicationLease,
  type PublicationLeaseReceiptPersistenceBoundary,
  type PublicationRecoveryArguments,
  type ReleasePublicationProvider,
} from "./publish-beta-release";
import type {
  AliasReadback,
  DeploymentReadback,
  ManagedAlias,
  ProjectReadback,
  VercelCommandRunner,
} from "./domain-cutover";
import {
  BoundedProcessCleanupUnprovenError,
  BoundedProcessRecoveryJournalError,
} from "./bounded-process";
import {
  canonicalDigest,
  HRA_CONVEX_PROJECT_ID,
  HRA_CONVEX_TEAM_ID,
  HRA_REPOSITORY_ID,
  releaseCandidateReceiptSchema,
  withSelfDigest,
  writeProtectedJsonNoReplace,
} from "./release-evidence";

const commit = "a".repeat(40);
const tag = "v0.1.0";
const runId = 9_876_543;
const runAttempt = 2;
const releaseId = 456;
const deploymentId = `dpl_${"N".repeat(24)}`;
const deploymentUrl = "hra-new-accepted.vercel.app";
const fallbackDeploymentId = `dpl_${"Q".repeat(24)}`;
const fallbackDeploymentUrl = "hra-v0-accepted.vercel.app";
const oldProjectId = "prj_eRfUBHdHkEbvIaB8x7dyyZhBc3wr";
const newProjectId = "prj_8ciIt9t9foE3utG45frRN7cxckjS";
const oldRepositoryId = 1_334_876_494;
const teamId = "team_UAd1iD2XogJlbFg4h14mRaPM";
const fallbackCommit = "443448b79e9016e00d52501f047fce3a408de092";
const notes = "# HRA v0.1.0 friend beta\n\nAccepted notes.";
const candidateDigest = "d".repeat(64);
const candidateReceipt = "/opt/hra-test/state/release-candidate.json";
const temporaryRoots: string[] = [];
type HostedFault =
  | "canonical-alias"
  | "canonical-marker"
  | "deployment"
  | "deployment-source"
  | "deployment-state"
  | "fallback-alias"
  | "fallback-marker"
  | "fallback-marker-repository"
  | "fallback-marker-shape"
  | "owner"
  | "project"
  | "staging-alias"
  | "staging-marker"
  | "team"
  | "version";

const digest = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const commandResult = (
  value: unknown,
  exitCode = 0,
): Readonly<{ exitCode: number; stderr: Buffer; stdout: Buffer }> => ({
  exitCode,
  stderr: Buffer.alloc(0),
  stdout: value === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value)),
});

const refuseUnexpectedHistoricalVercel: VercelCommandRunner = async () => {
  throw new Error("historical publication test reached Vercel");
};

const createHistoricalPublicationProvider = (
  options: ConstructorParameters<typeof GitHubReleasePublicationProvider>[0],
): GitHubReleasePublicationProvider => new GitHubReleasePublicationProvider({
  ...options,
  vercelRunner: refuseUnexpectedHistoricalVercel,
});

const assetNames = [
  "RELEASE_NOTES.md",
  "SHA256SUMS",
  `hra-${tag}.artifact.spdx.json`,
  `hra-${tag}.tgz`,
  `hra-${tag}.ubuntu-24.04-x64.runtime.spdx.json`,
] as const;

const makeAssets = (): ReadonlyMap<string, Buffer> => {
  const archive = Buffer.from("accepted archive bytes");
  const artifactSbom = Buffer.from(JSON.stringify({
    packages: [{
      checksums: [{ algorithm: "SHA256", checksumValue: digest(archive) }],
      name: "hra",
      versionInfo: "0.1.0",
    }],
  }));
  const runtimeSbom = Buffer.from(JSON.stringify({
    packages: [
      { name: "hra", versionInfo: "0.1.0" },
      { name: "@openai/codex", versionInfo: "0.149.0" },
      { name: "convex", versionInfo: "1.45.0" },
      { name: "zod", versionInfo: "4.4.3" },
    ],
  }));
  const checksums = Buffer.from([
    `${digest(archive)}  hra-${tag}.tgz`,
    `${digest(artifactSbom)}  hra-${tag}.artifact.spdx.json`,
    `${digest(runtimeSbom)}  hra-${tag}.ubuntu-24.04-x64.runtime.spdx.json`,
    `${digest(Buffer.from(notes))}  RELEASE_NOTES.md`,
    "",
  ].join("\n"));
  return new Map([
    ["RELEASE_NOTES.md", Buffer.from(notes)],
    ["SHA256SUMS", checksums],
    [`hra-${tag}.artifact.spdx.json`, artifactSbom],
    [`hra-${tag}.tgz`, archive],
    [`hra-${tag}.ubuntu-24.04-x64.runtime.spdx.json`, runtimeSbom],
  ]);
};

const writeAccepted = async (
  directory: string,
  assets = makeAssets(),
): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [name, value] of assets) {
    await writeFile(join(directory, name), value, { flag: "wx", mode: 0o600 });
  }
  await writeFile(join(directory, "RELEASE_COMMIT"), `${commit}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(join(directory, "RELEASE_CANDIDATE_SHA256"), `${candidateDigest}\n`, {
    flag: "wx",
    mode: 0o600,
  });
};

class FakeProvider implements ReleasePublicationProvider {
  readonly calls: string[] = [];
  readonly assets = makeAssets();
  artifactExpired = false;
  artifactAttempts: number[] = [1, runAttempt];
  assetIdentityChangesBeforePublish = false;
  candidateDigests: string[] = [];
  candidateReceiptReads = 0;
  draftImmutable = false;
  hostedFault: HostedFault | undefined;
  hostedFailsAfterPublish = false;
  immutable = true;
  leaseCleanupFails = false;
  leaseCancellationOutcome: PublicationLeaseCancellation = "cancelled";
  leaseLost = false;
  loseLeaseOnCandidateRead: number | undefined;
  leaseRunId = 7_654_321;
  leaseUnavailable = false;
  mainContainsCommit = true;
  published = false;
  publicInstallFails = false;
  publishFailsAfterCommit = false;
  publishFailsBeforeCommit = false;
  publishCleanupFailure: BoundedProcessCleanupUnprovenError | undefined;
  publishedReleaseId: number | undefined;
  publicReleaseImmutable = true;
  reviewedSourceMismatch = false;
  releaseBody = notes;
  releaseAssetsReads = 0;
  tagProtected = true;
  tagCommit = commit;

  async acquirePublicationLease(
    expectedCommit: string,
    exactCandidateDigest: string,
    exactCandidateReceipt: string,
  ): Promise<PublicationLease> {
    this.calls.push("lease:acquire");
    if (this.leaseUnavailable) {
      throw new ReleasePublicationError("publication_lease_unavailable");
    }
    return {
      candidateDigest: exactCandidateDigest,
      candidateReceipt: exactCandidateReceipt,
      expectedCommit,
      holder: "0123456789abcdef0123456789abcdef",
      runAttempt: 1,
      runId: this.leaseRunId,
    };
  }

  async assertPublicationLease(): Promise<void> {
    this.calls.push("lease:assert");
    if (this.leaseLost) {
      throw new ReleasePublicationError(
        "publication_lease_lost",
        "before_publication",
        this.leaseRunId,
      );
    }
  }

  async cancelPublicationLease(): Promise<PublicationLeaseCancellation> {
    this.calls.push("lease:cancel");
    if (this.leaseCleanupFails) throw new Error("lease cleanup failed");
    if (this.leaseCancellationOutcome === "published") this.published = true;
    return this.leaseCancellationOutcome;
  }

  async completePublicationLease(): Promise<void> {
    this.calls.push("lease:complete");
    if (this.leaseCleanupFails) throw new Error("lease cleanup failed");
  }

  async verifyLocalSource(expectedCommit: string): Promise<void> {
    this.calls.push(`local:${expectedCommit}`);
  }

  async verifyCandidateReceipt(path: string, expectedCommit: string): Promise<string> {
    this.calls.push(`candidate:${path}:${expectedCommit}`);
    this.candidateReceiptReads += 1;
    if (this.candidateReceiptReads === this.loseLeaseOnCandidateRead) this.leaseLost = true;
    return this.candidateDigests.shift() ?? candidateDigest;
  }

  async readRepository(): Promise<unknown> {
    this.calls.push("repository");
    return { full_name: "hraness/hra", id: 1_343_008_607 };
  }

  async readWorkflow(): Promise<unknown> {
    this.calls.push("workflow");
    return {
      id: 123,
      name: "Release",
      path: ".github/workflows/release.yml",
      state: "active",
    };
  }

  async readRun(id: number): Promise<unknown> {
    this.calls.push(`run:${String(id)}`);
    return {
      conclusion: "success",
      event: "push",
      head_branch: tag,
      head_sha: commit,
      id: runId,
      name: "Release",
      path: ".github/workflows/release.yml",
      repository: { full_name: "hraness/hra", id: 1_343_008_607 },
      run_attempt: runAttempt,
      status: "completed",
      workflow_id: 123,
    };
  }

  async readRunArtifacts(id: number): Promise<unknown> {
    this.calls.push(`artifacts:${String(id)}`);
    return {
      artifacts: this.artifactAttempts.map((attempt, index) => ({
        expired: this.artifactExpired && attempt === runAttempt,
        id: 321 + index,
        name: releaseArtifactName(runId, attempt),
        workflow_run: { id: runId },
      })),
      total_count: this.artifactAttempts.length,
    };
  }

  async downloadRunArtifact(id: number, name: string, destination: string): Promise<void> {
    this.calls.push(`download-run-artifact:${String(id)}:${name}`);
    await writeAccepted(destination, this.assets);
  }

  private release(): unknown {
    return {
      body: this.releaseBody,
      draft: !this.published,
      id: releaseId,
      immutable: this.published ? this.publicReleaseImmutable : this.draftImmutable,
      name: `HRA ${tag}`,
      prerelease: true,
      tag_name: tag,
    };
  }

  async listReleases(): Promise<unknown> {
    this.calls.push(`releases:${this.published ? "public" : "draft"}`);
    return [this.release()];
  }

  async listReleaseAssets(id: number): Promise<unknown> {
    this.calls.push(`release-assets:${String(id)}`);
    this.releaseAssetsReads += 1;
    return assetNames.map((name, index) => ({
      id: index + 1 + (this.assetIdentityChangesBeforePublish && this.releaseAssetsReads >= 3 ? 10 : 0),
      name,
      state: "uploaded",
    }));
  }

  async downloadReleaseAsset(assetId: number, destination: string): Promise<void> {
    const name = assetNames[assetId - 1];
    if (name === undefined) throw new Error("unknown asset");
    this.calls.push(`download-asset:${name}`);
    await writeFile(destination, this.assets.get(name) ?? Buffer.alloc(0), {
      flag: "wx",
      mode: 0o600,
    });
  }

  async downloadPublicReleaseAsset(name: string, destination: string): Promise<void> {
    this.calls.push(`download-public-asset:${name}`);
    const value = this.assets.get(name);
    if (value === undefined) throw new Error("unknown public asset");
    await writeFile(destination, value, { flag: "wx", mode: 0o600 });
  }

  async acceptPackedInstall(): Promise<void> {
    this.calls.push("accept-packed-install");
  }

  async readTagCommit(): Promise<string> {
    this.calls.push("tag-commit");
    return this.tagCommit;
  }

  async readMainComparison(): Promise<unknown> {
    this.calls.push("main-comparison");
    return {
      base_commit: { sha: commit },
      merge_base_commit: { sha: this.mainContainsCommit ? commit : "c".repeat(40) },
      status: "ahead",
    };
  }

  async readReviewedSourceAuthority(): Promise<Readonly<{ archive: Buffer; notes: string }>> {
    this.calls.push("reviewed-source-authority");
    return {
      archive: this.reviewedSourceMismatch
        ? Buffer.from("different reviewed source")
        : this.assets.get(`hra-${tag}.tgz`) ?? Buffer.alloc(0),
      notes,
    };
  }

  async readTagProtection(): Promise<unknown> {
    this.calls.push("tag-protection");
    return {
      bypass_actors: [],
      conditions: { ref_name: { exclude: [], include: ["refs/tags/v*"] } },
      current_user_can_bypass: this.tagProtected ? "never" : "always",
      enforcement: "active",
      id: 21_213_369,
      name: "Immutable version tags",
      rules: [{ type: "deletion" }, { type: "update" }],
      source: "hraness/hra",
      source_type: "Repository",
      target: "tag",
    };
  }

  async readImmutableSetting(): Promise<unknown> {
    this.calls.push("immutable-setting");
    return { enabled: this.immutable, enforced_by_owner: false };
  }

  async verifyVercelVersion(): Promise<void> {
    this.calls.push("vercel-version");
    if (this.hostedFault === "version" || (this.published && this.hostedFailsAfterPublish)) {
      throw new Error("hosted invalid");
    }
  }

  async readHostedProject(projectId: string): Promise<ProjectReadback> {
    this.calls.push(`hosted-project:${projectId}`);
    if (projectId !== oldProjectId && projectId !== newProjectId) throw new Error("unknown project");
    return {
      accountId: this.hostedFault === "team" ? "team_wrong" : teamId,
      autoAssignCustomDomains: this.hostedFault === "project" && projectId === newProjectId,
      id: projectId,
    } as ProjectReadback;
  }

  async readHostedDeployment(id: string): Promise<DeploymentReadback> {
    this.calls.push(`hosted-deployment:${id}`);
    const isNew = id === deploymentId;
    if (!isNew && id !== fallbackDeploymentId) throw new Error("unknown deployment");
    return {
      gitSource: {
        ref: this.hostedFault === "deployment-source" && isNew ? "feature" : "main",
        repoId: isNew ? 1_343_008_607 : oldRepositoryId,
        sha: isNew ? commit : fallbackCommit,
        type: "github",
      },
      id: this.hostedFault === "deployment" && isNew ? fallbackDeploymentId : id,
      projectId: isNew ? newProjectId : oldProjectId,
      readyState: this.hostedFault === "deployment-state" && isNew ? "ERROR" : "READY",
      url: isNew ? deploymentUrl : fallbackDeploymentUrl,
    } as DeploymentReadback;
  }

  async readHostedAlias(alias: ManagedAlias): Promise<AliasReadback> {
    this.calls.push(`hosted-alias:${alias}`);
    const isFallback = alias === "hra-weld.vercel.app";
    const id = isFallback ? fallbackDeploymentId : deploymentId;
    const url = isFallback ? fallbackDeploymentUrl : deploymentUrl;
    const invalidProject = (this.hostedFault === "canonical-alias" && alias === "hra.sh")
      || (this.hostedFault === "staging-alias" && alias === "try-hra.vercel.app")
      || (this.hostedFault === "fallback-alias" && isFallback);
    return {
      alias,
      deployment: { id, url },
      deploymentId: id,
      projectId: invalidProject ? (isFallback ? newProjectId : oldProjectId) : (
        isFallback ? oldProjectId : newProjectId
      ),
    };
  }

  async readHostedDomainNames(projectId: string): Promise<readonly string[]> {
    this.calls.push(`hosted-domains:${projectId}`);
    if (this.hostedFault === "owner") return projectId === oldProjectId ? ["hra.sh"] : [];
    return projectId === newProjectId ? ["hra.sh"] : [];
  }

  async readHostedMarker(alias: ManagedAlias): Promise<unknown> {
    this.calls.push(`hosted-marker:${alias}`);
    if (alias === "hra-weld.vercel.app") {
      if (this.hostedFault === "fallback-marker-shape") {
        return {
          generation: 1,
          product: "HRA",
          repository: { id: oldRepositoryId, path: "hraness/hra-v0" },
          schemaVersion: 2,
          source: { commit: fallbackCommit },
          version: "0.1.15",
        };
      }
      return {
        generation: 1,
        product: "HRA",
        publication: {
          build: 16,
          dmgSha256: "120b600d7cc11df260836198601cba91db33efc7b600dd2b601bde686c9ea028",
          publicationCommit: "d96173c3556799cb203a4d659f29856180838029",
          releaseId: 376_100_700,
          sourceCommit: "0c7764da0dea0a71bbccca817539a02d8e4284d0",
          tag: "v0.1.15",
          tagObject: "e5bcf5c919e8a7ffcdccc337b8940b60a70f0489",
          version: this.hostedFault === "fallback-marker" ? "0.1.14" : "0.1.15",
        },
        repository: this.hostedFault === "fallback-marker-repository"
          ? { id: 1_343_008_607, path: "hraness/hra" }
          : { id: oldRepositoryId, path: "hraness/hra-v0" },
        schemaVersion: 2,
        source: { commit: fallbackCommit },
      };
    }
    return {
      generation: 1,
      product: "HRA",
      repository: { id: 1_343_008_607, path: "hraness/hra" },
      schemaVersion: 2,
      source: {
        commit: (
          this.hostedFault === "canonical-marker" && alias === "hra.sh"
        ) || (
          this.hostedFault === "staging-marker" && alias === "try-hra.vercel.app"
        ) ? "c".repeat(40) : commit,
      },
      version: "0.1.0",
    };
  }

  async publishDraft(id: number, publishedNotes: string): Promise<unknown> {
    this.calls.push("publish");
    this.publishedReleaseId = id;
    if (publishedNotes !== notes) throw new Error("wrong notes");
    if (this.publishCleanupFailure !== undefined) throw this.publishCleanupFailure;
    if (this.publishFailsBeforeCommit) throw new Error("lost before commit");
    this.published = true;
    if (this.publishFailsAfterCommit) throw new Error("lost after commit");
    return this.release();
  }

  async acceptPublicInstall(url: string): Promise<void> {
    this.calls.push(`public-install:${url}`);
    if (this.publicInstallFails) throw new Error("public route unavailable");
  }
}

const publicationArguments = (action: "accept" | "publish"): PublicationArguments => ({
  action,
  candidateReceipt,
  deploymentId,
  deploymentUrl,
  expectedCommit: commit,
  fallbackDeploymentId,
  fallbackDeploymentUrl,
  fallbackVersion: "0.1.15",
  ghCli: "/opt/homebrew/bin/gh",
  runAttempt,
  runId,
  tag,
  vercelCli: "/opt/hra-test/bin/vercel",
});

const recoveryArguments = (receipt: string): PublicationRecoveryArguments => ({
  action: "recover",
  expectedCommit: commit,
  ghCli: "/opt/homebrew/bin/gh",
  receipt,
  tag,
});

const makeRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hra-release-publish-test-")));
  temporaryRoots.push(root);
  return root;
};

const writeRecoveryReceipt = async (
  directory: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<string> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const holder = "0123456789abcdef0123456789abcdef";
  const protectedCandidateReceipt = join(directory, "release-candidate.json");
  const convexTarget = {
    deploymentId: 5_089_017,
    deploymentName: "qualified-hummingbird-537",
    deploymentUrl: "https://qualified-hummingbird-537.convex.cloud",
    projectId: HRA_CONVEX_PROJECT_ID,
    teamId: HRA_CONVEX_TEAM_ID,
  } as const;
  const bootstrapRuntimeAttestation = {
    bound: true as const,
    deployedAtMs: 100,
    previousDeployDigest: null,
    runtimeRevision: "00000000-0000-4000-8000-000000000001",
    runtimeSourceCommit: commit,
    schemaIdentity: "hra-release-attestation-v1" as const,
    schemaVersion: 1 as const,
  };
  const candidateRuntimeAttestation = {
    ...bootstrapRuntimeAttestation,
    deployedAtMs: 200,
    previousDeployDigest: "2".repeat(64),
    runtimeRevision: "00000000-0000-4000-8000-000000000002",
  };
  const candidate = releaseCandidateReceiptSchema.parse(withSelfDigest({
    ci: ["Check (macos-15)", "Check (ubuntu-24.04)", "Required"].map((name) => ({
      completedAt: "2026-08-24T12:00:00.000Z",
      conclusion: "success" as const,
      headCommit: commit,
      name,
      runAttempt: 1,
      runId: 123,
      workflow: "CI" as const,
    })),
    convex: {
      bootstrapDeployDigest: "2".repeat(64),
      bootstrapLive: {
        completedAt: 200,
        deployEvidenceDigest: "2".repeat(64),
        digest: "3".repeat(64),
        packageVersion: "0.1.0" as const,
        runtimeRevision: bootstrapRuntimeAttestation.runtimeRevision,
        sourceCommit: commit,
        startedAt: 150,
        targetDigest: canonicalDigest(convexTarget),
      },
      bootstrapRuntime: bootstrapRuntimeAttestation,
      candidateDeployDigest: "4".repeat(64),
      candidateLive: {
        completedAt: 300,
        deployEvidenceDigest: "4".repeat(64),
        digest: "5".repeat(64),
        packageVersion: "0.1.0" as const,
        runtimeRevision: candidateRuntimeAttestation.runtimeRevision,
        sourceCommit: commit,
        startedAt: 250,
        targetDigest: canonicalDigest(convexTarget),
      },
      candidateRuntime: candidateRuntimeAttestation,
      target: convexTarget,
      targetDigest: canonicalDigest(convexTarget),
    },
    cutover: {
      finalForwardDigest: "6".repeat(64),
      forwardDigest: "7".repeat(64),
      reverseDigest: "8".repeat(64),
    },
    kind: "release-candidate" as const,
    releaseVersion: "0.1.0" as const,
    repository: { id: HRA_REPOSITORY_ID, name: "hraness/hra" as const },
    schemaVersion: 1 as const,
    sealedAt: Date.parse("2026-08-24T13:00:00.000Z"),
    sourceCommit: commit,
    surfaceDigest: "9".repeat(64),
    tag: "v0.1.0" as const,
    vercel: {
      authorityDigest: "a".repeat(64),
      candidate: {
        deploymentId,
        deploymentUrl,
        projectId: newProjectId,
        repositoryId: HRA_REPOSITORY_ID,
        sourceCommit: commit,
        version: "0.1.0",
      },
      fallback: {
        deploymentId: fallbackDeploymentId,
        deploymentUrl: fallbackDeploymentUrl,
        projectId: oldProjectId,
        repositoryId: oldRepositoryId,
        sourceCommit: fallbackCommit,
        version: "0.1.15",
      },
      teamId,
    },
  }));
  writeProtectedJsonNoReplace(
    protectedCandidateReceipt,
    candidate,
    releaseCandidateReceiptSchema,
  );
  const receipt = join(directory, `${tag}-${holder}.json`);
  await writeFile(receipt, `${JSON.stringify({
    candidateDigest: candidate.selfDigest,
    candidateReceipt: protectedCandidateReceipt,
    expectedCommit: commit,
    holder,
    repository: "hraness/hra",
    runAttempt: null,
    runId: null,
    schemaVersion: 1,
    state: "dispatching",
    tag,
    workflow: ".github/workflows/release.yml",
    ...overrides,
  })}\n`, { flag: "wx", mode: 0o600 });
  return receipt;
};

const stubRecoverySourceAuthority = (
  provider: GitHubReleasePublicationProvider,
): void => {
  provider.verifyLocalSource = async () => undefined;
  provider.readRepository = async () => ({ full_name: "hraness/hra", id: 1_343_008_607 });
  provider.readWorkflow = async () => ({
    id: 123,
    name: "Release",
    path: ".github/workflows/release.yml",
    state: "active",
  });
  provider.readTagCommit = async () => commit;
  provider.readMainComparison = async () => ({
    base_commit: { sha: commit },
    merge_base_commit: { sha: commit },
    status: "identical",
  });
  provider.readTagProtection = async () => ({
    bypass_actors: [],
    conditions: { ref_name: { exclude: [], include: ["refs/tags/v*"] } },
    current_user_can_bypass: "never",
    enforcement: "active",
    id: 21_213_369,
    name: "Immutable version tags",
    rules: [{ type: "deletion" }, { type: "update" }],
    source: "hraness/hra",
    source_type: "Repository",
    target: "tag",
  });
  provider.readImmutableSetting = async () => ({ enabled: true, enforced_by_owner: true });
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await rm(root, { force: true, recursive: true });
  }));
});

describe("release publication arguments", () => {
  test("the retired publisher has no ambient Vercel capability", () => {
    let githubCalls = 0;
    expect(() => new GitHubReleasePublicationProvider({
      ghCli: "/provider/must-not-run",
      githubCommand: async () => {
        githubCalls += 1;
        return commandResult(undefined);
      },
      vercelCli: "/provider/must-not-run",
    })).toThrow("operator_retired");
    expect(githubCalls).toBe(0);
  });

  test("requires an exact run, source commit, CLI, tag, and explicit publish acknowledgement", () => {
    const common = [
      "--tag", tag,
      "--candidate-receipt", candidateReceipt,
      "--run-id", String(runId),
      "--run-attempt", String(runAttempt),
      "--expected-commit", commit,
      "--deployment-id", deploymentId,
      "--deployment-url", deploymentUrl,
      "--fallback-deployment-id", fallbackDeploymentId,
      "--fallback-deployment-url", fallbackDeploymentUrl,
      "--fallback-version", "0.1.15",
      "--gh-cli", "/opt/homebrew/bin/gh",
      "--vercel-cli", "/opt/hra-test/bin/vercel",
    ];
    expect(parsePublicationArguments([
      "publish",
      ...common,
      "--acknowledge-immutable-publication",
    ])).toEqual(publicationArguments("publish"));
    expect(parsePublicationArguments([
      "accept",
      ...common,
    ])).toEqual(publicationArguments("accept"));
    expect(() => parsePublicationArguments([
      "publish",
      ...common,
    ])).toThrow("usage_invalid");
    expect(() => parsePublicationArguments([
      "accept",
      ...common,
      "--acknowledge-immutable-publication",
    ])).toThrow("usage_invalid");
    for (const [option, invalid] of [
      ["--deployment-id", fallbackDeploymentId],
      ["--deployment-url", "https://hra-new-accepted.vercel.app"],
      ["--fallback-version", "latest"],
      ["--gh-cli", "gh"],
      ["--vercel-cli", "vercel"],
    ] as const) {
      const candidate = ["accept", ...common];
      const index = candidate.indexOf(option);
      candidate[index + 1] = invalid;
      expect(() => parsePublicationArguments(candidate)).toThrow("usage_invalid");
    }
  });

  test("requires an absolute receipt and explicit prepublication cancellation acknowledgement", () => {
    const receipt = "/opt/hra-test/state/v0.1.0-receipt.json";
    const common = [
      "--tag", tag,
      "--expected-commit", commit,
      "--receipt", receipt,
      "--gh-cli", "/opt/homebrew/bin/gh",
    ];
    expect(parsePublicationRecoveryArguments([
      "recover",
      ...common,
      "--acknowledge-cancel-prepublication-leases",
    ])).toEqual(recoveryArguments(receipt));
    expect(() => parsePublicationRecoveryArguments(["recover", ...common]))
      .toThrow("usage_invalid");
    const relative = [
      "recover",
      ...common,
      "--acknowledge-cancel-prepublication-leases",
    ];
    relative[relative.indexOf("--receipt") + 1] = "relative/receipt.json";
    expect(() => parsePublicationRecoveryArguments(relative)).toThrow("usage_invalid");
  });

  test("preserves keyring authority only for GitHub and allowlists inspection state", async () => {
    const source = {
      CI: "",
      GH_ENTERPRISE_TOKEN: "sentinel",
      GH_HOST: "enterprise.invalid",
      GH_TOKEN: "sentinel",
      GITHUB_AUTH_TOKEN: "sentinel",
      GITHUB_ENTERPRISE_TOKEN: "sentinel",
      GITHUB_TOKEN: "sentinel",
      HOME: "/opt/hra-test/home",
      NODE_AUTH_TOKEN: "sentinel",
      NPM_TOKEN: "sentinel",
    };
    expect(buildGitHubCliEnvironment(source)).toEqual({ CI: "", HOME: "/opt/hra-test/home", NODE_AUTH_TOKEN: "sentinel", NPM_TOKEN: "sentinel" });
    const root = await makeRoot();
    const inspectionEnvironment = await buildCandidateInspectionEnvironment(root);
    expect(Object.keys(inspectionEnvironment).sort()).toEqual([
      "DO_NOT_TRACK",
      "HOME",
      "LANG",
      "LC_ALL",
      "PATH",
      "TMPDIR",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
    ]);
    expect(inspectionEnvironment.HOME).toStartWith(root);
    expect(inspectionEnvironment.HOME).not.toBe(source.HOME);
    expect(inspectionEnvironment.TMPDIR).toStartWith(root);
    expect(inspectionEnvironment.XDG_CONFIG_HOME).toStartWith(root);
    expect(inspectionEnvironment.GITHUB_TOKEN).toBeUndefined();
    expect(inspectionEnvironment.NPM_TOKEN).toBeUndefined();
    expect(() => assertLocalOperatorEnvironment({ GITHUB_ACTIONS: "true" }))
      .toThrow("local_source_invalid");
    expect(() => assertLocalOperatorEnvironment({ CI: "1" }))
      .toThrow("local_source_invalid");
  });

  test("uses an absolute Git executable for the authority-classified source fetch", async () => {
    const source = await Bun.file(join(import.meta.dir, "publish-beta-release.ts")).text();
    expect(source).toMatch(/arguments: \["fetch", "origin", "main", "--tags"\],\s+containment: "authority",\s+cwd: this\.root,\s+environment: this\.environment,\s+executable: "\/usr\/bin\/git"/u);
  });

  test("keeps hostile historical candidate code unreachable from the replacement workflow", async () => {
    const publisherSource = await Bun.file(join(import.meta.dir, "publish-beta-release.ts")).text();
    const replacementWorkflow = Bun.file(
      join(import.meta.dir, "..", ".github", "workflows", "release.yml"),
    );
    expect(publisherSource).not.toContain("pathToFileURL");
    expect(publisherSource).not.toContain('arguments: ["add", "--global"');
    expect(publisherSource).toContain('"pack",\n        "--ignore-scripts"');
    expect(await replacementWorkflow.exists()).toBeTrue();
    const replacementWorkflowSource = await replacementWorkflow.text();
    expect(replacementWorkflowSource).not.toContain("publish-beta-release.ts");
    expect(replacementWorkflowSource).toContain('git cat-file -t "$REQUESTED_TAG"');
    expect(replacementWorkflowSource).toContain('git merge-base --is-ancestor "$VERIFIED_SHA" "$remote_main"');
    expect(replacementWorkflowSource).toContain("HRA_NPM_PREFLIGHT_RUN_ATTEMPT");
  });
});

describe("release publication cleanup", () => {
  test("never replaces the authoritative result or publication phase", async () => {
    await expect(withBestEffortReleaseCleanup(
      async () => "published" as const,
      async () => { throw new Error("cleanup failed"); },
    )).resolves.toBe("published");

    const primary = new Error("publication outcome");
    let observed: unknown;
    try {
      await withBestEffortReleaseCleanup(
        async () => { throw primary; },
        async () => { throw new Error("cleanup failed"); },
      );
    } catch (error: unknown) {
      observed = error;
    }
    expect(observed).toBe(primary);
  });

  test("preserves child-reachable temporary state after cleanup becomes indeterminate", async () => {
    const root = await makeRoot();
    const cleanup = new BoundedProcessCleanupUnprovenError(42_420, "tar-extract");
    let removed = false;
    await expect(withBestEffortReleaseCleanup(
      async () => { throw cleanup; },
      async () => { removed = true; },
      { path: root, publicationPhase: "before_publication" },
    )).rejects.toBe(cleanup);
    expect(removed).toBeFalse();
    expect(cleanup.recoveryPaths).toContain(root);
    expect(cleanup.diagnostics).toEqual({ publicationPhase: "before_publication" });
  });

  test("preserves child-reachable temporary state when the recovery journal blocks", async () => {
    const root = await makeRoot();
    const journal = new BoundedProcessRecoveryJournalError(
      ["/private/operator/process-recovery/authority-publication.json"],
      "authority_recovery_required",
    );
    let removed = false;
    let observed: unknown;
    try {
      await withBestEffortReleaseCleanup(
        async () => { throw journal; },
        async () => { removed = true; },
        { path: root, publicationPhase: "before_publication" },
      );
    } catch (error: unknown) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(BoundedProcessRecoveryJournalError);
    expect((observed as BoundedProcessRecoveryJournalError).recoveryPaths).toEqual([
      "/private/operator/process-recovery/authority-publication.json",
      root,
    ].sort());
    expect(journal.recoveryPaths).toEqual([
      "/private/operator/process-recovery/authority-publication.json",
    ]);
    expect(removed).toBeFalse();
  });

  test("bounds hostile public bodies and preserves the final URL authority", async () => {
    let cancelled = false;
    const stalled = new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      pull() {
        return new Promise(() => undefined);
      },
    }), { status: 200 });
    Object.defineProperty(stalled, "url", { value: "https://downloads.example.test/hra.tgz" });
    const stalledProvider = createHistoricalPublicationProvider({
      fetcher: Object.assign(() => Promise.resolve(stalled), {
        preconnect: () => undefined,
      }) as typeof fetch,
      ghCli: "/not-used/gh",
      publicTimeoutMs: 10,
      vercelCli: "/not-used/vercel",
    });
    const startedAt = performance.now();
    await expect(stalledProvider.acceptPublicInstall(
      "https://github.com/hraness/hra/releases/download/v0.1.0/hra-v0.1.0.tgz",
      "/not-used",
      "0".repeat(64),
    )).rejects.toThrow("public_acceptance_failed");
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(cancelled).toBeTrue();

    const bytes = new TextEncoder().encode("exact public archive");
    const insecure = new Response(bytes, { status: 200 });
    Object.defineProperty(insecure, "url", { value: "http://downloads.example.test/hra.tgz" });
    const insecureProvider = createHistoricalPublicationProvider({
      fetcher: Object.assign(() => Promise.resolve(insecure), {
        preconnect: () => undefined,
      }) as typeof fetch,
      ghCli: "/not-used/gh",
      publicTimeoutMs: 100,
      vercelCli: "/not-used/vercel",
    });
    await expect(insecureProvider.acceptPublicInstall(
      "https://github.com/hraness/hra/releases/download/v0.1.0/hra-v0.1.0.tgz",
      "/not-used",
      digest(bytes),
    )).rejects.toThrow("public_acceptance_failed");
  });
});

describe("release publication lease identity", () => {
  const lease: PublicationLease = {
    candidateDigest,
    candidateReceipt,
    expectedCommit: commit,
    holder: "0123456789abcdef0123456789abcdef",
    runAttempt: 1,
    runId: 7_654_321,
  };

  const leaseRun = (
    overrides: Readonly<Record<string, unknown>> = {},
  ): Record<string, unknown> => ({
    conclusion: null,
    display_title: `HRA publication lease ${lease.holder}`,
    event: "workflow_dispatch",
    head_branch: tag,
    head_sha: commit,
    id: lease.runId,
    name: "Release",
    path: [".github/workflows/release.yml", "refs/tags/v0.1.0"].join("@"),
    repository: { full_name: "hraness/hra", id: 1_343_008_607 },
    run_attempt: lease.runAttempt,
    run_started_at: new Date().toISOString(),
    status: "in_progress",
    ...overrides,
  });

  test("accepts only the exact active workflow-dispatch run", () => {
    expect(assertPublicationLeaseRun(
      leaseRun(),
      lease,
      commit,
      "in_progress",
    )).toMatchObject({ id: lease.runId, status: "in_progress" });

    for (const mutate of [
      (run: Record<string, unknown>): void => { run.display_title = "another lease"; },
      (run: Record<string, unknown>): void => { run.head_sha = "b".repeat(40); },
      (run: Record<string, unknown>): void => { run.run_attempt = 2; },
      (run: Record<string, unknown>): void => { run.status = "completed"; },
      (run: Record<string, unknown>): void => {
        run.run_started_at = new Date(Date.now() - 5 * 60 * 60 * 1_000).toISOString();
      },
    ]) {
      const run = leaseRun();
      mutate(run);
      expect(() => assertPublicationLeaseRun(
        run,
        lease,
        commit,
        "in_progress",
      )).toThrow("publication_lease_lost");
    }
  });

  test("binds returned dispatch details and filters before strict candidate parsing", () => {
    expect(publicationLeaseDispatchRunId({
      html_url: `https://github.com/hraness/hra/actions/runs/${String(lease.runId)}`,
      run_url: `https://api.github.com/repos/hraness/hra/actions/runs/${String(lease.runId)}`,
      workflow_run_id: lease.runId,
    })).toBe(lease.runId);
    expect(publicationLeaseDispatchRunId({
      html_url: `https://github.com/attacker/repo/actions/runs/${String(lease.runId)}`,
      run_url: `https://api.github.com/repos/hraness/hra/actions/runs/${String(lease.runId)}`,
      workflow_run_id: lease.runId,
    })).toBeUndefined();

    const valid = leaseRun();
    const scan = scanPublicationLeaseCandidates({
      workflow_runs: [null, { display_title: "unrelated" }, valid],
    }, lease.holder);
    expect(scan.candidates).toHaveLength(1);
    expect(scan.identities).toEqual([{ runAttempt: lease.runAttempt, runId: lease.runId }]);
    expect(scan.matchingCount).toBe(1);
    expect(scan.candidates[0]?.id).toBe(lease.runId);
    expect(scan.malformedMatchingCandidate).toBeFalse();
    expect(scan.unidentifiedMatchingCandidate).toBeFalse();

    const malformed = scanPublicationLeaseCandidates({
      workflow_runs: [{ display_title: `HRA publication lease ${lease.holder}` }],
    }, lease.holder);
    expect(malformed.candidates).toHaveLength(0);
    expect(malformed.malformedMatchingCandidate).toBeTrue();
    expect(malformed.unidentifiedMatchingCandidate).toBeTrue();

    const duplicate = scanPublicationLeaseCandidates({
      workflow_runs: [
        valid,
        leaseRun({ id: lease.runId + 1 }),
        { display_title: `HRA publication lease ${lease.holder}` },
      ],
    }, lease.holder);
    expect(duplicate.matchingCount).toBe(3);
    expect(duplicate.identities).toEqual([
      { runAttempt: lease.runAttempt, runId: lease.runId },
      { runAttempt: lease.runAttempt, runId: lease.runId + 1 },
    ]);
    expect(duplicate.unidentifiedMatchingCandidate).toBeTrue();
  });

  test("accepts cancellation only after exact terminal identity reconciliation", () => {
    const cancelled = leaseRun();
    cancelled.status = "completed";
    cancelled.conclusion = "cancelled";
    expect(publicationLeaseCancellationOutcome(cancelled, lease)).toBe("cancelled");

    const published = leaseRun();
    published.status = "completed";
    published.conclusion = "success";
    expect(publicationLeaseCancellationOutcome(published, lease)).toBe("published");

    const failed = leaseRun();
    failed.status = "completed";
    failed.conclusion = "failure";
    expect(() => publicationLeaseCancellationOutcome(failed, lease)).toThrow(
      expect.objectContaining({
        code: "publication_lease_cleanup_failed",
        leaseRunId: lease.runId,
      }),
    );

    const wrongIdentity = leaseRun();
    wrongIdentity.status = "completed";
    wrongIdentity.conclusion = "cancelled";
    wrongIdentity.run_attempt = 2;
    expect(() => publicationLeaseCancellationOutcome(wrongIdentity, lease)).toThrow(
      expect.objectContaining({
        code: "publication_lease_lost",
        leaseRunId: lease.runId,
      }),
    );
  });

  test("binds the exact dispatch response and persists an active recovery receipt", async () => {
    const root = await makeRoot();
    const commands: string[][] = [];
    const stderr: string[] = [];
    const dispatchingBoundaries: PublicationLeaseReceiptPersistenceBoundary[] = [];
    const receiptPath = join(root, "receipts", `${tag}-${lease.holder}.json`);
    let receiptObservedBeforeDispatch = false;
    const responses = [
      commandResult({
        html_url: `https://github.com/hraness/hra/actions/runs/${String(lease.runId)}`,
        run_url: `https://api.github.com/repos/hraness/hra/actions/runs/${String(lease.runId)}`,
        workflow_run_id: lease.runId,
      }),
      commandResult(leaseRun()),
    ];
    const provider = createHistoricalPublicationProvider({
      environment: { HOME: root },
      ghCli: "/not-used/gh",
      githubCommand: async (arguments_) => {
        commands.push([...arguments_]);
        if (commands.length === 1) {
          const receiptValue = JSON.parse(
            await readFile(receiptPath, "utf8"),
          ) as unknown;
          receiptObservedBeforeDispatch = typeof receiptValue === "object"
            && receiptValue !== null
            && Reflect.get(receiptValue, "state") === "dispatching";
        }
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected GitHub command");
        return response;
      },
      leaseReceiptBoundary: (boundary, state) => {
        if (state === "dispatching") dispatchingBoundaries.push(boundary);
      },
      leaseReceiptDirectory: join(root, "receipts"),
      randomHolder: () => lease.holder,
      vercelCli: "/not-used/vercel",
      writeStderr: (value) => { stderr.push(value); },
    });
    await expect(provider.acquirePublicationLease(commit, candidateDigest, candidateReceipt))
      .resolves.toEqual(lease);
    expect(commands[0]).toContain("return_run_details=true");
    expect(receiptObservedBeforeDispatch).toBeTrue();
    expect(commands[1]).toContain(`repos/hraness/hra/actions/runs/${String(lease.runId)}`);
    expect(JSON.parse(await readFile(receiptPath, "utf8"))).toMatchObject({
      holder: lease.holder,
      runAttempt: lease.runAttempt,
      runId: lease.runId,
      state: "active",
    });
    expect((await lstat(receiptPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(root, "receipts"))).mode & 0o777).toBe(0o700);
    expect(dispatchingBoundaries).toEqual([
      "directory_opened",
      "temporary_opened",
      "written",
      "file_synced",
      "read_back",
      "renamed",
      "directory_synced",
    ]);
    expect(stderr.join("")).toContain(receiptPath);
    expect(stderr.join("")).toContain(lease.holder);
  });

  test("never dispatches without a fully durable holder-first receipt", async () => {
    for (const failedBoundary of [
      "directory_opened",
      "temporary_opened",
      "written",
      "file_synced",
      "read_back",
      "renamed",
    ] as const) {
      const root = await makeRoot();
      let remoteCommands = 0;
      const provider = createHistoricalPublicationProvider({
        ghCli: "/not-used/gh",
        githubCommand: async () => {
          remoteCommands += 1;
          return commandResult(undefined);
        },
        leaseReceiptBoundary: (boundary, state) => {
          if (state === "dispatching" && boundary === failedBoundary) {
            throw new Error(`crash_at_${failedBoundary}`);
          }
        },
        leaseReceiptDirectory: join(root, "receipts"),
        randomHolder: () => lease.holder,
        vercelCli: "/not-used/vercel",
        writeStderr: () => undefined,
      });
      await expect(provider.acquirePublicationLease(commit, candidateDigest, candidateReceipt))
        .rejects.toMatchObject({
        code: "local_source_invalid",
        phase: "before_publication",
      });
      expect(remoteCommands).toBe(0);
    }
  });

  test("rejects a non-private receipt directory before dispatch", async () => {
    const root = await makeRoot();
    const receiptDirectory = join(root, "receipts");
    await mkdir(receiptDirectory, { mode: 0o755 });
    let remoteCommands = 0;
    const provider = createHistoricalPublicationProvider({
      ghCli: "/not-used/gh",
      githubCommand: async () => {
        remoteCommands += 1;
        return commandResult(undefined);
      },
      leaseReceiptDirectory: receiptDirectory,
      randomHolder: () => lease.holder,
      vercelCli: "/not-used/vercel",
      writeStderr: () => undefined,
    });
    await expect(provider.acquirePublicationLease(commit, candidateDigest, candidateReceipt))
      .rejects.toMatchObject({
      code: "local_source_invalid",
    });
    expect(remoteCommands).toBe(0);
  });

  test("rejects a mode-private receipt directory with a dangerous Darwin ACL", async () => {
    if (process.platform !== "darwin") return;
    const root = await makeRoot();
    const receiptDirectory = join(root, "receipts");
    await mkdir(receiptDirectory, { mode: 0o700 });
    const acl = spawnSync("/bin/chmod", [
      "+a",
      "everyone allow list,search,add_file,add_subdirectory,delete_child,file_inherit,directory_inherit",
      receiptDirectory,
    ], { encoding: "utf8" });
    expect(acl.status).toBe(0);
    let remoteCommands = 0;
    const provider = createHistoricalPublicationProvider({
      ghCli: "/not-used/gh",
      githubCommand: async () => {
        remoteCommands += 1;
        return commandResult(undefined);
      },
      leaseReceiptDirectory: receiptDirectory,
      randomHolder: () => lease.holder,
      vercelCli: "/not-used/vercel",
      writeStderr: () => undefined,
    });
    await expect(provider.acquirePublicationLease(commit, candidateDigest, candidateReceipt))
      .rejects.toMatchObject({ code: "local_source_invalid" });
    expect(remoteCommands).toBe(0);
  });

  test("rejects a receipt whose exact descriptor readback differs", async () => {
    const root = await makeRoot();
    let remoteCommands = 0;
    const provider = createHistoricalPublicationProvider({
      ghCli: "/not-used/gh",
      githubCommand: async () => {
        remoteCommands += 1;
        return commandResult(undefined);
      },
      leaseReceiptBoundary: (boundary, state, temporaryPath) => {
        if (state === "dispatching" && boundary === "written") {
          writeFileSync(temporaryPath, "corrupt", { flag: "w" });
        }
      },
      leaseReceiptDirectory: join(root, "receipts"),
      randomHolder: () => lease.holder,
      vercelCli: "/not-used/vercel",
      writeStderr: () => undefined,
    });
    await expect(provider.acquirePublicationLease(commit, candidateDigest, candidateReceipt))
      .rejects.toMatchObject({
      code: "local_source_invalid",
    });
    expect(remoteCommands).toBe(0);
  });

  test("fails closed when a bound or active receipt transition cannot persist", async () => {
    for (const failedState of ["bound", "active"] as const) {
      const root = await makeRoot();
      const commands: string[][] = [];
      const responses = [
        commandResult({
          html_url: `https://github.com/hraness/hra/actions/runs/${String(lease.runId)}`,
          run_url: `https://api.github.com/repos/hraness/hra/actions/runs/${String(lease.runId)}`,
          workflow_run_id: lease.runId,
        }),
        commandResult(leaseRun()),
      ];
      const provider = createHistoricalPublicationProvider({
        ghCli: "/not-used/gh",
        githubCommand: async (arguments_) => {
          commands.push([...arguments_]);
          const response = responses.shift();
          if (response === undefined) throw new Error("unexpected GitHub command");
          return response;
        },
        leaseReceiptBoundary: (boundary, state) => {
          if (state === failedState && boundary === "file_synced") {
            throw new Error(`cannot_persist_${failedState}`);
          }
        },
        leaseReceiptDirectory: join(root, "receipts"),
        randomHolder: () => lease.holder,
        vercelCli: "/not-used/vercel",
        writeStderr: () => undefined,
      });
      await expect(provider.acquirePublicationLease(commit, candidateDigest, candidateReceipt))
        .rejects.toMatchObject({
        code: "publication_lease_cleanup_failed",
        leaseRunId: lease.runId,
        phase: "before_publication",
      });
      expect(commands).toHaveLength(failedState === "bound" ? 1 : 2);
    }
  });

  test("fails closed when terminal cancellation or publication state cannot persist", async () => {
    const root = await makeRoot();
    const cancelledProvider = createHistoricalPublicationProvider({
      ghCli: "/not-used/gh",
      githubCommand: async () => commandResult(leaseRun({
        conclusion: "cancelled",
        status: "completed",
      })),
      leaseReceiptBoundary: (boundary, state) => {
        if (state === "cancelled" && boundary === "file_synced") {
          throw new Error("cannot_persist_cancelled");
        }
      },
      leaseReceiptDirectory: join(root, "cancelled-receipts"),
      vercelCli: "/not-used/vercel",
      writeStderr: () => undefined,
    });
    await expect(cancelledProvider.cancelPublicationLease(lease)).rejects.toMatchObject({
      code: "publication_lease_cleanup_failed",
      leaseRunId: lease.runId,
      phase: "before_publication",
    });

    const publishedProvider = createHistoricalPublicationProvider({
      ghCli: "/not-used/gh",
      githubCommand: async () => commandResult(leaseRun({
        conclusion: "success",
        status: "completed",
      })),
      leaseReceiptBoundary: (boundary, state) => {
        if (state === "published" && boundary === "file_synced") {
          throw new Error("cannot_persist_published");
        }
      },
      leaseReceiptDirectory: join(root, "published-receipts"),
      vercelCli: "/not-used/vercel",
      writeStderr: () => undefined,
    });
    await expect(publishedProvider.completePublicationLease(lease)).rejects.toMatchObject({
      code: "publication_lease_cleanup_failed",
      leaseRunId: lease.runId,
      phase: "published_acceptance_failed",
    });
  });

  test("recovers a lost dispatch response through a permissive holder scan", async () => {
    const root = await makeRoot();
    const commands: string[][] = [];
    let now = 0;
    const responses = [
      commandResult(undefined, 1),
      commandResult(undefined, 1),
      commandResult({
        workflow_runs: [
          null,
          { display_title: "unrelated malformed run" },
          {
            display_title: `HRA publication lease ${lease.holder}`,
            id: lease.runId,
          },
        ],
      }),
      commandResult(leaseRun()),
    ];
    const provider = createHistoricalPublicationProvider({
      ghCli: "/not-used/gh",
      githubCommand: async (arguments_) => {
        commands.push([...arguments_]);
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected GitHub command");
        return response;
      },
      leaseAcquireTimeoutMs: 10_000,
      leaseReceiptDirectory: join(root, "receipts"),
      now: () => now,
      randomHolder: () => lease.holder,
      sleep: async (milliseconds) => { now += milliseconds; },
      vercelCli: "/not-used/vercel",
      writeStderr: () => undefined,
    });
    await expect(provider.acquirePublicationLease(commit, candidateDigest, candidateReceipt))
      .resolves.toEqual(lease);
    expect(commands.some((arguments_) => arguments_.some((argument) =>
      argument.includes("event=workflow_dispatch&head_sha=")))).toBeTrue();
    expect(commands.at(-1)).toContain(
      `repos/hraness/hra/actions/runs/${String(lease.runId)}`,
    );
  });

  test("finds a lost dispatch on page two before classifying the holder", async () => {
    const root = await makeRoot();
    const commands: string[][] = [];
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      display_title: `unrelated ${String(index)}`,
    }));
    const responses = [
      commandResult(undefined, 1),
      commandResult({ workflow_runs: firstPage }),
      commandResult({ workflow_runs: [leaseRun()] }),
    ];
    const provider = createHistoricalPublicationProvider({
      ghCli: "/not-used/gh",
      githubCommand: async (arguments_) => {
        commands.push([...arguments_]);
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected GitHub command");
        return response;
      },
      leaseReceiptDirectory: join(root, "receipts"),
      randomHolder: () => lease.holder,
      vercelCli: "/not-used/vercel",
      writeStderr: () => undefined,
    });
    await expect(provider.acquirePublicationLease(commit, candidateDigest, candidateReceipt))
      .resolves.toEqual(lease);
    expect(commands.some((arguments_) => arguments_.at(-1)?.endsWith("&page=2")))
      .toBeTrue();
  });

  test("requires a successful terminal full scan before reporting lost dispatch absence", async () => {
    const root = await makeRoot();
    let now = 0;
    const receiptPath = join(root, "receipts", `${tag}-${lease.holder}.json`);
    const responses = [
      commandResult(undefined, 1),
      commandResult(undefined, 1),
      commandResult(undefined, 1),
    ];
    const provider = createHistoricalPublicationProvider({
      ghCli: "/not-used/gh",
      githubCommand: async () => {
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected GitHub command");
        return response;
      },
      leaseAcquireTimeoutMs: 1,
      leaseReceiptDirectory: join(root, "receipts"),
      now: () => now,
      randomHolder: () => lease.holder,
      sleep: async (milliseconds) => { now += milliseconds; },
      vercelCli: "/not-used/vercel",
      writeStderr: () => undefined,
    });
    await expect(provider.acquirePublicationLease(commit, candidateDigest, candidateReceipt))
      .rejects.toMatchObject({
      code: "publication_lease_cleanup_failed",
      receiptPath,
    });
    expect(await Bun.file(receiptPath).exists()).toBeTrue();
  });

  test("reports lost dispatch absence only after a short terminal page", async () => {
    const root = await makeRoot();
    let now = 0;
    const receiptPath = join(root, "receipts", `${tag}-${lease.holder}.json`);
    const responses = [
      commandResult(undefined, 1),
      commandResult({ workflow_runs: [] }),
      commandResult({ workflow_runs: [] }),
    ];
    const provider = createHistoricalPublicationProvider({
      ghCli: "/not-used/gh",
      githubCommand: async () => {
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected GitHub command");
        return response;
      },
      leaseAcquireTimeoutMs: 1,
      leaseReceiptDirectory: join(root, "receipts"),
      now: () => now,
      randomHolder: () => lease.holder,
      sleep: async (milliseconds) => { now += milliseconds; },
      vercelCli: "/not-used/vercel",
      writeStderr: () => undefined,
    });
    await expect(provider.acquirePublicationLease(commit, candidateDigest, candidateReceipt))
      .rejects.toMatchObject({
      code: "publication_lease_unavailable",
      receiptPath,
    });
  });

  test("fails closed when the bounded terminal scan cannot disprove truncation", async () => {
    const root = await makeRoot();
    const commands: string[][] = [];
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      display_title: `unrelated ${String(index)}`,
    }));
    const provider = createHistoricalPublicationProvider({
      ghCli: "/not-used/gh",
      githubCommand: async (arguments_) => {
        commands.push([...arguments_]);
        return arguments_.includes("POST")
          ? commandResult(undefined, 1)
          : commandResult({ workflow_runs: fullPage });
      },
      leaseAcquireTimeoutMs: 0,
      leaseReceiptDirectory: join(root, "receipts"),
      randomHolder: () => lease.holder,
      vercelCli: "/not-used/vercel",
      writeStderr: () => undefined,
    });
    await expect(provider.acquirePublicationLease(commit, candidateDigest, candidateReceipt))
      .rejects.toMatchObject({
      code: "publication_lease_cleanup_failed",
    });
    const scans = commands.filter((arguments_) => arguments_.at(-1)?.includes("&page="));
    expect(scans).toHaveLength(100);
    expect(scans.at(-1)?.at(-1)).toEndWith("&page=100");
  });

  test("cancels and proves every identifiable duplicate holder run at timeout", async () => {
    const root = await makeRoot();
    const secondRunId = lease.runId + 1;
    const commands: string[][] = [];
    let now = 0;
    const queued = (id: number): Record<string, unknown> => leaseRun({
      conclusion: null,
      id,
      run_started_at: null,
      status: "queued",
    });
    const cancelled = (id: number): Record<string, unknown> => leaseRun({
      conclusion: "cancelled",
      id,
      status: "completed",
    });
    const responses = [
      commandResult(undefined, 1),
      commandResult({ workflow_runs: [queued(lease.runId), queued(secondRunId)] }),
      commandResult({ workflow_runs: [queued(lease.runId), queued(secondRunId)] }),
      commandResult(queued(lease.runId)),
      commandResult(undefined),
      commandResult(cancelled(lease.runId)),
      commandResult(queued(secondRunId)),
      commandResult(undefined),
      commandResult(cancelled(secondRunId)),
    ];
    const provider = createHistoricalPublicationProvider({
      ghCli: "/not-used/gh",
      githubCommand: async (arguments_) => {
        commands.push([...arguments_]);
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected GitHub command");
        return response;
      },
      leaseAcquireTimeoutMs: 1,
      leaseCleanupTimeoutMs: 10_000,
      leaseReceiptDirectory: join(root, "receipts"),
      now: () => now,
      randomHolder: () => lease.holder,
      sleep: async (milliseconds) => { now += milliseconds; },
      vercelCli: "/not-used/vercel",
      writeStderr: () => undefined,
    });
    await expect(provider.acquirePublicationLease(commit, candidateDigest, candidateReceipt))
      .rejects.toMatchObject({
      code: "publication_lease_unavailable",
      leaseRunId: lease.runId,
    });
    expect(commands.filter((arguments_) => arguments_.at(-1)?.endsWith("/cancel"))).toEqual([
      [
        "api",
        "--method",
        "POST",
        `repos/hraness/hra/actions/runs/${String(lease.runId)}/cancel`,
      ],
      [
        "api",
        "--method",
        "POST",
        `repos/hraness/hra/actions/runs/${String(secondRunId)}/cancel`,
      ],
    ]);
  });

  test("fails cleanup when a holder match has no cancellable exact identity", async () => {
    const root = await makeRoot();
    let now = 0;
    const responses = [
      commandResult(undefined, 1),
      commandResult({
        workflow_runs: [{ display_title: `HRA publication lease ${lease.holder}` }],
      }),
    ];
    const provider = createHistoricalPublicationProvider({
      ghCli: "/not-used/gh",
      githubCommand: async () => {
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected GitHub command");
        return response;
      },
      leaseAcquireTimeoutMs: 1,
      leaseReceiptDirectory: join(root, "receipts"),
      now: () => now,
      randomHolder: () => lease.holder,
      sleep: async (milliseconds) => { now += milliseconds; },
      vercelCli: "/not-used/vercel",
      writeStderr: () => undefined,
    });
    await expect(provider.acquirePublicationLease(commit, candidateDigest, candidateReceipt))
      .rejects.toMatchObject({
      code: "publication_lease_cleanup_failed",
      phase: "before_publication",
    });
  });

  test("maps provider cancellation success to publication and rejects other conclusions", async () => {
    const root = await makeRoot();
    const successProvider = createHistoricalPublicationProvider({
      ghCli: "/not-used/gh",
      githubCommand: async () => commandResult(leaseRun({
        conclusion: "success",
        status: "completed",
      })),
      leaseReceiptDirectory: join(root, "success-receipts"),
      vercelCli: "/not-used/vercel",
      writeStderr: () => undefined,
    });
    await expect(successProvider.cancelPublicationLease(lease)).resolves.toBe("published");

    const failureProvider = createHistoricalPublicationProvider({
      ghCli: "/not-used/gh",
      githubCommand: async () => commandResult(leaseRun({
        conclusion: "failure",
        status: "completed",
      })),
      leaseReceiptDirectory: join(root, "failure-receipts"),
      vercelCli: "/not-used/vercel",
      writeStderr: () => undefined,
    });
    await expect(failureProvider.cancelPublicationLease(lease)).rejects.toMatchObject({
      code: "publication_lease_cleanup_failed",
      leaseRunId: lease.runId,
    });
  });

  test("waits beyond three minutes for lease completion within the workflow budget", async () => {
    const root = await makeRoot();
    const startedAt = Date.parse("2026-08-23T12:00:00.000Z");
    let now = startedAt;
    const provider = createHistoricalPublicationProvider({
      ghCli: "/not-used/gh",
      githubCommand: async () => commandResult(leaseRun(
        now - startedAt >= 4 * 60 * 1_000
          ? {
              conclusion: "success",
              run_started_at: new Date(startedAt).toISOString(),
              status: "completed",
            }
          : { run_started_at: new Date(startedAt).toISOString() },
      )),
      leaseReceiptDirectory: join(root, "receipts"),
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
      vercelCli: "/not-used/vercel",
      writeStderr: () => undefined,
    });
    await expect(provider.completePublicationLease(lease)).resolves.toBeUndefined();
    expect(now - startedAt).toBeGreaterThanOrEqual(4 * 60 * 1_000);
  });

  test("retries transient transport, JSON, and run-envelope reads during completion", async () => {
    const root = await makeRoot();
    let now = 0;
    const responses = [
      commandResult(undefined, 1),
      { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.from("{") },
      commandResult({ id: lease.runId }),
      commandResult(leaseRun({ conclusion: "success", status: "completed" })),
    ];
    const provider = createHistoricalPublicationProvider({
      ghCli: "/not-used/gh",
      githubCommand: async () => {
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected GitHub command");
        return response;
      },
      leaseCompletionTimeoutMs: 20_000,
      leaseReceiptDirectory: join(root, "receipts"),
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
      vercelCli: "/not-used/vercel",
      writeStderr: () => undefined,
    });
    await expect(provider.completePublicationLease(lease)).resolves.toBeUndefined();
    expect(responses).toHaveLength(0);
  });

  test("keeps an exact run identity change terminal during completion", async () => {
    const root = await makeRoot();
    let sleeps = 0;
    const provider = createHistoricalPublicationProvider({
      ghCli: "/not-used/gh",
      githubCommand: async () => commandResult(leaseRun({ run_attempt: 2 })),
      leaseReceiptDirectory: join(root, "receipts"),
      sleep: async () => { sleeps += 1; },
      vercelCli: "/not-used/vercel",
      writeStderr: () => undefined,
    });
    await expect(provider.completePublicationLease(lease)).rejects.toMatchObject({
      code: "publication_lease_lost",
      leaseRunId: lease.runId,
    });
    expect(sleeps).toBe(0);
  });

  test("never retries or cancels after GitHub cleanup becomes indeterminate", async () => {
    const root = await makeRoot();
    const cleanup = new BoundedProcessCleanupUnprovenError(42_421, "github-lease-read");
    const commands: string[][] = [];
    let sleeps = 0;
    const provider = createHistoricalPublicationProvider({
      ghCli: "/not-used/gh",
      githubCommand: async (arguments_) => {
        commands.push([...arguments_]);
        throw cleanup;
      },
      leaseCleanupTimeoutMs: 10_000,
      leaseReceiptDirectory: join(root, "receipts"),
      sleep: async () => { sleeps += 1; },
      vercelCli: "/not-used/vercel",
      writeStderr: () => undefined,
    });
    await expect(provider.cancelPublicationLease(lease)).rejects.toBe(cleanup);
    await expect(provider.readRepository()).rejects.toBe(cleanup);
    expect(commands).toHaveLength(1);
    expect(sleeps).toBe(0);
  });

  test("retains the holder-first receipt and stops after an indeterminate dispatch", async () => {
    const root = await makeRoot();
    const cleanup = new BoundedProcessCleanupUnprovenError(42_422, "github-lease-dispatch");
    const commands: string[][] = [];
    const receiptPath = join(root, "receipts", `${tag}-${lease.holder}.json`);
    const provider = createHistoricalPublicationProvider({
      ghCli: "/not-used/gh",
      githubCommand: async (arguments_) => {
        commands.push([...arguments_]);
        throw cleanup;
      },
      leaseReceiptDirectory: join(root, "receipts"),
      randomHolder: () => lease.holder,
      vercelCli: "/not-used/vercel",
      writeStderr: () => undefined,
    });
    await expect(provider.acquirePublicationLease(commit, candidateDigest, candidateReceipt))
      .rejects.toBe(cleanup);
    expect(commands).toHaveLength(1);
    expect(await Bun.file(receiptPath).exists()).toBeTrue();
    expect(cleanup.recoveryPaths).toContain(receiptPath);
  });

  test("consumes an exact private receipt and permits retry only after draft reconciliation", async () => {
    const root = await makeRoot();
    const receiptDirectory = join(root, "receipts");
    const receipt = await writeRecoveryReceipt(receiptDirectory, {
      runAttempt: lease.runAttempt,
      runId: lease.runId,
      state: "bound",
    });
    const assets = makeAssets();
    const assetRows = assetNames.map((name, index) => ({
      id: index + 1,
      name,
      state: "uploaded",
    }));
    const release = {
      body: notes,
      draft: true,
      id: releaseId,
      immutable: false,
      name: tag.replace("v0.1.0", "HRA v0.1.0"),
      prerelease: true,
      tag_name: tag,
    };
    const commands: string[][] = [];
    let cancelled = false;
    const provider = createHistoricalPublicationProvider({
      ghCli: "/not-used/gh",
      githubCommand: async (arguments_) => {
        commands.push([...arguments_]);
        if (arguments_.at(-1)?.includes("/runs?")) {
          return commandResult({
            workflow_runs: [leaseRun(cancelled
              ? { conclusion: "cancelled", status: "completed" }
              : { conclusion: null, run_started_at: null, status: "queued" })],
          });
        }
        if (arguments_.at(-1)?.endsWith("/cancel")) {
          cancelled = true;
          return commandResult(undefined);
        }
        if (arguments_.at(-1)?.endsWith(`/runs/${String(lease.runId)}`)) {
          return commandResult(leaseRun(cancelled
            ? { conclusion: "cancelled", status: "completed" }
            : { conclusion: null, run_started_at: null, status: "queued" }));
        }
        throw new Error("unexpected GitHub command");
      },
      leaseReceiptDirectory: receiptDirectory,
      vercelCli: "/not-used/vercel",
      writeStderr: () => undefined,
    });
    stubRecoverySourceAuthority(provider);
    provider.listReleases = async () => [release];
    provider.listReleaseAssets = async () => assetRows;
    provider.downloadReleaseAsset = async (id, destination) => {
      const name = assetRows.find((asset) => asset.id === id)?.name;
      const value = name === undefined ? undefined : assets.get(name);
      if (value === undefined) throw new Error("missing fixture asset");
      await writeFile(destination, value, { flag: "wx", mode: 0o600 });
    };
    provider.readReviewedSourceAuthority = async () => ({
      archive: assets.get(`hra-${tag}.tgz`) ?? Buffer.alloc(0),
      notes,
    });
    provider.acceptPackedInstall = async () => undefined;
    await mkdir(join(root, "recovery"), { mode: 0o700 });
    await expect(provider.recoverPublicationLease(
      recoveryArguments(receipt),
      join(root, "recovery"),
    )).resolves.toEqual({
      commit,
      holder: lease.holder,
      status: "retry_permitted",
      tag,
    });
    expect(commands.some((arguments_) => arguments_.at(-1)?.endsWith("/cancel")))
      .toBeTrue();
    expect(JSON.parse(await readFile(receipt, "utf8"))).toMatchObject({
      runAttempt: lease.runAttempt,
      runId: lease.runId,
      state: "cancelled",
    });
  });

  test("accepts recovery only from the exact immutable public release and assets", async () => {
    const root = await makeRoot();
    const receiptDirectory = join(root, "receipts");
    const receipt = await writeRecoveryReceipt(receiptDirectory);
    const assets = makeAssets();
    const assetRows = assetNames.map((name, index) => ({
      id: index + 1,
      name,
      state: "uploaded",
    }));
    const release = {
      body: notes,
      draft: false,
      id: releaseId,
      immutable: true,
      name: "HRA v0.1.0",
      prerelease: true,
      tag_name: tag,
    };
    const provider = createHistoricalPublicationProvider({
      ghCli: "/not-used/gh",
      githubCommand: async () => commandResult({ workflow_runs: [] }),
      leaseReceiptDirectory: receiptDirectory,
      vercelCli: "/not-used/vercel",
      writeStderr: () => undefined,
    });
    stubRecoverySourceAuthority(provider);
    provider.listReleases = async () => [release];
    provider.listReleaseAssets = async () => assetRows;
    provider.downloadReleaseAsset = async (id, destination) => {
      const name = assetRows.find((asset) => asset.id === id)?.name;
      const value = name === undefined ? undefined : assets.get(name);
      if (value === undefined) throw new Error("missing fixture asset");
      await writeFile(destination, value, { flag: "wx", mode: 0o600 });
    };
    provider.downloadPublicReleaseAsset = async (name, destination) => {
      const value = assets.get(name);
      if (value === undefined) throw new Error("missing fixture asset");
      await writeFile(destination, value, { flag: "wx", mode: 0o600 });
    };
    provider.readReviewedSourceAuthority = async () => ({
      archive: assets.get(`hra-${tag}.tgz`) ?? Buffer.alloc(0),
      notes,
    });
    provider.acceptPackedInstall = async () => undefined;
    await mkdir(join(root, "recovery"), { mode: 0o700 });
    await expect(provider.recoverPublicationLease(
      recoveryArguments(receipt),
      join(root, "recovery"),
    )).resolves.toEqual({
      commit,
      holder: lease.holder,
      status: "published",
      tag,
    });
  });

  test("refuses a recovery receipt that is not an owned mode-0600 file", async () => {
    const root = await makeRoot();
    const receiptDirectory = join(root, "receipts");
    const receipt = await writeRecoveryReceipt(receiptDirectory);
    await chmod(receipt, 0o644);
    let remoteReads = 0;
    const provider = createHistoricalPublicationProvider({
      ghCli: "/not-used/gh",
      githubCommand: async () => {
        remoteReads += 1;
        return commandResult(undefined, 1);
      },
      leaseReceiptDirectory: receiptDirectory,
      vercelCli: "/not-used/vercel",
      writeStderr: () => undefined,
    });
    await expect(provider.recoverPublicationLease(
      recoveryArguments(receipt),
      join(root, "recovery"),
    )).rejects.toMatchObject({
      code: "publication_lease_cleanup_failed",
      receiptPath: receipt,
    });
    expect(remoteReads).toBe(0);
  });

  test("refuses a hard-linked recovery receipt before remote reads", async () => {
    const root = await makeRoot();
    const receiptDirectory = join(root, "receipts");
    const receipt = await writeRecoveryReceipt(receiptDirectory);
    await link(receipt, join(receiptDirectory, "second-link"));
    let remoteReads = 0;
    const provider = createHistoricalPublicationProvider({
      ghCli: "/not-used/gh",
      githubCommand: async () => {
        remoteReads += 1;
        return commandResult(undefined, 1);
      },
      leaseReceiptDirectory: receiptDirectory,
      vercelCli: "/not-used/vercel",
      writeStderr: () => undefined,
    });
    await expect(provider.recoverPublicationLease(
      recoveryArguments(receipt),
      join(root, "recovery"),
    )).rejects.toMatchObject({
      code: "publication_lease_cleanup_failed",
      receiptPath: receipt,
    });
    expect(remoteReads).toBe(0);
  });
});

describe("accepted release bundle", () => {
  test("does not wire the retired reviewed-source packer into the scoped release", async () => {
    const [packageDocument, workflow] = await Promise.all([
      Bun.file(join(import.meta.dir, "..", "package.json")).text()
        .then((value): unknown => JSON.parse(value)),
      Bun.file(join(import.meta.dir, "..", ".github", "workflows", "release.yml")).text(),
    ]);
    expect(packageDocument).toMatchObject({ name: "@hraness/hra" });
    expect(workflow).toContain('npm pack --ignore-scripts --pack-destination "$release_artifacts" .');
    expect(workflow).toContain('release_artifacts="$RUNNER_TEMP/hra-release-artifacts"');
    expect(workflow).not.toContain("$GITHUB_WORKSPACE/artifacts");
    expect(workflow).not.toContain("readReviewedSourceAuthority");
    expect(workflow).not.toContain("publish-beta-release.ts");
  });

  test("binds checksums and both SPDX contracts to the exact artifact set", async () => {
    const root = await makeRoot();
    await writeAccepted(root);
    const accepted = await verifyAcceptedBundle(root, commit);
    expect(accepted.commit).toBe(commit);
    expect(accepted.notes).toBe(notes);
    expect([...accepted.releaseAssets.keys()].sort()).toEqual([...assetNames]);
  });

  test("rejects a changed tarball before publication", async () => {
    const root = await makeRoot();
    await writeAccepted(root);
    await writeFile(join(root, `hra-${tag}.tgz`), "changed");
    await expect(verifyAcceptedBundle(root, commit)).rejects.toMatchObject({
      code: "accepted_artifact_invalid",
    });
  });

  test("rejects changed release notes before publication", async () => {
    const root = await makeRoot();
    await writeAccepted(root);
    await writeFile(join(root, "RELEASE_NOTES.md"), `${notes}\nchanged`);
    await expect(verifyAcceptedBundle(root, commit)).rejects.toMatchObject({
      code: "accepted_artifact_invalid",
    });
  });
});

describe("release publication authority", () => {
  test("selects only the exact artifact from the requested run attempt", async () => {
    const root = await makeRoot();
    const provider = new FakeProvider();
    provider.artifactAttempts = [1];
    await expect(executeReleasePublication({
      arguments: publicationArguments("publish"),
      provider,
      temporaryRoot: root,
    })).rejects.toMatchObject({ code: "workflow_run_invalid" });
    expect(provider.calls.some((call) => call.startsWith("download-run-artifact:"))).toBeFalse();

    const duplicateRoot = await makeRoot();
    const duplicateProvider = new FakeProvider();
    duplicateProvider.artifactAttempts = [runAttempt, runAttempt];
    await expect(executeReleasePublication({
      arguments: publicationArguments("publish"),
      provider: duplicateProvider,
      temporaryRoot: duplicateRoot,
    })).rejects.toMatchObject({ code: "workflow_run_invalid" });
  });

  test("requires an unexpired exact Actions artifact before PATCH", async () => {
    const root = await makeRoot();
    const provider = new FakeProvider();
    provider.artifactExpired = true;
    await expect(executeReleasePublication({
      arguments: publicationArguments("publish"),
      provider,
      temporaryRoot: root,
    })).rejects.toMatchObject({
      code: "workflow_run_invalid",
      phase: "before_publication",
    });
    expect(provider.calls).not.toContain("lease:acquire");
    expect(provider.calls).not.toContain("publish");
  });

  test("recovers immutable acceptance from durable public release assets after artifact expiry", async () => {
    const root = await makeRoot();
    const provider = new FakeProvider();
    provider.artifactExpired = true;
    provider.published = true;
    const result = await executeReleasePublication({
      arguments: publicationArguments("accept"),
      provider,
      temporaryRoot: root,
    });
    expect(result).toEqual({ commit, status: "accepted", tag });
    expect(provider.calls).not.toContain(`artifacts:${String(runId)}`);
    expect(provider.calls.some((call) => call.startsWith("download-run-artifact:"))).toBeFalse();
    for (const name of assetNames) {
      expect(provider.calls).toContain(`download-public-asset:${name}`);
    }
    expect(provider.calls).not.toContain("publish");
  });

  test("rejects an edited public body that no longer presents the immutable notes asset", async () => {
    const root = await makeRoot();
    const provider = new FakeProvider();
    provider.artifactExpired = true;
    provider.published = true;
    provider.releaseBody = `${notes}\n\nEdited after publication.`;
    await expect(executeReleasePublication({
      arguments: publicationArguments("accept"),
      provider,
      temporaryRoot: root,
    })).rejects.toMatchObject({
      code: "published_release_invalid",
      phase: "published_acceptance_failed",
    });
    expect(provider.calls).toContain("download-public-asset:RELEASE_NOTES.md");
    expect(provider.calls).not.toContain("publish");
  });

  test("never treats an immutable release as its own provenance authority", async () => {
    const root = await makeRoot();
    const provider = new FakeProvider();
    provider.artifactExpired = true;
    provider.published = true;
    provider.reviewedSourceMismatch = true;
    await expect(executeReleasePublication({
      arguments: publicationArguments("accept"),
      provider,
      temporaryRoot: root,
    })).rejects.toMatchObject({
      code: "published_release_invalid",
      phase: "published_acceptance_failed",
    });
    expect(provider.calls).toContain("reviewed-source-authority");
    expect(provider.calls).not.toContain("publish");
  });

  test("publishes only after exact reversible evidence and accepts the public URL", async () => {
    const root = await makeRoot();
    const provider = new FakeProvider();
    const result = await executeReleasePublication({
      arguments: publicationArguments("publish"),
      provider,
      temporaryRoot: root,
    });
    expect(result).toEqual({ commit, status: "published", tag });
    expect(provider.publishedReleaseId).toBe(releaseId);
    expect(provider.calls).toContain(
      `download-run-artifact:${String(runId)}:${releaseArtifactName(runId, runAttempt)}`,
    );
    expect(provider.calls).not.toContain(
      `download-run-artifact:${String(runId)}:${releaseArtifactName(runId, 1)}`,
    );
    const publishIndex = provider.calls.indexOf("publish");
    const finalReleaseRead = provider.calls.lastIndexOf("releases:draft", publishIndex);
    const finalAssetRead = provider.calls.lastIndexOf(`release-assets:${String(releaseId)}`, publishIndex);
    const finalTagRead = provider.calls.lastIndexOf("tag-commit", publishIndex);
    const finalMainRead = provider.calls.lastIndexOf("main-comparison", publishIndex);
    const finalProtectionRead = provider.calls.lastIndexOf("tag-protection", publishIndex);
    const finalHostedVersion = provider.calls.lastIndexOf("vercel-version", publishIndex);
    const finalHostedMarker = provider.calls.lastIndexOf(
      "hosted-marker:try-hra.vercel.app",
      publishIndex,
    );
    const finalLeaseRead = provider.calls.lastIndexOf("lease:assert", publishIndex);
    const finalCandidateRead = provider.calls.lastIndexOf(
      `candidate:${candidateReceipt}:${commit}`,
      publishIndex,
    );
    expect(finalTagRead).toBeLessThan(finalHostedVersion);
    expect(finalMainRead).toBeLessThan(finalHostedVersion);
    expect(finalProtectionRead).toBeLessThan(finalHostedVersion);
    expect(finalHostedMarker).toBeLessThan(finalLeaseRead);
    expect(finalReleaseRead).toBeLessThan(finalAssetRead);
    expect(finalAssetRead).toBeLessThan(finalLeaseRead);
    expect(finalCandidateRead).toBeLessThan(finalLeaseRead);
    expect(finalLeaseRead + 1).toBe(publishIndex);
    expect(provider.calls.indexOf("lease:acquire")).toBeLessThan(finalTagRead);
    expect(provider.calls.indexOf("lease:complete")).toBeGreaterThan(publishIndex);
    expect(provider.calls).not.toContain("lease:cancel");
    expect(provider.calls.slice(publishIndex + 1)).toContain("vercel-version");
    expect(provider.calls.slice(publishIndex + 1)).toContain("hosted-marker:hra.sh");
    expect(provider.calls).toContain(
      `public-install:https://github.com/hraness/hra/releases/download/${tag}/hra-${tag}.tgz`,
    );
  });

  test("performs no readback, cancellation, completion, or success after indeterminate PATCH cleanup", async () => {
    const root = await makeRoot();
    const provider = new FakeProvider();
    const cleanup = new BoundedProcessCleanupUnprovenError(42_423, "github-release-publish");
    provider.publishCleanupFailure = cleanup;
    await expect(executeReleasePublication({
      arguments: publicationArguments("publish"),
      provider,
      temporaryRoot: root,
    })).rejects.toBe(cleanup);
    const publishIndex = provider.calls.indexOf("publish");
    expect(publishIndex).toBeGreaterThan(0);
    expect(provider.calls.slice(publishIndex + 1)).toEqual([]);
    expect(provider.calls).not.toContain("lease:cancel");
    expect(provider.calls).not.toContain("lease:complete");
    expect(cleanup.diagnostics).toEqual({ publicationPhase: "publication_unknown" });
  });

  test("fails closed on tag, ancestry, draft, asset, or hosted-authority races", async () => {
    for (const mutate of [
      (provider: FakeProvider): void => { provider.mainContainsCommit = false; },
      (provider: FakeProvider): void => { provider.immutable = false; },
      (provider: FakeProvider): void => { provider.tagProtected = false; },
      (provider: FakeProvider): void => { provider.assetIdentityChangesBeforePublish = true; },
      (provider: FakeProvider): void => { provider.draftImmutable = true; },
    ]) {
      const root = await makeRoot();
      const provider = new FakeProvider();
      mutate(provider);
      await expect(executeReleasePublication({
        arguments: publicationArguments("publish"),
        provider,
        temporaryRoot: root,
      })).rejects.toMatchObject({ phase: "before_publication" });
      expect(provider.calls).not.toContain("publish");
    }
  });

  test("revalidates the sealed receipt immediately before lease dispatch and PATCH", async () => {
    const beforeLeaseRoot = await makeRoot();
    const beforeLease = new FakeProvider();
    beforeLease.candidateDigests = [candidateDigest, "e".repeat(64)];
    await expect(executeReleasePublication({
      arguments: publicationArguments("publish"),
      provider: beforeLease,
      temporaryRoot: beforeLeaseRoot,
    })).rejects.toThrow("release_authority_changed");
    expect(beforeLease.calls).not.toContain("lease:acquire");
    expect(beforeLease.calls).not.toContain("publish");

    const beforePatchRoot = await makeRoot();
    const beforePatch = new FakeProvider();
    beforePatch.candidateDigests = [candidateDigest, candidateDigest, "e".repeat(64)];
    await expect(executeReleasePublication({
      arguments: publicationArguments("publish"),
      provider: beforePatch,
      temporaryRoot: beforePatchRoot,
    })).rejects.toThrow("release_authority_changed");
    expect(beforePatch.calls).toContain("lease:acquire");
    expect(beforePatch.calls).toContain("lease:cancel");
    expect(beforePatch.calls).not.toContain("publish");
  });

  test("requires the exact in-progress lease and cancels it on a prepublication refusal", async () => {
    const root = await makeRoot();
    const provider = new FakeProvider();
    provider.leaseLost = true;
    await expect(executeReleasePublication({
      arguments: publicationArguments("publish"),
      provider,
      temporaryRoot: root,
    })).rejects.toMatchObject({ phase: "before_publication" });
    expect(provider.calls).toContain("lease:acquire");
    expect(provider.calls).toContain("lease:assert");
    expect(provider.calls).toContain("lease:cancel");
    expect(provider.calls).not.toContain("publish");
  });

  test("refuses when the lease is lost during final candidate verification", async () => {
    const root = await makeRoot();
    const provider = new FakeProvider();
    provider.loseLeaseOnCandidateRead = 3;
    await expect(executeReleasePublication({
      arguments: publicationArguments("publish"),
      provider,
      temporaryRoot: root,
    })).rejects.toMatchObject({
      code: "publication_lease_lost",
      phase: "before_publication",
    });
    const finalCandidateRead = provider.calls.lastIndexOf(
      `candidate:${candidateReceipt}:${commit}`,
    );
    expect(provider.calls[finalCandidateRead + 1]).toBe("lease:assert");
    expect(provider.calls).toContain("lease:cancel");
    expect(provider.calls).not.toContain("publish");
  });

  test("refuses publication when a competing operator owns the workflow lease", async () => {
    const root = await makeRoot();
    const provider = new FakeProvider();
    provider.leaseUnavailable = true;
    await expect(executeReleasePublication({
      arguments: publicationArguments("publish"),
      provider,
      temporaryRoot: root,
    })).rejects.toMatchObject({ phase: "before_publication" });
    expect(provider.calls).toContain("lease:acquire");
    expect(provider.calls).not.toContain("publish");
    expect(provider.calls).not.toContain("lease:cancel");
  });

  test("surfaces a lease cleanup failure without claiming a safe handoff", async () => {
    const root = await makeRoot();
    const provider = new FakeProvider();
    provider.assetIdentityChangesBeforePublish = true;
    provider.leaseCleanupFails = true;
    await expect(executeReleasePublication({
      arguments: publicationArguments("publish"),
      provider,
      temporaryRoot: root,
    })).rejects.toMatchObject({
      code: "publication_lease_cleanup_failed",
      leaseRunId: provider.leaseRunId,
      phase: "before_publication",
    });
    expect(provider.calls).toContain("lease:cancel");
    expect(provider.calls).not.toContain("publish");
  });

  test("reconciles a cancellation race that completed publication as acceptance-only", async () => {
    const root = await makeRoot();
    const provider = new FakeProvider();
    provider.leaseLost = true;
    provider.leaseCancellationOutcome = "published";
    await expect(executeReleasePublication({
      arguments: publicationArguments("publish"),
      provider,
      temporaryRoot: root,
    })).rejects.toMatchObject({
      code: "publication_lease_completed",
      leaseRunId: provider.leaseRunId,
      phase: "published_acceptance_failed",
    });
    expect(provider.calls).toContain("lease:cancel");
    expect(provider.calls).toContain("releases:public");
    expect(provider.calls).not.toContain("publish");
  });

  test("reports an unknown outcome when cancellation observes an invalid public release", async () => {
    const root = await makeRoot();
    const provider = new FakeProvider();
    provider.leaseLost = true;
    provider.leaseCancellationOutcome = "published";
    provider.publicReleaseImmutable = false;
    await expect(executeReleasePublication({
      arguments: publicationArguments("publish"),
      provider,
      temporaryRoot: root,
    })).rejects.toMatchObject({
      code: "publication_unknown",
      leaseRunId: provider.leaseRunId,
      phase: "publication_unknown",
    });
    expect(provider.calls).toContain("lease:cancel");
    expect(provider.calls).toContain("releases:public");
    expect(provider.calls).not.toContain("publish");
  });

  test("refuses every mismatched hosted release identity before publication", async () => {
    for (const fault of [
      "canonical-alias",
      "canonical-marker",
      "deployment",
      "deployment-source",
      "deployment-state",
      "fallback-alias",
      "fallback-marker",
      "fallback-marker-repository",
      "fallback-marker-shape",
      "owner",
      "project",
      "staging-alias",
      "staging-marker",
      "team",
      "version",
    ] as const) {
      const root = await makeRoot();
      const provider = new FakeProvider();
      provider.hostedFault = fault;
      await expect(executeReleasePublication({
        arguments: publicationArguments("publish"),
        provider,
        temporaryRoot: root,
      })).rejects.toMatchObject({
        code: "hosted_authority_invalid",
        phase: "before_publication",
      });
      expect(provider.calls).not.toContain("publish");
    }
  });

  test("recovers a lost publish response only from an immutable public readback", async () => {
    const root = await makeRoot();
    const provider = new FakeProvider();
    provider.publishFailsAfterCommit = true;
    const result = await executeReleasePublication({
      arguments: publicationArguments("publish"),
      provider,
      temporaryRoot: root,
    });
    expect(result.status).toBe("published");
    expect(provider.calls).toContain("releases:public");
    expect(provider.calls).toContain("lease:complete");
    expect(provider.calls).not.toContain("lease:cancel");
  });

  test("reports an unknown commit point when publication fails without a public readback", async () => {
    const root = await makeRoot();
    const provider = new FakeProvider();
    provider.publishFailsBeforeCommit = true;
    await expect(executeReleasePublication({
      arguments: publicationArguments("publish"),
      provider,
      temporaryRoot: root,
    })).rejects.toMatchObject({
      code: "publication_unknown",
      leaseRunId: provider.leaseRunId,
      phase: "publication_unknown",
    });
    expect(provider.published).toBeFalse();
    expect(provider.calls).not.toContain("lease:cancel");
    expect(provider.calls).not.toContain("lease:complete");
  });

  test("reports a post-publication lease handoff failure as acceptance-only recovery", async () => {
    const root = await makeRoot();
    const provider = new FakeProvider();
    provider.leaseCleanupFails = true;
    await expect(executeReleasePublication({
      arguments: publicationArguments("publish"),
      provider,
      temporaryRoot: root,
    })).rejects.toMatchObject({
      code: "publication_lease_cleanup_failed",
      leaseRunId: provider.leaseRunId,
      phase: "published_acceptance_failed",
    });
    expect(provider.published).toBeTrue();
    expect(provider.calls).toContain("lease:complete");
  });

  test("keeps post-publication failures in acceptance-only recovery", async () => {
    for (const mutate of [
      (provider: FakeProvider): void => { provider.publicInstallFails = true; },
      (provider: FakeProvider): void => { provider.publicReleaseImmutable = false; },
      (provider: FakeProvider): void => { provider.hostedFailsAfterPublish = true; },
    ]) {
      const root = await makeRoot();
      const provider = new FakeProvider();
      mutate(provider);
      await expect(executeReleasePublication({
        arguments: publicationArguments("publish"),
        provider,
        temporaryRoot: root,
      })).rejects.toMatchObject({ phase: "published_acceptance_failed" });
      expect(provider.published).toBeTrue();
    }
  });

  test("accepts an existing immutable release without invoking publication", async () => {
    const root = await makeRoot();
    const provider = new FakeProvider();
    provider.published = true;
    const result = await executeReleasePublication({
      arguments: publicationArguments("accept"),
      provider,
      temporaryRoot: root,
    });
    expect(result.status).toBe("accepted");
    expect(provider.calls).not.toContain("publish");
    expect(provider.calls).toContain("lease:acquire");
    expect(provider.calls).toContain("lease:complete");
    expect(provider.calls[0]).toBe(`candidate:${candidateReceipt}:${commit}`);
    expect(provider.calls).toContain("hosted-marker:hra.sh");
  });

  test("never accepts recovery without a successful ephemeral public URL installation", async () => {
    const root = await makeRoot();
    const provider = new FakeProvider();
    provider.published = true;
    provider.leaseCleanupFails = true;
    await expect(executeReleasePublication({
      arguments: publicationArguments("accept"),
      provider,
      temporaryRoot: root,
    })).rejects.toMatchObject({
      code: "publication_lease_cleanup_failed",
      leaseRunId: provider.leaseRunId,
      phase: "published_acceptance_failed",
    });
    expect(provider.calls).toContain("lease:acquire");
    expect(provider.calls).toContain("lease:complete");
    expect(provider.calls).not.toContain("publish");
  });
});
