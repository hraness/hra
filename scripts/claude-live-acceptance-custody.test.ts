import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { createProfileId, createSessionId } from "../src/domain/values";
import { protectedInteractionDetailDocumentSchema } from "../src/domain/interactions";
import { OOMPA_VERSION } from "../src/version";
import {
  assertClaudeLiveAcceptanceLayout as assertLayout,
  claudeLiveAcceptanceRecoveryReceiptSchema,
  consumeClaudeLiveAcceptanceProtectedInteractionFile as consumeProtectedInteractionFile,
  createClaudeLiveAcceptanceProtectedInteractionFile as createProtectedInteractionFile,
  parseClaudeLiveAcceptanceProcessArgvBytes as parseClaudeProcessArgvBytes,
  proveClaudeWorkerSignalDomain,
  claudeLiveAcceptanceRecoveryPolicy as recoveryPolicy,
  removeClaudeLiveAcceptancePrivateLayout as removePrivateLayout,
  type ClaudeLiveAcceptanceRecoveryReceipt,
} from "./claude-live-acceptance";
import { acquireClaudeLiveAcceptanceOwner } from "./claude-live-acceptance-owner";
import { AtomicPrivateJsonReceipt, observePrivateDirectory } from "./live-acceptance-private-custody";

const invalid = () => new Error("synthetic_custody_refused");

async function withDirectory(operation: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "oompa-claude-helper-test-"));
  await chmod(directory, 0o700);
  try { await operation(directory); }
  finally { await rm(directory, { force: false, recursive: true }); }
}

const protectedDocument = (directory: string) => protectedInteractionDetailDocumentSchema.parse({
  type: "hra_protected_interaction_detail",
  version: 1,
  binding: {
    interactionId: randomUUID(), revision: 1, kind: "permission_approval",
    sessionId: createSessionId(), profileId: createProfileId(),
    processGeneration: 1, connectionId: randomUUID(),
  },
  authority: {
    kind: "permission_approval", permissions: { synthetic: true },
    reason: "Synthetic private-file custody test", workingDirectory: directory,
    environmentId: null,
  },
});

async function withRecovery(
  operation: (input: Readonly<{
    directory: string;
    initial: ClaudeLiveAcceptanceRecoveryReceipt;
    receipt: AtomicPrivateJsonReceipt<ClaudeLiveAcceptanceRecoveryReceipt>;
    owner: Awaited<ReturnType<typeof acquireClaudeLiveAcceptanceOwner>>;
  }>) => Promise<void>,
): Promise<void> {
  await withDirectory(async (directory) => {
    const runId = randomUUID();
    const root = await mkdtemp(join(directory, `hra-live-acceptance-${runId}-`));
    const state = join(root, "device-a-test");
    const project = join(root, "project-a-test");
    await mkdir(state, { mode: 0o700 });
    await mkdir(project, { mode: 0o700 });
    const initial = claudeLiveAcceptanceRecoveryReceiptSchema.parse({
      accountLabel: "oompa-claude-live-000000000001",
      candidate: {
        cloudTargetDigest: "a".repeat(64), packageVersion: OOMPA_VERSION,
        sourceRevision: "b".repeat(40),
      },
      checkpoint: "prepared", createdAt: 1, updatedAt: 1,
      expectedHomeDirectory: homedir(), loginIdempotencyKey: randomUUID(),
      projectLabel: "oompa-claude-live-000000000002",
      project: { identity: await observePrivateDirectory(project, invalid), state: "active" },
      receiptPath: join(directory, `.oompa-live-claude-acceptance-${runId}.recovery.json`),
      runId, runRoot: await observePrivateDirectory(root, invalid),
      sendIdempotencyKey: randomUUID(), startIdempotencyKey: randomUUID(),
      state: { identity: await observePrivateDirectory(state, invalid), state: "active" },
      version: 1, worker: { state: "absent" },
    });
    const owner = await acquireClaudeLiveAcceptanceOwner({ runId, receiptPath: initial.receiptPath });
    try {
      const receipt = await AtomicPrivateJsonReceipt.create(initial, recoveryPolicy);
      await operation({ directory, initial, receipt, owner });
    } finally { await owner.releasePreserving().catch(() => undefined); }
  });
}

