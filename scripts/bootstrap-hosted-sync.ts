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
import { getDocumentSize } from "convex/values";

import {
  digestInviteCapability,
  generateInviteAuthority,
  identityInviteLifetimeMs,
  invitePublicIdFromCapabilityDigest,
} from "../src/cloud/inviteAuthority";

import {
  buildConvexChildEnvironment,
  runCommand,
  type CommandRequest,
  type CommandResult,
  type CommandRunner,
} from "./configure-hosted-sync";
import {
  BoundedProcessInvocationGuard,
  isBoundedProcessCleanupUnprovenError,
  isBoundedProcessRecoveryJournalError,
  recoverBoundedProcessJournal,
  retainBoundedProcessRecoveryPath,
} from "./bounded-process";
import {
  isAuthorityContainmentUnavailable,
  renderAuthorityContainmentUnavailable,
  rethrowAuthorityContainmentUnavailable,
} from "./authority-containment";
import {
  ConvexTargetError,
  parseConvexTarget,
  parseConvexTargetArguments,
  verifyConvexDefaultTarget,
  type ConvexTarget,
  type ConvexTargetVerifier,
} from "./convex-target";

const convexOutputMaximumBytes = 64 * 1024;
const convexTimeoutMs = 60_000;
const inviteCapabilityPattern =
  /hra_invite_(?:device|identity)_v1_[A-Za-z0-9_-]{43}/u;
const preGenesisQuery = "return {quota:await ctx.db.query(\"storageUsageService\").take(2),control:await ctx.db.query(\"serviceControl\").take(2),maintenance:await ctx.db.query(\"maintenanceState\").take(2),invites:await ctx.db.query(\"authInvites\").take(2)};";
const authorityQuery = "return {quota:await ctx.db.query(\"storageUsageService\").take(2),control:await ctx.db.query(\"serviceControl\").take(2),invites:await ctx.db.query(\"authInvites\").take(2)};";

const genesisResultSchema = z.object({
  enforcement: z.literal("hard"),
  invite: z.object({
    expiresAt: z.number().finite().positive(),
    publicId: z.string().regex(/^invite_[A-Za-z0-9_-]{32}$/u),
    purpose: z.literal("identity"),
    state: z.literal("issued"),
  }).strict(),
  replay: z.boolean(),
}).strict();

const authorityRowSchema = z.object({
  _creationTime: z.number().finite().nonnegative(),
  _id: z.string().min(1).max(256),
  enforcement: z.literal("hard"),
  identities: z.literal(0),
  key: z.literal("global"),
  logicalBytes: z.number().int().positive().safe(),
  records: z.literal(1),
  serviceLogicalBytes: z.number().int().positive().safe(),
  serviceRecords: z.literal(1),
  updatedAt: z.number().finite().nonnegative(),
  userLogicalBytes: z.literal(0),
  userRecords: z.literal(0),
}).strict();

const controlRowSchema = z.object({
  _creationTime: z.number().finite().nonnegative(),
  _id: z.string().min(1).max(256),
  authAdmissionGeneration: z.literal(0),
  authAdmissions: z.literal("open"),
  bootstrapCompletedAt: z.number().finite().nonnegative(),
  bootstrapInviteCapabilityDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  bootstrapInviteLifetimeMs: z.literal(identityInviteLifetimeMs),
  bootstrapInvitePublicId: z.string().regex(/^invite_[A-Za-z0-9_-]{32}$/u),
  key: z.literal("global"),
  updatedAt: z.number().finite().nonnegative(),
}).strict();

const bootstrapInviteRowSchema = z.object({
  _creationTime: z.number().finite().nonnegative(),
  _id: z.string().min(1).max(256),
  admissionExpiresAt: z.number().finite().positive(),
  capabilityDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  createdAt: z.number().finite().nonnegative(),
  expiresAt: z.number().finite().positive(),
  publicId: z.string().regex(/^invite_[A-Za-z0-9_-]{32}$/u),
  purpose: z.literal("identity"),
  requestedLifetimeMs: z.literal(identityInviteLifetimeMs),
  state: z.literal("issued"),
  updatedAt: z.number().finite().nonnegative(),
}).strict();

