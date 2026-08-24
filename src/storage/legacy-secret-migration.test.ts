import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BunLegacySecretReader,
  LEGACY_HRA_KEYCHAIN_SERVICE,
  LegacySecretMigrationError,
  migrateLegacySecrets,
  preflightLegacySecretMigration,
  type LegacySecretReader,
} from "./legacy-secret-migration";
import { resolveStatePaths, type StatePaths } from "./paths";
import { FileSecretBackend } from "./secret-custody";

class MemoryLegacyReader implements LegacySecretReader {
  readonly calls: string[] = [];
  readonly values = new Map<string, string>();

  async get(account: string): Promise<string | null> {
    this.calls.push(account);
    return this.values.get(account) ?? null;
  }
}

const currentAuthority = { assertCurrent: async (): Promise<void> => undefined };

type Fixture = Readonly<{ home: string; paths: StatePaths }>;

const createFixture = async (): Promise<Fixture> => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hra-legacy-secrets-")));
  const paths = resolveStatePaths({ rootDirectory: home });
  await mkdir(join(paths.root, "secret-metadata"), { mode: 0o700 });
  return { home, paths };
};

const addPointer = async (
  fixture: Fixture,
  slot: string,
  value: string,
  nonce: string,
): Promise<{ account: string; path: string }> => {
  const generation = 0;
  const digest = createHash("sha256").update(value).digest("hex");
  const path = join(fixture.paths.root, "secret-metadata", `${slot}.json`);
  await writeFile(path, JSON.stringify({ version: 1, generation, nonce, digest }), {
    mode: 0o600,
  });
  return { account: `${slot}.${generation}.${nonce}`, path };
};

