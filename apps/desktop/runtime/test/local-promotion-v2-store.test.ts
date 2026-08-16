import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  taskDomain,
  type PromotionBatchReceiptV2,
  type PromotionBatchV2,
} from "@hraness/agent-tasks-protocol";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyMigrations } from "../src/state/database";
import {
  LocalPromotionError,
  type LocalPromotionFaultInjector,
} from "../src/promotion/contracts";
import { LocalPromotionV2Store } from "../src/state/local-promotion-v2-store";
import { LocalTaskStore } from "../src/state/local-task-store";

const INSTALLATION_ID = "install_promotion_v2";
const WORKSPACE_ID = "wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const STAGING_WORKSPACE_ID = "wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const CLOUD_WORKSPACE_ID = STAGING_WORKSPACE_ID;
const REPOSITORY_ID = "repo_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROMOTION_ID = "promotion_01ARZ3NDEKTSV4RRFFQ69G5FAV";

function fixture(input: Readonly<{
  database?: Database;
  publicUrl?: string | null;
  faultInjector?: LocalPromotionFaultInjector;
}> = {}) {
  const database = input.database ??
    new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  const tasks = new LocalTaskStore(database, new Uint8Array(32).fill(0x51));
  tasks.registerInstallation(INSTALLATION_ID, 1);
  tasks.onboardProject({
    installationId: INSTALLATION_ID,
    repository: {
      repositoryId: REPOSITORY_ID,
      name: "Portable repository",
      provider: "github",
      ...(input.publicUrl === null
        ? {}
        : {
            publicUrl: input.publicUrl ??
              "https://github.com/example/portable.git",
          }),
      canonicalRepositoryPath: "/Users/private/portable",
      canonicalGitCommonDir: "/Users/private/portable/.git",
    },
    workspace: {
      workspaceId: WORKSPACE_ID,
      name: "Portable source",
      slug: "portable-source",
      keyPrefix: "PRO",
    },
  }, 2);
  tasks.execute({
    kind: "workspace.rename",
    operationId: "op_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    authority: {
      kind: "local_owner",
      workspaceId: WORKSPACE_ID,
      installationId: INSTALLATION_ID,
    },
    expectedWorkspaceRevision: 1,
    name: "Portable source frozen",
  }, undefined, 3);
  return {
    database,
    promotions: new LocalPromotionV2Store(database, {
      ...(input.faultInjector === undefined
        ? {}
        : { faultInjector: input.faultInjector }),
    }),
    tasks,
  };
}

function freeze(promotions: LocalPromotionV2Store) {
  return promotions.freezeSourceSnapshot({
    workspaceId: WORKSPACE_ID,
    promotionId: PROMOTION_ID,
    destinationOrganizationId: "org_destination",
    now: 4,
  });
}

function emptyCounts(): Record<
  (typeof taskDomain.promotionEntityFamilyValues)[number],
  number
> {
  return Object.fromEntries(
    taskDomain.promotionEntityFamilyValues.map((family) => [family, 0]),
  ) as Record<
    (typeof taskDomain.promotionEntityFamilyValues)[number],
    number
  >;
}

function uploadAll(
  promotions: LocalPromotionV2Store,
): readonly PromotionBatchReceiptV2[] {
  const counts = emptyCounts();
  const receipts: PromotionBatchReceiptV2[] = [];
  for (let now = 10; ; now += 1) {
    const prepared = promotions.prepareNextBatch(PROMOTION_ID, now);
    if (prepared === null) break;
    const receipt = receiptFor(prepared.batch, counts, now);
    promotions.recordBatchAcceptance(prepared.batch, receipt);
    receipts.push(receipt);
  }
  return receipts;
}

