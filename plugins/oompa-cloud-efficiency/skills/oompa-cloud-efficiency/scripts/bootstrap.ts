#!/usr/bin/env bun

import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import {
  ensureManagedSymlink,
  legacyMarkerPair,
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

const pluginName = "oompa-cloud-efficiency";
// The previous plugin identity. Its installed command links and managed
// block are migrated in place by the bootstrap.
const legacyPluginName = "hra-cloud-efficiency";
const pluginNames: readonly string[] = Object.freeze([pluginName, legacyPluginName]);
const startMarker = "<!-- oompa-cloud-efficiency:start -->";
const endMarker = "<!-- oompa-cloud-efficiency:end -->";
const legacyMarkers = legacyMarkerPair(startMarker, endMarker);
const commandNames = Object.freeze([
  Object.freeze(["oompa-cloud-adoption", "repo-adoption.ts"] as const),
  Object.freeze(["oompa-cloud-efficiency", "doctor.ts"] as const),
  Object.freeze(["oompa-cloud-exec", "cloud-run.ts"] as const),
  Object.freeze(["oompa-cloud-route", "route-check.ts"] as const),
]);

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
  return commandNames.map(([name, script]) => [join(bunBin, name), join(scripts, script)] as const);
}

// Compatibility links under the former command names. Repository guidance
// that has not been re-adopted still names them.
export function legacyCommandTargets(bunBin: string): readonly [string, string][] {
  const scripts = join(skillRoot(), "scripts");
  return commandNames
    .filter(([name]) => name.startsWith("oompa-"))
    .map(([name, script]) => [
      join(bunBin, name.replace(/^oompa-/u, "hra-")),
      join(scripts, script),
    ] as const);
}

// A machine that never installed a legacy command name is not asked to add
// one; a machine that has any legacy name must keep every legacy link current.
export function legacyCommandsPresent(bunBin: string): boolean {
  return legacyCommandTargets(bunBin).some(([link]) => {
    try {
      lstatSync(link);
      return true;
    } catch (error: unknown) {
      if (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "ENOENT"
      ) return false;
      throw error;
    }
  });
}

function requiredCommandTargets(bunBin: string): readonly [string, string][] {
  return legacyCommandsPresent(bunBin)
    ? [...commandTargets(bunBin), ...legacyCommandTargets(bunBin)]
    : commandTargets(bunBin);
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
    expected: replaceManagedBlock(current, globalBlock(), startMarker, endMarker, legacyMarkers),
    mode,
    path,
  };
}

export function bootstrapCurrent(options: Omit<BootstrapOptions, "mode">): boolean {
  const guidance = expectedGuidance(options.codexHome);
  if (guidance.current !== guidance.expected) return false;
  return requiredCommandTargets(options.bunBin).every(([link, target]) => symlinkMatches(link, target));
}

export function runBootstrap(options: BootstrapOptions): BootstrapReport {
  const guidance = expectedGuidance(options.codexHome);
  const wasCurrent = guidance.current === guidance.expected
    && requiredCommandTargets(options.bunBin).every(([link, target]) => symlinkMatches(link, target));
  if (options.mode === "check") {
    if (!wasCurrent) throw new Error("Oompa Cloud efficiency baseline differs from this plugin");
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
  for (const [link, target] of [...commandTargets(options.bunBin), ...legacyCommandTargets(options.bunBin)]) {
    const targetMetadata = lstatSync(target);
    if (
      !targetMetadata.isFile()
      || targetMetadata.isSymbolicLink()
      || targetMetadata.nlink !== 1
      || (targetMetadata.mode & 0o111) === 0
    ) {
      throw new Error(`managed command target is not one executable single-link regular file: ${target}`);
    }
    ensureManagedSymlink(link, target, pluginNames, options.codexHome);
  }
  if (!bootstrapCurrent(options)) throw new Error("Oompa Cloud efficiency baseline did not converge");
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
    console.error(`[oompa-cloud-bootstrap] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
