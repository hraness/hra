import { describe, expect, test } from "bun:test";

import {
  assertPresetSupportedByProvider,
  currentPresetContract,
  defaultPresetForProvider,
  isAdmittedPresetRequirement,
  isPresetSupportedByProvider,
  legacyPresetContract,
  PresetProviderMismatchError,
  presetContractSchema,
  presetForProviderTier,
  presetProviders,
  presetRequirementForContract,
  presetSchema,
  presetTiers,
  presetsForProvider,
  providerSchema,
} from "./presets";
import {
  effectiveClaudeRuntimeProfileSchema,
  effectiveRuntimeProfileSchema,
} from "./runtime-profile";

describe("model presets and providers", () => {
  test("names exactly the four presets and two providers", () => {
    expect(presetSchema.options).toEqual(["low", "high", "ultra", "fable-max"]);
    expect(providerSchema.options).toEqual(["codex", "claude"]);
    expect(presetsForProvider("codex")).toEqual(["low", "high", "ultra"]);
    expect(presetsForProvider("claude")).toEqual(["fable-max"]);
  });

  test("gives every provider one supported default without changing preset meanings", () => {
    expect(defaultPresetForProvider("codex")).toBe("ultra");
    expect(defaultPresetForProvider("claude")).toBe("fable-max");

    for (const provider of providerSchema.options) {
      const preset = defaultPresetForProvider(provider);
      expect(presetProviders[preset]).toBe(provider);
      expect(isPresetSupportedByProvider(provider, preset)).toBe(true);
    }
  });

  test("versions exact requirements without widening the admitted tuples", () => {
    expect(presetContractSchema.options.map((option) => option.value)).toEqual([
      legacyPresetContract,
      currentPresetContract,
    ]);
    expect(presetRequirementForContract("high", legacyPresetContract)).toEqual({
      model: "gpt-5.6-sol",
      effort: "max",
    });
    expect(presetRequirementForContract("ultra", currentPresetContract)).toEqual({
      model: "gpt-6-astra",
      effort: "ultra",
    });
    expect(isAdmittedPresetRequirement("high", {
      model: "gpt-5.6-sol",
      effort: "max",
    })).toBe(true);
    expect(isAdmittedPresetRequirement("high", {
      model: "gpt-6-astra",
      effort: "ultra",
    })).toBe(false);
  });

  test("refuses a preset the session's provider cannot run", () => {
    expect(() => { assertPresetSupportedByProvider("claude", "ultra"); })
      .toThrow(PresetProviderMismatchError);
    expect(() => { assertPresetSupportedByProvider("claude", "ultra"); })
      .toThrow("The claude provider does not support the `ultra` model preset. Supported presets: fable-max.");
    expect(() => { assertPresetSupportedByProvider("codex", "fable-max"); })
      .toThrow("Supported presets: low, high, ultra.");
    expect(() => { assertPresetSupportedByProvider("codex", "ultra"); }).not.toThrow();
    expect(isPresetSupportedByProvider("claude", "fable-max")).toBe(true);
    expect(isPresetSupportedByProvider("codex", "fable-max")).toBe(false);
  });

  test("round-trips every preset through its durable provider and tier", () => {
    for (const preset of presetSchema.options) {
      const provider = presetProviders[preset];
      expect(presetForProviderTier(provider, presetTiers[preset])).toBe(preset);
    }
    // No Claude preset exists below the top tier, so a stored `low` tier can
    // never be reassembled as a Claude preset.
    expect(() => presetForProviderTier("claude", "low")).toThrow("No claude model preset exists");
  });

  test("keeps another provider's preset out of a Codex runtime profile", () => {
    const profile = {
      approvalPolicy: "on-request",
      computerUse: true,
      enabledApps: [],
      fast: false,
      model: "gpt-6-astra",
      observedAt: 1_700_000_000_000,
      permissionProfile: ":workspace",
      pluginCapability: true,
      preset: "ultra",
      processGeneration: 1,
      profileId: "acct_00000000000000000000000000000000",
      reasoningEffort: "ultra",
      reviewMode: "auto_review",
      serviceTier: null,
    };
    expect(effectiveRuntimeProfileSchema.safeParse(profile).success).toBe(true);
    const legacy = {
      ...profile,
      model: "gpt-5.6-sol",
    };
    // Durable profile JSON is written from the parsed object, whose key order
    // is canonical. Reopening it must not rewrite that historical document.
    const legacyJson = JSON.stringify(effectiveRuntimeProfileSchema.parse(legacy));
    expect(JSON.stringify(effectiveRuntimeProfileSchema.parse(JSON.parse(legacyJson)))).toBe(legacyJson);
    expect(effectiveRuntimeProfileSchema.safeParse({
      ...legacy,
      reasoningEffort: "max",
    }).success).toBe(false);
    expect(effectiveRuntimeProfileSchema.safeParse({
      ...profile,
      model: "claude-fable-5-1",
      preset: "fable-max",
      reasoningEffort: "max",
    }).success).toBe(false);
  });

  test("keeps the reviewed native fallback state inside new Claude runtime profiles", () => {
    const profile = {
      claudeVersion: "2.1.260",
      inputFormat: "stream-json",
      isolatedConfigDir: true,
      model: "claude-fable-5-1",
      nativeFallback: {
        model: "claude-opus-5",
        reason: "live_acceptance_required",
        status: "unavailable",
      },
      observedAt: 1_700_000_000_000,
      outputFormat: "stream-json",
      permissionMode: "default",
      preset: "fable-max",
      processGeneration: 1,
      profileId: "acct_00000000000000000000000000000000",
      reasoningEffort: "max",
    };
    expect(effectiveClaudeRuntimeProfileSchema.safeParse(profile).success).toBe(true);
    expect(effectiveClaudeRuntimeProfileSchema.safeParse({
      ...profile,
      nativeFallback: {
        evidenceDigest: "not-a-digest",
        model: "claude-opus-5",
        status: "armed",
      },
    }).success).toBe(false);
    expect(effectiveClaudeRuntimeProfileSchema.safeParse({
      ...profile,
      nativeFallback: {
        evidenceDigest: "a".repeat(64),
        model: "claude-sonnet-5",
        status: "armed",
      },
    }).success).toBe(false);
    // Profiles recorded before the capability field was added remain readable
    // and keep their exact JSON and digest authority.
    expect(effectiveClaudeRuntimeProfileSchema.safeParse({
      ...profile,
      nativeFallback: undefined,
    }).success).toBe(true);
  });
});
