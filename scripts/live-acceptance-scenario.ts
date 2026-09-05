import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { Writable as WritableStream } from "node:stream";
import { createInterface } from "node:readline/promises";
import { isatty } from "node:tty";

import { z } from "zod";

import {
  canonicalCloudDeploymentUrl,
  DEFAULT_CLOUD_DEPLOYMENT_URL,
} from "../src/cloud/identity-custody";
import { publicInteractionSchema, type PublicInteraction } from "../src/domain/interactions";
import { sessionEventPageSchema, type SessionEvent } from "../src/domain/session-events";
import { safeLiveAcceptanceCommandDigest } from "../src/codex/protocol";
import {
  loadProtectedOutputNativeOpenAtLibrary,
  protectedOutputOpenAtLibrariesForPlatform,
  type ProtectedOutputNativeOpenAtLibrary,
} from "../src/cli/protected-output";
import {
  LIVE_ACCEPTANCE_CONTROL_FD,
  type LiveAcceptanceCliResult,
  type LiveAcceptanceDevice,
  type LiveAcceptanceDeviceName,
  type LiveAcceptanceRun,
} from "./live-acceptance";

const operatorInputFd = 0;
const operatorOutputFd = 1;
const scenarioConfigurationMaximumBytes = 8 * 1024;
const operatorFrameMaximumBytes = 64 * 1024;
const accountLoginDeadlineMs = 10 * 60 * 1_000;
const turnDeadlineMs = 15 * 60 * 1_000;
const remoteCommandDeadlineMs = 10 * 60 * 1_000;
const presenceOfflineBoundaryMs = 45_000;
const presenceObservationMarginMs = 2_000;
const defaultPollIntervalMs = 1_000;
// The 120-second bound covers the 70-second maximum normal cadence, two
// serialized 15-second provider reads, and a 20-second local scheduling margin.
const autonomousUsageProofDeadlineMs = 120_000;
const commandProofContent = "hra-live-tool-progress";
const expectedPermissionName = "network";
const expectedQuestionId = "acceptance_choice";

const reviewedSubscriptionPlans = [
  "business",
  "edu",
  "edu_plus",
  "edu_pro",
  "education",
  "ent26",
  "enterprise",
  "enterprise_cbp_automation",
  "enterprise_cbp_usage_based",
  "go",
  "k12",
  "plus",
  "pro",
  "prolite",
  "quorum",
  "self_serve_business_prolite",
  "self_serve_business_usage_based",
  "team",
] as const;

const canonicalCandidateUrlSchema = z.literal(DEFAULT_CLOUD_DEPLOYMENT_URL).refine((value) => {
  try {
    return canonicalCloudDeploymentUrl(value) === value;
  } catch {
    return false;
  }
}, "The live release gate must target the exact compiled candidate cloud authority.");

export const liveAcceptanceScenarioConfigurationSchema = z.object({
  cloudDeploymentUrl: canonicalCandidateUrlSchema,
  operator: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("terminal") }).strict(),
    z.object({ kind: z.literal("jsonl") }).strict(),
  ]),
  version: z.literal(1),
}).strict();

export type LiveAcceptanceScenarioConfiguration = z.infer<
  typeof liveAcceptanceScenarioConfigurationSchema
>;

export type LiveAcceptanceOperatorRequest = Readonly<{
  context?: unknown;
  kind:
    | "device_a_auth_code"
    | "device_a_auth_invite"
    | "device_b_auth_code"
    | "device_b_auth_email"
    | "permission_grant"
    | "user_answers";
  prompt: string;
}>;

export interface LiveAcceptanceScenarioOperator {
  acknowledgeDeviceLogin(input: Readonly<{
    accountId: string;
    accountLabel: string;
    documentPath: string;
  }>, signal: AbortSignal): Promise<void>;
  prepareDeviceLoginHandoff(input: Readonly<{
    accountId: string;
    accountLabel: string;
    projectDirectory: string;
  }>, signal: AbortSignal): Promise<string>;
  progress(step: string): Promise<void>;
  protectedDocument(
    request: LiveAcceptanceOperatorRequest,
    signal: AbortSignal,
  ): Promise<unknown>;
  close?(): void;
  flush?(): Promise<void>;
}

type ScenarioRun = Pick<
  LiveAcceptanceRun,
  "bindExpectedRevokedPeer" | "cleanup" | "device" | "runId"
>;

type ScenarioTiming = Readonly<{
  accountLoginDeadlineMs?: number;
  autonomousUsageProofDeadlineMs?: number;
  now?: () => number;
  pollIntervalMs?: number;
  prepareCommandProof?: (projectDirectory: string) => CommandProof;
  presenceObservationMarginMs?: number;
  remoteCommandDeadlineMs?: number;
  signal?: AbortSignal;
  sleep?: (milliseconds: number) => Promise<void>;
  turnDeadlineMs?: number;
}>;

export type LiveAcceptanceEvidence = Readonly<{
  accountIds: readonly [string, string];
  cloudTargetDigest: string;
  completedAt: number;
  devicePublicIds: readonly [string, string];
  eventKinds: Readonly<Record<string, readonly string[]>>;
  markerDigests: readonly [string, string, string];
  packageVersion: string;
  pluginLifecycleEffectsRejected: readonly ["auth", "disable", "enable", "install"];
  pluginInstallRejected: true;
  presence: readonly ["online", "offline", "online"];
  providerIdentitiesDistinct: true;
  remoteCommand: Readonly<{ resultCode: "APPLIED"; state: "applied" }>;
  runId: string;
  sessionIds: readonly [string, string];
  sourceRevision: string;
  startedAt: number;
  status: "passed";
  version: 1;
}>;

export type LiveAcceptanceScenarioAttestation = Readonly<{
  cloudTargetDigest: string;
  packageVersion: string;
  sourceRevision: string;
}>;

const stablePackageVersionSchema = z.string()
  .min(5)
  .max(128)
  .regex(/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u);

const scenarioAttestationSchema = z.object({
  cloudTargetDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  packageVersion: stablePackageVersionSchema,
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/u),
}).strict();

const evidenceDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const evidenceIdSchema = z.string().min(1).max(200);
const evidenceTimestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const liveAcceptanceEvidenceSchema: z.ZodType<LiveAcceptanceEvidence> = z.object({
  accountIds: z.tuple([evidenceIdSchema, evidenceIdSchema]),
  cloudTargetDigest: evidenceDigestSchema,
  completedAt: evidenceTimestampSchema,
  devicePublicIds: z.tuple([evidenceIdSchema, evidenceIdSchema]),
  eventKinds: z.record(
    evidenceIdSchema,
    z.array(z.string().min(1).max(128)).min(1).max(32),
  ),
  markerDigests: z.tuple([evidenceDigestSchema, evidenceDigestSchema, evidenceDigestSchema]),
  packageVersion: stablePackageVersionSchema,
  pluginLifecycleEffectsRejected: z.tuple([
    z.literal("auth"),
    z.literal("disable"),
    z.literal("enable"),
    z.literal("install"),
  ]),
  pluginInstallRejected: z.literal(true),
  presence: z.tuple([z.literal("online"), z.literal("offline"), z.literal("online")]),
  providerIdentitiesDistinct: z.literal(true),
  remoteCommand: z.object({
    resultCode: z.literal("APPLIED"),
    state: z.literal("applied"),
  }).strict(),
  runId: z.string().uuid(),
  sessionIds: z.tuple([evidenceIdSchema, evidenceIdSchema]),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/u),
  startedAt: evidenceTimestampSchema,
  status: z.literal("passed"),
  version: z.literal(1),
}).strict().superRefine((evidence, context) => {
  const distinctPairs = [
    evidence.accountIds,
    evidence.devicePublicIds,
    evidence.sessionIds,
  ];
  if (
    evidence.completedAt < evidence.startedAt
    || distinctPairs.some(([left, right]) => left === right)
    || Object.keys(evidence.eventKinds).length !== 2
    || evidence.sessionIds.some((sessionId) => !(sessionId in evidence.eventKinds))
  ) context.addIssue({ code: "custom", message: "Live acceptance evidence is incoherent." });
});

class ScenarioFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ScenarioFailure";
  }
}

type FileIdentity = Readonly<{
  device: number;
  inode: number;
  links: number;
  mode: number;
  owner: number;
}>;

type FileContentSnapshot = Readonly<{
  changedAt: number;
  modifiedAt: number;
  size: number;
}>;

type ProtectedDocumentTestHooks = Readonly<{
  beforeChildOpen?: () => void;
  beforePostflight?: () => void;
  expectedOwnerUid?: number;
  loadNativeOpenAtLibrary?: () => ProtectedOutputNativeOpenAtLibrary | null;
}>;

type CommandProofTestHooks = Readonly<{
  beforeCreate?: () => void;
  beforeVerifyOpen?: () => void;
}>;

const fileIdentity = (stats: Stats): FileIdentity => ({
  device: stats.dev,
  inode: stats.ino,
  links: stats.nlink,
  mode: stats.mode & 0o777,
  owner: stats.uid,
});

const sameFileIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.device === right.device
  && left.inode === right.inode
  && left.links === right.links
  && left.mode === right.mode
  && left.owner === right.owner;

const sameDirectoryIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.device === right.device
  && left.inode === right.inode
  && left.mode === right.mode
  && left.owner === right.owner;

const fileContentSnapshot = (stats: Stats): FileContentSnapshot => ({
  changedAt: stats.ctimeMs,
  modifiedAt: stats.mtimeMs,
  size: stats.size,
});

const sameFileContentSnapshot = (
  left: FileContentSnapshot,
  right: FileContentSnapshot,
): boolean => left.changedAt === right.changedAt
  && left.modifiedAt === right.modifiedAt
  && left.size === right.size;

const currentOwnerUid = (): number => {
  const owner = process.getuid?.();
  if (owner === undefined) throw new ScenarioFailure("protected_document_unsupported");
  return owner;
};

let processNativeOpenAtLibrary: ProtectedOutputNativeOpenAtLibrary | null | undefined;

const loadProcessNativeOpenAtLibrary = (): ProtectedOutputNativeOpenAtLibrary | null => {
  if (processNativeOpenAtLibrary !== undefined) return processNativeOpenAtLibrary;
  processNativeOpenAtLibrary = loadProtectedOutputNativeOpenAtLibrary(
    process.platform,
    process.arch,
  );
  return processNativeOpenAtLibrary;
};

const openChildAt = (
  parentDescriptor: number,
  fileName: string,
  flags: number,
  mode = 0,
  loadNativeOpenAtLibrary = loadProcessNativeOpenAtLibrary,
): number => {
  if (
    basename(fileName) !== fileName
    || fileName === "."
    || fileName === ".."
  ) throw new ScenarioFailure("protected_document_unsupported");
  const nativeOpenAtLibrary = loadNativeOpenAtLibrary();
  if (nativeOpenAtLibrary === null) {
    throw new ScenarioFailure("protected_document_unsupported");
  }
  const encoded = Buffer.from(`${fileName}\0`, "utf8");
  try {
    const descriptor = nativeOpenAtLibrary.symbols.openat(
      parentDescriptor,
      encoded,
      flags | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      mode,
    );
    if (descriptor < 0) throw new ScenarioFailure("protected_document_file_invalid");
    return descriptor;
  } finally {
    encoded.fill(0);
  }
};

const assertOwnedDirectory = (
  path: string,
  descriptor: number,
  expectedOwnerUid: number,
): FileIdentity => {
  const pathStats = lstatSync(path);
  const descriptorStats = fstatSync(descriptor);
  const pathIdentity = fileIdentity(pathStats);
  const descriptorIdentity = fileIdentity(descriptorStats);
  if (
    !pathStats.isDirectory()
    || pathStats.isSymbolicLink()
    || !descriptorStats.isDirectory()
    || pathIdentity.owner !== expectedOwnerUid
    || pathIdentity.mode !== 0o700
    || !sameDirectoryIdentity(pathIdentity, descriptorIdentity)
    || realpathSync(path) !== path
  ) throw new ScenarioFailure("protected_document_parent_invalid");
  return descriptorIdentity;
};

const assertOwnedDocument = (
  descriptor: number,
  expectedOwnerUid: number,
): FileIdentity => {
  const descriptorStats = fstatSync(descriptor);
  const descriptorIdentity = fileIdentity(descriptorStats);
  if (
    !descriptorStats.isFile()
    || descriptorIdentity.owner !== expectedOwnerUid
    || descriptorIdentity.mode !== 0o600
    || descriptorIdentity.links !== 1
  ) throw new ScenarioFailure("protected_document_file_invalid");
  return descriptorIdentity;
};

