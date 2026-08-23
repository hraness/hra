#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { constants, readSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { isatty } from "node:tty";

import {
  CliUsageError,
  completeProtectedAuthLogin,
  completeProtectedInteraction,
  parseCli,
  projectionRecoveryReplayCommand,
  requestsJsonOutput,
  usageForGroup,
  type CliInvocation,
  type ProjectionRecoveryCliInvocation,
  type ProtectedInputSource,
  type RemoteCliCommand,
} from "./cli/parser";
import { renderFailure, renderSuccess, safeDiagnostic, safeJson, terminalSafe, type Output } from "./cli/render";
import { compileShellLine, formatShellPrompt, shellHelp, type ShellSelection } from "./cli/shell";
import { ShellLiveObserver } from "./cli/shell-live";
import { followSessionEvents } from "./cli/watch";
import {
  BridgedCloudControl,
  CloudDaemonJournalRecoveryBlocker,
  CustodyCloudDaemonJournal,
  StateBackedCloudDaemonAdapter,
  containsAbsolutePath,
  createCloudDaemonLifecycle,
  createCloudUuidV7,
  createLocalCloudControlFromEnvironment,
  createLocalCloudDaemonBridgeFromEnvironment,
  IdentityScopedCloudSecretCustody,
  isRecord,
  isSafeNonNegativeInteger,
  isSafePositiveInteger,
  isUuidV7,
  hasExactKeys,
  redactAbsolutePaths,
  type CloudRemoteControlPort,
  type CloudRemoteSessionHead,
  type RemoteCommandPayload,
  type CloudDaemonLifecycle,
} from "./cloud/index";
import { resolvePinnedCodexRuntime } from "./codex/index";
import type { CommandResponse, LocalCommand } from "./domain/contracts";
import { profileIdSchema, sessionIdSchema } from "./domain/values";
import {
  LocalDaemonServer,
  LocalDaemonIndeterminateError,
  LocalDaemonShutdownTimeoutError,
  callLocalDaemon,
  callWithSafeAutostart,
  isLocalDaemonUnavailable,
} from "./daemon/local-transport";
import { DaemonAuthorityBusyError, DaemonAuthorityFence, DaemonLock } from "./daemon/daemon-lock";
import {
  daemonStatusIdentity,
  identityFromReceipt,
  waitForDaemonAuthorityRelease,
  waitForDaemonReady,
} from "./daemon/daemon-startup";
import { PinnedCodexRuntimeManager } from "./daemon/codex-runtime-adapter";
import { UnavailableCloudControl, type CloudControlPort, type CodexRuntimePort, type CompactProjectionRecoveryBlocker } from "./daemon/ports";
import { SessionEventCursorCodec } from "./daemon/session-event-cursor";
import { HraService } from "./daemon/service";
import { AccountUsagePoller } from "./daemon/usage-poller";
import { ExactChatGptBundlePort, LocalDesktopSwitchPort, PidBoundDesktopAccountRuntime } from "./desktop/index";
import { initializeStatePaths, resolveStatePaths, type StatePaths } from "./storage/paths";
import { GenerationalSecretCustody } from "./storage/secret-custody";
import { StateStore } from "./storage/state-store";
import { HRA_VERSION } from "./version";

const writeProcessStdoutAsync = (value: string, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error === undefined || error === null) resolve();
      else reject(error);
    };
    const onAbort = (): void => finish(
      signal.reason ?? new DOMException("Session event output was aborted.", "AbortError"),
    );
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      process.stdout.write(value, (error) => finish(error));
    } catch (error: unknown) {
      finish(error);
    }
  });

const processOutput: Output = {
  writeStdout: (value) => process.stdout.write(value),
  writeStdoutAsync: writeProcessStdoutAsync,
  writeStderr: (value) => process.stderr.write(value),
};

const protectedInputMaximumBytes = 64 * 1024;
const sessionCursorCustodySlot = "session-cursor-key";

const decodeProtectedJson = (bytes: Buffer): unknown => {
  if (bytes.byteLength === 0) throw new CliUsageError("Protected input is empty.");
  if (bytes.byteLength > protectedInputMaximumBytes) {
    throw new CliUsageError(`Protected input exceeds ${String(protectedInputMaximumBytes)} UTF-8 bytes.`);
  }
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(source) as unknown;
  } catch {
    throw new CliUsageError("Protected input must be one valid UTF-8 JSON document.");
  } finally {
    bytes.fill(0);
  }
};

const readBoundedDescriptor = (fd: number): Buffer => {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(8 * 1024, protectedInputMaximumBytes + 1 - total));
      const read = readSync(fd, chunk, 0, chunk.byteLength, null);
      if (read === 0) {
        chunk.fill(0);
        break;
      }
      chunks.push(chunk.subarray(0, read));
      total += read;
      if (total > protectedInputMaximumBytes) {
        throw new CliUsageError(`Protected interaction input exceeds ${String(protectedInputMaximumBytes)} UTF-8 bytes.`);
      }
    }
    return Buffer.concat(chunks, total);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
};

const readHiddenProtectedLine = async (output: Output): Promise<Buffer> => {
  const sink = new Writable({
    write(_chunk, _encoding, callback) { callback(); },
  });
  const terminal = createInterface({
    input: process.stdin,
    output: sink,
    terminal: true,
    historySize: 0,
  });
  const controller = new AbortController();
  terminal.once("SIGINT", () => controller.abort(new Error("Protected input was cancelled.")));
  output.writeStderr("Protected JSON input (hidden): ");
  try {
    const value = await terminal.question("", { signal: controller.signal });
    const bytes = Buffer.from(value, "utf8");
    if (bytes.byteLength > protectedInputMaximumBytes) {
      bytes.fill(0);
      throw new CliUsageError(`Protected input exceeds ${String(protectedInputMaximumBytes)} UTF-8 bytes.`);
    }
    return bytes;
  } catch (error: unknown) {
    if (controller.signal.aborted) throw new CliUsageError("Protected interaction input was cancelled.");
    throw error;
  } finally {
    terminal.close();
    sink.destroy();
    output.writeStderr("\n");
  }
};

const readProtectedDocument = async (
  source: ProtectedInputSource,
  output: Output,
): Promise<unknown> => {
  const fd = source.kind === "stdin" ? 0 : source.fd;
  let bytes: Buffer;
  try {
    if (isatty(fd)) {
      if (fd !== 0) {
        throw new CliUsageError("Protected input from a terminal is supported only through stdin.");
      }
      bytes = await readHiddenProtectedLine(output);
    } else {
      bytes = readBoundedDescriptor(fd);
    }
  } catch (error: unknown) {
    if (error instanceof CliUsageError) throw error;
    throw new CliUsageError("Protected input could not be read from the selected descriptor.");
  }
  return decodeProtectedJson(bytes);
};

export async function resolveSessionEventCursorCodec(
  custody: GenerationalSecretCustody,
): Promise<SessionEventCursorCodec> {
  let observation = await custody.read(sessionCursorCustodySlot);
  if (observation === null) {
    observation = await custody.compareAndSwap(
      sessionCursorCustodySlot,
      null,
      SessionEventCursorCodec.generateKey(),
    );
    if (observation === null) observation = await custody.read(sessionCursorCustodySlot);
  }
  if (observation === null) throw new Error("Session event cursor authority could not be initialized.");
  return new SessionEventCursorCodec(observation.value);
}

