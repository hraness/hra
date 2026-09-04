#!/usr/bin/env bun

import { dlopen } from "bun:ffi";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { readSync, type Stats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isatty } from "node:tty";

import { z } from "zod";

import {
  CliUsageError,
  accountLoginCancelCommand,
  accountLoginReplayCommand,
  completeProtectedAuthLogin,
  completeProtectedInteraction,
  deviceMutationReplayCommand,
  parseCli,
  projectionRecoveryReplayCommand,
  requestsJsonOutput,
  requestsJsonlOutput,
  requestsWorkApplyProtocol,
  resolveUsage,
  usageForGroup,
  type CliInvocation,
  type ProjectionRecoveryCliInvocation,
  type ProtectedInputSource,
  type RemoteCliCommand,
} from "./cli/parser";
import {
  parseAccountLoginAuthorityList,
  parseAccountLoginResponse,
  parseProtectedInteractionDetailResponse,
  ProtectedOutputError,
  ProtectedOutputFile,
  type DeviceLoginDocument,
} from "./cli/protected-output";
import { InvalidCommandResponseError, renderFailure, renderProtectedInteractionDetail, renderRootStatus, renderSuccess, safeDiagnostic, safeJson, terminalSafe, type Output } from "./cli/render";
import { redactCompleteSensitiveText } from "./cli/sensitive-text";
import { compileShellLine, formatShellPrompt, shellHelp, type ShellSelection } from "./cli/shell";
import {
  enumerateUnsettledSessionInteractions,
  pendingInteractionStateKey,
  ShellLiveObserver,
  ShellLivePresenter,
  type PendingInteraction,
} from "./cli/shell-live";
import { discardReadableUntilEnd, ShellTerminalCoordinator } from "./cli/shell-terminal";
import { followSessionEvents } from "./cli/watch";
import { followWorkEvents } from "./cli/work-watch";
import {
  BridgedCloudControl,
  CloudDaemonJournalRecoveryBlocker,
  CustodyCloudDaemonJournal,
  StateBackedCloudDaemonAdapter,
  containsAbsolutePath,
  createCloudDaemonLifecycle,
  createCloudUuidV7,
  cloudDeploymentAuthorityFromEnvironment,
  CloudDeploymentAuthorityError,
  createLocalCloudControlFromEnvironment,
  createLocalCloudDaemonBridgeFromEnvironment,
  DEFAULT_CLOUD_DEPLOYMENT_URL,
  DeploymentScopedCloudSecretCustody,
  IdentityScopedCloudSecretCustody,
  isRecord,
  isSafeNonNegativeInteger,
  isSafePositiveInteger,
  isUuidV7,
  hasExactKeys,
  projectionRecoveryStatusFromJournalState,
  readCloudDeploymentAuthority,
  redactAbsolutePaths,
  type CloudRemoteControlPort,
  type CloudRemoteSessionHead,
  type RemoteCommandPayload,
  type CloudDaemonLifecycle,
  type CloudDeploymentAuthority,
  type CloudProjectionRecoveryStatus,
  type CloudSecretCustodyPort,
} from "./cloud/index";
import { allowlistedEnvironment, resolvePinnedCodexRuntime } from "./codex/index";
import { localCommandSchema, type CommandResponse, type LocalCommand } from "./domain/contracts";
import {
  PROTECTED_INTERACTION_TERMINAL_MAXIMUM_BYTES,
} from "./domain/interactions";
import { sessionStatusSchema } from "./domain/observation";
import { profileIdSchema, selectByIdOrLabel, sessionIdSchema } from "./domain/values";
import {
  WORK_PROTOCOL_REQUEST_MAX_BYTES,
  WORK_PROTOCOL,
  WORK_PROTOCOL_VERSION,
  workProtocolRequestSchema,
} from "./domain/work";
import {
  describeWorkProtocol,
  workAgentProtocolResponseSchema,
  type WorkAgentProtocolError,
} from "./domain/work-protocol";
import {
  LocalDaemonServer,
  LocalDaemonIndeterminateError,
  LocalDaemonShutdownTimeoutError,
  callLocalDaemon,
  callWithSafeAutostart,
  isLocalDaemonUnavailable,
} from "./daemon/local-transport";
import {
  DaemonAuthorityBusyError,
  DaemonAuthorityFence,
  DaemonAuthoritySafetyError,
  DaemonLock,
  inspectDaemonAuthority,
  readDaemonAuthorityReceipt,
  type DaemonAuthorityInspection,
  type DaemonAuthorityReceipt,
} from "./daemon/daemon-lock";
import {
  daemonStatusIdentity,
  identityFromReceipt,
  sameDaemonIdentity,
  terminateDaemonStartupChild,
  waitForDaemonAuthorityRelease,
  waitForDaemonReady,
  type DaemonIdentity,
} from "./daemon/daemon-startup";
import { PinnedCodexRuntimeManager } from "./daemon/codex-runtime-adapter";
import { HraFactsMemoryLifecycle } from "./daemon/facts-memory-lifecycle";
import { UnavailableCloudControl, type CloudControlPort, type CodexRuntimePort, type CompactProjectionRecoveryBlocker } from "./daemon/ports";
import { SessionEventCursorCodec } from "./daemon/session-event-cursor";
import { CommandFailure, HraService } from "./daemon/service";
import { AccountUsagePoller } from "./daemon/usage-poller";
import { UsageHistoryCursorCodec } from "./daemon/usage-history-cursor";
import { ExactChatGptBundlePort, LocalDesktopSwitchPort, PidBoundDesktopAccountRuntime } from "./desktop/index";
import {
  assertInstallationHome,
  createProductionInstallation,
  type HraInstallation,
} from "./installation";
import { initializeStatePaths, resolveStatePaths, type StatePaths } from "./storage/paths";
import { FactsMemoryControlStore } from "./storage/facts-memory-control";
import { LocalFactsMemoryBroker } from "./storage/local-facts-memory-broker";
import { resolveUsableCanonicalProjectDirectory } from "./storage/project-directory";
import type { GenerationalSecretCustody } from "./storage/secret-custody";
import { StateStore } from "./storage/state-store";
import { WorkCapabilityCodec } from "./storage/work-capability";
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
  writeProtectedStderr: (value) => process.stderr.write(value),
};

const protectedInputMaximumBytes = 64 * 1024;
export const HUMAN_SESSION_WATCH_BOOTSTRAP_MAXIMUM_BYTES = 1 * 1024 * 1024;
const humanSessionWatchUtf8Encoder = new TextEncoder();
const sessionCursorCustodySlot = "session-cursor-key";

export const protectedTerminalInputQueueForPlatform = (
  platform: NodeJS.Platform,
): 0 | 1 | null => platform === "darwin" ? 1 : platform === "linux" ? 0 : null;

const terminalInputQueue = protectedTerminalInputQueueForPlatform(process.platform);

export const protectedTerminalControlLibrariesForPlatform = (
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): readonly string[] => {
  if (platform === "darwin") return ["/usr/lib/libSystem.B.dylib"];
  if (platform !== "linux") return [];
  const muslArchitecture = architecture === "x64"
    ? "x86_64"
    : architecture === "arm64"
      ? "aarch64"
      : null;
  if (muslArchitecture === null) return ["libc.so.6"];
  const muslLibrary = `libc.musl-${muslArchitecture}.so.1`;
  return [
    "libc.so.6",
    muslLibrary,
    `/lib/${muslLibrary}`,
    `/usr/lib/${muslLibrary}`,
  ];
};

type NativeTerminalControlLibrary = Readonly<{
  symbols: Readonly<{
    tcflush: (fd: number, queue: number) => number;
  }>;
}>;

let nativeTerminalControlLibrary: NativeTerminalControlLibrary | null | undefined;

const loadNativeTerminalControlLibrary = (): NativeTerminalControlLibrary | null => {
  if (nativeTerminalControlLibrary !== undefined) return nativeTerminalControlLibrary;
  nativeTerminalControlLibrary = null;
  for (const library of protectedTerminalControlLibrariesForPlatform(process.platform, process.arch)) {
    try {
      nativeTerminalControlLibrary = dlopen(library, {
        tcflush: { args: ["i32", "i32"], returns: "i32" },
      });
      break;
    } catch {
      // Try the next platform libc name. Protected input fails closed if none load.
    }
  }
  return nativeTerminalControlLibrary;
};

const flushProtectedTerminalInput = (fd: number): void => {
  const library = loadNativeTerminalControlLibrary();
  if (library === null || terminalInputQueue === null) {
    throw new CliUsageError("Protected terminal input could not establish an empty input queue.");
  }
  try {
    if (library.symbols.tcflush(fd, terminalInputQueue) === 0) return;
  } catch {
    // Preserve the same fail-closed, non-native diagnostic below.
  }
  throw new CliUsageError("Protected terminal input could not establish an empty input queue.");
};

const decodeProtectedJson = (
  bytes: Buffer,
  maximumBytes = protectedInputMaximumBytes,
): unknown => {
  if (bytes.byteLength === 0) throw new CliUsageError("Protected input is empty.");
  if (bytes.byteLength > maximumBytes) {
    throw new CliUsageError(`Protected input exceeds ${String(maximumBytes)} UTF-8 bytes.`);
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

const readBoundedDescriptor = (
  fd: number,
  maximumBytes = protectedInputMaximumBytes,
): Buffer => {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(8 * 1024, maximumBytes + 1 - total));
      const read = readSync(fd, chunk, 0, chunk.byteLength, null);
      if (read === 0) {
        chunk.fill(0);
        break;
      }
      chunks.push(chunk.subarray(0, read));
      total += read;
      if (total > maximumBytes) {
        throw new CliUsageError(`Protected input exceeds ${String(maximumBytes)} UTF-8 bytes.`);
      }
    }
    return Buffer.concat(chunks, total);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
};

type RawTerminalLineResult =
  | Readonly<{ bytes: Buffer; kind: "line" }>
  | Readonly<{ kind: "cancelled" | "ended" | "overflow" | "quit" | "suspended" }>;

class ProtectedTerminalRawSignalRequest extends Error {
  readonly signal: "SIGQUIT" | "SIGTSTP";

  constructor(signal: "SIGQUIT" | "SIGTSTP") {
    super(signal === "SIGTSTP"
      ? "Protected terminal input was suspended."
      : "Protected terminal input was interrupted by SIGQUIT.");
    this.name = "ProtectedTerminalRawSignalRequest";
    this.signal = signal;
  }
}

const bestEffortStderr = (output: Output, value: string): boolean => {
  try {
    output.writeStderr(value);
    return true;
  } catch {
    // Protected-input custody must not depend on display availability.
    return false;
  }
};

const abortRequested = (signal?: AbortSignal): boolean => signal?.aborted ?? false;
const rawSignalTailQuietMilliseconds = 50;
const rawSignalTailMaximumMilliseconds = 500;

const discardReadableNow = (input: NodeJS.ReadableStream): number => {
  const readable = input as unknown as {
    read(size?: number): Buffer | string | null;
  };
  let discarded = 0;
  for (;;) {
    const value = readable.read();
    if (value === null) return discarded;
    discarded += 1;
    if (Buffer.isBuffer(value)) value.fill(0);
  }
};

const readBoundedRawTerminalLine = (
  input: NodeJS.ReadableStream,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<RawTerminalLineResult> => new Promise((resolve) => {
  const storage = Buffer.alloc(maximumBytes + 1);
  let length = 0;
  let settled = false;
  const finish = (result: RawTerminalLineResult): void => {
    if (settled) {
      if (result.kind === "line") result.bytes.fill(0);
      return;
    }
    settled = true;
    input.off("data", onData);
    input.off("end", onEnded);
    input.off("error", onEnded);
    input.off("close", onEnded);
    signal?.removeEventListener("abort", onAbort);
    input.pause();
    storage.fill(0);
    resolve(result);
  };
  const onEnded = (): void => finish({ kind: "ended" });
  const onAbort = (): void => finish({ kind: "cancelled" });
  const onData = (value: unknown): void => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
    let result: RawTerminalLineResult | null = null;
    for (const byte of chunk) {
      if (byte === 0x03) {
        result = { kind: "cancelled" };
        break;
      }
      if (byte === 0x04) {
        result = { kind: "ended" };
        break;
      }
      if (byte === 0x1a) {
        result = { kind: "suspended" };
        break;
      }
      if (byte === 0x1c) {
        result = { kind: "quit" };
        break;
      }
      if (byte === 0x0a || byte === 0x0d) {
        result = { bytes: Buffer.from(storage.subarray(0, length)), kind: "line" };
        break;
      }
      if (byte === 0x08 || byte === 0x7f) {
        if (length > 0) {
          let removeFrom = length - 1;
          while (removeFrom > 0 && ((storage[removeFrom] ?? 0) & 0xc0) === 0x80) removeFrom -= 1;
          storage.fill(0, removeFrom, length);
          length = removeFrom;
        }
        continue;
      }
      if (length >= maximumBytes) {
        result = { kind: "overflow" };
        break;
      }
      storage[length] = byte;
      length += 1;
    }
    chunk.fill(0);
    if (result !== null) finish(result);
  };
  input.on("data", onData);
  input.once("end", onEnded);
  input.once("error", onEnded);
  input.once("close", onEnded);
  signal?.addEventListener("abort", onAbort, { once: true });
  const state = input as NodeJS.ReadableStream & { destroyed?: unknown; readableEnded?: unknown };
  if (signal?.aborted === true) {
    finish({ kind: "cancelled" });
    return;
  }
  if (state.destroyed === true || state.readableEnded === true) {
    finish({ kind: "ended" });
    return;
  }
  input.resume();
});

const drainRawTerminalUntilQuiet = (
  input: NodeJS.ReadableStream,
  quietMilliseconds = 20,
  maximumMilliseconds = 500,
  signal?: AbortSignal,
): Promise<"cancelled" | "continuous" | "ended" | "quiet" | "quit" | "suspended"> => new Promise((resolve) => {
  let settled = false;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  const maximumTimer = setTimeout(() => finish("continuous"), maximumMilliseconds);
  const armQuietTimer = (): void => {
    if (quietTimer !== null) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => finish("quiet"), quietMilliseconds);
  };
  const finish = (result: "cancelled" | "continuous" | "ended" | "quiet" | "quit" | "suspended"): void => {
    if (settled) return;
    settled = true;
    if (quietTimer !== null) clearTimeout(quietTimer);
    clearTimeout(maximumTimer);
    input.off("data", onData);
    input.off("end", onEnded);
    input.off("error", onEnded);
    input.off("close", onEnded);
    signal?.removeEventListener("abort", onAbort);
    input.pause();
    resolve(result);
  };
  const onEnded = (): void => finish("ended");
  const onAbort = (): void => finish("cancelled");
  const onData = (value: unknown): void => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
    const cancelled = chunk.includes(0x03);
    const ended = chunk.includes(0x04);
    const suspended = chunk.includes(0x1a);
    const quit = chunk.includes(0x1c);
    chunk.fill(0);
    if (cancelled) {
      finish("cancelled");
      return;
    }
    if (suspended) {
      finish("suspended");
      return;
    }
    if (quit) {
      finish("quit");
      return;
    }
    if (ended) {
      finish("ended");
      return;
    }
    armQuietTimer();
  };
  input.on("data", onData);
  input.once("end", onEnded);
  input.once("error", onEnded);
  input.once("close", onEnded);
  signal?.addEventListener("abort", onAbort, { once: true });
  const state = input as NodeJS.ReadableStream & { destroyed?: unknown; readableEnded?: unknown };
  if (signal?.aborted === true) {
    finish("cancelled");
    return;
  }
  if (state.destroyed === true || state.readableEnded === true) {
    finish("ended");
    return;
  }
  armQuietTimer();
  input.resume();
});

const discardRawSignalTailUntilQuiet = (
  input: NodeJS.ReadableStream,
  quietMilliseconds = 20,
  maximumMilliseconds = 500,
  signal?: AbortSignal,
): Promise<"cancelled" | "continuous" | "ended" | "quiet"> => new Promise((resolve) => {
  let settled = false;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  const maximumTimer = setTimeout(() => finish("continuous"), maximumMilliseconds);
  const armQuietTimer = (): void => {
    if (quietTimer !== null) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => finish("quiet"), quietMilliseconds);
  };
  const finish = (result: "cancelled" | "continuous" | "ended" | "quiet"): void => {
    if (settled) return;
    settled = true;
    if (quietTimer !== null) clearTimeout(quietTimer);
    clearTimeout(maximumTimer);
    input.off("data", onData);
    input.off("end", onEnded);
    input.off("error", onEnded);
    input.off("close", onEnded);
    signal?.removeEventListener("abort", onAbort);
    input.pause();
    resolve(result);
  };
  const onEnded = (): void => finish("ended");
  const onAbort = (): void => finish("cancelled");
  const onData = (value: unknown): void => {
    if (Buffer.isBuffer(value)) value.fill(0);
    armQuietTimer();
  };
  input.on("data", onData);
  input.once("end", onEnded);
  input.once("error", onEnded);
  input.once("close", onEnded);
  signal?.addEventListener("abort", onAbort, { once: true });
  const state = input as NodeJS.ReadableStream & { destroyed?: unknown; readableEnded?: unknown };
  if (signal?.aborted === true) {
    finish("cancelled");
    return;
  }
  if (state.destroyed === true || state.readableEnded === true) {
    finish("ended");
    return;
  }
  armQuietTimer();
  input.resume();
});

