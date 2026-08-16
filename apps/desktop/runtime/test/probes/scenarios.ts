import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CodexAppServerClient,
  RemoteRpcError,
  type ObservedMessage,
} from "./app-server-client";
import {
  buildProbeEnvironment,
  readCodexVersion,
  resolveCodexCommand,
  resolveExpectedCodexVersion,
  type ResolvedCodexCommand,
} from "./discovery";
import { errorMessage, isJsonObject, isJsonRpcId, type JsonObject } from "./jsonl";
import {
  HRA_RLM_DYNAMIC_TOOL_SPEC,
  HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256,
} from "../../src/codex";

const DEFAULT_PROTOCOL_TIMEOUT_MS = 15_000;
const DEFAULT_INTERACTIVE_TIMEOUT_MS = 90_000;
const THREAD_START_KNOWN_FIELDS = new Set([
  "model",
  "modelProvider",
  "serviceTier",
  "cwd",
  "approvalPolicy",
  "approvalsReviewer",
  "sandbox",
  "config",
  "serviceName",
  "baseInstructions",
  "developerInstructions",
  "personality",
  "ephemeral",
  "sessionStartSource",
  "threadSource",
]);

export type ProtocolProbeName =
  | "initialize"
  | "fork-cwd"
  | "ephemeral-promotion"
  | "pending-request-replay"
  | "dynamic-tool-registration";

export type ProbeStatus = "passed" | "failed" | "skipped";

export interface ProbeResult {
  readonly name: "codex-version" | ProtocolProbeName;
  readonly status: ProbeStatus;
  readonly durationMs: number;
  readonly reason?: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
  readonly diagnostic?: string;
}

export interface ProtocolProbeEvidence {
  readonly schemaVersion: 1;
  readonly kind: "oprte.phase1.codex-protocol-evidence";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly codex: {
    readonly binaryPath: string;
    readonly source: ResolvedCodexCommand["source"];
    readonly reportedVersion: string;
    readonly rawVersion: string;
    readonly expectedVersion: string | null;
  };
  readonly options: {
    readonly selectedScenarios: ReadonlyArray<ProtocolProbeName>;
    readonly interactiveEnabled: boolean;
    readonly explicitAccountHome: boolean;
    readonly dynamicToolRegistrationCandidate: boolean;
  };
  readonly results: ReadonlyArray<ProbeResult>;
  readonly summary: {
    readonly passed: number;
    readonly failed: number;
    readonly skipped: number;
    readonly complete: boolean;
  };
}

export interface RunProtocolProbeOptions {
  readonly binaryPath?: string | undefined;
  readonly expectedVersion?: string | undefined;
  readonly scenarios?: ReadonlyArray<ProtocolProbeName>;
  readonly interactive?: boolean | undefined;
  readonly accountCodexHome?: string | undefined;
  readonly protocolTimeoutMs?: number | undefined;
  readonly interactiveTimeoutMs?: number | undefined;
  readonly dynamicToolRegistrationField?: string | undefined;
}

export async function runProtocolProbeSuite(
  options: RunProtocolProbeOptions = {},
): Promise<ProtocolProbeEvidence> {
  const startedAt = new Date();
  const command = await resolveCodexCommand(options.binaryPath);
  const version = await readCodexVersion(command);
  const expectedVersion = await resolveExpectedCodexVersion(options.expectedVersion);
  const selectedScenarios = options.scenarios ?? [
    "initialize",
    "fork-cwd",
    "ephemeral-promotion",
    "pending-request-replay",
    "dynamic-tool-registration",
  ];
  const interactive = options.interactive ?? process.env.HRA_RUN_INTERACTIVE_PROBES === "1";
  const accountCodexHome = options.accountCodexHome ?? process.env.HRA_PROBE_CODEX_HOME;
  const protocolTimeoutMs = options.protocolTimeoutMs ?? DEFAULT_PROTOCOL_TIMEOUT_MS;
  const interactiveTimeoutMs = options.interactiveTimeoutMs ?? DEFAULT_INTERACTIVE_TIMEOUT_MS;
  const dynamicToolRegistrationField = options.dynamicToolRegistrationField ??
    process.env.HRA_PROBE_DYNAMIC_TOOL_REGISTRATION_FIELD;

  const results: Array<ProbeResult> = [];
  results.push(versionResult(version.version, expectedVersion));

  for (const scenario of selectedScenarios) {
    const result = await runScenario(scenario, async () => {
      switch (scenario) {
        case "initialize":
          return probeInitialize(command, protocolTimeoutMs);
        case "fork-cwd":
          return probeForkWithChangedCwd(command, protocolTimeoutMs);
        case "ephemeral-promotion":
          requireInteractive(interactive, accountCodexHome);
          return probeEphemeralPromotion(
            command,
            accountCodexHome,
            protocolTimeoutMs,
            interactiveTimeoutMs,
          );
        case "pending-request-replay":
          requireInteractive(interactive, accountCodexHome);
          return probePendingRequestReplay(
            command,
            accountCodexHome,
            protocolTimeoutMs,
            interactiveTimeoutMs,
          );
        case "dynamic-tool-registration":
          requireInteractive(interactive, accountCodexHome);
          return probeDynamicToolRegistration(
            command,
            accountCodexHome,
            dynamicToolRegistrationField,
            protocolTimeoutMs,
            interactiveTimeoutMs,
          );
        default:
          return assertNever(scenario);
      }
    });
    results.push(result);
  }

  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  return {
    schemaVersion: 1,
    kind: "oprte.phase1.codex-protocol-evidence",
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    codex: {
      binaryPath: command.binaryPath,
      source: command.source,
      reportedVersion: version.version,
      rawVersion: version.raw,
      expectedVersion,
    },
    options: {
      selectedScenarios,
      interactiveEnabled: interactive,
      explicitAccountHome: accountCodexHome !== undefined,
      dynamicToolRegistrationCandidate: dynamicToolRegistrationField !== undefined,
    },
    results,
    summary: { passed, failed, skipped, complete: failed === 0 && skipped === 0 },
  };
}

async function probeInitialize(
  command: ResolvedCodexCommand,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return withIsolatedProbe("initialize", async ({ codexHome, cwd }) => {
    const client = launch(command, codexHome, cwd);
    try {
      const initialized = await initialize(client, codexHome, timeoutMs, false);
      const shutdown = await client.close();
      if (shutdown.exitCode !== 0) {
        throw new Error(`app-server did not exit cleanly after stdin EOF (code ${shutdown.exitCode})`);
      }
      return {
        userAgent: initialized.userAgent,
        platformFamily: initialized.platformFamily,
        platformOs: initialized.platformOs,
        codexHomeMatched: initialized.codexHomeMatched,
        shutdownMode: shutdown.mode,
        shutdownExitCode: shutdown.exitCode,
      };
    } finally {
      await client.close();
    }
  });
}

