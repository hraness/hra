import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import {
  HRA_SUITE_LEGACY_PRODUCTS,
  productLinkProofMessage,
  suiteLinkReceiptMessage,
  type ProductLinkProof,
  type SuiteLinkReceipt,
  validateProductLinkProof,
} from "./suite-account-contracts";
import {
  HRA_SITE_URL,
  HRA_SUITE_ACCOUNTS_ORIGIN,
  HRA_SUITE_OIDC_CALLBACK_URL,
  HRA_SUITE_OIDC_CLIENT_ID,
  HRA_SUITE_OIDC_PROVIDER,
  hraSuiteAccountUrl,
} from "./suite-account-configuration";
import {
  selectSuiteReceiptConfiguration,
  verifySuiteLinkReceiptSignature,
} from "./suite-account-receipts";

const nowMs = Date.UTC(2026, 7, 16, 12);
const secret = "h".repeat(32);

describe("HRA-owned suite account contracts", () => {
  test("contains only HRA and its signed compatibility aliases", () => {
    expect(HRA_SUITE_LEGACY_PRODUCTS).toEqual(["oprte", "kitchen"]);
    const proof: ProductLinkProof = {
      challengeId: "challenge_abcdefghijklmnopqrstuv",
      environment: "production",
      expiresAtMs: nowMs + 4 * 60_000,
      issuedAtMs: nowMs,
      keyVersion: "v1",
      localSubject: "user_01J3B9W4XQ1M6N8VKY7R2T5P0A",
      product: "hra",
    };
    expect(validateProductLinkProof(proof, nowMs)).toBeNull();
    expect(productLinkProofMessage(proof)).toContain('"hra"');
  });

  test("verifies a bounded compatibility receipt with an HRA-only keyring", async () => {
    const selected = selectSuiteReceiptConfiguration({
      keys: [{
        environment: "production",
        keyVersion: "v1",
        product: "hra",
        secret,
      }],
      version: 1,
    }, "hra", "v1");
    expect(selected).not.toBeNull();
    if (selected === null) throw new Error("Expected an HRA receipt key.");
    const payload = {
      challengeId: "challenge_abcdefghijklmnopqrstuv",
      environment: "production",
      expiresAtMs: nowMs + 4 * 60_000,
      issuedAtMs: nowMs,
      keyVersion: "v1",
      localSubject: "user_01J3B9W4XQ1M6N8VKY7R2T5P0A",
      product: "oprte",
      suiteAccountId: "acct_018f1f7a7a367ccdbd5d706d4dc5c018",
    } as const;
    const receipt: SuiteLinkReceipt = {
      ...payload,
      signature: createHmac("sha256", secret)
        .update(suiteLinkReceiptMessage(payload))
        .digest("base64url"),
      version: "suite-link-receipt-v1",
    };
    expect(await verifySuiteLinkReceiptSignature(
      receipt,
      selected.keyring,
      nowMs,
    )).toBeTrue();
  });

  test("pins only HRA's public site and canonical Accounts origin", () => {
    expect(HRA_SITE_URL).toBe("https://hra.sh");
    expect(HRA_SUITE_ACCOUNTS_ORIGIN).toBe("https://account.hraness.com");
    expect(HRA_SUITE_OIDC_CLIENT_ID).toBe("hraness:hra:production:v1");
    expect(HRA_SUITE_OIDC_CALLBACK_URL).toBe(
      "https://hra.sh/api/suite-auth/callback",
    );
    expect(HRA_SUITE_OIDC_PROVIDER.issuer).toBe(HRA_SUITE_ACCOUNTS_ORIGIN);
    expect(hraSuiteAccountUrl("account")).toBe(
      "https://account.hraness.com/account",
    );
  });
});
