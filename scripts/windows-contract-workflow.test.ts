import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "bun:test";

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected workflow object");
  }
  return value as Record<string, unknown>;
}

test("Windows qualification stays credential-free, bounded and limited to portable contracts", async () => {
  const workflow = record(Bun.YAML.parse(await readFile(
    join(import.meta.dir, "..", ".github", "workflows", "windows-contracts.yml"), "utf8",
  )));
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.on).toEqual({ pull_request: null, push: { branches: ["main"] } });
  expect(workflow.env).toBeUndefined();
  const jobs = record(workflow.jobs);
  expect(Object.keys(jobs)).toEqual(["portable-contracts"]);
  const job = record(jobs["portable-contracts"]);
  expect(job["runs-on"]).toBe("windows-2025");
  expect(job["timeout-minutes"]).toBe(15);
  expect(job.defaults).toEqual({ run: { shell: "pwsh" } });
  for (const key of ["if", "environment", "permissions", "env", "continue-on-error", "services", "container"]) {
    expect(job[key]).toBeUndefined();
  }
  if (!Array.isArray(job.steps)) throw new TypeError("Expected steps");
  const steps = job.steps.map(record);
  expect(steps).toHaveLength(5);
  for (const step of steps) {
    for (const key of Object.keys(step)) expect(["name", "uses", "with", "run"]).toContain(key);
  }
  expect(steps.filter((step) => step.uses !== undefined).map(({ uses, with: inputs }) => ({ uses, inputs })))
    .toEqual([
      { uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", inputs: {
        ref: "${{ github.sha }}", "fetch-depth": 1, "fetch-tags": false, "persist-credentials": false,
      } },
      { uses: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6", inputs: { "bun-version-file": ".bun-version" } },
    ]);
  expect(steps.filter((step) => step.run !== undefined).map((step) => step.run)).toEqual([
    "bun --no-env-file -e \"if (process.platform !== 'win32' || process.arch !== 'x64' || Bun.version !== '1.3.14') process.exit(1); console.log('Windows x64 / Bun ' + Bun.version);\"",
    "bun install --frozen-lockfile --ignore-scripts",
    "bun test ./scripts/owned-controller/protocol.test.ts ./scripts/claude-auth-help.test.ts --isolate --max-concurrency=1",
  ]);
  expect((await readFile(join(import.meta.dir, "..", ".bun-version"), "utf8")).trim()).toBe("1.3.14");
});