async function probeForkWithChangedCwd(
  command: ResolvedCodexCommand,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return withIsolatedProbe("fork-cwd", async ({ codexHome, root, cwd }) => {
    const forkCwd = join(root, "fork-cwd");
    await mkdir(forkCwd, { recursive: false, mode: 0o700 });
    const client = launch(command, codexHome, cwd);
    try {
      await initialize(client, codexHome, timeoutMs, false);
      const startedResult = expectObject(
        await client.request(
          "thread/start",
          {
            cwd,
            approvalPolicy: "never",
            sandbox: "read-only",
            ephemeral: false,
          },
          timeoutMs,
        ),
        "thread/start result",
      );
      const startedThread = responseThread(startedResult, "thread/start");
      const sourceId = expectString(startedThread.id, "thread/start thread.id");
      await client.request(
        "thread/inject_items",
        {
          threadId: sourceId,
          items: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "HRA Phase 1 fork fixture" }],
            },
          ],
        },
        timeoutMs,
      );

      const forkResult = expectObject(
        await client.request(
          "thread/fork",
          {
            threadId: sourceId,
            cwd: forkCwd,
            approvalPolicy: "never",
            sandbox: "read-only",
            ephemeral: false,
          },
          timeoutMs,
        ),
        "thread/fork result",
      );
      const forkedThread = responseThread(forkResult, "thread/fork");
      const actualCwd = expectString(forkResult.cwd, "thread/fork cwd");
      await assertSamePath(actualCwd, forkCwd, "thread/fork response cwd");
      await assertSamePath(
        expectString(forkedThread.cwd, "thread/fork thread.cwd"),
        forkCwd,
        "thread/fork thread cwd",
      );
      if (forkedThread.forkedFromId !== sourceId) {
        throw new Error("thread/fork did not retain the source thread id");
      }
      return {
        sourceThreadCreated: true,
        sourceRolloutMaterializedWithoutModel: true,
        forkThreadCreated: true,
        forkedFromMatched: true,
        changedCwdMatched: true,
        sourceAndForkDiffer: expectString(forkedThread.id, "thread/fork thread.id") !== sourceId,
      };
    } finally {
      await client.close();
    }
  });
}

async function probeEphemeralPromotion(
  command: ResolvedCodexCommand,
  accountCodexHome: string | undefined,
  protocolTimeoutMs: number,
  interactiveTimeoutMs: number,
): Promise<Record<string, unknown>> {
  const codexHome = await validatedAccountHome(accountCodexHome);
  return withIsolatedWorkingDirectories("ephemeral-promotion", async ({ root, cwd }) => {
    const directPromotedCwd = join(root, "direct-promoted-cwd");
    const durableSourceCwd = join(root, "durable-source-cwd");
    const fallbackPromotedCwd = join(root, "fallback-promoted-cwd");
    await Promise.all(
      [directPromotedCwd, durableSourceCwd, fallbackPromotedCwd].map((path) =>
        mkdir(path, { recursive: false, mode: 0o700 }),
      ),
    );
    const client = launch(command, codexHome, cwd);
    let fallbackSourceId: string | null = null;
    let fallbackSourceArchived = false;
    try {
      await initialize(client, codexHome, protocolTimeoutMs, true);
      await requireSignedInAccount(client, protocolTimeoutMs);
      const ephemeral = await startAndCompleteProbeTurn(client, {
        cwd,
        ephemeral: true,
        prompt: "Reply with exactly HRA_PHASE1_EPHEMERAL_OK. Do not call tools.",
        protocolTimeoutMs,
        interactiveTimeoutMs,
        label: "ephemeral source",
      });

      let directLimitation: { readonly code: number; readonly message: string } | null = null;
      try {
        const directFork = expectObject(
          await client.request(
            "thread/fork",
            {
              threadId: ephemeral.threadId,
              lastTurnId: ephemeral.turnId,
              cwd: directPromotedCwd,
              approvalPolicy: "never",
              sandbox: "read-only",
              ephemeral: false,
            },
            protocolTimeoutMs,
          ),
          "direct ephemeral thread/fork result",
        );
        const directPromotedThread = responseThread(directFork, "direct ephemeral thread/fork");
        const directHistory = await inspectForkedHistory({
          sourceThreadId: ephemeral.threadId,
          sourceTurns: [ephemeral.completedTurn],
          promotedThread: directPromotedThread,
          promotedCwd: directPromotedCwd,
          label: "direct ephemeral promotion",
        });
        const directHistoryComparable =
          directHistory.sourceVisibleMessageCount > 0 &&
          directHistory.promotedVisibleMessageCount > 0;
        return {
          signedInAccountObserved: true,
          sourceWasEphemeral: true,
          sourceTurnCompleted: true,
          directEphemeralForkSupported: true,
          fallbackRequired: false,
          directHistoryComparisonBestEffort: true,
          visibleHistoryComparable: directHistoryComparable,
          visibleHistorySemanticHash: directHistory.visibleSemanticHash,
          visibleHistoryMatched: directHistoryComparable
            ? directHistory.visibleHistoryMatched
            : null,
          identityPayloadMatched: directHistory.identityPayloadMatched,
          sourceIdentityHash: directHistory.sourceIdentityHash,
          promotedIdentityHash: directHistory.promotedIdentityHash,
          sourceTurnCount: directHistory.sourceTurnCount,
          promotedTurnCount: directHistory.promotedTurnCount,
          sourceItemCount: directHistory.sourceItemCount,
          promotedItemCount: directHistory.promotedItemCount,
          sourceVisibleMessageCount: directHistory.sourceVisibleMessageCount,
          promotedVisibleMessageCount: directHistory.promotedVisibleMessageCount,
          promotedWasDurable: true,
          changedCwdMatched: true,
        };
      } catch (error: unknown) {
        directLimitation = expectedEphemeralForkLimitation(error);
      }

      const durable = await startAndCompleteProbeTurn(client, {
        cwd: durableSourceCwd,
        ephemeral: false,
        prompt: "Reply with exactly HRA_PHASE1_DURABLE_OK. Do not call tools.",
        protocolTimeoutMs,
        interactiveTimeoutMs,
        label: "temporary durable source",
      });
      fallbackSourceId = durable.threadId;
      const storedSourceTurns = await runPromotionStage(
        "source-thread-read",
        async () => {
          const storedSourceRead = expectObject(
            await client.request(
              "thread/read",
              { threadId: durable.threadId, includeTurns: true },
              protocolTimeoutMs,
            ),
            "temporary durable source thread/read result",
          );
          const storedSourceThread = responseThread(
            storedSourceRead,
            "temporary durable source thread/read",
          );
          return parseThreadTurns(
            storedSourceThread,
            "temporary durable source thread/read",
          );
        },
      );
      const fallbackFork = expectObject(
        await client.request(
          "thread/fork",
          {
            threadId: durable.threadId,
            lastTurnId: durable.turnId,
            cwd: fallbackPromotedCwd,
            approvalPolicy: "never",
            sandbox: "read-only",
            ephemeral: false,
          },
          protocolTimeoutMs,
        ),
        "temporary durable source thread/fork result",
      );
      const fallbackPromotedThread = responseThread(
        fallbackFork,
        "temporary durable source thread/fork",
      );
      const fallbackHistory = await verifyForkedHistory({
        sourceThreadId: durable.threadId,
        sourceTurns: storedSourceTurns,
        promotedThread: fallbackPromotedThread,
        promotedCwd: fallbackPromotedCwd,
        label: "temporary durable promotion fallback",
      });

      const beforeArchive = client.lastOrdinal;
      await client.request(
        "thread/archive",
        { threadId: durable.threadId },
        protocolTimeoutMs,
      );
      await client.waitForMessage(
        (message) => isThreadArchived(message, durable.threadId),
        { afterOrdinal: beforeArchive, timeoutMs: protocolTimeoutMs },
      );
      fallbackSourceArchived = true;

      return {
        signedInAccountObserved: true,
        sourceWasEphemeral: true,
        sourceTurnCompleted: true,
        directEphemeralForkSupported: false,
        directEphemeralForkErrorCode: directLimitation.code,
        directEphemeralForkError: directLimitation.message,
        directEphemeralHistoryTransferAvailable: false,
        fallbackStrategy: "temporary-durable-source-fork-then-archive",
        fallbackRequiresDurableSourceFromStart: true,
        fallbackDoesNotRetroactivelyRecoverEphemeralHistory: true,
        fallbackSourceTurnCompleted: true,
        fallbackSourceProjection: "thread/read(includeTurns:true)",
        fallbackSourceArchived: true,
        promotedWasDurable: true,
        promotedHistoryRetained: true,
        visibleHistorySemanticHash: fallbackHistory.visibleSemanticHash,
        visibleHistoryMatched: fallbackHistory.visibleHistoryMatched,
        identityPayloadMatched: fallbackHistory.identityPayloadMatched,
        sourceIdentityHash: fallbackHistory.sourceIdentityHash,
        promotedIdentityHash: fallbackHistory.promotedIdentityHash,
        sourceTurnCount: fallbackHistory.sourceTurnCount,
        promotedTurnCount: fallbackHistory.promotedTurnCount,
        sourceItemCount: fallbackHistory.sourceItemCount,
        promotedItemCount: fallbackHistory.promotedItemCount,
        sourceVisibleMessageCount: fallbackHistory.sourceVisibleMessageCount,
        promotedVisibleMessageCount: fallbackHistory.promotedVisibleMessageCount,
        changedCwdMatched: true,
      };
    } finally {
      if (fallbackSourceId !== null && !fallbackSourceArchived) {
        await client
          .request("thread/archive", { threadId: fallbackSourceId }, protocolTimeoutMs)
          .catch(() => undefined);
      }
      await client.close();
    }
  });
}

