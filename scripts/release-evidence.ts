import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import { assertSafeDarwinInstallAcl } from "../src/install-normalizer";
import { openOwnedPrivateStateDirectory } from "./bounded-process";

export const HRA_RELEASE_VERSION = "0.1.0" as const;
export const HRA_RELEASE_TAG = `v${HRA_RELEASE_VERSION}` as const;
export const HRA_REPOSITORY = "hraness/hra" as const;
export const HRA_REPOSITORY_ID = 1_343_008_607 as const;
export const HRA_CONVEX_TEAM_ID = 513_923 as const;
export const HRA_CONVEX_PROJECT_ID = 2_854_545 as const;
export const HRA_VERCEL_TEAM_ID = "team_UAd1iD2XogJlbFg4h14mRaPM" as const;
export const HRA_VERCEL_PROJECT_ID = "prj_8ciIt9t9foE3utG45frRN7cxckjS" as const;
export const HRA_V0_VERCEL_PROJECT_ID = "prj_eRfUBHdHkEbvIaB8x7dyyZhBc3wr" as const;

const maximumEvidenceBytes = 256 * 1024;
export const PROTECTED_EVIDENCE_DESCRIPTOR_MAXIMUM = 0x7fff_ffff;
const commitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const packageVersionSchema = z.string()
  .min(5)
  .max(128)
  .regex(/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u);
const positiveIntegerSchema = z.number().int().positive().safe();
const timestampSchema = z.number().int().nonnegative().safe();
const deploymentNameSchema = z.string()
  .min(5)
  .max(160)
  .regex(/^[a-z][a-z0-9]*-[a-z][a-z0-9]*-[0-9]+$/u);
const convexUrlSchema = z.string().url().refine((value) => {
  const parsed = new URL(value);
  return parsed.protocol === "https:"
    && parsed.username === ""
    && parsed.password === ""
    && parsed.origin === value
    && parsed.hostname.endsWith(".convex.cloud");
});
const vercelDeploymentIdSchema = z.string().regex(/^dpl_[A-Za-z0-9]{20,80}$/u);
const vercelDeploymentUrlSchema = z.string()
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.vercel\.app$/u);

export const convexTargetEvidenceSchema = z.object({
  deploymentId: positiveIntegerSchema,
  deploymentName: deploymentNameSchema,
  deploymentUrl: convexUrlSchema,
  projectId: z.literal(HRA_CONVEX_PROJECT_ID),
  teamId: z.literal(HRA_CONVEX_TEAM_ID),
}).strict();

export const runtimeReleaseAttestationSchema = z.object({
  bound: z.literal(true),
  deployedAtMs: timestampSchema,
  previousDeployDigest: digestSchema.nullable(),
  runtimeRevision: z.string().uuid(),
  runtimeSourceCommit: commitSchema,
  schemaIdentity: z.literal("hra-release-attestation-v1"),
  schemaVersion: z.literal(1),
}).strict();

export const unboundRuntimeReleaseAttestationSchema = z.object({
  bound: z.literal(false),
  schemaIdentity: z.literal("hra-release-attestation-v1"),
  schemaVersion: z.literal(1),
}).strict();

export const deployEvidenceSchema = z.object({
  after: runtimeReleaseAttestationSchema,
  before: runtimeReleaseAttestationSchema.nullable(),
  kind: z.literal("convex-deploy"),
  overlaySha256: digestSchema,
  phase: z.enum(["bootstrap", "candidate"]),
  previousDeployDigest: digestSchema.nullable(),
  schemaVersion: z.literal(1),
  selfDigest: digestSchema,
  sourceCommit: commitSchema,
  target: convexTargetEvidenceSchema,
  targetDigest: digestSchema,
}).strict().superRefine((value, context) => {
  const bootstrap = value.phase === "bootstrap";
  if (
    value.after.runtimeSourceCommit !== value.sourceCommit
    || value.after.previousDeployDigest !== value.previousDeployDigest
    || value.targetDigest !== canonicalDigest(value.target)
    || (bootstrap && (value.before !== null || value.previousDeployDigest !== null))
    || (!bootstrap && (value.before === null || value.previousDeployDigest === null))
    || (value.before !== null && value.after.deployedAtMs <= value.before.deployedAtMs)
    || (value.before !== null && value.after.runtimeRevision === value.before.runtimeRevision)
  ) context.addIssue({ code: "custom", message: "deploy_evidence_chain_invalid" });
});

