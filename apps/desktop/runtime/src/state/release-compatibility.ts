import { Database, constants as sqliteConstants } from "bun:sqlite";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "@hra-internal/schema";
import { migrations, type Migration } from "./migrations";

const semanticVersionPattern =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;

const appReleaseIdentitySchema = z.object({
  version: z.string().min(5).max(64).regex(semanticVersionPattern),
  build: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

const appliedMigrationSchema = z.object({
  version: z.number().int().positive(),
  name: z.string().min(1),
  checksum: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

const releaseStateRowSchema = z.object({
  format_version: z.literal(1),
  last_writer_version: z.string(),
  last_writer_build: z.number(),
  minimum_reader_version: z.string(),
  minimum_reader_build: z.number(),
  migration_version: z.number().int().positive(),
  updated_at: z.number().int().nonnegative(),
}).strict();

const sqliteObjectSchema = z.object({
  type: z.string(),
}).strict();
const releaseFenceSchema = z.object({
  version: z.literal(1),
  kind: z.literal("hraness-kitchen-control-plane-release-fence"),
  minimumReaderVersion: z.string(),
  minimumReaderBuild: z.number(),
  intendedMigrationVersion: z.number().int().positive(),
  updatedAt: z.number().int().nonnegative(),
}).strict();

const releaseFenceFileName = ".control-plane-release-fence-v1.json";
const releaseFenceCandidateFileName = ".control-plane-release-fence-v1.json.tmp";
const maximumReleaseFenceBytes = 1_024;

export interface AppReleaseIdentity {
  readonly version: string;
  readonly build: number;
}

export interface AppReleaseCompatibilityState {
  readonly formatVersion: 1;
  readonly lastWriter: AppReleaseIdentity;
  readonly minimumReader: AppReleaseIdentity;
  readonly migrationVersion: number;
  readonly updatedAt: number;
}

export interface ControlPlaneReleaseFence {
  readonly version: 1;
  readonly kind: "hraness-kitchen-control-plane-release-fence";
  readonly minimumReader: AppReleaseIdentity;
  readonly intendedMigrationVersion: number;
  readonly updatedAt: number;
}

export type ControlPlaneReleasePreflight =
  | Readonly<{ kind: "missing"; migrationVersion: 0; state: null }>
  | Readonly<{
      kind: "legacy";
      migrationVersion: number;
      state: null;
    }>
  | Readonly<{
      kind: "compatible";
      migrationVersion: number;
      state: AppReleaseCompatibilityState | null;
    }>;

export class ControlPlaneReleaseCompatibilityError extends Error {
  readonly code:
    | "incompatible_reader"
    | "invalid_release_identity"
    | "invalid_release_state"
    | "newer_migration"
    | "unsafe_database";

  constructor(
    code: ControlPlaneReleaseCompatibilityError["code"],
    message: string,
  ) {
    super(message);
    this.name = "ControlPlaneReleaseCompatibilityError";
    this.code = code;
  }
}

export const defaultAppReleaseIdentity: AppReleaseIdentity = Object.freeze({
  version: "0.1.11",
  build: 12,
});

export const currentControlPlaneMigrationVersion =
  migrations.at(-1)?.version ?? 0;

export function parseAppReleaseIdentity(value: unknown): AppReleaseIdentity {
  try {
    return appReleaseIdentitySchema.parse(value);
  } catch {
    throw new ControlPlaneReleaseCompatibilityError(
      "invalid_release_identity",
      "The application release identity is invalid",
    );
  }
}

export function compareAppReleaseIdentity(
  leftInput: unknown,
  rightInput: unknown,
): -1 | 0 | 1 {
  const left = parseAppReleaseIdentity(leftInput);
  const right = parseAppReleaseIdentity(rightInput);
  const leftParts = left.version.split(".").map((part) => BigInt(part));
  const rightParts = right.version.split(".").map((part) => BigInt(part));
  for (let index = 0; index < 3; index += 1) {
    const leftPart = leftParts[index] ?? 0n;
    const rightPart = rightParts[index] ?? 0n;
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  if (left.build < right.build) return -1;
  if (left.build > right.build) return 1;
  return 0;
}

export function validateSupportedMigrationPrefix(database: Database): number {
  const migrationObjectValue: unknown = database
    .query("SELECT type FROM sqlite_schema WHERE name = 'schema_migrations'")
    .get();
  if (migrationObjectValue === null) return 0;
  const migrationObject = parseSqliteObject(migrationObjectValue);
  if (migrationObject.type !== "table") {
    throw new ControlPlaneReleaseCompatibilityError(
      "invalid_release_state",
      "SQLite migration history object is not a table",
    );
  }

  const appliedValues: unknown[] = database
    .query(`
      SELECT version, name, checksum
      FROM schema_migrations
      ORDER BY version
      LIMIT ?1
    `)
    .all(migrations.length + 2);
  const applied = parseAppliedMigrations(appliedValues);

  for (const [index, migration] of applied.entries()) {
    const expected = migrations[index];
    if (expected === undefined) {
      throw new ControlPlaneReleaseCompatibilityError(
        "newer_migration",
        "The control-plane database was written by a newer application migration",
      );
    }
    if (migration.version !== expected.version) {
      throw new ControlPlaneReleaseCompatibilityError(
        migration.version > currentControlPlaneMigrationVersion
          ? "newer_migration"
          : "invalid_release_state",
        "SQLite migration history is not a supported contiguous prefix",
      );
    }
    if (
      migration.name !== expected.name
      || migration.checksum !== migrationChecksum(expected)
    ) {
      throw new ControlPlaneReleaseCompatibilityError(
        "invalid_release_state",
        `SQLite migration ${String(migration.version)} checksum drift`,
      );
    }
  }
  return applied.at(-1)?.version ?? 0;
}

export function inspectControlPlaneReleaseState(
  database: Database,
): AppReleaseCompatibilityState | null {
  const objectValue: unknown = database
    .query("SELECT type FROM sqlite_schema WHERE name = 'app_release_state'")
    .get();
  if (objectValue === null) return null;
  const object = parseSqliteObject(objectValue);
  if (object.type !== "table") {
    throw new ControlPlaneReleaseCompatibilityError(
      "invalid_release_state",
      "The application release state object is not a table",
    );
  }

  const rows: unknown[] = database.query(`
    SELECT
      format_version,
      last_writer_version,
      last_writer_build,
      minimum_reader_version,
      minimum_reader_build,
      migration_version,
      updated_at
    FROM app_release_state
    LIMIT 2
  `).all();
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new ControlPlaneReleaseCompatibilityError(
      "invalid_release_state",
      "The application release state must contain at most one row",
    );
  }

  try {
    const row = releaseStateRowSchema.parse(rows[0]);
    const lastWriter = parseAppReleaseIdentity({
      version: row.last_writer_version,
      build: row.last_writer_build,
    });
    const minimumReader = parseAppReleaseIdentity({
      version: row.minimum_reader_version,
      build: row.minimum_reader_build,
    });
    if (compareAppReleaseIdentity(minimumReader, lastWriter) < 0) {
      throw new ControlPlaneReleaseCompatibilityError(
        "invalid_release_state",
        "The minimum reader cannot be older than the recorded writer",
      );
    }
    return {
      formatVersion: 1,
      lastWriter,
      minimumReader,
      migrationVersion: row.migration_version,
      updatedAt: row.updated_at,
    };
  } catch (error: unknown) {
    if (error instanceof ControlPlaneReleaseCompatibilityError) throw error;
    throw new ControlPlaneReleaseCompatibilityError(
      "invalid_release_state",
      "The application release state row is invalid",
    );
  }
}

export function assertCompatibleControlPlaneDatabase(
  database: Database,
  releaseIdentityInput: unknown,
): Readonly<{
  migrationVersion: number;
  state: AppReleaseCompatibilityState | null;
}> {
  const releaseIdentity = parseAppReleaseIdentity(releaseIdentityInput);
  const migrationVersion = validateSupportedMigrationPrefix(database);
  if (migrationVersion > currentControlPlaneMigrationVersion) {
    throw new ControlPlaneReleaseCompatibilityError(
      "newer_migration",
      "The control-plane database requires a newer application migration",
    );
  }

  const state = inspectControlPlaneReleaseState(database);
  if (
    state !== null
    && compareAppReleaseIdentity(releaseIdentity, state.minimumReader) < 0
  ) {
    throw new ControlPlaneReleaseCompatibilityError(
      "incompatible_reader",
      "The control-plane database requires a newer HRA release",
    );
  }
  if (
    state !== null
    && (
      state.migrationVersion > currentControlPlaneMigrationVersion
      || state.migrationVersion > migrationVersion
    )
  ) {
    throw new ControlPlaneReleaseCompatibilityError(
      state.migrationVersion > currentControlPlaneMigrationVersion
        ? "newer_migration"
        : "invalid_release_state",
      "The recorded application release migration is incompatible",
    );
  }
  return { migrationVersion, state };
}

export function preflightControlPlaneRelease(
  databasePath: string,
  releaseIdentityInput: unknown,
): ControlPlaneReleasePreflight {
  if (!isAbsolute(databasePath)) {
    throw new ControlPlaneReleaseCompatibilityError(
      "unsafe_database",
      "The control-plane database path must be absolute",
    );
  }
  const releaseIdentity = parseAppReleaseIdentity(releaseIdentityInput);
  assertCompatibleReleaseFence(databasePath, releaseIdentity);

  let metadata: Stats;
  try {
    metadata = lstatSync(databasePath);
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) {
      return { kind: "missing", migrationVersion: 0, state: null };
    }
    throw error;
  }
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.nlink !== 1
  ) {
    throw new ControlPlaneReleaseCompatibilityError(
      "unsafe_database",
      "The control-plane database must be one owned regular file",
    );
  }
  const currentUser = process.getuid?.();
  if (currentUser !== undefined && metadata.uid !== currentUser) {
    throw new ControlPlaneReleaseCompatibilityError(
      "unsafe_database",
      "The control-plane database must be owned by the current user",
    );
  }
  assertReadOnlySidecarsAreSafe(databasePath, currentUser);

  let database: Database | null = null;
  try {
    const immutableUrl = pathToFileURL(databasePath);
    immutableUrl.searchParams.set("immutable", "1");
    immutableUrl.searchParams.set("mode", "ro");
    // Bun's options object does not enable URI parsing in bundled SQLite.
    database = new Database(
      immutableUrl.href,
      sqliteConstants.SQLITE_OPEN_READONLY | sqliteConstants.SQLITE_OPEN_URI,
    );
    const result = assertCompatibleControlPlaneDatabase(database, releaseIdentity);
    if (result.migrationVersion === 0) {
      return { kind: "legacy", migrationVersion: 0, state: null };
    }
    if (
      result.migrationVersion < currentControlPlaneMigrationVersion
      && result.state === null
    ) {
      return {
        kind: "legacy",
        migrationVersion: result.migrationVersion,
        state: null,
      };
    }
    return {
      kind: "compatible",
      migrationVersion: result.migrationVersion,
      state: result.state,
    };
  } catch (error: unknown) {
    if (error instanceof ControlPlaneReleaseCompatibilityError) throw error;
    throw new ControlPlaneReleaseCompatibilityError(
      "invalid_release_state",
      "The control-plane database could not be checked without mutation",
    );
  } finally {
    database?.close();
  }
}

export function controlPlaneReleaseFencePath(databasePath: string): string {
  if (!isAbsolute(databasePath) || basename(databasePath) !== "control-plane.sqlite") {
    throw new ControlPlaneReleaseCompatibilityError(
      "unsafe_database",
      "The release fence requires the canonical control-plane database path",
    );
  }
  return join(dirname(databasePath), releaseFenceFileName);
}

export function inspectControlPlaneReleaseFence(
  databasePath: string,
): ControlPlaneReleaseFence | null {
  const fencePath = controlPlaneReleaseFencePath(databasePath);
  let descriptor: number;
  try {
    descriptor = openSync(
      fencePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) return null;
    throw new ControlPlaneReleaseCompatibilityError(
      "unsafe_database",
      "The control-plane release fence cannot be read safely",
    );
  }
  try {
    const metadata = fstatSync(descriptor);
    const currentUser = process.getuid?.();
    if (
      !metadata.isFile()
      || metadata.nlink !== 1
      || metadata.size <= 0
      || metadata.size > maximumReleaseFenceBytes
      || (currentUser !== undefined && metadata.uid !== currentUser)
    ) {
      throw new ControlPlaneReleaseCompatibilityError(
        "unsafe_database",
        "The control-plane release fence must be one bounded owned file",
      );
    }
    const bytes = readFileSync(descriptor);
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    const parsed = releaseFenceSchema.parse(value);
    return {
      version: 1,
      kind: "hraness-kitchen-control-plane-release-fence",
      minimumReader: parseAppReleaseIdentity({
        version: parsed.minimumReaderVersion,
        build: parsed.minimumReaderBuild,
      }),
      intendedMigrationVersion: parsed.intendedMigrationVersion,
      updatedAt: parsed.updatedAt,
    };
  } catch (error: unknown) {
    if (error instanceof ControlPlaneReleaseCompatibilityError) throw error;
    throw new ControlPlaneReleaseCompatibilityError(
      "invalid_release_state",
      "The control-plane release fence is invalid",
    );
  } finally {
    closeSync(descriptor);
  }
}

export function assertCompatibleReleaseFence(
  databasePath: string,
  releaseIdentityInput: unknown,
): ControlPlaneReleaseFence | null {
  const releaseIdentity = parseAppReleaseIdentity(releaseIdentityInput);
  const fence = inspectControlPlaneReleaseFence(databasePath);
  if (fence === null) return null;
  if (compareAppReleaseIdentity(releaseIdentity, fence.minimumReader) < 0) {
    throw new ControlPlaneReleaseCompatibilityError(
      "incompatible_reader",
      "The control-plane release fence requires a newer HRA release",
    );
  }
  if (fence.intendedMigrationVersion > currentControlPlaneMigrationVersion) {
    throw new ControlPlaneReleaseCompatibilityError(
      "newer_migration",
      "The control-plane release fence requires a newer application migration",
    );
  }
  return fence;
}

export function publishControlPlaneReleaseFence(
  databasePath: string,
  releaseIdentityInput: unknown,
  intendedMigrationVersion: number = currentControlPlaneMigrationVersion,
  updatedAt: number = Date.now(),
): ControlPlaneReleaseFence {
  const releaseIdentity = parseAppReleaseIdentity(releaseIdentityInput);
  if (
    !Number.isSafeInteger(intendedMigrationVersion)
    || intendedMigrationVersion <= 0
    || !Number.isSafeInteger(updatedAt)
    || updatedAt < 0
  ) {
    throw new ControlPlaneReleaseCompatibilityError(
      "invalid_release_state",
      "The control-plane release fence input is invalid",
    );
  }
  const fencePath = controlPlaneReleaseFencePath(databasePath);
  const parent = dirname(fencePath);
  const parentMetadata = lstatSync(parent);
  const currentUser = process.getuid?.();
  if (
    parentMetadata.isSymbolicLink()
    || !parentMetadata.isDirectory()
    || (currentUser !== undefined && parentMetadata.uid !== currentUser)
  ) {
    throw new ControlPlaneReleaseCompatibilityError(
      "unsafe_database",
      "The control-plane release fence parent must be one owned directory",
    );
  }

  const previous = inspectControlPlaneReleaseFence(databasePath);
  if (
    previous !== null
    && compareAppReleaseIdentity(releaseIdentity, previous.minimumReader) < 0
  ) {
    throw new ControlPlaneReleaseCompatibilityError(
      "incompatible_reader",
      "The control-plane release fence cannot move backwards",
    );
  }
  if (
    previous !== null
    && intendedMigrationVersion < previous.intendedMigrationVersion
  ) {
    throw new ControlPlaneReleaseCompatibilityError(
      "newer_migration",
      "The control-plane migration fence cannot move backwards",
    );
  }
  const minimumReader = previous !== null
    && compareAppReleaseIdentity(previous.minimumReader, releaseIdentity) > 0
    ? previous.minimumReader
    : releaseIdentity;
  const fence: ControlPlaneReleaseFence = {
    version: 1,
    kind: "hraness-kitchen-control-plane-release-fence",
    minimumReader,
    intendedMigrationVersion: Math.max(
      previous?.intendedMigrationVersion ?? 0,
      intendedMigrationVersion,
    ),
    updatedAt,
  };
  const bytes = Buffer.from(JSON.stringify({
    version: fence.version,
    kind: fence.kind,
    minimumReaderVersion: fence.minimumReader.version,
    minimumReaderBuild: fence.minimumReader.build,
    intendedMigrationVersion: fence.intendedMigrationVersion,
    updatedAt: fence.updatedAt,
  }), "utf8");
  if (bytes.byteLength > maximumReleaseFenceBytes) {
    throw new ControlPlaneReleaseCompatibilityError(
      "invalid_release_state",
      "The control-plane release fence is too large",
    );
  }

  const candidatePath = join(parent, releaseFenceCandidateFileName);
  removeSafeFenceCandidate(candidatePath);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      candidatePath,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, bytes);
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(candidatePath, fencePath);
    syncDirectory(parent);
    return fence;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    removeSafeFenceCandidate(candidatePath);
  }
}

