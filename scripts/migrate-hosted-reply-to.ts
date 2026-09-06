import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { z } from "zod";

import {
  defaultHraOtpReplyTo,
  hraOtpReplyToEnvironmentName,
} from "../convex/otpEmailConfig";
import { createBoundedAuthorityFetch, type AuthorityFetcher } from "./bounded-authority-fetch";
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
} from "./authority-containment";
import {
  buildConvexChildEnvironment,
  runCommand,
  type CommandResult,
  type CommandRunner,
  type HOSTED_ENVIRONMENT_NAMES,
} from "./configure-hosted-sync";
import {
  ConvexTargetError,
  parseConvexTarget,
  parseConvexTargetArguments,
  verifyConvexDefaultTarget,
  type ConvexTarget,
  type ConvexTargetVerifier,
} from "./convex-target";
import {
  canonicalDigest,
  convexTargetEvidenceSchema,
  parseDeployEvidenceFile,
  readProtectedJson,
  ReleaseEvidenceError,
  runtimeReleaseAttestationSchema,
  withSelfDigest,
  writeProtectedJsonNoReplace,
  type DeployEvidence,
  type RuntimeReleaseAttestation,
} from "./release-evidence";

const repositoryRoot = resolve(import.meta.dir, "..");
const convexCli = resolve(repositoryRoot, "node_modules", "convex", "bin", "main.js");
const providerOutputMaximumBytes = 64 * 1024;
const gitOutputMaximumBytes = 64 * 1024;
const convexTimeoutMs = 60_000;
const releaseAttestationTimeoutMs = 30_000;
const sourceCommitPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;

type HostedEnvironmentName = (typeof HOSTED_ENVIRONMENT_NAMES)[number];
type ReplyToMigrationPrerequisite = Exclude<
  HostedEnvironmentName,
  typeof hraOtpReplyToEnvironmentName
>;

export const HOSTED_REPLY_TO_MIGRATION_PREREQUISITES:
readonly ReplyToMigrationPrerequisite[] = [
  "SITE_URL",
  "JWT_PRIVATE_KEY",
  "JWKS",
  "HRA_AUTH_HMAC_SECRET",
  "HRA_RESEND_API_KEY",
];

export const HOSTED_REPLY_TO_LEGACY_PREREQUISITE = "HRA_AUTH_EMAIL_FROM" as const;

const hostedReplyToMigrationRequiredNames = [
  ...HOSTED_REPLY_TO_MIGRATION_PREREQUISITES,
  HOSTED_REPLY_TO_LEGACY_PREREQUISITE,
  hraOtpReplyToEnvironmentName,
] as const;

export const HOSTED_REPLY_TO_VALUE_DIGEST = createHash("sha256")
  .update(defaultHraOtpReplyTo, "utf8")
  .digest("hex");

const bindingFields = {
  candidateDeployDigest: z.string().regex(digestPattern),
  fixedValueDigest: z.literal(HOSTED_REPLY_TO_VALUE_DIGEST),
  sourceCommit: z.string().regex(sourceCommitPattern),
  target: convexTargetEvidenceSchema,
  targetDigest: z.string().regex(digestPattern),
} as const;

export const hostedReplyToMigrationIntentSchema = z.object({
  ...bindingFields,
  kind: z.literal("hosted-reply-to-migration-intent"),
  schemaVersion: z.literal(1),
  selfDigest: z.string().regex(digestPattern),
}).strict().superRefine((value, context) => {
  if (value.targetDigest !== canonicalDigest(value.target)) {
    context.addIssue({ code: "custom", message: "migration_target_binding_invalid" });
  }
});

export const hostedReplyToMigrationReceiptSchema = z.object({
  ...bindingFields,
  intentDigest: z.string().regex(digestPattern),
  kind: z.literal("hosted-reply-to-migration-receipt"),
  schemaVersion: z.literal(1),
  selfDigest: z.string().regex(digestPattern),
  status: z.literal("completed"),
}).strict().superRefine((value, context) => {
  if (value.targetDigest !== canonicalDigest(value.target)) {
    context.addIssue({ code: "custom", message: "migration_target_binding_invalid" });
  }
});

export type HostedReplyToMigrationIntent = z.infer<
  typeof hostedReplyToMigrationIntentSchema
