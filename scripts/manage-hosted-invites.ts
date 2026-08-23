import { isAbsolute, resolve } from "node:path";

import { z } from "zod";

import {
  digestInviteCapability,
  generateInviteAuthority,
  identityInviteLifetimeMs,
  invitePublicIdFromCapabilityDigest,
} from "../src/cloud/inviteAuthority";

import {
  readProtectedInviteCapability,
  reserveCapabilityFile,
  type CapabilitySink,
} from "./bootstrap-hosted-sync";
import {
  buildConvexChildEnvironment,
  runCommand,
  type CommandResult,
  type CommandRunner,
} from "./configure-hosted-sync";
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

const publicIdSchema = z.string().regex(/^invite_[A-Za-z0-9_-]{32}$/u);
const identityInviteCapabilitySchema = z.string()
  .regex(/^hra_invite_identity_v1_[A-Za-z0-9_-]{43}$/u);

const issueResultSchema = z.object({
  expiresAt: z.number().finite().positive(),
  publicId: publicIdSchema,
  purpose: z.literal("identity"),
  replay: z.boolean(),
  state: z.literal("issued"),
}).strict();

const localAuthoritySchema = z.object({
  capability: identityInviteCapabilitySchema,
  capabilityDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  publicId: publicIdSchema,
}).strict();

const statusResultSchema = z.object({
  bound: z.boolean(),
  consumedAt: z.number().finite().nonnegative().nullable(),
  createdAt: z.number().finite().nonnegative(),
  expired: z.boolean(),
  expiresAt: z.number().finite().positive(),
  publicId: publicIdSchema,
  purpose: z.literal("identity"),
  state: z.enum(["bound_to_email", "consumed", "issued", "revoked"]),
  updatedAt: z.number().finite().nonnegative(),
}).strict();

const revokeResultSchema = statusResultSchema.extend({
  replay: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.state !== "revoked" && value.state !== "consumed") {
    context.addIssue({
      code: "custom",
      message: "revocation did not reach a terminal state",
    });
  }
  if (value.state === "consumed" && !value.replay) {
    context.addIssue({
      code: "custom",
      message: "consumed invitation must be an idempotent terminal result",
    });
  }
});

type InviteOperatorFailureCode =
  | "convex_target_refused"
  | "invite_issue_failed"
  | "invite_input_refused"
  | "invite_output_refused"
  | "invite_result_invalid"
  | "invite_revoke_failed"
  | "invite_revoke_result_invalid"
  | "invite_status_failed"
  | "invite_status_result_invalid"
  | "usage_invalid";

class InviteOperatorError extends Error {
  readonly code: InviteOperatorFailureCode;

  constructor(code: InviteOperatorFailureCode) {
    super(code);
    this.name = "InviteOperatorError";
    this.code = code;
  }
}

export type HostedInviteOperation =
  | Readonly<{
      inviteOutput: string;
      kind: "issue";
    }>
  | Readonly<{
      inviteFile: string;
      kind: "recover";
    }>
  | Readonly<{
      kind: "revoke" | "status";
      publicId: string;
    }>;

type HostedInviteArguments = Readonly<{
  operation: HostedInviteOperation;
  target: ConvexTarget;
}>;

const isCapabilityFree = (value: string): boolean =>
  !inviteCapabilityPattern.test(value);

export function parseHostedInviteArguments(
  arguments_: readonly string[],
): HostedInviteArguments {
  let parsedTarget: ReturnType<typeof parseConvexTargetArguments>;
  try {
    parsedTarget = parseConvexTargetArguments(arguments_);
  } catch {
    throw new InviteOperatorError("usage_invalid");
  }
  const [command, flag, value, ...remaining] = parsedTarget.otherArguments;
  if (remaining.length !== 0 || value === undefined || !isCapabilityFree(value)) {
    throw new InviteOperatorError("usage_invalid");
  }
  if (command === "issue" && flag === "--invite-output") {
    if (
      value.length === 0
      || value.length > 4_096
      || !isAbsolute(value)
      || resolve(value) !== value
    ) throw new InviteOperatorError("usage_invalid");
    return {
      operation: { inviteOutput: value, kind: "issue" },
      target: parsedTarget.target,
    };
  }
  if (command === "recover" && flag === "--invite-file") {
    if (
      value.length === 0
      || value.length > 4_096
      || !isAbsolute(value)
      || resolve(value) !== value
    ) throw new InviteOperatorError("usage_invalid");
    return {
      operation: { inviteFile: value, kind: "recover" },
      target: parsedTarget.target,
    };
  }
  if (
    (command === "status" || command === "revoke")
    && flag === "--public-id"
    && publicIdSchema.safeParse(value).success
  ) {
    return {
      operation: { kind: command, publicId: value },
      target: parsedTarget.target,
    };
  }
  throw new InviteOperatorError("usage_invalid");
}

