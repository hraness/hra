import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { PublicInteraction } from "../src/domain/interactions";
import type { SessionEvent } from "../src/domain/session-events";
import { DEFAULT_CLOUD_DEPLOYMENT_URL } from "../src/cloud/identity-custody";
import type {
  LiveAcceptanceCliResult,
  LiveAcceptanceDevice,
  LiveAcceptanceDeviceName,
} from "./live-acceptance";
import {
  liveAcceptanceScenarioConfigurationSchema,
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
          options: [{ description: "Continue the test", label: "Continue" }],
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

const eventPage = (
  sessionId: string,
  complete: boolean,
  marker: string,
  requestedCursor: string | null,
  sequenceGap = false,
): unknown => {
  const interactionId = sessionId === sessionA ? userInteractionId : permissionInteractionId;
  const interactionKind = sessionId === sessionA ? "user_input" : "permission_approval";
  const events = (complete
    ? [
      event(sessionId, 5, {
        interactionId,
        revision: 2,
        state: "response_prepared",
        type: "interaction_state",
      }),
      event(sessionId, 6, {
        interactionId,
        revision: 3,
        state: "response_written",
        type: "interaction_state",
      }),
      event(sessionId, 7, {
        itemId: "tool-1",
        outputBytesObserved: 23,
        status: "running",
        toolKind: "command",
        turnId: "turn-1",
        type: "tool_progress",
      }),
      event(sessionId, 8, {
        itemId: "tool-1",
        itemKind: "commandExecution",
        status: "completed",
        turnId: "turn-1",
        type: "item_completed",
      }),
      event(sessionId, 9, {
        itemId: "assistant-1",
        text: marker,
        turnId: "turn-1",
        type: "assistant_delta",
      }),
      event(sessionId, 10, {
        status: "completed",
        turnId: "turn-1",
        type: "turn_completed",
      }),
    ]
    : [
      event(sessionId, 1, { turnId: "turn-1", type: "turn_started" }),
      event(sessionId, 2, {
        blocking: true,
        interactionId,
        interactionKind,
        revision: 1,
        summary: "Acceptance interaction",
        type: "interaction_requested",
      }),
      event(sessionId, 3, {
        itemId: "reasoning-1",
        text: "safe summary",
        turnId: "turn-1",
        type: "reasoning_summary_delta",
      }),
      event(sessionId, 4, {
        itemId: "tool-1",
        itemKind: "commandExecution",
        turnId: "turn-1",
        type: "item_started",
      }),
    ]).map((entry) => sequenceGap && entry.sequence >= 3
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
  approved = false;
  boundPeer: string | undefined;
  cleanupComplete = false;
  deviceBOnline = true;
  deviceBRevoked = false;
  readonly eventPolls = new Map<string, number>();
  readonly messages = new Map<string, string>();
  emptyUsage = false;
  eventSequenceGap = false;
  invalidInteractionResolution = false;
  omitAssistantEvidence = false;
  remoteCommandPolls = 0;
  remoteApplied = false;
  remoteMarker = "";
  remotePrompt = "";
  remoteProjectionPolls = 0;
  remoteProjectionWrongAuthority = false;
  remoteTurnNeverCompletes = false;
  skipRemoteClaim = false;
  unsafeDeviceCode = false;
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
      return success(command, {
        account: { id: argv[2], state: "login_pending" },
        login: {
          status: "pending",
          userCode: this.#world.unsafeDeviceCode ? "ABCD\u001b[2J" : "ABCD-EFGH",
          verificationUrl: "https://example.test/device",
        },
      });
    }
    if (command === "account.show") {
      const primary = argv[2] === accountA;
      return success(command, {
        account: {
          id: argv[2],
          providerEmail: primary ? "primary@example.test" : "secondary@example.test",
          providerPlan: "plus",
          state: this.#world.accountLoginPending ? "login_pending" : "signed_in",
        },
      });
    }
    if (command === "account.usage") {
      if (this.#world.emptyUsage) return success(command, { usage: [] });
      const accountId = argv[2]!;
      return success(command, {
        usage: [{
          account: { id: accountId },
          poll: { observedAt: 10_000, sourceRevision: 1, state: "observed" },
          snapshot: { observedAt: 10_000, sourceRevision: 1 },
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
      return success(command, {
        interactions: [{
          ...found,
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
      const kind = command === "interaction.answer" ? "user_input" : "permission_approval";
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
      return success(command, eventPage(
        sessionId,
        polls > 1,
        this.#world.omitAssistantEvidence ? "" : marker,
        requestedCursor,
        this.#world.eventSequenceGap,
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

  async acknowledgeDeviceLogin(input: unknown, signal: AbortSignal): Promise<void> {
    void input;
    void signal;
    this.deviceLogins += 1;
  }

  progress(): void {}

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
  const promise = runLiveAcceptanceScenario({
    bindExpectedRevokedPeer: async (publicId) => { world.boundPeer = publicId; },
    cleanup: async () => {
      if (world.boundPeer !== deviceBId || !world.deviceBRevoked) {
        throw new Error("Cleanup was not bound to the exact revoked peer.");
      }
      world.cleanupComplete = true;
    },
    device: (name) => devices[name],
    runId: "50000000-0000-4000-8000-000000000001",
  }, operator, attestation, {
    accountLoginDeadlineMs: 1_000,
    now: () => clock,
    pollIntervalMs: 1,
    presenceObservationMarginMs: 0,
    remoteCommandDeadlineMs: options.remoteCommandDeadlineMs ?? 1_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    sleep: options.sleep ?? (async (milliseconds) => { clock += milliseconds; }),
    turnDeadlineMs: 1_000,
  });
  return { devices, promise };
};

describe("live acceptance release scenario", () => {
  test("executes the complete two-device CLI scenario and emits only bounded evidence", async () => {
    const world = new FakeWorld();
    const devices = {
      a: new FakeDevice("a", world),
      b: new FakeDevice("b", world),
    };
    const operator = new FakeOperator();
    let clock = 1_000;
    const evidence = await runLiveAcceptanceScenario({
      bindExpectedRevokedPeer: async (publicId) => { world.boundPeer = publicId; },
      cleanup: async () => {
        if (world.boundPeer !== deviceBId || !world.deviceBRevoked) {
          throw new Error("Cleanup was not bound to the exact revoked peer.");
        }
        world.cleanupComplete = true;
      },
      device: (name) => devices[name],
      runId: "50000000-0000-4000-8000-000000000001",
    }, operator, attestation, {
      accountLoginDeadlineMs: 1_000,
      now: () => clock,
      pollIntervalMs: 1,
      presenceObservationMarginMs: 0,
      remoteCommandDeadlineMs: 1_000,
      sleep: async (milliseconds) => { clock += milliseconds; },
      turnDeadlineMs: 1_000,
    });

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
      argv.includes("--input-fd") && argv.includes("4"))).toBe(true);
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

  test("JSONL operator abort closes the inherited input read and lets the process exit", async () => {
    const moduleUrl = pathToFileURL(join(import.meta.dir, "live-acceptance-scenario.ts")).href;
    const child = spawn(process.execPath, [
      "-e",
      [
        `import { JsonlLiveAcceptanceOperator } from ${JSON.stringify(moduleUrl)};`,
        "const operator = new JsonlLiveAcceptanceOperator();",
        "const controller = new AbortController();",
        "setTimeout(() => controller.abort(), 100);",
        "try {",
        "  await operator.protectedDocument({ kind: 'device_a_auth_invite', prompt: 'probe' }, controller.signal);",
        "  process.exitCode = 2;",
        "} catch {}",
      ].join("\n"),
    ], {
      cwd: join(import.meta.dir, ".."),
      stdio: ["ignore", "ignore", "ignore", "ignore", "pipe", "pipe"],
    });
    const result = await new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }> | null>(
      (resolvePromise) => {
        const timeout = setTimeout(() => resolvePromise(null), 3_000);
        child.once("exit", (code, signal) => {
          clearTimeout(timeout);
          resolvePromise({ code, signal });
        });
      },
    );
    if (result === null) {
      child.kill("SIGKILL");
      await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
    }
    expect(result).toEqual({ code: 0, signal: null });
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

  test("the executable refuses to start workers without an explicit scenario descriptor", async () => {
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
    expect(stderr).toContain("explicit candidate configuration");
  });
});
