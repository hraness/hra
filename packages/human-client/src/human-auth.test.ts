import { describe, expect, test } from "bun:test";

import {
  HRA_HUMAN_KEYCHAIN_SERVICE,
  HRA_RUNNER_KEYCHAIN_SERVICE,
  humanAuthenticationSchema,
  humanProfileSchema,
  profileFromHumanAuthentication,
  refreshedHumanAuthentication,
} from "./human-auth";

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
      version: 1,
      apiUrl: "https://hra.example.com",
      accessToken: "access-token-that-is-long-enough",
      refreshToken: "refresh-token-that-is-long-enough",
      user: {
        id: "user_abc123",
        email: "human@example.com",
      },
    });

    const profile = profileFromHumanAuthentication(
      authentication,
      "keychain",
    );

    expect(profile).toEqual({
      version: 1,
      apiUrl: "https://hra.example.com",
      secretStore: "keychain",
      user: {
        id: "user_abc123",
        email: "human@example.com",
      },
    });
    expect(JSON.stringify(profile)).not.toContain(authentication.accessToken);
    expect(JSON.stringify(profile)).not.toContain(authentication.refreshToken);
  });

  test("rejects a rotated token for another principal", () => {
    const current = humanAuthenticationSchema.parse({
      version: 1,
      apiUrl: "https://hra.example.com",
      accessToken: "access-token-that-is-long-enough",
      refreshToken: "refresh-token-that-is-long-enough",
      user: { id: "user_abc123", email: "human@example.com" },
    });

    expect(
      refreshedHumanAuthentication(current, {
        accessToken: "rotated-access-token-that-is-long-enough",
        refreshToken: "rotated-refresh-token-that-is-long-enough",
        user: { id: "user_other", email: "other@example.com" },
      }),
    ).toEqual({ ok: false, reason: "identity_mismatch" });
  });

  test("rejects inconsistent account selections in token-free profile metadata", () => {
    expect(humanProfileSchema.safeParse({
      version: 1,
      apiUrl: "https://hra.example.com",
      secretStore: "keychain",
      user: { id: "user_abc123", email: "human@example.com" },
      workspace: {
        id: "workspace_cloud",
        organizationId: "org_cloud",
        name: "Cloud",
        slug: "cloud",
        keyPrefix: "CLD",
        role: "member",
      },
    }).success).toBeFalse();
  });
});
