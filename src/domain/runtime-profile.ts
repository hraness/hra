import { z } from "zod";

import {
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

const currentEffectiveClaudeRuntimeProfileSchema = z.object({
  ...effectiveClaudeRuntimeProfileFields,
  configHome: claudeConfigHomeSchema,
  outputFormat: z.literal("stream-json"),
  inputFormat: z.literal("stream-json"),
}).strict();

// Runtime-profile rows are immutable evidence. Keep accepting the exact
// legacy shape so its stored JSON and digest remain byte-stable; new reviews
// always write `configHome` instead.
const legacyEffectiveClaudeRuntimeProfileSchema = z.object({
  ...effectiveClaudeRuntimeProfileFields,
  isolatedConfigDir: z.literal(true),
  outputFormat: z.literal("stream-json"),
  inputFormat: z.literal("stream-json"),
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
 * The reviewed runtime profile one session-start, turn-start, or queue-start
 * effect proved, for either provider.
 *
 * The two provider documents are stored exactly as their provider reviewed
 * them rather than inside a `{provider, profile}` wrapper: both are `.strict()`
 * objects with disjoint required keys (`approvalPolicy`/`permissionProfile`
 * against `claudeVersion`/`permissionMode`), so exactly one member can ever
 * match, and every Codex row and receipt written before Claude existed still
 * parses and re-serialises byte for byte. `session_runtime_profiles` and
 * `session_turn_runtime_profiles` already carry the three columns both
 * documents share (`profile_id`, `process_generation`, `observed_at`), so the
 * widening needs no new column and no schema version.
 */
export const reviewedRuntimeProfileSchema = z.union([
  effectiveRuntimeProfileSchema,
  effectiveClaudeRuntimeProfileSchema,
]);

export type ReviewedRuntimeProfile = EffectiveRuntimeProfile | EffectiveClaudeRuntimeProfile;

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
}).strict().superRefine((value, context) => {
  if (value.model !== presetRequirements[value.preset].model) {
    context.addIssue({ code: "custom", message: "The effective model must match the exact HRA preset." });
  }
});

export const publicReviewedRuntimeProfileSchema = z.union([
  effectiveRuntimeProfileSchema,
  publicEffectiveClaudeRuntimeProfileSchema,
]);

export type PublicReviewedRuntimeProfile = z.infer<typeof publicReviewedRuntimeProfileSchema>;

export const projectPublicReviewedRuntimeProfile = (
  profile: ReviewedRuntimeProfile,
): PublicReviewedRuntimeProfile => {
  const reviewed = reviewedRuntimeProfileSchema.parse(profile);
  if ("configHome" in reviewed || "isolatedConfigDir" in reviewed) {
    const publicProfile: Record<string, unknown> = { ...reviewed };
    delete publicProfile.configHome;
    delete publicProfile.isolatedConfigDir;
    return publicEffectiveClaudeRuntimeProfileSchema.parse(publicProfile);
  }
  return effectiveRuntimeProfileSchema.parse(reviewed);
};

/** The provider a reviewed profile belongs to, read from its exact preset. */
export const reviewedRuntimeProfileProvider = (
  profile: ReviewedRuntimeProfile,
): Provider => presetProviders[profile.preset];

/** True only for the Codex document, which is the one that carries fast mode. */
export const isCodexRuntimeProfile = (
  profile: ReviewedRuntimeProfile,
): profile is EffectiveRuntimeProfile => reviewedRuntimeProfileProvider(profile) === "codex";
