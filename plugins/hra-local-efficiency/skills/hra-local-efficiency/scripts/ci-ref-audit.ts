#!/usr/bin/env bun

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { canonicalIfPresent, command } from "./shared";

type AuditKind = "governed" | "not-applicable" | "review" | "unsafe";

type CiAuditOptions = {
  readonly check: boolean;
  readonly json: boolean;
  readonly root: string;
};

export type CiAuditRow = {
  readonly job: string;
  readonly kind: AuditKind;
  readonly reasons: readonly string[];
  readonly workflow: string;
};

export type CiAuditReport = {
  readonly completeHistoryConsumer: boolean;
  readonly counts: Readonly<Record<AuditKind, number>>;
  readonly root: string;
  readonly rows: readonly CiAuditRow[];
  readonly version: 1;
};

const workflowMaximumBytes = 512 * 1024;
const workflowMaximumCount = 128;
const jobMaximumCount = 128;
const stepMaximumCount = 256;
const trackedConsumerMaximumFiles = 20_000;
const trackedConsumerMaximumBytes = 512 * 1024;

export function parseCiAuditArguments(
  arguments_: readonly string[],
  cwd = process.cwd(),
): CiAuditOptions {
  let check = false;
  let json = false;
  let root = resolve(cwd);
  let rootSupplied = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--check") check = true;
    else if (argument === "--json") json = true;
    else if (argument === "--root") {
      if (rootSupplied) throw new Error("--root may appear only once");
      const value = arguments_[index + 1];
      if (value === undefined || !isAbsolute(value)) {
        throw new Error("--root requires an absolute path");
      }
      root = resolve(value);
      rootSupplied = true;
      index += 1;
    } else throw new Error(`unknown ci-ref-audit argument: ${argument}`);
  }
  return { check, json, root };
}

