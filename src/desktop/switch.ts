import type { ChatGptBundleCapability } from "./bundle.ts";
import { CODEX_ELECTRON_USER_DATA_PATH, CODEX_HOME } from "./bundle.ts";
import { DesktopSwitchError } from "./errors.ts";
import { deriveDesktopProfilePaths, type DesktopProfilePaths } from "./profile.ts";

export interface DesktopProcessIdentity {
  readonly pid: number;
  readonly executablePath: string;
}

export interface DesktopSwitchGeneration {
  readonly switchGeneration: number;
  readonly sourceProfileId: string | null;
  readonly sourceProcessGeneration: number | null;
  readonly targetProfileId: string;
  readonly targetProcessGeneration: number;
}

export type DesktopSwitchStage =
  | "prepared"
  | "quit-requested"
  | "source-quiesced"
  | "launch-requested"
  | "target-observed"
  | "verified"
  | "recovery-required";

export interface DesktopSwitchJournalEntry extends DesktopSwitchGeneration {
  readonly idempotencyKey: string;
  readonly bundleCdHash: string;
  readonly sourcePid: number | null;
  readonly targetPaths: DesktopProfilePaths;
  readonly expectedAccountKey: string;
}

export interface DesktopSwitchJournalPort {
  prepare(entry: DesktopSwitchJournalEntry): Promise<void>;
  advance(
    idempotencyKey: string,
    switchGeneration: number,
    stage: DesktopSwitchStage,
    details?: { readonly launchedPid?: number; readonly safeReason?: string },
  ): Promise<void>;
}

export interface DesktopSwitchLockPort {
  withLock<T>(effect: () => Promise<T>): Promise<T>;
}

export interface DesktopBundlePort {
  inspect(): Promise<ChatGptBundleCapability>;
}

export interface DesktopProcessPort {
  listExact(executablePath: string): Promise<readonly DesktopProcessIdentity[]>;
  requestGracefulQuit(process: DesktopProcessIdentity): Promise<void>;
  waitForExit(process: DesktopProcessIdentity, timeoutMs: number): Promise<boolean>;
  launch(input: {
    readonly executablePath: string;
    readonly environment: Readonly<Record<string, string>>;
  }): Promise<DesktopProcessIdentity>;
  waitForExactProcess(
    executablePath: string,
    expectedPid: number,
    timeoutMs: number,
  ): Promise<DesktopProcessIdentity | null>;
}

export interface DesktopSwitchAuthorityPort {
  assertEffectsSettled(generation: DesktopSwitchGeneration): Promise<void>;
  isCurrent(generation: DesktopSwitchGeneration): boolean | Promise<boolean>;
}

export interface DesktopAccountVerificationPort {
  readAccountKey(input: {
    readonly profileId: string;
    readonly processGeneration: number;
    readonly instance: {
      readonly pid: number;
      readonly executablePath: string;
      readonly bundleCdHash: string;
      readonly codexHome: string;
      readonly desktopUserData: string;
    };
  }): Promise<string | null>;
}

export interface DesktopSwitchRequest extends DesktopSwitchGeneration {
  readonly idempotencyKey: string;
  readonly expectedAccountKey: string;
  readonly stateRoot: string;
  readonly baseEnvironment: Readonly<Record<string, string | undefined>>;
}

export interface DesktopSwitchResult {
  readonly status: "switched";
  readonly profileId: string;
  readonly processGeneration: number;
  readonly desktopPid: number;
  readonly switchGeneration: number;
}

export interface DesktopSwitchPreflight {
  readonly capability: ChatGptBundleCapability;
  readonly running: readonly DesktopProcessIdentity[];
}

export interface DesktopSwitchControllerPorts {
  readonly bundle: DesktopBundlePort;
  readonly process: DesktopProcessPort;
  readonly authority: DesktopSwitchAuthorityPort;
  readonly journal: DesktopSwitchJournalPort;
  readonly lock: DesktopSwitchLockPort;
  readonly account: DesktopAccountVerificationPort;
}

/**
 * Journaled switch coordinator. It selects already-isolated directories; it never copies
 * credentials, edits Keychain, or moves provider state.
 */
export class DesktopSwitchController {
  readonly #ports: DesktopSwitchControllerPorts;

  constructor(ports: DesktopSwitchControllerPorts) {
    this.#ports = ports;
  }

