import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import {
  localObservationDirectoryName,
  localObservationSocketFileName,
} from "@hraness/hra-local-observation-protocol/wire";
import {
  ApplicationSupportMigrationError,
  applicationSupportPaths,
  inspectApplicationSupportMigration,
  inspectApplicationSupportReadiness,
  isolatedDevelopmentApplicationSupportRoot,
  prepareApplicationSupportMigration,
  prepareIsolatedDevelopmentApplicationSupport,
  type ApplicationSupportMigrationFaultPoint,
} from "../src/state/application-support";

const temporaryDirectories: string[] = [];
const managedWorktreeLayouts = [
  { label: "dispatch", segments: ["dispatch", "worktrees"] },
  { label: "local task", segments: ["local-task-worktrees"] },
  { label: "chat", segments: ["chat-worktrees"] },
  { label: "harness", segments: ["harness", "v1", "worktrees"] },
] as const;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{
  readonly home: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly paths: ReturnType<typeof applicationSupportPaths>;
}> {
  const home = await mkdtemp(join(tmpdir(), "oprte-migration-"));
  temporaryDirectories.push(home);
  const paths = applicationSupportPaths(home);
  await mkdir(paths.parent, { recursive: true });
  return { home, environment: { HOME: home }, paths };
}

async function lstatIfPresent(filePath: string) {
  try {
    return await lstat(filePath);
  } catch (error: unknown) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

async function withListeningSocketAt(
  socketPath: string,
  action: () => void | Promise<void>,
): Promise<void> {
  const socketStagingParent = process.platform === "darwin"
    ? "/private/tmp"
    : tmpdir();
  const socketStagingRoot = await realpath(
    await mkdtemp(join(socketStagingParent, "hra-migration-socket-")),
  );
  temporaryDirectories.push(socketStagingRoot);
  const listeningSocket = join(socketStagingRoot, "s");
  const server = createServer();
  try {
    server.listen(listeningSocket);
    await once(server, "listening");
    await chmod(listeningSocket, 0o600);
    await rename(listeningSocket, socketPath);
    await action();
  } finally {
    if (server.listening) {
      const closed = once(server, "close");
      server.close();
      await closed;
    }
  }
}

async function writeLegacyTree(root: string): Promise<void> {
  await mkdir(join(root, "codex", "accounts", "acct_12345678", "home"), {
    recursive: true,
    mode: 0o750,
  });
  await mkdir(join(root, "dispatch", "worktrees", "run_12345678"), {
    recursive: true,
    mode: 0o710,
  });
  const databasePath = join(root, "control-plane.sqlite");
  const crashedWriter = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
        import { Database } from "bun:sqlite";
        const database = new Database(process.env.MIGRATION_FIXTURE_DATABASE, {
          create: true,
          strict: true,
        });
        database.exec(\`
          PRAGMA journal_mode = WAL;
          PRAGMA wal_autocheckpoint = 0;
          CREATE TABLE migration_fixture (value TEXT NOT NULL) STRICT;
          INSERT INTO migration_fixture (value) VALUES ('legacy-database-bytes');
          CREATE TABLE operation_receipts (operation_id TEXT PRIMARY KEY) STRICT;
          INSERT INTO operation_receipts (operation_id) VALUES ('op_fixture');
        \`);
        process.kill(process.pid, "SIGKILL");
      `,
    ],
    {
      env: {
        ...process.env,
        MIGRATION_FIXTURE_DATABASE: databasePath,
      },
    },
  );
  if (crashedWriter.exitCode === 0) {
    throw new Error("The SQLite crash fixture exited without its injected interruption");
  }
  await chmod(databasePath, 0o640);
  await writeFile(
    join(root, "operation-receipts.hmac.key"),
    new Uint8Array(32).fill(0x42),
    { mode: 0o400 },
  );
  await writeFile(
    join(root, "codex", "accounts", "acct_12345678", "home", "auth.json"),
    "{\"token\":\"fixture\"}",
    { mode: 0o600 },
  );
  await writeFile(
    join(root, "dispatch", "worktrees", "run_12345678", "unknown-future-state"),
    new Uint8Array([12, 13, 14]),
    { mode: 0o444 },
  );
  await chmod(root, 0o750);
}

function expectLegacyDatabase(databasePath: string): void {
  const database = new Database(databasePath, { strict: true });
  try {
    expect(
      database.query<{ value: string }, []>("SELECT value FROM migration_fixture").get()?.value,
    ).toBe("legacy-database-bytes");
    expect(
      database.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check,
    ).toBe("ok");
  } finally {
    database.close();
  }
}

function faultAt(point: ApplicationSupportMigrationFaultPoint) {
  return (candidate: ApplicationSupportMigrationFaultPoint): void => {
    if (candidate === point) throw new Error(`fault:${point}`);
  };
}

