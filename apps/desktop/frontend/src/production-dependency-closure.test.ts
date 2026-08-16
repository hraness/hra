import { expect, test } from "bun:test";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

interface PackageManifest {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly name: string;
  readonly optionalDependencies: Readonly<Record<string, string>>;
  readonly optionalPeers: ReadonlySet<string>;
  readonly peerDependencies: Readonly<Record<string, string>>;
}

function stringRecord(value: unknown, field: string): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return Object.fromEntries(Object.entries(value).map(([name, specifier]) => {
    if (typeof specifier !== "string") {
      throw new Error(`${field}.${name} must be a string.`);
    }
    return [name, specifier];
  }));
}

function packageManifest(value: unknown, file: string): PackageManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${file} must contain an object.`);
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (typeof record.name !== "string" || record.name.length === 0) {
    throw new Error(`${file} must declare a package name.`);
  }
  const peerMeta = record.peerDependenciesMeta;
  const optionalPeers = new Set<string>();
  if (peerMeta !== undefined) {
    if (typeof peerMeta !== "object" || peerMeta === null || Array.isArray(peerMeta)) {
      throw new Error(`${file} peerDependenciesMeta must be an object.`);
    }
    for (const [name, metadata] of Object.entries(peerMeta)) {
      if (
        typeof metadata === "object"
        && metadata !== null
        && !Array.isArray(metadata)
        && (metadata as Readonly<Record<string, unknown>>).optional === true
      ) optionalPeers.add(name);
    }
  }
  return {
    dependencies: stringRecord(record.dependencies, `${file} dependencies`),
    name: record.name,
    optionalDependencies: stringRecord(
      record.optionalDependencies,
      `${file} optionalDependencies`,
    ),
    optionalPeers,
    peerDependencies: stringRecord(record.peerDependencies, `${file} peerDependencies`),
  };
}

async function findInstalledPackageJson(
  importer: string,
  dependency: string,
): Promise<string | null> {
  let cursor = importer;
  while (true) {
    const candidate = path.join(cursor, "node_modules", dependency, "package.json");
    try {
      const status = await lstat(candidate);
      if (!status.isFile() && !status.isSymbolicLink()) {
        throw new Error(`${candidate} is not a package manifest.`);
      }
      return await realpath(candidate);
    } catch (reason: unknown) {
      if (!(reason instanceof Error && "code" in reason && reason.code === "ENOENT")) {
        throw reason;
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

async function installedProductionPackageNames(rootManifest: string): Promise<ReadonlySet<string>> {
  const pending = [await realpath(rootManifest)];
  const visited = new Set<string>();
  const names = new Set<string>();
  while (pending.length > 0) {
    const manifestFile = pending.pop();
    if (manifestFile === undefined || visited.has(manifestFile)) continue;
    visited.add(manifestFile);
    const manifest = packageManifest(
      JSON.parse(await readFile(manifestFile, "utf8")) as unknown,
      manifestFile,
    );
    names.add(manifest.name);
    const optional = new Set(Object.keys(manifest.optionalDependencies));
    const dependencies = new Set([
      ...Object.keys(manifest.dependencies),
      ...optional,
      ...Object.keys(manifest.peerDependencies),
    ]);
    for (const dependency of [...dependencies].sort()) {
      const dependencyManifest = await findInstalledPackageJson(
        path.dirname(manifestFile),
        dependency,
      );
      if (dependencyManifest !== null) {
        pending.push(dependencyManifest);
        continue;
      }
      if (optional.has(dependency) || manifest.optionalPeers.has(dependency)) continue;
      throw new Error(`${manifest.name} has no installed production dependency ${dependency}.`);
    }
  }
  return names;
}

test("the installed desktop production closure excludes shared icon galleries", async () => {
  const packageJson = path.resolve(import.meta.dir, "../..", "package.json");
  const names = await installedProductionPackageNames(packageJson);

  expect(names.has("react-aria-components")).toBeTrue();
  expect(names.has("@hraness/ui")).toBeFalse();
  expect(names.has("@hra-internal/design-kit")).toBeFalse();
  expect(names.has("@hugeicons/core-free-icons")).toBeFalse();
  expect(names.has("@hugeicons/react")).toBeFalse();
});
