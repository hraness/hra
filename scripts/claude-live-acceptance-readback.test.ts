import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

import { canonicalSha256, parseSha256Hex } from "@hraness/oh";

import { CLAUDE_HOST_TOOL_BRIDGE_ENTRYPOINT } from "../src/claude/host-tool-bridge";
import { digestClaudeHostToolInvocation } from "../src/claude/host-tool-protocol";
import { CLAUDE_PIN, CLAUDE_PIN_MODEL } from "../src/claude/pin";
import { claudeHostToolCallbackSocketPath } from "../src/daemon/claude-host-tool-transport";
import type { ClaudeProcessLivenessProbe } from "../src/daemon/personal-session-discovery";
import { HRA_SESSION_PREAMBLE } from "../src/domain/hra-preamble";
import { createFactsMemoryBinding } from "../src/domain/facts-memory";
import { memoryPageContentDigest, memoryPageKeyDigest } from "../src/domain/memory-page";
import { PROJECT_MEMORY_EMPTY_HEAD } from "../src/domain/project-memory";
import { SESSION_CONVERSATION_AUTOMATION_CAPABILITY } from "../src/domain/session-tasks";
import { initializeStatePaths, profilePaths, resolveStatePaths } from "../src/storage/paths";
import { StateStore, MEMORY_SUBMISSION_RETAIN_AGE_MS } from "../src/storage/state-store";
import { HRA_VERSION } from "../src/version";
import { ClaudeLiveAcceptanceProofCollector } from "./claude-live-acceptance-proof";
import { createClaudeLiveAcceptanceReadback, type ClaudeLiveAcceptanceProcessInspectionInput } from "./claude-live-acceptance-readback";

