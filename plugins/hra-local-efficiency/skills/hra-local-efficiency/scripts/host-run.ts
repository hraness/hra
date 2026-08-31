#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { commandProgramLabel, containsControlCharacters, requireOperationLabel } from "./shared";

export type ResourceMode = "shared" | "heavy" | "exclusive";

export const hostAccessRequiredCode = "HRA_HOST_ACCESS_REQUIRED";
export const hostAccessRequiredExitCode = 77;

export class HostAccessRequiredError extends Error {
  readonly code = hostAccessRequiredCode;

  constructor() {
    super(
      "the machine-wide scheduler state is outside the active permission boundary; "
      + "retry this identical hra-host-run invocation through reviewed host access, "
      + "without running the child directly or removing scheduler state",
    );
    this.name = "HostAccessRequiredError";
  }
}

type HostResourceLease = {
  readonly inheritedFileDescriptor: number;
};

type HostResourceCoordinator = {
  withLease<T>(
    claims: readonly { readonly resource: string; readonly amount: number }[],
    callback: (lease: HostResourceLease) => T | Promise<T>,
    options?: { readonly waitTimeoutMilliseconds?: number },
  ): Promise<T>;
};

type HostResourceModule = {
  createHostResourceCoordinator(options: {
    readonly profile: {
      readonly id: string;
      readonly capacities: readonly { readonly resource: string; readonly limit: number }[];
    };
    readonly stateRoot: string;
    readonly waitTimeoutMilliseconds: number;
  }): HostResourceCoordinator;
};

export type HostRunOptions = {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly label: string;
  readonly mode: ResourceMode;
  readonly stateRoot?: string;
};

export function permitCapacity(hostParallelism = availableParallelism()): number {
  if (hostParallelism >= 12) return 4;
  if (hostParallelism >= 6) return 3;
  if (hostParallelism >= 3) return 2;
  return 1;
}

export function permitsForMode(
  mode: ResourceMode,
  hostParallelism = availableParallelism(),
): number {
  const capacity = permitCapacity(hostParallelism);
  if (mode === "shared") return 1;
  if (mode === "heavy") return Math.min(2, capacity);
  return capacity;
}

export function parseHostRunArguments(arguments_: readonly string[]): {
  readonly command: readonly string[];
  readonly label: string;
  readonly mode: ResourceMode;
} {
  const delimiter = arguments_.indexOf("--");
  if (delimiter < 0) throw new Error("hra-host-run requires -- before its command");
  let label: string | undefined;
  let mode: ResourceMode | undefined;
  for (const argument of arguments_.slice(0, delimiter)) {
    if (argument.startsWith("--mode=")) {
      if (mode !== undefined) throw new Error("--mode may appear only once");
      const value = argument.slice("--mode=".length);
      if (value !== "shared" && value !== "heavy" && value !== "exclusive") {
        throw new Error(`invalid resource mode: ${value}`);
      }
      mode = value;
      continue;
    }
    if (argument.startsWith("--label=")) {
      if (label !== undefined) throw new Error("--label may appear only once");
      label = requireOperationLabel(argument.slice("--label=".length), "--label");
      continue;
    }
    throw new Error(`unknown hra-host-run argument: ${argument}`);
  }
  const command = arguments_.slice(delimiter + 1);
  if (command.length === 0 || command[0] === undefined || command[0] === "") {
    throw new Error("hra-host-run requires a command");
  }
  if (containsControlCharacters(command[0])) {
    throw new Error("command program must contain no control characters");
  }
  return { command, label: label ?? commandProgramLabel(command[0]), mode: mode ?? "shared" };
}

export function resolveHostResourceStateRoot(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  userHome = homedir(),
): string {
  const configured = environment.HRA_LOCAL_EFFICIENCY_STATE_ROOT;
  if (configured !== undefined && configured !== "") {
    if (!isAbsolute(configured)) {
      throw new Error("HRA_LOCAL_EFFICIENCY_STATE_ROOT must be absolute");
    }
    return resolve(configured);
  }
  const xdgState = environment.XDG_STATE_HOME;
  if (xdgState !== undefined && xdgState !== "") {
    if (!isAbsolute(xdgState)) throw new Error("XDG_STATE_HOME must be absolute");
    return join(resolve(xdgState), "hra-local-efficiency", "host-resources-v1");
  }
  return join(resolve(userHome), ".local", "state", "hra-local-efficiency", "host-resources-v1");
}

export function resolveAtetRuntimeRoot(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  userHome = homedir(),
): string {
  const configured = environment.HRA_LOCAL_EFFICIENCY_RUNTIME_ROOT;
  if (configured !== undefined && configured !== "") {
    if (!isAbsolute(configured)) throw new Error("HRA_LOCAL_EFFICIENCY_RUNTIME_ROOT must be absolute");
    return resolve(configured);
  }
  const xdgData = environment.XDG_DATA_HOME;
  if (xdgData !== undefined && xdgData !== "") {
    if (!isAbsolute(xdgData)) throw new Error("XDG_DATA_HOME must be absolute");
    return join(resolve(xdgData), "hra-local-efficiency", "runtime", "atet-v2.0.0");
  }
  return join(resolve(userHome), ".local", "share", "hra-local-efficiency", "runtime", "atet-v2.0.0");
}

