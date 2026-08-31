import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  npmRegistryReleaseMetadata,
  parseNpmRelease,
} from "./release-distribution-policy";
import { assertReleasePackageReady, releaseArchiveName } from "./release-package-policy";

const argument = process.argv[2];
if (argument === undefined) throw new Error("Usage: check-npm-artifact-state.ts ARTIFACT.tgz");
const tarball = resolve(argument);
const bytes = await readFile(tarball);
const manifest = JSON.parse(await readFile(resolve(import.meta.dir, "..", "package.json"), "utf8")) as unknown;
const inspection = assertReleasePackageReady(manifest);
if (basename(tarball) !== releaseArchiveName(inspection.version)) {
  throw new Error("npm preflight received the wrong release artifact name.");
}
const response = await fetch(
  `https://registry.npmjs.org/${encodeURIComponent(inspection.name)}/${inspection.version}`,
  {
    cache: "no-store",
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  },
);
const metadata: Record<string, unknown> | null = await npmRegistryReleaseMetadata(
  response,
  inspection.version,
  "version",
);
if (metadata === null) {
  console.log("absent");
} else {
  const coordinate = parseNpmRelease(metadata, inspection.version);
  const expectedIntegrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const expectedShasum = createHash("sha1").update(bytes).digest("hex");
  if (coordinate.integrity !== expectedIntegrity || coordinate.shasum !== expectedShasum) {
    throw new Error(`${inspection.name}@${inspection.version} exists with different immutable bytes.`);
  }
  console.log("exact");
}
