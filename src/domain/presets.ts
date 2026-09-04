import { z } from "zod";

/** Every provider HRA can drive. A session binds exactly one for its life. */
export const providerSchema = z.enum(["codex", "claude"]);
export type Provider = z.infer<typeof providerSchema>;

export const DEFAULT_PROVIDER = "codex" satisfies Provider;

export const presetSchema = z.enum(["low", "high", "ultra", "fable-max"]);
export type Preset = z.infer<typeof presetSchema>;

/**
 * The durable storage encoding of a preset. `sessions.preset` and
 * `daemon_state.default_preset` predate multi-provider presets and enforce
 * this closed set in SQLite; a preset is therefore stored as its provider plus
 * its tier and reassembled on read. Every tier/provider pair that names a real
 * preset appears in `presetsByProviderTier`.
 */
export const presetTierSchema = z.enum(["low", "high", "ultra"]);
export type PresetTier = z.infer<typeof presetTierSchema>;

export const presetRequirements = {
  low: { model: "gpt-5.6-luna", effort: "max" },
  high: { model: "gpt-5.6-sol", effort: "max" },
  ultra: { model: "gpt-5.6-sol", effort: "ultra" },
  // The local Fable model id measured for the pinned Claude Code release. It
  // is spelled here rather than imported because `src/domain` is the leaf
  // layer; `src/claude/pin.test.ts` proves the two stay equal.
  "fable-max": { model: "claude-fable-5-1", effort: "max" },
} as const satisfies Record<Preset, { readonly model: string; readonly effort: string }>;

export const presetProviders = {
  low: "codex",
  high: "codex",
  ultra: "codex",
  "fable-max": "claude",
} as const satisfies Record<Preset, Provider>;

export const presetTiers = {
  low: "low",
  high: "high",
  ultra: "ultra",
  "fable-max": "ultra",
} as const satisfies Record<Preset, PresetTier>;

const presetsByProviderTier: Readonly<
  Record<Provider, Partial<Readonly<Record<PresetTier, Preset>>>>
> = Object.freeze({
  claude: Object.freeze({ ultra: "fable-max" }),
  codex: Object.freeze({ high: "high", low: "low", ultra: "ultra" }),
});

/** Presets a provider supports, in the union's declaration order. */
export const presetsForProvider = (provider: Provider): readonly Preset[] =>
  presetSchema.options.filter((preset) => presetProviders[preset] === provider);

export class PresetProviderMismatchError extends Error {
  readonly provider: Provider;
  readonly preset: Preset;

  constructor(provider: Provider, preset: Preset) {
    super(
      `The ${provider} provider does not support the \`${preset}\` model preset. `
      + `Supported presets: ${presetsForProvider(provider).join(", ")}.`,
    );
    this.name = "PresetProviderMismatchError";
    this.provider = provider;
    this.preset = preset;
  }
}

/** The presets a given provider owns, as a type. */
export type ProviderPreset<P extends Provider> = {
  [K in Preset]: (typeof presetProviders)[K] extends P ? K : never;
}[Preset];

/** Refuses a preset the session's provider cannot run, never ignores it. */
export function assertPresetSupportedByProvider<P extends Provider>(
  provider: P,
  preset: Preset,
): asserts preset is ProviderPreset<P> {
  if (presetProviders[preset] !== provider) {
    throw new PresetProviderMismatchError(provider, preset);
  }
}

/** The refusal as a value, for callers that classify instead of throwing. */
export const isPresetSupportedByProvider = (provider: Provider, preset: Preset): boolean =>
  presetProviders[preset] === provider;

/** Reassembles the preset a stored provider and tier name. */
export const presetForProviderTier = (provider: Provider, tier: PresetTier): Preset => {
  const preset = presetsByProviderTier[provider][tier];
  if (preset === undefined) {
    throw new Error(
      `No ${provider} model preset exists for the \`${tier}\` tier. `
      + `Supported presets: ${presetsForProvider(provider).join(", ")}.`,
    );
  }
  return preset;
};
