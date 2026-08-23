import { constants } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

const convexDeployOutputMaximumBytes = 512 * 1024;
const convexDeployTimeoutMs = 10 * 60 * 1_000;
const gitOutputMaximumBytes = 64 * 1024;
const sourceCommitPattern = /^[0-9a-f]{40}$/u;

type HostedDeployFailureCode =
  | "convex_deploy_failed"
  | "convex_target_refused"
  | "source_changed"
  | "target_file_refused"
  | "usage_invalid";

class HostedDeployError extends Error {
  readonly code: HostedDeployFailureCode;

  constructor(code: HostedDeployFailureCode) {
    super(code);
    this.name = "HostedDeployError";
    this.code = code;
  }
}

type DeployArguments = Readonly<{
  sourceCommit: string;
  target: ConvexTarget;
}>;

export function parseDeployArguments(arguments_: readonly string[]): DeployArguments {
  let parsedTarget: ReturnType<typeof parseConvexTargetArguments>;
  try {
    parsedTarget = parseConvexTargetArguments(arguments_);
  } catch {
    throw new HostedDeployError("usage_invalid");
  }
  let sourceCommit: string | undefined;
  for (let index = 0; index < parsedTarget.otherArguments.length; index += 1) {
    const argument = parsedTarget.otherArguments[index];
    if (argument === "--source-commit" && sourceCommit === undefined) {
      const value = parsedTarget.otherArguments[index + 1];
      if (value === undefined || !sourceCommitPattern.test(value)) {
        throw new HostedDeployError("usage_invalid");
      }
      sourceCommit = value;
      index += 1;
      continue;
    }
    throw new HostedDeployError("usage_invalid");
  }
  if (sourceCommit === undefined) throw new HostedDeployError("usage_invalid");
  return { sourceCommit, target: parsedTarget.target };
}

const convexCli = resolve(import.meta.dir, "..", "node_modules", "convex", "bin", "main.js");
const defaultRepositoryRoot = resolve(import.meta.dir, "..");

const invokeGit = async (
  runner: CommandRunner,
  repositoryRoot: string,
  environment: Readonly<Record<string, string>>,
  arguments_: readonly string[],
): Promise<CommandResult> => await runner({
  arguments: arguments_,
  cwd: repositoryRoot,
  environment,
  executable: "git",
  outputMaximumBytes: gitOutputMaximumBytes,
  stdin: "",
  timeoutMs: 60_000,
});

const requireExactSource = async (
  runner: CommandRunner,
  repositoryRoot: string,
  environment: Readonly<Record<string, string>>,
  sourceCommit: string,
): Promise<void> => {
  const head = await invokeGit(
    runner,
    repositoryRoot,
    environment,
    ["rev-parse", "--verify", "HEAD"],
  );
  if (
    head.exitCode !== 0
    || head.stdout !== `${sourceCommit}\n`
  ) throw new HostedDeployError("source_changed");
  const status = await invokeGit(
    runner,
    repositoryRoot,
    environment,
    ["status", "--porcelain=v1", "--untracked-files=all"],
  );
  if (status.exitCode !== 0 || status.stdout !== "") {
    throw new HostedDeployError("source_changed");
  }
};

type DeploymentBinding = Readonly<{
  cleanup: () => Promise<void>;
  path: string;
}>;

const closeQuietly = async (handle: FileHandle): Promise<void> => {
  await handle.close().catch(() => undefined);
};

async function createDeploymentBinding(
  deploymentName: string,
  temporaryRoot = tmpdir(),
): Promise<DeploymentBinding> {
  let directory: string;
  try {
    directory = await mkdtemp(join(temporaryRoot, "hra-hosted-deploy-"));
  } catch {
    throw new HostedDeployError("target_file_refused");
  }
  const path = join(directory, "convex-target.env");
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_WRONLY
        | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    await rm(directory, { force: true, recursive: true }).catch(() => undefined);
    throw new HostedDeployError("target_file_refused");
  }
  try {
    await handle.writeFile(`CONVEX_DEPLOYMENT=prod:${deploymentName}\n`, "utf8");
    await handle.sync();
    const identity = await handle.stat();
    const current = await lstat(path);
    if (
      !identity.isFile()
      || identity.nlink !== 1
      || (identity.mode & 0o777) !== 0o600
      || !current.isFile()
      || current.dev !== identity.dev
      || current.ino !== identity.ino
      || current.nlink !== 1
      || (current.mode & 0o777) !== 0o600
    ) throw new HostedDeployError("target_file_refused");
  } catch {
    await closeQuietly(handle);
    await rm(directory, { force: true, recursive: true }).catch(() => undefined);
    throw new HostedDeployError("target_file_refused");
  }
  await closeQuietly(handle);
  let cleaned = false;
  return {
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      try {
        await rm(directory, { force: false, recursive: true });
      } catch {
        throw new HostedDeployError("target_file_refused");
      }
    },
    path,
  };
}

