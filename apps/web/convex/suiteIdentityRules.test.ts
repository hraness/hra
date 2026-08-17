import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import {
  PREVIOUS_SUITE_CATALOG_REVISION,
  SUITE_CATALOG_REVISION,
  suiteLinkReceiptMessage,
  type SuiteLinkReceipt,
} from "../suite-account-contracts";
import {
  selectSuiteReceiptConfiguration,
  verifySuiteLinkReceiptSignature,
} from "../suite-account-receipts";

import {
  suiteAliasesAllowLink,
  suiteEntitlementProjectionIsFresh,
  suiteEntitlementProjectionTransition,
  type SuiteEntitlementProjection,
  type SuiteEntitlementProjectionUpdate,
} from "./suiteIdentityRules";

const accountId = "acct_018f1f7a7a367ccdbd5d706d4dc5c018";
const currentSecret = Buffer.alloc(32, 0x6e).toString("base64url");
const projection = {
  catalogRevision: SUITE_CATALOG_REVISION,
  expiresAt: 2_000,
  features: ["suite.paid"],
  observedAt: 1_000,
  projectionRevision: 3,
  receiptDigest: "a".repeat(64),
  receiptIssuedAt: 1_200,
  suiteAccountId: accountId,
} as const satisfies SuiteEntitlementProjectionUpdate;

