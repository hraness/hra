import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  acceptAttachmentBytes,
  attachmentMessageText,
  attachmentReferenceOf,
  ATTACHMENT_INLINE_TEXT_MAX_BYTES,
  ATTACHMENT_MAX_BYTES,
  type PreparedAttachment,
} from "./attachments";
import {
  MANAGED_FORWARD_PROVIDER_TEXT_MAX_BYTES,
  managedForwardRenderMetadataSchema,
  renderManagedForwardMessage,
} from "./managed-forward-renderer";
import {
  digestTranscriptRecords,
  renderTranscriptSeed,
  renderTranscriptSeedV1,
  type SessionTranscript,
  type TranscriptRecord,
} from "./transcript";
import { MESSAGE_MAX_BYTES, utf8Bytes } from "./values";

const encoder = new TextEncoder();
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const domainDigest = (domain: string, value: string): string => createHash("sha256")
  .update(`hra:managed-forward-${domain}:v1\0`, "utf8").update(value, "utf8").digest("hex");

const transcript = (texts: readonly string[] = [], omittedRecords = 0): SessionTranscript => {
  const records: TranscriptRecord[] = texts.map((text, index) => ({
    kind: "user", actor: "human", turnId: null, sequence: index + 1,
    throughSequence: index + 1, recordedAt: 1_000 + index, text, omittedCharacters: 0,
  }));
  return {
    version: 1, sessionId: `sess_${"a".repeat(32)}`, records,
    throughSequence: texts.length === 0 ? null : texts.length,
    nextSequence: null, omittedRecords, omittedCharacters: 0,
    digest: digestTranscriptRecords(records),
  };
};

const textAttachment = (
  text: string,
  name = "notes.md",
  bom = false,
): Extract<PreparedAttachment, { kind: "text" }> => {
  const bytes = encoder.encode(`${bom ? "\ufeff" : ""}${text}`);
  return {
    byteLength: bytes.byteLength, digest: sha256(bytes), kind: "text",
    mediaType: "text/markdown", name, path: "/custody/notes.txt", text,
  };
};

const imageAttachment = (name = "image.png"): Extract<PreparedAttachment, { kind: "image" }> => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return {
    base64: Buffer.from(bytes).toString("base64"), byteLength: bytes.byteLength,
    digest: sha256(bytes), kind: "image", mediaType: "image/png", name,
    path: "/custody/image.png",
  };
};

const render = (input: Parameters<typeof renderManagedForwardMessage>[0]) => {
  const result = renderManagedForwardMessage(input);
  if (result.status !== "rendered") throw new Error(`Unexpected refusal: ${result.reason}`);
  return result;
};

const base = { message: "Do the next requested change.", attachments: [], transcript: transcript() };

