import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { canonicalSha256 } from "@hraness/oh";
import { z } from "zod";

import { CLAUDE_HOST_TOOL_BRIDGE_ENTRYPOINT } from "../src/claude/host-tool-bridge";
import { digestClaudeHostToolInvocation } from "../src/claude/host-tool-protocol";
import { CLAUDE_PIN } from "../src/claude/pin";
import type { ClaudeProcessIdentity } from "../src/claude/process";
import { claudeHostToolCallbackSocketPath } from "../src/daemon/claude-host-tool-transport";
import {
  createLocalClaudeProcessLivenessProbe,
  type ClaudeProcessLivenessProbe,
} from "../src/daemon/personal-session-discovery";
import { OOMPA_SESSION_PREAMBLE } from "../src/domain/oompa-preamble";
import { createFactsMemoryBinding } from "../src/domain/facts-memory";
import { memoryPageContentDigest, memoryPageKeyDigest } from "../src/domain/memory-page";
import { projectMemoryIdentityContractSchema } from "../src/domain/project-memory";
import { claudeProviderAccountAuthoritySchema, type ProviderAccountAuthority } from "../src/domain/provider-accounts";
import { reviewedRuntimeProfileSchema } from "../src/domain/runtime-profile";
import { profileIdSchema, projectIdSchema, sessionIdSchema, type ProfileId, type ProjectId, type SessionId } from "../src/domain/values";
import { resolveStatePaths, type StatePaths } from "../src/storage/paths";
import { StateStore, MEMORY_SUBMISSION_RETAIN_AGE_MS, projectMemoryPhysicalStateSchema, projectMemorySyncStateSchema,
  type ClaudeProcessAuthorityRecord } from "../src/storage/state-store";
import type {
  ClaudeLiveAcceptancePrivateReceipt,
  ClaudeLiveAcceptanceProvisionalPrivateReceipt,
} from "./claude-live-acceptance-proof";
import {
  parseClaudeLiveAcceptancePrivateReceipt,
  parseClaudeLiveAcceptanceProvisionalPrivateReceipt,
} from "./claude-live-acceptance-proof";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const time = z.string().datetime({ offset: true });
const head = z.object({ digest, operationSha256: digest, sequence: z.number().int().positive().safe() }).strict();
const rowSchema = z.object({
  row: z.literal(0), lane: z.literal("working"), key: z.string().min(1).max(504),
  recordSha256: digest, title: z.string().max(512), summary: z.string().max(4096),
  language: z.string().max(200).nullable(), createdAt: time, updatedAt: time,
  provenance: z.object({ kind: z.literal("host-attested"), attestedAt: time,
    actorId: z.string().min(1).max(256), attestationSha256: digest,
    verification: z.literal("local-ledger-verified") }).strict(),
  bodyChunk: z.string().max(8192), chunkCount: z.literal(1), chunkIndex: z.literal(0),
}).strict();
const workingQuerySchema = z.object({
  version: z.literal(1), ok: z.literal(true), mode: z.literal("get"),
  sessionId: sessionIdSchema, queryId: z.string().regex(/^memq_[a-f0-9]{32}$/u),
  rows: z.tuple([rowSchema]), continuation: z.null(), conflicts: z.array(z.never()).max(0),
  page: z.object({ completeness: z.literal("complete"), endExclusive: z.literal(1),
    hasMore: z.literal(false), pageSize: z.literal(2), returnedRows: z.literal(1),
    start: z.literal(0), totalRows: z.literal(1) }).strict(),
  scope: z.literal("working"), canonicalHead: z.null(),
  canonical: z.object({ included: z.literal(false), frozen: z.boolean(),
    diagnosticCode: z.string().max(200).nullable(), syncState: projectMemorySyncStateSchema.nullable() }).strict(),
  workingHead: head,
}).strict();
const statusSchema = z.object({ version: z.literal(1), ok: z.literal(true), sessionId: sessionIdSchema,
  projectId: projectIdSchema, unsettledSubmission: z.null(),
  working: z.object({ state: z.literal("active"), ownerMatchesSession: z.literal(true),
    bindingDigest: digest, epoch: z.literal(1), head }).strict(),
  canonical: z.object({ initialized: z.boolean(), physicalState: projectMemoryPhysicalStateSchema.nullable(),
    identityContract: projectMemoryIdentityContractSchema.nullable(), authorityDigest: digest.nullable(), bindingDigest: digest.nullable(),
    expectedHead: z.object({ digest, sequence: z.number().int().nonnegative().safe(),
      operationSha256: digest.nullable() }).strict().nullable(), syncState: projectMemorySyncStateSchema.nullable(),
    frozen: z.boolean(), diagnosticCode: z.string().max(200).nullable(),
    revision: z.number().int().positive().safe().nullable(), lastExchangeAt: z.number().int().nonnegative().safe().nullable(),
    lastExchangeHead: z.object({ digest, sequence: z.number().int().nonnegative().safe(),
      operationSha256: digest.nullable() }).strict().nullable() }).strict(),
}).strict();
const startReceiptSchema = z.object({ sessionId: sessionIdSchema,
  sourceId: z.string().min(1).max(200).optional(),
  effectiveRuntimeProfile: reviewedRuntimeProfileSchema }).strict();
const sendReceiptSchema = z.object({ turnId: z.string().min(1).max(200),
  status: z.enum(["completed", "interrupted", "failed", "inProgress"]).optional(),
  sourceId: z.string().min(1).max(200).optional(),
  effectiveRuntimeProfile: reviewedRuntimeProfileSchema }).strict();
