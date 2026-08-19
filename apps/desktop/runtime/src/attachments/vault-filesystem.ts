import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rmdir,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { ChatMessageAttachmentId } from "../../../contracts/runtime";
import {
  CHAT_ATTACHMENT_MAX_CHUNK_BYTES,
  CHAT_ATTACHMENT_MAX_INPUT_BYTES,
  CHAT_ATTACHMENT_PREVIEW_MAX_BYTES,
  ChatAttachmentVaultError,
} from "./contracts";
import type { NativeImageNormalizerReceipt } from "./normalizer";

const normalizerResiduePattern =
  /^\.hra-image-normalizer-[0-9a-f]{32}\.tmp$/u;
const noFollow = constants.O_NOFOLLOW ?? 0;
const directoryFlag = constants.O_DIRECTORY ?? 0;

export interface VerifiedVaultFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface AttachmentVaultFileSystemOptions {
  readonly afterVerifiedUploadDigest?: () => Promise<void>;
}

export class AttachmentVaultFileSystem {
  readonly root: string;
  readonly objectsRoot: string;
  readonly #afterVerifiedUploadDigest: () => Promise<void>;

  constructor(root: string, options: AttachmentVaultFileSystemOptions = {}) {
    if (!isAbsolute(root) || resolve(root) !== root) {
      throw unsafe("Attachment vault root must be a normalized absolute path.");
    }
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (realpathSync(root) !== root) {
      throw unsafe("Attachment vault root cannot traverse a symbolic link.");
    }
    const rootIdentity = lstatSync(root);
    if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) {
      throw unsafe("Attachment vault root is not a private directory.");
    }
    chmodSync(root, 0o700);
    assertPrivateDirectorySync(root);
    this.root = root;
    this.objectsRoot = join(root, "objects");
    try {
      mkdirSync(this.objectsRoot, { mode: 0o700 });
    } catch (error: unknown) {
      if (!isErrno(error, "EEXIST")) throw error;
      const identity = lstatSync(this.objectsRoot);
      if (!identity.isDirectory() || identity.isSymbolicLink()) {
        throw unsafe("Attachment object root is not a private directory.");
      }
    }
    chmodSync(this.objectsRoot, 0o700);
    assertPrivateDirectorySync(this.objectsRoot);
    this.#afterVerifiedUploadDigest = options.afterVerifiedUploadDigest ??
      (() => Promise.resolve());
  }

  objectDirectory(attachmentId: ChatMessageAttachmentId): string {
    return this.#inside(join(this.objectsRoot, attachmentId));
  }

  uploadPath(attachmentId: ChatMessageAttachmentId): string {
    return join(this.objectDirectory(attachmentId), "source.upload");
  }

  imageGenerationPath(attachmentId: ChatMessageAttachmentId): string {
    return join(this.objectDirectory(attachmentId), "normalized");
  }

  genericPath(attachmentId: ChatMessageAttachmentId, suffix: string): string {
    if (!/^[a-z0-9]{1,16}$/u.test(suffix)) {
      throw unsafe("Attachment internal suffix is invalid.");
    }
    return join(this.objectDirectory(attachmentId), `blob.${suffix}`);
  }

  async createUploadObject(attachmentId: ChatMessageAttachmentId): Promise<void> {
    await this.assertRoots();
    const objectDirectory = this.objectDirectory(attachmentId);
    try {
      await mkdir(objectDirectory, { mode: 0o700 });
    } catch (error: unknown) {
      if (!isErrno(error, "EEXIST")) throw error;
      await assertPrivateDirectory(objectDirectory);
    }
    await assertPrivateDirectory(objectDirectory);
    const upload = this.uploadPath(attachmentId);
    try {
      const handle = await open(
        upload,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
        0o600,
      );
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error: unknown) {
      if (!isErrno(error, "EEXIST")) throw error;
      await this.verifyFile(upload, 0, createHash("sha256").digest("hex"), 0);
    }
    await fsyncDirectory(objectDirectory);
    await fsyncDirectory(this.objectsRoot);
  }

  async appendChunk(
    attachmentId: ChatMessageAttachmentId,
    expectedOffset: number,
    bytes: Uint8Array,
  ): Promise<void> {
    if (bytes.byteLength < 1 || bytes.byteLength > CHAT_ATTACHMENT_MAX_CHUNK_BYTES) {
      throw unsafe("Attachment chunk exceeds the filesystem boundary.");
    }
    const objectDirectory = this.objectDirectory(attachmentId);
    await assertPrivateDirectory(objectDirectory);
    const path = this.uploadPath(attachmentId);
    const handle = await open(path, constants.O_WRONLY | noFollow);
    try {
      const before = await handle.stat();
      assertPrivateRegularStat(before, expectedOffset);
      let written = 0;
      while (written < bytes.byteLength) {
        const result = await handle.write(
          bytes,
          written,
          bytes.byteLength - written,
          expectedOffset + written,
        );
        if (result.bytesWritten <= 0) {
          throw unsafe("Attachment chunk write made no progress.");
        }
        written += result.bytesWritten;
      }
      await handle.sync();
      const after = await handle.stat();
      assertStableIdentity(before, after);
      assertPrivateRegularStat(after, expectedOffset + bytes.byteLength);
    } finally {
      await handle.close();
    }
    await fsyncDirectory(objectDirectory);
  }

  async verifyRange(
    attachmentId: ChatMessageAttachmentId,
    offset: number,
    expectedBytes: number,
    expectedSha256: string,
  ): Promise<boolean> {
    const path = this.uploadPath(attachmentId);
    const handle = await open(path, constants.O_RDONLY | noFollow);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size < offset + expectedBytes) {
        return false;
      }
      const buffer = Buffer.alloc(expectedBytes);
      let read = 0;
      while (read < buffer.byteLength) {
        const result = await handle.read(
          buffer,
          read,
          buffer.byteLength - read,
          offset + read,
        );
        if (result.bytesRead <= 0) return false;
        read += result.bytesRead;
      }
      const after = await handle.stat();
      assertStableIdentity(before, after);
      return createHash("sha256").update(buffer).digest("hex") === expectedSha256;
    } finally {
      await handle.close();
    }
  }

  async uploadSize(attachmentId: ChatMessageAttachmentId): Promise<number> {
    const stat = await optionalSafeRegularStat(this.uploadPath(attachmentId));
    if (stat === null) throw unsafe("Attachment upload file is missing.");
    if (stat.size > CHAT_ATTACHMENT_MAX_INPUT_BYTES) {
      throw unsafe("Attachment upload file exceeds its limit.");
    }
    return Number(stat.size);
  }

  async verifyUpload(
    attachmentId: ChatMessageAttachmentId,
    expectedBytes: number,
    expectedSha256: string,
  ): Promise<VerifiedVaultFile> {
    return await this.verifyFile(
      this.uploadPath(attachmentId),
      expectedBytes,
      expectedSha256,
      CHAT_ATTACHMENT_MAX_INPUT_BYTES,
    );
  }

  async publishGeneric(
    attachmentId: ChatMessageAttachmentId,
    suffix: string,
    expectedBytes: number,
    expectedSha256: string,
  ): Promise<VerifiedVaultFile> {
    const objectDirectory = this.objectDirectory(attachmentId);
    await assertPrivateDirectory(objectDirectory);
    const upload = this.uploadPath(attachmentId);
    const published = this.genericPath(attachmentId, suffix);
    const uploadStat = await optionalSafeRegularStat(upload, true);
    const publishedStat = await optionalSafeRegularStat(published, true);
    if (publishedStat === null) {
      if (uploadStat === null) {
        throw unsafe("Generic attachment publication has no source or final file.");
      }
      if (uploadStat.nlink !== 1) {
        throw unsafe("Unpublished generic attachment has an unexpected hard link.");
      }
      try {
        await link(upload, published);
      } catch (error: unknown) {
        if (!isErrno(error, "EEXIST")) throw error;
      }
      await fsyncDirectory(objectDirectory);
    }
    const finalAfterLink = await optionalSafeRegularStat(published, true);
    if (finalAfterLink === null) {
      throw unsafe("Generic attachment publication did not create a final file.");
    }
    const currentUpload = await optionalSafeRegularStat(upload, true);
    if (currentUpload !== null) {
      if (
        currentUpload.dev !== finalAfterLink.dev ||
        currentUpload.ino !== finalAfterLink.ino ||
        currentUpload.nlink !== 2 ||
        finalAfterLink.nlink !== 2
      ) {
        throw unsafe("Generic attachment publication identities conflict.");
      }
      await unlink(upload);
      await fsyncDirectory(objectDirectory);
    } else if (finalAfterLink.nlink !== 1) {
      throw unsafe("Published generic attachment has an unexpected hard link.");
    }
    return await this.verifyFile(
      published,
      expectedBytes,
      expectedSha256,
      CHAT_ATTACHMENT_MAX_INPUT_BYTES,
    );
  }

  async verifyGeneric(
    attachmentId: ChatMessageAttachmentId,
    suffix: string,
    expectedBytes: number,
    expectedSha256: string,
  ): Promise<VerifiedVaultFile> {
    return await this.verifyFile(
      this.genericPath(attachmentId, suffix),
      expectedBytes,
      expectedSha256,
      CHAT_ATTACHMENT_MAX_INPUT_BYTES,
    );
  }

  async verifyImageGeneration(
    attachmentId: ChatMessageAttachmentId,
    receipt: NativeImageNormalizerReceipt,
  ): Promise<Readonly<{
    canonical: VerifiedVaultFile;
    preview: VerifiedVaultFile;
  }>> {
    const generation = this.imageGenerationPath(attachmentId);
    await assertPrivateDirectory(generation);
    const entries = (await readdir(generation)).sort();
    if (entries.length !== 2 || entries[0] !== "canonical.png" || entries[1] !== "preview.png") {
      throw unsafe("Normalized image generation has an unexpected inventory.");
    }
    const canonical = await this.verifyFile(
      join(generation, "canonical.png"),
      receipt.canonical.bytes,
      receipt.canonical.sha256,
      64 * 1024 * 1024,
    );
    const preview = await this.verifyFile(
      join(generation, "preview.png"),
      receipt.preview.bytes,
      receipt.preview.sha256,
      CHAT_ATTACHMENT_PREVIEW_MAX_BYTES,
    );
    return { canonical, preview };
  }

  async verifyImageCanonical(
    attachmentId: ChatMessageAttachmentId,
    expectedBytes: number,
    expectedSha256: string,
  ): Promise<VerifiedVaultFile> {
    return await this.verifyFile(
      join(this.imageGenerationPath(attachmentId), "canonical.png"),
      expectedBytes,
      expectedSha256,
      64 * 1024 * 1024,
    );
  }

  async readImagePreview(
    attachmentId: ChatMessageAttachmentId,
    expectedBytes: number,
    expectedSha256: string,
  ): Promise<Uint8Array> {
    const path = join(this.imageGenerationPath(attachmentId), "preview.png");
    const verified = await this.verifyFile(
      path,
      expectedBytes,
      expectedSha256,
      CHAT_ATTACHMENT_PREVIEW_MAX_BYTES,
    );
    const handle = await open(verified.path, constants.O_RDONLY | noFollow);
    try {
      const before = await handle.stat();
      assertPrivateRegularStat(before, expectedBytes);
      const bytes = Buffer.alloc(expectedBytes);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (result.bytesRead <= 0) throw unsafe("Attachment preview was truncated.");
        offset += result.bytesRead;
      }
      const after = await handle.stat();
      assertStableIdentity(before, after);
      assertPrivateRegularStat(after, expectedBytes);
      if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
        throw unsafe("Attachment preview changed during its read.");
      }
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async removeVerifiedUploadIfPresent(
    attachmentId: ChatMessageAttachmentId,
    expectedBytes: number,
    expectedSha256: string,
  ): Promise<boolean> {
    const path = this.uploadPath(attachmentId);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, constants.O_RDONLY | noFollow);
    } catch (error: unknown) {
      if (isErrno(error, "ENOENT")) return false;
      throw error;
    }
    try {
      const before = await handle.stat();
      assertPrivateRegularStat(before, expectedBytes);
      if (before.size > CHAT_ATTACHMENT_MAX_INPUT_BYTES) {
        throw unsafe("Attachment source exceeds its deletion boundary.");
      }
      const hasher = createHash("sha256");
      const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, before.size)));
      let offset = 0;
      while (offset < before.size) {
        const result = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, before.size - offset),
          offset,
        );
        if (result.bytesRead <= 0) throw unsafe("Attachment source was truncated.");
        hasher.update(buffer.subarray(0, result.bytesRead));
        offset += result.bytesRead;
      }
      const verified = await handle.stat();
      assertStableIdentity(before, verified);
      assertPrivateRegularStat(verified, expectedBytes);
      if (hasher.digest("hex") !== expectedSha256) {
        throw unsafe("Attachment source digest does not match custody.");
      }
      await this.#afterVerifiedUploadDigest();
      const beforeUnlink = await handle.stat();
      assertStableIdentity(verified, beforeUnlink);
      assertPrivateRegularStat(beforeUnlink, expectedBytes);
      if (realpathSync(path) !== path) {
        throw unsafe("Attachment source path changed before deletion.");
      }
      await unlink(path);
      const removed = await handle.stat();
      assertStableIdentity(verified, removed);
      if (removed.nlink !== 0) {
        throw unsafe("Attachment source deletion left an unowned hard link.");
      }
    } finally {
      await handle.close();
    }
    await fsyncDirectory(this.objectDirectory(attachmentId));
    return true;
  }

  async assertUploadAbsent(attachmentId: ChatMessageAttachmentId): Promise<void> {
    if (await optionalSafeRegularStat(this.uploadPath(attachmentId), true) !== null) {
      throw unsafe("Attachment source residue is not owned by its durable state.");
    }
  }

  async removeUndocumentedImageGeneration(
    attachmentId: ChatMessageAttachmentId,
  ): Promise<void> {
    const generation = this.imageGenerationPath(attachmentId);
    if (!(await pathExists(generation))) return;
    await removeExactGeneration(generation, true);
    await fsyncDirectory(this.objectDirectory(attachmentId));
  }

  async removeNormalizerResidue(
    attachmentId: ChatMessageAttachmentId,
  ): Promise<number> {
    const objectDirectory = this.objectDirectory(attachmentId);
    if (!(await pathExists(objectDirectory))) return 0;
    await assertPrivateDirectory(objectDirectory);
    let removed = 0;
    for (const entry of await readdir(objectDirectory)) {
      if (!normalizerResiduePattern.test(entry)) continue;
      await removeExactGeneration(join(objectDirectory, entry), false);
      removed += 1;
    }
    if (removed > 0) await fsyncDirectory(objectDirectory);
    return removed;
  }

  async removeObject(
    attachmentId: ChatMessageAttachmentId,
    suffix: string,
    kind: "image" | "file",
  ): Promise<void> {
    const objectDirectory = this.objectDirectory(attachmentId);
    if (!(await pathExists(objectDirectory))) return;
    await assertPrivateDirectory(objectDirectory);
    const entries = (await readdir(objectDirectory)).sort();
    const blobName = `blob.${suffix}`;
    const allowed = kind === "image"
      ? (entry: string): boolean =>
          entry === "source.upload" || entry === "normalized" ||
          normalizerResiduePattern.test(entry)
      : (entry: string): boolean => entry === "source.upload" || entry === blobName;
    if (entries.some((entry) => !allowed(entry))) {
      throw unsafe("Attachment object contains an unowned entry.");
    }
    const source = await optionalSafeRegularStat(
      join(objectDirectory, "source.upload"),
      true,
    );
    const blob = kind === "file"
      ? await optionalSafeRegularStat(join(objectDirectory, blobName), true)
      : null;
    if (source !== null && blob !== null) {
      if (
        source.dev !== blob.dev || source.ino !== blob.ino ||
        source.nlink !== 2 || blob.nlink !== 2
      ) {
        throw unsafe("Attachment deletion found conflicting payload identities.");
      }
    } else {
      const payload = source ?? blob;
      if (payload !== null && payload.nlink !== 1) {
        throw unsafe("Attachment deletion found an external payload hard link.");
      }
    }
    for (const entry of entries) {
      if (entry === "normalized") {
        await validateExactGeneration(join(objectDirectory, entry), true);
      } else if (normalizerResiduePattern.test(entry)) {
        await validateExactGeneration(join(objectDirectory, entry), false);
      }
    }
    if (source !== null) {
      await unlinkVerifiedRegular(
        join(objectDirectory, "source.upload"),
        blob === null ? 1 : 2,
        blob === null ? 0 : 1,
      );
    }
    if (blob !== null) {
      await unlinkVerifiedRegular(join(objectDirectory, blobName), 1, 0);
    }
    for (const entry of entries) {
      if (entry === "normalized") {
        await removeExactGeneration(join(objectDirectory, entry), true);
      } else if (normalizerResiduePattern.test(entry)) {
        await removeExactGeneration(join(objectDirectory, entry), false);
      }
    }
    await rmdir(objectDirectory);
    await fsyncDirectory(this.objectsRoot);
  }

  async listObjectIds(): Promise<readonly string[]> {
    await this.assertRoots();
    const ids: string[] = [];
    for (const entry of await readdir(this.objectsRoot)) {
      const path = join(this.objectsRoot, entry);
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw unsafe("Attachment object root contains a non-directory entry.");
      }
      ids.push(entry);
    }
    return ids.sort();
  }

  async assertObjectInventory(
    attachmentId: ChatMessageAttachmentId,
    input: Readonly<{
      allowedEntries: readonly string[];
      requiredEntries?: readonly string[];
      allowGenericPublicationPair?: boolean;
      allowMissingObject?: boolean;
      allowEmpty?: boolean;
    }>,
  ): Promise<void> {
    const objectDirectory = this.objectDirectory(attachmentId);
    if (!(await pathExists(objectDirectory))) {
      if (input.allowMissingObject === true) return;
      throw unsafe("Attachment object directory is missing.");
    }
    await assertPrivateDirectory(objectDirectory);
    const allowed = new Set(input.allowedEntries);
    const required = new Set(input.requiredEntries ?? []);
    if (
      [...allowed].some((entry) =>
        entry !== "source.upload" &&
        entry !== "normalized" &&
        !/^blob\.[a-z0-9]{1,16}$/u.test(entry)
      ) ||
      [...required].some((entry) => !allowed.has(entry))
    ) {
      throw unsafe("Attachment inventory contract is invalid.");
    }
    const entries = (await readdir(objectDirectory)).sort();
    for (const entry of entries) {
      if (!allowed.has(entry)) {
        throw unsafe("Attachment object contains an unexpected entry.");
      }
      const path = join(objectDirectory, entry);
      if (entry === "normalized") {
        await assertPrivateDirectory(path);
        continue;
      }
      await optionalSafeRegularStat(path, input.allowGenericPublicationPair === true);
    }
    for (const entry of required) {
      if (!entries.includes(entry)) {
        throw unsafe("Attachment object is missing a required entry.");
      }
    }
    if (input.allowGenericPublicationPair === true) {
      const source = await optionalSafeRegularStat(
        join(objectDirectory, "source.upload"),
        true,
      );
      const blobName = entries.find((entry) => entry.startsWith("blob."));
      const blob = blobName === undefined
        ? null
        : await optionalSafeRegularStat(join(objectDirectory, blobName), true);
      if (source !== null && blob !== null && (
        source.dev !== blob.dev || source.ino !== blob.ino ||
        source.nlink !== 2 || blob.nlink !== 2
      )) {
        throw unsafe("Generic publication inventory has conflicting identities.");
      }
      if ((source === null) === (blob === null)) {
        if (source === null && input.allowEmpty !== true) {
          throw unsafe("Generic publication inventory has no owned payload.");
        }
      } else {
        const existing = source ?? blob;
        if (existing?.nlink !== 1) {
          throw unsafe("Generic publication inventory has an unexpected hard link.");
        }
      }
    }
  }

  async assertRoots(): Promise<void> {
    await assertPrivateDirectory(this.root);
    await assertPrivateDirectory(this.objectsRoot);
    if (realpathSync(this.root) !== this.root || realpathSync(this.objectsRoot) !== this.objectsRoot) {
      throw unsafe("Attachment vault root identity changed.");
    }
  }

  async verifyFile(
    path: string,
    expectedBytes: number,
    expectedSha256: string,
    maximumBytes: number,
  ): Promise<VerifiedVaultFile> {
    this.#inside(path);
    const handle = await open(path, constants.O_RDONLY | noFollow);
    try {
      const before = await handle.stat();
      assertPrivateRegularStat(before, expectedBytes);
      if (before.size > maximumBytes) throw unsafe("Attachment file exceeds its limit.");
      const hasher = createHash("sha256");
      const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, before.size)));
      let offset = 0;
      while (offset < before.size) {
        const result = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, before.size - offset),
          offset,
        );
        if (result.bytesRead <= 0) throw unsafe("Attachment file was truncated.");
        hasher.update(buffer.subarray(0, result.bytesRead));
        offset += result.bytesRead;
      }
      const after = await handle.stat();
      assertStableIdentity(before, after);
      assertPrivateRegularStat(after, expectedBytes);
      const digest = hasher.digest("hex");
      if (digest !== expectedSha256) throw unsafe("Attachment digest does not match custody.");
      const canonical = realpathSync(path);
      if (canonical !== path) throw unsafe("Attachment file path changed during access.");
      return { path: canonical, bytes: expectedBytes, sha256: digest };
    } finally {
      await handle.close();
    }
  }

  #inside(path: string): string {
    const normalized = resolve(path);
    if (normalized !== this.root && !normalized.startsWith(`${this.root}/`)) {
      throw unsafe("Attachment path escapes the vault.");
    }
    return normalized;
  }
}

