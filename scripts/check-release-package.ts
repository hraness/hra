import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { assertInstallPinsForRelease } from "./check-install-pins";
import { assertPackageContentAt } from "./package-content";
import { assertReleasePackageReady } from "./release-package-policy";

const repositoryRoot = resolve(import.meta.dir, "..");
const manifest = JSON.parse(
  await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
) as unknown;
const inspection = assertReleasePackageReady(manifest);
await assertPackageContentAt(repositoryRoot);
console.log(`Oompa release package is registry-ready: ${inspection.name}@${inspection.version}.`);

// Under a tag ref the public install command must name exactly the runtime
// bytes being released; outside a tag ref the working-tree pins are covered
// by check-install-pins.ts in the ordinary gate.
if (process.env.GITHUB_REF_TYPE === "tag") {
  const tag = process.env.GITHUB_REF_NAME ?? "";
  await assertInstallPinsForRelease(repositoryRoot, tag);
  process.stdout.write(`Installer pins are release-consistent for ${tag}.\n`);
}
