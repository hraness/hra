import { Database } from "bun:sqlite";
import { chatAttachmentVaultRoot } from "./src/attachments/root";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { hraReleaseIdentity } from "./release-identity";
import {
  ControlPlaneBackupError,
  createEncryptedControlPlaneBackup,
  inspectEncryptedControlPlaneBackup,
  inspectControlPlaneAttachmentBackupReadiness,
  recoverPublishedCreateOnlyBackup,
  restoreEncryptedControlPlaneBackup,
  verifyEncryptedControlPlaneBackup,
} from "./src/state/control-plane-backup";
import {
  inspectApplicationSupportReadiness,
  type ApplicationSupportReadinessInspection,
} from "./src/state/application-support";
import {
  acquireControlPlaneLifetimeLock,
  ControlPlaneLifetimeLockError,
} from "./src/state/control-plane-lock";
import {
  assertBoundedControlPlaneIntegrity,
  ControlPlaneIntegrityError,
  defaultControlPlanePath,
} from "./src/state/database";
import {
  loadExistingOperationReceiptKey,
  operationReceiptKeyPath,
} from "./src/state/operation-receipt-key";
import {
  currentControlPlaneMigrationVersion,
  preflightControlPlaneRelease,
} from "./src/state/release-compatibility";

const maximumStdinBytes = 12_288;
const minimumPassphraseBytes = 16;
const maximumPassphraseBytes = 4_096;
const archiveDigestPattern = /^[a-f0-9]{64}$/u;

type MaintenanceCommand =
  | Readonly<{ kind: "backup"; archivePath: string }>
  | Readonly<{ kind: "doctor" }>
  | Readonly<{ kind: "inspect"; archivePath: string }>
  | Readonly<{ kind: "restore"; archivePath: string }>
  | Readonly<{ kind: "verify"; archivePath: string }>;

export interface ControlPlaneMaintenanceIO {
  readonly stdinIsTTY: boolean;
  readStdin(): Promise<string>;
  writeError(value: string): void;
  writeOutput(value: string): void;
}

export interface ControlPlaneMaintenanceOptions {
  readonly args: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly inspectReadiness?: (
    environment: NodeJS.ProcessEnv | undefined,
  ) => ApplicationSupportReadinessInspection;
  readonly io: ControlPlaneMaintenanceIO;
}

export class ControlPlaneMaintenanceError extends Error {
  readonly code:
    | "app_running"
    | "archive_exists"
    | "invalid_arguments"
    | "invalid_passphrase_input"
    | "invalid_restore_confirmation"
    | "state_missing"
    | "state_retry"
    | "state_unhealthy"
    | "tool_failure";
  readonly action:
    | "choose_new_archive_path"
    | "launch_hra_once"
    | "quit_hra_and_retry"
    | "review_state_recovery"
    | "launch_hra_and_retry"
    | "use_verified_archive_confirmation"
    | "use_help"
    | "use_piped_passphrase";
  readonly reason?:
    | "archive_authentication_failed"
    | "archive_incompatible"
    | "archive_invalid"
    | "archive_confirmation_failed"
    | "application_support_interrupted"
    | "interrupted_restore"
    | "application_support_legacy"
    | "application_support_locked"
    | "application_support_roots"
    | "application_support_unsafe"
    | "account_profile_capacity_quarantine"
    | "attachment_vault_recovery"
    | "backup_input_invalid"
    | "restore_interrupted"
    | "state_path_unsafe";

  constructor(
    code: ControlPlaneMaintenanceError["code"],
    action: ControlPlaneMaintenanceError["action"],
    reason?: ControlPlaneMaintenanceError["reason"],
  ) {
    super(code);
    this.name = "ControlPlaneMaintenanceError";
    this.code = code;
    this.action = action;
    if (reason !== undefined) this.reason = reason;
  }
}