async function optionalSafeRegularStat(
  path: string,
  allowMultipleLinks = false,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (!allowMultipleLinks && stat.nlink !== 1)) {
      throw unsafe("Attachment path is not a private regular file.");
    }
    return stat;
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}

async function removeExactGeneration(
  path: string,
  requireComplete: boolean,
): Promise<void> {
  const entries = await validateExactGeneration(path, requireComplete);
  for (const entry of entries) {
    await unlinkVerifiedRegular(join(path, entry), 1, 0);
  }
  await rmdir(path);
}

async function validateExactGeneration(
  path: string,
  requireComplete: boolean,
): Promise<readonly string[]> {
  await assertPrivateDirectory(path);
  const entries = (await readdir(path)).sort();
  if (
    entries.some((entry) => entry !== "canonical.png" && entry !== "preview.png") ||
    (requireComplete && (
      entries.length !== 2 || entries[0] !== "canonical.png" || entries[1] !== "preview.png"
    ))
  ) {
    throw unsafe("Image-normalizer generation contains an unowned entry.");
  }
  for (const entry of entries) {
    const child = join(path, entry);
    const stat = await optionalSafeRegularStat(child);
    if (stat === null) throw unsafe("Image-normalizer generation changed during cleanup.");
  }
  return entries;
}