  async switchProfile(request: DesktopSwitchRequest): Promise<DesktopSwitchResult> {
    validateSwitchRequest(request);
    return this.#ports.lock.withLock(async () => {
      const preflight = await this.inspectPreflight();
      return this.#switchLocked(request, preflight);
    });
  }

  /**
   * Read every deterministic bundle and process prerequisite before durable
   * switch authority is reserved. The caller must already hold the machine lock.
   */
  async inspectPreflight(): Promise<DesktopSwitchPreflight> {
    return inspectDesktopSwitchPreflight(this.#ports.bundle, this.#ports.process);
  }

  /** Execute from an immutable preflight while the caller retains the same lock. */
  async switchProfileLocked(
    request: DesktopSwitchRequest,
    preflight: DesktopSwitchPreflight,
  ): Promise<DesktopSwitchResult> {
    validateSwitchRequest(request);
    return this.#switchLocked(request, preflight);
  }

  async #switchLocked(
    request: DesktopSwitchRequest,
    preflight: DesktopSwitchPreflight,
  ): Promise<DesktopSwitchResult> {
    const { capability, running } = preflight;
    await this.#assertCurrent(request);
    await this.#ports.authority.assertEffectsSettled(request);
    const confirmedRunning = await this.#ports.process.listExact(capability.executablePath);
    if (!sameProcessSet(running, confirmedRunning)) {
      throw new DesktopSwitchError(
        "PROCESS_AMBIGUOUS",
        "the exact ChatGPT process set changed after switch preflight",
      );
    }
    const source = running[0] ?? null;
    const targetPaths = deriveDesktopProfilePaths(request.stateRoot, request.targetProfileId);
    const journal: DesktopSwitchJournalEntry = {
      idempotencyKey: request.idempotencyKey,
      switchGeneration: request.switchGeneration,
      sourceProfileId: request.sourceProfileId,
      sourceProcessGeneration: request.sourceProcessGeneration,
      targetProfileId: request.targetProfileId,
      targetProcessGeneration: request.targetProcessGeneration,
      bundleCdHash: capability.cdHash,
      sourcePid: source?.pid ?? null,
      targetPaths,
      expectedAccountKey: request.expectedAccountKey,
    };
    await this.#ports.journal.prepare(journal);

    if (source !== null) {
      await this.#assertCurrent(request);
      await this.#ports.journal.advance(
        request.idempotencyKey,
        request.switchGeneration,
        "quit-requested",
      );
      try {
        await this.#ports.process.requestGracefulQuit(source);
      } catch (error) {
        await this.#recovery(request, "graceful quit dispatch was indeterminate");
        throw recovery("ChatGPT quit requires recovery", error);
      }
      const exited = await this.#ports.process.waitForExit(source, 15_000);
      if (!exited) {
        await this.#recovery(request, "ChatGPT did not quiesce before the deadline");
        throw recovery("ChatGPT did not quit cleanly");
      }
      await this.#ports.journal.advance(
        request.idempotencyKey,
        request.switchGeneration,
        "source-quiesced",
      );
    }

    try {
      await this.#assertCurrent(request);
    } catch (error) {
      await this.#recovery(request, "authority changed after source quiescence");
      throw error;
    }
    await this.#ports.journal.advance(
      request.idempotencyKey,
      request.switchGeneration,
      "launch-requested",
    );
    let launched: DesktopProcessIdentity;
    try {
      launched = await this.#ports.process.launch({
        executablePath: capability.executablePath,
        environment: desktopLaunchEnvironment(request.baseEnvironment, targetPaths),
      });
    } catch (error) {
      await this.#recovery(request, "target launch dispatch was indeterminate");
      throw recovery("ChatGPT relaunch requires recovery", error);
    }
    const observed = await this.#ports.process.waitForExactProcess(
      capability.executablePath,
      launched.pid,
      15_000,
    );
    if (observed === null) {
      await this.#recovery(request, "the launched ChatGPT process could not be verified");
      throw recovery("ChatGPT relaunch could not be verified");
    }
    await this.#ports.journal.advance(
      request.idempotencyKey,
      request.switchGeneration,
      "target-observed",
      { launchedPid: observed.pid },
    );

    await this.#assertCurrentOrRecover(request, "authority changed before account verification");
    const accountKey = await this.#ports.account.readAccountKey({
      profileId: request.targetProfileId,
      processGeneration: request.targetProcessGeneration,
      instance: {
        pid: observed.pid,
        executablePath: observed.executablePath,
        bundleCdHash: capability.cdHash,
        codexHome: targetPaths.codexHome,
        desktopUserData: targetPaths.desktopUserData,
      },
    });
    if (accountKey === null || !timingSafeTextEqual(accountKey, request.expectedAccountKey)) {
      await this.#recovery(request, "the relaunched account did not match the selected profile");
      throw recovery("ChatGPT opened with an unexpected account");
    }
    await this.#ports.journal.advance(
      request.idempotencyKey,
      request.switchGeneration,
      "verified",
      { launchedPid: observed.pid },
    );
    return {
      status: "switched",
      profileId: request.targetProfileId,
      processGeneration: request.targetProcessGeneration,
      desktopPid: observed.pid,
      switchGeneration: request.switchGeneration,
    };
  }

  async #assertCurrent(generation: DesktopSwitchGeneration): Promise<void> {
    if (!(await this.#ports.authority.isCurrent(generation))) {
      throw new DesktopSwitchError("GENERATION_STALE", "desktop switch generation is stale");
    }
  }

  async #assertCurrentOrRecover(
    generation: DesktopSwitchRequest,
    reason: string,
  ): Promise<void> {
    if (!(await this.#ports.authority.isCurrent(generation))) {
      await this.#recovery(generation, reason);
      throw new DesktopSwitchError("RECOVERY_REQUIRED", reason);
    }
  }

  async #recovery(request: DesktopSwitchRequest, safeReason: string): Promise<void> {
    await this.#ports.journal.advance(
      request.idempotencyKey,
      request.switchGeneration,
      "recovery-required",
      { safeReason },
    );
  }
}

