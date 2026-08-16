import { describe, expect, test } from "bun:test";

import {
  WORKOS_OWNER_MEMBERSHIP_PROVIDER_POLICY,
  workOSMembershipLocatorMatches,
  workOSOrganizationExternalIdMatches,
} from "./workos";

describe("WorkOS owner membership provider policy", () => {
  test("keeps the non-idempotent create retry-free and inside its durable lease", () => {
    expect(WORKOS_OWNER_MEMBERSHIP_PROVIDER_POLICY.maxRetries).toBe(0);
    expect(WORKOS_OWNER_MEMBERSHIP_PROVIDER_POLICY.leaseDurationMs).toBeGreaterThan(
      WORKOS_OWNER_MEMBERSHIP_PROVIDER_POLICY.requestTimeoutMs *
        WORKOS_OWNER_MEMBERSHIP_PROVIDER_POLICY.maximumCallsPerLease,
    );
  });
});

describe("WorkOS provider locator agreement", () => {
  test("requires the exact organization external ID", () => {
    expect(workOSOrganizationExternalIdMatches({ externalId: "taskctl:org_1" }, "taskctl:org_1")).toBe(
      true,
    );
    expect(workOSOrganizationExternalIdMatches({ externalId: "taskctl:org_2" }, "taskctl:org_1")).toBe(
      false,
    );
    expect(workOSOrganizationExternalIdMatches({ externalId: null }, "taskctl:org_1")).toBe(false);
  });

  test("requires both membership locator fields", () => {
    const expected = { organizationId: "org_1", userId: "user_1" };
    expect(workOSMembershipLocatorMatches({ id: "om_1", ...expected }, expected)).toBe(true);
    expect(
      workOSMembershipLocatorMatches(
        { id: "om_1", organizationId: "org_2", userId: "user_1" },
        expected,
      ),
    ).toBe(false);
    expect(
      workOSMembershipLocatorMatches(
        { id: "om_1", organizationId: "org_1", userId: "user_2" },
        expected,
      ),
    ).toBe(false);
  });
});
