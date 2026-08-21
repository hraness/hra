import { describe, expect, test } from "bun:test";

import {
  HRA_HUMAN_KEYCHAIN_SERVICE,
  HRA_RUNNER_KEYCHAIN_SERVICE,
  humanAuthenticationSchema,
  humanProfileSchema,
  profileFromHumanAuthentication,
  refreshedHumanAuthentication,
  storedHumanAuthenticationDisposition,
} from "./human-auth";

const organization = {
  id: "org_cloud",
  name: "Cloud",
  role: "owner",
  status: "active",
} as const;

const workspace = {
  id: "workspace_cloud",
  organizationId: organization.id,
  name: "Cloud",
  slug: "cloud",
  taskKeyPrefix: "CLD",
  roles: ["planner" as const],
};

describe("human authentication contracts", () => {
  test("preserves the stable OPRTE human and runner Keychain storage IDs", () => {
    expect(HRA_HUMAN_KEYCHAIN_SERVICE).toBe(
      "kitchen.hraness.cloud-human.v1",
    );
    expect(HRA_RUNNER_KEYCHAIN_SERVICE).toBe(
      "kitchen.hraness.cloud-runner.v1",
    );
    expect(HRA_HUMAN_KEYCHAIN_SERVICE).not.toBe(
      HRA_RUNNER_KEYCHAIN_SERVICE,
    );
  });

  test("projects only safe metadata outside custody", () => {
    const authentication = humanAuthenticationSchema.parse({
      version: 2,
      apiUrl: "https://hra.example.com",
      accessToken: "access-token-that-is-long-enough",
      refreshToken: "refresh-token-that-is-long-enough",
      user: {
        id: "user_abc123",
        email: "human@example.com",
      },
      organization,
      workspace,
    });

    const profile = profileFromHumanAuthentication(
      authentication,
      "keychain",
    );

    expect(profile).toEqual({
      version: 2,
      apiUrl: "https://hra.example.com",
      secretStore: "keychain",
      user: {
        id: "user_abc123",
        email: "human@example.com",
      },
      organization,
      workspace,
    });
    expect(JSON.stringify(profile)).not.toContain(authentication.accessToken);
    expect(JSON.stringify(profile)).not.toContain(authentication.refreshToken);
  });

  test("rejects a rotated token for another principal", () => {
    const current = humanAuthenticationSchema.parse({
      version: 2,
      apiUrl: "https://hra.example.com",
      accessToken: "access-token-that-is-long-enough",
      refreshToken: "refresh-token-that-is-long-enough",
      user: { id: "user_abc123", email: "human@example.com" },
      organization,
      workspace,
    });

    expect(
      refreshedHumanAuthentication(current, {
        accessToken: "rotated-access-token-that-is-long-enough",
        refreshToken: "rotated-refresh-token-that-is-long-enough",
        user: { id: "user_other", email: "other@example.com" },
        organization,
        workspace,
      }),
    ).toEqual({ ok: false, reason: "identity_mismatch" });
  });

  test("rejects inconsistent account selections in token-free profile metadata", () => {
    expect(humanProfileSchema.safeParse({
      version: 2,
      apiUrl: "https://hra.example.com",
      secretStore: "keychain",
      user: { id: "user_abc123", email: "human@example.com" },
      organization,
      workspace: {
        id: "workspace_cloud",
        organizationId: "org_other",
        name: "Cloud",
        slug: "cloud",
        taskKeyPrefix: "CLD",
        roles: ["planner"],
      },
    }).success).toBeFalse();
  });

  test("classifies version-one custody as recovery-required without interpreting it", () => {
    expect(storedHumanAuthenticationDisposition({
      version: 1,
      apiUrl: "https://hra.example.com",
      accessToken: "legacy-access-material",
      refreshToken: "legacy-refresh-material",
      user: { id: "user_abc123" },
      externalOrganizationId: "external-id",
    })).toBe("legacy");
    expect(storedHumanAuthenticationDisposition({ version: 3 })).toBe("invalid");
  });
});
