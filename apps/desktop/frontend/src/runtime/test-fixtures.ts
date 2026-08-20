import {
  runtimeProtocolVersion,
  type AccountSummary,
  type RuntimeEvent,
  type RuntimeSnapshot,
} from "../../../contracts/runtime";

export const fixtureIds = {
  account: "acct_12345678",
} as const;

export function fixtureAccount(overrides: Partial<AccountSummary> = {}): AccountSummary {
  return {
    id: fixtureIds.account,
    revision: 1,
    label: "Work",
    selected: true,
    identityLabel: "builder@example.com",
    planLabel: "pro",
    usageRemainingPercent: null,
    authState: "signedIn",
    login: { state: "idle" },
    runtime: { state: "ready", generation: 1 },
    ...overrides,
  };
}

export function emptyRuntimeSnapshot(lastSequence = 0): RuntimeSnapshot {
  return {
    revision: 1,
    lastSequence,
    runtime: { state: "ready", generation: 1 },
    runner: { state: "connected" },
    accounts: [],
    retainedAccountLocalData: [],
    humanAccount: { state: "signedOut", revision: 0 },
    execution: {
      folderAccess: {
        revision: 1,
        displayName: "Documents",
        availability: "ready",
      },
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      sandbox: "danger-full-access",
      computerUse: "required",
    },
    chat: { revision: 1, panes: [] },
    sessionSync: {
      status: {
        state: "unavailable",
        reason: "cloudConfigurationMissing",
        retryable: false,
      },
      localGridSlots: [],
      remoteSessions: [],
    },
    harness: null,
  };
}

export function accountUpsertEvent(
  sequence: number,
  account: AccountSummary = fixtureAccount(),
): RuntimeEvent {
  return {
    version: runtimeProtocolVersion,
    sequence,
    event: { type: "account.upserted", account },
  };
}

export function snapshotInvalidatedEvent(sequence: number): RuntimeEvent {
  return {
    version: runtimeProtocolVersion,
    sequence,
    event: { type: "snapshot.invalidated", reason: "projectionOverflow" },
  };
}
