import { existsSync } from "node:fs";
import path from "node:path";

import {
  checkBundleBoundary,
  type BundleBoundaryResult,
} from "../../scripts/direct/bundle-boundary";

export const HRA_FORBIDDEN_ICON_OUTPUT_MARKERS = Object.freeze([
  "@hugeicons/",
  "@hugeicons+",
  "Hugeicons",
  "hugeicons",
] as const);

export interface HraProductionIconBoundaryResult {
  readonly emitted: BundleBoundaryResult;
}

export async function checkHraProductionIconBoundary(
  productRoot = import.meta.dir,
): Promise<HraProductionIconBoundaryResult> {
  const outputDirectory = path.join(productRoot, ".next");
  const emitted = existsSync(outputDirectory)
    ? await checkBundleBoundary({
        directory: outputDirectory,
        excludePatterns: ["cache/**", "dev/**"],
        markers: HRA_FORBIDDEN_ICON_OUTPUT_MARKERS,
        patterns: [
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
      })
    : { scanned: Object.freeze([]), violations: Object.freeze([]) };

  if (emitted.violations.length > 0) {
    throw new Error([
      "HRA web production output contains forbidden icon markers:",
      ...emitted.violations.map((violation) => (
        `${violation.file}: ${violation.markers.join(", ")}`
      )),
    ].join("\n"));
  }
  if (emitted.scanned.length === 0) {
    throw new Error("HRA web icon boundary did not scan any emitted Next.js assets.");
  }

  return { emitted };
}

if (import.meta.main) {
  void checkHraProductionIconBoundary()
    .then((result) => {
      console.log(
        `HRA web icon boundary passed (${result.emitted.scanned.length} emitted assets).`,
      );
    })
    .catch((reason: unknown) => {
      console.error(reason);
      process.exitCode = 1;
    });
}
