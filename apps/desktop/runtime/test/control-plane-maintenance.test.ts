import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { hraReleaseIdentity } from "../release-identity";
import {
  readBoundedMaintenanceStdin,
  runControlPlaneMaintenance,
  type ControlPlaneMaintenanceIO,
} from "../control-plane-maintenance";
import { acquireControlPlaneLifetimeLock } from "../src/state/control-plane-lock";
import {
  applicationSupportPaths,
  prepareApplicationSupportMigration,
} from "../src/state/application-support";
import {
  defaultControlPlanePath,
  openControlPlane,
} from "../src/state/database";
import {
  loadOrCreateOperationReceiptKey,
  operationReceiptKeyPath,
} from "../src/state/operation-receipt-key";
import { currentControlPlaneMigrationVersion } from "../src/state/release-compatibility";

const passphrase = "fixture backup passphrase with sufficient entropy";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("control-plane maintenance tool", () => {
  test("bounds and strictly decodes production secret input before materializing it", async () => {
    const chunks = [
      new TextEncoder().encode("split "),
      new TextEncoder().encode("secret\n"),
    ];
    expect(await readBoundedMaintenanceStdin(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }))).toBe("split secret\n");

    let cancelled = false;
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(12_289));
      },
      cancel() {
        cancelled = true;
      },
    });
    expect(readBoundedMaintenanceStdin(oversized)).rejects.toMatchObject({
      code: "invalid_passphrase_input",
      action: "use_piped_passphrase",
    });
    expect(cancelled).toBe(true);

    expect(readBoundedMaintenanceStdin(new ReadableStream({
      start(controller) {
        controller.enqueue(Uint8Array.of(0xff));
        controller.close();
      },
    }))).rejects.toMatchObject({
      code: "invalid_passphrase_input",
      action: "use_piped_passphrase",
    });
  });

  test("reports a fresh installation without creating local state", async () => {
    const home = temporaryHome();
    const capture = capturedIO();

    expect(await runControlPlaneMaintenance({
      args: ["doctor"],
      environment: { HOME: home },
      io: capture.io,
    })).toBe(0);
    expect(capture.output()).toEqual([{
      schemaVersion: 1,
      command: "doctor",
      status: "fresh",
      action: "launch_hra",
    }]);
    expect(capture.errors()).toEqual([]);
  });

  test("distinguishes an existing uninitialized root from a fresh install", async () => {
    const home = temporaryHome();
    const paths = applicationSupportPaths(home);
    mkdirSync(paths.target, { recursive: true, mode: 0o700 });
    const capture = capturedIO();

    expect(await runControlPlaneMaintenance({
      args: ["doctor"],
      environment: { HOME: home },
      io: capture.io,
    })).toBe(0);
    expect(capture.output()).toEqual([{
      schemaVersion: 1,
      command: "doctor",
      status: "uninitialized",
      action: "launch_hra",
    }]);
  });

  test("reports missing established control-plane state as unhealthy instead of fresh", async () => {
    const home = temporaryHome();
    const paths = applicationSupportPaths(home);
    mkdirSync(paths.target, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(paths.target, "operation-receipts.hmac.key"),
      Buffer.alloc(32, 0x5a),
      { mode: 0o600 },
    );
    const capture = capturedIO();

    expect(await runControlPlaneMaintenance({
      args: ["doctor"],
      environment: { HOME: home },
      io: capture.io,
    })).toBe(1);
    expect(capture.output()).toEqual([]);
    expect(capture.errors()).toEqual([{
      schemaVersion: 1,
      status: "error",
      code: "state_unhealthy",
      action: "review_state_recovery",
      reason: "application_support_unsafe",
    }]);
  });

  test("proves current SQLite, migration, and receipt authority while stopped", async () => {
    const home = temporaryHome();
    const databasePath = createControlPlane(home);
    const capture = capturedIO();

    expect(await runControlPlaneMaintenance({
      args: ["doctor"],
      environment: { HOME: home },
      io: capture.io,
    })).toBe(0);
    expect(capture.output()).toEqual([{
      schemaVersion: 1,
      command: "doctor",
      status: "ready",
      migrationVersion: currentControlPlaneMigrationVersion,
    }]);
    expect(capture.errors()).toEqual([]);
    expect(readFileSync(operationReceiptKeyPath(databasePath)).byteLength).toBe(32);
  });

  test("reports preserved legacy account overflow as an actionable recovery state", async () => {
    const home = temporaryHome();
    const databasePath = createControlPlane(home);
    const database = new Database(databasePath, { strict: true });
    try {
      database.query(`
        INSERT INTO account_profiles (
          profile_id, label, auth_state, process_generation, created_at,
          updated_at, revision, selected
        ) VALUES (
          'acct_doctor_capacity_001', 'Preserved overflow', 'signedOut', 0,
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z', 1, 0
        )
      `).run();
      database.query(`
        INSERT INTO account_profile_capacity_quarantine (
          profile_id, reason, evidence_revision, original_removed_at, created_at
        ) VALUES (
          'acct_doctor_capacity_001', 'legacy_capacity_overflow', 1, NULL,
          '2026-08-08T00:00:00.000Z'
        )
      `).run();
    } finally {
      database.close();
    }
    const capture = capturedIO();

    expect(await runControlPlaneMaintenance({
      args: ["doctor"],
      environment: { HOME: home },
      io: capture.io,
    })).toBe(1);
    expect(capture.output()).toEqual([]);
    expect(capture.errors()).toEqual([{
      schemaVersion: 1,
      status: "error",
      code: "state_unhealthy",
      action: "review_state_recovery",
      reason: "account_profile_capacity_quarantine",
    }]);
  });

  test("fails with a path-free action while the app lifetime lock is held", async () => {
    const home = temporaryHome();
    const databasePath = createControlPlane(home);
    const lock = acquireControlPlaneLifetimeLock(databasePath);
    const capture = capturedIO();
    try {
      expect(await runControlPlaneMaintenance({
        args: ["doctor"],
        environment: { HOME: home },
        io: capture.io,
      })).toBe(1);
    } finally {
      lock.release();
    }
    expect(capture.output()).toEqual([]);
    expect(capture.errors()).toEqual([{
      schemaVersion: 1,
      status: "error",
      code: "app_running",
      action: "quit_hra_and_retry",
    }]);
  });

  test("creates and inspects one encrypted create-only backup", async () => {
    const home = temporaryHome();
    createControlPlane(home);
    const archivePath = join(home, "backup.oprte");
    const createCapture = capturedIO(`${passphrase}\n${passphrase}\n`);

    const createExit = await runControlPlaneMaintenance({
      args: ["backup", archivePath],
      environment: { HOME: home },
      io: createCapture.io,
    });
    expect({ exit: createExit, errors: createCapture.errors() }).toEqual({
      exit: 0,
      errors: [],
    });
    expect(createCapture.errors()).toEqual([]);
    expect(createCapture.output()[0]).toMatchObject({
      schemaVersion: 1,
      command: "backup",
      status: "created",
      sourceMigrationVersion: currentControlPlaneMigrationVersion,
    });
    expect(readFileSync(archivePath).toString("latin1")).not.toContain(passphrase);
    const archiveBytes = Buffer.from(readFileSync(archivePath));

    const inspectCapture = capturedIO();
    expect(await runControlPlaneMaintenance({
      args: ["inspect", archivePath],
      environment: { HOME: home },
      io: inspectCapture.io,
    })).toBe(0);
    expect(inspectCapture.output()[0]).toMatchObject({
      schemaVersion: 1,
      command: "inspect",
      status: "headerReadable",
      sourceRelease: hraReleaseIdentity,
      sourceMigrationVersion: currentControlPlaneMigrationVersion,
    });

    const candidatePath = join(
      dirname(archivePath),
      `.${basename(archivePath)}.hraness-backup-v1.tmp`,
    );
    linkSync(archivePath, candidatePath);
    expect(lstatSync(archivePath).nlink).toBe(2);

    const repeatCapture = capturedIO(`${passphrase}\n${passphrase}\n`);
    expect(await runControlPlaneMaintenance({
      args: ["backup", archivePath],
      environment: { HOME: home },
      io: repeatCapture.io,
    })).toBe(1);
    expect(repeatCapture.errors()).toEqual([{
      schemaVersion: 1,
      status: "error",
      code: "archive_exists",
      action: "choose_new_archive_path",
    }]);
    expect(existsSync(candidatePath)).toBe(false);
    expect(lstatSync(archivePath).nlink).toBe(1);
    expect(readFileSync(archivePath)).toEqual(archiveBytes);
  }, 60_000);

  test("rejects unsafe secret input without echoing secret or path", async () => {
    const home = temporaryHome();
    createControlPlane(home);
    const archivePath = join(home, "must-not-exist.oprte");
    const capture = capturedIO(`${passphrase}\ndifferent confirmation value\n`);

    expect(await runControlPlaneMaintenance({
      args: ["backup", archivePath],
      environment: { HOME: home },
      io: capture.io,
    })).toBe(1);
    const serialized = JSON.stringify(capture.errors());
    expect(serialized).not.toContain(passphrase);
    expect(serialized).not.toContain(archivePath);
    expect(capture.errors()).toEqual([{
      schemaVersion: 1,
      status: "error",
      code: "invalid_passphrase_input",
      action: "use_piped_passphrase",
    }]);
  });

  test("authenticates an exact archive and restores it only after digest intent", async () => {
    const home = temporaryHome();
    createControlPlane(home, "install_before_backup");
    const archivePath = join(home, "verified-backup.oprte");
    const backupCapture = capturedIO(`${passphrase}\n${passphrase}\n`);
    expect(await runControlPlaneMaintenance({
      args: ["backup", archivePath],
      environment: { HOME: home },
      io: backupCapture.io,
    })).toBe(0);
    const archiveSha256 = stringField(
      backupCapture.output()[0],
      "archiveSha256",
    );

    replaceInstallation(home, "install_after_backup");
    const verifyCapture = capturedIO(`${passphrase}\n`);
    expect(await runControlPlaneMaintenance({
      args: ["verify", archivePath],
      environment: { HOME: home },
      io: verifyCapture.io,
    })).toBe(0);
    expect(verifyCapture.output()[0]).toMatchObject({
      schemaVersion: 1,
      command: "verify",
      status: "verified",
      archiveSha256,
      sourceRelease: hraReleaseIdentity,
      sourceMigrationVersion: currentControlPlaneMigrationVersion,
    });

    const refused = capturedIO(`${passphrase}\nRESTORE ${"0".repeat(64)}\n`);
    expect(await runControlPlaneMaintenance({
      args: ["restore", archivePath],
      environment: { HOME: home },
      io: refused.io,
    })).toBe(1);
    expect(refused.errors()).toEqual([{
      schemaVersion: 1,
      status: "error",
      code: "invalid_restore_confirmation",
      action: "use_verified_archive_confirmation",
      reason: "archive_confirmation_failed",
    }]);
    expect(readInstallationIds(home)).toEqual(["install_after_backup"]);

    const restoreCapture = capturedIO(
      `${passphrase}\nRESTORE ${archiveSha256}\n`,
    );
    expect(await runControlPlaneMaintenance({
      args: ["restore", archivePath],
      environment: { HOME: home },
      io: restoreCapture.io,
    })).toBe(0);
    expect(restoreCapture.output()[0]).toMatchObject({
      schemaVersion: 1,
      command: "restore",
      status: "restored",
      archiveSha256,
      sourceRelease: hraReleaseIdentity,
      restoredMigrationVersion: currentControlPlaneMigrationVersion,
    });
    expect(readInstallationIds(home)).toEqual(["install_before_backup"]);
  }, 120_000);

  test("verify rejects wrong authentication and modified ciphertext path-free", async () => {
    const home = temporaryHome();
    createControlPlane(home);
    const archivePath = join(home, "auth-backup.oprte");
    const backupCapture = capturedIO(`${passphrase}\n${passphrase}\n`);
    expect(await runControlPlaneMaintenance({
      args: ["backup", archivePath],
      environment: { HOME: home },
      io: backupCapture.io,
    })).toBe(0);

    for (const [candidatePath, secret] of [
      [archivePath, "wrong passphrase that is long enough"],
      [join(home, "tampered.oprte"), passphrase],
    ] as const) {
      if (candidatePath !== archivePath) {
        const tampered = Buffer.from(readFileSync(archivePath));
        const index = tampered.byteLength - 1;
        tampered[index] = (tampered[index] ?? 0) ^ 0x01;
        writeFileSync(candidatePath, tampered, { mode: 0o600 });
      }
      const capture = capturedIO(`${secret}\n`);
      expect(await runControlPlaneMaintenance({
        args: ["verify", candidatePath],
        environment: { HOME: home },
        io: capture.io,
      })).toBe(1);
      expect(capture.errors()).toEqual([{
        schemaVersion: 1,
        status: "error",
        code: "tool_failure",
        action: "review_state_recovery",
        reason: "archive_authentication_failed",
      }]);
      const serialized = JSON.stringify(capture.errors());
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(candidatePath);
      expect(serialized).not.toContain(home);
    }
  }, 120_000);

  test("verifies recovery evidence even when local application state is absent", async () => {
    const sourceHome = temporaryHome();
    createControlPlane(sourceHome);
    const archivePath = join(sourceHome, "recovery-evidence.oprte");
    const backupCapture = capturedIO(`${passphrase}\n${passphrase}\n`);
    expect(await runControlPlaneMaintenance({
      args: ["backup", archivePath],
      environment: { HOME: sourceHome },
      io: backupCapture.io,
    })).toBe(0);

    const recoveryHome = temporaryHome();
    const verifyCapture = capturedIO(`${passphrase}\n`);
    expect(await runControlPlaneMaintenance({
      args: ["verify", archivePath],
      environment: { HOME: recoveryHome },
      io: verifyCapture.io,
    })).toBe(0);
    expect(verifyCapture.output()[0]).toMatchObject({
      schemaVersion: 1,
      command: "verify",
      status: "verified",
    });
    expect(existsSync(join(recoveryHome, "Library"))).toBe(false);
  }, 120_000);

  test("requires the app to be stopped for authenticated archive operations", async () => {
    const home = temporaryHome();
    const databasePath = createControlPlane(home);
    const archivePath = join(home, "locked.oprte");
    const backupCapture = capturedIO(`${passphrase}\n${passphrase}\n`);
    expect(await runControlPlaneMaintenance({
      args: ["backup", archivePath],
      environment: { HOME: home },
      io: backupCapture.io,
    })).toBe(0);
    const archiveSha256 = stringField(
      backupCapture.output()[0],
      "archiveSha256",
    );
    const lock = acquireControlPlaneLifetimeLock(databasePath);
    try {
      for (const [command, stdin] of [
        ["verify", `${passphrase}\n`],
        ["restore", `${passphrase}\nRESTORE ${archiveSha256}\n`],
      ] as const) {
        const capture = capturedIO(stdin);
        expect(await runControlPlaneMaintenance({
          args: [command, archivePath],
          environment: { HOME: home },
          io: capture.io,
        })).toBe(1);
        expect(capture.errors()).toEqual([{
          schemaVersion: 1,
          status: "error",
          code: "app_running",
          action: "quit_hra_and_retry",
        }]);
      }
    } finally {
      lock.release();
    }
  }, 120_000);

  test("verify rejects the live Application Support migration lock", async () => {
    const home = temporaryHome();
    const archivePath = join(home, "must-not-be-read.oprte");
    const capture = capturedIO(`${passphrase}\n`);
    expect(await runControlPlaneMaintenance({
      args: ["verify", archivePath],
      environment: { HOME: home },
      inspectReadiness: () => ({ kind: "conflict", reason: "locked" }),
      io: capture.io,
    })).toBe(1);
    expect(capture.errors()).toEqual([{
      schemaVersion: 1,
      status: "error",
      code: "app_running",
      action: "quit_hra_and_retry",
    }]);
  });

  test("doctor reports legacy retry and root conflict without choosing a root", async () => {
    const legacyHome = temporaryHome();
    const legacyPaths = applicationSupportPaths(legacyHome);
    mkdirSync(legacyPaths.legacy, { recursive: true, mode: 0o700 });
    const legacyCapture = capturedIO();
    expect(await runControlPlaneMaintenance({
      args: ["doctor"],
      environment: { HOME: legacyHome },
      io: legacyCapture.io,
    })).toBe(1);
    expect(legacyCapture.errors()).toEqual([{
      schemaVersion: 1,
      status: "error",
      code: "state_retry",
      action: "launch_hra_and_retry",
      reason: "application_support_legacy",
    }]);
    expect(existsSync(legacyPaths.target)).toBe(false);

    const conflictHome = temporaryHome();
    const conflictPaths = applicationSupportPaths(conflictHome);
    mkdirSync(conflictPaths.target, { recursive: true, mode: 0o700 });
    mkdirSync(conflictPaths.legacy, { recursive: true, mode: 0o700 });
    const conflictCapture = capturedIO();
    expect(await runControlPlaneMaintenance({
      args: ["doctor"],
      environment: { HOME: conflictHome },
      io: conflictCapture.io,
    })).toBe(1);
    expect(conflictCapture.errors()).toEqual([{
      schemaVersion: 1,
      status: "error",
      code: "state_unhealthy",
      action: "review_state_recovery",
      reason: "application_support_roots",
    }]);
    const serialized = JSON.stringify(conflictCapture.errors());
    expect(serialized).not.toContain(conflictHome);
    expect(serialized).not.toContain(conflictPaths.target);
    expect(serialized).not.toContain(conflictPaths.legacy);
  });

  test("doctor reports an interrupted Application Support cutover as retryable", async () => {
    const home = temporaryHome();
    const paths = applicationSupportPaths(home);
    mkdirSync(paths.legacy, { recursive: true, mode: 0o700 });
    expect(() => prepareApplicationSupportMigration({
      environment: { HOME: home },
      isFileOpenByAnotherProcess: () => false,
      onCheckpoint: (point) => {
        if (point === "afterPreparedReceipt") throw new Error("fault");
      },
    })).toThrow("fault");

    const capture = capturedIO();
    expect(await runControlPlaneMaintenance({
      args: ["doctor"],
      environment: { HOME: home },
      io: capture.io,
    })).toBe(1);
    expect(capture.errors()).toEqual([{
      schemaVersion: 1,
      status: "error",
      code: "state_retry",
      action: "launch_hra_and_retry",
      reason: "application_support_interrupted",
    }]);
    expect(JSON.stringify(capture.errors())).not.toContain(home);
  });

  test("doctor reports an interrupted restore without exposing its state path", async () => {
    const home = temporaryHome();
    const capture = capturedIO();
    expect(await runControlPlaneMaintenance({
      args: ["doctor"],
      environment: { HOME: home },
      inspectReadiness: () => ({
        kind: "retry",
        reason: "interruptedRestore",
      }),
      io: capture.io,
    })).toBe(1);
    expect(capture.errors()).toEqual([{
      schemaVersion: 1,
      status: "error",
      code: "state_retry",
      action: "launch_hra_and_retry",
      reason: "interrupted_restore",
    }]);
    expect(JSON.stringify(capture.errors())).not.toContain(home);
  });

  test("rejects implicit or relative restore archives before reading a secret", async () => {
    const home = temporaryHome();
    createControlPlane(home);
    for (const args of [["restore"], ["restore", "backup.oprte"]]) {
      const capture = capturedIO(passphrase);
      expect(await runControlPlaneMaintenance({
        args,
        environment: { HOME: home },
        io: capture.io,
      })).toBe(1);
      expect(capture.errors()).toEqual([{
        schemaVersion: 1,
        status: "error",
        code: "invalid_arguments",
        action: "use_help",
      }]);
    }
  });
});

