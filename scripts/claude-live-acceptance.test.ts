import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  CLAUDE_PIN,
  CLAUDE_PIN_EFFORT,
  CLAUDE_PIN_MODEL,
  digestClaudeHostToolInvocation,
} from "../src/claude/index";
import { publicInteractionSchema, type PublicInteraction } from "../src/domain/interactions";
import type { LocalCommand } from "../src/domain/contracts";
import type { HraMemoryRememberInput } from "../src/domain/host-tools";
import { HRA_VERSION } from "../src/version";
import { projectPublicProviderIdentifier } from "../src/public-provider-identifier";
import {
  ClaudeLiveAcceptanceProofCollector,
  ClaudeLiveAcceptanceProofError,
  type ClaudeLiveAcceptancePrivateReceipt,
  type ClaudeLiveAcceptanceProvisionalPrivateReceipt,
} from "./claude-live-acceptance-proof";
import {
  parseClaudeLiveAcceptanceLogoutPreflightReceipt,
  type ClaudeLiveAcceptanceLogoutController,
} from "./claude-live-acceptance-logout";
import type {
  ClaudeLiveAcceptanceCleanupEvidence,
  ClaudeLiveAcceptanceReadback,
  ClaudeLiveAcceptanceReadbackEvidence,
} from "./claude-live-acceptance-readback";
import {
  claudeLiveAcceptanceEvidenceSchema,
  claudeLiveAcceptanceRecoveryPolicy,
  claudeLiveAcceptanceRecoveryReceiptSchema,
  createClaudeLiveAcceptanceSignalCustody,
  parseClaudeLiveAcceptanceArguments,
  runClaudeLiveAcceptance,
  type ClaudeLiveAcceptanceRecoveryReceipt,
} from "./claude-live-acceptance";
import type {
  AcceptanceInstallationDescriptor,
  LiveAcceptanceCandidate,
} from "./live-acceptance-installation";
import type {
  ClaudeLiveAcceptanceWorker,
  LiveAcceptanceCliResult,
} from "./live-acceptance";
import {
  acquireClaudeLiveAcceptanceOwner,
} from "./claude-live-acceptance-owner";
import {
  AtomicPrivateJsonReceipt,
  observePrivateDirectory,
} from "./live-acceptance-private-custody";
import { canonicalDigest } from "./release-evidence";
import {
  privateDescriptorFixtureEnvironment,
  privateDescriptorFixtureFailure,
  privateDescriptorFixtureFailureMessage,
  runPrivateDescriptorFixture,
} from "./private-descriptor-test-fixture";

const profileId = `acct_${"1".repeat(32)}` as const;
const projectId = `proj_${"2".repeat(32)}` as const;
const sessionId = `sess_${"3".repeat(32)}` as const;
const providerThreadId = "claude-live-provider-thread";
const providerTurnId = "claude-live-provider-turn";
const connectionId = "00000000-0000-4000-8000-000000000441";
const publicTurnId = projectPublicProviderIdentifier(
  "claude-live-provider-turn",
  Buffer.alloc(32, 0x51),
);
const publicItemId = projectPublicProviderIdentifier(
  "claude-live-provider-item",
  Buffer.alloc(32, 0x51),
);
const operationSha256 = "4".repeat(64);
const recordSha256 = "5".repeat(64);
const receiptSha256 = "6".repeat(64);
const workingDigest = "7".repeat(64);
const submissionId = `memsub_${"8".repeat(32)}`;
const candidate: LiveAcceptanceCandidate = {
  cloudTargetDigest: "9".repeat(64),
  packageVersion: HRA_VERSION,
  sourceRevision: "a".repeat(40),
};

const envelope = (command: string, data: unknown): LiveAcceptanceCliResult => ({
  exitCode: 0,
  stderr: "",
  stdout: JSON.stringify({ command, data, ok: true, version: 1 }),
});

const cursor = (sequence: number): string =>
  `hra1.${Buffer.from(`claude-runner:${String(sequence)}`).toString("base64url")}.${"A".repeat(43)}`;

const runtimeProfile = {
  claudeVersion: CLAUDE_PIN,
  inputFormat: "stream-json",
  model: CLAUDE_PIN_MODEL,
  observedAt: 2_000,
  outputFormat: "stream-json",
  permissionMode: "default",
  preset: "fable-max",
  processGeneration: 3,
  profileId,
  reasoningEffort: CLAUDE_PIN_EFFORT,
} as const;

const publicSession = (state: "active" | "idle") => ({
  ...(state === "active" ? { activeTurnId: publicTurnId } : {}),
  createdAt: 1_000,
  fastEnabled: false,
  id: sessionId,
  preset: "fable-max",
  profileId,
  projectId,
  provider: "claude",
  revision: state === "active" ? 2 : 3,
  state,
  title: "Claude live acceptance",
  updatedAt: state === "active" ? 2_000 : 3_000,
});