>;
export type HostedReplyToMigrationReceipt = z.infer<
  typeof hostedReplyToMigrationReceiptSchema
>;

type HostedReplyToMigrationFailureCode =
  | "candidate_deploy_evidence_invalid"
  | "convex_environment_ambiguous"
  | "convex_environment_query_failed"
  | "convex_environment_set_failed"
  | "convex_environment_verification_failed"
  | "convex_target_refused"
  | "migration_binding_changed"
  | "migration_evidence_invalid"
  | "migration_prerequisites_missing"
  | "migration_recovery_incomplete"
  | "release_attestation_invalid"
  | "reply_to_already_configured"
  | "reply_to_value_conflict"
  | "source_changed"
  | "usage_invalid";

class HostedReplyToMigrationError extends Error {
  constructor(readonly code: HostedReplyToMigrationFailureCode) {
    super(code);
    this.name = "HostedReplyToMigrationError";
  }
}

type HostedReplyToMigrationArguments = Readonly<{
  deployEvidencePath: string;
  evidencePath: string;
  sourceCommit: string;
  target: ConvexTarget;
}>;

const parseAbsolutePathArgument = (value: string | undefined): string => {
  if (value === undefined || !isAbsolute(value) || value.length > 4_096) {
    throw new HostedReplyToMigrationError("usage_invalid");
  }
  return value;
};

export function parseHostedReplyToMigrationArguments(
  arguments_: readonly string[],
): HostedReplyToMigrationArguments {
  let parsed: ReturnType<typeof parseConvexTargetArguments>;
  try {
    parsed = parseConvexTargetArguments(arguments_);
  } catch {
    throw new HostedReplyToMigrationError("usage_invalid");
  }
  let sourceCommit: string | undefined;
  let deployEvidencePath: string | undefined;
  let evidencePath: string | undefined;
  for (let index = 0; index < parsed.otherArguments.length; index += 1) {
    const argument = parsed.otherArguments[index];
    const value = parsed.otherArguments[index + 1];
    if (argument === "--source-commit" && sourceCommit === undefined) {
      if (value === undefined || !sourceCommitPattern.test(value)) {
        throw new HostedReplyToMigrationError("usage_invalid");
      }
      sourceCommit = value;
      index += 1;
      continue;
    }
    if (argument === "--deploy-evidence" && deployEvidencePath === undefined) {
      deployEvidencePath = parseAbsolutePathArgument(value);
      index += 1;
      continue;
    }
    if (argument === "--evidence-path" && evidencePath === undefined) {
      evidencePath = parseAbsolutePathArgument(value);
      index += 1;
      continue;
    }
    throw new HostedReplyToMigrationError("usage_invalid");
  }
  if (
    sourceCommit === undefined
    || deployEvidencePath === undefined
    || evidencePath === undefined
    || evidencePath === deployEvidencePath
    || `${evidencePath}.intent` === deployEvidencePath
  ) throw new HostedReplyToMigrationError("usage_invalid");
  return { deployEvidencePath, evidencePath, sourceCommit, target: parsed.target };
}

const parseEnvironmentNames = (result: CommandResult): ReadonlySet<string> => {
  if (
    result.exitCode !== 0
    || result.stderr !== ""
    || Buffer.byteLength(result.stdout, "utf8") > providerOutputMaximumBytes
  ) throw new HostedReplyToMigrationError("convex_environment_query_failed");
  const names = new Set<string>();
  for (const line of result.stdout.split(/\r?\n/gu)) {
    if (line.length === 0) continue;
    if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(line) || names.has(line)) {
      throw new HostedReplyToMigrationError("convex_environment_ambiguous");
    }
    names.add(line);
    if (names.size > 1_024) {
      throw new HostedReplyToMigrationError("convex_environment_ambiguous");
    }
  }
  return names;
};

const requirePrerequisites = (names: ReadonlySet<string>): void => {
  if (
    !HOSTED_REPLY_TO_MIGRATION_PREREQUISITES.every((name) => names.has(name))
    || !names.has(HOSTED_REPLY_TO_LEGACY_PREREQUISITE)
  ) {
    throw new HostedReplyToMigrationError("migration_prerequisites_missing");
  }
};

const environmentArguments = (deployment: string): readonly string[] => [
  "env",
  "list",
  "--names-only",
  "--deployment",
  deployment,
];