export async function runControlPlaneMaintenance(
  options: ControlPlaneMaintenanceOptions,
): Promise<number> {
  try {
    const command = parseCommand(options.args);
    const inspectReadiness = options.inspectReadiness ?? inspectReadinessFromState;
    const result = command.kind === "doctor"
      ? doctor(options.environment, inspectReadiness)
      : command.kind === "inspect"
        ? inspect(command.archivePath)
        : command.kind === "verify"
          ? await verify(
              command.archivePath,
              options.io,
              options.environment,
              inspectReadiness,
            )
          : command.kind === "restore"
            ? await restore(
                requireRestorableControlPlanePath(
                  options.environment,
                  inspectReadiness,
                ),
                command.archivePath,
                options.io,
              )
            : await backup(
                requireReadyControlPlanePath(
                  options.environment,
                  inspectReadiness,
                ),
                command.archivePath,
                options.io,
              );
    options.io.writeOutput(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error: unknown) {
    const failure = normalizeFailure(error);
    options.io.writeError(`${JSON.stringify({
      schemaVersion: 1,
      status: "error",
      code: failure.code,
      action: failure.action,
      ...(failure.reason === undefined ? {} : { reason: failure.reason }),
    })}\n`);
    return 1;
  }
}

export async function readBoundedMaintenanceStdin(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      byteLength += next.value.byteLength;
      if (byteLength > maximumStdinBytes) {
        next.value.fill(0);
        try {
          await reader.cancel();
        } catch {
          // The bounded typed failure remains authoritative even if the source
          // cannot acknowledge cancellation.
        }
        throw new ControlPlaneMaintenanceError(
          "invalid_passphrase_input",
          "use_piped_passphrase",
        );
      }
      chunks.push(Uint8Array.from(next.value));
      next.value.fill(0);
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ControlPlaneMaintenanceError(
        "invalid_passphrase_input",
        "use_piped_passphrase",
      );
    } finally {
      bytes.fill(0);
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    reader.releaseLock();
  }
}

function parseCommand(args: readonly string[]): MaintenanceCommand {
  if (args.length === 1 && args[0] === "doctor") return { kind: "doctor" };
  if (
    args.length === 2
    && (
      args[0] === "backup"
      || args[0] === "inspect"
      || args[0] === "restore"
      || args[0] === "verify"
    )
    && isAbsolute(args[1] ?? "")
  ) {
    return { kind: args[0], archivePath: args[1] as string };
  }
  throw new ControlPlaneMaintenanceError("invalid_arguments", "use_help");
}