const liveInputSchema = z.object({ receipt: z.unknown(), projectId: projectIdSchema,
  startIdempotencyKey: z.string().uuid(), sendIdempotencyKey: z.string().uuid(),
  sendText: z.string().min(1).max(262144),
  claudeAuthentication: z.object({ signedIn: z.literal(true) }).strict(), workingQuery: z.unknown(), memoryStatus: z.unknown(),
}).strict();

export type ClaudeLiveAcceptanceReadbackEvidence = Readonly<{
  version: 1;
  phase: "live" | "stopped";
  source: "independent_private_readback";
  snapshotDigest: string;
  proofBindingDigest: string;
  nativeStart: true;
  directSend: true;
  soleRemember: true;
  workingPage: true;
  managedClaudeSignedIn: true;
  processBound: true;
  hostBinding: true;
  pinnedProcessArgv: true;
  processArgvDigest: string;
  processReleased?: true;
  processNotLive?: true;
  privateArtifactsAbsent?: true;
  lifecycleInvalidated?: true;
}>;

export type ClaudeLiveAcceptanceReadbackLiveInput = Readonly<{
  receipt: ClaudeLiveAcceptanceProvisionalPrivateReceipt;
  projectId: ProjectId;
  startIdempotencyKey: string;
  sendIdempotencyKey: string;
  sendText: string;
  /** A fresh, independently checked managed-Claude status; never profiles.state. */
  claudeAuthentication: Readonly<{ signedIn: true }>;
  /** The complete production memory.query response for working/get of the nonce key. */
  workingQuery: unknown;
  /** A fresh owner memory.status response, independently observing current lifecycle. */
  memoryStatus: unknown;
}>;

export interface ClaudeLiveAcceptanceReadback {
  captureLive(input: ClaudeLiveAcceptanceReadbackLiveInput): Promise<ClaudeLiveAcceptanceReadbackEvidence>;
  verifyStopped(input: Readonly<{ receipt: ClaudeLiveAcceptancePrivateReceipt }>): Promise<ClaudeLiveAcceptanceReadbackEvidence>;
  /** Cleanup only, after the runner has independently joined the exact daemon/login worker. */
  verifyCleanupStoppedCustody(input: ClaudeLiveAcceptanceCleanupInput): Promise<ClaudeLiveAcceptanceCleanupEvidence>;
  /** Reconcile only a lost start response; this never grants deletion or acceptance authority. */
  recoverStartedSessionScope(input: ClaudeLiveAcceptanceStartedScopeInput): Promise<ClaudeLiveAcceptanceStartedScope | null>;
}

export type ClaudeLiveAcceptanceStartedScopeInput = Readonly<{
  profileId: ProfileId;
  projectId: ProjectId;
  startIdempotencyKey: string;
}>;
export type ClaudeLiveAcceptanceStartedScope = Readonly<{
  sessionId: SessionId;
  profileGeneration: number;
}>;
const startedScopeInputSchema = z.object({ profileId: profileIdSchema, projectId: projectIdSchema,
  startIdempotencyKey: z.string().uuid() }).strict();

export type ClaudeLiveAcceptanceCleanupInput = Readonly<{
  profileId: ProfileId;
  profileGeneration?: number;
  sessionId?: SessionId;
}>;

export type ClaudeLiveAcceptanceCleanupEvidence = Readonly<{
  version: 1;
  source: "independent_cleanup_readback";
  phase: "cleanup_stopped";
  snapshotDigest: string;
  scopeBindingDigest: string;
  unreleasedProcessesAbsent: true;
  privateArtifactsAbsent: true;
  retainedSessionProcess: "absent" | "released_not_live";
}>;

const cleanupInputSchema = z.object({ profileId: profileIdSchema,
  profileGeneration: z.number().int().nonnegative().safe().optional(),
  sessionId: sessionIdSchema.optional(),
}).strict().refine((value) => value.sessionId === undefined || value.profileGeneration !== undefined);

export type ClaudeLiveAcceptanceProcessInspectionInput = Readonly<{
  identity: ClaudeProcessIdentity;
  bindingPath: string;
  configPath: string;
  callbackSocketPath: string;
  profileId: ProfileId;
  profileGeneration: number;
  providerThreadId: string;
}>;

const refused = (): never => { throw new Error("claude_live_acceptance_readback_refused"); };
const requireThat = (value: boolean): void => { if (!value) refused(); };
const sha = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const same = (left: unknown, right: unknown): boolean => canonicalSha256(left) === canonicalSha256(right);
const withoutLifecycle = (receipt: ClaudeLiveAcceptancePrivateReceipt | ClaudeLiveAcceptanceProvisionalPrivateReceipt) => {
  const { lifecycleInvalidated, ...rest } = receipt;
  void lifecycleInvalidated;
  return rest;
};

// These independent admission checks intentionally do not extend any V1 receipt
// or digest preimage. The private tuple is retained across IO, never inferred
// from the Codex/profile generation or added retrospectively to old evidence.
// Process custody preserves its legacy profile counter separately. Compare
// provider generations only through the independently verified custody tuple.
const baseClaudeAuthority = (value: ProviderAccountAuthority) => claudeProviderAccountAuthoritySchema.parse({
  provider: value.provider, providerAccountId: value.providerAccountId, profileId: value.profileId,
  bindingGeneration: value.bindingGeneration, processGeneration: value.processGeneration,
});
const currentClaudeAuthority = (store: StateStore, profileId: ProfileId) => {
  const authority = baseClaudeAuthority(store.requireProviderAccountAuthority(profileId, "claude"));
  const account = store.assertProviderAccountAuthorityCurrent(authority);
  return { authority, readiness: account.readiness, readinessObservedAt: account.readinessObservedAt };
};
const capturedClaudeAuthority = (store: StateStore, sessionId: SessionId) =>
  baseClaudeAuthority(store.requireCapturedSessionProviderAuthority(sessionId));
