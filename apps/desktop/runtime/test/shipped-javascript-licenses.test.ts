import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import {
  createShippedJavaScriptLicenseInventory,
  renderShippedJavaScriptLicenseNotices,
  serializeShippedJavaScriptLicenseInventory,
  shippedJavaScriptSentinels,
  verifyShippedJavaScriptLicenseInventory,
} from "../shipped-javascript-licenses";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true })
  ));
});

async function fixtureRoot(): Promise<string> {
  const parent = join(import.meta.dir, "../../zig-out");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "javascript-licenses-test-"));
  temporaryRoots.push(root);
  return root;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writePackage(
  root: string,
  options: Readonly<{
    dependencies?: Readonly<Record<string, string>>;
    license?: string;
    licensePath?: string;
    licenseText?: string;
    name: string;
    version?: string;
  }>,
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeJson(join(root, "package.json"), {
    dependencies: options.dependencies ?? {},
    license: options.license ?? "MIT",
    name: options.name,
    version: options.version ?? "1.0.0",
  });
  if (options.licensePath !== undefined) {
    const path = join(root, options.licensePath);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, options.licenseText ?? "Fixture license\n");
  }
}

describe("shipped JavaScript license inventory", () => {
  test("captures the complete production closure in canonical order", async () => {
    const root = await fixtureRoot();
    await writePackage(root, {
      dependencies: { beta: "1.0.0", alpha: "1.0.0" },
      name: "fixture-root",
    });
    await writePackage(join(root, "node_modules/alpha"), {
      licensePath: "LICENSE",
      name: "alpha",
    });
    await writePackage(join(root, "node_modules/beta"), {
      dependencies: { nested: "1.0.0" },
      licensePath: "notices/THIRD-PARTY-LICENSES.txt",
      name: "beta",
    });
    await writePackage(join(root, "node_modules/nested"), {
      licensePath: "vendor/component/LICENSE-MIT",
      name: "nested",
    });

    const inventory = await createShippedJavaScriptLicenseInventory({
      packageJsonPath: join(root, "package.json"),
      sentinels: [],
    });

    expect(inventory.packages.map((entry) => entry.name)).toEqual([
      "alpha",
      "beta",
      "nested",
    ]);
    expect(inventory.packages[1]?.licenseDocuments[0]?.path).toBe(
      "notices/THIRD-PARTY-LICENSES.txt",
    );
    expect(inventory.packages[2]?.licenseDocuments[0]?.path).toBe(
      "vendor/component/LICENSE-MIT",
    );
    const serialized = serializeShippedJavaScriptLicenseInventory(inventory);
    expect(serialized).toBe(serializeShippedJavaScriptLicenseInventory(inventory));
    expect(renderShippedJavaScriptLicenseNotices(inventory)).toContain(
      "nested 1.0.0",
    );
  });

  test("fails closed on an unreviewed package without a license document", async () => {
    const root = await fixtureRoot();
    await writePackage(root, {
      dependencies: { undocumented: "1.0.0" },
      name: "fixture-root",
    });
    await writePackage(join(root, "node_modules/undocumented"), {
      name: "undocumented",
    });

    expect(createShippedJavaScriptLicenseInventory({
      packageJsonPath: join(root, "package.json"),
      sentinels: [],
    })).rejects.toThrow("no reviewed license document");
  });

  test("rejects UTF-8 BOMs so document hashes have one byte meaning", async () => {
    const root = await fixtureRoot();
    await writePackage(root, {
      dependencies: { bom: "1.0.0" },
      name: "fixture-root",
    });
    await writePackage(join(root, "node_modules/bom"), {
      licensePath: "LICENSE",
      licenseText: "\ufeffMIT\n",
      name: "bom",
    });

    expect(createShippedJavaScriptLicenseInventory({
      packageJsonPath: join(root, "package.json"),
      sentinels: [],
    })).rejects.toThrow("UTF-8 BOM is forbidden");
  });

  test("verifies every staged text hash and required sentinel", async () => {
    const inventory = await createShippedJavaScriptLicenseInventory();
    expect(inventory.packageCount).toBeGreaterThan(200);
    expect(inventory.packages.every((entry) => entry.licenseDocuments.length > 0)).toBe(true);
    const names = new Set(inventory.packages.map((entry) => entry.name));
    expect(names.has("@hugeicons/core-free-icons")).toBe(false);
    expect(names.has("@hugeicons/react")).toBe(false);
    expect(names.has("@hraness/ui")).toBe(false);
    for (const sentinel of shippedJavaScriptSentinels) {
      expect(names.has(sentinel)).toBe(true);
    }
    expect(() => verifyShippedJavaScriptLicenseInventory(inventory)).not.toThrow();

    const tampered = structuredClone(inventory) as unknown as {
      packages: Array<{
        licenseDocuments: Array<{ sha256: string; text: string }>;
      }>;
    };
    const firstDocument = tampered.packages[0]?.licenseDocuments[0];
    if (firstDocument === undefined) throw new Error("Fixture inventory has no document.");
    firstDocument.text = `${firstDocument.text}tampered`;
    expect(() => verifyShippedJavaScriptLicenseInventory(tampered)).toThrow("hash differs");
    expect(firstDocument.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(createHash("sha256").update(firstDocument.text).digest("hex"))
      .not.toBe(firstDocument.sha256);
  });
});