function doctor(
  environment: NodeJS.ProcessEnv | undefined,
  inspectReadiness: ReadinessInspector,
): Readonly<Record<string, unknown>> {
  const readiness = inspectReadiness(environment);
  if (readiness.kind === "fresh") {
    return {
      schemaVersion: 1,
      command: "doctor",
      status: "fresh",
      action: "launch_hra",
    };
  }
  assertApplicationSupportReady(readiness);
  const databasePath = defaultControlPlanePath(environment);
  if (!existsSync(databasePath)) {
    return {
      schemaVersion: 1,
      command: "doctor",
      status: "uninitialized",
      action: "launch_hra",
    };
  }

  return withExclusiveControlPlane(databasePath, () => {
    const preflight = preflightControlPlaneRelease(
      databasePath,
      hraReleaseIdentity,
    );
    if (
      preflight.kind !== "compatible"
      || preflight.migrationVersion !== currentControlPlaneMigrationVersion
    ) {
      throw new ControlPlaneMaintenanceError(
        "state_unhealthy",
        "review_state_recovery",
      );
    }
    let receiptKey: Uint8Array | null = null;
    let database: Database | null = null;
    try {
      database = new Database(databasePath, { readonly: true, strict: true });
      assertDatabaseHealth(database);
      const capacityRecovery: unknown = database.query(`
        SELECT COUNT(*) AS count FROM account_profile_capacity_quarantine
      `).get();
      if (
        typeof capacityRecovery !== "object" || capacityRecovery === null ||
        !("count" in capacityRecovery) ||
        typeof capacityRecovery.count !== "number" ||
        !Number.isSafeInteger(capacityRecovery.count) ||
        capacityRecovery.count < 0
      ) {
        throw new ControlPlaneMaintenanceError(
          "state_unhealthy",
          "review_state_recovery",
        );
      }
      if (capacityRecovery.count > 0) {
        throw new ControlPlaneMaintenanceError(
          "state_unhealthy",
          "review_state_recovery",
          "account_profile_capacity_quarantine",
        );
      }
      try {
        inspectControlPlaneAttachmentBackupReadiness({
          database,
          attachmentVaultRoot: chatAttachmentVaultRoot(databasePath),
        });
      } catch (error: unknown) {
        if (!(error instanceof ControlPlaneBackupError)) throw error;
        throw new ControlPlaneMaintenanceError(
          "state_unhealthy",
          "review_state_recovery",
          "attachment_vault_recovery",
        );
      }
      receiptKey = loadExistingOperationReceiptKey(
        operationReceiptKeyPath(databasePath),
      );
      return {
        schemaVersion: 1,
        command: "doctor",
        status: "ready",
        migrationVersion: preflight.migrationVersion,
      };
    } finally {
      receiptKey?.fill(0);
      database?.close();
    }
  });
}

function inspect(archivePath: string): Readonly<Record<string, unknown>> {
  const manifest = inspectEncryptedControlPlaneBackup(archivePath);
  return {
    schemaVersion: 1,
    command: "inspect",
    status: "headerReadable",
    createdAt: manifest.createdAt,
    sourceRelease: manifest.sourceRelease,
    sourceMigrationVersion: manifest.sourceMigrationVersion,
    payloadByteLength: manifest.payloadByteLength,
    attachmentVault: manifest.attachmentVault,
  };
}

async function verify(
  archivePath: string,
  io: ControlPlaneMaintenanceIO,
  environment: NodeJS.ProcessEnv | undefined,
  inspectReadiness: ReadinessInspector,
): Promise<Readonly<Record<string, unknown>>> {
  const readiness = inspectReadiness(environment);
  if (readiness.kind === "conflict" && readiness.reason === "locked") {
    throw new ControlPlaneMaintenanceError(
      "app_running",
      "quit_hra_and_retry",
    );
  }
  const passphrase = await readPassphrase(io);
  const action = (): Readonly<Record<string, unknown>> => {
    const verified = verifyEncryptedControlPlaneBackup({
      archivePath,
      passphrase,
      releaseIdentity: hraReleaseIdentity,
    });
    return {
      schemaVersion: 1,
      command: "verify",
      status: "verified",
      archiveSha256: verified.archiveSha256,
      peakResidentByteEstimate: verified.peakResidentByteEstimate,
      maximumBufferedPlaintextBytes: verified.maximumBufferedPlaintextBytes,
      createdAt: verified.manifest.createdAt,
      sourceRelease: verified.manifest.sourceRelease,
      sourceMigrationVersion: verified.manifest.sourceMigrationVersion,
      attachmentVault: verified.manifest.attachmentVault,
    };
  };
  // Verification is archive-only recovery evidence. When canonical local
  // state exists, the lifetime lock proves the app is stopped. Broken,
  // legacy, or absent local roots must not prevent authenticating a backup.
  return readiness.kind === "ready"
      || (readiness.kind === "retry" && readiness.reason === "interruptedRestore")
    ? withExclusiveControlPlane(defaultControlPlanePath(environment), action, false)
    : action();
}

