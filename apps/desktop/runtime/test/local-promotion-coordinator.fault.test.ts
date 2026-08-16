import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  taskDomain,
  type AcceptHRAPromotionBatchRequest,
  type ActivateHRAPromotionRequest,
  type AdvanceHRAPromotionCleanupRequest,
  type PromotionBatchReceiptPage,
  type PromotionBatchReceiptV2,
  type PromotionCleanupProgress,
  type PromotionManifestV2,
  type StartHRAPromotionRequest,
  type WorkspacePromotionStateV2,
} from "@hraness/agent-tasks-protocol";

import { LocalPromotionCoordinator } from "../src/promotion/coordinator";
import type {
  LocalPromotionCoordinatorCheckpoint,
  LocalPromotionTransport,
  LocalPromotionTransportResult,
} from "../src/promotion/contracts";
import { applyMigrations } from "../src/state/database";
import { LocalPromotionV2Store } from "../src/state/local-promotion-v2-store";
import { LocalTaskStore } from "../src/state/local-task-store";

const INSTALLATION_ID = "install_promotion_faults";
const WORKSPACE_ID = "wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const STAGING_WORKSPACE_ID = "wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const REPOSITORY_ID = "repo_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROMOTION_ID = "promotion_01ARZ3NDEKTSV4RRFFQ69G5FAV";

