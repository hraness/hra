import { createHmac } from "node:crypto";

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { sessionEventCursorWireSchema } from "../domain/session-events";
import { createWorkId, createWorkTaskId, workEventCursorWireSchema } from "../domain/work";
import { createSessionId } from "../domain/values";
import {
  HRA_CURSOR_MAX_BYTES,
  SessionEventCursorCodec,
  SessionEventCursorError,
  type SessionEventCursorErrorReason,
} from "./session-event-cursor";

const FIXED_KEY = Uint8Array.from({ length: 32 }, (_, index) => index);

const signedCursor = (payloadJson: string, key: Uint8Array = FIXED_KEY): string => {
  const encodedPayload = Buffer.from(payloadJson, "utf8").toString("base64url");
  const signature = createHmac("sha256", key)
    .update("hra1")
    .update("\0")
    .update(encodedPayload)
    .digest("base64url");
  return `hra1.${encodedPayload}.${signature}`;
};

const expectCursorRejection = (
  callback: () => unknown,
  reason: SessionEventCursorErrorReason,
): SessionEventCursorError => {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(SessionEventCursorError);
    const cursorError = error as SessionEventCursorError;
    expect(cursorError.reason).toBe(reason);
    return cursorError;
  }
  throw new Error(`Expected cursor rejection ${reason}.`);
};

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
    expect(sessionEventCursorWireSchema.parse(cursor)).toBe(cursor);
    expect(cursor).toStartWith("hra1.");
  });

  test("keeps the original hra1 event-cursor wire representation exactly", () => {
    const codec = new SessionEventCursorCodec(FIXED_KEY);
    expect(codec.encode({
      version: 1,
      sessionId: "sess_00000000000000000000000000000000",
      streamEpoch: "00000000-0000-4000-8000-000000000000",
      sequence: 42,
    })).toBe(
      "hra1.eyJ2ZXJzaW9uIjoxLCJzZXNzaW9uSWQiOiJzZXNzXzAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwic3RyZWFtRXBvY2giOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDAiLCJzZXF1ZW5jZSI6NDJ9.iXukWPzXSWWXf738iBzxcw7GjkjXSHW9N7h5j9RWVTI",
    );
  });

  test("keeps opaque provider aliases stable only under the same durable key", () => {
    const first = new SessionEventCursorCodec(FIXED_KEY);
    const restarted = new SessionEventCursorCodec(FIXED_KEY);
    const foreign = new SessionEventCursorCodec(
      Uint8Array.from({ length: 32 }, (_, index) => 255 - index),
    );
    const raw = "token=LOW-ENTROPY-PROVIDER-ID";
    const alias = first.projectPublicProviderIdentifier(raw);
    expect(alias).toMatch(/^opaque_v2_[a-f0-9]{64}$/u);
    expect(restarted.projectPublicProviderIdentifier(raw)).toBe(alias);
    expect(foreign.projectPublicProviderIdentifier(raw)).not.toBe(alias);
    expect(first.projectPublicProviderIdentifier(alias)).not.toBe(alias);
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
    expectCursorRejection(
      () => first.decode(`hra1.${"a".repeat(3_000)}.x`),
      "too_large",
    );
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

  test("round trips one canonical work-bound epoch cursor", () => {
    const codec = new SessionEventCursorCodec(FIXED_KEY);
    const payload = {
      version: 1 as const,
      type: "work" as const,
      workId: createWorkId(),
      streamEpoch: crypto.randomUUID(),
      sequence: 42,
    };
    const cursor = codec.encodeWorkEvent(payload);
    expect(codec.decodeWorkEvent(cursor, payload.workId)).toEqual(payload);
    expect(workEventCursorWireSchema.parse(cursor)).toBe(cursor);
    expect(Buffer.byteLength(cursor, "utf8")).toBeLessThanOrEqual(HRA_CURSOR_MAX_BYTES);
  });

  test("binds work cursors to their exact work plan, cursor type, and signing key", () => {
    const codec = new SessionEventCursorCodec(FIXED_KEY);
    const workId = createWorkId();
    const otherWorkId = createWorkId();
    const cursor = codec.encodeWorkEvent({
      version: 1,
      type: "work",
      workId,
      streamEpoch: crypto.randomUUID(),
      sequence: Number.MAX_SAFE_INTEGER,
    });
    expectCursorRejection(
      () => codec.decodeWorkEvent(cursor, otherWorkId),
      "filter_mismatch",
    );
    expectCursorRejection(() => codec.decode(cursor), "type_mismatch");
    const eventCursor = codec.encode({
      version: 1,
      sessionId: createSessionId(),
      streamEpoch: crypto.randomUUID(),
      sequence: 1,
    });
    expectCursorRejection(
      () => codec.decodeWorkEvent(eventCursor, workId),
      "type_mismatch",
    );
    const foreign = new SessionEventCursorCodec(
      Uint8Array.from({ length: 32 }, (_, index) => 255 - index),
    );
    expectCursorRejection(
      () => foreign.decodeWorkEvent(cursor, workId),
      "invalid_signature",
    );
    const [prefix, payload, signature] = cursor.split(".");
    const replacement = signature?.startsWith("A") === true ? "B" : "A";
    const tampered = `${prefix}.${payload}.${replacement}${signature?.slice(1)}`;
    expectCursorRejection(
      () => codec.decodeWorkEvent(tampered, workId),
      "invalid_signature",
    );
  });

  test("binds action continuations to the exact work, actor, stream cut, and cursor type", () => {
    const codec = new SessionEventCursorCodec(FIXED_KEY);
    const workId = createWorkId();
    const actorSessionId = createSessionId();
    const payload = {
      version: 1 as const,
      type: "work_actions" as const,
      workId,
      streamEpoch: crypto.randomUUID(),
      sequence: 19,
      projectionAt: 123_456,
      actorSessionId,
      offsets: {
        readyTasks: 3,
        ownedAttempts: 2,
        recoveryAttempts: 1,
        reviewableSubmissions: 4,
        signals: 5,
        preparedEffects: 6,
      },
    };
    const cursor = codec.encodeWorkAction(payload);
    expect(codec.decodeWorkAction(cursor, workId, actorSessionId)).toEqual(payload);
    expect(workEventCursorWireSchema.parse(cursor)).toBe(cursor);
    expectCursorRejection(
      () => codec.decodeWorkAction(cursor, createWorkId(), actorSessionId),
      "filter_mismatch",
    );
    expectCursorRejection(
      () => codec.decodeWorkAction(cursor, workId, createSessionId()),
      "filter_mismatch",
    );
    expectCursorRejection(
      () => codec.decodeWorkEvent(cursor, workId),
      "type_mismatch",
    );
  });

  test("binds task-history continuations to the exact work and task", () => {
    const codec = new SessionEventCursorCodec(FIXED_KEY);
    const workId = createWorkId();
    const taskId = createWorkTaskId();
    const payload = {
      version: 1 as const,
      type: "work_task_history" as const,
      workId,
      taskId,
      streamEpoch: crypto.randomUUID(),
      sequence: 41,
      projectionAt: 123_456,
      highWaterOrdinal: 77,
      taskRevision: 9,
      offset: 50,
    };
    const cursor = codec.encodeWorkTaskHistory(payload);
    expect(codec.decodeWorkTaskHistory(cursor, taskId)).toEqual(payload);
    expect(workEventCursorWireSchema.parse(cursor)).toBe(cursor);
    expect(Buffer.byteLength(cursor, "utf8")).toBeLessThanOrEqual(HRA_CURSOR_MAX_BYTES);
    expectCursorRejection(
      () => codec.decodeWorkTaskHistory(cursor, createWorkTaskId()),
      "filter_mismatch",
    );
    expectCursorRejection(
      () => codec.decodeWorkAction(cursor, workId, null),
      "type_mismatch",
    );
    const [prefix, encoded, signature] = cursor.split(".");
    const replacement = signature?.startsWith("A") === true ? "B" : "A";
    expectCursorRejection(
      () => codec.decodeWorkTaskHistory(
        `${prefix}.${encoded}.${replacement}${signature?.slice(1)}`,
        taskId,
      ),
      "invalid_signature",
    );
  });

  test("round trips global and exact-session interaction keysets", () => {
    const codec = new SessionEventCursorCodec(SessionEventCursorCodec.generateKey());
    const globalPayload = {
      version: 1 as const,
      type: "interaction" as const,
      scope: { type: "global" as const },
      pending: true,
      requestedAt: 1_725_000_000_123,
      publicId: "00000000-0000-4000-8000-000000000001",
    };
    const globalCursor = codec.encodeInteraction(globalPayload);
    expect(codec.decodeInteraction(globalCursor, {
      scope: { type: "global" },
      pending: true,
    })).toEqual(globalPayload);

    const sessionPayload = {
      ...globalPayload,
      scope: { type: "session" as const, sessionId: createSessionId() },
      pending: false,
      publicId: "00000000-0000-4000-8000-000000000002",
    };
    const sessionCursor = codec.encodeInteraction(sessionPayload);
    expect(codec.decodeInteraction(sessionCursor, {
      scope: sessionPayload.scope,
      pending: false,
    })).toEqual(sessionPayload);
    expect(Buffer.byteLength(sessionCursor, "utf8")).toBeLessThanOrEqual(HRA_CURSOR_MAX_BYTES);
  });

  test("rejects interaction cursor tampering and foreign signing keys", () => {
    const first = new SessionEventCursorCodec(SessionEventCursorCodec.generateKey());
    const second = new SessionEventCursorCodec(SessionEventCursorCodec.generateKey());
    const filter = { scope: { type: "global" as const }, pending: false };
    const cursor = first.encodeInteraction({
      version: 1,
      type: "interaction",
      ...filter,
      requestedAt: 100,
      publicId: "00000000-0000-4000-8000-000000000003",
    });
    expectCursorRejection(() => second.decodeInteraction(cursor, filter), "invalid_signature");

    const base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = cursor.at(-1);
    const lastIndex = last === undefined ? -1 : base64UrlAlphabet.indexOf(last);
    if (lastIndex < 0 || lastIndex % 4 !== 0) {
      throw new Error("Expected a canonical SHA-256 signature.");
    }
    const replacement = base64UrlAlphabet[(lastIndex + 4) % base64UrlAlphabet.length];
    if (replacement === undefined) throw new Error("Expected a signature replacement.");
    expectCursorRejection(
      () => first.decodeInteraction(`${cursor.slice(0, -1)}${replacement}`, filter),
      "invalid_signature",
    );
  });

  test("rejects signed but noncanonical interaction payloads", () => {
    const codec = new SessionEventCursorCodec(FIXED_KEY);
    const filter = { scope: { type: "global" as const }, pending: true };
    const reordered = JSON.stringify({
      type: "interaction",
      version: 1,
      scope: { type: "global" },
      pending: true,
      requestedAt: 123,
      publicId: "00000000-0000-4000-8000-000000000004",
    });
    expectCursorRejection(
      () => codec.decodeInteraction(signedCursor(reordered), filter),
      "noncanonical",
    );

    const extraField = JSON.stringify({
      version: 1,
      type: "interaction",
      scope: { type: "global" },
      pending: true,
      requestedAt: 123,
      publicId: "00000000-0000-4000-8000-000000000004",
      ignored: true,
    });
    expectCursorRejection(
      () => codec.decodeInteraction(signedCursor(extraField), filter),
      "noncanonical",
    );
  });

  test("rejects cross-type cursor use explicitly", () => {
    const codec = new SessionEventCursorCodec(SessionEventCursorCodec.generateKey());
    const eventCursor = codec.encode({
      version: 1,
      sessionId: createSessionId(),
      streamEpoch: crypto.randomUUID(),
      sequence: 1,
    });
    expectCursorRejection(
      () => codec.decodeInteraction(eventCursor, {
        scope: { type: "global" },
        pending: false,
      }),
      "type_mismatch",
    );

    const interactionCursor = codec.encodeInteraction({
      version: 1,
      type: "interaction",
      scope: { type: "global" },
      pending: false,
      requestedAt: 1,
      publicId: "00000000-0000-4000-8000-000000000005",
    });
    expectCursorRejection(() => codec.decode(interactionCursor), "type_mismatch");
  });

  test("binds interaction cursors to pending and exact resolved session filters", () => {
    const codec = new SessionEventCursorCodec(SessionEventCursorCodec.generateKey());
    const sessionId = createSessionId();
    const cursor = codec.encodeInteraction({
      version: 1,
      type: "interaction",
      scope: { type: "session", sessionId },
      pending: true,
      requestedAt: 99,
      publicId: "00000000-0000-4000-8000-000000000006",
    });
    expectCursorRejection(
      () => codec.decodeInteraction(cursor, {
        scope: { type: "session", sessionId },
        pending: false,
      }),
      "filter_mismatch",
    );
    expectCursorRejection(
      () => codec.decodeInteraction(cursor, {
        scope: { type: "session", sessionId: createSessionId() },
        pending: true,
      }),
      "filter_mismatch",
    );
    expectCursorRejection(
      () => codec.decodeInteraction(cursor, {
        scope: { type: "global" },
        pending: true,
      }),
      "filter_mismatch",
    );
  });

  test("enforces the shared 2048-byte cursor decode bound before parsing", () => {
    const codec = new SessionEventCursorCodec(SessionEventCursorCodec.generateKey());
    const oversized = `hra1.${"a".repeat(HRA_CURSOR_MAX_BYTES)}.x`;
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(HRA_CURSOR_MAX_BYTES);
    expectCursorRejection(
      () => codec.decodeInteraction(oversized, {
        scope: { type: "global" },
        pending: false,
      }),
      "too_large",
    );
  });

  test("round trips bounded account-scoped session-list continuations", () => {
    const codec = new SessionEventCursorCodec(FIXED_KEY);
    const traversalId = "00000000-0000-4000-8000-000000000041";
    const filter = {
      accountId: "acct_00000000000000000000000000000000" as const,
      providerGeneration: 7,
      limit: 37,
      includeArchived: false,
    };
    const first = codec.advanceSessionList({
      ...filter,
      traversalId,
      providerCursor: "provider-page-2",
    });
    const decodedFirst = codec.decodeSessionList(first, filter);
    expect(decodedFirst).toMatchObject({
      version: 1,
      type: "session_list",
      ...filter,
      traversalId,
      providerCursor: "provider-page-2",
      power: 1,
      span: 0,
      pageCount: 1,
    });
    expect(decodedFirst.checkpointDigest).toHaveLength(43);

    const second = codec.advanceSessionList({
      ...filter,
      providerCursor: "provider-page-3",
      prior: decodedFirst,
    });
    const decodedSecond = codec.decodeSessionList(second, filter);
    expect(decodedSecond).toMatchObject({
      traversalId,
      providerCursor: "provider-page-3",
      power: 2,
      span: 0,
      pageCount: 2,
    });
    expect(Buffer.byteLength(second, "utf8")).toBeLessThanOrEqual(HRA_CURSOR_MAX_BYTES);
    expectCursorRejection(
      () => codec.advanceSessionList({
        ...filter,
        traversalId: "00000000-0000-4000-8000-000000000042",
        providerCursor: "provider-page-4",
        prior: decodedSecond,
      }),
      "filter_mismatch",
    );
  });

  test("binds session-list cursors to the immutable account generation and exact limit", () => {
    const codec = new SessionEventCursorCodec(FIXED_KEY);
    const filter = {
      accountId: "acct_00000000000000000000000000000000" as const,
      providerGeneration: 3,
      limit: 50,
      includeArchived: false,
    };
    const cursor = codec.advanceSessionList({ ...filter, providerCursor: "provider-next" });
    for (const mismatch of [
      { ...filter, accountId: "acct_11111111111111111111111111111111" as const },
      { ...filter, providerGeneration: 4 },
      { ...filter, limit: 49 },
      { ...filter, includeArchived: true },
    ]) {
      expectCursorRejection(() => codec.decodeSessionList(cursor, mismatch), "filter_mismatch");
    }
  });

  test("round trips local-only session-list positions bound to the exact signed-out account filter", () => {
    const codec = new SessionEventCursorCodec(FIXED_KEY);
    const filter = {
      accountId: "acct_00000000000000000000000000000000" as const,
      accountGeneration: 0,
      limit: 37,
      includeArchived: false,
    };
    const cursor = codec.encodeLocalSessionList({
      ...filter,
      afterCreatedAt: 12_345,
      afterSessionId: "sess_11111111111111111111111111111111",
    });
    expect(codec.decodeLocalSessionList(cursor, filter)).toEqual({
      version: 1,
      type: "session_list_local",
      ...filter,
      afterCreatedAt: 12_345,
      afterSessionId: "sess_11111111111111111111111111111111",
    });
    expect(Buffer.byteLength(cursor, "utf8")).toBeLessThanOrEqual(HRA_CURSOR_MAX_BYTES);

    for (const mismatch of [
      { ...filter, accountId: "acct_22222222222222222222222222222222" as const },
      { ...filter, accountGeneration: 1 },
      { ...filter, limit: 36 },
      { ...filter, includeArchived: true },
    ]) {
      expectCursorRejection(
        () => codec.decodeLocalSessionList(cursor, mismatch),
        "filter_mismatch",
      );
    }
    const parts = cursor.split(".");
    const encodedPayload = parts[1];
    const signature = parts[2];
    if (encodedPayload === undefined || signature === undefined) {
      throw new Error("Expected a signed local session-list cursor.");
    }
    const replacement = signature[0] === "A" ? "B" : "A";
    expectCursorRejection(
      () => codec.decodeLocalSessionList(
        `hra1.${encodedPayload}.${replacement}${signature.slice(1)}`,
        filter,
      ),
      "invalid_signature",
    );
  });

  test("round trips source-neutral account-local continuations disjoint from provider cursors", () => {
    const codec = new SessionEventCursorCodec(FIXED_KEY);
    const traversalId = "00000000-0000-4000-8000-000000000043";
    const filter = {
      accountId: "acct_00000000000000000000000000000000" as const,
      providerGeneration: 7,
      limit: 2,
      includeArchived: false,
    };
    const initial = codec.encodeAccountSessionLocal({
      ...filter,
      traversalId,
      afterCreatedAt: null,
      afterSessionId: null,
    });
    expect(codec.decodeAccountSessionLocal(initial, filter)).toEqual({
      version: 1,
      type: "session_list_account_local",
      ...filter,
      traversalId,
      afterCreatedAt: null,
      afterSessionId: null,
    });
    const encodedPayload = initial.split(".")[1];
    if (encodedPayload === undefined) throw new Error("Expected an account-tail payload.");
    expect(Buffer.from(encodedPayload, "base64url").toString("utf8"))
      .not.toContain("adopted");
    const continuation = codec.encodeAccountSessionLocal({
      ...filter,
      traversalId,
      afterCreatedAt: 12_345,
      afterSessionId: "sess_11111111111111111111111111111111",
    });
    expect(codec.decodeAccountSessionLocal(continuation, filter)).toMatchObject({
      afterCreatedAt: 12_345,
      afterSessionId: "sess_11111111111111111111111111111111",
    });
    expectCursorRejection(
      () => codec.decodeSessionList(initial, filter),
      "type_mismatch",
    );
    expectCursorRejection(
      () => codec.decodeAccountSessionLocal(continuation, { ...filter, limit: 1 }),
      "filter_mismatch",
    );
    expectCursorRejection(
      () => codec.decodeAccountSessionLocal(continuation, {
        ...filter,
        includeArchived: true,
      }),
      "filter_mismatch",
    );
    const legacyAdopted = signedCursor(JSON.stringify({
      version: 1,
      type: "session_list_adopted",
      ...filter,
      afterCreatedAt: null,
      afterSessionId: null,
    }));
    expectCursorRejection(
      () => codec.decodeAccountSessionLocal(legacyAdopted, filter),
      "type_mismatch",
    );
  });

  test("keeps provider and local session-list cursor authorities disjoint", () => {
    const codec = new SessionEventCursorCodec(FIXED_KEY);
    const accountId = "acct_00000000000000000000000000000000" as const;
    const localFilter = { accountId, accountGeneration: 2, limit: 10, includeArchived: false };
    const providerFilter = { accountId, providerGeneration: 2, limit: 10, includeArchived: false };
    const local = codec.encodeLocalSessionList({
      ...localFilter,
      afterCreatedAt: 1,
      afterSessionId: "sess_11111111111111111111111111111111",
    });
    const provider = codec.advanceSessionList({
      ...providerFilter,
      providerCursor: "provider-next",
    });
    expectCursorRejection(
      () => codec.decodeSessionList(local, providerFilter),
      "type_mismatch",
    );
    expectCursorRejection(
      () => codec.decodeLocalSessionList(provider, localFilter),
      "type_mismatch",
    );
  });

  test("permits more than 32 advancing pages with constant-size Brent state", () => {
    const codec = new SessionEventCursorCodec(FIXED_KEY);
    const filter = {
      accountId: "acct_00000000000000000000000000000000" as const,
      providerGeneration: 1,
      limit: 100,
      includeArchived: false,
    };
    const initialCursor = codec.advanceSessionList({
      ...filter,
      providerCursor: "x".repeat(512),
    });
    let prior = codec.decodeSessionList(initialCursor, filter);
    const maximumCursorBytes = Buffer.byteLength(initialCursor, "utf8");
    for (let page = 2; page <= 10_000; page += 1) {
      prior = codec.decodeSessionList(codec.advanceSessionList({
        ...filter,
        providerCursor: `provider-${String(page)}`,
        prior,
      }), filter);
    }
    expect(prior).toMatchObject({
      pageCount: 10_000,
      power: 8_192,
      span: 1_808,
    });
    expect(prior).not.toHaveProperty("seen");
    expect(maximumCursorBytes).toBeLessThanOrEqual(HRA_CURSOR_MAX_BYTES);
    expect(Buffer.byteLength(codec.advanceSessionList({
      ...filter,
      providerCursor: "provider-10001",
      prior,
    }), "utf8")).toBeLessThanOrEqual(maximumCursorBytes);
  });

  test("rejects immediate provider repeats, oversized cursors, and the safe-integer page ceiling", () => {
    const codec = new SessionEventCursorCodec(FIXED_KEY);
    const filter = {
      accountId: "acct_00000000000000000000000000000000" as const,
      providerGeneration: 1,
      limit: 100,
      includeArchived: false,
    };
    const first = codec.decodeSessionList(
      codec.advanceSessionList({ ...filter, providerCursor: "a" }),
      filter,
    );
    expectCursorRejection(
      () => codec.advanceSessionList({ ...filter, providerCursor: "a", prior: first }),
      "nonadvancing",
    );
    expectCursorRejection(
      () => codec.advanceSessionList({ ...filter, providerCursor: "x".repeat(513) }),
      "too_large",
    );
    expectCursorRejection(
      () => codec.advanceSessionList({ ...filter, providerCursor: "🧪".repeat(129) }),
      "too_large",
    );

    const maximumState = codec.decodeSessionList(signedCursor(JSON.stringify({
      version: 1,
      type: "session_list",
      ...filter,
      providerCursor: "provider-current",
      checkpointDigest: "A".repeat(43),
      power: 4_503_599_627_370_496,
      span: 4_503_599_627_370_495,
      pageCount: Number.MAX_SAFE_INTEGER,
    })), filter);
    expectCursorRejection(
      () => codec.advanceSessionList({
        ...filter,
        providerCursor: "provider-after-safe-maximum",
        prior: maximumState,
      }),
      "progress_exhausted",
    );
  });

  test("detects long deterministic cursor cycles in bounded additional pages", () => {
    const codec = new SessionEventCursorCodec(FIXED_KEY);
    const filter = {
      accountId: "acct_00000000000000000000000000000000" as const,
      providerGeneration: 1,
      limit: 100,
      includeArchived: false,
    };
    const prefix = Array.from({ length: 73 }, (_, index) => `prefix-${String(index)}`);
    const cycle = Array.from({ length: 257 }, (_, index) => `cycle-${String(index)}`);
    let prior: ReturnType<SessionEventCursorCodec["decodeSessionList"]> | undefined;
    let detectedAt: number | undefined;
    const bound = prefix.length + cycle.length * 3;
    for (let index = 0; index < bound; index += 1) {
      const providerCursor = index < prefix.length
        ? prefix[index]
        : cycle[(index - prefix.length) % cycle.length];
      if (providerCursor === undefined) throw new Error("Expected one deterministic cursor.");
      try {
        prior = codec.decodeSessionList(codec.advanceSessionList({
          ...filter,
          providerCursor,
          ...(prior === undefined ? {} : { prior }),
        }), filter);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(SessionEventCursorError);
        expect((error as SessionEventCursorError).reason).toBe("nonadvancing");
        detectedAt = index;
        break;
      }
    }
    expect(detectedAt).toBeDefined();
    expect(detectedAt).toBeLessThan(bound);
  });

  test("Brent continuation state admits unique sequences and detects arbitrary bounded cycles", () => {
    const codec = new SessionEventCursorCodec(FIXED_KEY);
    const filter = {
      accountId: "acct_00000000000000000000000000000000" as const,
      providerGeneration: 5,
      limit: 23,
      includeArchived: false,
    };
    fc.assert(fc.property(
      fc.uniqueArray(fc.integer(), { minLength: 33, maxLength: 256 }),
      (values) => {
        let prior: ReturnType<SessionEventCursorCodec["decodeSessionList"]> | undefined;
        for (const value of values) {
          prior = codec.decodeSessionList(codec.advanceSessionList({
            ...filter,
            providerCursor: `unique-${String(value)}`,
            ...(prior === undefined ? {} : { prior }),
          }), filter);
        }
        return prior?.pageCount === values.length;
      },
    ), { numRuns: 50 });

    fc.assert(fc.property(
      fc.integer({ min: 0, max: 64 }),
      fc.integer({ min: 1, max: 64 }),
      (prefixLength, cycleLength) => {
        let prior: ReturnType<SessionEventCursorCodec["decodeSessionList"]> | undefined;
        const bound = (prefixLength + cycleLength) * 4 + 4;
        for (let index = 0; index < bound; index += 1) {
          const providerCursor = index < prefixLength
            ? `property-prefix-${String(index)}`
            : `property-cycle-${String((index - prefixLength) % cycleLength)}`;
          try {
            prior = codec.decodeSessionList(codec.advanceSessionList({
              ...filter,
              providerCursor,
              ...(prior === undefined ? {} : { prior }),
            }), filter);
          } catch (error: unknown) {
            return error instanceof SessionEventCursorError
              && error.reason === "nonadvancing";
          }
        }
        return false;
      },
    ), { numRuns: 100 });
  });

  test("rejects tampered, cross-type, and internally inconsistent session-list cursors", () => {
    const codec = new SessionEventCursorCodec(FIXED_KEY);
    const filter = {
      accountId: "acct_00000000000000000000000000000000" as const,
      providerGeneration: 2,
      limit: 10,
      includeArchived: false,
    };
    const eventCursor = codec.encode({
      version: 1,
      sessionId: createSessionId(),
      streamEpoch: crypto.randomUUID(),
      sequence: 1,
    });
    expectCursorRejection(
      () => codec.decodeSessionList(eventCursor, filter),
      "type_mismatch",
    );

    const cursor = codec.advanceSessionList({ ...filter, providerCursor: "provider-next" });
    expectCursorRejection(() => codec.decode(cursor), "type_mismatch");
    expectCursorRejection(
      () => codec.decodeInteraction(cursor, { scope: { type: "global" }, pending: false }),
      "type_mismatch",
    );
    const replacement = cursor.at(-1) === "A" ? "B" : "A";
    expectCursorRejection(
      () => codec.decodeSessionList(`${cursor.slice(0, -1)}${replacement}`, filter),
      "invalid_signature",
    );

    const inconsistent = JSON.stringify({
      version: 1,
      type: "session_list",
      ...filter,
      providerCursor: "provider-next",
      checkpointDigest: "A".repeat(43),
      power: 1,
      span: 2,
      pageCount: 3,
    });
    expectCursorRejection(
      () => codec.decodeSessionList(signedCursor(inconsistent), filter),
      "noncanonical",
    );
  });
});