export const deployIntentSchema = z.object({
  after: runtimeReleaseAttestationSchema,
  before: runtimeReleaseAttestationSchema.nullable(),
  kind: z.literal("convex-deploy-intent"),
  overlaySha256: digestSchema,
  phase: z.enum(["bootstrap", "candidate"]),
  previousDeployDigest: digestSchema.nullable(),
  schemaVersion: z.literal(1),
  selfDigest: digestSchema,
  sourceCommit: commitSchema,
  target: convexTargetEvidenceSchema,
  targetDigest: digestSchema,
}).strict().superRefine((value, context) => {
  const bootstrap = value.phase === "bootstrap";
  if (
    value.after.runtimeSourceCommit !== value.sourceCommit
    || value.after.previousDeployDigest !== value.previousDeployDigest
    || value.targetDigest !== canonicalDigest(value.target)
    || (bootstrap && (value.before !== null || value.previousDeployDigest !== null))
    || (!bootstrap && (value.before === null || value.previousDeployDigest === null))
    || (value.before !== null && value.after.deployedAtMs <= value.before.deployedAtMs)
    || (value.before !== null && value.after.runtimeRevision === value.before.runtimeRevision)
  ) context.addIssue({ code: "custom", message: "deploy_intent_chain_invalid" });
});

export const liveAcceptanceEvidenceDocumentSchema = z.object({
  completedAt: timestampSchema,
  deployEvidenceDigest: digestSchema,
  evidenceDigest: digestSchema,
  kind: z.literal("live-acceptance"),
  packageVersion: packageVersionSchema,
  runId: z.string().uuid(),
  runtimeRevision: z.string().uuid(),
  schemaVersion: z.literal(1),
  selfDigest: digestSchema,
  sourceCommit: commitSchema,
  startedAt: timestampSchema,
  status: z.literal("passed"),
  targetDigest: digestSchema,
}).strict().superRefine((value, context) => {
  if (value.completedAt < value.startedAt) {
    context.addIssue({ code: "custom", message: "live_acceptance_time_invalid" });
  }
});

export const cutoverEvidenceSchema = z.object({
  changed: z.boolean(),
  direction: z.enum(["forward", "reverse"]),
  finalAuthorityDigest: digestSchema,
  kind: z.literal("domain-cutover"),
  planDigest: digestSchema,
  previousDigest: digestSchema.nullable(),
  replayed: z.boolean(),
  schemaVersion: z.literal(1),
  selfDigest: digestSchema,
  sequence: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  sourceCommit: commitSchema,
}).strict().superRefine((value, context) => {
  const expectedDirection = value.sequence === 2 ? "reverse" : "forward";
  if (
    value.direction !== expectedDirection
    || (value.sequence === 1) !== (value.previousDigest === null)
    || value.changed === value.replayed
  ) context.addIssue({ code: "custom", message: "cutover_evidence_chain_invalid" });
});

export const cutoverReservationSchema = z.object({
  direction: z.enum(["forward", "reverse"]),
  kind: z.literal("domain-cutover-reservation"),
  planDigest: digestSchema,
  previousDigest: digestSchema.nullable(),
  schemaVersion: z.literal(1),
  selfDigest: digestSchema,
  sequence: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  sourceCommit: commitSchema,
}).strict();

const ciJobSchema = z.object({
  completedAt: z.string().datetime({ offset: true }),
  conclusion: z.literal("success"),
  headCommit: commitSchema,
  name: z.enum(["Check (macos-15)", "Check (ubuntu-24.04)", "Required"]),
  runAttempt: positiveIntegerSchema,
  runId: positiveIntegerSchema,
  workflow: z.literal("CI"),
}).strict();

export const vercelEndpointEvidenceSchema = z.object({
  deploymentId: vercelDeploymentIdSchema,
  deploymentUrl: vercelDeploymentUrlSchema,
  projectId: z.enum([HRA_VERCEL_PROJECT_ID, HRA_V0_VERCEL_PROJECT_ID]),
  repositoryId: z.union([z.literal(HRA_REPOSITORY_ID), z.literal(1_334_876_494)]),
  sourceCommit: commitSchema,
  version: z.string().regex(/^0\.[0-9]+\.[0-9]+$/u),
}).strict();