async function probePendingRequestReplay(
  command: ResolvedCodexCommand,
  accountCodexHome: string | undefined,
  protocolTimeoutMs: number,
  interactiveTimeoutMs: number,
): Promise<Record<string, unknown>> {
  const codexHome = await validatedAccountHome(accountCodexHome);
  return withIsolatedWorkingDirectories("request-replay", async ({ cwd }) => {
    const client = launch(command, codexHome, cwd);
    const timelineStart = client.lastOrdinal;
    let activeTurn: { readonly threadId: string; readonly turnId: string } | null = null;
    let pendingRequest: ObservedMessage | null = null;
    let replayThreadId: string | null = null;
    try {
      await runProbeStage("initialize", client, timelineStart, () =>
        initialize(client, codexHome, protocolTimeoutMs, true),
      );
      await runProbeStage("account-read", client, timelineStart, () =>
        requireSignedInAccount(client, protocolTimeoutMs),
      );
      const startResult = await runProbeStage("thread-start", client, timelineStart, async () =>
        expectObject(
          await client.request(
            "thread/start",
            {
              cwd,
              approvalPolicy: "on-request",
              sandbox: "read-only",
              ephemeral: false,
              developerInstructions:
                "This is a protocol replay probe. Follow the next user instruction exactly and do not answer it without invoking request_user_input.",
            },
            protocolTimeoutMs,
          ),
          "replay thread/start result",
        ),
      );
      const thread = responseThread(startResult, "replay thread/start");
      const threadId = expectString(thread.id, "replay thread id");
      replayThreadId = threadId;
      const selectedModel = expectString(startResult.model, "replay thread/start model");
      const beforeTurn = client.lastOrdinal;
      const turnResult = await runProbeStage("turn-start", client, timelineStart, async () =>
        expectObject(
          await client.request(
            "turn/start",
            {
              threadId,
              clientUserMessageId: `hra-phase1-${crypto.randomUUID()}`,
              input: [
                {
                  type: "text",
                  text: "Call request_user_input now with one yes/no question, then wait.",
                  text_elements: [],
                },
              ],
              collaborationMode: {
                mode: "plan",
                settings: {
                  model: selectedModel,
                  reasoning_effort: null,
                  developer_instructions:
                    "Your first and only action must be request_user_input with one non-secret yes/no question. Wait for the response.",
                },
              },
            },
            protocolTimeoutMs,
          ),
          "replay turn/start result",
        ),
      );
      const turn = expectObject(turnResult.turn, "replay turn/start turn");
      const turnId = expectString(turn.id, "replay turn id");
      activeTurn = { threadId, turnId };

      const initialOutcome = await runProbeStage(
        "initial-server-request",
        client,
        timelineStart,
        () =>
          client.waitForMessage(
            (message) =>
              isUserInputRequest(message, threadId, turnId) ||
              isTurnCompleted(message, threadId, turnId),
            { afterOrdinal: beforeTurn, timeoutMs: interactiveTimeoutMs },
          ),
      );
      if (!isUserInputRequest(initialOutcome, threadId, turnId)) {
        throw new ProbeStageFailure(
          "initial-server-request",
          "turn completed before request_user_input was issued; verify experimental plan collaboration mode remains supported",
          summarizeObservedMessages(client.messagesAfter(timelineStart)),
        );
      }
      pendingRequest = initialOutcome;
      const requestId = pendingRequest.value.id;
      if (!isJsonRpcId(requestId)) {
        throw new Error("pending user-input request did not contain a valid id");
      }
      const initialOrdinal = pendingRequest.ordinal;

      const resumeResult = await runProbeStage(
        "thread-resume-response",
        client,
        timelineStart,
        async () =>
          expectObject(
            await client.request(
              "thread/resume",
              { threadId, cwd, approvalPolicy: "on-request", sandbox: "read-only" },
              protocolTimeoutMs,
            ),
            "thread/resume result",
          ),
      );
      const resumedThread = responseThread(resumeResult, "thread/resume");
      if (resumedThread.id !== threadId) {
        throw new ProbeStageFailure(
          "thread-resume-response",
          "thread/resume returned a different thread id",
          summarizeObservedMessages(client.messagesAfter(timelineStart)),
        );
      }

      const replay = await runProbeStage(
        "replayed-server-request",
        client,
        timelineStart,
        () =>
          client.waitForMessage(
            (message) =>
              message.value.method === pendingRequest?.value.method &&
              message.value.id === requestId,
            { afterOrdinal: initialOrdinal, timeoutMs: protocolTimeoutMs },
          ),
      );
      client.respondResult(requestId, { answers: {} });
      pendingRequest = null;
      await runProbeStage("server-request-resolution", client, timelineStart, () =>
        client.waitForMessage(
          (message) => isRequestResolved(message, threadId, requestId),
          { afterOrdinal: replay.ordinal, timeoutMs: protocolTimeoutMs },
        ),
      );
      await client.request("turn/interrupt", { threadId, turnId }, protocolTimeoutMs).catch(() => undefined);
      activeTurn = null;
      return {
        signedInAccountObserved: true,
        sourceWasDurable: true,
        collaborationMode: "plan",
        requestMethod: replay.value.method,
        initialRequestObserved: true,
        resumeReturnedSameThread: true,
        replayedSameGeneration: true,
        replayedSameRequestId: true,
        replayedAfterResume: true,
        requestResolvedExactlyOnceByProbe: true,
      };
    } finally {
      if (pendingRequest !== null && isJsonRpcId(pendingRequest.value.id)) {
        client.respondResult(pendingRequest.value.id, { answers: {} });
      }
      if (activeTurn !== null) {
        await client
          .request("turn/interrupt", activeTurn, protocolTimeoutMs)
          .catch(() => undefined);
      }
      if (replayThreadId !== null) {
        await client
          .request("thread/archive", { threadId: replayThreadId }, protocolTimeoutMs)
          .catch(() => undefined);
      }
      await client.close();
    }
  });
}

