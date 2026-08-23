import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  commandTransitionDisposition,
  idempotencyDisposition,
  schedulerExpiryDisposition,
} from "./commands";
import type { CommandState } from "./contracts";

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
});
