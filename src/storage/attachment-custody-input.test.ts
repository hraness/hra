import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { type AttachmentReference } from "../domain/attachments";
import { fingerprintSessionSendRequest, sessionSendRequestSchema } from "../domain/session-send-request";
import {
  attachmentInputProof,
  attachmentReferencesDigest,
  initialEmptyAttachmentInput,
  parseAttachmentInput,
  type AttachmentIngressInput,
} from "./attachment-custody";
import { queueAttachmentRequestDigest } from "./queue-attachment-identity";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const first: AttachmentReference = { byteLength: 5, digest: "a".repeat(64), mediaType: "text/plain", name: "first.txt" };
const second: AttachmentReference = { byteLength: 7, digest: "b".repeat(64), mediaType: "text/markdown", name: "second.md" };
const input = (changes: Partial<AttachmentIngressInput> = {}): AttachmentIngressInput => ({
  kind: "session.send", sessionId: `sess_${"1".repeat(32)}`,
  idempotencyKey: "01991ddd-684b-77b8-9696-b703107bbf8c",
  message: "Exact original input 🦊", attachments: [],
  providerAuthority: { provider: "codex", profileId: `acct_${"2".repeat(32)}`,
    providerAccountId: `acct_${"2".repeat(32)}`, bindingGeneration: 3, processGeneration: 7 },
  daemonGeneration: 9, bootId: `boot_${"3".repeat(32)}`, ...changes,
});
const proofInput = (value: AttachmentIngressInput) => ({
  kind: value.kind, sessionId: value.sessionId, idempotencyKey: value.idempotencyKey,
  message: value.message, attachments: value.attachments, providerAuthority: value.providerAuthority,
});
const proof = (value: AttachmentIngressInput) => attachmentInputProof(proofInput(parseAttachmentInput(value)));
const legacyDigest = (value: AttachmentIngressInput) => sha(JSON.stringify({
  kind: value.kind, authorityId: value.sessionId, authorityGeneration: value.providerAuthority.processGeneration,
  request: value.attachments.length === 0 ? { message: value.message } : { message: value.message, attachments: value.attachments },
}));

