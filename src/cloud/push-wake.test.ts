import { describe, expect, test } from "bun:test";

import {
  createCloudPushWake,
  pendingCommandFingerprint,
  pushWakeBackoffMs,
  pushWakeInitialBackoffMs,
  pushWakeMaximumBackoffMs,
  pushWakePendingLimit,
  pushWakeQuery,
  type CloudPushWakePort,
  type CloudPushWakeSubscriber,
} from "./push-wake";
import { cloudQueries } from "./client";

type ManualPushWake = Readonly<{
  closes: () => number;
  deliver: (value: unknown) => void;
  fail: (error: unknown) => void;
  subscriptions: () => number;
  transportError: (error: unknown) => void;
  wake: CloudPushWakePort;
}>;

function manualPushWake(now: () => number = Date.now): ManualPushWake {
  let handlers: Parameters<CloudPushWakeSubscriber>[0] | null = null;
  let subscriptions = 0;
  let closes = 0;
  const subscribe: CloudPushWakeSubscriber = (next) => {
    handlers = next;
    subscriptions += 1;
    return {
      close: async () => {
        closes += 1;
        handlers = null;
      },
    };
  };
  const wake = createCloudPushWake({ now, subscribe });
  return {
    closes: () => closes,
    deliver: (value: unknown) => { handlers?.onResult(value); },
    fail: (error: unknown) => { handlers?.onError(error); },
    subscriptions: () => subscriptions,
    transportError: (error: unknown) => { handlers?.onTransportError(error); },
    wake,
  };
}

