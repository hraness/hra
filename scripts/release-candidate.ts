#!/usr/bin/env bun

import { dirname, isAbsolute, resolve } from "node:path";

import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { z } from "zod";

import { createBoundedAuthorityFetch } from "./bounded-authority-fetch";
import {
  BoundedProcessInvocationGuard,
  type BoundedProcessContainment,
  isBoundedProcessCleanupUnprovenError,
  isBoundedProcessRecoveryJournalError,
  recoverBoundedProcessJournal,
  retainBoundedProcessRecoveryPath,
  requireBoundedProcessCleanup,
  runBoundedProcess,
  settleConcurrentOperations,
} from "./bounded-process";
import { renderAuthorityContainmentUnavailable } from "./authority-containment";
import {
  canonicalDigest,
  defaultReleaseCandidatePath,
  ensureProtectedDirectory,
  HRA_RELEASE_TAG,
  HRA_RELEASE_VERSION,
  HRA_REPOSITORY,
  HRA_REPOSITORY_ID,
  HRA_V0_VERCEL_PROJECT_ID,
  HRA_VERCEL_PROJECT_ID,
  HRA_VERCEL_TEAM_ID,
  parseCutoverEvidenceFile,
  parseDeployEvidenceFile,
  parseLiveAcceptanceEvidenceFile,
  parseReleaseCandidateReceiptFile,
  releaseCandidateReceiptSchema,
  runtimeReleaseAttestationSchema,
  vercelEndpointEvidenceSchema,
  withSelfDigest,
  writeProtectedJsonNoReplace,
  type ReleaseCandidateReceipt,
  type RuntimeReleaseAttestation,
} from "./release-evidence";
import {
  preflightCutoverPlan,
  VercelCutoverProvider,
  type CutoverEndpoint,
  type CutoverPlan,
} from "./domain-cutover";

const oldRepositoryId = 1_334_876_494;
const oldProjectId = HRA_V0_VERCEL_PROJECT_ID;
const newProjectId = HRA_VERCEL_PROJECT_ID;
const commandMaximumBytes = 4 * 1024 * 1024;
const commandTimeoutMs = 120_000;
const commandTerminationGraceMs = 5_000;
const convexAuthorityTimeoutMs = 30_000;
const commitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const positiveIntegerSchema = z.number().int().positive().safe();

export class ReleaseCandidateError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ReleaseCandidateError";
  }
}

export type CandidateCiJob = Readonly<{
  completedAt: string;
  conclusion: "success";
  headCommit: string;
  name: "Check (macos-15)" | "Check (ubuntu-24.04)" | "Required";
  runAttempt: number;
  runId: number;
  workflow: "CI";
}>;

export type CandidateTagAuthority = Readonly<{
  candidateDigest: string;
  commit: string;
}>;

export type CandidateReleaseState = "absent" | "draft" | "published";

export interface ReleaseCandidateProvider {
  createLocalTag(commit: string, candidateDigest: string): Promise<void>;
  pushTag(): Promise<void>;
  readCiJobs(commit: string): Promise<readonly CandidateCiJob[]>;
  readLocalTag(): Promise<CandidateTagAuthority | null>;
  readReleaseState(): Promise<CandidateReleaseState>;
  readRemoteTag(): Promise<CandidateTagAuthority | null>;
  readRuntimeAttestation(
    deploymentUrl: string,
  ): Promise<RuntimeReleaseAttestation>;
  readSurfaceDigest(): Promise<string>;
  readVercelAuthorityDigest(
    candidate: ReleaseCandidateReceipt["vercel"]["candidate"],
    fallback: ReleaseCandidateReceipt["vercel"]["fallback"],
  ): Promise<string>;
  verifyLocalSource(commit: string): Promise<void>;
}

export type CandidateEvidencePaths = Readonly<{
  bootstrapDeploy: string;
  bootstrapLive: string;
  candidateDeploy: string;
  candidateLive: string;
  finalForwardCutover: string;
  forwardCutover: string;
  reverseCutover: string;
}>;

export type CandidateVercelAuthority = Readonly<{
  candidate: ReleaseCandidateReceipt["vercel"]["candidate"];
  fallback: ReleaseCandidateReceipt["vercel"]["fallback"];
}>;

const exactCiJobs = (
  jobs: readonly CandidateCiJob[],
  sourceCommit: string,
): ReleaseCandidateReceipt["ci"] => {
  const parsed = z.array(z.object({
    completedAt: z.string().datetime({ offset: true }),
    conclusion: z.literal("success"),
    headCommit: z.literal(sourceCommit),
    name: z.enum(["Check (macos-15)", "Check (ubuntu-24.04)", "Required"]),
    runAttempt: positiveIntegerSchema,
    runId: positiveIntegerSchema,
    workflow: z.literal("CI"),
  }).strict()).length(3).parse(jobs);
  const sorted = [...parsed].sort((left, right) => (
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  ));
  const names = sorted.map((job) => job.name);
  const identities = new Set(sorted.map((job) => `${String(job.runId)}:${String(job.runAttempt)}`));
  if (
    JSON.stringify(names) !== JSON.stringify([
      "Check (macos-15)",
      "Check (ubuntu-24.04)",
      "Required",
    ])
    || identities.size !== 1
  ) throw new ReleaseCandidateError("ci_authority_invalid");
  return sorted as ReleaseCandidateReceipt["ci"];
};