function fixture() {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  const tasks = new LocalTaskStore(database, new Uint8Array(32).fill(0x62));
  tasks.registerInstallation(INSTALLATION_ID, 1);
  tasks.onboardProject({
    installationId: INSTALLATION_ID,
    repository: {
      repositoryId: REPOSITORY_ID,
      name: "Promotion fault repository",
      provider: "github",
      publicUrl: "https://github.com/example/faults.git",
      canonicalRepositoryPath: "/private/faults",
      canonicalGitCommonDir: "/private/faults/.git",
    },
    workspace: {
      workspaceId: WORKSPACE_ID,
      name: "Promotion faults",
      slug: "promotion-faults",
      keyPrefix: "PF",
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
    name: "Promotion faults frozen",
  }, undefined, 3);
  return {
    database,
    store: new LocalPromotionV2Store(database),
  };
}

class FakePromotionAuthority implements LocalPromotionTransport {
  manifest: PromotionManifestV2 | null = null;
  state:
    | "receiving"
    | "ready"
    | "rejected"
    | "outcome_unknown"
    | "activated"
    | "aborted" = "receiving";
  readonly receipts: PromotionBatchReceiptV2[] = [];
  cleanupDeleted = 0;
  cleanupTotal = 1_201;
  loseNextBatchResponse = false;
  loseNextActivationResponse = false;
  loseNextAbortResponse = false;
  startCalls = 0;
  batchCalls = 0;
  activationCalls = 0;
  abortCalls = 0;
  cleanupCalls = 0;

  start(
    request: StartHRAPromotionRequest,
  ): Promise<LocalPromotionTransportResult<Readonly<{
    promotionId: string;
    stagingWorkspaceId: string;
    state: "receiving";
  }>>> {
    this.startCalls += 1;
    if (
      this.manifest !== null &&
      taskDomain.canonicalPromotionJson(this.manifest) !==
        taskDomain.canonicalPromotionJson(request.manifest)
    ) {
      return Promise.resolve({ ok: false, kind: "rejected" });
    }
    this.manifest = request.manifest;
    return Promise.resolve({
      ok: true,
      value: {
        promotionId: request.manifest.promotionId,
        stagingWorkspaceId: STAGING_WORKSPACE_ID,
        state: "receiving",
      },
    });
  }

  acceptBatch(
    promotionId: string,
    request: AcceptHRAPromotionBatchRequest,
  ): Promise<LocalPromotionTransportResult<Readonly<{
    receipt: PromotionBatchReceiptV2;
  }>>> {
    this.batchCalls += 1;
    if (this.manifest === null || promotionId !== this.manifest.promotionId) {
      return Promise.resolve({ ok: false, kind: "not_found" });
    }
    const replay = this.receipts.find(
      (receipt) => receipt.batchId === request.batch.batchId,
    );
    if (replay !== undefined) {
      return Promise.resolve({ ok: true, value: { receipt: replay } });
    }
    const advanced = taskDomain.advancePromotionFamilyDigest(
      request.batch.family,
      {
        count: request.batch.previousFamilyCount,
        digest: request.batch.previousFamilyDigest,
        lastEntityIdentity: request.batch.previousEntityIdentity,
      },
      request.batch.items,
    );
    const cumulativeCounts = Object.fromEntries(
      taskDomain.promotionEntityFamilyValues.map((family) => {
        const prior = this.receipts.filter((receipt) => receipt.family === family)
          .at(-1)?.cumulativeFamilyCount ?? 0;
        return [
          family,
          family === request.batch.family ? advanced.count : prior,
        ];
      }),
    );
    const receipt = taskDomain.promotionBatchReceiptV2Schema.parse({
      schemaVersion: 2,
      promotionId,
      batchId: request.batch.batchId,
      family: request.batch.family,
      ordinal: request.batch.ordinal,
      itemCount: request.batch.items.length,
      requestDigest: request.batch.requestDigest,
      acceptedRequestDigest: request.batch.requestDigest,
      previousFamilyCount: request.batch.previousFamilyCount,
      previousFamilyDigest: request.batch.previousFamilyDigest,
      cumulativeFamilyCount: advanced.count,
      cumulativeFamilyDigest: advanced.digest,
      lastEntityIdentity: advanced.lastEntityIdentity,
      acceptedAt: 20 + this.receipts.length,
      cumulativeCounts,
    });
    this.receipts.push(receipt);
    if (
      taskDomain.promotionEntityFamilyValues.every(
        (family) =>
          (this.receipts.filter((item) => item.family === family)
            .at(-1)?.cumulativeFamilyCount ?? 0) ===
          this.manifest?.counts[family],
      )
    ) {
      this.state = "ready";
    }
    if (this.loseNextBatchResponse) {
      this.loseNextBatchResponse = false;
      return Promise.resolve({ ok: false, kind: "outcome_unknown" });
    }
    return Promise.resolve({ ok: true, value: { receipt } });
  }

  lookup(
    promotionId: string,
  ): Promise<LocalPromotionTransportResult<Readonly<{
    promotion: WorkspacePromotionStateV2;
  }>>> {
    if (this.manifest === null || promotionId !== this.manifest.promotionId) {
      return Promise.resolve({ ok: false, kind: "not_found" });
    }
    return Promise.resolve({
      ok: true,
      value: { promotion: this.remoteState() },
    });
  }

  activate(
    promotionId: string,
    request: ActivateHRAPromotionRequest,
  ): Promise<LocalPromotionTransportResult<Readonly<{
    receipt: ReturnType<FakePromotionAuthority["activationReceipt"]>;
  }>>> {
    void request;
    this.activationCalls += 1;
    if (this.manifest === null || promotionId !== this.manifest.promotionId) {
      return Promise.resolve({ ok: false, kind: "not_found" });
    }
    this.state = "activated";
    const receipt = this.activationReceipt();
    if (this.loseNextActivationResponse) {
      this.loseNextActivationResponse = false;
      return Promise.resolve({ ok: false, kind: "outcome_unknown" });
    }
    return Promise.resolve({ ok: true, value: { receipt } });
  }

  abort(
    promotionId: string,
    request: Readonly<{ manifestRoot: string }>,
  ): Promise<LocalPromotionTransportResult<Readonly<{
    receipt: ReturnType<FakePromotionAuthority["abortReceipt"]>;
  }>>> {
    void request;
    this.abortCalls += 1;
    if (this.manifest === null || promotionId !== this.manifest.promotionId) {
      return Promise.resolve({ ok: false, kind: "not_found" });
    }
    this.state = "aborted";
    const receipt = this.abortReceipt();
    if (this.loseNextAbortResponse) {
      this.loseNextAbortResponse = false;
      return Promise.resolve({ ok: false, kind: "outcome_unknown" });
    }
    return Promise.resolve({ ok: true, value: { receipt } });
  }

  listReceipts(
    promotionId: string,
    input: Readonly<{ cursor?: string; limit: number }>,
  ): Promise<LocalPromotionTransportResult<
    PromotionBatchReceiptPage
  >> {
    if (this.manifest === null || promotionId !== this.manifest.promotionId) {
      return Promise.resolve({ ok: false, kind: "not_found" });
    }
    const offset = input.cursor === undefined
      ? 0
      : Number(input.cursor.slice("promotion_receipts_v1_".length));
    const items = this.receipts.slice(offset, offset + input.limit);
    const nextOffset = offset + items.length;
    const hasMore = nextOffset < this.receipts.length;
    return Promise.resolve({
      ok: true,
      value: taskDomain.promotionBatchReceiptPageSchema.parse({
        promotionId,
        items,
        cursor: hasMore ? `promotion_receipts_v1_${String(nextOffset)}` : null,
        hasMore,
      }),
    });
  }

  advanceCleanup(
    promotionId: string,
    request: AdvanceHRAPromotionCleanupRequest,
  ): Promise<LocalPromotionTransportResult<Readonly<{
    cleanup: PromotionCleanupProgress;
  }>>> {
    this.cleanupCalls += 1;
    if (this.manifest === null || promotionId !== this.manifest.promotionId) {
      return Promise.resolve({ ok: false, kind: "not_found" });
    }
    this.cleanupDeleted = Math.min(
      this.cleanupTotal,
      this.cleanupDeleted + (request.limit ?? 100),
    );
    return Promise.resolve({
      ok: true,
      value: { cleanup: this.cleanupProgress() },
    });
  }

  cleanupStatus(
    promotionId: string,
  ): Promise<LocalPromotionTransportResult<Readonly<{
    cleanup: PromotionCleanupProgress;
  }>>> {
    if (this.manifest === null || promotionId !== this.manifest.promotionId) {
      return Promise.resolve({ ok: false, kind: "not_found" });
    }
    return Promise.resolve({
      ok: true,
      value: { cleanup: this.cleanupProgress() },
    });
  }

  remoteState(): WorkspacePromotionStateV2 {
    const manifest = this.manifest;
    if (manifest === null) throw new Error("promotion has not started");
    if (this.state === "activated") {
      return taskDomain.workspacePromotionStateV2Schema.parse({
        schemaVersion: 2,
        state: "activated",
        promotionId: PROMOTION_ID,
        manifest,
        stagingWorkspaceId: STAGING_WORKSPACE_ID,
        localWritable: false,
        activationReceipt: this.activationReceipt(),
      });
    }
    if (this.state === "aborted") {
      return taskDomain.workspacePromotionStateV2Schema.parse({
        schemaVersion: 2,
        state: "aborted",
        promotionId: PROMOTION_ID,
        sourceWorkspaceId: WORKSPACE_ID,
        manifestRoot: manifest.rootDigest,
        stagingWorkspaceId: STAGING_WORKSPACE_ID,
        localWritable: true,
        abortReceipt: this.abortReceipt(),
      });
    }
    let allPriorComplete = true;
    const families = Object.fromEntries(
      taskDomain.promotionEntityFamilyValues.map((family) => {
        const matching = this.receipts.filter(
          (receipt) => receipt.family === family,
        );
        const last = matching.at(-1);
        const expected = manifest.counts[family];
        const complete = allPriorComplete &&
          (last?.cumulativeFamilyCount ?? 0) === expected;
        if (!complete) allPriorComplete = false;
        return [
          family,
          {
            family,
            acceptedBatchCount: matching.length,
            acceptedEntityCount: last?.cumulativeFamilyCount ?? 0,
            cumulativeDigest: last?.cumulativeFamilyDigest ??
              taskDomain.promotionFamilyInitialDigest(family),
            lastEntityIdentity: last?.lastEntityIdentity ?? null,
            complete,
          },
        ];
      }),
    );
    let activeFamilyIndex = 0;
    while (
      activeFamilyIndex < taskDomain.promotionEntityFamilyValues.length &&
      (
        families[
          taskDomain.promotionEntityFamilyValues[activeFamilyIndex] as keyof
            typeof families
        ] as { complete: boolean } | undefined
      )?.complete === true
    ) {
      activeFamilyIndex += 1;
    }
    const state = this.state === "rejected"
      ? {
          state: "rejected" as const,
          rejectionCode: "projection_failed" as const,
        }
      : { state: this.state };
    return taskDomain.workspacePromotionStateV2Schema.parse({
      schemaVersion: 2,
      promotionId: PROMOTION_ID,
      manifest,
      stagingWorkspaceId: STAGING_WORKSPACE_ID,
      localWritable: false,
      ...state,
      progress: {
        activeFamilyIndex,
        receiptCount: this.receipts.length,
        acceptedEntityCount: this.receipts.reduce(
          (sum, receipt, index) =>
            sum + (
              this.receipts.slice(0, index)
                .some((prior) =>
                  prior.family === receipt.family &&
                  prior.ordinal === receipt.ordinal)
                ? 0
                : receipt.itemCount
            ),
          0,
        ),
        families,
      },
    });
  }

  activationReceipt() {
    const manifest = this.manifest;
    if (manifest === null) throw new Error("promotion has not started");
    const base = taskDomain.promotionActivationReceiptV2DigestInputSchema.parse({
      schemaVersion: 2,
      issuer: "convex_promotion_authority",
      serverReceiptId: "promotion_receipt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      promotionId: PROMOTION_ID,
      sourceWorkspaceId: WORKSPACE_ID,
      destinationWorkspaceId: STAGING_WORKSPACE_ID,
      acceptedManifestRoot: manifest.rootDigest,
      acceptedCounts: manifest.counts,
      acceptedFamilyDigests: manifest.familyDigests,
      decision: "activated",
      decisionSequence: 1,
      activatedAt: 200,
    });
    return taskDomain.promotionActivationReceiptV2Schema.parse({
      ...base,
      receiptDigest: taskDomain.promotionActivationReceiptV2Digest(base),
    });
  }

  abortReceipt() {
    const manifest = this.manifest;
    if (manifest === null) throw new Error("promotion has not started");
    const base = taskDomain.promotionAbortReceiptV2DigestInputSchema.parse({
      schemaVersion: 2,
      issuer: "convex_promotion_authority",
      serverReceiptId: "promotion_receipt_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      promotionId: PROMOTION_ID,
      sourceWorkspaceId: WORKSPACE_ID,
      stagingWorkspaceId: STAGING_WORKSPACE_ID,
      manifestRoot: manifest.rootDigest,
      decision: "aborted_before_activation",
      decisionSequence: 1,
      abortedAt: 190,
    });
    return taskDomain.promotionAbortReceiptV2Schema.parse({
      ...base,
      receiptDigest: taskDomain.promotionAbortReceiptV2Digest(base),
    });
  }

  cleanupProgress(): PromotionCleanupProgress {
    const complete = this.cleanupDeleted === this.cleanupTotal;
    return taskDomain.promotionCleanupProgressSchema.parse({
      promotionId: PROMOTION_ID,
      scope: this.state === "aborted"
        ? "all_promotion_owned_rows"
        : "staging_rows",
      state: complete ? "complete" : this.cleanupDeleted === 0
        ? "pending"
        : "running",
      deletedEntityCount: this.cleanupDeleted,
      cursor: complete
        ? null
        : `promotion_cleanup_v1_${String(this.cleanupDeleted)}`,
      decisionProofRetained: true,
    });
  }
}

function coordinator(
  store: LocalPromotionV2Store,
  transport: FakePromotionAuthority,
  input: Readonly<{
    checkpoint?: LocalPromotionCoordinatorCheckpoint;
    now?: () => number;
  }> = {},
) {
  return new LocalPromotionCoordinator({
    store,
    transport,
    now: input.now ?? (() => 100),
    ...(input.checkpoint === undefined
      ? {}
      : {
          faultInjector: (checkpoint) => {
            if (checkpoint === input.checkpoint) throw new Error("crash");
          },
        }),
  });
}

async function driveUntil(
  value: LocalPromotionCoordinator,
  phase: "ready" | "activated" | "aborted",
  maximumSteps = 30,
) {
  for (let step = 0; step < maximumSteps; step += 1) {
    const progress = await value.runOnce(PROMOTION_ID);
    if (progress.phase === phase) return progress;
  }
  throw new Error(`promotion did not reach ${phase}`);
}

async function expectCrash(promise: Promise<unknown>): Promise<void> {
  const outcome = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).message).toBe("crash");
}

