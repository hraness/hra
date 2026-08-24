import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Resolve one project directory only while its name, inode, and access
 * authority remain stable. Callers deliberately receive no raw filesystem
 * diagnostic or alternate path.
 */
export async function resolveUsableCanonicalProjectDirectory(
  requestedRoot: string,
): Promise<string | null> {
  const requested = resolve(requestedRoot);
  try {
    const before = await lstat(requested);
    const canonicalBefore = await realpath(requested);
    const after = await lstat(requested);
    if (
      !before.isDirectory()
      || before.isSymbolicLink()
      || before.nlink < 1
      || canonicalBefore !== requested
      || before.dev !== after.dev
      || before.ino !== after.ino
    ) {
      return null;
    }
    await access(requested, constants.R_OK | constants.W_OK | constants.X_OK);
    const canonicalAfter = await realpath(requested);
    const final = await lstat(requested);
    if (
      !final.isDirectory()
      || final.isSymbolicLink()
      || final.nlink < 1
      || canonicalAfter !== requested
      || final.dev !== before.dev
      || final.ino !== before.ino
    ) {
      return null;
    }
    // Codex currently accepts a path string rather than a held directory
    // descriptor. Callers invoke the provider synchronously after this final
    // proof and recheck daemon authority at that boundary.
    return canonicalAfter;
  } catch {
    return null;
  }
}
