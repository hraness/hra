import { describe, expect, test } from "bun:test";

import {
  admitCommitCiRequiredJob,
  admitCommitCiRun,
  ciRequiredJobName,
  ciWorkflowPath,
  CommitCiRunError,
  commitCiRunErrorCodes,
} from "./check-commit-ci-run";

const sha = "b787e4d767d9bc95a70952e1002c150f5f33661c";
const otherSha = "0e9287bc2ead3af2d432375efb86247455c2223d";
const identity = { defaultBranch: "main", repository: "hraness/hra", sha } as const;

function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conclusion: "success",
    display_title: "docs: release",
    event: "push",
    head_branch: "main",
    head_repository: { full_name: "hraness/hra" },
    head_sha: sha,
    id: 33562319207,
    name: "CI",
    path: ciWorkflowPath,
    repository: { full_name: "hraness/hra" },
    run_attempt: 1,
    status: "completed",
    ...overrides,
  };
}

function runs(...items: Record<string, unknown>[]): Record<string, unknown> {
  return { total_count: items.length, workflow_runs: items };
}

function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conclusion: "success",
    head_sha: sha,
    id: 100039504965,
    name: ciRequiredJobName,
    run_attempt: 1,
    run_id: 33562319207,
    status: "completed",
    steps: [],
    ...overrides,
  };
}

function jobs(...items: Record<string, unknown>[]): Record<string, unknown> {
  return { jobs: items, total_count: items.length };
}

const admittedRun = Object.freeze({ runAttempt: 1, runId: 33562319207 });

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof CommitCiRunError) return error.code;
    throw error;
  }
  throw new Error("expected a CommitCiRunError");
}