function pendingInteraction(): PublicInteraction {
  return publicInteractionSchema.parse({
    blocking: true,
    context: { itemId: null, turnId: publicTurnId },
    deadlineAt: 60_000,
    display: {
      allowsSessionScope: false,
      kind: "permission_approval",
      reason: null,
      requested: [{ name: "mcp__hra__memory_remember" }],
      summary: "Allow one exact HRA memory receipt",
    },
    id: "00000000-0000-4000-8000-000000000442",
    kind: "permission_approval",
    requestedAt: 1_000,
    responseRecorded: false,
    revision: 1,
    sessionId,
    state: "pending",
    terminalAt: null,
    updatedAt: 1_000,
    version: 1,
  });
}

const writtenInteraction = (pending: PublicInteraction): PublicInteraction =>
  publicInteractionSchema.parse({
    ...pending,
    responseRecorded: true,
    revision: 3,
    state: "response_written",
    updatedAt: 3_000,
  });

function sessionEventPage(prompt: string, interaction: PublicInteraction) {
  const written = writtenInteraction(interaction);
  const nonceMatch = /claude-live-[0-9a-f]{32}/u.exec(prompt);
  if (nonceMatch === null) throw new Error("missing synthetic nonce");
  const echo = JSON.stringify({ nonce: nonceMatch[0], receiptSha256, submissionId });
  const bodies = [
    { type: "connection", state: "connected" },
    { type: "turn_started", turnId: publicTurnId },
    {
      blocking: true,
      interactionId: interaction.id,
      interactionKind: "permission_approval",
      revision: 1,
      summary: interaction.display.summary,
      type: "interaction_requested",
    },
    { interactionId: interaction.id, revision: 2, state: "response_prepared", type: "interaction_state" },
    { interactionId: interaction.id, revision: 3, state: "response_written", type: "interaction_state" },
    { itemId: publicItemId, text: echo, turnId: publicTurnId, type: "assistant_delta" },
    { status: "completed", turnId: publicTurnId, type: "turn_completed" },
    { actor: "human", omittedCharacters: 0, text: prompt, turnId: publicTurnId, type: "user_message" },
    { activeTurnId: null, status: "idle", type: "session_status" },
  ];
  const events = bodies.map((body, index) => ({
    accountId: profileId,
    body,
    providerConnectionId: connectionId,
    providerGeneration: 3,
    recordedAt: 10_000 + index,
    sequence: index + 1,
    sessionId,
    streamEpoch: "00000000-0000-4000-8000-000000000443",
    version: 1,
  }));
  return {
    events,
    gap: null,
    nextCursor: cursor(events.length),
    observedThroughCursor: cursor(events.length),
    requestedCursor: null,
    retentionFloorCursor: cursor(0),
    sessionId,
    version: 1,
    written,
  };
}

class FakeClaudeWorker implements ClaudeLiveAcceptanceWorker {
  readonly device = "a" as const;
  readonly pid = 91_001;
  readonly projectDirectory: string;
  readonly #candidate: LiveAcceptanceCandidate;
  readonly #phaseTrace: string[];
  readonly #runId: string;
  readonly interaction = pendingInteraction();
  collector: ClaudeLiveAcceptanceProofCollector | undefined;
  memory: HraMemoryRememberInput | undefined;
  prompt = "";
  stopCalls = 0;
  stopWithProofCalls = 0;
  preserveCalls = 0;
  refuseFinalProof = false;
  failStartAfterEffect = false;

  constructor(descriptor: AcceptanceInstallationDescriptor, phaseTrace: string[]) {
    if (descriptor.candidate === undefined) throw new Error("candidate missing");
    this.#candidate = descriptor.candidate;
    this.#phaseTrace = phaseTrace;
    this.#runId = descriptor.runId;
    this.projectDirectory = descriptor.documentsDirectory;
  }

