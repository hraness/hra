import { describe, expect, test } from "bun:test";
import { fc } from "@hra-internal/test";

import {
  actorWorkClassSchema,
  parseActorWorkClass,
} from "../src/harness/actor-domain";
import {
  HRA_LUNA_MODEL,
  HRA_SOL_MODEL,
  actorWorkClassMayDelegate,
  compileMetaharnessRoute,
  compileMetaharnessTier,
  orderedProfilesForWorkClass,
  requestedServiceTierForWorkClass,
} from "../src/harness/metaharness-policy-v1";

const solCapability = {
  modelId: HRA_SOL_MODEL,
  reasoningEfforts: ["max", "ultra"],
  supportsFast: true,
} as const;
const lunaCapability = {
  modelId: HRA_LUNA_MODEL,
  reasoningEfforts: ["max"],
  supportsFast: true,
} as const;

describe("metaharness policy v1", () => {
  test("parses only the closed semantic work classes", () => {
    expect(actorWorkClassSchema.options).toEqual([
      "largeChange",
      "wideResearch",
      "standard",
      "boundedLeaf",
    ]);
    expect(parseActorWorkClass("standard")).toBe("standard");
    expect(parseActorWorkClass("legacyUnclassified")).toBeNull();
  });

  test("maps work classes to exact profiles without quality downgrades", () => {
    expect(orderedProfilesForWorkClass("largeChange")).toEqual([{
      key: "solUltra",
      modelId: HRA_SOL_MODEL,
      reasoningEffort: "ultra",
    }]);
    expect(orderedProfilesForWorkClass("wideResearch")).toEqual(
      orderedProfilesForWorkClass("largeChange"),
    );
    expect(orderedProfilesForWorkClass("standard")).toEqual([{
      key: "solMax",
      modelId: HRA_SOL_MODEL,
      reasoningEffort: "max",
    }]);
    expect(orderedProfilesForWorkClass("boundedLeaf")?.map(({ key }) => key))
      .toEqual(["lunaMax", "solMax"]);
    expect(actorWorkClassMayDelegate("boundedLeaf")).toBeFalse();
    expect(actorWorkClassMayDelegate("standard")).toBeTrue();
  });

  test("falls back only from Luna Max to Sol Max", () => {
    expect(compileMetaharnessRoute({
      workClass: "boundedLeaf",
      capabilities: [solCapability],
    })).toMatchObject({
      kind: "resolved",
      requestedProfile: "lunaMax",
      selectedProfile: { key: "solMax" },
      profileFallbackReason: "lunaUnavailable",
    });
    expect(compileMetaharnessRoute({
      workClass: "boundedLeaf",
      capabilities: [lunaCapability, solCapability],
    })).toMatchObject({
      kind: "resolved",
      selectedProfile: { key: "lunaMax" },
      profileFallbackReason: null,
    });
    expect(compileMetaharnessRoute({
      workClass: "largeChange",
      capabilities: [{ ...solCapability, reasoningEfforts: ["max"] }],
    })).toMatchObject({
      kind: "capabilityUnavailable",
      requestedProfile: "solUltra",
    });
    expect(() => compileMetaharnessRoute({
      workClass: "standard",
      capabilities: [solCapability, solCapability],
    })).toThrow("catalog model IDs must be unique");
  });

  test("owns recursive tier selection by work class with closed fallbacks", () => {
    expect(requestedServiceTierForWorkClass("boundedLeaf")).toBe("fast");
    expect(requestedServiceTierForWorkClass("standard")).toBe("standard");
    expect(requestedServiceTierForWorkClass("largeChange")).toBe("standard");
    expect(requestedServiceTierForWorkClass("wideResearch")).toBe("standard");
    expect(requestedServiceTierForWorkClass("legacyUnclassified")).toBeNull();
    expect(compileMetaharnessTier({
      workClass: "boundedLeaf",
      selectedProfileSupportsFast: true,
      fastReservationAvailable: true,
    })).toMatchObject({
      requestedServiceTier: "fast",
      realizedTier: "fast",
      fallbackReason: null,
    });
    expect(compileMetaharnessTier({
      workClass: "boundedLeaf",
      selectedProfileSupportsFast: false,
      fastReservationAvailable: true,
    })).toMatchObject({
      requestedServiceTier: "fast",
      realizedTier: "standard",
      fallbackReason: "fastUnsupported",
    });
    expect(compileMetaharnessTier({
      workClass: "boundedLeaf",
      selectedProfileSupportsFast: true,
      fastReservationAvailable: false,
    })).toMatchObject({
      requestedServiceTier: "fast",
      realizedTier: "standard",
      fallbackReason: "fastReservationUnavailable",
    });
    expect(() => compileMetaharnessTier({
      workClass: "boundedLeaf",
      acceleration: { mode: "standard" },
      selectedProfileSupportsFast: true,
      fastReservationAvailable: true,
    })).toThrow();
  });

  test("property: broader work never acquires Fast", () => {
    fc.assert(fc.property(
      fc.boolean(),
      fc.boolean(),
      fc.constantFrom(
        "largeChange" as const,
        "wideResearch" as const,
        "standard" as const,
      ),
      (selectedProfileSupportsFast, fastReservationAvailable, workClass) => {
        expect(compileMetaharnessTier({
          workClass,
          selectedProfileSupportsFast,
          fastReservationAvailable,
        })).toMatchObject({
          requestedServiceTier: "standard",
          realizedTier: "standard",
          fallbackReason: null,
        });
      },
    ), { numRuns: 100 });
  });
});