describe("release CI run readback", () => {
  test("admits exactly one completed successful push run on the exact commit", () => {
    expect(admitCommitCiRun(runs(run()), identity)).toEqual(admittedRun);
    expect(admitCommitCiRun(runs(
      run({ head_sha: otherSha, id: 1 }),
      run({ event: "pull_request", head_branch: "feature", id: 2 }),
      run(),
    ), identity)).toEqual(admittedRun);
    expect(admitCommitCiRun(runs(run({ run_attempt: 3 })), identity))
      .toEqual({ runAttempt: 3, runId: 33562319207 });
  });

  test("refuses a commit CI never checked on the default branch", () => {
    expect(code(() => admitCommitCiRun(runs(), identity))).toBe("ci_run_missing");
    expect(code(() => admitCommitCiRun(runs(run({ head_sha: otherSha })), identity)))
      .toBe("ci_run_missing");
    expect(code(() => admitCommitCiRun(runs(run({ event: "pull_request" })), identity)))
      .toBe("ci_run_missing");
    expect(code(() => admitCommitCiRun(runs(run({ head_branch: "release" })), identity)))
      .toBe("ci_run_missing");
    expect(code(() => admitCommitCiRun(runs(run({ head_branch: null })), identity)))
      .toBe("ci_run_missing");
    expect(code(() => admitCommitCiRun(runs(run({ path: ".github/workflows/release.yml" })), identity)))
      .toBe("ci_run_missing");
    expect(code(() => admitCommitCiRun(runs(run({ repository: { full_name: "fork/hra" } })), identity)))
      .toBe("ci_run_missing");
    expect(code(() => admitCommitCiRun(runs(run({ head_repository: null })), identity)))
      .toBe("ci_run_missing");
  });

  test("refuses incomplete, failed, cancelled, and ambiguous runs", () => {
    expect(code(() => admitCommitCiRun(runs(run({ conclusion: null, status: "in_progress" })), identity)))
      .toBe("ci_run_incomplete");
    expect(code(() => admitCommitCiRun(runs(run({ conclusion: null, status: "queued" })), identity)))
      .toBe("ci_run_incomplete");
    for (const conclusion of ["failure", "cancelled", "timed_out", "skipped", "neutral", "action_required"]) {
      expect(code(() => admitCommitCiRun(runs(run({ conclusion })), identity)))
        .toBe("ci_run_not_successful");
    }
    expect(code(() => admitCommitCiRun(runs(run({ conclusion: null })), identity)))
      .toBe("ci_run_not_successful");
    expect(code(() => admitCommitCiRun(runs(run(), run({ id: 2 })), identity)))
      .toBe("ci_run_ambiguous");
  });

  test("refuses malformed or truncated run inventories instead of guessing", () => {
    expect(code(() => admitCommitCiRun(null, identity))).toBe("ci_run_inventory_malformed");
    expect(code(() => admitCommitCiRun([run()], identity))).toBe("ci_run_inventory_malformed");
    expect(code(() => admitCommitCiRun({ workflow_runs: [run()] }, identity)))
      .toBe("ci_run_inventory_malformed");
    expect(code(() => admitCommitCiRun(runs(run({ id: "33562319207" })), identity)))
      .toBe("ci_run_inventory_malformed");
    expect(code(() => admitCommitCiRun(runs(run({ head_sha: sha.toUpperCase() })), identity)))
      .toBe("ci_run_inventory_malformed");
    expect(code(() => admitCommitCiRun(runs(run({ run_attempt: 0 })), identity)))
      .toBe("ci_run_inventory_malformed");
    expect(code(() => admitCommitCiRun({ total_count: 2, workflow_runs: [run()] }, identity)))
      .toBe("ci_run_inventory_truncated");
    expect(code(() => admitCommitCiRun(
      { total_count: 101, workflow_runs: Array.from({ length: 101 }, (_, index) => run({ id: index + 1 })) },
      identity,
    ))).toBe("ci_run_inventory_malformed");
  });

  test("admits only the Required job of the same run attempt on the exact commit", () => {
    expect(admitCommitCiRequiredJob(jobs(job()), admittedRun, identity))
      .toEqual({ jobId: 100039504965, runId: 33562319207 });
    expect(admitCommitCiRequiredJob(jobs(
      job({ id: 1, name: "Check (macos-15)" }),
      job({ id: 2, name: "Check (ubuntu-24.04)" }),
      job(),
    ), admittedRun, identity)).toEqual({ jobId: 100039504965, runId: 33562319207 });
    expect(code(() => admitCommitCiRequiredJob(jobs(), admittedRun, identity)))
      .toBe("ci_required_job_missing");
    expect(code(() => admitCommitCiRequiredJob(jobs(job({ name: "required" })), admittedRun, identity)))
      .toBe("ci_required_job_missing");
    expect(code(() => admitCommitCiRequiredJob(jobs(job({ head_sha: otherSha })), admittedRun, identity)))
      .toBe("ci_required_job_missing");
    expect(code(() => admitCommitCiRequiredJob(jobs(job({ run_id: 7 })), admittedRun, identity)))
      .toBe("ci_required_job_missing");
    expect(code(() => admitCommitCiRequiredJob(jobs(job({ run_attempt: 2 })), admittedRun, identity)))
      .toBe("ci_required_job_missing");
    expect(code(() => admitCommitCiRequiredJob(jobs(job(), job({ id: 3 })), admittedRun, identity)))
      .toBe("ci_required_job_ambiguous");
    expect(code(() => admitCommitCiRequiredJob(
      jobs(job({ conclusion: null, status: "in_progress" })),
      admittedRun,
      identity,
    ))).toBe("ci_required_job_incomplete");
    expect(code(() => admitCommitCiRequiredJob(jobs(job({ conclusion: "failure" })), admittedRun, identity)))
      .toBe("ci_required_job_not_successful");
    expect(code(() => admitCommitCiRequiredJob(jobs(job({ conclusion: "skipped" })), admittedRun, identity)))
      .toBe("ci_required_job_not_successful");
    expect(code(() => admitCommitCiRequiredJob({ jobs: [job()] }, admittedRun, identity)))
      .toBe("ci_job_inventory_malformed");
    expect(code(() => admitCommitCiRequiredJob({ jobs: [job()], total_count: 4 }, admittedRun, identity)))
      .toBe("ci_job_inventory_truncated");
  });

  test("rejects an invalid release identity before reading any inventory", () => {
    expect(() => admitCommitCiRun(runs(run()), { ...identity, sha: sha.toUpperCase() }))
      .toThrow("lowercase commit SHA");
    expect(() => admitCommitCiRun(runs(run()), { ...identity, defaultBranch: "main branch" }))
      .toThrow("default branch");
    expect(() => admitCommitCiRun(runs(run()), { ...identity, repository: "fork/hra" }))
      .toThrow("hraness/hra");
    expect(() => admitCommitCiRequiredJob(jobs(job()), admittedRun, { ...identity, repository: "fork/hra" }))
      .toThrow("hraness/hra");
  });

  test("names every refusal with one closed error code", () => {
    expect(new Set(commitCiRunErrorCodes).size).toBe(commitCiRunErrorCodes.length);
    const error = new CommitCiRunError("ci_run_missing");
    expect(error.name).toBe("CommitCiRunError");
    expect(error.message).toBe("CI run readback refused the release commit: ci_run_missing");
  });
});
