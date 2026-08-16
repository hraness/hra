import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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
  inspectEncryptedControlPlaneBackup,
  recoverInterruptedControlPlaneRestore,
  restoreEncryptedControlPlaneBackup,
  verifyEncryptedControlPlaneBackup,
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
const temporaryDirectories: string[] = [];

function backupCandidatePath(archivePath: string): string {
  return join(dirname(archivePath), `.${basename(archivePath)}.hraness-backup-v1.tmp`);
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("encrypted control-plane backup and restore", () => {
  test("round-trips SQLite control-plane state and its non-credential receipt key", () => {
    const root = privateTemporaryDirectory("oprte-backup-roundtrip-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const archivePath = join(root, "control-plane.hkb");
    const result = createBackup(source, archivePath, release100);
    source.database.close();

    expect(result.manifest).toMatchObject({
      formatVersion: 1,
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
      operationReceiptKey: source.receiptKey,
      passphrase,
      releaseIdentity: release100,
      replaceExisting: false,
    })).toThrow("already exists");
    expect(readFileSync(archivePath, "utf8")).toBe("must survive");
    source.database.close();
  }, 60_000);

  test("self-heals only the exact published create-only hard-link crash", () => {
    const root = privateTemporaryDirectory("oprte-backup-create-only-recovery-");
    const source = createControlPlane(root, "source", release100, sourceInstallation);
    const archivePath = join(root, "published.hkb");
    const result = createEncryptedControlPlaneBackup({
      database: source.database,
      destinationPath: archivePath,
      operationReceiptKey: source.receiptKey,
      passphrase,
      releaseIdentity: release100,
      replaceExisting: false,
      now: () => 1_785_000_000_000,
    });
    const candidatePath = backupCandidatePath(archivePath);
    const publishedBytes = Buffer.from(readFileSync(archivePath));

    linkSync(archivePath, candidatePath);
    expect(lstatSync(archivePath).nlink).toBe(2);
    expect(inspectEncryptedControlPlaneBackup(archivePath)).toEqual(result.manifest);
    expect(existsSync(candidatePath)).toBe(false);
    expect(lstatSync(archivePath).nlink).toBe(1);

    linkSync(archivePath, candidatePath);
    expect(verifyEncryptedControlPlaneBackup({
      archivePath,
      passphrase,
      releaseIdentity: release100,
    }).archiveSha256).toBe(result.archiveSha256);
    expect(existsSync(candidatePath)).toBe(false);

    linkSync(archivePath, candidatePath);
    expect(() => createEncryptedControlPlaneBackup({
      database: source.database,
      destinationPath: archivePath,
      operationReceiptKey: source.receiptKey,
      passphrase,
      releaseIdentity: release100,
      replaceExisting: false,
    })).toThrow("already exists");
    expect(existsSync(candidatePath)).toBe(false);
    expect(readFileSync(archivePath)).toEqual(publishedBytes);
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
      "after_validation",
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
      expect(existsSync(join(target.parent, ".control-plane-restore-v1.json")))
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
      ".control-plane-restore-v1.rollback.sqlite",
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
        ".control-plane-restore-v1.json",
      );
      const stagePath = join(
        dirname(interrupted.databasePath),
        ".control-plane-restore-v1.stage.sqlite",
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
      ".control-plane-restore-v1.rollback.sqlite",
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
    const journalPath = join(fresh.parent, ".control-plane-restore-v1.json");
    writeFileSync(journalPath, JSON.stringify({
      version: 1,
      kind: "hraness-kitchen-control-plane-restore",
      phase: "database_replaced",
      archiveSha256: "a".repeat(64),
      databaseSha256: "b".repeat(64),
      receiptKeySha256: "c".repeat(64),
      hadDatabase: false,
      hadReceiptKey: false,
      originalDatabaseSha256: null,
      originalReceiptKeySha256: null,
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
    const journalPath = join(target.parent, ".control-plane-restore-v1.json");
    writeFileSync(journalPath, JSON.stringify({
      version: 1,
      kind: "hraness-kitchen-control-plane-restore",
      phase: "prepared",
      archiveSha256: "a".repeat(64),
      databaseSha256: "b".repeat(64),
      receiptKeySha256: "c".repeat(64),
      hadDatabase: true,
      hadReceiptKey: true,
      originalDatabaseSha256: snapshotControlPlanePair(target.databasePath).database,
      originalReceiptKeySha256: snapshotControlPlanePair(target.databasePath).receiptKey,
      rollbackPath: outsidePath,
    }), { mode: 0o600 });
    expect(() => recoverInterruptedControlPlaneRestore(target.databasePath))
      .toThrow("restore journal is invalid");
    expect(readFileSync(outsidePath, "utf8")).toBe("survive");
  }, 60_000);
});

function createControlPlane(
  root: string,
  name: string,
  releaseIdentity: AppReleaseIdentity,
  installationId: string,
): Readonly<{
  parent: string;
  databasePath: string;
  database: Database;
  receiptKey: Uint8Array;
}> {
  const parent = join(root, name);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  const databasePath = join(parent, "control-plane.sqlite");
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
  return { parent, databasePath, database, receiptKey };
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
  }>,
  archivePath: string,
  releaseIdentity: AppReleaseIdentity,
) {
  return createEncryptedControlPlaneBackup({
    database: source.database,
    destinationPath: archivePath,
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
