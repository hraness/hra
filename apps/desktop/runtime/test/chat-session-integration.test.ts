import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import type {
  PinnedCodexRequestInput,
  PinnedCodexRequestOutput,
} from "../src/codex";
import { projectCodexNotificationFacts } from "../src/codex/fact-projector";
import {
  ChatService,
  CodexChatProvider,
  ChatProviderEffectError,
  type ChatWorkspacePort,
} from "../src/chat";
import { AccountServiceError } from "../src/accounts/account-service";
import {
  SessionService,
  SessionServiceError,
  type SessionAccountRuntimePort,
} from "../src/sessions/session-service";
import type { SessionCodexRequestKey } from "../src/sessions/command-executor";
import { applyMigrations } from "../src/state/database";
import { ChatPaneStore } from "../src/state/chat-pane-store";
import { RootTurnRoutingSQLiteAuthorityV1 } from "../src/harness/root-turn-routing-sqlite-v1";

const ACCOUNT = "acct_integration01";
const PANE = "pane_integration01";
const REPOSITORY = `repo_${"3".repeat(26)}`;
const LOGICAL_TURN = "chatturn_integrat01";
const PROVIDER_THREAD = "provider-chat-thread";
const PROVIDER_TURN = "provider-chat-turn";

test("Codex chat preserves pre-dispatch runtime capacity as safely not applied", async () => {
  const unavailable = new AccountServiceError(
    "runtime_unavailable",
    "fixture capacity wait expired",
    true,
    "retry",
  );
  const reject = () => Promise.reject(unavailable);
  const provider = new CodexChatProvider({
    injectChatHistory: reject,
    interruptChatTurn: reject,
    resumeChatThread: reject,
    setChatThreadName: reject,
    startChatThread: reject,
    startChatTurn: reject,
    resolveChatConfiguration: reject,
  });

  const error = await provider.startThread({
    accountProfileId: ACCOUNT,
    title: "Capacity fixture",
    workingDirectory: process.cwd(),
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    sandbox: "workspace-write",
  }).then(() => null, (reason: unknown) => reason);

  expect(error).toBeInstanceOf(ChatProviderEffectError);
  expect(error).toMatchObject({ certainty: "not_applied", code: "runtime" });
});

test("Fast mode fails closed before any provider mutation when the model omits the tier", async () => {
  const requests: string[] = [];
  let position = 0;
  const sessions = new SessionService({
    accounts: {
      requestSession: () => Promise.reject(new Error("Expected positioned session request")),
      requestSessionWithResponsePosition<Key extends SessionCodexRequestKey>(
        _accountProfileId: string,
        key: Key,
      ) {
        requests.push(String(key));
        position += 1;
        if (key !== "modelList") throw new Error(`Unexpected mutation: ${String(key)}`);
        const output: PinnedCodexRequestOutput<"modelList"> = {
          data: [{
            model: "gpt-5.6-sol",
            supportedReasoningEfforts: [{ reasoningEffort: "ultra" }],
            serviceTiers: [],
          }],
          nextCursor: null,
        };
        return Promise.resolve({
          generation: 1,
          streamPosition: position,
          output: output as PinnedCodexRequestOutput<Key>,
        });
      },
    },
    emit: () => undefined,
  });

  const failure = await sessions.resolveChatConfiguration(
    ACCOUNT,
    [{ model: "gpt-5.6-sol", reasoningEffort: "ultra", serviceTier: "fast" }],
  ).then(() => null, (reason: unknown) => reason);
  expect(failure).toBeInstanceOf(SessionServiceError);
  expect(failure).toMatchObject({ code: "capability_unavailable" });
  expect(requests).toEqual(["modelList"]);
});

