import type { CodexCapabilitySnapshot, ResolvedPreset } from "../codex/index";
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- D4 extracts the provider port; the capability check still recognises the Codex error class directly.
import { CodexError } from "../codex/index";
import { effectiveRuntimeProfileSchema, type EffectiveRuntimeProfile } from "../domain/runtime-profile";
import type { ProfileAuthority } from "./ports";

const REQUIRED_FEATURES = ["computer_use", "plugins"] as const;
const REQUIRED_PERMISSION_PROFILE = ":workspace";

const binaryCompare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const requireExactlyOne = <T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
  label: string,
): T => {
  const matches = values.filter(predicate);
  if (matches.length !== 1) {
    throw new CodexError(
      "UNSUPPORTED_CAPABILITY",
      `The active Codex generation must advertise exactly one ${label}.`,
    );
  }
  const match = matches.at(0);
  if (match === undefined) {
    throw new CodexError("PROTOCOL_ERROR", `The active Codex generation omitted ${label}.`);
  }
  return match;
};

/**
 * Compile the exact provider capabilities used by HRA's recommended
 * profile. This is an observation only: it never installs, enables, or grants
 * access to an app or plugin.
 */
export const compileEffectiveRuntimeProfile = (input: {
  authority: ProfileAuthority;
  capabilities: CodexCapabilitySnapshot;
  preset: ResolvedPreset;
  observedAt: number;
}): EffectiveRuntimeProfile => {
  if (!Number.isSafeInteger(input.observedAt) || input.observedAt < 0) {
    throw new CodexError("INVALID_INPUT", "Capability observation time must be a nonnegative safe integer.");
  }

  for (const required of REQUIRED_FEATURES) {
    const feature = requireExactlyOne(
      input.capabilities.features,
      (candidate) => candidate.name === required,
      `${required.replaceAll("_", " ")} feature`,
    );
    if (!feature.enabled || feature.stage !== "stable") {
      throw new CodexError(
        "UNSUPPORTED_CAPABILITY",
        `The active Codex generation does not advertise the stable enabled ${required.replaceAll("_", " ")} capability required by the recommended HRA profile.`,
      );
    }
  }

  if (input.capabilities.permissionProfiles === null) {
    throw new CodexError(
      "UNSUPPORTED_CAPABILITY",
      "The active Codex generation did not expose permission profiles for the selected project.",
    );
  }
  const permission = requireExactlyOne(
    input.capabilities.permissionProfiles,
    (candidate) => candidate.id === REQUIRED_PERMISSION_PROFILE,
    "workspace permission profile",
  );
  if (!permission.allowed) {
    throw new CodexError(
      "UNSUPPORTED_CAPABILITY",
      "The workspace permission profile is not allowed for the selected project.",
    );
  }

  if (input.capabilities.apps === null) {
    throw new CodexError(
      "UNSUPPORTED_CAPABILITY",
      "The active Codex generation did not expose its enabled app and plugin set.",
    );
  }
  const ids = new Set<string>();
  for (const app of input.capabilities.apps) {
    if (ids.has(app.id)) {
      throw new CodexError("PROTOCOL_ERROR", "The active Codex generation advertised a duplicate app identity.");
    }
    ids.add(app.id);
  }
  const enabledApps = input.capabilities.apps
    .filter((app) => app.isAccessible && app.isEnabled)
    .map((app) => ({
      id: app.id,
      name: app.name,
      pluginDisplayNames: [...new Set(app.pluginDisplayNames)].toSorted(binaryCompare),
    }))
    .toSorted((left, right) => binaryCompare(left.id, right.id));

  return effectiveRuntimeProfileSchema.parse({
    profileId: input.authority.id,
    processGeneration: input.authority.generation,
    observedAt: input.observedAt,
    preset: input.preset.alias,
    model: input.preset.model,
    reasoningEffort: input.preset.effort,
    serviceTier: input.preset.serviceTier,
    fast: input.preset.fast,
    approvalPolicy: "on-request",
    reviewMode: "auto_review",
    permissionProfile: ":workspace",
    computerUse: true,
    pluginCapability: true,
    enabledApps,
  });
};
