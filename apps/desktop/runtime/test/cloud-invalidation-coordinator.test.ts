import { describe, expect, test } from "bun:test";

import {
  CloudInvalidationCoordinator,
  type HRACloudSessionResult,
  type HRAInvalidationPage,
} from "../src/cloud";

const LOCATOR = "0123456789ABCDEFGHJKMNPQRS";
const WORKSPACE_ID = `wsp_${LOCATOR}`;

function page(
  afterProjectionHead: number,
  projectionHead: number,
): HRAInvalidationPage {
  return {
    workspaceId: WORKSPACE_ID,
    afterProjectionHead,
    projectionHead,
    invalidations: [{
      workspaceId: WORKSPACE_ID,
      projectionRevision: projectionHead,
      scope: "workspace",
    }],
    cursor: null,
    hasMore: false,
  };
}

function unavailable(): HRACloudSessionResult<HRAInvalidationPage> {
  return {
    ok: false,
    kind: "session",
    error: {
      code: "SERVICE_UNAVAILABLE",
      message: "temporarily unavailable",
    },
  };
}

describe("cloud invalidation coordinator", () => {
  test("reconnects with bounded backoff, advances the head, and cancels the active poll", async () => {
    const calls: number[] = [];
    const sleeps: number[] = [];
    const deliveries: number[] = [];
    let pollCount = 0;
    const client = {
      pollInvalidations: (
        _workspaceId: string,
        input: {
          readonly afterProjectionHead: number;
          readonly signal?: AbortSignal;
        },
      ): Promise<HRACloudSessionResult<HRAInvalidationPage>> => {
        calls.push(input.afterProjectionHead);
        pollCount += 1;
        if (pollCount === 1) return Promise.resolve(unavailable());
        if (pollCount === 2) {
          return Promise.resolve({
            ok: true,
            data: page(input.afterProjectionHead, 4),
          });
        }
        return new Promise((resolve) => {
          input.signal?.addEventListener(
            "abort",
            () => resolve(unavailable()),
            { once: true },
          );
        });
      },
    };
    let resolveDelivery = (): void => undefined;
    const delivered = new Promise<void>((resolve) => {
      resolveDelivery = resolve;
    });
    const coordinator = new CloudInvalidationCoordinator({
      client,
      isAccountGenerationCurrent: (generation) => generation === 7,
      onDelivery: (delivery) => {
        deliveries.push(delivery.projectionHead);
        resolveDelivery();
      },
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
      initialBackoffMs: 10,
      maximumBackoffMs: 40,
    });

    coordinator.start({
      accountGeneration: 7,
      workspaceId: WORKSPACE_ID,
      afterProjectionHead: 1,
    });
    await delivered;
    await coordinator.stop();

    expect(deliveries).toEqual([4]);
    expect(calls.slice(0, 3)).toEqual([1, 1, 4]);
    expect(sleeps).toEqual([10]);
  });

  test("suppresses a completed response after account generation replacement", async () => {
    let current = true;
    let resolvePoll = (
      result: HRACloudSessionResult<HRAInvalidationPage>,
    ): void => {
      void result;
      throw new Error("poll fixture was not initialized");
    };
    const poll = new Promise<HRACloudSessionResult<HRAInvalidationPage>>(
      (resolve) => {
        resolvePoll = resolve;
      },
    );
    const deliveries: HRAInvalidationPage[] = [];
    const stopped: string[] = [];
    const coordinator = new CloudInvalidationCoordinator({
      client: { pollInvalidations: () => poll },
      isAccountGenerationCurrent: () => current,
      onDelivery: (delivery) => {
        deliveries.push(page(
          delivery.previousProjectionHead,
          delivery.projectionHead,
        ));
      },
      onStopped: (reason) => stopped.push(reason),
    });

    coordinator.start({
      accountGeneration: 3,
      workspaceId: WORKSPACE_ID,
      afterProjectionHead: 2,
    });
    current = false;
    resolvePoll({ ok: true, data: page(2, 3) });
    await Promise.resolve();
    await Promise.resolve();

    expect(deliveries).toEqual([]);
    expect(stopped).toContain("generation_changed");
    await coordinator.stop();
  });

  test("stops rather than reconnecting after signed-out authentication", async () => {
    const stopped: string[] = [];
    let calls = 0;
    const coordinator = new CloudInvalidationCoordinator({
      client: {
        pollInvalidations: () => {
          calls += 1;
          return Promise.resolve({
            ok: false as const,
            kind: "session" as const,
            error: {
              code: "SIGNED_OUT" as const,
              message: "signed out",
            },
          });
        },
      },
      isAccountGenerationCurrent: () => true,
      onDelivery: () => undefined,
      onStopped: (reason) => stopped.push(reason),
    });

    coordinator.start({
      accountGeneration: 1,
      workspaceId: WORKSPACE_ID,
      afterProjectionHead: 0,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toBe(1);
    expect(stopped).toEqual(["authentication_failed"]);
    await coordinator.stop();
  });

  test("a replaced loop cannot emit a stale stopped event", async () => {
    const stopped: string[] = [];
    let calls = 0;
    const coordinator = new CloudInvalidationCoordinator({
      client: {
        pollInvalidations: (_workspaceId, input) => {
          calls += 1;
          return new Promise((resolve) => {
            input.signal?.addEventListener(
              "abort",
              () => resolve(unavailable()),
              { once: true },
            );
          });
        },
      },
      isAccountGenerationCurrent: () => true,
      onDelivery: () => undefined,
      onStopped: (reason) => stopped.push(reason),
    });
    const input = {
      accountGeneration: 1,
      workspaceId: WORKSPACE_ID,
      afterProjectionHead: 0,
    };

    coordinator.start(input);
    coordinator.start(input);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(2);
    expect(stopped).toEqual([]);

    await coordinator.stop();
    expect(stopped).toEqual(["cancelled"]);
  });

  test("publishes one active-generation fatal failure and remains restartable", async () => {
    const failure = new Error("poll transport crashed");
    const fatalFailures: Error[] = [];
    let calls = 0;
    const coordinator = new CloudInvalidationCoordinator({
      client: {
        pollInvalidations: (_workspaceId, input) => {
          calls += 1;
          if (calls === 1) return Promise.reject(failure);
          return new Promise((resolve) => {
            input.signal?.addEventListener(
              "abort",
              () => resolve(unavailable()),
              { once: true },
            );
          });
        },
      },
      isAccountGenerationCurrent: () => true,
      onDelivery: () => undefined,
      onFatalFailure: (error) => {
        fatalFailures.push(error);
        throw new Error("simulated recovery sink failure");
      },
    });
    const input = {
      accountGeneration: 1,
      workspaceId: WORKSPACE_ID,
      afterProjectionHead: 0,
    };

    coordinator.start(input);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(fatalFailures).toEqual([failure]);

    coordinator.start(input);
    expect(calls).toBe(2);
    await coordinator.stop();
    expect(fatalFailures).toEqual([failure]);
  });

  test("suppresses a late failure from a superseded generation", async () => {
    let rejectSuperseded = (error: Error): void => {
      throw error;
    };
    const superseded = new Promise<HRACloudSessionResult<HRAInvalidationPage>>(
      (_resolve, reject) => {
        rejectSuperseded = reject;
      },
    );
    const fatalFailures: Error[] = [];
    let calls = 0;
    const coordinator = new CloudInvalidationCoordinator({
      client: {
        pollInvalidations: (_workspaceId, input) => {
          calls += 1;
          if (calls === 1) return superseded;
          return new Promise((resolve) => {
            input.signal?.addEventListener(
              "abort",
              () => resolve(unavailable()),
              { once: true },
            );
          });
        },
      },
      isAccountGenerationCurrent: () => true,
      onDelivery: () => undefined,
      onFatalFailure: (error) => fatalFailures.push(error),
    });
    const input = {
      accountGeneration: 1,
      workspaceId: WORKSPACE_ID,
      afterProjectionHead: 0,
    };

    coordinator.start(input);
    coordinator.start(input);
    rejectSuperseded(new Error("superseded poll failed late"));
    await Promise.resolve();
    await Promise.resolve();
    expect(fatalFailures).toEqual([]);
    await coordinator.stop();
    expect(fatalFailures).toEqual([]);
  });

  test("supervises synchronous delivery failures without an unhandled rejection", async () => {
    const failure = new Error("projection delivery failed");
    const fatalFailures: Error[] = [];
    const coordinator = new CloudInvalidationCoordinator({
      client: {
        pollInvalidations: (_workspaceId, input) => Promise.resolve({
          ok: true,
          data: page(input.afterProjectionHead, 1),
        }),
      },
      isAccountGenerationCurrent: () => true,
      onDelivery: () => {
        throw failure;
      },
      onFatalFailure: (error) => fatalFailures.push(error),
    });

    coordinator.start({
      accountGeneration: 1,
      workspaceId: WORKSPACE_ID,
      afterProjectionHead: 0,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await coordinator.stop();
    expect(fatalFailures).toEqual([failure]);
  });
});
