import { describe, expect, test } from "bun:test";

import {
  DesktopPairingError,
  desktopPairingChallengeForVerifier,
  loginWithDesktopPairing,
  type DesktopPairingVerification,
} from "./index";

const pairingId = "pair_00000000000000000000000000";
const requestId = "req_00000000000000000000000000";

function inputUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

function stringBody(body: RequestInit["body"]): string {
  if (typeof body !== "string") throw new Error("expected JSON request body");
  return body;
}

function approvedAuthentication() {
  return {
    accessToken: "access-token-that-is-long-enough",
    refreshToken: "refresh-token-that-is-long-enough",
    user: {
      id: "usr_00000000000000000000000000",
      email: "human@example.com",
      name: "Ada Lovelace",
    },
    organization: {
      id: "organization-id",
      name: "Example",
      role: "owner" as const,
      status: "active" as const,
    },
    workspace: {
      id: "workspace-id",
      organizationId: "organization-id",
      slug: "core",
      name: "Core",
      taskKeyPrefix: "CORE",
      roles: ["planner" as const],
    },
  };
}

describe("portable browser desktop pairing", () => {
  test("starts with only a verifier digest and redeems through bounded polling", async () => {
    const responses = [
      Response.json({
        ok: true,
        data: {
          pairingId,
          verificationUri: `https://hra.sh/pair/desktop/${pairingId}`,
          comparisonCode: "2345-6789",
          expiresAt: 61_000,
          pollIntervalMs: 2_000,
        },
        requestId,
      }),
      Response.json({
        ok: true,
        data: { status: "pending", retryAfterMs: 3_000 },
        requestId,
      }),
      Response.json({
        ok: true,
        data: { status: "approved", authentication: approvedAuthentication() },
        requestId,
      }),
    ];
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const verifications: DesktopPairingVerification[] = [];
    const sleeps: number[] = [];
    let now = 1_000;

    const result = await loginWithDesktopPairing({
      apiUrl: "https://api.hra.sh",
      expectedWebOrigin: "https://hra.sh",
      fetch: (input, init) => {
        requests.push({ url: inputUrl(input), ...(init === undefined ? {} : { init }) });
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected request");
        return Promise.resolve(response);
      },
      now: () => now,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
        return Promise.resolve();
      },
      randomBytes: () => Uint8Array.from({ length: 32 }, (_, index) => index),
      onVerification: (verification) => verifications.push(verification),
    });

    expect(result).toEqual(approvedAuthentication());
    expect(sleeps).toEqual([2_000, 3_000]);
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/v1/auth/desktop-pairings",
      `/v1/auth/desktop-pairings/${pairingId}/redeem`,
      `/v1/auth/desktop-pairings/${pairingId}/redeem`,
    ]);
    const startBody = JSON.parse(stringBody(requests[0]?.init?.body)) as Record<string, unknown>;
    const redeemBody = JSON.parse(stringBody(requests[1]?.init?.body)) as Record<string, unknown>;
    expect(startBody).toEqual({
      challenge: await desktopPairingChallengeForVerifier(String(redeemBody["verifier"])),
    });
    expect(startBody).not.toHaveProperty("verifier");
    expect(JSON.stringify(verifications)).not.toContain(String(redeemBody["verifier"]));
    expect(JSON.stringify(verifications)).not.toContain("access-token");
    expect(requests.every(({ init }) => init?.redirect === "error")).toBeTrue();
  });

  test("rejects credential-bearing and mismatched verification URLs before display", async () => {
    let verificationCalls = 0;
    const run = (verificationUri: string, expectedWebOrigin?: string) =>
      loginWithDesktopPairing({
        apiUrl: "https://api.hra.sh",
        expectedWebOrigin: expectedWebOrigin ?? "https://hra.sh",
        fetch: () => Promise.resolve(Response.json({
          ok: true,
          data: {
            pairingId,
            verificationUri,
            comparisonCode: "2345-6789",
            expiresAt: 61_000,
            pollIntervalMs: 2_000,
          },
          requestId,
        })),
        now: () => 1_000,
        sleep: () => Promise.resolve(),
        randomBytes: () => new Uint8Array(32),
        onVerification: () => {
          verificationCalls += 1;
        },
      }).catch((error: unknown) => error);

    const credentialUrl = await run(
      `https://hra.sh/pair/desktop/${pairingId}?verifier=must-not-escape`,
    );
    const mismatchedOrigin = await run(
      `https://other.example/pair/desktop/${pairingId}`,
      "https://hra.sh",
    );
    expect(credentialUrl).toBeInstanceOf(DesktopPairingError);
    expect(mismatchedOrigin).toBeInstanceOf(Error);
    expect(JSON.stringify(credentialUrl)).not.toContain("must-not-escape");
    expect(verificationCalls).toBe(0);
  });

  test("reports consumed and repeated network states without unbounded polling", async () => {
    const start = Response.json({
      ok: true,
      data: {
        pairingId,
        verificationUri: `https://hra.sh/pair/desktop/${pairingId}`,
        comparisonCode: "2345-6789",
        expiresAt: 61_000,
        pollIntervalMs: 1_000,
      },
      requestId,
    });
    let calls = 0;
    const consumed = await loginWithDesktopPairing({
      apiUrl: "https://api.hra.sh",
      expectedWebOrigin: "https://hra.sh",
      fetch: () => {
        calls += 1;
        return Promise.resolve(calls === 1
          ? start
          : Response.json({ ok: true, data: { status: "consumed" }, requestId }));
      },
      now: () => calls * 1_000,
      sleep: () => Promise.resolve(),
      randomBytes: () => new Uint8Array(32),
      onVerification: () => undefined,
    }).catch((error: unknown) => error);
    expect(consumed).toBeInstanceOf(DesktopPairingError);
    expect((consumed as DesktopPairingError).outcome).toBe("consumed");

    let networkCalls = 0;
    const network = await loginWithDesktopPairing({
      apiUrl: "https://api.hra.sh",
      expectedWebOrigin: "https://hra.sh",
      fetch: () => {
        networkCalls += 1;
        if (networkCalls === 1) {
          return Promise.resolve(Response.json({
            ok: true,
            data: {
              pairingId,
              verificationUri: `https://hra.sh/pair/desktop/${pairingId}`,
              comparisonCode: "2345-6789",
              expiresAt: 61_000,
              pollIntervalMs: 1_000,
            },
            requestId,
          }));
        }
        return Promise.reject(new Error("secret network detail"));
      },
      now: () => networkCalls * 1_000,
      sleep: () => Promise.resolve(),
      randomBytes: () => new Uint8Array(32),
      onVerification: () => undefined,
    }).catch((error: unknown) => error);
    expect(network).toBeInstanceOf(DesktopPairingError);
    expect((network as DesktopPairingError).outcome).toBe("network");
    expect(networkCalls).toBe(5);
    expect(JSON.stringify(network)).not.toContain("secret network detail");
  });
});