describe("Application Support migration", () => {
  test("raw development owns a distinct root and never consumes production or historical development state", async () => {
    const { home, paths } = await fixture();
    await mkdir(paths.target);
    await writeFile(join(paths.target, "production-sentinel"), "production");
    await mkdir(paths.developmentFallback);
    await writeFile(
      join(paths.developmentFallback, "historical-sentinel"),
      "historical",
    );

    const startup = prepareIsolatedDevelopmentApplicationSupport(home);
    expect(startup.root).toBe(isolatedDevelopmentApplicationSupportRoot(home));
    expect(startup.root).not.toBe(paths.target);
    expect(startup.root).not.toBe(paths.developmentFallback);
    startup.prepareTargetRoot();
    startup.activate();
    const developmentDatabase = new Database(
      join(startup.root, "control-plane.sqlite"),
      { create: true },
    );
    developmentDatabase.exec("CREATE TABLE development_only(value TEXT)");
    developmentDatabase.close();

    expect(await readFile(join(paths.target, "production-sentinel"), "utf8"))
      .toBe("production");
    expect(await readFile(
      join(paths.developmentFallback, "historical-sentinel"),
      "utf8",
    )).toBe("historical");
    expect((await stat(join(startup.root, "control-plane.sqlite"))).isFile())
      .toBeTrue();
  });

  test("inspects fresh, ready, retry, and conflicting roots without mutation", async () => {
    {
      const { environment, paths } = await fixture();
      const entriesBefore = await readdir(paths.parent);
      expect(inspectApplicationSupportReadiness({ environment })).toEqual({
        kind: "fresh",
      });
      expect(await readdir(paths.parent)).toEqual(entriesBefore);
      expect(await lstatIfPresent(paths.lock)).toBeNull();
    }
    {
      const { environment, paths } = await fixture();
      await mkdir(paths.target);
      expect(inspectApplicationSupportReadiness({ environment })).toEqual({
        kind: "ready",
      });
      expect(await lstatIfPresent(paths.lock)).toBeNull();
    }
    {
      const { environment, paths } = await fixture();
      await mkdir(paths.legacy);
      expect(inspectApplicationSupportReadiness({ environment })).toEqual({
        kind: "retry",
        reason: "legacy",
      });
      expect((await lstat(paths.legacy)).isDirectory()).toBeTrue();
      expect(await lstatIfPresent(paths.target)).toBeNull();
      expect(await lstatIfPresent(paths.lock)).toBeNull();
    }
    for (const roots of ["legacyAndTarget", "multipleLegacy"] as const) {
      const { environment, paths } = await fixture();
      await mkdir(paths.legacy);
      if (roots === "legacyAndTarget") await mkdir(paths.target);
      else await mkdir(paths.developmentFallback);
      expect(inspectApplicationSupportReadiness({ environment })).toEqual({
        kind: "conflict",
        reason: "roots",
      });
      expect((await lstat(paths.legacy)).isDirectory()).toBeTrue();
      expect(await lstatIfPresent(paths.lock)).toBeNull();
    }
  });

  test("reports interrupted, locked, and unsafe migration state without paths", async () => {
    {
      const { environment, home, paths } = await fixture();
      await mkdir(paths.legacy);
      expect(() => prepareApplicationSupportMigration({
        environment,
        onCheckpoint: faultAt("afterPreparedReceipt"),
      })).toThrow("fault:afterPreparedReceipt");
      const inspection = inspectApplicationSupportReadiness({
        environment,
        isFileOpenByAnotherProcess: () => false,
      });
      expect(inspection).toEqual({ kind: "retry", reason: "interrupted" });
      expect(JSON.stringify(inspection)).not.toContain(home);
    }
    {
      const { environment, paths } = await fixture();
      await writeFile(paths.lock, "lock", { mode: 0o600 });
      const inspected: string[] = [];
      const inspection = inspectApplicationSupportReadiness({
        environment,
        isFileOpenByAnotherProcess: (path) => {
          inspected.push(path);
          return true;
        },
      });
      expect(inspection).toEqual({ kind: "conflict", reason: "locked" });
      expect(inspected).toEqual([paths.lock]);
      expect(await readFile(paths.lock, "utf8")).toBe("lock");
      expect(JSON.stringify(inspection)).not.toContain(paths.parent);
    }
    {
      const { environment, paths } = await fixture();
      await symlink(paths.parent, paths.legacy);
      const inspection = inspectApplicationSupportReadiness({ environment });
      expect(inspection).toEqual({ kind: "conflict", reason: "unsafe" });
      expect(JSON.stringify(inspection)).not.toContain(paths.parent);
      expect((await lstat(paths.legacy)).isSymbolicLink()).toBeTrue();
      expect(await lstatIfPresent(paths.lock)).toBeNull();
    }
  });

  test("moves the entire OPRTE root without changing bytes or modes", async () => {
    const { environment, paths } = await fixture();
    await writeLegacyTree(paths.legacy);
    const originalRootMode = (await stat(paths.legacy)).mode & 0o777;
    const originalKeyMode =
      (await stat(join(paths.legacy, "operation-receipts.hmac.key"))).mode & 0o777;
    expect((await stat(join(paths.legacy, "control-plane.sqlite-wal"))).size).toBeGreaterThan(0);

    expect(inspectApplicationSupportMigration(environment)).toEqual({
      kind: "legacyOnly",
      source: "hranessKitchen",
    });
    const startup = prepareApplicationSupportMigration({
      environment,
      isFileOpenByAnotherProcess: () => false,
    });

    expect(startup.initialState).toBe("legacyOnly");
    expect(startup.hasControlPlaneDatabase()).toBe(true);
    expect((await lstat(paths.legacy)).isFile()).toBe(true);
    expect(await lstat(paths.stage).catch(() => null)).toBeNull();
    expect((await stat(paths.target)).mode & 0o777).toBe(originalRootMode);
    expect(
      (await stat(join(paths.target, "operation-receipts.hmac.key"))).mode & 0o777,
    ).toBe(originalKeyMode);
    const checkpointedWal = await lstatIfPresent(
      join(paths.target, "control-plane.sqlite-wal"),
    );
    if (checkpointedWal !== null) {
      expect(checkpointedWal.isFile()).toBe(true);
      expect(checkpointedWal.size).toBe(0);
    }
    const checkpointedSharedMemory = await lstatIfPresent(
      join(paths.target, "control-plane.sqlite-shm"),
    );
    if (checkpointedSharedMemory !== null) {
      expect(checkpointedSharedMemory.isFile()).toBe(true);
    }
    expectLegacyDatabase(join(paths.target, "control-plane.sqlite"));
    expect(
      await readFile(
        join(paths.target, "codex", "accounts", "acct_12345678", "home", "auth.json"),
        "utf8",
      ),
    ).toBe("{\"token\":\"fixture\"}");
    expect(
      await readFile(
        join(paths.target, "dispatch", "worktrees", "run_12345678", "unknown-future-state"),
      ),
    ).toEqual(Buffer.from([12, 13, 14]));

    startup.activate();
    expect((await lstat(paths.legacy)).isFile()).toBe(true);
    expect((await lstat(paths.developmentFallback)).isFile()).toBe(true);
    expect(inspectApplicationSupportMigration(environment)).toEqual({
      kind: "completedRetry",
      source: "hranessKitchen",
    });

    const retry = prepareApplicationSupportMigration({
      environment,
      isFileOpenByAnotherProcess: () => false,
    });
    expect(retry.initialState).toBe("completedRetry");
    retry.activate();
    expectLegacyDatabase(join(paths.target, "control-plane.sqlite"));
  });

  test("moves and validates a legitimate DELETE-journal legacy database", async () => {
    const { environment, paths } = await fixture();
    await mkdir(paths.legacy, { mode: 0o700 });
    const databasePath = join(paths.legacy, "control-plane.sqlite");
    const database = new Database(databasePath, { create: true, strict: true });
    try {
      database.exec("PRAGMA journal_mode = DELETE");
      database.exec("CREATE TABLE fixture (value TEXT NOT NULL) STRICT");
      database.query("INSERT INTO fixture (value) VALUES (?1)").run("delete-journal");
    } finally {
      database.close();
    }

    const startup = prepareApplicationSupportMigration({
      environment,
      isFileOpenByAnotherProcess: () => false,
    });
    startup.prepareTargetRoot();
    startup.activate();

    const migrated = new Database(join(paths.target, "control-plane.sqlite"), {
      strict: true,
    });
    try {
      expect(
        migrated.query<{ value: string }, []>("SELECT value FROM fixture").get(),
      ).toEqual({ value: "delete-journal" });
      expect(
        migrated.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get(),
      ).toEqual({ journal_mode: "delete" });
    } finally {
      migrated.close();
    }
  });

  test("rejects a legacy foreign-key violation before moving or rewriting state", async () => {
    const { environment, home, paths } = await fixture();
    const laneRoot = join(paths.legacy, "dispatch", "worktrees", "run_12345678");
    const manifestPath = join(
      paths.legacy,
      "dispatch",
      "worktrees",
      ".oprte-manifests",
      "run_12345678.json",
    );
    const gitLinkPath = join(laneRoot, ".git");
    await mkdir(join(paths.legacy, "dispatch", "worktrees", ".oprte-manifests"), {
      recursive: true,
    });
    await mkdir(laneRoot);
    const manifestBytes = '{"fixture":"unchanged"}\n';
    const gitLinkBytes = "gitdir: /external/fixture/worktrees/run_12345678\n";
    await writeFile(manifestPath, manifestBytes, { mode: 0o600 });
    await writeFile(gitLinkPath, gitLinkBytes, { mode: 0o600 });
    const database = new Database(join(paths.legacy, "control-plane.sqlite"), {
      create: true,
      strict: true,
    });
    try {
      database.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE parent (id INTEGER PRIMARY KEY) STRICT;
        CREATE TABLE child (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parent(id)
        ) STRICT;
        INSERT INTO child (id, parent_id) VALUES (1, 404);
      `);
    } finally {
      database.close();
    }
    const exchanges: string[][] = [];

    let failure: unknown;
    try {
      prepareApplicationSupportMigration({
        environment,
        exchangePaths: (left, right) => {
          exchanges.push([left, right]);
        },
        isFileOpenByAnotherProcess: () => false,
      });
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ApplicationSupportMigrationError);
    expect(failure).toMatchObject({ code: "invalid_state", path: null });
    expect((failure as Error).message).toBe(
      "Legacy SQLite state failed its integrity check",
    );
    expect((failure as Error).message).not.toContain(home);
    expect(exchanges).toEqual([]);
    expect((await lstat(paths.legacy)).isDirectory()).toBeTrue();
    expect(await lstatIfPresent(paths.target)).toBeNull();
    expect(await lstatIfPresent(paths.stage)).toBeNull();
    expect(await lstatIfPresent(paths.receipt)).toBeNull();
    expect(await readFile(manifestPath, "utf8")).toBe(manifestBytes);
    expect(await readFile(gitLinkPath, "utf8")).toBe(gitLinkBytes);
  });

  test("states neither, target-only, and completed retry explicitly", async () => {
    const { environment, paths } = await fixture();
    expect(inspectApplicationSupportMigration(environment)).toEqual({ kind: "neither" });

    await mkdir(paths.target);
    expect(inspectApplicationSupportMigration(environment)).toEqual({ kind: "targetOnly" });

    const startup = prepareApplicationSupportMigration({
      environment,
      isFileOpenByAnotherProcess: () => false,
    });
    expect(startup.initialState).toBe("targetOnly");
    startup.activate();
    expect(inspectApplicationSupportMigration(environment)).toEqual({
      kind: "completedRetry",
      source: "none",
    });
  });

  test("creates and validates a fresh target before activation", async () => {
    const { environment, paths } = await fixture();
    const startup = prepareApplicationSupportMigration({ environment });
    expect(startup.initialState).toBe("neither");
    startup.prepareTargetRoot();
    expect((await lstat(paths.target)).isDirectory()).toBe(true);
    const receiptCandidate = `${paths.receipt}.tmp`;
    await writeFile(receiptCandidate, "{\"version\":1", { mode: 0o600 });
    startup.activate();
    expect(startup.activated).toBe(true);
    expect(lstat(receiptCandidate)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("rejects established receipt authority without its control-plane database", async () => {
    for (const keyName of [
      "operation-receipts.hmac.key",
      "operation-receipts.hmac.key.tmp",
    ]) {
      const { environment, paths } = await fixture();
      await mkdir(paths.target);
      await writeFile(
        join(paths.target, keyName),
        new Uint8Array(32).fill(0x5a),
        { mode: 0o600 },
      );

      expect(inspectApplicationSupportReadiness({ environment })).toEqual({
        kind: "conflict",
        reason: "unsafe",
      });
      expect(() => prepareApplicationSupportMigration({ environment }))
        .toThrow(ApplicationSupportMigrationError);
    }
  });

  test("moves the orphan OPRTE development fallback when it is the sole root", async () => {
    const { environment, paths } = await fixture();
    await mkdir(join(paths.developmentFallback, "profiles", "default", "codex-home"), {
      recursive: true,
    });
    await writeFile(
      join(paths.developmentFallback, "profiles", "default", "codex-home", "auth.json"),
      "fallback-credential-bytes",
    );

    expect(inspectApplicationSupportMigration(environment)).toEqual({
      kind: "legacyOnly",
      source: "kitchenDevelopment",
    });
    const startup = prepareApplicationSupportMigration({ environment });
    startup.prepareTargetRoot();
    expect(startup.hasControlPlaneDatabase()).toBe(false);
    expect(
      await readFile(join(paths.target, "profiles", "default", "codex-home", "auth.json"), "utf8"),
    ).toBe("fallback-credential-bytes");
    startup.activate();
    expect(inspectApplicationSupportMigration(environment)).toEqual({
      kind: "completedRetry",
      source: "kitchenDevelopment",
    });
  });

  test("migrates every historical production spelling into the exact OPRTE entry", async () => {
    const candidates = [
      ["historicalOprte", "oprte"],
      ["historicalOperateDevelopment", "operateDevelopment"],
      ["predecessor", "kitchen"],
    ] as const;

    for (const [pathKey, source] of candidates) {
      const { environment, paths } = await fixture();
      const sourceRoot = paths[pathKey];
      await mkdir(sourceRoot);
      await writeFile(join(sourceRoot, "identity.txt"), source);
      expect(inspectApplicationSupportMigration(environment)).toEqual({
        kind: "legacyOnly",
        source,
      });

      const startup = prepareApplicationSupportMigration({
        environment,
        isFileOpenByAnotherProcess: () => false,
      });
      startup.activate();
      expect(await readFile(join(paths.target, "identity.txt"), "utf8")).toBe(source);
      const entries = await readdir(paths.parent);
      expect(entries).toContain("OPRTE");
      if (pathKey === "historicalOprte") {
        const sourceBefore = await lstat(sourceRoot).catch(() => null);
        const targetAfter = await lstat(paths.target);
        const volumeAliasesCase = sourceBefore !== null
          && sourceBefore.dev === targetAfter.dev
          && sourceBefore.ino === targetAfter.ino;
        if (!volumeAliasesCase) {
          expect(entries).toContain("Oprte");
          expect((await lstat(paths.historicalOprte)).isFile()).toBe(true);
        }
      }
    }
  });

  test("uses an injected case-insensitive identity probe without name-only guessing", async () => {
    const { environment, paths } = await fixture();
    await mkdir(paths.historicalOprte);
    await writeFile(join(paths.historicalOprte, "identity.txt"), "historical");
    const probes: Array<readonly [string, string]> = [];
    const startup = prepareApplicationSupportMigration({
      environment,
      isFileOpenByAnotherProcess: () => false,
      caseInsensitivePathAlias: (path, target) => {
        probes.push([path, target]);
        return true;
      },
    });
    startup.activate();

    expect(await readFile(join(paths.target, "identity.txt"), "utf8")).toBe("historical");
    expect(probes).toContainEqual([paths.historicalOprte, paths.target]);
    const entries = await readdir(paths.parent);
    expect(entries).toContain("OPRTE");
    expect(entries).not.toContain("Oprte");
  });

  test("adopts interrupted v1 receipts from both historical source-enum generations", async () => {
    for (const source of [
      "oprte",
      "operateDevelopment",
      "kitchen",
      "kitchenDevelopment",
    ] as const) {
      const { environment, paths } = await fixture();
      await mkdir(paths.legacyV1Stage);
      await writeFile(join(paths.legacyV1Stage, "v1-state.txt"), source);
      await writeFile(paths.legacyV1Receipt, `${JSON.stringify({
        version: 1,
        kind: "hraness-kitchen-application-support-migration",
        source,
        phase: "staged",
      })}\n`);

      expect(inspectApplicationSupportMigration(environment)).toEqual({
        kind: "legacyOnly",
        source: "v1Stage",
      });
      const startup = prepareApplicationSupportMigration({
        environment,
        isFileOpenByAnotherProcess: () => false,
      });
      startup.activate();
      expect(await readFile(join(paths.target, "v1-state.txt"), "utf8")).toBe(source);
    }
  });

  test("treats case-folded legacy spellings with one file identity as one root", async () => {
    const { environment, paths } = await fixture();
    await Promise.all([
      mkdir(paths.legacy),
      mkdir(paths.developmentFallback),
    ]);
    const [legacyMetadata, developmentMetadata] = await Promise.all([
      lstat(paths.legacy),
      lstat(paths.developmentFallback),
    ]);
    expect({
      dev: legacyMetadata.dev,
      ino: legacyMetadata.ino,
    }).not.toEqual({
      dev: developmentMetadata.dev,
      ino: developmentMetadata.ino,
    });

    const comparedIdentities: Array<readonly [number, number, number, number]> = [];
    expect(inspectApplicationSupportMigration(environment, {
      sameLegacyRootIdentity: (left, right) => {
        comparedIdentities.push([left.dev, left.ino, right.dev, right.ino]);
        return true;
      },
    })).toEqual({
      kind: "legacyOnly",
      source: "hranessKitchen",
    });
    expect(comparedIdentities).toEqual([[
      legacyMetadata.dev,
      legacyMetadata.ino,
      developmentMetadata.dev,
      developmentMetadata.ino,
    ]]);
  });

  test("never merges two legacy roots or a legacy and target root", async () => {
    for (const combination of ["twoLegacy", "legacyAndTarget"] as const) {
      const { environment, paths } = await fixture();
      await mkdir(paths.legacy);
      if (combination === "twoLegacy") {
        await mkdir(paths.developmentFallback);
        expect(inspectApplicationSupportMigration(environment)).toEqual({
          kind: "conflictingBoth",
          reason: "multipleLegacyRoots",
        });
      } else {
        await mkdir(paths.target);
        expect(inspectApplicationSupportMigration(environment)).toEqual({
          kind: "conflictingBoth",
          reason: "legacyAndTarget",
        });
      }
      expect(() => prepareApplicationSupportMigration({ environment })).toThrow(
        ApplicationSupportMigrationError,
      );
    }
  });

  test("rejects symlink, FIFO, and unrecognized regular-file roots", async () => {
    {
      const { environment, paths } = await fixture();
      await symlink(paths.parent, paths.legacy);
      expect(() => prepareApplicationSupportMigration({ environment })).toThrow(
        expect.objectContaining({ code: "unsafe_root" }),
      );
    }
    {
      const { environment, paths } = await fixture();
      const result = Bun.spawnSync(["mkfifo", paths.target]);
      expect(result.exitCode).toBe(0);
      expect(() => prepareApplicationSupportMigration({ environment })).toThrow(
        expect.objectContaining({ code: "unsafe_root" }),
      );
    }
    {
      const { environment, paths } = await fixture();
      await writeFile(paths.developmentFallback, "not-a-downgrade-guard");
      expect(() => prepareApplicationSupportMigration({ environment })).toThrow(
        expect.objectContaining({ code: "unsafe_root" }),
      );
    }
  });

  test("rejects nested symlink, FIFO, and socket entries before publication", async () => {
    {
      const { environment, paths } = await fixture();
      await mkdir(join(paths.legacy, "nested"), { recursive: true });
      await symlink(paths.parent, join(paths.legacy, "nested", "escape"));
      expect(() => prepareApplicationSupportMigration({ environment })).toThrow(
        expect.objectContaining({ code: "unsafe_root" }),
      );
    }
    {
      const { environment, paths } = await fixture();
      await mkdir(join(paths.legacy, "nested"), { recursive: true });
      const fifo = join(paths.legacy, "nested", "queue");
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
      expect(() => prepareApplicationSupportMigration({ environment })).toThrow(
        expect.objectContaining({ code: "unsafe_root" }),
      );
    }
    {
      const { environment, paths } = await fixture();
      await mkdir(join(paths.legacy, "nested"), { recursive: true });
      const socket = join(paths.legacy, "nested", "runtime.sock");
      const socketStagingParent = process.platform === "darwin" ? "/private/tmp" : tmpdir();
      const socketStagingRoot = await realpath(
        await mkdtemp(join(socketStagingParent, "hra-migration-socket-")),
      );
      temporaryDirectories.push(socketStagingRoot);
      const listeningSocket = join(socketStagingRoot, "s");
      const server = createServer();
      try {
        server.listen(listeningSocket);
        await once(server, "listening");
        await rename(listeningSocket, socket);
        expect(() => prepareApplicationSupportMigration({ environment })).toThrow(
          expect.objectContaining({ code: "unsafe_root" }),
        );
      } finally {
        if (server.listening) {
          const closed = once(server, "close");
          server.close();
          await closed;
        }
      }
    }
  });

  test("allows only the exact owned local-observation socket in the current target", async () => {
    {
      const { environment, paths } = await fixture();
      const endpointDirectory = join(paths.target, localObservationDirectoryName);
      const socket = join(endpointDirectory, localObservationSocketFileName);
      await mkdir(endpointDirectory, { recursive: true, mode: 0o700 });

      await withListeningSocketAt(socket, () => {
        expect(inspectApplicationSupportReadiness({ environment })).toEqual({
          kind: "ready",
        });
        const startup = prepareApplicationSupportMigration({ environment });
        expect(startup.initialState).toBe("targetOnly");
        startup.prepareTargetRoot();
        startup.activate();
      });
    }

    {
      const { home } = await fixture();
      const startup = prepareIsolatedDevelopmentApplicationSupport(home);
      startup.prepareTargetRoot();
      const endpointDirectory = join(
        startup.root,
        localObservationDirectoryName,
      );
      const socket = join(endpointDirectory, localObservationSocketFileName);
      await mkdir(endpointDirectory, { mode: 0o700 });

      await withListeningSocketAt(socket, () => {
        startup.prepareTargetRoot();
        startup.activate();
      });
    }
  });

  test("keeps the local-observation socket allowance out of legacy, stage, and other target entries", async () => {
    {
      const { environment, paths } = await fixture();
      const endpointDirectory = join(paths.legacy, localObservationDirectoryName);
      const socket = join(endpointDirectory, localObservationSocketFileName);
      await mkdir(endpointDirectory, { recursive: true, mode: 0o700 });
      await withListeningSocketAt(socket, () => {
        expect(() => prepareApplicationSupportMigration({ environment })).toThrow(
          expect.objectContaining({ code: "unsafe_root" }),
        );
      });
    }

    {
      const { environment, paths } = await fixture();
      await writeLegacyTree(paths.legacy);
      expect(() =>
        prepareApplicationSupportMigration({
          environment,
          isFileOpenByAnotherProcess: () => false,
          onCheckpoint: faultAt("afterSourceStaged"),
        })
      ).toThrow("fault:afterSourceStaged");
      const endpointDirectory = join(paths.stage, localObservationDirectoryName);
      const socket = join(endpointDirectory, localObservationSocketFileName);
      await mkdir(endpointDirectory, { mode: 0o700 });
      await withListeningSocketAt(socket, () => {
        expect(() =>
          prepareApplicationSupportMigration({
            environment,
            isFileOpenByAnotherProcess: () => false,
          })
        ).toThrow(expect.objectContaining({ code: "unsafe_root" }));
      });
    }

    {
      const { environment, paths } = await fixture();
      const endpointDirectory = join(paths.target, localObservationDirectoryName);
      const socket = join(endpointDirectory, "unexpected.sock");
      await mkdir(endpointDirectory, { recursive: true, mode: 0o700 });
      await withListeningSocketAt(socket, () => {
        expect(() => prepareApplicationSupportMigration({ environment })).toThrow(
          expect.objectContaining({ code: "unsafe_root" }),
        );
      });
    }

    {
      const { environment, paths } = await fixture();
      const endpointDirectory = join(paths.target, localObservationDirectoryName);
      const socket = join(endpointDirectory, localObservationSocketFileName);
      await mkdir(endpointDirectory, { recursive: true, mode: 0o700 });
      const outside = join(paths.parent, "linked-local-observation-socket");
      await writeFile(outside, "not a socket");
      await symlink(outside, socket);
      expect(() => prepareApplicationSupportMigration({ environment })).toThrow(
        expect.objectContaining({ code: "unsafe_root" }),
      );
    }

    {
      const { environment, paths } = await fixture();
      const endpointDirectory = join(paths.target, localObservationDirectoryName);
      const socket = join(endpointDirectory, localObservationSocketFileName);
      await mkdir(endpointDirectory, { recursive: true, mode: 0o700 });
      expect(Bun.spawnSync(["mkfifo", socket]).exitCode).toBe(0);
      expect(() => prepareApplicationSupportMigration({ environment })).toThrow(
        expect.objectContaining({ code: "unsafe_root" }),
      );
    }

    {
      const { environment, paths } = await fixture();
      const endpointDirectory = join(paths.target, localObservationDirectoryName);
      const socket = join(endpointDirectory, localObservationSocketFileName);
      await mkdir(endpointDirectory, { recursive: true, mode: 0o700 });
      await withListeningSocketAt(socket, async () => {
        await link(socket, join(endpointDirectory, "socket-alias"));
        expect(() => prepareApplicationSupportMigration({ environment })).toThrow(
          expect.objectContaining({ code: "unsafe_root" }),
        );
      });
    }

    {
      const { environment, paths } = await fixture();
      const endpointDirectory = join(paths.target, localObservationDirectoryName);
      const socket = join(endpointDirectory, localObservationSocketFileName);
      await mkdir(endpointDirectory, { recursive: true, mode: 0o700 });
      await withListeningSocketAt(socket, async () => {
        await chmod(socket, 0o640);
        expect(() => prepareApplicationSupportMigration({ environment })).toThrow(
          expect.objectContaining({ code: "unsafe_root" }),
        );
      });
    }

    {
      const { environment, paths } = await fixture();
      const endpointDirectory = join(paths.target, localObservationDirectoryName);
      const socket = join(endpointDirectory, localObservationSocketFileName);
      await mkdir(endpointDirectory, { recursive: true, mode: 0o700 });
      await withListeningSocketAt(socket, async () => {
        await chmod(endpointDirectory, 0o755);
        expect(() => prepareApplicationSupportMigration({ environment })).toThrow(
          expect.objectContaining({ code: "unsafe_root" }),
        );
      });
    }
  });

  test("preserves opaque checkout contents for every managed-worktree layout", async () => {
    for (const layout of managedWorktreeLayouts) {
      const { environment, paths } = await fixture();
      const laneName = `lane-${layout.label.replaceAll(" ", "-")}`;
      const lanesRoot = join(paths.legacy, ...layout.segments);
      const lane = join(lanesRoot, laneName);
      const nested = join(lane, "tracked", "dependencies");
      const outside = join(paths.parent, `repository-${laneName}`);
      const manifest = join(lanesRoot, ".oprte-manifests", `${laneName}.json`);
      await mkdir(nested, { recursive: true });
      await mkdir(join(lanesRoot, ".oprte-manifests"));
      await writeFile(outside, "target");
      await writeFile(manifest, '{"state":"ready"}\n');
      await symlink(outside, join(nested, "tracked-link"));

      const startup = prepareApplicationSupportMigration({ environment });
      expect(
        (await lstat(
          join(paths.target, ...layout.segments, laneName, "tracked", "dependencies", "tracked-link"),
        )).isSymbolicLink(),
      ).toBe(true);
      expect(await readFile(
        join(paths.target, ...layout.segments, ".oprte-manifests", `${laneName}.json`),
        "utf8",
      )).toBe('{"state":"ready"}\n');
      startup.activate();
    }
  });

  test("rejects symlinks at every managed-worktree ownership boundary", async () => {
    for (const layout of managedWorktreeLayouts) {
      for (const boundary of ["lanes-root", "lane-identity"] as const) {
        const { environment, paths } = await fixture();
        const lanesRoot = join(paths.legacy, ...layout.segments);
        const outside = join(
          paths.parent,
          `outside-${layout.label.replaceAll(" ", "-")}-${boundary}`,
        );
        await mkdir(outside);
        if (boundary === "lanes-root") {
          await mkdir(
            join(paths.legacy, ...layout.segments.slice(0, -1)),
            { recursive: true },
          );
          await symlink(outside, lanesRoot);
        } else {
          await mkdir(lanesRoot, { recursive: true });
          await symlink(outside, join(lanesRoot, "hostile-lane"));
        }

        expect(() => prepareApplicationSupportMigration({ environment })).toThrow(
          expect.objectContaining({ code: "unsafe_root" }),
        );
      }
    }
  });

  test("keeps managed-worktree manifest directories inside strict validation", async () => {
    for (const layout of managedWorktreeLayouts) {
      for (const manifestDirectory of [
        ".oprte-manifests",
        ".kitchen-manifests",
      ] as const) {
        const { environment, paths } = await fixture();
        const lanesRoot = join(paths.legacy, ...layout.segments);
        const outside = join(
          paths.parent,
          `outside-${layout.label.replaceAll(" ", "-")}-${manifestDirectory.slice(1)}`,
        );
        await mkdir(lanesRoot, { recursive: true });
        await mkdir(outside);
        await symlink(outside, join(lanesRoot, manifestDirectory));

        expect(() => prepareApplicationSupportMigration({ environment })).toThrow(
          expect.objectContaining({ code: "unsafe_root" }),
        );
      }
    }
  });

  test("rejects symlinked dispatch worktree ancestors", async () => {
    for (const symlinkedPart of ["dispatch", "worktrees", "lane"] as const) {
      const { environment, paths } = await fixture();
      const outside = join(paths.parent, `outside-${symlinkedPart}`);
      await mkdir(outside);
      await mkdir(paths.legacy);
      if (symlinkedPart === "dispatch") {
        await symlink(outside, join(paths.legacy, "dispatch"));
      } else {
        await mkdir(join(paths.legacy, "dispatch"));
        if (symlinkedPart === "worktrees") {
          await symlink(outside, join(paths.legacy, "dispatch", "worktrees"));
        } else {
          await mkdir(join(paths.legacy, "dispatch", "worktrees"));
          await symlink(
            outside,
            join(paths.legacy, "dispatch", "worktrees", "run_12345678"),
          );
        }
      }
      expect(() => prepareApplicationSupportMigration({ environment })).toThrow(
        expect.objectContaining({ code: "unsafe_root" }),
      );
    }
  });

  test("requires a private 32-byte operation-receipt key", async () => {
    for (const byteLength of [0, 31, 33]) {
      const { environment, paths } = await fixture();
      await mkdir(paths.legacy);
      await writeFile(
        join(paths.legacy, "operation-receipts.hmac.key"),
        new Uint8Array(byteLength),
      );
      expect(() => prepareApplicationSupportMigration({ environment })).toThrow(
        expect.objectContaining({ code: "invalid_state" }),
      );
    }

    {
      const { environment, paths } = await fixture();
      await mkdir(paths.legacy);
      const key = join(paths.legacy, "operation-receipts.hmac.key");
      await writeFile(key, new Uint8Array(32));
      await link(key, join(paths.legacy, "operation-receipts.hmac.key.alias"));
      expect(() => prepareApplicationSupportMigration({ environment })).toThrow(
        expect.objectContaining({ code: "unsafe_root" }),
      );
    }
  });

  test("rejects receipt rows without their installation key and orphan SQLite sidecars", async () => {
    {
      const { environment, paths } = await fixture();
      await writeLegacyTree(paths.legacy);
      await rm(join(paths.legacy, "operation-receipts.hmac.key"));
      expect(() => prepareApplicationSupportMigration({ environment })).toThrow(
        expect.objectContaining({ code: "invalid_state" }),
      );
    }

    for (const suffix of ["-wal", "-shm"]) {
      const { environment, paths } = await fixture();
      await mkdir(paths.legacy);
      await writeFile(join(paths.legacy, `control-plane.sqlite${suffix}`), "orphan");
      expect(() => prepareApplicationSupportMigration({ environment })).toThrow(
        expect.objectContaining({ code: "invalid_state" }),
      );
    }
  });

  test("does not follow HOME, Library, or Application Support symlinks", async () => {
    {
      const root = await mkdtemp(join(tmpdir(), "oprte-ancestor-"));
      temporaryDirectories.push(root);
      const realHome = join(root, "real-home");
      const linkedHome = join(root, "linked-home");
      await mkdir(realHome);
      await symlink(realHome, linkedHome);
      expect(() =>
        prepareApplicationSupportMigration({ environment: { HOME: linkedHome } }),
      ).toThrow(expect.objectContaining({ code: "unsafe_root" }));
    }
    {
      const root = await mkdtemp(join(tmpdir(), "oprte-ancestor-"));
      temporaryDirectories.push(root);
      const home = join(root, "home");
      const outside = join(root, "outside");
      await mkdir(home);
      await mkdir(outside);
      await symlink(outside, join(home, "Library"));
      expect(() =>
        prepareApplicationSupportMigration({ environment: { HOME: home } }),
      ).toThrow(expect.objectContaining({ code: "unsafe_root" }));
    }
    {
      const root = await mkdtemp(join(tmpdir(), "oprte-ancestor-"));
      temporaryDirectories.push(root);
      const home = join(root, "home");
      const library = join(home, "Library");
      const outside = join(root, "outside");
      await mkdir(library, { recursive: true });
      await mkdir(outside);
      await symlink(outside, join(library, "Application Support"));
      expect(() =>
        prepareApplicationSupportMigration({ environment: { HOME: home } }),
      ).toThrow(expect.objectContaining({ code: "unsafe_root" }));
    }
  });

  test("holds one exclusive migration cutover across gateway startup", async () => {
    const { environment, paths } = await fixture();
    const startup = prepareApplicationSupportMigration({ environment });
    expect(() => prepareApplicationSupportMigration({ environment })).toThrow(
      expect.objectContaining({ code: "migration_locked" }),
    );

    await mkdir(paths.target);
    startup.activate();
    const retry = prepareApplicationSupportMigration({ environment });
    retry.activate();
  });

  test("excludes another process and releases the migration lock after SIGKILL", async () => {
    const { environment } = await fixture();
    const moduleUrl = new URL(
      "../src/state/application-support.ts",
      import.meta.url,
    ).href;
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
          import { prepareApplicationSupportMigration } from ${JSON.stringify(moduleUrl)};
          const startup = prepareApplicationSupportMigration();
          globalThis.applicationSupportStartup = startup;
          console.log("migration-lock-held");
          await new Promise(() => undefined);
        `,
      ],
      {
        env: {
          ...process.env,
          ...environment,
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const reader = child.stdout.getReader();
    try {
      const ready = await Promise.race([
        reader.read(),
        Bun.sleep(5_000).then(() => {
          throw new Error("Timed out waiting for the child migration lock");
        }),
      ]);
      if (ready.done || !new TextDecoder().decode(ready.value).includes("migration-lock-held")) {
        child.kill("SIGKILL");
        await child.exited;
        const stderr = await new Response(child.stderr).text();
        throw new Error(`Child migration lock failed before readiness: ${stderr}`);
      }

      expect(() => prepareApplicationSupportMigration({ environment })).toThrow(
        expect.objectContaining({ code: "migration_locked" }),
      );

      child.kill("SIGKILL");
      await child.exited;

      const retry = prepareApplicationSupportMigration({ environment });
      expect(retry.rollbackBeforeActivation()).toBe(false);
    } finally {
      reader.releaseLock();
      child.kill("SIGKILL");
      await child.exited;
    }
  }, 10_000);

  test("refuses to move a live legacy SQLite authority", async () => {
    const { environment, paths } = await fixture();
    await writeLegacyTree(paths.legacy);
    const liveDatabase = new Database(join(paths.legacy, "control-plane.sqlite"), {
      strict: true,
    });
    liveDatabase.exec("BEGIN");
    liveDatabase.query("SELECT value FROM migration_fixture").get();
    try {
      expect(() => prepareApplicationSupportMigration({ environment })).toThrow(
        expect.objectContaining({ code: "legacy_state_in_use" }),
      );
    } finally {
      liveDatabase.exec("ROLLBACK");
      liveDatabase.close();
    }

    const startup = prepareApplicationSupportMigration({
      environment,
      isFileOpenByAnotherProcess: () => false,
    });
    expectLegacyDatabase(join(paths.target, "control-plane.sqlite"));
    startup.activate();
  });

  test("uses the injectable open-file gate on portable hosts", async () => {
    const { environment, paths } = await fixture();
    await writeLegacyTree(paths.legacy);
    const inspected: string[] = [];
    expect(() =>
      prepareApplicationSupportMigration({
        environment,
        isFileOpenByAnotherProcess: (path) => {
          inspected.push(path);
          return true;
        },
      }),
    ).toThrow(expect.objectContaining({ code: "legacy_state_in_use" }));
    expect(inspected).toEqual([join(paths.legacy, "control-plane.sqlite")]);
  });

  test("restores the legacy root when its database opens during the exchange", async () => {
    const { environment, paths } = await fixture();
    await writeLegacyTree(paths.legacy);
    const observedPaths: string[] = [];

    expect(() =>
      prepareApplicationSupportMigration({
        environment,
        isFileOpenByAnotherProcess: (path) => {
          observedPaths.push(path);
          return path === join(paths.stage, "control-plane.sqlite");
        },
      }),
    ).toThrow(expect.objectContaining({ code: "legacy_state_in_use" }));

    expect(observedPaths).toContain(join(paths.legacy, "control-plane.sqlite"));
    expect(observedPaths).toContain(join(paths.stage, "control-plane.sqlite"));
    expectLegacyDatabase(join(paths.legacy, "control-plane.sqlite"));
    expect((await lstat(paths.legacy)).isDirectory()).toBe(true);
    expect((await lstat(paths.stage)).isFile()).toBe(true);
    expect(await lstat(paths.target).catch(() => null)).toBeNull();

    const retry = prepareApplicationSupportMigration({
      environment,
      isFileOpenByAnotherProcess: () => false,
    });
    retry.prepareTargetRoot();
    retry.activate();
    expectLegacyDatabase(join(paths.target, "control-plane.sqlite"));
  });

  test("macOS refuses an idle legacy process with an open database descriptor", async () => {
    if (process.platform !== "darwin") return;
    const { environment, paths } = await fixture();
    await writeLegacyTree(paths.legacy);
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
          import { Database } from "bun:sqlite";
          const database = new Database(process.env.MIGRATION_FIXTURE_DATABASE, {
            strict: true,
          });
          database.query("SELECT value FROM migration_fixture").get();
          console.log("ready");
          await new Promise(() => undefined);
        `,
      ],
      {
        env: {
          ...process.env,
          MIGRATION_FIXTURE_DATABASE: join(paths.legacy, "control-plane.sqlite"),
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const reader = child.stdout.getReader();
    try {
      const ready = await reader.read();
      expect(new TextDecoder().decode(ready.value)).toContain("ready");
      expect(() => prepareApplicationSupportMigration({ environment })).toThrow(
        expect.objectContaining({ code: "legacy_state_in_use" }),
      );
    } finally {
      reader.releaseLock();
      child.kill("SIGKILL");
      await child.exited;
    }
  });

  test("parses persisted receipts from unknown and rejects malformed or unbounded data", async () => {
    for (const value of [
      "{",
      JSON.stringify({
        version: 1,
        kind: "hraness-kitchen-application-support-migration",
        source: "hranessKitchen",
        phase: "published",
        unexpected: true,
      }),
      "x".repeat(1_025),
    ]) {
      const { environment, paths } = await fixture();
      await mkdir(paths.target);
      await writeFile(paths.receipt, value);
      expect(() => inspectApplicationSupportMigration(environment)).toThrow(
        expect.objectContaining({ code: "invalid_metadata" }),
      );
    }
  });

  test("resumes idempotently after every publication checkpoint", async () => {
    const points = [
      "afterPreparedReceipt",
      "afterExchangeGuardPrepared",
      "afterSourceExchanged",
      "afterSourceStaged",
      "afterStagedReceipt",
      "afterTargetPublished",
      "afterPublishedReceipt",
    ] as const satisfies readonly ApplicationSupportMigrationFaultPoint[];

    for (const point of points) {
      const { environment, paths } = await fixture();
      await writeLegacyTree(paths.legacy);
      expect(() =>
        prepareApplicationSupportMigration({
          environment,
          isFileOpenByAnotherProcess: () => false,
          onCheckpoint: faultAt(point),
        }),
      ).toThrow(`fault:${point}`);

      expect(inspectApplicationSupportMigration(environment).kind).toBe("interruptedRetry");
      const retry = prepareApplicationSupportMigration({
        environment,
        isFileOpenByAnotherProcess: () => false,
      });
      expect(retry.initialState).toBe("interruptedRetry");
      retry.activate();
      expect(inspectApplicationSupportMigration(environment)).toEqual({
        kind: "completedRetry",
        source: "hranessKitchen",
      });
      expectLegacyDatabase(join(paths.target, "control-plane.sqlite"));
    }
  });

  test("repairs interrupted activation without reopening either old root", async () => {
    const { environment, paths } = await fixture();
    await writeLegacyTree(paths.legacy);
    const startup = prepareApplicationSupportMigration({
      environment,
      isFileOpenByAnotherProcess: () => false,
      onCheckpoint: faultAt("afterLegacyOprteDowngradeGuard"),
    });
    expect(() =>
      startup.activate(),
    ).toThrow("fault:afterLegacyOprteDowngradeGuard");
    expect(() =>
      prepareApplicationSupportMigration({
        environment,
        isFileOpenByAnotherProcess: () => false,
      }),
    ).toThrow(expect.objectContaining({ code: "migration_locked" }));
    startup.preserveForwardOnlyForRetry();

    const retry = prepareApplicationSupportMigration({
      environment,
      isFileOpenByAnotherProcess: () => false,
    });
    retry.activate();
    expect((await lstat(paths.legacy)).isFile()).toBe(true);
    expect((await lstat(paths.developmentFallback)).isFile()).toBe(true);
    expect(inspectApplicationSupportMigration(environment).kind).toBe("completedRetry");
  });

  test("an activated receipt prevents rollback even if the process faults after publication", async () => {
    const { environment, paths } = await fixture();
    await writeLegacyTree(paths.legacy);
    const startup = prepareApplicationSupportMigration({
      environment,
      isFileOpenByAnotherProcess: () => false,
      onCheckpoint: faultAt("afterActivatedReceipt"),
    });
    expect(() => startup.activate()).toThrow("fault:afterActivatedReceipt");
    expect(() =>
      prepareApplicationSupportMigration({
        environment,
        isFileOpenByAnotherProcess: () => false,
      }),
    ).toThrow(expect.objectContaining({ code: "migration_locked" }));
    expect(startup.rollbackBeforeActivation()).toBe(false);
    expect(inspectApplicationSupportMigration(environment).kind).toBe("completedRetry");
    expectLegacyDatabase(join(paths.target, "control-plane.sqlite"));
  });

  test("releases forward-only published and activated cutovers for retry", async () => {
    {
      const { environment, paths } = await fixture();
      await writeLegacyTree(paths.legacy);
      const startup = prepareApplicationSupportMigration({
        environment,
        isFileOpenByAnotherProcess: () => false,
      });

      expect(() =>
        prepareApplicationSupportMigration({
          environment,
          isFileOpenByAnotherProcess: () => false,
        }),
      ).toThrow(expect.objectContaining({ code: "migration_locked" }));
      startup.preserveForwardOnlyForRetry();
      expect(inspectApplicationSupportMigration(environment)).toEqual({
        kind: "interruptedRetry",
        phase: "published",
        source: "hranessKitchen",
      });

      const retry = prepareApplicationSupportMigration({
        environment,
        isFileOpenByAnotherProcess: () => false,
      });
      retry.activate();
    }

    {
      const { environment, paths } = await fixture();
      await writeLegacyTree(paths.legacy);
      const startup = prepareApplicationSupportMigration({
        environment,
        isFileOpenByAnotherProcess: () => false,
        onCheckpoint: faultAt("afterActivatedReceipt"),
      });
      expect(() => startup.activate()).toThrow("fault:afterActivatedReceipt");
      expect(() =>
        prepareApplicationSupportMigration({
          environment,
          isFileOpenByAnotherProcess: () => false,
        }),
      ).toThrow(expect.objectContaining({ code: "migration_locked" }));

      startup.preserveForwardOnlyForRetry();
      expect(startup.activated).toBe(true);
      expect(inspectApplicationSupportMigration(environment)).toEqual({
        kind: "completedRetry",
        source: "hranessKitchen",
      });
    }
  });

  test("rolls startup mutations back to the original root before activation", async () => {
    const { environment, paths } = await fixture();
    await writeLegacyTree(paths.legacy);
    const startup = prepareApplicationSupportMigration({
      environment,
      isFileOpenByAnotherProcess: () => false,
    });
    await writeFile(join(paths.target, "startup-created-state"), "preserved on rollback");

    expect(startup.rollbackBeforeActivation()).toBe(true);
    expect(await lstat(paths.target).catch(() => null)).toBeNull();
    expect(await lstat(paths.receipt).catch(() => null)).toBeNull();
    expect(await readFile(join(paths.legacy, "startup-created-state"), "utf8")).toBe(
      "preserved on rollback",
    );
    expect(inspectApplicationSupportMigration(environment)).toEqual({
      kind: "legacyOnly",
      source: "hranessKitchen",
    });
  });

  test("recovers deterministically from either rollback rename checkpoint", async () => {
    for (const point of [
      "afterTargetRestagedForRollback",
      "afterSourceRestored",
    ] as const satisfies readonly ApplicationSupportMigrationFaultPoint[]) {
      const { environment, paths } = await fixture();
      await writeLegacyTree(paths.legacy);
      const startup = prepareApplicationSupportMigration({
        environment,
        isFileOpenByAnotherProcess: () => false,
        onCheckpoint: faultAt(point),
      });
      expect(() => startup.rollbackBeforeActivation()).toThrow(`fault:${point}`);

      const retry = prepareApplicationSupportMigration({
        environment,
        isFileOpenByAnotherProcess: () => false,
      });
      retry.activate();
      expect(inspectApplicationSupportMigration(environment).kind).toBe("completedRetry");
      expectLegacyDatabase(join(paths.target, "control-plane.sqlite"));
    }
  });
});
