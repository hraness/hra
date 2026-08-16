import { describe, expect, test } from "bun:test";

import {
  HumanSessionCoordinator,
  type HumanAuthenticationStore,
  type HumanOperationResult,
  type HumanRefreshDriver,
} from "./session";
import type {
  HumanAuthentication,
  HumanAuthenticationSnapshot,
} from "./human-auth";

interface OperationFailure {
  readonly code: "AUTHENTICATION_FAILED" | "CONFLICT";
}

function authentication(
  accessToken = "access-token-that-is-long-enough",
  refreshToken = "refresh-token-that-is-long-enough",
): HumanAuthentication {
  return {
    version: 1,
    apiUrl: "https://hra.example.com",
    accessToken,
    refreshToken,
    user: {
      id: "user_abc123",
      email: "human@example.com",
      name: "Human",
    },
  };
}

function snapshot(
  generation: number,
  value = authentication(),
): HumanAuthenticationSnapshot {
  return { generation, authentication: value };
}

function memoryStore(
  initial: HumanAuthenticationSnapshot | null,
): HumanAuthenticationStore & {
  current: HumanAuthenticationSnapshot | null;
  compareCalls: number;
  clearCalls: number;
} {
  return {
    current: initial,
    compareCalls: 0,
    clearCalls: 0,
    read() {
      return Promise.resolve(this.current);
    },
    compareAndSwap(input) {
      this.compareCalls += 1;
      if (this.current?.generation !== input.expectedGeneration) {
        return Promise.resolve(null);
      }
      this.current = input.next;
      return Promise.resolve(this.current);
    },
    clear(input) {
      this.clearCalls += 1;
      if (this.current?.generation !== input.expectedGeneration) {
        return Promise.resolve(false);
      }
      this.current = null;
      return Promise.resolve(true);
    },
  };
}

