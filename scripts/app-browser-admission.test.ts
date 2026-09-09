import { expect, test } from "bun:test";
import * as fc from "fast-check";
import {
  assertBrowserDriverAdmission, browserDigest, createBrowserAdmissionController,
  type BrowserExecutionAdmission, type BrowserFile, type BrowserHandoff,
} from "./app-browser-handoff.ts";
import { assertBrowserDriverReceiptAdmission, importAdmittedBrowserDriver } from "./app-browser-runner.ts";

const root = "/fixture/repository", run = `${root}/tmp/app-browser-ABC123`;
const executable = { path: "/fixture/runtime", sha256: "a".repeat(64) };
const driver = (): BrowserFile => ({ path: "driver.mjs", bytes: 4, sha256: browserDigest("test"), identity: [1, 2, 33152, 1, 4, 10, 11] });
const handoff = (): BrowserHandoff => ({
  request: { schemaVersion: 1, kind: "hra-browser-preparation-request", root, run,
    node: executable, bun: executable, chromium: executable, sources: [driver()], app: [driver()], site: [driver()] },
  prepared: { schemaVersion: 1, kind: "hra-browser-prepared", requestSha256: "b".repeat(64),
    buildRuntime: { name: "bun", version: "1.3.14", executable }, driver: driver(), fixture: [driver()] },
});
function fixture() {
  const cancellation = new AbortController();
  let inputs = handoff(), observed = driver();
  let onHandoff: (count: number) => void = () => {}, onDriver: (count: number) => void = () => {};
  let handoffReads = 0, driverReads = 0;
  const controller = createBrowserAdmissionController(root, run, cancellation.signal, {
    readHandoff: async () => { onHandoff(++handoffReads); return structuredClone(inputs); },
    readDriver: async () => { onDriver(++driverReads); return structuredClone(observed); },
  });
  return {
    controller, cancellation, inputs: (value: BrowserHandoff) => { inputs = value; },
    observed: (value: BrowserFile) => { observed = value; },
    onHandoff: (callback: (count: number) => void) => { onHandoff = callback; },
    onDriver: (callback: (count: number) => void) => { onDriver = callback; },
    reads: () => ({ handoff: handoffReads, driver: driverReads }),
  };
}
async function claimed(sample = fixture()) {
  const admission = await sample.controller.admit(true);
  sample.controller.claim(admission);
  return { ...sample, admission };
}
const verify = (admission: BrowserExecutionAdmission) => admission.verify(admission, root, run);

test("one execution admission retains both observations and allows only pre-admission ctime drift", async () => {
  const sample = fixture();
  sample.observed({ ...driver(), identity: [1, 2, 33152, 1, 4, 10, 99] });
  const original = handoff();
  const admission = await sample.controller.admit(true);
  expect(admission.evidence.producerDriver).toEqual(original.prepared.driver);
  expect(admission.evidence.executionDriver.identity).toEqual([1, 2, 33152, 1, 4, 10, 99]);
  expect(admission.evidence.preparedSha256).toBe(browserDigest(JSON.stringify(original.prepared)));
  expect(admission.evidence.requestSha256).toBe(original.prepared.requestSha256);
  expect(sample.reads()).toEqual({ handoff: 2, driver: 2 });
  sample.controller.claim(admission);
  expect(await verify(admission)).toEqual(original);
  expect(await verify(admission)).toBe(await verify(admission));
});

test("producer-to-execution comparison rejects every non-ctime field and malformed identity", () => {
  for (let index = 0; index < 6; index += 1) {
    const identity = [...driver().identity]; identity[index]! += 1;
    expect(() => assertBrowserDriverAdmission(driver(), { ...driver(), identity })).toThrow();
  }
  for (const changed of [
    { ...driver(), path: "other.mjs" }, { ...driver(), bytes: 5 }, { ...driver(), sha256: "c".repeat(64) },
    { ...driver(), identity: [1, 2, 33152, 1, 4, 10] }, { ...driver(), identity: [1, 2, 33152, 1, 4, 10, -1] },
    { ...driver(), identity: [1, 2, 33152, 1, 4, 10, Number.NaN] },
    { ...driver(), bytes: 0, identity: [1, 2, 33152, 1, 0, 10, 11] },
    { ...driver(), bytes: 4 * 1024 * 1024 + 1, identity: [1, 2, 33152, 1, 4 * 1024 * 1024 + 1, 10, 11] },
    { ...driver(), extra: "foreign" },
  ]) expect(() => assertBrowserDriverAdmission(driver(), changed)).toThrow();
  fc.assert(fc.property(fc.integer({ min: 0, max: 1_000_000 }), (ctime) => {
    expect(() => assertBrowserDriverAdmission(driver(), { ...driver(), identity: [1, 2, 33152, 1, 4, 10, ctime] })).not.toThrow();
  }), { seed: 20260908, numRuns: 100 });
});

