import { describe, expect, test } from "bun:test";

import { createSessionId } from "../domain/values";
import { SessionEventCursorCodec, SessionEventCursorError } from "./session-event-cursor";

describe("SessionEventCursorCodec", () => {
  test("round trips one canonical session-bound epoch cursor", () => {
    const codec = new SessionEventCursorCodec(SessionEventCursorCodec.generateKey());
    const payload = {
      version: 1 as const,
      sessionId: createSessionId(),
      streamEpoch: crypto.randomUUID(),
      sequence: 42,
    };
    const cursor = codec.encode(payload);
    expect(codec.decode(cursor)).toEqual(payload);
    expect(cursor).toStartWith("hra1.");
  });

  test("rejects tampering, foreign keys, noncanonical payloads, and oversized values", () => {
    const first = new SessionEventCursorCodec(SessionEventCursorCodec.generateKey());
    const second = new SessionEventCursorCodec(SessionEventCursorCodec.generateKey());
    const cursor = first.encode({
      version: 1,
      sessionId: createSessionId(),
      streamEpoch: crypto.randomUUID(),
      sequence: 0,
    });
    expect(() => second.decode(cursor)).toThrow(SessionEventCursorError);
    const base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = cursor.at(-1);
    const lastIndex = last === undefined ? -1 : base64UrlAlphabet.indexOf(last);
    if (lastIndex < 0 || lastIndex % 4 !== 0) throw new Error("Expected a canonical SHA-256 signature.");
    const noncanonicalAlias = base64UrlAlphabet[lastIndex + 1];
    if (noncanonicalAlias === undefined) throw new Error("Expected a base64url alias.");
    expect(() => first.decode(`${cursor.slice(0, -1)}${noncanonicalAlias}`))
      .toThrow(SessionEventCursorError);
    expect(() => first.decode(`hra1.${Buffer.from('{"sequence":0,"version":1}', "utf8").toString("base64url")}.x`)).toThrow(SessionEventCursorError);
    expect(() => first.decode(`hra1.${"a".repeat(3_000)}.x`)).toThrow(SessionEventCursorError);
  });

  test("keeps numeric sequence and session identity inside the authenticated payload", () => {
    const codec = new SessionEventCursorCodec(SessionEventCursorCodec.generateKey());
    const sessionId = createSessionId();
    const otherSessionId = createSessionId();
    const cursor = codec.encode({
      version: 1,
      sessionId,
      streamEpoch: crypto.randomUUID(),
      sequence: Number.MAX_SAFE_INTEGER,
    });
    const decoded = codec.decode(cursor);
    expect(decoded.sessionId).toBe(sessionId);
    expect(decoded.sessionId).not.toBe(otherSessionId);
    expect(decoded.sequence).toBe(Number.MAX_SAFE_INTEGER);
  });
});