test("root routing proves model absence only from one complete generation-fenced catalog", async () => {
  const expectedGenerations: Array<number | undefined> = [];
  let page = 0;
  const sessions = new SessionService({
    accounts: {
      requestSession: () => Promise.reject(new Error("Expected positioned session request")),
      requestSessionWithResponsePosition<Key extends SessionCodexRequestKey>(
        _accountProfileId: string,
        key: Key,
        _input: PinnedCodexRequestInput<Key>,
        expectedGeneration?: number,
      ) {
        if (key !== "modelList") throw new Error(`Unexpected mutation: ${String(key)}`);
        expectedGenerations.push(expectedGeneration);
        page += 1;
        const output: PinnedCodexRequestOutput<"modelList"> = {
          data: page === 5
            ? [{
                model: "gpt-5.6-luna",
                supportedReasoningEfforts: [{ reasoningEffort: "max" }],
                serviceTiers: [{
                  id: "fast",
                  name: "Fast",
                  description: "Faster inference.",
                }],
              }]
            : [],
          nextCursor: page === 5 ? null : `cursor-${String(page)}`,
        };
        return Promise.resolve({
          generation: 7,
          streamPosition: page,
          output: output as PinnedCodexRequestOutput<Key>,
        });
      },
    },
    emit: () => undefined,
  });

  await sessions.resolveChatConfiguration(
    ACCOUNT,
    [{ model: "gpt-5.6-luna", reasoningEffort: "max", serviceTier: "fast" }],
  );
  expect(expectedGenerations).toEqual([undefined, 7, 7, 7, 7]);
});

test("one exact catalog resolves the first supported HRA candidate", async () => {
  let modelListCalls = 0;
  const sessions = new SessionService({
    accounts: {
      requestSession: () => Promise.reject(new Error("Expected positioned session request")),
      requestSessionWithResponsePosition<Key extends SessionCodexRequestKey>(
        _accountProfileId: string,
        key: Key,
      ) {
        if (key !== "modelList") throw new Error(`Unexpected mutation: ${String(key)}`);
        modelListCalls += 1;
        const output: PinnedCodexRequestOutput<"modelList"> = {
          data: [
            {
              model: "gpt-5.6-luna",
              supportedReasoningEfforts: [{ reasoningEffort: "max" }],
              serviceTiers: [],
            },
            {
              model: "gpt-5.6-sol",
              supportedReasoningEfforts: [{ reasoningEffort: "max" }],
              serviceTiers: [{
                id: "fast",
                name: "Fast",
                description: "Faster inference.",
              }],
            },
          ],
          nextCursor: null,
        };
        return Promise.resolve({
          generation: 12,
          streamPosition: 1,
          output: output as PinnedCodexRequestOutput<Key>,
        });
      },
    },
    emit: () => undefined,
  });

  const selected = await sessions.resolveChatConfiguration(ACCOUNT, [
    { model: "gpt-5.6-luna", reasoningEffort: "max", serviceTier: "fast" },
    { model: "gpt-5.6-luna", reasoningEffort: "max", serviceTier: "standard" },
    { model: "gpt-5.6-sol", reasoningEffort: "max", serviceTier: "fast" },
  ]);
  expect(selected).toEqual({
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
    serviceTier: "standard",
  });
  expect(modelListCalls).toBe(1);
});

test("an incomplete bounded root model catalog is protocol uncertainty, not absence", async () => {
  let page = 0;
  const sessions = new SessionService({
    accounts: {
      requestSession: () => Promise.reject(new Error("Expected positioned session request")),
      requestSessionWithResponsePosition<Key extends SessionCodexRequestKey>(
        _accountProfileId: string,
        key: Key,
      ) {
        if (key !== "modelList") throw new Error(`Unexpected mutation: ${String(key)}`);
        page += 1;
        const output: PinnedCodexRequestOutput<"modelList"> = {
          data: [],
          nextCursor: `cursor-${String(page)}`,
        };
        return Promise.resolve({
          generation: 9,
          streamPosition: page,
          output: output as PinnedCodexRequestOutput<Key>,
        });
      },
    },
    emit: () => undefined,
  });

  const failure = await sessions.resolveChatConfiguration(
    ACCOUNT,
    [{ model: "gpt-5.6-luna", reasoningEffort: "max", serviceTier: "standard" }],
  ).then(() => null, (reason: unknown) => reason);
  expect(failure).toBeInstanceOf(SessionServiceError);
  expect(failure).toMatchObject({ code: "protocol_error" });
  expect(page).toBe(8);
});

