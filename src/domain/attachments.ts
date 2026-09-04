/*
 * Attachments.
 *
 * An attachment is bytes plus a presentation: the bytes are content-addressed
 * and live out of band (see `src/storage/attachment-store.ts`), and a message
 * carries only a bounded reference to them. Nothing in this module ever holds
 * a filesystem path: a path is a local custody concern, and a reference that
 * crossed a device boundary must never be able to name one.
 *
 * This module holds no dependency at all, not even zod: it is reachable from
 * the browser bundle through `src/cloud/payloads.ts`, and the app must not
 * pay for a schema library or a Node built-in to know what an attachment is.
 * The parsing schemas live beside it in `attachment-schemas.ts`, and the
 * digest is computed where the bytes live, in
 * `src/storage/attachment-store.ts`.
 *
 * Two media types exist for every attachment and they are deliberately
 * different things:
 *
 * - the *canonical* media type is derived from the leading bytes alone. It is
 *   what makes the store content-addressed, and it is what a renamed
 *   executable cannot forge.
 * - the *declared* media type is what the caller says the file is. It must be
 *   consistent with the canonical one, it distinguishes text-ish files from
 *   one another (`.md` and `.csv` sniff identically), and it is what reaches
 *   the provider and the user.
 */

/** At most this many attachments may ride on one message. */
export const ATTACHMENT_MAX_COUNT = 8;
/** Upper bound on one attachment, in bytes. */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
/** Upper bound on every attachment on one message, in bytes. */
export const ATTACHMENT_MESSAGE_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
/** Upper bound on an attachment file name, in UTF-8 bytes. */
export const ATTACHMENT_NAME_MAX_BYTES = 255;

export const ATTACHMENT_IMAGE_MEDIA_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const);

export const ATTACHMENT_TEXT_MEDIA_TYPES = Object.freeze([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
] as const);

export const ATTACHMENT_MEDIA_TYPES = Object.freeze([
  ...ATTACHMENT_IMAGE_MEDIA_TYPES,
  ...ATTACHMENT_TEXT_MEDIA_TYPES,
] as const);

export type AttachmentImageMediaType = (typeof ATTACHMENT_IMAGE_MEDIA_TYPES)[number];
export type AttachmentTextMediaType = (typeof ATTACHMENT_TEXT_MEDIA_TYPES)[number];
export type AttachmentMediaType = AttachmentImageMediaType | AttachmentTextMediaType;

export function isAttachmentMediaType(value: unknown): value is AttachmentMediaType {
  return typeof value === "string"
    && (ATTACHMENT_MEDIA_TYPES as readonly string[]).includes(value);
}

export function isAttachmentImageMediaType(
  value: AttachmentMediaType,
): value is AttachmentImageMediaType {
  return (ATTACHMENT_IMAGE_MEDIA_TYPES as readonly string[]).includes(value);
}

const encoder = new TextEncoder();

const utf8Bytes = (value: string): number => encoder.encode(value).byteLength;

const attachmentDigestPattern = /^[0-9a-f]{64}$/u;

/** Lower-case hex SHA-256 of the exact bytes. */
export function isAttachmentDigest(value: unknown): value is string {
  return typeof value === "string" && attachmentDigestPattern.test(value);
}

/*
 * A file name, never a path. Separators, control scalars, and the two
 * traversal names are refused here so no later consumer has to re-derive
 * that a name is safe to render, log, or project.
 */
