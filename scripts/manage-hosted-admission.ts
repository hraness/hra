import { resolve } from "node:path";

import { z } from "zod";

import { isSafeNonNegativeInteger, isUuidV7 } from "../src/cloud/contracts";
import {
  buildConvexChildEnvironment,
  runCommand,
  type CommandResult,
  type CommandRunner,
} from "./configure-hosted-sync";
import {
  BoundedProcessInvocationGuard,
  isBoundedProcessCleanupUnprovenError,
  isBoundedProcessRecoveryJournalError,
  recoverBoundedProcessJournal,
} from "./bounded-process";
import {
  isAuthorityContainmentUnavailable,
  renderAuthorityContainmentUnavailable,
} from "./authority-containment";
import {
  ConvexTargetError,
  parseConvexTarget,
  parseConvexTargetArguments,
  verifyConvexDefaultTarget,
  type ConvexTarget,
  type ConvexTargetVerifier,
} from "./convex-target";

const convexCli = resolve(import.meta.dir, "..", "node_modules", "convex", "bin", "main.js");
const repositoryRoot = resolve(import.meta.dir, "..");
const providerOutputMaximumBytes = 64 * 1024;

// A deployment that predates the new-identity control reports no value. Absent
// means invite_only there exactly as it does in the authority itself.
const newIdentityAdmissions = z.union([z.literal("invite_only"), z.literal("open")]);

const statusSchema = z.object({
  generation: z.number().refine(isSafeNonNegativeInteger),
  newIdentityAdmissions: newIdentityAdmissions.optional(),
  state: z.union([z.literal("open"), z.literal("frozen")]),
  updatedAt: z.number().finite().nonnegative(),
}).strict();

const transitionSchema = statusSchema.extend({
  changed: z.boolean(),
  replay: z.boolean(),
}).strict();

type NewIdentityAdmissions = z.infer<typeof newIdentityAdmissions>;
type AdmissionStatus = Readonly<{
  generation: number;
  newIdentityAdmissions: NewIdentityAdmissions;
  state: "frozen" | "open";
  updatedAt: number;
}>;
type AdmissionTransition = Readonly<{
  expectedGeneration: number;
  kind: "freeze" | "new-identities" | "resume";
  mutationId: string;
  newIdentities?: NewIdentityAdmissions;
}>;
type AdmissionAction = Readonly<{ kind: "status" }> | AdmissionTransition;
type DesiredControl = Readonly<{
  newIdentityAdmissions: NewIdentityAdmissions;
  state: "frozen" | "open";
}>;

const readStatus = (
  parsed: z.infer<typeof statusSchema>,
): AdmissionStatus => ({
  generation: parsed.generation,
  newIdentityAdmissions: parsed.newIdentityAdmissions ?? "invite_only",
  state: parsed.state,
  updatedAt: parsed.updatedAt,
});

type AdmissionArguments = Readonly<{
  action: AdmissionAction;
  target: ConvexTarget;
}>;

type AdmissionFailureCode =
  | "convex_target_refused"
  | "provider_result_invalid"
  | "transition_refused"
  | "usage_invalid";

class AdmissionOperatorError extends Error {
  constructor(readonly code: AdmissionFailureCode) {
    super(code);
    this.name = "AdmissionOperatorError";
  }
}

const takeOption = (values: string[], name: string): string | undefined => {
  const index = values.indexOf(name);
  if (index < 0) return undefined;
  const value = values[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new AdmissionOperatorError("usage_invalid");
  }
  values.splice(index, 2);
  return value;
};

const takeFlag = (values: string[], name: string): boolean => {
  const index = values.indexOf(name);
  if (index < 0) return false;
  values.splice(index, 1);
  return true;
};

