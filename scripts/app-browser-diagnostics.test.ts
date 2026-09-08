import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { browserDiagnosticLine, browserFailureClass, recordBrowserProfileFailure } from "./app-browser";

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
      path: "tmp/app-browser-*/receipt.json",
      "if-no-files-found": "warn", "include-hidden-files": false, "retention-days": 7,
    },
  });
  expect(rows.indexOf(uploads[0]!)).toBeGreaterThan(rows.findIndex((step) => step.name === "Verify compiled browser surfaces"));
});
