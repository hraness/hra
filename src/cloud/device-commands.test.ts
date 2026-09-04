import { describe, expect, test } from "bun:test";

import type { AuthorityTuple } from "./contracts";
import {
  compareDeviceAuthority,
  deviceCommandAuthorityTransitionDisposition,
  deviceCommandRecoveryAdmitted,
  sameDeviceAuthority,
} from "./device-commands";

const authority = (
  bootGeneration: number,
  fence: number,
  bootId = "boot_00000000",
): AuthorityTuple => ({ bootGeneration, bootId, fence });

describe("device command authority", () => {
  test("orders by boot generation, then fence, and treats an equal tuple as equal", () => {
    expect(compareDeviceAuthority(authority(1, 1), authority(2, 1))).toBe("before");
    expect(compareDeviceAuthority(authority(2, 1), authority(1, 9))).toBe("after");
    expect(compareDeviceAuthority(authority(2, 1), authority(2, 2))).toBe("before");
    expect(compareDeviceAuthority(authority(2, 2), authority(2, 2))).toBe("equal");
    expect(sameDeviceAuthority(authority(2, 2), authority(2, 2))).toBe(true);
    expect(sameDeviceAuthority(authority(2, 2), authority(2, 2, "boot_00000001"))).toBe(false);
  });

  test("a fresh boot of the same generation is later, so a restart never deadlocks", () => {
    expect(compareDeviceAuthority(
      authority(3, 1, "boot_00000001"),
      authority(3, 1, "boot_00000000"),
    )).toBe("after");
  });

  test("claims a pending command and replays its own prepare", () => {
    const claimed = deviceCommandAuthorityTransitionDisposition({
      boundAuthority: null,
      next: "prepared",
      requestedAuthority: authority(1, 1),
      state: "pending",
    });
    expect(claimed).toEqual({
      boundAuthority: authority(1, 1),
      kind: "applied",
      state: "prepared",
    });
    expect(deviceCommandAuthorityTransitionDisposition({
      boundAuthority: authority(1, 1),
      next: "prepared",
      requestedAuthority: authority(1, 1),
      state: "prepared",
    })).toEqual({ boundAuthority: authority(1, 1), kind: "replay", state: "prepared" });
  });

  test("rebinds a prepared command to a strictly later authority and refuses an earlier one", () => {
    expect(deviceCommandAuthorityTransitionDisposition({
      boundAuthority: authority(1, 1),
      next: "prepared",
      requestedAuthority: authority(2, 1),
      state: "prepared",
    })).toEqual({ boundAuthority: authority(2, 1), kind: "rebound", state: "prepared" });
    expect(deviceCommandAuthorityTransitionDisposition({
      boundAuthority: authority(2, 1),
      next: "prepared",
      requestedAuthority: authority(1, 1),
      state: "prepared",
    })).toMatchObject({ kind: "rejected", reason: "stale_authority", state: "prepared" });
  });

  test("every post-prepare transition demands the exact bound authority", () => {
    expect(deviceCommandAuthorityTransitionDisposition({
      boundAuthority: authority(1, 1),
      next: "effect_started",
      requestedAuthority: authority(2, 1),
      state: "prepared",
    })).toMatchObject({ kind: "rejected", reason: "bound_authority" });
    expect(deviceCommandAuthorityTransitionDisposition({
      boundAuthority: null,
      next: "applied",
      requestedAuthority: authority(1, 1),
      state: "effect_started",
    })).toMatchObject({ kind: "rejected", reason: "bound_authority" });
    expect(deviceCommandAuthorityTransitionDisposition({
      boundAuthority: authority(1, 1),
      next: "applied",
      requestedAuthority: authority(1, 1),
      state: "effect_started",
    })).toEqual({ boundAuthority: authority(1, 1), kind: "applied", state: "applied" });
  });

  test("refuses a transition the closed state machine does not allow", () => {
    expect(deviceCommandAuthorityTransitionDisposition({
      boundAuthority: authority(1, 1),
      next: "applied",
      requestedAuthority: authority(1, 1),
      state: "pending",
    })).toMatchObject({ kind: "rejected", reason: "invalid_transition" });
  });

  test("recovery closes an effect that may have begun as ambiguous only", () => {
    // The load-bearing case: a start that may or may not have happened.
    expect(deviceCommandRecoveryAdmitted({
      recoveryAuthority: authority(2, 1),
      staleAuthority: authority(1, 1),
      state: "effect_started",
      terminalState: "ambiguous",
    })).toBe(true);
    expect(deviceCommandRecoveryAdmitted({
      recoveryAuthority: authority(2, 1),
      staleAuthority: authority(1, 1),
      state: "effect_started",
      terminalState: "applied",
    })).toBe(false);
    expect(deviceCommandRecoveryAdmitted({
      recoveryAuthority: authority(2, 1),
      staleAuthority: authority(1, 1),
      state: "effect_started",
      terminalState: "failed",
    })).toBe(false);
  });

  test("recovery from prepared may fail honestly, but never claim success", () => {
    expect(deviceCommandRecoveryAdmitted({
      recoveryAuthority: authority(2, 1),
      staleAuthority: authority(1, 1),
      state: "prepared",
      terminalState: "failed",
    })).toBe(true);
    expect(deviceCommandRecoveryAdmitted({
      recoveryAuthority: authority(2, 1),
      staleAuthority: authority(1, 1),
      state: "prepared",
      terminalState: "applied",
    })).toBe(false);
  });

  test("recovery refuses an authority that is not strictly later, or a terminal state", () => {
    expect(deviceCommandRecoveryAdmitted({
      recoveryAuthority: authority(1, 1),
      staleAuthority: authority(1, 1),
      state: "effect_started",
      terminalState: "ambiguous",
    })).toBe(false);
    expect(deviceCommandRecoveryAdmitted({
      recoveryAuthority: authority(2, 1),
      staleAuthority: authority(1, 1),
      state: "applied",
      terminalState: "ambiguous",
    })).toBe(false);
  });
});
