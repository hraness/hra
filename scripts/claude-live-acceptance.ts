#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  fstatSync,
  lstatSync,
  readSync,
} from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isatty } from "node:tty";

import { z } from "zod";

import {
  allowlistedEnvironment,
  claudeSessionArgv,
  resolvePinnedClaudeRuntime,
  withClaudeHostToolRuntime,
  CLAUDE_PIN,
  type ClaudeLoginSignalSource,
} from "../src/claude/index";
import { main as cliMain } from "../src/cli";
import type { Output } from "../src/cli/render";
import {
  protectedInteractionDetailDocumentSchema,
  publicInteractionSchema,
  type PublicInteraction,
} from "../src/domain/interactions";
import { hraMemoryRememberInputSchema, type HraMemoryRememberInput } from "../src/domain/host-tools";
import { publicSessionListItemSchema } from "../src/domain/contracts";
import { publicEffectiveClaudeRuntimeProfileSchema } from "../src/domain/runtime-profile";
import {
  profileIdSchema,
  projectIdSchema,
  sessionIdSchema,
} from "../src/domain/values";
import { DEFAULT_CLOUD_DEPLOYMENT_URL } from "../src/cloud/identity-custody";
import { profilePaths, resolveStatePaths } from "../src/storage/paths";
import { HRA_VERSION } from "../src/version";
import {
  createClaudeLiveAcceptanceLogout,
  createClaudeLiveAcceptanceCleanupStoppedCustody,
  parseClaudeLiveAcceptanceLogoutAttemptMarker,
  parseClaudeLiveAcceptanceLogoutPreflightReceipt,
  type ClaudeLiveAcceptanceLogoutController,
} from "./claude-live-acceptance-logout";
import {
  createClaudeLiveAcceptanceReadback,
  type ClaudeLiveAcceptanceReadback,
  type ClaudeLiveAcceptanceProcessInspectionInput,
} from "./claude-live-acceptance-readback";
import type {
  ClaudeLiveAcceptancePrivateReceipt,
  ClaudeLiveAcceptanceProvisionalPrivateReceipt,
} from "./claude-live-acceptance-proof";
import { ClaudeLiveAcceptanceProofError } from "./claude-live-acceptance-proof";
import {
  recoverBoundedProcessJournal,
} from "./bounded-process";
import {
  acceptanceInstallationDescriptorSchema,
  createAcceptanceInstallation,
  type AcceptanceInstallationDescriptor,
  type LiveAcceptanceCandidate,
} from "./live-acceptance-installation";
import {
  liveAcceptanceCliResultSchema,
  liveAcceptanceSourceAttestation,
  proveLiveAcceptanceStoppedInstallation,
  startClaudeLiveAcceptanceProcessWorker,
  LIVE_ACCEPTANCE_CONTROL_FD,
  type ClaudeLiveAcceptanceWorker,
  type LiveAcceptanceCliResult,
} from "./live-acceptance";
import {
  assertPrivateDirectoryIdentity,
  AtomicPrivateJsonReceipt,
  createPrivateTemporaryDirectory,
  isPrivateDirectChild,
  observePrivateDirectory,
  privatePathExists,
  privatePathsOverlap,
  syncPrivateDirectory,
  type PrivateDirectoryIdentity,
} from "./live-acceptance-private-custody";
import {
  canonicalDigest,
  withSelfDigest,
  writeProtectedJsonNoReplace,
  writeProtectedJsonToFd,
} from "./release-evidence";
import { runLiveAcceptanceAuthorityCommand } from "./live-acceptance-authority-process";
import {
  acquireClaudeLiveAcceptanceOwner,
  type ClaudeLiveAcceptanceOwner,
} from "./claude-live-acceptance-owner";
import { verifyClaudeLiveAcceptanceConsumption } from "./claude-live-acceptance-consumption";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const normalizedPathSchema = z.string().min(1).max(4_096)
  .refine((value) => isAbsolute(value) && resolve(value) === value);
const directoryIdentitySchema = z.object({
  device: z.number().int().nonnegative().safe(),
  inode: z.number().int().positive().safe(),
  mode: z.literal(0o700),
  owner: z.number().int().nonnegative().safe(),
  path: normalizedPathSchema,
}).strict();
const resourceSchema = z.object({
  identity: directoryIdentitySchema,
  quarantinePath: normalizedPathSchema.optional(),
  state: z.enum(["active", "quarantine_planned", "quarantined", "deleted"]),
}).strict();
const candidateSchema = z.object({
  cloudTargetDigest: digestSchema,
  packageVersion: z.literal(HRA_VERSION),
  sourceRevision: z.string().regex(/^[0-9a-f]{40}$/u),
}).strict();
const parsedUnknown = <T>(parse: (value: unknown) => T): z.ZodType<T> =>
  z.unknown().transform((value, context): T | typeof z.NEVER => {
    try {
      return parse(value);
    } catch {
      context.addIssue({ code: "custom", message: "private_receipt_invalid" });
      return z.NEVER;
    }
  });
const logoutPreflightSchema = parsedUnknown(parseClaudeLiveAcceptanceLogoutPreflightReceipt);
const logoutAttemptSchema = parsedUnknown(parseClaudeLiveAcceptanceLogoutAttemptMarker);

const checkpointSchema = z.enum([
  "prepared",
  "worker_starting",
  "worker_ready",
  "logout_preflight",
  "account_created",
  "login_started",
  "login_joined",
  "project_created",
  "session_started",
  "proof_armed",
  "send_started",
  "live_proved",
  "worker_stopped",
  "stopped_proved",
  "logout_attempted",
  "signed_out",
  "cleanup_authorized",
  "quarantined",
  "recovery_required",
]);

const cleanupAuthorizationBaseSchema = z.object({
  authentication: z.enum(["not_started", "signed_out"]),
  candidateBindingDigest: digestSchema,
  createdAt: z.number().int().nonnegative().safe(),
  preflightBindingDigest: digestSchema.optional(),
  profileGeneration: z.number().int().positive().safe().optional(),
  profileId: profileIdSchema.optional(),
  readbackSnapshotDigest: digestSchema.optional(),
  runId: z.string().uuid(),
  scopeBindingDigest: digestSchema.optional(),
  sessionId: sessionIdSchema.optional(),
  version: z.literal(1),
  workerPid: z.number().int().positive().safe().optional(),
}).strict();
const cleanupAuthorizationSchema = cleanupAuthorizationBaseSchema.extend({
  bindingDigest: digestSchema,
}).strict().superRefine((value, context) => {
  const { bindingDigest, ...base } = value;
  if (canonicalDigest({
    ...base,
    domain: "hra.claude.live-acceptance.cleanup-authorization.v1",
  }) !== bindingDigest) {
    context.addIssue({ code: "custom", path: ["bindingDigest"], message: "digest_invalid" });
  }
  if (value.profileId === undefined) {
    if (
      value.authentication !== "not_started"
      || value.preflightBindingDigest !== undefined
      || value.profileGeneration !== undefined
      || value.readbackSnapshotDigest !== undefined
      || value.scopeBindingDigest !== undefined
      || value.sessionId !== undefined
    ) context.addIssue({ code: "custom", message: "pre_account_scope_invalid" });
    return;
  }
  if (value.readbackSnapshotDigest === undefined || value.scopeBindingDigest === undefined) {
    context.addIssue({ code: "custom", message: "profile_scope_incomplete" });
  }
  if ((value.sessionId === undefined) !== (value.profileGeneration === undefined)) {
    context.addIssue({ code: "custom", message: "session_scope_incomplete" });
  }
  if (
    (value.preflightBindingDigest === undefined && value.authentication !== "not_started")
    || (value.preflightBindingDigest !== undefined && value.authentication !== "signed_out")
  ) context.addIssue({ code: "custom", message: "authentication_scope_invalid" });
});
type CleanupAuthorization = z.infer<typeof cleanupAuthorizationSchema>;

export const claudeLiveAcceptanceRecoveryReceiptSchema = z.object({
  accountLabel: z.string().regex(/^hra-claude-live-[0-9a-f]{12}$/u),
  candidate: candidateSchema,
  checkpoint: checkpointSchema,
  cleanupAuthorization: cleanupAuthorizationSchema.optional(),
  createdAt: z.number().int().nonnegative().safe(),
  expectedHomeDirectory: normalizedPathSchema,
  failureCode: z.enum([
    "input_invalid",
    "login_unproven",
    "proof_unavailable",
    "shutdown_unproven",
    "cleanup_unproven",
    "operator_interrupted",
  ]).optional(),
  loginIdempotencyKey: z.string().uuid(),
  logoutAttempt: logoutAttemptSchema.optional(),
  logoutPreflight: logoutPreflightSchema.optional(),
  profileGeneration: z.number().int().positive().safe().optional(),
  profileId: profileIdSchema.optional(),
  projectId: projectIdSchema.optional(),
  projectLabel: z.string().regex(/^hra-claude-live-[0-9a-f]{12}$/u),
  project: resourceSchema,
  receiptPath: normalizedPathSchema,
  runId: z.string().uuid(),
  runRoot: directoryIdentitySchema,
  sendIdempotencyKey: z.string().uuid(),
  sessionId: sessionIdSchema.optional(),
  startIdempotencyKey: z.string().uuid(),
  state: resourceSchema,
  updatedAt: z.number().int().nonnegative().safe(),
  version: z.literal(1),
  worker: z.object({
    pid: z.number().int().positive().safe().optional(),
    state: z.enum(["absent", "starting", "ready", "stopped"]),
  }).strict(),
}).strict().superRefine((value, context) => {
  const issue = (path: (string | number)[], message: string): void => {
    context.addIssue({ code: "custom", path, message });
  };
  if (value.worker.state === "absent" && value.worker.pid !== undefined) {
    issue(["worker", "pid"], "An absent worker cannot carry a process identity.");
  }
  if ((value.worker.state === "ready" || value.worker.state === "stopped")
    && value.worker.pid === undefined) {
    issue(["worker", "pid"], "A ready or stopped worker requires its exact process identity.");
  }
  if (value.logoutAttempt !== undefined && value.logoutPreflight === undefined) {
    issue(["logoutAttempt"], "A logout attempt requires its exact preflight receipt.");
  }
  if (value.logoutPreflight !== undefined) {
    if (
      value.profileId === undefined
      || value.logoutPreflight.profileId !== value.profileId
      || value.logoutPreflight.runId !== value.runId
      || canonicalDigest(value.logoutPreflight.candidate) !== canonicalDigest(value.candidate)
    ) issue(["logoutPreflight"], "Logout preflight scope does not match this run.");
    if (
      value.logoutAttempt !== undefined
      && value.logoutAttempt.preflightBindingDigest !== value.logoutPreflight.bindingDigest
    ) issue(["logoutAttempt"], "Logout attempt scope does not match its preflight.");
  }
  if (value.sessionId !== undefined && (
    value.profileId === undefined
    || value.profileGeneration === undefined
    || value.projectId === undefined
  )) issue(["sessionId"], "A staged session requires its profile generation and project.");
  if (value.profileGeneration !== undefined && value.sessionId === undefined) {
    issue(["profileGeneration"], "A staged profile generation requires its exact session.");
  }
  if (value.projectId !== undefined && value.profileId === undefined) {
    issue(["projectId"], "A staged project requires its exact profile.");
  }
  const cleanup = value.cleanupAuthorization;
  if (cleanup !== undefined && (
    (value.worker.state !== "stopped" && value.worker.state !== "absent")
    || (value.worker.state === "absent" && value.profileId !== undefined)
    || cleanup.candidateBindingDigest !== canonicalDigest(value.candidate)
    || cleanup.runId !== value.runId
    || cleanup.workerPid !== value.worker.pid
    || cleanup.profileId !== value.profileId
    || cleanup.profileGeneration !== value.profileGeneration
    || cleanup.sessionId !== value.sessionId
    || cleanup.scopeBindingDigest !== (
      value.profileId === undefined
        ? undefined
        : canonicalDigest({
            domain: "hra.claude.cleanup-readback.v1",
            profileId: value.profileId,
            profileGeneration: value.profileGeneration ?? null,
            sessionId: value.sessionId ?? null,
          })
    )
    || cleanup.preflightBindingDigest !== value.logoutPreflight?.bindingDigest
  )) issue(["cleanupAuthorization"], "Cleanup authorization scope does not match this run.");
});