const discardRawTerminalUntilExit = (
  input: NodeJS.ReadableStream,
  signal?: AbortSignal,
): Promise<"continuous" | "exited" | "quit" | "suspended"> =>
  new Promise((resolve) => {
    let settled = false;
    let requestedSignal: "quit" | "suspended" | null = null;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    let maximumTimer: ReturnType<typeof setTimeout> | null = null;
    const armSignalQuietTimer = (): void => {
      if (quietTimer !== null) clearTimeout(quietTimer);
      quietTimer = setTimeout(
        () => finish(requestedSignal ?? "continuous"),
        rawSignalTailQuietMilliseconds,
      );
      maximumTimer ??= setTimeout(() => finish("continuous"), rawSignalTailMaximumMilliseconds);
    };
    const finish = (
      result: "continuous" | "exited" | "quit" | "suspended" = "exited",
    ): void => {
      if (settled) return;
      settled = true;
      if (quietTimer !== null) clearTimeout(quietTimer);
      if (maximumTimer !== null) clearTimeout(maximumTimer);
      input.off("data", onData);
      input.off("end", onEnded);
      input.off("error", onEnded);
      input.off("close", onEnded);
      signal?.removeEventListener("abort", onEnded);
      input.pause();
      resolve(result);
    };
    const onEnded = (): void => finish();
    const onData = (value: unknown): void => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
      const suspended = chunk.includes(0x1a);
      const quit = chunk.includes(0x1c);
      const exitRequested = chunk.includes(0x03) || chunk.includes(0x04);
      chunk.fill(0);
      if (requestedSignal !== null) {
        armSignalQuietTimer();
      } else if (suspended || quit) {
        requestedSignal = suspended ? "suspended" : "quit";
        armSignalQuietTimer();
      } else if (exitRequested) {
        finish();
      }
    };
    input.on("data", onData);
    input.once("end", onEnded);
    input.once("error", onEnded);
    input.once("close", onEnded);
    signal?.addEventListener("abort", onEnded, { once: true });
    const state = input as NodeJS.ReadableStream & { destroyed?: unknown; readableEnded?: unknown };
    if (signal?.aborted === true || state.destroyed === true || state.readableEnded === true) {
      finish();
      return;
    }
    input.resume();
  });

export const readHiddenProtectedLineFromTerminal = async (
  input: NodeJS.ReadableStream,
  output: Output,
  flushInput: () => void,
  signal?: AbortSignal,
): Promise<Buffer> => {
  if (signal?.aborted === true) {
    throw new CliUsageError("Protected terminal input is unavailable because the shell terminal closed.");
  }
  try {
    discardReadableNow(input);
    flushInput();
    discardReadableNow(input);
  } catch {
    const noticeVisible = bestEffortStderr(output,
      "Protected input cannot prove an empty terminal queue. HRA will discard input until EOF; press Ctrl-D to return safely.\n",
    );
    if (!noticeVisible || await discardReadableUntilEnd(input, signal) === "aborted") {
      input.pause();
      discardReadableNow(input);
      (input as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    }
    throw new CliUsageError("Protected terminal input could not establish an empty input queue.");
  }
  const tty = input as NodeJS.ReadableStream & {
    isRaw?: boolean;
    setRawMode?: (mode: boolean) => unknown;
  };
  if (typeof tty.setRawMode !== "function") {
    throw new CliUsageError("Protected terminal input cannot establish raw no-echo mode.");
  }
  const wasRaw = tty.isRaw === true;
  let rawModeActive = false;
  let promptWritten = false;
  const displayState = { requiredAvailable: true };
  let pendingAnswer: Buffer | null = null;
  let releaseAnswer = false;
  const writeRequiredPrompt = (value: string): void => {
    try {
      output.writeStderr(value);
    } catch {
      displayState.requiredAvailable = false;
      throw new CliUsageError("Protected terminal input closed because its prompt became unavailable.");
    }
  };
  const restoreRawMode = (): void => {
    if (!rawModeActive) return;
    let lastFailure: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        tty.setRawMode?.(wasRaw);
        if (tty.isRaw === wasRaw) {
          rawModeActive = false;
          return;
        }
      } catch (error: unknown) {
        lastFailure = error;
        if (tty.isRaw === wasRaw) {
          rawModeActive = false;
          return;
        }
      }
    }
    input.pause();
    discardReadableNow(input);
    (input as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    rawModeActive = false;
    throw new CliUsageError(
      lastFailure === null
        ? "Protected terminal input was closed because raw mode could not be restored."
        : "Protected terminal input was closed because raw mode restoration failed.",
    );
  };
  let rawActivationProved = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      tty.setRawMode(true);
      if (tty.isRaw === true) {
        rawActivationProved = true;
        break;
      }
    } catch {
      if (tty.isRaw === true) {
        rawActivationProved = true;
        break;
      }
    }
  }
  if (!rawActivationProved) {
    discardReadableNow(input);
    try {
      flushInput();
      discardReadableNow(input);
    } catch {
      // Fencing the stream below does not depend on a successful final flush.
    }
    bestEffortStderr(output,
      "Protected terminal input could not disable echo. HRA closed this shell input before reading protected bytes.\n");
    input.pause();
    (input as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    throw new CliUsageError("Protected terminal input could not establish raw no-echo mode.");
  }
  rawModeActive = true;
  try {
    const beginPhrase = `BEGIN-${randomUUID().slice(0, 6).toUpperCase()}`;
    const beginPhraseBytes = Buffer.from(beginPhrase, "utf8");
    writeRequiredPrompt(
      `Protected input is hidden. Type ${beginPhrase} and press Enter to begin (input remains hidden): `,
    );
    promptWritten = true;
    let readinessAttempts = 0;
    let readinessBytes = 0;
    for (;;) {
      const readiness = await readBoundedRawTerminalLine(input, 4 * 1_024, signal);
      if (readiness.kind === "line") {
        readinessAttempts += 1;
        readinessBytes += readiness.bytes.byteLength;
        const accepted = readiness.bytes.equals(beginPhraseBytes);
        readiness.bytes.fill(0);
        if (accepted) break;
        if (readinessAttempts >= 8 || readinessBytes > 8 * 1_024) {
          beginPhraseBytes.fill(0);
          bestEffortStderr(output,
            "\nhra: Protected-input readiness could not prove a human handoff. HRA will discard input until EOF; press Ctrl-D to return safely.\n");
          throw new CliUsageError("Protected terminal input could not establish a bounded readiness handoff.");
        }
        writeRequiredPrompt(`\nhra: Queued input was discarded. Type ${beginPhrase} and press Enter: `);
        continue;
      }
      if (readiness.kind === "suspended") throw new ProtectedTerminalRawSignalRequest("SIGTSTP");
      if (readiness.kind === "quit") throw new ProtectedTerminalRawSignalRequest("SIGQUIT");
      if (readiness.kind === "cancelled") {
        throw new CliUsageError("Protected interaction input was cancelled.");
      }
      if (readiness.kind === "ended") {
        throw new CliUsageError("Protected terminal input ended before a document was received.");
      }
      bestEffortStderr(output,
        "\nhra: Protected-input readiness exceeded its bound. HRA will discard input until EOF; press Ctrl-D to return safely.\n");
      throw new CliUsageError("Protected-input readiness exceeded its bounded line size.");
    }
    beginPhraseBytes.fill(0);
    const quiet = await drainRawTerminalUntilQuiet(input, 20, 500, signal);
    if (quiet === "suspended") throw new ProtectedTerminalRawSignalRequest("SIGTSTP");
    if (quiet === "quit") throw new ProtectedTerminalRawSignalRequest("SIGQUIT");
    if (quiet === "cancelled") throw new CliUsageError("Protected interaction input was cancelled.");
    if (quiet === "ended") {
      throw new CliUsageError("Protected terminal input ended before a document was received.");
    }
    if (quiet === "continuous") {
      bestEffortStderr(output,
        "\nhra: Protected input did not become quiet. HRA will discard input until EOF; press Ctrl-D to return safely.\n");
      throw new CliUsageError("Protected terminal input could not establish a quiet input boundary.");
    }
    discardReadableNow(input);
    try {
      flushInput();
      discardReadableNow(input);
    } catch {
      bestEffortStderr(output,
        "\nhra: Protected input cannot prove an empty terminal queue. HRA will discard input until EOF; press Ctrl-D to return safely.\n");
      throw new CliUsageError("Protected terminal input could not establish an empty input queue.");
    }
    writeRequiredPrompt("\nProtected JSON input (hidden): ");
    const answer = await readBoundedRawTerminalLine(input, protectedInputMaximumBytes, signal);
    if (answer.kind === "line") {
      pendingAnswer = answer.bytes;
      const resumePhrase = `RESUME-${randomUUID().slice(0, 6).toUpperCase()}`;
      const resumePhraseBytes = Buffer.from(resumePhrase, "utf8");
      writeRequiredPrompt(
        `\nProtected input captured. Type ${resumePhrase} and press Enter to return to HRA (input remains hidden): `,
      );
      let handoffAttempts = 0;
      let handoffBytes = 0;
      for (;;) {
        const handoff = await readBoundedRawTerminalLine(input, 128, signal);
        if (handoff.kind === "line") {
          handoffAttempts += 1;
          handoffBytes += handoff.bytes.byteLength;
          const accepted = handoff.bytes.equals(resumePhraseBytes);
          handoff.bytes.fill(0);
          if (accepted) break;
          if (handoffAttempts >= 8 || handoffBytes > 1_024) {
            resumePhraseBytes.fill(0);
            answer.bytes.fill(0);
            bestEffortStderr(output,
              "\nhra: Protected-input return could not prove a human handoff. HRA will discard input until EOF; press Ctrl-D to return safely.\n");
            throw new CliUsageError("Protected terminal input could not establish a bounded return handoff.");
          }
          writeRequiredPrompt(`\nhra: Trailing input was discarded. Type ${resumePhrase} and press Enter: `);
          continue;
        }
        answer.bytes.fill(0);
        if (handoff.kind === "suspended") throw new ProtectedTerminalRawSignalRequest("SIGTSTP");
        if (handoff.kind === "quit") throw new ProtectedTerminalRawSignalRequest("SIGQUIT");
        if (handoff.kind === "cancelled") {
          throw new CliUsageError("Protected interaction input was cancelled.");
        }
        if (handoff.kind === "ended") {
          throw new CliUsageError("Protected terminal input ended before custody was returned.");
        }
        bestEffortStderr(output,
          "\nhra: Protected-input handoff exceeded its bound. HRA will discard input until EOF; press Ctrl-D to return safely.\n");
        throw new CliUsageError("Protected terminal input could not establish a bounded handoff.");
      }
      resumePhraseBytes.fill(0);
      const trailing = await drainRawTerminalUntilQuiet(input, 20, 500, signal);
      if (trailing === "suspended") {
        answer.bytes.fill(0);
        throw new ProtectedTerminalRawSignalRequest("SIGTSTP");
      }
      if (trailing === "quit") {
        answer.bytes.fill(0);
        throw new ProtectedTerminalRawSignalRequest("SIGQUIT");
      }
      if (trailing === "ended") {
        releaseAnswer = true;
        return answer.bytes;
      }
      if (trailing === "cancelled") {
        answer.bytes.fill(0);
        throw new CliUsageError("Protected interaction input was cancelled.");
      }
      if (trailing === "continuous") {
        answer.bytes.fill(0);
        bestEffortStderr(output,
          "\nhra: Protected input retained a continuing tail. HRA will discard input until EOF; press Ctrl-D to return safely.\n");
        throw new CliUsageError("Protected terminal input could not establish a quiet trailing boundary.");
      }
      discardReadableNow(input);
      try {
        flushInput();
        discardReadableNow(input);
      } catch {
        answer.bytes.fill(0);
        bestEffortStderr(output,
          "\nhra: Protected input cannot prove an empty trailing queue. HRA will discard input until EOF; press Ctrl-D to return safely.\n");
        throw new CliUsageError("Protected terminal input could not establish an empty trailing queue.");
      }
      releaseAnswer = true;
      return answer.bytes;
    }
    if (answer.kind === "suspended") throw new ProtectedTerminalRawSignalRequest("SIGTSTP");
    if (answer.kind === "quit") throw new ProtectedTerminalRawSignalRequest("SIGQUIT");
    if (answer.kind === "cancelled") {
      throw new CliUsageError("Protected interaction input was cancelled.");
    }
    if (answer.kind === "ended") {
      throw new CliUsageError("Protected terminal input ended before a document was received.");
    }
    bestEffortStderr(output,
      "\nhra: Protected input exceeded its bound. HRA will discard input until EOF; press Ctrl-D to return safely.\n");
    throw new CliUsageError(`Protected input exceeds ${String(protectedInputMaximumBytes)} UTF-8 bytes.`);
  } catch (error: unknown) {
    const state = input as NodeJS.ReadableStream & { destroyed?: unknown; readableEnded?: unknown };
    let failure = error;
    if (error instanceof ProtectedTerminalRawSignalRequest) {
      const tail = state.destroyed === true || state.readableEnded === true
        ? "ended"
        : await discardRawSignalTailUntilQuiet(
            input,
            rawSignalTailQuietMilliseconds,
            rawSignalTailMaximumMilliseconds,
            signal,
          );
      let boundaryProved = tail === "ended" || tail === "quiet";
      discardReadableNow(input);
      if (boundaryProved) {
        try {
          flushInput();
          discardReadableNow(input);
        } catch {
          boundaryProved = false;
        }
      }
      if (!boundaryProved) {
        bestEffortStderr(output,
          "\nhra: Protected input could not prove a quiet signal boundary. HRA closed this shell input without re-signalling.\n");
        failure = new CliUsageError(
          "Protected terminal input could not establish a quiet signal boundary.",
        );
      }
      restoreRawMode();
      if (state.destroyed !== true) {
        (input as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      }
    } else if (state.destroyed !== true && state.readableEnded !== true) {
      const immediateFence = !displayState.requiredAvailable || abortRequested(signal);
      if (!immediateFence) {
        bestEffortStderr(output,
          "\nhra: Protected input remains hidden while HRA discards its tail. Press Ctrl-D or Ctrl-C; HRA will then close this shell input safely.\n");
        const exit = await discardRawTerminalUntilExit(input, signal);
        if (exit === "suspended") {
          failure = new ProtectedTerminalRawSignalRequest("SIGTSTP");
        } else if (exit === "quit") {
          failure = new ProtectedTerminalRawSignalRequest("SIGQUIT");
        } else if (exit === "continuous") {
          failure = new CliUsageError(
            "Protected terminal input could not establish a quiet signal boundary.",
          );
        }
      }
      discardReadableNow(input);
      try {
        flushInput();
        discardReadableNow(input);
      } catch {
        if (failure instanceof ProtectedTerminalRawSignalRequest) {
          failure = new CliUsageError(
            "Protected terminal input could not establish an empty signal boundary.",
          );
        }
      }
      restoreRawMode();
      (input as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    }
    throw failure;
  } finally {
    let rawRestored = false;
    try {
      restoreRawMode();
      rawRestored = true;
    } finally {
      if (!rawRestored || !releaseAnswer) pendingAnswer?.fill(0);
      input.pause();
      if (promptWritten) bestEffortStderr(output, "\n");
    }
  }
};

const readHiddenProtectedLine = async (output: Output, signal?: AbortSignal): Promise<Buffer> =>
  await readHiddenProtectedLineFromTerminal(
    process.stdin,
    output,
    () => flushProtectedTerminalInput(0),
    signal,
  );

const readProtectedDocument = async (
  source: ProtectedInputSource,
  output: Output,
  signal?: AbortSignal,
  maximumBytes = protectedInputMaximumBytes,
): Promise<unknown> => {
  const fd = source.kind === "stdin" ? 0 : source.fd;
  let bytes: Buffer;
  try {
    if (isatty(fd)) {
      if (fd !== 0) {
        throw new CliUsageError("Protected input from a terminal is supported only through stdin.");
      }
      bytes = await readHiddenProtectedLine(output, signal);
    } else {
      bytes = readBoundedDescriptor(fd, maximumBytes);
    }
  } catch (error: unknown) {
    if (error instanceof CliUsageError) throw error;
    throw new CliUsageError("Protected input could not be read from the selected descriptor.");
  }
  return decodeProtectedJson(bytes, maximumBytes);
};

export type ProtectedTerminalLifecycleHooks = Readonly<{
  onOutputFailure: (listener: () => void) => () => void;
  onSignal: (signal: NodeJS.Signals, listener: () => void) => () => void;
  resignal: (signal: NodeJS.Signals) => void;
}>;

const processProtectedTerminalLifecycleHooks: ProtectedTerminalLifecycleHooks = {
  onOutputFailure: (listener) => {
    process.stderr.once("error", listener);
    process.stderr.once("close", listener);
    const state = process.stderr as NodeJS.WritableStream & { destroyed?: unknown };
    if (state.destroyed === true) listener();
    return () => {
      process.stderr.off("error", listener);
      process.stderr.off("close", listener);
    };
  },
  onSignal: (signal, listener) => {
    process.once(signal, listener);
    return () => process.off(signal, listener);
  },
  resignal: (signal) => process.kill(process.pid, signal),
};

const protectedTerminalLifecycleSignals: readonly NodeJS.Signals[] = process.platform === "win32"
  ? ["SIGINT", "SIGTERM"]
  : ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGTSTP"];

export const withProtectedTerminalLifecycle = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
  hooks: ProtectedTerminalLifecycleHooks = processProtectedTerminalLifecycleHooks,
): Promise<T> => {
  const controller = new AbortController();
  const removers: (() => void)[] = [];
  const lifecycleState: { receivedSignal: NodeJS.Signals | null } = { receivedSignal: null };
  const abortForOutput = (): void => controller.abort(
    new CliUsageError("Protected terminal input closed because its prompt output became unavailable."),
  );
  const abortForParent = (): void => controller.abort(
    parentSignal?.reason ?? new CliUsageError("Protected terminal input lifecycle ended."),
  );
  try {
    removers.push(hooks.onOutputFailure(abortForOutput));
    for (const signal of protectedTerminalLifecycleSignals) {
      removers.push(hooks.onSignal(signal, () => {
        if (lifecycleState.receivedSignal === null) lifecycleState.receivedSignal = signal;
        controller.abort(new CliUsageError(`Protected terminal input interrupted by ${signal}.`));
      }));
    }
    if (parentSignal !== undefined) {
      parentSignal.addEventListener("abort", abortForParent, { once: true });
      removers.push(() => parentSignal.removeEventListener("abort", abortForParent));
      if (parentSignal.aborted) abortForParent();
    }
    try {
      return await operation(controller.signal);
    } catch (error: unknown) {
      if (error instanceof ProtectedTerminalRawSignalRequest && lifecycleState.receivedSignal === null) {
        lifecycleState.receivedSignal = error.signal;
      }
      throw error;
    }
  } finally {
    for (const remove of removers.reverse()) remove();
    if (lifecycleState.receivedSignal !== null) {
      try {
        hooks.resignal(lifecycleState.receivedSignal);
      } catch {
        // Raw mode has already been restored or fenced; signal delivery is best effort.
      }
    }
  }
};

class CursorAuthorityMissingError extends Error {
  constructor() {
    super(
      "Session event cursor authority is missing for existing HRA state. Restore the original local secret before starting the daemon.",
    );
    this.name = "CursorAuthorityMissingError";
  }
}

async function resolveCursorAuthorityKey(
  custody: GenerationalSecretCustody,
  allowInitialization: boolean,
): Promise<string> {
  let observation = await custody.read(sessionCursorCustodySlot);
  if (observation === null) {
    if (!allowInitialization) {
      throw new CursorAuthorityMissingError();
    }
    observation = await custody.compareAndSwap(
      sessionCursorCustodySlot,
      null,
      SessionEventCursorCodec.generateKey(),
    );
    if (observation === null) observation = await custody.read(sessionCursorCustodySlot);
  }
  if (observation === null) throw new Error("Session event cursor authority could not be initialized.");
  return observation.value;
}

export async function resolveSessionEventCursorCodec(
  custody: GenerationalSecretCustody,
  options: Readonly<{ allowInitialization?: boolean }> = {},
): Promise<SessionEventCursorCodec> {
  return new SessionEventCursorCodec(await resolveCursorAuthorityKey(
    custody,
    options.allowInitialization ?? true,
  ));
}

export async function resolveUsageHistoryCursorCodec(
  custody: GenerationalSecretCustody,
  options: Readonly<{ allowInitialization?: boolean }> = {},
): Promise<UsageHistoryCursorCodec> {
  return new UsageHistoryCursorCodec(await resolveCursorAuthorityKey(
    custody,
    options.allowInitialization ?? true,
  ));
}

export async function resolveWorkCapabilityCodec(
  custody: GenerationalSecretCustody,
  options: Readonly<{ allowInitialization?: boolean }> = {},
): Promise<WorkCapabilityCodec> {
  const encoded = await resolveCursorAuthorityKey(
    custody,
    options.allowInitialization ?? true,
  );
  const key = Buffer.from(encoded, "base64url");
  if (key.toString("base64url") !== encoded) {
    throw new Error("Work capability authority is not canonical base64url.");
  }
  return new WorkCapabilityCodec(key);
}

const syncDiagnosticLimit = 16;
const syncDiagnosticMaximumBytes = 768;
const syncDiagnosticTruncationMarker = " [truncated]";
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
      nextCommand: "hra sync status --json";
      phase: "rejected";
      rejectionCode: string;
      sameKeyReplay: Readonly<{
        command: string;
        supported: true;
      }>;
      session: string;
    }>;

