import { createRequire } from "node:module";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "@hra-internal/schema";
import { parseConfigFileTextToJson } from "typescript";
import rawRuntimePins from "./runtime-versions.json";

const require = createRequire(import.meta.url);
const repositoryRoot = resolve(import.meta.dir, "../../..");

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const integritySchema = z.string().startsWith("sha512-");
const runtimePinsSchema = z
  .object({
    schemaVersion: z.literal(1),
    minimumMacOS: z.string().regex(/^\d+\.\d+$/u),
    codex: z
      .object({
        package: z.literal("@openai/codex"),
        version: z.string().min(1),
        packageIntegrity: integritySchema,
        platformPackage: z.literal("@openai/codex-darwin-arm64"),
        platformIntegrity: integritySchema,
        target: z.literal("aarch64-apple-darwin"),
        binarySha256: sha256Schema,
      })
      .strict(),
    git: z
      .object({
        providerPackage: z.literal("dugite"),
        providerVersion: z.string().min(1),
        providerIntegrity: integritySchema,
        version: z.string().min(1),
        release: z.string().min(1),
        asset: z.string().min(1),
        assetSha256: sha256Schema,
        binarySha256: sha256Schema,
      })
      .strict(),
  })
  .strict();

const packageJsonSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    license: z.string().min(1).optional(),
    optionalDependencies: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

const embeddedGitSchema = z.record(
  z.string(),
  z
    .object({
      name: z.string().min(1),
      url: z.string().url(),
      checksum: sha256Schema,
    })
    .strict(),
);

const bunLockSchema = z
  .object({
    packages: z.record(z.string(), z.array(z.unknown())),
  })
  .passthrough();

export const runtimePins = runtimePinsSchema.parse(rawRuntimePins);

export interface VerifiedRuntimePins {
  readonly codexBinary: string;
  readonly codexPackageRoot: string;
  readonly codexPlatformPackageJson: string;
  readonly codexVendorRoot: string;
  readonly gitBinary: string;
  readonly gitPackageRoot: string;
  readonly gitRoot: string;
}

export interface VerifiedRuntimePinMetadata {
  readonly codexPackageRoot: string;
  readonly gitPackageRoot: string;
}

async function parseJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function parseBunLock(path: string): Promise<unknown> {
  const parsed = parseConfigFileTextToJson(path, await readFile(path, "utf8"));
  if (parsed.error !== undefined) throw new Error("Bun lockfile is not valid JSONC");
  return parsed.config as unknown;
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await readFile(path));
  return hasher.digest("hex");
}

async function commandOutput(command: readonly string[]): Promise<string> {
  const child = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`${command[0]} exited with code ${String(exitCode)}`);
  return stdout.trim();
}

