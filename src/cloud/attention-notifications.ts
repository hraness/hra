import {
  hasExactKeys,
  isOpaqueIdentifier,
  isRecord,
  isSafeNonNegativeInteger,
  isSafePositiveInteger,
  snapshotForeignJson,
  type AuthorityTuple,
} from "./contracts";
import {
  parseNotificationEmailPolicy,
  type NotificationEmailPolicy,
} from "../domain/notification-email-contract";
import {
  parseNotificationHoursPolicy,
  type NotificationHoursPolicy,
} from "../domain/notification-hours-contract";
import {
  remoteInteractionActionOrder,
  type RemoteInteractionAction,
} from "../domain/remote-interaction-contract";

export const attentionNotificationCandidateLimit = 64;
export const attentionNotificationConsentLeaseMs = 2 * 60 * 1_000;

export type LocalAttentionNotificationCandidate = Readonly<{
  interactionDeadline: number;
  interactionId: string;
  interactionKind:
    | "command_approval"
    | "file_change_approval"
    | "permission_approval"
    | "user_input"
    | "mcp_elicitation";
  interactionRevision: number;
  remoteActions: readonly RemoteInteractionAction[];
  sessionPublicId: string;
}>;

export type LocalAttentionNotificationSnapshot = Readonly<{
  candidates: readonly LocalAttentionNotificationCandidate[];
  notificationEmail: NotificationEmailPolicy;
  notificationHours: NotificationHoursPolicy;
  notificationPolicyRevision: number;
  observedAt: number;
  status: "complete" | "overflow";
}>;

export type HostedAttentionNotificationCandidate = LocalAttentionNotificationCandidate & Readonly<{
  executionAuthority: AuthorityTuple;
}>;

export type AttentionNotificationDeviceAuthority = Readonly<{
  consentLeaseUntil: number;
  globalNotificationGeneration: number;
  localNotificationPolicyRevision: number;
  reconciliationSequence: number;
}>;

export type AttentionNotificationAuthorityStatus = Readonly<{
  deviceAuthority: AttentionNotificationDeviceAuthority | null;
  enabled: boolean;
  globalNotificationGeneration: number;
  observedAt: number;
  safetyFaultState: "latched" | "none" | "reviewed";
}>;

export type AttentionNotificationCompleteRequest = Readonly<{
  allowedWindowEnd: number;
  candidateCount: number;
  expectedGlobalNotificationGeneration: number;
  localNotificationPolicyRevision: number;
  mode: "complete";
  reconciliationSequence: number;
}>;

export type AttentionNotificationInvalidateRequest = Readonly<{
  localNotificationPolicyRevision: number;
  mode: "invalidate";
  reconciliationSequence: number;
}>;

export type AttentionNotificationReconcileReceipt =
  | Readonly<{
      acknowledgedAt: number;
      candidateCount: number;
      consentLeaseUntil: number;
      globalNotificationGeneration: number;
      localNotificationPolicyRevision: number;
      reconciliationSequence: number;
      state: "complete";
    }>
  | Readonly<{
      acknowledgedAt: number;
      consentLeaseUntil: number;
      globalNotificationGeneration: number;
      localNotificationPolicyRevision: number;
      reconciliationSequence: number;
      state: "invalidated";
    }>;

const interactionKinds = new Set([
  "command_approval",
  "file_change_approval",
  "permission_approval",
  "user_input",
  "mcp_elicitation",
] as const);

function actionsAreCanonical(value: unknown): value is readonly RemoteInteractionAction[] {
  if (
    !Array.isArray(value)
    || value.length > remoteInteractionActionOrder.length
    || value.some((entry) => !remoteInteractionActionOrder.includes(entry as RemoteInteractionAction))
  ) return false;
  const canonical = remoteInteractionActionOrder.filter((action) => value.includes(action));
  return canonical.length === value.length
    && canonical.every((action, index) => action === value[index]);
}

