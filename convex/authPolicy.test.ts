import { describe, expect, test } from "bun:test";

import {
  authAttemptPolicies,
  wouldExceedAuthAttemptQuota,
  type AuthAttemptEvent,
} from "./authPolicy";

describe("auth attempt quotas", () => {
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
