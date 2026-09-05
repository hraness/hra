import { describe, expect, test } from "bun:test";

import {
  attentionNotificationCandidateLimit,
  nextAttentionNotificationReconciliationSequence,
  parseAttentionNotificationAuthorityStatus,
  parseAttentionNotificationReconcileReceipt,
  parseLocalAttentionNotificationSnapshot,
} from "./attention-notifications";

const candidate = (index = 0) => ({
  interactionDeadline: 200_000 + index,
  interactionId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  interactionKind: "user_input" as const,
  interactionRevision: 2,
  remoteActions: ["decline", "answer"] as const,
  sessionPublicId: "00000000-0000-4000-8000-000000000999",
});

const snapshot = (candidates: readonly ReturnType<typeof candidate>[] = [candidate()]) => ({
  candidates,
  notificationEmail: { enabled: true, revision: 7, version: 1 as const },
  notificationHours: {
    endMinute: 1_439,
    revision: 7,
    startMinute: 0,
    timeZone: "UTC",
    version: 1 as const,
  },
  notificationPolicyRevision: 7,
  observedAt: 100_000,
  status: "complete" as const,
});

describe("attention notification boundary parsers", () => {
  test("admits one exact bounded local snapshot without plaintext presentation", () => {
    expect(parseLocalAttentionNotificationSnapshot(snapshot(), 100_000)).toEqual(snapshot());
    expect(JSON.stringify(parseLocalAttentionNotificationSnapshot(snapshot(), 100_000)))
      .not.toMatch(/display|question|prompt|path|provider/i);
    expect(parseLocalAttentionNotificationSnapshot({
      ...snapshot(),
      candidates: Array.from(
        { length: attentionNotificationCandidateLimit },
        (_, index) => candidate(index),
      ),
    }, 100_000)?.candidates).toHaveLength(attentionNotificationCandidateLimit);
  });

  test("rejects overflow bodies, revision tears, noncanonical actions, and accessors", () => {
    expect(parseLocalAttentionNotificationSnapshot({
      ...snapshot(),
      candidates: [candidate()],
      status: "overflow",
    }, 100_000)).toBeNull();
    expect(parseLocalAttentionNotificationSnapshot({
      ...snapshot(),
      notificationEmail: { enabled: true, revision: 8, version: 1 },
    }, 100_000)).toBeNull();
    expect(parseLocalAttentionNotificationSnapshot({
      ...snapshot(),
      candidates: [{ ...candidate(), remoteActions: ["answer", "decline"] }],
    }, 100_000)).toBeNull();
    expect(parseLocalAttentionNotificationSnapshot({
      ...snapshot(),
      candidates: Array.from(
        { length: attentionNotificationCandidateLimit + 1 },
        (_, index) => candidate(index),
      ),
    }, 100_000)).toBeNull();

    let reads = 0;
    const foreign = { ...snapshot() } as Record<string, unknown>;
    Object.defineProperty(foreign, "observedAt", {
      enumerable: true,
      get: () => {
        reads += 1;
        return 100_000;
      },
    });
    expect(parseLocalAttentionNotificationSnapshot(foreign, 100_000)).toBeNull();
    expect(reads).toBe(0);
  });

  test("strictly parses hosted authority and rejects enabled-latched incoherence", () => {
    const disabledLatched = {
      deviceAuthority: null,
      enabled: false,
      globalNotificationGeneration: 0,
      observedAt: 100_000,
      safetyFaultState: "latched" as const,
    };
    expect(parseAttentionNotificationAuthorityStatus(disabledLatched)).toEqual(disabledLatched);
    expect(parseAttentionNotificationAuthorityStatus({
      ...disabledLatched,
      enabled: true,
      globalNotificationGeneration: 1,
    })).toBeNull();
    expect(parseAttentionNotificationAuthorityStatus({
      ...disabledLatched,
      extra: true,
    })).toBeNull();

    const status = parseAttentionNotificationAuthorityStatus({
      deviceAuthority: {
        consentLeaseUntil: 200_000,
        globalNotificationGeneration: 3,
        localNotificationPolicyRevision: 7,
        reconciliationSequence: 9,
      },
      enabled: true,
      globalNotificationGeneration: 3,
      observedAt: 100_000,
      safetyFaultState: "reviewed",
    });
    expect(status).not.toBeNull();
    expect(status === null
      ? null
      : nextAttentionNotificationReconciliationSequence(status)).toBe(10);
    expect(status?.deviceAuthority?.consentLeaseUntil).toBe(200_000);
    expect(parseAttentionNotificationAuthorityStatus({
      deviceAuthority: {
        consentLeaseUntil: 220_000,
        globalNotificationGeneration: 3,
        localNotificationPolicyRevision: 7,
        reconciliationSequence: 9,
      },
      enabled: true,
      globalNotificationGeneration: 3,
      observedAt: 100_000,
      safetyFaultState: "reviewed",
    })).not.toBeNull();
    expect(parseAttentionNotificationAuthorityStatus({
      deviceAuthority: {
        consentLeaseUntil: 220_001,
        globalNotificationGeneration: 3,
        localNotificationPolicyRevision: 7,
        reconciliationSequence: 9,
      },
      enabled: true,
      globalNotificationGeneration: 3,
      observedAt: 100_000,
      safetyFaultState: "reviewed",
    })).toBeNull();
  });

  test("requires exact echoes and a complete consent lease no longer than two minutes", () => {
    const expected = {
      allowedWindowEnd: 250_000,
      candidateCount: 1,
      expectedGlobalNotificationGeneration: 3,
      localNotificationPolicyRevision: 7,
      mode: "complete" as const,
      reconciliationSequence: 10,
    };
    const receipt = {
      acknowledgedAt: 100_000,
      candidateCount: 1,
      consentLeaseUntil: 220_000,
      globalNotificationGeneration: 3,
      localNotificationPolicyRevision: 7,
      reconciliationSequence: 10,
      state: "complete" as const,
    };
    expect(parseAttentionNotificationReconcileReceipt(receipt, expected)).toEqual(receipt);
    expect(parseAttentionNotificationReconcileReceipt({
      ...receipt,
      consentLeaseUntil: 220_001,
    }, expected)).toBeNull();
    expect(parseAttentionNotificationReconcileReceipt({
      ...receipt,
      reconciliationSequence: 11,
    }, expected)).toBeNull();

    const invalidationExpected = {
      localNotificationPolicyRevision: 8,
      mode: "invalidate" as const,
      reconciliationSequence: 11,
    };
    const invalidated = {
      acknowledgedAt: 125_000,
      consentLeaseUntil: 125_000,
      globalNotificationGeneration: 3,
      localNotificationPolicyRevision: 8,
      reconciliationSequence: 11,
      state: "invalidated" as const,
    };
    expect(parseAttentionNotificationReconcileReceipt(
      invalidated,
      invalidationExpected,
    )).toEqual(invalidated);
    expect(parseAttentionNotificationReconcileReceipt({
      ...invalidated,
      consentLeaseUntil: 125_001,
    }, invalidationExpected)).toBeNull();
  });
});
