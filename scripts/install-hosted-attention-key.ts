import { createHash, createHmac } from "node:crypto";
import { readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import {
  oompaAttentionResendApiKeyEnvironmentName,
  oompaResendApiKeyEnvironmentName,
  isStrictResendApiKey,
} from "../convex/resendApiKey";
import {
  createAttentionKeyInstallTransport,
  type AttentionEnvironment,
  type AttentionKeyInstallTransport,
} from "./attention-key-install-transport";
import { isAuthorityContainmentUnavailable, renderAuthorityContainmentUnavailable } from "./authority-containment";
import { buildConvexChildEnvironment, HOSTED_ENVIRONMENT_NAMES } from "./configure-hosted-sync";
import {
  isBoundedProcessCleanupUnprovenError,
  isBoundedProcessRecoveryJournalError,
  retainBoundedProcessRecoveryPath,
} from "./bounded-process";
import { parseConvexTarget, parseConvexTargetArguments, verifyConvexDefaultTarget, type ConvexTarget } from "./convex-target";
import {
  hostedAttentionKeyObservationSchema,
  observeHostedAttentionKey,
  readProtectedAttentionKeyInput,
} from "./migrate-hosted-attention-key";
import {
  assertProtectedDirectory,
  canonicalDigest,
  canonicalJson,
  convexTargetEvidenceSchema,
  parseDeployEvidenceFile,
  readProtectedJson,
  withSelfDigest,
  writeProtectedJsonNoReplace,
} from "./release-evidence";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const commitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const timeSchema = z.number().int().nonnegative().safe();
const pathSchema = z.string().min(1).max(4_096).refine((path) =>
  isAbsolute(path) && resolve(path) === path && !path.includes("\0"));
const authorityPremise = "operational_custody_attested";

// This document records an operator's operational exclusion premise. Neither
// the self digest nor a local filesystem lock proves provider-side CAS.
export const attentionKeyInstallCustodySchema = z.object({
  authorityPremise: z.literal(authorityPremise),
  candidateDeployDigest: digestSchema,
  competingWritersQuiesced: z.object({
    ci: z.literal(true), cli: z.literal(true), dashboard: z.literal(true), delegated: z.literal(true),
  }).strict(),
  evidenceDirectory: pathSchema,
  evidenceDirectorySharedAndRetained: z.literal(true),
  expiresAtMs: timeSchema,
  intendedKeyDigest: digestSchema,
  issuedAtMs: timeSchema,
  kind: z.literal("hosted-attention-key-custody"),
  operationId: z.string().uuid(),
  preparationDigest: digestSchema,
  schemaVersion: z.literal(1),
  selfDigest: digestSchema,
  sourceCommit: commitSchema,
  target: convexTargetEvidenceSchema,
  targetDigest: digestSchema,
}).strict().superRefine((value, context) => {
  if (value.targetDigest !== canonicalDigest(value.target)
    || value.expiresAtMs <= value.issuedAtMs
    || value.expiresAtMs - value.issuedAtMs > 15 * 60_000) {
    context.addIssue({ code: "custom", message: "custody_binding_invalid" });
  }
});

export const attentionKeyInstallIntentSchema = z.object({
  authorityPremise: z.literal(authorityPremise),
  candidateDeployDigest: digestSchema,
  custodyDigest: digestSchema,
  intendedKeyDigest: digestSchema,
  kind: z.literal("hosted-attention-key-install-intent"),
  nonAttentionEnvironmentDigest: digestSchema,
  operationId: z.string().uuid(),
  preparationDigest: digestSchema,
  schemaVersion: z.literal(1),
  selfDigest: digestSchema,
  sourceCommit: commitSchema,
  target: convexTargetEvidenceSchema,
  targetDigest: digestSchema,
}).strict();

const resultSchema = z.object({
  authorityPremise: z.literal(authorityPremise),
  intentDigest: digestSchema,
  kind: z.literal("hosted-attention-key-install-result"),
  nonAttentionEnvironmentUnchanged: z.boolean(),
  operationId: z.string().uuid(),
  phase: z.enum(["install", "reconcile"]),
  schemaVersion: z.literal(1),
  selfDigest: digestSchema,
  status: z.enum(["provider_acknowledged_and_observed_equal", "observed_equal", "observed_absent", "observed_conflict"]),
}).strict();

type FailureCode = "usage_invalid" | "input_invalid" | "custody_invalid" | "binding_changed"
  | "preparation_invalid" | "environment_ambiguous" | "prerequisites_missing" | "otp_key_reused"
  | "attention_key_occupied" | "prestate_changed" | "reconciliation_required" | "preflight_failed";

export class AttentionKeyInstallationError extends Error {
  constructor(readonly code: FailureCode) { super(code); this.name = "AttentionKeyInstallationError"; }
}

export type AttentionKeyInstallationArguments = Readonly<{
  custodyAttestationPath: string;
  deployEvidencePath: string;
  evidenceDirectory: string;
  phase: "install" | "reconcile";
  preparationEvidencePath: string;
  sourceCommit: string;
  target: ConvexTarget;
}>;

const validateArguments = (options: AttentionKeyInstallationArguments): void => {
  const paths = [options.custodyAttestationPath, options.deployEvidencePath,
    options.evidenceDirectory, options.preparationEvidencePath];
  if (!commitSchema.safeParse(options.sourceCommit).success
    || !["install", "reconcile"].includes(options.phase)
    || paths.some((path) => !pathSchema.safeParse(path).success)
    || new Set(paths).size !== paths.length) throw new AttentionKeyInstallationError("usage_invalid");
  parseConvexTarget(options.target);
  if (options.target.deploymentUrl !== `https://${options.target.deploymentName}.convex.cloud`) {
    throw new AttentionKeyInstallationError("usage_invalid");
  }
};

export function parseAttentionKeyInstallationArguments(arguments_: readonly string[]): AttentionKeyInstallationArguments {
  const { target, otherArguments } = parseConvexTargetArguments(arguments_);
  const allowed = new Set(["--phase", "--source-commit", "--deploy-evidence", "--preparation-evidence",
    "--custody-attestation", "--evidence-directory"]);
  const values = new Map<string, string>();
  for (let index = 0; index < otherArguments.length; index += 2) {
    const name = otherArguments[index];
    const value = otherArguments[index + 1];
    if (name === undefined || value === undefined || !allowed.has(name) || values.has(name)) {
      throw new AttentionKeyInstallationError("usage_invalid");
    }
    values.set(name, value);
  }
  const phase = values.get("--phase");
  if (phase !== "install" && phase !== "reconcile") throw new AttentionKeyInstallationError("usage_invalid");
  const options: AttentionKeyInstallationArguments = {
    custodyAttestationPath: values.get("--custody-attestation") ?? "",
    deployEvidencePath: values.get("--deploy-evidence") ?? "",
    evidenceDirectory: values.get("--evidence-directory") ?? "", phase,
    preparationEvidencePath: values.get("--preparation-evidence") ?? "",
    sourceCommit: values.get("--source-commit") ?? "", target,
  };
  validateArguments(options);
  return options;
}

export function parseAttentionKeyInstallationInput(document: string, target: ConvexTarget) {
  try {
    if (Buffer.byteLength(document, "utf8") > 8 * 1024
      || !/^\s*\{\s*"attentionResendApiKey"\s*:\s*"[^"\\]*"\s*,\s*"convexDeploymentAdminKey"\s*:\s*"[^"\\]*"\s*\}\s*$/u.test(document)) throw new Error();
    const input = z.object({ attentionResendApiKey: z.string(), convexDeploymentAdminKey: z.string() })
      .strict().parse(JSON.parse(document) as unknown);
    const prefix = `prod:${target.deploymentName}|`;
    if (!isStrictResendApiKey(input.attentionResendApiKey)
      || !input.convexDeploymentAdminKey.startsWith(prefix)
      || !/^[A-Za-z0-9_-]{20,4096}$/u.test(input.convexDeploymentAdminKey.slice(prefix.length))) throw new Error();
    return input;
  } catch { throw new AttentionKeyInstallationError("input_invalid"); }
}

export const attentionKeyInstallSlot = (target: ConvexTarget): string =>
  `attention-key-${oompaAttentionResendApiKeyEnvironmentName}-${canonicalDigest(parseConvexTarget(target))}.intent.json`;

export const attentionEnvironmentFingerprint = (
  entries: AttentionEnvironment, target: ConvexTarget, intendedAttentionKey: string,
): string => createHmac("sha256", intendedAttentionKey)
  .update("oompa-attention-environment-fingerprint-v1\0", "utf8")
  .update(canonicalJson({
    entries: entries.filter(({ name }) => name !== oompaAttentionResendApiKeyEnvironmentName)
      .toSorted((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
    target: parseConvexTarget(target),
  }), "utf8")
  .digest("hex");

type ObservationOptions = Parameters<typeof observeHostedAttentionKey>[0];
type InstallationOptions = AttentionKeyInstallationArguments & Readonly<{
  inputDocument: string;
  now?: () => number;
  observation?: Pick<ObservationOptions, "authorityFetch" | "environment" | "readAttestation" | "repositoryRoot" | "runner" | "verifyTarget">;
  transport?: AttentionKeyInstallTransport;
}>;

export async function installHostedAttentionKey(options: InstallationOptions) {
  let intentAttempted = false;
  try {
    validateArguments(options);
    const input = parseAttentionKeyInstallationInput(options.inputDocument, options.target);
    const intendedKeyDigest = createHash("sha256").update("oompa-attention-key-observation-v1\0")
      .update(input.attentionResendApiKey).digest("hex");
    const targetDigest = canonicalDigest(options.target);
    const directory = assertProtectedDirectory(options.evidenceDirectory);
    const slot = attentionKeyInstallSlot(options.target);
    const intentPath = join(directory, slot);
    const custody = readProtectedJson(options.custodyAttestationPath, attentionKeyInstallCustodySchema);
    const candidate = parseDeployEvidenceFile(options.deployEvidencePath);
    const preparation = readProtectedJson(options.preparationEvidencePath, hostedAttentionKeyObservationSchema);
    const now = options.now ?? Date.now;
    const checkBindings = (requireUnexpired = options.phase === "install" && !intentAttempted) => {
      const current = readProtectedJson(options.custodyAttestationPath, attentionKeyInstallCustodySchema);
      const time = now();
      if (!Number.isSafeInteger(time) || time < current.issuedAtMs
        || (requireUnexpired && time >= current.expiresAtMs)
        || current.selfDigest !== custody.selfDigest || current.sourceCommit !== options.sourceCommit
        || current.targetDigest !== targetDigest || current.intendedKeyDigest !== intendedKeyDigest
        || current.evidenceDirectory !== directory || current.candidateDeployDigest !== candidate.selfDigest
        || current.preparationDigest !== preparation.selfDigest) throw new AttentionKeyInstallationError("custody_invalid");
      if (parseDeployEvidenceFile(options.deployEvidencePath).selfDigest !== candidate.selfDigest
        || readProtectedJson(options.preparationEvidencePath, hostedAttentionKeyObservationSchema).selfDigest !== preparation.selfDigest) {
        throw new AttentionKeyInstallationError("binding_changed");
      }
    };
    checkBindings();
    if (candidate.phase !== "candidate" || candidate.sourceCommit !== options.sourceCommit
      || candidate.targetDigest !== targetDigest || preparation.phase !== "prepare"
      || preparation.keyState !== "absent" || preparation.sourceCommit !== options.sourceCommit
      || preparation.candidateDeployDigest !== candidate.selfDigest || preparation.targetDigest !== targetDigest
      || preparation.intendedKeyDigest !== intendedKeyDigest) throw new AttentionKeyInstallationError("preparation_invalid");

    const transport = options.transport ?? createAttentionKeyInstallTransport({
      adminKey: input.convexDeploymentAdminKey, attentionKey: input.attentionResendApiKey, target: options.target,
    });
    const verifyTarget = options.observation?.verifyTarget ?? verifyConvexDefaultTarget;
    const nextEvidencePath = (stage: string): string => {
      const prefix = `${slot}.${custody.operationId}.${stage}.`;
      const names = new Set(readdirSync(directory));
      for (let sequence = 1; sequence <= 100; sequence += 1) {
        const name = `${prefix}${sequence}.json`;
        if (!names.has(name) && ![...names].some((entry) => entry.startsWith(`.${name}.`))) return join(directory, name);
      }
      throw new AttentionKeyInstallationError("reconciliation_required");
    };
    const prove = async (stage: string) => {
      checkBindings();
      const observed = await observeHostedAttentionKey({
        ...options.observation,
        deployEvidencePath: options.deployEvidencePath,
        environment: buildConvexChildEnvironment(options.observation?.environment ?? process.env,
          [input.convexDeploymentAdminKey, input.attentionResendApiKey]),
        evidencePath: nextEvidencePath(stage),
        inputDocument: JSON.stringify({ attentionResendApiKey: input.attentionResendApiKey }),
        phase: "reconcile", preparationEvidencePath: options.preparationEvidencePath,
        sourceCommit: options.sourceCommit, target: options.target,
      });
      checkBindings();
      return observed.evidence;
    };
    const snapshot = async () => {
      checkBindings();
      await verifyTarget(options.target);
      const entries: AttentionEnvironment = await transport.readEnvironment();
      await verifyTarget(options.target);
      const values = new Map(entries.map(({ name, value }) => [name, value]));
      if (entries.length > 1_024 || values.size !== entries.length) throw new AttentionKeyInstallationError("environment_ambiguous");
      if (!HOSTED_ENVIRONMENT_NAMES.every((name) =>
        name === oompaAttentionResendApiKeyEnvironmentName || values.has(name))) throw new AttentionKeyInstallationError("prerequisites_missing");
      const otp = values.get(oompaResendApiKeyEnvironmentName);
      if (!isStrictResendApiKey(otp)) throw new AttentionKeyInstallationError("environment_ambiguous");
      if (otp === input.attentionResendApiKey) throw new AttentionKeyInstallationError("otp_key_reused");
      const attention = values.get(oompaAttentionResendApiKeyEnvironmentName);
      const keyState = attention === undefined ? "absent" : attention === input.attentionResendApiKey
        ? "existing_equal" : "existing_mismatched";
      // Reconciliation retains the intended key even if the administrative
      // credential rotates. Do not persist an unkeyed digest of other secrets.
      const nonAttentionEnvironmentDigest = attentionEnvironmentFingerprint(entries, options.target, input.attentionResendApiKey);
      checkBindings();
      return { keyState, namesDigest: canonicalDigest([...values.keys()].sort()), nonAttentionEnvironmentDigest };
    };
    const record = (intent: z.infer<typeof attentionKeyInstallIntentSchema>, status: z.infer<typeof resultSchema>["status"], unchanged: boolean) => {
      const evidence = resultSchema.parse(withSelfDigest({
        authorityPremise, intentDigest: intent.selfDigest, kind: "hosted-attention-key-install-result",
        nonAttentionEnvironmentUnchanged: unchanged, operationId: custody.operationId,
        phase: options.phase, schemaVersion: 1, status,
      }));
      writeProtectedJsonNoReplace(nextEvidencePath("result"), evidence, resultSchema);
      return { status, nonAttentionEnvironmentUnchanged: unchanged, evidenceRetained: true as const };
    };

    if (options.phase === "reconcile") {
      intentAttempted = true;
      const intent = readProtectedJson(intentPath, attentionKeyInstallIntentSchema, { recoverInterruptedPublication: true });
      if (intent.sourceCommit !== options.sourceCommit || intent.targetDigest !== targetDigest
        || canonicalDigest(intent.target) !== targetDigest || intent.intendedKeyDigest !== intendedKeyDigest
        || intent.custodyDigest !== custody.selfDigest || intent.operationId !== custody.operationId
        || intent.candidateDeployDigest !== candidate.selfDigest || intent.preparationDigest !== preparation.selfDigest) {
        throw new AttentionKeyInstallationError("binding_changed");
      }
      const observed = await prove("reconcile");
      const current = await snapshot();
      if (current.keyState !== observed.keyState || current.namesDigest !== observed.namesDigest) {
        throw new AttentionKeyInstallationError("prestate_changed");
      }
      const unchanged = current.nonAttentionEnvironmentDigest === intent.nonAttentionEnvironmentDigest;
      return record(intent, !unchanged || current.keyState === "existing_mismatched" ? "observed_conflict"
        : current.keyState === "existing_equal" ? "observed_equal" : "observed_absent", unchanged);
    }

    // A new operation ID or intended secret cannot bypass a surviving intent or interrupted
    // publication in this attested, retained directory. Preserve and refuse
    // pre-release filenames too; changing the slot format cannot authorize a retry.
    if (readdirSync(directory).some((name) => name === slot || name.startsWith(`.${slot}.`)
      || /^\.?attention-key-[0-9a-f]{64}\.intent\.json(?:\.|$)/u.test(name))) {
      intentAttempted = true;
      throw new AttentionKeyInstallationError("reconciliation_required");
    }
    const before = await snapshot();
    const observed = await prove("before-intent");
    if (before.keyState !== "absent" || observed.keyState !== "absent") throw new AttentionKeyInstallationError("attention_key_occupied");
    if (before.namesDigest !== preparation.namesDigest || observed.namesDigest !== before.namesDigest) {
      throw new AttentionKeyInstallationError("prestate_changed");
    }
    const stable = await snapshot();
    if (canonicalDigest(before) !== canonicalDigest(stable)) throw new AttentionKeyInstallationError("prestate_changed");
    checkBindings(true);
    const intent = attentionKeyInstallIntentSchema.parse(withSelfDigest({
      authorityPremise, candidateDeployDigest: candidate.selfDigest, custodyDigest: custody.selfDigest,
      intendedKeyDigest, kind: "hosted-attention-key-install-intent",
      nonAttentionEnvironmentDigest: stable.nonAttentionEnvironmentDigest, operationId: custody.operationId,
      preparationDigest: preparation.selfDigest, schemaVersion: 1, sourceCommit: options.sourceCommit,
      target: options.target, targetDigest,
    }));
    intentAttempted = true;
    writeProtectedJsonNoReplace(intentPath, intent, attentionKeyInstallIntentSchema);
    const immediate = await prove("before-dispatch");
    const finalSnapshot = await snapshot();
    if (immediate.keyState !== "absent" || immediate.namesDigest !== before.namesDigest
      || canonicalDigest(finalSnapshot) !== canonicalDigest(before)) throw new AttentionKeyInstallationError("prestate_changed");
    checkBindings();
    if (now() + 30_000 > custody.expiresAtMs) throw new AttentionKeyInstallationError("custody_invalid");
    // Operational custody is the premise across this read/write gap. This is
    // one application invocation, not network exactly-once or provider CAS.
    await transport.installAttentionKey();
    const after = await snapshot();
    const confirmation = await prove("after-dispatch");
    const verified = await snapshot();
    if (after.keyState !== "existing_equal" || confirmation.keyState !== "existing_equal"
      || after.namesDigest !== confirmation.namesDigest
      || canonicalDigest(verified) !== canonicalDigest(after)
      || after.nonAttentionEnvironmentDigest !== before.nonAttentionEnvironmentDigest) throw new AttentionKeyInstallationError("prestate_changed");
    return record(intent, "provider_acknowledged_and_observed_equal", true);
  } catch (error: unknown) {
    if (isBoundedProcessCleanupUnprovenError(error) || isBoundedProcessRecoveryJournalError(error)) {
      let retained: unknown = error;
      for (const path of [options.deployEvidencePath, options.preparationEvidencePath,
        options.custodyAttestationPath, options.evidenceDirectory]) {
        retained = retainBoundedProcessRecoveryPath(retained, path);
      }
      throw retained;
    }
    if (intentAttempted) return {
      status: "dispatch_outcome_unknown" as const, nonAttentionEnvironmentUnchanged: false,
      evidenceRetained: true as const,
    };
    if (isAuthorityContainmentUnavailable(error)) throw error;
    if (error instanceof AttentionKeyInstallationError) throw error;
    throw new AttentionKeyInstallationError("preflight_failed");
  }
}

export async function executeAttentionKeyInstallation(options: Omit<InstallationOptions, keyof AttentionKeyInstallationArguments> & Readonly<{
  arguments: readonly string[];
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}>): Promise<number> {
  try {
    const result = await installHostedAttentionKey({ ...options, ...parseAttentionKeyInstallationArguments(options.arguments) });
    options.stdout.write(`${JSON.stringify({ ...result, activation: "unchanged", authorityPremise, schemaVersion: 1 })}\n`);
    return result.status === "provider_acknowledged_and_observed_equal" ? 0 : 1;
  } catch (error: unknown) {
    const authorityUnavailable = renderAuthorityContainmentUnavailable(error);
    if (isBoundedProcessCleanupUnprovenError(error) || isBoundedProcessRecoveryJournalError(error)) {
      options.stderr.write(`${JSON.stringify({
        code: isBoundedProcessCleanupUnprovenError(error) ? "process_cleanup_unproven" : "process_recovery_journal_blocked",
        effect: "unknown", evidenceRetained: true, schemaVersion: 1, status: "recovery_required",
      })}\n`);
      return 75;
    }
    options.stderr.write(authorityUnavailable ?? `${JSON.stringify({
      code: error instanceof AttentionKeyInstallationError ? error.code : "preflight_failed",
      effect: "none", schemaVersion: 1, status: "refused",
    })}\n`);
    return 1;
  }
}

if (import.meta.main) {
  try {
    parseAttentionKeyInstallationArguments(process.argv.slice(2));
    process.exitCode = await executeAttentionKeyInstallation({
      arguments: process.argv.slice(2), inputDocument: await readProtectedAttentionKeyInput(0),
      stderr: process.stderr, stdout: process.stdout,
    });
  } catch (error: unknown) {
    const authorityUnavailable = renderAuthorityContainmentUnavailable(error);
    process.stderr.write(authorityUnavailable ?? `${JSON.stringify({ code: "input_invalid", effect: "none", schemaVersion: 1, status: "refused" })}\n`);
    process.exitCode = 1;
  }
}
