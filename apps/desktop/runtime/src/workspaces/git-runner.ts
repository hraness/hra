import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

import type { RuntimePaths } from "../runtime-paths";

export interface GitResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface GitRunOptions {
  readonly killGraceMs?: number;
  readonly stderrLimitBytes?: number;
  readonly stdoutLimitBytes?: number;
  readonly terminateGraceMs?: number;
  readonly timeoutMs?: number;
}

export interface GitRunnerInstrumentation {
  /** Test/diagnostic boundary after config validation and before execution. */
  readonly afterConfigurationInspection?: (cwd: string) => void;
  /** Explicit descriptor executor fixture; never selected from ambient state. */
  readonly descriptorExecutorBinary?: string;
  /** Source-test-only escape hatch for non-Mach-O fake Git scripts. */
  readonly unsafeTestOnlyAllowPathExecution?: boolean;
}

export interface GitRunner {
  run(
    cwd: string,
    args: readonly string[],
    options?: GitRunOptions,
  ): Promise<GitResult>;
}

export class GitCommandError extends Error {
  readonly exitCode: number;

  constructor(_args: readonly string[], result: GitResult) {
    super(`Bundled Git exited with code ${String(result.exitCode)}`);
    this.name = "GitCommandError";
    this.exitCode = result.exitCode;
  }
}

export type GitExecutionFailureReason =
  | "capacity_unavailable"
  | "invalid_arguments"
  | "io_failure"
  | "kill_failed"
  | "spawn_failed"
  | "stderr_limit"
  | "stdout_limit"
  | "timeout"
  | "unsafe_configuration";

const executionFailureMessages = {
  capacity_unavailable: "Bundled Git is waiting for bounded execution capacity.",
  invalid_arguments: "Bundled Git received invalid arguments.",
  io_failure: "Bundled Git output could not be read safely.",
  kill_failed: "Bundled Git could not be terminated safely.",
  spawn_failed: "Bundled Git could not be started.",
  stderr_limit: "Bundled Git exceeded its standard-error limit.",
  stdout_limit: "Bundled Git exceeded its standard-output limit.",
  timeout: "Bundled Git exceeded its execution deadline.",
  unsafe_configuration: "Bundled Git rejected executable repository configuration.",
} as const satisfies Record<GitExecutionFailureReason, string>;

/**
 * Execution-boundary failures deliberately expose only a fixed reason and
 * message. Paths, arguments, inherited environment, and child output stay
 * outside every serialized error surface.
 */
export class GitExecutionError extends Error {
  readonly reason: GitExecutionFailureReason;

  constructor(reason: GitExecutionFailureReason) {
    super(executionFailureMessages[reason]);
    this.name = "GitExecutionError";
    this.reason = reason;
  }
}

interface ResolvedGitRunOptions {
  readonly killGraceMs: number;
  readonly stderrLimitBytes: number;
  readonly stdoutLimitBytes: number;
  readonly terminateGraceMs: number;
  readonly timeoutMs: number;
}

const defaultRunOptions: ResolvedGitRunOptions = {
  killGraceMs: 1_000,
  stderrLimitBytes: 64 * 1_024,
  stdoutLimitBytes: 1_024 * 1_024,
  terminateGraceMs: 250,
  timeoutMs: 120_000,
};
const maximumRunOptions: ResolvedGitRunOptions = {
  killGraceMs: 5_000,
  stderrLimitBytes: 8 * 1_024 * 1_024,
  stdoutLimitBytes: 16 * 1_024 * 1_024,
  terminateGraceMs: 5_000,
  timeoutMs: 10 * 60_000,
};
const configurationInspectionTimeoutMs = 15_000;
const configurationInspectionOutputBytes = 512 * 1_024;
const gitDirectoryExecutorName = "oprte-git-executor";
// The gateway's conservative 256-FD budget reserves at most 96 descriptors for
// 32 live account app-servers, 48 for these two-descriptor repository bindings,
// and 16 for eight Git stdout/stderr pairs. The remaining 96 descriptors stay
// available to Native transport, SQLite, cloud sockets, logs, and transients.
const maximumRepositoryBindings = 24;
const maximumParallelGitExecutions = 8;
const repositoryBindings = new Map<string, RepositoryBindingEntry>();
let repositoryBindingClock = 0;
let activeGitExecutions = 0;
const gitExecutionWaiters: GitExecutionWaiter[] = [];
const repositoryBindingCapacityWaiters: CapacitySignalWaiter[] = [];
const maximumArgumentCount = 256;
const maximumArgumentBytes = 64 * 1_024;
const allowedGitCommands = new Set([
  "branch",
  "cat-file",
  "ls-tree",
  "rev-parse",
  "show-ref",
  "status",
  "worktree",
]);
const allowedCallerGlobalArguments = new Set([
  "--no-optional-locks",
  "--no-pager",
]);
const macOSSandboxExecutable = "/usr/bin/sandbox-exec";
const machOMagicNumbers = new Set([
  "bebafeca", // FAT, little endian
  "bfbafeca", // FAT64, little endian
  "cafebabe", // FAT, big endian
  "cafebabf", // FAT64, big endian
  "cefaedfe", // Mach-O 32, little endian
  "cffaedfe", // Mach-O 64, little endian
  "feedface", // Mach-O 32, big endian
  "feedfacf", // Mach-O 64, big endian
]);

