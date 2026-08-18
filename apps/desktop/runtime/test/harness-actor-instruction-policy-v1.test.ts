import { describe, expect, test } from "bun:test";

import {
  persistentActorDelegationPolicy,
  persistentActorInstructions,
  parsePersistentActorInstructionPolicy,
} from "../src/harness/actor-instruction-policy-v1";

describe("malleable persistent actor instruction policy", () => {
  test("gives every work class an exact bounded delegation posture", () => {
    expect(persistentActorDelegationPolicy("boundedLeaf"))
      .toContain("do not dispatch another actor");
    expect(persistentActorDelegationPolicy("standard"))
      .toContain("bounded, independent leaves");
    expect(persistentActorDelegationPolicy("largeChange"))
      .toContain("implementation or review lanes");
    expect(persistentActorDelegationPolicy("wideResearch"))
      .toContain("reconcile their evidence");
  });

  test("binds the selected profile without embedding actor identity", () => {
    const instructions = persistentActorInstructions("standard", "solMax");
    expect(instructions).toContain("Durable work class: standard.");
    expect(instructions).toContain("gpt-5.6-sol with max reasoning");
    expect(instructions).toContain("oprte/rlm_run");
    expect(instructions).toContain("routing.inspect {}");
    expect(instructions).toContain("recursive actor outcomes only");
    expect(instructions).toContain("excludes ordinary root-turn spend");
    expect(instructions).toContain("requestedProfile is routing intent");
    expect(instructions).toContain("observed provider compliance");
    expect(instructions).toContain("descriptive and shadow-only");
    expect(instructions).toContain("operational completion is not quality");
    expect(instructions).toContain("misclassify work");
    expect(instructions).toContain("override user intent");
    expect(instructions).not.toContain("hactor_");
  });

  test("rejects executable-shaped, widened, and unbounded policy data", () => {
    expect(() => parsePersistentActorInstructionPolicy({})).toThrow();
    expect(() => parsePersistentActorInstructionPolicy({
      version: 1,
      opening: "ok",
      delegation: {
        boundedLeaf: "ok",
        standard: "ok",
        largeChange: "ok",
        wideResearch: "ok",
      },
      toolBoundary: "ok",
      schemaBoundary: "ok",
      handleGuidance: "ok",
      routingGuidance: "ok",
      completionGuidance: "ok",
      execute: "fetch('https://example.com')",
    })).toThrow();
  });
});