export const releaseCandidateReceiptSchema = z.object({
  ci: z.tuple([ciJobSchema, ciJobSchema, ciJobSchema]),
  convex: z.object({
    bootstrapDeployDigest: digestSchema,
    bootstrapLive: z.object({
      completedAt: timestampSchema,
      deployEvidenceDigest: digestSchema,
      digest: digestSchema,
      packageVersion: z.literal(HRA_RELEASE_VERSION),
      sourceCommit: commitSchema,
      startedAt: timestampSchema,
      targetDigest: digestSchema,
      runtimeRevision: z.string().uuid(),
    }).strict(),
    bootstrapRuntime: runtimeReleaseAttestationSchema,
    candidateDeployDigest: digestSchema,
    candidateLive: z.object({
      completedAt: timestampSchema,
      deployEvidenceDigest: digestSchema,
      digest: digestSchema,
      packageVersion: z.literal(HRA_RELEASE_VERSION),
      sourceCommit: commitSchema,
      startedAt: timestampSchema,
      targetDigest: digestSchema,
      runtimeRevision: z.string().uuid(),
    }).strict(),
    candidateRuntime: runtimeReleaseAttestationSchema,
    target: convexTargetEvidenceSchema,
    targetDigest: digestSchema,
  }).strict(),
  cutover: z.object({
    finalForwardDigest: digestSchema,
    forwardDigest: digestSchema,
    reverseDigest: digestSchema,
  }).strict(),
  kind: z.literal("release-candidate"),
  releaseVersion: z.literal(HRA_RELEASE_VERSION),
  repository: z.object({
    id: z.literal(HRA_REPOSITORY_ID),
    name: z.literal(HRA_REPOSITORY),
  }).strict(),
  schemaVersion: z.literal(1),
  sealedAt: timestampSchema,
  selfDigest: digestSchema,
  sourceCommit: commitSchema,
  surfaceDigest: digestSchema,
  tag: z.literal(HRA_RELEASE_TAG),
  vercel: z.object({
    authorityDigest: digestSchema,
    candidate: vercelEndpointEvidenceSchema,
    fallback: vercelEndpointEvidenceSchema,
    teamId: z.literal(HRA_VERCEL_TEAM_ID),
  }).strict(),
}).strict().superRefine((value, context) => {
  const names = value.ci.map((job) => job.name).sort();
  const ciRuns = new Set(value.ci.map((job) => `${String(job.runId)}:${String(job.runAttempt)}:${job.headCommit}`));
  if (
    JSON.stringify(names) !== JSON.stringify([
      "Check (macos-15)",
      "Check (ubuntu-24.04)",
      "Required",
    ])
    || ciRuns.size !== 1
    || value.ci.some((job) => job.headCommit !== value.sourceCommit)
    || value.convex.targetDigest !== canonicalDigest(value.convex.target)
    || value.convex.candidateLive.sourceCommit !== value.sourceCommit
    || value.convex.candidateLive.targetDigest !== value.convex.targetDigest
    || value.convex.candidateLive.deployEvidenceDigest !== value.convex.candidateDeployDigest
    || value.convex.candidateLive.runtimeRevision !== value.convex.candidateRuntime.runtimeRevision
    || value.convex.candidateRuntime.runtimeSourceCommit !== value.sourceCommit
    || value.convex.bootstrapRuntime.previousDeployDigest !== null
    || value.convex.candidateRuntime.previousDeployDigest !== value.convex.bootstrapDeployDigest
    || value.convex.candidateRuntime.deployedAtMs <= value.convex.bootstrapRuntime.deployedAtMs
    || value.convex.bootstrapLive.targetDigest !== value.convex.targetDigest
    || value.convex.bootstrapLive.deployEvidenceDigest !== value.convex.bootstrapDeployDigest
    || value.convex.bootstrapLive.runtimeRevision !== value.convex.bootstrapRuntime.runtimeRevision
    || value.convex.bootstrapLive.sourceCommit !== value.convex.bootstrapRuntime.runtimeSourceCommit
    || value.convex.bootstrapLive.startedAt <= value.convex.bootstrapRuntime.deployedAtMs
    || value.convex.bootstrapLive.completedAt < value.convex.bootstrapLive.startedAt
    || value.convex.candidateLive.startedAt <= value.convex.candidateRuntime.deployedAtMs
    || value.convex.candidateLive.completedAt < value.convex.candidateLive.startedAt
    || value.ci.some((job) => Date.parse(job.completedAt) > value.sealedAt)
    || value.sealedAt < value.convex.bootstrapLive.completedAt
    || value.sealedAt < value.convex.candidateLive.completedAt
    || value.vercel.candidate.projectId !== HRA_VERCEL_PROJECT_ID
    || value.vercel.candidate.repositoryId !== HRA_REPOSITORY_ID
    || value.vercel.candidate.sourceCommit !== value.sourceCommit
    || value.vercel.candidate.version !== HRA_RELEASE_VERSION
    || value.vercel.fallback.projectId !== HRA_V0_VERCEL_PROJECT_ID
    || value.vercel.fallback.repositoryId !== 1_334_876_494
  ) context.addIssue({ code: "custom", message: "release_candidate_binding_invalid" });
});