export function isAttachmentName(value: string): boolean {
  if (value.length === 0 || value === "." || value === "..") return false;
  if (utf8Bytes(value) > ATTACHMENT_NAME_MAX_BYTES) return false;
  for (const scalar of value) {
    if (scalar === "/" || scalar === "\\") return false;
    const code = scalar.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * What a message carries. The bytes are elsewhere; this is the whole wire and
 * command shape. `attachment-schemas.ts` parses it.
 */
export type AttachmentReference = Readonly<{
  byteLength: number;
  digest: string;
  mediaType: AttachmentMediaType;
  name: string;
}>;

/** What the leading bytes prove, independent of any declared media type. */
export type AttachmentSniff =
  | Readonly<{ kind: "image"; mediaType: AttachmentImageMediaType }>
  | Readonly<{ kind: "text" }>;

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean => {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
};

const asciiAt = (bytes: Uint8Array, offset: number, text: string): boolean => {
  if (bytes.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
};

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const jpegSignature = [0xff, 0xd8, 0xff];

const textDecoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Decodes strict UTF-8 with no C0 control scalar other than tab, newline, and
 * carriage return. A renamed executable fails here even when its name and
 * declared media type say `text/plain`.
 */
function decodeTextish(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = textDecoder.decode(bytes);
  } catch {
    return null;
  }
  for (const scalar of text) {
    const code = scalar.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code < 0x20 || code === 0x7f) return null;
  }
  return text;
}

/** Classifies the leading bytes. `null` means "not an accepted attachment". */
export function sniffAttachmentBytes(bytes: Uint8Array): AttachmentSniff | null {
  if (bytes.length === 0) return null;
  if (startsWith(bytes, pngSignature)) return { kind: "image", mediaType: "image/png" };
  if (startsWith(bytes, jpegSignature)) return { kind: "image", mediaType: "image/jpeg" };
  if (asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")) {
    return { kind: "image", mediaType: "image/gif" };
  }
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) {
    return { kind: "image", mediaType: "image/webp" };
  }
  return decodeTextish(bytes) === null ? null : { kind: "text" };
}

/**
 * The canonical, bytes-derived media type. Text-ish bytes canonicalize to
 * `text/plain` regardless of what the caller declared, so one blob has exactly
 * one canonical type and the store stays content-addressed.
 */
export function canonicalAttachmentMediaType(bytes: Uint8Array): AttachmentMediaType | null {
  const sniff = sniffAttachmentBytes(bytes);
  if (sniff === null) return null;
  return sniff.kind === "image" ? sniff.mediaType : "text/plain";
}

export type AttachmentRefusalReason =
  | "EMPTY"
  | "TOO_LARGE"
  | "UNSUPPORTED_BYTES"
  | "MEDIA_TYPE_MISMATCH"
  | "INVALID_JSON";

export type AttachmentAcceptance =
  | Readonly<{ canonicalMediaType: AttachmentMediaType; ok: true; text: string | null }>
  | Readonly<{ message: string; ok: false; reason: AttachmentRefusalReason }>;

/**
 * The single admission decision for one attachment's bytes. Every ingest path
 * — the CLI, the daemon, and the hosted bridge — runs exactly this.
 */
export function acceptAttachmentBytes(
  declaredMediaType: AttachmentMediaType,
  bytes: Uint8Array,
): AttachmentAcceptance {
  if (bytes.length === 0) {
    return { message: "An attachment must not be empty.", ok: false, reason: "EMPTY" };
  }
  if (bytes.length > ATTACHMENT_MAX_BYTES) {
    return {
      message: `An attachment must be at most ${String(ATTACHMENT_MAX_BYTES)} bytes.`,
      ok: false,
      reason: "TOO_LARGE",
    };
  }
  const sniff = sniffAttachmentBytes(bytes);
  if (sniff === null) {
    return {
      message: "Only PNG, JPEG, GIF, and WebP images and UTF-8 text files are accepted; those bytes are neither.",
      ok: false,
      reason: "UNSUPPORTED_BYTES",
    };
  }
  if (sniff.kind === "image") {
    if (declaredMediaType !== sniff.mediaType) {
      return {
        message: `Those bytes are ${sniff.mediaType}, not ${declaredMediaType}.`,
        ok: false,
        reason: "MEDIA_TYPE_MISMATCH",
      };
    }
    return { canonicalMediaType: sniff.mediaType, ok: true, text: null };
  }
  if (isAttachmentImageMediaType(declaredMediaType)) {
    return {
      message: `Those bytes are not ${declaredMediaType}.`,
      ok: false,
      reason: "MEDIA_TYPE_MISMATCH",
    };
  }
  const text = decodeTextish(bytes);
  if (text === null) {
    return {
      message: "A text attachment must be valid UTF-8 without control characters.",
      ok: false,
      reason: "UNSUPPORTED_BYTES",
    };
  }
  if (declaredMediaType === "application/json") {
    try {
      JSON.parse(text);
    } catch {
      return {
        message: "An application/json attachment must contain one valid JSON document.",
        ok: false,
        reason: "INVALID_JSON",
      };
    }
  }
  return { canonicalMediaType: "text/plain", ok: true, text };
}

