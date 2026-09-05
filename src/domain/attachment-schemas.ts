import { z } from "zod";

import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MEDIA_TYPES,
  ATTACHMENT_MESSAGE_MAX_TOTAL_BYTES,
  ATTACHMENT_NAME_MAX_BYTES,
  isAttachmentDigest,
  isAttachmentName,
  type AttachmentReference,
} from "./attachments";

/*
 * The parsing side of attachments.
 *
 * `attachments.ts` is reachable from the browser bundle and therefore carries
 * no dependency at all. Everything that needs zod lives here instead, so the
 * app pays for the vocabulary without paying for the schema library.
 */

export const attachmentMediaTypeSchema = z.enum(ATTACHMENT_MEDIA_TYPES);

export const attachmentDigestSchema = z.string().refine(
  isAttachmentDigest,
  "An attachment digest must be 64 lower-case hexadecimal characters.",
);

export const attachmentNameSchema = z.string().refine(
  isAttachmentName,
  `An attachment name must be a single file name of at most ${String(ATTACHMENT_NAME_MAX_BYTES)} UTF-8 bytes, with no path separator or control character.`,
);

export const attachmentByteLengthSchema = z.number()
  .int()
  .min(1)
  .max(ATTACHMENT_MAX_BYTES);

export const attachmentReferenceSchema = z.object({
  byteLength: attachmentByteLengthSchema,
  digest: attachmentDigestSchema,
  mediaType: attachmentMediaTypeSchema,
  name: attachmentNameSchema,
}).strict() satisfies z.ZodType<AttachmentReference>;

export const attachmentReferenceListSchema = z.array(attachmentReferenceSchema)
  .min(1)
  .max(ATTACHMENT_MAX_COUNT, `A message carries at most ${String(ATTACHMENT_MAX_COUNT)} attachments.`)
  .superRefine((values, context) => {
    let total = 0;
    for (const value of values) total += value.byteLength;
    if (total > ATTACHMENT_MESSAGE_MAX_TOTAL_BYTES) {
      context.addIssue({
        code: "custom",
        message: `Attachments on one message must total at most ${String(ATTACHMENT_MESSAGE_MAX_TOTAL_BYTES)} bytes.`,
      });
    }
    const seen = new Set<string>();
    for (const value of values) {
      const key = [value.digest, value.name].join(" ");
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          message: "A message must not repeat the same attachment name and digest.",
        });
        return;
      }
      seen.add(key);
    }
  });

export const attachmentManifestEntrySchema = attachmentReferenceSchema;