async function restore(
  databasePath: string,
  archivePath: string,
  io: ControlPlaneMaintenanceIO,
): Promise<Readonly<Record<string, unknown>>> {
  const input = await readRestoreInput(io);
  return withExclusiveControlPlane(databasePath, () => {
    const restored = restoreEncryptedControlPlaneBackup({
      archivePath,
      databasePath,
      passphrase: input.passphrase,
      releaseIdentity: hraReleaseIdentity,
      confirmedArchiveSha256: input.confirmedArchiveSha256,
    });
    return {
      schemaVersion: 1,
      command: "restore",
      status: "restored",
      archiveSha256: restored.archiveSha256,
      sourceRelease: restored.manifest.sourceRelease,
      restoredMigrationVersion: restored.restoredMigrationVersion,
      attachmentVault: restored.manifest.attachmentVault,
    };
  });
}

async function backup(
  databasePath: string,
  archivePath: string,
  io: ControlPlaneMaintenanceIO,
): Promise<Readonly<Record<string, unknown>>> {
  if (existsSync(archivePath)) {
    return withExclusiveControlPlane(databasePath, () => {
      recoverPublishedCreateOnlyBackup(archivePath);
      throw new ControlPlaneMaintenanceError(
        "archive_exists",
        "choose_new_archive_path",
      );
    });
  }
  if (!existsSync(databasePath)) {
    throw new ControlPlaneMaintenanceError("state_missing", "launch_hra_once");
  }

  const passphrase = await readConfirmedPassphrase(io);
  return withExclusiveControlPlane(databasePath, () => {
    const preflight = preflightControlPlaneRelease(
      databasePath,
      hraReleaseIdentity,
    );
    if (
      preflight.kind !== "compatible"
      || preflight.migrationVersion !== currentControlPlaneMigrationVersion
    ) {
      throw new ControlPlaneMaintenanceError(
        "state_unhealthy",
        "review_state_recovery",
      );
    }
    let database: Database | null = null;
    let receiptKey: Uint8Array | null = null;
    try {
      database = new Database(databasePath, { strict: true });
      database.exec(
        "PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; PRAGMA trusted_schema = OFF",
      );
      assertDatabaseHealth(database);
      receiptKey = loadExistingOperationReceiptKey(
        operationReceiptKeyPath(databasePath),
      );
      const created = createEncryptedControlPlaneBackup({
        database,
        destinationPath: archivePath,
        attachmentVaultRoot: chatAttachmentVaultRoot(databasePath),
        operationReceiptKey: receiptKey,
        passphrase,
        releaseIdentity: hraReleaseIdentity,
      });
      return {
        schemaVersion: 1,
        command: "backup",
        status: "created",
        archiveByteLength: created.archiveByteLength,
        archiveSha256: created.archiveSha256,
        peakResidentByteEstimate: created.peakResidentByteEstimate,
        maximumBufferedPlaintextBytes: created.maximumBufferedPlaintextBytes,
        createdAt: created.manifest.createdAt,
        sourceMigrationVersion: created.manifest.sourceMigrationVersion,
        attachmentVault: created.manifest.attachmentVault,
      };
    } finally {
      receiptKey?.fill(0);
      database?.close();
    }
  });
}

function withExclusiveControlPlane<T>(
  databasePath: string,
  action: () => T,
  bindControlPlane = true,
): T {
  let lifetimeLock;
  try {
    lifetimeLock = acquireControlPlaneLifetimeLock(databasePath);
  } catch (error: unknown) {
    if (
      error instanceof ControlPlaneLifetimeLockError
      && error.code === "already_running"
    ) {
      throw new ControlPlaneMaintenanceError(
        "app_running",
        "quit_hra_and_retry",
      );
    }
    throw error;
  }
  try {
    const result = action();
    if (bindControlPlane) lifetimeLock.bindControlPlane();
    return result;
  } finally {
    lifetimeLock.release();
  }
}