const controlledGitArguments = [
  "--no-replace-objects",
  "--no-pager",
  "--no-optional-locks",
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.untrackedCache=false",
  "-c", "credential.helper=",
  "-c", "credential.interactive=never",
  "-c", "core.askPass=/usr/bin/false",
  "-c", "core.sshCommand=/usr/bin/false",
  "-c", "protocol.ext.allow=never",
  "-c", "submodule.recurse=false",
  "-c", "fetch.recurseSubmodules=false",
  "-c", "push.recurseSubmodules=no",
  "-c", "gc.auto=0",
  "-c", "maintenance.auto=false",
] as const;

const prohibitedConfigurationPrefixes = [
  "alias.",
  "filter.",
  "include.",
  "includeif.",
  "difftool.",
  "mergetool.",
] as const;

const prohibitedConfigurationNames = new Set([
  "core.askpass",
  "core.editor",
  "core.fsmonitor",
  "core.hookspath",
  "core.pager",
  "core.sshcommand",
  "diff.external",
  "interactive.difffilter",
  "sequence.editor",
]);

interface BoundDirectory {
  readonly descriptor: number;
  readonly device: bigint;
  readonly inode: bigint;
  readonly path: string;
}

interface RepositoryBinding {
  readonly commonDirectory: BoundDirectory;
  readonly worktree: BoundDirectory;
}

interface RepositoryBindingEntry {
  binding: RepositoryBinding | null;
  readonly canonicalPath: string;
  lastUsed: number;
  pending: Promise<RepositoryBinding>;
  users: number;
}

interface RepositoryBindingLease {
  readonly binding: RepositoryBinding;
  readonly release: () => void;
}

interface GitExecutionWaiter {
  readonly reject: (error: GitExecutionError) => void;
  readonly resolve: (release: () => void) => void;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

interface CapacitySignalWaiter {
  readonly reject: (error: GitExecutionError) => void;
  readonly resolve: () => void;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

interface GitExecutionBoundary {
  readonly command: readonly string[];
  readonly containment: "command_process_group" | "gateway_generation";
  readonly directoryExecutor: string | null;
}

export class BundledGitRunner implements GitRunner {
  readonly #directoryExecutor: string | null;
  readonly #environment: Record<string, string>;
  readonly #executionCommand: readonly string[];
  readonly #processContainment:
    | "command_process_group"
    | "gateway_generation";
  readonly #instrumentation: GitRunnerInstrumentation;

  constructor(
    paths: RuntimePaths,
    environment: NodeJS.ProcessEnv = process.env,
    instrumentation: GitRunnerInstrumentation = {},
  ) {
    // The parameter remains for source compatibility, but no parent value is
    // admitted into the Git child. In particular, HOME, Git configuration,
    // dynamic-loader options, credentials, and proxy variables are excluded.
    void environment;
    const boundary = gitExecutionBoundary(
      paths.gitBinary,
      paths.gitRoot,
      instrumentation,
    );
    this.#directoryExecutor = boundary.directoryExecutor;
    this.#executionCommand = boundary.command;
    this.#processContainment = boundary.containment;
    this.#instrumentation = instrumentation;
    this.#environment = {
      GIT_ASKPASS: "/usr/bin/false",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CEILING_DIRECTORIES: "/",
      GIT_CONFIG_COUNT: "0",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_DISCOVERY_ACROSS_FILESYSTEM: "0",
      GIT_EXEC_PATH: join(paths.gitRoot, "libexec", "git-core"),
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TEMPLATE_DIR: join(paths.gitRoot, "share", "git-core", "templates"),
      GIT_TERMINAL_PROMPT: "0",
      HOME: "/var/empty",
      LANG: "C",
      LC_ALL: "C",
      PATH: `${join(paths.gitRoot, "bin")}:/usr/bin:/bin`,
      SSH_ASKPASS: "/usr/bin/false",
      TMPDIR: paths.codexHome,
      XDG_CONFIG_HOME: "/var/empty",
    };
  }

