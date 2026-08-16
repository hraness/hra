export const nativeHarnessCustodyFailureStages = Object.freeze([
  "admission",
  "marker_read",
  "envelope_read",
  "legacy_read",
  "marker_prepare",
  "envelope_set_if_absent",
  "legacy_preservation_read",
  "marker_commit",
  "legacy_delete",
  "envelope_delete",
  "marker_delete",
  "reconciliation",
  "reporting",
] as const);

export const nativeLegacyHarnessCustodyFailureStages = Object.freeze([
  "legacy_read",
  "legacy_preservation_read",
  "legacy_delete",
] as const);

export const nativeLegacyHarnessCustodyFailureSubstages = Object.freeze([
  "admission",
  "static_bundle",
  "static_self_managed",
  "static_security_metadata",
  "spawn",
  "descriptor_before_dynamic",
  "dynamic_pid_hash",
  "dynamic_security_metadata",
  "descriptor_after_dynamic",
  "resume",
  "output",
  "exit",
  "group_retirement",
  "response_parse",
] as const);

export type NativeHarnessCustodyFailureStage =
  (typeof nativeHarnessCustodyFailureStages)[number];

export type NativeLegacyHarnessCustodyFailureStage =
  (typeof nativeLegacyHarnessCustodyFailureStages)[number];

export type NativeLegacyHarnessCustodyFailureSubstage =
  (typeof nativeLegacyHarnessCustodyFailureSubstages)[number];

export function isNativeHarnessCustodyFailureStage(
  value: unknown,
): value is NativeHarnessCustodyFailureStage {
  return (
    typeof value === "string" &&
    (nativeHarnessCustodyFailureStages as readonly string[]).includes(value)
  );
}

export function isNativeLegacyHarnessCustodyFailureStage(
  value: unknown,
): value is NativeLegacyHarnessCustodyFailureStage {
  return (
    typeof value === "string" &&
    (nativeLegacyHarnessCustodyFailureStages as readonly string[]).includes(
      value,
    )
  );
}

export function isNativeLegacyHarnessCustodyFailureSubstage(
  value: unknown,
): value is NativeLegacyHarnessCustodyFailureSubstage {
  return (
    typeof value === "string" &&
    (nativeLegacyHarnessCustodyFailureSubstages as readonly string[]).includes(
      value,
    )
  );
}
