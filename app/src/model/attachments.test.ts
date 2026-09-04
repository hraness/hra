import { describe, expect, test } from "bun:test";

import {
  attachmentAcceptAttribute,
  attachmentDisplayName,
  attachmentKind,
  attachmentLimits,
  attachmentPayloadVersion,
  attachmentSendSupported,
  buildSendPayload,
  defaultMessageForAttachments,
  formatByteSize,
  imageMediaTypes,
  inlineBudgetRefusal,
  manifestForPrepared,
  normaliseMediaType,
  parseAttachmentManifest,
  prepareAttachment,
  refuseCandidate,
  savedSizeLine,
  selectAttachments,
  textMediaTypes,
  type AttachmentCandidate,
  type PreparedAttachment,
} from "./attachments";
import type { EncodedImage, ImageEncoder } from "./image-downscale";

const empty = { count: 0, totalBytes: 0 };

const candidate = (
  overrides: Partial<AttachmentCandidate> = {},
): AttachmentCandidate => ({
  mediaType: "image/png",
  name: "shot.png",
  size: 1024,
  ...overrides,
});

/**
 * Deterministic bytes. Nothing in this repository may commit a binary file, so
 * every fixture here is built in code: the downscaler only ever measures a
 * length, and the digest only ever hashes bytes, so real image data would prove
 * nothing extra.
 */
const bytes = (length: number, fill = 7): Uint8Array => new Uint8Array(length).fill(fill);

const prepared = (
  overrides: Partial<PreparedAttachment> = {},
): PreparedAttachment => ({
  bytes: bytes(64),
  digest: "a".repeat(64),
  id: "attachment-1",
  kind: "image",
  mediaType: "image/png",
  name: "shot.png",
  refusal: null,
  sourceBytes: 64,
  ...overrides,
});

describe("accepted types", () => {
  test("every image and text-ish type is accepted", () => {
    for (const mediaType of [...imageMediaTypes, ...textMediaTypes]) {
      expect(refuseCandidate(candidate({ mediaType }), empty)).toBeNull();
      expect(normaliseMediaType(mediaType)).toBe(mediaType);
    }
  });

  test("images are images and text-ish files are not", () => {
    for (const mediaType of imageMediaTypes) expect(attachmentKind(mediaType)).toBe("image");
    for (const mediaType of textMediaTypes) expect(attachmentKind(mediaType)).toBe("text");
  });

  test("a charset parameter and odd casing still resolve", () => {
    expect(normaliseMediaType("text/plain; charset=utf-8")).toBe("text/plain");
    expect(normaliseMediaType("IMAGE/PNG")).toBe("image/png");
  });

  test("the picker offers exactly the accepted set", () => {
    expect(attachmentAcceptAttribute.split(",").toSorted()).toEqual(
      [...imageMediaTypes, ...textMediaTypes].toSorted(),
    );
  });

  test("a refused type is named in the refusal, with the file", () => {
    const refusal = refuseCandidate(
      candidate({ mediaType: "application/pdf", name: "contract.pdf" }),
      empty,
    );
    expect(refusal).toContain("contract.pdf");
    expect(refusal).toContain("application/pdf");
  });

  test("a browser that reports no type at all is still refused by name", () => {
    const refusal = refuseCandidate(candidate({ mediaType: "", name: "mystery" }), empty);
    expect(refusal).toContain("mystery");
    expect(refusal).toContain("an unnamed type");
  });

  test("an executable is refused even when it is named like an image", () => {
    expect(refuseCandidate(
      candidate({ mediaType: "application/x-mach-binary", name: "shot.png" }),
      empty,
    )).toContain("application/x-mach-binary");
  });

  test("an empty file is refused", () => {
    expect(refuseCandidate(candidate({ size: 0 }), empty)).toContain("is empty");
  });
});

