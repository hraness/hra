import assert from "node:assert/strict";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import {
  lstat, mkdir, mkdtemp, open, opendir, readFile, readdir, realpath, rename, writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquireAppPublicationLock,
  APP_PROCESS_CUSTODY_FILE,
  AppProcessCustodyError,
  appSha256,
  beginAppProcessCustody,
  createAppSourceMarkerEvidence,
  parseAppPublication,
  parseAppSourceMarkerEvidence,
  readAppInventory,
  readAppOrdinary,
  snapshotAppSourceEnvironment,
  stageAppBuild,
  type AppArtifact,
  type AppPublicationLock,
  type AppProcessCustody,
  type AppSourceEnvironmentSnapshot,
  type AppSourceMarkerEvidence,
} from "./build-app.ts";
import { APP_SOURCE_MARKER_PATH } from "./app-source-marker.ts";

export const OOMPA_DEV_HOST = "127.0.0.1";
export const OOMPA_DEV_PORT = 5183;
export const OOMPA_DEV_PREFIX = "/_hra_dev";

const MAX_INPUT_FILES = 4096;
const MAX_INPUT_DIRECTORIES = 512;
const MAX_INPUT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_INPUT_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 1024;
const DEV_BUILD_DEADLINE_MS = 120_000;
const DEV_CHILD_GRACE_MS = 2_000;
const DEV_POLL_MS = 350;
const DEV_RECEIPT_SCHEMA_VERSION = 2;

export const OOMPA_DEV_CACHE_LIMITS = Object.freeze({
  bytes: 2 * 1024 * 1024 * 1024,
  directories: 4096,
  files: 32_768,
  // One run retains both the compiler-complete tree and its projected public
  // tree until publication moves the latter into revisions. Include bounded
  // graph receipts and directory overhead rather than budgeting one copy.
  reserveBytes: 640 * 1024 * 1024,
  reserveDirectories: 512,
  reserveFiles: 9000,
  revisions: 32,
  runs: 64,
});

export type DevInputArtifact = Readonly<{
  bytes: number;
  identitySha256: string;
  path: string;
  sha256: string;
}>;

export type DevInputSnapshot = Readonly<{
  dependencies: readonly DevInputArtifact[];
  dependencyEpoch: string;
  sourceMarker: AppSourceMarkerEvidence;
  sourceEpoch: string;
  sources: readonly DevInputArtifact[];
}>;

export type DevObservedInput = Readonly<{
  absolutePath: string;
  bytes?: number;
  logicalPath: string;
  sha256?: string;
}>;

export type DevInputRoot = Readonly<{
  absolutePath: string;
  logicalPrefix: string;
}>;

export type DevInputSpec = Readonly<{
  dependencyFiles: readonly DevObservedInput[];
  sourceEnvironment: () => AppSourceEnvironmentSnapshot;
  sourceFiles: readonly DevObservedInput[];
  sourceRoots: readonly DevInputRoot[];
}>;

export type DevBuildCandidate = Readonly<{
  artifacts: readonly AppArtifact[];
  dependencyEpoch: string;
  publicDirectory: string;
  revision: string;
  run: string;
  sourceMarker: AppSourceMarkerEvidence;
  sourceEpoch: string;
}>;

export type DevPublishedRevision = Readonly<{
  artifacts: readonly AppArtifact[];
  directory: string;
  revision: string;
  sourceMarker: AppSourceMarkerEvidence;
}>;

export type DevPhase =
  | "building"
  | "capacity-blocked"
  | "degraded"
  | "ready"
  | "restart-required"
  | "starting"
  | "stopped";

export type DevStatus = Readonly<{
  diagnostic: string | null;
  latest: string | null;
  phase: DevPhase;
}>;

type DevBuildReceipt = Readonly<{
  artifacts: readonly AppArtifact[];
  dependencyEpoch: string;
  kind: "hra-app-dev-publication";
  revision: string;
  run: string;
  schemaVersion: 2;
  sequence: number;
  sourceMarker: AppSourceMarkerEvidence;
  sourceEpoch: string;
}>;

type DevBuildResult = Readonly<{
  artifacts: readonly AppArtifact[];
  dependencyEpoch: string;
  kind: "hra-app-dev-build-result";
  revision: string;
  run: string;
  schemaVersion: 2;
  sourceMarker: AppSourceMarkerEvidence;
  sourceEpoch: string;
}>;

export type DevCacheCensus = Readonly<{
  bytes: number;
  directories: number;
  files: number;
  revisions: number;
  runs: number;
}>;

export type DevCache = {
  latest?: DevPublishedRevision;
  nextSequence: number;
  receiptsDirectory: string;
  revisions: Map<string, DevPublishedRevision>;
  revisionsDirectory: string;
  root: string;
  runsDirectory: string;
};

export class DevCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevCapacityError";
  }
}

export class DevStaleBuildError extends Error {
  constructor() {
    super("The development build inputs changed before publication");
    this.name = "DevStaleBuildError";
  }
}

export class DevDependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevDependencyError";
  }
}

export class DevTransientBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevTransientBuildError";
  }
}

type DevCollectionPhase =
  | "initial-probe" | "term-preprobe" | "term-syscall" | "post-term-probe" | "post-term-wait"
  | "pre-kill-probe" | "kill-preprobe" | "kill-syscall" | "post-kill-probe" | "post-kill-wait"
  | "final-probe" | "final-absence" | "direct-child-handle";

export type DevCollectionDiagnostic = Readonly<{
  attempt: number;
  elapsedCapped: boolean;
  elapsedMilliseconds: number;
  killSent: boolean;
  phase: DevCollectionPhase;
  termSent: boolean;
}>;

/** No caller may release either publication owner after this uncertainty. */
export class DevUncollectedProcessError extends AppProcessCustodyError {
  readonly collection: DevCollectionDiagnostic | undefined;

  constructor(message: string, options?: ErrorOptions & { collection?: DevCollectionDiagnostic }) {
    super(message, options);
    this.collection = options?.collection === undefined ? undefined : Object.freeze({ ...options.collection });
  }
}

/** Both build and server shutdown use this same sticky custody fence. */
export function releaseCollectedDevOwner(lock: AppPublicationLock, collectionUnproved: boolean): void {
  if (!collectionUnproved) lock.release();
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), "Expected an object");
  assert.ok(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), "Unexpected development record fields");
}

function digest(value: unknown, description = "SHA-256"): string {
  assert.ok(typeof value === "string" && /^[a-f0-9]{64}$/u.test(value), `Invalid ${description}`);
  return value;
}

function logicalPath(value: string, description: string): string {
  assert.ok(value.length > 0 && value.length <= 512, `${description} is not bounded`);
  const parts = value.split("/");
  assert.ok(parts.length <= 16, `${description} is too deep`);
  assert.ok(
    parts.every((part) => part.length > 0
      && part !== "."
      && part !== ".."
      && /^[A-Za-z0-9@_.+-]+$/u.test(part)),
    `${description} is unsafe`,
  );
  return value;
}

function safeRun(value: unknown): string {
  assert.ok(typeof value === "string" && /^build-[A-Za-z0-9_-]+$/u.test(value), "Unsafe development run name");
  return value;
}

function safeRevision(value: unknown): string {
  return digest(value, "development revision");
}

function safeSequence(value: unknown): number {
  assert.ok(
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 999_999_999_999,
    "Invalid development publication sequence",
  );
  return value;
}

function sameObjectIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size;
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return sameObjectIdentity(left, right)
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function inputIdentity(metadata: Stats): string {
  return appSha256(JSON.stringify([
    metadata.dev,
    metadata.ino,
    metadata.uid,
    metadata.mode,
    metadata.nlink,
    metadata.size,
    metadata.mtimeMs,
    metadata.ctimeMs,
  ]));
}

function assertOwnedEntry(metadata: Stats, directoryEntry: boolean): void {
  assert.ok(directoryEntry ? metadata.isDirectory() : metadata.isFile(), "Development boundary must be ordinary");
  assert.ok(!metadata.isSymbolicLink(), "Development boundary must not be a symlink");
  assert.equal(metadata.uid, process.getuid?.(), "Development boundary must belong to the current user");
  assert.equal(metadata.mode & 0o0022, 0, "Development boundary must not be group/world writable");
  if (!directoryEntry) {
    assert.equal(metadata.nlink, 1, "Development files must not be hardlinked");
    assert.equal(metadata.mode & 0o111, 0, "Development files must not be executable");
  }
}

async function assertOwnedDirectory(path: string): Promise<Stats> {
  const before = await lstat(path);
  assertOwnedEntry(before, true);
  assert.equal(await realpath(path), path, "Development directory ancestry must not be symlinked");
  const after = await lstat(path);
  assertOwnedEntry(after, true);
  assert.ok(sameIdentity(before, after), "Development directory changed during inspection");
  return after;
}

async function makeOwnedDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  await assertOwnedDirectory(path);
}

async function pathAbsent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}

