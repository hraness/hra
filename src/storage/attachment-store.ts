import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { attachmentDigestSchema } from "../domain/attachment-schemas";
import {
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
