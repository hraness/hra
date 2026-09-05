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
 * version, and the fact that the runtime home is an isolated
 * `CLAUDE_CONFIG_DIR` rather than the user's own configuration.
 */
export const effectiveClaudeRuntimeProfileSchema = z.object({
  profileId: profileIdSchema,
  processGeneration: z.number().int().nonnegative(),
  observedAt: unixMillisecondsSchema,
  preset: z.literal("fable-max"),
  model: z.string().trim().min(1).max(200),
  reasoningEffort: z.literal("max"),
  claudeVersion: z.string().regex(/^\d{1,5}\.\d{1,5}\.\d{1,5}$/u),
  permissionMode: z.literal("default"),
  isolatedConfigDir: z.literal(true),
  outputFormat: z.literal("stream-json"),
  inputFormat: z.literal("stream-json"),
}).strict().superRefine((value, context) => {
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

/** The provider a reviewed profile belongs to, read from its exact preset. */
export const reviewedRuntimeProfileProvider = (
  profile: ReviewedRuntimeProfile,
): Provider => presetProviders[profile.preset];

/** True only for the Codex document, which is the one that carries fast mode. */
export const isCodexRuntimeProfile = (
  profile: ReviewedRuntimeProfile,
): profile is EffectiveRuntimeProfile => reviewedRuntimeProfileProvider(profile) === "codex";
