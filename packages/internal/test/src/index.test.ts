import { expect, test } from "bun:test";

import { assertAsyncProperty, assertProperty, fc, propertyParameters } from "./index";

test("property defaults keep suites bounded and shrinking enabled", () => {
  expect(propertyParameters.numRuns).toBeGreaterThanOrEqual(100);
  expect(propertyParameters.interruptAfterTimeLimit).toBeLessThanOrEqual(10_000);
  assertProperty(fc.property(fc.integer(), (value) => Number.isInteger(value)));
});

test("async properties use the repository defaults", async () => {
  await assertAsyncProperty(fc.asyncProperty(fc.integer(), async (value) => {
    await Promise.resolve();
    return Number.isInteger(value);
  }));
});