describe("attachment custody input and historical request identity", () => {
  test.each(["session.send", "session.steer"] as const)("%s empty references preserve the released omitted-attachments request bytes", (kind) => {
    const value = parseAttachmentInput(input({ kind }));
    const observed = attachmentInputProof(proofInput(value));
    expect(observed.requestDigest).toBe(legacyDigest(value));
    expect(observed.requestDigest).not.toBe(sha(JSON.stringify({ kind, authorityId: value.sessionId,
      authorityGeneration: value.providerAuthority.processGeneration, request: { message: value.message, attachments: [] } })));
    expect(observed.referenceDigest).toBe(sha(JSON.stringify({ domain: "hra:attachment-custody-references:v1", references: [] })));
    expect(observed.referenceCount).toBe(0);
    expect(observed.members).toEqual([]);
  });

  test.each(["session.send", "session.steer"] as const)("%s nonempty references preserve generic request bytes without queue version two", (kind) => {
    const value = parseAttachmentInput(input({ kind, attachments: [first, second] }));
    const observed = attachmentInputProof(proofInput(value));
    expect(observed.requestDigest).toBe(legacyDigest(value));
    expect(observed.requestDigest).not.toBe(sha(JSON.stringify({ kind, authorityId: value.sessionId,
      authorityGeneration: value.providerAuthority.processGeneration,
      request: { version: 2, message: value.message, attachments: value.attachments } })));
  });

  test("nonempty queue custody uses the already sealed migration47 version-two request preimage", () => {
    const value = parseAttachmentInput(input({ kind: "session.queue", attachments: [first, second] }));
    const expected = sha(JSON.stringify({ kind: "session.queue", authorityId: value.sessionId,
      authorityGeneration: value.providerAuthority.processGeneration,
      request: { version: 2, message: value.message, attachments: value.attachments } }));
    expect(proof(value).requestDigest).toBe(expected);
    expect(proof(value).requestDigest).toBe(queueAttachmentRequestDigest({ sessionId: value.sessionId,
      authorityGeneration: value.providerAuthority.processGeneration, message: value.message, attachments: value.attachments }));
    expect(proof(value).requestDigest).not.toBe(legacyDigest(value));
  });

  test("empty queue custody still retains the released text-only queue digest", () => {
    const value = input({ kind: "session.queue" });
    expect(proof(value).requestDigest).toBe(legacyDigest(value));
    expect(proof(value).requestDigest).toBe(queueAttachmentRequestDigest({ sessionId: value.sessionId,
      authorityGeneration: value.providerAuthority.processGeneration, message: value.message, attachments: [] }));
  });

  test("original-send attachment-only custody preserves its independent owner fingerprint and zero text bytes", () => {
    const value = input({ message: "", attachments: [first] });
    const request = sessionSendRequestSchema.parse({ kind: "session.send", session: "Original selector",
      message: value.message, attachments: value.attachments, idempotencyKey: value.idempotencyKey });
    const fingerprint = fingerprintSessionSendRequest(request);
    const observed = attachmentInputProof(proofInput(value), fingerprint.requestDigest);
    expect(observed.requestDigest).toBe(fingerprint.requestDigest);
    expect(observed.messageUtf8Bytes).toBe(0);
    expect(observed.messageDigest).toBe(sha(""));
    expect(observed.referenceCount).toBe(1);
    expect(observed.members).toEqual([{ digest: first.digest, canonicalMediaType: "text/plain", byteLength: first.byteLength }]);
    expect(observed.referenceDigest).not.toBe(fingerprint.attachmentReferencesDigest);
    expect(observed.messageDigest).not.toBe(fingerprint.inputDigest);
  });

  test("generic ingress remains text-bearing and no positive empty proof can describe an entirely empty request", () => {
    expect(() => parseAttachmentInput(input({ message: "" }))).toThrow("ATTACHMENT_CUSTODY_INVALID_INPUT");
    expect(() => parseAttachmentInput(input({ message: " \n\t " }))).toThrow("ATTACHMENT_CUSTODY_INVALID_INPUT");
    expect(() => parseAttachmentInput(input({ message: "", attachments: [first] }))).toThrow("ATTACHMENT_CUSTODY_INVALID_INPUT");
    expect(() => attachmentInputProof(proofInput(input({ message: "" })), "a".repeat(64))).toThrow();
  });

  test("positive empty input has a real reference digest and no synthetic custody id", () => {
    const value = input();
    const observed = proof(value);
    expect(observed.referenceDigest).toBe(attachmentReferencesDigest([]));
    expect(observed.members).toEqual([]);
    expect(initialEmptyAttachmentInput(proofInput(value))).toEqual({ format: "empty_v1", custodyId: null,
      digest: sha(JSON.stringify({ domain: "hra:attachment-custody:v1", value: observed })) });
    expect(() => initialEmptyAttachmentInput(proofInput(input({ attachments: [first] })))).toThrow();
  });

  test("empty input commitment binds the full provider tuple independently of the unchanged human input", () => {
    const original = input();
    const originalProof = proof(original);
    const originalSeal = initialEmptyAttachmentInput(proofInput(original));
    const authorities = [
      { ...original.providerAuthority, profileId: `acct_${"4".repeat(32)}` },
      { ...original.providerAuthority, providerAccountId: `acct_${"5".repeat(32)}` },
      { ...original.providerAuthority, bindingGeneration: original.providerAuthority.bindingGeneration + 1 },
      { ...original.providerAuthority, processGeneration: original.providerAuthority.processGeneration + 1 },
      { ...original.providerAuthority, provider: "claude" as const, providerAccountId: `pact_${"6".repeat(32)}` },
    ];
    for (const providerAuthority of authorities) {
      const changed = input({ providerAuthority });
      const observed = proof(changed);
      expect(observed.authority).toEqual(providerAuthority);
      expect(observed.messageDigest).toBe(originalProof.messageDigest);
      expect(observed.referenceDigest).toBe(originalProof.referenceDigest);
      expect(initialEmptyAttachmentInput(proofInput(changed)).digest).not.toBe(originalSeal.digest);
    }
  });

  const changes: readonly [string, readonly AttachmentReference[]][] = [
    ["order", [second, first]],
    ["name", [{ ...first, name: "renamed.txt" }, second]],
    ["declared type", [{ ...first, mediaType: "text/markdown" }, second]],
    ["byte length", [{ ...first, byteLength: first.byteLength + 1 }, second]],
    ["digest", [{ ...first, digest: "c".repeat(64) }, second]],
    ["suffix", [first]],
    ["empty replacement", []],
  ];
  test.each(changes)("same-key changed %s produces different request and ordered-reference identity", (...[, attachments]) => {
    const original = proof(input({ attachments: [first, second] }));
    const changed = proof(input({ attachments }));
    expect(changed.idempotencyKey).toBe(original.idempotencyKey);
    expect(changed.requestDigest).not.toBe(original.requestDigest);
    expect(changed.referenceDigest).not.toBe(original.referenceDigest);
    expect(changed.messageDigest).toBe(original.messageDigest);
  });

  test("content-free members canonicalize text types without retaining names, text, or filesystem paths", () => {
    const refs: AttachmentReference[] = [first, second,
      { byteLength: 12, digest: "c".repeat(64), mediaType: "application/json", name: "private.json" },
      { byteLength: 17, digest: "d".repeat(64), mediaType: "image/png", name: "private.png" }];
    const observed = proof(input({ attachments: refs }));
    expect(observed.members).toEqual(refs.map((ref) => ({ digest: ref.digest,
      canonicalMediaType: ref.mediaType === "image/png" ? "image/png" : "text/plain", byteLength: ref.byteLength })));
    const serialized = JSON.stringify(observed);
    expect(serialized).not.toContain(input().message);
    for (const ref of refs) expect(serialized).not.toContain(ref.name);
    expect(Object.keys(observed).sort()).toEqual(["authority", "idempotencyKey", "kind", "members", "messageDigest",
      "messageUtf8Bytes", "referenceCount", "referenceDigest", "requestDigest", "sessionId", "version"]);
  });

  test("message admission and proof count the exact maximal multibyte input in UTF-8", () => {
    const message = "🦊".repeat(65_536);
    const observed = proof(input({ message }));
    expect(observed.messageUtf8Bytes).toBe(262_144);
    expect(observed.messageDigest).toBe(sha(message));
    expect(parseAttachmentInput(input({ message })).message).toBe(message);
    expect(() => parseAttachmentInput(input({ message: `${message}a` }))).toThrow("ATTACHMENT_CUSTODY_INVALID_INPUT");
    const whitespace = " \n exact input \t ";
    expect(parseAttachmentInput(input({ message: whitespace })).message).toBe(whitespace);
    expect(proof(input({ message: whitespace })).messageUtf8Bytes).toBe(new TextEncoder().encode(whitespace).byteLength);
  });

  test("attachment admission allows exactly ten MiB in at most eight references and refuses overflow", () => {
    const refs = [{ ...first, byteLength: 5 * 1024 * 1024 }, { ...second, byteLength: 5 * 1024 * 1024 }];
    expect(proof(input({ attachments: refs })).members.reduce((total, member) => total + member.byteLength, 0))
      .toBe(10 * 1024 * 1024);
    expect(() => parseAttachmentInput(input({ attachments: [...refs,
      { ...first, digest: "c".repeat(64), name: "overflow.txt", byteLength: 1 }] })))
      .toThrow("ATTACHMENT_CUSTODY_INVALID_INPUT");
    const eight = Array.from({ length: 8 }, (_, index) => ({ ...first, name: `ref-${String(index)}.txt` }));
    expect(proof(input({ attachments: eight })).referenceCount).toBe(8);
    expect(() => parseAttachmentInput(input({ attachments: [...eight, { ...first, name: "ninth.txt" }] })))
      .toThrow("ATTACHMENT_CUSTODY_INVALID_INPUT");
  });

  test("attachment names obey their UTF-8 bound without normalizing the admitted name", () => {
    const name = `${"🦊".repeat(63)}abc`;
    expect(parseAttachmentInput(input({ attachments: [{ ...first, name }] })).attachments[0]?.name).toBe(name);
    expect(() => parseAttachmentInput(input({ attachments: [{ ...first, name: "🦊".repeat(64) }] })))
      .toThrow("ATTACHMENT_CUSTODY_INVALID_INPUT");
  });

  test.each(["\uD800", "\uDC00"])("malformed Unicode %j cannot collapse onto replacement-character identity", (malformed) => {
    expect(() => parseAttachmentInput(input({ message: `before${malformed}after` }))).toThrow("ATTACHMENT_CUSTODY_INVALID_INPUT");
    expect(() => parseAttachmentInput(input({ attachments: [{ ...first, name: `before${malformed}after.txt` }] })))
      .toThrow("ATTACHMENT_CUSTODY_INVALID_INPUT");
    expect(parseAttachmentInput(input({ message: "before�after" })).message).toBe("before�after");
  });

  test("closed ingress parsing rejects surplus top-level fields instead of projecting them away", () => {
    const foreign = { ...input(), arbitraryCleanupPath: "/must-not-be-authority" };
    expect(() => parseAttachmentInput(foreign)).toThrow("ATTACHMENT_CUSTODY_INVALID_INPUT");
  });

  test("closed ingress rejects surplus authority and reference fields", () => {
    const foreignAuthority = { ...input(), providerAuthority: { ...input().providerAuthority, credential: "not evidence" } };
    const foreignReference = { ...input(), attachments: [{ ...first, localPath: "/not-a-reference-field" }] };
    expect(() => parseAttachmentInput(foreignAuthority)).toThrow("ATTACHMENT_CUSTODY_INVALID_INPUT");
    expect(() => parseAttachmentInput(foreignReference)).toThrow("ATTACHMENT_CUSTODY_INVALID_INPUT");
  });

  test("foreign missing or nonobject ingress values produce a bounded input refusal", () => {
    for (const foreign of [null, undefined, [], 3, "not an ingress request", {}, { ...input(), attachments: undefined }]) {
      expect(() => parseAttachmentInput(foreign)).toThrow("ATTACHMENT_CUSTODY_INVALID_INPUT");
    }
  });
});
