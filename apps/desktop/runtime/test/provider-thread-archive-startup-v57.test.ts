import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type { ChatThreadBinding } from "../src/chat/types";
import { chatProviderAttachmentAuthority } from "../src/chat/types";
import type {
  ChatImageNormalizer,
  NativeImageNormalizerReceipt,
} from "../src/attachments/normalizer";
import { SQLiteChatAttachmentVault } from "../src/attachments/vault";
import {
  AccountService,
  type AccountRuntimeRouterPort,
  type ExternalUrlOpener,
} from "../src/accounts/account-service";
import { ArchiveAdmissionGate } from "../src/accounts/archive-admission-gate";
import type { AccountProfileFileSystem } from "../src/accounts/local-data-remover";
import { AccountProfileStore } from "../src/accounts/profile-store";
import { AccountRuntimeRouter } from "../src/accounts/runtime-router";
import { RootTurnRoutingSQLiteAuthorityV1 } from
  "../src/harness/root-turn-routing-sqlite-v1";
import { ChatPaneStore } from "../src/state/chat-pane-store";
import { applyMigrations } from "../src/state/database";
import {
  ProviderThreadArchiveJournalV57,
  providerThreadArchiveAccountTombstonePreimageDigestV57,
  providerThreadArchiveCompleteInventoryDigestV57,
} from "../src/state/provider-thread-archive-journal-v57";

const ACCOUNT = "acct_startupv5701";
const REMOVAL_ACCOUNT = "acct_startupv5702";
const NOW = new Date("2026-08-19T12:00:00.000Z");
const RECEIPT_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const CATALOG_DIGEST = "c".repeat(64);
const REPOSITORY = `repo_${"A".repeat(26)}`;

class UnusedNormalizer implements ChatImageNormalizer {
  normalize(
    inputPath: string,
    outputDirectory: string,
  ): Promise<NativeImageNormalizerReceipt> {
    void inputPath;
    void outputDirectory;
    return Promise.reject(
      new Error("The startup fixture must not invoke image normalization."),
    );
  }
}

class NoopProfileFileSystem implements AccountProfileFileSystem {
  ensureAccountProfile(): Promise<void> {
    return Promise.resolve();
  }

  deleteAccountHome(): Promise<void> {
    return Promise.resolve();
  }
}

class NoopExternalUrlOpener implements ExternalUrlOpener {
  open(): Promise<void> {
    return Promise.resolve();
  }
}

type ReplayHarness = Readonly<{
  archiveAdmissionGate: ArchiveAdmissionGate;
  processConstructions: { value: number };
  rpcInvocations: { value: number };
  router: AccountRuntimeRouter;
  service: AccountService;
}>;

function replayHarness(
  database: Database,
  databasePath: string,
): ReplayHarness {
  const archiveAdmissionGate = new ArchiveAdmissionGate();
  const processConstructions = { value: 0 };
  const rpcInvocations = { value: 0 };
  const router = new AccountRuntimeRouter({
    archiveAdmissionGate,
    createProcess: () => {
      processConstructions.value += 1;
      return Promise.reject(
        new Error("Provider construction is forbidden before archive replay."),
      );
    },
  });
  const providerRpcMethods = new Set<PropertyKey>([
    "request",
    "requestArchiveRecoveryWithResponsePosition",
    "requestWithResponsePosition",
  ]);
  const observedRouter = new Proxy(router, {
    get(target, property): unknown {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]): unknown => {
        if (providerRpcMethods.has(property)) rpcInvocations.value += 1;
        const result: unknown = Reflect.apply(value, target, args);
        return result;
      };
    },
  }) as AccountRuntimeRouterPort;
  const service = new AccountService({
    archiveAdmissionGate,
    assets: {
      codexBinary: "/fixture/codex",
      gitBinary: "/fixture/git/bin/git",
      gitRoot: "/fixture/git",
    },
    containChatsBeforeRemoval: () => Promise.resolve(),
    joinChatArchiveGenerationContainment: () => Promise.resolve(),
    controlPlanePath: databasePath,
    controlPlaneDatabase: database,
    emit: () => {},
    externalUrlOpener: new NoopExternalUrlOpener(),
    profileFileSystem: new NoopProfileFileSystem(),
    providerThreadArchiveJournalV57: new ProviderThreadArchiveJournalV57(
      database,
      RECEIPT_KEY,
    ),
    now: () => NOW,
    router: observedRouter,
    store: new AccountProfileStore(database),
  });
  return {
    archiveAdmissionGate,
    processConstructions,
    rpcInvocations,
    router,
    service,
  };
}

