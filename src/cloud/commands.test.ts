import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  commandAuthorityTransitionDisposition,
  commandTransitionDisposition,
  idempotencyDisposition,
  schedulerExpiryDisposition,
} from "./commands";
import type { AuthorityTuple, CommandState } from "./contracts";

const states: readonly CommandState[] = [
  "pending",
  "prepared",
  "effect_started",
  "applied",
  "failed",
  "ambiguous",
  "cancelled",
  "expired",
];
const terminals: readonly CommandState[] = [
  "applied",
  "failed",
  "ambiguous",
  "cancelled",
  "expired",
];

const liveAuthority: AuthorityTuple = {
  bootGeneration: 3,
  bootId: "boot_live_0001",
  fence: 7,
};

function authorityTransition(
  overrides: Partial<Parameters<typeof commandAuthorityTransitionDisposition>[0]> = {},
) {
  return commandAuthorityTransitionDisposition({
    boundAuthority: liveAuthority,
    leaseUntil: 20_000,
    liveAuthority,
    next: "effect_started",
    now: 10_000,
    requestedAuthority: liveAuthority,
    state: "prepared",
    ...overrides,
  });
}

describe("remote command laws", () => {
  test("terminal states are absorbing", () => {
    fc.assert(fc.property(
      fc.constantFrom(...terminals),
      fc.constantFrom(...states),
      (current, next) => {
        const disposition = commandTransitionDisposition(current, next);
        expect(disposition.kind).toBe(current === next ? "replay" : "rejected");
      },
    ));
  });

  test("only the closed transition graph applies", () => {
    expect(commandTransitionDisposition("pending", "prepared").kind).toBe("applied");
    expect(commandTransitionDisposition("prepared", "effect_started").kind).toBe("applied");
    expect(commandTransitionDisposition("prepared", "expired").kind).toBe("applied");
    for (const terminal of ["applied", "failed", "ambiguous"] as const) {
      expect(commandTransitionDisposition("effect_started", terminal).kind).toBe("applied");
    }
    expect(commandTransitionDisposition("pending", "applied").kind).toBe("rejected");
    expect(commandTransitionDisposition("prepared", "applied").kind).toBe("rejected");
  });

  test("same idempotency digest replays and changed digest conflicts", () => {
    expect(idempotencyDisposition(null, "a")).toBe("new");
    expect(idempotencyDisposition({ requestDigest: "a" }, "a")).toBe("replay");
    expect(idempotencyDisposition({ requestDigest: "a" }, "b")).toBe("conflict");
  });

  test("only pending commands expire automatically", () => {
    expect(schedulerExpiryDisposition("pending", 10, 9)).toBe("wait");
    expect(schedulerExpiryDisposition("pending", 10, 10)).toBe("expire");
    for (const state of states.filter((state) => state !== "pending")) {
      expect(schedulerExpiryDisposition(state, 10, 100)).toBe("leave");
    }
  });

  test("effect-bearing transitions require the exact live and bound authority", () => {
    const authorityFaults: readonly AuthorityTuple[] = [
      { ...liveAuthority, bootGeneration: liveAuthority.bootGeneration + 1 },
      { ...liveAuthority, bootId: "boot_stale_0001" },
      { ...liveAuthority, fence: liveAuthority.fence + 1 },
    ];
    for (const requestedAuthority of authorityFaults) {
      const result = authorityTransition({ requestedAuthority });
      expect(result).toEqual({
        boundAuthority: liveAuthority,
        kind: "rejected",
        reason: "live_authority",
        state: "prepared",
      });
    }

    for (const now of [20_000, 20_001, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = authorityTransition({ now });
      expect(result).toEqual({
        boundAuthority: liveAuthority,
        kind: "rejected",
        reason: "lease_not_live",
        state: "prepared",
      });
    }

    const staleBound = { ...liveAuthority, fence: liveAuthority.fence - 1 };
    expect(authorityTransition({ boundAuthority: staleBound })).toEqual({
      boundAuthority: staleBound,
      kind: "rejected",
      reason: "bound_authority",
      state: "prepared",
    });
  });

  test("prepared commands rebind only before an effect and rejects stay inert", () => {
    const staleBound = { ...liveAuthority, fence: liveAuthority.fence - 1 };
    expect(authorityTransition({
      boundAuthority: staleBound,
      next: "prepared",
    })).toEqual({
      boundAuthority: liveAuthority,
      kind: "rebound",
      state: "prepared",
    });
    expect(authorityTransition({
      boundAuthority: staleBound,
      state: "effect_started",
    })).toEqual({
      boundAuthority: staleBound,
      kind: "rejected",
      reason: "bound_authority",
      state: "effect_started",
    });
    expect(authorityTransition({
      boundAuthority: null,
      next: "prepared",
      state: "pending",
    })).toEqual({
      boundAuthority: liveAuthority,
      kind: "applied",
      state: "prepared",
    });
    expect(authorityTransition({
      boundAuthority: null,
      state: "pending",
    })).toEqual({
      boundAuthority: null,
      kind: "rejected",
      reason: "bound_authority",
      state: "pending",
    });
  });

  test("effect start and settlement admit only their closed transition states", () => {
    expect(authorityTransition()).toEqual({
      boundAuthority: liveAuthority,
      kind: "applied",
      state: "effect_started",
    });
    expect(authorityTransition({ state: "effect_started" })).toEqual({
      boundAuthority: liveAuthority,
      kind: "replay",
      state: "effect_started",
    });
    expect(authorityTransition({
      next: "applied",
      state: "effect_started",
    })).toEqual({
      boundAuthority: liveAuthority,
      kind: "applied",
      state: "applied",
    });
    expect(authorityTransition({ next: "applied" })).toEqual({
      boundAuthority: liveAuthority,
      kind: "rejected",
      reason: "invalid_transition",
      state: "prepared",
    });
  });
});