interface DynamicToolProbeCall {
  readonly request: ObservedMessage;
  readonly requestId: string | number;
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string;
}

async function probeDynamicToolRegistration(
  command: ResolvedCodexCommand,
  accountCodexHome: string | undefined,
  registrationField: string | undefined,
  protocolTimeoutMs: number,
  interactiveTimeoutMs: number,
): Promise<Record<string, unknown>> {
  if (
    registrationField === undefined ||
    !/^[A-Za-z][A-Za-z0-9_]{0,159}$/u.test(registrationField) ||
    THREAD_START_KNOWN_FIELDS.has(registrationField)
  ) {
    throw new ProbeSkipped(
      "pinned 0.144.6 generates DynamicToolSpec and item/tool/call but no registration field; set HRA_PROBE_DYNAMIC_TOOL_REGISTRATION_FIELD only from an upstream-code or documentation candidate",
    );
  }
  const codexHome = await validatedAccountHome(accountCodexHome);
  return withIsolatedWorkingDirectories("dynamic-tool", async ({ cwd }) => {
    let client = launch(command, codexHome, cwd);
    let threadId: string | null = null;
    try {
      await initialize(client, codexHome, protocolTimeoutMs, true);
      await requireSignedInAccount(client, protocolTimeoutMs);
      const started = expectObject(
        await client.request(
          "thread/start",
          {
            cwd,
            approvalPolicy: "never",
            sandbox: "read-only",
            ephemeral: false,
            developerInstructions:
              "This is an HRA dynamic-tool protocol probe. Invoke oprte/rlm_run exactly when the user asks and do not substitute another tool.",
            [registrationField]: [HRA_RLM_DYNAMIC_TOOL_SPEC],
          },
          protocolTimeoutMs,
        ),
        "dynamic-tool thread/start result",
      );
      const thread = responseThread(started, "dynamic-tool thread/start");
      threadId = expectString(thread.id, "dynamic-tool thread id");

      const successful = await startDynamicToolProbeCall(
        client,
        threadId,
        "successful-completion",
        protocolTimeoutMs,
        interactiveTimeoutMs,
      );
      client.respondResult(successful.requestId, {
        contentItems: [{ type: "inputText", text: "probe-success" }],
        success: true,
      });
      await waitForProbeTurnCompletion(
        client,
        successful,
        successful.request.ordinal,
        interactiveTimeoutMs,
      );

      const failed = await startDynamicToolProbeCall(
        client,
        threadId,
        "failed-completion",
        protocolTimeoutMs,
        interactiveTimeoutMs,
      );
      client.respondResult(failed.requestId, {
        contentItems: [{ type: "inputText", text: "probe-failure" }],
        success: false,
      });
      await waitForProbeTurnCompletion(
        client,
        failed,
        failed.request.ordinal,
        interactiveTimeoutMs,
      );

      const cancelled = await startDynamicToolProbeCall(
        client,
        threadId,
        "cancellation",
        protocolTimeoutMs,
        interactiveTimeoutMs,
      );
      const beforeCancellation = client.lastOrdinal;
      await client.request(
        "turn/interrupt",
        { threadId, turnId: cancelled.turnId },
        protocolTimeoutMs,
      );
      await client.waitForMessage(
        (message) =>
          isRequestResolved(message, threadId ?? "", cancelled.requestId) ||
          isTurnCompleted(message, threadId ?? "", cancelled.turnId),
        { afterOrdinal: beforeCancellation, timeoutMs: interactiveTimeoutMs },
      );

      const duplicate = await startDynamicToolProbeCall(
        client,
        threadId,
        "duplicate-replay",
        protocolTimeoutMs,
        interactiveTimeoutMs,
      );
      await client.request(
        "thread/resume",
        { threadId, cwd, approvalPolicy: "never", sandbox: "read-only" },
        protocolTimeoutMs,
      );
      const replay = await client.waitForMessage(
        (message) => isSameDynamicToolCall(message, duplicate),
        { afterOrdinal: duplicate.request.ordinal, timeoutMs: protocolTimeoutMs },
      );
      const replayId = replay.value.id;
      if (!isJsonRpcId(replayId)) throw new Error("duplicate dynamic call lacked a request id");
      client.respondError(replayId, -32_609, "Duplicate dynamic tool call");
      await client.request(
        "turn/interrupt",
        { threadId, turnId: duplicate.turnId },
        protocolTimeoutMs,
      ).catch(() => undefined);

      const beforeRestart = await startDynamicToolProbeCall(
        client,
        threadId,
        "process-restart",
        protocolTimeoutMs,
        interactiveTimeoutMs,
      );
      await client.close();
      client = launch(command, codexHome, cwd);
      await initialize(client, codexHome, protocolTimeoutMs, true);
      await requireSignedInAccount(client, protocolTimeoutMs);
      const restartOrdinal = client.lastOrdinal;
      await client.request(
        "thread/resume",
        { threadId, cwd, approvalPolicy: "never", sandbox: "read-only" },
        protocolTimeoutMs,
      );
      const afterRestart = await client.waitForMessage(
        (message) => isSameDynamicToolCall(message, beforeRestart),
        { afterOrdinal: restartOrdinal, timeoutMs: interactiveTimeoutMs },
      );
      const restartedRequestId = afterRestart.value.id;
      if (!isJsonRpcId(restartedRequestId)) {
        throw new Error("restarted dynamic call lacked a request id");
      }
      client.respondResult(restartedRequestId, {
        contentItems: [{ type: "inputText", text: "probe-restart" }],
        success: true,
      });

      return {
        schemaVersion: 1,
        kind: "oprte.codex.dynamic-tool.real-probe-observations",
        registration: {
          initializeExperimentalApi: true,
          carrierMethod: "thread/start",
          paramsField: registrationField,
          namespace: "oprte",
          tool: "rlm_run",
          specSha256: HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256,
        },
        binarySha256: await sha256ProbeBinary(command.binaryPath),
        observations: {
          registrationAccepted: true,
          exactThreadAndTurnIdentity: true,
          successfulCompletion: true,
          failedCompletion: true,
          cancellationResolution: true,
          duplicateCallObserved: true,
          duplicateCallRejected: true,
          restartGenerationScoped: true,
        },
        duplicateRequestIdReused: replayId === duplicate.requestId,
        restartRequestIdReused: restartedRequestId === beforeRestart.requestId,
        restartCallIdReused: true,
      };
    } finally {
      if (threadId !== null) {
        await client.request("thread/archive", { threadId }, protocolTimeoutMs)
          .catch(() => undefined);
      }
      await client.close();
    }
  });
}