  async run(
    cwd: string,
    args: readonly string[],
    options?: GitRunOptions,
  ): Promise<GitResult> {
    assertArguments(args);
    const resolved = resolveOptions(options);
    const deadline = performance.now() + resolved.timeoutMs;
    const command = callerCommand(args);
    const releaseExecution = await acquireGitExecutionSlot(deadline);
    let lease: RepositoryBindingLease | null = null;
    try {
      lease = await this.#repositoryBinding(cwd, resolved, deadline);
      const binding = lease?.binding ?? null;
      const useCommonDirectory = binding !== null
        && commonDirectoryCommand(command);
      const directory = binding === null
        ? cwd
        : useCommonDirectory
        ? binding.commonDirectory
        : binding.worktree;
      const repositoryArguments = useCommonDirectory ? ["--git-dir=."] : [];
      await this.#assertConfigurationSafe(
        directory,
        repositoryArguments,
        resolved,
        deadline,
      );
      try {
        this.#instrumentation.afterConfigurationInspection?.(
          binding?.worktree.path ?? cwd,
        );
      } catch {
        throw new GitExecutionError("io_failure");
      }
      return await this.#execute(
        directory,
        [...controlledGitArguments, ...repositoryArguments, ...args],
        resolved,
        deadline,
      );
    } finally {
      lease?.release();
      releaseExecution();
    }
  }

  async #repositoryBinding(
    cwd: string,
    options: ResolvedGitRunOptions,
    deadline: number,
  ): Promise<RepositoryBindingLease | null> {
    if (this.#directoryExecutor === null) return null;

    for (;;) {
      const candidate = openBoundDirectory(cwd);
      const canonicalPath = candidate.path;
      const existing = repositoryBindings.get(canonicalPath);
      if (existing !== undefined) {
        existing.users += 1;
        try {
          const binding = await bindingBeforeDeadline(existing.pending, deadline);
          assertSameDirectory(candidate, binding.worktree);
          assertPublishedDirectory(binding.worktree);
          assertPublishedDirectory(binding.commonDirectory);
          return bindingLease(existing, binding);
        } catch (error: unknown) {
          releaseRepositoryBinding(existing);
          throw error;
        } finally {
          closeSync(candidate.descriptor);
        }
      }
      if (
        repositoryBindings.size >= maximumRepositoryBindings &&
        !evictLeastRecentlyUsedRepositoryBinding()
      ) {
        closeSync(candidate.descriptor);
        await waitForRepositoryBindingCapacity(deadline);
        continue;
      }

      const entry: RepositoryBindingEntry = {
        binding: null,
        canonicalPath,
        lastUsed: ++repositoryBindingClock,
        pending: Promise.resolve(null as never),
        users: 1,
      };
      entry.pending = this.#createRepositoryBinding(
        candidate,
        options,
        deadline,
      ).then((binding) => {
        entry.binding = binding;
        return binding;
      });
      repositoryBindings.set(canonicalPath, entry);
      try {
        const binding = await entry.pending;
        return bindingLease(entry, binding);
      } catch (error: unknown) {
        if (repositoryBindings.get(canonicalPath) === entry) {
          repositoryBindings.delete(canonicalPath);
          notifyRepositoryBindingCapacity();
        }
        throw error;
      }
    }
  }

  async #createRepositoryBinding(
    worktree: BoundDirectory,
    options: ResolvedGitRunOptions,
    deadline: number,
  ): Promise<RepositoryBinding> {
    let commonDirectory: BoundDirectory | null = null;
    try {
      const result = await this.#execute(
        worktree,
        [
          ...controlledGitArguments,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ],
        {
          ...options,
          stderrLimitBytes: Math.min(
            options.stderrLimitBytes,
            defaultRunOptions.stderrLimitBytes,
          ),
          stdoutLimitBytes: Math.min(options.stdoutLimitBytes, 16 * 1_024),
        },
        Math.min(
          deadline,
          performance.now() + configurationInspectionTimeoutMs,
        ),
      );
      if (result.exitCode !== 0) {
        throw new GitExecutionError("unsafe_configuration");
      }
      commonDirectory = openBoundDirectory(
        parseAbsoluteGitDirectory(result.stdout),
      );
      return { commonDirectory, worktree };
    } catch (error: unknown) {
      closeSync(worktree.descriptor);
      if (commonDirectory !== null) closeSync(commonDirectory.descriptor);
      if (error instanceof GitExecutionError) throw error;
      throw new GitExecutionError("unsafe_configuration");
    }
  }

  async #assertConfigurationSafe(
    directory: string | BoundDirectory,
    repositoryArguments: readonly string[],
    options: ResolvedGitRunOptions,
    deadline: number,
  ): Promise<void> {
    const result = await this.#execute(
      directory,
      [
        ...repositoryArguments,
        "--no-pager",
        "--no-optional-locks",
        "config",
        "--null",
        "--name-only",
        "--list",
        "--no-includes",
      ],
      {
        ...options,
        stderrLimitBytes: Math.min(
          options.stderrLimitBytes,
          defaultRunOptions.stderrLimitBytes,
        ),
        stdoutLimitBytes: Math.min(
          options.stdoutLimitBytes,
          configurationInspectionOutputBytes,
        ),
      },
      Math.min(
        deadline,
        performance.now() + configurationInspectionTimeoutMs,
      ),
    );
    if (result.exitCode !== 0) {
      throw new GitExecutionError("unsafe_configuration");
    }
    for (const rawName of result.stdout.split("\0")) {
      const name = rawName.trim().toLowerCase();
      if (name.length === 0) continue;
      if (
        prohibitedConfigurationNames.has(name)
        || prohibitedConfigurationPrefixes.some((prefix) =>
          name.startsWith(prefix)
        )
        || /^diff\..+\.command$/u.test(name)
        || /^merge\..+\.driver$/u.test(name)
        || /^pager\..+$/u.test(name)
        || /^submodule\..+\.update$/u.test(name)
      ) {
        throw new GitExecutionError("unsafe_configuration");
      }
    }
  }

  async #execute(
    directory: string | BoundDirectory,
    args: readonly string[],
    options: ResolvedGitRunOptions,
    deadline: number,
  ): Promise<GitResult> {
    if (deadline <= performance.now()) {
      throw new GitExecutionError("timeout");
    }
    let child: Bun.Subprocess<number | "ignore", "pipe", "pipe">;
    try {
      const bound = typeof directory === "string" ? null : directory;
      const spawnCwd = typeof directory === "string" ? directory : "/";
      const command = bound === null
        ? [...this.#executionCommand, ...args]
        : [
            this.#directoryExecutor ?? failMissingDirectoryExecutor(),
            ...this.#executionCommand,
            ...args,
          ];
      child = Bun.spawn(command, {
        cwd: spawnCwd,
        // Packaged Darwin Git remains in Native's generation process group.
        // Test/portable commands lack that Native owner, so they retain an
        // isolated group that this runner can fence without exiting its host.
        detached: this.#processContainment === "command_process_group"
          && process.platform !== "win32",
        env: this.#environment,
        stdin: bound?.descriptor ?? "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch {
      throw new GitExecutionError("spawn_failed");
    }

    const captureAbort = new AbortController();
    const completion = Promise.all([
      child.exited,
      readBoundedOutput(
        child.stdout,
        options.stdoutLimitBytes,
        "stdout_limit",
        captureAbort.signal,
      ),
      readBoundedOutput(
        child.stderr,
        options.stderrLimitBytes,
        "stderr_limit",
        captureAbort.signal,
      ),
    ]);
    void completion.catch(() => undefined);
    const timeout = monotonicTimeout(deadline);

    try {
      const [exitCode, stdout, stderr] = await Promise.race([
        completion,
        timeout.promise,
      ]);
      timeout.cancel();
      if (
        this.#processContainment === "command_process_group"
        && processGroupExists(child.pid)
      ) {
        const stopped = await terminateProcessGroup(
          child,
          options.terminateGraceMs,
          options.killGraceMs,
        );
        if (!stopped) throw new GitExecutionError("kill_failed");
        throw new GitExecutionError("unsafe_configuration");
      }
      return {
        exitCode,
        stderr: stderr.trimEnd(),
        stdout: stdout.trimEnd(),
      };
    } catch (error: unknown) {
      timeout.cancel();
      if (this.#processContainment === "gateway_generation") {
        // A post-spawn failure cannot prove which synchronous Git helper still
        // owns repository effects. End this generation unconditionally. Native
        // owns the enclosing PGID and will fence it before any relaunch, so no
        // caller can catch this error and overlap another mutation.
        fatalGatewayGeneration();
      }
      const stopped = await terminateProcessGroup(
        child,
        options.terminateGraceMs,
        options.killGraceMs,
      );
      captureAbort.abort();
      if (!stopped) throw new GitExecutionError("kill_failed");
      if (error instanceof GitExecutionError) throw error;
      throw new GitExecutionError("io_failure");
    } finally {
      timeout.cancel();
      captureAbort.abort();
    }
  }
}

function gitExecutionBoundary(
  gitBinary: string,
  gitRoot: string,
  instrumentation: GitRunnerInstrumentation,
): GitExecutionBoundary {
  const canonicalGitBinary = canonicalExecutable(gitBinary, false);
  if (process.platform !== "darwin") {
    return {
      command: [canonicalGitBinary],
      containment: "command_process_group",
      directoryExecutor: null,
    };
  }

  if (instrumentation.unsafeTestOnlyAllowPathExecution === true) {
    if (basename(process.execPath) !== "bun") {
      throw new GitExecutionError("unsafe_configuration");
    }
    return {
      command: [canonicalGitBinary],
      containment: "command_process_group",
      directoryExecutor: null,
    };
  }

  assertMachOExecutable(canonicalGitBinary);
  const canonicalGitCore = canonicalExecutable(
    join(gitRoot, "libexec", "git-core", "git"),
    true,
  );
  const canonicalSandboxExecutable = canonicalExecutable(
    macOSSandboxExecutable,
    true,
  );
  if (canonicalSandboxExecutable !== macOSSandboxExecutable) {
    throw new GitExecutionError("unsafe_configuration");
  }
  const directoryExecutor = resolveDirectoryExecutor(
    gitRoot,
    instrumentation.descriptorExecutorBinary,
  );

  // The repository config remains data, never an executable extension point.
  // This child policy closes the scan/execute race for filters, diff/merge
  // drivers, pagers, editors, credential helpers, and hooks even if a same-UID
  // process rewrites config after validation. All Git commands admitted by
  // this runner are built into the sealed bundled executable.
  const profile = [
    "(version 1)",
    "(allow default)",
    "(deny process-exec)",
    "(deny network*)",
    `(allow process-exec (literal ${JSON.stringify(canonicalGitBinary)}))`,
    `(allow process-exec (literal ${JSON.stringify(canonicalGitCore)}))`,
  ].join("");
  return {
    command: [
      canonicalSandboxExecutable,
      "-p",
      profile,
      canonicalGitBinary,
    ],
    containment: "gateway_generation",
    directoryExecutor,
  };
}

function fatalGatewayGeneration(): never {
  // This process is the compiled private gateway. Exiting it closes Native's
  // transport immediately; Native then sends one generation-wide SIGKILL and
  // proves that PGID absent before starting a replacement. Keep the exit code
  // fixed and pathless because it may reach development process diagnostics.
  process.exit(86);
}

function canonicalExecutable(path: string, requireMachO: boolean): string {
  let canonical: string;
  try {
    canonical = realpathSync(path);
    const metadata = lstatSync(canonical);
    if (!metadata.isFile() || (metadata.mode & 0o111) === 0) {
      throw new Error("not an executable regular file");
    }
  } catch {
    throw new GitExecutionError("unsafe_configuration");
  }
  if (requireMachO) assertMachOExecutable(canonical);
  return canonical;
}

function assertMachOExecutable(path: string): void {
  if (!isMachOExecutable(path)) {
    throw new GitExecutionError("unsafe_configuration");
  }
}

function resolveDirectoryExecutor(
  gitRoot: string,
  override: string | undefined,
): string {
  const candidates = override === undefined
    ? [
        join(dirname(gitRoot), "bin", gitDirectoryExecutorName),
        join(
          import.meta.dir,
          "..",
          "..",
          "..",
          "zig-out",
          "bin",
          gitDirectoryExecutorName,
        ),
      ]
    : [override];
  for (const candidate of candidates) {
    try {
      return canonicalExecutable(candidate, true);
    } catch (error: unknown) {
      if (!(error instanceof GitExecutionError)) throw error;
    }
  }
  throw new GitExecutionError("unsafe_configuration");
}

function callerCommand(args: readonly string[]): string {
  const command = args.find((argument) =>
    !allowedCallerGlobalArguments.has(argument)
  );
  if (command === undefined || !allowedGitCommands.has(command)) {
    throw new GitExecutionError("invalid_arguments");
  }
  return command;
}

function commonDirectoryCommand(command: string): boolean {
  return command === "show-ref" || command === "worktree";
}

function openBoundDirectory(path: string): BoundDirectory {
  if (!isAbsolute(path)) {
    throw new GitExecutionError("invalid_arguments");
  }
  let descriptor: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error("not a direct directory");
    }
    const canonicalPath = realpathSync(path);
    descriptor = openSync(
      canonicalPath,
      constants.O_RDONLY
        | constants.O_NOFOLLOW
        | constants.O_DIRECTORY,
    );
    const opened = fstatSync(descriptor, { bigint: true });
    const published = lstatSync(canonicalPath, { bigint: true });
    const after = lstatSync(path, { bigint: true });
    if (
      !opened.isDirectory()
      || !published.isDirectory()
      || !after.isDirectory()
      || published.isSymbolicLink()
      || after.isSymbolicLink()
      || before.dev !== opened.dev
      || before.ino !== opened.ino
      || opened.dev !== published.dev
      || opened.ino !== published.ino
      || opened.dev !== after.dev
      || opened.ino !== after.ino
    ) {
      throw new Error("directory identity changed");
    }
    return {
      descriptor,
      device: opened.dev,
      inode: opened.ino,
      path: canonicalPath,
    };
  } catch {
    if (descriptor !== undefined) closeSync(descriptor);
    throw new GitExecutionError("unsafe_configuration");
  }
}