const assertChildBinding = (
  parentDescriptor: number,
  fileName: string,
  expected: FileIdentity,
  expectedOwnerUid: number,
  loadNativeOpenAtLibrary = loadProcessNativeOpenAtLibrary,
): void => {
  let reboundDescriptor: number | undefined;
  try {
    reboundDescriptor = openChildAt(
      parentDescriptor,
      fileName,
      constants.O_RDONLY,
      0,
      loadNativeOpenAtLibrary,
    );
    if (!sameFileIdentity(
      expected,
      assertOwnedDocument(reboundDescriptor, expectedOwnerUid),
    )) throw new ScenarioFailure("protected_document_changed");
  } finally {
    if (reboundDescriptor !== undefined) closeSync(reboundDescriptor);
  }
};

const readOwnedProtectedJsonDocument = (
  documentPath: string,
  hooks: ProtectedDocumentTestHooks = {},
): unknown => {
  if (
    !isAbsolute(documentPath)
    || resolve(documentPath) !== documentPath
    || basename(documentPath) === ""
  ) throw new ScenarioFailure("protected_document_path_invalid");
  const parentPath = dirname(documentPath);
  const fileName = basename(documentPath);
  const expectedOwnerUid = hooks.expectedOwnerUid ?? currentOwnerUid();
  let parentDescriptor: number | undefined;
  let documentDescriptor: number | undefined;
  let bytes = Buffer.alloc(0);
  const chunks: Buffer[] = [];
  try {
    parentDescriptor = openSync(
      parentPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const parentIdentity = assertOwnedDirectory(
      parentPath,
      parentDescriptor,
      expectedOwnerUid,
    );
    hooks.beforeChildOpen?.();
    documentDescriptor = openChildAt(
      parentDescriptor,
      fileName,
      constants.O_RDONLY,
      0,
      hooks.loadNativeOpenAtLibrary,
    );
    const documentIdentity = assertOwnedDocument(
      documentDescriptor,
      expectedOwnerUid,
    );
    const contentSnapshot = fileContentSnapshot(fstatSync(documentDescriptor));
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(
        8 * 1024,
        operatorFrameMaximumBytes + 1 - total,
      ));
      const count = readSync(documentDescriptor, chunk, 0, chunk.byteLength, null);
      if (count === 0) {
        chunk.fill(0);
        break;
      }
      chunks.push(chunk.subarray(0, count));
      total += count;
      if (total > operatorFrameMaximumBytes) {
        throw new ScenarioFailure("protected_document_oversize");
      }
    }
    if (total === 0) throw new ScenarioFailure("protected_document_empty");
    bytes = Buffer.concat(chunks, total);
    hooks.beforePostflight?.();
    const postParentIdentity = assertOwnedDirectory(
      parentPath,
      parentDescriptor,
      expectedOwnerUid,
    );
    const postDocumentIdentity = assertOwnedDocument(documentDescriptor, expectedOwnerUid);
    assertChildBinding(
      parentDescriptor,
      fileName,
      documentIdentity,
      expectedOwnerUid,
      hooks.loadNativeOpenAtLibrary,
    );
    if (
      !sameDirectoryIdentity(parentIdentity, postParentIdentity)
      || !sameFileIdentity(documentIdentity, postDocumentIdentity)
      || !sameFileContentSnapshot(
        contentSnapshot,
        fileContentSnapshot(fstatSync(documentDescriptor)),
      )
    ) throw new ScenarioFailure("protected_document_changed");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error: unknown) {
    if (error instanceof ScenarioFailure) throw error;
    throw new ScenarioFailure("protected_document_invalid");
  } finally {
    bytes.fill(0);
    for (const chunk of chunks) chunk.fill(0);
    if (documentDescriptor !== undefined) closeSync(documentDescriptor);
    if (parentDescriptor !== undefined) closeSync(parentDescriptor);
  }
};

