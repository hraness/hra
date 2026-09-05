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

import { randomUUID } from "node:crypto";
import { constants, type Dir } from "node:fs";
import { open, opendir, realpath } from "node:fs/promises";
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
  /** True when every visible automation directory fit inside the requested bound. */
  complete: boolean;
  diagnostics: readonly CodexAutomationDiagnostic[];
}>;

export type ReadCodexAutomationsInput = Readonly<{
  automationsDirectory?: string;
  limit?: number;
}>;

/**
 * Private filesystem evidence used only when a scheduled-task association can
 * grant an otherwise-stale thread adoption authority. The directory name is
 * intentionally kept out of `CodexAutomation`, which is cloud projected.
 */
export type CodexAutomationAuthorityEntry = Readonly<{
  automation: Readonly<Pick<CodexAutomation, "kind" | "status" | "targetThreadId">>;
  sourceDirectoryName: string;
}>;

export type CodexAutomationAuthorityRequest =
  | Readonly<{
      after?: string | null;
      kind: "page";
      limit?: number;
    }>
  | Readonly<{
      kind: "sources";
      sourceDirectoryNames: readonly string[];
    }>;

export type ReadCodexAutomationAuthorityInput = CodexAutomationAuthorityRequest & Readonly<{
  automationsDirectory?: string;
}>;

export type CodexAutomationAuthorityScan = Readonly<{
  /** True only when this exact request was completely inspected. */
  complete: boolean;
  diagnostics: readonly CodexAutomationDiagnostic[];
  entries: readonly CodexAutomationAuthorityEntry[];
  /** Opaque in-process scan cursor for the next fair page, or null at wrap. */
  nextCursor: string | null;
}>;

/**
 * Returned collections and retained filesystem values have fixed bounds. The
 * compatibility projection streams a whole directory to preserve its atomic,
 * lexicographically stable snapshot; adoption authority additionally bounds
 * the number of directory entries examined on each fair page.
 */
const MAX_AUTOMATION_FILE_BYTES = 64 * 1_024;
const MAX_ID_LENGTH = 200;
const MAX_KIND_LENGTH = 200;
const MAX_NAME_LENGTH = 200;
const MAX_RRULE_LENGTH = 512;
const MAX_TARGET_THREAD_ID_LENGTH = 200;
const MAX_AUTOMATION_DIRECTORIES = 200;
const DEFAULT_AUTOMATION_LIMIT = 200;
const MAX_AUTOMATION_DIRECTORY_NAME_LENGTH = 255;
/** Maximum directory entries consumed by one authority-page request. */
export const CODEX_AUTOMATION_AUTHORITY_PAGE_ENTRY_LIMIT = 256;
const MAX_AUTOMATION_AUTHORITY_PAGE_CURSORS = 16;
const AUTOMATION_AUTHORITY_PAGE_CURSOR_TTL_MS = 5 * 60_000;
const AUTOMATION_AUTHORITY_PAGE_CURSOR_PREFIX = "authority_scan_";
const automationAuthorityPageCursorPattern =
  /^authority_scan_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const AUTOMATION_FILE_NAME = "automation.toml";
const RRULE_PREFIX = "RRULE:";

/** Mirrors the control scalars refused by `containsUnsafeTerminalScalar`. */
const unsafeScalarPattern = /[\p{Cc}\p{Cf}\p{Cs}]/gu;

const EMPTY_SCAN: CodexAutomationScan = Object.freeze({
  automations: Object.freeze([]),
  complete: true,
  diagnostics: Object.freeze([]),
});

const UNAVAILABLE_SCAN: CodexAutomationScan = Object.freeze({
  automations: Object.freeze([]),
  complete: false,
  diagnostics: Object.freeze([]),
});

const UNAVAILABLE_AUTHORITY_SCAN: CodexAutomationAuthorityScan = Object.freeze({
  complete: false,
  diagnostics: Object.freeze([]),
  entries: Object.freeze([]),
  nextCursor: null,
});

type AutomationAuthorityPageState = {
  readonly canonicalDirectory: string;
  readonly directory: string;
  readonly handle: Dir;
  token: string;
  busy: boolean;
  closeTask?: Promise<void>;
  expiresAt: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
};

