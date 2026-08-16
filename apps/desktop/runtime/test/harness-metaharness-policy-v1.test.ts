import { describe, expect, test } from "bun:test";
import { fc } from "@hra-internal/test";

import {
  actorTurnAccelerationSchema,
  actorWorkClassSchema,
  parseActorTurnAcceleration,
  parseActorWorkClass,
} from "../src/harness/actor-domain";
import {
  HRA_LUNA_MODEL,
  HRA_SOL_MODEL,
  actorWorkClassMayDelegate,
  compileMetaharnessRoute,
  compileMetaharnessTier,
  orderedProfilesForWorkClass,
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
  test("parses only the closed work classes and acceleration states", () => {
    expect(actorWorkClassSchema.options).toEqual([
      "largeChange",
      "wideResearch",
      "standard",
      "boundedLeaf",
    ]);
    expect(parseActorWorkClass("standard")).toBe("standard");
    expect(parseActorWorkClass("legacyUnclassified")).toBeNull();
    expect(parseActorTurnAcceleration({ mode: "standard" })).toEqual({
      mode: "standard",
    });
    expect(parseActorTurnAcceleration({
      mode: "fast",
      criticalPath: true,
      bottleneck: "reasoning",
    })).toEqual({
      mode: "fast",
      criticalPath: true,
      bottleneck: "reasoning",
    });
    expect(actorTurnAccelerationSchema.safeParse({
      mode: "fast",
      criticalPath: false,
      bottleneck: "reasoning",
    }).success).toBeFalse();
    expect(actorTurnAccelerationSchema.safeParse({
      mode: "fast",
      criticalPath: true,
      bottleneck: "toolIo",
    }).success).toBeFalse();
    expect(actorTurnAccelerationSchema.safeParse({
      mode: "standard",
      bottleneck: "reasoning",
    }).success).toBeFalse();
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

  test("makes Fast a sparse per-turn overlay with closed fallbacks", () => {
    const acceleration = {
      mode: "fast" as const,
      criticalPath: true as const,
      bottleneck: "reasoning" as const,
    };
    expect(compileMetaharnessTier({
      acceleration,
      automaticFastMode: "criticalPath",
      selectedProfileSupportsFast: true,
      fastReservationAvailable: true,
    })).toMatchObject({ realizedTier: "fast", fallbackReason: null });
    expect(compileMetaharnessTier({
      acceleration,
      automaticFastMode: "off",
      selectedProfileSupportsFast: true,
      fastReservationAvailable: true,
    })).toMatchObject({
      realizedTier: "standard",
      fallbackReason: "automaticFastDisabled",
    });
    expect(compileMetaharnessTier({
      acceleration,
      automaticFastMode: "criticalPath",
      selectedProfileSupportsFast: false,
      fastReservationAvailable: true,
    })).toMatchObject({
      realizedTier: "standard",
      fallbackReason: "fastUnsupported",
    });
    expect(compileMetaharnessTier({
      acceleration,
      automaticFastMode: "criticalPath",
      selectedProfileSupportsFast: true,
      fastReservationAvailable: false,
    })).toMatchObject({
      realizedTier: "standard",
      fallbackReason: "fastReservationUnavailable",
    });
  });

  test("property: Standard never acquires Fast regardless of capability state", () => {
    fc.assert(fc.property(
      fc.boolean(),
      fc.boolean(),
      fc.constantFrom("off" as const, "criticalPath" as const),
      (selectedProfileSupportsFast, fastReservationAvailable, automaticFastMode) => {
        expect(compileMetaharnessTier({
          acceleration: { mode: "standard" },
          automaticFastMode,
          selectedProfileSupportsFast,
          fastReservationAvailable,
        })).toMatchObject({ realizedTier: "standard", fallbackReason: null });
      },
    ), { numRuns: 100 });
  });
});
