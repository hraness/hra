import { describe, expect, test } from "bun:test";

import {
  authAttemptPolicies,
  newIdentityAdmissionWindowLimit,
  newIdentityAdmissionWindowMs,
  unverifiedLifetimeSendLimit,
  wouldExceedAuthAttemptQuota,
  type AuthAttemptEvent,
} from "./authPolicy";

const minuteMs = 60 * 1_000;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;

describe("auth attempt quotas", () => {
  test("pins the open sign-up send limits and leaves verify limits unchanged", () => {
    expect(authAttemptPolicies.send.perEmail).toEqual([
      { limit: 3, windowMs: 15 * minuteMs },
      { limit: 5, windowMs: dayMs },
    ]);
    expect(authAttemptPolicies.send.global).toEqual([
      { limit: 200, windowMs: hourMs },
      { limit: 1_000, windowMs: dayMs },
    ]);
    expect(authAttemptPolicies.verify).toEqual({
      global: [{ limit: 100, windowMs: hourMs }],
      perEmail: [{ limit: 10, windowMs: 15 * minuteMs }],
      retentionMs: hourMs,
    });
    expect(unverifiedLifetimeSendLimit).toBe(10);
    expect(newIdentityAdmissionWindowLimit).toBe(200);
    expect(newIdentityAdmissionWindowMs).toBe(dayMs);
  });

  test("every attempt window is fed by rows that survive at least that long", () => {
    for (const kind of ["send", "verify"] as const) {
      const policy = authAttemptPolicies[kind];
      for (const window of [...policy.perEmail, ...policy.global]) {
        expect(window.windowMs).toBeLessThanOrEqual(policy.retentionMs);
        expect(window.limit).toBeGreaterThan(0);
      }
    }
  });

  test("a wider window never admits more than a narrower one", () => {
    for (const kind of ["send", "verify"] as const) {
      const policy = authAttemptPolicies[kind];
      for (const scope of [policy.perEmail, policy.global]) {
        const windows: readonly { limit: number; windowMs: number }[] = scope;
        windows.forEach((window, index) => {
          const previous = windows[index - 1];
          if (previous === undefined) return;
          expect(window.windowMs).toBeGreaterThan(previous.windowMs);
          expect(window.limit).toBeGreaterThanOrEqual(previous.limit);
        });
      }
    }
  });

  test("send and verify reservations are independent at exact boundaries", () => {
    const now = 2_000_000;
    const digest = "a".repeat(64);
    const sends: AuthAttemptEvent[] = Array.from(
      { length: authAttemptPolicies.send.perEmail[0].limit },
      (_, index) => ({ createdAt: now - index, emailDigest: digest, kind: "send" }),
    );
    expect(wouldExceedAuthAttemptQuota(sends, { emailDigest: digest, kind: "send", now }))
      .toBe(true);
    expect(wouldExceedAuthAttemptQuota(sends, { emailDigest: digest, kind: "verify", now }))
      .toBe(false);
  });

  test("events outside a window do not consume its quota", () => {
    const now = 2_000_000;
    const digest = "b".repeat(64);
    const window = authAttemptPolicies.send.perEmail[0];
    const events: AuthAttemptEvent[] = Array.from({ length: window.limit }, () => ({
      createdAt: now - window.windowMs - 1,
      emailDigest: digest,
      kind: "send",
    }));
    expect(wouldExceedAuthAttemptQuota(events, { emailDigest: digest, kind: "send", now }))
      .toBe(false);
  });
});