describe("human session coordinator", () => {
  test("signed-out execution performs zero operation or refresh network work", async () => {
    const store = memoryStore(null);
    let operationCalls = 0;
    let refreshCalls = 0;
    const coordinator = new HumanSessionCoordinator({
      store,
      refresh: {
        refresh: () => {
          refreshCalls += 1;
          return Promise.resolve({
            ok: false,
            outcome: "indeterminate",
          });
        },
      },
    });

    const result = await coordinator.execute(() => {
      operationCalls += 1;
      return Promise.resolve({ ok: true, data: "unexpected" });
    });

    expect(result).toEqual({
      ok: false,
      kind: "session",
      error: {
        code: "SIGNED_OUT",
        message: "no human account is signed in",
      },
    });
    expect(operationCalls).toBe(0);
    expect(refreshCalls).toBe(0);
  });

  test("coalesces concurrent authentication failures into one rotation", async () => {
    const store = memoryStore(snapshot(7));
    let refreshCalls = 0;
    let releaseRefresh:
      | ((value: Awaited<ReturnType<HumanRefreshDriver["refresh"]>>) => void)
      | undefined;
    const refreshGate = new Promise<
      Awaited<ReturnType<HumanRefreshDriver["refresh"]>>
    >((resolve) => {
      releaseRefresh = resolve;
    });
    const coordinator = new HumanSessionCoordinator({
      store,
      refresh: {
        refresh: (input) => {
          refreshCalls += 1;
          expect(input.refreshToken).toBe(
            "refresh-token-that-is-long-enough",
          );
          return refreshGate;
        },
      },
    });
    let oldTokenCalls = 0;
    let rotatedTokenCalls = 0;
    const operation = (
      accessToken: string,
    ): Promise<HumanOperationResult<string, OperationFailure>> => {
      if (accessToken === "access-token-that-is-long-enough") {
        oldTokenCalls += 1;
        return Promise.resolve({
          ok: false,
          error: { code: "AUTHENTICATION_FAILED" },
        });
      }
      rotatedTokenCalls += 1;
      return Promise.resolve({ ok: true, data: "ready" });
    };

    const executions = [
      coordinator.execute(operation),
      coordinator.execute(operation),
      coordinator.execute(operation),
    ];
    for (let attempt = 0; attempt < 10 && refreshCalls === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(refreshCalls).toBe(1);
    releaseRefresh?.({
      ok: true,
      data: {
        accessToken: "rotated-access-token-that-is-long-enough",
        refreshToken: "rotated-refresh-token-that-is-long-enough",
        user: {
          id: "user_abc123",
          email: "human@example.com",
          name: "Human",
        },
      },
    });
    const results = await Promise.all(executions);

    expect(results).toEqual([
      { ok: true, data: "ready" },
      { ok: true, data: "ready" },
      { ok: true, data: "ready" },
    ]);
    expect(oldTokenCalls).toBe(3);
    expect(rotatedTokenCalls).toBe(3);
    expect(refreshCalls).toBe(1);
    expect(store.compareCalls).toBe(1);
    expect(store.current?.generation).toBe(8);
    expect(JSON.stringify(results)).not.toContain("refresh-token");
  });

  test("a stale refresh writer adopts a newer generation instead of overwriting it", async () => {
    const store = memoryStore(snapshot(3));
    const winner = snapshot(
      4,
      authentication(
        "winner-access-token-that-is-long-enough",
        "winner-refresh-token-that-is-long-enough",
      ),
    );
    const coordinator = new HumanSessionCoordinator({
      store,
      refresh: {
        refresh: () => {
          store.current = winner;
          return Promise.resolve({
            ok: true,
            data: {
              accessToken: "loser-access-token-that-is-long-enough",
              refreshToken: "loser-refresh-token-that-is-long-enough",
              user: {
                id: "user_abc123",
                email: "human@example.com",
                name: "Human",
              },
            },
          });
        },
      },
    });
    const seenTokens: string[] = [];

    const result = await coordinator.execute<string, OperationFailure>(
      (accessToken) => {
        seenTokens.push(accessToken);
        return Promise.resolve(
          accessToken === winner.authentication.accessToken
            ? { ok: true, data: "winner" }
            : {
                ok: false,
                error: { code: "AUTHENTICATION_FAILED" },
              },
        );
      },
    );

    expect(result).toEqual({ ok: true, data: "winner" });
    expect(store.current).toEqual(winner);
    expect(store.compareCalls).toBe(1);
    expect(seenTokens).toEqual([
      "access-token-that-is-long-enough",
      "winner-access-token-that-is-long-enough",
    ]);
    expect(JSON.stringify(result)).not.toContain("winner-refresh-token");
  });

  test("an indeterminate rotation clears only the attempted generation", async () => {
    const store = memoryStore(snapshot(0));
    const coordinator = new HumanSessionCoordinator({
      store,
      refresh: {
        refresh: () =>
          Promise.resolve({ ok: false, outcome: "indeterminate" }),
      },
    });

    const result = await coordinator.execute<string, OperationFailure>(() =>
      Promise.resolve({
        ok: false,
        error: { code: "AUTHENTICATION_FAILED" },
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      kind: "session",
      error: { code: "AUTH_REFRESH_INDETERMINATE" },
    });
    expect(store.current).toBeNull();
    expect(store.clearCalls).toBe(1);
    expect(JSON.stringify(result)).not.toContain(
      "refresh-token-that-is-long-enough",
    );
  });

  test("never shares an in-flight refresh across a changed principal", async () => {
    const store = memoryStore(snapshot(7));
    let releaseFirst:
      | ((value: Awaited<ReturnType<HumanRefreshDriver["refresh"]>>) => void)
      | undefined;
    const firstRefresh = new Promise<
      Awaited<ReturnType<HumanRefreshDriver["refresh"]>>
    >((resolve) => {
      releaseFirst = resolve;
    });
    let refreshCalls = 0;
    const coordinator = new HumanSessionCoordinator({
      store,
      refresh: {
        refresh: () => {
          refreshCalls += 1;
          if (refreshCalls === 1) return firstRefresh;
          return Promise.resolve({
            ok: true,
            data: {
              accessToken: "second-rotated-access-token",
              refreshToken: "second-rotated-refresh-token",
              user: {
                id: "user_second",
                email: "second@example.com",
              },
            },
          });
        },
      },
    });
    const seenBySecond: string[] = [];
    const first = coordinator.execute<string, OperationFailure>(() =>
      Promise.resolve({
        ok: false,
        error: { code: "AUTHENTICATION_FAILED" },
      }));
    for (let attempt = 0; attempt < 10 && refreshCalls === 0; attempt += 1) {
      await Promise.resolve();
    }
    store.current = snapshot(8, {
      ...authentication(
        "second-stale-access-token",
        "second-stale-refresh-token",
      ),
      user: {
        id: "user_second",
        email: "second@example.com",
      },
    });
    const second = coordinator.execute<string, OperationFailure>(
      (accessToken) => {
        seenBySecond.push(accessToken);
        return Promise.resolve(
          accessToken === "second-rotated-access-token"
            ? { ok: true, data: "second" }
            : {
                ok: false,
                error: { code: "AUTHENTICATION_FAILED" },
              },
        );
      },
    );
    releaseFirst?.({
      ok: true,
      data: {
        accessToken: "first-rotated-access-token",
        refreshToken: "first-rotated-refresh-token",
        user: {
          id: "user_abc123",
          email: "human@example.com",
        },
      },
    });

    expect(await first).toMatchObject({
      ok: false,
      kind: "session",
      error: { code: "AUTHENTICATION_FAILED" },
    });
    expect(await second).toEqual({ ok: true, data: "second" });
    expect(seenBySecond).toEqual([
      "second-stale-access-token",
      "second-rotated-access-token",
    ]);
    expect(seenBySecond).not.toContain("first-rotated-access-token");
    expect(refreshCalls).toBe(2);
  });

  test("clears the rotated generation after a second authentication failure", async () => {
    const store = memoryStore(snapshot(2));
    const coordinator = new HumanSessionCoordinator({
      store,
      refresh: {
        refresh: () =>
          Promise.resolve({
            ok: true,
            data: {
              accessToken: "rotated-access-token",
              refreshToken: "rotated-refresh-token",
              user: {
                id: "user_abc123",
                email: "human@example.com",
              },
            },
          }),
      },
    });

    const result = await coordinator.execute<string, OperationFailure>(() =>
      Promise.resolve({
        ok: false,
        error: { code: "AUTHENTICATION_FAILED" },
      }));

    expect(result).toMatchObject({
      ok: false,
      kind: "session",
      error: { code: "AUTHENTICATION_FAILED" },
    });
    expect(store.current).toBeNull();
    expect(store.clearCalls).toBe(1);
  });

  test("uses the actual replacement generation returned across a custody gap", async () => {
    const store = memoryStore(snapshot(0));
    store.compareAndSwap = function (input) {
      this.compareCalls += 1;
      if (this.current?.generation !== input.expectedGeneration) {
        return Promise.resolve(null);
      }
      this.current = {
        ...input.next,
        generation: 2,
      };
      return Promise.resolve(this.current);
    };
    const coordinator = new HumanSessionCoordinator({
      store,
      refresh: {
        refresh: () =>
          Promise.resolve({
            ok: true,
            data: {
              accessToken: "gap-rotated-access-token",
              refreshToken: "gap-rotated-refresh-token",
              user: {
                id: "user_abc123",
                email: "human@example.com",
              },
            },
          }),
      },
    });

    expect(await coordinator.execute<string, OperationFailure>(() =>
      Promise.resolve({
        ok: false,
        error: { code: "AUTHENTICATION_FAILED" },
      }))).toMatchObject({
      ok: false,
      kind: "session",
      error: { code: "AUTHENTICATION_FAILED" },
    });
    expect(store.compareCalls).toBe(1);
    expect(store.clearCalls).toBe(1);
    expect(store.current).toBeNull();
  });
});