const setArguments = (deployment: string): readonly string[] => [
  "env",
  "set",
  "--deployment",
  deployment,
];

const getArguments = (deployment: string): readonly string[] => [
  "env",
  "get",
  hraOtpReplyToEnvironmentName,
  "--deployment",
  deployment,
];

export const serializeHostedReplyToMigration = (): string =>
  `${hraOtpReplyToEnvironmentName}='${defaultHraOtpReplyTo}'\n`;

type ReleaseAttestationReader = (
  target: ConvexTarget,
) => Promise<RuntimeReleaseAttestation>;

const releaseAttestationFunction = makeFunctionReference<
  "query",
  Record<string, never>,
  unknown
>("releaseAttestation:read");

const readRuntimeReleaseAttestation = (
  fetcher: AuthorityFetcher,
): ReleaseAttestationReader => async (target) => {
  const client = new ConvexHttpClient(target.deploymentUrl, {
    fetch: createBoundedAuthorityFetch(
      fetcher,
      releaseAttestationTimeoutMs,
      "convex_release_attestation_timeout",
    ),
    logger: false,
  });
  try {
    return runtimeReleaseAttestationSchema.parse(
      await client.query(releaseAttestationFunction, {}),
    );
  } catch {
    throw new HostedReplyToMigrationError("release_attestation_invalid");
  }
};

const sameCanonicalValue = (left: unknown, right: unknown): boolean =>
  canonicalDigest(left) === canonicalDigest(right);

const readOptionalProtectedJson = <T>(
  path: string,
  schema: z.ZodType<T>,
): T | undefined => {
  try {
    return readProtectedJson(path, schema, { recoverInterruptedPublication: true });
  } catch (error: unknown) {
    if (error instanceof ReleaseEvidenceError && error.code === "evidence_not_found") {
      return undefined;
    }
    throw error;
  }
};

type MigrateHostedReplyToOptions = Readonly<{
  authorityFetch?: AuthorityFetcher;
  deployEvidencePath: string;
  environment?: Readonly<NodeJS.ProcessEnv>;
  evidencePath: string;
  readAttestation?: ReleaseAttestationReader;
  repositoryRoot?: string;
  runner?: CommandRunner;
  sourceCommit: string;
  target: ConvexTarget;
  verifyTarget?: ConvexTargetVerifier;
}>;

export type HostedReplyToMigrationResult = Readonly<{
  receipt: HostedReplyToMigrationReceipt;
  replayed: boolean;
}>;

class ProviderInvocationUncertainError extends Error {
  constructor() {
    super("provider_invocation_uncertain");
    this.name = "ProviderInvocationUncertainError";
  }
}

