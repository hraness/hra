import { z } from "@hra-internal/schema";

import {
  harnessAutomaticFastModeSchema,
  type HarnessAutomaticFastMode,
} from "../../../contracts/runtime";

import {
  HRA_METAHARNESS_POLICY_VERSION,
  actorTurnAccelerationSchema,
  actorWorkClassSchema,
  type ActorTurnAcceleration,
  type ActorWorkClass,
} from "./actor-domain";

export const workClassSchema = actorWorkClassSchema;
export const turnAccelerationSchema = actorTurnAccelerationSchema;
export type WorkClass = ActorWorkClass;
export type TurnAcceleration = ActorTurnAcceleration;

export const HRA_SOL_MODEL = "gpt-5.6-sol" as const;
export const HRA_LUNA_MODEL = "gpt-5.6-luna" as const;

export const metaharnessProfileKeySchema = z.enum([
  "solUltra",
  "solMax",
  "lunaMax",
]);
export type MetaharnessProfileKey = z.infer<
  typeof metaharnessProfileKeySchema
>;

export const metaharnessProfileSchema = z.object({
  key: metaharnessProfileKeySchema,
  modelId: z.enum([HRA_SOL_MODEL, HRA_LUNA_MODEL]),
  reasoningEffort: z.enum(["ultra", "max"]),
}).strict();
export type MetaharnessProfile = z.infer<typeof metaharnessProfileSchema>;
export const realizedActorProfileSchema = metaharnessProfileSchema.omit({
  key: true,
});
export type RealizedActorProfile = z.infer<
  typeof realizedActorProfileSchema
>;

export const HRA_METAHARNESS_PROFILES = Object.freeze({
  solUltra: Object.freeze({
    key: "solUltra",
    modelId: HRA_SOL_MODEL,
    reasoningEffort: "ultra",
  }),
  solMax: Object.freeze({
    key: "solMax",
    modelId: HRA_SOL_MODEL,
    reasoningEffort: "max",
  }),
  lunaMax: Object.freeze({
    key: "lunaMax",
    modelId: HRA_LUNA_MODEL,
    reasoningEffort: "max",
  }),
} satisfies Readonly<Record<MetaharnessProfileKey, MetaharnessProfile>>);

export const metaharnessCatalogCapabilitySchema = z.object({
  modelId: z.string().min(1).max(128),
  reasoningEfforts: z.array(z.string().min(1).max(32)).max(16)
    .refine(
      (values) => new Set(values).size === values.length,
      "reasoning efforts must be unique",
    ),
  supportsFast: z.boolean(),
}).strict();
export type MetaharnessCatalogCapability = z.infer<
  typeof metaharnessCatalogCapabilitySchema
>;

export const metaharnessProfileFallbackReasonSchema =
  z.literal("lunaUnavailable");
export type MetaharnessProfileFallbackReason = z.infer<
  typeof metaharnessProfileFallbackReasonSchema
>;

export type MetaharnessRouteDecision =
  | Readonly<{
      kind: "resolved";
      policyVersion: typeof HRA_METAHARNESS_POLICY_VERSION;
      workClass: ActorWorkClass;
      requestedProfile: MetaharnessProfileKey;
      selectedProfile: MetaharnessProfile;
      profileFallbackReason: MetaharnessProfileFallbackReason | null;
      supportsFast: boolean;
    }>
  | Readonly<{
      kind: "capabilityUnavailable";
      policyVersion: typeof HRA_METAHARNESS_POLICY_VERSION;
      workClass: ActorWorkClass;
      requestedProfile: MetaharnessProfileKey;
      acceptableProfiles: readonly MetaharnessProfile[];
    }>;

export const automaticFastModeSchema = harnessAutomaticFastModeSchema;
export type AutomaticFastMode = HarnessAutomaticFastMode;

export const metaharnessTierSchema = z.enum(["standard", "fast"]);
export type MetaharnessTier = z.infer<typeof metaharnessTierSchema>;

export const metaharnessFastFallbackReasonSchema = z.enum([
  "automaticFastDisabled",
  "fastUnsupported",
  "fastReservationUnavailable",
]);
export type MetaharnessFastFallbackReason = z.infer<
  typeof metaharnessFastFallbackReasonSchema
>;