function receiptFor(
  batch: PromotionBatchV2,
  counts: Record<
    (typeof taskDomain.promotionEntityFamilyValues)[number],
    number
  >,
  acceptedAt: number,
): PromotionBatchReceiptV2 {
  const advanced = taskDomain.advancePromotionFamilyDigest(
    batch.family,
    {
      count: batch.previousFamilyCount,
      digest: batch.previousFamilyDigest,
      lastEntityIdentity: batch.previousEntityIdentity,
    },
    batch.items,
  );
  counts[batch.family] = advanced.count;
  return taskDomain.promotionBatchReceiptV2Schema.parse({
    schemaVersion: 2,
    promotionId: PROMOTION_ID,
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
    lastEntityIdentity: advanced.lastEntityIdentity,
    acceptedAt,
    cumulativeCounts: { ...counts },
  });
}

function readyRemote(
  promotions: LocalPromotionV2Store,
  receipts: readonly PromotionBatchReceiptV2[],
) {
  const manifest = promotions.manifest(PROMOTION_ID);
  const families = Object.fromEntries(
    taskDomain.promotionEntityFamilyValues.map((family) => {
      const matching = receipts.filter((receipt) => receipt.family === family);
      const last = matching.at(-1);
      return [
        family,
        {
          family,
          acceptedBatchCount: matching.length,
          acceptedEntityCount: last?.cumulativeFamilyCount ?? 0,
          cumulativeDigest: last?.cumulativeFamilyDigest ??
            taskDomain.promotionFamilyInitialDigest(family),
          lastEntityIdentity: last?.lastEntityIdentity ?? null,
          complete: true,
        },
      ];
    }),
  );
  return taskDomain.workspacePromotionStateV2Schema.parse({
    schemaVersion: 2,
    promotionId: PROMOTION_ID,
    manifest,
    stagingWorkspaceId: STAGING_WORKSPACE_ID,
    localWritable: false,
    state: "ready",
    progress: {
      activeFamilyIndex: taskDomain.promotionEntityFamilyValues.length,
      receiptCount: receipts.length,
      acceptedEntityCount: Object.values(manifest.counts).reduce(
        (sum, count) => sum + count,
        0,
      ),
      families,
    },
  });
}

function activationReceipt(promotions: LocalPromotionV2Store) {
  const manifest = promotions.manifest(PROMOTION_ID);
  const base = taskDomain.promotionActivationReceiptV2DigestInputSchema.parse({
    schemaVersion: 2,
    issuer: "convex_promotion_authority",
    serverReceiptId: "promotion_receipt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    promotionId: PROMOTION_ID,
    sourceWorkspaceId: WORKSPACE_ID,
    destinationWorkspaceId: CLOUD_WORKSPACE_ID,
    acceptedManifestRoot: manifest.rootDigest,
    acceptedCounts: manifest.counts,
    acceptedFamilyDigests: manifest.familyDigests,
    decision: "activated",
    decisionSequence: 1,
    activatedAt: 100,
  });
  return taskDomain.promotionActivationReceiptV2Schema.parse({
    ...base,
    receiptDigest: taskDomain.promotionActivationReceiptV2Digest(base),
  });
}

function abortReceipt(
  promotions: LocalPromotionV2Store,
  stagingWorkspaceId = STAGING_WORKSPACE_ID,
) {
  const manifest = promotions.manifest(PROMOTION_ID);
  const base = taskDomain.promotionAbortReceiptV2DigestInputSchema.parse({
    schemaVersion: 2,
    issuer: "convex_promotion_authority",
    serverReceiptId: stagingWorkspaceId === STAGING_WORKSPACE_ID
      ? "promotion_receipt_01ARZ3NDEKTSV4RRFFQ69G5FAW"
      : "promotion_receipt_01ARZ3NDEKTSV4RRFFQ69G5FAX",
    promotionId: PROMOTION_ID,
    sourceWorkspaceId: WORKSPACE_ID,
    stagingWorkspaceId,
    manifestRoot: manifest.rootDigest,
    decision: "aborted_before_activation",
    decisionSequence: 1,
    abortedAt: 100,
  });
  return taskDomain.promotionAbortReceiptV2Schema.parse({
    ...base,
    receiptDigest: taskDomain.promotionAbortReceiptV2Digest(base),
  });
}

