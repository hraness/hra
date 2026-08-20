import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { assertProperty, fc } from "@hra-internal/test";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  scryptSync,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  ControlPlaneBackupError,
  createEncryptedControlPlaneBackup,
  estimateControlPlaneBackupMemoryBudget,
  inspectEncryptedControlPlaneBackup,
  maximumControlPlaneBackupDatabaseByteLength,
  maximumControlPlaneBackupPeakResidentByteEstimate,
  prepareAuthenticatedControlPlaneRestoreStage,
  recoverInterruptedControlPlaneRestore,
  restoreEncryptedControlPlaneBackup as restoreEncryptedControlPlaneBackupCore,
  verifyEncryptedControlPlaneBackup,
  type RestoreControlPlaneBackupInput,
  type ControlPlaneRestoreFaultPoint,
} from "../src/state/control-plane-backup";
import {
  inspectApplicationSupportReadiness,
  prepareApplicationSupportMigration,
} from "../src/state/application-support";
import { acquireControlPlaneLifetimeLock } from "../src/state/control-plane-lock";
import { defaultControlPlanePath, openControlPlane } from "../src/state/database";
import {
  loadOrCreateOperationReceiptKey,
  operationReceiptKeyPath,
} from "../src/state/operation-receipt-key";
import {
  providerThreadArchiveCompleteInventoryDigestV57,
  ProviderThreadArchiveJournalV57,
} from "../src/state/provider-thread-archive-journal-v57";
import {
  controlPlaneRestoreAttachmentVaultInventorySchema,
  controlPlaneRestoreJournalSchema,
  inspectControlPlaneAttachmentVault,
  maximumControlPlaneAttachmentVaultFileCount,
  maximumControlPlaneRestoreJournalByteLength,
} from "../src/state/control-plane-restore-state";
import {
  currentControlPlaneMigrationVersion,
  inspectControlPlaneReleaseFence,
  preflightControlPlaneRelease,
  type AppReleaseIdentity,
} from "../src/state/release-compatibility";

const release100: AppReleaseIdentity = { version: "1.0.0", build: 100 };
const release110: AppReleaseIdentity = { version: "1.1.0", build: 1 };
const passphrase = "an intentionally long deterministic backup passphrase";
const sourceInstallation = "install_backup_source";
const oldInstallation = "install_backup_old";
const backupAttachmentPaneId = "pane_backup_attachment_0001";
const backupAttachmentAccountId = "acct_backup_attachment_0001";
const backupFileAttachmentId = "attachment_backup_file0001";
const backupImageAttachmentId = "attachment_backup_image001";
const temporaryDirectories: string[] = [];

function backupCandidatePath(archivePath: string): string {
  return join(dirname(archivePath), `.${basename(archivePath)}.hraness-backup-v2.tmp`);
}

function writeMaterializingRestoreJournal(
  target: Readonly<{
    parent: string;
    databasePath: string;
    attachmentVaultRoot: string;
  }>,
  prepared: Readonly<{
    archiveSha256: string;
    databaseSha256: string;
    receiptKeySha256: string;
    attachmentVaultGenerationSha256: string;
    attachmentVaultInventory: unknown;
    stageCustodyNonce: string;
    restoreRootDevice: number;
    restoreRootInode: number;
  }>,
): string {
  const original = snapshotControlPlanePair(target.databasePath);
  const journalPath = join(target.parent, ".control-plane-restore-v2.json");
  writeFileSync(journalPath, JSON.stringify({
    version: 2,
    kind: "hraness-kitchen-control-plane-restore",
    phase: "materializing",
    archiveSha256: prepared.archiveSha256,
    databaseSha256: prepared.databaseSha256,
    receiptKeySha256: prepared.receiptKeySha256,
    attachmentVaultGenerationSha256:
      prepared.attachmentVaultGenerationSha256,
    attachmentVaultInventory: prepared.attachmentVaultInventory,
    stageCustodyNonce: prepared.stageCustodyNonce,
    restoreRootDevice: prepared.restoreRootDevice,
    restoreRootInode: prepared.restoreRootInode,
    hadDatabase: true,
    hadReceiptKey: true,
    hadAttachmentVault: true,
    originalDatabaseSha256: original.database,
    originalReceiptKeySha256: original.receiptKey,
    originalAttachmentVaultGenerationSha256:
      inspectControlPlaneAttachmentVault(target.attachmentVaultRoot)
        .generationSha256,
    originalAttachmentVaultInventory:
      {
        version: 1,
        ...inspectControlPlaneAttachmentVault(target.attachmentVaultRoot),
      },
  }), { mode: 0o600 });
  return journalPath;
}

function advanceRestoreJournalPhase(
  journalPath: string,
  phase: "prepared" | "validated",
): void {
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Record<
    string,
    unknown
  >;
  journal.phase = phase;
  writeFileSync(journalPath, JSON.stringify(journal), { mode: 0o600 });
}

function publishMaterializedStageForTest(target: Readonly<{
  parent: string;
  databasePath: string;
  attachmentVaultRoot: string;
}>): void {
  renameSync(
    target.databasePath,
    join(target.parent, ".control-plane-restore-v2.rollback.sqlite"),
  );
  renameSync(
    join(target.parent, ".control-plane-restore-v2.stage.sqlite"),
    target.databasePath,
  );
  const keyPath = operationReceiptKeyPath(target.databasePath);
  renameSync(
    keyPath,
    join(target.parent, ".control-plane-restore-v2.rollback.hmac.key"),
  );
  renameSync(
    join(target.parent, ".control-plane-restore-v2.stage.hmac.key"),
    keyPath,
  );
  renameSync(
    target.attachmentVaultRoot,
    join(target.parent, ".control-plane-restore-v2.rollback.attachments"),
  );
  renameSync(
    join(target.parent, ".control-plane-restore-v2.stage.attachments"),
    target.attachmentVaultRoot,
  );
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function seedReadyAttachmentVault(source: Readonly<{
  database: Database;
  attachmentVaultRoot: string;
}>): Readonly<{
  file: Buffer;
  canonical: Buffer;
  preview: Buffer;
}> {
  const now = "2026-08-18T12:00:00.000Z";
  source.database.query(`
    INSERT INTO account_profiles (
      profile_id, label, auth_state, process_generation,
      selected, created_at, updated_at
    ) VALUES (?1, 'Backup attachments', 'signed_in', 1, 1, ?2, ?2)
  `).run(backupAttachmentAccountId, now);
  const hasPalette = source.database.query<{ count: number }, []>(`
    SELECT COUNT(*) AS count FROM pragma_table_info('chat_panes')
    WHERE name = 'palette_index'
  `).get()?.count === 1;
  source.database.query(`
    INSERT INTO chat_panes (
      pane_id, ${hasPalette ? "palette_index," : ""}
      display_order, repository_id, repository_name, revision, title,
      account_profile_id, model, reasoning_effort, service_tier,
      interaction_mode, state,
      workspace_mode, workspace_state, workspace_revision,
      workspace_recovery_reason, created_at, updated_at
    ) VALUES (
      ?1, ${hasPalette ? "0," : ""}
      0, ?2, 'Backup attachment fixture', 1, 'Backup attachment fixture',
      ?3, 'gpt-5.6-sol', 'max', 'standard',
      'chat', 'ready', 'managed_worktree', 'preparing', 1,
      NULL, ?4, ?4
    )
  `).run(
    backupAttachmentPaneId,
    `repo_${"b".repeat(26)}`,
    backupAttachmentAccountId,
    now,
  );

  const file = Buffer.from("portable generic attachment", "utf8");
  const canonical = Buffer.from("canonical portable image", "utf8");
  const preview = Buffer.from("preview portable image", "utf8");
  const sourceImage = Buffer.from("original image input", "utf8");
  source.database.query(`
    INSERT INTO chat_attachments (
      attachment_id, upload_id, pane_id, revision, state, kind,
      display_name, declared_media_type, effective_media_type,
      internal_suffix, expected_input_bytes, received_input_bytes,
      source_retained, next_chunk_ordinal, finalize_request_revision,
      requested_input_sha256, input_sha256,
      provider_bytes, provider_sha256, ready_at, created_at, updated_at
    ) VALUES (
      ?1, 'upload_backup_file0001', ?2, 4, 'ready', 'file',
      'notes.txt', 'text/plain', 'text/plain', 'txt', ?3, ?3,
      0, 1, 4, ?4, ?4, ?3, ?4, ?5, ?5, ?5
    )
  `).run(
    backupFileAttachmentId,
    backupAttachmentPaneId,
    file.byteLength,
    createHash("sha256").update(file).digest("hex"),
    now,
  );
  source.database.query(`
    INSERT INTO chat_attachments (
      attachment_id, upload_id, pane_id, revision, state, kind,
      display_name, declared_media_type, effective_media_type,
      internal_suffix, expected_input_bytes, received_input_bytes,
      source_retained, next_chunk_ordinal, finalize_request_revision,
      requested_input_sha256, input_sha256, source_media_type,
      width, height, pixel_count,
      canonical_bytes, canonical_sha256,
      preview_bytes, preview_width, preview_height, preview_sha256,
      provider_bytes, provider_sha256, ready_at, created_at, updated_at
    ) VALUES (
      ?1, 'upload_backup_image001', ?2, 5, 'ready', 'image',
      'image.png', 'image/png', 'image/png', 'png', ?3, ?3,
      0, 1, 5, ?4, ?4, 'image/png',
      4, 2, 8, ?5, ?6, ?7, 4, 2, ?8,
      ?5, ?6, ?9, ?9, ?9
    )
  `).run(
    backupImageAttachmentId,
    backupAttachmentPaneId,
    sourceImage.byteLength,
    createHash("sha256").update(sourceImage).digest("hex"),
    canonical.byteLength,
    createHash("sha256").update(canonical).digest("hex"),
    preview.byteLength,
    createHash("sha256").update(preview).digest("hex"),
    now,
  );

  const fileRoot = join(
    source.attachmentVaultRoot,
    "objects",
    backupFileAttachmentId,
  );
  const normalizedRoot = join(
    source.attachmentVaultRoot,
    "objects",
    backupImageAttachmentId,
    "normalized",
  );
  mkdirSync(fileRoot, { recursive: true, mode: 0o700 });
  mkdirSync(normalizedRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(fileRoot, "blob.txt"), file, { mode: 0o600 });
  writeFileSync(join(normalizedRoot, "canonical.png"), canonical, { mode: 0o600 });
  writeFileSync(join(normalizedRoot, "preview.png"), preview, { mode: 0o600 });
  return { file, canonical, preview };
}

function seedPortableAttachmentProviderAuthority(source: Readonly<{
  database: Database;
  receiptKey: Uint8Array;
}>): void {
  const now = "2026-08-18T12:00:00.000Z";
  source.database.query(`
    INSERT INTO chat_pane_history (
      pane_id, sequence, role, text, utf8_bytes, created_at
    ) VALUES (?1, 1, 'user', ?2, ?3, ?4)
  `).run(
    backupAttachmentPaneId,
    "keep this attachment transcript",
    Buffer.byteLength("keep this attachment transcript", "utf8"),
    now,
  );
  source.database.query(`
    UPDATE chat_panes
    SET provider_account_profile_id = ?1,
        provider_thread_id = ?2,
        provider_restart_thread_id = ?3,
        revision = revision + 1,
        updated_at = ?4
    WHERE pane_id = ?5
  `).run(
    backupAttachmentAccountId,
    "thread_backup_attachment001",
    "restart_backup_attachment001",
    now,
    backupAttachmentPaneId,
  );
  source.database.query(`
    INSERT INTO chat_provider_attachment_bindings (
      binding_id, binding_key_digest, pane_id, revision, state,
      ambiguity_receipt_digest, containment_receipt_digest,
      acquired_at, updated_at, released_at
    ) VALUES (
      'attbinding_backup_portable001', ?1, ?2, 1, 'active',
      NULL, NULL, ?3, ?3, NULL
    )
  `).run("9".repeat(64), backupAttachmentPaneId, now);
  source.database.query(`
    INSERT INTO chat_provider_attachment_leases (
      binding_id, pane_id, attachment_id, acquired_at
    ) VALUES ('attbinding_backup_portable001', ?1, ?2, ?3)
  `).run(backupAttachmentPaneId, backupImageAttachmentId, now);
  source.database.query(`
    INSERT INTO chat_provider_thread_archive_intents (
      pane_id, purpose, state, pane_revision, queue_revision,
      account_profile_id, thread_id, restart_thread_id,
      binding_id, binding_key_digest, binding_revision,
      generation, generation_contained, generation_containment_receipt,
      effect_attempt, ambiguity_receipt,
      reconciliation_disposition, reconciliation_receipt,
      created_at, updated_at
    ) VALUES (
      ?1, 'pane_archive', 'ambiguous', 2, NULL,
      ?2, 'thread_backup_attachment001', 'restart_backup_attachment001',
      'attbinding_backup_portable001', ?3, 1,
      1, 1, 'generation_contained_backup_portable001',
      1, 'archive_ambiguous_backup_portable001',
      'not_applied', 'archive_reconciliation_backup_portable001',
      ?4, ?4
    )
  `).run(
    backupAttachmentPaneId,
    backupAttachmentAccountId,
    "9".repeat(64),
    now,
  );

  const archiveNow = new Date(now);
  const targetId = "archtarget_backupportable01";
  const attemptId = "archattempt_backupportable01";
  const cutId = "archcut_backupportable01";
  const journal = new ProviderThreadArchiveJournalV57(
    source.database,
    source.receiptKey,
  );
  const binding = {
    kind: "exact" as const,
    bindingId: "attbinding_backup_portable001",
    bindingKeyDigest: "9".repeat(64),
    bindingRevision: 1,
  };
  journal.prepareTarget({
    targetId,
    paneId: backupAttachmentPaneId,
    purpose: "pane_archive",
    paneRevision: 2,
    queueRevision: null,
    paneCasDigest: backupDigest("portable-pane-cas"),
    queueCasDigest: null,
    accountProfileId: backupAttachmentAccountId,
    accountProfileRevision: 1,
    threadId: "thread_backup_attachment001",
    restartThreadId: "restart_backup_attachment001",
    binding,
    attempt: {
      attemptId,
      generation: 1,
      accountProfileRevision: 1,
      requestEvidenceDigest: backupDigest("portable-archive-request"),
      requestRevisionDigest: backupDigest("portable-archive-request-revision"),
    },
    now: archiveNow,
  });
  journal.createCut({
    cutId,
    accountProfileId: backupAttachmentAccountId,
    accountProfileRevision: 1,
    sourceGeneration: 1,
    cause: "account_removal",
    initiatingAttemptId: null,
    predecessorCutId: null,
    identityEvidenceDigest: backupDigest("portable-removal-identity"),
    identityRevisionDigest: backupDigest("portable-removal-identity-revision"),
    now: archiveNow,
  });
  journal.bindAllAffectedTargets(cutId);
  journal.recordFence({
    cutId,
    successorGeneration: null,
    successorAccountProfileRevision: null,
    fenceEvidenceDigest: backupDigest("portable-removal-fence"),
    fenceRevisionDigest: backupDigest("portable-removal-fence-revision"),
    now: archiveNow,
  });
  const member = {
    memberId: "archmember_backupportable01",
    cutId,
    paneId: backupAttachmentPaneId,
    paneRevision: 2,
    paneCasDigest: backupDigest("portable-member-pane-cas"),
    threadId: "thread_backup_attachment001",
    restartThreadId: "restart_backup_attachment001",
    role: "target",
    targetId,
    attemptId,
    targetAttemptOrdinal: 1,
    action: "preserved_target",
    binding,
    identityEvidenceDigest: backupDigest("portable-member-identity"),
    identityRevisionDigest: backupDigest("portable-member-identity-revision"),
    now: archiveNow,
  } as const;
  journal.addCutMember(member);
  journal.sealCutInventory({
    cutId,
    expectedMemberCount: 1,
    expectedInventoryDigest:
      providerThreadArchiveCompleteInventoryDigestV57([member]),
    enumerationAuthorityDigest: backupDigest(
      "portable-removal-enumeration-authority",
    ),
    sealRevisionDigest: backupDigest("portable-removal-seal-revision"),
    now: archiveNow,
  });
}

function seedUnsealedPortableV57Cut(
  source: Readonly<{
    database: Database;
    receiptKey: Uint8Array;
  }>,
  state: "fence_started" | "fenced",
): void {
  const archiveNow = new Date("2026-08-18T12:00:00.000Z");
  source.database.query(`
    UPDATE chat_panes
    SET provider_account_profile_id = ?1,
        provider_thread_id = 'thread_backup_attachment001',
        provider_restart_thread_id = 'restart_backup_attachment001',
        revision = revision + 1,
        updated_at = ?2
    WHERE pane_id = ?3
  `).run(
    backupAttachmentAccountId,
    archiveNow.toISOString(),
    backupAttachmentPaneId,
  );
  const cutId = state === "fence_started"
    ? "archcut_backupportableunsealed01"
    : "archcut_backupportablepartial01";
  const journal = new ProviderThreadArchiveJournalV57(
    source.database,
    source.receiptKey,
  );
  journal.createCut({
    cutId,
    accountProfileId: backupAttachmentAccountId,
    accountProfileRevision: 1,
    sourceGeneration: 1,
    cause: "account_removal",
    initiatingAttemptId: null,
    predecessorCutId: null,
    identityEvidenceDigest: backupDigest(`unsealed-identity:${state}`),
    identityRevisionDigest: backupDigest(`unsealed-revision:${state}`),
    now: archiveNow,
  });
  if (state === "fence_started") return;
  journal.bindAllAffectedTargets(cutId);
  journal.recordFence({
    cutId,
    successorGeneration: null,
    successorAccountProfileRevision: null,
    fenceEvidenceDigest: backupDigest("unsealed-fence"),
    fenceRevisionDigest: backupDigest("unsealed-fence-revision"),
    now: archiveNow,
  });
  journal.addCutMember({
    memberId: "archmember_backupportablepartial01",
    cutId,
    paneId: backupAttachmentPaneId,
    paneRevision: 2,
    paneCasDigest: backupDigest("unsealed-member-pane-cas"),
    threadId: "thread_backup_attachment001",
    restartThreadId: "restart_backup_attachment001",
    role: "sibling",
    targetId: null,
    attemptId: null,
    targetAttemptOrdinal: null,
    action: "detach_binding_only",
    binding: { kind: "none" },
    identityEvidenceDigest: backupDigest("unsealed-member-identity"),
    identityRevisionDigest: backupDigest("unsealed-member-revision"),
    now: archiveNow,
  });
}

function backupDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fileSha256ForGeneration(
  proof: ReturnType<typeof inspectControlPlaneAttachmentVault>,
): string {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    blobs: proof.blobs,
    totalBytes: proof.totalBytes,
  })).digest("hex");
}

