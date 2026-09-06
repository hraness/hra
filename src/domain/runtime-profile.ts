import { z } from "zod";

import {
  isAdmittedPresetRequirement,
  presetProviders,
  presetRequirements,
  presetSchema,
  type Provider,
} from "./presets";
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
  if (presetProviders[value.preset] !== "codex") {
    context.addIssue({ code: "custom", message: "A Codex runtime profile cannot carry another provider's model preset." });
  }
  if (!isAdmittedPresetRequirement(value.preset, {
    model: value.model,
    effort: value.reasoningEffort,
  })) {
    context.addIssue({ code: "custom", message: "The effective model and reasoning effort must match an admitted exact HRA preset." });
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

/**
 * The reviewed profile HRA proves before it lets the pinned Claude Code
 * runtime start a session or a turn. Claude Code owns its own permission
 * engine, so the profile pins the interactive permission mode (every tool use
 * reaches HRA as a `can_use_tool` control request), the exact pinned CLI
 * version, and which reviewed `CLAUDE_CONFIG_DIR` authority it uses. Managed
 * sessions use an isolated account home; adopted sessions use the explicitly
 * bound personal home without pretending that it is isolated.
 */
const effectiveClaudeRuntimeProfileFields = {
  profileId: profileIdSchema,
  processGeneration: z.number().int().nonnegative(),
  observedAt: unixMillisecondsSchema,
  preset: z.literal("fable-max"),
  model: z.string().trim().min(1).max(200),
  reasoningEffort: z.literal("max"),
  claudeVersion: z.string().regex(/^\d{1,5}\.\d{1,5}\.\d{1,5}$/u),
  permissionMode: z.literal("default"),
} as const;

export const claudeConfigHomeSchema = z.enum(["isolated", "personal"]);
export type ClaudeConfigHome = z.infer<typeof claudeConfigHomeSchema>;

const claudeNativeFallbackSchema = z.discriminatedUnion("status", [
  z.object({
    evidenceDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    model: z.literal("claude-opus-5"),
    status: z.literal("armed"),
  }).strict(),
  z.object({
    model: z.literal("claude-opus-5"),
    reason: z.literal("live_acceptance_required"),
    status: z.literal("unavailable"),
  }).strict(),
]);

const currentEffectiveClaudeRuntimeProfileSchema = z.object({
  ...effectiveClaudeRuntimeProfileFields,
  configHome: claudeConfigHomeSchema,
  outputFormat: z.literal("stream-json"),
  inputFormat: z.literal("stream-json"),
  nativeFallback: claudeNativeFallbackSchema.optional(),
}).strict();

// Runtime-profile rows are immutable evidence. Keep accepting the exact
// legacy shape so its stored JSON and digest remain byte-stable; new reviews
// always write `configHome` instead.
const legacyEffectiveClaudeRuntimeProfileSchema = z.object({
  ...effectiveClaudeRuntimeProfileFields,
  isolatedConfigDir: z.literal(true),
  outputFormat: z.literal("stream-json"),
  inputFormat: z.literal("stream-json"),
  nativeFallback: claudeNativeFallbackSchema.optional(),
}).strict();

export const effectiveClaudeRuntimeProfileSchema = z.union([
  currentEffectiveClaudeRuntimeProfileSchema,
  legacyEffectiveClaudeRuntimeProfileSchema,
]).superRefine((value, context) => {
  if (value.model !== presetRequirements[value.preset].model) {
    context.addIssue({ code: "custom", message: "The effective model must match the exact HRA preset." });
  }
});

export type EffectiveClaudeRuntimeProfile = z.infer<typeof effectiveClaudeRuntimeProfileSchema>;

/**
 * The exact local Devin ACP profile HRA admits. The pinned CLI owns its
 * authentication and model defaults inside the isolated home; HRA records
 * only the public runtime/protocol facts it proved before dispatch.
 */
const effectiveDevinRuntimeProfileFields = {
  profileId: profileIdSchema,
  processGeneration: z.number().int().nonnegative(),
  observedAt: unixMillisecondsSchema,
  preset: z.literal("astra"),
  model: z.string().trim().min(1).max(200),
  reasoningEffort: z.literal("provider-default"),
  devinVersion: z.literal("3000.6.14"),
  protocolVersion: z.literal(1),
} as const;

export const effectiveDevinRuntimeProfileSchema = z.object({
  ...effectiveDevinRuntimeProfileFields,
  isolatedHome: z.literal(true),
}).strict().superRefine((value, context) => {
  if (!isAdmittedPresetRequirement(value.preset, {
    effort: value.reasoningEffort,
    model: value.model,
  })) {
    context.addIssue({
      code: "custom",
      message: "The effective model and reasoning effort must match Devin's exact current HRA preset.",
    });
  }
});

export type EffectiveDevinRuntimeProfile = z.infer<typeof effectiveDevinRuntimeProfileSchema>;

/**
 * The reviewed runtime profile one session-start, turn-start, or queue-start
 * effect proved, for one provider.
 *
 * Provider documents are stored exactly as their provider reviewed them
 * rather than inside a `{provider, profile}` wrapper. Every member is a
 * `.strict()` object with a provider-owned discriminator (`approvalPolicy`,
 * `claudeVersion`, or `devinVersion`), so exactly one member can match and
 * every pre-existing Codex or Claude row still parses and re-serialises byte
 * for byte. `session_runtime_profiles` and
 * `session_turn_runtime_profiles` already carry the three columns all
 * documents share (`profile_id`, `process_generation`, `observed_at`), so the
 * widening needs no new column and no schema version.
 */
export const reviewedRuntimeProfileSchema = z.union([
  effectiveRuntimeProfileSchema,
  effectiveClaudeRuntimeProfileSchema,
  effectiveDevinRuntimeProfileSchema,
]);

export type ReviewedRuntimeProfile =
  | EffectiveRuntimeProfile
  | EffectiveClaudeRuntimeProfile
  | EffectiveDevinRuntimeProfile;

/**
 * Public runtime evidence intentionally omits which Claude config home owns
 * the process. That field is required private custody evidence, but exposing
 * `personal` versus `isolated` would distinguish adopted sessions from native
 * ones. The legacy isolation marker is provenance for the same reason.
 */
export const publicEffectiveClaudeRuntimeProfileSchema = z.object({
  ...effectiveClaudeRuntimeProfileFields,
  outputFormat: z.literal("stream-json"),
  inputFormat: z.literal("stream-json"),
  nativeFallback: claudeNativeFallbackSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.model !== presetRequirements[value.preset].model) {
    context.addIssue({ code: "custom", message: "The effective model must match the exact HRA preset." });
  }
});