export function parseAdmissionArguments(arguments_: readonly string[]): AdmissionArguments {
  let targetArguments: ReturnType<typeof parseConvexTargetArguments>;
  try {
    targetArguments = parseConvexTargetArguments(arguments_);
  } catch {
    throw new AdmissionOperatorError("usage_invalid");
  }
  const values = [...targetArguments.otherArguments];
  const action = values.shift();
  if (action === "status") {
    if (values.length !== 0) throw new AdmissionOperatorError("usage_invalid");
    return { action: { kind: "status" }, target: targetArguments.target };
  }
  if (action !== "freeze" && action !== "new-identities" && action !== "resume") {
    throw new AdmissionOperatorError("usage_invalid");
  }
  const expected = takeOption(values, "--expected-generation");
  const mutationId = takeOption(values, "--mutation-id");
  const newIdentities = takeOption(values, "--new-identities");
  const acknowledgedResume = takeFlag(values, "--acknowledge-resume");
  const acknowledgedOpenSignup = takeFlag(values, "--acknowledge-open-signup");
  if (
    values.length !== 0
    || expected === undefined
    || !/^(0|[1-9][0-9]*)$/u.test(expected)
    || !isSafeNonNegativeInteger(Number(expected))
    || mutationId === undefined
    || !isUuidV7(mutationId)
    || (action === "resume") !== acknowledgedResume
    || (newIdentities !== undefined
      && newIdentities !== "invite_only"
      && newIdentities !== "open")
    || (action === "new-identities") !== (newIdentities !== undefined)
    || (newIdentities === "open") !== acknowledgedOpenSignup
  ) throw new AdmissionOperatorError("usage_invalid");
  return {
    action: {
      expectedGeneration: Number(expected),
      kind: action,
      mutationId,
      ...(newIdentities === undefined ? {} : { newIdentities }),
    },
    target: targetArguments.target,
  };
}

const parseProviderJson = <T>(stdout: string, schema: z.ZodType<T>): T => {
  if (
    stdout.trim().length === 0
    || Buffer.byteLength(stdout, "utf8") > providerOutputMaximumBytes
  ) throw new AdmissionOperatorError("provider_result_invalid");
  try {
    return schema.parse(JSON.parse(stdout) as unknown);
  } catch {
    throw new AdmissionOperatorError("provider_result_invalid");
  }
};

const statusArguments = (deployment: string): readonly string[] => [
  "run",
  "admissionControl:status",
  "{}",
  "--deployment",
  deployment,
];

const transitionArguments = (
  deployment: string,
  action: AdmissionTransition,
  desired: DesiredControl,
): readonly string[] => [
  "run",
  "admissionControl:transition",
  JSON.stringify({
    expectedGeneration: action.expectedGeneration,
    mutationId: action.mutationId,
    // Only an explicit `--new-identities` sends the field, so freeze and resume
    // stay exactly the request they were before this control existed.
    ...(action.newIdentities === undefined
      ? {}
      : { newIdentityAdmissions: action.newIdentities }),
    state: desired.state,
  }),
  "--deployment",
  deployment,
];

type AdmissionOptions = Readonly<{
  action: AdmissionAction;
  environment?: Readonly<NodeJS.ProcessEnv>;
  runner?: CommandRunner;
  target: ConvexTarget;
  verifyTarget?: ConvexTargetVerifier;
}>;