const automationAuthorityPageStates = new Map<string, AutomationAuthorityPageState>();
let automationAuthorityPageCreationTail = Promise.resolve();

type AutomationParseOutcome =
  | Readonly<{ ok: true; automation: CodexAutomation }>
  | Readonly<{ ok: false; reason: "invalid_toml" | "invalid_fields" }>;

type AutomationAuthorityParseOutcome =
  | Readonly<{
      ok: true;
      automation: CodexAutomationAuthorityEntry["automation"];
    }>
  | Readonly<{ ok: false; reason: "invalid_toml" | "invalid_fields" }>;

const INVALID_TOML: AutomationParseOutcome = Object.freeze({
  ok: false,
  reason: "invalid_toml",
} as const);

const INVALID_FIELDS: AutomationParseOutcome = Object.freeze({
  ok: false,
  reason: "invalid_fields",
} as const);

const INVALID_AUTHORITY_TOML: AutomationAuthorityParseOutcome = Object.freeze({
  ok: false,
  reason: "invalid_toml",
} as const);

const INVALID_AUTHORITY_FIELDS: AutomationAuthorityParseOutcome = Object.freeze({
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

  const canonicalDirectory = await resolveCanonicalAutomationDirectory(directory);
  if (!canonicalDirectory.ok) {
    return canonicalDirectory.missing ? EMPTY_SCAN : UNAVAILABLE_SCAN;
  }

  let selected: Readonly<{ complete: boolean; names: readonly string[] }>;
  try {
    selected = await selectAutomationProjectionNames(directory, limit);
  } catch (error) {
    const code = fileSystemErrorCode(error);
    return code === "ENOENT" || code === "ENOTDIR" ? EMPTY_SCAN : UNAVAILABLE_SCAN;
  }

  const automations: CodexAutomation[] = [];
  const diagnostics: CodexAutomationDiagnostic[] = [];

  for (const name of selected.names) {
    const read = await readBoundedText(
      join(directory, name, AUTOMATION_FILE_NAME),
      join(canonicalDirectory.path, name, AUTOMATION_FILE_NAME),
    );
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
    complete: selected.complete,
    diagnostics: Object.freeze(diagnostics),
  });
}

async function selectAutomationProjectionNames(
  directory: string,
  limit: number,
): Promise<Readonly<{ complete: boolean; names: readonly string[] }>> {
  // Keep only the lexicographically first bounded candidates while streaming.
  // This preserves the original public snapshot semantics without `readdir`'s
  // directory-cardinality-sized allocation. Unlike adoption authority, this
  // compatibility projection is not a source of session-control authority.
  const candidates: string[] = [];
  let complete = true;
  const handle = await opendir(directory);
  for await (const entry of handle) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (candidates.length === limit) complete = false;
    let low = 0;
    let high = candidates.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((candidates[middle] ?? "") < entry.name) low = middle + 1;
      else high = middle;
    }
    candidates.splice(low, 0, entry.name);
    if (candidates.length > limit) candidates.pop();
  }
  return Object.freeze({ complete, names: Object.freeze(candidates) });
}

/**
 * Read fair, bounded pages of automation authority or re-read an exact set of
 * source directories. Positive age-waiver evidence comes from a page entry;
 * pre-claim and pre-commit checks use `kind: "sources"` so unrelated directory
 * insertion or deletion cannot shift the evidence across a page boundary.
 *
 * This deliberately does not cache records. Every exact-source request opens
 * and validates the current file again, so deletion, retargeting, pausing
 * drift, malformed TOML, symlinks, and replacement all fail closed.
 */
