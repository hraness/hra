import { createHash } from "node:crypto";
import {
  constants,
  lstat,
  open,
  readdir,
} from "node:fs/promises";
import { posix, resolve, sep } from "node:path";

const DEFAULT_ENTRY_PATH = "index.html";
const DEFAULT_MANIFEST_SOURCE_DIRECTORY = "frontend/dist";
const NATIVE_ASSET_MANIFEST = "asset-manifest.zon";
const VITE_ASSET_MANIFEST = ".vite/manifest.json";
const MANIFEST_HEADER = ".{ .assets = .{\n";
const MANIFEST_FOOTER = "} }\n";
const MANIFEST_ENTRY = /^ {2}\.\{ \.id = "([^"\\\r\n]+)", \.bundle_path = "([^"\\\r\n]+)", \.source_path = "([^"\\\r\n]+)", \.byte_len = (0|[1-9][0-9]*), \.hash = "([0-9a-f]{64})"(?:, \.media_type = "([^"\\\r\n]+)")? \},$/;
const FILE_REFERENCE_TAG = /<(script|link|img|source|video|audio)\b[^>]*>/giu;
const HTML_ATTRIBUTE = /\b([a-z][a-z0-9:_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu;

export const FRONTEND_PACKAGE_LIMITS = Object.freeze({
  maximumDirectoryDepth: 16,
  maximumFileBytes: 16 * 1024 * 1024,
  maximumFileCount: 4_096,
  maximumManifestBytes: 2 * 1024 * 1024,
  maximumPathBytes: 1_024,
  maximumTotalBytes: 128 * 1024 * 1024,
  maximumViteManifestEntries: 4_096,
});

export type FrontendPackageIntegrityCode =
  | "blank_package"
  | "duplicate_manifest_asset"
  | "file_changed_during_read"
  | "file_set_mismatch"
  | "invalid_asset_path"
  | "invalid_entry"
  | "invalid_file_type"
  | "invalid_manifest"
  | "manifest_asset_mismatch"
  | "missing_asset"
  | "missing_directory"
  | "missing_entry"
  | "missing_manifest"
  | "non_local_executable_asset"
  | "resource_limit"
  | "reserved_asset_path";

export class FrontendPackageIntegrityError extends Error {
  readonly code: FrontendPackageIntegrityCode;

  constructor(code: FrontendPackageIntegrityCode, message: string) {
    super(message);
    this.name = "FrontendPackageIntegrityError";
    this.code = code;
  }
}

export interface FrontendAssetFile {
  readonly byteLength: number;
  readonly relativePath: string;
  readonly sha256: string;
}

export interface FrontendAssetInventory {
  readonly entryPath: string;
  readonly files: readonly FrontendAssetFile[];
  readonly referencedAssets: readonly string[];
  readonly rootDirectory: string;
}

export interface RequiredOversizedFrontendAsset {
  readonly byteLength: number;
  readonly relativePath: string;
  readonly sha256: string;
}

export interface NativeAssetManifestEntry {
  readonly bundlePath: string;
  readonly byteLength: number;
  readonly hash: string;
  readonly id: string;
  readonly mediaType?: string;
  readonly sourcePath: string;
}

interface ViteManifestEntry {
  readonly assets: readonly string[];
  readonly css: readonly string[];
  readonly dynamicImports: readonly string[];
  readonly file: string;
  readonly imports: readonly string[];
  readonly isDynamicEntry: boolean;
  readonly isEntry: boolean;
  readonly name?: string;
  readonly names: readonly string[];
  readonly source?: string;
}

interface ViteManifest {
  readonly entries: ReadonlyMap<string, ViteManifestEntry>;
}

interface InventoryFile extends FrontendAssetFile {
  readonly absolutePath: string;
}

interface PendingInventoryFile {
  readonly absolutePath: string;
  readonly byteLength: number;
  readonly expectedSha256?: string;
  readonly relativePath: string;
}

interface InternalInventory extends FrontendAssetInventory {
  readonly directories: readonly string[];
  readonly files: readonly InventoryFile[];
}

export async function validateFrontendBuild(options: {
  readonly entryPath?: string;
  readonly sourceDirectory: string;
}): Promise<FrontendAssetInventory> {
  const entryPath = validateAssetPath(
    options.entryPath ?? DEFAULT_ENTRY_PATH,
    "frontend entry",
  );
  const inventory = await inventoryDirectory(options.sourceDirectory, {
    rejectManifest: true,
  });
  const references = await validateEntryAndReferences(inventory, entryPath);
  const viteManifest = inventory.files.find(
    (file) => file.relativePath === VITE_ASSET_MANIFEST,
  );
  if (viteManifest === undefined) {
    throw new FrontendPackageIntegrityError(
      "missing_manifest",
      `Frontend build is missing ephemeral ${VITE_ASSET_MANIFEST}.`,
    );
  }
  if (viteManifest.byteLength > FRONTEND_PACKAGE_LIMITS.maximumManifestBytes) {
    throw resourceLimit(
      `${VITE_ASSET_MANIFEST} exceeds ${FRONTEND_PACKAGE_LIMITS.maximumManifestBytes} bytes.`,
    );
  }
  const manifest = parseViteManifest(
    (await readStableRegularFile(viteManifest.absolutePath)).toString("utf8"),
    entryPath,
  );
  validateViteReachability(inventory, references, manifest, entryPath);
  return publicInventory(inventory, entryPath, references);
}

export async function verifyPackagedFrontend(options: {
  readonly entryPath?: string;
  readonly manifestSourceDirectory?: string;
  readonly packageDirectory: string;
  readonly requiredOversizedAsset?: RequiredOversizedFrontendAsset;
  readonly sourceDirectory?: string;
}): Promise<void> {
  const entryPath = validateAssetPath(
    options.entryPath ?? DEFAULT_ENTRY_PATH,
    "frontend entry",
  );
  const manifestSourceDirectory = validateAssetPath(
    options.manifestSourceDirectory ?? DEFAULT_MANIFEST_SOURCE_DIRECTORY,
    "manifest source directory",
  );
  const requiredOversizedAsset = options.requiredOversizedAsset === undefined
    ? undefined
    : validateRequiredOversizedAsset(options.requiredOversizedAsset);
  const packaged = await inventoryDirectory(options.packageDirectory, {
    rejectManifest: false,
    ...(requiredOversizedAsset === undefined
      ? {}
      : { requiredOversizedAsset }),
  });
  const manifestFile = packaged.files.find(
    (file) => file.relativePath === NATIVE_ASSET_MANIFEST,
  );
  if (manifestFile === undefined) {
    throw new FrontendPackageIntegrityError(
      "missing_manifest",
      `Packaged frontend is missing ${NATIVE_ASSET_MANIFEST}.`,
    );
  }
  const manifestText = (await readStableRegularFile(manifestFile.absolutePath))
    .toString("utf8");
  const manifest = parseNativeAssetManifest(manifestText);
  if (manifest.length === 0) {
    throw new FrontendPackageIntegrityError(
      "blank_package",
      "Native asset manifest contains no frontend assets.",
    );
  }

  const packageAssets = packaged.files.filter(
    (file) => file.relativePath !== NATIVE_ASSET_MANIFEST,
  );
  requireExactPaths(
    "package and Native asset manifest",
    packageAssets.map((file) => file.relativePath),
    manifest.map((entry) => entry.bundlePath),
  );
  requireExactPaths(
    "package and Native asset manifest directories",
    packaged.directories,
    parentDirectories([
      NATIVE_ASSET_MANIFEST,
      ...manifest.map((entry) => entry.bundlePath),
    ]),
  );

  const packageByPath = new Map(
    packageAssets.map((file) => [file.relativePath, file] as const),
  );
  const manifestByPath = new Map(
    manifest.map((entry) => [entry.bundlePath, entry] as const),
  );
  for (const entry of manifest) {
    const packagedFile = packageByPath.get(entry.bundlePath);
    if (packagedFile === undefined) {
      throw new FrontendPackageIntegrityError(
        "missing_asset",
        `Native asset manifest names missing package file ${entry.bundlePath}.`,
      );
    }
    const expectedSourcePath = `${manifestSourceDirectory}/${entry.bundlePath}`;
    if (
      entry.id !== entry.bundlePath ||
      entry.sourcePath !== expectedSourcePath ||
      entry.byteLength !== packagedFile.byteLength ||
      entry.hash !== packagedFile.sha256
    ) {
      throw new FrontendPackageIntegrityError(
        "manifest_asset_mismatch",
        `Native asset manifest metadata does not match ${entry.bundlePath}.`,
      );
    }
  }

  const packageReferences = await validateEntryAndReferences(
    packaged,
    entryPath,
  );
  for (const reference of packageReferences) {
    if (!manifestByPath.has(reference)) {
      throw new FrontendPackageIntegrityError(
        "missing_asset",
        `Frontend entry references ${reference}, which is absent from the Native asset manifest.`,
      );
    }
  }

  if (options.sourceDirectory === undefined) return;

  const source = await inventoryDirectory(options.sourceDirectory, {
    rejectManifest: true,
  });
  const sourceReferences = await validateEntryAndReferences(source, entryPath);
  requireExactPaths(
    "source and packaged frontend",
    source.files.map((file) => file.relativePath),
    packageAssets.map((file) => file.relativePath),
  );
  requireExactPaths(
    "source and packaged frontend directories",
    source.directories,
    packaged.directories,
  );
  requireExactPaths(
    "source and packaged entry references",
    sourceReferences,
    packageReferences,
  );

  const sourceByPath = new Map(
    source.files.map((file) => [file.relativePath, file] as const),
  );
  for (const packagedFile of packageAssets) {
    const sourceFile = sourceByPath.get(packagedFile.relativePath);
    if (
      sourceFile === undefined ||
      sourceFile.byteLength !== packagedFile.byteLength ||
      sourceFile.sha256 !== packagedFile.sha256
    ) {
      throw new FrontendPackageIntegrityError(
        "manifest_asset_mismatch",
        `Packaged frontend bytes differ from source for ${packagedFile.relativePath}.`,
      );
    }
  }
}

export function parseNativeAssetManifest(
  text: string,
): readonly NativeAssetManifestEntry[] {
  if (!text.startsWith(MANIFEST_HEADER) || !text.endsWith(MANIFEST_FOOTER)) {
    throw invalidManifest("Native asset manifest has an unexpected envelope.");
  }
  const body = text.slice(MANIFEST_HEADER.length, -MANIFEST_FOOTER.length);
  if (body.length === 0) return [];
  if (!body.endsWith("\n")) {
    throw invalidManifest("Native asset manifest entries must be line-delimited.");
  }

  const entries: NativeAssetManifestEntry[] = [];
  const seenIds = new Set<string>();
  const seenBundlePaths = new Set<string>();
  for (const line of body.slice(0, -1).split("\n")) {
    const match = MANIFEST_ENTRY.exec(line);
    if (match === null) {
      throw invalidManifest("Native asset manifest contains a malformed entry.");
    }
    const [, idValue, bundlePathValue, sourcePathValue, byteLengthValue, hash, mediaType] = match;
    if (
      idValue === undefined ||
      bundlePathValue === undefined ||
      sourcePathValue === undefined ||
      byteLengthValue === undefined ||
      hash === undefined
    ) {
      throw invalidManifest("Native asset manifest entry is incomplete.");
    }
    const id = validateAssetPath(idValue, "manifest asset id");
    const bundlePath = validateAssetPath(
      bundlePathValue,
      "manifest bundle path",
    );
    const sourcePath = validateAssetPath(
      sourcePathValue,
      "manifest source path",
    );
    if (id === NATIVE_ASSET_MANIFEST || bundlePath === NATIVE_ASSET_MANIFEST) {
      throw new FrontendPackageIntegrityError(
        "reserved_asset_path",
        `${NATIVE_ASSET_MANIFEST} cannot describe itself as a frontend asset.`,
      );
    }
    if (seenIds.has(id) || seenBundlePaths.has(bundlePath)) {
      throw new FrontendPackageIntegrityError(
        "duplicate_manifest_asset",
        `Native asset manifest repeats ${id}.`,
      );
    }
    const byteLength = Number(byteLengthValue);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw invalidManifest("Native asset manifest byte length is unsafe.");
    }
    seenIds.add(id);
    seenBundlePaths.add(bundlePath);
    entries.push({
      bundlePath,
      byteLength,
      hash,
      id,
      ...(mediaType === undefined ? {} : { mediaType }),
      sourcePath,
    });
  }
  return entries;
}

function parseViteManifest(text: string, entryPath: string): ViteManifest {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw invalidManifest("Vite asset manifest is not valid JSON.");
  }
  if (!isPlainRecord(value)) {
    throw invalidManifest("Vite asset manifest must be an object.");
  }
  const records = Object.entries(value);
  if (
    records.length === 0 ||
    records.length > FRONTEND_PACKAGE_LIMITS.maximumViteManifestEntries
  ) {
    throw resourceLimit(
      `Vite asset manifest must contain 1-${FRONTEND_PACKAGE_LIMITS.maximumViteManifestEntries} entries.`,
    );
  }

  const entries = new Map<string, ViteManifestEntry>();
  const outputFiles = new Set<string>();
  let entryCount = 0;
  for (const [key, record] of records) {
    validateViteKey(key, "manifest key");
    if (!isPlainRecord(record)) {
      throw invalidManifest(`Vite manifest entry ${JSON.stringify(key)} must be an object.`);
    }
    const allowed = new Set([
      "assets",
      "css",
      "dynamicImports",
      "file",
      "imports",
      "isDynamicEntry",
      "isEntry",
      "name",
      "names",
      "src",
    ]);
    for (const field of Object.keys(record)) {
      if (!allowed.has(field)) {
        throw invalidManifest(
          `Vite manifest entry ${JSON.stringify(key)} has unknown field ${JSON.stringify(field)}.`,
        );
      }
    }
    const file = parseViteOutputPath(record.file, key, "file");
    if (outputFiles.has(file)) {
      throw invalidManifest(`Vite manifest repeats output file ${file}.`);
    }
    outputFiles.add(file);
    const isEntry = parseOptionalBoolean(record.isEntry, key, "isEntry");
    const isDynamicEntry = parseOptionalBoolean(
      record.isDynamicEntry,
      key,
      "isDynamicEntry",
    );
    const source = parseOptionalViteString(record.src, key, "src");
    const name = parseOptionalViteString(record.name, key, "name");
    const names = parseViteStringArray(record.names, key, "names", false);
    if (isEntry) entryCount += 1;
    entries.set(key, {
      assets: parseViteOutputArray(record.assets, key, "assets"),
      css: parseViteOutputArray(record.css, key, "css"),
      dynamicImports: parseViteStringArray(
        record.dynamicImports,
        key,
        "dynamicImports",
        true,
      ),
      file,
      imports: parseViteStringArray(record.imports, key, "imports", true),
      isDynamicEntry,
      isEntry,
      ...(name === undefined ? {} : { name }),
      names,
      ...(source === undefined ? {} : { source }),
    });
  }

  const entry = entries.get(entryPath);
  if (
    entryCount !== 1 ||
    entry === undefined ||
    !entry.isEntry ||
    entry.source !== entryPath
  ) {
    throw invalidManifest(
      `Vite asset manifest must have exactly one ${entryPath} entry with matching src.`,
    );
  }
  return { entries };
}

