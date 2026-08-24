import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { sessionEventCursorPayloadSchema, type SessionEventCursorPayload } from "../domain/session-events";
import { profileIdSchema, sessionIdSchema, unixMillisecondsSchema } from "../domain/values";

const CURSOR_PREFIX = "hra1";
export const HRA_CURSOR_MAX_BYTES = 2_048;

export type SessionEventCursorErrorReason =
  | "filter_mismatch"
  | "invalid_signature"
  | "malformed"
  | "nonadvancing"
  | "noncanonical"
  | "progress_exhausted"
  | "too_large"
  | "type_mismatch"
  | "unsupported_version";

export class SessionEventCursorError extends Error {
  constructor(
    message: string,
    readonly reason: SessionEventCursorErrorReason = "malformed",
  ) {
    super(message);
    this.name = "SessionEventCursorError";
  }
}

export const interactionCursorScopeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("global"),
  }).strict(),
  z.object({
    type: z.literal("session"),
    sessionId: sessionIdSchema,
  }).strict(),
]);

export type InteractionCursorScope = z.infer<typeof interactionCursorScopeSchema>;

export const interactionCursorPayloadSchema = z.object({
  version: z.literal(1),
  type: z.literal("interaction"),
  scope: interactionCursorScopeSchema,
  pending: z.boolean(),
  requestedAt: unixMillisecondsSchema.max(Number.MAX_SAFE_INTEGER),
  publicId: z.string().uuid().refine((value) => value === value.toLowerCase(), {
    message: "Interaction cursor public ID must be a canonical lowercase UUID.",
  }),
}).strict();

export type InteractionCursorPayload = z.infer<typeof interactionCursorPayloadSchema>;

export const interactionCursorFilterSchema = interactionCursorPayloadSchema.pick({
  scope: true,
  pending: true,
});

export type InteractionCursorFilter = z.infer<typeof interactionCursorFilterSchema>;

const sessionListProviderCursorSchema = z.string().min(1).max(512).refine(
  (value) => Buffer.byteLength(value, "utf8") <= 512,
  "Provider session-list cursor exceeds 512 UTF-8 bytes.",
);
const sessionListProviderCursorDigestSchema = z.string()
  .regex(/^[A-Za-z0-9_-]{43}$/u)
  .refine((value) => {
    const decoded = Buffer.from(value, "base64url");
    return decoded.byteLength === 32 && decoded.toString("base64url") === value;
  }, "Session-list checkpoint digest must be canonical base64url SHA-256.");
const safePositiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

// Brent state after N observed continuations: power is the largest power of two
// at most N, span is N - power, and the checkpoint is the cursor at power - 1.
const sessionListBrentPower = (pageCount: number): number => {
  let power = 1;
  while (power <= Math.floor(pageCount / 2)) power *= 2;
  return power;
};

export const sessionListCursorFilterSchema = z.object({
  accountId: profileIdSchema,
  providerGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  limit: z.number().int().min(1).max(100),
}).strict();

export type SessionListCursorFilter = z.infer<typeof sessionListCursorFilterSchema>;

export const sessionListCursorPayloadSchema = z.object({
  version: z.literal(1),
  type: z.literal("session_list"),
  accountId: profileIdSchema,
  providerGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  limit: z.number().int().min(1).max(100),
  providerCursor: sessionListProviderCursorSchema,
  checkpointDigest: sessionListProviderCursorDigestSchema,
  power: safePositiveIntegerSchema,
  span: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  pageCount: safePositiveIntegerSchema,
}).strict().superRefine((value, context) => {
  const expectedPower = sessionListBrentPower(value.pageCount);
  if (value.power !== expectedPower || value.span !== value.pageCount - expectedPower) {
    context.addIssue({
      code: "custom",
      message: "Session-list cycle state is incoherent.",
    });
  }
  if (
    value.span === 0
    && value.checkpointDigest !== sessionListProviderCursorDigest(value.providerCursor)
  ) {
    context.addIssue({
      code: "custom",
      message: "Session-list checkpoint does not match its current provider cursor.",
    });
  }
});

export type SessionListCursorPayload = z.infer<typeof sessionListCursorPayloadSchema>;

export const localSessionListCursorFilterSchema = z.object({
  accountId: profileIdSchema,
  accountGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  limit: z.number().int().min(1).max(100),
}).strict();

export type LocalSessionListCursorFilter = z.infer<typeof localSessionListCursorFilterSchema>;

