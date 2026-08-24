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

describe("UsageHistoryCursorCodec", () => {
  test("round trips one canonical account-and-range-bound position", () => {
    const codec = new UsageHistoryCursorCodec(KEY);
    const encoded = codec.encode(payload());
    expect(codec.decode(encoded, {
      accountId,
      fromObservedAt: payload().fromObservedAt,
      throughObservedAt: payload().throughObservedAt,
      now: payload().issuedAt + USAGE_HISTORY_CURSOR_TTL_MS,
    })).toEqual({
      ...payload(),
      expiresAt: payload().issuedAt + USAGE_HISTORY_CURSOR_TTL_MS,
    });
    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(USAGE_HISTORY_CURSOR_MAX_BYTES);
  });

  test("rejects tampering, another account, conflicting ranges, and expiry with typed reasons", () => {
    const codec = new UsageHistoryCursorCodec(KEY);
    const encoded = codec.encode(payload());
    const decode = (overrides: Partial<Parameters<typeof codec.decode>[1]> = {}) =>
      codec.decode(encoded, {
        accountId,
        now: payload().issuedAt,
        ...overrides,
      });
    expect(() => decode({ accountId: `acct_${"2".repeat(32)}` }))
      .toThrow(new UsageHistoryCursorError(
        "Usage-history cursor belongs to another account.",
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
      now: payload().issuedAt,
    })).toThrow(UsageHistoryCursorError);
  });

  test("rejects signed noncanonical or invalid range payloads and oversized cursors", () => {
    const codec = new UsageHistoryCursorCodec(KEY);
    const canonical = {
      ...payload(),
      expiresAt: payload().issuedAt + USAGE_HISTORY_CURSOR_TTL_MS,
    };
    const reordered = {
      type: canonical.type,
      version: canonical.version,
      accountId: canonical.accountId,
      fromObservedAt: canonical.fromObservedAt,
      throughObservedAt: canonical.throughObservedAt,
      afterSourceRevision: canonical.afterSourceRevision,
      issuedAt: canonical.issuedAt,
      expiresAt: canonical.expiresAt,
    };
    expect(() => codec.decode(signed(reordered), {
      accountId,
      now: canonical.issuedAt,
    })).toThrow(UsageHistoryCursorError);
    expect(() => codec.decode(signed({
      ...canonical,
      fromObservedAt: canonical.throughObservedAt + 1,
    }), {
      accountId,
      now: canonical.issuedAt,
    })).toThrow(UsageHistoryCursorError);
    expect(() => codec.decode(`hrau1.${"a".repeat(USAGE_HISTORY_CURSOR_MAX_BYTES)}.x`, {
      accountId,
      now: canonical.issuedAt,
    })).toThrow(UsageHistoryCursorError);
  });
});
