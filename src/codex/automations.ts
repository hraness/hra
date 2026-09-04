// Codex Desktop calls its scheduled tasks "automations". They are not on the
// app-server RPC surface at all (see `kb/notes/codex-schedules.md`); the source
// of truth is one directory per automation under
// `<codexHome>/automations/<id>/automation.toml`, where `<codexHome>` defaults
// to `~/.codex`.
//
// This reader is READ-ONLY. It never writes, creates, or deletes anything, and
// it never opens the Desktop SQLite caches (`sqlite/codex-dev.db` and friends),
// whose file names and columns shift between Desktop builds.
//
// It is also deliberately narrow: the automation `prompt`, its `cwds`, and
// every other filesystem-shaped value are never read, logged, or returned. The
// two free-text fields that do reach a projection - `label` and `cadence` - are
// refused outright when they carry an absolute path or a control scalar,
// because these values are projected to the cloud.
//
// Every failure is tolerated. Codex adds TOML keys across builds, so unknown
// keys are ignored, and one unreadable or malformed directory yields a
// diagnostic instead of failing the whole scan.

import { open, readdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { containsAbsolutePath, containsUnsafeTerminalScalar } from "../domain/text-safety";

export type CodexAutomation = Readonly<{
  /** Raw RFC 5545 RRULE, passed through unparsed, `RRULE:` prefix stripped. */
  cadence: string;
  id: string;
  /** Raw `kind` string. Only `heartbeat` has been observed; others are kept verbatim. */
  kind: string;
  label: string;
  status: "active" | "paused";
  targetThreadId: string | null;
  /** `updated_at` in epoch ms when it is a safe non-negative integer. */
  updatedAt: number | null;
}>;

export type CodexAutomationDiagnostic = Readonly<{
  automationId: string;
  reason: "unreadable" | "invalid_toml" | "invalid_fields";
}>;

export type CodexAutomationScan = Readonly<{
  automations: readonly CodexAutomation[];
  diagnostics: readonly CodexAutomationDiagnostic[];
}>;

export type ReadCodexAutomationsInput = Readonly<{
  automationsDirectory?: string;
  limit?: number;
}>;

/** Every bound is fixed here; nothing in this module reads an unbounded value. */
const MAX_AUTOMATION_FILE_BYTES = 64 * 1_024;
const MAX_ID_LENGTH = 200;
const MAX_KIND_LENGTH = 200;
const MAX_NAME_LENGTH = 200;
const MAX_RRULE_LENGTH = 512;
const MAX_TARGET_THREAD_ID_LENGTH = 200;
const MAX_AUTOMATION_DIRECTORIES = 200;
const DEFAULT_AUTOMATION_LIMIT = 200;

const AUTOMATION_FILE_NAME = "automation.toml";
const RRULE_PREFIX = "RRULE:";

/** Mirrors the control scalars refused by `containsUnsafeTerminalScalar`. */
const unsafeScalarPattern = /[\p{Cc}\p{Cf}\p{Cs}]/gu;

const EMPTY_SCAN: CodexAutomationScan = Object.freeze({
  automations: Object.freeze([]),
  diagnostics: Object.freeze([]),
});

type AutomationParseOutcome =
  | Readonly<{ ok: true; automation: CodexAutomation }>
  | Readonly<{ ok: false; reason: "invalid_toml" | "invalid_fields" }>;

const INVALID_TOML: AutomationParseOutcome = Object.freeze({
  ok: false,
  reason: "invalid_toml",
} as const);

const INVALID_FIELDS: AutomationParseOutcome = Object.freeze({
  ok: false,
  reason: "invalid_fields",
} as const);

/**
 * Parse one `automation.toml` body. Returns `null` for malformed TOML and for
 * any value that fails a bound or a safety check; the caller decides whether
 * that is worth a diagnostic. `fallbackId` is the automation directory name,
 * used when the file omits `id`.
 */
export function parseCodexAutomationToml(
  text: string,
  fallbackId: string,
): CodexAutomation | null {
  const outcome = parseAutomationDocument(text, fallbackId);
  return outcome.ok ? outcome.automation : null;
}

/**
 * Scan `<codexHome>/automations` for automations. Never throws for
 * filesystem or content reasons: a missing directory is an empty scan (Codex
 * Desktop may not be installed), and a bad automation directory becomes one
 * diagnostic.
 */
export async function readCodexAutomations(
  input: ReadCodexAutomationsInput = {},
): Promise<CodexAutomationScan> {
  const directory = input.automationsDirectory ?? defaultAutomationsDirectory();
  const limit = boundedLimit(input.limit);
  if (limit === 0) return EMPTY_SCAN;

  let entries: readonly string[];
  try {
    // A directory that cannot be listed at all carries no automation identity,
    // so there is nothing to attribute a diagnostic to: report an empty scan.
    const listed = await readdir(directory, { withFileTypes: true });
    entries = listed
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return EMPTY_SCAN;
  }

  const names = [...entries].sort().slice(0, limit);
  const automations: CodexAutomation[] = [];
  const diagnostics: CodexAutomationDiagnostic[] = [];

  for (const name of names) {
    const read = await readBoundedText(join(directory, name, AUTOMATION_FILE_NAME));
    if (!read.ok) {
      // A directory without `automation.toml` is not an automation at all
      // (Codex keeps other state beside them), so it is skipped silently.
      if (read.missing) continue;
      diagnostics.push(diagnostic(name, "unreadable"));
      continue;
    }
    const outcome = parseAutomationDocument(read.text, name);
    if (outcome.ok) automations.push(outcome.automation);
    else diagnostics.push(diagnostic(name, outcome.reason));
  }

  return Object.freeze({
    automations: Object.freeze(automations),
    diagnostics: Object.freeze(diagnostics),
  });
}

function defaultAutomationsDirectory(): string {
  return join(homedir(), ".codex", "automations");
}

function parseAutomationDocument(text: string, fallbackId: string): AutomationParseOutcome {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch {
    return INVALID_TOML;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return INVALID_TOML;
  // Unknown keys are ignored on purpose: Codex adds fields across builds, and
  // `prompt`/`cwds` are never read even though they sit in the same table.
  const document = parsed as Record<string, unknown>;

  const rawId = document.id;
  const id = safeField(rawId === undefined || rawId === null ? fallbackId : rawId, MAX_ID_LENGTH);
  if (id === null || id.length === 0) return INVALID_FIELDS;

  const kind = safeField(document.kind, MAX_KIND_LENGTH);
  if (kind === null || kind.length === 0) return INVALID_FIELDS;

  const rawName = document.name;
  let label = id;
  if (rawName !== undefined && rawName !== null) {
    // A name carrying a local path is refused rather than redacted: this label
    // is projected to the cloud, and a silent redaction hides the drift.
    const name = safeField(rawName, MAX_NAME_LENGTH);
    if (name === null) return INVALID_FIELDS;
    if (name.length > 0) label = name;
  }

  // Status: an absent (or blank) `status` means the file predates the field or
  // the writer left it out, and every observed automation without an explicit
  // PAUSED is running, so missing defaults to "active". An unrecognised
  // non-empty status is drift in a field that decides whether a schedule is
  // live, so it is refused as `invalid_fields` rather than guessed either way.
  const rawStatus = document.status;
  let status: "active" | "paused" = "active";
  if (rawStatus !== undefined && rawStatus !== null) {
    if (typeof rawStatus !== "string") return INVALID_FIELDS;
    const normalised = rawStatus.trim().toUpperCase();
    if (normalised === "PAUSED") status = "paused";
    else if (normalised !== "" && normalised !== "ACTIVE") return INVALID_FIELDS;
  }

  const rawRrule = document.rrule;
  let cadence = "";
  if (rawRrule !== undefined && rawRrule !== null) {
    const rrule = safeField(rawRrule, MAX_RRULE_LENGTH);
    if (rrule === null) return INVALID_FIELDS;
    // Only three RRULE shapes have been observed and the grammar is not
    // parsed here: the remainder is passed through verbatim.
    cadence = rrule.toUpperCase().startsWith(RRULE_PREFIX)
      ? rrule.slice(RRULE_PREFIX.length)
      : rrule;
  }

  const rawTarget = document.target_thread_id;
  let targetThreadId: string | null = null;
  if (rawTarget !== undefined && rawTarget !== null) {
    const target = safeField(rawTarget, MAX_TARGET_THREAD_ID_LENGTH);
    if (target === null) return INVALID_FIELDS;
    if (target.length > 0) targetThreadId = target;
  }

  const rawUpdatedAt = document.updated_at;
  const updatedAt =
    typeof rawUpdatedAt === "number" &&
    Number.isSafeInteger(rawUpdatedAt) &&
    rawUpdatedAt >= 0
      ? rawUpdatedAt
      : null;

  return Object.freeze({
    ok: true,
    automation: Object.freeze({
      cadence,
      id,
      kind,
      label,
      status,
      targetThreadId,
      updatedAt,
    }),
  } as const);
}

/**
 * A string field that is within its bound and carries neither a control scalar
 * nor an absolute path. Returns `null` when the value is not usable; an
 * over-long value is invalid, never truncated.
 */
function safeField(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  if (value.length > max) return null;
  if (containsUnsafeTerminalScalar(value)) return null;
  if (containsAbsolutePath(value)) return null;
  return value.trim();
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_AUTOMATION_LIMIT;
  const floored = Math.floor(limit);
  if (floored <= 0) return 0;
  return Math.min(floored, MAX_AUTOMATION_DIRECTORIES);
}

function diagnostic(
  directoryName: string,
  reason: CodexAutomationDiagnostic["reason"],
): CodexAutomationDiagnostic {
  return Object.freeze({
    automationId: directoryName.slice(0, MAX_ID_LENGTH).replace(unsafeScalarPattern, ""),
    reason,
  });
}

type BoundedRead =
  | Readonly<{ ok: true; text: string }>
  | Readonly<{ ok: false; missing: boolean }>;

const MISSING_FILE: BoundedRead = Object.freeze({ ok: false, missing: true } as const);
const UNREADABLE_FILE: BoundedRead = Object.freeze({ ok: false, missing: false } as const);

/** Read at most `MAX_AUTOMATION_FILE_BYTES`; a larger file is unreadable. */
async function readBoundedText(path: string): Promise<BoundedRead> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    const code = fileSystemErrorCode(error);
    return code === "ENOENT" || code === "ENOTDIR" ? MISSING_FILE : UNREADABLE_FILE;
  }
  try {
    const buffer = new Uint8Array(MAX_AUTOMATION_FILE_BYTES + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > MAX_AUTOMATION_FILE_BYTES) return UNREADABLE_FILE;
    return Object.freeze({
      ok: true,
      text: new TextDecoder().decode(buffer.subarray(0, filled)),
    } as const);
  } catch {
    return UNREADABLE_FILE;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function fileSystemErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : null;
}