export type ClaudeLiveAcceptanceRecoveryReceipt = z.infer<
  typeof claudeLiveAcceptanceRecoveryReceiptSchema
>;

export class ClaudeLiveAcceptanceError extends Error {
  constructor(readonly code: "input_invalid" | "login_unproven" | "proof_unavailable" |
  "shutdown_unproven" | "cleanup_unproven" | "operator_interrupted",
  readonly recoveryReceiptPath?: string,
  options?: ErrorOptions) {
    super(`claude_live_acceptance_${code}`, options);
    this.name = "ClaudeLiveAcceptanceError";
  }
}

const readbackLiveSchema = z.object({
  version: z.literal(1),
  phase: z.literal("live"),
  source: z.literal("independent_private_readback"),
  snapshotDigest: digestSchema,
  proofBindingDigest: digestSchema,
  nativeStart: z.literal(true), directSend: z.literal(true), soleRemember: z.literal(true),
  workingPage: z.literal(true), managedClaudeSignedIn: z.literal(true),
  processBound: z.literal(true), hostBinding: z.literal(true), pinnedProcessArgv: z.literal(true),
  processArgvDigest: digestSchema,
}).strict();
const readbackStoppedSchema = readbackLiveSchema.extend({
  phase: z.literal("stopped"), processReleased: z.literal(true), processNotLive: z.literal(true),
  privateArtifactsAbsent: z.literal(true), lifecycleInvalidated: z.literal(true),
}).strict();
const logoutEvidenceSchema = z.object({
  helpSha256: digestSchema,
  logoutDispatched: z.boolean(),
  recovered: z.boolean(),
  signedOut: z.literal(true),
  version: z.literal(CLAUDE_PIN),
}).strict();
const memoryEvidenceSchema = z.object({
  operationSha256: digestSchema,
  receiptSha256: digestSchema,
  recordSha256: digestSchema,
  submissionIdSha256: digestSchema,
}).strict();

const claudeLiveAcceptanceEvidenceBaseSchema = z.object({
  candidate: candidateSchema,
  completedAt: z.string().datetime({ offset: true }),
  kind: z.literal("claude-live-acceptance"),
  logout: logoutEvidenceSchema,
  memory: memoryEvidenceSchema,
  permission: z.object({
    exactTool: z.literal("mcp__hra__memory_remember"),
    responseWritten: z.literal(true),
    scope: z.literal("turn"),
  }).strict(),
  providerConsumption: z.object({
    exactReceiptEcho: z.literal(true),
    echoSha256: digestSchema,
  }).strict(),
  readbackLive: readbackLiveSchema,
  readbackStopped: readbackStoppedSchema,
  runId: z.string().uuid(),
  schemaVersion: z.literal(1),
  startedAt: z.string().datetime({ offset: true }),
  status: z.literal("passed"),
  worker: z.object({
    daemonJoined: z.literal(true),
    separateSignalDomain: z.literal(true),
    workerNotLive: z.literal(true),
  }).strict(),
}).strict();

export const claudeLiveAcceptanceEvidenceSchema = claudeLiveAcceptanceEvidenceBaseSchema.extend({
  selfDigest: digestSchema,
}).strict().superRefine((value, context) => {
  const { selfDigest, ...base } = value;
  if (canonicalDigest(base) !== selfDigest) {
    context.addIssue({ code: "custom", message: "self_digest_invalid" });
  }
});

export type ClaudeLiveAcceptanceEvidence = z.infer<typeof claudeLiveAcceptanceEvidenceSchema>;

type ClaudeLayout = Readonly<{
  descriptor: AcceptanceInstallationDescriptor;
  project: PrivateDirectoryIdentity;
  receiptPath: string;
  runRoot: PrivateDirectoryIdentity;
  state: PrivateDirectoryIdentity;
}>;

const invalid = (code: ClaudeLiveAcceptanceError["code"] = "input_invalid") =>
  new ClaudeLiveAcceptanceError(code);

export const assertClaudeLiveAcceptanceLayout = async (
  receipt: ClaudeLiveAcceptanceRecoveryReceipt,
): Promise<void> => {
  if (
    process.env.HOME !== receipt.expectedHomeDirectory
    || homedir() !== receipt.expectedHomeDirectory
    || dirname(receipt.receiptPath) !== dirname(receipt.runRoot.path)
    || basename(receipt.receiptPath) !== `.hra-live-claude-acceptance-${receipt.runId}.recovery.json`
    || !basename(receipt.runRoot.path).startsWith(`hra-live-acceptance-${receipt.runId}-`)
    || !isPrivateDirectChild(receipt.runRoot.path, receipt.state.identity.path)
    || !isPrivateDirectChild(receipt.runRoot.path, receipt.project.identity.path)
    || receipt.state.identity.path === receipt.project.identity.path
    || privatePathsOverlap(receipt.runRoot.path, receipt.expectedHomeDirectory)
    || privatePathsOverlap(receipt.runRoot.path, resolveStatePaths().root)
  ) throw invalid();
  const resourcesDeleted = [receipt.state, receipt.project]
    .every((resource) => resource.state === "deleted");
  const runRootExists = await privatePathExists(receipt.runRoot.path);
  if (runRootExists) await assertPrivateDirectoryIdentity(receipt.runRoot, invalid);
  else if (!resourcesDeleted) throw invalid();
  for (const resource of [receipt.state, receipt.project]) {
    const quarantinePath = resource.quarantinePath;
    if ((resource.state === "active") !== (quarantinePath === undefined)) throw invalid();
    if (
      quarantinePath !== undefined
      && (
        !isPrivateDirectChild(receipt.runRoot.path, quarantinePath)
        || !basename(quarantinePath).startsWith(".hra-claude-quarantine-")
      )
    ) throw invalid();
    const sourceExists = await privatePathExists(resource.identity.path);
    const quarantineExists = quarantinePath === undefined
      ? false
      : await privatePathExists(quarantinePath);
    if (resource.state === "active") {
      if (!sourceExists || quarantineExists) throw invalid();
      await assertPrivateDirectoryIdentity(resource.identity, invalid);
      continue;
    }
    if (resource.state === "quarantine_planned") {
      if (sourceExists === quarantineExists) throw invalid();
      await assertPrivateDirectoryIdentity(
        sourceExists
          ? resource.identity
          : { ...resource.identity, path: quarantinePath ?? "" },
        invalid,
      );
      continue;
    }
    if (resource.state === "quarantined") {
      if (sourceExists || quarantinePath === undefined) throw invalid();
      // A crash after removing the exact quarantine inode but before persisting
      // `deleted` is a recoverable, deletion-completed transition.
      if (quarantineExists) {
        await assertPrivateDirectoryIdentity({ ...resource.identity, path: quarantinePath }, invalid);
      }
      continue;
    }
    if (sourceExists || quarantineExists) throw invalid();
  }
};

export const claudeLiveAcceptanceRecoveryPolicy = {
  assertRuntime: assertClaudeLiveAcceptanceLayout,
  createdIdentityMatches: (
    current: ClaudeLiveAcceptanceRecoveryReceipt,
    next: ClaudeLiveAcceptanceRecoveryReceipt,
  ): boolean => current.runId === next.runId
    && current.receiptPath === next.receiptPath
    && canonicalDigest(current.candidate) === canonicalDigest(next.candidate)
    && current.runRoot.device === next.runRoot.device
    && current.runRoot.inode === next.runRoot.inode,
  invalid,
  maximumBytes: 64 * 1024,
  parse: (value: unknown) => claudeLiveAcceptanceRecoveryReceiptSchema.parse(value),
  path: (value: ClaudeLiveAcceptanceRecoveryReceipt) => value.receiptPath,
};

async function createLayout(candidate: LiveAcceptanceCandidate): Promise<ClaudeLayout> {
  const expectedHomeDirectory = process.env.HOME;
  if (
    expectedHomeDirectory === undefined
    || expectedHomeDirectory !== homedir()
    || !isAbsolute(expectedHomeDirectory)
  ) throw invalid();
  const base = await realpath(tmpdir());
  if (
    privatePathsOverlap(base, expectedHomeDirectory)
    || privatePathsOverlap(base, resolveStatePaths().root)
  ) throw invalid();
  const runId = randomUUID();
  const runRoot = await createPrivateTemporaryDirectory(
    join(base, `hra-live-acceptance-${runId}-`),
    invalid,
  );
  let state: PrivateDirectoryIdentity | undefined;
  let project: PrivateDirectoryIdentity | undefined;
  try {
    state = await createPrivateTemporaryDirectory(join(runRoot.path, "device-a-"), invalid);
    project = await createPrivateTemporaryDirectory(join(runRoot.path, "project-a-"), invalid);
    const descriptor = acceptanceInstallationDescriptorSchema.parse({
      candidate,
      device: "a",
      documentsDirectory: project.path,
      expectedHomeDirectory,
      rootDirectory: state.path,
      runId,
      type: "hra-live-acceptance-device",
      version: 1,
    });
    return {
      descriptor,
      project,
      receiptPath: join(base, `.hra-live-claude-acceptance-${runId}.recovery.json`),
      runRoot,
      state,
    };
  } catch (error: unknown) {
    try {
      for (const identity of [project, state]) {
        if (identity === undefined) continue;
        await assertPrivateDirectoryIdentity(identity, invalid);
        if ((await readdir(identity.path)).length !== 0) throw invalid("cleanup_unproven");
        await rmdir(identity.path);
      }
      await assertPrivateDirectoryIdentity(runRoot, invalid);
      if ((await readdir(runRoot.path)).length !== 0) throw invalid("cleanup_unproven");
      await rmdir(runRoot.path);
      await syncPrivateDirectory(dirname(runRoot.path));
    } catch (cleanupError: unknown) {
      throw new ClaudeLiveAcceptanceError("cleanup_unproven", undefined, {
        cause: cleanupError,
      });
    }
    throw error;
  }
}

const initialReceipt = (
  layout: ClaudeLayout,
  now: number,
): ClaudeLiveAcceptanceRecoveryReceipt => claudeLiveAcceptanceRecoveryReceiptSchema.parse({
  accountLabel: `hra-claude-live-${layout.descriptor.runId.replaceAll("-", "").slice(0, 12)}`,
  candidate: layout.descriptor.candidate,
  checkpoint: "prepared",
  createdAt: now,
  expectedHomeDirectory: layout.descriptor.expectedHomeDirectory,
  loginIdempotencyKey: randomUUID(),
  project: { identity: layout.project, state: "active" },
  projectLabel: `hra-claude-live-${layout.descriptor.runId.replaceAll("-", "").slice(-12)}`,
  receiptPath: layout.receiptPath,
  runId: layout.descriptor.runId,
  runRoot: layout.runRoot,
  sendIdempotencyKey: randomUUID(),
  startIdempotencyKey: randomUUID(),
  state: { identity: layout.state, state: "active" },
  updatedAt: now,
  version: 1,
  worker: { state: "absent" },
});

