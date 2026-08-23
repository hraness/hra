import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import type { CommandResponse } from "../domain/contracts";
import { initializeStatePaths, resolveStatePaths } from "../storage/paths";
import { DAEMON_PROTOCOL, DaemonLock } from "./daemon-lock";
import {
  daemonStatusIdentity,
  identityFromReceipt,
  waitForDaemonAuthorityRelease,
  waitForDaemonReady,
  type DaemonIdentity,
} from "./daemon-startup";

async function pathsFixture() {
  const home = await mkdtemp(join("/private/tmp", "hra-startup-"));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  return paths;
}

function status(identity: DaemonIdentity): CommandResponse {
  return {
    ok: true,
    version: 1,
    requestId: crypto.randomUUID(),
    data: { running: true, pid: identity.pid, daemon: identity },
  };
}

describe("daemon startup receipts", () => {
  test("waits beyond the old five-second blind poll for a verified ready identity", async () => {
    const paths = await pathsFixture();
    const lock = await DaemonLock.acquire(paths, { pid: 42, now: 0 });
    const bootId = "boot_11111111111111111111111111111111";
    await lock.publish({ state: "booting", generation: 7, bootId, now: 0 });
    let now = 0;
    let published = false;
    const expected = identityFromReceipt({ ...lock.receipt, state: "ready" });
    if (expected === null) throw new Error("fixture identity missing");
    try {
      expect(await waitForDaemonReady({
        paths,
        deadlineMs: 10_000,
        pollMs: 1_000,
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
          if (now >= 6_000 && !published) {
            published = true;
            await lock.publish({ state: "ready", generation: 7, bootId, now });
          }
        },
        queryStatus: async () => status(expected),
      })).toEqual(expected);
      expect(now).toBe(6_000);
    } finally {
      await lock.release();
    }
  });

  test("surfaces a bounded child boot failure from the durable receipt", async () => {
    const paths = await pathsFixture();
    const lock = await DaemonLock.acquire(paths, { pid: 43, now: 0 });
    await lock.publish({ state: "failed", failure: "schema is newer", now: 1 });
    await lock.release({ state: "failed", failure: "schema is newer", now: 2 });
    await expect(waitForDaemonReady({
      paths,
      deadlineMs: 100,
      now: () => 2,
      sleep: async () => undefined,
      observeChild: () => ({ pid: 43, exited: true, exitCode: 1 }),
      queryStatus: async () => { throw new Error("must not query failed daemon"); },
    })).rejects.toThrow("schema is newer");
  });

  test("does not mistake a stale failed receipt for the newly spawned boot", async () => {
    const paths = await pathsFixture();
    const stale = await DaemonLock.acquire(paths, { pid: 47, now: 0 });
    await stale.release({ state: "failed", failure: "old failure", now: 1 });
    let now = 1;
    let current: DaemonLock | undefined;
    const expected: DaemonIdentity = {
      protocol: DAEMON_PROTOCOL,
      pid: 48,
      nonce: "00000000-0000-4000-8000-000000000048",
      generation: 12,
      bootId: "boot_55555555555555555555555555555555",
    };
    try {
      expect(await waitForDaemonReady({
        paths,
        deadlineMs: 100,
        pollMs: 1,
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
          if (current === undefined) {
            current = await DaemonLock.acquire(paths, { pid: expected.pid, nonce: expected.nonce, now });
            await current.publish({ state: "ready", generation: expected.generation, bootId: expected.bootId, now });
          }
        },
        observeChild: () => ({ pid: expected.pid, exited: false }),
        queryStatus: async () => status(expected),
      })).toEqual(expected);
    } finally {
      await current?.release();
    }
  });

  test("validates protocol, process, generation, boot, and nonce from status", () => {
    const identity: DaemonIdentity = {
      protocol: DAEMON_PROTOCOL,
      pid: 44,
      nonce: "00000000-0000-4000-8000-000000000044",
      generation: 9,
      bootId: "boot_22222222222222222222222222222222",
    };
    expect(daemonStatusIdentity(status(identity))).toEqual(identity);
    expect(() => daemonStatusIdentity({
      ok: true,
      version: 1,
      requestId: crypto.randomUUID(),
      data: { running: true, daemon: { ...identity, protocol: "unknown" } },
    })).toThrow();
  });

  test("stop observation proves exact old authority release without confusing a replacement", async () => {
    const paths = await pathsFixture();
    const old = await DaemonLock.acquire(paths, { pid: 45, now: 0 });
    const oldBootId = "boot_33333333333333333333333333333333";
    await old.publish({ state: "ready", generation: 10, bootId: oldBootId, now: 1 });
    const expected = identityFromReceipt(old.receipt);
    if (expected === null) throw new Error("fixture identity missing");
    let now = 1;
    let replacement: DaemonLock | undefined;
    const released = await waitForDaemonAuthorityRelease({
      paths,
      expected,
      deadlineMs: 100,
      pollMs: 1,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
        await old.release({ now });
        replacement = await DaemonLock.acquire(paths, { pid: 46, now });
        await replacement.publish({
          state: "ready",
          generation: 11,
          bootId: "boot_44444444444444444444444444444444",
          now,
        });
      },
    });
    expect(released.replacement).toMatchObject({ pid: 46, generation: 11 });
    await replacement?.release();
  });

  test("stop observation preserves a forced recovery receipt after authority releases", async () => {
    const paths = await pathsFixture();
    const lock = await DaemonLock.acquire(paths, { pid: 49, now: 0 });
    await lock.publish({
      state: "ready",
      generation: 13,
      bootId: "boot_66666666666666666666666666666666",
      now: 1,
    });
    const expected = identityFromReceipt(lock.receipt);
    if (expected === null) throw new Error("fixture identity missing");
    await lock.release({ state: "failed", failure: "Forced recovery boundary: transport did not settle.", now: 2 });
    expect(await waitForDaemonAuthorityRelease({ paths, expected })).toMatchObject({
      replacement: null,
      finalReceipt: {
        nonce: expected.nonce,
        state: "failed",
        failure: "Forced recovery boundary: transport did not settle.",
      },
    });
  });
});
