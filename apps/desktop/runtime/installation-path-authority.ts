import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
} from "node:fs";
import {
  lstat,
  readdir,
  realpath,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { dlopen, FFIType } from "bun:ffi";

const RENAME_SWAP = 0x00000002;
const RENAME_EXCL = 0x00000004;
const RENAME_NOFOLLOW_ANY = 0x00000010;
const closeOnExecValue: unknown = Reflect.get(constants, "O_CLOEXEC");
const closeOnExec = typeof closeOnExecValue === "number"
  ? closeOnExecValue
  : 0;
const noFollow = typeof constants.O_NOFOLLOW === "number"
  ? constants.O_NOFOLLOW
  : 0;
const directoryOnly = typeof constants.O_DIRECTORY === "number"
  ? constants.O_DIRECTORY
  : 0;

export type PathNodeIdentity = Readonly<{
  device: bigint;
  inode: bigint;
  path: string;
}>;

export type ProspectivePathAuthority = Readonly<{
  existing: readonly PathNodeIdentity[];
  missing: readonly string[];
  path: string;
}>;

export class InstallationPathAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallationPathAuthorityError";
  }
}

function normalizedAbsolute(value: string, label: string): string {
  if (
    !isAbsolute(value)
    || resolve(value) !== value
    || value === sep
    || value.includes("\u0000")
  ) {
    throw new InstallationPathAuthorityError(
      `${label} must be an absolute normalized non-root path.`,
    );
  }
  return value;
}

function filesystemFold(value: string): string {
  // APFS and HFS compare decomposed Unicode names. Rejecting the same folded
  // spelling on a case-sensitive volume is deliberately conservative: the
  // handoff has no valid reason to create two visually equivalent authorities.
  return value.normalize("NFD").toLocaleLowerCase("en-US");
}

async function assertNoFoldedEntry(
  parent: string,
  proposed: string,
  label: string,
): Promise<void> {
  const folded = filesystemFold(proposed);
  const entries = await readdir(parent, { encoding: "utf8" });
  const collision = entries.find(entry => filesystemFold(entry) === folded);
  if (collision !== undefined) {
    throw new InstallationPathAuthorityError(
      `${label} aliases existing entry ${collision}.`,
    );
  }
}

function prefixes(path: string): string[] {
  const parts = path.split(sep).filter(Boolean);
  const result: string[] = [];
  let cursor: string = sep;
  for (const part of parts) {
    cursor = cursor === sep ? `${sep}${part}` : `${cursor}${sep}${part}`;
    result.push(cursor);
  }
  return result;
}

export async function inspectProspectivePathAuthority(
  value: string,
  label: string,
): Promise<ProspectivePathAuthority> {
  const path = normalizedAbsolute(value, label);
  const components = prefixes(path);
  const existing: PathNodeIdentity[] = [];
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index]!;
    let status;
    try {
      status = await lstat(component, { bigint: true });
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
      const missing = components.slice(index).map(componentPath =>
        basename(componentPath)
      );
      const parent = index === 0 ? sep : components[index - 1]!;
      await assertNoFoldedEntry(parent, missing[0]!, label);
      return { existing, missing, path };
    }
    if (status.isSymbolicLink()) {
      throw new InstallationPathAuthorityError(
        `${label} contains symbolic-link component ${component}.`,
      );
    }
    if (index < components.length - 1 && !status.isDirectory()) {
      throw new InstallationPathAuthorityError(
        `${label} contains non-directory component ${component}.`,
      );
    }
    const canonical = await realpath(component);
    if (canonical !== component) {
      throw new InstallationPathAuthorityError(
        `${label} contains a case, Unicode, or canonical-path alias at ${component}.`,
      );
    }
    existing.push({
      device: status.dev,
      inode: status.ino,
      path: component,
    });
  }
  return { existing, missing: [], path };
}

