import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  acquireLeaseDisposition,
  heartbeatDisposition,
  type LeaseSnapshot,
} from "./leases";

const initial: LeaseSnapshot = {
  bootGeneration: 1,
  bootId: "boot_12345678",
  devicePublicId: "device_12345678",
  fence: 1,
  heartbeatFingerprint: "a".repeat(64),
  heartbeatSequence: 1,
  leaseUntil: 20_000,
};

const invalidLeaseDurations: readonly number[] = [
  Number.NEGATIVE_INFINITY,
  Number.MIN_SAFE_INTEGER,
  -1,
  0,
  4_999,
  5_000.5,
  120_000.5,
  120_001,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1,
  Number.POSITIVE_INFINITY,
  Number.NaN,
];

describe("execution lease laws", () => {
  test("invalid acquire and heartbeat durations have a truthful fail-closed status", () => {
    for (const leaseDurationMs of invalidLeaseDurations) {
      expect(acquireLeaseDisposition(initial, {
        bootGeneration: initial.bootGeneration,
        bootId: initial.bootId,
        devicePublicId: initial.devicePublicId,
        leaseDurationMs,
        now: 15_000,
      })).toEqual({ kind: "rejected", reason: "invalid_duration" });
      expect(heartbeatDisposition(initial, {
        authority: {
          bootGeneration: initial.bootGeneration,
          bootId: initial.bootId,
          fence: initial.fence,
        },
        fingerprint: "b".repeat(64),
        leaseDurationMs,
        now: 15_000,
        sequence: initial.heartbeatSequence + 1,
      })).toEqual({ kind: "rejected", reason: "invalid_duration" });
    }
  });

  test("lease duration boundaries remain valid", () => {
    for (const leaseDurationMs of [5_000, 120_000]) {
      expect(acquireLeaseDisposition(null, {
        bootGeneration: initial.bootGeneration,
        bootId: initial.bootId,
        devicePublicId: initial.devicePublicId,
        leaseDurationMs,
        now: 15_000,
      }).kind).toBe("acquired");
      expect(heartbeatDisposition(initial, {
        authority: {
          bootGeneration: initial.bootGeneration,
          bootId: initial.bootId,
          fence: initial.fence,
        },
        fingerprint: "b".repeat(64),
        leaseDurationMs,
        now: 15_000,
        sequence: initial.heartbeatSequence + 1,
      }).kind).toBe("advanced");
    }
  });

  test("heartbeat rejects stale or expired authority before invalid duration", () => {
    const staleAuthorities = [
      { bootGeneration: 2, bootId: initial.bootId, fence: initial.fence },
      { bootGeneration: 1, bootId: "boot_stale_0001", fence: initial.fence },
      { bootGeneration: 1, bootId: initial.bootId, fence: initial.fence + 1 },
    ] as const;
    for (const authority of staleAuthorities) {
      expect(heartbeatDisposition(initial, {
        authority,
        fingerprint: "b".repeat(64),
        leaseDurationMs: 0,
        now: 15_000,
        sequence: initial.heartbeatSequence + 1,
      })).toEqual({ kind: "rejected", reason: "authority" });
    }
    expect(heartbeatDisposition(initial, {
      authority: {
        bootGeneration: initial.bootGeneration,
        bootId: initial.bootId,
        fence: initial.fence,
      },
      fingerprint: "b".repeat(64),
      leaseDurationMs: 0,
      now: initial.leaseUntil,
      sequence: initial.heartbeatSequence + 1,
    })).toEqual({ kind: "rejected", reason: "authority" });
    expect(heartbeatDisposition(initial, {
      authority: {
        bootGeneration: initial.bootGeneration,
        bootId: initial.bootId,
        fence: initial.fence,
      },
      fingerprint: "b".repeat(64),
      leaseDurationMs: 0,
      now: initial.leaseUntil - 1,
      sequence: initial.heartbeatSequence + 1,
    })).toEqual({ kind: "rejected", reason: "invalid_duration" });
  });

  test("takeover happens only at expiry under a strictly newer daemon generation", () => {
    const base = {
      bootGeneration: 2,
      bootId: "boot_87654321",
      devicePublicId: initial.devicePublicId,
      leaseDurationMs: 10_000,
    } as const;
    expect(acquireLeaseDisposition(initial, { ...base, now: 19_999 }).kind).toBe("rejected");
    const acquired = acquireLeaseDisposition(initial, { ...base, now: 20_000 });
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind === "acquired") expect(acquired.lease.fence).toBe(2);
    expect(acquireLeaseDisposition(initial, {
      ...base,
      bootGeneration: 3,
      now: 20_000,
    }).kind).toBe("acquired");
    expect(acquireLeaseDisposition(initial, {
      ...base,
      bootGeneration: 1,
      now: 20_000,
    }).kind).toBe("rejected");
  });

  test("heartbeat replay is stable and never extends the deadline", () => {
    const replay = heartbeatDisposition(initial, {
      authority: { bootGeneration: 1, bootId: initial.bootId, fence: 1 },
      fingerprint: initial.heartbeatFingerprint,
      leaseDurationMs: 10_000,
      now: 15_000,
      sequence: 1,
    });
    expect(replay).toEqual({ kind: "replay", lease: initial });
    const acquireReplay = acquireLeaseDisposition(initial, {
      bootGeneration: initial.bootGeneration,
      bootId: initial.bootId,
      devicePublicId: initial.devicePublicId,
      leaseDurationMs: 10_000,
      now: 15_000,
    });
    expect(acquireReplay.kind).toBe("renewed");
    if (acquireReplay.kind === "renewed") {
      expect(acquireReplay.lease.leaseUntil).toBe(initial.leaseUntil);
    }
  });

  test("expired leases accept exactly strictly newer positive daemon generations", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 10_000 }), (generation) => {
      const result = acquireLeaseDisposition(initial, {
        bootGeneration: generation,
        bootId: "boot_property1",
        devicePublicId: initial.devicePublicId,
        leaseDurationMs: 10_000,
        now: initial.leaseUntil,
      });
      expect(result.kind).toBe(generation > initial.bootGeneration ? "acquired" : "rejected");
    }));
  });

  test("an expired lease reacquired by the same daemon always advances its fence", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 10_000 }),
      fc.integer({ min: 0, max: 60_000 }),
      (fence, elapsed) => {
        const existing = { ...initial, fence };
        const result = acquireLeaseDisposition(existing, {
          bootGeneration: existing.bootGeneration,
          bootId: existing.bootId,
          devicePublicId: existing.devicePublicId,
          leaseDurationMs: 10_000,
          now: existing.leaseUntil + elapsed,
        });
        expect(result.kind).toBe("acquired");
        if (result.kind !== "acquired") return;
        expect(result.lease).toMatchObject({
          bootGeneration: existing.bootGeneration,
          bootId: existing.bootId,
          fence: fence + 1,
          heartbeatFingerprint: "initial",
          heartbeatSequence: 0,
        });
      },
    ));
  });

  test("sequence gaps, stale sequences, and changed replay payloads always fail", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 100 }), (delta) => {
      const sequence = initial.heartbeatSequence + delta;
      const result = heartbeatDisposition(initial, {
        authority: { bootGeneration: 1, bootId: initial.bootId, fence: 1 },
        fingerprint: delta === 0 ? "b".repeat(64) : "c".repeat(64),
        leaseDurationMs: 10_000,
        now: 15_000,
        sequence,
      });
      if (delta === 1) expect(result.kind).toBe("advanced");
      else expect(result.kind).toBe("rejected");
    }));
  });
});
