import { describe, expect, test } from "bun:test";

import {
  classifyMembershipGeneration,
  isRetiredMembershipGeneration,
  membershipRestrictionRank,
  missingIdentityResourceDecision,
  shouldApplyIdentityObservation,
  shouldApplyIdentityResourceObservation,
} from "./identityProjection";
import {
  normalizeWorkOSMembershipForReconciliation,
  normalizeWorkOSOrganizationForReconciliation,
} from "./identitySync";

describe("identity projection ordering", () => {
  test("rejects an older active delivery after a newer inactive update", () => {
    expect(
      shouldApplyIdentityObservation({
        incomingUpdatedAt: 100,
        incomingObservedAt: 150,
        incomingRestrictionRank: 0,
        currentUpdatedAt: 200,
        currentObservedAt: 250,
        currentRestrictionRank: 2,
      }),
    ).toBeFalse();
  });

  test("lets a provider-found membership reverse a later 404 observation", () => {
    expect(
      shouldApplyIdentityObservation({
        incomingUpdatedAt: 100,
        incomingObservedAt: 300,
        incomingRestrictionRank: 0,
        currentUpdatedAt: 100,
        currentObservedAt: 200,
        currentRestrictionRank: 3,
      }),
    ).toBeTrue();
  });

  test("prefers the restrictive state when provider and observation versions tie", () => {
    expect(
      shouldApplyIdentityObservation({
        incomingUpdatedAt: 100,
        incomingObservedAt: 200,
        incomingRestrictionRank: 3,
        currentUpdatedAt: 100,
        currentObservedAt: 200,
        currentRestrictionRank: 0,
      }),
    ).toBeTrue();
    expect(
      shouldApplyIdentityObservation({
        incomingUpdatedAt: 100,
        incomingObservedAt: 200,
        incomingRestrictionRank: 0,
        currentUpdatedAt: 100,
        currentObservedAt: 200,
        currentRestrictionRank: 3,
      }),
    ).toBeFalse();
  });

  test("rejects an active owner input tied with a current active member", () => {
    expect(
      shouldApplyIdentityObservation({
        incomingUpdatedAt: 100,
        incomingObservedAt: 200,
        incomingRestrictionRank: membershipRestrictionRank("active", "owner"),
        currentUpdatedAt: 100,
        currentObservedAt: 200,
        currentRestrictionRank: membershipRestrictionRank("active", "member"),
      }),
    ).toBeFalse();
  });

  test("keeps lifecycle status stricter than role and missing removal maximal", () => {
    expect(membershipRestrictionRank("pending", "owner")).toBeGreaterThan(
      membershipRestrictionRank("active", "member"),
    );
    expect(membershipRestrictionRank("removed", "member")).toBeGreaterThan(
      membershipRestrictionRank("inactive", "member"),
    );
  });

  test("makes a signed hard deletion terminal for the same provider resource", () => {
    expect(
      shouldApplyIdentityResourceObservation({
        incomingUpdatedAt: 999,
        incomingObservedAt: 999,
        incomingRestrictionRank: membershipRestrictionRank("active", "owner"),
        incomingHardDeleted: false,
        currentUpdatedAt: 100,
        currentObservedAt: 200,
        currentRestrictionRank: membershipRestrictionRank("removed", "member"),
        currentHardDeletedAt: 100,
      }),
    ).toBeFalse();
  });

  test("lets signed deletion provenance establish the hard tombstone", () => {
    expect(
      shouldApplyIdentityResourceObservation({
        incomingUpdatedAt: 100,
        incomingObservedAt: 100,
        incomingRestrictionRank: membershipRestrictionRank("removed", "member"),
        incomingHardDeleted: true,
        currentUpdatedAt: 100,
        currentObservedAt: 300,
        currentRestrictionRank: membershipRestrictionRank("active", "member"),
      }),
    ).toBeTrue();
  });

  test("rebinds only a removed membership to a new provider generation", () => {
    expect(
      classifyMembershipGeneration({
        currentMembershipId: "om_M1",
        currentStatus: "removed",
        incomingMembershipId: "om_M2",
        incomingStatus: "active",
        incomingHardDeleted: false,
      }),
    ).toBe("rebind");
    expect(
      classifyMembershipGeneration({
        currentMembershipId: "om_M1",
        currentStatus: "active",
        incomingMembershipId: "om_M2",
        incomingStatus: "active",
        incomingHardDeleted: false,
      }),
    ).toBe("collision");
    expect(
      classifyMembershipGeneration({
        currentMembershipId: "om_M1",
        currentStatus: "removed",
        incomingMembershipId: "om_M2",
        incomingStatus: "active",
        incomingHardDeleted: false,
        currentQuarantined: true,
      }),
    ).toBe("rebind");
  });

  test("clears corroborated quarantine without reviving M1, then retires it for M2", () => {
    const corroboratedMissing = missingIdentityResourceDecision({
      lifecycleApplies: shouldApplyIdentityResourceObservation({
        incomingUpdatedAt: 100,
        incomingObservedAt: 400,
        incomingRestrictionRank: membershipRestrictionRank("removed", "member"),
        incomingHardDeleted: false,
        currentUpdatedAt: 100,
        currentObservedAt: 300,
        currentRestrictionRank: membershipRestrictionRank("removed", "member"),
        currentHardDeletedAt: 100,
      }),
      currentQuarantined: true,
    });
    expect(corroboratedMissing).toEqual({ applyLifecycle: false, clearQuarantine: true });
    expect(
      classifyMembershipGeneration({
        currentMembershipId: "om_M1",
        currentStatus: "removed",
        incomingMembershipId: "om_M2",
        incomingStatus: "active",
        incomingHardDeleted: false,
      }),
    ).toBe("rebind");
    expect(isRetiredMembershipGeneration("om_M1", "om_M1")).toBeTrue();
    expect(isRetiredMembershipGeneration("om_M1", "om_M2")).toBeFalse();
  });
});

describe("WorkOS reconciliation normalization", () => {
  const observedAt = 1_000;
  const membership = {
    id: "om_Test1",
    organizationId: "org_Test1",
    userId: "user_Test1",
    organizationName: "Test organization",
    status: "active",
    updatedAt: "2026-01-01T00:00:00.000Z",
    role: { slug: "admin" },
  };

  test("falls back to role.slug when roles are absent, null, or empty", () => {
    for (const roles of [undefined, null, []] as const) {
      const normalized = normalizeWorkOSMembershipForReconciliation(
        { ...membership, ...(roles === undefined ? {} : { roles }) },
        observedAt,
      );
      expect(normalized?.roleSlugs).toEqual(["admin"]);
    }
  });

  test("returns null instead of throwing for malformed memberships", () => {
    const malformed: unknown[] = [
      null,
      { ...membership, roles: [null] },
      { ...membership, roles: {} },
      { ...membership, role: null },
      { ...membership, id: "wrong" },
      { ...membership, status: "unknown" },
      { ...membership, updatedAt: "not-a-timestamp" },
    ];
    for (const value of malformed) {
      expect(normalizeWorkOSMembershipForReconciliation(value, observedAt)).toBeNull();
    }
  });

  test("returns null instead of throwing for malformed organizations", () => {
    const organization = {
      id: "org_Test1",
      name: "Test organization",
      externalId: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const malformed: unknown[] = [
      null,
      { ...organization, id: "wrong" },
      { ...organization, name: null },
      { ...organization, externalId: {} },
      { ...organization, updatedAt: "not-a-timestamp" },
    ];
    for (const value of malformed) {
      expect(normalizeWorkOSOrganizationForReconciliation(value, observedAt)).toBeNull();
    }
  });
});
