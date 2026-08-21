import {
  PREVIOUS_SUITE_CATALOG_REVISION,
  SUITE_CATALOG_REVISION,
} from "../suite-account-contracts";
import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import {
  LEGACY_HOSTED_MUTATION_OPERATION_ID_FIELD,
  LEGACY_HOSTED_MUTATION_OPERATION_ID_INDEX,
} from "./hostedMutationPersistence";

import {
  agentScopeValidator,
  agentStatusValidator,
  claimStateValidator,
  credentialStatusValidator,
  enrollmentStatusValidator,
  eventCommandValidator,
  grantStatusValidator,
  humanInputKindValidator,
  publicMetadataValidator,
  publicRunStatusEventKindValidator,
  publicRunTextEventKindValidator,
  runInteractionRequestValidator,
  sealedRunInteractionResponseValidator,
  runInteractionStateValidator,
  repositoryProviderValidator,
  dispatchRunnerValidator,
  persistedEventActorValidator,
  securityEventTypeValidator,
  sessionStatusValidator,
  taskDispatchValidator,
  taskReferenceValueValidator,
  taskSubmissionValidator,
  taskEventTypeValidator,
  taskStatusValidator,
  taskTypeValidator,
  wakeStateValidator,
} from "./model";

const { users: authUsers, ...authTablesWithoutUsers } = authTables;
void authUsers;