export type ConvexTargetEvidence = z.infer<typeof convexTargetEvidenceSchema>;
export type CutoverEvidence = z.infer<typeof cutoverEvidenceSchema>;
export type DeployEvidence = z.infer<typeof deployEvidenceSchema>;
export type DeployIntent = z.infer<typeof deployIntentSchema>;
export type LiveAcceptanceEvidenceDocument = z.infer<typeof liveAcceptanceEvidenceDocumentSchema>;
export type ReleaseCandidateReceipt = z.infer<typeof releaseCandidateReceiptSchema>;
export type RuntimeReleaseAttestation = z.infer<typeof runtimeReleaseAttestationSchema>;

export class ReleaseEvidenceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ReleaseEvidenceError";
  }
}

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return Object.fromEntries(entries.map(([key, entry]) => [key, canonicalValue(entry)]));
  }
  return value;
};

export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalValue(value));

export const canonicalDigest = (value: unknown): string => createHash("sha256")
  .update(canonicalJson(value), "utf8")
  .digest("hex");

export const withSelfDigest = <T extends Readonly<Record<string, unknown>>>(
  value: T,
): T & Readonly<{ selfDigest: string }> => ({
  ...value,
  selfDigest: canonicalDigest(value),
});

export const verifySelfDigest = <T extends Readonly<{ selfDigest: string }>>(
  value: T,
): T => {
  const { selfDigest, ...unsigned } = value;
  if (selfDigest !== canonicalDigest(unsigned)) {
    throw new ReleaseEvidenceError("evidence_digest_invalid");
  }
  return value;
};

const currentUid = (): number => {
  const uid = process.getuid?.();
  if (uid === undefined) throw new ReleaseEvidenceError("custody_unsupported");
  return uid;
};

export const assertProtectedDirectory = (directoryInput: string): string => {
  if (!isAbsolute(directoryInput) || directoryInput.length > 4_096) {
    throw new ReleaseEvidenceError("evidence_path_invalid");
  }
  const directory = resolve(directoryInput);
  let canonical: string;
  let metadata;
  let descriptor = -1;
  try {
    descriptor = openOwnedPrivateStateDirectory(directory, false);
    canonical = realpathSync(directory);
    metadata = lstatSync(directory);
    const held = fstatSync(descriptor);
    if (
      held.dev !== metadata.dev
      || held.ino !== metadata.ino
      || held.uid !== metadata.uid
      || (held.mode & 0o777) !== 0o700
    ) throw new Error("directory_changed");
  } catch {
    throw new ReleaseEvidenceError("evidence_directory_invalid");
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
  }
  if (
    canonical !== directory
    || !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || metadata.uid !== currentUid()
    || (metadata.mode & 0o777) !== 0o700
  ) throw new ReleaseEvidenceError("evidence_directory_invalid");
  return canonical;
};

export const ensureProtectedDirectory = (directoryInput: string): string => {
  if (!isAbsolute(directoryInput) || directoryInput.length > 4_096) {
    throw new ReleaseEvidenceError("evidence_path_invalid");
  }
  let descriptor = -1;
  try {
    descriptor = openOwnedPrivateStateDirectory(resolve(directoryInput));
  } catch {
    throw new ReleaseEvidenceError("evidence_directory_invalid");
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
  }
  return assertProtectedDirectory(directoryInput);
};

const assertDirectChild = (pathInput: string, createDirectory: boolean): Readonly<{
  directory: string;
  path: string;
}> => {
  if (!isAbsolute(pathInput) || pathInput.length > 4_096) {
    throw new ReleaseEvidenceError("evidence_path_invalid");
  }
  const path = resolve(pathInput);
  if (basename(path) === "" || basename(path) === "." || basename(path) === "..") {
    throw new ReleaseEvidenceError("evidence_path_invalid");
  }
  const directory = createDirectory
    ? ensureProtectedDirectory(dirname(path))
    : assertProtectedDirectory(dirname(path));
  if (dirname(path) !== directory) throw new ReleaseEvidenceError("evidence_path_invalid");
  return { directory, path };
};