export async function readCodexAutomationAuthority(
  input: ReadCodexAutomationAuthorityInput,
): Promise<CodexAutomationAuthorityScan> {
  const directory = input.automationsDirectory ?? defaultAutomationsDirectory();
  const canonicalDirectory = await resolveCanonicalAutomationDirectory(directory);
  if (!canonicalDirectory.ok) {
    if (input.kind === "page" && input.after !== undefined && input.after !== null) {
      await discardAutomationAuthorityPageCursor(input.after, directory);
    }
    if (!canonicalDirectory.missing) return UNAVAILABLE_AUTHORITY_SCAN;
    return Object.freeze({
      complete: true,
      diagnostics: Object.freeze([]),
      entries: Object.freeze([]),
      nextCursor: null,
    });
  }
  if (input.kind === "sources") {
    const names = [...new Set(input.sourceDirectoryNames)];
    if (
      names.length > MAX_AUTOMATION_DIRECTORIES
      || names.some((name) => !safeAutomationDirectoryName(name))
    ) return UNAVAILABLE_AUTHORITY_SCAN;
    const read = await readAutomationAuthorityEntries(
      directory,
      canonicalDirectory.path,
      names.sort(),
    );
    return Object.freeze({
      complete: true,
      diagnostics: read.diagnostics,
      entries: read.entries,
      nextCursor: null,
    });
  }

  const after = input.after ?? null;
  if (after !== null && !safeAutomationAuthorityPageCursor(after)) {
    return UNAVAILABLE_AUTHORITY_SCAN;
  }
  const limit = boundedLimit(input.limit);
  if (limit === 0) return UNAVAILABLE_AUTHORITY_SCAN;

  let page: readonly string[];
  let complete: boolean;
  let nextCursor: string | null;
  try {
    const selected = await selectAutomationAuthorityPage(
      directory,
      canonicalDirectory.path,
      after,
      limit,
    );
    page = selected.names;
    complete = selected.complete;
    nextCursor = selected.nextCursor;
  } catch (error) {
    const code = fileSystemErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return Object.freeze({
        complete: true,
        diagnostics: Object.freeze([]),
        entries: Object.freeze([]),
        nextCursor: null,
      });
    }
    return UNAVAILABLE_AUTHORITY_SCAN;
  }
  if (!complete && nextCursor === null) return UNAVAILABLE_AUTHORITY_SCAN;
  const read = await readAutomationAuthorityEntries(
    directory,
    canonicalDirectory.path,
    page,
  );
  return Object.freeze({
    complete,
    diagnostics: read.diagnostics,
    entries: read.entries,
    nextCursor,
  });
}

async function selectAutomationAuthorityPage(
  directory: string,
  canonicalDirectory: string,
  after: string | null,
  limit: number,
): Promise<Readonly<{
  complete: boolean;
  names: readonly string[];
  nextCursor: string | null;
}>> {
  let state: AutomationAuthorityPageState | null;
  if (after === null) {
    state = await createAutomationAuthorityPageState(directory, canonicalDirectory);
    if (state === null) throw new Error("Automation authority cursor capacity is unavailable.");
  } else {
    const current = automationAuthorityPageStates.get(after);
    if (current === undefined) {
      // Cursor state is process-local and intentionally expires. Recover with a
      // fresh empty authority page: no stale cursor can grant positive evidence,
      // while the returned token lets the single owner resume on its next poll.
      state = await createAutomationAuthorityPageState(directory, canonicalDirectory);
      if (state === null) throw new Error("Automation authority cursor capacity is unavailable.");
      return Object.freeze({
        complete: false,
        names: Object.freeze([]),
        nextCursor: state.token,
      });
    }
    if (
      current.directory !== directory
      || current.canonicalDirectory !== canonicalDirectory
      || current.expiresAt <= Date.now()
    ) {
      if (current.directory !== directory) {
        throw new Error("Automation authority cursor belongs to another directory.");
      }
      await closeAutomationAuthorityPageState(current);
      state = await createAutomationAuthorityPageState(directory, canonicalDirectory);
      if (state === null) throw new Error("Automation authority cursor capacity is unavailable.");
      return Object.freeze({
        complete: false,
        names: Object.freeze([]),
        nextCursor: state.token,
      });
    }
    if (current.busy || current.closeTask !== undefined) {
      throw new Error("Automation authority cursor is already in use.");
    }
    state = current;
  }

  state.busy = true;
  armAutomationAuthorityPageExpiry(state);
  const names: string[] = [];
  let complete = false;
  let examined = 0;
  try {
    while (
      names.length < limit
      && examined < CODEX_AUTOMATION_AUTHORITY_PAGE_ENTRY_LIMIT
    ) {
      const entry = await state.handle.read();
      if (entry === null) {
        complete = true;
        break;
      }
      examined += 1;
      if (entry.isDirectory() && safeAutomationDirectoryName(entry.name)) {
        names.push(entry.name);
      }
    }
    if (complete) {
      await closeAutomationAuthorityPageState(state);
    } else {
      rotateAutomationAuthorityPageCursor(state);
    }
    return Object.freeze({
      complete,
      names: Object.freeze(names),
      nextCursor: complete ? null : state.token,
    });
  } catch (error: unknown) {
    // A failed close does not prove the descriptor was released. Retry it once
    // immediately; if that also fails, retained state and its expiry timer keep
    // later cleanup possible. In every case this page returns no authority.
    await closeAutomationAuthorityPageState(state).catch(() => undefined);
    throw error;
  } finally {
    state.busy = false;
    if (
      automationAuthorityPageStates.get(state.token) === state
      && state.closeTask === undefined
    ) {
      armAutomationAuthorityPageExpiry(state);
    }
  }
}

