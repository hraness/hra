import { describe, expect, test } from "bun:test";

import {
  promotionBatchAcceptanceSchema,
  promotionBatchDigestPreimage,
  promotionBatchRequestDigest,
  promotionBatchSchema,
  promotionCredentialFreeHttpsUrlSchema,
  promotionEntityCountsSchema,
  promotionEntityFamilyValues,
  promotionEntityIdentity,
  promotionEntitySchema,
  promotionSnapshotSchema,
  promotionSnapshotRootDigest,
  sanitizedImportedEvidenceSchema,
  taskLabelRelationKey,
  workspacePromotionStateSchema,
  type PromotionEntity,
} from "./index";

const LOCATOR = "0123456789ABCDEFGHJKMNPQRS";
const OTHER_LOCATOR = "1123456789ABCDEFGHJKMNPQRS";
const WORKSPACE_ID = `wsp_${LOCATOR}`;
const OTHER_WORKSPACE_ID = `wsp_${OTHER_LOCATOR}`;
const TASK_ID = `tsk_${LOCATOR}`;
const OTHER_TASK_ID = `tsk_${OTHER_LOCATOR}`;
const PROMOTION_ID = `promotion_${LOCATOR}`;
const BATCH_ID = `batch_${LOCATOR}`;
const REQUEST_DIGEST = `sha256_${"b".repeat(64)}`;

function entityCounts(entities: readonly PromotionEntity[]) {
  return promotionEntityCountsSchema.parse(Object.fromEntries(
    promotionEntityFamilyValues.map((family) => [
      family,
      entities.filter((entity) => entity.family === family).length,
    ]),
  ));
}

function manifest(
  entities: readonly PromotionEntity[],
) {
  const unsigned = {
    schemaVersion: 1 as const,
    promotionId: PROMOTION_ID,
    sourceWorkspaceId: WORKSPACE_ID,
    sourceWorkspaceRevision: 3,
    sourceEventSequence: 5,
    createdAt: 10,
    rootDigest: `sha256_${"0".repeat(64)}`,
    counts: entityCounts(entities),
    repositoryIds: entities.flatMap((entity) =>
      entity.family === "repositories" ? [entity.id] : []),
    taskIds: entities.flatMap((entity) =>
      entity.family === "tasks" ? [entity.id] : []),
    terminalLocalWork: {
      queuedIntents: 0 as const,
      activeClaims: 0 as const,
      nonterminalRuns: 0 as const,
      openInteractions: 0 as const,
    },
  };
  return {
    ...unsigned,
    rootDigest: promotionSnapshotRootDigest({ manifest: unsigned, entities }),
  };
}

const workspaceEntity = {
  family: "workspace_metadata" as const,
  workspaceId: WORKSPACE_ID,
  name: "HRA",
  slug: "hra",
  keyPrefix: "KIT",
};
const executorEntity = {
  family: "executors" as const,
  workspaceId: WORKSPACE_ID,
  executor: "local_codex" as const,
  enabled: true as const,
};
const inReviewTaskEntity = {
  family: "tasks" as const,
  id: TASK_ID,
  key: "KIT-123ABCD",
  title: "Make soup",
  type: "task" as const,
  priority: 2,
  status: "in_review" as const,
  availableAt: 1,
  revision: 2,
  reviewRevision: 2,
};
const taskBodyEntity = {
  family: "task_bodies" as const,
  taskId: TASK_ID,
  description: "Use vegetables.",
};
const pendingSubmissionEntity = {
  family: "submissions" as const,
  taskId: TASK_ID,
  submissionId: `sub_${LOCATOR}`,
  reviewRevision: 2,
  status: "pending" as const,
  summary: "Ready to review",
  evidence: [],
};