type DaemonStopCommand = Extract<LocalCommand, { kind: "daemon.stop" }>;
type BoundDaemonStopCommand = DaemonStopCommand & Readonly<{ expected: DaemonIdentity }>;
type DaemonStopResponseError = Extract<CommandResponse, { ok: false }>["error"];
type DaemonReleaseObservation = Awaited<ReturnType<typeof waitForDaemonAuthorityRelease>>;

export type DaemonStopDependencies = Readonly<{
  requestStop(input: Readonly<{
    paths: StatePaths;
    command: BoundDaemonStopCommand;
    deadlineMs: number;
  }>): Promise<CommandResponse>;
  observeReceipt(paths: StatePaths): Promise<DaemonAuthorityReceipt | null>;
  waitForRelease(input: Readonly<{
    paths: StatePaths;
    expected: DaemonIdentity;
  }>): Promise<DaemonReleaseObservation>;
  inspectAuthority(paths: StatePaths): Promise<DaemonAuthorityInspection>;
  authorityHeld(paths: StatePaths): Promise<boolean>;
  sleep(milliseconds: number): Promise<void>;
}>;

export type DaemonStopResult =
  | Readonly<{ kind: "success"; data: Readonly<Record<string, unknown>> }>
  | Readonly<{ kind: "failure"; error: DaemonStopResponseError }>;

export type DaemonReadyStatus = Readonly<{
  running: true;
  pid: number;
  daemon: DaemonIdentity;
}>;

export type CliMainInput = Readonly<{
  installation?: HraInstallation;
  startDaemon?: (installation: HraInstallation) => Promise<DaemonReadyStatus>;
  statePaths?: StatePaths;
  callDaemon?: (command: LocalCommand, signal?: AbortSignal) => Promise<CommandResponse>;
  daemonStopDependencies?: DaemonStopDependencies;
  getRemoteCommandStatus?: CloudRemoteControlPort["getRemoteCommandStatus"];
  interactive?: boolean;
  isTerminalDescriptor?: (fd: number) => boolean;
  readProtectedDocument?: (source: ProtectedInputSource) => Promise<unknown>;
  readShellLine?: (prompt: string) => Promise<string | null>;
  readRootStatus?: (paths: StatePaths) => unknown;
  offlineDoctorOwnerUid?: number;
  sessionObserverSignalMode?: "process" | "foreground_interrupt";
  onHumanSessionObserverBootstrap?: (bootstrap: Readonly<{
    interactions: readonly Readonly<{
      id: string;
      revision: number;
      state: PendingInteraction["state"];
    }>[];
    sessionId: string;
  }>) => void;
}>;

const daemonStopRequestDeadlineMs = 5_000;
const daemonReleaseSettleIntervalMs = 25;
const invalidDaemonAuthorityMessage = "The daemon authority database is invalid and requires manual recovery.";

const defaultDaemonStopDependencies: DaemonStopDependencies = {
  requestStop: async (input) => await callLocalDaemon(input),
  observeReceipt: async (paths) => await readDaemonAuthorityReceipt(paths),
  waitForRelease: async (input) => await waitForDaemonAuthorityRelease(input),
  inspectAuthority: async (paths) => await inspectDaemonAuthority(paths),
  authorityHeld: async (paths) => await DaemonLock.isAuthorityHeld(paths),
  sleep: async (milliseconds) => { await Bun.sleep(milliseconds); },
};

type DaemonReleaseProof =
  | Readonly<{ kind: "stopped"; reconciledAfterObservationError: boolean }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "replacement" }>
  | Readonly<{ kind: "unproven" }>;

const daemonStopRecovery = (
  kind: Exclude<DaemonReleaseProof["kind"], "stopped" | "absent">,
): Extract<DaemonStopResult, { kind: "failure" }> => {
  if (kind === "failed") {
    return {
      kind: "failure",
      error: {
        code: "RECOVERY_REQUIRED",
        message: "The daemon released authority in a failed state. Run `hra doctor --offline` before restarting it.",
        details: { nextCommand: "hra doctor --offline" },
      },
    };
  }
  if (kind === "replacement") {
    return {
      kind: "failure",
      error: {
        code: "RECOVERY_REQUIRED",
        message: "The daemon authority changed while HRA was confirming shutdown. The replacement was not stopped; inspect `hra daemon status --json` before retrying.",
        details: { nextCommand: "hra daemon status --json" },
      },
    };
  }
  return {
    kind: "failure",
    error: {
      code: "RECOVERY_REQUIRED",
      message: "HRA could not prove that the exact daemon authority stopped and released. Inspect `hra daemon status --json` before retrying.",
      details: { nextCommand: "hra daemon status --json" },
    },
  };
};

const daemonStopAuthorityRecovery = (): Extract<DaemonStopResult, { kind: "failure" }> => ({
  kind: "failure",
  error: {
    code: "RECOVERY_REQUIRED",
    message: "The local daemon authority is unsafe or invalid. Run `hra doctor --offline` before changing daemon state.",
    details: { nextCommand: "hra doctor --offline" },
  },
});

const isImmediateDaemonAuthorityError = (error: unknown): boolean =>
  error instanceof DaemonAuthoritySafetyError
  || (error instanceof Error && error.message === invalidDaemonAuthorityMessage);

const daemonReceiptIsLive = (receipt: DaemonAuthorityReceipt): boolean =>
  receipt.state !== "stopped" && receipt.state !== "failed";

const receiptNamesIdentity = (
  receipt: DaemonAuthorityReceipt,
  identity: DaemonIdentity,
): boolean => receipt.pid === identity.pid
  && receipt.nonce === identity.nonce
  && (receipt.generation === undefined || receipt.generation === identity.generation)
  && (receipt.bootId === undefined || receipt.bootId === identity.bootId);

const releaseProofFromReceipt = (
  expected: DaemonIdentity,
  receipt: DaemonAuthorityReceipt | null,
): DaemonReleaseProof => {
  if (receipt === null) return { kind: "unproven" };
  if (!receiptNamesIdentity(receipt, expected)) return { kind: "replacement" };
  const identity = identityFromReceipt(receipt);
  if (identity === null) return { kind: "unproven" };
  if (!sameDaemonIdentity(identity, expected)) return { kind: "replacement" };
  if (receipt.state === "failed") return { kind: "failed" };
  return receipt.state === "stopped"
    ? { kind: "stopped", reconciledAfterObservationError: false }
    : { kind: "unproven" };
};

const reconcileTerminalDaemonRelease = async (
  paths: StatePaths,
  expected: DaemonIdentity,
  dependencies: DaemonStopDependencies,
): Promise<DaemonReleaseProof> => {
  let terminal: DaemonAuthorityReceipt | null;
  try {
    terminal = await dependencies.observeReceipt(paths);
  } catch (error: unknown) {
    if (isImmediateDaemonAuthorityError(error)) throw error;
    return { kind: "unproven" };
  }
  const published = releaseProofFromReceipt(expected, terminal);
  if (published.kind !== "stopped" && published.kind !== "failed") return published;

  // DaemonLock.release publishes the terminal receipt before releasing SQLite.
  // Allow exactly one ordinary poll interval for that documented sequence.
  await dependencies.sleep(daemonReleaseSettleIntervalMs);
  let held: boolean;
  let finalReceipt: DaemonAuthorityReceipt | null;
  try {
    held = await dependencies.authorityHeld(paths);
    finalReceipt = await dependencies.observeReceipt(paths);
  } catch (error: unknown) {
    if (isImmediateDaemonAuthorityError(error)) throw error;
    return { kind: "unproven" };
  }
  const finalProof = releaseProofFromReceipt(expected, finalReceipt);
  if (finalProof.kind !== "stopped" && finalProof.kind !== "failed") return finalProof;
  if (held) return { kind: "unproven" };
  return finalProof.kind === "failed"
    ? finalProof
    : { kind: "stopped", reconciledAfterObservationError: true };
};

const confirmExactDaemonRelease = async (
  paths: StatePaths,
  expected: DaemonIdentity,
  dependencies: DaemonStopDependencies,
): Promise<DaemonReleaseProof> => {
  try {
    const released = await dependencies.waitForRelease({ paths, expected });
    if (released.replacement !== null) return { kind: "replacement" };
    return releaseProofFromReceipt(expected, released.finalReceipt);
  } catch (error: unknown) {
    if (isImmediateDaemonAuthorityError(error)) throw error;
    return await reconcileTerminalDaemonRelease(paths, expected, dependencies);
  }
};

const confirmNoDaemonAuthority = async (
  paths: StatePaths,
  dependencies: DaemonStopDependencies,
): Promise<DaemonReleaseProof> => {
  let inspection: DaemonAuthorityInspection;
  try {
    inspection = await dependencies.inspectAuthority(paths);
  } catch (error: unknown) {
    if (isImmediateDaemonAuthorityError(error)) throw error;
    return { kind: "unproven" };
  }
  if (
    inspection.state === "unsafe_receipt"
    || inspection.state === "unsafe_database"
    || inspection.state === "invalid_database"
    || inspection.state === "indeterminate"
  ) {
    throw new DaemonAuthoritySafetyError(
      "The local daemon authority requires offline recovery before stop can be proved.",
    );
  }
  if (inspection.state === "absent") return { kind: "absent" };
  if (
    inspection.database.custody === "safe"
    && inspection.database.authority === "released"
    && (inspection.state === "released" || inspection.state === "stale_recoverable")
  ) {
    if (inspection.receipt.custody === "safe" && inspection.receipt.state === "failed") {
      return { kind: "failed" };
    }
    return { kind: "absent" };
  }
  return { kind: "unproven" };
};

const completedDaemonStop = (
  expected: DaemonIdentity,
  proof: Extract<DaemonReleaseProof, { kind: "stopped" }>,
  acknowledgedData: unknown,
  requestWasAcknowledged: boolean,
): Extract<DaemonStopResult, { kind: "success" }> => ({
  kind: "success",
  data: {
    ...(typeof acknowledgedData === "object" && acknowledgedData !== null ? acknowledgedData : {}),
    stopping: false,
    running: false,
    daemon: expected,
    released: true,
    ...(!requestWasAcknowledged || proof.reconciledAfterObservationError ? { reconciled: true } : {}),
  },
});

async function stopDaemonWithExactAuthorityInner(
  paths: StatePaths,
  dependencies: DaemonStopDependencies = defaultDaemonStopDependencies,
): Promise<DaemonStopResult> {
  const preStopReceipt = await dependencies.observeReceipt(paths);
  const initialProof = await confirmNoDaemonAuthority(paths, dependencies);
  if (initialProof.kind === "failed") return daemonStopRecovery("failed");
  if (initialProof.kind === "absent") {
    return { kind: "success", data: { stopping: false, running: false, released: false } };
  }
  if (preStopReceipt === null || !daemonReceiptIsLive(preStopReceipt)) {
    return daemonStopRecovery(initialProof.kind === "stopped" ? "unproven" : initialProof.kind);
  }
  const capturedAuthority = identityFromReceipt(preStopReceipt);
  if (capturedAuthority === null) return daemonStopRecovery("unproven");

  let response: CommandResponse;
  try {
    response = await dependencies.requestStop({
      paths,
      command: { kind: "daemon.stop", expected: capturedAuthority },
      deadlineMs: daemonStopRequestDeadlineMs,
    });
  } catch (error: unknown) {
    if (error instanceof LocalDaemonIndeterminateError) {
      const proof = await confirmExactDaemonRelease(paths, capturedAuthority, dependencies);
      return proof.kind === "stopped"
        ? completedDaemonStop(capturedAuthority, proof, undefined, false)
        : daemonStopRecovery(proof.kind === "absent" ? "unproven" : proof.kind);
    }
    if (!isLocalDaemonUnavailable(error)) throw error;
    const proof = await confirmExactDaemonRelease(paths, capturedAuthority, dependencies);
    return proof.kind === "stopped"
      ? completedDaemonStop(capturedAuthority, proof, undefined, false)
      : daemonStopRecovery(proof.kind === "absent" ? "unproven" : proof.kind);
  }

  if (!response.ok) return { kind: "failure", error: response.error };
  let acknowledgedAuthority: DaemonIdentity;
  try {
    acknowledgedAuthority = daemonStatusIdentity(response);
  } catch {
    const proof = await confirmExactDaemonRelease(paths, capturedAuthority, dependencies);
    return proof.kind === "stopped"
      ? completedDaemonStop(capturedAuthority, proof, undefined, false)
      : daemonStopRecovery(proof.kind === "absent" ? "unproven" : proof.kind);
  }
  if (!sameDaemonIdentity(capturedAuthority, acknowledgedAuthority)) {
    return daemonStopRecovery("replacement");
  }
  const proof = await confirmExactDaemonRelease(paths, capturedAuthority, dependencies);
  return proof.kind === "stopped"
    ? completedDaemonStop(capturedAuthority, proof, response.data, true)
    : daemonStopRecovery(proof.kind === "absent" ? "unproven" : proof.kind);
}

export async function stopDaemonWithExactAuthority(
  paths: StatePaths,
  dependencies: DaemonStopDependencies = defaultDaemonStopDependencies,
): Promise<DaemonStopResult> {
  try {
    return await stopDaemonWithExactAuthorityInner(paths, dependencies);
  } catch (error: unknown) {
    if (isImmediateDaemonAuthorityError(error)) return daemonStopAuthorityRecovery();
    throw error;
  }
}

export function selectDaemonCloudControl(
  configured: CloudControlPort | null,
  projectionRecoveryBlocker: CompactProjectionRecoveryBlocker,
  diagnostic?: string,
  unavailability: "disabled" | "recovery_required" = "recovery_required",
  projectionRecoveryStatus?: () => Promise<CloudProjectionRecoveryStatus>,
  reenable?: CloudReenableConfiguration,
): CloudControlPort {
  if (configured !== null) return configured;
  if (diagnostic === undefined) return new UnavailableCloudControl(projectionRecoveryBlocker);
  return new DiagnosedUnavailableCloudControl(
    projectionRecoveryBlocker,
    diagnostic,
    unavailability,
    projectionRecoveryStatus,
    reenable,
  );
}

class DiagnosedUnavailableCloudControl extends UnavailableCloudControl {
  readonly #diagnostic: string;
  readonly #projectionRecoveryStatus: (() => Promise<CloudProjectionRecoveryStatus>) | undefined;
  readonly #reenable: CloudReenableConfiguration | undefined;
  readonly #unavailability: "disabled" | "recovery_required";

  constructor(
    projectionRecoveryBlocker: CompactProjectionRecoveryBlocker,
    diagnostic: string,
    unavailability: "disabled" | "recovery_required",
    projectionRecoveryStatus?: () => Promise<CloudProjectionRecoveryStatus>,
    reenable?: CloudReenableConfiguration,
  ) {
    super(projectionRecoveryBlocker);
    this.#diagnostic = diagnostic;
    this.#projectionRecoveryStatus = projectionRecoveryStatus;
    this.#reenable = reenable;
    this.#unavailability = unavailability;
  }

  #unavailable(): never {
    throw new Error(this.#diagnostic);
  }

