import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  HRA_PROMOTION_MAX_REQUEST_BYTES,
  taskDomain,
  type PromotionEntity,
} from "@hraness/agent-tasks-protocol";
import { assertProperty, fc } from "@hra-internal/test";

import { applyMigrations } from "../src/state/database";
import { LocalPromotionV2Store } from "../src/state/local-promotion-v2-store";
import { LocalTaskStore } from "../src/state/local-task-store";

const INSTALLATION_ID = "install_promotion_property";
const WORKSPACE_ID = "wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const STAGING_WORKSPACE_ID = "wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const REPOSITORY_ID = "repo_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TASK_ID = "tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROMOTION_ID = "promotion_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function seedFixtureDatabase(database: Database): void {
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  const tasks = new LocalTaskStore(database, new Uint8Array(32).fill(0x81));
  tasks.registerInstallation(INSTALLATION_ID, 1);
  tasks.onboardProject({
    installationId: INSTALLATION_ID,
    repository: {
      repositoryId: REPOSITORY_ID,
      name: "Promotion property repository",
      provider: "github",
      publicUrl: "https://github.com/example/promotion-property.git",
      canonicalRepositoryPath: "/private/promotion-property",
      canonicalGitCommonDir: "/private/promotion-property/.git",
    },
    workspace: {
      workspaceId: WORKSPACE_ID,
      name: "Promotion property",
      slug: "promotion-property",
      keyPrefix: "PPR",
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
    name: "Promotion property frozen",
  }, undefined, 3);
  const promotions = new LocalPromotionV2Store(database);
  promotions.freezeSourceSnapshot({
    workspaceId: WORKSPACE_ID,
    promotionId: PROMOTION_ID,
    destinationOrganizationId: "org_destination",
    now: 4,
  });
}

function createFixtureDatabase(): Uint8Array {
  const database = new Database(":memory:", { strict: true });
  try {
    seedFixtureDatabase(database);
    return database.serialize();
  } finally {
    database.close();
  }
}

const pristineFixtureDatabase = createFixtureDatabase();

function fixture() {
  const database = Database.deserialize(
    pristineFixtureDatabase.slice(),
    { strict: true },
  );
  database.exec("PRAGMA foreign_keys = ON");
  return { database, promotions: new LocalPromotionV2Store(database) };
}

function locator(indexValue: number): string {
  let index = BigInt(indexValue);
  let result = "";
  for (let position = 0; position < 26; position += 1) {
    result = (CROCKFORD[Number(index & 31n)] ?? "0") + result;
    index >>= 5n;
  }
  return result;
}

function syntheticComments(
  count: number,
  bodyLength: number,
): readonly PromotionEntity[] {
  return Array.from({ length: count }, (_, index) =>
    taskDomain.promotionEntitySchema.parse({
      family: "comments",
      id: `cmt_${locator(index + 1)}`,
      taskId: TASK_ID,
      body: `${String(index).padStart(6, "0")}:${
        "x".repeat(Math.max(1, bodyLength - 7))
      }`,
      authorProvenance: "local_owner",
      createdAt: index + 1,
    }));
}

