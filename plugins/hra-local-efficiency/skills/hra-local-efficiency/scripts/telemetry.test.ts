import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  appendThroughputEvent,
  commandDigest,
  newThroughputEvent,
  readThroughputEvents,
  scopeDigest,
  telemetryRetentionDays,
  throughputTelemetryRoot,
  validateThroughputEvent,
  type ThroughputEvent,
} from "./telemetry";

function event(overrides: Partial<ThroughputEvent> = {}): ThroughputEvent {
  return {
    admittedAt: "2026-08-31T12:00:01.000Z",
    capacity: 4,
    capability: "compute",
    commandDigest: "a".repeat(64),
    exitCode: 0,
    finishedAt: "2026-08-31T12:00:02.000Z",
    label: "repo-check",
    mode: "heavy",
    outcome: "pass",
    permits: 2,
    program: "bun",
    queueMilliseconds: 1_000,
    queuedAt: "2026-08-31T12:00:00.000Z",
    runId: "00000000-0000-4000-8000-000000000000",
    runMilliseconds: 1_000,
    scopeDigest: "b".repeat(64),
    version: 1,
    ...overrides,
  };
}

describe("throughput telemetry", () => {
  test("validates the closed privacy-safe event schema", () => {
    expect(validateThroughputEvent(event())).toEqual(event());
    expect(() => validateThroughputEvent({ ...event(), rawCommand: "secret" }))
      .toThrow("fields");
    expect(() => validateThroughputEvent({ ...event(), label: "contains spaces" }))
      .toThrow("ASCII identifier");
    expect(() => validateThroughputEvent({ ...event(), runMilliseconds: -1 }))
      .toThrow("runMilliseconds");
  });

  test("writes one bounded private record without raw argv, cwd, or environment", () => {
    const fixture = mkdtempSync(join(tmpdir(), "hra-telemetry-private-"));
    const stateRoot = join(fixture, "host-resources-v1");
    const root = throughputTelemetryRoot(stateRoot);
    const secretCwd = join(fixture, "secret-repository-name");
    mkdirSync(secretCwd);
    const scope = scopeDigest(secretCwd);
    const prepared = {
      ...event(),
      commandDigest: commandDigest(["bun", "secret-argument-value"], scope),
      scopeDigest: scope,
    };
    const { runId: ignoredRunId, version: ignoredVersion, ...eventInput } = prepared;
    void ignoredRunId;
    void ignoredVersion;
    const value = newThroughputEvent(eventInput);
    try {
      appendThroughputEvent(root, value, new Date("2026-08-31T12:00:03.000Z"));
      const path = join(root, "events-2026-08-31.jsonl");
      const stored = readFileSync(path, "utf8");
      expect(stored).not.toContain("secret-argument-value");
      expect(stored).not.toContain(secretCwd);
      expect(stored).not.toContain("environment");
      expect(lstatSync(root).mode & 0o777).toBe(0o700);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      expect(readThroughputEvents(root, {
        days: 1,
        limit: 10,
        now: new Date("2026-08-31T12:00:04.000Z"),
      })).toHaveLength(1);
    } finally {
      rmSync(fixture, { force: true, recursive: true });
    }
  });

  test("removes only old validated owned daily files", () => {
    const fixture = mkdtempSync(join(tmpdir(), "hra-telemetry-retention-"));
    const root = join(fixture, "telemetry-v1");
    mkdirSync(root, { mode: 0o700 });
    const now = new Date("2026-08-31T12:00:00.000Z");
    const old = new Date(now.getTime() - telemetryRetentionDays * 24 * 60 * 60_000)
      .toISOString().slice(0, 10);
    const oldPath = join(root, `events-${old}.jsonl`);
    writeFileSync(oldPath, `${JSON.stringify(event())}\n`, { mode: 0o600 });
    const unrelated = join(root, "keep-me.txt");
    writeFileSync(unrelated, "user state", { mode: 0o600 });
    try {
      appendThroughputEvent(root, event(), now);
      expect(() => lstatSync(oldPath)).toThrow();
      expect(readFileSync(unrelated, "utf8")).toBe("user state");
    } finally {
      rmSync(fixture, { force: true, recursive: true });
    }
  });

  test("rejects symlinked and malformed telemetry inputs", () => {
    const fixture = mkdtempSync(join(tmpdir(), "hra-telemetry-hostile-"));
    const root = join(fixture, "telemetry-v1");
    mkdirSync(root, { mode: 0o700 });
    const target = join(fixture, "target");
    writeFileSync(target, "preserve", { mode: 0o600 });
    const path = join(root, "events-2026-08-31.jsonl");
    symlinkSync(target, path);
    try {
      expect(() => appendThroughputEvent(root, event(), new Date("2026-08-31T12:00:00Z")))
        .toThrow();
      expect(readFileSync(target, "utf8")).toBe("preserve");
      rmSync(path);
      writeFileSync(path, "not-json\n", { mode: 0o600 });
      chmodSync(path, 0o600);
      expect(() => readThroughputEvents(root, {
        days: 1,
        limit: 10,
        now: new Date("2026-08-31T12:00:00Z"),
      })).toThrow();
    } finally {
      rmSync(fixture, { force: true, recursive: true });
    }
  });

  test("keeps concurrent one-write appends parseable", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "hra-telemetry-concurrent-"));
    const root = join(fixture, "telemetry-v1");
    const moduleUrl = pathToFileURL(join(import.meta.dir, "telemetry.ts")).href;
    try {
      const children = Array.from({ length: 8 }, (_, index) => {
        const value = event({
          runId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        });
        return Bun.spawn({
          cmd: [
            process.execPath,
            "-e",
            `const telemetry = await import(${JSON.stringify(moduleUrl)}); telemetry.appendThroughputEvent(${JSON.stringify(root)}, ${JSON.stringify(value)}, new Date("2026-08-31T12:00:00Z"));`,
          ],
          stderr: "pipe",
          stdout: "pipe",
        });
      });
      const exitCodes = await Promise.all(children.map((child) => child.exited));
      expect(exitCodes).toEqual(Array.from({ length: 8 }, () => 0));
      const events = readThroughputEvents(root, {
        days: 1,
        limit: 8,
        now: new Date("2026-08-31T12:00:00Z"),
      });
      expect(events).toHaveLength(8);
      expect(new Set(events.map((value) => value.runId)).size).toBe(8);
    } finally {
      rmSync(fixture, { force: true, recursive: true });
    }
  });
});