const requireOriginalMutationAuthority = (
  store: StateStore, attemptId: Parameters<StateStore["readMutationProviderAuthorities"]>[0],
  captured: ProviderAccountAuthority,
) => {
  const authorities = store.readMutationProviderAuthorities(attemptId);
  requireThat(authorities.length === 1 && authorities[0]?.role === "primary"
    && same(authorities[0].authority, captured));
  return authorities;
};

/** Mirrors the production host-call idempotency preimage, independently of its result. */
const rememberKey = (receipt: ClaudeLiveAcceptanceProvisionalPrivateReceipt): string => {
  const bytes = createHash("sha256").update([
    "oompa:host-tool-call:v1", receipt.profileId, receipt.providerThreadId,
    receipt.turnId, receipt.callId, "memory_remember",
  ].join("\0"), "utf8").digest();
  bytes[6] = (bytes[6] ?? 0) & 0x0f | 0x50;
  bytes[8] = (bytes[8] ?? 0) & 0x3f | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

const privateNode = async (path: string, type: "directory" | "socket"): Promise<void> => {
  // Canonicalize the parent of a socket: Bun's realpath cannot resolve a socket
  // on every supported host. The normalized leaf is admitted by no-follow lstat.
  const canonicalNode = type === "socket" ? dirname(path) : path;
  const stat = await lstat(path);
  requireThat(isAbsolute(path) && resolve(path) === path
    && stat.uid === process.getuid?.() && (stat.mode & 0o7777) === (type === "directory" ? 0o700 : 0o600)
    && !stat.isSymbolicLink() && (type === "directory" ? stat.isDirectory() : stat.isSocket() && stat.nlink === 1)
    && await realpath(canonicalNode) === canonicalNode);
};

/** Descriptor-bounded, no-follow JSON; never returns bytes to the runner or stdout. */
const privateJson = async (path: string): Promise<unknown> => {
  const parent = dirname(path);
  await privateNode(parent, "directory");
  const parentBefore = await lstat(parent);
  const buffer = new Uint8Array(8193);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    requireThat(before.isFile() && before.nlink === 1 && before.uid === process.getuid?.()
      && (before.mode & 0o7777) === 0o600 && before.size >= 2 && before.size <= 8192);
    let length = 0;
    while (length < buffer.length) {
      const part = await file.read(buffer, length, buffer.length - length, length);
      if (part.bytesRead === 0) break;
      length += part.bytesRead;
    }
    const after = await file.stat();
    const pathAfter = await lstat(path);
    await privateNode(parent, "directory");
    const parentAfter = await lstat(parent);
    requireThat(length === before.size && length <= 8192
      && before.dev === after.dev && before.ino === after.ino
      && before.size === after.size && before.mtimeMs === after.mtimeMs
      && before.ctimeMs === after.ctimeMs && pathAfter.dev === before.dev && pathAfter.ino === before.ino
      && parentBefore.dev === parentAfter.dev && parentBefore.ino === parentAfter.ino
      && [after, pathAfter].every((stat) => stat.isFile() && stat.nlink === 1
        && stat.uid === before.uid && (stat.mode & 0o7777) === 0o600));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))) as unknown;
  } finally { buffer.fill(0); await file.close(); }
};

const absent = async (path: string): Promise<void> => {
  try { await lstat(path); } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  refused();
};

const readArtifacts = async (paths: StatePaths, receipt: ClaudeLiveAcceptanceProvisionalPrivateReceipt) => {
  await privateNode(paths.runtime, "directory");
  const directories: string[] = [];
  let entries = 0;
  for await (const entry of await opendir(paths.runtime)) {
    requireThat(++entries <= 64);
    if (entry.name.startsWith(".oompa-claude-host-tools-")) directories.push(join(paths.runtime, entry.name));
  }
  requireThat(directories.length === 1);
  const directory = directories[0] ?? refused();
  await privateNode(directory, "directory");
  const children = new Set<string>();
  for await (const entry of await opendir(directory)) {
    requireThat(children.size < 2 && (entry.name === "binding.json" || entry.name === "mcp.json"));
    children.add(entry.name);
  }
  requireThat(children.size === 2);
  const bindingPath = join(directory, "binding.json");
  const configPath = join(directory, "mcp.json");
  const socketPath = claudeHostToolCallbackSocketPath(paths);
  const binding = z.object({ bindingId: z.string().regex(/^clhb_[a-f0-9]{32}$/u),
    capability: z.string().regex(/^[A-Za-z0-9_-]{43}$/u), callbackSocketPath: z.string(), version: z.literal(1),
  }).strict().parse(await privateJson(bindingPath));
  requireThat(binding.bindingId === receipt.bindingId && binding.callbackSocketPath === socketPath);
  const config = await privateJson(configPath);
  requireThat(same(config, { mcpServers: { oompa: {
    args: [CLAUDE_HOST_TOOL_BRIDGE_ENTRYPOINT, "--binding", bindingPath],
    command: process.execPath, type: "stdio",
  } } }));
  await privateNode(socketPath, "socket");
  return Object.freeze({ directory, bindingPath, configPath, socketPath,
    bindingDigest: canonicalSha256(binding), configDigest: canonicalSha256(config) });
};