const parseJson = (output: string, code: InviteOperatorFailureCode): unknown => {
  if (
    output.trim().length === 0
    || Buffer.byteLength(output, "utf8") > convexOutputMaximumBytes
  ) throw new InviteOperatorError(code);
  try {
    return JSON.parse(output) as unknown;
  } catch {
    throw new InviteOperatorError(code);
  }
};

const issueArguments = (
  deployment: string,
  authority: Readonly<{
    capabilityDigest: string;
    publicId: string;
  }>,
): readonly string[] => [
  "run",
  "authInvites:recordIssue",
  JSON.stringify({
    capabilityDigest: authority.capabilityDigest,
    lifetimeMs: identityInviteLifetimeMs,
    publicId: authority.publicId,
    purpose: "identity",
  }),
  "--deployment",
  deployment,
];

const statusArguments = (deployment: string, publicId: string): readonly string[] => [
  "run",
  "authInvites:status",
  JSON.stringify({ publicId }),
  "--deployment",
  deployment,
];

const revokeArguments = (deployment: string, publicId: string): readonly string[] => [
  "run",
  "authInvites:revoke",
  JSON.stringify({ publicId }),
  "--deployment",
  deployment,
];

const convexCli = resolve(import.meta.dir, "..", "node_modules", "convex", "bin", "main.js");
const repositoryRoot = resolve(import.meta.dir, "..");

type PublicStatus = z.infer<typeof statusResultSchema>;
type RevokeStatus = z.infer<typeof revokeResultSchema>;
type LocalAuthority = z.infer<typeof localAuthoritySchema>;

export type HostedInviteOperatorResult =
  | Readonly<{
      invite: z.infer<typeof issueResultSchema>;
      operation: "issue";
    }>
  | Readonly<{
      invite: PublicStatus;
      operation: "recover";
    }>
  | Readonly<{
      invite: PublicStatus | null;
      operation: "status";
    }>
  | Readonly<{
      invite: RevokeStatus | null;
      operation: "revoke";
    }>;

type ManageOptions = Readonly<{
  authorityFactory?: () => Promise<LocalAuthority>;
  environment?: Readonly<NodeJS.ProcessEnv>;
  operation: HostedInviteOperation;
  readCapability?: (path: string) => Promise<string>;
  reserve?: (path: string) => Promise<CapabilitySink>;
  runner?: CommandRunner;
  target: ConvexTarget;
  verifyTarget?: ConvexTargetVerifier;
}>;

const validateLocalAuthority = async (value: unknown): Promise<LocalAuthority> => {
  const parsed = localAuthoritySchema.safeParse(value);
  if (!parsed.success) throw new InviteOperatorError("invite_result_invalid");
  const digest = await digestInviteCapability(parsed.data.capability, "identity");
  if (
    parsed.data.capabilityDigest !== digest
    || parsed.data.publicId !== invitePublicIdFromCapabilityDigest(digest)
  ) throw new InviteOperatorError("invite_result_invalid");
  return parsed.data;
};

const authorityForCapability = async (capability: string): Promise<LocalAuthority> => {
  const capabilityDigest = await digestInviteCapability(capability, "identity");
  return {
    capability,
    capabilityDigest,
    publicId: invitePublicIdFromCapabilityDigest(capabilityDigest),
  };
};

const parseStatus = (
  output: string,
  publicId: string,
): PublicStatus | null => {
  const parsed = statusResultSchema.nullable().safeParse(
    parseJson(output, "invite_status_result_invalid"),
  );
  if (!parsed.success || (parsed.data !== null && parsed.data.publicId !== publicId)) {
    throw new InviteOperatorError("invite_status_result_invalid");
  }
  return parsed.data;
};

const parseRevoke = (
  output: string,
  publicId: string,
): RevokeStatus | null => {
  const parsed = revokeResultSchema.nullable().safeParse(
    parseJson(output, "invite_revoke_result_invalid"),
  );
  if (!parsed.success || (parsed.data !== null && parsed.data.publicId !== publicId)) {
    throw new InviteOperatorError("invite_revoke_result_invalid");
  }
  return parsed.data;
};

