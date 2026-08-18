import { describe, expect, test } from "bun:test";
import { fc } from "@hra-internal/test";

import {
  chatRootTurnRoutingProjectionSchema,
  type ChatRootTurnRoutingProjection,
} from "../../contracts/runtime";
import {
  ROOT_TURN_ROUTING_POLICY_VERSION,
  classifyRootTurnRoutingV1,
} from "../src/chat/root-turn-routing-policy-v1";

function classify(
  prompt: string,
  priorRouting?: ChatRootTurnRoutingProjection | null,
) {
  return classifyRootTurnRoutingV1({ prompt, priorRouting });
}

const priorRoutes = {
  ultra: chatRootTurnRoutingProjectionSchema.parse({
    policyVersion: 1,
    classificationReason: "largeChangeCue",
    workClass: "largeChange",
    requestedProfile: "solUltra",
    selectedProfile: "solUltra",
    profileFallbackReason: null,
    requestedServiceTier: "standard",
    selectedServiceTier: "standard",
    serviceTierFallbackReason: null,
  }),
  standard: chatRootTurnRoutingProjectionSchema.parse({
    policyVersion: 1,
    classificationReason: "conservativeDefault",
    workClass: "standard",
    requestedProfile: "solMax",
    selectedProfile: "solMax",
    profileFallbackReason: null,
    requestedServiceTier: "standard",
    selectedServiceTier: "standard",
    serviceTierFallbackReason: null,
  }),
  leaf: chatRootTurnRoutingProjectionSchema.parse({
    policyVersion: 1,
    classificationReason: "boundedLeafCue",
    workClass: "boundedLeaf",
    requestedProfile: "lunaMax",
    selectedProfile: "solMax",
    profileFallbackReason: "lunaUnavailable",
    requestedServiceTier: "fast",
    selectedServiceTier: "standard",
    serviceTierFallbackReason: "fastUnavailable",
  }),
} as const;