export function recordCompatibleControlPlaneRelease(
  database: Database,
  releaseIdentityInput: unknown,
  updatedAt: number = Date.now(),
): AppReleaseCompatibilityState {
  const releaseIdentity = parseAppReleaseIdentity(releaseIdentityInput);
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new ControlPlaneReleaseCompatibilityError(
      "invalid_release_state",
      "The release-state timestamp is invalid",
    );
  }
  const checked = assertCompatibleControlPlaneDatabase(database, releaseIdentity);
  if (checked.migrationVersion !== currentControlPlaneMigrationVersion) {
    throw new ControlPlaneReleaseCompatibilityError(
      "invalid_release_state",
      "The release identity may only be recorded after all migrations apply",
    );
  }
  const previousMinimum = checked.state?.minimumReader;
  const minimumReader = previousMinimum !== undefined
    && compareAppReleaseIdentity(previousMinimum, releaseIdentity) > 0
    ? previousMinimum
    : releaseIdentity;

  database.transaction(() => {
    database.query(`
      INSERT INTO app_release_state (
        singleton,
        format_version,
        last_writer_version,
        last_writer_build,
        minimum_reader_version,
        minimum_reader_build,
        migration_version,
        updated_at
      ) VALUES (1, 1, ?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT (singleton) DO UPDATE SET
        format_version = excluded.format_version,
        last_writer_version = excluded.last_writer_version,
        last_writer_build = excluded.last_writer_build,
        minimum_reader_version = excluded.minimum_reader_version,
        minimum_reader_build = excluded.minimum_reader_build,
        migration_version = excluded.migration_version,
        updated_at = excluded.updated_at
    `).run(
      releaseIdentity.version,
      releaseIdentity.build,
      minimumReader.version,
      minimumReader.build,
      checked.migrationVersion,
      updatedAt,
    );
  })();

  return {
    formatVersion: 1,
    lastWriter: releaseIdentity,
    minimumReader,
    migrationVersion: checked.migrationVersion,
    updatedAt,
  };
}

