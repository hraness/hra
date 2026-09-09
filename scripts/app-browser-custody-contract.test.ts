import { expect, test } from "bun:test";
import fc from "fast-check";
import { assertConnectedCancellationProof, assertPreparationCancellationProof } from "./app-browser-custody-contract.ts";

const preparationFailure = () => ({ name: "Error", message: "Browser preparation cancelled" });
const connectedFailure = () => ({ name: "Error", message: "Browser profile desktop cancelled" });
const preparation = () => ({ state: "failed", collected: true, failure: preparationFailure() });
const runner = () => ({ preparationCollected: false, cancelled: true, inputsUnchanged: true });
const driver = () => ({ state: "failed", failure: connectedFailure(), profileDiagnostics: [{ name: "desktop", failure: connectedFailure() }] });

test("native cancellation proof requires the exact preparation and connected failure shapes", () => {
  expect(() => assertPreparationCancellationProof(preparation(), runner())).not.toThrow();
  expect(() => assertConnectedCancellationProof(driver())).not.toThrow();
});

test("preparation cancellation cannot claim successful admission, unchanged cancellation state or unknown collection", () => {
  for (const patch of [{ state: "passed" }, { collected: false }, { collected: undefined }]) {
    expect(() => assertPreparationCancellationProof({ ...preparation(), ...patch }, runner())).toThrow();
  }
  for (const patch of [{ preparationCollected: true }, { preparationCollected: undefined }, { cancelled: false }, { inputsUnchanged: false }]) {
    expect(() => assertPreparationCancellationProof(preparation(), { ...runner(), ...patch })).toThrow();
  }
});

for (const phase of ["preparation", "connected"] as const) {
  const expectedFailure = phase === "preparation" ? preparationFailure : connectedFailure;
  const prove = (failure: unknown) => {
    if (phase === "preparation") assertPreparationCancellationProof({ ...preparation(), failure }, runner());
    else assertConnectedCancellationProof({ ...driver(), failure });
  };

  test(`${phase} cancellation rejects absent, arbitrary and wrong-phase failures`, () => {
    for (const failure of [
      undefined, null, {}, "cancelled", new Error(expectedFailure().message),
      { name: "AbortError", message: expectedFailure().message },
      { name: "Error", message: "Browser acceptance cancelled" },
      { name: "Error", message: "Browser profile desktop exceeded 120000ms" },
      phase === "preparation" ? connectedFailure() : preparationFailure(),
    ]) expect(() => prove(failure)).toThrow();
    if (phase === "preparation") {
      expect(() => assertPreparationCancellationProof({ state: "failed", collected: true }, runner())).toThrow();
    } else {
      expect(() => assertConnectedCancellationProof({ state: "failed", profileDiagnostics: driver().profileDiagnostics })).toThrow();
    }
  });

  test(`${phase} cancellation rejects cleanup aggregates and laundered cancellation fields`, () => {
    const cleanup = { name: "Error", message: "Browser fixture server stop exceeded 5000ms" };
    for (const failure of [
      { name: "AggregateError", message: "Browser gate and server cleanup failed", errors: [expectedFailure(), cleanup] },
      { ...expectedFailure(), cause: cleanup },
      { ...expectedFailure(), errors: [cleanup] },
      { ...expectedFailure(), cause: undefined },
      { ...expectedFailure(), errors: [] },
      { ...expectedFailure(), cleanupFailed: true },
    ]) expect(() => prove(failure)).toThrow();
  });

  test(`${phase} cancellation admits no other failure name or message`, () => {
    fc.assert(fc.property(fc.string({ maxLength: 160 }), fc.string({ maxLength: 160 }), (name, message) => {
      if (name === expectedFailure().name && message === expectedFailure().message) return;
      expect(() => prove({ name, message })).toThrow();
    }), { seed: 20260908, numRuns: 100 });
  });
}

test("connected cancellation binds the driver failure to its sole desktop profile", () => {
  for (const profileDiagnostics of [
    undefined, [], [driver().profileDiagnostics[0], driver().profileDiagnostics[0]],
    [{ name: "light-os", failure: connectedFailure() }],
    [{ name: "desktop" }],
    [{ name: "desktop", failure: preparationFailure() }],
    [{ name: "desktop", failure: { ...connectedFailure(), cause: { name: "Error", message: "cleanup failed" } } }],
  ]) expect(() => assertConnectedCancellationProof({ ...driver(), profileDiagnostics })).toThrow();
  expect(() => assertConnectedCancellationProof({ ...driver(), state: "passed" })).toThrow();
});

test("native cancellation proof rejects non-object and foreign-prototype receipts", () => {
  for (const value of [undefined, null, [], "failed", Object.create({ state: "failed" }) as unknown]) {
    expect(() => assertPreparationCancellationProof(value, runner())).toThrow();
    expect(() => assertPreparationCancellationProof(preparation(), value)).toThrow();
    expect(() => assertConnectedCancellationProof(value)).toThrow();
  }
});