const assertTagAuthority = (
  actual: CandidateTagAuthority | null,
  receipt: ReleaseCandidateReceipt,
  expected: "absent" | "exact",
): void => {
  if (expected === "absent") {
    if (actual !== null) throw new ReleaseCandidateError("tag_already_exists");
    return;
  }
  if (
    actual === null
    || actual.commit !== receipt.sourceCommit
    || actual.candidateDigest !== receipt.selfDigest
  ) throw new ReleaseCandidateError("tag_authority_invalid");
};

const authorityDigestForPlan = async (
  provider: VercelCutoverProvider,
  plan: CutoverPlan,
): Promise<string> => {
  await provider.verifyVersion();
  const authority = await preflightCutoverPlan(plan, provider);
  if (
    authority.status !== "already_committed"
    || authority.nextAction !== "replay_plan_for_receipt"
    || authority.reason !== "exact_target"
  ) throw new ReleaseCandidateError("vercel_authority_invalid");
  return canonicalDigest({
    authority,
    canonicalAlias: "hra.sh",
    fallbackAlias: "hra-weld.vercel.app",
    stagingAlias: "try-hra.vercel.app",
    target: plan.target,
  });
};

const asCutoverEndpoint = (
  endpoint: ReleaseCandidateReceipt["vercel"]["candidate"],
): CutoverEndpoint => ({
  ...endpoint,
  generation: endpoint.projectId === newProjectId ? 1 : 0,
});

export const candidateForwardPlan = (
  candidate: ReleaseCandidateReceipt["vercel"]["candidate"],
  fallback: ReleaseCandidateReceipt["vercel"]["fallback"],
): CutoverPlan => ({
  direction: "forward",
  mode: "domain",
  schemaVersion: 1,
  source: asCutoverEndpoint(fallback),
  target: asCutoverEndpoint(candidate),
});

export const candidateReversePlan = (
  candidate: ReleaseCandidateReceipt["vercel"]["candidate"],
  fallback: ReleaseCandidateReceipt["vercel"]["fallback"],
): CutoverPlan => ({
  direction: "reverse",
  mode: "domain",
  schemaVersion: 1,
  source: asCutoverEndpoint(candidate),
  target: asCutoverEndpoint(fallback),
});