type JsonEnvelope = Readonly<{ command: string; data: unknown; ok: true; version: 1 }>;

const parseJsonResult = (resultInput: LiveAcceptanceCliResult, command: string): unknown => {
  const result = liveAcceptanceCliResultSchema.parse(resultInput);
  if (result.exitCode !== 0 || result.stderr !== "" || result.stdout.trim().includes("\n")) {
    throw invalid("proof_unavailable");
  }
  let source: unknown;
  try {
    source = JSON.parse(result.stdout) as unknown;
  } catch {
    throw invalid("proof_unavailable");
  }
  const envelope = z.object({
    command: z.literal(command),
    data: z.unknown(),
    ok: z.literal(true),
    version: z.literal(1),
  }).strict().parse(source) satisfies JsonEnvelope;
  return envelope.data;
};

const executeJson = async (
  worker: ClaudeLiveAcceptanceWorker,
  argv: readonly string[],
  command: string,
  protectedDocument?: unknown,
): Promise<unknown> => parseJsonResult(
  await worker.execute(argv, protectedDocument === undefined ? {} : { protectedDocument }),
  command,
);

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

export function parseClaudeLiveAcceptanceProcessArgvBytes(
  bytes: Uint8Array,
): readonly string[] {
  if (bytes.byteLength < 2 || bytes.byteLength > 64 * 1024 || bytes.at(-1) !== 0) {
    throw invalid();
  }
  const values = new TextDecoder("utf-8", { fatal: true })
    .decode(bytes.subarray(0, bytes.byteLength - 1))
    .split("\0");
  if (values.some((value) => value.length === 0 || /\p{Cc}|\p{Cs}/u.test(value))) throw invalid();
  return Object.freeze(values);
}

async function readExactProcessArgv(pid: number): Promise<readonly string[]> {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid < 1) throw invalid();
  const path = `/proc/${String(pid)}/cmdline`;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const bytes = Buffer.alloc(64 * 1024 + 1);
  try {
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    return parseClaudeLiveAcceptanceProcessArgvBytes(bytes.subarray(0, length));
  } finally {
    bytes.fill(0);
    await handle.close();
  }
}

export async function inspectClaudeLiveAcceptanceProcess(
  pathsRoot: string,
  input: ClaudeLiveAcceptanceProcessInspectionInput,
  signal: AbortSignal,
): Promise<Readonly<{ pinnedArgv: true; argvDigest: string }>> {
  if (input.identity.pidDomain !== "linux" || signal.aborted) throw invalid();
  const paths = resolveStatePaths({ rootDirectory: pathsRoot });
  const profile = profilePaths(paths, input.profileId);
  const configDir = profile.claudeConfigDir;
  const probeTemporaryDirectory = join(profile.root, "claude-logout-tmp");
  const environment = allowlistedEnvironment(process.env);
  environment.HOME = homedir();
  environment.LANG = "C";
  environment.LC_ALL = "C";
  environment.CLAUDE_CONFIG_DIR = configDir;
  environment.TMPDIR = probeTemporaryDirectory;
  environment.NO_COLOR = "1";
  const executable = await realpath(`/proc/${String(input.identity.pid)}/exe`);
  const runtime = await resolvePinnedClaudeRuntime({
    configDir,
    executablePath: executable,
    environment,
    probeVersion: async ({ executablePath }) => {
      const result = await runLiveAcceptanceAuthorityCommand({
        arguments: ["--version"],
        containment: "authority",
        cwd: configDir,
        environment,
        executable: executablePath,
        outputMaximumBytes: 16 * 1024,
        phase: "claude-live-acceptance-process-version",
        stdin: "",
        timeoutMs: 5_000,
      });
      if (result.exitCode !== 0 || result.stderr !== "") throw invalid("proof_unavailable");
      return result.stdout;
    },
    signal,
    versionProbeDeadlineMs: 5_000,
  });
  const expected = claudeSessionArgv(
    withClaudeHostToolRuntime(runtime, { mcpConfigPath: input.configPath }),
    { kind: "create", providerThreadId: input.providerThreadId },
  );
  const actual = await readExactProcessArgv(input.identity.pid);
  if (
    actual.length !== expected.length
    || actual.some((value, index) => value !== expected[index])
  ) throw invalid("proof_unavailable");
  return Object.freeze({
    argvDigest: canonicalDigest({ argv: actual, domain: "hra-live-acceptance-claude-argv-v1" }),
    pinnedArgv: true as const,
  });
}

const publicAccountSchema = z.object({
  id: profileIdSchema,
  label: z.string().min(1).max(160),
  processGeneration: z.number().int().nonnegative().safe(),
  state: z.enum(["signed_out", "login_pending", "signed_in", "recovery_required", "removed"]),
  updatedAt: z.number().int().nonnegative().safe(),
  providerEmail: z.string().email().optional(),
  providerPlan: z.string().min(1).max(200).optional(),
}).strict();
const accountAddSchema = z.object({
  account: publicAccountSchema,
  next: z.string().min(1).max(512),
}).strict();
const claudeAccountStatusSchema = z.object({
  account: z.object({
    id: profileIdSchema,
    label: z.string().min(1).max(160),
  }).strict(),
  authentication: z.object({
    provider: z.literal("claude"),
    signedIn: z.literal(true),
  }).strict(),
  providerGeneration: z.number().int().nonnegative().safe(),
}).strict();
const projectAddSchema = z.object({
  project: z.object({ id: projectIdSchema }).passthrough(),
}).strict();
const publicSessionSchema = publicSessionListItemSchema.extend({
  activeTurnId: z.string().min(1).max(512).optional(),
}).strict();
const sessionStartSchema = z.object({
  effectiveRuntimeProfile: publicEffectiveClaudeRuntimeProfileSchema,
  idempotencyKey: z.string().uuid(),
  session: publicSessionSchema,
}).strict();
const sessionSendSchema = z.object({
  effectiveRuntimeProfile: publicEffectiveClaudeRuntimeProfileSchema,
  idempotencyKey: z.string().uuid(),
  session: publicSessionSchema,
  turnId: z.string().min(1).max(512).optional(),
}).strict();
const interactionPageSchema = z.object({
  interactions: z.array(publicInteractionSchema).max(20),
  nextCursor: z.string().min(1).max(2_048).nullable(),
  sessionId: sessionIdSchema,
}).strict();
const protectedInspectResultSchema = z.object({
  interactionId: z.string().uuid(),
  protectedOutput: z.object({
    disposition: z.literal("preserved_caller_removes_after_decision"),
    documentVersion: z.literal(1),
    path: normalizedPathSchema,
    status: z.literal("written"),
  }).strict(),
  revision: z.number().int().positive().safe(),
}).strict();
const interactionResolutionSchema = z.object({
  interaction: publicInteractionSchema,
  responseWritten: z.literal(true),
}).strict();
const expectedTool = "mcp__hra__memory_remember" as const;
const pollDeadlineMs = 10 * 60 * 1_000;
const pollIntervalMs = 250;

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw invalid("operator_interrupted");
};

const sleep = async (milliseconds: number, signal: AbortSignal): Promise<void> => {
  throwIfAborted(signal);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const finish = (): void => {
      signal.removeEventListener("abort", abort);
      resolvePromise();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      rejectPromise(invalid("operator_interrupted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
};

async function pollUntil<T>(
  signal: AbortSignal,
  operation: () => Promise<T | null>,
): Promise<T> {
  const deadline = Date.now() + pollDeadlineMs;
  for (;;) {
    throwIfAborted(signal);
    const value = await operation();
    if (value !== null) return value;
    if (Date.now() >= deadline) throw invalid("proof_unavailable");
    await sleep(pollIntervalMs, signal);
  }
}

const terminalOutput: Output = {
  writeStderr(value: string): void {
    process.stderr.write(value);
  },
  writeStdout(value: string): void {
    process.stdout.write(value);
  },
  async writeStdoutAsync(value: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      process.stdout.write(value, (error) => {
        if (error === undefined || error === null) resolvePromise();
        else rejectPromise(error);
      });
    });
  },
};

type ProtectedInteractionDocument = z.infer<typeof protectedInteractionDetailDocumentSchema>;

export async function createClaudeLiveAcceptanceProtectedInteractionFile(
  directory: PrivateDirectoryIdentity,
): Promise<Readonly<{ device: number; inode: number; path: string }>> {
  await assertPrivateDirectoryIdentity(directory, invalid);
  const path = join(directory.path, `.claude-interaction-${randomUUID()}.json`);
  if (!isPrivateDirectChild(directory.path, path)) throw invalid();
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.chmod(0o600);
    await handle.sync();
    const metadata = await handle.stat();
    if (
      !metadata.isFile()
      || metadata.nlink !== 1
      || metadata.uid !== process.getuid?.()
      || (metadata.mode & 0o7777) !== 0o600
      || metadata.size !== 0
    ) throw invalid();
    await syncPrivateDirectory(directory.path);
    return { device: metadata.dev, inode: metadata.ino, path };
  } finally {
    await handle.close();
  }
}

export async function consumeClaudeLiveAcceptanceProtectedInteractionFile(
  directory: PrivateDirectoryIdentity,
  identity: Readonly<{ device: number; inode: number; path: string }>,
): Promise<ProtectedInteractionDocument> {
  await assertPrivateDirectoryIdentity(directory, invalid);
  if (!isPrivateDirectChild(directory.path, identity.path)) throw invalid();
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 1);
  const handle = await open(
    identity.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let exactNamedIdentity = false;
  let document: ProtectedInteractionDocument | undefined;
  let failure: unknown;
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || before.nlink !== 1
      || before.uid !== process.getuid?.()
      || (before.mode & 0o7777) !== 0o600
      || before.dev !== identity.device
      || before.ino !== identity.inode
      || before.size < 2
      || before.size > 3 * 1024 * 1024
    ) throw invalid("proof_unavailable");
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    const named = await lstat(identity.path);
    if (
      length !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
      || named.dev !== before.dev
      || named.ino !== before.ino
      || !named.isFile()
      || named.isSymbolicLink()
      || named.nlink !== 1
      || named.uid !== before.uid
      || (named.mode & 0o7777) !== 0o600
    ) throw invalid("proof_unavailable");
    exactNamedIdentity = true;
    const source = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)),
    ) as unknown;
    document = protectedInteractionDetailDocumentSchema.parse(source);
  } catch (error: unknown) {
    failure = error instanceof ClaudeLiveAcceptanceError
      ? error
      : invalid("proof_unavailable");
  } finally {
    bytes.fill(0);
    await handle.close();
  }
  if (exactNamedIdentity) {
    await assertPrivateDirectoryIdentity(directory, invalid);
    const named = await lstat(identity.path);
    if (
      named.dev !== identity.device
      || named.ino !== identity.inode
      || !named.isFile()
      || named.isSymbolicLink()
      || named.nlink !== 1
      || named.uid !== process.getuid?.()
      || (named.mode & 0o7777) !== 0o600
    ) throw invalid("cleanup_unproven");
    await unlink(identity.path);
    await syncPrivateDirectory(directory.path);
    if (await privatePathExists(identity.path)) throw invalid("cleanup_unproven");
  }
  if (failure instanceof Error) throw failure;
  if (failure !== undefined) throw invalid("proof_unavailable");
  if (document === undefined) throw invalid("proof_unavailable");
  return document;
}

