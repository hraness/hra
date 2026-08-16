/**
 * The deployed Convex table and index use the original public wire spelling.
 * Keep those physical bytes stable while HRA exposes `hraOperationId` at its
 * application and network boundaries.
 */
export const LEGACY_HOSTED_MUTATION_OPERATION_ID_FIELD =
  "oprteOperationId" as const;
export const LEGACY_HOSTED_MUTATION_OPERATION_ID_INDEX =
  "by_principal_workspace_operation" as const;

type HostedMutationOperationIdRecord = Readonly<{
  oprteOperationId: string;
}>;

export function hraOperationIdFromLegacyHostedMutationRecord(
  record: HostedMutationOperationIdRecord,
): string {
  return record[LEGACY_HOSTED_MUTATION_OPERATION_ID_FIELD];
}

export function legacyHostedMutationOperationIdFields(
  hraOperationId: string,
): HostedMutationOperationIdRecord {
  return { [LEGACY_HOSTED_MUTATION_OPERATION_ID_FIELD]: hraOperationId };
}
