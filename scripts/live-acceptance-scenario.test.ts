import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import type { PublicInteraction } from "../src/domain/interactions";
import type { SessionEvent } from "../src/domain/session-events";
import { DEFAULT_CLOUD_DEPLOYMENT_URL } from "../src/cloud/identity-custody";
import { safeLiveAcceptanceCommandDigest } from "../src/codex/protocol";
import {
  LIVE_ACCEPTANCE_CONTROL_FD,
  type LiveAcceptanceCliResult,
  type LiveAcceptanceDevice,
  type LiveAcceptanceDeviceName,
} from "./live-acceptance";
import {
  liveAcceptanceScenarioConfigurationSchema,
  liveAcceptanceScenarioTesting,
  runLiveAcceptanceScenario,
  type LiveAcceptanceOperatorRequest,
  type LiveAcceptanceScenarioOperator,
} from "./live-acceptance-scenario";

const accountA = `acct_${"1".repeat(32)}`;
const accountB = `acct_${"2".repeat(32)}`;
const projectA = `proj_${"3".repeat(32)}`;
const projectB = `proj_${"4".repeat(32)}`;
const sessionA = `sess_${"5".repeat(32)}`;
const sessionB = `sess_${"6".repeat(32)}`;
const deviceAId = `device_${"7".repeat(32)}`;
const deviceBId = `device_${"8".repeat(32)}`;
const commandId = "018bcfe5-6800-7000-8000-000000000001";
const userInteractionId = "10000000-0000-4000-8000-000000000001";
const permissionInteractionId = "20000000-0000-4000-8000-000000000001";
const attestation = {
  cloudTargetDigest: "a".repeat(64),
  packageVersion: "0.1.0",
  sourceRevision: "b".repeat(40),
} as const;

const success = (command: string, data: unknown): LiveAcceptanceCliResult => ({
  exitCode: 0,
  stderr: "",
  stdout: `${JSON.stringify({ command, data, ok: true, version: 1 })}\n`,
});

const failure = (
  code: "INVALID_INPUT" | "UNAVAILABLE" = "UNAVAILABLE",
  exitCode = code === "INVALID_INPUT" ? 2 : 5,
): LiveAcceptanceCliResult => ({
  exitCode,
  stderr: "",
  stdout: `${JSON.stringify({
    error: { code, message: "Unavailable in the deterministic acceptance world." },
    ok: false,
    version: 1,
  })}\n`,
});

const interaction = (kind: "permission_approval" | "user_input"): PublicInteraction => ({
  blocking: true,
  context: { itemId: "item-1", turnId: "turn-1" },
  deadlineAt: 1_000_000,
  display: kind === "user_input"
    ? {
        blocking: true,
        kind,
        questions: [{
          allowsOther: false,
          header: "Acceptance",
          id: "acceptance_choice",
          options: [
            { description: "Continue the test", label: "Continue" },
            { description: "Stop the test", label: "Stop" },
          ],
          question: "Continue?",
          secret: false,
        }],
        summary: "Acceptance user input",
      }
    : {
        allowsSessionScope: true,
        kind,
        reason: "Acceptance permission proof",
        requested: [{ name: "network" }],
        summary: "Acceptance permission",
      },
  id: kind === "user_input"
    ? userInteractionId
    : permissionInteractionId,
  kind,
  requestedAt: 1,
  responseRecorded: false,
  revision: 1,
  sessionId: kind === "user_input" ? sessionA : sessionB,
  state: "pending",
  terminalAt: null,
  updatedAt: 1,
  version: 1,
});

const event = (
  sessionId: string,
  sequence: number,
  body: SessionEvent["body"],
): SessionEvent => ({
  accountId: sessionId === sessionA ? accountA : accountB,
  body,
  providerConnectionId: "30000000-0000-4000-8000-000000000001",
  providerGeneration: 1,
  recordedAt: sequence,
  sequence,
  sessionId,
  streamEpoch: "40000000-0000-4000-8000-000000000001",
  version: 1,
});

type EvidenceOrderViolation =
  | "requested_prepared"
  | "prepared_written"
  | "written_command"
  | "command_progress"
  | "progress_completion"
  | "completion_terminal";

type EventPageHostility = Readonly<{
  commandDigestMissing: boolean;
  commandDigestMismatch: boolean;
  duplicateCommandCompletion: boolean;
  lateCommandProgress: boolean;
  orderViolation?: EvidenceOrderViolation;
  sequenceGap: boolean;
  unrelatedProgressSameItem: boolean;
  unrelatedSideEffectReuseCommandId: boolean;
  unrelatedSideEffectItemKind?: "dynamicToolCall" | "fileChange" | "mcpToolCall";
}>;

const eventPage = (
  sessionId: string,
  complete: boolean,
  marker: string,
  requestedCursor: string | null,
  commandDigest: string,
  hostility: EventPageHostility,
): unknown => {
  const interactionId = sessionId === sessionA ? userInteractionId : permissionInteractionId;
  const interactionKind = sessionId === sessionA ? "user_input" : "permission_approval";
  const projectedCommandDigest = hostility.commandDigestMissing
    ? undefined
    : hostility.commandDigestMismatch
      ? "f".repeat(64)
      : commandDigest;
  const ordered: Array<Readonly<{ key: string; body: SessionEvent["body"] }>> = [
    { key: "turn", body: { turnId: "turn-1", type: "turn_started" } },
    {
      key: "requested",
      body: {
        blocking: true,
        interactionId,
        interactionKind,
        revision: 1,
        summary: "Acceptance interaction",
        type: "interaction_requested",
      },
    },
    {
      key: "reasoning",
      body: {
        itemId: "reasoning-1",
        text: "safe summary",
        turnId: "turn-1",
        type: "reasoning_summary_delta",
      },
    },
    {
      key: "prepared",
      body: {
        interactionId,
        revision: 2,
        state: "response_prepared",
        type: "interaction_state",
      },
    },
    {
      key: "written",
      body: {
        interactionId,
        revision: 3,
        state: "response_written",
        type: "interaction_state",
      },
    },
    {
      key: "command",
      body: {
        itemId: "tool-1",
        itemKind: "commandExecution",
        ...(projectedCommandDigest === undefined
          ? {}
          : { liveAcceptanceCommandDigest: projectedCommandDigest }),
        turnId: "turn-1",
        type: "item_started",
      },
    },
    ...(hostility.unrelatedSideEffectItemKind === undefined
      ? []
      : [{
          key: "unrelated",
          body: {
            itemId: hostility.unrelatedSideEffectReuseCommandId ? "tool-1" : "unrelated-tool",
            itemKind: hostility.unrelatedSideEffectItemKind,
            turnId: "turn-1",
            type: "item_started",
          } satisfies SessionEvent["body"],
        }]),
    {
      key: "progress",
      body: {
        itemId: "tool-1",
        outputBytesObserved: 23,
        status: "running",
        toolKind: "command",
        turnId: "turn-1",
        type: "tool_progress",
      },
    },
    {
      key: "completion",
      body: {
        itemId: "tool-1",
        itemKind: "commandExecution",
        ...(projectedCommandDigest === undefined
          ? {}
          : { liveAcceptanceCommandDigest: projectedCommandDigest }),
        status: "completed",
        turnId: "turn-1",
        type: "item_completed",
      },
    },
    ...(hostility.duplicateCommandCompletion
      ? [{
          key: "duplicate-completion",
          body: {
            itemId: "tool-1",
            itemKind: "commandExecution",
            liveAcceptanceCommandDigest: projectedCommandDigest ?? "e".repeat(64),
            status: "completed",
            turnId: "turn-1",
            type: "item_completed",
          } satisfies SessionEvent["body"],
        }]
      : []),
    ...(hostility.lateCommandProgress
      ? [{
          key: "late-progress",
          body: {
            itemId: "tool-1",
            outputBytesObserved: 0,
            status: "running",
            toolKind: "command",
            turnId: "turn-1",
            type: "tool_progress",
          } satisfies SessionEvent["body"],
        }]
      : []),
    ...(hostility.unrelatedProgressSameItem
      ? [{
          key: "unrelated-progress",
          body: {
            itemId: "tool-1",
            outputBytesObserved: 1,
            status: "running",
            toolKind: "file_change",
            turnId: "turn-1",
            type: "tool_progress",
          } satisfies SessionEvent["body"],
        }]
      : []),
    {
      key: "assistant",
      body: {
        itemId: "assistant-1",
        text: marker,
        turnId: "turn-1",
        type: "assistant_delta",
      },
    },
    {
      key: "terminal",
      body: {
        status: "completed",
        turnId: "turn-1",
        type: "turn_completed",
      },
    },
  ];
  const reversedPairs: Readonly<Record<EvidenceOrderViolation, readonly [string, string]>> = {
    requested_prepared: ["requested", "prepared"],
    prepared_written: ["prepared", "written"],
    written_command: ["written", "command"],
    command_progress: ["command", "progress"],
    progress_completion: ["progress", "completion"],
    completion_terminal: ["completion", "terminal"],
  };
  if (hostility.orderViolation !== undefined) {
    const [leftKey, rightKey] = reversedPairs[hostility.orderViolation];
    const left = ordered.findIndex((entry) => entry.key === leftKey);
    const right = ordered.findIndex((entry) => entry.key === rightKey);
    [ordered[left], ordered[right]] = [ordered[right]!, ordered[left]!];
  }
  const allEvents = ordered.map((entry, index) => event(sessionId, index + 1, entry.body));
  const events = (complete ? allEvents.slice(3) : allEvents.slice(0, 3))
    .map((entry) => hostility.sequenceGap && entry.sequence >= 3
      ? { ...entry, sequence: entry.sequence + 1 }
      : entry) as SessionEvent[];
  return {
    events,
    gap: null,
    nextCursor: complete ? "cursor-terminal" : "cursor-first",
    observedThroughCursor: "cursor-observed",
    requestedCursor,
    retentionFloorCursor: "cursor-floor",
    sessionId,
    version: 1,
  };
};