test("every route resolution reads one current account catalog", async () => {
  const validations: string[] = [];
  const reject = () => Promise.reject(new Error("Unexpected provider mutation"));
  const provider = new CodexChatProvider({
    injectChatHistory: reject,
    interruptChatTurn: reject,
    resumeChatThread: reject,
    setChatThreadName: reject,
    startChatThread: reject,
    startChatTurn: reject,
    resolveChatConfiguration: (_account, candidates) => {
      const selected = candidates[0];
      if (selected === undefined) throw new Error("Expected a routing candidate");
      validations.push(selected.serviceTier);
      return Promise.resolve(selected);
    },
  });

  const fast = {
    model: "gpt-5.6-sol" as const,
    reasoningEffort: "ultra" as const,
    serviceTier: "fast" as const,
    approvalPolicy: "on-request" as const,
    approvalsReviewer: "auto_review" as const,
    sandbox: "workspace-write" as const,
  };
  const standard = { ...fast, serviceTier: "standard" as const };
  await provider.resolveConfiguration(ACCOUNT, [fast]);
  await provider.resolveConfiguration(ACCOUNT, [fast]);
  await provider.resolveConfiguration(ACCOUNT, [standard]);
  await provider.resolveConfiguration(ACCOUNT, [standard]);
  expect(validations).toEqual(["fast", "fast", "standard", "standard"]);
});

test("Codex chat preserves definitive model absence for safe automatic fallback", async () => {
  const unavailable = new SessionServiceError(
    "capability_unavailable",
    "Luna is absent from this exact account catalog.",
    false,
    "none",
  );
  const reject = () => Promise.reject(new Error("Unexpected provider mutation"));
  const provider = new CodexChatProvider({
    injectChatHistory: reject,
    interruptChatTurn: reject,
    resumeChatThread: reject,
    setChatThreadName: reject,
    startChatThread: reject,
    startChatTurn: reject,
    resolveChatConfiguration: () => Promise.reject(unavailable),
  });

  const error = await provider.resolveConfiguration(ACCOUNT, [{
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
    serviceTier: "standard",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    sandbox: "workspace-write",
  }]).then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(ChatProviderEffectError);
  expect(error).toMatchObject({
    certainty: "not_applied",
    code: "capability_unavailable",
  });
});