function assertSameDirectory(
  left: BoundDirectory,
  right: BoundDirectory,
): void {
  if (left.device !== right.device || left.inode !== right.inode) {
    throw new GitExecutionError("unsafe_configuration");
  }
}

function assertPublishedDirectory(directory: BoundDirectory): void {
  try {
    const opened = fstatSync(directory.descriptor, { bigint: true });
    const published = lstatSync(directory.path, { bigint: true });
    if (
      !opened.isDirectory()
      || !published.isDirectory()
      || published.isSymbolicLink()
      || opened.dev !== directory.device
      || opened.ino !== directory.inode
      || published.dev !== directory.device
      || published.ino !== directory.inode
    ) {
      throw new Error("directory identity changed");
    }
  } catch {
    throw new GitExecutionError("unsafe_configuration");
  }
}

function bindingLease(
  entry: RepositoryBindingEntry,
  binding: RepositoryBinding,
): RepositoryBindingLease {
  let released = false;
  return {
    binding,
    release() {
      if (released) return;
      released = true;
      releaseRepositoryBinding(entry);
    },
  };
}

function releaseRepositoryBinding(entry: RepositoryBindingEntry): void {
  if (entry.users <= 0) throw new GitExecutionError("io_failure");
  entry.users -= 1;
  entry.lastUsed = ++repositoryBindingClock;
  if (entry.users === 0) notifyRepositoryBindingCapacity();
}