const sha = (value: string) => {
  const digest = parseSha256Hex(createHash("sha256").update(value).digest("hex"));
  if (digest === null) throw new Error("fixture_digest_invalid");
  return digest;
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Real current-schema StateStore records and private filesystem artifacts.
// OS liveness and argv observations are typed deterministic fixtures; no provider is launched.
const fixture = async () => {
  // A short Unix temporary root keeps the real callback socket below sun_path's bound.
  const root = await realpath(await mkdtemp("/tmp/hra-clrb-"));
  const paths = resolveStatePaths({ rootDirectory: root });
  await initializeStatePaths(paths);
  const store = new StateStore(paths);
  const socketPath = claudeHostToolCallbackSocketPath(paths);
  const server = createServer();
  let socketClosed = false;
  const closeSocket = async () => {
    if (socketClosed) return;
    socketClosed = true;
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  };
  cleanups.push(async () => { if (server.listening) await closeSocket(); store.close(); await rm(root, { recursive: true }); });
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { mode: 0o700 });
  const project = await store.createProject("Readback test", projectRoot, true);
  const createdProfile = store.createProfile("Readback test");
  const profile = store.nextProfileGeneration(createdProfile.id);
  const runtime = {
    profileId: profile.id, processGeneration: profile.processGeneration, observedAt: Date.now(),
    preset: "fable-max" as const, model: CLAUDE_PIN_MODEL, reasoningEffort: "max" as const,
    claudeVersion: CLAUDE_PIN, permissionMode: "default" as const, configHome: "isolated" as const,
    inputFormat: "stream-json" as const, outputFormat: "stream-json" as const,
  };
  const startIdempotencyKey = randomUUID();
  const sendIdempotencyKey = randomUUID();
  const start = store.prepareMutation({ kind: "session.start", authorityId: profile.id,
    authorityGeneration: profile.processGeneration, idempotencyKey: startIdempotencyKey,
    request: { projectId: project.id, provider: "claude", preset: "fable-max", fast: false } });
  const session = store.beginSessionStartEffect({ attemptId: start.id, profileId: profile.id,
    profileGeneration: profile.processGeneration, projectId: project.id, provider: "claude", preset: "fable-max",
    fastEnabled: false, providerAccountKey: `v1:claude:${sha("test account")}`,
    providerAuthentication: { profileId: profile.id, processGeneration: profile.processGeneration, provider: "claude", signedIn: true },
    evidence: { kind: "session.start", projectId: project.id, clientMessageId: null, messageDigest: null,
      runtimeProfile: runtime, conversationAutomationCapability: SESSION_CONVERSATION_AUTOMATION_CAPABILITY },
    hostCapabilities: { preambleVersion: HRA_SESSION_PREAMBLE.version, preambleDigest: HRA_SESSION_PREAMBLE.digest,
      manifestVersion: HRA_SESSION_PREAMBLE.manifestVersion, manifestDigest: HRA_SESSION_PREAMBLE.manifestDigest },
  });
  const threadId = randomUUID();
  const turnId = randomUUID();
  const identity = { pid: 40001, pidDomain: "linux" as const, procStart: "readback-test-child" };
  store.recordClaimedClaudeProcessAuthority({ providerThreadId: threadId, profileId: profile.id,
    profileGeneration: profile.processGeneration, runtimeScope: "managed", sessionId: session.id, identity });
  store.completeSessionStartEffect({ attemptId: start.id, sessionId: session.id,
    expectedSessionRevision: session.revision, providerThreadId: threadId, state: "idle",
    runtimeProfile: runtime, claudeProcessIdentity: identity,
    receipt: { sessionId: session.id, effectiveRuntimeProfile: runtime } });
  const sendText = "Remember the exact test nonce and echo the returned receipt.";
  const send = store.prepareMutation({ kind: "session.send", authorityId: session.id,
    authorityGeneration: profile.processGeneration, idempotencyKey: sendIdempotencyKey, request: { message: sendText } });
  store.beginSessionMutationEffect({ attemptId: send.id, sessionId: session.id, profileGeneration: profile.processGeneration,
    message: sendText, evidence: { kind: "session.send", providerThreadId: threadId,
      baseline: { status: "idle", activeTurnId: null, providerUpdatedAt: null },
      clientMessageId: send.id, messageDigest: sha(sendText), runtimeProfile: runtime, messageActor: "human" } });
  store.completeSessionTurnEffect({ attemptId: send.id, sessionId: session.id, accountId: profile.id,
    providerGeneration: profile.processGeneration, providerConnectionId: null,
    expectedSessionRevision: store.requireSession(session.id).revision, applyResponseState: true,
    turnId, turnStatus: "completed", runtimeProfile: runtime, message: sendText,
    receipt: { turnId, status: "completed", effectiveRuntimeProfile: runtime } });
  const runId = randomUUID();
  const memory = { body: `Acceptance nonce ${runId}.`, key: `acceptance/${runId}`,
    summary: "Synthetic acceptance memory.", title: "Acceptance memory" };
  const bindingId = `clhb_${randomUUID().replaceAll("-", "")}`;
  const callId = randomUUID();
  const connectionId = randomUUID();
  const request = { tool: "memory_remember", input: memory } as const;
  const requestDigest = digestClaudeHostToolInvocation(callId, request);
  const keyBytes = createHash("sha256").update([
    "hra:host-tool-call:v1", profile.id, threadId, turnId, callId, "memory_remember",
  ].join("\0")).digest();
  keyBytes[6] = (keyBytes[6] ?? 0) & 15 | 80;
  keyBytes[8] = (keyBytes[8] ?? 0) & 63 | 128;
  const hex = keyBytes.toString("hex");
  const memoryIdempotencyKey = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  const submission = store.prepareMemorySubmission({ actorSessionId: session.id, projectId: project.id,
    kind: "remember", requestDigest, contentDigest: memoryPageContentDigest(memory), keyDigest: memoryPageKeyDigest(memory.key),
    workingBindingDigest: createFactsMemoryBinding({ ownerId: profile.id, sessionId: session.id }).bindingDigest,
    workingEpoch: 1, expectedHead: PROJECT_MEMORY_EMPTY_HEAD,
    idempotencyKey: memoryIdempotencyKey }).record;
  const attestedAt = new Date(submission.createdAt).toISOString();
  const actorId = "readback-test-actor";
  const attestationSha256 = canonicalSha256({ actorId, actorSessionId: session.id, attestedAt,
    contentDigest: submission.contentDigest, domain: "hra.memory.host-attestation.v1",
    idempotencyKeySha256: canonicalSha256({ idempotencyKey: memoryIdempotencyKey, v: 1 }),
    keyDigest: submission.keyDigest, projectId: project.id, requestDigest, submissionId: submission.id, v: 1,
    workingBindingDigest: submission.workingBindingDigest, workingEpoch: 1 });
  const recordSha256 = sha("test record");
  const operationSha256 = sha("test operation");
  const receiptSha256 = sha("test receipt");
  const headDigest = sha("test head");
  store.bindMemorySubmissionEffect({ submissionId: submission.id, attestationSha256, effectRecordSha256: recordSha256,
    operationId: "readback-test-operation" });
  store.beginMemorySubmission(submission.id);
  store.settleMemorySubmission({ submissionId: submission.id, expectedState: "effect_started", state: "applied",
    outcomeCode: "remember_committed", receiptDigest: receiptSha256,
    resultHead: { sequence: 1, operationSha256, headDigest } });
  const result = { version: 1, ok: true, replay: false,
    idempotencyRetainedUntil: new Date(store.requireMemorySubmission(submission.id).updatedAt + MEMORY_SUBMISSION_RETAIN_AGE_MS).toISOString(),
    submission: { id: submission.id, kind: "remember", state: "applied" },
    page: { key: memory.key, recordSha256, operationSha256 }, receiptSha256,
    workingHead: { digest: headDigest, operationSha256, sequence: 1 } } as const;
  const collector = new ClaudeLiveAcceptanceProofCollector({ runId,
    candidate: { cloudTargetDigest: sha("test cloud"), packageVersion: HRA_VERSION, sourceRevision: "1".repeat(40) } });
  collector.beginDaemonGeneration(1);
  collector.armFreshSession({ daemonGeneration: 1, memory, profileGeneration: profile.processGeneration, profileId: profile.id,
    providerThreadId: threadId, sendIdempotencyKey, sessionId: session.id });
  const profileDirectories = profilePaths(paths, profile.id);
  await collector.handleManagedHostToolCall({ authority: { id: profile.id, generation: profile.processGeneration,
    codexHome: profileDirectories.codexHome, desktopUserData: profileDirectories.desktopUserData },
    call: { authority: { profileId: profile.id, processGeneration: profile.processGeneration },
      callId, connectionId, threadId, turnId, requestId: { type: "string", value: callId }, requestDigest,
      tool: "memory_remember", input: memory }, dispatch: async () => result });
  collector.corroborateAppliedSend({ daemonGeneration: 1, idempotencyKey: sendIdempotencyKey, sessionId: session.id, turnId });
  collector.handleManagedHostToolResponseWritten({ bindingId, callId, profileId: profile.id,
    processGeneration: profile.processGeneration, provider: "claude", providerThreadId: threadId, request, requestDigest });
  const receipt = collector.readProvisionalPrivateReceipt();
  const directory = await mkdtemp(join(paths.runtime, ".hra-claude-host-tools-"));
  const bindingPath = join(directory, "binding.json");
  const configPath = join(directory, "mcp.json");
  const binding = { bindingId, callbackSocketPath: socketPath, capability: "a".repeat(43), version: 1 };
  await writeFile(bindingPath, JSON.stringify(binding), { mode: 0o600 });
  const config = { mcpServers: { hra: { args: [CLAUDE_HOST_TOOL_BRIDGE_ENTRYPOINT, "--binding", bindingPath],
    command: process.execPath, type: "stdio" } } };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await new Promise<void>((ready, reject) => { server.once("error", reject); server.listen(socketPath, ready); });
  await chmod(socketPath, 0o600);
  const workingQuery = { version: 1, ok: true, mode: "get", sessionId: session.id,
    queryId: `memq_${randomUUID().replaceAll("-", "")}`, rows: [{ row: 0, lane: "working", key: memory.key,
      recordSha256, title: memory.title, summary: memory.summary, language: null, createdAt: attestedAt, updatedAt: attestedAt,
      provenance: { kind: "host-attested", attestedAt, actorId, attestationSha256, verification: "local-ledger-verified" },
      bodyChunk: memory.body, chunkCount: 1, chunkIndex: 0 }], continuation: null, conflicts: [],
    page: { completeness: "complete", endExclusive: 1, hasMore: false, pageSize: 2, returnedRows: 1, start: 0, totalRows: 1 },
    scope: "working", canonicalHead: null, canonical: { included: false, frozen: false, diagnosticCode: null, syncState: null },
    workingHead: result.workingHead };
  const memoryStatus = { version: 1, ok: true, sessionId: session.id, projectId: project.id, unsettledSubmission: null,
    working: { state: "active", ownerMatchesSession: true, bindingDigest: submission.workingBindingDigest,
      epoch: 1, head: result.workingHead },
    canonical: { initialized: false, physicalState: null, identityContract: null, authorityDigest: null,
      bindingDigest: null, expectedHead: null, syncState: null, frozen: false, diagnosticCode: null,
      revision: null, lastExchangeAt: null, lastExchangeHead: null } };
  const input = { receipt, projectId: project.id, startIdempotencyKey, sendIdempotencyKey,
    sendText, claudeAuthentication: { signedIn: true as const }, workingQuery, memoryStatus };
  let liveness: "live" | "not_live" | "unknown" = "live";
  let processObservation: (() => void) | undefined;
  const processProbe: ClaudeProcessLivenessProbe = async (observed) => {
    expect(observed).toEqual(identity);
    processObservation?.();
    return liveness;
  };
  const oracle = (inspect?: (input: ClaudeLiveAcceptanceProcessInspectionInput) => Promise<void>) => createClaudeLiveAcceptanceReadback({ paths, signal: new AbortController().signal, processProbe,
    inspectLiveProcess: async (input) => {
      expect(input.identity).toEqual(identity);
      expect(input.configPath).toBe(configPath);
      await inspect?.(input);
      return { pinnedArgv: true, argvDigest: sha("deterministic argv observation") };
    } });
  const stop = async () => {
    const process = store.readSessionClaudeProcessAuthority(session.id);
    if (process === null) throw new Error("fixture process missing");
    const releasing = store.beginClaudeProcessAuthorityRelease({ profileId: profile.id, runtimeScope: "managed",
      providerThreadId: threadId, expectedRevision: process.revision, identity });
    store.completeClaudeProcessAuthorityRelease({ profileId: profile.id, runtimeScope: "managed",
      providerThreadId: threadId, expectedRevision: releasing.revision, identity });
    store.advanceProfileGeneration(profile.id, profile.processGeneration);
    await closeSocket();
    await rm(directory, { recursive: true });
    liveness = "not_live";
    collector.closeDaemonGeneration(1);
    return collector.readPrivateReceipt();
  };
  return { root, paths, store, input, oracle, stop, directory, bindingPath, configPath, binding, config,
    profile, session, send, submission, setLiveness: (value: typeof liveness) => { liveness = value; },
    observeProcess: (observation: () => void) => { processObservation = observation; } };
};