const assertDirectoryUnchanged = (
  directory: string,
  identity: Stats,
  descriptor: number,
): void => {
  const held = fstatSync(descriptor);
  const current = lstatSync(directory);
  if (
    !held.isDirectory()
    || !current.isDirectory()
    || current.isSymbolicLink()
    || held.dev !== identity.dev
    || held.ino !== identity.ino
    || held.uid !== currentUid()
    || (held.mode & 0o777) !== 0o700
    || current.dev !== identity.dev
    || current.ino !== identity.ino
    || current.uid !== currentUid()
    || (current.mode & 0o777) !== 0o700
    || realpathSync(directory) !== directory
  ) throw new ReleaseEvidenceError("evidence_directory_changed");
  try {
    assertSafeDarwinInstallAcl(descriptor, currentUid(), directory);
  } catch {
    throw new ReleaseEvidenceError("evidence_directory_changed");
  }
};

const readDescriptorBounded = (descriptor: number, maximumBytes: number): Buffer => {
  const output = Buffer.alloc(maximumBytes + 1);
  let offset = 0;
  for (;;) {
    const count = readSync(descriptor, output, offset, output.byteLength - offset, offset);
    if (count === 0) break;
    offset += count;
    if (offset > maximumBytes) throw new ReleaseEvidenceError("evidence_too_large");
  }
  return output.subarray(0, offset);
};

const assertProtectedFileIdentity = (
  metadata: Stats,
  expectedLinks = 1,
): void => {
  if (
    !metadata.isFile()
    || metadata.uid !== currentUid()
    || metadata.nlink !== expectedLinks
    || (metadata.mode & 0o777) !== 0o600
    || metadata.size > maximumEvidenceBytes
  ) throw new ReleaseEvidenceError("evidence_file_invalid");
};

const assertProtectedFileDescriptor = (
  descriptor: number,
  metadata: Stats,
  expectedLinks = 1,
): void => {
  assertProtectedFileIdentity(metadata, expectedLinks);
  try {
    assertSafeDarwinInstallAcl(descriptor, currentUid(), "release evidence");
  } catch {
    throw new ReleaseEvidenceError("evidence_file_invalid");
  }
};