export async function inspectDesktopSwitchPreflight(
  bundle: DesktopBundlePort,
  process: DesktopProcessPort,
): Promise<DesktopSwitchPreflight> {
  const capability = await bundle.inspect();
  const running = await process.listExact(capability.executablePath);
  if (running.length > 1) {
    throw new DesktopSwitchError(
      "PROCESS_AMBIGUOUS",
      "more than one supported ChatGPT process is running",
    );
  }
  return { capability, running };
}

const DESKTOP_ENV_ALLOWLIST = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "USER",
]);

export function desktopLaunchEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  paths: DesktopProfilePaths,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(base)) {
    if (DESKTOP_ENV_ALLOWLIST.has(key) && value !== undefined) environment[key] = value;
  }
  environment[CODEX_HOME] = paths.codexHome;
  environment[CODEX_ELECTRON_USER_DATA_PATH] = paths.desktopUserData;
  return Object.freeze(environment);
}

function validateSwitchRequest(request: DesktopSwitchRequest): void {
  if (!Number.isSafeInteger(request.switchGeneration) || request.switchGeneration < 1) {
    throw new DesktopSwitchError("GENERATION_STALE", "switch generation must be positive");
  }
  if (
    !Number.isSafeInteger(request.targetProcessGeneration) ||
    request.targetProcessGeneration < 1
  ) {
    throw new DesktopSwitchError("GENERATION_STALE", "target generation must be positive");
  }
  if (
    (request.sourceProfileId === null) !== (request.sourceProcessGeneration === null) ||
    (request.sourceProcessGeneration !== null &&
      (!Number.isSafeInteger(request.sourceProcessGeneration) || request.sourceProcessGeneration < 1))
  ) {
    throw new DesktopSwitchError("GENERATION_STALE", "source authority is incomplete");
  }
  for (const [label, value, max] of [
    ["idempotency key", request.idempotencyKey, 256],
    ["account key", request.expectedAccountKey, 1_024],
  ] as const) {
    if (value.length < 1 || value.length > max || /\p{Cc}/u.test(value)) {
      throw new DesktopSwitchError("INVALID_PROFILE", `${label} is invalid`);
    }
  }
  deriveDesktopProfilePaths(request.stateRoot, request.targetProfileId);
}

function recovery(message: string, cause?: unknown): DesktopSwitchError {
  return new DesktopSwitchError(
    "RECOVERY_REQUIRED",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function timingSafeTextEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.byteLength, rightBytes.byteLength);
  let difference = leftBytes.byteLength ^ rightBytes.byteLength;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function sameProcessSet(
  left: readonly DesktopProcessIdentity[],
  right: readonly DesktopProcessIdentity[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (process, index) =>
        process.pid === right[index]?.pid &&
        process.executablePath === right[index].executablePath,
    )
  );
}
