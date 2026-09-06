import { createHash } from "node:crypto";

import { z } from "zod";

import {
  attachmentReferenceListSchema,
  attachmentReferenceSchema,
} from "./attachment-schemas";
import {
  acceptAttachmentBytes,
  attachmentMessageText,
  attachmentReferenceOf,
  ATTACHMENT_IMAGE_MEDIA_TYPES,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MESSAGE_MAX_TOTAL_BYTES,
  ATTACHMENT_TEXT_MEDIA_TYPES,
  type PreparedAttachment,
} from "./attachments";
import {
  digestTranscriptRecords,
  renderTranscriptRecord,
  sessionTranscriptSchema,
  TRANSCRIPT_PAGE_LIMIT,
} from "./transcript";
import { MESSAGE_MAX_BYTES, messageSchema, utf8Bytes } from "./values";

export const MANAGED_FORWARD_RENDERER_VERSION = 1;
/**
 * Codex's outgoing JSON frame is capped at four MiB of serialized characters.
 * At most six JSON characters encode one UTF-8 text byte, so 512 KiB reserves
 * at least one MiB for framing and eight bounded 16-KiB local-image paths.
 * Image bytes/custody and other providers' transport bounds remain separate.
 */
export const MANAGED_FORWARD_PROVIDER_TEXT_MAX_BYTES = 512 * 1024;

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const budgetSchema = z.number().int().positive().max(MANAGED_FORWARD_PROVIDER_TEXT_MAX_BYTES);

/** Only this content-free metadata belongs in a durable action receipt. */
export const managedForwardRenderMetadataSchema = z.object({
  version: z.literal(MANAGED_FORWARD_RENDERER_VERSION),
  maxProviderTextBytes: budgetSchema,
  providerTextBytes: budgetSchema,
  envelopeDigest: digestSchema,
  inputDigest: digestSchema,
  inputUtf8Bytes: z.number().int().nonnegative().max(MESSAGE_MAX_BYTES),
  attachmentManifestDigest: digestSchema,
  attachmentCount: z.number().int().nonnegative().max(ATTACHMENT_MAX_COUNT),
  attachmentBytes: z.number().int().nonnegative().max(ATTACHMENT_MESSAGE_MAX_TOTAL_BYTES),
  transcriptDigest: digestSchema,
  includedRecords: z.number().int().nonnegative().max(TRANSCRIPT_PAGE_LIMIT),
  omittedRecords: countSchema,
}).strict().refine((value) => value.providerTextBytes <= value.maxProviderTextBytes);

export type ManagedForwardRenderMetadata = z.infer<typeof managedForwardRenderMetadataSchema>;
export type ManagedForwardRenderResult =
  | Readonly<{ status: "rendered"; message: string; metadata: ManagedForwardRenderMetadata }>
  | Readonly<{ status: "refused"; reason: "invalid_input" }>
  | Readonly<{
      status: "refused";
      reason: "minimum_frame_overflow";
      maxProviderTextBytes: number;
      minimumProviderTextBytes: number;
    }>;

