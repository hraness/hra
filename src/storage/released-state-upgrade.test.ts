import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import { Database } from "bun:sqlite";
import { z } from "zod";

import {
  assertReleasedHraReadonlySchema,
  RELEASED_HRA_SCHEMA_VERSION,
} from "../../scripts/fixtures/released-state/v0.5.0/released-readonly-schema-guard";
import { resolveStatePaths } from "./paths";
import { StateStore } from "./state-store";

const fixtureDirectory = resolve(
  import.meta.dir,
  "../../scripts/fixtures/released-state/v0.5.0",
);

const expectedRowsSchema = z.object({
  migrations: z.object({
    count: z.number().int().positive(),
    first: z.number().int().positive(),
    last: z.number().int().positive(),
  }).strict(),
  profiles: z.array(z.object({
    id: z.string(),
    label: z.string(),
    process_generation: z.number().int().nonnegative(),
    state: z.string(),
  }).strict()),
  projects: z.array(z.object({
    id: z.string(),
    is_default: z.number().int(),
    label: z.string(),
    root_path: z.string(),
  }).strict()),
  queueEntries: z.array(z.object({
    enqueue_sequence: z.number().int().positive(),
    id: z.string(),
    message: z.string(),
    session_id: z.string(),
    state: z.string(),
  }).strict()),
  queueSequenceAuthority: z.object({
    next_sequence: z.number().int().positive(),
  }).strict(),
  sessions: z.array(z.object({
    id: z.string(),
    preset: z.string(),
    profile_id: z.string(),
    project_id: z.string(),
    provider: z.string(),
    revision: z.number().int().positive(),
    state: z.string(),
    title: z.string(),
  }).strict()),
}).strict();

