import { z } from "zod";

import { usageProviderSchema, type UsageProvider } from "./provider-usage";
import {
  automaticUsagePolicyConfigurationSchema,
  resolveAutomaticUsagePolicy,
} from "./usage-policy";

const effectiveAutomaticUsagePolicySchema = z.object({
  provider: usageProviderSchema,
  enabled: z.boolean(),
  source: z.enum(["default", "override"]),
  automaticPolicyRevision: automaticUsagePolicyConfigurationSchema.shape.automaticPolicyRevision,
}).strict().readonly();

/** A status snapshot or saved mutation receipt, never a promise of the current head. */
export const automaticUsagePolicyCommandResultSchema = z.object({
  version: z.literal(1),
  configuration: automaticUsagePolicyConfigurationSchema.extend({
    overrides: automaticUsagePolicyConfigurationSchema.shape.overrides.readonly(),
  }).readonly(),
  effective: z.array(effectiveAutomaticUsagePolicySchema).min(1).max(2).readonly(),
}).strict().superRefine((result, context) => {
  if (result.effective.length === 2
    && (result.effective[0]?.provider !== "codex" || result.effective[1]?.provider !== "claude")) {
    context.addIssue({
      code: "custom", path: ["effective"],
      message: "Unfiltered automatic usage policy must contain Codex then Claude exactly once.",
    });
  }
  for (const [index, effective] of result.effective.entries()) {
    // Zod may refine values with continuable bound errors. Do not invoke a
    // throwing parser here: safeParse must still return a closed failure.
    const override = result.configuration.overrides[effective.provider];
    const enabled = override === "inherit" ? result.configuration.defaultEnabled : override === "on";
    const source = override === "inherit" ? "default" : "override";
    if (effective.enabled !== enabled || effective.source !== source
      || effective.automaticPolicyRevision !== result.configuration.automaticPolicyRevision) {
      context.addIssue({
        code: "custom", path: ["effective", index],
        message: "Effective automatic usage policy must match its configuration.",
      });
    }
  }
}).readonly();

export type AutomaticUsagePolicyCommandResult = z.infer<
  typeof automaticUsagePolicyCommandResultSchema
>;

export function createAutomaticUsagePolicyCommandResult(
  input: unknown,
  provider?: UsageProvider,
): AutomaticUsagePolicyCommandResult {
  // Parsing detaches the receipt from the caller's mutable state. There is no
  // later configuration callback that could mix revisions within one result.
  const configuration = automaticUsagePolicyConfigurationSchema.parse(input);
  Object.freeze(configuration.overrides);
  Object.freeze(configuration);
  const providers: readonly UsageProvider[] = provider === undefined
    ? ["codex", "claude"] : [usageProviderSchema.parse(provider)];
  return Object.freeze({
    version: 1,
    configuration,
    effective: Object.freeze(providers.map((selected) => Object.freeze(
      resolveAutomaticUsagePolicy({ configuration, provider: selected }),
    ))),
  });
}
