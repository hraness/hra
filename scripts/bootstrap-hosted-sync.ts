import { constants } from "node:fs";
import {
  lstat,
  open,
  realpath,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import {
  buildConvexChildEnvironment,
  runCommand,
  type CommandRequest,
  type CommandResult,
  type CommandRunner,
} from "./configure-hosted-sync";
import {
  ConvexTargetError,
  parseConvexTarget,
  parseConvexTargetArguments,
  verifyConvexTarget,
  type ConvexTarget,
  type ConvexTargetVerifier,
} from "./convex-target";

const convexOutputMaximumBytes = 64 * 1024;
const identityInviteLifetimeMs = 24 * 60 * 60 * 1_000;
const authorityQuery = "return await ctx.db.query(\"storageUsageService\").take(2);";

const genesisResultSchema = z.object({
  enforcement: z.literal("hard"),
}).strict();

const authorityRowSchema = z.object({
  _creationTime: z.number().finite().nonnegative(),
  _id: z.string().min(1).max(256),
  enforcement: z.literal("hard"),
  identities: z.literal(0),
  key: z.literal("global"),
  logicalBytes: z.literal(0),
  records: z.literal(0),
  serviceLogicalBytes: z.literal(0),
  serviceRecords: z.literal(0),
  updatedAt: z.number().finite().nonnegative(),
  userLogicalBytes: z.literal(0),
  userRecords: z.literal(0),
}).strict();

const identityInviteCapabilitySchema = z.string()
  .regex(/^hra_invite_identity_v1_[A-Za-z0-9_-]{43}$/u);

const inviteResultSchema = z.object({
  capability: identityInviteCapabilitySchema,
  expiresAt: z.number().finite().positive(),
  publicId: z.string().regex(/^invite_[A-Za-z0-9_-]{32}$/u),
  purpose: z.literal("identity"),
  replay: z.literal(false),
  state: z.literal("issued"),
}).strict();

type BootstrapFailureCode =
  | "authority_dirty"
  | "authority_readback_invalid"
  | "genesis_failed"
  | "genesis_result_invalid"
  | "invite_issue_failed"
  | "invite_output_refused"
  | "invite_result_invalid"
  | "convex_target_refused"
  | "usage_invalid";

class BootstrapError extends Error {
  readonly code: BootstrapFailureCode;

  constructor(code: BootstrapFailureCode) {
    super(code);
    this.name = "BootstrapError";
    this.code = code;
  }
}

type BootstrapArguments = Readonly<{
  inviteOutput: string;
  target: ConvexTarget;
}>;

export function parseBootstrapArguments(arguments_: readonly string[]): BootstrapArguments {
  let parsedTarget: ReturnType<typeof parseConvexTargetArguments>;
  try {
    parsedTarget = parseConvexTargetArguments(arguments_);
  } catch {
    throw new BootstrapError("usage_invalid");
  }
  let inviteOutput: string | undefined;
  for (let index = 0; index < parsedTarget.otherArguments.length; index += 1) {
    const argument = parsedTarget.otherArguments[index];
    if (argument === "--invite-output" && inviteOutput === undefined) {
      const value = parsedTarget.otherArguments[index + 1];
      if (
        value === undefined
        || value.length === 0
        || value.length > 4_096
        || !isAbsolute(value)
        || resolve(value) !== value
      ) throw new BootstrapError("usage_invalid");
      inviteOutput = value;
      index += 1;
      continue;
    }
    throw new BootstrapError("usage_invalid");
  }
  if (inviteOutput === undefined) {
    throw new BootstrapError("usage_invalid");
  }
  return { inviteOutput, target: parsedTarget.target };
}

const parseJson = (output: string): unknown => {
  if (
    output.trim().length === 0
    || Buffer.byteLength(output, "utf8") > convexOutputMaximumBytes
  ) throw new BootstrapError("authority_readback_invalid");
  try {
    return JSON.parse(output) as unknown;
  } catch {
    throw new BootstrapError("authority_readback_invalid");
  }
};

const authorityArguments = (deployment: string): readonly string[] => [
  "run",
  "--inline-query",
  authorityQuery,
  "--deployment",
  deployment,
];

const genesisArguments = (deployment: string): readonly string[] => [
  "run",
  "quota:genesisHardAuthority",
  "{}",
  "--deployment",
  deployment,
];

const inviteArguments = (deployment: string): readonly string[] => [
  "run",
  "authInvites:issue",
  JSON.stringify({ lifetimeMs: identityInviteLifetimeMs, purpose: "identity" }),
  "--deployment",
  deployment,
];

const convexCli = resolve(import.meta.dir, "..", "node_modules", "convex", "bin", "main.js");
const repositoryRoot = resolve(import.meta.dir, "..");

export type CapabilitySink = Readonly<{
  abort: () => Promise<void>;
  commit: (capability: string) => Promise<void>;
}>;

type FileIdentity = Readonly<{ dev: number; ino: number }>;

const matchingPath = async (
  path: string,
  identity: FileIdentity,
): Promise<boolean> => {
  try {
    const current = await lstat(path);
    return current.isFile()
      && current.dev === identity.dev
      && current.ino === identity.ino;
  } catch {
    return false;
  }
};

const matchingProtectedPath = async (
  path: string,
  identity: FileIdentity,
): Promise<boolean> => {
  try {
    const current = await lstat(path);
    return current.isFile()
      && current.dev === identity.dev
      && current.ino === identity.ino
      && current.nlink === 1
      && (current.mode & 0o777) === 0o600;
  } catch {
    return false;
  }
};

const matchingDirectoryPath = async (
  path: string,
  identity: FileIdentity,
): Promise<boolean> => {
  try {
    const current = await lstat(path);
    return current.isDirectory()
      && current.dev === identity.dev
      && current.ino === identity.ino;
  } catch {
    return false;
  }
};

const closeQuietly = async (handle: FileHandle): Promise<void> => {
  await handle.close().catch(() => undefined);
};

export async function reserveCapabilityFile(path: string): Promise<CapabilitySink> {
  const name = basename(path);
  if (name.length === 0 || name === "." || name === "..") {
    throw new BootstrapError("invite_output_refused");
  }
  let canonicalParent: string;
  try {
    canonicalParent = await realpath(dirname(path));
  } catch {
    throw new BootstrapError("invite_output_refused");
  }
  const canonicalPath = join(canonicalParent, name);
  let parentHandle: FileHandle;
  try {
    parentHandle = await open(
      canonicalParent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch {
    throw new BootstrapError("invite_output_refused");
  }
  const parentIdentity = await parentHandle.stat().catch(async () => {
    await closeQuietly(parentHandle);
    throw new BootstrapError("invite_output_refused");
  });
  if (
    !parentIdentity.isDirectory()
    || !await matchingDirectoryPath(canonicalParent, parentIdentity)
  ) {
    await closeQuietly(parentHandle);
    throw new BootstrapError("invite_output_refused");
  }

  let handle: FileHandle;
  try {
    handle = await open(
      canonicalPath,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_WRONLY
        | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    await closeQuietly(parentHandle);
    throw new BootstrapError("invite_output_refused");
  }

  const identity = await handle.stat().catch(async () => {
    await closeQuietly(handle);
    await closeQuietly(parentHandle);
    throw new BootstrapError("invite_output_refused");
  });

  const removeReserved = async (): Promise<void> => {
    await closeQuietly(handle);
    if (
      await matchingDirectoryPath(canonicalParent, parentIdentity)
      && await matchingPath(canonicalPath, identity)
    ) {
      await unlink(canonicalPath).catch(() => undefined);
      await parentHandle.sync().catch(() => undefined);
    }
    await closeQuietly(parentHandle);
  };

  if (!identity.isFile() || identity.nlink !== 1) {
    await removeReserved();
    throw new BootstrapError("invite_output_refused");
  }
  try {
    await handle.chmod(0o600);
    const protectedStat = await handle.stat();
    if (
      (protectedStat.mode & 0o777) !== 0o600
      || protectedStat.nlink !== 1
      || !await matchingProtectedPath(canonicalPath, identity)
      || !await matchingDirectoryPath(canonicalParent, parentIdentity)
    ) {
      throw new BootstrapError("invite_output_refused");
    }
    await parentHandle.sync();
    if (
      !await matchingProtectedPath(canonicalPath, identity)
      || !await matchingDirectoryPath(canonicalParent, parentIdentity)
    ) throw new BootstrapError("invite_output_refused");
  } catch {
    await removeReserved();
    throw new BootstrapError("invite_output_refused");
  }

  let fileClosed = false;
  let parentClosed = false;
  let committed = false;
  const closeFile = async (): Promise<void> => {
    if (fileClosed) return;
    fileClosed = true;
    await handle.close();
  };
  const closeParent = async (): Promise<void> => {
    if (parentClosed) return;
    parentClosed = true;
    await parentHandle.close();
  };
  const abort = async (): Promise<void> => {
    await closeQuietly(handle);
    fileClosed = true;
    if (
      !committed
      && await matchingDirectoryPath(canonicalParent, parentIdentity)
      && await matchingPath(canonicalPath, identity)
    ) {
      await unlink(canonicalPath).catch(() => undefined);
      await parentHandle.sync().catch(() => undefined);
    }
    await closeQuietly(parentHandle);
    parentClosed = true;
  };
  return {
    abort,
    async commit(capability) {
      if (
        committed
        || fileClosed
        || parentClosed
        || !identityInviteCapabilitySchema.safeParse(capability).success
      ) {
        throw new BootstrapError("invite_output_refused");
      }
      try {
        if (
          !await matchingProtectedPath(canonicalPath, identity)
          || !await matchingDirectoryPath(canonicalParent, parentIdentity)
        ) throw new BootstrapError("invite_output_refused");
        await handle.writeFile(`${capability}\n`, "utf8");
        await handle.sync();
        const written = await handle.stat();
        if (
          !written.isFile()
          || written.dev !== identity.dev
          || written.ino !== identity.ino
          || written.nlink !== 1
          || (written.mode & 0o777) !== 0o600
          || !await matchingProtectedPath(canonicalPath, identity)
          || !await matchingDirectoryPath(canonicalParent, parentIdentity)
        ) throw new BootstrapError("invite_output_refused");
        await parentHandle.sync();
        if (
          !await matchingProtectedPath(canonicalPath, identity)
          || !await matchingDirectoryPath(canonicalParent, parentIdentity)
        ) {
          throw new BootstrapError("invite_output_refused");
        }
        committed = true;
        await closeFile().catch(() => undefined);
        await closeParent().catch(() => undefined);
      } catch {
        await abort();
        throw new BootstrapError("invite_output_refused");
      }
    },
  };
}

type BootstrapOptions = Readonly<{
  environment?: Readonly<NodeJS.ProcessEnv>;
  inviteOutput: string;
  reserve?: (path: string) => Promise<CapabilitySink>;
  runner?: CommandRunner;
  target: ConvexTarget;
  verifyTarget?: ConvexTargetVerifier;
}>;

export async function bootstrapHostedSync(options: BootstrapOptions): Promise<void> {
  const target = parseConvexTarget(options.target);
  const verifyTarget = options.verifyTarget ?? verifyConvexTarget;
  await verifyTarget(target);
  const environment = buildConvexChildEnvironment(options.environment ?? process.env, []);
  const runner = options.runner ?? runCommand;
  const invoke = async (arguments_: readonly string[]): Promise<CommandResult> =>
    await runner({
      arguments: [convexCli, ...arguments_],
      cwd: repositoryRoot,
      environment,
      executable: process.execPath,
      stdin: "",
    });

  const before = await invoke(authorityArguments(target.deploymentName));
  if (before.exitCode !== 0) throw new BootstrapError("authority_readback_invalid");
  const beforeValue = parseJson(before.stdout);
  if (!Array.isArray(beforeValue)) {
    throw new BootstrapError("authority_readback_invalid");
  }
  if (beforeValue.length !== 0) throw new BootstrapError("authority_dirty");

  const sink = await (options.reserve ?? reserveCapabilityFile)(options.inviteOutput);
  try {
    const genesis = await invoke(genesisArguments(target.deploymentName));
    if (genesis.exitCode !== 0) throw new BootstrapError("genesis_failed");
    try {
      genesisResultSchema.parse(parseJson(genesis.stdout));
    } catch {
      throw new BootstrapError("genesis_result_invalid");
    }

    const after = await invoke(authorityArguments(target.deploymentName));
    if (after.exitCode !== 0) throw new BootstrapError("authority_readback_invalid");
    try {
      z.tuple([authorityRowSchema]).parse(parseJson(after.stdout));
    } catch {
      throw new BootstrapError("authority_readback_invalid");
    }

    const invite = await invoke(inviteArguments(target.deploymentName));
    if (invite.exitCode !== 0) throw new BootstrapError("invite_issue_failed");
    let inviteResult: z.infer<typeof inviteResultSchema>;
    try {
      inviteResult = inviteResultSchema.parse(parseJson(invite.stdout));
    } catch {
      throw new BootstrapError("invite_result_invalid");
    }
    await verifyTarget(target);
    await sink.commit(inviteResult.capability);
  } catch (error: unknown) {
    await sink.abort();
    throw error;
  }
}

type ExecuteOptions = Readonly<{
  arguments: readonly string[];
  environment?: Readonly<NodeJS.ProcessEnv>;
  reserve?: (path: string) => Promise<CapabilitySink>;
  runner?: CommandRunner;
  stderr: Pick<NodeJS.WriteStream, "write">;
  stdout: Pick<NodeJS.WriteStream, "write">;
  verifyTarget?: ConvexTargetVerifier;
}>;

export async function executeHostedBootstrap(options: ExecuteOptions): Promise<number> {
  try {
    const arguments_ = parseBootstrapArguments(options.arguments);
    await bootstrapHostedSync({
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      inviteOutput: arguments_.inviteOutput,
      ...(options.reserve === undefined ? {} : { reserve: options.reserve }),
      ...(options.runner === undefined ? {} : { runner: options.runner }),
      target: arguments_.target,
      ...(options.verifyTarget === undefined ? {} : { verifyTarget: options.verifyTarget }),
    });
    options.stdout.write(
      "Hosted bootstrap verified hard zero authority and protected the first identity invite.\n",
    );
    return 0;
  } catch (error: unknown) {
    const code = error instanceof BootstrapError
      ? error.code
      : error instanceof ConvexTargetError
        ? "convex_target_refused"
        : "authority_readback_invalid";
    options.stderr.write(`Hosted bootstrap refused (${code}).\n`);
    return 1;
  }
}

if (import.meta.main) {
  const exitCode = await executeHostedBootstrap({
    arguments: process.argv.slice(2),
    stderr: process.stderr,
    stdout: process.stdout,
  });
  process.exitCode = exitCode;
}

export type { CommandRequest };