async function unlinkVerifiedRegular(
  path: string,
  expectedLinksBefore: number,
  expectedLinksAfter: number,
): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== expectedLinksBefore) {
      throw unsafe("Attachment deletion file identity is unsafe.");
    }
    if (realpathSync(path) !== path) {
      throw unsafe("Attachment deletion path changed before unlink.");
    }
    await unlink(path);
    const after = await handle.stat();
    assertStableIdentity(before, after);
    if (after.nlink !== expectedLinksAfter) {
      throw unsafe("Attachment deletion left an unowned hard link.");
    }
  } finally {
    await handle.close();
  }
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw unsafe("Attachment vault directory is unsafe.");
  }
  if ((Number(stat.mode) & 0o077) !== 0) {
    throw unsafe("Attachment vault directory is not user-only.");
  }
  if (typeof process.geteuid === "function" && stat.uid !== process.geteuid()) {
    throw unsafe("Attachment vault directory has the wrong owner.");
  }
}

function assertPrivateDirectorySync(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw unsafe("Attachment vault directory is unsafe.");
  }
  if (typeof process.geteuid === "function" && stat.uid !== process.geteuid()) {
    throw unsafe("Attachment vault directory has the wrong owner.");
  }
}

function assertPrivateRegularStat(
  stat: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
  expectedBytes: number,
): void {
  if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expectedBytes) {
    throw unsafe("Attachment file identity or size is unsafe.");
  }
  if ((Number(stat.mode) & 0o077) !== 0) {
    throw unsafe("Attachment file is not user-only.");
  }
  if (typeof process.geteuid === "function" && stat.uid !== process.geteuid()) {
    throw unsafe("Attachment file has the wrong owner.");
  }
}

function assertStableIdentity(
  before: Readonly<{ dev: number; ino: number; size: number }>,
  after: Readonly<{ dev: number; ino: number; size: number }>,
): void {
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw unsafe("Attachment file identity changed during access.");
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | directoryFlag | noFollow);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function unsafe(message: string): ChatAttachmentVaultError {
  return new ChatAttachmentVaultError("unsafe_filesystem", message);
}