test("v57 file-backed startup sweeps exact committed pane authority and is idempotent", async () => {
  await withTemporaryStartupDatabase(async ({
    attachmentRoot,
    databasePath,
  }) => {
    const componentCutId = "archcut_v57_startup_component01";
    const removalCutId = "archcut_v57_startup_removal01";
    const targetIds = seedCommittedStartupAuthority({
      attachmentRoot,
      componentCutId,
      databasePath,
      removalCutId,
    });

    let database = openDatabase(databasePath);
    let vault = new SQLiteChatAttachmentVault({
      database,
      root: attachmentRoot,
      normalizer: new UnusedNormalizer(),
    });
    let store = new ChatPaneStore(database, {
      messageRequestDigestKey: RECEIPT_KEY,
      paneArchiveAuthority: vault,
    });
    let harness = replayHarness(database, databasePath);

    expect(harness.processConstructions.value).toBe(0);
    expect(harness.rpcInvocations.value).toBe(0);
    const committedTargetIds =
      store.verifyProviderThreadArchiveTerminalAuthorityV57();
    expect(committedTargetIds).toEqual(targetIds);
    vault.authorizeProviderThreadArchivePaneCleanupAfterStoreVerificationV57(
      committedTargetIds,
    );
    await vault.reconcile(NOW);
    const swept = store.sweepProviderThreadArchiveTerminalAuthorityV57(
      committedTargetIds,
    );
    expect(swept.cleanup).toEqual({
      deletedTargetIds: targetIds,
      deletedCutIds: [componentCutId],
    });
    expect(harness.service.installArchiveAdmissionReplayV57(
      swept.recoveryInventory,
    )).toEqual(swept.recoveryInventory);
    expect(harness.processConstructions.value).toBe(0);
    expect(harness.rpcInvocations.value).toBe(0);
    expect(harness.router.isRunning(ACCOUNT)).toBe(false);
    expect(database.query(`
      SELECT
        (SELECT COUNT(*) FROM chat_provider_thread_archive_targets_v57)
          AS targets,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_attempts_v57)
          AS attempts,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_cut_members_v57)
          AS members,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_cuts_v57
          WHERE cut_id = ?1 AND cause = 'account_removal'
            AND state = 'contained' AND target_count = 0) AS removal_cuts
    `).get(removalCutId)).toEqual({
      targets: 0,
      attempts: 0,
      members: 0,
      removal_cuts: 1,
    });
    database.close();

    database = openDatabase(databasePath);
    vault = new SQLiteChatAttachmentVault({
      database,
      root: attachmentRoot,
      normalizer: new UnusedNormalizer(),
    });
    store = new ChatPaneStore(database, {
      messageRequestDigestKey: RECEIPT_KEY,
      paneArchiveAuthority: vault,
    });
    harness = replayHarness(database, databasePath);
    const repeatedCommittedTargetIds =
      store.verifyProviderThreadArchiveTerminalAuthorityV57();
    expect(repeatedCommittedTargetIds).toEqual([]);
    vault.authorizeProviderThreadArchivePaneCleanupAfterStoreVerificationV57(
      repeatedCommittedTargetIds,
    );
    await vault.reconcile(new Date(NOW.getTime() + 1_000));
    const repeated = store.sweepProviderThreadArchiveTerminalAuthorityV57(
      repeatedCommittedTargetIds,
    );
    expect(repeated.cleanup).toEqual({
      deletedTargetIds: [],
      deletedCutIds: [],
    });
    expect(harness.service.installArchiveAdmissionReplayV57(
      repeated.recoveryInventory,
    )).toEqual(repeated.recoveryInventory);
    expect(harness.processConstructions.value).toBe(0);
    expect(harness.rpcInvocations.value).toBe(0);
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM chat_provider_thread_archive_cuts_v57
      WHERE cut_id = ?1 AND cause = 'account_removal'
        AND state = 'contained' AND target_count = 0
    `).get(removalCutId)).toEqual({ count: 1 });
    database.close();
  });
});

test("v57 file-backed startup retains and quarantines a mixed terminal component", async () => {
  await withTemporaryStartupDatabase(async ({
    attachmentRoot,
    databasePath,
  }) => {
    const database = createDatabase(databasePath);
    insertProfiles(database);
    const vault = new SQLiteChatAttachmentVault({
      database,
      root: attachmentRoot,
      normalizer: new UnusedNormalizer(),
    });
    const store = new ChatPaneStore(database, {
      messageRequestDigestKey: RECEIPT_KEY,
      paneArchiveAuthority: vault,
    });
    const journal = new ProviderThreadArchiveJournalV57(
      database,
      RECEIPT_KEY,
    );
    const mixed = seedMixedCommittedAndOpenComponent({
      cutId: "archcut_v57_startup_mixed01",
      database,
      journal,
      store,
    });
    database.close();

    const reopened = openDatabase(databasePath);
    const reopenedVault = new SQLiteChatAttachmentVault({
      database: reopened,
      root: attachmentRoot,
      normalizer: new UnusedNormalizer(),
    });
    const reopenedStore = new ChatPaneStore(reopened, {
      messageRequestDigestKey: RECEIPT_KEY,
      paneArchiveAuthority: reopenedVault,
    });
    const harness = replayHarness(reopened, databasePath);
    const committedTargetIds =
      reopenedStore.verifyProviderThreadArchiveTerminalAuthorityV57();
    expect(committedTargetIds).toEqual([mixed.committedTargetId]);
    reopenedVault
      .authorizeProviderThreadArchivePaneCleanupAfterStoreVerificationV57(
        committedTargetIds,
      );
    await reopenedVault.reconcile(NOW);
    const swept = reopenedStore.sweepProviderThreadArchiveTerminalAuthorityV57(
      committedTargetIds,
    );
    expect(swept.cleanup).toEqual({
      deletedTargetIds: [],
      deletedCutIds: [],
    });
    expect(swept.recoveryInventory.targets.map(({ targetId }) => targetId))
      .toEqual([mixed.openTargetId]);
    expect(harness.service.installArchiveAdmissionReplayV57(
      swept.recoveryInventory,
    )).toEqual(swept.recoveryInventory);
    expect(harness.archiveAdmissionGate.isHeld(ACCOUNT)).toBe(true);
    expect(harness.processConstructions.value).toBe(0);
    expect(harness.rpcInvocations.value).toBe(0);
    expect(harness.router.isRunning(ACCOUNT)).toBe(false);
    expect(reopened.query(`
      SELECT
        (SELECT COUNT(*) FROM chat_provider_thread_archive_targets_v57)
          AS targets,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_attempts_v57)
          AS attempts,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_cut_members_v57)
          AS members,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_cuts_v57
          WHERE cut_id = ?1) AS cuts
    `).get(mixed.cutId)).toEqual({
      targets: 2,
      attempts: 2,
      members: 2,
      cuts: 1,
    });
    reopened.close();
  });
});

async function withTemporaryStartupDatabase(
  run: (fixture: Readonly<{
    attachmentRoot: string;
    databasePath: string;
  }>) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp("/private/tmp/hra-v57-startup-");
  const attachmentRoot = join(root, "attachments");
  const databasePath = join(root, "control-plane.sqlite");
  await mkdir(attachmentRoot, { recursive: true });
  try {
    await run({ attachmentRoot, databasePath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createDatabase(databasePath: string): Database {
  const database = new Database(databasePath, { create: true, strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  return database;
}

function openDatabase(databasePath: string): Database {
  const database = new Database(databasePath, { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

function insertProfiles(database: Database): void {
  database.query(`
    INSERT INTO account_profiles (
      profile_id, label, auth_state, process_generation,
      selected, created_at, updated_at
    ) VALUES (?1, 'Startup primary', 'signed_in', 1, 1, ?3, ?3),
      (?2, 'Startup removal', 'signed_in', 1, 0, ?3, ?3)
  `).run(ACCOUNT, REMOVAL_ACCOUNT, NOW.toISOString());
}

function seedCommittedStartupAuthority(input: Readonly<{
  attachmentRoot: string;
  componentCutId: string;
  databasePath: string;
  removalCutId: string;
}>): readonly string[] {
  const database = createDatabase(input.databasePath);
  insertProfiles(database);
  const vault = new SQLiteChatAttachmentVault({
    database,
    root: input.attachmentRoot,
    normalizer: new UnusedNormalizer(),
  });
  const store = new ChatPaneStore(database, {
    messageRequestDigestKey: RECEIPT_KEY,
    paneArchiveAuthority: vault,
  });
  const journal = new ProviderThreadArchiveJournalV57(database, RECEIPT_KEY);
  const component = finalizeConnectedAppliedTargets({
    cutId: input.componentCutId,
    database,
    journal,
    store,
    targets: [{
      paneId: "pane_v57_startup_archive01",
      purpose: "pane_archive",
      suffix: "startup_archive01",
    }, {
      paneId: "pane_v57_startup_fresh01",
      purpose: "start_fresh",
      suffix: "startup_fresh01",
    }],
  });
  seedContainedZeroTargetRemovalCut({
    accountProfileId: REMOVAL_ACCOUNT,
    cutId: input.removalCutId,
    database,
    journal,
  });
  const targetIds = component.targets.map(({ targetId }) => targetId).sort();
  database.close();
  return targetIds;
}

function seedMixedCommittedAndOpenComponent(input: Readonly<{
  cutId: string;
  database: Database;
  journal: ProviderThreadArchiveJournalV57;
  store: ChatPaneStore;
}>): Readonly<{
  committedTargetId: string;
  cutId: string;
  openTargetId: string;
}> {
  const first = seedProviderPane({
    database: input.database,
    paneId: "pane_v57_startup_mixeda01",
    store: input.store,
    suffix: "startup_mixeda01",
  });
  const second = seedProviderPane({
    database: input.database,
    paneId: "pane_v57_startup_mixedb01",
    store: input.store,
    suffix: "startup_mixedb01",
  });
  retainProviderBinding(input.database, first.paneId, first.binding);
  retainProviderBinding(input.database, second.paneId, second.binding);
  const firstPreparation = targetPreparation({
    paneId: first.paneId,
    store: input.store,
    suffix: "startup_mixeda01",
  });
  const secondPreparation = targetPreparation({
    paneId: second.paneId,
    store: input.store,
    suffix: "startup_mixedb01",
  });
  input.store.prepareProviderThreadArchiveEffectStartedV57(firstPreparation);
  input.store.prepareProviderThreadArchiveEffectStartedV57(secondPreparation);
  input.store.beginProviderThreadArchiveLostResponseCutV57({
    targetId: secondPreparation.targetId,
    cutId: input.cutId,
    cause: "lost_response",
    now: NOW,
  });
  const successorRevision = advanceAccountGeneration(input.database, 2);
  input.journal.recordFence({
    cutId: input.cutId,
    successorGeneration: 2,
    successorAccountProfileRevision: successorRevision,
    fenceEvidenceDigest: digest("1"),
    fenceRevisionDigest: digest("2"),
    now: NOW,
  });
  const sealed = input.store.sealProviderThreadArchiveSourceInventoryV57({
    cutId: input.cutId,
    now: NOW,
  });
  for (const member of sealed.members) {
    input.store.settleProviderThreadArchiveMemberV57({
      memberId: member.memberId,
      now: NOW,
    });
  }
  input.store.markProviderThreadArchiveCutContainedV57({
    cutId: input.cutId,
    now: NOW,
  });
  for (const [index, targetId] of [
    firstPreparation.targetId,
    secondPreparation.targetId,
  ].entries()) {
    input.store.recordProviderThreadArchiveReconciliationV57({
      targetId,
      result: {
        disposition: "applied",
        responseGeneration: 2,
        responseStreamPosition: 200 + index,
        providerContainmentReceipt: `mixed startup containment ${index}`,
      },
      now: NOW,
    });
  }
  input.store.finalizeProviderThreadArchiveTargetV57({
    targetId: firstPreparation.targetId,
    now: NOW,
  });
  return {
    committedTargetId: firstPreparation.targetId,
    cutId: input.cutId,
    openTargetId: secondPreparation.targetId,
  };
}

function finalizeConnectedAppliedTargets(input: Readonly<{
  cutId: string;
  database: Database;
  journal: ProviderThreadArchiveJournalV57;
  store: ChatPaneStore;
  targets: readonly Readonly<{
    paneId: string;
    purpose: "pane_archive" | "start_fresh";
    suffix: string;
  }>[];
}>): Readonly<{
  targets: readonly Readonly<{ paneId: string; targetId: string }>[];
}> {
  const seeded = input.targets.map((target) => {
    const fixture = seedProviderPane({
      database: input.database,
      paneId: target.paneId,
      store: input.store,
      suffix: target.suffix,
    });
    retainProviderBinding(input.database, target.paneId, fixture.binding);
    if (target.purpose === "start_fresh") {
      const changed = input.database.query(`
        UPDATE chat_panes SET state = 'attention',
          attention_code = 'runtime_unavailable',
          attention_message = 'Choose Start fresh.', attention_retryable = 0,
          provider_context_reset_required = 1,
          message_queue_pause_reason = 'attention',
          message_queue_revision = message_queue_revision + 1,
          revision = revision + 1
        WHERE pane_id = ?1
      `).run(target.paneId);
      if (changed.changes !== 1) {
        throw new Error("Expected a startup Start fresh fixture pane.");
      }
    }
    return {
      paneId: target.paneId,
      preparation: targetPreparation({
        paneId: target.paneId,
        purpose: target.purpose,
        store: input.store,
        suffix: target.suffix,
      }),
    };
  });
  const initiating = seeded[0];
  if (initiating === undefined) throw new Error("Expected a startup target.");
  for (const { preparation } of seeded) {
    input.store.prepareProviderThreadArchiveEffectStartedV57(preparation);
  }
  input.store.beginProviderThreadArchiveLostResponseCutV57({
    targetId: initiating.preparation.targetId,
    cutId: input.cutId,
    cause: "lost_response",
    now: NOW,
  });
  const successorRevision = advanceAccountGeneration(input.database, 2);
  input.journal.recordFence({
    cutId: input.cutId,
    successorGeneration: 2,
    successorAccountProfileRevision: successorRevision,
    fenceEvidenceDigest: digest("1"),
    fenceRevisionDigest: digest("2"),
    now: NOW,
  });
  const sealed = input.store.sealProviderThreadArchiveSourceInventoryV57({
    cutId: input.cutId,
    now: NOW,
  });
  for (const member of sealed.members) {
    input.store.settleProviderThreadArchiveMemberV57({
      memberId: member.memberId,
      now: NOW,
    });
  }
  input.store.markProviderThreadArchiveCutContainedV57({
    cutId: input.cutId,
    now: NOW,
  });
  for (const [index, { preparation }] of seeded.entries()) {
    input.store.recordProviderThreadArchiveReconciliationV57({
      targetId: preparation.targetId,
      result: {
        disposition: "applied",
        responseGeneration: 2,
        responseStreamPosition: 100 + index,
        providerContainmentReceipt: `startup containment ${index}`,
      },
      now: NOW,
    });
  }
  return {
    targets: seeded.map(({ paneId, preparation }) => {
      input.store.finalizeProviderThreadArchiveTargetV57({
        targetId: preparation.targetId,
        now: NOW,
      });
      return { paneId, targetId: preparation.targetId };
    }),
  };
}

function seedProviderPane(input: Readonly<{
  database: Database;
  paneId: string;
  store: ChatPaneStore;
  suffix: string;
}>): Readonly<{
  binding: ChatThreadBinding;
  paneId: string;
}> {
  const created = input.store.create({
    paneId: input.paneId,
    repository: {
      id: REPOSITORY,
      name: "Startup fixture",
      workingDirectory: "/fixture/startup",
    },
    accountProfileId: ACCOUNT,
    now: NOW,
  });
  const turnId = `chatturn_v57_${input.suffix}`;
  input.store.beginTurn({
    paneId: input.paneId,
    expectedRevision: created.revision,
    turnId,
    prompt: `startup ownership ${input.suffix}`,
    now: NOW,
  });
  input.store.reserveAccount(input.paneId, turnId, ACCOUNT, NOW);
  const routing = new RootTurnRoutingSQLiteAuthorityV1(input.database);
  const classified = routing.readTurnRouting(input.paneId, turnId);
  if (classified === null) throw new Error("Expected startup routing authority.");
  routing.resolve({
    paneId: input.paneId,
    chatTurnId: turnId,
    selectedProfile: classified.requestedProfile,
    profileFallbackReason: null,
    selectedServiceTier: classified.requestedServiceTier,
    serviceTierFallbackReason: null,
    catalogGeneration: 1,
    catalogDigest: CATALOG_DIGEST,
    now: NOW,
  });
  const binding = {
    accountProfileId: ACCOUNT,
    threadId: `thread_v57_${input.suffix}`,
    restartThreadId: `raw_thread_v57_${input.suffix}`,
  } as const;
  input.store.prepareProviderThread(input.paneId, turnId, binding, NOW);
  routing.markEffectStarted({
    paneId: input.paneId,
    chatTurnId: turnId,
    now: NOW,
  });
  routing.accept({
    paneId: input.paneId,
    chatTurnId: turnId,
    acceptedGeneration: 1,
    acceptedStreamPosition: 0,
    now: NOW,
  });
  input.store.markTurnAccepted(
    input.paneId,
    turnId,
    `provider_turn_v57_${input.suffix}`,
    NOW,
  );
  routing.settle({
    paneId: input.paneId,
    chatTurnId: turnId,
    outcome: "failed",
    now: NOW,
  });
  const terminal = input.store.enterAttention({
    paneId: input.paneId,
    turnId,
    attention: {
      code: "turn_failed",
      message: "The accepted provider turn is terminal.",
      retryable: false,
    },
    clearBinding: false,
    now: NOW,
  });
  if (terminal === null) throw new Error("Expected a terminal startup pane.");
  return { binding, paneId: input.paneId };
}

function retainProviderBinding(
  database: Database,
  paneId: string,
  binding: ChatThreadBinding,
): void {
  const authority = chatProviderAttachmentAuthority(paneId, binding);
  database.query(`
    INSERT INTO chat_provider_attachment_bindings (
      binding_id, binding_key_digest, pane_id, revision, state,
      acquired_at, updated_at
    ) VALUES (?1, ?2, ?3, 1, 'active', ?4, ?4)
  `).run(
    authority.bindingId,
    authority.bindingKeyDigest,
    paneId,
    NOW.toISOString(),
  );
}

function targetPreparation(input: Readonly<{
  paneId: string;
  purpose?: "pane_archive" | "start_fresh";
  store: ChatPaneStore;
  suffix: string;
}>) {
  const pane = input.store.require(input.paneId).projection;
  const purpose = input.purpose ?? "pane_archive";
  const base = {
    targetId: `archtarget_v57_${input.suffix}`,
    attemptId: `archattempt_v57_${input.suffix}`,
    paneId: input.paneId,
    expectedRevision: pane.revision,
    generation: 1,
    now: NOW,
  } as const;
  return purpose === "start_fresh"
    ? ({
        ...base,
        purpose,
        expectedQueueRevision: pane.messageQueue.revision,
      } as const)
    : ({
        ...base,
        purpose,
        expectedQueueRevision: null,
      } as const);
}

function advanceAccountGeneration(
  database: Database,
  generation: number,
): number {
  const profile = database.query<{
    process_generation: number;
    revision: number;
  }, [string]>(`
    SELECT process_generation, revision FROM account_profiles
    WHERE profile_id = ?1
  `).get(ACCOUNT);
  if (profile === null || generation !== profile.process_generation + 1) {
    throw new Error("Startup generation cannot advance.");
  }
  const revision = profile.revision + 1;
  const changed = database.query(`
    UPDATE account_profiles SET process_generation = ?2,
      revision = ?3, updated_at = ?4
    WHERE profile_id = ?1 AND revision = ?5 AND removed_at IS NULL
  `).run(
    ACCOUNT,
    generation,
    revision,
    NOW.toISOString(),
    profile.revision,
  );
  if (changed.changes !== 1) {
    throw new Error("Startup generation changed concurrently.");
  }
  return revision;
}

function seedContainedZeroTargetRemovalCut(input: Readonly<{
  accountProfileId: string;
  cutId: string;
  database: Database;
  journal: ProviderThreadArchiveJournalV57;
}>): void {
  const profile = input.database.query<{
    process_generation: number;
    revision: number;
  }, [string]>(`
    SELECT process_generation, revision FROM account_profiles
    WHERE profile_id = ?1 AND removed_at IS NULL
  `).get(input.accountProfileId);
  if (profile === null) throw new Error("Expected the removal profile.");
  input.journal.createCut({
    cutId: input.cutId,
    accountProfileId: input.accountProfileId,
    accountProfileRevision: profile.revision,
    sourceGeneration: profile.process_generation,
    cause: "account_removal",
    initiatingAttemptId: null,
    predecessorCutId: null,
    identityEvidenceDigest: digest("1"),
    identityRevisionDigest: digest("2"),
    now: NOW,
  });
  input.journal.recordFence({
    cutId: input.cutId,
    successorGeneration: null,
    successorAccountProfileRevision: null,
    fenceEvidenceDigest: digest("3"),
    fenceRevisionDigest: digest("4"),
    now: NOW,
  });
  input.journal.sealCutInventory({
    cutId: input.cutId,
    expectedMemberCount: 0,
    expectedInventoryDigest: providerThreadArchiveCompleteInventoryDigestV57(
      [],
    ),
    enumerationAuthorityDigest: digest("5"),
    sealRevisionDigest: digest("6"),
    now: NOW,
  });
  input.journal.markRemovalAwaitingTombstone({
    cutId: input.cutId,
    containmentEvidenceDigest: digest("7"),
    containmentRevisionDigest: digest("8"),
    targets: [],
    now: NOW,
  });
  const removedAt = new Date(NOW.getTime() + 1_000).toISOString();
  const accountProfileRevision = profile.revision + 1;
  const updated = input.database.query(`
    UPDATE account_profiles SET removed_at = ?2, selected = 0,
      local_data_deleted_at = NULL,
      identity_label = NULL, plan_label = NULL, auth_state = 'signedOut',
      revision = ?3, updated_at = ?2
    WHERE profile_id = ?1 AND revision = ?4 AND removed_at IS NULL
  `).run(
    input.accountProfileId,
    removedAt,
    accountProfileRevision,
    profile.revision,
  );
  if (updated.changes !== 1) throw new Error("Expected an account tombstone.");
  input.journal.markRemovalTombstoned({
    cutId: input.cutId,
    tombstoneEvidenceDigest: digest("9"),
    tombstoneRevisionDigest: digest("a"),
    accountProfileRevision,
    removedAt,
    localDataDeletedAt: null,
    profilePreimageDigest:
      providerThreadArchiveAccountTombstonePreimageDigestV57({
        accountProfileId: input.accountProfileId,
        accountProfileRevision,
        processGeneration: profile.process_generation,
        removedAt,
        localDataDeletedAt: null,
      }),
    now: new Date(NOW.getTime() + 2_000),
  });
}

function digest(character: string): string {
  return character.repeat(64);
}