const requireManagedArtifactsAbsent = async (paths: StatePaths): Promise<void> => {
  await privateNode(paths.runtime, "directory");
  let entries = 0;
  for await (const entry of await opendir(paths.runtime)) {
    requireThat(++entries <= 64 && !entry.name.startsWith(".oompa-claude-host-tools-"));
  }
  await absent(claudeHostToolCallbackSocketPath(paths));
};

const readCleanupRecords = (store: StateStore, input: ClaudeLiveAcceptanceCleanupInput) => {
  const profile = store.requireProfile(input.profileId);
  const current = currentClaudeAuthority(store, input.profileId);
  requireThat(!store.profileHasClaudeProcessLaunchIntents(input.profileId)
    && !store.profileHasUnreleasedClaudeProcessAuthorities(input.profileId)
    && store.listUnsettledMutations({ authorityId: input.profileId }).length === 0);
  const sessions = store.listSessions(2, input.profileId, true);
  if (input.sessionId === undefined) {
    requireThat(sessions.length === 0
      && (input.profileGeneration === undefined || current.authority.processGeneration === input.profileGeneration));
    return { records: { profile, session: null, authority: null, process: null }, providerSnapshot: { current, captured: null } };
  }
  const session = store.requireSession(input.sessionId);
  const authority = store.readSessionProviderAccountAuthority(input.sessionId);
  const captured = capturedClaudeAuthority(store, input.sessionId);
  requireThat(sessions.length === 1 && sessions[0]?.id === input.sessionId
    && captured.processGeneration === input.profileGeneration
    && same(current.authority, { ...captured, processGeneration: (input.profileGeneration ?? refused()) + 1 })
    && session.profileId === input.profileId && session.provider === "claude"
    && session.providerThreadId !== undefined && authority?.provider === "claude" && authority.runtimeScope === "managed"
    && store.readSessionPersonalRuntimeBinding(input.sessionId, true) === null
    && store.listUnsettledMutations({ sessionId: input.sessionId }).length === 0);
  const process = store.readClaudeProcessAuthority({ runtimeScope: "managed", profileId: input.profileId,
    providerThreadId: session.providerThreadId ?? refused() });
  requireThat(process !== null && process.sessionId === input.sessionId
    && process.providerAuthority?.processGeneration === input.profileGeneration
    && process.state === "released" && process.releasedAt !== null
    && same(process.providerAuthority, captured));
  if (process === null) return refused();
  return { records: { profile, session, authority, process }, providerSnapshot: { current, captured } };
};

const readStartedScope = (store: StateStore, input: ClaudeLiveAcceptanceStartedScopeInput) => {
  const profile = store.requireProfile(input.profileId);
  const current = currentClaudeAuthority(store, input.profileId);
  const project = store.requireProject(input.projectId);
  const sessions = store.listSessions(2, input.profileId, true);
  const start = store.readMutation(input.startIdempotencyKey);
  requireThat(profile.state !== "removed" && !store.profileHasClaudeProcessLaunchIntents(input.profileId)
    && store.listUnsettledMutations({ authorityId: input.profileId }).length === 0);
  if (start === null) {
    requireThat(sessions.length === 0 && !store.profileHasUnreleasedClaudeProcessAuthorities(input.profileId));
    return { profile, project, providerSnapshot: { current, captured: null, start: null }, scope: null };
  }
  const result = startReceiptSchema.parse(start.result);
  const generation = start.authorityGeneration;
  requireThat(start.kind === "session.start" && start.authorityId === input.profileId
    && generation > 0 && start.state === "applied" && start.resolution === undefined
    && start.originalState === undefined && start.evidence?.attemptId === start.id
    && start.sessionStartId === result.sessionId
    && (result.sourceId === undefined || result.sourceId === start.id)
    && start.requestDigest === sha(JSON.stringify({ kind: "session.start", authorityId: input.profileId,
      authorityGeneration: generation,
      request: { projectId: input.projectId, provider: "claude", preset: "fable-max", fast: false } }))
    && start.evidence.evidence.kind === "session.start"
    && start.evidence.evidence.projectId === input.projectId
    && start.evidence.evidence.clientMessageId === null && start.evidence.evidence.messageDigest === null
    && same(start.evidence.evidence.runtimeProfile, result.effectiveRuntimeProfile));
  const session = store.requireSession(result.sessionId);
  const captured = capturedClaudeAuthority(store, session.id);
  const startAuthority = requireOriginalMutationAuthority(store, start.id, captured);
  const authority = store.readSessionProviderAccountAuthority(session.id);
  const runtime = store.latestSessionRuntimeProfile(session.id);
  const reviewed = result.effectiveRuntimeProfile;
  requireThat(sessions.length === 1 && sessions[0]?.id === session.id
    && session.profileId === input.profileId && session.projectId === input.projectId
    && session.provider === "claude" && session.preset === "fable-max" && !session.fastEnabled
    && session.providerThreadId !== undefined && session.activeTurnId === undefined
    && session.state === "idle" && session.archivedAt === undefined
    && store.readSessionPersonalRuntimeBinding(session.id, true) === null
    && authority?.provider === "claude" && authority.runtimeScope === "managed"
    && store.hasNativeConversationAutomationAuthority(session.id, session.providerThreadId ?? refused())
    && store.listUnsettledMutations({ sessionId: session.id }).length === 0
    && runtime?.revision === 1 && runtime.sourceKind === "session_start" && runtime.sourceId === start.id
    && same(runtime.profile, reviewed) && reviewed.profileId === input.profileId
    && reviewed.processGeneration === generation && "configHome" in reviewed && reviewed.configHome === "isolated"
    && "claudeVersion" in reviewed && reviewed.claudeVersion === CLAUDE_PIN);
  const capabilities = store.requireSessionHostCapabilityBinding(session.id);
  requireThat(capabilities.preambleVersion === OOMPA_SESSION_PREAMBLE.version
    && capabilities.preambleDigest === OOMPA_SESSION_PREAMBLE.digest
    && capabilities.manifestVersion === OOMPA_SESSION_PREAMBLE.manifestVersion
    && capabilities.manifestDigest === OOMPA_SESSION_PREAMBLE.manifestDigest);
  const process = store.readClaudeProcessAuthority({ runtimeScope: "managed", profileId: input.profileId,
    providerThreadId: session.providerThreadId ?? refused() });
  requireThat(process !== null && process.sessionId === session.id && process.providerAuthority?.processGeneration === generation
    && captured.processGeneration === generation && same(process.providerAuthority, captured)
    && ((process.state === "bound" && process.releasedAt === null && same(current.authority, captured))
      || (process.state === "released" && process.releasedAt !== null
        && same(current.authority, { ...captured, processGeneration: generation + 1 }))));
  return { profile, project, start, session, authority, runtime, capabilities, process,
    providerSnapshot: { current, captured, start: startAuthority },
    scope: { sessionId: session.id, profileGeneration: generation } };
};