export async function buildReleaseCandidateReceipt(options: Readonly<{
  evidence: CandidateEvidencePaths;
  now?: () => number;
  provider: ReleaseCandidateProvider;
  sourceCommit: string;
  vercel: CandidateVercelAuthority;
}>): Promise<ReleaseCandidateReceipt> {
  if (!commitSchema.safeParse(options.sourceCommit).success) {
    throw new ReleaseCandidateError("source_invalid");
  }
  const [
    bootstrapDeploy,
    bootstrapLive,
    candidateDeploy,
    candidateLive,
    forward,
    reverse,
    finalForward,
  ] = [
    parseDeployEvidenceFile(options.evidence.bootstrapDeploy),
    parseLiveAcceptanceEvidenceFile(options.evidence.bootstrapLive),
    parseDeployEvidenceFile(options.evidence.candidateDeploy),
    parseLiveAcceptanceEvidenceFile(options.evidence.candidateLive),
    parseCutoverEvidenceFile(options.evidence.forwardCutover),
    parseCutoverEvidenceFile(options.evidence.reverseCutover),
    parseCutoverEvidenceFile(options.evidence.finalForwardCutover),
  ];
  const forwardPlanDigest = canonicalDigest(candidateForwardPlan(
    options.vercel.candidate,
    options.vercel.fallback,
  ));
  const reversePlanDigest = canonicalDigest(candidateReversePlan(
    options.vercel.candidate,
    options.vercel.fallback,
  ));
  if (
    bootstrapDeploy.phase !== "bootstrap"
    || candidateDeploy.phase !== "candidate"
    || candidateDeploy.previousDeployDigest !== bootstrapDeploy.selfDigest
    || canonicalDigest(candidateDeploy.before) !== canonicalDigest(bootstrapDeploy.after)
    || canonicalDigest(candidateDeploy.target) !== canonicalDigest(bootstrapDeploy.target)
    || candidateDeploy.sourceCommit !== options.sourceCommit
    || bootstrapLive.sourceCommit !== bootstrapDeploy.sourceCommit
    || bootstrapLive.targetDigest !== bootstrapDeploy.targetDigest
    || bootstrapLive.deployEvidenceDigest !== bootstrapDeploy.selfDigest
    || bootstrapLive.runtimeRevision !== bootstrapDeploy.after.runtimeRevision
    || bootstrapLive.startedAt <= bootstrapDeploy.after.deployedAtMs
    || candidateLive.sourceCommit !== options.sourceCommit
    || candidateLive.targetDigest !== candidateDeploy.targetDigest
    || candidateLive.deployEvidenceDigest !== candidateDeploy.selfDigest
    || candidateLive.runtimeRevision !== candidateDeploy.after.runtimeRevision
    || candidateLive.startedAt <= candidateDeploy.after.deployedAtMs
    || forward.sequence !== 1
    || reverse.sequence !== 2
    || finalForward.sequence !== 3
    || forward.planDigest !== forwardPlanDigest
    || reverse.planDigest !== reversePlanDigest
    || finalForward.planDigest !== forwardPlanDigest
    || reverse.previousDigest !== forward.selfDigest
    || finalForward.previousDigest !== reverse.selfDigest
    || forward.finalAuthorityDigest !== finalForward.finalAuthorityDigest
    || reverse.finalAuthorityDigest === finalForward.finalAuthorityDigest
    || [forward, reverse, finalForward].some((entry) => entry.sourceCommit !== options.sourceCommit)
    || options.vercel.candidate.sourceCommit !== options.sourceCommit
  ) throw new ReleaseCandidateError("evidence_chain_invalid");

  await options.provider.verifyLocalSource(options.sourceCommit);
  const [ci, runtime, surfaceDigest, authorityDigest, remoteTag, localTag, releaseState] =
    await settleConcurrentOperations([
      options.provider.readCiJobs(options.sourceCommit),
      options.provider.readRuntimeAttestation(candidateDeploy.target.deploymentUrl),
      options.provider.readSurfaceDigest(),
      options.provider.readVercelAuthorityDigest(
        options.vercel.candidate,
        options.vercel.fallback,
      ),
      options.provider.readRemoteTag(),
      options.provider.readLocalTag(),
      options.provider.readReleaseState(),
    ]);
  if (
    canonicalDigest(runtime) !== canonicalDigest(candidateDeploy.after)
    || authorityDigest !== finalForward.finalAuthorityDigest
    || remoteTag !== null
    || localTag !== null
    || releaseState !== "absent"
  ) throw new ReleaseCandidateError("release_authority_invalid");
  const exactCi = exactCiJobs(ci, options.sourceCommit);
  const evidenceMaximum = Math.max(
    bootstrapLive.completedAt,
    candidateLive.completedAt,
    ...exactCi.map((job) => Date.parse(job.completedAt)),
  );
  const sealedAt = options.now?.() ?? Date.now();
  if (!Number.isSafeInteger(sealedAt) || sealedAt < evidenceMaximum) {
    throw new ReleaseCandidateError("seal_time_invalid");
  }
  return releaseCandidateReceiptSchema.parse(withSelfDigest({
    ci: exactCi,
    convex: {
      bootstrapDeployDigest: bootstrapDeploy.selfDigest,
      bootstrapLive: {
        completedAt: bootstrapLive.completedAt,
        deployEvidenceDigest: bootstrapLive.deployEvidenceDigest,
        digest: bootstrapLive.selfDigest,
        packageVersion: bootstrapLive.packageVersion,
        sourceCommit: bootstrapLive.sourceCommit,
        startedAt: bootstrapLive.startedAt,
        targetDigest: bootstrapLive.targetDigest,
        runtimeRevision: bootstrapLive.runtimeRevision,
      },
      bootstrapRuntime: bootstrapDeploy.after,
      candidateDeployDigest: candidateDeploy.selfDigest,
      candidateLive: {
        completedAt: candidateLive.completedAt,
        deployEvidenceDigest: candidateLive.deployEvidenceDigest,
        digest: candidateLive.selfDigest,
        packageVersion: candidateLive.packageVersion,
        sourceCommit: candidateLive.sourceCommit,
        startedAt: candidateLive.startedAt,
        targetDigest: candidateLive.targetDigest,
        runtimeRevision: candidateLive.runtimeRevision,
      },
      candidateRuntime: candidateDeploy.after,
      target: candidateDeploy.target,
      targetDigest: candidateDeploy.targetDigest,
    },
    cutover: {
      finalForwardDigest: finalForward.selfDigest,
      forwardDigest: forward.selfDigest,
      reverseDigest: reverse.selfDigest,
    },
    kind: "release-candidate" as const,
    releaseVersion: HRA_RELEASE_VERSION,
    repository: { id: HRA_REPOSITORY_ID, name: HRA_REPOSITORY },
    schemaVersion: 1 as const,
    sealedAt,
    sourceCommit: options.sourceCommit,
    surfaceDigest,
    tag: HRA_RELEASE_TAG,
    vercel: {
      authorityDigest,
      candidate: options.vercel.candidate,
      fallback: options.vercel.fallback,
      teamId: HRA_VERCEL_TEAM_ID,
    },
  }));
}

export async function createReleaseCandidateReceipt(options: Readonly<{
  evidence: CandidateEvidencePaths;
  outputPath?: string;
  now?: () => number;
  provider: ReleaseCandidateProvider;
  sourceCommit: string;
  vercel: CandidateVercelAuthority;
}>): Promise<Readonly<{ path: string; receipt: ReleaseCandidateReceipt; replayed: boolean }>> {
  const path = options.outputPath ?? defaultReleaseCandidatePath(options.sourceCommit);
  ensureProtectedDirectory(dirname(path));
  let existing: ReleaseCandidateReceipt | undefined;
  try {
    existing = parseReleaseCandidateReceiptFile(path, {
      recoverInterruptedPublication: true,
    });
  } catch (error: unknown) {
    if (
      !(error instanceof Error)
      || error.message !== "evidence_not_found"
    ) throw error;
  }
  const receipt = await buildReleaseCandidateReceipt({
    evidence: options.evidence,
    ...(existing !== undefined
      ? { now: () => existing.sealedAt }
      : options.now === undefined ? {} : { now: options.now }),
    provider: options.provider,
    sourceCommit: options.sourceCommit,
    vercel: options.vercel,
  });
  const result = writeProtectedJsonNoReplace(
    path,
    receipt,
    releaseCandidateReceiptSchema,
    { allowExactReplay: true },
  );
  return { path: result.path, receipt, replayed: result.replayed };
}

