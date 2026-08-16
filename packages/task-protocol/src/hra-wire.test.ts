import { describe, expect, test } from "bun:test";

import {
  HRA_PROMOTION_MAX_REQUEST_BYTES,
  RUN_INTERACTION_SEALED_CIPHERTEXT_BASE64URL_CHARACTERS,
  acceptHRAPromotionBatchRequestSchema,
  getHRARunInteractionReplyAuthorityResponseSchema,
  getHRATaskResponseSchema,
  initialPromotionFamilyProgressMap,
  legacyKitchenHumanApiRoutes,
  legacyKitchenPromotionApiRoutes,
  legacyOprteHumanApiRoutes,
  legacyOprtePromotionApiRoutes,
  legacyOprteSessionSyncHttpRoutes,
  legacyPredecessorHumanApiRoutes,
  legacyPredecessorPromotionApiRoutes,
  hraHumanApiOperations,
  hraHumanApiRoutes,
  hraHumanMutationKindValues,
  hraHumanMutationIntentSchema,
  hraProjectionCursorSchema,
  hraPromotionApiOperations,
  hraPromotionApiRoutes,
  listHRATasksQuerySchema,
  listHRATasksResponseSchema,
  lookupHRAPromotionEnvelopeSchema,
  lookupHRATaskResponseSchema,
  parseHRAHumanRoute,
  parseHRAPromotionRoute,
  pollHRAInvalidationsResponseSchema,
  promotionBatchV2RequestDigest,
  promotionEntityCountsSchema,
  promotionEntityFamilyValues,
  promotionFamilyInitialDigest,
  promotionManifestV2RootDigest,
  promotionManifestV2Schema,
  promotionSnapshotFamilyDigests,
  respondHRARunInteractionRequestSchema,
  sessionSyncHttpRoutes,
  serializedHRAPromotionRequestBytes,
  startHRAPromotionRequestSchema,
  type PromotionEntity,
} from "./index";

const LOCATOR = "0123456789ABCDEFGHJKMNPQRS";
const OTHER_LOCATOR = "1123456789ABCDEFGHJKMNPQRS";
const WORKSPACE_ID = `wsp_${LOCATOR}`;
const OTHER_WORKSPACE_ID = `wsp_${OTHER_LOCATOR}`;
const TASK_ID = `tsk_${LOCATOR}`;
const PROMOTION_ID = `promotion_${LOCATOR}`;
const OPERATION_ID = `op_${LOCATOR}`;
const CURSOR_TOKEN = "kitchen_cursor_v1_0123456789ABCDEFGHJKMNPQRS";

const task = {
  id: TASK_ID,
  key: "KIT-123ABCD",
  title: "Make soup",
  type: "task" as const,
  priority: 2,
  availableAt: 1,
  isReady: true,
  unresolvedBlockerCount: 0,
  cancelledBlockerCount: 0,
  revision: 1,
  reviewRevision: 1,
  createdAt: 1,
  updatedAt: 1,
  status: "open" as const,
};

const detail = {
  workspaceId: WORKSPACE_ID,
  projectionRevision: 7,
  task,
  description: "Use vegetables.",
  labels: ["hra"],
  parent: null,
  blockers: [],
  dependents: [],
  children: [],
  comments: [],
  events: [],
  references: [],
  runs: [],
  submission: null,
  recoveries: [],
  truncatedCollections: [],
};

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

function compactManifest() {
  const entities = [workspaceEntity, executorEntity];
  const header = {
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
    ...header,
    rootDigest: promotionManifestV2RootDigest(header),
  });
}