test("SessionService dispatch stays fire-and-forget while ordered chat projection is blocked", async () => {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.query(`
    INSERT INTO account_profiles (
      profile_id, label, auth_state, process_generation,
      selected, created_at, updated_at
    ) VALUES (?1, 'Integration account', 'signed_in', 1, 1, ?2, ?2)
  `).run(ACCOUNT, "2026-08-03T12:00:00.000Z");

  const projectionEntered = deferred<void>();
  const releaseProjection = deferred<void>();
  try {
    let blockedProjection = false;
    const requests: Array<Readonly<{ key: string; input: unknown }>> = [];
    let responsePosition = 0;
    const accounts: SessionAccountRuntimePort = {
      requestSession: () => Promise.reject(new Error("Expected positioned session request")),
      requestSessionWithResponsePosition<Key extends SessionCodexRequestKey>(
        _accountProfileId: string,
        key: Key,
        input: PinnedCodexRequestInput<Key>,
      ) {
        requests.push({ key: String(key), input });
        responsePosition += 1;
        return Promise.resolve({
          generation: 1,
          streamPosition: responsePosition,
          output: responseFor(key, requestWorkingDirectory(input)) as PinnedCodexRequestOutput<Key>,
        });
      },
    };
    const callbackWork: Promise<void>[] = [];
    let chat: ChatService | null = null;
    const sessions = new SessionService({
      accounts,
      emit: () => undefined,
      onAssistantItemCompletion: (event) => {
        const work = chat?.observeSessionAssistantCompletion(event) ?? Promise.resolve();
        callbackWork.push(work);
        return work;
      },
      onTurnActivity: (event) => {
        const work = chat?.observeSessionActivity(event) ?? Promise.resolve();
        callbackWork.push(work);
        return work;
      },
      onTurnLifecycle: (event) => {
        const work = chat?.observeSessionLifecycle(event) ?? Promise.resolve();
        callbackWork.push(work);
      },
    });
    sessions.handleRuntimeState(ACCOUNT, { type: "starting", generation: 1 });
    const store = new ChatPaneStore(database);
    chat = new ChatService({
      accounts: {
        containAmbiguousEffect: () => Promise.resolve(),
        refreshCandidates: () => Promise.resolve([
          { id: ACCOUNT, selected: true, budget: "healthy" },
        ]),
      },
      projection: {
        paneChanged: () => undefined,
        paneStateChanged: () => undefined,
        paneRemoved: () => undefined,
        panesReordered: () => undefined,
        delta: async () => {
          if (blockedProjection) return;
          blockedProjection = true;
          projectionEntered.resolve();
          await releaseProjection.promise;
        },
      },
      provider: new CodexChatProvider(sessions),
      repositories: {
        resolve: (id) => Promise.resolve(id === REPOSITORY
          ? { id, name: "OPRTE", workingDirectory: process.cwd() }
          : null),
      },
      runtimeRecovery: { requestRecovery: () => undefined },
      rootTurnRouting: new RootTurnRoutingSQLiteAuthorityV1(database),
      store,
      workspaces: testWorkspaces(store, database),
    });

    const created = await chat.execute({
      type: "chat.pane.create",
      paneId: PANE,
      repositoryId: REPOSITORY,
    });
    if (created.type !== "pane") throw new Error("Expected pane");
    await chat.settled();
    const ready = store.require(PANE).projection;
    const accepted = await chat.execute({
      type: "chat.turn.start",
      paneId: PANE,
      expectedRevision: ready.revision,
      turnId: LOGICAL_TURN,
      prompt: "Fix the typo in the button label.",
    });
    expect(accepted.type === "pane" ? accepted.pane.revision : 0)
      .toBe(ready.revision + 1);
    await chat.settled();
    sessions.handleRuntimeState(ACCOUNT, { type: "idle", generation: 1 });

    expect(requests.map(({ key }) => key)).toEqual([
      "modelList",
      "configRequirementsRead",
      "threadStart",
      "threadSetName",
      "configRequirementsRead",
      "turnStart",
    ]);
    expect(requests.find(({ key }) => key === "threadStart")?.input).toMatchObject({
      model: "gpt-5.6-luna",
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      sandbox: "danger-full-access",
      serviceTier: "fast",
    });
    expect(requests.find(({ key }) => key === "turnStart")?.input).toMatchObject({
      model: "gpt-5.6-luna",
      effort: "max",
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      sandboxPolicy: { type: "dangerFullAccess" },
      serviceTier: "fast",
    });

    let notificationLoopCompleted = false;
    sessions.consumeCodexFacts(projectCodexNotificationFacts(ACCOUNT, {
      generation: 1,
      streamPosition: 100,
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: PROVIDER_THREAD,
        turnId: PROVIDER_TURN,
        itemId: "provider-reasoning",
        delta: "Checking the seam",
        summaryIndex: 0,
      },
    }));
    sessions.consumeCodexFacts(projectCodexNotificationFacts(ACCOUNT, {
      generation: 1,
      streamPosition: 101,
      method: "item/agentMessage/delta",
      params: {
        threadId: PROVIDER_THREAD,
        turnId: PROVIDER_TURN,
        itemId: "provider-answer",
        delta: "The seam is exact.",
      },
    }));
    sessions.consumeCodexFacts(projectCodexNotificationFacts(ACCOUNT, {
      generation: 1,
      streamPosition: 102,
      method: "item/completed",
      params: {
        threadId: PROVIDER_THREAD,
        turnId: PROVIDER_TURN,
        item: { id: "provider-answer", type: "agentMessage", text: "The seam is exact." },
        completedAtMs: 1_775_217_600_001,
      },
    }));
    sessions.consumeCodexFacts(projectCodexNotificationFacts(ACCOUNT, {
      generation: 1,
      streamPosition: 103,
      method: "item/started",
      params: {
        threadId: PROVIDER_THREAD,
        turnId: PROVIDER_TURN,
        item: { id: "provider-tool", type: "fileChange", status: "inProgress", changes: [] },
        startedAtMs: 1_775_217_600_002,
      },
    }));
    sessions.consumeCodexFacts(projectCodexNotificationFacts(ACCOUNT, {
      generation: 1,
      streamPosition: 104,
      method: "item/completed",
      params: {
        threadId: PROVIDER_THREAD,
        turnId: PROVIDER_TURN,
        item: { id: "provider-tool", type: "fileChange", status: "completed", changes: [] },
        completedAtMs: 1_775_217_600_003,
      },
    }));
    sessions.consumeCodexFacts(projectCodexNotificationFacts(ACCOUNT, {
      generation: 1,
      streamPosition: 105,
      method: "turn/completed",
      params: {
        threadId: PROVIDER_THREAD,
        turn: rawTurn(PROVIDER_TURN, "completed"),
      },
    }));
    notificationLoopCompleted = true;
    let callbacksSettled = false;
    const callbackSettlement = Promise.all(callbackWork).then(() => {
      callbacksSettled = true;
    });
    await projectionEntered.promise;
    expect(notificationLoopCompleted).toBeTrue();
    expect(callbacksSettled).toBeFalse();
    expect(store.require(PANE).projection.state).toBe("streaming");
    releaseProjection.resolve();
    await callbackSettlement;
    await chat.settled();

    const pane = store.require(PANE).projection;
    expect(pane).toMatchObject({
      state: "ready",
      turn: {
        status: "completed",
        reasoningSummary: { tail: "Checking the seam" },
        responseMarkdown: { tail: "The seam is exact." },
        tools: [expect.objectContaining({ category: "other", status: "completed" })],
      },
    });
    expect(JSON.stringify(pane)).not.toContain(PROVIDER_THREAD);
    expect(JSON.stringify(pane)).not.toContain(PROVIDER_TURN);
  } finally {
    releaseProjection.resolve();
    database.close();
  }
});

