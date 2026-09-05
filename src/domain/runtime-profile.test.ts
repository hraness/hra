import { describe, expect, test } from "bun:test";

import {
  effectiveClaudeRuntimeProfileSchema,
  projectPublicReviewedRuntimeProfile,
} from "./runtime-profile";

const shared = {
  claudeVersion: "2.1.260",
  inputFormat: "stream-json" as const,
  model: "claude-fable-5-1",
  observedAt: 1_700_000_000_000,
  outputFormat: "stream-json" as const,
  permissionMode: "default" as const,
  preset: "fable-max" as const,
  processGeneration: 3,
  profileId: "acct_00000000000000000000000000000000",
  reasoningEffort: "max" as const,
};

describe("Claude runtime profile", () => {
  test("records the reviewed config home without an adoption-specific tier", () => {
    expect(effectiveClaudeRuntimeProfileSchema.parse({
      ...shared,
      configHome: "isolated",
    })).toEqual({ ...shared, configHome: "isolated" });
    expect(effectiveClaudeRuntimeProfileSchema.parse({
      ...shared,
      configHome: "personal",
    })).toEqual({ ...shared, configHome: "personal" });
  });

  test("parses legacy isolated evidence byte-for-byte without rewriting it", () => {
    const legacy = {
      profileId: shared.profileId,
      processGeneration: shared.processGeneration,
      observedAt: shared.observedAt,
      preset: shared.preset,
      model: shared.model,
      reasoningEffort: shared.reasoningEffort,
      claudeVersion: shared.claudeVersion,
      permissionMode: shared.permissionMode,
      isolatedConfigDir: true as const,
      outputFormat: shared.outputFormat,
      inputFormat: shared.inputFormat,
    };
    const parsed = effectiveClaudeRuntimeProfileSchema.parse(legacy);
    expect(parsed).toEqual(legacy);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(legacy));
  });

  test("refuses an ambiguous or missing config-home attestation", () => {
    expect(effectiveClaudeRuntimeProfileSchema.safeParse(shared).success).toBe(false);
    expect(effectiveClaudeRuntimeProfileSchema.safeParse({
      ...shared,
      configHome: "personal",
      isolatedConfigDir: true,
    }).success).toBe(false);
  });

  test("omits current and legacy config-home provenance only from public projections", () => {
    const current = { ...shared, configHome: "personal" as const };
    const legacy = { ...shared, isolatedConfigDir: true as const };
    expect(projectPublicReviewedRuntimeProfile(current)).toEqual(shared);
    expect(projectPublicReviewedRuntimeProfile(legacy)).toEqual(shared);
    expect(current).toHaveProperty("configHome", "personal");
    expect(legacy).toHaveProperty("isolatedConfigDir", true);
  });
});
