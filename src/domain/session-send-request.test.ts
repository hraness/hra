import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { attachmentReferenceListSchema } from "./attachment-schemas";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MESSAGE_MAX_TOTAL_BYTES,
  type AttachmentReference,
} from "./attachments";
import { localCommandSchema, selectorSchema } from "./contracts";
import {
  fingerprintSessionSendRequest,
  sessionSendRequestFingerprintSchema,
  sessionSendRequestSchema,
  type SessionSendRequest,
} from "./session-send-request";
import { MESSAGE_MAX_BYTES, utf8Bytes } from "./values";

const key = "01991ddd-684b-77b8-9696-b703107bbf8c";
const reference: AttachmentReference = {
  byteLength: 5,
  digest: "a".repeat(64),
  mediaType: "text/plain",
  name: "private-input.txt",
};
const otherReference: AttachmentReference = {
  byteLength: 7,
  digest: "b".repeat(64),
  mediaType: "text/markdown",
  name: "other.md",
};
const request = (changes: Partial<SessionSendRequest> = {}): SessionSendRequest => ({
  kind: "session.send",
  session: "original session label",
  message: "private message 🦊",
  attachments: [],
  idempotencyKey: key,
  ...changes,
});

const hash = (domain: string, text: string): string => createHash("sha256")
  .update(`hra:session-send-${domain}:v1\0`, "utf8").update(text, "utf8").digest("hex");