function evictLeastRecentlyUsedRepositoryBinding(): boolean {
  let selected: RepositoryBindingEntry | null = null;
  for (const entry of repositoryBindings.values()) {
    if (entry.users !== 0 || entry.binding === null) continue;
    if (selected === null || entry.lastUsed < selected.lastUsed) selected = entry;
  }
  if (selected === null || selected.binding === null) return false;
  if (repositoryBindings.get(selected.canonicalPath) !== selected) return false;
  repositoryBindings.delete(selected.canonicalPath);
  closeSync(selected.binding.commonDirectory.descriptor);
  closeSync(selected.binding.worktree.descriptor);
  return true;
}

async function acquireGitExecutionSlot(deadline: number): Promise<() => void> {
  if (deadline <= performance.now()) {
    throw new GitExecutionError("capacity_unavailable");
  }
  if (
    activeGitExecutions < maximumParallelGitExecutions &&
    gitExecutionWaiters.length === 0
  ) {
    activeGitExecutions += 1;
    return gitExecutionRelease();
  }
  return await new Promise<() => void>((resolve, reject) => {
    const waiter: GitExecutionWaiter = {
      reject,
      resolve,
      settled: false,
      timer: null,
    };
    gitExecutionWaiters.push(waiter);
    armCapacityDeadline(waiter, deadline, gitExecutionWaiters);
  });
}