const syncDiagnosticLimit = 16;
const syncDiagnosticMaximumBytes = 768;
const syncDiagnosticTruncationMarker = " [truncated]";
const bearerSecretPattern = /(^|[^A-Za-z0-9])Bearer[ \t]+[A-Za-z0-9._~+/=-]+/giu;
const prefixedSecretPattern = /(^|[^A-Za-z0-9])(?:sk|re)_[A-Za-z0-9_-]{8,}/gu;
const assignedSecretPattern = /(^|[^A-Za-z0-9])(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|authorization)[ \t]*[:=][ \t]*(?:Bearer[ \t]+)?[A-Za-z0-9._~+/=-]{4,}/giu;
const jwtSecretPattern = /(^|[^A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu;
const privateKeyHeaderPattern = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/iu;
const secretLabelPattern = /(?:\bBearer\b|\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|authorization)\b|\b(?:sk|re)_|\beyJ)/iu;
const unsafeTerminalScalarPattern = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const underscoreAbsolutePathPattern = /(^|_)((?:file:\/\/+|~\/|[A-Za-z]:[\\/]|\\\\[^\\/\s"'`<>{}[\](),;]+[\\/]|\/(?!\/))[^\s"'`<>{}[\](),;_]*)/giu;

type SyncNowSummary = Readonly<{
  online: boolean;
  commandsApplied: number;
  commandsUnsettled: number;
  sessionsUploaded: number;
  usageUploaded: number;
  errorCount: number;
  errors: readonly string[];
  errorsOmitted: number;
}>;

type ProjectionRecoverySummary =
  | Readonly<{
      boundaryHead: number;
      gapRemainsVisible: true;
      idempotencyKey: string;
      newEpoch: number;
      oldEpoch: number;
      phase: "applied";
      sameKeyReplay: Readonly<{
        command: string;
        supported: true;
      }>;
      session: string;
    }>
  | Readonly<{
      idempotencyKey: string;
      phase: "rejected";
      rejectionCode: string;
      sameKeyReplay: Readonly<{
        command: string;
        supported: true;
      }>;
      session: string;
    }>;

type CliMainInput = Readonly<{
  statePaths?: StatePaths;
  callDaemon?: (command: LocalCommand, signal?: AbortSignal) => Promise<CommandResponse>;
  getRemoteCommandStatus?: CloudRemoteControlPort["getRemoteCommandStatus"];
  interactive?: boolean;
  isTerminalDescriptor?: (fd: number) => boolean;
  readProtectedDocument?: (source: ProtectedInputSource) => Promise<unknown>;
  readShellLine?: (prompt: string) => Promise<string | null>;
}>;

export function selectDaemonCloudControl(
  configured: CloudControlPort | null,
  projectionRecoveryBlocker: CompactProjectionRecoveryBlocker,
): CloudControlPort {
  return configured ?? new UnavailableCloudControl(projectionRecoveryBlocker);
}

function boundedUtf8Text(value: string, maximumBytes: number): string {
  const encoder = new TextEncoder();
  const retained: Array<Readonly<{ bytes: number; scalar: string }>> = [];
  let retainedBytes = 0;
  let truncated = false;
  for (const scalar of value) {
    const bytes = encoder.encode(scalar).byteLength;
    if (retainedBytes + bytes > maximumBytes) {
      truncated = true;
      break;
    }
    retained.push({ bytes, scalar });
    retainedBytes += bytes;
  }
  if (!truncated) return retained.map((entry) => entry.scalar).join("");

  const markerBytes = encoder.encode(syncDiagnosticTruncationMarker).byteLength;
  while (retained.length > 0 && retainedBytes + markerBytes > maximumBytes) {
    const removed = retained.pop();
    if (removed !== undefined) retainedBytes -= removed.bytes;
  }
  return `${retained.map((entry) => entry.scalar).join("")}${syncDiagnosticTruncationMarker}`;
}

function redactSyncSecrets(value: string): string {
  if (privateKeyHeaderPattern.test(value)) return "[redacted private key material]";
  if (unsafeTerminalScalarPattern.test(value) && secretLabelPattern.test(value)) {
    return "[redacted token-like diagnostic containing terminal controls]";
  }
  return value
    .replace(bearerSecretPattern, (_match, prefix: string) => `${prefix}Bearer [redacted]`)
    .replace(prefixedSecretPattern, (_match, prefix: string) => `${prefix}[redacted-token]`)
    .replace(jwtSecretPattern, (_match, prefix: string) => `${prefix}[redacted-token]`)
    .replace(assignedSecretPattern, (_match, prefix: string) => `${prefix}[redacted-token]`);
}

function redactSyncPaths(value: string): string {
  return redactAbsolutePaths(value).replace(
    underscoreAbsolutePathPattern,
    (_match, prefix: string) => `${prefix}[local-path]`,
  );
}

function sanitizeSyncDiagnostic(value: string): string {
  const bounded = boundedUtf8Text(value, syncDiagnosticMaximumBytes);
  const redacted = redactSyncSecrets(redactSyncPaths(bounded));
  const terminalSanitized = terminalSafe(redacted);
  const sanitized = redactSyncSecrets(redactSyncPaths(terminalSanitized));
  const pathSafe = containsAbsolutePath(sanitized)
    ? "[sync diagnostic omitted because it contained a local path]"
    : sanitized;
  const final = boundedUtf8Text(pathSafe, syncDiagnosticMaximumBytes).trim();
  return final.length === 0 ? "Sync failed without a diagnostic." : final;
}

function parseSyncNowSummary(value: unknown): SyncNowSummary | null {
  if (!isRecord(value) || !isRecord(value.daemon)) return null;
  const daemon = value.daemon;
  if (
    typeof daemon.online !== "boolean"
    || !isSafeNonNegativeInteger(daemon.commandsApplied)
    || !isSafeNonNegativeInteger(daemon.commandsUnsettled)
    || !isSafeNonNegativeInteger(daemon.sessionsUploaded)
    || !isSafeNonNegativeInteger(daemon.usageUploaded)
    || !Array.isArray(daemon.errors)
  ) return null;

  const errors: string[] = [];
  const errorValues: readonly unknown[] = daemon.errors;
  const returnedErrors = Math.min(errorValues.length, syncDiagnosticLimit);
  for (let index = 0; index < returnedErrors; index += 1) {
    const diagnostic = errorValues[index];
    if (typeof diagnostic !== "string") return null;
    errors.push(sanitizeSyncDiagnostic(diagnostic));
  }
  return {
    online: daemon.online,
    commandsApplied: daemon.commandsApplied,
    commandsUnsettled: daemon.commandsUnsettled,
    sessionsUploaded: daemon.sessionsUploaded,
    usageUploaded: daemon.usageUploaded,
    errorCount: errorValues.length,
    errors,
    errorsOmitted: errorValues.length - errors.length,
  };
}

function renderSyncNowSuccess(data: unknown, json: boolean, output: Output): number {
  const summary = parseSyncNowSummary(data);
  if (summary === null) {
    return renderFailure({
      code: "INTERNAL",
      message: "The daemon returned an invalid sync summary.",
    }, json, output);
  }
  if (json) {
    output.writeStdout(`${safeJson({ ok: true, version: 1, command: "sync.now", data: summary })}\n`);
    return 0;
  }
  const rows = [
    `Cloud sync: ${summary.online ? "online" : "offline"}`,
    `Uploaded: ${String(summary.sessionsUploaded)} sessions; ${String(summary.usageUploaded)} usage snapshots`,
    `Commands: ${String(summary.commandsApplied)} applied; ${String(summary.commandsUnsettled)} unsettled`,
  ];
  if (summary.errors.length === 0) {
    rows.push("Diagnostics: none");
  } else {
    rows.push("Diagnostics:", ...summary.errors.map((error) => `  - ${terminalSafe(error)}`));
    if (summary.errorsOmitted > 0) rows.push(`  - ${String(summary.errorsOmitted)} more omitted`);
  }
  output.writeStdout(`${rows.join("\n")}\n`);
  return 0;
}

function renderSyncNowFailure(
  error: Readonly<{ code: string; message: string }>,
  json: boolean,
  output: Output,
): number {
  return renderFailure({
    code: error.code,
    message: sanitizeSyncDiagnostic(error.message),
  }, json, output);
}

function parseProjectionRecoverySummary(
  value: unknown,
  invocation: ProjectionRecoveryCliInvocation,
): ProjectionRecoverySummary | null {
  if (!isRecord(value)) return null;
  const parsedSession = sessionIdSchema.safeParse(value.sessionPublicId);
  if (!parsedSession.success) return null;
  const sessionPublicId = parsedSession.data;
  const sameIdentity = value.idempotencyKey === invocation.command.idempotencyKey
    && sessionPublicId.length <= 96;
  if (!sameIdentity) return null;
  const sameKeyReplay = {
    command: projectionRecoveryReplayCommand(
      sessionPublicId,
      invocation.command.idempotencyKey,
      invocation.json,
    ),
    supported: true as const,
  };
  if (value.phase === "applied") {
    if (
      !hasExactKeys(value, [
        "boundaryHeadSequence",
        "compactHasRecoveryGap",
        "compactStreamEpoch",
        "idempotencyKey",
        "phase",
        "projectionRevision",
        "sessionPublicId",
      ])
      || value.compactHasRecoveryGap !== true
      || !isSafePositiveInteger(value.boundaryHeadSequence)
      || !isSafePositiveInteger(value.compactStreamEpoch)
      || !isSafePositiveInteger(value.projectionRevision)
    ) return null;
    return {
      boundaryHead: value.boundaryHeadSequence,
      gapRemainsVisible: true,
      idempotencyKey: invocation.command.idempotencyKey,
      newEpoch: value.compactStreamEpoch,
      oldEpoch: value.compactStreamEpoch - 1,
      phase: "applied",
      sameKeyReplay,
      session: sessionPublicId,
    };
  }
  if (
    value.phase !== "rejected"
    || !hasExactKeys(value, [
      "idempotencyKey",
      "phase",
      "rejectionCode",
      "sessionPublicId",
    ])
    || typeof value.rejectionCode !== "string"
  ) return null;
  return {
    idempotencyKey: invocation.command.idempotencyKey,
    phase: "rejected",
    rejectionCode: boundedUtf8Text(sanitizeSyncDiagnostic(value.rejectionCode), 128),
    sameKeyReplay,
    session: sessionPublicId,
  };
}

function renderProjectionRecoverySuccess(
  value: unknown,
  invocation: ProjectionRecoveryCliInvocation,
  output: Output,
): number {
  const summary = parseProjectionRecoverySummary(value, invocation);
  if (summary === null) {
    return renderFailure({
      code: "INTERNAL",
      message: "The daemon returned an invalid projection-recovery summary.",
    }, invocation.json, output);
  }
  if (invocation.json) {
    output.writeStdout(`${safeJson({
      command: invocation.command.kind,
      data: summary,
      ok: true,
      version: 1,
    })}\n`);
    return 0;
  }
  if (summary.phase === "rejected") {
    output.writeStdout(`${[
      `Projection recovery rejected for ${terminalSafe(summary.session)}.`,
      `Reason: ${terminalSafe(summary.rejectionCode)}`,
      "Encrypted cloud history and provider/app state were unchanged.",
      `Same-key replay: ${terminalSafe(summary.sameKeyReplay.command)}`,
    ].join("\n")}\n`);
    return 0;
  }
  output.writeStdout(`${[
    `Projection recovery applied for ${terminalSafe(summary.session)}.`,
    `Epoch: ${String(summary.oldEpoch)} -> ${String(summary.newEpoch)}`,
    `Boundary head: ${String(summary.boundaryHead)}`,
    "Gap remains visible: yes",
    "Encrypted cloud history was preserved; provider and app state were unchanged.",
    `Same-key replay: ${terminalSafe(summary.sameKeyReplay.command)}`,
  ].join("\n")}\n`);
  return 0;
}

function renderProjectionRecoveryFailure(
  error: Readonly<{ code: string; message: string }>,
  invocation: ProjectionRecoveryCliInvocation,
  output: Output,
): number {
  return renderFailure({
    code: error.code,
    message: sanitizeSyncDiagnostic(error.message),
  }, invocation.json, output);
}

async function startDaemonProcess(): Promise<void> {
  const cliPath = process.argv[1] ?? import.meta.path;
  const paths = resolveStatePaths();
  await initializeStatePaths(paths);
  const child = Bun.spawn([process.execPath, cliPath, "daemon", "run"], {
    detached: true,
    env: process.env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.unref();
  let exited = false;
  let exitCode: number | undefined;
  void child.exited.then((code) => {
    exitCode = code;
    exited = true;
  });
  await waitForDaemonReady({
    paths,
    queryStatus: async () => await callLocalDaemon({ paths, command: { kind: "daemon.status" }, deadlineMs: 750 }),
    observeChild: () => ({
      pid: child.pid,
      exited,
      ...(exitCode === undefined ? {} : { exitCode }),
    }),
  });
}

async function callWithAutostart(
  command: LocalCommand,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof callLocalDaemon>>> {
  const paths = resolveStatePaths();
  return await callWithSafeAutostart(
    async () => await callLocalDaemon({ paths, command, ...(signal === undefined ? {} : { signal }) }),
    startDaemonProcess,
  );
}

export async function initialize(
  yes: boolean,
  json: boolean,
  output: Output,
  input: { paths?: StatePaths; documentsDirectory?: string } = {},
): Promise<number> {
  const paths = input.paths ?? resolveStatePaths();
  await initializeStatePaths(paths);
  const authority = await DaemonLock.acquire(paths, { state: "maintenance" });
  let store: StateStore | undefined;
  try {
    store = new StateStore(paths);
    let projectCreated = false;
    const documents = input.documentsDirectory ?? join(homedir(), "Documents");
    if (store.listProjects().length === 0) {
      let approved = yes;
      if (!approved && !json && process.stdin.isTTY) {
        approved = confirm(`Use ${documents} as the default HRA project?`);
      }
      if (!approved) {
        return renderFailure({ code: "INTERACTION_REQUIRED", message: "Confirm the default Documents project with `hra init --yes`." }, json, output);
      }
      await access(documents, constants.R_OK | constants.W_OK);
      await store.createProject("Documents", documents, true);
      projectCreated = true;
    }
    const data = { initialized: true, stateRoot: paths.root, defaultProjectCreated: projectCreated, next: "hra account add Personal" };
    if (json) output.writeStdout(`${JSON.stringify({ ok: true, version: 1, data })}\n`);
    else output.writeStdout(`HRA is ready.\n\nNext: ${data.next}\n`);
    return 0;
  } finally {
    try { store?.close(); } finally { await authority.release(); }
  }
}

async function offlineDoctor(json: boolean, output: Output, paths: StatePaths): Promise<number> {
  let initialized = false;
  const problems: string[] = [];
  let database: "not_initialized" | "ready" | "invalid" = "not_initialized";
  let projectCount = 0;
  try {
    const metadata = await lstat(paths.root);
    initialized = metadata.isDirectory() && !metadata.isSymbolicLink() && (metadata.mode & 0o077) === 0;
    if (!initialized) problems.push("The state root is not a private canonical directory.");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (initialized) {
    try {
      const store = new StateStore(paths, { readonly: true });
      try {
        projectCount = store.listProjects().length;
        for (const project of store.listProjects()) await access(project.rootPath, constants.R_OK | constants.W_OK);
        database = "ready";
      } finally {
        store.close();
      }
    } catch {
      database = "invalid";
      problems.push("The local database check failed without exposing its runtime diagnostic.");
    }
  }
  let codexRuntime: { status: "ready"; version: string } | { status: "invalid"; diagnostic: string };
  try {
    const runtime = await resolvePinnedCodexRuntime();
    codexRuntime = { status: "ready", version: runtime.packageVersion };
  } catch {
    const diagnostic = "The pinned Codex runtime check failed without exposing its runtime diagnostic.";
    codexRuntime = { status: "invalid", diagnostic };
    problems.push(diagnostic);
  }
  const bunReady = Bun.version === "1.3.14";
  if (!bunReady) problems.push(`HRA requires Bun 1.3.14, but ${Bun.version} is running.`);
  const data = {
    healthy: problems.length === 0,
    offline: true,
    runtime: { bun: Bun.version, requiredBun: "1.3.14", bunReady, codex: codexRuntime, platform: process.platform, architecture: process.arch },
    state: { initialized, database, projectCount },
    networkChecks: "skipped",
    problems,
  };
  if (json) output.writeStdout(`${JSON.stringify({ ok: true, version: 1, data })}\n`);
  else if (data.healthy) output.writeStdout(`HRA offline checks passed. Bun ${Bun.version}; Codex ${codexRuntime.status}; ${process.platform} ${process.arch}; state ${initialized ? database : "not initialized"}.\n`);
  else output.writeStderr(`hra: offline checks failed\n${problems.map((problem) => `- ${problem}`).join("\n")}\n`);
  return data.healthy ? 0 : 1;
}

async function editSessionNote(session: string, json: boolean, output: Output): Promise<number> {
  if (json || !process.stdin.isTTY || !process.stdout.isTTY) {
    return renderFailure({ code: "INTERACTION_REQUIRED", message: "Note editing requires an interactive terminal. Use `session note set` for scripts." }, json, output);
  }
  const current = await callWithAutostart({ kind: "session.note.get", session });
  if (!current.ok) return renderFailure(current.error, false, output);
  const note = typeof current.data === "object" && current.data !== null && "note" in current.data && typeof current.data.note === "string" ? current.data.note : "";
  const directory = await mkdtemp(join(tmpdir(), "hra-note-"));
  const file = join(directory, "note.md");
  try {
    await writeFile(file, note, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const editorName = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
    const editor = Bun.which(editorName);
    if (editor === null) throw new Error(`Editor is unavailable: ${editorName}`);
    const child = Bun.spawn([editor, file], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env });
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error(`Editor exited with status ${exitCode}.`);
    const edited = await readFile(file, "utf8");
    const response = await callWithAutostart({ kind: "session.note.set", session, note: edited });
    if (!response.ok) return renderFailure(response.error, false, output);
    renderSuccess({ kind: "session.note.set", session, note: edited }, response.data, false, output);
    return 0;
  } finally {
    await unlink(file).catch(() => undefined);
    await rmdir(directory).catch(() => undefined);
  }
}

function remoteFailure(error: unknown, json: boolean, output: Output): number {
  const message = error instanceof Error ? error.message : "Cloud remote operation failed.";
  const code = /not found/iu.test(message)
    ? "NOT_FOUND"
    : /ambiguous/iu.test(message)
      ? "AMBIGUOUS"
      : /changed|conflict|recovered/iu.test(message)
        ? "CONFLICT"
        : /invalid|expired|too (?:long|large)/iu.test(message)
          ? "INVALID_INPUT"
          : /auth|configured|device|pair|unavailable/iu.test(message)
            ? "UNAVAILABLE"
            : "INTERNAL";
  const closedMessage = code === "NOT_FOUND"
    ? "The requested remote object was not found."
    : code === "AMBIGUOUS"
      ? "The remote selector is ambiguous."
      : code === "CONFLICT"
        ? "Remote authority changed before the operation could complete."
        : code === "INVALID_INPUT"
          ? "The remote request is invalid."
          : code === "UNAVAILABLE"
            ? "Remote control is unavailable."
            : "The remote operation failed before a safe diagnostic was available.";
  return renderFailure({ code, message: closedMessage }, json, output);
}

function remoteSessionName(head: CloudRemoteSessionHead): string {
  return terminalSafe(head.metadata?.name ?? head.publicId).replace(/[\r\n\t]+/gu, " ");
}

function remotePayload(command: RemoteCliCommand): RemoteCommandPayload | null {
  switch (command.kind) {
    case "remote.list":
    case "remote.show":
    case "remote.command": return null;
    case "remote.send": return { kind: "send", message: command.message };
    case "remote.queue": return { kind: "queue", message: command.message };
    case "remote.steer": return { kind: "steer", message: command.message };
    case "remote.stop": return { kind: "stop" };
    case "remote.preset": return { kind: "set_model", preset: command.preset };
    case "remote.fast": return { enabled: command.enabled, kind: "set_fast" };
  }
}

type RemoteSessionProjection = Awaited<ReturnType<CloudRemoteControlPort["pullRemoteSession"]>>;
type RemoteInteractionEvent = Extract<RemoteSessionProjection["events"][number], { kind: "interaction_state" }>;

const remoteInteractionSafetyRank: Readonly<Record<RemoteInteractionEvent["state"], number>> = {
  pending: 0,
  response_prepared: 1,
  response_written: 2,
  resolution_unknown: 3,
  resolved: 4,
  declined: 4,
  canceled: 4,
  expired: 4,
};

const laterRemoteInteraction = (
  candidate: RemoteInteractionEvent,
  current: RemoteInteractionEvent,
): boolean => {
  if (candidate.revision !== current.revision) return candidate.revision > current.revision;
  const candidateRank = remoteInteractionSafetyRank[candidate.state];
  const currentRank = remoteInteractionSafetyRank[current.state];
  if (candidateRank !== currentRank) return candidateRank > currentRank;
  if (candidate.sequence !== current.sequence) return candidate.sequence > current.sequence;
  const candidateTie = `${candidate.state}\u0000${candidate.interactionKind}\u0000${candidate.summary}`;
  const currentTie = `${current.state}\u0000${current.interactionKind}\u0000${current.summary}`;
  return candidateTie > currentTie;
};

const latestRemoteInteractions = (
  events: RemoteSessionProjection["events"],
): ReadonlyMap<string, RemoteInteractionEvent> => {
  const latest = new Map<string, RemoteInteractionEvent>();
  for (const event of events) {
    if (event.kind !== "interaction_state") continue;
    const current = latest.get(event.interactionId);
    if (current === undefined || laterRemoteInteraction(event, current)) {
      latest.set(event.interactionId, event);
    }
  }
  return latest;
};

export function renderRemoteSuccess(
  command: RemoteCliCommand,
  data: unknown,
  json: boolean,
  output: Output,
): void {
  if (command.kind === "remote.command") {
    if (!isRecord(data)) throw new Error("Cloud remote command status was invalid.");
    const required = [
      data.commandPublicId,
      data.sessionPublicId,
      data.kind,
      data.state,
      data.targetDevicePublicId,
    ];
    if (!required.every((value) => typeof value === "string")
      || (data.resultCode !== undefined && typeof data.resultCode !== "string")) {
      throw new Error("Cloud remote command status was invalid.");
    }
    const summary = {
      commandPublicId: boundedUtf8Text(sanitizeSyncDiagnostic(data.commandPublicId as string), 160),
      sessionPublicId: boundedUtf8Text(sanitizeSyncDiagnostic(data.sessionPublicId as string), 160),
      kind: boundedUtf8Text(sanitizeSyncDiagnostic(data.kind as string), 64),
      state: boundedUtf8Text(sanitizeSyncDiagnostic(data.state as string), 64),
      ...(typeof data.resultCode === "string"
        ? { resultCode: boundedUtf8Text(sanitizeSyncDiagnostic(data.resultCode), 128) }
        : {}),
      targetDevicePublicId: boundedUtf8Text(sanitizeSyncDiagnostic(data.targetDevicePublicId as string), 160),
    };
    if (json) {
      output.writeStdout(`${safeJson({ ok: true, version: 1, command: command.kind, data: summary })}\n`);
      return;
    }
    output.writeStdout(`${[
      `Command ${terminalSafe(summary.commandPublicId)}`,
      `State: ${terminalSafe(summary.state)}`,
      `Result: ${terminalSafe(summary.resultCode ?? "not reported")}`,
      `Session: ${terminalSafe(summary.sessionPublicId)}`,
      `Kind: ${terminalSafe(summary.kind)}`,
      `Target: ${terminalSafe(summary.targetDevicePublicId)}`,
    ].join("\n")}\n`);
    return;
  }
  if (json) {
    output.writeStdout(`${safeJson({ ok: true, version: 1, command: command.kind, data })}\n`);
    return;
  }
  if (command.kind === "remote.list") {
    const sessions = (data as { sessions: readonly CloudRemoteSessionHead[] }).sessions;
    if (sessions.length === 0) {
      output.writeStdout("No cloud sessions.\n");
      return;
    }
    output.writeStdout(`${sessions.map((head) => [
      `${remoteSessionName(head)}  ${terminalSafe(head.state)}`,
      `  ${terminalSafe(head.publicId)}  device ${terminalSafe(head.executionDevicePublicId)}`,
    ].join("\n")).join("\n")}\n`);
    return;
  }
  if (command.kind === "remote.show") {
    const session = data as Awaited<ReturnType<CloudRemoteControlPort["pullRemoteSession"]>>;
    const rows = [
      remoteSessionName(session),
      `State: ${terminalSafe(session.state)}`,
      `Session: ${terminalSafe(session.publicId)}`,
      `Device: ${terminalSafe(session.executionDevicePublicId)}`,
      "",
    ];
    if (session.recoveryGap !== undefined) {
      rows.push(
        `Recovery gap: compact projection cache recovery at stream epoch ${String(session.recoveryGap.streamEpoch)}.`,
        "  Remote interaction state is incomplete while recovery settles. Do not act until a committed baseline is available.",
        "",
      );
    } else if (session.compactHasRecoveryGap) {
      rows.push(
        "Recovery gap: the compact projection reports an incomplete recovery boundary.",
        "",
      );
    }
    const currentInteractions = latestRemoteInteractions(session.events);
    const interactionGuidanceAvailable = session.recoveryGap === undefined
      && !session.compactHasRecoveryGap;
    for (const event of session.events) {
      if (event.kind === "user_message" || event.kind === "assistant_message") {
        rows.push(`${event.kind === "user_message" ? "You" : "Codex"}  ${terminalSafe(event.turnId)}`);
        rows.push(...terminalSafe(event.text, true).split("\n").map((line) => `  ${line}`), "");
      } else if (event.kind === "interaction_state") {
        if (currentInteractions.get(event.interactionId) !== event) continue;
        const kind = event.interactionKind.replaceAll("_", " ");
        rows.push(`Interaction ${terminalSafe(event.interactionId)}  ${terminalSafe(kind)}`);
        rows.push(`  ${terminalSafe(event.state)}  revision ${String(event.revision)}  ${event.blocking ? "blocking" : "nonblocking"}`);
        rows.push(
          ...terminalSafe(event.summary, true).split("\n").map((line) => `  ${line}`),
        );
        if (!interactionGuidanceAvailable) {
          rows.push("  Interaction action guidance is suppressed while remote recovery settles.");
        } else if (event.state === "pending") {
          rows.push("  Resolve on the execution device. Remote interaction responses are not enabled.");
        } else if (event.state === "response_prepared") {
          rows.push("  A response is durably prepared on the execution device. Do not submit another response.");
        } else if (event.state === "response_written") {
          rows.push("  The provider response write began on the execution device. Do not submit another response.");
        } else if (event.state === "resolution_unknown") {
          rows.push("  Provider delivery is uncertain. Do not retry; recover on the execution device.");
        }
        rows.push("");
      } else {
        const runtimeProfile = event.model === undefined
          ? "model/Fast unknown"
          : `${event.model}${event.fast === true ? " fast" : ""}`;
        rows.push(`Turn ${terminalSafe(event.turnId)}  ${(event.runtimeMs / 1_000).toFixed(1)}s  ${terminalSafe(runtimeProfile)}`);
        if (event.filesTouched.length > 0) rows.push(`  files: ${event.filesTouched.map((file) => terminalSafe(file)).join(", ")}`);
        if (event.gitActions.length > 0) rows.push(`  git: ${event.gitActions.map((action) => terminalSafe(action.label ?? action.kind)).join(", ")}`);
        rows.push("");
      }
    }
    if (!session.complete) rows.push("Older cloud events were truncated.");
    output.writeStdout(`${rows.join("\n").trimEnd()}\n`);
    return;
  }
  const receipt = data as Readonly<{
    commandPublicId: string;
    kind: string;
    sessionPublicId: string;
    state: string;
  }>;
  output.writeStdout(`Queued ${terminalSafe(receipt.kind)} as ${terminalSafe(receipt.commandPublicId)} for ${terminalSafe(receipt.sessionPublicId)} (${terminalSafe(receipt.state)}).\n`);
}

async function executeRemoteInvocation(
  invocation: Extract<CliInvocation, { kind: "remote" }>,
  output: Output,
  input: Pick<CliMainInput, "getRemoteCommandStatus"> = {},
): Promise<number> {
  const paths = resolveStatePaths();
  const controller = new AbortController();
  const injectedStatus = invocation.command.kind === "remote.command"
    ? input.getRemoteCommandStatus
    : undefined;
  const control = injectedStatus === undefined
    ? createLocalCloudControlFromEnvironment({
        lifetimeSignal: controller.signal,
        secretCustody: await IdentityScopedCloudSecretCustody.open(
          new GenerationalSecretCustody(paths),
        ),
      })
    : null;
  if (control === null && injectedStatus === undefined) {
    return renderFailure({
      code: "UNAVAILABLE",
      message: "Cloud sync is not configured. Set HRA_CONVEX_URL and run `hra auth login`.",
    }, invocation.json, output);
  }
  const abort = () => controller.abort(new Error("Cloud remote operation was interrupted."));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    if (invocation.command.kind === "remote.list") {
      if (control === null) throw new Error("Cloud sync is not configured.");
      const data = await control.listRemoteSessionHeads({
        limit: invocation.command.limit,
        signal: controller.signal,
      });
      renderRemoteSuccess(invocation.command, data, invocation.json, output);
      return 0;
    }
    if (invocation.command.kind === "remote.command") {
      const getRemoteCommandStatus = injectedStatus ?? control?.getRemoteCommandStatus.bind(control);
      if (getRemoteCommandStatus === undefined) throw new Error("Cloud sync is not configured.");
      const data = await getRemoteCommandStatus({
        commandPublicId: invocation.command.commandPublicId,
        signal: controller.signal,
      });
      renderRemoteSuccess(invocation.command, data, invocation.json, output);
      return 0;
    }
    if (control === null) throw new Error("Cloud sync is not configured.");
    const selector = await control.resolveRemoteSession({
      selector: invocation.command.session,
      signal: controller.signal,
    });
    if (invocation.command.kind === "remote.show") {
      const data = await control.pullRemoteSession({ selector, signal: controller.signal });
      renderRemoteSuccess(invocation.command, data, invocation.json, output);
      return 0;
    }
    const payload = remotePayload(invocation.command);
    if (payload === null) throw new Error("Cloud remote command is invalid.");
    const now = Date.now();
    const idempotencyKey = invocation.idempotencyKey ?? createCloudUuidV7(now);
    if (!isUuidV7(idempotencyKey)) {
      throw new Error("Remote --idempotency-key must be a current UUIDv7.");
    }
    const shortLived = payload.kind === "steer" || payload.kind === "stop";
    const data = await control.enqueueRemoteCommand({
      commandPublicId: idempotencyKey,
      deadline: now + (shortLived ? 5 * 60 * 1_000 : 24 * 60 * 60 * 1_000),
      idempotencyKey,
      payload,
      selector,
      signal: controller.signal,
    });
    renderRemoteSuccess(invocation.command, data, invocation.json, output);
    return 0;
  } catch (error: unknown) {
    const diagnostic = invocation.command.kind === "remote.command" && error instanceof Error
      ? new Error(sanitizeSyncDiagnostic(error.message))
      : error;
    return remoteFailure(diagnostic, invocation.json, output);
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

class DaemonBootInterruptedError extends Error {
  constructor() {
    super("Daemon startup was interrupted before it published readiness.");
    this.name = "DaemonBootInterruptedError";
  }
}

class DaemonJoinDeadlineError extends Error {
  constructor(readonly operation: string, readonly deadlineMs: number) {
    super(`${operation} did not settle within ${deadlineMs}ms.`);
    this.name = "DaemonJoinDeadlineError";
  }
}

function safeDaemonFailure(error: unknown): string {
  if (error instanceof DaemonJoinDeadlineError || error instanceof LocalDaemonShutdownTimeoutError) {
    return `Forced recovery boundary: ${error.message}`;
  }
  if (error instanceof Error && /^STATE_SCHEMA_NEWER:\d+:\d+$/u.test(error.message)) {
    return error.message;
  }
  return "Daemon startup or shutdown failed before a safe readiness boundary.";
}

async function joinBeforeDeadline<T>(operation: string, promise: Promise<T>, deadlineMs = 5_000): Promise<T> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new DaemonJoinDeadlineError(operation, deadlineMs)), deadlineMs);
      }),
    ]);
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
}

async function runDaemon(): Promise<number> {
  const paths = resolveStatePaths();
  await initializeStatePaths(paths);
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  const daemonLock = await DaemonLock.acquire(paths);
  let store: StateStore | undefined;
  let codex: PinnedCodexRuntimeManager | undefined;
  let service: HraService | undefined;
  let server: LocalDaemonServer | undefined;
  let cloudAdapter: StateBackedCloudDaemonAdapter | undefined;
  let cloudLifecycle: CloudDaemonLifecycle | undefined;
  let usagePoller: AccountUsagePoller | undefined;
  let usagePollerShutdown: Promise<void> | undefined;
  let cloudRequestController: AbortController | undefined;
  let daemonAuthority: DaemonAuthorityFence | undefined;
  let serviceShutdown: Promise<void> | undefined;
  let generation: number | undefined;
  let bootId: string | undefined;
  let resolveStop!: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStop = resolve; });
  let stopRequested = false;
  const requestStop = () => {
    if (stopRequested) return;
    stopRequested = true;
    if (usagePoller !== undefined) usagePollerShutdown ??= usagePoller.close();
    if (service !== undefined) serviceShutdown = service.close();
    else daemonAuthority?.close();
    server?.beginShutdown(new Error("Daemon shutdown was requested."));
    resolveStop();
  };
  const onSignal = () => requestStop();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const cleanupErrors: unknown[] = [];
  let runError: unknown;
  const checkpointBoot = () => {
    if (stopRequested) throw new DaemonBootInterruptedError();
  };
  try {
    checkpointBoot();
    store = new StateStore(paths);
    const activeStore = store;
    bootId = `boot_${randomUUID().replaceAll("-", "")}`;
    generation = activeStore.nextDaemonGeneration(bootId);
    await daemonLock.publish({ state: "booting", generation, bootId });
    daemonAuthority = new DaemonAuthorityFence(daemonLock, { generation, bootId });
    const activeDaemonAuthority = daemonAuthority;
    checkpointBoot();
    const serviceReference: { current?: HraService } = {};
    codex = new PinnedCodexRuntimeManager({
      isCurrent: (authority) => {
        try {
          const profile = activeStore.requireProfile(authority.id);
          return profile.processGeneration === authority.generation && profile.state !== "removed";
        } catch {
          return false;
        }
      },
      observer: {
        account: async (authority, account) => {
          await serviceReference.current?.observeCodexAccount(authority, account);
        },
        fact: async (authority, fact) => { await serviceReference.current?.observeCodexFact(authority, fact); },
      },
    });
    const secretCustody = new GenerationalSecretCustody(paths);
    const cloudSecretCustody = await IdentityScopedCloudSecretCustody.open(secretCustody);
    const eventCursors = await resolveSessionEventCursorCodec(secretCustody);
    const cloudJournal = new CustodyCloudDaemonJournal(cloudSecretCustody);
    const projectionRecoveryBlocker = new CloudDaemonJournalRecoveryBlocker(cloudJournal, {
      isSessionTerminal: (sessionPublicId) => {
        try {
          return activeStore.requireSession(sessionPublicId).state === "terminal";
        } catch {
          return false;
        }
      },
    });
    cloudRequestController = new AbortController();
    const localCloudControl = createLocalCloudControlFromEnvironment({
      lifetimeSignal: cloudRequestController.signal,
      secretCustody: cloudSecretCustody,
    });
    let cloud = selectDaemonCloudControl(localCloudControl, projectionRecoveryBlocker);
    if (localCloudControl !== null) {
      const cloudCodex = new Proxy(codex, {
        get(target, property) {
          const value = Reflect.get(target, property, target) as unknown;
          if (typeof value !== "function") return value;
          if (property === "close") {
            return (...args: unknown[]): unknown => Reflect.apply(value, target, args) as unknown;
          }
          return async (...args: unknown[]) => {
            await activeDaemonAuthority.assertCurrent();
            const result = await Reflect.apply(value, target, args) as unknown;
            await activeDaemonAuthority.assertCurrent();
            return result;
          };
        },
      }) as CodexRuntimePort;
      cloudAdapter = new StateBackedCloudDaemonAdapter({
        codex: cloudCodex,
        executeRemote: async (command, expected, options) => {
          const current = serviceReference.current;
          if (current === undefined) throw new Error("The local command service is not ready.");
          return await current.executeRemote(command, expected, { signal: options.signal });
        },
        paths,
        store: activeStore,
        cloudIdentityNamespace: cloudSecretCustody.cacheNamespace,
      });
      const cloudBridge = createLocalCloudDaemonBridgeFromEnvironment({
        daemonAuthority: { bootGeneration: generation, bootId },
        daemonAuthorityFence: activeDaemonAuthority,
        executor: cloudAdapter,
        lifetimeSignal: cloudRequestController.signal,
        local: cloudAdapter,
        journal: cloudJournal,
        registration: localCloudControl,
        secretCustody: cloudSecretCustody,
      });
      if (cloudBridge === null) throw new Error("The cloud deployment changed during daemon startup.");
      cloud = new BridgedCloudControl(localCloudControl, cloudBridge, cloudAdapter);
      cloudLifecycle = createCloudDaemonLifecycle({ bridge: cloudBridge });
    }
    checkpointBoot();
    const desktop = process.platform === "darwin"
      ? (() => {
          const bundle = new ExactChatGptBundlePort("/Applications/ChatGPT.app");
          return new LocalDesktopSwitchPort({
            paths,
            store: activeStore,
            runtime: new PidBoundDesktopAccountRuntime({ codex, bundle }),
            bundle,
          });
        })()
      : undefined;
    const activeService = new HraService({
      store: activeStore,
      paths,
      codex,
      cloud,
      daemonAuthority: activeDaemonAuthority,
      daemonGeneration: generation,
      eventCursors,
      ...(desktop === undefined ? {} : { desktop }),
      requestStop,
    });
    serviceReference.current = activeService;
    service = activeService;
    const recovery = activeService.recover();
    const recoveryOutcome = await Promise.race([
      recovery.then(() => "recovered" as const),
      stopped.then(() => "interrupted" as const),
    ]);
    if (recoveryOutcome === "interrupted") {
      await joinBeforeDeadline("Interrupted daemon recovery", recovery);
      throw new DaemonBootInterruptedError();
    }
    checkpointBoot();
    usagePoller = new AccountUsagePoller({
      listAccountIds: () => activeStore.listProfiles()
        .filter((profile) => profile.state === "signed_in" && profile.processGeneration > 0)
        .map((profile) => profile.id),
      poll: async (accountId, signal) => {
        await activeService.execute(
          { kind: "account.usage", account: accountId, refresh: true },
          { signal },
        );
      },
    });
    usagePoller.start();
    cloudLifecycle?.start();
    server = await LocalDaemonServer.start({
      paths,
      handler: async (command, context) => {
        await daemonLock.assertCurrent();
        const data = await activeService.execute(command, { signal: context.signal, afterResponse: (callback) => context.afterResponse(callback) });
        if (command.kind !== "daemon.status" && command.kind !== "daemon.stop") return data;
        const daemon = identityFromReceipt(daemonLock.receipt);
        if (daemon === null) throw new Error("Daemon authority identity is not published.");
        return {
          ...(typeof data === "object" && data !== null ? data : {}),
          running: true,
          daemon,
        };
      },
    });
    checkpointBoot();
    await daemonLock.publish({ state: "ready", generation, bootId });
    await stopped;
    await daemonLock.publish({ state: "stopping", generation, bootId });
  } catch (error: unknown) {
    if (!(error instanceof DaemonBootInterruptedError)) runError = error;
  } finally {
    if (usagePoller !== undefined) usagePollerShutdown ??= usagePoller.close();
    if (service !== undefined) serviceShutdown ??= service.close();
    else daemonAuthority?.close();
    server?.beginShutdown(new Error("Daemon lifetime ended."));
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);

    const forceReason = runError instanceof DaemonJoinDeadlineError || runError instanceof LocalDaemonShutdownTimeoutError
      ? runError
      : undefined;
    if (forceReason === undefined && server !== undefined) {
      try { await server.close({ deadlineMs: 5_000 }); } catch (error: unknown) {
        if (error instanceof LocalDaemonShutdownTimeoutError) runError = error;
        else cleanupErrors.push(error);
      }
    }
    if (!(runError instanceof DaemonJoinDeadlineError) && !(runError instanceof LocalDaemonShutdownTimeoutError) && usagePollerShutdown !== undefined) {
      try { await joinBeforeDeadline("Usage poller shutdown", usagePollerShutdown); } catch (error: unknown) {
        if (error instanceof DaemonJoinDeadlineError) runError = error;
        else cleanupErrors.push(error);
      }
    }
    if (!(runError instanceof DaemonJoinDeadlineError) && !(runError instanceof LocalDaemonShutdownTimeoutError) && cloudLifecycle !== undefined) {
      try { await joinBeforeDeadline("Cloud daemon shutdown", cloudLifecycle.close()); } catch (error: unknown) {
        if (error instanceof DaemonJoinDeadlineError) runError = error;
        else cleanupErrors.push(error);
      }
    }
    cloudRequestController?.abort(new Error("Cloud daemon transport is closing."));
    if (!(runError instanceof DaemonJoinDeadlineError) && !(runError instanceof LocalDaemonShutdownTimeoutError) && cloudAdapter !== undefined) {
      try { cloudAdapter.close(); } catch (error: unknown) { cleanupErrors.push(error); }
    }
    if (!(runError instanceof DaemonJoinDeadlineError) && !(runError instanceof LocalDaemonShutdownTimeoutError)) {
      try {
        if (serviceShutdown !== undefined) await joinBeforeDeadline("Codex service shutdown", serviceShutdown);
        else if (codex !== undefined) await joinBeforeDeadline("Codex runtime shutdown", codex.close());
      } catch (error: unknown) {
        if (error instanceof DaemonJoinDeadlineError) runError = error;
        else cleanupErrors.push(error);
      }
    }

    if (runError instanceof DaemonJoinDeadlineError || runError instanceof LocalDaemonShutdownTimeoutError) {
      const diagnostic = safeDaemonFailure(runError);
      await daemonLock.publish({
        state: "failed",
        ...(generation === undefined || bootId === undefined ? {} : { generation, bootId }),
        failure: diagnostic,
      }).catch(() => undefined);
      process.stderr.write(`hra: ${diagnostic}\n`);
      process.exit(70);
    }

    if (store !== undefined) {
      if (generation !== undefined && bootId !== undefined) {
        try { store.markDaemonStopped(generation, bootId); } catch (error: unknown) { cleanupErrors.push(error); }
      }
      try { store.close(); } catch (error: unknown) { cleanupErrors.push(error); }
    }
    const normalizedRunError = runError === undefined ? undefined : safeDaemonFailure(runError);
    await daemonLock.release(normalizedRunError === undefined
      ? { state: "stopped" }
      : { state: "failed", failure: normalizedRunError }).catch((error: unknown) => cleanupErrors.push(error));
  }
  if (runError !== undefined) {
    const normalized = runError instanceof Error ? runError : new Error("HRA daemon failed with a non-Error value.");
    throw cleanupErrors.length === 0 ? normalized : new AggregateError([normalized, ...cleanupErrors], "HRA daemon failed and cleanup was incomplete.");
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "HRA daemon cleanup failed.");
  return 0;
}

