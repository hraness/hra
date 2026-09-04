import { describe, expect, test } from "bun:test";

import { randomKeyBytes } from "./crypto";
import {
  decryptUsageProjection,
  decryptRemoteCommand,
  encryptUsageProjection,
  encryptRemoteCommand,
  parseRemoteCommandPayload,
  parseSessionMetadataPayload,
} from "./payloads";
import {
  USAGE_CLOUD_ENVELOPE_MAX_CIPHERTEXT_CHARACTERS,
  USAGE_CLOUD_PROJECTION_MAX_LIMITS,
} from "./usage";
import { expectPromiseToReject } from "./testAssertions";

describe("closed encrypted payloads", () => {
  test("encrypts the exact maximum usage projection at the closed envelope boundary", async () => {
    const window = {
      resetsAt: Number.MAX_VALUE,
      usedPercent: 2.2250738585072014e-308,
      windowDurationMinutes: 365 * 24 * 60,
    } as const;
    const projection = {
      data: {
        currentStreakDays: Number.MAX_SAFE_INTEGER,
        daily: [{ startDate: "9999-99-99", tokens: Number.MAX_SAFE_INTEGER }],
        lifetimeTokens: Number.MAX_SAFE_INTEGER,
        limits: Array.from({ length: USAGE_CLOUD_PROJECTION_MAX_LIMITS }, (_, index) => ({
          id: `${index}${"x".repeat(95)}`,
          individual: false,
          name: "\0".repeat(96),
          primary: window,
          reached: false,
          secondary: window,
          unlimited: false,
        })),
        longestRunningTurnSeconds: Number.MAX_SAFE_INTEGER,
        longestStreakDays: Number.MAX_SAFE_INTEGER,
        peakDailyTokens: Number.MAX_SAFE_INTEGER,
      },
      state: "ready",
    } as const;
    const key = randomKeyBytes();
    const authority = {
      entityPublicId: "account_12345678",
      keyVersion: 1,
      kind: "usage",
      userPublicId: "user_12345678",
    } as const;
    const envelope = await encryptUsageProjection(projection, key, authority);
    expect(envelope.ciphertext).toHaveLength(
      USAGE_CLOUD_ENVELOPE_MAX_CIPHERTEXT_CHARACTERS,
    );
    expect(await decryptUsageProjection(envelope, key, authority)).toEqual(projection);
  });

  test("rejects generic RPC and provider method smuggling", () => {
    const absoluteSecretPath = ["", "Users", "name", ".ssh"].join("/");
    expect(parseRemoteCommandPayload({ kind: "rpc", method: "danger" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "send", message: "hello", method: "raw" }))
      .toBeNull();
    expect(parseRemoteCommandPayload({ kind: "set_model", preset: "unknown" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "steer", message: `read ${absoluteSecretPath}` }))
      .toBeNull();
  });

  test("keeps exactly one bounded note and name", () => {
    expect(parseSessionMetadataPayload({ name: "Work", note: "Remember this" }))
      .toEqual({ name: "Work", note: "Remember this" });
    expect(parseSessionMetadataPayload({ name: "Work", note: "x", secondNote: "y" }))
      .toBeNull();
  });

  test("remote commands round trip only under their entity authority", async () => {
    const key = randomKeyBytes();
    const authority = {
      entityPublicId: "command_12345678",
      keyVersion: 1,
      kind: "command",
      userPublicId: "user_12345678",
    } as const;
    const envelope = await encryptRemoteCommand({ kind: "set_fast", enabled: true }, key, authority);
    expect(await decryptRemoteCommand(envelope, key, authority))
      .toEqual({ kind: "set_fast", enabled: true });
    await expectPromiseToReject(decryptRemoteCommand(envelope, key, {
      ...authority,
      entityPublicId: "command_87654321",
    }));
  });
});

describe("remote decision payloads", () => {
  const interactionId = "0192a3b4-c5d6-7e8f-8a9b-0c1d2e3f4a5b";

  test("accepts once, decline, and cancel decisions and bounded answer maps", () => {
    expect(parseRemoteCommandPayload({ kind: "resolve_interaction", interactionId, revision: 3, decision: "once" }))
      .toEqual({ decision: "once", interactionId, kind: "resolve_interaction", revision: 3 });
    expect(parseRemoteCommandPayload({ kind: "resolve_interaction", interactionId, revision: 1, decision: "cancel" }))
      .toMatchObject({ decision: "cancel" });
    expect(parseRemoteCommandPayload({
      kind: "resolve_interaction",
      interactionId,
      revision: 2,
      answers: { q1: { answers: ["spaces"] } },
    })).toEqual({ answers: { q1: { answers: ["spaces"] } }, interactionId, kind: "resolve_interaction", revision: 2 });
    expect(parseRemoteCommandPayload({ kind: "send_or_steer", message: "keep going" }))
      .toEqual({ kind: "send_or_steer", message: "keep going" });
  });

  test("refuses session scope, malformed ids, extra keys, and unsafe answers", () => {
    expect(parseRemoteCommandPayload({ kind: "resolve_interaction", interactionId, revision: 1, decision: "session" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "resolve_interaction", interactionId: "int_1", revision: 1, decision: "once" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "resolve_interaction", interactionId, revision: 0, decision: "once" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "resolve_interaction", interactionId, revision: 1, decision: "once", answers: {} })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "resolve_interaction", interactionId, revision: 1, answers: {} })).toBeNull();
    expect(parseRemoteCommandPayload({
      kind: "resolve_interaction",
      interactionId,
      revision: 1,
      answers: { q1: { answers: ["/Users/someone/secret"] } },
    })).toBeNull();
  });
});