async function createAutomationAuthorityPageState(
  directory: string,
  canonicalDirectory: string,
): Promise<AutomationAuthorityPageState | null> {
  let releaseCreation!: () => void;
  const priorCreation = automationAuthorityPageCreationTail;
  automationAuthorityPageCreationTail = new Promise<void>((resolve) => {
    releaseCreation = resolve;
  });
  await priorCreation;
  try {
    const now = Date.now();
    for (const state of [...automationAuthorityPageStates.values()]) {
      if (!state.busy && state.closeTask === undefined && state.expiresAt <= now) {
        await closeAutomationAuthorityPageState(state);
      }
    }
    if (automationAuthorityPageStates.size >= MAX_AUTOMATION_AUTHORITY_PAGE_CURSORS) {
      const evictable = [...automationAuthorityPageStates.values()]
        .filter((state) => !state.busy && state.closeTask === undefined)
        .sort((left, right) => left.expiresAt - right.expiresAt)[0];
      if (evictable === undefined) return null;
      await closeAutomationAuthorityPageState(evictable);
    }

    const handle = await opendir(directory);
    const token = `${AUTOMATION_AUTHORITY_PAGE_CURSOR_PREFIX}${randomUUID()}`;
    if (automationAuthorityPageStates.has(token)) {
      await handle.close();
      return null;
    }
    const state: AutomationAuthorityPageState = {
      busy: false,
      canonicalDirectory,
      directory,
      expiresAt: now + AUTOMATION_AUTHORITY_PAGE_CURSOR_TTL_MS,
      handle,
      token,
    };
    automationAuthorityPageStates.set(token, state);
    armAutomationAuthorityPageExpiry(state);
    return state;
  } finally {
    releaseCreation();
  }
}

function armAutomationAuthorityPageExpiry(state: AutomationAuthorityPageState): void {
  if (state.closeTask !== undefined) return;
  if (state.expiryTimer !== undefined) clearTimeout(state.expiryTimer);
  state.expiresAt = Date.now() + AUTOMATION_AUTHORITY_PAGE_CURSOR_TTL_MS;
  state.expiryTimer = setTimeout(() => {
    if (automationAuthorityPageStates.get(state.token) !== state) return;
    if (state.busy || state.closeTask !== undefined) {
      armAutomationAuthorityPageExpiry(state);
      return;
    }
    void closeAutomationAuthorityPageState(state).catch(() => undefined);
  }, AUTOMATION_AUTHORITY_PAGE_CURSOR_TTL_MS);
  state.expiryTimer.unref();
}

async function closeAutomationAuthorityPageState(
  state: AutomationAuthorityPageState,
): Promise<void> {
  if (state.closeTask !== undefined) return state.closeTask;
  if (automationAuthorityPageStates.get(state.token) !== state) return;
  if (state.expiryTimer !== undefined) {
    clearTimeout(state.expiryTimer);
    delete state.expiryTimer;
  }
  // Bun 1.3 implements this Node API as a synchronous `undefined` return even
  // though its declaration promises `Promise<void>`. Normalise both runtimes
  // and synchronous throws into one tracked close task.
  const closeTask = Promise.resolve().then(() => state.handle.close()).then(
    () => {
      if (automationAuthorityPageStates.get(state.token) === state) {
        automationAuthorityPageStates.delete(state.token);
      }
    },
    (error: unknown) => {
      delete state.closeTask;
      if (
        automationAuthorityPageStates.get(state.token) === state
        && !state.busy
      ) {
        armAutomationAuthorityPageExpiry(state);
      }
      throw error;
    },
  );
  state.closeTask = closeTask;
  return closeTask;
}

