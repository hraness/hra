import { describe, expect, test } from "bun:test";

import {
  cloudMutations,
  cloudQueries,
  CloudRequestDeadlineError,
  createConvexCloudTransport,
} from "./client";

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
});