function validateViteReachability(
  inventory: InternalInventory,
  htmlReferences: readonly string[],
  manifest: ViteManifest,
  entryPath: string,
): void {
  const reachableFiles = new Set<string>([entryPath, ...htmlReferences]);
  const visitedEntries = new Set<string>();
  const pending = [entryPath];
  while (pending.length > 0) {
    const key = pending.pop();
    if (key === undefined || visitedEntries.has(key)) continue;
    const entry = manifest.entries.get(key);
    if (entry === undefined) {
      throw new FrontendPackageIntegrityError(
        "missing_asset",
        `Vite manifest graph references missing entry ${key}.`,
      );
    }
    visitedEntries.add(key);
    reachableFiles.add(entry.file);
    for (const path of [...entry.css, ...entry.assets]) {
      reachableFiles.add(path);
    }
    pending.push(...entry.imports, ...entry.dynamicImports);
  }

  for (const [key, entry] of manifest.entries) {
    if (!reachableFiles.has(entry.file)) {
      throw new FrontendPackageIntegrityError(
        "file_set_mismatch",
        `Vite output ${entry.file} from ${key} is unreachable from ${entryPath}.`,
      );
    }
  }
  requireExactPaths(
    "reachable Vite graph and emitted frontend",
    [...reachableFiles],
    inventory.files
      .map((file) => file.relativePath)
      .filter((path) => path !== VITE_ASSET_MANIFEST),
  );
  requireExactPaths(
    "reachable Vite graph and emitted frontend directories",
    parentDirectories([...reachableFiles, VITE_ASSET_MANIFEST]),
    inventory.directories,
  );
}

