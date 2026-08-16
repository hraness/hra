import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";
import type { AccountUsageState } from "../src/internal-contracts";
import { projectRateLimitsUpdated } from "../src/accounts/protocol";

const observedAt = "2026-07-19T12:00:00.000Z";

const updateValueArbitrary = fc.record({
  usedPercent: fc.integer({ min: 0, max: 100 }),
  windowDurationMins: fc.option(
    fc.integer({ min: 0, max: 5_256_000 }),
    { nil: null },
  ),
  reachedByProvider: fc.boolean(),
});

test("distinct sparse rate-limit updates commute and duplicate delivery is idempotent", () => {
  assertProperty(
    fc.property(
      fc.array(updateValueArbitrary, { minLength: 1, maxLength: 32 }),
      (values) => {
        const updates = values.map((value, index) => ({
          rateLimits: {
            limitId: `bucket_${String(index).padStart(2, "0")}`,
            limitName: `Bucket ${index}`,
            primary: {
              usedPercent: value.usedPercent,
              windowDurationMins: value.windowDurationMins,
              resetsAt: null,
            },
            secondary: null,
            rateLimitReachedType: value.reachedByProvider
              ? "rate_limit_reached" as const
              : null,
          },
        }));

        const forward = applyUpdates(updates);
        const reverse = applyUpdates([...updates].reverse());
        expect(reverse).toEqual(forward);

        const duplicate = updates.at(-1);
        if (duplicate === undefined) throw new Error("property generated no updates");
        expect(projectRateLimitsUpdated(duplicate, observedAt, forward)).toEqual(forward);

        if (forward.state !== "ready") throw new Error("updates did not produce ready usage");
        expect(forward.limits.map(({ id }) => id)).toEqual(
          [...forward.limits.map(({ id }) => id)].sort(),
        );
      },
    ),
  );
});

function applyUpdates(
  updates: readonly Parameters<typeof projectRateLimitsUpdated>[0][],
): AccountUsageState {
  let state: AccountUsageState = { state: "unavailable" };
  for (const update of updates) {
    state = projectRateLimitsUpdated(update, observedAt, state);
  }
  return state;
}