async function readConfirmedPassphrase(
  io: ControlPlaneMaintenanceIO,
): Promise<string> {
  const lines = await readStdinLines(io);
  const passphrase = lines[0] ?? "";
  if (
    lines.length !== 2
    || lines[1] !== passphrase
    || !isValidPassphrase(passphrase)
  ) {
    throw new ControlPlaneMaintenanceError(
      "invalid_passphrase_input",
      "use_piped_passphrase",
    );
  }
  return passphrase;
}

async function readPassphrase(io: ControlPlaneMaintenanceIO): Promise<string> {
  const lines = await readStdinLines(io);
  const passphrase = lines[0] ?? "";
  if (
    lines.length !== 1
    || !isValidPassphrase(passphrase)
  ) {
    throw new ControlPlaneMaintenanceError(
      "invalid_passphrase_input",
      "use_piped_passphrase",
    );
  }
  return passphrase;
}

async function readRestoreInput(io: ControlPlaneMaintenanceIO): Promise<Readonly<{
  passphrase: string;
  confirmedArchiveSha256: string;
}>> {
  const lines = await readStdinLines(io);
  const passphrase = lines[0] ?? "";
  const confirmation = lines[1] ?? "";
  const prefix = "RESTORE ";
  const confirmedArchiveSha256 = confirmation.startsWith(prefix)
    ? confirmation.slice(prefix.length)
    : "";
  if (
    lines.length !== 2
    || !isValidPassphrase(passphrase)
    || !archiveDigestPattern.test(confirmedArchiveSha256)
  ) {
    throw new ControlPlaneMaintenanceError(
      "invalid_restore_confirmation",
      "use_verified_archive_confirmation",
      "archive_confirmation_failed",
    );
  }
  return { passphrase, confirmedArchiveSha256 };
}

async function readStdinLines(
  io: ControlPlaneMaintenanceIO,
): Promise<readonly string[]> {
  if (io.stdinIsTTY) {
    throw new ControlPlaneMaintenanceError(
      "invalid_passphrase_input",
      "use_piped_passphrase",
    );
  }
  let value: string;
  try {
    value = await io.readStdin();
  } catch (error: unknown) {
    if (error instanceof ControlPlaneMaintenanceError) throw error;
    throw new ControlPlaneMaintenanceError(
      "invalid_passphrase_input",
      "use_piped_passphrase",
    );
  }
  if (Buffer.byteLength(value, "utf8") > maximumStdinBytes) {
    throw new ControlPlaneMaintenanceError(
      "invalid_passphrase_input",
      "use_piped_passphrase",
    );
  }
  const normalized = value.endsWith("\n") ? value.slice(0, -1) : value;
  return normalized.split("\n").map((line) =>
    line.endsWith("\r") ? line.slice(0, -1) : line
  );
}

function isValidPassphrase(value: string): boolean {
  const byteLength = Buffer.byteLength(value, "utf8");
  return byteLength >= minimumPassphraseBytes
    && byteLength <= maximumPassphraseBytes;
}

function requireReadyControlPlanePath(
  environment: NodeJS.ProcessEnv | undefined,
  inspectReadiness: ReadinessInspector,
): string {
  const readiness = inspectReadiness(environment);
  if (readiness.kind === "fresh") {
    throw new ControlPlaneMaintenanceError("state_missing", "launch_hra_once");
  }
  assertApplicationSupportReady(readiness);
  return defaultControlPlanePath(environment);
}

function requireRestorableControlPlanePath(
  environment: NodeJS.ProcessEnv | undefined,
  inspectReadiness: ReadinessInspector,
): string {
  const readiness = inspectReadiness(environment);
  if (
    readiness.kind === "ready"
    || (readiness.kind === "retry" && readiness.reason === "interruptedRestore")
  ) return defaultControlPlanePath(environment);
  assertApplicationSupportReady(readiness);
  return defaultControlPlanePath(environment);
}

type ReadinessInspector = (
  environment: NodeJS.ProcessEnv | undefined,
) => ApplicationSupportReadinessInspection;

