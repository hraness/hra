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

const statusSchema = z.object({
  generation: z.number().refine(isSafeNonNegativeInteger),
  state: z.union([z.literal("open"), z.literal("frozen")]),
  updatedAt: z.number().finite().nonnegative(),
}).strict();

const transitionSchema = statusSchema.extend({
  changed: z.boolean(),
  replay: z.boolean(),
}).strict();

type AdmissionStatus = z.infer<typeof statusSchema>;
type AdmissionAction =
  | Readonly<{ kind: "status" }>
  | Readonly<{
      expectedGeneration: number;
      kind: "freeze" | "resume";
      mutationId: string;
    }>;

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
  if (action !== "freeze" && action !== "resume") {
    throw new AdmissionOperatorError("usage_invalid");
  }
  const expected = takeOption(values, "--expected-generation");
  const mutationId = takeOption(values, "--mutation-id");
  const acknowledgedResume = takeFlag(values, "--acknowledge-resume");
  if (
    values.length !== 0
    || expected === undefined
    || !/^(0|[1-9][0-9]*)$/u.test(expected)
    || !isSafeNonNegativeInteger(Number(expected))
    || mutationId === undefined
    || !isUuidV7(mutationId)
    || (action === "resume") !== acknowledgedResume
  ) throw new AdmissionOperatorError("usage_invalid");
  return {
    action: {
      expectedGeneration: Number(expected),
      kind: action,
      mutationId,
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
  action: Extract<AdmissionAction, { kind: "freeze" | "resume" }>,
): readonly string[] => [
  "run",
  "admissionControl:transition",
  JSON.stringify({
    expectedGeneration: action.expectedGeneration,
    mutationId: action.mutationId,
    state: action.kind === "freeze" ? "frozen" : "open",
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
  const invoke = async (arguments_: readonly string[]): Promise<CommandResult> => await runner({
    arguments: [convexCli, ...arguments_],
    cwd: repositoryRoot,
    environment,
    executable: process.execPath,
    outputMaximumBytes: providerOutputMaximumBytes,
    stdin: "",
    timeoutMs: 60_000,
  });
  const invokeWithPostflight = async (
    arguments_: readonly string[],
  ): Promise<CommandResult> => {
    try {
      return await invoke(arguments_);
    } finally {
      await verify(target);
    }
  };

  await verify(target);
  const beforeResult = await invokeWithPostflight(statusArguments(target.deploymentName));
  if (beforeResult.exitCode !== 0) {
    throw new AdmissionOperatorError("provider_result_invalid");
  }
  const before = parseProviderJson(beforeResult.stdout, statusSchema);
  if (options.action.kind === "status") {
    return before;
  }

  const desired = options.action.kind === "freeze" ? "frozen" : "open";
  const expectedBefore = before.generation === options.action.expectedGeneration;
  const possibleLostResponse = before.generation === options.action.expectedGeneration + 1
    && before.state === desired;
  if (
    (!expectedBefore && !possibleLostResponse)
    || (expectedBefore && before.state === desired)
  ) {
    throw new AdmissionOperatorError("transition_refused");
  }

  const changedResult = await invokeWithPostflight(
    transitionArguments(target.deploymentName, options.action),
  );
  if (changedResult.exitCode !== 0) {
    throw new AdmissionOperatorError("transition_refused");
  }
  const changed = parseProviderJson(changedResult.stdout, transitionSchema);
  const expectedGeneration = options.action.expectedGeneration + 1;
  if (
    changed.state !== desired
    || changed.generation !== expectedGeneration
    || (possibleLostResponse && !changed.replay)
  ) throw new AdmissionOperatorError("transition_refused");

  const afterResult = await invokeWithPostflight(statusArguments(target.deploymentName));
  if (afterResult.exitCode !== 0) {
    throw new AdmissionOperatorError("provider_result_invalid");
  }
  const after = parseProviderJson(afterResult.stdout, statusSchema);
  if (after.state !== desired || after.generation !== expectedGeneration) {
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
      state: status.state,
      version: 1,
    })}\n`);
    return 0;
  } catch (error: unknown) {
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
  process.exitCode = await executeHostedAdmission({
    arguments: process.argv.slice(2),
    stderr: process.stderr,
    stdout: process.stdout,
  });
}