function begin(
  value: LocalPromotionCoordinator,
) {
  return value.beginPromotion({
    workspaceId: WORKSPACE_ID,
    promotionId: PROMOTION_ID,
    destinationOrganizationId: "org_destination",
  });
}

describe("local promotion coordinator faults", () => {
  test("boots resumable work once and clears its lifecycle timer on stop", async () => {
    const { database, store } = fixture();
    const authority = new FakePromotionAuthority();
    let armed = 0;
    let cleared = 0;
    const value = new LocalPromotionCoordinator({
      store,
      transport: authority,
      now: () => 100,
      setTimer: (callback, delayMs) => {
        armed += 1;
        return setTimeout(callback, delayMs);
      },
      clearTimer: (handle) => {
        cleared += 1;
        clearTimeout(handle);
      },
    });
    try {
      begin(value);
      value.start();
      value.start();
      value.wake();
      for (
        let attempts = 0;
        attempts < 20 && authority.startCalls === 0;
        attempts += 1
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      expect(authority.startCalls).toBe(1);
      expect(armed).toBe(1);
      await value.stop();
      expect(cleared).toBe(1);
    } finally {
      await value.stop();
      database.close();
    }
  });

  test("resumes a lost batch response by auditing the exact server receipt", async () => {
    const { database, store } = fixture();
    const authority = new FakePromotionAuthority();
    const value = coordinator(store, authority);
    try {
      begin(value);
      await value.runOnce(PROMOTION_ID);
      authority.loseNextBatchResponse = true;
      const lost = await value.runOnce(PROMOTION_ID);
      expect(lost.fault?.code).toBe("transport_outcome_unknown");
      expect(store.outstandingBatch(PROMOTION_ID)?.state).toBe("lost_response");
      const reconciled = await value.runOnce(PROMOTION_ID);
      expect(reconciled.acceptedBatchCount).toBe(1);
      expect(authority.batchCalls).toBe(1);
      expect(store.outstandingBatch(PROMOTION_ID)).toBeNull();
    } finally {
      database.close();
    }
  });

  test("recovers crashes at every durable before-request boundary", async () => {
    for (const checkpoint of [
      "start.before_request",
      "batch.before_request",
      "lookup.before_request",
      "activation.before_request",
      "abort.before_request",
      "cleanup.before_request",
    ] as const) {
      const { database, store } = fixture();
      const authority = new FakePromotionAuthority();
      const stable = coordinator(store, authority);
      const crashing = coordinator(store, authority, { checkpoint });
      try {
        begin(stable);
        if (checkpoint === "start.before_request") {
          await expectCrash(crashing.runOnce(PROMOTION_ID));
          expect(authority.startCalls).toBe(0);
        } else {
          await stable.runOnce(PROMOTION_ID);
          if (checkpoint === "batch.before_request") {
            await expectCrash(crashing.runOnce(PROMOTION_ID));
            expect(authority.batchCalls).toBe(0);
          } else if (checkpoint === "lookup.before_request") {
            await expectCrash(crashing.abortPromotion(PROMOTION_ID));
            expect(authority.abortCalls).toBe(0);
          } else if (checkpoint === "activation.before_request") {
            await driveUntil(stable, "ready");
            await expectCrash(crashing.runOnce(PROMOTION_ID));
            expect(authority.activationCalls).toBe(0);
          } else if (checkpoint === "abort.before_request") {
            await expectCrash(crashing.abortPromotion(PROMOTION_ID));
            expect(authority.abortCalls).toBe(0);
          } else {
            await driveUntil(stable, "activated");
            await expectCrash(crashing.runOnce(PROMOTION_ID));
            expect(authority.cleanupCalls).toBe(0);
          }
        }
        const resumed = coordinator(store, authority);
        if (
          checkpoint === "lookup.before_request" ||
          checkpoint === "abort.before_request"
        ) {
          await driveUntil(resumed, "aborted");
        } else {
          await driveUntil(resumed, "activated");
        }
      } finally {
        database.close();
      }
    }
  });

  test("recovers crashes after every remote response boundary", async () => {
    for (const checkpoint of [
      "start.after_response_before_persist",
      "batch.after_response_before_persist",
      "lookup.after_response_before_persist",
      "activation.after_response_before_persist",
      "abort.after_response_before_persist",
      "cleanup.after_response_before_persist",
    ] as const) {
      const { database, store } = fixture();
      const authority = new FakePromotionAuthority();
      try {
        const crashing = coordinator(store, authority, { checkpoint });
        begin(crashing);
        if (checkpoint === "start.after_response_before_persist") {
          await expectCrash(crashing.runOnce(PROMOTION_ID));
        } else if (checkpoint === "abort.after_response_before_persist") {
          await coordinator(store, authority).runOnce(PROMOTION_ID);
          await expectCrash(crashing.abortPromotion(PROMOTION_ID));
        } else {
          await coordinator(store, authority).runOnce(PROMOTION_ID);
          if (checkpoint === "batch.after_response_before_persist") {
            await expectCrash(crashing.runOnce(PROMOTION_ID));
          } else {
            await driveUntil(coordinator(store, authority), "ready");
            if (checkpoint === "lookup.after_response_before_persist") {
              store.recordRemoteState(
                PROMOTION_ID,
                {
                  ...authority.remoteState(),
                  state: "projecting",
                },
                100,
              );
              await expectCrash(crashing.runOnce(PROMOTION_ID));
            } else {
              if (checkpoint === "activation.after_response_before_persist") {
                await expectCrash(crashing.runOnce(PROMOTION_ID));
              } else {
                await driveUntil(coordinator(store, authority), "activated");
                await expectCrash(crashing.runOnce(PROMOTION_ID));
              }
            }
          }
        }
        const resumed = coordinator(store, authority);
        if (checkpoint === "abort.after_response_before_persist") {
          await resumed.runOnce(PROMOTION_ID);
        } else if (checkpoint === "cleanup.after_response_before_persist") {
          await resumed.runOnce(PROMOTION_ID);
          expect(store.cleanup(PROMOTION_ID)).not.toBeNull();
        } else if (checkpoint === "lookup.after_response_before_persist") {
          await driveUntil(resumed, "activated");
        } else {
          await driveUntil(resumed, "activated");
        }
        expect(store.progress(PROMOTION_ID).phase).toBe(
          checkpoint === "abort.after_response_before_persist"
            ? "aborted"
            : "activated",
        );
        if (checkpoint === "start.after_response_before_persist") {
          expect(authority.startCalls).toBe(1);
        }
      } finally {
        database.close();
      }
    }
  });

  test("reconciles lost activation and abort responses from server proofs", async () => {
    const activatedFixture = fixture();
    const activationAuthority = new FakePromotionAuthority();
    try {
      const value = coordinator(
        activatedFixture.store,
        activationAuthority,
      );
      begin(value);
      await driveUntil(value, "ready");
      activationAuthority.loseNextActivationResponse = true;
      const unknown = await value.runOnce(PROMOTION_ID);
      expect(unknown.phase).toBe("outcome_unknown");
      const activated = await value.runOnce(PROMOTION_ID);
      expect(activated.phase).toBe("activated");
      expect(activationAuthority.activationCalls).toBe(1);
    } finally {
      activatedFixture.database.close();
    }

    const abortedFixture = fixture();
    const abortAuthority = new FakePromotionAuthority();
    try {
      const value = coordinator(abortedFixture.store, abortAuthority);
      begin(value);
      await value.runOnce(PROMOTION_ID);
      abortAuthority.loseNextAbortResponse = true;
      const unknown = await value.abortPromotion(PROMOTION_ID);
      expect(unknown.phase).toBe("aborting");
      expect(unknown.fault?.code).toBe("transport_outcome_unknown");
      const aborted = await value.runOnce(PROMOTION_ID);
      expect(aborted.phase).toBe("aborted");
      expect(aborted.localWritable).toBeTrue();
      expect(abortAuthority.abortCalls).toBe(1);
      expect(abortedFixture.store.authorityOverlay(WORKSPACE_ID).sourceAccess)
        .toBe("read_write");
    } finally {
      abortedFixture.database.close();
    }
  });

  test("keeps rejection frozen until an exact abort receipt is reconciled", async () => {
    const { database, store } = fixture();
    const authority = new FakePromotionAuthority();
    const value = coordinator(store, authority);
    try {
      begin(value);
      await value.runOnce(PROMOTION_ID);
      for (let step = 0; step < 30; step += 1) {
        const progress = store.progress(PROMOTION_ID);
        if (
          progress.acceptedEntityCount === progress.preparedEntityCount
        ) {
          break;
        }
        await value.runOnce(PROMOTION_ID);
      }
      expect(store.progress(PROMOTION_ID).acceptedEntityCount).toBe(
        store.progress(PROMOTION_ID).preparedEntityCount,
      );

      authority.state = "rejected";
      const rejected = await value.runOnce(PROMOTION_ID);
      expect(rejected).toMatchObject({
        fault: { code: "transport_rejected", retryable: false },
        canAbort: true,
        localWritable: false,
      });
      expect(database.query<{ count: number }, [string]>(`
        SELECT count(*) AS count
        FROM local_promotion_rejection_proofs_v2
        WHERE promotion_id = ?1
      `).get(PROMOTION_ID)?.count).toBe(1);
      expect(store.resumablePromotionIds(100)).not.toContain(PROMOTION_ID);
      expect(store.authorityOverlay(WORKSPACE_ID).sourceAccess).toBe("frozen");

      authority.loseNextAbortResponse = true;
      const lostAbort = await value.abortPromotion(PROMOTION_ID);
      expect(lostAbort).toMatchObject({
        phase: "aborting",
        fault: { code: "transport_outcome_unknown", retryable: true },
        localWritable: false,
      });
      expect(authority.abortCalls).toBe(1);
      expect(store.authorityOverlay(WORKSPACE_ID).sourceAccess).toBe("frozen");

      const exactReceipt = taskDomain.canonicalPromotionJson(
        authority.abortReceipt(),
      );
      const aborted = await value.runOnce(PROMOTION_ID);
      expect(aborted).toMatchObject({
        phase: "aborted",
        localWritable: true,
      });
      expect(database.query<{ receipt_json: string }, [string]>(`
        SELECT receipt_json
        FROM local_promotion_decision_proofs_v2
        WHERE promotion_id = ?1
      `).get(PROMOTION_ID)?.receipt_json).toBe(exactReceipt);
      expect(store.authorityOverlay(WORKSPACE_ID).sourceAccess).toBe(
        "read_write",
      );
    } finally {
      database.close();
    }
  });

  test("does not abort while a lost activation remains ambiguous", async () => {
    const { database, store } = fixture();
    const authority = new FakePromotionAuthority();
    const value = coordinator(store, authority);
    try {
      begin(value);
      await driveUntil(value, "ready");
      authority.loseNextActivationResponse = true;
      const unknown = await value.runOnce(PROMOTION_ID);
      expect(unknown).toMatchObject({
        phase: "outcome_unknown",
        canAbort: false,
        localWritable: false,
      });

      authority.state = "outcome_unknown";
      const abortError = await value.abortPromotion(PROMOTION_ID).then(
        () => null,
        (error: unknown) => error,
      );
      expect(abortError).toMatchObject({ code: "state_conflict" });
      expect(store.progress(PROMOTION_ID)).toMatchObject({
        phase: "outcome_unknown",
        canAbort: false,
        localWritable: false,
      });
      expect(authority.abortCalls).toBe(0);
      expect(store.authorityOverlay(WORKSPACE_ID).sourceAccess).toBe("frozen");

      authority.state = "activated";
      const activated = await value.runOnce(PROMOTION_ID);
      expect(activated).toMatchObject({
        phase: "activated",
        localWritable: false,
      });
      expect(authority.abortCalls).toBe(0);
      expect(store.authorityOverlay(WORKSPACE_ID).sourceAccess).toBe(
        "read_only_recovery",
      );
    } finally {
      database.close();
    }
  });

  test("persists rejected activation reconciliation across restart", async () => {
    const { database, store } = fixture();
    const authority = new FakePromotionAuthority();
    try {
      const initial = coordinator(store, authority);
      begin(initial);
      await driveUntil(initial, "ready");
      authority.loseNextActivationResponse = true;
      expect(await initial.runOnce(PROMOTION_ID)).toMatchObject({
        phase: "outcome_unknown",
        canAbort: false,
        localWritable: false,
      });

      authority.state = "rejected";
      const provenRejected = await initial.runOnce(PROMOTION_ID);
      expect(provenRejected).toMatchObject({
        phase: "outcome_unknown",
        fault: { code: "transport_rejected", retryable: false },
        canAbort: true,
        localWritable: false,
      });

      const restartedForAbort = coordinator(store, authority);
      authority.loseNextAbortResponse = true;
      const lostAbort = await restartedForAbort.abortPromotion(PROMOTION_ID);
      expect(lostAbort).toMatchObject({
        phase: "aborting",
        fault: { code: "transport_outcome_unknown", retryable: true },
        localWritable: false,
      });
      expect(authority.abortCalls).toBe(1);

      const restartedForProof = coordinator(store, authority);
      const exactAbortReceipt = taskDomain.canonicalPromotionJson(
        authority.abortReceipt(),
      );
      expect(await restartedForProof.runOnce(PROMOTION_ID)).toMatchObject({
        phase: "aborted",
        localWritable: true,
      });
      expect(database.query<{ receipt_json: string }, [string]>(`
        SELECT receipt_json
        FROM local_promotion_decision_proofs_v2
        WHERE promotion_id = ?1
      `).get(PROMOTION_ID)?.receipt_json).toBe(exactAbortReceipt);
    } finally {
      database.close();
    }
  });

  test("paginates cleanup while retaining the local decision proof", async () => {
    const { database, store } = fixture();
    const authority = new FakePromotionAuthority();
    const value = coordinator(store, authority);
    try {
      begin(value);
      await driveUntil(value, "activated");
      for (let index = 0; index < 4; index += 1) {
        await value.runOnce(PROMOTION_ID);
      }
      expect(store.cleanup(PROMOTION_ID)).toMatchObject({
        state: "complete",
        deletedEntityCount: 1_201,
        decisionProofRetained: true,
      });
      expect(authority.cleanupCalls).toBe(3);
      expect(database.query<{ count: number }, [string]>(`
        SELECT count(*) AS count FROM local_promotion_decision_proofs_v2
        WHERE promotion_id = ?1
      `).get(PROMOTION_ID)?.count).toBe(1);
    } finally {
      database.close();
    }
  });
});