async function readLinuxProcessGroup(pid: number): Promise<number> {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid < 1) throw invalid();
  const path = `/proc/${String(pid)}/stat`;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const bytes = Buffer.alloc(8 * 1024 + 1);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw invalid();
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      length < 8
      || length > 8 * 1024
      || after.dev !== before.dev
      || after.ino !== before.ino
    ) throw invalid();
    const text = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes.subarray(0, length));
    const boundary = text.lastIndexOf(") ");
    const prefix = text.slice(0, boundary + 1);
    const fields = text.slice(boundary + 2).trimEnd().split(" ");
    const parsedPid = Number(prefix.slice(0, prefix.indexOf(" ")));
    const group = Number(fields[2]);
    if (
      boundary < 3
      || parsedPid !== pid
      || !Number.isSafeInteger(group)
      || group < 1
    ) throw invalid();
    return group;
  } finally {
    bytes.fill(0);
    await handle.close();
  }
}

export async function proveClaudeWorkerSignalDomain(workerPid: number): Promise<void> {
  const [workerGroup, parentGroup] = await Promise.all([
    readLinuxProcessGroup(workerPid),
    readLinuxProcessGroup(process.pid),
  ]);
  if (workerGroup !== workerPid || parentGroup === workerGroup) throw invalid("shutdown_unproven");
}

function readRecoveryReceiptFromFd(fd: number): ClaudeLiveAcceptanceRecoveryReceipt {
  if (!Number.isSafeInteger(fd) || fd < 3 || fd > 255 || isatty(fd)) throw invalid();
  const before = fstatSync(fd);
  if (
    !before.isFile()
    || before.nlink !== 1
    || before.uid !== process.getuid?.()
    || (before.mode & 0o7777) !== 0o600
    || before.size < 2
    || before.size > 64 * 1024
  ) throw invalid();
  const bytes = Buffer.alloc(64 * 1024 + 1);
  try {
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(fd);
    const value = claudeLiveAcceptanceRecoveryReceiptSchema.parse(JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)),
    ) as unknown);
    const named = lstatSync(value.receiptPath);
    if (
      length !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
      || named.dev !== before.dev
      || named.ino !== before.ino
      || !named.isFile()
      || named.isSymbolicLink()
      || named.nlink !== 1
      || named.uid !== before.uid
      || (named.mode & 0o7777) !== 0o600
    ) throw invalid();
    return value;
  } catch (error: unknown) {
    throw error instanceof ClaudeLiveAcceptanceError ? error : invalid();
  } finally {
    bytes.fill(0);
  }
}

const updateReceipt = async (
  receipt: AtomicPrivateJsonReceipt<ClaudeLiveAcceptanceRecoveryReceipt>,
  owner: ClaudeLiveAcceptanceOwner,
  transform: (
    current: ClaudeLiveAcceptanceRecoveryReceipt,
  ) => ClaudeLiveAcceptanceRecoveryReceipt,
): Promise<ClaudeLiveAcceptanceRecoveryReceipt> => {
  owner.assertCurrent();
  const next = await receipt.update(transform);
  owner.assertCurrent();
  return next;
};

const resourceFor = (
  receipt: ClaudeLiveAcceptanceRecoveryReceipt,
  key: "project" | "state",
) => receipt[key];

async function assertNoUnknownRunChildren(
  value: ClaudeLiveAcceptanceRecoveryReceipt,
): Promise<void> {
  if (!await privatePathExists(value.runRoot.path)) return;
  const allowed = new Set<string>();
  for (const resource of [value.state, value.project]) {
    if (resource.state === "active" || resource.state === "quarantine_planned") {
      allowed.add(basename(resource.identity.path));
    }
    if (
      resource.quarantinePath !== undefined
      && (resource.state === "quarantine_planned" || resource.state === "quarantined")
    ) allowed.add(basename(resource.quarantinePath));
  }
  const entries = await readdir(value.runRoot.path);
  if (entries.length > 4 || entries.some((entry) => !allowed.has(entry))) throw invalid();
}

async function quarantineAndDeleteResource(
  receipt: AtomicPrivateJsonReceipt<ClaudeLiveAcceptanceRecoveryReceipt>,
  owner: ClaudeLiveAcceptanceOwner,
  key: "project" | "state",
): Promise<void> {
  owner.assertCurrent();
  await assertClaudeLiveAcceptanceLayout(receipt.value);
  let resource = resourceFor(receipt.value, key);
  if (resource.state === "active") {
    const quarantinePath = join(
      receipt.value.runRoot.path,
      `.hra-claude-quarantine-${key}-${randomUUID()}`,
    );
    if (
      !isPrivateDirectChild(receipt.value.runRoot.path, quarantinePath)
      || await privatePathExists(quarantinePath)
    ) throw invalid();
    await updateReceipt(receipt, owner, (current) => ({
      ...current,
      [key]: { ...resourceFor(current, key), quarantinePath, state: "quarantine_planned" },
      checkpoint: "quarantined",
      updatedAt: Date.now(),
    }));
    resource = resourceFor(receipt.value, key);
  }
  if (resource.state === "quarantine_planned") {
    const quarantinePath = resource.quarantinePath;
    if (quarantinePath === undefined) throw invalid();
    const sourceExists = await privatePathExists(resource.identity.path);
    const quarantineExists = await privatePathExists(quarantinePath);
    if (sourceExists === quarantineExists) {
      if (!sourceExists) {
        await updateReceipt(receipt, owner, (current) => ({
          ...current,
          [key]: { ...resourceFor(current, key), state: "deleted" },
          updatedAt: Date.now(),
        }));
        resource = resourceFor(receipt.value, key);
      } else {
        throw invalid();
      }
    } else if (sourceExists) {
      owner.assertCurrent();
      await assertPrivateDirectoryIdentity(resource.identity, invalid);
      await rename(resource.identity.path, quarantinePath);
      await syncPrivateDirectory(receipt.value.runRoot.path);
      owner.assertCurrent();
    }
    if (resource.state === "quarantine_planned") {
      if (!await privatePathExists(quarantinePath)) throw invalid();
      await assertPrivateDirectoryIdentity({ ...resource.identity, path: quarantinePath }, invalid);
      await updateReceipt(receipt, owner, (current) => ({
        ...current,
        [key]: { ...resourceFor(current, key), state: "quarantined" },
        updatedAt: Date.now(),
      }));
      resource = resourceFor(receipt.value, key);
    }
  }
  if (resource.state === "quarantined") {
    const quarantinePath = resource.quarantinePath;
    if (quarantinePath === undefined) throw invalid();
    if (await privatePathExists(quarantinePath)) {
      owner.assertCurrent();
      await assertPrivateDirectoryIdentity({ ...resource.identity, path: quarantinePath }, invalid);
      await rm(quarantinePath, { force: false, recursive: true });
      await syncPrivateDirectory(receipt.value.runRoot.path);
      owner.assertCurrent();
    }
    if (await privatePathExists(quarantinePath)) throw invalid();
    await updateReceipt(receipt, owner, (current) => ({
      ...current,
      [key]: { ...resourceFor(current, key), state: "deleted" },
      updatedAt: Date.now(),
    }));
    resource = resourceFor(receipt.value, key);
  }
  if (
    resource.state !== "deleted"
    || await privatePathExists(resource.identity.path)
    || (resource.quarantinePath !== undefined && await privatePathExists(resource.quarantinePath))
  ) throw invalid();
}

export async function removeClaudeLiveAcceptancePrivateLayout(
  receipt: AtomicPrivateJsonReceipt<ClaudeLiveAcceptanceRecoveryReceipt>,
  owner: ClaudeLiveAcceptanceOwner,
): Promise<void> {
  owner.assertCurrent();
  await assertClaudeLiveAcceptanceLayout(receipt.value);
  if (await privatePathExists(receipt.value.runRoot.path)) {
    await assertPrivateDirectoryIdentity(receipt.value.runRoot, invalid);
    await assertNoUnknownRunChildren(receipt.value);
    await quarantineAndDeleteResource(receipt, owner, "project");
    await assertNoUnknownRunChildren(receipt.value);
    await quarantineAndDeleteResource(receipt, owner, "state");
    await assertNoUnknownRunChildren(receipt.value);
    const remaining = await readdir(receipt.value.runRoot.path);
    if (remaining.length !== 0) throw invalid();
    owner.assertCurrent();
    await rmdir(receipt.value.runRoot.path);
    await syncPrivateDirectory(dirname(receipt.value.runRoot.path));
  }
  if (await privatePathExists(receipt.value.runRoot.path)) throw invalid();
  owner.assertCurrent();
  await receipt.remove();
  owner.assertCurrent();
  await owner.removeAndRelease();
}

const descriptorFromReceipt = (
  value: ClaudeLiveAcceptanceRecoveryReceipt,
): AcceptanceInstallationDescriptor => acceptanceInstallationDescriptorSchema.parse({
  candidate: value.candidate,
  device: "a",
  documentsDirectory: value.project.identity.path,
  expectedHomeDirectory: value.expectedHomeDirectory,
  rootDirectory: value.state.identity.path,
  runId: value.runId,
  type: "hra-live-acceptance-device",
  version: 1,
});

type ClaudeEvidenceOutput =
  | Readonly<{ descriptor: number; kind: "descriptor" }>
  | Readonly<{ kind: "path"; path: string }>;

type ClaudeRunnerInvocation =
  | Readonly<{ kind: "prove"; output: ClaudeEvidenceOutput }>
  | Readonly<{ descriptor: number; kind: "resume" }>;

export function parseClaudeLiveAcceptanceArguments(
  arguments_: readonly string[],
): ClaudeRunnerInvocation {
  if (arguments_.length !== 2) throw invalid();
  const [option, value] = arguments_;
  if (value === undefined) throw invalid();
  if (option === "--resume-fd") {
    if (!/^[0-9]+$/u.test(value)) throw invalid();
    const descriptor = Number(value);
    if (!Number.isSafeInteger(descriptor) || descriptor < 3 || descriptor > 255) throw invalid();
    return { descriptor, kind: "resume" };
  }
  if (option === "--evidence-fd") {
    if (!/^[0-9]+$/u.test(value)) throw invalid();
    const descriptor = Number(value);
    if (!Number.isSafeInteger(descriptor) || descriptor < 3 || descriptor > 255) throw invalid();
    return { kind: "prove", output: { descriptor, kind: "descriptor" } };
  }
  if (option === "--evidence-path") {
    if (!isAbsolute(value) || resolve(value) !== value || value.length > 4_096) throw invalid();
    return { kind: "prove", output: { kind: "path", path: value } };
  }
  throw invalid();
}

type ClaudeRunnerSignalCustody = Readonly<{
  beginCleanup(): AbortSignal;
  beginProof(): AbortSignal;
  close(): void;
  interruptedDuringLogin(): boolean;
  loginSignalSource: ClaudeLoginSignalSource;
}>;

type ClaudeRunnerSignalSource = Readonly<{
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
}>;