const emptyAuthoritySchema = z.object({
  control: z.array(z.unknown()).max(2),
  invites: z.array(z.unknown()).max(2),
  maintenance: z.array(z.unknown()).max(2),
  quota: z.array(z.unknown()).max(2),
}).strict();

const hostedAuthoritySchema = z.object({
  control: z.tuple([controlRowSchema]),
  invites: z.tuple([bootstrapInviteRowSchema]),
  quota: z.tuple([authorityRowSchema]),
}).strict();

const identityInviteCapabilitySchema = z.string()
  .regex(/^hra_invite_identity_v1_[A-Za-z0-9_-]{43}$/u);

const inviteResultSchema = z.object({
  expiresAt: z.number().finite().positive(),
  publicId: z.string().regex(/^invite_[A-Za-z0-9_-]{32}$/u),
  purpose: z.literal("identity"),
  replay: z.boolean(),
  state: z.literal("issued"),
}).strict();

const localAuthoritySchema = z.object({
  capability: identityInviteCapabilitySchema,
  capabilityDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  publicId: z.string().regex(/^invite_[A-Za-z0-9_-]{32}$/u),
}).strict();

type LocalAuthority = z.infer<typeof localAuthoritySchema>;

type BootstrapFailureCode =
  | "authority_dirty"
  | "bootstrap_authority_conflict"
  | "authority_readback_invalid"
  | "genesis_failed"
  | "genesis_result_invalid"
  | "invite_input_refused"
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

type BootstrapOperation =
  | Readonly<{ inviteOutput: string; kind: "initialize" }>
  | Readonly<{ inviteFile: string; kind: "recover" }>;

type BootstrapArguments = Readonly<{
  operation: BootstrapOperation;
  target: ConvexTarget;
}>;

const parseProtectedAbsolutePath = (value: string | undefined): string => {
  if (
    value === undefined
    || value.length === 0
    || value.length > 4_096
    || !isAbsolute(value)
    || resolve(value) !== value
    || inviteCapabilityPattern.test(value)
  ) throw new BootstrapError("usage_invalid");
  return value;
};

