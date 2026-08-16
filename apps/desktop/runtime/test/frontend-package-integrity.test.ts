import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  link,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  FrontendPackageIntegrityError,
  FRONTEND_PACKAGE_LIMITS,
  parseNativeAssetManifest,
  readStableRegularFile,
  validateFrontendBuild,
  verifyPackagedFrontend,
} from "../frontend-package-integrity";
import {
  PackageOutputPreparationError,
  preparePackageOutput,
} from "../prepare-package-output";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, {
      force: true,
      recursive: true,
    })),
  );
});

describe("frontend build integrity", () => {
  test("accepts a nonblank entry whose local assets all exist", async () => {
    const fixture = await createFixture();

    const inventory = await validateFrontendBuild({
      sourceDirectory: fixture.sourceDirectory,
    });

    expect(inventory.files.map((file) => file.relativePath)).toEqual([
      ".vite/manifest.json",
      "assets/app.css",
      "assets/app.js",
      "index.html",
    ]);
    expect(inventory.referencedAssets).toEqual([
      "assets/app.css",
      "assets/app.js",
    ]);
  });

  test("rejects absent, blank, dangling, and remote executable entries", async () => {
    const fixture = await createFixture();
    await rm(join(fixture.sourceDirectory, "index.html"));
    expect(validateFrontendBuild({
      sourceDirectory: fixture.sourceDirectory,
    })).rejects.toMatchObject({ code: "missing_entry" });

    await writeFile(join(fixture.sourceDirectory, "index.html"), " \n");
    expect(validateFrontendBuild({
      sourceDirectory: fixture.sourceDirectory,
    })).rejects.toMatchObject({ code: "invalid_entry" });

    await writeFile(
      join(fixture.sourceDirectory, "index.html"),
      "<script src=\"./assets/missing.js\"></script>",
    );
    expect(validateFrontendBuild({
      sourceDirectory: fixture.sourceDirectory,
    })).rejects.toMatchObject({ code: "missing_asset" });

    await writeFile(
      join(fixture.sourceDirectory, "index.html"),
      "<script src=\"https://example.test/app.js\"></script>",
    );
    expect(validateFrontendBuild({
      sourceDirectory: fixture.sourceDirectory,
    })).rejects.toMatchObject({ code: "non_local_executable_asset" });
  });

  test("rejects reserved manifests and symlinks anywhere in the source tree", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.sourceDirectory, "asset-manifest.zon"),
      ".{ .assets = .{} }\n",
    );
    expect(validateFrontendBuild({
      sourceDirectory: fixture.sourceDirectory,
    })).rejects.toMatchObject({ code: "reserved_asset_path" });

    await rm(join(fixture.sourceDirectory, "asset-manifest.zon"));
    await symlink(
      join(fixture.sourceDirectory, "assets/app.js"),
      join(fixture.sourceDirectory, "assets/alias.js"),
    );
    expect(validateFrontendBuild({
      sourceDirectory: fixture.sourceDirectory,
    })).rejects.toMatchObject({ code: "invalid_file_type" });

    await rm(join(fixture.sourceDirectory, "assets/alias.js"));
    await link(
      join(fixture.sourceDirectory, "assets/app.js"),
      join(fixture.sourceDirectory, "assets/hard.js"),
    );
    expect(validateFrontendBuild({
      sourceDirectory: fixture.sourceDirectory,
    })).rejects.toMatchObject({ code: "invalid_file_type" });
  });

  test("proves dynamic imports and rejects unreachable emitted chunks", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.sourceDirectory, "assets/lazy.js"), "lazy();\n");
    await writeViteManifest(fixture, {
      "index.html": {
        file: "assets/app.js",
        src: "index.html",
        isEntry: true,
        css: ["assets/app.css"],
        dynamicImports: ["src/lazy.ts"],
      },
      "src/lazy.ts": {
        file: "assets/lazy.js",
        src: "src/lazy.ts",
        isDynamicEntry: true,
      },
    });
    expect(validateFrontendBuild({
      sourceDirectory: fixture.sourceDirectory,
    })).resolves.toMatchObject({
      referencedAssets: ["assets/app.css", "assets/app.js"],
    });

    await writeFile(join(fixture.sourceDirectory, "assets/stale.js"), "stale();\n");
    expect(validateFrontendBuild({
      sourceDirectory: fixture.sourceDirectory,
    })).rejects.toMatchObject({ code: "file_set_mismatch" });

    await rm(join(fixture.sourceDirectory, "assets/stale.js"));
    await writeViteManifest(fixture, {
      "index.html": {
        file: "assets/app.js",
        src: "index.html",
        isEntry: true,
        css: ["assets/app.css"],
        dynamicImports: ["src/missing.ts"],
      },
    });
    expect(validateFrontendBuild({
      sourceDirectory: fixture.sourceDirectory,
    })).rejects.toMatchObject({ code: "missing_asset" });
  });

  test("bounds file bytes and directory depth before asset reads", async () => {
    const oversized = await createFixture();
    await truncate(
      join(oversized.sourceDirectory, "assets/app.js"),
      FRONTEND_PACKAGE_LIMITS.maximumFileBytes + 1,
    );
    expect(validateFrontendBuild({
      sourceDirectory: oversized.sourceDirectory,
    })).rejects.toMatchObject({ code: "resource_limit" });

    const deep = await createFixture();
    const nested = Array.from(
      { length: FRONTEND_PACKAGE_LIMITS.maximumDirectoryDepth + 1 },
      (_, index) => `d${index}`,
    ).join("/");
    await mkdir(join(deep.sourceDirectory, nested), { recursive: true });
    expect(validateFrontendBuild({
      sourceDirectory: deep.sourceDirectory,
    })).rejects.toMatchObject({ code: "resource_limit" });
  });

  test("bounds concurrent file growth and truncation during stable reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "oprte-frontend-stable-read-"));
    temporaryRoots.push(root);
    const path = join(root, "asset.bin");
    const initialBytes = Buffer.alloc(2 * 64 * 1_024, 0x5a);

    await writeFile(path, initialBytes);
    let grew = false;
    expect(readStableRegularFile(
      path,
      initialBytes.byteLength,
      initialBytes.byteLength,
      async () => {
        grew = true;
        await appendFile(path, Buffer.from([0x7f]));
      },
    )).rejects.toMatchObject({ code: "file_changed_during_read" });
    expect(grew).toBe(true);

    await writeFile(path, initialBytes);
    let truncated = false;
    expect(readStableRegularFile(
      path,
      initialBytes.byteLength,
      initialBytes.byteLength,
      async () => {
        truncated = true;
        await truncate(path, initialBytes.byteLength - 1);
      },
    )).rejects.toMatchObject({ code: "file_changed_during_read" });
    expect(truncated).toBe(true);
  });

});

