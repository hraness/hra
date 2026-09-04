import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  ATTACHMENT_INLINE_TEXT_MAX_BYTES,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MEDIA_TYPES,
  ATTACHMENT_MESSAGE_MAX_TOTAL_BYTES,
  acceptAttachmentBytes,
  attachmentBlobExtension,
  attachmentFencedText,
  attachmentMediaTypeForName,
  attachmentMessageText,
  canonicalAttachmentMediaType,
  formatAttachmentSize,
  isAttachmentName,
  sniffAttachmentBytes,
  type PreparedAttachment,
} from "./attachments";
import {
  attachmentNameSchema,
  attachmentReferenceListSchema,
} from "./attachment-schemas";

// The domain module is reachable from the browser bundle and therefore holds
// no hashing of its own; the digest is computed here the way the blob store
// computes it.
const attachmentDigest = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const bytes = (...values: readonly number[]): Uint8Array => new Uint8Array(values);
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

/*
 * Every image fixture is assembled from a byte array here. The repository
 * commits no binary file, and a signature is all any admission decision reads.
 */
const png = (): Uint8Array =>
  bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52);
const jpeg = (): Uint8Array => bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46);
const gif = (): Uint8Array => new Uint8Array([...utf8("GIF89a"), 0x01, 0x00, 0x01, 0x00]);
const webp = (): Uint8Array =>
  new Uint8Array([...utf8("RIFF"), 0x1a, 0x00, 0x00, 0x00, ...utf8("WEBPVP8 ")]);
/** A Mach-O executable header. Renaming it `.txt` must not make it text. */
const machO = (): Uint8Array => bytes(0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01, 0x00, 0x00);

describe("attachment sniffing", () => {
  test("classifies each accepted image by its leading bytes", () => {
    expect(sniffAttachmentBytes(png())).toEqual({ kind: "image", mediaType: "image/png" });
    expect(sniffAttachmentBytes(jpeg())).toEqual({ kind: "image", mediaType: "image/jpeg" });
    expect(sniffAttachmentBytes(gif())).toEqual({ kind: "image", mediaType: "image/gif" });
    expect(sniffAttachmentBytes(webp())).toEqual({ kind: "image", mediaType: "image/webp" });
  });

  test("classifies UTF-8 text and refuses binary and empty bytes", () => {
    expect(sniffAttachmentBytes(utf8("hello\n\tworld — ok"))).toEqual({ kind: "text" });
    expect(sniffAttachmentBytes(machO())).toBeNull();
    expect(sniffAttachmentBytes(bytes())).toBeNull();
    // A lone continuation byte is not valid UTF-8.
    expect(sniffAttachmentBytes(bytes(0x80, 0x81))).toBeNull();
  });

  test("canonicalizes every text-ish media type onto one blob identity", () => {
    expect(canonicalAttachmentMediaType(utf8("a,b\n1,2"))).toBe("text/plain");
    expect(canonicalAttachmentMediaType(png())).toBe("image/png");
    expect(canonicalAttachmentMediaType(machO())).toBeNull();
  });
});

describe("attachment admission", () => {
  test("accepts an image only under its own media type", () => {
    expect(acceptAttachmentBytes("image/png", png())).toEqual({
      canonicalMediaType: "image/png",
      ok: true,
      text: null,
    });
    const mismatch = acceptAttachmentBytes("image/jpeg", png());
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.reason).toBe("MEDIA_TYPE_MISMATCH");
  });

  test("refuses a renamed executable however it is declared", () => {
    for (const mediaType of ATTACHMENT_MEDIA_TYPES) {
      const outcome = acceptAttachmentBytes(mediaType, machO());
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(["UNSUPPORTED_BYTES", "MEDIA_TYPE_MISMATCH"]).toContain(outcome.reason);
      }
    }
  });

  test("refuses text bytes declared as an image, and invalid JSON", () => {
    const asImage = acceptAttachmentBytes("image/png", utf8("not a png"));
    expect(asImage.ok).toBe(false);
    if (!asImage.ok) expect(asImage.reason).toBe("MEDIA_TYPE_MISMATCH");
    const badJson = acceptAttachmentBytes("application/json", utf8("{"));
    expect(badJson.ok).toBe(false);
    if (!badJson.ok) expect(badJson.reason).toBe("INVALID_JSON");
    expect(acceptAttachmentBytes("application/json", utf8(`{"a":1}`)).ok).toBe(true);
  });

  test("bounds emptiness and size", () => {
    const empty = acceptAttachmentBytes("text/plain", bytes());
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toBe("EMPTY");
    const large = new Uint8Array(ATTACHMENT_MAX_BYTES + 1).fill(0x61);
    const refused = acceptAttachmentBytes("text/plain", large);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("TOO_LARGE");
  });
});

