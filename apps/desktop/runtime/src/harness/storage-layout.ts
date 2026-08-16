import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  type BigIntStats,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "@hra-internal/schema";

const controlPlaneFileName = "control-plane.sqlite";
const privateDirectoryMode = 0o700;

const absoluteControlPlanePathSchema = z.string().min(1).superRefine(
  (value, context) => {
    if (
      !isAbsolute(value) ||
      resolve(value) !== value ||
      basename(value) !== controlPlaneFileName
    ) {
      context.addIssue({
        code: "custom",
        message: "control-plane path must be the canonical absolute OPRTE database path",
      });
    }
  },
);

export type HarnessStoragePathErrorCode =
  | "invalid_control_plane_path"
  | "unsafe_directory"
  | "unsafe_control_plane";

/** Path-free because this error may cross a redacted gateway diagnostic seam. */
export class HarnessStoragePathError extends Error {
  readonly code: HarnessStoragePathErrorCode;

  constructor(code: HarnessStoragePathErrorCode) {
    super({
      invalid_control_plane_path: "The harness control-plane path is invalid.",
      unsafe_directory: "The harness storage directory is unsafe.",
      unsafe_control_plane: "The harness control-plane file is unsafe.",
    }[code]);
    this.name = "HarnessStoragePathError";
    this.code = code;
  }
}

export interface HarnessStorageLayout {
  readonly applicationSupportRoot: string;
  readonly root: string;
  readonly objects: string;
  readonly heap: string;
  readonly contextValues: string;
  readonly lanesRoot: string;
  readonly scratch: string;
  readonly semanticEvidenceInbox: string;
}

export interface HarnessPreparedStorageLayout extends HarnessStorageLayout {
  readonly lanesRootIdentity: HarnessDirectoryIdentity;
  readonly semanticEvidenceInboxIdentity: HarnessDirectoryIdentity;
}

export interface HarnessDirectoryIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly owner: number;
  readonly path: string;
}

/**
 * Derive every harness path from the already-selected control-plane database.
 * No ambient HOME value or caller-selected alternate root participates.
 */
export function harnessStorageLayout(
  controlPlanePathValue: unknown,
): HarnessStorageLayout {
  const parsed = absoluteControlPlanePathSchema.safeParse(controlPlanePathValue);
  if (!parsed.success) {
    throw new HarnessStoragePathError("invalid_control_plane_path");
  }
  const applicationSupportRoot = dirname(parsed.data);
  const root = join(applicationSupportRoot, "harness", "v1");
  const scratch = join(root, "scratch");
  return Object.freeze({
    applicationSupportRoot,
    root,
    objects: join(root, "objects", "sha256"),
    heap: join(root, "heap", "sha256"),
    contextValues: join(root, "context-values", "sha256"),
    lanesRoot: join(root, "worktrees"),
    scratch,
    semanticEvidenceInbox: join(scratch, "semantic-evidence-v2"),
  });
}

/**
 * Create only fixed, direct children beneath the proven Application Support
 * root. Every component is re-opened without following links and bound to its
 * device/inode before it is returned.
 */
export function prepareHarnessStorageLayout(
  controlPlanePathValue: unknown,
): HarnessPreparedStorageLayout {
  const layout = harnessStorageLayout(controlPlanePathValue);
  assertApplicationSupportRoot(layout.applicationSupportRoot);
  assertControlPlaneFileIfPresent(
    join(layout.applicationSupportRoot, controlPlaneFileName),
    layout.applicationSupportRoot,
  );

  const harness = ensurePrivateDirectory(
    join(layout.applicationSupportRoot, "harness"),
    layout.applicationSupportRoot,
  );
  const version = ensurePrivateDirectory(layout.root, harness.path);
  const objects = ensurePrivateDirectory(join(layout.root, "objects"), version.path);
  ensurePrivateDirectory(layout.objects, objects.path);
  const heap = ensurePrivateDirectory(join(layout.root, "heap"), version.path);
  ensurePrivateDirectory(layout.heap, heap.path);
  const contextValues = ensurePrivateDirectory(
    join(layout.root, "context-values"),
    version.path,
  );
  ensurePrivateDirectory(layout.contextValues, contextValues.path);
  const scratch = ensurePrivateDirectory(layout.scratch, version.path);
  const semanticEvidenceInboxIdentity = ensurePrivateDirectory(
    layout.semanticEvidenceInbox,
    scratch.path,
  );
  const lanesRootIdentity = ensurePrivateDirectory(
    layout.lanesRoot,
    version.path,
  );
  assertHarnessDirectoryIdentity(lanesRootIdentity);

  return Object.freeze({
    ...layout,
    lanesRootIdentity,
    semanticEvidenceInboxIdentity,
  });
}

