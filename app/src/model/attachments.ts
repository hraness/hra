/**
 * Composer attachments: what the browser accepts, what it refuses, and the one
 * shape it sends.
 *
 * This module is the single alignment point for the attachment wire. The daemon
 * side of the contract (provider wires, local custody, the versioned hosted
 * send payload) is being written in parallel, so everything the browser puts on
 * the wire is built by `buildSendPayload` here and nothing else in the app
 * constructs an attachment record. When the daemon-side shape settles, this file
 * is the only one to change.
 *
 * Two different bounds apply, and they are not the same number:
 *
 *  - What a reader may attach: 8 files, 5 MiB each, 10 MiB per message. Those
 *    are the pre-downscale bounds, measured on the file as it arrived.
 *  - What may actually travel: `inlineBudgetBytes`. A remote command is one
 *    encrypted envelope bounded by `cloudLimits.ciphertextCharacters` (350k
 *    base64url characters), and base64 expands bytes by four thirds, so the
 *    bytes of a whole message have to stay far under that. Images are
 *    downscaled into this budget; a text file that does not fit is refused with
 *    its measured size, because there is nothing to downscale.
 *
 * Nothing here touches React, the DOM, or a canvas.
 */
import {
  encodeBase64Url,
  parseRemoteCommandPayload,
  sha256Hex,
  type RemoteCommandPayload,
} from "../hra/cloud";
import { neutraliseText } from "../markdown/sanitise";
import { downscaleImage, type ImageEncoder, type ImageSize } from "./image-downscale";

const mebibyte = 1024 * 1024;

export const attachmentLimits = Object.freeze({
  /** The longest edge a downscaled image is fitted into. */
  imageLongestEdge: 1568,
  /**
   * Total attachment bytes one message may actually carry. Chosen against
   * `cloudLimits.ciphertextCharacters` (350k) with the four-thirds base64
   * expansion and room for the message text and the record around it.
   */
  inlineBudgetBytes: 160 * 1024,
  maximumCount: 8,
  maximumFileBytes: 5 * mebibyte,
  maximumNameCharacters: 120,
  maximumTotalBytes: 10 * mebibyte,
} as const);

