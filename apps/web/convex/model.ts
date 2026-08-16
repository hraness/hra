import { v } from "convex/values";

// These mirror the frozen wire constants without pulling Zod into schema evaluation.
export const DEFAULT_CLAIM_LEASE_MS = 15 * 60 * 1_000;
export const CLAIM_RENEWAL_THRESHOLD_MS = 5 * 60 * 1_000;
export const AGENT_SESSION_IDLE_MS = 20 * 60 * 1_000;
export const AGENT_SESSION_HEARTBEAT_MS = 5 * 60 * 1_000;
export const RUNNER_HEARTBEAT_INTERVAL_MS = 15_000;
export const RUNNER_PRESENCE_LEASE_MS = 45_000;
export const DISPATCH_LEASE_MS = 90_000;
export const MAX_RUN_EVENT_BATCH = 25;
export const MAX_RUN_EVENTS_VIEW = 100;
export const MAX_NONTERMINAL_RUN_EVENTS = 96;
export const MAX_RUNNER_CAPACITY = 32;
export const MAX_RUNNER_REPOSITORIES = 128;
export const HRA_DISPATCH_PROTOCOL_VERSION = 1;
export const MAX_HUMAN_INPUT_PREVIEW_BYTES = 160;

export const CREDENTIAL_LIFETIME_MS = 90 * 24 * 60 * 60 * 1_000;
export const ENROLLMENT_LIFETIME_MS = 10 * 60 * 1_000;
export const MAX_DEFER_MS = 4 * 365 * 24 * 60 * 60 * 1_000;
export const TASK_KEY_SUFFIX_LENGTH = 7;
export const MAX_TASK_DESCRIPTION_BYTES = 32 * 1_024;
export const MAX_TASK_COMMENT_BYTES = 16 * 1_024;
export const MAX_SUBMISSION_SUMMARY_BYTES = 16 * 1_024;
export const MAX_SUBMISSION_EVIDENCE = 50;
export const MAX_COMMAND_RECEIPT_BYTES = 512 * 1_024;
export const MAX_TASK_LABELS = 50;
export const MAX_GRAPH_DEPTH = 100;
export const MAX_GRAPH_NODES = 500;

export const agentScopeValidator = v.union(
  v.literal("tasks:read"),
  v.literal("tasks:create"),
  v.literal("tasks:edit"),
  v.literal("tasks:assign"),
  v.literal("tasks:claim"),
  v.literal("tasks:submit"),
  v.literal("tasks:review"),
  v.literal("dependencies:write"),
  v.literal("comments:write"),
  v.literal("dispatch:execute"),
  v.literal("runtime:heartbeat"),
  v.literal("runs:report"),
);

export const agentStatusValidator = v.union(v.literal("active"), v.literal("disabled"));
export const grantStatusValidator = v.union(v.literal("active"), v.literal("revoked"));
export const credentialStatusValidator = v.union(v.literal("active"), v.literal("revoked"));
export const sessionStatusValidator = v.union(
  v.literal("active"),
  v.literal("expired"),
  v.literal("revoked"),
);
export const enrollmentStatusValidator = v.union(
  v.literal("active"),
  v.literal("redeemed"),
  v.literal("revoked"),
);
export const taskStatusValidator = v.union(
  v.literal("open"),
  v.literal("in_progress"),
  v.literal("in_review"),
  v.literal("done"),
  v.literal("cancelled"),
);
export const taskTypeValidator = v.union(
  v.literal("task"),
  v.literal("bug"),
  v.literal("feature"),
  v.literal("epic"),
  v.literal("chore"),
);
export const claimStateValidator = v.union(
  v.literal("active"),
  v.literal("released"),
  v.literal("expired"),
  v.literal("submitted"),
  v.literal("replaced"),
);
export const wakeStateValidator = v.union(
  v.literal("pending"),
  v.literal("completed"),
  v.literal("stale"),
);

