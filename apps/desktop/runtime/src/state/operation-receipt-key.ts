import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

export const operationReceiptKeyByteLength = 32;

const keyFileName = "operation-receipts.hmac.key";

export function operationReceiptKeyPath(databasePath: string): string {
  if (!isAbsolute(databasePath)) throw new Error("Control-plane database path must be absolute");
  return join(dirname(databasePath), keyFileName);
}

export function operationReceiptKeyCandidatePath(keyPath: string): string {
  if (!isAbsolute(keyPath) || basename(keyPath) !== keyFileName) {
    throw new Error("Operation-receipt key path must be an absolute owned state-file path");
  }
  return `${keyPath}.tmp`;
}

export function loadOrCreateOperationReceiptKey(keyPath: string): Uint8Array {
  if (!isAbsolute(keyPath) || basename(keyPath) !== keyFileName) {
    throw new Error("Operation-receipt key path must be an absolute owned state-file path");
  }

  const parent = dirname(keyPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!lstatSync(parent).isDirectory()) {
    throw new Error("Operation-receipt key parent must be a directory");
  }
  chmodSync(parent, 0o700);
  recoverOperationReceiptKeyCandidate(keyPath);

  try {
    return readOperationReceiptKey(keyPath);
  } catch (error: unknown) {
    if (!hasCode(error, "ENOENT")) throw error;
  }

  return createOperationReceiptKey(keyPath);
}

/**
 * Loads already-published receipt authority without creating a replacement.
 * Backup and diagnostic tooling must fail closed when an existing control
 * plane has lost this key because a new key cannot authenticate old receipts.
 */
export function loadExistingOperationReceiptKey(keyPath: string): Uint8Array {
  if (!isAbsolute(keyPath) || basename(keyPath) !== keyFileName) {
    throw new Error("Operation-receipt key path must be an absolute owned state-file path");
  }
  return readOperationReceiptKey(keyPath);
}

function readOperationReceiptKey(keyPath: string): Uint8Array {
  const descriptor = openSync(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error("Operation-receipt key must be a regular file");
    fchmodSync(descriptor, 0o600);
    const key = readFileSync(descriptor);
    if (key.byteLength !== operationReceiptKeyByteLength) {
      throw new Error("Operation-receipt key has an invalid length");
    }
    return Uint8Array.from(key);
  } finally {
    closeSync(descriptor);
  }
}

function createOperationReceiptKey(keyPath: string): Uint8Array {
  const parent = dirname(keyPath);
  const key = randomBytes(operationReceiptKeyByteLength);
  const candidatePath = operationReceiptKeyCandidatePath(keyPath);
  let descriptor: number | null = null;

  try {
    descriptor = openSync(
      candidatePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, key);
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;

    try {
      linkSync(candidatePath, keyPath);
      syncDirectory(parent);
      return Uint8Array.from(key);
    } catch (error: unknown) {
      if (!hasCode(error, "EEXIST")) throw error;
      return readOperationReceiptKey(keyPath);
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    try {
      unlinkSync(candidatePath);
      syncDirectory(parent);
    } catch {
      // A private orphan candidate is safer than masking the key publication result.
    }
  }
}

function recoverOperationReceiptKeyCandidate(keyPath: string): void {
  const candidatePath = operationReceiptKeyCandidatePath(keyPath);
  let candidate;
  try {
    candidate = lstatSync(candidatePath);
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  const parentMetadata = lstatSync(dirname(keyPath));
  if (
    !candidate.isFile() ||
    candidate.isSymbolicLink() ||
    candidate.uid !== process.geteuid?.() ||
    (candidate.mode & 0o777) !== 0o600 ||
    candidate.size !== operationReceiptKeyByteLength ||
    candidate.dev !== parentMetadata.dev
  ) {
    throw new Error("Operation-receipt key candidate is unsafe");
  }
  let published = null;
  try {
    published = lstatSync(keyPath);
  } catch (error: unknown) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  if (published === null) {
    if (candidate.nlink !== 1) {
      throw new Error("Unpublished operation-receipt key candidate has an invalid link count");
    }
  } else if (
    !published.isFile() ||
    published.isSymbolicLink() ||
    published.dev !== candidate.dev ||
    published.ino !== candidate.ino ||
    candidate.nlink !== 2
  ) {
    throw new Error("Operation-receipt key candidate conflicts with the published key");
  }
  unlinkSync(candidatePath);
  syncDirectory(dirname(keyPath));
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function hasCode(error: unknown, expected: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === expected;
}