test("a durable binding reconstructs a fresh SessionService before the next turn", async () => {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.query(`
    INSERT INTO account_profiles (
      profile_id, label, auth_state, process_generation,
      selected, created_at, updated_at
    ) VALUES (?1, 'Restart account', 'signed_in', 1, 1, ?2, ?2)
  `).run(ACCOUNT, "2026-08-03T12:00:00.000Z");

  try {
    const firstRequests: string[] = [];
    let firstPosition = 0;
    const firstSessions = new SessionService({
      accounts: positionedAccounts(firstRequests, () => ++firstPosition),
      emit: () => undefined,
    });
    firstSessions.handleRuntimeState(ACCOUNT, { type: "starting", generation: 1 });
    const store = new ChatPaneStore(database);
    const firstChat = new ChatService({
      accounts: {
        containAmbiguousEffect: () => Promise.resolve(),
        refreshCandidates: () => Promise.resolve([
          { id: ACCOUNT, selected: true, budget: "healthy" },
        ]),
      },
      projection: quietProjection(),
      provider: new CodexChatProvider(firstSessions),
      repositories: {
        resolve: (id) => Promise.resolve(id === REPOSITORY
          ? { id, name: "OPRTE", workingDirectory: process.cwd() }
          : null),
      },
      runtimeRecovery: { requestRecovery: () => undefined },
      rootTurnRouting: new RootTurnRoutingSQLiteAuthorityV1(database),
      store,
      workspaces: testWorkspaces(store, database),
    });
    const created = await firstChat.execute({
      type: "chat.pane.create",
      paneId: PANE,
      repositoryId: REPOSITORY,
    });
    if (created.type !== "pane") throw new Error("Expected pane");
    await firstChat.settled();
    const ready = store.require(PANE).projection;
    await firstChat.execute({
      type: "chat.turn.start",
      paneId: PANE,
      expectedRevision: ready.revision,
      turnId: LOGICAL_TURN,
      prompt: "Persist the provider binding",
    });
    await firstChat.settled();
    firstSessions.handleRuntimeState(ACCOUNT, { type: "idle", generation: 1 });
    const activeFirst = store.require(PANE);
    if (activeFirst.binding === null || activeFirst.providerTurnId === null) {
      throw new Error("Expected active provider binding");
    }
    await firstChat.observeSessionAssistantCompletion({
      accountProfileId: activeFirst.binding.accountProfileId,
      assistantItemId: "item_integration01",
      displayText: "",
      threadId: activeFirst.binding.threadId,
      truncated: false,
      turnId: activeFirst.providerTurnId,
    });
    await firstChat.handleTurnTerminal({
      paneId: PANE,
      turnId: LOGICAL_TURN,
      outcome: "completed",
    });
    const persisted = store.require(PANE);
    expect(persisted.binding).toMatchObject({
      accountProfileId: ACCOUNT,
      restartThreadId: PROVIDER_THREAD,
    });
    expect(persisted.binding?.threadId).not.toBe(PROVIDER_THREAD);

    const resumedRequests: Array<Readonly<{ key: string; input: unknown }>> = [];
    let resumedPosition = 0;
    const callbackWork: Promise<void>[] = [];
    let resumedChat: ChatService | null = null;
    const resumedSessions = new SessionService({
      accounts: {
        requestSession: () => Promise.reject(new Error("Expected positioned session request")),
        requestSessionWithResponsePosition<Key extends SessionCodexRequestKey>(
          _accountProfileId: string,
          key: Key,
          input: PinnedCodexRequestInput<Key>,
        ) {
          resumedRequests.push({ key: String(key), input });
          resumedPosition += 1;
          return Promise.resolve({
            generation: 1,
            streamPosition: resumedPosition,
            output: responseFor(key, requestWorkingDirectory(input)) as PinnedCodexRequestOutput<Key>,
          });
        },
      },
      emit: () => undefined,
      onAssistantItemCompletion: (event) => {
        const work = resumedChat?.observeSessionAssistantCompletion(event) ?? Promise.resolve();
        callbackWork.push(work);
        return work;
      },
      onTurnActivity: (event) => {
        const work = resumedChat?.observeSessionActivity(event) ?? Promise.resolve();
        callbackWork.push(work);
        return work;
      },
      onTurnLifecycle: (event) => {
        const work = resumedChat?.observeSessionLifecycle(event) ?? Promise.resolve();
        callbackWork.push(work);
      },
    });
    resumedSessions.handleRuntimeState(ACCOUNT, { type: "starting", generation: 1 });
    resumedChat = new ChatService({
      accounts: {
        containAmbiguousEffect: () => Promise.resolve(),
        refreshCandidates: () => Promise.resolve([
          { id: ACCOUNT, selected: true, budget: "healthy" },
        ]),
      },
      projection: quietProjection(),
      provider: new CodexChatProvider(resumedSessions),
      repositories: {
        resolve: (id) => Promise.resolve(id === REPOSITORY
          ? { id, name: "OPRTE", workingDirectory: process.cwd() }
          : null),
      },
      runtimeRecovery: { requestRecovery: () => undefined },
      rootTurnRouting: new RootTurnRoutingSQLiteAuthorityV1(database),
      store,
      workspaces: testWorkspaces(store, database),
    });
    resumedChat.initialize();
    await resumedChat.execute({
      type: "chat.turn.start",
      paneId: PANE,
      expectedRevision: persisted.projection.revision,
      turnId: "chatturn_integrat02",
      prompt: "Resume after restart",
    });
    await resumedChat.settled();
    resumedSessions.handleRuntimeState(ACCOUNT, { type: "idle", generation: 1 });

    expect(resumedRequests.map(({ key }) => key)).toEqual([
      "modelList",
      "configRequirementsRead",
      "threadResume",
      "configRequirementsRead",
      "turnStart",
    ]);
    expect(resumedRequests.find(({ key }) => key === "threadResume")?.input).toMatchObject({
      threadId: PROVIDER_THREAD,
      model: "gpt-5.6-sol",
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      sandbox: "danger-full-access",
      serviceTier: null,
    });
    expect(resumedRequests.find(({ key }) => key === "turnStart")?.input).toMatchObject({
      model: "gpt-5.6-sol",
      effort: "max",
      serviceTier: null,
    });
    expect(store.require(PANE).binding).toEqual(persisted.binding);

    resumedSessions.consumeCodexFacts(projectCodexNotificationFacts(ACCOUNT, {
      generation: 1,
      streamPosition: 100,
      method: "item/agentMessage/delta",
      params: {
        threadId: "provider-unowned-thread",
        turnId: PROVIDER_TURN,
        itemId: "ignored-answer",
        delta: "wrong thread",
      },
    }));
    resumedSessions.consumeCodexFacts(projectCodexNotificationFacts(ACCOUNT, {
      generation: 1,
      streamPosition: 101,
      method: "item/agentMessage/delta",
      params: {
        threadId: PROVIDER_THREAD,
        turnId: PROVIDER_TURN,
        itemId: "resumed-answer",
        delta: "Restart-safe response",
      },
    }));
    resumedSessions.consumeCodexFacts(projectCodexNotificationFacts(ACCOUNT, {
      generation: 1,
      streamPosition: 102,
      method: "item/completed",
      params: {
        threadId: PROVIDER_THREAD,
        turnId: PROVIDER_TURN,
        item: { id: "resumed-answer", type: "agentMessage", text: "Restart-safe response" },
        completedAtMs: 1_775_217_600_001,
      },
    }));
    resumedSessions.consumeCodexFacts(projectCodexNotificationFacts(ACCOUNT, {
      generation: 1,
      streamPosition: 103,
      method: "turn/completed",
      params: {
        threadId: PROVIDER_THREAD,
        turn: rawTurn(PROVIDER_TURN, "completed"),
      },
    }));
    await Promise.all(callbackWork);
    await resumedChat.settled();

    const completed = store.require(PANE).projection;
    expect(completed).toMatchObject({
      state: "ready",
      turn: {
        id: "chatturn_integrat02",
        status: "completed",
        responseMarkdown: { tail: "Restart-safe response" },
      },
    });
    expect(completed.turn?.responseMarkdown.tail).not.toContain("wrong thread");
    expect(JSON.stringify(completed)).not.toContain(PROVIDER_THREAD);
  } finally {
    database.close();
  }
});