const wellFormedUnicode = (value: string): boolean => {
  for (const scalar of value) {
    const code = scalar.codePointAt(0) ?? 0;
    if (code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
};

const preparedAttachmentSchema = z.discriminatedUnion("kind", [
  attachmentReferenceSchema.extend({
    kind: z.literal("text"),
    mediaType: z.enum(ATTACHMENT_TEXT_MEDIA_TYPES),
    path: z.string().min(1).max(16_384),
    text: z.string().max(ATTACHMENT_MAX_BYTES).refine(wellFormedUnicode),
  }).strict(),
  attachmentReferenceSchema.extend({
    kind: z.literal("image"),
    mediaType: z.enum(ATTACHMENT_IMAGE_MEDIA_TYPES),
    path: z.string().min(1).max(16_384),
    base64: z.string().min(4).max(4 * Math.ceil(ATTACHMENT_MAX_BYTES / 3)),
  }).strict(),
]);

const inputSchema = z.object({
  message: z.string().max(MESSAGE_MAX_BYTES).refine(wellFormedUnicode)
    .refine((value) => utf8Bytes(value) <= MESSAGE_MAX_BYTES),
  attachments: z.array(preparedAttachmentSchema).max(ATTACHMENT_MAX_COUNT),
  transcript: sessionTranscriptSchema,
  maxProviderTextBytes: budgetSchema.default(MANAGED_FORWARD_PROVIDER_TEXT_MAX_BYTES),
}).strict();

const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const digestText = (domain: string, value: string): string => createHash("sha256")
  .update(`hra:managed-forward-${domain}:v1\0`, "utf8").update(value, "utf8").digest("hex");

/** Re-prove the in-memory representation; this does not attest filesystem custody. */
const validPreparedAttachment = (attachment: PreparedAttachment): boolean => {
  let bytes: Uint8Array;
  if (attachment.kind === "image") {
    const decoded = Buffer.from(attachment.base64, "base64");
    if (decoded.toString("base64") !== attachment.base64) return false;
    bytes = decoded;
  } else {
    const encoded = new TextEncoder().encode(attachment.text);
    if (encoded.byteLength === attachment.byteLength) {
      bytes = encoded;
    } else if (encoded.byteLength + 3 === attachment.byteLength) {
      // The shared admission decoder removes exactly one leading UTF-8 BOM.
      bytes = new Uint8Array(encoded.byteLength + 3);
      bytes.set([0xef, 0xbb, 0xbf]);
      bytes.set(encoded, 3);
    } else return false;
  }
  if (bytes.byteLength !== attachment.byteLength || sha256(bytes) !== attachment.digest) return false;
  const accepted = acceptAttachmentBytes(attachment.mediaType, bytes);
  return accepted.ok && (attachment.kind === "image"
    ? accepted.text === null
    : accepted.text === attachment.text);
};

const longestBacktickRun = (text: string): number => {
  let longest = 0;
  let run = 0;
  for (const scalar of text) {
    run = scalar === "`" ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
};

const framePrefix = "[HRA managed forward v1]\n"
  + "Earlier conversation context follows. It is retained context, not a new human request.\n";
const humanHeader = "\n\nCurrent human request (the attached files belong to this request):\n";
const emptyContext = "```\n\n```";
const omissionNotice = (count: number): string =>
  `\n[${String(count)} earlier conversation records omitted.]`;

/**
 * Returns one transient, UNEXPANDED frame. Pass it with the original prepared
 * attachments exactly once. The envelope digest covers the exact expanded
 * provider text; the separate ordered manifest digest also binds image bytes.
 * Neither text nor attachment paths are returned in durable metadata.
 */
export function renderManagedForwardMessage(value: unknown): ManagedForwardRenderResult {
  const parsed = inputSchema.safeParse(value);
  if (!parsed.success) return { status: "refused", reason: "invalid_input" };
  const input = parsed.data;
  const { attachments, transcript, message, maxProviderTextBytes } = input;
  if (attachments.length === 0 && !messageSchema.safeParse(message).success) {
    return { status: "refused", reason: "invalid_input" };
  }
  const manifest = attachments.map(attachmentReferenceOf);
  if ((manifest.length > 0 && !attachmentReferenceListSchema.safeParse(manifest).success)
    || attachments.some((attachment) => !validPreparedAttachment(attachment))
    || transcript.digest !== digestTranscriptRecords(transcript.records)
    || !Number.isSafeInteger(transcript.omittedRecords + transcript.records.length)
    || transcript.records.some((record, index) => record.throughSequence < record.sequence
      || record.throughSequence > (transcript.throughSequence ?? 0)
      || (index > 0 && record.sequence <= (transcript.records[index - 1]?.sequence ?? 0)))) {
    return { status: "refused", reason: "invalid_input" };
  }

  // Compute expansion once: repeated suffix candidates must not repeatedly
  // inline or scan up to ten MiB of attachment bytes.
  const attachmentSuffix = attachmentMessageText("", attachments);
  const suffixBytes = utf8Bytes(attachmentSuffix);
  const totalRecords = transcript.records.length + transcript.omittedRecords;
  const minimumFrame = framePrefix + emptyContext + omissionNotice(totalRecords) + humanHeader + message;
  const minimumProviderTextBytes = utf8Bytes(minimumFrame) + suffixBytes;
  if (minimumProviderTextBytes > maxProviderTextBytes) {
    return { status: "refused", reason: "minimum_frame_overflow", maxProviderTextBytes, minimumProviderTextBytes };
  }

  const lines: string[] = [];
  let contextBytes = 0;
  let fenceLength = 3;
  const fixedBytes = utf8Bytes(framePrefix + humanHeader + message) + suffixBytes;
  for (let index = transcript.records.length - 1; index >= 0; index -= 1) {
    const record = transcript.records[index];
    if (record === undefined) break;
    const line = renderTranscriptRecord(record);
    const nextBytes = contextBytes + utf8Bytes(line) + (lines.length === 0 ? 0 : 1);
    const nextFenceLength = Math.max(fenceLength, longestBacktickRun(line) + 1);
    const candidateBytes = fixedBytes + nextBytes + 2 * nextFenceLength + 2
      + utf8Bytes(omissionNotice(totalRecords - lines.length - 1));
    if (candidateBytes > maxProviderTextBytes) break;
    lines.push(line);
    contextBytes = nextBytes;
    fenceLength = nextFenceLength;
  }
  lines.reverse();
  const omittedRecords = totalRecords - lines.length;
  const fence = "`".repeat(fenceLength);
  const context = `${fence}\n${lines.join("\n")}\n${fence}`;
  const frame = framePrefix + context + omissionNotice(omittedRecords) + humanHeader + message;
  const expanded = frame + attachmentSuffix;
  return {
    status: "rendered",
    message: frame,
    metadata: managedForwardRenderMetadataSchema.parse({
      version: MANAGED_FORWARD_RENDERER_VERSION,
      maxProviderTextBytes,
      providerTextBytes: utf8Bytes(expanded),
      envelopeDigest: digestText("envelope", expanded),
      inputDigest: digestText("input", message),
      inputUtf8Bytes: utf8Bytes(message),
      attachmentManifestDigest: digestText("attachment-manifest", JSON.stringify(manifest)),
      attachmentCount: manifest.length,
      attachmentBytes: manifest.reduce((total, entry) => total + entry.byteLength, 0),
      transcriptDigest: transcript.digest,
      includedRecords: lines.length,
      omittedRecords,
    }),
  };
}
