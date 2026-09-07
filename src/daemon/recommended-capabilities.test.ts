import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import type { CodexCapabilitySnapshot } from "../codex/index";
import { effectiveRuntimeProfileSchema } from "../domain/runtime-profile";
import { compileEffectiveRuntimeProfile } from "./recommended-capabilities";

const base = (): CodexCapabilitySnapshot => ({
  models: [],
  features: [
    { name: "computer_use", stage: "stable", enabled: true, defaultEnabled: true },
    { name: "plugins", stage: "stable", enabled: true, defaultEnabled: true },
  ],
  permissionProfiles: [
    { id: "read-only", description: null, allowed: true },
    { id: ":workspace", description: null, allowed: true },
    { id: "danger-full-access", description: null, allowed: false },
  ],
  apps: [
    { id: "disabled", name: "Disabled", description: null, isAccessible: true, isEnabled: false, pluginDisplayNames: ["Disabled"] },
    { id: "enabled-b", name: "Second", description: null, isAccessible: true, isEnabled: true, pluginDisplayNames: ["Zeta", "Alpha", "Alpha"] },
    { id: "enabled-a", name: "First", description: null, isAccessible: true, isEnabled: true, pluginDisplayNames: [] },
  ],
  pluginLifecycle: "unsupported-under-development",
});

const authority = {
  id: "acct_00000000000000000000000000000000" as never,
  generation: 7,
  codexHome: "/profiles/a/codex-home",
  desktopUserData: "/profiles/a/desktop-user-data",
};
const preset = {
  alias: "high" as const,
  model: "gpt-5.6-sol",
  effort: "max" as const,
  serviceTier: null,
  fast: false,
};

describe("recommended capability projection", () => {
  test("records only enabled accessible apps without mutating provider state", () => {
    expect(compileEffectiveRuntimeProfile({ authority, capabilities: base(), preset, observedAt: 42 })).toEqual({
      profileId: authority.id,
      processGeneration: 7,
      observedAt: 42,
      preset: "high",
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      serviceTier: null,
      fast: false,
      approvalPolicy: "on-request",
      reviewMode: "auto_review",
      permissionProfile: ":workspace",
      computerUse: true,
      pluginCapability: true,
      enabledApps: [
        { id: "enabled-a", name: "First", pluginDisplayNames: [] },
        { id: "enabled-b", name: "Second", pluginDisplayNames: ["Alpha", "Zeta"] },
      ],
    });
  });

  test("accepts an honest empty enabled app set", () => {
    const capabilities = base();
    expect(compileEffectiveRuntimeProfile({
      authority,
      capabilities: { ...capabilities, apps: [] },
      preset,
      observedAt: 42,
    }).enabledApps).toEqual([]);
  });

  test("fails closed on absent, duplicate, disabled, or unstable required authority", () => {
    const capabilities = base();
    expect(() => compileEffectiveRuntimeProfile({ authority, capabilities: { ...capabilities, apps: null }, preset, observedAt: 1 })).toThrow("app and plugin set");
    expect(() => compileEffectiveRuntimeProfile({ authority, capabilities: { ...capabilities, permissionProfiles: null }, preset, observedAt: 1 })).toThrow("permission profiles");
    expect(() => compileEffectiveRuntimeProfile({ authority, capabilities: { ...capabilities, permissionProfiles: capabilities.permissionProfiles!.map((profile) => profile.id === ":workspace" ? { ...profile, allowed: false } : profile) }, preset, observedAt: 1 })).toThrow("not allowed");
    expect(() => compileEffectiveRuntimeProfile({ authority, capabilities: { ...capabilities, features: [...capabilities.features, capabilities.features[0]!] }, preset, observedAt: 1 })).toThrow("exactly one computer use");
    expect(() => compileEffectiveRuntimeProfile({ authority, capabilities: { ...capabilities, apps: [...capabilities.apps!, capabilities.apps![0]!] }, preset, observedAt: 1 })).toThrow("duplicate app");
    expect(() => compileEffectiveRuntimeProfile({
      authority,
      capabilities: { ...capabilities, apps: [{ ...capabilities.apps![1]!, name: "Unsafe\u001b]52;c;payload\u0007" }] },
      preset,
      observedAt: 1,
    })).toThrow("control or formatting");
    expect(() => compileEffectiveRuntimeProfile({
      authority,
      capabilities: { ...capabilities, apps: [{ ...capabilities.apps![1]!, pluginDisplayNames: ["safe\u202Etxt"] }] },
      preset,
      observedAt: 1,
    })).toThrow("control or formatting");
  });

  test("is canonical under arbitrary provider ordering", () => {
    const expected = compileEffectiveRuntimeProfile({ authority, capabilities: base(), preset, observedAt: 42 });
    fc.assert(fc.property(
      fc.shuffledSubarray([0, 1], { minLength: 2, maxLength: 2 }),
      fc.shuffledSubarray([0, 1, 2], { minLength: 3, maxLength: 3 }),
      (featureOrder, appOrder) => {
        const capabilities = base();
        const reordered = {
          ...capabilities,
          features: featureOrder.map((index) => capabilities.features[index]!),
          apps: appOrder.map((index) => capabilities.apps![index]!),
        };
        expect(compileEffectiveRuntimeProfile({ authority, capabilities: reordered, preset, observedAt: 42 })).toEqual(expected);
      },
    ), { numRuns: 100 });
  });

  test("the durable profile parser is total for arbitrary foreign values", () => {
    fc.assert(fc.property(fc.anything(), (value) => {
      expect(() => effectiveRuntimeProfileSchema.safeParse(value)).not.toThrow();
    }), { numRuns: 1_000 });
  });
});