function responseFor(key: unknown, cwd: string): unknown {
  switch (key) {
    case "modelList":
      return {
        data: ["gpt-5.6-sol", "gpt-5.6-luna"].map((model) => ({
          model,
          supportedReasoningEfforts: [
            { reasoningEffort: "ultra" },
            { reasoningEffort: "max" },
          ],
          serviceTiers: [{
            id: "fast",
            name: "Fast",
            description: "Faster model inference with higher credit use.",
          }],
        })),
        nextCursor: null,
      };
    case "configRequirementsRead":
      return { requirements: null };
    case "threadStart":
      return {
        thread: rawThread(cwd),
        approvalPolicy: "never",
        approvalsReviewer: "auto_review",
        sandbox: { type: "dangerFullAccess" },
      };
    case "threadResume":
      return {
        thread: rawThread(cwd),
        approvalPolicy: "never",
        approvalsReviewer: "auto_review",
        sandbox: { type: "dangerFullAccess" },
      };
    case "threadSetName":
      return undefined;
    case "turnStart":
      return { turn: rawTurn(PROVIDER_TURN, "inProgress") };
    default:
      throw new Error(`Unexpected request: ${String(key)}`);
  }
}

function requestWorkingDirectory(input: unknown): string {
  if (
    typeof input === "object" && input !== null && "cwd" in input &&
    typeof input.cwd === "string"
  ) return input.cwd;
  return process.cwd();
}

