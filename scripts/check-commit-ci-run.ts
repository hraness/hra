import { z } from "zod";

import { readBoundedJsonResponse } from "./bounded-json-response";
import { publicRepository } from "./release-distribution-policy";

// Release readback: the tagged commit must already carry one successful CI
// run on the default branch. The workflow admits packaging only after this
// module proves that run and its Required job on the exact commit.

const SHA = /^[0-9a-f]{40}$/u;
const GITHUB_BRANCH = /^[A-Za-z0-9._/-]+$/u;
const MAXIMUM_INVENTORY_PAGE = 100;
const MAXIMUM_JSON_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;

export const ciWorkflowPath = ".github/workflows/ci.yml";
export const ciRequiredJobName = "Required";

export const commitCiRunErrorCodes = [
  "ci_run_inventory_malformed",
  "ci_run_inventory_truncated",
  "ci_run_missing",
  "ci_run_ambiguous",
  "ci_run_incomplete",
  "ci_run_not_successful",
  "ci_job_inventory_malformed",
  "ci_job_inventory_truncated",
  "ci_required_job_missing",
  "ci_required_job_ambiguous",
  "ci_required_job_incomplete",
  "ci_required_job_not_successful",
] as const;

export type CommitCiRunErrorCode = (typeof commitCiRunErrorCodes)[number];

export class CommitCiRunError extends Error {
  readonly code: CommitCiRunErrorCode;

  constructor(code: CommitCiRunErrorCode) {
    super(`CI run readback refused the release commit: ${code}`);
    this.name = "CommitCiRunError";
    this.code = code;
  }
}

const positiveInteger = z.number().int().positive();
const nullableText = z.string().max(256).nullable();

const workflowRunSchema = z.object({
  conclusion: nullableText,
  event: z.string().max(64),
  head_branch: nullableText,
  head_repository: z.object({ full_name: z.string().max(256) }).nullable(),
  head_sha: z.string().regex(SHA),
  id: positiveInteger,
  path: z.string().max(256),
  repository: z.object({ full_name: z.string().max(256) }),
  run_attempt: positiveInteger,
  status: nullableText,
});

const workflowRunInventorySchema = z.object({
  total_count: z.number().int().nonnegative(),
  workflow_runs: z.array(workflowRunSchema).max(MAXIMUM_INVENTORY_PAGE),
});

const workflowJobSchema = z.object({
  conclusion: nullableText,
  head_sha: z.string().regex(SHA),
  id: positiveInteger,
  name: z.string().max(256),
  run_attempt: positiveInteger,
  run_id: positiveInteger,
  status: nullableText,
});

const workflowJobInventorySchema = z.object({
  jobs: z.array(workflowJobSchema).max(MAXIMUM_INVENTORY_PAGE),
  total_count: z.number().int().nonnegative(),
});

export type CommitCiRunIdentity = Readonly<{
  defaultBranch: string;
  repository: string;
  sha: string;
}>;

export type AdmittedCiRun = Readonly<{ runAttempt: number; runId: number }>;
export type AdmittedCiJob = Readonly<{ jobId: number; runId: number }>;

function identity(input: CommitCiRunIdentity): CommitCiRunIdentity {
  if (!SHA.test(input.sha)) throw new Error("CI run readback requires one lowercase commit SHA.");
  if (!GITHUB_BRANCH.test(input.defaultBranch)) {
    throw new Error("CI run readback requires a valid default branch name.");
  }
  if (input.repository !== publicRepository) {
    throw new Error(`CI run readback must address ${publicRepository}.`);
  }
  return input;
}

