export {
  BLOCKER_PROPAGATION_READ_HEADROOM,
  MAX_BLOCKER_PROPAGATION_READS,
  MAX_BLOCKING_DEPENDENTS,
  MAX_DIRECT_BLOCKERS,
  MAX_GRAPH_EXAMINED_EDGES,
  MAX_GRAPH_VISITED_TASKS,
  MAX_PARENT_DEPTH,
  WORKSPACE_ACTIVE_TASK_LIMIT,
  WORKSPACE_TOTAL_TASK_LIMIT,
  blockerContribution,
  blockerPropagationReadBound,
  derivedNeedsAttention,
  derivedReady,
  isCredentialFreeHttpsUrl,
  reviewAcceptanceAllowed,
  reviewActorAllowed,
  taskCancellationDisposition,
  transitionBlockerCounters,
  transitionSubmissionLifecycle,
  validateDependencyInsertion,
  validateParentInsertion,
} from "@hraness/agent-tasks-domain";
export type {
  BlockerLifecycle,
  GraphValidationResult,
  ParentValidationResult,
  SubmissionLifecycle,
  SubmissionTerminalCommand,
  TaskCancellationDisposition,
} from "@hraness/agent-tasks-domain";

export interface TaskClaimTupleInput {
  readonly taskStatus: string;
  readonly taskOrganizationId: string;
  readonly taskWorkspaceId: string;
  readonly taskId: string;
  readonly compactClaimId: string;
  readonly compactClaimPublicId: string;
  readonly compactAgentId: string;
  readonly compactAgentPublicId: string;
  readonly compactFence: number;
  readonly compactLeaseGeneration: number;
  readonly compactLeaseUntil: number;
  readonly claimId: string;
  readonly claimOrganizationId: string;
  readonly claimWorkspaceId: string;
  readonly claimTaskId: string;
  readonly claimPublicId: string;
  readonly claimAgentId: string;
  readonly claimAgentPublicId: string;
  readonly claimState: string;
  readonly claimFence: number;
  readonly claimLeaseGeneration: number;
  readonly claimLeaseUntil: number;
}

export interface TaskScopedRecordInput {
  readonly taskOrganizationId: string;
  readonly taskWorkspaceId: string;
  readonly taskId: string;
  readonly recordOrganizationId: string;
  readonly recordWorkspaceId: string;
  readonly recordTaskId: string;
}

export interface AuthorizedTaskScopeInput {
  readonly authorizedOrganizationId: string;
  readonly authorizedWorkspaceId: string;
  readonly taskOrganizationId: string;
  readonly taskWorkspaceId: string;
}

export interface ParentTaskTupleInput {
  readonly taskOrganizationId: string;
  readonly taskWorkspaceId: string;
  readonly taskParentTaskId: string;
  readonly parentOrganizationId: string;
  readonly parentWorkspaceId: string;
  readonly parentTaskId: string;
}

export interface DependencyTupleInput {
  readonly dependencyOrganizationId: string;
  readonly dependencyWorkspaceId: string;
  readonly dependencyBlockerTaskId: string;
  readonly dependencyBlockedTaskId: string;
  readonly blockerOrganizationId: string;
  readonly blockerWorkspaceId: string;
  readonly blockerTaskId: string;
  readonly blockedOrganizationId: string;
  readonly blockedWorkspaceId: string;
  readonly blockedTaskId: string;
}

export interface AgentGrantTupleInput {
  readonly authorizedOrganizationId: string;
  readonly authorizedWorkspaceId: string;
  readonly agentOrganizationId: string;
  readonly agentId: string;
  readonly grantOrganizationId: string;
  readonly grantWorkspaceId: string;
  readonly grantAgentId: string;
}

/** A task loaded through an index must still agree with the final authorized tenant. */
export function taskMatchesAuthorizedScope(input: AuthorizedTaskScopeInput): boolean {
  return (
    input.taskOrganizationId === input.authorizedOrganizationId &&
    input.taskWorkspaceId === input.authorizedWorkspaceId
  );
}

/** A denormalized task-owned row must agree with all three tenant keys. */
export function taskScopedRecordMatches(input: TaskScopedRecordInput): boolean {
  return (
    input.recordOrganizationId === input.taskOrganizationId &&
    input.recordWorkspaceId === input.taskWorkspaceId &&
    input.recordTaskId === input.taskId
  );
}

/** A parent pointer is valid only when the loaded parent and child share the full tenant tuple. */
export function parentTaskTupleMatches(input: ParentTaskTupleInput): boolean {
  return (
    input.parentOrganizationId === input.taskOrganizationId &&
    input.parentWorkspaceId === input.taskWorkspaceId &&
    input.parentTaskId === input.taskParentTaskId
  );
}

