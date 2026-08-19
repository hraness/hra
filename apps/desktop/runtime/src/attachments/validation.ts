import { createHash } from "node:crypto";
import {
  chatMessageAttachmentIdSchema,
  chatMessageIdSchema,
  chatPaneIdSchema,
  type ChatMessageAttachmentId,
  type ChatMessageId,
  type ChatPaneProjection,
} from "../../../contracts/runtime";
import {
  CHAT_ATTACHMENT_MAX_CHUNK_BYTES,
  CHAT_ATTACHMENT_MAX_DISPLAY_NAME_UTF8_BYTES,
  CHAT_ATTACHMENT_MAX_INPUT_BYTES,
  CHAT_ATTACHMENT_MAX_MEDIA_TYPE_BYTES,
  ChatAttachmentVaultError,
  type ChatAttachmentKind,
  type ChatProviderAttachmentBindingId,
} from "./contracts";

const uploadIdPattern = /^upload_[A-Za-z0-9_-]{7,88}$/u;
const bindingIdPattern = /^attbinding_[A-Za-z0-9_-]{8,85}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const mediaTypePattern =
  /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u;
const strictBase64Pattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const unsafeDisplayCodePoints = new RegExp(
  String.raw`[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]`,
  "gu",
);

export function parseAttachmentId(value: unknown): ChatMessageAttachmentId {
  return parseOrInvalid(
    () => chatMessageAttachmentIdSchema.parse(value),
    "Attachment ID is invalid.",
  );
}

export function parsePaneId(value: unknown): ChatPaneProjection["id"] {
  return parseOrInvalid(
    () => chatPaneIdSchema.parse(value),
    "Pane ID is invalid.",
  );
}

export function parseMessageId(value: unknown): ChatMessageId {
  return parseOrInvalid(
    () => chatMessageIdSchema.parse(value),
    "Message ID is invalid.",
  );
}

export function parseUploadId(value: unknown): string {
  if (typeof value !== "string" || !uploadIdPattern.test(value)) {
    throw invalid("Upload ID is invalid.");
  }
  return value;
}

export function parseProviderBindingId(
  value: unknown,
): ChatProviderAttachmentBindingId {
  if (typeof value !== "string" || !bindingIdPattern.test(value)) {
    throw invalid("Provider attachment binding ID is invalid.");
  }
  return value;
}

export function parseSha256(value: unknown, label = "SHA-256"): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw invalid(`${label} is invalid.`);
  }
  return value;
}

export function parseRevision(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw invalid("Attachment revision is invalid.");
  }
  return value;
}

export function parseChunkOrdinal(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= Math.ceil(
      CHAT_ATTACHMENT_MAX_INPUT_BYTES / CHAT_ATTACHMENT_MAX_CHUNK_BYTES,
    )
  ) {
    throw invalid("Attachment chunk ordinal is invalid.");
  }
  return value;
}

export function parseExpectedBytes(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > CHAT_ATTACHMENT_MAX_INPUT_BYTES
  ) {
    throw invalid("Attachment byte count is outside the accepted limit.");
  }
  return value;
}

export function parseKind(value: unknown): ChatAttachmentKind {
  if (value !== "image" && value !== "file") {
    throw invalid("Attachment kind is invalid.");
  }
  return value;
}

export function parseNow(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw invalid("Attachment time is invalid.");
  }
  return value;
}

export function strictBase64Chunk(value: unknown): Buffer {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > Math.ceil(CHAT_ATTACHMENT_MAX_CHUNK_BYTES / 3) * 4 ||
    !strictBase64Pattern.test(value)
  ) {
    throw invalid("Attachment chunk is not canonical bounded base64.");
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.byteLength < 1 ||
    decoded.byteLength > CHAT_ATTACHMENT_MAX_CHUNK_BYTES ||
    decoded.toString("base64") !== value
  ) {
    throw invalid("Attachment chunk is not canonical bounded base64.");
  }
  return decoded;
}

export function sanitizeDisplayName(value: unknown): string {
  if (typeof value !== "string") {
    throw invalid("Attachment display name is invalid.");
  }
  const leaf = value.normalize("NFC").replaceAll("\\", "/").split("/").at(-1)
    ?? "";
  let sanitized = leaf
    .replace(unsafeDisplayCodePoints, "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^\.+/u, "")
    .trim();
  if (sanitized.length === 0) sanitized = "attachment";
  sanitized = truncateUtf8(sanitized, CHAT_ATTACHMENT_MAX_DISPLAY_NAME_UTF8_BYTES)
    .trim();
  if (sanitized.length === 0) return "attachment";
  return sanitized;
}

export function normalizeMediaType(value: unknown): string {
  if (typeof value !== "string") return "application/octet-stream";
  const normalized = value.trim().toLowerCase();
  if (
    Buffer.byteLength(normalized, "utf8") === 0 ||
    Buffer.byteLength(normalized, "utf8") > CHAT_ATTACHMENT_MAX_MEDIA_TYPE_BYTES ||
    !mediaTypePattern.test(normalized)
  ) {
    return "application/octet-stream";
  }
  return normalized;
}

export function internalSuffix(kind: ChatAttachmentKind, name: string): string {
  if (kind === "image") return "png";
  const candidate = name.split(".").at(-1)?.toLowerCase() ?? "";
  return /^[a-z0-9]{1,16}$/u.test(candidate) ? candidate : "bin";
}

export function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function digestOpaqueReceipt(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 512 ||
    value.includes("\0")
  ) {
    throw invalid(`${label} is invalid.`);
  }
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function exactBindingKeyDigest(value: unknown): string {
  return parseSha256(value, "Provider attachment binding digest");
}

function truncateUtf8(value: string, maximumBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const codePoint of value) {
    const nextBytes = Buffer.byteLength(codePoint, "utf8");
    if (bytes + nextBytes > maximumBytes) break;
    result += codePoint;
    bytes += nextBytes;
  }
  return result;
}

function parseOrInvalid<T>(parse: () => T, message: string): T {
  try {
    return parse();
  } catch {
    throw invalid(message);
  }
}

function invalid(message: string): ChatAttachmentVaultError {
  return new ChatAttachmentVaultError("invalid_input", message);
}