export function createClaudeLiveAcceptanceSignalCustody(
  source: ClaudeRunnerSignalSource = process,
): ClaudeRunnerSignalCustody {
  const proof = new AbortController();
  const cleanup = new AbortController();
  let phase: "login" | "proof" | "cleanup" | "closed" = "login";
  let loginInterrupted: "SIGINT" | "SIGTERM" | null = null;
  const loginListeners = new Map<"SIGINT" | "SIGTERM", Set<() => void>>([
    ["SIGINT", new Set()],
    ["SIGTERM", new Set()],
  ]);
  const interrupt = (signal: "SIGINT" | "SIGTERM"): void => {
    if (phase === "login") {
      // The production foreground-login owner independently observes and
      // joins this signal. This listener only closes the handoff gap between
      // that owner removing its listener and returning to this runner.
      loginInterrupted ??= signal;
      for (const listener of loginListeners.get(signal) ?? []) listener();
      return;
    }
    if (phase === "proof") {
      if (!proof.signal.aborted) proof.abort(invalid("operator_interrupted"));
      return;
    }
    if (phase === "cleanup" && !cleanup.signal.aborted) {
      cleanup.abort(invalid("operator_interrupted"));
    }
  };
  const onInterrupt = (): void => interrupt("SIGINT");
  const onTerminate = (): void => interrupt("SIGTERM");
  source.on("SIGINT", onInterrupt);
  source.on("SIGTERM", onTerminate);
  const loginSignalSource: ClaudeLoginSignalSource = Object.freeze({
    add(signal: "SIGINT" | "SIGTERM", listener: () => void): void {
      if (phase !== "login") throw invalid();
      loginListeners.get(signal)?.add(listener);
      if (loginInterrupted === signal) listener();
    },
    remove(signal: "SIGINT" | "SIGTERM", listener: () => void): void {
      loginListeners.get(signal)?.delete(listener);
    },
  });
  return Object.freeze({
    beginCleanup(): AbortSignal {
      if (phase === "closed") throw invalid();
      phase = "cleanup";
      return cleanup.signal;
    },
    beginProof(): AbortSignal {
      if (phase !== "login") throw invalid();
      phase = "proof";
      if (loginInterrupted) proof.abort(invalid("operator_interrupted"));
      return proof.signal;
    },
    close(): void {
      if (phase === "closed") return;
      phase = "closed";
      source.off("SIGINT", onInterrupt);
      source.off("SIGTERM", onTerminate);
      for (const listeners of loginListeners.values()) listeners.clear();
    },
    interruptedDuringLogin: () => loginInterrupted !== null,
    loginSignalSource,
  });
}

type ForegroundLoginInput = Readonly<{
  installation: ReturnType<typeof createAcceptanceInstallation>;
  loginIdempotencyKey: string;
  loginSignalSource: ClaudeLoginSignalSource;
  owner: ClaudeLiveAcceptanceOwner;
  profileId: z.infer<typeof profileIdSchema>;
  worker: ClaudeLiveAcceptanceWorker;
}>;

type ClaudeRunnerDependencies = Readonly<{
  acquireOwner: typeof acquireClaudeLiveAcceptanceOwner;
  createLayout: typeof createLayout;
  createLogout: typeof createClaudeLiveAcceptanceLogout;
  createReadback: typeof createClaudeLiveAcceptanceReadback;
  createSignalCustody: () => ClaudeRunnerSignalCustody;
  foregroundLogin(input: ForegroundLoginInput): Promise<number>;
  isTerminalDescriptor(descriptor: number): boolean;
  now(): number;
  platform: NodeJS.Platform;
  proveSignalDomain(workerPid: number): Promise<void>;
  proveStopped(
    workerPid: number,
    descriptor: AcceptanceInstallationDescriptor,
  ): Promise<void>;
  recoverProcessJournal(): Promise<void>;
  sourceAttestation(url: string): Promise<LiveAcceptanceCandidate>;
  startWorker(
    descriptor: AcceptanceInstallationDescriptor,
    beforeDescriptorWrite?: (workerPid: number) => Promise<void>,
  ): Promise<ClaudeLiveAcceptanceWorker>;
}>;

export type ClaudeLiveAcceptanceRunnerOptions = Partial<ClaudeRunnerDependencies>;

const defaultRunnerDependencies = (): ClaudeRunnerDependencies => ({
  acquireOwner: acquireClaudeLiveAcceptanceOwner,
  createLayout,
  createLogout: createClaudeLiveAcceptanceLogout,
  createReadback: createClaudeLiveAcceptanceReadback,
  createSignalCustody: () => createClaudeLiveAcceptanceSignalCustody(),
  foregroundLogin: async (input) => {
    input.owner.assertCurrent();
    const exitCode = await cliMain([
      "account",
      "login",
      input.profileId,
      "--provider",
      "claude",
      "--idempotency-key",
      input.loginIdempotencyKey,
    ], terminalOutput, {
      callDaemon: async (command) => await input.worker.command(command),
      claudeLoginSignalSource: input.loginSignalSource,
      installation: input.installation,
      interactive: true,
      isTerminalDescriptor: isatty,
    });
    input.owner.assertCurrent();
    return exitCode;
  },
  isTerminalDescriptor: isatty,
  now: Date.now,
  platform: process.platform,
  proveSignalDomain: proveClaudeWorkerSignalDomain,
  proveStopped: proveLiveAcceptanceStoppedInstallation,
  recoverProcessJournal: recoverBoundedProcessJournal,
  sourceAttestation: liveAcceptanceSourceAttestation,
  startWorker: startClaudeLiveAcceptanceProcessWorker,
});

const resolveRunnerDependencies = (
  options: ClaudeLiveAcceptanceRunnerOptions,
): ClaudeRunnerDependencies => ({ ...defaultRunnerDependencies(), ...options });

const updateCheckpoint = async (
  receipt: AtomicPrivateJsonReceipt<ClaudeLiveAcceptanceRecoveryReceipt>,
  owner: ClaudeLiveAcceptanceOwner,
  checkpoint: z.infer<typeof checkpointSchema>,
  now: number,
  extra: Partial<ClaudeLiveAcceptanceRecoveryReceipt> = {},
): Promise<void> => {
  await updateReceipt(receipt, owner, (current) => ({
    ...current,
    ...extra,
    checkpoint,
    updatedAt: now,
  }));
};

const executeOwnedJson = async (
  worker: ClaudeLiveAcceptanceWorker,
  owner: ClaudeLiveAcceptanceOwner,
  argv: readonly string[],
  command: string,
  protectedDocument?: unknown,
): Promise<unknown> => {
  owner.assertCurrent();
  const value = await executeJson(worker, argv, command, protectedDocument);
  owner.assertCurrent();
  return value;
};

const makeMemoryTask = (runId: string): Readonly<{
  memory: HraMemoryRememberInput;
  nonce: string;
  prompt: string;
}> => {
  const nonce = `claude-live-${randomUUID().replaceAll("-", "")}`;
  const memory = hraMemoryRememberInputSchema.parse({
    body: `Bounded Claude live acceptance receipt nonce: ${nonce}`,
    key: `acceptance.claude.${runId.replaceAll("-", "")}`,
    language: "en",
    summary: `One-shot Claude acceptance memory ${nonce}`,
    title: "Claude live acceptance receipt",
  });
  const prompt = [
    "Use exactly one tool: mcp__hra__memory_remember.",
    `Pass this exact JSON object as its input: ${JSON.stringify(memory)}`,
    "After the tool succeeds, output exactly one compact JSON line and nothing else.",
    `The line must be {"submissionId":<the actual returned submission.id>,"receiptSha256":<the actual returned receiptSha256>,"nonce":${JSON.stringify(nonce)}}.`,
    "Do not guess either returned value, call another tool, use a shell, or add Markdown.",
  ].join("\n");
  return Object.freeze({ memory: Object.freeze({ ...memory }), nonce, prompt });
};

const exactClaudeAccountStatus = (
  value: unknown,
  profileId: z.infer<typeof profileIdSchema>,
  label: string,
) => {
  const status = claudeAccountStatusSchema.parse(value);
  if (status.account.id !== profileId || status.account.label !== label) {
    throw invalid("proof_unavailable");
  }
  return status;
};

const exactStartedSession = (
  value: unknown,
  input: Readonly<{
    idempotencyKey: string;
    profileId: z.infer<typeof profileIdSchema>;
    projectId: z.infer<typeof projectIdSchema>;
  }>,
) => {
  const result = sessionStartSchema.parse(value);
  if (
    result.idempotencyKey !== input.idempotencyKey
    || result.session.profileId !== input.profileId
    || result.session.projectId !== input.projectId
    || result.session.provider !== "claude"
    || result.session.preset !== "fable-max"
    || result.session.fastEnabled
    || result.session.state !== "idle"
    || result.session.activeTurnId !== undefined
    || result.effectiveRuntimeProfile.profileId !== input.profileId
    || result.effectiveRuntimeProfile.processGeneration < 1
  ) throw invalid("proof_unavailable");
  return result;
};

const exactSentTurn = (
  value: unknown,
  input: Readonly<{
    idempotencyKey: string;
    profileGeneration: number;
    profileId: z.infer<typeof profileIdSchema>;
    sessionId: z.infer<typeof sessionIdSchema>;
  }>,
) => {
  const result = sessionSendSchema.parse(value);
  if (
    result.idempotencyKey !== input.idempotencyKey
    || result.session.id !== input.sessionId
    || result.session.profileId !== input.profileId
    || result.session.provider !== "claude"
    || (result.session.state !== "active" && result.session.state !== "idle")
    || (result.session.state === "idle" && result.session.activeTurnId !== undefined)
    || (
      result.session.state === "active"
      && (result.session.activeTurnId !== undefined || result.turnId !== undefined)
      && (
        result.session.activeTurnId === undefined
        || result.turnId === undefined
        || result.session.activeTurnId !== result.turnId
      )
    )
    || result.effectiveRuntimeProfile.profileId !== input.profileId
    || result.effectiveRuntimeProfile.processGeneration !== input.profileGeneration
  ) throw invalid("proof_unavailable");
  return result;
};

const exactCreatedAccount = (value: unknown, label: string) => {
  const result = accountAddSchema.parse(value);
  if (
    result.account.label !== label
    || result.account.state !== "signed_out"
    || result.account.processGeneration !== 0
  ) throw invalid("proof_unavailable");
  return result.account;
};

const exactCreatedProject = (value: unknown) => projectAddSchema.parse(value).project.id;

const exactPendingMemoryPermission = (
  value: unknown,
  input: Readonly<{
    publicTurnId?: string;
    sessionId: z.infer<typeof sessionIdSchema>;
  }>,
): PublicInteraction | null => {
  const page = interactionPageSchema.parse(value);
  if (page.sessionId !== input.sessionId || page.nextCursor !== null) {
    throw invalid("proof_unavailable");
  }
  if (page.interactions.length === 0) return null;
  if (page.interactions.length !== 1) throw invalid("proof_unavailable");
  const interaction = page.interactions[0];
  if (
    interaction === undefined
    || interaction.sessionId !== input.sessionId
    || interaction.kind !== "permission_approval"
    || interaction.state !== "pending"
    || !interaction.blocking
    || interaction.responseRecorded
    || interaction.terminalAt !== null
    || interaction.display.kind !== "permission_approval"
    || interaction.display.allowsSessionScope
    || interaction.display.requested.length !== 1
    || interaction.display.requested[0]?.name !== expectedTool
    || interaction.context.turnId === null
    || (input.publicTurnId !== undefined && interaction.context.turnId !== input.publicTurnId)
  ) throw invalid("proof_unavailable");
  return interaction;
};

