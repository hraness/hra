import { createHash } from "node:crypto";
import { constants, lstatSync, realpathSync, unlinkSync } from "node:fs";
import { open, opendir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import { attachmentDigestSchema, attachmentNameSchema } from "../domain/attachment-schemas";
import {
  ATTACHMENT_IMAGE_MEDIA_TYPES,
  ATTACHMENT_MAX_BYTES,
  acceptAttachmentBytes,
  attachmentBlobExtension,
  type AttachmentAcceptance,
  type AttachmentMediaType,
} from "../domain/attachments";
import { ensurePrivateDirectory, type StatePaths } from "./paths";

/*
 * The content-addressed attachment blob store.
 *
 * Bytes never enter SQLite and never enter a message column. They live in one
 * mode-0700 directory under the state root as mode-0600 files named by the
 * SHA-256 of their own content plus the extension their canonical media type
 * implies. The extension is a function of the bytes, so the name is still
 * content-addressed; it exists because the Codex app-server is handed a
 * `localImage` path and recognises an image by its file name.
 *
 * The store knows nothing about sessions, queues, or reference counts. The
 * durable `attachments` table in `state-store.ts` owns custody accounting and
 * decides when a blob may be removed.
 */

/**
 * Lower-case hex SHA-256 of the exact bytes. It lives here rather than in the
 * domain because the domain module is reachable from the browser bundle and
 * must stay free of Node built-ins.
 */
export function attachmentDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function attachmentsDirectory(paths: StatePaths): string {
  return join(paths.root, "attachments");
}

export type StoredAttachmentBlob = Readonly<{
  byteLength: number;
  canonicalMediaType: AttachmentMediaType;
  digest: string;
  path: string;
}>;

export type AttachmentBlobRefusal = Readonly<{
  kind: "refused";
  message: string;
  reason: Extract<AttachmentAcceptance, { ok: false }>["reason"];
}>;

export type AttachmentBlobOutcome =
  | Readonly<{ kind: "stored"; value: StoredAttachmentBlob }>
  | AttachmentBlobRefusal;

const blobNamePattern = /^[0-9a-f]{64}\.(?:png|jpg|gif|webp|txt)$/u;
// macOS may resolve an uppercase spelling to the same retained blob. Such
// aliases are never stale-file authority, even on case-sensitive volumes.
const blobNameAliasPattern = /^[0-9a-f]{64}\.(?:png|jpg|gif|webp|txt)$/iu;
const canonicalMediaTypes = [...ATTACHMENT_IMAGE_MEDIA_TYPES, "text/plain"] as const;
const cleanupCandidateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("blob"), digest: attachmentDigestSchema,
    canonicalMediaType: z.enum(canonicalMediaTypes) }).strict(),
  // A real blob cannot bypass the future reference/pin lookup by being
  // relabelled as an unaccounted stale filename.
  z.object({ kind: z.literal("stale"), name: attachmentNameSchema.refine((name) =>
    !blobNameAliasPattern.test(name) && !/[\uD800-\uDFFF]/u.test(name)) }).strict(),
]);
export type AttachmentCleanupCandidate = z.infer<typeof cleanupCandidateSchema>;
export type AttachmentCleanupUnlinkResult = Readonly<
  { kind: "deleted" | "absent" } | { kind: "retained"; reason: "young" | "unsafe_file" }
>;
export type AttachmentCleanupPort = Readonly<{
  unlinkCleanupCandidateSync(candidate: AttachmentCleanupCandidate,
    options: Readonly<{ notNewerThan: number | null }>): AttachmentCleanupUnlinkResult;
}>;

/** Sanitized failure codes: never forward a filesystem path or native error. */
export class AttachmentCleanupError extends Error {
  constructor(readonly code: "ATTACHMENT_CLEANUP_INVALID_CANDIDATE" | "ATTACHMENT_CLEANUP_INVALID_LIMIT"
    | "ATTACHMENT_CLEANUP_INVALID_CUTOFF" | "ATTACHMENT_CLEANUP_UNSAFE_DIRECTORY"
    | "ATTACHMENT_CLEANUP_INSPECT_FAILED" | "ATTACHMENT_CLEANUP_UNLINK_FAILED"
    | "ATTACHMENT_CLEANUP_ENUMERATION_FAILED") {
    super(code);
    this.name = "AttachmentCleanupError";
  }
}

export function parseAttachmentCleanupCandidate(value: unknown): AttachmentCleanupCandidate {
  const parsed = cleanupCandidateSchema.safeParse(value);
  if (!parsed.success) throw new AttachmentCleanupError("ATTACHMENT_CLEANUP_INVALID_CANDIDATE");
  return parsed.data;
}

const isMissing = (error: unknown): boolean => typeof error === "object" && error !== null
  && "code" in error && error.code === "ENOENT";
const assertPrivateCleanupDirectory = (path: string): void => {
  const metadata = lstatSync(path);
  const owner = process.getuid?.();
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.nlink < 1
    || (owner !== undefined && metadata.uid !== owner) || (metadata.mode & 0o077) !== 0
    || realpathSync(path) !== resolve(path)) {
    throw new AttachmentCleanupError("ATTACHMENT_CLEANUP_UNSAFE_DIRECTORY");
  }
};