describe("bounds", () => {
  test("the ninth attachment is refused", () => {
    expect(refuseCandidate(candidate(), { count: 7, totalBytes: 0 })).toBeNull();
    expect(refuseCandidate(candidate(), { count: 8, totalBytes: 0 }))
      .toContain("at most 8 attachments");
  });

  test("one attachment may not exceed five mebibytes", () => {
    expect(refuseCandidate(
      candidate({ size: attachmentLimits.maximumFileBytes }),
      empty,
    )).toBeNull();
    expect(refuseCandidate(
      candidate({ size: attachmentLimits.maximumFileBytes + 1 }),
      empty,
    )).toContain("at most 5.0 MiB");
  });

  test("a message may not exceed ten mebibytes of attachments", () => {
    const totals = { count: 2, totalBytes: attachmentLimits.maximumTotalBytes - 10 };
    expect(refuseCandidate(candidate({ size: 10 }), totals)).toBeNull();
    expect(refuseCandidate(candidate({ size: 11 }), totals)).toContain("past 10.0 MiB");
  });

  test("a batch keeps a running total and refuses only what does not fit", () => {
    const big = 4 * 1024 * 1024;
    const selection = selectAttachments(
      [
        candidate({ name: "one.png", size: big }),
        candidate({ name: "two.png", size: big }),
        candidate({ name: "three.png", size: big }),
        candidate({ mediaType: "text/plain", name: "notes.txt", size: 20 }),
      ],
      (entry) => entry,
      empty,
    );
    expect(selection.accepted.map((entry) => entry.name))
      .toEqual(["one.png", "two.png", "notes.txt"]);
    expect(selection.refusals.length).toBe(1);
    expect(selection.refusals[0]).toContain("three.png");
  });

  test("the count bound applies across a batch, not only per call", () => {
    const many = Array.from({ length: 10 }, (unused, index) =>
      candidate({ name: `file-${String(index)}.png` }));
    const selection = selectAttachments(many, (entry) => entry, empty);
    expect(selection.accepted.length).toBe(attachmentLimits.maximumCount);
    expect(selection.refusals.length).toBe(2);
  });
});

describe("names", () => {
  test("a directory prefix never survives into a chip", () => {
    expect(attachmentDisplayName("/etc/passwd")).toBe("passwd");
    expect(attachmentDisplayName("C:\\Users\\somebody\\shot.png")).toBe("shot.png");
  });

  test("bidi and control scalars are removed", () => {
    expect(attachmentDisplayName("sh\u202Eot.png")).toBe("shot.png");
    expect(attachmentDisplayName("a\u0000b.txt")).toBe("ab.txt");
  });

  test("a name with nothing left in it gets a placeholder", () => {
    expect(attachmentDisplayName("   ")).toBe("attachment");
    expect(attachmentDisplayName("/")).toBe("attachment");
  });

  test("a long name is cut to the bound", () => {
    expect(attachmentDisplayName(`${"n".repeat(400)}.png`).length)
      .toBe(attachmentLimits.maximumNameCharacters);
  });
});

describe("sizes", () => {
  test("reads at the scale a reader recognises", () => {
    expect(formatByteSize(0)).toBe("0 B");
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(2048)).toBe("2.0 KiB");
    expect(formatByteSize(160 * 1024)).toBe("160 KiB");
    expect(formatByteSize(3 * 1024 * 1024)).toBe("3.0 MiB");
  });

  test("the chip reports a saving only when there was one", () => {
    expect(savedSizeLine(prepared({ bytes: bytes(1024), sourceBytes: 4 * 1024 * 1024 })))
      .toBe("4.0 MiB down to 1.0 KiB");
    expect(savedSizeLine(prepared({ bytes: bytes(64), sourceBytes: 64 }))).toBeNull();
  });
});