function parseLocalCandidate(
  value: unknown,
  observedAt: number,
): LocalAttentionNotificationCandidate | null {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "interactionDeadline",
      "interactionId",
      "interactionKind",
      "interactionRevision",
      "remoteActions",
      "sessionPublicId",
    ])
    || !isSafeNonNegativeInteger(value.interactionDeadline)
    || value.interactionDeadline <= observedAt
    || !isOpaqueIdentifier(value.interactionId)
    || typeof value.interactionKind !== "string"
    || !interactionKinds.has(value.interactionKind as LocalAttentionNotificationCandidate["interactionKind"])
    || !isSafePositiveInteger(value.interactionRevision)
    || !actionsAreCanonical(value.remoteActions)
    || !isOpaqueIdentifier(value.sessionPublicId)
  ) return null;
  return {
    interactionDeadline: value.interactionDeadline,
    interactionId: value.interactionId,
    interactionKind: value.interactionKind as LocalAttentionNotificationCandidate["interactionKind"],
    interactionRevision: value.interactionRevision,
    remoteActions: [...value.remoteActions],
    sessionPublicId: value.sessionPublicId,
  };
}

/** Strictly copies the daemon adapter seam and rejects all non-notification fields. */
export function parseLocalAttentionNotificationSnapshot(
  input: unknown,
  expectedObservedAt: number,
): LocalAttentionNotificationSnapshot | null {
  const copied = snapshotForeignJson(input);
  if (!copied.ok || !isRecord(copied.value)) return null;
  const value = copied.value;
  if (
    !hasExactKeys(value, [
      "candidates",
      "notificationEmail",
      "notificationHours",
      "notificationPolicyRevision",
      "observedAt",
      "status",
    ])
    || !isSafeNonNegativeInteger(expectedObservedAt)
    || value.observedAt !== expectedObservedAt
    || (value.status !== "complete" && value.status !== "overflow")
    || !Array.isArray(value.candidates)
    || value.candidates.length > attentionNotificationCandidateLimit
    || (value.status === "overflow" && value.candidates.length !== 0)
  ) return null;
  const notificationEmail = parseNotificationEmailPolicy(value.notificationEmail);
  const notificationHours = parseNotificationHoursPolicy(value.notificationHours);
  if (
    notificationEmail === null
    || notificationHours === null
    || !isSafePositiveInteger(value.notificationPolicyRevision)
    || notificationEmail.revision !== value.notificationPolicyRevision
    || notificationHours.revision !== value.notificationPolicyRevision
  ) return null;
  const candidates: LocalAttentionNotificationCandidate[] = [];
  const ids = new Set<string>();
  for (const candidate of value.candidates) {
    const parsed = parseLocalCandidate(candidate, expectedObservedAt);
    if (parsed === null || ids.has(parsed.interactionId)) return null;
    ids.add(parsed.interactionId);
    candidates.push(parsed);
  }
  return {
    candidates,
    notificationEmail,
    notificationHours,
    notificationPolicyRevision: value.notificationPolicyRevision,
    observedAt: expectedObservedAt,
    status: value.status,
  };
}

function parseDeviceAuthority(value: unknown): AttentionNotificationDeviceAuthority | null {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "consentLeaseUntil",
      "globalNotificationGeneration",
      "localNotificationPolicyRevision",
      "reconciliationSequence",
    ])
    || !isSafeNonNegativeInteger(value.consentLeaseUntil)
    || !isSafeNonNegativeInteger(value.globalNotificationGeneration)
    || !isSafePositiveInteger(value.localNotificationPolicyRevision)
    || !isSafePositiveInteger(value.reconciliationSequence)
  ) return null;
  return {
    consentLeaseUntil: value.consentLeaseUntil,
    globalNotificationGeneration: value.globalNotificationGeneration,
    localNotificationPolicyRevision: value.localNotificationPolicyRevision,
    reconciliationSequence: value.reconciliationSequence,
  };
}