const commandCaller = (
  input: CliMainInput,
): ((command: LocalCommand, signal?: AbortSignal) => Promise<CommandResponse>) =>
  input.callDaemon ?? callWithAutostart;

const protectedInputDescriptor = (source: ProtectedInputSource): number =>
  source.kind === "stdin" ? 0 : source.fd;

const protectedInputReplayCommand = (
  invocation: Extract<CliInvocation, {
    kind: "auth.login-protected" | "interaction.resolve-protected";
  }>,
): string => {
  if (invocation.kind === "auth.login-protected") {
    return "hra auth login --input-stdin --json < /path/to/protected.json";
  }
  const common = `${invocation.interaction} --revision ${String(invocation.expectedRevision)}`;
  if (invocation.resolution.kind === "user_answers") {
    return `hra interaction answer ${common} --input-stdin --json < /path/to/protected.json`;
  }
  if (invocation.resolution.kind === "permission_grant") {
    const scope = invocation.resolution.scope === null
      ? ""
      : ` --scope ${invocation.resolution.scope}`;
    return `hra interaction grant ${common}${scope} --input-stdin --json < /path/to/protected.json`;
  }
  return `hra interaction submit ${common} --action accept --input-stdin --json < /path/to/protected.json`;
};

const rejectJsonTerminalProtectedInput = (
  invocation: Extract<CliInvocation, {
    kind: "auth.login-protected" | "interaction.resolve-protected";
  }>,
  output: Output,
  input: CliMainInput,
): number | null => {
  if (!invocation.json) return null;
  const fd = protectedInputDescriptor(invocation.input);
  const terminal = (input.isTerminalDescriptor ?? isatty)(fd);
  if (!terminal) return null;
  return renderFailure({
    code: "INTERACTION_REQUIRED",
    details: {
      nextCommand: protectedInputReplayCommand(invocation),
      protectedInput: "non_terminal_stdin_or_fd",
    },
    message: "JSON mode never prompts. Redirect one protected JSON document from a non-terminal stdin or file descriptor.",
  }, true, output);
};

