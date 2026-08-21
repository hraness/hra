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
    version: 2,
    apiUrl: "https://hra.example.com",
    accessToken,
    refreshToken,
    user: {
      id: "user_abc123",
      email: "human@example.com",
      name: "Human",
    },
    organization: {
      id: "org_cloud",
      name: "Cloud",
      role: "owner",
      status: "active",
    },
    workspace: {
      id: "workspace_cloud",
      organizationId: "org_cloud",
      slug: "cloud",
      name: "Cloud",
      taskKeyPrefix: "CLD",
      roles: ["planner"],
    },
  };
}

function refreshData(
  accessToken: string,
  refreshToken: string,
  base: HumanAuthentication = authentication(),
): unknown {
  return {
    accessToken,
    refreshToken,
    user: base.user,
    organization: base.organization,
    workspace: base.workspace,
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
    preserveCalls: number;
    clearCalls: number;
} {
  return {
    current: initial,
    compareCalls: 0,
    preserveCalls: 0,
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
    preserveForRecovery(input) {
      this.preserveCalls += 1;
      if (this.current?.generation !== input.expectedGeneration) {
        return Promise.resolve(false);
      }
      this.current = null;
      return Promise.resolve(true);
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
  test("reopens recovery admission only after active bearer work settles", async () => {
    const store = memoryStore(snapshot(0));
    let entered = (): void => undefined;
    const operationEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release = (): void => undefined;
    const operationReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    const coordinator = new HumanSessionCoordinator({
      store,
      refresh: {
        refresh: () => Promise.resolve({
          ok: false,
          outcome: "authentication_failed",
        }),
      },
    });
    const active = coordinator.execute(async () => {
      entered();
      await operationReleased;
      return { ok: true as const, data: "settled" };
    });
    await operationEntered;

    coordinator.closeAdmission();
    expect(coordinator.reopenAdmission()).toBe(false);
    release();
    expect(await active).toEqual({ ok: true, data: "settled" });
    await coordinator.settled();
    expect(coordinator.reopenAdmission()).toBe(true);
    expect(await coordinator.execute(() =>
      Promise.resolve({ ok: true, data: "fresh" }))).toEqual({
      ok: true,
      data: "fresh",
    });
  });

  test("closed admission joins every bearer operation through credential settlement", async () => {
    const store = memoryStore(snapshot(0));
    let operationEntered = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      operationEntered = resolve;
    });
    let releaseOperation = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    let operationCalls = 0;
    const coordinator = new HumanSessionCoordinator({
      store,
      refresh: {
        refresh: () => Promise.resolve({
          ok: false,
          outcome: "authentication_failed",
        }),
      },
    });
    const active = coordinator.execute<string, OperationFailure>(async () => {
      operationCalls += 1;
      operationEntered();
      await released;
      return {
        ok: false,
        error: { code: "AUTHENTICATION_FAILED" },
      };
    });
    await entered;
    coordinator.closeAdmission();
    const settlement = coordinator.settled();
    expect(await coordinator.execute<string, OperationFailure>(() => {
      operationCalls += 1;
      return Promise.resolve({ ok: true, data: "unexpected" });
    })).toMatchObject({
      ok: false,
      kind: "session",
      error: { code: "SERVICE_UNAVAILABLE" },
    });
    expect(await Promise.race([
      settlement.then(() => "settled" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 5)),
    ])).toBe("blocked");

    releaseOperation();
    expect(await active).toMatchObject({
      ok: false,
      kind: "session",
      error: { code: "AUTHENTICATION_FAILED" },
    });
    await settlement;
    expect(operationCalls).toBe(1);
    expect(store.clearCalls).toBe(1);
    expect(store.current).toBeNull();
  });

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
      data: refreshData(
        "rotated-access-token-that-is-long-enough",
        "rotated-refresh-token-that-is-long-enough",
      ),
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

  test("supplies the exact credential snapshot used by each retried attempt", async () => {
    const store = memoryStore(snapshot(3));
    const coordinator = new HumanSessionCoordinator({
      store,
      refresh: {
        refresh: () => Promise.resolve({
          ok: true,
          data: refreshData(
            "attempt-authority-b-access-token",
            "attempt-authority-b-refresh-token",
          ),
        }),
      },
    });
    const attempts: Array<Readonly<{ generation: number; token: string }>> = [];

    expect(await coordinator.execute<string, OperationFailure>(
      (accessToken, authority) => {
        attempts.push({ generation: authority.generation, token: accessToken });
        expect(authority.authentication.accessToken).toBe(accessToken);
        return Promise.resolve(
          authority.generation === 3
            ? {
                ok: false,
                error: { code: "AUTHENTICATION_FAILED" },
              }
            : { ok: true, data: "selected" },
        );
      },
    )).toEqual({ ok: true, data: "selected" });
    expect(attempts).toEqual([
      { generation: 3, token: "access-token-that-is-long-enough" },
      { generation: 4, token: "attempt-authority-b-access-token" },
    ]);
  });

  test("an exclusive transition drains ordinary work and never reopens terminal admission", async () => {
    const store = memoryStore(snapshot(0));
    const coordinator = new HumanSessionCoordinator({
      store,
      refresh: {
        refresh: () => Promise.resolve({
          ok: false,
          outcome: "authentication_failed",
        }),
      },
    });
    let releaseTransition = (): void => undefined;
    const transitionReleased = new Promise<void>((resolve) => {
      releaseTransition = resolve;
    });
    let transitionEntered = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      transitionEntered = resolve;
    });
    const transition = coordinator.withExclusiveTransition(async (session) => {
      const result = await session.execute(() => {
        transitionEntered();
        return Promise.resolve({ ok: true, data: "rotated" });
      });
      await transitionReleased;
      return result;
    });
    await entered;

    expect(await coordinator.execute(() =>
      Promise.resolve({ ok: true, data: "must be paused" }))).toMatchObject({
      ok: false,
      kind: "session",
      error: { code: "SERVICE_UNAVAILABLE" },
    });
    coordinator.closeAdmission();
    expect(coordinator.reopenAdmission()).toBe(false);
    releaseTransition();
    expect(await transition).toEqual({
      ok: true,
      data: { ok: true, data: "rotated" },
    });
    await coordinator.settled();
    expect(await coordinator.execute(() =>
      Promise.resolve({ ok: true, data: "must stay closed" }))).toMatchObject({
      ok: false,
      kind: "session",
      error: { code: "SERVICE_UNAVAILABLE" },
    });
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
            data: refreshData(
              "loser-access-token-that-is-long-enough",
              "loser-refresh-token-that-is-long-enough",
            ),
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

  test("a stale refresh writer never adopts a concurrent workspace selection", async () => {
    const store = memoryStore(snapshot(3));
    const selectedWorkspace = {
      id: "workspace_selected",
      organizationId: "org_cloud",
      slug: "selected",
      name: "Selected",
      taskKeyPrefix: "SEL",
      roles: ["planner" as const],
    };
    const winner = snapshot(4, {
      ...authentication(
        "selected-access-token-that-is-long-enough",
        "selected-refresh-token-that-is-long-enough",
      ),
      workspace: selectedWorkspace,
    });
    const coordinator = new HumanSessionCoordinator({
      store,
      refresh: {
        refresh: () => {
          store.current = winner;
          return Promise.resolve({
            ok: true,
            data: refreshData(
              "loser-access-token-that-is-long-enough",
              "loser-refresh-token-that-is-long-enough",
            ),
          });
        },
      },
    });
    const seenTokens: string[] = [];

    const result = await coordinator.execute<string, OperationFailure>(
      (accessToken) => {
        seenTokens.push(accessToken);
        return Promise.resolve({
          ok: false,
          error: { code: "AUTHENTICATION_FAILED" },
        });
      },
    );

    expect(result).toMatchObject({
      ok: false,
      kind: "session",
      error: { code: "AUTHENTICATION_FAILED" },
    });
    expect(seenTokens).toEqual(["access-token-that-is-long-enough"]);
    expect(store.current).toEqual(winner);
    expect(store.current?.authentication.workspace).toEqual(selectedWorkspace);
    expect(store.clearCalls).toBe(0);
  });

  test("an indeterminate rotation preserves only the attempted generation for recovery", async () => {
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
    expect(store.preserveCalls).toBe(1);
    expect(store.clearCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain(
      "refresh-token-that-is-long-enough",
    );
    expect(await coordinator.execute(() =>
      Promise.resolve({ ok: true, data: "must stay closed" }))).toMatchObject({
      ok: false,
      kind: "session",
      error: { code: "SERVICE_UNAVAILABLE" },
    });
  });

  test("a failed recovery preservation permanently closes bearer admission", async () => {
    const store = memoryStore(snapshot(5));
    store.preserveForRecovery = function () {
      this.preserveCalls += 1;
      return Promise.reject(new Error("durable quarantine unavailable"));
    };
    const coordinator = new HumanSessionCoordinator({
      store,
      refresh: {
        refresh: () => Promise.reject(new Error("lost refresh response")),
      },
    });

    expect(await coordinator.execute<string, OperationFailure>(() =>
      Promise.resolve({
        ok: false,
        error: { code: "AUTHENTICATION_FAILED" },
      }))).toMatchObject({
      ok: false,
      kind: "session",
      error: { code: "AUTH_REFRESH_INDETERMINATE" },
    });
    expect(store.current?.generation).toBe(5);
    expect(store.preserveCalls).toBe(1);
    expect(await coordinator.execute(() =>
      Promise.resolve({ ok: true, data: "must stay closed" }))).toMatchObject({
      ok: false,
      kind: "session",
      error: { code: "SERVICE_UNAVAILABLE" },
    });
  });

  test("an old indeterminate refresh does not close admission for a newer selected scope", async () => {
    const stale = snapshot(5);
    const selectedWorkspace = {
      id: "workspace_selected",
      organizationId: "org_cloud",
      slug: "selected",
      name: "Selected",
      taskKeyPrefix: "SEL",
      roles: ["planner" as const],
    };
    const winner = snapshot(6, {
      ...authentication(
        "selected-access-token-that-is-long-enough",
        "selected-refresh-token-that-is-long-enough",
      ),
      workspace: selectedWorkspace,
    });
    const store = memoryStore(stale);
    const coordinator = new HumanSessionCoordinator({
      store,
      refresh: {
        refresh: () => {
          store.current = winner;
          return Promise.reject(new Error("old refresh response was lost"));
        },
      },
    });

    expect(await coordinator.execute<string, OperationFailure>(() =>
      Promise.resolve({
        ok: false,
        error: { code: "AUTHENTICATION_FAILED" },
      }))).toMatchObject({
      ok: false,
      kind: "session",
      error: { code: "AUTH_REFRESH_INDETERMINATE" },
    });
    expect(store.current).toEqual(winner);
    expect(store.preserveCalls).toBe(1);

    const seen: string[] = [];
    expect(await coordinator.execute<string, OperationFailure>((accessToken) => {
      seen.push(accessToken);
      return Promise.resolve({ ok: true, data: "selected" });
    })).toEqual({ ok: true, data: "selected" });
    expect(seen).toEqual(["selected-access-token-that-is-long-enough"]);
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
            data: refreshData(
              "second-rotated-access-token",
              "second-rotated-refresh-token",
              {
                ...authentication(),
                user: { id: "user_second", email: "second@example.com" },
              },
            ),
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
      data: refreshData(
        "first-rotated-access-token",
        "first-rotated-refresh-token",
      ),
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
            data: refreshData("rotated-access-token", "rotated-refresh-token"),
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

  test("closes admission when a definitive authentication clear returns false", async () => {
    const store = memoryStore(snapshot(4));
    store.clear = function () {
      this.clearCalls += 1;
      return Promise.resolve(false);
    };
    const coordinator = new HumanSessionCoordinator({
      store,
      refresh: {
        refresh: () => Promise.resolve({
          ok: false,
          outcome: "authentication_failed",
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
    expect(store.current?.generation).toBe(4);
    expect(await coordinator.execute(() =>
      Promise.resolve({ ok: true, data: "must stay closed" }))).toMatchObject({
      ok: false,
      kind: "session",
      error: { code: "SERVICE_UNAVAILABLE" },
    });
  });

  test("closes admission when a definitive authentication clear throws", async () => {
    const store = memoryStore(snapshot(4));
    store.clear = function () {
      this.clearCalls += 1;
      return Promise.reject(new Error("clear response was lost"));
    };
    const coordinator = new HumanSessionCoordinator({
      store,
      refresh: {
        refresh: () => Promise.resolve({
          ok: false,
          outcome: "authentication_failed",
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
    expect(store.current?.generation).toBe(4);
    expect(await coordinator.execute(() =>
      Promise.resolve({ ok: true, data: "must stay closed" }))).toMatchObject({
      ok: false,
      kind: "session",
      error: { code: "SERVICE_UNAVAILABLE" },
    });
  });

  test("a failed definitive clear leaves a newer selected generation admissible", async () => {
    const store = memoryStore(snapshot(4));
    const winner = snapshot(5, {
      ...authentication(
        "newer-selection-access-token-that-is-long-enough",
        "newer-selection-refresh-token-that-is-long-enough",
      ),
      workspace: {
        id: "workspace_newer_selection",
        organizationId: "org_cloud",
        slug: "newer-selection",
        name: "Newer selection",
        taskKeyPrefix: "NEW",
        roles: ["planner"],
      },
    });
    store.clear = function () {
      this.clearCalls += 1;
      this.current = winner;
      return Promise.resolve(false);
    };
    const coordinator = new HumanSessionCoordinator({
      store,
      refresh: {
        refresh: () => Promise.resolve({
          ok: false,
          outcome: "authentication_failed",
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
    const seen: string[] = [];
    expect(await coordinator.execute<string, OperationFailure>((accessToken) => {
      seen.push(accessToken);
      return Promise.resolve({ ok: true, data: "newer" });
    })).toEqual({ ok: true, data: "newer" });
    expect(seen).toEqual(["newer-selection-access-token-that-is-long-enough"]);
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
            data: refreshData("gap-rotated-access-token", "gap-rotated-refresh-token"),
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
