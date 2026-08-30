import { describe, expect, test } from "bun:test";

import { decideNpmPublicationTransition } from "./npm-publication-transition";

const base = {
  currentArtifactState: "absent",
  currentRunAttempt: "1",
  currentRunId: "123",
  preflightArtifactState: "absent",
  preflightRunAttempt: "1",
  preflightRunId: "123",
} as const;

describe("npm publication retry transition", () => {
  test("requires current-attempt provenance when a same-attempt preflight was absent", () => {
    expect(decideNpmPublicationTransition(base)).toEqual({
      action: "publish",
      attemptPolicy: "exact",
    });
    expect(decideNpmPublicationTransition({
      ...base,
      currentArtifactState: "exact",
    })).toEqual({
      action: "admit_existing",
      attemptPolicy: "exact",
    });
  });

  test("completes after publish succeeded but admission failed on the prior attempt", () => {
    expect(decideNpmPublicationTransition({
      ...base,
      currentArtifactState: "exact",
      currentRunAttempt: "2",
    })).toEqual({
      action: "admit_existing",
      attemptPolicy: "same_run_not_later",
    });
  });

  test("completes when publication became visible despite the prior publisher job failing", () => {
    expect(decideNpmPublicationTransition({
      ...base,
      currentArtifactState: "exact",
      currentRunAttempt: "3",
      preflightRunAttempt: "2",
    })).toEqual({
      action: "admit_existing",
      attemptPolicy: "same_run_not_later",
    });
  });

  test("rejects another run, a future preflight, and disappearance after exact preflight", () => {
    expect(() => decideNpmPublicationTransition({
      ...base,
      currentRunId: "124",
    })).toThrow("this workflow run");
    expect(() => decideNpmPublicationTransition({
      ...base,
      currentRunAttempt: "1",
      preflightRunAttempt: "2",
    })).toThrow("this workflow run");
    expect(() => decideNpmPublicationTransition({
      ...base,
      preflightArtifactState: "exact",
    })).toThrow("disappeared");
  });
});