export default defineSchema({
  ...authTablesWithoutUsers,

  organizations: defineTable({
    publicId: v.string(),
    name: v.string(),
    status: v.union(v.literal("active"), v.literal("disabled")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_public_id", ["publicId"]),

  users: defineTable({
    publicId: v.string(),
    name: v.string(),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    status: v.union(v.literal("active"), v.literal("disabled")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("email", ["email"])
    .index("phone", ["phone"])
    .index("by_public_id", ["publicId"]),

  authSessionSelections: defineTable({
    sessionId: v.id("authSessions"),
    userId: v.id("users"),
    organizationId: v.id("organizations"),
    workspaceId: v.optional(v.id("workspaces")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_user", ["userId"]),

  passwordSessionProofs: defineTable({
    sessionId: v.id("authSessions"),
    userId: v.id("users"),
    authenticatedAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_expiry", ["expiresAt"]),

  authSessionRotationRequests: defineTable({
    credentialDigest: v.string(),
    userId: v.id("users"),
    oldSessionId: v.id("authSessions"),
    organizationId: v.id("organizations"),
    workspaceId: v.optional(v.id("workspaces")),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_credential_digest", ["credentialDigest"])
    .index("by_old_session", ["oldSessionId"])
    .index("by_expiry", ["expiresAt"]),

  passwordMigrationClaims: defineTable({
    claimProofDigest: v.string(),
    userId: v.id("users"),
    createdAt: v.number(),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
  })
    .index("by_claim_proof_digest", ["claimProofDigest"])
    .index("by_expiry", ["expiresAt"]),

  passwordSignUpReservations: defineTable({
    emailDigest: v.string(),
    targetUserId: v.optional(v.id("users")),
    migrationClaimId: v.optional(v.id("passwordMigrationClaims")),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_email_digest", ["emailDigest"])
    .index("by_expiry", ["expiresAt"]),

  desktopPairingRequests: defineTable({
    pairingId: v.string(),
    challenge: v.string(),
    comparisonCode: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("consumed"),
      v.literal("denied"),
      v.literal("expired"),
    ),
    userId: v.optional(v.id("users")),
    organizationId: v.optional(v.id("organizations")),
    workspaceId: v.optional(v.id("workspaces")),
    authSessionId: v.optional(v.id("authSessions")),
    createdAt: v.number(),
    expiresAt: v.number(),
    approvedAt: v.optional(v.number()),
    consumedAt: v.optional(v.number()),
  })
    .index("by_pairing_id", ["pairingId"])
    .index("by_expiry", ["expiresAt"]),

  suiteEntitlementProjections: defineTable({
    catalogRevision: v.union(
      v.literal(PREVIOUS_SUITE_CATALOG_REVISION),
      v.literal(SUITE_CATALOG_REVISION),
    ),
    expiresAt: v.number(),
    features: v.array(v.union(
      v.literal("suite.paid"),
      v.literal("suite.believer"),
    )),
    localSubject: v.string(),
    observedAt: v.number(),
    projectionRevision: v.number(),
    receiptDigest: v.string(),
    receiptIssuedAt: v.optional(v.number()),
    suiteAccountId: v.string(),
    updatedAt: v.number(),
    userId: v.id("users"),
  })
    .index("by_local_subject", ["localSubject"])
    .index("by_suite_account", ["suiteAccountId"])
    .index("by_user", ["userId"]),

  suiteIdentityAliases: defineTable({
    environment: v.union(
      v.literal("development"),
      v.literal("production"),
    ),
    linkedAt: v.number(),
    localSubject: v.string(),
    state: v.union(v.literal("active"), v.literal("revoked")),
    suiteAccountId: v.string(),
    updatedAt: v.number(),
    userId: v.id("users"),
  })
    .index("by_local_subject", ["localSubject"])
    .index("by_suite_account", ["suiteAccountId"])
    .index("by_user", ["userId"]),

  suiteIdentityLinkChallenges: defineTable({
    challengeId: v.string(),
    createdAt: v.number(),
    environment: v.union(
      v.literal("development"),
      v.literal("production"),
    ),
    expiresAt: v.number(),
    issuedAt: v.number(),
    keyVersion: v.string(),
    localSubject: v.string(),
    proofDigest: v.string(),
    receiptDigest: v.optional(v.string()),
    state: v.union(v.literal("pending"), v.literal("consumed")),
    suiteAccountId: v.optional(v.string()),
    userId: v.id("users"),
  })
    .index("by_challenge", ["challengeId"])
    .index("by_expiry", ["expiresAt"])
    .index("by_user", ["userId"]),

  organizationMemberships: defineTable({
    organizationId: v.id("organizations"),
    userId: v.id("users"),
    role: v.union(v.literal("owner"), v.literal("admin"), v.literal("member")),
    status: v.union(
      v.literal("active"),
      v.literal("inactive"),
      v.literal("pending"),
      v.literal("removed"),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization_and_user", ["organizationId", "userId"])
    .index("by_organization_status_and_user", ["organizationId", "status", "userId"])
    .index("by_user_and_organization", ["userId", "organizationId"]),

  workspaces: defineTable({
    organizationId: v.id("organizations"),
    publicId: v.string(),
    slug: v.string(),
    name: v.string(),
    taskKeyPrefix: v.string(),
    status: v.union(
      v.literal("active"),
      v.literal("disabled"),
      v.literal("staging"),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_public_id", ["publicId"])
    .index("by_organization_and_slug", ["organizationId", "slug"])
    .index("by_organization_status_and_public_id", ["organizationId", "status", "publicId"]),

  workspaceMemberships: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    roles: v.array(
      v.union(v.literal("planner"), v.literal("reviewer"), v.literal("viewer")),
    ),
    status: v.union(v.literal("active"), v.literal("removed")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_and_user", ["workspaceId", "userId"])
    .index("by_user_and_workspace", ["userId", "workspaceId"])
    .index("by_user_organization_status_and_workspace", [
      "userId",
      "organizationId",
      "status",
      "workspaceId",
    ])
    .index("by_organization_and_user", ["organizationId", "userId"]),

  agents: defineTable({
    organizationId: v.id("organizations"),
    createdByUserId: v.id("users"),
    publicId: v.string(),
    name: v.string(),
    status: agentStatusValidator,
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_public_id", ["publicId"])
    .index("by_organization", ["organizationId"]),

  agentWorkspaceGrants: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    agentId: v.id("agents"),
    status: grantStatusValidator,
    scopes: v.array(agentScopeValidator),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_and_agent", ["workspaceId", "agentId"])
    .index("by_workspace_status_and_agent", ["workspaceId", "status", "agentId"])
    .index("by_agent_and_workspace", ["agentId", "workspaceId"]),

  agentEnrollments: defineTable({
    locator: v.string(),
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    agentId: v.id("agents"),
    grantId: v.id("agentWorkspaceGrants"),
    createdByUserId: v.id("users"),
    verifierDigest: v.bytes(),
    pepperVersion: v.string(),
    scopes: v.array(agentScopeValidator),
    credentialLifetimeMs: v.optional(v.number()),
    status: enrollmentStatusValidator,
    expiresAt: v.number(),
    redeemedAt: v.optional(v.number()),
    credentialId: v.optional(v.id("agentCredentials")),
    createdAt: v.number(),
  })
    .index("by_locator", ["locator"])
    .index("by_workspace_and_agent", ["workspaceId", "agentId"]),

  agentCredentials: defineTable({
    locator: v.string(),
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    agentId: v.id("agents"),
    grantId: v.id("agentWorkspaceGrants"),
    verifierDigest: v.bytes(),
    pepperVersion: v.string(),
    scopes: v.array(agentScopeValidator),
    status: credentialStatusValidator,
    expiresAt: v.number(),
    lastUsedAt: v.number(),
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_locator", ["locator"])
    .index("by_workspace_and_agent", ["workspaceId", "agentId"]),

  agentSessions: defineTable({
    publicId: v.string(),
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    agentId: v.id("agents"),
    credentialId: v.id("agentCredentials"),
    status: sessionStatusValidator,
    lastSeenAt: v.number(),
    idleExpiresAt: v.number(),
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_public_id", ["publicId"])
    .index("by_credential_and_status", ["credentialId", "status"])
    .index("by_workspace_and_agent", ["workspaceId", "agentId"])
    .index("by_workspace_agent_and_status", ["workspaceId", "agentId", "status"]),

  dispatchRunners: defineTable(dispatchRunnerValidator)
    .index("by_public_id", ["publicId"])
    .index("by_workspace_and_updated", ["workspaceId", "updatedAt"])
    .index("by_workspace_and_lease", ["workspaceId", "leaseUntil"])
    .index("by_workspace_and_agent", ["workspaceId", "agentId"]),

  dispatchRunnerAuthorities: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    runnerId: v.id("dispatchRunners"),
    runnerPublicId: v.string(),
    installationId: v.string(),
    generation: v.number(),
    leaseUntil: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_runner", ["runnerId"]),

  dispatchRunnerRepositories: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    runnerId: v.id("dispatchRunners"),
    repositoryId: v.id("workspaceRepositories"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_runner_and_repository", ["runnerId", "repositoryId"])
    .index("by_runner", ["runnerId"])
    .index("by_workspace_repository_runner", ["workspaceId", "repositoryId", "runnerId"]),

  tasks: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    publicId: v.string(),
    key: v.string(),
    title: v.string(),
    type: taskTypeValidator,
    priority: v.number(),
    status: taskStatusValidator,
    availableAt: v.number(),
    isReady: v.boolean(),
    isBlocked: v.optional(v.boolean()),
    unresolvedBlockerCount: v.number(),
    cancelledBlockerCount: v.number(),
    revision: v.number(),
    reviewRevision: v.number(),
    createdBy: v.optional(persistedEventActorValidator),
    lastEditedBy: v.optional(persistedEventActorValidator),
    assigneeAgentPublicId: v.optional(v.string()),
    parentTaskId: v.optional(v.id("tasks")),
    readySince: v.optional(v.number()),
    needsAttention: v.optional(v.boolean()),
    // Presence, rather than false, is the sort rank. Legacy and ordinary rows
    // therefore share the same undefined partition without a backfill split.
    hasPendingHumanInput: v.optional(v.literal(true)),
    pendingHumanInputCount: v.optional(v.number()),
    oldestPendingHumanInputAt: v.optional(v.number()),
    oldestPendingHumanInputExpiresAt: v.optional(v.number()),
    latestPendingHumanInputExpiresAt: v.optional(v.number()),
    pendingHumanInputKind: v.optional(humanInputKindValidator),
    pendingHumanInputPreview: v.optional(v.string()),
    wakeGeneration: v.optional(v.number()),
    cancelledAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    submittedAt: v.optional(v.number()),
    claimFence: v.number(),
    currentClaim: v.optional(
      v.object({
        claimId: v.id("taskClaims"),
        publicId: v.string(),
        agentId: v.id("agents"),
        agentPublicId: v.string(),
        fence: v.number(),
        leaseGeneration: v.number(),
        leaseUntil: v.number(),
      }),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_public_id", ["publicId"])
    .index("by_workspace_and_public_id", ["workspaceId", "publicId"])
    .index("by_workspace_and_key", ["workspaceId", "key"])
    .index("by_workspace_ready_available", ["workspaceId", "isReady", "availableAt"])
    .index("by_workspace_status", ["workspaceId", "status"])
    .index("by_workspace_updated", ["workspaceId", "updatedAt"])
    .index("by_workspace_status_updated", ["workspaceId", "status", "updatedAt"])
    .index("by_workspace_type_updated", ["workspaceId", "type", "updatedAt"])
    .index("by_workspace_priority_updated", ["workspaceId", "priority", "updatedAt"])
    .index("by_workspace_assignee_updated", ["workspaceId", "assigneeAgentPublicId", "updatedAt"])
    .index("by_workspace_parent_updated", ["workspaceId", "parentTaskId", "updatedAt"])
    .index("by_workspace_ready_updated", ["workspaceId", "isReady", "updatedAt"])
    .index("by_workspace_ready_priority_since", [
      "workspaceId",
      "isReady",
      "priority",
      "readySince",
    ])
    .index("by_workspace_blocked_attention_updated", [
      "workspaceId",
      "isBlocked",
      "needsAttention",
      "updatedAt",
    ]),

  taskBodies: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    taskId: v.id("tasks"),
    description: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_workspace_and_task", ["workspaceId", "taskId"]),

  taskDependencies: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    blockerTaskId: v.id("tasks"),
    blockedTaskId: v.id("tasks"),
    kind: v.literal("blocks"),
    createdBy: persistedEventActorValidator,
    createdAt: v.number(),
  })
    .index("by_workspace_blocker_blocked", ["workspaceId", "blockerTaskId", "blockedTaskId"])
    .index("by_workspace_blocked_blocker", ["workspaceId", "blockedTaskId", "blockerTaskId"])
    .index("by_blocked_task_blocker", ["blockedTaskId", "blockerTaskId"])
    .index("by_workspace_blocker_created", ["workspaceId", "blockerTaskId", "createdAt"])
    .index("by_workspace_blocked_created", ["workspaceId", "blockedTaskId", "createdAt"]),

  workspaceLabels: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    name: v.string(),
    createdAt: v.number(),
  }).index("by_workspace_and_name", ["workspaceId", "name"]),

  taskLabels: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    taskId: v.id("tasks"),
    labelId: v.id("workspaceLabels"),
    label: v.string(),
    createdBy: persistedEventActorValidator,
    createdAt: v.number(),
  })
    .index("by_workspace_task_label", ["workspaceId", "taskId", "label"])
    .index("by_workspace_label_task", ["workspaceId", "label", "taskId"])
    .index("by_workspace_task_created", ["workspaceId", "taskId", "createdAt"]),

  taskComments: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    taskId: v.id("tasks"),
    publicId: v.string(),
    body: v.string(),
    actor: persistedEventActorValidator,
    createdAt: v.number(),
  })
    .index("by_public_id", ["publicId"])
    .index("by_workspace_task_created", ["workspaceId", "taskId", "createdAt"]),

  taskCancellations: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    taskId: v.id("tasks"),
    reason: v.string(),
    actor: persistedEventActorValidator,
    cancelledAt: v.number(),
  }).index("by_workspace_task_cancelled", ["workspaceId", "taskId", "cancelledAt"]),

  taskSubmissions: defineTable(taskSubmissionValidator)
    .index("by_public_id", ["publicId"])
    .index("by_task_status_submitted", ["taskId", "status", "submittedAt"])
    .index("by_workspace_task_submitted", ["workspaceId", "taskId", "submittedAt"])
    .index("by_workspace_task_status_submitted", [
      "workspaceId",
      "taskId",
      "status",
      "submittedAt",
    ])
    .index("by_workspace_status_submitted", ["workspaceId", "status", "submittedAt"]),

  workspaceRepositories: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    publicId: v.string(),
    name: v.string(),
    provider: repositoryProviderValidator,
    url: v.string(),
    status: v.union(v.literal("active"), v.literal("removed")),
    createdByUserId: v.id("users"),
    removedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_public_id", ["publicId"])
    .index("by_workspace_status_created", ["workspaceId", "status", "createdAt"])
    .index("by_workspace_and_url", ["workspaceId", "url"]),

  taskRepositoryLinks: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    taskId: v.id("tasks"),
    repositoryId: v.id("workspaceRepositories"),
    createdAt: v.number(),
  }).index("by_workspace_task_repository", [
    "workspaceId",
    "taskId",
    "repositoryId",
  ]),

  taskReferences: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    taskId: v.id("tasks"),
    publicId: v.string(),
    value: taskReferenceValueValidator,
    status: v.union(v.literal("active"), v.literal("removed")),
    createdBy: persistedEventActorValidator,
    removedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_public_id", ["publicId"])
    .index("by_workspace_task_status_created", ["workspaceId", "taskId", "status", "createdAt"]),

  projectionRepairs: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    taskId: v.id("tasks"),
    kind: v.union(
      v.literal("task_readiness"),
      v.literal("task_claim"),
      v.literal("task_review"),
    ),
    generation: v.number(),
    expectedRevision: v.number(),
    status: v.union(v.literal("pending"), v.literal("completed"), v.literal("stale")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_task_kind", ["workspaceId", "taskId", "kind"])
    .index("by_status_and_updated", ["status", "updatedAt"]),

  workspaceUsage: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    activeTasks: v.number(),
    totalTasks: v.number(),
    activeAgents: v.number(),
    updatedAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),

  taskClaims: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    taskId: v.id("tasks"),
    publicId: v.string(),
    agentId: v.id("agents"),
    agentPublicId: v.string(),
    state: claimStateValidator,
    fence: v.number(),
    leaseGeneration: v.number(),
    leaseUntil: v.number(),
    sweepSuppressed: v.optional(v.boolean()),
    endedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_and_task", ["workspaceId", "taskId"])
    .index("by_task_state", ["taskId", "state"])
    .index("by_workspace_task_state", ["workspaceId", "taskId", "state"])
    .index("by_workspace_agent_state", ["workspaceId", "agentId", "state"])
    .index("by_workspace_state_deadline", ["workspaceId", "state", "leaseUntil"])
    .index("by_sweep_suppressed_state_deadline", ["sweepSuppressed", "state", "leaseUntil"])
    .index("by_state_deadline", ["state", "leaseUntil"]),

  taskDispatches: defineTable(taskDispatchValidator)
    .index("by_public_id", ["publicId"])
    .index("by_workspace_and_updated", ["workspaceId", "updatedAt"])
    .index("by_workspace_task_updated", ["workspaceId", "taskId", "updatedAt"])
    .index("by_workspace_retry_source", ["workspaceId", "retryOfDispatchId"])
    .index("by_workspace_task_phase", ["workspaceId", "taskId", "phase"])
    .index("by_workspace_phase_queued", ["workspaceId", "phase", "queuedAt"])
    .index("by_workspace_repository_phase_candidate", [
      "workspaceId",
      "repositoryId",
      "phase",
      "candidateOrderAt",
      "queuedAt",
      "publicId",
    ])
    .index("by_workspace_task_repository_phase", [
      "workspaceId",
      "taskId",
      "repositoryId",
      "phase",
    ])
    .index("by_runner_and_updated", ["runnerId", "updatedAt"])
    .index("by_runner_phase_updated", ["runnerId", "phase", "updatedAt"]),

  taskRunEvents: defineTable(v.union(
    v.object({
      organizationId: v.id("organizations"),
      workspaceId: v.id("workspaces"),
      dispatchId: v.id("taskDispatches"),
      publicId: v.string(),
      sequence: v.number(),
      kind: publicRunStatusEventKindValidator,
      observedAt: v.number(),
    }),
    v.object({
      organizationId: v.id("organizations"),
      workspaceId: v.id("workspaces"),
      dispatchId: v.id("taskDispatches"),
      publicId: v.string(),
      sequence: v.number(),
      kind: publicRunTextEventKindValidator,
      displayText: v.string(),
      observedAt: v.number(),
    }),
  ))
    .index("by_public_id", ["publicId"])
    .index("by_dispatch_and_sequence", ["dispatchId", "sequence"])
    .index("by_workspace_dispatch_sequence", ["workspaceId", "dispatchId", "sequence"]),

  taskRunInteractions: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    dispatchId: v.id("taskDispatches"),
    // Optional only for online compatibility with rows created before the
    // task-level human-input projection. Every current write repairs it.
    taskId: v.optional(v.id("tasks")),
    publicId: v.string(),
    runnerId: v.id("dispatchRunners"),
    runnerPublicId: v.string(),
    bootId: v.string(),
    bootGeneration: v.number(),
    claimPublicId: v.string(),
    claimFence: v.number(),
    request: runInteractionRequestValidator,
    requestDigest: v.string(),
    state: runInteractionStateValidator,
    responseRevision: v.optional(v.number()),
    respondedByUserId: v.optional(v.id("users")),
    respondedAt: v.optional(v.number()),
    resolvedAt: v.optional(v.number()),
    settlementAcknowledgedAt: v.optional(v.number()),
    expiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_public_id", ["publicId"])
    .index("by_dispatch_and_created", ["dispatchId", "createdAt"])
    .index("by_dispatch_state_created", ["dispatchId", "state", "createdAt"])
    .index("by_task_state_created", ["taskId", "state", "createdAt"])
    .index("by_state_and_expiry", ["state", "expiresAt"]),

  taskRunInteractionResponses: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    dispatchId: v.id("taskDispatches"),
    interactionId: v.id("taskRunInteractions"),
    responseRevision: v.number(),
    sealedResponse: sealedRunInteractionResponseValidator,
    createdAt: v.number(),
  })
    .index("by_interaction", ["interactionId"])
    .index("by_dispatch", ["dispatchId"]),

  taskWakes: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    taskId: v.id("tasks"),
    generation: v.number(),
    expectedAvailableAt: v.number(),
    state: wakeStateValidator,
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_workspace_and_task", ["workspaceId", "taskId"])
    .index("by_state_and_available", ["state", "expectedAvailableAt"]),

  taskEvents: defineTable({
    publicId: v.optional(v.string()),
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    taskId: v.id("tasks"),
    taskPublicId: v.string(),
    taskRevision: v.number(),
    type: taskEventTypeValidator,
    schemaVersion: v.literal(1),
    actor: persistedEventActorValidator,
    command: eventCommandValidator,
    payload: publicMetadataValidator,
    createdAt: v.number(),
  })
    .index("by_task", ["taskId"])
    .index("by_workspace_and_task", ["workspaceId", "taskId"])
    .index("by_workspace_and_created", ["workspaceId", "createdAt"]),

  securityEvents: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    agentId: v.optional(v.id("agents")),
    type: securityEventTypeValidator,
    schemaVersion: v.literal(1),
    actor: persistedEventActorValidator,
    command: eventCommandValidator,
    payload: publicMetadataValidator,
    createdAt: v.number(),
  })
    .index("by_workspace_and_agent", ["workspaceId", "agentId"])
    .index("by_workspace_and_created", ["workspaceId", "createdAt"]),

  commandReceipts: defineTable({
    principalKind: v.union(v.literal("agent"), v.literal("enrollment")),
    principalId: v.string(),
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    operation: v.string(),
    idempotencyKey: v.string(),
    // Legacy local rows may still use the string arm; all new writes use bytes.
    requestDigest: v.union(v.bytes(), v.string()),
    requestId: v.string(),
    responseJson: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_scope_principal_operation_key", [
      "organizationId",
      "workspaceId",
      "principalKind",
      "principalId",
      "operation",
      "idempotencyKey",
    ])
    .index("by_workspace_and_expiry", ["workspaceId", "expiresAt"])
    .index("by_expiry", ["expiresAt"]),

  humanCommandReceipts: defineTable({
    principalKind: v.union(v.literal("account"), v.literal("organization")),
    principalId: v.string(),
    organizationId: v.optional(v.id("organizations")),
    operation: v.string(),
    idempotencyKey: v.string(),
    requestDigest: v.union(v.bytes(), v.string()),
    requestId: v.string(),
    responseJson: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_principal_operation_key", [
      "principalKind",
      "principalId",
      "organizationId",
      "operation",
      "idempotencyKey",
    ])
    .index("by_expiry", ["expiresAt"]),

  hostedMutationAttempts: defineTable(v.union(
    v.object({
      organizationId: v.id("organizations"),
      workspaceId: v.id("workspaces"),
      workspacePublicId: v.string(),
      principalId: v.id("users"),
      sourceId: v.string(),
      operation: v.string(),
      fingerprint: v.string(),
      fingerprintKeyVersion: v.string(),
      idempotencyKey: v.string(),
      [LEGACY_HOSTED_MUTATION_OPERATION_ID_FIELD]: v.string(),
      suppliedTaskId: v.string(),
      targetTaskId: v.optional(v.string()),
      state: v.literal("prepared"),
      open: v.literal(true),
      revision: v.literal(1),
      preparedAt: v.number(),
      orderKey: v.string(),
    }),
    v.object({
      organizationId: v.id("organizations"),
      workspaceId: v.id("workspaces"),
      workspacePublicId: v.string(),
      principalId: v.id("users"),
      sourceId: v.string(),
      operation: v.string(),
      fingerprint: v.string(),
      fingerprintKeyVersion: v.string(),
      idempotencyKey: v.string(),
      [LEGACY_HOSTED_MUTATION_OPERATION_ID_FIELD]: v.string(),
      suppliedTaskId: v.string(),
      targetTaskId: v.optional(v.string()),
      state: v.literal("effect-started"),
      open: v.literal(true),
      revision: v.literal(2),
      preparedAt: v.number(),
      orderKey: v.string(),
      effectStartedAt: v.number(),
      // Optional only for effect-started rows created before authoritative
      // receipt linking. Current successful commands patch this in the same
      // transaction as their domain write and human command receipt.
      receiptId: v.optional(v.id("humanCommandReceipts")),
    }),
    v.object({
      organizationId: v.id("organizations"),
      workspaceId: v.id("workspaces"),
      workspacePublicId: v.string(),
      principalId: v.id("users"),
      sourceId: v.string(),
      operation: v.string(),
      fingerprint: v.string(),
      fingerprintKeyVersion: v.string(),
      idempotencyKey: v.string(),
      [LEGACY_HOSTED_MUTATION_OPERATION_ID_FIELD]: v.string(),
      suppliedTaskId: v.string(),
      targetTaskId: v.optional(v.string()),
      state: v.literal("settled"),
      open: v.literal(false),
      revision: v.union(v.literal(2), v.literal(3)),
      preparedAt: v.number(),
      orderKey: v.string(),
      effectStartedAt: v.optional(v.number()),
      receiptId: v.optional(v.id("humanCommandReceipts")),
      settledAt: v.number(),
      // Optional only for terminal rows created before bounded retirement.
      retireAt: v.optional(v.number()),
      settlement: v.union(
        v.object({
          kind: v.literal("confirmed"),
          commandKind: v.string(),
        }),
        v.object({
          kind: v.literal("rejected"),
          code: v.string(),
          retryable: v.boolean(),
        }),
        v.object({
          kind: v.literal("cancelled"),
          reason: v.union(
            v.literal("caller"),
            v.literal("client-closing"),
            v.literal("superseded"),
          ),
        }),
        v.object({
          kind: v.literal("quarantined"),
          reason: v.union(
            v.literal("expired-unack"),
            v.literal("invalid-receipt"),
          ),
        }),
      ),
    }),
  ))
    .index(LEGACY_HOSTED_MUTATION_OPERATION_ID_INDEX, [
      "principalId",
      "workspaceId",
      LEGACY_HOSTED_MUTATION_OPERATION_ID_FIELD,
    ])
    .index("by_principal_workspace_idempotency", [
      "principalId",
      "workspaceId",
      "idempotencyKey",
    ])
    .index("by_principal_organization_operation_idempotency_open", [
      "principalId",
      "organizationId",
      "operation",
      "idempotencyKey",
      "open",
    ])
    .index("by_scope_fingerprint_open", [
      "principalId",
      "workspaceId",
      "sourceId",
      "fingerprint",
      "open",
    ])
    .index("by_scope_open_order", [
      "principalId",
      "workspaceId",
      "sourceId",
      "open",
      "orderKey",
    ])
    .index("by_principal_workspace_open_order", [
      "principalId",
      "workspaceId",
      "open",
      "orderKey",
    ])
    .index("by_open_order", [
      "open",
      "orderKey",
    ])
    .index("by_fingerprint_key_version_open", [
      "fingerprintKeyVersion",
      "open",
      "orderKey",
    ])
    .index("by_open_and_settled", [
      "open",
      "settledAt",
    ])
    .index("by_open_and_retire", [
      "open",
      "retireAt",
    ])
    .index("by_receipt", ["receiptId"]),

  apiRateLimitBuckets: defineTable({
    subjectKind: v.union(
      v.literal("credential"),
      v.literal("workspace"),
      v.literal("user"),
      v.literal("unauthenticated"),
      v.literal("global"),
    ),
    subjectKey: v.string(),
    routeClass: v.union(
      v.literal("agent_read"),
      v.literal("agent_write"),
      v.literal("agent_claim"),
      v.literal("agent_review"),
      v.literal("agent_session"),
      v.literal("human_read"),
      v.literal("human_mutation"),
      v.literal("human_poll"),
      v.literal("desktop_pairing_start"),
      v.literal("desktop_pairing_redeem"),
      v.literal("password_sign_in"),
      v.literal("password_sign_up"),
      v.literal("refresh_auth"),
      v.literal("agent_auth_failure"),
      v.literal("enrollment_auth_failure"),
    ),
    windowStartedAt: v.number(),
    shard: v.number(),
    count: v.number(),
    expiresAt: v.number(),
  })
    .index("by_subject_route_window_shard", [
      "subjectKind",
      "subjectKey",
      "routeClass",
      "windowStartedAt",
      "shard",
    ])
    .index("by_expiry", ["expiresAt"]),

  workspaceProjectionHeads: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    workspacePublicId: v.string(),
    revision: v.number(),
    // Optional while rows written before the scoped-head migration remain.
    // Readers inherit the global revision until the next semantic write
    // materializes this field.
    taskListRevision: v.optional(v.number()),
    // Optional while legacy rows use the single task-list revision. New writes
    // materialize one continuation watermark for each closed human task view.
    taskViewRevisions: v.optional(v.object({
      all: v.number(),
      ready: v.number(),
      blocked: v.number(),
      deferred: v.number(),
      attention: v.number(),
      assigned: v.number(),
      review: v.number(),
    })),
    lastSemanticAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_workspace_public_id", ["workspacePublicId"]),

  workspaceInvalidations: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    workspacePublicId: v.string(),
    projectionRevision: v.number(),
    scope: v.union(
      v.literal("workspace"),
      v.literal("task"),
      v.literal("run"),
    ),
    // Legacy workspace invalidations omit scoped metadata. The transactional
    // writer validates every current combination before it persists the row.
    taskPublicId: v.optional(v.string()),
    runPublicId: v.optional(v.string()),
    views: v.optional(v.array(v.union(
      v.literal("all"),
      v.literal("ready"),
      v.literal("blocked"),
      v.literal("deferred"),
      v.literal("attention"),
      v.literal("assigned"),
      v.literal("review"),
    ))),
    structure: v.optional(v.boolean()),
    createdAt: v.number(),
  })
    .index("by_workspace_and_revision", ["workspaceId", "projectionRevision"])
    .index("by_workspace_public_id_and_revision", [
      "workspacePublicId",
      "projectionRevision",
    ]),

  promotionSessions: defineTable({
    publicId: v.string(),
    organizationId: v.id("organizations"),
    organizationPublicId: v.string(),
    startedByUserId: v.id("users"),
    startedByUserPublicId: v.string(),
    authorizationMembershipId: v.id("organizationMemberships"),
    sourceWorkspacePublicId: v.string(),
    stagingWorkspaceId: v.id("workspaces"),
    stagingWorkspacePublicId: v.string(),
    manifestRoot: v.string(),
    manifestJson: v.string(),
    progressJson: v.string(),
    startIdempotencyKey: v.string(),
    startRequestDigest: v.string(),
    state: v.union(
      v.literal("receiving"),
      v.literal("validating"),
      v.literal("projecting"),
      v.literal("ready"),
      v.literal("activated"),
      v.literal("aborted"),
      v.literal("rejected"),
    ),
    validationFamilyIndex: v.optional(v.number()),
    validationCursor: v.optional(v.string()),
    validationCount: v.optional(v.number()),
    validationDigest: v.optional(v.string()),
    validationLastIdentity: v.optional(v.string()),
    projectionFamilyIndex: v.optional(v.number()),
    projectionCursor: v.optional(v.string()),
    decisionSequence: v.number(),
    activationReceiptJson: v.optional(v.string()),
    activationIdempotencyKey: v.optional(v.string()),
    activationRequestDigest: v.optional(v.string()),
    abortReceiptJson: v.optional(v.string()),
    abortIdempotencyKey: v.optional(v.string()),
    abortRequestDigest: v.optional(v.string()),
    rejectionCode: v.optional(v.union(
      v.literal("authorization_lost"),
      v.literal("staged_entity_invalid"),
      v.literal("family_digest_mismatch"),
      v.literal("projection_incomplete"),
      v.literal("projection_failed"),
    )),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_public_id", ["publicId"])
    .index("by_organization_and_public_id", ["organizationId", "publicId"])
    .index("by_staging_workspace", ["stagingWorkspaceId"])
    .index("by_started_by_and_created", ["startedByUserId", "createdAt"]),

  promotionStagedEntities: defineTable({
    promotionSessionId: v.id("promotionSessions"),
    promotionPublicId: v.string(),
    family: v.string(),
    identity: v.string(),
    entityJson: v.string(),
    acceptedAt: v.number(),
    projectedAt: v.optional(v.number()),
  })
    .index("by_session_family_identity", [
      "promotionSessionId",
      "family",
      "identity",
    ])
    .index("by_session_and_identity", ["promotionSessionId", "identity"])
    .index("by_session", ["promotionSessionId"]),

  promotionBatchReceipts: defineTable({
    promotionSessionId: v.id("promotionSessions"),
    promotionPublicId: v.string(),
    batchId: v.string(),
    family: v.string(),
    ordinal: v.number(),
    requestDigest: v.string(),
    receiptJson: v.string(),
    acceptedAt: v.number(),
  })
    .index("by_session_and_batch", ["promotionSessionId", "batchId"])
    .index("by_session_and_accepted", [
      "promotionSessionId",
      "acceptedAt",
      "batchId",
    ])
    .index("by_session", ["promotionSessionId"]),

  promotionDecisionProofs: defineTable({
    promotionSessionId: v.id("promotionSessions"),
    promotionPublicId: v.string(),
    decision: v.union(
      v.literal("activated"),
      v.literal("aborted_before_activation"),
    ),
    decisionSequence: v.number(),
    proofJson: v.string(),
    createdAt: v.number(),
  })
    .index("by_session", ["promotionSessionId"])
    .index("by_public_id", ["promotionPublicId"]),

  promotionImportedRunSummaries: defineTable({
    promotionSessionId: v.id("promotionSessions"),
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    publicId: v.string(),
    taskPublicId: v.string(),
    summaryJson: v.string(),
    finishedAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_workspace_and_public_id", ["workspaceId", "publicId"])
    .index("by_workspace_task_finished", [
      "workspaceId",
      "taskPublicId",
      "finishedAt",
    ])
    .index("by_session", ["promotionSessionId"]),

  promotionTaskRepositoryLinks: defineTable({
    promotionSessionId: v.id("promotionSessions"),
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    taskId: v.id("tasks"),
    repositoryId: v.id("workspaceRepositories"),
    relationKey: v.string(),
    createdAt: v.number(),
  })
    .index("by_workspace_task_repository", [
      "workspaceId",
      "taskId",
      "repositoryId",
    ])
    .index("by_session", ["promotionSessionId"]),

  promotionImportedSubmissions: defineTable({
    promotionSessionId: v.id("promotionSessions"),
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    taskId: v.id("tasks"),
    publicId: v.string(),
    submissionJson: v.string(),
    createdAt: v.number(),
  })
    .index("by_workspace_task", ["workspaceId", "taskId"])
    .index("by_workspace_and_public_id", ["workspaceId", "publicId"])
    .index("by_session", ["promotionSessionId"]),

  promotionCleanupTombstones: defineTable({
    promotionSessionId: v.id("promotionSessions"),
    promotionPublicId: v.string(),
    scope: v.union(
      v.literal("staging_rows"),
      v.literal("all_promotion_owned_rows"),
    ),
    state: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("complete"),
    ),
    deletedEntityCount: v.number(),
    cursor: v.optional(v.string()),
    decisionProofRetained: v.literal(true),
    updatedAt: v.number(),
  })
    .index("by_session", ["promotionSessionId"])
    .index("by_public_id", ["promotionPublicId"]),

  promotionCleanupReceipts: defineTable({
    promotionSessionId: v.id("promotionSessions"),
    promotionPublicId: v.string(),
    idempotencyKey: v.string(),
    requestDigest: v.string(),
    responseJson: v.string(),
    createdAt: v.number(),
  }).index("by_session_and_key", [
    "promotionSessionId",
    "idempotencyKey",
  ]),

  syncVaults: defineTable({
    tenantId: v.string(),
    organizationCoordinate: v.string(),
    ownerUserCoordinate: v.string(),
    organizationId: v.id("organizations"),
    ownerUserId: v.id("users"),
    vaultId: v.string(),
    vaultGeneration: v.string(),
    status: v.union(v.literal("active"), v.literal("retired")),
    membershipEpoch: v.string(),
    membershipDigest: v.string(),
    recoveryGeneration: v.string(),
    recoveryKeyId: v.string(),
    recoveryPublicKey: v.string(),
    recoveryPublicKeyDigest: v.string(),
    recoveryAgreementKeyId: v.string(),
    recoveryAgreementPublicKey: v.string(),
    recoveryAgreementPublicKeyDigest: v.string(),
    rootKeyEpoch: v.string(),
    rootKeyCommitment: v.string(),
    retainedRootKeyEpochs: v.array(v.string()),
    wrappedRootKeyEpochs: v.array(v.string()),
    directoryVersion: v.string(),
    directoryVersionOrderKey: v.string(),
    changeFloorVersion: v.string(),
    nextDirectoryOrdinal: v.string(),
    activeDeviceCount: v.number(),
    directorySessionCount: v.number(),
    activeStreamCount: v.number(),
    retainedEventCount: v.number(),
    retainedCiphertextBytes: v.number(),
    compatibilityEvidenceCiphertextBytes: v.number(),
    retiredAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_vault_id", ["vaultId"])
    .index("by_human_and_status", ["ownerUserId", "organizationId", "status"])
    .index("by_scope_and_generation", [
      "ownerUserId",
      "organizationId",
      "vaultId",
      "vaultGeneration",
    ]),

  syncMembershipHeads: defineTable({
    vaultId: v.id("syncVaults"),
    organizationId: v.id("organizations"),
    ownerUserId: v.id("users"),
    membershipEpoch: v.string(),
    previousMembershipDigest: v.optional(v.string()),
    statementDigest: v.string(),
    requestDigest: v.string(),
    headJson: v.string(),
    acceptedAt: v.number(),
  })
    .index("by_vault_and_epoch", ["vaultId", "membershipEpoch"])
    .index("by_vault_and_digest", ["vaultId", "statementDigest"]),

  syncMembershipVotes: defineTable({
    vaultId: v.id("syncVaults"),
    proposalId: v.id("syncMembershipProposals"),
    signerDeviceId: v.string(),
    signatureJson: v.string(),
    signedAt: v.number(),
  })
    .index("by_proposal_and_signer", [
      "proposalId",
      "signerDeviceId",
    ])
    .index("by_proposal", ["proposalId"]),

  syncMembershipSigningIntents: defineTable({
    vaultId: v.id("syncVaults"),
    proposalId: v.id("syncMembershipProposals"),
    signerDeviceId: v.string(),
    createdAt: v.number(),
  })
    .index("by_proposal_and_signer", ["proposalId", "signerDeviceId"])
    .index("by_proposal", ["proposalId"]),

  syncMembershipProposals: defineTable({
    vaultId: v.id("syncVaults"),
    parentMembershipEpoch: v.string(),
    parentMembershipDigest: v.string(),
    childMembershipEpoch: v.string(),
    childMembershipDigest: v.string(),
    kind: v.union(v.literal("update"), v.literal("enrollment")),
    enrollmentRequestId: v.optional(v.string()),
    statementJson: v.string(),
    wrappedRootsJson: v.string(),
    rootKeyLinkJson: v.optional(v.string()),
    recoveryRootWrapJson: v.string(),
    state: v.union(
      v.literal("pending"),
      v.literal("accepted"),
      v.literal("expired"),
    ),
    expiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_vault_parent_and_state", [
      "vaultId",
      "parentMembershipEpoch",
      "state",
    ])
    .index("by_expiry", ["expiresAt"])
    .index("by_vault_enrollment_and_state", [
      "vaultId",
      "enrollmentRequestId",
      "state",
    ])
    .index("by_vault_and_child", [
      "vaultId",
      "childMembershipDigest",
    ]),

  syncDevices: defineTable({
    vaultId: v.id("syncVaults"),
    organizationId: v.id("organizations"),
    ownerUserId: v.id("users"),
    deviceId: v.string(),
    name: v.string(),
    status: v.union(v.literal("active"), v.literal("revoked")),
    signingKeyId: v.string(),
    signingPublicKey: v.string(),
    signingPublicKeyDigest: v.string(),
    agreementKeyId: v.string(),
    agreementPublicKey: v.string(),
    agreementPublicKeyDigest: v.string(),
    membershipEpoch: v.string(),
    bootId: v.optional(v.string()),
    bootGeneration: v.optional(v.string()),
    bootEstablishRequestDigest: v.optional(v.string()),
    heartbeatSequence: v.optional(v.string()),
    lastHeartbeatAt: v.optional(v.number()),
    approvedAt: v.number(),
    revokedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_vault_and_device", ["vaultId", "deviceId"])
    .index("by_human_and_device", ["ownerUserId", "organizationId", "deviceId"])
    .index("by_vault_status_and_device", ["vaultId", "status", "deviceId"]),

  syncEnrollmentRequests: defineTable({
    vaultId: v.id("syncVaults"),
    organizationId: v.id("organizations"),
    ownerUserId: v.id("users"),
    requestId: v.string(),
    requestDigest: v.string(),
    deviceId: v.string(),
    name: v.string(),
    keysJson: v.string(),
    pairingDigest: v.string(),
    pairingCode: v.string(),
    pairingTranscriptJson: v.string(),
    state: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("expired"),
    ),
    requestedMembershipEpoch: v.string(),
    approvedMembershipEpoch: v.optional(v.string()),
    approvalRequestDigest: v.optional(v.string()),
    expiresAt: v.number(),
    purgeAfter: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_request_id", ["requestId"])
    .index("by_vault_device_and_state", ["vaultId", "deviceId", "state"])
    .index("by_vault_state_and_expiry", ["vaultId", "state", "expiresAt"])
    .index("by_state_and_expiry", ["state", "expiresAt"])
    .index("by_purge_after", ["purgeAfter"]),

  syncEnrollmentProofNonces: defineTable({
    vaultId: v.id("syncVaults"),
    deviceId: v.string(),
    proofNonce: v.string(),
    purpose: v.union(v.literal("submit"), v.literal("claim")),
    bodyDigest: v.string(),
    issuedAt: v.number(),
    expiresAt: v.number(),
    consumedAt: v.number(),
  })
    .index("by_vault_device_and_nonce", ["vaultId", "deviceId", "proofNonce"])
    .index("by_vault_device_and_expiry", ["vaultId", "deviceId", "expiresAt"])
    .index("by_expiry", ["expiresAt"]),

  syncRateLimitBuckets: defineTable({
    subjectKind: v.union(
      v.literal("human"),
      v.literal("vault"),
      v.literal("device"),
    ),
    subjectKey: v.string(),
    routeClass: v.union(
      v.literal("registration"),
      v.literal("heartbeat"),
      v.literal("read_poll"),
      v.literal("membership"),
      v.literal("ingest"),
    ),
    windowStartedAt: v.number(),
    count: v.number(),
    expiresAt: v.number(),
  })
    .index("by_subject_route_and_window", [
      "subjectKind",
      "subjectKey",
      "routeClass",
      "windowStartedAt",
    ])
    .index("by_expiry", ["expiresAt"]),

  syncVaultRootWraps: defineTable({
    vaultId: v.id("syncVaults"),
    deviceId: v.id("syncDevices"),
    recipientDeviceId: v.string(),
    membershipEpoch: v.string(),
    rootKeyEpoch: v.string(),
    wrappedRootJson: v.string(),
    ciphertextBytes: v.number(),
    createdAt: v.number(),
  })
    .index("by_vault_device_and_epoch", [
      "vaultId",
      "deviceId",
      "rootKeyEpoch",
    ])
    .index("by_vault_device_membership_and_epoch", [
      "vaultId",
      "deviceId",
      "membershipEpoch",
      "rootKeyEpoch",
    ])
    .index("by_vault_and_membership", ["vaultId", "membershipEpoch"]),

  syncVaultRootWrapEvidence: defineTable({
    vaultId: v.id("syncVaults"),
    recipientDeviceId: v.string(),
    membershipEpoch: v.string(),
    rootKeyEpoch: v.string(),
    wrappedRootJson: v.string(),
    ciphertextBytes: v.number(),
    sourceCreatedAt: v.number(),
    archivedAt: v.number(),
  })
    .index("by_vault_and_membership", ["vaultId", "membershipEpoch"])
    .index("by_vault_and_archive", ["vaultId", "archivedAt"]),

  syncVaultRootKeyLinks: defineTable({
    vaultId: v.id("syncVaults"),
    membershipEpoch: v.string(),
    parentRootKeyEpoch: v.string(),
    parentRootKeyEpochOrderKey: v.string(),
    childRootKeyEpoch: v.string(),
    childRootKeyEpochOrderKey: v.string(),
    linkDigest: v.string(),
    linkJson: v.string(),
    ciphertextBytes: v.number(),
    createdAt: v.number(),
  })
    .index("by_vault_and_child_epoch", ["vaultId", "childRootKeyEpochOrderKey"])
    .index("by_vault_and_digest", ["vaultId", "linkDigest"]),

  syncRecoveryRootWraps: defineTable({
    vaultId: v.id("syncVaults"),
    membershipEpoch: v.string(),
    rootKeyEpoch: v.string(),
    recoveryGeneration: v.string(),
    wrapDigest: v.string(),
    wrapJson: v.string(),
    ciphertextBytes: v.number(),
    createdAt: v.number(),
  })
    .index("by_vault_and_membership", ["vaultId", "membershipEpoch"])
    .index("by_vault_and_digest", ["vaultId", "wrapDigest"]),

  syncRecoveryRootWrapEvidence: defineTable({
    vaultId: v.id("syncVaults"),
    membershipEpoch: v.string(),
    rootKeyEpoch: v.string(),
    recoveryGeneration: v.string(),
    wrapDigest: v.string(),
    wrapJson: v.string(),
    ciphertextBytes: v.number(),
    sourceCreatedAt: v.number(),
    archivedAt: v.number(),
  })
    .index("by_vault_and_membership", ["vaultId", "membershipEpoch"])
    .index("by_vault_and_archive", ["vaultId", "archivedAt"]),

  syncProofNonces: defineTable({
    vaultId: v.id("syncVaults"),
    deviceId: v.id("syncDevices"),
    proofNonce: v.string(),
    route: v.string(),
    method: v.union(v.literal("GET"), v.literal("POST")),
    bodyDigest: v.string(),
    issuedAt: v.number(),
    expiresAt: v.number(),
    consumedAt: v.number(),
  })
    .index("by_device_and_nonce", ["deviceId", "proofNonce"])
    .index("by_device_and_expiry", ["deviceId", "expiresAt"])
    .index("by_expiry", ["expiresAt"]),

  syncSessionEntries: defineTable({
    vaultId: v.id("syncVaults"),
    organizationId: v.id("organizations"),
    ownerUserId: v.id("users"),
    sessionId: v.string(),
    originDeviceId: v.id("syncDevices"),
    originDevicePublicId: v.string(),
    directoryOrdinal: v.string(),
    directoryOrdinalOrderKey: v.string(),
    state: v.union(
      v.literal("reserved"),
      v.literal("active"),
      v.literal("tombstone"),
      v.literal("retired"),
    ),
    creationGrantDigest: v.string(),
    creationGrantExpiresAt: v.number(),
    creationGrantConsumedAt: v.optional(v.number()),
    createdDirectoryVersion: v.optional(v.string()),
    mirrorEpoch: v.string(),
    writerGeneration: v.string(),
    writerBootId: v.optional(v.string()),
    writerBootGeneration: v.optional(v.string()),
    currentSequence: v.string(),
    currentDigest: v.optional(v.string()),
    currentSourceRevision: v.string(),
    currentKeyEpoch: v.string(),
    streamActive: v.boolean(),
    latestDirectoryVersion: v.string(),
    latestDirectoryVersionOrderKey: v.string(),
    tombstoneDirectoryVersion: v.optional(v.string()),
    retirementDirectoryVersion: v.optional(v.string()),
    retainedEventCount: v.number(),
    retainedCiphertextBytes: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_vault_and_session", ["vaultId", "sessionId"])
    .index("by_vault_and_ordinal", ["vaultId", "directoryOrdinalOrderKey", "sessionId"])
    .index("by_vault_state_and_ordinal", [
      "vaultId",
      "state",
      "directoryOrdinalOrderKey",
      "sessionId",
    ])
    .index("by_origin_and_state", ["originDeviceId", "state", "sessionId"])
    .index("by_state_and_grant_expiry", ["state", "creationGrantExpiresAt"]),

  syncScheduledChats: defineTable({
    vaultId: v.id("syncVaults"),
    sessionEntryId: v.id("syncSessionEntries"),
    sessionId: v.string(),
    originDeviceId: v.id("syncDevices"),
    originDevicePublicId: v.string(),
    state: v.union(v.literal("active"), v.literal("cleared")),
    generation: v.string(),
    rrule: v.string(),
    timeZone: v.string(),
    nextRunAt: v.optional(v.number()),
    definitionFirstRunAt: v.number(),
    occurrenceSequence: v.string(),
    definitionCiphertextDigest: v.string(),
    definitionCiphertextBytes: v.number(),
    definitionEnvelopeJson: v.string(),
    clearedBy: v.optional(v.union(
      v.literal("user"),
      v.literal("session_deleted"),
      v.literal("schedule_exhausted"),
      v.literal("authority_lost"),
    )),
    clearedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_session_entry", ["sessionEntryId"])
    .index("by_origin_and_session", ["originDeviceId", "sessionId"])
    .index("by_vault_and_session", ["vaultId", "sessionId"])
    .index("by_origin_state_and_due", [
      "originDeviceId",
      "state",
      "nextRunAt",
      "sessionId",
    ])
    .index("by_vault_and_state", ["vaultId", "state", "sessionId"])
    .index("by_state_and_due", ["state", "nextRunAt", "sessionId"]),

  syncScheduledChatWakes: defineTable({
    scheduleId: v.id("syncScheduledChats"),
    vaultId: v.id("syncVaults"),
    sessionEntryId: v.id("syncSessionEntries"),
    originDeviceId: v.id("syncDevices"),
    generation: v.string(),
    occurrenceSequence: v.string(),
    expectedRunAt: v.number(),
    state: v.union(
      v.literal("pending"),
      v.literal("completed"),
      v.literal("stale"),
    ),
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_schedule_generation_and_sequence", [
      "scheduleId",
      "generation",
      "occurrenceSequence",
    ])
    .index("by_schedule_and_state", ["scheduleId", "state"])
    .index("by_state_and_due", ["state", "expectedRunAt"]),

  syncScheduledChatRuns: defineTable({
    scheduleId: v.id("syncScheduledChats"),
    vaultId: v.id("syncVaults"),
    sessionEntryId: v.id("syncSessionEntries"),
    sessionId: v.string(),
    originDeviceId: v.id("syncDevices"),
    runId: v.string(),
    generation: v.string(),
    occurrenceSequence: v.string(),
    scheduledFor: v.number(),
    definitionCiphertextDigest: v.string(),
    definitionEnvelopeJson: v.string(),
    state: v.union(
      v.literal("pending"),
      v.literal("acknowledged"),
      v.literal("cancelled"),
    ),
    acknowledgedBootId: v.optional(v.string()),
    acknowledgedBootGeneration: v.optional(v.string()),
    acknowledgedHasNextRun: v.optional(v.boolean()),
    acknowledgedNextRunAt: v.optional(v.number()),
    acknowledgedAt: v.optional(v.number()),
    cancelledAt: v.optional(v.number()),
    purgeAfter: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_public_id", ["runId"])
    .index("by_schedule_generation_and_sequence", [
      "scheduleId",
      "generation",
      "occurrenceSequence",
    ])
    .index("by_schedule_and_state", ["scheduleId", "state"])
    .index("by_state_and_purge_after", ["state", "purgeAfter"])
    .index("by_origin_state_and_due", [
      "originDeviceId",
      "state",
      "scheduledFor",
      "runId",
    ]),

  syncSessionHeads: defineTable({
    vaultId: v.id("syncVaults"),
    sessionEntryId: v.id("syncSessionEntries"),
    sessionId: v.string(),
    directoryOrdinal: v.string(),
    directoryVersion: v.string(),
    mirrorEpoch: v.string(),
    writerGeneration: v.string(),
    bootId: v.string(),
    bootGeneration: v.string(),
    syncSequence: v.string(),
    sourceRevision: v.string(),
    keyEpoch: v.string(),
    ciphertextDigest: v.string(),
    ciphertextBytes: v.number(),
    envelopeJson: v.string(),
    observedAt: v.number(),
  })
    .index("by_session_entry", ["sessionEntryId"])
    .index("by_vault_and_session", ["vaultId", "sessionId"]),

  syncSessionEvents: defineTable({
    vaultId: v.id("syncVaults"),
    sessionEntryId: v.id("syncSessionEntries"),
    sessionId: v.string(),
    directoryVersion: v.string(),
    directoryVersionOrderKey: v.string(),
    mirrorEpoch: v.string(),
    syncSequence: v.string(),
    sourceRevision: v.string(),
    keyEpoch: v.string(),
    eventKind: v.string(),
    ciphertextDigest: v.string(),
    ciphertextBytes: v.number(),
    envelopeJson: v.string(),
    observedAt: v.number(),
  })
    .index("by_session_and_sequence", ["sessionEntryId", "mirrorEpoch", "syncSequence"])
    .index("by_session_and_directory_version", [
      "sessionEntryId",
      "directoryVersionOrderKey",
    ])
    .index("by_vault_and_observed", ["vaultId", "observedAt"]),

  syncRecoveryTransitions: defineTable({
    vaultId: v.id("syncVaults"),
    organizationId: v.id("organizations"),
    ownerUserId: v.id("users"),
    recoveryNonce: v.string(),
    requestDigest: v.string(),
    priorMembershipDigest: v.string(),
    priorRecoveryGeneration: v.string(),
    acceptedMembershipDigest: v.string(),
    responseJson: v.string(),
    acceptedAt: v.number(),
  })
    .index("by_vault_and_nonce", ["vaultId", "recoveryNonce"]),

  syncSessionTombstones: defineTable({
    vaultId: v.id("syncVaults"),
    sessionEntryId: v.id("syncSessionEntries"),
    sessionId: v.string(),
    directoryOrdinal: v.string(),
    directoryVersion: v.string(),
    directoryVersionOrderKey: v.string(),
    tombstoneDigest: v.string(),
    tombstoneJson: v.string(),
    purgeAfter: v.number(),
    createdAt: v.number(),
  })
    .index("by_session_entry", ["sessionEntryId"])
    .index("by_vault_and_session", ["vaultId", "sessionId"])
    .index("by_purge_after", ["purgeAfter"]),

  syncRetiredSessionIds: defineTable({
    vaultId: v.id("syncVaults"),
    sessionEntryId: v.id("syncSessionEntries"),
    sessionId: v.string(),
    directoryOrdinal: v.string(),
    retirementDirectoryVersion: v.string(),
    retirementDirectoryVersionOrderKey: v.string(),
    tombstoneDigest: v.string(),
    fenceJson: v.string(),
    retiredAt: v.number(),
  })
    .index("by_vault_and_session", ["vaultId", "sessionId"])
    .index("by_session_entry", ["sessionEntryId"]),

  syncDirectoryChanges: defineTable({
    vaultId: v.id("syncVaults"),
    directoryVersion: v.string(),
    directoryVersionOrderKey: v.string(),
    kind: v.union(
      v.literal("upsert"),
      v.literal("tombstone"),
      v.literal("retired"),
      v.literal("mirror_reset"),
    ),
    sessionEntryId: v.id("syncSessionEntries"),
    eventId: v.optional(v.id("syncSessionEvents")),
    tombstoneId: v.optional(v.id("syncSessionTombstones")),
    retiredFenceId: v.optional(v.id("syncRetiredSessionIds")),
    payloadJson: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_vault_and_version", ["vaultId", "directoryVersionOrderKey"]),

  syncSnapshotPins: defineTable({
    vaultId: v.id("syncVaults"),
    deviceId: v.id("syncDevices"),
    snapshotId: v.string(),
    snapshotVersion: v.string(),
    snapshotVersionOrderKey: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_device_and_snapshot", ["deviceId", "snapshotId"])
    .index("by_vault_and_expiry", ["vaultId", "expiresAt"])
    .index("by_expiry", ["expiresAt"]),

  syncSnapshotEntries: defineTable({
    vaultId: v.id("syncVaults"),
    snapshotPinId: v.id("syncSnapshotPins"),
    directoryOrdinal: v.string(),
    directoryOrdinalOrderKey: v.string(),
    sessionId: v.string(),
    entryJson: v.string(),
    createdAt: v.number(),
  })
    .index("by_pin_and_ordinal", [
      "snapshotPinId",
      "directoryOrdinalOrderKey",
      "sessionId",
    ])
    .index("by_pin", ["snapshotPinId"]),
});
