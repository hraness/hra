import { accessSync, constants, realpathSync } from "node:fs";
import { resolve } from "node:path";

import {
  advanceDevLaunch,
  devCleanupOrder,
  gatewayExecutableNameForNativeMode,
  maySpawnDevApp,
  nativeDevFrontendEnvironment,
  HRA_DEV_SESSION_ENV,
  scrubRetiredSelfEditEnvironment,
  type DevLaunchPhase,
  type DevProcessName,
} from "./dev-protocol";
import {
  attemptDevAppSpawn,
  assertFixedDevPortAvailable,
  createDevSessionId,
  probeDevReadinessHttp,
  type DevShutdownSignal,
  waitForDevReadiness,
} from "./dev-supervisor";
import { zigArgumentsWithWorkerBudget } from "./run-zig";
import { resolvePortableRuntimeAssets } from "./src/runtime-paths";
import { resolveZigExecutable } from "./zig-toolchain";

const TERMINATION_GRACE_MS = 2_000;
const KILL_GRACE_MS = 1_000;
const GROUP_POLL_MS = 25;
// The bridge retains the exact signed predecessor executable filename.
const legacyOprteNativeExecutableName = "oprte";

type OwnedProcess = Readonly<{
  name: DevProcessName;
  pid: number;
  exited: Promise<number>;
  kill: (signal: NodeJS.Signals) => void;
}>;

type OwnedProcessRegistry = Partial<Record<DevProcessName, OwnedProcess>>;

type ShutdownSignal = DevShutdownSignal;

interface SignalLatch {
  readonly promise: Promise<ShutdownSignal>;
  readonly requested: () => ShutdownSignal | undefined;
  readonly dispose: () => void;
}

function spawnOwnedProcess(
  name: DevProcessName,
  argv: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  },
): OwnedProcess {
  const child = Bun.spawn([...argv], {
    cwd: options.cwd,
    env: { ...options.env },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    detached: true,
  });
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1) {
    child.kill("SIGKILL");
    throw new Error(`Could not establish an owned process group for ${name}.`);
  }
  return {
    name,
    pid: child.pid,
    exited: child.exited,
    kill: (signal) => {
      child.kill(signal);
    },
  };
}

function processErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (processErrorCode(error) === "ESRCH") return false;
    if (processErrorCode(error) === "EPERM") return true;
    throw error;
  }
}

function signalOwnedProcessGroup(
  child: OwnedProcess,
  signal: "SIGKILL" | "SIGTERM",
): void {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (processErrorCode(error) !== "ESRCH") throw error;
    // If the group disappeared between the existence check and signal, Bun's
    // direct handle is a safe final fallback for an unreaped leader.
    try {
      child.kill(signal);
    } catch (fallbackError) {
      if (processErrorCode(fallbackError) !== "ESRCH") throw fallbackError;
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function nextEventLoopTurn(): Promise<void> {
  return new Promise((resolveTurn) => setImmediate(resolveTurn));
}

async function processGroupExitsWithin(
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(processGroupId)) {
    if (Date.now() >= deadline) return false;
    await delay(Math.min(GROUP_POLL_MS, deadline - Date.now()));
  }
  return true;
}

async function promiseSettlesWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function terminateOwnedProcessGroup(child: OwnedProcess): Promise<void> {
  if (processGroupExists(child.pid)) {
    signalOwnedProcessGroup(child, "SIGTERM");
    if (!await processGroupExitsWithin(child.pid, TERMINATION_GRACE_MS)) {
      signalOwnedProcessGroup(child, "SIGKILL");
      if (!await processGroupExitsWithin(child.pid, KILL_GRACE_MS)) {
        throw new Error(`${child.name} process group ${child.pid} survived SIGKILL.`);
      }
    }
  }
  if (!await promiseSettlesWithin(child.exited, KILL_GRACE_MS)) {
    try {
      child.kill("SIGKILL");
    } catch (error) {
      if (processErrorCode(error) !== "ESRCH") throw error;
    }
    if (!await promiseSettlesWithin(child.exited, KILL_GRACE_MS)) {
      throw new Error(`${child.name} process ${child.pid} was not reaped.`);
    }
  }
}

function forceKillOwnedProcesses(processes: OwnedProcessRegistry): void {
  const owned = {
    app: processes.app !== undefined,
    build: processes.build !== undefined,
    vite: processes.vite !== undefined,
  };
  for (const name of devCleanupOrder(owned)) {
    const child = processes[name];
    if (child === undefined) continue;
    try {
      signalOwnedProcessGroup(child, "SIGKILL");
    } catch {
      // The first signal's bounded cleanup retains responsibility for errors.
    }
  }
}

async function cleanupOwnedProcesses(processes: OwnedProcessRegistry): Promise<void> {
  const owned = {
    app: processes.app !== undefined,
    build: processes.build !== undefined,
    vite: processes.vite !== undefined,
  };
  const failures: unknown[] = [];
  for (const name of devCleanupOrder(owned)) {
    const child = processes[name];
    if (child === undefined) continue;
    try {
      await terminateOwnedProcessGroup(child);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "HRA development process cleanup failed.");
  }
}

function installSignalLatch(processes: OwnedProcessRegistry): SignalLatch {
  let current: ShutdownSignal | undefined;
  let resolveSignal: ((signal: ShutdownSignal) => void) | undefined;
  const promise = new Promise<ShutdownSignal>((resolveShutdown) => {
    resolveSignal = resolveShutdown;
  });
  const handlers = new Map<ShutdownSignal, () => void>();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = (): void => {
      if (current === undefined) {
        current = signal;
        resolveSignal?.(signal);
        return;
      }
      forceKillOwnedProcesses(processes);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return {
    promise,
    requested: () => current,
    dispose: () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    },
  };
}

function signalExitCode(signal: ShutdownSignal): number {
  switch (signal) {
    case "SIGHUP":
      return 129;
    case "SIGINT":
      return 130;
    case "SIGTERM":
      return 143;
  }
}

function runtimeEnvironment(
  gatewayPath: string,
  runtimePaths: ReturnType<typeof resolvePortableRuntimeAssets>,
): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {
    ...scrubRetiredSelfEditEnvironment(process.env),
    HRA_CODEX_BIN: runtimePaths.codexBinary,
    HRA_GATEWAY_PATH: gatewayPath,
    HRA_GIT_BIN: runtimePaths.gitBinary,
    HRA_GIT_ROOT: runtimePaths.gitRoot,
  };
  // The bundled run path must not inherit a stale dev envelope. Development
  // adds all four exact values together only after this sanitization.
  delete environment.NATIVE_SDK_FRONTEND_URL;
  delete environment.NATIVE_SDK_HMR;
  delete environment.NATIVE_SDK_MODE;
  delete environment[HRA_DEV_SESSION_ENV];
  return environment;
}