export async function verifyReleaseCandidateReceipt(options: Readonly<{
  expectedReleaseState: "absent" | "any" | "draft-or-published";
  expectedTag: "absent" | "exact";
  path: string;
  provider: ReleaseCandidateProvider;
}>): Promise<ReleaseCandidateReceipt> {
  const receipt = parseReleaseCandidateReceiptFile(options.path);
  await options.provider.verifyLocalSource(receipt.sourceCommit);
  const [
    ci,
    runtime,
    surfaceDigest,
    authorityDigest,
    remoteTag,
    releaseState,
  ] = await settleConcurrentOperations([
    options.provider.readCiJobs(receipt.sourceCommit),
    options.provider.readRuntimeAttestation(receipt.convex.target.deploymentUrl),
    options.provider.readSurfaceDigest(),
    options.provider.readVercelAuthorityDigest(
      receipt.vercel.candidate,
      receipt.vercel.fallback,
    ),
    options.provider.readRemoteTag(),
    options.provider.readReleaseState(),
  ]);
  if (
    canonicalDigest(exactCiJobs(ci, receipt.sourceCommit)) !== canonicalDigest(receipt.ci)
    || canonicalDigest(runtime) !== canonicalDigest(receipt.convex.candidateRuntime)
    || surfaceDigest !== receipt.surfaceDigest
    || authorityDigest !== receipt.vercel.authorityDigest
    || (options.expectedReleaseState === "absent" && releaseState !== "absent")
    || (
      options.expectedReleaseState === "draft-or-published"
      && releaseState === "absent"
    )
  ) throw new ReleaseCandidateError("release_authority_changed");
  assertTagAuthority(remoteTag, receipt, options.expectedTag);
  return receipt;
}

export async function tagReleaseCandidate(options: Readonly<{
  path: string;
  provider: ReleaseCandidateProvider;
}>): Promise<Readonly<{ candidateDigest: string; commit: string; replayed: boolean; tag: string }>> {
  const sealed = parseReleaseCandidateReceiptFile(options.path);
  const remoteBefore = await options.provider.readRemoteTag();
  if (remoteBefore !== null) {
    assertTagAuthority(remoteBefore, sealed, "exact");
    const replay = await verifyReleaseCandidateReceipt({
      expectedReleaseState: "any",
      expectedTag: "exact",
      path: options.path,
      provider: options.provider,
    });
    return {
      candidateDigest: replay.selfDigest,
      commit: replay.sourceCommit,
      replayed: true,
      tag: HRA_RELEASE_TAG,
    };
  }
  let receipt = await verifyReleaseCandidateReceipt({
    expectedReleaseState: "absent",
    expectedTag: "absent",
    path: options.path,
    provider: options.provider,
  });
  let local = await options.provider.readLocalTag();
  if (local === null) {
    // Revalidate every volatile authority immediately before the first local
    // mutation. Receipt creation and verification never call this method.
    receipt = await verifyReleaseCandidateReceipt({
      expectedReleaseState: "absent",
      expectedTag: "absent",
      path: options.path,
      provider: options.provider,
    });
    await options.provider.createLocalTag(receipt.sourceCommit, receipt.selfDigest);
    local = await options.provider.readLocalTag();
  }
  assertTagAuthority(local, receipt, "exact");
  // The exact annotated local tag is a recoverable intermediate state. Recheck
  // all remote/provider authority again before the irreversible protected push.
  receipt = await verifyReleaseCandidateReceipt({
    expectedReleaseState: "absent",
    expectedTag: "absent",
    path: options.path,
    provider: options.provider,
  });
  assertTagAuthority(await options.provider.readLocalTag(), receipt, "exact");
  await options.provider.pushTag();
  const remote = await options.provider.readRemoteTag();
  assertTagAuthority(remote, receipt, "exact");
  return {
    candidateDigest: receipt.selfDigest,
    commit: receipt.sourceCommit,
    replayed: false,
    tag: HRA_RELEASE_TAG,
  };
}

type ProcessResult = Readonly<{ exitCode: number; stderr: Buffer; stdout: Buffer }>;
type ProcessRequest = Readonly<{
  arguments: readonly string[];
  containment: BoundedProcessContainment;
  cwd: string;
  environment: Readonly<NodeJS.ProcessEnv>;
  executable: string;
  phase: string;
  terminationGraceMs?: number;
  timeoutMs?: number;
}>;
type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

export const runReleaseCandidateProcess: ProcessRunner = async (request) => {
  const result = requireBoundedProcessCleanup(await runBoundedProcess({
    arguments: request.arguments,
    containment: request.containment,
    cwd: request.cwd,
    environment: request.environment,
    executable: request.executable,
    outputMaximumBytes: commandMaximumBytes,
    phase: request.phase,
    terminationGraceMs: request.terminationGraceMs ?? commandTerminationGraceMs,
    timeoutMs: request.timeoutMs ?? commandTimeoutMs,
  }));
  return result;
};