async function syncEntry(path: string, directoryEntry: boolean): Promise<Stats> {
  const before = await lstat(path);
  assertOwnedEntry(before, directoryEntry);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    assertOwnedEntry(opened, directoryEntry);
    assert.ok(sameIdentity(before, opened), "Development entry changed before sync");
    await handle.sync();
    const after = await lstat(path);
    assertOwnedEntry(after, directoryEntry);
    assert.ok(sameIdentity(opened, after), "Development entry changed during sync");
    return after;
  } finally {
    await handle.close();
  }
}

async function readStableInput(input: DevObservedInput): Promise<Readonly<{
  artifact: DevInputArtifact;
  bytes: Buffer;
}>> {
  const before = await lstat(input.absolutePath);
  assertOwnedEntry(before, false);
  assert.equal(await realpath(input.absolutePath), input.absolutePath, `Development input ancestry must not be symlinked: ${input.logicalPath}`);
  assert.ok(before.size <= MAX_INPUT_FILE_BYTES, `Development input is too large: ${input.logicalPath}`);
  const handle = await open(input.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    assertOwnedEntry(opened, false);
    assert.ok(sameIdentity(before, opened), `Development input changed before read: ${input.logicalPath}`);
    const bytes = await handle.readFile();
    const after = await lstat(input.absolutePath);
    assertOwnedEntry(after, false);
    assert.ok(sameIdentity(opened, after), `Development input changed during read: ${input.logicalPath}`);
    const artifact = {
      bytes: bytes.byteLength,
      identitySha256: inputIdentity(opened),
      path: logicalPath(input.logicalPath, "Development input path"),
      sha256: appSha256(bytes),
    };
    if (input.bytes !== undefined || input.sha256 !== undefined) {
      if (input.bytes === undefined || input.sha256 === undefined) {
        throw new DevDependencyError(`Dependency descriptor is incomplete: ${input.logicalPath}`);
      }
      if (artifact.bytes !== input.bytes || artifact.sha256 !== input.sha256) {
        throw new DevDependencyError(`Dependency artifact changed; restart after restoring the install: ${input.logicalPath}`);
      }
    }
    return { artifact, bytes };
  } finally {
    await handle.close();
  }
}

async function collectInputRoot(
  root: DevInputRoot,
  budget: { directories: number; files: number },
): Promise<Readonly<{
  directories: readonly string[];
  files: readonly DevObservedInput[];
}>> {
  const found: DevObservedInput[] = [];
  const directoryIdentities: string[] = [];
  async function walk(absolute: string, logical: string, depth: number): Promise<void> {
    budget.directories += 1;
    assert.ok(budget.directories <= MAX_INPUT_DIRECTORIES && depth <= 16, "Development source census exceeded its directory bound");
    const metadata = await assertOwnedDirectory(absolute);
    directoryIdentities.push(`${logical}:${inputIdentity(metadata)}`);
    const stream = await opendir(absolute);
    const entries: string[] = [];
    for await (const entry of stream) {
      assert.ok(
        entries.length < MAX_INPUT_FILES + MAX_INPUT_DIRECTORIES - budget.files - budget.directories,
        "Development source census exceeded its entry bound",
      );
      entries.push(entry.name);
    }
    entries.sort();
    for (const name of entries) {
      const child = join(absolute, name);
      const childLogical = logicalPath(`${logical}/${name}`, "Development source path");
      const metadata = await lstat(child);
      if (metadata.isDirectory()) await walk(child, childLogical, depth + 1);
      else {
        assertOwnedEntry(metadata, false);
        budget.files += 1;
        assert.ok(budget.files <= MAX_INPUT_FILES, "Development source census exceeded its file bound");
        found.push({ absolutePath: child, logicalPath: childLogical });
      }
    }
  }
  await walk(resolve(root.absolutePath), logicalPath(root.logicalPrefix, "Development source root"), 0);
  return { directories: directoryIdentities, files: found };
}

function inputEpoch(artifacts: readonly DevInputArtifact[]): string {
  return appSha256(JSON.stringify(artifacts));
}

/** Hash a complete, bounded source and dependency closure without following links. */
export async function snapshotDevInputs(spec: DevInputSpec): Promise<DevInputSnapshot> {
  const seen = new Set<string>();
  async function snapshot(inputs: readonly DevObservedInput[]): Promise<Readonly<{
    artifacts: readonly DevInputArtifact[];
    contents: ReadonlyMap<string, Buffer>;
  }>> {
    let totalBytes = 0;
    const output: DevInputArtifact[] = [];
    const contents = new Map<string, Buffer>();
    assert.ok(inputs.length > 0 && inputs.length <= MAX_INPUT_FILES, "Development input census is empty or too large");
    for (const input of [...inputs].sort((left, right) => left.logicalPath.localeCompare(right.logicalPath))) {
      assert.equal(seen.has(input.logicalPath), false, `Duplicate development input: ${input.logicalPath}`);
      seen.add(input.logicalPath);
      const { artifact, bytes } = await readStableInput(input);
      totalBytes += artifact.bytes;
      assert.ok(totalBytes <= MAX_INPUT_TOTAL_BYTES, "Development input census exceeded its byte bound");
      output.push(artifact);
      contents.set(artifact.path, bytes);
    }
    return { artifacts: output, contents };
  }
  let dependencySnapshot: Awaited<ReturnType<typeof snapshot>>;
  try {
    dependencySnapshot = await snapshot(spec.dependencyFiles);
  } catch (error) {
    if (error instanceof DevDependencyError) throw error;
    throw new DevDependencyError("The installed development dependency closure is unavailable");
  }
  const dependencies = dependencySnapshot.artifacts;
  const packageBytes = dependencySnapshot.contents.get("repository/package.json");
  assert.ok(packageBytes !== undefined, "The development closure must bind the root package manifest");
  const sourceMarker = createAppSourceMarkerEvidence(packageBytes, spec.sourceEnvironment());
  assert.ok(spec.sourceFiles.length <= MAX_INPUT_FILES, "Development source census exceeded its file bound");
  const sourceBudget = { directories: 0, files: spec.sourceFiles.length };
  const collectedRoots: Awaited<ReturnType<typeof collectInputRoot>>[] = [];
  for (const root of spec.sourceRoots) collectedRoots.push(await collectInputRoot(root, sourceBudget));
  const sourceInputs = [
    ...spec.sourceFiles,
    ...collectedRoots.flatMap(({ files }) => files),
  ];
  const sourceSnapshot = await snapshot(sourceInputs);
  const sources = sourceSnapshot.artifacts;
  return {
    dependencies,
    dependencyEpoch: inputEpoch(dependencies),
    sourceMarker,
    sourceEpoch: appSha256(JSON.stringify({
      directories: collectedRoots.flatMap(({ directories }) => directories),
      files: sources,
      sourceMarker,
    })),
    sources,
  };
}

function manifestArtifact(value: unknown): Readonly<{ bytes: number; path: string; sha256: string }> {
  const item = record(value);
  assert.ok(typeof item.bytes === "number" && Number.isSafeInteger(item.bytes) && item.bytes > 0);
  assert.ok(typeof item.path === "string");
  return {
    bytes: item.bytes,
    path: logicalPath(item.path, "StyleX package artifact"),
    sha256: digest(item.sha256),
  };
}

async function findUiPackageRoot(manifestPath: string): Promise<string> {
  let cursor = dirname(manifestPath);
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(cursor, "package.json");
    if (!await pathAbsent(candidate)) {
      const parsed: unknown = JSON.parse((await readStableInput({
        absolutePath: candidate,
        logicalPath: "dependency/@hraness/ui/package.json",
      })).bytes.toString("utf8"));
      const packageRecord = record(parsed);
      if (packageRecord.name === "@hraness/ui") return cursor;
    }
    const parent = dirname(cursor);
    assert.notEqual(parent, cursor, "Could not locate the @hraness/ui package root");
    cursor = parent;
  }
  throw new DevDependencyError("Could not locate the installed @hraness/ui package root");
}