export async function manageHostedAdmission(options: AdmissionOptions): Promise<AdmissionStatus> {
  const target = parseConvexTarget(options.target);
  const verify = options.verifyTarget ?? verifyConvexDefaultTarget;
  const runner = options.runner ?? runCommand;
  const environment = buildConvexChildEnvironment(options.environment ?? process.env, []);
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
    outputMaximumBytes: providerOutputMaximumBytes,
    phase,
    stdin: "",
    timeoutMs: 60_000,
  }));
  const invokeWithPostflight = async (
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
        await guard.observe(async () => await verify(target));
      }
    }
  };

  await guard.observe(async () => await verify(target));
  const beforeResult = await invokeWithPostflight(
    statusArguments(target.deploymentName),
    "hosted-admission-read-before",
  );
  if (beforeResult.exitCode !== 0) {
    throw new AdmissionOperatorError("provider_result_invalid");
  }
  const before = readStatus(parseProviderJson(beforeResult.stdout, statusSchema));
  if (options.action.kind === "status") {
    return before;
  }

  const action = options.action;
  const desired: DesiredControl = {
    newIdentityAdmissions: action.newIdentities ?? before.newIdentityAdmissions,
    state: action.kind === "freeze"
      ? "frozen"
      : action.kind === "resume"
        ? "open"
        : before.state,
  };
  const matchesDesired = (observed: AdmissionStatus): boolean =>
    observed.state === desired.state
    && observed.newIdentityAdmissions === desired.newIdentityAdmissions;
  const expectedBefore = before.generation === action.expectedGeneration;
  const possibleLostResponse = before.generation === action.expectedGeneration + 1
    && matchesDesired(before);
  if (
    (!expectedBefore && !possibleLostResponse)
    || (expectedBefore && matchesDesired(before))
  ) {
    throw new AdmissionOperatorError("transition_refused");
  }

  const changedResult = await invokeWithPostflight(
    transitionArguments(target.deploymentName, action, desired),
    "hosted-admission-transition",
  );
  if (changedResult.exitCode !== 0) {
    throw new AdmissionOperatorError("transition_refused");
  }
  const parsedChange = parseProviderJson(changedResult.stdout, transitionSchema);
  const changed = readStatus(parsedChange);
  const expectedGeneration = action.expectedGeneration + 1;
  if (
    !matchesDesired(changed)
    || changed.generation !== expectedGeneration
    || (possibleLostResponse && !parsedChange.replay)
  ) throw new AdmissionOperatorError("transition_refused");

  const afterResult = await invokeWithPostflight(
    statusArguments(target.deploymentName),
    "hosted-admission-read-after",
  );
  if (afterResult.exitCode !== 0) {
    throw new AdmissionOperatorError("provider_result_invalid");
  }
  const after = readStatus(parseProviderJson(afterResult.stdout, statusSchema));
  if (!matchesDesired(after) || after.generation !== expectedGeneration) {
    throw new AdmissionOperatorError("transition_refused");
  }
  return after;
}

type ExecuteAdmissionOptions = Readonly<{
  arguments: readonly string[];
  environment?: Readonly<NodeJS.ProcessEnv>;
  runner?: CommandRunner;
  stderr: Pick<NodeJS.WriteStream, "write">;
  stdout: Pick<NodeJS.WriteStream, "write">;
  verifyTarget?: ConvexTargetVerifier;
}>;

export async function executeHostedAdmission(options: ExecuteAdmissionOptions): Promise<number> {
  try {
    const parsed = parseAdmissionArguments(options.arguments);
    const status = await manageHostedAdmission({
      action: parsed.action,
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.runner === undefined ? {} : { runner: options.runner }),
      target: parsed.target,
      ...(options.verifyTarget === undefined ? {} : { verifyTarget: options.verifyTarget }),
    });
    options.stdout.write(`${JSON.stringify({
      generation: status.generation,
      newIdentityAdmissions: status.newIdentityAdmissions,
      state: status.state,
      version: 1,
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
    const code = error instanceof AdmissionOperatorError
      ? error.code
      : error instanceof ConvexTargetError
        ? "convex_target_refused"
        : "provider_result_invalid";
    options.stderr.write(`Hosted auth admission operation refused (${code}).\n`);
    return 1;
  }
}

if (import.meta.main) {
  let exitCode = 75;
  try {
    await recoverBoundedProcessJournal();
    exitCode = await executeHostedAdmission({
      arguments: process.argv.slice(2),
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
      process.stderr.write("Hosted auth admission operation refused (provider_result_invalid).\n");
      exitCode = 1;
    }
  }
  process.exitCode = exitCode;
}
