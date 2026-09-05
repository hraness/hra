import { describe, expect, test } from "bun:test";

import {
  accessTokenExpiresAt,
  accessTokenExpirySkewMs,
  cloudMutations,
  cloudQueries,
  CloudRequestDeadlineError,
  CloudResponseTooLargeError,
  createConvexCloudTransport,
  isExpiredAccessToken,
  maximumCloudResponseBytes,
} from "./client";
import { cloudLimits } from "./contracts";

const deploymentUrl = "https://quiet-otter-123.convex.cloud";

function neverSettles(): Promise<Response> {
  return new Promise<Response>(() => undefined);
}

function fakeFetch(
  implementation: (
    resource: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) => Promise<Response>,
): typeof globalThis.fetch {
  return Object.assign(implementation, {
    preconnect: (...parameters: Parameters<typeof globalThis.fetch.preconnect>): void => {
      void parameters;
    },
  });
}

describe("bounded Convex transport", () => {
  test("keeps device presence inside the closed transport surface", () => {
    expect(cloudQueries).toContain("presence:current");
    expect(cloudMutations).toContain("presence:connect");
    expect(cloudMutations).toContain("presence:disconnect");
    expect(cloudMutations).toContain("presence:heartbeat");
  });

  test("admits only the status-first account-erasure pair", () => {
    expect(cloudQueries.filter((name) => name.startsWith("accountDeletion:")))
      .toEqual(["accountDeletion:status"]);
    expect(cloudMutations.filter((name) => name.startsWith("accountDeletion:")))
      .toEqual(["accountDeletion:request"]);
  });

  test("admits exact device-command terminal confirmations", () => {
    expect(cloudMutations).toContain("deviceCommands:confirmRevokedTerminal");
    expect(cloudMutations).toContain("deviceCommands:confirmTerminalRecovery");
  });

  test("ends a hung query even when fetch ignores its abort signal", async () => {
    let calls = 0;
    let observedSignal: AbortSignal | null | undefined;
    const ignoredFetch = fakeFetch((_resource, init) => {
      calls += 1;
      observedSignal = init?.signal;
      return neverSettles();
    });
    const transport = createConvexCloudTransport({
      accessToken: async () => null,
      deploymentUrl,
      fetch: ignoredFetch,
      requestTimeoutMs: 10,
    });

    await expect(transport.query("account:current", {})).rejects.toMatchObject({
      name: "CloudRequestDeadlineError",
      timeoutMs: 10,
    });
    expect(calls).toBe(1);
    expect(observedSignal?.aborted).toBe(true);
  });

  test("threads lifetime cancellation through an already-started hung fetch", async () => {
    const lifetime = new AbortController();
    let calls = 0;
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const ignoredFetch = fakeFetch(() => {
      calls += 1;
      startedResolve();
      return neverSettles();
    });
    const transport = createConvexCloudTransport({
      accessToken: async () => null,
      deploymentUrl,
      fetch: ignoredFetch,
      lifetimeSignal: lifetime.signal,
      requestTimeoutMs: 1_000,
    });

    const pending = transport.query("account:current", {});
    await started;
    const reason = new Error("test transport closed");
    lifetime.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(calls).toBe(1);
  });

  test("does not retry a mutation whose effect may have committed before timeout", async () => {
    let calls = 0;
    let effects = 0;
    const lostResponseFetch = fakeFetch((_resource, init) => {
      calls += 1;
      effects += 1;
      init?.signal?.addEventListener("abort", () => undefined, { once: true });
      return neverSettles();
    });
    const transport = createConvexCloudTransport({
      accessToken: async () => null,
      deploymentUrl,
      fetch: lostResponseFetch,
      requestTimeoutMs: 10,
    });

    await expect(transport.mutation("commands:enqueue", {})).rejects.toBeInstanceOf(
      CloudRequestDeadlineError,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect({ calls, effects }).toEqual({ calls: 1, effects: 1 });
  });

  test("rejects an invalid request deadline before constructing a client", () => {
    expect(() => createConvexCloudTransport({
      accessToken: async () => null,
      deploymentUrl,
      requestTimeoutMs: 0,
    })).toThrow("Cloud request timeout must be an integer from 1ms through 120000ms.");
  });

  test("bounds the response body by bytes before the Convex client parses it", async () => {
    const successBody = JSON.stringify({ logLines: [], status: "success", value: { ok: true } });
    const oversized = JSON.stringify({
      logLines: [],
      status: "success",
      value: { padding: "x".repeat(successBody.length + 64) },
    });
    const responses = new Map<string, () => Response>([
      ["small", () => new Response(successBody, { status: 200 })],
      // The declared length alone rejects, even though the delivered body is small.
      ["oversized-declared", () => new Response(
        successBody,
        { headers: { "content-length": String(oversized.length) }, status: 200 },
      )],
      ["oversized-streamed", () => new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const bytes = new TextEncoder().encode(oversized);
            for (let offset = 0; offset < bytes.byteLength; offset += 7) {
              controller.enqueue(bytes.subarray(offset, Math.min(offset + 7, bytes.byteLength)));
            }
            controller.close();
          },
        }),
        { status: 200 },
      )],
    ]);
    let selected = "small";
    const transport = createConvexCloudTransport({
      accessToken: async () => null,
      deploymentUrl,
      fetch: fakeFetch(async () => {
        const build = responses.get(selected);
        if (build === undefined) throw new Error("unexpected fixture");
        return build();
      }),
      maximumResponseBytes: successBody.length + 32,
      requestTimeoutMs: 1_000,
    });

    await expect(transport.query("account:current", {})).resolves.toEqual({ ok: true });

    selected = "oversized-declared";
    await expect(transport.query("account:current", {})).rejects.toBeInstanceOf(
      CloudResponseTooLargeError,
    );

    selected = "oversized-streamed";
    await expect(transport.query("account:current", {})).rejects.toMatchObject({
      code: "CLOUD_RESPONSE_TOO_LARGE",
      maximumBytes: successBody.length + 32,
      name: "CloudResponseTooLargeError",
    });
  });

  test("derives the default response bound from one full detail-chunk page", () => {
    expect(maximumCloudResponseBytes).toBeGreaterThan(
      cloudLimits.pageSize * cloudLimits.ciphertextCharacters,
    );
    expect(maximumCloudResponseBytes).toBeLessThan(64 * 1_048_576);
    expect(() => createConvexCloudTransport({
      accessToken: async () => null,
      deploymentUrl,
      maximumResponseBytes: maximumCloudResponseBytes + 1,
    })).toThrow(/response bound/u);
    expect(() => createConvexCloudTransport({
      accessToken: async () => null,
      deploymentUrl,
      maximumResponseBytes: 0,
    })).toThrow(/response bound/u);
  });
});