describe("attachment names and media types", () => {
  test("refuses a path, a traversal, and a control character", () => {
    expect(isAttachmentName("diagram.png")).toBe(true);
    expect(isAttachmentName("a b.png")).toBe(true);
    expect(isAttachmentName("../etc/passwd")).toBe(false);
    expect(isAttachmentName("dir/file.png")).toBe(false);
    expect(isAttachmentName("dir\\file.png")).toBe(false);
    expect(isAttachmentName("..")).toBe(false);
    expect(isAttachmentName(".")).toBe(false);
    expect(isAttachmentName("")).toBe(false);
    expect(isAttachmentName(`bell${String.fromCodePoint(0x07)}.png`)).toBe(false);
    expect(attachmentNameSchema.safeParse("x".repeat(256)).success).toBe(false);
  });

  test("maps reviewed extensions and refuses everything else", () => {
    expect(attachmentMediaTypeForName("a.png")).toBe("image/png");
    expect(attachmentMediaTypeForName("a.JPG")).toBe("image/jpeg");
    expect(attachmentMediaTypeForName("notes.md")).toBe("text/markdown");
    expect(attachmentMediaTypeForName("rows.csv")).toBe("text/csv");
    expect(attachmentMediaTypeForName("config.json")).toBe("application/json");
    expect(attachmentMediaTypeForName("main.rs")).toBe("text/plain");
    expect(attachmentMediaTypeForName("installer.dmg")).toBeNull();
    expect(attachmentMediaTypeForName("library.so")).toBeNull();
    expect(attachmentMediaTypeForName("noextension")).toBeNull();
    expect(attachmentMediaTypeForName(".hidden")).toBeNull();
  });

  test("derives a blob extension from the canonical media type", () => {
    expect(attachmentBlobExtension("image/png")).toBe("png");
    expect(attachmentBlobExtension("image/jpeg")).toBe("jpg");
    expect(attachmentBlobExtension("text/plain")).toBe("txt");
    expect(attachmentBlobExtension("application/json")).toBe("txt");
  });
});

describe("attachment reference bounds", () => {
  const reference = (index: number, byteLength: number) => ({
    byteLength,
    digest: attachmentDigest(utf8(`blob-${String(index)}`)),
    mediaType: "text/plain" as const,
    name: `file-${String(index)}.txt`,
  });

  test("accepts up to the count bound and refuses one more", () => {
    const within = Array.from({ length: ATTACHMENT_MAX_COUNT }, (_, index) => reference(index, 10));
    expect(attachmentReferenceListSchema.safeParse(within).success).toBe(true);
    const over = [...within, reference(ATTACHMENT_MAX_COUNT, 10)];
    expect(attachmentReferenceListSchema.safeParse(over).success).toBe(false);
  });

  test("refuses a message whose attachments exceed the total bound", () => {
    const half = Math.trunc(ATTACHMENT_MESSAGE_MAX_TOTAL_BYTES / 2) + 1;
    const values = [reference(0, half), reference(1, half)];
    expect(attachmentReferenceListSchema.safeParse(values).success).toBe(false);
  });

  test("refuses a repeated name and digest, and an unknown key", () => {
    const one = reference(0, 10);
    expect(attachmentReferenceListSchema.safeParse([one, { ...one }]).success).toBe(false);
    expect(attachmentReferenceListSchema.safeParse([{ ...one, extra: 1 }]).success).toBe(false);
  });
});

describe("provider text folding", () => {
  const textAttachment = (
    text: string,
    name = "notes.md",
  ): Extract<PreparedAttachment, { kind: "text" }> => ({
    byteLength: new TextEncoder().encode(text).byteLength,
    digest: attachmentDigest(utf8(text)),
    kind: "text",
    mediaType: "text/markdown",
    name,
    path: "/dev/null",
    text,
  });

  test("leaves a message with no attachment byte-identical", () => {
    expect(attachmentMessageText("hello", [])).toBe("hello");
  });

  test("names the file and fences past the file's own backticks", () => {
    const fenced = attachmentFencedText(textAttachment("a\n```\nb"));
    expect(fenced.startsWith("Attached file: notes.md (text/markdown, 7 bytes)\n````\n")).toBe(true);
    expect(fenced.endsWith("\n````")).toBe(true);
  });

  test("bounds the inlined prefix and says how much was left out", () => {
    const oversized = "x".repeat(ATTACHMENT_INLINE_TEXT_MAX_BYTES + 100);
    const fenced = attachmentFencedText(textAttachment(oversized, "big.txt"));
    expect(fenced).toContain("[100 further UTF-8 bytes of big.txt were not inlined]");
    expect(fenced.length).toBeLessThan(ATTACHMENT_INLINE_TEXT_MAX_BYTES + 400);
  });

  test("appends one block per text attachment, in order", () => {
    const folded = attachmentMessageText("look", [
      textAttachment("one", "a.md"),
      textAttachment("two", "b.md"),
    ]);
    expect(folded.indexOf("a.md")).toBeGreaterThan(folded.indexOf("look"));
    expect(folded.indexOf("b.md")).toBeGreaterThan(folded.indexOf("a.md"));
  });
});

test("formats a size for humans and never for a digest", () => {
  expect(formatAttachmentSize(512)).toBe("512 B");
  expect(formatAttachmentSize(2048)).toBe("2.0 KB");
  expect(formatAttachmentSize(5 * 1024 * 1024)).toBe("5.0 MB");
});
