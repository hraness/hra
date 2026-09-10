import { createHash } from "node:crypto";
import { fstatSync, readlinkSync, type BigIntStats } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isatty } from "node:tty";

import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { z } from "zod";

import {
  oompaAttentionResendApiKeyEnvironmentName,
  oompaResendApiKeyEnvironmentName,
  isStrictResendApiKey,
  requireOompaAttentionResendApiKey,
} from "../convex/resendApiKey";
import {
  isAuthorityContainmentUnavailable,
  renderAuthorityContainmentUnavailable,
} from "./authority-containment";
import { createBoundedAuthorityFetch, type AuthorityFetcher } from "./bounded-authority-fetch";
import {
  isBoundedProcessCleanupUnprovenError,
  isBoundedProcessRecoveryJournalError,
  retainBoundedProcessRecoveryPath,
  rethrowBoundedProcessTerminalError,
} from "./bounded-process";
import {
  buildConvexChildEnvironment,
  HOSTED_ENVIRONMENT_NAMES,
  readProtectedInput,
  runCommand,
  type CommandRunner,
} from "./configure-hosted-sync";
import {
  parseConvexTarget,
  parseConvexTargetArguments,
  verifyConvexDefaultTarget,
  type ConvexTarget,
  type ConvexTargetVerifier,
} from "./convex-target";
import { attentionInactiveReadSchema } from "./hosted-status";
import {
  canonicalDigest,
  convexTargetEvidenceSchema,
  parseDeployEvidenceFile,
  readProtectedJson,
  runtimeReleaseAttestationSchema,
  withSelfDigest,
  writeProtectedJsonNoReplace,
  type RuntimeReleaseAttestation,
} from "./release-evidence";

const repositoryRoot = resolve(import.meta.dir, "..");
const convexCli = resolve(repositoryRoot, "node_modules", "convex", "bin", "main.js");
const outputMaximumBytes = 64 * 1024;
const commitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const inputSchema = z.object({ attentionResendApiKey: z.string() }).strict();
const inactiveSchema = z.object({
  generation: z.literal(0),
  globalState: z.literal("absent"),
  outboxOccupancy: z.literal(0),
  safetyFaultOccupancy: z.literal(0),
}).strict();

// This is observation evidence, never an apply intent or migration receipt.
// Convex 1.45 lists before updating {changes}; omitting --force is not CAS.
// There is deliberately no write-capable transport or apply phase here.
export const hostedAttentionKeyObservationSchema = z.object({
  candidateDeployDigest: digestSchema,
  effect: z.literal("none"),
  inactive: inactiveSchema,
  intendedKeyDigest: digestSchema,
  keyState: z.enum(["absent", "existing_equal", "existing_mismatched"]),
  kind: z.literal("hosted-attention-key-observation"),
  namesDigest: digestSchema,
  phase: z.enum(["prepare", "reconcile"]),
  preparationDigest: digestSchema.nullable(),
  providerWriteCapability: z.literal("unavailable"),
  schemaVersion: z.literal(1),
  selfDigest: digestSchema,
  sourceCommit: commitSchema,
  status: z.literal("observed_only"),
  target: convexTargetEvidenceSchema,
  targetDigest: digestSchema,
}).strict().superRefine((value, context) => {
  if (
    value.targetDigest !== canonicalDigest(value.target)
    || (value.phase === "prepare") !== (value.preparationDigest === null)
  ) context.addIssue({ code: "custom", message: "observation_binding_invalid" });
});

type FailureCode = "usage_invalid" | "input_invalid" | "input_not_protected" | "source_changed"
  | "candidate_mismatch" | "release_attestation_invalid" | "attention_not_inactive"
  | "environment_ambiguous" | "prerequisites_missing" | "otp_key_reused"
  | "prestate_changed" | "preparation_mismatch" | "observation_failed";

export class HostedAttentionKeyObservationError extends Error {
  constructor(readonly code: FailureCode) {
    super(code);
    this.name = "HostedAttentionKeyObservationError";
  }
}

type ObservationArguments = Readonly<{
  deployEvidencePath: string;
  evidencePath: string;
  phase: "prepare" | "reconcile";
  preparationEvidencePath?: string;
  sourceCommit: string;
  target: ConvexTarget;
}>;

