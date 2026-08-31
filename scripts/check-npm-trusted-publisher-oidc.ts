import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  assertNpmPublisherIdentity,
  runNpmPublisher,
} from "./npm-publisher-boundary";
import { assertReleasePackageReady, releaseArchiveName } from "./release-package-policy";

const argument = process.argv[2];
if (argument === undefined) {
  throw new Error("Usage: check-npm-trusted-publisher-oidc.ts ARTIFACT.tgz");
}
const tarball = resolve(argument);
const manifest = JSON.parse(
  await readFile(resolve(import.meta.dir, "..", "package.json"), "utf8"),
) as unknown;
const inspection = assertReleasePackageReady(manifest);
if (basename(tarball) !== releaseArchiveName(inspection.version)) {
  throw new Error("npm trusted-publisher preflight received the wrong release artifact name.");
}
const verifiedTag = process.env.VERIFIED_TAG;
const verifiedSha = process.env.VERIFIED_SHA;
if (verifiedTag === undefined || verifiedSha === undefined) {
  throw new Error("npm trusted-publisher preflight requires verified release identity.");
}
assertNpmPublisherIdentity(process.env, verifiedTag, verifiedSha);
const result = await runNpmPublisher({ dryRun: true, source: process.env, tarball });
if (result.exitCode !== 0 || !result.trustedExchangeProven || result.failure !== null) {
  throw new Error(`npm trusted-publisher OIDC preflight failed (${result.failure ?? "unclassified"}).`);
}
console.log("npm trusted-publisher OIDC exchange preflight passed without publication.");