function gitExecutionRelease(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = takeCapacityWaiter(gitExecutionWaiters);
    if (next === null) {
      if (activeGitExecutions <= 0) throw new GitExecutionError("io_failure");
      activeGitExecutions -= 1;
      return;
    }
    next.resolve(gitExecutionRelease());
  };
}

async function waitForRepositoryBindingCapacity(deadline: number): Promise<void> {
  if (deadline <= performance.now()) {
    throw new GitExecutionError("capacity_unavailable");
  }
  await new Promise<void>((resolve, reject) => {
    const waiter: CapacitySignalWaiter = {
      reject,
      resolve,
      settled: false,
      timer: null,
    };
    repositoryBindingCapacityWaiters.push(waiter);
    armCapacityDeadline(waiter, deadline, repositoryBindingCapacityWaiters);
  });
}

function notifyRepositoryBindingCapacity(): void {
  takeCapacityWaiter(repositoryBindingCapacityWaiters)?.resolve();
}

function armCapacityDeadline<T extends GitExecutionWaiter | CapacitySignalWaiter>(
  waiter: T,
  deadline: number,
  queue: T[],
): void {
  const check = (): void => {
    if (waiter.settled) return;
    const remaining = deadline - performance.now();
    if (remaining > 0) {
      waiter.timer = setTimeout(check, Math.min(remaining, 1_000));
      return;
    }
    waiter.settled = true;
    const index = queue.indexOf(waiter);
    if (index >= 0) queue.splice(index, 1);
    waiter.reject(new GitExecutionError("capacity_unavailable"));
  };
  check();
}