/** Maximum directory entries examined, including entries refused as unsafe. */
export const ATTACHMENT_CLEANUP_SCAN_LIMIT = 100_000;

export class AttachmentBlobStore {
  readonly #directory: string;
  #prepared = false;

  constructor(directory: string) {
    if (!isAbsolute(directory)) {
      throw new Error("The attachment store directory must be absolute.");
    }
    this.#directory = directory;
  }

  static forStatePaths(paths: StatePaths): AttachmentBlobStore {
    return new AttachmentBlobStore(attachmentsDirectory(paths));
  }

  get directory(): string {
    return this.#directory;
  }

  /** The exact blob path for a digest whose canonical media type is known. */
  pathFor(digest: string, canonicalMediaType: AttachmentMediaType): string {
    return join(
      this.#directory,
      `${attachmentDigestSchema.parse(digest)}.${attachmentBlobExtension(canonicalMediaType)}`,
    );
  }

  async #prepare(): Promise<void> {
    if (this.#prepared) return;
    await ensurePrivateDirectory(this.#directory);
    this.#prepared = true;
  }

  /**
   * Admits bytes and writes them once. The declared media type is checked
   * against the leading bytes here, so a renamed executable never reaches the
   * store, let alone a provider.
   */
  async put(
    declaredMediaType: AttachmentMediaType,
    bytes: Uint8Array,
  ): Promise<AttachmentBlobOutcome> {
    const acceptance = acceptAttachmentBytes(declaredMediaType, bytes);
    if (!acceptance.ok) {
      return { kind: "refused", message: acceptance.message, reason: acceptance.reason };
    }
    await this.#prepare();
    const digest = attachmentDigest(bytes);
    const path = this.pathFor(digest, acceptance.canonicalMediaType);
    const existing = await this.#byteLengthOf(path);
    if (existing !== bytes.byteLength) {
      // Write to a private temporary name and rename into place, so a reader
      // never observes a partial blob under a digest-named path.
      const temporary = `${path}.${process.pid.toString(16)}.${Date.now().toString(16)}.part`;
      const handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.write(bytes);
        await handle.chmod(0o600);
      } finally {
        await handle.close();
      }
      try {
        await rename(temporary, path);
      } catch (error: unknown) {
        await rm(temporary, { force: true });
        throw error;
      }
    }
    return {
      kind: "stored",
      value: {
        byteLength: bytes.byteLength,
        canonicalMediaType: acceptance.canonicalMediaType,
        digest,
        path,
      },
    };
  }

