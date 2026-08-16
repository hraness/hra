import { describe, expect, test } from "bun:test";

import {
  HumanClientError,
  loginWithWorkosDevice,
  type DeviceVerification,
} from "./index";

function inputUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

function formEntries(body: RequestInit["body"]): Record<string, string> {
  if (!(body instanceof URLSearchParams)) throw new Error("expected form body");
  return Object.fromEntries(body);
}

describe("portable WorkOS device authentication", () => {
  test("polls pending and slow-down responses without exposing the device code", async () => {
    const deviceCode = "secret-device-code-never-shown";
    const responses = [
      Response.json({
        device_code: deviceCode,
        user_code: "ABCD-EFGH",
        verification_uri: "https://auth.example.com/device",
        verification_uri_complete:
          "https://auth.example.com/device?code=ABCD-EFGH",
        expires_in: 600,
        interval: 2,
      }),
      Response.json({ error: "authorization_pending" }, { status: 400 }),
      Response.json({ error: "slow_down" }, { status: 400 }),
      Response.json({
        access_token: "access-token-that-is-long-enough",
        refresh_token: "refresh-token-that-is-long-enough",
        user: {
          id: "user_abc123",
          email: "human@example.com",
          first_name: "Ada",
          last_name: "Lovelace",
        },
      }),
    ];
    const requests: {
      readonly url: string;
      readonly init?: RequestInit;
    }[] = [];
    const verifications: DeviceVerification[] = [];
    const sleeps: number[] = [];
    let now = 1_000;

    const result = await loginWithWorkosDevice({
      clientId: "client_public123",
      fetch: (input, init) => {
        requests.push({
          url: inputUrl(input),
          ...(init === undefined ? {} : { init }),
        });
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
      onVerification: (verification) => {
        verifications.push(verification);
      },
    });

    expect(result).toEqual({
      accessToken: "access-token-that-is-long-enough",
      refreshToken: "refresh-token-that-is-long-enough",
      user: {
        id: "user_abc123",
        email: "human@example.com",
        name: "Ada Lovelace",
      },
    });
    expect(sleeps).toEqual([2_000, 2_000, 7_000]);
    expect(JSON.stringify(verifications)).not.toContain(deviceCode);
    expect(
      requests.map((request) => request.init?.redirect),
    ).toEqual(["error", "error", "error", "error"]);
    expect(formEntries(requests[1]?.init?.body)).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: "client_public123",
    });
  });

  test("rejects provider redirects and oversized responses with static diagnostics", async () => {
    const sensitiveLocation =
      "https://attacker.example/collect?refresh_token=do-not-leak";
    const redirectError = await loginWithWorkosDevice({
      clientId: "client_public123",
      fetch: () =>
        Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { Location: sensitiveLocation },
          }),
        ),
      now: () => 0,
      sleep: () => Promise.resolve(),
      onVerification: () => undefined,
    }).catch((error: unknown) => error);

    const oversizedError = await loginWithWorkosDevice({
      clientId: "client_public123",
      fetch: () =>
        Promise.resolve(
          new Response("{}", {
            headers: {
              "Content-Type": "application/json",
              "Content-Length": String(256 * 1_024 + 1),
            },
          }),
        ),
      now: () => 0,
      sleep: () => Promise.resolve(),
      onVerification: () => undefined,
    }).catch((error: unknown) => error);

    expect(redirectError).toBeInstanceOf(HumanClientError);
    expect(oversizedError).toBeInstanceOf(HumanClientError);
    expect(JSON.stringify(redirectError)).not.toContain("attacker.example");
    expect(JSON.stringify(redirectError)).not.toContain("do-not-leak");
    expect(JSON.stringify(oversizedError)).toMatch(
      /invalid response|too large/u,
    );
  });

  test("rejects credential fields in verification URL fragments", async () => {
    let verificationCalls = 0;
    const error = await loginWithWorkosDevice({
      clientId: "client_public123",
      fetch: () =>
        Promise.resolve(Response.json({
          device_code: "secret-device-code",
          user_code: "ABCD-EFGH",
          verification_uri:
            "https://auth.example.com/device#access_token=must-not-escape",
          expires_in: 600,
        })),
      now: () => 0,
      sleep: () => Promise.resolve(),
      onVerification: () => {
        verificationCalls += 1;
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HumanClientError);
    expect(JSON.stringify(error)).not.toContain("must-not-escape");
    expect(verificationCalls).toBe(0);
  });
});