export const taskEventTypeValidator = v.union(
  v.literal("task.created"),
  v.literal("task.deferred"),
  v.literal("task.became_ready"),
  v.literal("task.claimed"),
  v.literal("task.claim_renewed"),
  v.literal("task.claim_released"),
  v.literal("task.claim_expired"),
  v.literal("task.reclaimed"),
  v.literal("task.submitted"),
  v.literal("task.accepted"),
  v.literal("task.rejected"),
  v.literal("task.updated"),
  v.literal("task.cancelled"),
  v.literal("task.reopened"),
  v.literal("task.assigned"),
  v.literal("task.parent_set"),
  v.literal("task.parent_cleared"),
  v.literal("task.label_added"),
  v.literal("task.label_removed"),
  v.literal("task.comment_added"),
  v.literal("task.reference_added"),
  v.literal("task.reference_removed"),
  v.literal("dependency.added"),
  v.literal("dependency.removed"),
);

export const securityEventTypeValidator = v.union(
  v.literal("workspace.membership_roles_set"),
  v.literal("workspace.repository_created"),
  v.literal("workspace.repository_removed"),
  v.literal("agent.enrollment_created"),
  v.literal("agent.enrollment_redeemed"),
  v.literal("agent.credential_created"),
  v.literal("agent.credential_revoked"),
  v.literal("agent.session_started"),
  v.literal("agent.session_expired"),
  v.literal("agent.disabled"),
);

export const eventActorValidator = v.union(
  v.object({ kind: v.literal("human"), userId: v.string() }),
  v.object({ kind: v.literal("agent"), agentId: v.string() }),
  v.object({
    kind: v.literal("system"),
    jobKind: v.union(
      v.literal("claim_expiry"),
      v.literal("defer_wake"),
      v.literal("repair"),
      v.literal("reconciliation"),
    ),
  }),
);

export const persistedEventActorValidator = v.union(
  v.object({ kind: v.literal("human"), userId: v.string() }),
  v.object({
    kind: v.literal("agent"),
    agentId: v.string(),
    credentialId: v.string(),
    sessionId: v.optional(v.string()),
  }),
  v.object({
    kind: v.literal("system"),
    jobKind: v.union(
      v.literal("claim_expiry"),
      v.literal("defer_wake"),
      v.literal("repair"),
      v.literal("reconciliation"),
    ),
    sourceId: v.string(),
  }),
);

export const eventCommandValidator = v.union(
  v.object({ kind: v.literal("client"), idempotencyKey: v.string(), requestId: v.string() }),
  v.object({
    kind: v.literal("system"),
    jobKind: v.union(
      v.literal("claim_expiry"),
      v.literal("defer_wake"),
      v.literal("repair"),
      v.literal("reconciliation"),
    ),
  }),
);

export const publicMetadataValueValidator = v.union(
  v.string(),
  v.number(),
  v.boolean(),
  v.null(),
  v.array(v.string()),
);
export const publicMetadataValidator = v.record(v.string(), publicMetadataValueValidator);

export const repositoryProviderValidator = v.union(
  v.literal("github"),
  v.literal("gitlab"),
  v.literal("bitbucket"),
  v.literal("other"),
);

export const runnerDesiredStateValidator = v.union(
  v.literal("active"),
  v.literal("draining"),
);

export const runnerBlockReasonValidator = v.union(
  v.literal("no_account"),
  v.literal("no_repository"),
  v.literal("capacity_full"),
  v.literal("upgrade_required"),
  v.literal("credential_invalid"),
);

export const runnerReportedStateValidator = v.union(
  v.literal("starting"),
  v.literal("ready"),
  v.literal("busy"),
  v.literal("degraded"),
);

export const publicRunStatusEventKindValidator = v.union(
  v.literal("run.queued"),
  v.literal("worktree.preparing"),
  v.literal("worktree.ready"),
  v.literal("codex.starting"),
  v.literal("codex.running"),
  v.literal("codex.planning"),
  v.literal("codex.editing"),
  v.literal("codex.testing"),
  v.literal("codex.waiting_for_approval"),
  v.literal("codex.waiting_for_input"),
  v.literal("run.submitted"),
  v.literal("run.failed"),
  v.literal("run.cancelled"),
  v.literal("run.lease_lost"),
  v.literal("codex.tool_activity.started"),
  v.literal("codex.tool_activity.completed"),
);

export const publicRunTextEventKindValidator = v.union(
  v.literal("codex.reasoning_summary.delta"),
  v.literal("codex.assistant_message.delta"),
);

export const publicRunEventKindValidator = v.union(
  publicRunStatusEventKindValidator,
  publicRunTextEventKindValidator,
);

