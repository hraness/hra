#!/usr/bin/env bun

import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import {
  ensureManagedSymlink,
  readText,
  regularFileMode,
  replaceManagedBlock,
  resolvedBunBin,
  resolvedCodexHome,
  symlinkMatches,
  writeAtomic,
} from "./shared";

export type BootstrapMode = "apply" | "check";

export type BootstrapOptions = {
  readonly bunBin: string;
  readonly codexHome: string;
  readonly mode: BootstrapMode;
};

export type BootstrapReport = {
  readonly commandsCurrent: boolean;
  readonly guidanceCurrent: boolean;
  readonly mode: BootstrapMode;
  readonly status: "current" | "updated";
  readonly version: 1;
};

const pluginName = "hra-cloud-efficiency";
const startMarker = "<!-- hra-cloud-efficiency:start -->";
const endMarker = "<!-- hra-cloud-efficiency:end -->";

export function parseBootstrapArguments(arguments_: readonly string[]): BootstrapOptions {
  let bunBin = resolvedBunBin();
  let codexHome = resolvedCodexHome();
  let mode: BootstrapMode | null = null;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--apply" || argument === "--check") {
      if (mode !== null) throw new Error("choose exactly one of --apply or --check");
      mode = argument.slice(2) as BootstrapMode;
      continue;
    }
    if (argument === "--bun-bin" || argument === "--codex-home") {
      const value = arguments_[index + 1];
      if (value === undefined || !isAbsolute(value)) {
        throw new Error(`${argument} requires one absolute path`);
      }
      if (argument === "--bun-bin") bunBin = resolve(value);
      else codexHome = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`unknown bootstrap argument: ${argument}`);
  }
  if (mode === null) throw new Error("choose --apply or --check");
  return { bunBin, codexHome, mode };
}

function skillRoot(): string {
  return resolve(import.meta.dir, "..");
}

function globalBlock(): string {
  const value = readFileSync(join(skillRoot(), "assets", "global-agents-block.md"), "utf8");
  if (value.split(startMarker).length !== 2 || value.split(endMarker).length !== 2) {
    throw new Error("global guidance asset must contain exactly one managed block");
  }
  if (value.indexOf(startMarker) > value.indexOf(endMarker)) {
    throw new Error("global guidance markers are reversed");
  }
  return value;
}

export function commandTargets(bunBin: string): readonly [string, string][] {
  const scripts = join(skillRoot(), "scripts");
  return [
    [join(bunBin, "hra-cloud-adoption"), join(scripts, "repo-adoption.ts")],
    [join(bunBin, "hra-cloud-efficiency"), join(scripts, "doctor.ts")],
    [join(bunBin, "hra-cloud-exec"), join(scripts, "cloud-run.ts")],
    [join(bunBin, "hra-cloud-route"), join(scripts, "route-check.ts")],
  ];
}

function expectedGuidance(codexHome: string): {
  readonly current: string | null;
  readonly expected: string;
  readonly mode: number;
  readonly path: string;
} {
  const path = join(codexHome, "AGENTS.md");
  const mode = regularFileMode(path, "global Codex guidance");
  const current = readText(path);
  return {
    current,
    expected: replaceManagedBlock(current, globalBlock(), startMarker, endMarker),
    mode,
    path,
  };
}

export function bootstrapCurrent(options: Omit<BootstrapOptions, "mode">): boolean {
  const guidance = expectedGuidance(options.codexHome);
  if (guidance.current !== guidance.expected) return false;
  return commandTargets(options.bunBin).every(([link, target]) => symlinkMatches(link, target));
}

export function runBootstrap(options: BootstrapOptions): BootstrapReport {
  const guidance = expectedGuidance(options.codexHome);
  const wasCurrent = guidance.current === guidance.expected
    && commandTargets(options.bunBin).every(([link, target]) => symlinkMatches(link, target));
  if (options.mode === "check") {
    if (!wasCurrent) throw new Error("HRA Cloud efficiency baseline differs from this plugin");
    return {
      commandsCurrent: true,
      guidanceCurrent: true,
      mode: options.mode,
      status: "current",
      version: 1,
    };
  }

  if (guidance.current !== guidance.expected) {
    writeAtomic(guidance.path, guidance.expected, guidance.mode);
  }
  for (const [link, target] of commandTargets(options.bunBin)) {
    const targetMetadata = lstatSync(target);
    if (
      !targetMetadata.isFile()
      || targetMetadata.isSymbolicLink()
      || targetMetadata.nlink !== 1
      || (targetMetadata.mode & 0o111) === 0
    ) {
      throw new Error(`managed command target is not one executable single-link regular file: ${target}`);
    }
    ensureManagedSymlink(link, target, pluginName, options.codexHome);
  }
  if (!bootstrapCurrent(options)) throw new Error("HRA Cloud efficiency baseline did not converge");
  return {
    commandsCurrent: true,
    guidanceCurrent: true,
    mode: options.mode,
    status: wasCurrent ? "current" : "updated",
    version: 1,
  };
}

if (import.meta.main) {
  try {
    const report = runBootstrap(parseBootstrapArguments(process.argv.slice(2)));
    console.log(`${report.status.toUpperCase()}\tcloud-routing-baseline`);
  } catch (error: unknown) {
    console.error(`[hra-cloud-bootstrap] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
