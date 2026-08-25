import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertProductionPackageOnly } from "./package-policy";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { force: true, recursive: true });
  }));
});

const fixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "hra-package-policy-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "src", "cloud"), { recursive: true });
  await writeFile(join(root, "src", "cli.ts"), "export {};\n");
  await chmod(join(root, "src", "cli.ts"), 0o755);
  await writeFile(join(root, "src", "install-normalizer.ts"), "export {};\n", { mode: 0o644 });
  await chmod(join(root, "src", "install-normalizer.ts"), 0o644);
  await writeFile(join(root, "src", "install-preflight.ts"), "export {};\n", { mode: 0o644 });
  await chmod(join(root, "src", "install-preflight.ts"), 0o644);
  await writeFile(join(root, "src", "install-preflight-runtime.ts"), "export {};\n", { mode: 0o644 });
  await chmod(join(root, "src", "install-preflight-runtime.ts"), 0o644);
  await writeFile(join(root, "README.md"), "# HRA\n");
  await chmod(join(root, "README.md"), 0o644);
  return root;
};

describe("production package policy", () => {
  test("accepts the bounded production source surface", async () => {
    await expect(assertProductionPackageOnly(await fixture())).resolves.toBeUndefined();
  });

  test("restores exact archive modes under a restrictive umask", async () => {
    const previousUmask = process.umask(0o077);
    try {
      const root = await fixture();
      expect((await lstat(join(root, "src", "cli.ts"))).mode & 0o777).toBe(0o755);
      expect((await lstat(join(root, "src", "install-normalizer.ts"))).mode & 0o777).toBe(0o644);
      expect((await lstat(join(root, "src", "install-preflight.ts"))).mode & 0o777).toBe(0o644);
      expect((await lstat(join(root, "src", "install-preflight-runtime.ts"))).mode & 0o777).toBe(0o644);
      expect((await lstat(join(root, "README.md"))).mode & 0o777).toBe(0o644);
      await expect(assertProductionPackageOnly(root)).resolves.toBeUndefined();
    } finally {
      process.umask(previousUmask);
    }
  });

  test("rejects repository, test, guide, and operator-only source", async () => {
    const forbidden = [
      [".github", "workflows", "release.yml"],
      ["convex", "schema.ts"],
      ["docs", "live-acceptance.md"],
      ["kb", "plans", "hra-v1.md"],
      ["scripts", "live-acceptance.ts"],
      ["site", "content.ts"],
      ["src", "AGENTS.md"],
      ["src", "cli.test.ts"],
      ["src", "cloud", "inviteAuthority.ts"],
      ["src", "cloud", "testAssertions.ts"],
      ["src", "storage", "legacy-secret-migration.ts"],
      ["src", "live-acceptance-private.ts"],
    ] as const;
    for (const components of forbidden) {
      const root = await fixture();
      const path = join(root, ...components);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "forbidden\n");
      await expect(assertProductionPackageOnly(root))
        .rejects.toThrow(/repository-only|development-only/u);
    }
  });

  test("rejects operator-only source below the package archive wrapper", async () => {
    const root = await fixture();
    const path = join(root, "package", "src", "storage", "legacy-secret-migration.ts");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "forbidden\n");
    await expect(assertProductionPackageOnly(root)).rejects.toThrow("repository-only source");
  });

  test("rejects a group- or world-writable CLI entry point", async () => {
    const root = await fixture();
    await chmod(join(root, "src", "cli.ts"), 0o777);
    await expect(assertProductionPackageOnly(root)).rejects.toThrow("mode-0755 regular file");
  });

  test("rejects a missing CLI entry point", async () => {
    const root = await mkdtemp(join(tmpdir(), "hra-package-policy-missing-cli-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "install-normalizer.ts"), "export {};\n", { mode: 0o644 });
    await chmod(join(root, "src", "install-normalizer.ts"), 0o644);
    await writeFile(join(root, "src", "install-preflight.ts"), "export {};\n", { mode: 0o644 });
    await chmod(join(root, "src", "install-preflight.ts"), 0o644);
    await writeFile(join(root, "src", "install-preflight-runtime.ts"), "export {};\n", { mode: 0o644 });
    await chmod(join(root, "src", "install-preflight-runtime.ts"), 0o644);
    await writeFile(join(root, "README.md"), "# HRA\n");
    await chmod(join(root, "README.md"), 0o644);
    await expect(assertProductionPackageOnly(root)).rejects.toThrow("exactly one CLI entry point");
  });

  test("rejects a writable or missing reviewed install preflight", async () => {
    const writable = await fixture();
    await chmod(join(writable, "src", "install-preflight.ts"), 0o666);
    await expect(assertProductionPackageOnly(writable)).rejects.toThrow("preflight");

    const missing = await fixture();
    await rm(join(missing, "src", "install-preflight.ts"));
    await expect(assertProductionPackageOnly(missing)).rejects.toThrow("pre-add install preflight");
  });

  test("rejects a writable or missing reviewed install preflight runtime", async () => {
    const writable = await fixture();
    await chmod(join(writable, "src", "install-preflight-runtime.ts"), 0o666);
    await expect(assertProductionPackageOnly(writable)).rejects.toThrow("preflight runtime");

    const missing = await fixture();
    await rm(join(missing, "src", "install-preflight-runtime.ts"));
    await expect(assertProductionPackageOnly(missing)).rejects.toThrow("self-contained install preflight runtime");
  });

  test("rejects a writable or missing reviewed install normalizer", async () => {
    const writable = await fixture();
    await chmod(join(writable, "src", "install-normalizer.ts"), 0o666);
    await expect(assertProductionPackageOnly(writable)).rejects.toThrow("mode-0644 regular file");

    const missing = await fixture();
    await rm(join(missing, "src", "install-normalizer.ts"));
    await expect(assertProductionPackageOnly(missing)).rejects.toThrow("exactly one reviewed non-bin install normalizer");
  });

  test("keeps the archive normalizer at 0644 and accepts a restrictive installed copy", async () => {
    const root = await fixture();
    await chmod(join(root, "src", "install-normalizer.ts"), 0o600);
    await expect(assertProductionPackageOnly(root)).rejects.toThrow("archive normalizer");
    await chmod(join(root, "src", "install-normalizer.ts"), 0o644);
    await chmod(join(root, "src", "install-preflight.ts"), 0o600);
    await expect(assertProductionPackageOnly(root)).rejects.toThrow("archive preflight");
    await chmod(join(root, "src", "install-preflight.ts"), 0o644);
    await chmod(join(root, "src", "install-preflight-runtime.ts"), 0o600);
    await expect(assertProductionPackageOnly(root)).rejects.toThrow("archive preflight runtime");
    await chmod(join(root, "src", "install-normalizer.ts"), 0o600);
    await expect(assertProductionPackageOnly(root, "installed")).resolves.toBeUndefined();
  });
});