export async function revalidatePathAuthority(
  authority: ProspectivePathAuthority,
  label: string,
): Promise<void> {
  for (const expected of authority.existing) {
    const status = await lstat(expected.path, { bigint: true });
    if (
      status.isSymbolicLink()
      || status.dev !== expected.device
      || status.ino !== expected.inode
      || await realpath(expected.path) !== expected.path
    ) {
      throw new InstallationPathAuthorityError(
        `${label} changed after validation at ${expected.path}.`,
      );
    }
  }
  if (authority.missing.length > 0) {
    const parent = authority.existing.at(-1)?.path ?? sep;
    await assertNoFoldedEntry(parent, authority.missing[0]!, label);
  }
}

export function authoritiesOverlap(
  left: ProspectivePathAuthority,
  right: ProspectivePathAuthority,
): boolean {
  const leftFolded = filesystemFold(left.path);
  const rightFolded = filesystemFold(right.path);
  const fromLeft = relative(leftFolded, rightFolded);
  const fromRight = relative(rightFolded, leftFolded);
  const contains = (value: string) =>
    value === ""
    || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
  return contains(fromLeft) || contains(fromRight);
}

function openVerifiedParent(
  authority: ProspectivePathAuthority,
  label: string,
): number {
  const parentPath = dirname(authority.path);
  const expected = authority.existing.find(node => node.path === parentPath);
  if (expected === undefined) {
    throw new InstallationPathAuthorityError(`${label} parent is not validated.`);
  }
  const descriptor = openSync(
    parentPath,
    constants.O_RDONLY | directoryOnly | noFollow | closeOnExec,
  );
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    const published = lstatSync(parentPath, { bigint: true });
    if (
      !opened.isDirectory()
      || opened.dev !== expected.device
      || opened.ino !== expected.inode
      || opened.dev !== published.dev
      || opened.ino !== published.ino
      || published.isSymbolicLink()
    ) {
      throw new InstallationPathAuthorityError(`${label} parent changed before rename.`);
    }
    return descriptor;
  } catch (error: unknown) {
    closeSync(descriptor);
    throw error;
  }
}

function requiredLeafIdentity(
  authority: ProspectivePathAuthority,
  label: string,
): PathNodeIdentity {
  const leaf = authority.existing.at(-1);
  if (
    authority.missing.length > 0
    || leaf === undefined
    || leaf.path !== authority.path
  ) {
    throw new InstallationPathAuthorityError(`${label} leaf is not validated.`);
  }
  return leaf;
}

function sameNode(
  expected: PathNodeIdentity,
  actual: PathNodeIdentity | null,
): boolean {
  return actual !== null
    && actual.device === expected.device
    && actual.inode === expected.inode;
}

/**
 * Rename two validated leaves relative to already-opened parent directories.
 * `exchange` uses Darwin's atomic RENAME_SWAP and never creates a gap where
 * neither bundle is canonical.
 */
