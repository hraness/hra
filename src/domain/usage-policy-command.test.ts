import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { localCommandSchema } from "./contracts";
import {
  automaticUsagePolicyCommandResultSchema,
  createAutomaticUsagePolicyCommandResult,
} from "./usage-policy-command";

const configuration = {
  version: 1, defaultEnabled: false,
  overrides: { codex: "on", claude: "inherit" }, automaticPolicyRevision: 7,
} as const;
const result = {
  version: 1,
  configuration,
  effective: [
    { provider: "codex", enabled: true, source: "override", automaticPolicyRevision: 7 },
    { provider: "claude", enabled: false, source: "default", automaticPolicyRevision: 7 },
  ],
} as const;
const key = "11111111-1111-4111-8111-111111111111";

describe("automatic usage policy command contract", () => {
  test("derives the exact detached, immutable result for every override and filter", () => {
    for (const defaultEnabled of [false, true]) {
      for (const codex of ["inherit", "on", "off"] as const) {
        for (const claude of ["inherit", "on", "off"] as const) {
          for (const provider of [undefined, "codex", "claude"] as const) {
            const input = { ...configuration, defaultEnabled, overrides: { codex, claude } };
            const before = JSON.stringify(input);
            const actual = createAutomaticUsagePolicyCommandResult(input, provider);
            const providers = provider === undefined ? ["codex", "claude"] as const : [provider];
            expect(actual).toEqual({
              version: 1, configuration: input,
              effective: providers.map((selected) => ({
                provider: selected,
                enabled: input.overrides[selected] === "inherit"
                  ? defaultEnabled : input.overrides[selected] === "on",
                source: input.overrides[selected] === "inherit" ? "default" : "override",
                automaticPolicyRevision: 7,
              })),
            });
            expect(automaticUsagePolicyCommandResultSchema.parse(actual)).toEqual(actual);
            expect(actual.configuration).not.toBe(input);
            expect(actual.configuration.overrides).not.toBe(input.overrides);
            expect(JSON.stringify(input)).toBe(before);
            for (const frozen of [actual, actual.configuration, actual.configuration.overrides,
              actual.effective, ...actual.effective]) expect(Object.isFrozen(frozen)).toBe(true);
            input.defaultEnabled = !defaultEnabled;
            expect(actual.configuration.defaultEnabled).toBe(defaultEnabled);
          }
        }
      }
    }
  });

  test("pins the versioned public JSON without internal account or process identities", () => {
    const expected = '{"version":1,"configuration":{"version":1,"defaultEnabled":false,"overrides":{"codex":"on","claude":"inherit"},"automaticPolicyRevision":7},"effective":[{"provider":"codex","enabled":true,"source":"override","automaticPolicyRevision":7},{"provider":"claude","enabled":false,"source":"default","automaticPolicyRevision":7}]}';
    expect(JSON.stringify(createAutomaticUsagePolicyCommandResult(configuration))).toBe(expected);
    expect(JSON.stringify(automaticUsagePolicyCommandResultSchema.parse(result))).toBe(expected);
  });

  test("rejects malformed, missing, inconsistent, unordered and expanded results", () => {
    const codex = result.effective[0];
    const claude = result.effective[1];
    const invalid: readonly unknown[] = [
      null, {}, { ...result, version: 2 }, { ...result, profileId: "private" },
      { ...result, configuration: { ...configuration, processGeneration: 3 } },
      { ...result, configuration: { ...configuration, overrides: { ...configuration.overrides, devin: "off" } } },
      { ...result, configuration: { ...configuration, defaultEnabled: undefined } },
      { ...result, configuration: { ...configuration, automaticPolicyRevision: 0 } },
      { ...result, configuration: { ...configuration, automaticPolicyRevision: Number.MAX_SAFE_INTEGER + 1 } },
      { ...result, configuration: { ...configuration, overrides: { codex: "on" } } },
      { ...result, effective: [] }, { ...result, effective: [codex, claude, codex] },
      { ...result, effective: [claude, codex] }, { ...result, effective: [codex, codex] },
      { ...result, effective: [claude, claude] },
      { ...result, effective: [{ ...codex, provider: "devin" }] },
      { ...result, effective: [{ ...codex, enabled: false }] },
      { ...result, effective: [{ ...codex, source: "default" }] },
      { ...result, effective: [{ ...codex, automaticPolicyRevision: 6 }] },
      { ...result, effective: [{ ...codex, providerAccountId: "private" }] },
      { ...result, effective: [{ ...codex, enabled: undefined }] },
      { ...result, effective: [{ ...codex, extra: undefined }] },
    ];
    for (const candidate of invalid) {
      expect(automaticUsagePolicyCommandResultSchema.safeParse(candidate).success).toBe(false);
    }
    for (const candidate of [null, {}, { ...configuration, extra: true }]) {
      expect(() => createAutomaticUsagePolicyCommandResult(candidate)).toThrow();
    }
  });

  test("the local wire is closed and requires explicit mutation authority", () => {
    const update = {
      kind: "usage.auto.set", idempotencyKey: key, expectedAutomaticPolicyRevision: 7,
      change: { kind: "set_override", provider: "codex", override: "inherit" },
    } as const;
    expect(localCommandSchema.parse(update)).toEqual(update);
    for (const candidate of [
      { kind: "usage.auto.status" }, { kind: "usage.auto.status", provider: "claude" },
      { ...update, change: { kind: "set_default", enabled: false } },
    ]) expect(localCommandSchema.safeParse(candidate).success).toBe(true);
    for (const candidate of [
      { kind: "usage.auto.status", provider: "devin" },
      { kind: "usage.auto.status", idempotencyKey: key },
      { kind: "usage.auto.status", expectedAutomaticPolicyRevision: 7 },
      { ...update, idempotencyKey: undefined }, { ...update, idempotencyKey: "invalid" },
      { ...update, expectedAutomaticPolicyRevision: undefined },
      { ...update, expectedAutomaticPolicyRevision: 0 },
      { ...update, expectedAutomaticPolicyRevision: 1.5 },
      { ...update, expectedAutomaticPolicyRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...update, processGeneration: 3 },
      { ...update, change: { ...update.change, provider: "devin" } },
      { ...update, change: { ...update.change, override: "auto" } },
      { ...update, change: { kind: "set_default", enabled: false, provider: "codex" } },
    ]) expect(localCommandSchema.safeParse(candidate).success).toBe(false);
  });

  test("safe parsing is total over JSON and continuable revision-bound failures", () => {
    fc.assert(fc.property(fc.jsonValue(), (value) => {
      expect(() => automaticUsagePolicyCommandResultSchema.safeParse(value)).not.toThrow();
    }), { seed: 49_007, numRuns: 100 });
    fc.assert(fc.property(fc.integer({ min: -1_000, max: 0 }), (automaticPolicyRevision) => {
      expect(automaticUsagePolicyCommandResultSchema.safeParse({
        ...result, configuration: { ...configuration, automaticPolicyRevision },
      }).success).toBe(false);
    }), { seed: 49_008, numRuns: 100 });
  });
});