/** Public Devin evidence omits the private isolated-home custody marker. */
export const publicEffectiveDevinRuntimeProfileSchema = z.object({
  ...effectiveDevinRuntimeProfileFields,
}).strict().superRefine((value, context) => {
  if (!isAdmittedPresetRequirement(value.preset, {
    effort: value.reasoningEffort,
    model: value.model,
  })) {
    context.addIssue({
      code: "custom",
      message: "The effective model and reasoning effort must match Devin's exact current HRA preset.",
    });
  }
});

export const publicReviewedRuntimeProfileSchema = z.union([
  effectiveRuntimeProfileSchema,
  publicEffectiveClaudeRuntimeProfileSchema,
  publicEffectiveDevinRuntimeProfileSchema,
]);

export type PublicReviewedRuntimeProfile = z.infer<typeof publicReviewedRuntimeProfileSchema>;

export const projectPublicReviewedRuntimeProfile = (
  profile: ReviewedRuntimeProfile,
): PublicReviewedRuntimeProfile => {
  const reviewed = reviewedRuntimeProfileSchema.parse(profile);
  switch (reviewedRuntimeProfileProvider(reviewed)) {
    case "codex":
      return effectiveRuntimeProfileSchema.parse(reviewed);
    case "claude": {
      const publicProfile: Record<string, unknown> = { ...reviewed };
      delete publicProfile.configHome;
      delete publicProfile.isolatedConfigDir;
      return publicEffectiveClaudeRuntimeProfileSchema.parse(publicProfile);
    }
    case "devin": {
      const publicProfile: Record<string, unknown> = { ...reviewed };
      delete publicProfile.isolatedHome;
      return publicEffectiveDevinRuntimeProfileSchema.parse(publicProfile);
    }
  }
};

/** The provider a reviewed profile belongs to, read from its exact preset. */
export const reviewedRuntimeProfileProvider = (
  profile: ReviewedRuntimeProfile,
): Provider => presetProviders[profile.preset];

/** True only for the Codex document, which is the one that carries fast mode. */
export const isCodexRuntimeProfile = (
  profile: ReviewedRuntimeProfile,
): profile is EffectiveRuntimeProfile => reviewedRuntimeProfileProvider(profile) === "codex";

/** True only for the Devin ACP document. */
export const isDevinRuntimeProfile = (
  profile: ReviewedRuntimeProfile,
): profile is EffectiveDevinRuntimeProfile => reviewedRuntimeProfileProvider(profile) === "devin";
