import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  pinnedCodexRequests,
  projectCodexTurnResponseFacts,
  type PinnedCodexRequestInput,
  type PinnedCodexRequestKey,
  type PinnedCodexRequestOutput,
  type PinnedCodexResponseAtPosition,
  type PinnedCodexThread,
  type PinnedCodexTurn,
} from "../src/codex";
import type { GatewaySessionEvent } from "../src/internal-contracts";
import {
  SessionService,
  type SessionAccountRuntimePort,
} from "../src/sessions/session-service";

interface CapturedRequest<Key extends PinnedCodexRequestKey = PinnedCodexRequestKey> {
  readonly accountProfileId: string;
  readonly expectedGeneration: number | undefined;
  readonly input: PinnedCodexRequestInput<Key>;
  readonly key: Key;
}

interface PositionedFixture {
  readonly generation: number;
  readonly output: unknown;
  readonly streamPosition: number;
}

function positionedAccountPort(
  requests: CapturedRequest[],
  respond: (request: CapturedRequest) => PositionedFixture,
): SessionAccountRuntimePort {
  return {
    ensureArchiveRecoveryRuntime: () =>
      Promise.reject(new Error("Unexpected archive recovery runtime request")),
    ensureSessionRuntime: () => Promise.resolve({ generation: 1 }),
    requestArchiveRecoveryWithResponsePosition: () =>
      Promise.reject(new Error("Unexpected archive recovery provider request")),
    requestSession() {
      return Promise.reject(new Error("Only positioned session requests are allowed."));
    },
    requestSessionWithResponsePosition<Key extends PinnedCodexRequestKey>(
      accountProfileId: string,
      key: Key,
      input: PinnedCodexRequestInput<Key>,
      expectedGeneration?: number,
    ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<Key>>> {
      const request: CapturedRequest<Key> = {
        accountProfileId,
        expectedGeneration,
        input,
        key,
      };
      requests.push(request);
      const fixture = key === "configRequirementsRead"
        ? {
            generation: expectedGeneration ?? 1,
            output: { requirements: null },
            streamPosition: 1,
          }
        : respond(request);
      const output = (key === "threadStart" || key === "threadResume") &&
          typeof fixture.output === "object" && fixture.output !== null
        ? {
            model: "gpt-5.6-sol",
            reasoningEffort: "ultra",
            serviceTier: null,
            approvalPolicy: "never",
            approvalsReviewer: "auto_review",
            sandbox: { type: "dangerFullAccess" },
            ...(fixture.output as Record<string, unknown>),
          }
        : fixture.output;
      return Promise.resolve({
        generation: fixture.generation,
        output: output as PinnedCodexRequestOutput<Key>,
        streamPosition: fixture.streamPosition,
      });
    },
  };
}

function actorThread(
  cwd: string,
  threadSource: string,
  overrides: Partial<PinnedCodexThread> = {},
): PinnedCodexThread {
  return {
    id: "provider-actor-thread-0001",
    ephemeral: false,
    historyMode: "paginated",
    preview: "",
    createdAt: 1_786_000_000,
    updatedAt: 1_786_000_000,
    status: { type: "idle" },
    cwd,
    threadSource,
    name: null,
    turns: [],
    ...overrides,
  };
}

function actorTurn(
  id = "provider-actor-turn-0001",
  status: PinnedCodexTurn["status"] = "inProgress",
): PinnedCodexTurn {
  return {
    id,
    items: [],
    itemsView: "full",
    status,
    startedAt: 1_786_000_001,
    completedAt: status === "inProgress" ? null : 1_786_000_002,
  };
}

function parsedHistoryItems(items: readonly unknown[]) {
  return pinnedCodexRequests.threadItemsList.outputCodec.parse({
    data: items,
    nextCursor: null,
    backwardsCursor: null,
  }).data;
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject.");
}

test("harness actor mutations install exact private routing and positioned identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oprte-harness-session-"));
  const workspacePath = await realpath(directory);
  const accountProfileId = "acct_harness_primary";
  const threadSource = "oprte:actor:hactor_000000001:incarnation_0001";
  const developerInstructions = "Operate as the bounded persistent OPRTE child actor.";
  const requests: CapturedRequest[] = [];
  const events: GatewaySessionEvent[] = [];
  const rawThread = actorThread(workspacePath, threadSource);
  const rawTurn = actorTurn();
  const service = new SessionService({
    accounts: positionedAccountPort(requests, ({ key }) => {
      if (key === "threadStart") {
        return { generation: 7, output: { thread: rawThread }, streamPosition: 41 };
      }
      if (key === "turnStart") {
        return { generation: 7, output: { turn: rawTurn }, streamPosition: 42 };
      }
      throw new Error(`Unexpected request: ${key}`);
    }),
    emit: (event) => events.push(event),
    now: () => new Date("2026-08-06T12:00:00.000Z"),
  });

  try {
    service.handleRuntimeState(accountProfileId, { type: "starting", generation: 7 });
    const started = await service.startHarnessActorThread({
      accountProfileId,
      actorId: "hactor_000000001",
      developerInstructions,
      expectedGeneration: 7,
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      threadSource,
      title: "Research child",
      workspaceMode: "managed",
      workspacePath,
    });
    expect(started.threadId).toMatch(/^thread_/u);
    expect(started.projectId).toMatch(/^proj_/u);
    expect(started.workspaceLaneId).toMatch(/^lane_/u);
    expect(started).toEqual({
      generation: 7,
      observedProfile: {
        modelId: "gpt-5.6-sol",
        reasoningEffort: "ultra",
      },
      threadId: started.threadId,
      providerThreadId: rawThread.id,
      projectId: started.projectId,
      streamPosition: 41,
      workspaceLaneId: started.workspaceLaneId,
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual({
      accountProfileId,
      expectedGeneration: 7,
      key: "configRequirementsRead",
      input: undefined,
    });
    expect(requests[1]).toEqual({
      accountProfileId,
      expectedGeneration: 7,
      key: "threadStart",
      input: {
        model: "gpt-5.6-sol",
        allowProviderModelFallback: false,
        serviceTier: null,
        cwd: workspacePath,
        approvalPolicy: "never",
        approvalsReviewer: "auto_review",
        sandbox: "danger-full-access",
        developerInstructions,
        ephemeral: false,
        historyMode: "paginated",
        config: {
          "agents.enabled": false,
          "features.multi_agent_v2.enabled": false,
          model_reasoning_effort: "ultra",
        },
        threadSource,
      },
    });
    expect(service.readHarnessActorChatAttachment({
      accountProfileId,
      expectedGeneration: 7,
      providerThreadId: rawThread.id,
    })).toEqual({
      threadId: started.threadId,
      restartThreadId: rawThread.id,
    });
    expect(Object.keys(service.readHarnessActorChatAttachment({
      accountProfileId,
      expectedGeneration: 7,
      providerThreadId: rawThread.id,
    }) ?? {})).toEqual(["threadId", "restartThreadId"]);
    expect(service.readHarnessActorChatAttachment({
      accountProfileId: "acct_harness_wrong",
      expectedGeneration: 7,
      providerThreadId: rawThread.id,
    })).toBeNull();

    const prompt = "Sensitive actor input recovered from encrypted custody.";
    const turn = await service.startHarnessActorTurn({
      actorId: "hactor_000000001",
      clientUserMessageId: "message_harness0001",
      expectedGeneration: 7,
      model: "gpt-5.6-sol",
      prompt,
      reasoningEffort: "ultra",
      serviceTier: "standard",
      thread: {
        kind: "provider",
        accountProfileId,
        providerThreadId: rawThread.id,
      },
    });
    expect(turn.turnId).toMatch(/^turn_/u);
    expect(turn).toEqual({
      generation: 7,
      providerTurnId: rawTurn.id,
      quotaProof: null,
      status: "inProgress",
      streamPosition: 42,
      threadId: started.threadId,
      turnId: turn.turnId,
    });
    expect(service.readHarnessActorChatTurnAttachment({
      accountProfileId,
      expectedGeneration: 7,
      providerThreadId: rawThread.id,
      providerTurnId: rawTurn.id,
    })).toEqual({
      threadId: started.threadId,
      turnId: turn.turnId,
    });
    expect(Object.keys(service.readHarnessActorChatTurnAttachment({
      accountProfileId,
      expectedGeneration: 7,
      providerThreadId: rawThread.id,
      providerTurnId: rawTurn.id,
    }) ?? {})).toEqual(["threadId", "turnId"]);
    expect(service.readHarnessActorChatEventAttachment({
      accountProfileId,
      expectedGeneration: 7,
      providerThreadId: rawThread.id,
      threadId: started.threadId,
      turnId: turn.turnId,
    })).toEqual({
      threadId: started.threadId,
      turnId: turn.turnId,
    });
    expect(Object.keys(service.readHarnessActorChatEventAttachment({
      accountProfileId,
      expectedGeneration: 7,
      providerThreadId: rawThread.id,
      threadId: started.threadId,
      turnId: turn.turnId,
    }) ?? {})).toEqual(["threadId", "turnId"]);
    expect(service.readHarnessActorChatEventRoute({
      accountProfileId,
      threadId: started.threadId,
      turnId: turn.turnId,
    })).toEqual({
      actorId: "hactor_000000001",
      admissionGeneration: 7,
      generation: 7,
      providerThreadId: rawThread.id,
      threadId: started.threadId,
      turnId: turn.turnId,
    });
    expect(Object.keys(service.readHarnessActorChatEventRoute({
      accountProfileId,
      threadId: started.threadId,
      turnId: turn.turnId,
    }) ?? {})).toEqual([
      "actorId",
      "admissionGeneration",
      "generation",
      "providerThreadId",
      "threadId",
      "turnId",
    ]);
    expect(service.readHarnessActorChatEventRoute({
      accountProfileId: "acct_harness_wrong",
      threadId: started.threadId,
      turnId: turn.turnId,
    })).toBeNull();
    for (const mismatch of [{
      accountProfileId: "acct_harness_wrong",
      expectedGeneration: 7,
      providerThreadId: rawThread.id,
      providerTurnId: rawTurn.id,
    }, {
      accountProfileId,
      expectedGeneration: 8,
      providerThreadId: rawThread.id,
      providerTurnId: rawTurn.id,
    }, {
      accountProfileId,
      expectedGeneration: 7,
      providerThreadId: "provider-actor-thread-wrong",
      providerTurnId: rawTurn.id,
    }, {
      accountProfileId,
      expectedGeneration: 7,
      providerThreadId: rawThread.id,
      providerTurnId: "provider-actor-turn-wrong",
    }]) {
      expect(service.readHarnessActorChatTurnAttachment(mismatch)).toBeNull();
    }
    for (const mismatch of [{
      accountProfileId: "acct_harness_wrong",
      expectedGeneration: 7,
      providerThreadId: rawThread.id,
      threadId: started.threadId,
      turnId: turn.turnId,
    }, {
      accountProfileId,
      expectedGeneration: 8,
      providerThreadId: rawThread.id,
      threadId: started.threadId,
      turnId: turn.turnId,
    }, {
      accountProfileId,
      expectedGeneration: 7,
      providerThreadId: "provider-actor-thread-wrong",
      threadId: started.threadId,
      turnId: turn.turnId,
    }, {
      accountProfileId,
      expectedGeneration: 7,
      providerThreadId: rawThread.id,
      threadId: "thread_owned_wrong",
      turnId: turn.turnId,
    }, {
      accountProfileId,
      expectedGeneration: 7,
      providerThreadId: rawThread.id,
      threadId: started.threadId,
      turnId: "turn_owned_wrong",
    }]) {
      expect(service.readHarnessActorChatEventAttachment(mismatch)).toBeNull();
    }
    expect(requests).toHaveLength(4);
    expect(requests[2]).toEqual({
      accountProfileId,
      expectedGeneration: 7,
      key: "configRequirementsRead",
      input: undefined,
    });
    expect(requests[3]).toEqual({
      accountProfileId,
      expectedGeneration: 7,
      key: "turnStart",
      input: {
        threadId: rawThread.id,
        clientUserMessageId: "message_harness0001",
        input: [{ type: "text", text: prompt, text_elements: [] }],
        cwd: workspacePath,
        approvalPolicy: "never",
        approvalsReviewer: "auto_review",
        sandboxPolicy: { type: "dangerFullAccess" },
        model: "gpt-5.6-sol",
        effort: "ultra",
        serviceTier: null,
      },
    });
    expect(requests.map(({ key }) => key)).toEqual([
      "configRequirementsRead",
      "threadStart",
      "configRequirementsRead",
      "turnStart",
    ]);
    expect(service.resolveHarnessCaller(
      accountProfileId,
      7,
      rawThread.id,
      rawTurn.id,
    )).toMatchObject({
      generation: 7,
      threadId: started.threadId,
      turnId: turn.turnId,
      workspaceMode: "managed",
      workspacePath,
    });
    expect(JSON.stringify(events)).not.toContain(prompt);
    expect(JSON.stringify(events)).not.toContain(rawThread.id);
    expect(JSON.stringify(events)).not.toContain(rawTurn.id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("one actor thread emits raw Fast then Standard service tiers without rebinding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hra-harness-tier-sequence-"));
  const workspacePath = await realpath(directory);
  const accountProfileId = "acct_harness_tier_sequence";
  const actorId = "hactor_tiersequence01";
  const generation = 11;
  const threadSource = "hra:actor:tier-sequence:incarnation-01";
  const requests: CapturedRequest[] = [];
  const rawThread = actorThread(workspacePath, threadSource, {
    id: "provider-actor-thread-tier-sequence",
  });
  const providerTurnIds = [
    "provider-actor-turn-tier-fast",
    "provider-actor-turn-tier-standard",
  ] as const;
  let nextTurn = 0;
  let streamPosition = 70;
  const service = new SessionService({
    accounts: positionedAccountPort(requests, ({ key }) => {
      streamPosition += 1;
      if (key === "threadStart") {
        return {
          generation,
          output: {
            thread: rawThread,
            model: "gpt-5.6-sol",
            reasoningEffort: "max",
            serviceTier: null,
          },
          streamPosition,
        };
      }
      if (key === "turnStart") {
        const providerTurnId = providerTurnIds[nextTurn];
        nextTurn += 1;
        if (providerTurnId === undefined) {
          throw new Error("unexpected third tier-sequence turn");
        }
        return {
          generation,
          output: { turn: actorTurn(providerTurnId) },
          streamPosition,
        };
      }
      throw new Error(`Unexpected request: ${key}`);
    }),
    emit: () => undefined,
  });

  try {
    service.handleRuntimeState(accountProfileId, {
      type: "starting",
      generation,
    });
    const started = await service.startHarnessActorThread({
      accountProfileId,
      actorId,
      developerInstructions: "Remain inside the exact persistent actor boundary.",
      expectedGeneration: generation,
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      threadSource,
      title: "Tier sequence actor",
      workspaceMode: "managed",
      workspacePath,
    });
    const providerThread = {
      kind: "provider" as const,
      accountProfileId,
      providerThreadId: rawThread.id,
    };
    const fast = await service.startHarnessActorTurn({
      actorId,
      clientUserMessageId: "message_tier_sequence_fast",
      expectedGeneration: generation,
      model: "gpt-5.6-sol",
      prompt: "Resolve the critical-path reasoning task.",
      reasoningEffort: "max",
      serviceTier: "fast",
      thread: providerThread,
    });
    expect(service.readHarnessActorChatEventRoute({
      accountProfileId,
      threadId: fast.threadId,
      turnId: fast.turnId,
    })).toMatchObject({
      actorId,
      generation,
      providerThreadId: rawThread.id,
      threadId: started.threadId,
    });
    streamPosition += 1;
    expect(service.consumeCodexFacts(projectCodexTurnResponseFacts({
      accountProfileId,
      generation,
      origin: "reconciled",
      streamPosition,
    }, rawThread.id, actorTurn(providerTurnIds[0], "completed"))))
      .toBeTrue();
    const standard = await service.startHarnessActorTurn({
      actorId,
      clientUserMessageId: "message_tier_sequence_standard",
      expectedGeneration: generation,
      model: "gpt-5.6-sol",
      prompt: "Continue with the ordinary follow-up.",
      reasoningEffort: "max",
      serviceTier: "standard",
      thread: providerThread,
    });

    expect([fast.threadId, standard.threadId]).toEqual([
      started.threadId,
      started.threadId,
    ]);
    const rawTurns = requests.filter((request) => request.key === "turnStart");
    expect(rawTurns.map(({ input }) =>
      (input as PinnedCodexRequestInput<"turnStart">).serviceTier
    )).toEqual(["fast", null]);
    expect(rawTurns.map(({ accountProfileId: id }) => id)).toEqual([
      accountProfileId,
      accountProfileId,
    ]);
    expect(rawTurns.map(({ input }) =>
      (input as PinnedCodexRequestInput<"turnStart">).threadId
    )).toEqual([rawThread.id, rawThread.id]);
    expect(service.readHarnessActorChatEventRoute({
      accountProfileId,
      threadId: standard.threadId,
      turnId: standard.turnId,
    })).toMatchObject({
      actorId,
      generation,
      providerThreadId: rawThread.id,
      threadId: started.threadId,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reverse routes one exact event with 114 registered actor threads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oprte-harness-reverse-route-"));
  const workspacePath = await realpath(directory);
  const accountProfileId = "acct_harness_reverse_route";
  const generation = 11;
  const actorCount = 114;
  const actors = Array.from({ length: actorCount }, (_, index) => {
    const suffix = String(index).padStart(3, "0");
    const actorId = `hactor_reverse_route_${suffix}`;
    const threadSource = `oprte:actor:${actorId}:incarnation_0001`;
    return Object.freeze({
      actorId,
      providerThreadId: `provider-reverse-route-thread-${suffix}`,
      threadSource,
    });
  });
  const requests: CapturedRequest[] = [];
  let nextThread = 0;
  let streamPosition = 100;
  const rawTurn = actorTurn("provider-reverse-route-turn", "inProgress");
  const service = new SessionService({
    accounts: positionedAccountPort(requests, ({ key }) => {
      streamPosition += 1;
      if (key === "threadStart") {
        const actor = actors[nextThread];
        nextThread += 1;
        if (actor === undefined) throw new Error("unexpected reverse-route thread start");
        return {
          generation,
          output: {
            thread: actorThread(workspacePath, actor.threadSource, {
              id: actor.providerThreadId,
            }),
          },
          streamPosition,
        };
      }
      if (key === "turnStart") {
        return { generation, output: { turn: rawTurn }, streamPosition };
      }
      throw new Error(`Unexpected request: ${key}`);
    }),
    emit: () => undefined,
  });

  try {
    service.handleRuntimeState(accountProfileId, { type: "starting", generation });
    const started: Array<Awaited<
      ReturnType<SessionService["startHarnessActorThread"]>
    >> = [];
    for (const actor of actors) {
      started.push(await service.startHarnessActorThread({
        accountProfileId,
        actorId: actor.actorId,
        developerInstructions: "Remain inside the exact reverse-route fixture.",
        expectedGeneration: generation,
        model: "gpt-5.6-sol",
        reasoningEffort: "ultra",
        threadSource: actor.threadSource,
        title: actor.actorId,
        workspaceMode: "readOnly",
        workspacePath,
      }));
    }
    const target = actors.at(-1)!;
    const targetThread = started.at(-1)!;
    const turn = await service.startHarnessActorTurn({
      actorId: target.actorId,
      clientUserMessageId: "message_reverse_route_001",
      expectedGeneration: generation,
      model: "gpt-5.6-sol",
      prompt: "Route only this actor event.",
      reasoningEffort: "ultra",
      serviceTier: "standard",
      thread: {
        kind: "provider",
        accountProfileId,
        providerThreadId: target.providerThreadId,
      },
    });
    const providerRequestsBeforeRoute = requests.length;

    expect(service.readHarnessActorChatEventRoute({
      accountProfileId,
      threadId: targetThread.threadId,
      turnId: turn.turnId,
    })).toEqual({
      actorId: target.actorId,
      admissionGeneration: generation,
      generation,
      providerThreadId: target.providerThreadId,
      threadId: targetThread.threadId,
      turnId: turn.turnId,
    });
    expect(service.readHarnessActorChatEventRoute({
      accountProfileId,
      threadId: started[0]!.threadId,
      turnId: turn.turnId,
    })).toBeNull();
    expect(requests).toHaveLength(providerRequestsBeforeRoute);
    expect(nextThread).toBe(actorCount);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("harness actor thread registration rejects every observable response drift", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oprte-harness-response-drift-"));
  const workspacePath = await realpath(directory);
  const expectedSource = "oprte:actor:hactor_000000004:incarnation_0001";
  const cases: readonly Readonly<{
    label: string;
    generation?: number;
    overrides?: Partial<PinnedCodexThread>;
    profile?: Readonly<{
      model?: string;
      reasoningEffort?: string | null;
      serviceTier?: string | null;
    }>;
  }>[] = [
    { label: "generation", generation: 10 },
    { label: "model", profile: { model: "gpt-5.6-luna" } },
    { label: "effort", profile: { reasoningEffort: "max" } },
    { label: "tier", profile: { serviceTier: "fast" } },
    { label: "cwd", overrides: { cwd: "/private/tmp/other-harness-workspace" } },
    { label: "ephemeral", overrides: { ephemeral: true } },
    { label: "history", overrides: { historyMode: "legacy" } },
    { label: "source", overrides: { threadSource: "oprte:actor:other" } },
    {
      label: "not-fresh",
      overrides: { turns: [actorTurn("provider-preexisting-turn", "completed")] },
    },
    { label: "name", overrides: { name: "A different actor" } },
  ];

  try {
    for (const [index, fixture] of cases.entries()) {
      const requests: CapturedRequest[] = [];
      const events: GatewaySessionEvent[] = [];
      const accountProfileId = `acct_harness_drift_${fixture.label}`;
      const responseThread = actorThread(workspacePath, expectedSource, {
        id: `provider-actor-thread-drift-${String(index)}`,
        ...fixture.overrides,
      });
      const service = new SessionService({
        accounts: positionedAccountPort(requests, () => ({
          generation: fixture.generation ?? 9,
          output: { thread: responseThread, ...fixture.profile },
          streamPosition: 30 + index,
        })),
        emit: (event) => events.push(event),
      });
      service.handleRuntimeState(accountProfileId, { type: "starting", generation: 9 });
      const start = service.startHarnessActorThread({
        accountProfileId,
        actorId: "hactor_000000001",
        developerInstructions: "Use the exact persistent actor contract.",
        expectedGeneration: 9,
        model: "gpt-5.6-sol",
        reasoningEffort: "ultra",
        threadSource: expectedSource,
        title: "Exact child",
        workspaceMode: "managed",
        workspacePath,
      });
      expect(await captureRejection(start)).toMatchObject({ code: "protocol_error" });
      expect(requests.map(({ key }) => key)).toEqual([
        "configRequirementsRead",
        "threadStart",
      ]);
      expect(events.some(({ type }) => type === "thread.upserted")).toBeFalse();
      expect(service.readHarnessActorChatAttachment({
        accountProfileId,
        expectedGeneration: 9,
        providerThreadId: responseThread.id,
      })).toBeNull();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("harness actor turn response generation drift never becomes routable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oprte-harness-turn-drift-"));
  const workspacePath = await realpath(directory);
  const accountProfileId = "acct_harness_turn_drift";
  const threadSource = "oprte:actor:hactor_000000005:incarnation_0001";
  const requests: CapturedRequest[] = [];
  const events: GatewaySessionEvent[] = [];
  const rawThread = actorThread(workspacePath, threadSource, {
    id: "provider-actor-thread-0005",
  });
  const rawTurn = actorTurn("provider-actor-turn-0005");
  const service = new SessionService({
    accounts: positionedAccountPort(requests, ({ key }) => key === "threadStart"
      ? { generation: 4, output: { thread: rawThread }, streamPosition: 50 }
      : { generation: 5, output: { turn: rawTurn }, streamPosition: 51 }),
    emit: (event) => events.push(event),
  });

  try {
    service.handleRuntimeState(accountProfileId, { type: "starting", generation: 4 });
    const started = await service.startHarnessActorThread({
      accountProfileId,
      actorId: "hactor_000000001",
      developerInstructions: "Use the exact persistent actor contract.",
      expectedGeneration: 4,
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      threadSource,
      title: "Turn fenced child",
      workspaceMode: "managed",
      workspacePath,
    });
    const prompt = "This response must not install.";
    const turnStart = service.startHarnessActorTurn({
      actorId: "hactor_000000001",
      clientUserMessageId: "message_harness0005",
      expectedGeneration: 4,
      model: "gpt-5.6-sol",
      prompt,
      reasoningEffort: "ultra",
      serviceTier: "standard",
      thread: { kind: "gateway", threadId: started.threadId },
    });
    expect(await captureRejection(turnStart)).toMatchObject({
      code: "protocol_error",
      action: "restartRuntime",
    });
    expect(requests.map(({ key }) => key)).toEqual([
      "configRequirementsRead",
      "threadStart",
      "configRequirementsRead",
      "turnStart",
    ]);
    expect(service.resolveHarnessCaller(
      accountProfileId,
      4,
      rawThread.id,
      rawTurn.id,
    )).toBeNull();
    expect(JSON.stringify(events)).not.toContain(prompt);
    expect(JSON.stringify(events)).not.toContain(rawTurn.id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("read-only workspace identity never weakens the immutable execution policy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oprte-harness-read-only-"));
  const workspacePath = await realpath(directory);
  const accountProfileId = "acct_harness_readonly";
  const requests: CapturedRequest[] = [];
  const threadSource = "oprte:actor:hactor_000000002:incarnation_0001";
  const rawThread = actorThread(workspacePath, threadSource, {
    id: "provider-actor-thread-0002",
  });
  const service = new SessionService({
    accounts: positionedAccountPort(requests, ({ key }) => key === "threadStart"
      ? { generation: 3, output: { thread: rawThread }, streamPosition: 10 }
      : { generation: 3, output: { turn: actorTurn("provider-actor-turn-0002") }, streamPosition: 11 }),
    emit: () => undefined,
  });

  try {
    service.handleRuntimeState(accountProfileId, { type: "starting", generation: 3 });
    const started = await service.startHarnessActorThread({
      accountProfileId,
      actorId: "hactor_000000001",
      developerInstructions: "Read and synthesize without changing the checkout.",
      expectedGeneration: 3,
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      threadSource,
      title: "Read-only child",
      workspaceMode: "readOnly",
      workspacePath,
    });
    await service.startHarnessActorTurn({
      actorId: "hactor_000000001",
      clientUserMessageId: "message_harness0002",
      expectedGeneration: 3,
      model: "gpt-5.6-sol",
      prompt: "Inspect the selected evidence.",
      reasoningEffort: "ultra",
      serviceTier: "standard",
      thread: { kind: "gateway", threadId: started.threadId },
    });
    expect(requests[1]?.input).toMatchObject({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    expect(requests[3]?.input).toMatchObject({
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      effort: "ultra",
      approvalsReviewer: "auto_review",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("harness actor bindings fail closed on response drift and generation changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oprte-harness-fence-"));
  const workspacePath = await realpath(directory);
  const accountProfileId = "acct_harness_fenced";
  const threadSource = "oprte:actor:hactor_000000003:incarnation_0001";
  const driftRequests: CapturedRequest[] = [];
  const driftEvents: GatewaySessionEvent[] = [];
  const drifted = new SessionService({
    accounts: positionedAccountPort(driftRequests, () => ({
      generation: 5,
      output: { thread: actorThread(workspacePath, "oprte:actor:wrong-source") },
      streamPosition: 20,
    })),
    emit: (event) => driftEvents.push(event),
  });

  try {
    drifted.handleRuntimeState(accountProfileId, { type: "starting", generation: 5 });
    const driftedStart = drifted.startHarnessActorThread({
      accountProfileId,
      actorId: "hactor_000000001",
      developerInstructions: "Stay inside the fixed child actor contract.",
      expectedGeneration: 5,
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      threadSource,
      title: "Fenced child",
      workspaceMode: "managed",
      workspacePath,
    });
    expect(await captureRejection(driftedStart)).toMatchObject({
      code: "protocol_error",
      action: "restartRuntime",
    });
    expect(driftRequests.map(({ key }) => key)).toEqual([
      "configRequirementsRead",
      "threadStart",
    ]);
    expect(driftEvents.some(({ type }) => type === "thread.upserted")).toBeFalse();
    expect(drifted.readHarnessActorChatAttachment({
      accountProfileId,
      expectedGeneration: 5,
      providerThreadId: "provider-actor-thread-0001",
    })).toBeNull();

    const requests: CapturedRequest[] = [];
    const rawThread = actorThread(workspacePath, threadSource, {
      id: "provider-actor-thread-0003",
    });
    const service = new SessionService({
      accounts: positionedAccountPort(requests, () => ({
        generation: 5,
        output: { thread: rawThread },
        streamPosition: 21,
      })),
      emit: () => undefined,
    });
    service.handleRuntimeState(accountProfileId, { type: "starting", generation: 5 });
    const started = await service.startHarnessActorThread({
      accountProfileId,
      actorId: "hactor_000000001",
      developerInstructions: "Stay inside the fixed child actor contract.",
      expectedGeneration: 5,
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      threadSource,
      title: "Fenced child",
      workspaceMode: "managed",
      workspacePath,
    });
    service.handleRuntimeState(accountProfileId, { type: "starting", generation: 6 });
    expect(service.readHarnessActorChatAttachment({
      accountProfileId,
      expectedGeneration: 5,
      providerThreadId: rawThread.id,
    })).toBeNull();
    expect(service.readHarnessActorChatAttachment({
      accountProfileId,
      expectedGeneration: 6,
      providerThreadId: rawThread.id,
    })).toBeNull();
    const staleTurn = service.startHarnessActorTurn({
      actorId: "hactor_000000001",
      clientUserMessageId: "message_harness0003",
      expectedGeneration: 6,
      model: "gpt-5.6-sol",
      prompt: "Do not dispatch this stale turn.",
      reasoningEffort: "ultra",
      serviceTier: "standard",
      thread: { kind: "gateway", threadId: started.threadId },
    });
    expect(await captureRejection(staleTurn)).toMatchObject({ code: "conflict" });
    expect(requests).toHaveLength(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("harness actor recovery resumes N to N+1 with a chained fixed-page proof", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oprte-harness-resume-"));
  const workspacePath = await realpath(directory);
  const accountProfileId = "acct_harness_resume";
  const actorId = "hactor_resume00001";
  const threadSource = "oprte:actor:hactor_resume00001:incarnation_0001";
  const rawThread = actorThread(workspacePath, threadSource, {
    id: "provider-actor-thread-resume-0001",
  });
  const requests: CapturedRequest[] = [];
  let generation = 8;
  let streamPosition = 9;
  let responseProfile: Readonly<{
    model: string;
    reasoningEffort: string | null;
    serviceTier: string | null;
  }> = {
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    serviceTier: null,
  };
  const service = new SessionService({
    accounts: positionedAccountPort(requests, ({ key }) => {
      streamPosition += 1;
      if (key === "threadStart" || key === "threadResume") {
        return {
          generation,
          output: { thread: rawThread, ...responseProfile },
          streamPosition,
        };
      }
      if (key === "threadTurnsList") {
        return {
          generation,
          output: { data: [], nextCursor: null, backwardsCursor: null },
          streamPosition,
        };
      }
      throw new Error(`Unexpected request: ${key}`);
    }),
    emit: () => undefined,
    now: () => new Date("2026-08-06T12:00:00.000Z"),
  });

  try {
    service.handleRuntimeState(accountProfileId, { type: "starting", generation });
    const started = await service.startHarnessActorThread({
      accountProfileId,
      actorId,
      developerInstructions: "Remain inside the durable actor boundary.",
      expectedGeneration: generation,
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      threadSource,
      title: "Recoverable actor",
      workspaceMode: "managed",
      workspacePath,
    });
    const initialProof = await service.observeHarnessActorSessionRecoveryProof({
      actorId,
      accountProfileId,
      admissionGeneration: 8,
      expectedGeneration: 8,
      providerThreadId: rawThread.id,
      priorRecoveryProofDigest: null,
    });
    expect(initialProof).toMatchObject({
      observationGeneration: 8,
      priorRecoveryProofDigest: null,
      historyTurnCount: 0,
      historyItemCount: 0,
    });
    expect(initialProof.recoveryProofDigest).toMatch(/^[0-9a-f]{64}$/u);
    const requestsBeforeInvalidAdoption = requests.length;
    expect(await captureRejection(service.resumeHarnessActorThread({
      accountProfileId,
      actorId,
      admissionGeneration: 8,
      expectedGeneration: 8,
      model: "gpt-5.6-sol",
      previousRecoveryProofDigest: null,
      providerThreadId: rawThread.id,
      reasoningEffort: "ultra",
      threadSource,
      title: "Recoverable actor",
      workspaceMode: "managed",
      workspacePath,
    }))).toMatchObject({ recoveryFailure: "recovery_protocol_error" });
    expect(requests).toHaveLength(requestsBeforeInvalidAdoption);

    generation = 9;
    streamPosition = 19;
    service.handleRuntimeState(accountProfileId, { type: "starting", generation });
    responseProfile = { ...responseProfile, reasoningEffort: "max" };
    expect(await captureRejection(service.resumeHarnessActorThread({
      accountProfileId,
      actorId,
      admissionGeneration: 8,
      expectedGeneration: 9,
      model: "gpt-5.6-sol",
      previousRecoveryProofDigest: initialProof.recoveryProofDigest,
      providerThreadId: rawThread.id,
      reasoningEffort: "ultra",
      threadSource,
      title: "Recoverable actor",
      workspaceMode: "managed",
      workspacePath,
    }))).toMatchObject({ recoveryFailure: "recovery_protocol_error" });
    responseProfile = { ...responseProfile, reasoningEffort: "ultra" };
    const resumed = await service.resumeHarnessActorThread({
      accountProfileId,
      actorId,
      admissionGeneration: 8,
      expectedGeneration: 9,
      model: "gpt-5.6-sol",
      previousRecoveryProofDigest: initialProof.recoveryProofDigest,
      providerThreadId: rawThread.id,
      reasoningEffort: "ultra",
      threadSource,
      title: "Recoverable actor",
      workspaceMode: "managed",
      workspacePath,
    });
    expect(resumed).toMatchObject({
      admissionGeneration: 8,
      generation: 9,
      observedProfile: {
        modelId: "gpt-5.6-sol",
        reasoningEffort: "ultra",
      },
      providerThreadId: rawThread.id,
      threadId: started.threadId,
      recoveryProof: {
        observationGeneration: 9,
        priorRecoveryProofDigest: initialProof.recoveryProofDigest,
        firstObservationPosition: 22,
        secondObservationPosition: 23,
        historyTurnCount: 0,
        historyItemCount: 0,
      },
    });
    expect(resumed.recoveryProof.recoveryProofDigest)
      .not.toBe(initialProof.recoveryProofDigest);
    expect(service.readHarnessActorChatAttachment({
      accountProfileId,
      expectedGeneration: 8,
      providerThreadId: rawThread.id,
    })).toBeNull();
    expect(service.readHarnessActorChatAttachment({
      accountProfileId,
      expectedGeneration: 9,
      providerThreadId: rawThread.id,
    })).toEqual({
      threadId: started.threadId,
      restartThreadId: rawThread.id,
    });
    expect(requests.slice(-3).map(({ key, expectedGeneration }) => ({
      key,
      expectedGeneration,
    }))).toEqual([
      { key: "threadResume", expectedGeneration: 9 },
      { key: "threadTurnsList", expectedGeneration: 9 },
      { key: "threadTurnsList", expectedGeneration: 9 },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("harness actor recovery adopts one lost initial start after a generation successor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oprte-harness-adopt-"));
  const workspacePath = await realpath(directory);
  const accountProfileId = "acct_harness_adopt";
  const actorId = "hactor_adopt000001";
  const threadSource = "oprte:actor:hactor_adopt000001:incarnation_0001";
  const rawThread = actorThread(workspacePath, threadSource, {
    id: "provider-actor-thread-adopt-0001",
  });
  const requests: CapturedRequest[] = [];
  const generation = 9;
  let streamPosition = 30;
  const service = new SessionService({
    accounts: positionedAccountPort(requests, ({ key }) => {
      streamPosition += 1;
      if (key === "threadResume") {
        return { generation, output: { thread: rawThread }, streamPosition };
      }
      if (key === "threadTurnsList") {
        return {
          generation,
          output: { data: [], nextCursor: null, backwardsCursor: null },
          streamPosition,
        };
      }
      throw new Error(`Unexpected request: ${key}`);
    }),
    emit: () => undefined,
  });
  try {
    service.handleRuntimeState(accountProfileId, { type: "starting", generation });
    const adopted = await service.resumeHarnessActorThread({
      accountProfileId,
      actorId,
      admissionGeneration: 8,
      expectedGeneration: 9,
      model: "gpt-5.6-sol",
      previousRecoveryProofDigest: null,
      providerThreadId: rawThread.id,
      reasoningEffort: "ultra",
      threadSource,
      title: "Initially adopted actor",
      workspaceMode: "managed",
      workspacePath,
    });
    expect(adopted).toMatchObject({
      admissionGeneration: 8,
      generation: 9,
      recoveryProof: {
        observationGeneration: 9,
        priorRecoveryProofDigest: null,
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("harness actor recovery rejects source tampering before registry installation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oprte-harness-resume-tamper-"));
  const workspacePath = await realpath(directory);
  const accountProfileId = "acct_harness_resume_tamper";
  const expectedSource = "oprte:actor:hactor_resume00002:incarnation_0001";
  const requests: CapturedRequest[] = [];
  const service = new SessionService({
    accounts: positionedAccountPort(requests, () => ({
      generation: 4,
      output: { thread: actorThread(workspacePath, "oprte:actor:tampered-source", {
        id: "provider-actor-thread-resume-tamper",
      }) },
      streamPosition: 1,
    })),
    emit: () => undefined,
  });
  try {
    service.handleRuntimeState(accountProfileId, { type: "starting", generation: 4 });
    const error = await captureRejection(service.resumeHarnessActorThread({
      accountProfileId,
      actorId: "hactor_resume00002",
      admissionGeneration: 3,
      expectedGeneration: 4,
      model: "gpt-5.6-sol",
      previousRecoveryProofDigest: "a".repeat(64),
      providerThreadId: "provider-actor-thread-resume-tamper",
      reasoningEffort: "ultra",
      threadSource: expectedSource,
      title: "Tamper fenced actor",
      workspaceMode: "readOnly",
      workspacePath,
    }));
    expect(error).toMatchObject({
      recoveryFailure: "thread_source_mismatch",
      retryable: false,
    });
    expect(service.readHarnessActorChatAttachment({
      accountProfileId,
      expectedGeneration: 4,
      providerThreadId: "provider-actor-thread-resume-tamper",
    })).toBeNull();
    expect(requests.map(({ key }) => key)).toEqual([
      "configRequirementsRead",
      "threadResume",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("actor quota continuation reads and injects only exact bounded text with full readback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oprte-harness-continuation-"));
  const workspacePath = await realpath(directory);
  const actorId = "hactor_continuation01";
  const sourceAccountProfileId = "acct_harness_source01";
  const targetAccountProfileId = "acct_harness_target01";
  const sourceProviderThreadId = "provider-harness-source-thread";
  const sourceProviderTurnId = "provider-harness-source-quota-turn";
  const sourceThreadSource = "oprte:actor:source:continuation";
  const targetProviderThreadId = "provider-harness-target-thread";
  const targetThreadSource = "oprte:actor:target:continuation";
  const requests: CapturedRequest[] = [];
  let streamPosition = 100;
  let injected = false;
  let mismatchedReadback = false;
  const verifiedSourceItems = parsedHistoryItems([{
    type: "userMessage" as const,
    id: "provider-source-user",
    clientId: "message_source0001",
    content: [{ type: "text", text: "Original bounded request", text_elements: [] }],
  }, {
    type: "reasoning" as const,
    id: "provider-source-reasoning",
    summary: [],
    content: [],
  }, {
    type: "agentMessage" as const,
    id: "provider-source-commentary",
    phase: "commentary" as const,
    text: "Private intermediate commentary",
    memoryCitation: null,
  }, {
    type: "agentMessage" as const,
    id: "provider-source-final",
    phase: "final_answer" as const,
    text: "Verified partial answer",
    memoryCitation: null,
  }]);
  let sourceItems = verifiedSourceItems;
  const targetReadback = () => ({
    thread: {
      id: targetProviderThreadId,
      turns: injected ? [{
        ...actorTurn("provider-injected-history-turn", "completed"),
        items: parsedHistoryItems(mismatchedReadback ? [{
          type: "userMessage",
          id: "provider-injected-user",
          clientId: null,
          content: [{ type: "text", text: "Different text", text_elements: [] }],
        }] : [{
          type: "userMessage",
          id: "provider-injected-user",
          clientId: null,
          content: [{
            type: "text",
            text: "Original bounded request",
            text_elements: [],
          }],
        }, {
          type: "agentMessage",
          id: "provider-injected-assistant",
          phase: "final_answer",
          text: "Verified partial answer",
          memoryCitation: null,
        }]),
      }] : [],
    },
  });
  const service = new SessionService({
    accounts: positionedAccountPort(requests, ({ accountProfileId, key }) => {
      streamPosition += 1;
      if (key === "threadStart") {
        const source = accountProfileId === sourceAccountProfileId;
        return {
          generation: source ? 7 : 9,
          output: {
            thread: actorThread(workspacePath, source ? sourceThreadSource : targetThreadSource, {
              id: source ? sourceProviderThreadId : targetProviderThreadId,
            }),
          },
          streamPosition,
        };
      }
      if (key === "threadTurnsList") {
        return {
          generation: 7,
          output: {
            data: [{
              ...actorTurn(sourceProviderTurnId, "failed"),
              items: [],
              itemsView: "notLoaded",
              quotaProof: "provider_usage_limit_exceeded",
            }],
            nextCursor: null,
            backwardsCursor: null,
          },
          streamPosition,
        };
      }
      if (key === "threadItemsList") {
        return {
          generation: 7,
          output: { data: sourceItems, nextCursor: null, backwardsCursor: null },
          streamPosition,
        };
      }
      if (key === "threadInjectItems") {
        injected = true;
        return { generation: 9, output: undefined, streamPosition };
      }
      if (key === "threadHistoryRead") {
        return { generation: 9, output: targetReadback(), streamPosition };
      }
      throw new Error(`Unexpected request: ${key}`);
    }),
    emit: () => undefined,
  });

  try {
    service.handleRuntimeState(sourceAccountProfileId, { type: "starting", generation: 7 });
    service.handleRuntimeState(targetAccountProfileId, { type: "starting", generation: 9 });
    await service.startHarnessActorThread({
      accountProfileId: sourceAccountProfileId,
      actorId,
      developerInstructions: "Use the exact persistent actor contract.",
      expectedGeneration: 7,
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      threadSource: sourceThreadSource,
      title: "Source actor",
      workspaceMode: "managed",
      workspacePath,
    });
    await service.startHarnessActorThread({
      accountProfileId: targetAccountProfileId,
      actorId,
      developerInstructions: "Use the exact persistent actor contract.",
      expectedGeneration: 9,
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      threadSource: targetThreadSource,
      title: "Target actor",
      workspaceMode: "managed",
      workspacePath,
    });

    const history = await service.readHarnessActorContinuationHistory({
      actorId,
      accountProfileId: sourceAccountProfileId,
      expectedGeneration: 7,
      providerThreadId: sourceProviderThreadId,
      providerTurnId: sourceProviderTurnId,
    });
    expect(history).toMatchObject({
      itemCount: 2,
      items: [
        { role: "user", text: "Original bounded request" },
        { role: "assistant", text: "Verified partial answer" },
      ],
    });
    expect(history).not.toHaveProperty("sourceGeneration");
    expect(history).not.toHaveProperty("sourceStreamPosition");
    expect(history.historyDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(history)).not.toContain("Private intermediate commentary");
    expect(JSON.stringify(history)).not.toContain("reasoning");

    sourceItems = parsedHistoryItems([{
      type: "userMessage",
      id: "provider-source-user",
      clientId: "message_source0001",
      content: [{ type: "image", url: "https://example.test/attachment.png" }],
    }, {
      type: "agentMessage",
      id: "provider-source-final",
      phase: "final_answer",
      text: "Verified partial answer",
      memoryCitation: null,
    }]);
    expect(await captureRejection(service.readHarnessActorContinuationHistory({
      actorId,
      accountProfileId: sourceAccountProfileId,
      expectedGeneration: 7,
      providerThreadId: sourceProviderThreadId,
      providerTurnId: sourceProviderTurnId,
    }))).toMatchObject({ code: "conflict" });

    sourceItems = parsedHistoryItems([{
      type: "userMessage",
      id: "provider-source-user",
      clientId: "message_source0001",
      content: [{ type: "text", text: "Original bounded request", text_elements: [] }],
    }, {
      type: "agentMessage",
      id: "provider-source-final",
      phase: null,
      text: "Ambiguous assistant response",
      memoryCitation: null,
    }]);
    expect(await captureRejection(service.readHarnessActorContinuationHistory({
      actorId,
      accountProfileId: sourceAccountProfileId,
      expectedGeneration: 7,
      providerThreadId: sourceProviderThreadId,
      providerTurnId: sourceProviderTurnId,
    }))).toMatchObject({ code: "conflict" });

    sourceItems = parsedHistoryItems([{
      type: "userMessage",
      id: "provider-source-user",
      clientId: "message_source0001",
      content: [{ type: "text", text: "Retained suffix", text_elements: [] }],
    }, {
      type: "contextCompaction",
      id: "provider-source-compaction",
    }, {
      type: "agentMessage",
      id: "provider-source-final",
      phase: "final_answer",
      text: "Suffix answer",
      memoryCitation: null,
    }]);
    expect(await captureRejection(service.readHarnessActorContinuationHistory({
      actorId,
      accountProfileId: sourceAccountProfileId,
      expectedGeneration: 7,
      providerThreadId: sourceProviderThreadId,
      providerTurnId: sourceProviderTurnId,
    }))).toMatchObject({ code: "conflict" });
    expect(requests.filter(({ key }) => key === "threadInjectItems")).toHaveLength(0);
    sourceItems = verifiedSourceItems;

    const emptyReadback = await service.verifyHarnessActorContinuationHistory({
      actorId,
      accountProfileId: targetAccountProfileId,
      expectedGeneration: 9,
      providerThreadId: targetProviderThreadId,
      history,
    });
    expect(emptyReadback.kind).toBe("empty");
    if (emptyReadback.kind !== "empty") {
      throw new Error("expected an exact empty continuation target");
    }
    expect(emptyReadback.rawEvidenceDigest).toMatch(/^[a-f0-9]{64}$/u);

    await service.injectHarnessActorContinuationHistory({
      actorId,
      accountProfileId: targetAccountProfileId,
      expectedGeneration: 9,
      providerThreadId: targetProviderThreadId,
      history,
    });
    const injection = requests.find(({ key }) => key === "threadInjectItems");
    expect(injection).toMatchObject({
      accountProfileId: targetAccountProfileId,
      expectedGeneration: 9,
      input: {
        threadId: targetProviderThreadId,
        items: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Original bounded request" }],
        }, {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Verified partial answer" }],
        }],
      },
    });
    expect(await service.verifyHarnessActorContinuationHistory({
      actorId,
      accountProfileId: targetAccountProfileId,
      expectedGeneration: 9,
      providerThreadId: targetProviderThreadId,
      history,
    })).toMatchObject({
      kind: "matched",
      historyDigest: history.historyDigest,
    });
    expect(requests.filter(({ key }) => key === "threadHistoryRead")).toHaveLength(4);
    expect(requests.filter(({ key }) => key === "threadRead")).toHaveLength(0);

    const injectionCount = requests.filter(({ key }) => key === "threadInjectItems").length;
    const overBoundItems = Array.from({ length: 1_025 }, (_, index) => ({
      role: "user" as const,
      text: `bounded-${String(index)}`,
    }));
    expect(await captureRejection(service.injectHarnessActorContinuationHistory({
      actorId,
      accountProfileId: targetAccountProfileId,
      expectedGeneration: 9,
      providerThreadId: targetProviderThreadId,
      history: {
        ...history,
        itemCount: overBoundItems.length,
        items: overBoundItems,
        totalUtf8Bytes: overBoundItems.reduce(
          (total, item) => total + Buffer.byteLength(item.text, "utf8"),
          0,
        ),
      },
    }))).toMatchObject({ code: "conflict" });
    expect(requests.filter(({ key }) => key === "threadInjectItems"))
      .toHaveLength(injectionCount);

    mismatchedReadback = true;
    expect(await service.verifyHarnessActorContinuationHistory({
      actorId,
      accountProfileId: targetAccountProfileId,
      expectedGeneration: 9,
      providerThreadId: targetProviderThreadId,
      history,
    })).toMatchObject({ kind: "mismatched" });
    expect(await captureRejection(service.readHarnessActorContinuationHistory({
      actorId: "hactor_different0001",
      accountProfileId: sourceAccountProfileId,
      expectedGeneration: 7,
      providerThreadId: sourceProviderThreadId,
      providerTurnId: sourceProviderTurnId,
    }))).toMatchObject({ code: "conflict" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