test("changes inside the first descriptor observation fail instead of admitting a second snapshot", async () => {
  const sample = fixture(), original = new Error("descriptor identity changed during bounded read");
  sample.onDriver(() => { throw original; });
  await expect(sample.controller.admit(true)).rejects.toBe(original);
  expect(sample.reads()).toEqual({ handoff: 1, driver: 1 });
  sample.onDriver(() => {});
  await expect(sample.controller.admit(true)).rejects.toThrow("already attempted");
});

for (let index = 0; index < 7; index += 1) {
  test(`all seven execution identity fields are strict after first observation: field ${index}`, async () => {
    const sample = fixture();
    sample.onDriver((count) => {
      if (count !== 2) return;
      const identity = [...driver().identity]; identity[index]! += 1;
      sample.observed({ ...driver(), identity });
    });
    await expect(sample.controller.admit(true)).rejects.toThrow("changed during execution admission");
  });
}

test("changed compiler receipt, request, fixture or bytes cannot cross admission", async () => {
  const mutations: ((value: BrowserHandoff) => BrowserHandoff)[] = [
    (value) => ({ ...value, prepared: { ...value.prepared, requestSha256: "d".repeat(64) } }),
    (value) => ({ ...value, prepared: { ...value.prepared, driver: { ...driver(), identity: [1, 2, 33152, 1, 4, 10, 12] } } }),
    (value) => ({ ...value, prepared: { ...value.prepared, fixture: [{ ...driver(), sha256: "e".repeat(64) }] } }),
    (value) => ({ ...value, request: { ...value.request, sources: [{ ...driver(), sha256: "f".repeat(64) }] } }),
  ];
  for (const mutate of mutations) {
    const sample = fixture();
    sample.onHandoff((count) => { if (count === 2) sample.inputs(mutate(handoff())); });
    await expect(sample.controller.admit(true)).rejects.toThrow("preparation changed during execution admission");
  }
  const sample = fixture();
  sample.observed({ ...driver(), sha256: "e".repeat(64) });
  await expect(sample.controller.admit(true)).rejects.toThrow("changed before execution admission");
});

test("uncollected, failed and cancelled preparation cannot mint execution authority", async () => {
  const uncollected = fixture();
  await expect(uncollected.controller.admit(false)).rejects.toThrow("has not been collected");
  expect(uncollected.reads()).toEqual({ handoff: 0, driver: 0 });
  await expect(uncollected.controller.admit(true)).rejects.toThrow("already attempted");
  const failed = fixture();
  failed.onHandoff(() => { throw new Error("request input changed"); });
  await expect(failed.controller.admit(true)).rejects.toThrow("request input changed");
  await expect(failed.controller.admit(true)).rejects.toThrow("already attempted");
  const cancelled = fixture(); cancelled.cancellation.abort();
  await expect(cancelled.controller.admit(true)).rejects.toThrow("cancelled");
  expect(cancelled.reads()).toEqual({ handoff: 0, driver: 0 });
});

for (const boundary of ["handoff:1", "driver:1", "handoff:2", "driver:2"] as const) {
  test(`cancellation at ${boundary} never returns an admission`, async () => {
    const sample = fixture();
    sample.onHandoff((count) => { if (`handoff:${count}` === boundary) sample.cancellation.abort(); });
    sample.onDriver((count) => { if (`driver:${count}` === boundary) sample.cancellation.abort(); });
    await expect(sample.controller.admit(true)).rejects.toThrow("cancelled");
    await expect(sample.controller.admit(true)).rejects.toThrow("already attempted");
  });
}

test("admission has one owner claim; cancellation or verification cannot create that claim", async () => {
  const sample = fixture(), admission = await sample.controller.admit(true);
  await expect(verify(admission)).rejects.toThrow("not claimed");
  await expect(sample.controller.admit(true)).rejects.toThrow("already attempted");
  sample.controller.claim(admission);
  expect(() => sample.controller.claim(admission)).toThrow("already claimed");
  await verify(admission);
  const cancelled = fixture(), other = await cancelled.controller.admit(true);
  cancelled.cancellation.abort();
  expect(() => cancelled.controller.claim(other)).toThrow("cancelled");
  await expect(verify(other)).rejects.toThrow("not claimed");
});

