import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, parse } from "node:path";

import {
  localObservationCapabilityFileName,
  localObservationCapabilitySchema,
  localObservationDirectoryName,
  localObservationSocketFileName,
} from "@hraness/hra-local-observation-protocol/wire";

export type LocalDesktopProfile = "production" | "development";

export interface FixedLocalObservationPaths {
  readonly profile: LocalDesktopProfile;
  readonly directory: string;
  readonly socket: string;
  readonly capability: string;
}

export interface DiscoveredLocalObservationEndpoint {
  readonly profile: LocalDesktopProfile;
  readonly socket: string;
  readonly capability: string;
}

const productionApplicationSupportDirectory = "OPRTE";
const developmentApplicationSupportDirectory = "HRA Source Development";

function expectedUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
    throw new Error("local_observation_unsupported");
  }
  return uid;
}

function exactPermissions(stat: Stats, permissions: number): boolean {
  return (stat.mode & 0o777) === permissions;
}

function ownerDirectory(stat: Stats, uid: number, exactMode: boolean): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid &&
    (exactMode ? exactPermissions(stat, 0o700) : (stat.mode & 0o022) === 0);
}

function verifyNoLinkDirectoryChain(
  canonicalHome: string,
  paths: FixedLocalObservationPaths,
  uid: number,
): boolean {
  const applicationRoot = join(
    canonicalHome,
    "Library",
    "Application Support",
    paths.profile === "production"
      ? productionApplicationSupportDirectory
      : developmentApplicationSupportDirectory,
  );
  const candidates = [
    join(canonicalHome, "Library"),
    join(canonicalHome, "Library", "Application Support"),
    applicationRoot,
    paths.directory,
  ];
  return candidates.every((candidate, index) => {
    try {
      return ownerDirectory(lstatSync(candidate), uid, index === candidates.length - 1);
    } catch {
      return false;
    }
  });
}

function fixedApplicationSupportRoot(
  canonicalHome: string,
  profile: LocalDesktopProfile,
): string {
  return join(
    canonicalHome,
    "Library",
    "Application Support",
    profile === "production"
      ? productionApplicationSupportDirectory
      : developmentApplicationSupportDirectory,
  );
}

export function fixedLocalObservationPaths(
  homeDirectory: string,
  profile: LocalDesktopProfile,
): FixedLocalObservationPaths {
  if (!isAbsolute(homeDirectory) || homeDirectory === parse(homeDirectory).root) {
    throw new Error("local_observation_unsupported");
  }
  const canonicalHome = realpathSync(homeDirectory);
  const root = fixedApplicationSupportRoot(canonicalHome, profile);
  const directory = join(root, localObservationDirectoryName);
  return Object.freeze({
    profile,
    directory,
    socket: join(directory, localObservationSocketFileName),
    capability: join(directory, localObservationCapabilityFileName),
  });
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readCapability(path: string, uid: number): string | null {
  let before: Stats;
  try {
    before = lstatSync(path);
  } catch {
    return null;
  }
  if (
    !before.isFile() || before.isSymbolicLink() || before.uid !== uid ||
    before.nlink !== 1 || !exactPermissions(before, 0o600) || before.size !== 43
  ) return null;

  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const after = fstatSync(descriptor);
    if (
      !sameIdentity(before, after) || !after.isFile() || after.uid !== uid ||
      after.nlink !== 1 || !exactPermissions(after, 0o600) || after.size !== 43
    ) return null;
    const value = readFileSync(descriptor, { encoding: "utf8" });
    return localObservationCapabilitySchema.safeParse(value).data ?? null;
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function verifySocket(path: string, uid: number): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isSocket() && !stat.isSymbolicLink() && stat.uid === uid &&
      stat.nlink === 1 && exactPermissions(stat, 0o600);
  } catch {
    return false;
  }
}

export function discoverFixedLocalObservationEndpoints(
  homeDirectory: string,
  options: Readonly<{ expectedUid?: number }> = {},
): readonly DiscoveredLocalObservationEndpoint[] {
  const uid = options.expectedUid ?? expectedUid();
  if (!Number.isSafeInteger(uid) || uid < 0) return [];
  let canonicalHome: string;
  try {
    canonicalHome = realpathSync(homeDirectory);
  } catch {
    return [];
  }
  const endpoints: DiscoveredLocalObservationEndpoint[] = [];
  for (const profile of ["production", "development"] as const) {
    let paths: FixedLocalObservationPaths;
    try {
      paths = fixedLocalObservationPaths(canonicalHome, profile);
    } catch {
      continue;
    }
    if (!verifyNoLinkDirectoryChain(canonicalHome, paths, uid)) continue;
    const capability = readCapability(paths.capability, uid);
    if (capability === null || !verifySocket(paths.socket, uid)) continue;
    endpoints.push(Object.freeze({
      profile,
      socket: paths.socket,
      capability,
    }));
  }
  return Object.freeze(endpoints);
}