export interface MetaharnessTierDecision {
  readonly policyVersion: typeof HRA_METAHARNESS_POLICY_VERSION;
  readonly requestedAcceleration: ActorTurnAcceleration;
  readonly realizedTier: MetaharnessTier;
  readonly fallbackReason: MetaharnessFastFallbackReason | null;
}

const routeInputSchema = z.object({
  workClass: actorWorkClassSchema,
  capabilities: z.array(metaharnessCatalogCapabilitySchema).max(128).refine(
    (capabilities) =>
      new Set(capabilities.map(({ modelId }) => modelId)).size ===
        capabilities.length,
    "catalog model IDs must be unique",
  ),
}).strict();

const tierInputSchema = z.object({
  acceleration: actorTurnAccelerationSchema,
  automaticFastMode: automaticFastModeSchema,
  selectedProfileSupportsFast: z.boolean(),
  fastReservationAvailable: z.boolean(),
}).strict();

export function orderedProfilesForWorkClass(
  workClassValue: unknown,
): readonly MetaharnessProfile[] | null {
  const parsed = actorWorkClassSchema.safeParse(workClassValue);
  if (!parsed.success) return null;
  switch (parsed.data) {
    case "largeChange":
    case "wideResearch":
      return Object.freeze([HRA_METAHARNESS_PROFILES.solUltra]);
    case "standard":
      return Object.freeze([HRA_METAHARNESS_PROFILES.solMax]);
    case "boundedLeaf":
      return Object.freeze([
        HRA_METAHARNESS_PROFILES.lunaMax,
        HRA_METAHARNESS_PROFILES.solMax,
      ]);
  }
}

export function actorWorkClassMayDelegate(workClassValue: unknown): boolean {
  const parsed = actorWorkClassSchema.safeParse(workClassValue);
  return parsed.success && parsed.data !== "boundedLeaf";
}

/** Compile a complete, exact-generation catalog into one immutable route. */
export function compileMetaharnessRoute(
  inputValue: unknown,
): MetaharnessRouteDecision {
  const input = routeInputSchema.parse(inputValue);
  const acceptableProfiles = orderedProfilesForWorkClass(input.workClass);
  if (acceptableProfiles === null) {
    throw new Error("metaharness work class became invalid after parsing");
  }
  const requestedProfile = acceptableProfiles[0]!.key;
  for (const profile of acceptableProfiles) {
    const capability = input.capabilities.find((candidate) =>
      candidate.modelId === profile.modelId &&
      candidate.reasoningEfforts.includes(profile.reasoningEffort)
    );
    if (capability !== undefined) {
      return Object.freeze({
        kind: "resolved",
        policyVersion: HRA_METAHARNESS_POLICY_VERSION,
        workClass: input.workClass,
        requestedProfile,
        selectedProfile: profile,
        profileFallbackReason: profile.key === requestedProfile
          ? null
          : "lunaUnavailable",
        supportsFast: capability.supportsFast,
      });
    }
  }
  return Object.freeze({
    kind: "capabilityUnavailable",
    policyVersion: HRA_METAHARNESS_POLICY_VERSION,
    workClass: input.workClass,
    requestedProfile,
    acceptableProfiles,
  });
}

/**
 * Decide the per-turn tier after the atomic reservation seam has reported
 * availability. Fast never changes the actor's model or reasoning effort.
 */
export function compileMetaharnessTier(
  inputValue: unknown,
): MetaharnessTierDecision {
  const input = tierInputSchema.parse(inputValue);
  if (input.acceleration.mode === "standard") {
    return tierDecision(input.acceleration, "standard", null);
  }
  if (input.automaticFastMode === "off") {
    return tierDecision(
      input.acceleration,
      "standard",
      "automaticFastDisabled",
    );
  }
  if (!input.selectedProfileSupportsFast) {
    return tierDecision(input.acceleration, "standard", "fastUnsupported");
  }
  if (!input.fastReservationAvailable) {
    return tierDecision(
      input.acceleration,
      "standard",
      "fastReservationUnavailable",
    );
  }
  return tierDecision(input.acceleration, "fast", null);
}

function tierDecision(
  requestedAcceleration: ActorTurnAcceleration,
  realizedTier: MetaharnessTier,
  fallbackReason: MetaharnessFastFallbackReason | null,
): MetaharnessTierDecision {
  return Object.freeze({
    policyVersion: HRA_METAHARNESS_POLICY_VERSION,
    requestedAcceleration: Object.freeze({ ...requestedAcceleration }),
    realizedTier,
    fallbackReason,
  });
}
