export type RenamedEnvironmentValue =
  | Readonly<{ state: "missing" }>
  | Readonly<{
      state: "value";
      source: "canonical" | "legacy" | "both";
      value: string;
    }>
  | Readonly<{ state: "conflicting" }>;

type Environment = Readonly<Record<string, string | undefined>>;

function nonempty(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

/**
 * Reads an `HRA_*` setting with its exact pre-rename `OPRTE_*` alias. The
 * older `KITCHEN_*` spelling remains input-only compatibility for machines
 * that crossed both product renames. Empty values are absent; duplicate equal
 * values are safe; disagreement is represented without retaining any
 * potentially sensitive value.
 */
export function renamedEnvironmentValue(
  environment: Environment,
  canonicalName: `HRA_${string}`,
): RenamedEnvironmentValue {
  const suffix = canonicalName.slice("HRA_".length);
  const legacyName = `OPRTE_${suffix}`;
  const predecessorName = `KITCHEN_${suffix}`;
  const canonical = nonempty(environment[canonicalName]);
  const legacy = nonempty(environment[legacyName]);
  const predecessor = nonempty(environment[predecessorName]);
  const values = [canonical, legacy, predecessor].filter(
    (value): value is string => value !== undefined,
  );
  if (values.length === 0) return { state: "missing" };
  if (values.some((value) => value !== values[0])) {
    return { state: "conflicting" };
  }
  const value = values[0] as string;
  if (canonical !== undefined) {
    return {
      state: "value",
      source: legacy !== undefined || predecessor !== undefined ? "both" : "canonical",
      value,
    };
  }
  return { state: "value", source: "legacy", value };
}

export function optionalRenamedEnvironmentValue(
  environment: Environment,
  canonicalName: `HRA_${string}`,
): string | undefined {
  const result = renamedEnvironmentValue(environment, canonicalName);
  if (result.state === "conflicting") {
    throw new TypeError(`${canonicalName} conflicts with a legacy alias.`);
  }
  return result.state === "value" ? result.value : undefined;
}
