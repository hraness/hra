import { describe, expect, test } from "bun:test";
import { fc } from "@hra-internal/test";

import {
  runInteractionRequestSchema,
  runInteractionResponseSchema,
  syncRunInteractionsRequestSchema,
  syncRunInteractionsResponseSchema,
  validateRunInteractionResponse,
  type RunInteractionRequest,
} from "./interactions";

const fileApprovalRequest: RunInteractionRequest = {
  id: "interaction_property001",
  kind: "file_change_approval",
  scope: "once",
  createdAt: 1,
  expiresAt: 2,
  reply: {
    version: 1,
    algorithm: "P256-HKDF-SHA256-A256GCM",
    keyId: `hitlkey_${"a".repeat(32)}`,
    publicKey: "B".repeat(87),
    runnerId: "runner_property001",
    bootId: "boot_property0001",
    bootGeneration: 1,
    claimId: "claim_property001",
    claimFence: 1,
    requestDigest: `sha256_${"b".repeat(64)}`,
  },
};

describe("HRA run interaction parser laws", () => {
  test("all public interaction parsers and the request-aware validator are total", () => {
    fc.assert(fc.property(fc.jsonValue(), (value) => {
      expect(() => runInteractionRequestSchema.safeParse(value)).not.toThrow();
      expect(() => runInteractionResponseSchema.safeParse(value)).not.toThrow();
      expect(() => syncRunInteractionsRequestSchema.safeParse(value)).not.toThrow();
      expect(() => syncRunInteractionsResponseSchema.safeParse(value)).not.toThrow();
      expect(() => validateRunInteractionResponse(fileApprovalRequest, value)).not.toThrow();
    }), { numRuns: 2_000 });
  });

  test("strict requests reject every sensitive provider or local field", () => {
    fc.assert(fc.property(
      fc.constantFrom("providerRequestId", "threadId", "turnId", "itemId", "path", "cwd", "reason", "secret"),
      fc.string(),
      (key, value) => {
        expect(runInteractionRequestSchema.safeParse({
          ...fileApprovalRequest,
          [key]: value,
        }).success).toBeFalse();
      },
    ));
  });
});
