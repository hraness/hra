import { describe, expect, test } from "bun:test";
import type { RunnerPresenceView } from "@hraness/agent-tasks-protocol";

import { runnerReadinessSemanticFingerprint } from "./dispatch";

const REPOSITORIES = ["repository_bravo", "repository_alpha"] as const;

function fingerprint(
  presence: RunnerPresenceView,
  repositoryIds: readonly string[] = REPOSITORIES,
): string {
  return runnerReadinessSemanticFingerprint(presence, repositoryIds);
}

describe("runner readiness projection head", () => {
  test.each([
    [
      "offline",
      { state: "offline", serverTime: 1_000 },
      { state: "offline", serverTime: 9_000 },
    ],
    [
      "busy",
      { state: "busy", serverTime: 1_000, leaseUntil: 2_000 },
      { state: "busy", serverTime: 9_000, leaseUntil: 99_000 },
    ],
    [
      "draining",
      { state: "draining", serverTime: 1_000, leaseUntil: 2_000 },
      { state: "draining", serverTime: 9_000, leaseUntil: 99_000 },
    ],
    [
      "blocked",
      {
        state: "blocked",
        serverTime: 1_000,
        leaseUntil: 2_000,
        reason: "capacity_full",
      },
      {
        state: "blocked",
        serverTime: 9_000,
        leaseUntil: 99_000,
        reason: "capacity_full",
      },
    ],
    [
      "ready",
      {
        state: "ready",
        serverTime: 1_000,
        leaseUntil: 2_000,
        availableCapacity: 2,
      },
      {
        state: "ready",
        serverTime: 9_000,
        leaseUntil: 99_000,
        availableCapacity: 2,
      },
    ],
  ] as const)("ignores lease-only and clock-only churn for %s", (
    _state,
    before,
    after,
  ) => {
    expect(fingerprint(before)).toBe(fingerprint(after));
  });

  test("canonicalizes repository capability order and duplicates", () => {
    const presence = {
      state: "ready",
      serverTime: 1_000,
      leaseUntil: 2_000,
      availableCapacity: 2,
    } as const;

    expect(fingerprint(presence, ["repository_alpha", "repository_bravo"]))
      .toBe(fingerprint(presence, [
        "repository_bravo",
        "repository_alpha",
        "repository_bravo",
      ]));
  });

  test.each([
    [
      "presence state",
      { state: "offline", serverTime: 1_000 },
      { state: "busy", serverTime: 1_000, leaseUntil: 2_000 },
      REPOSITORIES,
      REPOSITORIES,
    ],
    [
      "blocked reason",
      {
        state: "blocked",
        serverTime: 1_000,
        leaseUntil: 2_000,
        reason: "capacity_full",
      },
      {
        state: "blocked",
        serverTime: 1_000,
        leaseUntil: 2_000,
        reason: "no_repository",
      },
      REPOSITORIES,
      REPOSITORIES,
    ],
    [
      "available capacity",
      {
        state: "ready",
        serverTime: 1_000,
        leaseUntil: 2_000,
        availableCapacity: 2,
      },
      {
        state: "ready",
        serverTime: 1_000,
        leaseUntil: 2_000,
        availableCapacity: 1,
      },
      REPOSITORIES,
      REPOSITORIES,
    ],
    [
      "repository capability set",
      {
        state: "ready",
        serverTime: 1_000,
        leaseUntil: 2_000,
        availableCapacity: 2,
      },
      {
        state: "ready",
        serverTime: 1_000,
        leaseUntil: 2_000,
        availableCapacity: 2,
      },
      ["repository_alpha"],
      ["repository_alpha", "repository_bravo"],
    ],
  ] as const)("changes when the human-visible %s changes", (
    _name,
    before,
    after,
    beforeRepositories,
    afterRepositories,
  ) => {
    expect(fingerprint(before, beforeRepositories))
      .not.toBe(fingerprint(after, afterRepositories));
  });
});