const renderJsonlFailure = (
  error: { code: string; message: string; details?: unknown },
  output: Output,
): number => renderFailure(error, true, {
  writeStdout: (value) => output.writeStderr(value),
  writeStderr: (value) => output.writeStderr(value),
});

const isClosedStdout = (error: unknown): boolean => {
  const code = error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : "";
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ERR_STREAM_WRITE_AFTER_END";
};

async function executeProtectedInteraction(
  invocation: Extract<CliInvocation, { kind: "interaction.resolve-protected" }>,
  output: Output,
  input: CliMainInput,
): Promise<number> {
  const terminalRefusal = rejectJsonTerminalProtectedInput(invocation, output, input);
  if (terminalRefusal !== null) return terminalRefusal;
  const document = await (input.readProtectedDocument ?? ((source) =>
    readProtectedDocument(source, output)))(invocation.input);
  const command = completeProtectedInteraction(invocation, document);
  const response = await commandCaller(input)(command);
  if (!response.ok) return renderFailure(response.error, invocation.json, output);
  renderSuccess(command, response.data, invocation.json, output);
  return 0;
}

async function executeProtectedAuthLogin(
  invocation: Extract<CliInvocation, { kind: "auth.login-protected" }>,
  output: Output,
  input: CliMainInput,
): Promise<number> {
  const terminalRefusal = rejectJsonTerminalProtectedInput(invocation, output, input);
  if (terminalRefusal !== null) return terminalRefusal;
  const document = await (input.readProtectedDocument ?? ((source) =>
    readProtectedDocument(source, output)))(invocation.input);
  const command = completeProtectedAuthLogin(invocation, document);
  const response = await commandCaller(input)(command);
  if (!response.ok) return renderFailure(response.error, invocation.json, output);
  renderSuccess(command, response.data, invocation.json, output);
  return 0;
}

