export {
  bootstrapSyncVaultRequestSchema,
  claimSyncEnrollmentIntentSchema,
  claimSyncEnrollmentRequestSchema,
  MAX_SESSION_SYNC_HTTP_BODY_BYTES,
  MAX_SESSION_SYNC_REQUEST_JSON_BYTES,
  MAX_SESSION_SYNC_RESPONSE_JSON_BYTES,
  parseBootstrapSyncVaultRequestJson,
  parseClaimSyncEnrollmentRequestJson,
  parseRecoverSyncVaultRequestJson,
  parseReadSyncRecoveryContextRequestJson,
  parseSessionSyncHelloJson,
  parseSessionSyncProofJson,
  parseSessionSyncRequestJson,
  parseSessionSyncResponseJson,
  parseSubmitSyncEnrollmentRequestJson,
  routeForSessionSyncRequest,
  SESSION_SYNC_BACKEND_REQUEST_VERSION,
  readSyncRecoveryContextRequestSchema,
  sessionSyncBackendErrorCodes,
  sessionSyncBackendNonRateErrorCodes,
  sessionSyncBackendErrorCodeSchema,
  sessionSyncBackendRequestSchema,
  sessionSyncBackendResponseSchema,
  sessionSyncBackendResultSchema,
  sessionSyncHttpRoutes,
  sessionSyncHumanInvocationSchema,
  sessionSyncEnrollmentRequestIdSchema,
  sessionSyncInvocationSchema,
  sessionSyncNegotiationInvocationSchema,
  sessionSyncSnapshotIdSchema,
  submitSyncEnrollmentIntentSchema,
  submitSyncEnrollmentRequestSchema,
  type BootstrapSyncVaultRequest,
  type ClaimSyncEnrollmentRequest,
  type RecoverSyncVaultRequest,
  type SessionSyncBackendErrorCode,
  type SessionSyncBackendRequest,
  type SessionSyncBackendResponse,
  type SessionSyncBackendResult,
  type SubmitSyncEnrollmentRequest,
} from "@hraness/agent-tasks-protocol";

export const SESSION_SYNC_SNAPSHOT_TTL_MS = 30_000;
export const SESSION_SYNC_CREATION_GRANT_TTL_MS = 2 * 60_000;
export const SESSION_SYNC_TOMBSTONE_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const SESSION_SYNC_ENROLLMENT_TTL_MS = 10 * 60_000;
export const SESSION_SYNC_ENROLLMENT_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const SESSION_SYNC_MEMBERSHIP_PROPOSAL_TTL_MS = 10 * 60_000;
export const MAX_SESSION_SYNC_PENDING_ENROLLMENTS = 8;
