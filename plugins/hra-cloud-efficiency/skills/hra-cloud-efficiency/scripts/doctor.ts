#!/usr/bin/env bun

import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapCurrent } from "./bootstrap";
import { command, resolvedBunBin, resolvedCodexHome } from "./shared";

export type DoctorReport = {
  readonly baselineCurrent: boolean;
  readonly chatgptLogin: boolean;
  readonly cloudCli: boolean;
  readonly codexAvailable: boolean;
  readonly codexVersion: string | null;
  readonly version: 1;
};

function privateCloudHelp(codex: string): boolean {
  const priorUmask = process.umask(0o077);
  let scratch: string | null = null;
  try {
    scratch = mkdtempSync(join(tmpdir(), "hra-cloud-doctor-"));
    chmodSync(scratch, 0o700);
    process.umask(priorUmask);
    const help = command([codex, "cloud", "--help"], scratch);
    return help.exitCode === 0
      && help.stdout.includes("exec")
      && help.stdout.includes("list")
      && help.stdout.includes("status")
      && help.stdout.includes("diff")
      && help.stdout.includes("apply");
  } finally {
    process.umask(priorUmask);
    if (scratch !== null) rmSync(scratch, { force: false, recursive: true });
  }
}

export function inspectDoctor(): DoctorReport {
  const codex = Bun.which("codex");
  const version = codex === null ? null : command([codex, "--version"]);
  const codexVersion = version?.exitCode === 0 && /^codex-cli [A-Za-z0-9.+-]+$/u.test(version.stdout)
    ? version.stdout
    : null;
  const login = codex === null ? null : command([codex, "login", "status"]);
  return {
    baselineCurrent: bootstrapCurrent({
      bunBin: resolvedBunBin(),
      codexHome: resolvedCodexHome(),
    }),
    chatgptLogin: login?.exitCode === 0 && login.stdout === "Logged in using ChatGPT",
    cloudCli: codex === null ? false : privateCloudHelp(codex),
    codexAvailable: codexVersion !== null,
    codexVersion,
    version: 1,
  };
}

if (import.meta.main) {
  try {
    const arguments_ = process.argv.slice(2);
    if (arguments_.some((argument) => argument !== "--json") || arguments_.length > 1) {
      throw new Error("doctor accepts only optional --json");
    }
    const report = inspectDoctor();
    if (arguments_.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else {
      for (const [key, value] of Object.entries(report)) {
        if (key !== "version") console.log(`${key}\t${String(value)}`);
      }
    }
    if (!report.baselineCurrent || !report.chatgptLogin || !report.cloudCli || !report.codexAvailable) {
      process.exitCode = 1;
    }
  } catch (error: unknown) {
    console.error(`[hra-cloud-efficiency] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