function createControlPlane(home: string, installationId?: string): string {
  const databasePath = defaultControlPlanePath({ HOME: home });
  const database = openControlPlane(databasePath, {
    releaseIdentity: hraReleaseIdentity,
    now: () => 1_786_000_000_000,
  });
  const key = loadOrCreateOperationReceiptKey(
    operationReceiptKeyPath(databasePath),
  );
  if (installationId !== undefined) {
    database.query(`
      INSERT INTO local_installations (installation_id, created_at, updated_at)
      VALUES (?1, 1, 1)
    `).run(installationId);
  }
  key.fill(0);
  database.close();
  return databasePath;
}

function replaceInstallation(home: string, installationId: string): void {
  const databasePath = defaultControlPlanePath({ HOME: home });
  const database = openControlPlane(databasePath, {
    releaseIdentity: hraReleaseIdentity,
    now: () => 1_786_000_000_001,
  });
  database.transaction(() => {
    database.exec("DELETE FROM local_installations");
    database.query(`
      INSERT INTO local_installations (installation_id, created_at, updated_at)
      VALUES (?1, 2, 2)
    `).run(installationId);
  })();
  database.close();
}

function readInstallationIds(home: string): readonly string[] {
  const database = new Database(defaultControlPlanePath({ HOME: home }), {
    readonly: true,
    strict: true,
  });
  try {
    return database.query<{ installation_id: string }, []>(`
      SELECT installation_id FROM local_installations ORDER BY installation_id
    `).all().map(({ installation_id }) => installation_id);
  } finally {
    database.close();
  }
}

function stringField(value: unknown, field: string): string {
  if (
    typeof value !== "object"
    || value === null
    || !(field in value)
    || typeof Reflect.get(value, field) !== "string"
  ) throw new Error(`Expected ${field}`);
  return Reflect.get(value, field) as string;
}

function capturedIO(stdin = ""): Readonly<{
  io: ControlPlaneMaintenanceIO;
  errors(): readonly unknown[];
  output(): readonly unknown[];
}> {
  const errors: string[] = [];
  const output: string[] = [];
  return {
    io: {
      stdinIsTTY: false,
      readStdin: () => Promise.resolve(stdin),
      writeError: (value) => errors.push(value),
      writeOutput: (value) => output.push(value),
    },
    errors: () => errors.map(parseLine),
    output: () => output.map(parseLine),
  };
}

function parseLine(value: string): unknown {
  return JSON.parse(value.trim()) as unknown;
}

function temporaryHome(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "oprte-maintenance-")));
  chmodSync(path, 0o700);
  temporaryDirectories.push(path);
  return path;
}
