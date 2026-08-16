import {
  afterEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runStartupLocalDataRemovalRecovery,
  startupLocalDataRemovalRecoveryRequested,
} from "../src/maintenance/local-data-removal-recovery";
import {
  fixedLocalDataRemovalPaths,
} from "../src/maintenance/local-data-removal-inventory";

const temporaryDirectories: string[] = [];
const RECOVERY_AUTHORITY = {
  nativeRemovalCapability: "cd".repeat(32),
  secrets: {
    delete: () => Promise.resolve(true),
  },
} as const;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) =>
      await rm(path, { recursive: true, force: true })
    ),
  );
});

async function recoveryFixture() {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "oprte-recovery-home-")),
  );
  temporaryDirectories.push(home);
  const fixed = fixedLocalDataRemovalPaths(home);
  await mkdir(fixed.applicationSupportParent, {
    recursive: true,
    mode: 0o700,
  });
  return { fixed, home };
}

describe("startup-only local-data removal recovery", () => {
  test("accepts only the exact recovery environment flag", () => {
    expect(startupLocalDataRemovalRecoveryRequested({
      HRA_STARTUP_REMOVAL_RECOVERY: "1",
    })).toBeTrue();
    expect(startupLocalDataRemovalRecoveryRequested({
      HRA_STARTUP_REMOVAL_RECOVERY: "true",
    })).toBeFalse();
    expect(startupLocalDataRemovalRecoveryRequested({})).toBeFalse();
  });

  test("returns a strict pathless clear result without opening control-plane or Codex state", async () => {
    const fixture = await recoveryFixture();
    await mkdir(fixture.fixed.applicationSupportRoot, {
      recursive: true,
      mode: 0o700,
    });
    const databaseSentinel = fixture.fixed.controlPlanePath;
    const codexSentinel = join(
      fixture.fixed.applicationSupportRoot,
      "codex",
      "must-not-open",
    );
    await mkdir(join(
      fixture.fixed.applicationSupportRoot,
      "codex",
    ), { recursive: true, mode: 0o700 });
    await writeFile(databaseSentinel, "not-a-database");
    await writeFile(codexSentinel, "not-codex-state");

    const result = await runStartupLocalDataRemovalRecovery({
      ...RECOVERY_AUTHORITY,
      effectiveHome: fixture.home,
      nativeRecoveryPrepared: true,
      parentProcessId: 44_001,
    });

    expect(result).toEqual({
      kind: "localDataRemovalRecoveryResult",
      version: 1,
      state: "clear",
      recoveredOperationCount: 0,
    });
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain(fixture.home);
    expect(encoded).not.toContain("control-plane");
    expect(await readFile(databaseSentinel, "utf8")).toBe(
      "not-a-database",
    );
    expect(await readFile(codexSentinel, "utf8")).toBe(
      "not-codex-state",
    );
  });

  test("rejects an unprepared direct invocation without touching recovery state", async () => {
    const fixture = await recoveryFixture();
    await mkdir(fixture.fixed.helperStateRoot, {
      mode: 0o700,
    });
    const exclusion = join(
      fixture.fixed.applicationSupportParent,
      ".OPRTE Removal.removal-in-progress",
    );
    await mkdir(exclusion, { mode: 0o700 });
    expect(runStartupLocalDataRemovalRecovery({
      ...RECOVERY_AUTHORITY,
      effectiveHome: fixture.home,
      nativeRecoveryPrepared: false,
      parentProcessId: 44_002,
    })).rejects.toThrow("not prepared");
    expect((await lstat(fixture.fixed.helperStateRoot)).isDirectory())
      .toBeTrue();
    expect((await lstat(exclusion)).isDirectory()).toBeTrue();
  });

  test("fails closed when Native preparation leaves a known tombstone", async () => {
    const fixture = await recoveryFixture();
    const knownTombstone = join(
      fixture.fixed.applicationSupportParent,
      ".OPRTE Removal.removing-op_recovery01",
    );
    await mkdir(knownTombstone, { mode: 0o700 });
    await mkdir(join(
      fixture.fixed.applicationSupportParent,
      ".OPRTE Removal.removing-not-an-operation",
    ), { mode: 0o700 });
    expect(runStartupLocalDataRemovalRecovery({
      ...RECOVERY_AUTHORITY,
      effectiveHome: fixture.home,
      nativeRecoveryPrepared: true,
      parentProcessId: 44_003,
    })).rejects.toThrow("preparation is incomplete");
    expect((await lstat(knownTombstone)).isDirectory()).toBeTrue();
  });

  test("never reports clear while Native-owned helper state or its exclusion remains", async () => {
    const fixture = await recoveryFixture();
    await mkdir(fixture.fixed.helperStateRoot, { mode: 0o700 });
    const exclusion = join(
      fixture.fixed.applicationSupportParent,
      ".OPRTE Removal.removal-in-progress",
    );
    await mkdir(exclusion, { mode: 0o700 });

    expect(runStartupLocalDataRemovalRecovery({
      ...RECOVERY_AUTHORITY,
      effectiveHome: fixture.home,
      nativeRecoveryPrepared: true,
      parentProcessId: 44_004,
    })).rejects.toThrow("unclaimed helper state");
    expect((await lstat(fixture.fixed.helperStateRoot)).isDirectory())
      .toBeTrue();
    expect((await lstat(exclusion)).isDirectory()).toBeTrue();

    await rm(fixture.fixed.helperStateRoot, { recursive: true });
    expect(runStartupLocalDataRemovalRecovery({
      ...RECOVERY_AUTHORITY,
      effectiveHome: fixture.home,
      nativeRecoveryPrepared: true,
      parentProcessId: 44_004,
    })).rejects.toThrow("startup exclusion active");
    expect((await lstat(exclusion)).isDirectory()).toBeTrue();
  });

  test("fails closed on a malformed pending gateway receipt", async () => {
    const fixture = await recoveryFixture();
    await mkdir(join(
      fixture.fixed.helperStateRoot,
      "gateway-receipts",
    ), { recursive: true, mode: 0o700 });
    await writeFile(
      join(
        fixture.fixed.helperStateRoot,
        "gateway-receipts",
        "op_malformed01.json",
      ),
      "{not-json",
      { mode: 0o600 },
    );
    expect(runStartupLocalDataRemovalRecovery({
      ...RECOVERY_AUTHORITY,
      effectiveHome: fixture.home,
      nativeRecoveryPrepared: true,
      parentProcessId: 44_005,
    })).rejects.toThrow();
  });
});
