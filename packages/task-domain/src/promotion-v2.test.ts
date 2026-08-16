import { describe, expect, test } from "bun:test";

import {
  advancePromotionFamilyDigest,
  canonicalPromotionJson,
  initialPromotionFamilyProgressMap,
  materializeLocalOwnerTaskCommand,
  promotionAbortReceiptV2Digest,
  promotionAbortReceiptV2Schema,
  promotionActivationReceiptV2Digest,
  promotionActivationReceiptV2Schema,
  promotionBatchAcceptanceV2Schema,
  promotionBatchOrderDisposition,
  promotionBatchReceiptPageSchema,
  promotionBatchReplayDisposition,
  promotionBatchV2RequestDigest,
  promotionBatchV2Schema,
  promotionEntityCountsSchema,
  promotionEntityFamilyValues,
  promotionFamilyDigest,
  promotionFamilyInitialDigest,
  promotionManifestV2RootDigest,
  promotionManifestV2Schema,
  promotionSha256Digest,
  promotionSnapshotFamilyDigests,
  promotionUploadProgressSchema,
  taskWorkspaceMutationIntentSchema,
  taskWorkspaceMutationResultSchema,
  taskWorkspaceViewerSchema,
  workspacePromotionStateV2Schema,
  type PromotionBatchReceiptV2,
  type PromotionBatchV2,
  type PromotionEntity,
  type PromotionManifestV2,
} from "./index";

const LOCATOR = "0123456789ABCDEFGHJKMNPQRS";
const OTHER_LOCATOR = "1123456789ABCDEFGHJKMNPQRS";
const WORKSPACE_ID = `wsp_${LOCATOR}`;
const DESTINATION_WORKSPACE_ID = `wsp_${OTHER_LOCATOR}`;
const PROMOTION_ID = `promotion_${LOCATOR}`;
const BATCH_ID = `batch_${LOCATOR}`;
const OPERATION_ID = `op_${LOCATOR}`;
const INSTALLATION_ID = "install_contract_test";

const workspaceEntity = {
  family: "workspace_metadata",
  workspaceId: WORKSPACE_ID,
  name: "HRA",
  slug: "hra",
  keyPrefix: "KIT",
} as const satisfies PromotionEntity;

const executorEntity = {
  family: "executors",
  workspaceId: WORKSPACE_ID,
  executor: "local_codex",
  enabled: true,
} as const satisfies PromotionEntity;

function countsFor(entities: readonly PromotionEntity[]) {
  return promotionEntityCountsSchema.parse(
    Object.fromEntries(promotionEntityFamilyValues.map((family) => [
      family,
      entities.filter((entity) => entity.family === family).length,
    ])),
  );
}

function manifestFor(entities: readonly PromotionEntity[]): PromotionManifestV2 {
  const compact = {
    schemaVersion: 2 as const,
    promotionId: PROMOTION_ID,
    sourceWorkspaceId: WORKSPACE_ID,
    sourceWorkspaceRevision: 2,
    sourceEventSequence: 3,
    createdAt: 4,
    counts: countsFor(entities),
    familyDigests: promotionSnapshotFamilyDigests(entities),
    terminalLocalWork: {
      queuedIntents: 0 as const,
      activeClaims: 0 as const,
      nonterminalRuns: 0 as const,
      openInteractions: 0 as const,
    },
  };
  return promotionManifestV2Schema.parse({
    ...compact,
    rootDigest: promotionManifestV2RootDigest(compact),
  });
}