async function sha256ProbeBinary(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

async function startDynamicToolProbeCall(
  client: CodexAppServerClient,
  threadId: string,
  stage: string,
  protocolTimeoutMs: number,
  interactiveTimeoutMs: number,
): Promise<DynamicToolProbeCall> {
  const token = crypto.randomUUID();
  const beforeTurn = client.lastOrdinal;
  const started = expectObject(
    await client.request(
      "turn/start",
      {
        threadId,
        clientUserMessageId: `hra-dynamic-tool-${token}`,
        input: [{
          type: "text",
          text: `Call oprte/rlm_run exactly once with {"schemaVersion":1,"action":"submit","program":{"version":2,"capabilities":[],"steps":[],"result":{"kind":"literal","value":{"probeStage":"${stage}","probeToken":"${token}"}}}} and wait for its result.`,
          text_elements: [],
        }],
      },
      protocolTimeoutMs,
    ),
    `dynamic-tool ${stage} turn/start result`,
  );
  const turn = expectObject(started.turn, `dynamic-tool ${stage} turn`);
  const turnId = expectString(turn.id, `dynamic-tool ${stage} turn id`);
  const request = await client.waitForMessage(
    (message) =>
      isDynamicToolCall(message, threadId, turnId) ||
      isTurnCompleted(message, threadId, turnId),
    { afterOrdinal: beforeTurn, timeoutMs: interactiveTimeoutMs },
  );
  if (!isDynamicToolCall(request, threadId, turnId)) {
    throw new ProbeEvidenceFailure(
      `dynamic-tool ${stage} turn completed without invoking oprte/rlm_run`,
      { stage, observedMessages: summarizeObservedMessages(client.messagesAfter(beforeTurn)) },
    );
  }
  const requestId = request.value.id;
  const params = expectObject(request.value.params, `dynamic-tool ${stage} params`);
  if (!isJsonRpcId(requestId)) throw new Error(`dynamic-tool ${stage} request id was invalid`);
  return {
    request,
    requestId,
    threadId,
    turnId,
    callId: expectString(params.callId, `dynamic-tool ${stage} call id`),
  };
}

function isDynamicToolCall(
  message: ObservedMessage,
  threadId: string,
  turnId: string,
): boolean {
  if (
    message.value.method !== "item/tool/call" ||
    !isJsonRpcId(message.value.id) ||
    !isJsonObject(message.value.params)
  ) {
    return false;
  }
  return message.value.params.threadId === threadId &&
    message.value.params.turnId === turnId &&
    message.value.params.namespace === "oprte" &&
    message.value.params.tool === "rlm_run" &&
    typeof message.value.params.callId === "string" &&
    message.value.params.callId.length > 0;
}

function isSameDynamicToolCall(
  message: ObservedMessage,
  expected: DynamicToolProbeCall,
): boolean {
  if (!isDynamicToolCall(message, expected.threadId, expected.turnId)) return false;
  const params = expectObject(message.value.params, "replayed dynamic-tool params");
  return params.callId === expected.callId;
}

async function waitForProbeTurnCompletion(
  client: CodexAppServerClient,
  call: DynamicToolProbeCall,
  afterOrdinal: number,
  timeoutMs: number,
): Promise<void> {
  await client.waitForMessage(
    (message) => isTurnCompleted(message, call.threadId, call.turnId),
    { afterOrdinal, timeoutMs },
  );
}

interface CompletedProbeTurn {
  readonly threadId: string;
  readonly turnId: string;
  readonly completedTurn: JsonObject;
}

async function startAndCompleteProbeTurn(
  client: CodexAppServerClient,
  options: {
    readonly cwd: string;
    readonly ephemeral: boolean;
    readonly prompt: string;
    readonly protocolTimeoutMs: number;
    readonly interactiveTimeoutMs: number;
    readonly label: string;
  },
): Promise<CompletedProbeTurn> {
  const startResult = expectObject(
    await client.request(
      "thread/start",
      {
        cwd: options.cwd,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: options.ephemeral,
      },
      options.protocolTimeoutMs,
    ),
    `${options.label} thread/start result`,
  );
  const thread = responseThread(startResult, `${options.label} thread/start`);
  const threadId = expectString(thread.id, `${options.label} thread id`);
  if (thread.ephemeral !== options.ephemeral) {
    throw new Error(
      `${options.label} ephemeral mismatch: expected ${String(options.ephemeral)}, received ${String(thread.ephemeral)}`,
    );
  }

  const beforeTurn = client.lastOrdinal;
  const turnResult = expectObject(
    await client.request(
      "turn/start",
      {
        threadId,
        clientUserMessageId: `hra-phase1-${crypto.randomUUID()}`,
        input: [{ type: "text", text: options.prompt, text_elements: [] }],
      },
      options.protocolTimeoutMs,
    ),
    `${options.label} turn/start result`,
  );
  const turn = expectObject(turnResult.turn, `${options.label} turn/start turn`);
  const turnId = expectString(turn.id, `${options.label} turn id`);
  const completed = await client.waitForMessage(
    (message) => isTurnCompleted(message, threadId, turnId),
    { afterOrdinal: beforeTurn, timeoutMs: options.interactiveTimeoutMs },
  );
  const completedTurn = completedTurnFromNotification(completed);
  if (completedTurn.status !== "completed") {
    throw new Error(
      `${options.label} turn ended with status ${String(completedTurn.status)}`,
    );
  }
  return { threadId, turnId, completedTurn };
}

interface ForkHistoryComparison {
  readonly visibleHistoryMatched: boolean;
  readonly visibleSemanticHash: string;
  readonly sourceVisibleSemanticHash: string;
  readonly promotedVisibleSemanticHash: string;
  readonly identityPayloadMatched: boolean;
  readonly sourceIdentityHash: string;
  readonly promotedIdentityHash: string;
  readonly turnShapeMatched: boolean;
  readonly sourceTurnCount: number;
  readonly promotedTurnCount: number;
  readonly sourceItemCount: number;
  readonly promotedItemCount: number;
  readonly sourceVisibleMessageCount: number;
  readonly promotedVisibleMessageCount: number;
  readonly sourceItemTypes: ReadonlyArray<string>;
  readonly promotedItemTypes: ReadonlyArray<string>;
}

async function inspectForkedHistory(options: {
  readonly sourceThreadId: string;
  readonly sourceTurns: ReadonlyArray<JsonObject>;
  readonly promotedThread: JsonObject;
  readonly promotedCwd: string;
  readonly label: string;
}): Promise<ForkHistoryComparison> {
  if (options.promotedThread.ephemeral !== false) {
    throw new Error(`${options.label} remained ephemeral`);
  }
  if (options.promotedThread.forkedFromId !== options.sourceThreadId) {
    throw new Error(`${options.label} did not retain its source thread id`);
  }
  await assertSamePath(
    expectString(options.promotedThread.cwd, `${options.label} thread.cwd`),
    options.promotedCwd,
    `${options.label} cwd`,
  );
  const promotedTurns = expectArray(
    options.promotedThread.turns,
    `${options.label} thread.turns`,
  ).map((turn, index) => expectObject(turn, `${options.label} turn ${String(index)}`));
  return compareForkHistory(options.sourceTurns, promotedTurns);
}

async function verifyForkedHistory(options: {
  readonly sourceThreadId: string;
  readonly sourceTurns: ReadonlyArray<JsonObject>;
  readonly promotedThread: JsonObject;
  readonly promotedCwd: string;
  readonly label: string;
}): Promise<ForkHistoryComparison> {
  const comparison = await inspectForkedHistory(options);
  if (comparison.sourceVisibleMessageCount === 0) {
    throw promotionHistoryFailure(
      "source-visible-projection",
      `${options.label} stored source contained no visible user or agent messages`,
      comparison,
    );
  }
  if (comparison.promotedVisibleMessageCount === 0) {
    throw promotionHistoryFailure(
      "promoted-visible-projection",
      `${options.label} fork response contained no visible user or agent messages`,
      comparison,
    );
  }
  if (!comparison.turnShapeMatched) {
    throw promotionHistoryFailure(
      "semantic-comparison",
      `${options.label} changed completed-turn count or status ` +
        `(source ${String(comparison.sourceTurnCount)}, promoted ${String(comparison.promotedTurnCount)})`,
      comparison,
    );
  }
  if (!comparison.visibleHistoryMatched) {
    throw promotionHistoryFailure(
      "semantic-comparison",
      `${options.label} changed ordered visible user/agent message content ` +
        `(source ${comparison.sourceVisibleSemanticHash}, promoted ${comparison.promotedVisibleSemanticHash})`,
      comparison,
    );
  }
  return comparison;
}

function expectedEphemeralForkLimitation(
  error: unknown,
): { readonly code: number; readonly message: string } {
  if (!(error instanceof RemoteRpcError)) {
    throw error;
  }
  const code = error.payload.code;
  const message = error.payload.message;
  if (
    code !== -32600 ||
    typeof message !== "string" ||
    !message.toLocaleLowerCase().includes("no rollout found")
  ) {
    throw error;
  }
  return { code, message };
}

export function compareForkHistory(
  sourceTurns: ReadonlyArray<JsonObject>,
  promotedTurns: ReadonlyArray<JsonObject>,
): ForkHistoryComparison {
  const sourceVisible = visibleMessageHistory(sourceTurns);
  const promotedVisible = visibleMessageHistory(promotedTurns);
  const sourceVisibleSemanticHash = jsonFingerprint(sourceVisible);
  const promotedVisibleSemanticHash = jsonFingerprint(promotedVisible);
  const sourceIdentityHash = jsonFingerprint(sourceTurns.map(identityHistoryProjection));
  const promotedIdentityHash = jsonFingerprint(promotedTurns.map(identityHistoryProjection));
  const sourceStatuses = sourceTurns.map((turn) => turn.status);
  const promotedStatuses = promotedTurns.map((turn) => turn.status);
  const turnShapeMatched =
    sourceTurns.length === promotedTurns.length &&
    jsonFingerprint(sourceStatuses) === jsonFingerprint(promotedStatuses) &&
    promotedStatuses.every((status) => status === "completed");

  return {
    visibleHistoryMatched: sourceVisibleSemanticHash === promotedVisibleSemanticHash,
    visibleSemanticHash: promotedVisibleSemanticHash,
    sourceVisibleSemanticHash,
    promotedVisibleSemanticHash,
    identityPayloadMatched: sourceIdentityHash === promotedIdentityHash,
    sourceIdentityHash,
    promotedIdentityHash,
    turnShapeMatched,
    sourceTurnCount: sourceTurns.length,
    promotedTurnCount: promotedTurns.length,
    sourceItemCount: countTurnItems(sourceTurns),
    promotedItemCount: countTurnItems(promotedTurns),
    sourceVisibleMessageCount: sourceVisible.length,
    promotedVisibleMessageCount: promotedVisible.length,
    sourceItemTypes: turnItemTypes(sourceTurns),
    promotedItemTypes: turnItemTypes(promotedTurns),
  };
}

function visibleMessageHistory(turns: ReadonlyArray<JsonObject>): ReadonlyArray<JsonObject> {
  const visible: Array<JsonObject> = [];
  for (const turn of turns) {
    for (const item of expectArray(turn.items, "turn history items")) {
      const parsedItem = expectObject(item, "turn history item");
      if (parsedItem.type === "userMessage") {
        visible.push({
          type: "userMessage",
          content: expectArray(parsedItem.content, "user message content"),
        });
      } else if (parsedItem.type === "agentMessage") {
        visible.push({
          type: "agentMessage",
          text: expectString(parsedItem.text, "agent message text"),
        });
      }
    }
  }
  return visible;
}

function turnItemTypes(turns: ReadonlyArray<JsonObject>): ReadonlyArray<string> {
  return turns.flatMap((turn) =>
    expectArray(turn.items, "turn history items").map((item) => {
      const parsed = expectObject(item, "turn history item");
      return typeof parsed.type === "string" ? parsed.type : "<missing-type>";
    }),
  );
}

function parseThreadTurns(thread: JsonObject, label: string): ReadonlyArray<JsonObject> {
  return expectArray(thread.turns, `${label} turns`).map((turn, index) =>
    expectObject(turn, `${label} turn ${String(index)}`),
  );
}

type PromotionProbeStage =
  | "source-thread-read"
  | "source-visible-projection"
  | "promoted-visible-projection"
  | "semantic-comparison";

async function runPromotionStage<T>(
  stage: PromotionProbeStage,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error: unknown) {
    if (error instanceof ProbeSkipped || error instanceof ProbeEvidenceFailure) {
      throw error;
    }
    throw new ProbeEvidenceFailure(
      `ephemeral-promotion probe failed at ${stage}: ${errorMessage(error)}`,
      { failedStage: stage },
    );
  }
}

