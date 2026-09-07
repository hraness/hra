import { z } from "zod";

import {
  presetContractSchema,
  presetSchema,
  providerSchema,
} from "./presets";

/**
 * Immutable historical identities, not selectors or capability receipts.
 * Recognizing a key grants no permission to start or continue a provider
 * effect. Fresh selection, established-session authority, and exact live
 * capabilities remain separate checks in their existing owners.
 */
export const canonicalProfileKeySchema = z.enum([
  "codex:gpt-5.6-luna:max",
  "codex:gpt-5.6-sol:max",
  "codex:gpt-5.6-sol:ultra",
  "codex:gpt-6-astra:max",
  "codex:gpt-6-astra:ultra",
  "claude:claude-fable-5-1:max",
  "devin:gpt-6-astra:provider-default",
]);
export type CanonicalProfileKey = z.infer<typeof canonicalProfileKeySchema>;

export const canonicalProfileCatalog = Object.freeze([
  Object.freeze({ key: "codex:gpt-5.6-luna:max", provider: "codex", model: "gpt-5.6-luna", effort: "max" }),
  Object.freeze({ key: "codex:gpt-5.6-sol:max", provider: "codex", model: "gpt-5.6-sol", effort: "max" }),
  Object.freeze({ key: "codex:gpt-5.6-sol:ultra", provider: "codex", model: "gpt-5.6-sol", effort: "ultra" }),
  Object.freeze({ key: "codex:gpt-6-astra:max", provider: "codex", model: "gpt-6-astra", effort: "max" }),
  Object.freeze({ key: "codex:gpt-6-astra:ultra", provider: "codex", model: "gpt-6-astra", effort: "ultra" }),
  Object.freeze({ key: "claude:claude-fable-5-1:max", provider: "claude", model: "claude-fable-5-1", effort: "max" }),
  // Retired-provider provenance remains decodable, never executable.
  Object.freeze({ key: "devin:gpt-6-astra:provider-default", provider: "devin", model: "gpt-6-astra", effort: "provider-default" }),
] as const);
export type CanonicalProfile = (typeof canonicalProfileCatalog)[number];

// These two contracts are frozen provenance, not active alias preferences.
// Keep the identical Low/Fable tuples shared without collapsing Sol/Astra.
const historicalPresetKeys = Object.freeze({
  1: Object.freeze({
    low: "codex:gpt-5.6-luna:max",
    high: "codex:gpt-5.6-sol:max",
    ultra: "codex:gpt-5.6-sol:ultra",
    "fable-max": "claude:claude-fable-5-1:max",
    astra: null,
  }),
  2: Object.freeze({
    low: "codex:gpt-5.6-luna:max",
    high: "codex:gpt-6-astra:max",
    ultra: "codex:gpt-6-astra:ultra",
    "fable-max": "claude:claude-fable-5-1:max",
    astra: "devin:gpt-6-astra:provider-default",
  }),
} as const satisfies Readonly<Record<
  z.infer<typeof presetContractSchema>,
  Readonly<Record<z.infer<typeof presetSchema>, CanonicalProfileKey | null>>
>>);

const historicalTupleSchema = z.object({
  provider: providerSchema,
  model: z.enum(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-6-astra", "claude-fable-5-1"]),
  effort: z.enum(["max", "ultra", "provider-default"]),
}).strict();

const historicalPresetSchema = z.object({
  provider: providerSchema,
  preset: presetSchema,
  contract: presetContractSchema,
}).strict();

/**
 * Snapshot exactly the expected own enumerable scalar data properties.
 * Accessors are never invoked, and nested objects never reach schema parsing.
 * Proxy traps may run while inspecting an object; thrown traps (including
 * revoked proxies) fail closed instead of escaping a decoder.
 */
const snapshotFields = (
  input: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> | null => {
  if (input === null || typeof input !== "object") return null;
  try {
    const prototype: unknown = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(input);
    if (keys.length !== fields.length || fields.some((field) => !keys.includes(field))) return null;
    const snapshot: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(input, field);
      if (
        descriptor === undefined
        || !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true
      ) return null;
      const value: unknown = descriptor.value;
      if (typeof value !== "string" && typeof value !== "number") return null;
      snapshot[field] = value;
    }
    return snapshot;
  } catch {
    return null;
  }
};

/** Decode only an exact scalar historical key; no coercion or default. */
export const decodeHistoricalProfileKey = (input: unknown): CanonicalProfile | null => {
  if (typeof input !== "string") return null;
  return canonicalProfileCatalog.find((profile) => profile.key === input) ?? null;
};

/** Decode a complete historical tuple without inferring provider or effort. */
export const decodeHistoricalProfileTuple = (input: unknown): CanonicalProfile | null => {
  const snapshot = snapshotFields(input, ["provider", "model", "effort"]);
  const parsed = historicalTupleSchema.safeParse(snapshot);
  if (!parsed.success) return null;
  return canonicalProfileCatalog.find((profile) =>
    profile.provider === parsed.data.provider
    && profile.model === parsed.data.model
    && profile.effort === parsed.data.effort) ?? null;
};

/** Decode a row's own frozen provider/alias/contract, never active defaults. */
export const decodeHistoricalPresetProfile = (input: unknown): CanonicalProfile | null => {
  const snapshot = snapshotFields(input, ["provider", "preset", "contract"]);
  const parsed = historicalPresetSchema.safeParse(snapshot);
  if (!parsed.success) return null;
  const key = historicalPresetKeys[parsed.data.contract][parsed.data.preset];
  const profile = decodeHistoricalProfileKey(key);
  return profile?.provider === parsed.data.provider ? profile : null;
};
