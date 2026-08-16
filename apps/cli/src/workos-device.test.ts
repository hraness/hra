import { describe, expect, test } from "bun:test";

import { loginWithWorkosDevice, type DeviceVerification } from "./workos-device";

function formEntries(body: RequestInit["body"]): Record<string, string> {
  if (!(body instanceof URLSearchParams)) throw new Error("expected a form body");
  return Object.fromEntries(body);
}

function inputUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

describe("WorkOS device authentication", () => {
  test("polls the public endpoints directly and obeys pending and slow-down intervals", async () => {
    const deviceCode = "secret-device-code-never-shown";
    const requests: { readonly url: string; readonly init?: RequestInit }[] = [];
    const responses = [
      Response.json({
        device_code: deviceCode,
        user_code: "ABCD-EFGH",
        verification_uri: "https://auth.example.com/device",
        verification_uri_complete: "https://auth.example.com/device?code=ABCD-EFGH",
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
          object: "user",
        },
      }),
    ];
    let now = 1_000;
    const sleeps: number[] = [];
    const verifications: DeviceVerification[] = [];
    const opened: string[] = [];

    const result = await loginWithWorkosDevice({
      clientId: "client_public123",
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
      onVerification: (verification) => verifications.push(verification),
      openBrowser: (url) => {
        opened.push(url);
        return Promise.resolve();
      },
    });

    expect(result).toEqual({
      accessToken: "access-token-that-is-long-enough",
      refreshToken: "refresh-token-that-is-long-enough",
      user: { id: "user_abc123", email: "human@example.com", name: "Ada Lovelace" },
    });
    expect(sleeps).toEqual([2_000, 2_000, 7_000]);
    expect(verifications).toEqual([
      {
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.example.com/device",
        verificationUriComplete: "https://auth.example.com/device?code=ABCD-EFGH",
        expiresAt: 601_000,
      },
    ]);
    expect(JSON.stringify(verifications)).not.toContain(deviceCode);
    expect(opened).toEqual(["https://auth.example.com/device?code=ABCD-EFGH"]);
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.workos.com/user_management/authorize/device",
      "https://api.workos.com/user_management/authenticate",
      "https://api.workos.com/user_management/authenticate",
      "https://api.workos.com/user_management/authenticate",
    ]);
    expect(formEntries(requests[0]?.init?.body)).toEqual({ client_id: "client_public123" });
    expect(formEntries(requests[1]?.init?.body)).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: "client_public123",
    });
    for (const request of requests) {
      expect(request.init?.method).toBe("POST");
      expect(request.init?.redirect).toBe("error");
      expect(new Headers(request.init?.headers).get("Content-Type")).toBe(
        "application/x-www-form-urlencoded",
      );
    }
  });

  test("treats denial and expiry as terminal without exposing provider fields", async () => {
    const deviceCode = "secret-device-code-never-shown";
    let call = 0;
    let caught: unknown;
    try {
      await loginWithWorkosDevice({
        clientId: "client_public123",
        fetch: () => {
          call += 1;
          return Promise.resolve(
            call === 1
              ? Response.json({
                  device_code: deviceCode,
                  user_code: "ABCD-EFGH",
                  verification_uri: "https://auth.example.com/device",
                  expires_in: 600,
                  interval: 1,
                })
              : Response.json(
                  { error: "access_denied", error_description: `denied ${deviceCode}` },
                  { status: 400 },
                ),
          );
        },
        now: () => 0,
        sleep: () => Promise.resolve(),
        onVerification: () => undefined,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "AUTHENTICATION_FAILED" });
    expect(JSON.stringify(caught)).not.toContain(deviceCode);
    expect(call).toBe(2);
  });
});
