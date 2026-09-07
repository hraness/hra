import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireClaudeLiveAcceptanceOwner, type ClaudeLiveAcceptanceOwner } from "./claude-live-acceptance-owner";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const operation of cleanup.splice(0).reverse()) await operation(); });

const fixture = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hra-claude-owner-")));
  const runId = randomUUID();
  const receiptPath = join(root, `.hra-live-claude-acceptance-${runId}.recovery.json`);
  const lockPath = join(root, `.hra-live-claude-acceptance-${runId}.lock`);
  const owners: ClaudeLiveAcceptanceOwner[] = [];
  cleanup.push(async () => {
    for (const owner of owners) await owner.releasePreserving().catch(() => undefined);
    await rm(root, { recursive: true });
  });
  const input = { runId, receiptPath };
  return { root, input, lockPath, acquire: async () => {
    const owner = await acquireClaudeLiveAcceptanceOwner(input); owners.push(owner); return owner;
  } };
};

const childAttempt = (input: Readonly<{ runId: string; receiptPath: string }>): string => {
  const modulePath = new URL("./claude-live-acceptance-owner.ts", import.meta.url).href;
  const program = `import {acquireClaudeLiveAcceptanceOwner} from ${JSON.stringify(modulePath)};
try { const owner=await acquireClaudeLiveAcceptanceOwner(${JSON.stringify(input)});
await owner.releasePreserving(); process.stdout.write("acquired"); }
catch(error) { if(error?.code!=="concurrent_owner") process.exit(2); process.stdout.write("refused"); }`;
  const child = spawnSync(process.execPath, ["--eval", program], { encoding: "utf8", maxBuffer: 1024, timeout: 5000 });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(child.signal).toBeNull();
  expect(child.stderr).toBe("");
  return child.stdout;
};

describe("exact Claude acceptance invocation owner", () => {
  test("holds native ownership across processes, preserves the name, and permits recovery reacquisition", async () => {
    const f = await fixture();
    const owner = await f.acquire();
    expect(() => owner.assertCurrent()).not.toThrow();
    const before = await lstat(f.lockPath);
    expect(before.mode & 0o7777).toBe(0o600);
    expect(before.size).toBe(0);
    await expect(f.acquire()).rejects.toMatchObject({ code: "concurrent_owner" });
    expect(childAttempt(f.input)).toBe("refused");
    expect((await lstat(f.lockPath)).ino).toBe(before.ino);
    await owner.releasePreserving();
    expect(childAttempt(f.input)).toBe("acquired");
    expect((await lstat(f.lockPath)).ino).toBe(before.ino);
    const recovered = await f.acquire();
    await recovered.removeAndRelease();
    expect(() => recovered.assertCurrent()).toThrow("claude_live_acceptance_owner_closed");
    await expect(lstat(f.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(recovered.releasePreserving()).rejects.toMatchObject({ code: "closed" });
  });

  test("will not remove a lock while any authoritative receipt entry remains", async () => {
    const f = await fixture();
    await writeFile(f.input.receiptPath, "private recovery state", { mode: 0o600 });
    const owner = await f.acquire();
    const before = await lstat(f.lockPath);
    await expect(owner.removeAndRelease()).rejects.toMatchObject({ code: "receipt_present" });
    expect(await readFile(f.input.receiptPath, "utf8")).toBe("private recovery state");
    expect((await lstat(f.lockPath)).ino).toBe(before.ino);
    expect(childAttempt(f.input)).toBe("acquired");
  });

  test("refuses substituted lock inode without deleting the replacement", async () => {
    const f = await fixture();
    const owner = await f.acquire();
    const moved = join(f.root, "moved-lock");
    await rename(f.lockPath, moved);
    await writeFile(f.lockPath, "", { mode: 0o600 });
    const replacement = await lstat(f.lockPath);
    expect(() => owner.assertCurrent()).toThrow("claude_live_acceptance_owner_custody_refused");
    await expect(owner.removeAndRelease()).rejects.toMatchObject({ code: "custody_refused" });
    expect((await lstat(f.lockPath)).ino).toBe(replacement.ino);
    expect(await readFile(moved, "utf8")).toBe("");
  });

  test("refuses replaced parent even if the exact lock inode is moved back", async () => {
    const f = await fixture();
    const parent = join(f.root, "parent");
    const moved = join(f.root, "old-parent");
    await mkdir(parent, { mode: 0o700 });
    const input = { ...f.input, receiptPath: join(parent, f.input.receiptPath.split("/").at(-1) ?? "") };
    const owner = await acquireClaudeLiveAcceptanceOwner(input);
    const lockName = f.lockPath.split("/").at(-1) ?? "";
    await rename(parent, moved); await mkdir(parent, { mode: 0o700 });
    await rename(join(moved, lockName), join(parent, lockName));
    await expect(owner.removeAndRelease()).rejects.toMatchObject({ code: "custody_refused" });
    expect((await lstat(join(parent, lockName))).isFile()).toBe(true);
  });

  test.each(["mode", "hardlink", "symlink", "bytes", "directory"])("refuses %s lock material without replacing it", async (kind) => {
    const f = await fixture();
    if (kind === "directory") await mkdir(f.lockPath, { mode: 0o700 });
    else {
      await writeFile(f.lockPath, "", { mode: 0o600 });
      if (kind === "mode") await chmod(f.lockPath, 0o644);
      if (kind === "hardlink") await link(f.lockPath, join(f.root, "linked-lock"));
      if (kind === "bytes") await writeFile(f.lockPath, "retained foreign material");
      if (kind === "symlink") {
        const moved = join(f.root, "symlink-target");
        await rename(f.lockPath, moved); await symlink(moved, f.lockPath);
      }
    }
    const before = await lstat(f.lockPath);
    await expect(f.acquire()).rejects.toMatchObject({ code: "custody_refused" });
    expect((await lstat(f.lockPath)).ino).toBe(before.ino);
  });

  test("rejects extra, nonnormalized, wrong-run, and non-temporary scope before creating a lock", async () => {
    const f = await fixture();
    for (const input of [{ ...f.input, extra: true }, { ...f.input, runId: randomUUID() },
      { ...f.input, receiptPath: `${f.root}/../${f.root.split("/").at(-1) ?? ""}/${f.input.receiptPath.split("/").at(-1) ?? ""}` },
      { ...f.input, receiptPath: `/var/.hra-live-claude-acceptance-${f.input.runId}.recovery.json` }]) {
      await expect(acquireClaudeLiveAcceptanceOwner(input)).rejects.toMatchObject({ code: "scope_refused" });
    }
    await expect(lstat(f.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
