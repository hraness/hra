import { expect, test } from "bun:test";

import { isCodexRuntimeProfile, isDevinRuntimeProfile, reviewedRuntimeProfileProvider, reviewedRuntimeProfileSchema } from "./runtime-profile";

test("a Devin Astra profile is admitted only as Devin, never as a Codex fast-mode profile", () => {
  const profile = reviewedRuntimeProfileSchema.parse({
    profileId: `acct_${"1".repeat(32)}`,
    processGeneration: 3,
    observedAt: 1_000,
    preset: "astra",
    model: "gpt-6-astra",
    reasoningEffort: "provider-default",
    devinVersion: "3000.6.14",
    protocolVersion: 1,
    isolatedHome: true,
  });
  expect(reviewedRuntimeProfileProvider(profile)).toBe("devin");
  expect(isDevinRuntimeProfile(profile)).toBe(true);
  expect(isCodexRuntimeProfile(profile)).toBe(false);
  expect(reviewedRuntimeProfileSchema.safeParse({ ...profile, fast: true }).success).toBe(false);
  expect(reviewedRuntimeProfileSchema.safeParse({ ...profile, preset: "ultra" }).success).toBe(false);
});