const validateArguments = (value: ObservationArguments): void => {
  const paths = [value.deployEvidencePath, value.evidencePath];
  if (value.preparationEvidencePath !== undefined) paths.push(value.preparationEvidencePath);
  if (
    !commitSchema.safeParse(value.sourceCommit).success
    || !["prepare", "reconcile"].includes(value.phase)
    || (value.phase === "reconcile") !== (value.preparationEvidencePath !== undefined)
    || paths.some((path) => !isAbsolute(path) || path.length > 4_096 || path.includes("\0"))
    || new Set(paths.map((path) => resolve(path))).size !== paths.length
  ) throw new HostedAttentionKeyObservationError("usage_invalid");
};

export function parseHostedAttentionKeyObservationArguments(
  arguments_: readonly string[],
): ObservationArguments {
  const { target, otherArguments } = parseConvexTargetArguments(arguments_);
  const names = new Set([
    "--phase", "--source-commit", "--deploy-evidence", "--evidence-path",
    "--preparation-evidence",
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < otherArguments.length; index += 2) {
    const name = otherArguments[index];
    const value = otherArguments[index + 1];
    if (name === undefined || value === undefined || !names.has(name) || values.has(name)) {
      throw new HostedAttentionKeyObservationError("usage_invalid");
    }
    values.set(name, value);
  }
  const phase = values.get("--phase");
  if (phase !== "prepare" && phase !== "reconcile") {
    throw new HostedAttentionKeyObservationError("usage_invalid");
  }
  const preparationEvidencePath = values.get("--preparation-evidence");
  const parsed: ObservationArguments = {
    deployEvidencePath: values.get("--deploy-evidence") ?? "",
    evidencePath: values.get("--evidence-path") ?? "",
    phase,
    ...(preparationEvidencePath === undefined ? {} : { preparationEvidencePath }),
    sourceCommit: values.get("--source-commit") ?? "",
    target,
  };
  validateArguments(parsed);
  return parsed;
}

export function parseHostedAttentionKeyInput(document: string): string {
  try {
    if (Buffer.byteLength(document, "utf8") > 8 * 1024) throw new Error();
    // Credentials use a plain ASCII grammar. Reject duplicate fields and
    // alternate escaped spellings instead of silently accepting JSON's last key.
    if (!/^\s*\{\s*"attentionResendApiKey"\s*:\s*"[^"\\]*"\s*\}\s*$/u.test(document)) {
      throw new Error();
    }
    const input = inputSchema.parse(JSON.parse(document) as unknown);
    if (!isStrictResendApiKey(input.attentionResendApiKey)) throw new Error();
    return input.attentionResendApiKey;
  } catch {
    throw new HostedAttentionKeyObservationError("input_invalid");
  }
}

type PipeMetadata = Pick<BigIntStats, "dev" | "ino" | "mode" | "nlink" | "uid" | "isFIFO">;

export function requireProtectedAttentionKeyPipe(
  descriptor: number,
  dependencies: Readonly<{
    currentUid?: () => number | undefined;
    inspect?: (descriptor: number) => PipeMetadata;
    isTerminal?: (descriptor: number) => boolean;
    platform?: NodeJS.Platform;
    readLink?: (path: string) => string;
  }> = {},
): void {
  try {
    if (!Number.isSafeInteger(descriptor) || descriptor < 0) throw new Error();
    if ((dependencies.isTerminal ?? isatty)(descriptor)) throw new Error();
    const platform = dependencies.platform ?? process.platform;
    const inspect = dependencies.inspect ?? ((fd: number) => fstatSync(fd, { bigint: true }));
    const expectedUid = (dependencies.currentUid ?? (() => process.geteuid?.()))();
    const before = inspect(descriptor);
    if (
      expectedUid === undefined || !Number.isSafeInteger(expectedUid)
      || before.uid !== BigInt(expectedUid) || !before.isFIFO()
      || (platform !== "darwin" && platform !== "linux")
    ) throw new Error();
    if (platform === "darwin") {
      // Bun exposes Darwin's opaque 64-bit pipe identity as a signed bigint.
      // Compare it exactly below; its sign does not distinguish anonymous pipes.
      if (before.nlink !== 0n) throw new Error();
    } else {
      if (before.nlink !== 1n) throw new Error();
      const link = (dependencies.readLink ?? readlinkSync)(`/proc/self/fd/${descriptor}`);
      if (link !== `pipe:[${before.ino}]` || !/^pipe:\[[1-9][0-9]*\]$/u.test(link)) {
        throw new Error();
      }
    }
    const after = inspect(descriptor);
    if (!after.isFIFO() || (["dev", "ino", "mode", "nlink", "uid"] as const)
      .some((field) => before[field] !== after[field])) throw new Error();
  } catch {
    throw new HostedAttentionKeyObservationError("input_not_protected");
  }
}

export async function readProtectedAttentionKeyInput(descriptor = 0): Promise<string> {
  requireProtectedAttentionKeyPipe(descriptor);
  return await readProtectedInput(descriptor);
}

type ReadAttestation = (target: ConvexTarget) => Promise<RuntimeReleaseAttestation>;
type ObservationOptions = ObservationArguments & Readonly<{
  authorityFetch?: AuthorityFetcher;
  environment?: Readonly<NodeJS.ProcessEnv>;
  inputDocument: string;
  readAttestation?: ReadAttestation;
  repositoryRoot?: string;
  runner?: CommandRunner;
  verifyTarget?: ConvexTargetVerifier;
}>;

const readAttestationWith = (fetcher: AuthorityFetcher): ReadAttestation => async (target) => {
  const client = new ConvexHttpClient(target.deploymentUrl, {
    fetch: createBoundedAuthorityFetch(fetcher, 30_000, "convex_release_attestation_timeout"),
    logger: false,
  });
  return runtimeReleaseAttestationSchema.parse(await client.query(
    makeFunctionReference<"query", Record<string, never>, unknown>("releaseAttestation:read"),
    {},
  ));
};

const observe = async (options: ObservationOptions) => {
  validateArguments(options);
  const target = parseConvexTarget(options.target);
  const intendedKey = parseHostedAttentionKeyInput(options.inputDocument);
  const intendedKeyDigest = createHash("sha256")
    .update("oompa-attention-key-observation-v1\0", "utf8")
    .update(intendedKey, "utf8").digest("hex");
  const forbiddenValues = [intendedKey];
  const environment = () => Object.fromEntries(Object.entries(buildConvexChildEnvironment(
    options.environment ?? process.env, forbiddenValues,
  )).filter(([, value]) => !value.includes("re_")));
  const runner = options.runner ?? runCommand;
  const verifyTarget = options.verifyTarget ?? verifyConvexDefaultTarget;
  const readAttestation = options.readAttestation
    ?? readAttestationWith(options.authorityFetch ?? fetch);
  const sourceRoot = options.repositoryRoot ?? repositoryRoot;
  const source = async (): Promise<void> => {
    for (const [arguments_, expected] of [
      [["rev-parse", "--verify", "HEAD^{commit}"], `${options.sourceCommit}\n`],
      [["status", "--porcelain=v1", "--untracked-files=all"], ""],
    ] as const) {
      const result = await runner({
        arguments: arguments_, containment: "local", cwd: sourceRoot,
        environment: environment(), executable: "/usr/bin/git", outputMaximumBytes,
        phase: "hosted-attention-key-source-read", stdin: "", timeoutMs: 60_000,
      });
      if (result.exitCode !== 0 || result.stderr !== "" || result.stdout !== expected) {
        throw new HostedAttentionKeyObservationError("source_changed");
      }
    }
  };
  const readProvider = async (
    operation: "names" | "otp" | "attention" | "inactive",
  ): Promise<string> => {
    const arguments_ = operation === "names"
      ? ["env", "list", "--names-only"]
      : operation === "inactive"
        ? ["run", "attentionNotificationControl:inactiveDeploymentStatus", "{}"]
        : ["env", "get", operation === "otp"
          ? oompaResendApiKeyEnvironmentName : oompaAttentionResendApiKeyEnvironmentName];
    await verifyTarget(target);
    const result = await runner({
      arguments: [convexCli, ...arguments_, "--deployment", target.deploymentName],
      containment: "authority", cwd: sourceRoot, environment: environment(),
      executable: process.execPath, outputMaximumBytes,
      phase: `hosted-attention-key-${operation}-read`, stdin: "", timeoutMs: 60_000,
    });
    await verifyTarget(target);
    if (
      result.exitCode !== 0 || result.stderr !== ""
      || Buffer.byteLength(result.stdout, "utf8") > outputMaximumBytes
    ) throw new HostedAttentionKeyObservationError("environment_ambiguous");
    return result.stdout;
  };
  await source();
  const candidate = parseDeployEvidenceFile(options.deployEvidencePath);
  if (
    candidate.phase !== "candidate" || candidate.sourceCommit !== options.sourceCommit
    || candidate.targetDigest !== canonicalDigest(target)
  ) throw new HostedAttentionKeyObservationError("candidate_mismatch");
  const preparation = options.preparationEvidencePath === undefined ? undefined
    : readProtectedJson(options.preparationEvidencePath, hostedAttentionKeyObservationSchema);
  if (preparation !== undefined && (
    preparation.phase !== "prepare" || preparation.sourceCommit !== options.sourceCommit
    || preparation.candidateDeployDigest !== candidate.selfDigest
    || preparation.targetDigest !== canonicalDigest(target)
    || preparation.intendedKeyDigest !== intendedKeyDigest
  )) throw new HostedAttentionKeyObservationError("preparation_mismatch");

  const proveBinding = async () => {
    await source();
    if (parseDeployEvidenceFile(options.deployEvidencePath).selfDigest !== candidate.selfDigest) {
      throw new HostedAttentionKeyObservationError("candidate_mismatch");
    }
    await verifyTarget(target);
    let attestation: RuntimeReleaseAttestation;
    try { attestation = runtimeReleaseAttestationSchema.parse(await readAttestation(target)); }
    catch (error: unknown) {
      rethrowBoundedProcessTerminalError(error);
      if (isAuthorityContainmentUnavailable(error)) throw error;
      throw new HostedAttentionKeyObservationError("release_attestation_invalid");
    }
    if (canonicalDigest(attestation) !== canonicalDigest(candidate.after)) {
      throw new HostedAttentionKeyObservationError("release_attestation_invalid");
    }
    const inactiveDocument = await readProvider("inactive");
    try {
      const inactive = attentionInactiveReadSchema.parse(JSON.parse(inactiveDocument) as unknown);
      return inactiveSchema.parse(inactive);
    } catch { throw new HostedAttentionKeyObservationError("attention_not_inactive"); }
  };
  const snapshot = async () => {
    const names = new Set<string>();
    for (const name of (await readProvider("names")).split(/\r?\n/gu)) {
      if (name === "") continue;
      if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(name) || names.has(name) || names.size >= 1_024) {
        throw new HostedAttentionKeyObservationError("environment_ambiguous");
      }
      names.add(name);
    }
    if (!HOSTED_ENVIRONMENT_NAMES.every((name) =>
      name === oompaAttentionResendApiKeyEnvironmentName || names.has(name))) {
      throw new HostedAttentionKeyObservationError("prerequisites_missing");
    }
    const readKey = async (operation: "otp" | "attention") => {
      const raw = await readProvider(operation);
      const value = raw.replace(/\r?\n$/u, "");
      if (!isStrictResendApiKey(value)) {
        throw new HostedAttentionKeyObservationError("environment_ambiguous");
      }
      forbiddenValues.push(value);
      return value;
    };
    const otp = await readKey("otp");
    if (otp === intendedKey) throw new HostedAttentionKeyObservationError("otp_key_reused");
    requireOompaAttentionResendApiKey({
      [oompaAttentionResendApiKeyEnvironmentName]: intendedKey,
      [oompaResendApiKeyEnvironmentName]: otp,
    });
    const attention = names.has(oompaAttentionResendApiKeyEnvironmentName)
      ? await readKey("attention") : undefined;
    const keyState = attention === undefined ? "absent" as const
      : attention === intendedKey ? "existing_equal" as const : "existing_mismatched" as const;
    return { attention, keyState, namesDigest: canonicalDigest([...names].sort()), otp };
  };

  await proveBinding();
  const before = await snapshot();
  await proveBinding();
  const after = await snapshot();
  if (
    before.namesDigest !== after.namesDigest || before.otp !== after.otp
    || before.attention !== after.attention
  ) throw new HostedAttentionKeyObservationError("prestate_changed");
  const inactive = await proveBinding();
  await source();
  if (parseDeployEvidenceFile(options.deployEvidencePath).selfDigest !== candidate.selfDigest) {
    throw new HostedAttentionKeyObservationError("candidate_mismatch");
  }
  if (preparation !== undefined && options.preparationEvidencePath !== undefined) {
    const current = readProtectedJson(options.preparationEvidencePath, hostedAttentionKeyObservationSchema);
    if (current.selfDigest !== preparation.selfDigest) {
      throw new HostedAttentionKeyObservationError("preparation_mismatch");
    }
  }
  const evidence = hostedAttentionKeyObservationSchema.parse(withSelfDigest({
    candidateDeployDigest: candidate.selfDigest, effect: "none" as const, inactive,
    intendedKeyDigest, keyState: after.keyState, kind: "hosted-attention-key-observation" as const,
    namesDigest: after.namesDigest, phase: options.phase,
    preparationDigest: preparation?.selfDigest ?? null,
    providerWriteCapability: "unavailable" as const, schemaVersion: 1 as const,
    sourceCommit: options.sourceCommit, status: "observed_only" as const,
    target, targetDigest: canonicalDigest(target),
  }));
  // These reads are bounded observations, not an atomic provider snapshot.
  // Another actor can change state after the last sample. Publishing this
  // record neither reserves that state nor establishes migration authority.
  const publication = writeProtectedJsonNoReplace(
    options.evidencePath, evidence, hostedAttentionKeyObservationSchema, { allowExactReplay: true },
  );
  return { code: "provider_add_only_unavailable" as const, evidence, replayed: publication.replayed };
};