export const localSessionListCursorPayloadSchema = z.object({
  version: z.literal(1),
  type: z.literal("session_list_local"),
  accountId: profileIdSchema,
  accountGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  limit: z.number().int().min(1).max(100),
  afterCreatedAt: unixMillisecondsSchema.max(Number.MAX_SAFE_INTEGER),
  afterSessionId: sessionIdSchema,
}).strict();

export type LocalSessionListCursorPayload = z.infer<typeof localSessionListCursorPayloadSchema>;

const canonicalPayload = (payload: SessionEventCursorPayload): string => JSON.stringify({
  version: payload.version,
  sessionId: payload.sessionId,
  streamEpoch: payload.streamEpoch,
  sequence: payload.sequence,
});

const canonicalInteractionScope = (scope: InteractionCursorScope): InteractionCursorScope =>
  scope.type === "global"
    ? { type: "global" }
    : { type: "session", sessionId: scope.sessionId };

const canonicalInteractionPayload = (payload: InteractionCursorPayload): string => JSON.stringify({
  version: payload.version,
  type: payload.type,
  scope: canonicalInteractionScope(payload.scope),
  pending: payload.pending,
  requestedAt: payload.requestedAt,
  publicId: payload.publicId,
});

const canonicalSessionListPayload = (payload: SessionListCursorPayload): string => JSON.stringify({
  version: payload.version,
  type: payload.type,
  accountId: payload.accountId,
  providerGeneration: payload.providerGeneration,
  limit: payload.limit,
  providerCursor: payload.providerCursor,
  checkpointDigest: payload.checkpointDigest,
  power: payload.power,
  span: payload.span,
  pageCount: payload.pageCount,
});

const canonicalLocalSessionListPayload = (
  payload: LocalSessionListCursorPayload,
): string => JSON.stringify({
  version: payload.version,
  type: payload.type,
  accountId: payload.accountId,
  accountGeneration: payload.accountGeneration,
  limit: payload.limit,
  afterCreatedAt: payload.afterCreatedAt,
  afterSessionId: payload.afterSessionId,
});

const sameInteractionFilter = (
  actual: InteractionCursorFilter,
  expected: InteractionCursorFilter,
): boolean => actual.pending === expected.pending
  && actual.scope.type === expected.scope.type
  && (actual.scope.type === "global"
    || (expected.scope.type === "session" && actual.scope.sessionId === expected.scope.sessionId));

const sameSessionListFilter = (
  actual: SessionListCursorFilter,
  expected: SessionListCursorFilter,
): boolean => actual.accountId === expected.accountId
  && actual.providerGeneration === expected.providerGeneration
  && actual.limit === expected.limit;

const sameLocalSessionListFilter = (
  actual: LocalSessionListCursorFilter,
  expected: LocalSessionListCursorFilter,
): boolean => actual.accountId === expected.accountId
  && actual.accountGeneration === expected.accountGeneration
  && actual.limit === expected.limit;

const sessionListProviderCursorDigest = (providerCursor: string): string =>
  createHash("sha256")
    .update(providerCursor, "utf8")
    .digest()
    .toString("base64url");

const decodeBase64Url = (value: string, label: string): Buffer => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new SessionEventCursorError(`${label} is malformed.`, "malformed");
  }
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) {
      throw new SessionEventCursorError(`${label} is not canonical.`, "noncanonical");
    }
    return decoded;
  } catch (error) {
    if (error instanceof SessionEventCursorError) throw error;
    throw new SessionEventCursorError(`${label} is malformed.`, "malformed");
  }
};

type DecodedCursorEnvelope = Readonly<{
  encodedPayload: string;
  payloadJson: string;
  value: unknown;
}>;

export class SessionEventCursorCodec {
  readonly #key: Buffer;

  constructor(key: string | Uint8Array) {
    const decoded = typeof key === "string" ? decodeBase64Url(key, "Cursor key") : Buffer.from(key);
    if (decoded.byteLength !== 32) throw new Error("Session event cursor key must be exactly 32 bytes.");
    this.#key = Buffer.from(decoded);
  }

  static generateKey(): string {
    return randomBytes(32).toString("base64url");
  }

  encode(input: SessionEventCursorPayload): string {
    const payload = sessionEventCursorPayloadSchema.parse(input);
    return this.#encodeCanonical(canonicalPayload(payload), "Session event cursor");
  }

  decode(cursor: string): SessionEventCursorPayload {
    const envelope = this.#decodeEnvelope(cursor, "Session event cursor");
    if (
      typeof envelope.value === "object"
      && envelope.value !== null
      && "type" in envelope.value
      && typeof envelope.value.type === "string"
    ) {
      throw new SessionEventCursorError(
        "A typed HRA cursor cannot be used as a session event cursor.",
        "type_mismatch",
      );
    }
    const parsed = sessionEventCursorPayloadSchema.safeParse(envelope.value);
    if (!parsed.success || canonicalPayload(parsed.data) !== envelope.payloadJson) {
      throw new SessionEventCursorError(
        "Session event cursor payload is not canonical.",
        "noncanonical",
      );
    }
    return parsed.data;
  }