export async function migrateHostedReplyTo(
  options: MigrateHostedReplyToOptions,
): Promise<HostedReplyToMigrationResult> {
  if (
    !sourceCommitPattern.test(options.sourceCommit)
    || !isAbsolute(options.deployEvidencePath)
    || !isAbsolute(options.evidencePath)
    || options.deployEvidencePath === options.evidencePath
    || options.deployEvidencePath === `${options.evidencePath}.intent`
  ) throw new HostedReplyToMigrationError("usage_invalid");
  const target = parseConvexTarget(options.target);
  const runner = options.runner ?? runCommand;
  const sourceRoot = options.repositoryRoot ?? repositoryRoot;
  const verifyTarget = options.verifyTarget ?? verifyConvexDefaultTarget;
  const readAttestation = options.readAttestation
    ?? readRuntimeReleaseAttestation(options.authorityFetch ?? fetch);
  const environment = buildConvexChildEnvironment(
    options.environment ?? process.env,
    [defaultHraOtpReplyTo],
  );
  const guard = new BoundedProcessInvocationGuard();
  const invokeGit = async (
    arguments_: readonly string[],
    phase: string,
  ): Promise<CommandResult> => await guard.observe(async () => await runner({
    arguments: arguments_,
    containment: "local",
    cwd: sourceRoot,
    environment,
    executable: "/usr/bin/git",
    outputMaximumBytes: gitOutputMaximumBytes,
    phase,
    stdin: "",
    timeoutMs: convexTimeoutMs,
  }));
  const requireExactSource = async (): Promise<void> => {
    const head = await invokeGit(
      ["rev-parse", "--verify", "HEAD^{commit}"],
      "hosted-reply-to-source-head",
    );
    if (
      head.exitCode !== 0
      || head.stderr !== ""
      || head.stdout !== `${options.sourceCommit}\n`
    ) throw new HostedReplyToMigrationError("source_changed");
    const status = await invokeGit(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      "hosted-reply-to-source-status",
    );
    if (status.exitCode !== 0 || status.stderr !== "" || status.stdout !== "") {
      throw new HostedReplyToMigrationError("source_changed");
    }
  };
  const invokeProvider = async (
    arguments_: readonly string[],
    phase: string,
    stdin = "",
  ): Promise<CommandResult> => {
    await guard.observe(async () => await verifyTarget(target));
    let result: CommandResult | undefined;
    let uncertain = false;
    try {
      result = await guard.observe(async () => await runner({
        arguments: [convexCli, ...arguments_],
        containment: "authority",
        cwd: repositoryRoot,
        environment,
        executable: process.execPath,
        outputMaximumBytes: providerOutputMaximumBytes,
        phase,
        stdin,
        timeoutMs: convexTimeoutMs,
      }));
    } catch (error: unknown) {
      if (
        isAuthorityContainmentUnavailable(error)
        || isBoundedProcessCleanupUnprovenError(error)
        || isBoundedProcessRecoveryJournalError(error)
      ) throw error;
      uncertain = true;
    }
    await guard.observe(async () => await verifyTarget(target));
    if (uncertain || result === undefined) throw new ProviderInvocationUncertainError();
    return result;
  };
  const readNames = async (phase: string): Promise<ReadonlySet<string>> => {
    let result: CommandResult;
    try {
      result = await invokeProvider(environmentArguments(target.deploymentName), phase);
    } catch (error: unknown) {
      if (error instanceof ProviderInvocationUncertainError) {
        throw new HostedReplyToMigrationError("convex_environment_query_failed");
      }
      throw error;
    }
    return parseEnvironmentNames(result);
  };
  const requireExactReplyTo = async (): Promise<void> => {
    let result: CommandResult;
    try {
      result = await invokeProvider(
        getArguments(target.deploymentName),
        "hosted-reply-to-value-read",
      );
    } catch (error: unknown) {
      if (error instanceof ProviderInvocationUncertainError) {
        throw new HostedReplyToMigrationError("convex_environment_verification_failed");
      }
      throw error;
    }
    if (
      result.exitCode !== 0
      || result.stderr !== ""
      || result.stdout !== `${defaultHraOtpReplyTo}\n`
    ) throw new HostedReplyToMigrationError("reply_to_value_conflict");
  };
  const requireCompleteEnvironment = async (): Promise<void> => {
    await requireExactReplyTo();
    const names = await readNames("hosted-reply-to-names-read");
    if (!hostedReplyToMigrationRequiredNames.every((name) => names.has(name))) {
      throw new HostedReplyToMigrationError("convex_environment_verification_failed");
    }
  };

  let candidate: DeployEvidence;
  try {
    candidate = parseDeployEvidenceFile(options.deployEvidencePath, {
      recoverInterruptedPublication: true,
    });
  } catch {
    throw new HostedReplyToMigrationError("candidate_deploy_evidence_invalid");
  }
  const targetDigest = canonicalDigest(target);
  if (
    candidate.phase !== "candidate"
    || candidate.sourceCommit !== options.sourceCommit
    || candidate.targetDigest !== targetDigest
    || !sameCanonicalValue(candidate.target, target)
  ) throw new HostedReplyToMigrationError("candidate_deploy_evidence_invalid");
  const candidateDeployDigest = candidate.selfDigest;
  const intent = hostedReplyToMigrationIntentSchema.parse(withSelfDigest({
    candidateDeployDigest,
    fixedValueDigest: HOSTED_REPLY_TO_VALUE_DIGEST,
    kind: "hosted-reply-to-migration-intent" as const,
    schemaVersion: 1 as const,
    sourceCommit: options.sourceCommit,
    target,
    targetDigest,
  }));
  const receipt = hostedReplyToMigrationReceiptSchema.parse(withSelfDigest({
    candidateDeployDigest,
    fixedValueDigest: HOSTED_REPLY_TO_VALUE_DIGEST,
    intentDigest: intent.selfDigest,
    kind: "hosted-reply-to-migration-receipt" as const,
    schemaVersion: 1 as const,
    sourceCommit: options.sourceCommit,
    status: "completed" as const,
    target,
    targetDigest,
  }));
  const intentPath = `${options.evidencePath}.intent`;

  const proveBinding = async (): Promise<void> => {
    await requireExactSource();
    let currentCandidate: DeployEvidence;
    try {
      currentCandidate = parseDeployEvidenceFile(options.deployEvidencePath, {
        recoverInterruptedPublication: true,
      });
    } catch {
      throw new HostedReplyToMigrationError("candidate_deploy_evidence_invalid");
    }
    if (
      currentCandidate.phase !== "candidate"
      || currentCandidate.sourceCommit !== options.sourceCommit
      || currentCandidate.selfDigest !== candidateDeployDigest
      || currentCandidate.targetDigest !== targetDigest
      || !sameCanonicalValue(currentCandidate.target, target)
    ) throw new HostedReplyToMigrationError("migration_binding_changed");
    await guard.observe(async () => await verifyTarget(target));
    let runtime: RuntimeReleaseAttestation;
    try {
      runtime = await readAttestation(target);
    } catch (error: unknown) {
      if (error instanceof HostedReplyToMigrationError) throw error;
      throw new HostedReplyToMigrationError("release_attestation_invalid");
    } finally {
      await guard.observe(async () => await verifyTarget(target));
    }
    if (!sameCanonicalValue(runtime, currentCandidate.after)) {
      throw new HostedReplyToMigrationError("release_attestation_invalid");
    }
    await requireExactSource();
  };

  const requireExactIntent = (): void => {
    const current = readOptionalProtectedJson(
      intentPath,
      hostedReplyToMigrationIntentSchema,
    );
    if (current === undefined || !sameCanonicalValue(current, intent)) {
      throw new HostedReplyToMigrationError("migration_binding_changed");
    }
  };
  const existingReceipt = readOptionalProtectedJson(
    options.evidencePath,
    hostedReplyToMigrationReceiptSchema,
  );
  const existingIntent = readOptionalProtectedJson(
    intentPath,
    hostedReplyToMigrationIntentSchema,
  );
  if (existingReceipt !== undefined || existingIntent !== undefined) {
    guard.retainRecoveryPath(options.evidencePath);
    guard.retainRecoveryPath(intentPath);
  }

  if (existingReceipt !== undefined) {
    if (
      existingIntent === undefined
      || !sameCanonicalValue(existingIntent, intent)
      || !sameCanonicalValue(existingReceipt, receipt)
    ) throw new HostedReplyToMigrationError("migration_binding_changed");
    await proveBinding();
    await requireCompleteEnvironment();
    await proveBinding();
    requireExactIntent();
    const currentReceipt = readOptionalProtectedJson(
      options.evidencePath,
      hostedReplyToMigrationReceiptSchema,
    );
    if (currentReceipt === undefined || !sameCanonicalValue(currentReceipt, receipt)) {
      throw new HostedReplyToMigrationError("migration_binding_changed");
    }
    return { receipt, replayed: true };
  }

  if (existingIntent !== undefined) {
    if (!sameCanonicalValue(existingIntent, intent)) {
      throw new HostedReplyToMigrationError("migration_binding_changed");
    }
    await proveBinding();
    try {
      await requireCompleteEnvironment();
    } catch (error: unknown) {
      if (error instanceof HostedReplyToMigrationError) {
        throw new HostedReplyToMigrationError("migration_recovery_incomplete");
      }
      throw error;
    }
    await proveBinding();
    requireExactIntent();
    writeProtectedJsonNoReplace(
      options.evidencePath,
      receipt,
      hostedReplyToMigrationReceiptSchema,
      { allowExactReplay: true },
    );
    return { receipt, replayed: true };
  }

  await proveBinding();
  const preflightNames = await readNames("hosted-reply-to-preflight-names");
  requirePrerequisites(preflightNames);
  if (preflightNames.has(hraOtpReplyToEnvironmentName)) {
    throw new HostedReplyToMigrationError("reply_to_already_configured");
  }
  writeProtectedJsonNoReplace(
    intentPath,
    intent,
    hostedReplyToMigrationIntentSchema,
    { allowExactReplay: false },
  );
  guard.retainRecoveryPath(options.evidencePath);
  guard.retainRecoveryPath(intentPath);

  await proveBinding();
  const freshNames = await readNames("hosted-reply-to-prewrite-names");
  requirePrerequisites(freshNames);
  if (freshNames.has(hraOtpReplyToEnvironmentName)) {
    await requireCompleteEnvironment();
  } else {
    await proveBinding();
    requireExactIntent();
    try {
      await invokeProvider(
        setArguments(target.deploymentName),
        "hosted-reply-to-set",
        serializeHostedReplyToMigration(),
      );
    } catch (error: unknown) {
      if (!(error instanceof ProviderInvocationUncertainError)) throw error;
    }
    try {
      await requireCompleteEnvironment();
    } catch (error: unknown) {
      if (
        error instanceof ConvexTargetError
        || isAuthorityContainmentUnavailable(error)
        || isBoundedProcessCleanupUnprovenError(error)
        || isBoundedProcessRecoveryJournalError(error)
      ) throw error;
      throw new HostedReplyToMigrationError("convex_environment_set_failed");
    }
  }

  await proveBinding();
  requireExactIntent();
  writeProtectedJsonNoReplace(
    options.evidencePath,
    receipt,
    hostedReplyToMigrationReceiptSchema,
    { allowExactReplay: true },
  );
  return { receipt, replayed: false };
}