function parseViteOutputArray(
  value: unknown,
  key: string,
  field: string,
): readonly string[] {
  return parseViteStringArray(value, key, field, false).map((path) =>
    parseViteOutputPath(path, key, field)
  );
}

function parseViteStringArray(
  value: unknown,
  key: string,
  field: string,
  allowSourceKeys: boolean,
): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > FRONTEND_PACKAGE_LIMITS.maximumFileCount) {
    throw invalidManifest(
      `Vite manifest ${JSON.stringify(key)}.${field} must be a bounded string array.`,
    );
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      throw invalidManifest(
        `Vite manifest ${JSON.stringify(key)}.${field} must contain only strings.`,
      );
    }
    if (allowSourceKeys) validateViteKey(item, `${key}.${field}`);
    else validateAssetPath(item, `${key}.${field}`);
    if (seen.has(item)) {
      throw invalidManifest(
        `Vite manifest ${JSON.stringify(key)}.${field} repeats ${JSON.stringify(item)}.`,
      );
    }
    seen.add(item);
    result.push(item);
  }
  return result;
}

function parseViteOutputPath(value: unknown, key: string, field: string): string {
  if (typeof value !== "string") {
    throw invalidManifest(
      `Vite manifest ${JSON.stringify(key)}.${field} must be a path.`,
    );
  }
  const path = validateAssetPath(value, `${key}.${field}`);
  if (path === NATIVE_ASSET_MANIFEST || path === VITE_ASSET_MANIFEST) {
    throw new FrontendPackageIntegrityError(
      "reserved_asset_path",
      `Vite manifest cannot emit reserved path ${path}.`,
    );
  }
  return path;
}

