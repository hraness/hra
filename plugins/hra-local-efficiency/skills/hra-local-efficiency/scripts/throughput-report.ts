#!/usr/bin/env bun

import { isAbsolute, resolve } from "node:path";

import { resolveHostResourceStateRoot } from "./host-run";
import {
  readThroughputEvents,
  throughputTelemetryRoot,
  type ThroughputEvent,
} from "./telemetry";

type ThroughputOptions = {
  readonly days: number;
  readonly json: boolean;
  readonly limit: number;
  readonly stateRoot: string;
};

type DurationSummary = {
  readonly count: number;
  readonly maximum: number;
  readonly p50: number;
  readonly p95: number;
  readonly total: number;
};

type Breakdown = {
  readonly capability: ThroughputEvent["capability"];
  readonly count: number;
  readonly failures: number;
  readonly mode: ThroughputEvent["mode"];
  readonly queueMilliseconds: DurationSummary;
  readonly runMilliseconds: DurationSummary;
};

type ThroughputReport = {
  readonly breakdown: readonly Breakdown[];
  readonly days: number;
  readonly eventCount: number;
  readonly generatedAt: string;
  readonly maxConcurrentRuns: number;
  readonly outcomes: Readonly<Record<ThroughputEvent["outcome"], number>>;
  readonly permitWeightedRunMilliseconds: number;
  readonly queueMilliseconds: DurationSummary;
  readonly repeatedCommands: readonly {
    readonly commandDigest: string;
    readonly count: number;
    readonly runMilliseconds: number;
    readonly scopeDigest: string;
  }[];
  readonly repeatInterpretation: "review-heuristic-not-proof-of-waste";
  readonly runMilliseconds: DurationSummary;
  readonly statusAuthority: "scheduler-telemetry-only";
  readonly version: 1;
};

export function parseThroughputArguments(
  arguments_: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): ThroughputOptions {
  let days = 7;
  let json = false;
  let limit = 10_000;
  let stateRoot = resolveHostResourceStateRoot(environment);
  let stateRootSupplied = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--json") json = true;
    else if (argument?.startsWith("--days=")) days = Number(argument.slice("--days=".length));
    else if (argument?.startsWith("--limit=")) limit = Number(argument.slice("--limit=".length));
    else if (argument === "--state-root") {
      if (stateRootSupplied) throw new Error("--state-root may appear only once");
      const value = arguments_[index + 1];
      if (value === undefined || !isAbsolute(value)) {
        throw new Error("--state-root requires an absolute path");
      }
      stateRoot = resolve(value);
      stateRootSupplied = true;
      index += 1;
    } else throw new Error(`unknown throughput-report argument: ${argument}`);
  }
  if (!Number.isSafeInteger(days) || days < 1 || days > 90) {
    throw new Error("--days must be an integer from 1 through 90");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50_000) {
    throw new Error("--limit must be an integer from 1 through 50000");
  }
  return { days, json, limit, stateRoot };
}

function quantile(sorted: readonly number[], percentile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.ceil(sorted.length * percentile) - 1);
  return sorted[index] ?? 0;
}

export function summarizeDurations(values: readonly number[]): DurationSummary {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    maximum: sorted.at(-1) ?? 0,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    total: sorted.reduce((sum, value) => sum + value, 0),
  };
}

function maximumConcurrency(events: readonly ThroughputEvent[]): number {
  const boundaries: { readonly delta: -1 | 1; readonly time: number }[] = [];
  for (const event of events) {
    if (event.admittedAt === null || event.runMilliseconds === null) continue;
    boundaries.push({ delta: 1, time: Date.parse(event.admittedAt) });
    boundaries.push({ delta: -1, time: Date.parse(event.finishedAt) });
  }
  boundaries.sort((left, right) => left.time - right.time || left.delta - right.delta);
  let active = 0;
  let maximum = 0;
  for (const boundary of boundaries) {
    active += boundary.delta;
    maximum = Math.max(maximum, active);
  }
  return maximum;
}