async function executeSessionEventFollow(
  invocation: Extract<CliInvocation, { kind: "session.events.follow" }>,
  output: Output,
  input: CliMainInput,
): Promise<number> {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Session event follow stopped."));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    await followSessionEvents({
      command: invocation.command,
      fetchPage: async (command, signal) => {
        const response = await commandCaller(input)(command, signal);
        if (!response.ok) throw Object.assign(new Error(response.error.message), {
          commandError: response.error,
        });
        return response.data;
      },
      output,
      retryFetchError: async (error, consecutiveFailures, signal) => {
        const commandError = error !== null && typeof error === "object" && "commandError" in error
          ? (error as { commandError?: unknown }).commandError
          : undefined;
        const retryableCommand = commandError !== null
          && typeof commandError === "object"
          && "code" in commandError
          && commandError.code === "UNAVAILABLE";
        if (
          !(error instanceof LocalDaemonIndeterminateError)
          && !isLocalDaemonUnavailable(error)
          && !retryableCommand
        ) return false;
        const delayMs = Math.min(1_000, 25 * (2 ** Math.min(consecutiveFailures - 1, 5)));
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          const onAbort = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          }, delayMs);
          signal.addEventListener("abort", onAbort, { once: true });
        });
        return !signal.aborted;
      },
      signal: controller.signal,
    });
    return 0;
  } catch (error: unknown) {
    if (controller.signal.aborted) return 0;
    if (isClosedStdout(error)) return 0;
    const commandError = error !== null && typeof error === "object" && "commandError" in error
      ? (error as { commandError?: unknown }).commandError
      : undefined;
    if (
      commandError !== null
      && typeof commandError === "object"
      && "code" in commandError
      && typeof commandError.code === "string"
      && "message" in commandError
      && typeof commandError.message === "string"
    ) {
      return renderJsonlFailure(commandError as { code: string; message: string; details?: unknown }, output);
    }
    return renderJsonlFailure({
      code: "INTERNAL",
      message: error instanceof Error ? error.message : "Session event follow failed.",
    }, output);
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

const defaultReadShellLine = async (prompt: string): Promise<string | null> => {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
    historySize: 0,
  });
  try {
    return await terminal.question(prompt);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ERR_USE_AFTER_CLOSE") return null;
    throw error;
  } finally {
    terminal.close();
  }
};

