import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const [mode, artifactArgument, checksumArgument] = process.argv.slice(2);
if ((mode !== "write" && mode !== "check") || artifactArgument === undefined || checksumArgument === undefined) {
  throw new Error("Usage: release-artifact-checksum.ts <write|check> ARTIFACT.tgz SHA256SUMS");
}
const artifact = resolve(artifactArgument);
const checksum = resolve(checksumArgument);
const metadata = await lstat(artifact);
if (
  !metadata.isFile()
  || metadata.isSymbolicLink()
  || metadata.nlink !== 1
  || metadata.size < 1
  || metadata.size > 64 * 1024 * 1024
  || await realpath(artifact) !== artifact
) throw new Error("The release artifact must be one exact bounded regular file.");
const digest = createHash("sha256").update(await readFile(artifact)).digest("hex");
const expected = `${digest}  ${basename(artifact)}\n`;
if (mode === "write") {
  await writeFile(checksum, expected, { encoding: "utf8", flag: "wx", mode: 0o644 });
  console.log(`Wrote SHA-256 for ${basename(artifact)}.`);
} else if (await readFile(checksum, "utf8") !== expected) {
  throw new Error(`SHA-256 mismatch for ${basename(artifact)}.`);
} else {
  console.log(`Verified SHA-256 for ${basename(artifact)}.`);
}
