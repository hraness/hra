import { describe, expect, test } from "bun:test";

import {
  OPERATOR_DIAGNOSTIC_LIMITS,
  OPERATOR_DIAGNOSTIC_THRESHOLDS,
  buildOperatorDiagnostics,
  type OperatorDiagnosticsInput,
} from "./operatorDiagnostics";
import { rateLimitRouteClasses } from "./rateLimitPolicy";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

type MutableDiagnosticsInput = {
  -readonly [Key in keyof OperatorDiagnosticsInput]: OperatorDiagnosticsInput[Key];
};

function emptyInput(): MutableDiagnosticsInput {
  return {
    now: NOW,
    rateLimitBuckets: { rows: [], limit: 256, truncated: false },
    overdueClaims: { rows: [], limit: 128, truncated: false },
    claimSamples: [],
    sessions: { rows: [], limit: 256, truncated: false },
    projectionRepairs: { rows: [], limit: 128, truncated: false },
    repairSamples: [],
    reviewWorkspaces: { rows: [], limit: 8, truncated: false },
    reviewSamples: [],
    credentials: { rows: [], limit: 256, truncated: false },
    dueWakes: { rows: [], limit: 128, truncated: false },
    wakeSamples: [],
    workspaceUsage: { rows: [], limit: 256, truncated: false },
  };
}