function takeCapacityWaiter<T extends GitExecutionWaiter | CapacitySignalWaiter>(
  queue: T[],
): T | null {
  for (;;) {
    const waiter = queue.shift();
    if (waiter === undefined) return null;
    if (waiter.settled) continue;
    waiter.settled = true;
    if (waiter.timer !== null) clearTimeout(waiter.timer);
    return waiter;
  }
}

function parseAbsoluteGitDirectory(output: string): string {
  if (
    output.length === 0
    || output.includes("\0")
    || output.includes("\n")
    || output.includes("\r")
    || !isAbsolute(output)
  ) {
    throw new GitExecutionError("unsafe_configuration");
  }
  return output;
}

function failMissingDirectoryExecutor(): never {
  throw new GitExecutionError("unsafe_configuration");
}

async function bindingBeforeDeadline(
  binding: Promise<RepositoryBinding>,
  deadline: number,
): Promise<RepositoryBinding> {
  if (deadline <= performance.now()) {
    throw new GitExecutionError("timeout");
  }
  const timeout = monotonicTimeout(deadline);
  try {
    return await Promise.race([binding, timeout.promise]);
  } finally {
    timeout.cancel();
  }
}

function isMachOExecutable(path: string): boolean {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const header = Buffer.allocUnsafe(4);
    if (readSync(descriptor, header, 0, header.byteLength, 0) !== 4) {
      return false;
    }
    return machOMagicNumbers.has(header.toString("hex"));
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export async function requireGit(
  runner: GitRunner,
  cwd: string,
  args: readonly string[],
  options?: GitRunOptions,
): Promise<string> {
  const result = await runner.run(cwd, args, options);
  if (result.exitCode !== 0) throw new GitCommandError(args, result);
  return result.stdout;
}

function assertArguments(args: readonly string[]): void {
  if (args.length === 0 || args.length > maximumArgumentCount) {
    throw new GitExecutionError("invalid_arguments");
  }
  let byteCount = 0;
  let command: string | undefined;
  for (const argument of args) {
    if (argument.includes("\0")) {
      throw new GitExecutionError("invalid_arguments");
    }
    byteCount += Buffer.byteLength(argument);
    if (byteCount > maximumArgumentBytes) {
      throw new GitExecutionError("invalid_arguments");
    }
    if (command === undefined && !allowedCallerGlobalArguments.has(argument)) {
      command = argument;
    }
  }
  if (command === undefined || !allowedGitCommands.has(command)) {
    throw new GitExecutionError("invalid_arguments");
  }
  const commandIndex = args.indexOf(command);
  if (command === "cat-file") {
    if (
      commandIndex < 0 || args.length - commandIndex !== 3 ||
      args[commandIndex + 1] !== "blob" ||
      !/^[a-f0-9]{40,64}$/u.test(args[commandIndex + 2] ?? "")
    ) throw new GitExecutionError("invalid_arguments");
  }
  if (command === "ls-tree") {
    if (
      commandIndex < 0 || args.length - commandIndex !== 5 ||
      args[commandIndex + 1] !== "-z" ||
      !/^[a-f0-9]{40,64}$/u.test(args[commandIndex + 2] ?? "") ||
      args[commandIndex + 3] !== "--" ||
      args[commandIndex + 4] !== ".hra/workspace.json"
    ) throw new GitExecutionError("invalid_arguments");
  }
}

function resolveOptions(options: GitRunOptions | undefined): ResolvedGitRunOptions {
  return {
    killGraceMs: boundedOption(
      options?.killGraceMs,
      defaultRunOptions.killGraceMs,
      maximumRunOptions.killGraceMs,
    ),
    stderrLimitBytes: boundedOption(
      options?.stderrLimitBytes,
      defaultRunOptions.stderrLimitBytes,
      maximumRunOptions.stderrLimitBytes,
    ),
    stdoutLimitBytes: boundedOption(
      options?.stdoutLimitBytes,
      defaultRunOptions.stdoutLimitBytes,
      maximumRunOptions.stdoutLimitBytes,
    ),
    terminateGraceMs: boundedOption(
      options?.terminateGraceMs,
      defaultRunOptions.terminateGraceMs,
      maximumRunOptions.terminateGraceMs,
    ),
    timeoutMs: boundedOption(
      options?.timeoutMs,
      defaultRunOptions.timeoutMs,
      maximumRunOptions.timeoutMs,
    ),
  };
}

function boundedOption(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved)
    || resolved < 1
    || resolved > maximum
  ) {
    throw new GitExecutionError("invalid_arguments");
  }
  return resolved;
}

