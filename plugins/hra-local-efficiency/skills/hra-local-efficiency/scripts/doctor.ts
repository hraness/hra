#!/usr/bin/env bun

import { isAbsolute, resolve } from "node:path";

import { checkInstallation, type BootstrapOptions } from "./bootstrap";
import { resolveAtetRuntimeRoot } from "./host-run";
import { resolvedBunBin, resolvedCodexHome } from "./shared";

export type DoctorOptions = {
  readonly bunBin: string;
  readonly codexHome: string;
  readonly json: boolean;
};

export type DoctorReport = {
  readonly bunBin: string;
  readonly codexHome: string;
  readonly failures: readonly string[];
  readonly ok: boolean;
  readonly version: 1;
};

export function parseDoctorArguments(arguments_: readonly string[]): DoctorOptions {
  let bunBin = resolvedBunBin();
  let codexHome = resolvedCodexHome();
  let json = false;
  const seen = new Set<string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--json") {
      if (seen.has(argument)) throw new Error("--json may appear only once");
      seen.add(argument);
      json = true;
      continue;
    }
    if (argument === "--codex-home" || argument === "--bun-bin") {
      if (seen.has(argument)) throw new Error(`${argument} may appear only once`);
      seen.add(argument);
      const value = arguments_[index + 1];
      if (value === undefined || !isAbsolute(value)) {
        throw new Error(`${argument} requires an absolute path`);
      }
      if (argument === "--codex-home") codexHome = resolve(value);
      else bunBin = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`unknown doctor argument: ${argument}`);
  }
  return { bunBin, codexHome, json };
}

export function doctorReport(
  options: DoctorOptions,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): DoctorReport {
  const bootstrapOptions: BootstrapOptions = {
    bunBin: options.bunBin,
    codexHome: options.codexHome,
    installDependency: false,
    mode: "check",
    runtimeRoot: resolveAtetRuntimeRoot(environment),
  };
  let failures: readonly string[];
  try {
    failures = checkInstallation(bootstrapOptions, environment);
  } catch (error: unknown) {
    failures = [`installation check failed: ${error instanceof Error ? error.message : String(error)}`];
  }
  return {
    bunBin: options.bunBin,
    codexHome: options.codexHome,
    failures,
    ok: failures.length === 0,
    version: 1,
  };
}

if (import.meta.main) {
  try {
    const options = parseDoctorArguments(process.argv.slice(2));
    const report = doctorReport(options);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else if (report.ok) console.log("PASS\tHRA local efficiency baseline");
    else for (const failure of report.failures) console.error(`FAIL\t${failure}`);
    if (!report.ok) process.exitCode = 1;
  } catch (error: unknown) {
    console.error(`[hra-local-efficiency] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