async function uiDependencyInputs(manifestPath: string): Promise<readonly DevObservedInput[]> {
  const physicalManifest = await realpath(manifestPath);
  const root = await findUiPackageRoot(physicalManifest);
  const manifestRead = await readStableInput({
    absolutePath: physicalManifest,
    logicalPath: "dependency/@hraness/ui/stylex-manifest.json",
  });
  const manifest = record(JSON.parse(manifestRead.bytes.toString("utf8")) as unknown);
  assert.equal(manifest.kind, "hraness-stylex-package-manifest");
  const packageIdentity = record(manifest.package);
  assert.equal(packageIdentity.name, "@hraness/ui");
  assert.ok(typeof packageIdentity.version === "string" && /^\d+\.\d+\.\d+$/u.test(packageIdentity.version));
  const descriptors: ReturnType<typeof manifestArtifact>[] = [];
  for (const key of ["buildTools", "runtime", "stylesheets"] as const) {
    const collection = manifest[key];
    assert.ok(Array.isArray(collection), `StyleX manifest ${key} must be an array`);
    assert.ok(
      collection.length <= MAX_INPUT_FILES - 2 - descriptors.length,
      "StyleX manifest artifact inventory is too large",
    );
    for (const value of collection) descriptors.push(manifestArtifact(value));
  }
  assert.ok(descriptors.length < MAX_INPUT_FILES - 2, "StyleX manifest artifact inventory is too large");
  descriptors.push(manifestArtifact(manifest.standaloneCss));
  assert.ok(typeof manifest.compilerFoundation === "string");
  assert.ok(
    descriptors.some(({ path }) => path === manifest.compilerFoundation),
    "StyleX compiler foundation is not bound by its stylesheet inventory",
  );
  const byPath = new Map<string, ReturnType<typeof manifestArtifact>>();
  for (const descriptor of descriptors) {
    const prior = byPath.get(descriptor.path);
    if (prior !== undefined) assert.deepEqual(descriptor, prior, `StyleX manifest artifact disagrees: ${descriptor.path}`);
    else byPath.set(descriptor.path, descriptor);
  }
  const inputs: DevObservedInput[] = [
    {
      absolutePath: physicalManifest,
      logicalPath: "dependency/@hraness/ui/stylex-manifest.json",
    },
    {
      absolutePath: join(root, "package.json"),
      logicalPath: "dependency/@hraness/ui/package.json",
    },
  ];
  for (const descriptor of [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path))) {
    const absolute = resolve(root, ...descriptor.path.split("/"));
    const logical = relative(root, absolute).split(sep).join("/");
    if (logical !== descriptor.path || logical.startsWith("../")) {
      throw new DevDependencyError(`StyleX package artifact escaped its package root: ${descriptor.path}`);
    }
    inputs.push({
      absolutePath: absolute,
      bytes: descriptor.bytes,
      logicalPath: `dependency/@hraness/ui/${descriptor.path}`,
      sha256: descriptor.sha256,
    });
  }
  return inputs;
}

/** Resolve the exact source/config/shared-package closure used by a dev child. */
export async function defaultDevInputSpec(rootDirectory: string): Promise<DevInputSpec> {
  const root = resolve(rootDirectory);
  const manifestUrl = import.meta.resolve("@hraness/ui/stylex-manifest.json");
  assert.ok(manifestUrl.startsWith("file:"), "The StyleX manifest must resolve to a local file");
  const dependencyFiles: DevObservedInput[] = ([
    ["package.json", "repository/package.json"],
    ["bun.lock", "repository/bun.lock"],
    ["tsconfig.json", "repository/tsconfig.json"],
    ["app/vercel.json", "repository/app/vercel.json"],
    ["scripts/app-source-marker.ts", "repository/scripts/app-source-marker.ts"],
    ["scripts/build-app.ts", "repository/scripts/build-app.ts"],
    ["scripts/dev-app.ts", "repository/scripts/dev-app.ts"],
    ["src/install-normalizer.ts", "repository/src/install-normalizer.ts"],
  ] as const).map(([path, logical]) => ({ absolutePath: join(root, ...path.split("/")), logicalPath: logical }));
  dependencyFiles.push(...await uiDependencyInputs(fileURLToPath(manifestUrl)));
  return {
    dependencyFiles,
    sourceEnvironment: () => snapshotAppSourceEnvironment(process.env),
    sourceFiles: [
      { absolutePath: join(root, "app", "index.html"), logicalPath: "source/app/index.html" },
      { absolutePath: join(root, "app", "vite.config.ts"), logicalPath: "source/app/vite.config.ts" },
    ],
    sourceRoots: [
      { absolutePath: join(root, "app", "src"), logicalPrefix: "source/app/src" },
      { absolutePath: join(root, "src", "cloud"), logicalPrefix: "source/src/cloud" },
      { absolutePath: join(root, "src", "domain"), logicalPrefix: "source/src/domain" },
    ],
  };
}

function parsePublicArtifacts(
  value: unknown,
  sourceMarkerValue: unknown,
): readonly AppArtifact[] {
  const sourceMarker = parseAppSourceMarkerEvidence(sourceMarkerValue);
  return parseAppPublication({
    artifacts: value,
    completeSha256: "a".repeat(64),
    kind: "hra-app-publication",
    schemaVersion: 2,
    shellSha256: "b".repeat(64),
    sourceMarker,
  });
}

export function appDevRevision(value: unknown, sourceMarkerValue: unknown): string {
  const sourceMarker = parseAppSourceMarkerEvidence(sourceMarkerValue);
  const artifacts = parseAppPublication({
    artifacts: value,
    completeSha256: "a".repeat(64),
    kind: "hra-app-publication",
    schemaVersion: 2,
    shellSha256: "b".repeat(64),
    sourceMarker,
  });
  return appSha256(JSON.stringify({ artifacts, sourceMarker }));
}

function parseDevBuildResult(value: unknown): DevBuildResult {
  const item = record(value);
  exactKeys(item, ["artifacts", "dependencyEpoch", "kind", "revision", "run", "schemaVersion", "sourceEpoch", "sourceMarker"]);
  assert.equal(item.kind, "hra-app-dev-build-result");
  assert.equal(item.schemaVersion, DEV_RECEIPT_SCHEMA_VERSION);
  const sourceMarker = parseAppSourceMarkerEvidence(item.sourceMarker);
  const artifacts = parsePublicArtifacts(item.artifacts, sourceMarker);
  const revision = safeRevision(item.revision);
  assert.equal(revision, appDevRevision(artifacts, sourceMarker), "Development build result revision changed");
  return {
    artifacts,
    dependencyEpoch: digest(item.dependencyEpoch, "dependency epoch"),
    kind: "hra-app-dev-build-result",
    revision,
    run: safeRun(item.run),
    schemaVersion: 2,
    sourceMarker,
    sourceEpoch: digest(item.sourceEpoch, "source epoch"),
  };
}

function parseDevBuildReceipt(value: unknown): DevBuildReceipt {
  const item = record(value);
  exactKeys(item, ["artifacts", "dependencyEpoch", "kind", "revision", "run", "schemaVersion", "sequence", "sourceEpoch", "sourceMarker"]);
  assert.equal(item.kind, "hra-app-dev-publication");
  assert.equal(item.schemaVersion, DEV_RECEIPT_SCHEMA_VERSION);
  const sourceMarker = parseAppSourceMarkerEvidence(item.sourceMarker);
  const artifacts = parsePublicArtifacts(item.artifacts, sourceMarker);
  const revision = safeRevision(item.revision);
  assert.equal(revision, appDevRevision(artifacts, sourceMarker), "Development publication revision changed");
  return {
    artifacts,
    dependencyEpoch: digest(item.dependencyEpoch, "dependency epoch"),
    kind: "hra-app-dev-publication",
    revision,
    run: safeRun(item.run),
    schemaVersion: 2,
    sequence: safeSequence(item.sequence),
    sourceMarker,
    sourceEpoch: digest(item.sourceEpoch, "source epoch"),
  };
}

function developmentRecord(value: DevBuildResult | DevBuildReceipt): string {
  return `${JSON.stringify(value)}\n`;
}

async function writePrivateRecord(path: string, value: DevBuildResult | DevBuildReceipt): Promise<void> {
  await writeFile(path, developmentRecord(value), { flag: "wx", mode: 0o600 });
  const metadata = await syncEntry(path, false);
  assert.equal(metadata.mode & 0o777, 0o600, "Development evidence must stay private");
}

async function readPrivateRecord(path: string): Promise<Buffer> {
  const metadata = await lstat(path);
  assertOwnedEntry(metadata, false);
  assert.equal(metadata.mode & 0o777, 0o600, "Development evidence must stay private");
  return readAppOrdinary(path);
}

function genericName(name: string): void {
  assert.ok(name.length > 0 && name.length <= 240, "Development cache entry name is not bounded");
  assert.ok(!name.includes("/") && !name.includes("\\") && name.split("").every((character) => {
    const code = character.charCodeAt(0);
    return code > 31 && code !== 127;
  }), "Unsafe development cache entry name");
  assert.ok(name !== "." && name !== "..", "Unsafe development cache entry name");
}

/** Inspect retained cache without pruning anything that a loaded page may use. */
export async function inspectDevCache(root: string): Promise<DevCacheCensus> {
  let bytes = 0;
  let directories = 0;
  let files = 0;
  async function walk(path: string, depth: number): Promise<void> {
    assert.ok(++directories <= OOMPA_DEV_CACHE_LIMITS.directories && depth <= 20, "Development cache directory bound exceeded");
    await assertOwnedDirectory(path);
    const stream = await opendir(path);
    for await (const entry of stream) {
      genericName(entry.name);
      const child = join(path, entry.name);
      const metadata = await lstat(child);
      if (metadata.isDirectory()) await walk(child, depth + 1);
      else {
        assertOwnedEntry(metadata, false);
        files += 1;
        assert.ok(files <= OOMPA_DEV_CACHE_LIMITS.files, "Development cache file bound exceeded");
        assert.ok(metadata.size <= MAX_INPUT_FILE_BYTES, "Development cache file bound exceeded");
        bytes += metadata.size;
        assert.ok(bytes <= OOMPA_DEV_CACHE_LIMITS.bytes, "Development cache byte bound exceeded");
      }
    }
  }
  await walk(root, 0);
  const runNames = await readdir(join(root, "runs"));
  const revisionNames = await readdir(join(root, "revisions"));
  runNames.forEach(safeRun);
  revisionNames.forEach(safeRevision);
  return {
    bytes,
    directories,
    files,
    revisions: revisionNames.length,
    runs: runNames.length,
  };
}

