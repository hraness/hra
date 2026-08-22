import { randomBytes as nodeRandomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, parse } from "node:path";

import {
  localObservationCapabilityFileName,
  localObservationCapabilitySchema,
  localObservationDirectoryName,
  localObservationSocketFileName,
} from "@hraness/hra-local-observation-protocol/wire";

export type LocalObservationServerProfile =
  | "production"
  | "development"
  | "automation"
  | "recovery";

export interface LocalObservationEndpointPaths {
  readonly directory: string;
  readonly socket: string;
  readonly capability: string;
}

export interface PreparedLocalObservationEndpoint {
  readonly paths: LocalObservationEndpointPaths;
  readonly capabilityBytes: Buffer;
  markSocketReady(): void;
  cleanup(): void;
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
    throw new Error("Local observation requires POSIX ownership.");
  }
  return uid;
}

function mode(stat: Stats): number {
  return stat.mode & 0o777;
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function localObservationEndpointPaths(
  endpointRoot: string,
): LocalObservationEndpointPaths {
  if (!isAbsolute(endpointRoot) || endpointRoot === parse(endpointRoot).root) {
    throw new TypeError("Local observation endpoint root must be an absolute app directory.");
  }
  const directory = join(realpathSync(endpointRoot), localObservationDirectoryName);
  return Object.freeze({
    directory,
    socket: join(directory, localObservationSocketFileName),
    capability: join(directory, localObservationCapabilityFileName),
  });
}

function verifyEndpointRoot(endpointRoot: string, uid: number): void {
  const stat = lstatSync(endpointRoot);
  if (
    !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid ||
    (stat.mode & 0o022) !== 0
  ) throw new Error("Local observation endpoint root is not owner-private.");
}

function removeOwnedStaleFile(
  path: string,
  uid: number,
  expected: "file" | "socket",
): void {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const expectedType = expected === "file" ? stat.isFile() : stat.isSocket();
  if (
    !expectedType || stat.isSymbolicLink() || stat.uid !== uid || stat.nlink !== 1
  ) throw new Error("Local observation retained unsafe endpoint material.");
  unlinkSync(path);
}

function removeSameIdentity(path: string, expected: Stats | null): void {
  if (expected === null) return;
  try {
    const current = lstatSync(path);
    if (sameIdentity(current, expected)) unlinkSync(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function prepareLocalObservationEndpoint(options: Readonly<{
  endpointRoot: string;
  randomBytes?: (size: number) => Uint8Array;
}>): PreparedLocalObservationEndpoint {
  const uid = currentUid();
  verifyEndpointRoot(options.endpointRoot, uid);
  const paths = localObservationEndpointPaths(options.endpointRoot);
  try {
    mkdirSync(paths.directory, { mode: 0o700 });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const directoryIdentity = lstatSync(paths.directory);
  if (
    !directoryIdentity.isDirectory() || directoryIdentity.isSymbolicLink() ||
    directoryIdentity.uid !== uid || mode(directoryIdentity) !== 0o700
  ) throw new Error("Local observation directory is not owner-private.");

  removeOwnedStaleFile(paths.socket, uid, "socket");
  removeOwnedStaleFile(paths.capability, uid, "file");

  const bytes = Buffer.from((options.randomBytes ?? nodeRandomBytes)(32));
  if (bytes.byteLength !== 32) {
    throw new Error("Local observation capability source returned the wrong size.");
  }
  const capability = bytes.toString("base64url");
  localObservationCapabilitySchema.parse(capability);
  let capabilityDescriptor: number | null = null;
  let capabilityIdentity: Stats | null = null;
  let socketIdentity: Stats | null = null;
  try {
    capabilityDescriptor = openSync(
      paths.capability,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fchmodSync(capabilityDescriptor, 0o600);
    const written = writeSync(capabilityDescriptor, capability, null, "utf8");
    if (written !== 43) throw new Error("Local observation capability write was incomplete.");
    fsyncSync(capabilityDescriptor);
    capabilityIdentity = fstatSync(capabilityDescriptor);
  } finally {
    if (capabilityDescriptor !== null) closeSync(capabilityDescriptor);
  }

  let cleaned = false;
  return Object.freeze({
    paths,
    capabilityBytes: bytes,
    markSocketReady: () => {
      chmodSync(paths.socket, 0o600);
      const ready = lstatSync(paths.socket);
      if (
        !ready.isSocket() || ready.isSymbolicLink() || ready.uid !== uid ||
        ready.nlink !== 1 || mode(ready) !== 0o600
      ) throw new Error("Local observation socket is not owner-private.");
      socketIdentity = ready;
    },
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      removeSameIdentity(paths.socket, socketIdentity);
      removeSameIdentity(paths.capability, capabilityIdentity);
      try {
        const currentDirectory = lstatSync(paths.directory);
        if (sameIdentity(currentDirectory, directoryIdentity)) rmdirSync(paths.directory);
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
      }
      bytes.fill(0);
    },
  });
}