/*
 * The blob file name extension. It is a function of the canonical media type
 * and therefore of the bytes, so the store stays content-addressed while the
 * Codex app-server still sees an image path it can recognise.
 */
const blobExtensions: Readonly<Record<AttachmentMediaType, string>> = Object.freeze({
  "application/json": "txt",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "text/csv": "txt",
  "text/markdown": "txt",
  "text/plain": "txt",
});

export function attachmentBlobExtension(canonicalMediaType: AttachmentMediaType): string {
  return blobExtensions[canonicalMediaType];
}

/** Maps a file name to the media type the caller means by it. */
const extensionMediaTypes: Readonly<Record<string, AttachmentMediaType>> = Object.freeze({
  bash: "text/plain",
  c: "text/plain",
  cc: "text/plain",
  cfg: "text/plain",
  clj: "text/plain",
  conf: "text/plain",
  cpp: "text/plain",
  cs: "text/plain",
  css: "text/plain",
  csv: "text/csv",
  dart: "text/plain",
  diff: "text/plain",
  ex: "text/plain",
  exs: "text/plain",
  fish: "text/plain",
  gif: "image/gif",
  go: "text/plain",
  gradle: "text/plain",
  graphql: "text/plain",
  h: "text/plain",
  hpp: "text/plain",
  hs: "text/plain",
  htm: "text/plain",
  html: "text/plain",
  ini: "text/plain",
  java: "text/plain",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/plain",
  json: "application/json",
  jsonc: "text/plain",
  jsx: "text/plain",
  kt: "text/plain",
  lua: "text/plain",
  m: "text/plain",
  markdown: "text/markdown",
  md: "text/markdown",
  mjs: "text/plain",
  ml: "text/plain",
  mm: "text/plain",
  patch: "text/plain",
  php: "text/plain",
  pl: "text/plain",
  png: "image/png",
  proto: "text/plain",
  ps1: "text/plain",
  py: "text/plain",
  r: "text/plain",
  rb: "text/plain",
  rs: "text/plain",
  scala: "text/plain",
  sh: "text/plain",
  sql: "text/plain",
  svelte: "text/plain",
  swift: "text/plain",
  text: "text/plain",
  toml: "text/plain",
  ts: "text/plain",
  tsv: "text/csv",
  tsx: "text/plain",
  txt: "text/plain",
  vue: "text/plain",
  webp: "image/webp",
  xml: "text/plain",
  yaml: "text/plain",
  yml: "text/plain",
  zig: "text/plain",
  zsh: "text/plain",
});

/**
 * The declared media type for a file name, or `null` when the extension is not
 * on the reviewed list. Refusing by name first keeps a `.dmg` or a `.so` out
 * before its bytes are ever read.
 */
export function attachmentMediaTypeForName(name: string): AttachmentMediaType | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  return extensionMediaTypes[extension] ?? null;
}

/** The reviewed extension list, for help text and documentation. */
export function attachmentFileExtensions(): readonly string[] {
  return Object.keys(extensionMediaTypes).sort();
}

