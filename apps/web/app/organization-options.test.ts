import { describe, expect, test } from "bun:test";

import { sanitizeOrganizationOptions } from "./organization-options";

describe("sanitizeOrganizationOptions", () => {
  test("keeps only active memberships for the signed-in human", () => {
    const organizations = sanitizeOrganizationOptions(
      [
        {
          organizationId: "org_zeta",
          organizationName: "  Zeta Lab  ",
          status: "active",
          userId: "user_current",
          metadata: { private: "must not cross the boundary" },
        },
        {
          organizationId: "org_other",
          organizationName: "Other tenant",
          status: "active",
          userId: "user_other",
        },
        {
          organizationId: "org_pending",
          organizationName: "Pending tenant",
          status: "pending",
          userId: "user_current",
        },
        {
          organizationId: "org_alpha",
          organizationName: "Alpha Lab",
          status: "active",
          userId: "user_current",
        },
      ],
      "user_current",
    );

    expect(organizations).toEqual([
      { id: "org_alpha", name: "Alpha Lab" },
      { id: "org_zeta", name: "Zeta Lab" },
    ]);
    expect(organizations[0]).not.toHaveProperty("metadata");
  });

  test("rejects malformed, control-bearing, and duplicate records", () => {
    const organizations = sanitizeOrganizationOptions(
      [
        null,
        "not-a-record",
        {
          organizationId: "org_safe",
          organizationName: "Original",
          status: "active",
          userId: "user_current",
        },
        {
          organizationId: "org_safe",
          organizationName: "Current name",
          status: "active",
          userId: "user_current",
        },
        {
          organizationId: "org_control",
          organizationName: "Unsafe\nname",
          status: "active",
          userId: "user_current",
        },
      ],
      "user_current",
    );

    expect(organizations).toEqual([{ id: "org_safe", name: "Current name" }]);
  });

  test("fails closed for an invalid signed-in user locator", () => {
    expect(sanitizeOrganizationOptions([], "")).toEqual([]);
  });
});
