import { afterEach, describe, expect, test } from "bun:test";

import { handleHRASuiteOidc } from "./relying-party";

const ENVIRONMENT_KEYS = [
  "NEXT_PUBLIC_SITE_URL",
  "SUITE_IDENTITY_RECEIPT_KEY_VERSION",
  "SUITE_OIDC_COOKIE_SECRET",
] as const;
const originalEnvironment = Object.fromEntries(
  ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENVIRONMENT_KEYS)[number], string | undefined>;

afterEach(() => {
  for (const key of ENVIRONMENT_KEYS) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("HRA suite OIDC relying party", () => {
  test("fails closed when the relying-party environment is absent", async () => {
    for (const key of ENVIRONMENT_KEYS) delete process.env[key];

    const response = await handleHRASuiteOidc(
      new Request("https://hra.sh/api/suite-auth/session"),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: {
        code: "SUITE_OIDC_UNAVAILABLE",
        message: "Suite sign-in is not configured for this surface.",
        retryable: false,
      },
      schemaVersion: 1,
    });
  });

  test("accepts only the registered HRA origin before exact route dispatch", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://hra.sh";
    process.env.SUITE_IDENTITY_RECEIPT_KEY_VERSION = "v1";
    process.env.SUITE_OIDC_COOKIE_SECRET = "c".repeat(64);

    const response = await handleHRASuiteOidc(
      new Request("https://hra.sh/api/suite-auth/not-a-route"),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("rejects an unregistered site URL without constructing an OIDC client", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://hra.example";
    process.env.SUITE_IDENTITY_RECEIPT_KEY_VERSION = "v1";
    process.env.SUITE_OIDC_COOKIE_SECRET = "c".repeat(64);

    const response = await handleHRASuiteOidc(
      new Request("https://hra.example/api/suite-auth/session"),
    );

    expect(response.status).toBe(503);
  });
});
