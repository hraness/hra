import { describe, expect, test } from "bun:test";

import * as publicHraApi from "../index";
import {
  createFactsMemoryBinding,
  digestFactsMemoryPurgeReceipt,
  digestFactsMemoryReceipt,
  factsMemoryBindingSchema,
  factsMemoryPurgeReceiptSchema,
  factsMemoryStoreReceiptSchema,
} from "./facts-memory";

const ownerId = `acct_${"a".repeat(32)}`;
const sessionId = `sess_${"b".repeat(32)}`;

describe("facts-memory public authority values", () => {
  test("keeps host custody and purge controls out of the package's agent-facing surface", () => {
    for (const key of [
      "FactsMemoryControlStore",
      "HraFactsMemoryLifecycle",
      "LocalFactsMemoryBroker",
      "factsMemoryBindingSchema",
    ]) expect(Object.hasOwn(publicHraApi, key)).toBe(false);
  });

  test("derives a stable binding only from the host-owned owner/session pair", () => {
    const first = createFactsMemoryBinding({ ownerId, sessionId });
    const second = createFactsMemoryBinding({ ownerId, sessionId });
    expect(first).toEqual(second);
    expect(first.bindingDigest).toHaveLength(64);
    expect(createFactsMemoryBinding({
      ownerId: `acct_${"c".repeat(32)}`,
      sessionId,
    }).bindingDigest).not.toBe(first.bindingDigest);
    expect(factsMemoryBindingSchema.safeParse({
      ...first,
      bindingDigest: "f".repeat(64),
    }).success).toBe(false);
  });

  test("binds exact store and purge receipts", () => {
    const binding = createFactsMemoryBinding({ ownerId, sessionId });
    const base = {
      version: 1 as const,
      bindingDigest: binding.bindingDigest,
      createdAt: 1,
      handleHash: "c".repeat(64),
      head: { digest: "d".repeat(64), sequence: 0 },
    };
    const receipt = factsMemoryStoreReceiptSchema.parse({
      ...base,
      receiptDigest: digestFactsMemoryReceipt(base),
    });
    expect(receipt.receiptDigest).not.toBe(receipt.handleHash);
    const purgeBase = {
      version: 1 as const,
      bindingDigest: binding.bindingDigest,
      handleHash: receipt.handleHash,
      purgedAt: 2,
    };
    expect(factsMemoryPurgeReceiptSchema.parse({
      ...purgeBase,
      purgeDigest: digestFactsMemoryPurgeReceipt(purgeBase),
    }).purgeDigest).toHaveLength(64);
  });
});