function parseOptionalBoolean(
  value: unknown,
  key: string,
  field: string,
): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw invalidManifest(
      `Vite manifest ${JSON.stringify(key)}.${field} must be boolean.`,
    );
  }
  return value;
}

function parseOptionalViteString(
  value: unknown,
  key: string,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw invalidManifest(
      `Vite manifest ${JSON.stringify(key)}.${field} must be a string.`,
    );
  }
  validateViteKey(value, `${key}.${field}`);
  return value;
}

function validateViteKey(value: string, label: string): void {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value) > FRONTEND_PACKAGE_LIMITS.maximumPathBytes
  ) {
    throw invalidManifest(`Vite ${label} is empty or too long.`);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

async function inventoryDirectory(
  directory: string,
  options: {
    readonly rejectManifest: boolean;
    readonly requiredOversizedAsset?: RequiredOversizedFrontendAsset;
  },
): Promise<InternalInventory> {
  const rootDirectory = resolve(directory);
  let rootStat;
  try {
    rootStat = await lstat(rootDirectory);
  } catch (error) {
    if (isNotFound(error)) {
      throw new FrontendPackageIntegrityError(
        "missing_directory",
        `Frontend directory does not exist: ${rootDirectory}`,
      );
    }
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new FrontendPackageIntegrityError(
      "invalid_file_type",
      `Frontend root must be a real directory: ${rootDirectory}`,
    );
  }

  const directories: string[] = [];
  const pendingFiles: PendingInventoryFile[] = [];
  const counters = { directories: 1, totalBytes: 0 };
  await walkDirectory(
    rootDirectory,
    "",
    directories,
    pendingFiles,
    counters,
    options,
  );
  if (
    options.requiredOversizedAsset !== undefined &&
    !pendingFiles.some((file) =>
      file.relativePath === options.requiredOversizedAsset?.relativePath
    )
  ) {
    throw new FrontendPackageIntegrityError(
      "missing_asset",
      `Required oversized frontend asset is missing: ${options.requiredOversizedAsset.relativePath}.`,
    );
  }
  const files: InventoryFile[] = [];
  for (const pending of pendingFiles) {
    const maximumByteLength = pending.expectedSha256 === undefined
      ? FRONTEND_PACKAGE_LIMITS.maximumFileBytes
      : pending.byteLength;
    const bytes = await readStableRegularFile(
      pending.absolutePath,
      pending.byteLength,
      maximumByteLength,
    );
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (
      pending.expectedSha256 !== undefined &&
      sha256 !== pending.expectedSha256
    ) {
      throw new FrontendPackageIntegrityError(
        "manifest_asset_mismatch",
        `Pinned frontend asset bytes do not match ${pending.relativePath}.`,
      );
    }
    files.push({
      absolutePath: pending.absolutePath,
      byteLength: bytes.byteLength,
      relativePath: pending.relativePath,
      sha256,
    });
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return {
    directories: directories.sort((left, right) => left.localeCompare(right)),
    entryPath: DEFAULT_ENTRY_PATH,
    files,
    referencedAssets: [],
    rootDirectory,
  };
}

async function walkDirectory(
  rootDirectory: string,
  relativeDirectory: string,
  directories: string[],
  files: PendingInventoryFile[],
  counters: { directories: number; totalBytes: number },
  options: {
    readonly rejectManifest: boolean;
    readonly requiredOversizedAsset?: RequiredOversizedFrontendAsset;
  },
): Promise<void> {
  const absoluteDirectory = filesystemPath(rootDirectory, relativeDirectory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relativePath = validateAssetPath(
      relativeDirectory.length === 0
        ? entry.name
        : `${relativeDirectory}/${entry.name}`,
      "frontend file",
    );
    if (Buffer.byteLength(relativePath) > FRONTEND_PACKAGE_LIMITS.maximumPathBytes) {
      throw resourceLimit(
        `Frontend path exceeds ${FRONTEND_PACKAGE_LIMITS.maximumPathBytes} bytes: ${relativePath}.`,
      );
    }
    if (
      options.rejectManifest &&
      relativePath === NATIVE_ASSET_MANIFEST
    ) {
      throw new FrontendPackageIntegrityError(
        "reserved_asset_path",
        `Source frontend cannot contain reserved ${NATIVE_ASSET_MANIFEST}.`,
      );
    }
    const absolutePath = filesystemPath(rootDirectory, relativePath);
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      throw new FrontendPackageIntegrityError(
        "invalid_file_type",
        `Frontend tree contains symlink ${relativePath}.`,
      );
    }
    if (stat.isDirectory()) {
      const depth = relativePath.split("/").length;
      if (depth > FRONTEND_PACKAGE_LIMITS.maximumDirectoryDepth) {
        throw resourceLimit(
          `Frontend directory depth exceeds ${FRONTEND_PACKAGE_LIMITS.maximumDirectoryDepth}: ${relativePath}.`,
        );
      }
      counters.directories += 1;
      if (counters.directories > FRONTEND_PACKAGE_LIMITS.maximumFileCount) {
        throw resourceLimit("Frontend contains too many directories.");
      }
      directories.push(relativePath);
      await walkDirectory(
        rootDirectory,
        relativePath,
        directories,
        files,
        counters,
        options,
      );
      continue;
    }
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new FrontendPackageIntegrityError(
        "invalid_file_type",
        `Frontend tree contains non-exclusive regular file ${relativePath}.`,
      );
    }
    const requiredOversizedAsset = options.requiredOversizedAsset;
    const isRequiredOversizedAsset =
      requiredOversizedAsset?.relativePath === relativePath;
    if (
      isRequiredOversizedAsset &&
      stat.size !== requiredOversizedAsset.byteLength
    ) {
      throw new FrontendPackageIntegrityError(
        "manifest_asset_mismatch",
        `Required oversized frontend asset size does not match ${relativePath}.`,
      );
    }
    if (
      stat.size > FRONTEND_PACKAGE_LIMITS.maximumFileBytes &&
      !isRequiredOversizedAsset
    ) {
      throw resourceLimit(
        `Frontend file exceeds ${FRONTEND_PACKAGE_LIMITS.maximumFileBytes} bytes: ${relativePath}.`,
      );
    }
    if (files.length >= FRONTEND_PACKAGE_LIMITS.maximumFileCount) {
      throw resourceLimit(
        `Frontend contains more than ${FRONTEND_PACKAGE_LIMITS.maximumFileCount} files.`,
      );
    }
    counters.totalBytes += stat.size;
    if (counters.totalBytes > FRONTEND_PACKAGE_LIMITS.maximumTotalBytes) {
      throw resourceLimit(
        `Frontend exceeds ${FRONTEND_PACKAGE_LIMITS.maximumTotalBytes} total bytes.`,
      );
    }
    files.push({
      absolutePath,
      byteLength: stat.size,
      ...(isRequiredOversizedAsset
        ? { expectedSha256: requiredOversizedAsset.sha256 }
        : {}),
      relativePath,
    });
  }
}

