import type { ActorWorkClass } from "./actor-domain";
import { parsePersistentActorInstructionPolicy } from
  "./actor-instruction-policy-schema-v1";
import {
  HRA_METAHARNESS_PROFILES,
  type MetaharnessProfileKey,
} from "./metaharness-policy-v1";
import policyValue from "./actor-instruction-policy-v1.json";

export {
  parsePersistentActorInstructionPolicy,
  persistentActorInstructionPolicySchema,
  type PersistentActorInstructionPolicy,
} from "./actor-instruction-policy-schema-v1";

const policy = Object.freeze(parsePersistentActorInstructionPolicy(policyValue));

/**
 * Pure policy for instructions sent only when a fresh persistent actor thread
 * starts. Development reload admission rejects every prepared or active actor
 * effect, so a replacement gateway cannot execute this policy during its boot
 * and recovery pass. That makes this the deliberately small, reviewed seam for
 * iterating on real metaharness behavior without widening durable authority.
 */
export function persistentActorInstructions(
  workClass: ActorWorkClass,
  selectedProfile: MetaharnessProfileKey,
): string {
  const profile = HRA_METAHARNESS_PROFILES[selectedProfile];
  return [
    policy.opening,
    `Durable work class: ${workClass}.`,
    `Durable execution profile: ${profile.modelId} with ${profile.reasoningEffort} reasoning.`,
    policy.toolBoundary,
    persistentActorDelegationPolicy(workClass),
    policy.schemaBoundary,
    policy.handleGuidance,
    policy.routingGuidance,
    policy.completionGuidance,
  ].join("\n");
}

export function persistentActorDelegationPolicy(
  workClass: ActorWorkClass,
): string {
  return policy.delegation[workClass];
}