test("foreign, copied, serialized, wrong-receiver and cross-run admissions are rejected before reads", async () => {
  const sample = await claimed(), other = await claimed();
  const before = sample.reads();
  const copy = { ...sample.admission };
  for (const value of [copy, Object.freeze(copy), other.admission,
    JSON.parse(JSON.stringify(sample.admission)) as BrowserExecutionAdmission,
    new Proxy(sample.admission, {})]) {
    expect(() => sample.controller.claim(value)).toThrow();
    await expect(sample.admission.verify(value, root, run)).rejects.toThrow("Foreign");
    await expect(sample.admission.verify.call(value, sample.admission, root, run)).rejects.toThrow("Foreign");
  }
  await expect(sample.admission.verify(sample.admission, `${root}-other`, run)).rejects.toThrow();
  await expect(sample.admission.verify(sample.admission, root, `${run}other`)).rejects.toThrow();
  await expect(sample.admission.verify.call(undefined as unknown as BrowserExecutionAdmission, sample.admission, root, run)).rejects.toThrow("Foreign");
  expect(sample.reads()).toEqual(before);
  await verify(sample.admission);
});

test("authority and nested snapshots are immutable without sharing mutable producer input aliases", async () => {
  const sample = await claimed(), { admission } = sample;
  const snapshot = await verify(admission);
  const objects = [admission, admission.evidence, admission.evidence.producerDriver, admission.evidence.executionDriver,
    admission.evidence.producerDriver.identity, admission.evidence.executionDriver.identity,
    snapshot, snapshot.request, snapshot.request.node, snapshot.request.sources, snapshot.request.sources[0]!,
    snapshot.request.sources[0]!.identity, snapshot.prepared, snapshot.prepared.buildRuntime, snapshot.prepared.fixture];
  for (const object of objects) {
    expect(Object.isFrozen(object)).toBe(true);
    expect(Reflect.set(object, "foreign", true)).toBe(false);
    expect(() => { Object.setPrototypeOf(object, { injected: true }); }).toThrow();
  }
  expect(Reflect.set(admission.evidence.executionDriver.identity, "6", 999)).toBe(false);
  expect(Reflect.set(admission, "verify", async () => snapshot)).toBe(false);
  expect(Reflect.set(admission.evidence.executionDriver, "sha256", "f".repeat(64))).toBe(false);
  await verify(admission);
});

test("post-admission ctime drift is fatal and cannot be healed by restoring or readmitting", async () => {
  const sample = await claimed();
  sample.observed({ ...driver(), identity: [1, 2, 33152, 1, 4, 10, 12] });
  await expect(verify(sample.admission)).rejects.toThrow("driver changed after execution admission");
  sample.observed(driver());
  await expect(verify(sample.admission)).rejects.toThrow("not claimed");
  await expect(sample.controller.admit(true)).rejects.toThrow("already attempted");
  expect(() => sample.controller.claim(sample.admission)).toThrow("already claimed or failed");
});

test("every driver path, content, length and complete identity field stays exact after dispatch", async () => {
  const mutations: BrowserFile[] = [
    { ...driver(), path: "other.mjs" }, { ...driver(), bytes: 5 }, { ...driver(), sha256: "d".repeat(64) },
    ...driver().identity.map((_value, index) => {
      const identity = [...driver().identity]; identity[index]! += 1;
      return { ...driver(), identity };
    }),
  ];
  for (const mutation of mutations) {
    const sample = await claimed();
    const module = await importAdmittedBrowserDriver(root, run, sample.cancellation.signal, sample.admission, async () => ({
      runAppBrowser: async () => { sample.observed(mutation); },
    }));
    await module.runAppBrowser(root, run, sample.cancellation.signal, sample.admission);
    await expect(verify(sample.admission)).rejects.toThrow("driver changed after execution admission");
  }
});

test("immutable snapshots do not alias the operation's mutable producer objects", async () => {
  const input = handoff(), observed = driver();
  const controller = createBrowserAdmissionController(root, run, new AbortController().signal, {
    readHandoff: async () => input, readDriver: async () => observed,
  });
  const admission = await controller.admit(true); controller.claim(admission);
  expect(Object.isFrozen(input)).toBe(false); expect(Object.isFrozen(observed)).toBe(false);
  Object.assign(observed, { sha256: "e".repeat(64) });
  expect(admission.evidence.executionDriver.sha256).toBe(driver().sha256);
  await expect(verify(admission)).rejects.toThrow("driver changed after execution admission");
});