describe("encrypted control-plane backup and restore", () => {
  test("uses one additive owned-buffer law at the maximum valid state", () => {
    const maximum = estimateControlPlaneBackupMemoryBudget({
      databaseByteLength: maximumControlPlaneBackupDatabaseByteLength,
      vaultManifestByteLength: 8 * 1_024 * 1_024,
      vaultBlobByteLength: 512 * 1_024 * 1_024,
    });
    expect(maximum.peakResidentByteEstimate)
      .toBe(maximumControlPlaneBackupPeakResidentByteEstimate);
    const emptyVault = estimateControlPlaneBackupMemoryBudget({
      databaseByteLength: 4 * 1_024 * 1_024,
      vaultManifestByteLength: 64,
      vaultBlobByteLength: 0,
    });
    expect(emptyVault.maximumBufferedPlaintextBytes)
      .toBeGreaterThan(4 * 1_024 * 1_024 + 64);

    const root = privateTemporaryDirectory("oprte-backup-memory-owners-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    let observedOwnedDatabaseImages = 0;
    const created = createEncryptedControlPlaneBackup({
      database: source.database,
      destinationPath: join(root, "control-plane.hkb"),
      attachmentVaultRoot: source.attachmentVaultRoot,
      operationReceiptKey: source.receiptKey,
      passphrase,
      releaseIdentity: release100,
      onMemoryOwnershipCheckpoint: (ownedDatabaseImages) => {
        observedOwnedDatabaseImages = Math.max(
          observedOwnedDatabaseImages,
          ownedDatabaseImages,
        );
      },
    });
    expect(observedOwnedDatabaseImages).toBe(4);
    const verified = verifyEncryptedControlPlaneBackup({
      archivePath: join(root, "control-plane.hkb"),
      passphrase,
      releaseIdentity: release100,
    });
    expect({
      peakResidentByteEstimate: verified.peakResidentByteEstimate,
      maximumBufferedPlaintextBytes: verified.maximumBufferedPlaintextBytes,
    }).toEqual({
      peakResidentByteEstimate: created.peakResidentByteEstimate,
      maximumBufferedPlaintextBytes: created.maximumBufferedPlaintextBytes,
    });
    source.database.close();
  });

  test("enforces passphrase and archive-confirmation bounds at the core API", () => {
    const root = privateTemporaryDirectory("oprte-backup-auth-boundary-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const archivePath = join(root, "control-plane.hkb");
    for (const invalidPassphrase of ["short", "x".repeat(4_097)]) {
      expect(() => createEncryptedControlPlaneBackup({
        database: source.database,
        destinationPath: archivePath,
        operationReceiptKey: source.receiptKey,
        passphrase: invalidPassphrase,
        releaseIdentity: release100,
        attachmentVaultRoot: source.attachmentVaultRoot,
      })).toThrow(expect.objectContaining({ code: "invalid_input" }));
      expect(existsSync(archivePath)).toBe(false);
    }
    const backup = createBackup(source, archivePath, release100);
    source.database.close();
    for (const invalidPassphrase of ["short", "x".repeat(4_097)]) {
      expect(() => verifyEncryptedControlPlaneBackup({
        archivePath,
        passphrase: invalidPassphrase,
        releaseIdentity: release100,
      })).toThrow(expect.objectContaining({ code: "invalid_input" }));
    }

    const target = createControlPlane(root, "target", release100, oldInstallation);
    checkpointAndClose(target.database);
    expect(() => {
      Reflect.apply(restoreEncryptedControlPlaneBackupCore, null, [{
        archivePath,
        databasePath: target.databasePath,
        passphrase,
        releaseIdentity: release100,
      }]);
    }).toThrow(expect.objectContaining({
      code: "confirmation_failed",
    }));
    expect(() => prepareAuthenticatedControlPlaneRestoreStage({
      archivePath,
      databasePath: target.databasePath,
      passphrase: "short",
      releaseIdentity: release100,
      confirmedArchiveSha256: backup.archiveSha256,
    })).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  test("refuses to publish a portable backup while a scheduled chat is active", () => {
    const root = privateTemporaryDirectory("hra-backup-active-schedule-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    seedPortableScheduledChatState(source.database, "active");
    const archivePath = join(root, "control-plane.hkb");

    const failure = captureControlPlaneBackupError(() => {
      createBackup(source, archivePath, release100);
    });
    expect(failure.code).toBe("invalid_input");
    expect(failure.message).toContain("Turn off scheduled chats first");
    expect(existsSync(archivePath)).toBe(false);
    expect(existsSync(backupCandidatePath(archivePath))).toBe(false);
    expect(source.database.query(`
      SELECT COUNT(*) AS count FROM chat_scheduled_chats
    `).get()).toEqual({ count: 1 });
    source.database.close();
  });

  test("refuses to publish while a scheduled-chat mutation may have reached cloud", () => {
    for (const state of ["prepared", "effect_started"] as const) {
      const root = privateTemporaryDirectory(`hra-backup-schedule-${state}-`);
      const source = createControlPlane(
        root,
        "source",
        release100,
        sourceInstallation,
      );
      seedPortableScheduledChatState(source.database, state);
      const archivePath = join(root, "control-plane.hkb");

      const failure = captureControlPlaneBackupError(() => {
        createBackup(source, archivePath, release100);
      });
      expect(failure.code).toBe("invalid_input");
      expect(failure.message).toContain("Turn off scheduled chats first");
      expect(existsSync(archivePath)).toBe(false);
      expect(existsSync(backupCandidatePath(archivePath))).toBe(false);
      expect(source.database.query(`
        SELECT state FROM chat_scheduled_chat_mutations
      `).get()).toEqual({ state });
      source.database.close();
    }
  });

  test("allows a cleared scheduled-chat high-water and terminal run in a portable backup", () => {
    const root = privateTemporaryDirectory("hra-backup-cleared-schedule-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    seedPortableScheduledChatState(source.database, "cleared");
    const archivePath = join(root, "control-plane.hkb");

    const backup = createBackup(source, archivePath, release100);
    expect(verifyEncryptedControlPlaneBackup({
      archivePath,
      passphrase,
      releaseIdentity: release100,
    })).toMatchObject({ archiveSha256: backup.archiveSha256 });
    expect(source.database.query(`
      SELECT generation FROM chat_scheduled_chat_generation_high_water
    `).get()).toEqual({ generation: "7" });
    source.database.close();
  }, 60_000);

  test("verifies and restores a valid v61 portable schedule snapshot", () => {
    const root = privateTemporaryDirectory("hra-backup-v61-schedule-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    seedPortableScheduledChatState(source.database, "cleared");
    downgradeScheduledChatSchemaToV61(source.database);
    const archivePath = join(root, "control-plane.hkb");

    const backup = createBackup(source, archivePath, release100);
    source.database.close();
    expect(backup.manifest.sourceMigrationVersion).toBe(61);
    expect(verifyEncryptedControlPlaneBackup({
      archivePath,
      passphrase,
      releaseIdentity: release100,
    })).toMatchObject({
      archiveSha256: backup.archiveSha256,
      verifiedMigrationVersion: 61,
    });

    const target = createControlPlane(root, "target", release100, oldInstallation);
    checkpointAndClose(target.database);
    expect(restoreEncryptedControlPlaneBackup({
      archivePath,
      databasePath: target.databasePath,
      passphrase,
      releaseIdentity: release100,
      confirmedArchiveSha256: backup.archiveSha256,
    })).toMatchObject({
      archiveSha256: backup.archiveSha256,
      restoredMigrationVersion: 61,
    });
    const restored = openControlPlane(target.databasePath, {
      releaseIdentity: release100,
      now: () => 2,
    });
    try {
      expect(restored.query(`
        SELECT MAX(version) AS version FROM schema_migrations
      `).get()).toEqual({ version: currentControlPlaneMigrationVersion });
      expect(restored.query(`
        SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name = 'chat_scheduled_chat_desired_off'
      `).get()).toEqual({ name: "chat_scheduled_chat_desired_off" });
      expect(restored.query(`
        SELECT generation FROM chat_scheduled_chat_generation_high_water
      `).get()).toEqual({ generation: "7" });
    } finally {
      restored.close();
    }
  }, 60_000);

  test("refuses an older restore before mutating a destination with an active scheduled chat", () => {
    const root = privateTemporaryDirectory("hra-restore-active-schedule-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const archivePath = join(root, "older-control-plane.hkb");
    const backup = createBackup(source, archivePath, release100);
    source.database.close();

    const target = createControlPlane(root, "target", release100, oldInstallation);
    seedPortableScheduledChatState(target.database, "active");
    checkpointAndClose(target.database);
    const before = snapshotControlPlanePair(target.databasePath);
    const vaultBefore = inspectControlPlaneAttachmentVault(
      target.attachmentVaultRoot,
    );

    const failure = captureControlPlaneBackupError(() => {
      restoreEncryptedControlPlaneBackup({
        archivePath,
        databasePath: target.databasePath,
        passphrase,
        releaseIdentity: release100,
        confirmedArchiveSha256: backup.archiveSha256,
      });
    });
    expect(failure.code).toBe("invalid_input");
    expect(failure.message).toContain("Turn off scheduled chats first");
    expect(snapshotControlPlanePair(target.databasePath)).toEqual(before);
    expect(inspectControlPlaneAttachmentVault(target.attachmentVaultRoot))
      .toEqual(vaultBefore);
    for (const restoreArtifact of [
      ".control-plane-restore-v2.json",
      ".control-plane-restore-v2.json.tmp",
      ".control-plane-restore-v2.stage.sqlite",
      ".control-plane-restore-v2.rollback.sqlite",
      ".control-plane-restore-v2.stage.hmac.key",
      ".control-plane-restore-v2.rollback.hmac.key",
      ".control-plane-restore-v2.stage.attachments",
      ".control-plane-restore-v2.rollback.attachments",
    ]) {
      expect(existsSync(join(target.parent, restoreArtifact))).toBe(false);
    }
    const restored = new Database(target.databasePath, {
      readonly: true,
      strict: true,
    });
    try {
      expect(restored.query(`
        SELECT COUNT(*) AS count FROM chat_scheduled_chats
      `).get()).toEqual({ count: 1 });
      expect(restored.query(`
        SELECT installation_id FROM local_installations
      `).all()).toEqual([{ installation_id: oldInstallation }]);
    } finally {
      restored.close();
    }
  }, 60_000);

  test("round-trips SQLite control-plane state and its non-credential receipt key", () => {
    const root = privateTemporaryDirectory("oprte-backup-roundtrip-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const archivePath = join(root, "control-plane.hkb");
    const result = createBackup(source, archivePath, release100);
    source.database.close();

    expect(result.manifest).toMatchObject({
      formatVersion: 2,
      kind: "hraness-kitchen-control-plane-backup",
      sourceRelease: release100,
      sourceMigrationVersion: currentControlPlaneMigrationVersion,
      checkpointProof: {
        busy: 0,
        sourceQuickCheck: "ok",
        snapshotQuickCheck: "ok",
      },
      kdf: {
        name: "scrypt",
        cost: 131_072,
        blockSize: 8,
        parallelization: 1,
      },
      cipher: { name: "aes-256-gcm" },
    });
    expect(inspectEncryptedControlPlaneBackup(archivePath)).toEqual(result.manifest);
    expect(verifyEncryptedControlPlaneBackup({
      archivePath,
      passphrase,
      releaseIdentity: release100,
    })).toMatchObject({
      archiveSha256: result.archiveSha256,
      manifest: result.manifest,
      verifiedMigrationVersion: currentControlPlaneMigrationVersion,
    });
    expect(lstatSync(archivePath).mode & 0o777).toBe(0o600);
    const archiveText = readFileSync(archivePath).toString("latin1");
    expect(archiveText).not.toContain(passphrase);
    expect(archiveText).not.toContain(sourceInstallation);

    const target = createControlPlane(root, "target", release100, oldInstallation);
    const oldKey = Uint8Array.from(target.receiptKey);
    checkpointAndClose(target.database);
    expect(oldKey).not.toEqual(source.receiptKey);

    expect(restoreEncryptedControlPlaneBackup({
      archivePath,
      databasePath: target.databasePath,
      passphrase,
      releaseIdentity: release100,
    })).toMatchObject({
      archiveSha256: result.archiveSha256,
      restoredMigrationVersion: currentControlPlaneMigrationVersion,
    });
    expect(readInstallationIds(target.databasePath)).toContain(sourceInstallation);
    expect(readInstallationIds(target.databasePath)).not.toContain(oldInstallation);
    expect(loadOrCreateOperationReceiptKey(
      operationReceiptKeyPath(target.databasePath),
    )).toEqual(source.receiptKey);
    expect(lstatSync(target.parent).mode & 0o777).toBe(0o700);
    expect(lstatSync(target.databasePath).mode & 0o777).toBe(0o600);
    expect(
      lstatSync(operationReceiptKeyPath(target.databasePath)).mode & 0o777,
    ).toBe(0o600);
    expect(recoverInterruptedControlPlaneRestore(target.databasePath)).toEqual({
      kind: "none",
    });
  }, 60_000);

  test("authenticates a complete ready file and image attachment generation", () => {
    const root = privateTemporaryDirectory("oprte-backup-attachments-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const attachmentBytes = seedReadyAttachmentVault(source);
    const archivePath = join(root, "control-plane.hkb");
    const result = createBackup(source, archivePath, release100);
    source.database.close();

    expect(result.manifest.attachmentVault).toEqual({
      blobCount: 3,
      totalBytes: attachmentBytes.file.byteLength
        + attachmentBytes.canonical.byteLength
        + attachmentBytes.preview.byteLength,
      providerHomesIncluded: false,
      rolloutStateIncluded: false,
      restoredAttachmentProviderContext: "fresh_send_required",
    });
    expect(verifyEncryptedControlPlaneBackup({
      archivePath,
      passphrase,
      releaseIdentity: release100,
    })).toMatchObject({
      archiveSha256: result.archiveSha256,
      manifest: {
        attachmentVault: result.manifest.attachmentVault,
      },
    });
  }, 60_000);

  test("keeps private attachment and chat identity out of the plaintext outer manifest", () => {
    const root = privateTemporaryDirectory("oprte-backup-private-manifest-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const attachmentBytes = seedReadyAttachmentVault(source);
    seedPortableAttachmentProviderAuthority(source);
    const archivePath = join(root, "control-plane.hkb");
    const result = createBackup(source, archivePath, release100);
    source.database.close();

    const archive = Buffer.from(readFileSync(archivePath));
    const manifestLength = archive.readUInt32BE(8);
    const manifestText = archive.subarray(12, 12 + manifestLength).toString("utf8");
    expect(JSON.parse(manifestText)).toEqual(result.manifest);
    const privateValues = [
      sourceInstallation,
      backupAttachmentAccountId,
      backupAttachmentPaneId,
      backupFileAttachmentId,
      backupImageAttachmentId,
      "thread_backup_attachment001",
      "restart_backup_attachment001",
      "attbinding_backup_portable001",
      "generation_contained_backup_portable001",
      "archive_ambiguous_backup_portable001",
      "archive_reconciliation_backup_portable001",
      "archtarget_backupportable01",
      "archattempt_backupportable01",
      "archcut_backupportable01",
      "archmember_backupportable01",
      source.attachmentVaultRoot,
      "notes.txt",
      "image.png",
      "blob.txt",
      "normalized/canonical.png",
      "keep this attachment transcript",
      ...Object.values(attachmentBytes).map((bytes) =>
        createHash("sha256").update(bytes).digest("hex")
      ),
    ];
    for (const privateValue of privateValues) {
      expect(manifestText).not.toContain(privateValue);
    }
  }, 60_000);

  test("restores attachment bytes while removing resumable provider authority only from the portable copy", () => {
    const root = privateTemporaryDirectory("oprte-backup-portable-attachments-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const attachmentBytes = seedReadyAttachmentVault(source);
    seedPortableAttachmentProviderAuthority(source);
    const sourceDatabaseBefore = Buffer.from(source.database.serialize());
    sourceDatabaseBefore[18] = 1;
    sourceDatabaseBefore[19] = 1;
    const sourceVaultBefore = [
      readFileSync(join(
        source.attachmentVaultRoot,
        "objects",
        backupFileAttachmentId,
        "blob.txt",
      )),
      readFileSync(join(
        source.attachmentVaultRoot,
        "objects",
        backupImageAttachmentId,
        "normalized",
        "canonical.png",
      )),
      readFileSync(join(
        source.attachmentVaultRoot,
        "objects",
        backupImageAttachmentId,
        "normalized",
        "preview.png",
      )),
    ];
    const archivePath = join(root, "control-plane.hkb");
    const backup = createBackup(source, archivePath, release100);

    expect(backup.manifest.sourceHashes.sourceDatabaseSha256)
      .not.toBe(backup.manifest.sourceHashes.projectedDatabaseSha256);
    expect(backup.manifest.portableProviderContext).toMatchObject({
      version: 3,
      affectedPaneCount: 1,
      removedBindingCount: 1,
      removedLeaseCount: 1,
      removedArchiveIntentCount: 1,
      removedArchiveTargetCount: 1,
      removedArchiveAttemptCount: 1,
      removedArchiveCutCount: 1,
      removedArchiveCutMemberCount: 1,
      requiresFreshSend: true,
    });
    expect(source.database.query(`
      SELECT state FROM chat_provider_attachment_bindings
      WHERE binding_id = 'attbinding_backup_portable001'
    `).get()).toEqual({ state: "active" });
    expect(source.database.query(`
      SELECT attachment_id FROM chat_provider_attachment_leases
      WHERE binding_id = 'attbinding_backup_portable001'
    `).get()).toEqual({ attachment_id: backupImageAttachmentId });
    expect(source.database.query(`
      SELECT purpose, state, generation_containment_receipt,
             ambiguity_receipt, reconciliation_receipt
      FROM chat_provider_thread_archive_intents
      WHERE pane_id = ?1
    `).get(backupAttachmentPaneId)).toEqual({
      purpose: "pane_archive",
      state: "ambiguous",
      generation_containment_receipt:
        "generation_contained_backup_portable001",
      ambiguity_receipt: "archive_ambiguous_backup_portable001",
      reconciliation_receipt: "archive_reconciliation_backup_portable001",
    });
    expect(source.database.query(`
      SELECT
        (SELECT COUNT(*) FROM chat_provider_thread_archive_targets_v57) AS targets,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_attempts_v57) AS attempts,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_cuts_v57) AS cuts,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_cut_members_v57) AS members
    `).get()).toEqual({ targets: 1, attempts: 1, cuts: 1, members: 1 });
    const sourceDatabaseAfter = Buffer.from(source.database.serialize());
    sourceDatabaseAfter[18] = 1;
    sourceDatabaseAfter[19] = 1;
    expect(sourceDatabaseAfter).toEqual(sourceDatabaseBefore);
    expect([
      readFileSync(join(
        source.attachmentVaultRoot,
        "objects",
        backupFileAttachmentId,
        "blob.txt",
      )),
      readFileSync(join(
        source.attachmentVaultRoot,
        "objects",
        backupImageAttachmentId,
        "normalized",
        "canonical.png",
      )),
      readFileSync(join(
        source.attachmentVaultRoot,
        "objects",
        backupImageAttachmentId,
        "normalized",
        "preview.png",
      )),
    ]).toEqual(sourceVaultBefore);
    source.database.close();

    const target = createControlPlane(root, "target", release100, oldInstallation);
    checkpointAndClose(target.database);
    restoreEncryptedControlPlaneBackup({
      archivePath,
      databasePath: target.databasePath,
      passphrase,
      releaseIdentity: release100,
    });

    expect(readFileSync(join(
      target.attachmentVaultRoot,
      "objects",
      backupFileAttachmentId,
      "blob.txt",
    )).toString("hex")).toBe(attachmentBytes.file.toString("hex"));
    expect(readFileSync(join(
      target.attachmentVaultRoot,
      "objects",
      backupImageAttachmentId,
      "normalized",
      "canonical.png",
    )).toString("hex")).toBe(attachmentBytes.canonical.toString("hex"));
    expect(readFileSync(join(
      target.attachmentVaultRoot,
      "objects",
      backupImageAttachmentId,
      "normalized",
      "preview.png",
    )).toString("hex")).toBe(attachmentBytes.preview.toString("hex"));

    const restored = openControlPlane(target.databasePath, {
      releaseIdentity: release100,
      now: () => 1,
    });
    try {
      expect(restored.query(`
        SELECT COUNT(*) AS count FROM chat_provider_attachment_bindings
      `).get()).toEqual({ count: 0 });
      expect(restored.query(`
        SELECT COUNT(*) AS count FROM chat_provider_attachment_leases
      `).get()).toEqual({ count: 0 });
      expect(restored.query(`
        SELECT COUNT(*) AS count FROM chat_provider_thread_archive_intents
      `).get()).toEqual({ count: 0 });
      expect(restored.query(`
        SELECT
          (SELECT COUNT(*) FROM chat_provider_thread_archive_targets_v57) AS targets,
          (SELECT COUNT(*) FROM chat_provider_thread_archive_attempts_v57) AS attempts,
          (SELECT COUNT(*) FROM chat_provider_thread_archive_cuts_v57) AS cuts,
          (SELECT COUNT(*) FROM chat_provider_thread_archive_cut_members_v57) AS members
      `).get()).toEqual({ targets: 0, attempts: 0, cuts: 0, members: 0 });
      expect(restored.query(`
        SELECT state, provider_account_profile_id, provider_thread_id,
               provider_restart_thread_id, provider_context_reset_required,
               provider_history_floor_sequence, attention_code,
               attention_retryable, message_queue_pause_reason
        FROM chat_panes WHERE pane_id = ?1
      `).get(backupAttachmentPaneId)).toEqual({
        state: "attention",
        provider_account_profile_id: null,
        provider_thread_id: null,
        provider_restart_thread_id: null,
        provider_context_reset_required: 1,
        provider_history_floor_sequence: 1,
        attention_code: "runtime_unavailable",
        attention_retryable: 0,
        message_queue_pause_reason: "attention",
      });
      expect(restored.query(`
        SELECT sequence, role, text FROM chat_pane_history
        WHERE pane_id = ?1 ORDER BY sequence
      `).all(backupAttachmentPaneId)).toEqual([{
        sequence: 1,
        role: "user",
        text: "keep this attachment transcript",
      }]);
    } finally {
      restored.close();
    }
  }, 60_000);

  test("rejects unsealed portable v57 cuts without changing source database or vault bytes", () => {
    for (const state of ["fence_started", "fenced"] as const) {
      const root = privateTemporaryDirectory(
        `oprte-backup-portable-v57-${state}-`,
      );
      const source = createControlPlane(
        root,
        "source",
        release100,
        sourceInstallation,
      );
      seedReadyAttachmentVault(source);
      seedUnsealedPortableV57Cut(source, state);
      const sourceDatabaseBefore = Buffer.from(source.database.serialize());
      sourceDatabaseBefore[18] = 1;
      sourceDatabaseBefore[19] = 1;
      const sourceVaultBefore = [
        readFileSync(join(
          source.attachmentVaultRoot,
          "objects",
          backupFileAttachmentId,
          "blob.txt",
        )),
        readFileSync(join(
          source.attachmentVaultRoot,
          "objects",
          backupImageAttachmentId,
          "normalized",
          "canonical.png",
        )),
        readFileSync(join(
          source.attachmentVaultRoot,
          "objects",
          backupImageAttachmentId,
          "normalized",
          "preview.png",
        )),
      ];
      const archivePath = join(root, `control-plane-${state}.hkb`);

      expect(() => createBackup(source, archivePath, release100))
        .toThrow("complete sealed inventory");

      const sourceDatabaseAfter = Buffer.from(source.database.serialize());
      sourceDatabaseAfter[18] = 1;
      sourceDatabaseAfter[19] = 1;
      expect(sourceDatabaseAfter).toEqual(sourceDatabaseBefore);
      expect([
        readFileSync(join(
          source.attachmentVaultRoot,
          "objects",
          backupFileAttachmentId,
          "blob.txt",
        )),
        readFileSync(join(
          source.attachmentVaultRoot,
          "objects",
          backupImageAttachmentId,
          "normalized",
          "canonical.png",
        )),
        readFileSync(join(
          source.attachmentVaultRoot,
          "objects",
          backupImageAttachmentId,
          "normalized",
          "preview.png",
        )),
      ]).toEqual(sourceVaultBefore);
      expect(source.database.query(`
        SELECT state FROM chat_provider_thread_archive_cuts_v57
      `).get()).toEqual({ state });
      expect(existsSync(archivePath)).toBe(false);
      expect(existsSync(backupCandidatePath(archivePath))).toBe(false);
      source.database.close();
    }
  }, 60_000);

  test("rejects authenticated portable v57 removal-count tampering before restore staging", () => {
    const root = privateTemporaryDirectory("oprte-backup-portable-v57-count-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    seedReadyAttachmentVault(source);
    seedPortableAttachmentProviderAuthority(source);
    const archivePath = join(root, "control-plane.hkb");
    createBackup(source, archivePath, release100);
    source.database.close();

    const tamperedPath = join(root, "portable-count-tampered.hkb");
    writeAuthenticatedPortableCountCorruption(archivePath, tamperedPath);
    expect(inspectEncryptedControlPlaneBackup(tamperedPath).portableProviderContext)
      .toMatchObject({
        removedArchiveTargetCount: 1,
        removedArchiveAttemptCount: 1,
        removedArchiveCutCount: 2,
        removedArchiveCutMemberCount: 1,
      });
    expect(() => verifyEncryptedControlPlaneBackup({
      archivePath: tamperedPath,
      passphrase,
      releaseIdentity: release100,
    })).toThrow("portable provider-context proof is not bound to this receipt key");

    const target = createControlPlane(root, "target", release100, oldInstallation);
    checkpointAndClose(target.database);
    const targetBefore = snapshotControlPlanePair(target.databasePath);
    expect(() => prepareAuthenticatedControlPlaneRestoreStage({
      archivePath: tamperedPath,
      databasePath: target.databasePath,
      passphrase,
      releaseIdentity: release100,
      confirmedArchiveSha256: fileSha256(tamperedPath),
    })).toThrow("portable provider-context proof is not bound to this receipt key");
    expect(snapshotControlPlanePair(target.databasePath)).toEqual(targetBefore);
    expect(existsSync(join(
      target.parent,
      ".control-plane-restore-v2.stage.sqlite",
    ))).toBe(false);
  }, 60_000);

  test("resumes committed attachment-vault rollback cleanup after a blob-removal crash", () => {
    const root = privateTemporaryDirectory("oprte-backup-vault-cleanup-crash-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const expectedBytes = seedReadyAttachmentVault(source);
    const archivePath = join(root, "control-plane.hkb");
    const backup = createBackup(source, archivePath, release100);
    source.database.close();

    const target = createControlPlane(root, "target", release100, oldInstallation);
    seedReadyAttachmentVault(target);
    checkpointAndClose(target.database);
    expect(() => restoreEncryptedControlPlaneBackup({
      archivePath,
      databasePath: target.databasePath,
      passphrase,
      releaseIdentity: release100,
      leaveInterruptedOnFault: true,
      onCheckpoint: (point) => {
        if (point === "after_first_vault_rollback_blob_removed") {
          throw new Error("simulated vault rollback cleanup crash");
        }
      },
    })).toThrow("simulated vault rollback cleanup crash");

    expect(recoverInterruptedControlPlaneRestore(target.databasePath)).toEqual({
      kind: "completed",
      phase: "validated",
    });
    expect(recoverInterruptedControlPlaneRestore(target.databasePath)).toEqual({
      kind: "none",
    });
    expect(readFileSync(join(
      target.attachmentVaultRoot,
      "objects",
      backupImageAttachmentId,
      "normalized",
      "canonical.png",
    )).toString("hex")).toBe(expectedBytes.canonical.toString("hex"));
    expect(inspectControlPlaneAttachmentVault(target.attachmentVaultRoot)
      .generationSha256).toBe(
        backup.manifest.sourceHashes.attachmentVaultGenerationSha256,
      );
  }, 60_000);

  test("rolls back a partially removed replacement attachment vault", () => {
    const root = privateTemporaryDirectory("oprte-backup-vault-partial-rollback-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    seedReadyAttachmentVault(source);
    const archivePath = join(root, "control-plane.hkb");
    createBackup(source, archivePath, release100);
    source.database.close();

    const target = createControlPlane(root, "target", release100, oldInstallation);
    checkpointAndClose(target.database);
    expect(() => restoreEncryptedControlPlaneBackup({
      archivePath,
      databasePath: target.databasePath,
      passphrase,
      releaseIdentity: release100,
      leaveInterruptedOnFault: true,
      onCheckpoint: (point) => {
        if (point === "after_vault_replaced") {
          throw new Error("simulated pre-validation vault crash");
        }
      },
    })).toThrow("simulated pre-validation vault crash");
    unlinkSync(join(
      target.attachmentVaultRoot,
      "objects",
      backupFileAttachmentId,
      "blob.txt",
    ));

    expect(recoverInterruptedControlPlaneRestore(target.databasePath)).toEqual({
      kind: "rolled_back",
      phase: "vault_replaced",
    });
    expect(readInstallationIds(target.databasePath)).toContain(oldInstallation);
    expect(inspectControlPlaneAttachmentVault(target.attachmentVaultRoot)).toMatchObject({
      blobs: [],
      totalBytes: 0,
    });
  }, 60_000);

  test("fails closed on missing, extra, or kind-impossible live vault bytes", () => {
    for (const variant of ["missing", "extra", "wrong_kind"] as const) {
      const root = privateTemporaryDirectory(`oprte-backup-vault-${variant}-`);
      const source = createControlPlane(root, "source", release100, sourceInstallation);
      seedReadyAttachmentVault(source);
      const fileRoot = join(
        source.attachmentVaultRoot,
        "objects",
        backupFileAttachmentId,
      );
      if (variant === "missing") {
        unlinkSync(join(fileRoot, "blob.txt"));
      } else if (variant === "extra") {
        const extraRoot = join(
          source.attachmentVaultRoot,
          "objects",
          "attachment_backup_extra0001",
        );
        mkdirSync(extraRoot, { mode: 0o700 });
        writeFileSync(join(extraRoot, "blob.bin"), "unowned", { mode: 0o600 });
      } else {
        unlinkSync(join(fileRoot, "blob.txt"));
        mkdirSync(join(fileRoot, "normalized"), { mode: 0o700 });
        writeFileSync(
          join(fileRoot, "normalized", "canonical.png"),
          "canonical",
          { mode: 0o600 },
        );
        writeFileSync(
          join(fileRoot, "normalized", "preview.png"),
          "preview",
          { mode: 0o600 },
        );
      }

      expect(() => createBackup(
        source,
        join(root, "control-plane.hkb"),
        release100,
      )).toThrow(ControlPlaneBackupError);
      source.database.close();
    }
  }, 60_000);

  test("canonicalizes attachment generations independently of creation order", () => {
    const entries: ("file" | "canonical" | "preview")[] = [
      "file",
      "canonical",
      "preview",
    ];
    assertProperty(
      fc.property(
        fc.shuffledSubarray(entries, {
          minLength: entries.length,
          maxLength: entries.length,
        }),
        (creationOrder) => {
          const root = privateTemporaryDirectory("oprte-backup-vault-order-");
          const objectsRoot = join(root, "objects");
          const fileRoot = join(objectsRoot, backupFileAttachmentId);
          const imageRoot = join(objectsRoot, backupImageAttachmentId);
          mkdirSync(fileRoot, { recursive: true, mode: 0o700 });
          mkdirSync(join(imageRoot, "normalized"), {
            recursive: true,
            mode: 0o700,
          });
          for (const entry of creationOrder) {
            const path = entry === "file"
              ? join(fileRoot, "blob.txt")
              : join(imageRoot, "normalized", `${entry}.png`);
            writeFileSync(path, entry, { mode: 0o600 });
          }
          const proof = inspectControlPlaneAttachmentVault(root);
          expect(proof.blobs.map(({ relativePath }) => relativePath)).toEqual([
            `${backupFileAttachmentId}/blob.txt`,
            `${backupImageAttachmentId}/normalized/canonical.png`,
            `${backupImageAttachmentId}/normalized/preview.png`,
          ]);
          expect(proof.generationSha256).toBe(fileSha256ForGeneration(proof));
        },
      ),
      { numRuns: 24 },
    );
  });

  test("authenticates before writing the fixed descriptor-bound restore stage", () => {
    const root = privateTemporaryDirectory("oprte-backup-stream-stage-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    seedReadyAttachmentVault(source);
    const archivePath = join(root, "control-plane.hkb");
    const backup = createBackup(source, archivePath, release100);
    source.database.close();

    const target = createControlPlane(root, "target", release100, oldInstallation);
    checkpointAndClose(target.database);
    const before = snapshotControlPlanePair(target.databasePath);
    const prepared = prepareAuthenticatedControlPlaneRestoreStage({
      archivePath,
      databasePath: target.databasePath,
      passphrase,
      releaseIdentity: release100,
      confirmedArchiveSha256: backup.archiveSha256,
    });
    expect(prepared).toMatchObject({
      archiveSha256: backup.archiveSha256,
      restoredMigrationVersion: currentControlPlaneMigrationVersion,
      attachmentVaultGenerationSha256:
        backup.manifest.sourceHashes.attachmentVaultGenerationSha256,
    });
    const databaseStage = join(
      target.parent,
      ".control-plane-restore-v2.stage.sqlite",
    );
    const keyStage = join(
      target.parent,
      ".control-plane-restore-v2.stage.hmac.key",
    );
    const vaultStage = join(
      target.parent,
      ".control-plane-restore-v2.stage.attachments",
    );
    expect(existsSync(databaseStage)).toBe(false);
    expect(existsSync(keyStage)).toBe(false);
    expect(existsSync(vaultStage)).toBe(false);
    writeMaterializingRestoreJournal(target, prepared);
    const materialized = prepared.transferToJournal();
    expect(existsSync(databaseStage)).toBe(true);
    expect(existsSync(keyStage)).toBe(true);
    expect(inspectControlPlaneAttachmentVault(vaultStage).generationSha256)
      .toBe(prepared.attachmentVaultGenerationSha256);
    expect(snapshotControlPlanePair(target.databasePath)).toEqual(before);

    materialized.cleanup();
    expect(existsSync(databaseStage)).toBe(false);
    expect(existsSync(keyStage)).toBe(false);
    expect(existsSync(vaultStage)).toBe(false);
    expect(snapshotControlPlanePair(target.databasePath)).toEqual(before);
  }, 60_000);

  test("retains cleanup custody when an authenticated stage directory is replaced", () => {
    const root = privateTemporaryDirectory("oprte-backup-stage-cleanup-race-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    seedReadyAttachmentVault(source);
    const archivePath = join(root, "control-plane.hkb");
    const backup = createBackup(source, archivePath, release100);
    source.database.close();
    const target = createControlPlane(root, "target", release100, oldInstallation);
    checkpointAndClose(target.database);
    const prepared = prepareAuthenticatedControlPlaneRestoreStage({
      archivePath,
      databasePath: target.databasePath,
      passphrase,
      releaseIdentity: release100,
      confirmedArchiveSha256: backup.archiveSha256,
    });
    writeMaterializingRestoreJournal(target, prepared);
    const materialized = prepared.transferToJournal();
    const vaultStage = join(
      target.parent,
      ".control-plane-restore-v2.stage.attachments",
    );
    const movedVaultStage = `${vaultStage}.moved`;
    renameSync(vaultStage, movedVaultStage);
    mkdirSync(vaultStage, { mode: 0o700 });

    expect(() => materialized.cleanup()).toThrow(ControlPlaneBackupError);
    expect(existsSync(movedVaultStage)).toBe(true);
    expect(existsSync(vaultStage)).toBe(true);

    rmSync(vaultStage, { recursive: true, force: true });
    renameSync(movedVaultStage, vaultStage);
    materialized.cleanup();
    expect(existsSync(vaultStage)).toBe(false);
  }, 60_000);

  test("requires an exact materializing journal before the first stage inode", () => {
    const root = privateTemporaryDirectory("oprte-backup-stage-journal-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const archivePath = join(root, "control-plane.hkb");
    const backup = createBackup(source, archivePath, release100);
    source.database.close();
    const target = createControlPlane(root, "target", release100, oldInstallation);
    checkpointAndClose(target.database);
    const prepared = prepareAuthenticatedControlPlaneRestoreStage({
      archivePath,
      databasePath: target.databasePath,
      passphrase,
      releaseIdentity: release100,
      confirmedArchiveSha256: backup.archiveSha256,
    });
    const journalPath = writeMaterializingRestoreJournal(target, prepared);
    const inconsistent = JSON.parse(readFileSync(journalPath, "utf8")) as Record<
      string,
      unknown
    >;
    inconsistent.originalDatabaseSha256 = null;
    writeFileSync(journalPath, JSON.stringify(inconsistent), { mode: 0o600 });

    expect(() => prepared.transferToJournal()).toThrow(
      "original-state proof is inconsistent",
    );
    for (const path of [
      ".control-plane-restore-v2.stage.sqlite",
      ".control-plane-restore-v2.stage.hmac.key",
      ".control-plane-restore-v2.stage.attachments",
    ]) {
      expect(existsSync(join(target.parent, path))).toBe(false);
    }

    writeMaterializingRestoreJournal(target, prepared);
    prepared.transferToJournal().cleanup();
  }, 60_000);

  test("bounds materializing journal bytes and attachment inventory entries", () => {
    const blobs = Array.from(
      { length: maximumControlPlaneAttachmentVaultFileCount + 1 },
      (_, index) => {
        const attachmentId = `attachment_${index.toString().padStart(8, "0")}`;
        return {
          attachmentId,
          relativePath: `${attachmentId}/blob.bin`,
          bytes: 0,
          sha256: "0".repeat(64),
        };
      },
    );
    expect(controlPlaneRestoreAttachmentVaultInventorySchema.safeParse({
      version: 1,
      generationSha256: "0".repeat(64),
      totalBytes: 0,
      blobs,
    }).success).toBe(false);

    const maximumInventoryBlobs = Array.from(
      { length: maximumControlPlaneAttachmentVaultFileCount },
      (_, index) => {
        const unique = index.toString(36).padStart(8, "0");
        const attachmentId = `attachment_${unique}_${"x".repeat(76)}`;
        return {
          attachmentId,
          relativePath: `${attachmentId}/blob.abcdefghijklmnop`,
          bytes: 0,
          sha256: "0".repeat(64),
        };
      },
    );
    const maximumInventoryGeneration = createHash("sha256").update(
      Buffer.from(JSON.stringify({
        version: 1,
        blobs: maximumInventoryBlobs,
        totalBytes: 0,
      }), "utf8"),
    ).digest("hex");
    const maximumInventory = {
      version: 1 as const,
      generationSha256: maximumInventoryGeneration,
      totalBytes: 0,
      blobs: maximumInventoryBlobs,
    };
    const nearMaximumJournal = controlPlaneRestoreJournalSchema.parse({
      version: 2,
      kind: "hraness-kitchen-control-plane-restore",
      phase: "materializing",
      archiveSha256: "1".repeat(64),
      databaseSha256: "2".repeat(64),
      receiptKeySha256: "3".repeat(64),
      attachmentVaultGenerationSha256: maximumInventoryGeneration,
      attachmentVaultInventory: maximumInventory,
      stageCustodyNonce: "4".repeat(64),
      restoreRootDevice: 1,
      restoreRootInode: 1,
      hadDatabase: true,
      hadReceiptKey: true,
      hadAttachmentVault: true,
      originalDatabaseSha256: "5".repeat(64),
      originalReceiptKeySha256: "6".repeat(64),
      originalAttachmentVaultGenerationSha256: maximumInventoryGeneration,
      originalAttachmentVaultInventory: maximumInventory,
    });
    expect(Buffer.byteLength(JSON.stringify(nearMaximumJournal), "utf8"))
      .toBeLessThanOrEqual(maximumControlPlaneRestoreJournalByteLength);
    expect(controlPlaneRestoreJournalSchema.safeParse({
      ...nearMaximumJournal,
      hadAttachmentVault: false,
    }).success).toBe(false);
    expect(controlPlaneRestoreJournalSchema.safeParse({
      ...nearMaximumJournal,
      originalAttachmentVaultGenerationSha256: "7".repeat(64),
    }).success).toBe(false);

    const root = privateTemporaryDirectory("oprte-backup-journal-bound-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const archivePath = join(root, "control-plane.hkb");
    const backup = createBackup(source, archivePath, release100);
    source.database.close();
    const target = createControlPlane(root, "target", release100, oldInstallation);
    checkpointAndClose(target.database);
    const prepared = prepareAuthenticatedControlPlaneRestoreStage({
      archivePath,
      databasePath: target.databasePath,
      passphrase,
      releaseIdentity: release100,
      confirmedArchiveSha256: backup.archiveSha256,
    });
    const journalPath = writeMaterializingRestoreJournal(target, prepared);
    truncateSync(journalPath, maximumControlPlaneRestoreJournalByteLength + 1);
    expect(() => prepared.transferToJournal()).toThrow(
      "retained restore journal is unsafe",
    );
    expect(existsSync(join(
      target.parent,
      ".control-plane-restore-v2.stage.sqlite",
    ))).toBe(false);
    prepared.cleanup();
  }, 60_000);

  test("recovers a complete materializing stage without touching the live triad", () => {
    const root = privateTemporaryDirectory("oprte-backup-materializing-recovery-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    seedReadyAttachmentVault(source);
    const archivePath = join(root, "control-plane.hkb");
    const backup = createBackup(source, archivePath, release100);
    source.database.close();
    const target = createControlPlane(root, "target", release100, oldInstallation);
    checkpointAndClose(target.database);
    const liveBefore = snapshotControlPlanePair(target.databasePath);
    const liveVaultBefore = inspectControlPlaneAttachmentVault(
      target.attachmentVaultRoot,
    ).generationSha256;
    const prepared = prepareAuthenticatedControlPlaneRestoreStage({
      archivePath,
      databasePath: target.databasePath,
      passphrase,
      releaseIdentity: release100,
      confirmedArchiveSha256: backup.archiveSha256,
    });
    writeMaterializingRestoreJournal(target, prepared);
    prepared.transferToJournal();

    expect(recoverInterruptedControlPlaneRestore(target.databasePath)).toEqual({
      kind: "rolled_back",
      phase: "materializing",
    });
    expect(snapshotControlPlanePair(target.databasePath)).toEqual(liveBefore);
    expect(inspectControlPlaneAttachmentVault(
      target.attachmentVaultRoot,
    ).generationSha256).toBe(liveVaultBefore);
    for (const path of [
      ".control-plane-restore-v2.json",
      ".control-plane-restore-v2.stage.sqlite",
      ".control-plane-restore-v2.stage.hmac.key",
      ".control-plane-restore-v2.stage.attachments",
    ]) {
      expect(existsSync(join(target.parent, path))).toBe(false);
    }
  }, 60_000);

  test("recovers fixed journal-owned residue after process crashes mid-materialization", () => {
    const root = privateTemporaryDirectory("oprte-backup-materializing-crash-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    seedReadyAttachmentVault(source);
    const archivePath = join(root, "control-plane.hkb");
    const backup = createBackup(source, archivePath, release100);
    source.database.close();

    for (const checkpoint of [
      "after_database_staged",
      "after_attachment_blob_staged",
    ] as const) {
      const target = createControlPlane(
        root,
        `target-${checkpoint}`,
        release100,
        oldInstallation,
      );
      checkpointAndClose(target.database);
      const liveBefore = snapshotControlPlanePair(target.databasePath);
      const prepared = prepareAuthenticatedControlPlaneRestoreStage({
        archivePath,
        databasePath: target.databasePath,
        passphrase,
        releaseIdentity: release100,
        confirmedArchiveSha256: backup.archiveSha256,
      });
      writeMaterializingRestoreJournal(target, prepared);
      prepared.cleanup();
      crashMaterialization({
        archivePath,
        databasePath: target.databasePath,
        archiveSha256: backup.archiveSha256,
        checkpoint,
      });
      expect(existsSync(join(
        target.parent,
        ".control-plane-restore-v2.json",
      ))).toBe(true);
      expect(existsSync(join(
        target.parent,
        ".control-plane-restore-v2.stage.sqlite",
      ))).toBe(true);
      expect(recoverInterruptedControlPlaneRestore(target.databasePath)).toEqual({
        kind: "rolled_back",
        phase: "materializing",
      });
      expect(snapshotControlPlanePair(target.databasePath)).toEqual(liveBefore);
      expect(existsSync(join(
        target.parent,
        ".control-plane-restore-v2.stage.attachments",
      ))).toBe(false);
    }
  }, 120_000);

  test("preserves foreign hard links while materializing recovery fails closed", () => {
    const root = privateTemporaryDirectory("oprte-backup-materializing-links-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    seedReadyAttachmentVault(source);
    const archivePath = join(root, "control-plane.hkb");
    const backup = createBackup(source, archivePath, release100);
    source.database.close();

    for (const artifact of ["database", "blob"] as const) {
      const checkpoint = artifact === "database"
        ? "after_database_staged"
        : "after_attachment_blob_staged";
      const target = createControlPlane(
        root,
        `target-${artifact}`,
        release100,
        oldInstallation,
      );
      checkpointAndClose(target.database);
      const prepared = prepareAuthenticatedControlPlaneRestoreStage({
        archivePath,
        databasePath: target.databasePath,
        passphrase,
        releaseIdentity: release100,
        confirmedArchiveSha256: backup.archiveSha256,
      });
      writeMaterializingRestoreJournal(target, prepared);
      prepared.cleanup();
      crashMaterialization({
        archivePath,
        databasePath: target.databasePath,
        archiveSha256: backup.archiveSha256,
        checkpoint,
      });
      const stagePath = artifact === "database"
        ? join(target.parent, ".control-plane-restore-v2.stage.sqlite")
        : join(
          target.parent,
          ".control-plane-restore-v2.stage.attachments",
          "objects",
          backupFileAttachmentId,
          "blob.txt",
        );
      const foreignPath = join(target.parent, `foreign-${artifact}.link`);
      linkSync(stagePath, foreignPath);
      const before = Buffer.from(readFileSync(foreignPath));
      expect(() => recoverInterruptedControlPlaneRestore(target.databasePath))
        .toThrow();
      expect(readFileSync(foreignPath)).toEqual(before);
      expect(existsSync(join(
        target.parent,
        ".control-plane-restore-v2.json",
      ))).toBe(true);
      unlinkSync(foreignPath);
      expect(recoverInterruptedControlPlaneRestore(target.databasePath)).toEqual({
        kind: "rolled_back",
        phase: "materializing",
      });
    }
  }, 120_000);

  test("keeps the materializing journal for unsafe fixed file kinds", () => {
    const root = privateTemporaryDirectory("oprte-backup-materializing-kinds-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const archivePath = join(root, "control-plane.hkb");
    const backup = createBackup(source, archivePath, release100);
    source.database.close();

    for (const kind of ["symlink", "fifo", "directory"] as const) {
      const target = createControlPlane(root, `target-${kind}`, release100, oldInstallation);
      checkpointAndClose(target.database);
      const prepared = prepareAuthenticatedControlPlaneRestoreStage({
        archivePath,
        databasePath: target.databasePath,
        passphrase,
        releaseIdentity: release100,
        confirmedArchiveSha256: backup.archiveSha256,
      });
      const journalPath = writeMaterializingRestoreJournal(target, prepared);
      prepared.cleanup();
      crashMaterialization({
        archivePath,
        databasePath: target.databasePath,
        archiveSha256: backup.archiveSha256,
        checkpoint: "after_database_staged",
      });
      const keyStage = join(
        target.parent,
        ".control-plane-restore-v2.stage.hmac.key",
      );
      const retainedKey = `${keyStage}.retained`;
      const retainedKeyBytes = Buffer.from(readFileSync(keyStage));
      renameSync(keyStage, retainedKey);
      if (kind === "symlink") symlinkSync(retainedKey, keyStage);
      else if (kind === "fifo") makeFifo(keyStage);
      else mkdirSync(keyStage, { mode: 0o700 });
      expect(() => recoverInterruptedControlPlaneRestore(target.databasePath))
        .toThrow();
      expect(existsSync(journalPath)).toBe(true);
      expect(readFileSync(retainedKey)).toEqual(retainedKeyBytes);
    }
  }, 120_000);

  test("zeroes retained stage inodes after completed-section rename or hard-link races", () => {
    const root = privateTemporaryDirectory("oprte-backup-stage-inode-custody-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    seedReadyAttachmentVault(source);
    const archivePath = join(root, "control-plane.hkb");
    const backup = createBackup(source, archivePath, release100);
    source.database.close();
    const cases = [
      ["receipt_key", "rename", "after_receipt_key_staged"],
      ["receipt_key", "hardlink", "after_receipt_key_staged"],
      ["database", "rename", "after_database_staged"],
      ["database", "hardlink", "after_database_staged"],
      ["blob", "rename", "after_attachment_blob_staged"],
      ["blob", "hardlink", "after_attachment_blob_staged"],
    ] as const;

    for (const [artifact, race, checkpoint] of cases) {
      const target = createControlPlane(
        root,
        `target-${artifact}-${race}`,
        release100,
        oldInstallation,
      );
      checkpointAndClose(target.database);
      let injected = false;
      let foreignPath = "";
      const prepared = prepareAuthenticatedControlPlaneRestoreStage({
        archivePath,
        databasePath: target.databasePath,
        passphrase,
        releaseIdentity: release100,
        confirmedArchiveSha256: backup.archiveSha256,
        onStageCheckpoint: (point) => {
          if (injected || point !== checkpoint) return;
          injected = true;
          const stagePath = artifact === "receipt_key"
            ? join(target.parent, ".control-plane-restore-v2.stage.hmac.key")
            : artifact === "database"
            ? join(target.parent, ".control-plane-restore-v2.stage.sqlite")
            : join(
              target.parent,
              ".control-plane-restore-v2.stage.attachments",
              "objects",
              backupFileAttachmentId,
              "blob.txt",
            );
          foreignPath = join(
            target.parent,
            `foreign-${artifact}-${race}.plaintext`,
          );
          if (race === "rename") renameSync(stagePath, foreignPath);
          else linkSync(stagePath, foreignPath);
          throw new Error(`injected ${artifact} ${race}`);
        },
      });
      writeMaterializingRestoreJournal(target, prepared);
      expect(() => prepared.transferToJournal()).toThrow();
      expect(injected).toBe(true);
      expect(readFileSync(foreignPath).byteLength).toBe(0);
    }
  }, 120_000);

  test("never deletes replacement names after stage construction races", () => {
    const root = privateTemporaryDirectory("oprte-backup-stage-construction-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    seedReadyAttachmentVault(source);
    const archivePath = join(root, "control-plane.hkb");
    const backup = createBackup(source, archivePath, release100);
    source.database.close();

    for (const artifact of ["file", "directory"] as const) {
      const target = createControlPlane(
        root,
        `target-${artifact}`,
        release100,
        oldInstallation,
      );
      checkpointAndClose(target.database);
      let injected = false;
      let movedPath = "";
      let replacementPath = "";
      const prepared = prepareAuthenticatedControlPlaneRestoreStage({
        archivePath,
        databasePath: target.databasePath,
        passphrase,
        releaseIdentity: release100,
        confirmedArchiveSha256: backup.archiveSha256,
        onStageCheckpoint: (point) => {
          const expected = artifact === "file"
            ? "after_stage_file_created_before_validation"
            : "after_stage_directory_created_before_bind";
          if (injected || point !== expected) return;
          injected = true;
          replacementPath = artifact === "file"
            ? join(target.parent, ".control-plane-restore-v2.stage.hmac.key")
            : join(
              target.parent,
              ".control-plane-restore-v2.stage.attachments",
            );
          movedPath = `${replacementPath}.moved`;
          renameSync(replacementPath, movedPath);
          if (artifact === "file") {
            writeFileSync(replacementPath, "replacement survives", { mode: 0o600 });
          } else {
            mkdirSync(replacementPath, { mode: 0o700 });
          }
          throw new Error("construction race");
        },
      });
      const journalPath = writeMaterializingRestoreJournal(target, prepared);
      expect(() => prepared.transferToJournal()).toThrow();
      expect(injected).toBe(true);
      expect(existsSync(replacementPath)).toBe(true);
      expect(existsSync(movedPath)).toBe(true);
      if (artifact === "file") {
        expect(readFileSync(replacementPath, "utf8")).toBe(
          "replacement survives",
        );
        expect(lstatSync(movedPath).size).toBe(0);
      }
      expect(() => recoverInterruptedControlPlaneRestore(target.databasePath))
        .toThrow("custody marker");
      expect(existsSync(journalPath)).toBe(true);
      expect(existsSync(replacementPath)).toBe(true);
      expect(existsSync(movedPath)).toBe(true);
      if (artifact === "file") {
        expect(readFileSync(replacementPath, "utf8")).toBe(
          "replacement survives",
        );
      }
    }
  }, 120_000);

  test("preserves replacement children inside an authentic materializing vault", () => {
    const root = privateTemporaryDirectory("oprte-backup-stage-child-provenance-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    seedReadyAttachmentVault(source);
    const archivePath = join(root, "control-plane.hkb");
    const backup = createBackup(source, archivePath, release100);
    source.database.close();

    for (const artifact of ["blob", "object_directory"] as const) {
      const target = createControlPlane(
        root,
        `target-${artifact}`,
        release100,
        oldInstallation,
      );
      checkpointAndClose(target.database);
      const prepared = prepareAuthenticatedControlPlaneRestoreStage({
        archivePath,
        databasePath: target.databasePath,
        passphrase,
        releaseIdentity: release100,
        confirmedArchiveSha256: backup.archiveSha256,
      });
      const journalPath = writeMaterializingRestoreJournal(target, prepared);
      prepared.cleanup();
      crashMaterialization({
        archivePath,
        databasePath: target.databasePath,
        archiveSha256: backup.archiveSha256,
        checkpoint: "after_attachment_blob_staged",
      });

      const objectPath = join(
        target.parent,
        ".control-plane-restore-v2.stage.attachments",
        "objects",
        backupFileAttachmentId,
      );
      const replacementPath = artifact === "blob"
        ? join(objectPath, "blob.txt")
        : objectPath;
      const movedPath = join(target.parent, `foreign-${artifact}`);
      renameSync(replacementPath, movedPath);
      if (artifact === "blob") {
        writeFileSync(replacementPath, "foreign replacement blob", {
          mode: 0o600,
        });
      } else {
        mkdirSync(replacementPath, { mode: 0o700 });
      }
      const foreignBytes = artifact === "blob"
        ? Buffer.from(readFileSync(movedPath))
        : Buffer.from(readFileSync(join(movedPath, "blob.txt")));

      expect(() => recoverInterruptedControlPlaneRestore(target.databasePath))
        .toThrow("custody marker");
      expect(existsSync(journalPath)).toBe(true);
      expect(existsSync(replacementPath)).toBe(true);
      expect(
        artifact === "blob"
          ? readFileSync(replacementPath, "utf8")
          : lstatSync(replacementPath).isDirectory(),
      ).toBe(artifact === "blob" ? "foreign replacement blob" : true);
      expect(
        artifact === "blob"
          ? readFileSync(movedPath)
          : readFileSync(join(movedPath, "blob.txt")),
      ).toEqual(foreignBytes);
    }
  }, 120_000);

  test("retains exact stage custody after accepting the prepared journal", () => {
    const root = privateTemporaryDirectory("oprte-backup-prepared-custody-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    seedReadyAttachmentVault(source);
    const archivePath = join(root, "control-plane.hkb");
    const backup = createBackup(source, archivePath, release100);
    source.database.close();

    for (const race of ["rename_database", "hardlink_blob"] as const) {
      const target = createControlPlane(
        root,
        `target-${race}`,
        release100,
        oldInstallation,
      );
      checkpointAndClose(target.database);
      const prepared = prepareAuthenticatedControlPlaneRestoreStage({
        archivePath,
        databasePath: target.databasePath,
        passphrase,
        releaseIdentity: release100,
        confirmedArchiveSha256: backup.archiveSha256,
      });
      const journalPath = writeMaterializingRestoreJournal(target, prepared);
      const materialized = prepared.transferToJournal();
      advanceRestoreJournalPhase(journalPath, "prepared");
      const journaled = materialized.acceptPreparedJournal();
      const stagePath = race === "rename_database"
        ? join(target.parent, ".control-plane-restore-v2.stage.sqlite")
        : join(
          target.parent,
          ".control-plane-restore-v2.stage.attachments",
          "objects",
          backupFileAttachmentId,
          "blob.txt",
        );
      const foreignPath = join(target.parent, `foreign-${race}.plaintext`);
      if (race === "rename_database") renameSync(stagePath, foreignPath);
      else linkSync(stagePath, foreignPath);

      expect(() => journaled.eraseAfterFailedRecovery()).toThrow();
      expect(readFileSync(foreignPath).byteLength).toBe(0);
    }
  }, 120_000);

  test("releases retained custody only for validated exact live inodes", () => {
    const root = privateTemporaryDirectory("oprte-backup-validated-custody-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    seedReadyAttachmentVault(source);
    const archivePath = join(root, "control-plane.hkb");
    const backup = createBackup(source, archivePath, release100);
    source.database.close();

    for (const variant of [
      "exact",
      "replaced_database",
      "mutated_database",
      "mutated_key",
    ] as const) {
      const target = createControlPlane(
        root,
        `target-${variant}`,
        release100,
        oldInstallation,
      );
      checkpointAndClose(target.database);
      const prepared = prepareAuthenticatedControlPlaneRestoreStage({
        archivePath,
        databasePath: target.databasePath,
        passphrase,
        releaseIdentity: release100,
        confirmedArchiveSha256: backup.archiveSha256,
      });
      const journalPath = writeMaterializingRestoreJournal(target, prepared);
      const materialized = prepared.transferToJournal();
      advanceRestoreJournalPhase(journalPath, "prepared");
      const journaled = materialized.acceptPreparedJournal();
      expect(() => journaled.releaseCommitted()).toThrow(
        "does not authorize this authenticated stage",
      );
      publishMaterializedStageForTest(target);
      advanceRestoreJournalPhase(journalPath, "validated");
      if (variant === "exact") {
        const liveBeforeStaleCleanup = snapshotControlPlanePair(
          target.databasePath,
        );
        const vaultBeforeStaleCleanup = inspectControlPlaneAttachmentVault(
          target.attachmentVaultRoot,
        ).generationSha256;
        expect(() => materialized.cleanup()).toThrow("custody has transferred");
        expect(() => prepared.cleanup()).not.toThrow();
        expect(() => journaled.eraseAfterFailedRecovery()).toThrow(
          "does not authorize failed-swap erasure",
        );
        expect(snapshotControlPlanePair(target.databasePath)).toEqual(
          liveBeforeStaleCleanup,
        );
        expect(inspectControlPlaneAttachmentVault(
          target.attachmentVaultRoot,
        ).generationSha256).toBe(vaultBeforeStaleCleanup);
      }
      if (variant === "replaced_database") {
        const retainedDatabase = join(target.parent, "retained-database.moved");
        renameSync(target.databasePath, retainedDatabase);
        writeFileSync(target.databasePath, readFileSync(retainedDatabase), {
          mode: 0o600,
        });
        expect(() => journaled.releaseCommitted()).toThrow(
          "not the retained stage inode",
        );
      } else if (variant === "mutated_database" || variant === "mutated_key") {
        const path = variant === "mutated_database"
          ? target.databasePath
          : operationReceiptKeyPath(target.databasePath);
        const bytes = Buffer.from(readFileSync(path));
        bytes[bytes.byteLength - 1] = (bytes.at(-1) ?? 0) ^ 0x01;
        writeFileSync(path, bytes, { mode: 0o600 });
        expect(() => journaled.releaseCommitted()).toThrow(
          "file content changed",
        );
      } else {
        expect(() => journaled.releaseCommitted()).not.toThrow();
      }
    }
  }, 120_000);

  test("settles retained custody according to the exact recovery outcome", () => {
    const root = privateTemporaryDirectory("oprte-backup-recovery-custody-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    seedReadyAttachmentVault(source);
    const archivePath = join(root, "control-plane.hkb");
    const backup = createBackup(source, archivePath, release100);
    source.database.close();

    for (const outcome of ["rolled_back", "completed", "wrong_split"] as const) {
      const target = createControlPlane(
        root,
        `target-${outcome}`,
        release100,
        oldInstallation,
      );
      checkpointAndClose(target.database);
      const prepared = prepareAuthenticatedControlPlaneRestoreStage({
        archivePath,
        databasePath: target.databasePath,
        passphrase,
        releaseIdentity: release100,
        confirmedArchiveSha256: backup.archiveSha256,
      });
      const journalPath = writeMaterializingRestoreJournal(target, prepared);
      const materialized = prepared.transferToJournal();
      advanceRestoreJournalPhase(journalPath, "prepared");
      const journaled = materialized.acceptPreparedJournal();
      if (outcome === "rolled_back") {
        const retainedPaths = [
          join(target.parent, ".control-plane-restore-v2.stage.sqlite"),
          join(target.parent, ".control-plane-restore-v2.stage.hmac.key"),
          join(
            target.parent,
            ".control-plane-restore-v2.stage.attachments",
            "objects",
            backupFileAttachmentId,
            "blob.txt",
          ),
        ];
        expect(() => journaled.eraseAfterRolledBackRecovery()).not.toThrow();
        for (const path of retainedPaths) {
          expect(lstatSync(path).size).toBe(0);
        }
      } else {
        publishMaterializedStageForTest(target);
        const publishedBefore = snapshotControlPlanePair(target.databasePath);
        if (outcome === "wrong_split") {
          expect(() => journaled.eraseAfterRolledBackRecovery()).toThrow(
            "still publishes a retained stage inode",
          );
          expect(snapshotControlPlanePair(target.databasePath)).toEqual(
            publishedBefore,
          );
        }
        advanceRestoreJournalPhase(journalPath, "validated");
        unlinkSync(journalPath);
        expect(() => journaled.releaseAfterCompletedRecovery()).not.toThrow();
        expect(snapshotControlPlanePair(target.databasePath)).toEqual(
          publishedBefore,
        );
      }
    }
  }, 120_000);

  test("settles materialized custody after rollback before journal acceptance", () => {
    const root = privateTemporaryDirectory("oprte-backup-preaccept-rollback-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    seedReadyAttachmentVault(source);
    const archivePath = join(root, "control-plane.hkb");
    const backup = createBackup(source, archivePath, release100);
    source.database.close();
    const target = createControlPlane(root, "target", release100, oldInstallation);
    checkpointAndClose(target.database);
    const prepared = prepareAuthenticatedControlPlaneRestoreStage({
      archivePath,
      databasePath: target.databasePath,
      passphrase,
      releaseIdentity: release100,
      confirmedArchiveSha256: backup.archiveSha256,
    });
    const journalPath = writeMaterializingRestoreJournal(target, prepared);
    const materialized = prepared.transferToJournal();
    advanceRestoreJournalPhase(journalPath, "prepared");
    const databaseStage = join(
      target.parent,
      ".control-plane-restore-v2.stage.sqlite",
    );
    const movedStage = join(target.parent, "moved-preaccept-stage.sqlite");
    renameSync(databaseStage, movedStage);

    expect(recoverInterruptedControlPlaneRestore(target.databasePath)).toEqual({
      kind: "rolled_back",
      phase: "prepared",
    });
    expect(readFileSync(movedStage).byteLength).toBeGreaterThan(0);
    expect(() => materialized.eraseAfterRolledBackRecovery()).not.toThrow();
    expect(readFileSync(movedStage).byteLength).toBe(0);
  }, 120_000);

  test("settles materialized custody when restore fails before prepared acceptance", () => {
    const root = privateTemporaryDirectory("oprte-backup-prepared-accept-fault-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    seedReadyAttachmentVault(source);
    const archivePath = join(root, "control-plane.hkb");
    createBackup(source, archivePath, release100);
    source.database.close();
    const target = createControlPlane(root, "target", release100, oldInstallation);
    checkpointAndClose(target.database);
    const liveBefore = snapshotControlPlanePair(target.databasePath);

    expect(() => restoreEncryptedControlPlaneBackup({
      archivePath,
      databasePath: target.databasePath,
      passphrase,
      releaseIdentity: release100,
      onCheckpoint: (point) => {
        if (point === "after_materialized_before_prepared") {
          throw new Error("fail before prepared acceptance");
        }
      },
    })).toThrow("fail before prepared acceptance");
    expect(snapshotControlPlanePair(target.databasePath)).toEqual(liveBefore);
    for (const path of [
      ".control-plane-restore-v2.json",
      ".control-plane-restore-v2.stage.sqlite",
      ".control-plane-restore-v2.stage.hmac.key",
      ".control-plane-restore-v2.stage.attachments",
    ]) {
      expect(existsSync(join(target.parent, path))).toBe(false);
    }
  }, 120_000);

  test("never writes a restore stage before archive authentication", () => {
    const root = privateTemporaryDirectory("oprte-backup-stream-auth-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const archivePath = join(root, "control-plane.hkb");
    createBackup(source, archivePath, release100);
    source.database.close();
    const tampered = Buffer.from(readFileSync(archivePath));
    tampered[tampered.byteLength - 1] = (tampered.at(-1) ?? 0) ^ 0xff;
    writeFileSync(archivePath, tampered, { mode: 0o600 });
    const target = createControlPlane(root, "target", release100, oldInstallation);
    checkpointAndClose(target.database);

    expect(() => prepareAuthenticatedControlPlaneRestoreStage({
      archivePath,
      databasePath: target.databasePath,
      passphrase,
      releaseIdentity: release100,
      confirmedArchiveSha256: fileSha256(archivePath),
    })).toThrow(expect.objectContaining({ code: "authentication_failed" }));
    expect(existsSync(join(
      target.parent,
      ".control-plane-restore-v2.stage.sqlite",
    ))).toBe(false);
    expect(existsSync(join(
      target.parent,
      ".control-plane-restore-v2.stage.hmac.key",
    ))).toBe(false);
    expect(existsSync(join(
      target.parent,
      ".control-plane-restore-v2.stage.attachments",
    ))).toBe(false);
  }, 60_000);

  test("retains the preflight restore-root identity through authentication", () => {
    const root = privateTemporaryDirectory("oprte-backup-stage-parent-race-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const archivePath = join(root, "control-plane.hkb");
    const backup = createBackup(source, archivePath, release100);
    source.database.close();
    const target = createControlPlane(root, "target", release100, oldInstallation);
    checkpointAndClose(target.database);
    const movedTargetRoot = join(root, "target-moved");

    expect(() => prepareAuthenticatedControlPlaneRestoreStage({
      archivePath,
      databasePath: target.databasePath,
      passphrase,
      releaseIdentity: release100,
      confirmedArchiveSha256: backup.archiveSha256,
      onStageCheckpoint: (point) => {
        if (point !== "after_archive_authentication") return;
        renameSync(target.parent, movedTargetRoot);
        mkdirSync(target.parent, { mode: 0o700 });
      },
    })).toThrow("parent identity changed");
    expect(existsSync(join(
      movedTargetRoot,
      ".control-plane-restore-v2.stage.sqlite",
    ))).toBe(false);
    expect(existsSync(join(
      target.parent,
      ".control-plane-restore-v2.stage.sqlite",
    ))).toBe(false);

    rmSync(target.parent, { recursive: true, force: true });
    renameSync(movedTargetRoot, target.parent);
  }, 60_000);

  test("rejects the legacy v1 outer archive identity", () => {
    const root = privateTemporaryDirectory("oprte-backup-legacy-envelope-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const archivePath = join(root, "control-plane.hkb");
    createBackup(source, archivePath, release100);
    source.database.close();
    const legacyPath = join(root, "legacy-v1.hkb");
    const bytes = Buffer.from(readFileSync(archivePath));
    bytes.write("HKCPB001", 0, "ascii");
    writeFileSync(legacyPath, bytes, { mode: 0o600 });
    expect(() => inspectEncryptedControlPlaneBackup(legacyPath))
      .toThrow("archive magic is invalid");
    expect(() => verifyEncryptedControlPlaneBackup({
      archivePath: legacyPath,
      passphrase,
      releaseIdentity: release100,
    })).toThrow("archive magic is invalid");
  });

  test("rejects FIFOs without blocking and retries partial stage cleanup", () => {
    const root = privateTemporaryDirectory("oprte-backup-fifo-");
    const fifoArchive = join(root, "fifo.hkb");
    makeFifo(fifoArchive);
    expect(() => inspectEncryptedControlPlaneBackup(fifoArchive))
      .toThrow("regular file");

    const source = createControlPlane(root, "source", release100, sourceInstallation);
    seedReadyAttachmentVault(source);
    const blobPath = join(
      source.attachmentVaultRoot,
      "objects",
      backupFileAttachmentId,
      "blob.txt",
    );
    unlinkSync(blobPath);
    makeFifo(blobPath);
    expect(() => createEncryptedControlPlaneBackup({
      database: source.database,
      destinationPath: join(root, "blocked-by-fifo.hkb"),
      operationReceiptKey: source.receiptKey,
      passphrase,
      releaseIdentity: release100,
      attachmentVaultRoot: source.attachmentVaultRoot,
    })).toThrow("blob is not protected restore state");
    source.database.close();

    const cleanSource = createControlPlane(
      root,
      "clean-source",
      release100,
      sourceInstallation,
    );
    const archivePath = join(root, "clean.hkb");
    const backup = createBackup(cleanSource, archivePath, release100);
    cleanSource.database.close();
    const candidate = backupCandidatePath(join(root, "candidate-target.hkb"));
    makeFifo(candidate);
    const candidateSource = createControlPlane(
      root,
      "candidate-source",
      release100,
      sourceInstallation,
    );
    expect(() => createBackup(
      candidateSource,
      join(root, "candidate-target.hkb"),
      release100,
    )).toThrow("staging path is unsafe");
    candidateSource.database.close();

    const target = createControlPlane(root, "target", release100, oldInstallation);
    checkpointAndClose(target.database);
    const prepared = prepareAuthenticatedControlPlaneRestoreStage({
      archivePath,
      databasePath: target.databasePath,
      passphrase,
      releaseIdentity: release100,
      confirmedArchiveSha256: backup.archiveSha256,
    });
    writeMaterializingRestoreJournal(target, prepared);
    const materialized = prepared.transferToJournal();
    const databaseStage = join(
      target.parent,
      ".control-plane-restore-v2.stage.sqlite",
    );
    unlinkSync(databaseStage);
    makeFifo(databaseStage);
    expect(() => materialized.cleanup()).toThrow("identity changed during cleanup");
    unlinkSync(databaseStage);
    expect(() => materialized.cleanup()).not.toThrow();
    expect(existsSync(databaseStage)).toBe(false);
  }, 60_000);

  test("fails closed on a wrong passphrase or any ciphertext/tag tamper", () => {
    const root = privateTemporaryDirectory("oprte-backup-auth-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const archivePath = join(root, "control-plane.hkb");
    createBackup(source, archivePath, release100);
    source.database.close();
    const target = createControlPlane(root, "target", release100, oldInstallation);
    checkpointAndClose(target.database);
    const before = snapshotControlPlanePair(target.databasePath);

    expect(() => restoreEncryptedControlPlaneBackup({
      archivePath,
      databasePath: target.databasePath,
      passphrase: "wrong passphrase",
      releaseIdentity: release100,
    })).toThrow("wrong or the archive was modified");
    expect(() => verifyEncryptedControlPlaneBackup({
      archivePath,
      passphrase: "wrong passphrase",
      releaseIdentity: release100,
    })).toThrow("wrong or the archive was modified");
    expect(snapshotControlPlanePair(target.databasePath)).toEqual(before);

    const tamperedPath = join(root, "tampered.hkb");
    const tampered = Buffer.from(readFileSync(archivePath));
    const tamperedIndex = tampered.byteLength - 1;
    tampered[tamperedIndex] = (tampered[tamperedIndex] ?? 0) ^ 0xff;
    writeFileSync(tamperedPath, tampered, { mode: 0o600 });
    expect(() => restoreEncryptedControlPlaneBackup({
      archivePath: tamperedPath,
      databasePath: target.databasePath,
      passphrase,
      releaseIdentity: release100,
    })).toThrow(ControlPlaneBackupError);
    expect(() => verifyEncryptedControlPlaneBackup({
      archivePath: tamperedPath,
      passphrase,
      releaseIdentity: release100,
    })).toThrow(ControlPlaneBackupError);
    expect(snapshotControlPlanePair(target.databasePath)).toEqual(before);
  }, 60_000);

  test("authenticated verification rejects a corrupted decrypted payload", () => {
    const root = privateTemporaryDirectory("oprte-backup-corrupt-payload-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const archivePath = join(root, "control-plane.hkb");
    createBackup(source, archivePath, release100);
    source.database.close();
    const corruptPath = join(root, "authenticated-corrupt.hkb");
    writeAuthenticatedPayloadCorruption(archivePath, corruptPath);

    let failure: unknown;
    try {
      verifyEncryptedControlPlaneBackup({
        archivePath: corruptPath,
        passphrase,
        releaseIdentity: release100,
      });
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ControlPlaneBackupError);
    expect(failure).toMatchObject({ code: "invalid_archive" });
  }, 60_000);

  test("create-only publication never replaces an existing archive path", () => {
    const root = privateTemporaryDirectory("oprte-backup-create-only-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const archivePath = join(root, "existing.hkb");
    writeFileSync(archivePath, "must survive", { mode: 0o600 });

    expect(() => createEncryptedControlPlaneBackup({
      database: source.database,
      destinationPath: archivePath,
      attachmentVaultRoot: source.attachmentVaultRoot,
      operationReceiptKey: source.receiptKey,
      passphrase,
      releaseIdentity: release100,
    })).toThrow("already exists");
    expect(readFileSync(archivePath, "utf8")).toBe("must survive");
    source.database.close();
  }, 60_000);

  test("never deletes an unproven preexisting staging-name file", () => {
    const root = privateTemporaryDirectory("oprte-backup-stale-candidate-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const archivePath = join(root, "control-plane.hkb");
    const candidatePath = backupCandidatePath(archivePath);
    const userBytes = Buffer.from("unproven user-owned staging name", "utf8");
    writeFileSync(candidatePath, userBytes, { mode: 0o600 });

    expect(() => createEncryptedControlPlaneBackup({
      database: source.database,
      destinationPath: archivePath,
      attachmentVaultRoot: source.attachmentVaultRoot,
      operationReceiptKey: source.receiptKey,
      passphrase,
      releaseIdentity: release100,
    })).toThrow("without deletion provenance");
    expect(readFileSync(candidatePath)).toEqual(userBytes);
    expect(existsSync(archivePath)).toBe(false);
    source.database.close();
  }, 60_000);

  test("leaves a content-mismatched published inode for explicit recovery", () => {
    const root = privateTemporaryDirectory("oprte-backup-create-race-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const destinationRoot = join(root, "destination");
    mkdirSync(destinationRoot, { mode: 0o700 });
    const archivePath = join(destinationRoot, "control-plane.hkb");
    const candidatePath = backupCandidatePath(archivePath);

    expect(() => createEncryptedControlPlaneBackup({
      database: source.database,
      destinationPath: archivePath,
      attachmentVaultRoot: source.attachmentVaultRoot,
      operationReceiptKey: source.receiptKey,
      passphrase,
      releaseIdentity: release100,
      onPublicationCheckpoint: (point) => {
        if (point !== "after_staged_hash_before_publish") return;
        const bytes = Buffer.from(readFileSync(candidatePath));
        const mutationOffset = Math.floor(bytes.byteLength / 2);
        bytes[mutationOffset] = (bytes[mutationOffset] ?? 0) ^ 0xff;
        writeFileSync(candidatePath, bytes, { mode: 0o600 });
      },
    })).toThrow("do not match the retained staging inode");
    expect(existsSync(archivePath)).toBe(true);
    expect(existsSync(candidatePath)).toBe(false);
    expect(() => verifyEncryptedControlPlaneBackup({
      archivePath,
      passphrase,
      releaseIdentity: release100,
    })).toThrow(ControlPlaneBackupError);
    source.database.close();
  }, 60_000);

  test("retains encrypted residue when its parent path changes after publication", () => {
    const root = privateTemporaryDirectory("oprte-backup-parent-race-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const destinationRoot = join(root, "destination");
    const movedDestinationRoot = join(root, "destination-moved");
    mkdirSync(destinationRoot, { mode: 0o700 });
    const archivePath = join(destinationRoot, "control-plane.hkb");

    expect(() => createEncryptedControlPlaneBackup({
      database: source.database,
      destinationPath: archivePath,
      attachmentVaultRoot: source.attachmentVaultRoot,
      operationReceiptKey: source.receiptKey,
      passphrase,
      releaseIdentity: release100,
      onPublicationCheckpoint: (point) => {
        if (point !== "after_publish_before_parent_recheck") return;
        renameSync(destinationRoot, movedDestinationRoot);
        mkdirSync(destinationRoot, { mode: 0o700 });
      },
    })).toThrow("parent identity changed");
    expect(existsSync(join(movedDestinationRoot, "control-plane.hkb"))).toBe(true);
    expect(existsSync(backupCandidatePath(join(
      movedDestinationRoot,
      "control-plane.hkb",
    )))).toBe(false);
    expect(existsSync(archivePath)).toBe(false);
    source.database.close();
  }, 60_000);

  test("keeps the originally authorized destination parent through capture", () => {
    const root = privateTemporaryDirectory("oprte-backup-parent-prelink-race-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const destinationRoot = join(root, "destination");
    const movedDestinationRoot = join(root, "destination-moved");
    mkdirSync(destinationRoot, { mode: 0o700 });
    const archivePath = join(destinationRoot, "control-plane.hkb");

    expect(() => createEncryptedControlPlaneBackup({
      database: source.database,
      destinationPath: archivePath,
      attachmentVaultRoot: source.attachmentVaultRoot,
      operationReceiptKey: source.receiptKey,
      passphrase,
      releaseIdentity: release100,
      onPublicationCheckpoint: (point) => {
        if (point !== "after_staged_hash_before_publish") return;
        renameSync(destinationRoot, movedDestinationRoot);
        mkdirSync(destinationRoot, { mode: 0o700 });
      },
    })).toThrow("parent identity changed");
    expect(existsSync(join(movedDestinationRoot, "control-plane.hkb"))).toBe(false);
    expect(existsSync(backupCandidatePath(join(
      movedDestinationRoot,
      "control-plane.hkb",
    )))).toBe(true);
    expect(existsSync(archivePath)).toBe(false);
    source.database.close();
  }, 60_000);

  test("never removes a replacement destination during failed publication cleanup", () => {
    const root = privateTemporaryDirectory("oprte-backup-destination-replace-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const destinationRoot = join(root, "destination");
    mkdirSync(destinationRoot, { mode: 0o700 });
    const archivePath = join(destinationRoot, "control-plane.hkb");
    const replacement = Buffer.from("user replacement must survive", "utf8");

    expect(() => createEncryptedControlPlaneBackup({
      database: source.database,
      destinationPath: archivePath,
      attachmentVaultRoot: source.attachmentVaultRoot,
      operationReceiptKey: source.receiptKey,
      passphrase,
      releaseIdentity: release100,
      onPublicationCheckpoint: (point) => {
        if (point !== "after_publish_before_parent_recheck") return;
        unlinkSync(archivePath);
        writeFileSync(archivePath, replacement, { mode: 0o600 });
      },
    })).toThrow("publication identity changed");
    expect(readFileSync(archivePath)).toEqual(replacement);
    expect(existsSync(backupCandidatePath(archivePath))).toBe(false);
    source.database.close();
  }, 60_000);

  test("rejects an ambiguous create-only hard-link state without mutation", () => {
    const root = privateTemporaryDirectory("oprte-backup-create-only-recovery-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const archivePath = join(root, "published.hkb");
    const result = createEncryptedControlPlaneBackup({
      database: source.database,
      destinationPath: archivePath,
      attachmentVaultRoot: source.attachmentVaultRoot,
      operationReceiptKey: source.receiptKey,
      passphrase,
      releaseIdentity: release100,
      now: () => 1_785_000_000_000,
    });
    const candidatePath = backupCandidatePath(archivePath);
    const publishedBytes = Buffer.from(readFileSync(archivePath));

    linkSync(archivePath, candidatePath);
    expect(lstatSync(archivePath).nlink).toBe(2);
    expect(() => inspectEncryptedControlPlaneBackup(archivePath)).toThrow(
      "ambiguous retained staging link",
    );
    expect(() => verifyEncryptedControlPlaneBackup({
      archivePath,
      passphrase,
      releaseIdentity: release100,
    })).toThrow("ambiguous retained staging link");
    expect(() => createEncryptedControlPlaneBackup({
      database: source.database,
      destinationPath: archivePath,
      attachmentVaultRoot: source.attachmentVaultRoot,
      operationReceiptKey: source.receiptKey,
      passphrase,
      releaseIdentity: release100,
    })).toThrow("ambiguous retained staging link");
    expect(existsSync(candidatePath)).toBe(true);
    expect(lstatSync(archivePath).nlink).toBe(2);
    expect(readFileSync(archivePath)).toEqual(publishedBytes);

    unlinkSync(candidatePath);
    expect(inspectEncryptedControlPlaneBackup(archivePath)).toEqual(result.manifest);
    expect(lstatSync(archivePath).nlink).toBe(1);
    source.database.close();
  }, 60_000);

  test("leaves mismatched, over-linked, and permission-mutated backup names untouched", () => {
    const root = privateTemporaryDirectory("oprte-backup-create-only-unsafe-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const originalArchivePath = join(root, "source.hkb");
    createBackup(source, originalArchivePath, release100);
    const archiveBytes = Buffer.from(readFileSync(originalArchivePath));
    source.database.close();

    for (const variant of ["wrong_identity", "third_link", "permissions"] as const) {
      const directory = join(root, variant);
      mkdirSync(directory, { mode: 0o700 });
      const archivePath = join(directory, "published.hkb");
      const candidatePath = backupCandidatePath(archivePath);
      writeFileSync(archivePath, archiveBytes, { mode: 0o600 });

      if (variant === "wrong_identity") {
        writeFileSync(candidatePath, archiveBytes, { mode: 0o600 });
        linkSync(candidatePath, join(directory, "unexpected-link"));
      } else {
        linkSync(archivePath, candidatePath);
        if (variant === "third_link") {
          linkSync(archivePath, join(directory, "unexpected-link"));
        } else {
          chmodSync(candidatePath, 0o640);
        }
      }
      const beforeArchive = Buffer.from(readFileSync(archivePath));
      const beforeCandidate = Buffer.from(readFileSync(candidatePath));

      expect(() => inspectEncryptedControlPlaneBackup(archivePath)).toThrow(
        "unexpected hard link",
      );
      expect(readFileSync(archivePath)).toEqual(beforeArchive);
      expect(readFileSync(candidatePath)).toEqual(beforeCandidate);
      expect(existsSync(candidatePath)).toBe(true);
    }
  }, 60_000);

  test("rejects logical foreign-key corruption before it can enter an archive", () => {
    const root = privateTemporaryDirectory("oprte-backup-foreign-key-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const archivePath = join(root, "corrupt.hkb");
    source.database.exec("PRAGMA foreign_keys = OFF");
    source.database.exec(`
      CREATE TABLE backup_integrity_parent (
        id INTEGER PRIMARY KEY
      ) STRICT;
      CREATE TABLE backup_integrity_child (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER NOT NULL REFERENCES backup_integrity_parent(id)
      ) STRICT;
      INSERT INTO backup_integrity_child (id, parent_id) VALUES (1, 404);
    `);

    let failure: unknown;
    try {
      createBackup(source, archivePath, release100);
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ControlPlaneBackupError);
    expect(failure).toMatchObject({ code: "invalid_input" });
    if (!(failure instanceof Error)) throw new Error("Expected backup rejection");
    expect(failure.message).toContain("bounded integrity check");
    expect(failure.message).not.toContain("backup_integrity_child");
    expect(failure.message).not.toContain("404");
    expect(() => lstatSync(archivePath)).toThrow();
    source.database.close();
  }, 60_000);

  test("rejects an archive whose release fence is newer than the restoring app", () => {
    const root = privateTemporaryDirectory("oprte-backup-newer-");
    const source = createControlPlane(root, "source", release110, sourceInstallation);
    const archivePath = join(root, "newer.hkb");
    createBackup(source, archivePath, release110);
    source.database.close();
    const target = createControlPlane(root, "target", release100, oldInstallation);
    checkpointAndClose(target.database);
    const before = snapshotControlPlanePair(target.databasePath);

    expect(() => restoreEncryptedControlPlaneBackup({
      archivePath,
      databasePath: target.databasePath,
      passphrase,
      releaseIdentity: release100,
    })).toThrow("requires a newer HRA release");
    expect(() => verifyEncryptedControlPlaneBackup({
      archivePath,
      passphrase,
      releaseIdentity: release100,
    })).toThrow("requires a newer HRA release");
    expect(snapshotControlPlanePair(target.databasePath)).toEqual(before);
  }, 60_000);

  test("binds destructive restore to the exact verified archive digest", () => {
    const root = privateTemporaryDirectory("oprte-backup-confirmation-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const archivePath = join(root, "control-plane.hkb");
    createBackup(source, archivePath, release100);
    source.database.close();
    const target = createControlPlane(root, "target", release100, oldInstallation);
    checkpointAndClose(target.database);
    const before = snapshotControlPlanePair(target.databasePath);

    expect(() => restoreEncryptedControlPlaneBackup({
      archivePath,
      databasePath: target.databasePath,
      passphrase,
      releaseIdentity: release100,
      confirmedArchiveSha256: "0".repeat(64),
    })).toThrow(expect.objectContaining({ code: "confirmation_failed" }));
    expect(snapshotControlPlanePair(target.databasePath)).toEqual(before);
    expect(recoverInterruptedControlPlaneRestore(target.databasePath)).toEqual({
      kind: "none",
    });
  }, 60_000);

  test("restore retains the target's monotonic external release fence", () => {
    const root = privateTemporaryDirectory("oprte-backup-fence-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const archivePath = join(root, "older.hkb");
    createBackup(source, archivePath, release100);
    source.database.close();
    const target = createControlPlane(root, "target", release110, oldInstallation);
    checkpointAndClose(target.database);

    restoreEncryptedControlPlaneBackup({
      archivePath,
      databasePath: target.databasePath,
      passphrase,
      releaseIdentity: release110,
    });
    expect(inspectControlPlaneReleaseFence(target.databasePath)).toMatchObject({
      minimumReader: release110,
      intendedMigrationVersion: currentControlPlaneMigrationVersion,
    });
    expect(() => preflightControlPlaneRelease(target.databasePath, release100))
      .toThrow("release fence requires a newer HRA release");
    expect(readInstallationIds(target.databasePath)).toContain(sourceInstallation);
  }, 60_000);

  test("recovers every pre-commit crash by rollback and every post-commit crash forward", () => {
    const root = privateTemporaryDirectory("oprte-backup-crashes-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const archivePath = join(root, "control-plane.hkb");
    createBackup(source, archivePath, release100);
    source.database.close();
    const points: readonly ControlPlaneRestoreFaultPoint[] = [
      "after_prepared",
      "after_database_rollback_staged",
      "after_database_replaced",
      "after_key_rollback_staged",
      "after_key_replaced",
      "after_vault_rollback_staged",
      "after_vault_replaced",
      "after_validation",
      "after_vault_rollback_removed",
      "after_database_rollback_removed",
      "after_key_rollback_removed",
    ];

    for (const point of points) {
      const target = createControlPlane(
        root,
        `target-${point}`,
        release100,
        oldInstallation,
      );
      const originalKey = Uint8Array.from(target.receiptKey);
      checkpointAndClose(target.database);
      expect(() => restoreEncryptedControlPlaneBackup({
        archivePath,
        databasePath: target.databasePath,
        passphrase,
        releaseIdentity: release100,
        leaveInterruptedOnFault: true,
        onCheckpoint: (observed) => {
          if (observed === point) throw new Error(`simulated crash: ${point}`);
        },
      })).toThrow(`simulated crash: ${point}`);

      const recovery = recoverInterruptedControlPlaneRestore(target.databasePath);
      const committed = point === "after_validation"
        || point === "after_vault_rollback_removed"
        || point === "after_database_rollback_removed"
        || point === "after_key_rollback_removed";
      expect(recovery.kind).toBe(committed ? "completed" : "rolled_back");
      expect(readInstallationIds(target.databasePath)).toContain(
        committed ? sourceInstallation : oldInstallation,
      );
      expect(loadOrCreateOperationReceiptKey(
        operationReceiptKeyPath(target.databasePath),
      )).toEqual(committed ? source.receiptKey : originalKey);
      expect(recoverInterruptedControlPlaneRestore(target.databasePath)).toEqual({
        kind: "none",
      });
    }
  }, 120_000);

  test("removes validated SQLite sidecars durably before the first database rename", () => {
    const root = privateTemporaryDirectory("oprte-backup-sidecar-cutover-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const archivePath = join(root, "control-plane.hkb");
    createBackup(source, archivePath, release100);
    source.database.close();
    const target = createControlPlane(root, "target", release100, oldInstallation);
    checkpointAndClose(target.database);
    const walPath = `${target.databasePath}-wal`;
    const sharedMemoryPath = `${target.databasePath}-shm`;
    writeFileSync(walPath, Buffer.alloc(0), { mode: 0o600 });
    writeFileSync(sharedMemoryPath, Buffer.alloc(32_768), { mode: 0o600 });

    expect(() => restoreEncryptedControlPlaneBackup({
      archivePath,
      databasePath: target.databasePath,
      passphrase,
      releaseIdentity: release100,
      leaveInterruptedOnFault: true,
      onCheckpoint: (point) => {
        if (point !== "after_prepared") return;
        expect(existsSync(walPath)).toBe(false);
        expect(existsSync(sharedMemoryPath)).toBe(false);
        expect(existsSync(target.databasePath)).toBe(true);
        throw new Error("crash before database rename");
      },
    })).toThrow("crash before database rename");
    expect(recoverInterruptedControlPlaneRestore(target.databasePath)).toEqual({
      kind: "rolled_back",
      phase: "prepared",
    });
    expect(readInstallationIds(target.databasePath)).toContain(oldInstallation);
  }, 60_000);

  test("rejects nonzero, oversized, linked, or symlinked SQLite sidecars before journaling", () => {
    const root = privateTemporaryDirectory("oprte-backup-sidecar-unsafe-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const archivePath = join(root, "control-plane.hkb");
    createBackup(source, archivePath, release100);
    source.database.close();

    for (const variant of ["wal", "oversized_shm", "linked_shm", "symlink_shm"] as const) {
      const target = createControlPlane(
        root,
        `target-${variant}`,
        release100,
        oldInstallation,
      );
      checkpointAndClose(target.database);
      const before = snapshotControlPlanePair(target.databasePath);
      const walPath = `${target.databasePath}-wal`;
      const sharedMemoryPath = `${target.databasePath}-shm`;
      if (variant === "wal") {
        writeFileSync(walPath, Buffer.of(1), { mode: 0o600 });
      } else if (variant === "oversized_shm") {
        writeFileSync(sharedMemoryPath, Buffer.alloc(0), { mode: 0o600 });
        truncateSync(sharedMemoryPath, 32 * 1_024 * 1_024 + 1);
      } else if (variant === "linked_shm") {
        writeFileSync(sharedMemoryPath, Buffer.alloc(32_768), { mode: 0o600 });
        linkSync(sharedMemoryPath, join(target.parent, "unexpected-shm-link"));
      } else {
        const outside = join(target.parent, "outside-shm");
        if (existsSync(sharedMemoryPath)) unlinkSync(sharedMemoryPath);
        writeFileSync(outside, Buffer.alloc(32_768), { mode: 0o600 });
        symlinkSync(outside, sharedMemoryPath);
      }

      expect(() => restoreEncryptedControlPlaneBackup({
        archivePath,
        databasePath: target.databasePath,
        passphrase,
        releaseIdentity: release100,
      })).toThrow("closed and checkpointed");
      expect(snapshotControlPlanePair(target.databasePath)).toEqual(before);
      expect(existsSync(join(target.parent, ".control-plane-restore-v2.json")))
        .toBe(false);
    }
  }, 120_000);

  test("admits the exact historical missing-database restore shape until locked recovery", () => {
    const interrupted = createCanonicalInterruptedRestore(
      "oprte-backup-application-support-recovery-",
    );
    const walPath = `${interrupted.databasePath}-wal`;
    const sharedMemoryPath = `${interrupted.databasePath}-shm`;
    writeFileSync(walPath, Buffer.alloc(0), { mode: 0o600 });
    writeFileSync(sharedMemoryPath, Buffer.alloc(32_768), { mode: 0o600 });

    expect(inspectApplicationSupportReadiness({
      environment: interrupted.environment,
      isFileOpenByAnotherProcess: () => false,
    })).toEqual({ kind: "retry", reason: "interruptedRestore" });
    expect(existsSync(walPath)).toBe(true);
    expect(existsSync(sharedMemoryPath)).toBe(true);

    const startup = prepareApplicationSupportMigration({
      environment: interrupted.environment,
      isFileOpenByAnotherProcess: () => false,
    });
    startup.prepareTargetRoot();
    startup.activate();
    const lifetimeLock = acquireControlPlaneLifetimeLock(interrupted.databasePath);
    try {
      expect(recoverInterruptedControlPlaneRestore(interrupted.databasePath)).toEqual({
        kind: "rolled_back",
        phase: "prepared",
      });
    } finally {
      lifetimeLock.release();
    }
    expect(existsSync(walPath)).toBe(false);
    expect(existsSync(sharedMemoryPath)).toBe(false);
    expect(readInstallationIds(interrupted.databasePath)).toContain(oldInstallation);
  }, 60_000);

  test("recovers an interrupted restore into an uninitialized canonical root", () => {
    const home = privateTemporaryDirectory("oprte-backup-uninitialized-recovery-");
    const environment = { HOME: home };
    const source = createControlPlane(home, "source", release100, sourceInstallation);
    const archivePath = join(home, "control-plane.hkb");
    createBackup(source, archivePath, release100);
    source.database.close();

    const databasePath = defaultControlPlanePath(environment);
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    expect(() => restoreEncryptedControlPlaneBackup({
      archivePath,
      databasePath,
      passphrase,
      releaseIdentity: release100,
      leaveInterruptedOnFault: true,
      onCheckpoint: (point) => {
        if (point === "after_database_rollback_staged") {
          throw new Error("simulated uninitialized restore crash");
        }
      },
    })).toThrow("simulated uninitialized restore crash");
    expect(existsSync(databasePath)).toBe(false);
    const unexpectedRollback = join(
      dirname(databasePath),
      ".control-plane-restore-v2.rollback.sqlite",
    );
    writeFileSync(unexpectedRollback, Buffer.of(1), { mode: 0o600 });
    expect(inspectApplicationSupportReadiness({
      environment,
      isFileOpenByAnotherProcess: () => false,
    })).toEqual({ kind: "conflict", reason: "unsafe" });
    unlinkSync(unexpectedRollback);
    expect(inspectApplicationSupportReadiness({
      environment,
      isFileOpenByAnotherProcess: () => false,
    })).toEqual({ kind: "retry", reason: "interruptedRestore" });

    const startup = prepareApplicationSupportMigration({
      environment,
      isFileOpenByAnotherProcess: () => false,
    });
    startup.prepareTargetRoot();
    startup.activate();
    const lifetimeLock = acquireControlPlaneLifetimeLock(databasePath);
    try {
      expect(recoverInterruptedControlPlaneRestore(databasePath)).toEqual({
        kind: "rolled_back",
        phase: "prepared",
      });
      expect(recoverInterruptedControlPlaneRestore(databasePath)).toEqual({
        kind: "none",
      });
    } finally {
      lifetimeLock.release();
    }
    expect(existsSync(databasePath)).toBe(false);
    expect(inspectApplicationSupportReadiness({
      environment,
      isFileOpenByAnotherProcess: () => false,
    })).toEqual({ kind: "ready" });
  }, 60_000);

  test("Application Support rejects every inexact missing-database restore shape", () => {
    for (const variant of [
      "absent_journal",
      "malformed_journal",
      "changed_stage",
      "nonzero_wal",
      "oversized_shm",
      "linked_shm",
    ] as const) {
      const interrupted = createCanonicalInterruptedRestore(
        `oprte-backup-application-support-${variant}-`,
      );
      const journalPath = join(
        dirname(interrupted.databasePath),
        ".control-plane-restore-v2.json",
      );
      const stagePath = join(
        dirname(interrupted.databasePath),
        ".control-plane-restore-v2.stage.sqlite",
      );
      const walPath = `${interrupted.databasePath}-wal`;
      const sharedMemoryPath = `${interrupted.databasePath}-shm`;
      if (variant === "absent_journal") {
        unlinkSync(journalPath);
        writeFileSync(walPath, Buffer.alloc(0), { mode: 0o600 });
      } else if (variant === "malformed_journal") {
        writeFileSync(journalPath, "{}", { mode: 0o600 });
      } else if (variant === "changed_stage") {
        const stage = Buffer.from(readFileSync(stagePath));
        stage[stage.byteLength - 1] = (stage[stage.byteLength - 1] ?? 0) ^ 1;
        writeFileSync(stagePath, stage, { mode: 0o600 });
      } else if (variant === "nonzero_wal") {
        writeFileSync(walPath, Buffer.of(1), { mode: 0o600 });
      } else if (variant === "oversized_shm") {
        writeFileSync(sharedMemoryPath, Buffer.alloc(0), { mode: 0o600 });
        truncateSync(sharedMemoryPath, 32 * 1_024 * 1_024 + 1);
      } else {
        writeFileSync(sharedMemoryPath, Buffer.alloc(32_768), { mode: 0o600 });
        linkSync(sharedMemoryPath, join(dirname(sharedMemoryPath), "unexpected-shm-link"));
      }

      expect(inspectApplicationSupportReadiness({
        environment: interrupted.environment,
        isFileOpenByAnotherProcess: () => false,
      })).toEqual({ kind: "conflict", reason: "unsafe" });
      expect(existsSync(interrupted.databasePath)).toBe(false);
      expect(existsSync(stagePath)).toBe(true);
    }
  }, 120_000);

  test("rolls an operational failure back before returning it", () => {
    const root = privateTemporaryDirectory("oprte-backup-rollback-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const archivePath = join(root, "control-plane.hkb");
    createBackup(source, archivePath, release100);
    source.database.close();
    const target = createControlPlane(root, "target", release100, oldInstallation);
    const originalKey = Uint8Array.from(target.receiptKey);
    checkpointAndClose(target.database);

    expect(() => restoreEncryptedControlPlaneBackup({
      archivePath,
      databasePath: target.databasePath,
      passphrase,
      releaseIdentity: release100,
      onCheckpoint: (point) => {
        if (point === "after_database_replaced") {
          throw new Error("injected operational failure");
        }
      },
    })).toThrow("injected operational failure");
    expect(readInstallationIds(target.databasePath)).toContain(oldInstallation);
    expect(loadOrCreateOperationReceiptKey(
      operationReceiptKeyPath(target.databasePath),
    )).toEqual(originalKey);
    expect(recoverInterruptedControlPlaneRestore(target.databasePath)).toEqual({
      kind: "none",
    });
  }, 60_000);

  test("refuses corrupt rollback bytes and a stale journal cannot delete live state", () => {
    const root = privateTemporaryDirectory("oprte-backup-journal-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const archivePath = join(root, "control-plane.hkb");
    createBackup(source, archivePath, release100);
    source.database.close();
    const target = createControlPlane(root, "target", release100, oldInstallation);
    checkpointAndClose(target.database);

    expect(() => restoreEncryptedControlPlaneBackup({
      archivePath,
      databasePath: target.databasePath,
      passphrase,
      releaseIdentity: release100,
      leaveInterruptedOnFault: true,
      onCheckpoint: (point) => {
        if (point === "after_database_replaced") throw new Error("crash");
      },
    })).toThrow("crash");
    const rollbackPath = join(
      target.parent,
      ".control-plane-restore-v2.rollback.sqlite",
    );
    const corruptRollback = Buffer.from(readFileSync(rollbackPath));
    const corruptIndex = corruptRollback.byteLength - 1;
    corruptRollback[corruptIndex] = (corruptRollback[corruptIndex] ?? 0) ^ 0x01;
    writeFileSync(rollbackPath, corruptRollback, { mode: 0o600 });
    expect(() => recoverInterruptedControlPlaneRestore(target.databasePath))
      .toThrow("does not match its journaled hash");
    expect(readInstallationIds(target.databasePath)).toContain(sourceInstallation);

    rmSync(target.parent, { recursive: true, force: true });
    const fresh = createControlPlane(root, "target-stale", release100, oldInstallation);
    checkpointAndClose(fresh.database);
    const journalPath = join(fresh.parent, ".control-plane-restore-v2.json");
    const freshVault = inspectControlPlaneAttachmentVault(
      fresh.attachmentVaultRoot,
    );
    const freshRoot = lstatSync(fresh.parent);
    writeFileSync(journalPath, JSON.stringify({
      version: 2,
      kind: "hraness-kitchen-control-plane-restore",
      phase: "database_replaced",
      archiveSha256: "a".repeat(64),
      databaseSha256: "b".repeat(64),
      receiptKeySha256: "c".repeat(64),
      attachmentVaultGenerationSha256: freshVault.generationSha256,
      attachmentVaultInventory: { version: 1, ...freshVault },
      stageCustodyNonce: "f".repeat(64),
      restoreRootDevice: freshRoot.dev,
      restoreRootInode: freshRoot.ino,
      hadDatabase: false,
      hadReceiptKey: false,
      hadAttachmentVault: false,
      originalDatabaseSha256: null,
      originalReceiptKeySha256: null,
      originalAttachmentVaultGenerationSha256: null,
      originalAttachmentVaultInventory: null,
    }), { mode: 0o600 });
    const before = snapshotControlPlanePair(fresh.databasePath);
    expect(() => recoverInterruptedControlPlaneRestore(fresh.databasePath))
      .toThrow("does not match its journaled hash");
    expect(snapshotControlPlanePair(fresh.databasePath)).toEqual(before);
  }, 60_000);

  test("rejects symlinked archive ancestors, destination ancestors, and path-bearing journals", () => {
    const root = privateTemporaryDirectory("oprte-backup-paths-");
    const realDirectory = join(root, "real");
    mkdirSync(realDirectory, { mode: 0o700 });
    const linkedDirectory = join(root, "linked");
    symlinkSync(realDirectory, linkedDirectory);
    const source = createControlPlane(root, "source", release100, sourceInstallation);

    expect(() => createEncryptedControlPlaneBackup({
      database: source.database,
      destinationPath: join(linkedDirectory, "backup.hkb"),
      attachmentVaultRoot: source.attachmentVaultRoot,
      operationReceiptKey: source.receiptKey,
      passphrase,
      releaseIdentity: release100,
    })).toThrow("may not traverse links");

    const archivePath = join(root, "control-plane.hkb");
    createBackup(source, archivePath, release100);
    source.database.close();
    symlinkSync(archivePath, join(realDirectory, "archive.hkb"));
    const target = createControlPlane(root, "target", release100, oldInstallation);
    checkpointAndClose(target.database);
    expect(() => restoreEncryptedControlPlaneBackup({
      archivePath: join(linkedDirectory, "archive.hkb"),
      databasePath: target.databasePath,
      passphrase,
      releaseIdentity: release100,
    })).toThrow("may not traverse links");

    const outsidePath = join(root, "must-survive");
    writeFileSync(outsidePath, "survive", { mode: 0o600 });
    const journalPath = join(target.parent, ".control-plane-restore-v2.json");
    writeFileSync(journalPath, JSON.stringify({
      version: 2,
      kind: "hraness-kitchen-control-plane-restore",
      phase: "prepared",
      archiveSha256: "a".repeat(64),
      databaseSha256: "b".repeat(64),
      receiptKeySha256: "c".repeat(64),
      attachmentVaultGenerationSha256: "d".repeat(64),
      hadDatabase: true,
      hadReceiptKey: true,
      hadAttachmentVault: true,
      originalDatabaseSha256: snapshotControlPlanePair(target.databasePath).database,
      originalReceiptKeySha256: snapshotControlPlanePair(target.databasePath).receiptKey,
      originalAttachmentVaultGenerationSha256: "e".repeat(64),
      rollbackPath: outsidePath,
    }), { mode: 0o600 });
    expect(() => recoverInterruptedControlPlaneRestore(target.databasePath))
      .toThrow("restore journal is invalid");
    expect(readFileSync(outsidePath, "utf8")).toBe("survive");
  }, 60_000);

  test("keeps backup archives disjoint from every live control-plane artifact", () => {
    const root = privateTemporaryDirectory("oprte-backup-alias-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const before = snapshotControlPlanePair(source.databasePath);
    for (const destinationPath of [
      source.databasePath,
      operationReceiptKeyPath(source.databasePath),
      `${source.databasePath}-wal`,
      join(source.parent, ".control-plane-restore-v2.stage.sqlite"),
      join(source.parent, ".control-plane-restore-v2.json"),
      join(source.attachmentVaultRoot, "objects", "new-archive.hkb"),
    ]) {
      const existedBefore = existsSync(destinationPath);
      expect(() => createEncryptedControlPlaneBackup({
        database: source.database,
        destinationPath,
        attachmentVaultRoot: source.attachmentVaultRoot,
        operationReceiptKey: source.receiptKey,
        passphrase,
        releaseIdentity: release100,
      })).toThrow("outside the live control-plane root");
      expect(snapshotControlPlanePair(source.databasePath)).toEqual(before);
      expect(existsSync(destinationPath)).toBe(existedBefore);
    }

    const archivePath = join(root, "control-plane.hkb");
    createBackup(source, archivePath, release100);
    source.database.close();
    const target = createControlPlane(root, "target", release100, oldInstallation);
    checkpointAndClose(target.database);
    const targetBefore = snapshotControlPlanePair(target.databasePath);
    for (const alias of [
      target.databasePath,
      operationReceiptKeyPath(target.databasePath),
      join(target.parent, ".control-plane-restore-v2.stage.sqlite"),
      join(target.attachmentVaultRoot, "objects", "archive.hkb"),
    ]) {
      expect(() => restoreEncryptedControlPlaneBackup({
        archivePath: alias,
        databasePath: target.databasePath,
        passphrase,
        releaseIdentity: release100,
      })).toThrow("outside the live control-plane root");
      expect(snapshotControlPlanePair(target.databasePath)).toEqual(targetBefore);
    }
  }, 60_000);

  test("rejects every exact legacy v1 interrupted restore artifact at startup", () => {
    for (const fileName of [
      ".control-plane-restore-v1.json",
      ".control-plane-restore-v1.json.tmp",
      ".control-plane-restore-v1.stage.sqlite",
      ".control-plane-restore-v1.rollback.sqlite",
      ".control-plane-restore-v1.stage.hmac.key",
      ".control-plane-restore-v1.rollback.hmac.key",
    ]) {
      const home = privateTemporaryDirectory("oprte-backup-legacy-journal-");
      const environment = { HOME: home };
      const databasePath = defaultControlPlanePath(environment);
      mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
      writeFileSync(join(dirname(databasePath), fileName), "{}", { mode: 0o600 });
      expect(inspectApplicationSupportReadiness({
        environment,
        isFileOpenByAnotherProcess: () => false,
      })).toEqual({ kind: "conflict", reason: "unsafe" });
    }
  });
});

function createControlPlane(
  root: string,
  name: string,
  releaseIdentity: AppReleaseIdentity,
  installationId: string,
): Readonly<{
  parent: string;
  databasePath: string;
  attachmentVaultRoot: string;
  database: Database;
  receiptKey: Uint8Array;
}> {
  const parent = join(root, name);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  const databasePath = join(parent, "control-plane.sqlite");
  const attachmentVaultRoot = join(parent, "attachment-vault-v2");
  mkdirSync(join(attachmentVaultRoot, "objects"), {
    recursive: true,
    mode: 0o700,
  });
  const database = openControlPlane(databasePath, {
    releaseIdentity,
    now: () => 1,
  });
  database.query(`
    INSERT INTO local_installations (installation_id, created_at, updated_at)
    VALUES (?1, 1, 1)
  `).run(installationId);
  const receiptKey = loadOrCreateOperationReceiptKey(
    operationReceiptKeyPath(databasePath),
  );
  return { parent, databasePath, attachmentVaultRoot, database, receiptKey };
}

function seedPortableScheduledChatState(
  database: Database,
  state: "active" | "cleared" | "prepared" | "effect_started",
): void {
  const scheduleNow = Date.parse("2026-08-19T12:00:00.000Z");
  const accountId = "acct_backup_schedule_0001";
  const paneId = "pane_backup_schedule_0001";
  const sessionId = `syncsession_${"s".repeat(32)}`;
  database.query(`
    INSERT INTO account_profiles(
      profile_id, label, auth_state, process_generation,
      selected, created_at, updated_at
    ) VALUES (?1, 'Backup schedule', 'signed_in', 1, 1, ?2, ?2)
  `).run(accountId, new Date(scheduleNow).toISOString());
  database.query(`
    INSERT INTO chat_panes(
      pane_id, palette_index, display_order,
      repository_id, repository_name, revision, title,
      account_profile_id, model, reasoning_effort, service_tier,
      interaction_mode, state,
      workspace_mode, workspace_state, workspace_revision,
      workspace_recovery_reason, created_at, updated_at
    ) VALUES (
      ?1, 0, 0,
      ?2, 'Backup schedule fixture', 1, 'Backup schedule fixture',
      ?3, 'gpt-5.6-sol', 'max', 'standard',
      'chat', 'ready',
      'managed_worktree', 'preparing', 1,
      NULL, ?4, ?4
    )
  `).run(
    paneId,
    `repo_${"7".repeat(26)}`,
    accountId,
    new Date(scheduleNow).toISOString(),
  );
  database.query(`
    INSERT INTO session_sync_grid_positions(
      session_id, grid_position, origin, discovered_at
    ) VALUES (?1, 0, 'local', ?2)
  `).run(sessionId, scheduleNow);
  database.query(`
    INSERT INTO session_sync_pane_bindings(
      pane_id, session_id, tenant_id, organization_id, owner_user_id,
      vault_id, vault_generation, origin_device_id, included,
      binding_state, creation_grant_digest, reserved_at, created_at
    ) VALUES (
      ?1, ?2, ?3, ?4, ?5,
      ?6, '1', ?7, 1,
      'accepted', ?8, ?9, ?9
    )
  `).run(
    paneId,
    sessionId,
    `synctenant_${"t".repeat(32)}`,
    `syncorg_${"o".repeat(32)}`,
    `syncuser_${"u".repeat(32)}`,
    `syncvault_${"v".repeat(32)}`,
    `syncdevice_${"d".repeat(32)}`,
    `sha256_${"e".repeat(64)}`,
    scheduleNow,
  );
  const rrule = "DTSTART;TZID=America/Puerto_Rico:20260820T090000\nRRULE:FREQ=DAILY;INTERVAL=1";
  if (state === "active") {
    database.query(`
      INSERT INTO chat_scheduled_chats(
        pane_id, session_id, revision, generation, key_epoch,
        rrule, time_zone, next_run_at, definition_ciphertext_digest,
        created_at, updated_at
      ) VALUES (
        ?1, ?2, 1, '1', '1',
        ?3, 'America/Puerto_Rico', ?4, ?5,
        ?6, ?6
      )
    `).run(
      paneId,
      sessionId,
      rrule,
      scheduleNow + 60_000,
      `sha256_${"f".repeat(64)}`,
      scheduleNow,
    );
    return;
  }
  if (state === "prepared" || state === "effect_started") {
    database.query(`
      INSERT INTO chat_scheduled_chat_mutations(
        operation_id, pane_id, session_id, kind, state,
        expected_pane_revision, expected_schedule_revision,
        target_schedule_revision, target_generation, request_json,
        request_digest, rrule, time_zone, next_run_at,
        definition_ciphertext_digest, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, 'put', ?4,
        1, NULL,
        1, '1', '{}',
        ?5, ?6, 'America/Puerto_Rico', ?7,
        ?8, ?9, ?9
      )
    `).run(
      `syncop_${state === "prepared" ? "p".repeat(32) : "e".repeat(32)}`,
      paneId,
      sessionId,
      state,
      `sha256_${"1".repeat(64)}`,
      rrule,
      scheduleNow + 60_000,
      `sha256_${"2".repeat(64)}`,
      scheduleNow,
    );
    return;
  }
  database.query(`
    INSERT INTO chat_scheduled_chat_generation_high_water(
      pane_id, session_id, generation, updated_at
    ) VALUES (?1, ?2, '7', ?3)
  `).run(paneId, sessionId, scheduleNow);
  database.query(`
    INSERT INTO chat_scheduled_chat_runs(
      run_id, pane_id, session_id, schedule_generation,
      occurrence_sequence, scheduled_for, message_id, state,
      enqueued_at, acknowledged_at, cancelled_at
    ) VALUES (
      ?1, ?2, ?3, '7',
      '3', ?4, ?5, 'acknowledged',
      ?6, ?6, ?6
    )
  `).run(
    `syncrun_${"A".repeat(26)}`,
    paneId,
    sessionId,
    scheduleNow - 60_000,
    `chatmsg_${"c".repeat(24)}`,
    scheduleNow,
  );
}

function downgradeScheduledChatSchemaToV61(database: Database): void {
  database.exec(`
    DROP TRIGGER chat_scheduled_chat_desired_off_pane_update_quarantine;
    DROP TRIGGER chat_scheduled_chat_desired_off_pane_delete_quarantine;
    DROP TABLE chat_scheduled_chat_desired_off;
    DELETE FROM schema_migrations WHERE version = 62;
    UPDATE app_release_state SET migration_version = 61;
  `);
}

function createCanonicalInterruptedRestore(
  prefix: string,
): Readonly<{
  environment: NodeJS.ProcessEnv;
  databasePath: string;
}> {
  const home = privateTemporaryDirectory(prefix);
  const environment = { HOME: home };
  const source = createControlPlane(home, "source", release100, sourceInstallation);
  const archivePath = join(home, "control-plane.hkb");
  createBackup(source, archivePath, release100);
  source.database.close();

  const databasePath = defaultControlPlanePath(environment);
  const database = openControlPlane(databasePath, {
    releaseIdentity: release100,
    now: () => 1,
  });
  database.query(`
    INSERT INTO local_installations (installation_id, created_at, updated_at)
    VALUES (?1, 1, 1)
  `).run(oldInstallation);
  const receiptKey = loadOrCreateOperationReceiptKey(
    operationReceiptKeyPath(databasePath),
  );
  receiptKey.fill(0);
  checkpointAndClose(database);

  expect(() => restoreEncryptedControlPlaneBackup({
    archivePath,
    databasePath,
    passphrase,
    releaseIdentity: release100,
    leaveInterruptedOnFault: true,
    onCheckpoint: (point) => {
      if (point === "after_database_rollback_staged") {
        throw new Error("simulated historical restore crash");
      }
    },
  })).toThrow("simulated historical restore crash");
  expect(existsSync(databasePath)).toBe(false);
  return { environment, databasePath };
}

function createBackup(
  source: Readonly<{
    database: Database;
    receiptKey: Uint8Array;
    attachmentVaultRoot: string;
  }>,
  archivePath: string,
  releaseIdentity: AppReleaseIdentity,
) {
  return createEncryptedControlPlaneBackup({
    database: source.database,
    destinationPath: archivePath,
    attachmentVaultRoot: source.attachmentVaultRoot,
    operationReceiptKey: source.receiptKey,
    passphrase,
    releaseIdentity,
    now: () => 1_785_000_000_000,
  });
}

function checkpointAndClose(database: Database): void {
  database.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE");
  database.close();
}

function readInstallationIds(databasePath: string): readonly string[] {
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    return database
      .query<{ installation_id: string }, []>(`
        SELECT installation_id FROM local_installations ORDER BY installation_id
      `)
      .all()
      .map(({ installation_id }) => installation_id);
  } finally {
    database.close();
  }
}

function snapshotControlPlanePair(databasePath: string): Readonly<{
  database: string;
  receiptKey: string;
}> {
  return {
    database: fileSha256(databasePath),
    receiptKey: fileSha256(operationReceiptKeyPath(databasePath)),
  };
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function captureControlPlaneBackupError(
  operation: () => unknown,
): ControlPlaneBackupError {
  try {
    operation();
  } catch (error: unknown) {
    if (error instanceof ControlPlaneBackupError) return error;
    throw error;
  }
  throw new Error("Expected a control-plane backup error");
}

function makeFifo(path: string): void {
  const result = Bun.spawnSync(["/usr/bin/mkfifo", path]);
  if (result.exitCode !== 0) {
    throw new Error("Could not create FIFO fixture");
  }
}

function crashMaterialization(input: Readonly<{
  archivePath: string;
  databasePath: string;
  archiveSha256: string;
  checkpoint: "after_database_staged" | "after_attachment_blob_staged";
}>): void {
  const backupModuleUrl = new URL(
    "../src/state/control-plane-backup.ts",
    import.meta.url,
  ).href;
  const source = `
    import {
      closeSync,
      constants,
      fsyncSync,
      openSync,
      readFileSync,
      renameSync,
      writeFileSync,
    } from "node:fs";
    import { dirname, join } from "node:path";
    import { prepareAuthenticatedControlPlaneRestoreStage } from ${JSON.stringify(backupModuleUrl)};
    const prepared = prepareAuthenticatedControlPlaneRestoreStage({
      archivePath: ${JSON.stringify(input.archivePath)},
      databasePath: ${JSON.stringify(input.databasePath)},
      passphrase: ${JSON.stringify(passphrase)},
      releaseIdentity: ${JSON.stringify(release100)},
      confirmedArchiveSha256: ${JSON.stringify(input.archiveSha256)},
      onStageCheckpoint(point) {
        if (point === ${JSON.stringify(input.checkpoint)}) process.exit(73);
      },
    });
    const journalPath = join(
      dirname(${JSON.stringify(input.databasePath)}),
      ".control-plane-restore-v2.json",
    );
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    journal.stageCustodyNonce = prepared.stageCustodyNonce;
    const journalCandidate = journalPath + ".fixture";
    writeFileSync(journalCandidate, JSON.stringify(journal), { mode: 0o600 });
    const journalDescriptor = openSync(journalCandidate, constants.O_RDONLY);
    fsyncSync(journalDescriptor);
    closeSync(journalDescriptor);
    renameSync(journalCandidate, journalPath);
    const parentDescriptor = openSync(
      dirname(journalPath),
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    fsyncSync(parentDescriptor);
    closeSync(parentDescriptor);
    prepared.transferToJournal();
    process.exit(74);
  `;
  const result = Bun.spawnSync([process.execPath, "-e", source], {
    cwd: process.cwd(),
    env: process.env,
  });
  if (result.exitCode !== 73) {
    throw new Error(
      `Materialization crash fixture exited ${result.exitCode}: ${result.stderr.toString()}`,
    );
  }
}

function restoreEncryptedControlPlaneBackup(
  input: Omit<RestoreControlPlaneBackupInput, "confirmedArchiveSha256">
    & Readonly<{ confirmedArchiveSha256?: string }>,
) {
  return restoreEncryptedControlPlaneBackupCore({
    ...input,
    confirmedArchiveSha256:
      input.confirmedArchiveSha256
      ?? (existsSync(input.archivePath)
        ? fileSha256(input.archivePath)
        : "0".repeat(64)),
  });
}

function writeAuthenticatedPayloadCorruption(
  sourcePath: string,
  destinationPath: string,
): void {
  const archive = Buffer.from(readFileSync(sourcePath));
  const archiveMagicByteLength = 8;
  const manifestLengthPrefixByteLength = 4;
  const authenticationTagByteLength = 16;
  const manifestLength = archive.readUInt32BE(archiveMagicByteLength);
  const manifestOffset = archiveMagicByteLength
    + manifestLengthPrefixByteLength;
  const ciphertextOffset = manifestOffset + manifestLength;
  const tagOffset = archive.byteLength - authenticationTagByteLength;
  const manifestBytes = archive.subarray(manifestOffset, ciphertextOffset);
  const manifestValue: unknown = JSON.parse(manifestBytes.toString("utf8"));
  const kdf = recordField(manifestValue, "kdf");
  const cipherMetadata = recordField(manifestValue, "cipher");
  const salt = Buffer.from(stringField(kdf, "salt"), "base64");
  const iv = Buffer.from(stringField(cipherMetadata, "iv"), "base64");
  const key = scryptSync(passphrase, salt, 32, {
    N: 131_072,
    r: 8,
    p: 1,
    maxmem: 256 * 1_024 * 1_024,
  });
  let decrypted: Buffer | null = null;
  let ciphertext: Buffer | null = null;
  let authenticationTag: Buffer | null = null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, {
      authTagLength: authenticationTagByteLength,
    });
    decipher.setAAD(Buffer.concat([
      archive.subarray(0, archiveMagicByteLength),
      manifestBytes,
    ]));
    decipher.setAuthTag(archive.subarray(tagOffset));
    decrypted = Buffer.concat([
      decipher.update(archive.subarray(ciphertextOffset, tagOffset)),
      decipher.final(),
    ]);
    const corruptIndex = decrypted.byteLength - 1;
    decrypted[corruptIndex] = (decrypted[corruptIndex] ?? 0) ^ 0x01;
    const cipher = createCipheriv("aes-256-gcm", key, iv, {
      authTagLength: authenticationTagByteLength,
    });
    cipher.setAAD(Buffer.concat([
      archive.subarray(0, archiveMagicByteLength),
      manifestBytes,
    ]));
    ciphertext = Buffer.concat([cipher.update(decrypted), cipher.final()]);
    authenticationTag = cipher.getAuthTag();
    writeFileSync(destinationPath, Buffer.concat([
      archive.subarray(0, ciphertextOffset),
      ciphertext,
      authenticationTag,
    ]), { mode: 0o600 });
  } finally {
    key.fill(0);
    decrypted?.fill(0);
    ciphertext?.fill(0);
    authenticationTag?.fill(0);
  }
}

function writeAuthenticatedPortableCountCorruption(
  sourcePath: string,
  destinationPath: string,
): void {
  const archive = Buffer.from(readFileSync(sourcePath));
  const archiveMagicByteLength = 8;
  const manifestLengthPrefixByteLength = 4;
  const authenticationTagByteLength = 16;
  const manifestLength = archive.readUInt32BE(archiveMagicByteLength);
  const manifestOffset = archiveMagicByteLength
    + manifestLengthPrefixByteLength;
  const ciphertextOffset = manifestOffset + manifestLength;
  const tagOffset = archive.byteLength - authenticationTagByteLength;
  const manifestBytes = archive.subarray(manifestOffset, ciphertextOffset);
  const manifestValue: unknown = JSON.parse(manifestBytes.toString("utf8"));
  const kdf = recordField(manifestValue, "kdf");
  const cipherMetadata = recordField(manifestValue, "cipher");
  const portable = recordField(manifestValue, "portableProviderContext");
  if (portable.removedArchiveCutCount !== 1) {
    throw new Error("Expected one portable v57 cut in corruption fixture");
  }
  portable.removedArchiveCutCount = 2;
  const changedManifestBytes = Buffer.from(JSON.stringify(manifestValue), "utf8");
  if (changedManifestBytes.byteLength !== manifestBytes.byteLength) {
    throw new Error("Portable count corruption changed the manifest length");
  }
  const salt = Buffer.from(stringField(kdf, "salt"), "base64");
  const iv = Buffer.from(stringField(cipherMetadata, "iv"), "base64");
  const key = scryptSync(passphrase, salt, 32, {
    N: 131_072,
    r: 8,
    p: 1,
    maxmem: 256 * 1_024 * 1_024,
  });
  let decrypted: Buffer | null = null;
  let ciphertext: Buffer | null = null;
  let authenticationTag: Buffer | null = null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, {
      authTagLength: authenticationTagByteLength,
    });
    decipher.setAAD(Buffer.concat([
      archive.subarray(0, archiveMagicByteLength),
      manifestBytes,
    ]));
    decipher.setAuthTag(archive.subarray(tagOffset));
    decrypted = Buffer.concat([
      decipher.update(archive.subarray(ciphertextOffset, tagOffset)),
      decipher.final(),
    ]);
    const cipher = createCipheriv("aes-256-gcm", key, iv, {
      authTagLength: authenticationTagByteLength,
    });
    cipher.setAAD(Buffer.concat([
      archive.subarray(0, archiveMagicByteLength),
      changedManifestBytes,
    ]));
    ciphertext = Buffer.concat([cipher.update(decrypted), cipher.final()]);
    authenticationTag = cipher.getAuthTag();
    writeFileSync(destinationPath, Buffer.concat([
      archive.subarray(0, manifestOffset),
      changedManifestBytes,
      ciphertext,
      authenticationTag,
    ]), { mode: 0o600 });
  } finally {
    key.fill(0);
    decrypted?.fill(0);
    ciphertext?.fill(0);
    authenticationTag?.fill(0);
    changedManifestBytes.fill(0);
  }
}

function recordField(value: unknown, field: string): Record<string, unknown> {
  const record = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
  const candidate = record?.[field];
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error(`Expected ${field} record`);
  }
  return candidate as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string") throw new Error(`Expected ${field} string`);
  return candidate;
}

function privateTemporaryDirectory(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaryDirectories.push(root);
  chmodSync(root, 0o700);
  return root;
}
