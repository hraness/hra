import type { AgentScope } from "@hraness/agent-tasks-protocol";

export const dispatchClaimRequiredScopes = [
  "dispatch:execute",
  "tasks:claim",
  "runs:report",
] as const satisfies readonly AgentScope[];

export function firstMissingDispatchClaimScope(
  scopes: readonly AgentScope[],
): (typeof dispatchClaimRequiredScopes)[number] | null {
  return dispatchClaimRequiredScopes.find((scope) => !scopes.includes(scope)) ?? null;
}