function parseAppliedMigrations(values: readonly unknown[]): readonly {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}[] {
  try {
    return z.array(appliedMigrationSchema).max(migrations.length + 1).parse(values);
  } catch {
    throw new ControlPlaneReleaseCompatibilityError(
      "invalid_release_state",
      "SQLite migration history contains invalid rows",
    );
  }
}

function parseSqliteObject(value: unknown): z.infer<typeof sqliteObjectSchema> {
  try {
    return sqliteObjectSchema.parse(value);
  } catch {
    throw new ControlPlaneReleaseCompatibilityError(
      "invalid_release_state",
      "SQLite contains an invalid schema object",
    );
  }
}

function migrationChecksum(migration: Migration): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${String(migration.version)}\n${migration.name}\n${migration.sql}`);
  return hasher.digest("hex");
}

function assertReadOnlySidecarsAreSafe(
  databasePath: string,
  currentUser: number | undefined,
): void {
  const wal = readOptionalMetadata(`${databasePath}-wal`);
  const sharedMemory = readOptionalMetadata(`${databasePath}-shm`);
  for (const [label, metadata] of [
    ["write-ahead log", wal],
    ["shared-memory index", sharedMemory],
  ] as const) {
    if (metadata === null) continue;
    if (
      metadata.isSymbolicLink()
      || !metadata.isFile()
      || metadata.nlink !== 1
      || (currentUser !== undefined && metadata.uid !== currentUser)
    ) {
      throw new ControlPlaneReleaseCompatibilityError(
        "unsafe_database",
        `The control-plane ${label} must be one owned regular file`,
      );
    }
  }
}

function readOptionalMetadata(
  path: string,
): Stats | null {
  try {
    return lstatSync(path);
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
}

function removeSafeFenceCandidate(path: string): void {
  const metadata = readOptionalMetadata(path);
  if (metadata === null) return;
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    throw new ControlPlaneReleaseCompatibilityError(
      "unsafe_database",
      "The control-plane release-fence staging file is unsafe",
    );
  }
  unlinkSync(path);
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function hasCode(error: unknown, expected: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === expected;
}