function atetCandidates(
  environment: Readonly<NodeJS.ProcessEnv>,
  userHome = homedir(),
): string[] {
  const configured = environment.HRA_ATET_HOST_RESOURCES_MODULE;
  return [
    ...(configured === undefined || configured === "" ? [] : [configured]),
    join(resolveAtetRuntimeRoot(environment, userHome), "host-resources.js"),
  ].map((candidate) => resolve(candidate));
}

export function resolveAtetHostResourceModule(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  userHome = homedir(),
): string {
  const path = atetCandidates(environment, userHome)
    .find((candidate) => existsSync(candidate));
  if (path === undefined) {
    throw new Error(
      "the private Atet host-resource runtime is unavailable; run the hra-local-efficiency bootstrap",
    );
  }
  return path;
}

async function hostResourceModule(
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<HostResourceModule> {
  const loaded: unknown = await import(pathToFileURL(resolveAtetHostResourceModule(environment)).href);
  if (
    typeof loaded !== "object"
    || loaded === null
    || !("createHostResourceCoordinator" in loaded)
    || typeof loaded.createHostResourceCoordinator !== "function"
  ) {
    throw new Error("the installed Atet host-resource module is incompatible");
  }
  return { createHostResourceCoordinator: loaded.createHostResourceCoordinator as HostResourceModule["createHostResourceCoordinator"] };
}

function spawnCommand(
  command: readonly string[],
  cwd: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  inheritedLeaseDescriptor?: number,
): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const [program, ...arguments_] = command;
    if (program === undefined) return reject(new Error("command is empty"));
    const child = spawn(program, arguments_, {
      cwd,
      env: { ...environment },
      stdio: inheritedLeaseDescriptor === undefined
        ? "inherit"
        : ["inherit", "inherit", "inherit", inheritedLeaseDescriptor],
    });
    const forward = (signal: NodeJS.Signals): void => {
      if (!child.killed) child.kill(signal);
    };
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);
    child.once("error", (error) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      resolveExit(code ?? (signal === null ? 1 : 128));
    });
  });
}

export function permissionBoundaryDenied(error: unknown): boolean {
  let current = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null || seen.has(current)) return false;
    seen.add(current);
    if (
      "code" in current
      && (current.code === "EACCES" || current.code === "EPERM")
    ) return true;
    try {
      current = "cause" in current ? current.cause : undefined;
    } catch {
      return false;
    }
  }
  return false;
}

export async function runHostCommand(options: HostRunOptions): Promise<number> {
  const environment = { ...(options.environment ?? process.env) };
  if (environment.HRA_LOCAL_EFFICIENCY_LEASE !== undefined) {
    return spawnCommand(options.command, options.cwd, environment);
  }
  const capacity = permitCapacity();
  const permitCount = permitsForMode(options.mode);
  const stateRoot = options.stateRoot
    ?? resolveHostResourceStateRoot(environment);
  const module = await hostResourceModule(environment);
  const coordinator = module.createHostResourceCoordinator({
    profile: {
      id: `hra.local-efficiency/v1-${capacity}`,
      capacities: [{ resource: "cpu", limit: capacity }],
    },
    stateRoot,
    waitTimeoutMilliseconds: 24 * 60 * 60_000,
  });
  const queuedAt = performance.now();
  console.error(
    `[hra-host-run] waiting for ${options.mode} ${options.label} (${permitCount}/${capacity} permits)`,
  );
  const execution = { admitted: false };
  try {
    return await coordinator.withLease(
      [{ resource: "cpu", amount: permitCount }],
      async (lease) => {
        execution.admitted = true;
        const waitedSeconds = (performance.now() - queuedAt) / 1_000;
        console.error(
          `[hra-host-run] admitted ${options.label} after ${waitedSeconds.toFixed(1)}s`,
        );
        const childEnvironment = {
          ...environment,
          HRA_LOCAL_EFFICIENCY_LEASE: JSON.stringify({
            capacity,
            label: options.label,
            mode: options.mode,
            permits: permitCount,
            version: 1,
          }),
        };
        return spawnCommand(
          options.command,
          options.cwd,
          childEnvironment,
          lease.inheritedFileDescriptor,
        );
      },
      { waitTimeoutMilliseconds: 24 * 60 * 60_000 },
    );
  } catch (error: unknown) {
    if (!execution.admitted && permissionBoundaryDenied(error)) {
      throw new HostAccessRequiredError();
    }
    throw error;
  }
}

function usage(): string {
  return "Usage: hra-host-run --mode=shared|heavy|exclusive [--label=LABEL] -- COMMAND [ARGUMENT ...]";
}

if (import.meta.main) {
  try {
    const parsed = parseHostRunArguments(process.argv.slice(2));
    process.exitCode = await runHostCommand({ ...parsed, cwd: process.cwd() });
  } catch (error) {
    if (error instanceof HostAccessRequiredError) {
      console.error(`[hra-host-run] ${error.code}: ${error.message}`);
      process.exitCode = hostAccessRequiredExitCode;
    } else {
      console.error(`[hra-host-run] ${error instanceof Error ? error.message : String(error)}`);
      console.error(usage());
      process.exitCode = 1;
    }
  }
}
