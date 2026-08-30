import { createHmac } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  USAGE_HISTORY_CURSOR_MAX_BYTES,
  USAGE_HISTORY_CURSOR_TTL_MS,
  UsageHistoryCursorCodec,
  UsageHistoryCursorError,
} from "./usage-history-cursor";

const KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const accountId = `acct_${"1".repeat(32)}`;
const accountFingerprint = "a".repeat(64);

const payload = (issuedAt = 1_700_000_000_000) => ({
  version: 1 as const,
  type: "account_usage_history" as const,
  accountId,
  fromObservedAt: issuedAt - 60_000,
  throughObservedAt: issuedAt,
  afterSourceRevision: 7,
  issuedAt,
});

const signed = (value: unknown): string => {
  const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const signature = createHmac("sha256", KEY)
    .update("hrau1")
    .update("\0")
    .update(encoded)
    .digest("base64url");
  return `hrau1.${encoded}.${signature}`;
};

const cursorPayload = (cursor: string): Record<string, unknown> => {
  const encoded = cursor.split(".")[1];
  if (encoded === undefined) throw new Error("Expected an encoded cursor payload.");
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
};

describe("UsageHistoryCursorCodec", () => {
  test("round trips one canonical account-and-range-bound position", () => {
    const codec = new UsageHistoryCursorCodec(KEY);
    const encoded = codec.encode({ ...payload(), accountFingerprint });
    const decoded = codec.decode(encoded, {
      accountId,
      accountFingerprint,
      fromObservedAt: payload().fromObservedAt,
      throughObservedAt: payload().throughObservedAt,
      now: payload().issuedAt + USAGE_HISTORY_CURSOR_TTL_MS,
    });
    expect(decoded).toEqual({
      ...payload(),
      accountBinding: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      expiresAt: payload().issuedAt + USAGE_HISTORY_CURSOR_TTL_MS,
    });
    const cleartextPayload = Buffer.from(encoded.split(".")[1] ?? "", "base64url")
      .toString("utf8");
    expect(encoded).not.toContain(accountFingerprint);
    expect(cleartextPayload).not.toContain(accountFingerprint);
    expect(cursorPayload(encoded)).not.toHaveProperty("accountFingerprint");
    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(USAGE_HISTORY_CURSOR_MAX_BYTES);
  });

  test("rejects tampering, another account, conflicting ranges, and expiry with typed reasons", () => {
    const codec = new UsageHistoryCursorCodec(KEY);
    const encoded = codec.encode({ ...payload(), accountFingerprint });
    const decode = (overrides: Partial<Parameters<typeof codec.decode>[1]> = {}) =>
      codec.decode(encoded, {
        accountId,
        accountFingerprint,
        now: payload().issuedAt,
        ...overrides,
      });
    expect(() => decode({ accountId: `acct_${"2".repeat(32)}` }))
      .toThrow(new UsageHistoryCursorError(
        "Usage-history cursor belongs to another account.",
        "account_mismatch",
      ));
    expect(() => decode({ accountFingerprint: "b".repeat(64) }))
      .toThrow(new UsageHistoryCursorError(
        "Usage-history cursor belongs to another account identity.",
        "account_mismatch",
      ));
    expect(() => decode({ fromObservedAt: payload().fromObservedAt + 1 }))
      .toThrow(new UsageHistoryCursorError(
        "Usage-history cursor range does not match the requested range.",
        "filter_mismatch",
      ));
    expect(() => decode({ now: payload().issuedAt + USAGE_HISTORY_CURSOR_TTL_MS + 1 }))
      .toThrow(new UsageHistoryCursorError(
        "Usage-history cursor expired. Start a fresh history query.",
        "expired",
      ));
    const replacement = encoded.at(-1) === "A" ? "B" : "A";
    expect(() => codec.decode(`${encoded.slice(0, -1)}${replacement}`, {
      accountId,
      accountFingerprint,
      now: payload().issuedAt,
    })).toThrow(UsageHistoryCursorError);
  });

  test("rejects signed noncanonical or invalid range payloads and oversized cursors", () => {
    const codec = new UsageHistoryCursorCodec(KEY);
    const canonical = cursorPayload(codec.encode({ ...payload(), accountFingerprint }));
    const reordered = {
      type: canonical.type,
      version: canonical.version,
      accountId: canonical.accountId,
      accountBinding: canonical.accountBinding,
      fromObservedAt: canonical.fromObservedAt,
      throughObservedAt: canonical.throughObservedAt,
      afterSourceRevision: canonical.afterSourceRevision,
      issuedAt: canonical.issuedAt,
      expiresAt: canonical.expiresAt,
    };
    expect(() => codec.decode(signed(reordered), {
      accountId,
      accountFingerprint,
      now: payload().issuedAt,
    })).toThrow(UsageHistoryCursorError);
    expect(() => codec.decode(signed({
      ...canonical,
      fromObservedAt: payload().throughObservedAt + 1,
    }), {
      accountId,
      accountFingerprint,
      now: payload().issuedAt,
    })).toThrow(UsageHistoryCursorError);
    expect(() => codec.decode(signed({
      ...canonical,
      accountFingerprint,
    }), {
      accountId,
      accountFingerprint,
      now: payload().issuedAt,
    })).toThrow(UsageHistoryCursorError);
    expect(() => codec.decode(`hrau1.${"a".repeat(USAGE_HISTORY_CURSOR_MAX_BYTES)}.x`, {
      accountId,
      accountFingerprint,
      now: payload().issuedAt,
    })).toThrow(UsageHistoryCursorError);
  });
});