async function runDevelopment(
  desktopRoot: string,
  gatewayPath: string,
  runtimePaths: ReturnType<typeof resolvePortableRuntimeAssets>,
  zigExecutable: string,
): Promise<number> {
  const sessionId = createDevSessionId();
  const launcherEnvironment = scrubRetiredSelfEditEnvironment(process.env);
  const processes: OwnedProcessRegistry = {};
  const shutdown = installSignalLatch(processes);
  let phase: DevLaunchPhase = "checking-listener";

  try {
    await assertFixedDevPortAvailable();
    phase = advanceDevLaunch(phase, "listener-clear");
    if (shutdown.requested() !== undefined) return signalExitCode(shutdown.requested()!);

    console.log("[hra dev] starting the owned Vite HMR server on 127.0.0.1:5173");
    const vite = spawnOwnedProcess(
      "vite",
      [process.execPath, "run", "dev:frontend"],
      {
        cwd: desktopRoot,
        env: {
          ...launcherEnvironment,
          [HRA_DEV_SESSION_ENV]: sessionId,
        },
      },
    );
    processes.vite = vite;
    phase = advanceDevLaunch(phase, "vite-started");

    console.log("[hra dev] compiling the Debug Zig host");
    const build = spawnOwnedProcess(
      "build",
      [
        zigExecutable,
        ...zigArgumentsWithWorkerBudget(
          ["build", "-Dplatform=macos"],
          launcherEnvironment,
        ),
      ],
      { cwd: desktopRoot, env: launcherEnvironment },
    );
    processes.build = build;
    let viteExitCode: number | undefined;
    const viteExited = vite.exited.then((code) => {
      viteExitCode = code;
      return { code, kind: "vite-exit" } as const;
    });
    const buildOutcome = await Promise.race([
      build.exited.then((code) => ({ code, kind: "build-exit" } as const)),
      viteExited,
      shutdown.promise.then((signal) => ({ kind: "signal", signal } as const)),
    ]);
    if (buildOutcome.kind === "signal") return signalExitCode(buildOutcome.signal);
    if (buildOutcome.kind === "vite-exit") {
      throw new Error(`Vite exited with status ${buildOutcome.code} before the native build completed.`);
    }
    if (buildOutcome.code !== 0) {
      throw new Error(`The Zig Debug build exited with status ${buildOutcome.code}; the app was not started.`);
    }
    // Retire the completed build group immediately. Keeping its dead PGID in
    // the registry for the lifetime of the app could target an unrelated group
    // after operating-system PID reuse during a long development session.
    await terminateOwnedProcessGroup(build);
    delete processes.build;
    phase = advanceDevLaunch(phase, "build-succeeded");
    if (shutdown.requested() !== undefined) return signalExitCode(shutdown.requested()!);

    const readinessAbort = new AbortController();
    const readiness = waitForDevReadiness({
      expectedSessionId: sessionId,
      probe: probeDevReadinessHttp,
      signal: readinessAbort.signal,
    }).then(() => ({ kind: "ready" } as const));
    const readinessOutcome = await Promise.race([
      readiness,
      viteExited,
      shutdown.promise.then((signal) => ({ kind: "signal", signal } as const)),
    ]);
    if (readinessOutcome.kind !== "ready") readinessAbort.abort();
    if (readinessOutcome.kind === "signal") return signalExitCode(readinessOutcome.signal);
    if (readinessOutcome.kind === "vite-exit") {
      throw new Error(`Vite exited with status ${readinessOutcome.code} before proving readiness.`);
    }
    phase = advanceDevLaunch(phase, "readiness-matched");
    const appPath = realpathSync(resolve(
      desktopRoot,
      "zig-out",
      "bin",
      legacyOprteNativeExecutableName,
    ));
    accessSync(appPath, constants.X_OK);

    // Yield once so process and signal callbacks already queued by the host
    // can update their latches before the final synchronous spawn gate.
    await nextEventLoopTurn();
    const lateShutdown = shutdown.requested();
    const appSpawn = attemptDevAppSpawn(
      {
        authorized: maySpawnDevApp(phase),
        ...(lateShutdown === undefined ? {} : { shutdownSignal: lateShutdown }),
        ...(viteExitCode === undefined ? {} : { viteExitCode }),
      },
      () => {
        console.log("[hra dev] launching HRA; frontend edits now hot reload");
        console.log("[hra dev] restart this command after Zig or gateway changes");
        return spawnOwnedProcess("app", [appPath], {
          cwd: desktopRoot,
          env: {
            ...runtimeEnvironment(gatewayPath, runtimePaths),
            ...nativeDevFrontendEnvironment(sessionId),
          },
        });
      },
    );
    if (appSpawn.kind === "shutdown") return signalExitCode(appSpawn.signal);
    if (appSpawn.kind === "vite-exit") {
      throw new Error(`Vite exited with status ${appSpawn.code} before the native app started.`);
    }
    if (appSpawn.kind === "not-authorized") {
      throw new Error("The HRA development launch gate did not authorize app startup.");
    }
    const app = appSpawn.value;
    processes.app = app;
    phase = advanceDevLaunch(phase, "app-started");

    const appOutcome = await Promise.race([
      app.exited.then((code) => ({ code, kind: "app-exit" } as const)),
      viteExited,
      shutdown.promise.then((signal) => ({ kind: "signal", signal } as const)),
    ]);
    if (appOutcome.kind === "signal") return signalExitCode(appOutcome.signal);
    if (appOutcome.kind === "vite-exit") {
      throw new Error(`Vite exited with status ${appOutcome.code}; the native app was terminated.`);
    }
    return appOutcome.code;
  } finally {
    try {
      if (phase !== "stopping" && phase !== "stopped") {
        phase = advanceDevLaunch(phase, "stop-requested");
      }
      await cleanupOwnedProcesses(processes);
      if (phase === "stopping") phase = advanceDevLaunch(phase, "cleanup-complete");
    } finally {
      shutdown.dispose();
    }
  }
}

