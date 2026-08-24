import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  await writeFile(join(root, "README.md"), "# HRA\n");
  return root;
};

describe("production package policy", () => {
  test("accepts the bounded production source surface", async () => {
    await expect(assertProductionPackageOnly(await fixture())).resolves.toBeUndefined();
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
});
