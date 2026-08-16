import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "@hra-internal/schema";
import { applicationSupportRoot } from "./application-support";
import { assertBoundedControlPlaneIntegrity } from "./control-plane-integrity";
import { migrations, type Migration } from "./migrations";
import {
  parseAppReleaseIdentity,
  preflightControlPlaneRelease,
  publishControlPlaneReleaseFence,
  recordCompatibleControlPlaneRelease,
  validateSupportedMigrationPrefix,
  type AppReleaseIdentity,
} from "./release-compatibility";

const walCheckpointSchema = z.object({
  busy: z.number().int().nonnegative(),
  checkpointed: z.number().int().min(-1),
  log: z.number().int().min(-1),
}).passthrough();
const foreignKeysPragmaSchema = z.object({
  foreign_keys: z.literal(1),
}).passthrough();
const journalModePragmaSchema = z.object({
  journal_mode: z.literal("wal"),
}).passthrough();
const synchronousPragmaSchema = z.object({
  synchronous: z.literal(2),
}).passthrough();
const trustedSchemaPragmaSchema = z.object({
  trusted_schema: z.literal(0),
}).passthrough();

export {
  assertBoundedControlPlaneIntegrity,
  ControlPlaneIntegrityError,
} from "./control-plane-integrity";

function checksum(migration: Migration): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${String(migration.version)}\n${migration.name}\n${migration.sql}`);
  return hasher.digest("hex");
}

export function validateAppliedMigrationPrefix(database: Database): number {
  return validateSupportedMigrationPrefix(database);
}

export function controlPlanePath(homeDirectory: string): string {
  return controlPlanePathFromApplicationSupportRoot(applicationSupportRoot(homeDirectory));
}

export function controlPlanePathFromApplicationSupportRoot(root: string): string {
  if (!isAbsolute(root)) throw new Error("Application Support root must be absolute");
  return join(root, "control-plane.sqlite");
}

export function applyMigrations(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  const appliedVersion = validateSupportedMigrationPrefix(database);

  for (const migration of migrations) {
    const expectedChecksum = checksum(migration);
    if (migration.version <= appliedVersion) continue;
    database.transaction(() => {
      database.exec(migration.sql);
      database
        .query(
          "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?1, ?2, ?3, ?4)",
        )
        .run(migration.version, migration.name, expectedChecksum, new Date().toISOString());
    })();
  }
}

export function checkpointControlPlaneForApplicationSupportCutover(
  database: Database,
): void {
  const checkpointValue: unknown = database
    .query("PRAGMA wal_checkpoint(TRUNCATE)")
    .get();
  const checkpoint = walCheckpointSchema.parse(checkpointValue);
  const deleteJournal = checkpoint.log === -1 && checkpoint.checkpointed === -1;
  const completeWal = checkpoint.log >= 0
    && checkpoint.checkpointed >= 0
    && checkpoint.log === checkpoint.checkpointed;
  if (checkpoint.busy !== 0 || (!deleteJournal && !completeWal)) {
    throw new Error("Application Support cutover SQLite state could not be checkpointed");
  }

  assertBoundedControlPlaneIntegrity(database);
}

export interface OpenControlPlaneOptions {
  readonly releaseIdentity: AppReleaseIdentity;
  readonly now?: () => number;
}

export function openControlPlane(
  databasePath: string,
  options: OpenControlPlaneOptions,
): Database {
  if (!isAbsolute(databasePath)) throw new Error("Control-plane database path must be absolute");
  const releaseIdentity = parseAppReleaseIdentity(options.releaseIdentity);
  preflightControlPlaneRelease(databasePath, releaseIdentity);
  const parent = dirname(databasePath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  publishControlPlaneReleaseFence(
    databasePath,
    releaseIdentity,
    migrations.at(-1)?.version ?? 0,
    options.now?.() ?? Date.now(),
  );
  const database = new Database(databasePath, { create: true, strict: true });
  try {
    chmodSync(databasePath, 0o600);
    database.exec(
      [
        "PRAGMA foreign_keys = ON",
        "PRAGMA journal_mode = WAL",
        "PRAGMA synchronous = FULL",
        "PRAGMA trusted_schema = OFF",
      ].join("; "),
    );
    foreignKeysPragmaSchema.parse(
      database.query("PRAGMA foreign_keys").get(),
    );
    journalModePragmaSchema.parse(
      database.query("PRAGMA journal_mode").get(),
    );
    synchronousPragmaSchema.parse(
      database.query("PRAGMA synchronous").get(),
    );
    trustedSchemaPragmaSchema.parse(
      database.query("PRAGMA trusted_schema").get(),
    );
    assertBoundedControlPlaneIntegrity(database);
    applyMigrations(database);
    assertBoundedControlPlaneIntegrity(database);
    recordCompatibleControlPlaneRelease(
      database,
      releaseIdentity,
      options.now?.() ?? Date.now(),
    );
    checkpointControlPlaneForApplicationSupportCutover(database);
    return database;
  } catch (error: unknown) {
    database.close();
    throw error;
  }
}

export function defaultControlPlanePath(environment?: NodeJS.ProcessEnv): string {
  const home = environment === undefined
    ? userInfo().homedir
    : environment.HOME;
  if (home === undefined || home.length === 0) {
    throw new Error("An effective-user home is required for local state");
  }
  return controlPlanePath(home);
}
