import { describe, expect, test } from "bun:test";
import { auditSuiteIdentityConfiguration } from "./suiteIdentityAudit";
import { createSuiteReceiptProviderProof } from "../suite-account-receipts";

const secret = Buffer.alloc(32, 0x68).toString("base64url");
const exactKeyring = JSON.stringify({
  keys: [{
    environment: "production",
    keyVersion: "v1",
    product: "hra",
    secret,
  }],
  version: 1,
});
const challenge = Buffer.alloc(32, 0x63).toString("base64url");

describe("HRA receipt configuration audit", () => {
  test("reports only counts and status for missing and malformed state", async () => {
    expect(await auditSuiteIdentityConfiguration({})).toEqual({
      candidateProof: null,
      hraProductionV1Count: 0,
      keyCount: 0,
      otherKeyCount: 0,
      selectorV1: false,
      status: "missing",
    });
    expect(await auditSuiteIdentityConfiguration({
      SUITE_IDENTITY_LINK_KEYS: "not-json",
      SUITE_IDENTITY_RECEIPT_KEY_VERSION: "v1",
    })).toEqual({
      candidateProof: null,
      hraProductionV1Count: 0,
      keyCount: 0,
      otherKeyCount: 0,
      selectorV1: true,
      status: "malformed",
    });
  });

  test("requires selector v1 and one exact HRA production/v1 entry", async () => {
    expect(await auditSuiteIdentityConfiguration({
      SUITE_IDENTITY_LINK_KEYS: exactKeyring,
      SUITE_IDENTITY_RECEIPT_KEY_VERSION: "v2",
    })).toMatchObject({
      candidateProof: null,
      hraProductionV1Count: 1,
      keyCount: 1,
      otherKeyCount: 0,
      selectorV1: false,
      status: "selector-mismatch",
    });
    const extraKeyring = JSON.stringify({
      keys: [
        JSON.parse(exactKeyring).keys[0],
        {
          environment: "development",
          keyVersion: "v1",
          product: "hra",
          secret: Buffer.alloc(32, 0x64).toString("base64url"),
        },
      ],
      version: 1,
    });
    expect(await auditSuiteIdentityConfiguration({
      SUITE_IDENTITY_LINK_KEYS: extraKeyring,
      SUITE_IDENTITY_RECEIPT_KEY_VERSION: "v1",
    })).toMatchObject({
      hraProductionV1Count: 1,
      keyCount: 2,
      otherKeyCount: 1,
      status: "not-exact",
    });
  });

  test("returns only a fresh-challenge proof, counts, and status", async () => {
    const matching = await auditSuiteIdentityConfiguration({
      SUITE_IDENTITY_LINK_KEYS: exactKeyring,
      SUITE_IDENTITY_RECEIPT_KEY_VERSION: "v1",
    }, challenge);
    expect(matching).toEqual({
      candidateProof: await createSuiteReceiptProviderProof(secret, challenge),
      hraProductionV1Count: 1,
      keyCount: 1,
      otherKeyCount: 0,
      selectorV1: true,
      status: "ready",
    });
    expect(await auditSuiteIdentityConfiguration({
      SUITE_IDENTITY_LINK_KEYS: exactKeyring,
      SUITE_IDENTITY_RECEIPT_KEY_VERSION: "v1",
    }, "not-a-canonical-challenge")).toMatchObject({
      candidateProof: null,
      status: "candidate-challenge-invalid",
    });
    const serialized = JSON.stringify(matching);
    expect(serialized).not.toContain(secret);
    expect(Object.keys(matching).sort()).toEqual([
      "candidateProof",
      "hraProductionV1Count",
      "keyCount",
      "otherKeyCount",
      "selectorV1",
      "status",
    ]);
  });
});