async function quarantine(
  receipt: AtomicPrivateJsonReceipt<ClaudeLiveAcceptanceRecoveryReceipt>,
  key: "project" | "state",
): Promise<string> {
  const quarantinePath = join(receipt.value.runRoot.path, `.oompa-claude-quarantine-${key}-${randomUUID()}`);
  await receipt.update((current) => ({
    ...current, [key]: { ...current[key], quarantinePath, state: "quarantine_planned" },
  }));
  await rename(receipt.value[key].identity.path, quarantinePath);
  return quarantinePath;
}

describe("Claude acceptance helper custody", () => {
  test("process argv parsing is bounded, strict UTF-8, and NUL terminated", () => {
    const bytes = Buffer.from("/synthetic/claude\0--mcp-config\0/synthetic/mcp.json\0");
    const parsed = parseClaudeProcessArgvBytes(bytes);
    expect(parsed).toEqual(["/synthetic/claude", "--mcp-config", "/synthetic/mcp.json"]);
    expect(Object.isFrozen(parsed)).toBe(true);
    for (const malformed of [
      Buffer.alloc(0), Buffer.from("a"), Buffer.from("a\0\0"),
      Buffer.from([0xff, 0]), Buffer.from("a\nb\0"), Buffer.from("a\x7fb\0"),
      Buffer.concat([Buffer.alloc(64 * 1024, 0x61), Buffer.from([0])]),
    ]) expect(() => parseClaudeProcessArgvBytes(malformed)).toThrow();
  });

  test.skipIf(process.platform !== "linux")("real zero-size proc stat proves only a separate worker group", async () => {
    const child = spawn(process.execPath, ["--eval", "process.stdout.write('ready'); process.stdin.resume();"], {
      detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const closed = new Promise<void>((resolvePromise) => {
      child.once("close", () => resolvePromise());
      child.once("error", () => { if (child.pid === undefined) resolvePromise(); });
    });
    const joinClosed = async (milliseconds: number): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          closed.then(() => true),
          new Promise<boolean>((resolvePromise) => {
            timer = setTimeout(() => resolvePromise(false), milliseconds);
          }),
        ]);
      } finally { clearTimeout(timer); }
    };
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => rejectPromise(new Error("synthetic_worker_timeout")), 2_000);
        child.once("error", (error) => { clearTimeout(timer); rejectPromise(error); });
        child.stdout.once("data", (bytes: Buffer) => {
          clearTimeout(timer);
          if (bytes.toString("utf8") !== "ready") rejectPromise(new Error("synthetic_worker_output"));
          else resolvePromise();
        });
      });
      const pid = child.pid;
      if (pid === undefined) throw new Error("synthetic_worker_missing");
      expect((await lstat(`/proc/${String(pid)}/stat`)).size).toBe(0);
      await expect(proveClaudeWorkerSignalDomain(pid)).resolves.toBeUndefined();
      await expect(proveClaudeWorkerSignalDomain(process.pid)).rejects.toThrow();
    } finally {
      child.stdin.end();
      if (!await joinClosed(250)) {
        child.kill("SIGKILL");
        expect(await joinClosed(1_000)).toBe(true);
      }
    }
  });

  test("consumes and removes only the exact private interaction file", async () => {
    await withDirectory(async (directory) => {
      const parent = await observePrivateDirectory(directory, invalid);
      const identity = await createProtectedInteractionFile(parent);
      const value = protectedDocument(directory);
      await writeFile(identity.path, JSON.stringify(value));
      expect(await consumeProtectedInteractionFile(parent, identity)).toEqual(value);
      await expect(lstat(identity.path)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  test("a replaced protected interaction inode is preserved on refusal", async () => {
    await withDirectory(async (directory) => {
      const parent = await observePrivateDirectory(directory, invalid);
      const identity = await createProtectedInteractionFile(parent);
      const moved = join(directory, "owned-interaction.json");
      await rename(identity.path, moved);
      await writeFile(identity.path, "foreign replacement", { mode: 0o600 });
      const replacement = await lstat(identity.path);
      await expect(consumeProtectedInteractionFile(parent, identity)).rejects.toThrow();
      expect((await lstat(identity.path)).ino).toBe(replacement.ino);
      expect(await readFile(identity.path, "utf8")).toBe("foreign replacement");
      expect((await lstat(moved)).ino).toBe(identity.inode);
    });
  });

  test("a replaced parent is refused even when the original file inode is moved back", async () => {
    await withDirectory(async (directory) => {
      const path = join(directory, "parent");
      const moved = join(directory, "original-parent");
      await mkdir(path, { mode: 0o700 });
      const parent = await observePrivateDirectory(path, invalid);
      const identity = await createProtectedInteractionFile(parent);
      await writeFile(identity.path, JSON.stringify(protectedDocument(path)));
      await rename(path, moved);
      await mkdir(path, { mode: 0o700 });
      const filename = identity.path.slice(path.length + 1);
      await rename(join(moved, filename), identity.path);
      await expect(consumeProtectedInteractionFile(parent, identity)).rejects.toThrow();
      expect((await lstat(identity.path)).ino).toBe(identity.inode);
    });
  });

  test("special mode protected files are refused and preserved", async () => {
    await withDirectory(async (directory) => {
      const parent = await observePrivateDirectory(directory, invalid);
      const identity = await createProtectedInteractionFile(parent);
      await writeFile(identity.path, JSON.stringify(protectedDocument(directory)));
      expect(spawnSync("/bin/chmod", ["1600", identity.path], { timeout: 1_000 }).status).toBe(0);
      expect((await lstat(identity.path)).mode & 0o7777).toBe(0o1600);
      await expect(consumeProtectedInteractionFile(parent, identity)).rejects.toThrow();
      expect((await lstat(identity.path)).ino).toBe(identity.inode);
    });
  });

  test("invalid UTF-8 is refused while the exact consumed private file is removed", async () => {
    await withDirectory(async (directory) => {
      const parent = await observePrivateDirectory(directory, invalid);
      const identity = await createProtectedInteractionFile(parent);
      await writeFile(identity.path, Buffer.from([0xff, 0xfe]));
      await expect(consumeProtectedInteractionFile(parent, identity)).rejects.toThrow();
      await expect(lstat(identity.path)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  test.each(["after_rename", "after_rm"] as const)("reconciles quarantine crash %s through real receipt custody", async (boundary) => {
    await withRecovery(async ({ directory, initial, receipt, owner }) => {
      const sibling = join(directory, "unrelated-sibling");
      await writeFile(sibling, "preserve me", { mode: 0o600 });
      const quarantined = await quarantine(receipt, "project");
      if (boundary === "after_rm") {
        await receipt.update((current) => ({
          ...current, project: { ...current.project, state: "quarantined" },
        }));
        await rm(quarantined, { recursive: true });
      }
      const reopened = await AtomicPrivateJsonReceipt.open(receipt.value, recoveryPolicy);
      await expect(assertLayout(reopened.value)).resolves.toBeUndefined();
      await removePrivateLayout(reopened, owner);
      await expect(lstat(initial.runRoot.path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(initial.receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(sibling, "utf8")).toBe("preserve me");
      expect(() => owner.assertCurrent()).toThrow();
    });
  });

  test("finishes receipt and lock removal after the exact run root is already deleted", async () => {
    await withRecovery(async ({ initial, receipt, owner }) => {
      for (const key of ["project", "state"] as const) {
        const path = await quarantine(receipt, key);
        await receipt.update((current) => ({ ...current, [key]: { ...current[key], state: "quarantined" } }));
        await rm(path, { recursive: true });
        await receipt.update((current) => ({ ...current, [key]: { ...current[key], state: "deleted" } }));
      }
      await rm(initial.runRoot.path, { recursive: true });
      const reopened = await AtomicPrivateJsonReceipt.open(receipt.value, recoveryPolicy);
      await removePrivateLayout(reopened, owner);
      await expect(lstat(initial.receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(() => owner.assertCurrent()).toThrow();
    });
  });

  test("foreign quarantine replacement is preserved and cannot advance cleanup", async () => {
    await withRecovery(async ({ receipt, initial, owner }) => {
      const path = await quarantine(receipt, "project");
      await receipt.update((current) => ({ ...current, project: { ...current.project, state: "quarantined" } }));
      await rename(path, join(initial.runRoot.path, "retained-owned-project"));
      await mkdir(path, { mode: 0o700 });
      await writeFile(join(path, "foreign"), "preserve replacement");
      const before = await lstat(path);
      await expect(removePrivateLayout(receipt, owner)).rejects.toThrow();
      expect((await lstat(path)).ino).toBe(before.ino);
      expect(await readFile(join(path, "foreign"), "utf8")).toBe("preserve replacement");
      expect((await lstat(initial.receiptPath)).isFile()).toBe(true);
    });
  });
});