test("terminal receipt binds the same producer, execution tuple and dispatched bundle", async () => {
  const { admission } = await claimed();
  const receipt = {
    executionAdmission: structuredClone(admission.evidence), preparationSha256: admission.evidence.preparedSha256,
    driverRuntime: { bundleSha256: admission.evidence.executionDriver.sha256 },
  };
  expect(() => assertBrowserDriverReceiptAdmission(receipt, admission)).not.toThrow();
  for (const changed of [
    { ...receipt, executionAdmission: undefined },
    { ...receipt, executionAdmission: { ...receipt.executionAdmission, run: `${run}foreign` } },
    { ...receipt, executionAdmission: { ...receipt.executionAdmission, producerDriver: { ...driver(), identity: [1, 2, 33152, 1, 4, 10, 999] } } },
    { ...receipt, executionAdmission: { ...receipt.executionAdmission, executionDriver: { ...driver(), identity: [1, 2, 33152, 1, 4, 10, 999] } } },
    { ...receipt, preparationSha256: "e".repeat(64) },
    { ...receipt, driverRuntime: { bundleSha256: "f".repeat(64) } },
    { ...receipt, driverRuntime: null },
  ]) expect(() => assertBrowserDriverReceiptAdmission(changed, admission)).toThrow();
});

test("concurrent verification cannot establish another observation or claim", async () => {
  let finish: () => void = () => { throw new Error("Missing resolver"); };
  const blocked = new Promise<void>((resolve) => { finish = resolve; });
  let blockedRead = false, reads = 0;
  const controller = createBrowserAdmissionController(root, run, new AbortController().signal, {
    readHandoff: async () => { reads += 1; if (blockedRead) await blocked; return handoff(); },
    readDriver: async () => driver(),
  });
  const admission = await controller.admit(true); controller.claim(admission); blockedRead = true;
  const pending = verify(admission);
  await expect(verify(admission)).rejects.toThrow("Concurrent");
  expect(reads).toBe(3);
  finish(); await pending;
});

test("pre-import mutation blocks module loading and post-import mutation blocks dispatch", async () => {
  for (const boundary of ["before", "inside"] as const) {
    const sample = await claimed(); let imports = 0, dispatches = 0;
    const change = () => sample.observed({ ...driver(), sha256: "d".repeat(64) });
    if (boundary === "before") change();
    await expect(importAdmittedBrowserDriver(root, run, sample.cancellation.signal, sample.admission, async () => {
      imports += 1; change(); return { runAppBrowser: async () => { dispatches += 1; } };
    })).rejects.toThrow("driver changed after execution admission");
    expect(imports).toBe(boundary === "before" ? 0 : 1); expect(dispatches).toBe(0);
  }
});

test("import and dispatch share the same authority and cancelled runs never dispatch", async () => {
  const sample = await claimed(); let received: BrowserExecutionAdmission | undefined;
  const module = await importAdmittedBrowserDriver(root, run, sample.cancellation.signal, sample.admission, async () => ({
    runAppBrowser: async (_root: string, _run: string, _signal: AbortSignal, admission: BrowserExecutionAdmission) => {
      received = admission; await verify(admission);
    },
  }));
  await module.runAppBrowser(root, run, sample.cancellation.signal, sample.admission);
  expect(received).toBe(sample.admission);
  sample.cancellation.abort();
  let imports = 0;
  await expect(importAdmittedBrowserDriver(root, run, sample.cancellation.signal, sample.admission,
    async () => { imports += 1; return module; })).rejects.toThrow("cancelled");
  expect(imports).toBe(0);
  // Cancellation never skips the owner's strict terminal identity postflight.
  await verify(sample.admission);
  sample.observed({ ...driver(), identity: [1, 2, 33152, 1, 4, 10, 20] });
  await expect(verify(sample.admission)).rejects.toThrow("driver changed after execution admission");
});

test("cancellation during import and setup failure retain a claimed baseline without another import", async () => {
  const cancelled = await claimed();
  await expect(importAdmittedBrowserDriver(root, run, cancelled.cancellation.signal, cancelled.admission, async () => {
    cancelled.cancellation.abort(); return { runAppBrowser: async () => {} };
  })).rejects.toThrow("cancelled");
  await verify(cancelled.admission);
  const failed = await claimed(), original = new Error("module setup failed");
  await expect(importAdmittedBrowserDriver(root, run, failed.cancellation.signal, failed.admission,
    async () => { throw original; })).rejects.toBe(original);
  await verify(failed.admission);
  await expect(failed.controller.admit(true)).rejects.toThrow("already attempted");
});