export function assertDevCacheCapacity(census: DevCacheCensus): void {
  if (census.runs >= OOMPA_DEV_CACHE_LIMITS.runs
    || census.revisions >= OOMPA_DEV_CACHE_LIMITS.revisions
    || census.files + OOMPA_DEV_CACHE_LIMITS.reserveFiles > OOMPA_DEV_CACHE_LIMITS.files
    || census.directories + OOMPA_DEV_CACHE_LIMITS.reserveDirectories > OOMPA_DEV_CACHE_LIMITS.directories
    || census.bytes + OOMPA_DEV_CACHE_LIMITS.reserveBytes > OOMPA_DEV_CACHE_LIMITS.bytes) {
    throw new DevCapacityError(
      "The retained compiled-development cache reached its reviewed bound; stop the server and review tmp/build-app/dev before removing any revision",
    );
  }
}

function assertDevPublicationCapacity(
  census: DevCacheCensus,
  createsRevision: boolean,
  receiptBytes: number,
): void {
  if (census.runs > OOMPA_DEV_CACHE_LIMITS.runs
    || census.revisions + (createsRevision ? 1 : 0) > OOMPA_DEV_CACHE_LIMITS.revisions
    || census.files + 1 > OOMPA_DEV_CACHE_LIMITS.files
    || census.directories > OOMPA_DEV_CACHE_LIMITS.directories
    || census.bytes + receiptBytes > OOMPA_DEV_CACHE_LIMITS.bytes) {
    throw new DevCapacityError(
      "The completed development build cannot fit its exact publication receipt; preserve the retained cache for review",
    );
  }
}

type DevCacheDirectories = Readonly<{
  receiptsDirectory: string;
  revisionsDirectory: string;
  root: string;
  runsDirectory: string;
}>;

async function prepareDevCacheDirectories(rootDirectory: string): Promise<DevCacheDirectories> {
  const root = resolve(rootDirectory, "tmp", "build-app", "dev");
  await makeOwnedDirectory(resolve(rootDirectory, "tmp"));
  await makeOwnedDirectory(resolve(rootDirectory, "tmp", "build-app"));
  await makeOwnedDirectory(root);
  const runsDirectory = join(root, "runs");
  const revisionsDirectory = join(root, "revisions");
  const receiptsDirectory = join(root, "receipts");
  await makeOwnedDirectory(runsDirectory);
  await makeOwnedDirectory(revisionsDirectory);
  await makeOwnedDirectory(receiptsDirectory);
  return { receiptsDirectory, revisionsDirectory, root, runsDirectory };
}

async function recoverDevCache(directories: DevCacheDirectories): Promise<DevCache> {
  const { receiptsDirectory, revisionsDirectory, root, runsDirectory } = directories;
  // Bound the tree before materializing even one directory-wide name array.
  await inspectDevCache(root);
  const top = (await readdir(root)).sort();
  assert.ok(
    top.every((name) => ["publication.lock", APP_PROCESS_CUSTODY_FILE, "receipts", "revisions", "runs"].includes(name)),
    "Unknown development cache state; preserve it for review",
  );
  const physical = new Map<string, Readonly<{
    artifacts: readonly AppArtifact[];
    directory: string;
    revision: string;
  }>>();
  for (const revision of (await readdir(revisionsDirectory)).sort()) {
    safeRevision(revision);
    const directory = join(revisionsDirectory, revision);
    const artifacts = await readAppInventory(directory);
    physical.set(revision, { artifacts, directory, revision });
  }
  const published = new Map<string, DevPublishedRevision>();
  let latest: DevPublishedRevision | undefined;
  let lastSequence = 0;
  for (const name of (await readdir(receiptsDirectory)).sort()) {
    const match = /^(\d{12})-([a-f0-9]{64})\.json$/u.exec(name);
    assert.ok(match !== null, "Unknown development publication receipt");
    const sequenceText = match[1];
    const namedRevision = match[2];
    assert.ok(sequenceText !== undefined && namedRevision !== undefined);
    const receipt = parseDevBuildReceipt(JSON.parse((await readPrivateRecord(join(receiptsDirectory, name))).toString("utf8")) as unknown);
    assert.equal(String(receipt.sequence).padStart(12, "0"), sequenceText);
    assert.equal(receipt.revision, namedRevision);
    assert.ok(receipt.sequence > lastSequence, "Development publication sequences are not strictly increasing");
    lastSequence = receipt.sequence;
    const revision = physical.get(receipt.revision);
    assert.ok(revision !== undefined, "Development receipt names a missing revision");
    assert.deepEqual(revision.artifacts, receipt.artifacts, "Development receipt inventory changed");
    assert.equal(appDevRevision(revision.artifacts, receipt.sourceMarker), revision.revision, "Immutable development revision contents changed");
    const verified = { ...revision, sourceMarker: receipt.sourceMarker };
    published.set(receipt.revision, verified);
    latest = verified;
  }
  return {
    ...(latest === undefined ? {} : { latest }),
    nextSequence: lastSequence + 1,
    receiptsDirectory,
    revisions: published,
    revisionsDirectory,
    root,
    runsDirectory,
  };
}

export async function prepareDevCache(rootDirectory: string): Promise<DevCache> {
  return recoverDevCache(await prepareDevCacheDirectories(rootDirectory));
}

/** Acquire the persistent dev ownership boundary before inspecting publication state. */
export async function prepareLockedDevCache(rootDirectory: string): Promise<Readonly<{
  cache: DevCache;
  lock: AppPublicationLock;
}>> {
  const directories = await prepareDevCacheDirectories(rootDirectory);
  const lock = acquireAppPublicationLock(directories.root);
  try {
    return { cache: await recoverDevCache(directories), lock };
  } catch (error) {
    lock.release();
    throw error;
  }
}

type OwnedChild = Readonly<{
  exited: Promise<number>;
  pid: number;
}>;

function processGroupExists(pid: number): boolean {
  assert.ok(Number.isSafeInteger(pid) && pid > 1, "Invalid owned process group");
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

function signalOwnedProcessGroup(
  pid: number,
  signal: "SIGKILL" | "SIGTERM",
  beforeSyscall: () => void,
): "absent" | "sent" {
  if (!processGroupExists(pid)) return "absent";
  beforeSyscall();
  try { process.kill(-pid, signal); return "sent"; } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    return "absent";
  }
}

type DevCollectionOperations = Readonly<{
  now?: () => number;
  probe: () => boolean;
  signal: (signal: "SIGKILL" | "SIGTERM", beforeSyscall: () => void) => "absent" | "sent";
  wait: (milliseconds: number) => Promise<void>;
}>;