export const runPhaseValidator = v.union(
  v.literal("queued"),
  v.literal("leased"),
  v.literal("provisioning"),
  v.literal("starting"),
  v.literal("running"),
  v.literal("waiting"),
  v.literal("submitted"),
  v.literal("failed"),
  v.literal("cancel_requested"),
  v.literal("cancelled"),
  v.literal("ambiguous"),
);

export const runInteractionOptionValidator = v.object({
  id: v.string(),
  label: v.string(),
  description: v.optional(v.string()),
});

export const runInteractionQuestionValidator = v.object({
  id: v.string(),
  header: v.string(),
  prompt: v.string(),
  allowOther: v.boolean(),
  options: v.array(runInteractionOptionValidator),
});

export const runInteractionReplyBindingValidator = v.object({
  version: v.literal(1),
  algorithm: v.literal("P256-HKDF-SHA256-A256GCM"),
  keyId: v.string(),
  publicKey: v.string(),
  runnerId: v.string(),
  bootId: v.string(),
  bootGeneration: v.number(),
  claimId: v.string(),
  claimFence: v.number(),
  requestDigest: v.string(),
});

export const runInteractionRequestValidator = v.union(
  v.object({
    id: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    kind: v.literal("user_input"),
    questions: v.array(runInteractionQuestionValidator),
    reply: runInteractionReplyBindingValidator,
  }),
  v.object({
    id: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    kind: v.literal("file_change_approval"),
    scope: v.literal("once"),
    reply: runInteractionReplyBindingValidator,
  }),
);

export const sealedRunInteractionResponseValidator = v.object({
  version: v.literal(1),
  algorithm: v.literal("P256-HKDF-SHA256-A256GCM"),
  keyId: v.string(),
  workspaceId: v.string(),
  ephemeralPublicKey: v.string(),
  nonce: v.string(),
  ciphertext: v.string(),
});

export const runInteractionStateValidator = v.union(
  v.literal("pending"),
  v.literal("answered"),
  v.literal("resolved"),
  v.literal("expired"),
);

export const humanInputKindValidator = v.union(
  v.literal("approval"),
  v.literal("user_input"),
);

export const humanInputSummaryValidator = v.object({
  pendingCount: v.number(),
  oldestRequestedAt: v.number(),
  expiresAt: v.number(),
  kind: humanInputKindValidator,
  preview: v.string(),
});

export const runFailureKindValidator = v.union(
  v.literal("worktree_setup"),
  v.literal("codex_start"),
  v.literal("codex_exit"),
  v.literal("lease_lost"),
  v.literal("claim_lost"),
  v.literal("internal"),
);

export const runnerHeartbeatResponseValidator = v.object({
  serverTime: v.number(),
  leaseUntil: v.number(),
  desiredState: runnerDesiredStateValidator,
  candidates: v.array(
    v.object({ taskKey: v.string(), repositoryId: v.string(), queuedAt: v.number() }),
  ),
  runLeases: v.array(v.object({ runId: v.string(), leaseUntil: v.number() })),
  stopRunIds: v.array(v.string()),
  releaseRunIds: v.array(v.string()),
});

const dispatchRunnerBase = {
  organizationId: v.id("organizations"),
  workspaceId: v.id("workspaces"),
  agentId: v.id("agents"),
  publicId: v.string(),
  installationId: v.string(),
  bootId: v.string(),
  bootGeneration: v.number(),
  heartbeatSequence: v.number(),
  heartbeatFingerprint: v.string(),
  desiredState: runnerDesiredStateValidator,
  protocolVersion: v.literal(HRA_DISPATCH_PROTOCOL_VERSION),
  clientVersion: v.string(),
  capacity: v.number(),
  activeRuns: v.number(),
  candidateRepositoryCursor: v.optional(v.id("workspaceRepositories")),
  lastHeartbeatResponse: v.optional(runnerHeartbeatResponseValidator),
  lastHeartbeatAt: v.number(),
  leaseUntil: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
} as const;

export const dispatchRunnerValidator = v.object({
  ...dispatchRunnerBase,
  reportedState: runnerReportedStateValidator,
  blockReason: v.optional(runnerBlockReasonValidator),
});

