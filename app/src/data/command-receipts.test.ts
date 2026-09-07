import { describe, expect, test } from "bun:test";

import {
  acknowledgeObservedCommandReceipt,
  parseCommandReceiptProofPage,
  parseDeviceCommandEnqueueReceipt,
  parseSessionCommandEnqueueReceipt,
} from "./command-receipts";
import type { WireDeviceEnqueueArgs, WireEnqueueArgs } from "./functions";

const publicId = "018bcfe5-6800-7000-8000-000000000001";
const idempotencyKey = "018bcfe5-6800-7000-8000-000000000002";
const requestDigest = "a".repeat(64);
const envelope = {
  algorithm: "A256GCM" as const,
  ciphertext: "A".repeat(32),
  keyVersion: 1,
  nonce: "B".repeat(16),
};
const deviceRequest: WireDeviceEnqueueArgs = {
  deadline: 1_760_000_060_000,
  expectedRequestingDevicePublicId: "device_browser01",
  expectedTargetDevicePublicId: "device_daemon01",
  idempotencyKey,
  kind: "usage_refresh",
  payload: envelope,
  publicId,
  requestCommitmentVersion: 2,
  requestDigest,
};
const sessionRequest: WireEnqueueArgs = {
  ...deviceRequest,
  kind: "stop",
  sessionPublicId: "session_00000001",
};

function deviceReceipt(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    publicId,
    requestCommitmentVersion: 2,
    replay: false,
    requestingDevicePublicId: "device_browser01",
    state: "pending",
    targetDevicePublicId: "device_daemon01",
    ...overrides,
  };
}

describe("browser command receipt parsing", () => {
  test("derives session acknowledgement proof from the request after an exact stable response", () => {
    const receipt = { ...deviceReceipt(), sessionPublicId: "session_00000001" };
    expect(parseSessionCommandEnqueueReceipt(receipt, sessionRequest)).toEqual({
      idempotencyKey,
      publicId,
      requestDigest,
    });
    expect(parseSessionCommandEnqueueReceipt({
      ...receipt,
      idempotencyKey,
    }, sessionRequest)).toBeNull();
    expect(parseSessionCommandEnqueueReceipt({
      ...receipt,
      extra: true,
    }, sessionRequest)).toBeNull();
  });

  test("derives device acknowledgement proof from the request after an exact stable response", () => {
    expect(parseDeviceCommandEnqueueReceipt(deviceReceipt(), deviceRequest)).toEqual({
      idempotencyKey,
      publicId,
      requestDigest,
    });
    expect(parseDeviceCommandEnqueueReceipt(deviceReceipt({
      requestingDevicePublicId: "device_other000",
    }), deviceRequest)).toBeNull();
    expect(parseDeviceCommandEnqueueReceipt(deviceReceipt({
      requestDigest,
    }), deviceRequest)).toBeNull();
  });

  test("parses a bounded exact recovery page and rejects duplicate or expanded proofs", () => {
    const proof = { idempotencyKey, publicId, requestDigest };
    expect(parseCommandReceiptProofPage([proof])).toEqual([proof]);
    expect(parseCommandReceiptProofPage([proof, proof])).toBeNull();
    expect(parseCommandReceiptProofPage([{ ...proof, state: "pending" }])).toBeNull();
    expect(parseCommandReceiptProofPage(new Array(101).fill(proof))).toBeNull();
  });

  test("acknowledges only the exact observed proof and validates the response", async () => {
    const proof = { idempotencyKey, publicId, requestDigest };
    const calls: unknown[] = [];
    await acknowledgeObservedCommandReceipt(proof, async (args) => {
      calls.push(args);
      return { acknowledgedAt: 1_760_000_000_000, publicId, replay: false };
    });
    expect(calls).toEqual([{
      commandPublicId: publicId,
      idempotencyKey,
      requestDigest,
    }]);
    await expect(acknowledgeObservedCommandReceipt(proof, async () => ({
      acknowledgedAt: 1_760_000_000_000,
      publicId: "018bcfe5-6800-7000-8000-000000000099",
      replay: false,
    }))).rejects.toThrow("command receipt acknowledgement");
  });
});