/**
 * One attachment resolved against local custody: the bytes are in hand, so a
 * provider adapter never touches the filesystem or the store.
 */
export type PreparedAttachment =
  | Readonly<{
      base64: string;
      byteLength: number;
      digest: string;
      kind: "image";
      mediaType: AttachmentImageMediaType;
      name: string;
      path: string;
    }>
  | Readonly<{
      byteLength: number;
      digest: string;
      kind: "text";
      mediaType: AttachmentTextMediaType;
      name: string;
      path: string;
      text: string;
    }>;

/** A fence long enough that the attachment's own backtick runs cannot close it. */
function fenceFor(text: string): string {
  let longest = 0;
  let run = 0;
  for (const scalar of text) {
    run = scalar === "`" ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * Upper bound on how much of one text-ish attachment is inlined into a prompt.
 * A larger file is still stored and still named in every manifest; only the
 * inlined prefix is bounded, so eight attachments plus a full-size message
 * always stay inside the providers' own request bounds.
 */
export const ATTACHMENT_INLINE_TEXT_MAX_BYTES = 64 * 1024;

/** The inlined prefix of a text attachment, cut on a scalar boundary. */
export function attachmentInlineText(
  text: string,
  maximumBytes = ATTACHMENT_INLINE_TEXT_MAX_BYTES,
): Readonly<{ text: string; truncatedBytes: number }> {
  const total = utf8Bytes(text);
  if (total <= maximumBytes) return { text, truncatedBytes: 0 };
  let prefix = "";
  let bytes = 0;
  for (const scalar of text) {
    const scalarBytes = utf8Bytes(scalar);
    if (bytes + scalarBytes > maximumBytes) break;
    prefix += scalar;
    bytes += scalarBytes;
  }
  return { text: prefix, truncatedBytes: total - bytes };
}

/**
 * How a text-ish attachment reaches a provider that has no file content item:
 * a header naming the file, then its bytes inside a fence long enough that the
 * file's own backtick runs cannot close it.
 */
export function attachmentFencedText(
  attachment: Extract<PreparedAttachment, { kind: "text" }>,
): string {
  const inlined = attachmentInlineText(attachment.text);
  const fence = fenceFor(inlined.text);
  return [
    `Attached file: ${attachment.name} (${attachment.mediaType}, ${String(attachment.byteLength)} bytes)`,
    fence,
    inlined.text,
    fence,
    ...(inlined.truncatedBytes === 0
      ? []
      : [`[${String(inlined.truncatedBytes)} further UTF-8 bytes of ${attachment.name} were not inlined]`]),
  ].join("\n");
}

/**
 * The message text a provider sees. With no text-ish attachment this returns
 * the message unchanged, so every existing text path stays byte-identical.
 */
export function attachmentMessageText(
  message: string,
  attachments: readonly PreparedAttachment[],
): string {
  const blocks = attachments
    .filter((attachment): attachment is Extract<PreparedAttachment, { kind: "text" }> =>
      attachment.kind === "text")
    .map(attachmentFencedText);
  return blocks.length === 0 ? message : [message, ...blocks].join("\n\n");
}

/** The bounded, byte-free manifest a projection or a renderer may carry. */
export type AttachmentManifestEntry = AttachmentReference;

export function attachmentReferenceOf(
  attachment: PreparedAttachment,
): AttachmentManifestEntry {
  return {
    byteLength: attachment.byteLength,
    digest: attachment.digest,
    mediaType: attachment.mediaType,
    name: attachment.name,
  };
}

/** `12.3 KB`, for human output only. Never used in a digest or a wire value. */
export function formatAttachmentSize(byteLength: number): string {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) return "unknown size";
  if (byteLength < 1024) return `${String(byteLength)} B`;
  const kilobytes = byteLength / 1024;
  if (kilobytes < 1024) return `${kilobytes.toFixed(1)} KB`;
  return `${(kilobytes / 1024).toFixed(1)} MB`;
}
