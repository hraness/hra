import { z } from "zod";

import { presetRequirements, presetSchema } from "./presets";
import { profileIdSchema, unixMillisecondsSchema } from "./values";

const binaryCompare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const canonicalStrings = (values: readonly string[]): boolean =>
  values.every((value, index) => index === 0 || binaryCompare(values[index - 1] ?? "", value) < 0);

const safeDisplayString = (maximum: number) => z.string().trim().min(1).max(maximum).refine(
  (value) => !/[\p{Cc}\p{Cf}]/u.test(value),
  "Display text must not contain control or formatting characters.",
);

export const effectiveRuntimeAppSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: safeDisplayString(320),
  pluginDisplayNames: z.array(safeDisplayString(320)).max(100),
}).strict().superRefine((value, context) => {
  if (!canonicalStrings(value.pluginDisplayNames)) {
    context.addIssue({ code: "custom", message: "Plugin display names must be unique and canonically ordered." });
  }
});

export const effectiveRuntimeProfileSchema = z.object({
  profileId: profileIdSchema,
  processGeneration: z.number().int().nonnegative(),
  observedAt: unixMillisecondsSchema,
  preset: presetSchema,
  model: z.string().trim().min(1).max(200),
  reasoningEffort: z.enum(["max", "ultra"]),
  serviceTier: z.literal("priority").nullable(),
  fast: z.boolean(),
  approvalPolicy: z.literal("on-request"),
  reviewMode: z.literal("auto_review"),
  permissionProfile: z.literal(":workspace"),
  computerUse: z.literal(true),
  pluginCapability: z.literal(true),
  enabledApps: z.array(effectiveRuntimeAppSchema).max(100),
}).strict().superRefine((value, context) => {
  const requirement = presetRequirements[value.preset];
  if (value.model !== requirement.model || value.reasoningEffort !== requirement.effort) {
    context.addIssue({ code: "custom", message: "The effective model and reasoning effort must match the exact HRA preset." });
  }
  if ((value.fast && value.serviceTier !== "priority") || (!value.fast && value.serviceTier !== null)) {
    context.addIssue({ code: "custom", message: "Fast mode and the effective service tier are incoherent." });
  }
  if (!canonicalStrings(value.enabledApps.map((app) => app.id))) {
    context.addIssue({ code: "custom", message: "Enabled apps must have unique, canonically ordered identities." });
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 240 * 1024) {
    context.addIssue({ code: "custom", message: "The effective runtime profile exceeds its durable byte limit." });
  }
});

export type EffectiveRuntimeApp = z.infer<typeof effectiveRuntimeAppSchema>;
export type EffectiveRuntimeProfile = z.infer<typeof effectiveRuntimeProfileSchema>;