function rotateAutomationAuthorityPageCursor(state: AutomationAuthorityPageState): void {
  if (automationAuthorityPageStates.get(state.token) !== state) {
    throw new Error("Automation authority cursor state was retired during use.");
  }
  const nextToken = `${AUTOMATION_AUTHORITY_PAGE_CURSOR_PREFIX}${randomUUID()}`;
  if (automationAuthorityPageStates.has(nextToken)) {
    throw new Error("Automation authority cursor identity collided.");
  }
  automationAuthorityPageStates.delete(state.token);
  state.token = nextToken;
  automationAuthorityPageStates.set(nextToken, state);
}

async function discardAutomationAuthorityPageCursor(
  token: string,
  directory: string,
): Promise<void> {
  if (!safeAutomationAuthorityPageCursor(token)) return;
  const state = automationAuthorityPageStates.get(token);
  if (
    state === undefined
    || state.directory !== directory
    || state.busy
    || state.closeTask !== undefined
  ) return;
  await closeAutomationAuthorityPageState(state).catch(() => undefined);
}

async function readAutomationAuthorityEntries(
  directory: string,
  canonicalDirectory: string,
  names: readonly string[],
): Promise<Readonly<{
  diagnostics: readonly CodexAutomationDiagnostic[];
  entries: readonly CodexAutomationAuthorityEntry[];
}>> {
  const entries: CodexAutomationAuthorityEntry[] = [];
  const diagnostics: CodexAutomationDiagnostic[] = [];
  for (const name of names) {
    const read = await readBoundedText(
      join(directory, name, AUTOMATION_FILE_NAME),
      join(canonicalDirectory, name, AUTOMATION_FILE_NAME),
    );
    if (!read.ok) {
      if (!read.missing) diagnostics.push(diagnostic(name, "unreadable"));
      continue;
    }
    const outcome = parseAutomationAuthorityDocument(read.text);
    if (outcome.ok) {
      entries.push(Object.freeze({
        automation: outcome.automation,
        sourceDirectoryName: name,
      }));
    } else {
      diagnostics.push(diagnostic(name, outcome.reason));
    }
  }
  return Object.freeze({
    diagnostics: Object.freeze(diagnostics),
    entries: Object.freeze(entries),
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

  // `kind` and `target_thread_id` decide adoption authority. Unlike display
  // fields, their bytes must already be canonical; trimming must never turn a
  // malformed record into an exact heartbeat association.
  const kind = safeExactField(document.kind, MAX_KIND_LENGTH);
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
    const target = safeExactField(rawTarget, MAX_TARGET_THREAD_ID_LENGTH);
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
 * Parse only the fields that can grant scheduled-target adoption authority.
 * Display and projection fields are deliberately not read: an unsafe name or
 * unusable id/rrule must not revoke an otherwise exact Desktop-owned binding,
 * and none of that free text belongs in the private authority result.
 */
function parseAutomationAuthorityDocument(text: string): AutomationAuthorityParseOutcome {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch {
    return INVALID_AUTHORITY_TOML;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return INVALID_AUTHORITY_TOML;
  }
  const document = parsed as Record<string, unknown>;

  if (document.kind !== "heartbeat") return INVALID_AUTHORITY_FIELDS;

  const targetThreadId = safeExactField(
    document.target_thread_id,
    MAX_TARGET_THREAD_ID_LENGTH,
  );
  if (targetThreadId === null || targetThreadId.length === 0) {
    return INVALID_AUTHORITY_FIELDS;
  }

  const rawStatus = document.status;
  let status: "active" | "paused" = "active";
  if (rawStatus !== undefined) {
    if (typeof rawStatus !== "string") return INVALID_AUTHORITY_FIELDS;
    if (rawStatus.trim().length === 0 || rawStatus === "ACTIVE") status = "active";
    else if (rawStatus === "PAUSED") status = "paused";
    else return INVALID_AUTHORITY_FIELDS;
  }

  return Object.freeze({
    ok: true,
    automation: Object.freeze({
      kind: "heartbeat",
      status,
      targetThreadId,
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

function safeExactField(value: unknown, max: number): string | null {
  const field = safeField(value, max);
  return field !== null && field === value ? field : null;
}

function safeAutomationDirectoryName(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_AUTOMATION_DIRECTORY_NAME_LENGTH
    && value !== "."
    && value !== ".."
    && !value.startsWith(".")
    && !value.includes("/")
    && !value.includes("\\")
    && !containsUnsafeTerminalScalar(value);
}

function safeAutomationAuthorityPageCursor(value: unknown): value is string {
  return typeof value === "string" && automationAuthorityPageCursorPattern.test(value);
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
const exposedCloseOnExecFlag: unknown = Reflect.get(constants, "O_CLOEXEC");
// Node-compatible runtimes open descriptors close-on-exec internally, but do
// not expose O_CLOEXEC in `fs.constants` on every supported platform. Include
// the native flag when it is exposed without making those platforms unreadable.
const CLOSE_ON_EXEC_OPEN_FLAG = typeof exposedCloseOnExecFlag === "number"
  ? exposedCloseOnExecFlag
  : 0;

type CanonicalAutomationDirectory =
  | Readonly<{ ok: true; path: string }>
  | Readonly<{ ok: false; missing: boolean }>;

async function resolveCanonicalAutomationDirectory(
  directory: string,
): Promise<CanonicalAutomationDirectory> {
  try {
    return Object.freeze({ ok: true, path: await realpath(directory) });
  } catch (error) {
    const code = fileSystemErrorCode(error);
    return code === "ENOENT" || code === "ENOTDIR"
      ? Object.freeze({ ok: false, missing: true })
      : Object.freeze({ ok: false, missing: false });
  }
}

/**
 * Resolve the already-open descriptor without trusting any path component
 * used to reach it. Darwin exposes descriptors through `/dev/fd`; Linux uses
 * `/proc/self/fd`. A platform without either proof refuses the file.
 */
async function canonicalPathForOpenHandle(handle: FileHandle): Promise<string | null> {
  const candidates = process.platform === "linux"
    ? [`/proc/self/fd/${handle.fd}`, `/dev/fd/${handle.fd}`]
    : [`/dev/fd/${handle.fd}`, `/proc/self/fd/${handle.fd}`];
  for (const candidate of candidates) {
    try {
      return await realpath(candidate);
    } catch {
      // Try the other supported descriptor filesystem.
    }
  }
  return null;
}

/** Read at most `MAX_AUTOMATION_FILE_BYTES`; a larger file is unreadable. */
async function readBoundedText(
  path: string,
  expectedCanonicalPath: string,
): Promise<BoundedRead> {
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | CLOSE_ON_EXEC_OPEN_FLAG | constants.O_NOFOLLOW,
    );
  } catch (error) {
    const code = fileSystemErrorCode(error);
    return code === "ENOENT" || code === "ENOTDIR" ? MISSING_FILE : UNREADABLE_FILE;
  }
  try {
    const openedPath = await canonicalPathForOpenHandle(handle);
    if (openedPath !== expectedCanonicalPath) return UNREADABLE_FILE;
    const before = await handle.stat();
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (
      !before.isFile()
      || before.nlink !== 1
      || before.size > MAX_AUTOMATION_FILE_BYTES
      || (currentUid !== null && before.uid !== currentUid)
      || (before.mode & 0o022) !== 0
    ) return UNREADABLE_FILE;
    const buffer = new Uint8Array(MAX_AUTOMATION_FILE_BYTES + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > MAX_AUTOMATION_FILE_BYTES) return UNREADABLE_FILE;
    const after = await handle.stat();
    const settledPath = await canonicalPathForOpenHandle(handle);
    if (
      settledPath !== openedPath
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
    ) return UNREADABLE_FILE;
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
