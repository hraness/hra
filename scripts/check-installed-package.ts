import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { assertProductionPackageOnly } from "./package-policy";

const [packageRoot, ...remaining] = process.argv.slice(2);
if (
  remaining.length !== 0
  || packageRoot === undefined
  || !isAbsolute(packageRoot)
  || resolve(packageRoot) !== packageRoot
) {
  throw new Error("Expected one absolute installed-package root.");
}
const canonicalRoot = await realpath(packageRoot);
await assertProductionPackageOnly(canonicalRoot, "installed");
process.stdout.write("Installed package contains production files only.\n");
