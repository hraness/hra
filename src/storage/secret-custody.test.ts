import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, linkSync, renameSync, writeFileSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeStatePaths, resolveStatePaths, type StatePaths } from "./paths";
import { parseDarwinDescriptorAclResult } from "./descriptor-security";
import {
  FileSecretBackend,
  GenerationalSecretCustody,
  type DescriptorAclInspection,
  type SecretBackend,
} from "./secret-custody";

class MemoryBackend implements SecretBackend {
  readonly values = new Map<string, string>();
  readonly deletedAccounts: string[] = [];
  beforeGet: (() => Promise<void>) | undefined;
  deleteError: Error | undefined;
  deleteResult: boolean | undefined;

  async get(account: string): Promise<string | null> {
    await this.beforeGet?.();
    return this.values.get(account) ?? null;
  }

  async set(account: string, value: string): Promise<void> {
    if (this.values.has(account)) {
      const conflict: NodeJS.ErrnoException = new Error("exists");
      conflict.code = "EEXIST";
      throw conflict;
    }
    this.values.set(account, value);
  }

  async delete(account: string): Promise<boolean> {
    this.deletedAccounts.push(account);
    if (this.deleteError !== undefined) throw this.deleteError;
    if (this.deleteResult !== undefined) return this.deleteResult;
    return this.values.delete(account);
  }
}

const fixture = async (prefix: string): Promise<{ home: string; paths: StatePaths }> => {
  const home = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  return { home, paths };
};

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

