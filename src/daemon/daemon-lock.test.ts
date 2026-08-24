import { describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readdir, readFile, realpath, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeStatePaths, resolveStatePaths } from "../storage/paths";
import {
  DaemonAuthorityBusyError,
  DaemonAuthoritySafetyError,
  DaemonAuthorityFence,
  DaemonLock,
  daemonAuthorityDatabasePath,
  inspectDaemonAuthority,
  readDaemonAuthorityReceipt,
} from "./daemon-lock";

async function pathsFixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hra-lock-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  return paths;
}

async function authorityArtifacts(paths: Awaited<ReturnType<typeof pathsFixture>>) {
  const snapshotFile = async (path: string) => {
    try {
      const metadata = await lstat(path);
      return {
        device: metadata.dev,
        inode: metadata.ino,
        mode: metadata.mode & 0o777,
        size: metadata.size,
        modifiedAt: metadata.mtimeMs,
        contents: metadata.isFile() ? (await readFile(path)).toString("base64") : null,
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  return {
    entries: (await readdir(paths.runtime)).sort(),
    database: await snapshotFile(daemonAuthorityDatabasePath(paths)),
    receipt: await snapshotFile(paths.daemonLock),
  };
}

describe("DaemonLock", () => {
  test("inspects absent authority without creating any artifact", async () => {
    const paths = await pathsFixture();
    const before = await authorityArtifacts(paths);
    const inspection = await inspectDaemonAuthority(paths);
    expect(inspection).toEqual({
      state: "absent",
      database: { custody: "absent" },
      receipt: { custody: "absent" },
    });
    expect(await authorityArtifacts(paths)).toEqual(before);
    expect(JSON.stringify(inspection)).not.toContain(paths.runtime);
  });

  test("uses database authority as truth across held, releasing, and released states", async () => {
    const paths = await pathsFixture();
    const lock = await DaemonLock.acquire(paths, { state: "maintenance" });
    const heldArtifacts = await authorityArtifacts(paths);
    expect(await inspectDaemonAuthority(paths)).toEqual({
      state: "held",
      database: { custody: "safe", authority: "held" },
      receipt: { custody: "safe", state: "maintenance" },
    });
    expect(await authorityArtifacts(paths)).toEqual(heldArtifacts);

    await lock.publish({ state: "stopped" });
    expect(await inspectDaemonAuthority(paths)).toEqual({
      state: "releasing",
      database: { custody: "safe", authority: "held" },
      receipt: { custody: "safe", state: "stopped" },
    });

    await lock.release();
    const releasedArtifacts = await authorityArtifacts(paths);
    expect(await inspectDaemonAuthority(paths)).toEqual({
      state: "released",
      database: { custody: "safe", authority: "released" },
      receipt: { custody: "safe", state: "stopped" },
    });
    expect(await authorityArtifacts(paths)).toEqual(releasedArtifacts);
  });

  test("distinguishes recoverable stale receipt evidence from released terminal evidence", async () => {
    const paths = await pathsFixture();
    const lock = await DaemonLock.acquire(paths);
    await lock.publish({
      state: "ready",
      generation: 1,
      bootId: "boot_99999999999999999999999999999999",
    });
    await lock.release();
    const terminal = await readDaemonAuthorityReceipt(paths);
    if (terminal === null) throw new Error("Expected a terminal receipt fixture.");
    await writeFile(paths.daemonLock, `${JSON.stringify({ ...terminal, state: "ready" })}\n`);
    const staleArtifacts = await authorityArtifacts(paths);
    expect(await inspectDaemonAuthority(paths)).toEqual({
      state: "stale_recoverable",
      database: { custody: "safe", authority: "released" },
      receipt: { custody: "safe", state: "ready" },
    });
    expect(await authorityArtifacts(paths)).toEqual(staleArtifacts);

    await writeFile(paths.daemonLock, "{malformed receipt");
    const invalidArtifacts = await authorityArtifacts(paths);
    expect(await inspectDaemonAuthority(paths)).toEqual({
      state: "stale_recoverable",
      database: { custody: "safe", authority: "released" },
      receipt: { custody: "invalid" },
    });
    expect(await authorityArtifacts(paths)).toEqual(invalidArtifacts);
  });

  test("does not treat a live receipt as restart-safe after its named authority database disappears", async () => {
    const paths = await pathsFixture();
    const lock = await DaemonLock.acquire(paths);
    await lock.publish({
      bootId: `boot_${"1".repeat(32)}`,
      generation: 1,
      state: "ready",
    });
    await lock.release();
    const terminal = await readDaemonAuthorityReceipt(paths);
    if (terminal === null) throw new Error("Expected a daemon authority receipt fixture.");
    await writeFile(paths.daemonLock, `${JSON.stringify({ ...terminal, state: "ready" })}\n`);
    await unlink(daemonAuthorityDatabasePath(paths));
    const before = await authorityArtifacts(paths);

    expect(await inspectDaemonAuthority(paths)).toEqual({
      state: "indeterminate",
      database: { custody: "absent" },
      receipt: { custody: "safe", state: "ready" },
    });
    expect(await authorityArtifacts(paths)).toEqual(before);
  });

  test("keeps malformed receipt evidence indeterminate while database authority is held", async () => {
    const paths = await pathsFixture();
    const lock = await DaemonLock.acquire(paths, { state: "maintenance" });
    const originalReceipt = await readFile(paths.daemonLock);
    await writeFile(paths.daemonLock, "{malformed receipt");
    const before = await authorityArtifacts(paths);
    expect(await inspectDaemonAuthority(paths)).toEqual({
      state: "indeterminate",
      database: { custody: "safe", authority: "held" },
      receipt: { custody: "invalid" },
    });
    expect(await authorityArtifacts(paths)).toEqual(before);
    await writeFile(paths.daemonLock, originalReceipt);
    await lock.release();
  });

  test("reports unsafe receipt and database custody without mutating either artifact", async () => {
    const receiptPaths = await pathsFixture();
    const receiptLock = await DaemonLock.acquire(receiptPaths);
    await receiptLock.release();
    await chmod(receiptPaths.daemonLock, 0o640);
    const unsafeReceiptArtifacts = await authorityArtifacts(receiptPaths);
    expect(await inspectDaemonAuthority(receiptPaths)).toEqual({
      state: "unsafe_receipt",
      database: { custody: "safe", authority: "released" },
      receipt: { custody: "unsafe" },
    });
    expect(await authorityArtifacts(receiptPaths)).toEqual(unsafeReceiptArtifacts);

    const databasePaths = await pathsFixture();
    const databaseLock = await DaemonLock.acquire(databasePaths);
    await databaseLock.release();
    await chmod(daemonAuthorityDatabasePath(databasePaths), 0o640);
    const unsafeDatabaseArtifacts = await authorityArtifacts(databasePaths);
    expect(await inspectDaemonAuthority(databasePaths)).toEqual({
      state: "unsafe_database",
      database: { custody: "unsafe" },
      receipt: { custody: "safe", state: "stopped" },
    });
    expect(await authorityArtifacts(databasePaths)).toEqual(unsafeDatabaseArtifacts);
  });

  test("reports a stable invalid authority database without repair or mutation", async () => {
    const paths = await pathsFixture();
    const lock = await DaemonLock.acquire(paths);
    await lock.release();
    await writeFile(daemonAuthorityDatabasePath(paths), "not a sqlite database");
    const before = await authorityArtifacts(paths);
    expect(await inspectDaemonAuthority(paths)).toEqual({
      state: "invalid_database",
      database: { custody: "invalid" },
      receipt: { custody: "safe", state: "stopped" },
    });
    expect(await authorityArtifacts(paths)).toEqual(before);
  });

  test("admits exactly one live daemon owner", async () => {
    const paths = await pathsFixture();
    const first = await DaemonLock.acquire(paths);
    await expect(DaemonLock.acquire(paths)).rejects.toThrow("already owns");
    await first.release();
    const second = await DaemonLock.acquire(paths);
    await second.release();
  });

  test("recovers a well-formed lock whose process is gone", async () => {
    const paths = await pathsFixture();
    await writeFile(paths.daemonLock, JSON.stringify({ version: 1, pid: 999_999, nonce: crypto.randomUUID() }), { mode: 0o600 });
    const lock = await DaemonLock.acquire(paths);
    await lock.release();
  });

  test("stale receipt recovery has one OS-backed winner and never unnames it", async () => {
    const paths = await pathsFixture();
    await writeFile(paths.daemonLock, JSON.stringify({ version: 1, pid: 999_999, nonce: crypto.randomUUID() }), { mode: 0o600 });
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, async () => await DaemonLock.acquire(paths)));
    const winners = attempts.filter((attempt): attempt is PromiseFulfilledResult<DaemonLock> => attempt.status === "fulfilled");
    const losers = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(11);
    expect(losers.every((attempt) => attempt.reason instanceof DaemonAuthorityBusyError)).toBe(true);
    expect(await DaemonLock.isAuthorityHeld(paths)).toBe(true);
    const named = await readDaemonAuthorityReceipt(paths);
    expect(named?.nonce).toBe(winners[0]?.value.receipt.nonce);
    expect(JSON.parse(await readFile(paths.daemonLock, "utf8"))).toMatchObject({ version: 2, nonce: named?.nonce });
    await winners[0]?.value.release();
    expect(await DaemonLock.isAuthorityHeld(paths)).toBe(false);
  });

  test("classifies only SQLite busy during authority open as a live owner", async () => {
    const paths = await pathsFixture();
    const held = await DaemonLock.acquire(paths);
    await expect(DaemonLock.isAuthorityHeld(paths)).resolves.toBe(true);
    await held.release();
    await expect(DaemonLock.isAuthorityHeld(paths, {
      openDatabase: () => { throw new Error("database is locked"); },
    })).rejects.toThrow("invalid and requires manual recovery");
    await expect(DaemonLock.isAuthorityHeld(paths, {
      openDatabase: () => { throw new Error("database is corrupt"); },
    })).rejects.toThrow("invalid and requires manual recovery");
    const safetyFailure = new DaemonAuthoritySafetyError("database is locked after authority name changed");
    await expect(DaemonLock.isAuthorityHeld(paths, {
      openDatabase: () => { throw safetyFailure; },
    })).rejects.toBe(safetyFailure);
  });

  test("preserves an unsafe receipt error when SQLite authority is busy", async () => {
    const paths = await pathsFixture();
    const held = await DaemonLock.acquire(paths);
    await chmod(paths.daemonLock, 0o640);
    try {
      await expect(DaemonLock.acquire(paths)).rejects.toBeInstanceOf(DaemonAuthoritySafetyError);
      await expect(DaemonLock.acquire(paths)).rejects.toThrow("unsafe permissions");
    } finally {
      await chmod(paths.daemonLock, 0o600);
      await held.release();
    }
  });

  test("a crashed owner releases authority without path reclamation", async () => {
    const paths = await pathsFixture();
    const initialized = await DaemonLock.acquire(paths);
    await initialized.release();
    const script = [
      'import { Database } from "bun:sqlite";',
      "const database = new Database(process.argv[1], { create: false, strict: true });",
      'database.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");',
      'process.stdout.write("locked\\n");',
      "await new Promise(() => undefined);",
    ].join("");
    const child = Bun.spawn([process.execPath, "-e", script, daemonAuthorityDatabasePath(paths)], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("locked");
    await expect(DaemonLock.acquire(paths)).rejects.toBeInstanceOf(DaemonAuthorityBusyError);
    child.kill("SIGKILL");
    await child.exited;
    const recovered = await DaemonLock.acquire(paths);
    await recovered.release();
  });

  test("fails closed on an unsafe receipt path even after winning OS authority", async () => {
    const paths = await pathsFixture();
    const target = join(paths.runtime, "receipt-target");
    await writeFile(target, "stale", { mode: 0o600 });
    await symlink(target, paths.daemonLock);
    await expect(DaemonLock.acquire(paths)).rejects.toThrow("Unsafe daemon authority file");
    expect(await DaemonLock.isAuthorityHeld(paths)).toBe(false);
  });

  test("fails closed when the stable authority database becomes group-readable", async () => {
    const paths = await pathsFixture();
    const lock = await DaemonLock.acquire(paths);
    await lock.release();
    await chmod(daemonAuthorityDatabasePath(paths), 0o640);
    await expect(DaemonLock.acquire(paths)).rejects.toThrow("unsafe permissions");
  });

  test("a named authority replacement fences admission and cannot be overwritten on old release", async () => {
    const paths = await pathsFixture();
    const old = await DaemonLock.acquire(paths);
    const authorityPath = daemonAuthorityDatabasePath(paths);
    await rename(authorityPath, `${authorityPath}.displaced`);
    await writeFile(authorityPath, "", { mode: 0o600 });
    await expect(old.assertCurrent()).rejects.toThrow("changed while authority was held");
    await expect(old.release()).rejects.toThrow("release was incomplete");
    const replacement = await DaemonLock.acquire(paths);
    expect((await readDaemonAuthorityReceipt(paths))?.nonce).toBe(replacement.receipt.nonce);
    await replacement.release();
  });

  test("revalidates the named authority after probing the held transaction", async () => {
    const paths = await pathsFixture();
    const old = await DaemonLock.acquire(paths);
    const authorityPath = daemonAuthorityDatabasePath(paths);
    let replacement: DaemonLock | undefined;
    await expect(old.assertCurrent({
      afterTransactionProbe: async () => {
        await rename(authorityPath, `${authorityPath}.post-probe-displaced`);
        await writeFile(authorityPath, "", { mode: 0o600 });
        replacement = await DaemonLock.acquire(paths);
      },
    })).rejects.toThrow("changed while authority was held");
    await expect(old.release()).rejects.toThrow("release was incomplete");
    if (replacement === undefined) throw new Error("Replacement authority fixture was not created.");
    expect((await readDaemonAuthorityReceipt(paths))?.nonce).toBe(replacement.receipt.nonce);
    await replacement.release();
  });

  test("binds each publication to the exact previously published receipt inode", async () => {
    const paths = await pathsFixture();
    const lock = await DaemonLock.acquire(paths);
    const displaced = `${paths.daemonLock}.same-receipt-displaced`;
    await rename(paths.daemonLock, displaced);
    await writeFile(paths.daemonLock, `${JSON.stringify(lock.receipt)}\n`, { mode: 0o600 });
    await expect(lock.publish({ state: "stopping" })).rejects.toThrow(
      "receipt changed before publication began",
    );
    await unlink(paths.daemonLock);
    await rename(displaced, paths.daemonLock);
    await lock.release();
  });

  test("serializes concurrent publications in invocation order", async () => {
    const paths = await pathsFixture();
    const lock = await DaemonLock.acquire(paths, { now: 0 });
    const authority = {
      generation: 1,
      bootId: "boot_44444444444444444444444444444444",
    } as const;
    const inputs = Array.from({ length: 32 }, (_, index) => ({
      state: index % 2 === 0 ? "booting" as const : "stopping" as const,
      now: 100 - index,
      ...authority,
    }));
    const receipts = await Promise.all(inputs.map(async (input) => await lock.publish(input)));
    expect(receipts).toHaveLength(inputs.length);
    expect(receipts.every((receipt) => receipt.updatedAt === 100)).toBe(true);
    expect(receipts.map((receipt) => receipt.state)).toEqual(inputs.map((input) => input.state));
    expect(lock.receipt).toMatchObject({
      state: inputs.at(-1)?.state,
      updatedAt: 100,
      ...authority,
    });
    await lock.release({ now: 101 });
  });

  test("retries an atomic receipt publication between path validation and descriptor open", async () => {
    const paths = await pathsFixture();
    const lock = await DaemonLock.acquire(paths);
    let published = false;
    const receipt = await readDaemonAuthorityReceipt(paths, {
      afterNamedValidation: async () => {
        if (published) return;
        published = true;
        await lock.publish({
          state: "ready",
          generation: 1,
          bootId: "boot_55555555555555555555555555555555",
        });
      },
    });
    expect(published).toBe(true);
    expect(receipt).toMatchObject({
      state: "ready",
      generation: 1,
      bootId: "boot_55555555555555555555555555555555",
    });
    await lock.release();
  });

  test("retries an exact atomic receipt publication after opening the validated old inode", async () => {
    const paths = await pathsFixture();
    const lock = await DaemonLock.acquire(paths);
    let published = false;
    const receipt = await readDaemonAuthorityReceipt(paths, {
      afterDescriptorOpen: async () => {
        if (published) return;
        published = true;
        await lock.publish({
          state: "ready",
          generation: 2,
          bootId: "boot_66666666666666666666666666666666",
        });
      },
    });
    expect(published).toBe(true);
    expect(receipt).toMatchObject({
      nonce: lock.receipt.nonce,
      state: "ready",
      generation: 2,
      bootId: "boot_66666666666666666666666666666666",
    });
    await lock.release();
  });

  test("retries when an opened receipt is renamed away and replaced at its authority name", async () => {
    const paths = await pathsFixture();
    const lock = await DaemonLock.acquire(paths);
    const displaced = `${paths.daemonLock}.reader-displaced`;
    const replacement = {
      ...lock.receipt,
      pid: lock.receipt.pid + 1,
      nonce: crypto.randomUUID(),
    };
    let replaced = false;
    const receipt = await readDaemonAuthorityReceipt(paths, {
      afterDescriptorOpen: async () => {
        if (replaced) return;
        replaced = true;
        await rename(paths.daemonLock, displaced);
        await writeFile(paths.daemonLock, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
      },
    });
    expect(replaced).toBe(true);
    expect(receipt).toEqual(replacement);
    await unlink(paths.daemonLock);
    await rename(displaced, paths.daemonLock);
    await lock.release();
  });

  test("retries ready-to-stopping-to-stopped publications across validation and descriptor inspection", async () => {
    const paths = await pathsFixture();
    const lock = await DaemonLock.acquire(paths);
    const authority = {
      generation: 3,
      bootId: "boot_77777777777777777777777777777777",
    } as const;
    await lock.publish({ state: "ready", ...authority });
    let stoppingPublished = false;
    let stoppedPublished = false;
    const receipt = await readDaemonAuthorityReceipt(paths, {
      afterNamedValidation: async () => {
        if (stoppingPublished) return;
        stoppingPublished = true;
        await lock.publish({ state: "stopping", ...authority });
      },
      afterDescriptorOpen: async () => {
        if (stoppedPublished) return;
        stoppedPublished = true;
        await lock.publish({ state: "stopped", ...authority });
      },
    });
    expect(stoppingPublished).toBe(true);
    expect(stoppedPublished).toBe(true);
    expect(receipt).toMatchObject({
      nonce: lock.receipt.nonce,
      state: "stopped",
      ...authority,
    });
    await lock.release();
  });

  test("retries a terminal publication after reading the formerly current receipt inode", async () => {
    const paths = await pathsFixture();
    const lock = await DaemonLock.acquire(paths);
    const authority = {
      generation: 4,
      bootId: "boot_88888888888888888888888888888888",
    } as const;
    await lock.publish({ state: "ready", ...authority });
    let stoppedPublished = false;
    const receipt = await readDaemonAuthorityReceipt(paths, {
      afterDescriptorRead: async () => {
        if (stoppedPublished) return;
        stoppedPublished = true;
        await lock.publish({ state: "stopped", ...authority });
      },
    });
    expect(stoppedPublished).toBe(true);
    expect(receipt).toMatchObject({
      nonce: lock.receipt.nonce,
      state: "stopped",
      ...authority,
    });
    await lock.release();
  });

  test("fails closed when an opened receipt is unlinked without a safe named replacement", async () => {
    const paths = await pathsFixture();
    const lock = await DaemonLock.acquire(paths);
    let unlinked = false;
    const reading = readDaemonAuthorityReceipt(paths, {
      afterDescriptorOpen: async () => {
        if (unlinked) return;
        unlinked = true;
        await unlink(paths.daemonLock);
      },
    });
    await expect(reading).rejects.toBeInstanceOf(DaemonAuthoritySafetyError);
    await expect(reading).rejects.toThrow("no safe named replacement");
    expect(unlinked).toBe(true);
    await expect(lock.release()).rejects.toThrow("release was incomplete");
  });

  test("a closeable generation and boot fence rejects replacement lifetimes", async () => {
    const paths = await pathsFixture();
    const lock = await DaemonLock.acquire(paths);
    const firstAuthority = {
      generation: 7,
      bootId: "boot_11111111111111111111111111111111",
    } as const;
    await lock.publish({ state: "booting", ...firstAuthority });
    const fence = new DaemonAuthorityFence(lock, firstAuthority);
    await fence.assertCurrent();
    await lock.publish({ state: "ready", ...firstAuthority });
    await fence.assertCurrent();

    const nextAuthority = {
      generation: 8,
      bootId: "boot_22222222222222222222222222222222",
    } as const;
    await lock.publish({ state: "ready", ...nextAuthority });
    await expect(fence.assertCurrent()).rejects.toThrow("generation or boot ID changed");
    await lock.release();
  });

  test("closing a daemon effect fence synchronously stops post-await admission", async () => {
    const paths = await pathsFixture();
    const lock = await DaemonLock.acquire(paths);
    const effectAuthority = {
      generation: 9,
      bootId: "boot_33333333333333333333333333333333",
    } as const;
    await lock.publish({ state: "ready", ...effectAuthority });
    const fence = new DaemonAuthorityFence(lock, effectAuthority);
    const resumed = Promise.resolve().then(async () => await fence.assertCurrent());
    fence.close();
    await expect(resumed).rejects.toThrow("effect authority is closed");
    await expect(fence.assertCurrent()).rejects.toThrow("effect authority is closed");
    await lock.release();
  });
});