  encodeInteraction(input: InteractionCursorPayload): string {
    const payload = interactionCursorPayloadSchema.parse(input);
    return this.#encodeCanonical(canonicalInteractionPayload(payload), "Interaction cursor");
  }

  decodeInteraction(
    cursor: string,
    expectedFilter: InteractionCursorFilter,
  ): InteractionCursorPayload {
    const expected = interactionCursorFilterSchema.parse(expectedFilter);
    const envelope = this.#decodeEnvelope(cursor, "Interaction cursor");
    if (
      typeof envelope.value !== "object"
      || envelope.value === null
      || !("type" in envelope.value)
      || envelope.value.type !== "interaction"
    ) {
      throw new SessionEventCursorError(
        "A session event cursor cannot be used as an interaction cursor.",
        "type_mismatch",
      );
    }
    const parsed = interactionCursorPayloadSchema.safeParse(envelope.value);
    if (!parsed.success || canonicalInteractionPayload(parsed.data) !== envelope.payloadJson) {
      throw new SessionEventCursorError(
        "Interaction cursor payload is not canonical.",
        "noncanonical",
      );
    }
    if (!sameInteractionFilter(parsed.data, expected)) {
      throw new SessionEventCursorError(
        "Interaction cursor filters do not match the requested interaction list.",
        "filter_mismatch",
      );
    }
    return parsed.data;
  }

