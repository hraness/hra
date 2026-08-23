import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { z } from "zod";

import { canonicalCloudDeploymentUrl } from "../src/cloud/identity-custody";
import type { HraInstallation } from "../src/installation";
import { ensurePrivateDirectory, resolveStatePaths } from "../src/storage/paths";
import {
  FileSecretBackend,
  GenerationalSecretCustody,
} from "../src/storage/secret-custody";

const normalizedAbsolutePathSchema = z.string()
  .min(1)
  .max(4_096)
  .refine((value) => isAbsolute(value) && resolve(value) === value);

export const acceptanceInstallationDescriptorSchema = z.object({
  cloudDeploymentUrl: z.string().min(1).max(2_048).refine((value) => {
    try {
      return canonicalCloudDeploymentUrl(value) === value;
    } catch {
      return false;
    }
  }).optional(),
  device: z.enum(["a", "b"]),
  documentsDirectory: normalizedAbsolutePathSchema,
  expectedHomeDirectory: normalizedAbsolutePathSchema,
  rootDirectory: normalizedAbsolutePathSchema,
  runId: z.string().uuid(),
  type: z.literal("hra-live-acceptance-device"),
  version: z.literal(1),
}).strict();

export type AcceptanceInstallationDescriptor = z.infer<
  typeof acceptanceInstallationDescriptorSchema
>;

const acceptanceCodexConfig = [
  'cli_auth_credentials_store = "file"',
  'mcp_oauth_credentials_store = "file"',
  "",
].join("\n");

const maximumAcceptanceCodexConfigBytes = 4_096;
const acceptanceCodexInheritedEnvironmentKeys = [
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "USER",
] as const;

async function acceptanceCodexEnvironment(
  codexHome: string,
  expectedHomeDirectory: string,
): Promise<Readonly<Record<string, string>>> {
  const environment: Record<string, string> = {
    HOME: expectedHomeDirectory,
    TMPDIR: await ensurePrivateDirectory(join(codexHome, "tmp")),
  };
  for (const key of acceptanceCodexInheritedEnvironmentKeys) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

async function assertAcceptanceCodexConfig(configPath: string): Promise<void> {
  const currentUid = process.getuid?.();
  if (currentUid === undefined) {
    throw new Error("Live acceptance requires an operating system user ID.");
  }

  const handle = await open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || before.nlink !== 1
      || before.uid !== currentUid
      || (before.mode & 0o777) !== 0o600
      || before.size > maximumAcceptanceCodexConfigBytes
    ) {
      throw new Error("Acceptance CODEX_HOME has an unsafe credential-store configuration.");
    }

    const contents = Buffer.alloc(maximumAcceptanceCodexConfigBytes + 1);
    let length = 0;
    while (length < contents.length) {
      const read = await handle.read(contents, length, contents.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }

    const after = await handle.stat();
    if (
      !after.isFile()
      || after.nlink !== 1
      || after.uid !== currentUid
      || (after.mode & 0o777) !== 0o600
      || after.size > maximumAcceptanceCodexConfigBytes
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || length !== after.size
      || contents.subarray(0, length).toString("utf8") !== acceptanceCodexConfig
    ) {
      throw new Error("Acceptance CODEX_HOME has an unexpected credential-store configuration.");
    }
  } finally {
    await handle.close();
  }
}

async function prepareAcceptanceCodexHome(codexHome: string): Promise<void> {
  const canonicalHome = await ensurePrivateDirectory(codexHome);
  if (canonicalHome !== resolve(codexHome)) {
    throw new Error("Acceptance CODEX_HOME is not canonical.");
  }
  const configPath = join(canonicalHome, "config.toml");
  try {
    const handle = await open(
      configPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(acceptanceCodexConfig, "utf8");
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const directory = await open(canonicalHome, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await assertAcceptanceCodexConfig(configPath);
  await ensurePrivateDirectory(join(canonicalHome, "tmp"));
}

function assertDirectChild(parent: string, child: string, label: string): void {
  const relation = relative(parent, child);
  if (
    relation === ""
    || relation.startsWith("..")
    || isAbsolute(relation)
    || relation.includes("/")
    || relation.includes("\\")
  ) throw new Error(`${label} must be one direct child of the acceptance run root.`);
}

function pathsOverlap(leftInput: string, rightInput: string): boolean {
  const left = resolve(leftInput);
  const right = resolve(rightInput);
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  return left === right
    || (!leftToRight.startsWith("..") && !isAbsolute(leftToRight))
    || (!rightToLeft.startsWith("..") && !isAbsolute(rightToLeft));
}

export function createAcceptanceInstallation(
  descriptorInput: AcceptanceInstallationDescriptor,
): HraInstallation {
  const descriptor = acceptanceInstallationDescriptorSchema.parse(descriptorInput);
  const runRoot = resolve(descriptor.rootDirectory, "..");
  assertDirectChild(runRoot, descriptor.rootDirectory, "Acceptance state root");
  assertDirectChild(runRoot, descriptor.documentsDirectory, "Acceptance project root");
  if (descriptor.rootDirectory === descriptor.documentsDirectory) {
    throw new Error("Acceptance state and project roots must be distinct.");
  }
  if (
    !basename(runRoot).startsWith(`hra-live-acceptance-${descriptor.runId}-`)
    || !basename(descriptor.rootDirectory).startsWith(`device-${descriptor.device}-`)
    || !basename(descriptor.documentsDirectory).startsWith(`project-${descriptor.device}-`)
  ) throw new Error("Acceptance installation paths do not match their run identity.");
  const productionRoot = resolveStatePaths().root;
  if (
    pathsOverlap(runRoot, productionRoot)
    || pathsOverlap(runRoot, descriptor.expectedHomeDirectory)
  ) throw new Error("Acceptance state must not overlap production HRA state or the invoking home.");

  const cloudDeploymentUrl = descriptor.cloudDeploymentUrl === undefined
    ? undefined
    : canonicalCloudDeploymentUrl(descriptor.cloudDeploymentUrl);
  const paths = resolveStatePaths({ rootDirectory: descriptor.rootDirectory });
  const expectedHomeDirectory = descriptor.expectedHomeDirectory;
  return {
    cloudEnvironment: cloudDeploymentUrl === undefined
      ? { HRA_CONVEX_URL: "" }
      : { HRA_CONVEX_URL: cloudDeploymentUrl },
    codexEnvironment: async (codexHome) => await acceptanceCodexEnvironment(
      codexHome,
      expectedHomeDirectory,
    ),
    credentialStorePreflight: {
      cliAuth: "file",
      cwd: descriptor.documentsDirectory,
      mcpOauth: "file",
    },
    createSecretCustody: () => new GenerationalSecretCustody(
      paths,
      new FileSecretBackend(join(paths.root, "secret-values")),
    ),
    desktopSwitching: false,
    documentsDirectory: descriptor.documentsDirectory,
    expectedHomeDirectory,
    kind: "live_acceptance",
    paths,
    prepareCodexHome: prepareAcceptanceCodexHome,
  };
}