function record(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function trackedCompleteHistoryConsumer(root: string): boolean {
  const filesResult = command(["git", "-C", root, "ls-files", "-z"]);
  if (filesResult.exitCode !== 0) throw new Error("could not enumerate tracked repository files");
  const files = filesResult.stdout.split("\0").filter((path) => path !== "");
  if (files.length > trackedConsumerMaximumFiles) {
    throw new Error("tracked file bound exceeded during complete-history audit");
  }
  const eligible = /(?:^|\/)(?:package\.json|[^/]+\.(?:bash|js|mjs|sh|ts))$/u;
  for (const relativePath of files) {
    if (!eligible.test(relativePath)) continue;
    const path = join(root, relativePath);
    const metadata = (() => {
      try {
        return lstatSync(path);
      } catch (error: unknown) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
          return null;
        }
        throw error;
      }
    })();
    if (metadata === null) continue;
    if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
    if (metadata.size > trackedConsumerMaximumBytes) continue;
    const source = readFileSync(path, "utf8");
    if (
      /\bgit\s+(?:rev-list|log|grep)\b[^\n]{0,240}\s--all(?:\s|$)/u.test(source)
      || /\brev-list\b[^\n]{0,160}--all(?:\s|["'])/u.test(source)
    ) return true;
  }
  return false;
}

function workflowFiles(root: string): string[] {
  const directory = join(root, ".github", "workflows");
  const entries = (() => {
    try {
      return readdirSync(directory, { encoding: "utf8", withFileTypes: true });
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  })();
  const files = entries
    .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
    .map((entry) => join(directory, entry.name))
    .sort();
  if (files.length > workflowMaximumCount) throw new Error("workflow file bound exceeded");
  return files;
}

function exactCheckout(step: Record<string, unknown>): boolean {
  const with_ = step.with === undefined ? {} : record(step.with, "checkout inputs");
  const ref = text(with_.ref);
  const depth = text(with_["fetch-depth"]);
  const tags = text(with_["fetch-tags"]);
  const credentials = text(with_["persist-credentials"]);
  return depth === "1"
    && tags === "false"
    && credentials === "false"
    && (/github\.sha/u.test(ref) || /verified_sha/u.test(ref) || /refs\/tags\//u.test(ref));
}

function broadCheckout(step: Record<string, unknown>): boolean {
  const with_ = step.with === undefined ? {} : record(step.with, "checkout inputs");
  return text(with_["fetch-depth"]) === "0";
}

export function classifyCiJob(input: {
  readonly completeHistoryConsumer: boolean;
  readonly job: Record<string, unknown>;
}): Pick<CiAuditRow, "kind" | "reasons"> {
  const steps = input.job.steps;
  if (!Array.isArray(steps)) return { kind: "not-applicable", reasons: ["job has no steps"] };
  if (steps.length > stepMaximumCount) throw new Error("workflow step bound exceeded");
  const parsedSteps = steps.map((step, index) => record(step, `workflow step ${index}`));
  const checkout = parsedSteps.find((step) => /(?:^|\/)actions\/checkout@/u.test(text(step.uses)));
  const scripts = parsedSteps.map((step) => text(step.run)).filter((value) => value !== "").join("\n");
  const fetchAll = /\bgit\s+fetch\b[^\n]{0,240}(?:\s--all(?:\s|$)|refs\/heads\/\*)/u.test(scripts);
  const directCompleteScan = /\bgit\s+(?:rev-list|log|grep)\b[^\n]{0,240}\s--all(?:\s|$)/u.test(scripts);
  if (fetchAll) return { kind: "unsafe", reasons: ["job fetches an unbounded ref set"] };
  if (checkout === undefined) {
    return input.completeHistoryConsumer && directCompleteScan
      ? { kind: "review", reasons: ["complete-history scan has no auditable checkout step"] }
      : { kind: "not-applicable", reasons: ["job does not check out repository history"] };
  }
  if (broadCheckout(checkout) && (input.completeHistoryConsumer || directCompleteScan)) {
    return {
      kind: "unsafe",
      reasons: ["broad checkout can couple a complete-history consumer to unrelated refs"],
    };
  }
  if (broadCheckout(checkout)) {
    return { kind: "review", reasons: ["broad history fetch has no detected complete-history consumer"] };
  }
  if (!input.completeHistoryConsumer && !directCompleteScan) {
    return { kind: "not-applicable", reasons: ["no complete-history consumer detected"] };
  }
  const governedFetch = /\bgit\s+fetch\b/u.test(scripts)
    && /(?:--unshallow|--depth)/u.test(scripts)
    && /\+(?:\$[A-Z_]+|refs\/(?:heads|tags)\/\$[A-Z_]+):refs\//u.test(scripts)
    && !/refs\/(?:heads|tags)\/\*/u.test(scripts);
  const enumeratesRefs = /git\s+for-each-ref\b/u.test(scripts);
  const rejectsUnexpected = /Unexpected ref|unexpected ref/u.test(scripts);
  if (exactCheckout(checkout) && governedFetch && enumeratesRefs && rejectsUnexpected) {
    return {
      kind: "governed",
      reasons: ["exact shallow checkout expands only explicit refs and rejects unexpected refs"],
    };
  }
  return {
    kind: "review",
    reasons: ["complete-history consumer is not statically proven to receive only governed refs"],
  };
}

export function auditCiRefs(root: string): CiAuditReport {
  const gitRoot = command(["git", "-C", root, "rev-parse", "--show-toplevel"]);
  if (gitRoot.exitCode !== 0 || canonicalIfPresent(gitRoot.stdout) !== canonicalIfPresent(root)) {
    throw new Error("--root must be an exact Git worktree root");
  }
  const completeHistoryConsumer = trackedCompleteHistoryConsumer(root);
  const rows: CiAuditRow[] = [];
  for (const path of workflowFiles(root)) {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > workflowMaximumBytes) {
      throw new Error(`workflow is not a bounded regular file: ${relative(root, path)}`);
    }
    const parsed = Bun.YAML.parse(readFileSync(path, "utf8"));
    const jobs = record(record(parsed, "workflow").jobs, "workflow jobs");
    const jobEntries = Object.entries(jobs);
    if (jobEntries.length > jobMaximumCount) throw new Error("workflow job bound exceeded");
    for (const [jobName, jobValue] of jobEntries) {
      const classified = classifyCiJob({
        completeHistoryConsumer,
        job: record(jobValue, `workflow job ${jobName}`),
      });
      rows.push({
        job: jobName,
        kind: classified.kind,
        reasons: classified.reasons,
        workflow: relative(root, path),
      });
    }
  }
  const counts: Record<AuditKind, number> = {
    governed: 0,
    "not-applicable": 0,
    review: 0,
    unsafe: 0,
  };
  for (const row of rows) counts[row.kind] += 1;
  return { completeHistoryConsumer, counts, root, rows, version: 1 };
}

export function printCiAudit(report: CiAuditReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(
    `CI-REFS\tconsumer=${report.completeHistoryConsumer ? "yes" : "no"}`
    + `\tgoverned=${report.counts.governed}\treview=${report.counts.review}`
    + `\tunsafe=${report.counts.unsafe}`,
  );
  for (const row of report.rows.filter((item) => item.kind !== "not-applicable")) {
    console.log(`${row.kind.toUpperCase()}\t${row.workflow}\t${row.job}\t${row.reasons.join("; ")}`);
  }
  console.log("NOTE\tReview findings require inspection; this command never rewrites CI or weakens history gates.");
}

if (import.meta.main) {
  try {
    const options = parseCiAuditArguments(process.argv.slice(2));
    const report = auditCiRefs(options.root);
    printCiAudit(report, options.json);
    if (options.check && report.counts.unsafe > 0) process.exitCode = 1;
  } catch (error: unknown) {
    console.error(`[hra-ci-ref-audit] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
