import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeStatePaths, resolveStatePaths } from "../storage/paths";
import {
  DaemonAuthorityBusyError,
  DaemonAuthorityFence,
  DaemonLock,
  daemonAuthorityDatabasePath,
  readDaemonAuthorityReceipt,
} from "./daemon-lock";

async function pathsFixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hra-lock-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  return paths;
}

describe("DaemonLock", () => {
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