const readRecords = (store: StateStore, input: ClaudeLiveAcceptanceReadbackLiveInput, stopped: boolean) => {
  const r = input.receipt;
  const profile = store.requireProfile(r.profileId);
  const current = currentClaudeAuthority(store, r.profileId);
  const captured = capturedClaudeAuthority(store, r.sessionId);
  const session = store.requireSession(r.sessionId);
  const project = store.requireProject(input.projectId);
  requireThat(profile.id === r.profileId && project.id === input.projectId
    && captured.processGeneration === r.profileGeneration
    && same(current.authority, { ...captured, processGeneration: r.profileGeneration + (stopped ? 1 : 0) })
    && session.id === r.sessionId && session.profileId === r.profileId && session.projectId === input.projectId
    && session.provider === "claude" && session.providerThreadId === r.providerThreadId
    && session.preset === "fable-max" && !session.fastEnabled && session.state === "idle"
    && session.activeTurnId === undefined && session.archivedAt === undefined
    && store.readSessionPersonalRuntimeBinding(r.sessionId, true) === null);
  if (!stopped) requireThat(session.createdAt >= Date.now() - 60 * 60 * 1000
    && session.createdAt <= Date.now() && store.hasNativeConversationAutomationAuthority(r.sessionId, r.providerThreadId));
  const authority = store.readSessionProviderAccountAuthority(r.sessionId);
  requireThat(authority?.provider === "claude" && authority.runtimeScope === "managed");
  const capabilities = store.requireSessionHostCapabilityBinding(r.sessionId);
  requireThat(capabilities.preambleVersion === OOMPA_SESSION_PREAMBLE.version
    && capabilities.preambleDigest === OOMPA_SESSION_PREAMBLE.digest
    && capabilities.manifestVersion === OOMPA_SESSION_PREAMBLE.manifestVersion
    && capabilities.manifestDigest === OOMPA_SESSION_PREAMBLE.manifestDigest);
  const start = store.readMutation(input.startIdempotencyKey);
  const send = store.readMutation(input.sendIdempotencyKey);
  requireThat(start !== null && send !== null);
  if (start === null || send === null) return refused();
  const startAuthority = requireOriginalMutationAuthority(store, start.id, captured);
  const sendAuthority = requireOriginalMutationAuthority(store, send.id, captured);
  for (const mutation of [start, send]) requireThat(mutation.state === "applied"
    && mutation.resolution === undefined && mutation.originalState === undefined
    && mutation.authorityGeneration === r.profileGeneration && mutation.evidence?.attemptId === mutation.id);
  const startResult = startReceiptSchema.parse(start.result);
  const sendResult = sendReceiptSchema.parse(send.result);
  requireThat(start.kind === "session.start" && start.authorityId === r.profileId
    && start.requestDigest === sha(JSON.stringify({ kind: "session.start", authorityId: r.profileId,
      authorityGeneration: r.profileGeneration,
      request: { projectId: input.projectId, provider: "claude", preset: "fable-max", fast: false } }))
    && start.sessionStartId === r.sessionId && startResult.sessionId === r.sessionId
    && (startResult.sourceId === undefined || startResult.sourceId === start.id)
    && start.evidence?.evidence.kind === "session.start"
    && start.evidence.evidence.projectId === input.projectId
    && start.evidence.evidence.clientMessageId === null && start.evidence.evidence.messageDigest === null
    && same(start.evidence.evidence.runtimeProfile, startResult.effectiveRuntimeProfile)
    && send.kind === "session.send" && send.authorityId === r.sessionId
    && sendResult.turnId === r.turnId && sendResult.status !== "failed" && sendResult.status !== "interrupted"
    && (sendResult.sourceId === undefined || sendResult.sourceId === send.id)
    && send.requestDigest === sha(JSON.stringify({ kind: "session.send", authorityId: r.sessionId,
      authorityGeneration: r.profileGeneration, request: { message: input.sendText } }))
    && send.evidence?.evidence.kind === "session.send"
    && send.evidence.evidence.providerThreadId === r.providerThreadId
    && send.evidence.evidence.messageDigest === sha(input.sendText)
    && send.evidence.evidence.messageActor === "human"
    && send.evidence.evidence.clientMessageId === send.id
    && send.evidence.evidence.baseline.activeTurnId === null
    && send.evidence.evidence.baseline.status === "idle"
    && same(send.evidence.evidence.runtimeProfile, sendResult.effectiveRuntimeProfile));
  const runtime = store.latestSessionRuntimeProfile(r.sessionId);
  requireThat(runtime?.sourceId === send.id && runtime.sourceKind === "turn_start" && runtime.revision === 2
    && same(runtime.profile, sendResult.effectiveRuntimeProfile)
    && same(store.runtimeProfileForTurn(r.sessionId, r.turnId), runtime.profile));
  for (const p of [startResult.effectiveRuntimeProfile, sendResult.effectiveRuntimeProfile]) {
    requireThat(p.profileId === r.profileId && p.processGeneration === r.profileGeneration
      && "configHome" in p && p.configHome === "isolated"
      && "claudeVersion" in p && p.claudeVersion === CLAUDE_PIN);
  }
  requireThat(store.listUnsettledMutations({ authorityId: r.profileId }).length === 0
    && store.listUnsettledMutations({ sessionId: r.sessionId }).length === 0
    && store.readUnsettledMemorySubmissionForSession(r.sessionId) === null);
  const submission = store.requireMemorySubmission(r.result.submission.id);
  requireThat(store.isSoleMemorySubmissionForSession(r.sessionId, submission.id)
    && submission.actorSessionId === r.sessionId && submission.projectId === input.projectId
    && submission.kind === "remember" && submission.state === "applied"
    && submission.outcomeCode === "remember_committed" && submission.idempotencyKey === rememberKey(r)
    && submission.requestDigest === r.requestDigest && submission.contentDigest === memoryPageContentDigest(r.memory)
    && submission.keyDigest === memoryPageKeyDigest(r.memory.key)
    && submission.workingEpoch === 1 && submission.workingBindingDigest === createFactsMemoryBinding({
      ownerId: r.profileId, sessionId: r.sessionId, epoch: 1 }).bindingDigest
    && submission.expectedHead.sequence === 0 && submission.resultHead?.sequence === 1
    && submission.createdAt >= session.createdAt
    && submission.resultHead.headDigest === r.result.workingHead.digest
    && submission.resultHead.operationSha256 === r.result.workingHead.operationSha256
    && submission.receiptDigest === r.result.receiptSha256
    && r.result.idempotencyRetainedUntil === new Date(submission.updatedAt + MEMORY_SUBMISSION_RETAIN_AGE_MS).toISOString()
    && submission.effectRecordSha256 === r.result.page.recordSha256
    && submission.sourceHead === undefined && submission.nominationSha256 === undefined && submission.conflict === undefined
    && submission.attestationSha256 !== undefined);
  const attestation = store.findMemoryPageAttestation(submission.attestationSha256 ?? refused());
  requireThat(attestation !== null);
  if (attestation === null) return refused();
  for (const field of ["idempotencyKey", "actorSessionId", "projectId", "requestDigest", "contentDigest",
    "keyDigest", "workingBindingDigest", "workingEpoch", "effectRecordSha256", "attestationSha256"] as const) {
    requireThat(attestation[field] === submission[field]);
  }
  requireThat(attestation.submissionId === submission.id);
  requireThat(store.isMemoryPageAttestationReferenced({ attestationSha256: attestation.attestationSha256,
    authorityDigest: submission.workingBindingDigest, keyDigest: submission.keyDigest,
    lane: "working", projectId: input.projectId }));
  const workingHead = store.readMemoryWorkingAttestationHead(submission.workingBindingDigest);
  requireThat(workingHead?.origin === "create" && same(workingHead.head, submission.resultHead)
    && workingHead.forkParentAuthorityDigest === undefined
    && store.readMemoryWorkingAttestationFork(submission.workingBindingDigest) === null);
  const process = store.readClaudeProcessAuthority({ runtimeScope: "managed", profileId: r.profileId,
    providerThreadId: r.providerThreadId });
  requireThat(process?.sessionId === r.sessionId && process.providerAuthority?.processGeneration === r.profileGeneration
    && process.state === (stopped ? "released" : "bound")
    && (stopped ? process.releasedAt !== null : process.releasedAt === null));
  if (process === null) return refused();
  requireThat(same(process.providerAuthority, captured));
  return { immutable: { start, send, authority, capabilities, submission, attestation, runtime, workingHead }, process,
    providerSnapshot: { current, captured, start: startAuthority, send: sendAuthority } };
};