function validateRequiredOversizedAsset(
  asset: RequiredOversizedFrontendAsset,
): RequiredOversizedFrontendAsset {
  const relativePath = validateAssetPath(
    asset.relativePath,
    "required oversized frontend asset",
  );
  if (
    relativePath === NATIVE_ASSET_MANIFEST ||
    relativePath === VITE_ASSET_MANIFEST
  ) {
    throw new FrontendPackageIntegrityError(
      "reserved_asset_path",
      `Required oversized frontend asset cannot use reserved path ${relativePath}.`,
    );
  }
  if (
    !Number.isSafeInteger(asset.byteLength) ||
    asset.byteLength <= FRONTEND_PACKAGE_LIMITS.maximumFileBytes ||
    asset.byteLength > FRONTEND_PACKAGE_LIMITS.maximumTotalBytes
  ) {
    throw resourceLimit(
      "Required oversized frontend asset byte length is outside the checked package bounds.",
    );
  }
  if (!/^[0-9a-f]{64}$/u.test(asset.sha256)) {
    throw new FrontendPackageIntegrityError(
      "manifest_asset_mismatch",
      "Required oversized frontend asset SHA-256 is not canonical.",
    );
  }
  return Object.freeze({
    byteLength: asset.byteLength,
    relativePath,
    sha256: asset.sha256,
  });
}