  async #byteLengthOf(path: string): Promise<number | null> {
    try {
      const metadata = await stat(path);
      return metadata.isFile() ? metadata.size : null;
    } catch {
      return null;
    }
  }

  /**
   * Reads a blob back and re-proves its digest. Local custody is trusted for
   * confidentiality, never for integrity: the caller always gets bytes whose
   * SHA-256 is the digest it asked for, or an error.
   */
  async read(digest: string, canonicalMediaType: AttachmentMediaType): Promise<Uint8Array> {
    const expected = attachmentDigestSchema.parse(digest);
    const path = this.pathFor(expected, canonicalMediaType);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size < 1 || metadata.size > ATTACHMENT_MAX_BYTES) {
        throw new Error("ATTACHMENT_BLOB_UNSAFE");
      }
      const bytes = new Uint8Array(metadata.size);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
        if (read.bytesRead === 0) break;
        offset += read.bytesRead;
      }
      if (offset !== bytes.byteLength || attachmentDigest(bytes) !== expected) {
        throw new Error("ATTACHMENT_BLOB_UNSAFE");
      }
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async has(digest: string, canonicalMediaType: AttachmentMediaType): Promise<boolean> {
    return await this.#byteLengthOf(this.pathFor(digest, canonicalMediaType)) !== null;
  }

  #cleanupDirectoryExistsSync(): boolean {
    // Even an absent attachment directory needs an intact existing private
    // parent. Cleanup never prepares, repairs or creates directory custody.
    try {
      assertPrivateCleanupDirectory(dirname(this.#directory));
    } catch (error: unknown) {
      if (error instanceof AttachmentCleanupError) throw error;
      throw new AttachmentCleanupError("ATTACHMENT_CLEANUP_INSPECT_FAILED");
    }
    try {
      assertPrivateCleanupDirectory(this.#directory);
      return true;
    } catch (error: unknown) {
      if (isMissing(error)) return false;
      if (error instanceof AttachmentCleanupError) throw error;
      throw new AttachmentCleanupError("ATTACHMENT_CLEANUP_INSPECT_FAILED");
    }
  }

  /** Hints only. No reference, age or deletion authority survives an await. */
  async listCleanupCandidates(limit = 256): Promise<Readonly<{
    candidates: readonly AttachmentCleanupCandidate[]; truncated: boolean;
  }>> {
    const parsedLimit = z.number().int().min(1).max(ATTACHMENT_CLEANUP_SCAN_LIMIT).safeParse(limit);
    if (!parsedLimit.success) throw new AttachmentCleanupError("ATTACHMENT_CLEANUP_INVALID_LIMIT");
    if (!this.#cleanupDirectoryExistsSync()) return { candidates: [], truncated: false };
    const candidates: AttachmentCleanupCandidate[] = [];
    let scanned = 0;
    try {
      for await (const entry of await opendir(this.#directory)) {
        if (scanned >= parsedLimit.data) return { candidates, truncated: true };
        scanned += 1;
        if (blobNamePattern.test(entry.name)) {
          const extension = entry.name.slice(65);
          const canonicalMediaType = canonicalMediaTypes.find((mediaType) => attachmentBlobExtension(mediaType) === extension);
          const parsed = cleanupCandidateSchema.safeParse({ kind: "blob", digest: entry.name.slice(0, 64), canonicalMediaType });
          if (parsed.success) candidates.push(parsed.data);
        } else {
          const parsed = cleanupCandidateSchema.safeParse({ kind: "stale", name: entry.name });
          if (parsed.success) candidates.push(parsed.data);
        }
      }
    } catch (error: unknown) {
      if (isMissing(error)) return { candidates, truncated: false };
      throw new AttachmentCleanupError("ATTACHMENT_CLEANUP_ENUMERATION_FAILED");
    }
    return { candidates, truncated: false };
  }

  /**
   * Filesystem half of one closed storage-owned cleanup transaction. This
   * method grants no custody authority: its caller must hold SQLite's writer
   * exclusion while rechecking references, pins and exact live daemon boot.
   * No await separates the final metadata check from unlink. A later SQL
   * rollback cannot restore deleted bytes; absent-file retry is conservative.
   */
  unlinkCleanupCandidateSync(candidateInput: AttachmentCleanupCandidate,
    options: Readonly<{ notNewerThan: number | null }>): AttachmentCleanupUnlinkResult {
    const candidate = parseAttachmentCleanupCandidate(candidateInput);
    const cutoff = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().safeParse(options.notNewerThan);
    if (!cutoff.success || (candidate.kind === "stale" && cutoff.data === null)) {
      throw new AttachmentCleanupError("ATTACHMENT_CLEANUP_INVALID_CUTOFF");
    }
    if (!this.#cleanupDirectoryExistsSync()) return { kind: "absent" };
    const path = candidate.kind === "blob" ? this.pathFor(candidate.digest, candidate.canonicalMediaType)
      : join(this.#directory, candidate.name);
    let metadata;
    try {
      metadata = lstatSync(path);
    } catch (error: unknown) {
      if (isMissing(error)) return { kind: "absent" };
      throw new AttachmentCleanupError("ATTACHMENT_CLEANUP_INSPECT_FAILED");
    }
    const owner = process.getuid?.();
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || (owner !== undefined && metadata.uid !== owner) || (metadata.mode & 0o077) !== 0
      || !Number.isFinite(metadata.mtimeMs) || metadata.mtimeMs < 0) {
      return { kind: "retained", reason: "unsafe_file" };
    }
    if (cutoff.data !== null && metadata.mtimeMs > cutoff.data) return { kind: "retained", reason: "young" };
    try {
      unlinkSync(path);
    } catch (error: unknown) {
      if (isMissing(error)) return { kind: "absent" };
      throw new AttachmentCleanupError("ATTACHMENT_CLEANUP_UNLINK_FAILED");
    }
    return { kind: "deleted" };
  }

  async remove(digest: string, canonicalMediaType: AttachmentMediaType): Promise<void> {
    await rm(this.pathFor(digest, canonicalMediaType), { force: true });
  }

  /**
   * Removes blob files that local custody does not account for and that are
   * older than the grace window. The window exists because the CLI writes the
   * bytes before the daemon records the reference: a blob younger than the
   * window may belong to a command that is still in flight.
   */
  async sweepUnaccounted(
    accounted: ReadonlySet<string>,
    olderThanMs: number,
    now: number,
  ): Promise<number> {
    let entries: readonly string[];
    try {
      entries = await readdir(this.#directory);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const entry of entries.slice(0, 100_000)) {
      if (blobNameAliasPattern.test(entry) && !blobNamePattern.test(entry)) continue;
      const digest = entry.slice(0, 64);
      const stale = entry.endsWith(".part") || !blobNamePattern.test(entry);
      if (!stale && accounted.has(digest)) continue;
      const path = join(this.#directory, entry);
      let metadata;
      try {
        metadata = await stat(path);
      } catch {
        continue;
      }
      if (!metadata.isFile() || now - metadata.mtimeMs < olderThanMs) continue;
      await rm(path, { force: true });
      removed += 1;
    }
    return removed;
  }
}

/** Blobs younger than this are never swept, so an in-flight command is safe. */
export const ATTACHMENT_BLOB_SWEEP_GRACE_MS = 60 * 60 * 1_000;
