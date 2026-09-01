import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fileConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { command, requireOperationLabel, sha256 } from "./shared";
import type { CapabilityLane, ResourceMode } from "./host-run";

export type ThroughputOutcome = "fail" | "pass" | "scheduler-error" | "spawn-error";

export type ThroughputEvent = {
  readonly admittedAt: string | null;
  readonly capacity: number;
  readonly capability: CapabilityLane;
  readonly commandDigest: string;
  readonly exitCode: number | null;
  readonly finishedAt: string;
  readonly label: string;
  readonly mode: ResourceMode;
  readonly outcome: ThroughputOutcome;
  readonly permits: number;
  readonly program: string;
  readonly queueMilliseconds: number;
  readonly queuedAt: string;
  readonly runId: string;
  readonly runMilliseconds: number | null;
  readonly scopeDigest: string;
  readonly version: 1;
};

export const telemetryDailyMaximumBytes = 4 * 1024 * 1024;
export const telemetryMaximumRecordBytes = 2 * 1024;
export const telemetryRetentionDays = 14;
const telemetryReadRaceAllowanceBytes = 32 * 1024;
const telemetryDirectoryMaximumEntries = 64;
const eventName = /^events-(\d{4})-(\d{2})-(\d{2})\.jsonl$/u;

function ownerMatches(uid: number): boolean {
  return process.getuid === undefined || process.getuid() === uid;
}

function requirePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || !ownerMatches(metadata.uid)
    || (metadata.mode & 0o777) !== 0o700
  ) throw new Error("throughput telemetry directory is not a private owned directory");
}

function openPrivateAppendFile(path: string): number {
  const noFollow = fileConstants.O_NOFOLLOW;
  const descriptor = openSync(
    path,
    fileConstants.O_APPEND | fileConstants.O_CREAT | fileConstants.O_WRONLY | noFollow,
    0o600,
  );
  try {
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile()
      || metadata.nlink !== 1
      || !ownerMatches(metadata.uid)
      || (metadata.mode & 0o777) !== 0o600
    ) throw new Error("throughput telemetry file is not a private owned regular file");
    return descriptor;
  } catch (error: unknown) {
    closeSync(descriptor);
    throw error;
  }
}

function utcDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function isOwnedDailyFile(path: string): boolean {
  try {
    const metadata = lstatSync(path);
    return metadata.isFile()
      && !metadata.isSymbolicLink()
      && metadata.nlink === 1
      && ownerMatches(metadata.uid)
      && (metadata.mode & 0o777) === 0o600;
  } catch {
    return false;
  }
}

export function throughputTelemetryRoot(stateRoot: string): string {
  return join(resolve(stateRoot, ".."), "telemetry-v1");
}