  async ready(): Promise<void> {}
  async currentDaemonGeneration(): Promise<number> { return 1; }
  async armClaudeProof(input: Parameters<ClaudeLiveAcceptanceWorker["armClaudeProof"]>[0]): Promise<void> {
    this.memory = input.memory;
    this.collector = new ClaudeLiveAcceptanceProofCollector({ candidate: this.#candidate, runId: this.#runId });
    this.collector.beginDaemonGeneration(input.daemonGeneration);
    this.collector.armFreshSession({ ...input, providerThreadId });
  }

  async execute(
    argv: readonly string[],
    options: Readonly<{ protectedDocument?: unknown }> = {},
  ): Promise<LiveAcceptanceCliResult> {
    const key = `${argv[0] ?? ""}.${argv[1] ?? ""}`;
    if (key === "account.add") {
      return envelope("account.add", {
        account: {
          id: profileId,
          label: argv[2],
          processGeneration: 0,
          state: "signed_out",
          updatedAt: 1_000,
        },
        next: `hra account login ${profileId}`,
      });
    }
    if (key === "account.show") {
      return envelope("account.show", {
        account: { id: profileId, label: `hra-claude-live-${this.#runId.replaceAll("-", "").slice(0, 12)}` },
        authentication: { provider: "claude", signedIn: true },
        providerGeneration: 3,
      });
    }
    if (key === "project.add") return envelope("project.add", { project: { id: projectId } });
    if (key === "session.start") {
      if (this.failStartAfterEffect) throw new Error("synthetic lost start response");
      return envelope("session.start", {
        effectiveRuntimeProfile: runtimeProfile,
        idempotencyKey: argv[argv.indexOf("--idempotency-key") + 1],
        session: publicSession("idle"),
      });
    }
    if (key === "autorespond.off") return envelope("autorespond.set", { enabled: false });
    if (key === "session.send") {
      this.prompt = argv[3] ?? "";
      this.collector?.corroborateAppliedSend({
        daemonGeneration: 1,
        idempotencyKey: argv[argv.indexOf("--idempotency-key") + 1] ?? "",
        sessionId,
        turnId: providerTurnId,
      });
      return envelope("session.send", {
        effectiveRuntimeProfile: runtimeProfile,
        idempotencyKey: argv[argv.indexOf("--idempotency-key") + 1],
        session: publicSession("idle"),
      });
    }
    if (key === "interaction.list") {
      return envelope("interaction.list", {
        interactions: [this.interaction],
        nextCursor: null,
        sessionId,
      });
    }
    if (key === "interaction.inspect") {
      const path = argv[argv.indexOf("--handoff-file") + 1];
      if (path === undefined) throw new Error("handoff path missing");
      await writeFile(path, JSON.stringify({
        authority: {
          environmentId: null,
          kind: "permission_approval",
          permissions: ["mcp__hra__memory_remember"],
          reason: "One exact memory tool",
          workingDirectory: this.projectDirectory,
        },
        binding: {
          connectionId,
          interactionId: this.interaction.id,
          kind: "permission_approval",
          processGeneration: 3,
          profileId,
          revision: this.interaction.revision,
          sessionId,
        },
        type: "hra_protected_interaction_detail",
        version: 1,
      }));
      return envelope("interaction.inspect", {
        interactionId: this.interaction.id,
        protectedOutput: {
          disposition: "preserved_caller_removes_after_decision",
          documentVersion: 1,
          path,
          status: "written",
        },
        revision: this.interaction.revision,
      });
    }
    if (key === "interaction.grant") {
      expect(options.protectedDocument).toEqual({ permissions: ["mcp__hra__memory_remember"] });
      if (this.collector === undefined || this.memory === undefined) throw new Error("collector not armed");
      const callId = "claude-live-call";
      const request = { input: this.memory, tool: "memory_remember" as const };
      const requestDigest = digestClaudeHostToolInvocation(callId, request);
      const result = {
        idempotencyRetainedUntil: "2026-09-07T00:00:00.000Z",
        ok: true as const,
        page: { key: this.memory.key, operationSha256, recordSha256 },
        receiptSha256,
        replay: false as const,
        submission: { id: submissionId, kind: "remember" as const, state: "applied" as const },
        version: 1 as const,
        workingHead: { digest: workingDigest, operationSha256, sequence: 1 },
      };
      await this.collector.handleManagedHostToolCall({
        authority: {
          codexHome: join(this.projectDirectory, ".synthetic-codex-home"),
          desktopUserData: join(this.projectDirectory, ".synthetic-desktop-data"),
          generation: 3,
          id: profileId,
        },
        call: {
          authority: { processGeneration: 3, profileId },
          callId,
          connectionId,
          input: this.memory,
          requestDigest,
          requestId: { type: "string", value: callId },
          threadId: providerThreadId,
          tool: "memory_remember",
          turnId: providerTurnId,
        },
        dispatch: async () => result,
      });
      this.collector.handleManagedHostToolResponseWritten({
        bindingId: "claude-live-binding",
        callId,
        processGeneration: 3,
        profileId,
        provider: "claude",
        providerThreadId,
        request,
        requestDigest,
      });
      return envelope("interaction.grant", {
        interaction: writtenInteraction(this.interaction),
        responseWritten: true,
      });
    }
    if (key === "session.events") {
      const page = sessionEventPage(this.prompt, this.interaction);
      return envelope("session.events", {
        events: page.events,
        gap: page.gap,
        nextCursor: page.nextCursor,
        observedThroughCursor: page.observedThroughCursor,
        requestedCursor: page.requestedCursor,
        retentionFloorCursor: page.retentionFloorCursor,
        sessionId: page.sessionId,
        version: page.version,
      });
    }
    if (key === "memory.get") return envelope("memory.query", { synthetic: "working" });
    if (key === "memory.status") return envelope("memory.status", { synthetic: "status" });
    throw new Error(`unexpected synthetic command: ${argv.join(" ")}`);
  }

  async readClaudeProvisionalProof(): Promise<ClaudeLiveAcceptanceProvisionalPrivateReceipt | null> {
    return this.collector?.readProvisionalPrivateReceipt() ?? null;
  }
  async stopWithClaudeProof(): Promise<ClaudeLiveAcceptancePrivateReceipt> {
    this.stopWithProofCalls += 1;
    if (this.collector === undefined) {
      throw new ClaudeLiveAcceptanceProofError("proof_incomplete");
    }
    this.collector.closeDaemonGeneration(1);
    if (this.refuseFinalProof) throw new ClaudeLiveAcceptanceProofError("proof_incomplete");
    const receipt = this.collector.readPrivateReceipt();
    this.#phaseTrace.push("stop-proved");
    return receipt;
  }
  async stop(): Promise<void> { this.stopCalls += 1; }
  async preserve(): Promise<void> { this.preserveCalls += 1; }
  async command(command: LocalCommand): Promise<never> {
    void command;
    throw new Error("foreground login is injected");
  }
  async armCanonicalMemoryResponseDrop(): Promise<never> { throw new Error("not supported"); }
  async canonicalMemoryResponseDropStatus(): Promise<never> { throw new Error("not supported"); }
  async finalizeCanonicalMemoryResponseDrop(): Promise<never> { throw new Error("not supported"); }
  async suspend(): Promise<never> { throw new Error("not supported"); }
  async resume(): Promise<never> { throw new Error("not supported"); }
  async lifetime(): Promise<void> {}
  async failure(): Promise<never> { return await new Promise<never>(() => undefined); }
}

const directoryIdentity = (path: string, inode: number) => ({
  device: 1,
  inode,
  mode: 0o700 as const,
  owner: process.getuid?.() ?? 0,
  path,
});

function logoutPreflight(descriptor: AcceptanceInstallationDescriptor) {
  const base = {
    candidate,
    configDirectory: directoryIdentity(join(descriptor.rootDirectory, "logout-config"), 101),
    helpSha256: "b".repeat(64),
    phase: "preflight_complete" as const,
    profileId,
    runId: descriptor.runId,
    runtimeVersion: "2.1.260" as const,
    temporaryDirectory: directoryIdentity(join(descriptor.rootDirectory, "logout-tmp"), 102),
    version: 1 as const,
  };
  return parseClaudeLiveAcceptanceLogoutPreflightReceipt({
    ...base,
    bindingDigest: canonicalDigest({
      ...base,
      domain: "hra-live-acceptance-claude-logout-preflight-v1",
    }),
  });
}

const liveReadback = (
  receipt: Pick<ClaudeLiveAcceptanceProvisionalPrivateReceipt, "candidateBindingDigest">,
): ClaudeLiveAcceptanceReadbackEvidence => ({
  directSend: true,
  hostBinding: true,
  managedClaudeSignedIn: true,
  nativeStart: true,
  phase: "live",
  pinnedProcessArgv: true,
  processArgvDigest: "c".repeat(64),
  processBound: true,
  proofBindingDigest: receipt.candidateBindingDigest,
  snapshotDigest: "d".repeat(64),
  soleRemember: true,
  source: "independent_private_readback",
  version: 1,
  workingPage: true,
});

const stoppedReadback = (
  receipt: ClaudeLiveAcceptancePrivateReceipt,
): ClaudeLiveAcceptanceReadbackEvidence => ({
  ...liveReadback(receipt),
  lifecycleInvalidated: true,
  phase: "stopped",
  privateArtifactsAbsent: true,
  processNotLive: true,
  processReleased: true,
});

async function withPrivateDirectory(
  operation: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "hra-claude-runner-test-"));
  await chmod(directory, 0o700);
  try {
    await operation(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function testLayout(directory: string, value: LiveAcceptanceCandidate) {
  const runId = randomUUID();
  const runRootPath = join(directory, `hra-live-acceptance-${runId}-test`);
  const statePath = join(runRootPath, "device-a-test");
  const projectPath = join(runRootPath, "project-a-test");
  await mkdir(statePath, { mode: 0o700, recursive: true });
  await mkdir(projectPath, { mode: 0o700 });
  return {
    descriptor: {
      candidate: value,
      device: "a" as const,
      documentsDirectory: projectPath,
      expectedHomeDirectory: homedir(),
      rootDirectory: statePath,
      runId,
      type: "hra-live-acceptance-device" as const,
      version: 1 as const,
    },
    project: await observePrivateDirectory(projectPath, () => new Error("project_invalid")),
    receiptPath: join(directory, `.hra-live-claude-acceptance-${runId}.recovery.json`),
    runRoot: await observePrivateDirectory(runRootPath, () => new Error("root_invalid")),
    state: await observePrivateDirectory(statePath, () => new Error("state_invalid")),
  };
}

function fakeLogoutFactory(input: Readonly<{
  descriptor: AcceptanceInstallationDescriptor;
  phaseTrace?: string[];
  persistAttempt(marker: never): Promise<void>;
}>): ClaudeLiveAcceptanceLogoutController {
  const preflight = logoutPreflight(input.descriptor);
  return {
    close(): void {},
    async logoutAfterStoppedOracle() {
      input.phaseTrace?.push("logout");
      return { helpSha256: preflight.helpSha256, logoutDispatched: false,
        recovered: false, signedOut: true as const, version: "2.1.260" as const };
    },
    async preflightBeforeLogin() {
      return { helpSha256: preflight.helpSha256, receipt: preflight, version: "2.1.260" as const };
    },
    async recoverUncertainLogout() { throw new Error("not expected"); },
    async resumeCleanupAfterStoppedCustody() {
      return { logoutDispatched: false, preflightBindingDigest: preflight.bindingDigest,
        recovered: true, signedOut: true as const, source: "cleanup_only" as const,
        version: "2.1.260" as const };
    },
  };
}

const cleanupEvidence = (input: Readonly<{
  profileGeneration?: number;
  profileId: string;
  sessionId?: string;
}>): ClaudeLiveAcceptanceCleanupEvidence => ({
  phase: "cleanup_stopped",
  privateArtifactsAbsent: true,
  retainedSessionProcess: "released_not_live",
  scopeBindingDigest: canonicalDigest({
    domain: "hra.claude.cleanup-readback.v1",
    profileGeneration: input.profileGeneration ?? null,
    profileId: input.profileId,
    sessionId: input.sessionId ?? null,
  }),
  snapshotDigest: "f".repeat(64),
  source: "independent_cleanup_readback",
  unreleasedProcessesAbsent: true,
  version: 1,
});

type TestLayout = Awaited<ReturnType<typeof testLayout>>;
type RunnerBehavior = Readonly<{
  foregroundLoginExitCode?: number;
  recoverStartedScope?: boolean;
  refuseFinalProof?: boolean;
  refuseStoppedProof?: boolean;
  sessionStartResponseLost?: boolean;
  startFailsAfterPid?: boolean;
}>;

function runnerHarness(layout: TestLayout, behavior: RunnerBehavior = {}) {
  let worker: FakeClaudeWorker | undefined;
  let logoutControllers = 0;
  const handshake: string[] = [];
  const cleanupInputs: unknown[] = [];
  const phaseTrace: string[] = [];
  return {
    cleanupInputs,
    handshake,
    phaseTrace,
    get logoutControllers() { return logoutControllers; },
    options: {
      createLayout: async () => layout,
      createLogout: (input: Parameters<typeof fakeLogoutFactory>[0]) => {
        logoutControllers += 1;
        return fakeLogoutFactory({ ...input, phaseTrace });
      },
      createReadback: () => {
        const readback: ClaudeLiveAcceptanceReadback = {
          async captureLive(input) {
            const evidence = liveReadback(input.receipt);
            phaseTrace.push("live-readback");
            return evidence;
          },
          async recoverStartedSessionScope() {
            return behavior.recoverStartedScope === true
              ? { profileGeneration: 3, sessionId }
              : null;
          },
          async verifyCleanupStoppedCustody(input) {
            cleanupInputs.push(input);
            return cleanupEvidence(input);
          },
          async verifyStopped(input) {
            const evidence = stoppedReadback(input.receipt);
            phaseTrace.push("stopped-readback");
            return evidence;
          },
        };
        return readback;
      },
      foregroundLogin: async () => {
        const exitCode = behavior.foregroundLoginExitCode ?? 0;
        phaseTrace.push("login-joined");
        return exitCode;
      },
      isTerminalDescriptor: () => true,
      now: (() => { let value = 1_700_000_000_000; return () => ++value; })(),
      platform: "linux" as const,
      proveSignalDomain: async () => { handshake.push("signal-domain"); },
      proveStopped: async () => {
        handshake.push("stopped");
        if (behavior.refuseStoppedProof === true) throw new Error("synthetic stopped proof refusal");
      },
      recoverProcessJournal: async () => undefined,
      sourceAttestation: async () => candidate,
      startWorker: async (
        descriptor: AcceptanceInstallationDescriptor,
        beforeDescriptorWrite?: (workerPid: number) => Promise<void>,
      ) => {
        const value = new FakeClaudeWorker(descriptor, phaseTrace);
        value.refuseFinalProof = behavior.refuseFinalProof === true;
        value.failStartAfterEffect = behavior.sessionStartResponseLost === true;
        worker = value;
        handshake.push("spawned");
        await beforeDescriptorWrite?.(value.pid);
        handshake.push("descriptor-delivered");
        if (behavior.startFailsAfterPid === true) throw new Error("synthetic activation ambiguity");
        return value;
      },
    },
    get worker() { return worker; },
  };
}

describe("dedicated Claude live acceptance runner", () => {
  test("runs one exact proof, joins shutdown, removes private roots, then emits v1 evidence", async () => {
    await withPrivateDirectory(async (directory) => {
      const layout = await testLayout(directory, candidate);
      const evidencePath = join(directory, "claude-evidence.json");
      const harness = runnerHarness(layout);
      const result = await runClaudeLiveAcceptance(
        ["--evidence-path", evidencePath],
        harness.options,
      );
      expect(result).not.toBeNull();
      if (result === null) throw new Error("acceptance result missing");
      expect(claudeLiveAcceptanceEvidenceSchema.parse(result)).toEqual(result);
      expect(harness.handshake.slice(0, 3)).toEqual(["spawned", "descriptor-delivered", "signal-domain"]);
      expect(harness.phaseTrace).toEqual([
        "login-joined",
        "live-readback",
        "stop-proved",
        "stopped-readback",
        "logout",
      ]);
      expect(harness.worker?.stopWithProofCalls).toBe(1);
      expect(harness.worker?.stopCalls).toBe(0);
      expect((await lstat(evidencePath)).mode & 0o7777).toBe(0o600);
      expect(claudeLiveAcceptanceEvidenceSchema.parse(
        JSON.parse(await Bun.file(evidencePath).text()) as unknown,
      )).toEqual(result);
      await expect(lstat(layout.runRoot.path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(layout.receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  test("replays a terminal signal to the late foreground-login subscriber", () => {
    const listeners = new Map<string, Set<() => void>>();
    const source = {
      off(signal: "SIGINT" | "SIGTERM", listener: () => void): void {
        listeners.get(signal)?.delete(listener);
      },
      on(signal: "SIGINT" | "SIGTERM", listener: () => void): void {
        const values = listeners.get(signal) ?? new Set();
        values.add(listener);
        listeners.set(signal, values);
      },
    };
    const custody = createClaudeLiveAcceptanceSignalCustody(source);
    for (const listener of listeners.get("SIGINT") ?? []) listener();
    let observed = 0;
    custody.loginSignalSource.add("SIGINT", () => { observed += 1; });
    expect(observed).toBe(1);
    expect(custody.interruptedDuringLogin()).toBeTrue();
    custody.close();
  });

  test("a refused final proof still joins exactly once and uses a fresh cleanup logout controller", async () => {
    await withPrivateDirectory(async (directory) => {
      const layout = await testLayout(directory, candidate);
      const evidencePath = join(directory, "refused-proof.json");
      const harness = runnerHarness(layout, { refuseFinalProof: true });
      await expect(runClaudeLiveAcceptance(
        ["--evidence-path", evidencePath],
        harness.options,
      )).rejects.toMatchObject({ code: "proof_unavailable" });
      expect(harness.worker?.stopWithProofCalls).toBe(1);
      expect(harness.worker?.stopCalls).toBe(0);
      expect(harness.logoutControllers).toBe(2);
      await expect(lstat(evidencePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(layout.runRoot.path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(layout.receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  test("an interrupted foreground login is joined before cleanup and never emits evidence", async () => {
    await withPrivateDirectory(async (directory) => {
      const layout = await testLayout(directory, candidate);
      const evidencePath = join(directory, "interrupted.json");
      const harness = runnerHarness(layout, { foregroundLoginExitCode: 130 });
      await expect(runClaudeLiveAcceptance(
        ["--evidence-path", evidencePath],
        harness.options,
      )).rejects.toMatchObject({ code: "operator_interrupted" });
      expect(harness.worker?.stopWithProofCalls).toBe(1);
      expect(harness.worker?.stopCalls).toBe(0);
      expect(harness.logoutControllers).toBe(2);
      await expect(lstat(evidencePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(layout.runRoot.path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(layout.receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  test("recovers an exact applied start scope before cleanup after its public response is lost", async () => {
    await withPrivateDirectory(async (directory) => {
      const layout = await testLayout(directory, candidate);
      const harness = runnerHarness(layout, {
        recoverStartedScope: true,
        sessionStartResponseLost: true,
      });
      const evidencePath = join(directory, "lost-start.json");
      await expect(runClaudeLiveAcceptance(
        ["--evidence-path", evidencePath],
        harness.options,
      )).rejects.toMatchObject({ code: "proof_unavailable" });
      expect(harness.cleanupInputs).toEqual([{ profileGeneration: 3, profileId, sessionId }]);
      expect(harness.worker?.stopWithProofCalls).toBe(1);
      await expect(lstat(evidencePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(layout.runRoot.path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(layout.receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  test("preserves recovery when an activated worker PID cannot be independently stopped", async () => {
    await withPrivateDirectory(async (directory) => {
      const layout = await testLayout(directory, candidate);
      const harness = runnerHarness(layout, {
        refuseStoppedProof: true,
        startFailsAfterPid: true,
      });
      const evidencePath = join(directory, "uncertain-start.json");
      let failure: unknown;
      try {
        await runClaudeLiveAcceptance(
          ["--evidence-path", evidencePath],
          harness.options,
        );
      } catch (error: unknown) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "shutdown_unproven", recoveryReceiptPath: layout.receiptPath });
      expect(harness.handshake).toEqual(["spawned", "descriptor-delivered", "stopped"]);
      const uncertainWorker = harness.worker;
      if (uncertainWorker === undefined) throw new Error("synthetic worker missing");
      expect(uncertainWorker.stopWithProofCalls).toBe(0);
      expect((await lstat(layout.receiptPath)).isFile()).toBeTrue();
      expect((await lstat(layout.runRoot.path)).isDirectory()).toBeTrue();
      const retained = claudeLiveAcceptanceRecoveryReceiptSchema.parse(
        JSON.parse(await Bun.file(layout.receiptPath).text()) as unknown,
      );
      expect(retained).toMatchObject({
        checkpoint: "recovery_required",
        failureCode: "shutdown_unproven",
        worker: { pid: uncertainWorker.pid, state: "starting" },
      });
      expect("cleanupAuthorization" in retained).toBeFalse();
      await expect(lstat(evidencePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});

describe("private descriptor cleanup fixture controls", () => {
  test("forwards only the home and temporary identities required by the real cleanup policy", () => {
    const operation = { candidate, kind: "claude-cleanup" } as const;
    expect(privateDescriptorFixtureEnvironment(operation, "/fixture/home", "/fixture/home", "/fixture/tmp"))
      .toEqual({ HOME: "/fixture/home", LANG: "C", LC_ALL: "C", TMPDIR: "/fixture/tmp", TZ: "UTC" });
    for (const home of [undefined, "/different/home", "relative", "/fixture/./home", "/fixture/home\n"]) {
      expect(() => privateDescriptorFixtureEnvironment(operation, home, "/fixture/home", "/fixture/tmp")).toThrow();
    }
    for (const temporaryRoot of ["relative", "/fixture/../tmp", "/fixture/tmp\n", "/"]) {
      expect(() => privateDescriptorFixtureEnvironment(operation, "/fixture/home", "/fixture/home", temporaryRoot)).toThrow();
    }
    expect(privateDescriptorFixtureEnvironment({ kind: "provider-activity" }, undefined, "/fixture/home", "/fixture/tmp"))
      .toEqual({ LANG: "C", LC_ALL: "C", TZ: "UTC" });
  });

  test("reports only finite child failure stages and codes without private content", () => {
    const known = privateDescriptorFixtureFailure({ code: "cleanup_unproven", recoveryReceiptPath: "/private/receipt", message: "credential" }, "claude-cleanup");
    expect(known).toEqual({ code: "cleanup_unproven", stage: "claude-cleanup" });
    expect(privateDescriptorFixtureFailureMessage(JSON.stringify(known))).toBe(JSON.stringify(known));
    expect(privateDescriptorFixtureFailure({ code: "credential", message: "secret" }, "claude-import"))
      .toEqual({ code: "unclassified", stage: "claude-import" });
    for (const stderr of ["credential", "x".repeat(1025), JSON.stringify({ ...known, path: "/private/receipt" }),
      JSON.stringify({ ...known, stage: "/private/receipt" }), JSON.stringify({ ...known, code: "credential" })]) {
      expect(privateDescriptorFixtureFailureMessage(stderr)).toBe("unclassified");
    }
  });
});

describe("Claude cleanup-only recovery", () => {
  function openHighRecoveryDescriptor(path: string): number {
    // Exercise the allocator state of a long-running suite without retaining
    // pressure descriptors or changing the runner's 3..255 input contract.
    const heldDescriptors: number[] = [];
    try {
      for (let count = 0; count < 256; count += 1) {
        const descriptor = openSync("/dev/null", "r");
        heldDescriptors.push(descriptor);
        if (descriptor >= 255) return openSync(path, "r");
      }
      throw new Error("Could not allocate the bounded high-descriptor fixture.");
    } finally {
      for (const descriptor of heldDescriptors) closeSync(descriptor);
    }
  }

  const cleanupAuthorization = (
    value: Omit<ClaudeLiveAcceptanceRecoveryReceipt, "cleanupAuthorization">,
  ) => {
    const base = {
      authentication: "not_started" as const,
      candidateBindingDigest: canonicalDigest(value.candidate),
      createdAt: 2,
      runId: value.runId,
      version: 1 as const,
    };
    return {
      ...base,
      bindingDigest: canonicalDigest({
        ...base,
        domain: "hra.claude.live-acceptance.cleanup-authorization.v1",
      }),
    };
  };

  async function recoveryFixture(directory: string, rootExists: boolean) {
    const layout = await testLayout(directory, candidate);
    const initial = claudeLiveAcceptanceRecoveryReceiptSchema.parse({
      accountLabel: `hra-claude-live-${layout.descriptor.runId.replaceAll("-", "").slice(0, 12)}`,
      candidate,
      checkpoint: "cleanup_authorized",
      createdAt: 1,
      expectedHomeDirectory: homedir(),
      loginIdempotencyKey: randomUUID(),
      project: {
        identity: layout.project,
        quarantinePath: join(layout.runRoot.path, ".hra-claude-quarantine-project-test"),
        state: "deleted",
      },
      projectLabel: `hra-claude-live-${layout.descriptor.runId.replaceAll("-", "").slice(-12)}`,
      receiptPath: layout.receiptPath,
      runId: layout.descriptor.runId,
      runRoot: layout.runRoot,
      sendIdempotencyKey: randomUUID(),
      startIdempotencyKey: randomUUID(),
      state: {
        identity: layout.state,
        quarantinePath: join(layout.runRoot.path, ".hra-claude-quarantine-state-test"),
        state: "deleted",
      },
      updatedAt: 1,
      version: 1,
      worker: { state: "absent" },
    });
    const receiptValue = claudeLiveAcceptanceRecoveryReceiptSchema.parse({
      ...initial,
      cleanupAuthorization: cleanupAuthorization(initial),
    });
    await rm(layout.project.path, { recursive: true });
    await rm(layout.state.path, { recursive: true });
    if (!rootExists) await rmdir(layout.runRoot.path);
    const owner = await acquireClaudeLiveAcceptanceOwner({
      receiptPath: layout.receiptPath,
      runId: layout.descriptor.runId,
    });
    const receipt = await AtomicPrivateJsonReceipt.create(
      receiptValue,
      claudeLiveAcceptanceRecoveryPolicy,
    );
    await owner.releasePreserving();
    const descriptor = openHighRecoveryDescriptor(receipt.value.receiptPath);
    return { descriptor, layout, receiptValue };
  }

  test.each([true, false])(
    "finishes already-authorized cleanup when the private root exists=%s",
    async (rootExists) => {
      await withPrivateDirectory(async (directory) => {
        const { descriptor, layout, receiptValue } = await recoveryFixture(directory, rootExists);
        try {
          expect(descriptor).toBeGreaterThan(255);
          expect(() => parseClaudeLiveAcceptanceArguments(["--resume-fd", String(descriptor)]))
            .toThrow("claude_live_acceptance_input_invalid");
          const authorization = receiptValue.cleanupAuthorization;
          if (authorization === undefined) throw new Error("cleanup authorization missing");
          const { bindingDigest, ...authorizationBase } = authorization;
          void bindingDigest;
          const readyAuthorizationBase = { ...authorizationBase, workerPid: 91_002 };
          expect(() => claudeLiveAcceptanceRecoveryReceiptSchema.parse({
            ...receiptValue,
            cleanupAuthorization: {
              ...readyAuthorizationBase,
              bindingDigest: canonicalDigest({
                ...readyAuthorizationBase,
                domain: "hra.claude.live-acceptance.cleanup-authorization.v1",
              }),
            },
            worker: { pid: 91_002, state: "ready" },
          })).toThrow("Cleanup authorization scope does not match this run");
          expect(runPrivateDescriptorFixture(descriptor, { candidate, kind: "claude-cleanup" }))
            .toEqual({ closure: "fixture", descriptor: 3, effects: 0, kind: "claude-cleanup", outcome: "cleaned", sha256: null, version: 1 });
          // Child closure cannot close the owned parent descriptor. Its unlinked
          // inode proves cleanup reached the actual protected receipt.
          expect(fstatSync(descriptor).nlink).toBe(0);
        } finally {
          closeSync(descriptor);
        }
        await expect(lstat(layout.receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(lstat(layout.runRoot.path)).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
    15_000,
  );
});