export function admitCommitCiRun(value: unknown, input: CommitCiRunIdentity): AdmittedCiRun {
  const expected = identity(input);
  const parsed = workflowRunInventorySchema.safeParse(value);
  if (!parsed.success) throw new CommitCiRunError("ci_run_inventory_malformed");
  const inventory = parsed.data;
  if (inventory.total_count !== inventory.workflow_runs.length) {
    throw new CommitCiRunError("ci_run_inventory_truncated");
  }
  const candidates = inventory.workflow_runs.filter((run) =>
    run.head_sha === expected.sha
    && run.event === "push"
    && run.head_branch === expected.defaultBranch
    && run.path === ciWorkflowPath
    && run.repository.full_name === expected.repository
    && run.head_repository?.full_name === expected.repository);
  if (candidates.length === 0) throw new CommitCiRunError("ci_run_missing");
  if (candidates.length > 1) throw new CommitCiRunError("ci_run_ambiguous");
  const [run] = candidates;
  if (run === undefined) throw new CommitCiRunError("ci_run_missing");
  if (run.status !== "completed") throw new CommitCiRunError("ci_run_incomplete");
  if (run.conclusion !== "success") throw new CommitCiRunError("ci_run_not_successful");
  return Object.freeze({ runAttempt: run.run_attempt, runId: run.id });
}

export function admitCommitCiRequiredJob(
  value: unknown,
  run: AdmittedCiRun,
  input: CommitCiRunIdentity,
): AdmittedCiJob {
  const expected = identity(input);
  const parsed = workflowJobInventorySchema.safeParse(value);
  if (!parsed.success) throw new CommitCiRunError("ci_job_inventory_malformed");
  const inventory = parsed.data;
  if (inventory.total_count !== inventory.jobs.length) {
    throw new CommitCiRunError("ci_job_inventory_truncated");
  }
  const candidates = inventory.jobs.filter((job) =>
    job.name === ciRequiredJobName
    && job.run_id === run.runId
    && job.run_attempt === run.runAttempt
    && job.head_sha === expected.sha);
  if (candidates.length === 0) throw new CommitCiRunError("ci_required_job_missing");
  if (candidates.length > 1) throw new CommitCiRunError("ci_required_job_ambiguous");
  const [job] = candidates;
  if (job === undefined) throw new CommitCiRunError("ci_required_job_missing");
  if (job.status !== "completed") throw new CommitCiRunError("ci_required_job_incomplete");
  if (job.conclusion !== "success") throw new CommitCiRunError("ci_required_job_not_successful");
  return Object.freeze({ jobId: job.id, runId: run.runId });
}

function environment(name: string, pattern?: RegExp): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0 || (pattern !== undefined && !pattern.test(value))) {
    throw new Error(`CI run readback requires a valid ${name}.`);
  }
  return value;
}

async function githubJson(url: string, label: string, token: string): Promise<unknown> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Cache-Control": "no-cache",
      "User-Agent": "hra-release-ci-readback",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status !== 200) throw new Error(`${label} returned HTTP ${String(response.status)}.`);
  return readBoundedJsonResponse(response, label, MAXIMUM_JSON_BYTES);
}

if (import.meta.main) {
  const repository = environment("GITHUB_REPOSITORY");
  const token = environment("GITHUB_TOKEN");
  const input = identity({
    defaultBranch: environment("DEFAULT_BRANCH", GITHUB_BRANCH),
    repository,
    sha: environment("VERIFIED_SHA", SHA),
  });
  const api = `https://api.github.com/repos/${publicRepository}`;
  const runQuery = new URLSearchParams({
    branch: input.defaultBranch,
    event: "push",
    head_sha: input.sha,
    per_page: String(MAXIMUM_INVENTORY_PAGE),
  });
  const run = admitCommitCiRun(
    await githubJson(`${api}/actions/workflows/ci.yml/runs?${runQuery.toString()}`, "CI run inventory", token),
    input,
  );
  const jobQuery = new URLSearchParams({ filter: "latest", per_page: String(MAXIMUM_INVENTORY_PAGE) });
  const job = admitCommitCiRequiredJob(
    await githubJson(`${api}/actions/runs/${String(run.runId)}/jobs?${jobQuery.toString()}`, "CI job inventory", token),
    run,
    input,
  );
  console.log(`ci_run=${String(job.runId)} ci_run_attempt=${String(run.runAttempt)} ci_required_job=${String(job.jobId)}`);
}