const manifestSchema = z.object({
  downgradeProof: z.object({
    probedNewerSchemaVersion: z.number().int().positive(),
    releasedReadonlyError: z.string(),
  }).strict(),
  schemaVersion: z.literal(1),
  source: z.object({
    archiveBytes: z.number().int().positive(),
    archiveName: z.string(),
    archiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    archiveSRI: z.string().startsWith("sha512-"),
    packageName: z.string(),
    stateStoreSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    tag: z.string(),
    tagCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    version: z.string(),
  }).strict(),
  state: z.object({
    databaseRelativePath: z.string(),
    expectedRows: expectedRowsSchema,
    releasedSchemaVersion: z.number().int().positive(),
    rootDirectories: z.array(z.string()).max(32),
    sqlBytes: z.number().int().positive().max(512 * 1_024),
    sqlSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    walCheckpoint: z.object({
      busy: z.literal(0),
      checkpointed: z.number().int().nonnegative(),
      log: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
}).strict();

type ReleasedFixtureManifest = z.infer<typeof manifestSchema>;

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

const assertFixtureRelativePath = (value: string): string => {
  if (
    value.length < 1
    || value.length > 256
    || value.startsWith("/")
    || value.split("/").some((part) => part.length < 1 || part === "." || part === "..")
  ) throw new Error("Released-state fixture contains an unsafe relative path.");
  return value;
};

const materialState = (databasePath: string): z.infer<typeof expectedRowsSchema> => {
  const database = new Database(databasePath, { create: false, readonly: true, strict: true });
  try {
    return expectedRowsSchema.parse({
      migrations: database.query(
        "SELECT MIN(version) AS first,MAX(version) AS last,COUNT(*) AS count FROM migrations",
      ).get(),
      profiles: database.query(
        "SELECT id,label,state,process_generation FROM profiles ORDER BY id",
      ).all(),
      projects: database.query(
        "SELECT id,label,root_path,is_default FROM projects ORDER BY id",
      ).all(),
      queueEntries: database.query(
        "SELECT id,session_id,message,state,enqueue_sequence FROM queue_entries ORDER BY id",
      ).all(),
      queueSequenceAuthority: database.query(
        "SELECT next_sequence FROM queue_sequence_authority WHERE singleton=1",
      ).get(),
      sessions: database.query(
        "SELECT id,profile_id,project_id,title,provider,preset,state,revision FROM sessions ORDER BY id",
      ).all(),
    });
  } finally {
    database.close(false);
  }
};

const materialTree = async (root: string, at = root): Promise<string> => {
  const entries = (await readdir(at, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const measured: string[] = [];
  for (const entry of entries) {
    const path = join(at, entry.name);
    const canonicalRelative = relative(root, path).split(sep).join("/");
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error("Released-state fixture root must not contain symlinks.");
    if (metadata.isDirectory()) {
      measured.push(`directory:${canonicalRelative}`);
      measured.push(await materialTree(root, path));
      continue;
    }
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new Error("Released-state fixture root contains an unsupported entry.");
    }
    measured.push(`file:${canonicalRelative}:${String(metadata.size)}:${sha256(await readFile(path))}`);
  }
  return measured.join("\n");
};

const materializeReleasedRoot = async (
  root: string,
  manifest: ReleasedFixtureManifest,
  sql: string,
): Promise<string> => {
  await mkdir(root, { recursive: false, mode: 0o700 });
  for (const directory of manifest.state.rootDirectories) {
    await mkdir(join(root, assertFixtureRelativePath(directory)), { recursive: true, mode: 0o700 });
  }
  const databasePath = join(root, assertFixtureRelativePath(manifest.state.databaseRelativePath));
  const database = new Database(databasePath, { create: true, strict: true });
  try {
    database.exec(sql);
    expect(database.query("PRAGMA journal_mode=WAL").get()).toEqual({ journal_mode: "wal" });
    expect(database.query("PRAGMA wal_checkpoint(TRUNCATE)").get()).toEqual({
      busy: 0,
      checkpointed: 0,
      log: 0,
    });
  } finally {
    database.close(false);
  }
  await chmod(databasePath, 0o600);
  const wal = `${databasePath}-wal`;
  if (await Bun.file(wal).exists()) expect((await lstat(wal)).size).toBe(0);
  const sharedMemory = `${databasePath}-shm`;
  if (await Bun.file(sharedMemory).exists()) {
    const metadata = await lstat(sharedMemory);
    expect(metadata.isFile()).toBe(true);
    expect(metadata.isSymbolicLink()).toBe(false);
    expect(metadata.nlink).toBe(1);
    expect(metadata.size).toBeLessThanOrEqual(64 * 1_024);
  }
  return databasePath;
};

test("upgrades exact released v0.5.0 state and restores the whole root for downgrade", async () => {
  const manifestBytes = await readFile(join(fixtureDirectory, "manifest.json"));
  const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")) as unknown);
  expect(manifest.source).toMatchObject({
    archiveBytes: 808_632,
    archiveName: "hraness-hra-0.5.0.tgz",
    archiveSha256: "d0d958a95b15989f639e60ba90a2abefa7d01a3c54af601c300657d365f39063",
    archiveSRI: "sha512-lpiJw1nEDc1CKVpnbtvw4+3+3DZAAKDJ2rvP0VZCwfzatP3gEMh6iTQNQjvZn1z4kyKCQcwo//cRg3/HLyz27Q==",
    packageName: "@hraness/hra",
    stateStoreSha256: "9c40a3a616f308c7387ba2861e3307624f75019aed79608626a0a7325e04caad",
    tag: "v0.5.0",
    tagCommit: "846f5c99f573f97ce99f1f23ac1ea45d93e63042",
    version: "0.5.0",
  });
  expect(manifest.state.releasedSchemaVersion).toBe(RELEASED_HRA_SCHEMA_VERSION);
  expect(manifest.state.walCheckpoint).toEqual({ busy: 0, checkpointed: 0, log: 0 });
  expect(manifest.downgradeProof).toEqual({
    probedNewerSchemaVersion: 35,
    releasedReadonlyError: "STATE_SCHEMA_NEWER:35:33",
  });

  const sqlBytes = await readFile(join(fixtureDirectory, "control-plane.sql"));
  expect(sqlBytes.byteLength).toBe(manifest.state.sqlBytes);
  expect(sha256(sqlBytes)).toBe(manifest.state.sqlSha256);

  const temporary = await realpath(await mkdtemp(join(tmpdir(), "hra-released-upgrade-")));
  const releasedRoot = join(temporary, "state");
  const backupRoot = join(temporary, "state.v0.5.0.backup");
  const upgradedRoot = join(temporary, "state.upgraded");
  try {
    const databasePath = await materializeReleasedRoot(
      releasedRoot,
      manifest,
      sqlBytes.toString("utf8"),
    );
    expect(materialState(databasePath)).toEqual(manifest.state.expectedRows);
    expect(() => assertReleasedHraReadonlySchema(databasePath)).not.toThrow();

    const beforeUpgrade = await materialTree(releasedRoot);
    await cp(releasedRoot, backupRoot, { recursive: true });
    expect(await materialTree(backupRoot)).toBe(beforeUpgrade);

    const paths = resolveStatePaths({ rootDirectory: releasedRoot });
    const current = new StateStore(paths, { now: () => 1_800_000_000_000 });
    current.close();

    const inspector = new Database(databasePath, { create: false, readonly: true, strict: true });
    let currentSchemaVersion = 0;
    try {
      currentSchemaVersion = (inspector.query("PRAGMA user_version").get() as { user_version: number }).user_version;
      expect(currentSchemaVersion).toBeGreaterThan(RELEASED_HRA_SCHEMA_VERSION);
      expect(inspector.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(inspector.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(inspector.query(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('attachments','session_peer_policies','session_provider_switches') ORDER BY name",
      ).all()).toEqual([
        { name: "attachments" },
        { name: "session_peer_policies" },
      ]);
      expect(inspector.query(
        "SELECT message_actor,peer_action_id FROM queue_entries",
      ).get()).toEqual({ message_actor: "human", peer_action_id: null });
      expect(inspector.query(
        "SELECT session_id,mode,revision FROM session_peer_policies",
      ).get()).toEqual({
        mode: "coordinate",
        revision: 1,
        session_id: manifest.state.expectedRows.sessions[0]?.id,
      });
    } finally {
      inspector.close(false);
    }
    const upgradedState = materialState(databasePath);
    expect(upgradedState.migrations).toEqual({
      count: currentSchemaVersion,
      first: 1,
      last: currentSchemaVersion,
    });
    expect({
      ...upgradedState,
      migrations: manifest.state.expectedRows.migrations,
    }).toEqual({
      ...manifest.state.expectedRows,
      queueEntries: manifest.state.expectedRows.queueEntries.map((entry) => ({
        ...entry,
        message: "[queue message removed after settlement]",
        state: "cancelled",
      })),
      sessions: manifest.state.expectedRows.sessions.map((session) => ({
        ...session,
        revision: session.revision + 1,
        state: "recovery_required",
      })),
    });
    expect(() => assertReleasedHraReadonlySchema(databasePath))
      .toThrow(`STATE_SCHEMA_NEWER:${String(currentSchemaVersion)}:${String(RELEASED_HRA_SCHEMA_VERSION)}`);

    // Rollback is deliberately a whole-root exchange. Overlaying only the old
    // database could leave current sidecars, profile data, or memory epochs in
    // place for a released binary to misinterpret.
    await rename(releasedRoot, upgradedRoot);
    await rename(backupRoot, releasedRoot);
    const restoredDatabasePath = join(releasedRoot, manifest.state.databaseRelativePath);
    expect(await materialTree(releasedRoot)).toBe(beforeUpgrade);
    expect(materialState(restoredDatabasePath)).toEqual(manifest.state.expectedRows);
    expect(() => assertReleasedHraReadonlySchema(restoredDatabasePath)).not.toThrow();
    expect(() => new StateStore(resolveStatePaths({ rootDirectory: releasedRoot }), { readonly: true }))
      .toThrow(`STATE_SCHEMA_MIGRATION_REQUIRED:${String(RELEASED_HRA_SCHEMA_VERSION)}:${String(currentSchemaVersion)}`);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});
