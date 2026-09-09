import { expect, test } from "bun:test";
import * as fc from "fast-check";
import { finishSiteTestBuild } from "./build-site-test-shutdown";

test("finishes the build and awaits shutdown before publishing its terminal", async () => {
  const built = Promise.withResolvers<readonly string[]>();
  const stopping = Promise.withResolvers<undefined>();
  const stopEntered = Promise.withResolvers<undefined>();
  const events: string[] = [];
  const task = finishSiteTestBuild(async () => {
    events.push("build");
    const value = await built.promise;
    events.push("built");
    return value;
  }, async () => {
    events.push("stop"); stopEntered.resolve(undefined);
    await stopping.promise;
    events.push("stopped");
  }).then((terminal) => { events.push("published"); return terminal; });
  expect(events).toEqual(["build"]);
  built.resolve(["README.md"]);
  // Either outcome releases this deterministic observation; a missing stop
  // must fail the ordering assertion instead of waiting for the test timeout.
  await Promise.race([stopEntered.promise, task]);
  expect(events).toEqual(["build", "built", "stop"]);
  stopping.resolve(undefined);
  expect(await task).toEqual({ status: "success", mismatches: ["README.md"] });
  expect(events).toEqual(["build", "built", "stop", "stopped", "published"]);
});

test("preserves the original builder error after successful shutdown", async () => {
  const error = new TypeError("synthetic builder failure");
  const events: string[] = [];
  const terminal = await finishSiteTestBuild(() => {
    events.push("build"); return Promise.reject(error);
  }, async () => { events.push("stop"); });
  expect(terminal).toEqual({ status: "failure", name: error.name, message: error.message, stack: error.stack });
  expect(events).toEqual(["build", "stop"]);
});

test.each(["builder success", "builder error", "builder throws undefined"] as const)(
  "shutdown refusal publishes no terminal and retains tagged causes: %s", async (mode) => {
    const buildError = mode === "builder throws undefined" ? undefined : new Error("synthetic build detail");
    const stopError = new Error("synthetic stop detail");
    let published = false;
    const failure: unknown = await finishSiteTestBuild(
      () => mode === "builder success" ? Promise.resolve([]) : Promise.reject(buildError),
      () => Promise.reject(stopError),
    ).then(() => { published = true; }, (error: unknown) => error);
    expect(published).toBe(false);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error("Expected shutdown refusal");
    expect(failure.message).toBe("SITE_COMPILER_SHUTDOWN_FAILED");
    const causes: unknown[] = failure.errors;
    expect(causes).toHaveLength(mode === "builder success" ? 1 : 2);
    const stopCause = causes.at(-1);
    expect(stopCause).toBeInstanceOf(Error);
    if (!(stopCause instanceof Error)) throw new Error("Expected tagged shutdown failure");
    expect(stopCause.message).toBe("SITE_COMPILER_SHUTDOWN_FAILED");
    expect(stopCause.cause).toBe(stopError);
    if (mode !== "builder success") {
      const buildCause = causes[0];
      expect(buildCause).toBeInstanceOf(Error);
      if (!(buildCause instanceof Error)) throw new Error("Expected tagged builder failure");
      expect(buildCause.message).toBe("SITE_COMPILER_BUILD_FAILED");
      expect(Object.hasOwn(buildCause, "cause")).toBe(true);
      expect(buildCause.cause).toBe(buildError);
    }
  },
);

test("synchronous shutdown throws retain a thrown undefined builder failure", async () => {
  const stopError = new Error("synthetic synchronous stop failure");
  const failure: unknown = await finishSiteTestBuild(
    () => Promise.reject(undefined),
    () => { throw stopError; },
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError)) throw new Error("Expected shutdown refusal");
  const causes: unknown[] = failure.errors;
  expect(causes).toHaveLength(2);
  expect(causes.map((cause) => cause instanceof Error ? cause.message : "untagged")).toEqual([
    "SITE_COMPILER_BUILD_FAILED", "SITE_COMPILER_SHUTDOWN_FAILED",
  ]);
});

test("a builder rejection with undefined remains a failure after shutdown", async () => {
  const terminal = await finishSiteTestBuild(() => Promise.reject(undefined), async () => {});
  expect(terminal).toEqual({ status: "failure", name: "Error", message: "undefined" });
});

test("requests shutdown before converting a hostile thrown value to terminal text", async () => {
  const conversionError = new Error("synthetic conversion failure");
  const events: string[] = [];
  const thrown = { toString() { events.push("convert"); throw conversionError; } };
  await expect(finishSiteTestBuild(() => Promise.reject(thrown), async () => { events.push("stop"); })).rejects.toBe(conversionError);
  expect(events).toEqual(["stop", "convert"]);
});

test("shutdown refusal retains a hostile raw build failure without converting it", async () => {
  let converted = false;
  const thrown = { toString() { converted = true; throw new Error("synthetic conversion failure"); } };
  const stopError = new Error("synthetic stop failure");
  const failure: unknown = await finishSiteTestBuild(
    () => Promise.reject(thrown), () => Promise.reject(stopError),
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError)) throw new Error("Expected shutdown refusal");
  const causes: unknown[] = failure.errors;
  expect(causes).toHaveLength(2);
  const buildCause = causes[0];
  expect(buildCause).toBeInstanceOf(Error);
  if (!(buildCause instanceof Error)) throw new Error("Expected tagged builder failure");
  expect(buildCause.cause).toBe(thrown);
  expect(converted).toBe(false);
});

test("bounded outcomes preserve build-before-stop order and terminal data", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.string({ maxLength: 64 }), async (failed, message) => {
    const events: string[] = [];
    const terminal = await finishSiteTestBuild(() => {
      events.push("build");
      return failed ? Promise.reject(message) : Promise.resolve([message]);
    }, async () => { events.push("stop"); });
    events.push("published");
    expect(events).toEqual(["build", "stop", "published"]);
    expect(terminal).toEqual(failed
      ? { status: "failure", name: "Error", message }
      : { status: "success", mismatches: [message] });
  }), { seed: 68174, numRuns: 60 });
});