describe("HRA suite identity laws", () => {
  test("requires one exact production/v1 HRA key and verifies a compatibility receipt", async () => {
    const selected = selectSuiteReceiptConfiguration({
      keys: [{
        environment: "production",
        keyVersion: "v1",
        product: "hra",
        secret: currentSecret,
      }],
      version: 1,
    }, "hra", "v1");
    expect(selected?.key.keyVersion).toBe("v1");
    expect(selected?.keyring.keys).toHaveLength(1);
    if (selected === null) throw new Error("Expected an HRA receipt configuration.");
    const retiredPayload = {
      challengeId: "retired_challenge_abcdefghijklmn",
      environment: "production",
      expiresAtMs: 1_240_000,
      issuedAtMs: 1_000_000,
      keyVersion: "v1",
      localSubject: "user_01J3B9W4XQ1M6N8VKY7R2T5P0A",
      product: "oprte",
      suiteAccountId: accountId,
    } as const;
    const retiredReceipt: SuiteLinkReceipt = {
      ...retiredPayload,
      signature: createHmac("sha256", currentSecret)
        .update(suiteLinkReceiptMessage(retiredPayload))
        .digest("base64url"),
      version: "suite-link-receipt-v1",
    };
    expect(await verifySuiteLinkReceiptSignature(
      retiredReceipt,
      selected.keyring,
      1_000_000,
    )).toBe(true);
    expect(selectSuiteReceiptConfiguration(
      selected.keyring,
      "hra",
      "missing",
    )).toBeNull();
    expect(selectSuiteReceiptConfiguration({
      keys: [
        selected.key,
        { ...selected.key, keyVersion: "v2" },
      ],
      version: 1,
    }, "hra", "v1")).toBeNull();
    expect(selectSuiteReceiptConfiguration({
      keys: [{ ...selected.key, environment: "development" }],
      version: 1,
    }, "hra", "v1")).toBeNull();
  });

  test("permits one exact alias and rejects either-direction conflicts", () => {
    const target = {
      localSubject: "user_01J3B9W4XQ1M6N8VKY7R2T5P0A",
      suiteAccountId: accountId,
      userId: "local-user-1",
    };
    const alias = { ...target, id: "alias-1", state: "active" as const };

    expect(suiteAliasesAllowLink([null, null, null], target)).toBe(true);
    expect(suiteAliasesAllowLink([alias, alias, alias], target)).toBe(true);
    expect(suiteAliasesAllowLink([alias, null, alias], target)).toBe(false);
    expect(suiteAliasesAllowLink(
      [alias, { ...alias, id: "alias-2" }],
      target,
    )).toBe(false);
    expect(suiteAliasesAllowLink(
      [{ ...alias, suiteAccountId: "acct_11111111111111111111111111111111" }],
      target,
    )).toBe(false);
    expect(suiteAliasesAllowLink(
      [{ ...alias, state: "revoked" }],
      target,
    )).toBe(false);
  });

  test("accepts only an exact replay at one revision", () => {
    expect(suiteEntitlementProjectionTransition(null, projection)).toBe("insert");
    expect(
      suiteEntitlementProjectionTransition(projection, projection),
    ).toBe("idempotent");
    expect(suiteEntitlementProjectionTransition(projection, {
      ...projection,
      receiptDigest: "b".repeat(64),
    })).toBe("conflict");
    expect(suiteEntitlementProjectionTransition(projection, {
      ...projection,
      features: [],
    })).toBe("conflict");
    expect(suiteEntitlementProjectionTransition(projection, {
      ...projection,
      expiresAt: 2_500,
      receiptDigest: "b".repeat(64),
      receiptIssuedAt: 1_300,
    })).toBe("replace");
    expect(suiteEntitlementProjectionTransition(projection, {
      ...projection,
      expiresAt: 2_500,
      features: [],
      observedAt: 1_400,
      receiptDigest: "b".repeat(64),
      receiptIssuedAt: 1_400,
    })).toBe("replace");
  });

  test("moves only forward in provider observation and projection revision", () => {
    expect(suiteEntitlementProjectionTransition(projection, {
      ...projection,
      features: [],
      observedAt: 1_500,
      projectionRevision: 4,
      receiptDigest: "b".repeat(64),
      receiptIssuedAt: 1_500,
    })).toBe("replace");
    expect(suiteEntitlementProjectionTransition(projection, {
      ...projection,
      observedAt: 999,
      projectionRevision: 4,
      receiptDigest: "b".repeat(64),
      receiptIssuedAt: 1_500,
    })).toBe("conflict");
    expect(suiteEntitlementProjectionTransition(projection, {
      ...projection,
      projectionRevision: 2,
      receiptDigest: "b".repeat(64),
      receiptIssuedAt: 1_500,
    })).toBe("conflict");
    expect(suiteEntitlementProjectionTransition(projection, {
      ...projection,
      observedAt: 1_500,
      projectionRevision: 4,
      receiptDigest: "b".repeat(64),
      receiptIssuedAt: 1_100,
    })).toBe("conflict");
  });

  test("backfills receipt issuance for the first verified legacy update", () => {
    const legacy: SuiteEntitlementProjection = {
      catalogRevision: projection.catalogRevision,
      expiresAt: projection.expiresAt,
      features: projection.features,
      observedAt: projection.observedAt,
      projectionRevision: projection.projectionRevision,
      receiptDigest: projection.receiptDigest,
      suiteAccountId: projection.suiteAccountId,
    };
    expect(suiteEntitlementProjectionTransition(legacy, {
      ...projection,
      expiresAt: 2_500,
      receiptIssuedAt: 1_300,
    })).toBe("replace");
  });

  test("treats expiry, future observation, age, and account mismatch as stale", () => {
    expect(suiteEntitlementProjectionIsFresh(projection, accountId, 1_500)).toBe(true);
    expect(suiteEntitlementProjectionIsFresh(projection, accountId, 2_000)).toBe(false);
    expect(suiteEntitlementProjectionIsFresh(
      projection,
      "acct_11111111111111111111111111111111",
      1_500,
    )).toBe(false);
    expect(suiteEntitlementProjectionIsFresh(
      { ...projection, observedAt: 1_600 },
      accountId,
      1_500,
    )).toBe(false);
    expect(suiteEntitlementProjectionIsFresh(
      {
        ...projection,
        catalogRevision: PREVIOUS_SUITE_CATALOG_REVISION,
      },
      accountId,
      1_500,
    )).toBe(false);
  });
});