/** A dependency row must own and point to both exact task documents in one tenant. */
export function dependencyTupleMatches(input: DependencyTupleInput): boolean {
  return (
    input.dependencyOrganizationId === input.blockerOrganizationId &&
    input.dependencyOrganizationId === input.blockedOrganizationId &&
    input.dependencyWorkspaceId === input.blockerWorkspaceId &&
    input.dependencyWorkspaceId === input.blockedWorkspaceId &&
    input.dependencyBlockerTaskId === input.blockerTaskId &&
    input.dependencyBlockedTaskId === input.blockedTaskId
  );
}

/** A target agent and its grant must agree with the authorized organization and workspace. */
export function agentGrantTupleMatches(input: AgentGrantTupleInput): boolean {
  return (
    input.agentOrganizationId === input.authorizedOrganizationId &&
    input.grantOrganizationId === input.authorizedOrganizationId &&
    input.grantWorkspaceId === input.authorizedWorkspaceId &&
    input.grantAgentId === input.agentId
  );
}

/** Full durable/compact tuple equality required before a claim-bound write or overdue read. */
export function activeTaskClaimTupleMatches(input: TaskClaimTupleInput): boolean {
  return (
    input.taskStatus === "in_progress" &&
    input.claimState === "active" &&
    input.claimOrganizationId === input.taskOrganizationId &&
    input.claimWorkspaceId === input.taskWorkspaceId &&
    input.claimTaskId === input.taskId &&
    input.claimId === input.compactClaimId &&
    input.claimPublicId === input.compactClaimPublicId &&
    input.claimAgentId === input.compactAgentId &&
    input.claimAgentPublicId === input.compactAgentPublicId &&
    input.claimFence === input.compactFence &&
    input.claimLeaseGeneration === input.compactLeaseGeneration &&
    input.claimLeaseUntil === input.compactLeaseUntil
  );
}

export type ClaimCommandKind = "renew" | "release" | "submit";

export type ClaimCommandDisposition =
  | { readonly kind: "allowed" }
  | { readonly kind: "task_state_conflict" }
  | { readonly kind: "claim_not_owned" }
  | { readonly kind: "claim_stale" }
  | { readonly kind: "lease_not_renewable" };

/**
 * Classifies the compact-claim guard shared by claim-bound commands. Durable
 * tuple validation remains a separate, mandatory check because it may require
 * a database read. Keeping the compact decision pure gives the mutation paths
 * and serial-interleaving tests one source of truth for fencing and lease
 * semantics.
 */
export function claimCommandDisposition(input: {
  readonly command: ClaimCommandKind;
  readonly taskStatus: string;
  readonly hasCurrentClaim: boolean;
  readonly currentAgentId?: string;
  readonly authorizedAgentId: string;
  readonly currentFence?: number;
  readonly requestedFence: number;
  readonly currentLeaseUntil?: number;
  readonly now: number;
  readonly renewalThresholdMs?: number;
}): ClaimCommandDisposition {
  if (
    input.taskStatus !== "in_progress" ||
    !input.hasCurrentClaim ||
    input.currentAgentId === undefined ||
    input.currentFence === undefined ||
    input.currentLeaseUntil === undefined
  ) {
    return { kind: "task_state_conflict" };
  }
  if (input.currentAgentId !== input.authorizedAgentId) {
    return { kind: "claim_not_owned" };
  }
  if (input.currentFence !== input.requestedFence) {
    return { kind: "claim_stale" };
  }
  const remaining = input.currentLeaseUntil - input.now;
  if (input.command === "renew") {
    if (
      input.renewalThresholdMs === undefined ||
      remaining <= 0 ||
      remaining > input.renewalThresholdMs
    ) {
      return { kind: "lease_not_renewable" };
    }
  } else if (remaining <= 0) {
    return { kind: "claim_stale" };
  }
  return { kind: "allowed" };
}

export function nextClaimFence(currentFence: number): number | null {
  if (!Number.isSafeInteger(currentFence) || currentFence < 0) return null;
  const next = currentFence + 1;
  return Number.isSafeInteger(next) ? next : null;
}

export type ScheduledClaimDisposition = "expire" | "reschedule" | "stale";

/** A scheduled expiry may mutate only the exact durable/compact generation it names. */
export function scheduledClaimDisposition(input: {
  readonly activeTupleMatches: boolean;
  readonly scheduledClaimId: string;
  readonly currentClaimId: string | undefined;
  readonly scheduledFence: number;
  readonly currentFence: number | undefined;
  readonly scheduledLeaseGeneration: number;
  readonly currentLeaseGeneration: number | undefined;
  readonly scheduledDeadline: number;
  readonly currentLeaseUntil: number | undefined;
  readonly now: number;
}): ScheduledClaimDisposition {
  if (
    !input.activeTupleMatches ||
    input.currentClaimId !== input.scheduledClaimId ||
    input.currentFence !== input.scheduledFence ||
    input.currentLeaseGeneration !== input.scheduledLeaseGeneration ||
    input.currentLeaseUntil !== input.scheduledDeadline
  ) {
    return "stale";
  }
  return input.now < input.scheduledDeadline ? "reschedule" : "expire";
}
