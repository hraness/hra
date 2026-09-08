import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseSync } from "@babel/core";
import {
  browserDiagnosticLine, browserFailureClass, browserNegativeStep, observeBrowserCustody,
  recordBrowserProfileFailure, withBrowserNegativeCleanup,
  type BrowserCustodyObservation, type BrowserCustodyObserver,
} from "./app-browser";

function assertOwnedBrowserSignalPolicy(source: string): void {
  const tree = parseSync(source, {
    babelrc: false, configFile: false, sourceType: "module", parserOpts: { plugins: ["typescript"] },
  });
  expect(tree).not.toBeNull();
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const launches: Record<string, unknown>[] = [];
  let nodes = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const child of value) visit(child); return; }
    const node = object(value);
    if (node === undefined) return;
    if (++nodes > 100_000) throw new Error("Browser launch policy AST exceeds its bound");
    const callee = object(node.callee);
    if (object(callee?.object)?.name === "chromium"
      && object(callee?.property)?.name === "launchPersistentContext") {
      expect(node.type).toBe("CallExpression");
      expect(callee?.type).toBe("MemberExpression");
      expect(callee?.computed).toBe(false);
      launches.push(node);
    }
    for (const [key, child] of Object.entries(node)) {
      if (!["loc", "start", "end", "comments", "tokens"].includes(key)) visit(child);
    }
  };
  visit(tree);
  expect(launches).toHaveLength(1);
  const args = launches[0]?.arguments;
  if (!Array.isArray(args) || args.length !== 2) throw new Error("Expected one explicit browser launch options object");
  const options = object(args[1]);
  expect(options?.type).toBe("ObjectExpression");
  const properties = options?.properties;
  if (!Array.isArray(properties)) throw new Error("Expected explicit browser launch properties");
  const fields = properties.map((property: unknown) => object(property));
  for (const field of fields) {
    expect(field?.type).toBe("ObjectProperty");
    expect(field?.computed).toBe(false);
  }
  for (const signal of ["handleSIGINT", "handleSIGTERM"]) {
    const matches = fields.filter((field) => {
      const key = object(field?.key);
      return (key?.type === "Identifier" ? key.name : key?.type === "StringLiteral" ? key.value : undefined) === signal;
    });
    expect(matches).toHaveLength(1);
    const value = object(matches[0]?.value);
    expect(value?.type).toBe("BooleanLiteral");
    expect(value?.value).toBe(false);
  }
}

test("the actual browser launch leaves SIGINT and SIGTERM cleanup solely with the bootstrap", async () => {
  assertOwnedBrowserSignalPolicy(await readFile(new URL("./app-browser.ts", import.meta.url), "utf8"));
});

test("browser signal ownership rejects defaults, enabled handlers and overrides at the actual call boundary", () => {
  const prefix = "chromium.launchPersistentContext(profile, ";
  const options = "{ handleSIGINT: false, handleSIGTERM: false }";
  expect(() => assertOwnedBrowserSignalPolicy(`${prefix}${options});`)).not.toThrow();
  expect(() => assertOwnedBrowserSignalPolicy(`${prefix}{ 'handleSIGINT': false, 'handleSIGTERM': false });`)).not.toThrow();
  for (const invalid of [
    "{}", "{ handleSIGINT: false }", "{ handleSIGTERM: false }",
    "{ handleSIGINT: true, handleSIGTERM: false }", "{ handleSIGINT: false, handleSIGTERM: true }",
    "{ handleSIGINT: false, handleSIGTERM: runtimePolicy }",
    "{ handleSIGINT: false, handleSIGTERM: false, ...overrides }",
    "{ handleSIGINT: false, handleSIGTERM: false, handleSIGTERM: true }",
    "{ handleSIGINT: false, handleSIGTERM: false, 'handleSIGTERM': true }",
    "{ 'handleSIGINT': false, handleSIGTERM: false, handleSIGINT: true }",
    "{ handleSIGINT: false, ['handleSIGTERM']: false }", "runtimeOptions",
  ]) expect(() => assertOwnedBrowserSignalPolicy(`${prefix}${invalid});`)).toThrow();
  expect(() => assertOwnedBrowserSignalPolicy(`const unused = ${options}; chromium.launchPersistentContext(profile, {});`)).toThrow();
  expect(() => assertOwnedBrowserSignalPolicy(`${prefix}${options}); ${prefix}${options});`)).toThrow();
});

