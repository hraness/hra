export type HraEnvironmentValue =
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "value"; value: string }>;

/**
 * Resolve one renamed environment value without changing its bytes. The HRA
 * spelling is canonical, the OPRTE spelling is a deployment-compatibility
 * fallback, and a disagreement fails closed instead of choosing authority.
 */
export function resolveHraEnvironmentValue(
  hraValue: string | undefined,
  legacyOprteValue: string | undefined,
): HraEnvironmentValue {
  if (
    hraValue !== undefined &&
    legacyOprteValue !== undefined &&
    hraValue !== legacyOprteValue
  ) {
    return { kind: "conflict" };
  }
  const value = hraValue ?? legacyOprteValue;
  return value === undefined
    ? { kind: "missing" }
    : { kind: "value", value };
}

export type HraSessionSyncEnvironment = Readonly<{
  HRA_SESSION_SYNC_ENABLED?: string | undefined;
  OPRTE_SESSION_SYNC_ENABLED?: string | undefined;
}>;

export function hraSessionSyncEnabled(
  environment: HraSessionSyncEnvironment,
): boolean {
  const resolved = resolveHraEnvironmentValue(
    environment.HRA_SESSION_SYNC_ENABLED,
    environment.OPRTE_SESSION_SYNC_ENABLED,
  );
  return resolved.kind === "value" && resolved.value === "true";
}