describe("legacy Keychain secret migration", () => {
  test("pins the former prerelease service without exposing a mutation port", () => {
    expect(LEGACY_HRA_KEYCHAIN_SERVICE).toBe("sh.hra.control-plane.v1");
    const reader = new BunLegacySecretReader();
    expect(typeof reader.get).toBe("function");
    expect("set" in reader).toBe(false);
    expect("delete" in reader).toBe(false);
  });

  test("preflight inspects pointers without Keychain access or filesystem mutation", async () => {
    const fixture = await createFixture();
    try {
      const pointer = await addPointer(
        fixture,
        "cloud-auth",
        "private-auth-value",
        "11111111-1111-4111-8111-111111111111",
      );
      const beforeEntries = await readdir(fixture.paths.root);
      const beforePointer = await readFile(pointer.path, "utf8");

      await expect(preflightLegacySecretMigration(fixture.paths)).resolves.toEqual({
        copiesPending: 1,
        copiesPresent: 0,
        copiesRequired: 1,
        nextAction: "execute_migration",
        status: "ready",
      });

      expect(await readdir(fixture.paths.root)).toEqual(beforeEntries);
      expect(await readFile(pointer.path, "utf8")).toBe(beforePointer);
      await expect(lstat(join(fixture.paths.root, "secret-values")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(fixture.home, { force: true, recursive: true });
    }
  });

  test("preflight validates persistent, legacy-stale, and pending artifacts without mutation", async () => {
    const fixture = await createFixture();
    try {
      const nonce = "12121212-1212-4212-8212-121212121212";
      const value = "private-auth-value";
      const pointer = await addPointer(fixture, "cloud-auth", value, nonce);
      const metadataRoot = join(fixture.paths.root, "secret-metadata");
      const digest = createHash("sha256").update(value).digest("hex");
      const legacyLock = join(metadataRoot, "cloud-auth.lock");
      const legacyLockDocument = JSON.stringify({
        version: 1,
        pid: process.pid,
        nonce: "13131313-1313-4313-8313-131313131313",
      });
      await writeFile(legacyLock, legacyLockDocument, { mode: 0o600 });
      await link(legacyLock, `${legacyLock}.stale.14141414-1414-4414-8414-141414141414`);
      await writeFile(join(metadataRoot, "device-secret.lock"), "", { mode: 0o600 });
      const pendingPath = join(metadataRoot, "cloud-auth.pending.json");
      const pendingDocument = JSON.stringify({
        version: 2,
        state: "clearing",
        generation: 0,
        nonce,
        digest,
      });
      await writeFile(pendingPath, pendingDocument, { mode: 0o600 });
      const beforeEntries = (await readdir(metadataRoot)).sort();
      const beforeLinks = (await lstat(legacyLock, { bigint: true })).nlink;

      await expect(preflightLegacySecretMigration(fixture.paths)).resolves.toEqual({
        copiesPending: 1,
        copiesPresent: 0,
        copiesRequired: 1,
        nextAction: "execute_migration",
        status: "ready",
      });

      expect((await readdir(metadataRoot)).sort()).toEqual(beforeEntries);
      expect((await lstat(legacyLock, { bigint: true })).nlink).toBe(beforeLinks);
      expect(await readFile(pointer.path, "utf8")).toContain(nonce);
      expect(await readFile(pendingPath, "utf8")).toBe(pendingDocument);
      expect(await readFile(legacyLock, "utf8")).toBe(legacyLockDocument);
    } finally {
      await rm(fixture.home, { force: true, recursive: true });
    }
  });

  test("preflight rejects a schema-valid pending pointer that cannot follow its authority", async () => {
    const fixture = await createFixture();
    try {
      await addPointer(
        fixture,
        "cloud-auth",
        "private-auth-value",
        "16161616-1616-4616-8616-161616161616",
      );
      const pendingPath = join(
        fixture.paths.root,
        "secret-metadata",
        "cloud-auth.pending.json",
      );
      const impossible = JSON.stringify({
        version: 3,
        state: "committed",
        current: {
          generation: 99,
          nonce: "17171717-1717-4717-8717-171717171717",
          digest: createHash("sha256").update("future-value").digest("hex"),
        },
      });
      await writeFile(pendingPath, impossible, { mode: 0o600 });

      await expect(preflightLegacySecretMigration(fixture.paths)).rejects.toEqual(
        new LegacySecretMigrationError("unsafe_metadata"),
      );
      expect(await readFile(pendingPath, "utf8")).toBe(impossible);
    } finally {
      await rm(fixture.home, { force: true, recursive: true });
    }
  });

  test("preflight enforces the runtime stale-lock bound per slot without mutation", async () => {
    const fixture = await createFixture();
    try {
      const metadataRoot = join(fixture.paths.root, "secret-metadata");
      const lockPath = join(metadataRoot, "cloud-auth.lock");
      await writeFile(lockPath, "", { mode: 0o600 });
      for (let index = 0; index < 65; index += 1) {
        const suffix = index.toString(16).padStart(12, "0");
        await link(lockPath, `${lockPath}.stale.18181818-1818-4818-8818-${suffix}`);
      }
      const beforeEntries = (await readdir(metadataRoot)).sort();

      await expect(preflightLegacySecretMigration(fixture.paths)).rejects.toEqual(
        new LegacySecretMigrationError("unsafe_metadata"),
      );
      expect((await readdir(metadataRoot)).sort()).toEqual(beforeEntries);
      expect((await lstat(lockPath, { bigint: true })).nlink).toBe(66n);
    } finally {
      await rm(fixture.home, { force: true, recursive: true });
    }
  });

  test("preflight nonmutatingly accepts a bounded stale-only quarantine cut", async () => {
    const fixture = await createFixture();
    try {
      const metadataRoot = join(fixture.paths.root, "secret-metadata");
      const lockPath = join(metadataRoot, "cloud-auth.lock");
      const stalePath = `${lockPath}.stale.15151515-1515-4515-8515-151515151515`;
      await writeFile(lockPath, "", { mode: 0o600 });
      await link(lockPath, stalePath);
      await unlink(lockPath);

      await expect(preflightLegacySecretMigration(fixture.paths)).resolves.toEqual({
        copiesPending: 0,
        copiesPresent: 0,
        copiesRequired: 0,
        nextAction: "none",
        status: "not_required",
      });
      expect(await readdir(metadataRoot)).toEqual([
        "cloud-auth.lock.stale.15151515-1515-4515-8515-151515151515",
      ]);
    } finally {
      await rm(fixture.home, { force: true, recursive: true });
    }
  });

  test("validates every required legacy value before copying any of them", async () => {
    const fixture = await createFixture();
    try {
      const available = await addPointer(
        fixture,
        "cloud-auth",
        "available-value",
        "22222222-2222-4222-8222-222222222222",
      );
      await addPointer(
        fixture,
        "device-secret",
        "missing-value",
        "33333333-3333-4333-8333-333333333333",
      );
      const legacy = new MemoryLegacyReader();
      legacy.values.set(available.account, "available-value");

      await expect(migrateLegacySecrets(fixture.paths, legacy, currentAuthority)).rejects.toEqual(
        new LegacySecretMigrationError("legacy_value_missing"),
      );
      await expect(lstat(join(fixture.paths.root, "secret-values")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(fixture.home, { force: true, recursive: true });
    }
  });

  test("refuses a legacy value whose digest does not match its pointer", async () => {
    const fixture = await createFixture();
    try {
      const pointer = await addPointer(
        fixture,
        "cloud-auth",
        "expected-value",
        "44444444-4444-4444-8444-444444444444",
      );
      const legacy = new MemoryLegacyReader();
      legacy.values.set(pointer.account, "different-value");

      await expect(migrateLegacySecrets(fixture.paths, legacy, currentAuthority)).rejects.toEqual(
        new LegacySecretMigrationError("legacy_digest_mismatch"),
      );
      await expect(lstat(join(fixture.paths.root, "secret-values")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(fixture.home, { force: true, recursive: true });
    }
  });

  test("finishes a partial copy and makes the next execution Keychain-free", async () => {
    const fixture = await createFixture();
    try {
      const present = await addPointer(
        fixture,
        "cloud-auth",
        "already-copied",
        "55555555-5555-4555-8555-555555555555",
      );
      const pending = await addPointer(
        fixture,
        "device-secret",
        "still-in-keychain",
        "66666666-6666-4666-8666-666666666666",
      );
      const destination = new FileSecretBackend(join(fixture.paths.root, "secret-values"));
      await destination.set(present.account, "already-copied");
      const legacy = new MemoryLegacyReader();
      legacy.values.set(pending.account, "still-in-keychain");

      await expect(migrateLegacySecrets(fixture.paths, legacy, currentAuthority)).resolves.toEqual({
        copiesPresent: 2,
        copiesRequired: 2,
        legacyEntriesRetained: true,
        status: "migrated",
      });
      expect(legacy.calls).toEqual([pending.account]);
      expect(legacy.values.get(pending.account)).toBe("still-in-keychain");
      expect(await destination.get(present.account)).toBe("already-copied");
      expect(await destination.get(pending.account)).toBe("still-in-keychain");

      legacy.calls.length = 0;
      await expect(migrateLegacySecrets(fixture.paths, legacy, currentAuthority)).resolves.toEqual({
        copiesPresent: 2,
        copiesRequired: 2,
        legacyEntriesRetained: true,
        status: "already_complete",
      });
      expect(legacy.calls).toEqual([]);
    } finally {
      await rm(fixture.home, { force: true, recursive: true });
    }
  });

  test("migration rewrites a crash-partial deterministic pending value before publication", async () => {
    const fixture = await createFixture();
    try {
      const pointer = await addPointer(
        fixture,
        "cloud-auth",
        "complete-value",
        "88888888-8888-4888-8888-888888888888",
      );
      const valuesRoot = join(fixture.paths.root, "secret-values");
      await mkdir(valuesRoot, { mode: 0o700 });
      await writeFile(join(valuesRoot, `.${pointer.account}.pending`), "partial", {
        mode: 0o600,
      });
      const legacy = new MemoryLegacyReader();
      legacy.values.set(pointer.account, "complete-value");

      await expect(migrateLegacySecrets(fixture.paths, legacy, currentAuthority)).resolves.toEqual({
        copiesPresent: 1,
        copiesRequired: 1,
        legacyEntriesRetained: true,
        status: "migrated",
      });
      expect(legacy.calls).toEqual([pointer.account]);
      expect(await readdir(valuesRoot)).toEqual([pointer.account]);
      expect(await readFile(join(valuesRoot, pointer.account), "utf8")).toBe("complete-value");
    } finally {
      await rm(fixture.home, { force: true, recursive: true });
    }
  });

  test("preflight accepts an exact linked publication crash without cleaning it", async () => {
    const fixture = await createFixture();
    try {
      const pointer = await addPointer(
        fixture,
        "cloud-auth",
        "complete-value",
        "99999999-9999-4999-8999-999999999999",
      );
      const valuesRoot = join(fixture.paths.root, "secret-values");
      const failure = new Error("post-link sync failure");
      let failed = false;
      const interrupted = new FileSecretBackend(valuesRoot, {
        syncDirectory: async (handle) => {
          if (!failed) {
            failed = true;
            throw failure;
          }
          await handle.sync();
        },
      });
      await expect(interrupted.set(pointer.account, "complete-value")).rejects.toBe(failure);
      const beforeEntries = (await readdir(valuesRoot)).sort();
      expect(beforeEntries).toEqual([`.${pointer.account}.pending`, pointer.account]);
      expect((await lstat(join(valuesRoot, pointer.account), { bigint: true })).nlink).toBe(2n);

      await expect(preflightLegacySecretMigration(fixture.paths)).resolves.toEqual({
        copiesPending: 0,
        copiesPresent: 1,
        copiesRequired: 1,
        nextAction: "none",
        status: "already_complete",
      });
      expect((await readdir(valuesRoot)).sort()).toEqual(beforeEntries);
      expect((await lstat(join(valuesRoot, pointer.account), { bigint: true })).nlink).toBe(2n);

      const restarted = new FileSecretBackend(valuesRoot);
      await restarted.set(pointer.account, "complete-value");
      expect(await readdir(valuesRoot)).toEqual([pointer.account]);
    } finally {
      await rm(fixture.home, { force: true, recursive: true });
    }
  });

  test("refuses an existing conflicting file before reading Keychain", async () => {
    const fixture = await createFixture();
    try {
      const pointer = await addPointer(
        fixture,
        "cloud-auth",
        "expected-value",
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      );
      const destination = new FileSecretBackend(join(fixture.paths.root, "secret-values"));
      await destination.set(pointer.account, "conflicting-value");
      const legacy = new MemoryLegacyReader();
      legacy.values.set(pointer.account, "expected-value");

      await expect(preflightLegacySecretMigration(fixture.paths)).rejects.toEqual(
        new LegacySecretMigrationError("target_value_conflict"),
      );
      await expect(migrateLegacySecrets(fixture.paths, legacy, currentAuthority)).rejects.toEqual(
        new LegacySecretMigrationError("target_value_conflict"),
      );
      expect(legacy.calls).toEqual([]);
      expect(await destination.get(pointer.account)).toBe("conflicting-value");
    } finally {
      await rm(fixture.home, { force: true, recursive: true });
    }
  });

  test("fails closed on an unsafe pointer before reading Keychain", async () => {
    const fixture = await createFixture();
    try {
      const pointer = await addPointer(
        fixture,
        "cloud-auth",
        "private-auth-value",
        "77777777-7777-4777-8777-777777777777",
      );
      await chmod(pointer.path, 0o644);
      const legacy = new MemoryLegacyReader();

      await expect(preflightLegacySecretMigration(fixture.paths)).rejects.toEqual(
        new LegacySecretMigrationError("unsafe_metadata"),
      );
      await expect(migrateLegacySecrets(fixture.paths, legacy, currentAuthority)).rejects.toEqual(
        new LegacySecretMigrationError("unsafe_metadata"),
      );
      expect(legacy.calls).toEqual([]);
    } finally {
      await rm(fixture.home, { force: true, recursive: true });
    }
  });
});