async function readBoundedOutput(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  overflowReason: "stderr_limit" | "stdout_limit",
  signal: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  let storage = new Uint8Array(Math.min(maximumBytes, 8 * 1_024));
  let length = 0;
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      if (result.value.byteLength > maximumBytes - length) {
        throw new GitExecutionError(overflowReason);
      }
      const required = length + result.value.byteLength;
      if (required > storage.byteLength) {
        let capacity = storage.byteLength;
        while (capacity < required) {
          capacity = Math.min(
            maximumBytes,
            Math.max(required, Math.max(1, capacity * 2)),
          );
        }
        const grown = new Uint8Array(capacity);
        grown.set(storage.subarray(0, length));
        storage = grown;
      }
      storage.set(result.value, length);
      length = required;
    }
    return new TextDecoder().decode(storage.subarray(0, length));
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function monotonicTimeout(deadline: number): {
  readonly cancel: () => void;
  readonly promise: Promise<never>;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const promise = new Promise<never>((_resolve, reject) => {
    const check = (): void => {
      if (cancelled) return;
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        reject(new GitExecutionError("timeout"));
        return;
      }
      timer = setTimeout(check, Math.min(remaining, 1_000));
    };
    check();
  });
  return {
    cancel() {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    },
    promise,
  };
}

function processGroupExists(processId: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-processId, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function terminateProcessGroup(
  child: Bun.Subprocess<number | "ignore", "pipe", "pipe">,
  terminateGraceMs: number,
  killGraceMs: number,
): Promise<boolean> {
  const useProcessGroup = process.platform !== "win32";
  const exists = (): boolean => useProcessGroup
    ? processGroupExists(child.pid)
    : child.exitCode === null;
  const signal = (value: NodeJS.Signals): void => {
    if (useProcessGroup) {
      try {
        process.kill(-child.pid, value);
        return;
      } catch {
        // A just-exited group falls through to the direct child handle.
      }
    }
    try {
      child.kill(value);
    } catch {
      // An already-exited process needs no further cleanup.
    }
  };

  if (!exists()) return true;
  signal("SIGTERM");
  if (await waitUntilMissing(exists, terminateGraceMs)) return true;
  signal("SIGKILL");
  return await waitUntilMissing(exists, killGraceMs);
}

async function waitUntilMissing(
  exists: () => boolean,
  maximumWaitMs: number,
): Promise<boolean> {
  const deadline = performance.now() + maximumWaitMs;
  while (exists()) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(10, remaining));
    });
  }
  return true;
}
