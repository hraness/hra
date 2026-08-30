import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { profileIdSchema, unixMillisecondsSchema } from "../domain/values";

const CURSOR_PREFIX = "hrau1";
const ACCOUNT_BINDING_CONTEXT = "hra:usage-history-cursor:account-binding:v1";
export const USAGE_HISTORY_CURSOR_MAX_BYTES = 2_048;
export const USAGE_HISTORY_CURSOR_TTL_MS = 5 * 60_000;

const accountFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const accountBindingSchema = z.string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/u)
  .refine((value) => {
    const decoded = Buffer.from(value, "base64url");
    return decoded.byteLength === 32 && decoded.toString("base64url") === value;
  }, "Usage-history cursor account binding is not canonical.");

export type UsageHistoryCursorErrorReason =
  | "account_mismatch"
  | "expired"
  | "filter_mismatch"
  | "invalid_signature"
  | "malformed"
  | "noncanonical"
  | "too_large"
  | "unsupported_version";

export class UsageHistoryCursorError extends Error {
  constructor(
    message: string,
    readonly reason: UsageHistoryCursorErrorReason = "malformed",
  ) {
    super(message);
    this.name = "UsageHistoryCursorError";
  }
}

export const usageHistoryCursorPayloadSchema = z.object({
  version: z.literal(1),
  type: z.literal("account_usage_history"),
  accountId: profileIdSchema,
  accountBinding: accountBindingSchema,
  fromObservedAt: unixMillisecondsSchema,
  throughObservedAt: unixMillisecondsSchema,
  afterSourceRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  issuedAt: unixMillisecondsSchema.max(Number.MAX_SAFE_INTEGER - USAGE_HISTORY_CURSOR_TTL_MS),
  expiresAt: unixMillisecondsSchema,
}).strict().superRefine((value, context) => {
  if (value.fromObservedAt > value.throughObservedAt) {
    context.addIssue({
      code: "custom",
      message: "Usage-history cursor range is reversed.",
    });
  }
  if (value.throughObservedAt > value.issuedAt) {
    context.addIssue({
      code: "custom",
      message: "Usage-history cursor range extends beyond its issue time.",
    });
  }
  if (value.expiresAt !== value.issuedAt + USAGE_HISTORY_CURSOR_TTL_MS) {
    context.addIssue({
      code: "custom",
      message: "Usage-history cursor expiry is not canonical.",
    });
  }
});

export type UsageHistoryCursorPayload = z.infer<typeof usageHistoryCursorPayloadSchema>;

export type UsageHistoryCursorEncodeInput = Readonly<
  Omit<UsageHistoryCursorPayload, "accountBinding" | "expiresAt">
  & { accountFingerprint: string }
>;

export type UsageHistoryCursorFilter = Readonly<{
  accountId: string;
  accountFingerprint: string;
  fromObservedAt?: number;
  throughObservedAt?: number;
}>;

const canonicalPayload = (payload: UsageHistoryCursorPayload): string => JSON.stringify({
  version: payload.version,
  type: payload.type,
  accountId: payload.accountId,
  accountBinding: payload.accountBinding,
  fromObservedAt: payload.fromObservedAt,
  throughObservedAt: payload.throughObservedAt,
  afterSourceRevision: payload.afterSourceRevision,
  issuedAt: payload.issuedAt,
  expiresAt: payload.expiresAt,
});

const decodeBase64Url = (value: string, label: string): Buffer => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new UsageHistoryCursorError(`${label} is malformed.`, "malformed");
  }
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) {
      throw new UsageHistoryCursorError(`${label} is not canonical.`, "noncanonical");
    }
    return decoded;
  } catch (error: unknown) {
    if (error instanceof UsageHistoryCursorError) throw error;
    throw new UsageHistoryCursorError(`${label} is malformed.`, "malformed");
  }
};

export class UsageHistoryCursorCodec {
  readonly #key: Buffer;

  constructor(key: string | Uint8Array) {
    const decoded = typeof key === "string"
      ? decodeBase64Url(key, "Usage-history cursor key")
      : Buffer.from(key);
    if (decoded.byteLength !== 32) {
      throw new Error("Usage-history cursor key must be exactly 32 bytes.");
    }
    this.#key = Buffer.from(decoded);
  }

  static generateKey(): string {
    return randomBytes(32).toString("base64url");
  }

