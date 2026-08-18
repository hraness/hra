import { existsSync } from "node:fs";
import path from "node:path";

import {
  checkBundleBoundary,
  DIRECT_WIRE_MARKERS,
  type BundleBoundaryResult,
} from "@hraness/direct/tooling/bundle-boundary";

const SOURCE_MARKERS = Object.freeze([
  "@hraness/direct",
  ...DIRECT_WIRE_MARKERS,
  "hra.agent-tasks.direct/v1",
  "@/direct",
  "../direct",
  "./direct",
  "__direct_scenario",
  "__direct_fixture",
  "__direct",
  "AgentTasksDirect",
  "Agent Tasks Direct",
  ".direct-frame-only",
  ".direct-workbench",
  "data-agent-tasks-direct",
]);
const EMITTED_MARKERS = Object.freeze([
  ...DIRECT_WIRE_MARKERS,
  "hra.agent-tasks.direct/v1",
  "__direct_scenario",
  "__direct_fixture",
  "__direct",
  "AgentTasksDirect",
  "Agent Tasks Direct",
  ".direct-frame-only",
  ".direct-workbench",
  "data-agent-tasks-direct",
]);

export interface AgentTasksProductionBoundaryResult {
  readonly source: BundleBoundaryResult;
  readonly emitted: BundleBoundaryResult;
}

function emptyResult(): BundleBoundaryResult {
  return { scanned: Object.freeze([]), violations: Object.freeze([]) };
}

function combineResults(results: readonly BundleBoundaryResult[]): BundleBoundaryResult {
  const scanned = new Set<string>();
  const violations = new Map<string, Set<string>>();
  for (const result of results) {
    for (const file of result.scanned) scanned.add(file);
    for (const violation of result.violations) {
      const markers = violations.get(violation.file) ?? new Set<string>();
      for (const marker of violation.markers) markers.add(marker);
      violations.set(violation.file, markers);
    }
  }
  return {
    scanned: Object.freeze([...scanned].sort()),
    violations: Object.freeze([...violations]
      .map(([file, markers]) => ({ file, markers: Object.freeze([...markers]) }))
      .sort((left, right) => left.file.localeCompare(right.file))),
  };
}

async function scanExisting(
  directory: string,
  markers: readonly string[],
  patterns: readonly string[],
  excludePatterns: readonly string[] = [],
): Promise<BundleBoundaryResult> {
  return existsSync(directory)
    ? await checkBundleBoundary({ directory, excludePatterns, markers, patterns })
    : emptyResult();
}

export async function checkAgentTasksProductionBoundary(
  productRoot = path.resolve(import.meta.dir, ".."),
): Promise<AgentTasksProductionBoundaryResult> {
  const sourcePatterns = ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs", "**/*.css"];
  const source = combineResults(await Promise.all([
    ...["app", "components", "convex", "lib", "public", "src"].map((directory) => (
      scanExisting(path.join(productRoot, directory), SOURCE_MARKERS, sourcePatterns)
    )),
    scanExisting(
      productRoot,
      SOURCE_MARKERS,
      ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs", "*.css"],
      ["production-icon-boundary.ts"],
    ),
  ]));
  const emitted = await scanExisting(
    path.join(productRoot, ".next"),
    EMITTED_MARKERS,
    [
      "**/*.cjs",
      "**/*.css",
      "**/*.html",
      "**/*.js",
      "**/*.json",
      "**/*.map",
      "**/*.mjs",
      "**/*.rsc",
      "**/*.svg",
      "**/*.txt",
      "**/*.xml",
    ],
  );

  const violations = [...source.violations, ...emitted.violations];
  if (violations.length > 0) {
    throw new Error([
      "Agent Tasks production assets contain Direct markers:",
      ...violations.map((violation) => `${violation.file}: ${violation.markers.join(", ")}`),
    ].join("\n"));
  }
  if (source.scanned.length === 0) {
    throw new Error("Agent Tasks production boundary did not scan any production source files.");
  }
  if (emitted.scanned.length === 0) {
    throw new Error("Agent Tasks production boundary did not scan any emitted Next.js assets.");
  }
  return { source, emitted };
}

if (import.meta.main) {
  const result = await checkAgentTasksProductionBoundary();
  console.log(
    `Agent Tasks production boundary passed (${result.source.scanned.length} source files, ${result.emitted.scanned.length} emitted assets).`,
  );
}