class FakeWorld {
  accountLoginPending = false;
  autonomousPollerDisabled = false;
  autonomousUsageAdvanceAfterA = 1;
  autonomousUsageAdvanceAfterB = 1;
  approved = false;
  boundPeer: string | undefined;
  cleanupComplete = false;
  deviceBOnline = true;
  deviceBRevoked = false;
  readonly eventPolls = new Map<string, number>();
  readonly resolvedSessions = new Set<string>();
  readonly usagePolls = new Map<string, number>();
  readonly messages = new Map<string, string>();
  emptyUsage = false;
  eventSequenceGap = false;
  commandDigestMissing = false;
  commandDigestMismatch = false;
  duplicateCommandCompletion = false;
  lateCommandProgress = false;
  evidenceOrderViolation: EvidenceOrderViolation | undefined;
  invalidInteractionResolution = false;
  multipleQuestions = false;
  allowsOtherQuestion = false;
  omitAssistantEvidence = false;
  remoteCommandPolls = 0;
  remoteApplied = false;
  remoteMarker = "";
  remotePrompt = "";
  remoteProjectionPolls = 0;
  remoteProjectionWrongAuthority = false;
  remoteTurnNeverCompletes = false;
  requestedBroadPermission = false;
  skipRemoteClaim = false;
  terminalImmediatelyAfterResolve = false;
  unsafeDeviceCode = false;
  providerPlan = "plus";
  secretQuestion = false;
  wrongQuestionId = false;
  wrongToolSideEffect = false;
  unrelatedSideEffectItemKind: EventPageHostility["unrelatedSideEffectItemKind"];
  unrelatedProgressSameItem = false;
  unrelatedSideEffectReuseCommandId = false;
  cleanupClockAdvanceMs = 0;
  cleanupObservedAt: number | undefined;
  wrongInteractionTurn = false;
  sessionStarts = 0;
  accountAdds = 0;
}

class FakeDevice implements LiveAcceptanceDevice {
  readonly calls: readonly string[][] = [];
  readonly device: LiveAcceptanceDeviceName;
  readonly projectDirectory: string;
  readonly #world: FakeWorld;

  constructor(device: LiveAcceptanceDeviceName, world: FakeWorld) {
    this.device = device;
    this.projectDirectory = `/private/tmp/hra-acceptance-${device}`;
    this.#world = world;
  }

