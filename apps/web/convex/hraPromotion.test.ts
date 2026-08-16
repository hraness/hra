import { describe, expect, test } from "bun:test";
import {
  initialPromotionFamilyProgressMap,
  promotionEntityCountsSchema,
  promotionEntityFamilyValues,
  promotionFamilyDigestMapSchema,
  promotionFamilyInitialDigest,
  promotionManifestV2RootDigest,
  promotionManifestV2Schema,
  promotionUploadProgressSchema,
} from "@hraness/agent-tasks-domain";

import {
  completeEmptyPromotionFamilies,
  publicPromotionState,
} from "./hraPromotion";
import { promotionProjectionPageSize } from "./hraPromotionProjection";

const counts = promotionEntityCountsSchema.parse(Object.fromEntries(
  promotionEntityFamilyValues.map((family) => [
    family,
    family === "workspace_metadata" ||
      family === "executors" ||
      family === "tasks" ||
      family === "task_bodies"
      ? 1
      : 0,
  ]),
));
const familyDigests = promotionFamilyDigestMapSchema.parse(Object.fromEntries(
  promotionEntityFamilyValues.map((family) => [
    family,
    promotionFamilyInitialDigest(family),
  ]),
));
const manifestInput = {
  schemaVersion: 2 as const,
  promotionId: "promotion_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  sourceWorkspaceId: "wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  sourceWorkspaceRevision: 8,
  sourceEventSequence: 8,
  createdAt: 1_700_000_000_000,
  counts,
  familyDigests,
  terminalLocalWork: {
    queuedIntents: 0 as const,
    activeClaims: 0 as const,
    nonterminalRuns: 0 as const,
    openInteractions: 0 as const,
  },
};
const manifest = promotionManifestV2Schema.parse({
  ...manifestInput,
  rootDigest: promotionManifestV2RootDigest(manifestInput),
});

function completedProgress() {
  const families = initialPromotionFamilyProgressMap();
  for (const family of promotionEntityFamilyValues) {
    const acceptedEntityCount = manifest.counts[family];
    families[family] = {
      family,
      acceptedBatchCount: acceptedEntityCount === 0 ? 0 : 1,
      acceptedEntityCount,
      cumulativeDigest: manifest.familyDigests[family],
      lastEntityIdentity: acceptedEntityCount === 0
        ? null
        : `${family}:fixture`,
      complete: true,
    };
  }
  return {
    activeFamilyIndex: promotionEntityFamilyValues.length,
    receiptCount: promotionEntityFamilyValues.filter(
      (family) => manifest.counts[family] > 0,
    ).length,
    acceptedEntityCount: promotionEntityFamilyValues.reduce(
      (total, family) => total + manifest.counts[family],
      0,
    ),
    families,
  };
}

describe("HRA promotion scheduler laws", () => {
  test("advances canonical empty families without inventing batch receipts", () => {
    const families = initialPromotionFamilyProgressMap();
    families.workspace_metadata = {
      ...families.workspace_metadata,
      complete: true,
      acceptedBatchCount: 1,
      acceptedEntityCount: 1,
      lastEntityIdentity: manifest.sourceWorkspaceId,
    };
    families.executors = {
      ...families.executors,
      complete: true,
      acceptedBatchCount: 1,
      acceptedEntityCount: 1,
      lastEntityIdentity: `${manifest.sourceWorkspaceId}:local_codex`,
    };
    const progress = promotionUploadProgressSchema.parse({
      activeFamilyIndex: 2,
      receiptCount: 2,
      acceptedEntityCount: 2,
      families,
    });

    const completed = completeEmptyPromotionFamilies(manifest, progress);

    expect(completed.activeFamilyIndex).toBe(3);
    expect(completed.families.repositories.complete).toBeTrue();
    expect(completed.families.repositories.acceptedBatchCount).toBe(0);
    expect(completed.receiptCount).toBe(2);
    expect(progress.activeFamilyIndex).toBe(2);
  });

  test("keeps every scheduled projection transaction bounded", () => {
    expect(promotionProjectionPageSize()).toBe(32);
    expect(promotionProjectionPageSize()).toBeLessThanOrEqual(100);
  });

  test("publishes deterministic rejection without inventing ambiguity", () => {
    const progress = completedProgress();
    const rejected = publicPromotionState({
      state: "rejected",
      publicId: manifest.promotionId,
      sourceWorkspacePublicId: manifest.sourceWorkspaceId,
      stagingWorkspacePublicId: "wsp_1123456789ABCDEFGHJKMNPQRS",
      manifestRoot: manifest.rootDigest,
      manifestJson: JSON.stringify(manifest),
      progressJson: JSON.stringify(progress),
      rejectionCode: "projection_failed",
    });

    expect(rejected).toMatchObject({
      state: "rejected",
      rejectionCode: "projection_failed",
      localWritable: false,
    });
    expect(() =>
      publicPromotionState({
        state: "rejected",
        publicId: manifest.promotionId,
        sourceWorkspacePublicId: manifest.sourceWorkspaceId,
        stagingWorkspacePublicId: "wsp_1123456789ABCDEFGHJKMNPQRS",
        manifestRoot: manifest.rootDigest,
        manifestJson: JSON.stringify(manifest),
        progressJson: JSON.stringify(progress),
      })
    ).toThrow("lost its rejection proof");
  });
});