test("native custody observations copy and freeze identities without exposing resource operations", () => {
  const pids = [42, 43], origins = ["http://127.0.0.1:1234"];
  const received: BrowserCustodyObservation[] = [];
  observeBrowserCustody((observation) => { received.push(observation); return undefined; },
    { kind: "browser-census-owned", run: "/fixture/run", origins, pids });
  pids.push(44); origins.push("http://127.0.0.1:5678");
  expect(received).toEqual([{ kind: "browser-census-owned", run: "/fixture/run", origins: ["http://127.0.0.1:1234"], pids: [42, 43] }]);
  const observation = received[0];
  expect(Object.isFrozen(observation)).toBe(true);
  if (observation?.kind !== "browser-census-owned") throw new Error("Missing closed observation");
  expect(Object.isFrozen(observation.origins)).toBe(true); expect(Object.isFrozen(observation.pids)).toBe(true);
  expect(Object.keys(observation).sort()).toEqual(["kind", "origins", "pids", "run"]);
});

test("native custody observation is optional, synchronous and propagates the exact setup failure", () => {
  const observation = { kind: "partial-servers-owned" as const, run: "/fixture/run", origins: ["http://127.0.0.1:1234", "http://127.0.0.1:5678"] };
  expect(() => observeBrowserCustody(undefined, observation)).not.toThrow();
  const failure = new Error("fixture setup failure");
  expect(() => observeBrowserCustody(() => { throw failure; }, observation)).toThrow(failure);
  // Foreign misuse must not install an unawaited asynchronous hook. The native
  // fixture only supplies a synchronous function returning undefined.
  const asynchronous = (() => Promise.resolve()) as unknown as BrowserCustodyObserver;
  expect(() => observeBrowserCustody(asynchronous, observation)).toThrow("must finish synchronously");
});

test("browser diagnostic output admits only finite labels and safe failure categories", () => {
  const secret = "/private/fixture-profile?credential=fixture-secret";
  expect(browserDiagnosticLine("light-os", "static-site:home:font-load", "progress"))
    .toBe('Browser diagnostic {"profile":"light-os","step":"static-site:home:font-load","phase":"progress"}');
  const cases = [
    [new Error("Browser profile light-os exceeded 120000ms"), "deadline"],
    [new Error("Closing browser census session exceeded 5000ms"), "deadline"],
    [new Error("Browser acceptance cancelled"), "cancelled"],
    [Object.assign(new Error(secret), { name: "AssertionError" }), "assertion"],
    [Object.assign(new Error(secret), { name: "TimeoutError" }), "deadline"],
    [new AggregateError([new Error(secret)], secret), "aggregate"],
    [new Error(secret), "error"],
    [{ message: secret, pageContent: "fixture content" }, "unknown"],
  ] as const;
  for (const [error, expected] of cases) {
    expect(browserFailureClass(error)).toBe(expected);
    const line = browserDiagnosticLine("light-os", "static-site:home:font-load", "failed", error);
    expect(line).toContain(`"failure":"${expected}"`);
    expect(line).not.toContain(secret);
    expect(line.length).toBeLessThan(200);
  }
  expect(browserDiagnosticLine(secret, secret, secret, new Error(secret)))
    .toBe('Browser diagnostic {"profile":"unknown-profile","step":"unknown-step","phase":"unknown-phase"}');
});