function replaceSyntheticCommentFamily(
  database: Database,
  promotions: LocalPromotionV2Store,
  comments: readonly PromotionEntity[],
): void {
  const current = promotions.manifest(PROMOTION_ID);
  const counts = {
    ...current.counts,
    comments: comments.length,
  };
  const familyDigests = {
    ...current.familyDigests,
    comments: taskDomain.promotionFamilyDigest("comments", comments),
  };
  const digestInput = {
    ...current,
    counts,
    familyDigests,
  };
  const manifest = taskDomain.promotionManifestV2Schema.parse({
    ...digestInput,
    rootDigest: taskDomain.promotionManifestV2RootDigest(digestInput),
  });
  const insert = database.query(`
    INSERT INTO local_promotion_snapshot_entities (
      promotion_id, family, family_ordinal, entity_identity,
      entity_json, serialized_bytes
    ) VALUES (?1, 'comments', ?2, ?3, ?4, ?5)
  `);
  let serializedBytes = 0;
  for (const [ordinal, entity] of comments.entries()) {
    const source = taskDomain.canonicalPromotionJson(entity);
    const bytes = new TextEncoder().encode(source).byteLength;
    serializedBytes += bytes;
    insert.run(
      PROMOTION_ID,
      ordinal,
      taskDomain.promotionEntityIdentity(entity),
      source,
      bytes,
    );
  }
  database.query(`
    UPDATE local_promotion_manifests_v2
    SET manifest_json = ?2, entity_count = ?3,
      serialized_entity_bytes = serialized_entity_bytes + ?4
    WHERE promotion_id = ?1
  `).run(
    PROMOTION_ID,
    taskDomain.canonicalPromotionJson(manifest),
    Object.values(manifest.counts).reduce((sum, value) => sum + value, 0),
    serializedBytes,
  );
  database.query(`
    UPDATE local_promotion_family_progress_v2
    SET snapshot_count = ?2, snapshot_digest = ?3,
      snapshot_last_identity = ?4, complete = ?5
    WHERE promotion_id = ?1 AND family = 'comments'
  `).run(
    PROMOTION_ID,
    comments.length,
    manifest.familyDigests.comments,
    comments.length === 0
      ? null
      : taskDomain.promotionEntityIdentity(
          comments[comments.length - 1] as PromotionEntity,
        ),
    comments.length === 0 ? 1 : 0,
  );
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

describe("local promotion v2 storage properties", () => {
  test("every prepared batch remains within both portable boundaries", () => {
    const { database, promotions } = fixture();
    try {
      const comments = syntheticComments(501, 32);
      replaceSyntheticCommentFamily(database, promotions, comments);
      promotions.markStarting(PROMOTION_ID, 5);
      promotions.recordStart(PROMOTION_ID, {
        promotionId: PROMOTION_ID,
        stagingWorkspaceId: STAGING_WORKSPACE_ID,
        state: "receiving",
      }, 6);
      const counts = emptyCounts();
      const commentBatchSizes: number[] = [];
      for (let now = 10; ; now += 1) {
        const prepared = promotions.prepareNextBatch(PROMOTION_ID, now);
        if (prepared === null) break;
        expect(prepared.batch.items.length).toBeLessThanOrEqual(500);
        expect(prepared.serializedBytes).toBeLessThanOrEqual(
          HRA_PROMOTION_MAX_REQUEST_BYTES,
        );
        if (prepared.batch.family === "comments") {
          commentBatchSizes.push(prepared.batch.items.length);
        }
        const advanced = taskDomain.advancePromotionFamilyDigest(
          prepared.batch.family,
          {
            count: prepared.batch.previousFamilyCount,
            digest: prepared.batch.previousFamilyDigest,
            lastEntityIdentity: prepared.batch.previousEntityIdentity,
          },
          prepared.batch.items,
        );
        counts[prepared.batch.family] = advanced.count;
        promotions.recordBatchAcceptance(
          prepared.batch,
          taskDomain.promotionBatchReceiptV2Schema.parse({
            schemaVersion: 2,
            promotionId: PROMOTION_ID,
            batchId: prepared.batch.batchId,
            family: prepared.batch.family,
            ordinal: prepared.batch.ordinal,
            itemCount: prepared.batch.items.length,
            requestDigest: prepared.batch.requestDigest,
            acceptedRequestDigest: prepared.batch.requestDigest,
            previousFamilyCount: prepared.batch.previousFamilyCount,
            previousFamilyDigest: prepared.batch.previousFamilyDigest,
            cumulativeFamilyCount: advanced.count,
            cumulativeFamilyDigest: advanced.digest,
            lastEntityIdentity: advanced.lastEntityIdentity,
            acceptedAt: now,
            cumulativeCounts: { ...counts },
          }),
        );
      }
      expect(commentBatchSizes.length).toBeGreaterThan(1);
      expect(Math.max(...commentBatchSizes)).toBe(500);
      expect(commentBatchSizes.reduce((sum, value) => sum + value, 0)).toBe(
        501,
      );
      expect(promotions.progress(PROMOTION_ID)).toMatchObject({
        preparedEntityCount: 504,
        acceptedEntityCount: 504,
      });
    } finally {
      database.close();
    }
  });

  test("backoff is deterministic, exponential, and capped for arbitrary fault counts", () => {
    assertProperty(
      fc.property(fc.integer({ min: 0, max: 30 }), (faultCount) => {
        const { database, promotions } = fixture();
        try {
          for (let index = 0; index < faultCount; index += 1) {
            promotions.scheduleFault({
              promotionId: PROMOTION_ID,
              code: "transport_offline",
              nextAttemptAt: null,
              now: 100 + index,
            });
          }
          const now = 1_000;
          const expectedDelay = Math.min(
            60_000,
            500 * 2 ** Math.min(faultCount, 7),
          );
          expect(promotions.nextBackoffAt(PROMOTION_ID, now)).toBe(
            now + expectedDelay,
          );
        } finally {
          database.close();
        }
      }),
      { numRuns: 20 },
    );
  });

  test("the 500k progress projection remains a fixed-size manifest plus 15 rows", () => {
    const { database, promotions } = fixture();
    try {
      const current = promotions.manifest(PROMOTION_ID);
      const counts = {
        ...current.counts,
        comments: 499_997,
      };
      const familyDigests = {
        ...current.familyDigests,
        comments: `sha256_${"a".repeat(64)}`,
      };
      const digestInput = { ...current, counts, familyDigests };
      const manifest = taskDomain.promotionManifestV2Schema.parse({
        ...digestInput,
        rootDigest: taskDomain.promotionManifestV2RootDigest(digestInput),
      });
      database.query(`
        UPDATE local_promotion_manifests_v2
        SET manifest_json = ?2, entity_count = 500000
        WHERE promotion_id = ?1
      `).run(PROMOTION_ID, taskDomain.canonicalPromotionJson(manifest));
      database.query(`
        UPDATE local_promotion_family_progress_v2
        SET snapshot_count = 499997, snapshot_digest = ?2,
          snapshot_last_identity = 'cmt_maximum', complete = 0
        WHERE promotion_id = ?1 AND family = 'comments'
      `).run(PROMOTION_ID, manifest.familyDigests.comments);

      const progress = promotions.progress(PROMOTION_ID);
      expect(progress.preparedEntityCount).toBe(500_000);
      expect(progress.families).toHaveLength(15);
      expect(JSON.stringify(progress).length).toBeLessThan(10_000);
      expect(database.query<{ count: number }, []>(`
        SELECT count(*) AS count
        FROM local_promotion_family_progress_v2
      `).get()?.count).toBe(15);
      expect(database.query<{ bytes: number }, []>(`
        SELECT length(manifest_json) AS bytes
        FROM local_promotion_manifests_v2
      `).get()?.bytes).toBeLessThan(4_096);
    } finally {
      database.close();
    }
  });
});