const selectedId = (
  data: unknown,
  field: "account" | "session",
): string | null => {
  if (data === null || typeof data !== "object") return null;
  const value = (data as Record<string, unknown>)[field];
  if (value === null || typeof value !== "object") return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
};

export async function runPersistentShell(
  output: Output = processOutput,
  input: CliMainInput = {},
): Promise<number> {
  const readLine = input.readShellLine ?? defaultReadShellLine;
  const callDaemon = commandCaller(input);
  const status = await callDaemon({ kind: "daemon.status" });
  if (!status.ok) return renderFailure(status.error, false, output);
  daemonStatusIdentity(status);
  const live = new ShellLiveObserver({
    callDaemon,
    write: (value) => output.writeStderr(value),
  });
  let selection: ShellSelection = {};
  output.writeStderr("HRA shell. /help lists commands; /exit leaves the daemon running.\n");
  try {
    for (;;) {
      const line = await readLine(formatShellPrompt(selection));
      if (line === null) return 0;
      try {
        const intent = compileShellLine(line, selection);
        if (intent.kind === "noop") continue;
        if (intent.kind === "exit") return 0;
        if (intent.kind === "help") {
          output.writeStdout(`${shellHelp}\n`);
          continue;
        }
        if (intent.kind === "select-account") {
          const response = await callDaemon({ kind: "account.show", account: intent.selector });
          if (!response.ok) {
            renderFailure(response.error, false, output);
            continue;
          }
          const account = selectedId(response.data, "account");
          if (account === null) throw new Error("Selected account response is invalid.");
          await live.stop();
          selection = { account };
          output.writeStderr(`Selected account ${terminalSafe(account)}.\n`);
          continue;
        }
        if (intent.kind === "select-session") {
          const response = await callDaemon({ kind: "session.status", session: intent.selector });
          if (!response.ok) {
            renderFailure(response.error, false, output);
            continue;
          }
          const session = selectedId(response.data, "session");
          if (session === null) throw new Error("Selected session response is invalid.");
          const data = response.data as { session?: { profileId?: unknown } };
          const account = typeof data.session?.profileId === "string"
            ? data.session.profileId
            : selection.account;
          selection = { ...(account === undefined ? {} : { account }), session };
          output.writeStderr(`Selected session ${terminalSafe(session)}.\n`);
          await live.select({ session, statusData: response.data });
          continue;
        }
        await main(intent.argv, output, input);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Shell command failed.";
        output.writeStderr(`hra: ${safeDiagnostic(message)}\n`);
      }
    }
  } finally {
    await live.stop();
  }
}

