const stableSemver = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const exactRegistryVersion = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function stringRecord(value: unknown, label: string): Readonly<Record<string, string>> {
  const source = record(value, label);
  const result: Record<string, string> = {};
  for (const [name, version] of Object.entries(source)) {
    if (typeof version !== "string") throw new Error(`${label} ${name} must be a string.`);
    result[name] = version;
  }
  return Object.freeze(result);
}

export type ReleasePackageInspection = Readonly<{
  blockers: readonly string[];
  name: "@hraness/hra";
  version: string;
}>;

export function releaseArchiveName(version: string): string {
  if (!stableSemver.test(version)) throw new Error("The HRA release version must be stable semantic versioning.");
  return `hraness-hra-${version}.tgz`;
}

export function inspectReleasePackage(value: unknown): ReleasePackageInspection {
  const manifest = record(value, "HRA package manifest");
  const publishConfig = record(manifest.publishConfig, "HRA publishConfig");
  const bin = record(manifest.bin, "HRA bin");
  const dependencies = stringRecord(manifest.dependencies, "HRA runtime dependency");
  if (
    manifest.name !== "@hraness/hra"
    || typeof manifest.version !== "string"
    || !stableSemver.test(manifest.version)
    || manifest.license !== "MIT"
    || publishConfig.access !== "public"
    || publishConfig.registry !== "https://registry.npmjs.org"
    || Object.keys(bin).length !== 1
    || bin.hra !== "./src/cli.ts"
  ) throw new Error("The HRA public package identity, license, registry, version, or binary is invalid.");

  const blockers = Object.entries(dependencies)
    .filter(([, version]) => !exactRegistryVersion.test(version))
    .map(([name, version]) => `${name}=${version}`)
    .sort();
  return Object.freeze({
    blockers: Object.freeze(blockers),
    name: "@hraness/hra",
    version: manifest.version,
  });
}

export function assertReleasePackageReady(value: unknown): ReleasePackageInspection {
  const inspection = inspectReleasePackage(value);
  if (inspection.blockers.length > 0) {
    throw new Error(`HRA release is blocked by non-registry runtime dependencies: ${inspection.blockers.join(", ")}`);
  }
  return inspection;
}