describe("Native SDK frontend package integrity", () => {
  test("verifies exact Native metadata and bytes with or without source", async () => {
    const fixture = await createFixture();
    await removeViteProof(fixture);

    expect(verifyPackagedFrontend({
      packageDirectory: fixture.packageDirectory,
      sourceDirectory: fixture.sourceDirectory,
    })).resolves.toBeUndefined();
    expect(verifyPackagedFrontend({
      packageDirectory: fixture.packageDirectory,
    })).resolves.toBeUndefined();
  });

  test("admits only one required exact oversized historical package asset", async () => {
    const fixture = await createFixture();
    const relativePath = "legacy/exact-oversized.bin";
    const byteLength = FRONTEND_PACKAGE_LIMITS.maximumFileBytes + 1;
    const sourcePath = join(fixture.sourceDirectory, relativePath);
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, "");
    await truncate(sourcePath, byteLength);
    await writeFixturePackage(fixture, [relativePath]);
    await removeViteProof(fixture);
    const sha256 = createHash("sha256")
      .update(await readFile(join(fixture.packageDirectory, relativePath)))
      .digest("hex");
    const requiredOversizedAsset = { byteLength, relativePath, sha256 };

    expect(verifyPackagedFrontend({
      packageDirectory: fixture.packageDirectory,
    })).rejects.toMatchObject({ code: "resource_limit" });
    expect(verifyPackagedFrontend({
      packageDirectory: fixture.packageDirectory,
      requiredOversizedAsset,
    })).resolves.toBeUndefined();
    expect(verifyPackagedFrontend({
      packageDirectory: fixture.packageDirectory,
      requiredOversizedAsset,
      sourceDirectory: fixture.sourceDirectory,
    })).rejects.toMatchObject({ code: "resource_limit" });

    expect(verifyPackagedFrontend({
      packageDirectory: fixture.packageDirectory,
      requiredOversizedAsset: {
        ...requiredOversizedAsset,
        relativePath: "legacy/alias.bin",
      },
    })).rejects.toMatchObject({ code: "resource_limit" });
    expect(verifyPackagedFrontend({
      packageDirectory: fixture.packageDirectory,
      requiredOversizedAsset: {
        ...requiredOversizedAsset,
        byteLength: byteLength + 1,
      },
    })).rejects.toMatchObject({ code: "manifest_asset_mismatch" });
    expect(verifyPackagedFrontend({
      packageDirectory: fixture.packageDirectory,
      requiredOversizedAsset: {
        ...requiredOversizedAsset,
        sha256: "0".repeat(64),
      },
    })).rejects.toMatchObject({ code: "manifest_asset_mismatch" });

    const missing = await createFixture();
    expect(verifyPackagedFrontend({
      packageDirectory: missing.packageDirectory,
      requiredOversizedAsset,
    })).rejects.toMatchObject({ code: "missing_asset" });

    const unrelatedPath = "legacy/unrelated-oversized.bin";
    const unrelatedSourcePath = join(fixture.sourceDirectory, unrelatedPath);
    await writeFile(unrelatedSourcePath, "");
    await truncate(unrelatedSourcePath, byteLength);
    await writeFixturePackage(fixture, [relativePath, unrelatedPath]);
    expect(verifyPackagedFrontend({
      packageDirectory: fixture.packageDirectory,
      requiredOversizedAsset,
    })).rejects.toMatchObject({ code: "resource_limit" });
  });

  test("rejects stale extras, missing files, and changed bytes", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.packageDirectory, "stale-empty"));
    expect(verifyPackagedFrontend({
      packageDirectory: fixture.packageDirectory,
    })).rejects.toMatchObject({ code: "file_set_mismatch" });

    await rm(join(fixture.packageDirectory, "stale-empty"), {
      recursive: true,
    });
    await writeFile(join(fixture.packageDirectory, "stale.js"), "stale");
    expect(verifyPackagedFrontend({
      packageDirectory: fixture.packageDirectory,
    })).rejects.toMatchObject({ code: "file_set_mismatch" });

    await rm(join(fixture.packageDirectory, "stale.js"));
    await rm(join(fixture.packageDirectory, "assets/app.js"));
    expect(verifyPackagedFrontend({
      packageDirectory: fixture.packageDirectory,
    })).rejects.toMatchObject({ code: "file_set_mismatch" });

    await writeFile(join(fixture.packageDirectory, "assets/app.js"), "changed");
    expect(verifyPackagedFrontend({
      packageDirectory: fixture.packageDirectory,
    })).rejects.toMatchObject({ code: "manifest_asset_mismatch" });
  });

  test("rejects source/package drift even when the package is self-consistent", async () => {
    const fixture = await createFixture();
    await removeViteProof(fixture);
    await writeFile(join(fixture.sourceDirectory, "assets/app.js"), "changed");

    expect(verifyPackagedFrontend({
      packageDirectory: fixture.packageDirectory,
      sourceDirectory: fixture.sourceDirectory,
    })).rejects.toMatchObject({ code: "manifest_asset_mismatch" });
  });

  test("rejects empty, malformed, duplicate, traversing, and unsafe manifests", () => {
    const invalid = [
      ".{ .assets = .{} }\n",
      ".{ .assets = .{\n  nope,\n} }\n",
      manifestText([
        manifestEntry("index.html", "x"),
        manifestEntry("index.html", "x"),
      ]),
      manifestText([manifestEntry("../index.html", "x")]),
      manifestText([manifestEntry("index.html", "x", Number.MAX_SAFE_INTEGER + 1)]),
    ];

    for (const text of invalid) {
      expect(() => parseNativeAssetManifest(text)).toThrow(
        FrontendPackageIntegrityError,
      );
    }
    expect(parseNativeAssetManifest(".{ .assets = .{\n} }\n")).toEqual([]);
  });

  test("rejects a blank package and symlinked package assets", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.packageDirectory, "asset-manifest.zon"),
      ".{ .assets = .{\n} }\n",
    );
    expect(verifyPackagedFrontend({
      packageDirectory: fixture.packageDirectory,
    })).rejects.toMatchObject({ code: "blank_package" });

    await writeFixturePackage(fixture);
    await rm(join(fixture.packageDirectory, "assets/app.js"));
    await symlink(
      join(fixture.sourceDirectory, "assets/app.js"),
      join(fixture.packageDirectory, "assets/app.js"),
    );
    expect(verifyPackagedFrontend({
      packageDirectory: fixture.packageDirectory,
    })).rejects.toMatchObject({ code: "invalid_file_type" });
  });
});

