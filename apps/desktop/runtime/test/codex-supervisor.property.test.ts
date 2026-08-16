import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";
import { codexRestartDelay } from "../src/codex";

test("restart backoff is monotonic and never exceeds its cap", () => {
  assertProperty(
    fc.property(
      fc.integer({ min: 1, max: 10_000 }),
      fc.integer({ min: 1, max: 10_000 }),
      fc.integer({ min: 1, max: 32 }),
      (initial, additionalCap, attempts) => {
        const policy = {
          initialDelayMs: initial,
          maximumDelayMs: initial + additionalCap,
          maximumRestartAttempts: attempts,
        };
        let previous = 0;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          const delay = codexRestartDelay(policy, attempt);
          expect(delay).toBeGreaterThanOrEqual(previous);
          expect(delay).toBeLessThanOrEqual(policy.maximumDelayMs);
          previous = delay;
        }
      },
    ),
  );
});