export async function renameWithPathAuthority(
  source: ProspectivePathAuthority,
  destination: ProspectivePathAuthority,
  options: Readonly<{
    beforeRenameForTest?: () => Promise<void> | void;
    exchange?: boolean;
  }> = {},
): Promise<void> {
  await revalidatePathAuthority(source, "rename source");
  await revalidatePathAuthority(destination, "rename destination");
  const expectedSource = requiredLeafIdentity(source, "rename source");
  const expectedDestination = options.exchange
    ? requiredLeafIdentity(destination, "rename destination")
    : null;
  if (!options.exchange && destination.missing.length !== 1) {
    throw new InstallationPathAuthorityError(
      "Non-exchange destination must be one validated missing leaf.",
    );
  }
  const sourceParent = openVerifiedParent(source, "rename source");
  let destinationParent: number;
  try {
    destinationParent = openVerifiedParent(destination, "rename destination");
  } catch (error: unknown) {
    closeSync(sourceParent);
    throw error;
  }
  if (process.platform !== "darwin") {
    closeSync(sourceParent);
    closeSync(destinationParent);
    throw new InstallationPathAuthorityError(
      "Atomic descriptor-relative bundle rename is available only on macOS.",
    );
  }
  const library = dlopen("/usr/lib/libSystem.B.dylib", {
    renameatx_np: {
      args: [
        FFIType.i32,
        FFIType.cstring,
        FFIType.i32,
        FFIType.cstring,
        FFIType.u32,
      ],
      returns: FFIType.i32,
    },
    openat: {
      args: [FFIType.i32, FFIType.cstring, FFIType.i32],
      returns: FFIType.i32,
    },
  });
  const sourceName = Buffer.from(`${basename(source.path)}\u0000`);
  const destinationName = Buffer.from(`${basename(destination.path)}\u0000`);
  const inspectLeaf = (
    parent: number,
    name: Buffer,
    path: string,
  ): PathNodeIdentity | null => {
    const descriptor = library.symbols.openat(
      parent,
      name,
      constants.O_RDONLY | noFollow | closeOnExec,
    );
    if (descriptor < 0) return null;
    try {
      const status = fstatSync(descriptor, { bigint: true });
      return { device: status.dev, inode: status.ino, path };
    } finally {
      closeSync(descriptor);
    }
  };
  const renameLeaves = (
    fromParent: number,
    fromName: Buffer,
    toParent: number,
    toName: Buffer,
    flags: number,
  ) => library.symbols.renameatx_np(
    fromParent,
    fromName,
    toParent,
    toName,
    flags | RENAME_NOFOLLOW_ANY,
  );
  try {
    await options.beforeRenameForTest?.();
    const result = renameLeaves(
      sourceParent,
      sourceName,
      destinationParent,
      destinationName,
      options.exchange ? RENAME_SWAP : RENAME_EXCL,
    );
    if (result !== 0) {
      throw new InstallationPathAuthorityError("Descriptor-relative bundle rename failed.");
    }

    const sourceAfter = inspectLeaf(sourceParent, sourceName, source.path);
    const destinationAfter = inspectLeaf(
      destinationParent,
      destinationName,
      destination.path,
    );
    const postconditionHolds = sameNode(expectedSource, destinationAfter)
      && (options.exchange
        ? expectedDestination !== null && sameNode(expectedDestination, sourceAfter)
        : sourceAfter === null);
    if (postconditionHolds) return;

    // A regular-file or directory leaf can be exchanged between the last
    // metadata check and renameatx_np. Put the two observed leaves back under
    // their pre-syscall names when possible, then fail closed. The caller
    // still retains the independently verified predecessor until it has
    // inspected the installed candidate.
    let compensated = false;
    if (options.exchange && sourceAfter !== null && destinationAfter !== null) {
      if (renameLeaves(
        sourceParent,
        sourceName,
        destinationParent,
        destinationName,
        RENAME_SWAP,
      ) === 0) {
        compensated = sameNode(
          destinationAfter,
          inspectLeaf(sourceParent, sourceName, source.path),
        ) && sameNode(
          sourceAfter,
          inspectLeaf(destinationParent, destinationName, destination.path),
        );
      }
    } else if (!options.exchange && sourceAfter === null && destinationAfter !== null) {
      if (renameLeaves(
        destinationParent,
        destinationName,
        sourceParent,
        sourceName,
        RENAME_EXCL,
      ) === 0) {
        compensated = sameNode(
          destinationAfter,
          inspectLeaf(sourceParent, sourceName, source.path),
        ) && inspectLeaf(destinationParent, destinationName, destination.path) === null;
      }
    }
    throw new InstallationPathAuthorityError(
      compensated
        ? "Bundle rename leaf identity changed; the observed mutation was compensated."
        : "Bundle rename leaf identity changed and safe compensation could not be proven.",
    );
  } finally {
    library.close();
    closeSync(sourceParent);
    closeSync(destinationParent);
  }
}
