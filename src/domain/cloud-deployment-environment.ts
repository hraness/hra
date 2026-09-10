export type CloudDeploymentEnvironment = Readonly<{
  HRA_CONVEX_URL?: string;
  OOMPA_CONVEX_URL?: string;
}>;

export type CloudDeploymentEnvironmentResolution = Readonly<{
  environment: CloudDeploymentEnvironment;
  selection:
    | Readonly<{ kind: "absent" | "conflict" }>
    | Readonly<{ kind: "selected"; value: string }>;
}>;

export class CloudDeploymentAliasConflictError extends Error {
  constructor() {
    super("OOMPA_CONVEX_URL and HRA_CONVEX_URL must be byte-identical when both are set.");
    this.name = "CloudDeploymentAliasConflictError";
  }
}

/** Capture once without normalizing aliases or granting deployment authority. */
export function resolveCloudDeploymentEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): CloudDeploymentEnvironmentResolution {
  const forward = source.OOMPA_CONVEX_URL;
  const legacy = source.HRA_CONVEX_URL;
  const environment = Object.freeze({
    ...(legacy === undefined ? {} : { HRA_CONVEX_URL: legacy }),
    ...(forward === undefined ? {} : { OOMPA_CONVEX_URL: forward }),
  });
  const value = forward ?? legacy;
  return Object.freeze({
    environment,
    selection: Object.freeze(forward !== undefined && legacy !== undefined && forward !== legacy
      ? { kind: "conflict" as const }
      : value === undefined
        ? { kind: "absent" as const }
        : { kind: "selected" as const, value }),
  });
}

/** Require agreement only where an operation selects or starts new authority. */
export function requireCloudDeploymentEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): CloudDeploymentEnvironmentResolution {
  const resolved = resolveCloudDeploymentEnvironment(source);
  if (resolved.selection.kind === "conflict") throw new CloudDeploymentAliasConflictError();
  return resolved;
}
