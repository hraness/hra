import { describe, expect, test } from "bun:test";
import {
  PREVIOUS_SUITE_CATALOG_REVISION,
  SUITE_CATALOG_REVISION,
} from "../suite-account-contracts";

import {
  parseHRASuiteEntitlementReceipt,
  parseHRASuiteLinkReceipt,
  parseHRASuiteOidcSession,
} from "./suite-account-protocol";

const nowMs = Date.UTC(2026, 6, 24, 16);
const suiteAccountId = "acct_018f1f7a7a367ccdbd5d706d4dc5c018";
const entitlementReceipt = {
  entitlements: {
    catalogRevision: SUITE_CATALOG_REVISION,
    expiresAtMs: nowMs + 24 * 60 * 60_000,
    features: ["suite.paid", "suite.believer"],
    observedAtMs: nowMs,
    projectionRevision: 17,
    version: "suite-entitlements-v1",
  },
  environment: "production",
  expiresAtMs: nowMs + 4 * 60_000,
  issuedAtMs: nowMs,
  keyVersion: "v1",
  product: "hra",
  signature: "s".repeat(43),
  suiteAccountId,
  version: "suite-entitlement-receipt-v1",
};

describe("HRA suite account browser boundary", () => {
  test("parses canonical HRA and historical OPRTE/Kitchen receipts without changing signed bytes", () => {
    const receipt = {
      challengeId: "challenge_abcdefghijklmnopqrstuv",
      environment: "production",
      expiresAtMs: nowMs + 4 * 60_000,
      issuedAtMs: nowMs,
      keyVersion: "v1",
      localSubject: "user_01J3B9W4XQ1M6N8VKY7R2T5P0A",
      product: "hra",
      signature: "l".repeat(43),
      suiteAccountId,
      version: "suite-link-receipt-v1",
    };

    expect(parseHRASuiteLinkReceipt(receipt, nowMs)).not.toBeNull();
    for (const product of ["oprte", "kitchen"] as const) {
      expect(parseHRASuiteLinkReceipt(
        { ...receipt, product },
        nowMs,
      )?.product).toBe(product);
    }
    expect(parseHRASuiteLinkReceipt(
      { ...receipt, product: "gnrte" },
      nowMs,
    )).toBeNull();
    expect(parseHRASuiteLinkReceipt(receipt, receipt.expiresAtMs)).toBeNull();
  });

  test("rejects noncanonical entitlement features and mismatched sessions", () => {
    expect(
      parseHRASuiteEntitlementReceipt(entitlementReceipt, nowMs),
    ).not.toBeNull();
    for (const product of ["oprte", "kitchen"] as const) {
      expect(parseHRASuiteEntitlementReceipt({
        ...entitlementReceipt,
        product,
      }, nowMs)?.product).toBe(product);
    }
    expect(parseHRASuiteEntitlementReceipt({
      ...entitlementReceipt,
      entitlements: {
        ...entitlementReceipt.entitlements,
        features: ["suite.believer", "suite.paid"],
      },
    }, nowMs)).toBeNull();
    expect(parseHRASuiteEntitlementReceipt({
      ...entitlementReceipt,
      entitlements: {
        ...entitlementReceipt.entitlements,
        catalogRevision: PREVIOUS_SUITE_CATALOG_REVISION,
      },
    }, nowMs)).toBeNull();

    expect(parseHRASuiteOidcSession({
      kind: "signed_in",
      session: {
        entitlementReceipt,
        entitlements: {
          features: ["suite.paid", "suite.believer"],
          kind: "fresh",
        },
        suiteAccountId,
      },
    }, nowMs)).not.toBeNull();
    expect(parseHRASuiteOidcSession({
      kind: "signed_in",
      session: {
        entitlementReceipt,
        entitlements: {
          features: ["suite.paid", "suite.believer"],
          kind: "fresh",
        },
        suiteAccountId: "acct_11111111111111111111111111111111",
      },
    }, nowMs)).toBeNull();
  });

  test("recognizes only the bounded signed-out and refresh states", () => {
    expect(parseHRASuiteOidcSession({ kind: "signed_out" }, nowMs)).toEqual({
      kind: "signed_out",
    });
    expect(
      parseHRASuiteOidcSession({ kind: "refresh_required" }, nowMs),
    ).toEqual({ kind: "refresh_required" });
    expect(parseHRASuiteOidcSession({ kind: "signed_in" }, nowMs)).toBeNull();
  });
});
