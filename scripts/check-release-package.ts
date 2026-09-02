import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { assertInstallPinsForRelease } from "./check-install-pins";
import { assertReleasePackageReady } from "./release-package-policy";

const manifest = JSON.parse(
  await readFile(resolve(import.meta.dir, "..", "package.json"), "utf8"),
) as unknown;
const inspection = assertReleasePackageReady(manifest);
console.log(`HRA release package is registry-ready: ${inspection.name}@${inspection.version}.`);

// Under a tag ref the public install command must name exactly the runtime
// bytes being released; outside a tag ref the working-tree pins are covered
// by check-install-pins.ts in the ordinary gate.
if (process.env.GITHUB_REF_TYPE === "tag") {
  const tag = process.env.GITHUB_REF_NAME ?? "";
  await assertInstallPinsForRelease(resolve(import.meta.dir, ".."), tag);
  process.stdout.write(`Installer pins are release-consistent for ${tag}.\n`);
}
