import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import {
  accountBindingState,
  accountDeletionCategory,
  accountDeletionState,
  authAttemptKind,
  authSubjectStatus,
  challengeDeliveryState,
  commandKind,
  commandState,
  deviceRevocationCategory,
  deviceRevocationState,
  deviceStatus,
  encryptedEnvelope,
  invitePurpose,
  inviteState,
  maintenanceCategory,
  quotaCategory,
  quotaAccountResource,
  quotaEnforcement,
  quotaUserResource,
  sessionStatus,
  syncStream,
  usageAdmissionAuthority,
  usageEncryptedEnvelope,
  wrappedKeyEnvelope,
} from "./validators";

export default defineSchema({
  ...authTables,
  authVerifiers: defineTable({
    sessionId: v.optional(v.id("authSessions")),
    signature: v.optional(v.string()),
  })
    .index("signature", ["signature"])
    .index("sessionId", ["sessionId"]),
  authSubjects: defineTable({
    admissionInviteId: v.optional(v.id("authInvites")),
    authEpoch: v.number(),
    createdAt: v.number(),
    emailDigest: v.string(),
    status: authSubjectStatus,
    updatedAt: v.number(),
    userId: v.optional(v.id("users")),
    verifiedAt: v.optional(v.number()),
  })
    .index("by_email_digest", ["emailDigest"])
    .index("by_unverified_status_and_updated_at", ["verifiedAt", "status", "updatedAt"])
    .index("by_user", ["userId"]),
  authEmailAttemptEvents: defineTable({
    authEpoch: v.number(),
    createdAt: v.number(),
    emailDigest: v.string(),
    expiresAt: v.number(),
    kind: authAttemptKind,
  })
    .index("by_email_kind_and_created_at", ["emailDigest", "kind", "createdAt"])
    .index("by_expires_at", ["expiresAt"])
    .index("by_kind_and_created_at", ["kind", "createdAt"]),
  authOtpChallenges: defineTable({
    accountId: v.id("authAccounts"),
    authEpoch: v.number(),
    codeDigest: v.string(),
    createdAt: v.number(),
    deliveryState: challengeDeliveryState,
    emailDigest: v.string(),
    expiresAt: v.number(),
    updatedAt: v.number(),
    userId: v.id("users"),
  })
    .index("by_email", ["emailDigest"])
    .index("by_expires_at", ["expiresAt"])
    .index("by_user", ["userId"]),
  authInvites: defineTable({
    admissionExpiresAt: v.optional(v.number()),
    boundAt: v.optional(v.number()),
    boundEmailDigest: v.optional(v.string()),
    capabilityDigest: v.string(),
    consumedAt: v.optional(v.number()),
    createdAt: v.number(),
    expiresAt: v.number(),
    issuedByUserId: v.optional(v.id("users")),
    publicId: v.string(),
    purpose: invitePurpose,
    requestedLifetimeMs: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    state: inviteState,
    updatedAt: v.number(),
  })
    .index("by_capability_digest", ["capabilityDigest"])
    .index("by_bound_email_digest", ["boundEmailDigest"])
    .index("by_expiry", ["expiresAt"])
    .index("by_issuer", ["issuedByUserId"])
    .index("by_public_id", ["publicId"]),
  devices: defineTable({
    activatedAt: v.optional(v.number()),
    authEpoch: v.number(),
    createdAt: v.number(),
    credentialGeneration: v.optional(v.number()),
    encryptedLabel: encryptedEnvelope,
    keyVersion: v.number(),
    publicId: v.string(),
    registrationBootstrapKeyEnvelope: v.optional(wrappedKeyEnvelope),
    registrationIdempotencyKey: v.optional(v.string()),
    registrationRequestDigest: v.optional(v.string()),
    revision: v.number(),
    revokedAt: v.optional(v.number()),
    signingPublicKey: v.string(),
    status: deviceStatus,
    updatedAt: v.number(),
    userId: v.id("users"),
    wrappingPublicKey: v.string(),
  })
    .index("by_public_id", ["publicId"])
    .index("by_user_and_public_id", ["userId", "publicId"])
    .index("by_user_and_status", ["userId", "status"]),
  deviceSessions: defineTable({
    authEpoch: v.number(),
    authSessionId: v.id("authSessions"),
    boundAt: v.number(),
    deviceId: v.id("devices"),
    revokedAt: v.optional(v.number()),
    userId: v.id("users"),
  })
    .index("by_auth_session", ["authSessionId"])
    .index("by_device", ["deviceId"])
    .index("by_user", ["userId"]),
  deviceBindChallenges: defineTable({
    authSessionId: v.id("authSessions"),
    challengeId: v.string(),
    consumedAt: v.optional(v.number()),
    createdAt: v.number(),
    deviceId: v.id("devices"),
    expiresAt: v.number(),
    nonce: v.string(),
    userId: v.id("users"),
  })
    .index("by_challenge", ["challengeId"])
    .index("by_device", ["deviceId"])
    .index("by_expiry", ["expiresAt"])
    .index("by_user", ["userId"]),
  deviceKeyEnvelopes: defineTable({
    createdAt: v.number(),
    deviceId: v.id("devices"),
    envelope: wrappedKeyEnvelope,
    userId: v.id("users"),
  })
    .index("by_device_and_version", ["deviceId", "envelope.keyVersion"])
    .index("by_user", ["userId"]),
  recoveryEnvelopes: defineTable({
    createdAt: v.number(),
    envelope: encryptedEnvelope,
    recoveryVerifierDigest: v.string(),
    retiredAt: v.optional(v.number()),
    userId: v.id("users"),
  })
    .index("by_user_and_version", ["userId", "envelope.keyVersion"])
    .index("by_user", ["userId"]),
  devicePresence: defineTable({
    authEpoch: v.number(),
    connectionId: v.string(),
    connectionSequence: v.number(),
    credentialGeneration: v.number(),
    deviceId: v.id("devices"),
    fingerprint: v.string(),
    observedAt: v.number(),
    presenceUntil: v.number(),
    userId: v.id("users"),
  })
    .index("by_device", ["deviceId"])
    .index("by_presence_until", ["presenceUntil"])
    .index("by_user", ["userId"]),
  sessionHeads: defineTable({
    compactHasRecoveryGap: v.optional(v.boolean()),
    compactHeadSequence: v.number(),
    compactStreamEpoch: v.optional(v.number()),
    compactTailDigest: v.optional(v.string()),
    createdAt: v.number(),
    detailHeadSequence: v.number(),
    detailTailDigest: v.optional(v.string()),
    executionDeviceId: v.id("devices"),
    metadata: v.optional(encryptedEnvelope),
    metadataRevision: v.number(),
    projectionRevision: v.number(),
    publicId: v.string(),
    state: sessionStatus,
    updatedAt: v.number(),
    userId: v.id("users"),
  })
    .index("by_execution_device", ["executionDeviceId"])
    .index("by_execution_device_and_state", ["executionDeviceId", "state"])
    .index("by_public_id", ["publicId"])
    .index("by_user_and_public_id", ["userId", "publicId"])
    .index("by_user_and_updated_at", ["userId", "updatedAt"]),
  sessionChunks: defineTable({
    authority: v.object({
      bootGeneration: v.number(),
      bootId: v.string(),
      fence: v.number(),
    }),
    createdAt: v.number(),
    digest: v.string(),
    envelope: encryptedEnvelope,
    firstSequence: v.number(),
    lastSequence: v.number(),
    previousDigest: v.optional(v.string()),
    sessionId: v.id("sessionHeads"),
    sourceDeviceId: v.id("devices"),
    stream: syncStream,
    streamEpoch: v.optional(v.number()),
    userId: v.id("users"),
  })
    .index("by_session_stream_and_first", ["sessionId", "stream", "firstSequence"])
    .index("by_session_stream_and_last", ["sessionId", "stream", "lastSequence"])
    .index("by_user", ["userId"]),
  sessionStreamEpochs: defineTable({
    authority: v.object({
      bootGeneration: v.number(),
      bootId: v.string(),
      fence: v.number(),
    }),
    boundaryHeadSequence: v.number(),
    boundaryTailDigest: v.optional(v.string()),
    createdAt: v.number(),
    epoch: v.number(),
    idempotencyKey: v.string(),
    lineageCommitment: v.string(),
    predecessorEpoch: v.number(),
    projectionRevision: v.optional(v.number()),
    publicId: v.string(),
    reason: v.literal("projection_cache_recovery"),
    requestDigest: v.string(),
    sessionId: v.id("sessionHeads"),
    sourceDeviceId: v.id("devices"),
    stream: v.literal("compact"),
    userId: v.id("users"),
  })
    .index("by_public_id", ["publicId"])
    .index("by_session_stream_and_epoch", ["sessionId", "stream", "epoch"])
    .index("by_user_session_stream_and_epoch", [
      "userId",
      "sessionId",
      "stream",
      "epoch",
    ])
    .index("by_user", ["userId"]),
  executionLeases: defineTable({
    bootGeneration: v.number(),
    bootId: v.string(),
    deviceId: v.id("devices"),
    fence: v.number(),
    heartbeatFingerprint: v.string(),
    heartbeatSequence: v.number(),
    leaseUntil: v.number(),
    sessionId: v.id("sessionHeads"),
    updatedAt: v.number(),
    userId: v.id("users"),
  })
    .index("by_session", ["sessionId"])
    .index("by_device", ["deviceId"])
    .index("by_user", ["userId"]),
  sessionCommands: defineTable({
    boundAuthority: v.optional(v.object({
      bootGeneration: v.number(),
      bootId: v.string(),
      fence: v.number(),
    })),
    createdAt: v.number(),
    deadline: v.number(),
    idempotencyKey: v.string(),
    kind: commandKind,
    nonterminal: v.boolean(),
    payload: encryptedEnvelope,
    publicId: v.string(),
    requestDigest: v.string(),
    requestingDeviceId: v.id("devices"),
    requesterAcknowledgedAt: v.optional(v.number()),
    result: v.optional(encryptedEnvelope),
    resultCode: v.optional(v.string()),
    resultDigest: v.optional(v.string()),
    sessionId: v.id("sessionHeads"),
    state: commandState,
    targetDeviceId: v.id("devices"),
    terminalCleanupAfter: v.optional(v.number()),
    updatedAt: v.number(),
    userId: v.id("users"),
  })
    .index("by_public_id", ["publicId"])
    .index("by_session_and_created_at", ["sessionId", "createdAt"])
    .index("by_session_and_state", ["sessionId", "state"])
    .index("by_target_state_and_created_at", ["targetDeviceId", "state", "createdAt"])
    .index("by_target_nonterminal_and_created_at", ["targetDeviceId", "nonterminal", "createdAt"])
    .index("by_requesting_device_and_nonterminal", ["requestingDeviceId", "nonterminal", "createdAt"])
    .index("by_state_and_deadline", ["state", "deadline"])
    .index("by_state_and_updated_at", ["state", "updatedAt"])
    .index("by_state_and_cleanup_after", ["state", "terminalCleanupAfter"])
    .index("by_idempotency", [
      "userId",
      "sessionId",
      "requestingDeviceId",
      "kind",
      "idempotencyKey",
    ])
    .index("by_user", ["userId"]),
  codexAccounts: defineTable({
    createdAt: v.number(),
    encryptedMetadata: encryptedEnvelope,
    matchKey: v.string(),
    publicId: v.string(),
    updatedAt: v.number(),
    userId: v.id("users"),
  })
    .index("by_user_and_match_key", ["userId", "matchKey"])
    .index("by_user_and_public_id", ["userId", "publicId"]),
  deviceAccountBindings: defineTable({
    accountId: v.id("codexAccounts"),
    deviceId: v.id("devices"),
    encryptedLocalReference: encryptedEnvelope,
    lastSeenAt: v.number(),
    sourceGeneration: v.number(),
    state: accountBindingState,
    updatedAt: v.number(),
    usageAdmission: v.optional(usageAdmissionAuthority),
    userId: v.id("users"),
  })
    .index("by_device_and_account", ["deviceId", "accountId"])
    .index("by_user_and_account", ["userId", "accountId"])
    .index("by_user", ["userId"]),
  accountUsageSnapshots: defineTable({
    accountId: v.id("codexAccounts"),
    createdAt: v.number(),
    digest: v.string(),
    envelope: usageEncryptedEnvelope,
    observedAt: v.number(),
    receivedAt: v.number(),
    sourceDeviceId: v.id("devices"),
    sourceDevicePublicId: v.string(),
    sourceRevision: v.number(),
    userId: v.id("users"),
  })
    .index("by_account_and_observed_at", ["accountId", "observedAt"])
    .index("by_account_and_received_at", ["accountId", "receivedAt"])
    .index("by_observed_at", ["observedAt"])
    .index("by_received_at", ["receivedAt"])
    .index("by_account_and_winner", [
      "accountId",
      "observedAt",
      "sourceDevicePublicId",
      "sourceRevision",
    ])
    .index("by_source_revision", ["accountId", "sourceDeviceId", "sourceRevision"])
    .index("by_user", ["userId"]),
  idempotencyReceipts: defineTable({
    createdAt: v.number(),
    deviceId: v.optional(v.id("devices")),
    expiresAt: v.number(),
    idempotencyKey: v.string(),
    operation: v.string(),
    requestDigest: v.string(),
    responseJson: v.string(),
    scopeId: v.string(),
    userId: v.id("users"),
  })
    .index("by_scope_and_key", [
      "userId",
      "deviceId",
      "operation",
      "scopeId",
      "idempotencyKey",
    ])
    .index("by_expiry", ["expiresAt"])
    .index("by_user", ["userId"]),
  securityEvents: defineTable({
    actorDeviceId: v.optional(v.id("devices")),
    createdAt: v.number(),
    entityId: v.string(),
    event: v.union(
      v.literal("device_registered"),
      v.literal("device_activated"),
      v.literal("device_bound"),
      v.literal("device_revoked"),
      v.literal("lease_acquired"),
      v.literal("command_enqueued"),
      v.literal("command_terminal"),
      v.literal("account_key_rotated"),
    ),
    userId: v.id("users"),
  })
    .index("by_created_at", ["createdAt"])
    .index("by_user_and_created_at", ["userId", "createdAt"]),
  accountDeletionJobs: defineTable({
    category: accountDeletionCategory,
    createdAt: v.number(),
    publicId: v.string(),
    state: accountDeletionState,
    statusCapabilityDigest: v.string(),
    subjectId: v.id("authSubjects"),
    updatedAt: v.number(),
    userId: v.id("users"),
  })
    .index("by_public_id", ["publicId"])
    .index("by_state_and_updated_at", ["state", "updatedAt"])
    .index("by_user", ["userId"]),
  accountDeletionReceipts: defineTable({
    completedAt: v.number(),
    expiresAt: v.number(),
    publicId: v.string(),
    statusCapabilityDigest: v.string(),
  })
    .index("by_expiry", ["expiresAt"])
    .index("by_public_id", ["publicId"]),
  deviceRevocationJobs: defineTable({
    category: deviceRevocationCategory,
    createdAt: v.number(),
    deviceId: v.id("devices"),
    publicId: v.string(),
    state: deviceRevocationState,
    updatedAt: v.number(),
    userId: v.id("users"),
  })
    .index("by_device", ["deviceId"])
    .index("by_public_id", ["publicId"])
    .index("by_state_and_updated_at", ["state", "updatedAt"])
    .index("by_user", ["userId"]),
  storageUsageByUser: defineTable({
    category: quotaCategory,
    logicalBytes: v.number(),
    records: v.number(),
    updatedAt: v.number(),
    userId: v.id("users"),
  }).index("by_user_and_category", ["userId", "category"]),
  storageUsageService: defineTable({
    enforcement: quotaEnforcement,
    identities: v.number(),
    key: v.literal("global"),
    logicalBytes: v.number(),
    records: v.number(),
    serviceLogicalBytes: v.number(),
    serviceRecords: v.number(),
    updatedAt: v.number(),
    userLogicalBytes: v.number(),
    userRecords: v.number(),
  }).index("by_key", ["key"]),
  storageResourceUsageByUser: defineTable({
    records: v.number(),
    resource: quotaUserResource,
    updatedAt: v.number(),
    userId: v.id("users"),
  }).index("by_user_and_resource", ["userId", "resource"]),
  storageResourceUsageByAccount: defineTable({
    accountId: v.id("codexAccounts"),
    records: v.number(),
    resource: quotaAccountResource,
    updatedAt: v.number(),
    userId: v.id("users"),
  })
    .index("by_account_and_resource", ["accountId", "resource"])
    .index("by_user", ["userId"]),
  maintenanceState: defineTable({
    key: v.literal("retention"),
    nextCategory: maintenanceCategory,
    updatedAt: v.number(),
  }).index("by_key", ["key"]),
});
