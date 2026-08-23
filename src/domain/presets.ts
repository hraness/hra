import { z } from "zod";

export const presetSchema = z.enum(["low", "high", "ultra"]);
export type Preset = z.infer<typeof presetSchema>;

export const presetRequirements = {
  low: { model: "gpt-5.6-luna", effort: "max" },
  high: { model: "gpt-5.6-sol", effort: "max" },
  ultra: { model: "gpt-5.6-sol", effort: "ultra" },
} as const satisfies Record<Preset, { readonly model: string; readonly effort: string }>;