const exactProtectedMemoryPermission = (
  document: ProtectedInteractionDocument,
  input: Readonly<{
    interaction: PublicInteraction;
    profileGeneration: number;
    profileId: z.infer<typeof profileIdSchema>;
    projectPath: string;
    sessionId: z.infer<typeof sessionIdSchema>;
  }>,
): ProtectedInteractionDocument => {
  if (
    document.binding.interactionId !== input.interaction.id
    || document.binding.revision !== input.interaction.revision
    || document.binding.kind !== "permission_approval"
    || document.binding.sessionId !== input.sessionId
    || document.binding.profileId !== input.profileId
    || document.binding.processGeneration !== input.profileGeneration
    || document.authority.kind !== "permission_approval"
    || canonicalDigest(document.authority.permissions) !== canonicalDigest([expectedTool])
    || document.authority.workingDirectory !== input.projectPath
    || document.authority.environmentId !== null
  ) throw invalid("proof_unavailable");
  return document;
};

const exactWrittenPermission = (
  value: unknown,
  pending: PublicInteraction,
): PublicInteraction => {
  const result = interactionResolutionSchema.parse(value);
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
  ) throw invalid("proof_unavailable");
  return written;
};

const exactProvisionalProof = (
  value: ClaudeLiveAcceptanceProvisionalPrivateReceipt,
  input: Readonly<{
    candidate: LiveAcceptanceCandidate;
    connectionId: string;
    daemonGeneration: number;
    memory: HraMemoryRememberInput;
    profileGeneration: number;
    profileId: z.infer<typeof profileIdSchema>;
    runId: string;
    sendIdempotencyKey: string;
    sessionId: z.infer<typeof sessionIdSchema>;
  }>,
): ClaudeLiveAcceptanceProvisionalPrivateReceipt => {
  if (
    canonicalDigest(value.candidate) !== canonicalDigest(input.candidate)
    || value.runId !== input.runId
    || value.daemonGeneration !== input.daemonGeneration
    || value.profileId !== input.profileId
    || value.profileGeneration !== input.profileGeneration
    || value.sessionId !== input.sessionId
    || value.sendIdempotencyKey !== input.sendIdempotencyKey
    || value.connectionId !== input.connectionId
    || canonicalDigest(value.memory) !== canonicalDigest(input.memory)
  ) throw invalid("proof_unavailable");
  return value;
};

const failureCodeOf = (error: unknown): ClaudeLiveAcceptanceError["code"] =>
  error instanceof ClaudeLiveAcceptanceError ? error.code : "proof_unavailable";

const writeEvidence = (
  output: ClaudeEvidenceOutput,
  evidence: ClaudeLiveAcceptanceEvidence,
): void => {
  if (output.kind === "path") {
    writeProtectedJsonNoReplace(output.path, evidence, claudeLiveAcceptanceEvidenceSchema);
    return;
  }
  writeProtectedJsonToFd(output.descriptor, evidence, claudeLiveAcceptanceEvidenceSchema);
};

const preflightEvidenceOutput = async (output: ClaudeEvidenceOutput): Promise<void> => {
  if (output.kind === "descriptor") {
    if (isatty(output.descriptor)) throw invalid();
    const metadata = fstatSync(output.descriptor);
    if (
      !metadata.isFile()
      || metadata.nlink !== 1
      || metadata.uid !== process.getuid?.()
      || (metadata.mode & 0o7777) !== 0o600
      || metadata.size !== 0
    ) throw invalid();
    return;
  }
  const parent = dirname(output.path);
  const parentIdentity = await observePrivateDirectory(parent, invalid);
  await assertPrivateDirectoryIdentity(parentIdentity, invalid);
  try {
    await lstat(output.path);
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw invalid();
  }
  throw invalid();
};

const discardNewLayout = async (layout: ClaudeLayout): Promise<void> => {
  for (const identity of [layout.project, layout.state]) {
    await assertPrivateDirectoryIdentity(identity, invalid);
    if ((await readdir(identity.path)).length !== 0) throw invalid("cleanup_unproven");
    await rmdir(identity.path);
  }
  await assertPrivateDirectoryIdentity(layout.runRoot, invalid);
  if ((await readdir(layout.runRoot.path)).length !== 0) throw invalid("cleanup_unproven");
  await rmdir(layout.runRoot.path);
  await syncPrivateDirectory(dirname(layout.runRoot.path));
};