type HostedDeployOptions = Readonly<{
  environment?: Readonly<NodeJS.ProcessEnv>;
  repositoryRoot?: string;
  runner?: CommandRunner;
  sourceCommit: string;
  target: ConvexTarget;
  temporaryRoot?: string;
  verifyTarget?: ConvexTargetVerifier;
}>;

export async function deployHostedSync(options: HostedDeployOptions): Promise<void> {
  if (!sourceCommitPattern.test(options.sourceCommit)) {
    throw new HostedDeployError("usage_invalid");
  }
  const target = parseConvexTarget(options.target);
  const runner = options.runner ?? runCommand;
  const repositoryRoot = options.repositoryRoot ?? defaultRepositoryRoot;
  const environment = buildConvexChildEnvironment(options.environment ?? process.env, []);
  const verifyTarget = options.verifyTarget ?? verifyConvexTarget;

  await requireExactSource(
    runner,
    repositoryRoot,
    environment,
    options.sourceCommit,
  );
  await verifyTarget(target);
  const binding = await createDeploymentBinding(
    target.deploymentName,
    options.temporaryRoot,
  );
  let failure: Error | undefined;
  try {
    let result: CommandResult | undefined;
    try {
      result = await runner({
        arguments: [
          convexCli,
          "deploy",
          "--env-file",
          binding.path,
          "--yes",
          "--typecheck",
          "enable",
          "--codegen",
          "disable",
          "--message",
          `HRA source ${options.sourceCommit}`,
        ],
        cwd: repositoryRoot,
        environment,
        executable: process.execPath,
        outputMaximumBytes: convexDeployOutputMaximumBytes,
        stdin: "",
        timeoutMs: convexDeployTimeoutMs,
      });
    } catch {
      result = undefined;
    }
    await verifyTarget(target);
    if (result === undefined || result.exitCode !== 0) {
      throw new HostedDeployError("convex_deploy_failed");
    }
    await requireExactSource(
      runner,
      repositoryRoot,
      environment,
      options.sourceCommit,
    );
  } catch (error: unknown) {
    failure = error instanceof Error
      ? error
      : new HostedDeployError("convex_deploy_failed");
  }
  try {
    await binding.cleanup();
  } catch (error: unknown) {
    if (failure === undefined) {
      failure = error instanceof Error
        ? error
        : new HostedDeployError("target_file_refused");
    }
  }
  if (failure !== undefined) throw failure;
}

type ExecuteOptions = Readonly<{
  arguments: readonly string[];
  environment?: Readonly<NodeJS.ProcessEnv>;
  repositoryRoot?: string;
  runner?: CommandRunner;
  stderr: Pick<NodeJS.WriteStream, "write">;
  stdout: Pick<NodeJS.WriteStream, "write">;
  temporaryRoot?: string;
  verifyTarget?: ConvexTargetVerifier;
}>;

export async function executeHostedDeploy(options: ExecuteOptions): Promise<number> {
  try {
    const parsed = parseDeployArguments(options.arguments);
    await deployHostedSync({
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.repositoryRoot === undefined ? {} : { repositoryRoot: options.repositoryRoot }),
      ...(options.runner === undefined ? {} : { runner: options.runner }),
      sourceCommit: parsed.sourceCommit,
      target: parsed.target,
      ...(options.temporaryRoot === undefined ? {} : { temporaryRoot: options.temporaryRoot }),
      ...(options.verifyTarget === undefined ? {} : { verifyTarget: options.verifyTarget }),
    });
    options.stdout.write(`Deployed exact source ${parsed.sourceCommit} to the verified target.\n`);
    return 0;
  } catch (error: unknown) {
    const code = error instanceof HostedDeployError
      ? error.code
      : error instanceof ConvexTargetError
        ? "convex_target_refused"
        : "convex_deploy_failed";
    options.stderr.write(`Hosted deploy refused (${code}).\n`);
    return 1;
  }
}

if (import.meta.main) {
  const exitCode = await executeHostedDeploy({
    arguments: process.argv.slice(2),
    stderr: process.stderr,
    stdout: process.stdout,
  });
  process.exitCode = exitCode;
}

export type { CommandRequest };