const writeOwnedProtectedJsonDocument = (
  documentPath: string,
  document: unknown,
): void => {
  if (
    !isAbsolute(documentPath)
    || resolve(documentPath) !== documentPath
    || basename(documentPath) === ""
  ) throw new ScenarioFailure("protected_document_path_invalid");
  const parentPath = dirname(documentPath);
  const fileName = basename(documentPath);
  const expectedOwnerUid = currentOwnerUid();
  let parentDescriptor: number | undefined;
  let documentDescriptor: number | undefined;
  const encoded = Buffer.from(`${JSON.stringify(document)}\n`, "utf8");
  const observed = Buffer.alloc(encoded.byteLength);
  const eofProbe = Buffer.alloc(1);
  try {
    if (encoded.byteLength === 0 || encoded.byteLength > operatorFrameMaximumBytes) {
      throw new ScenarioFailure("protected_document_oversize");
    }
    parentDescriptor = openSync(
      parentPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const parentIdentity = assertOwnedDirectory(parentPath, parentDescriptor, expectedOwnerUid);
    documentDescriptor = openChildAt(parentDescriptor, fileName, constants.O_RDWR);
    const documentIdentity = assertOwnedDocument(documentDescriptor, expectedOwnerUid);
    if (fstatSync(documentDescriptor).size !== 0) {
      throw new ScenarioFailure("protected_document_not_empty");
    }
    let written = 0;
    while (written < encoded.byteLength) {
      const count = writeSync(
        documentDescriptor,
        encoded,
        written,
        encoded.byteLength - written,
        written,
      );
      if (count <= 0) throw new ScenarioFailure("protected_document_write_failed");
      written += count;
    }
    fsyncSync(documentDescriptor);
    const count = readSync(documentDescriptor, observed, 0, observed.byteLength, 0);
    const extra = readSync(documentDescriptor, eofProbe, 0, 1, observed.byteLength);
    const postIdentity = assertOwnedDocument(documentDescriptor, expectedOwnerUid);
    assertChildBinding(parentDescriptor, fileName, documentIdentity, expectedOwnerUid);
    if (
      count !== encoded.byteLength
      || extra !== 0
      || !observed.equals(encoded)
      || !sameFileIdentity(documentIdentity, postIdentity)
      || fstatSync(documentDescriptor).size !== encoded.byteLength
      || !sameDirectoryIdentity(
        parentIdentity,
        assertOwnedDirectory(parentPath, parentDescriptor, expectedOwnerUid),
      )
    ) throw new ScenarioFailure("protected_document_write_unproven");
  } catch (error: unknown) {
    if (error instanceof ScenarioFailure) throw error;
    throw new ScenarioFailure("protected_document_write_failed");
  } finally {
    encoded.fill(0);
    observed.fill(0);
    eofProbe.fill(0);
    if (documentDescriptor !== undefined) closeSync(documentDescriptor);
    if (parentDescriptor !== undefined) closeSync(parentDescriptor);
  }
};

const createEmptyOwnedProtectedDocument = (directoryPath: string): string => {
  if (!isAbsolute(directoryPath) || resolve(directoryPath) !== directoryPath) {
    throw new ScenarioFailure("protected_document_path_invalid");
  }
  const owner = currentOwnerUid();
  const fileName = `.hra-live-login-handoff-${randomUUID()}.json`;
  let parentDescriptor: number | undefined;
  let documentDescriptor: number | undefined;
  try {
    parentDescriptor = openSync(
      directoryPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const parentIdentity = assertOwnedDirectory(directoryPath, parentDescriptor, owner);
    documentDescriptor = openChildAt(
      parentDescriptor,
      fileName,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
      0o600,
    );
    fchmodSync(documentDescriptor, 0o600);
    const documentIdentity = assertOwnedDocument(documentDescriptor, owner);
    assertChildBinding(parentDescriptor, fileName, documentIdentity, owner);
    if (
      fstatSync(documentDescriptor).size !== 0
      || !sameDirectoryIdentity(
        parentIdentity,
        assertOwnedDirectory(directoryPath, parentDescriptor, owner),
      )
    ) throw new ScenarioFailure("protected_document_file_invalid");
    return join(directoryPath, fileName);
  } catch (error: unknown) {
    if (error instanceof ScenarioFailure) throw error;
    throw new ScenarioFailure("protected_document_file_invalid");
  } finally {
    if (documentDescriptor !== undefined) closeSync(documentDescriptor);
    if (parentDescriptor !== undefined) closeSync(parentDescriptor);
  }
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

type CommandProof = Readonly<{
  command: string;
  commandDigest: string;
  verify: () => void;
}>;

const createCommandProof = (
  projectDirectory: string,
  hooks: CommandProofTestHooks = {},
): CommandProof => {
  if (!isAbsolute(projectDirectory) || resolve(projectDirectory) !== projectDirectory) {
    throw new ScenarioFailure("command_proof_directory_invalid");
  }
  let canonicalProjectDirectory: string;
  try {
    canonicalProjectDirectory = realpathSync(projectDirectory);
  } catch {
    throw new ScenarioFailure("command_proof_directory_invalid");
  }
  if (canonicalProjectDirectory !== projectDirectory) {
    throw new ScenarioFailure("command_proof_directory_invalid");
  }
  const owner = currentOwnerUid();
  const fileName = `.hra-live-command-proof-${randomUUID()}.txt`;
  let parentDescriptor: number | undefined;
  let proofDescriptor: number | undefined;
  let parentIdentity: FileIdentity;
  let proofIdentity: FileIdentity;
  try {
    parentDescriptor = openSync(
      canonicalProjectDirectory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    parentIdentity = assertOwnedDirectory(canonicalProjectDirectory, parentDescriptor, owner);
    hooks.beforeCreate?.();
    proofDescriptor = openChildAt(
      parentDescriptor,
      fileName,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(proofDescriptor, 0o600);
    proofIdentity = assertOwnedDocument(proofDescriptor, owner);
    assertChildBinding(parentDescriptor, fileName, proofIdentity, owner);
    if (!sameDirectoryIdentity(
      parentIdentity,
      assertOwnedDirectory(canonicalProjectDirectory, parentDescriptor, owner),
    )) throw new ScenarioFailure("command_proof_directory_changed");
  } catch (error: unknown) {
    if (error instanceof ScenarioFailure) throw error;
    throw new ScenarioFailure("command_proof_prepare_failed");
  } finally {
    if (proofDescriptor !== undefined) closeSync(proofDescriptor);
    if (parentDescriptor !== undefined) closeSync(parentDescriptor);
  }

  const command = `/bin/echo ${commandProofContent} | /usr/bin/tee ./${fileName}`;
  const commandDigest = safeLiveAcceptanceCommandDigest(command);
  if (commandDigest === undefined) throw new ScenarioFailure("command_proof_command_invalid");
  return {
    command,
    commandDigest,
    verify: () => {
      let directoryDescriptor: number | undefined;
      let documentDescriptor: number | undefined;
      const output = Buffer.alloc(Buffer.byteLength(commandProofContent, "utf8") + 2);
      try {
        directoryDescriptor = openSync(
          canonicalProjectDirectory,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        if (!sameDirectoryIdentity(
          parentIdentity,
          assertOwnedDirectory(canonicalProjectDirectory, directoryDescriptor, owner),
        )) throw new ScenarioFailure("command_proof_directory_changed");
        hooks.beforeVerifyOpen?.();
        documentDescriptor = openChildAt(directoryDescriptor, fileName, constants.O_RDONLY);
        if (!sameFileIdentity(
          proofIdentity,
          assertOwnedDocument(documentDescriptor, owner),
        )) throw new ScenarioFailure("command_proof_file_changed");
        const count = readSync(documentDescriptor, output, 0, output.byteLength, null);
        const eofProbe = Buffer.alloc(1);
        const extra = readSync(documentDescriptor, eofProbe, 0, 1, null);
        eofProbe.fill(0);
        if (
          output.subarray(0, count).toString("utf8") !== `${commandProofContent}\n`
          || extra !== 0
          || !sameFileIdentity(
            proofIdentity,
            assertOwnedDocument(documentDescriptor, owner),
          )
          || !sameDirectoryIdentity(
            parentIdentity,
            assertOwnedDirectory(canonicalProjectDirectory, directoryDescriptor, owner),
          )
        ) throw new ScenarioFailure("command_proof_content_invalid");
        assertChildBinding(directoryDescriptor, fileName, proofIdentity, owner);
      } catch (error: unknown) {
        if (error instanceof ScenarioFailure) throw error;
        throw new ScenarioFailure("command_proof_verify_failed");
      } finally {
        output.fill(0);
        if (documentDescriptor !== undefined) closeSync(documentDescriptor);
        if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
      }
    },
  };
};

export const liveAcceptanceScenarioTesting = Object.freeze({
  createEmptyOwnedProtectedDocument,
  createCommandProof,
  loadProtectedOutputNativeOpenAtLibrary,
  protectedOutputOpenAtLibrariesForPlatform,
  readOwnedProtectedJsonDocument,
  writeOwnedProtectedJsonDocument,
});

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ScenarioFailure(`${label}_invalid`);
  }
  return value as Record<string, unknown>;
};

const requiredString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new ScenarioFailure(`${label}_invalid`);
  }
  return value;
};

const safeDeviceUserCode = (value: unknown): string => {
  const code = requiredString(value, "device_user_code");
  if (!/^[A-Z0-9]{4,12}(?:-[A-Z0-9]{4,12}){0,2}$/u.test(code)) {
    throw new ScenarioFailure("device_user_code_invalid");
  }
  return code;
};

const safeDeviceVerificationUrl = (value: unknown): string => {
  const source = requiredString(value, "device_verification_url");
  if (/\p{Cc}|\p{Cf}/u.test(source)) {
    throw new ScenarioFailure("device_verification_url_invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    throw new ScenarioFailure("device_verification_url_invalid");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.hostname === ""
  ) throw new ScenarioFailure("device_verification_url_invalid");
  return parsed.href;
};

const deviceLoginDocumentSchema = z.object({
  accountId: z.string().min(1).max(200),
  accountLabel: z.string().min(1).max(200),
  cancelCommand: z.string().min(1).max(1_024),
  method: z.literal("device_code"),
  type: z.literal("codex_device_login"),
  userCode: z.string().min(1).max(128),
  verificationUrl: z.string().min(1).max(2_048),
  version: z.literal(1),
}).strict();

const readDeviceLoginDocument = (
  documentPath: string,
  expectedAccountId: string,
  expectedAccountLabel: string,
): Readonly<{ userCode: string; verificationUrl: string }> => {
  const document = deviceLoginDocumentSchema.parse(
    readOwnedProtectedJsonDocument(documentPath),
  );
  if (
    document.accountId !== expectedAccountId
    || document.accountLabel !== expectedAccountLabel
  ) {
    throw new ScenarioFailure("device_login_account_changed");
  }
  if (document.cancelCommand !== `hra account login-cancel ${expectedAccountId}`) {
    throw new ScenarioFailure("device_login_cancel_command_changed");
  }
  return {
    userCode: safeDeviceUserCode(document.userCode),
    verificationUrl: safeDeviceVerificationUrl(document.verificationUrl),
  };
};

const proveEmptyOwnedProtectedDocument = (documentPath: string): void => {
  if (!isAbsolute(documentPath) || resolve(documentPath) !== documentPath) {
    throw new ScenarioFailure("protected_document_path_invalid");
  }
  const parentPath = dirname(documentPath);
  const fileName = basename(documentPath);
  const owner = currentOwnerUid();
  let parentDescriptor: number | undefined;
  let documentDescriptor: number | undefined;
  try {
    parentDescriptor = openSync(
      parentPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const parentIdentity = assertOwnedDirectory(parentPath, parentDescriptor, owner);
    documentDescriptor = openChildAt(parentDescriptor, fileName, constants.O_RDWR);
    const documentIdentity = assertOwnedDocument(documentDescriptor, owner);
    assertChildBinding(parentDescriptor, fileName, documentIdentity, owner);
    if (
      fstatSync(documentDescriptor).size !== 0
      || !sameDirectoryIdentity(
        parentIdentity,
        assertOwnedDirectory(parentPath, parentDescriptor, owner),
      )
    ) throw new ScenarioFailure("protected_document_not_empty");
  } catch (error: unknown) {
    if (error instanceof ScenarioFailure) throw error;
    throw new ScenarioFailure("protected_document_file_invalid");
  } finally {
    if (documentDescriptor !== undefined) closeSync(documentDescriptor);
    if (parentDescriptor !== undefined) closeSync(parentDescriptor);
  }
};

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw new ScenarioFailure("operator_interrupted");
};

const abortable = async <T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> => {
  throwIfAborted(signal);
  return await new Promise<T>((resolvePromise, rejectPromise) => {
    const abort = () => settle(false, new ScenarioFailure("operator_interrupted"));
    const settle = (ok: boolean, value: unknown): void => {
      signal.removeEventListener("abort", abort);
      if (ok) resolvePromise(value as T);
      else rejectPromise(value);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else void operation().then(
      (value) => settle(true, value),
      (error: unknown) => settle(false, error),
    );
  });
};

const cancellableDevice = (
  device: LiveAcceptanceDevice,
  signal: AbortSignal,
): LiveAcceptanceDevice => ({
  device: device.device,
  execute: async (argv, options) => await abortable(
    async () => await device.execute(argv, options),
    signal,
  ),
  projectDirectory: device.projectDirectory,
  resume: async () => await abortable(async () => await device.resume(), signal),
  suspend: async () => await abortable(async () => await device.suspend(), signal),
});

type JsonCliEnvelope = Readonly<{
  command?: string;
  data?: unknown;
  error?: unknown;
  ok: boolean;
  version: 1;
}>;

const parseJsonCliEnvelope = (result: LiveAcceptanceCliResult): JsonCliEnvelope => {
  if (result.stderr !== "") throw new ScenarioFailure("cli_json_stderr_nonempty");
  const source = result.stdout.trim();
  if (source.length === 0 || source.includes("\n")) {
    throw new ScenarioFailure("cli_json_frame_invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new ScenarioFailure("cli_json_invalid");
  }
  const root = record(value, "cli_envelope");
  if (root.version !== 1 || typeof root.ok !== "boolean") {
    throw new ScenarioFailure("cli_envelope_invalid");
  }
  return root as JsonCliEnvelope;
};

const executeJson = async (
  device: LiveAcceptanceDevice,
  argv: readonly string[],
  options?: Readonly<{ protectedDocument?: unknown }>,
): Promise<unknown> => {
  if (!argv.includes("--json")) throw new ScenarioFailure("json_flag_missing");
  const result = await device.execute(argv, options);
  const envelope = parseJsonCliEnvelope(result);
  if (result.exitCode !== 0 || !envelope.ok || envelope.data === undefined) {
    throw new ScenarioFailure(`cli_${argv[0] ?? "unknown"}_failed`);
  }
  const expectedCommand = argv[0] === "interaction"
    && ["answer", "decide", "grant", "submit"].includes(argv[1] ?? "")
    ? "interaction.resolve"
    : `${argv[0] ?? ""}.${argv[1] ?? ""}`;
  if (envelope.command !== expectedCommand) {
    throw new ScenarioFailure("cli_command_mismatch");
  }
  return envelope.data;
};

const executeJsonFailure = async (
  device: LiveAcceptanceDevice,
  argv: readonly string[],
  expected: Readonly<{ code: "INVALID_INPUT" | "UNAVAILABLE"; exitCode?: number }>,
): Promise<void> => {
  if (!argv.includes("--json")) throw new ScenarioFailure("json_flag_missing");
  const result = await device.execute(argv);
  const envelope = parseJsonCliEnvelope(result);
  const error = envelope.error === undefined ? null : record(envelope.error, "cli_error");
  if (
    result.exitCode === 0
    || envelope.ok
    || error?.code !== expected.code
    || (expected.exitCode !== undefined && result.exitCode !== expected.exitCode)
  ) {
    throw new ScenarioFailure(`cli_${argv[0] ?? "unknown"}_unexpected_success`);
  }
};

const pollUntil = async <T>(input: Readonly<{
  deadlineMs: number;
  now: () => number;
  operation: () => Promise<T | null>;
  pollIntervalMs: number;
  signal: AbortSignal;
  sleep: (milliseconds: number) => Promise<void>;
}>): Promise<T> => {
  const deadline = input.now() + input.deadlineMs;
  for (;;) {
    throwIfAborted(input.signal);
    const result = await abortable(input.operation, input.signal);
    if (result !== null) return result;
    if (input.now() >= deadline) throw new ScenarioFailure("poll_deadline_exceeded");
    await abortable(async () => await input.sleep(input.pollIntervalMs), input.signal);
  }
};

type ProtectedAuthKind = Extract<
  LiveAcceptanceOperatorRequest["kind"],
  `${string}_auth_${string}`
>;

const protectedAuthDocumentSchema = z.object({
  email: z.string().email().min(3).max(320),
}).passthrough();

const protectedAuth = async (
  device: LiveAcceptanceDevice,
  operator: LiveAcceptanceScenarioOperator,
  kind: ProtectedAuthKind,
  prompt: string,
  signal: AbortSignal,
  expectedEmailDigest?: string,
): Promise<Readonly<{ data: unknown; emailDigest: string }>> => {
  const document = await operator.protectedDocument({ kind, prompt }, signal);
  const parsed = protectedAuthDocumentSchema.parse(document);
  const emailDigest = sha256(parsed.email.trim().toLowerCase());
  if (expectedEmailDigest !== undefined && emailDigest !== expectedEmailDigest) {
    throw new ScenarioFailure("protected_auth_identity_changed");
  }
  const data = await executeJson(
    device,
    ["auth", "login", "--input-fd", String(LIVE_ACCEPTANCE_CONTROL_FD), "--json"],
    { protectedDocument: document },
  );
  return { data, emailDigest };
};

const accountSchema = z.object({
  id: z.string().min(1).max(200),
  providerEmail: z.string().email().optional(),
  providerPlan: z.string().min(1).max(200).optional(),
  state: z.enum(["signed_out", "login_pending", "signed_in", "recovery_required", "removed"]),
}).passthrough();

const signedInSubscriptionAccountSchema = accountSchema.extend({
  providerEmail: z.string().email().min(3).max(320),
  providerPlan: z.enum(reviewedSubscriptionPlans),
  state: z.literal("signed_in"),
});

const addAccount = async (
  device: LiveAcceptanceDevice,
  label: string,
): Promise<string> => {
  const data = record(await executeJson(
    device,
    ["account", "add", label, "--json"],
  ), "account_add");
  return accountSchema.parse(data.account).id;
};

const loginAccount = async (input: Readonly<{
  accountId: string;
  accountLabel: string;
  deadlineMs: number;
  device: LiveAcceptanceDevice;
  now: () => number;
  operator: LiveAcceptanceScenarioOperator;
  pollIntervalMs: number;
  signal: AbortSignal;
  sleep: (milliseconds: number) => Promise<void>;
}>): Promise<z.infer<typeof signedInSubscriptionAccountSchema>> => {
  const handoffPath = await input.operator.prepareDeviceLoginHandoff({
    accountId: input.accountId,
    accountLabel: input.accountLabel,
    projectDirectory: input.device.projectDirectory,
  }, input.signal);
  const started = record(await executeJson(input.device, [
    "account",
    "login",
    input.accountId,
    "--device-code",
    "--handoff-file",
    handoffPath,
    "--json",
  ]), "account_login");
  const login = record(started.login, "account_login_handoff");
  if (login.status !== "pending") throw new ScenarioFailure("device_login_not_pending");
  const handoff = record(login.handoff, "account_login_handoff_file");
  if (
    handoff.status !== "written"
    || handoff.path !== handoffPath
    || handoff.documentVersion !== 1
    || handoff.disposition !== "preserved_caller_removes_after_login"
  ) throw new ScenarioFailure("device_login_handoff_unproven");
  await input.operator.acknowledgeDeviceLogin({
    accountId: input.accountId,
    accountLabel: input.accountLabel,
    documentPath: handoffPath,
  }, input.signal);
  return await pollUntil({
    deadlineMs: input.deadlineMs,
    now: input.now,
    operation: async () => {
      const shown = record(await executeJson(
        input.device,
        ["account", "show", input.accountId, "--json"],
      ), "account_show");
      const account = accountSchema.parse(shown.account);
      if (account.state === "recovery_required" || account.state === "removed") {
        throw new ScenarioFailure("account_login_recovery_required");
      }
      if (account.state !== "signed_in") return null;
      const subscriptionAccount = signedInSubscriptionAccountSchema.safeParse(shown.account);
      if (!subscriptionAccount.success) {
        throw new ScenarioFailure("provider_subscription_plan_unreviewed");
      }
      return subscriptionAccount.data;
    },
    pollIntervalMs: input.pollIntervalMs,
    signal: input.signal,
    sleep: input.sleep,
  });
};

const pairSchema = z.object({
  device: z.object({
    publicId: z.string().min(1).max(200),
    status: z.enum(["pending", "active", "revoked"]),
  }).passthrough(),
  paired: z.boolean(),
}).passthrough();

const deviceListScenarioSchema = z.object({
  currentDevicePublicId: z.string().min(1).max(200),
  devices: z.array(z.object({
    current: z.boolean(),
    online: z.boolean(),
    publicId: z.string().min(1).max(200),
    status: z.enum(["pending", "active", "revoked"]),
  }).passthrough()).min(1).max(1_024),
}).passthrough();

const projectSchema = z.object({
  id: z.string().min(1).max(200),
}).passthrough();

const addProject = async (device: LiveAcceptanceDevice): Promise<string> => {
  const data = record(await executeJson(device, [
    "project",
    "add",
    "--path",
    device.projectDirectory,
    "--name",
    `Acceptance ${device.device.toUpperCase()}`,
    "--json",
  ]), "project_add");
  return projectSchema.parse(data.project).id;
};

const startSession = async (
  device: LiveAcceptanceDevice,
  accountId: string,
  projectId: string,
): Promise<string> => {
  const data = record(await executeJson(device, [
    "session",
    "start",
    accountId,
    "--project",
    projectId,
    "--preset",
    "high",
    "--json",
  ]), "session_start");
  const session = record(data.session, "session_start_session");
  return requiredString(session.id, "session_id");
};

const sendSessionTurn = async (
  device: LiveAcceptanceDevice,
  sessionId: string,
  message: string,
): Promise<string> => {
  const data = record(await executeJson(device, [
    "session",
    "send",
    sessionId,
    message,
    "--json",
  ]), "session_send");
  const session = record(data.session, "session_send_session");
  if (session.id !== sessionId) throw new ScenarioFailure("session_send_identity_changed");
  return requiredString(data.turnId, "session_turn_id");
};

const assertObservedUsage = (value: unknown, accountId: string): Readonly<{
  observedAt: number;
  sourceRevision: number;
}> => {
  const parsed = z.object({
    usage: z.array(z.object({
      account: z.object({ id: z.literal(accountId) }).passthrough(),
      poll: z.object({
        observedAt: z.number().int().nonnegative(),
        sourceRevision: z.number().int().positive(),
        state: z.literal("observed"),
      }).passthrough(),
      snapshot: z.object({
        observedAt: z.number().int().nonnegative(),
        sourceRevision: z.number().int().positive(),
      }).passthrough(),
    }).passthrough()).length(1),
  }).passthrough().parse(value);
  const observation = parsed.usage[0];
  if (
    observation === undefined
    || observation.poll.sourceRevision !== observation.snapshot.sourceRevision
  ) throw new ScenarioFailure("account_usage_observation_invalid");
  return {
    observedAt: observation.snapshot.observedAt,
    sourceRevision: observation.snapshot.sourceRevision,
  };
};

const proveAutonomousUsagePolling = async (input: Readonly<{
  accounts: readonly [
    Readonly<{ accountId: string; baselineRevision: number }>,
    Readonly<{ accountId: string; baselineRevision: number }>,
  ];
  deadlineMs: number;
  device: LiveAcceptanceDevice;
  now: () => number;
  pollIntervalMs: number;
  signal: AbortSignal;
  sleep: (milliseconds: number) => Promise<void>;
}>): Promise<void> => {
  const deadlineAt = input.now() + input.deadlineMs;
  const advanced = new Set<string>();
  for (;;) {
    throwIfAborted(input.signal);
    if (input.now() >= deadlineAt) {
      throw new ScenarioFailure("autonomous_account_polling_unproven");
    }
    const pending = input.accounts.filter((account) => !advanced.has(account.accountId));
    const observations = await Promise.all(pending.map(async (account) => ({
      account,
      observation: assertObservedUsage(
        await executeJson(input.device, [
          "account",
          "usage",
          account.accountId,
          "--json",
        ]),
        account.accountId,
      ),
    })));
    for (const { account, observation } of observations) {
      if (observation.sourceRevision > account.baselineRevision) {
        advanced.add(account.accountId);
      }
    }
    if (advanced.size === input.accounts.length) return;
    const remainingMs = deadlineAt - input.now();
    if (remainingMs <= 0) {
      throw new ScenarioFailure("autonomous_account_polling_unproven");
    }
    await abortable(
      async () => await input.sleep(Math.min(input.pollIntervalMs, remainingMs)),
      input.signal,
    );
  }
};

const assertLocalAssistantMarker = (
  value: unknown,
  turnId: string,
  marker: string,
): void => {
  const shown = z.object({
    projection: z.object({
      messages: z.array(z.object({
        role: z.enum(["assistant", "user"]),
        text: z.string().max(64_000),
        turnId: z.string().min(1).max(512),
      }).passthrough()).max(100),
    }).passthrough(),
  }).passthrough().parse(value);
  const assistant = shown.projection.messages.filter((message) =>
    message.role === "assistant" && message.turnId === turnId);
  if (
    assistant.length === 0
    || assistant.reduce(
      (count, message) => count + markerOccurrences(message.text, marker),
      0,
    ) !== 1
  ) throw new ScenarioFailure("session_marker_missing");
};

const remoteProjectionEventSchema = z.object({
  kind: z.string().min(1).max(128),
  sequence: z.number().int().positive(),
  text: z.string().max(64_000).optional(),
  turnId: z.string().min(1).max(512).optional(),
}).passthrough();

const remoteProjectionSchema = z.object({
  compactHasRecoveryGap: z.literal(false),
  complete: z.literal(true),
  executionDevicePublicId: z.string().min(1).max(200),
  events: z.array(remoteProjectionEventSchema).max(10_000),
  publicId: z.string().min(1).max(200),
  recoveryGap: z.undefined().optional(),
}).passthrough();

const remoteProjectionEvents = (value: unknown): readonly z.infer<
  typeof remoteProjectionEventSchema
>[] => {
  const projection = remoteProjectionSchema.parse(value);
  if (projection.events.some((event, index) =>
    index > 0 && event.sequence <= (projection.events[index - 1]?.sequence ?? -1))) {
    throw new ScenarioFailure("remote_projection_unordered");
  }
  return projection.events;
};

const assertRemoteProjectionIdentity = (
  value: unknown,
  sessionId: string,
  targetDevicePublicId: string,
): void => {
  const projection = remoteProjectionSchema.parse(value);
  if (
    projection.publicId !== sessionId
    || projection.executionDevicePublicId !== targetDevicePublicId
  ) throw new ScenarioFailure("remote_projection_identity_changed");
  remoteProjectionEvents(projection);
};

const assertRemoteAssistantMarker = (
  value: unknown,
  marker: string,
  sessionId: string,
  targetDevicePublicId: string,
  turnId?: string,
): void => {
  assertRemoteProjectionIdentity(value, sessionId, targetDevicePublicId);
  const assistant = remoteProjectionEvents(value).filter((event) =>
    event.kind === "assistant_message"
    && (turnId === undefined || event.turnId === turnId));
  if (
    assistant.reduce(
      (count, event) => count + markerOccurrences(event.text ?? "", marker),
      0,
    ) !== 1
  ) throw new ScenarioFailure("remote_assistant_marker_missing");
};

const remoteCommandTurnSettled = (
  value: unknown,
  marker: string,
  sessionId: string,
  targetDevicePublicId: string,
): boolean => {
  assertRemoteProjectionIdentity(value, sessionId, targetDevicePublicId);
  const events = remoteProjectionEvents(value);
  const submitted = events.filter((event) =>
    event.kind === "user_message" && markerOccurrences(event.text ?? "", marker) === 1);
  if (submitted.length === 0) return false;
  if (submitted.length !== 1 || submitted[0]?.turnId === undefined) {
    throw new ScenarioFailure("remote_command_submission_missing");
  }
  const turnId = submitted[0].turnId;
  const assistant = events.filter((event) =>
    event.kind === "assistant_message" && event.turnId === turnId);
  const markerCount = assistant.reduce(
    (count, event) => count + markerOccurrences(event.text ?? "", marker),
    0,
  );
  if (markerCount === 0) return false;
  if (markerCount !== 1) throw new ScenarioFailure("remote_assistant_marker_missing");
  const summaries = events.filter((event) =>
    event.kind === "turn_summary" && event.turnId === turnId);
  if (summaries.length === 0) return false;
  if (summaries.length !== 1) throw new ScenarioFailure("remote_turn_terminal_ambiguous");
  const summary = summaries[0];
  if (summary === undefined) throw new ScenarioFailure("remote_turn_terminal_ambiguous");
  const assistantLastSequence = Math.max(...assistant.map((event) => event.sequence));
  if (
    submitted[0].sequence >= assistantLastSequence
    || assistantLastSequence >= summary.sequence
  ) throw new ScenarioFailure("remote_turn_terminal_unordered");
  return true;
};

const remoteCommandBindingSchema = z.object({
  commandPublicId: z.string().min(1).max(200),
  kind: z.literal("send"),
  sessionPublicId: z.string().min(1).max(200),
  state: z.enum([
    "pending",
    "prepared",
    "effect_started",
    "applied",
    "failed",
    "ambiguous",
    "cancelled",
    "expired",
  ]),
  targetDevicePublicId: z.string().min(1).max(200),
}).passthrough();

const containsPathBearingKey = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(containsPathBearingKey);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) =>
    /cwd|path|root/iu.test(key) || containsPathBearingKey(nested));
};

const assertPluginCatalog = (value: unknown, accountId: string): void => {
  const parsed = z.object({
    account: z.object({ id: z.literal(accountId), state: z.literal("signed_in") }).passthrough(),
    catalog: z.object({
      lifecycle: z.object({
        discovery: z.literal("available"),
        enablement: z.literal("no_separate_pinned_method"),
        install: z.literal("blocked_compound_upstream_effect"),
        oauth: z.literal("separate_foreground_only"),
      }).strict(),
      marketplaceLoadErrorCount: z.number().int().nonnegative().max(100),
      marketplaces: z.array(z.object({
        plugins: z.array(z.object({ id: z.string().min(1).max(512) }).passthrough()).max(5_000),
      }).passthrough()).max(100),
    }).passthrough(),
  }).passthrough().parse(value);
  if (containsPathBearingKey(parsed.catalog)) {
    throw new ScenarioFailure("plugin_catalog_path_exposed");
  }
};

const pendingInteraction = async (
  device: LiveAcceptanceDevice,
  sessionId: string,
  turnId: string,
  kind: "permission_approval" | "user_input",
): Promise<PublicInteraction | null> => {
  const data = record(await executeJson(device, [
    "interaction",
    "list",
    sessionId,
    "--pending",
    "--limit",
    "20",
    "--json",
  ]), "interaction_list");
  const values = z.array(publicInteractionSchema).max(20).parse(data.interactions);
  const candidates = values.filter((interaction) =>
    interaction.kind === kind && interaction.sessionId === sessionId);
  if (candidates.length === 0) return null;
  const interaction = candidates[0];
  if (
    candidates.length !== 1
    || interaction === undefined
    || interaction.context.turnId !== turnId
    || interaction.state !== "pending"
    || !interaction.blocking
    || interaction.responseRecorded
    || interaction.terminalAt !== null
  ) throw new ScenarioFailure("interaction_authority_changed");
  return interaction;
};

const interactionResolutionResultSchema = z.object({
  interaction: publicInteractionSchema,
  responseWritten: z.literal(true),
}).strict();

const assertInteractionResponseWritten = (
  value: unknown,
  pending: PublicInteraction,
): PublicInteraction => {
  const result = interactionResolutionResultSchema.parse(value);
  const written = result.interaction;
  if (
    written.id !== pending.id
    || written.sessionId !== pending.sessionId
    || written.kind !== pending.kind
    || written.context.turnId !== pending.context.turnId
    || written.context.itemId !== pending.context.itemId
    || written.state !== "response_written"
    || written.revision !== pending.revision + 2
    || !written.blocking
    || !written.responseRecorded
    || written.terminalAt !== null
  ) throw new ScenarioFailure("interaction_response_unproven");
  return written;
};

const resolveUserInput = async (
  device: LiveAcceptanceDevice,
  interaction: PublicInteraction,
  operator: LiveAcceptanceScenarioOperator,
  signal: AbortSignal,
): Promise<PublicInteraction> => {
  if (interaction.display.kind !== "user_input") throw new ScenarioFailure("user_input_invalid");
  const [question] = interaction.display.questions;
  if (
    !interaction.display.blocking
    || interaction.display.questions.length !== 1
    || question === undefined
    || question.id !== expectedQuestionId
    || question.allowsOther
    || question.secret
    || question.options === null
    || question.options.length !== 2
    || question.options[0]?.label !== "Continue"
    || question.options[1]?.label !== "Stop"
  ) throw new ScenarioFailure("user_input_contract_invalid");
  const context = {
    questions: interaction.display.questions.map((question) => ({
      allowsOther: question.allowsOther,
      id: question.id,
      options: question.options,
      question: question.question,
      secret: question.secret,
    })),
  };
  const document = z.object({
    answers: z.object({
      [expectedQuestionId]: z.object({
        answers: z.tuple([z.literal("Continue")]),
      }).strict(),
    }).strict(),
  }).strict().safeParse(await operator.protectedDocument({
    context,
    kind: "user_answers",
    prompt: "Provide exactly {answers:{acceptance_choice:{answers:[\"Continue\"]}}}. This fixed answer is non-secret.",
  }, signal));
  if (!document.success) throw new ScenarioFailure("user_input_response_invalid");
  const result = await executeJson(device, [
    "interaction",
    "answer",
    interaction.id,
    "--revision",
    String(interaction.revision),
    "--input-fd",
    String(LIVE_ACCEPTANCE_CONTROL_FD),
    "--json",
  ], {
    protectedDocument: document.data,
  });
  return assertInteractionResponseWritten(result, interaction);
};

const resolvePermission = async (
  device: LiveAcceptanceDevice,
  interaction: PublicInteraction,
  operator: LiveAcceptanceScenarioOperator,
  signal: AbortSignal,
): Promise<PublicInteraction> => {
  if (interaction.display.kind !== "permission_approval") {
    throw new ScenarioFailure("permission_interaction_invalid");
  }
  const requested = interaction.display.requested.map((permission) => permission.name);
  if (
    requested.length !== 1
    || requested[0] !== expectedPermissionName
    || interaction.display.summary.trim() === ""
    || interaction.display.reason === null
    || interaction.display.reason.trim() === ""
  ) throw new ScenarioFailure("permission_interaction_invalid");
  const document = z.object({
    permissions: z.tuple([z.literal(expectedPermissionName)]),
  }).strict().safeParse(await operator.protectedDocument({
    context: {
      reason: interaction.display.reason,
      requested,
      scope: "turn",
      summary: interaction.display.summary,
    },
    kind: "permission_grant",
    prompt: "Provide exactly {permissions:[\"network\"]}. This fixed turn-scoped category is non-secret.",
  }, signal));
  if (!document.success) throw new ScenarioFailure("permission_response_invalid");
  const result = await executeJson(device, [
    "interaction",
    "grant",
    interaction.id,
    "--revision",
    String(interaction.revision),
    "--scope",
    "turn",
    "--input-fd",
    String(LIVE_ACCEPTANCE_CONTROL_FD),
    "--json",
  ], {
    protectedDocument: document.data,
  });
  return assertInteractionResponseWritten(result, interaction);
};

type SessionEvidence = Readonly<{
  eventKinds: readonly string[];
}>;

type PendingSessionEventObservation = {
  readonly accountId: string;
  cursor: string | undefined;
  readonly interactionId: string;
  readonly interactionKind: "permission_approval" | "user_input";
  lastSequence: number;
  readonly observed: Map<number, SessionEvent>;
  readonly pendingRevision: number;
  readonly sessionId: string;
  readonly turnId: string;
};

const markerOccurrences = (source: string, marker: string): number => {
  let count = 0;
  let offset = 0;
  for (;;) {
    const next = source.indexOf(marker, offset);
    if (next < 0) return count;
    count += 1;
    offset = next + marker.length;
  }
};

const readNextSessionEventPage = async (input: Readonly<{
  device: LiveAcceptanceDevice;
  observation: PendingSessionEventObservation;
}>): Promise<readonly SessionEvent[]> => {
  const requestedCursor = input.observation.cursor;
  const argv = [
    "session",
    "events",
    input.observation.sessionId,
    "--limit",
    "200",
    "--wait-ms",
    "1000",
    ...(requestedCursor === undefined ? [] : ["--cursor", requestedCursor]),
    "--json",
  ];
  const page = sessionEventPageSchema.parse(await executeJson(input.device, argv));
  if (
    page.sessionId !== input.observation.sessionId
    || page.requestedCursor !== (requestedCursor ?? null)
    || page.gap !== null
  ) {
    throw new ScenarioFailure("session_event_cursor_invalid");
  }
  for (const event of page.events) {
    if (
      event.sequence !== input.observation.lastSequence + 1
      || event.sessionId !== input.observation.sessionId
      || event.accountId !== input.observation.accountId
      || event.body.type === "gap"
      || event.body.type === "error"
      || event.body.type === "protocol_incompatible"
    ) {
      throw new ScenarioFailure("session_events_unordered");
    }
    input.observation.lastSequence = event.sequence;
    input.observation.observed.set(event.sequence, event);
  }
  input.observation.cursor = page.nextCursor;
  return [...input.observation.observed.values()]
    .sort((left, right) => left.sequence - right.sequence);
};

const observePendingSessionEvidence = async (input: Readonly<{
  accountId: string;
  deadlineMs: number;
  device: LiveAcceptanceDevice;
  interaction: Readonly<{
    id: string;
    kind: "permission_approval" | "user_input";
    pendingRevision: number;
  }>;
  now: () => number;
  pollIntervalMs: number;
  sessionId: string;
  signal: AbortSignal;
  sleep: (milliseconds: number) => Promise<void>;
  turnId: string;
}>): Promise<PendingSessionEventObservation> => {
  const observation: PendingSessionEventObservation = {
    accountId: input.accountId,
    cursor: undefined,
    interactionId: input.interaction.id,
    interactionKind: input.interaction.kind,
    lastSequence: 0,
    observed: new Map<number, SessionEvent>(),
    pendingRevision: input.interaction.pendingRevision,
    sessionId: input.sessionId,
    turnId: input.turnId,
  };
  return await pollUntil({
    deadlineMs: input.deadlineMs,
    now: input.now,
    operation: async () => {
      const events = await readNextSessionEventPage({ device: input.device, observation });
      const turnEvents = events.filter((event) =>
        "turnId" in event.body && event.body.turnId === input.turnId);
      if (turnEvents.some((event) => event.body.type === "turn_completed")) {
        throw new ScenarioFailure("session_terminal_before_interaction_resolution");
      }
      const requested = events.filter((event) => {
        const body = event.body;
        return body.type === "interaction_requested"
          && body.interactionId === input.interaction.id;
      });
      const requestedBody = requested[0]?.body;
      const turnStart = turnEvents.filter((event) => event.body.type === "turn_started");
      if (requested.length === 0) return null;
      if (
        requested.length !== 1
        || requestedBody?.type !== "interaction_requested"
        || requestedBody.interactionKind !== input.interaction.kind
        || !requestedBody.blocking
        || requestedBody.revision !== input.interaction.pendingRevision
        || turnStart.length !== 1
        || turnStart[0] === undefined
        || requested[0] === undefined
        || turnStart[0].sequence >= requested[0].sequence
      ) throw new ScenarioFailure("session_pending_interaction_evidence_invalid");
      const authority = turnStart[0];
      if (
        authority.providerConnectionId === null
        || requested.some((event) =>
          event.streamEpoch !== authority.streamEpoch
          || event.providerGeneration !== authority.providerGeneration
          || event.providerConnectionId !== authority.providerConnectionId)
      ) throw new ScenarioFailure("session_event_authority_changed");
      return observation;
    },
    pollIntervalMs: input.pollIntervalMs,
    signal: input.signal,
    sleep: input.sleep,
  });
};

const collectSettledSessionEvidence = async (input: Readonly<{
  accountId: string;
  commandProof: CommandProof;
  deadlineMs: number;
  device: LiveAcceptanceDevice;
  marker: string;
  now: () => number;
  observation: PendingSessionEventObservation;
  pollIntervalMs: number;
  interaction: Readonly<{
    id: string;
    itemId: string | null;
    kind: "permission_approval" | "user_input";
    pendingRevision: number;
    writtenRevision: number;
  }>;
  sessionId: string;
  signal: AbortSignal;
  sleep: (milliseconds: number) => Promise<void>;
  turnId: string;
}>): Promise<SessionEvidence> => {
  if (
    input.observation.accountId !== input.accountId
    || input.observation.interactionId !== input.interaction.id
    || input.observation.interactionKind !== input.interaction.kind
    || input.observation.pendingRevision !== input.interaction.pendingRevision
    || input.observation.sessionId !== input.sessionId
    || input.observation.turnId !== input.turnId
  ) throw new ScenarioFailure("session_pending_observation_identity_changed");
  return await pollUntil({
    deadlineMs: input.deadlineMs,
    now: input.now,
    operation: async () => {
      const events = await readNextSessionEventPage({
        device: input.device,
        observation: input.observation,
      });
      const turnEvents = events.filter((event) =>
        "turnId" in event.body && event.body.turnId === input.turnId);
      const terminalEvents = turnEvents.filter((event) => event.body.type === "turn_completed");
      if (terminalEvents.length === 0) return null;
      const terminalEvent = terminalEvents[0];
      if (
        terminalEvents.length !== 1
        || terminalEvent === undefined
        || terminalEvent.body.type !== "turn_completed"
        || terminalEvent.body.status !== "completed"
        || terminalEvent.sequence !== turnEvents.at(-1)?.sequence
      ) throw new ScenarioFailure("session_terminal_invalid");
      const turnStarts = turnEvents.filter((event) => event.body.type === "turn_started");
      if (
        turnStarts.length !== 1
        || turnStarts[0]?.sequence !== turnEvents[0]?.sequence
      ) throw new ScenarioFailure("session_turn_start_invalid");

      const interactionRequested = events.filter((event) => {
        const body = event.body;
        return body.type === "interaction_requested"
          && body.interactionId === input.interaction.id;
      });
      const interactionPrepared = events.filter((event) => {
        const body = event.body;
        return body.type === "interaction_state"
          && body.interactionId === input.interaction.id
          && body.state === "response_prepared";
      });
      const interactionWritten = events.filter((event) => {
        const body = event.body;
        return body.type === "interaction_state"
          && body.interactionId === input.interaction.id
          && body.state === "response_written";
      });
      const requestedBody = interactionRequested[0]?.body;
      const preparedBody = interactionPrepared[0]?.body;
      const writtenBody = interactionWritten[0]?.body;
      const turnStart = turnStarts[0];
      const requestedEvent = interactionRequested[0];
      const preparedEvent = interactionPrepared[0];
      const writtenEvent = interactionWritten[0];
      if (
        interactionRequested.length !== 1
        || interactionPrepared.length !== 1
        || interactionWritten.length !== 1
        || requestedBody?.type !== "interaction_requested"
        || requestedBody.interactionKind !== input.interaction.kind
        || !requestedBody.blocking
        || requestedBody.revision !== input.interaction.pendingRevision
        || preparedBody?.type !== "interaction_state"
        || preparedBody.revision !== input.interaction.pendingRevision + 1
        || writtenBody?.type !== "interaction_state"
        || writtenBody.revision !== input.interaction.writtenRevision
        || turnStart === undefined
        || requestedEvent === undefined
        || preparedEvent === undefined
        || writtenEvent === undefined
      ) throw new ScenarioFailure("session_interaction_evidence_incomplete");
      if (
        turnStart.sequence >= requestedEvent.sequence
        || requestedEvent.sequence >= preparedEvent.sequence
        || preparedEvent.sequence >= writtenEvent.sequence
        || writtenEvent.sequence >= terminalEvent.sequence
      ) throw new ScenarioFailure("session_interaction_evidence_incomplete");

      const authority = turnEvents[0];
      const authorityEvents = [
        ...turnEvents,
        ...interactionRequested,
        ...interactionPrepared,
        ...interactionWritten,
      ];
      if (
        authority === undefined
        || authority.providerConnectionId === null
        || authorityEvents.some((event) =>
          event.streamEpoch !== authority.streamEpoch
          || event.providerGeneration !== authority.providerGeneration
          || event.providerConnectionId !== authority.providerConnectionId)
      ) throw new ScenarioFailure("session_event_authority_changed");

      const reasoning = turnEvents.some((event) =>
        event.body.type === "reasoning_summary_delta" && event.body.text.length > 0);
      const commandStarts = turnEvents.filter((event) =>
        event.body.type === "item_started" && event.body.itemKind === "commandExecution");
      const commandStart = commandStarts[0];
      const commandItemId = commandStart?.body.type === "item_started"
        ? commandStart.body.itemId
        : undefined;
      const commandProgress = turnEvents.filter((event) => {
        const body = event.body;
        return body.type === "tool_progress"
          && body.itemId === commandItemId
          && body.toolKind === "command";
      });
      const commandCompletions = turnEvents.filter((event) => {
        const body = event.body;
        return body.type === "item_completed"
          && body.itemId === commandItemId
          && body.itemKind === "commandExecution";
      });
      const commandCompleted = commandCompletions[0];
      const nonemptyCommandProgress = commandProgress.filter((event) =>
        event.body.type === "tool_progress"
          && (event.body.outputBytesObserved ?? 0) > 0);
      const benignItemKinds = new Set([
        "agentMessage",
        "contextCompaction",
        "enteredReviewMode",
        "exitedReviewMode",
        "hookPrompt",
        "plan",
        "reasoning",
        "userMessage",
      ]);
      const unrelatedSideEffectItems = turnEvents.filter((event) => {
        const body = event.body;
        if (body.type !== "item_started" && body.type !== "item_completed") return false;
        if (body.itemId === commandItemId && body.itemKind === "commandExecution") return false;
        if (
          body.itemId === input.interaction.itemId
          && input.interaction.kind === "user_input"
          && body.itemKind === "dynamicToolCall"
        ) return false;
        return !benignItemKinds.has(body.itemKind);
      });
      const unrelatedToolProgress = turnEvents.filter((event) =>
        event.body.type === "tool_progress"
          && (event.body.itemId !== commandItemId || event.body.toolKind !== "command"));
      const unrelatedFileChanges = turnEvents.filter((event) => event.body.type === "file_change");
      const assistantText = turnEvents
        .filter((event): event is SessionEvent & { body: Extract<SessionEvent["body"], { type: "assistant_delta" }> } =>
          event.body.type === "assistant_delta")
        .map((event) => event.body.text)
        .join("");
      if (
        !reasoning
        || commandStarts.length !== 1
        || commandStart === undefined
        || commandStart.body.type !== "item_started"
        || commandStart.body.liveAcceptanceCommandDigest !== input.commandProof.commandDigest
        || nonemptyCommandProgress.length === 0
        || commandCompletions.length !== 1
        || commandCompleted === undefined
        || commandCompleted.body.type !== "item_completed"
        || commandCompleted.body.liveAcceptanceCommandDigest
          !== input.commandProof.commandDigest
        || commandCompleted.body.status !== "completed"
        || writtenEvent.sequence >= commandStart.sequence
        || commandProgress.some((event) =>
          event.sequence <= commandStart.sequence
            || event.sequence >= commandCompleted.sequence)
        || commandCompleted.sequence >= terminalEvent.sequence
        || unrelatedSideEffectItems.length !== 0
        || unrelatedToolProgress.length !== 0
        || unrelatedFileChanges.length !== 0
        || markerOccurrences(assistantText, input.marker) !== 1
      ) {
        throw new ScenarioFailure("session_stream_evidence_incomplete");
      }
      input.commandProof.verify();
      const eventKinds = [...new Set(authorityEvents.map((event) => event.body.type))].sort();
      return { eventKinds };
    },
    pollIntervalMs: input.pollIntervalMs,
    signal: input.signal,
    sleep: input.sleep,
  });
};

const assertDeviceAListAuthority = (
  list: z.infer<typeof deviceListScenarioSchema>,
  deviceAPublicId: string,
  deviceBPublicId: string,
): z.infer<typeof deviceListScenarioSchema>["devices"][number] => {
  if (deviceAPublicId === deviceBPublicId) {
    throw new ScenarioFailure("device_identity_ambiguous");
  }
  const current = list.devices.filter((device) => device.current);
  const distinctPublicIds = new Set(list.devices.map((device) => device.publicId));
  const deviceA = list.devices.filter((device) => device.publicId === deviceAPublicId);
  const deviceB = list.devices.filter((device) => device.publicId === deviceBPublicId);
  const currentDevice = current[0];
  const deviceARow = deviceA[0];
  const deviceBRow = deviceB[0];
  if (
    list.currentDevicePublicId !== deviceAPublicId
    || list.devices.length !== 2
    || distinctPublicIds.size !== list.devices.length
    || current.length !== 1
    || currentDevice === undefined
    || currentDevice.publicId !== deviceAPublicId
    || currentDevice.status !== "active"
    || deviceA.length !== 1
    || deviceARow?.current !== true
    || deviceB.length !== 1
    || deviceBRow?.current !== false
  ) throw new ScenarioFailure("device_list_authority_changed");
  return deviceBRow;
};

export async function runLiveAcceptanceScenario(
  run: ScenarioRun,
  operator: LiveAcceptanceScenarioOperator,
  attestationInput: LiveAcceptanceScenarioAttestation,
  timing: ScenarioTiming = {},
): Promise<LiveAcceptanceEvidence> {
  const attestation = scenarioAttestationSchema.parse(attestationInput);
  const now = timing.now ?? Date.now;
  const sleep = timing.sleep ?? (async (milliseconds: number) => { await Bun.sleep(milliseconds); });
  const prepareCommandProof = timing.prepareCommandProof ?? createCommandProof;
  const pollIntervalMs = timing.pollIntervalMs ?? defaultPollIntervalMs;
  const signal = timing.signal ?? new AbortController().signal;
  throwIfAborted(signal);
  const startedAt = now();
  const deviceA = cancellableDevice(run.device("a"), signal);
  const deviceB = cancellableDevice(run.device("b"), signal);

  await operator.progress("projects");
  const [projectA] = await Promise.all([addProject(deviceA), addProject(deviceB)]);

  await operator.progress("device_a_auth");
  const identityA = await protectedAuth(
    deviceA,
    operator,
    "device_a_auth_invite",
    "Provide exactly {email,invite} for the one-time candidate identity invite.",
    signal,
  );
  await protectedAuth(
    deviceA,
    operator,
    "device_a_auth_code",
    "Provide exactly {email,code} for device A's email verification.",
    signal,
    identityA.emailDigest,
  );
  const pairA = pairSchema.parse(await executeJson(deviceA, ["device", "pair", "--json"]));
  if (!pairA.paired || pairA.device.status !== "active") {
    throw new ScenarioFailure("device_a_pairing_failed");
  }

  await operator.progress("codex_accounts");
  const accountA = await addAccount(deviceA, "Acceptance Primary");
  const signedInA = await loginAccount({
    accountId: accountA,
    accountLabel: "Acceptance Primary",
    deadlineMs: timing.accountLoginDeadlineMs ?? accountLoginDeadlineMs,
    device: deviceA,
    now,
    operator,
    pollIntervalMs,
    signal,
    sleep,
  });
  const accountB = await addAccount(deviceA, "Acceptance Secondary");
  const signedInB = await loginAccount({
    accountId: accountB,
    accountLabel: "Acceptance Secondary",
    deadlineMs: timing.accountLoginDeadlineMs ?? accountLoginDeadlineMs,
    device: deviceA,
    now,
    operator,
    pollIntervalMs,
    signal,
    sleep,
  });
  const providerEmailA = signedInA.providerEmail;
  const providerEmailB = signedInB.providerEmail;
  if (providerEmailA.trim().toLowerCase() === providerEmailB.trim().toLowerCase()) {
    throw new ScenarioFailure("provider_identities_not_distinct");
  }
  const [usageA, usageB] = await Promise.all([
    executeJson(deviceA, ["account", "usage", accountA, "--refresh", "--json"]),
    executeJson(deviceA, ["account", "usage", accountB, "--refresh", "--json"]),
  ]);
  const usageBaselineA = assertObservedUsage(usageA, accountA);
  const usageBaselineB = assertObservedUsage(usageB, accountB);
  await operator.progress("autonomous_account_polling");
  await proveAutonomousUsagePolling({
    accounts: [
      { accountId: accountA, baselineRevision: usageBaselineA.sourceRevision },
      { accountId: accountB, baselineRevision: usageBaselineB.sourceRevision },
    ],
    deadlineMs: timing.autonomousUsageProofDeadlineMs
      ?? autonomousUsageProofDeadlineMs,
    device: deviceA,
    now,
    pollIntervalMs,
    signal,
    sleep,
  });

  await operator.progress("device_b_pending");
  await protectedAuth(
    deviceB,
    operator,
    "device_b_auth_email",
    "Provide exactly {email} for the same candidate identity on device B.",
    signal,
    identityA.emailDigest,
  );
  await protectedAuth(
    deviceB,
    operator,
    "device_b_auth_code",
    "Provide exactly {email,code} for device B's email verification.",
    signal,
    identityA.emailDigest,
  );
  const pendingPairB = pairSchema.parse(await executeJson(deviceB, ["device", "pair", "--json"]));
  const deviceBPublicId = pendingPairB.device.publicId;
  await run.bindExpectedRevokedPeer(deviceBPublicId);
  throwIfAborted(signal);
  if (pendingPairB.paired || pendingPairB.device.status !== "pending") {
    throw new ScenarioFailure("device_b_not_pending");
  }
  const listedPending = deviceListScenarioSchema.parse(await executeJson(
    deviceA,
    ["device", "list", "--json"],
  ));
  if (assertDeviceAListAuthority(
    listedPending,
    pairA.device.publicId,
    deviceBPublicId,
  ).status !== "pending") {
    throw new ScenarioFailure("device_b_pending_not_visible");
  }
  await executeJsonFailure(deviceB, ["sync", "now", "--json"], { code: "UNAVAILABLE" });
  await executeJsonFailure(
    deviceB,
    ["remote", "list", "--limit", "10", "--json"],
    { code: "UNAVAILABLE" },
  );
  await executeJsonFailure(deviceB, [
    "remote",
    "send",
    `missing-${randomUUID()}`,
    "pending devices cannot submit remote commands",
    "--json",
  ], { code: "UNAVAILABLE" });

  await operator.progress("device_b_approval");
  const approved = record(await executeJson(
    deviceA,
    ["device", "approve", deviceBPublicId, "--json"],
  ), "device_approve");
  const approvedDevice = record(approved.device, "approved_device");
  if (approvedDevice.publicId !== deviceBPublicId || approvedDevice.status !== "active") {
    throw new ScenarioFailure("device_b_approval_failed");
  }
  const activePairB = pairSchema.parse(await executeJson(deviceB, ["device", "pair", "--json"]));
  if (!activePairB.paired || activePairB.device.publicId !== deviceBPublicId || activePairB.device.status !== "active") {
    throw new ScenarioFailure("device_b_pairing_failed");
  }

  await operator.progress("sessions_and_interactions");
  const sessionA = await startSession(deviceA, accountA, projectA);
  const sessionB = await startSession(deviceA, accountB, projectA);
  const commandProofA = prepareCommandProof(deviceA.projectDirectory);
  const commandProofB = prepareCommandProof(deviceA.projectDirectory);
  const markerA = `hra-live-user-input-${randomUUID()}`;
  const markerB = `hra-live-permission-${randomUUID()}`;
  const turnA = await sendSessionTurn(
    deviceA,
    sessionA,
    `Acceptance marker ${markerA}. Call request_user_input with exactly one blocking, non-secret question whose ID is acceptance_choice and exactly two options in this order: Continue and Stop. Wait for the answer, run exactly ${commandProofA.command} with the shell tool, briefly summarize your reasoning, then reply with the marker exactly once.`,
  );
  const userInput = await pollUntil({
    deadlineMs: timing.turnDeadlineMs ?? turnDeadlineMs,
    now,
    operation: async () => await pendingInteraction(deviceA, sessionA, turnA, "user_input"),
    pollIntervalMs,
    signal,
    sleep,
  });
  const pendingObservationA = await observePendingSessionEvidence({
    accountId: accountA,
    deadlineMs: timing.turnDeadlineMs ?? turnDeadlineMs,
    device: deviceA,
    interaction: {
      id: userInput.id,
      kind: "user_input",
      pendingRevision: userInput.revision,
    },
    now,
    pollIntervalMs,
    sessionId: sessionA,
    signal,
    sleep,
    turnId: turnA,
  });
  const writtenUserInput = await resolveUserInput(deviceA, userInput, operator, signal);
  const sessionEvidencePromiseA = collectSettledSessionEvidence({
    accountId: accountA,
    commandProof: commandProofA,
    deadlineMs: timing.turnDeadlineMs ?? turnDeadlineMs,
    device: deviceA,
    interaction: {
      id: userInput.id,
      itemId: userInput.context.itemId,
      kind: "user_input",
      pendingRevision: userInput.revision,
      writtenRevision: writtenUserInput.revision,
    },
    marker: markerA,
    now,
    observation: pendingObservationA,
    pollIntervalMs,
    sessionId: sessionA,
    signal,
    sleep,
    turnId: turnA,
  });
  void sessionEvidencePromiseA.catch(() => undefined);

  const turnB = await sendSessionTurn(
    deviceA,
    sessionB,
    `Acceptance marker ${markerB}. Use the explicit permission-request mechanism to request exactly the network category for this turn before running a command. Wait for the grant, run exactly ${commandProofB.command} with the shell tool, briefly summarize your reasoning, then reply with the marker exactly once.`,
  );
  const permission = await pollUntil({
    deadlineMs: timing.turnDeadlineMs ?? turnDeadlineMs,
    now,
    operation: async () => await pendingInteraction(
      deviceA,
      sessionB,
      turnB,
      "permission_approval",
    ),
    pollIntervalMs,
    signal,
    sleep,
  });
  const pendingObservationB = await observePendingSessionEvidence({
    accountId: accountB,
    deadlineMs: timing.turnDeadlineMs ?? turnDeadlineMs,
    device: deviceA,
    interaction: {
      id: permission.id,
      kind: "permission_approval",
      pendingRevision: permission.revision,
    },
    now,
    pollIntervalMs,
    sessionId: sessionB,
    signal,
    sleep,
    turnId: turnB,
  });
  const writtenPermission = await resolvePermission(deviceA, permission, operator, signal);
  const sessionEvidencePromiseB = collectSettledSessionEvidence({
    accountId: accountB,
    commandProof: commandProofB,
    deadlineMs: timing.turnDeadlineMs ?? turnDeadlineMs,
    device: deviceA,
    interaction: {
      id: permission.id,
      itemId: permission.context.itemId,
      kind: "permission_approval",
      pendingRevision: permission.revision,
      writtenRevision: writtenPermission.revision,
    },
    marker: markerB,
    now,
    observation: pendingObservationB,
    pollIntervalMs,
    sessionId: sessionB,
    signal,
    sleep,
    turnId: turnB,
  });
  void sessionEvidencePromiseB.catch(() => undefined);

  const [sessionEvidenceA, sessionEvidenceB] = await Promise.all([
    sessionEvidencePromiseA,
    sessionEvidencePromiseB,
  ]);
  const [shownA, shownB] = await Promise.all([
    executeJson(deviceA, ["session", "show", sessionA, "--detail", "--json"]),
    executeJson(deviceA, ["session", "show", sessionB, "--detail", "--json"]),
  ]);
  assertLocalAssistantMarker(shownA, turnA, markerA);
  assertLocalAssistantMarker(shownB, turnB, markerB);

  const pluginCatalog = await executeJson(deviceA, [
    "plugin",
    "list",
    accountA,
    "--project",
    projectA,
    "--refresh",
    "--json",
  ]);
  assertPluginCatalog(pluginCatalog, accountA);
  for (const action of ["auth", "disable", "enable", "install"] as const) {
    await executeJsonFailure(
      deviceA,
      ["plugin", action, "acceptance-probe", "--json"],
      { code: "INVALID_INPUT", exitCode: 2 },
    );
  }

  await operator.progress("sync_and_remote");
  await executeJson(deviceA, ["sync", "now", "--json"]);
  await executeJson(deviceB, ["sync", "now", "--json"]);
  const remoteHeads = record(await executeJson(
    deviceB,
    ["remote", "list", "--limit", "50", "--json"],
  ), "remote_list");
  const heads = z.array(z.object({
    executionDevicePublicId: z.string().min(1).max(200),
    publicId: z.string().min(1).max(200),
  }).passthrough()).max(50).parse(remoteHeads.sessions);
  const exactHeads = [sessionA, sessionB].map((sessionId) =>
    heads.filter((head) => head.publicId === sessionId));
  if (exactHeads.some((matches) =>
    matches.length !== 1 || matches[0]?.executionDevicePublicId !== pairA.device.publicId)) {
    throw new ScenarioFailure("remote_sessions_missing");
  }
  const remoteProjection = await executeJson(
    deviceB,
    ["remote", "show", sessionA, "--json"],
  );
  assertRemoteAssistantMarker(
    remoteProjection,
    markerA,
    sessionA,
    pairA.device.publicId,
    turnA,
  );
  const remoteMarker = `hra-live-remote-${randomUUID()}`;
  const remoteReceipt = remoteCommandBindingSchema.parse(await executeJson(deviceB, [
    "remote",
    "send",
    sessionA,
    `Reply with ${remoteMarker} exactly once.`,
    "--json",
  ]));
  const commandPublicId = remoteReceipt.commandPublicId;
  if (
    remoteReceipt.state !== "pending"
    || remoteReceipt.sessionPublicId !== sessionA
    || remoteReceipt.targetDevicePublicId !== pairA.device.publicId
  ) throw new ScenarioFailure("remote_receipt_invalid");
  const terminalRemote = await pollUntil({
    deadlineMs: timing.remoteCommandDeadlineMs ?? remoteCommandDeadlineMs,
    now,
    operation: async () => {
      const status = remoteCommandBindingSchema.parse(await executeJson(
        deviceB,
        ["remote", "command", commandPublicId, "--json"],
      ));
      if (
        status.commandPublicId !== commandPublicId
        || status.sessionPublicId !== sessionA
        || status.targetDevicePublicId !== pairA.device.publicId
      ) throw new ScenarioFailure("remote_command_binding_changed");
      if (status.state === "failed" || status.state === "ambiguous" || status.state === "expired" || status.state === "cancelled") {
        throw new ScenarioFailure("remote_command_failed");
      }
      return status.state === "applied" ? status : null;
    },
    pollIntervalMs,
    signal,
    sleep,
  });
  if (
    terminalRemote.resultCode !== "APPLIED"
    || terminalRemote.state !== "applied"
  ) throw new ScenarioFailure("remote_result_invalid");
  await pollUntil({
    deadlineMs: timing.remoteCommandDeadlineMs ?? remoteCommandDeadlineMs,
    now,
    operation: async () => {
      await executeJson(deviceA, ["sync", "now", "--json"]);
      await executeJson(deviceB, ["sync", "now", "--json"]);
      const remoteAfter = await executeJson(
        deviceB,
        ["remote", "show", sessionA, "--json"],
      );
      return remoteCommandTurnSettled(
        remoteAfter,
        remoteMarker,
        sessionA,
        pairA.device.publicId,
      ) ? true : null;
    },
    pollIntervalMs,
    signal,
    sleep,
  });

  await operator.progress("presence_and_revocation");
  const onlineBefore = deviceListScenarioSchema.parse(await executeJson(
    deviceA,
    ["device", "list", "--json"],
  ));
  if (!assertDeviceAListAuthority(
    onlineBefore,
    pairA.device.publicId,
    deviceBPublicId,
  ).online) {
    throw new ScenarioFailure("device_b_not_online_before_suspend");
  }
  await deviceB.suspend();
  await abortable(async () => await sleep(presenceOfflineBoundaryMs + (
    timing.presenceObservationMarginMs ?? presenceObservationMarginMs
  )), signal);
  const offline = deviceListScenarioSchema.parse(await executeJson(
    deviceA,
    ["device", "list", "--json"],
  ));
  if (assertDeviceAListAuthority(
    offline,
    pairA.device.publicId,
    deviceBPublicId,
  ).online) {
    throw new ScenarioFailure("device_b_offline_boundary_failed");
  }
  await deviceB.resume();
  await pollUntil({
    deadlineMs: 60_000,
    now,
    operation: async () => {
      const list = deviceListScenarioSchema.parse(await executeJson(
        deviceA,
        ["device", "list", "--json"],
      ));
      return assertDeviceAListAuthority(
        list,
        pairA.device.publicId,
        deviceBPublicId,
      ).online ? true : null;
    },
    pollIntervalMs,
    signal,
    sleep,
  });
  const revoked = record(await executeJson(
    deviceA,
    ["device", "revoke", deviceBPublicId, "--json"],
  ), "device_revoke");
  const revokedDevice = record(revoked.device, "revoked_device");
  if (revokedDevice.publicId !== deviceBPublicId || revokedDevice.status !== "revoked") {
    throw new ScenarioFailure("device_b_revocation_failed");
  }
  await executeJsonFailure(deviceB, ["sync", "now", "--json"], { code: "UNAVAILABLE" });
  await executeJsonFailure(
    deviceB,
    ["remote", "show", sessionA, "--json"],
    { code: "UNAVAILABLE" },
  );
  await executeJsonFailure(deviceB, [
    "remote",
    "send",
    sessionA,
    "revoked devices cannot submit remote commands",
    "--json",
  ], { code: "UNAVAILABLE" });
  await abortable(async () => await sleep(presenceOfflineBoundaryMs + (
    timing.presenceObservationMarginMs ?? presenceObservationMarginMs
  )), signal);
  const revokedOffline = deviceListScenarioSchema.parse(await executeJson(
    deviceA,
    ["device", "list", "--json"],
  ));
  const provenRevoked = assertDeviceAListAuthority(
    revokedOffline,
    pairA.device.publicId,
    deviceBPublicId,
  );
  if (provenRevoked.status !== "revoked" || provenRevoked.online) {
    throw new ScenarioFailure("device_b_revoked_presence_unproven");
  }

  await operator.progress("cleanup");
  await run.cleanup({ signal });
  return liveAcceptanceEvidenceSchema.parse({
    accountIds: [accountA, accountB],
    cloudTargetDigest: attestation.cloudTargetDigest,
    completedAt: now(),
    devicePublicIds: [pairA.device.publicId, deviceBPublicId],
    eventKinds: {
      [sessionA]: sessionEvidenceA.eventKinds,
      [sessionB]: sessionEvidenceB.eventKinds,
    },
    markerDigests: [sha256(markerA), sha256(markerB), sha256(remoteMarker)],
    packageVersion: attestation.packageVersion,
    pluginLifecycleEffectsRejected: ["auth", "disable", "enable", "install"],
    pluginInstallRejected: true,
    presence: ["online", "offline", "online"],
    providerIdentitiesDistinct: true,
    remoteCommand: { resultCode: "APPLIED", state: "applied" },
    runId: run.runId,
    sessionIds: [sessionA, sessionB],
    sourceRevision: attestation.sourceRevision,
    startedAt,
    status: "passed",
    version: 1,
  });
}

export function readLiveAcceptanceScenarioConfigurationFromFd(
  fd: number,
): LiveAcceptanceScenarioConfiguration {
  if (!Number.isSafeInteger(fd) || fd < 3 || fd > 255 || isatty(fd)) {
    throw new ScenarioFailure("scenario_descriptor_invalid");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const remaining = scenarioConfigurationMaximumBytes + 1 - total;
      if (remaining <= 0) throw new ScenarioFailure("scenario_descriptor_invalid");
      const chunk = Buffer.allocUnsafe(Math.min(4 * 1024, remaining));
      const count = readSync(fd, chunk, 0, chunk.byteLength, null);
      if (count === 0) {
        chunk.fill(0);
        break;
      }
      chunks.push(chunk.subarray(0, count));
      total += count;
      if (total > scenarioConfigurationMaximumBytes) {
        throw new ScenarioFailure("scenario_descriptor_invalid");
      }
    }
    if (total === 0) throw new ScenarioFailure("scenario_descriptor_invalid");
    const bytes = Buffer.concat(chunks, total);
    try {
      return liveAcceptanceScenarioConfigurationSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
      );
    } finally {
      bytes.fill(0);
    }
  } catch (error: unknown) {
    if (error instanceof ScenarioFailure) throw error;
    throw new ScenarioFailure("scenario_descriptor_invalid");
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

const hiddenTerminalDocument = async (
  prompt: string,
  signal: AbortSignal,
): Promise<unknown> => {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new ScenarioFailure("terminal_operator_unavailable");
  }
  const sink = new WritableStream({
    write(_chunk, _encoding, callback) { callback(); },
  });
  const terminal = createInterface({
    historySize: 0,
    input: process.stdin,
    output: sink,
    terminal: true,
  });
  process.stderr.write(`${prompt}\nProtected JSON (hidden): `);
  try {
    const source = await abortable(
      async () => await terminal.question("", { signal }),
      signal,
    );
    const bytes = Buffer.from(source, "utf8");
    try {
      if (bytes.byteLength === 0 || bytes.byteLength > operatorFrameMaximumBytes) {
        throw new ScenarioFailure("operator_response_invalid");
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } finally {
      bytes.fill(0);
    }
  } catch (error: unknown) {
    if (error instanceof ScenarioFailure) throw error;
    throw new ScenarioFailure("operator_response_invalid");
  } finally {
    terminal.close();
    sink.destroy();
    process.stderr.write("\n");
  }
};

export class TerminalLiveAcceptanceOperator implements LiveAcceptanceScenarioOperator {
  async acknowledgeDeviceLogin(input: Readonly<{
    accountId: string;
    accountLabel: string;
    documentPath: string;
  }>, signal: AbortSignal): Promise<void> {
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      throw new ScenarioFailure("terminal_operator_unavailable");
    }
    const document = readDeviceLoginDocument(
      input.documentPath,
      input.accountId,
      input.accountLabel,
    );
    process.stderr.write([
      `Complete Codex device login for ${input.accountLabel}.`,
      `URL: ${document.verificationUrl}`,
      `Code: ${document.userCode}`,
      "Press Enter only after the provider confirms completion: ",
    ].join("\n"));
    const terminal = createInterface({
      historySize: 0,
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });
    try {
      await abortable(async () => await terminal.question("", { signal }), signal);
    } finally {
      terminal.close();
    }
  }

  prepareDeviceLoginHandoff(input: Readonly<{
    accountId: string;
    accountLabel: string;
    projectDirectory: string;
  }>): Promise<string> {
    void input.accountId;
    void input.accountLabel;
    return Promise.resolve(createEmptyOwnedProtectedDocument(input.projectDirectory));
  }

  async progress(step: string): Promise<void> {
    process.stderr.write(`hra live acceptance: ${step}\n`);
  }

  async protectedDocument(
    request: LiveAcceptanceOperatorRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    const context = request.context === undefined
      ? ""
      : `\nContext: ${JSON.stringify(request.context)}`;
    return await hiddenTerminalDocument(`${request.prompt}${context}`, signal);
  }
}

const operatorResponseSchema = z.union([
  z.object({
    document: z.unknown(),
    requestId: z.string().uuid(),
    type: z.literal("protected_input"),
    version: z.literal(1),
  }).strict(),
  z.object({
    documentPath: z.string().min(1).max(4_096),
    requestId: z.string().uuid(),
    type: z.literal("protected_input_file"),
    version: z.literal(1),
  }).strict(),
  z.object({
    documentPath: z.string().min(1).max(4_096),
    requestId: z.string().uuid(),
    type: z.literal("device_login_handoff_file"),
    version: z.literal(1),
  }).strict(),
  z.object({
    acknowledged: z.literal(true),
    requestId: z.string().uuid(),
    type: z.literal("device_login"),
    version: z.literal(1),
  }).strict(),
]);

class JsonlFrameReader {
  readonly #stream: Readable;
  #buffer = Buffer.alloc(0);
  #closed = false;
  #iterator: AsyncIterator<unknown>;

  constructor() {
    if (isatty(operatorInputFd)) throw new ScenarioFailure("operator_descriptor_invalid");
    this.#stream = process.stdin;
    this.#iterator = this.#stream[Symbol.asyncIterator]();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#buffer.fill(0);
    this.#buffer = Buffer.alloc(0);
    this.#stream.destroy();
    const returned = this.#iterator.return?.();
    if (returned !== undefined) void returned.catch(() => undefined);
  }

  async read(
    signal: AbortSignal,
    maximumBytes: number = operatorFrameMaximumBytes,
  ): Promise<unknown> {
    try {
      for (;;) {
        if (this.#closed) throw new ScenarioFailure("operator_closed");
        const newline = this.#buffer.indexOf(0x0a);
        if (newline >= 0) {
          if (newline === 0 || newline + 1 > maximumBytes) {
            throw new ScenarioFailure("operator_response_invalid");
          }
          const line = this.#buffer.subarray(0, newline);
          this.#buffer = this.#buffer.subarray(newline + 1);
          try {
            return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)) as unknown;
          } catch {
            throw new ScenarioFailure("operator_response_invalid");
          } finally {
            line.fill(0);
          }
        }
        if (this.#buffer.byteLength >= maximumBytes) {
          throw new ScenarioFailure("operator_response_invalid");
        }
        const next = await abortable(async () => await this.#iterator.next(), signal);
        if (next.done) throw new ScenarioFailure("operator_closed");
        const chunk = Buffer.isBuffer(next.value)
          ? next.value
          : Buffer.from(next.value as Uint8Array);
        const prior = this.#buffer;
        if (chunk.byteLength > operatorFrameMaximumBytes - prior.byteLength) {
          prior.fill(0);
          chunk.fill(0);
          this.#buffer = Buffer.alloc(0);
          throw new ScenarioFailure("operator_response_invalid");
        }
        this.#buffer = Buffer.concat([prior, chunk]);
        prior.fill(0);
        chunk.fill(0);
      }
    } catch (error: unknown) {
      if (signal.aborted) this.close();
      throw error;
    }
  }
}

const writeFrame = async (
  stream: Writable,
  value: unknown,
  signal?: AbortSignal,
): Promise<void> => {
  const frame = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(frame, "utf8") > operatorFrameMaximumBytes) {
    throw new ScenarioFailure("operator_request_invalid");
  }
  const write = async (): Promise<void> => {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      stream.write(frame, (error) => {
        if (error === undefined || error === null) resolvePromise();
        else rejectPromise(error);
      });
    });
  };
  if (signal === undefined) await write();
  else await abortable(write, signal);
};