function completedPromotionProgress() {
  const manifest = compactManifest();
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

describe("dedicated HRA human HTTP contract", () => {
  test("treats assigned as any assigned task unless an exact agent is supplied", () => {
    expect(listHRATasksQuerySchema.parse({
      view: "assigned",
      limit: "50",
    })).toEqual({ view: "assigned", limit: 50 });
    expect(listHRATasksQuerySchema.parse({
      view: "assigned",
      assignedAgentId: "agent_primary",
      limit: "50",
    })).toEqual({
      view: "assigned",
      assignedAgentId: "agent_primary",
      limit: 50,
    });
    expect(listHRATasksQuerySchema.safeParse({
      view: "all",
      assignedAgentId: "agent_primary",
      limit: "50",
    }).success).toBeFalse();

    expect(hraProjectionCursorSchema.safeParse({
      version: 1,
      token: CURSOR_TOKEN,
      workspaceId: WORKSPACE_ID,
      projectionHead: 7,
      scope: { kind: "task_list", view: "assigned" },
    }).success).toBeTrue();
  });

  test("covers every shared human action without accepting plaintext HITL", () => {
    expect(hraHumanMutationKindValues).toEqual([
      "workspace.rename",
      "task.create",
      "task.create_and_run",
      "task.update",
      "task.cancel",
      "task.reopen",
      "task.assign",
      "task.defer",
      "task.parent_set",
      "task.parent_clear",
      "task.label_add",
      "task.label_remove",
      "task.comment_add",
      "task.reference_add",
      "task.reference_remove",
      "dependency.add",
      "dependency.remove",
      "review.accept",
      "review.reject",
      "dispatch.stop",
      "dispatch.retry",
      "dispatch.resolve_ambiguity",
    ]);
    const rename = {
      operationId: OPERATION_ID,
      expectedWorkspaceRevision: 2,
      kind: "workspace.rename" as const,
      name: "Renamed HRA",
    };
    expect(hraHumanMutationIntentSchema.parse(rename)).toEqual(rename);
    expect(hraHumanMutationIntentSchema.safeParse({
      operationId: OPERATION_ID,
      expectedWorkspaceRevision: 2,
      kind: "interaction.respond",
      authority: { kind: "human", userId: "user" },
    }).success).toBeFalse();
  });

  test("parses only exact method-aware routes and builds safe public-ID paths", () => {
    expect(parseHRAHumanRoute({
      method: "GET",
      pathname: hraHumanApiRoutes.workspace(WORKSPACE_ID),
    })).toEqual({ operation: "get_workspace", workspaceId: WORKSPACE_ID });
    expect(parseHRAHumanRoute({
      method: "GET",
      pathname: hraHumanApiRoutes.taskLookup(WORKSPACE_ID),
    })).toEqual({ operation: "lookup_task", workspaceId: WORKSPACE_ID });
    expect(parseHRAHumanRoute({
      method: "GET",
      pathname: hraHumanApiRoutes.task(WORKSPACE_ID, TASK_ID),
    })).toEqual({
      operation: "get_task",
      workspaceId: WORKSPACE_ID,
      taskId: TASK_ID,
    });
    expect(parseHRAHumanRoute({
      method: "GET",
      pathname: hraHumanApiRoutes.interactionReplyAuthority(
        WORKSPACE_ID,
        "run_primary0001",
        "interaction_primary0001",
      ),
    })).toEqual({
      operation: "get_interaction_reply_authority",
      workspaceId: WORKSPACE_ID,
      runId: "run_primary0001",
      interactionId: "interaction_primary0001",
    });
    expect(parseHRAHumanRoute({
      method: "POST",
      pathname: hraHumanApiRoutes.interactionResponse(
        WORKSPACE_ID,
        "run_primary0001",
        "interaction_primary0001",
      ),
    })).toEqual({
      operation: "respond_interaction",
      workspaceId: WORKSPACE_ID,
      runId: "run_primary0001",
      interactionId: "interaction_primary0001",
    });
    expect(parseHRAHumanRoute({
      method: "POST",
      pathname: hraHumanApiRoutes.interactionReplyAuthority(
        WORKSPACE_ID,
        "run_primary0001",
        "interaction_primary0001",
      ),
    })).toBeNull();
    expect(parseHRAHumanRoute({
      method: "POST",
      pathname: hraHumanApiRoutes.task(WORKSPACE_ID, TASK_ID),
    })).toBeNull();
    expect(parseHRAHumanRoute({
      method: "GET",
      pathname: `${hraHumanApiRoutes.workspace(WORKSPACE_ID)}/unknown`,
    })).toBeNull();
    expect(() => hraHumanApiRoutes.workspace("../secret")).toThrow();
  });

  test("emits HRA paths and accepts exact OPRTE and Kitchen aliases", () => {
    expect(hraHumanApiRoutes.workspaces).toBe("/v1/hra/workspaces");
    expect(parseHRAHumanRoute({
      method: "GET",
      pathname: legacyOprteHumanApiRoutes.workspace(WORKSPACE_ID),
    })).toEqual({ operation: "get_workspace", workspaceId: WORKSPACE_ID });
    expect(parseHRAHumanRoute({
      method: "GET",
      pathname: legacyKitchenHumanApiRoutes.workspace(WORKSPACE_ID),
    })).toEqual({ operation: "get_workspace", workspaceId: WORKSPACE_ID });
    expect(legacyPredecessorHumanApiRoutes).toBe(legacyKitchenHumanApiRoutes);
    expect(parseHRAHumanRoute({
      method: "GET",
      pathname: `${legacyKitchenHumanApiRoutes.workspace(WORKSPACE_ID)}/unknown`,
    })).toBeNull();
  });

  test("binds lookup and detail responses to workspace, task, key, and head", () => {
    const response = {
      workspaceId: WORKSPACE_ID,
      taskId: TASK_ID,
      projectionHead: 7,
      detail,
    };
    expect(getHRATaskResponseSchema.parse(response)).toEqual(response);
    expect(getHRATaskResponseSchema.safeParse({
      ...response,
      workspaceId: OTHER_WORKSPACE_ID,
    }).success).toBeFalse();
    expect(getHRATaskResponseSchema.safeParse({
      ...response,
      projectionHead: 8,
    }).success).toBeFalse();
    expect(lookupHRATaskResponseSchema.safeParse({
      workspaceId: WORKSPACE_ID,
      projectionHead: 7,
      key: task.key,
      task: {
        id: TASK_ID,
        key: "KIT-7654321",
        priority: 2,
        revision: 1,
        status: "open",
        title: "Other",
      },
    }).success).toBeFalse();
  });

  test("binds immutable list cursors and invalidations to one projection head", () => {
    const cursor = hraProjectionCursorSchema.parse({
      version: 1,
      token: CURSOR_TOKEN,
      workspaceId: WORKSPACE_ID,
      projectionHead: 7,
      scope: { kind: "task_list", view: "all" },
    });
    const page = {
      workspaceId: WORKSPACE_ID,
      view: "all" as const,
      projectionRevision: 7,
      items: [{ humanInput: null, run: null, task }],
      cursor: CURSOR_TOKEN,
      hasMore: true,
    };
    expect(listHRATasksResponseSchema.safeParse({ page, cursor }).success)
      .toBeTrue();
    expect(listHRATasksResponseSchema.safeParse({
      page,
      cursor: { ...cursor, projectionHead: 8 },
    }).success).toBeFalse();

    const invalidationPage = {
      workspaceId: WORKSPACE_ID,
      afterProjectionHead: 5,
      projectionHead: 7,
      invalidations: [
        {
          workspaceId: WORKSPACE_ID,
          projectionRevision: 6,
          scope: "workspace" as const,
        },
        {
          workspaceId: WORKSPACE_ID,
          projectionRevision: 7,
          scope: "task_detail" as const,
          taskId: TASK_ID,
        },
      ],
      cursor: {
        version: 1 as const,
        token: CURSOR_TOKEN,
        workspaceId: WORKSPACE_ID,
        projectionHead: 7,
        scope: { kind: "invalidations" as const },
      },
      hasMore: true,
    };
    expect(pollHRAInvalidationsResponseSchema.safeParse(invalidationPage).success)
      .toBeTrue();
    expect(pollHRAInvalidationsResponseSchema.safeParse({
      ...invalidationPage,
      invalidations: [...invalidationPage.invalidations].reverse(),
    }).success).toBeFalse();
  });

  test("requires HITL response plaintext to stay inside the sealed ciphertext", () => {
    const request = {
      operationId: OPERATION_ID,
      workspaceId: WORKSPACE_ID,
      expectedWorkspaceRevision: 2,
      expectedProjectionHead: 7,
      requestDigest: `sha256_${"a".repeat(64)}`,
      sealedResponse: {
        version: 1 as const,
        algorithm: "P256-HKDF-SHA256-A256GCM" as const,
        keyId: `hitlkey_${"a".repeat(24)}`,
        workspaceId: WORKSPACE_ID,
        ephemeralPublicKey: "A".repeat(87),
        nonce: "A".repeat(16),
        ciphertext: "A".repeat(
          RUN_INTERACTION_SEALED_CIPHERTEXT_BASE64URL_CHARACTERS,
        ),
      },
    };
    expect(respondHRARunInteractionRequestSchema.safeParse(request).success)
      .toBeTrue();
    expect(respondHRARunInteractionRequestSchema.safeParse({
      ...request,
      response: { kind: "file_change_approval", approved: true },
    }).success).toBeFalse();
    expect(respondHRARunInteractionRequestSchema.safeParse({
      ...request,
      sealedResponse: {
        ...request.sealedResponse,
        workspaceId: OTHER_WORKSPACE_ID,
      },
    }).success).toBeFalse();
  });

  test("binds reply authority to the exact workspace, run, interaction, digest, and head", () => {
    const requestDigest = `sha256_${"a".repeat(64)}`;
    const response = {
      workspaceId: WORKSPACE_ID,
      runId: "run_primary0001",
      interactionId: "interaction_primary0001",
      requestDigest,
      projectionHead: 7,
      request: {
        id: "interaction_primary0001",
        kind: "file_change_approval" as const,
        scope: "once" as const,
        createdAt: 1_000,
        expiresAt: 61_000,
        reply: {
          version: 1 as const,
          algorithm: "P256-HKDF-SHA256-A256GCM" as const,
          keyId: `hitlkey_${"a".repeat(24)}`,
          publicKey: "A".repeat(87),
          runnerId: "runner_primary0001",
          bootId: "boot_primary000001",
          bootGeneration: 3,
          claimId: "claim_primary00001",
          claimFence: 7,
          requestDigest,
        },
      },
    };
    expect(
      getHRARunInteractionReplyAuthorityResponseSchema.parse(response),
    ).toEqual(response);
    for (const mismatch of [
      {
        ...response,
        interactionId: "interaction_secondary001",
      },
      {
        ...response,
        requestDigest: `sha256_${"b".repeat(64)}`,
      },
      {
        ...response,
        request: {
          ...response.request,
          reply: {
            ...response.request.reply,
            requestDigest: `sha256_${"b".repeat(64)}`,
          },
        },
      },
      {
        ...response,
        response: { kind: "file_change_approval", decision: "approve_once" },
      },
    ]) {
      expect(
        getHRARunInteractionReplyAuthorityResponseSchema.safeParse(mismatch)
          .success,
      ).toBeFalse();
    }
  });

  test("preserves the stable bearer classifier with credentials confined to headers", () => {
    for (const operation of Object.values(hraHumanApiOperations)) {
      expect(operation.authorization).toBe("oprte-human-bearer");
      expect(operation.credentials).toBe("authorization_header_only");
      expect(JSON.stringify(operation)).not.toContain("accessToken");
      expect(JSON.stringify(operation)).not.toContain("refreshToken");
    }
  });
});

describe("HRA session-sync HTTP routes", () => {
  test("emits HRA paths and retains only the exact OPRTE alias family", () => {
    expect(Object.values(sessionSyncHttpRoutes).every((path) =>
      path.startsWith("/v1/hra/session-sync/"))).toBeTrue();
    expect(Object.values(legacyOprteSessionSyncHttpRoutes).every((path) =>
      path.startsWith("/v1/oprte/session-sync/"))).toBeTrue();
    expect(Object.keys(sessionSyncHttpRoutes)).toEqual(
      Object.keys(legacyOprteSessionSyncHttpRoutes),
    );
    expect(JSON.stringify([
      sessionSyncHttpRoutes,
      legacyOprteSessionSyncHttpRoutes,
    ])).not.toContain("/v1/kitchen/session-sync/");
  });
});

describe("HRA promotion HTTP contract", () => {
  test("parses every promotion route and rejects method/path near misses", () => {
    expect(parseHRAPromotionRoute({
      method: "POST",
      pathname: hraPromotionApiRoutes.start,
    })).toEqual({ operation: "start" });
    for (const [operation, method, pathname] of [
      ["lookup", "GET", hraPromotionApiRoutes.lookup(PROMOTION_ID)],
      ["accept_batch", "POST", hraPromotionApiRoutes.batches(PROMOTION_ID)],
      ["activate", "POST", hraPromotionApiRoutes.activate(PROMOTION_ID)],
      ["abort", "POST", hraPromotionApiRoutes.abort(PROMOTION_ID)],
      ["list_receipts", "GET", hraPromotionApiRoutes.receipts(PROMOTION_ID)],
      ["advance_cleanup", "POST", hraPromotionApiRoutes.cleanup(PROMOTION_ID)],
      ["cleanup_status", "GET", hraPromotionApiRoutes.cleanupStatus(PROMOTION_ID)],
    ] as const) {
      expect(parseHRAPromotionRoute({ method, pathname })).toEqual({
        operation,
        promotionId: PROMOTION_ID,
      });
    }
    expect(parseHRAPromotionRoute({
      method: "GET",
      pathname: hraPromotionApiRoutes.batches(PROMOTION_ID),
    })).toBeNull();
    expect(parseHRAPromotionRoute({
      method: "GET",
      pathname: `${hraPromotionApiRoutes.lookup(PROMOTION_ID)}/extra`,
    })).toBeNull();
  });

  test("emits HRA paths and accepts exact OPRTE and Kitchen promotion aliases", () => {
    expect(hraPromotionApiRoutes.start).toBe("/v1/hra/promotions");
    expect(parseHRAPromotionRoute({
      method: "POST",
      pathname: legacyOprtePromotionApiRoutes.start,
    })).toEqual({ operation: "start" });
    expect(parseHRAPromotionRoute({
      method: "POST",
      pathname: legacyKitchenPromotionApiRoutes.start,
    })).toEqual({ operation: "start" });
    expect(parseHRAPromotionRoute({
      method: "GET",
      pathname: legacyKitchenPromotionApiRoutes.lookup(PROMOTION_ID),
    })).toEqual({ operation: "lookup", promotionId: PROMOTION_ID });
    expect(legacyPredecessorPromotionApiRoutes).toBe(legacyKitchenPromotionApiRoutes);
    expect(parseHRAPromotionRoute({
      method: "GET",
      pathname: `${legacyKitchenPromotionApiRoutes.lookup(PROMOTION_ID)}/extra`,
    })).toBeNull();
  });

  test("uses a compact secret-free start header", () => {
    const request = {
      organizationId: "org_cloud",
      manifest: compactManifest(),
    };
    expect(startHRAPromotionRequestSchema.parse(request)).toEqual(request);
    expect(startHRAPromotionRequestSchema.safeParse({
      ...request,
      accessToken: "secret",
    }).success).toBeFalse();
    expect(JSON.stringify(request)).not.toContain("taskIds");
    expect(serializedHRAPromotionRequestBytes(request))
      .toBeLessThan(HRA_PROMOTION_MAX_REQUEST_BYTES);
  });

  test("carries bounded pre-activation rejection distinctly from ambiguity", () => {
    const rejected = {
      ok: true as const,
      data: {
        promotion: {
          schemaVersion: 2 as const,
          state: "rejected" as const,
          rejectionCode: "family_digest_mismatch" as const,
          promotionId: PROMOTION_ID,
          manifest: compactManifest(),
          stagingWorkspaceId: OTHER_WORKSPACE_ID,
          localWritable: false as const,
          progress: completedPromotionProgress(),
        },
      },
      requestId: "req_00000000000000000000000000",
    };

    expect(lookupHRAPromotionEnvelopeSchema.parse(rejected)).toEqual(
      rejected,
    );
    expect(lookupHRAPromotionEnvelopeSchema.safeParse({
      ...rejected,
      data: {
        promotion: {
          ...rejected.data.promotion,
          state: "outcome_unknown",
        },
      },
    }).success).toBeFalse();
  });

  test("enforces both the 500-item and portable 512 KiB batch bounds", () => {
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const locator = (index: number): string => {
      const high = alphabet[Math.floor(index / alphabet.length)] ?? "0";
      const low = alphabet[index % alphabet.length] ?? "0";
      return `${"0".repeat(24)}${high}${low}`;
    };
    const items = Array.from({ length: 40 }, (_, index) => ({
      family: "comments" as const,
      id: `cmt_${locator(index)}`,
      taskId: TASK_ID,
      body: "x".repeat(15_000),
      authorProvenance: "local_owner" as const,
      createdAt: index + 1,
    }));
    const batchFields = {
      schemaVersion: 2 as const,
      promotionId: PROMOTION_ID,
      batchId: `batch_${LOCATOR}`,
      family: "comments" as const,
      ordinal: 0,
      previousFamilyCount: 0,
      previousFamilyDigest: promotionFamilyInitialDigest("comments"),
      previousEntityIdentity: null,
      items,
    };
    const request = {
      batch: {
        ...batchFields,
        requestDigest: promotionBatchV2RequestDigest(batchFields),
      },
    };
    expect(serializedHRAPromotionRequestBytes(request))
      .toBeGreaterThan(HRA_PROMOTION_MAX_REQUEST_BYTES);
    expect(acceptHRAPromotionBatchRequestSchema.safeParse(request).success)
      .toBeFalse();
    expect(hraPromotionApiOperations.acceptBatch.maxItems).toBe(500);
    expect(hraPromotionApiOperations.acceptBatch.maxRequestBytes)
      .toBe(HRA_PROMOTION_MAX_REQUEST_BYTES);
  }, 20_000);

  test("keeps promotion authorization in the human bearer header", () => {
    for (const operation of Object.values(hraPromotionApiOperations)) {
      expect(operation.authorization).toBe("oprte-human-bearer");
      expect(operation.credentials).toBe("authorization_header_only");
    }
  });
});
