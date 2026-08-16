import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import { basename, join } from "node:path";
import type { Database } from "bun:sqlite";

import {
  harnessSignedSemanticEvidenceBundleV2Schema,
  type HarnessSignedSemanticEvidenceCustodyV2,
  type HarnessSemanticEvidenceTrustedSignerV2,
  type HarnessSignedSemanticEvidenceBundleV2,
} from "./semantic-evidence-custody-v2";
import {
  assertHarnessDirectoryIdentity,
  type HarnessDirectoryIdentity,
  type HarnessPreparedStorageLayout,
} from "./storage-layout";

const inboxFileMode = 0o600;
const maximumBundleCount = 16;
const maximumBundleBytes = 256 * 1024;
const maximumInboxBytes = 1024 * 1024;
const inboxFilePattern = /^semantic-evidence-v2-([a-f0-9]{64})\.json$/u;

export type HarnessProductionSemanticEvidenceInboxErrorCodeV2 =
  | "bundle_invalid"
  | "entry_tampered"
  | "inbox_limit"
  | "unexpected_entry"
  | "unsafe_entry"
  | "unsafe_inbox";

/** Path-free because Application Support locations must not enter diagnostics. */
export class HarnessProductionSemanticEvidenceInboxErrorV2 extends Error {
  readonly code: HarnessProductionSemanticEvidenceInboxErrorCodeV2;

  constructor(code: HarnessProductionSemanticEvidenceInboxErrorCodeV2) {
    super({
      bundle_invalid: "A staged semantic evidence bundle is invalid.",
      entry_tampered: "A staged semantic evidence bundle changed while read.",
      inbox_limit: "The semantic evidence inbox exceeds its fixed bounds.",
      unexpected_entry: "The semantic evidence inbox has an unexpected entry.",
      unsafe_entry: "A staged semantic evidence entry is unsafe.",
      unsafe_inbox: "The semantic evidence inbox is unsafe.",
    }[code]);
    this.name = "HarnessProductionSemanticEvidenceInboxErrorV2";
    this.code = code;
  }
}

export interface HarnessProductionSemanticEvidenceConfigV2 {
  readonly trustedSigners: readonly HarnessSemanticEvidenceTrustedSignerV2[];
  readonly importBundles: readonly HarnessSignedSemanticEvidenceBundleV2[];
}

export interface HarnessProductionSemanticEvidenceInboxReadHooksV2 {
  /**
   * A deterministic filesystem-fault seam. Production never supplies it;
   * tests use it to mutate an open entry between the byte read and identity
   * reinspection.
   */
  readonly afterCandidateBytesRead?: (canonicalFileName: string) => void;
}

/**
 * Dormant offline custody registry retained for future research. The current
 * production graph neither imports this module nor reads its inbox, so adding
 * a key or bundle cannot activate a harness feature. A future composition may
 * use this registry only after a separate authority review. Private keys and
 * evidence bundles never belong in source.
 */
export const HARNESS_PRODUCTION_SEMANTIC_EVIDENCE_SIGNERS_V2:
  readonly HarnessSemanticEvidenceTrustedSignerV2[] = Object.freeze([]);

/**
 * Read the dormant custody configuration from the proven storage layout for
 * explicit offline tooling and tests. Nothing in SQLite, the environment,
 * HOME, or a caller-selected path can extend signer trust.
 */
export function loadHarnessProductionSemanticEvidenceConfigV2(
  storage: Pick<
    HarnessPreparedStorageLayout,
    "semanticEvidenceInbox" | "semanticEvidenceInboxIdentity"
  >,
  hooks: HarnessProductionSemanticEvidenceInboxReadHooksV2 = {},
): HarnessProductionSemanticEvidenceConfigV2 {
  if (
    storage.semanticEvidenceInbox !==
      storage.semanticEvidenceInboxIdentity.path
  ) {
    throw new HarnessProductionSemanticEvidenceInboxErrorV2("unsafe_inbox");
  }
  const importBundles = readHarnessProductionSemanticEvidenceInboxV2(
    storage.semanticEvidenceInboxIdentity,
    hooks,
  );
  return Object.freeze({
    trustedSigners: HARNESS_PRODUCTION_SEMANTIC_EVIDENCE_SIGNERS_V2,
    importBundles,
  });
}

