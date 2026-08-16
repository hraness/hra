import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { taskDomain } from "@hraness/agent-tasks-protocol";
import { applyMigrations } from "../src/state/database";
import {
  LocalPromotionConflict,
  LocalPromotionStore,
} from "../src/state/local-promotion-store";
import { LocalTaskStore } from "../src/state/local-task-store";

const INSTALLATION_ID = "install_promotion_test";
const WORKSPACE_ID = "wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const DESTINATION_ID = "wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const REPOSITORY_ID = "repo_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROMOTION_ID = "promotion_01ARZ3NDEKTSV4RRFFQ69G5FAV";

function counts(overrides: Readonly<Record<string, number>> = {}) {
  return taskDomain.promotionEntityCountsSchema.parse(Object.fromEntries(
    taskDomain.promotionEntityFamilyValues.map((family) =>
      [family, overrides[family] ?? 0]),
  ));
}

function fixture() {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  const tasks = new LocalTaskStore(database, new Uint8Array(32).fill(0x55));
  tasks.registerInstallation(INSTALLATION_ID, 1);
  tasks.onboardProject({
    installationId: INSTALLATION_ID,
    repository: {
      repositoryId: REPOSITORY_ID,
      name: "Private offline project",
      canonicalRepositoryPath: "/Users/local/private",
      canonicalGitCommonDir: "/Users/local/private/.git",
    },
    workspace: {
      workspaceId: WORKSPACE_ID,
      name: "Promotion source",
      slug: "promotion-source",
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
    name: "Promotion source frozen",
  }, undefined, 3);
  const entities = [
    {
      family: "workspace_metadata",
      workspaceId: WORKSPACE_ID,
      name: "Promotion source frozen",
      slug: "promotion-source",
      keyPrefix: "PRO",
    },
    {
      family: "executors",
      workspaceId: WORKSPACE_ID,
      executor: "local_codex",
      enabled: true,
    },
  ] as const;
  const baseManifest = {
    schemaVersion: 1,
    promotionId: PROMOTION_ID,
    sourceWorkspaceId: WORKSPACE_ID,
    sourceWorkspaceRevision: 2,
    sourceEventSequence: 1,
    createdAt: 4,
    rootDigest: `sha256_${"0".repeat(64)}`,
    counts: counts({ workspace_metadata: 1, executors: 1 }),
    repositoryIds: [],
    taskIds: [],
    terminalLocalWork: {
      queuedIntents: 0,
      activeClaims: 0,
      nonterminalRuns: 0,
      openInteractions: 0,
    },
  } as const;
  const rootDigest = taskDomain.promotionSnapshotRootDigest({
    manifest: taskDomain.promotionManifestSchema.parse(baseManifest),
    entities: entities.map((entity) => taskDomain.promotionEntitySchema.parse(entity)),
  });
  const snapshot = taskDomain.promotionSnapshotSchema.parse({
    manifest: { ...baseManifest, rootDigest },
    entities,
  });
  return {
    database,
    promotions: new LocalPromotionStore(database),
    snapshot,
  };
}

describe("local promotion durability", () => {
  test("freezes a strict path-free snapshot and replays the same session", () => {
    const { database, promotions, snapshot } = fixture();
    try {
      const first = promotions.freezeSnapshot({
        snapshot,
        destinationOrganizationId: "org_destination",
        now: 4,
      });
      expect(first).toMatchObject({
        state: "promoting",
        localWritable: false,
        promotionId: PROMOTION_ID,
      });
      expect(promotions.freezeSnapshot({
        snapshot,
        destinationOrganizationId: "org_destination",
        now: 9,
      })).toEqual(first);
      const stored = database.query<{
        manifest_json: string;
        snapshot_json: string;
      }, []>(`
        SELECT manifest_json, snapshot_json FROM local_promotion_manifests
      `).get();
      expect(JSON.stringify(stored)).not.toContain("/Users/local/private");
      expect(JSON.stringify(stored)).not.toContain("canonical");
      expect(database.query<{ authority_kind: string; authority_phase: string }, []>(`
        SELECT authority_kind, authority_phase FROM local_workspaces
      `).get()).toEqual({
        authority_kind: "promoting",
        authority_phase: "snapshot_frozen",
      });
    } finally {
      database.close();
    }
  });

  test("keeps cumulative batch receipts exact and activates once", () => {
    const { database, promotions, snapshot } = fixture();
    try {
      promotions.freezeSnapshot({
        snapshot,
        destinationOrganizationId: "org_destination",
        now: 4,
      });
      promotions.markStaging({
        promotionId: PROMOTION_ID,
        stagingWorkspaceId: DESTINATION_ID,
        now: 5,
      });
      const metadataEntity = snapshot.entities[0];
      const executorEntity = snapshot.entities[1];

      if (
        metadataEntity?.family !== "workspace_metadata" ||
        executorEntity?.family !== "executors"
      ) {
        throw new Error("expected the fixture to contain promotion families in order");
      }

      const metadataBatchBase = {
        promotionId: PROMOTION_ID,
        batchId: "batch_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        family: "workspace_metadata",
        ordinal: 0,
        items: [metadataEntity],
      } as const;
      const metadataBatch = taskDomain.promotionBatchSchema.parse({
        ...metadataBatchBase,
        requestDigest: taskDomain.promotionBatchRequestDigest(metadataBatchBase),
      });
      const metadataReceipt = taskDomain.promotionBatchReceiptSchema.parse({
        promotionId: PROMOTION_ID,
        batchId: metadataBatch.batchId,
        family: metadataBatch.family,
        ordinal: 0,
        itemCount: 1,
        requestDigest: metadataBatch.requestDigest,
        acceptedDigest: metadataBatch.requestDigest,
        acceptedAt: 6,
        cumulativeCounts: counts({ workspace_metadata: 1 }),
      });
      promotions.recordBatchAcceptance({
        batch: metadataBatch,
        receipt: metadataReceipt,
      });

      const executorBatchBase = {
        promotionId: PROMOTION_ID,
        batchId: "batch_01ARZ3NDEKTSV4RRFFQ69G5FAW",
        family: "executors",
        ordinal: 0,
        items: [executorEntity],
      } as const;
      const executorBatch = taskDomain.promotionBatchSchema.parse({
        ...executorBatchBase,
        requestDigest: taskDomain.promotionBatchRequestDigest(executorBatchBase),
      });
      const executorReceipt = taskDomain.promotionBatchReceiptSchema.parse({
        promotionId: PROMOTION_ID,
        batchId: executorBatch.batchId,
        family: executorBatch.family,
        ordinal: 0,
        itemCount: 1,
        requestDigest: executorBatch.requestDigest,
        acceptedDigest: executorBatch.requestDigest,
        acceptedAt: 6,
        cumulativeCounts: counts({ workspace_metadata: 1, executors: 1 }),
      });
      const uploaded = promotions.recordBatchAcceptance({
        batch: executorBatch,
        receipt: executorReceipt,
      });
      expect(uploaded).toMatchObject({
        state: "promoting",
        acceptedBatchReceipts: [{ batchId: metadataBatch.batchId }, {
          batchId: executorBatch.batchId,
        }],
      });
      expect(promotions.recordBatchAcceptance({
        batch: executorBatch,
        receipt: executorReceipt,
      })).toEqual(uploaded);
      expect(() => promotions.recordBatchAcceptance({
        batch: executorBatch,
        receipt: { ...executorReceipt, acceptedAt: 8 },
      })).toThrow(LocalPromotionConflict);

      promotions.beginActivation(PROMOTION_ID, 8);
      const activation = {
        promotionId: PROMOTION_ID,
        sourceWorkspaceId: WORKSPACE_ID,
        destinationWorkspaceId: DESTINATION_ID,
        acceptedManifestRoot: snapshot.manifest.rootDigest,
        acceptedCounts: snapshot.manifest.counts,
        activatedAt: 9,
      };
      const promoted = promotions.recordActivation(activation);
      expect(promoted).toMatchObject({
        state: "promoted",
        activationReceipt: activation,
      });
      expect(promotions.recordActivation(activation)).toEqual(promoted);
      expect(database.query<{ authority_kind: string; cloud_workspace_id: string }, []>(`
        SELECT authority_kind, cloud_workspace_id FROM local_workspaces
      `).get()).toEqual({
        authority_kind: "cloud",
        cloud_workspace_id: DESTINATION_ID,
      });
    } finally {
      database.close();
    }
  });

  test("restores local writes only after a proven pre-activation abort", () => {
    const { database, promotions, snapshot } = fixture();
    try {
      promotions.freezeSnapshot({
        snapshot,
        destinationOrganizationId: "org_destination",
        now: 4,
      });
      expect(promotions.abortPreActivation({
        promotionId: PROMOTION_ID,
        provedAt: 5,
      })).toMatchObject({
        state: "aborted",
        localWritable: true,
      });
      expect(database.query<{ authority_kind: string }, []>(`
        SELECT authority_kind FROM local_workspaces
      `).get()?.authority_kind).toBe("local");
    } finally {
      database.close();
    }
  });
});
