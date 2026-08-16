import { dlopen, FFIType } from "bun:ffi";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

const LOCK_EX = 0x02;
const LOCK_NB = 0x04;

export type ControlPlaneLifetimeLockErrorCode =
  | "already_running"
  | "invalid_path"
  | "lock_failed"
  | "unsupported_platform";

export class ControlPlaneLifetimeLockError extends Error {
  readonly code: ControlPlaneLifetimeLockErrorCode;

  constructor(code: ControlPlaneLifetimeLockErrorCode, message: string) {
    super(message);
    this.name = "ControlPlaneLifetimeLockError";
    this.code = code;
  }
}

export interface ControlPlaneLifetimeLock {
  readonly path: string;
  bindControlPlane(): ControlPlaneFileSystemAuthority;
  release(): void;
}

export interface ControlPlaneFileSystemAuthority {
  readonly controlPlanePath: string;
  readonly stateRoot: Readonly<{
    readonly device: string;
    readonly inode: string;
  }>;
  readonly controlPlane: Readonly<{
    readonly device: string;
    readonly inode: string;
  }>;
}

function metadataOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function assertOwnedRegularFile(metadata: Stats): void {
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.nlink !== 1
  ) {
    throw new ControlPlaneLifetimeLockError(
      "invalid_path",
      "The control-plane lock must be one owned regular file.",
    );
  }
}

/**
 * Returns the lock identity for a canonical control-plane database path.
 * The file intentionally remains after release; authority belongs to the
 * kernel-held descriptor lock, never to file presence or process metadata.
 */
export function controlPlaneLifetimeLockPath(databasePath: string): string {
  if (!isAbsolute(databasePath)) {
    throw new ControlPlaneLifetimeLockError(
      "invalid_path",
      "The control-plane database path must be absolute.",
    );
  }
  const parent = dirname(databasePath);
  const parentMetadata = metadataOrNull(parent);
  if (
    parentMetadata === null ||
    parentMetadata.isSymbolicLink() ||
    !parentMetadata.isDirectory()
  ) {
    throw new ControlPlaneLifetimeLockError(
      "invalid_path",
      "The control-plane parent must be one real directory.",
    );
  }
  const databaseMetadata = metadataOrNull(databasePath);
  if (
    databaseMetadata !== null &&
    (databaseMetadata.isSymbolicLink() || !databaseMetadata.isFile())
  ) {
    throw new ControlPlaneLifetimeLockError(
      "invalid_path",
      "The control-plane database must be one regular file.",
    );
  }
  return join(realpathSync(parent), `.${basename(databasePath)}.lifetime.lock`);
}

function flockLibraryPath(): string {
  if (process.platform === "darwin") return "/usr/lib/libSystem.B.dylib";
  if (process.platform === "linux") return "libc.so.6";
  throw new ControlPlaneLifetimeLockError(
    "unsupported_platform",
    "This platform does not expose the required advisory file lock.",
  );
}