export function parseBootstrapArguments(arguments_: readonly string[]): BootstrapArguments {
  let parsedTarget: ReturnType<typeof parseConvexTargetArguments>;
  try {
    parsedTarget = parseConvexTargetArguments(arguments_);
  } catch {
    throw new BootstrapError("usage_invalid");
  }
  const [commandOrFlag, flagOrValue, maybeValue, ...remaining] =
    parsedTarget.otherArguments;
  if (remaining.length !== 0) throw new BootstrapError("usage_invalid");
  if (commandOrFlag === "--invite-output" && maybeValue === undefined) {
    return {
      operation: {
        inviteOutput: parseProtectedAbsolutePath(flagOrValue),
        kind: "initialize",
      },
      target: parsedTarget.target,
    };
  }
  if (
    commandOrFlag === "recover"
    && flagOrValue === "--invite-file"
  ) {
    return {
      operation: {
        inviteFile: parseProtectedAbsolutePath(maybeValue),
        kind: "recover",
      },
      target: parsedTarget.target,
    };
  }
  throw new BootstrapError("usage_invalid");
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

const preGenesisArguments = (deployment: string): readonly string[] => [
  "run",
  "--inline-query",
  preGenesisQuery,
  "--deployment",
  deployment,
];

const genesisArguments = (
  deployment: string,
  authority: Pick<LocalAuthority, "capabilityDigest" | "publicId">,
): readonly string[] => [
  "run",
  "quota:genesisHostedAuthority",
  JSON.stringify({
    capabilityDigest: authority.capabilityDigest,
    lifetimeMs: identityInviteLifetimeMs,
    publicId: authority.publicId,
  }),
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
    const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
    return current.isFile()
      && !current.isSymbolicLink()
      && owner !== undefined
      && current.uid === owner
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
    const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
    return current.isDirectory()
      && !current.isSymbolicLink()
      && owner !== undefined
      && current.uid === owner
      && current.dev === identity.dev
      && current.ino === identity.ino
      && (current.mode & 0o777) === 0o700;
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
    || parentIdentity.isSymbolicLink()
    || typeof process.getuid !== "function"
    || parentIdentity.uid !== process.getuid()
    || (parentIdentity.mode & 0o777) !== 0o700
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

export async function readProtectedInviteCapability(path: string): Promise<string> {
  const name = basename(path);
  if (name.length === 0 || name === "." || name === "..") {
    throw new BootstrapError("invite_input_refused");
  }
  let canonicalParent: string;
  try {
    canonicalParent = await realpath(dirname(path));
  } catch {
    throw new BootstrapError("invite_input_refused");
  }
  const canonicalPath = join(canonicalParent, name);
  let parentHandle: FileHandle;
  try {
    parentHandle = await open(
      canonicalParent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch {
    throw new BootstrapError("invite_input_refused");
  }
  const parentIdentity = await parentHandle.stat().catch(async () => {
    await closeQuietly(parentHandle);
    throw new BootstrapError("invite_input_refused");
  });
  if (!await matchingDirectoryPath(canonicalParent, parentIdentity)) {
    await closeQuietly(parentHandle);
    throw new BootstrapError("invite_input_refused");
  }

  let handle: FileHandle;
  try {
    handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    await closeQuietly(parentHandle);
    throw new BootstrapError("invite_input_refused");
  }
  try {
    const before = await handle.stat();
    const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      owner === undefined
      || !before.isFile()
      || before.uid !== owner
      || before.nlink !== 1
      || (before.mode & 0o777) !== 0o600
      || before.size <= 0
      || before.size > 256
      || !await matchingDirectoryPath(canonicalParent, parentIdentity)
      || !await matchingProtectedPath(canonicalPath, before)
    ) throw new BootstrapError("invite_input_refused");
    const bytes = await handle.readFile();
    let document: string;
    try {
      document = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } finally {
      bytes.fill(0);
    }
    const after = await handle.stat();
    if (
      after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || !await matchingDirectoryPath(canonicalParent, parentIdentity)
      || !await matchingProtectedPath(canonicalPath, before)
    ) throw new BootstrapError("invite_input_refused");
    const capability = document.endsWith("\n") ? document.slice(0, -1) : "";
    if (
      document !== `${capability}\n`
      || !identityInviteCapabilitySchema.safeParse(capability).success
    ) throw new BootstrapError("invite_input_refused");
    return capability;
  } catch (error: unknown) {
    if (error instanceof BootstrapError) throw error;
    throw new BootstrapError("invite_input_refused");
  } finally {
    await closeQuietly(handle);
    await closeQuietly(parentHandle);
  }
}

type BootstrapRuntimeOptions = Readonly<{
  environment?: Readonly<NodeJS.ProcessEnv>;
  runner?: CommandRunner;
  target: ConvexTarget;
  verifyTarget?: ConvexTargetVerifier;
}>;

type BootstrapOptions = BootstrapRuntimeOptions & Readonly<{
  authorityFactory?: () => Promise<LocalAuthority>;
  inviteOutput: string;
  reserve?: (path: string) => Promise<CapabilitySink>;
}>;

type BootstrapRecoveryOptions = BootstrapRuntimeOptions & Readonly<{
  inviteFile: string;
  readCapability?: (path: string) => Promise<string>;
}>;

export type HostedBootstrapResult = Readonly<{
  invite: z.infer<typeof inviteResultSchema>;
  operation: "bootstrap" | "recover";
}>;

const validateLocalAuthority = async (value: unknown): Promise<LocalAuthority> => {
  const parsed = localAuthoritySchema.safeParse(value);
  if (!parsed.success) throw new BootstrapError("invite_result_invalid");
  const digest = await digestInviteCapability(parsed.data.capability, "identity");
  if (
    parsed.data.capabilityDigest !== digest
    || parsed.data.publicId !== invitePublicIdFromCapabilityDigest(digest)
  ) throw new BootstrapError("invite_result_invalid");
  return parsed.data;
};

const readHostedAuthority = (
  value: unknown,
  authority: LocalAuthority,
): z.infer<typeof bootstrapInviteRowSchema> => {
  const parsed = hostedAuthoritySchema.safeParse(value);
  if (!parsed.success) throw new BootstrapError("authority_readback_invalid");
  const control = parsed.data.control[0];
  const invite = parsed.data.invites[0];
  const quota = parsed.data.quota[0];
  const inviteLogicalBytes = getDocumentSize(invite);
  if (
    control.bootstrapCompletedAt !== control.updatedAt
    || control.bootstrapInviteCapabilityDigest !== authority.capabilityDigest
    || control.bootstrapInvitePublicId !== authority.publicId
    || invite.capabilityDigest !== authority.capabilityDigest
    || invite.publicId !== authority.publicId
    || invite.admissionExpiresAt !== invite.expiresAt
    || invite.expiresAt - invite.createdAt !== identityInviteLifetimeMs
    || invite.updatedAt !== invite.createdAt
    || quota.logicalBytes !== inviteLogicalBytes
    || quota.serviceLogicalBytes !== inviteLogicalBytes
  ) throw new BootstrapError("bootstrap_authority_conflict");
  return invite;
};

const authorityRowsSchema = z.object({
  control: z.array(z.unknown()).max(2),
  invites: z.array(z.unknown()).max(2),
  quota: z.array(z.unknown()).max(2),
}).strict();

type BootstrapInvoker = Readonly<{
  invoke: (arguments_: readonly string[], phase: string) => Promise<CommandResult>;
  invokeMutation: (arguments_: readonly string[], phase: string) => Promise<CommandResult>;
  retainRecoveryPath: (path: string) => void;
  target: ConvexTarget;
  verifyTarget: () => Promise<void>;
}>;

const createBootstrapInvoker = async (
  options: BootstrapRuntimeOptions,
): Promise<BootstrapInvoker> => {
  const target = parseConvexTarget(options.target);
  const verifyTarget = options.verifyTarget ?? verifyConvexDefaultTarget;
  await verifyTarget(target);
  const sourceEnvironment = options.environment ?? process.env;
  const forbiddenEnvironmentValues = Object.values(sourceEnvironment)
    .filter((value): value is string =>
      value !== undefined && inviteCapabilityPattern.test(value));
  const environment = buildConvexChildEnvironment(
    sourceEnvironment,
    forbiddenEnvironmentValues,
  );
  const runner = options.runner ?? runCommand;
  const guard = new BoundedProcessInvocationGuard();
  const invoke = async (
    arguments_: readonly string[],
    phase: string,
  ): Promise<CommandResult> => await guard.observe(async () => await runner({
      arguments: [convexCli, ...arguments_],
      containment: "authority",
      cwd: repositoryRoot,
      environment,
      executable: process.execPath,
      outputMaximumBytes: convexOutputMaximumBytes,
      phase,
      stdin: "",
      timeoutMs: convexTimeoutMs,
    }));
  const invokeMutation = async (
    arguments_: readonly string[],
    phase: string,
  ): Promise<CommandResult> => {
    let authorityUnavailable = false;
    let custodyFailure = false;
    try {
      return await invoke(arguments_, phase);
    } catch (error: unknown) {
      authorityUnavailable = isAuthorityContainmentUnavailable(error);
      custodyFailure = isBoundedProcessCleanupUnprovenError(error)
        || isBoundedProcessRecoveryJournalError(error);
      throw error;
    } finally {
      if (!authorityUnavailable && !custodyFailure) {
        await guard.observe(async () => await verifyTarget(target));
      }
    }
  };
  return {
    invoke,
    invokeMutation,
    retainRecoveryPath: (path) => guard.retainRecoveryPath(path),
    target,
    verifyTarget: async () => await guard.observe(async () => await verifyTarget(target)),
  };
};

const runHostedGenesis = async (
  invoker: BootstrapInvoker,
  authority: LocalAuthority,
): Promise<z.infer<typeof inviteResultSchema>> => {
  let mutationReplay: boolean | undefined;
  let mutationFailure: Error | undefined;
  try {
    const genesis = await invoker.invokeMutation(
      genesisArguments(invoker.target.deploymentName, authority),
      "hosted-bootstrap-genesis",
    );
    if (genesis.exitCode !== 0) {
      mutationFailure = new BootstrapError("genesis_failed");
    } else {
      let parsed: ReturnType<typeof genesisResultSchema.safeParse>;
      try {
        parsed = genesisResultSchema.safeParse(parseJson(genesis.stdout));
      } catch {
        parsed = genesisResultSchema.safeParse(undefined);
      }
      if (
        !parsed.success
        || parsed.data.invite.publicId !== authority.publicId
      ) {
        mutationFailure = new BootstrapError("genesis_result_invalid");
      } else {
        mutationReplay = parsed.data.replay;
      }
    }
  } catch (error: unknown) {
    if (error instanceof ConvexTargetError) throw error;
    if (isBoundedProcessCleanupUnprovenError(error)) throw error;
    if (isBoundedProcessRecoveryJournalError(error)) throw error;
    rethrowAuthorityContainmentUnavailable(error);
    mutationFailure = error instanceof Error
      ? error
      : new BootstrapError("genesis_failed");
  }

  const after = await invoker.invoke(
    authorityArguments(invoker.target.deploymentName),
    "hosted-bootstrap-authority-read",
  );
  if (after.exitCode !== 0) throw new BootstrapError("authority_readback_invalid");
  const afterValue = parseJson(after.stdout);
  let invite: z.infer<typeof bootstrapInviteRowSchema>;
  try {
    invite = readHostedAuthority(afterValue, authority);
  } catch (error: unknown) {
    const rows = authorityRowsSchema.safeParse(afterValue);
    if (
      rows.success
      && (
        rows.data.control.length !== 0
        || rows.data.invites.length !== 0
        || rows.data.quota.length !== 0
      )
    ) throw new BootstrapError("bootstrap_authority_conflict");
    if (mutationFailure !== undefined) throw mutationFailure;
    throw error;
  }
  await invoker.verifyTarget();
  return inviteResultSchema.parse({
    expiresAt: invite.expiresAt,
    publicId: invite.publicId,
    purpose: invite.purpose,
    replay: mutationReplay ?? true,
    state: invite.state,
  });
};

export async function bootstrapHostedSync(
  options: BootstrapOptions,
): Promise<HostedBootstrapResult> {
  const invoker = await createBootstrapInvoker(options);

  const before = await invoker.invoke(
    preGenesisArguments(invoker.target.deploymentName),
    "hosted-bootstrap-preflight-read",
  );
  if (before.exitCode !== 0) throw new BootstrapError("authority_readback_invalid");
  let beforeValue: z.infer<typeof emptyAuthoritySchema>;
  try {
    beforeValue = emptyAuthoritySchema.parse(parseJson(before.stdout));
  } catch {
    throw new BootstrapError("authority_readback_invalid");
  }
  if (
    beforeValue.control.length !== 0
    || beforeValue.invites.length !== 0
    || beforeValue.maintenance.length !== 0
    || beforeValue.quota.length !== 0
  ) {
    throw new BootstrapError("authority_dirty");
  }

  const sink = await (options.reserve ?? reserveCapabilityFile)(options.inviteOutput);
  let authority: LocalAuthority;
  try {
    authority = await validateLocalAuthority(
      await (options.authorityFactory ?? (async () =>
        await generateInviteAuthority("identity")))(),
    );
  } catch (error: unknown) {
    await sink.abort();
    throw error;
  }
  try {
    await sink.commit(authority.capability);
  } catch {
    await sink.abort();
    throw new BootstrapError("invite_output_refused");
  }
  invoker.retainRecoveryPath(options.inviteOutput);
  return {
    invite: await runHostedGenesis(invoker, authority),
    operation: "bootstrap",
  };
}

export async function recoverHostedBootstrap(
  options: BootstrapRecoveryOptions,
): Promise<HostedBootstrapResult> {
  const invoker = await createBootstrapInvoker(options);
  let capability: string;
  try {
    capability = await (options.readCapability ?? readProtectedInviteCapability)(
      options.inviteFile,
    );
  } catch {
    throw new BootstrapError("invite_input_refused");
  }
  const capabilityDigest = await digestInviteCapability(capability, "identity");
  const authority = await validateLocalAuthority({
    capability,
    capabilityDigest,
    publicId: invitePublicIdFromCapabilityDigest(capabilityDigest),
  });
  invoker.retainRecoveryPath(options.inviteFile);
  return {
    invite: await runHostedGenesis(invoker, authority),
    operation: "recover",
  };
}

type ExecuteOptions = Readonly<{
  arguments: readonly string[];
  authorityFactory?: () => Promise<LocalAuthority>;
  environment?: Readonly<NodeJS.ProcessEnv>;
  readCapability?: (path: string) => Promise<string>;
  reserve?: (path: string) => Promise<CapabilitySink>;
  runner?: CommandRunner;
  stderr: Pick<NodeJS.WriteStream, "write">;
  stdout: Pick<NodeJS.WriteStream, "write">;
  verifyTarget?: ConvexTargetVerifier;
}>;

export async function executeHostedBootstrap(options: ExecuteOptions): Promise<number> {
  try {
    const arguments_ = parseBootstrapArguments(options.arguments);
    const runtimeOptions = {
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.runner === undefined ? {} : { runner: options.runner }),
      target: arguments_.target,
      ...(options.verifyTarget === undefined ? {} : { verifyTarget: options.verifyTarget }),
    } as const;
    const result = arguments_.operation.kind === "initialize"
      ? await bootstrapHostedSync({
          ...runtimeOptions,
          ...(options.authorityFactory === undefined
            ? {}
            : { authorityFactory: options.authorityFactory }),
          inviteOutput: arguments_.operation.inviteOutput,
          ...(options.reserve === undefined ? {} : { reserve: options.reserve }),
        })
      : await recoverHostedBootstrap({
          ...runtimeOptions,
          inviteFile: arguments_.operation.inviteFile,
          ...(options.readCapability === undefined
            ? {}
            : { readCapability: options.readCapability }),
        });
    options.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error: unknown) {
    const authorityUnavailable = renderAuthorityContainmentUnavailable(error);
    if (authorityUnavailable !== undefined) {
      options.stderr.write(authorityUnavailable);
      return 1;
    }
    if (isBoundedProcessCleanupUnprovenError(error)) {
      options.stderr.write(`${JSON.stringify({
        code: "process_cleanup_unproven",
        phase: error.phase,
        processGroupId: error.processGroupId,
        processes: error.processes,
        recoveryPaths: error.recoveryPaths,
        schemaVersion: 1,
        status: "recovery_required",
      })}\n`);
      return 75;
    }
    if (isBoundedProcessRecoveryJournalError(error)) {
      options.stderr.write(`${JSON.stringify({
        code: "process_recovery_journal_blocked",
        reason: error.reason,
        recoveryPaths: error.recoveryPaths,
        schemaVersion: 1,
        status: "recovery_required",
      })}\n`);
      return 75;
    }
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
  let exitCode = 75;
  try {
    const rawArguments = process.argv.slice(2);
    let operatorRecoveryPath: string | undefined;
    try {
      const parsed = parseBootstrapArguments(rawArguments);
      operatorRecoveryPath = parsed.operation.kind === "initialize"
        ? parsed.operation.inviteOutput
        : parsed.operation.inviteFile;
    } catch {
      // Recovery remains authoritative even when a later argument parse would
      // refuse this invocation. Only validated absolute paths are retained.
    }
    try {
      await recoverBoundedProcessJournal();
    } catch (error: unknown) {
      throw operatorRecoveryPath === undefined
        ? error
        : retainBoundedProcessRecoveryPath(error, operatorRecoveryPath);
    }
    exitCode = await executeHostedBootstrap({
      arguments: rawArguments,
      stderr: process.stderr,
      stdout: process.stdout,
    });
  } catch (error: unknown) {
    const authorityUnavailable = renderAuthorityContainmentUnavailable(error);
    if (authorityUnavailable !== undefined) {
      process.stderr.write(authorityUnavailable);
      exitCode = 1;
    } else if (isBoundedProcessCleanupUnprovenError(error)) {
      process.stderr.write(`${JSON.stringify({
        code: "process_cleanup_unproven",
        phase: error.phase,
        processGroupId: error.processGroupId,
        processes: error.processes,
        recoveryPaths: error.recoveryPaths,
        schemaVersion: 1,
        status: "recovery_required",
      })}\n`);
    } else if (isBoundedProcessRecoveryJournalError(error)) {
      process.stderr.write(`${JSON.stringify({
        code: "process_recovery_journal_blocked",
        reason: error.reason,
        recoveryPaths: error.recoveryPaths,
        schemaVersion: 1,
        status: "recovery_required",
      })}\n`);
    } else {
      process.stderr.write("Hosted bootstrap refused (authority_readback_invalid).\n");
      exitCode = 1;
    }
  }
  process.exitCode = exitCode;
}

export type { CommandRequest };
