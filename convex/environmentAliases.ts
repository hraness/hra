/**
 * Forward `OOMPA_*` names resolve before their legacy `HRA_*` aliases. Both
 * may be present during the rename only when byte-identical; a contradictory
 * pair refuses before any effect so a stale deployment value cannot win silently.
 */
export function legacyEnvironmentName(forwardName: string): string {
  if (!forwardName.startsWith("OOMPA_")) throw new Error("Only OOMPA_ names carry a legacy alias.");
  return `HRA_${forwardName.slice("OOMPA_".length)}`;
}

export function readAliasedEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  forwardName: string,
): string | undefined {
  const legacyName = legacyEnvironmentName(forwardName);
  const forward = environment[forwardName];
  const legacy = environment[legacyName];
  if (forward !== undefined && legacy !== undefined && forward !== legacy) {
    throw new Error(`${forwardName} and ${legacyName} must be byte-identical when both are set.`);
  }
  return forward ?? legacy;
}
