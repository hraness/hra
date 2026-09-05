import {
  acceptAttachmentBytes,
  isAttachmentImageMediaType,
  type AttachmentMediaType,
  type AttachmentReference,
  type PreparedAttachment,
} from "../domain/attachments";
import type { StoredMessageAttachment } from "../storage/state-store";
import type { AttachmentBlobStore } from "../storage/attachment-store";

/*
 * Resolving a message's attachment references against local custody.
 *
 * A reference names a digest, never a path. Nothing that arrived from argv,
 * the local socket, or the hosted bridge is trusted here: the bytes are read
 * back from the content-addressed store, their SHA-256 is re-proved by the
 * store itself, their declared media type is re-checked against their leading
 * bytes, and their length is re-measured. Only then does a provider see them.
 */

export type AttachmentResolution =
  | Readonly<{ kind: "prepared"; stored: readonly StoredMessageAttachment[]; values: readonly PreparedAttachment[] }>
  | Readonly<{ code: string; kind: "refused"; message: string }>;

/** The canonical media type a declared type must have been filed under. */
export function canonicalMediaTypeOf(declared: AttachmentMediaType): AttachmentMediaType {
  return isAttachmentImageMediaType(declared) ? declared : "text/plain";
}

export async function resolveMessageAttachments(
  blobs: AttachmentBlobStore,
  references: readonly AttachmentReference[],
): Promise<AttachmentResolution> {
  const values: PreparedAttachment[] = [];
  const stored: StoredMessageAttachment[] = [];
  for (const reference of references) {
    const canonicalMediaType = canonicalMediaTypeOf(reference.mediaType);
    let bytes: Uint8Array;
    try {
      bytes = await blobs.read(reference.digest, canonicalMediaType);
    } catch {
      return {
        code: "ATTACHMENT_MISSING",
        kind: "refused",
        message: `Attachment ${reference.name} is not in local attachment custody on this machine.`,
      };
    }
    if (bytes.byteLength !== reference.byteLength) {
      return {
        code: "ATTACHMENT_LENGTH_MISMATCH",
        kind: "refused",
        message: `Attachment ${reference.name} does not have the length its reference claims.`,
      };
    }
    const acceptance = acceptAttachmentBytes(reference.mediaType, bytes);
    if (!acceptance.ok) {
      return {
        code: `ATTACHMENT_${acceptance.reason}`,
        kind: "refused",
        message: `Attachment ${reference.name} was refused: ${acceptance.message}`,
      };
    }
    const path = blobs.pathFor(reference.digest, acceptance.canonicalMediaType);
    values.push(acceptance.text === null
      ? {
          base64: Buffer.from(bytes).toString("base64"),
          byteLength: reference.byteLength,
          digest: reference.digest,
          kind: "image",
          mediaType: acceptance.canonicalMediaType as Extract<AttachmentMediaType, `image/${string}`>,
          name: reference.name,
          path,
        }
      : {
          byteLength: reference.byteLength,
          digest: reference.digest,
          kind: "text",
          mediaType: reference.mediaType as Exclude<AttachmentMediaType, `image/${string}`>,
          name: reference.name,
          path,
          text: acceptance.text,
        });
    stored.push({
      byteLength: reference.byteLength,
      canonicalMediaType: acceptance.canonicalMediaType,
      digest: reference.digest,
      mediaType: reference.mediaType,
      name: reference.name,
    });
  }
  return { kind: "prepared", stored, values };
}