  encode(input: UsageHistoryCursorEncodeInput): string {
    const { accountFingerprint, ...position } = input;
    const parsedFingerprint = accountFingerprintSchema.parse(accountFingerprint);
    const payload = usageHistoryCursorPayloadSchema.parse({
      ...position,
      accountBinding: this.#accountBinding(parsedFingerprint).toString("base64url"),
      expiresAt: input.issuedAt + USAGE_HISTORY_CURSOR_TTL_MS,
    });
    const encodedPayload = Buffer.from(canonicalPayload(payload), "utf8").toString("base64url");
    const signature = this.#signature(encodedPayload).toString("base64url");
    const cursor = `${CURSOR_PREFIX}.${encodedPayload}.${signature}`;
    if (Buffer.byteLength(cursor, "utf8") > USAGE_HISTORY_CURSOR_MAX_BYTES) {
      throw new Error("Usage-history cursor exceeds its byte bound.");
    }
    return cursor;
  }

  decode(
    cursor: string,
    expected: UsageHistoryCursorFilter & Readonly<{ now: number }>,
  ): UsageHistoryCursorPayload {
    const now = unixMillisecondsSchema.parse(expected.now);
    if (Buffer.byteLength(cursor, "utf8") > USAGE_HISTORY_CURSOR_MAX_BYTES) {
      throw new UsageHistoryCursorError(
        "Usage-history cursor exceeds its byte bound.",
        "too_large",
      );
    }
    const parts = cursor.split(".");
    if (parts.length !== 3 || parts[0] !== CURSOR_PREFIX) {
      throw new UsageHistoryCursorError(
        "Usage-history cursor version is unsupported.",
        "unsupported_version",
      );
    }
    const encodedPayload = parts[1];
    const encodedSignature = parts[2];
    if (encodedPayload === undefined || encodedSignature === undefined) {
      throw new UsageHistoryCursorError("Usage-history cursor is malformed.", "malformed");
    }
    const provided = decodeBase64Url(encodedSignature, "Usage-history cursor signature");
    const signature = this.#signature(encodedPayload);
    if (provided.byteLength !== signature.byteLength || !timingSafeEqual(provided, signature)) {
      throw new UsageHistoryCursorError(
        "Usage-history cursor signature is invalid.",
        "invalid_signature",
      );
    }
    let payloadJson: string;
    let value: unknown;
    try {
      payloadJson = decodeBase64Url(encodedPayload, "Usage-history cursor payload").toString("utf8");
      value = JSON.parse(payloadJson) as unknown;
    } catch (error: unknown) {
      if (error instanceof UsageHistoryCursorError) throw error;
      throw new UsageHistoryCursorError("Usage-history cursor payload is malformed.", "malformed");
    }
    const parsed = usageHistoryCursorPayloadSchema.safeParse(value);
    if (!parsed.success || canonicalPayload(parsed.data) !== payloadJson) {
      throw new UsageHistoryCursorError(
        "Usage-history cursor payload is not canonical.",
        "noncanonical",
      );
    }
    if (parsed.data.accountId !== profileIdSchema.parse(expected.accountId)) {
      throw new UsageHistoryCursorError(
        "Usage-history cursor belongs to another account.",
        "account_mismatch",
      );
    }
    const parsedFingerprint = accountFingerprintSchema.parse(expected.accountFingerprint);
    const providedBinding = Buffer.from(parsed.data.accountBinding, "base64url");
    const expectedBinding = this.#accountBinding(parsedFingerprint);
    if (
      providedBinding.byteLength !== expectedBinding.byteLength
      || !timingSafeEqual(providedBinding, expectedBinding)
    ) {
      throw new UsageHistoryCursorError(
        "Usage-history cursor belongs to another account identity.",
        "account_mismatch",
      );
    }
    if (
      (expected.fromObservedAt !== undefined
        && parsed.data.fromObservedAt !== unixMillisecondsSchema.parse(expected.fromObservedAt))
      || (expected.throughObservedAt !== undefined
        && parsed.data.throughObservedAt !== unixMillisecondsSchema.parse(expected.throughObservedAt))
    ) {
      throw new UsageHistoryCursorError(
        "Usage-history cursor range does not match the requested range.",
        "filter_mismatch",
      );
    }
    if (now > parsed.data.expiresAt) {
      throw new UsageHistoryCursorError(
        "Usage-history cursor expired. Start a fresh history query.",
        "expired",
      );
    }
    return parsed.data;
  }

  #signature(encodedPayload: string): Buffer {
    return createHmac("sha256", this.#key)
      .update(CURSOR_PREFIX)
      .update("\0")
      .update(encodedPayload)
      .digest();
  }

  #accountBinding(accountFingerprint: string): Buffer {
    return createHmac("sha256", this.#key)
      .update(ACCOUNT_BINDING_CONTEXT)
      .update("\0")
      .update(accountFingerprint)
      .digest();
  }
}