const usageRefreshAllAccountLimit = 32;
const usageRefreshAllConcurrency = 4;

type UsageRefreshAccount = Readonly<{
  id: string;
  state: "signed_out" | "login_pending" | "signed_in" | "recovery_required" | "removed";
}>;

type UsageRefreshOutcome = Readonly<{
  accountId: string;
  state: "refreshed";
}> | Readonly<{
  accountId: string;
  accountState: UsageRefreshAccount["state"];
  reason: "not_signed_in";
  state: "skipped";
}> | Readonly<{
  accountId: string;
  code: "INVALID_INPUT" | "NOT_FOUND" | "AMBIGUOUS" | "CONFLICT" | "INTERACTION_REQUIRED" | "UNAVAILABLE" | "RECOVERY_REQUIRED" | "INTERNAL" | "INVALID_RESPONSE" | "TRANSPORT_FAILURE";
  state: "failed";
}>;

const orderedByAccountId = <T extends { accountId: string }>(left: T, right: T): number =>
  left.accountId < right.accountId ? -1 : left.accountId > right.accountId ? 1 : 0;

const refreshAllAccounts = (data: unknown): readonly UsageRefreshAccount[] | null => {
  if (!isRecord(data) || !Array.isArray(data.accounts)) return null;
  const accounts: UsageRefreshAccount[] = [];
  for (const value of data.accounts) {
    if (!isRecord(value)) return null;
    const id = profileIdSchema.safeParse(value.id);
    if (!id.success || !["signed_out", "login_pending", "signed_in", "recovery_required", "removed"].includes(String(value.state))) {
      return null;
    }
    accounts.push({ id: id.data, state: value.state as UsageRefreshAccount["state"] });
  }
  accounts.sort((left, right) => orderedByAccountId(
    { accountId: left.id },
    { accountId: right.id },
  ));
  if (new Set(accounts.map((account) => account.id)).size !== accounts.length) return null;
  return accounts;
};

const usageResponseContains = (data: unknown, accountId: string): boolean =>
  isRecord(data)
  && Array.isArray(data.usage)
  && data.usage.some((value) =>
    isRecord(value) && isRecord(value.account) && value.account.id === accountId);

const deterministicUsageData = (
  data: unknown,
  outcomes: readonly UsageRefreshOutcome[],
): Readonly<Record<string, unknown>> | null => {
  if (!isRecord(data) || !Array.isArray(data.usage)) return null;
  const rawUsage: readonly unknown[] = data.usage;
  const usage = [...rawUsage].sort((left, right) => {
    const leftId = isRecord(left) && isRecord(left.account) && typeof left.account.id === "string"
      ? left.account.id
      : "";
    const rightId = isRecord(right) && isRecord(right.account) && typeof right.account.id === "string"
      ? right.account.id
      : "";
    return orderedByAccountId({ accountId: leftId }, { accountId: rightId });
  });
  return {
    usage,
    refresh: {
      accountLimit: usageRefreshAllAccountLimit,
      concurrency: usageRefreshAllConcurrency,
      outcomes: [...outcomes].sort(orderedByAccountId),
    },
  };
};

const renderUsageRefreshAllPostEffectFailure = (
  outcomes: readonly UsageRefreshOutcome[],
  reasonCode: Extract<UsageRefreshOutcome, { state: "failed" }>["code"],
  json: boolean,
  output: Output,
): number => renderFailure({
  code: "UNAVAILABLE",
  details: {
    refresh: {
      accountLimit: usageRefreshAllAccountLimit,
      concurrency: usageRefreshAllConcurrency,
      outcomes: [...outcomes].sort(orderedByAccountId),
    },
    usageView: { reasonCode, state: "unavailable" },
  },
  message: "Refresh outcomes were recorded, but the final usage view is unavailable.",
}, json, output);