export function parseAttentionNotificationAuthorityStatus(
  input: unknown,
): AttentionNotificationAuthorityStatus | null {
  const copied = snapshotForeignJson(input);
  if (!copied.ok || !isRecord(copied.value)) return null;
  const value = copied.value;
  if (
    !hasExactKeys(value, [
      "deviceAuthority",
      "enabled",
      "globalNotificationGeneration",
      "observedAt",
      "safetyFaultState",
    ])
    || typeof value.enabled !== "boolean"
    || !isSafeNonNegativeInteger(value.globalNotificationGeneration)
    || !isSafeNonNegativeInteger(value.observedAt)
    || (value.enabled && value.globalNotificationGeneration < 1)
    || (value.enabled && value.safetyFaultState === "latched")
    || (value.safetyFaultState !== "none"
      && value.safetyFaultState !== "latched"
      && value.safetyFaultState !== "reviewed")
  ) return null;
  const deviceAuthority = value.deviceAuthority === null
    ? null
    : parseDeviceAuthority(value.deviceAuthority);
  if (
    (value.deviceAuthority !== null && deviceAuthority === null)
    || (deviceAuthority !== null
      && deviceAuthority.consentLeaseUntil - value.observedAt
        > attentionNotificationConsentLeaseMs)
  ) return null;
  return {
    deviceAuthority,
    enabled: value.enabled,
    globalNotificationGeneration: value.globalNotificationGeneration,
    observedAt: value.observedAt,
    safetyFaultState: value.safetyFaultState,
  };
}

export function nextAttentionNotificationReconciliationSequence(
  status: AttentionNotificationAuthorityStatus,
): number | null {
  const current = status.deviceAuthority?.reconciliationSequence ?? 0;
  return current < Number.MAX_SAFE_INTEGER ? current + 1 : null;
}

export function parseAttentionNotificationReconcileReceipt(
  input: unknown,
  expected: AttentionNotificationCompleteRequest | AttentionNotificationInvalidateRequest,
): AttentionNotificationReconcileReceipt | null {
  const copied = snapshotForeignJson(input);
  if (!copied.ok || !isRecord(copied.value)) return null;
  const value = copied.value;
  const complete = expected.mode === "complete";
  if (
    !hasExactKeys(value, complete
      ? [
          "acknowledgedAt",
          "candidateCount",
          "consentLeaseUntil",
          "globalNotificationGeneration",
          "localNotificationPolicyRevision",
          "reconciliationSequence",
          "state",
        ]
      : [
          "acknowledgedAt",
          "consentLeaseUntil",
          "globalNotificationGeneration",
          "localNotificationPolicyRevision",
          "reconciliationSequence",
          "state",
        ])
    || !isSafeNonNegativeInteger(value.acknowledgedAt)
    || !isSafeNonNegativeInteger(value.consentLeaseUntil)
    || !isSafeNonNegativeInteger(value.globalNotificationGeneration)
    || value.localNotificationPolicyRevision !== expected.localNotificationPolicyRevision
    || value.reconciliationSequence !== expected.reconciliationSequence
    || value.state !== (complete ? "complete" : "invalidated")
  ) return null;
  if (complete) {
    if (
      value.candidateCount !== expected.candidateCount
      || value.globalNotificationGeneration !== expected.expectedGlobalNotificationGeneration
      || value.consentLeaseUntil <= value.acknowledgedAt
      || value.consentLeaseUntil > value.acknowledgedAt + attentionNotificationConsentLeaseMs
      || value.consentLeaseUntil > expected.allowedWindowEnd
    ) return null;
    return {
      acknowledgedAt: value.acknowledgedAt,
      candidateCount: value.candidateCount,
      consentLeaseUntil: value.consentLeaseUntil,
      globalNotificationGeneration: value.globalNotificationGeneration,
      localNotificationPolicyRevision: value.localNotificationPolicyRevision,
      reconciliationSequence: value.reconciliationSequence,
      state: "complete",
    };
  }
  if (value.consentLeaseUntil !== value.acknowledgedAt) return null;
  return {
    acknowledgedAt: value.acknowledgedAt,
    consentLeaseUntil: value.consentLeaseUntil,
    globalNotificationGeneration: value.globalNotificationGeneration,
    localNotificationPolicyRevision: value.localNotificationPolicyRevision,
    reconciliationSequence: value.reconciliationSequence,
    state: "invalidated",
  };
}