const taskDispatchCommon = {
  organizationId: v.id("organizations"),
  workspaceId: v.id("workspaces"),
  taskId: v.id("tasks"),
  repositoryId: v.id("workspaceRepositories"),
  publicId: v.string(),
  taskKey: v.string(),
  repositoryPublicId: v.string(),
  acceptedThroughSequence: v.number(),
  queuedByUserId: v.id("users"),
  queuedTaskRevision: v.number(),
  queuedClaimFence: v.number(),
  retryOfDispatchId: v.optional(v.id("taskDispatches")),
  queuedAt: v.number(),
  candidateOrderAt: v.optional(v.number()),
  candidateRotationAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
} as const;

const boundTaskDispatch = {
  ...taskDispatchCommon,
  runnerId: v.id("dispatchRunners"),
  runnerPublicId: v.string(),
  bootId: v.string(),
  bootGeneration: v.number(),
  taskClaimId: v.id("taskClaims"),
  taskClaimPublicId: v.string(),
  claimFence: v.number(),
  inputReviewRevision: v.number(),
  leaseGeneration: v.number(),
  leaseUntil: v.number(),
  claimedAt: v.number(),
} as const;

const humanDispatchResolution = {
  humanResolution: v.optional(
    v.object({
      reason: v.union(v.literal("confirmed_cancelled"), v.literal("declared_failed")),
      resolvedByUserId: v.id("users"),
      resolvedAt: v.number(),
    }),
  ),
} as const;

export const taskDispatchValidator = v.union(
  v.object({
    ...taskDispatchCommon,
    phase: v.literal("queued"),
    desiredState: v.literal("run"),
  }),
  v.object({
    ...taskDispatchCommon,
    phase: v.literal("cancelled"),
    desiredState: v.literal("stop"),
    terminalAt: v.number(),
  }),
  v.object({
    ...boundTaskDispatch,
    phase: v.union(
      v.literal("leased"),
      v.literal("provisioning"),
      v.literal("starting"),
      v.literal("running"),
      v.literal("waiting"),
    ),
    desiredState: v.literal("run"),
  }),
  v.object({
    ...boundTaskDispatch,
    phase: v.literal("cancel_requested"),
    desiredState: v.literal("stop"),
  }),
  v.object({
    ...boundTaskDispatch,
    phase: v.literal("submitted"),
    desiredState: v.union(v.literal("run"), v.literal("stop")),
    terminalAt: v.number(),
  }),
  v.object({
    ...boundTaskDispatch,
    ...humanDispatchResolution,
    phase: v.literal("failed"),
    desiredState: v.union(v.literal("run"), v.literal("stop")),
    failureKind: runFailureKindValidator,
    terminalAt: v.number(),
  }),
  v.object({
    ...boundTaskDispatch,
    ...humanDispatchResolution,
    phase: v.literal("cancelled"),
    desiredState: v.literal("stop"),
    failureKind: v.optional(v.union(v.literal("lease_lost"), v.literal("claim_lost"))),
    terminalAt: v.number(),
  }),
  v.object({
    ...boundTaskDispatch,
    phase: v.literal("ambiguous"),
    desiredState: v.union(v.literal("run"), v.literal("stop")),
    failureKind: v.union(v.literal("lease_lost"), v.literal("claim_lost")),
    terminalAt: v.number(),
  }),
);

export const taskReferenceValueValidator = v.union(
  v.object({ kind: v.literal("repository"), repositoryId: v.id("workspaceRepositories") }),
  v.object({
    kind: v.literal("pull_request"),
    url: v.string(),
    repositoryId: v.optional(v.id("workspaceRepositories")),
  }),
  v.object({
    kind: v.literal("commit"),
    sha: v.string(),
    repositoryId: v.optional(v.id("workspaceRepositories")),
    url: v.optional(v.string()),
  }),
  v.object({ kind: v.literal("artifact"), name: v.string(), url: v.string() }),
  v.object({ kind: v.literal("url"), label: v.string(), url: v.string() }),
);

export const submissionEvidenceValidator = v.union(
  v.object({ kind: v.literal("commit"), sha: v.string(), url: v.optional(v.string()) }),
  v.object({ kind: v.literal("pull_request"), url: v.string() }),
  v.object({ kind: v.literal("artifact"), name: v.string(), url: v.string() }),
  v.object({ kind: v.literal("url"), label: v.string(), url: v.string() }),
  v.object({ kind: v.literal("test"), command: v.string() }),
  v.object({ kind: v.literal("note"), text: v.string() }),
);