describe("root turn routing policy v1", () => {
  test("pins the durable policy version", () => {
    expect(ROOT_TURN_ROUTING_POLICY_VERSION).toBe(1);
  });

  test("routes only high-confidence wide research and broad changes to Ultra Standard", () => {
    expect(classify("Review this function.").policyVersion)
      .toBe(ROOT_TURN_ROUTING_POLICY_VERSION);
    expect(classify(
      "Research and compare several persistence approaches across the ecosystem.",
    )).toMatchObject({
      classificationReason: "wideResearchCue",
      workClass: "wideResearch",
      requestedProfile: "solUltra",
      requestedServiceTier: "standard",
    });
    expect(classify(
      "Implement the new routing feature across the frontend and backend.",
    )).toMatchObject({
      classificationReason: "largeChangeCue",
      workClass: "largeChange",
      requestedProfile: "solUltra",
      requestedServiceTier: "standard",
    });
    for (const prompt of ["Implement this feature", "Refactor this system"]) {
      expect(classify(prompt, priorRoutes.leaf)).toMatchObject({
        classificationReason: "largeChangeCue",
        workClass: "largeChange",
        requestedProfile: "solUltra",
        requestedServiceTier: "standard",
      });
    }
    expect(classify("Audit the entire repository.")).toMatchObject({
      classificationReason: "wideResearchCue",
      workClass: "wideResearch",
      requestedProfile: "solUltra",
      requestedServiceTier: "standard",
    });
    for (const prompt of [
      "Review all the code.",
      "Audit every file.",
      "Review the whole frontend and backend.",
      "Audit the entire app.",
      "Perform a comprehensive audit.",
    ]) {
      expect(classify(prompt)).toMatchObject({
        classificationReason: "wideResearchCue",
        workClass: "wideResearch",
        requestedProfile: "solUltra",
        requestedServiceTier: "standard",
      });
    }
    expect(classify("Review this function for a possible bug.")).toMatchObject({
      classificationReason: "conservativeDefault",
      workClass: "standard",
      requestedProfile: "solMax",
      requestedServiceTier: "standard",
    });
    for (const prompt of ["Review multiple tests", "Compare multiple strings"]) {
      expect(classify(prompt)).toMatchObject({
        classificationReason: "conservativeDefault",
        workClass: "standard",
        requestedProfile: "solMax",
      });
    }
    for (const prompt of [
      "Review the sources button label.",
      "Compare the system button labels.",
      "Implement the feature button label.",
      "Review the architecture icon.",
      "Change the architecture button.",
      "Update all text in this button.",
      "Change every string in this test.",
      "Update the whole label.",
      "Change the entire tooltip.",
    ]) {
      expect(classify(prompt).requestedProfile).not.toBe("solUltra");
    }
  });

  test("uses Luna Fast only for bounded leaf work with a named narrow target", () => {
    expect(classify("Fix the typo in the button label.")).toMatchObject({
      classificationReason: "boundedLeafCue",
      workClass: "boundedLeaf",
      requestedProfile: "lunaMax",
      selectedProfile: null,
      profileFallbackReason: null,
      requestedServiceTier: "fast",
      selectedServiceTier: null,
      serviceTierFallbackReason: null,
    });
    expect(classify("Update the feature button label.")).toMatchObject({
      classificationReason: "boundedLeafCue",
      workClass: "boundedLeaf",
      requestedProfile: "lunaMax",
      requestedServiceTier: "fast",
    });
    expect(classify("Update the repository README.")).toMatchObject({
      classificationReason: "boundedLeafCue",
      workClass: "boundedLeaf",
      requestedProfile: "lunaMax",
      requestedServiceTier: "fast",
    });
    expect(classify("Update the system tooltip.")).toMatchObject({
      classificationReason: "conservativeDefault",
      workClass: "standard",
      requestedProfile: "solMax",
    });
    expect(classify("Update apps/desktop/frontend/src/App.tsx only.")).toMatchObject({
      workClass: "boundedLeaf",
      requestedProfile: "lunaMax",
      requestedServiceTier: "fast",
    });
    expect(classify(
      "Update apps/desktop/frontend/src/App.tsx and apps/desktop/runtime/src/index.ts.",
    )).toMatchObject({
      workClass: "standard",
      requestedProfile: "solMax",
      requestedServiceTier: "standard",
    });
    expect(classify(
      "Update apps/desktop/frontend/src/App.tsx, apps/desktop/runtime/src/index.ts, and apps/desktop/contracts/runtime.ts.",
    )).toMatchObject({
      workClass: "largeChange",
      requestedProfile: "solUltra",
      requestedServiceTier: "standard",
    });
    expect(classify("Fix the authentication schema.")).toMatchObject({
      workClass: "standard",
      requestedProfile: "solMax",
    });
    for (const prompt of [
      "Fix one cross-cutting bug",
      "Fix one cross cutting bug",
      "Fix one end-to-end flow",
      "Fix one end to end flow",
    ]) {
      expect(classify(prompt)).toMatchObject({
        classificationReason: "conservativeDefault",
        workClass: "standard",
        requestedProfile: "solMax",
      });
    }
  });

  test("exact continuation inherits the prior requested route, not its fallback", () => {
    expect(classify("continue it", priorRoutes.ultra)).toMatchObject({
      classificationReason: "continuationInherited",
      workClass: "largeChange",
      requestedProfile: "solUltra",
      requestedServiceTier: "standard",
    });
    expect(classify("Please keep going.", priorRoutes.standard)).toMatchObject({
      classificationReason: "continuationInherited",
      workClass: "standard",
      requestedProfile: "solMax",
      requestedServiceTier: "standard",
    });
    expect(classify("do it", priorRoutes.leaf)).toMatchObject({
      classificationReason: "continuationInherited",
      workClass: "boundedLeaf",
      requestedProfile: "lunaMax",
      requestedServiceTier: "fast",
      selectedProfile: null,
      profileFallbackReason: null,
      selectedServiceTier: null,
      serviceTierFallbackReason: null,
    });
    for (const prompt of [
      "Continue with the implementation",
      "Continue and apply the watcher baseline fix finish all your work here",
    ]) {
      expect(classify(prompt, priorRoutes.ultra)).toMatchObject({
        classificationReason: "continuationInherited",
        workClass: "largeChange",
        requestedProfile: "solUltra",
        requestedServiceTier: "standard",
      });
    }
    for (const prompt of [
      "Continue the broad repository audit",
      "Continue with a full implementation across the frontend and backend",
      "Continue, but now refactor the entire system",
    ]) {
      expect(classify(prompt, priorRoutes.leaf)).toMatchObject({
        requestedProfile: "solUltra",
        requestedServiceTier: "standard",
      });
    }
    expect(classify(
      "Continue, but only fix the button label",
      priorRoutes.ultra,
    )).toMatchObject({
      classificationReason: "boundedLeafCue",
      workClass: "boundedLeaf",
      requestedProfile: "lunaMax",
      requestedServiceTier: "fast",
    });
  });

  test("continuation without a prior route uses Sol Max Fast", () => {
    for (const prompt of [
      "continue it",
      "Please keep going.",
      "do it",
      "fix that",
      "Update this",
    ]) {
      expect(classify(prompt)).toMatchObject({
        classificationReason: "continuationOrAmbiguous",
        workClass: "standard",
        requestedProfile: "solMax",
        requestedServiceTier: "fast",
      });
    }
  });

  test("rejects unbounded or structurally foreign input", () => {
    expect(() => classifyRootTurnRoutingV1({ prompt: "" })).toThrow();
    expect(() => classifyRootTurnRoutingV1({ prompt: " " })).toThrow();
    expect(() => classifyRootTurnRoutingV1({
      prompt: "Fix the label",
      promptDigest: "forbidden",
    })).toThrow();
    expect(() => classifyRootTurnRoutingV1({
      prompt: "continue it",
      priorRouting: { ...priorRoutes.standard, prompt: "forbidden" },
    })).toThrow();
  });

  test("property: classification is closed, content-free, and unresolved", () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1, maxLength: 500 }).filter((value) =>
        value.trim().length > 0 && !value.includes("\0")
      ),
      (prompt) => {
        const decision = classify(prompt);
        expect(chatRootTurnRoutingProjectionSchema.safeParse(decision).success)
          .toBeTrue();
        expect(decision.selectedProfile).toBeNull();
        expect(decision.profileFallbackReason).toBeNull();
        expect(decision.selectedServiceTier).toBeNull();
        expect(decision.serviceTierFallbackReason).toBeNull();
        expect("prompt" in decision).toBeFalse();
        expect(Object.keys(decision).sort()).toEqual([
          "classificationReason",
          "policyVersion",
          "profileFallbackReason",
          "requestedProfile",
          "requestedServiceTier",
          "selectedProfile",
          "selectedServiceTier",
          "serviceTierFallbackReason",
          "workClass",
        ]);
      },
    ), { numRuns: 200 });
  });
});
