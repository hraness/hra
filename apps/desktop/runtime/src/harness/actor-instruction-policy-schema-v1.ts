import { z } from "@hra-internal/schema";

const boundedInstructionSchema = z.string().min(1).max(1_024)
  .refine((value) => !value.includes("\0"), "actor instruction contains NUL");

export const persistentActorInstructionPolicySchema = z.object({
  version: z.literal(1),
  opening: boundedInstructionSchema,
  delegation: z.object({
    boundedLeaf: boundedInstructionSchema,
    standard: boundedInstructionSchema,
    largeChange: boundedInstructionSchema,
    wideResearch: boundedInstructionSchema,
  }).strict(),
  toolBoundary: boundedInstructionSchema,
  schemaBoundary: boundedInstructionSchema,
  handleGuidance: boundedInstructionSchema,
  routingGuidance: boundedInstructionSchema,
  completionGuidance: boundedInstructionSchema,
}).strict();

export type PersistentActorInstructionPolicy = z.infer<
  typeof persistentActorInstructionPolicySchema
>;

export function parsePersistentActorInstructionPolicy(
  value: unknown,
): PersistentActorInstructionPolicy {
  return persistentActorInstructionPolicySchema.parse(value);
}