const taskSubmissionBase = {
  organizationId: v.id("organizations"),
  workspaceId: v.id("workspaces"),
  taskId: v.id("tasks"),
  publicId: v.string(),
  dispatchPublicId: v.optional(v.string()),
  submittedBy: v.object({
    kind: v.literal("agent"),
    agentId: v.string(),
    credentialId: v.string(),
    sessionId: v.optional(v.string()),
  }),
  reviewRevision: v.number(),
  summary: v.string(),
  evidence: v.array(submissionEvidenceValidator),
  submittedAt: v.number(),
} as const;

export const taskSubmissionValidator = v.union(
  v.object({ ...taskSubmissionBase, status: v.literal("pending") }),
  v.object({
    ...taskSubmissionBase,
    status: v.literal("accepted"),
    reviewedBy: persistedEventActorValidator,
    reviewedAt: v.number(),
  }),
  v.object({
    ...taskSubmissionBase,
    status: v.literal("rejected"),
    reviewedBy: persistedEventActorValidator,
    reviewedAt: v.number(),
    reviewReason: v.string(),
  }),
  v.object({
    ...taskSubmissionBase,
    status: v.literal("cancelled"),
    cancelledBy: persistedEventActorValidator,
    cancelledAt: v.number(),
    cancellationReason: v.string(),
  }),
);

export const errorCodeValidator = v.union(
  v.literal("VALIDATION_ERROR"),
  v.literal("AUTHENTICATION_FAILED"),
  v.literal("SESSION_REQUIRED"),
  v.literal("SESSION_INVALID"),
  v.literal("AUTHORIZATION_DENIED"),
  v.literal("SCOPE_REQUIRED"),
  v.literal("ORGANIZATION_REQUIRED"),
  v.literal("ORGANIZATION_MISMATCH"),
  v.literal("MEMBERSHIP_INACTIVE"),
  v.literal("WORKSPACE_ROLE_REQUIRED"),
  v.literal("PROVISIONING_IN_PROGRESS"),
  v.literal("PROVISIONING_FAILED"),
  v.literal("AUTH_REFRESH_INDETERMINATE"),
  v.literal("IDEMPOTENCY_REQUIRED"),
  v.literal("IDEMPOTENCY_EXPIRED"),
  v.literal("IDEMPOTENCY_CONFLICT"),
  v.literal("ENROLLMENT_EXPIRED"),
  v.literal("ENROLLMENT_REDEEMED"),
  v.literal("ENROLLMENT_CONFLICT"),
  v.literal("NOT_FOUND"),
  v.literal("TASK_NOT_READY"),
  v.literal("TASK_ALREADY_CLAIMED"),
  v.literal("TASK_BLOCKED"),
  v.literal("TASK_IN_REVIEW"),
  v.literal("TASK_STATE_CONFLICT"),
  v.literal("DEPENDENCY_DUPLICATE"),
  v.literal("DEPENDENCY_CYCLE"),
  v.literal("HIERARCHY_CYCLE"),
  v.literal("GRAPH_VALIDATION_LIMIT"),
  v.literal("BLOCKER_LIMIT"),
  v.literal("DEPENDENT_LIMIT"),
  v.literal("CLAIM_STALE"),
  v.literal("CLAIM_NOT_OWNED"),
  v.literal("LEASE_NOT_RENEWABLE"),
  v.literal("RUNNER_ALREADY_CONNECTED"),
  v.literal("RUN_INTERACTION_LIMIT"),
  v.literal("PROJECTION_MISMATCH"),
  v.literal("SELF_REVIEW_DENIED"),
  v.literal("SUBMISSION_STALE"),
  v.literal("WORKSPACE_TASK_LIMIT"),
  v.literal("DEFER_HORIZON"),
  v.literal("RATE_LIMITED"),
  v.literal("SERVICE_UNAVAILABLE"),
  v.literal("INTERNAL_ERROR"),
);

export const errorDetailsValidator = v.object({
  taskKey: v.optional(v.string()),
  currentRevision: v.optional(v.number()),
  fence: v.optional(v.number()),
  leaseUntil: v.optional(v.number()),
  blockingCount: v.optional(v.number()),
  ownerAgentId: v.optional(v.string()),
  requiredScope: v.optional(agentScopeValidator),
  retryAfterMs: v.optional(v.number()),
  idempotencyKey: v.optional(v.string()),
  exhaustedLimit: v.optional(
    v.union(
      v.literal("visited_tasks"),
      v.literal("examined_edges"),
      v.literal("parent_depth"),
    ),
  ),
});