async function runBundled(
  desktopRoot: string,
  gatewayPath: string,
  runtimePaths: ReturnType<typeof resolvePortableRuntimeAssets>,
  zigExecutable: string,
): Promise<number> {
  const child = Bun.spawn(
    [
      zigExecutable,
      ...zigArgumentsWithWorkerBudget(
        ["build", "run", "-Dplatform=macos"],
        process.env,
      ),
    ],
    {
      cwd: desktopRoot,
      env: runtimeEnvironment(gatewayPath, runtimePaths),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  return await child.exited;
}

export async function main(arguments_: readonly string[] = process.argv.slice(2)): Promise<number> {
  const mode = arguments_[0];
  if (mode !== "dev" && mode !== "run") {
    throw new Error("Expected `dev` or `run`");
  }

  const desktopRoot = realpathSync(resolve(import.meta.dir, ".."));
  const gatewayPath = realpathSync(resolve(
    desktopRoot,
    "runtime",
    "dist",
    gatewayExecutableNameForNativeMode(mode),
  ));
  accessSync(gatewayPath, constants.X_OK);
  const runtimePaths = resolvePortableRuntimeAssets();
  const zigExecutable = resolveZigExecutable();

  return mode === "dev"
    ? await runDevelopment(
        desktopRoot,
        gatewayPath,
        runtimePaths,
        zigExecutable,
      )
    : await runBundled(desktopRoot, gatewayPath, runtimePaths, zigExecutable);
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