function pending(...ids: readonly string[]): readonly unknown[] {
  return ids.map((publicId) => ({
    kind: "send",
    payload: { ciphertext: "opaque" },
    publicId,
    sessionPublicId: "session_12345678",
    state: "pending",
    updatedAt: 1_000 + publicId.length,
  }));
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("cloud push wake", () => {
  test("subscribes only to an allowlisted cloud query with a small limit", () => {
    expect([...cloudQueries]).toContain(pushWakeQuery);
    expect(pushWakeQuery).toBe("commands:listPendingForTarget");
    expect(pushWakePendingLimit).toBeLessThanOrEqual(16);
  });

  test("fingerprints the server-visible identity of pending commands only", () => {
    const before = pendingCommandFingerprint(pending("cmd_1"));
    const same = pendingCommandFingerprint(pending("cmd_1"));
    const added = pendingCommandFingerprint(pending("cmd_1", "cmd_2"));
    expect(before).toBe(same);
    expect(added).not.toBe(before);
    // Ciphertext never participates: two rows differing only in payload agree.
    expect(pendingCommandFingerprint([{
      payload: { ciphertext: "a" },
      publicId: "cmd_1",
      state: "pending",
      updatedAt: 1_000,
    }])).toBe(pendingCommandFingerprint([{
      payload: { ciphertext: "b" },
      publicId: "cmd_1",
      state: "pending",
      updatedAt: 1_000,
    }]));
    // Order from the server is not authoritative.
    expect(pendingCommandFingerprint(pending("cmd_2", "cmd_1")))
      .toBe(pendingCommandFingerprint(pending("cmd_1", "cmd_2")));
    expect(pendingCommandFingerprint("not a page")).toBe("invalid");
  });

  test("treats the first delivery as a baseline and later changes as wakes", async () => {
    const manual = manualPushWake();
    const controller = new AbortController();
    manual.deliver(pending());
    expect(manual.wake.status()).toMatchObject({ state: "listening", wakes: 0 });

    let woke = false;
    const waiting = manual.wake.wait(controller.signal).then(() => { woke = true; });
    await settle();
    expect(woke).toBe(false);

    manual.deliver(pending("cmd_1"));
    await waiting;
    expect(woke).toBe(true);
    expect(manual.wake.status().wakes).toBe(1);

    // An unchanged redelivery is not an edge.
    let second = false;
    const again = manual.wake.wait(controller.signal).then(() => { second = true; });
    manual.deliver(pending("cmd_1"));
    await settle();
    expect(second).toBe(false);
    controller.abort(new Error("test over"));
    await again;
    await manual.wake.close();
  });

  test("latches a change observed while nobody is waiting", async () => {
    const manual = manualPushWake();
    manual.deliver(pending());
    manual.deliver(pending("cmd_1"));
    // The wake arrived during a cycle; the next wait must not block on it.
    await manual.wake.wait(new AbortController().signal);
    let second = false;
    const controller = new AbortController();
    const waiting = manual.wake.wait(controller.signal).then(() => { second = true; });
    await settle();
    expect(second).toBe(false);
    controller.abort(new Error("test over"));
    await waiting;
    await manual.wake.close();
  });

  test("records one diagnostic per failure episode and reopens with backoff", async () => {
    const manual = manualPushWake();
    manual.deliver(pending());
    expect(manual.subscriptions()).toBe(1);

    manual.fail(new Error("subscription rejected"));
    expect(manual.wake.status()).toMatchObject({ consecutiveFailures: 1, state: "failed" });
    const first = manual.wake.takeDiagnostics();
    expect(first).toEqual(["push wake: subscription rejected"]);
    // A drained diagnostic is not repeated, and the retry itself stays silent.
    expect(manual.wake.takeDiagnostics()).toEqual([]);

    await Bun.sleep(pushWakeInitialBackoffMs + 250);
    expect(manual.subscriptions()).toBe(2);
    expect(manual.closes()).toBe(1);
    await manual.wake.close();
  }, 10_000);

  test("keeps the pre-outage fingerprint so a change during a failure still wakes", async () => {
    const manual = manualPushWake();
    manual.deliver(pending("cmd_1"));
    manual.fail(new Error("socket closed"));
    await Bun.sleep(pushWakeInitialBackoffMs + 250);
    const controller = new AbortController();
    let woke = false;
    const waiting = manual.wake.wait(controller.signal).then(() => { woke = true; });
    await settle();
    expect(woke).toBe(false);
    manual.deliver(pending("cmd_1", "cmd_2"));
    await waiting;
    expect(woke).toBe(true);
    await manual.wake.close();
  }, 10_000);

  test("reports a transport disconnect without tearing the subscription down", async () => {
    const manual = manualPushWake();
    manual.deliver(pending());
    manual.transportError(new Error("server disconnected"));
    manual.transportError(new Error("server disconnected"));
    expect(manual.wake.takeDiagnostics()).toEqual(["push wake: server disconnected"]);
    expect(manual.subscriptions()).toBe(1);
    expect(manual.wake.status().consecutiveFailures).toBe(0);
    await manual.wake.close();
  });

  test("redacts a diagnostic that carries token-shaped or path-shaped text", () => {
    const manual = manualPushWake();
    manual.deliver(pending());
    const token = `Bearer ${"A".repeat(40)}`;
    manual.fail(new Error(`refused with ${token}`));
    expect(manual.wake.takeDiagnostics())
      .toEqual(["push wake: Cloud push wake failed with a redacted diagnostic."]);
    void manual.wake.close();
  });

  test("doubles the backoff from one second and caps it at thirty", () => {
    expect(pushWakeBackoffMs(1)).toBe(1_000);
    expect(pushWakeBackoffMs(2)).toBe(2_000);
    expect(pushWakeBackoffMs(3)).toBe(4_000);
    expect(pushWakeBackoffMs(6)).toBe(pushWakeMaximumBackoffMs);
    expect(pushWakeBackoffMs(64)).toBe(pushWakeMaximumBackoffMs);
  });

  test("resolves every waiter on close and stops waking afterwards", async () => {
    const manual = manualPushWake();
    manual.deliver(pending());
    const controller = new AbortController();
    const waiting = manual.wake.wait(controller.signal);
    await manual.wake.close();
    await waiting;
    expect(manual.wake.status().state).toBe("closed");
    manual.deliver(pending("cmd_1"));
    expect(manual.wake.status().wakes).toBe(0);
    await manual.wake.wait(controller.signal);
  });
});
