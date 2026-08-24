import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { z } from "zod";

import {
  DaemonLock,
  readDaemonAuthorityReceipt,
  type DaemonAuthorityReceipt,
} from "../src/daemon/daemon-lock";
import {
  daemonIdentitySchema,
  identityFromReceipt,
  sameDaemonIdentity,
  terminateDaemonStartupChild,
  type DaemonIdentity,
} from "../src/daemon/daemon-startup";
import type { StatePaths } from "../src/storage/paths";
import { resolveStatePaths } from "../src/storage/paths";
import {
  assertPublicSensitiveText,
  assertPublicText,
  assertPublicTree,
} from "./public-text-policy";
import { assertProductionPackageOnly } from "./package-policy";

const packageSchema = z.object({
  bin: z.object({ hra: z.literal("./src/cli.ts") }).strict(),
  bugs: z.object({ url: z.literal("https://github.com/hraness/hra/issues") }).strict(),
  engines: z.object({ bun: z.literal("1.3.14") }).strict(),
  exports: z.object({ ".": z.literal("./src/index.ts") }).strict(),
  files: z.array(z.string()).min(1),
  homepage: z.literal("https://hra.sh"),
  name: z.literal("hra"),
  repository: z.object({
    type: z.literal("git"),
    url: z.literal("git+https://github.com/hraness/hra.git"),
  }).strict(),
  version: z.literal("0.1.0"),
}).passthrough();

type ProcessResult = Readonly<{
  exitCode: number;
  stderr: string;
  stdout: string;
}>;

type OwnedDaemonExit = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}>;

type OwnedInstalledDaemon = Readonly<{
  child: ChildProcess;
  exited: Promise<OwnedDaemonExit>;
  exitObservation: () => OwnedDaemonExit | null;
  pid: number;
}>;

class InstalledDaemonOwnershipError extends Error {
  constructor() {
    super("The installed daemon process spawned without an exact PID, so cleanup cannot be proved.");
    this.name = "InstalledDaemonOwnershipError";
  }
}

const daemonRunningSchema = z.object({
  data: z.object({
    daemon: daemonIdentitySchema,
    running: z.literal(true),
  }).passthrough(),
  ok: z.literal(true),
  version: z.literal(1),
}).passthrough();

const run = async (
  executable: string,
  arguments_: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<ProcessResult> =>
  await new Promise<ProcessResult>((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let settlementTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          forceTimer = setTimeout(() => {
            child.kill("SIGKILL");
            settlementTimer = setTimeout(() => {
              reject(new Error(
                `${executable} ${arguments_.join(" ")} did not settle after bounded forced termination.`,
              ));
            }, 1_000);
          }, 1_000);
        }, options.timeoutMs);
    const clearTimers = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      if (settlementTimer !== undefined) clearTimeout(settlementTimer);
    };
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimers();
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimers();
      if (timedOut) {
        reject(new Error(
          `${executable} ${arguments_.join(" ")} exceeded ${String(options.timeoutMs)}ms:\n${Buffer.concat(stderr).toString("utf8")}${Buffer.concat(stdout).toString("utf8")}`,
        ));
        return;
      }
      resolvePromise({
        exitCode: exitCode ?? 1,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    });
  });