class DevCollectionTrace {
  attempt = 0;
  killSent = false;
  phase: DevCollectionPhase = "initial-probe";
  termSent = false;
  readonly #started: number;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.#started = now();
  }

  mark(phase: DevCollectionPhase, attempt = 0): void {
    this.phase = phase;
    this.attempt = attempt;
  }

  snapshot(): DevCollectionDiagnostic {
    const elapsed = Math.max(0, Math.floor(this.now() - this.#started));
    return {
      attempt: this.attempt,
      elapsedCapped: elapsed > DEV_BUILD_DEADLINE_MS,
      elapsedMilliseconds: Math.min(DEV_BUILD_DEADLINE_MS, elapsed),
      killSent: this.killSent,
      phase: this.phase,
      termSent: this.termSent,
    };
  }
}

/** Closed process-group operations allow deterministic uncertainty regressions. */
export async function collectDevProcessGroup(operations: DevCollectionOperations): Promise<boolean> {
  return collectTracedDevProcessGroup(operations, new DevCollectionTrace(operations.now));
}

function isDevPermissionFailure(error: unknown): boolean {
  try {
    return typeof error === "object" && error !== null
      && Object.getOwnPropertyDescriptor(error, "code")?.value === "EPERM";
  } catch { return false; }
}

async function waitForDevProcessGroupAbsence(
  operations: DevCollectionOperations, trace: DevCollectionTrace, phase: "term" | "kill",
): Promise<void> {
  const now = operations.now ?? (() => performance.now());
  const deadline = now() + DEV_CHILD_GRACE_MS;
  let unresolvedPermission: { cause: unknown } | undefined;
  for (let attempt = 0; ; attempt += 1) {
    trace.mark(phase === "term" ? "post-term-probe" : "post-kill-probe", attempt);
    try {
      // Only an actual absence probe clears uncertainty. Neither a successful
      // signal nor the direct child's exit establishes group absence.
      if (!operations.probe()) return;
    } catch (error) {
      const signalSent = phase === "term" ? trace.termSent : trace.killSent;
      if (!signalSent || !isDevPermissionFailure(error)) throw error;
      // Retain the first denied observation even if a later probe finds the
      // group present. Unresolved permission never authorizes escalation.
      unresolvedPermission ??= { cause: error };
    }
    const remaining = deadline - now();
    // Keep the existing 80 waits and two-second phase budget, with one final
    // observation at the boundary. No denied probe restarts either bound.
    if (remaining <= 0 || attempt >= DEV_CHILD_GRACE_MS / 25) {
      if (unresolvedPermission !== undefined) throw unresolvedPermission.cause;
      return;
    }
    trace.mark(phase === "term" ? "post-term-wait" : "post-kill-wait", attempt);
    await operations.wait(Math.min(25, remaining));
  }
}

async function collectTracedDevProcessGroup(operations: DevCollectionOperations, trace: DevCollectionTrace): Promise<boolean> {
  const probe = (phase: DevCollectionPhase, attempt = 0): boolean => {
    trace.mark(phase, attempt);
    return operations.probe();
  };
  try {
    if (!probe("initial-probe")) return false;
    trace.mark("term-preprobe");
    trace.termSent = operations.signal("SIGTERM", () => { trace.mark("term-syscall"); }) === "sent";
    await waitForDevProcessGroupAbsence(operations, trace, "term");
    if (probe("pre-kill-probe")) {
      trace.mark("kill-preprobe");
      trace.killSent = operations.signal("SIGKILL", () => { trace.mark("kill-syscall"); }) === "sent";
    }
    await waitForDevProcessGroupAbsence(operations, trace, "kill");
    const present = probe("final-probe");
    trace.mark("final-absence");
    assert.equal(present, false, "Owned development process group survived cleanup");
    return true;
  } catch (cause) {
    throw new DevUncollectedProcessError("Development child collection is unproved; retain both publication owners", {
      cause, collection: trace.snapshot(),
    });
  }
}

async function terminateOwnedChild(child: OwnedChild): Promise<boolean> {
  const trace = new DevCollectionTrace();
  const descendants = await collectTracedDevProcessGroup({
    probe: () => processGroupExists(child.pid),
    signal: (signal, beforeSyscall) => signalOwnedProcessGroup(child.pid, signal, beforeSyscall),
    wait: (milliseconds) => Bun.sleep(milliseconds),
  }, trace);
  // Group absence is not a substitute for collecting the direct child handle.
  let timer: ReturnType<typeof setTimeout> | undefined;
  trace.mark("direct-child-handle");
  try {
    await Promise.race([
      child.exited,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Development child exit was not collected")), DEV_CHILD_GRACE_MS);
      }),
    ]);
  } catch (cause) {
    throw new DevUncollectedProcessError("Development child handle collection is unproved; retain both publication owners", {
      cause, collection: trace.snapshot(),
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return descendants;
}

type OwnedDevProcessOptions = Readonly<{
  command: readonly string[];
  custody?: AppProcessCustody;
  cwd: string;
  deadlineMilliseconds: number;
  onSpawn?: (pid: number) => void;
  signal: AbortSignal;
}>;

/** Clear durable fences only after the direct child and its group are collected. */
export async function runOwnedDevProcess(options: OwnedDevProcessOptions): Promise<void> {
  let failure: unknown;
  let failed = false;
  try { await executeOwnedDevProcess(options); }
  catch (error) { failed = true; failure = error; }
  if (!(failure instanceof AppProcessCustodyError)) {
    try { options.custody?.clearAfterCollection(); }
    catch (error) {
      failure = !failed ? error : new AppProcessCustodyError(
        "Development process failed and its custody records require recovery",
        { cause: new AggregateError([failure, error]) },
      );
      failed = true;
    }
  }
  if (failed) throw failure;
}

/** Spawn one direct child and prove timeout/abort never leaves it running. */
async function executeOwnedDevProcess(options: OwnedDevProcessOptions): Promise<void> {
  assert.ok(options.command.length > 0 && options.command.every((part) => part.length > 0));
  assert.ok(options.deadlineMilliseconds > 0 && options.deadlineMilliseconds <= DEV_BUILD_DEADLINE_MS);
  assert.equal(options.signal.aborted, false, "Development child was aborted before spawn");
  options.custody?.assertHeld();
  const child = Bun.spawn([...options.command], {
    cwd: options.cwd,
    detached: true,
    env: process.env,
    stderr: "inherit",
    stdin: "ignore",
    stdout: "inherit",
  });
  try {
    options.onSpawn?.(child.pid);
  } catch (error) {
    await terminateOwnedChild(child);
    throw error;
  }
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const interruption = new Promise<"abort" | "timeout">((resolveInterruption) => {
    deadline = setTimeout(() => resolveInterruption("timeout"), options.deadlineMilliseconds);
    abortListener = () => resolveInterruption("abort");
    options.signal.addEventListener("abort", abortListener, { once: true });
    if (options.signal.aborted) resolveInterruption("abort");
  });
  let outcome: Readonly<{ code: number; kind: "exit" }> | Readonly<{ kind: "abort" | "timeout" }>;
  try {
    outcome = await Promise.race([
      child.exited.then((code) => ({ code, kind: "exit" as const })),
      interruption.then((kind) => ({ kind })),
    ]);
  } catch (error) {
    await terminateOwnedChild(child);
    throw error;
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
    if (abortListener !== undefined) options.signal.removeEventListener("abort", abortListener);
  }
  if (outcome.kind !== "exit") {
    await terminateOwnedChild(child);
    throw new Error(outcome.kind === "timeout"
      ? "Compiled app build exceeded its owned deadline"
      : "Compiled app build was aborted");
  }
  if (await terminateOwnedChild(child)) {
    throw new Error("Compiled app build left a descendant process running");
  }
  assert.equal(outcome.code, 0, `Compiled app build child failed with exit ${String(outcome.code)}`);
}

async function runBuildChild(
  rootDirectory: string,
  cache: DevCache,
  devLock: AppPublicationLock,
  snapshot: DevInputSnapshot,
  signal: AbortSignal,
): Promise<DevBuildCandidate> {
  assertDevCacheCapacity(await inspectDevCache(cache.root));
  let buildLock: AppPublicationLock;
  let collectionUnproved = false;
  try {
    buildLock = acquireAppPublicationLock(resolve(rootDirectory, "tmp", "build-app"));
  } catch (error) {
    if (error instanceof Error && error.message.includes("Another app publication owns")) {
      throw new DevTransientBuildError("The production app publisher is currently active");
    }
    throw error;
  }
  try {
    const runDirectory = await mkdtemp(join(cache.runsDirectory, "build-"));
    await assertOwnedDirectory(runDirectory);
    await syncEntry(cache.runsDirectory, true);
    const run = safeRun(runDirectory.slice(cache.runsDirectory.length + 1));
    const custody = beginAppProcessCustody([
      { controlDirectory: resolve(rootDirectory, "tmp", "build-app"), lock: buildLock },
      { controlDirectory: cache.root, lock: devLock },
    ], run);
    await runOwnedDevProcess({
      command: [
        process.execPath,
        fileURLToPath(import.meta.url),
        "--build-child",
        run,
        snapshot.sourceEpoch,
        snapshot.dependencyEpoch,
      ],
      custody,
      cwd: rootDirectory,
      deadlineMilliseconds: DEV_BUILD_DEADLINE_MS,
      signal,
    });
    const resultPath = join(runDirectory, "dev-build-result.json");
    const result = parseDevBuildResult(JSON.parse((await readPrivateRecord(resultPath)).toString("utf8")) as unknown);
    assert.equal(result.run, run);
    assert.equal(result.sourceEpoch, snapshot.sourceEpoch);
    assert.equal(result.dependencyEpoch, snapshot.dependencyEpoch);
    assert.deepEqual(result.sourceMarker, snapshot.sourceMarker, "Development build result source-marker inputs changed");
    const publicDirectory = join(runDirectory, "public");
    assert.deepEqual(await readAppInventory(publicDirectory), result.artifacts, "Development child output changed");
    return { ...result, publicDirectory };
  } catch (error) {
    collectionUnproved = error instanceof AppProcessCustodyError;
    throw error;
  } finally {
    releaseCollectedDevOwner(buildLock, collectionUnproved);
  }
}

async function assertRelativeRevisionShell(directory: string): Promise<void> {
  const shell = (await readAppOrdinary(join(directory, "index.html"))).toString("utf8");
  assert.ok(shell.includes('href="./stylex.css"'), "Development shell lost its relative recipe link");
  assert.ok(/href="\.\/graphs\/client\/assets\/[^"]+\.css"/u.test(shell), "Development shell lost its relative foundation link");
  assert.ok(/src="\.\/graphs\/client\/assets\/[^"]+\.js"/u.test(shell), "Development shell lost its relative entry link");
  assert.ok(!/(?:href|src)="\/(?:graphs\/client|stylex\.css)/u.test(shell), "Development shell contains a root-absolute build link");
}

async function syncDevInventory(directory: string, artifacts: readonly AppArtifact[]): Promise<void> {
  assert.deepEqual(await readAppInventory(directory), artifacts, "Development revision inventory changed before sync");
  const directories = new Set<string>([directory]);
  for (const artifact of artifacts) {
    let parent = dirname(join(directory, ...artifact.path.split("/")));
    while (parent !== directory) {
      assert.ok(parent.startsWith(`${directory}${sep}`), "Development artifact parent escaped its revision");
      directories.add(parent);
      parent = dirname(parent);
    }
    await syncEntry(join(directory, ...artifact.path.split("/")), false);
  }
  for (const path of [...directories].sort((left, right) => right.length - left.length)) {
    await syncEntry(path, true);
  }
  assert.deepEqual(await readAppInventory(directory), artifacts, "Development revision inventory changed during sync");
}

async function assertDevSourceMarker(
  directory: string,
  evidenceValue: AppSourceMarkerEvidence,
): Promise<void> {
  const evidence = parseAppSourceMarkerEvidence(evidenceValue);
  const bytes = await readAppOrdinary(join(directory, APP_SOURCE_MARKER_PATH));
  assert.deepEqual(
    { bytes: bytes.byteLength, path: APP_SOURCE_MARKER_PATH, sha256: appSha256(bytes) },
    evidence.markerArtifact,
    "Development source marker changed",
  );
}

export async function publishDevCandidate(options: Readonly<{
  cache: DevCache;
  candidate: DevBuildCandidate;
  currentSnapshot: () => Promise<DevInputSnapshot>;
  lock: AppPublicationLock;
  signal: AbortSignal;
  snapshot: DevInputSnapshot;
}>): Promise<DevPublishedRevision> {
  const assertActive = (): void => {
    options.lock.assertHeld();
    options.signal.throwIfAborted();
  };
  const assertCurrent = async (): Promise<void> => {
    const current = await options.currentSnapshot();
    assertActive();
    if (JSON.stringify(current) !== JSON.stringify(options.snapshot)) throw new DevStaleBuildError();
  };
  assertActive();
  assert.equal(options.candidate.sourceEpoch, options.snapshot.sourceEpoch);
  assert.equal(options.candidate.dependencyEpoch, options.snapshot.dependencyEpoch);
  assert.deepEqual(options.candidate.sourceMarker, options.snapshot.sourceMarker);
  assert.equal(options.candidate.revision, appDevRevision(options.candidate.artifacts, options.candidate.sourceMarker));
  const runDirectory = cacheRunDirectory(options.cache, options.candidate.run);
  assert.equal(options.candidate.publicDirectory, join(runDirectory, "public"), "Development output escaped its owned run");
  await assertCurrent();
  await assertDevSourceMarker(options.candidate.publicDirectory, options.candidate.sourceMarker);
  const target = join(options.cache.revisionsDirectory, options.candidate.revision);
  const createsRevision = await pathAbsent(target);
  const sequence = options.cache.nextSequence;
  safeSequence(sequence);
  const receipt: DevBuildReceipt = {
    artifacts: options.candidate.artifacts,
    dependencyEpoch: options.snapshot.dependencyEpoch,
    kind: "hra-app-dev-publication",
    revision: options.candidate.revision,
    run: options.candidate.run,
    schemaVersion: 2,
    sequence,
    sourceMarker: options.candidate.sourceMarker,
    sourceEpoch: options.snapshot.sourceEpoch,
  };
  assertDevPublicationCapacity(
    await inspectDevCache(options.cache.root),
    createsRevision,
    Buffer.byteLength(developmentRecord(receipt)),
  );
  if (createsRevision) {
    await syncDevInventory(options.candidate.publicDirectory, options.candidate.artifacts);
    await assertDevSourceMarker(options.candidate.publicDirectory, options.candidate.sourceMarker);
    const sourceIdentity = await syncEntry(options.candidate.publicDirectory, true);
    await assertCurrent();
    await assertDevSourceMarker(options.candidate.publicDirectory, options.candidate.sourceMarker);
    assertActive();
    await rename(options.candidate.publicDirectory, target);
    const targetIdentity = await lstat(target);
    assertOwnedEntry(targetIdentity, true);
    assert.ok(sameObjectIdentity(sourceIdentity, targetIdentity), "Development revision identity changed during promotion");
    await syncEntry(dirname(options.candidate.publicDirectory), true);
    await syncEntry(options.cache.revisionsDirectory, true);
  } else {
    assert.deepEqual(await readAppInventory(target), options.candidate.artifacts, "Development revision digest collision");
  }
  await assertRelativeRevisionShell(target);
  assert.deepEqual(await readAppInventory(target), options.candidate.artifacts, "Development revision changed after promotion");
  await assertDevSourceMarker(target, options.candidate.sourceMarker);
  await assertCurrent();
  const stagedReceipt = join(runDirectory, "dev-publication.json");
  const receiptName = `${String(sequence).padStart(12, "0")}-${options.candidate.revision}.json`;
  const finalReceipt = join(options.cache.receiptsDirectory, receiptName);
  assertActive();
  await writePrivateRecord(stagedReceipt, receipt);
  await syncEntry(runDirectory, true);
  await assertCurrent();
  await assertDevSourceMarker(target, options.candidate.sourceMarker);
  const receiptIdentity = await syncEntry(stagedReceipt, false);
  // Submitting the append-only rename is the durable commit boundary. A later
  // cancellation retains that complete receipt but cannot move the live head.
  assertActive();
  await rename(stagedReceipt, finalReceipt);
  options.cache.nextSequence += 1;
  const finalIdentity = await lstat(finalReceipt);
  assertOwnedEntry(finalIdentity, false);
  assert.ok(sameObjectIdentity(receiptIdentity, finalIdentity), "Development receipt identity changed during publication");
  await syncEntry(runDirectory, true);
  await syncEntry(options.cache.receiptsDirectory, true);
  const parsed = parseDevBuildReceipt(JSON.parse((await readPrivateRecord(finalReceipt)).toString("utf8")) as unknown);
  assert.deepEqual(parsed, receipt);
  assert.deepEqual(await readAppInventory(target), options.candidate.artifacts);
  const published = {
    artifacts: options.candidate.artifacts,
    directory: target,
    revision: options.candidate.revision,
    sourceMarker: options.candidate.sourceMarker,
  };
  assertActive();
  options.cache.revisions.set(published.revision, published);
  options.cache.latest = published;
  return published;
}

function cacheRunDirectory(cache: DevCache, run: string): string {
  safeRun(run);
  const path = join(cache.runsDirectory, run);
  assert.equal(dirname(path), cache.runsDirectory, "Development run escaped its cache");
  return path;
}

type CoordinatorOperations = Readonly<{
  build: (snapshot: DevInputSnapshot, signal: AbortSignal) => Promise<DevBuildCandidate>;
  currentSnapshot: () => Promise<DevInputSnapshot>;
  onStatus?: (status: DevStatus) => void;
  publish: (candidate: DevBuildCandidate, snapshot: DevInputSnapshot, signal: AbortSignal) => Promise<DevPublishedRevision>;
}>;

function genericDiagnostic(error: unknown): string {
  if (error instanceof DevCapacityError) return "retained-cache-capacity";
  if (error instanceof DevStaleBuildError) return "stale-build";
  if (error instanceof DevTransientBuildError) return "publication-lane-busy";
  return "build-failed";
}

function validateSnapshot(snapshot: DevInputSnapshot): void {
  digest(snapshot.dependencyEpoch, "dependency epoch");
  digest(snapshot.sourceEpoch, "source epoch");
  parseAppSourceMarkerEvidence(snapshot.sourceMarker);
  assert.ok(snapshot.dependencies.length > 0 && snapshot.sources.length > 0);
}

/** One serial build lane. Later source observations replace, never multiply, work. */
export class DevBuildCoordinator {
  readonly #operations: CoordinatorOperations;
  #active: Promise<void> | undefined;
  #activeController: AbortController | undefined;
  #baselineDependencyEpoch: string | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;
  #processCollectionUnproved = false;
  #desired: DevInputSnapshot | undefined;
  #lastGood: DevPublishedRevision | undefined;
  #lastPublishedSource: string | undefined;
  #lastTriedSource: string | undefined;
  #status: DevStatus = { diagnostic: null, latest: null, phase: "starting" };

  constructor(operations: CoordinatorOperations, initial?: DevPublishedRevision) {
    this.#operations = operations;
    if (initial !== undefined) {
      this.#lastGood = initial;
      this.#status = { diagnostic: null, latest: initial.revision, phase: "ready" };
    }
  }

  get latest(): DevPublishedRevision | undefined {
    return this.#lastGood;
  }

  get status(): DevStatus {
    return this.#status;
  }

  get processCollectionUnproved(): boolean {
    return this.#processCollectionUnproved;
  }

  #setStatus(phase: DevPhase, diagnostic: string | null): void {
    this.#status = { diagnostic, latest: this.#lastGood?.revision ?? null, phase };
    this.#operations.onStatus?.(this.#status);
  }

  notify(snapshot: DevInputSnapshot): void {
    validateSnapshot(snapshot);
    if (this.#closed || this.#status.phase === "restart-required") return;
    this.#baselineDependencyEpoch ??= snapshot.dependencyEpoch;
    if (snapshot.dependencyEpoch !== this.#baselineDependencyEpoch) {
      this.requireRestart("dependency-epoch-changed");
      return;
    }
    if (this.#status.phase === "capacity-blocked") return;
    if (snapshot.sourceEpoch === this.#lastPublishedSource) {
      if (this.#status.diagnostic === "source-census-failed") this.#setStatus("ready", null);
      return;
    }
    if (snapshot.sourceEpoch === this.#lastTriedSource) return;
    this.#desired = snapshot;
    this.#startPump();
  }

  reportScanFailure(): void {
    if (this.#closed || this.#status.phase === "restart-required" || this.#status.phase === "capacity-blocked") return;
    this.#setStatus("degraded", "source-census-failed");
  }

  requireRestart(diagnostic = "dependency-epoch-changed"): void {
    if (this.#closed || this.#status.phase === "restart-required") return;
    this.#desired = undefined;
    this.#setStatus("restart-required", diagnostic);
    this.#activeController?.abort();
  }

  #startPump(): void {
    if (this.#active !== undefined || this.#cannotContinue()) return;
    this.#active = this.#pump().finally(() => {
      this.#active = undefined;
      if (this.#desired !== undefined && !this.#cannotContinue()) this.#startPump();
    });
  }

  // Read current state after every await; callbacks may require a restart.
  #cannotContinue(): boolean {
    return this.#closed || this.#status.phase === "restart-required";
  }

  async #pump(): Promise<void> {
    while (this.#desired !== undefined && !this.#cannotContinue()) {
      const snapshot = this.#desired;
      this.#desired = undefined;
      this.#lastTriedSource = snapshot.sourceEpoch;
      const controller = new AbortController();
      this.#activeController = controller;
      this.#setStatus("building", null);
      try {
        if (this.#cannotContinue()) continue;
        const candidate = await this.#operations.build(snapshot, controller.signal);
        if (this.#cannotContinue()) continue;
        let current: DevInputSnapshot;
        try {
          current = await this.#operations.currentSnapshot();
        } catch (error) {
          if (this.#cannotContinue()) continue;
          this.#lastTriedSource = undefined;
          if (error instanceof DevDependencyError) this.requireRestart("dependency-install-changed");
          else this.#setStatus("degraded", "source-census-failed");
          continue;
        }
        if (this.#cannotContinue()) continue;
        if (current.dependencyEpoch !== this.#baselineDependencyEpoch) {
          this.requireRestart("dependency-epoch-changed");
          continue;
        }
        if (current.sourceEpoch !== snapshot.sourceEpoch) {
          this.#desired = current;
          this.#setStatus(this.#lastGood === undefined ? "building" : "ready", "stale-build");
          continue;
        }
        const published = await this.#operations.publish(candidate, snapshot, controller.signal);
        if (this.#cannotContinue()) continue;
        this.#lastGood = published;
        this.#lastPublishedSource = snapshot.sourceEpoch;
        this.#setStatus("ready", null);
      } catch (error) {
        // Record custody uncertainty even when close/restart raced the child.
        if (error instanceof AppProcessCustodyError) {
          this.#processCollectionUnproved = true;
          this.requireRestart("process-collection-unproved");
          console.error(error.message);
        }
        if (this.#cannotContinue()) continue;
        if (error instanceof DevStaleBuildError) {
          this.#lastTriedSource = undefined;
          try {
            const current = await this.#operations.currentSnapshot();
            if (this.#cannotContinue()) continue;
            if (current.dependencyEpoch !== this.#baselineDependencyEpoch) this.requireRestart("dependency-epoch-changed");
            else this.#desired = current;
          } catch (snapshotError) {
            if (this.#cannotContinue()) continue;
            if (snapshotError instanceof DevDependencyError) this.requireRestart("dependency-install-changed");
            else this.#setStatus("degraded", "source-census-failed");
          }
          continue;
        }
        if (error instanceof DevTransientBuildError) {
          // This build did not execute. Permit the next bounded census tick to
          // retry after the production publisher releases its own lock.
          this.#lastTriedSource = undefined;
        }
        const diagnostic = genericDiagnostic(error);
        this.#setStatus(error instanceof DevCapacityError ? "capacity-blocked" : "degraded", diagnostic);
        if (error instanceof Error) console.error(`Oompa compiled development build failed: ${error.message.slice(0, MAX_DIAGNOSTIC_BYTES)}`);
      } finally {
        if (this.#activeController === controller) this.#activeController = undefined;
      }
    }
  }

  async waitForIdle(): Promise<void> {
    while (this.#active !== undefined) await this.#active;
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    // Install the shared promise before abort listeners can reenter close.
    this.#closing = Promise.resolve().then(() => this.waitForIdle()).then(() => { this.#setStatus("stopped", null); });
    this.#closed = true;
    this.#desired = undefined;
    this.#activeController?.abort();
    return this.#closing;
  }
}

const expectedDevHeaders = Object.freeze(new Map<string, string>([
  ["Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src https://qualified-hummingbird-537.convex.cloud wss://qualified-hummingbird-537.convex.cloud https://qualified-hummingbird-537.convex.site; style-src 'self'; img-src data: blob:; font-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'; worker-src 'none'; manifest-src 'none'; frame-ancestors 'none'"],
  ["Cross-Origin-Opener-Policy", "same-origin"],
  ["Permissions-Policy", "camera=(), clipboard-read=(), geolocation=(), microphone=(), payment=(), usb=()"],
  ["Referrer-Policy", "no-referrer"],
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
  ["X-Robots-Tag", "noindex, nofollow"],
]));

export function parseDevSecurityHeaders(value: unknown): readonly (readonly [string, string])[] {
  const configuration = record(value);
  assert.ok(Array.isArray(configuration.headers));
  const globalEntries = configuration.headers.map(record).filter((item) => item.source === "/(.*)");
  assert.equal(globalEntries.length, 1, "Production security headers must have one global rule");
  const global = globalEntries[0];
  assert.ok(global !== undefined && Array.isArray(global.headers), "Production security headers are missing");
  const parsed = new Map<string, string>();
  for (const raw of global.headers) {
    const header = record(raw);
    exactKeys(header, ["key", "value"]);
    assert.ok(typeof header.key === "string" && typeof header.value === "string");
    assert.equal(parsed.has(header.key), false, `Duplicate production header: ${header.key}`);
    parsed.set(header.key, header.value);
  }
  assert.deepEqual(parsed, expectedDevHeaders, "Development headers must equal the production security policy");
  return [...parsed.entries()];
}

function responseHeaders(
  securityHeaders: readonly (readonly [string, string])[],
  cacheControl: "immutable" | "no-store",
): Headers {
  const headers = new Headers();
  for (const [name, value] of securityHeaders) headers.append(name, value);
  headers.set("Cache-Control", cacheControl === "immutable"
    ? "public, max-age=31536000, immutable"
    : "no-store");
  return headers;
}

function contentType(path: string): string {
  if (path === APP_SOURCE_MARKER_PATH) return "application/json; charset=utf-8";
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  throw new Error(`Unsupported development response type: ${path}`);
}

export function createDevRequestHandler(options: Readonly<{
  getStatus: () => DevStatus;
  revisions: Map<string, DevPublishedRevision>;
  securityHeaders: readonly (readonly [string, string])[];
}>): (request: Request) => Promise<Response> {
  const redirectLatest = (url: URL): Response => {
    const latest = options.getStatus().latest;
    if (latest === null) {
      const headers = responseHeaders(options.securityHeaders, "no-store");
      headers.set("Content-Type", "text/plain; charset=utf-8");
      return new Response("Oompa is compiling its first complete development graph.\n", { headers, status: 503 });
    }
    const headers = responseHeaders(options.securityHeaders, "no-store");
    headers.set("Location", `${OOMPA_DEV_PREFIX}/${latest}/${url.search}`);
    return new Response(null, { headers, status: 307 });
  };

  const serveRevisionArtifact = async (
    request: Request,
    revisionName: string,
    path: string,
  ): Promise<Response> => {
    const revision = options.revisions.get(revisionName);
    const artifact = revision?.artifacts.find((item) => item.path === path);
    if (revision === undefined || artifact === undefined) {
      return new Response(null, { headers: responseHeaders(options.securityHeaders, "no-store"), status: 404 });
    }
    try {
      const bytes = await readAppOrdinary(join(revision.directory, ...path.split("/")));
      assert.deepEqual(
        { bytes: bytes.byteLength, sha256: appSha256(bytes) },
        { bytes: artifact.bytes, sha256: artifact.sha256 },
        "Immutable development artifact changed",
      );
      const noStore = path === "index.html" || path === APP_SOURCE_MARKER_PATH;
      const headers = responseHeaders(options.securityHeaders, noStore ? "no-store" : "immutable");
      headers.set("Content-Length", String(bytes.byteLength));
      headers.set("Content-Type", contentType(path));
      return new Response(request.method === "HEAD" ? null : Uint8Array.from(bytes), { headers });
    } catch (error) {
      console.error(`Oompa immutable development artifact failed revalidation: ${error instanceof Error ? error.message.slice(0, MAX_DIAGNOSTIC_BYTES) : "unknown error"}`);
      return new Response(null, { headers: responseHeaders(options.securityHeaders, "no-store"), status: 500 });
    }
  };

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.protocol !== "http:" || url.hostname !== OOMPA_DEV_HOST
      || url.port !== String(OOMPA_DEV_PORT) || url.username !== "" || url.password !== "") {
      return new Response(null, { headers: responseHeaders(options.securityHeaders, "no-store"), status: 421 });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      const headers = responseHeaders(options.securityHeaders, "no-store");
      headers.set("Allow", "GET, HEAD");
      return new Response(null, { headers, status: 405 });
    }
    if (url.pathname === `/${APP_SOURCE_MARKER_PATH}`) {
      const latest = options.getStatus().latest;
      if (latest === null) {
        const headers = responseHeaders(options.securityHeaders, "no-store");
        headers.set("Content-Type", "application/json; charset=utf-8");
        return new Response(request.method === "HEAD" ? null : '{"error":"app-compiling"}\n', { headers, status: 503 });
      }
      return serveRevisionArtifact(request, latest, APP_SOURCE_MARKER_PATH);
    }
    if (url.pathname === "/" || url.pathname === "/index.html"
      || url.pathname === `${OOMPA_DEV_PREFIX}/latest` || url.pathname === `${OOMPA_DEV_PREFIX}/latest/`) {
      return redirectLatest(url);
    }
    if (url.pathname === `${OOMPA_DEV_PREFIX}/status.json`) {
      const body = `${JSON.stringify(options.getStatus())}\n`;
      const headers = responseHeaders(options.securityHeaders, "no-store");
      headers.set("Content-Type", "application/json; charset=utf-8");
      return new Response(request.method === "HEAD" ? null : body, { headers });
    }
    const match = /^\/_hra_dev\/([a-f0-9]{64})\/(.*)$/u.exec(url.pathname);
    if (match === null) return new Response(null, { headers: responseHeaders(options.securityHeaders, "no-store"), status: 404 });
    const revisionName = match[1];
    let path = match[2];
    assert.ok(revisionName !== undefined && path !== undefined);
    const status = options.getStatus();
    if (path === "" && status.latest !== null && revisionName !== status.latest) return redirectLatest(url);
    if (path === "") path = "index.html";
    try {
      logicalPath(path, "Development request path");
    } catch {
      return new Response(null, { headers: responseHeaders(options.securityHeaders, "no-store"), status: 404 });
    }
    return serveRevisionArtifact(request, revisionName, path);
  };
}

async function runDevelopmentBuildChild(
  rootDirectory: string,
  run: string,
  sourceEpoch: string,
  dependencyEpoch: string,
): Promise<void> {
  safeRun(run);
  digest(sourceEpoch, "source epoch");
  digest(dependencyEpoch, "dependency epoch");
  const runDirectory = resolve(rootDirectory, "tmp", "build-app", "dev", "runs", run);
  assert.equal(dirname(runDirectory), resolve(rootDirectory, "tmp", "build-app", "dev", "runs"));
  await assertOwnedDirectory(runDirectory);
  const inputSpec = await defaultDevInputSpec(rootDirectory);
  const before = await snapshotDevInputs(inputSpec);
  assert.equal(before.sourceEpoch, sourceEpoch, "Development source changed before the build child started");
  assert.equal(before.dependencyEpoch, dependencyEpoch, "Development dependency install changed before the build child started");
  const staged = await stageAppBuild({
    profile: "development",
    rootDirectory,
    runDirectory,
  });
  assert.deepEqual(staged.sourceMarker, before.sourceMarker, "Development source-marker inputs changed during staging");
  await assertRelativeRevisionShell(staged.publishDirectory);
  const after = await snapshotDevInputs(inputSpec);
  assert.deepEqual(after, before, "Development inputs changed while the build child compiled");
  const result: DevBuildResult = {
    artifacts: staged.projected,
    dependencyEpoch,
    kind: "hra-app-dev-build-result",
    revision: appDevRevision(staged.projected, staged.sourceMarker),
    run,
    schemaVersion: 2,
    sourceMarker: staged.sourceMarker,
    sourceEpoch,
  };
  await writePrivateRecord(join(runDirectory, "dev-build-result.json"), result);
  await syncEntry(runDirectory, true);
}

async function runDevelopmentServer(): Promise<void> {
  assert.equal(Bun.version, "1.3.14", "Run app development with the pinned Bun runtime");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await assertOwnedDirectory(root);
  const securityHeaders = parseDevSecurityHeaders(JSON.parse(await readFile(join(root, "app", "vercel.json"), "utf8")) as unknown);
  const { cache, lock: devLock } = await prepareLockedDevCache(root);
  let coordinator: DevBuildCoordinator | undefined;
  let spec: DevInputSpec | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  const handler = createDevRequestHandler({
    getStatus: () => coordinator?.status ?? { diagnostic: null, latest: null, phase: "starting" },
    revisions: cache.revisions,
    securityHeaders,
  });
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      development: false,
      fetch: handler,
      hostname: OOMPA_DEV_HOST,
      port: OOMPA_DEV_PORT,
      reusePort: false,
    });
  } catch (error) {
    devLock.release();
    throw error;
  }
  assert.equal(server.hostname, OOMPA_DEV_HOST, "Development server did not bind the loopback host");
  assert.equal(server.port, OOMPA_DEV_PORT, "Development server did not bind the fixed port");
  console.log(`Oompa compiled development server bound http://${OOMPA_DEV_HOST}:${String(OOMPA_DEV_PORT)}/ before its first build.`);
  try {
    try {
      spec = await defaultDevInputSpec(root);
      const currentSnapshot = async (): Promise<DevInputSnapshot> => {
        assert.ok(spec !== undefined, "Development input specification is unavailable");
        return snapshotDevInputs(spec);
      };
      coordinator = new DevBuildCoordinator({
        build: (snapshot, signal) => runBuildChild(root, cache, devLock, snapshot, signal),
        currentSnapshot,
        onStatus: (status) => {
          if (status.phase === "ready" && status.diagnostic === null) console.log(`Oompa development revision ready: ${status.latest ?? "unknown"}. Refresh the page to load it.`);
          if (status.phase === "restart-required") console.error("Oompa development dependencies changed. Restart dev:app; no install was attempted.");
          if (status.phase === "capacity-blocked") console.error("Oompa development cache is full. Stop dev:app and review tmp/build-app/dev before cleanup.");
        },
        publish: (candidate, snapshot, signal) => publishDevCandidate({
          cache,
          candidate,
          currentSnapshot,
          lock: devLock,
          signal,
          snapshot,
        }),
      }, cache.latest);
      polling = true;
      try {
        coordinator.notify(await currentSnapshot());
      } catch (error) {
        if (error instanceof DevDependencyError) coordinator.requireRestart("dependency-install-changed");
        else coordinator.reportScanFailure();
      } finally {
        polling = false;
      }
      poll = setInterval(() => {
        if (polling || coordinator === undefined || spec === undefined
          || coordinator.status.phase === "restart-required") return;
        polling = true;
        void snapshotDevInputs(spec).then(
          (snapshot) => coordinator?.notify(snapshot),
          (error: unknown) => {
            if (error instanceof DevDependencyError) coordinator?.requireRestart("dependency-install-changed");
            else coordinator?.reportScanFailure();
          },
        ).finally(() => { polling = false; });
      }, DEV_POLL_MS);
    } catch (error) {
      console.error(`Oompa development initialization requires restart: ${error instanceof Error ? error.message.slice(0, MAX_DIAGNOSTIC_BYTES) : "unknown error"}`);
      coordinator = new DevBuildCoordinator({
        build: async () => { throw new Error("Development initialization failed"); },
        currentSnapshot: async () => { throw new Error("Development initialization failed"); },
        publish: async () => { throw new Error("Development initialization failed"); },
      }, cache.latest);
      coordinator.requireRestart("dependency-initialization-failed");
    }

    await new Promise<void>((resolveShutdown) => {
      let requested = false;
      const shutdown = (): void => {
        if (requested) return;
        requested = true;
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
        resolveShutdown();
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });
  } finally {
    if (poll !== undefined) clearInterval(poll);
    try {
      await coordinator?.close();
    } finally {
      try {
        await server.stop(true);
      } finally {
        releaseCollectedDevOwner(devLock, coordinator?.processCollectionUnproved === true);
      }
    }
  }
}

if (import.meta.main) {
  const arguments_ = process.argv.slice(2);
  if (arguments_[0] === "--build-child") {
    assert.equal(arguments_.length, 4, "Development build child received unexpected arguments");
    const run = arguments_[1];
    const sourceEpoch = arguments_[2];
    const dependencyEpoch = arguments_[3];
    assert.ok(run !== undefined && sourceEpoch !== undefined && dependencyEpoch !== undefined);
    await runDevelopmentBuildChild(
      resolve(dirname(fileURLToPath(import.meta.url)), ".."),
      run,
      sourceEpoch,
      dependencyEpoch,
    );
  } else {
    assert.deepEqual(arguments_, [], "dev:app accepts no command-line arguments");
    await runDevelopmentServer();
  }
}
