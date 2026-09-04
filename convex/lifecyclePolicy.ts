export const CLOUD_USAGE_SNAPSHOT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

// live_tail retention for detail-stream chunks: keep the current and
// previous turn. The corpus this plan is based on (23,699 measured turns)
// has a p90 turn duration of 4,919s (~82 minutes), so a 6-hour TTL keeps the
// current and previous turn in the overwhelming majority of sessions while
// still reclaiming abandoned-session storage promptly. This is the sweeper's
// time-based backstop; the row cap below is the size-based backstop.
export const LIVE_TAIL_CHUNK_TTL_MS = 6 * 60 * 60 * 1_000;

// Soft per-session cap on detail (live_tail) chunk rows. Enforcement in
// appendChunk is amortized: it only prunes once a session is
// LIVE_TAIL_ROW_CAP_TRIGGER rows over the cap, deleting back down to the cap
// in one batch, so the true row count is allowed to drift up to the trigger
// between prunes rather than doing a delete (and a fresh retention epoch)
// on every single append past 200.
export const LIVE_TAIL_ROW_CAP = 200;
export const LIVE_TAIL_ROW_CAP_TRIGGER = 20;

export type HostedTableLifecycle = Readonly<{
  owner: "user" | "parent" | "email_digest" | "capability" | "service";
  quota: "identity" | "device" | "account" | "session" | "chunk" | "usage" | "command" | "custody" | "receipt" | "security" | "job" | null;
  retention: "auth_library" | "challenge_expiry" | "invite_expiry" | "active" | "encrypted_history" | "live_tail" | "lease_expiry" | "command_recovery" | "usage_90d_daily" | "receipt_expiry" | "security_90d" | "job_until_complete" | "service_permanent";
  deletionOrder: number | null;
  disposition: "erase" | "expire" | "complete_receipt" | "service_reset";
}>;

// sessionChunks and sessionStreamEpochs are declared "encrypted_history"
// below: this is the table-wide (bulk) retention class shared by every
// compact-stream row, which is never swept on its own schedule. Detail-
// stream ("live_tail") rows in the same two tables are additionally, and
// more aggressively, governed row-by-row by the live_tail retention class:
// current and previous turn, at most 200 rows per session, enforced by the
// live_tail_chunks maintenance sweeper (see convex/maintenance.ts) rather
// than by table-uniform retention. This constant records that per-row
// exception; it does not change the table-level entries themselves.
export const DETAIL_CHUNK_RETENTION: HostedTableLifecycle["retention"] = "live_tail";

export const HOSTED_TABLE_LIFECYCLE = {
  users: { owner: "user", quota: "identity", retention: "auth_library", deletionOrder: 130, disposition: "erase" },
  authSessions: { owner: "user", quota: "identity", retention: "auth_library", deletionOrder: 100, disposition: "erase" },
  authAccounts: { owner: "user", quota: "identity", retention: "auth_library", deletionOrder: 120, disposition: "erase" },
  authRefreshTokens: { owner: "parent", quota: "identity", retention: "auth_library", deletionOrder: 90, disposition: "erase" },
  authVerificationCodes: { owner: "parent", quota: "identity", retention: "challenge_expiry", deletionOrder: 110, disposition: "erase" },
  authVerifiers: { owner: "parent", quota: "identity", retention: "auth_library", deletionOrder: 90, disposition: "erase" },
  authRateLimits: { owner: "email_digest", quota: "identity", retention: "auth_library", deletionOrder: 120, disposition: "erase" },
  authSubjects: { owner: "user", quota: "identity", retention: "active", deletionOrder: 140, disposition: "erase" },
  authEmailAttemptEvents: { owner: "email_digest", quota: "identity", retention: "challenge_expiry", deletionOrder: 80, disposition: "expire" },
  authOtpChallenges: { owner: "user", quota: "identity", retention: "challenge_expiry", deletionOrder: 110, disposition: "erase" },
  authInvites: { owner: "capability", quota: "identity", retention: "invite_expiry", deletionOrder: 80, disposition: "expire" },
  devices: { owner: "user", quota: "device", retention: "active", deletionOrder: 70, disposition: "erase" },
  deviceSessions: { owner: "user", quota: "custody", retention: "active", deletionOrder: 60, disposition: "erase" },
  deviceBindChallenges: { owner: "user", quota: "custody", retention: "challenge_expiry", deletionOrder: 60, disposition: "erase" },
  deviceKeyEnvelopes: { owner: "user", quota: "custody", retention: "active", deletionOrder: 60, disposition: "erase" },
  recoveryEnvelopes: { owner: "user", quota: "custody", retention: "active", deletionOrder: 60, disposition: "erase" },
  devicePresence: { owner: "user", quota: "device", retention: "lease_expiry", deletionOrder: 60, disposition: "erase" },
  deviceRegistries: { owner: "user", quota: "custody", retention: "active", deletionOrder: 60, disposition: "erase" },
  sessionHeads: { owner: "user", quota: "session", retention: "encrypted_history", deletionOrder: 30, disposition: "erase" },
  sessionChunks: { owner: "user", quota: "chunk", retention: "encrypted_history", deletionOrder: 20, disposition: "erase" },
  sessionStreamEpochs: { owner: "user", quota: "chunk", retention: "encrypted_history", deletionOrder: 20, disposition: "erase" },
  executionLeases: { owner: "user", quota: "session", retention: "lease_expiry", deletionOrder: 10, disposition: "erase" },
  sessionCommands: { owner: "user", quota: "command", retention: "command_recovery", deletionOrder: 10, disposition: "erase" },
  codexAccounts: { owner: "user", quota: "account", retention: "active", deletionOrder: 50, disposition: "erase" },
  deviceAccountBindings: { owner: "user", quota: "account", retention: "active", deletionOrder: 40, disposition: "erase" },
  accountUsageSnapshots: { owner: "user", quota: "usage", retention: "usage_90d_daily", deletionOrder: 40, disposition: "erase" },
  idempotencyReceipts: { owner: "user", quota: "receipt", retention: "receipt_expiry", deletionOrder: 80, disposition: "erase" },
  securityEvents: { owner: "user", quota: "security", retention: "security_90d", deletionOrder: 80, disposition: "erase" },
  accountDeletionJobs: { owner: "user", quota: "job", retention: "job_until_complete", deletionOrder: 150, disposition: "complete_receipt" },
  accountDeletionReceipts: { owner: "capability", quota: "receipt", retention: "receipt_expiry", deletionOrder: null, disposition: "expire" },
  deviceRevocationJobs: { owner: "user", quota: "job", retention: "job_until_complete", deletionOrder: 80, disposition: "erase" },
  storageUsageByUser: { owner: "user", quota: null, retention: "active", deletionOrder: 150, disposition: "erase" },
  storageUsageService: { owner: "service", quota: null, retention: "service_permanent", deletionOrder: null, disposition: "service_reset" },
  serviceControl: { owner: "service", quota: null, retention: "service_permanent", deletionOrder: null, disposition: "service_reset" },
  storageResourceUsageByUser: { owner: "user", quota: null, retention: "active", deletionOrder: 150, disposition: "erase" },
  storageResourceUsageByAccount: { owner: "user", quota: null, retention: "active", deletionOrder: 150, disposition: "erase" },
  maintenanceState: { owner: "service", quota: null, retention: "service_permanent", deletionOrder: null, disposition: "service_reset" },
} as const satisfies Readonly<Record<string, HostedTableLifecycle>>;
