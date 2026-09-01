import { describe, expect, test } from "bun:test";

import {
  buildThroughputReport,
  parseThroughputArguments,
  summarizeDurations,
} from "./throughput-report";
import type { ThroughputEvent } from "./telemetry";

function event(overrides: Partial<ThroughputEvent> = {}): ThroughputEvent {
  return {
    admittedAt: "2026-08-31T12:00:01.000Z",
    capacity: 4,
    capability: "compute",
    commandDigest: "a".repeat(64),
    exitCode: 0,
    finishedAt: "2026-08-31T12:00:03.000Z",
    label: "repo-check",
    mode: "heavy",
    outcome: "pass",
    permits: 2,
    program: "bun",
    queueMilliseconds: 1_000,
    queuedAt: "2026-08-31T12:00:00.000Z",
    runId: "00000000-0000-4000-8000-000000000000",
    runMilliseconds: 2_000,
    scopeDigest: "b".repeat(64),
    version: 1,
    ...overrides,
  };
}

describe("throughput report", () => {
  test("bounds its window and result size", () => {
    expect(parseThroughputArguments([], {})).toMatchObject({ days: 7, limit: 10_000 });
    expect(() => parseThroughputArguments(["--days=0"], {})).toThrow("1 through 90");
    expect(() => parseThroughputArguments(["--limit=50001"], {})).toThrow("50000");
    expect(() => parseThroughputArguments(["--state-root", "relative"], {})).toThrow("absolute");
  });

  test("computes deterministic percentiles", () => {
    expect(summarizeDurations([50, 10, 40, 20, 30])).toEqual({
      count: 5,
      maximum: 50,
      p50: 30,
      p95: 50,
      total: 150,
    });
    expect(summarizeDurations([])).toEqual({ count: 0, maximum: 0, p50: 0, p95: 0, total: 0 });
  });

  test("aggregates queue, run, failures, permits, concurrency, and repeat heuristics", () => {
    const report = buildThroughputReport([
      event(),
      event({
        admittedAt: "2026-08-31T12:00:02.000Z",
        exitCode: 1,
        finishedAt: "2026-08-31T12:00:05.000Z",
        outcome: "fail",
        queueMilliseconds: 2_000,
        runId: "00000000-0000-4000-8000-000000000001",
        runMilliseconds: 3_000,
      }),
      event({
        admittedAt: null,
        capability: "browser-auth",
        commandDigest: "c".repeat(64),
        exitCode: null,
        finishedAt: "2026-08-31T12:00:04.000Z",
        mode: "shared",
        outcome: "scheduler-error",
        permits: 1,
        queueMilliseconds: 4_000,
        runId: "00000000-0000-4000-8000-000000000002",
        runMilliseconds: null,
      }),
    ], 7, new Date("2026-08-31T13:00:00.000Z"));

    expect(report).toMatchObject({
      eventCount: 3,
      maxConcurrentRuns: 2,
      outcomes: { canceled: 0, fail: 1, pass: 1, "scheduler-error": 1, "spawn-error": 0 },
      permitWeightedRunMilliseconds: 10_000,
      repeatInterpretation: "review-heuristic-not-proof-of-waste",
      statusAuthority: "scheduler-telemetry-only",
    });
    expect(report.queueMilliseconds).toMatchObject({ p50: 2_000, p95: 4_000, total: 7_000 });
    expect(report.runMilliseconds).toMatchObject({ p50: 2_000, p95: 3_000, total: 5_000 });
    expect(report.repeatedCommands).toEqual([{
      commandDigest: "a".repeat(64),
      count: 2,
      runMilliseconds: 5_000,
      scopeDigest: "b".repeat(64),
    }]);
  });
});