function tryAcquireDescriptorLock(descriptor: number): boolean {
  const library = dlopen(flockLibraryPath(), {
    flock: {
      args: [FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
  });
  try {
    return library.symbols.flock(descriptor, LOCK_EX | LOCK_NB) === 0;
  } finally {
    library.close();
  }
}

/**
 * Acquires one nonblocking advisory lock for the complete gateway lifetime.
 * Closing the descriptor, including process death, releases authority.
 */
export function acquireControlPlaneLifetimeLock(
  databasePath: string,
): ControlPlaneLifetimeLock {
  const path = controlPlaneLifetimeLockPath(databasePath);
  const stateRootPath = dirname(databasePath);
  const existing = metadataOrNull(path);
  if (existing !== null) assertOwnedRegularFile(existing);

  const closeOnExecValue: unknown = Reflect.get(constants, "O_CLOEXEC");
  const closeOnExec =
    typeof closeOnExecValue === "number" ? closeOnExecValue : 0;
  const directoryValue: unknown = Reflect.get(constants, "O_DIRECTORY");
  const directory =
    typeof directoryValue === "number" ? directoryValue : 0;
  let stateRootDescriptor: number | null = null;
  let descriptor: number | null = null;
  try {
    stateRootDescriptor = openSync(
      stateRootPath,
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        directory |
        closeOnExec,
    );
    const openedStateRoot = fstatSync(stateRootDescriptor, { bigint: true });
    const publishedStateRoot = lstatSync(stateRootPath, { bigint: true });
    const effectiveUserId = BigInt(process.geteuid?.() ?? -1);
    if (
      !openedStateRoot.isDirectory() ||
      openedStateRoot.isSymbolicLink() ||
      openedStateRoot.uid !== effectiveUserId ||
      (openedStateRoot.mode & 0o777n) !== 0o700n ||
      openedStateRoot.dev !== publishedStateRoot.dev ||
      openedStateRoot.ino !== publishedStateRoot.ino
    ) {
      throw new ControlPlaneLifetimeLockError(
        "invalid_path",
        "The control-plane state root must be one stable private directory.",
      );
    }
    descriptor = openSync(
      path,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        closeOnExec,
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    const opened = fstatSync(descriptor);
    assertOwnedRegularFile(opened);
    const published = lstatSync(path);
    assertOwnedRegularFile(published);
    if (opened.dev !== published.dev || opened.ino !== published.ino) {
      throw new ControlPlaneLifetimeLockError(
        "invalid_path",
        "The control-plane lock identity changed while opening it.",
      );
    }
    if (!tryAcquireDescriptorLock(descriptor)) {
      throw new ControlPlaneLifetimeLockError(
        "already_running",
        "Another HRA process owns the local control plane.",
      );
    }
  } catch (error: unknown) {
    if (descriptor !== null) closeSync(descriptor);
    if (stateRootDescriptor !== null) closeSync(stateRootDescriptor);
    if (error instanceof ControlPlaneLifetimeLockError) throw error;
    throw new ControlPlaneLifetimeLockError(
      "lock_failed",
      "The local control-plane lifetime lock could not be acquired.",
    );
  }

  let heldDescriptor: number | null = descriptor;
  let heldStateRootDescriptor: number | null = stateRootDescriptor;
  let heldControlPlaneDescriptor: number | null = null;
  let boundAuthority: ControlPlaneFileSystemAuthority | null = null;
  return {
    path,
    bindControlPlane() {
      if (heldStateRootDescriptor === null || heldDescriptor === null) {
        throw new ControlPlaneLifetimeLockError(
          "invalid_path",
          "The control-plane lifetime authority is no longer held.",
        );
      }
      if (boundAuthority !== null) return boundAuthority;
      let controlPlaneDescriptor: number | null = null;
      try {
        const openedStateRoot = fstatSync(
          heldStateRootDescriptor,
          { bigint: true },
        );
        const publishedStateRoot = lstatSync(
          stateRootPath,
          { bigint: true },
        );
        if (
          !openedStateRoot.isDirectory() ||
          openedStateRoot.dev !== publishedStateRoot.dev ||
          openedStateRoot.ino !== publishedStateRoot.ino
        ) {
          throw new ControlPlaneLifetimeLockError(
            "invalid_path",
            "The live control-plane state root identity changed.",
          );
        }
        controlPlaneDescriptor = openSync(
          databasePath,
          constants.O_RDONLY |
            constants.O_NOFOLLOW |
            closeOnExec,
        );
        const openedControlPlane = fstatSync(
          controlPlaneDescriptor,
          { bigint: true },
        );
        const publishedControlPlane = lstatSync(
          databasePath,
          { bigint: true },
        );
        const effectiveUserId = BigInt(process.geteuid?.() ?? -1);
        if (
          !openedControlPlane.isFile() ||
          openedControlPlane.isSymbolicLink() ||
          openedControlPlane.uid !== effectiveUserId ||
          openedControlPlane.nlink !== 1n ||
          (openedControlPlane.mode & 0o777n) !== 0o600n ||
          openedControlPlane.dev !== openedStateRoot.dev ||
          openedControlPlane.dev !== publishedControlPlane.dev ||
          openedControlPlane.ino !== publishedControlPlane.ino
        ) {
          throw new ControlPlaneLifetimeLockError(
            "invalid_path",
            "The live control-plane file identity is unsafe.",
          );
        }
        heldControlPlaneDescriptor = controlPlaneDescriptor;
        controlPlaneDescriptor = null;
        boundAuthority = {
          controlPlanePath: databasePath,
          stateRoot: {
            device: openedStateRoot.dev.toString(10),
            inode: openedStateRoot.ino.toString(10),
          },
          controlPlane: {
            device: openedControlPlane.dev.toString(10),
            inode: openedControlPlane.ino.toString(10),
          },
        };
        return boundAuthority;
      } catch (error: unknown) {
        if (error instanceof ControlPlaneLifetimeLockError) throw error;
        throw new ControlPlaneLifetimeLockError(
          "invalid_path",
          "The live control-plane file could not be bound.",
        );
      } finally {
        if (controlPlaneDescriptor !== null) {
          closeSync(controlPlaneDescriptor);
        }
      }
    },
    release() {
      if (heldDescriptor === null) return;
      const owned = heldDescriptor;
      heldDescriptor = null;
      if (heldControlPlaneDescriptor !== null) {
        closeSync(heldControlPlaneDescriptor);
        heldControlPlaneDescriptor = null;
      }
      if (heldStateRootDescriptor !== null) {
        closeSync(heldStateRootDescriptor);
        heldStateRootDescriptor = null;
      }
      closeSync(owned);
    },
  };
}