describe("expired access tokens", () => {
  const encode = (payload: unknown): string =>
    Buffer.from(JSON.stringify(payload)).toString("base64url");
  const header = encode({ alg: "RS256", typ: "JWT" });
  const jwt = (payload: unknown): string => `${header}.${encode(payload)}.${"s".repeat(43)}`;
  const now = 1_800_000_000_000;

  test("reads the exp claim without trusting anything else", () => {
    expect(accessTokenExpiresAt(jwt({ exp: 1_800_000_900, sub: "user|session" })))
      .toBe(1_800_000_900_000);
    for (const opaque of [
      "a".repeat(64),
      `${header}.${encode({ sub: "user" })}.sig`,
      `${header}.${encode([])}.sig`,
      `${header}.${encode({ exp: "soon" })}.sig`,
      `${header}.${encode({ exp: -1 })}.sig`,
      `${header}.not-json.sig`,
      "x.y",
    ]) {
      expect(accessTokenExpiresAt(opaque)).toBeNull();
      expect(isExpiredAccessToken(opaque, now)).toBe(false);
    }
    expect(isExpiredAccessToken(jwt({ exp: (now + accessTokenExpirySkewMs) / 1_000 }), now))
      .toBe(true);
    expect(isExpiredAccessToken(jwt({ exp: (now + accessTokenExpirySkewMs + 1_000) / 1_000 }), now))
      .toBe(false);
  });

  test("never presents an expired token, so a refresh-token sign-in can proceed", async () => {
    const authorizations: (string | null)[] = [];
    const fetchImplementation = fakeFetch(async (_resource, init) => {
      const headers = new Headers(init?.headers);
      authorizations.push(headers.get("authorization"));
      return new Response(JSON.stringify({ status: "success", value: null, logLines: [] }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    });
    let token = jwt({ exp: (now - 60_000) / 1_000 });
    const transport = createConvexCloudTransport({
      accessToken: async () => token,
      deploymentUrl,
      fetch: fetchImplementation,
      now: () => now,
    });
    await transport.action("auth:signIn", { refreshToken: "refresh" });
    token = jwt({ exp: (now + 14 * 60_000) / 1_000 });
    await transport.query("account:current", {});
    expect(authorizations).toEqual([null, `Bearer ${token}`]);
  });
});