export async function observeHostedAttentionKey(options: ObservationOptions) {
  try { return await observe(options); }
  catch (error: unknown) {
    if (isBoundedProcessCleanupUnprovenError(error) || isBoundedProcessRecoveryJournalError(error)) {
      let retained: unknown = error;
      for (const path of [options.deployEvidencePath, options.evidencePath, options.preparationEvidencePath]) {
        if (path !== undefined) retained = retainBoundedProcessRecoveryPath(retained, path);
      }
      throw retained;
    }
    if (error instanceof HostedAttentionKeyObservationError || isAuthorityContainmentUnavailable(error)) {
      throw error;
    }
    throw new HostedAttentionKeyObservationError("observation_failed");
  }
}

type ExecuteOptions = Omit<ObservationOptions, keyof ObservationArguments> & Readonly<{
  arguments: readonly string[];
  stderr: Pick<NodeJS.WriteStream, "write">;
  stdout: Pick<NodeJS.WriteStream, "write">;
}>;

export async function executeHostedAttentionKeyObservation(options: ExecuteOptions): Promise<number> {
  try {
    const result = await observeHostedAttentionKey({
      ...options, ...parseHostedAttentionKeyObservationArguments(options.arguments),
    });
    options.stdout.write(`${JSON.stringify({
      code: result.code, effect: "none", evidenceWritten: true,
      keyState: result.evidence.keyState, phase: result.evidence.phase,
      replayed: result.replayed, schemaVersion: 1, status: "refused",
    })}\n`);
    return 1;
  } catch (error: unknown) {
    const authorityUnavailable = renderAuthorityContainmentUnavailable(error);
    if (isBoundedProcessCleanupUnprovenError(error) || isBoundedProcessRecoveryJournalError(error)) {
      // Preserve recovery paths on the typed error, never echo arbitrary
      // diagnostic strings or paths through the credential-facing CLI.
      options.stderr.write(`${JSON.stringify({
        code: isBoundedProcessCleanupUnprovenError(error)
          ? "process_cleanup_unproven" : "process_recovery_journal_blocked",
        effect: "none", evidencePreserved: true, schemaVersion: 1, status: "recovery_required",
      })}\n`);
      return 75;
    }
    options.stderr.write(authorityUnavailable ?? `${JSON.stringify({
      code: error instanceof HostedAttentionKeyObservationError ? error.code : "observation_failed",
      effect: "none", schemaVersion: 1, status: "refused",
    })}\n`);
    return 1;
  }
}

if (import.meta.main) {
  try {
    parseHostedAttentionKeyObservationArguments(process.argv.slice(2));
    process.exitCode = await executeHostedAttentionKeyObservation({
      arguments: process.argv.slice(2), inputDocument: await readProtectedAttentionKeyInput(0),
      stderr: process.stderr, stdout: process.stdout,
    });
  } catch (error: unknown) {
    const authorityUnavailable = renderAuthorityContainmentUnavailable(error);
    process.stderr.write(authorityUnavailable ?? `${JSON.stringify({
      code: error instanceof HostedAttentionKeyObservationError ? error.code : "input_invalid",
      effect: "none", schemaVersion: 1, status: "refused",
    })}\n`);
    process.exitCode = 1;
  }
}