describe("FileSecretBackend atomic immutable publication", () => {
  test("publishes through one bounded pending file and never overwrites a final value", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-value-atomic-")));
    try {
      const root = join(home, "values");
      const backend = new FileSecretBackend(root);
      await backend.set("device.0.value", "credential");
      expect(await readdir(root)).toEqual(["device.0.value"]);
      await expect(backend.set("device.0.value", "replacement"))
        .rejects.toMatchObject({ code: "EEXIST" });
      expect(await backend.get("device.0.value")).toBe("credential");
      expect(await readdir(root)).toEqual(["device.0.value"]);
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  test("enforces the public backend's 1..65,536 UTF-8 byte contract", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-value-bounds-")));
    try {
      const backend = new FileSecretBackend(join(home, "values"));
      await expect(backend.set("empty.value", ""))
        .rejects.toThrow("Secret value is outside the custody bound.");
      await expect(backend.set("oversize.value", "a".repeat(65_537)))
        .rejects.toThrow("Secret value is outside the custody bound.");
      await expect(backend.set("utf8-oversize.value", "é".repeat(32_769)))
        .rejects.toThrow("Secret value is outside the custody bound.");
      await backend.set("maximum.value", "a".repeat(65_536));
      expect((await backend.get("maximum.value"))?.length).toBe(65_536);
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  test("rewrites a crash-partial deterministic pending file under its kernel lock", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-value-partial-")));
    try {
      const root = join(home, "values");
      await mkdir(root, { mode: 0o700 });
      await writeFile(join(root, ".device.0.value.pending"), "part", { mode: 0o600 });
      const backend = new FileSecretBackend(root);

      await backend.set("device.0.value", "complete-credential");
      expect(await backend.get("device.0.value")).toBe("complete-credential");
      expect(await readdir(root)).toEqual(["device.0.value"]);
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  for (const failedSync of [1, 2] as const) {
    test(`restart reconciles publication when directory sync ${failedSync} fails`, async () => {
      const home = await realpath(await mkdtemp(join(tmpdir(), `hra-value-sync-${failedSync}-`)));
      try {
        const root = join(home, "values");
        const failure = new Error(`sync ${failedSync}`);
        let syncCalls = 0;
        const interrupted = new FileSecretBackend(root, {
          syncDirectory: async (handle) => {
            syncCalls += 1;
            if (syncCalls === failedSync) throw failure;
            await handle.sync();
          },
        });
        await expect(interrupted.set("device.0.value", "credential")).rejects.toBe(failure);

        const recovered = new FileSecretBackend(root);
        expect(await recovered.get("device.0.value")).toBe("credential");
        expect(await readdir(root)).toEqual(["device.0.value"]);
      } finally {
        await rm(home, { force: true, recursive: true });
      }
    });
  }

  test("an exact-value set replays a crash after link and before pending cleanup", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-value-exact-replay-")));
    try {
      const root = join(home, "values");
      const failure = new Error("post-link sync failure");
      let failed = false;
      const interrupted = new FileSecretBackend(root, {
        syncDirectory: async (handle) => {
          if (!failed) {
            failed = true;
            throw failure;
          }
          await handle.sync();
        },
      });
      await expect(interrupted.set("device.0.value", "credential")).rejects.toBe(failure);
      expect((await lstat(join(root, "device.0.value"), { bigint: true })).nlink).toBe(2n);

      const restarted = new FileSecretBackend(root);
      await expect(restarted.set("device.0.value", "credential")).resolves.toBeUndefined();
      expect(await restarted.get("device.0.value")).toBe("credential");
      expect(await readdir(root)).toEqual(["device.0.value"]);
      await expect(restarted.set("device.0.value", "different"))
        .rejects.toMatchObject({ code: "EEXIST" });
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  test("a no-op link cannot publish partial bytes at the final name", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-value-link-proof-")));
    try {
      const root = join(home, "values");
      const interrupted = new FileSecretBackend(root, { linkAt: () => null });
      await expect(interrupted.set("device.0.value", "credential"))
        .rejects.toThrow("Secret immutable publication could not be proven.");
      await expect(readFile(join(root, "device.0.value"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });

      const recovered = new FileSecretBackend(root);
      await recovered.set("device.0.value", "credential");
      expect(await recovered.get("device.0.value")).toBe("credential");
      expect(await readdir(root)).toEqual(["device.0.value"]);
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  test("link success must prove the exact final account name and inode", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-value-exact-link-")));
    try {
      const root = join(home, "values");
      const backend = new FileSecretBackend(root, {
        linkAt: (...parameters) => {
          const sourceName = parameters[1];
          linkSync(join(root, sourceName), join(root, "wrong"));
          return null;
        },
      });
      await expect(backend.set("device.0.value", "credential"))
        .rejects.toThrow("Secret immutable publication could not be proven.");
      await expect(lstat(join(root, "device.0.value")))
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(root, "wrong"), "utf8")).toBe("credential");
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  test("two live writers serialize on the per-account kernel lock", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-value-writers-")));
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let entered!: () => void;
      const admission = new Promise<void>((resolve) => { entered = resolve; });
      let first = true;
      const backend = new FileSecretBackend(join(home, "values"), {
        beforeLinkAt: async () => {
          if (!first) return;
          first = false;
          entered();
          await gate;
        },
      });
      const winner = backend.set("device.0.value", "first");
      await admission;
      const loser = backend.set("device.0.value", "second");
      release();
      const results = await Promise.allSettled([winner, loser]);

      expect(results[0].status).toBe("fulfilled");
      expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "EEXIST" } });
      expect(await backend.get("device.0.value")).toBe("first");
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  test("a reader waiting on a linked pending inode observes the immutable final value", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-value-reader-race-")));
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let entered!: () => void;
      const linked = new Promise<void>((resolve) => { entered = resolve; });
      let first = true;
      const backend = new FileSecretBackend(join(home, "values"), {
        syncDirectory: async (handle) => {
          if (first) {
            first = false;
            entered();
            await gate;
          }
          await handle.sync();
        },
      });
      const publication = backend.set("device.0.value", "credential");
      await linked;
      const observation = backend.get("device.0.value");
      release();

      await expect(publication).resolves.toBeUndefined();
      await expect(observation).resolves.toBe("credential");
      expect(await readdir(join(home, "values"))).toEqual(["device.0.value"]);
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  test("delete attempts final and pending cleanup and remains idempotent", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-value-delete-")));
    try {
      const root = join(home, "values");
      const backend = new FileSecretBackend(root);
      await backend.set("device.0.value", "credential");
      expect(await backend.delete("device.0.value")).toBe(true);
      expect(await backend.delete("device.0.value")).toBe(false);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });
});

describe("descriptor-relative authority and ACLs", () => {
  test("Darwin ACL result parsing distinguishes proven absence from presence and ambiguity", () => {
    const clear = new Uint8Array(32);
    const clearWords = new Uint32Array(clear.buffer);
    clearWords[0] = 32;
    clearWords[1] = 0x80000000;
    expect(parseDarwinDescriptorAclResult(0, clear)).toBe("clear");

    const present = new Uint8Array(32);
    const presentWords = new Uint32Array(present.buffer);
    presentWords[0] = 48;
    presentWords[1] = 0x80400000;
    expect(parseDarwinDescriptorAclResult(0, present)).toBe("present");
    expect(parseDarwinDescriptorAclResult(-1, clear)).toBe("indeterminate");
    clearWords[6] = 1;
    expect(parseDarwinDescriptorAclResult(0, clear)).toBe("indeterminate");
  });

  for (const operation of ["get", "set", "delete"] as const) {
    test(`${operation} cannot traverse a parent swapped at its exact child boundary`, async () => {
      const home = await realpath(await mkdtemp(join(tmpdir(), `hra-value-${operation}-swap-`)));
      try {
        const parent = join(home, "authority");
        const root = join(parent, "values");
        const displaced = join(home, "authority-displaced");
        const outside = join(home, "outside");
        const outsideRoot = join(outside, "values");
        const account = operation === "set" ? "device.1.value" : "device.0.value";
        let armed = false;
        const backend = new FileSecretBackend(root, {
          beforeOpenAt: async (candidate, openedAccount) => {
            if (!armed || candidate !== operation || openedAccount !== account) return;
            if (operation === "delete") return;
            armed = false;
            await rename(parent, displaced);
            await symlink(outside, parent, "dir");
          },
          beforeUnlinkAt: async (name) => {
            if (!armed || operation !== "delete" || name !== account) return;
            armed = false;
            await rename(parent, displaced);
            await symlink(outside, parent, "dir");
          },
        });
        await backend.set("device.0.value", "credential");
        await mkdir(outsideRoot, { mode: 0o700, recursive: true });
        await writeFile(join(outsideRoot, "device.0.value"), "outside-decoy", { mode: 0o600 });
        armed = true;

        const action = operation === "get"
          ? backend.get(account)
          : operation === "set"
            ? backend.set(account, "new-credential")
            : backend.delete(account);
        await expect(action).rejects.toThrow("Secret root identity changed.");
        expect(await readFile(join(outsideRoot, "device.0.value"), "utf8"))
          .toBe("outside-decoy");
        if (operation === "set") {
          await expect(readFile(join(outsideRoot, account), "utf8"))
            .rejects.toMatchObject({ code: "ENOENT" });
          expect(await readFile(join(displaced, "values", account), "utf8"))
            .toBe("new-credential");
        }
      } finally {
        await rm(home, { force: true, recursive: true });
      }
    });
  }

  test("Darwin ACL present/indeterminate states fail closed for root and value descriptors", async () => {
    for (const inspection of ["present", "indeterminate"] as const) {
      const home = await realpath(await mkdtemp(join(tmpdir(), `hra-acl-root-${inspection}-`)));
      try {
        const rootRejected = new FileSecretBackend(join(home, "root-values"), {
          inspectDarwinAcl: () => inspection,
          platform: "darwin",
        });
        await expect(rootRejected.set("device.0.value", "credential"))
          .rejects.toThrow("Unsafe secret root ACL.");

        const valueRejected = new FileSecretBackend(join(home, "value-values"), {
          inspectDarwinAcl: (descriptor): DescriptorAclInspection =>
            fstatSync(descriptor, { bigint: true }).isDirectory() ? "clear" : inspection,
          platform: "darwin",
        });
        await expect(valueRejected.set("device.0.value", "credential"))
          .rejects.toThrow("Unsafe secret value ACL.");
      } finally {
        await rm(home, { force: true, recursive: true });
      }
    }
  });

  test("descriptor cleanup cannot replace the original ACL failure", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-acl-cleanup-order-")));
    try {
      let closed = false;
      const backend = new FileSecretBackend(join(home, "values"), {
        inspectDarwinAcl: (descriptor): DescriptorAclInspection => {
          if (!closed) {
            closed = true;
            closeSync(descriptor);
          }
          return "present";
        },
        platform: "darwin",
      });
      let caught: unknown;
      try {
        await backend.set("device.0.value", "credential");
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AggregateError);
      const aggregate = caught as AggregateError;
      expect(aggregate.errors[0]).toMatchObject({ message: "Unsafe secret root ACL." });
      expect(aggregate.errors.length).toBeGreaterThan(1);
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });
});

describe("GenerationalSecretCustody bounded state machine", () => {
  test("keeps one current value and a compact v3 pointer across high churn", async () => {
    const { home, paths } = await fixture("hra-cas-churn-");
    try {
      const custody = new GenerationalSecretCustody(paths);
      let expected: number | null = null;
      for (let index = 0; index < 80; index += 1) {
        const result = await custody.compareAndSwap("cursor", expected, `value-${index}`);
        expect(result?.generation).toBe(index);
        expected = index;
      }
      expect(await custody.read("cursor")).toEqual({ generation: 79, value: "value-79" });
      const valueNames = await readdir(join(paths.root, "secret-values"));
      const metadataNames = (await readdir(join(paths.root, "secret-metadata"))).sort();
      expect(valueNames).toHaveLength(1);
      expect(metadataNames).toEqual(["cursor.json", "cursor.lock"]);
      expect(JSON.parse(await readFile(
        join(paths.root, "secret-metadata", "cursor.json"),
        "utf8",
      ))).toMatchObject({ version: 3, state: "committed", current: { generation: 79 } });
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  test("aggregate files and bytes are linear in slot count after repeated generations", async () => {
    const { home, paths } = await fixture("hra-cas-aggregate-");
    try {
      const custody = new GenerationalSecretCustody(paths);
      const slots = 8;
      const generations = 12;
      for (let slot = 0; slot < slots; slot += 1) {
        let expected: number | null = null;
        for (let generation = 0; generation < generations; generation += 1) {
          await custody.compareAndSwap(`slot-${slot}`, expected, `s${slot}-g${generation}`);
          expected = generation;
        }
      }
      const valueRoot = join(paths.root, "secret-values");
      const metadataRoot = join(paths.root, "secret-metadata");
      const valueNames = await readdir(valueRoot);
      const metadataNames = await readdir(metadataRoot);
      let valueBytes = 0n;
      for (const name of valueNames) valueBytes += (await lstat(join(valueRoot, name), { bigint: true })).size;
      let metadataBytes = 0n;
      for (const name of metadataNames) metadataBytes += (await lstat(join(metadataRoot, name), { bigint: true })).size;

      expect(valueNames).toHaveLength(slots);
      expect(metadataNames).toHaveLength(slots * 2);
      expect(valueBytes).toBeLessThanOrEqual(BigInt(slots * 16));
      expect(metadataBytes).toBeLessThanOrEqual(BigInt(slots * 1_024));
      expect(valueNames.some((name) => name.endsWith(".pending"))).toBe(false);
      expect(metadataNames.some((name) => name.includes(".pending."))).toBe(false);
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  test("restart rolls back a staged CAS whose value publication never linked", async () => {
    const { home, paths } = await fixture("hra-cas-staged-rollback-");
    try {
      const failure = new Error("injected link failure");
      const backend = new FileSecretBackend(join(paths.root, "secret-values"), {
        beforeLinkAt: async () => { throw failure; },
      });
      const interrupted = new GenerationalSecretCustody(paths, backend);
      await expect(interrupted.compareAndSwap("cursor", null, "credential"))
        .rejects.toBe(failure);
      expect(await readdir(join(paths.root, "secret-metadata")))
        .toContain("cursor.pending.json");

      const restarted = new GenerationalSecretCustody(paths);
      expect(await restarted.read("cursor")).toBeNull();
      expect(await restarted.compareAndSwap("cursor", null, "replacement"))
        .toEqual({ generation: 0, value: "replacement" });
      expect(await readdir(join(paths.root, "secret-values"))).toHaveLength(1);
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  test("restart commits a staged pointer after the exact new value was published", async () => {
    const { home, paths } = await fixture("hra-cas-staged-commit-");
    try {
      let failRename = true;
      const interrupted = new GenerationalSecretCustody(paths, undefined, {
        renameAt: () => {
          if (!failRename) return null;
          failRename = false;
          return 5;
        },
      });
      await expect(interrupted.compareAndSwap("cursor", null, "credential"))
        .rejects.toThrow("Secret pointer rename failed.");

      const restarted = new GenerationalSecretCustody(paths);
      expect(await restarted.read("cursor")).toEqual({ generation: 0, value: "credential" });
      expect(await readdir(join(paths.root, "secret-values"))).toHaveLength(1);
      const metadataNames = await readdir(join(paths.root, "secret-metadata"));
      expect(metadataNames).toContain("cursor.json");
      expect(metadataNames).toContain("cursor.lock");
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  test("a no-op rename cannot be reported as an authoritative pointer commit", async () => {
    const { home, paths } = await fixture("hra-pointer-noop-rename-");
    try {
      const interrupted = new GenerationalSecretCustody(paths, undefined, {
        renameAt: () => null,
      });
      await expect(interrupted.compareAndSwap("cursor", null, "credential"))
        .rejects.toThrow("Secret pointer rename could not be proven.");
      await expect(lstat(join(paths.root, "secret-metadata", "cursor.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(join(paths.root, "secret-metadata")))
        .toContain("cursor.pending.json");

      const restarted = new GenerationalSecretCustody(paths);
      expect(await restarted.read("cursor")).toEqual({ generation: 0, value: "credential" });
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  test("retired deletion failure and deletion-before-compaction crash replay idempotently", async () => {
    for (const boundary of ["delete", "compact"] as const) {
      const { home, paths } = await fixture(`hra-retired-${boundary}-`);
      try {
        const backend = new MemoryBackend();
        let armed = false;
        let writes = 0;
        const failure = new Error(`injected ${boundary} failure`);
        const custody = new GenerationalSecretCustody(paths, backend, {
          beforeMetadataOperation: async (operation) => {
            if (!armed || boundary !== "compact" || operation !== "pointer-write") return;
            writes += 1;
            if (writes === 2) throw failure;
          },
        });
        await custody.compareAndSwap("cursor", null, "first");
        armed = true;
        if (boundary === "delete") backend.deleteError = failure;

        await expect(custody.compareAndSwap("cursor", 0, "second")).rejects.toBe(failure);
        backend.deleteError = undefined;
        const restarted = new GenerationalSecretCustody(paths, backend);
        expect(await restarted.read("cursor")).toEqual({ generation: 1, value: "second" });
        expect([...backend.values.values()]).toEqual(["second"]);
        expect(JSON.parse(await readFile(
          join(paths.root, "secret-metadata", "cursor.json"),
          "utf8",
        ))).toMatchObject({ version: 3, current: { generation: 1 } });
      } finally {
        await rm(home, { force: true, recursive: true });
      }
    }
  });

  test("v1 pointers and v2 clearing/cleared replay remain compatible", async () => {
    const { home, paths } = await fixture("hra-pointer-compat-");
    try {
      const backend = new MemoryBackend();
      const nonce = crypto.randomUUID();
      const account = `cloud-session.7.${nonce}`;
      backend.values.set(account, "credential");
      const metadataRoot = join(paths.root, "secret-metadata");
      await mkdir(metadataRoot, { mode: 0o700 });
      await writeFile(join(metadataRoot, "cloud-session.json"), JSON.stringify({
        version: 1,
        generation: 7,
        nonce,
        digest: digest("credential"),
      }), { mode: 0o600 });
      const failure = new Error("injected delete failure");
      backend.deleteError = failure;
      const custody = new GenerationalSecretCustody(paths, backend);
      expect(await custody.read("cloud-session")).toEqual({ generation: 7, value: "credential" });
      await expect(custody.clearIfGeneration("cloud-session", 7)).rejects.toBe(failure);
      expect(JSON.parse(await readFile(join(metadataRoot, "cloud-session.json"), "utf8")))
        .toMatchObject({ version: 2, state: "clearing", generation: 7, nonce });

      backend.deleteError = undefined;
      const restarted = new GenerationalSecretCustody(paths, backend);
      expect(await restarted.read("cloud-session")).toBeNull();
      expect(JSON.parse(await readFile(join(metadataRoot, "cloud-session.json"), "utf8")))
        .toMatchObject({ version: 2, state: "cleared", generation: 7, nonce });
      expect(await restarted.clearIfGeneration("cloud-session", 7)).toBe(true);
      expect(await restarted.clearIfGeneration("cloud-session", 7)).toBe(true);
      expect(await restarted.read("cloud-session")).toBeNull();
      expect(JSON.parse(await readFile(join(metadataRoot, "cloud-session.json"), "utf8")))
        .toMatchObject({ version: 2, state: "cleared", generation: 7, nonce });

      const clearedRestart = new GenerationalSecretCustody(paths, backend);
      expect(await clearedRestart.read("cloud-session")).toBeNull();
      expect(await clearedRestart.clearIfGeneration("cloud-session", 7)).toBe(true);
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  test("generation increment rejects safe-integer exhaustion", async () => {
    const { home, paths } = await fixture("hra-generation-exhaustion-");
    try {
      const backend = new MemoryBackend();
      const nonce = crypto.randomUUID();
      backend.values.set(`cursor.${Number.MAX_SAFE_INTEGER}.${nonce}`, "credential");
      const metadataRoot = join(paths.root, "secret-metadata");
      await mkdir(metadataRoot, { mode: 0o700 });
      await writeFile(join(metadataRoot, "cursor.json"), JSON.stringify({
        version: 1,
        generation: Number.MAX_SAFE_INTEGER,
        nonce,
        digest: digest("credential"),
      }), { mode: 0o600 });

      const custody = new GenerationalSecretCustody(paths, backend);
      await expect(custody.compareAndSwap("cursor", Number.MAX_SAFE_INTEGER, "next"))
        .rejects.toThrow("Secret generation is exhausted.");
      expect(backend.values.size).toBe(1);
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });
});

describe("persistent slot locks, metadata authority, and closed ACL output", () => {
  test("converts an old PID lock and crash-after-quarantine hardlink without PID authority", async () => {
    const { home, paths } = await fixture("hra-lock-conversion-");
    try {
      const metadataRoot = join(paths.root, "secret-metadata");
      await mkdir(metadataRoot, { mode: 0o700 });
      const lockPath = join(metadataRoot, "cursor.lock");
      await writeFile(lockPath, JSON.stringify({
        version: 1,
        pid: process.pid,
        nonce: crypto.randomUUID(),
      }), { mode: 0o600 });
      await link(lockPath, `${lockPath}.stale.${crypto.randomUUID()}`);

      const custody = new GenerationalSecretCustody(paths, new MemoryBackend());
      expect(await custody.read("cursor")).toBeNull();
      expect(await readdir(metadataRoot)).toEqual(["cursor.lock"]);
      expect((await lstat(lockPath, { bigint: true })).size).toBe(0n);
      expect((await lstat(lockPath, { bigint: true })).nlink).toBe(1n);
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  test("recovers an orphan quarantine link left after canonical lock unlink", async () => {
    const { home, paths } = await fixture("hra-lock-orphan-quarantine-");
    try {
      const metadataRoot = join(paths.root, "secret-metadata");
      await mkdir(metadataRoot, { mode: 0o700 });
      const lockPath = join(metadataRoot, "cursor.lock");
      const stalePath = `${lockPath}.stale.${crypto.randomUUID()}`;
      await writeFile(lockPath, JSON.stringify({
        version: 1,
        pid: process.pid,
        nonce: crypto.randomUUID(),
      }), { mode: 0o600 });
      await link(lockPath, stalePath);
      await unlink(lockPath);

      const custody = new GenerationalSecretCustody(paths, new MemoryBackend());
      expect(await custody.read("cursor")).toBeNull();
      expect(await readdir(metadataRoot)).toEqual(["cursor.lock"]);
      expect((await lstat(join(metadataRoot, "cursor.lock"), { bigint: true })).nlink).toBe(1n);
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  test("retries when the canonical lock name is replaced while flock admission waits", async () => {
    const { home, paths } = await fixture("hra-lock-canonical-retry-");
    try {
      const metadataRoot = join(paths.root, "secret-metadata");
      await mkdir(metadataRoot, { mode: 0o700 });
      const lockPath = join(metadataRoot, "cursor.lock");
      const stalePath = `${lockPath}.stale.${crypto.randomUUID()}`;
      await writeFile(lockPath, "", { mode: 0o600 });
      let replaced = false;
      const custody = new GenerationalSecretCustody(paths, new MemoryBackend(), {
        flock: (_descriptor, operation) => {
          if (!replaced && operation === 6) {
            replaced = true;
            renameSync(lockPath, stalePath);
            writeFileSync(lockPath, "", { mode: 0o600 });
          }
          return null;
        },
      });

      expect(await custody.read("cursor")).toBeNull();
      expect(replaced).toBe(true);
      expect(await readdir(metadataRoot)).toEqual(["cursor.lock"]);
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  test("concurrent CAS attempts serialize through the persistent descriptor lock", async () => {
    const { home, paths } = await fixture("hra-slot-flock-");
    try {
      const backend = new MemoryBackend();
      const custody = new GenerationalSecretCustody(paths, backend);
      const results = await Promise.all([
        custody.compareAndSwap("cursor", null, "first"),
        custody.compareAndSwap("cursor", null, "second"),
      ]);
      expect(results.filter((result) => result !== null)).toHaveLength(1);
      const metadataNames = await readdir(join(paths.root, "secret-metadata"));
      expect(metadataNames).toContain("cursor.json");
      expect(metadataNames).toContain("cursor.lock");
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  test("pointer rename remains in the held root across exact-boundary substitution", async () => {
    const { home, paths } = await fixture("hra-pointer-root-swap-");
    try {
      const metadataRoot = join(paths.root, "secret-metadata");
      const displaced = join(home, "metadata-displaced");
      const outside = join(home, "outside-metadata");
      const target = "cursor.json";
      const pending = "cursor.pending.json";
      let armed = true;
      const custody = new GenerationalSecretCustody(paths, new MemoryBackend(), {
        beforeMetadataOperation: async (operation, name) => {
          if (!armed || operation !== "pointer-rename" || name !== target) return;
          armed = false;
          await rename(metadataRoot, displaced);
          await mkdir(outside, { mode: 0o700 });
          await writeFile(join(outside, target), "outside-pointer", { mode: 0o600 });
          await writeFile(join(outside, pending), "outside-pending", { mode: 0o600 });
          await symlink(outside, metadataRoot, "dir");
        },
      });

      let caught: unknown;
      try {
        await custody.compareAndSwap("cursor", null, "credential");
      } catch (error: unknown) {
        caught = error;
      }
      const errors = caught instanceof AggregateError ? caught.errors : [caught];
      expect(errors[0]).toMatchObject({ message: "Secret metadata root identity changed." });
      expect(await readFile(join(outside, target), "utf8")).toBe("outside-pointer");
      expect(await readFile(join(outside, pending), "utf8")).toBe("outside-pending");
      expect(JSON.parse(await readFile(join(displaced, target), "utf8")))
        .toMatchObject({ version: 3, current: { generation: 0 } });
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  test("an expected-generation mismatch still proves the metadata root before returning", async () => {
    const { home, paths } = await fixture("hra-pointer-read-root-swap-");
    try {
      const backend = new MemoryBackend();
      const initial = new GenerationalSecretCustody(paths, backend);
      await initial.compareAndSwap("cursor", null, "credential");
      const metadataRoot = join(paths.root, "secret-metadata");
      const displaced = join(home, "metadata-read-displaced");
      const outside = join(home, "outside-read-metadata");
      await mkdir(outside, { mode: 0o700 });
      let armed = true;
      const custody = new GenerationalSecretCustody(paths, backend, {
        beforeMetadataOperation: async (operation, name) => {
          if (!armed || operation !== "pointer-open" || name !== "cursor.json") return;
          armed = false;
          await rename(metadataRoot, displaced);
          await symlink(outside, metadataRoot, "dir");
        },
      });

      let caught: unknown;
      try {
        await custody.compareAndSwap("cursor", 99, "replacement");
      } catch (error: unknown) {
        caught = error;
      }
      const errors = caught instanceof AggregateError ? caught.errors : [caught];
      expect(errors[0]).toMatchObject({ message: "Secret metadata root identity changed." });
      expect([...backend.values.values()]).toEqual(["credential"]);
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  test("Darwin ACL checks cover metadata root, lock, and authoritative pointer descriptors", async () => {
    const { home, paths } = await fixture("hra-metadata-acl-");
    try {
      const rootRejected = new GenerationalSecretCustody(paths, new MemoryBackend(), {
        inspectDarwinAcl: () => "present",
        platform: "darwin",
      });
      await expect(rootRejected.read("root-slot"))
        .rejects.toThrow("Unsafe secret metadata root ACL.");

      const lockRejected = new GenerationalSecretCustody(paths, new MemoryBackend(), {
        inspectDarwinAcl: (descriptor): DescriptorAclInspection =>
          fstatSync(descriptor, { bigint: true }).isDirectory() ? "clear" : "present",
        platform: "darwin",
      });
      await expect(lockRejected.read("lock-slot"))
        .rejects.toThrow("Unsafe secret slot lock ACL.");

      const backend = new MemoryBackend();
      const clear = new GenerationalSecretCustody(paths, backend, {
        inspectDarwinAcl: () => "clear",
        platform: "darwin",
      });
      await clear.compareAndSwap("pointer-slot", null, "credential");
      const pointerRejected = new GenerationalSecretCustody(paths, backend, {
        inspectDarwinAcl: (descriptor): DescriptorAclInspection => {
          const metadata = fstatSync(descriptor, { bigint: true });
          return metadata.isDirectory() || metadata.size === 0n ? "clear" : "indeterminate";
        },
        platform: "darwin",
      });
      await expect(pointerRejected.read("pointer-slot"))
        .rejects.toThrow("Unsafe secret pointer ACL.");
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  test("operation and unlock failures preserve original-first aggregation and attempt close", async () => {
    const { home, paths } = await fixture("hra-cleanup-aggregate-");
    try {
      const primary = new Error("primary pointer failure");
      const custody = new GenerationalSecretCustody(paths, new MemoryBackend(), {
        beforeMetadataOperation: async (operation) => {
          if (operation === "pointer-open") throw primary;
        },
        flock: (_descriptor, operation) => operation === 8 ? 5 : null,
      });
      let caught: unknown;
      try { await custody.read("cursor"); } catch (error: unknown) { caught = error; }
      expect(caught).toBeInstanceOf(AggregateError);
      const aggregate = caught as AggregateError;
      expect(aggregate.errors[0]).toBe(primary);
      expect(aggregate.errors[1]).toMatchObject({ message: "Secret descriptor unlock failed." });
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });
});
