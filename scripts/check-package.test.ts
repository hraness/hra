import { describe, expect, test } from "bun:test";

import type { DaemonAuthorityReceipt } from "../src/daemon/daemon-lock";
import type { DaemonIdentity } from "../src/daemon/daemon-startup";
import { waitForOwnedInstalledDaemonReady } from "./check-package";

const identity = (pid: number): DaemonIdentity => ({
  bootId: `boot_${"a".repeat(32)}`,
  generation: 1,
  nonce: "10000000-0000-4000-8000-000000000001",
  pid,
  protocol: "hra-control-plane-local-v1",
});

const receipt = (pid: number): DaemonAuthorityReceipt => ({
  acquiredAt: 0,
  bootId: `boot_${"a".repeat(32)}`,
  generation: 1,
  nonce: "10000000-0000-4000-8000-000000000001",
  pid,
  protocol: "hra-control-plane-local-v1",
  state: "ready",
  updatedAt: 0,
  version: 2,
});

describe("installed package daemon ownership", () => {
  test("times out delayed receipt publication without losing the exact owned pid", async () => {
    const pid = 42_424;
    let now = 0;
    let statusCalls = 0;
    const error = await waitForOwnedInstalledDaemonReady({
      daemon: { exitObservation: () => null, pid },
      deadlineMs: 100,
      now: () => now,
      pollMs: 20,
      queryStatus: async () => {
        statusCalls += 1;
        return identity(pid);
      },
      readReceipt: async () => now >= 120 ? receipt(pid) : null,
      sleep: async (milliseconds) => { now += milliseconds; },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(`pid ${String(pid)}`);
    expect(String(error)).toContain("did not become ready before the deadline");
    expect(statusCalls).toBe(0);
  });

  test("refuses a live receipt published by a process the harness does not own", async () => {
    const ownedPid = 42_425;
    await expect(waitForOwnedInstalledDaemonReady({
      daemon: { exitObservation: () => null, pid: ownedPid },
      queryStatus: async () => identity(ownedPid + 1),
      readReceipt: async () => receipt(ownedPid + 1),
    })).rejects.toThrow(`unexpected pid ${String(ownedPid + 1)} instead of owned pid ${String(ownedPid)}`);
  });
});