function inspectReadinessFromState(
  environment: NodeJS.ProcessEnv | undefined,
): ApplicationSupportReadinessInspection {
  return inspectApplicationSupportReadiness(
    environment === undefined ? {} : { environment },
  );
}

function assertApplicationSupportReady(
  readiness: ReturnType<typeof inspectApplicationSupportReadiness>,
): asserts readiness is Readonly<{ kind: "ready" }> {
  if (readiness.kind === "ready") return;
  if (readiness.kind === "retry") {
    throw new ControlPlaneMaintenanceError(
      "state_retry",
      "launch_hra_and_retry",
      readiness.reason === "legacy"
        ? "application_support_legacy"
        : readiness.reason === "interrupted"
          ? "application_support_interrupted"
          : "interrupted_restore",
    );
  }
  if (readiness.kind === "conflict" && readiness.reason === "locked") {
    throw new ControlPlaneMaintenanceError(
      "state_retry",
      "quit_hra_and_retry",
      "application_support_locked",
    );
  }
  if (readiness.kind === "conflict") {
    throw new ControlPlaneMaintenanceError(
      "state_unhealthy",
      "review_state_recovery",
      readiness.reason === "roots"
        ? "application_support_roots"
        : "application_support_unsafe",
    );
  }
  throw new ControlPlaneMaintenanceError("state_missing", "launch_hra_once");
}

function assertDatabaseHealth(database: Database): void {
  try {
    assertBoundedControlPlaneIntegrity(database);
  } catch (error: unknown) {
    if (!(error instanceof ControlPlaneIntegrityError)) throw error;
    throw new ControlPlaneMaintenanceError(
      "state_unhealthy",
      "review_state_recovery",
    );
  }
}

function normalizeFailure(error: unknown): ControlPlaneMaintenanceError {
  if (error instanceof ControlPlaneMaintenanceError) return error;
  if (error instanceof ControlPlaneBackupError) {
    const reason = error.code === "authentication_failed"
      ? "archive_authentication_failed"
      : error.code === "confirmation_failed"
        ? "archive_confirmation_failed"
      : error.code === "incompatible_backup"
        ? "archive_incompatible"
        : error.code === "invalid_archive"
          ? "archive_invalid"
          : error.code === "unsafe_path"
            ? "state_path_unsafe"
            : error.code === "restore_interrupted"
              ? "restore_interrupted"
              : "backup_input_invalid";
    return new ControlPlaneMaintenanceError(
      error.code === "unsafe_path"
        ? "state_unhealthy"
        : error.code === "confirmation_failed"
          ? "invalid_restore_confirmation"
          : "tool_failure",
      error.code === "unsafe_path"
        ? "choose_new_archive_path"
        : error.code === "confirmation_failed"
          ? "use_verified_archive_confirmation"
          : "review_state_recovery",
      reason,
    );
  }
  if (
    error instanceof ControlPlaneLifetimeLockError
    && error.code === "already_running"
  ) {
    return new ControlPlaneMaintenanceError(
      "app_running",
      "quit_hra_and_retry",
    );
  }
  if (
    error instanceof ControlPlaneLifetimeLockError
    && (error.code === "invalid_path" || error.code === "lock_failed")
  ) {
    return new ControlPlaneMaintenanceError(
      "state_unhealthy",
      "review_state_recovery",
      "state_path_unsafe",
    );
  }
  return new ControlPlaneMaintenanceError(
    "tool_failure",
    "review_state_recovery",
  );
}

if (import.meta.main) {
  const exitCode = await runControlPlaneMaintenance({
    args: process.argv.slice(2),
    io: {
      stdinIsTTY: Boolean(process.stdin.isTTY),
      readStdin: async () => await readBoundedMaintenanceStdin(Bun.stdin.stream()),
      writeError: (value) => process.stderr.write(value),
      writeOutput: (value) => process.stdout.write(value),
    },
  });
  process.exitCode = exitCode;
}
