import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import {
  acceptHRAPromotionBatchRequestSchema,
  activateHRAPromotionRequestSchema,
  getHRARunInteractionReplyAuthorityQuerySchema,
  getHRARunInteractionReplyAuthorityResponseSchema,
  hraHumanMutationIntentSchema,
  listHRATasksQuerySchema,
  lookupHRATaskQuerySchema,
  mutateHRAWorkspaceRequestSchema,
  parseHRAHumanRoute,
  parseHRAPromotionRoute,
  pollHRAInvalidationsQuerySchema,
  respondHRARunInteractionRequestSchema,
  serializedHRAPromotionRequestBytes,
  startHRAPromotionRequestSchema,
} from "./index";

test("HRA route parsing is total for arbitrary methods and paths", () => {
  assertProperty(
    fc.property(fc.string(), fc.string(), (method, pathname) => {
      expect(() => parseHRAHumanRoute({ method, pathname })).not.toThrow();
      expect(() => parseHRAPromotionRoute({ method, pathname })).not.toThrow();
    }),
    { numRuns: 2_000 },
  );
});

test("HRA foreign wire parsing is total", () => {
  assertProperty(
    fc.property(fc.jsonValue(), (value) => {
      for (const schema of [
        acceptHRAPromotionBatchRequestSchema,
        activateHRAPromotionRequestSchema,
        getHRARunInteractionReplyAuthorityQuerySchema,
        getHRARunInteractionReplyAuthorityResponseSchema,
        hraHumanMutationIntentSchema,
        listHRATasksQuerySchema,
        lookupHRATaskQuerySchema,
        mutateHRAWorkspaceRequestSchema,
        pollHRAInvalidationsQuerySchema,
        respondHRARunInteractionRequestSchema,
        startHRAPromotionRequestSchema,
      ]) {
        expect(() => schema.safeParse(value)).not.toThrow();
      }
    }),
    { numRuns: 1_000 },
  );
});

test("portable request byte accounting equals UTF-8 JSON bytes", () => {
  assertProperty(
    fc.property(fc.jsonValue(), (value) => {
      expect(serializedHRAPromotionRequestBytes(value)).toBe(
        new TextEncoder().encode(JSON.stringify(value)).byteLength,
      );
    }),
    { numRuns: 1_000 },
  );
});
