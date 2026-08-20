import { cronJobs, makeFunctionReference } from "convex/server";

import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("sweep overdue task claims", { minutes: 1 }, internal.schedules.sweepOverdueClaims, {});

crons.interval("sweep due task wakes", { minutes: 1 }, internal.schedules.sweepDueWakes, {});

crons.interval(
  "sweep expired API rate-limit buckets",
  { minutes: 1 },
  internal.rateLimits.sweepExpired,
  {},
);

crons.interval(
  "retire expired session sync state",
  { minutes: 1 },
  makeFunctionReference<"mutation">("sessionSyncModel:retireExpiredSyncState"),
  {},
);

crons.interval(
  "sweep due scheduled chats",
  { minutes: 1 },
  makeFunctionReference<"mutation">(
    "sessionSyncScheduledChats:sweepDueScheduledChats",
  ),
  {},
);

crons.interval(
  "reconcile stale hosted mutation attempts",
  { hours: 24 },
  internal.hostedMutationAttempts.sweepStaleOpenAttempts,
  {},
);

crons.interval(
  "retire hosted mutation audit tombstones",
  { hours: 24 },
  internal.hostedMutationAttempts.sweepSettledTombstones,
  {},
);

crons.interval(
  "sweep expired human command receipts",
  { hours: 24 },
  internal.receiptMaintenance.sweepExpiredHumanReceipts,
  {},
);

crons.interval(
  "sweep expired agent command receipts",
  { hours: 24 },
  internal.receiptMaintenance.sweepExpiredAgentReceipts,
  {},
);

crons.interval(
  "reconcile WorkOS memberships",
  { minutes: 15 },
  internal.identitySync.reconcileWorkOSMemberships,
  {},
);

crons.interval(
  "discover WorkOS memberships",
  { minutes: 15 },
  internal.identitySync.discoverWorkOSMemberships,
  {},
);

export default crons;