  override async status(): Promise<unknown> {
    const projectionRecovery = await this.#projectionRecoveryStatus?.();
    return {
      configured: false,
      diagnostic: this.#diagnostic,
      ...(projectionRecovery === undefined ? {} : { projectionRecovery }),
      ...(this.#reenable === undefined ? {} : { reenable: this.#reenable }),
      signedIn: false,
      unavailability: this.#unavailability,
    };
  }

  override sync(): Promise<never> { return Promise.reject(this.#unavailable()); }
  override recoverCompactProjection(): Promise<never> { return Promise.reject(this.#unavailable()); }
  override auth(): Promise<never> { return Promise.reject(this.#unavailable()); }
  override logout(): Promise<never> { return Promise.reject(this.#unavailable()); }
  override deleteAccount(): Promise<never> { return Promise.reject(this.#unavailable()); }
  override listDevices(): Promise<never> { return Promise.reject(this.#unavailable()); }
  override pairDevice(): Promise<never> { return Promise.reject(this.#unavailable()); }
  override approveDevice(
    device: string,
    idempotencyKey: string,
    fingerprint: string,
    signal: AbortSignal,
  ): Promise<never> {
    void device;
    void idempotencyKey;
    void fingerprint;
    void signal;
    return Promise.reject(this.#unavailable());
  }
  override revokeDevice(device: string, idempotencyKey: string, signal: AbortSignal): Promise<never> {
    void device;
    void idempotencyKey;
    void signal;
    return Promise.reject(this.#unavailable());
  }
}

function cloudBindingDiagnostic(error: unknown): string {
  if (!(error instanceof CloudDeploymentAuthorityError)) {
    return "Cloud sync is unavailable because local cloud custody requires recovery.";
  }
  switch (error.code) {
    case "invalid_configuration":
      return "Cloud sync is unavailable because HRA_CONVEX_URL is invalid.";
    case "legacy_binding_required":
      return "Cloud sync is unavailable until HRA_CONVEX_URL explicitly selects the legacy deployment.";
    case "target_mismatch":
      return "Cloud sync is unavailable because this state root is bound to another deployment.";
    case "concurrent_change":
    case "corrupt_custody":
    case "stale_authority":
      return "Cloud sync is unavailable because deployment custody requires recovery.";
  }
}

type CloudReenableConfiguration =
  | Readonly<{ kind: "use_hosted_default" }>
  | Readonly<{
      deploymentUrl: string;
      kind: "restore_bound_deployment";
    }>;

const cloudReenableConfiguration = (
  authority: CloudDeploymentAuthority | null,
): CloudReenableConfiguration => authority === null
  || authority.deploymentUrl === DEFAULT_CLOUD_DEPLOYMENT_URL
  ? { kind: "use_hosted_default" }
  : {
      deploymentUrl: authority.deploymentUrl,
      kind: "restore_bound_deployment",
    };

const disabledCloudDiagnostic = (reenable: CloudReenableConfiguration): string =>
  reenable.kind === "use_hosted_default"
    ? "Cloud sync is disabled for this daemon. Unset HRA_CONVEX_URL and restart the daemon to use hosted sync."
    : "Cloud sync is disabled for this daemon. Restore this state root's bound HRA_CONVEX_URL deployment and restart the daemon.";

type DaemonCloudStartup = Readonly<{
  deploymentAuthority: CloudDeploymentAuthority | null;
  identityNamespace: string | null;
  journal: CustodyCloudDaemonJournal | null;
  projectionRecoveryBlocker: CompactProjectionRecoveryBlocker;
  diagnostic?: string;
  reenable?: CloudReenableConfiguration;
  unavailability?: "disabled" | "recovery_required";
}>;

class FailClosedProjectionRecoveryBlocker implements CompactProjectionRecoveryBlocker {
  readonly #delegate: CompactProjectionRecoveryBlocker | null;

  constructor(delegate: CompactProjectionRecoveryBlocker | null) {
    this.#delegate = delegate;
  }

  async isCompactProjectionRecoveryUnsettled(
    sessionPublicId: Parameters<CompactProjectionRecoveryBlocker[
      "isCompactProjectionRecoveryUnsettled"
    ]>[0],
  ): Promise<boolean> {
    if (this.#delegate === null) return true;
    try {
      return await this.#delegate.isCompactProjectionRecoveryUnsettled(sessionPublicId);
    } catch {
      return true;
    }
  }

  async isCompactProjectionRecoveryUnsettledForProfile(
    profileId: Parameters<CompactProjectionRecoveryBlocker[
      "isCompactProjectionRecoveryUnsettledForProfile"
    ]>[0],
  ): Promise<boolean> {
    if (this.#delegate === null) return true;
    try {
      return await this.#delegate.isCompactProjectionRecoveryUnsettledForProfile(profileId);
    } catch {
      return true;
    }
  }

  readCompactProjectionRecoveryReceipt(
    input: Parameters<NonNullable<CompactProjectionRecoveryBlocker[
      "readCompactProjectionRecoveryReceipt"
    ]>>[0],
  ): ReturnType<NonNullable<CompactProjectionRecoveryBlocker[
    "readCompactProjectionRecoveryReceipt"
  ]>> {
    return this.#delegate?.readCompactProjectionRecoveryReceipt?.(input)
      ?? Promise.resolve({ status: "absent" });
  }

  async supersedeCompactProjectionRecoveryForProviderDeletion(
    sessionPublicId: Parameters<CompactProjectionRecoveryBlocker[
      "supersedeCompactProjectionRecoveryForProviderDeletion"
    ]>[0],
  ): Promise<{ superseded: boolean }> {
    if (this.#delegate !== null) {
      try {
        return await this.#delegate
          .supersedeCompactProjectionRecoveryForProviderDeletion(sessionPublicId);
      } catch {
        // Fall through to the static fail-closed diagnostic.
      }
    }
    throw new Error("Cloud projection recovery custody requires recovery.");
  }

  async supersedeTerminalCompactProjectionRecoveries(): Promise<{ superseded: number }> {
    if (this.#delegate === null) return { superseded: 0 };
    try {
      return await this.#delegate.supersedeTerminalCompactProjectionRecoveries();
    } catch {
      return { superseded: 0 };
    }
  }
}

function daemonCloudStartupResult(input: Readonly<{
  deploymentAuthority: CloudDeploymentAuthority | null;
  diagnostic?: string;
  reenable?: CloudReenableConfiguration;
  unavailability?: "disabled" | "recovery_required";
  identityNamespace: string | null;
  isSessionTerminal?: (sessionPublicId: string) => boolean | Promise<boolean>;
  journal: CustodyCloudDaemonJournal | null;
}>): DaemonCloudStartup {
  const delegate = input.journal === null
    ? null
    : new CloudDaemonJournalRecoveryBlocker(
        input.journal,
        input.isSessionTerminal === undefined
          ? {}
          : { isSessionTerminal: input.isSessionTerminal },
      );
  const result = {
    deploymentAuthority: input.deploymentAuthority,
    identityNamespace: input.identityNamespace,
    journal: input.journal,
    projectionRecoveryBlocker: new FailClosedProjectionRecoveryBlocker(delegate),
  };
  return input.diagnostic === undefined
    ? result
    : {
        ...result,
        diagnostic: input.diagnostic,
        ...(input.reenable === undefined ? {} : { reenable: input.reenable }),
        unavailability: input.unavailability ?? "recovery_required",
      };
}

export async function resolveDaemonCloudStartup(input: Readonly<{
  environment: Readonly<Record<string, string | undefined>>;
  isSessionTerminal?: (sessionPublicId: string) => boolean | Promise<boolean>;
  secretCustody: CloudSecretCustodyPort;
}>): Promise<DaemonCloudStartup> {
  let deploymentAuthority: CloudDeploymentAuthority | null = null;
  let diagnostic: string | undefined;
  let unavailability: "disabled" | "recovery_required" | undefined;
  try {
    deploymentAuthority = await cloudDeploymentAuthorityFromEnvironment(
      input.secretCustody,
      input.environment,
    );
    if (deploymentAuthority === null) {
      diagnostic = disabledCloudDiagnostic({ kind: "use_hosted_default" });
      unavailability = "disabled";
    }
  } catch (error: unknown) {
    diagnostic = cloudBindingDiagnostic(error);
    unavailability = "recovery_required";
  }

  let recoveryAuthority = deploymentAuthority;
  if (recoveryAuthority === null) {
    try {
      recoveryAuthority = await readCloudDeploymentAuthority(input.secretCustody);
    } catch (error: unknown) {
      return daemonCloudStartupResult({
        deploymentAuthority: null,
        diagnostic: cloudBindingDiagnostic(error),
        unavailability: "recovery_required",
        identityNamespace: null,
        ...(input.isSessionTerminal === undefined
          ? {}
          : { isSessionTerminal: input.isSessionTerminal }),
        journal: null,
      });
    }
  }

  const reenable = unavailability === "disabled"
    ? cloudReenableConfiguration(recoveryAuthority)
    : undefined;
  if (reenable !== undefined) diagnostic = disabledCloudDiagnostic(reenable);

  try {
    const deploymentCustody = recoveryAuthority === null
      ? input.secretCustody
      : new DeploymentScopedCloudSecretCustody(input.secretCustody, recoveryAuthority);
    const identityCustody = await IdentityScopedCloudSecretCustody.open(deploymentCustody);
    const journal = new CustodyCloudDaemonJournal(identityCustody);
    await journal.read();
    return daemonCloudStartupResult({
      deploymentAuthority,
      ...(diagnostic === undefined ? {} : { diagnostic }),
      ...(reenable === undefined ? {} : { reenable }),
      ...(unavailability === undefined ? {} : { unavailability }),
      identityNamespace: identityCustody.cacheNamespace,
      ...(input.isSessionTerminal === undefined
        ? {}
        : { isSessionTerminal: input.isSessionTerminal }),
      journal,
    });
  } catch (error: unknown) {
    return daemonCloudStartupResult({
      deploymentAuthority: null,
      diagnostic: cloudBindingDiagnostic(error),
      unavailability: "recovery_required",
      identityNamespace: null,
      ...(input.isSessionTerminal === undefined
        ? {}
        : { isSessionTerminal: input.isSessionTerminal }),
      journal: null,
    });
  }
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
  return redactCompleteSensitiveText(value, "[redacted-token]");
}

function redactSyncPaths(value: string): string {
  return redactAbsolutePaths(value).replace(
    underscoreAbsolutePathPattern,
    (_match, prefix: string) => `${prefix}[local-path]`,
  );
}

function sanitizeSyncDiagnostic(value: string): string {
  const redacted = redactSyncPaths(redactSyncSecrets(value));
  const bounded = boundedUtf8Text(redacted, syncDiagnosticMaximumBytes);
  const terminalSanitized = terminalSafe(bounded);
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
    nextCommand: "hra sync status --json",
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
      `Next: ${summary.nextCommand}`,
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
  error: Readonly<{ code: string; message: string; details?: unknown }>,
  invocation: ProjectionRecoveryCliInvocation,
  output: Output,
): number {
  const nextCommand = (() => {
    if (!isRecord(error.details)) return null;
    try {
      return error.details.nextCommand === "hra sync status --json"
        ? "hra sync status --json" as const
        : null;
    } catch {
      return null;
    }
  })();
  return renderFailure({
    code: error.code,
    message: sanitizeSyncDiagnostic(error.message),
    ...(nextCommand === null ? {} : { details: { nextCommand } }),
  }, invocation.json, output);
}

export const daemonRunProcessArguments = (
  bunExecutable: string,
  cliPath: string,
): string[] => [
  bunExecutable,
  "--no-env-file",
  cliPath,
  "daemon",
  "run",
];

// The detached daemon receives the Codex child allowlist plus the one HRA
// variable it reads at boot: the explicit cloud deployment selection.
export const DAEMON_ENVIRONMENT_KEYS: ReadonlySet<string> = new Set(["HRA_CONVEX_URL"]);

export const daemonRunProcessOptions = (
  cwd: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => ({
  cwd,
  detached: true,
  env: allowlistedEnvironment(environment, DAEMON_ENVIRONMENT_KEYS),
  stdin: "ignore" as const,
  stdout: "ignore" as const,
  stderr: "ignore" as const,
});

async function startDaemonProcess(installation: HraInstallation): Promise<DaemonReadyStatus> {
  assertInstallationHome(installation);
  if (installation.kind !== "production") {
    throw new Error("A live-acceptance daemon must be started by its source-only worker.");
  }
  const cliPath = process.argv[1] ?? import.meta.path;
  const paths = installation.paths;
  await requireInitializedDaemonState(paths);
  await initializeStatePaths(paths);
  const child = Bun.spawn(
    daemonRunProcessArguments(process.execPath, cliPath),
    daemonRunProcessOptions(paths.root),
  );
  child.unref();
  let exited = false;
  let exitCode: number | undefined;
  void child.exited.then((code) => {
    exitCode = code;
    exited = true;
  });
  try {
    const daemon = await waitForDaemonReady({
      paths,
      queryStatus: async () => await callLocalDaemon({ paths, command: { kind: "daemon.status" }, deadlineMs: 750 }),
      observeChild: () => ({
        pid: child.pid,
        exited,
        ...(exitCode === undefined ? {} : { exitCode }),
      }),
    });
    return { running: true, pid: daemon.pid, daemon };
  } catch (error: unknown) {
    try {
      await terminateDaemonStartupChild(child);
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [error, cleanupError],
        "Daemon startup failed and exact child cleanup was incomplete.",
      );
    }
    throw error;
  }
}

const initializationRequired = (
  operation: "daemon" | "local_status" = "daemon",
): CommandFailure => new CommandFailure(
  "INTERACTION_REQUIRED",
  operation === "daemon"
    ? "Initialize HRA before starting its daemon."
    : "Initialize HRA before reading local status.",
  { nextCommand: "hra init --yes" },
);

async function requireInitializedDaemonState(
  paths: StatePaths,
  operation: "daemon" | "local_status" = "daemon",
): Promise<void> {
  try {
    await lstat(paths.database);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw initializationRequired(operation);
    }
    throw new CommandFailure(
      "RECOVERY_REQUIRED",
      operation === "daemon"
        ? "HRA could not prove that local state is initialized. Inspect it before starting the daemon."
        : "HRA could not prove that local state is initialized. Inspect it before reading local status.",
      { nextCommand: "hra doctor --offline" },
    );
  }
  let store: StateStore | undefined;
  let inspectionFailure: CommandFailure | undefined;
  try {
    store = new StateStore(paths, { readonly: true });
    if (store.listProjects().length === 0) throw initializationRequired(operation);
  } catch (error: unknown) {
    inspectionFailure = error instanceof CommandFailure
      ? error
      : new CommandFailure(
          "RECOVERY_REQUIRED",
          operation === "daemon"
            ? "HRA could not prove that local state is initialized. Inspect it before starting the daemon."
            : "HRA could not prove that local state is initialized. Inspect it before reading local status.",
          { nextCommand: "hra doctor --offline" },
        );
  }
  try {
    store?.close();
  } catch {
    throw new CommandFailure(
      "RECOVERY_REQUIRED",
      operation === "daemon"
        ? "HRA could not close its initialization inspection safely. Inspect local state before starting the daemon."
        : "HRA could not close its initialization inspection safely. Inspect local state before reading local status.",
      { nextCommand: "hra doctor --offline" },
    );
  }
  if (inspectionFailure !== undefined) throw inspectionFailure;
}

async function callWithAutostart(
  installation: HraInstallation,
  command: LocalCommand,
  signal?: AbortSignal,
  injectedStart?: (installation: HraInstallation) => Promise<DaemonReadyStatus>,
): Promise<Awaited<ReturnType<typeof callLocalDaemon>>> {
  assertInstallationHome(installation);
  const paths = installation.paths;
  return await callWithSafeAutostart(
    async () => await callLocalDaemon({ paths, command, ...(signal === undefined ? {} : { signal }) }),
    async () => {
      if (injectedStart === undefined) {
        await startDaemonProcess(installation);
        return;
      }
      await requireInitializedDaemonState(paths);
      await injectedStart(installation);
    },
  );
}

export async function initialize(
  yes: boolean,
  json: boolean,
  output: Output,
  input: { paths?: StatePaths; documentsDirectory?: string } = {},
): Promise<number> {
  const paths = input.paths ?? resolveStatePaths();
  if (!yes) {
    return renderFailure({
      code: "INTERACTION_REQUIRED",
      message: "Confirm the default Documents project with `hra init --yes`.",
    }, json, output);
  }
  await initializeStatePaths(paths);
  const authority = await DaemonLock.acquire(paths, { state: "maintenance" });
  let store: StateStore | undefined;
  try {
    const documents = input.documentsDirectory ?? join(homedir(), "Documents");
    const prepareDocuments = async (): Promise<number | null> => {
      try {
        await mkdir(documents, { mode: 0o700 });
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          return renderFailure({
            code: "UNAVAILABLE",
            message: "The default Documents project could not be created. Create a readable, writable, and traversable canonical Documents directory, then run `hra init --yes` again.",
          }, json, output);
        }
      }
      if (await resolveUsableCanonicalProjectDirectory(documents) === null) {
        return renderFailure({
          code: "UNAVAILABLE",
          message: "The default Documents project is not a readable, writable, and traversable canonical directory. Repair it, then run `hra init --yes` again.",
        }, json, output);
      }
      return null;
    };
    let databaseExists = true;
    try {
      await lstat(paths.database);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") databaseExists = false;
      else throw error;
    }
    let documentsReady = false;
    if (!databaseExists) {
      const failure = await prepareDocuments();
      if (failure !== null) return failure;
      documentsReady = true;
    }
    store = new StateStore(paths);
    let projectCreated = false;
    if (store.listProjects().length === 0) {
      if (!documentsReady) {
        const failure = await prepareDocuments();
        if (failure !== null) return failure;
      }
      await store.createProject("Documents", documents, true);
      projectCreated = true;
    }
    const data = { initialized: true, stateRoot: paths.root, defaultProjectCreated: projectCreated, next: "hra account add Personal" };
    if (json) output.writeStdout(`${safeJson({ ok: true, version: 1, data })}\n`);
    else output.writeStdout(`HRA is ready.\n\nNext: ${data.next}\n`);
    return 0;
  } finally {
    try { store?.close(); } finally { await authority.release(); }
  }
}

async function offlineDoctor(
  json: boolean,
  output: Output,
  paths: StatePaths,
  ownerUid = process.getuid?.(),
): Promise<number> {
  let initialized = false;
  let databaseFileReady = false;
  let rootReady = false;
  const problems: string[] = [];
  let database: "not_initialized" | "ready" | "invalid" = "not_initialized";
  let projectCount = 0;
  let rootMetadata: Stats | undefined;
  try {
    rootMetadata = await lstat(paths.root);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (rootMetadata !== undefined) {
    try {
      const canonical = await realpath(paths.root);
      const after = await lstat(paths.root);
      rootReady = rootMetadata.isDirectory()
        && !rootMetadata.isSymbolicLink()
        && rootMetadata.nlink >= 1
        && (rootMetadata.mode & 0o777) === 0o700
        && (ownerUid === undefined || rootMetadata.uid === ownerUid)
        && canonical === resolve(paths.root)
        && after.dev === rootMetadata.dev
        && after.ino === rootMetadata.ino;
    } catch {
      rootReady = false;
    }
    if (!rootReady) problems.push("The state root is not a private canonical directory.");
  }
  let daemonAuthority: DaemonAuthorityInspection = rootMetadata === undefined
    ? {
        state: "absent",
        database: { custody: "absent" },
        receipt: { custody: "absent" },
      }
    : {
        state: "indeterminate",
        database: { custody: "indeterminate" },
        receipt: { custody: "indeterminate" },
      };
  if (rootReady) {
    daemonAuthority = await inspectDaemonAuthority(paths);
    switch (daemonAuthority.state) {
      case "unsafe_receipt":
        problems.push("The daemon authority receipt has unsafe file custody. Verify that no HRA daemon is running, restore it as a current-user-owned single-link mode-0600 regular file, then rerun `hra doctor --offline`.");
        break;
      case "unsafe_database":
        problems.push("The daemon authority database has unsafe file custody. Verify that no HRA daemon is running, restore it as a current-user-owned single-link mode-0600 regular file, then rerun `hra doctor --offline`.");
        break;
      case "invalid_database":
        problems.push("The daemon authority database is invalid. Stop every HRA process, preserve the invalid authority file for recovery, then repair its SQLite state before restarting HRA.");
        break;
      case "indeterminate":
        problems.push("The daemon authority changed or could not be proved safe during inspection. Do not change authority files; wait for any daemon transition to settle, then rerun `hra doctor --offline`.");
        break;
      case "absent":
      case "held":
      case "releasing":
      case "released":
      case "stale_recoverable":
        break;
    }
  }
  if (rootReady) {
    try {
      const metadata = await lstat(paths.database);
      databaseFileReady = metadata.isFile()
        && !metadata.isSymbolicLink()
        && metadata.nlink === 1
        && (metadata.mode & 0o777) === 0o600
        && (ownerUid === undefined || metadata.uid === ownerUid);
      if (!databaseFileReady) throw new Error("Unsafe local database file.");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        database = "invalid";
        problems.push("The local database check failed without exposing its runtime diagnostic.");
      }
    }
  }
  let projectRoots: readonly string[] = [];
  if (databaseFileReady && database !== "invalid") {
    try {
      const store = new StateStore(paths, { readonly: true });
      try {
        const projects = store.listProjects();
        projectCount = projects.length;
        projectRoots = projects.map((project) => project.rootPath);
        database = "ready";
        initialized = projectCount > 0;
      } finally {
        store.close();
      }
    } catch {
      database = "invalid";
      problems.push("The local database check failed without exposing its runtime diagnostic.");
    }
  }
  if (database === "ready") {
    if (projectCount === 0) {
      problems.push(
        daemonAuthority.state === "held" || daemonAuthority.state === "releasing"
          ? "No project directory is configured. Stop the daemon with `hra daemon stop`, then run `hra init --yes`."
          : "No project directory is configured. Run `hra init --yes`.",
      );
    }
    let unusableProjectRoots = 0;
    for (const projectRoot of projectRoots) {
      if (await resolveUsableCanonicalProjectDirectory(projectRoot) === null) {
        unusableProjectRoots += 1;
      }
    }
    if (unusableProjectRoots > 0) {
      problems.push("A configured project directory is missing or unsafe. Run `hra project list`, then restore or repair every listed directory so it is readable, writable, traversable, and canonical.");
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
    state: { initialized, database, projectCount, daemonAuthority },
    networkChecks: "skipped",
    problems,
  };
  if (json) {
    output.writeStdout(`${safeJson(data.healthy
      ? { ok: true, version: 1, data }
      : unhealthyDoctorEnvelope(data, doctorVerdict(data).message))}\n`);
  }
  else if (data.healthy) {
    const daemonAuthoritySummary = (() => {
      switch (daemonAuthority.state) {
        case "absent": return "not initialized";
        case "held": return "held by a running HRA process";
        case "releasing": return "release in progress; wait before restarting";
        case "released":
          return daemonAuthority.receipt.custody === "safe"
            && daemonAuthority.receipt.state === "failed"
            ? "released after a failed daemon; safe to restart after these checks"
            : "released";
        case "stale_recoverable": return "released with recoverable stale evidence";
        case "unsafe_receipt": return "unsafe receipt";
        case "unsafe_database": return "unsafe database";
        case "invalid_database": return "invalid database";
        case "indeterminate": return "indeterminate";
      }
    })();
    output.writeStdout(`HRA offline checks passed. Bun ${Bun.version}; Codex ${codexRuntime.status}; ${process.platform} ${process.arch}; state ${initialized ? database : "not initialized"}; daemon authority ${daemonAuthoritySummary}.\n`);
  }
  else output.writeStderr(`hra: offline checks failed\n${problems.map((problem) => `- ${problem}`).join("\n")}\n`);
  return data.healthy ? 0 : 1;
}

// An interactive editor needs its terminal description and its own editor
// selection on top of the Codex child allowlist. It gets nothing else.
export const EDITOR_ENVIRONMENT_KEYS: ReadonlySet<string> = new Set([
  "COLORTERM",
  "COLUMNS",
  "EDITOR",
  "LINES",
  "NO_COLOR",
  "TERM",
  "TERMINFO",
  "TERMINFO_DIRS",
  "VISUAL",
]);

async function editSessionNote(
  session: string,
  json: boolean,
  output: Output,
  callDaemon: (command: LocalCommand, signal?: AbortSignal) => Promise<CommandResponse>,
): Promise<number> {
  if (json || !process.stdin.isTTY || !process.stdout.isTTY) {
    return renderFailure({ code: "INTERACTION_REQUIRED", message: "Note editing requires an interactive terminal. Use `session note set` for scripts." }, json, output);
  }
  const current = await callDaemon({ kind: "session.note.get", session });
  if (!current.ok) return renderFailure(current.error, false, output);
  const note = typeof current.data === "object" && current.data !== null && "note" in current.data && typeof current.data.note === "string" ? current.data.note : "";
  const directory = await mkdtemp(join(tmpdir(), "hra-note-"));
  const file = join(directory, "note.md");
  try {
    await writeFile(file, note, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const editorName = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
    const editor = Bun.which(editorName);
    if (editor === null) throw new Error(`Editor is unavailable: ${editorName}`);
    const child = Bun.spawn([editor, file], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: allowlistedEnvironment(process.env, EDITOR_ENVIRONMENT_KEYS),
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error(`Editor exited with status ${exitCode}.`);
    const edited = await readFile(file, "utf8");
    const response = await callDaemon({ kind: "session.note.set", session, note: edited });
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
    case "remote.send": return command.orSteer === true
      ? { kind: "send_or_steer", message: command.message }
      : { kind: "send", message: command.message };
    case "remote.resolve": return {
      decision: command.decision,
      interactionId: command.interaction,
      kind: "resolve_interaction",
      revision: command.revision,
    };
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
          rows.push(`  Decide remotely with \`hra remote resolve <session> --interaction ${event.interactionId} --revision ${String(event.revision)} --decision once|decline|cancel\`, or resolve on the execution device.`);
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
  input: Pick<CliMainInput, "getRemoteCommandStatus" | "installation"> = {},
): Promise<number> {
  const installation = input.installation ?? createProductionInstallation();
  assertInstallationHome(installation);
  const controller = new AbortController();
  const injectedStatus = invocation.command.kind === "remote.command"
    ? input.getRemoteCommandStatus
    : undefined;
  const abort = () => controller.abort(new Error("Cloud remote operation was interrupted."));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const control = injectedStatus === undefined
      ? await createLocalCloudControlFromEnvironment({
          environment: installation.cloudEnvironment,
          lifetimeSignal: controller.signal,
          secretCustody: installation.createSecretCustody(),
        })
      : null;
    if (control === null && injectedStatus === undefined) {
      return renderFailure({
        code: "UNAVAILABLE",
        message: "Cloud sync is disabled. Unset HRA_CONVEX_URL for hosted sync, or set a deployment URL, then run `hra auth login`.",
      }, invocation.json, output);
    }
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
    if (error instanceof CloudDeploymentAuthorityError) {
      return renderFailure({
        code: "UNAVAILABLE",
        message: cloudBindingDiagnostic(error),
      }, invocation.json, output);
    }
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
  if (error instanceof CursorAuthorityMissingError) return error.message;
  if (error instanceof DaemonJoinDeadlineError || error instanceof LocalDaemonShutdownTimeoutError) {
    return `Forced recovery boundary: ${error.message}`;
  }
  if (error instanceof Error && /^STATE_SCHEMA_NEWER:\d+:\d+$/u.test(error.message)) {
    return error.message;
  }
  return "Daemon startup or shutdown failed before a safe readiness boundary.";
}

export function admitExactDaemonStop(input: Readonly<{
  command: DaemonStopCommand;
  receipt: DaemonAuthorityReceipt;
  afterResponse(callback: () => void): void;
  requestStop(): void;
}>): Readonly<{ stopping: true; running: true; daemon: DaemonIdentity }> {
  const daemon = identityFromReceipt(input.receipt);
  if (
    daemon === null
    || input.command.expected === undefined
    || !sameDaemonIdentity(daemon, input.command.expected)
  ) {
    throw new CommandFailure(
      "CONFLICT",
      "The daemon stop authority changed before dispatch. No daemon was stopped.",
      { nextCommand: "hra daemon status --json" },
    );
  }
  input.afterResponse(input.requestStop);
  return { stopping: true, running: true, daemon };
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

export async function runDaemon(
  installation: HraInstallation = createProductionInstallation(),
): Promise<number> {
  assertInstallationHome(installation);
  const paths = installation.paths;
  await requireInitializedDaemonState(paths);
  await initializeStatePaths(paths);
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  const daemonLock = await DaemonLock.acquire(paths);
  let store: StateStore | undefined;
  let factsMemoryControl: FactsMemoryControlStore | undefined;
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
  // A rejection nobody awaited is a lost owned task. Stop through the normal
  // shutdown path and publish a closed failure receipt instead of letting the
  // runtime print the raw error and exit without one.
  let unhandledRejectionError: Error | undefined;
  const onUnhandledRejection = () => {
    unhandledRejectionError ??= new Error("The daemon stopped after an unhandled promise rejection in an owned background task.");
    requestStop();
  };
  process.on("unhandledRejection", onUnhandledRejection);
  const cleanupErrors: unknown[] = [];
  let runError: unknown;
  const checkpointBoot = () => {
    if (stopRequested) throw new DaemonBootInterruptedError();
  };
  try {
    checkpointBoot();
    store = new StateStore(paths);
    const activeStore = store;
    const secretCustody = installation.createSecretCustody();
    const allowCursorAuthorityInitialization =
      activeStore.canInitializeDaemonCursorAuthority();
    const eventCursors = await resolveSessionEventCursorCodec(secretCustody, {
      allowInitialization: allowCursorAuthorityInitialization,
    });
    const usageHistoryCursors = await resolveUsageHistoryCursorCodec(secretCustody, {
      allowInitialization: allowCursorAuthorityInitialization,
    });
    const workCapabilities = await resolveWorkCapabilityCodec(secretCustody, {
      allowInitialization: allowCursorAuthorityInitialization,
    });
    activeStore.configurePublicProviderIdentifierProjector(
      (value) => eventCursors.projectPublicProviderIdentifier(value),
    );
    bootId = `boot_${randomUUID().replaceAll("-", "")}`;
    generation = activeStore.nextDaemonGeneration(bootId);
    await daemonLock.publish({ state: "booting", generation, bootId });
    daemonAuthority = new DaemonAuthorityFence(daemonLock, { generation, bootId });
    const activeDaemonAuthority = daemonAuthority;
    checkpointBoot();
    const serviceReference: { current?: HraService } = {};
    codex = new PinnedCodexRuntimeManager({
      ...(installation.kind === "live_acceptance"
        ? {
            codexEnvironment: installation.codexEnvironment,
            prepareCodexHome: installation.prepareCodexHome,
          }
        : {}),
      credentialStorePreflight: installation.credentialStorePreflight,
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
        conversationAutomation: async (authority, call) => {
          const current = serviceReference.current;
          if (current === undefined) {
            throw new Error("The HRA service is unavailable during conversation automation.");
          }
          return await current.handleConversationAutomationToolCall(authority, call);
        },
        conversationAutomationResponseWritten: (authority, call) => {
          serviceReference.current?.notifyConversationAutomationToolResponseWritten(
            authority,
            call,
          );
        },
        fact: async (authority, fact) => { await serviceReference.current?.observeCodexFact(authority, fact); },
      },
    });
    const cloudEnvironment = installation.cloudEnvironment;
    const cloudStartup = await resolveDaemonCloudStartup({
      environment: cloudEnvironment,
      isSessionTerminal: (sessionPublicId) => {
        try {
          return activeStore.requireSession(sessionPublicId).state === "terminal";
        } catch {
          return false;
        }
      },
      secretCustody,
    });
    const cloudDeploymentAuthority = cloudStartup.deploymentAuthority;
    const cloudIdentityNamespace = cloudStartup.identityNamespace;
    let cloudStartupDiagnostic = cloudStartup.diagnostic;
    let cloudStartupUnavailability = cloudStartup.unavailability;
    const cloudJournal = cloudStartup.journal;
    const projectionRecoveryBlocker = cloudStartup.projectionRecoveryBlocker;
    const unavailableProjectionRecoveryStatus = cloudJournal === null
      ? undefined
      : async (): Promise<CloudProjectionRecoveryStatus> =>
          projectionRecoveryStatusFromJournalState((await cloudJournal.read()).state);
    cloudRequestController = new AbortController();
    let cloud = selectDaemonCloudControl(
      null,
      projectionRecoveryBlocker,
      cloudStartupDiagnostic,
      cloudStartupUnavailability,
      unavailableProjectionRecoveryStatus,
      cloudStartup.reenable,
    );
    if (cloudDeploymentAuthority !== null && cloudJournal !== null) {
      let candidateAdapter: StateBackedCloudDaemonAdapter | undefined;
      let candidateBridge: Awaited<ReturnType<
        typeof createLocalCloudDaemonBridgeFromEnvironment
      >> | undefined;
      try {
        const localCloudControl = await createLocalCloudControlFromEnvironment({
          deploymentAuthority: cloudDeploymentAuthority,
          environment: cloudEnvironment,
          lifetimeSignal: cloudRequestController.signal,
          secretCustody,
        });
        if (localCloudControl === null) {
          throw new CloudDeploymentAuthorityError(
            "stale_authority",
            "Cloud deployment authority changed during daemon startup.",
          );
        }
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
        candidateAdapter = new StateBackedCloudDaemonAdapter({
          codex: cloudCodex,
          executeRemote: async (command, expected, options) => {
            const current = serviceReference.current;
            if (current === undefined) throw new Error("The local command service is not ready.");
            return await current.executeRemote(command, expected, { signal: options.signal });
          },
          paths,
          store: activeStore,
          cloudIdentityNamespace,
        });
        candidateBridge = await createLocalCloudDaemonBridgeFromEnvironment({
          daemonAuthority: { bootGeneration: generation, bootId },
          daemonAuthorityFence: activeDaemonAuthority,
          deploymentAuthority: cloudDeploymentAuthority,
          environment: cloudEnvironment,
          executor: candidateAdapter,
          lifetimeSignal: cloudRequestController.signal,
          local: candidateAdapter,
          journal: cloudJournal,
          registration: localCloudControl,
          secretCustody,
        });
        if (candidateBridge === null) {
          throw new CloudDeploymentAuthorityError(
            "stale_authority",
            "Cloud deployment authority changed during daemon startup.",
          );
        }
        const cloudBridge = candidateBridge;
        const candidateCloud = new BridgedCloudControl(
          localCloudControl,
          cloudBridge,
          candidateAdapter,
        );
        const candidateLifecycle = createCloudDaemonLifecycle({ bridge: cloudBridge });
        cloudAdapter = candidateAdapter;
        cloud = candidateCloud;
        cloudLifecycle = candidateLifecycle;
        candidateAdapter = undefined;
        candidateBridge = undefined;
      } catch (error: unknown) {
        cloudRequestController.abort(new Error("Cloud initialization was fenced."));
        if (candidateBridge !== undefined && candidateBridge !== null) {
          try { await candidateBridge.close(); } catch (cleanupError: unknown) {
            cleanupErrors.push(cleanupError);
          }
        }
        if (candidateAdapter !== undefined) {
          try { candidateAdapter.close(); } catch (cleanupError: unknown) {
            cleanupErrors.push(cleanupError);
          }
        }
        cloudStartupDiagnostic = cloudBindingDiagnostic(error);
        cloudStartupUnavailability = "recovery_required";
        cloud = selectDaemonCloudControl(
          null,
          projectionRecoveryBlocker,
          cloudStartupDiagnostic,
          cloudStartupUnavailability,
          unavailableProjectionRecoveryStatus,
        );
      }
    }
    checkpointBoot();
    factsMemoryControl = new FactsMemoryControlStore(paths.factsMemoryControl);
    const { OhSqliteFactsMemoryEngine } = await import("./storage/oh-facts-memory-engine");
    const factsMemory = new HraFactsMemoryLifecycle({
      broker: new LocalFactsMemoryBroker({
        engine: new OhSqliteFactsMemoryEngine(),
        root: paths.factsMemorySessions,
      }),
      control: factsMemoryControl,
    });
    const desktop = process.platform === "darwin" && installation.desktopSwitching
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
      usageHistoryCursors,
      workCapabilities,
      factsMemory,
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
      onFailure: (_accountId, error) => {
        activeService.recordBackgroundDiagnostic("usage_poll_account_failed", error);
      },
      onTickFailure: (error) => {
        activeService.recordBackgroundDiagnostic("usage_poll_tick_failed", error);
      },
    });
    usagePoller.start();
    cloudLifecycle?.start();
    server = await LocalDaemonServer.start({
      paths,
      handler: async (command, context) => {
        await daemonLock.assertCurrent();
        if (command.kind === "daemon.stop") {
          return admitExactDaemonStop({
            command,
            receipt: daemonLock.receipt,
            afterResponse: (callback) => context.afterResponse(callback),
            requestStop,
          });
        }
        const data = await activeService.execute(command, { signal: context.signal, afterResponse: (callback) => context.afterResponse(callback) });
        if (command.kind !== "daemon.status") return data;
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
    runError ??= unhandledRejectionError;
    if (usagePoller !== undefined) usagePollerShutdown ??= usagePoller.close();
    if (service !== undefined) serviceShutdown ??= service.close();
    else daemonAuthority?.close();
    server?.beginShutdown(new Error("Daemon lifetime ended."));
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("unhandledRejection", onUnhandledRejection);

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

    if (factsMemoryControl !== undefined) {
      try { factsMemoryControl.close(); } catch (error: unknown) { cleanupErrors.push(error); }
    }
    if (store !== undefined) {
      if (generation !== undefined && bootId !== undefined) {
        try { store.markDaemonStopped(generation, bootId); } catch (error: unknown) { cleanupErrors.push(error); }
      }
      try { store.close(); } catch (error: unknown) { cleanupErrors.push(error); }
    }
    const normalizedRunError = runError === undefined
      ? undefined
      : unhandledRejectionError !== undefined && runError === unhandledRejectionError
        ? unhandledRejectionError.message
        : safeDaemonFailure(runError);
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
): ((command: LocalCommand, signal?: AbortSignal) => Promise<CommandResponse>) => {
  if (input.callDaemon !== undefined) return input.callDaemon;
  const installation = input.installation ?? createProductionInstallation();
  return async (command, signal) => await callWithAutostart(
    installation,
    command,
    signal,
    input.startDaemon,
  );
};

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

const readInvocationProtectedDocument = async (
  source: ProtectedInputSource,
  output: Output,
  input: CliMainInput,
  maximumBytes = protectedInputMaximumBytes,
): Promise<unknown> => {
  if (input.readProtectedDocument !== undefined) return await input.readProtectedDocument(source);
  const fd = protectedInputDescriptor(source);
  const terminal = (input.isTerminalDescriptor ?? isatty)(fd);
  if (!terminal) return await readProtectedDocument(source, output, undefined, maximumBytes);
  if (!input.interactive || !process.stderr.isTTY) {
    throw new CliUsageError(
      "Terminal protected input requires an interactive stdin and a visible terminal on stderr. Redirect one protected JSON document from a non-terminal stdin or file descriptor instead.",
    );
  }
  return await withProtectedTerminalLifecycle(async (signal) =>
    await readProtectedDocument(source, output, signal, maximumBytes));
};

async function executeProtectedInteraction(
  invocation: Extract<CliInvocation, { kind: "interaction.resolve-protected" }>,
  output: Output,
  input: CliMainInput,
): Promise<number> {
  const terminalRefusal = rejectJsonTerminalProtectedInput(invocation, output, input);
  if (terminalRefusal !== null) return terminalRefusal;
  const document = await readInvocationProtectedDocument(invocation.input, output, input);
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
  const document = await readInvocationProtectedDocument(invocation.input, output, input);
  const command = completeProtectedAuthLogin(invocation, document);
  const response = await commandCaller(input)(command);
  if (!response.ok) return renderFailure(response.error, invocation.json, output);
  renderSuccess(command, response.data, invocation.json, output);
  return 0;
}

type WorkCommandError = Extract<CommandResponse, { ok: false }>["error"];

type WorkFailureMapping = Readonly<{
  commandCode: WorkCommandError["code"];
  protocolCode: WorkAgentProtocolError["code"];
  recovery: WorkAgentProtocolError["recovery"];
  retryable: boolean;
}>;

const workProtocolErrorMessages = {
  invalid_request: "The work request is invalid.",
  not_found: "A required work entity was not found.",
  conflict: "The work mutation conflicts with current durable state.",
  fence_mismatch: "The attempt fence no longer authorizes this mutation.",
  lease_expired: "The attempt lease expired before this mutation.",
  not_owner: "The actor does not own the selected attempt.",
  route_mismatch: "The selected session does not satisfy the durable task route.",
  invalid_state: "The work mutation is not valid in the current durable state.",
  limit_exceeded: "A durable work protocol limit prevents this operation.",
  effect_unknown: "The work effect is uncertain; replay the exact same request document.",
  internal: "The work mutation failed at an internal boundary.",
} as const satisfies Readonly<Record<WorkAgentProtocolError["code"], string>>;

const workFailureByReason = {
  ATTEMPT_EXHAUSTED: { commandCode: "CONFLICT", protocolCode: "limit_exceeded", recovery: "none", retryable: false },
  ATTEMPT_NOT_OWNER: { commandCode: "CONFLICT", protocolCode: "not_owner", recovery: "refresh_state_then_new_request", retryable: false },
  ATTEMPT_NOT_CLAIMABLE: { commandCode: "CONFLICT", protocolCode: "invalid_state", recovery: "refresh_state_then_new_request", retryable: false },
  ATTEMPT_NOT_FOUND: { commandCode: "NOT_FOUND", protocolCode: "not_found", recovery: "refresh_state_then_new_request", retryable: false },
  ATTEMPT_RECOVERY_REQUIRED: { commandCode: "RECOVERY_REQUIRED", protocolCode: "effect_unknown", recovery: "replay_exact_request", retryable: true },
  BAD_CURSOR: { commandCode: "INVALID_INPUT", protocolCode: "invalid_request", recovery: "none", retryable: false },
  BAD_IDEMPOTENCY_KEY: { commandCode: "INVALID_INPUT", protocolCode: "invalid_request", recovery: "none", retryable: false },
  DEPENDENCY_CYCLE: { commandCode: "INVALID_INPUT", protocolCode: "invalid_request", recovery: "none", retryable: false },
  DEPENDENCY_INCOMPLETE: { commandCode: "CONFLICT", protocolCode: "invalid_state", recovery: "refresh_state_then_new_request", retryable: false },
  EVIDENCE_INVALID: { commandCode: "INVALID_INPUT", protocolCode: "invalid_request", recovery: "none", retryable: false },
  FENCE_MISMATCH: { commandCode: "CONFLICT", protocolCode: "fence_mismatch", recovery: "refresh_state_then_new_request", retryable: false },
  IDEMPOTENCY_CONFLICT: { commandCode: "CONFLICT", protocolCode: "conflict", recovery: "refresh_state_then_new_request", retryable: false },
  LEASE_EXPIRED: { commandCode: "CONFLICT", protocolCode: "lease_expired", recovery: "refresh_state_then_new_request", retryable: false },
  MEMBER_NOT_FOUND: { commandCode: "NOT_FOUND", protocolCode: "not_found", recovery: "refresh_state_then_new_request", retryable: false },
  NO_READY_TASK: { commandCode: "CONFLICT", protocolCode: "invalid_state", recovery: "refresh_state_then_new_request", retryable: false },
  NOT_REVIEWABLE: { commandCode: "CONFLICT", protocolCode: "invalid_state", recovery: "refresh_state_then_new_request", retryable: false },
  REVISION_CONFLICT: { commandCode: "CONFLICT", protocolCode: "conflict", recovery: "refresh_state_then_new_request", retryable: false },
  ROUTE_MISMATCH: { commandCode: "CONFLICT", protocolCode: "route_mismatch", recovery: "refresh_state_then_new_request", retryable: false },
  SELF_REVIEW: { commandCode: "CONFLICT", protocolCode: "invalid_state", recovery: "refresh_state_then_new_request", retryable: false },
  SIGNAL_NOT_FOUND: { commandCode: "NOT_FOUND", protocolCode: "not_found", recovery: "refresh_state_then_new_request", retryable: false },
  TASK_DEPTH_EXCEEDED: { commandCode: "INVALID_INPUT", protocolCode: "limit_exceeded", recovery: "none", retryable: false },
  TASK_LIMIT_EXCEEDED: { commandCode: "INVALID_INPUT", protocolCode: "limit_exceeded", recovery: "none", retryable: false },
  TASK_NOT_FOUND: { commandCode: "NOT_FOUND", protocolCode: "not_found", recovery: "refresh_state_then_new_request", retryable: false },
  UNKNOWN_DEPENDENCY: { commandCode: "INVALID_INPUT", protocolCode: "invalid_request", recovery: "none", retryable: false },
  UNKNOWN_PARENT: { commandCode: "INVALID_INPUT", protocolCode: "invalid_request", recovery: "none", retryable: false },
  WORK_CAPACITY_EXCEEDED: { commandCode: "CONFLICT", protocolCode: "limit_exceeded", recovery: "none", retryable: false },
  WORK_NOT_ACTIVE: { commandCode: "CONFLICT", protocolCode: "invalid_state", recovery: "refresh_state_then_new_request", retryable: false },
  WORK_NOT_FOUND: { commandCode: "NOT_FOUND", protocolCode: "not_found", recovery: "refresh_state_then_new_request", retryable: false },
  WORK_RELEASED: { commandCode: "NOT_FOUND", protocolCode: "not_found", recovery: "refresh_state_then_new_request", retryable: false },
} as const satisfies Readonly<Record<string, WorkFailureMapping>>;

type WorkFailureReason = keyof typeof workFailureByReason;

const workCommandExitCodes = {
  INVALID_INPUT: 2,
  NOT_FOUND: 4,
  AMBIGUOUS: 1,
  CONFLICT: 1,
  INTERACTION_REQUIRED: 6,
  UNAVAILABLE: 5,
  RECOVERY_REQUIRED: 7,
  INTERNAL: 1,
} as const satisfies Readonly<Record<WorkCommandError["code"], number>>;

const workFailureReason = (details: unknown): WorkFailureReason | null => {
  if (details === null || typeof details !== "object" || Array.isArray(details)) return null;
  const reason = (details as Readonly<Record<string, unknown>>).reason;
  return typeof reason === "string" && Object.hasOwn(workFailureByReason, reason)
    ? reason as WorkFailureReason
    : null;
};

const fallbackWorkFailure = {
  INVALID_INPUT: { protocolCode: "invalid_request", recovery: "none", retryable: false },
  NOT_FOUND: { protocolCode: "not_found", recovery: "refresh_state_then_new_request", retryable: false },
  AMBIGUOUS: { protocolCode: "conflict", recovery: "refresh_state_then_new_request", retryable: false },
  CONFLICT: { protocolCode: "conflict", recovery: "refresh_state_then_new_request", retryable: false },
  INTERACTION_REQUIRED: { protocolCode: "invalid_state", recovery: "none", retryable: false },
  UNAVAILABLE: { protocolCode: "internal", recovery: "retry_same_request", retryable: true },
  RECOVERY_REQUIRED: { protocolCode: "effect_unknown", recovery: "replay_exact_request", retryable: true },
  INTERNAL: { protocolCode: "internal", recovery: "none", retryable: false },
} as const satisfies Readonly<Record<
  WorkCommandError["code"],
  Readonly<{ protocolCode: WorkAgentProtocolError["code"]; recovery: WorkAgentProtocolError["recovery"]; retryable: boolean }>
>>;

const mapWorkFailure = (failure: WorkCommandError): Readonly<{
  error: WorkAgentProtocolError;
  exitCode: number;
}> => {
  const reason = workFailureReason(failure.details);
  const exact = reason === null ? null : workFailureByReason[reason];
  const mapped = exact !== null && exact.commandCode === failure.code
    ? exact
    : fallbackWorkFailure[failure.code];
  return {
    error: {
      code: mapped.protocolCode,
      message: workProtocolErrorMessages[mapped.protocolCode],
      recovery: mapped.recovery,
      retryable: mapped.retryable,
      exitCode: workCommandExitCodes[failure.code],
    },
    exitCode: workCommandExitCodes[failure.code],
  };
};

const writeWorkProtocolFailure = (
  requestId: string | null,
  error: WorkAgentProtocolError,
  output: Output,
): void => {
  output.writeStdout(`${safeJson(workAgentProtocolResponseSchema.parse({
    protocol: WORK_PROTOCOL,
    version: WORK_PROTOCOL_VERSION,
    requestId,
    ok: false,
    error,
  }))}\n`);
};

const admittedWorkRequestCorrelation = (document: unknown): string | null => {
  if (document === null || typeof document !== "object" || Array.isArray(document)) return null;
  const record = document as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  if (
    JSON.stringify(keys) !== JSON.stringify(["operation", "protocol", "requestId", "version"])
    || record.protocol !== WORK_PROTOCOL
    || record.version !== WORK_PROTOCOL_VERSION
    || typeof record.requestId !== "string"
  ) return null;
  const parsed = z.string().uuid().safeParse(record.requestId);
  return parsed.success ? parsed.data : null;
};

async function executeWorkApply(
  invocation: Extract<CliInvocation, { kind: "work.apply-input" }>,
  output: Output,
  input: CliMainInput,
): Promise<number> {
  const descriptor = protectedInputDescriptor(invocation.input);
  if ((input.isTerminalDescriptor ?? isatty)(descriptor)) {
    writeWorkProtocolFailure(null, {
      code: "invalid_state",
      message: "Work operations require one bounded JSON document from non-terminal stdin or a file descriptor.",
      recovery: "none",
      retryable: false,
      exitCode: 6,
    }, output);
    return 6;
  }
  let document: unknown;
  try {
    document = await readInvocationProtectedDocument(
      invocation.input,
      output,
      input,
      WORK_PROTOCOL_REQUEST_MAX_BYTES,
    );
  } catch {
    writeWorkProtocolFailure(null, {
      code: "invalid_request",
      message: "The work request input is not one bounded JSON document.",
      recovery: "none",
      retryable: false,
      exitCode: 2,
    }, output);
    return 2;
  }
  const request = workProtocolRequestSchema.safeParse(document);
  if (!request.success) {
    writeWorkProtocolFailure(admittedWorkRequestCorrelation(document), {
      code: "invalid_request",
      message: "The work request document does not match the strict versioned HRA work protocol.",
      recovery: "none",
      retryable: false,
      exitCode: 2,
    }, output);
    return 2;
  }
  const command = localCommandSchema.parse({
    kind: "work.apply",
    requestId: request.data.requestId,
    operation: request.data.operation,
  });
  if (command.kind !== "work.apply") throw new CliUsageError("The work operation is invalid.");
  let response: CommandResponse;
  try {
    response = await commandCaller(input)(command);
  } catch (error: unknown) {
    if (!(error instanceof LocalDaemonIndeterminateError)) throw error;
    writeWorkProtocolFailure(request.data.requestId, {
      code: "effect_unknown",
      message: "The local transport outcome is uncertain; replay the exact same request document.",
      recovery: "replay_exact_request",
      retryable: true,
      exitCode: 7,
    }, output);
    return 7;
  }
  if (!response.ok) {
    const failure = mapWorkFailure(response.error);
    writeWorkProtocolFailure(request.data.requestId, failure.error, output);
    return failure.exitCode;
  }
  try {
    renderSuccess(command, response.data, true, output);
  } catch (error: unknown) {
    if (!(error instanceof InvalidCommandResponseError)) throw error;
    writeWorkProtocolFailure(request.data.requestId, {
      code: "effect_unknown",
      message: "The daemon reported success without a valid bound result; replay the exact same request document.",
      recovery: "replay_exact_request",
      retryable: true,
      exitCode: 7,
    }, output);
    return 7;
  }
  return 0;
}

const accountLoginPublicData = (
  result: ReturnType<typeof parseAccountLoginResponse>,
  handoff:
    | Readonly<{
        disposition: "preserved_caller_removes_after_login";
        documentVersion: 1;
        path: string;
        status: "written";
      }>
    | Readonly<{ status: "shown_in_protected_terminal" | "unavailable_on_replay" }>
    | undefined,
): unknown => ({
  account: result.account,
  idempotencyKey: result.idempotencyKey,
  login: {
    status: result.kind === "signed_in"
      ? "signed_in"
      : result.kind === "settled"
        ? "settled"
        : "pending",
    ...(handoff === undefined ? {} : { handoff }),
  },
});

const renderProtectedForegroundLogin = (
  document: DeviceLoginDocument,
  output: Output,
): void => {
  output.writeStderr([
    `Complete Codex ${document.method === "device_code" ? "device-code " : ""}login for ${terminalSafe(document.accountLabel)}.`,
    `URL: ${terminalSafe(document.verificationUrl)}`,
    ...(document.userCode === undefined ? [] : [`Code: ${terminalSafe(document.userCode)}`]),
    `If needed, cancel with: ${terminalSafe(document.cancelCommand)}`,
    "",
  ].join("\n"));
};

const protectedInteractionInspectCommand = (
  invocation: Extract<CliInvocation, { kind: "interaction.inspect-protected" }>,
): string => `hra interaction inspect ${invocation.command.interaction} --revision ${String(invocation.command.expectedRevision)} --handoff-file /absolute/path/to/empty-protected-approval.json${invocation.json ? " --json" : ""}`;

async function executeProtectedInteractionInspect(
  invocation: Extract<CliInvocation, { kind: "interaction.inspect-protected" }>,
  output: Output,
  input: CliMainInput,
): Promise<number> {
  const interactive = input.interactive === true;
  const protectedTerminalWriter = output.writeProtectedStderr?.bind(output);
  const protectedTerminal = interactive
    && (input.isTerminalDescriptor ?? isatty)(2)
    && protectedTerminalWriter !== undefined;
  if (invocation.handoffFile === undefined && (invocation.json || !protectedTerminal)) {
    return renderFailure({
      code: "INTERACTION_REQUIRED",
      details: {
        nextCommand: protectedInteractionInspectCommand(invocation),
        protectedOutput: "absolute_canonical_owned_mode_0600_empty_file",
      },
      message: "Protected approval inspection requires a foreground terminal or a caller-owned protected output file.",
      trustedLocalPaths: true,
    }, invocation.json, output);
  }

  let protectedOutput: ProtectedOutputFile | undefined;
  const closeProtectedOutput = (): boolean => {
    const current = protectedOutput;
    protectedOutput = undefined;
    return current?.close() ?? true;
  };
  try {
    if (invocation.handoffFile !== undefined) {
      try {
        // Prove and hold the caller-owned empty file before asking for private authority.
        protectedOutput = new ProtectedOutputFile(invocation.handoffFile);
      } catch (error: unknown) {
        if (!(error instanceof ProtectedOutputError)) throw error;
        return renderFailure({
          code: "INVALID_INPUT",
          details: {
            requirement: "absolute_canonical_current_user_owned_mode_0700_parent_empty_single_link_mode_0600_regular_file",
          },
          message: "The approval-detail handoff file does not satisfy the protected output contract.",
        }, invocation.json, output);
      }
    }

    const response = await commandCaller(input)(invocation.command);
    if (!response.ok) return renderFailure(response.error, invocation.json, output);
    let document: ReturnType<typeof parseProtectedInteractionDetailResponse>;
    try {
      document = parseProtectedInteractionDetailResponse(response.data, {
        interactionId: invocation.command.interaction,
        revision: invocation.command.expectedRevision,
      });
    } catch (error: unknown) {
      if (!(error instanceof ProtectedOutputError)) throw error;
      return renderFailure({
        code: "INTERNAL",
        message: "The daemon returned an invalid protected approval-detail document.",
      }, invocation.json, output);
    }

    let terminalDocument: string | undefined;
    if (protectedOutput === undefined) {
      terminalDocument = renderProtectedInteractionDetail(document);
      const terminalBytes = new TextEncoder().encode(terminalDocument);
      const terminalSafeSize = terminalBytes.byteLength <= PROTECTED_INTERACTION_TERMINAL_MAXIMUM_BYTES;
      terminalBytes.fill(0);
      if (!terminalSafeSize) {
        return renderFailure({
          code: "INTERACTION_REQUIRED",
          details: {
            nextCommand: protectedInteractionInspectCommand(invocation),
            protectedOutput: "absolute_canonical_owned_mode_0600_empty_file",
          },
          message: "The complete approval authority is too large for safe terminal display. Use a caller-owned protected output file.",
          trustedLocalPaths: true,
        }, invocation.json, output);
      }
    }

    if (protectedOutput !== undefined) {
      try {
        const handoffPath = protectedOutput.path;
        protectedOutput.write(document);
        if (!closeProtectedOutput()) throw new ProtectedOutputError("write_unproven");
        renderSuccess(invocation.command, {
          binding: document.binding,
          protectedOutput: {
            disposition: "preserved_caller_removes_after_decision",
            documentVersion: document.version,
            path: handoffPath,
            status: "written",
          },
        }, invocation.json, output);
        return 0;
      } catch (error: unknown) {
        if (!(error instanceof ProtectedOutputError)) throw error;
        return renderFailure({
          code: "RECOVERY_REQUIRED",
          message: "Protected approval detail may have reached the caller-owned file, but HRA could not prove the completed write. Treat the file as private material and remove it before retrying.",
        }, invocation.json, output);
      }
    }

    if (protectedTerminalWriter === undefined || terminalDocument === undefined) {
      throw new Error("Protected terminal authority changed during interaction inspection.");
    }
    protectedTerminalWriter(terminalDocument);
    renderSuccess(invocation.command, {
      binding: document.binding,
      protectedOutput: { status: "shown_in_protected_terminal" },
    }, false, output);
    return 0;
  } finally {
    closeProtectedOutput();
  }
}

async function executeAccountLogin(
  invocation: Extract<CliInvocation, { kind: "account.login-handoff" }>,
  output: Output,
  input: CliMainInput,
): Promise<number> {
  const interactive = input.interactive === true;
  if (invocation.handoffFile === undefined && (invocation.json || !interactive)) {
    return renderFailure({
      code: "INTERACTION_REQUIRED",
      details: {
        idempotencyKey: invocation.command.idempotencyKey,
        nextCommand: invocation.replayCommand,
        protectedOutput: "absolute_canonical_owned_mode_0600_empty_file",
      },
      message: "Account login requires a protected handoff file outside a foreground terminal. Create the file under a current-user-owned mode 0700 directory, set the empty file to mode 0600, then run the exact same-key command.",
      trustedLocalPaths: true,
    }, invocation.json, output);
  }

  let protectedOutput: ProtectedOutputFile | undefined;
  const closeProtectedOutput = (): boolean => {
    const current = protectedOutput;
    protectedOutput = undefined;
    return current?.close() ?? true;
  };
  try {
    if (invocation.handoffFile !== undefined) {
      try {
        protectedOutput = new ProtectedOutputFile(invocation.handoffFile);
      } catch (error: unknown) {
        if (!(error instanceof ProtectedOutputError)) throw error;
        return renderFailure({
          code: "INVALID_INPUT",
          details: {
            requirement: "absolute_canonical_current_user_owned_mode_0700_parent_empty_single_link_mode_0600_regular_file",
          },
          message: "The login handoff file does not satisfy the protected output contract.",
        }, invocation.json, output);
      }
    }

    const callDaemon = commandCaller(input);
    let listed: CommandResponse;
    try {
      listed = await callDaemon({ kind: "account.list" });
    } catch (error: unknown) {
      if (!(error instanceof LocalDaemonIndeterminateError)) throw error;
      return renderFailure({
        code: "UNAVAILABLE",
        details: {
          idempotencyKey: invocation.command.idempotencyKey,
          nextCommand: invocation.replayCommand,
          providerEffectDispatched: false,
        },
        message: "HRA could not resolve the exact account authority. No provider login was dispatched; retry the same command.",
        trustedLocalPaths: true,
      }, invocation.json, output);
    }
    if (!listed.ok) return renderFailure(listed.error, invocation.json, output);
    let authorities: ReturnType<typeof parseAccountLoginAuthorityList>;
    try {
      authorities = parseAccountLoginAuthorityList(listed.data);
    } catch (error: unknown) {
      if (!(error instanceof ProtectedOutputError)) throw error;
      return renderFailure({
        code: "INTERNAL",
        message: "The daemon returned an invalid account authority list.",
      }, invocation.json, output);
    }
    const selected = selectByIdOrLabel(authorities, invocation.command.account);
    if (selected.kind === "missing") {
      return renderFailure({
        code: "NOT_FOUND",
        message: "No account matches the requested login authority.",
      }, invocation.json, output);
    }
    if (selected.kind === "ambiguous") {
      return renderFailure({
        code: "AMBIGUOUS",
        details: {
          candidates: selected.values.map(({ id, label }) => ({ id, label })),
        },
        message: "The account selector is ambiguous. Use the exact account ID.",
      }, invocation.json, output);
    }
    const command = { ...invocation.command, account: selected.value.id };
    const replayCommand = accountLoginReplayCommand(
      command,
      invocation.handoffFile ?? "/absolute/path/to/empty-protected-login.json",
      invocation.json,
    );
    let response: CommandResponse;
    try {
      response = await callDaemon(command);
    } catch (error: unknown) {
      if (!(error instanceof LocalDaemonIndeterminateError)) throw error;
      return renderFailure({
        code: "RECOVERY_REQUIRED",
        details: {
          cancelCommand: accountLoginCancelCommand(selected.value.id),
          idempotencyKey: command.idempotencyKey,
          sameKeyReplayCommand: replayCommand,
        },
        message: "The account login response is uncertain. Reuse only the exact same-key command to inspect the durable result; cancel the pending login before starting a fresh one.",
        trustedLocalPaths: true,
      }, invocation.json, output);
    }
    if (!response.ok) return renderFailure(response.error, invocation.json, output);

    let result: ReturnType<typeof parseAccountLoginResponse>;
    try {
      result = parseAccountLoginResponse(response.data, {
        accountId: selected.value.id,
        deviceCode: command.deviceCode,
        idempotencyKey: command.idempotencyKey,
      });
      if (result.kind === "handoff") {
        if (protectedOutput !== undefined) {
          const handoffPath = protectedOutput.path;
          protectedOutput.write(result.document);
          if (!closeProtectedOutput()) throw new ProtectedOutputError("write_unproven");
          renderSuccess(command, accountLoginPublicData(result, {
            disposition: "preserved_caller_removes_after_login",
            documentVersion: 1,
            path: handoffPath,
            status: "written",
          }), invocation.json, output);
        } else {
          renderProtectedForegroundLogin(result.document, output);
          renderSuccess(command, accountLoginPublicData(result, {
            status: "shown_in_protected_terminal",
          }), false, output);
        }
        return 0;
      }
      if (!closeProtectedOutput()) throw new ProtectedOutputError("write_unproven");
      renderSuccess(command, accountLoginPublicData(
        result,
        result.kind === "pending_replay"
          ? { status: "unavailable_on_replay" }
          : undefined,
      ), invocation.json, output);
      return 0;
    } catch (error: unknown) {
      if (!(error instanceof ProtectedOutputError)) throw error;
      return renderFailure({
        code: "RECOVERY_REQUIRED",
        details: {
          cancelCommand: accountLoginCancelCommand(selected.value.id),
          idempotencyKey: command.idempotencyKey,
          sameKeyReplayCommand: replayCommand,
        },
        message: "The provider login effect may be pending, but HRA could not prove the protected handoff. Cancel the pending login before starting a fresh login; a same-key replay cannot recover one-time instructions.",
        trustedLocalPaths: true,
      }, invocation.json, output);
    }
  } finally {
    closeProtectedOutput();
  }
}

async function executeSessionEventObserver(
  invocation: Extract<CliInvocation, {
    kind: "session.events.follow" | "session.events.watch";
  }>,
  output: Output,
  input: CliMainInput,
): Promise<number> {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Session event observation stopped."));
  const human = invocation.kind === "session.events.watch" && !invocation.jsonl;
  let humanBootstrapComplete = !human;
  let humanBootstrapBytes = 0;
  const humanChunks: string[] = [];
  const presenter = human
    ? new ShellLivePresenter((value) => {
        if (!humanBootstrapComplete) {
          const nextBytes = humanSessionWatchUtf8Encoder.encode(value).byteLength;
          if (
            humanBootstrapBytes + nextBytes
              > HUMAN_SESSION_WATCH_BOOTSTRAP_MAXIMUM_BYTES
          ) {
            throw new CommandFailure(
              "UNAVAILABLE",
              "Pending interaction guidance exceeds the bounded human watch bootstrap. Inspect pending interactions in bounded pages, then restart watch.",
            );
          }
          humanBootstrapBytes += nextBytes;
        }
        humanChunks.push(value);
      }, 35, "cli")
    : null;
  const bootstrappedInteractions: Array<Readonly<{
    id: string;
    revision: number;
    state: PendingInteraction["state"];
  }>> = [];
  const callDaemon = commandCaller(input);
  const drainHumanChunks = async (signal: AbortSignal): Promise<void> => {
    if (humanChunks.length === 0) return;
    const value = humanChunks.splice(0).join("");
    if (output.writeStdoutAsync !== undefined) {
      await output.writeStdoutAsync(value, signal);
      return;
    }
    output.writeStdout(value);
  };
  const finalize = async (): Promise<void> => {
    presenter?.close();
    process.off("SIGINT", abort);
    if (input.sessionObserverSignalMode !== "foreground_interrupt") {
      process.off("SIGTERM", abort);
    }
    if (!humanBootstrapComplete) humanChunks.length = 0;
    if (humanChunks.length === 0) return;
    const finalOutputController = new AbortController();
    const finalOutputDeadline = setTimeout(
      () => finalOutputController.abort(new Error("Final human watch output exceeded its deadline.")),
      1_000,
    );
    finalOutputDeadline.unref();
    try {
      await drainHumanChunks(finalOutputController.signal);
    } catch (error: unknown) {
      if (!isClosedStdout(error) && !finalOutputController.signal.aborted) throw error;
    } finally {
      clearTimeout(finalOutputDeadline);
    }
  };
  process.once("SIGINT", abort);
  if (input.sessionObserverSignalMode !== "foreground_interrupt") {
    process.once("SIGTERM", abort);
  }
  try {
    let command = invocation.command;
    if (presenter !== null) {
      const exactRequestedSession = sessionIdSchema.safeParse(invocation.command.session);
      const { sessionId } = await enumerateUnsettledSessionInteractions({
        callDaemon,
        ...(exactRequestedSession.success
          ? { expectedSessionId: exactRequestedSession.data }
          : {}),
        onInteractions: (interactions) => {
          bootstrappedInteractions.push(...interactions.map((interaction) => ({
            id: interaction.id,
            revision: interaction.revision,
            state: interaction.state,
          })));
          presenter.showInitialInteractions(interactions);
        },
        session: invocation.command.session,
        signal: controller.signal,
      });
      humanBootstrapComplete = true;
      presenter.flush();
      await drainHumanChunks(controller.signal);
      input.onHumanSessionObserverBootstrap?.({
        interactions: bootstrappedInteractions,
        sessionId,
      });
      command = { ...command, session: sessionId };
    }
    await followSessionEvents({
      command,
      ...(human
        ? { expectedSessionId: command.session }
        : sessionIdSchema.safeParse(command.session).success
          ? { expectedSessionId: command.session }
          : {}),
      fetchPage: async (command, signal) => {
        const response = await callDaemon(command, signal);
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
      ...(presenter === null
        ? {}
        : {
            writePage: async (page, _pageOutput, signal) => {
              presenter.acceptPage(page);
              presenter.flush();
              await drainHumanChunks(signal);
            },
          }),
    });
    return 0;
  } catch (error: unknown) {
    if (controller.signal.aborted) return 0;
    if (isClosedStdout(error)) return 0;
    if (error instanceof CommandFailure) {
      const failure = {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      };
      return human
        ? renderFailure(failure, false, output)
        : renderJsonlFailure(failure, output);
    }
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
      return human
        ? renderFailure(commandError as { code: string; message: string; details?: unknown }, false, output)
        : renderJsonlFailure(commandError as { code: string; message: string; details?: unknown }, output);
    }
    const failure = {
      code: "INTERNAL",
      message: error instanceof Error ? error.message : "Session event observation failed.",
    };
    return human
      ? renderFailure(failure, false, output)
      : renderJsonlFailure(failure, output);
  } finally {
    await finalize();
  }
}

async function executeWorkEventObserver(
  invocation: Extract<CliInvocation, { kind: "work.events.follow" }>,
  output: Output,
  input: CliMainInput,
): Promise<number> {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Work event observation stopped."));
  const callDaemon = commandCaller(input);
  process.once("SIGINT", abort);
  if (input.sessionObserverSignalMode !== "foreground_interrupt") {
    process.once("SIGTERM", abort);
  }
  try {
    await followWorkEvents({
      command: invocation.command,
      fetchPage: async (command, signal) => {
        const response = await callDaemon(command, signal);
        if (!response.ok) {
          throw Object.assign(new Error(response.error.message), {
            commandError: response.error,
          });
        }
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
    if (controller.signal.aborted || isClosedStdout(error)) return 0;
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
      return renderJsonlFailure(
        commandError as { code: string; message: string; details?: unknown },
        output,
      );
    }
    return renderJsonlFailure({
      code: "INTERNAL",
      message: "Work event observation failed before a safe page was available.",
    }, output);
  } finally {
    process.off("SIGINT", abort);
    if (input.sessionObserverSignalMode !== "foreground_interrupt") {
      process.off("SIGTERM", abort);
    }
  }
}

async function executeRootStatus(
  invocation: Extract<CliInvocation, { kind: "status" }>,
  output: Output,
  input: CliMainInput,
): Promise<number> {
  const installation = input.installation ?? createProductionInstallation();
  const data = input.readRootStatus === undefined
    ? await (async (): Promise<unknown> => {
        await requireInitializedDaemonState(installation.paths, "local_status");
        const store = new StateStore(installation.paths, { readonly: true });
        try {
          return store.readRootStatusSnapshot();
        } finally {
          store.close();
        }
      })()
    : input.readRootStatus(installation.paths);
  renderRootStatus(data, invocation.json, output);
  return 0;
}

const selectedId = (
  data: unknown,
  field: "account" | "session",
): string | null => {
  if (data === null || typeof data !== "object") return null;
  const value = (data as Record<string, unknown>)[field];
  if (value === null || typeof value !== "object") return null;
  const id = (value as Record<string, unknown>).id;
  const parsed = (field === "account" ? profileIdSchema : sessionIdSchema).safeParse(id);
  return parsed.success ? parsed.data : null;
};

const selectedShellSessionIdentity = (
  data: unknown,
):
  | Readonly<{ account: string; kind: "valid"; session: string }>
  | Readonly<{ kind: "invalid_account" | "invalid_session" }> => {
  const current = sessionStatusSchema.safeParse(data);
  if (current.success) {
    return {
      account: current.data.session.accountId,
      kind: "valid",
      session: current.data.session.id,
    };
  }
  const legacy = isRecord(data) && data.version === 1 ? data : null;
  if (legacy === null) return { kind: "invalid_session" };
  const session = selectedId(legacy, "session");
  if (session === null) return { kind: "invalid_session" };
  const legacySession = legacy.session;
  const account = profileIdSchema.safeParse(
    isRecord(legacySession) ? legacySession.profileId : undefined,
  );
  return account.success
    ? { account: account.data, kind: "valid", session }
    : { kind: "invalid_account" };
};

type ForegroundSessionBootstrap = Parameters<
  NonNullable<CliMainInput["onHumanSessionObserverBootstrap"]>
>[0];

const matchesSelectedSession = (
  observed: ForegroundSessionBootstrap | null,
  selected: string | undefined,
): observed is ForegroundSessionBootstrap =>
  observed !== null && observed.sessionId === selected;

export async function runPersistentShell(
  output: Output = processOutput,
  input: CliMainInput = {},
): Promise<number> {
  const terminal = input.readShellLine === undefined
    ? new ShellTerminalCoordinator({
        flushInput: () => flushProtectedTerminalInput(0),
        input: process.stdin,
        lifecycleHooks: {
          onSignal: (signal, listener) => {
            process.once(signal, listener);
            return () => process.off(signal, listener);
          },
          resignal: (signal) => process.kill(process.pid, signal),
        },
        output: process.stderr,
        terminal: true,
      })
    : null;
  const readLine = input.readShellLine ?? (async (prompt: string) =>
    terminal === null ? null : await terminal.question(prompt));
  const commandInput: CliMainInput = terminal === null || input.readProtectedDocument !== undefined
    ? input
    : {
        ...input,
        readProtectedDocument: async (source) => {
          if (source.kind === "stdin") {
            const discarded = await terminal.establishProtectedInputBoundary();
            if (discarded > 0) {
              throw new CliUsageError(
                "Protected input cannot consume pretyped shell lines. HRA discarded the buffered lines; retry and enter the protected document only after its hidden prompt appears.",
              );
            }
          }
          return await terminal.withSignalHandlingSuspended(
            async () => await withProtectedTerminalLifecycle(
              async (signal) => await readProtectedDocument(source, output, signal),
              terminal.lifecycleSignal,
            ),
          );
        },
      };
  let foregroundBootstrap: ForegroundSessionBootstrap | null = null;
  const shellCommandInput: CliMainInput = {
    ...commandInput,
    ...(terminal === null ? {} : { sessionObserverSignalMode: "foreground_interrupt" as const }),
    onHumanSessionObserverBootstrap: (bootstrap) => {
      foregroundBootstrap = bootstrap;
      commandInput.onHumanSessionObserverBootstrap?.(bootstrap);
    },
  };
  const callDaemon = commandCaller(input);
  let live: ShellLiveObserver | null = null;
  let liveOutputEnabled = true;
  try {
    const status = await callDaemon({ kind: "daemon.status" });
    if (!status.ok) return renderFailure(status.error, false, output);
    daemonStatusIdentity(status);
    live = new ShellLiveObserver({
      callDaemon,
      write: (value) => {
        if (!liveOutputEnabled) return;
        if (terminal === null) output.writeStderr(value);
        else terminal.writeLive(value);
      },
    });
    let selection: ShellSelection = {};
    const stopSelectedSessionLive = async (): Promise<void> => {
      liveOutputEnabled = false;
      await live?.stop();
      terminal?.discardHeldLiveOutput();
    };
    const restartSelectedSessionLive = async (
      bootstrap: ForegroundSessionBootstrap | null,
    ): Promise<void> => {
      if (selection.session === undefined || selection.account === undefined) return;
      try {
        const response = await callDaemon({
          kind: "session.status",
          session: selection.session,
        });
        if (!response.ok) {
          output.writeStderr(
            "hra: Live updates remain paused because HRA could not refresh the exact selected session. Reselect it to resume.\n",
          );
          return;
        }
        const identity = selectedShellSessionIdentity(response.data);
        if (
          identity.kind !== "valid"
          || identity.session !== selection.session
          || identity.account !== selection.account
        ) {
          output.writeStderr(
            "hra: Live updates remain paused because HRA could not refresh the exact selected session. Reselect it to resume.\n",
          );
          return;
        }
        liveOutputEnabled = true;
        await live?.select({
          session: identity.session,
          statusData: response.data,
          ...(bootstrap === null
            ? {}
            : {
                suppressedInitialInteractionKeys: new Set(
                  bootstrap.interactions.map(pendingInteractionStateKey),
                ),
              }),
        });
      } catch {
        liveOutputEnabled = false;
        output.writeStderr(
          "hra: Live updates remain paused because HRA could not refresh the exact selected session. Reselect it to resume.\n",
        );
      }
    };
    output.writeStderr("HRA shell. /help lists commands; /exit leaves the daemon running.\n");
    for (;;) {
      let line: string | null;
      try {
        line = await readLine(formatShellPrompt(selection));
      } catch {
        output.writeStderr("hra: Shell input is unavailable.\n");
        return 1;
      }
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
          const exactAccount = profileIdSchema.safeParse(intent.selector);
          if (exactAccount.success && account !== exactAccount.data) {
            throw new Error("Selected account response does not match the exact requested account.");
          }
          await stopSelectedSessionLive();
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
          const identity = selectedShellSessionIdentity(response.data);
          if (identity.kind !== "valid") {
            throw new Error(identity.kind === "invalid_account"
              ? "Selected session account response is invalid."
              : "Selected session response is invalid.");
          }
          const { account, session } = identity;
          const exactSession = sessionIdSchema.safeParse(intent.selector);
          if (exactSession.success && session !== exactSession.data) {
            throw new Error("Selected session response does not match the exact requested session.");
          }
          await stopSelectedSessionLive();
          selection = { account, session };
          output.writeStderr(`Selected session ${terminalSafe(session)}.\n`);
          liveOutputEnabled = true;
          await live.select({ session, statusData: response.data });
          continue;
        }
        const execute = async (): Promise<number> => await main(intent.argv, output, shellCommandInput);
        let parsedForeground: CliInvocation | null = null;
        try {
          parsedForeground = parseCli(intent.argv);
        } catch {
          // main owns diagnostics for malformed shell commands.
        }
        const foregroundObserver = parsedForeground?.kind === "session.events.follow"
          || parsedForeground?.kind === "session.events.watch";
        const foregroundEventRead = foregroundObserver
          || (
            parsedForeground?.kind === "command"
            && parsedForeground.command.kind === "session.events"
          );
        const ownsForegroundSignal = foregroundObserver
          || (
            parsedForeground?.kind === "command"
            && parsedForeground.command.kind === "session.events"
            && parsedForeground.command.waitMs > 0
        );
        const runForeground = async (): Promise<void> => {
          if (foregroundEventRead) await stopSelectedSessionLive();
          foregroundBootstrap = null;
          try {
            if (terminal !== null && ownsForegroundSignal) {
              await terminal.withInterruptHandlingSuspended(execute);
            } else {
              await execute();
            }
          } finally {
            if (foregroundEventRead) {
              await restartSelectedSessionLive(
                matchesSelectedSession(foregroundBootstrap, selection.session)
                  ? foregroundBootstrap
                  : null,
              );
            }
          }
        };
        if (terminal === null) await runForeground();
        else await terminal.withLiveOutputHeld(runForeground);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Shell command failed.";
        output.writeStderr(`hra: ${safeDiagnostic(message)}\n`);
      }
    }
  } catch (error: unknown) {
    if (error instanceof CommandFailure) {
      return renderFailure({
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      }, false, output);
    }
    bestEffortStderr(output, "hra: HRA could not start or continue the shell safely.\n");
    return 1;
  } finally {
    liveOutputEnabled = false;
    await live?.stop().catch(() => undefined);
    terminal?.close();
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

function renderHelp(invocation: Extract<CliInvocation, { kind: "help" }>, output: Output): number {
  const resolved = resolveUsage(invocation.group, invocation.leaf);
  output.writeStdout(invocation.json
    ? `${safeJson({ ok: true, version: 1, command: "help", data: resolved })}\n`
    : `${resolved.usage}\n`);
  return 0;
}

function renderVersion(invocation: Extract<CliInvocation, { kind: "version" }>, output: Output): number {
  output.writeStdout(invocation.json
    ? `${safeJson({ ok: true, version: 1, command: "version", data: { version: HRA_VERSION } })}\n`
    : `hra ${HRA_VERSION}\n`);
  return 0;
}

// One verdict decides both the doctor exit code and its JSON envelope. Any result that is
// not an exact healthy shape exits 1 and reports `UNHEALTHY`, so `ok` never disagrees with
// the exit code. The validated data stays beside the error for callers that read problems.
function doctorVerdict(data: unknown): Readonly<{ healthy: boolean; message: string }> {
  const doctor = isRecord(data) ? data : null;
  const problems = Array.isArray(doctor?.problems)
    && doctor.problems.every((value) => typeof value === "string")
    ? (doctor.problems as readonly string[])
    : null;
  if (doctor === null || typeof doctor.healthy !== "boolean" || problems === null) {
    return { healthy: false, message: "HRA checks returned an invalid local result." };
  }
  if (doctor.healthy && problems.length === 0) return { healthy: true, message: "HRA checks passed." };
  const count = problems.length;
  return {
    healthy: false,
    message: count === 0
      ? "HRA checks did not pass, but no safe diagnostic was available."
      : `HRA checks found ${String(count)} problem${count === 1 ? "" : "s"}.`,
  };
}

function unhealthyDoctorEnvelope(
  data: unknown,
  message: string,
  command?: "doctor",
): Readonly<Record<string, unknown>> {
  return {
    ok: false,
    version: 1,
    ...(command === undefined ? {} : { command }),
    data,
    error: { code: "UNHEALTHY", message },
  };
}

function renderDoctorOutcome(
  command: Extract<LocalCommand, { kind: "doctor" }>,
  data: unknown,
  json: boolean,
  output: Output,
): number {
  const verdict = doctorVerdict(data);
  if (verdict.healthy || !json) {
    renderSuccess(command, data, json, output);
    return verdict.healthy ? 0 : 1;
  }
  output.writeStdout(`${safeJson(unhealthyDoctorEnvelope(data, verdict.message, "doctor"))}\n`);
  return 1;
}

async function executeInvocation(
  invocation: CliInvocation,
  output: Output,
  input: CliMainInput = {},
): Promise<number> {
  const installation = input.installation ?? createProductionInstallation();
  assertInstallationHome(installation);
  if (invocation.kind === "help") return renderHelp(invocation, output);
  if (invocation.kind === "version") return renderVersion(invocation, output);
  if (invocation.kind === "command" && invocation.command.kind === "work.protocol") {
    // The protocol document is a pure function of the query, so it is served without
    // initialized state or a daemon. The daemon keeps the same operation for parity.
    renderSuccess(invocation.command, describeWorkProtocol(invocation.command.query), true, output);
    return 0;
  }
  const callDaemon = commandCaller({ ...input, installation });
  if (invocation.kind === "status") {
    return await executeRootStatus(invocation, output, { ...input, installation });
  }
  if (invocation.kind === "init") {
    return await initialize(invocation.yes, invocation.json, output, {
      documentsDirectory: installation.documentsDirectory,
      paths: installation.paths,
    });
  }
  if (invocation.kind === "daemon.run") return await runDaemon(installation);
  if (invocation.kind === "remote") {
    return await executeRemoteInvocation(invocation, output, { ...input, installation });
  }
  if (invocation.kind === "account.login-handoff") {
    return await executeAccountLogin(invocation, output, input);
  }
  if (invocation.kind === "auth.login-protected") {
    return await executeProtectedAuthLogin(invocation, output, input);
  }
  if (invocation.kind === "work.apply-input") {
    return await executeWorkApply(invocation, output, input);
  }
  if (invocation.kind === "interaction.resolve-protected") {
    return await executeProtectedInteraction(invocation, output, input);
  }
  if (invocation.kind === "interaction.inspect-protected") {
    return await executeProtectedInteractionInspect(invocation, output, input);
  }
  if (invocation.kind === "session.events.follow" || invocation.kind === "session.events.watch") {
    return await executeSessionEventObserver(invocation, output, input);
  }
  if (invocation.kind === "work.events.follow") {
    return await executeWorkEventObserver(invocation, output, input);
  }
  if (invocation.kind === "interaction-required") {
    return renderFailure(invocation.error, invocation.json, output);
  }
  if (invocation.kind === "sync.projection-recover") {
    const response = await callDaemon(invocation.command);
    if (!response.ok) {
      return renderProjectionRecoveryFailure(response.error, invocation, output);
    }
    return renderProjectionRecoverySuccess(response.data, invocation, output);
  }
  if (invocation.kind === "daemon.start") {
    try {
      const existing = await callLocalDaemon({ paths: installation.paths, command: { kind: "daemon.status" }, deadlineMs: 500 });
      if (existing.ok) {
        daemonStatusIdentity(existing);
        renderSuccess({ kind: "daemon.status" }, existing.data, invocation.json, output);
        return 0;
      }
    } catch (error: unknown) {
      if (!isLocalDaemonUnavailable(error)) throw error;
    }
    await requireInitializedDaemonState(installation.paths);
    const ready = await (input.startDaemon ?? startDaemonProcess)(installation);
    renderSuccess({ kind: "daemon.status" }, ready, invocation.json, output);
    return 0;
  }
  if (invocation.command.kind === "doctor" && invocation.command.offline) {
    return await offlineDoctor(
      invocation.json,
      output,
      input.statePaths ?? installation.paths,
      input.offlineDoctorOwnerUid,
    );
  }
  if (
    invocation.command.kind === "account.usage"
    && invocation.command.refresh
    && invocation.command.account === undefined
  ) {
    return await executeUsageRefreshAll(invocation.command, invocation.json, output, input);
  }
  if (invocation.command.kind === "session.note.edit") {
    return await editSessionNote(invocation.command.session, invocation.json, output, callDaemon);
  }
  if (invocation.command.kind === "daemon.status") {
    try {
      const paths = installation.paths;
      const response = await callLocalDaemon({ paths, command: invocation.command, deadlineMs: 500 });
      if (!response.ok) return renderFailure(response.error, invocation.json, output);
      daemonStatusIdentity(response);
      renderSuccess(invocation.command, response.data, invocation.json, output);
    } catch (error: unknown) {
      if (!isLocalDaemonUnavailable(error)) throw error;
      renderSuccess(invocation.command, { running: false }, invocation.json, output);
    }
    return 0;
  }
  if (invocation.command.kind === "daemon.stop") {
    const result = await stopDaemonWithExactAuthority(
      installation.paths,
      input.daemonStopDependencies ?? defaultDaemonStopDependencies,
    );
    if (result.kind === "failure") return renderFailure(result.error, invocation.json, output);
    renderSuccess(invocation.command, result.data, invocation.json, output);
    return 0;
  }
  let command = invocation.command;
  if (invocation.command.kind === "project.add") {
    let canonicalProjectRoot: string | null = null;
    try {
      const canonical = await realpath(invocation.command.path);
      canonicalProjectRoot = await resolveUsableCanonicalProjectDirectory(canonical);
    } catch {
      canonicalProjectRoot = null;
    }
    if (canonicalProjectRoot === null) {
      return renderFailure({
        code: "INVALID_INPUT",
        message: "The project directory does not exist or is not readable, writable, traversable, and canonical. Restore access or choose another directory, then retry.",
      }, invocation.json, output);
    }
    command = { ...invocation.command, path: canonicalProjectRoot };
  }
  let response: CommandResponse;
  if (
    command.kind === "session.events"
    && command.waitMs > 0
    && input.sessionObserverSignalMode === "foreground_interrupt"
  ) {
    const controller = new AbortController();
    const abort = () => controller.abort(new Error("Session event read interrupted."));
    process.once("SIGINT", abort);
    try {
      response = await callDaemon(command, controller.signal);
      if (controller.signal.aborted) return 0;
    } catch (error: unknown) {
      if (controller.signal.aborted) return 0;
      throw error;
    } finally {
      process.off("SIGINT", abort);
    }
  } else {
    response = await callDaemon(command);
  }
  if (!response.ok) {
    return command.kind === "sync.now"
      ? renderSyncNowFailure(response.error, invocation.json, output)
      : renderFailure(response.error, invocation.json, output);
  }
  if (command.kind === "sync.now") {
    return renderSyncNowSuccess(response.data, invocation.json, output);
  }
  if (command.kind === "doctor") return renderDoctorOutcome(command, response.data, invocation.json, output);
  renderSuccess(command, response.data, invocation.json, output);
  return 0;
}

export async function main(
  argv: readonly string[] = Bun.argv.slice(2),
  output: Output = processOutput,
  input: CliMainInput = {},
): Promise<number> {
  const installation = input.installation ?? createProductionInstallation();
  assertInstallationHome(installation);
  const resolvedInput = { ...input, installation };
  const interactive = resolvedInput.interactive
    ?? (process.stdin.isTTY && process.stderr.isTTY);
  if (argv.length === 0 && interactive) return await runPersistentShell(output, resolvedInput);
  const json = requestsJsonOutput(argv);
  const jsonl = requestsJsonlOutput(argv);
  let invocation: CliInvocation | undefined;
  try {
    invocation = parseCli(argv);
    return await executeInvocation(invocation, output, { ...resolvedInput, interactive });
  } catch (error: unknown) {
    const syncNow = invocation?.kind === "command" && invocation.command.kind === "sync.now";
    const projectionRecovery = invocation?.kind === "sync.projection-recover"
      ? invocation
      : undefined;
    const deviceMutation = invocation?.kind === "command"
      && (
        invocation.command.kind === "device.approve"
        || invocation.command.kind === "device.revoke"
      )
      ? invocation.command
      : undefined;
    const replayableLocalMutation = invocation?.kind === "command"
      && (
        invocation.command.kind === "account.logout"
        || invocation.command.kind === "account.switch"
        || invocation.command.kind === "session.start"
        || invocation.command.kind === "session.send"
        || invocation.command.kind === "session.queue"
        || invocation.command.kind === "session.steer"
        || invocation.command.kind === "session.stop"
        || invocation.command.kind === "session.rename"
        || invocation.command.kind === "session.task.create"
        || invocation.command.kind === "session.task.edit"
        || invocation.command.kind === "session.task.delete"
      )
      && typeof invocation.command.idempotencyKey === "string"
      ? invocation.command
      : undefined;
    const sanitizeDaemonDiagnostic = (message: string): string =>
      syncNow || projectionRecovery !== undefined
        ? sanitizeSyncDiagnostic(message)
        : message;
    if (error instanceof CliUsageError) {
      if (requestsWorkApplyProtocol(argv)) {
        writeWorkProtocolFailure(null, {
          code: "invalid_request",
          message: "The work apply invocation is invalid.",
          recovery: "none",
          retryable: false,
          exitCode: 2,
        }, output);
        return 2;
      }
      if (jsonl) return renderJsonlFailure({ code: "INVALID_INPUT", message: error.message }, output);
      if (json) return renderFailure({ code: "INVALID_INPUT", message: error.message }, true, output);
      output.writeStderr(`hra: ${safeDiagnostic(error.message)}\n\n${usageForGroup(undefined)}\n`);
      return 2;
    }
    if (error instanceof InvalidCommandResponseError) {
      return renderFailure({
        code: "INVALID_RESPONSE",
        message: "The HRA daemon returned an invalid response for this command.",
      }, json, output);
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
      if (deviceMutation !== undefined) {
        return renderFailure({
          code: "RECOVERY_REQUIRED",
          details: {
            idempotencyKey: deviceMutation.idempotencyKey,
            nextCommand: deviceMutationReplayCommand(deviceMutation, json),
            sameKeyReplay: true,
          },
          message: "The device mutation response is uncertain. Reuse the exact same-key command; HRA did not create a second device-mutation authority.",
        }, json, output);
      }
      if (replayableLocalMutation !== undefined) {
        return renderFailure({
          code: "RECOVERY_REQUIRED",
          details: {
            idempotencyKey: replayableLocalMutation.idempotencyKey,
            replayArguments: [
              "--idempotency-key",
              replayableLocalMutation.idempotencyKey,
            ],
            replayPlacement: "before_double_dash",
            sameKeyReplay: true,
          },
          message: "The mutation response is uncertain. Re-run the original command unchanged with the supplied same-key replay arguments before any double-dash delimiter. HRA did not create a second mutation authority.",
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
    if (error instanceof CommandFailure) {
      return renderFailure({
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
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