export const readProtectedJson = <T>(
  pathInput: string,
  schema: z.ZodType<T>,
  options: Readonly<{
    boundary?: (boundary: "descriptors_opened") => void;
    recoverInterruptedPublication?: boolean;
  }> = {},
): T => {
  const { directory, path } = assertDirectChild(pathInput, false);
  let directoryDescriptor = -1;
  let descriptor = -1;
  try {
    directoryDescriptor = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    const directoryIdentity = fstatSync(directoryDescriptor);
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        assertDirectoryUnchanged(directory, directoryIdentity, directoryDescriptor);
        throw new ReleaseEvidenceError("evidence_not_found");
      }
      throw error;
    }
    const identity = fstatSync(descriptor);
    const interrupted = identity.nlink === 2
      && options.recoverInterruptedPublication === true;
    assertProtectedFileDescriptor(descriptor, identity, interrupted ? 2 : 1);
    options.boundary?.("descriptors_opened");
    assertDirectoryUnchanged(directory, directoryIdentity, directoryDescriptor);
    const bytes = readDescriptorBounded(descriptor, maximumEvidenceBytes);
    const readback = readDescriptorBounded(descriptor, maximumEvidenceBytes);
    const afterRead = fstatSync(descriptor);
    let pathIdentity: Stats;
    try {
      pathIdentity = lstatSync(path);
    } catch {
      throw new ReleaseEvidenceError("evidence_identity_changed");
    }
    if (
      !readback.equals(bytes)
      || afterRead.dev !== identity.dev
      || afterRead.ino !== identity.ino
      || afterRead.uid !== identity.uid
      || afterRead.nlink !== identity.nlink
      || afterRead.mode !== identity.mode
      || afterRead.size !== identity.size
      || afterRead.mtimeMs !== identity.mtimeMs
      || afterRead.ctimeMs !== identity.ctimeMs
      || !pathIdentity.isFile()
      || pathIdentity.dev !== identity.dev
      || pathIdentity.ino !== identity.ino
      || pathIdentity.uid !== identity.uid
      || pathIdentity.nlink !== identity.nlink
      || pathIdentity.mode !== identity.mode
      || pathIdentity.size !== identity.size
      || pathIdentity.mtimeMs !== identity.mtimeMs
      || pathIdentity.ctimeMs !== identity.ctimeMs
      || realpathSync(directory) !== directory
    ) throw new ReleaseEvidenceError("evidence_identity_changed");
    assertProtectedFileDescriptor(descriptor, afterRead, interrupted ? 2 : 1);
    assertDirectoryUnchanged(directory, directoryIdentity, directoryDescriptor);
    let value: unknown;
    try {
      const text = bytes.toString("utf8");
      if (!text.endsWith("\n") || Buffer.from(text, "utf8").compare(bytes) !== 0) {
        throw new Error("encoding");
      }
      value = JSON.parse(text) as unknown;
    } catch {
      throw new ReleaseEvidenceError("evidence_encoding_invalid");
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new ReleaseEvidenceError("evidence_schema_invalid");
    if (
      typeof parsed.data === "object"
      && parsed.data !== null
      && "selfDigest" in parsed.data
    ) verifySelfDigest(parsed.data as Readonly<{ selfDigest: string }>);
    if (interrupted) {
      const escapedName = basename(path).replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const temporaryPattern = new RegExp(`^\\.${escapedName}\\.[0-9a-f]{32}\\.tmp$`, "u");
      const candidates = readdirSync(directory).filter((name) => temporaryPattern.test(name));
      if (candidates.length !== 1) {
        throw new ReleaseEvidenceError("evidence_publish_unproven");
      }
      const temporary = join(directory, candidates[0] as string);
      const temporaryIdentity = lstatSync(temporary);
      if (
        !temporaryIdentity.isFile()
        || temporaryIdentity.isSymbolicLink()
        || temporaryIdentity.dev !== identity.dev
        || temporaryIdentity.ino !== identity.ino
        || temporaryIdentity.nlink !== 2
      ) throw new ReleaseEvidenceError("evidence_publish_unproven");
      assertDirectoryUnchanged(directory, directoryIdentity, directoryDescriptor);
      fsyncSync(descriptor);
      unlinkSync(temporary);
      fsyncSync(directoryDescriptor);
      const recovered = fstatSync(descriptor);
      const recoveredPath = lstatSync(path);
      assertProtectedFileDescriptor(descriptor, recovered);
      assertProtectedFileIdentity(recoveredPath);
      if (
        recovered.dev !== identity.dev
        || recovered.ino !== identity.ino
        || recovered.nlink !== 1
        || recoveredPath.dev !== identity.dev
        || recoveredPath.ino !== identity.ino
        || recoveredPath.nlink !== 1
        || !readDescriptorBounded(descriptor, maximumEvidenceBytes).equals(bytes)
      ) throw new ReleaseEvidenceError("evidence_publish_unproven");
      assertDirectoryUnchanged(directory, directoryIdentity, directoryDescriptor);
    }
    return parsed.data;
  } catch (error: unknown) {
    if (error instanceof ReleaseEvidenceError) throw error;
    throw new ReleaseEvidenceError("evidence_file_invalid");
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
    if (directoryDescriptor >= 0) closeSync(directoryDescriptor);
  }
};

const recoverExactInterruptedPublication = (
  directory: string,
  path: string,
  encoded: Buffer,
): boolean => {
  let directoryDescriptor = -1;
  let descriptor = -1;
  try {
    directoryDescriptor = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    const directoryIdentity = fstatSync(directoryDescriptor);
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const identity = fstatSync(descriptor);
    assertProtectedFileDescriptor(descriptor, identity, 2);
    if (
      !identity.isFile()
      || identity.uid !== currentUid()
      || identity.nlink !== 2
      || (identity.mode & 0o777) !== 0o600
      || identity.size !== encoded.byteLength
      || identity.size > maximumEvidenceBytes
      || !readDescriptorBounded(descriptor, maximumEvidenceBytes).equals(encoded)
    ) return false;
    const escapedName = basename(path).replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const temporaryPattern = new RegExp(`^\\.${escapedName}\\.[0-9a-f]{32}\\.tmp$`, "u");
    const candidates = readdirSync(directory).filter((name) => temporaryPattern.test(name));
    if (candidates.length !== 1) return false;
    const temporary = join(directory, candidates[0] as string);
    const temporaryIdentity = lstatSync(temporary);
    const finalIdentity = lstatSync(path);
    if (
      !temporaryIdentity.isFile()
      || temporaryIdentity.isSymbolicLink()
      || temporaryIdentity.dev !== identity.dev
      || temporaryIdentity.ino !== identity.ino
      || finalIdentity.dev !== identity.dev
      || finalIdentity.ino !== identity.ino
    ) return false;
    assertDirectoryUnchanged(directory, directoryIdentity, directoryDescriptor);
    unlinkSync(temporary);
    fsyncSync(directoryDescriptor);
    const recovered = fstatSync(descriptor);
    const recoveredPath = lstatSync(path);
    if (
      recovered.nlink !== 1
      || recoveredPath.dev !== identity.dev
      || recoveredPath.ino !== identity.ino
      || !readDescriptorBounded(descriptor, maximumEvidenceBytes).equals(encoded)
    ) throw new ReleaseEvidenceError("evidence_publish_unproven");
    assertDirectoryUnchanged(directory, directoryIdentity, directoryDescriptor);
    return true;
  } catch (error: unknown) {
    if (error instanceof ReleaseEvidenceError) throw error;
    return false;
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
    if (directoryDescriptor >= 0) closeSync(directoryDescriptor);
  }
};

