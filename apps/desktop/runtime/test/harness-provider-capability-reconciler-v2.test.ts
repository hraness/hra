import { describe, expect, test } from "bun:test";

import { createSessionState, type SessionState } from "../src/sessions/model";
import type { SessionTurnLifecycle } from "../src/sessions/session-service";
import {
  HarnessProviderCapabilityReconcilerV2,
} from "../src/harness/provider-capability-reconciler-v2";

const terminal: SessionTurnLifecycle = Object.freeze({
  accountProfileId: "acct_a",
  threadId: "provider-thread-a",
  turnId: "provider-turn-a",
  status: "completed",
});

function fixture(input: Readonly<{
  active?: boolean;
  initiallyEnabled?: boolean;
  restartFails?: boolean;
  runtimeLaunchEnabled?: boolean;
}> = {}) {
  const calls: string[] = [];
  const running = new Set(["acct_a", "acct_b"]);
  const enabled = new Set<string>(input.initiallyEnabled === true
    ? ["acct_a", "acct_b"]
    : []);
  const runtimeLaunchEnabled = input.runtimeLaunchEnabled ?? true;
  let active = input.active ?? false;
  let releaseChat: (() => void) | null = null;
  let chat = Promise.resolve();
  const reconciler = new HarnessProviderCapabilityReconcilerV2({
    initialEnabled: false,
    runtimes: {
      configuredAccountProfileIds: () => ["acct_b", "acct_a"],
      generation: (accountProfileId) => running.has(accountProfileId) ? 1 : null,
      isRunning: (accountProfileId) => running.has(accountProfileId),
      supportsDynamicTool: (accountProfileId) => enabled.has(accountProfileId),
      restart: (accountProfileId) => {
        calls.push(`restart:${accountProfileId}`);
        if (input.restartFails === true && accountProfileId === "acct_a") {
          return Promise.reject(new Error("private restart detail"));
        }
        if (runtimeLaunchEnabled) enabled.add(accountProfileId);
        else enabled.delete(accountProfileId);
        return Promise.resolve({ generation: 2 });
      },
      stop: (accountProfileId) => {
        calls.push(`stop:${accountProfileId}`);
        running.delete(accountProfileId);
        enabled.delete(accountProfileId);
        return Promise.resolve();
      },
    },
    sessions: {
      getSnapshot: () => active
        ? activeSessionState("acct_a")
        : createSessionState(),
    },
    settleChat: () => chat,
  });
  return {
    calls,
    enabled,
    reconciler,
    setActive(value: boolean) {
      active = value;
    },
    holdChat() {
      chat = new Promise<void>((resolve) => {
        releaseChat = resolve;
      });
    },
    releaseChat() {
      releaseChat?.();
    },
  };
}

describe("HarnessProviderCapabilityReconcilerV2", () => {
  test("converges every idle running account to the enabled capability", async () => {
    const value = fixture();
    await value.reconciler.settingsChanged(true);
    expect(value.calls).toEqual(["restart:acct_a", "restart:acct_b"]);
    expect([...value.enabled].toSorted()).toEqual(["acct_a", "acct_b"]);

    await value.reconciler.settingsChanged(true);
    expect(value.calls).toHaveLength(2);
  });

  test("converges booted processes to a disabled durable setting", async () => {
    const value = fixture({
      initiallyEnabled: true,
      runtimeLaunchEnabled: false,
    });
    await value.reconciler.settingsChanged(false);
    expect(value.calls).toEqual(["restart:acct_a", "restart:acct_b"]);
    expect([...value.enabled]).toEqual([]);

    await value.reconciler.settingsChanged(false);
    expect(value.calls).toHaveLength(2);
  });

  test("defers active accounts until Chat drains their terminal fact", async () => {
    const value = fixture({ active: true });
    await value.reconciler.settingsChanged(true);
    expect(value.calls).toEqual(["restart:acct_b"]);

    value.holdChat();
    value.setActive(false);
    value.reconciler.observe(terminal);
    await Promise.resolve();
    expect(value.calls).toEqual(["restart:acct_b"]);
    value.releaseChat();
    await value.reconciler.settled();
    expect(value.calls).toEqual(["restart:acct_b", "restart:acct_a"]);
  });

  test("stops a generation whose replacement cannot prove the target capability", async () => {
    const value = fixture({ restartFails: true });
    await value.reconciler.settingsChanged(true);
    expect(value.calls).toEqual([
      "restart:acct_a",
      "stop:acct_a",
      "restart:acct_b",
    ]);
    value.reconciler.close();
    value.reconciler.observe(terminal);
    expect(await rejected(value.reconciler.settingsChanged(false)))
      .toMatchObject({ code: "closed" });
  });
});

function activeSessionState(accountProfileId: string): SessionState {
  return {
    ...createSessionState(),
    revision: 1,
    threads: {
      thread_a: {
        accountProfileId,
        archived: false,
        createdAt: "2031-01-01T00:00:00.000Z",
        cwd: "/tmp/project",
        id: "thread_a",
        status: "active",
        title: null,
        turnKeys: [],
        updatedAt: "2031-01-01T00:00:00.000Z",
      },
    },
  };
}

async function rejected(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected operation to reject");
}