function assertEqual(actual: string | undefined, expected: string, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${expected}, received ${actual ?? "missing"}`);
  }
}

function lockIntegrity(lock: z.infer<typeof bunLockSchema>, key: string): string | undefined {
  const entry = lock.packages[key];
  const value = entry?.[3];
  return typeof value === "string" ? value : undefined;
}

function lockIdentifier(lock: z.infer<typeof bunLockSchema>, key: string): string | undefined {
  const entry = lock.packages[key];
  const value = entry?.[0];
  return typeof value === "string" ? value : undefined;
}

/**
 * Verifies the repository and package metadata that pins the macOS runtimes.
 * This intentionally does not resolve or execute a platform binary, so the
 * ordinary monorepo check remains portable on Linux CI.
 */
export async function verifyRuntimePinMetadata(): Promise<VerifiedRuntimePinMetadata> {
  const codexPackageJson = await realpath(require.resolve("@openai/codex/package.json"));
  const codexPackageRoot = dirname(codexPackageJson);
  const gitPackageJson = await realpath(require.resolve("dugite/package.json"));
  const gitPackageRoot = dirname(gitPackageJson);

  const [codexPackage, gitPackage, embeddedGit, lock] = await Promise.all([
    parseJsonFile(codexPackageJson).then((value) => packageJsonSchema.parse(value)),
    parseJsonFile(gitPackageJson).then((value) => packageJsonSchema.parse(value)),
    parseJsonFile(join(gitPackageRoot, "script", "embedded-git.json")).then((value) =>
      embeddedGitSchema.parse(value),
    ),
    parseBunLock(join(repositoryRoot, "bun.lock")).then((value) => bunLockSchema.parse(value)),
  ]);

  assertEqual(codexPackage.name, runtimePins.codex.package, "Codex package name");
  assertEqual(codexPackage.version, runtimePins.codex.version, "Codex package version");
  assertEqual(codexPackage.license, "Apache-2.0", "Codex package license");
  assertEqual(
    codexPackage.optionalDependencies?.[runtimePins.codex.platformPackage],
    `npm:@openai/codex@${runtimePins.codex.version}-darwin-arm64`,
    "Codex optional platform dependency",
  );
  assertEqual(gitPackage.name, runtimePins.git.providerPackage, "Git provider package name");
  assertEqual(gitPackage.version, runtimePins.git.providerVersion, "Git provider package version");

  assertEqual(
    lockIdentifier(lock, runtimePins.codex.package),
    `${runtimePins.codex.package}@${runtimePins.codex.version}`,
    "Codex lock package",
  );
  assertEqual(
    lockIdentifier(lock, runtimePins.codex.platformPackage),
    `${runtimePins.codex.package}@${runtimePins.codex.version}-darwin-arm64`,
    "Codex platform lock package",
  );
  assertEqual(
    lockIdentifier(lock, runtimePins.git.providerPackage),
    `${runtimePins.git.providerPackage}@${runtimePins.git.providerVersion}`,
    "Git provider lock package",
  );
  assertEqual(
    lockIntegrity(lock, runtimePins.codex.package),
    runtimePins.codex.packageIntegrity,
    "Codex lock integrity",
  );
  assertEqual(
    lockIntegrity(lock, runtimePins.codex.platformPackage),
    runtimePins.codex.platformIntegrity,
    "Codex platform lock integrity",
  );
  assertEqual(
    lockIntegrity(lock, runtimePins.git.providerPackage),
    runtimePins.git.providerIntegrity,
    "Git provider lock integrity",
  );

  const embedded = embeddedGit["darwin-arm64"];
  if (embedded === undefined) throw new Error("Dugite does not declare a darwin-arm64 runtime");
  assertEqual(embedded.name, runtimePins.git.asset, "Dugite Native asset name");
  assertEqual(embedded.checksum, runtimePins.git.assetSha256, "Dugite Native asset checksum");
  if (!embedded.url.includes(`/download/${runtimePins.git.release}/`)) {
    throw new Error("Dugite Native release URL does not match the runtime pin");
  }

  return { codexPackageRoot, gitPackageRoot };
}

export async function verifyRuntimePins(): Promise<VerifiedRuntimePins> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Full runtime verification requires Apple Silicon macOS");
  }
  const metadata = await verifyRuntimePinMetadata();
  const codexPackageJson = join(metadata.codexPackageRoot, "package.json");
  const codexPackageRoot = metadata.codexPackageRoot;
  const codexRequire = createRequire(codexPackageJson);
  const codexPlatformPackageJson = await realpath(
    codexRequire.resolve(`${runtimePins.codex.platformPackage}/package.json`),
  );
  const codexPlatformRoot = dirname(codexPlatformPackageJson);
  const codexVendorRoot = join(codexPlatformRoot, "vendor", runtimePins.codex.target);
  const codexBinary = await realpath(join(codexVendorRoot, "bin", "codex"));

  const gitPackageRoot = metadata.gitPackageRoot;
  const gitRoot = await realpath(join(gitPackageRoot, "git"));
  const gitBinary = await realpath(join(gitRoot, "bin", "git"));

  const codexPlatformPackage = await parseJsonFile(codexPlatformPackageJson).then((value) =>
    packageJsonSchema.parse(value),
  );

  assertEqual(codexPlatformPackage.name, runtimePins.codex.package, "Codex platform package name");
  assertEqual(
    codexPlatformPackage.version,
    `${runtimePins.codex.version}-darwin-arm64`,
    "Codex platform package version",
  );

  const [codexHash, gitHash, codexVersion, gitVersion] = await Promise.all([
    sha256(codexBinary),
    sha256(gitBinary),
    commandOutput([codexBinary, "--version"]),
    commandOutput([gitBinary, "--version"]),
  ]);
  assertEqual(codexHash, runtimePins.codex.binarySha256, "Codex binary SHA-256");
  assertEqual(gitHash, runtimePins.git.binarySha256, "Git binary SHA-256");
  assertEqual(codexVersion, `codex-cli ${runtimePins.codex.version}`, "Codex binary version");
  assertEqual(gitVersion, `git version ${runtimePins.git.version}`, "Git binary version");

  return {
    codexBinary,
    codexPackageRoot,
    codexPlatformPackageJson,
    codexVendorRoot,
    gitBinary,
    gitPackageRoot,
    gitRoot,
  };
}

if (import.meta.main) {
  if (process.argv.includes("--metadata-only")) {
    await verifyRuntimePinMetadata();
    process.stdout.write(
      `Verified portable metadata for Codex ${runtimePins.codex.version} and Git ${runtimePins.git.version}.\n`,
    );
  } else {
    await verifyRuntimePins();
    process.stdout.write(
      `Verified Codex ${runtimePins.codex.version} and Git ${runtimePins.git.version} runtime pins.\n`,
    );
  }
}