  async execute(
    argvInput: readonly string[],
    options: Readonly<{ protectedDocument?: unknown }> = {},
  ): Promise<LiveAcceptanceCliResult> {
    const argv = [...argvInput];
    (this.calls as string[][]).push(argv);
    const command = `${argv[0]}.${argv[1]}`;
    if (command === "project.add") {
      return success(command, { project: { id: this.device === "a" ? projectA : projectB } });
    }
    if (command === "auth.login") {
      if (!Object.hasOwn(options, "protectedDocument") || !argv.includes("--input-fd")) {
        throw new Error("Protected auth did not use the CLI descriptor boundary.");
      }
      return success(command, { signedIn: true });
    }
    if (command === "device.pair") {
      if (this.device === "a") {
        return success(command, { device: { publicId: deviceAId, status: "active" }, paired: true });
      }
      return success(command, {
        device: {
          publicId: deviceBId,
          status: this.#world.approved ? "active" : "pending",
        },
        paired: this.#world.approved,
      });
    }
    if (command === "device.list") {
      return success(command, {
        currentDevicePublicId: deviceAId,
        devices: [
          { current: true, online: true, publicId: deviceAId, status: "active" },
          {
            current: false,
            online: this.#world.deviceBOnline,
            publicId: deviceBId,
            status: this.#world.deviceBRevoked
              ? "revoked"
              : this.#world.approved
                ? "active"
                : "pending",
          },
        ],
      });
    }
    if (command === "device.approve") {
      this.#world.approved = true;
      return success(command, { device: { publicId: deviceBId, status: "active" } });
    }
    if (command === "device.revoke") {
      this.#world.deviceBRevoked = true;
      this.#world.deviceBOnline = false;
      return success(command, { device: { publicId: deviceBId, status: "revoked" } });
    }
    if (command === "account.add") {
      this.#world.accountAdds += 1;
      return success(command, {
        account: { id: this.#world.accountAdds === 1 ? accountA : accountB, state: "signed_out" },
      });
    }
    if (command === "account.login") {
      const handoffIndex = argv.indexOf("--handoff-file");
      const handoffPath = argv[handoffIndex + 1];
      if (handoffIndex < 0 || handoffPath === undefined) {
        throw new Error("Account login did not request protected output.");
      }
      const accountLabel = argv[2] === accountA ? "Acceptance Primary" : "Acceptance Secondary";
      liveAcceptanceScenarioTesting.writeOwnedProtectedJsonDocument(handoffPath, {
        accountId: argv[2],
        accountLabel,
        cancelCommand: `hra account login-cancel ${argv[2] ?? "unknown"}`,
        method: "device_code",
        type: "codex_device_login",
        userCode: this.#world.unsafeDeviceCode ? "ABCD\u001b[2J" : "ABCD-EFGH",
        verificationUrl: "https://example.test/device",
        version: 1,
      });
      return success(command, {
        account: { id: argv[2], state: "login_pending" },
        login: {
          handoff: {
            disposition: "preserved_caller_removes_after_login",
            documentVersion: 1,
            path: handoffPath,
            status: "written",
          },
          status: "pending",
        },
      });
    }
    if (command === "account.show") {
      const primary = argv[2] === accountA;
      return success(command, {
        account: {
          id: argv[2],
          providerEmail: primary ? "primary@example.test" : "secondary@example.test",
          providerPlan: this.#world.providerPlan,
          state: this.#world.accountLoginPending ? "login_pending" : "signed_in",
        },
      });
    }
    if (command === "account.usage") {
      if (this.#world.emptyUsage) return success(command, { usage: [] });
      const accountId = argv[2]!;
      const refreshing = argv.includes("--refresh");
      const pollCount = refreshing
        ? 0
        : (this.#world.usagePolls.get(accountId) ?? 0) + 1;
      if (!refreshing) this.#world.usagePolls.set(accountId, pollCount);
      const advanceAfter = accountId === accountA
        ? this.#world.autonomousUsageAdvanceAfterA
        : this.#world.autonomousUsageAdvanceAfterB;
      const sourceRevision = !refreshing
        && !this.#world.autonomousPollerDisabled
        && pollCount >= advanceAfter
        ? 2
        : 1;
      return success(command, {
        usage: [{
          account: { id: accountId },
          poll: { observedAt: 10_000, sourceRevision, state: "observed" },
          snapshot: { observedAt: 10_000, sourceRevision },
        }],
      });
    }
    if (command === "sync.now") {
      if (this.device === "b" && (!this.#world.approved || this.#world.deviceBRevoked)) {
        return failure();
      }
      return success(command, { online: true });
    }
    if (command === "remote.list") {
      if (this.device === "b" && (!this.#world.approved || this.#world.deviceBRevoked)) {
        return failure();
      }
      return success(command, {
        sessions: [
          { executionDevicePublicId: deviceAId, publicId: sessionA },
          { executionDevicePublicId: deviceAId, publicId: sessionB },
        ],
        truncated: false,
      });
    }
    if (command === "session.start") {
      this.#world.sessionStarts += 1;
      return success(command, {
        session: { id: this.#world.sessionStarts === 1 ? sessionA : sessionB },
      });
    }
    if (command === "session.send") {
      this.#world.messages.set(argv[2]!, argv[3]!);
      return success(command, { session: { id: argv[2] }, turnId: "turn-1" });
    }
    if (command === "interaction.list") {
      const found = interaction(argv[2] === sessionA ? "user_input" : "permission_approval");
      const hostileDisplay = found.display.kind === "user_input"
        ? {
            ...found.display,
            questions: [
              {
                ...found.display.questions[0]!,
                ...(this.#world.wrongQuestionId ? { id: "different_choice" } : {}),
                ...(this.#world.secretQuestion ? { secret: true } : {}),
                ...(this.#world.allowsOtherQuestion ? { allowsOther: true } : {}),
              },
              ...(this.#world.multipleQuestions
                ? [{ ...found.display.questions[0]!, id: "second_choice" }]
                : []),
            ],
          }
        : {
            ...found.display,
            ...(this.#world.requestedBroadPermission
              ? { requested: [{ name: "network" }, { name: "filesystem" }] }
              : {}),
          };
      return success(command, {
        interactions: [{
          ...found,
          display: hostileDisplay,
          ...(this.#world.wrongInteractionTurn
            ? { context: { ...found.context, turnId: "turn-other" } }
            : {}),
        }],
      });
    }
    if (command === "interaction.answer" || command === "interaction.grant") {
      if (!Object.hasOwn(options, "protectedDocument")) {
        throw new Error("Interaction resolution omitted protected input.");
      }
      if (this.#world.invalidInteractionResolution) {
        return success("interaction.resolve", { interaction: null, responseWritten: true });
      }
      if (command === "interaction.answer") {
        expect(options.protectedDocument).toEqual({
          answers: { acceptance_choice: { answers: ["Continue"] } },
        });
      } else {
        expect(argv.slice(argv.indexOf("--scope"), argv.indexOf("--scope") + 2))
          .toEqual(["--scope", "turn"]);
        expect(options.protectedDocument).toEqual({ permissions: ["network"] });
      }
      const kind = command === "interaction.answer" ? "user_input" : "permission_approval";
      this.#world.resolvedSessions.add(kind === "user_input" ? sessionA : sessionB);
      return success("interaction.resolve", {
        interaction: {
          ...interaction(kind),
          responseRecorded: true,
          revision: 3,
          state: "response_written",
          updatedAt: 3,
        },
        responseWritten: true,
      });
    }
    if (command === "session.events") {
      const sessionId = argv[2]!;
      const polls = (this.#world.eventPolls.get(sessionId) ?? 0) + 1;
      this.#world.eventPolls.set(sessionId, polls);
      const cursorIndex = argv.indexOf("--cursor");
      const requestedCursor = cursorIndex < 0 ? null : argv[cursorIndex + 1]!;
      const marker = this.#world.messages.get(sessionId)?.match(
        /hra-live-(?:user-input|permission)-[0-9a-f-]+/u,
      )?.[0] ?? "";
      const expectedCommand = this.#world.messages.get(sessionId)?.match(
        /\/bin\/echo hra-live-tool-progress \| \/usr\/bin\/tee \.\/\.hra-live-command-proof-[0-9a-f-]+\.txt/u,
      )?.[0] ?? "";
      const commandDigest = safeLiveAcceptanceCommandDigest(expectedCommand);
      if (commandDigest === undefined) throw new Error("Fake prompt omitted the exact live command.");
      return success(command, eventPage(
        sessionId,
        this.#world.terminalImmediatelyAfterResolve
          ? this.#world.resolvedSessions.has(sessionId)
          : polls > 1,
        this.#world.omitAssistantEvidence ? "" : marker,
        requestedCursor,
        commandDigest,
        {
          commandDigestMissing: this.#world.commandDigestMissing,
          commandDigestMismatch: this.#world.commandDigestMismatch,
          duplicateCommandCompletion: this.#world.duplicateCommandCompletion,
          lateCommandProgress: this.#world.lateCommandProgress,
          ...(this.#world.evidenceOrderViolation === undefined
            ? {}
            : { orderViolation: this.#world.evidenceOrderViolation }),
          sequenceGap: this.#world.eventSequenceGap,
          unrelatedProgressSameItem: this.#world.unrelatedProgressSameItem,
          unrelatedSideEffectReuseCommandId: this.#world.unrelatedSideEffectReuseCommandId,
          ...(this.#world.unrelatedSideEffectItemKind === undefined
            ? {}
            : { unrelatedSideEffectItemKind: this.#world.unrelatedSideEffectItemKind }),
        },
      ));
    }
    if (command === "session.show") {
      const prompt = this.#world.messages.get(argv[2]!) ?? "";
      const marker = prompt.match(/hra-live-(?:user-input|permission)-[0-9a-f-]+/u)?.[0] ?? "";
      return success(command, {
        projection: {
          messages: [
            { role: "user", text: prompt, turnId: "turn-1" },
            {
              role: "assistant",
              text: this.#world.omitAssistantEvidence ? "" : marker,
              turnId: "turn-1",
            },
          ],
        },
      });
    }
    if (command === "plugin.list") return success(command, {
      account: { id: accountA, state: "signed_in" },
      catalog: {
        lifecycle: {
          discovery: "available",
          enablement: "no_separate_pinned_method",
          install: "blocked_compound_upstream_effect",
          oauth: "separate_foreground_only",
        },
        marketplaceLoadErrorCount: 0,
        marketplaces: [{ plugins: [{ id: "acceptance@example" }] }],
      },
    });
    if (
      argv[0] === "plugin"
      && ["auth", "disable", "enable", "install"].includes(argv[1] ?? "")
    ) return failure("INVALID_INPUT", 2);
    if (command === "remote.show") {
      if (this.device === "b" && (!this.#world.approved || this.#world.deviceBRevoked)) {
        return failure();
      }
      const prompt = this.#world.messages.get(sessionA) ?? "";
      const localMarker = prompt.match(/hra-live-user-input-[0-9a-f-]+/u)?.[0] ?? "";
      if (this.#world.remoteApplied) this.#world.remoteProjectionPolls += 1;
      const remoteTurnSettled = this.#world.remoteApplied
        && !this.#world.remoteTurnNeverCompletes
        && this.#world.remoteProjectionPolls > 1;
      return success(command, {
        compactHasRecoveryGap: false,
        complete: true,
        executionDevicePublicId: deviceAId,
        events: [
          { kind: "user_message", sequence: 1, text: prompt, turnId: "turn-1" },
          { kind: "assistant_message", sequence: 2, text: localMarker, turnId: "turn-1" },
          ...(this.#world.remoteApplied
            ? [
                {
                  kind: "user_message",
                  sequence: 3,
                  text: this.#world.remotePrompt,
                  turnId: "turn-remote",
                },
                ...(remoteTurnSettled
                  ? [
                      {
                        kind: "assistant_message",
                        sequence: 4,
                        text: this.#world.remoteMarker,
                        turnId: "turn-remote",
                      },
                      {
                        filesTouched: [],
                        gitActions: [],
                        kind: "turn_summary",
                        runtimeMs: 1,
                        sequence: 5,
                        turnId: "turn-remote",
                      },
                    ]
                  : []),
              ]
            : []),
        ],
        publicId: this.#world.remoteProjectionWrongAuthority ? sessionB : sessionA,
      });
    }
    if (command === "remote.send") {
      if (this.device === "b" && (!this.#world.approved || this.#world.deviceBRevoked)) {
        return failure();
      }
      this.#world.remoteMarker = argv[3]!.match(/hra-live-remote-[0-9a-f-]+/u)?.[0] ?? "";
      this.#world.remotePrompt = argv[3]!;
      return success(command, {
        commandPublicId: commandId,
        kind: "send",
        sessionPublicId: sessionA,
        state: "pending",
        targetDevicePublicId: deviceAId,
      });
    }
    if (command === "remote.command") {
      this.#world.remoteCommandPolls += 1;
      const applied = this.#world.skipRemoteClaim || this.#world.remoteCommandPolls > 1;
      if (applied) this.#world.remoteApplied = true;
      return success(command, {
        commandPublicId: commandId,
        kind: "send",
        ...(applied ? { resultCode: "APPLIED" } : {}),
        sessionPublicId: sessionA,
        state: applied ? "applied" : "effect_started",
        targetDevicePublicId: deviceAId,
      });
    }
    throw new Error(`Unexpected fake CLI command: ${command}`);
  }

  async resume(): Promise<void> {
    this.#world.deviceBOnline = true;
  }

  async suspend(): Promise<void> {
    this.#world.deviceBOnline = false;
  }
}

class FakeOperator implements LiveAcceptanceScenarioOperator {
  deviceLogins = 0;
  readonly requests: LiveAcceptanceOperatorRequest[] = [];

  async acknowledgeDeviceLogin(input: Readonly<{
    accountId: string;
    accountLabel: string;
    documentPath: string;
  }>, signal: AbortSignal): Promise<void> {
    void signal;
    const document = liveAcceptanceScenarioTesting.readOwnedProtectedJsonDocument(
      input.documentPath,
    ) as {
      accountId?: unknown;
      accountLabel?: unknown;
      cancelCommand?: unknown;
      userCode?: unknown;
      verificationUrl?: unknown;
    };
    if (
      document.accountId !== input.accountId
      || document.accountLabel !== input.accountLabel
      || document.cancelCommand !== `hra account login-cancel ${input.accountId}`
      || typeof document.userCode !== "string"
      || !/^[A-Z0-9]{4,12}(?:-[A-Z0-9]{4,12}){0,2}$/u.test(document.userCode)
      || typeof document.verificationUrl !== "string"
      || !document.verificationUrl.startsWith("https://")
    ) throw new Error("device_user_code_invalid");
    this.deviceLogins += 1;
  }

  async prepareDeviceLoginHandoff(input: Readonly<{
    accountId: string;
    accountLabel: string;
    projectDirectory: string;
  }>): Promise<string> {
    void input;
    const root = await mkdtemp(join(await realpath(tmpdir()), "hra-fake-login-"));
    await chmod(root, 0o700);
    const path = join(root, "handoff.json");
    await writeFile(path, "", { flag: "wx", mode: 0o600 });
    return path;
  }

  async progress(): Promise<void> {}

  async protectedDocument(
    request: LiveAcceptanceOperatorRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    void signal;
    this.requests.push(request);
    if (request.kind === "device_a_auth_invite") {
      return { email: "person@example.test", invite: `hra_invite_${"a".repeat(48)}` };
    }
    if (request.kind === "device_a_auth_code" || request.kind === "device_b_auth_code") {
      return { code: "01234567", email: "person@example.test" };
    }
    if (request.kind === "device_b_auth_email") return { email: "person@example.test" };
    if (request.kind === "user_answers") {
      return { answers: { acceptance_choice: { answers: ["Continue"] } } };
    }
    return { permissions: ["network"] };
  }
}

const startFakeScenario = (
  world: FakeWorld,
  operator: LiveAcceptanceScenarioOperator,
  options: Readonly<{
    remoteCommandDeadlineMs?: number;
    signal?: AbortSignal;
    sleep?: (milliseconds: number) => Promise<void>;
  }> = {},
): Readonly<{
  devices: Readonly<Record<LiveAcceptanceDeviceName, FakeDevice>>;
  promise: ReturnType<typeof runLiveAcceptanceScenario>;
}> => {
  const devices = {
    a: new FakeDevice("a", world),
    b: new FakeDevice("b", world),
  } as const;
  let clock = 1_000;
  let commandProofSequence = 0;
  const promise = runLiveAcceptanceScenario({
    bindExpectedRevokedPeer: async (publicId) => { world.boundPeer = publicId; },
    cleanup: async () => {
      if (world.boundPeer !== deviceBId || !world.deviceBRevoked) {
        throw new Error("Cleanup was not bound to the exact revoked peer.");
      }
      clock += world.cleanupClockAdvanceMs;
      world.cleanupObservedAt = clock;
      world.cleanupComplete = true;
    },
    device: (name) => devices[name],
    runId: "50000000-0000-4000-8000-000000000001",
  }, operator, attestation, {
    accountLoginDeadlineMs: 1_000,
    autonomousUsageProofDeadlineMs: 5,
    now: () => clock,
    pollIntervalMs: 1,
    presenceObservationMarginMs: 0,
    prepareCommandProof: () => {
      commandProofSequence += 1;
      const proofId = `00000000-0000-4000-8000-${String(commandProofSequence).padStart(12, "0")}`;
      const command = `/bin/echo hra-live-tool-progress | /usr/bin/tee ./.hra-live-command-proof-${proofId}.txt`;
      const commandDigest = safeLiveAcceptanceCommandDigest(command);
      if (commandDigest === undefined) throw new Error("Invalid fake command proof grammar.");
      return {
        command,
        commandDigest,
        verify: () => {
          if (world.wrongToolSideEffect) throw new Error("command_proof_content_invalid");
        },
      };
    },
    remoteCommandDeadlineMs: options.remoteCommandDeadlineMs ?? 1_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    sleep: options.sleep ?? (async (milliseconds) => { clock += milliseconds; }),
    turnDeadlineMs: 1_000,
  });
  return { devices, promise };
};

type FifoProbeResult = Readonly<{
  message: string;
  rejected: boolean;
}>;

const runPromptFailureProbe = async (source: string): Promise<FifoProbeResult> => {
  const child = spawn(process.execPath, ["-e", source], {
    cwd: join(import.meta.dir, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const completion = new Promise<Readonly<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
  const blocked = Symbol("blocked");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    completion,
    new Promise<typeof blocked>((resolvePromise) => {
      timer = setTimeout(() => resolvePromise(blocked), 3_000);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (result === blocked) {
    child.kill("SIGKILL");
    await completion;
    throw new Error("FIFO substitution blocked instead of failing promptly.");
  }
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(`FIFO probe failed: ${stderr || stdout}`);
  }
  const parsed = JSON.parse(stdout) as Partial<FifoProbeResult>;
  if (typeof parsed.message !== "string" || typeof parsed.rejected !== "boolean") {
    throw new Error("FIFO probe returned an invalid result.");
  }
  return { message: parsed.message, rejected: parsed.rejected };
};

const probeDeviceLoginBinding = (
  documentPath: string,
  expectedAccountId: string,
): ReturnType<typeof spawnSync> => {
  const moduleUrl = pathToFileURL(join(import.meta.dir, "live-acceptance-scenario.ts")).href;
  return spawnSync(process.execPath, [
    "-e",
    [
      `import { JsonlLiveAcceptanceOperator } from ${JSON.stringify(moduleUrl)};`,
      "const operator = new JsonlLiveAcceptanceOperator();",
      "try {",
      `  await operator.acknowledgeDeviceLogin({ accountId: ${JSON.stringify(expectedAccountId)}, accountLabel: 'primary', documentPath: ${JSON.stringify(documentPath)} }, new AbortController().signal);`,
      "  process.stderr.write('accepted');",
      "  process.exitCode = 2;",
      "} catch (error) {",
      "  process.stderr.write(error instanceof Error ? error.message : String(error));",
      "} finally {",
      "  operator.close();",
      "}",
    ].join("\n"),
  ], {
    cwd: join(import.meta.dir, ".."),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
};

describe("live acceptance release scenario", () => {
  test("executes the complete two-device CLI scenario and emits only bounded evidence", async () => {
    const world = new FakeWorld();
    const operator = new FakeOperator();
    const started = startFakeScenario(world, operator);
    const evidence = await started.promise;
    const devices = started.devices;

    expect(world.cleanupComplete).toBe(true);
    expect(world.boundPeer).toBe(deviceBId);
    expect(operator.deviceLogins).toBe(2);
    expect(operator.requests.map((request) => request.kind)).toEqual([
      "device_a_auth_invite",
      "device_a_auth_code",
      "device_b_auth_email",
      "device_b_auth_code",
      "user_answers",
      "permission_grant",
    ]);
    expect(operator.requests.find((request) => request.kind === "permission_grant")?.context)
      .toEqual({
        reason: "Acceptance permission proof",
        requested: ["network"],
        scope: "turn",
        summary: "Acceptance permission",
      });
    expect(evidence).toMatchObject({
      accountIds: [accountA, accountB],
      cloudTargetDigest: "a".repeat(64),
      devicePublicIds: [deviceAId, deviceBId],
      packageVersion: "0.1.0",
      pluginLifecycleEffectsRejected: ["auth", "disable", "enable", "install"],
      pluginInstallRejected: true,
      presence: ["online", "offline", "online"],
      providerIdentitiesDistinct: true,
      remoteCommand: { resultCode: "APPLIED", state: "applied" },
      sessionIds: [sessionA, sessionB],
      sourceRevision: "b".repeat(40),
      status: "passed",
      version: 1,
    });
    expect(evidence.completedAt - evidence.startedAt).toBeGreaterThan(70_000);
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("primary@example.test");
    expect(serialized).not.toContain("secondary@example.test");
    expect(serialized).not.toContain("primary@example");
    expect(serialized).not.toContain("secondary@example");
    for (const email of ["primary@example.test", "secondary@example.test"]) {
      expect(serialized).not.toContain(
        createHash("sha256").update(email, "utf8").digest("hex"),
      );
    }
    expect(Object.hasOwn(evidence, "providerIdentityDigests")).toBe(false);
    expect(serialized).not.toContain("ABCD-EFGH");
    expect(devices.a.calls.some((argv) =>
      argv.includes("--input-fd") && argv.includes(String(LIVE_ACCEPTANCE_CONTROL_FD))))
      .toBe(true);
    expect(devices.a.calls.filter((argv) =>
      argv[0] === "account" && argv[1] === "usage" && !argv.includes("--refresh")))
      .toHaveLength(2);
    for (const action of ["auth", "disable", "enable", "install"]) {
      expect(devices.a.calls.some((argv) => argv[0] === "plugin" && argv[1] === action))
        .toBe(true);
    }
  });

  test("rejects prompt-only markers and empty usage", async () => {
    const promptOnly = new FakeWorld();
    promptOnly.omitAssistantEvidence = true;
    await expect(startFakeScenario(promptOnly, new FakeOperator()).promise)
      .rejects.toThrow("session_stream_evidence_incomplete");

    const emptyUsage = new FakeWorld();
    emptyUsage.emptyUsage = true;
    await expect(startFakeScenario(emptyUsage, new FakeOperator()).promise).rejects.toThrow();

  });

  test("accepts an immediate applied receipt but waits for the exact remote turn to settle", async () => {
    const immediateApplied = new FakeWorld();
    immediateApplied.skipRemoteClaim = true;
    await expect(startFakeScenario(immediateApplied, new FakeOperator()).promise)
      .resolves.toMatchObject({ status: "passed" });
    expect(immediateApplied.remoteProjectionPolls).toBeGreaterThan(1);

    const neverSettled = new FakeWorld();
    neverSettled.remoteTurnNeverCompletes = true;
    await expect(startFakeScenario(neverSettled, new FakeOperator(), {
      remoteCommandDeadlineMs: 5,
    }).promise).rejects.toThrow("poll_deadline_exceeded");
  });

  test("rejects wrong remote projection authority and a local sequence gap", async () => {
    const wrongRemoteAuthority = new FakeWorld();
    wrongRemoteAuthority.remoteProjectionWrongAuthority = true;
    await expect(startFakeScenario(wrongRemoteAuthority, new FakeOperator()).promise)
      .rejects.toThrow("remote_projection_identity_changed");

    const localGap = new FakeWorld();
    localGap.eventSequenceGap = true;
    await expect(startFakeScenario(localGap, new FakeOperator()).promise)
      .rejects.toThrow("session_events_unordered");
  });

  test("requires exact-turn pending interactions and an exact response-written receipt", async () => {
    const wrongTurn = new FakeWorld();
    wrongTurn.wrongInteractionTurn = true;
    await expect(startFakeScenario(wrongTurn, new FakeOperator()).promise)
      .rejects.toThrow("interaction_authority_changed");

    const noOpResolution = new FakeWorld();
    noOpResolution.invalidInteractionResolution = true;
    await expect(startFakeScenario(noOpResolution, new FakeOperator()).promise).rejects.toThrow();
  });

  test("rejects wrong, secret, or multiple acceptance questions and broad permissions", async () => {
    for (const field of [
      "wrongQuestionId",
      "secretQuestion",
      "multipleQuestions",
      "allowsOtherQuestion",
    ] as const) {
      const world = new FakeWorld();
      world[field] = true;
      await expect(startFakeScenario(world, new FakeOperator()).promise)
        .rejects.toThrow("user_input_contract_invalid");
    }
    const broad = new FakeWorld();
    broad.requestedBroadPermission = true;
    await expect(startFakeScenario(broad, new FakeOperator()).promise)
      .rejects.toThrow("permission_interaction_invalid");

    class BroadGrantOperator extends FakeOperator {
      override async protectedDocument(
        request: LiveAcceptanceOperatorRequest,
        signal: AbortSignal,
      ): Promise<unknown> {
        if (request.kind === "permission_grant") {
          return { permissions: ["network", "filesystem"] };
        }
        return await super.protectedDocument(request, signal);
      }
    }
    await expect(startFakeScenario(new FakeWorld(), new BroadGrantOperator()).promise)
      .rejects.toThrow("permission_response_invalid");
  });

  test("requires the exact interaction-to-command-to-terminal event order", async () => {
    for (const evidenceOrderViolation of [
      "requested_prepared",
      "prepared_written",
      "written_command",
      "command_progress",
      "progress_completion",
      "completion_terminal",
    ] as const) {
      const world = new FakeWorld();
      world.evidenceOrderViolation = evidenceOrderViolation;
      await expect(startFakeScenario(world, new FakeOperator()).promise).rejects.toThrow();
    }
  });

  test("observes each pending interaction before resolving and retains that cursor through immediate terminal completion", async () => {
    const world = new FakeWorld();
    world.terminalImmediatelyAfterResolve = true;
    const started = startFakeScenario(world, new FakeOperator());
    await expect(started.promise).resolves.toMatchObject({ status: "passed" });
    for (const sessionId of [sessionA, sessionB]) {
      const calls = started.devices.a.calls;
      const eventCalls = calls.filter((argv) =>
        argv[0] === "session" && argv[1] === "events" && argv[2] === sessionId);
      const firstEvent = calls.findIndex((argv) =>
        argv[0] === "session" && argv[1] === "events" && argv[2] === sessionId);
      const resolution = calls.findIndex((argv) =>
        argv[0] === "interaction"
        && (argv[1] === "answer" || argv[1] === "grant")
        && argv[2] === (sessionId === sessionA ? userInteractionId : permissionInteractionId));
      expect(firstEvent).toBeGreaterThanOrEqual(0);
      expect(resolution).toBeGreaterThan(firstEvent);
      expect(eventCalls).toHaveLength(2);
      expect(eventCalls[0]).not.toContain("--cursor");
      const continued = eventCalls[1];
      if (continued === undefined) throw new Error("Missing continued event observation.");
      expect(continued.slice(continued.indexOf("--cursor"), -1))
        .toEqual(["--cursor", "cursor-first"]);
      expect(world.eventPolls.get(sessionId)).toBe(2);
    }
  });

  test("requires the exact safe command digest and rejects unrelated side-effect tools", async () => {
    for (const field of ["commandDigestMissing", "commandDigestMismatch"] as const) {
      const world = new FakeWorld();
      world[field] = true;
      await expect(startFakeScenario(world, new FakeOperator()).promise)
        .rejects.toThrow("session_stream_evidence_incomplete");
    }
    for (const itemKind of ["dynamicToolCall", "fileChange", "mcpToolCall"] as const) {
      const world = new FakeWorld();
      world.unrelatedSideEffectItemKind = itemKind;
      await expect(startFakeScenario(world, new FakeOperator()).promise)
        .rejects.toThrow("session_stream_evidence_incomplete");
    }
    const reusedCommandId = new FakeWorld();
    reusedCommandId.unrelatedSideEffectItemKind = "fileChange";
    reusedCommandId.unrelatedSideEffectReuseCommandId = true;
    await expect(startFakeScenario(reusedCommandId, new FakeOperator()).promise)
      .rejects.toThrow("session_stream_evidence_incomplete");

    const unrelatedProgress = new FakeWorld();
    unrelatedProgress.unrelatedProgressSameItem = true;
    await expect(startFakeScenario(unrelatedProgress, new FakeOperator()).promise)
      .rejects.toThrow("session_stream_evidence_incomplete");

    const duplicateCompletion = new FakeWorld();
    duplicateCompletion.duplicateCommandCompletion = true;
    await expect(startFakeScenario(duplicateCompletion, new FakeOperator()).promise)
      .rejects.toThrow("session_stream_evidence_incomplete");

    const lateProgress = new FakeWorld();
    lateProgress.lateCommandProgress = true;
    await expect(startFakeScenario(lateProgress, new FakeOperator()).promise)
      .rejects.toThrow("session_stream_evidence_incomplete");
  });

  test("requires the command side effect and autonomous revisions for both accounts", async () => {
    const wrongSideEffect = new FakeWorld();
    wrongSideEffect.wrongToolSideEffect = true;
    await expect(startFakeScenario(wrongSideEffect, new FakeOperator()).promise)
      .rejects.toThrow("command_proof_content_invalid");

    const disabledPoller = new FakeWorld();
    disabledPoller.autonomousPollerDisabled = true;
    const started = startFakeScenario(disabledPoller, new FakeOperator());
    await expect(started.promise).rejects.toThrow("autonomous_account_polling_unproven");
    expect(started.devices.a.calls.filter((argv) =>
      argv[0] === "account" && argv[1] === "usage" && !argv.includes("--refresh")))
      .toHaveLength(10);

    const delayedSecondAccount = new FakeWorld();
    delayedSecondAccount.autonomousUsageAdvanceAfterB = 4;
    const delayed = startFakeScenario(delayedSecondAccount, new FakeOperator());
    await expect(delayed.promise).resolves.toMatchObject({ status: "passed" });
    expect(delayedSecondAccount.usagePolls.get(accountA)).toBe(1);
    expect(delayedSecondAccount.usagePolls.get(accountB)).toBe(4);
    expect(delayed.devices.a.calls.filter((argv) =>
      argv[0] === "account"
      && argv[1] === "usage"
      && argv[2] === accountB
      && !argv.includes("--refresh")))
      .toHaveLength(4);
  });

  test("accepts the exact pinned paid plans and rejects non-paid or unknown variants", async () => {
    for (const providerPlan of [
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
    ]) {
      const world = new FakeWorld();
      world.providerPlan = providerPlan;
      await expect(startFakeScenario(world, new FakeOperator()).promise)
        .resolves.toMatchObject({ status: "passed" });
    }
    for (const providerPlan of ["guest", "free", "free_workspace", "unknown", "future_unreviewed_plan"]) {
      const world = new FakeWorld();
      world.providerPlan = providerPlan;
      await expect(startFakeScenario(world, new FakeOperator()).promise)
        .rejects.toThrow("provider_subscription_plan_unreviewed");
    }
  });

  test("timestamps passing evidence only after cleanup succeeds", async () => {
    const world = new FakeWorld();
    world.cleanupClockAdvanceMs = 12_345;
    const evidence = await startFakeScenario(world, new FakeOperator()).promise;
    expect(world.cleanupComplete).toBe(true);
    const cleanupObservedAt = world.cleanupObservedAt;
    if (cleanupObservedAt === undefined) throw new Error("Cleanup timestamp was not observed.");
    expect(evidence.completedAt).toBe(cleanupObservedAt);
  });

  test("loads the protected-open authority lazily across reviewed glibc and musl names", async () => {
    expect(liveAcceptanceScenarioTesting.protectedOutputOpenAtLibrariesForPlatform(
      "linux",
      "x64",
    )).toEqual([
      "libc.so.6",
      "libc.musl-x86_64.so.1",
      "/lib/libc.musl-x86_64.so.1",
      "/usr/lib/libc.musl-x86_64.so.1",
    ]);
    expect(liveAcceptanceScenarioTesting.protectedOutputOpenAtLibrariesForPlatform(
      "linux",
      "arm64",
    )).toEqual([
      "libc.so.6",
      "libc.musl-aarch64.so.1",
      "/lib/libc.musl-aarch64.so.1",
      "/usr/lib/libc.musl-aarch64.so.1",
    ]);
    const attempts: string[] = [];
    expect(liveAcceptanceScenarioTesting.loadProtectedOutputNativeOpenAtLibrary(
      "linux",
      "x64",
      (library) => {
        attempts.push(library);
        throw new Error("not installed");
      },
    )).toBeNull();
    expect(attempts).toEqual([
      ...liveAcceptanceScenarioTesting.protectedOutputOpenAtLibrariesForPlatform(
        "linux",
        "x64",
      ),
    ]);

    const createdRoot = await mkdtemp(join(tmpdir(), "hra-protected-loader-"));
    await chmod(createdRoot, 0o700);
    const root = await realpath(createdRoot);
    const documentPath = join(root, "document.json");
    await writeFile(documentPath, "{\"answer\":42}", { mode: 0o600 });
    let protectedOpenRequests = 0;
    try {
      expect(() => liveAcceptanceScenarioTesting.readOwnedProtectedJsonDocument(
        documentPath,
        {
          loadNativeOpenAtLibrary: () => {
            protectedOpenRequests += 1;
            return null;
          },
        },
      )).toThrow("protected_document_unsupported");
      expect(protectedOpenRequests).toBe(1);
      expect(JSON.parse(await readFile(documentPath, "utf8"))).toEqual({ answer: 42 });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("accepts only stable owned single-link protected JSON documents and preserves them", async () => {
    const createdRoot = await mkdtemp(join(tmpdir(), "hra-protected-hostile-"));
    await chmod(createdRoot, 0o700);
    const root = await realpath(createdRoot);
    const makeCase = async (name: string, content = "{\"answer\":42}") => {
      const directory = join(root, name);
      await mkdir(directory, { mode: 0o700 });
      const path = join(directory, "document.json");
      await writeFile(path, content, { mode: 0o600 });
      return { directory, path };
    };
    try {
      const valid = await makeCase("valid");
      expect(liveAcceptanceScenarioTesting.readOwnedProtectedJsonDocument(valid.path))
        .toEqual({ answer: 42 });
      expect((await stat(valid.path)).isFile()).toBe(true);
      expect(() => liveAcceptanceScenarioTesting.readOwnedProtectedJsonDocument("document.json"))
        .toThrow("protected_document_path_invalid");

      const symbolic = await makeCase("symlink");
      const symbolicPath = join(symbolic.directory, "symbolic.json");
      await symlink(symbolic.path, symbolicPath);
      expect(() => liveAcceptanceScenarioTesting.readOwnedProtectedJsonDocument(symbolicPath))
        .toThrow();

      const symbolicParentTarget = await makeCase("parent-target");
      const symbolicParent = join(root, "parent-symbolic");
      await symlink(symbolicParentTarget.directory, symbolicParent);
      expect(() => liveAcceptanceScenarioTesting.readOwnedProtectedJsonDocument(
        join(symbolicParent, "document.json"),
      )).toThrow();

      const permissive = await makeCase("mode");
      await chmod(permissive.path, 0o644);
      expect(() => liveAcceptanceScenarioTesting.readOwnedProtectedJsonDocument(permissive.path))
        .toThrow();

      const permissiveParent = await makeCase("parent-mode");
      await chmod(permissiveParent.directory, 0o755);
      expect(() => liveAcceptanceScenarioTesting.readOwnedProtectedJsonDocument(
        permissiveParent.path,
      )).toThrow("protected_document_parent_invalid");

      const wrongOwner = await makeCase("owner");
      expect(() => liveAcceptanceScenarioTesting.readOwnedProtectedJsonDocument(
        wrongOwner.path,
        { expectedOwnerUid: (process.getuid?.() ?? 0) + 1 },
      )).toThrow();

      const linked = await makeCase("link");
      await link(linked.path, join(linked.directory, "second-link.json"));
      expect(() => liveAcceptanceScenarioTesting.readOwnedProtectedJsonDocument(linked.path))
        .toThrow();

      const raced = await makeCase("race");
      expect(() => liveAcceptanceScenarioTesting.readOwnedProtectedJsonDocument(raced.path, {
        beforePostflight: () => chmodSync(raced.path, 0o644),
      })).toThrow();

      const contentRaced = await makeCase("content-race");
      expect(() => liveAcceptanceScenarioTesting.readOwnedProtectedJsonDocument(
        contentRaced.path,
        { beforePostflight: () => writeFileSync(contentRaced.path, "{\"answer\":43}") },
      )).toThrow("protected_document_changed");

      const substituted = await makeCase("substitution");
      expect(() => liveAcceptanceScenarioTesting.readOwnedProtectedJsonDocument(
        substituted.path,
        {
          beforePostflight: () => {
            renameSync(substituted.path, `${substituted.path}.original`);
            writeFileSync(substituted.path, "{\"answer\":99}", { mode: 0o600 });
          },
        },
      )).toThrow();

      const parentSwapped = await makeCase("parent-swap");
      const originalParent = `${parentSwapped.directory}.original`;
      expect(() => liveAcceptanceScenarioTesting.readOwnedProtectedJsonDocument(
        parentSwapped.path,
        {
          beforeChildOpen: () => {
            renameSync(parentSwapped.directory, originalParent);
            mkdirSync(parentSwapped.directory, { mode: 0o700 });
            writeFileSync(parentSwapped.path, "{\"answer\":99}", { mode: 0o600 });
          },
        },
      )).toThrow();
      expect(JSON.parse(await readFile(parentSwapped.path, "utf8"))).toEqual({ answer: 99 });

      const exactBoundary = await makeCase("exact-boundary", `"${"x".repeat(64 * 1024 - 2)}"`);
      expect((liveAcceptanceScenarioTesting.readOwnedProtectedJsonDocument(
        exactBoundary.path,
      ) as string).length).toBe(64 * 1024 - 2);

      const emptyHandoffDirectory = join(root, "empty-handoff");
      await mkdir(emptyHandoffDirectory, { mode: 0o700 });
      const emptyHandoffPath = join(emptyHandoffDirectory, "handoff.json");
      await writeFile(emptyHandoffPath, "", { mode: 0o600 });
      liveAcceptanceScenarioTesting.writeOwnedProtectedJsonDocument(
        emptyHandoffPath,
        { answer: 42 },
      );
      expect(liveAcceptanceScenarioTesting.readOwnedProtectedJsonDocument(emptyHandoffPath))
        .toEqual({ answer: 42 });
      const nonemptyHandoff = await makeCase("nonempty-handoff");
      expect(() => liveAcceptanceScenarioTesting.writeOwnedProtectedJsonDocument(
        nonemptyHandoff.path,
        { answer: 99 },
      )).toThrow("protected_document_not_empty");

      const oversized = await makeCase("oversize", `"${"x".repeat(64 * 1024)}"`);
      expect(() => liveAcceptanceScenarioTesting.readOwnedProtectedJsonDocument(oversized.path))
        .toThrow("protected_document_oversize");

      const multipleValues = await makeCase("multiple-values", "{} {}");
      expect(() => liveAcceptanceScenarioTesting.readOwnedProtectedJsonDocument(
        multipleValues.path,
      )).toThrow();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("rejects FIFO child substitutions promptly across every protected open", async () => {
    const createdRoot = await mkdtemp(join(tmpdir(), "hra-protected-fifo-"));
    await chmod(createdRoot, 0o700);
    const root = await realpath(createdRoot);
    const moduleUrl = pathToFileURL(join(import.meta.dir, "live-acceptance-scenario.ts")).href;
    const makeDirectory = async (name: string): Promise<string> => {
      const directory = join(root, name);
      await mkdir(directory, { mode: 0o700 });
      return directory;
    };
    const makeFifo = (path: string): void => {
      const result = spawnSync("/usr/bin/mkfifo", [path], { encoding: "utf8" });
      if (result.status !== 0) {
        throw new Error(`mkfifo failed: ${result.stderr}`);
      }
      chmodSync(path, 0o600);
    };
    const probeSource = (operation: string): string => [
      'import { renameSync } from "node:fs";',
      'import { join } from "node:path";',
      `import { liveAcceptanceScenarioTesting } from ${JSON.stringify(moduleUrl)};`,
      "let rejected = false;",
      'let message = "";',
      "try {",
      operation,
      "} catch (error) {",
      "  rejected = true;",
      "  message = error instanceof Error ? error.message : String(error);",
      "}",
      'process.stdout.write(`${JSON.stringify({ message, rejected })}\\n`);',
      "if (!rejected) process.exitCode = 2;",
    ].join("\n");
    try {
      const readDirectory = await makeDirectory("read");
      const readPath = join(readDirectory, "document.json");
      makeFifo(readPath);

      const writeDirectory = await makeDirectory("write");
      const writePath = join(writeDirectory, "document.json");
      makeFifo(writePath);

      const rebindDirectory = await makeDirectory("rebind");
      const rebindPath = join(rebindDirectory, "document.json");
      const rebindReplacement = join(rebindDirectory, "replacement.fifo");
      await writeFile(rebindPath, "{\"answer\":42}", { mode: 0o600 });
      makeFifo(rebindReplacement);

      const proofDirectory = await makeDirectory("proof");
      const proofReplacement = join(proofDirectory, "replacement.fifo");
      makeFifo(proofReplacement);

      const settled = await Promise.allSettled([
        runPromptFailureProbe(probeSource(
          `  liveAcceptanceScenarioTesting.readOwnedProtectedJsonDocument(${JSON.stringify(readPath)});`,
        )),
        runPromptFailureProbe(probeSource(
          `  liveAcceptanceScenarioTesting.writeOwnedProtectedJsonDocument(${JSON.stringify(writePath)}, { answer: 42 });`,
        )),
        runPromptFailureProbe(probeSource([
          `  const documentPath = ${JSON.stringify(rebindPath)};`,
          "  liveAcceptanceScenarioTesting.readOwnedProtectedJsonDocument(documentPath, {",
          "    beforePostflight: () => {",
          '      renameSync(documentPath, `${documentPath}.original`);',
          `      renameSync(${JSON.stringify(rebindReplacement)}, documentPath);`,
          "    },",
          "  });",
        ].join("\n"))),
        runPromptFailureProbe(probeSource([
          '  let proofPath = "";',
          "  const proof = liveAcceptanceScenarioTesting.createCommandProof(",
          `    ${JSON.stringify(proofDirectory)},`,
          "    {",
          "      beforeVerifyOpen: () => {",
          '        renameSync(proofPath, `${proofPath}.original`);',
          `        renameSync(${JSON.stringify(proofReplacement)}, proofPath);`,
          "      },",
          "    },",
          "  );",
          '  const fileName = proof.command.match(/\\.\\/(\\.hra-live-command-proof-[0-9a-f-]+\\.txt)$/u)?.[1];',
          '  if (fileName === undefined) throw new Error("Missing command proof file name.");',
          `  proofPath = join(${JSON.stringify(proofDirectory)}, fileName);`,
          "  proof.verify();",
        ].join("\n"))),
      ]);
      const results = settled.map((result) => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
      });
      expect(results).toEqual(Array.from({ length: 4 }, () => ({
        message: "protected_document_file_invalid",
        rejected: true,
      })));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 10_000);

  test("creates an isolated exact echo command proof and rejects a wrong side effect", async () => {
    const createdDirectory = await mkdtemp(join(tmpdir(), "hra-command-proof-"));
    await chmod(createdDirectory, 0o700);
    const directory = await realpath(createdDirectory);
    try {
      const proof = liveAcceptanceScenarioTesting.createCommandProof(directory);
      expect(proof.command).toMatch(
        /^\/bin\/echo hra-live-tool-progress \| \/usr\/bin\/tee \.\/\.hra-live-command-proof-[0-9a-f-]+\.txt$/u,
      );
      expect(safeLiveAcceptanceCommandDigest(proof.command)).toBe(proof.commandDigest);
      const child = spawn("/bin/sh", ["-c", proof.command], {
        cwd: directory,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const close = await new Promise<number | null>((resolvePromise) => {
        child.once("close", resolvePromise);
      });
      expect(close).toBe(0);
      proof.verify();

      const fileName = proof.command.match(/\.\/(\.hra-live-command-proof-[0-9a-f-]+\.txt)$/u)?.[1];
      if (fileName === undefined) throw new Error("Missing command proof file name.");
      await writeFile(join(directory, fileName), "wrong\n");
      expect(() => proof.verify()).toThrow("command_proof_content_invalid");

      const unexecuted = liveAcceptanceScenarioTesting.createCommandProof(directory);
      expect(() => unexecuted.verify()).toThrow("command_proof_content_invalid");

      const symbolicDirectory = join(dirname(directory), `${basename(directory)}-symbolic`);
      await symlink(directory, symbolicDirectory);
      expect(() => liveAcceptanceScenarioTesting.createCommandProof(symbolicDirectory))
        .toThrow("command_proof_directory_invalid");
      await rm(symbolicDirectory);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("binds command proof children through held directory descriptors across parent swaps", async () => {
    const createdRoot = await mkdtemp(join(tmpdir(), "hra-command-proof-swap-"));
    await chmod(createdRoot, 0o700);
    const root = await realpath(createdRoot);
    const createDirectory = join(root, "create");
    const verifyDirectory = join(root, "verify");
    await mkdir(createDirectory, { mode: 0o700 });
    await mkdir(verifyDirectory, { mode: 0o700 });
    try {
      expect(() => liveAcceptanceScenarioTesting.createCommandProof(createDirectory, {
        beforeCreate: () => {
          renameSync(createDirectory, `${createDirectory}.original`);
          mkdirSync(createDirectory, { mode: 0o700 });
        },
      })).toThrow();

      let swapped = false;
      const proof = liveAcceptanceScenarioTesting.createCommandProof(verifyDirectory, {
        beforeVerifyOpen: () => {
          if (swapped) return;
          swapped = true;
          renameSync(verifyDirectory, `${verifyDirectory}.original`);
          mkdirSync(verifyDirectory, { mode: 0o700 });
        },
      });
      const child = spawn("/bin/sh", ["-c", proof.command], {
        cwd: verifyDirectory,
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(await new Promise<number | null>((resolvePromise) => {
        child.once("close", resolvePromise);
      })).toBe(0);
      expect(() => proof.verify()).toThrow();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("JSONL operator abort closes the standard-input read and lets the process exit", async () => {
    const moduleUrl = pathToFileURL(join(import.meta.dir, "live-acceptance-scenario.ts")).href;
    const child = spawn(process.execPath, [
      "-e",
      [
        `import { JsonlLiveAcceptanceOperator } from ${JSON.stringify(moduleUrl)};`,
        "const operator = new JsonlLiveAcceptanceOperator();",
        "const controller = new AbortController();",
        "let subscriptions = 0;",
        "const signal = {",
        "  get aborted() { return controller.signal.aborted; },",
        "  get reason() { return controller.signal.reason; },",
        "  addEventListener(type, listener, options) {",
        "    controller.signal.addEventListener(type, listener, options);",
        "    subscriptions += 1;",
        "    // The second subscription is installed immediately before the pending input read.",
        "    if (subscriptions === 2) setImmediate(() => controller.abort());",
        "  },",
        "  removeEventListener(type, listener, options) {",
        "    controller.signal.removeEventListener(type, listener, options);",
        "  },",
        "};",
        "try {",
        "  await operator.protectedDocument({ kind: 'device_a_auth_invite', prompt: 'probe' }, signal);",
        "  process.exitCode = 2;",
        "} catch {",
        "  if (!controller.signal.aborted) process.exitCode = 3;",
        "}",
        "process.stdout.write(JSON.stringify({ status: 'after_abort', version: 1 }) + '\\n');",
      ].join("\n"),
    ], {
      cwd: join(import.meta.dir, ".."),
      stdio: ["pipe", "pipe", "ignore"],
    });
    const operatorInput = child.stdin;
    const operatorOutput = child.stdout;
    const closePromise = new Promise<Readonly<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>>((resolvePromise) => {
      child.once("close", (code, signal) => {
        resolvePromise({ code, signal });
      });
    });
    const bounded = async <T>(promise: Promise<T>): Promise<T | null> => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<null>((resolvePromise) => {
            timeout = setTimeout(() => resolvePromise(null), 3_000);
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    };
    let outputLines: ReturnType<typeof createInterface> | undefined;
    try {
      outputLines = createInterface({ input: operatorOutput });
      const outputIterator = outputLines[Symbol.asyncIterator]();
      const frame = await bounded(outputIterator.next());
      if (frame === null || frame.done) throw new Error("Missing JSONL operator request.");
      expect(JSON.parse(frame.value) as unknown).toMatchObject({
        kind: "device_a_auth_invite",
        prompt: "probe",
        requestId: expect.any(String),
        type: "protected_input_required",
        version: 1,
      });
      const finalFrame = await bounded(outputIterator.next());
      if (finalFrame === null || finalFrame.done) throw new Error("Missing post-abort JSONL output.");
      expect(JSON.parse(finalFrame.value) as unknown).toEqual({
        status: "after_abort",
        version: 1,
      });
      expect(await bounded(closePromise)).toEqual({ code: 0, signal: null });
    } finally {
      const inputClosed = operatorInput.closed
        ? Promise.resolve()
        : new Promise<void>((resolvePromise) => operatorInput.once("close", resolvePromise));
      const outputClosed = operatorOutput.closed
        ? Promise.resolve()
        : new Promise<void>((resolvePromise) => operatorOutput.once("close", resolvePromise));
      outputLines?.close();
      operatorInput.destroy();
      operatorOutput.destroy();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await Promise.all([closePromise, inputClosed, outputClosed]);
    }
  }, 10_000);

  test("JSONL routes Codex login secrets through a caller-owned protected handoff file", async () => {
    const moduleUrl = pathToFileURL(join(import.meta.dir, "live-acceptance-scenario.ts")).href;
    const createdDirectory = await mkdtemp(join(tmpdir(), "hra-login-handoff-"));
    await chmod(createdDirectory, 0o700);
    const directory = await realpath(createdDirectory);
    const handoffPath = join(directory, "codex-login.json");
    await writeFile(handoffPath, "", { mode: 0o600 });
    const userCode = "ABCD-EFGH";
    const verificationUrl = "https://example.test/device";
    const child = spawn(process.execPath, [
      "-e",
      [
        `import { JsonlLiveAcceptanceOperator, liveAcceptanceScenarioTesting } from ${JSON.stringify(moduleUrl)};`,
        "const operator = new JsonlLiveAcceptanceOperator();",
        "const signal = new AbortController().signal;",
        `const accountId = 'acct_${"1".repeat(32)}';`,
        "const documentPath = await operator.prepareDeviceLoginHandoff({ accountId, accountLabel: 'primary', projectDirectory: '/unused' }, signal);",
        `liveAcceptanceScenarioTesting.writeOwnedProtectedJsonDocument(documentPath, { accountId: 'acct_${"1".repeat(32)}', accountLabel: 'primary', cancelCommand: 'hra account login-cancel acct_${"1".repeat(32)}', method: 'device_code', type: 'codex_device_login', userCode: ${JSON.stringify(userCode)}, verificationUrl: ${JSON.stringify(verificationUrl)}, version: 1 });`,
        "await operator.acknowledgeDeviceLogin({ accountId, accountLabel: 'primary', documentPath }, signal);",
        "await operator.flush();",
        "operator.close();",
      ].join("\n"),
    ], {
      cwd: join(import.meta.dir, ".."),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    const frames: string[] = [];
    const closePromise = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>(
      (resolvePromise) => child.once("close", (code, signal) => resolvePromise({ code, signal })),
    );
    try {
      const handoffLine = await iterator.next();
      if (handoffLine.done) throw new Error("Missing login handoff request.");
      frames.push(handoffLine.value);
      const handoffRequest = JSON.parse(handoffLine.value) as { requestId: string };
      expect(handoffRequest).toMatchObject({
        accountId: `acct_${"1".repeat(32)}`,
        accountLabel: "primary",
        responseMode: "absolute_canonical_owned_mode_0600_empty_file",
        type: "device_login_handoff_file_required",
        version: 1,
      });
      child.stdin.write(`${JSON.stringify({
        documentPath: handoffPath,
        requestId: handoffRequest.requestId,
        type: "device_login_handoff_file",
        version: 1,
      })}\n`);

      const acknowledgementLine = await iterator.next();
      if (acknowledgementLine.done) throw new Error("Missing login acknowledgement request.");
      frames.push(acknowledgementLine.value);
      const acknowledgementRequest = JSON.parse(acknowledgementLine.value) as { requestId: string };
      expect(acknowledgementRequest).toMatchObject({
        accountId: `acct_${"1".repeat(32)}`,
        accountLabel: "primary",
        handoffDocumentPath: handoffPath,
        responseMode: "fixed_nonsecret_acknowledgement",
        type: "device_login_required",
        version: 1,
      });
      expect(frames.join("\n")).not.toContain(userCode);
      expect(frames.join("\n")).not.toContain(verificationUrl);
      expect(JSON.parse(await readFile(handoffPath, "utf8"))).toEqual({
        accountId: `acct_${"1".repeat(32)}`,
        accountLabel: "primary",
        cancelCommand: `hra account login-cancel acct_${"1".repeat(32)}`,
        method: "device_code",
        type: "codex_device_login",
        userCode,
        verificationUrl,
        version: 1,
      });
      child.stdin.write(`${JSON.stringify({
        acknowledged: true,
        requestId: acknowledgementRequest.requestId,
        type: "device_login",
        version: 1,
      })}\n`);
      expect(await closePromise).toEqual({ code: 0, signal: null });
      expect((await stat(handoffPath)).isFile()).toBe(true);
    } finally {
      lines.close();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closePromise;
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  test("JSONL rejects a protected device-login document bound to a different account ID", async () => {
    const createdDirectory = await mkdtemp(join(tmpdir(), "hra-login-account-binding-"));
    await chmod(createdDirectory, 0o700);
    const directory = await realpath(createdDirectory);
    const handoffPath = join(directory, "codex-login.json");
    const expectedAccountId = `acct_${"1".repeat(32)}`;
    const userCode = "ABCD-EFGH";
    const verificationUrl = "https://example.test/device";
    try {
      await writeFile(handoffPath, JSON.stringify({
        accountId: `acct_${"9".repeat(32)}`,
        accountLabel: "primary",
        cancelCommand: `hra account login-cancel ${expectedAccountId}`,
        method: "device_code",
        type: "codex_device_login",
        userCode,
        verificationUrl,
        version: 1,
      }), { flag: "wx", mode: 0o600 });
      const result = probeDeviceLoginBinding(handoffPath, expectedAccountId);
      expect({ signal: result.signal, status: result.status }).toEqual({ signal: null, status: 0 });
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("device_login_account_changed");
      expect(`${result.stdout}${result.stderr}`).not.toContain(userCode);
      expect(`${result.stdout}${result.stderr}`).not.toContain(verificationUrl);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("JSONL rejects a protected device-login document with a noncanonical cancel command", async () => {
    const createdDirectory = await mkdtemp(join(tmpdir(), "hra-login-cancel-binding-"));
    await chmod(createdDirectory, 0o700);
    const directory = await realpath(createdDirectory);
    const handoffPath = join(directory, "codex-login.json");
    const expectedAccountId = `acct_${"1".repeat(32)}`;
    const userCode = "ABCD-EFGH";
    const verificationUrl = "https://example.test/device";
    try {
      await writeFile(handoffPath, JSON.stringify({
        accountId: expectedAccountId,
        accountLabel: "primary",
        cancelCommand: `hra account login-cancel acct_${"9".repeat(32)}`,
        method: "device_code",
        type: "codex_device_login",
        userCode,
        verificationUrl,
        version: 1,
      }), { flag: "wx", mode: 0o600 });
      const result = probeDeviceLoginBinding(handoffPath, expectedAccountId);
      expect({ signal: result.signal, status: result.status }).toEqual({ signal: null, status: 0 });
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("device_login_cancel_command_changed");
      expect(`${result.stdout}${result.stderr}`).not.toContain(userCode);
      expect(`${result.stdout}${result.stderr}`).not.toContain(verificationUrl);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("JSONL operator refuses inline authentication documents", async () => {
    const moduleUrl = pathToFileURL(join(import.meta.dir, "live-acceptance-scenario.ts")).href;
    const child = spawn(process.execPath, [
      "-e",
      [
        `import { JsonlLiveAcceptanceOperator } from ${JSON.stringify(moduleUrl)};`,
        "const operator = new JsonlLiveAcceptanceOperator();",
        "try {",
        "  await operator.protectedDocument({ kind: 'device_a_auth_invite', prompt: 'probe' }, new AbortController().signal);",
        "  process.exitCode = 2;",
        "} catch {",
        "  process.stdout.write(JSON.stringify({ status: 'inline_rejected', version: 1 }) + '\\n');",
        "}",
      ].join("\n"),
    ], {
      cwd: join(import.meta.dir, ".."),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    const closePromise = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>(
      (resolvePromise) => child.once("close", (code, signal) => resolvePromise({ code, signal })),
    );
    try {
      const requestLine = await iterator.next();
      if (requestLine.done) throw new Error("Missing authentication request.");
      const request = JSON.parse(requestLine.value) as { requestId: string };
      expect(request).toMatchObject({
        responseMode: "absolute_canonical_owned_mode_0600_json_file",
        type: "protected_input_required",
      });
      child.stdin.write(`${JSON.stringify({
        document: { email: "must-not-be-accepted@example.test", invite: "secret" },
        requestId: request.requestId,
        type: "protected_input",
        version: 1,
      })}\n`);
      const resultLine = await iterator.next();
      if (resultLine.done) throw new Error("Missing inline-refusal result.");
      expect(JSON.parse(resultLine.value) as unknown).toEqual({
        status: "inline_rejected",
        version: 1,
      });
      expect(await closePromise).toEqual({ code: 0, signal: null });
    } finally {
      lines.close();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closePromise;
    }
  }, 10_000);

  test("JSONL operator reads configuration and matching responses from one stdin stream", async () => {
    const moduleUrl = pathToFileURL(join(import.meta.dir, "live-acceptance-scenario.ts")).href;
    const createdProtectedDirectory = await mkdtemp(join(tmpdir(), "hra-protected-input-"));
    await chmod(createdProtectedDirectory, 0o700);
    const protectedDirectory = await realpath(createdProtectedDirectory);
    const protectedPath = join(protectedDirectory, "document.json");
    await writeFile(protectedPath, JSON.stringify({ answer: 42 }), { mode: 0o600 });
    const child = spawn(process.execPath, [
      "-e",
      [
        `import { createStandardJsonlLiveAcceptanceScenario } from ${JSON.stringify(moduleUrl)};`,
        "const controller = new AbortController();",
        "const { configuration, operator } = await createStandardJsonlLiveAcceptanceScenario(controller.signal);",
        `if (configuration.cloudDeploymentUrl !== ${JSON.stringify(DEFAULT_CLOUD_DEPLOYMENT_URL)}) throw new Error('wrong_config');`,
        "const document = await operator.protectedDocument({ kind: 'device_a_auth_invite', prompt: 'probe' }, controller.signal);",
        "if (document?.answer !== 42) throw new Error('wrong_response');",
        "await operator.progress('complete');",
        "await operator.flush();",
        "operator.close();",
      ].join("\n"),
    ], {
      cwd: join(import.meta.dir, ".."),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let childStderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      childStderr += chunk;
    });
    const outputLines = createInterface({ input: child.stdout });
    const outputIterator = outputLines[Symbol.asyncIterator]();
    const closePromise = new Promise<Readonly<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>>((resolvePromise) => {
      child.once("close", (code, signal) => resolvePromise({ code, signal }));
    });
    const writeLine = async (line: string): Promise<void> => {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        child.stdin.write(`${line}\n`, (error) => {
          if (error === undefined || error === null) resolvePromise();
          else rejectPromise(error);
        });
      });
    };
    const write = async (value: unknown): Promise<void> => {
      await writeLine(JSON.stringify(value));
    };
    try {
      await writeLine(`  ${JSON.stringify({
        cloudDeploymentUrl: DEFAULT_CLOUD_DEPLOYMENT_URL,
        operator: { kind: "jsonl" },
        version: 1,
      })}  `);
      const requestLine = await outputIterator.next();
      if (requestLine.done) throw new Error("Missing JSONL operator request.");
      const request = JSON.parse(requestLine.value) as { requestId?: unknown };
      const requestId = request.requestId;
      expect(typeof requestId).toBe("string");
      expect(request).toMatchObject({
        documentFileDisposition: "hra_preserves_caller_removes_after_final_result",
        kind: "device_a_auth_invite",
        prompt: "probe",
        requestId,
        responseMode: "absolute_canonical_owned_mode_0600_json_file",
        type: "protected_input_required",
        version: 1,
      });
      await write({
        documentPath: protectedPath,
        requestId,
        type: "protected_input_file",
        version: 1,
      });
      const progressLine = await outputIterator.next();
      if (progressLine.done) throw new Error(`Missing JSONL progress frame. ${childStderr}`);
      expect(JSON.parse(progressLine.value) as unknown).toEqual({
        step: "complete",
        type: "progress",
        version: 1,
      });
      expect(await closePromise).toEqual({ code: 0, signal: null });
      expect(await outputIterator.next()).toMatchObject({ done: true });
      expect(childStderr).toBe("");
      expect((await stat(protectedPath)).isFile()).toBe(true);
    } finally {
      outputLines.close();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closePromise;
      await rm(protectedDirectory, { force: true, recursive: true });
    }
  }, 10_000);

  test("JSONL operator rejects an otherwise-valid first frame above 8 KiB", async () => {
    const moduleUrl = pathToFileURL(join(import.meta.dir, "live-acceptance-scenario.ts")).href;
    const child = spawn(process.execPath, [
      "-e",
      [
        `import { createStandardJsonlLiveAcceptanceScenario } from ${JSON.stringify(moduleUrl)};`,
        "const controller = new AbortController();",
        "try {",
        "  await createStandardJsonlLiveAcceptanceScenario(controller.signal);",
        "  process.stdout.write('accepted\\n');",
        "  process.exitCode = 2;",
        "} catch {",
        "  process.stdout.write('rejected\\n');",
        "}",
      ].join("\n"),
    ], {
      cwd: join(import.meta.dir, ".."),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const closePromise = new Promise<Readonly<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>>((resolvePromise) => {
      child.once("close", (code, signal) => resolvePromise({ code, signal }));
    });
    try {
      const validConfiguration = JSON.stringify({
        cloudDeploymentUrl: DEFAULT_CLOUD_DEPLOYMENT_URL,
        operator: { kind: "jsonl" },
        version: 1,
      });
      child.stdin.end(`${" ".repeat(8 * 1024)}${validConfiguration}\n`);
      expect(await closePromise).toEqual({ code: 0, signal: null });
      expect(stdout).toBe("rejected\n");
      expect(stderr).toBe("");
    } finally {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closePromise;
    }
  }, 10_000);

  test("rejects terminal-unsafe provider login handoff before rendering it", async () => {
    const world = new FakeWorld();
    world.unsafeDeviceCode = true;
    const operator = new FakeOperator();
    await expect(startFakeScenario(world, operator).promise)
      .rejects.toThrow("device_user_code_invalid");
    expect(operator.deviceLogins).toBe(0);
  });

  test("rejects a different B cloud identity before B auth has an effect", async () => {
    class MismatchedIdentityOperator extends FakeOperator {
      override async protectedDocument(
        request: LiveAcceptanceOperatorRequest,
        signal: AbortSignal,
      ): Promise<unknown> {
        const document = await super.protectedDocument(request, signal);
        return request.kind === "device_b_auth_email"
          ? { email: "different@example.test" }
          : document;
      }
    }
    const world = new FakeWorld();
    const started = startFakeScenario(world, new MismatchedIdentityOperator());
    await expect(started.promise).rejects.toThrow("protected_auth_identity_changed");
    expect(started.devices.b.calls.filter((argv) =>
      argv[0] === "auth" && argv[1] === "login")).toHaveLength(0);
  });

  test("interrupts an operator read before starting the protected auth effect", async () => {
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolvePromise) => {
      markReadStarted = resolvePromise;
    });
    class BlockingOperator extends FakeOperator {
      override async protectedDocument(
        request: LiveAcceptanceOperatorRequest,
        signal: AbortSignal,
      ): Promise<unknown> {
        if (request.kind !== "device_a_auth_invite") {
          return await super.protectedDocument(request, signal);
        }
        markReadStarted();
        return await new Promise<never>((_resolve, rejectPromise) => {
          const abort = () => rejectPromise(new Error("operator_interrupted"));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      }
    }
    const controller = new AbortController();
    const started = startFakeScenario(new FakeWorld(), new BlockingOperator(), {
      signal: controller.signal,
    });
    await readStarted;
    controller.abort();
    await expect(started.promise).rejects.toThrow("operator_interrupted");
    expect(started.devices.a.calls.filter((argv) =>
      argv[0] === "auth" && argv[1] === "login")).toHaveLength(0);
  });

  test("interrupts an account-status poll without starting another effect", async () => {
    const world = new FakeWorld();
    world.accountLoginPending = true;
    const controller = new AbortController();
    const started = startFakeScenario(world, new FakeOperator(), {
      signal: controller.signal,
      sleep: async () => { controller.abort(); },
    });
    await expect(started.promise).rejects.toThrow("operator_interrupted");
    expect(started.devices.a.calls.filter((argv) =>
      argv[0] === "account" && argv[1] === "show")).toHaveLength(1);
  });

  test("requires an explicit canonical candidate origin and explicit operator mode", () => {
    expect(liveAcceptanceScenarioConfigurationSchema.safeParse({
      cloudDeploymentUrl: "https://EXAMPLE.convex.cloud/",
      operator: { kind: "terminal" },
      version: 1,
    }).success).toBe(false);
    for (const cloudDeploymentUrl of [
      "http://127.0.0.1:3210",
      "https://wrong-candidate.convex.cloud",
    ]) {
      expect(liveAcceptanceScenarioConfigurationSchema.safeParse({
        cloudDeploymentUrl,
        operator: { kind: "jsonl" },
        version: 1,
      }).success).toBe(false);
    }
    expect(liveAcceptanceScenarioConfigurationSchema.safeParse({
      operator: { kind: "terminal" },
      version: 1,
    }).success).toBe(false);
    expect(liveAcceptanceScenarioConfigurationSchema.parse({
      cloudDeploymentUrl: DEFAULT_CLOUD_DEPLOYMENT_URL,
      operator: { kind: "jsonl" },
      version: 1,
    })).toEqual({
      cloudDeploymentUrl: DEFAULT_CLOUD_DEPLOYMENT_URL,
      operator: { kind: "jsonl" },
      version: 1,
    });
  });

  test("the executable requires one explicit terminal or agent scenario mode", async () => {
    const child = Bun.spawn([
      process.execPath,
      join(import.meta.dir, "live-acceptance.ts"),
    ], {
      cwd: join(import.meta.dir, ".."),
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("--scenario-fd");
    expect(stderr).toContain("--scenario-stdin");
  });

  test("the executable rejects terminal configuration on agent stdin with a final frame", async () => {
    const child = Bun.spawn([
      process.execPath,
      join(import.meta.dir, "live-acceptance.ts"),
      "--scenario-stdin",
    ], {
      cwd: join(import.meta.dir, ".."),
      stdin: "pipe",
      stderr: "pipe",
      stdout: "pipe",
    });
    await child.stdin.write(`${JSON.stringify({
      cloudDeploymentUrl: DEFAULT_CLOUD_DEPLOYMENT_URL,
      operator: { kind: "terminal" },
      version: 1,
    })}\n`);
    await child.stdin.end();
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe(`${JSON.stringify({
      ok: false,
      status: "startup_failed",
      version: 1,
    })}\n`);
    expect(stderr).toContain("startup failed safely");
  });

  test("the executable rejects JSONL configuration from terminal descriptor mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hra-scenario-mode-"));
    try {
      const configurationPath = join(directory, "configuration.json");
      await writeFile(configurationPath, JSON.stringify({
        cloudDeploymentUrl: DEFAULT_CLOUD_DEPLOYMENT_URL,
        operator: { kind: "jsonl" },
        version: 1,
      }), { mode: 0o600 });
      const child = Bun.spawn([
        "/bin/sh",
        "-c",
        'exec 3< "$1"; exec "$2" "$3" --scenario-fd 3',
        "hra-live-acceptance",
        configurationPath,
        process.execPath,
        join(import.meta.dir, "live-acceptance.ts"),
      ], {
        cwd: join(import.meta.dir, ".."),
        stdin: "ignore",
        stderr: "pipe",
        stdout: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode).toBe(1);
      expect(stdout).toBe(`${JSON.stringify({
        ok: false,
        status: "startup_failed",
        version: 1,
      })}\n`);
      expect(stderr).toContain("startup failed safely");
    } finally {
      await rm(directory, { force: false, recursive: true });
    }
  });
});