export function scopeDigest(cwd: string): string {
  const common = command([
    "git",
    "-C",
    cwd,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  return sha256(common.exitCode === 0 && common.stdout !== "" ? common.stdout : resolve(cwd));
}

export function commandDigest(command_: readonly string[], scope: string): string {
  return sha256(JSON.stringify({ command: command_, scope }));
}

export function newThroughputEvent(input: Omit<ThroughputEvent, "runId" | "version">): ThroughputEvent {
  return { ...input, runId: randomUUID(), version: 1 };
}

export function validateThroughputEvent(value: unknown): ThroughputEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("throughput event must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = [
    "admittedAt",
    "capacity",
    "capability",
    "commandDigest",
    "exitCode",
    "finishedAt",
    "label",
    "mode",
    "outcome",
    "permits",
    "program",
    "queueMilliseconds",
    "queuedAt",
    "runId",
    "runMilliseconds",
    "scopeDigest",
    "version",
  ];
  if (
    Object.keys(record).length !== keys.length
    || keys.some((key) => !(key in record))
  ) throw new Error("throughput event fields are invalid");
  if (record.version !== 1) throw new Error("throughput event version is invalid");
  if (
    record.capability !== "compute"
    && record.capability !== "browser-auth"
    && record.capability !== "mac-native"
  ) throw new Error("throughput event capability is invalid");
  if (record.mode !== "shared" && record.mode !== "heavy" && record.mode !== "exclusive") {
    throw new Error("throughput event mode is invalid");
  }
  if (
    record.outcome !== "pass"
    && record.outcome !== "fail"
    && record.outcome !== "spawn-error"
    && record.outcome !== "scheduler-error"
  ) throw new Error("throughput event outcome is invalid");
  if (typeof record.label !== "string" || typeof record.program !== "string") {
    throw new Error("throughput event labels are invalid");
  }
  requireOperationLabel(record.label, "event label");
  requireOperationLabel(record.program, "event program");
  if (
    typeof record.runId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(record.runId)
  ) throw new Error("throughput event run ID is invalid");
  for (const key of ["commandDigest", "scopeDigest"] as const) {
    if (typeof record[key] !== "string" || !/^[0-9a-f]{64}$/u.test(record[key])) {
      throw new Error(`throughput event ${key} is invalid`);
    }
  }
  for (const key of ["queuedAt", "finishedAt"] as const) {
    if (typeof record[key] !== "string" || !Number.isFinite(Date.parse(record[key]))) {
      throw new Error(`throughput event ${key} is invalid`);
    }
  }
  if (
    record.admittedAt !== null
    && (typeof record.admittedAt !== "string" || !Number.isFinite(Date.parse(record.admittedAt)))
  ) throw new Error("throughput event admittedAt is invalid");
  for (const key of ["capacity", "permits", "queueMilliseconds"] as const) {
    if (!Number.isSafeInteger(record[key]) || Number(record[key]) < 0) {
      throw new Error(`throughput event ${key} is invalid`);
    }
  }
  const runMilliseconds = record.runMilliseconds;
  if (
    runMilliseconds !== null
    && (typeof runMilliseconds !== "number" || !Number.isSafeInteger(runMilliseconds) || runMilliseconds < 0)
  ) throw new Error("throughput event runMilliseconds is invalid");
  const exitCode = record.exitCode;
  if (
    exitCode !== null
    && (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255)
  ) throw new Error("throughput event exitCode is invalid");
  return value as ThroughputEvent;
}

export function retainRecentTelemetry(root: string, now = new Date()): void {
  const entries = readdirSync(root, { withFileTypes: true });
  if (entries.length > telemetryDirectoryMaximumEntries) {
    throw new Error("throughput telemetry directory entry bound exceeded");
  }
  const cutoff = new Date(now.getTime() - telemetryRetentionDays * 24 * 60 * 60_000);
  const cutoffDay = utcDay(cutoff);
  for (const entry of entries) {
    const match = eventName.exec(entry.name);
    if (match === null || !entry.isFile() || entry.name.slice(7, 17) > cutoffDay) continue;
    const path = join(root, entry.name);
    if (isOwnedDailyFile(path)) unlinkSync(path);
  }
}

export function appendThroughputEvent(
  root: string,
  event: ThroughputEvent,
  now = new Date(),
): void {
  validateThroughputEvent(event);
  requirePrivateDirectory(root);
  retainRecentTelemetry(root, now);
  const encoded = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
  if (encoded.byteLength > telemetryMaximumRecordBytes) {
    throw new Error("throughput telemetry record bound exceeded");
  }
  const path = join(root, `events-${utcDay(now)}.jsonl`);
  const descriptor = openPrivateAppendFile(path);
  try {
    const metadata = fstatSync(descriptor);
    if (metadata.size + encoded.byteLength > telemetryDailyMaximumBytes) {
      throw new Error("throughput telemetry daily bound reached");
    }
    const written = writeSync(descriptor, encoded);
    if (written !== encoded.byteLength) {
      throw new Error("throughput telemetry append was incomplete");
    }
  } finally {
    closeSync(descriptor);
  }
}

export function readThroughputEvents(
  root: string,
  options: { readonly days: number; readonly limit: number; readonly now?: Date },
): ThroughputEvent[] {
  const now = options.now ?? new Date();
  const cutoff = now.getTime() - options.days * 24 * 60 * 60_000;
  const entries = (() => {
    try {
      return readdirSync(root, { encoding: "utf8", withFileTypes: true });
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  })();
  if (entries.length > telemetryDirectoryMaximumEntries) {
    throw new Error("throughput telemetry directory entry bound exceeded");
  }
  const events: ThroughputEvent[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (eventName.exec(entry.name) === null || !entry.isFile()) continue;
    const path = join(root, entry.name);
    if (!isOwnedDailyFile(path)) throw new Error("throughput telemetry input is not private");
    const metadata = lstatSync(path);
    if (metadata.size > telemetryDailyMaximumBytes + telemetryReadRaceAllowanceBytes) {
      throw new Error("throughput telemetry input bound exceeded");
    }
    const text = readFileSync(path, "utf8");
    for (const line of text.split("\n")) {
      if (line === "") continue;
      if (Buffer.byteLength(line, "utf8") + 1 > telemetryMaximumRecordBytes) {
        throw new Error("throughput telemetry line bound exceeded");
      }
      const event = validateThroughputEvent(JSON.parse(line) as unknown);
      if (Date.parse(event.finishedAt) >= cutoff) events.push(event);
      if (events.length > options.limit) {
        throw new Error("throughput telemetry result limit exceeded");
      }
    }
  }
  return events;
}