describe("original session-send request", () => {
  test("uses parsed selector and UUID contracts without borrowing execution authority", () => {
    const input = request({ session: "  original session label  ", attachments: [reference] });
    const parsed = sessionSendRequestSchema.parse(input);
    expect(parsed.session).toBe(selectorSchema.parse(input.session));
    expect(parsed.session).toBe("original session label");
    expect(parsed.idempotencyKey).toBe(key);
    const fromWire = localCommandSchema.parse(input);
    expect(sessionSendRequestSchema.parse(fromWire)).toEqual(parsed);
    for (const foreign of [
      { ...input, provider: "codex" },
      { ...input, processGeneration: 3 },
      { ...input, activeSessionId: "other" },
      { ...input, kind: "session.queue" },
      { ...input, session: "bad\u0000selector" },
      { ...input, session: "x".repeat(201) },
      { ...input, idempotencyKey: "not-a-uuid" },
      { ...input, idempotencyKey: undefined },
    ]) expect(sessionSendRequestSchema.safeParse(foreign).success).toBe(false);
  });

  test("omitted and empty references normalize to one request identity", () => {
    const { kind, session, message, idempotencyKey } = request();
    const withoutReferences = { kind, session, message, idempotencyKey };
    expect(sessionSendRequestSchema.parse(withoutReferences).attachments).toEqual([]);
    expect(fingerprintSessionSendRequest(withoutReferences)).toEqual(fingerprintSessionSendRequest(request()));
  });

  test("fingerprints the parsed wire text and selector without changing wire trimming", () => {
    const wireInput = {
      kind: "session.send",
      session: " \toriginal session label  ",
      message: "  exact input 🦊\n",
      idempotencyKey: key,
    };
    const parsedWire = localCommandSchema.parse(wireInput);
    const ownerInput = sessionSendRequestSchema.parse(parsedWire);
    expect(ownerInput.session).toBe("original session label");
    expect(ownerInput.message).toBe("exact input 🦊");
    expect(ownerInput.attachments).toEqual([]);
    const expected = fingerprintSessionSendRequest(request({ message: "exact input 🦊" }));
    expect(fingerprintSessionSendRequest(parsedWire)).toEqual(expected);
    expect(fingerprintSessionSendRequest(ownerInput)).toEqual(expected);
    // The foundation preserves text it is given; it must not silently apply a
    // second trim or treat unparsed wire whitespace as already-normalized text.
    expect(fingerprintSessionSendRequest(wireInput).requestDigest).not.toBe(expected.requestDigest);
  });

  test("attachment-only is valid; empty and whitespace-only without references are not", () => {
    for (const message of ["", " \t\r\n"]) {
      expect(sessionSendRequestSchema.safeParse(request({ message })).success).toBe(false);
      const input = request({ message, attachments: [reference] });
      expect(sessionSendRequestSchema.parse(input).message).toBe(message);
      const fingerprint = fingerprintSessionSendRequest(input);
      expect(fingerprint.inputUtf8Bytes).toBe(utf8Bytes(message));
      expect(fingerprint.attachmentCount).toBe(1);
      expect(sessionSendRequestFingerprintSchema.safeParse(fingerprint).success).toBe(true);
    }
  });

  test("retains exact already-parsed text bytes, whitespace, and Unicode form", () => {
    const texts = ["hello", " hello", "hello ", "hello\n", "héllo", "he\u0301llo", "hello\u0000"];
    const fingerprints = texts.map((message) => {
      const input = request({ message });
      expect(sessionSendRequestSchema.parse(input).message).toBe(message);
      const fingerprint = fingerprintSessionSendRequest(input);
      expect(fingerprint.inputUtf8Bytes).toBe(utf8Bytes(message));
      expect(fingerprint.inputDigest).toBe(hash("input", message));
      return fingerprint.requestDigest;
    });
    expect(new Set(fingerprints).size).toBe(texts.length);
  });

  test("malformed Unicode is refused before UTF-8 replacement can collapse distinct input", () => {
    for (const malformed of ["\ud800", "\udfff", "x\ud800y", "\udfff\ud800"]) {
      expect(sessionSendRequestSchema.safeParse(request({ message: malformed })).success).toBe(false);
      expect(sessionSendRequestSchema.safeParse(request({ session: malformed })).success).toBe(false);
      expect(sessionSendRequestSchema.safeParse(request({
        attachments: [{ ...reference, name: `${malformed}.txt` }],
      })).success).toBe(false);
      expect(() => fingerprintSessionSendRequest(request({ message: malformed }))).toThrow();
    }
    expect(sessionSendRequestSchema.safeParse(request({ message: "\ufffd 🦊" })).success).toBe(true);
  });

  test("accepts the largest legal exact UTF-8 input and rejects one more byte", () => {
    for (const message of ["x".repeat(MESSAGE_MAX_BYTES), "🦊".repeat(MESSAGE_MAX_BYTES / 4)]) {
      const fingerprint = fingerprintSessionSendRequest(request({ message }));
      expect(fingerprint.inputUtf8Bytes).toBe(MESSAGE_MAX_BYTES);
      expect(sessionSendRequestFingerprintSchema.safeParse(fingerprint).success).toBe(true);
      expect(sessionSendRequestSchema.safeParse(request({ message: `${message}x` })).success).toBe(false);
    }
    expect(sessionSendRequestSchema.safeParse(request({ message: "é".repeat(MESSAGE_MAX_BYTES) })).success).toBe(false);
  });

  test("uses the existing reference shape, count, total-byte and duplicate limits", () => {
    const maximum = Array.from({ length: ATTACHMENT_MAX_COUNT }, (_, index) => ({
      ...reference,
      byteLength: ATTACHMENT_MESSAGE_MAX_TOTAL_BYTES / ATTACHMENT_MAX_COUNT,
      name: `${String(index)}.txt`,
    }));
    expect(fingerprintSessionSendRequest(request({ attachments: maximum })).attachmentCount).toBe(ATTACHMENT_MAX_COUNT);
    const refused = [
      [{ ...reference, path: "/not-a-reference" }],
      [{ ...reference, text: "not reference metadata" }],
      [{ ...reference, byteLength: 0 }],
      [{ ...reference, byteLength: ATTACHMENT_MAX_BYTES + 1 }],
      [{ ...reference, digest: reference.digest.toUpperCase() }],
      [{ ...reference, mediaType: "application/executable" }],
      [{ ...reference, name: "../private.txt" }],
      [reference, reference],
      [...maximum, otherReference],
      maximum.map((entry, index) => ({ ...entry, byteLength: entry.byteLength + (index === 0 ? 1 : 0) })),
    ];
    for (const attachments of refused) {
      expect(attachmentReferenceListSchema.safeParse(attachments).success).toBe(false);
      expect(sessionSendRequestSchema.safeParse({ ...request(), attachments }).success).toBe(false);
    }
  });
});