const tagMessage = (digest: string): string => [
  `HRA ${HRA_RELEASE_TAG} sealed candidate`,
  "",
  `hra-release-candidate-sha256:${digest}`,
].join("\n");

const parseTagMessage = (message: string): string => {
  const match = /^HRA v0\.1\.0 sealed candidate\n\nhra-release-candidate-sha256:([0-9a-f]{64})$/u
    .exec(message);
  if (match?.[1] === undefined) throw new ReleaseCandidateError("tag_authority_invalid");
  return match[1];
};

export class SystemReleaseCandidateProvider implements ReleaseCandidateProvider {
  readonly #authorityFetch: typeof fetch;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #ghCli: string;
  readonly #guard: BoundedProcessInvocationGuard;
  readonly #root: string;
  readonly #runner: ProcessRunner;
  readonly #vercelCli: string;

  constructor(options: Readonly<{
    authorityFetch?: typeof fetch;
    authorityTimeoutMs?: number;
    environment?: Readonly<NodeJS.ProcessEnv>;
    ghCli: string;
    guard?: BoundedProcessInvocationGuard;
    repositoryRoot?: string;
    runner?: ProcessRunner;
    vercelCli: string;
  }>) {
    if (!isAbsolute(options.ghCli) || !isAbsolute(options.vercelCli)) {
      throw new ReleaseCandidateError("usage_invalid");
    }
    this.#ghCli = options.ghCli;
    this.#guard = options.guard ?? new BoundedProcessInvocationGuard();
    this.#vercelCli = options.vercelCli;
    this.#root = options.repositoryRoot ?? resolve(import.meta.dir, "..");
    const source = options.environment ?? process.env;
    this.#environment = {
      ...(source.HOME === undefined ? {} : { HOME: source.HOME }),
      ...(source.PATH === undefined ? {} : { PATH: source.PATH }),
      ...(source.GH_CONFIG_DIR === undefined ? {} : { GH_CONFIG_DIR: source.GH_CONFIG_DIR }),
      GH_PAGER: "cat",
      NO_COLOR: "1",
      TERM: "dumb",
    };
    const authorityTimeout = options.authorityTimeoutMs ?? convexAuthorityTimeoutMs;
    if (!Number.isSafeInteger(authorityTimeout) || authorityTimeout < 1 || authorityTimeout > 120_000) {
      throw new ReleaseCandidateError("usage_invalid");
    }
    this.#authorityFetch = createBoundedAuthorityFetch(
      options.authorityFetch ?? fetch,
      authorityTimeout,
      "convex_authority_timeout",
    );
    this.#runner = options.runner ?? runReleaseCandidateProcess;
  }

  async #run(
    containment: BoundedProcessContainment,
    executable: string,
    arguments_: readonly string[],
    phase: string,
  ): Promise<ProcessResult> {
    return await this.#guard.observe(async () => await this.#runner({
      arguments: arguments_,
      containment,
      cwd: this.#root,
      environment: this.#environment,
      executable,
      phase,
    }));
  }

  async #success(
    containment: BoundedProcessContainment,
    executable: string,
    arguments_: readonly string[],
    phase: string,
  ): Promise<Buffer> {
    const result = await this.#run(containment, executable, arguments_, phase);
    if (result.exitCode !== 0) throw new ReleaseCandidateError("provider_read_failed");
    return result.stdout;
  }

  async #ghJson(arguments_: readonly string[], phase: string): Promise<unknown> {
    const output = await this.#success("authority", this.#ghCli, [
      "api",
      "--hostname",
      "github.com",
      ...arguments_,
    ], phase);
    try {
      return JSON.parse(output.toString("utf8")) as unknown;
    } catch {
      throw new ReleaseCandidateError("provider_result_invalid");
    }
  }

  async verifyLocalSource(commit: string): Promise<void> {
    const [head, main, status, symbolic] = await settleConcurrentOperations([
      this.#run("local", "/usr/bin/git", ["rev-parse", "--verify", "HEAD^{commit}"], "git-head-read"),
      this.#run("local", "/usr/bin/git", ["rev-parse", "--verify", "origin/main^{commit}"], "git-main-read"),
      this.#run("local", "/usr/bin/git", ["status", "--porcelain=v1", "--untracked-files=all"], "git-status-read"),
      this.#run("local", "/usr/bin/git", ["symbolic-ref", "-q", "HEAD"], "git-symbolic-read"),
    ]);
    if (
      head.exitCode !== 0
      || main.exitCode !== 0
      || status.exitCode !== 0
      || head.stdout.toString("utf8") !== `${commit}\n`
      || main.stdout.toString("utf8") !== `${commit}\n`
      || status.stdout.byteLength !== 0
      || symbolic.exitCode === 0
    ) throw new ReleaseCandidateError("local_source_invalid");
  }

  async readCiJobs(commit: string): Promise<readonly CandidateCiJob[]> {
    const runs = z.object({
      workflow_runs: z.array(z.object({
        conclusion: z.literal("success"),
        event: z.literal("push"),
        head_sha: z.literal(commit),
        id: positiveIntegerSchema,
        name: z.literal("CI"),
        run_attempt: positiveIntegerSchema,
        status: z.literal("completed"),
      }).passthrough()).max(100),
    }).passthrough().parse(await this.#ghJson([
      `repos/${HRA_REPOSITORY}/actions/workflows/ci.yml/runs?head_sha=${commit}&event=push&per_page=100`,
    ], "github-ci-runs-read")).workflow_runs;
    if (runs.length !== 1) throw new ReleaseCandidateError("ci_authority_invalid");
    const run = runs[0];
    if (run === undefined) throw new ReleaseCandidateError("ci_authority_invalid");
    const jobs = z.object({
      jobs: z.array(z.object({
        completed_at: z.string().datetime({ offset: true }),
        conclusion: z.literal("success"),
        name: z.enum(["Check (macos-15)", "Check (ubuntu-24.04)", "Required"]),
        run_id: z.literal(run.id),
        status: z.literal("completed"),
      }).passthrough()).length(3),
    }).passthrough().parse(await this.#ghJson([
      `repos/${HRA_REPOSITORY}/actions/runs/${String(run.id)}/jobs?per_page=100`,
    ], "github-ci-jobs-read")).jobs;
    return jobs.map((job) => ({
      completedAt: job.completed_at,
      conclusion: job.conclusion,
      headCommit: commit,
      name: job.name,
      runAttempt: run.run_attempt,
      runId: run.id,
      workflow: "CI",
    }));
  }

  async #readRemoteTag(): Promise<CandidateTagAuthority | null> {
    const ref = await this.#run("authority", this.#ghCli, [
      "api",
      "--hostname",
      "github.com",
      `repos/${HRA_REPOSITORY}/git/ref/tags/${HRA_RELEASE_TAG}`,
    ], "github-tag-ref-read");
    if (ref.exitCode !== 0) {
      if (ref.stderr.toString("utf8").includes("HTTP 404")) return null;
      throw new ReleaseCandidateError("provider_read_failed");
    }
    let value: unknown;
    try {
      value = JSON.parse(ref.stdout.toString("utf8")) as unknown;
    } catch {
      throw new ReleaseCandidateError("provider_result_invalid");
    }
    const object = z.object({
      object: z.object({
        sha: z.string().regex(/^[0-9a-f]{40}$/u),
        type: z.literal("tag"),
      }).passthrough(),
      ref: z.literal(`refs/tags/${HRA_RELEASE_TAG}`),
    }).passthrough().parse(value).object;
    const tag = z.object({
      message: z.string().max(4_096),
      object: z.object({ sha: commitSchema, type: z.literal("commit") }).passthrough(),
      sha: z.literal(object.sha),
      tag: z.literal(HRA_RELEASE_TAG),
    }).passthrough().parse(await this.#ghJson([
      `repos/${HRA_REPOSITORY}/git/tags/${object.sha}`,
    ], "github-tag-object-read"));
    return { candidateDigest: parseTagMessage(tag.message), commit: tag.object.sha };
  }

  async readRemoteTag(): Promise<CandidateTagAuthority | null> {
    return await this.#readRemoteTag();
  }

  async readLocalTag(): Promise<CandidateTagAuthority | null> {
    const reference = await this.#run("local", "/usr/bin/git", [
      "show-ref",
      "--verify",
      "--hash",
      `refs/tags/${HRA_RELEASE_TAG}`,
    ], "git-local-tag-ref-read");
    if (reference.exitCode !== 0) {
      if (reference.stdout.byteLength === 0 && reference.stderr.byteLength === 0) return null;
      throw new ReleaseCandidateError("local_source_invalid");
    }
    const type = await this.#success("local",
      "/usr/bin/git",
      ["cat-file", "-t", `refs/tags/${HRA_RELEASE_TAG}`],
      "git-local-tag-type-read",
    );
    if (type.toString("utf8") !== "tag\n") throw new ReleaseCandidateError("tag_authority_invalid");
    const message = await this.#success("local", "/usr/bin/git", [
      "for-each-ref",
      "--format=%(contents)",
      `refs/tags/${HRA_RELEASE_TAG}`,
    ], "git-local-tag-message-read");
    const commit = await this.#success("local", "/usr/bin/git", [
      "rev-parse",
      `refs/tags/${HRA_RELEASE_TAG}^{commit}`,
    ], "git-local-tag-commit-read");
    return {
      candidateDigest: parseTagMessage(message.toString("utf8").trimEnd()),
      commit: commit.toString("utf8").trimEnd(),
    };
  }

  async readReleaseState(): Promise<CandidateReleaseState> {
    const result = await this.#run("authority", this.#ghCli, [
      "api",
      "--hostname",
      "github.com",
      `repos/${HRA_REPOSITORY}/releases/tags/${HRA_RELEASE_TAG}`,
    ], "github-release-read");
    if (result.exitCode !== 0) {
      if (result.stderr.toString("utf8").includes("HTTP 404")) return "absent";
      throw new ReleaseCandidateError("provider_read_failed");
    }
    let value: unknown;
    try {
      value = JSON.parse(result.stdout.toString("utf8")) as unknown;
    } catch {
      throw new ReleaseCandidateError("provider_result_invalid");
    }
    const release = z.object({
      draft: z.boolean(),
      tag_name: z.literal(HRA_RELEASE_TAG),
    }).passthrough().parse(value);
    return release.draft ? "draft" : "published";
  }

  async readRuntimeAttestation(deploymentUrl: string): Promise<RuntimeReleaseAttestation> {
    this.#guard.assertMayProceed();
    const client = new ConvexHttpClient(deploymentUrl, {
      fetch: this.#authorityFetch,
      logger: false,
    });
    const reference = makeFunctionReference<"query", Record<string, never>, unknown>(
      "releaseAttestation:read",
    );
    try {
      return runtimeReleaseAttestationSchema.parse(await client.query(reference, {}));
    } catch {
      throw new ReleaseCandidateError("convex_authority_invalid");
    }
  }

  async readSurfaceDigest(): Promise<string> {
    this.#guard.assertMayProceed();
    const content = await import("../site/content");
    const template = await import("../site/template");
    if (
      content.publicReleaseState !== "release-ready"
      || Object.values(content.publicContent.endpoints).some((value) => value !== "release-ready" && value !== "live")
      || content.publicContent.endpoints.betaTag !== "release-ready"
      || content.publicContent.endpoints.hostedSync !== "live"
      || content.publicContent.endpoints.website !== "live"
    ) throw new ReleaseCandidateError("surface_not_release_ready");
    return canonicalDigest({
      html: template.renderSiteHtml(),
      llms: content.renderLlmsText(),
      privacy: content.renderPrivacyMarkdown(),
      readme: content.renderReadmeMarkdown(),
    });
  }

  async readVercelAuthorityDigest(
    candidate: ReleaseCandidateReceipt["vercel"]["candidate"],
    fallback: ReleaseCandidateReceipt["vercel"]["fallback"],
  ): Promise<string> {
    const provider = new VercelCutoverProvider({
      environment: this.#environment,
      guard: this.#guard,
      vercelCli: this.#vercelCli,
    });
    return await authorityDigestForPlan(provider, candidateForwardPlan(candidate, fallback));
  }

  async createLocalTag(commit: string, candidateDigest: string): Promise<void> {
    if (!commitSchema.safeParse(commit).success || !digestSchema.safeParse(candidateDigest).success) {
      throw new ReleaseCandidateError("tag_authority_invalid");
    }
    await this.#success("local", "/usr/bin/git", [
      "tag",
      "--annotate",
      HRA_RELEASE_TAG,
      commit,
      "--message",
      tagMessage(candidateDigest),
    ], "git-local-tag-create");
  }

  async pushTag(): Promise<void> {
    await this.#success("authority", "/usr/bin/git", [
      "push",
      "origin",
      `refs/tags/${HRA_RELEASE_TAG}:refs/tags/${HRA_RELEASE_TAG}`,
    ], "git-tag-push");
  }
}

