import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { sessionEventCursorPayloadSchema, type SessionEventCursorPayload } from "../domain/session-events";

const CURSOR_PREFIX = "hra1";
const MAXIMUM_CURSOR_BYTES = 2_048;

export class SessionEventCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionEventCursorError";
  }
}

const canonicalPayload = (payload: SessionEventCursorPayload): string => JSON.stringify({
  version: payload.version,
  sessionId: payload.sessionId,
  streamEpoch: payload.streamEpoch,
  sequence: payload.sequence,
});

const decodeBase64Url = (value: string, label: string): Buffer => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new SessionEventCursorError(`${label} is malformed.`);
  try {
    return Buffer.from(value, "base64url");
  } catch {
    throw new SessionEventCursorError(`${label} is malformed.`);
  }
};

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
    const encodedPayload = Buffer.from(canonicalPayload(payload), "utf8").toString("base64url");
    const signature = this.#signature(encodedPayload).toString("base64url");
    const cursor = `${CURSOR_PREFIX}.${encodedPayload}.${signature}`;
    if (Buffer.byteLength(cursor, "utf8") > MAXIMUM_CURSOR_BYTES) {
      throw new Error("Session event cursor exceeds its byte bound.");
    }
    return cursor;
  }

  decode(cursor: string): SessionEventCursorPayload {
    if (Buffer.byteLength(cursor, "utf8") > MAXIMUM_CURSOR_BYTES) {
      throw new SessionEventCursorError("Session event cursor exceeds its byte bound.");
    }
    const parts = cursor.split(".");
    if (parts.length !== 3 || parts[0] !== CURSOR_PREFIX) {
      throw new SessionEventCursorError("Session event cursor version is unsupported.");
    }
    const encodedPayload = parts[1];
    const encodedSignature = parts[2];
    if (encodedPayload === undefined || encodedSignature === undefined) {
      throw new SessionEventCursorError("Session event cursor is malformed.");
    }
    const provided = decodeBase64Url(encodedSignature, "Session event cursor signature");
    const expected = this.#signature(encodedPayload);
    if (provided.byteLength !== expected.byteLength || !timingSafeEqual(provided, expected)) {
      throw new SessionEventCursorError("Session event cursor signature is invalid.");
    }
    let value: unknown;
    try {
      value = JSON.parse(decodeBase64Url(encodedPayload, "Session event cursor payload").toString("utf8")) as unknown;
    } catch {
      throw new SessionEventCursorError("Session event cursor payload is malformed.");
    }
    const parsed = sessionEventCursorPayloadSchema.safeParse(value);
    if (!parsed.success || canonicalPayload(parsed.data) !== decodeBase64Url(encodedPayload, "Session event cursor payload").toString("utf8")) {
      throw new SessionEventCursorError("Session event cursor payload is not canonical.");
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
}