const checkQuery = (input: ClaudeLiveAcceptanceReadbackLiveInput, submission: ReturnType<StateStore["requireMemorySubmission"]>) => {
  requireThat(Buffer.byteLength(JSON.stringify(input.workingQuery), "utf8") <= 64 * 1024);
  requireThat(Buffer.byteLength(JSON.stringify(input.memoryStatus), "utf8") <= 8192);
  const query = workingQuerySchema.parse(input.workingQuery);
  const status = statusSchema.parse(input.memoryStatus);
  const r = input.receipt;
  const row = query.rows[0];
  requireThat(status.sessionId === r.sessionId && status.projectId === input.projectId
    && status.working.bindingDigest === submission.workingBindingDigest
    && same(status.working.head, query.workingHead));
  requireThat(query.sessionId === r.sessionId && same(query.workingHead, r.result.workingHead)
    && row.key === r.memory.key && row.bodyChunk === r.memory.body && row.title === r.memory.title
    && row.summary === r.memory.summary && row.language === (r.memory.language ?? null)
    && row.recordSha256 === r.result.page.recordSha256
    && row.provenance.attestationSha256 === submission.attestationSha256);
  requireThat(canonicalSha256({ actorId: row.provenance.actorId, actorSessionId: r.sessionId,
    attestedAt: row.provenance.attestedAt, contentDigest: submission.contentDigest,
    domain: "hra.memory.host-attestation.v1", idempotencyKeySha256: canonicalSha256({ idempotencyKey: submission.idempotencyKey, v: 1 }),
    keyDigest: submission.keyDigest, projectId: input.projectId, requestDigest: r.requestDigest,
    submissionId: submission.id, v: 1, workingBindingDigest: submission.workingBindingDigest,
    workingEpoch: submission.workingEpoch }) === submission.attestationSha256);
  return { query, status };
};

