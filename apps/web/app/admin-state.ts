export const workspaceRoleValues = ["planner", "reviewer", "viewer"] as const;
export type WorkspaceRole = (typeof workspaceRoleValues)[number];

const workspaceRoleSet = new Set<string>(workspaceRoleValues);

function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === "string" && workspaceRoleSet.has(value);
}

export function canonicalWorkspaceRoles(value: unknown): readonly WorkspaceRole[] {
  if (!Array.isArray(value)) return [];
  const selected = new Set<WorkspaceRole>();
  for (const candidate of value) {
    if (isWorkspaceRole(candidate)) selected.add(candidate);
  }
  return workspaceRoleValues.filter((role) => selected.has(role));
}

export function withWorkspaceRole(
  current: readonly WorkspaceRole[],
  role: WorkspaceRole,
  checked: boolean,
): readonly WorkspaceRole[] {
  const selected = new Set(canonicalWorkspaceRoles(current));
  if (checked) selected.add(role);
  else selected.delete(role);
  return workspaceRoleValues.filter((candidate) => selected.has(candidate));
}

export function refreshedSelection(
  current: string | null,
  availableIds: readonly string[],
): string | null {
  if (current !== null && availableIds.includes(current)) return current;
  return availableIds[0] ?? null;
}

export function sameWorkspaceRoles(
  left: readonly WorkspaceRole[],
  right: readonly WorkspaceRole[],
): boolean {
  const canonicalLeft = canonicalWorkspaceRoles(left);
  const canonicalRight = canonicalWorkspaceRoles(right);
  return (
    canonicalLeft.length === canonicalRight.length &&
    canonicalLeft.every((role, index) => role === canonicalRight[index])
  );
}