type CandidateArguments =
  | Readonly<{
      action: "create";
      evidence: CandidateEvidencePaths;
      ghCli: string;
      outputPath?: string;
      sourceCommit: string;
      vercel: CandidateVercelAuthority;
      vercelCli: string;
    }>
  | Readonly<{
      action: "tag" | "verify";
      candidateReceipt: string;
      ghCli: string;
      vercelCli: string;
    }>;

const takeOption = (values: string[], name: string): string => {
  const index = values.indexOf(name);
  const value = values[index + 1];
  if (index < 0 || value === undefined || value.startsWith("--")) {
    throw new ReleaseCandidateError("usage_invalid");
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

export const parseCandidateArguments = (arguments_: readonly string[]): CandidateArguments => {
  const values = [...arguments_];
  const action = values.shift();
  if (action !== "create" && action !== "verify" && action !== "tag") {
    throw new ReleaseCandidateError("usage_invalid");
  }
  const ghCli = takeOption(values, "--gh-cli");
  const vercelCli = takeOption(values, "--vercel-cli");
  if (!isAbsolute(ghCli) || !isAbsolute(vercelCli)) {
    throw new ReleaseCandidateError("usage_invalid");
  }
  if (action === "tag" || action === "verify") {
    const candidateReceipt = takeOption(values, "--candidate-receipt");
    const execute = takeFlag(values, "--execute");
    const acknowledged = takeFlag(values, "--acknowledge-immutable-tag");
    if (
      !isAbsolute(candidateReceipt)
      || values.length !== 0
      || (action === "tag" && (!execute || !acknowledged))
      || (action === "verify" && (execute || acknowledged))
    ) throw new ReleaseCandidateError("usage_invalid");
    return { action, candidateReceipt, ghCli, vercelCli };
  }
  const sourceCommit = takeOption(values, "--source-commit");
  const outputIndex = values.indexOf("--output");
  const outputPath = outputIndex < 0 ? undefined : takeOption(values, "--output");
  const evidence = {
    bootstrapDeploy: takeOption(values, "--bootstrap-deploy-evidence"),
    bootstrapLive: takeOption(values, "--bootstrap-live-evidence"),
    candidateDeploy: takeOption(values, "--candidate-deploy-evidence"),
    candidateLive: takeOption(values, "--candidate-live-evidence"),
    finalForwardCutover: takeOption(values, "--final-forward-cutover-evidence"),
    forwardCutover: takeOption(values, "--forward-cutover-evidence"),
    reverseCutover: takeOption(values, "--reverse-cutover-evidence"),
  };
  const candidate = {
    deploymentId: takeOption(values, "--deployment-id"),
    deploymentUrl: takeOption(values, "--deployment-url"),
    projectId: newProjectId,
    repositoryId: HRA_REPOSITORY_ID,
    sourceCommit,
    version: HRA_RELEASE_VERSION,
  };
  const fallback = {
    deploymentId: takeOption(values, "--fallback-deployment-id"),
    deploymentUrl: takeOption(values, "--fallback-deployment-url"),
    projectId: oldProjectId,
    repositoryId: oldRepositoryId,
    sourceCommit: takeOption(values, "--fallback-source-commit"),
    version: takeOption(values, "--fallback-version"),
  };
  const parsedCandidate = vercelEndpointEvidenceSchema.parse(candidate);
  const parsedFallback = vercelEndpointEvidenceSchema.parse(fallback);
  if (
    !commitSchema.safeParse(sourceCommit).success
    || values.length !== 0
    || outputPath !== undefined && !isAbsolute(outputPath)
    || Object.values(evidence).some((path) => !isAbsolute(path))
  ) throw new ReleaseCandidateError("usage_invalid");
  return {
    action,
    evidence,
    ghCli,
    ...(outputPath === undefined ? {} : { outputPath }),
    sourceCommit,
    vercel: { candidate: parsedCandidate, fallback: parsedFallback },
    vercelCli,
  };
};

export const renderReleaseCandidateFailure = (
  error: unknown,
  stderr: Pick<NodeJS.WriteStream, "write">,
): number => {
  const authorityUnavailable = renderAuthorityContainmentUnavailable(error);
  if (authorityUnavailable !== undefined) {
    stderr.write(authorityUnavailable);
    return 1;
  }
  const cleanup = isBoundedProcessCleanupUnprovenError(error) ? error : undefined;
  const journal = isBoundedProcessRecoveryJournalError(error) ? error : undefined;
  const code = cleanup !== undefined
    ? "process_cleanup_unproven"
    : journal !== undefined ? "process_recovery_journal_blocked"
    : error instanceof ReleaseCandidateError ? error.code : "candidate_refused";
  stderr.write(`${JSON.stringify({
    code,
    ...(cleanup === undefined ? {} : {
      phase: cleanup.phase,
      processGroupId: cleanup.processGroupId,
      processes: cleanup.processes,
      recoveryPaths: cleanup.recoveryPaths,
    }),
    ...(journal === undefined ? {} : {
      reason: journal.reason,
      recoveryPaths: journal.recoveryPaths,
    }),
    schemaVersion: 1,
    status: cleanup === undefined && journal === undefined ? "refused" : "recovery_required",
  })}\n`);
  return cleanup === undefined && journal === undefined ? 1 : 75;
};

if (import.meta.main) {
  let exitCode = 75;
  try {
    const arguments_ = parseCandidateArguments(process.argv.slice(2));
    try {
      await recoverBoundedProcessJournal();
    } catch (error: unknown) {
      if (
        (isBoundedProcessCleanupUnprovenError(error)
          || isBoundedProcessRecoveryJournalError(error))
        && (arguments_.action === "tag" || arguments_.action === "verify")
      ) throw retainBoundedProcessRecoveryPath(error, arguments_.candidateReceipt);
      throw error;
    }
    const guard = new BoundedProcessInvocationGuard();
    if (arguments_.action === "create") {
      if (arguments_.outputPath !== undefined) {
        try {
          parseReleaseCandidateReceiptFile(arguments_.outputPath);
          guard.retainRecoveryPath(arguments_.outputPath);
        } catch {
          // A nonexistent output has no child-reachable state to preserve. The
          // normal create path still validates any malformed existing receipt.
        }
      }
    } else {
      guard.retainRecoveryPath(arguments_.candidateReceipt);
    }
    const provider = new SystemReleaseCandidateProvider({
      ghCli: arguments_.ghCli,
      guard,
      vercelCli: arguments_.vercelCli,
    });
    const result = arguments_.action === "create"
      ? await createReleaseCandidateReceipt({
          evidence: arguments_.evidence,
          ...(arguments_.outputPath === undefined ? {} : { outputPath: arguments_.outputPath }),
          provider,
          sourceCommit: arguments_.sourceCommit,
          vercel: arguments_.vercel,
        }).then(({ path, receipt, replayed }) => ({
          candidateDigest: receipt.selfDigest,
          commit: receipt.sourceCommit,
          path,
          replayed,
          status: "sealed",
          tag: receipt.tag,
        }))
      : arguments_.action === "verify"
        ? await verifyReleaseCandidateReceipt({
            expectedReleaseState: "absent",
            expectedTag: "absent",
            path: arguments_.candidateReceipt,
            provider,
          }).then((receipt) => ({
            candidateDigest: receipt.selfDigest,
            commit: receipt.sourceCommit,
            status: "verified",
            tag: receipt.tag,
          }))
        : await tagReleaseCandidate({
            path: arguments_.candidateReceipt,
            provider,
          }).then((value) => ({ ...value, status: "tagged" }));
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...result })}\n`);
    exitCode = 0;
  } catch (error: unknown) {
    exitCode = renderReleaseCandidateFailure(error, process.stderr);
  }
  process.exitCode = exitCode;
}

export { authorityDigestForPlan };