async function executeUsageRefreshAll(
  command: Extract<LocalCommand, { kind: "account.usage" }>,
  json: boolean,
  output: Output,
  input: CliMainInput,
): Promise<number> {
  const callDaemon = commandCaller(input);
  const listed = await callDaemon({ kind: "account.list" });
  if (!listed.ok) return renderFailure(listed.error, json, output);
  const accounts = refreshAllAccounts(listed.data);
  if (accounts === null) {
    return renderFailure({
      code: "INTERNAL",
      message: "The daemon returned an invalid account list.",
    }, json, output);
  }
  if (accounts.length > usageRefreshAllAccountLimit) {
    return renderFailure({
      code: "UNAVAILABLE",
      details: {
        accountCount: accounts.length,
        accountLimit: usageRefreshAllAccountLimit,
        nextCommand: "hra account usage <account> --refresh",
      },
      message: "Refresh-all exceeds the bounded account limit. Refresh one explicit account instead.",
    }, json, output);
  }

  const outcomes: UsageRefreshOutcome[] = accounts.map((account) => account.state === "signed_in"
    ? { accountId: account.id, code: "TRANSPORT_FAILURE", state: "failed" }
    : {
        accountId: account.id,
        accountState: account.state,
        reason: "not_signed_in",
        state: "skipped",
      });
  const signedIn = accounts
    .map((account, index) => ({ account, index }))
    .filter((entry) => entry.account.state === "signed_in");
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const workIndex = next;
      next += 1;
      const entry = signedIn[workIndex];
      if (entry === undefined) return;
      try {
        const response = await callDaemon({
          kind: "account.usage",
          account: entry.account.id,
          refresh: true,
        });
        outcomes[entry.index] = response.ok
          ? usageResponseContains(response.data, entry.account.id)
            ? { accountId: entry.account.id, state: "refreshed" }
            : { accountId: entry.account.id, code: "INVALID_RESPONSE", state: "failed" }
          : { accountId: entry.account.id, code: response.error.code, state: "failed" };
      } catch {
        outcomes[entry.index] = {
          accountId: entry.account.id,
          code: "TRANSPORT_FAILURE",
          state: "failed",
        };
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(usageRefreshAllConcurrency, signedIn.length) },
    worker,
  ));

  let history: CommandResponse;
  try {
    history = await callDaemon({ kind: "account.usage", refresh: false });
  } catch {
    return renderUsageRefreshAllPostEffectFailure(
      outcomes,
      "TRANSPORT_FAILURE",
      json,
      output,
    );
  }
  if (!history.ok) {
    return renderUsageRefreshAllPostEffectFailure(
      outcomes,
      history.error.code,
      json,
      output,
    );
  }
  const data = deterministicUsageData(history.data, outcomes);
  if (data === null) {
    return renderUsageRefreshAllPostEffectFailure(
      outcomes,
      "INVALID_RESPONSE",
      json,
      output,
    );
  }
  renderSuccess(command, data, json, output);
  return 0;
}

async function executeInvocation(
  invocation: CliInvocation,
  output: Output,
  input: CliMainInput = {},
): Promise<number> {
  if (invocation.kind === "help") { output.writeStdout(`${usageForGroup(invocation.group)}\n`); return 0; }
  if (invocation.kind === "version") { output.writeStdout(`hra ${HRA_VERSION}\n`); return 0; }
  if (invocation.kind === "init") return await initialize(invocation.yes, invocation.json, output);
  if (invocation.kind === "daemon.run") return await runDaemon();
  if (invocation.kind === "remote") return await executeRemoteInvocation(invocation, output, input);
  if (invocation.kind === "auth.login-protected") {
    return await executeProtectedAuthLogin(invocation, output, input);
  }
  if (invocation.kind === "interaction.resolve-protected") {
    return await executeProtectedInteraction(invocation, output, input);
  }
  if (invocation.kind === "session.events.follow") {
    return await executeSessionEventFollow(invocation, output, input);
  }
  if (invocation.kind === "interaction-required") {
    return renderFailure(invocation.error, invocation.json, output);
  }
  if (invocation.kind === "sync.projection-recover") {
    const response = await (input.callDaemon ?? callWithAutostart)(invocation.command);
    if (!response.ok) {
      return renderProjectionRecoveryFailure(response.error, invocation, output);
    }
    return renderProjectionRecoverySuccess(response.data, invocation, output);
  }
  if (invocation.kind === "daemon.start") {
    try {
      const existing = await callLocalDaemon({ paths: resolveStatePaths(), command: { kind: "daemon.status" }, deadlineMs: 500 });
      if (existing.ok) {
        daemonStatusIdentity(existing);
        renderSuccess({ kind: "daemon.status" }, existing.data, invocation.json, output);
        return 0;
      }
    } catch (error: unknown) {
      if (!isLocalDaemonUnavailable(error)) throw error;
    }
    await startDaemonProcess();
    const response = await callLocalDaemon({ paths: resolveStatePaths(), command: { kind: "daemon.status" } });
    if (!response.ok) return renderFailure(response.error, invocation.json, output);
    daemonStatusIdentity(response);
    renderSuccess({ kind: "daemon.status" }, response.data, invocation.json, output);
    return 0;
  }
  if (invocation.command.kind === "doctor" && invocation.command.offline) {
    return await offlineDoctor(invocation.json, output, input.statePaths ?? resolveStatePaths());
  }
  if (
    invocation.command.kind === "account.usage"
    && invocation.command.refresh
    && invocation.command.account === undefined
  ) {
    return await executeUsageRefreshAll(invocation.command, invocation.json, output, input);
  }
  if (invocation.command.kind === "session.note.edit") return await editSessionNote(invocation.command.session, invocation.json, output);
  if (invocation.command.kind === "daemon.status" || invocation.command.kind === "daemon.stop") {
    try {
      const paths = resolveStatePaths();
      const response = await callLocalDaemon({ paths, command: invocation.command, deadlineMs: 500 });
      if (!response.ok) return renderFailure(response.error, invocation.json, output);
      const identity = daemonStatusIdentity(response);
      let data = response.data;
      if (invocation.command.kind === "daemon.stop") {
        const released = await waitForDaemonAuthorityRelease({ paths, expected: identity });
        if (released.finalReceipt?.nonce === identity.nonce && released.finalReceipt.state === "failed") {
          return renderFailure({
            code: "RECOVERY_REQUIRED",
            message: `The daemon released authority with recovery required: ${released.finalReceipt.failure ?? "bounded shutdown failed"}`,
          }, invocation.json, output);
        }
        data = {
          ...(typeof response.data === "object" && response.data !== null ? response.data : {}),
          released: true,
          ...(released.replacement === null ? {} : { replacement: released.replacement }),
        };
      }
      renderSuccess(invocation.command, data, invocation.json, output);
    } catch (error: unknown) {
      if (!isLocalDaemonUnavailable(error)) throw error;
      renderSuccess(
        invocation.command,
        invocation.command.kind === "daemon.stop"
          ? { stopping: false, running: false }
          : { running: false },
        invocation.json,
        output,
      );
    }
    return 0;
  }
  const command = invocation.command.kind === "project.add"
    ? { ...invocation.command, path: await realpath(invocation.command.path) }
    : invocation.command;
  const response = await (input.callDaemon ?? callWithAutostart)(command);
  if (!response.ok) {
    return command.kind === "sync.now"
      ? renderSyncNowFailure(response.error, invocation.json, output)
      : renderFailure(response.error, invocation.json, output);
  }
  if (command.kind === "sync.now") {
    return renderSyncNowSuccess(response.data, invocation.json, output);
  }
  renderSuccess(command, response.data, invocation.json, output);
  return 0;
}

export async function main(
  argv: readonly string[] = Bun.argv.slice(2),
  output: Output = processOutput,
  input: CliMainInput = {},
): Promise<number> {
  const interactive = input.interactive
    ?? (process.stdin.isTTY && process.stderr.isTTY);
  if (argv.length === 0 && interactive) return await runPersistentShell(output, input);
  const json = requestsJsonOutput(argv);
  let invocation: CliInvocation | undefined;
  try {
    invocation = parseCli(argv);
    return await executeInvocation(invocation, output, input);
  } catch (error: unknown) {
    const syncNow = invocation?.kind === "command" && invocation.command.kind === "sync.now";
    const projectionRecovery = invocation?.kind === "sync.projection-recover"
      ? invocation
      : undefined;
    const sanitizeDaemonDiagnostic = (message: string): string =>
      syncNow || projectionRecovery !== undefined
        ? sanitizeSyncDiagnostic(message)
        : message;
    if (error instanceof CliUsageError) {
      if (json) return renderFailure({ code: "INVALID_INPUT", message: error.message }, true, output);
      output.writeStderr(`hra: ${safeDiagnostic(error.message)}\n\n${usageForGroup(undefined)}\n`);
      return 2;
    }
    if (error instanceof LocalDaemonIndeterminateError) {
      if (projectionRecovery !== undefined) {
        return renderFailure({
          code: "RECOVERY_REQUIRED",
          details: {
            idempotencyKey: projectionRecovery.command.idempotencyKey,
            nextCommand: projectionRecovery.replayCommand,
            sameKeyReplay: true,
          },
          message: `${sanitizeSyncDiagnostic(error.message)} The response is uncertain. Reuse the exact same-key command; HRA did not create a different recovery authority.`,
        }, json, output);
      }
      return renderFailure({
        code: "RECOVERY_REQUIRED",
        message: `${sanitizeDaemonDiagnostic(error.message)} HRA did not replay the command. Inspect its durable result before issuing another mutation.`,
      }, json, output);
    }
    if (error instanceof DaemonAuthorityBusyError) {
      return renderFailure({
        code: "UNAVAILABLE",
        message: sanitizeDaemonDiagnostic(error.message),
      }, json, output);
    }
    if (json) {
      return renderFailure({
        code: "INTERNAL",
        message: "HRA failed before a safe command response was available.",
      }, true, output);
    }
    output.writeStderr("hra: HRA failed before a safe command response was available.\n");
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
