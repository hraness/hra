// Local custody for the responder gateway key used by prose autorespond.
//
// The key is a provider credential: it lives in one user-only (0600) regular
// file under the state root, it is never uploaded, never logged, never put in
// a journal entry, an evidence row, a command result, or `--json` output, and
// nothing here returns it to a caller that only needs to know whether it is
// configured. `hasGatewayKey` is the only read the daemon and the settings
// projection use; `readGatewayKey` exists for the responder alone.
//
// INTEGRATOR NOTE: the prose-autorespond work package (`hra autorespond
// gateway set`) is expected to own the same custody. If that package lands its
// own helper, reconcile the two into one module rather than keeping both: the
// file name and payload shape below are the contract to preserve.

import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { StatePaths } from "../storage/paths";

const gatewayKeyFileName = "gateway-key";
const maximumGatewayKeyBytes = 4_096;

// The shape the payload must have, checked without ever putting the value in
// an error message.
const gatewayKeyPattern = /^[\x21-\x7e]{8,512}$/u;

export function gatewayKeyPath(paths: StatePaths): string {
  return join(paths.root, gatewayKeyFileName);
}

export function isGatewayKey(value: unknown): value is string {
  return typeof value === "string" && gatewayKeyPattern.test(value);
}

/**
 * Replace the stored key. The write is atomic (exclusive temporary file,
 * fsync, rename) so a crash mid-write leaves either the previous key or no
 * key, never a truncated one.
 */
export async function setGatewayKey(paths: StatePaths, key: string): Promise<void> {
  if (!isGatewayKey(key)) throw new Error("The gateway key has an unsupported shape.");
  const path = gatewayKeyPath(paths);
  if (!isAbsolute(path)) throw new Error("The gateway key path must be absolute.");
  const staging = `${path}.${crypto.randomUUID()}`;
  const handle = await open(
    staging,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(key, "utf8");
    await handle.sync();
  } catch (error: unknown) {
    await handle.close();
    await unlink(staging).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(staging, path);
  } catch (error: unknown) {
    await unlink(staging).catch(() => undefined);
    throw error;
  }
}

export async function clearGatewayKey(paths: StatePaths): Promise<boolean> {
  try {
    await unlink(gatewayKeyPath(paths));
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Whether a usable key is in custody. A file that is not a user-only regular
 * file, or whose contents do not have the key shape, reports `false` rather
 * than being trusted: the responder then stays off instead of sending an
 * attacker-controlled credential upstream.
 */
export async function hasGatewayKey(paths: StatePaths): Promise<boolean> {
  return await readGatewayKey(paths) !== null;
}

export async function readGatewayKey(paths: StatePaths): Promise<string | null> {
  const path = gatewayKeyPath(paths);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || (metadata.mode & 0o077) !== 0
    || metadata.size > maximumGatewayKeyBytes
  ) return null;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let contents: string;
  try {
    contents = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  const key = contents.trim();
  return isGatewayKey(key) ? key : null;
}