describe("promotion cross-record integrity", () => {
  test("supports one pending submission for an in-review task without inventing a review", () => {
    const entities: PromotionEntity[] = [
      workspaceEntity,
      executorEntity,
      inReviewTaskEntity,
      taskBodyEntity,
      pendingSubmissionEntity,
    ];
    const snapshot = { manifest: manifest(entities), entities };
    expect(promotionSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(promotionSnapshotSchema.safeParse({
      manifest: manifest(entities.slice(0, -1)),
      entities: entities.slice(0, -1),
    }).success).toBeFalse();
    const pendingReview = {
      family: "reviews" as const,
      taskId: TASK_ID,
      submissionId: pendingSubmissionEntity.submissionId,
      decision: "accepted" as const,
      reviewerProvenance: "local_owner" as const,
      reviewedAt: 2,
    };
    const contradictory = [...entities, pendingReview];
    expect(promotionSnapshotSchema.safeParse({
      manifest: manifest(contradictory),
      entities: contradictory,
    }).success).toBeFalse();

    const stalePending = entities.map((entity) =>
      entity.family === "submissions"
        ? { ...entity, reviewRevision: inReviewTaskEntity.reviewRevision - 1 }
        : entity);
    expect(promotionSnapshotSchema.safeParse({
      manifest: manifest(stalePending),
      entities: stalePending,
    }).success).toBeFalse();

    const historicalSubmission = {
      ...pendingSubmissionEntity,
      submissionId: `sub_${OTHER_LOCATOR}`,
      reviewRevision: 1,
      status: "rejected" as const,
    };
    const historicalReview = {
      family: "reviews" as const,
      taskId: TASK_ID,
      submissionId: historicalSubmission.submissionId,
      decision: "rejected" as const,
      reviewerProvenance: "local_owner" as const,
      reason: "The earlier attempt needed another pass.",
      reviewedAt: 1,
    };
    const withHistory: PromotionEntity[] = [
      ...entities,
      historicalSubmission,
      historicalReview,
    ];
    expect(promotionSnapshotSchema.parse({
      manifest: manifest(withHistory),
      entities: withHistory,
    })).toEqual({
      manifest: manifest(withHistory),
      entities: withHistory,
    });
  });

  test("requires decision-specific durable review reasons", () => {
    const reviewBase = {
      family: "reviews" as const,
      taskId: TASK_ID,
      submissionId: pendingSubmissionEntity.submissionId,
      reviewerProvenance: "local_owner" as const,
      reviewedAt: 2,
    };
    expect(promotionEntitySchema.safeParse({
      ...reviewBase,
      decision: "accepted",
    }).success).toBeTrue();
    expect(promotionEntitySchema.safeParse({
      ...reviewBase,
      decision: "accepted",
      reason: "Unexpected accepted reason",
    }).success).toBeFalse();
    for (const decision of ["rejected", "cancelled"] as const) {
      expect(promotionEntitySchema.safeParse({
        ...reviewBase,
        decision,
      }).success).toBeFalse();
      expect(promotionEntitySchema.safeParse({
        ...reviewBase,
        decision,
        reason: `${decision} for a durable reason`,
      }).success).toBeTrue();
    }
  });

  test("orders historical and accepted submissions against the task review revision", () => {
    const futureRejectedSubmission = {
      ...pendingSubmissionEntity,
      reviewRevision: 3,
      status: "rejected" as const,
    };
    const futureRejectedReview = {
      family: "reviews" as const,
      taskId: TASK_ID,
      submissionId: futureRejectedSubmission.submissionId,
      decision: "rejected" as const,
      reviewerProvenance: "local_owner" as const,
      reason: "This row claims to come from a future review revision.",
      reviewedAt: 2,
    };
    const openWithFutureHistory: PromotionEntity[] = [
      workspaceEntity,
      executorEntity,
      { ...inReviewTaskEntity, status: "open" },
      taskBodyEntity,
      futureRejectedSubmission,
      futureRejectedReview,
    ];
    expect(promotionSnapshotSchema.safeParse({
      manifest: manifest(openWithFutureHistory),
      entities: openWithFutureHistory,
    }).success).toBeFalse();

    const staleAcceptedSubmission = {
      ...pendingSubmissionEntity,
      reviewRevision: 1,
      status: "accepted" as const,
    };
    const staleAcceptedReview = {
      family: "reviews" as const,
      taskId: TASK_ID,
      submissionId: staleAcceptedSubmission.submissionId,
      decision: "accepted" as const,
      reviewerProvenance: "local_owner" as const,
      reviewedAt: 2,
    };
    const doneWithStaleAcceptance: PromotionEntity[] = [
      workspaceEntity,
      executorEntity,
      { ...inReviewTaskEntity, status: "done" },
      taskBodyEntity,
      staleAcceptedSubmission,
      staleAcceptedReview,
      {
        family: "terminal_states",
        taskId: TASK_ID,
        status: "done",
        acceptedSubmissionId: staleAcceptedSubmission.submissionId,
        terminalAt: 2,
      },
    ];
    expect(promotionSnapshotSchema.safeParse({
      manifest: manifest(doneWithStaleAcceptance),
      entities: doneWithStaleAcceptance,
    }).success).toBeFalse();
  });

  test("retains accepted history and points done state at the current acceptance", () => {
    const historicalAcceptedSubmission = {
      ...pendingSubmissionEntity,
      submissionId: `sub_${OTHER_LOCATOR}`,
      reviewRevision: 1,
      status: "accepted" as const,
    };
    const historicalAcceptedReview = {
      family: "reviews" as const,
      taskId: TASK_ID,
      submissionId: historicalAcceptedSubmission.submissionId,
      decision: "accepted" as const,
      reviewerProvenance: "local_owner" as const,
      reviewedAt: 1,
    };
    const openWithAcceptedHistory: PromotionEntity[] = [
      workspaceEntity,
      executorEntity,
      { ...inReviewTaskEntity, status: "open" },
      taskBodyEntity,
      historicalAcceptedSubmission,
      historicalAcceptedReview,
    ];
    expect(promotionSnapshotSchema.safeParse({
      manifest: manifest(openWithAcceptedHistory),
      entities: openWithAcceptedHistory,
    }).success).toBeTrue();

    const currentAcceptedSubmission = {
      ...pendingSubmissionEntity,
      status: "accepted" as const,
    };
    const currentAcceptedReview = {
      family: "reviews" as const,
      taskId: TASK_ID,
      submissionId: currentAcceptedSubmission.submissionId,
      decision: "accepted" as const,
      reviewerProvenance: "local_owner" as const,
      reviewedAt: 2,
    };
    const doneWithAcceptedHistory: PromotionEntity[] = [
      workspaceEntity,
      executorEntity,
      { ...inReviewTaskEntity, status: "done" },
      taskBodyEntity,
      historicalAcceptedSubmission,
      historicalAcceptedReview,
      currentAcceptedSubmission,
      currentAcceptedReview,
      {
        family: "terminal_states",
        taskId: TASK_ID,
        status: "done",
        acceptedSubmissionId: currentAcceptedSubmission.submissionId,
        terminalAt: 2,
      },
    ];
    expect(promotionSnapshotSchema.safeParse({
      manifest: manifest(doneWithAcceptedHistory),
      entities: doneWithAcceptedHistory,
    }).success).toBeTrue();
  });

  test("binds a same-revision done pointer to the matching accepted review time", () => {
    const acceptedA = {
      ...pendingSubmissionEntity,
      submissionId: `sub_${OTHER_LOCATOR}`,
      status: "accepted" as const,
    };
    const acceptedB = {
      ...pendingSubmissionEntity,
      status: "accepted" as const,
    };
    const reviewA = {
      family: "reviews" as const,
      taskId: TASK_ID,
      submissionId: acceptedA.submissionId,
      decision: "accepted" as const,
      reviewerProvenance: "local_owner" as const,
      reviewedAt: 10,
    };
    const reviewB = {
      family: "reviews" as const,
      taskId: TASK_ID,
      submissionId: acceptedB.submissionId,
      decision: "accepted" as const,
      reviewerProvenance: "local_owner" as const,
      reviewedAt: 20,
    };
    const sharedEntities: PromotionEntity[] = [
      workspaceEntity,
      executorEntity,
      { ...inReviewTaskEntity, status: "done" },
      taskBodyEntity,
      acceptedA,
      reviewA,
      acceptedB,
      reviewB,
    ];
    const pointsAtOlderAcceptance: PromotionEntity[] = [
      ...sharedEntities,
      {
        family: "terminal_states",
        taskId: TASK_ID,
        status: "done",
        acceptedSubmissionId: acceptedA.submissionId,
        terminalAt: 20,
      },
    ];
    expect(promotionSnapshotSchema.safeParse({
      manifest: manifest(pointsAtOlderAcceptance),
      entities: pointsAtOlderAcceptance,
    }).success).toBeFalse();

    const pointsAtCurrentAcceptance: PromotionEntity[] = [
      ...sharedEntities,
      {
        family: "terminal_states",
        taskId: TASK_ID,
        status: "done",
        acceptedSubmissionId: acceptedB.submissionId,
        terminalAt: 20,
      },
    ];
    expect(promotionSnapshotSchema.safeParse({
      manifest: manifest(pointsAtCurrentAcceptance),
      entities: pointsAtCurrentAcceptance,
    }).success).toBeTrue();
  });

  test("rejects missing, cross-task, non-accepted, and cancelled terminal pointers", () => {
    expect(promotionEntitySchema.safeParse({
      family: "terminal_states",
      taskId: TASK_ID,
      status: "cancelled",
      acceptedSubmissionId: pendingSubmissionEntity.submissionId,
      terminalAt: 2,
    }).success).toBeFalse();

    const missingPointer: PromotionEntity[] = [
      workspaceEntity,
      executorEntity,
      { ...inReviewTaskEntity, status: "done" },
      taskBodyEntity,
      {
        family: "terminal_states",
        taskId: TASK_ID,
        status: "done",
        acceptedSubmissionId: `sub_${OTHER_LOCATOR}`,
        terminalAt: 2,
      },
    ];
    expect(promotionSnapshotSchema.safeParse({
      manifest: manifest(missingPointer),
      entities: missingPointer,
    }).success).toBeFalse();

    const otherTask = {
      ...inReviewTaskEntity,
      id: OTHER_TASK_ID,
      key: "KIT-456EFGH",
      title: "Make salad",
      status: "open" as const,
    };
    const otherTaskBody = {
      ...taskBodyEntity,
      taskId: OTHER_TASK_ID,
      description: "Use greens.",
    };
    const otherAcceptedSubmission = {
      ...pendingSubmissionEntity,
      taskId: OTHER_TASK_ID,
      submissionId: `sub_${OTHER_LOCATOR}`,
      status: "accepted" as const,
    };
    const otherAcceptedReview = {
      family: "reviews" as const,
      taskId: OTHER_TASK_ID,
      submissionId: otherAcceptedSubmission.submissionId,
      decision: "accepted" as const,
      reviewerProvenance: "local_owner" as const,
      reviewedAt: 2,
    };
    const crossTaskPointer: PromotionEntity[] = [
      workspaceEntity,
      executorEntity,
      { ...inReviewTaskEntity, status: "done" },
      taskBodyEntity,
      otherTask,
      otherTaskBody,
      otherAcceptedSubmission,
      otherAcceptedReview,
      {
        family: "terminal_states",
        taskId: TASK_ID,
        status: "done",
        acceptedSubmissionId: otherAcceptedSubmission.submissionId,
        terminalAt: 2,
      },
    ];
    expect(promotionSnapshotSchema.safeParse({
      manifest: manifest(crossTaskPointer),
      entities: crossTaskPointer,
    }).success).toBeFalse();

    const rejectedSubmission = {
      ...pendingSubmissionEntity,
      status: "rejected" as const,
    };
    const rejectedReview = {
      family: "reviews" as const,
      taskId: TASK_ID,
      submissionId: rejectedSubmission.submissionId,
      decision: "rejected" as const,
      reviewerProvenance: "local_owner" as const,
      reason: "This submission was not accepted.",
      reviewedAt: 2,
    };
    const nonAcceptedPointer: PromotionEntity[] = [
      workspaceEntity,
      executorEntity,
      { ...inReviewTaskEntity, status: "done" },
      taskBodyEntity,
      rejectedSubmission,
      rejectedReview,
      {
        family: "terminal_states",
        taskId: TASK_ID,
        status: "done",
        acceptedSubmissionId: rejectedSubmission.submissionId,
        terminalAt: 2,
      },
    ];
    expect(promotionSnapshotSchema.safeParse({
      manifest: manifest(nonAcceptedPointer),
      entities: nonAcceptedPointer,
    }).success).toBeFalse();
  });

  test("rejects incomplete, foreign, or live task snapshot records", () => {
    const entities: PromotionEntity[] = [
      workspaceEntity,
      executorEntity,
      inReviewTaskEntity,
      taskBodyEntity,
      pendingSubmissionEntity,
    ];
    const missingBody = entities.filter((entity) => entity.family !== "task_bodies");
    expect(promotionSnapshotSchema.safeParse({
      manifest: manifest(missingBody),
      entities: missingBody,
    }).success).toBeFalse();
    const foreignBody = entities.map((entity) =>
      entity.family === "task_bodies"
        ? { ...entity, taskId: OTHER_TASK_ID }
        : entity);
    expect(promotionSnapshotSchema.safeParse({
      manifest: manifest(foreignBody),
      entities: foreignBody,
    }).success).toBeFalse();
    const foreignExecutor = entities.map((entity) =>
      entity.family === "executors"
        ? { ...entity, workspaceId: OTHER_WORKSPACE_ID }
        : entity);
    expect(promotionSnapshotSchema.safeParse({
      manifest: manifest(foreignExecutor),
      entities: foreignExecutor,
    }).success).toBeFalse();
    const wrongPrefix = entities.map((entity) =>
      entity.family === "tasks"
        ? { ...entity, key: "OPS-123ABCD" }
        : entity);
    expect(promotionSnapshotSchema.safeParse({
      manifest: manifest(wrongPrefix),
      entities: wrongPrefix,
    }).success).toBeFalse();
    expect(promotionEntitySchema.safeParse({
      ...inReviewTaskEntity,
      status: "in_progress",
    }).success).toBeFalse();
    const tooManyLabels: PromotionEntity[] = [
      ...entities,
      ...Array.from({ length: 51 }, (_, index) => {
        const label = `label-${String(index)}`;
        return {
          family: "labels" as const,
          relationKey: taskLabelRelationKey(TASK_ID, label),
          taskId: TASK_ID,
          label,
        };
      }),
    ];
    expect(promotionSnapshotSchema.safeParse({
      manifest: manifest(tooManyLabels),
      entities: tooManyLabels,
    }).success).toBeFalse();
    const doneWithoutAcceptance: PromotionEntity[] = [
      workspaceEntity,
      executorEntity,
      { ...inReviewTaskEntity, status: "done" },
      taskBodyEntity,
      {
        family: "terminal_states",
        taskId: TASK_ID,
        status: "done",
        acceptedSubmissionId: `sub_${OTHER_LOCATOR}`,
        terminalAt: 3,
      },
    ];
    expect(promotionSnapshotSchema.safeParse({
      manifest: manifest(doneWithoutAcceptance),
      entities: doneWithoutAcceptance,
    }).success).toBeFalse();
  });

  test("binds manifest IDs, source, counts, receipts, and activation as one session", () => {
    const entities: PromotionEntity[] = [workspaceEntity, executorEntity];
    const frozen = manifest(entities);
    const cumulativeCounts = entityCounts([workspaceEntity]);
    const receipt = {
      promotionId: PROMOTION_ID,
      batchId: BATCH_ID,
      family: "workspace_metadata" as const,
      ordinal: 0,
      itemCount: 1,
      requestDigest: REQUEST_DIGEST,
      acceptedDigest: REQUEST_DIGEST,
      acceptedAt: 11,
      cumulativeCounts,
    };
    const promoting = {
      state: "promoting" as const,
      promotionId: PROMOTION_ID,
      manifest: frozen,
      localWritable: false as const,
      stagingWorkspaceId: OTHER_WORKSPACE_ID,
      acceptedBatchReceipts: [receipt],
    };
    expect(workspacePromotionStateSchema.parse(promoting)).toEqual(promoting);
    expect(workspacePromotionStateSchema.safeParse({
      ...promoting,
      promotionId: `promotion_${OTHER_LOCATOR}`,
    }).success).toBeFalse();
    expect(workspacePromotionStateSchema.safeParse({
      ...promoting,
      stagingWorkspaceId: WORKSPACE_ID,
    }).success).toBeFalse();
    expect(workspacePromotionStateSchema.safeParse({
      ...promoting,
      acceptedBatchReceipts: [
        receipt,
        { ...receipt, ordinal: 0 },
      ],
    }).success).toBeFalse();
    expect(workspacePromotionStateSchema.safeParse({
      ...promoting,
      acceptedBatchReceipts: [{
        ...receipt,
        promotionId: `promotion_${OTHER_LOCATOR}`,
      }],
    }).success).toBeFalse();
    expect(workspacePromotionStateSchema.safeParse({
      ...promoting,
      stagingWorkspaceId: undefined,
    }).success).toBeFalse();
    expect(workspacePromotionStateSchema.safeParse({
      ...promoting,
      acceptedBatchReceipts: [{
        ...receipt,
        cumulativeCounts: frozen.counts,
      }],
    }).success).toBeFalse();

    const promoted = {
      state: "promoted" as const,
      promotionId: PROMOTION_ID,
      manifest: frozen,
      localWritable: false as const,
      stagingWorkspaceId: OTHER_WORKSPACE_ID,
      activationReceipt: {
        promotionId: PROMOTION_ID,
        sourceWorkspaceId: WORKSPACE_ID,
        destinationWorkspaceId: OTHER_WORKSPACE_ID,
        acceptedManifestRoot: frozen.rootDigest,
        acceptedCounts: frozen.counts,
        activatedAt: 12,
      },
    };
    expect(workspacePromotionStateSchema.parse(promoted)).toEqual(promoted);
    expect(workspacePromotionStateSchema.safeParse({
      ...promoted,
      stagingWorkspaceId: `wsp_2123456789ABCDEFGHJKMNPQRS`,
    }).success).toBeFalse();
    expect(workspacePromotionStateSchema.safeParse({
      ...promoted,
      activationReceipt: {
        ...promoted.activationReceipt,
        acceptedManifestRoot: `sha256_${"c".repeat(64)}`,
      },
    }).success).toBeFalse();
    expect(workspacePromotionStateSchema.safeParse({
      ...promoted,
      activationReceipt: {
        ...promoted.activationReceipt,
        acceptedCounts: {
          ...promoted.activationReceipt.acceptedCounts,
          comments: 1,
        },
      },
    }).success).toBeFalse();
  });

  test("rejects duplicate upsert identities within a batch", () => {
    const content = {
      promotionId: PROMOTION_ID,
      batchId: BATCH_ID,
      family: "tasks" as const,
      ordinal: 0,
      items: [inReviewTaskEntity, inReviewTaskEntity],
    };
    const batch = {
      ...content,
      requestDigest: promotionBatchRequestDigest(content),
    };
    expect(promotionBatchSchema.safeParse(batch).success).toBeFalse();
  });

  test("correlates every accepted batch receipt to the exact request", () => {
    const content = {
      promotionId: PROMOTION_ID,
      batchId: BATCH_ID,
      family: "workspace_metadata" as const,
      ordinal: 0,
      items: [workspaceEntity],
    };
    const batch = {
      ...content,
      requestDigest: promotionBatchRequestDigest(content),
    };
    const receipt = {
      promotionId: PROMOTION_ID,
      batchId: BATCH_ID,
      family: "workspace_metadata" as const,
      ordinal: 0,
      itemCount: 1,
      requestDigest: batch.requestDigest,
      acceptedDigest: batch.requestDigest,
      acceptedAt: 11,
      cumulativeCounts: entityCounts([workspaceEntity, executorEntity]),
    };
    expect(promotionBatchAcceptanceSchema.safeParse({ batch, receipt }).success).toBeTrue();
    expect(promotionBatchDigestPreimage(batch)).toStartWith(
      "hraness-kitchen:promotion-batch:v1\n",
    );
    expect(batch.requestDigest).toBe(
      "sha256_e7f1610e8988b0a66e765e030e5b8679c2a9698868f1d5e8b3db01627e294a8d",
    );
    const changedItemBatch = {
      ...batch,
      items: [{ ...workspaceEntity, name: "Changed without changing its ID" }],
    };
    expect(promotionBatchSchema.safeParse(changedItemBatch).success).toBeFalse();
    expect(promotionBatchAcceptanceSchema.safeParse({
      batch: changedItemBatch,
      receipt,
    }).success).toBeFalse();
    for (const changed of [
      { batchId: `batch_${OTHER_LOCATOR}` },
      { family: "executors" },
      { ordinal: 1 },
      { itemCount: 2 },
      { requestDigest: `sha256_${"c".repeat(64)}` },
      { acceptedDigest: `sha256_${"c".repeat(64)}` },
    ]) {
      expect(promotionBatchAcceptanceSchema.safeParse({
        batch,
        receipt: { ...receipt, ...changed },
      }).success).toBeFalse();
    }
  });

  test("binds the manifest root to same-count, same-ID snapshot content", () => {
    const entities: PromotionEntity[] = [workspaceEntity, executorEntity];
    const frozen = manifest(entities);
    expect(promotionSnapshotSchema.safeParse({
      manifest: frozen,
      entities,
    }).success).toBeTrue();
    const changedEntities: PromotionEntity[] = [
      { ...workspaceEntity, name: "A different workspace name" },
      executorEntity,
    ];
    expect(entityCounts(changedEntities)).toEqual(entityCounts(entities));
    expect(changedEntities.map(promotionEntityIdentity)).toEqual(
      entities.map(promotionEntityIdentity),
    );
    expect(promotionSnapshotSchema.safeParse({
      manifest: frozen,
      entities: changedEntities,
    }).success).toBeFalse();
    expect(promotionSnapshotRootDigest({
      manifest: frozen,
      entities: changedEntities,
    })).not.toBe(frozen.rootDigest);
  });
});

describe("promotion privacy boundary", () => {
  test("rejects credential-like query and fragment material without blocking normal URLs", () => {
    expect(promotionCredentialFreeHttpsUrlSchema.safeParse(
      "https://example.com/repository?view=activity&dispatch=now&path=readme#readme",
    ).success).toBeTrue();
    for (const url of [
      "https://example.com/repository?access_token=secret",
      "https://example.com/repository?accessToken=secret",
      "https://example.com/repository?apikey=secret",
      "https://example.com/repository?pat=ordinary-looking-value",
      "https://example.com/repository?pwd=ordinary-looking-value",
      "https://example.com/repository?private_token=abc123",
      "https://example.com/repository?auth_key=abc123",
      "https://example.com/repository?key=AIzaSyDabcdefghijklmnopqrstuvwxyz",
      "https://example.com/repository?authorization=Basic%20c2VjcmV0",
      "https://example.com/repository?X-Amz-Signature=abc",
      "https://example.com/repository#token=secret",
      "https://example.com/repository#accessToken=secret",
      "https://example.com/repository?value=Bearer%20secret",
      "https://example.com/repository?value=%2567%2568%2570%255fabcdefghijklmnopqrstuvwxyz0123456789AB",
      "https://example.com/repository?value=%2525252567%2525252568%2525252570%252525255Fabcdefghijklmnopqrstuvwxyz0123456789AB",
      "https://example.com/repository?value=%ZZ+%2567%2568%2570%255Fabcdefghijklmnopqrstuvwxyz0123456789AB",
      "https://example.com/repository?value=%2525252525252525252541",
      "https://example.com/repository#github_pat_abcdefghijklmnopqrstuvwxyz0123456789",
      "https://example.com/private/ghp_abcdefghijklmnopqrstuvwxyz0123456789AB",
      "https://example.com/private/%ZZ",
      "https://glpat-abcdefghijklmnopqrstuvwxyz012345.example.com/repository", // gitleaks:allow - negative security fixture
      "https://example.com/private/eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnopqrstuvwxyzABCD.abcdefghijklmnopqrstuvwxyzABCD",
      "https://user:password@example.com/repository",
    ]) {
      expect(promotionCredentialFreeHttpsUrlSchema.safeParse(url).success).toBeFalse();
    }
  });

  test("applies the credential-free URL law to every promotion URL family", () => {
    const credentialUrl = "https://example.com/private?api_key=secret";
    const credentialHostnameUrl =
      "https://glpat-abcdefghijklmnopqrstuvwxyz012345.example.com/repository"; // gitleaks:allow - negative security fixture
    expect(promotionEntitySchema.safeParse({
      family: "repositories",
      id: `repo_${LOCATOR}`,
      name: "HRA",
      provider: "github",
      url: credentialUrl,
    }).success).toBeFalse();
    expect(promotionEntitySchema.safeParse({
      family: "repositories",
      id: `repo_${LOCATOR}`,
      name: "HRA",
      provider: "gitlab",
      url: credentialHostnameUrl,
    }).success).toBeFalse();
    expect(promotionEntitySchema.safeParse({
      family: "references",
      taskId: TASK_ID,
      reference: {
        id: `ref_${LOCATOR}`,
        createdAt: 1,
        kind: "url",
        label: "Private artifact",
        url: credentialUrl,
      },
    }).success).toBeFalse();
    expect(sanitizedImportedEvidenceSchema.safeParse({
      kind: "artifact",
      name: "Private artifact",
      url: credentialUrl,
    }).success).toBeFalse();
  });
});