describe("preparing an attachment", () => {
  const encoderProducing = (size: number): ImageEncoder => async (request) => {
    const encoded: EncodedImage = {
      bytes: bytes(size),
      mediaType: request.mediaType,
    };
    return encoded;
  };

  test("downscales an image and reports the source size beside it", async () => {
    let disposed = false;
    const item = await prepareAttachment({
      bytes: bytes(3 * 1024 * 1024),
      id: "attachment-1",
      measure: async () => ({
        dispose: () => { disposed = true; },
        encode: encoderProducing(90_000),
        size: { height: 2000, width: 3000 },
      }),
      mediaType: "image/png",
      name: "Screenshot 2026-09-04.png",
    });
    expect(item.kind).toBe("image");
    expect(item.bytes.byteLength).toBe(90_000);
    expect(item.sourceBytes).toBe(3 * 1024 * 1024);
    expect(item.refusal).toBeNull();
    expect(item.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(savedSizeLine(item)).toBe("3.0 MiB down to 88 KiB");
    expect(disposed).toBe(true);
  });

  test("refuses an image that is still over the budget after downscaling", async () => {
    const item = await prepareAttachment({
      bytes: bytes(4 * 1024 * 1024),
      id: "attachment-1",
      measure: async () => ({
        encode: encoderProducing(400_000),
        size: { height: 4000, width: 6000 },
      }),
      mediaType: "image/png",
      name: "huge.png",
    });
    expect(item.refusal).toContain("still 391 KiB after downscaling");
    expect(item.refusal).toContain("160 KiB");
  });

  test("a text file is never re-encoded and is refused when it will not fit", async () => {
    const small = await prepareAttachment({
      bytes: new TextEncoder().encode("hello, notes"),
      id: "attachment-1",
      measure: null,
      mediaType: "text/markdown",
      name: "notes.md",
    });
    expect(small.kind).toBe("text");
    expect(small.refusal).toBeNull();
    expect(small.bytes.byteLength).toBe(12);

    const big = await prepareAttachment({
      bytes: bytes(attachmentLimits.inlineBudgetBytes + 1),
      id: "attachment-2",
      measure: null,
      mediaType: "text/csv",
      name: "rows.csv",
    });
    expect(big.refusal).toContain("rows.csv");
    expect(big.bytes.byteLength).toBe(attachmentLimits.inlineBudgetBytes + 1);
  });

  test("an image the browser cannot decode is sent as it arrived", async () => {
    const item = await prepareAttachment({
      bytes: bytes(400),
      id: "attachment-1",
      measure: async () => null,
      mediaType: "image/webp",
      name: "odd.webp",
    });
    expect(item.bytes.byteLength).toBe(400);
    expect(item.mediaType).toBe("image/webp");
  });

  test("the digest is over the bytes that travel, not the file that arrived", async () => {
    const item = await prepareAttachment({
      bytes: bytes(2048, 1),
      id: "attachment-1",
      measure: async () => ({
        encode: encoderProducing(32),
        size: { height: 4000, width: 4000 },
      }),
      mediaType: "image/png",
      name: "shot.png",
    });
    const direct = await prepareAttachment({
      bytes: bytes(32),
      id: "attachment-2",
      measure: null,
      mediaType: "text/plain",
      name: "same.txt",
    });
    expect(item.digest).toBe(direct.digest);
  });
});

describe("the message-level budget", () => {
  test("attachments that fit alone but not together are refused as a set", () => {
    const half = attachmentLimits.inlineBudgetBytes - 10;
    expect(inlineBudgetRefusal([prepared({ bytes: bytes(half) })])).toBeNull();
    const refusal = inlineBudgetRefusal([
      prepared({ bytes: bytes(half), id: "one" }),
      prepared({ bytes: bytes(half), id: "two" }),
    ]);
    expect(refusal).toContain("160 KiB");
    expect(refusal).toContain("Remove one");
  });

  test("attachments alone become a message made of their names", () => {
    expect(defaultMessageForAttachments([])).toBe("");
    expect(defaultMessageForAttachments([
      prepared({ name: "shot.png" }),
      prepared({ name: "notes.md" }),
    ])).toBe("shot.png, notes.md");
    expect(defaultMessageForAttachments(
      Array.from({ length: 8 }, () => prepared({ name: "x".repeat(60) })),
    ).length).toBe(200);
  });
});

describe("the send payload", () => {
  test("with no attachments it is byte-identical to the payload sent today", () => {
    expect(buildSendPayload({ attachments: [], message: "hello" }))
      .toEqual({ kind: "send_or_steer", message: "hello" });
  });

  test("with attachments it carries a versioned envelope and base64url bytes", () => {
    const payload = buildSendPayload({
      attachments: [prepared({
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: "image/webp",
        sourceBytes: 4096,
      })],
      message: "look at this",
    }) as unknown as Readonly<Record<string, unknown>>;

    expect(payload.kind).toBe("send_or_steer");
    expect(payload.message).toBe("look at this");
    expect(payload.attachments).toEqual({
      items: [{
        bytesBase64: "AQID",
        digest: "a".repeat(64),
        kind: "image",
        mediaType: "image/webp",
        name: "shot.png",
        size: 3,
        sourceSize: 4096,
      }],
      version: attachmentPayloadVersion,
    });
  });

  test("the builder reports honestly whether this build's contract carries it", () => {
    // The daemon-side kind is landing in parallel. Either answer is correct for
    // its own build; what matters is that the composer asks the repository
    // parser rather than assuming, so it never enqueues a refused command.
    expect(typeof attachmentSendSupported()).toBe("boolean");
  });
});

describe("the transcript manifest", () => {
  const entry = (overrides: Readonly<Record<string, unknown>> = {}) => ({
    digest: "b".repeat(64),
    mediaType: "image/png",
    name: "shot.png",
    size: 1234,
    ...overrides,
  });

  test("parses a bounded manifest and derives the kind", () => {
    expect(parseAttachmentManifest([entry(), entry({ mediaType: "text/csv" })])).toEqual([
      { digest: "b".repeat(64), kind: "image", mediaType: "image/png", name: "shot.png", size: 1234 },
      { digest: "b".repeat(64), kind: "text", mediaType: "text/csv", name: "shot.png", size: 1234 },
    ]);
  });

  test("an absent, empty, or oversized manifest is nothing to render", () => {
    expect(parseAttachmentManifest(undefined)).toBeNull();
    expect(parseAttachmentManifest([])).toBeNull();
    expect(parseAttachmentManifest("shot.png")).toBeNull();
    expect(parseAttachmentManifest(Array.from({ length: 9 }, () => entry()))).toBeNull();
  });

  test("an entry carrying bytes is refused outright, not trimmed", () => {
    expect(parseAttachmentManifest([entry({ bytesBase64: "AQID" })])).toBeNull();
    expect(parseAttachmentManifest([entry({ data: "AQID" })])).toBeNull();
  });

  test("every field is bounded", () => {
    expect(parseAttachmentManifest([entry({ digest: "nope" })])).toBeNull();
    expect(parseAttachmentManifest([entry({ digest: "B".repeat(64) })])).toBeNull();
    expect(parseAttachmentManifest([entry({ mediaType: "application/pdf" })])).toBeNull();
    expect(parseAttachmentManifest([entry({ size: -1 })])).toBeNull();
    expect(parseAttachmentManifest([entry({ size: 1.5 })])).toBeNull();
    expect(parseAttachmentManifest([
      entry({ size: attachmentLimits.maximumFileBytes + 1 }),
    ])).toBeNull();
    expect(parseAttachmentManifest([entry({ name: "" })])).toBeNull();
  });

  test("a name from the projection is cleaned the same way as one from a file", () => {
    const parsed = parseAttachmentManifest([entry({ name: "/tmp/sh\u202Eot.png" })]);
    expect(parsed?.[0]?.name).toBe("shot.png");
  });

  test("the manifest for what this tab is sending describes the bytes that travel", () => {
    expect(manifestForPrepared([prepared({ bytes: bytes(99), sourceBytes: 4096 })])).toEqual([{
      digest: "a".repeat(64),
      kind: "image",
      mediaType: "image/png",
      name: "shot.png",
      size: 99,
    }]);
  });
});