export const domainErrorValidator = v.object({
  code: errorCodeValidator,
  message: v.string(),
  requestId: v.string(),
  details: errorDetailsValidator,
});

export const claimViewValidator = v.object({
  id: v.string(),
  agentId: v.string(),
  fence: v.number(),
  leaseGeneration: v.number(),
  leaseUntil: v.number(),
});

const taskViewFields = {
  id: v.string(),
  key: v.string(),
  title: v.string(),
  type: taskTypeValidator,
  priority: v.number(),
  availableAt: v.number(),
  isReady: v.boolean(),
  unresolvedBlockerCount: v.number(),
  cancelledBlockerCount: v.number(),
  revision: v.number(),
  reviewRevision: v.number(),
  assigneeAgentId: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
};

export const taskViewValidator = v.union(
  v.object({ ...taskViewFields, status: v.literal("open") }),
  v.object({
    ...taskViewFields,
    status: v.literal("in_progress"),
    currentClaim: claimViewValidator,
  }),
  v.object({ ...taskViewFields, status: v.literal("in_review") }),
  v.object({ ...taskViewFields, status: v.literal("done") }),
  v.object({ ...taskViewFields, status: v.literal("cancelled") }),
);

export const humanTaskRunSummaryValidator = v.union(
  v.object({
    phase: runPhaseValidator,
    updatedAt: v.number(),
    latestDisplay: v.union(
      v.object({
        kind: publicRunStatusEventKindValidator,
        observedAt: v.number(),
      }),
      v.object({
        kind: publicRunTextEventKindValidator,
        displayText: v.string(),
        observedAt: v.number(),
      }),
      v.null(),
    ),
  }),
  v.null(),
);

export const humanTaskListItemValidator = v.object({
  task: taskViewValidator,
  humanInput: v.union(humanInputSummaryValidator, v.null()),
  run: humanTaskRunSummaryValidator,
});

export const redeemEnrollmentDataValidator = v.object({
  agentId: v.string(),
  credentialId: v.string(),
  credentialExpiresAt: v.number(),
  scopes: v.array(agentScopeValidator),
});

export const startSessionDataValidator = v.object({
  sessionId: v.string(),
  expiresAt: v.number(),
});

export const taskDataValidator = v.object({ task: taskViewValidator });

export const readyTasksDataValidator = v.object({
  tasks: v.array(taskViewValidator),
  cursor: v.union(v.string(), v.null()),
});

export const contextDataValidator = v.object({
  principal: v.object({
    kind: v.literal("agent"),
    agentId: v.string(),
    name: v.string(),
    scopes: v.array(agentScopeValidator),
    sessionId: v.string(),
  }),
  organization: v.object({ id: v.string(), name: v.string() }),
  workspace: v.object({ id: v.string(), slug: v.string(), name: v.string() }),
  serverTime: v.number(),
  defaults: v.object({
    claimLeaseMs: v.literal(DEFAULT_CLAIM_LEASE_MS),
    claimRenewalThresholdMs: v.literal(CLAIM_RENEWAL_THRESHOLD_MS),
    sessionIdleMs: v.literal(AGENT_SESSION_IDLE_MS),
    sessionHeartbeatMs: v.literal(AGENT_SESSION_HEARTBEAT_MS),
  }),
  counts: v.object({
    readyTasks: v.number(),
    activeClaims: v.number(),
    reviewRequests: v.number(),
  }),
  readyTasks: v.array(taskViewValidator),
  activeClaims: v.array(taskViewValidator),
  reviewRequests: v.array(
    v.object({
      task: taskViewValidator,
      submissionId: v.string(),
      submittedByAgentId: v.string(),
      submittedAt: v.number(),
    }),
  ),
  cursors: v.object({
    readyTasks: v.union(v.string(), v.null()),
    activeClaims: v.union(v.string(), v.null()),
    reviewRequests: v.union(v.string(), v.null()),
  }),
  workflowRules: v.array(v.string()),
});

export function successResultValidator<DataValidator extends Parameters<typeof v.object>[0]>(
  data: DataValidator,
) {
  return v.object({
    ok: v.literal(true),
    data: v.object(data),
    requestId: v.string(),
  });
}

export const failureResultValidator = v.object({ ok: v.literal(false), error: domainErrorValidator });
