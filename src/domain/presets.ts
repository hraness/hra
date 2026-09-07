import { z } from "zod";

/** Historical provider identities. Retired providers remain readable, never executable. */
export const providerSchema = z.enum(["codex", "claude", "devin"]);
export type Provider = z.infer<typeof providerSchema>;

/** Providers whose existing personal-home sessions HRA can adopt. */
export const adoptableProviderSchema = z.enum(["codex", "claude"]);
export type AdoptableProvider = z.infer<typeof adoptableProviderSchema>;

/** Providers admitted for new effects. Do not use historical schemas for admission. */
export const supportedProviderSchema = z.enum(["codex", "claude"]);
export type SupportedProvider = z.infer<typeof supportedProviderSchema>;

export const DEFAULT_PROVIDER = "codex" satisfies SupportedProvider;

/** Historical aliases, including those found only in retired provider records. */
export const presetSchema = z.enum(["low", "high", "ultra", "fable-max", "astra"]);
export type Preset = z.infer<typeof presetSchema>;
export const supportedPresetSchema = z.enum(["low", "high", "ultra", "fable-max"]);
export type SupportedPreset = z.infer<typeof supportedPresetSchema>;

export const isSupportedProvider = (provider: Provider): provider is SupportedProvider =>
  supportedProviderSchema.safeParse(provider).success;

export const isSupportedPreset = (preset: Preset): preset is SupportedPreset =>
  supportedPresetSchema.safeParse(preset).success;

export function assertSupportedProvider(provider: Provider): asserts provider is SupportedProvider {
  if (!isSupportedProvider(provider)) throw new Error(`PROVIDER_RETIRED:${provider}`);
}

/**
 * The durable storage encoding of a preset. `sessions.preset` and
 * `daemon_state.default_preset` predate multi-provider presets and enforce
 * this closed set in SQLite; a preset is therefore stored as its provider plus
 * its tier and reassembled on read. Every tier/provider pair that names a real
 * preset appears in `presetsByProviderTier`.
 */
export const presetTierSchema = z.enum(["low", "high", "ultra"]);
export type PresetTier = z.infer<typeof presetTierSchema>;

/**
 * The durable interpretation of a stored preset alias.
 *
 * Contract 1 is the original Sol mapping. Contract 2 is the later Astra
 * mapping. Both integers are stored in SQLite, so never renumber or
 * reinterpret either contract. The active selection for a preset is separate
 * from this frozen history and can return to an older contract.
 */
export const legacyPresetContract = 1 as const;
export const currentPresetContract = 2 as const;
/** Semantic names for active choices; historical aliases remain API-compatible. */
export const solCodexPresetContract = legacyPresetContract;
export const astraPresetContract = currentPresetContract;
export const devinPresetContract = astraPresetContract;
export const presetContractSchema = z.union([
  z.literal(legacyPresetContract),
  z.literal(currentPresetContract),
]);
export type PresetContract = z.infer<typeof presetContractSchema>;

export type PresetRequirement = Readonly<{
  model: string;
  effort: "max" | "ultra" | "provider-default";
}>;

const legacyPresetRequirements = {
  low: { model: "gpt-5.6-luna", effort: "max" },
  high: { model: "gpt-5.6-sol", effort: "max" },
  ultra: { model: "gpt-5.6-sol", effort: "ultra" },
  "fable-max": { model: "claude-fable-5-1", effort: "max" },
} as const satisfies Partial<Record<Preset, PresetRequirement>>;

const currentPresetRequirements = {
  low: { model: "gpt-5.6-luna", effort: "max" },
  high: { model: "gpt-6-astra", effort: "max" },
  ultra: { model: "gpt-6-astra", effort: "ultra" },
  // The local Fable model id measured for the pinned Claude Code release. It
  // is spelled here rather than imported because `src/domain` is the leaf
  // layer; `src/claude/pin.test.ts` proves the two stay equal.
  "fable-max": { model: "claude-fable-5-1", effort: "max" },
  // Retained only to decode the exact runtime tuple already stored by v39.
  astra: { model: "gpt-6-astra", effort: "provider-default" },
} as const satisfies Record<Preset, PresetRequirement>;

const presetRequirementsByContract: Readonly<
  Record<PresetContract, Partial<Readonly<Record<Preset, PresetRequirement>>>>
> = Object.freeze({
  [legacyPresetContract]: Object.freeze(legacyPresetRequirements),
  [currentPresetContract]: Object.freeze(currentPresetRequirements),
});

type ActivePresetBinding = Readonly<{
  contract: PresetContract;
  requirement: PresetRequirement;
}>;

/**
 * One atomic, exhaustive binding for a new or explicitly selected preset.
 *
 * Codex High and Ultra select their immutable Sol meanings from contract 1.
 * Low and Fable are byte-identical across both contracts, so they remain on
 * contract 2 to minimize durable churn. The Astra entry exists only so exact
 * historical records can be decoded; effect admission must first pass the
 * supported provider and preset schemas.
 */