const startOnlyFixture = async () => {
  const root = await realpath(await mkdtemp("/tmp/hra-clrb-start-"));
  const paths = resolveStatePaths({ rootDirectory: root });
  await initializeStatePaths(paths);
  const store = new StateStore(paths);
  cleanups.push(async () => { store.close(); await rm(root, { recursive: true }); });
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { mode: 0o700 });
  const project = await store.createProject("Start recovery", projectRoot, true);
  const profile = store.nextProfileGeneration(store.createProfile("Start recovery").id);
  const startIdempotencyKey = randomUUID();
  const input = { profileId: profile.id, projectId: project.id, startIdempotencyKey };
  const runtime = { profileId: profile.id, processGeneration: profile.processGeneration, observedAt: Date.now(),
    preset: "fable-max" as const, model: CLAUDE_PIN_MODEL, reasoningEffort: "max" as const,
    claudeVersion: CLAUDE_PIN, permissionMode: "default" as const, configHome: "isolated" as const,
    inputFormat: "stream-json" as const, outputFormat: "stream-json" as const };
  const prepare = () => store.prepareMutation({ kind: "session.start", authorityId: profile.id,
    authorityGeneration: profile.processGeneration, idempotencyKey: startIdempotencyKey,
    request: { projectId: project.id, provider: "claude", preset: "fable-max", fast: false } });
  const apply = () => {
    const start = prepare();
    const session = store.beginSessionStartEffect({ attemptId: start.id, profileId: profile.id,
      profileGeneration: profile.processGeneration, projectId: project.id, provider: "claude", preset: "fable-max",
      fastEnabled: false, providerAccountKey: `v1:claude:${sha("start recovery account")}`,
      providerAuthentication: { profileId: profile.id, processGeneration: profile.processGeneration, provider: "claude", signedIn: true },
      evidence: { kind: "session.start", projectId: project.id, clientMessageId: null, messageDigest: null,
        runtimeProfile: runtime, conversationAutomationCapability: SESSION_CONVERSATION_AUTOMATION_CAPABILITY },
      hostCapabilities: { preambleVersion: HRA_SESSION_PREAMBLE.version, preambleDigest: HRA_SESSION_PREAMBLE.digest,
        manifestVersion: HRA_SESSION_PREAMBLE.manifestVersion, manifestDigest: HRA_SESSION_PREAMBLE.manifestDigest } });
    const providerThreadId = randomUUID();
    const identity = { pid: 40002, pidDomain: "linux" as const, procStart: "synthetic-start-recovery" };
    store.recordClaimedClaudeProcessAuthority({ providerThreadId, profileId: profile.id,
      profileGeneration: profile.processGeneration, runtimeScope: "managed", sessionId: session.id, identity });
    store.completeSessionStartEffect({ attemptId: start.id, sessionId: session.id, expectedSessionRevision: session.revision,
      providerThreadId, state: "idle", runtimeProfile: runtime, claudeProcessIdentity: identity,
      receipt: { sessionId: session.id, effectiveRuntimeProfile: runtime } });
    const release = () => {
      const process = store.readSessionClaudeProcessAuthority(session.id);
      if (process === null) throw new Error("fixture_start_process_missing");
      const releasing = store.beginClaudeProcessAuthorityRelease({ profileId: profile.id, runtimeScope: "managed",
        providerThreadId, expectedRevision: process.revision, identity });
      store.completeClaudeProcessAuthorityRelease({ profileId: profile.id, runtimeScope: "managed",
        providerThreadId, expectedRevision: releasing.revision, identity });
      store.advanceProfileGeneration(profile.id, profile.processGeneration);
    };
    return { session, start, release };
  };
  const oracle = (signal = new AbortController().signal) => createClaudeLiveAcceptanceReadback({ paths, signal,
    inspectLiveProcess: async () => { throw new Error("scope_recovery_must_not_inspect_argv"); },
    processProbe: async () => { throw new Error("scope_recovery_must_not_claim_liveness"); } });
  return { input, profile, paths, store, prepare, apply, oracle };
};