/** Private, single-use oracle. No provider commands, mutations, or generic database access. */
export function createClaudeLiveAcceptanceReadback(options: Readonly<{
  paths: StatePaths;
  signal: AbortSignal;
  processProbe?: ClaudeProcessLivenessProbe;
  inspectLiveProcess: (input: ClaudeLiveAcceptanceProcessInspectionInput) => Promise<Readonly<{
    pinnedArgv: true; argvDigest: string;
  }>>;
}>): ClaudeLiveAcceptanceReadback {
  const paths = resolveStatePaths({ rootDirectory: options.paths.root });
  requireThat(isAbsolute(paths.root) && resolve(paths.root) === paths.root && same(paths, options.paths));
  const probe = options.processProbe ?? createLocalClaudeProcessLivenessProbe();
  let phase: "new" | "busy" | "live" | "stopped" | "failed" = "new";
  let saved: Readonly<{ input: ClaudeLiveAcceptanceReadbackLiveInput; immutableDigest: string;
    providerSnapshot: ReturnType<typeof readRecords>["providerSnapshot"];
    process: ClaudeProcessAuthorityRecord; artifacts: Awaited<ReturnType<typeof readArtifacts>>;
    evidence: ClaudeLiveAcceptanceReadbackEvidence }> | undefined;
  const check = (): void => { options.signal.throwIfAborted(); };
  const isBusy = (): boolean => phase === "busy";
  let cleanupPhase: "new" | "busy" | "done" | "failed" = "new";
  let startedScopeUsed = false;
  const cleanupIsBusy = (): boolean => cleanupPhase === "busy";
  const withStore = async <T>(operation: (store: StateStore) => T): Promise<T> => {
    check();
    await privateNode(paths.root, "directory");
    const store = new StateStore(paths, { readonly: true });
    try { const value = operation(store); check(); return value; } finally { store.close(); }
  };
  return Object.freeze({
    async recoverStartedSessionScope(input: ClaudeLiveAcceptanceStartedScopeInput) {
      try {
        requireThat(!startedScopeUsed && !isBusy() && cleanupPhase === "new");
        startedScopeUsed = true;
        phase = "failed";
        const parsed = startedScopeInputSchema.parse(input);
        const first = await withStore((store) => readStartedScope(store, parsed));
        const second = await withStore((store) => readStartedScope(store, parsed));
        requireThat(same(first, second)); check();
        return first.scope === null ? null : Object.freeze({ ...first.scope });
      } catch { return refused(); }
    },
    async captureLive(input: ClaudeLiveAcceptanceReadbackLiveInput) {
      let boundary = "input";
      try {
        requireThat(phase === "new"); phase = "busy"; check();
        requireThat(input.receipt.sendIdempotencyKey === input.sendIdempotencyKey
          && input.startIdempotencyKey !== input.sendIdempotencyKey
          && z.string().uuid().safeParse(input.startIdempotencyKey).success
          && z.string().uuid().safeParse(input.sendIdempotencyKey).success
          && projectIdSchema.safeParse(input.projectId).success
          && z.object({ signedIn: z.literal(true) }).strict().safeParse(input.claudeAuthentication).success
          && input.receipt.requestDigest === digestClaudeHostToolInvocation(input.receipt.callId,
            { tool: "memory_remember", input: input.receipt.memory }));
        const parsedInput = liveInputSchema.parse(input);
        const frozenInput = structuredClone({ ...parsedInput,
          receipt: parseClaudeLiveAcceptanceProvisionalPrivateReceipt(parsedInput.receipt) });
        boundary = "records";
        const first = await withStore((store) => readRecords(store, frozenInput, false));
        boundary = "query";
        const query = checkQuery(frozenInput, first.immutable.submission);
        boundary = "artifacts";
        const artifacts = await readArtifacts(paths, frozenInput.receipt);
        boundary = "process";
        requireThat(await probe(first.process.identity, { deadlineAt: Date.now() + 3000, signal: options.signal }) === "live");
        const processInspection = z.object({ pinnedArgv: z.literal(true), argvDigest: digest }).strict().parse(
          await options.inspectLiveProcess({ identity: first.process.identity, bindingPath: artifacts.bindingPath,
            configPath: artifacts.configPath, callbackSocketPath: artifacts.socketPath,
            profileId: frozenInput.receipt.profileId, profileGeneration: frozenInput.receipt.profileGeneration,
            providerThreadId: frozenInput.receipt.providerThreadId }));
        requireThat(same(artifacts, await readArtifacts(paths, frozenInput.receipt)));
        const second = await withStore((store) => readRecords(store, frozenInput, false));
        requireThat(same(first, second)
          && await probe(first.process.identity, { deadlineAt: Date.now() + 3000, signal: options.signal }) === "live"); check();
        requireThat(same(first, await withStore((store) => readRecords(store, frozenInput, false))));
        const immutableDigest = canonicalSha256(first.immutable);
        boundary = "snapshot";
        const snapshotDigest = canonicalSha256({ immutableDigest, query, process: first.process, artifacts,
          receipt: withoutLifecycle(frozenInput.receipt), processInspection });
        const evidence: ClaudeLiveAcceptanceReadbackEvidence = Object.freeze({ version: 1, phase: "live",
          source: "independent_private_readback", snapshotDigest, nativeStart: true, directSend: true,
          proofBindingDigest: frozenInput.receipt.candidateBindingDigest,
          soleRemember: true, workingPage: true, managedClaudeSignedIn: true, processBound: true, hostBinding: true,
          pinnedProcessArgv: true, processArgvDigest: processInspection.argvDigest });
        requireThat(isBusy());
        saved = { input: frozenInput, immutableDigest, providerSnapshot: first.providerSnapshot,
          process: first.process, artifacts, evidence };
        phase = "live";
        return evidence;
      } catch (error: unknown) {
        phase = "failed";
        if (error instanceof Error && error.message === "claude_live_acceptance_readback_refused") throw error;
        const category = error instanceof z.ZodError ? "schema"
          : error instanceof TypeError ? "type"
          : error instanceof SyntaxError ? "json"
          : error instanceof RangeError ? "range"
          : error instanceof Error && error.name === "OhValidationError" ? "canonical"
          : typeof error === "object" && error !== null && "code" in error
            && typeof error.code === "string" && ["ENOENT", "ELOOP", "ENOTDIR", "EBADF", "ERR_DIR_CLOSED", "EINVAL", "EPERM"].includes(error.code)
            ? error.code : "other";
        throw new Error(`claude_live_acceptance_readback_refused_${boundary}_${category}`);
      }
    },
    async verifyStopped(input: Readonly<{ receipt: ClaudeLiveAcceptancePrivateReceipt }>) {
      try {
        requireThat(phase === "live" && saved !== undefined); phase = "busy"; check();
        const live = saved ?? refused();
        const envelope = z.object({ receipt: z.unknown() }).strict().parse(input);
        const receipt = parseClaudeLiveAcceptancePrivateReceipt(envelope.receipt);
        requireThat(same(withoutLifecycle(receipt), withoutLifecycle(live.input.receipt)));
        const records = await withStore((store) => readRecords(store, live.input, true));
        requireThat(canonicalSha256(records.immutable) === live.immutableDigest
          && same(records.providerSnapshot.captured, live.providerSnapshot.captured)
          && same(records.providerSnapshot.start, live.providerSnapshot.start)
          && same(records.providerSnapshot.send, live.providerSnapshot.send)
          && same(records.process.identity, live.process.identity)
          && records.process.recordedAt === live.process.recordedAt
          && records.process.revision === live.process.revision + 2);
        requireThat(await probe(live.process.identity, { deadlineAt: Date.now() + 3000, signal: options.signal }) === "not_live");
        for (const path of [live.artifacts.bindingPath, live.artifacts.configPath,
          live.artifacts.directory, live.artifacts.socketPath]) await absent(path);
        const finalRecords = await withStore((store) => readRecords(store, live.input, true));
        requireThat(same(records, finalRecords)
          && await probe(live.process.identity, { deadlineAt: Date.now() + 3000, signal: options.signal }) === "not_live");
        requireThat(same(records, await withStore((store) => readRecords(store, live.input, true))));
        check(); requireThat(isBusy()); phase = "stopped";
        return Object.freeze({ ...live.evidence, phase: "stopped" as const, processReleased: true as const,
          processNotLive: true as const, privateArtifactsAbsent: true as const, lifecycleInvalidated: true as const });
      } catch (error: unknown) {
        phase = "failed";
        if (error instanceof Error && error.message === "claude_live_acceptance_readback_refused") throw error;
        return refused();
      }
    },
    async verifyCleanupStoppedCustody(input: ClaudeLiveAcceptanceCleanupInput) {
      try {
        requireThat(cleanupPhase === "new" && !isBusy());
        cleanupPhase = "busy";
        // Cleanup cannot mint or revive acceptance proof, including after a failed capture.
        phase = "failed";
        const parsed = cleanupInputSchema.parse(input);
        const scope: ClaudeLiveAcceptanceCleanupInput = { profileId: parsed.profileId,
          ...(parsed.profileGeneration === undefined ? {} : { profileGeneration: parsed.profileGeneration }),
          ...(parsed.sessionId === undefined ? {} : { sessionId: parsed.sessionId }) };
        const first = await withStore((store) => readCleanupRecords(store, scope));
        if (first.records.process !== null) requireThat(await probe(first.records.process.identity,
          { deadlineAt: Date.now() + 3000, signal: options.signal }) === "not_live");
        await requireManagedArtifactsAbsent(paths);
        const second = await withStore((store) => readCleanupRecords(store, scope));
        requireThat(same(first, second));
        if (first.records.process !== null) requireThat(await probe(first.records.process.identity,
          { deadlineAt: Date.now() + 3000, signal: options.signal }) === "not_live");
        await requireManagedArtifactsAbsent(paths);
        requireThat(same(first, await withStore((store) => readCleanupRecords(store, scope))));
        check();
        requireThat(cleanupIsBusy());
        cleanupPhase = "done";
        return Object.freeze({ version: 1 as const, source: "independent_cleanup_readback" as const,
          phase: "cleanup_stopped" as const, snapshotDigest: canonicalSha256(first.records),
          scopeBindingDigest: canonicalSha256({ domain: "oompa.claude.cleanup-readback.v1", profileId: parsed.profileId,
            profileGeneration: parsed.profileGeneration ?? null, sessionId: parsed.sessionId ?? null }),
          unreleasedProcessesAbsent: true as const, privateArtifactsAbsent: true as const,
          retainedSessionProcess: first.records.process === null ? "absent" as const : "released_not_live" as const });
      } catch {
        cleanupPhase = "failed";
        return refused();
      }
    },
  });
}