const discardProtectedInteractionFile = async (
  directory: PrivateDirectoryIdentity,
  identity: Readonly<{ device: number; inode: number; path: string }>,
): Promise<void> => {
  await assertPrivateDirectoryIdentity(directory, invalid);
  if (!isPrivateDirectChild(directory.path, identity.path)) throw invalid("cleanup_unproven");
  let named;
  try {
    named = await lstat(identity.path);
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (
    named.dev !== identity.device
    || named.ino !== identity.inode
    || !named.isFile()
    || named.isSymbolicLink()
    || named.nlink !== 1
    || named.uid !== process.getuid?.()
    || (named.mode & 0o7777) !== 0o600
  ) throw invalid("cleanup_unproven");
  await unlink(identity.path);
  await syncPrivateDirectory(directory.path);
};

const cleanupScopeDigest = (
  value: ClaudeLiveAcceptanceRecoveryReceipt,
): string => canonicalDigest({
  domain: "hra.claude.cleanup-readback.v1",
  profileId: value.profileId,
  profileGeneration: value.profileGeneration ?? null,
  sessionId: value.sessionId ?? null,
});

const createCleanupAuthorization = (
  value: ClaudeLiveAcceptanceRecoveryReceipt,
  input: Readonly<{ readbackSnapshotDigest?: string; now: number }>,
): CleanupAuthorization => {
  const base = cleanupAuthorizationBaseSchema.parse({
    authentication: value.logoutPreflight === undefined ? "not_started" : "signed_out",
    candidateBindingDigest: canonicalDigest(value.candidate),
    createdAt: input.now,
    ...(value.logoutPreflight === undefined
      ? {}
      : { preflightBindingDigest: value.logoutPreflight.bindingDigest }),
    ...(value.profileGeneration === undefined
      ? {}
      : { profileGeneration: value.profileGeneration }),
    ...(value.profileId === undefined
      ? {}
      : {
          profileId: value.profileId,
          readbackSnapshotDigest: input.readbackSnapshotDigest,
          scopeBindingDigest: cleanupScopeDigest(value),
        }),
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    version: 1,
    ...(value.worker.pid === undefined ? {} : { workerPid: value.worker.pid }),
    runId: value.runId,
  });
  return cleanupAuthorizationSchema.parse({
    ...base,
    bindingDigest: canonicalDigest({
      ...base,
      domain: "hra.claude.live-acceptance.cleanup-authorization.v1",
    }),
  });
};

const persistCleanupAuthorization = async (
  receipt: AtomicPrivateJsonReceipt<ClaudeLiveAcceptanceRecoveryReceipt>,
  owner: ClaudeLiveAcceptanceOwner,
  dependencies: ClaudeRunnerDependencies,
  readbackSnapshotDigest?: string,
): Promise<void> => {
  const authorization = createCleanupAuthorization(receipt.value, {
    now: dependencies.now(),
    ...(readbackSnapshotDigest === undefined ? {} : { readbackSnapshotDigest }),
  });
  await updateCheckpoint(receipt, owner, "cleanup_authorized", dependencies.now(), {
    cleanupAuthorization: authorization,
  });
};

const createRunReadback = (
  dependencies: ClaudeRunnerDependencies,
  descriptor: AcceptanceInstallationDescriptor,
  signal: AbortSignal,
): ClaudeLiveAcceptanceReadback => dependencies.createReadback({
  inspectLiveProcess: async (input) =>
    await inspectClaudeLiveAcceptanceProcess(descriptor.rootDirectory, input, signal),
  paths: createAcceptanceInstallation(descriptor).paths,
  signal,
});

const createRunLogout = (
  dependencies: ClaudeRunnerDependencies,
  receipt: AtomicPrivateJsonReceipt<ClaudeLiveAcceptanceRecoveryReceipt>,
  owner: ClaudeLiveAcceptanceOwner,
): ClaudeLiveAcceptanceLogoutController => {
  const value = receipt.value;
  if (value.profileId === undefined) throw invalid("cleanup_unproven");
  return dependencies.createLogout({
    descriptor: descriptorFromReceipt(value),
    persistAttempt: async (marker) => {
      owner.assertCurrent();
      await updateCheckpoint(receipt, owner, "logout_attempted", dependencies.now(), {
        logoutAttempt: marker,
      });
    },
    profileId: value.profileId,
    run: async (request) => {
      owner.assertCurrent();
      const result = await runLiveAcceptanceAuthorityCommand(request);
      owner.assertCurrent();
      return result;
    },
  });
};

const stopAndProveWorker = async (
  input: Readonly<{
    dependencies: ClaudeRunnerDependencies;
    descriptor: AcceptanceInstallationDescriptor;
    owner: ClaudeLiveAcceptanceOwner;
    receipt: AtomicPrivateJsonReceipt<ClaudeLiveAcceptanceRecoveryReceipt>;
    worker?: ClaudeLiveAcceptanceWorker;
  }>,
): Promise<ClaudeLiveAcceptancePrivateReceipt | undefined> => {
  const staged = input.receipt.value.worker;
  if (staged.state === "absent" && input.worker === undefined) return undefined;
  const pid = input.worker?.pid ?? staged.pid;
  if (pid === undefined) throw invalid("shutdown_unproven");
  let proof: ClaudeLiveAcceptancePrivateReceipt | undefined;
  if (input.worker !== undefined && staged.state !== "stopped") {
    input.owner.assertCurrent();
    if (staged.state === "ready") {
      try {
        proof = await input.worker.stopWithClaudeProof();
      } catch (error: unknown) {
        if (!(error instanceof ClaudeLiveAcceptanceProofError)) throw error;
      }
    } else {
      await input.worker.preserve();
    }
    input.owner.assertCurrent();
  }
  try {
    await input.dependencies.proveStopped(pid, input.descriptor);
  } catch (error: unknown) {
    throw new ClaudeLiveAcceptanceError("shutdown_unproven", undefined, { cause: error });
  }
  if (input.receipt.value.worker.state !== "stopped") {
    await updateCheckpoint(input.receipt, input.owner, "worker_stopped", input.dependencies.now(), {
      worker: { pid, state: "stopped" },
    });
  }
  return proof;
};

const cleanupStoppedRun = async (
  input: Readonly<{
    dependencies: ClaudeRunnerDependencies;
    owner: ClaudeLiveAcceptanceOwner;
    receipt: AtomicPrivateJsonReceipt<ClaudeLiveAcceptanceRecoveryReceipt>;
    signal: AbortSignal;
    worker?: ClaudeLiveAcceptanceWorker;
  }>,
): Promise<void> => {
  if (input.receipt.value.cleanupAuthorization !== undefined) {
    await removeClaudeLiveAcceptancePrivateLayout(input.receipt, input.owner);
    return;
  }
  const descriptor = descriptorFromReceipt(input.receipt.value);
  await stopAndProveWorker({ ...input, descriptor });
  let value = input.receipt.value;
  let readback: ClaudeLiveAcceptanceReadback | undefined;
  if (
    value.profileId !== undefined
    && value.projectId !== undefined
    && value.sessionId === undefined
  ) {
    readback = createRunReadback(input.dependencies, descriptor, input.signal);
    const recovered = await readback.recoverStartedSessionScope({
      profileId: value.profileId,
      projectId: value.projectId,
      startIdempotencyKey: value.startIdempotencyKey,
    });
    if (recovered !== null) {
      await updateCheckpoint(input.receipt, input.owner, "session_started", input.dependencies.now(), {
        profileGeneration: recovered.profileGeneration,
        sessionId: recovered.sessionId,
      });
      value = input.receipt.value;
    }
  }
  if (value.profileId !== undefined) {
    readback ??= createRunReadback(input.dependencies, descriptor, input.signal);
    const stopped = await readback.verifyCleanupStoppedCustody({
      profileId: value.profileId,
      ...(value.profileGeneration === undefined ? {} : { profileGeneration: value.profileGeneration }),
      ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    });
    if (stopped.scopeBindingDigest !== cleanupScopeDigest(value)) {
      throw invalid("cleanup_unproven");
    }
    if (value.logoutPreflight !== undefined) {
      // A controller used for preflight cannot enter its cleanup-only state
      // machine. Reconstruct one solely from the durable preflight/attempt
      // receipts after the daemon has been independently proved stopped.
      const logout = createRunLogout(input.dependencies, input.receipt, input.owner);
      try {
        const workerPid = value.worker.pid;
        if (workerPid === undefined) throw invalid("shutdown_unproven");
        const custody = createClaudeLiveAcceptanceCleanupStoppedCustody({
          candidateBindingDigest: canonicalDigest(value.candidate),
          daemonAuthorityReleased: true,
          daemonJoined: true,
          daemonPrivateArtifactsAbsent: stopped.privateArtifactsAbsent,
          phase: "stopped",
          preflightBindingDigest: value.logoutPreflight.bindingDigest,
          profileId: value.profileId,
          retainedSessionProcess: stopped.retainedSessionProcess,
          runId: value.runId,
          source: "worker_shutdown_private",
          unreleasedProcessesAbsent: stopped.unreleasedProcessesAbsent,
          version: 1,
          workerNotLive: true,
          workerPid,
        });
        await logout.resumeCleanupAfterStoppedCustody({
          ...(value.logoutAttempt === undefined ? {} : { attemptMarker: value.logoutAttempt }),
          preflightReceipt: value.logoutPreflight,
          signal: input.signal,
          stoppedCustody: custody,
        });
        await updateCheckpoint(input.receipt, input.owner, "signed_out", input.dependencies.now());
      } finally {
        logout.close();
      }
    }
    await persistCleanupAuthorization(
      input.receipt,
      input.owner,
      input.dependencies,
      stopped.snapshotDigest,
    );
  } else {
    await persistCleanupAuthorization(input.receipt, input.owner, input.dependencies);
  }
  await removeClaudeLiveAcceptancePrivateLayout(input.receipt, input.owner);
};

const preserveRecovery = async (
  receipt: AtomicPrivateJsonReceipt<ClaudeLiveAcceptanceRecoveryReceipt>,
  owner: ClaudeLiveAcceptanceOwner,
  error: unknown,
  now: number,
): Promise<never> => {
  let code = failureCodeOf(error);
  let cause = error;
  try {
    await updateCheckpoint(receipt, owner, "recovery_required", now, { failureCode: code });
  } catch (updateError: unknown) {
    code = "cleanup_unproven";
    cause = updateError;
  } finally {
    try {
      await owner.releasePreserving();
    } catch (releaseError: unknown) {
      code = "cleanup_unproven";
      cause = releaseError;
    }
  }
  throw new ClaudeLiveAcceptanceError(code, receipt.value.receiptPath, { cause });
};

const normalizeRunFailure = (error: unknown): ClaudeLiveAcceptanceError =>
  error instanceof ClaudeLiveAcceptanceError
    ? error
    : new ClaudeLiveAcceptanceError("proof_unavailable", undefined, { cause: error });

const samePrivateProof = (
  provisional: ClaudeLiveAcceptanceProvisionalPrivateReceipt,
  final: ClaudeLiveAcceptancePrivateReceipt,
): boolean => {
  const { lifecycleInvalidated: provisionalLifecycle, ...provisionalBase } = provisional;
  const { lifecycleInvalidated: finalLifecycle, ...finalBase } = final;
  void provisionalLifecycle;
  void finalLifecycle;
  return canonicalDigest(provisionalBase) === canonicalDigest(finalBase);
};

const createOwnedReceipt = async (
  layout: ClaudeLayout,
  dependencies: ClaudeRunnerDependencies,
): Promise<Readonly<{
  owner: ClaudeLiveAcceptanceOwner;
  receipt: AtomicPrivateJsonReceipt<ClaudeLiveAcceptanceRecoveryReceipt>;
}>> => {
  let owner: ClaudeLiveAcceptanceOwner;
  try {
    owner = await dependencies.acquireOwner({
      receiptPath: layout.receiptPath,
      runId: layout.descriptor.runId,
    });
  } catch (error: unknown) {
    try {
      await discardNewLayout(layout);
    } catch (cleanupError: unknown) {
      throw new ClaudeLiveAcceptanceError("cleanup_unproven", undefined, {
        cause: cleanupError,
      });
    }
    throw normalizeRunFailure(error);
  }
  try {
    owner.assertCurrent();
    const receipt = await AtomicPrivateJsonReceipt.create(
      initialReceipt(layout, dependencies.now()),
      claudeLiveAcceptanceRecoveryPolicy,
    );
    owner.assertCurrent();
    return { owner, receipt };
  } catch (error: unknown) {
    if (await privatePathExists(layout.receiptPath)) {
      await owner.releasePreserving();
      throw new ClaudeLiveAcceptanceError(
        "cleanup_unproven",
        layout.receiptPath,
        { cause: error },
      );
    }
    try {
      await discardNewLayout(layout);
      await owner.removeAndRelease();
    } catch (cleanupError: unknown) {
      await owner.releasePreserving().catch(() => undefined);
      throw new ClaudeLiveAcceptanceError("cleanup_unproven", undefined, {
        cause: cleanupError,
      });
    }
    throw normalizeRunFailure(error);
  }
};

const runCleanupOnly = async (
  invocation: Extract<ClaudeRunnerInvocation, { kind: "resume" }>,
  dependencies: ClaudeRunnerDependencies,
): Promise<null> => {
  const locator = readRecoveryReceiptFromFd(invocation.descriptor);
  await dependencies.recoverProcessJournal();
  const candidate = await dependencies.sourceAttestation(DEFAULT_CLOUD_DEPLOYMENT_URL);
  if (canonicalDigest(candidate) !== canonicalDigest(locator.candidate)) {
    throw new ClaudeLiveAcceptanceError("cleanup_unproven", locator.receiptPath);
  }
  const owner = await dependencies.acquireOwner({
    receiptPath: locator.receiptPath,
    runId: locator.runId,
  });
  let receipt: AtomicPrivateJsonReceipt<ClaudeLiveAcceptanceRecoveryReceipt>;
  try {
    owner.assertCurrent();
    receipt = await AtomicPrivateJsonReceipt.open(locator, claudeLiveAcceptanceRecoveryPolicy);
    owner.assertCurrent();
  } catch (error: unknown) {
    await owner.releasePreserving().catch(() => undefined);
    throw new ClaudeLiveAcceptanceError("cleanup_unproven", locator.receiptPath, {
      cause: error,
    });
  }
  const custody = dependencies.createSignalCustody();
  try {
    await cleanupStoppedRun({
      dependencies,
      owner,
      receipt,
      signal: custody.beginCleanup(),
    });
    return null;
  } catch (error: unknown) {
    return await preserveRecovery(receipt, owner, error, dependencies.now());
  } finally {
    custody.close();
  }
};

const runProof = async (
  invocation: Extract<ClaudeRunnerInvocation, { kind: "prove" }>,
  dependencies: ClaudeRunnerDependencies,
): Promise<ClaudeLiveAcceptanceEvidence> => {
  if (
    dependencies.platform !== "linux"
    || !dependencies.isTerminalDescriptor(0)
    || !dependencies.isTerminalDescriptor(1)
    || !dependencies.isTerminalDescriptor(2)
  ) throw invalid();
  await preflightEvidenceOutput(invocation.output);
  await dependencies.recoverProcessJournal();
  const candidate = await dependencies.sourceAttestation(DEFAULT_CLOUD_DEPLOYMENT_URL);
  const layout = await dependencies.createLayout(candidate);
  const { owner, receipt } = await createOwnedReceipt(layout, dependencies);
  const signalCustody = dependencies.createSignalCustody();
  const installation = createAcceptanceInstallation(layout.descriptor);
  const startedAt = new Date(dependencies.now()).toISOString();
  let worker: ClaudeLiveAcceptanceWorker | undefined;
  let logout: ClaudeLiveAcceptanceLogoutController | undefined;
  let cleanupSignal: AbortSignal | undefined;
  let layoutRemoved = false;
  try {
    await updateCheckpoint(receipt, owner, "worker_starting", dependencies.now(), {
      worker: { state: "starting" },
    });
    owner.assertCurrent();
    worker = await dependencies.startWorker(layout.descriptor, async (workerPid: number) => {
      owner.assertCurrent();
      await updateCheckpoint(receipt, owner, "worker_starting", dependencies.now(), {
        worker: { pid: workerPid, state: "starting" },
      });
    });
    owner.assertCurrent();
    await worker.ready();
    owner.assertCurrent();
    await dependencies.proveSignalDomain(worker.pid);
    owner.assertCurrent();
    const daemonGeneration = await worker.currentDaemonGeneration();
    await updateCheckpoint(receipt, owner, "worker_ready", dependencies.now(), {
      worker: { pid: worker.pid, state: "ready" },
    });
    const activeWorker = worker;

    const account = exactCreatedAccount(await executeOwnedJson(
      activeWorker,
      owner,
      ["account", "add", receipt.value.accountLabel, "--json"],
      "account.add",
    ), receipt.value.accountLabel);
    await updateCheckpoint(receipt, owner, "account_created", dependencies.now(), {
      profileId: account.id,
    });

    logout = createRunLogout(dependencies, receipt, owner);
    owner.assertCurrent();
    const preflight = await logout.preflightBeforeLogin(new AbortController().signal);
    owner.assertCurrent();
    if (signalCustody.interruptedDuringLogin()) throw invalid("operator_interrupted");
    await updateCheckpoint(receipt, owner, "logout_preflight", dependencies.now(), {
      logoutPreflight: preflight.receipt,
    });

    await updateCheckpoint(receipt, owner, "login_started", dependencies.now());
    owner.assertCurrent();
    if (signalCustody.interruptedDuringLogin()) throw invalid("operator_interrupted");
    const loginExitCode = await dependencies.foregroundLogin({
      installation,
      loginIdempotencyKey: receipt.value.loginIdempotencyKey,
      loginSignalSource: signalCustody.loginSignalSource,
      owner,
      profileId: account.id,
      worker: activeWorker,
    });
    owner.assertCurrent();
    if (signalCustody.interruptedDuringLogin() || loginExitCode === 130 || loginExitCode === 143) {
      throw invalid("operator_interrupted");
    }
    if (loginExitCode !== 0) throw invalid("login_unproven");
    await updateCheckpoint(receipt, owner, "login_joined", dependencies.now());
    const proofSignal = signalCustody.beginProof();
    throwIfAborted(proofSignal);

    const authentication = exactClaudeAccountStatus(await executeOwnedJson(
      activeWorker,
      owner,
      ["account", "show", account.id, "--provider", "claude", "--json"],
      "account.show",
    ), account.id, receipt.value.accountLabel);
    if (authentication.providerGeneration < 1) throw invalid("proof_unavailable");

    const projectId = exactCreatedProject(await executeOwnedJson(
      activeWorker,
      owner,
      [
        "project",
        "add",
        "--path",
        layout.project.path,
        "--name",
        receipt.value.projectLabel,
        "--json",
      ],
      "project.add",
    ));
    await updateCheckpoint(receipt, owner, "project_created", dependencies.now(), { projectId });

    const started = exactStartedSession(await executeOwnedJson(
      activeWorker,
      owner,
      [
        "session",
        "start",
        account.id,
        "--project",
        projectId,
        "--provider",
        "claude",
        "--preset",
        "fable-max",
        "--idempotency-key",
        receipt.value.startIdempotencyKey,
        "--json",
      ],
      "session.start",
    ), {
      idempotencyKey: receipt.value.startIdempotencyKey,
      profileId: account.id,
      projectId,
    });
    const sessionId = started.session.id;
    const profileGeneration = started.effectiveRuntimeProfile.processGeneration;
    if (profileGeneration !== authentication.providerGeneration) {
      throw invalid("proof_unavailable");
    }
    await updateCheckpoint(receipt, owner, "session_started", dependencies.now(), {
      profileGeneration,
      sessionId,
    });
    await executeOwnedJson(
      activeWorker,
      owner,
      ["autorespond", "off", "--session", sessionId, "--json"],
      "autorespond.set",
    );

    const task = makeMemoryTask(receipt.value.runId);
    owner.assertCurrent();
    await activeWorker.armClaudeProof({
      daemonGeneration,
      memory: task.memory,
      profileGeneration,
      profileId: account.id,
      sendIdempotencyKey: receipt.value.sendIdempotencyKey,
      sessionId,
    });
    owner.assertCurrent();
    await updateCheckpoint(receipt, owner, "proof_armed", dependencies.now());
    await updateCheckpoint(receipt, owner, "send_started", dependencies.now());
    exactSentTurn(await executeOwnedJson(
      activeWorker,
      owner,
      [
        "session",
        "send",
        sessionId,
        task.prompt,
        "--idempotency-key",
        receipt.value.sendIdempotencyKey,
        "--json",
      ],
      "session.send",
    ), {
      idempotencyKey: receipt.value.sendIdempotencyKey,
      profileGeneration,
      profileId: account.id,
      sessionId,
    });

    const interaction = await pollUntil(proofSignal, async () => exactPendingMemoryPermission(
      await executeOwnedJson(
        activeWorker,
        owner,
        ["interaction", "list", sessionId, "--pending", "--limit", "20", "--json"],
        "interaction.list",
      ),
      { sessionId },
    ));
    const protectedFile = await createClaudeLiveAcceptanceProtectedInteractionFile(layout.project);
    let protectedDocument: ProtectedInteractionDocument;
    try {
      const inspection = protectedInspectResultSchema.parse(await executeOwnedJson(
        activeWorker,
        owner,
        [
          "interaction",
          "inspect",
          interaction.id,
          "--revision",
          String(interaction.revision),
          "--handoff-file",
          protectedFile.path,
          "--json",
        ],
        "interaction.inspect",
      ));
      if (
        inspection.interactionId !== interaction.id
        || inspection.revision !== interaction.revision
        || inspection.protectedOutput.path !== protectedFile.path
      ) throw invalid("proof_unavailable");
      protectedDocument = exactProtectedMemoryPermission(
        await consumeClaudeLiveAcceptanceProtectedInteractionFile(layout.project, protectedFile),
        {
          interaction,
          profileGeneration,
          profileId: account.id,
          projectPath: layout.project.path,
          sessionId,
        },
      );
    } catch (error: unknown) {
      await discardProtectedInteractionFile(layout.project, protectedFile);
      throw error;
    }
    const written = exactWrittenPermission(await executeOwnedJson(
      activeWorker,
      owner,
      [
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
      ],
      "interaction.grant",
      { permissions: [expectedTool] },
    ), interaction);

    const provisional = exactProvisionalProof(await pollUntil(
      proofSignal,
      async () => await activeWorker.readClaudeProvisionalProof(),
    ), {
      candidate,
      connectionId: protectedDocument.binding.connectionId,
      daemonGeneration,
      memory: task.memory,
      profileGeneration,
      profileId: account.id,
      runId: receipt.value.runId,
      sendIdempotencyKey: receipt.value.sendIdempotencyKey,
      sessionId,
    });
    const consumption = await pollUntil(proofSignal, async () =>
      await verifyClaudeLiveAcceptanceConsumption({
        connectionId: protectedDocument.binding.connectionId,
        interaction,
        nonce: task.nonce,
        profileGeneration,
        profileId: account.id,
        prompt: task.prompt,
        readPage: async (cursor) => await executeOwnedJson(
          activeWorker,
          owner,
          [
            "session",
            "events",
            sessionId,
            "--limit",
            "200",
            "--wait-ms",
            "0",
            ...(cursor === undefined ? [] : ["--cursor", cursor]),
            "--json",
          ],
          "session.events",
        ),
        receiptSha256: provisional.result.receiptSha256,
        sessionId,
        signal: proofSignal,
        submissionId: provisional.result.submission.id,
        written,
      }));
    const workingQuery = await executeOwnedJson(
      activeWorker,
      owner,
      ["memory", "get", sessionId, task.memory.key, "--working-only", "--json"],
      "memory.query",
    );
    const memoryStatus = await executeOwnedJson(
      activeWorker,
      owner,
      ["memory", "status", sessionId, "--json"],
      "memory.status",
    );
    const finalAuthentication = exactClaudeAccountStatus(await executeOwnedJson(
      activeWorker,
      owner,
      ["account", "show", account.id, "--provider", "claude", "--json"],
      "account.show",
    ), account.id, receipt.value.accountLabel);
    if (finalAuthentication.providerGeneration !== authentication.providerGeneration) {
      throw invalid("proof_unavailable");
    }

    cleanupSignal = signalCustody.beginCleanup();
    const readback = createRunReadback(dependencies, layout.descriptor, cleanupSignal);
    owner.assertCurrent();
    const readbackLive = readbackLiveSchema.parse(await readback.captureLive({
      claudeAuthentication: { signedIn: true },
      memoryStatus,
      projectId,
      receipt: provisional,
      sendIdempotencyKey: receipt.value.sendIdempotencyKey,
      sendText: task.prompt,
      startIdempotencyKey: receipt.value.startIdempotencyKey,
      workingQuery,
    }));
    owner.assertCurrent();
    await updateCheckpoint(receipt, owner, "live_proved", dependencies.now());

    const finalProof = await stopAndProveWorker({
      dependencies,
      descriptor: layout.descriptor,
      owner,
      receipt,
      worker: activeWorker,
    });
    if (finalProof === undefined || !samePrivateProof(provisional, finalProof)) {
      throw invalid("proof_unavailable");
    }
    owner.assertCurrent();
    const readbackStopped = readbackStoppedSchema.parse(await readback.verifyStopped({
      receipt: finalProof,
    }));
    owner.assertCurrent();
    if (
      readbackStopped.proofBindingDigest !== readbackLive.proofBindingDigest
      || readbackStopped.processArgvDigest !== readbackLive.processArgvDigest
    ) throw invalid("shutdown_unproven");
    await updateCheckpoint(receipt, owner, "stopped_proved", dependencies.now());

    owner.assertCurrent();
    const logoutEvidence = logoutEvidenceSchema.parse(await logout.logoutAfterStoppedOracle({
      receipt: finalProof,
      signal: cleanupSignal,
      stoppedOracle: readbackStopped,
    }));
    owner.assertCurrent();
    await updateCheckpoint(receipt, owner, "signed_out", dependencies.now());
    await persistCleanupAuthorization(
      receipt,
      owner,
      dependencies,
      readbackStopped.snapshotDigest,
    );
    const evidenceBase = {
      candidate,
      kind: "claude-live-acceptance" as const,
      logout: logoutEvidence,
      memory: {
        operationSha256: provisional.result.page.operationSha256,
        receiptSha256: provisional.result.receiptSha256,
        recordSha256: provisional.result.page.recordSha256,
        submissionIdSha256: sha256(provisional.result.submission.id),
      },
      permission: {
        exactTool: expectedTool,
        responseWritten: true as const,
        scope: "turn" as const,
      },
      providerConsumption: consumption,
      readbackLive,
      readbackStopped,
      runId: layout.descriptor.runId,
      schemaVersion: 1 as const,
      startedAt,
      status: "passed" as const,
      worker: {
        daemonJoined: true as const,
        separateSignalDomain: true as const,
        workerNotLive: true as const,
      },
    };
    logout.close();
    logout = undefined;
    await removeClaudeLiveAcceptancePrivateLayout(receipt, owner);
    layoutRemoved = true;
    const evidence = claudeLiveAcceptanceEvidenceSchema.parse(withSelfDigest({
      ...evidenceBase,
      completedAt: new Date(dependencies.now()).toISOString(),
    }));
    writeEvidence(invocation.output, evidence);
    return evidence;
  } catch (error: unknown) {
    logout?.close();
    logout = undefined;
    if (layoutRemoved) throw normalizeRunFailure(error);
    cleanupSignal ??= signalCustody.beginCleanup();
    try {
      await cleanupStoppedRun({
        dependencies,
        owner,
        receipt,
        signal: cleanupSignal,
        ...(worker === undefined ? {} : { worker }),
      });
      layoutRemoved = true;
    } catch (cleanupError: unknown) {
      return await preserveRecovery(receipt, owner, cleanupError, dependencies.now());
    }
    throw normalizeRunFailure(error);
  } finally {
    logout?.close();
    signalCustody.close();
  }
};

export async function runClaudeLiveAcceptance(
  arguments_: readonly string[],
  options: ClaudeLiveAcceptanceRunnerOptions = {},
): Promise<ClaudeLiveAcceptanceEvidence | null> {
  const invocation = parseClaudeLiveAcceptanceArguments(arguments_);
  const dependencies = resolveRunnerDependencies(options);
  return invocation.kind === "resume"
    ? await runCleanupOnly(invocation, dependencies)
    : await runProof(invocation, dependencies);
}

export async function claudeLiveAcceptanceMain(
  arguments_: readonly string[] = Bun.argv.slice(2),
  options: ClaudeLiveAcceptanceRunnerOptions = {},
): Promise<number> {
  try {
    const result = await runClaudeLiveAcceptance(arguments_, options);
    process.stdout.write(result === null
      ? "hra: Claude live acceptance cleanup completed.\n"
      : "hra: Claude live acceptance passed.\n");
    return 0;
  } catch (error: unknown) {
    const failure = normalizeRunFailure(error);
    process.stderr.write(`hra: Claude live acceptance failed (${failure.code}).\n`);
    if (failure.recoveryReceiptPath !== undefined) {
      process.stderr.write(`Recovery receipt: ${failure.recoveryReceiptPath}\n`);
    }
    return failure.code === "operator_interrupted" ? 130 : 1;
  }
}

if (import.meta.main) {
  process.exitCode = await claudeLiveAcceptanceMain();
}