export function buildThroughputReport(
  events: readonly ThroughputEvent[],
  days: number,
  now = new Date(),
): ThroughputReport {
  const outcomes: Record<ThroughputEvent["outcome"], number> = {
    canceled: 0,
    fail: 0,
    pass: 0,
    "scheduler-error": 0,
    "spawn-error": 0,
  };
  const buckets = new Map<string, ThroughputEvent[]>();
  const repeats = new Map<string, ThroughputEvent[]>();
  for (const event of events) {
    outcomes[event.outcome] += 1;
    const bucket = `${event.capability}\u0000${event.mode}`;
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), event]);
    const repeat = `${event.scopeDigest}\u0000${event.commandDigest}`;
    repeats.set(repeat, [...(repeats.get(repeat) ?? []), event]);
  }
  const breakdown = [...buckets.values()].map((bucket): Breakdown => {
    const first = bucket[0];
    if (first === undefined) throw new Error("empty throughput bucket");
    return {
      capability: first.capability,
      count: bucket.length,
      failures: bucket.filter((event) => event.outcome !== "pass").length,
      mode: first.mode,
      queueMilliseconds: summarizeDurations(bucket.map((event) => event.queueMilliseconds)),
      runMilliseconds: summarizeDurations(
        bucket.flatMap((event) => event.runMilliseconds === null ? [] : [event.runMilliseconds]),
      ),
    };
  }).sort((left, right) => (
    left.capability.localeCompare(right.capability) || left.mode.localeCompare(right.mode)
  ));
  const repeatedCommands = [...repeats.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      commandDigest: group[0]?.commandDigest ?? "",
      count: group.length,
      runMilliseconds: group.reduce((sum, event) => sum + (event.runMilliseconds ?? 0), 0),
      scopeDigest: group[0]?.scopeDigest ?? "",
    }))
    .sort((left, right) => right.runMilliseconds - left.runMilliseconds || right.count - left.count)
    .slice(0, 100);
  const runDurations = events.flatMap(
    (event) => event.runMilliseconds === null ? [] : [event.runMilliseconds],
  );
  return {
    breakdown,
    days,
    eventCount: events.length,
    generatedAt: now.toISOString(),
    maxConcurrentRuns: maximumConcurrency(events),
    outcomes,
    permitWeightedRunMilliseconds: events.reduce(
      (sum, event) => sum + (event.runMilliseconds ?? 0) * event.permits,
      0,
    ),
    queueMilliseconds: summarizeDurations(events.map((event) => event.queueMilliseconds)),
    repeatedCommands,
    repeatInterpretation: "review-heuristic-not-proof-of-waste",
    runMilliseconds: summarizeDurations(runDurations),
    statusAuthority: "scheduler-telemetry-only",
    version: 1,
  };
}

function seconds(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}

export function printThroughputReport(report: ThroughputReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(
    `THROUGHPUT\tevents=${report.eventCount}\tdays=${report.days}`
    + `\tpass=${report.outcomes.pass}\tfail=${report.outcomes.fail}`
    + `\tcanceled=${report.outcomes.canceled}`
    + `\tqueue-p95=${seconds(report.queueMilliseconds.p95)}`
    + `\trun-p95=${seconds(report.runMilliseconds.p95)}`
    + `\tmax-concurrent=${report.maxConcurrentRuns}`,
  );
  for (const row of report.breakdown) {
    console.log(
      `LANE\t${row.capability}\t${row.mode}\tcount=${row.count}`
      + `\tfailures=${row.failures}\tqueue-p95=${seconds(row.queueMilliseconds.p95)}`
      + `\trun-p95=${seconds(row.runMilliseconds.p95)}`,
    );
  }
  for (const repeated of report.repeatedCommands.slice(0, 20)) {
    console.log(
      `REPEAT-REVIEW\tcount=${repeated.count}\trun=${seconds(repeated.runMilliseconds)}`
      + `\tscope=${repeated.scopeDigest.slice(0, 16)}`
      + `\tcommand=${repeated.commandDigest.slice(0, 16)}`,
    );
  }
  console.log("NOTE\tRepeated command digests are review heuristics, not proof of waste.");
  console.log("NOTE\tThis report covers scheduled local commands only; silence is not task status.");
}

if (import.meta.main) {
  try {
    const options = parseThroughputArguments(process.argv.slice(2));
    const events = readThroughputEvents(throughputTelemetryRoot(options.stateRoot), {
      days: options.days,
      limit: options.limit,
    });
    printThroughputReport(buildThroughputReport(events, options.days), options.json);
  } catch (error: unknown) {
    console.error(`[hra-throughput-report] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