function completedProgress(manifest: PromotionManifestV2) {
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

function firstWorkspaceBatch(): PromotionBatchV2 {
  const batch = {
    schemaVersion: 2 as const,
    promotionId: PROMOTION_ID,
    batchId: BATCH_ID,
    family: "workspace_metadata" as const,
    ordinal: 0,
    previousFamilyCount: 0,
    previousFamilyDigest: promotionFamilyInitialDigest("workspace_metadata"),
    previousEntityIdentity: null,
    items: [workspaceEntity],
  };
  return promotionBatchV2Schema.parse({
    ...batch,
    requestDigest: promotionBatchV2RequestDigest(batch),
  });
}

function receiptFor(batch: PromotionBatchV2): PromotionBatchReceiptV2 {
  const advanced = advancePromotionFamilyDigest(
    batch.family,
    {
      count: batch.previousFamilyCount,
      digest: batch.previousFamilyDigest,
      lastEntityIdentity: batch.previousEntityIdentity,
    },
    batch.items,
  );
  return {
    schemaVersion: 2,
    promotionId: batch.promotionId,
    batchId: batch.batchId,
    family: batch.family,
    ordinal: batch.ordinal,
    itemCount: batch.items.length,
    requestDigest: batch.requestDigest,
    acceptedRequestDigest: batch.requestDigest,
    previousFamilyCount: batch.previousFamilyCount,
    previousFamilyDigest: batch.previousFamilyDigest,
    cumulativeFamilyCount: advanced.count,
    cumulativeFamilyDigest: advanced.digest,
    lastEntityIdentity: advanced.lastEntityIdentity ?? "",
    acceptedAt: 10,
    cumulativeCounts: countsFor(batch.items),
  };
}

describe("backend-neutral HRA task contracts", () => {
  test("parses authority-free intents and materializes local authority only in the gateway", () => {
    const intent = {
      operationId: OPERATION_ID,
      expectedWorkspaceRevision: 2,
      kind: "workspace.rename" as const,
      name: "Renamed HRA",
    };
    expect(taskWorkspaceMutationIntentSchema.parse(intent)).toEqual(intent);
    expect(taskWorkspaceMutationIntentSchema.safeParse({
      ...intent,
      authority: {
        kind: "local_owner",
        workspaceId: WORKSPACE_ID,
        installationId: INSTALLATION_ID,
      },
    }).success).toBeFalse();
    expect(materializeLocalOwnerTaskCommand(intent, {
      kind: "local_owner",
      workspaceId: WORKSPACE_ID,
      installationId: INSTALLATION_ID,
    })).toEqual({
      ...intent,
      authority: {
        kind: "local_owner",
        workspaceId: WORKSPACE_ID,
        installationId: INSTALLATION_ID,
      },
    });
  });

  test("models renderer viewers without granting cloud or local authority", () => {
    expect(taskWorkspaceViewerSchema.parse({
      id: "user_ada",
      kind: "human",
      name: "Ada",
    }).kind).toBe("human");
    expect(taskWorkspaceViewerSchema.parse({
      id: INSTALLATION_ID,
      kind: "local_owner",
      name: "This Mac",
    }).kind).toBe("local_owner");
    expect(taskWorkspaceViewerSchema.safeParse({
      id: "agent_worker",
      kind: "agent",
      name: "Worker",
      status: "active",
    }).success).toBeFalse();
  });

  test("binds generic mutation results to the exact intent result family", () => {
    const result = {
      operationId: OPERATION_ID,
      workspaceId: WORKSPACE_ID,
      commandKind: "workspace.rename" as const,
      workspaceRevision: 3,
      projectionRevision: 4,
      result: { kind: "workspace" as const, workspaceRevision: 3 },
    };
    expect(taskWorkspaceMutationResultSchema.parse(result)).toEqual(result);
    expect(taskWorkspaceMutationResultSchema.safeParse({
      ...result,
      commandKind: "task.comment_add",
    }).success).toBeFalse();
  });
});

describe("compact promotion v2 contracts", () => {
  test("canonicalizes JSON and exports the exact deterministic SHA-256 primitive", () => {
    expect(canonicalPromotionJson({ z: 1, a: { y: -0, x: true } }))
      .toBe('{"a":{"x":true,"y":0},"z":1}');
    expect(canonicalPromotionJson({ a: 1, z: 2 }))
      .toBe(canonicalPromotionJson({ z: 2, a: 1 }));
    expect(() => canonicalPromotionJson(Number.NaN)).toThrow();
    expect(promotionSha256Digest("abc")).toBe(
      "sha256_ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("folds ordered family entities independently of batch boundaries", () => {
    const first = {
      family: "repositories",
      id: `repo_${LOCATOR}`,
      name: "Alpha",
      provider: "github",
      url: "https://github.com/example/alpha",
    } as const satisfies PromotionEntity;
    const second = {
      family: "repositories",
      id: `repo_${OTHER_LOCATOR}`,
      name: "Beta",
      provider: "github",
      url: "https://github.com/example/beta",
    } as const satisfies PromotionEntity;
    const direct = promotionFamilyDigest("repositories", [first, second]);
    const checkpoint = advancePromotionFamilyDigest("repositories", {
      count: 0,
      digest: promotionFamilyInitialDigest("repositories"),
      lastEntityIdentity: null,
    }, [first]);
    expect(advancePromotionFamilyDigest(
      "repositories",
      checkpoint,
      [second],
    ).digest).toBe(direct);
    expect(() => promotionFamilyDigest("repositories", [second, first]))
      .toThrow("strict identity order");
  });

  test("proves an accepted batch request and cumulative family checkpoint", () => {
    const batch = firstWorkspaceBatch();
    const receipt = receiptFor(batch);
    expect(promotionBatchAcceptanceV2Schema.parse({ batch, receipt }))
      .toEqual({ batch, receipt });
    expect(promotionBatchAcceptanceV2Schema.safeParse({
      batch,
      receipt: {
        ...receipt,
        cumulativeFamilyDigest: promotionFamilyInitialDigest(
          "workspace_metadata",
        ),
      },
    }).success).toBeFalse();
    expect(promotionBatchReplayDisposition(receipt, batch)).toBe("replay");
    expect(promotionBatchReplayDisposition(receipt, {
      ...batch,
      batchId: `batch_${OTHER_LOCATOR}`,
    })).toBe("conflict");
    expect(promotionBatchReplayDisposition(null, batch)).toBe("accept");
  });

  test("enforces family order, contiguous ordinals, and exact checkpoints", () => {
    const progress = promotionUploadProgressSchema.parse({
      activeFamilyIndex: 0,
      receiptCount: 0,
      acceptedEntityCount: 0,
      families: initialPromotionFamilyProgressMap(),
    });
    const batch = firstWorkspaceBatch();
    expect(promotionBatchOrderDisposition(progress, batch)).toBe("accept");
    const skippedFamily = {
      ...batch,
      family: "executors" as const,
      previousFamilyDigest: promotionFamilyInitialDigest("executors"),
      items: [executorEntity],
    };
    const checkedSkippedFamily = promotionBatchV2Schema.parse({
      ...skippedFamily,
      requestDigest: promotionBatchV2RequestDigest(skippedFamily),
    });
    expect(promotionBatchOrderDisposition(progress, checkedSkippedFamily))
      .toBe("family_out_of_order");
    const skippedOrdinal = {
      ...batch,
      ordinal: 1,
    };
    const checkedSkippedOrdinal = promotionBatchV2Schema.parse({
      ...skippedOrdinal,
      requestDigest: promotionBatchV2RequestDigest(skippedOrdinal),
    });
    expect(promotionBatchOrderDisposition(progress, checkedSkippedOrdinal))
      .toBe("ordinal_conflict");
  });

  test("keeps the maximum-scale resumable state fixed-size", () => {
    const familyDigests = promotionSnapshotFamilyDigests([
      workspaceEntity,
      executorEntity,
    ]);
    familyDigests.tasks = `sha256_${"a".repeat(64)}`;
    const maximumCounts = {
      ...countsFor([workspaceEntity, executorEntity]),
      tasks: 499_998,
    };
    const compact = {
      schemaVersion: 2 as const,
      promotionId: PROMOTION_ID,
      sourceWorkspaceId: WORKSPACE_ID,
      sourceWorkspaceRevision: 2,
      sourceEventSequence: 3,
      createdAt: 4,
      counts: maximumCounts,
      familyDigests,
      terminalLocalWork: {
        queuedIntents: 0 as const,
        activeClaims: 0 as const,
        nonterminalRuns: 0 as const,
        openInteractions: 0 as const,
      },
    };
    const manifest = promotionManifestV2Schema.parse({
      ...compact,
      rootDigest: promotionManifestV2RootDigest(compact),
    });
    const state = workspacePromotionStateV2Schema.parse({
      schemaVersion: 2,
      state: "receiving",
      promotionId: PROMOTION_ID,
      manifest,
      stagingWorkspaceId: DESTINATION_WORKSPACE_ID,
      localWritable: false,
      progress: {
        activeFamilyIndex: 0,
        receiptCount: 0,
        acceptedEntityCount: 0,
        families: initialPromotionFamilyProgressMap(),
      },
    });
    expect(JSON.stringify(state).length).toBeLessThan(12_000);
    expect(JSON.stringify(state)).not.toContain("acceptedBatchReceipts");
  });

  test("distinguishes proven cloud rejection from an uncertain outcome", () => {
    const manifest = manifestFor([workspaceEntity, executorEntity]);
    const progress = completedProgress(manifest);
    const rejected = workspacePromotionStateV2Schema.parse({
      schemaVersion: 2,
      state: "rejected",
      rejectionCode: "projection_failed",
      promotionId: PROMOTION_ID,
      manifest,
      stagingWorkspaceId: DESTINATION_WORKSPACE_ID,
      localWritable: false,
      progress,
    });

    expect(rejected).toMatchObject({
      state: "rejected",
      rejectionCode: "projection_failed",
      localWritable: false,
    });
    expect(workspacePromotionStateV2Schema.safeParse({
      ...rejected,
      rejectionCode: "unbounded_provider_detail",
    }).success).toBeFalse();
    expect(workspacePromotionStateV2Schema.safeParse({
      ...rejected,
      state: "outcome_unknown",
    }).success).toBeFalse();
  });

  test("binds all family digests into activation and proves pre-activation abort", () => {
    const manifest = manifestFor([workspaceEntity, executorEntity]);
    const activationFields = {
      schemaVersion: 2 as const,
      issuer: "convex_promotion_authority" as const,
      serverReceiptId: `promotion_receipt_${LOCATOR}`,
      promotionId: PROMOTION_ID,
      sourceWorkspaceId: WORKSPACE_ID,
      destinationWorkspaceId: DESTINATION_WORKSPACE_ID,
      acceptedManifestRoot: manifest.rootDigest,
      acceptedCounts: manifest.counts,
      acceptedFamilyDigests: manifest.familyDigests,
      decision: "activated" as const,
      decisionSequence: 1,
      activatedAt: 20,
    };
    const activationReceipt = promotionActivationReceiptV2Schema.parse({
      ...activationFields,
      receiptDigest: promotionActivationReceiptV2Digest(activationFields),
    });
    expect(workspacePromotionStateV2Schema.safeParse({
      schemaVersion: 2,
      state: "activated",
      promotionId: PROMOTION_ID,
      manifest,
      stagingWorkspaceId: DESTINATION_WORKSPACE_ID,
      localWritable: false,
      activationReceipt,
    }).success).toBeTrue();
    expect(promotionActivationReceiptV2Schema.safeParse({
      ...activationReceipt,
      acceptedFamilyDigests: {
        ...activationReceipt.acceptedFamilyDigests,
        tasks: `sha256_${"f".repeat(64)}`,
      },
    }).success).toBeFalse();

    const abortFields = {
      schemaVersion: 2 as const,
      issuer: "convex_promotion_authority" as const,
      serverReceiptId: `promotion_receipt_${OTHER_LOCATOR}`,
      promotionId: PROMOTION_ID,
      sourceWorkspaceId: WORKSPACE_ID,
      stagingWorkspaceId: DESTINATION_WORKSPACE_ID,
      manifestRoot: manifest.rootDigest,
      decision: "aborted_before_activation" as const,
      decisionSequence: 1,
      abortedAt: 20,
    };
    const abortReceipt = promotionAbortReceiptV2Schema.parse({
      ...abortFields,
      receiptDigest: promotionAbortReceiptV2Digest(abortFields),
    });
    expect(workspacePromotionStateV2Schema.safeParse({
      schemaVersion: 2,
      state: "aborted",
      promotionId: PROMOTION_ID,
      sourceWorkspaceId: WORKSPACE_ID,
      manifestRoot: manifest.rootDigest,
      stagingWorkspaceId: DESTINATION_WORKSPACE_ID,
      abortReceipt,
      localWritable: true,
    }).success).toBeTrue();
    expect(promotionAbortReceiptV2Schema.safeParse({
      ...abortReceipt,
      decision: "activated",
    }).success).toBeFalse();
  });

  test("keeps receipt audit bounded and session-specific", () => {
    const batch = firstWorkspaceBatch();
    const receipt = receiptFor(batch);
    expect(promotionBatchReceiptPageSchema.parse({
      promotionId: PROMOTION_ID,
      items: [receipt],
      cursor: "promotion_receipts_v1_next",
      hasMore: true,
    }).items).toHaveLength(1);
    expect(promotionBatchReceiptPageSchema.safeParse({
      promotionId: `promotion_${OTHER_LOCATOR}`,
      items: [receipt],
      cursor: null,
      hasMore: false,
    }).success).toBeFalse();
    expect(promotionBatchReceiptPageSchema.safeParse({
      promotionId: PROMOTION_ID,
      items: Array.from({ length: 101 }, () => receipt),
      cursor: null,
      hasMore: false,
    }).success).toBeFalse();
  });
});
