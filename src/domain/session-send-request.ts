import { createHash } from "node:crypto";

import { z } from "zod";

import { attachmentReferenceListSchema } from "./attachment-schemas";
import { ATTACHMENT_MAX_COUNT } from "./attachments";
import { localCommandSchema, selectorSchema } from "./contracts";
import { MESSAGE_MAX_BYTES, messageSchema, utf8Bytes } from "./values";

export const SESSION_SEND_REQUEST_VERSION = 1;

// Reuse the wire's actual UUID contract without changing its optional-key API.
type SendCommandSchema = Extract<
  (typeof localCommandSchema.options)[number],
  { shape: { kind: z.ZodLiteral<"session.send"> } }
>;
const sendCommandSchema = localCommandSchema.options.find(
  (option): option is SendCommandSchema => option.shape.kind.safeParse("session.send").success,
);
if (sendCommandSchema === undefined) throw new Error("The session.send command schema is missing.");

// Like the managed renderer, refuse lone surrogates before UTF-8 can replace
// them: two distinct malformed strings must not acquire the same fingerprint.
const wellFormedUnicode = (value: string): boolean => {
  for (const scalar of value) {
    const code = scalar.codePointAt(0) ?? 0;
    if (code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
};

/**
 * The original, already-parsed user input, not a resolved execution target.
 * The caller supplies its generated key if the wire request omitted one.
 * Message bytes are preserved; this does not change the wire's text parsing.
 * An attachment-only request is valid even though the old wire cannot express
 * it yet. References prove request identity, not attachment-byte custody.
 */
export const sessionSendRequestSchema = z.object({
  kind: z.literal("session.send"),
  session: selectorSchema.refine(wellFormedUnicode),
  message: z.string().max(MESSAGE_MAX_BYTES).refine(wellFormedUnicode)
    .refine((value) => utf8Bytes(value) <= MESSAGE_MAX_BYTES),
  attachments: z.union([z.tuple([]), attachmentReferenceListSchema])
    .transform((references) => [...references]).default([]),
  idempotencyKey: sendCommandSchema.shape.idempotencyKey.unwrap(),
}).strict().superRefine((value, context) => {
  if (value.attachments.length === 0 && !messageSchema.safeParse(value.message).success) {
    context.addIssue({
      code: "custom",
      path: ["message"],
      message: "A send requires message text or an attachment reference.",
    });
  }
  for (const [index, reference] of value.attachments.entries()) {
    if (!wellFormedUnicode(reference.name)) {
      context.addIssue({
        code: "custom",
        path: ["attachments", index, "name"],
        message: "An attachment name must contain well-formed Unicode.",
      });
    }
  }
});

export type SessionSendRequest = z.infer<typeof sessionSendRequestSchema>;

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const digestText = (domain: string, value: string): string => createHash("sha256")
  .update(`hra:session-send-${domain}:v1\0`, "utf8").update(value, "utf8").digest("hex");

const fingerprintFieldsSchema = z.object({
  version: z.literal(SESSION_SEND_REQUEST_VERSION),
  selectorDigest: digestSchema,
  inputDigest: digestSchema,
  inputUtf8Bytes: z.number().int().nonnegative().max(MESSAGE_MAX_BYTES),
  attachmentReferencesDigest: digestSchema,
  attachmentCount: z.number().int().nonnegative().max(ATTACHMENT_MAX_COUNT),
}).strict();

// The tuple order and domain prefixes are the version-one serialization.
// Neither a global key nor mutable execution/routing authority is a request
// field. The durable owner must bind its original key independently.
const requestDigest = (value: z.infer<typeof fingerprintFieldsSchema>): string => digestText(
  "request",
  JSON.stringify([
    value.version,
    "session.send",
    value.selectorDigest,
    value.inputDigest,
    value.inputUtf8Bytes,
    value.attachmentReferencesDigest,
    value.attachmentCount,
  ]),
);

/** Content-free identity only: never persist SessionSendRequest as a receipt. */
export const sessionSendRequestFingerprintSchema = fingerprintFieldsSchema.extend({
  requestDigest: digestSchema,
}).strict().superRefine((value, context) => {
  if (value.requestDigest !== requestDigest(value)) {
    context.addIssue({ code: "custom", path: ["requestDigest"], message: "Request digest does not match its fingerprint." });
  }
  if (value.inputUtf8Bytes === 0 && value.inputDigest !== digestText("input", "")) {
    context.addIssue({ code: "custom", path: ["inputDigest"], message: "Empty input has a different digest." });
  }
  if (value.attachmentCount === 0 && value.attachmentReferencesDigest !== digestText("attachment-references", "[]")) {
    context.addIssue({ code: "custom", path: ["attachmentReferencesDigest"], message: "Empty references have a different digest." });
  }
  if (value.inputUtf8Bytes === 0 && value.attachmentCount === 0) {
    context.addIssue({ code: "custom", message: "An empty send has no request fingerprint." });
  }
});

export type SessionSendRequestFingerprint = z.infer<typeof sessionSendRequestFingerprintSchema>;

/** Pure, deterministic hashing; no provider state, attachment reads, or I/O. */
export function fingerprintSessionSendRequest(value: unknown): SessionSendRequestFingerprint {
  const request = sessionSendRequestSchema.parse(value);
  const fields = {
    version: SESSION_SEND_REQUEST_VERSION,
    selectorDigest: digestText("selector", request.session),
    inputDigest: digestText("input", request.message),
    inputUtf8Bytes: utf8Bytes(request.message),
    attachmentReferencesDigest: digestText("attachment-references", JSON.stringify(
      request.attachments.map((reference) => [
        reference.byteLength, reference.digest, reference.mediaType, reference.name,
      ]),
    )),
    attachmentCount: request.attachments.length,
  } satisfies z.infer<typeof fingerprintFieldsSchema>;
  return Object.freeze(sessionSendRequestFingerprintSchema.parse({
    ...fields,
    requestDigest: requestDigest(fields),
  }));
}
