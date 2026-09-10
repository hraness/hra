import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  CloudDeploymentAliasConflictError,
  requireCloudDeploymentEnvironment,
  resolveCloudDeploymentEnvironment,
} from "./cloud-deployment-environment";

describe("cloud deployment environment aliases", () => {
  test("distinguishes absence, exact values, and contradictions without normalizing", () => {
    expect(requireCloudDeploymentEnvironment({})).toEqual({ environment: {}, selection: { kind: "absent" } });
    for (const value of ["", " ", "\t\n", "https://EXAMPLE.convex.cloud/", "invalid"]) {
      for (const environment of [
        { OOMPA_CONVEX_URL: value }, { HRA_CONVEX_URL: value },
        { OOMPA_CONVEX_URL: value, HRA_CONVEX_URL: value },
      ]) expect(requireCloudDeploymentEnvironment(environment)).toEqual({
        environment, selection: { kind: "selected", value },
      });
    }
    for (const [forward, legacy] of [
      ["", " "], [" ", "\t"],
      ["https://EXAMPLE.convex.cloud/", "https://example.convex.cloud"],
      ["https://first.convex.cloud", "https://second.convex.cloud"],
    ]) {
      const environment = { OOMPA_CONVEX_URL: forward, HRA_CONVEX_URL: legacy };
      expect(resolveCloudDeploymentEnvironment(environment).selection).toEqual({ kind: "conflict" });
      expect(() => requireCloudDeploymentEnvironment(environment)).toThrow(CloudDeploymentAliasConflictError);
    }
  });

  test("retains only the exact two-key snapshot and reads each source value once", () => {
    let forwardReads = 0;
    let legacyReads = 0;
    const result = resolveCloudDeploymentEnvironment({
      get OOMPA_CONVEX_URL() { forwardReads++; return ""; },
      get HRA_CONVEX_URL() { legacyReads++; return ""; },
      UNRELATED_VALUE: "not forwarded",
    });
    expect(forwardReads).toBe(1);
    expect(legacyReads).toBe(1);
    expect(result).toEqual({ environment: { OOMPA_CONVEX_URL: "", HRA_CONVEX_URL: "" }, selection: { kind: "selected", value: "" } });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.environment)).toBe(true);
    expect(Object.isFrozen(result.selection)).toBe(true);
  });

  test("preserves exact selection and rejects every sampled unequal defined pair", () => {
    fc.assert(fc.property(
      fc.option(fc.string({ maxLength: 128 }), { nil: undefined }),
      fc.option(fc.string({ maxLength: 128 }), { nil: undefined }),
      (forward, legacy) => {
        const input = { OOMPA_CONVEX_URL: forward, HRA_CONVEX_URL: legacy };
        const result = resolveCloudDeploymentEnvironment(input);
        expect(result.environment).toEqual({
          ...(forward === undefined ? {} : { OOMPA_CONVEX_URL: forward }),
          ...(legacy === undefined ? {} : { HRA_CONVEX_URL: legacy }),
        });
        if (forward !== undefined && legacy !== undefined && forward !== legacy) {
          expect(result.selection).toEqual({ kind: "conflict" });
          try {
            requireCloudDeploymentEnvironment(input);
            throw new Error("Expected conflicting aliases to refuse selection.");
          } catch (error: unknown) {
            expect(error).toBeInstanceOf(CloudDeploymentAliasConflictError);
            expect((error as Error).message).toBe("OOMPA_CONVEX_URL and HRA_CONVEX_URL must be byte-identical when both are set.");
            expect(Object.hasOwn(error as Error, "cause")).toBe(false);
          }
        } else {
          const value = forward ?? legacy;
          expect(requireCloudDeploymentEnvironment(input).selection).toEqual(value === undefined
            ? { kind: "absent" } : { kind: "selected", value });
        }
        input.OOMPA_CONVEX_URL = "later mutation";
        input.HRA_CONVEX_URL = "different later mutation";
        expect(result.environment.OOMPA_CONVEX_URL).toBe(forward);
        expect(result.environment.HRA_CONVEX_URL).toBe(legacy);
      },
    ), { seed: 20_260_912, numRuns: 64 });
  });
});