export class JsonlLiveAcceptanceOperator implements LiveAcceptanceScenarioOperator {
  readonly #input: JsonlFrameReader;
  readonly #output: Writable;
  #outputTail = Promise.resolve();

  constructor() {
    if (isatty(operatorInputFd) || isatty(operatorOutputFd)) {
      throw new ScenarioFailure("operator_descriptor_invalid");
    }
    this.#input = new JsonlFrameReader();
    this.#output = process.stdout;
  }

  close(): void {
    this.#input.close();
  }

  async flush(): Promise<void> {
    await this.#outputTail;
  }

  #write(value: unknown, signal?: AbortSignal): Promise<void> {
    const operation = this.#outputTail.then(
      async () => await writeFrame(this.#output, value, signal),
    );
    const guarded = operation.catch((error: unknown) => {
      this.close();
      throw error;
    });
    this.#outputTail = guarded;
    void guarded.catch(() => undefined);
    return guarded;
  }

  async readConfiguration(signal: AbortSignal): Promise<LiveAcceptanceScenarioConfiguration> {
    try {
      const configuration = liveAcceptanceScenarioConfigurationSchema.parse(
        await this.#input.read(signal, scenarioConfigurationMaximumBytes),
      );
      if (configuration.operator.kind !== "jsonl") {
        throw new ScenarioFailure("operator_descriptor_invalid");
      }
      return configuration;
    } catch (error: unknown) {
      this.close();
      throw error;
    }
  }

  async acknowledgeDeviceLogin(input: Readonly<{
    accountId: string;
    accountLabel: string;
    documentPath: string;
  }>, signal: AbortSignal): Promise<void> {
    try {
      readDeviceLoginDocument(input.documentPath, input.accountId, input.accountLabel);
      const requestId = randomUUID();
      await this.#write({
        accountId: input.accountId,
        accountLabel: input.accountLabel,
        documentFileDisposition: "hra_preserves_caller_removes_after_final_result",
        handoffDocumentPath: input.documentPath,
        requestId,
        responseMode: "fixed_nonsecret_acknowledgement",
        type: "device_login_required",
        version: 1,
      }, signal);
      const response = operatorResponseSchema.parse(await this.#input.read(signal));
      if (
        response.type !== "device_login"
        || response.requestId !== requestId
      ) throw new ScenarioFailure("operator_response_invalid");
    } catch (error: unknown) {
      this.close();
      throw error;
    }
  }

  async prepareDeviceLoginHandoff(input: Readonly<{
    accountId: string;
    accountLabel: string;
    projectDirectory: string;
  }>, signal: AbortSignal): Promise<string> {
    void input.projectDirectory;
    const requestId = randomUUID();
    try {
      await this.#write({
        accountId: input.accountId,
        accountLabel: input.accountLabel,
        documentFileDisposition: "hra_preserves_caller_removes_after_final_result",
        requestId,
        responseMode: "absolute_canonical_owned_mode_0600_empty_file",
        type: "device_login_handoff_file_required",
        version: 1,
      }, signal);
      const response = operatorResponseSchema.parse(await this.#input.read(signal));
      if (
        response.type !== "device_login_handoff_file"
        || response.requestId !== requestId
      ) throw new ScenarioFailure("operator_response_invalid");
      proveEmptyOwnedProtectedDocument(response.documentPath);
      return response.documentPath;
    } catch (error: unknown) {
      this.close();
      throw error;
    }
  }

  async progress(step: string): Promise<void> {
    await this.#write({
      step,
      type: "progress",
      version: 1,
    });
  }

  async protectedDocument(
    request: LiveAcceptanceOperatorRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    const requestId = randomUUID();
    const fileRequired = request.kind === "device_a_auth_invite"
      || request.kind === "device_a_auth_code"
      || request.kind === "device_b_auth_email"
      || request.kind === "device_b_auth_code";
    try {
      await this.#write({
        ...(request.context === undefined ? {} : { context: request.context }),
        ...(fileRequired
          ? {
              documentFileDisposition: "hra_preserves_caller_removes_after_final_result",
              responseMode: "absolute_canonical_owned_mode_0600_json_file",
            }
          : { responseMode: "inline_fixed_nonsecret" }),
        kind: request.kind,
        prompt: request.prompt,
        requestId,
        type: "protected_input_required",
        version: 1,
      }, signal);
      const response = operatorResponseSchema.parse(await this.#input.read(signal));
      if (response.requestId !== requestId) {
        throw new ScenarioFailure("operator_response_invalid");
      }
      if (fileRequired) {
        if (response.type !== "protected_input_file") {
          throw new ScenarioFailure("operator_response_invalid");
        }
        return readOwnedProtectedJsonDocument(response.documentPath);
      }
      if (response.type !== "protected_input") {
        throw new ScenarioFailure("operator_response_invalid");
      }
      return response.document;
    } catch (error: unknown) {
      this.close();
      throw error;
    }
  }
}

export function createLiveAcceptanceScenarioOperator(
  configuration: LiveAcceptanceScenarioConfiguration,
): LiveAcceptanceScenarioOperator {
  return configuration.operator.kind === "terminal"
    ? new TerminalLiveAcceptanceOperator()
    : new JsonlLiveAcceptanceOperator();
}

export async function createStandardJsonlLiveAcceptanceScenario(
  signal: AbortSignal,
): Promise<Readonly<{
  configuration: LiveAcceptanceScenarioConfiguration;
  operator: JsonlLiveAcceptanceOperator;
}>> {
  const operator = new JsonlLiveAcceptanceOperator();
  const configuration = await operator.readConfiguration(signal);
  return { configuration, operator };
}

export const liveAcceptanceScenarioPresenceOfflineBoundaryMs = presenceOfflineBoundaryMs;

export const liveAcceptanceScenarioDeviceNames = ["a", "b"] as const satisfies readonly LiveAcceptanceDeviceName[];