describe("independent Claude private readback", () => {
  test("lost-start scope returns null only for a proved no-effect fresh profile", async () => {
    const f = await startOnlyFixture();
    expect(await f.oracle().recoverStartedSessionScope(f.input)).toBeNull();
    f.prepare();
    await expect(f.oracle().recoverStartedSessionScope(f.input)).rejects.toThrow("claude_live_acceptance_readback_refused");
  });

  test("recovers only exact direct-applied start scope before and after process release", async () => {
    const f = await startOnlyFixture(); const started = f.apply();
    const expected = { sessionId: started.session.id, profileGeneration: f.profile.processGeneration };
    const first = f.oracle();
    const scope = await first.recoverStartedSessionScope(f.input);
    expect(scope).toEqual(expected);
    expect(Object.isFrozen(scope)).toBe(true);
    await expect(first.recoverStartedSessionScope(f.input)).rejects.toThrow("claude_live_acceptance_readback_refused");
    started.release();
    const stopped = f.oracle();
    expect(await stopped.recoverStartedSessionScope(f.input)).toEqual(expected);
    expect(scope).not.toHaveProperty("processNotLive");
    expect(scope).not.toHaveProperty("soleRemember");
  });

  test("lost-start scope refuses foreign key/profile/project, extra fields, and changed generation", async () => {
    const f = await startOnlyFixture(); const started = f.apply();
    const otherProfile = f.store.createProfile("Other scope");
    await mkdir(join(f.paths.root, "other-project"), { mode: 0o700 });
    const otherProject = await f.store.createProject("Other project", join(f.paths.root, "other-project"), false);
    for (const input of [{ ...f.input, startIdempotencyKey: randomUUID() },
      { ...f.input, profileId: otherProfile.id }, { ...f.input, projectId: otherProject.id }, { ...f.input, extra: true }]) {
      await expect(f.oracle().recoverStartedSessionScope(input)).rejects.toThrow("claude_live_acceptance_readback_refused");
    }
    started.release();
    f.store.advanceProfileGeneration(f.profile.id, f.profile.processGeneration + 1);
    await expect(f.oracle().recoverStartedSessionScope(f.input)).rejects.toThrow("claude_live_acceptance_readback_refused");
  });

  test("lost-start scope refuses a later send instead of adopting its session", async () => {
    const f = await fixture();
    await expect(f.oracle().recoverStartedSessionScope({ profileId: f.profile.id, projectId: f.input.projectId,
      startIdempotencyKey: f.input.startIdempotencyKey })).rejects.toThrow("claude_live_acceptance_readback_refused");
  });

  test("lost-start scope brackets authority changes between the two readonly snapshots", async () => {
    const f = await startOnlyFixture(); const started = f.apply(); started.release();
    const signal = new AbortController().signal;
    const original = signal.throwIfAborted.bind(signal);
    let checks = 0;
    Object.defineProperty(signal, "throwIfAborted", { value: () => {
      original();
      if (++checks === 3) f.store.advanceProfileGeneration(f.profile.id, f.profile.processGeneration + 1);
    } });
    await expect(f.oracle(signal).recoverStartedSessionScope(f.input)).rejects.toThrow("claude_live_acceptance_readback_refused");
    expect(checks).toBeGreaterThanOrEqual(3);
  });

  test("corroborates real durable rows and exact artifacts before and after shutdown", async () => {
    const f = await fixture();
    expect(f.store.requireProfile(f.profile.id).state).toBe("signed_out");
    const oracle = f.oracle();
    const live = await oracle.captureLive(f.input);
    expect(live).toMatchObject({ phase: "live", soleRemember: true, managedClaudeSignedIn: true,
      proofBindingDigest: f.input.receipt.candidateBindingDigest });
    const stopped = await oracle.verifyStopped({ receipt: await f.stop() });
    expect(stopped).toMatchObject({ phase: "stopped", snapshotDigest: live.snapshotDigest,
      processReleased: true, processNotLive: true, privateArtifactsAbsent: true, lifecycleInvalidated: true });
    expect(JSON.stringify(stopped)).not.toContain(f.root);
    expect(JSON.stringify(stopped)).not.toContain(f.session.id);
    expect(JSON.stringify(stopped)).not.toContain("40001");
    await expect(oracle.verifyStopped({ receipt: { ...f.input.receipt, lifecycleInvalidated: true } }))
      .rejects.toThrow("claude_live_acceptance_readback_refused");
  });

  test.each(["nonce", "key", "attestation", "extra-row", "continuation", "canonical", "auth", "send", "start", "extra-field",
    "epoch", "owner", "status-head", "status-session", "status-project", "status-extra"])(
    "refuses mismatched independent %s evidence", async (kind) => {
      const f = await fixture();
      const input = structuredClone(f.input);
      const row = input.workingQuery.rows[0];
      if (row === undefined) throw new Error("fixture row missing");
      if (kind === "nonce") row.bodyChunk += "wrong";
      if (kind === "key") row.key += "wrong";
      if (kind === "attestation") row.provenance.attestationSha256 = sha("wrong");
      if (kind === "extra-row") input.workingQuery.rows.push(row);
      if (kind === "continuation") Object.assign(input.workingQuery, { continuation: "memc_unexpected" });
      if (kind === "canonical") row.lane = "canonical";
      if (kind === "auth") Object.assign(input.claudeAuthentication, { signedIn: false });
      if (kind === "send") input.sendIdempotencyKey = randomUUID();
      if (kind === "start") input.startIdempotencyKey = randomUUID();
      if (kind === "extra-field") Object.assign(input.receipt, { extra: true });
      if (kind === "epoch") input.memoryStatus.working.epoch = 2;
      if (kind === "owner") input.memoryStatus.working.ownerMatchesSession = false;
      if (kind === "status-head") input.memoryStatus.working.head = { ...input.memoryStatus.working.head, digest: sha("wrong") };
      if (kind === "status-session") input.memoryStatus.sessionId = `sess_${"0".repeat(32)}`;
      if (kind === "status-project") input.memoryStatus.projectId = `proj_${"0".repeat(32)}`;
      if (kind === "status-extra") Object.assign(input.memoryStatus, { extra: true });
      await expect(f.oracle().captureLive(input)).rejects.toThrow("claude_live_acceptance_readback_refused");
    },
  );

  test("refuses another retained submission even when it was cancelled", async () => {
    const f = await fixture();
    const extra = f.store.prepareMemorySubmission({ actorSessionId: f.session.id, projectId: f.input.projectId,
      kind: "remember", requestDigest: sha("extra"), contentDigest: sha("extra content"), keyDigest: sha("extra key"),
      workingBindingDigest: f.submission.workingBindingDigest, workingEpoch: 1,
      expectedHead: { sequence: 1, operationSha256: f.input.receipt.result.workingHead.operationSha256,
        headDigest: f.input.receipt.result.workingHead.digest }, idempotencyKey: randomUUID() }).record;
    f.store.cancelPreparedMemorySubmission(extra.id);
    await expect(f.oracle().captureLive(f.input)).rejects.toThrow("claude_live_acceptance_readback_refused");
  });

  test("refuses a retained attestation whose exact working reference was removed", async () => {
    const f = await fixture();
    f.store.reserveMemoryWorkingPageAttestationFork({ childBindingDigest: sha("other binding"),
      childSessionId: `sess_${"f".repeat(32)}`, parentBindingDigest: f.submission.workingBindingDigest,
      parentHead: f.input.receipt.result.workingHead });
    expect(f.store.purgeMemoryWorkingPageAttestations({ bindingDigest: f.submission.workingBindingDigest })).toBe(1);
    expect(f.store.findMemoryPageAttestation(f.input.workingQuery.rows[0]?.provenance.attestationSha256 ?? "")).not.toBeNull();
    await expect(f.oracle().captureLive(f.input)).rejects.toThrow("claude_live_acceptance_readback_refused");
  });

  test("freezes caller evidence before asynchronous observations", async () => {
    const f = await fixture();
    const input = structuredClone(f.input);
    const oracle = f.oracle(async () => {
      Object.assign(input.receipt.memory, { title: "caller changed this after capture began" });
      input.memoryStatus.working.epoch = 2;
      await Promise.resolve();
    });
    const live = await oracle.captureLive(input);
    expect(await oracle.verifyStopped({ receipt: await f.stop() })).toMatchObject({ phase: "stopped", snapshotDigest: live.snapshotDigest });
  });

  test("refuses failed argv custody and artifacts changed during process inspection", async () => {
    const f = await fixture();
    await expect(f.oracle(async () => { throw new Error("synthetic custody refusal"); }).captureLive(f.input))
      .rejects.toThrow("claude_live_acceptance_readback_refused");
    await expect(f.oracle(async () => { await writeFile(f.configPath, JSON.stringify({ extra: true })); }).captureLive(f.input))
      .rejects.toThrow("claude_live_acceptance_readback_refused");
  });

  test.each(["symlink", "hardlink", "oversize", "binding", "config", "mode", "extra-binding", "extra-file", "invalid-utf8"])(
    "refuses %s private artifacts without leaking their bytes", async (kind) => {
      const f = await fixture();
      if (kind === "symlink") {
        const target = join(f.directory, "target.json");
        await writeFile(target, JSON.stringify(f.binding), { mode: 0o600 });
        await rm(f.bindingPath); await symlink(target, f.bindingPath);
      }
      if (kind === "oversize") await writeFile(f.bindingPath, "x".repeat(8193));
      if (kind === "hardlink") await link(f.bindingPath, join(f.paths.runtime, "linked-binding.json"));
      if (kind === "binding") await writeFile(f.bindingPath, JSON.stringify({ ...f.binding, bindingId: `clhb_${"0".repeat(32)}` }));
      if (kind === "config") await writeFile(f.configPath, JSON.stringify({ ...f.config, extra: "private" }));
      if (kind === "mode") await chmod(f.configPath, 0o644);
      if (kind === "extra-binding") await mkdtemp(join(f.paths.runtime, ".hra-claude-host-tools-"));
      if (kind === "extra-file") await writeFile(join(f.directory, "extra.json"), "{}", { mode: 0o600 });
      if (kind === "invalid-utf8") await writeFile(f.bindingPath, new Uint8Array([0x22, 0xff, 0x22]));
      await expect(f.oracle().captureLive(f.input)).rejects.toThrow("claude_live_acceptance_readback_refused");
    },
  );

  test("requires live and then exact not-live process observations", async () => {
    const f = await fixture();
    f.setLiveness("unknown");
    await expect(f.oracle().captureLive(f.input)).rejects.toThrow("claude_live_acceptance_readback_refused");
    f.setLiveness("live");
    const oracle = f.oracle();
    await oracle.captureLive(f.input);
    const receipt = await f.stop();
    f.setLiveness("live");
    await expect(oracle.verifyStopped({ receipt })).rejects.toThrow("claude_live_acceptance_readback_refused");
  });

  test("requires removed artifacts even after exact process release", async () => {
    const f = await fixture();
    const oracle = f.oracle();
    await oracle.captureLive(f.input);
    const receipt = await f.stop();
    await mkdir(f.directory, { mode: 0o700 });
    await writeFile(f.configPath, JSON.stringify(f.config), { mode: 0o600 });
    await expect(oracle.verifyStopped({ receipt })).rejects.toThrow("claude_live_acceptance_readback_refused");
  });

  test("refuses authority changed during the stopped process observation", async () => {
    const f = await fixture();
    const oracle = f.oracle();
    await oracle.captureLive(f.input);
    const receipt = await f.stop();
    f.observeProcess(() => { f.store.advanceProfileGeneration(f.profile.id, f.profile.processGeneration + 1); });
    await expect(oracle.verifyStopped({ receipt })).rejects.toThrow("claude_live_acceptance_readback_refused");
  });

  test("does not accept an early stop, a changed final receipt, or an aborted reader", async () => {
    const f = await fixture();
    const oracle = f.oracle();
    await expect(oracle.verifyStopped({ receipt: { ...f.input.receipt, lifecycleInvalidated: true } }))
      .rejects.toThrow("claude_live_acceptance_readback_refused");
    const valid = f.oracle();
    await valid.captureLive(f.input);
    const receipt = await f.stop();
    await expect(valid.verifyStopped({ receipt: { ...receipt, callId: "wrong" } }))
      .rejects.toThrow("claude_live_acceptance_readback_refused");
    const controller = new AbortController(); controller.abort();
    const aborted = createClaudeLiveAcceptanceReadback({ paths: f.paths, signal: controller.signal,
      inspectLiveProcess: async () => { throw new Error("must not inspect"); } });
    await expect(aborted.captureLive(f.input)).rejects.toThrow("claude_live_acceptance_readback_refused");
  });

  test("cleanup-only proves retained released custody without minting acceptance proof", async () => {
    const f = await fixture();
    const input = { profileId: f.profile.id, profileGeneration: f.profile.processGeneration, sessionId: f.session.id };
    await expect(f.oracle().verifyCleanupStoppedCustody(input)).rejects.toThrow("claude_live_acceptance_readback_refused");
    await f.stop();
    const oracle = f.oracle();
    const evidence = await oracle.verifyCleanupStoppedCustody(input);
    expect(evidence).toMatchObject({ source: "independent_cleanup_readback", phase: "cleanup_stopped",
      retainedSessionProcess: "released_not_live", unreleasedProcessesAbsent: true, privateArtifactsAbsent: true,
      scopeBindingDigest: canonicalSha256({ domain: "hra.claude.cleanup-readback.v1", ...input }) });
    expect(evidence).not.toHaveProperty("soleRemember");
    expect(JSON.stringify(evidence)).not.toContain(f.session.id);
    await expect(oracle.captureLive(f.input)).rejects.toThrow("claude_live_acceptance_readback_refused");
  });

  test("cleanup-only refuses missing staged session, wrong generation, extra input, artifacts, and unknown liveness", async () => {
    const f = await fixture();
    await f.stop();
    const input = { profileId: f.profile.id, profileGeneration: f.profile.processGeneration, sessionId: f.session.id };
    for (const invalid of [{ profileId: f.profile.id }, { ...input, profileGeneration: input.profileGeneration + 1 },
      { profileId: input.profileId, sessionId: input.sessionId }, { ...input, extra: true }]) {
      await expect(f.oracle().verifyCleanupStoppedCustody(invalid)).rejects.toThrow("claude_live_acceptance_readback_refused");
    }
    f.setLiveness("unknown");
    await expect(f.oracle().verifyCleanupStoppedCustody(input)).rejects.toThrow("claude_live_acceptance_readback_refused");
    f.setLiveness("not_live");
    await mkdir(f.directory, { mode: 0o700 });
    await expect(f.oracle().verifyCleanupStoppedCustody(input)).rejects.toThrow("claude_live_acceptance_readback_refused");
  });

  test("cleanup-only refuses authority changed during its stopped observation", async () => {
    const f = await fixture();
    await f.stop();
    f.observeProcess(() => { f.store.advanceProfileGeneration(f.profile.id, f.profile.processGeneration + 1); });
    await expect(f.oracle().verifyCleanupStoppedCustody({ profileId: f.profile.id,
      profileGeneration: f.profile.processGeneration, sessionId: f.session.id })).rejects.toThrow("claude_live_acceptance_readback_refused");
  });

  test("cleanup before native start proves no sessions or unsettled start, not provider receipt consumption", async () => {
    const root = await realpath(await mkdtemp("/tmp/hra-clrb-empty-"));
    const paths = resolveStatePaths({ rootDirectory: root });
    await initializeStatePaths(paths);
    const store = new StateStore(paths);
    cleanups.push(async () => { store.close(); await rm(root, { recursive: true }); });
    const profile = store.createProfile("Cleanup before native start");
    const oracle = () => createClaudeLiveAcceptanceReadback({ paths, signal: new AbortController().signal,
      inspectLiveProcess: async () => { throw new Error("no live process to inspect"); },
      processProbe: async () => { throw new Error("no process identity to inspect"); } });
    expect(await oracle().verifyCleanupStoppedCustody({ profileId: profile.id, profileGeneration: profile.processGeneration }))
      .toMatchObject({ retainedSessionProcess: "absent", phase: "cleanup_stopped" });
    const mutation = store.prepareMutation({ kind: "session.start", authorityId: profile.id,
      authorityGeneration: profile.processGeneration, idempotencyKey: randomUUID(), request: { synthetic: true } });
    expect(store.transitionMutation(mutation.id, "prepared", "effect_started")).toBe(true);
    await expect(oracle().verifyCleanupStoppedCustody({ profileId: profile.id }))
      .rejects.toThrow("claude_live_acceptance_readback_refused");
  });
});