const requireSuccess = (label: string, result: ProcessResult): ProcessResult => {
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed with exit ${String(result.exitCode)}:\n${result.stderr}${result.stdout}`);
  }
  return result;
};

const assertExactlyOneJsonValue = (value: string): unknown => {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error("Expected one JSON value on stdout.");
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (error: unknown) {
    throw new Error("CLI stdout was not exactly one JSON value.", { cause: error });
  }
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const launchOwnedInstalledDaemon = async (input: Readonly<{
  cwd: string;
  env: NodeJS.ProcessEnv;
  executable: string;
}>): Promise<OwnedInstalledDaemon> => {
  const child = spawn(input.executable, ["daemon", "run"], {
    cwd: input.cwd,
    env: input.env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  // Keep every post-construction child error observed. The spawn-specific
  // listener below still turns a failed launch into the lifecycle error.
  child.on("error", () => undefined);
  let exitObservation: OwnedDaemonExit | null = null;
  const exited = new Promise<OwnedDaemonExit>((resolveExit) => {
    child.once("close", (exitCode, signal) => {
      exitObservation = { exitCode, signal };
      resolveExit(exitObservation);
    });
  });
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      rejectSpawn(error);
    };
    const onSpawn = () => {
      child.off("error", onError);
      resolveSpawn();
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });
  const pid = child.pid;
  if (pid === undefined) {
    child.kill("SIGKILL");
    throw new InstalledDaemonOwnershipError();
  }
  return {
    child,
    exited,
    exitObservation: () => exitObservation,
    pid,
  };
};

export const waitForOwnedInstalledDaemonReady = async (input: Readonly<{
  daemon: Pick<OwnedInstalledDaemon, "exitObservation" | "pid">;
  queryStatus: () => Promise<DaemonIdentity | null>;
  readReceipt: () => Promise<DaemonAuthorityReceipt | null>;
  deadlineMs?: number;
  now?: () => number;
  pollMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}>): Promise<DaemonIdentity> => {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? (async (milliseconds: number) => { await Bun.sleep(milliseconds); });
  const deadline = now() + (input.deadlineMs ?? 30_000);
  let lastReceipt: DaemonAuthorityReceipt | null = null;
  let lastStatusError: Error | undefined;
  while (now() <= deadline) {
    const exited = input.daemon.exitObservation();
    if (exited !== null) {
      throw new Error(
        `The owned installed daemon pid ${String(input.daemon.pid)} exited before readiness with ${
          exited.exitCode === null ? exited.signal ?? "an unknown signal" : `status ${String(exited.exitCode)}`
        }.`,
      );
    }
    lastReceipt = await input.readReceipt();
    if (
      lastReceipt !== null
      && lastReceipt.pid !== input.daemon.pid
      && (lastReceipt.state === "booting" || lastReceipt.state === "ready" || lastReceipt.state === "maintenance")
    ) {
      throw new Error(
        `The installed daemon authority belongs to unexpected pid ${String(lastReceipt.pid)} instead of owned pid ${String(input.daemon.pid)}.`,
      );
    }
    if (lastReceipt?.pid === input.daemon.pid && lastReceipt.state === "failed") {
      throw new Error(`The owned installed daemon failed before readiness: ${lastReceipt.failure ?? "unknown failure"}`);
    }
    if (lastReceipt?.pid === input.daemon.pid && lastReceipt.state === "ready") {
      const receiptIdentity = identityFromReceipt(lastReceipt);
      if (receiptIdentity === null) {
        throw new Error("The owned installed daemon published a ready receipt without a complete identity.");
      }
      try {
        const statusIdentity = await input.queryStatus();
        if (statusIdentity !== null && sameDaemonIdentity(receiptIdentity, statusIdentity)) {
          return statusIdentity;
        }
        lastStatusError = new Error("The installed daemon status did not match its owned ready receipt.");
      } catch (error: unknown) {
        lastStatusError = error instanceof Error
          ? error
          : new Error("The installed daemon status query threw a non-Error value.");
      }
    }
    await sleep(input.pollMs ?? 25);
  }
  const receiptState = lastReceipt === null
    ? "no receipt"
    : `${lastReceipt.state} receipt for pid ${String(lastReceipt.pid)}`;
  const statusState = lastStatusError === undefined ? "" : ` Last status: ${lastStatusError.message}`;
  throw new Error(
    `Owned installed daemon pid ${String(input.daemon.pid)} did not become ready before the deadline (${receiptState}).${statusState}`,
  );
};

const socketExists = async (paths: StatePaths): Promise<boolean> => {
  try {
    await lstat(paths.socket);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const waitForOwnedInstalledDaemonRelease = async (input: Readonly<{
  daemon: OwnedInstalledDaemon;
  paths: StatePaths;
  deadlineMs?: number;
  now?: () => number;
  pollMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}>): Promise<void> => {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? (async (milliseconds: number) => { await Bun.sleep(milliseconds); });
  const deadline = now() + (input.deadlineMs ?? 10_000);
  let stableReleasedObservations = 0;
  while (now() <= deadline) {
    const exited = input.daemon.exitObservation() !== null;
    const processAlive = processIsAlive(input.daemon.pid);
    const authorityHeld = await DaemonLock.isAuthorityHeld(input.paths);
    const socketPresent = await socketExists(input.paths);
    if (exited && !processAlive && !authorityHeld && !socketPresent) {
      stableReleasedObservations += 1;
      if (stableReleasedObservations >= 2) return;
    } else {
      stableReleasedObservations = 0;
    }
    await sleep(input.pollMs ?? 25);
  }
  throw new Error(
    `Owned installed daemon pid ${String(input.daemon.pid)} did not prove process exit, authority release, and socket removal before the cleanup deadline.`,
  );
};

const terminateOwnedInstalledDaemon = async (daemon: OwnedInstalledDaemon): Promise<void> => {
  if (daemon.exitObservation() !== null) return;
  await terminateDaemonStartupChild({
    exited: daemon.exited.then((exit) => exit.exitCode ?? 1),
    kill: (signal) => { daemon.child.kill(signal); },
  });
};

export async function checkPackage(): Promise<void> {
const repositoryRoot = resolve(import.meta.dir, "..");
const packageJson = packageSchema.parse(
  JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as unknown,
);
if (!packageJson.files.includes("src")) throw new Error("The package must include src.");
if (!packageJson.files.includes("!src/cloud/inviteAuthority.ts")) {
  throw new Error("The package must exclude operator-only invite authority.");
}
if (!packageJson.files.includes("!src/storage/legacy-secret-migration.ts")) {
  throw new Error("The package must exclude the checkout-only legacy secret migration implementation.");
}
await access(join(repositoryRoot, "src", "storage", "legacy-secret-migration.ts"), constants.R_OK);

await assertPublicTree(repositoryRoot);
const completeHistory = requireSuccess(
  "Git history sensitive-text check",
  await run("git", ["log", "--all", "--format=", "--patch", "--no-ext-diff", "--no-textconv"], { cwd: repositoryRoot }),
);
assertPublicSensitiveText(completeHistory.stdout, "Git history");
const authoredHistory = requireSuccess(
  "Git history public-text check",
  await run(
    "git",
    [
      "log",
      "--all",
      "--format=",
      "--patch",
      "--no-ext-diff",
      "--no-textconv",
      "--",
      ".",
      ":(exclude)bun.lock",
    ],
    { cwd: repositoryRoot },
  ),
);
assertPublicText(authoredHistory.stdout, "Git history");

const generated = requireSuccess(
  "generated public tree check",
  await run(process.execPath, ["run", "build:site", "--", "--check"], { cwd: repositoryRoot }),
);
if (generated.stdout.trim().length > 0) process.stdout.write(generated.stdout);

const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "hra-package-")));
let removeTemporaryRoot = true;
try {
  const packageDirectory = join(temporaryRoot, "package");
  const consumerDirectory = join(temporaryRoot, "consumer");
  const consumerHome = join(temporaryRoot, "home");
  const consumerTemporaryDirectory = join(temporaryRoot, "tmp");
  const globalInstallRoot = join(temporaryRoot, "bun-global");
  await mkdir(packageDirectory, { recursive: true, mode: 0o700 });
  await mkdir(consumerDirectory, { recursive: true, mode: 0o700 });
  await mkdir(consumerHome, { recursive: true, mode: 0o700 });
  await mkdir(join(consumerHome, "Documents"), { recursive: true, mode: 0o700 });
  await mkdir(consumerTemporaryDirectory, { recursive: true, mode: 0o700 });
  await mkdir(globalInstallRoot, { recursive: true, mode: 0o700 });

  requireSuccess(
    "package archive creation",
    await run(process.execPath, ["pm", "pack", "--destination", packageDirectory], { cwd: repositoryRoot }),
  );
  const archive = join(packageDirectory, `${packageJson.name}-${packageJson.version}.tgz`);
  const inspectionDirectory = join(temporaryRoot, "inspection");
  await mkdir(inspectionDirectory, { recursive: true, mode: 0o700 });
  requireSuccess(
    "package archive extraction",
    await run("tar", ["-xzf", archive, "-C", inspectionDirectory], { cwd: repositoryRoot }),
  );
  await assertPublicTree(inspectionDirectory);
  await assertProductionPackageOnly(inspectionDirectory);
  try {
    await access(
      join(inspectionDirectory, "package", "src", "storage", "legacy-secret-migration.ts"),
      constants.F_OK,
    );
    throw new Error("The package archive contains the checkout-only legacy secret migration implementation.");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify({ name: "hra-package-smoke", private: true, type: "module" }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  const isolatedEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    BUN_INSTALL: globalInstallRoot,
    HOME: consumerHome,
    TMPDIR: consumerTemporaryDirectory,
  };
  requireSuccess(
    "clean consumer install",
    await run(process.execPath, ["add", "--ignore-scripts", archive], {
      cwd: consumerDirectory,
      env: isolatedEnvironment,
    }),
  );
  requireSuccess(
    "side-effect-free package import",
    await run(process.execPath, ["-e", "await import('hra')"], {
      cwd: consumerDirectory,
      env: isolatedEnvironment,
    }),
  );

  const executable = join(consumerDirectory, "node_modules", ".bin", "hra");
  const help = requireSuccess(
    "installed CLI help",
    await run(executable, ["--help"], { cwd: consumerDirectory, env: isolatedEnvironment }),
  );
  if (!help.stdout.startsWith("HRA\n")) throw new Error("Installed CLI help has an unexpected header.");
  if (help.stderr !== "") throw new Error("Installed CLI help wrote diagnostics.");

  const version = requireSuccess(
    "installed CLI version",
    await run(executable, ["--version"], { cwd: consumerDirectory, env: isolatedEnvironment }),
  );
  if (version.stdout !== `hra ${packageJson.version}\n` || version.stderr !== "") {
    throw new Error("Installed CLI version does not match package.json.");
  }

  const doctor = await run(executable, ["doctor", "--offline", "--json"], {
    cwd: consumerDirectory,
    env: isolatedEnvironment,
  });
  const doctorValue = assertExactlyOneJsonValue(doctor.stdout);
  const doctorSchema = z.object({
    data: z.object({ offline: z.literal(true) }).passthrough(),
    ok: z.literal(true),
    version: z.literal(1),
  }).passthrough();
  doctorSchema.parse(doctorValue);
  if (doctor.stderr !== "") throw new Error("JSON doctor wrote diagnostics to stderr.");
  if (doctor.exitCode !== 0) throw new Error("Offline doctor failed in the clean consumer.");

  requireSuccess(
    "clean global consumer install",
    await run(process.execPath, ["add", "--global", "--ignore-scripts", archive], {
      cwd: consumerDirectory,
      env: isolatedEnvironment,
    }),
  );
  const globalExecutable = join(globalInstallRoot, "bin", "hra");
  const globalHelp = requireSuccess(
    "global CLI help",
    await run(globalExecutable, ["--help"], { cwd: consumerDirectory, env: isolatedEnvironment }),
  );
  if (!globalHelp.stdout.startsWith("HRA\n") || globalHelp.stderr !== "") {
    throw new Error("Globally installed CLI help is invalid.");
  }
  const globalDoctor = await run(globalExecutable, ["doctor", "--offline", "--json"], {
    cwd: consumerDirectory,
    env: isolatedEnvironment,
  });
  doctorSchema.parse(assertExactlyOneJsonValue(globalDoctor.stdout));
  if (globalDoctor.stderr !== "" || globalDoctor.exitCode !== 0) {
    throw new Error("Globally installed CLI offline doctor failed.");
  }

  const daemonEnvironment: NodeJS.ProcessEnv = {
    ...isolatedEnvironment,
    HRA_CONVEX_URL: "",
  };
  const daemonPaths = resolveStatePaths({
    homeDirectory: consumerHome,
    platform: process.platform,
  });
  const lifecycleTimeoutMs = 45_000;
  let lifecycleComplete = false;
  let ownedDaemon: OwnedInstalledDaemon | undefined;
  let lifecycleError: Error | undefined;
  try {
    const initialized = requireSuccess(
      "globally installed CLI initialization",
      await run(globalExecutable, ["init", "--yes", "--json"], {
        cwd: consumerDirectory,
        env: daemonEnvironment,
        timeoutMs: lifecycleTimeoutMs,
      }),
    );
    z.object({
      data: z.object({ initialized: z.literal(true) }).passthrough(),
      ok: z.literal(true),
      version: z.literal(1),
    }).passthrough().parse(assertExactlyOneJsonValue(initialized.stdout));
    if (initialized.stderr !== "") {
      throw new Error("Globally installed CLI initialization wrote diagnostics.");
    }

    ownedDaemon = await launchOwnedInstalledDaemon({
      cwd: consumerDirectory,
      env: daemonEnvironment,
      executable: globalExecutable,
    });
    const queryInstalledDaemonStatus = async (): Promise<DaemonIdentity | null> => {
      const status = await run(globalExecutable, ["daemon", "status", "--json"], {
        cwd: consumerDirectory,
        env: daemonEnvironment,
        timeoutMs: 2_000,
      });
      if (status.exitCode !== 0) return null;
      if (status.stderr !== "") {
        throw new Error("Globally installed daemon status wrote diagnostics.");
      }
      return daemonRunningSchema.parse(assertExactlyOneJsonValue(status.stdout)).data.daemon;
    };
    const readyIdentity = await waitForOwnedInstalledDaemonReady({
      daemon: ownedDaemon,
      queryStatus: queryInstalledDaemonStatus,
      readReceipt: async () => await readDaemonAuthorityReceipt(daemonPaths),
    });
    if (readyIdentity.pid !== ownedDaemon.pid) {
      throw new Error("The installed daemon ready identity does not belong to the directly owned process.");
    }

    const status = requireSuccess(
      "globally installed daemon status",
      await run(globalExecutable, ["daemon", "status", "--json"], {
        cwd: consumerDirectory,
        env: daemonEnvironment,
        timeoutMs: lifecycleTimeoutMs,
      }),
    );
    const statusIdentity = daemonRunningSchema.parse(assertExactlyOneJsonValue(status.stdout)).data.daemon;
    if (!sameDaemonIdentity(readyIdentity, statusIdentity)) {
      throw new Error("The installed daemon status changed after owned readiness.");
    }
    if (status.stderr !== "") {
      throw new Error("Globally installed daemon status wrote diagnostics.");
    }

    const accountSchema = z.object({
      id: z.string().min(1),
      label: z.literal("Package Audit"),
      processGeneration: z.literal(0),
      state: z.literal("signed_out"),
    }).passthrough();
    const addedAccount = requireSuccess(
      "globally installed pristine account creation",
      await run(globalExecutable, ["account", "add", "Package Audit", "--json"], {
        cwd: consumerDirectory,
        env: daemonEnvironment,
        timeoutMs: lifecycleTimeoutMs,
      }),
    );
    const addedAccountValue = z.object({
      data: z.object({ account: accountSchema }).passthrough(),
      ok: z.literal(true),
      version: z.literal(1),
    }).passthrough().parse(assertExactlyOneJsonValue(addedAccount.stdout));
    if (addedAccount.stderr !== "") {
      throw new Error("Globally installed pristine account creation wrote diagnostics.");
    }

    const shownAccount = requireSuccess(
      "globally installed pristine account read",
      await run(globalExecutable, ["account", "show", addedAccountValue.data.account.id, "--json"], {
        cwd: consumerDirectory,
        env: daemonEnvironment,
        timeoutMs: lifecycleTimeoutMs,
      }),
    );
    z.object({
      data: z.object({ account: accountSchema }).passthrough(),
      ok: z.literal(true),
      version: z.literal(1),
    }).passthrough().parse(assertExactlyOneJsonValue(shownAccount.stdout));
    if (shownAccount.stderr !== "") {
      throw new Error("Globally installed pristine account read wrote diagnostics.");
    }

    const duplicateAccount = await run(
      globalExecutable,
      ["account", "add", "PACKAGE AUDIT", "--json"],
      {
        cwd: consumerDirectory,
        env: daemonEnvironment,
        timeoutMs: lifecycleTimeoutMs,
      },
    );
    z.object({
      error: z.object({ code: z.literal("CONFLICT") }).passthrough(),
      ok: z.literal(false),
      version: z.literal(1),
    }).passthrough().parse(assertExactlyOneJsonValue(duplicateAccount.stdout));
    if (duplicateAccount.exitCode !== 1 || duplicateAccount.stderr !== "") {
      throw new Error("Globally installed duplicate account did not return one quiet conflict.");
    }

    for (const [label, arguments_, field, length] of [
      ["globally installed account list", ["account", "list", "--json"], "accounts", 1],
      ["globally installed project list", ["project", "list", "--json"], "projects", 1],
    ] as const) {
      const listing = requireSuccess(
        label,
        await run(globalExecutable, arguments_, {
          cwd: consumerDirectory,
          env: daemonEnvironment,
          timeoutMs: lifecycleTimeoutMs,
        }),
      );
      z.object({
        data: z.record(z.string(), z.unknown()).refine(
          (data) => Array.isArray(data[field]) && data[field].length === length,
          `${field} did not have the expected installed-state cardinality`,
        ),
        ok: z.literal(true),
        version: z.literal(1),
      }).passthrough().parse(assertExactlyOneJsonValue(listing.stdout));
      if (listing.stderr !== "") throw new Error(`${label} wrote diagnostics.`);
    }

    const stopped = requireSuccess(
      "globally installed daemon stop",
      await run(globalExecutable, ["daemon", "stop", "--json"], {
        cwd: consumerDirectory,
        env: daemonEnvironment,
        timeoutMs: lifecycleTimeoutMs,
      }),
    );
    z.object({
      data: z.object({ released: z.literal(true) }).passthrough(),
      ok: z.literal(true),
      version: z.literal(1),
    }).passthrough().parse(assertExactlyOneJsonValue(stopped.stdout));
    if (stopped.stderr !== "") {
      throw new Error("Globally installed daemon stop wrote diagnostics.");
    }

    const stoppedStatus = requireSuccess(
      "globally installed stopped-daemon status",
      await run(globalExecutable, ["daemon", "status", "--json"], {
        cwd: consumerDirectory,
        env: daemonEnvironment,
        timeoutMs: lifecycleTimeoutMs,
      }),
    );
    z.object({
      data: z.object({ running: z.literal(false) }).passthrough(),
      ok: z.literal(true),
      version: z.literal(1),
    }).passthrough().parse(assertExactlyOneJsonValue(stoppedStatus.stdout));
    if (stoppedStatus.stderr !== "") {
      throw new Error("Stopped-daemon status wrote diagnostics.");
    }
    await waitForOwnedInstalledDaemonRelease({ daemon: ownedDaemon, paths: daemonPaths });
    lifecycleComplete = true;
  } catch (error: unknown) {
    lifecycleError = error instanceof Error
      ? error
      : new Error("Installed package acceptance threw a non-Error value.");
    if (error instanceof InstalledDaemonOwnershipError) removeTemporaryRoot = false;
  }
  if (!lifecycleComplete) {
    let terminateError: Error | undefined;
    let releaseError: Error | undefined;
    if (ownedDaemon !== undefined) {
      // A socket-addressed stop could target a replacement authority after the
      // readiness failure. Cleanup therefore signals only the retained child.
      try {
        await terminateOwnedInstalledDaemon(ownedDaemon);
      } catch (error: unknown) {
        terminateError = error instanceof Error
          ? error
          : new Error("Installed daemon exact termination threw a non-Error value.");
      }
      try {
        await waitForOwnedInstalledDaemonRelease({ daemon: ownedDaemon, paths: daemonPaths });
      } catch (error: unknown) {
        releaseError = error instanceof Error
          ? error
          : new Error("Installed daemon release proof threw a non-Error value.");
        removeTemporaryRoot = false;
      }
    }
    const errors = [lifecycleError, terminateError, releaseError]
      .filter((error): error is Error => error !== undefined);
    if (errors.length > 1 || (!removeTemporaryRoot && errors.length > 0)) {
      throw new AggregateError(
        errors,
        removeTemporaryRoot
          ? "Installed package acceptance failed, but exact daemon cleanup was proved."
          : `Installed package acceptance failed and daemon cleanup was not proved; evidence remains at ${temporaryRoot}.`,
      );
    }
    const onlyError = errors[0];
    if (onlyError !== undefined) throw onlyError;
  }
  if (lifecycleError !== undefined) throw lifecycleError;

  process.stdout.write(`Verified ${basename(archive)} in isolated local and global consumers, including the global daemon lifecycle.\n`);
} finally {
  if (removeTemporaryRoot) {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}
}

if (import.meta.main) await checkPackage();
