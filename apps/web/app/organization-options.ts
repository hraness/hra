export type OrganizationOption = Readonly<{
  id: string;
  name: string;
}>;

export type OrganizationOptionsResult =
  | Readonly<{ kind: "ready"; organizations: readonly OrganizationOption[] }>
  | Readonly<{ kind: "signed-out" }>
  | Readonly<{ kind: "unavailable" }>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

/**
 * Reduce provider records to the two fields the organization picker needs.
 * Provider objects contain metadata and directory details that must not cross
 * the server/client boundary.
 */
export function sanitizeOrganizationOptions(
  value: unknown,
  expectedUserId: string,
): readonly OrganizationOption[] {
  if (!Array.isArray(value) || !isSafeText(expectedUserId, 255)) return [];

  const byId = new Map<string, OrganizationOption>();
  for (const candidate of value.slice(0, 100)) {
    if (!isRecord(candidate)) continue;
    if (candidate.status !== "active" || candidate.userId !== expectedUserId) continue;
    if (!isSafeText(candidate.organizationId, 255)) continue;
    if (!isSafeText(candidate.organizationName, 240)) continue;

    const name = candidate.organizationName.trim();
    if (name.length === 0) continue;
    byId.set(candidate.organizationId, { id: candidate.organizationId, name });
  }

  return [...byId.values()].sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
}
