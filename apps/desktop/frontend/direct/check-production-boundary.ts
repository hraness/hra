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
  "frontend/direct",
  "../direct",
  "./direct",
  "__direct_scenario",
  "__direct_fixture",
  "__direct",
  "Direct ready:",
]);
const EMITTED_MARKERS = Object.freeze([
  ...DIRECT_WIRE_MARKERS,
  "__direct_scenario",
  "__direct_fixture",
  "__direct",
  "Direct ready:",
]);
const FORBIDDEN_FRONTEND_EMITTED_MARKERS = Object.freeze([
  "@hugeicons/core-free-icons",
  "@hugeicons/react",
  "Hugeicons",
]);
const FORBIDDEN_FRONTEND_DEV_MARKERS = Object.freeze([
  "hra-dev-status/v1",
  "/__hra_dev_status",
  "hra:dev-status",
  "HRA — Dev",
]);
const RENDERER_CONTRACT_MARKERS = Object.freeze([
  '"project.',
  '"workspace.upserted',
  '"thread.',
  '"turn.',
  '"item.',
  '"interaction.upserted',
  '"compatibility.',
  '"protocol.',
  "projectId:",
  "workspaceLaneId:",
  "threadId:",
  "itemId:",
  "interactionId:",
  "providerThreadId:",
  "providerTurnId:",
  "providerRestartThreadId:",
  "restartThreadId:",
  "activePrompt:",
  "projects:",
  "workspaceLanes:",
  "threads:",
  "turns:",
  "items:",
  "interactions:",
  "compatibilityFaults:",
  "usage:",
  "models:",
  "codexVersion:",
  "gitVersion:",
  "projectPath:",
  "workspacePath:",
  "worktreePath:",
  "workingDirectory:",
  "transcript:",
  "answer:",
  "stdout:",
  "stderr:",
  "commandOutput:",
  "paths:",
  "commands:",
]);
const RENDERER_SOURCE_MARKERS = Object.freeze([
  "runtime/src/internal-contracts",
]);
const RENDERER_EMITTED_MARKERS = Object.freeze([
  "project.upserted",
  "workspace.upserted",
  "thread.upserted",
  "item.upserted",
  "item.delta",
  "interaction.upserted",
  "compatibility.faulted",
  "project.register",
  "thread.start",
  '"turn.start"',
  "'turn.start'",
  "turn.steer",
  "interaction.answer",
  "codexVersion",
  "gitVersion",
]);
const NON_PRODUCTION_SOURCE_PATTERNS = Object.freeze([
  "**/*.test.{ts,tsx,js,jsx}",
  "**/*.spec.{ts,tsx,js,jsx}",
  "**/__tests__/**/*",
]);

export interface HRAProductionBoundaryResult {
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

export async function checkHRAProductionBoundary(
  frontend = path.resolve(import.meta.dir, ".."),
): Promise<HRAProductionBoundaryResult> {
  const desktop = path.dirname(frontend);
  const directSource = combineResults(await Promise.all([
    scanExisting(
      path.join(frontend, "src"),
      SOURCE_MARKERS,
      ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],
      NON_PRODUCTION_SOURCE_PATTERNS,
    ),
    scanExisting(
      path.join(desktop, "runtime", "src"),
      SOURCE_MARKERS,
      ["**/*.ts", "**/*.js"],
      NON_PRODUCTION_SOURCE_PATTERNS,
    ),
    scanExisting(
      path.join(desktop, "src"),
      SOURCE_MARKERS,
      ["**/*.zig"],
      NON_PRODUCTION_SOURCE_PATTERNS,
    ),
    scanExisting(
      path.join(desktop, "convex"),
      SOURCE_MARKERS,
      ["**/*.ts", "**/*.js"],
      NON_PRODUCTION_SOURCE_PATTERNS,
    ),
    scanExisting(path.join(desktop, "contracts"), SOURCE_MARKERS, ["runtime.ts"]),
  ]));

