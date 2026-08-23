import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { initializeStatePaths, resolveStatePaths } from "./paths";
import { GenerationalSecretCustody, type SecretBackend } from "./secret-custody";

class MemoryBackend implements SecretBackend {
  readonly values = new Map<string, string>();
  beforeGet?: () => Promise<void>;
  async get(account: string): Promise<string | null> { await this.beforeGet?.(); return this.values.get(account) ?? null; }
  async set(account: string, value: string): Promise<void> { if (this.values.has(account)) throw new Error("exists"); this.values.set(account, value); }
  async delete(account: string): Promise<boolean> { return this.values.delete(account); }
}

describe("GenerationalSecretCustody", () => {
  test("publishes immutable generations with exact CAS", async () => {
    const home = await mkdtemp(join("/private/tmp", "hra-secrets-"));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const backend = new MemoryBackend();
    const custody = new GenerationalSecretCustody(paths, backend);
    expect(await custody.compareAndSwap("device-key", null, "first")).toEqual({ generation: 0, value: "first" });
    expect(await custody.compareAndSwap("device-key", null, "loser")).toBeNull();
    expect(await custody.compareAndSwap("device-key", 0, "second")).toEqual({ generation: 1, value: "second" });
    expect(await custody.read("device-key")).toEqual({ generation: 1, value: "second" });
    expect([...backend.values.values()]).toContain("first");
  });

  test("two concurrent compare-and-swap attempts produce one winner", async () => {
    const home = await mkdtemp(join("/private/tmp", "hra-secrets-"));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const custody = new GenerationalSecretCustody(paths, new MemoryBackend());
    const results = await Promise.all([
      custody.compareAndSwap("device-key", null, "first"),
      custody.compareAndSwap("device-key", null, "second"),
    ]);
    expect(results.filter((result) => result !== null)).toHaveLength(1);
    const winner = await custody.read("device-key");
    expect(winner).not.toBeNull();
    expect(["first", "second"]).toContain(winner!.value);
  });

  test("generation-checked clear cannot retire a newer winner", async () => {
    const home = await mkdtemp(join("/private/tmp", "hra-secrets-"));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const custody = new GenerationalSecretCustody(paths, new MemoryBackend());
    await custody.compareAndSwap("cloud-session", null, "first");
    await custody.compareAndSwap("cloud-session", 0, "second");
    expect(await custody.clearIfGeneration("cloud-session", 0)).toBe(false);
    expect(await custody.read("cloud-session")).toEqual({ generation: 1, value: "second" });
  });

  test("a concurrent clear cannot delete a value underneath an admitted read", async () => {
    const home = await mkdtemp(join("/private/tmp", "hra-secrets-"));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const backend = new MemoryBackend();
    const custody = new GenerationalSecretCustody(paths, backend);
    await custody.compareAndSwap("cloud-session", null, "credential");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const admitted = new Promise<void>((resolve) => { entered = resolve; });
    backend.beforeGet = async () => { entered(); await gate; };
    const read = custody.read("cloud-session");
    await admitted;
    const clear = custody.clearIfGeneration("cloud-session", 0);
    release();
    expect(await read).toEqual({ generation: 0, value: "credential" });
    expect(await clear).toBe(true);
  });
});
