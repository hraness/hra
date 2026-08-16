import { describe, expect, test } from "bun:test";

import type { ChatPaneProjection } from "../../contracts/runtime";

import {
  HarnessBootAwareRootProjectionV2,
  HarnessBootAwareRootProjectionV2Error,
} from "../src/harness/boot-aware-root-projection-v2";

const actorId = "hactor_boot_projection_01";
const otherActorId = "hactor_boot_projection_02";
const paneId = "pane_boot_projection_01";

function witness(id = actorId) {
  return {
    actorId: id,
    revision: 1,
    semanticDigest: "a".repeat(64),
  };
}

function fixture(input: Readonly<{
  failAt?: "bind" | "chat" | "create" | "projection";
  synchronized?: () => Promise<unknown>;
  refreshed?: () => Promise<unknown>;
}> = {}) {
  const calls: string[] = [];
  const panes: readonly ChatPaneProjection[] = [];
  const liveness = {
    requestReconciliation: () => undefined,
    observe: () => undefined,
    ensureCurrent: () => Promise.resolve(),
    settled: () => Promise.resolve(),
    close: () => {
      calls.push("liveness.close");
      return Promise.resolve();
    },
  };
  const adapter = new HarnessBootAwareRootProjectionV2({
    authority: {
      synchronizeProjectionWitness: async () => {
        calls.push("witness");
        return input.synchronized === undefined
          ? witness()
          : await input.synchronized();
      },
    },
    reconciler: {
      reconcileActor: async () => {
        calls.push("refresh");
        return input.refreshed === undefined
          ? witness()
          : await input.refreshed();
      },
    },
    chat: {
      initialize: () => {
        calls.push("chat");
        if (input.failAt === "chat") throw new Error("chat failed");
        return panes;
      },
    },
    projection: {
      installBootstrapChatState: (installed) => {
        calls.push("projection");
        expect(installed).toBe(panes);
        if (input.failAt === "projection") {
          throw new Error("projection failed");
        }
        return "installed";
      },
    },
    createLiveness: () => {
      calls.push("liveness.create");
      if (input.failAt === "create") throw new Error("create failed");
      return liveness;
    },
    liveness: {
      bind: (target) => {
        calls.push("liveness.bind");
        expect(target).toBe(liveness);
        if (input.failAt === "bind") throw new Error("bind failed");
        return "bound";
      },
    },
  });
  return { adapter, calls, panes };
}

describe("HarnessBootAwareRootProjectionV2", () => {
  test("converges witnesses before chat bootstrap and refreshes afterward", async () => {
    const value = fixture();

    await value.adapter.reconcile({ actorId, paneId });
    expect(value.adapter.ready).toBe(false);
    expect(value.calls).toEqual(["witness"]);
    expect(await value.adapter.recoverInterruptedAfterRootRecovery())
      .toBe(value.panes);
    expect(value.adapter.ready).toBe(false);
    await value.adapter.activateLiveness();
    expect(value.adapter.ready).toBe(true);
    await value.adapter.reconcile({ actorId, paneId });
    expect(value.calls).toEqual([
      "witness",
      "chat",
      "projection",
      "liveness.create",
      "liveness.bind",
      "refresh",
    ]);
  });

  test("installs panes before a separately authorized liveness activation", async () => {
    const value = fixture();

    const recovery = value.adapter.recoverInterruptedAfterRootRecovery();
    expect(value.calls).toEqual([
      "chat",
      "projection",
    ]);
    expect(value.adapter.ready).toBe(false);
    await value.adapter.activateLiveness();
    expect(value.calls).toEqual([
      "chat",
      "projection",
      "liveness.create",
      "liveness.bind",
    ]);
    expect(value.adapter.ready).toBe(true);
    expect(await recovery).toBe(value.panes);
  });

  test("closes an orphan pump when binding fails", async () => {
    const value = fixture({ failAt: "bind" });

    await value.adapter.recoverInterruptedAfterRootRecovery();
    expect(await rejected(value.adapter.activateLiveness()))
      .toMatchObject({ code: "recovery_failed" });
    expect(value.adapter.ready).toBe(false);
    expect(value.calls).toEqual([
      "chat",
      "projection",
      "liveness.create",
      "liveness.bind",
      "liveness.close",
    ]);
    expect(await rejected(value.adapter.reconcile({ actorId, paneId })))
      .toMatchObject({ code: "invalid_state" });
  });

  test("fails closed after chat recovery fails and rejects replay", async () => {
    const value = fixture({ failAt: "chat" });

    expect(await rejected(value.adapter.recoverInterruptedAfterRootRecovery()))
      .toMatchObject({
        code: "recovery_failed",
        cause: { message: "chat failed" },
      });
    expect(value.adapter.ready).toBe(false);
    expect(await rejected(value.adapter.reconcile({ actorId, paneId })))
      .toMatchObject({ code: "invalid_state" });
    expect(await rejected(value.adapter.recoverInterruptedAfterRootRecovery()))
      .toMatchObject({ code: "invalid_state" });
    expect(value.calls).toEqual(["chat"]);
  });

  test("rejects mismatched or malformed witnesses before renderer use", async () => {
    const mismatched = fixture({
      synchronized: () => Promise.resolve(witness(otherActorId)),
    });
    expect(await rejected(mismatched.adapter.reconcile({ actorId, paneId })))
      .toMatchObject({ code: "corrupt_state" });

    const malformed = fixture({
      synchronized: () => Promise.resolve({ actorId }),
    });
    expect(await rejected(malformed.adapter.reconcile({ actorId, paneId })))
      .toBeInstanceOf(HarnessBootAwareRootProjectionV2Error);
  });

  test("permits chat bootstrap exactly once", async () => {
    const value = fixture();
    await value.adapter.recoverInterruptedAfterRootRecovery();
    expect(await rejected(value.adapter.recoverInterruptedAfterRootRecovery()))
      .toMatchObject({ code: "invalid_state" });
  });

  test("permits liveness activation exactly once and only after chat", async () => {
    const value = fixture();
    expect(await rejected(value.adapter.activateLiveness()))
      .toMatchObject({ code: "invalid_state" });
    await value.adapter.recoverInterruptedAfterRootRecovery();
    await value.adapter.activateLiveness();
    expect(await rejected(value.adapter.activateLiveness()))
      .toMatchObject({ code: "invalid_state" });
  });
});

async function rejected<Value>(promise: Promise<Value>): Promise<unknown> {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (cause: unknown) {
    return cause;
  }
}