describe("managed forward renderer", () => {
  test("frames prior context and one exact current human request without a standalone seed", () => {
    const message = "  Preserve these spaces.\n\n";
    const result = render({ ...base, message, transcript: transcript(["Earlier human input"]) });
    expect(result.message).toContain("retained context, not a new human request");
    expect(result.message).toContain("User: Earlier human input");
    expect(result.message.endsWith(message)).toBe(true);
    expect(result.message).not.toContain("Continue the work from here");
    expect(result.metadata).toMatchObject({
      version: 1, inputUtf8Bytes: utf8Bytes(message), includedRecords: 1, omittedRecords: 0,
      providerTextBytes: utf8Bytes(result.message),
    });
  });

  test("preserves a maximum-size 262144-byte multibyte human input while dropping context first", () => {
    const message = "🦊".repeat(MESSAGE_MAX_BYTES / 4);
    const minimum = render({ ...base, message });
    const result = render({
      ...base, message, transcript: transcript(["old context ".repeat(1_000)], 9),
      maxProviderTextBytes: minimum.metadata.providerTextBytes + 2,
    });
    expect(result.message.endsWith(message)).toBe(true);
    expect(result.metadata.inputUtf8Bytes).toBe(262_144);
    expect(result.metadata).toMatchObject({ includedRecords: 0, omittedRecords: 10 });
    expect(result.metadata.providerTextBytes).toBeLessThanOrEqual(minimum.metadata.providerTextBytes + 2);
    expect(renderManagedForwardMessage({ ...base, message: `${message}x` }))
      .toEqual({ status: "refused", reason: "invalid_input" });
  });

  test("keeps a contiguous recent suffix and counts pre-existing omissions", () => {
    const latest = "latest context";
    const roomForLatest = render({ ...base, transcript: transcript([latest], 11) });
    const result = render({
      ...base, transcript: transcript(["too large ".repeat(100), "old middle", latest], 9),
      maxProviderTextBytes: roomForLatest.metadata.providerTextBytes,
    });
    expect(result.metadata).toMatchObject({ includedRecords: 1, omittedRecords: 11 });
    expect(result.message).toContain(latest);
    expect(result.message).not.toContain("old middle");
    expect(result.message).not.toContain("too large");
  });

  test("measures and hashes the exact once-expanded provider text, including dynamic fences", () => {
    const attachments = [textAttachment("a\n`````\n🦊"), imageAttachment()];
    const result = render({ ...base, attachments });
    const expanded = attachmentMessageText(result.message, attachments);
    expect(result.message).not.toContain("Attached file:");
    expect(expanded.match(/Attached file:/gu)).toHaveLength(1);
    expect(expanded).toContain("\n``````\n");
    expect(result.metadata.providerTextBytes).toBe(utf8Bytes(expanded));
    expect(result.metadata.envelopeDigest).toBe(domainDigest("envelope", expanded));
    expect(result.metadata.attachmentManifestDigest)
      .toBe(domainDigest("attachment-manifest", JSON.stringify(attachments.map(attachmentReferenceOf))));
    expect(result.metadata.inputDigest).toBe(domainDigest("input", base.message));
    expect(new Set([
      result.metadata.envelopeDigest, result.metadata.attachmentManifestDigest,
      result.metadata.inputDigest, result.metadata.transcriptDigest,
    ]).size).toBe(4);
  });

  test.each(["text", "image"] as const)("admits attachment-only %s input without duplicating it", (kind) => {
    const attachments = [kind === "text" ? textAttachment("Please inspect this file") : imageAttachment()];
    const result = render({ ...base, message: "", attachments });
    expect(result.metadata).toMatchObject({ inputUtf8Bytes: 0, attachmentCount: 1 });
    expect(result.message).not.toContain("Please inspect this file");
    expect(result.message).not.toContain("base64");
    expect(result.metadata.providerTextBytes).toBe(utf8Bytes(attachmentMessageText(result.message, attachments)));
  });

  test("refuses minimum framing overflow instead of truncating input or attachment expansion", () => {
    const attachment = textAttachment("`".repeat(ATTACHMENT_INLINE_TEXT_MAX_BYTES));
    const attachments = [attachment];
    const exact = render({ ...base, attachments });
    expect(exact.metadata.providerTextBytes).toBeGreaterThan(3 * ATTACHMENT_INLINE_TEXT_MAX_BYTES);
    expect(render({ ...base, attachments, maxProviderTextBytes: exact.metadata.providerTextBytes }))
      .toEqual({ ...exact, metadata: { ...exact.metadata, maxProviderTextBytes: exact.metadata.providerTextBytes } });
    expect(renderManagedForwardMessage({
      ...base, attachments, maxProviderTextBytes: exact.metadata.providerTextBytes - 1,
    })).toEqual({
      status: "refused", reason: "minimum_frame_overflow",
      maxProviderTextBytes: exact.metadata.providerTextBytes - 1,
      minimumProviderTextBytes: exact.metadata.providerTextBytes,
    });
    const many = Array.from({ length: 8 }, (_unused, index) => ({ ...attachment, name: `file-${String(index)}.md` }));
    expect(renderManagedForwardMessage({ ...base, attachments: many })).toMatchObject({
      status: "refused", reason: "minimum_frame_overflow",
      maxProviderTextBytes: MANAGED_FORWARD_PROVIDER_TEXT_MAX_BYTES,
    });
  });

  test("budgets the shared attachment prefix truncation and omission notice exactly", () => {
    const attachments = [textAttachment("é".repeat(ATTACHMENT_INLINE_TEXT_MAX_BYTES))];
    const result = render({ ...base, attachments });
    const expanded = attachmentMessageText(result.message, attachments);
    expect(expanded).toContain(`[${String(ATTACHMENT_INLINE_TEXT_MAX_BYTES)} further UTF-8 bytes`);
    expect(result.metadata.providerTextBytes).toBe(utf8Bytes(expanded));
  });

  test("reserves the outgoing four-MiB JSON bound under maximally escaped text and bounded image paths", () => {
    const attachments = Array.from({ length: 8 }, (_unused, index) => ({
      ...imageAttachment(`image-${String(index)}.png`),
      path: `/${'"\\'.repeat(8_191)}"`,
    }));
    const message = "\0".repeat(MESSAGE_MAX_BYTES);
    const result = render({
      message, attachments,
      transcript: transcript(Array.from({ length: 20 }, () => "\0".repeat(16_384))),
    });
    const expanded = attachmentMessageText(result.message, attachments);
    const serialized = JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "turn/start",
      params: {
        threadId: "thread".repeat(30),
        input: [
          { type: "text", text: expanded },
          ...attachments.map((attachment) => ({ type: "localImage", path: attachment.path })),
        ],
      },
    });
    expect(result.message.endsWith(message)).toBe(true);
    expect(result.metadata.inputUtf8Bytes).toBe(MESSAGE_MAX_BYTES);
    expect(result.metadata.providerTextBytes).toBeLessThanOrEqual(512 * 1024);
    expect(result.metadata.omittedRecords).toBeGreaterThan(0);
    expect(serialized.length).toBeLessThan(4 * 1024 * 1024);
  });

  test("is deterministic, canonicalizes manifest fields, preserves attachment order and excludes custody paths", () => {
    const first = textAttachment("first", "a.md");
    const second = textAttachment("second", "b.md");
    const input = { ...base, attachments: [first, second], transcript: transcript(["context"]) };
    const one = render(input);
    expect(render(structuredClone(input))).toEqual(one);
    const { byteLength, digest, kind, mediaType, name, text } = first;
    expect(render({ ...input, attachments: [{ text, name, mediaType, kind, digest, byteLength, path: "/different/custody" }, second] }))
      .toEqual(one);
    const reordered = render({ ...input, attachments: [second, first] });
    expect(reordered.metadata.attachmentManifestDigest).not.toBe(one.metadata.attachmentManifestDigest);
    expect(reordered.metadata.envelopeDigest).not.toBe(one.metadata.envelopeDigest);
    expect(reordered.metadata.inputDigest).toBe(one.metadata.inputDigest);
    expect(reordered.metadata.transcriptDigest).toBe(one.metadata.transcriptDigest);
    expect(JSON.stringify(one.metadata)).not.toContain("custody");
    expect(JSON.stringify(one.metadata)).not.toContain("context");
  });

  test("binds image order in the manifest even when provider text is unchanged", () => {
    const first = imageAttachment("a.png");
    const second = imageAttachment("b.png");
    const one = render({ ...base, attachments: [first, second] });
    const two = render({ ...base, attachments: [second, first] });
    expect(one.metadata.envelopeDigest).toBe(two.metadata.envelopeDigest);
    expect(one.metadata.attachmentManifestDigest).not.toBe(two.metadata.attachmentManifestDigest);
  });

  test("admits the shared decoder's BOM-bearing text without changing its prepared representation", () => {
    for (const text of ["valid UTF-8 text", "\ufeffsecond BOM stays in text"]) {
      const attachment = textAttachment(text, "bom.md", true);
      const bytes = encoder.encode(`\ufeff${text}`);
      expect(acceptAttachmentBytes(attachment.mediaType, bytes)).toMatchObject({ ok: true, text });
      expect(render({ ...base, attachments: [attachment] }).metadata.attachmentBytes).toBe(bytes.byteLength);
    }
  });

  test("refuses tampered bytes, kind/media mismatches, duplicate manifests and invalid JSON", () => {
    const text = textAttachment("plain text");
    const image = imageAttachment();
    for (const attachments of [
      [{ ...text, digest: "0".repeat(64) }],
      [{ ...text, byteLength: text.byteLength + 1 }],
      [{ ...text, text: "changed" }],
      [{ ...text, mediaType: "image/png" }],
      [{ ...text, mediaType: "application/json" }],
      [{ ...text, name: "../bad.md" }],
      [{ ...text, unexpected: true }],
      [{ ...image, base64: `${image.base64}\n` }],
      [{ ...image, mediaType: "image/jpeg" }],
      [text, { ...text }],
      Array.from({ length: 9 }, (_unused, index) => ({ ...text, name: `${String(index)}.md` })),
    ]) expect(renderManagedForwardMessage({ ...base, attachments }))
      .toEqual({ status: "refused", reason: "invalid_input" });
    const oversizedManifest = Array.from({ length: 3 }, (_unused, index) => ({
      ...text, name: `${String(index)}.md`, byteLength: ATTACHMENT_MAX_BYTES,
    }));
    expect(renderManagedForwardMessage({ ...base, attachments: oversizedManifest }))
      .toEqual({ status: "refused", reason: "invalid_input" });
  });

  test("refuses empty, malformed, oversized and incoherent inputs and budgets", () => {
    for (const value of [
      null, {}, { ...base, extra: true }, { ...base, message: "" },
      { ...base, message: " \n\t" }, { ...base, message: "\ud800" },
      { ...base, message: "a".repeat(MESSAGE_MAX_BYTES + 1) },
      ...[0, -1, 1.5, NaN, Infinity, MANAGED_FORWARD_PROVIDER_TEXT_MAX_BYTES + 1]
        .map((maxProviderTextBytes) => ({ ...base, maxProviderTextBytes })),
      { ...base, transcript: { ...transcript(), digest: "a".repeat(64) } },
      { ...base, transcript: { ...transcript(["first", "second"]), throughSequence: 1 } },
      { ...base, transcript: transcript(["one"], Number.MAX_SAFE_INTEGER) },
    ]) expect(renderManagedForwardMessage(value)).toEqual({ status: "refused", reason: "invalid_input" });
    expect(managedForwardRenderMetadataSchema.safeParse({ ...render(base).metadata, providerTextBytes: 1_000_001 }).success)
      .toBe(false);
  });

  test("does not change the manual v1 seed's exact bytes or digest", () => {
    const source = transcript(["hello"]);
    const expected = "[HRA provider handoff]\n"
      + "This conversation ran on codex and now runs on claude.\n"
      + "What follows is HRA's own record of it, not the previous provider's transcript:"
      + " secrets, absolute paths, raw tool arguments, and raw tool output were never stored and are not here.\n"
      + "No records were omitted.\n"
      + "Continue the work from here. Ask before assuming anything the summary does not state.\n"
      + "User: hello";
    const expectedDigest = createHash("sha256").update("hra:session-transcript-seed:v1\0", "utf8")
      .update(expected, "utf8").digest("hex");
    const before = renderTranscriptSeedV1({ transcript: source, fromProvider: "codex", toProvider: "claude" });
    render({ ...base, transcript: source });
    expect(before).toEqual({ text: expected, digest: expectedDigest, includedRecords: 1, omittedRecords: 0 });
    expect(renderTranscriptSeedV1({ transcript: source, fromProvider: "codex", toProvider: "claude" })).toEqual(before);
    const currentExpected = expected.replace(
      "secrets, absolute paths, raw tool arguments, and raw tool output were never stored and are not here.",
      "secrets, absolute paths, raw tool arguments, raw tool output, and attachment contents were never embedded and are not here.",
    ).replace("No records were omitted.", "No retained records were omitted.");
    const currentDigest = createHash("sha256").update("hra:session-transcript-seed:v1\0", "utf8")
      .update(currentExpected, "utf8").digest("hex");
    expect(renderTranscriptSeed({ transcript: source, fromProvider: "codex", toProvider: "claude" }))
      .toEqual({ text: currentExpected, digest: currentDigest, includedRecords: 1, omittedRecords: 0 });
  });

  test("is total for JSON input and preserves exact text under arbitrary bounded budgets", () => {
    fc.assert(fc.property(fc.jsonValue(), (value) => {
      expect(() => renderManagedForwardMessage(value)).not.toThrow();
    }), { numRuns: 100 });
    const text = fc.array(fc.constantFrom("a", "é", "🦊", "`", "\n", "\t", "\0"), { maxLength: 40 })
      .map((parts) => `Request:${parts.join("")}`);
    fc.assert(fc.property(text, fc.array(text, { maxLength: 8 }), fc.integer({ min: 1, max: 1_024 }),
      (message, context, maxProviderTextBytes) => {
        const input = { message, transcript: transcript(context), attachments: [], maxProviderTextBytes };
        const result = renderManagedForwardMessage(input);
        expect(renderManagedForwardMessage(structuredClone(input))).toEqual(result);
        if (result.status === "rendered") {
          expect(result.message.endsWith(message)).toBe(true);
          expect(result.metadata.providerTextBytes).toBe(utf8Bytes(result.message));
          expect(result.metadata.providerTextBytes).toBeLessThanOrEqual(maxProviderTextBytes);
          expect(result.metadata.includedRecords + result.metadata.omittedRecords).toBe(context.length);
        } else {
          expect(result.reason).toBe("minimum_frame_overflow");
          if (result.reason === "minimum_frame_overflow") {
            expect(result.minimumProviderTextBytes).toBeGreaterThan(maxProviderTextBytes);
          }
        }
      }), { numRuns: 100 });
  });
});