describe("package output preparation", () => {
  test("removes only the exact generated app after source validation", async () => {
    const fixture = await createFixture();
    const packageRoot = join(fixture.projectDirectory, "zig-out/package");
    const appBundlePath = join(
      packageRoot,
      "OPRTE-0.1.0-macos-ReleaseFast.app",
    );
    const sibling = join(packageRoot, "keep-me");
    await mkdir(appBundlePath, { recursive: true });
    await writeFile(join(appBundlePath, "stale"), "stale");
    await writeFile(sibling, "keep");

    await preparePackageOutput({
      appBundlePath,
      projectDirectory: fixture.projectDirectory,
      sourceDirectory: fixture.sourceDirectory,
    });

    expect(readFile(sibling, "utf8")).resolves.toBe("keep");
    expect(readFile(join(appBundlePath, "stale"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  test("refuses broad, malformed, symlinked, and non-directory targets", async () => {
    const fixture = await createFixture();
    const packageRoot = join(fixture.projectDirectory, "zig-out/package");
    expect(preparePackageOutput({
      appBundlePath: packageRoot,
      projectDirectory: fixture.projectDirectory,
      sourceDirectory: fixture.sourceDirectory,
    })).rejects.toBeInstanceOf(PackageOutputPreparationError);

    const wrongName = join(packageRoot, "Other.app");
    await mkdir(wrongName, { recursive: true });
    expect(preparePackageOutput({
      appBundlePath: wrongName,
      projectDirectory: fixture.projectDirectory,
      sourceDirectory: fixture.sourceDirectory,
    })).rejects.toBeInstanceOf(PackageOutputPreparationError);

    const fileTarget = join(packageRoot, "OPRTE-0.1.0-macos-Debug.app");
    await writeFile(fileTarget, "not a bundle");
    expect(preparePackageOutput({
      appBundlePath: fileTarget,
      projectDirectory: fixture.projectDirectory,
      sourceDirectory: fixture.sourceDirectory,
    })).rejects.toBeInstanceOf(PackageOutputPreparationError);

    await rm(fileTarget);
    const outside = join(fixture.root, "outside");
    await mkdir(outside);
    await symlink(outside, fileTarget);
    expect(preparePackageOutput({
      appBundlePath: fileTarget,
      projectDirectory: fixture.projectDirectory,
      sourceDirectory: fixture.sourceDirectory,
    })).rejects.toBeInstanceOf(PackageOutputPreparationError);
    expect(readFile(join(fixture.sourceDirectory, "index.html"), "utf8"))
      .resolves.toContain("assets/app.js");
  });

  test("does not remove an existing app when the fresh frontend is invalid", async () => {
    const fixture = await createFixture();
    const appBundlePath = join(
      fixture.projectDirectory,
      "zig-out/package/OPRTE-0.1.0-macos-ReleaseFast.app",
    );
    await mkdir(appBundlePath, { recursive: true });
    await writeFile(join(appBundlePath, "retained"), "retained");
    await rm(join(fixture.sourceDirectory, "assets/app.js"));

    expect(preparePackageOutput({
      appBundlePath,
      projectDirectory: fixture.projectDirectory,
      sourceDirectory: fixture.sourceDirectory,
    })).rejects.toMatchObject({ code: "missing_asset" });
    expect(readFile(join(appBundlePath, "retained"), "utf8"))
      .resolves.toBe("retained");
  });
});

interface Fixture {
  readonly packageDirectory: string;
  readonly projectDirectory: string;
  readonly root: string;
  readonly sourceDirectory: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "oprte-frontend-package-"));
  temporaryRoots.push(root);
  const projectDirectory = join(root, "desktop");
  const sourceDirectory = join(projectDirectory, "frontend/dist");
  const packageDirectory = join(
    projectDirectory,
    "fixture.app/Contents/Resources/frontend/dist",
  );
  await mkdir(join(sourceDirectory, "assets"), { recursive: true });
  await writeFile(
    join(sourceDirectory, "index.html"),
    [
      "<!doctype html>",
      "<link rel=\"stylesheet\" href=\"./assets/app.css?immutable=1\">",
      "<script type=\"module\" src=\"./assets/app.js\"></script>",
    ].join("\n"),
  );
  await writeFile(join(sourceDirectory, "assets/app.css"), "body{}\n");
  await writeFile(join(sourceDirectory, "assets/app.js"), "export {};\n");
  const fixture = { packageDirectory, projectDirectory, root, sourceDirectory };
  await writeViteManifest(fixture, {
    "index.html": {
      file: "assets/app.js",
      src: "index.html",
      isEntry: true,
      css: ["assets/app.css"],
    },
  });
  await writeFixturePackage(fixture);
  return fixture;
}

async function removeViteProof(fixture: Fixture): Promise<void> {
  await rm(join(fixture.sourceDirectory, ".vite"), {
    force: true,
    recursive: true,
  });
}

async function writeViteManifest(
  fixture: Fixture,
  value: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): Promise<void> {
  const directory = join(fixture.sourceDirectory, ".vite");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "manifest.json"),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

async function writeFixturePackage(
  fixture: Fixture,
  additionalPaths: readonly string[] = [],
): Promise<void> {
  await rm(fixture.packageDirectory, { force: true, recursive: true });
  await mkdir(join(fixture.packageDirectory, "assets"), { recursive: true });
  const paths = [
    "assets/app.css",
    "assets/app.js",
    ...additionalPaths,
    "index.html",
  ];
  const entries: string[] = [];
  for (const path of paths) {
    const bytes = await readFile(join(fixture.sourceDirectory, path));
    const packagePath = join(fixture.packageDirectory, path);
    await mkdir(dirname(packagePath), { recursive: true });
    await writeFile(packagePath, bytes);
    entries.push(manifestEntry(path, bytes));
  }
  await writeFile(
    join(fixture.packageDirectory, "asset-manifest.zon"),
    manifestText(entries),
  );
}

function manifestEntry(
  path: string,
  bytes: Buffer | string,
  byteLength?: number,
): string {
  const value = Buffer.from(bytes);
  return `  .{ .id = "${path}", .bundle_path = "${path}", .source_path = "frontend/dist/${path}", .byte_len = ${byteLength ?? value.byteLength}, .hash = "${createHash("sha256").update(value).digest("hex")}" },`;
}

function manifestText(entries: readonly string[]): string {
  return `.{ .assets = .{\n${entries.join("\n")}${entries.length === 0 ? "" : "\n"}} }\n`;
}
