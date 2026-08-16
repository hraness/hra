import { z } from "@hra-internal/schema";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

export const RELEASE_SCHEMA_VERSION = 1 as const;
export const RELEASE_PRODUCT = "taskctl" as const;
export const PINNED_BUN_VERSION = "1.3.14" as const;
export const RELEASE_MANIFEST_FILE = "taskctl-manifest.json" as const;
export const RELEASE_CHECKSUM_FILE = "SHA256SUMS" as const;
export const RELEASE_INSTALLER_FILE = "install-taskctl.sh" as const;
export const MAX_RELEASE_FILE_BYTES = 512 * 1_024 * 1_024;

export const releaseTargets = [
  {
    platform: "darwin",
    arch: "arm64",
    libc: null,
    bunTarget: "bun-darwin-arm64",
    artifactSuffix: "darwin-arm64",
  },
  {
    platform: "darwin",
    arch: "x64",
    libc: null,
    bunTarget: "bun-darwin-x64",
    artifactSuffix: "darwin-x64",
  },
  {
    platform: "linux",
    arch: "arm64",
    libc: "glibc",
    bunTarget: "bun-linux-arm64",
    artifactSuffix: "linux-arm64-glibc",
  },
  {
    platform: "linux",
    arch: "x64",
    libc: "glibc",
    bunTarget: "bun-linux-x64-baseline",
    artifactSuffix: "linux-x64-glibc-baseline",
  },
] as const;

export type ReleaseTarget = (typeof releaseTargets)[number];

const versionSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u, "invalid SHA-256 digest");
const safeFilenameSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, "invalid release filename");
const byteLengthSchema = z.number().int().positive().max(MAX_RELEASE_FILE_BYTES);

export function artifactFilename(version: string, target: ReleaseTarget): string {
  const parsedVersion = versionSchema.parse(version);
  return safeFilenameSchema.parse(`taskctl-v${parsedVersion}-${target.artifactSuffix}`);
}

const artifactManifestSchema = z
  .object({
    platform: z.enum(["darwin", "linux"]),
    arch: z.enum(["arm64", "x64"]),
    libc: z.enum(["glibc"]).nullable(),
    bunTarget: z.enum([
      "bun-darwin-arm64",
      "bun-darwin-x64",
      "bun-linux-arm64",
      "bun-linux-x64-baseline",
    ]),
    file: safeFilenameSchema,
    bytes: byteLengthSchema,
    sha256: sha256Schema,
  })
  .strict();

const installerManifestSchema = z
  .object({
    file: z.literal(RELEASE_INSTALLER_FILE),
  })
  .strict();

const checksumManifestSchema = z
  .object({ algorithm: z.literal("sha256"), file: z.literal(RELEASE_CHECKSUM_FILE) })
  .strict();

export const releaseManifestSchema = z
  .object({
    schemaVersion: z.literal(RELEASE_SCHEMA_VERSION),
    product: z.literal(RELEASE_PRODUCT),
    version: versionSchema,
    bunVersion: z.literal(PINNED_BUN_VERSION),
    artifacts: z.array(artifactManifestSchema).length(releaseTargets.length),
    installer: installerManifestSchema,
    checksum: checksumManifestSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    for (const [index, target] of releaseTargets.entries()) {
      const artifact = manifest.artifacts[index];
      if (
        artifact === undefined ||
        artifact.platform !== target.platform ||
        artifact.arch !== target.arch ||
        artifact.libc !== target.libc ||
        artifact.bunTarget !== target.bunTarget ||
        artifact.file !== artifactFilename(manifest.version, target)
      ) {
        context.addIssue({
          code: "custom",
          message: `artifact ${index} does not match the pinned release target`,
          path: ["artifacts", index],
        });
      }
    }
  });

export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

