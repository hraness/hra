import { describe, expect, test } from "bun:test";
import { createCoverageCatalogSnapshot } from "@hraness/direct/core";
import { parseDefinitionCoverageSnapshot } from "@hraness/direct/testing";

import {
  canAutomaticallyStartServer,
  coveragePolicyViolations,
  directServerCommand,
  externalOrFailedRequests,
  parseArguments,
  remainingScripts,
} from "./verify-browser";
import { agentTasksDirectDefinition } from "./scenarios";

const authoredCoverage = createCoverageCatalogSnapshot(agentTasksDirectDefinition.coverage);

function bindCoverageSnapshot(input: unknown) {
  return parseDefinitionCoverageSnapshot(input, agentTasksDirectDefinition);
}

describe("Agent Tasks browser verification policy", () => {
  test("parses default, explicit, and help arguments", () => {
    expect(parseArguments([])).toEqual({ kind: "run", baseUrl: "http://127.0.0.1:5176" });
    expect(parseArguments(["--base-url", "http://localhost:7777/"])).toEqual({
      kind: "run",
      baseUrl: "http://localhost:7777",
    });
    expect(parseArguments(["--help"])).toEqual({ kind: "help" });
  });

  test("starts servers only for local HTTP origins", () => {
    expect(canAutomaticallyStartServer("http://127.0.0.1:5176")).toBe(true);
    expect(canAutomaticallyStartServer("http://localhost:5176")).toBe(true);
    expect(canAutomaticallyStartServer("https://agent-tasks.example")).toBe(false);
  });

  test("owns the Vite listener directly instead of a package-script wrapper", () => {
    expect(directServerCommand("/repo/apps/web", "5176")).toEqual([
      "/repo/apps/web/node_modules/.bin/vite",
      "--config",
      "direct/vite.config.ts",
      "--port",
      "5176",
    ]);
  });

  test("rejects external, failed, and mutating browser requests", () => {
    const requests = [
      { method: "GET", status: 200, url: "http://127.0.0.1:5176/main.tsx" },
      { method: "POST", status: 200, url: "http://127.0.0.1:5176/api" },
      { method: "GET", status: 500, url: "http://127.0.0.1:5176/broken" },
      { method: "GET", status: 200, url: "https://example.convex.cloud/api/query" },
      { method: "GET", status: 200, url: "http://127.0.0.1:5176/api/tasks" },
    ];
    expect(externalOrFailedRequests(requests, "http://127.0.0.1:5176")).toEqual(requests.slice(1));
  });

  test("counts command and page scripts", () => {
    expect(remainingScripts({
      schema: "direct.probe/v1",
      activationHash: "fnv1a-64:0000000000000000",
      generation: 1,
      revision: 0,
      activity: { active: 0, started: 0, settled: 0 },
      pending: {},
      violations: {},
      remainingWork: { disposed: false, scripts: { commands: 2, interactions: 3, pages: 1 } },
      isQuiescent: true,
    })).toBe(6);
  });

  test("keeps direct evidence detached and fixture evidence scoped to known scenarios", () => {
    const known = new Set(["runner-ready"]);
    expect(coveragePolicyViolations([
      { claim: "Fixture UI", key: "fixture", mode: "fixture", scenarios: ["runner-ready"] },
      { claim: "Provider law", key: "direct", mode: "direct", scenarios: [] },
    ], known, known)).toEqual([]);
    expect(coveragePolicyViolations([
      { claim: "Bad direct", key: "direct-scenarios", mode: "direct", scenarios: ["runner-ready"] },
      { claim: "Missing scenario", key: "mixed-empty", mode: "mixed", scenarios: [] },
      { claim: "Unknown", key: "unknown", mode: "fixture", scenarios: ["runner-missing"] },
    ], known, new Set())).toEqual([
      "direct-scenarios: direct evidence must not cite fixture scenarios",
      "mixed-empty: mixed evidence requires a scenario",
      "unknown: unknown scenario runner-missing",
    ]);
  });

  test("rejects a browser coverage snapshot with a deleted authored claim", () => {
    const received = bindCoverageSnapshot({
      ...authoredCoverage,
      entries: authoredCoverage.entries.slice(1),
    });
    expect(received).toMatchObject({ ok: false, error: { code: "coverage-mismatch" } });
  });

  test("rejects browser coverage mode drift", () => {
    const first = authoredCoverage.entries[0];
    if (first === undefined) throw new Error("Authored coverage is unexpectedly empty.");
    const received = bindCoverageSnapshot({
      ...authoredCoverage,
      entries: [
        { ...first, mode: first.mode === "fixture" ? "mixed" : "fixture" },
        ...authoredCoverage.entries.slice(1),
      ],
    });

    expect(received).toMatchObject({ ok: false, error: { code: "coverage-mismatch" } });
  });

  test("rejects browser coverage claim drift", () => {
    const first = authoredCoverage.entries[0];
    if (first === undefined) throw new Error("Authored coverage is unexpectedly empty.");
    const received = bindCoverageSnapshot({
      ...authoredCoverage,
      entries: [
        { ...first, claim: `${first.claim} (drifted)` },
        ...authoredCoverage.entries.slice(1),
      ],
    });

    expect(received).toMatchObject({ ok: false, error: { code: "coverage-mismatch" } });
  });
});