function promotionHistoryFailure(
  stage: Exclude<PromotionProbeStage, "source-thread-read">,
  message: string,
  comparison: ForkHistoryComparison,
): ProbeEvidenceFailure {
  return new ProbeEvidenceFailure(`ephemeral-promotion probe failed at ${stage}: ${message}`, {
    failedStage: stage,
    sourceTurnCount: comparison.sourceTurnCount,
    promotedTurnCount: comparison.promotedTurnCount,
    sourceItemCount: comparison.sourceItemCount,
    promotedItemCount: comparison.promotedItemCount,
    sourceVisibleMessageCount: comparison.sourceVisibleMessageCount,
    promotedVisibleMessageCount: comparison.promotedVisibleMessageCount,
    sourceItemTypes: comparison.sourceItemTypes,
    promotedItemTypes: comparison.promotedItemTypes,
    sourceVisibleSemanticHash: comparison.sourceVisibleSemanticHash,
    promotedVisibleSemanticHash: comparison.promotedVisibleSemanticHash,
  });
}

function identityHistoryProjection(turn: JsonObject): JsonObject {
  return {
    id: expectString(turn.id, "turn history id"),
    items: expectArray(turn.items, "turn history items"),
  };
}

function countTurnItems(turns: ReadonlyArray<JsonObject>): number {
  return turns.reduce(
    (total, turn) => total + expectArray(turn.items, "turn history items").length,
    0,
  );
}

