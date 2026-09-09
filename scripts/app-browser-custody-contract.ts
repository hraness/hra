import assert from "node:assert/strict";

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "Expected a native custody receipt object");
  assert.equal(Object.getPrototypeOf(value), Object.prototype, "Expected a plain native custody receipt object");
  return value as Record<string, unknown>;
}

/** Proof-only checks. Native absence remains separately required by the process
 * test; it cannot excuse a cleanup failure hidden alongside cancellation. */
export function assertPreparationCancellationProof(preparationValue: unknown, runnerValue: unknown): void {
  const preparation = record(preparationValue), runner = record(runnerValue);
  assert.equal(preparation.state, "failed");
  assert.equal(preparation.collected, true);
  assert.deepEqual(preparation.failure, { name: "Error", message: "Browser preparation cancelled" },
    "Preparation must fail only from the reviewed cancellation phase");
  assert.equal(runner.preparationCollected, false);
  assert.equal(runner.cancelled, true);
  assert.equal(runner.inputsUnchanged, true);
}

export function assertConnectedCancellationProof(driverValue: unknown): void {
  const driver = record(driverValue);
  const expected = { name: "Error", message: "Browser profile desktop cancelled" };
  assert.equal(driver.state, "failed");
  // Exact objects reject aggregates, causes, error arrays and laundered extra
  // fields, even if every process and listener is absent after owner exit.
  assert.deepEqual(driver.failure, expected, "Connected custody must fail only from the reviewed profile cancellation");
  assert.ok(Array.isArray(driver.profileDiagnostics) && driver.profileDiagnostics.length === 1);
  const profile = record(driver.profileDiagnostics[0]);
  assert.equal(profile.name, "desktop");
  assert.deepEqual(profile.failure, expected, "The sole desktop profile must retain the same cancellation failure");
}