export async function readStableRegularFile(
  absolutePath: string,
  expectedByteLength?: number,
  maximumByteLength = FRONTEND_PACKAGE_LIMITS.maximumFileBytes,
  afterFirstChunk?: () => Promise<void> | void,
): Promise<Buffer> {
  const before = await lstat(absolutePath);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw new FrontendPackageIntegrityError(
      "invalid_file_type",
      `Frontend asset is not a regular file: ${absolutePath}`,
    );
  }
  if (
    before.size > maximumByteLength ||
    (expectedByteLength !== undefined && before.size !== expectedByteLength)
  ) {
    throw new FrontendPackageIntegrityError(
      "file_changed_during_read",
      `Frontend asset size changed before it could be read: ${absolutePath}`,
    );
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(absolutePath, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.mode !== before.mode ||
      opened.size !== before.size ||
      opened.mtimeMs !== before.mtimeMs ||
      opened.ctimeMs !== before.ctimeMs ||
      !Number.isSafeInteger(opened.size) ||
      opened.size < 0 ||
      opened.size > maximumByteLength ||
      (expectedByteLength !== undefined && opened.size !== expectedByteLength)
    ) {
      throw new FrontendPackageIntegrityError(
        "file_changed_during_read",
        `Frontend asset changed before it could be read: ${absolutePath}`,
      );
    }
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    let observedFirstChunk = false;
    while (offset < bytes.byteLength) {
      const result = await handle.read(
        bytes,
        offset,
        Math.min(64 * 1_024, bytes.byteLength - offset),
        offset,
      );
      if (result.bytesRead <= 0) {
        throw new FrontendPackageIntegrityError(
          "file_changed_during_read",
          `Frontend asset changed while it was read: ${absolutePath}`,
        );
      }
      offset += result.bytesRead;
      if (!observedFirstChunk) {
        observedFirstChunk = true;
        await afterFirstChunk?.();
      }
    }
    const eofProbe = Buffer.allocUnsafe(1);
    const extra = await handle.read(eofProbe, 0, 1, offset);
    if (extra.bytesRead !== 0) {
      throw new FrontendPackageIntegrityError(
        "file_changed_during_read",
        `Frontend asset changed while it was read: ${absolutePath}`,
      );
    }
    const closedOver = await handle.stat();
    const after = await lstat(absolutePath);
    if (
      !closedOver.isFile() ||
      closedOver.nlink !== 1 ||
      closedOver.dev !== opened.dev ||
      closedOver.ino !== opened.ino ||
      closedOver.mode !== opened.mode ||
      closedOver.size !== opened.size ||
      closedOver.mtimeMs !== opened.mtimeMs ||
      closedOver.ctimeMs !== opened.ctimeMs ||
      after.isSymbolicLink() ||
      !after.isFile() ||
      after.nlink !== 1 ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.mode !== opened.mode ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      bytes.byteLength > maximumByteLength ||
      after.size !== bytes.byteLength ||
      (expectedByteLength !== undefined && bytes.byteLength !== expectedByteLength)
    ) {
      throw new FrontendPackageIntegrityError(
        "file_changed_during_read",
        `Frontend asset changed while it was read: ${absolutePath}`,
      );
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function validateEntryAndReferences(
  inventory: InternalInventory,
  entryPath: string,
): Promise<readonly string[]> {
  const byPath = new Map(
    inventory.files.map((file) => [file.relativePath, file] as const),
  );
  const entry = byPath.get(entryPath);
  if (entry === undefined) {
    throw new FrontendPackageIntegrityError(
      "missing_entry",
      `Frontend is missing required entry ${entryPath}.`,
    );
  }
  const html = (await readStableRegularFile(entry.absolutePath)).toString("utf8");
  if (html.trim().length === 0) {
    throw new FrontendPackageIntegrityError(
      "invalid_entry",
      `Frontend entry ${entryPath} is blank.`,
    );
  }
  const references = extractEntryAssetReferences(html, entryPath);
  for (const reference of references) {
    if (!byPath.has(reference)) {
      throw new FrontendPackageIntegrityError(
        "missing_asset",
        `Frontend entry ${entryPath} references missing asset ${reference}.`,
      );
    }
  }
  return references;
}

function extractEntryAssetReferences(
  html: string,
  entryPath: string,
): readonly string[] {
  const references = new Set<string>();
  for (const tagMatch of html.matchAll(FILE_REFERENCE_TAG)) {
    const tag = tagMatch[0];
    const tagName = tagMatch[1]?.toLowerCase();
    if (tagName === undefined) continue;
    const attributes = new Map<string, string>();
    for (const attribute of tag.matchAll(HTML_ATTRIBUTE)) {
      const name = attribute[1]?.toLowerCase();
      const value = attribute[2] ?? attribute[3] ?? attribute[4];
      if (name !== undefined && value !== undefined) attributes.set(name, value);
    }
    const names = tagName === "video"
      ? ["src", "poster"]
      : tagName === "source"
        ? ["src", "srcset"]
        : tagName === "link"
          ? ["href"]
          : ["src"];
    for (const name of names) {
      const value = attributes.get(name);
      if (value === undefined) continue;
      const candidates = name === "srcset"
        ? value.split(",").map((part) => part.trim().split(/\s+/u)[0] ?? "")
        : [value];
      for (const candidate of candidates) {
        const resolved = resolveEntryReference(candidate, entryPath, tagName);
        if (resolved !== null) references.add(resolved);
      }
    }
  }
  return [...references].sort((left, right) => left.localeCompare(right));
}

function resolveEntryReference(
  value: string,
  entryPath: string,
  tagName: string,
): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return null;
  if (trimmed.startsWith("//") || /^[a-z][a-z0-9+.-]*:/iu.test(trimmed)) {
    if (tagName === "script" || tagName === "link") {
      throw new FrontendPackageIntegrityError(
        "non_local_executable_asset",
        `Packaged ${tagName} asset must be local: ${trimmed}`,
      );
    }
    return null;
  }
  const withoutQuery = trimmed.split(/[?#]/u, 1)[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    throw new FrontendPackageIntegrityError(
      "invalid_asset_path",
      `Frontend entry contains malformed asset URL ${trimmed}.`,
    );
  }
  if (decoded.includes("\\") || decoded.includes("\0")) {
    throw new FrontendPackageIntegrityError(
      "invalid_asset_path",
      `Frontend entry contains unsafe asset URL ${trimmed}.`,
    );
  }
  const baseDirectory = posix.dirname(entryPath);
  const joined = decoded.startsWith("/")
    ? decoded.slice(1)
    : posix.join(baseDirectory === "." ? "" : baseDirectory, decoded);
  return validateAssetPath(posix.normalize(joined), "frontend reference");
}

function validateAssetPath(value: string, label: string): string {
  if (
    value.length === 0 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value === "." ||
    value === ".." ||
    value.startsWith("../") ||
    value.includes("/../") ||
    value.includes("/./") ||
    value.includes("//") ||
    posix.normalize(value) !== value
  ) {
    throw new FrontendPackageIntegrityError(
      "invalid_asset_path",
      `Invalid ${label} path: ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

function requireExactPaths(
  label: string,
  left: readonly string[],
  right: readonly string[],
): void {
  const sortedLeft = [...left].sort((a, b) => a.localeCompare(b));
  const sortedRight = [...right].sort((a, b) => a.localeCompare(b));
  if (
    sortedLeft.length !== sortedRight.length ||
    sortedLeft.some((value, index) => value !== sortedRight[index])
  ) {
    throw new FrontendPackageIntegrityError(
      "file_set_mismatch",
      `${label} file sets differ.`,
    );
  }
}

function parentDirectories(paths: readonly string[]): readonly string[] {
  const directories = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/");
    segments.pop();
    let directory = "";
    for (const segment of segments) {
      directory = directory.length === 0 ? segment : `${directory}/${segment}`;
      directories.add(directory);
    }
  }
  return [...directories].sort((left, right) => left.localeCompare(right));
}

function publicInventory(
  inventory: InternalInventory,
  entryPath: string,
  referencedAssets: readonly string[],
): FrontendAssetInventory {
  return {
    entryPath,
    files: inventory.files.map(({ byteLength, relativePath, sha256 }) => ({
      byteLength,
      relativePath,
      sha256,
    })),
    referencedAssets,
    rootDirectory: inventory.rootDirectory,
  };
}

function filesystemPath(rootDirectory: string, relativePath: string): string {
  if (relativePath.length === 0) return rootDirectory;
  return `${rootDirectory}${sep}${relativePath.split("/").join(sep)}`;
}

function invalidManifest(message: string): FrontendPackageIntegrityError {
  return new FrontendPackageIntegrityError("invalid_manifest", message);
}

function resourceLimit(message: string): FrontendPackageIntegrityError {
  return new FrontendPackageIntegrityError("resource_limit", message);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function parseCliArguments(argv: readonly string[]): {
  readonly manifestSourceDirectory: string;
  readonly packageDirectory: string;
  readonly sourceDirectory?: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      !["--source", "--package", "--manifest-source"].includes(key) ||
      values.has(key)
    ) {
      throw new Error(
        "Usage: frontend-package-integrity.ts [--source <dir>] --package <dir> [--manifest-source <relative-dir>]",
      );
    }
    values.set(key, value);
  }
  const packageDirectory = values.get("--package");
  if (packageDirectory === undefined) {
    throw new Error("--package is required.");
  }
  const sourceDirectory = values.get("--source");
  return {
    manifestSourceDirectory: values.get("--manifest-source") ?? DEFAULT_MANIFEST_SOURCE_DIRECTORY,
    packageDirectory,
    ...(sourceDirectory === undefined ? {} : { sourceDirectory }),
  };
}

if (import.meta.main) {
  await verifyPackagedFrontend(parseCliArguments(process.argv.slice(2)));
  process.stdout.write("HRA packaged frontend integrity verified.\n");
}