export function readHarnessProductionSemanticEvidenceInboxV2(
  directory: HarnessDirectoryIdentity,
  hooks: HarnessProductionSemanticEvidenceInboxReadHooksV2 = {},
): readonly HarnessSignedSemanticEvidenceBundleV2[] {
  const directoryBefore = inspectDirectory(directory);
  let entries: string[];
  try {
    entries = readdirSync(directory.path, { encoding: "utf8" });
  } catch {
    throw new HarnessProductionSemanticEvidenceInboxErrorV2("unsafe_inbox");
  }
  if (entries.length > maximumBundleCount) {
    throw new HarnessProductionSemanticEvidenceInboxErrorV2("inbox_limit");
  }
  const ordered = entries.toSorted(compareCodeUnits);
  const bundles: HarnessSignedSemanticEvidenceBundleV2[] = [];
  let totalBytes = 0;
  for (const entry of ordered) {
    const match = inboxFilePattern.exec(entry);
    if (match === null || basename(entry) !== entry) {
      throw new HarnessProductionSemanticEvidenceInboxErrorV2(
        "unexpected_entry",
      );
    }
    const result = readStableBundleFile(
      directory,
      entry,
      match[1]!,
      hooks,
    );
    totalBytes += result.byteLength;
    if (totalBytes > maximumInboxBytes) {
      throw new HarnessProductionSemanticEvidenceInboxErrorV2("inbox_limit");
    }
    bundles.push(result.bundle);
  }
  const directoryAfter = inspectDirectory(directory);
  if (!sameStableDirectory(directoryBefore, directoryAfter)) {
    throw new HarnessProductionSemanticEvidenceInboxErrorV2("unsafe_inbox");
  }
  return Object.freeze(bundles);
}

/**
 * Import one inspected batch without ever exposing a valid prefix as
 * authority. Immutable objects written before a later rejection are harmless
 * orphans because evidence admission requires a committed inventory row.
 */
export function importHarnessProductionSemanticEvidenceBatchV2(
  database: Database,
  custody: Pick<HarnessSignedSemanticEvidenceCustodyV2, "importSignedBundle">,
  bundles: readonly unknown[],
): void {
  database.transaction(() => {
    for (const bundle of bundles) custody.importSignedBundle(bundle);
  })();
}

export function harnessProductionSemanticEvidenceInboxFileNameV2(
  bytesValue: Uint8Array,
): string {
  if (
    !(bytesValue instanceof Uint8Array) || bytesValue.byteLength < 1 ||
    bytesValue.byteLength > maximumBundleBytes
  ) {
    throw new HarnessProductionSemanticEvidenceInboxErrorV2("inbox_limit");
  }
  return `semantic-evidence-v2-${sha256(bytesValue)}.json`;
}