export function bindHarnessDirectory(
  pathValue: unknown,
): HarnessDirectoryIdentity {
  if (typeof pathValue !== "string" || !isAbsolute(pathValue)) {
    throw new HarnessStoragePathError("unsafe_directory");
  }
  const descriptor = openDirectoryNoFollow(pathValue);
  try {
    const metadata = fstatSync(descriptor, { bigint: true });
    assertPrivateDirectoryMetadata(metadata);
    const published = lstatSync(pathValue, { bigint: true });
    assertPrivateDirectoryMetadata(published);
    if (published.dev !== metadata.dev || published.ino !== metadata.ino) {
      throw new HarnessStoragePathError("unsafe_directory");
    }
    return Object.freeze({
      device: metadata.dev,
      inode: metadata.ino,
      owner: Number(metadata.uid),
      path: pathValue,
    });
  } catch (error: unknown) {
    if (error instanceof HarnessStoragePathError) throw error;
    throw new HarnessStoragePathError("unsafe_directory");
  } finally {
    closeSync(descriptor);
  }
}

export function assertHarnessDirectoryIdentity(
  identity: HarnessDirectoryIdentity,
): void {
  const current = bindHarnessDirectory(identity.path);
  if (
    current.device !== identity.device ||
    current.inode !== identity.inode ||
    current.owner !== identity.owner
  ) {
    throw new HarnessStoragePathError("unsafe_directory");
  }
}

function assertApplicationSupportRoot(path: string): void {
  let metadata: Stats;
  try {
    metadata = lstatSync(path);
  } catch {
    throw new HarnessStoragePathError("unsafe_directory");
  }
  assertPrivateDirectoryMetadata(metadata);
  bindHarnessDirectory(path);
}

function assertControlPlaneFileIfPresent(
  path: string,
  expectedParent: string,
): void {
  let metadata: Stats;
  try {
    metadata = lstatSync(path);
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) return;
    throw new HarnessStoragePathError("unsafe_control_plane");
  }
  const parent = lstatSync(expectedParent);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.dev !== parent.dev ||
    !ownedByEffectiveUser(metadata) ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new HarnessStoragePathError("unsafe_control_plane");
  }
}

function ensurePrivateDirectory(
  path: string,
  expectedParent: string,
): HarnessDirectoryIdentity {
  const parent = bindHarnessDirectory(expectedParent);
  let created = false;
  try {
    mkdirSync(path, { mode: privateDirectoryMode });
    created = true;
  } catch (error: unknown) {
    if (!hasCode(error, "EEXIST")) {
      throw new HarnessStoragePathError("unsafe_directory");
    }
  }
  assertHarnessDirectoryIdentity(parent);
  if (created) syncHarnessDirectory(parent);
  const directory = bindHarnessDirectory(path);
  if (directory.device !== parent.device) {
    throw new HarnessStoragePathError("unsafe_directory");
  }
  return directory;
}

function syncHarnessDirectory(directory: HarnessDirectoryIdentity): void {
  assertHarnessDirectoryIdentity(directory);
  const descriptor = openDirectoryNoFollow(directory.path);
  try {
    const metadata = fstatSync(descriptor, { bigint: true });
    if (metadata.dev !== directory.device || metadata.ino !== directory.inode) {
      throw new HarnessStoragePathError("unsafe_directory");
    }
    fsyncSync(descriptor);
  } catch (error: unknown) {
    if (error instanceof HarnessStoragePathError) throw error;
    throw new HarnessStoragePathError("unsafe_directory");
  } finally {
    closeSync(descriptor);
  }
}

function openDirectoryNoFollow(path: string): number {
  try {
    return openSync(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch {
    throw new HarnessStoragePathError("unsafe_directory");
  }
}

function assertPrivateDirectoryMetadata(metadata: Stats | BigIntStats): void {
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !ownedByEffectiveUser(metadata) ||
    (Number(metadata.mode) & 0o777) !== privateDirectoryMode
  ) {
    throw new HarnessStoragePathError("unsafe_directory");
  }
}

function ownedByEffectiveUser(
  metadata: Pick<Stats, "uid"> | Pick<BigIntStats, "uid">,
): boolean {
  const effectiveUser = process.geteuid?.();
  return effectiveUser === undefined || Number(metadata.uid) === effectiveUser;
}

function hasCode(error: unknown, expected: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === expected;
}
