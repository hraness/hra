import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyMigrations,
  openControlPlane,
} from "../src/state/database";
import {
  ControlPlaneReleaseCompatibilityError,
  currentControlPlaneMigrationVersion,
  inspectControlPlaneReleaseState,
  preflightControlPlaneRelease,
  publishControlPlaneReleaseFence,
  recordCompatibleControlPlaneRelease,
  type AppReleaseIdentity,
} from "../src/state/release-compatibility";

const release100: AppReleaseIdentity = { version: "1.0.0", build: 100 };
const release101: AppReleaseIdentity = { version: "1.0.0", build: 101 };
const release110: AppReleaseIdentity = { version: "1.1.0", build: 1 };
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("control-plane release compatibility", () => {
  test("records the checked writer only after migration and rejects version/build downgrades", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      applyMigrations(database);
      expect(recordCompatibleControlPlaneRelease(database, release100, 123)).toEqual({
        formatVersion: 1,
        lastWriter: release100,
        minimumReader: release100,
        migrationVersion: currentControlPlaneMigrationVersion,
        updatedAt: 123,
      });
      expect(() =>
        recordCompatibleControlPlaneRelease(
          database,
          { version: "1.0.0", build: 99 },
          124,
        ),
      ).toThrow(ControlPlaneReleaseCompatibilityError);
      expect(() =>
        recordCompatibleControlPlaneRelease(
          database,
          { version: "0.9.9", build: 999_999 },
          124,
        ),
      ).toThrow("requires a newer HRA release");
      expect(recordCompatibleControlPlaneRelease(database, release101, 125))
        .toMatchObject({
          lastWriter: release101,
          minimumReader: release101,
        });
      expect(recordCompatibleControlPlaneRelease(database, release110, 126))
        .toMatchObject({
          lastWriter: release110,
          minimumReader: release110,
        });
    } finally {
      database.close();
    }
  });

  test("rejects an inconsistent writer/minimum-reader row and a future migration", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      applyMigrations(database);
      recordCompatibleControlPlaneRelease(database, release100, 1);
      database.query(`
        UPDATE app_release_state
        SET
          last_writer_version = '1.1.0',
          last_writer_build = 7,
          minimum_reader_version = '1.0.0',
          minimum_reader_build = 100
        WHERE singleton = 1
      `).run();
      expect(() => inspectControlPlaneReleaseState(database))
        .toThrow("minimum reader cannot be older");

      database.query(`
        UPDATE app_release_state
        SET
          minimum_reader_version = '1.1.0',
          minimum_reader_build = 7,
          migration_version = ?
        WHERE singleton = 1
      `).run(currentControlPlaneMigrationVersion + 1);
      expect(() =>
        recordCompatibleControlPlaneRelease(
          database,
          { version: "1.1.0", build: 7 },
          2,
        ),
      )
        .toThrow("recorded application release migration is incompatible");
    } finally {
      database.close();
    }
  });

  test("rejects a future writer before chmod, writable open, pragma, or migration", () => {
    const root = privateTemporaryDirectory("oprte-release-preflight-");
    const databasePath = join(root, "control-plane.sqlite");
    const database = openControlPlane(databasePath, {
      releaseIdentity: release100,
      now: () => 1,
    });
    database.query(`
      UPDATE app_release_state
      SET
        last_writer_version = '1.1.0',
        last_writer_build = 8,
        minimum_reader_version = '1.1.0',
        minimum_reader_build = 8,
        updated_at = 2
      WHERE singleton = 1
    `).run();
    database.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE");
    database.close();
    chmodSync(databasePath, 0o640);

    const before = snapshotFiles(root);
    expect(() =>
      openControlPlane(databasePath, {
        releaseIdentity: release100,
        now: () => 3,
      }),
    ).toThrow("requires a newer HRA release");
    expect(snapshotFiles(root)).toEqual(before);
    expect(lstatSync(databasePath).mode & 0o777).toBe(0o640);
  });

  test("read-only preflight leaves a live WAL triplet byte-for-byte unchanged", () => {
    const root = privateTemporaryDirectory("oprte-release-wal-");
    const databasePath = join(root, "control-plane.sqlite");
    const database = new Database(databasePath, { create: true, strict: true });
    try {
      database.exec(
        "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; PRAGMA foreign_keys = ON",
      );
      applyMigrations(database);
      recordCompatibleControlPlaneRelease(database, release100, 1);
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      database.query(`
        INSERT INTO local_installations (installation_id, created_at, updated_at)
        VALUES ('install_wal_preflight', 1, 1)
      `).run();

      expect(readdirSync(root).sort()).toEqual([
        "control-plane.sqlite",
        "control-plane.sqlite-shm",
        "control-plane.sqlite-wal",
      ]);
      const before = snapshotFiles(root);
      expect(preflightControlPlaneRelease(databasePath, release100)).toMatchObject({
        kind: "compatible",
        migrationVersion: currentControlPlaneMigrationVersion,
      });
      expect(snapshotFiles(root)).toEqual(before);
    } finally {
      database.close();
    }
  });

  test("preflights a WAL missing its shm without materializing one", () => {
    const root = privateTemporaryDirectory("oprte-release-wal-no-shm-");
    const databasePath = join(root, "control-plane.sqlite");
    const database = new Database(databasePath, { create: true, strict: true });
    try {
      database.exec(
        "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; PRAGMA foreign_keys = ON",
      );
      applyMigrations(database);
      recordCompatibleControlPlaneRelease(database, release100, 1);
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      database.query(`
        INSERT INTO local_installations (installation_id, created_at, updated_at)
        VALUES ('install_wal_without_shm', 1, 1)
      `).run();
      unlinkSync(`${databasePath}-shm`);

      const before = snapshotFiles(root);
      expect(preflightControlPlaneRelease(databasePath, release100)).toMatchObject({
        kind: "compatible",
        migrationVersion: currentControlPlaneMigrationVersion,
      });
      expect(snapshotFiles(root)).toEqual(before);
      expect(readdirSync(root)).not.toContain("control-plane.sqlite-shm");
    } finally {
      database.close();
    }
  });

  test("external fence rejects an old binary after a future migration reaches only WAL", () => {
    const root = privateTemporaryDirectory("oprte-release-future-wal-");
    const databasePath = join(root, "control-plane.sqlite");
    const initial = openControlPlane(databasePath, {
      releaseIdentity: release100,
      now: () => 1,
    });
    initial.close();

    publishControlPlaneReleaseFence(
      databasePath,
      release110,
      currentControlPlaneMigrationVersion,
      2,
    );
    const futureWriter = new Database(databasePath, { strict: true });
    try {
      futureWriter.exec(
        "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0",
      );
      futureWriter.exec(`
        CREATE TABLE future_migration_wal_only (
          value TEXT NOT NULL
        ) STRICT;
        INSERT INTO future_migration_wal_only (value) VALUES ('future');
      `);
      const before = snapshotFiles(root);

      expect(() =>
        openControlPlane(databasePath, {
          releaseIdentity: release100,
          now: () => 3,
        }),
      ).toThrow("release fence requires a newer HRA release");
      expect(snapshotFiles(root)).toEqual(before);
    } finally {
      futureWriter.close();
    }
  });
});

function privateTemporaryDirectory(prefix: string): string {
  const candidate = mkdtempSync(join(tmpdir(), prefix));
  const root = realpathSync(candidate);
  temporaryDirectories.push(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return root;
}

function snapshotFiles(root: string): readonly Readonly<{
  name: string;
  dev: string;
  ino: string;
  mode: number;
  size: string;
  mtimeNs: string;
  sha256: string;
}>[] {
  return readdirSync(root).sort().map((name) => {
    const path = join(root, name);
    const metadata = lstatSync(path, { bigint: true });
    return {
      name,
      dev: String(metadata.dev),
      ino: String(metadata.ino),
      mode: Number(metadata.mode & 0o777n),
      size: String(metadata.size),
      mtimeNs: String(metadata.mtimeNs),
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    };
  });
}