type ExecuteHostedReplyToMigrationOptions = Readonly<{
  arguments: readonly string[];
  authorityFetch?: AuthorityFetcher;
  environment?: Readonly<NodeJS.ProcessEnv>;
  readAttestation?: ReleaseAttestationReader;
  repositoryRoot?: string;
  runner?: CommandRunner;
  stderr: Pick<NodeJS.WriteStream, "write">;
  stdout: Pick<NodeJS.WriteStream, "write">;
  verifyTarget?: ConvexTargetVerifier;
}>;

export async function executeHostedReplyToMigration(
  options: ExecuteHostedReplyToMigrationOptions,
): Promise<number> {
  try {
    const parsed = parseHostedReplyToMigrationArguments(options.arguments);
    const result = await migrateHostedReplyTo({
      ...(options.authorityFetch === undefined
        ? {}
        : { authorityFetch: options.authorityFetch }),
      deployEvidencePath: parsed.deployEvidencePath,
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      evidencePath: parsed.evidencePath,
      ...(options.readAttestation === undefined
        ? {}
        : { readAttestation: options.readAttestation }),
      ...(options.repositoryRoot === undefined ? {} : { repositoryRoot: options.repositoryRoot }),
      ...(options.runner === undefined ? {} : { runner: options.runner }),
      sourceCommit: parsed.sourceCommit,
      target: parsed.target,
      ...(options.verifyTarget === undefined ? {} : { verifyTarget: options.verifyTarget }),
    });
    options.stdout.write(`${JSON.stringify({
      evidenceDigest: result.receipt.selfDigest,
      evidencePath: parsed.evidencePath,
      replayed: result.replayed,
      schemaVersion: 1,
      sourceCommit: parsed.sourceCommit,
      status: "completed",
    })}\n`);
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
    const code = error instanceof HostedReplyToMigrationError
      ? error.code
      : error instanceof ConvexTargetError
        ? "convex_target_refused"
        : error instanceof ReleaseEvidenceError
          ? "migration_evidence_invalid"
          : "convex_environment_verification_failed";
    options.stderr.write(`Hosted Reply-To migration refused (${code}).\n`);
    return 1;
  }
}

if (import.meta.main) {
  let exitCode = 75;
  const rawArguments = process.argv.slice(2);
  let evidencePaths: readonly string[] = [];
  try {
    try {
      const parsed = parseHostedReplyToMigrationArguments(rawArguments);
      evidencePaths = [parsed.evidencePath, `${parsed.evidencePath}.intent`];
    } catch {
      // Argument validation remains authoritative after recovery completes.
    }
    try {
      await recoverBoundedProcessJournal();
    } catch (error: unknown) {
      let retained = error;
      for (const path of evidencePaths) {
        retained = retainBoundedProcessRecoveryPath(retained, path);
      }
      throw retained;
    }
    exitCode = await executeHostedReplyToMigration({
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
      process.stderr.write(
        "Hosted Reply-To migration refused (convex_environment_verification_failed).\n",
      );
      exitCode = 1;
    }
  }
  process.exitCode = exitCode;
}
