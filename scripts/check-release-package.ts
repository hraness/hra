import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { assertReleasePackageReady } from "./release-package-policy";

const manifest = JSON.parse(
  await readFile(resolve(import.meta.dir, "..", "package.json"), "utf8"),
) as unknown;
const inspection = assertReleasePackageReady(manifest);
console.log(`HRA release package is registry-ready: ${inspection.name}@${inspection.version}.`);