function positionedAccounts(
  requests: string[],
  nextPosition: () => number,
): SessionAccountRuntimePort {
  return {
    requestSession: () => Promise.reject(new Error("Expected positioned session request")),
    requestSessionWithResponsePosition<Key extends SessionCodexRequestKey>(
      _accountProfileId: string,
      key: Key,
      input: PinnedCodexRequestInput<Key>,
    ) {
      void input;
      requests.push(String(key));
      return Promise.resolve({
        generation: 1,
        streamPosition: nextPosition(),
        output: responseFor(key, requestWorkingDirectory(input)) as PinnedCodexRequestOutput<Key>,
      });
    },
  };
}

function quietProjection() {
  return {
    paneChanged: () => undefined,
    paneStateChanged: () => undefined,
    paneRemoved: () => undefined,
    panesReordered: () => undefined,
    delta: () => undefined,
  };
}

function testWorkspaces(
  store: ChatPaneStore,
  database: Database,
): ChatWorkspacePort {
  return {
    provision(paneId) {
      const current = store.require(paneId).projection;
      if (current.workspace?.state === "ready") return Promise.resolve(current);
      database.query(`
        UPDATE chat_panes SET workspace_mode = 'managed_worktree',
          workspace_state = 'ready', workspace_recovery_reason = NULL,
          workspace_revision = workspace_revision + 1,
          revision = revision + 1,
          updated_at = '2026-08-03T12:00:00.000Z'
        WHERE pane_id = ?1 AND archived_at IS NULL
      `).run(paneId);
      return Promise.resolve(store.require(paneId).projection);
    },
    resolve(paneId, repository) {
      return Promise.resolve(store.require(paneId).projection.workspace?.state === "ready"
        ? { ...repository, workingDirectory: process.cwd() }
        : null);
    },
    markRepositoryUnavailable(paneId) {
      database.query(`
        UPDATE chat_panes SET workspace_state = 'recovery_required',
          workspace_recovery_reason = 'unknown',
          workspace_revision = workspace_revision + 1,
          revision = revision + 1,
          updated_at = '2026-08-03T12:00:00.000Z'
        WHERE pane_id = ?1 AND archived_at IS NULL
          AND workspace_state != 'preserved'
      `).run(paneId);
      return store.require(paneId).projection;
    },
    release() {},
  };
}

function rawThread(cwd: string) {
  return {
    id: PROVIDER_THREAD,
    preview: "",
    createdAt: 1_775_217_600,
    updatedAt: 1_775_217_600,
    status: { type: "idle", activeFlags: [] },
    cwd,
    name: null,
    turns: [],
  };
}

function rawTurn(id: string, status: "completed" | "inProgress") {
  return {
    id,
    items: [],
    itemsView: "full" as const,
    status,
    startedAt: 1_775_217_600,
    completedAt: status === "completed" ? 1_775_217_601 : null,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
