import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import {
  advancePromotionFamilyDigest,
  canonicalPromotionJson,
  promotionBatchReceiptV2Schema,
  promotionBatchV2RequestDigest,
  promotionBatchV2Schema,
  promotionFamilyDigest,
  promotionFamilyInitialDigest,
  promotionManifestV2Schema,
  taskWorkspaceMutationIntentSchema,
  workspacePromotionStateV2Schema,
  type PromotionEntity,
} from "./index";

const LOCATORS = [
  "0123456789ABCDEFGHJKMNPQRS",
  "1123456789ABCDEFGHJKMNPQRS",
  "2123456789ABCDEFGHJKMNPQRS",
  "3123456789ABCDEFGHJKMNPQRS",
  "4123456789ABCDEFGHJKMNPQRS",
  "5123456789ABCDEFGHJKMNPQRS",
] as const;

const repositories = LOCATORS.map((locator, index) => ({
  family: "repositories",
  id: `repo_${locator}`,
  name: `Repository ${index}`,
  provider: "github",
  url: `https://github.com/example/repository-${index}`,
}) as const satisfies PromotionEntity);

test("canonical promotion JSON ignores object insertion order for arbitrary JSON", () => {
  assertProperty(
    fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (record) => {
      const reversed = Object.fromEntries(Object.entries(record).reverse());
      expect(canonicalPromotionJson(record)).toBe(
        canonicalPromotionJson(reversed),
      );
    }),
    { numRuns: 500 },
  );
});

test("family digest resumption is independent of generated batch boundaries", () => {
  assertProperty(
    fc.property(
      fc.subarray(repositories, { minLength: 2 }),
      fc.nat(),
      (selection, splitSeed) => {
        const ordered = [...selection].sort((left, right) =>
          left.id.localeCompare(right.id));
        const split = 1 + splitSeed % (ordered.length - 1);
        const direct = promotionFamilyDigest("repositories", ordered);
        const first = advancePromotionFamilyDigest("repositories", {
          count: 0,
          digest: promotionFamilyInitialDigest("repositories"),
          lastEntityIdentity: null,
        }, ordered.slice(0, split));
        const resumed = advancePromotionFamilyDigest(
          "repositories",
          first,
          ordered.slice(split),
        );
        expect(resumed.digest).toBe(direct);
        expect(resumed.count).toBe(ordered.length);
      },
    ),
    { numRuns: 100 },
  );
});

test("ordered promotion digests and batch requests are order-sensitive", () => {
  assertProperty(
    fc.property(
      fc.subarray(repositories, { minLength: 2 }),
      (selection) => {
        const ordered = [...selection].sort((left, right) =>
          left.id.localeCompare(right.id));
        const reversed = [...ordered].reverse();
        expect(() => promotionFamilyDigest("repositories", reversed)).toThrow();
        const base = {
          schemaVersion: 2 as const,
          promotionId: "promotion_0123456789ABCDEFGHJKMNPQRS",
          batchId: "batch_0123456789ABCDEFGHJKMNPQRS",
          family: "repositories" as const,
          ordinal: 0,
          previousFamilyCount: 0,
          previousFamilyDigest: promotionFamilyInitialDigest("repositories"),
          previousEntityIdentity: null,
        };
        expect(promotionBatchV2RequestDigest({ ...base, items: ordered }))
          .not.toBe(promotionBatchV2RequestDigest({ ...base, items: reversed }));
      },
    ),
    { numRuns: 100 },
  );
});

test("new promotion and mutation parsers are total for arbitrary foreign values", () => {
  assertProperty(
    fc.property(fc.jsonValue(), (value) => {
      for (const schema of [
        promotionBatchReceiptV2Schema,
        promotionBatchV2Schema,
        promotionManifestV2Schema,
        taskWorkspaceMutationIntentSchema,
        workspacePromotionStateV2Schema,
      ]) {
        expect(() => schema.safeParse(value)).not.toThrow();
      }
    }),
    { numRuns: 1_000 },
  );
});
