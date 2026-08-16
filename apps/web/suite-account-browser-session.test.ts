import { describe, expect, test } from "bun:test";

import {
  loadSuiteOidcBrowserSession,
  signOutSuiteOidcBrowserSession,
  SUITE_OIDC_REFRESH_LOCK_NAME,
  type SuiteOidcBrowserSessionDependencies,
  type SuiteOidcExclusiveLock,
} from "./suite-account-browser-session";

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const body = JSON.stringify(value);
  return new Response(body, {
    ...init,
    headers: {
      "content-length": String(new TextEncoder().encode(body).byteLength),
      "content-type": "application/json; charset=utf-8",
      ...init.headers,
    },
  });
}

function serialLock(
  observedNames: string[],
): SuiteOidcExclusiveLock {
  let tail = Promise.resolve();
  return async (name, task) => {
    observedNames.push(name);
    const predecessor = tail;
    let release = (): void => undefined;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

function requestPath(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

describe("suite OIDC browser session", () => {
  test("serializes concurrent rotation and re-reads inside the lock", async () => {
    let refreshed = false;
    let sessionRequests = 0;
    let refreshRequests = 0;
    const lockNames: string[] = [];
    const withExclusiveLock = serialLock(lockNames);
    const fetcher: NonNullable<
      SuiteOidcBrowserSessionDependencies["fetch"]
    > = (input, init) => {
      const path = requestPath(input);
      if (path === "/api/suite-auth/session" && init?.method === "GET") {
        sessionRequests += 1;
        return Promise.resolve(jsonResponse(refreshed
          ? { kind: "signed_in", session: { suiteAccountId: "suite_1" } }
          : { kind: "refresh_required" }));
      }
      if (path === "/api/suite-auth/refresh" && init?.method === "POST") {
        refreshRequests += 1;
        refreshed = true;
        return Promise.resolve(jsonResponse({
          kind: "signed_in",
          session: { suiteAccountId: "suite_1" },
        }));
      }
      throw new Error(`Unexpected request: ${path}`);
    };

    const [first, second] = await Promise.all([
      loadSuiteOidcBrowserSession({
        fetch: fetcher,
        withExclusiveLock,
      }),
      loadSuiteOidcBrowserSession({
        fetch: fetcher,
        withExclusiveLock,
      }),
    ]);

    expect(first).toEqual({
      kind: "signed_in",
      session: { suiteAccountId: "suite_1" },
    });
    expect(second).toEqual(first);
    expect(refreshRequests).toBe(1);
    expect(sessionRequests).toBe(4);
    expect(lockNames).toEqual([
      SUITE_OIDC_REFRESH_LOCK_NAME,
      SUITE_OIDC_REFRESH_LOCK_NAME,
    ]);
  });

  test("refreshes only the exact refresh-required envelope", async () => {
    const paths: string[] = [];
    const value = await loadSuiteOidcBrowserSession({
      fetch: (input) => {
        paths.push(requestPath(input));
        return Promise.resolve(jsonResponse({
          kind: "refresh_required",
          unexpected: true,
        }));
      },
      withExclusiveLock: async (_name, task) => await task(),
    });

    expect(value).toEqual({
      kind: "refresh_required",
      unexpected: true,
    });
    expect(paths).toEqual(["/api/suite-auth/session"]);
  });

  test("rejects oversized and non-JSON responses before parsing", async () => {
    let oversizedError: unknown;
    try {
      await loadSuiteOidcBrowserSession({
        fetch: () => Promise.resolve(new Response("{}", {
          headers: {
            "content-length": "32769",
            "content-type": "application/json",
          },
        })),
        withExclusiveLock: null,
      });
    } catch (error) {
      oversizedError = error;
    }
    expect(oversizedError).toBeInstanceOf(Error);
    expect((oversizedError as Error).message).toContain("too large");

    let contentTypeError: unknown;
    try {
      await loadSuiteOidcBrowserSession({
        fetch: () => Promise.resolve(new Response("{}", {
          headers: { "content-type": "text/plain" },
        })),
        withExclusiveLock: null,
      });
    } catch (error) {
      contentTypeError = error;
    }
    expect(contentTypeError).toBeInstanceOf(Error);
    expect((contentTypeError as Error).message).toContain("not JSON");
  });

  test("serializes sign-out with refresh and notifies only after confirmation", async () => {
    const lockNames: string[] = [];
    const requests: string[] = [];
    let refreshed = false;
    let signedOut = false;
    let notified = 0;
    const fetcher: NonNullable<
      SuiteOidcBrowserSessionDependencies["fetch"]
    > = (input, init) => {
      const request = `${init?.method ?? "GET"} ${requestPath(input)}`;
      requests.push(request);
      if (request === "GET /api/suite-auth/session") {
        return Promise.resolve(jsonResponse(
          signedOut
            ? { kind: "signed_out" }
            : refreshed
              ? { kind: "signed_in", session: { suiteAccountId: "suite_1" } }
              : { kind: "refresh_required" },
        ));
      }
      if (request === "POST /api/suite-auth/refresh") {
        refreshed = true;
        return Promise.resolve(jsonResponse({
          kind: "signed_in",
          session: { suiteAccountId: "suite_1" },
        }));
      }
      if (request === "POST /api/suite-auth/sign-out") {
        signedOut = true;
        return Promise.resolve(jsonResponse({ kind: "signed_out" }));
      }
      throw new Error(`Unexpected request: ${request}`);
    };
    const withExclusiveLock = serialLock(lockNames);

    await Promise.all([
      loadSuiteOidcBrowserSession({ fetch: fetcher, withExclusiveLock }),
      signOutSuiteOidcBrowserSession({
        fetch: fetcher,
        notifySignedOut: () => {
          notified += 1;
        },
        withExclusiveLock,
      }),
    ]);

    expect(requests).toEqual([
      "GET /api/suite-auth/session",
      "POST /api/suite-auth/sign-out",
      "GET /api/suite-auth/session",
    ]);
    expect(lockNames).toEqual([
      SUITE_OIDC_REFRESH_LOCK_NAME,
      SUITE_OIDC_REFRESH_LOCK_NAME,
    ]);
    expect(notified).toBe(1);
  });

  test("does not broadcast an invalid sign-out response", () => {
    let notified = false;
    expect(signOutSuiteOidcBrowserSession({
      fetch: () => Promise.resolve(jsonResponse({
        kind: "signed_out",
        unexpected: true,
      })),
      notifySignedOut: () => {
        notified = true;
      },
      withExclusiveLock: null,
    })).rejects.toThrow("sign-out response was invalid");
    expect(notified).toBe(false);
  });
});