export const imageMediaTypes = Object.freeze([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const);

export const textMediaTypes = Object.freeze([
  "application/json",
  "text/csv",
  "text/markdown",
  "text/plain",
] as const);

export type ImageMediaType = (typeof imageMediaTypes)[number];
export type TextMediaType = (typeof textMediaTypes)[number];
export type AttachmentMediaType = ImageMediaType | TextMediaType;
export type AttachmentKind = "image" | "text";

/** The `accept` attribute for the file picker, derived from the same lists. */
export const attachmentAcceptAttribute = [...imageMediaTypes, ...textMediaTypes].join(",");

const imageMediaTypeSet: ReadonlySet<string> = new Set<string>(imageMediaTypes);
const textMediaTypeSet: ReadonlySet<string> = new Set<string>(textMediaTypes);

/**
 * The media type as the accepted union, or null.
 *
 * A browser reports a type with parameters on some platforms (`text/plain;
 * charset=utf-8`), so the parameters are dropped before the comparison. The
 * type is never guessed from the file name: an extension is reader-supplied
 * text, not evidence about the bytes.
 */
export function normaliseMediaType(value: string): AttachmentMediaType | null {
  const base = value.split(";")[0]?.trim().toLowerCase() ?? "";
  if (imageMediaTypeSet.has(base) || textMediaTypeSet.has(base)) {
    return base as AttachmentMediaType;
  }
  return null;
}

export function attachmentKind(mediaType: AttachmentMediaType): AttachmentKind {
  return imageMediaTypeSet.has(mediaType) ? "image" : "text";
}

export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${String(Math.round(bytes))} B`;
  if (bytes < mebibyte) {
    const kib = bytes / 1024;
    return `${kib < 10 ? kib.toFixed(1) : String(Math.round(kib))} KiB`;
  }
  return `${(bytes / mebibyte).toFixed(1)} MiB`;
}

/**
 * A display name that cannot be mistaken for a path.
 *
 * Directory separators, control scalars, and the bidirectional and zero-width
 * scalars the markdown surface already strips elsewhere are removed here too,
 * because an attachment name is reader-supplied text that renders in a chip.
 */
// eslint-disable-next-line no-control-regex
const controlCharacters = /[\u0000-\u001f\u007f]/gu;

export function attachmentDisplayName(value: string): string {
  const withoutDirectories = value.split(/[/\\]/u).at(-1) ?? "";
  const cleaned = neutraliseText(withoutDirectories.replaceAll(controlCharacters, "")).trim();
  if (cleaned.length === 0) return "attachment";
  return cleaned.length > attachmentLimits.maximumNameCharacters
    ? cleaned.slice(0, attachmentLimits.maximumNameCharacters)
    : cleaned;
}

export type AttachmentCandidate = Readonly<{
  mediaType: string;
  name: string;
  size: number;
}>;

export type AttachmentTotals = Readonly<{ count: number; totalBytes: number }>;

/**
 * Why a candidate cannot be attached, in one line the composer shows verbatim.
 *
 * A refusal always names the file, and a type refusal always names the type the
 * browser reported, so "it did nothing" is never the answer.
 */
export function refuseCandidate(
  candidate: AttachmentCandidate,
  totals: AttachmentTotals,
): string | null {
  const name = attachmentDisplayName(candidate.name);
  const mediaType = normaliseMediaType(candidate.mediaType);
  if (mediaType === null) {
    const reported = candidate.mediaType.trim().length === 0
      ? "an unnamed type"
      : candidate.mediaType.split(";")[0]?.trim() ?? candidate.mediaType;
    return `${name}: ${reported} is not a type this composer sends. `
      + "It sends PNG, JPEG, GIF, and WebP images, and plain text, Markdown, CSV, and JSON files.";
  }
  if (candidate.size <= 0) return `${name} is empty.`;
  if (totals.count >= attachmentLimits.maximumCount) {
    return `${name}: a message carries at most `
      + `${String(attachmentLimits.maximumCount)} attachments.`;
  }
  if (candidate.size > attachmentLimits.maximumFileBytes) {
    return `${name} is ${formatByteSize(candidate.size)}. One attachment can be at most `
      + `${formatByteSize(attachmentLimits.maximumFileBytes)}.`;
  }
  if (totals.totalBytes + candidate.size > attachmentLimits.maximumTotalBytes) {
    return `${name} would take this message past `
      + `${formatByteSize(attachmentLimits.maximumTotalBytes)} of attachments.`;
  }
  return null;
}

export type AttachmentSelection<T> = Readonly<{
  accepted: readonly T[];
  refusals: readonly string[];
}>;

/**
 * Applies the accept and refuse rules to a batch, in order.
 *
 * The bounds are running totals, so the first five files of a six-file paste
 * are attached and the sixth is refused by name rather than the whole paste
 * being dropped. `describe` keeps this usable for a `File`, for a
 * `DataTransferItem`-derived record, and for a plain object in a test.
 */
export function selectAttachments<T>(
  candidates: readonly T[],
  describe: (candidate: T) => AttachmentCandidate,
  totals: AttachmentTotals,
): AttachmentSelection<T> {
  const accepted: T[] = [];
  const refusals: string[] = [];
  let running = totals;
  for (const candidate of candidates) {
    const described = describe(candidate);
    const refusal = refuseCandidate(described, running);
    if (refusal !== null) {
      refusals.push(refusal);
      continue;
    }
    accepted.push(candidate);
    running = {
      count: running.count + 1,
      totalBytes: running.totalBytes + described.size,
    };
  }
  return { accepted, refusals };
}

/**
 * One attachment, ready to send. `bytes` is what actually travels: for an image
 * that is usually the downscaled re-encode, and `sourceBytes` remembers what the
 * reader handed over so the chip can report the saving.
 */
export type PreparedAttachment = Readonly<{
  bytes: Uint8Array;
  digest: string;
  id: string;
  kind: AttachmentKind;
  mediaType: AttachmentMediaType;
  name: string;
  /** Set when the bytes are still over the inline budget: the send is refused. */
  refusal: string | null;
  sourceBytes: number;
}>;

/** The one line under a chip, or null when nothing was re-encoded. */
export function savedSizeLine(attachment: PreparedAttachment): string | null {
  if (attachment.bytes.byteLength >= attachment.sourceBytes) return null;
  return `${formatByteSize(attachment.sourceBytes)} down to `
    + formatByteSize(attachment.bytes.byteLength);
}

/**
 * Prepares one accepted candidate.
 *
 * `measure` decodes the image and returns its pixel size together with an
 * encoder bound to it; it is the only part that needs a canvas, and a test
 * passes a stub. A non-image, or an image the browser will not decode, is sent
 * as it arrived.
 */
export type MeasuredImageSource = Readonly<{
  dispose?: () => void;
  encode: ImageEncoder;
  size: ImageSize;
}>;

export async function prepareAttachment(input: Readonly<{
  bytes: Uint8Array;
  id: string;
  measure: (() => Promise<MeasuredImageSource | null>) | null;
  mediaType: AttachmentMediaType;
  name: string;
}>): Promise<PreparedAttachment> {
  const kind = attachmentKind(input.mediaType);
  let bytes = input.bytes;
  let mediaType: AttachmentMediaType = input.mediaType;

  if (kind === "image" && input.measure !== null) {
    const measured = await input.measure();
    if (measured !== null) {
      try {
        const result = await downscaleImage({
          budgetBytes: attachmentLimits.inlineBudgetBytes,
          encode: measured.encode,
          longestEdge: attachmentLimits.imageLongestEdge,
          mediaType: input.mediaType,
          size: measured.size,
          source: input.bytes,
        });
        bytes = result.bytes;
        mediaType = normaliseMediaType(result.mediaType) ?? input.mediaType;
      } finally {
        measured.dispose?.();
      }
    }
  }

  const name = attachmentDisplayName(input.name);
  const refusal = bytes.byteLength > attachmentLimits.inlineBudgetBytes
    ? `${name} is still ${formatByteSize(bytes.byteLength)} after downscaling. `
      + `One message carries at most ${formatByteSize(attachmentLimits.inlineBudgetBytes)} `
      + "of attachments."
    : null;

  return {
    bytes,
    digest: await sha256Hex(bytes),
    id: input.id,
    kind,
    mediaType,
    name,
    refusal,
    sourceBytes: input.bytes.byteLength,
  };
}

/**
 * The refusal for a set that fits individually but not together, or null.
 *
 * Individual refusals are already on their own chips; this is the message-level
 * bound the Send button reads.
 */
export function inlineBudgetRefusal(
  attachments: readonly PreparedAttachment[],
): string | null {
  const total = attachments.reduce((sum, item) => sum + item.bytes.byteLength, 0);
  if (total <= attachmentLimits.inlineBudgetBytes) return null;
  return `These attachments come to ${formatByteSize(total)} after downscaling. `
    + `One message carries at most ${formatByteSize(attachmentLimits.inlineBudgetBytes)}. `
    + "Remove one and send it separately.";
}

/**
 * The message to send when the reader attached files and typed nothing.
 *
 * It is the file names and nothing else. Inventing a sentence would put words
 * in the reader's mouth in a transcript the provider then reasons over; the
 * names are facts the reader supplied.
 */
export function defaultMessageForAttachments(
  attachments: readonly PreparedAttachment[],
): string {
  const line = attachments.map((item) => item.name).join(", ");
  return line.length === 0 ? "" : line.slice(0, 200);
}

export const attachmentPayloadVersion = 1;

export type AttachmentSendItem = Readonly<{
  /** base64url of the bytes that travel, matching `isBase64Url` in contracts. */
  bytesBase64: string;
  /** SHA-256 hex of those same bytes, so the transcript manifest can match. */
  digest: string;
  kind: AttachmentKind;
  mediaType: AttachmentMediaType;
  name: string;
  size: number;
  sourceSize: number;
}>;

export type AttachmentSendEnvelope = Readonly<{
  items: readonly AttachmentSendItem[];
  version: number;
}>;

/**
 * The one builder for the send payload.
 *
 * With no attachments it returns exactly the payload the app has always sent,
 * so the ordinary path is byte-identical and keeps passing the repository's
 * `parseRemoteCommandPayload`. With attachments it adds one versioned key. That
 * key is not in the repository's `RemoteCommandPayload` union yet: the daemon
 * side is being written in parallel, and the assertion below is the single
 * place the two shapes meet. `attachmentSendSupported()` reports whether the
 * repository parser in this build accepts it, so the composer can say so
 * instead of failing inside the encrypt step.
 */
export function buildSendPayload(input: Readonly<{
  attachments: readonly PreparedAttachment[];
  message: string;
}>): RemoteCommandPayload {
  if (input.attachments.length === 0) {
    return { kind: "send_or_steer", message: input.message };
  }
  const envelope: AttachmentSendEnvelope = {
    items: input.attachments.map((item) => ({
      bytesBase64: encodeBase64Url(item.bytes),
      digest: item.digest,
      kind: item.kind,
      mediaType: item.mediaType,
      name: item.name,
      size: item.bytes.byteLength,
      sourceSize: item.sourceBytes,
    })),
    version: attachmentPayloadVersion,
  };
  const payload: Readonly<{
    attachments: AttachmentSendEnvelope;
    kind: "send_or_steer";
    message: string;
  }> = { attachments: envelope, kind: "send_or_steer", message: input.message };
  // `attachments` is an extra key the repository's `RemoteCommandPayload` union
  // does not name yet. Structural typing accepts it here, and
  // `parseRemoteCommandPayload` is exact-keyed, so `attachmentSendSupported()`
  // below is what actually reports whether this build carries it.
  return payload;
}

let supportedProbe: boolean | null = null;

/**
 * Whether the repository contract in this build carries attachments.
 *
 * `parseRemoteCommandPayload` is exact-keyed, so it answers honestly: today it
 * refuses the extra key and the composer says attachments are not carried yet;
 * the moment the daemon-side worker widens the union, this returns true and the
 * composer sends without another change here.
 */
export function attachmentSendSupported(): boolean {
  supportedProbe ??= parseRemoteCommandPayload(buildSendPayload({
    attachments: [{
      bytes: new Uint8Array([0]),
      digest: "0".repeat(64),
      id: "probe",
      kind: "text",
      mediaType: "text/plain",
      name: "probe.txt",
      refusal: null,
      sourceBytes: 1,
    }],
    message: "probe",
  })) !== null;
  return supportedProbe;
}

export type AttachmentManifestEntry = Readonly<{
  digest: string;
  kind: AttachmentKind;
  mediaType: AttachmentMediaType;
  name: string;
  size: number;
}>;

const digestPattern = /^[0-9a-f]{64}$/u;

/**
 * Parses the manifest a compact `user_message` may carry.
 *
 * The manifest describes attachments; it never carries them. An entry with any
 * bytes-bearing key is refused outright rather than trimmed, because a
 * projection that started shipping bytes is a contract change that has to be
 * reviewed, not silently rendered. Everything else is bounded to the same
 * numbers the composer enforces on the way out.
 */
export function parseAttachmentManifest(
  value: unknown,
): readonly AttachmentManifestEntry[] | null {
  if (!Array.isArray(value)) return null;
  const source: readonly unknown[] = value;
  if (source.length === 0 || source.length > attachmentLimits.maximumCount) return null;
  const entries: AttachmentManifestEntry[] = [];
  for (const item of source) {
    if (typeof item !== "object" || item === null) return null;
    const record = item as Readonly<Record<string, unknown>>;
    if ("bytesBase64" in record || "bytes" in record || "data" in record) return null;
    const mediaType = typeof record.mediaType === "string"
      ? normaliseMediaType(record.mediaType)
      : null;
    if (
      mediaType === null
      || typeof record.digest !== "string"
      || !digestPattern.test(record.digest)
      || typeof record.name !== "string"
      || record.name.length === 0
      || record.name.length > attachmentLimits.maximumNameCharacters * 2
      || typeof record.size !== "number"
      || !Number.isSafeInteger(record.size)
      || record.size < 0
      || record.size > attachmentLimits.maximumFileBytes
    ) return null;
    entries.push({
      digest: record.digest,
      kind: attachmentKind(mediaType),
      mediaType,
      name: attachmentDisplayName(record.name),
      size: record.size,
    });
  }
  return entries;
}

/**
 * The manifest for attachments this tab is sending, so the optimistic row and
 * the projected row describe the same thing.
 */
export function manifestForPrepared(
  attachments: readonly PreparedAttachment[],
): readonly AttachmentManifestEntry[] {
  return attachments.map((item) => ({
    digest: item.digest,
    kind: item.kind,
    mediaType: item.mediaType,
    name: item.name,
    size: item.bytes.byteLength,
  }));
}
