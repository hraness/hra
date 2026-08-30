import { describe, expect, test } from "bun:test";

import { assertNpmProvenanceBuildIdentity } from "./verify-npm-provenance";

const sha = "a".repeat(40);
const tag = "v0.1.0";

function predicate(
  runId = "123",
  runAttempt = "2",
  options: Readonly<{ commit?: string; invocationSuffix?: string }> = {},
): unknown {
  return {
    buildDefinition: {
      buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
      externalParameters: {
        workflow: {
          path: ".github/workflows/release.yml",
          ref: `refs/tags/${tag}`,
          repository: "https://github.com/hraness/hra",
        },
      },
      resolvedDependencies: [{
        digest: { gitCommit: options.commit ?? sha },
        uri: `git+https://github.com/hraness/hra@refs/tags/${tag}`,
      }],
    },
    runDetails: {
      builder: { id: "https://github.com/actions/runner/github-hosted" },
      metadata: {
        invocationId:
          `https://github.com/hraness/hra/actions/runs/${runId}/attempts/${runAttempt}${options.invocationSuffix ?? ""}`,
      },
    },
  };
}

const identity = {
  runAttempt: "2",
  runId: "123",
  sha,
  tag,
} as const;

describe("npm provenance workflow attempt admission", () => {
  test("requires the current attempt for a first publication", () => {
    expect(assertNpmProvenanceBuildIdentity(predicate(), {
      ...identity,
      attemptPolicy: "exact",
    })).toBe("2");
    expect(() => assertNpmProvenanceBuildIdentity(predicate("123", "1"), {
      ...identity,
      attemptPolicy: "exact",
    })).toThrow("inadmissible workflow attempt");
  });

  test("admits an earlier positive attempt only within the same workflow run", () => {
    expect(assertNpmProvenanceBuildIdentity(predicate("123", "1"), {
      ...identity,
      attemptPolicy: "same_run_not_later",
    })).toBe("1");
    expect(() => assertNpmProvenanceBuildIdentity(predicate("123", "3"), {
      ...identity,
      attemptPolicy: "same_run_not_later",
    })).toThrow("inadmissible workflow attempt");
    expect(() => assertNpmProvenanceBuildIdentity(predicate("3123", "2"), {
      ...identity,
      attemptPolicy: "same_run_not_later",
    })).toThrow("workflow-run identity");
  });

  test("keeps the release workflow, ref, commit, and invocation coordinates exact", () => {
    expect(() => assertNpmProvenanceBuildIdentity(predicate("123", "2", {
      commit: "b".repeat(40),
    }), {
      ...identity,
      attemptPolicy: "same_run_not_later",
    })).toThrow("exact release ref and commit");

    expect(() => assertNpmProvenanceBuildIdentity(predicate("123", "2", {
      invocationSuffix: "/jobs/7",
    }), {
      ...identity,
      attemptPolicy: "same_run_not_later",
    })).toThrow("workflow-run identity");
  });
});