function readStableBundleFile(
  directory: HarnessDirectoryIdentity,
  entry: string,
  expectedDigest: string,
  hooks: HarnessProductionSemanticEvidenceInboxReadHooksV2,
): Readonly<{
  bundle: HarnessSignedSemanticEvidenceBundleV2;
  byteLength: number;
}> {
  assertDirectory(directory);
  const path = join(directory.path, entry);
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    throw new HarnessProductionSemanticEvidenceInboxErrorV2("unsafe_entry");
  }
  try {
    const before = fstatSync(descriptor, { bigint: true });
    assertPrivateBundleFile(before, directory);
    if (before.size < 1n || before.size > BigInt(maximumBundleBytes)) {
      throw new HarnessProductionSemanticEvidenceInboxErrorV2("inbox_limit");
    }
    assertPublishedIdentity(path, before, directory);
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (count < 1) {
        throw new HarnessProductionSemanticEvidenceInboxErrorV2(
          "entry_tampered",
        );
      }
      offset += count;
    }
    const excess = Buffer.alloc(1);
    if (readSync(descriptor, excess, 0, 1, bytes.byteLength) !== 0) {
      throw new HarnessProductionSemanticEvidenceInboxErrorV2(
        "entry_tampered",
      );
    }
    hooks.afterCandidateBytesRead?.(entry);
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameStableFile(before, after)) {
      throw new HarnessProductionSemanticEvidenceInboxErrorV2(
        "entry_tampered",
      );
    }
    assertPrivateBundleFile(after, directory);
    assertPublishedIdentity(path, after, directory);
    assertDirectory(directory);
    if (sha256(bytes) !== expectedDigest) {
      throw new HarnessProductionSemanticEvidenceInboxErrorV2(
        "entry_tampered",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as unknown;
    } catch {
      throw new HarnessProductionSemanticEvidenceInboxErrorV2(
        "bundle_invalid",
      );
    }
    const bundle = harnessSignedSemanticEvidenceBundleV2Schema.safeParse(parsed);
    if (!bundle.success) {
      throw new HarnessProductionSemanticEvidenceInboxErrorV2(
        "bundle_invalid",
      );
    }
    return Object.freeze({
      bundle: Object.freeze({
        version: 2 as const,
        manifest: Object.freeze({
          ...bundle.data.manifest,
          witnesses: Object.freeze(
            bundle.data.manifest.witnesses.map((witness) =>
              Object.freeze(witness)
            ),
          ),
        }),
        signature: Object.freeze(bundle.data.signature),
      }),
      byteLength: bytes.byteLength,
    });
  } catch (error: unknown) {
    if (error instanceof HarnessProductionSemanticEvidenceInboxErrorV2) {
      throw error;
    }
    throw new HarnessProductionSemanticEvidenceInboxErrorV2("unsafe_entry");
  } finally {
    closeSync(descriptor);
  }
}

function assertDirectory(directory: HarnessDirectoryIdentity): void {
  try {
    assertHarnessDirectoryIdentity(directory);
  } catch {
    throw new HarnessProductionSemanticEvidenceInboxErrorV2("unsafe_inbox");
  }
}

function inspectDirectory(directory: HarnessDirectoryIdentity): BigIntStats {
  assertDirectory(directory);
  let metadata: BigIntStats;
  try {
    metadata = lstatSync(directory.path, { bigint: true });
  } catch {
    throw new HarnessProductionSemanticEvidenceInboxErrorV2("unsafe_inbox");
  }
  if (
    !metadata.isDirectory() || metadata.isSymbolicLink() ||
    metadata.dev !== directory.device || metadata.ino !== directory.inode ||
    Number(metadata.uid) !== directory.owner ||
    (Number(metadata.mode) & 0o777) !== 0o700
  ) {
    throw new HarnessProductionSemanticEvidenceInboxErrorV2("unsafe_inbox");
  }
  return metadata;
}

function assertPrivateBundleFile(
  metadata: BigIntStats,
  directory: HarnessDirectoryIdentity,
): void {
  if (
    !metadata.isFile() || metadata.isSymbolicLink() ||
    metadata.dev !== directory.device || metadata.nlink !== 1n ||
    Number(metadata.uid) !== directory.owner ||
    (Number(metadata.mode) & 0o777) !== inboxFileMode
  ) {
    throw new HarnessProductionSemanticEvidenceInboxErrorV2("unsafe_entry");
  }
}

function assertPublishedIdentity(
  path: string,
  opened: BigIntStats,
  directory: HarnessDirectoryIdentity,
): void {
  let published: BigIntStats;
  try {
    published = lstatSync(path, { bigint: true });
  } catch {
    throw new HarnessProductionSemanticEvidenceInboxErrorV2("entry_tampered");
  }
  assertPrivateBundleFile(published, directory);
  if (!sameStableFile(opened, published)) {
    throw new HarnessProductionSemanticEvidenceInboxErrorV2(
      "entry_tampered",
    );
  }
}

function sameStableFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.uid === right.uid && left.gid === right.gid &&
    left.mode === right.mode && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function sameStableDirectory(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.uid === right.uid && left.gid === right.gid &&
    left.mode === right.mode && left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