test("browser diagnostic failure step remains frozen when work advances during cleanup", () => {
  const first = new Error("Browser profile light-os exceeded 120000ms");
  const diagnostics: Parameters<typeof recordBrowserProfileFailure>[0] = {
    step: "static-site:home:font-load", failureStep: undefined, failure: undefined,
  };
  recordBrowserProfileFailure(diagnostics, first);
  diagnostics.step = "static-site:home:resource-bytes";
  recordBrowserProfileFailure(diagnostics, new Error("Owned browser close exceeded 20000ms"));
  expect(diagnostics.failureStep).toBe("static-site:home:font-load");
  expect(diagnostics.failure).toEqual({ name: "Error", message: first.message });
  expect(browserDiagnosticLine("light-os", diagnostics.step, "after-failure")).toContain('"phase":"after-failure"');
});

test("negative control substeps expose finite phases and bounded elapsed milliseconds without foreign data", () => {
  const step = "static-site:home:negative-foundation-css:restore";
  for (const phase of ["entered", "settled", "failed"]) {
    const line = browserDiagnosticLine("narrow-coarse", step, phase, new Error("private fixture text"), 12.9);
    expect(line).toContain(`"phase":"${phase}"`);
    expect(line).toContain('"elapsedMs":12');
    expect(line).not.toContain("private fixture text");
    expect(line).not.toContain("unknown-step");
    expect(line.length).toBeLessThan(300);
  }
  for (const elapsed of [-1, Number.NaN, Number.POSITIVE_INFINITY, "/private/fixture", {}]) {
    expect(browserDiagnosticLine("narrow-coarse", step, "entered", undefined, elapsed)).toContain('"elapsedMs":0');
  }
  expect(browserDiagnosticLine("narrow-coarse", step, "entered", undefined, 2 ** 40)).toContain('"elapsedMs":3600000');
  expect(browserDiagnosticLine("narrow-coarse", "fixture:primitives:negative-css:disable", "entered", undefined, 1))
    .not.toContain("unknown-step");
  expect(browserFailureClass(new Error("Browser font/frame settlement exceeded 15000ms"))).toBe("deadline");
});

test("negative control preserves first inner failure before restore and aggregates restore plus disposal failures", async () => {
  const primary = new Error("Browser font/frame settlement exceeded 15000ms");
  const restore = new Error("fixture restoration failure");
  const dispose = new Error("fixture disposal failure");
  const diagnostics: Parameters<typeof recordBrowserProfileFailure>[0] = {
    step: "static-site:home:negative-foundation-css", failureStep: undefined, failure: undefined,
  };
  const events: string[] = [];
  const report: Parameters<typeof browserNegativeStep>[2] = (step, phase, error) => {
    diagnostics.step = `static-site:home:negative-foundation-css:${step}`;
    events.push(`${step}:${phase}`);
    if (phase === "failed") recordBrowserProfileFailure(diagnostics, error);
  };
  let caught: unknown;
  try {
    await withBrowserNegativeCleanup(() => withBrowserNegativeCleanup(
      () => browserNegativeStep("settle-disabled", () => Promise.reject(primary), report),
      () => browserNegativeStep("restore", () => {
        expect(diagnostics.failureStep).toBe("static-site:home:negative-foundation-css:settle-disabled");
        return Promise.reject(restore);
      }, report), "restore"),
    () => browserNegativeStep("dispose", () => Promise.reject(dispose), report), "dispose");
  } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(AggregateError);
  if (!(caught instanceof AggregateError)) throw new Error("Expected cleanup aggregate");
  expect(caught.errors[0]).toBeInstanceOf(AggregateError);
  const inner: unknown = caught.errors[0];
  if (!(inner instanceof AggregateError)) throw new Error("Expected restoration aggregate");
  expect(inner.errors).toEqual([primary, restore]);
  expect(caught.errors[1]).toBe(dispose);
  expect(diagnostics.failure).toEqual({ name: "Error", message: primary.message });
  expect(diagnostics.failureStep).toBe("static-site:home:negative-foundation-css:settle-disabled");
  expect(events).toEqual([
    "settle-disabled:entered", "settle-disabled:failed", "restore:entered", "restore:failed", "dispose:entered", "dispose:failed",
  ]);
});