describe("local promotion v2 storage", () => {
  test("freezes a canonical path-free snapshot and exact compact progress", () => {
    const { database, promotions } = fixture();
    try {
      expect(promotions.progressForWorkspace(WORKSPACE_ID)).toBeNull();
      const progress = freeze(promotions);
      expect(progress).toMatchObject({
        phase: "snapshot_frozen",
        preparedEntityCount: 3,
        acceptedEntityCount: 0,
        localWritable: false,
      });
      expect(freeze(promotions)).toEqual(progress);
      expect(promotions.progressForWorkspace(WORKSPACE_ID)).toEqual(progress);
      const source = JSON.stringify(database.query(`
        SELECT manifest_json FROM local_promotion_manifests_v2
      `).get()) + JSON.stringify(database.query(`
        SELECT entity_json FROM local_promotion_snapshot_entities
      `).all());
      expect(source).not.toContain("/Users/private");
      expect(source).not.toContain("canonicalRepositoryPath");
      expect(source).not.toContain("accessToken");
      expect(promotions.authorityOverlay(WORKSPACE_ID)).toMatchObject({
        sourceLocalWorkspaceId: WORKSPACE_ID,
        sourceAccess: "frozen",
        authority: {
          kind: "promoting",
          phase: "snapshot_frozen",
        },
      });
      expect(database.query<{ authority_kind: string }, [string]>(`
        SELECT authority_kind FROM local_workspaces WHERE workspace_id = ?1
      `).get(WORKSPACE_ID)?.authority_kind).toBe("promoting");
    } finally {
      database.close();
    }
  });

  test("rejects repositories without a portable credential-free remote", () => {
    const { database, promotions } = fixture({ publicUrl: null });
    try {
      expect(() => freeze(promotions)).toThrow(LocalPromotionError);
      expect(() => freeze(promotions)).toThrow(
        "credential-free HTTPS remote",
      );
      expect(database.query(`
        SELECT promotion_id FROM local_promotion_sessions
        WHERE schema_version = 2
      `).get()).toBeNull();
      expect(database.query<{ authority_kind: string }, []>(`
        SELECT authority_kind FROM local_workspaces
      `).get()?.authority_kind).toBe("local");
    } finally {
      database.close();
    }
  });

  test("refuses to freeze while local execution work is live", () => {
    const { database, promotions, tasks } = fixture();
    try {
      tasks.execute({
        kind: "task.create_and_run",
        operationId: "op_01ARZ3NDEKTSV4RRFFQ69G5FAW",
        authority: {
          kind: "local_owner",
          workspaceId: WORKSPACE_ID,
          installationId: INSTALLATION_ID,
        },
        expectedWorkspaceRevision: 2,
        taskId: "tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        title: "Still queued locally",
        description: "",
        type: "task",
        priority: 2,
        availableAt: 0,
        labels: [],
        repositoryId: REPOSITORY_ID,
      }, undefined, 4);
      expect(() => promotions.freezeSourceSnapshot({
        workspaceId: WORKSPACE_ID,
        promotionId: PROMOTION_ID,
        destinationOrganizationId: "org_destination",
        now: 5,
      })).toThrow("Local work must finish");
      expect(database.query<{ authority_kind: string }, [string]>(`
        SELECT authority_kind FROM local_workspaces WHERE workspace_id = ?1
      `).get(WORKSPACE_ID)?.authority_kind).toBe("local");
    } finally {
      database.close();
    }
  });

  test("persists exact ordered receipts and switches authority only on proof", () => {
    const { database, promotions, tasks } = fixture();
    try {
      freeze(promotions);
      promotions.markStarting(PROMOTION_ID, 5);
      promotions.recordStart(PROMOTION_ID, {
        promotionId: PROMOTION_ID,
        stagingWorkspaceId: STAGING_WORKSPACE_ID,
        state: "receiving",
      }, 6);
      const receipts = uploadAll(promotions);
      expect(receipts).toHaveLength(3);
      expect(promotions.progress(PROMOTION_ID)).toMatchObject({
        acceptedEntityCount: 3,
        acceptedBatchCount: 3,
      });
      const remote = readyRemote(promotions, receipts);
      promotions.recordRemoteState(PROMOTION_ID, remote, 90);
      promotions.beginActivation(PROMOTION_ID, 91);
      const receipt = activationReceipt(promotions);
      const activated = promotions.recordActivation(receipt);
      expect(activated).toMatchObject({
        phase: "activated",
        recoveryCopyAvailable: true,
        runnerPairing: "pending",
      });
      expect(promotions.recordActivation(receipt)).toEqual(activated);
      expect(promotions.authorityOverlay(WORKSPACE_ID)).toEqual({
        sourceLocalWorkspaceId: WORKSPACE_ID,
        presentedWorkspaceId: CLOUD_WORKSPACE_ID,
        authority: {
          kind: "cloud",
          cloudWorkspaceId: CLOUD_WORKSPACE_ID,
        },
        sourceAccess: "read_only_recovery",
      });
      expect(promotions.progressForWorkspace(CLOUD_WORKSPACE_ID)).toEqual(
        activated,
      );
      expect(tasks.listWorkspaceSummaries(101)[0]).toMatchObject({
        id: CLOUD_WORKSPACE_ID,
        authority: {
          kind: "cloud",
          cloudWorkspaceId: CLOUD_WORKSPACE_ID,
        },
      });
      expect(database.query<{ count: number }, [string]>(`
        SELECT count(*) AS count FROM local_workspaces
        WHERE workspace_id = ?1
      `).get(WORKSPACE_ID)?.count).toBe(1);
      expect(database.query<{ count: number }, [string]>(`
        SELECT count(*) AS count FROM local_workspace_repositories
        WHERE workspace_id = ?1
      `).get(WORKSPACE_ID)?.count).toBe(1);
      expect(promotions.recoveryCopy(PROMOTION_ID)).toEqual({
        promotionId: PROMOTION_ID,
        localWorkspaceId: WORKSPACE_ID,
        cloudWorkspaceId: CLOUD_WORKSPACE_ID,
        access: "read_only",
        createdAt: 100,
        lastOpenedAt: null,
      });
      expect(promotions.recoveryReadAuthority({
        promotionId: PROMOTION_ID,
        localWorkspaceId: WORKSPACE_ID,
        cloudWorkspaceId: CLOUD_WORKSPACE_ID,
        access: "read_only",
        createdAt: 100,
        lastOpenedAt: null,
      })).toMatchObject({
        promotionId: PROMOTION_ID,
        localWorkspaceId: WORKSPACE_ID,
        cloudWorkspaceId: CLOUD_WORKSPACE_ID,
        access: "read_only",
      });
      expect(() => promotions.recoveryReadAuthority({
        promotionId: PROMOTION_ID,
        localWorkspaceId: WORKSPACE_ID,
        cloudWorkspaceId: "wsp_00000000000000000000000009",
        access: "read_only",
        createdAt: 100,
        lastOpenedAt: null,
      })).toThrow(LocalPromotionError);
      expect(() => promotions.markPairingState({
        cloudWorkspaceId: CLOUD_WORKSPACE_ID,
        promotionId: "promotion_01ARZ3NDEKTSV4RRFFQ69G5FAW",
        state: "paired",
        faultCode: null,
        now: 101,
      })).toThrow(LocalPromotionError);
      promotions.markPairingState({
        cloudWorkspaceId: CLOUD_WORKSPACE_ID,
        promotionId: PROMOTION_ID,
        state: "paired",
        faultCode: null,
        now: 102,
      });
      expect(promotions.progress(PROMOTION_ID).runnerPairing).toBe("paired");
      expect(promotions.runnerPairingsForInstallation(INSTALLATION_ID))
        .toEqual([
          expect.objectContaining({
            cloudWorkspaceId: CLOUD_WORKSPACE_ID,
            promotionId: PROMOTION_ID,
            sourceWorkspaceId: WORKSPACE_ID,
            installationId: INSTALLATION_ID,
            state: "paired",
          }),
        ]);
    } finally {
      database.close();
    }
  });

  test("accepts exact receipt replay and rejects conflicting replay", () => {
    const { database, promotions } = fixture();
    try {
      freeze(promotions);
      promotions.markStarting(PROMOTION_ID, 5);
      promotions.recordStart(PROMOTION_ID, {
        promotionId: PROMOTION_ID,
        stagingWorkspaceId: STAGING_WORKSPACE_ID,
        state: "receiving",
      }, 6);
      const prepared = promotions.prepareNextBatch(PROMOTION_ID, 10);
      if (prepared === null) throw new Error("expected a promotion batch");
      const counts = emptyCounts();
      const receipt = receiptFor(prepared.batch, counts, 10);
      const accepted = promotions.recordBatchAcceptance(
        prepared.batch,
        receipt,
      );
      expect(promotions.recordBatchAcceptance(prepared.batch, receipt)).toEqual(
        accepted,
      );
      expect(() => promotions.recordBatchAcceptance(prepared.batch, {
        ...receipt,
        acceptedAt: 11,
      })).toThrow("cloud receipt conflicts");
      expect(promotions.progress(PROMOTION_ID).acceptedBatchCount).toBe(1);
    } finally {
      database.close();
    }
  });

  test("rejects a receipt audit page that does not advance its cursor", () => {
    const { database, promotions } = fixture();
    try {
      freeze(promotions);
      promotions.markStarting(PROMOTION_ID, 5);
      promotions.recordStart(PROMOTION_ID, {
        promotionId: PROMOTION_ID,
        stagingWorkspaceId: STAGING_WORKSPACE_ID,
        state: "receiving",
      }, 6);
      const prepared = promotions.prepareNextBatch(PROMOTION_ID, 10);
      if (prepared === null) throw new Error("expected a promotion batch");
      promotions.markBatchInFlight(
        PROMOTION_ID,
        prepared.batch.batchId,
        11,
      );
      promotions.markBatchLostResponse(
        PROMOTION_ID,
        prepared.batch.batchId,
        12,
      );
      const cursor = "promotion_receipts_v1_page_one";
      expect(promotions.advanceReceiptAudit(
        PROMOTION_ID,
        prepared.batch.batchId,
        {
          promotionId: PROMOTION_ID,
          items: [],
          cursor,
          hasMore: true,
        },
        13,
      )).toBeNull();
      expect(() =>
        promotions.advanceReceiptAudit(
          PROMOTION_ID,
          prepared.batch.batchId,
          {
            promotionId: PROMOTION_ID,
            items: [],
            cursor,
            hasMore: true,
          },
          14,
        )
      ).toThrow(LocalPromotionError);
      expect(promotions.outstandingBatch(PROMOTION_ID)).toMatchObject({
        state: "lost_response",
        receiptAuditCursor: cursor,
      });
    } finally {
      database.close();
    }
  });

  test("durably rejects a longer receipt cursor cycle after restart", () => {
    const { database, promotions } = fixture();
    try {
      freeze(promotions);
      promotions.markStarting(PROMOTION_ID, 5);
      promotions.recordStart(PROMOTION_ID, {
        promotionId: PROMOTION_ID,
        stagingWorkspaceId: STAGING_WORKSPACE_ID,
        state: "receiving",
      }, 6);
      const prepared = promotions.prepareNextBatch(PROMOTION_ID, 10);
      if (prepared === null) throw new Error("expected a promotion batch");
      promotions.markBatchInFlight(PROMOTION_ID, prepared.batch.batchId, 11);
      promotions.markBatchLostResponse(PROMOTION_ID, prepared.batch.batchId, 12);
      const firstCursor = "promotion_receipts_v1_cycle_a";
      const secondCursor = "promotion_receipts_v1_cycle_b";
      expect(promotions.advanceReceiptAudit(
        PROMOTION_ID,
        prepared.batch.batchId,
        {
          promotionId: PROMOTION_ID,
          items: [],
          cursor: firstCursor,
          hasMore: true,
        },
        13,
      )).toBeNull();

      const restarted = new LocalPromotionV2Store(database);
      expect(restarted.advanceReceiptAudit(
        PROMOTION_ID,
        prepared.batch.batchId,
        {
          promotionId: PROMOTION_ID,
          items: [],
          cursor: secondCursor,
          hasMore: true,
        },
        14,
      )).toBeNull();
      expect(() =>
        restarted.advanceReceiptAudit(
          PROMOTION_ID,
          prepared.batch.batchId,
          {
            promotionId: PROMOTION_ID,
            items: [],
            cursor: firstCursor,
            hasMore: true,
          },
          15,
        )
      ).toThrow(LocalPromotionError);
      expect(restarted.outstandingBatch(PROMOTION_ID)).toMatchObject({
        state: "lost_response",
        receiptAuditCursor: secondCursor,
      });
    } finally {
      database.close();
    }
  });

  test("fails closed before receipt audit pagination exceeds its durable bound", () => {
    const { database, promotions } = fixture();
    try {
      freeze(promotions);
      promotions.markStarting(PROMOTION_ID, 5);
      promotions.recordStart(PROMOTION_ID, {
        promotionId: PROMOTION_ID,
        stagingWorkspaceId: STAGING_WORKSPACE_ID,
        state: "receiving",
      }, 6);
      const prepared = promotions.prepareNextBatch(PROMOTION_ID, 10);
      if (prepared === null) throw new Error("expected a promotion batch");
      promotions.markBatchInFlight(PROMOTION_ID, prepared.batch.batchId, 11);
      promotions.markBatchLostResponse(PROMOTION_ID, prepared.batch.batchId, 12);

      const currentCursor = "promotion_receipts_v1_bound_current";
      const currentFingerprint = createHash("sha256")
        .update(currentCursor)
        .digest("base64url")
        .slice(0, 22);
      const maxAuditPages = Math.ceil(
        taskDomain.MAX_PROMOTION_BATCH_RECEIPTS /
          taskDomain.MAX_PROMOTION_RECEIPT_PAGE_SIZE,
      );
      const cursorFingerprints = [
        ...Array.from(
          { length: maxAuditPages - 2 },
          (_, index) => String(index).padStart(22, "0"),
        ),
        currentFingerprint,
      ];
      database.query(`
        UPDATE local_promotion_sessions
        SET receipt_audit_cursor = ?2
        WHERE promotion_id = ?1
      `).run(PROMOTION_ID, JSON.stringify({
        version: 1,
        cursorFingerprints,
      }));
      database.query(`
        UPDATE local_promotion_outbound_batches_v2
        SET receipt_audit_cursor = ?3
        WHERE promotion_id = ?1 AND batch_id = ?2
      `).run(PROMOTION_ID, prepared.batch.batchId, currentCursor);
      expect(() =>
        promotions.advanceReceiptAudit(
          PROMOTION_ID,
          prepared.batch.batchId,
          {
            promotionId: PROMOTION_ID,
            items: [],
            cursor: "promotion_receipts_v1_bound_overflow",
            hasMore: true,
          },
          300,
        )
      ).toThrow(LocalPromotionError);
      expect(promotions.outstandingBatch(PROMOTION_ID)).toMatchObject({
        state: "lost_response",
        receiptAuditCursor: currentCursor,
      });

      expect(promotions.advanceReceiptAudit(
        PROMOTION_ID,
        prepared.batch.batchId,
        {
          promotionId: PROMOTION_ID,
          items: [],
          cursor: null,
          hasMore: false,
        },
        301,
      )).toBeNull();
      expect(promotions.outstandingBatch(PROMOTION_ID)).toMatchObject({
        state: "prepared",
        receiptAuditCursor: null,
      });
    } finally {
      database.close();
    }
  });

  test("restores local writes only for the exact bound abort proof", () => {
    const { database, promotions } = fixture();
    try {
      freeze(promotions);
      promotions.markStarting(PROMOTION_ID, 5);
      promotions.recordStart(PROMOTION_ID, {
        promotionId: PROMOTION_ID,
        stagingWorkspaceId: STAGING_WORKSPACE_ID,
        state: "receiving",
      }, 6);
      promotions.beginAbort(PROMOTION_ID, 7);
      const otherStaging = "wsp_01ARZ3NDEKTSV4RRFFQ69G5FAX";
      expect(() => promotions.recordAbort(
        abortReceipt(promotions, otherStaging),
      )).toThrow("abort proof");
      expect(promotions.authorityOverlay(WORKSPACE_ID).sourceAccess).toBe(
        "frozen",
      );
      expect(database.query<{ authority_kind: string }, [string]>(`
        SELECT authority_kind FROM local_workspaces WHERE workspace_id = ?1
      `).get(WORKSPACE_ID)?.authority_kind).toBe("promoting");

      expect(promotions.recordAbort(abortReceipt(promotions))).toMatchObject({
        phase: "aborted",
        localWritable: true,
      });
      expect(promotions.authorityOverlay(WORKSPACE_ID).sourceAccess).toBe(
        "read_write",
      );
    } finally {
      database.close();
    }
  });

  test("rolls back receipt and decision proof checkpoints atomically", () => {
    {
      const value = fixture({
        faultInjector: (checkpoint) => {
          if (checkpoint === "batch.after_receipt_before_progress") {
            throw new Error("crash");
          }
        },
      });
      try {
        freeze(value.promotions);
        value.promotions.markStarting(PROMOTION_ID, 5);
        value.promotions.recordStart(PROMOTION_ID, {
          promotionId: PROMOTION_ID,
          stagingWorkspaceId: STAGING_WORKSPACE_ID,
          state: "receiving",
        }, 6);
        const prepared = value.promotions.prepareNextBatch(PROMOTION_ID, 10);
        if (prepared === null) throw new Error("expected a promotion batch");
        const receipt = receiptFor(prepared.batch, emptyCounts(), 10);
        expect(() => value.promotions.recordBatchAcceptance(
          prepared.batch,
          receipt,
        )).toThrow("crash");
        expect(value.promotions.progress(PROMOTION_ID).acceptedBatchCount).toBe(
          0,
        );
        expect(value.database.query<{ count: number }, []>(`
          SELECT count(*) AS count
          FROM local_promotion_upload_receipts_v2
        `).get()?.count).toBe(0);
        expect(new LocalPromotionV2Store(value.database).recordBatchAcceptance(
          prepared.batch,
          receipt,
        ).acceptedBatchCount).toBe(1);
      } finally {
        value.database.close();
      }
    }

    {
      const value = fixture({
        faultInjector: (checkpoint) => {
          if (checkpoint === "activation.after_proof_before_authority") {
            throw new Error("crash");
          }
        },
      });
      try {
        freeze(value.promotions);
        value.promotions.markStarting(PROMOTION_ID, 5);
        value.promotions.recordStart(PROMOTION_ID, {
          promotionId: PROMOTION_ID,
          stagingWorkspaceId: STAGING_WORKSPACE_ID,
          state: "receiving",
        }, 6);
        const receipts = uploadAll(value.promotions);
        value.promotions.recordRemoteState(
          PROMOTION_ID,
          readyRemote(value.promotions, receipts),
          90,
        );
        value.promotions.beginActivation(PROMOTION_ID, 91);
        const receipt = activationReceipt(value.promotions);
        expect(() => value.promotions.recordActivation(receipt)).toThrow(
          "crash",
        );
        expect(value.database.query<{ count: number }, []>(`
          SELECT count(*) AS count
          FROM local_promotion_decision_proofs_v2
        `).get()?.count).toBe(0);
        expect(value.promotions.authorityOverlay(WORKSPACE_ID).sourceAccess)
          .toBe("frozen");
        expect(new LocalPromotionV2Store(value.database).recordActivation(
          receipt,
        ).phase).toBe("activated");
      } finally {
        value.database.close();
      }
    }

    {
      const value = fixture({
        faultInjector: (checkpoint) => {
          if (checkpoint === "abort.after_proof_before_authority") {
            throw new Error("crash");
          }
        },
      });
      try {
        freeze(value.promotions);
        value.promotions.markStarting(PROMOTION_ID, 5);
        value.promotions.recordStart(PROMOTION_ID, {
          promotionId: PROMOTION_ID,
          stagingWorkspaceId: STAGING_WORKSPACE_ID,
          state: "receiving",
        }, 6);
        value.promotions.beginAbort(PROMOTION_ID, 7);
        const receipt = abortReceipt(value.promotions);
        expect(() => value.promotions.recordAbort(receipt)).toThrow("crash");
        expect(value.database.query<{ count: number }, []>(`
          SELECT count(*) AS count
          FROM local_promotion_decision_proofs_v2
        `).get()?.count).toBe(0);
        expect(value.promotions.authorityOverlay(WORKSPACE_ID).sourceAccess)
          .toBe("frozen");
        expect(new LocalPromotionV2Store(value.database).recordAbort(
          receipt,
        ).phase).toBe("aborted");
      } finally {
        value.database.close();
      }
    }
  });

  test("rolls back every local snapshot checkpoint atomically", () => {
    for (const checkpoint of [
      "snapshot.after_read_before_persist",
      "snapshot.after_entities_before_authority",
    ] as const) {
      const { database, promotions } = fixture({
        faultInjector: (observed) => {
          if (observed === checkpoint) throw new Error("crash");
        },
      });
      try {
        expect(() => freeze(promotions)).toThrow("crash");
        expect(database.query(`
          SELECT promotion_id FROM local_promotion_sessions
          WHERE schema_version = 2
        `).get()).toBeNull();
        expect(database.query<{ authority_kind: string }, []>(`
          SELECT authority_kind FROM local_workspaces
        `).get()?.authority_kind).toBe("local");
      } finally {
        database.close();
      }
    }
  });

  test("holds the immediate write lock from source read through authority freeze", async () => {
    const root = await mkdtemp(join(tmpdir(), "oprte-promotion-freeze-"));
    const path = join(root, "control-plane.sqlite");
    const database = new Database(path, { create: true, strict: true });
    let writer: Database | null = null;
    let writeBlocked = false;
    const value = fixture({
      database,
      faultInjector: (checkpoint) => {
        if (checkpoint !== "snapshot.after_read_before_persist") return;
        if (writer === null) throw new Error("writer was not initialized");
        try {
          writer.query(`
            UPDATE local_workspaces SET name = 'raced'
            WHERE workspace_id = ?1
          `).run(WORKSPACE_ID);
        } catch {
          writeBlocked = true;
        }
      },
    });
    writer = new Database(path, { strict: true });
    writer.exec("PRAGMA busy_timeout = 0");
    try {
      freeze(value.promotions);
      expect(writeBlocked).toBeTrue();
      expect(database.query<{ name: string; authority_kind: string }, [string]>(`
        SELECT name, authority_kind FROM local_workspaces
        WHERE workspace_id = ?1
      `).get(WORKSPACE_ID)).toEqual({
        name: "Portable source frozen",
        authority_kind: "promoting",
      });
    } finally {
      writer.close();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