  encodeLocalSessionList(
    input: LocalSessionListCursorFilter & Readonly<{
      afterCreatedAt: number;
      afterSessionId: string;
    }>,
  ): string {
    const payload = localSessionListCursorPayloadSchema.parse({
      version: 1,
      type: "session_list_local",
      accountId: input.accountId,
      accountGeneration: input.accountGeneration,
      limit: input.limit,
      afterCreatedAt: input.afterCreatedAt,
      afterSessionId: input.afterSessionId,
    });
    return this.#encodeCanonical(
      canonicalLocalSessionListPayload(payload),
      "Local session-list cursor",
    );
  }

  decodeLocalSessionList(
    cursor: string,
    expectedFilter: LocalSessionListCursorFilter,
  ): LocalSessionListCursorPayload {
    const expected = localSessionListCursorFilterSchema.parse(expectedFilter);
    const envelope = this.#decodeEnvelope(cursor, "Local session-list cursor");
    if (
      typeof envelope.value !== "object"
      || envelope.value === null
      || !("type" in envelope.value)
      || envelope.value.type !== "session_list_local"
    ) {
      throw new SessionEventCursorError(
        "Another HRA cursor type cannot be used as a local session-list cursor.",
        "type_mismatch",
      );
    }
    const parsed = localSessionListCursorPayloadSchema.safeParse(envelope.value);
    if (
      !parsed.success
      || canonicalLocalSessionListPayload(parsed.data) !== envelope.payloadJson
    ) {
      throw new SessionEventCursorError(
        "Local session-list cursor payload is not canonical.",
        "noncanonical",
      );
    }
    if (!sameLocalSessionListFilter(parsed.data, expected)) {
      throw new SessionEventCursorError(
        "Local session-list cursor filters do not match the requested account listing.",
        "filter_mismatch",
      );
    }
    return parsed.data;
  }

  advanceSessionList(
    input: SessionListCursorFilter & Readonly<{
      providerCursor: string;
      prior?: SessionListCursorPayload;
    }>,
  ): string {
    const filter = sessionListCursorFilterSchema.parse({
      accountId: input.accountId,
      providerGeneration: input.providerGeneration,
      limit: input.limit,
    });
    const providerCursor = sessionListProviderCursorSchema.safeParse(input.providerCursor);
    if (!providerCursor.success) {
      throw new SessionEventCursorError(
        "The provider session-list cursor exceeds its safe continuation bound.",
        "too_large",
      );
    }
    const digest = sessionListProviderCursorDigest(providerCursor.data);
    let checkpointDigest = digest;
    let power = 1;
    let span = 0;
    let pageCount = 1;
    if (input.prior !== undefined) {
      const prior = sessionListCursorPayloadSchema.safeParse(input.prior);
      if (!prior.success) {
        throw new SessionEventCursorError(
          "The prior session-list cycle state is not canonical.",
          "noncanonical",
        );
      }
      if (!sameSessionListFilter(prior.data, filter)) {
        throw new SessionEventCursorError(
          "Session-list cursor filters do not match the requested account listing.",
          "filter_mismatch",
        );
      }
      if (
        providerCursor.data === prior.data.providerCursor
        || digest === prior.data.checkpointDigest
      ) {
        throw new SessionEventCursorError(
          "The provider session-list cursor entered a deterministic cycle.",
          "nonadvancing",
        );
      }
      if (prior.data.pageCount >= Number.MAX_SAFE_INTEGER) {
        throw new SessionEventCursorError(
          "The safe session-list page count is exhausted.",
          "progress_exhausted",
        );
      }
      pageCount = prior.data.pageCount + 1;
      span = prior.data.span + 1;
      power = prior.data.power;
      checkpointDigest = prior.data.checkpointDigest;
      if (span === power) {
        checkpointDigest = digest;
        power *= 2;
        span = 0;
      }
    }
    const payload = sessionListCursorPayloadSchema.parse({
      version: 1,
      type: "session_list",
      ...filter,
      providerCursor: providerCursor.data,
      checkpointDigest,
      power,
      span,
      pageCount,
    });
    return this.#encodeCanonical(canonicalSessionListPayload(payload), "Session-list cursor");
  }

  decodeSessionList(
    cursor: string,
    expectedFilter: SessionListCursorFilter,
  ): SessionListCursorPayload {
    const expected = sessionListCursorFilterSchema.parse(expectedFilter);
    const envelope = this.#decodeEnvelope(cursor, "Session-list cursor");
    if (
      typeof envelope.value !== "object"
      || envelope.value === null
      || !("type" in envelope.value)
      || envelope.value.type !== "session_list"
    ) {
      throw new SessionEventCursorError(
        "Another HRA cursor type cannot be used as a session-list cursor.",
        "type_mismatch",
      );
    }
    const parsed = sessionListCursorPayloadSchema.safeParse(envelope.value);
    if (
      !parsed.success
      || canonicalSessionListPayload(parsed.data) !== envelope.payloadJson
    ) {
      throw new SessionEventCursorError(
        "Session-list cursor payload is not canonical.",
        "noncanonical",
      );
    }
    if (!sameSessionListFilter(parsed.data, expected)) {
      throw new SessionEventCursorError(
        "Session-list cursor filters do not match the requested account listing.",
        "filter_mismatch",
      );
    }
    return parsed.data;
  }

  #encodeCanonical(payloadJson: string, label: string): string {
    const encodedPayload = Buffer.from(payloadJson, "utf8").toString("base64url");
    const signature = this.#signature(encodedPayload).toString("base64url");
    const cursor = `${CURSOR_PREFIX}.${encodedPayload}.${signature}`;
    if (Buffer.byteLength(cursor, "utf8") > HRA_CURSOR_MAX_BYTES) {
      throw new Error(`${label} exceeds its byte bound.`);
    }
    return cursor;
  }

  #decodeEnvelope(cursor: string, label: string): DecodedCursorEnvelope {
    if (Buffer.byteLength(cursor, "utf8") > HRA_CURSOR_MAX_BYTES) {
      throw new SessionEventCursorError(`${label} exceeds its byte bound.`, "too_large");
    }
    const parts = cursor.split(".");
    if (parts.length !== 3 || parts[0] !== CURSOR_PREFIX) {
      throw new SessionEventCursorError(`${label} version is unsupported.`, "unsupported_version");
    }
    const encodedPayload = parts[1];
    const encodedSignature = parts[2];
    if (encodedPayload === undefined || encodedSignature === undefined) {
      throw new SessionEventCursorError(`${label} is malformed.`, "malformed");
    }
    const provided = decodeBase64Url(encodedSignature, `${label} signature`);
    const expected = this.#signature(encodedPayload);
    if (provided.byteLength !== expected.byteLength || !timingSafeEqual(provided, expected)) {
      throw new SessionEventCursorError(`${label} signature is invalid.`, "invalid_signature");
    }
    let payloadJson: string;
    let value: unknown;
    try {
      payloadJson = decodeBase64Url(encodedPayload, `${label} payload`).toString("utf8");
      value = JSON.parse(payloadJson) as unknown;
    } catch (error) {
      if (error instanceof SessionEventCursorError) throw error;
      throw new SessionEventCursorError(`${label} payload is malformed.`, "malformed");
    }
    return { encodedPayload, payloadJson, value };
  }

  #signature(encodedPayload: string): Buffer {
    return createHmac("sha256", this.#key)
      .update(CURSOR_PREFIX)
      .update("\0")
      .update(encodedPayload)
      .digest();
  }
}