function jsonFingerprint(value: unknown): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify(canonicalizeJson(value)));
  return hasher.digest("hex");
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (isJsonObject(value)) {
    const result: JsonObject = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalizeJson(value[key]);
    }
    return result;
  }
  return value;
}

type ReplayProbeStage =
  | "initialize"
  | "account-read"
  | "thread-start"
  | "turn-start"
  | "initial-server-request"
  | "thread-resume-response"
  | "replayed-server-request"
  | "server-request-resolution";

async function runProbeStage<T>(
  stage: ReplayProbeStage,
  client: CodexAppServerClient,
  timelineStart: number,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error: unknown) {
    if (error instanceof ProbeSkipped || error instanceof ProbeEvidenceFailure) {
      throw error;
    }
    throw new ProbeStageFailure(
      stage,
      errorMessage(error),
      summarizeObservedMessages(client.messagesAfter(timelineStart)),
    );
  }
}

export function summarizeObservedMessages(
  messages: ReadonlyArray<ObservedMessage>,
): ReadonlyArray<Record<string, unknown>> {
  return messages.slice(-40).map((message) => {
    const summary: Record<string, unknown> = {
      ordinal: message.ordinal,
      method: message.value.method,
      kind: isJsonRpcId(message.value.id) ? "server-request" : "notification",
    };
    if (isJsonRpcId(message.value.id)) {
      summary.requestId = message.value.id;
    }
    return summary;
  });
}

async function initialize(
  client: CodexAppServerClient,
  codexHome: string,
  timeoutMs: number,
  experimentalApi: boolean,
): Promise<{
  readonly userAgent: string;
  readonly platformFamily: string;
  readonly platformOs: string;
  readonly codexHomeMatched: boolean;
}> {
  const result = expectObject(
    await client.request(
      "initialize",
      {
        clientInfo: {
          name: "hra_phase1_probe",
          title: "HRA Phase 1 Probe",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi,
          requestAttestation: false,
          mcpServerOpenaiFormElicitation: false,
        },
      },
      timeoutMs,
    ),
    "initialize result",
  );
  const userAgent = expectString(result.userAgent, "initialize userAgent");
  const returnedCodexHome = expectString(result.codexHome, "initialize codexHome");
  const platformFamily = expectString(result.platformFamily, "initialize platformFamily");
  const platformOs = expectString(result.platformOs, "initialize platformOs");
  await assertSamePath(returnedCodexHome, codexHome, "initialize CODEX_HOME");
  client.notify("initialized");
  return { userAgent, platformFamily, platformOs, codexHomeMatched: true };
}

function launch(
  command: ResolvedCodexCommand,
  codexHome: string,
  cwd: string,
): CodexAppServerClient {
  return CodexAppServerClient.launch({
    command: [...command.commandPrefix, "app-server"],
    cwd,
    env: buildProbeEnvironment(codexHome),
  });
}

async function requireSignedInAccount(
  client: CodexAppServerClient,
  timeoutMs: number,
): Promise<void> {
  const result = expectObject(
    await client.request("account/read", { refreshToken: false }, timeoutMs),
    "account/read result",
  );
  if (result.account === null) {
    throw new ProbeSkipped(
      "the explicit HRA_PROBE_CODEX_HOME is not signed in; the probe will not start OAuth or copy credentials",
    );
  }
  if (!isJsonObject(result.account)) {
    throw new Error("account/read returned an invalid account envelope");
  }
}