export function releaseTargetForRuntime(
  platform: string,
  arch: string,
  libc: "glibc" | "musl" | null,
): ReleaseTarget | null {
  return (
    releaseTargets.find(
      (target) =>
        target.platform === platform &&
        target.arch === arch &&
        (target.platform === "darwin" ? libc === null : libc === target.libc),
    ) ?? null
  );
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface VerifiedReleaseFile {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

async function verifiedRegularFile(
  releaseDirectory: string,
  file: string,
): Promise<VerifiedReleaseFile> {
  const bytes = await readBoundedRegularFile(releaseDirectory, file, MAX_RELEASE_FILE_BYTES);
  return { file, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

async function readBoundedRegularFile(
  releaseDirectory: string,
  file: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  safeFilenameSchema.parse(file);
  const path = resolve(releaseDirectory, file);
  if (dirname(path) !== releaseDirectory) throw new Error(`release file escapes directory: ${file}`);
  const pathMetadata = await lstat(path);
  if (
    pathMetadata.isSymbolicLink() ||
    !pathMetadata.isFile() ||
    pathMetadata.size <= 0 ||
    pathMetadata.size > maximumBytes
  ) {
    throw new Error(`release file has an invalid size or type: ${file}`);
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`release file must not be a symbolic link: ${file}`);
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > maximumBytes) {
      throw new Error(`release file has an invalid size or type: ${file}`);
    }
    const expectedBytes = Number(metadata.size);
    const bytes = new Uint8Array(expectedBytes);
    let offset = 0;
    while (offset < expectedBytes) {
      const result = await handle.read(bytes, offset, expectedBytes - offset, offset);
      if (result.bytesRead === 0) throw new Error(`release file changed while reading: ${file}`);
      offset += result.bytesRead;
    }
    const overflowProbe = new Uint8Array(1);
    if ((await handle.read(overflowProbe, 0, 1, expectedBytes)).bytesRead !== 0) {
      throw new Error(`release file grew while reading: ${file}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

export function parseChecksumFile(source: string): ReadonlyMap<string, string> {
  if (source.length === 0 || !source.endsWith("\n")) {
    throw new Error("checksum file must be nonempty and newline-terminated");
  }
  const entries = new Map<string, string>();
  for (const line of source.slice(0, -1).split("\n")) {
    const match = /^([0-9a-f]{64}) {2}([A-Za-z0-9][A-Za-z0-9._-]*)$/u.exec(line);
    if (match === null) throw new Error("checksum file contains an invalid line");
    const digest = match[1];
    const file = match[2];
    if (digest === undefined || file === undefined || entries.has(file)) {
      throw new Error("checksum file contains a duplicate or incomplete entry");
    }
    entries.set(file, digest);
  }
  return entries;
}

export async function verifyReleaseDirectory(releaseDirectoryInput: string): Promise<ReleaseManifest> {
  const releaseDirectory = resolve(releaseDirectoryInput);
  const directoryMetadata = await lstat(releaseDirectory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new Error("release directory must be a real directory");
  }
  if ((await realpath(releaseDirectory)) !== releaseDirectory) {
    throw new Error("release directory must be a normalized physical path without symbolic-link ancestors");
  }
  const manifestSource = decodeUtf8(
    await readBoundedRegularFile(releaseDirectory, RELEASE_MANIFEST_FILE, 64 * 1_024),
    "release manifest",
  );
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestSource);
  } catch {
    throw new Error("release manifest is not valid JSON");
  }
  const manifest = releaseManifestSchema.parse(manifestValue);
  const expectedFiles = [
    ...manifest.artifacts.map((artifact) => artifact.file),
    manifest.installer.file,
    RELEASE_MANIFEST_FILE,
  ].sort();
  const checksumSource = decodeUtf8(
    await readBoundedRegularFile(releaseDirectory, RELEASE_CHECKSUM_FILE, 64 * 1_024),
    "release checksum file",
  );
  const checksums = parseChecksumFile(checksumSource);
  if (
    checksums.size !== expectedFiles.length ||
    expectedFiles.some((file) => !checksums.has(file))
  ) {
    throw new Error("checksum file does not name the exact release file set");
  }

  const declaredByFile = new Map<string, { readonly bytes: number; readonly sha256: string }>(
    manifest.artifacts.map((artifact) => [artifact.file, artifact] as const),
  );
  for (const file of expectedFiles) {
    const verified = await verifiedRegularFile(releaseDirectory, file);
    if (checksums.get(file) !== verified.sha256) {
      throw new Error(`checksum mismatch for ${file}`);
    }
    const declared = declaredByFile.get(file);
    if (
      declared !== undefined &&
      (declared.sha256 !== verified.sha256 || declared.bytes !== verified.bytes)
    ) {
      throw new Error(`manifest metadata mismatch for ${file}`);
    }
  }

  const actualFiles = (await readdir(releaseDirectory)).sort();
  const allowedFiles = [...expectedFiles, RELEASE_CHECKSUM_FILE].sort();
  if (
    actualFiles.length !== allowedFiles.length ||
    actualFiles.some((file, index) => file !== allowedFiles[index])
  ) {
    throw new Error("release directory contains an unexpected or missing file");
  }
  return manifest;
}

export interface InstallDestination {
  readonly destination: string;
  readonly parent: string;
  readonly replace: boolean;
}

export async function validateInstallDestination(
  destinationInput: string,
  replace: boolean,
): Promise<InstallDestination> {
  if (!isAbsolute(destinationInput) || resolve(destinationInput) !== destinationInput) {
    throw new Error("install destination must be a normalized absolute path");
  }
  if (basename(destinationInput) === "." || basename(destinationInput) === "..") {
    throw new Error("install destination must name a file");
  }
  const parent = dirname(destinationInput);
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error("install destination parent must be a real directory");
  }
  if ((await realpath(parent)) !== parent) {
    throw new Error("install destination parent must not traverse symbolic links");
  }
  try {
    const destinationMetadata = await lstat(destinationInput);
    if (destinationMetadata.isSymbolicLink() || !destinationMetadata.isFile()) {
      throw new Error("existing install destination must be a regular file");
    }
    if (!replace) throw new Error("install destination exists; pass --replace explicitly");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { destination: destinationInput, parent, replace };
}
