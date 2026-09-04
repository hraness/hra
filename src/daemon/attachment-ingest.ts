import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MESSAGE_MAX_TOTAL_BYTES,
  attachmentFileExtensions,
  attachmentMediaTypeForName,
  formatAttachmentSize,
  type AttachmentReference,
} from "../domain/attachments";
import { attachmentNameSchema } from "../domain/attachment-schemas";
import type { AttachmentBlobStore } from "../storage/attachment-store";

/*
 * Attachment ingest from a local filesystem path.
 *
 * This is the only place a filesystem path is ever resolved for an
 * attachment, and it lives at the daemon layer because writing into local
 * custody is a storage effect. The CLI calls it before it builds a command:
 * the file is refused by extension before it is opened, refused again by its
 * leading bytes, written into the content-addressed store, and reduced to a
 * digest reference. No path ever crosses the local socket, so no remote
 * command can ever name one.
 */

export class AttachmentIngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentIngestError";
  }
}

const readAttachmentFile = async (path: string): Promise<Uint8Array> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new AttachmentIngestError(`${path} is not a regular file.`);
    }
    if (metadata.size < 1) {
      throw new AttachmentIngestError(`${path} is empty.`);
    }
    if (metadata.size > ATTACHMENT_MAX_BYTES) {
      throw new AttachmentIngestError(
        `${path} is ${formatAttachmentSize(metadata.size)}; an attachment must be at most ${formatAttachmentSize(ATTACHMENT_MAX_BYTES)}.`,
      );
    }
    const bytes = new Uint8Array(metadata.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset !== bytes.byteLength) {
      throw new AttachmentIngestError(`${path} changed while it was being read.`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
};

/**
 * Reads, admits, and stores every `--attach` path, in order, and returns the
 * digest references the command carries.
 */
export async function ingestAttachments(
  blobs: AttachmentBlobStore,
  paths: readonly string[],
  cwd: string,
): Promise<readonly AttachmentReference[]> {
  if (paths.length > ATTACHMENT_MAX_COUNT) {
    throw new AttachmentIngestError(
      `At most ${String(ATTACHMENT_MAX_COUNT)} attachments may ride on one message.`,
    );
  }
  const references: AttachmentReference[] = [];
  let total = 0;
  for (const candidate of paths) {
    const path = isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate);
    const name = basename(path);
    const parsedName = attachmentNameSchema.safeParse(name);
    if (!parsedName.success) {
      throw new AttachmentIngestError(
        `${candidate} does not have a usable attachment file name.`,
      );
    }
    const mediaType = attachmentMediaTypeForName(parsedName.data);
    if (mediaType === null) {
      throw new AttachmentIngestError(
        `${name} is not an accepted attachment type. Accepted extensions: ${attachmentFileExtensions().join(", ")}.`,
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = await readAttachmentFile(path);
    } catch (error: unknown) {
      if (error instanceof AttachmentIngestError) throw error;
      throw new AttachmentIngestError(`${candidate} could not be read as an attachment.`);
    }
    total += bytes.byteLength;
    if (total > ATTACHMENT_MESSAGE_MAX_TOTAL_BYTES) {
      throw new AttachmentIngestError(
        `Attachments on one message must total at most ${formatAttachmentSize(ATTACHMENT_MESSAGE_MAX_TOTAL_BYTES)}.`,
      );
    }
    const stored = await blobs.put(mediaType, bytes);
    if (stored.kind === "refused") {
      throw new AttachmentIngestError(`${name} was refused: ${stored.message}`);
    }
    references.push({
      byteLength: stored.value.byteLength,
      digest: stored.value.digest,
      mediaType,
      name: parsedName.data,
    });
  }
  return references;
}