export const writeProtectedJsonNoReplace = <T>(
  pathInput: string,
  value: T,
  schema: z.ZodType<T>,
  options: Readonly<{
    allowExactReplay?: boolean;
    boundary?: (boundary: "temporary_opened" | "destination_published") => void;
  }> = {},
): Readonly<{ path: string; replayed: boolean }> => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ReleaseEvidenceError("evidence_schema_invalid");
  if (
    typeof parsed.data === "object"
    && parsed.data !== null
    && "selfDigest" in parsed.data
  ) verifySelfDigest(parsed.data as Readonly<{ selfDigest: string }>);
  const { directory, path } = assertDirectChild(pathInput, true);
  const encoded = Buffer.from(`${canonicalJson(parsed.data)}\n`, "utf8");
  if (encoded.byteLength > maximumEvidenceBytes) {
    throw new ReleaseEvidenceError("evidence_too_large");
  }
  try {
    lstatSync(path);
    if (options.allowExactReplay === true) {
      try {
        const existing = readProtectedJson(path, schema);
        if (canonicalJson(existing) === canonicalJson(parsed.data)) {
          return { path, replayed: true };
        }
      } catch (error: unknown) {
        if (
          error instanceof ReleaseEvidenceError
          && error.code === "evidence_file_invalid"
          && recoverExactInterruptedPublication(directory, path, encoded)
        ) return { path, replayed: true };
        throw error;
      }
    }
    throw new ReleaseEvidenceError("evidence_exists");
  } catch (error: unknown) {
    if (error instanceof ReleaseEvidenceError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw new ReleaseEvidenceError("evidence_file_invalid");
  }
  const temporary = join(directory, `.${basename(path)}.${randomBytes(16).toString("hex")}.tmp`);
  let directoryDescriptor = -1;
  let descriptor = -1;
  let published = false;
  try {
    directoryDescriptor = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    const directoryIdentity = fstatSync(directoryDescriptor);
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    const initial = fstatSync(descriptor);
    assertProtectedFileDescriptor(descriptor, initial);
    options.boundary?.("temporary_opened");
    assertDirectoryUnchanged(directory, directoryIdentity, directoryDescriptor);
    let offset = 0;
    while (offset < encoded.byteLength) {
      const count = writeSync(descriptor, encoded, offset, encoded.byteLength - offset, offset);
      if (count <= 0) throw new ReleaseEvidenceError("evidence_write_failed");
      offset += count;
    }
    fsyncSync(descriptor);
    const written = fstatSync(descriptor);
    assertProtectedFileDescriptor(descriptor, written);
    if (written.dev !== initial.dev || written.ino !== initial.ino || written.size !== encoded.byteLength) {
      throw new ReleaseEvidenceError("evidence_identity_changed");
    }
    if (!readDescriptorBounded(descriptor, maximumEvidenceBytes).equals(encoded)) {
      throw new ReleaseEvidenceError("evidence_readback_failed");
    }
    const temporaryIdentity = lstatSync(temporary);
    if (temporaryIdentity.dev !== written.dev || temporaryIdentity.ino !== written.ino) {
      throw new ReleaseEvidenceError("evidence_identity_changed");
    }
    assertDirectoryUnchanged(directory, directoryIdentity, directoryDescriptor);
    // A same-directory hard-link publication is the portable POSIX no-replace
    // primitive available to Bun. It is atomic: an existing destination is
    // never replaced. The temporary link is removed before success is reported.
    linkSync(temporary, path);
    published = true;
    options.boundary?.("destination_published");
    assertDirectoryUnchanged(directory, directoryIdentity, directoryDescriptor);
    fsyncSync(directoryDescriptor);
    unlinkSync(temporary);
    fsyncSync(descriptor);
    assertDirectoryUnchanged(directory, directoryIdentity, directoryDescriptor);
    fsyncSync(directoryDescriptor);
    const finalIdentity = lstatSync(path);
    if (
      finalIdentity.dev !== written.dev
      || finalIdentity.ino !== written.ino
      || finalIdentity.nlink !== 1
      || (finalIdentity.mode & 0o777) !== 0o600
      || !readDescriptorBounded(descriptor, maximumEvidenceBytes).equals(encoded)
    ) throw new ReleaseEvidenceError("evidence_publish_unproven");
    assertProtectedFileDescriptor(descriptor, fstatSync(descriptor));
    return { path, replayed: false };
  } catch (error: unknown) {
    if (error instanceof ReleaseEvidenceError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new ReleaseEvidenceError(code === "EEXIST" ? "evidence_exists" : "evidence_write_failed");
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
    if (directoryDescriptor >= 0) closeSync(directoryDescriptor);
    if (!published) {
      try {
        unlinkSync(temporary);
      } catch {
        // The protected temporary may already be absent.
      }
    }
  }
};

export const writeProtectedJsonToFd = <T>(
  descriptor: number,
  value: T,
  schema: z.ZodType<T>,
): void => {
  if (
    !Number.isSafeInteger(descriptor)
    || descriptor < 3
    || descriptor > PROTECTED_EVIDENCE_DESCRIPTOR_MAXIMUM
  ) {
    throw new ReleaseEvidenceError("evidence_descriptor_invalid");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ReleaseEvidenceError("evidence_schema_invalid");
  if (
    typeof parsed.data === "object"
    && parsed.data !== null
    && "selfDigest" in parsed.data
  ) verifySelfDigest(parsed.data as Readonly<{ selfDigest: string }>);
  const encoded = Buffer.from(`${canonicalJson(parsed.data)}\n`, "utf8");
  if (encoded.byteLength > maximumEvidenceBytes) throw new ReleaseEvidenceError("evidence_too_large");
  const before = fstatSync(descriptor);
  assertProtectedFileDescriptor(descriptor, before);
  if (before.size !== 0) throw new ReleaseEvidenceError("evidence_descriptor_not_empty");
  let offset = 0;
  while (offset < encoded.byteLength) {
    const count = writeSync(descriptor, encoded, offset, encoded.byteLength - offset, offset);
    if (count <= 0) throw new ReleaseEvidenceError("evidence_write_failed");
    offset += count;
  }
  fsyncSync(descriptor);
  const after = fstatSync(descriptor);
  if (
    after.dev !== before.dev
    || after.ino !== before.ino
    || after.size !== encoded.byteLength
    || !readDescriptorBounded(descriptor, maximumEvidenceBytes).equals(encoded)
  ) throw new ReleaseEvidenceError("evidence_readback_failed");
  assertProtectedFileDescriptor(descriptor, after);
};

export const defaultReleaseCandidateDirectory = (): string => {
  const uid = process.getuid?.();
  let account: Readonly<{ homedir: string; uid: number }>;
  try {
    const systemAccount = userInfo({ encoding: "utf8" });
    account = { homedir: systemAccount.homedir, uid: systemAccount.uid };
  } catch {
    throw new ReleaseEvidenceError("custody_unsupported");
  }
  if (
    uid === undefined
    || account.uid !== uid
    || !isAbsolute(account.homedir)
  ) throw new ReleaseEvidenceError("custody_unsupported");
  return join(account.homedir, ".local", "state", "hra", "release-candidates");
};

export const defaultReleaseCandidatePath = (
  sourceCommit: string,
): string => {
  if (!commitSchema.safeParse(sourceCommit).success) {
    throw new ReleaseEvidenceError("source_commit_invalid");
  }
  return join(
    defaultReleaseCandidateDirectory(),
    `${HRA_RELEASE_TAG}-${sourceCommit}.json`,
  );
};

export const parseDeployEvidenceFile = (
  path: string,
  options: Readonly<{ recoverInterruptedPublication?: boolean }> = {},
): DeployEvidence => readProtectedJson(path, deployEvidenceSchema, options);

export const parseLiveAcceptanceEvidenceFile = (path: string): LiveAcceptanceEvidenceDocument =>
  readProtectedJson(path, liveAcceptanceEvidenceDocumentSchema);

export const parseCutoverEvidenceFile = (
  path: string,
  options: Readonly<{ recoverInterruptedPublication?: boolean }> = {},
): CutoverEvidence => readProtectedJson(path, cutoverEvidenceSchema, options);

export const parseReleaseCandidateReceiptFile = (
  path: string,
  options: Readonly<{ recoverInterruptedPublication?: boolean }> = {},
): ReleaseCandidateReceipt => readProtectedJson(path, releaseCandidateReceiptSchema, options);