test("negative control awaits its exact pending operation before cleanup without racing a new timer", async () => {
  let finish: (value: number) => void = () => { throw new Error("Missing fixture resolver"); };
  const pending = new Promise<number>((resolve) => { finish = resolve; });
  const events: string[] = [];
  const report: Parameters<typeof browserNegativeStep>[2] = (step, phase) => { events.push(`${step}:${phase}`); };
  const result = withBrowserNegativeCleanup(
    () => browserNegativeStep("disable", () => pending, report),
    () => browserNegativeStep("restore", () => Promise.resolve(), report), "restore");
  await Promise.resolve();
  expect(events).toEqual(["disable:entered"]);
  finish(7);
  expect(await result).toBe(7);
  expect(events).toEqual(["disable:entered", "disable:settled", "restore:entered", "restore:settled"]);
});

test("negative control preserves isolated primary or cleanup errors and does not swallow undefined rejection", async () => {
  const primary = new Error("fixture primary");
  const cleanup = new Error("fixture cleanup");
  await expect(withBrowserNegativeCleanup(() => Promise.reject(primary), () => Promise.resolve(), "restore")).rejects.toBe(primary);
  await expect(withBrowserNegativeCleanup(() => Promise.resolve(), () => Promise.reject(cleanup), "dispose")).rejects.toBe(cleanup);
  await expect(withBrowserNegativeCleanup(() => Promise.reject(undefined), () => Promise.resolve(), "restore"))
    .rejects.toThrow("Browser stylesheet operation failed");
});

test("CI always retains only the browser receipt allowlist, with bounded repository artifact retention", async () => {
  const source = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const workflow: unknown = Bun.YAML.parse(source);
  const object = (value: unknown): Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected workflow object");
    return value as Record<string, unknown>;
  };
  const browser = object(object(object(workflow).jobs).browser);
  const steps = browser.steps;
  if (!Array.isArray(steps)) throw new Error("Expected browser steps");
  const rows = steps.map((step: unknown) => object(step));
  const uploads = rows.filter((step) => typeof step.uses === "string" && step.uses.startsWith("actions/upload-artifact@"));
  expect(uploads).toHaveLength(1);
  expect(uploads[0]).toEqual({
    name: "Retain browser acceptance receipts",
    if: "${{ always() }}",
    uses: "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    with: {
      name: "compiled-browser-receipts-${{ github.run_attempt }}",
      path: [
        "tmp/app-browser-*/receipt.json",
        "tmp/app-browser-*/preparation-result.json",
        "tmp/browser-custody-*/supervisor-result.json",
        "tmp/browser-custody-*/fixture-terminal.json",
        "tmp/browser-custody-*/observation-*.json",
        "tmp/browser-custody-*/trigger.json",
        "tmp/browser-custody-*/expiry.json",
        "",
      ].join("\n"),
      "if-no-files-found": "warn", "include-hidden-files": false, "retention-days": 7,
    },
  });
  expect(rows.indexOf(uploads[0]!)).toBeGreaterThan(rows.findIndex((step) => step.name === "Verify compiled browser surfaces"));
});

test("the canonical browser gate enables native custody before acceptance", async () => {
  const manifest: unknown = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  if (typeof manifest !== "object" || manifest === null || !("scripts" in manifest)) throw new Error("Missing package scripts");
  const scripts = manifest.scripts;
  if (typeof scripts !== "object" || scripts === null) throw new Error("Expected package scripts");
  expect(Reflect.get(scripts, "check:browser"))
    .toBe("bun run build:app && bun run build:site && bun run test:browser:custody && bun run test:browser");
  expect(Reflect.get(scripts, "test:browser:custody"))
    .toBe("HRA_BROWSER_CUSTODY_NATIVE=1 bun test --bail=1 ./scripts/app-browser-custody.process.test.ts");
});