async function validatedAccountHome(value: string | undefined): Promise<string> {
  if (value === undefined) {
    throw new ProbeSkipped(
      "set HRA_PROBE_CODEX_HOME to an isolated signed-in profile before running credentialed probes",
    );
  }
  await access(value, constants.R_OK | constants.W_OK);
  return realpath(value);
}

function requireInteractive(interactive: boolean, accountCodexHome: string | undefined): void {
  if (!interactive) {
    throw new ProbeSkipped(
      "credentialed/model-consuming probe disabled; set HRA_RUN_INTERACTIVE_PROBES=1 and HRA_PROBE_CODEX_HOME to opt in",
    );
  }
  if (accountCodexHome === undefined) {
    throw new ProbeSkipped(
      "interactive mode was enabled without HRA_PROBE_CODEX_HOME; default user credentials are never inferred",
    );
  }
}

async function runScenario(
  name: ProtocolProbeName,
  run: () => Promise<Record<string, unknown>>,
): Promise<ProbeResult> {
  const started = performance.now();
  try {
    const evidence = await run();
    return { name, status: "passed", durationMs: elapsed(started), evidence };
  } catch (error: unknown) {
    if (error instanceof ProbeSkipped) {
      return { name, status: "skipped", durationMs: elapsed(started), reason: error.message };
    }
    if (error instanceof ProbeEvidenceFailure) {
      return {
        name,
        status: "failed",
        durationMs: elapsed(started),
        reason: error.message,
        evidence: error.evidence,
      };
    }
    return {
      name,
      status: "failed",
      durationMs: elapsed(started),
      reason: errorMessage(error),
    };
  }
}

function versionResult(reported: string, expected: string | null): ProbeResult {
  if (expected === null) {
    return {
      name: "codex-version",
      status: "failed",
      durationMs: 0,
      reason: "no exact expected Codex version was supplied or pinned in the root workspace catalog",
      evidence: { reported },
    };
  }
  if (reported !== expected) {
    return {
      name: "codex-version",
      status: "failed",
      durationMs: 0,
      reason: `Codex version mismatch: expected ${expected}, received ${reported}`,
      evidence: { expected, reported },
    };
  }
  return {
    name: "codex-version",
    status: "passed",
    durationMs: 0,
    evidence: { expected, reported, exactMatch: true },
  };
}

async function withIsolatedProbe<T>(
  name: string,
  run: (paths: { readonly root: string; readonly codexHome: string; readonly cwd: string }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), `hra-${name}-`));
  const codexHome = join(root, "codex-home");
  const cwd = join(root, "cwd");
  await mkdir(codexHome, { mode: 0o700 });
  await mkdir(cwd, { mode: 0o700 });
  try {
    return await run({ root, codexHome, cwd });
  } finally {
    await removeOwnedTempDirectory(root);
  }
}

async function withIsolatedWorkingDirectories<T>(
  name: string,
  run: (paths: { readonly root: string; readonly cwd: string }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), `hra-${name}-`));
  const cwd = join(root, "cwd");
  await mkdir(cwd, { mode: 0o700 });
  try {
    return await run({ root, cwd });
  } finally {
    await removeOwnedTempDirectory(root);
  }
}

async function removeOwnedTempDirectory(root: string): Promise<void> {
  const canonicalTemp = await realpath(tmpdir());
  const canonicalRoot = await realpath(root);
  if (!canonicalRoot.startsWith(`${canonicalTemp}/hra-`)) {
    throw new Error(`refusing to remove unexpected probe directory ${canonicalRoot}`);
  }
  await rm(canonicalRoot, { force: true, recursive: true });
}

function responseThread(response: JsonObject, label: string): JsonObject {
  return expectObject(response.thread, `${label} thread`);
}

function isTurnCompleted(message: ObservedMessage, threadId: string, turnId: string): boolean {
  if (message.value.method !== "turn/completed" || !isJsonObject(message.value.params)) {
    return false;
  }
  const turn = message.value.params.turn;
  return message.value.params.threadId === threadId && isJsonObject(turn) && turn.id === turnId;
}

function completedTurnFromNotification(message: ObservedMessage): JsonObject {
  const params = expectObject(message.value.params, "turn/completed params");
  return expectObject(params.turn, "turn/completed turn");
}

function isUserInputRequest(
  message: ObservedMessage,
  threadId: string,
  turnId: string,
): boolean {
  if (
    message.value.method !== "item/tool/requestUserInput" ||
    !isJsonRpcId(message.value.id) ||
    !isJsonObject(message.value.params)
  ) {
    return false;
  }
  return message.value.params.threadId === threadId && message.value.params.turnId === turnId;
}

function isRequestResolved(
  message: ObservedMessage,
  threadId: string,
  requestId: string | number,
): boolean {
  if (message.value.method !== "serverRequest/resolved" || !isJsonObject(message.value.params)) {
    return false;
  }
  return (
    message.value.params.threadId === threadId && message.value.params.requestId === requestId
  );
}

function isThreadArchived(message: ObservedMessage, threadId: string): boolean {
  return (
    message.value.method === "thread/archived" &&
    isJsonObject(message.value.params) &&
    message.value.params.threadId === threadId
  );
}

async function assertSamePath(actual: string, expected: string, label: string): Promise<void> {
  const [actualPath, expectedPath] = await Promise.all([realpath(actual), realpath(expected)]);
  if (actualPath !== expectedPath) {
    throw new Error(`${label} mismatch: expected ${expectedPath}, received ${actualPath}`);
  }
}

function expectObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function expectArray(value: unknown, label: string): ReadonlyArray<unknown> {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}

function assertNever(value: never): never {
  throw new Error(`unsupported protocol probe ${String(value)}`);
}

class ProbeSkipped extends Error {
  override readonly name = "ProbeSkipped";
}

class ProbeEvidenceFailure extends Error {
  override readonly name: string = "ProbeEvidenceFailure";
  readonly evidence: Readonly<Record<string, unknown>>;

  constructor(message: string, evidence: Readonly<Record<string, unknown>>) {
    super(message);
    this.evidence = evidence;
  }
}

class ProbeStageFailure extends ProbeEvidenceFailure {
  override readonly name = "ProbeStageFailure";

  constructor(
    stage: ReplayProbeStage,
    message: string,
    observedMessages: ReadonlyArray<Record<string, unknown>>,
  ) {
    super(`pending-request replay failed at ${stage}: ${message}`, {
      failedStage: stage,
      observedMessageCount: observedMessages.length,
      observedMessages,
    });
  }
}
