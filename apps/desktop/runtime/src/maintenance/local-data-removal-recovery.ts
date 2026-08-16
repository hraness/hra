import { operationIdSchema, runtimeProtocolVersion } from "../../../contracts/runtime";
import {
  hostLocalDataRemovalNativeLaunch,
  hostLocalDataRemovalRecoveryResult,
  type HostLocalDataRemovalNativeLaunch,
  type HostLocalDataRemovalRecoveryResult,
} from "../host-protocol";
import {
  FileLocalDataRemovalReceiptStore,
  loadOrCreateLocalDataRemovalHelperState,
  localDataRemovalExclusionPath,
  localDataRemovalSigningKeyFileName,
  resumePendingLocalDataRemovalHelperLaunch,
  type AuthenticatedLocalDataRemovalSecretStore,
} from "./local-data-removal";
import {
  fixedLocalDataRemovalPaths,
} from "./local-data-removal-inventory";
import { lstat, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { optionalRenamedEnvironmentValue } from "../security/renamed-environment";

export const startupLocalDataRemovalRecoveryEnvironment =
  "HRA_STARTUP_REMOVAL_RECOVERY" as const;

export function startupLocalDataRemovalRecoveryRequested(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return optionalRenamedEnvironmentValue(
    environment,
    startupLocalDataRemovalRecoveryEnvironment,
  ) === "1";
}

export type StartupLocalDataRemovalRecoveryResult =
  | HostLocalDataRemovalNativeLaunch
  | HostLocalDataRemovalRecoveryResult;

export interface StartupLocalDataRemovalRecoveryOptions {
  readonly effectiveHome: string;
  readonly nativeRecoveryPrepared: boolean;
  readonly nativeRemovalCapability: string;
  readonly parentProcessId: number;
  readonly secrets: AuthenticatedLocalDataRemovalSecretStore;
}

/**
 * The startup recovery process deliberately has no database, network, Codex,
 * or renderer dependencies. It never executes the helper; after the verified
 * Native preparation signal it may resume one authenticated gateway receipt.
 */
export async function runStartupLocalDataRemovalRecovery(
  options: StartupLocalDataRemovalRecoveryOptions,
): Promise<StartupLocalDataRemovalRecoveryResult> {
  if (options.nativeRecoveryPrepared !== true) {
    throw new TypeError("Native local-data recovery is not prepared.");
  }
  if (
    !Number.isSafeInteger(options.parentProcessId) ||
    options.parentProcessId < 2
  ) {
    throw new TypeError("The Native parent process is invalid.");
  }
  const fixed = fixedLocalDataRemovalPaths(options.effectiveHome);
  const tombstoneCount = await countRemovalTombstones(
    fixed.helperStateRoot,
  );
  if (tombstoneCount !== 0) {
    throw new Error("Native local-data recovery preparation is incomplete.");
  }

  const helperState = await lstat(fixed.helperStateRoot).catch(
    (error: unknown) => {
      if (isFileSystemError(error, "ENOENT")) return null;
      throw error;
    },
  );
  if (helperState === null) {
    const exclusion = await lstat(
      localDataRemovalExclusionPath(fixed.helperStateRoot),
    ).catch((error: unknown) => {
      if (isFileSystemError(error, "ENOENT")) return null;
      throw error;
    });
    if (exclusion !== null) {
      throw new Error(
        "Native local-data recovery left its startup exclusion active.",
      );
    }
    return hostLocalDataRemovalRecoveryResult("clear", 0);
  }
  if (helperState.isSymbolicLink() || !helperState.isDirectory()) {
    throw new Error("HRA local-data recovery state is unsafe.");
  }

  const receipts = new FileLocalDataRemovalReceiptStore(
    fixed.helperStateRoot,
  );
  const pending = await receipts.list();
  if (pending.length === 0) {
    throw new Error(
      "Native local-data recovery left unclaimed helper state.",
    );
  }
  const signingKeyPath = join(
    fixed.helperStateRoot,
    localDataRemovalSigningKeyFileName,
  );
  const signingKeyMetadata = await lstat(signingKeyPath).catch(
    (error: unknown) => {
      if (isFileSystemError(error, "ENOENT")) return null;
      throw error;
    },
  );
  if (signingKeyMetadata === null) {
    throw new Error("HRA local-data recovery key is missing.");
  }
  const helper = await loadOrCreateLocalDataRemovalHelperState(
    fixed.helperStateRoot,
  );
  const launch = await resumePendingLocalDataRemovalHelperLaunch({
    parentProcessId: options.parentProcessId,
    nativeRemovalCapability: options.nativeRemovalCapability,
    signingKey: helper.signingKey,
    signingKeyPath: helper.signingKeyPath,
    secrets: options.secrets,
    receipts,
    maintenanceFence: {
      isHeld: () => true,
    },
  });
  if (launch === null) {
    throw new Error(
      "A pending local-data removal vanished during recovery.",
    );
  }
  const operationId = launch.signedRequest.payload.operationId;
  const previewId = launch.signedRequest.payload.previewId;
  return hostLocalDataRemovalNativeLaunch({
    operationId,
    previewId,
    parentProcessId: launch.parentProcessId,
    requestPath: launch.requestPath,
    signingKeyPath: launch.signingKeyPath,
    publicResponse: {
      version: runtimeProtocolVersion,
      operationId,
      ok: true,
      result: {
        type: "localDataRemovalScheduled",
        previewId,
        state: "scheduled",
        willQuitApplication: true,
      },
    },
  });
}

async function countRemovalTombstones(
  helperStateRoot: string,
): Promise<number> {
  const parent = dirname(helperStateRoot);
  const prefix = `.${basename(helperStateRoot)}.removing-`;
  const entries = await readdir(parent, { withFileTypes: true });
  return entries.filter((entry) =>
    entry.isDirectory() &&
    !entry.isSymbolicLink() &&
    entry.name.startsWith(prefix) &&
    operationIdSchema.safeParse(entry.name.slice(prefix.length)).success
  ).length;
}

function isFileSystemError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