describe("operator diagnostics", () => {
  test("returns a stable zero snapshot", () => {
    const snapshot = buildOperatorDiagnostics(emptyInput());

    expect(snapshot.generatedAt).toBe(NOW);
    expect(snapshot.rateLimits.byRoute.map((row) => row.routeClass)).toEqual([
      ...rateLimitRouteClasses,
    ]);
    expect(snapshot.rateLimits.requestsObserved).toBe(0);
    expect(snapshot.claims).toMatchObject({ overdue: 0, stuck: 0, oldestOverdueMs: null });
    expect(snapshot.review).toMatchObject({ pending: 0, aged: 0, oldestPendingAgeMs: null });
    expect(snapshot.quotas.highestActiveTaskPercent).toBe(0);
  });

  test("applies operational thresholds at their exact boundaries", () => {
    const input = emptyInput();
    const currentWindow = Math.floor(NOW / MINUTE) * MINUTE;
    input.rateLimitBuckets = {
      rows: [
        {
          routeClass: "agent_auth_failure",
          subjectKind: "unauthenticated",
          windowStartedAt: currentWindow,
          count: 8,
        },
        {
          routeClass: "refresh_auth",
          subjectKind: "unauthenticated",
          windowStartedAt: currentWindow,
          count: 1,
        },
        {
          routeClass: "agent_read",
          subjectKind: "credential",
          windowStartedAt: currentWindow - MINUTE,
          count: 75,
        },
      ],
      limit: 256,
      truncated: false,
    };
    input.overdueClaims = {
      rows: [
        { leaseUntil: NOW - 1 },
        { leaseUntil: NOW - OPERATOR_DIAGNOSTIC_THRESHOLDS.schedulerStuckAfterMs },
      ],
      limit: 128,
      truncated: false,
    };
    input.sessions = {
      rows: [
        {
          status: "active",
          idleExpiresAt: NOW - OPERATOR_DIAGNOSTIC_THRESHOLDS.schedulerStuckAfterMs,
          credentialResolution: "linked",
          credentialStatus: "revoked",
          credentialExpiresAt: NOW + DAY,
        },
        {
          status: "active",
          idleExpiresAt: NOW,
          credentialResolution: "linked",
          credentialStatus: "active",
          credentialExpiresAt: NOW,
        },
        {
          status: "active",
          idleExpiresAt: NOW + DAY,
          credentialResolution: "missing",
        },
        {
          status: "active",
          idleExpiresAt: NOW + DAY,
          credentialResolution: "mismatch",
        },
        { status: "expired", idleExpiresAt: NOW - DAY, credentialResolution: "missing" },
        { status: "revoked", idleExpiresAt: NOW + DAY, credentialResolution: "missing" },
      ],
      limit: 256,
      truncated: false,
    };
    input.projectionRepairs = {
      rows: [
        {
          kind: "task_claim",
          status: "pending",
          updatedAt: NOW - OPERATOR_DIAGNOSTIC_THRESHOLDS.schedulerStuckAfterMs,
        },
      ],
      limit: 128,
      truncated: false,
    };
    input.reviewWorkspaces = {
      rows: [
        {
          workspacePublicId: "wsp_alpha",
          workspaceSlug: "alpha",
          submissions: {
            rows: [
              { submittedAt: NOW - OPERATOR_DIAGNOSTIC_THRESHOLDS.reviewAgedAfterMs },
              { submittedAt: NOW - OPERATOR_DIAGNOSTIC_THRESHOLDS.reviewAgedAfterMs + 1 },
            ],
            limit: 8,
            truncated: false,
          },
        },
      ],
      limit: 8,
      truncated: false,
    };
    input.credentials = {
      rows: [
        { status: "active", expiresAt: NOW, lastUsedAt: NOW },
        {
          status: "active",
          expiresAt: NOW + OPERATOR_DIAGNOSTIC_THRESHOLDS.credentialRenewalWindowMs,
          lastUsedAt: NOW - OPERATOR_DIAGNOSTIC_THRESHOLDS.credentialUnusedAfterMs,
        },
        { status: "revoked", expiresAt: NOW + DAY, lastUsedAt: NOW },
      ],
      limit: 256,
      truncated: false,
    };
    input.dueWakes = {
      rows: [
        {
          state: "pending",
          expectedAvailableAt:
            NOW - OPERATOR_DIAGNOSTIC_THRESHOLDS.schedulerStuckAfterMs,
        },
      ],
      limit: 128,
      truncated: false,
    };
    input.workspaceUsage = {
      rows: [
        {
          workspacePublicId: "wsp_alpha",
          activeTasks: 8_000,
          totalTasks: 79_999,
          activeAgents: 100,
        },
      ],
      limit: 256,
      truncated: false,
    };

    const snapshot = buildOperatorDiagnostics(input);

    expect(snapshot.rateLimits).toMatchObject({
      currentBuckets: 2,
      requestsObserved: 9,
      saturatedBuckets: 1,
      authPressure: { requestsObserved: 9, saturatedBuckets: 1 },
    });
    expect(snapshot.claims).toMatchObject({ overdue: 2, stuck: 1 });
    expect(snapshot.sessions).toMatchObject({
      active: 4,
      expiredStatus: 1,
      revokedStatus: 1,
      activePastIdleDeadline: 2,
      stuckPastIdleDeadline: 1,
      observedActiveOnRevokedCredential: 1,
      observedActiveOnExpiredCredential: 1,
      observedActiveWithMissingCredential: 1,
      observedActiveWithCredentialLinkMismatch: 1,
    });
    expect(snapshot.projectionRepairs).toMatchObject({ pending: 1, stuck: 1 });
    expect(snapshot.review).toMatchObject({ pending: 2, aged: 1 });
    expect(snapshot.credentials).toMatchObject({
      active: 2,
      revoked: 1,
      activeExpired: 1,
      activeExpiringWithinRenewalWindow: 1,
      activeUnused: 1,
    });
    expect(snapshot.wakes).toMatchObject({ overdue: 1, stuck: 1 });
    expect(snapshot.quotas).toMatchObject({
      workspacesAtOrAboveWarning: 1,
      workspacesAtOrAboveLimit: 1,
      highestActiveTaskPercent: 80,
      highestActiveAgentPercent: 100,
    });
  });

  test("caps samples, reports truncation, and never forwards secret-bearing fields", () => {
    const input = emptyInput();
    const secret = "secret_SENTINEL_must_not_escape";
    const subject = {
      routeClass: "agent_auth_failure" as const,
      subjectKind: "unauthenticated" as const,
      windowStartedAt: NOW,
      count: 1,
      subjectKey: secret,
    };
    const credential = {
      status: "active" as const,
      expiresAt: NOW + DAY,
      lastUsedAt: NOW,
      locator: secret,
      verifierDigest: secret,
      responseJson: secret,
    };
    input.rateLimitBuckets = { rows: [subject], limit: 1, truncated: true };
    input.credentials = { rows: [credential], limit: 1, truncated: true };
    input.claimSamples = Array.from(
      { length: OPERATOR_DIAGNOSTIC_LIMITS.samples + 4 },
      (_, index) => ({
        workspacePublicId: `wsp_${index}`,
        taskKey: `TASK-${index}`,
        agentPublicId: `agt_${index}`,
        leaseUntil: NOW - index - 1,
        internalDocumentId: secret,
      }),
    );

    const snapshot = buildOperatorDiagnostics(input);
    const encoded = JSON.stringify(snapshot);

    expect(snapshot.claims.samples).toHaveLength(OPERATOR_DIAGNOSTIC_LIMITS.samples);
    expect(snapshot.rateLimits.coverage).toEqual({ scanned: 1, limit: 1, truncated: true });
    expect(snapshot.credentials.coverage.truncated).toBeTrue();
    expect(encoded).not.toContain(secret);
    expect(encoded).not.toContain('"subjectKey":');
    expect(encoded).not.toContain('"verifierDigest":');
    expect(encoded).not.toContain('"locator":');
    expect(encoded).not.toContain('"internalDocumentId":');
    expect(encoded).not.toContain('"responseJson":');
  });
});