  const rendererSourceBoundary = combineResults(await Promise.all([
    scanExisting(
      path.join(desktop, "contracts"),
      RENDERER_CONTRACT_MARKERS,
      ["runtime.ts"],
    ),
    scanExisting(
      path.join(frontend, "src"),
      RENDERER_SOURCE_MARKERS,
      ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],
      NON_PRODUCTION_SOURCE_PATTERNS,
    ),
  ]));
  const rendererEmittedBoundary = await scanExisting(
    path.join(frontend, "dist"),
    RENDERER_EMITTED_MARKERS,
    ["**/*"],
  );
  const forbiddenFrontendDependencies = await scanExisting(
    path.join(frontend, "dist"),
    FORBIDDEN_FRONTEND_EMITTED_MARKERS,
    ["**/*"],
  );
  const forbiddenFrontendDevMarkers = await scanExisting(
    path.join(frontend, "dist"),
    FORBIDDEN_FRONTEND_DEV_MARKERS,
    ["**/*"],
  );
  const rendererBoundary = combineResults([
    rendererSourceBoundary,
    rendererEmittedBoundary,
  ]);
  const source = combineResults([directSource, rendererSourceBoundary]);

  // The 0.1.7 bridge retains the signed predecessor executable name on disk.
  const legacyOprteNativeExecutableName = "oprte";
  const directEmitted = combineResults(await Promise.all([
    scanExisting(path.join(frontend, "dist"), EMITTED_MARKERS, ["**/*"]),
    scanExisting(path.join(desktop, "runtime", "dist"), EMITTED_MARKERS, ["oprte-gateway"]),
    scanExisting(path.join(desktop, "zig-out", "bin"), EMITTED_MARKERS, [
      legacyOprteNativeExecutableName,
    ]),
    scanExisting(path.join(desktop, "zig-out", "package"), EMITTED_MARKERS, [
      `**/Contents/MacOS/${legacyOprteNativeExecutableName}`,
      "**/Contents/Resources/frontend/dist/**/*",
      "**/Contents/Resources/runtime/bin/oprte-gateway",
    ]),
  ]));
  const emitted = combineResults([
    directEmitted,
    forbiddenFrontendDependencies,
    forbiddenFrontendDevMarkers,
    rendererEmittedBoundary,
  ]);

  if (rendererBoundary.violations.length > 0) {
    throw new Error([
      "HRA renderer boundary exposes gateway-private state:",
      ...rendererBoundary.violations.map(
        (violation) => `${violation.file}: ${violation.markers.join(", ")}`,
      ),
    ].join("\n"));
  }

  if (forbiddenFrontendDependencies.violations.length > 0) {
    throw new Error([
      "HRA production assets contain forbidden frontend dependencies:",
      ...forbiddenFrontendDependencies.violations.map(
        (violation) => `${violation.file}: ${violation.markers.join(", ")}`,
      ),
    ].join("\n"));
  }
  if (forbiddenFrontendDevMarkers.violations.length > 0) {
    throw new Error([
      "HRA production assets contain malleable-development markers:",
      ...forbiddenFrontendDevMarkers.violations.map(
        (violation) => `${violation.file}: ${violation.markers.join(", ")}`,
      ),
    ].join("\n"));
  }

  const directViolations = [...directSource.violations, ...directEmitted.violations];
  if (directViolations.length > 0) {
    throw new Error([
      "HRA production assets contain browser-lab markers:",
      ...directViolations.map(
        (violation) => `${violation.file}: ${violation.markers.join(", ")}`,
      ),
    ].join("\n"));
  }
  if (source.scanned.length === 0) {
    throw new Error("HRA production boundary did not scan any production source files.");
  }
  if (emitted.scanned.length === 0) {
    throw new Error("HRA production boundary did not scan any emitted production assets.");
  }

  return { source, emitted };
}

if (import.meta.main) {
  const result = await checkHRAProductionBoundary();
  console.log(
    `HRA production boundary passed (${result.source.scanned.length} source files, ${result.emitted.scanned.length} emitted assets).`,
  );
}