const activePresetBindings = Object.freeze({
  low: Object.freeze({
    contract: astraPresetContract,
    requirement: currentPresetRequirements.low,
  }),
  high: Object.freeze({
    contract: solCodexPresetContract,
    requirement: legacyPresetRequirements.high,
  }),
  ultra: Object.freeze({
    contract: solCodexPresetContract,
    requirement: legacyPresetRequirements.ultra,
  }),
  "fable-max": Object.freeze({
    contract: astraPresetContract,
    requirement: currentPresetRequirements["fable-max"],
  }),
  astra: Object.freeze({
    contract: devinPresetContract,
    requirement: currentPresetRequirements.astra,
  }),
} as const satisfies Readonly<Record<Preset, ActivePresetBinding>>);

export const activePresetBinding = <P extends Preset>(
  preset: P,
): (typeof activePresetBindings)[P] => activePresetBindings[preset];

export const isReboundCodexPreset = (
  preset: Preset | undefined,
): preset is "high" | "ultra" => preset === "high" || preset === "ultra";

/**
 * Whether a provider-switch request can select one of the mutable Codex
 * aliases. An omitted Codex preset is source-sensitive because the daemon
 * derives the target tier from session state that the caller cannot inspect
 * atomically with dispatch.
 */
export const providerSwitchRequiresPresetContract = (
  provider: Provider,
  preset: Preset | undefined,
): boolean => provider === "codex"
  && (preset === undefined || isReboundCodexPreset(preset));

const activeReboundCodexPresetContract = (preset: "high" | "ultra"): PresetContract =>
  activePresetBinding(preset).contract;

/**
 * The one active contract shared by Codex High and Ultra wherever a boundary
 * can select either alias without observing which tier will win. Keep the
 * equality check centralized so every such boundary fails closed if those
 * aliases ever stop sharing one interpretation.
 */
export const sharedActiveCodexPresetContract = (): PresetContract => {
  const high = activeReboundCodexPresetContract("high");
  const ultra = activeReboundCodexPresetContract("ultra");
  if (high !== ultra) {
    throw new Error("Implicit Codex preset selection requires High and Ultra to share one active contract.");
  }
  return high;
};

/**
 * Requirements exposed to runtime readers. Supported aliases use their active
 * bindings; Astra retains only its exact historical tuple.
 */
export const presetRequirements = Object.freeze({
  low: activePresetBindings.low.requirement,
  high: activePresetBindings.high.requirement,
  ultra: activePresetBindings.ultra.requirement,
  "fable-max": activePresetBindings["fable-max"].requirement,
  astra: activePresetBindings.astra.requirement,
} as const satisfies Readonly<Record<Preset, PresetRequirement>>);

type ContractRequirement<P extends Preset, C extends PresetContract> =
  C extends typeof currentPresetContract
    ? PresetRequirement
    : P extends "astra" ? undefined : PresetRequirement;

/** Resolve one alias under its durable, session-owned interpretation. */
export const presetRequirementForContract = <
  P extends Preset,
  C extends PresetContract,
>(preset: P, contract: C): ContractRequirement<P, C> =>
  presetRequirementsByContract[contract][preset] as ContractRequirement<P, C>;

/**
 * Historical runtime documents remain admissible only when they carry one of
 * the exact tuples HRA has shipped for that alias.
 */
export const isAdmittedPresetRequirement = (
  preset: Preset,
  requirement: PresetRequirement,
): boolean => [legacyPresetContract, currentPresetContract].some((contract) => {
  const admitted = presetRequirementsByContract[contract][preset];
  return admitted !== undefined
    && admitted.model === requirement.model
    && admitted.effort === requirement.effort;
});

export const presetProviders = {
  low: "codex",
  high: "codex",
  ultra: "codex",
  "fable-max": "claude",
  astra: "devin",
} as const satisfies Record<Preset, Provider>;

/** The presets a given provider owns, as a type. */
export type ProviderPreset<P extends Provider> = {
  [K in Preset]: (typeof presetProviders)[K] extends P ? K : never;
}[Preset];

const defaultPresetsByProvider = {
  claude: "fable-max",
  codex: "ultra",
  devin: "astra",
} as const satisfies { readonly [P in Provider]: ProviderPreset<P> };

/** Historical default mapping; new sessions must first admit a supported provider. */
export const defaultPresetForProvider = <P extends Provider>(
  provider: P,
): (typeof defaultPresetsByProvider)[P] => defaultPresetsByProvider[provider];

export const presetTiers = {
  low: "low",
  high: "high",
  ultra: "ultra",
  "fable-max": "ultra",
  astra: "ultra",
} as const satisfies Record<Preset, PresetTier>;

const presetsByProviderTier: Readonly<
  Record<Provider, Partial<Readonly<Record<PresetTier, Preset>>>>
> = Object.freeze({
  claude: Object.freeze({ ultra: "fable-max" }),
  codex: Object.freeze({ high: "high", low: "low", ultra: "ultra" }),
  devin: Object.freeze({ ultra: "astra" }),
});

/** Historically mapped presets, in declaration order; not an admission check. */
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