describe("content-free session-send fingerprint", () => {
  test("version one binds explicit domain-separated serialization", () => {
    const input = request({ message: "exact 🦊\n", attachments: [reference, otherReference] });
    const fingerprint = fingerprintSessionSendRequest(input);
    const selectorDigest = hash("selector", input.session);
    const inputDigest = hash("input", input.message);
    const attachmentReferencesDigest = hash("attachment-references", JSON.stringify([
      [5, "a".repeat(64), "text/plain", "private-input.txt"],
      [7, "b".repeat(64), "text/markdown", "other.md"],
    ]));
    expect(fingerprint).toEqual({
      version: 1,
      requestDigest: hash("request", JSON.stringify([
        1, "session.send", selectorDigest, inputDigest, 11, attachmentReferencesDigest, 2,
      ])),
      selectorDigest,
      inputDigest,
      inputUtf8Bytes: 11,
      attachmentReferencesDigest,
      attachmentCount: 2,
    });
    expect(Object.isFrozen(fingerprint)).toBe(true);
  });

  test("selector, text, reference order and every actual reference field change identity", () => {
    const input = request({ attachments: [reference, otherReference] });
    const original = fingerprintSessionSendRequest(input);
    const changed = [
      { ...input, session: "other session label" },
      { ...input, message: "other exact text" },
      { ...input, attachments: [otherReference, reference] },
      { ...input, attachments: [{ ...reference, name: "renamed.txt" }, otherReference] },
      { ...input, attachments: [{ ...reference, byteLength: 6 }, otherReference] },
      { ...input, attachments: [{ ...reference, digest: "c".repeat(64) }, otherReference] },
      { ...input, attachments: [{ ...reference, mediaType: "text/markdown" }, otherReference] },
      { ...input, attachments: [reference] },
    ];
    for (const value of changed) expect(fingerprintSessionSendRequest(value).requestDigest).not.toBe(original.requestDigest);
    expect(fingerprintSessionSendRequest({ ...input, session: ` ${input.session} ` })).toEqual(original);
    expect(fingerprintSessionSendRequest({ ...input, idempotencyKey: "01991ddd-684b-77b8-9696-b703107bbf8d" })).toEqual(original);
  });

  test("reference object insertion order does not affect the ordered reference digest", () => {
    const reordered = {
      name: reference.name,
      mediaType: reference.mediaType,
      digest: reference.digest,
      byteLength: reference.byteLength,
    };
    expect(fingerprintSessionSendRequest(request({ attachments: [reordered] })))
      .toEqual(fingerprintSessionSendRequest(request({ attachments: [reference] })));
  });

  test("contains no input, selector, key, attachment name, or reference digest", () => {
    const input = request({ attachments: [reference] });
    const fingerprint = fingerprintSessionSendRequest(input);
    expect(Object.keys(fingerprint).sort()).toEqual([
      "version", "requestDigest", "selectorDigest", "inputDigest", "inputUtf8Bytes",
      "attachmentReferencesDigest", "attachmentCount",
    ].sort());
    for (const privateValue of [input.message, input.session, input.idempotencyKey, reference.name, reference.digest]) {
      expect(JSON.stringify(fingerprint)).not.toContain(privateValue);
    }
    input.message = "replaced caller-owned text";
    input.attachments.push(otherReference);
    expect(fingerprint).toEqual(fingerprintSessionSendRequest(request({ attachments: [reference] })));
  });

  test("closed fingerprint parsing rejects altered fields, unknown versions and added plaintext", () => {
    const fingerprint = fingerprintSessionSendRequest(request());
    for (const changed of [
      { ...fingerprint, version: 2 },
      { ...fingerprint, requestDigest: "0".repeat(64) },
      { ...fingerprint, selectorDigest: "0".repeat(64) },
      { ...fingerprint, inputDigest: "0".repeat(64) },
      { ...fingerprint, inputUtf8Bytes: fingerprint.inputUtf8Bytes + 1 },
      { ...fingerprint, attachmentReferencesDigest: "0".repeat(64) },
      { ...fingerprint, attachmentCount: 1 },
      { ...fingerprint, inputUtf8Bytes: MESSAGE_MAX_BYTES + 1 },
      { ...fingerprint, inputUtf8Bytes: -1 },
      { ...fingerprint, attachmentCount: ATTACHMENT_MAX_COUNT + 1 },
      { ...fingerprint, attachmentCount: 0.5 },
      { ...fingerprint, message: "unexpected plaintext" },
    ]) expect(sessionSendRequestFingerprintSchema.safeParse(changed).success).toBe(false);
  });

  test("valid Unicode requests are deterministic and fingerprints round-trip without content", () => {
    const unicode = fc.array(fc.constantFrom("a", "é", "🦊", "\n", "\t", "\u0000", "\ufffd"), { maxLength: 100 });
    fc.assert(fc.property(unicode, (scalars) => {
      const input = request({ message: `x${scalars.join("")}`, attachments: [reference] });
      const first = fingerprintSessionSendRequest(input);
      expect(first).toEqual(fingerprintSessionSendRequest(JSON.parse(JSON.stringify(input))));
      expect(sessionSendRequestFingerprintSchema.parse(JSON.parse(JSON.stringify(first)))).toEqual(first);
      expect(first.inputUtf8Bytes).toBe(utf8Bytes(input.message));
      expect(first.inputDigest).toBe(hash("input", input.message));
    }), { numRuns: 100, seed: 6145 });
  });

  test("request and fingerprint parsers are total over foreign JSON", () => {
    fc.assert(fc.property(fc.jsonValue(), (value) => {
      expect(() => sessionSendRequestSchema.safeParse(value)).not.toThrow();
      expect(() => sessionSendRequestFingerprintSchema.safeParse(value)).not.toThrow();
    }), { numRuns: 100, seed: 6146 });
  });
});