export async function manageHostedInvite(
  options: ManageOptions,
): Promise<HostedInviteOperatorResult> {
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
  const invoke = async (
    arguments_: readonly string[],
    failureCode: InviteOperatorFailureCode,
  ): Promise<CommandResult> => {
    let result: CommandResult;
    try {
      result = await runner({
        arguments: [convexCli, ...arguments_],
        cwd: repositoryRoot,
        environment,
        executable: process.execPath,
        outputMaximumBytes: convexOutputMaximumBytes,
        stdin: "",
        timeoutMs: convexTimeoutMs,
      });
    } catch {
      throw new InviteOperatorError(failureCode);
    }
    if (result.exitCode !== 0) throw new InviteOperatorError(failureCode);
    return result;
  };
  const invokeWithPostflight = async (
    arguments_: readonly string[],
    failureCode: InviteOperatorFailureCode,
  ): Promise<CommandResult> => {
    try {
      return await invoke(arguments_, failureCode);
    } finally {
      await verifyTarget(target);
    }
  };

  if (options.operation.kind === "issue") {
    let sink: CapabilitySink;
    try {
      sink = await (options.reserve ?? reserveCapabilityFile)(
        options.operation.inviteOutput,
      );
    } catch {
      throw new InviteOperatorError("invite_output_refused");
    }
    let committed = false;
    try {
      const authority = await validateLocalAuthority(
        await (options.authorityFactory ?? (async () =>
          await generateInviteAuthority("identity")))(),
      );
      try {
        await sink.commit(authority.capability);
        committed = true;
      } catch {
        throw new InviteOperatorError("invite_output_refused");
      }
      const result = await invokeWithPostflight(
        issueArguments(target.deploymentName, authority),
        "invite_issue_failed",
      );
      const parsed = issueResultSchema.safeParse(
        parseJson(result.stdout, "invite_result_invalid"),
      );
      if (
        !parsed.success
        || parsed.data.publicId !== authority.publicId
      ) throw new InviteOperatorError("invite_result_invalid");
      return {
        invite: parsed.data,
        operation: "issue",
      };
    } catch (error: unknown) {
      if (!committed) await sink.abort().catch(() => undefined);
      throw error;
    }
  }

  if (options.operation.kind === "recover") {
    let capability: string;
    try {
      capability = await (options.readCapability ?? readProtectedInviteCapability)(
        options.operation.inviteFile,
      );
    } catch {
      throw new InviteOperatorError("invite_input_refused");
    }
    let authority: LocalAuthority;
    try {
      authority = await validateLocalAuthority(await authorityForCapability(capability));
    } catch {
      throw new InviteOperatorError("invite_input_refused");
    }
    const before = await invokeWithPostflight(
      statusArguments(target.deploymentName, authority.publicId),
      "invite_status_failed",
    );
    const existing = parseStatus(before.stdout, authority.publicId);
    if (existing !== null) return { invite: existing, operation: "recover" };

    let issueFailure: Error | undefined;
    try {
      const result = await invokeWithPostflight(
        issueArguments(target.deploymentName, authority),
        "invite_issue_failed",
      );
      const parsed = issueResultSchema.safeParse(
        parseJson(result.stdout, "invite_result_invalid"),
      );
      if (
        !parsed.success
        || parsed.data.publicId !== authority.publicId
      ) throw new InviteOperatorError("invite_result_invalid");
    } catch (error: unknown) {
      if (error instanceof ConvexTargetError) throw error;
      issueFailure = error instanceof Error
        ? error
        : new InviteOperatorError("invite_issue_failed");
    }

    const after = await invokeWithPostflight(
      statusArguments(target.deploymentName, authority.publicId),
      "invite_status_failed",
    );
    const recovered = parseStatus(after.stdout, authority.publicId);
    if (recovered === null) {
      if (issueFailure !== undefined) throw issueFailure;
      throw new InviteOperatorError("invite_result_invalid");
    }
    return { invite: recovered, operation: "recover" };
  }

  const before = await invokeWithPostflight(
    statusArguments(target.deploymentName, options.operation.publicId),
    "invite_status_failed",
  );
  const status = parseStatus(before.stdout, options.operation.publicId);
  if (options.operation.kind === "status") {
    return { invite: status, operation: "status" };
  }

  const revoked = await invokeWithPostflight(
    revokeArguments(target.deploymentName, options.operation.publicId),
    "invite_revoke_failed",
  );
  const revoke = parseRevoke(revoked.stdout, options.operation.publicId);
  if ((status === null) !== (revoke === null)) {
    throw new InviteOperatorError("invite_revoke_result_invalid");
  }
  return { invite: revoke, operation: "revoke" };
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

export async function executeHostedInviteOperator(
  options: ExecuteOptions,
): Promise<number> {
  try {
    const arguments_ = parseHostedInviteArguments(options.arguments);
    const result = await manageHostedInvite({
      ...(options.authorityFactory === undefined
        ? {}
        : { authorityFactory: options.authorityFactory }),
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      operation: arguments_.operation,
      ...(options.readCapability === undefined
        ? {}
        : { readCapability: options.readCapability }),
      ...(options.reserve === undefined ? {} : { reserve: options.reserve }),
      ...(options.runner === undefined ? {} : { runner: options.runner }),
      target: arguments_.target,
      ...(options.verifyTarget === undefined ? {} : { verifyTarget: options.verifyTarget }),
    });
    options.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error: unknown) {
    const code = error instanceof InviteOperatorError
      ? error.code
      : error instanceof ConvexTargetError
        ? "convex_target_refused"
        : "invite_result_invalid";
    options.stderr.write(`Hosted invite operator refused (${code}).\n`);
    return 1;
  }
}

if (import.meta.main) {
  const exitCode = await executeHostedInviteOperator({
    arguments: process.argv.slice(2),
    stderr: process.stderr,
    stdout: process.stdout,
  });
  process.exitCode = exitCode;
}
